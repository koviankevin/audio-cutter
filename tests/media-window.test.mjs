import test from 'node:test';
import assert from 'node:assert/strict';
import { MediaWindowPlayer } from '../media-window.mjs';

class Media extends EventTarget {
  paused = true;
  ended = false;
  seeking = false;
  error = null;
  playbackRate = 1;
  position = 0;
  get currentTime() {
    return this.position;
  }
  set currentTime(value) {
    this.position = value;
    this.ended = false;
    if (this.seeking) return;
    this.seeking = true;
    queueMicrotask(() => {
      this.dispatchEvent(new Event('seeking'));
      this.seeking = false;
      this.dispatchEvent(new Event('seeked'));
    });
  }
  play() {
    this.paused = false;
    this.ended = false;
    this.dispatchEvent(new Event('play'));
    return Promise.resolve();
  }
  pause() {
    this.paused = true;
    this.dispatchEvent(new Event('pause'));
  }
}

test('bounded one-shot stops at its end, keeps the window, and replays from the start', async () => {
  const audio = new Media(),
    player = new MediaWindowPlayer(audio);
  try {
    player.start({ start: 1.75, end: 2.25 });
    await Promise.resolve();
    audio.position = 2.3;
    audio.dispatchEvent(new Event('timeupdate'));
    await Promise.resolve();
    assert.equal(audio.paused, true);
    assert.equal(audio.currentTime, 2.25);
    assert.equal(player.timer, null);
    await audio.play();
    assert.equal(audio.currentTime, 1.75);
  } finally {
    player.stop({ pause: true });
  }
});

test('loop restarts at the actual file end and native pause cancels its timer', async () => {
  const audio = new Media(),
    player = new MediaWindowPlayer(audio);
  try {
    player.start({ start: 7.5, end: 8 }, { loop: true });
    await Promise.resolve();
    audio.position = 8;
    audio.paused = true;
    audio.ended = true;
    audio.dispatchEvent(new Event('ended'));
    await Promise.resolve();
    assert.equal(audio.currentTime, 7.5);
    assert.equal(audio.paused, false);
    assert.equal(player.looping, true);
    audio.pause();
    assert.equal(player.timer, null);
    assert.equal(player.looping, true);
    await audio.play();
    assert.notEqual(player.timer, null);
  } finally {
    player.stop({ pause: true });
  }
});

test('native user seeks exit the loop, owned seeks keep it, and explicit stop releases the timer', async () => {
  let manual = 0;
  const audio = new Media(),
    player = new MediaWindowPlayer(audio, { onManualSeek: () => manual++ });
  try {
    player.start({ start: 1, end: 3 }, { loop: true });
    await Promise.resolve();
    assert.equal(manual, 0);
    audio.currentTime = 5;
    await Promise.resolve();
    assert.equal(manual, 1);
    assert.equal(player.window, null);
    assert.equal(player.looping, false);
    assert.equal(player.timer, null);
    player.start({ start: 2, end: 4 }, { loop: true, play: false });
    await Promise.resolve();
    assert.equal(audio.paused, true);
    assert.equal(player.timer, null);
  } finally {
    player.stop({ pause: true });
  }
});

test('late playback failures from a retired window cannot report errors or restart playback', async () => {
  let reject,
    errors = 0;
  const audio = new Media(),
    player = new MediaWindowPlayer(audio, { onError: () => errors++ });
  audio.play = () =>
    new Promise((resolve, failure) => {
      reject = failure;
    });
  try {
    player.start({ start: 1, end: 2 }, { loop: true });
    player.stop({ pause: true });
    reject(new Error('retired media'));
    await Promise.resolve();
    assert.equal(errors, 0);
    assert.equal(player.timer, null);
    assert.equal(audio.paused, true);
  } finally {
    player.stop({ pause: true });
  }
});

test('stopping before an owned seek event arrives preserves selection but later user seeks still exit', async () => {
  let manual = 0;
  const audio = new Media(),
    player = new MediaWindowPlayer(audio, { onManualSeek: () => manual++ });
  try {
    player.start({ start: 3, end: 5 }, { loop: true });
    player.stop({ pause: true });
    await Promise.resolve();
    assert.equal(manual, 0, 'queued owned seek must not be reported as a user seek after stop');
    assert.equal(audio.paused, true);
    assert.equal(player.window, null);
    assert.equal(player.timer, null);
    assert.equal(player.looping, false);
    audio.currentTime = 6;
    await Promise.resolve();
    assert.equal(manual, 1, 'subsequent native/user seeking must still be handled');
  } finally {
    player.stop({ pause: true });
  }
});

// Native media state changes and queued DOM events are separate. Unlike Media,
// let each test choose when decoding finishes and when each event is delivered.
class QueuedMedia extends Media {
  events = [];
  get currentTime() { return this.position; }
  set currentTime(value) {
    this.position = value;
    this.seeking = true;
    this.events.push('seeking');
  }
  completeSeek() {
    this.seeking = false;
    this.events.push('timeupdate', 'seeked');
  }
  deliver() { this.dispatchEvent(new Event(this.events.shift())); }
  flush() { while (this.events.length) this.deliver(); }
}

test('a completed seek with undelivered events remains owned after a rapid loop stop', () => {
  let selected = 1;
  const audio = new QueuedMedia(),
    player = new MediaWindowPlayer(audio, { onManualSeek: () => selected = -1 });
  try {
    player.start({ start: 3, end: 5 }, { loop: true });
    audio.completeSeek();
    player.stop({ pause: true });
    audio.flush();
    assert.equal(selected, 1, 'rapid loop stop must retain its selected join');
    assert.equal(audio.paused, true);
    assert.equal(player.window, null);
    assert.equal(player.timer, null);
    audio.currentTime = 6;
    audio.completeSeek();
    audio.flush();
    assert.equal(selected, -1, 'later native/user seeking still clears selection');
  } finally { player.stop({ pause: true }); }
});

test('an older queued seeked cannot retire a newer owned seek before its seeking event', () => {
  let selected = 1;
  const audio = new QueuedMedia(),
    player = new MediaWindowPlayer(audio, { onManualSeek: () => selected = -1 });
  try {
    player.start({ start: 1, end: 2 }, { loop: true });
    audio.deliver(); // first seeking
    audio.completeSeek(); // first timeupdate and seeked remain queued
    player.start({ start: 3, end: 5 }, { loop: true });
    player.stop({ pause: true });
    audio.flush(); // old seeked arrives before the second seeking
    audio.completeSeek();
    audio.flush();
    assert.equal(selected, 1, 'a stale completion must not turn an owned seek into a user seek');
    assert.equal(audio.paused, true);
    assert.equal(player.timer, null);
    audio.currentTime = 6;
    audio.completeSeek();
    audio.flush();
    assert.equal(selected, -1);
  } finally { player.stop({ pause: true }); }
});

test('overlapping owned seeks survive old completions but an intervening user seek exits', () => {
  let manual = 0;
  const audio = new QueuedMedia(),
    player = new MediaWindowPlayer(audio, { onManualSeek: () => manual++ });
  try {
    player.start({ start: 1, end: 2 }, { loop: true });
    audio.completeSeek();
    player.start({ start: 3, end: 5 }, { loop: true });
    player.stop({ pause: true });
    audio.flush();
    audio.completeSeek();
    audio.flush();
    assert.equal(manual, 0, 'both queued seeking events belong to the latest owned position');

    player.start({ start: 1, end: 2 }, { loop: true });
    audio.deliver();
    audio.completeSeek();
    player.start({ start: 3, end: 5 }, { loop: true });
    audio.deliver(); // old timeupdate
    audio.deliver(); // old seeked while the new seek is still in progress
    audio.deliver(); // new seeking
    audio.currentTime = 6; // genuine native user seek before completion
    audio.completeSeek();
    audio.flush();
    assert.equal(manual, 1);
    assert.equal(player.window, null);
    assert.equal(player.looping, false);
    assert.equal(player.timer, null);
  } finally { player.stop({ pause: true }); }
});

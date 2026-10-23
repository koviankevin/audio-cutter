import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startServer } from '../scripts/serve.mjs';
import { wavHeader } from '../pcm.mjs';
import { runtimeInfo } from './runtime-info.mjs';

const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright'
);
const channel = process.env.BROWSER_CHANNEL || 'chrome';
const output = path.resolve('test-results', `export-preview-${channel}`);
await mkdir(output, { recursive: true });
const source = path.join(output, 'tones.wav'),
  frames = 12 * 44100;
const pcm = Buffer.alloc(frames * 4);
for (let i = 0; i < frames; i++) {
  const tone = 220 + 110 * Math.floor(i / 44100);
  for (let c = 0; c < 2; c++)
    pcm.writeInt16LE(Math.round(9000 * Math.sin((2 * Math.PI * (tone + c * 55) * i) / 44100)), i * 4 + c * 2);
}
await writeFile(source, Buffer.concat([Buffer.from(wavHeader(frames, 2, 44100)), pcm]));
const { server, url } = process.env.SITE_URL
  ? { server: null, url: process.env.SITE_URL }
  : await startServer({ port: 0, base: '/audio-cutter/' });
const browser = await chromium.launch({ channel, headless: true });
const context = await browser.newContext({ acceptDownloads: true });
const page = await context.newPage(),
  errors = [],
  requests = [];
let downloads = 0;
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (d) => d.accept());
page.on('download', () => downloads++);
context.on('request', (r) => requests.push({ url: r.url(), method: r.method() }));
await page.addInitScript(() => {
  const revoke = URL.revokeObjectURL.bind(URL);
  window.revokedUrls = new Set();
  URL.revokeObjectURL = (url) => {
    window.revokedUrls.add(url);
    revoke(url);
  };
  const decode = AudioContext.prototype.decodeAudioData;
  window.decodeCalls = 0;
  AudioContext.prototype.decodeAudioData = function (...args) {
    window.decodeCalls++;
    return decode.apply(this, args);
  };
});
const player = page.locator('#result-audio');
async function select(start, end) {
  await page.locator('#selection-start').fill(String(start));
  await page.locator('#selection-end').fill(String(end));
  await page.locator('#selection-end').press('Enter');
}
async function exportFile(format, duration = 8) {
  await page.locator(`[name="format"][value="${format}"]`).check();
  await page.locator('#export-button').click();
  await page.locator('#export-result').waitFor({ state: 'visible' });
  await page.waitForFunction(() => document.getElementById('result-audio').readyState >= 1);
  const state = await player.evaluate((a) => ({
    src: a.src,
    download: document.getElementById('download-link').href,
    duration: a.duration,
    paused: a.paused,
    preload: a.preload,
    controls: a.controls,
  }));
  assert.equal(state.src, state.download, 'preview must use the exact download object URL');
  assert.match(state.src, /^blob:/);
  assert.ok(Math.abs(state.duration - duration) < 0.15, `${format} must play the edited timeline`);
  assert.equal(state.paused, true, 'never autoplay on export completion');
  assert.equal(state.preload, 'metadata');
  assert.equal(state.controls, true);
  return state.src;
}
async function cleared(oldUrl) {
  assert.equal(await player.getAttribute('src'), null);
  assert.equal(await player.evaluate((a) => a.paused), true);
  assert.equal(await page.locator('#export-result').isVisible(), false);
  assert.equal(await page.evaluate((url) => window.revokedUrls.has(url), oldUrl), true);
  assert.equal(await page.locator('#result-audio-error').isVisible(), false);
  assert.equal(await page.locator('#result-junction-markers button').count(), 0);
  assert.equal(await page.locator('#result-junction-previous').isDisabled(), true);
  assert.equal(await page.locator('#result-junction-next').isDisabled(), true);
  assert.equal(await page.locator('#result-junction-loop').getAttribute('aria-pressed'), 'false');
  assert.equal(
    await page
      .locator('.result-preview')
      .evaluate((el) => el.dispatchEvent(new KeyboardEvent('keydown', { key: 'l', bubbles: true, cancelable: true }))),
    true,
    'hidden player ignores shortcuts',
  );
}
async function contextSeconds(before, after) {
  for (const [id, value] of [
    ['before', before],
    ['after', after],
  ]) {
    await page.locator(`#result-junction-${id}`).fill(String(value));
    await page.locator(`#result-junction-${id}`).press('Enter');
  }
}
async function reviewJoin(control, index, start) {
  await player.evaluate((a) => {
    window.reviewStart = null;
    a.addEventListener(
      'seeked',
      () => {
        window.reviewStart = a.currentTime;
      },
      { once: true },
    );
  });
  await control.click();
  await page.waitForFunction((index) => {
    const a = document.getElementById('result-audio');
    return (
      !a.paused &&
      !a.seeking &&
      document.getElementById('result-junction-markers').children[index].getAttribute('aria-pressed') === 'true'
    );
  }, index);
  await player.evaluate((a) => a.pause());
  assert.ok(
    Math.abs((await page.evaluate(() => window.reviewStart)) - start) < 0.1,
    'play from one second before the selected join',
  );
}
try {
  await page.goto(url);
  for (const format of ['mp3', 'wav']) {
    await page.locator('#file-input').setInputFiles(source);
    await page.locator('#workspace').waitFor({ state: 'visible' });
    for (const [a, b] of [
      [2, 4],
      [6, 8],
    ]) {
      await select(a, b);
      await page.locator('#add-deletion').click();
    }
    const decodes = await page.evaluate(() => window.decodeCalls);
    const previousDownloads = downloads;
    let src = await exportFile(format);
    const markers = page.locator('#result-junction-markers button');
    const previous = page.locator('#result-junction-previous'),
      next = page.locator('#result-junction-next');
    assert.equal(await markers.count(), 2);
    assert.match(await markers.nth(0).getAttribute('aria-label'), /00:02\.000/);
    assert.match(await markers.nth(1).getAttribute('aria-label'), /00:04\.000/);
    assert.equal(await previous.isDisabled(), true);
    await reviewJoin(next, 0, 1);
    await reviewJoin(next, 1, 3);
    assert.equal(await next.isDisabled(), true);
    await reviewJoin(previous, 0, 1);
    assert.equal(await previous.isDisabled(), true);
    await reviewJoin(markers.nth(1), 1, 3);
    const loop = page.locator('#result-junction-loop');
    const panel = page.locator('.result-preview');
    await page.locator('#export-button').focus();
    await page.keyboard.press('Tab');
    assert.equal(
      await panel.evaluate((el) => el === document.activeElement),
      true,
      'Tab from export enters the preview keyboard group',
    );
    await reviewJoin({ click: () => page.keyboard.press('[') }, 0, 1);
    await page.keyboard.press('[');
    assert.equal(
      await markers.nth(0).getAttribute('aria-pressed'),
      'true',
      'previous shortcut cannot wrap before the first join',
    );
    await reviewJoin({ click: () => page.keyboard.press(']') }, 1, 3);
    await page.keyboard.press(']');
    assert.equal(
      await markers.nth(1).getAttribute('aria-pressed'),
      'true',
      'next shortcut cannot wrap after the last join',
    );
    await player.focus();
    await reviewJoin({ click: () => page.keyboard.press('[') }, 0, 1);
    await page.locator('#result-audio-seek').focus();
    await reviewJoin({ click: () => page.keyboard.press(']') }, 1, 3);
    await page.keyboard.down('l');
    await page.keyboard.down('l');
    await page.keyboard.up('l');
    assert.equal(await loop.getAttribute('aria-pressed'), 'true', 'holding the loop shortcut only toggles once');
    await page.keyboard.press('l');
    assert.equal(await loop.getAttribute('aria-pressed'), 'false');
    assert.equal(await player.evaluate((a) => a.paused), true);
    // Wait for delivered media events, not just the seeking property: it may
    // become false before the seeking/seeked DOM tasks have run.
    const rapidLoopEvidence = [];
    async function rapidLoopStop(staleCompletion = false) {
      const evidence = await page.evaluate(async (staleCompletion) => {
        const audio = document.getElementById('result-audio');
        const loop = document.getElementById('result-junction-loop');
        const events = [];
        const record = (event) => events.push({
          type: event.type, trusted: event.isTrusted, seeking: audio.seeking,
          paused: audio.paused, time: audio.currentTime,
          selected: document.querySelectorAll('#result-junction-markers button')[1].getAttribute('aria-pressed'),
        });
        audio.addEventListener('seeking', record);
        audio.addEventListener('seeked', record);
        const stopRapidly = () => new Promise((resolve) => {
          let sawSeeking = false;
          const seeking = () => { sawSeeking = true; };
          const seeked = () => {
            if (!sawSeeking || audio.seeking) return;
            audio.removeEventListener('seeking', seeking);
            audio.removeEventListener('seeked', seeked);
            resolve();
          };
          audio.addEventListener('seeking', seeking);
          audio.addEventListener('seeked', seeked);
          loop.click();
          loop.click();
        });
        let timeout;
        try {
          await Promise.race([
            (async () => {
              if (staleCompletion) {
                // Start/stop a new loop just before the previous native seeked
                // reaches the player's listener. All events are real media events.
                await new Promise((resolve) => {
                  audio.addEventListener('seeked', () => {
                    loop.click(); // stop the first loop
                    stopRapidly().then(resolve);
                  }, { capture: true, once: true });
                  loop.click();
                });
              } else await stopRapidly();
            })(),
            new Promise((resolve, reject) => {
              timeout = setTimeout(() => reject(new Error('native loop seek events did not settle')), 5000);
            }),
          ]);
        } finally {
          clearTimeout(timeout);
          audio.removeEventListener('seeking', record);
          audio.removeEventListener('seeked', record);
        }
        return { staleCompletion, events };
      }, staleCompletion);
      assert.ok(evidence.events.every((event) => event.trusted), 'controlled order must use native media events');
      rapidLoopEvidence.push(evidence);
      await writeFile(path.join(output, `rapid-loop-events-${format}.json`), JSON.stringify(rapidLoopEvidence, null, 2));
      assert.equal(await loop.getAttribute('aria-pressed'), 'false');
      assert.equal(await player.evaluate((a) => a.paused), true);
      assert.equal(await markers.nth(1).getAttribute('aria-pressed'), 'true', 'rapid loop stop must retain its selected join');
    }
    await rapidLoopStop();
    for (let trial = 0; trial < 25; trial++) await rapidLoopStop();
    await rapidLoopStop(true);
    const selectedStatus = await page.locator('#result-junction-status').textContent();
    for (const modifier of ['ctrlKey', 'metaKey', 'altKey', 'shiftKey', 'isComposing']) {
      assert.equal(
        await panel.evaluate(
          (el, modifier) =>
            el.dispatchEvent(
              new KeyboardEvent('keydown', {
                key: 'l',
                bubbles: true,
                cancelable: true,
                [modifier]: true,
              }),
            ),
          modifier,
        ),
        true,
        'modified/composing keys must keep their browser defaults',
      );
      assert.equal(await loop.getAttribute('aria-pressed'), 'false');
    }
    await page.locator('#result-junction-before').focus();
    await page.keyboard.press('l');
    await page.keyboard.press('[');
    assert.equal(await loop.getAttribute('aria-pressed'), 'false', 'seconds input does not trigger shortcuts');
    assert.equal(await page.locator('#result-junction-status').textContent(), selectedStatus);
    await page.locator('#waveform').focus();
    await page.keyboard.press('[');
    await page.keyboard.press('l');
    assert.equal(await loop.getAttribute('aria-pressed'), 'false', 'editor focus does not trigger export shortcuts');
    await reviewJoin(markers.nth(1), 1, 3);
    await contextSeconds(0.2, 0.3);
    assert.equal(await player.evaluate((a) => a.paused), true, 'changing seconds while paused must stay paused');
    await page.evaluate(() => {
      window.loopSeeks = [];
      const audio = document.getElementById('result-audio');
      audio.addEventListener('seeking', () => window.loopSeeks.push(audio.currentTime));
    });
    await loop.click();
    await page.waitForFunction(() => window.loopSeeks.filter((t) => Math.abs(t - 3.8) < 0.05).length >= 4);
    assert.equal(await loop.getAttribute('aria-pressed'), 'true');
    assert.match(await page.locator('#result-junction-window').textContent(), /00:03\.800 — 00:04\.300/);
    await page.evaluate(() => {
      window.loopSeeks = [];
    });
    await contextSeconds(0.4, 0.2);
    await page.waitForFunction(() => window.loopSeeks.filter((t) => Math.abs(t - 3.6) < 0.05).length >= 3);
    assert.match(await page.locator('#result-junction-window').textContent(), /00:03\.600 — 00:04\.200/);
    await previous.click();
    await page.waitForFunction(() =>
      document.getElementById('result-junction-status').textContent.includes('接點 1 / 2'),
    );
    assert.equal(await loop.getAttribute('aria-pressed'), 'true', 'changing joins must preserve the loop');
    await page.screenshot({ path: path.join(output, `loop-${format}.png`), fullPage: true });
    await player.evaluate((a) => a.pause());
    await page.waitForTimeout(100);
    const frozen = await player.evaluate((a) => a.currentTime),
      seekCount = await page.evaluate(() => window.loopSeeks.length);
    await page.waitForTimeout(700);
    assert.equal(await player.evaluate((a) => a.paused), true);
    assert.equal(await player.evaluate((a) => a.currentTime), frozen);
    assert.equal(await page.evaluate(() => window.loopSeeks.length), seekCount, 'native pause cancels the loop timer');
    await player.evaluate((a) => a.play());
    await page.waitForFunction((count) => window.loopSeeks.length > count, seekCount);
    await loop.click();
    assert.equal(await player.evaluate((a) => a.paused), true);
    assert.equal(await loop.getAttribute('aria-pressed'), 'false');
    await contextSeconds(-1, 0.3);
    assert.equal(await page.locator('#result-junction-settings-error').isVisible(), true);
    assert.equal(await loop.isDisabled(), true);
    await contextSeconds(0, 0);
    assert.equal(await page.locator('#result-junction-settings-error').isVisible(), true);
    await contextSeconds(0.25, 0.25);
    assert.equal(await page.locator('#result-junction-settings-error').isVisible(), false);
    await markers.nth(0).click();
    await page.waitForFunction(() => {
      const a = document.getElementById('result-audio');
      return a.paused && a.currentTime >= 2.24 && a.currentTime <= 2.26;
    });
    assert.equal(
      await markers.nth(0).getAttribute('aria-pressed'),
      'true',
      'one-shot stops at the configured end and keeps its join',
    );
    await contextSeconds(1, 1);
    await loop.click();
    // Manual/native seeking leaves the numbered review and follows the playhead.
    await player.evaluate((a) => {
      a.currentTime = 0;
    });
    await page.waitForFunction(() => document.getElementById('result-junction-status').textContent === '共 2 個接點');
    assert.equal(await loop.getAttribute('aria-pressed'), 'false', 'manual seeking exits the loop');
    assert.equal(await previous.isDisabled(), true);
    assert.equal(await next.isEnabled(), true);
    await page.locator('#preview-result').click();
    await page.waitForFunction(() => document.getElementById('toggle-play').getAttribute('aria-label') === '暫停');
    await player.evaluate((a) => a.play());
    await page.waitForFunction(() => document.getElementById('toggle-play').getAttribute('aria-label') === '播放');
    await page.waitForFunction(() => document.getElementById('result-audio').currentTime > 0.05);
    // Seek through both seams in the actual encoded file, not the editor's PCM.
    for (const seam of [2, 4]) {
      await page.locator('#result-audio-seek').evaluate((input, time) => {
        input.value = time - 0.1;
        input.dispatchEvent(new Event('input', { bubbles: true }));
      }, seam);
      await page.waitForFunction((time) => document.getElementById('result-audio').currentTime > time + 0.1, seam);
    }
    await select(0, 1);
    assert.equal(await page.locator('#delete-selection').isEnabled(), true);
    await player.focus();
    await page.keyboard.press('Space');
    await page.waitForFunction(() => document.getElementById('result-audio').paused);
    assert.equal(await page.locator('#toggle-play').getAttribute('aria-label'), '播放');
    await page.keyboard.press('Delete');
    assert.equal(await page.locator('#export-result').isVisible(), true, 'player keys must not delete audio');
    await player.evaluate((a) => a.play());
    await page.locator('#preview-result').click();
    assert.equal(await player.evaluate((a) => a.paused), true, 'editor playback must pause the export preview');
    await markers.nth(0).click();
    await loop.click();
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    assert.equal(await player.evaluate((a) => a.paused), true);
    assert.equal(await loop.getAttribute('aria-pressed'), 'false');
    assert.equal(await player.getAttribute('src'), src, 'back/forward cache keeps the completed file');
    await player.evaluate(async (a) => {
      a.currentTime = a.duration - 0.1;
      await a.play();
    });
    await page.waitForFunction(() => document.getElementById('result-audio').ended);
    await player.evaluate(async (a) => {
      a.currentTime = 0;
      await a.play();
    });
    await page.waitForFunction(() => document.getElementById('result-audio').currentTime > 0.05);
    await player.evaluate((a) => a.pause());
    assert.equal(downloads, previousDownloads, 'previewing must not trigger a download');
    assert.equal(
      await page.evaluate(() => window.decodeCalls),
      decodes,
      'do not decode the export into a full Web Audio buffer',
    );
    await page.screenshot({ path: path.join(output, `${format}-desktop.png`), fullPage: true });
    await page.setViewportSize({ width: 390, height: 844 });
    assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
    await page.screenshot({ path: path.join(output, `${format}-mobile.png`), fullPage: true });
    await page.setViewportSize({ width: 1280, height: 720 });
    // A native media failure must not invalidate a valid completed download.
    await player.evaluate((a) => {
      a.src = URL.createObjectURL(new Blob(['invalid media'], { type: 'audio/mpeg' }));
    });
    await page.locator('#result-audio-error').waitFor({ state: 'visible' });
    await panel.focus();
    await page.keyboard.press(']');
    await page.keyboard.press('l');
    assert.equal(await player.evaluate((a) => a.paused), true, 'shortcuts cannot restart failed media');
    const pending = page.waitForEvent('download');
    await page.locator('#download-link').click();
    const download = await pending;
    await download.saveAs(path.join(output, `edited.${format}`));
    assert.equal(await download.failure(), null);
    assert.equal(await page.locator('#export-result').isVisible(), true);
    await player.evaluate((a) => URL.revokeObjectURL(a.src));
    const oldUrl = src;
    src = await exportFile(format);
    assert.notEqual(src, oldUrl);
    assert.equal(await page.evaluate((url) => window.revokedUrls.has(url), oldUrl), true);
    assert.equal(await page.locator('#result-audio-error').isVisible(), false);
    await player.evaluate((a) => a.play());
    await select(0, 1);
    await page.locator('#add-deletion').click();
    await cleared(src);
    await page.locator('#undo').click();
    src = await exportFile(format);
    await player.evaluate((a) => a.play());
    await page.locator('#file-input').setInputFiles(source);
    await page.locator('#workspace').waitFor({ state: 'visible' });
    await cleared(src);
  }
  // A single kept piece has no internal seam, even with both ends trimmed.
  await select(1, 11);
  await page.locator('#keep-selection').click();
  await exportFile('wav', 10);
  assert.equal(await page.locator('#result-junction-markers button').count(), 0);
  assert.equal(await page.locator('#result-junction-previous').isDisabled(), true);
  assert.equal(await page.locator('#result-junction-next').isDisabled(), true);
  assert.equal(await page.locator('#result-junction-loop').isDisabled(), true);
  await page.locator('.result-preview').focus();
  await page.keyboard.press(']');
  await page.keyboard.press('l');
  assert.equal(await player.evaluate((a) => a.paused), true, 'no-join shortcuts cannot start playback');
  assert.match(await page.locator('#result-junction-status').textContent(), /沒有剪輯接點/);
  assert.deepEqual(errors, []);
  // Match the browser suite: the host antivirus injects its own monitoring script.
  // Keep its traffic separate from application traffic without disabling it.
  const environmentRequests = requests.filter((r) =>
    ['me.kis.v2.scr.kaspersky-labs.com', 'gc.kis.v2.scr.kaspersky-labs.com'].includes(new URL(r.url).hostname),
  );
  await writeFile(path.join(output, 'environment-requests.json'), JSON.stringify(environmentRequests, null, 2));
  const appRequests = requests.filter((r) => !environmentRequests.includes(r));
  await writeFile(path.join(output, 'app-requests.json'), JSON.stringify(appRequests, null, 2));
  assert.deepEqual(
    appRequests.filter((r) => /^https?:/.test(r.url) && (r.method !== 'GET' || !r.url.startsWith(url))),
    [],
    'no audio upload or external application requests',
  );
  await writeFile(path.join(output, 'report.json'), JSON.stringify({
    runtime: runtimeInfo(browser),
    fixture: { seconds: 12, channels: 2, sampleRate: 44100, synthetic: true },
    passed: ['mp3-wav-native-preview', 'same-download-source', 'no-autoplay-or-auto-download', 'junction-navigation', 'junction-loop', 'rapid-loop-stop', 'queued-seeked-before-seeking', 'keyboard-guards', 'preview-error-download', 'source-retirement', 'no-whole-output-decode', 'no-upload'],
  }, null, 2));
  console.log(
    `PASS ${channel}: MP3/WAV previews, scoped bracket/L shortcuts on panel/audio/slider, repeat/modifier/IME/input guards, first/last/hidden/error/no-join states, custom loops and downloads`,
  );
} finally {
  await context.close();
  await browser.close();
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

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

    await page.evaluate(async () => {
      const { MediaWindowPlayer } = await import('./media-window.mjs');
      window.loopTrace = [];
      const log = (type, instance) => {
        const audio = document.getElementById('result-audio');
        window.loopTrace.push({type, seeking:audio.seeking, paused:audio.paused,
          time:audio.currentTime, selected:[...document.querySelectorAll('#result-junction-markers button')].map(b=>b.getAttribute('aria-pressed')),
          target:instance?.seekTarget, stamp:performance.now()});
        if (window.loopTrace.length > 60) window.loopTrace.shift();
      };
      for (const name of ['start','stop','seek']) {
        const original = MediaWindowPlayer.prototype[name];
        MediaWindowPlayer.prototype[name] = function(...args) {
          log(name + ':before', this);
          const result = original.apply(this,args);
          log(name + ':after', this);
          return result;
        };
      }
      for (const type of ['seeking','seeked','play','pause','timeupdate']) {
        document.addEventListener(type, event => {
          if (event.target.id !== 'result-audio') return;
          log(type + ':before');
          queueMicrotask(() => log(type + ':after'));
        }, true);
      }
    });
    const outcomes = [];
    for (const delay of [0, 5, 20, 50]) {
      let failures = 0, firstFailure;
      for (let trial = 0; trial < 50; trial++) {
        await reviewJoin(markers.nth(1), 1, 3);
        await page.evaluate((delay) => {
          const loop = document.getElementById('result-junction-loop');
          loop.click();
          const end = performance.now() + delay;
          while (performance.now() < end) {}
          loop.click();
        }, delay);
        await page.waitForFunction(() => !document.getElementById('result-audio').seeking);
        // Separate task gives the queued media events a chance to run.
        await page.waitForTimeout(30);
        if (await markers.nth(1).getAttribute('aria-pressed') !== 'true') {
          failures++;
          firstFailure ??= await page.evaluate(() => window.loopTrace);
        }
      }
      outcomes.push({delay, trials:50, failures, firstFailure});
      console.log(JSON.stringify({format, delay, trials:50, failures}));
    }
    await writeFile(path.join(output, `loop-events-${format}.json`), JSON.stringify(outcomes, null, 2));
  }
} finally {
  await browser.close();
  await new Promise(resolve => server.close(resolve));
}

import assert from 'node:assert/strict';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startServer } from '../scripts/serve.mjs';
import { wavHeader } from '../pcm.mjs';

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
}
async function reviewJoin(control, index, start) {
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
    Math.abs((await player.evaluate((a) => a.currentTime)) - start) < 0.4,
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
    // Manual/native seeking leaves the numbered review and follows the playhead.
    await player.evaluate((a) => {
      a.currentTime = 0;
    });
    await page.waitForFunction(() => document.getElementById('result-junction-status').textContent === '共 2 個接點');
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
    await player.evaluate((a) => a.play());
    await page.evaluate(() => window.dispatchEvent(new PageTransitionEvent('pagehide', { persisted: true })));
    assert.equal(await player.evaluate((a) => a.paused), true);
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
  console.log(
    `PASS ${channel}: actual MP3/WAV, join markers and lead-in navigation, first/last/no-join states, native/slider seeks, keyboard, replay, errors, cleanup, responsive and local-only`,
  );
} finally {
  await context.close();
  await browser.close();
  if (server) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
}

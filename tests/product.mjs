import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startServer } from '../scripts/serve.mjs';
import { wavHeader } from '../pcm.mjs';
import { APP_VERSION } from '../version.mjs';

const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright'
);
const channel = process.env.BROWSER_CHANNEL || 'chrome',
  output = path.resolve('test-results', `product-${channel}`);
await mkdir(output, { recursive: true });
const { server, url } = process.env.SITE_URL
  ? { server: null, url: process.env.SITE_URL }
  : await startServer({ port: 0, base: '/audio-cutter/' });
const browser = await chromium.launch({ channel, headless: true });
try {
  const context = await browser.newContext({ acceptDownloads: true, viewport: { width: 1440, height: 1000 } });
  const page = await context.newPage(),
    errors = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('dialog', (dialog) => dialog.accept());
  await page.addInitScript(() => {
    const start = AudioBufferSourceNode.prototype.start;
    window.previewBuffers = [];
    AudioBufferSourceNode.prototype.start = function (...args) {
      window.previewBuffers.push(this.buffer);
      return start.apply(this, args);
    };
    const fill = CanvasRenderingContext2D.prototype.fillText;
    CanvasRenderingContext2D.prototype.fillText = function (text, x, y, ...rest) {
      if (text === 'ORIGINAL TIMELINE') {
        const metrics = this.measureText(text);
        window.timelineFooter = {
          top: y - metrics.actualBoundingBoxAscent,
          bottom: y + metrics.actualBoundingBoxDescent,
          height: this.canvas.height / this.getTransform().d,
          font: this.font,
        };
      }
      return fill.call(this, text, x, y, ...rest);
    };
  });
  await page.goto(url);
  await page.keyboard.press('Tab');
  assert.equal(await page.locator('.skip-link').evaluate((el) => el === document.activeElement), true);
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('main').evaluate((el) => el === document.activeElement), true);
  const frames = 4 * 44100,
    pcm = Buffer.alloc(frames * 4);
  for (let frame = 0; frame < frames; frame++) {
    pcm.writeInt16LE(Math.round(8000 + 1000 * Math.sin((frame / 44100) * Math.PI * 2 * 440)), frame * 4);
    pcm.writeInt16LE(Math.round(-6000 + 500 * Math.sin((frame / 44100) * Math.PI * 2 * 660)), frame * 4 + 2);
  }
  await page.locator('#file-input').setInputFiles({
    name: 'private-test-recording.wav',
    mimeType: 'audio/wav',
    buffer: Buffer.concat([Buffer.from(wavHeader(frames, 2, 44100)), pcm]),
  });
  await page.locator('#workspace').waitFor({ state: 'visible' });
  // The complete main workflow can be performed through keyboard-accessible form controls.
  await page.locator('#selection-start').focus();
  await page.keyboard.press('Control+a');
  await page.keyboard.type('1');
  await page.keyboard.press('Tab');
  await page.keyboard.press('Control+a');
  await page.keyboard.type('2');
  await page.keyboard.press('Enter');
  await page.locator('#add-deletion').focus();
  await page.keyboard.press('Enter');
  assert.equal(await page.locator('#pending-count').textContent(), '1');
  const advanced = page.locator('.advanced-help').first();
  assert.equal(await advanced.evaluate((el) => el.open), false, 'expert instructions are available on demand');
  await advanced.locator('summary').focus();
  await page.keyboard.press('Enter');
  assert.equal(await advanced.evaluate((el) => el.open), true);
  await page.locator('#join-fade').selectOption('5');
  await page.locator('#preview-deletions').focus();
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => window.previewBuffers.reduce((sum, buffer) => sum + buffer.length, 0) === 3 * 44100);
  const preview = await page.evaluate(async () => {
    const buffers = window.previewBuffers,
      frames = buffers.reduce((sum, buffer) => sum + buffer.length, 0);
    const bytes = new Uint8Array(frames * 4),
      view = new DataView(bytes.buffer);
    let offset = 0;
    for (const buffer of buffers) {
      for (let frame = 0; frame < buffer.length; frame++)
        for (let c = 0; c < 2; c++) {
          const sample = buffer.getChannelData(c)[frame];
          view.setInt16((offset + frame) * 4 + c * 2, Math.round(sample < 0 ? sample * 32768 : sample * 32767), true);
        }
      offset += buffer.length;
    }
    return await new Promise((resolve) => {
      const reader = new FileReader();
      reader.onload = () => resolve(reader.result.split(',')[1]);
      reader.readAsDataURL(new Blob([bytes]));
    });
  });
  await page.locator('#toggle-play').click();
  await page.locator('[name="format"][value="wav"]').check();
  await page.locator('#export-button').focus();
  await page.keyboard.press('Enter');
  await page.locator('#export-result').waitFor({ state: 'visible' });
  const download = page.waitForEvent('download');
  await page.locator('#download-link').focus();
  await page.keyboard.press('Enter');
  const file = path.join(output, 'faded.wav');
  await (await download).saveAs(file);
  const result = await readFile(file),
    previewPCM = Buffer.from(preview, 'base64');
  assert.deepEqual(result.subarray(44), previewPCM, 'real preview buffers and actual exported PCM must agree');
  assert.equal(result.readUInt32LE(40), 3 * 44100 * 4);
  for (const c of [0, 1]) {
    assert.equal(result.readInt16LE(44 + (44100 - 1) * 4 + c * 2), 0);
    assert.equal(result.readInt16LE(44 + 44100 * 4 + c * 2), 0);
  }
  assert.equal(result.readInt16LE(44), pcm.readInt16LE(0), 'file head is unchanged');
  assert.equal(result.readInt16LE(result.length - 2), pcm.readInt16LE(pcm.length - 2), 'file tail is unchanged');
  await page.locator('[name="format"][value="mp3"]').check();
  await page.locator('#export-button').click();
  await page.waitForFunction(
    () =>
      !document.getElementById('export-result').hidden &&
      document.getElementById('result-name').textContent.endsWith('.mp3'),
  );
  const mp3Download = page.waitForEvent('download');
  await page.locator('#download-link').click();
  const mp3Path = path.join(output, 'faded.mp3');
  await (await mp3Download).saveAs(mp3Path);
  const encoded = await readFile(mp3Path);
  const decoded = await page.evaluate(async (encoded) => {
    const context = new AudioContext();
    try {
      const buffer = await context.decodeAudioData(Uint8Array.from(atob(encoded), (char) => char.charCodeAt(0)).buffer);
      return {
        duration: buffer.duration,
        channels: buffer.numberOfChannels,
        rms: [0, 1].map((c) => {
          const data = buffer.getChannelData(c).slice(22050, 26460);
          return Math.sqrt(data.reduce((sum, value) => sum + value * value, 0) / data.length);
        }),
      };
    } finally {
      await context.close();
    }
  }, encoded.toString('base64'));
  assert.ok(Math.abs(decoded.duration - 3) < 0.15);
  assert.equal(decoded.channels, 2);
  assert.ok(decoded.rms[0] > 0.005 && decoded.rms[1] > 0.002, 'both channels contain the encoded tones');

  for (const width of [1440, 768, 390, 320]) {
    await page.setViewportSize({ width, height: 1000 });
    // WCAG's text enlargement mechanism: double the root text size, independently of the app presets.
    await page.evaluate(() => (document.documentElement.style.fontSize = '200%'));
    assert.equal(await page.evaluate(() => getComputedStyle(document.body).fontSize), '32px');
    const overflow = await page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
    if (overflow) {
      await page.screenshot({ path: path.join(output, `overflow-${width}.png`), fullPage: true });
      console.log(
        await page.evaluate(() =>
          [...document.querySelectorAll('body *')]
            .filter((el) => {
              const r = el.getBoundingClientRect();
              return r.width && r.right > innerWidth + 1 && !el.closest('svg');
            })
            .map((el) => ({
              id: el.id,
              class: el.className,
              width: el.getBoundingClientRect().width,
              right: el.getBoundingClientRect().right,
            }))
            .slice(0, 25),
        ),
      );
    }
    assert.equal(overflow, false, `200% text layout fits ${width}px`);
    assert.equal(
      await page.locator('#selection-start').evaluate((input) => input.scrollWidth <= input.clientWidth + 1),
      true,
      `complete time visible at ${width}px`,
    );
    await page.waitForFunction(() => window.timelineFooter?.font.startsWith('28px'));
    assert.equal(
      await page.evaluate(
        () => window.timelineFooter.top >= 0 && window.timelineFooter.bottom <= window.timelineFooter.height,
      ),
      true,
      'scaled Canvas footer is not clipped',
    );
    await page.screenshot({ path: path.join(output, `text-200-${width}.png`), fullPage: true });
  }
  await page.locator('#open-help').click();
  assert.equal(await page.locator('#help-dialog').isVisible(), true);
  assert.equal(await page.locator('#app-version').textContent(), APP_VERSION);
  const pending = await page.locator('#pending-summary').textContent();
  await page.keyboard.press('Delete');
  await page.keyboard.press('l');
  assert.equal(await page.locator('#pending-summary').textContent(), pending, 'help dialog isolates editor shortcuts');
  await page.locator('#copy-diagnostics').click();
  const diagnostics = JSON.parse(await page.locator('#diagnostics-output').inputValue());
  assert.equal(diagnostics.version, APP_VERSION);
  assert.equal(diagnostics.capabilities.worker, true);
  assert.ok(!JSON.stringify(diagnostics).includes('private-test-recording'));
  assert.deepEqual(
    Object.keys(diagnostics).sort(),
    ['app', 'browser', 'capabilities', 'lastIssue', 'secureContext', 'version'].sort(),
  );
  assert.equal(await page.locator('#help-dialog').evaluate((el) => el.scrollWidth <= el.clientWidth + 1), true);
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#help-dialog').isVisible(), false);
  assert.equal(await page.locator('#open-help').evaluate((el) => el === document.activeElement), true);
  assert.deepEqual(errors, []);
  const legacyContext = await browser.newContext(),
    legacy = await legacyContext.newPage();
  const legacyErrors = [];
  legacy.on('pageerror', (error) => legacyErrors.push(error.message));
  await legacy.route(
    url,
    async (route) => {
      const response = await route.fetch();
      await route.fulfill({
        response,
        body: (await response.text())
          .replace('id="save-project"', 'id="legacy-save"')
          .replace('id="help-dialog"', 'id="legacy-help"'),
      });
    },
    { times: 1 },
  );
  await legacy.goto(url);
  await legacy.waitForFunction(() => document.getElementById('notice').textContent.includes('音剪已更新'));
  assert.equal(await legacy.locator('#choose-file').textContent(), '重新載入音剪');
  const modern = legacy.waitForNavigation({ waitUntil: 'load' });
  await legacy.locator('#choose-file').click();
  await modern;
  await legacy.locator('#load-demo').click();
  await legacy.locator('#workspace').waitFor({ state: 'visible' });
  assert.ok(legacyErrors.length === 1 && legacyErrors[0].includes('頁面版本較舊'));
  const failureContext = await browser.newContext(),
    failure = await failureContext.newPage();
  await failure.route('**/app.mjs*', (route) => route.abort());
  await failure.goto(url);
  await failure.waitForFunction(() => document.getElementById('startup-message').textContent.includes('未能完整載入'));
  assert.equal(await failure.locator('#choose-file').isDisabled(), true);
  await failure.unroute('**/app.mjs*');
  const reloaded = failure.waitForNavigation({ waitUntil: 'load' });
  await failure.locator('#retry-startup').click();
  await reloaded;
  await failure.locator('#app-startup').waitFor({ state: 'hidden' });
  await failure.locator('#load-demo').click();
  await failure.locator('#workspace').waitFor({ state: 'visible' });
  const snapshotContext = await browser.newContext(),
    snapshot = await snapshotContext.newPage();
  snapshot.on('pageerror', (error) => errors.push(error.message));
  await snapshot.addInitScript(() => {
    const NativeWorker = Worker,
      delayed = new WeakSet();
    window.Worker = class extends NativeWorker {
      constructor(...args) {
        super(...args);
        if (String(args[0]).includes('export-worker.js'))
          this.addEventListener('message', (event) => {
            if (event.data.type !== 'progress' || delayed.has(event)) return;
            event.stopImmediatePropagation();
            setTimeout(() => {
              const next = new MessageEvent('message', { data: event.data });
              delayed.add(next);
              this.dispatchEvent(next);
            }, 500);
          });
      }
    };
  });
  await snapshot.goto(url);
  await snapshot.locator('#file-input').setInputFiles({
    name: 'snapshot.wav',
    mimeType: 'audio/wav',
    buffer: Buffer.concat([Buffer.from(wavHeader(frames, 2, 44100)), pcm]),
  });
  await snapshot.locator('#workspace').waitFor({ state: 'visible' });
  async function queueSnapshot(start, end) {
    await snapshot.locator('#selection-start').fill(start);
    await snapshot.locator('#selection-end').fill(end);
    await snapshot.locator('#selection-end').press('Enter');
    await snapshot.locator('#add-deletion').click();
  }
  await queueSnapshot('1', '2');
  await snapshot.locator('[name="format"][value="wav"]').check();
  await snapshot.locator('#export-button').click();
  await snapshot.locator('#export-progress').waitFor({ state: 'visible' });
  assert.equal(await snapshot.locator('#export-name').isDisabled(), true);
  await queueSnapshot('2.5', '3');
  await snapshot.locator('#export-result').waitFor({ state: 'visible' });
  assert.equal(await snapshot.locator('#result-version-note').isVisible(), true);
  assert.equal(await snapshot.locator('#output-duration').textContent(), '00:02.500');
  await snapshot.waitForFunction(() => document.getElementById('result-audio').readyState >= 1);
  assert.ok(Math.abs((await snapshot.locator('#result-audio').evaluate((audio) => audio.duration)) - 3) < 0.01);
  await snapshot.locator('#clear-deletions').click();
  assert.equal(
    await snapshot.locator('#export-result').isVisible(),
    false,
    'editing an already completed snapshot clears the old download',
  );
  assert.deepEqual(errors, []);
  await writeFile(
    path.join(output, 'result.json'),
    JSON.stringify(
      {
        passed: true,
        version: APP_VERSION,
        browser: channel,
        checks: [
          'keyboard main flow',
          '5ms preview/export PCM equality',
          'stereo boundaries and duration',
          '200% text layout',
          'help focus and shortcut guards',
          'private diagnostics',
          'faded MP3 playback',
          'module failure and reload recovery',
          'immutable export snapshot and explicit stale-result notice',
          'old-markup refresh recovery',
        ],
      },
      null,
      2,
    ),
  );
  console.log(
    `PASS ${channel}: main keyboard workflow, real faded preview/export equality, 200% text resizing, help focus and private diagnostics`,
  );
} finally {
  await browser.close();
  server?.close();
}

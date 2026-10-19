import assert from 'node:assert/strict';
import { mkdir, open, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startServer } from '../scripts/serve.mjs';
import { wavHeader } from '../pcm.mjs';
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright'
);
const channel = process.env.BROWSER_CHANNEL || 'chrome',
  output = path.resolve('test-results', `mp3-export-${channel}`);
await mkdir(output, { recursive: true });
const file = path.join(output, 'ninety-seconds.wav'),
  handle = await open(file, 'w');
try {
  await handle.write(wavHeader(90 * 44100, 2, 44100));
  const block = Buffer.alloc(44100 * 4);
  for (let i = 0; i < 44100; i++) {
    block.writeInt16LE(Math.round(0.3 * 32767 * Math.sin((i * 2 * Math.PI * 440) / 44100)), i * 4);
    block.writeInt16LE(Math.round(0.3 * 32767 * Math.sin((i * 2 * Math.PI * 880) / 44100)), i * 4 + 2);
  }
  for (let i = 0; i < 90; i++) await handle.write(block);
} finally {
  await handle.close();
}
const { server, url } = process.env.SITE_URL
  ? { server: null, url: process.env.SITE_URL }
  : await startServer({ port: 0, base: '/audio-cutter/' });
const browser = await chromium.launch({ channel, headless: true }),
  context = await browser.newContext({ acceptDownloads: true }),
  page = await context.newPage(),
  errors = [];
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (d) => d.accept());
const original = await readFile('export-worker.js', 'utf8');
const slow =
  "const post=self.postMessage.bind(self);self.postMessage=(data,...rest)=>data.type==='progress'?setTimeout(()=>post(data,...rest),50):post(data,...rest);\n";
try {
  await context.route('**/export-worker.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: slow + original }),
  );
  await page.addInitScript(() => {
    const Native = window.Worker;
    window.encoders = [];
    window.Worker = class extends Native {
      constructor(...args) {
        super(...args);
        if (String(args[0]).endsWith('/export-worker.js'))
          this.addEventListener('message', ({ data }) => {
            if (data.type === 'ready') window.encoders.push(data.encoder);
          });
      }
    };
  });
  await page.goto(url);
  await page.locator('#file-input').setInputFiles(file);
  await page.locator('#workspace').waitFor({ state: 'visible' });
  await page.locator('#export-button').click();
  assert.match(await page.locator('#export-eta').textContent(), /估算/);
  await page.waitForFunction(() => /預估剩餘 \d/.test(document.getElementById('export-eta').textContent));
  assert.doesNotMatch(await page.locator('#export-eta').textContent(), /NaN|Infinity|剩餘 0 秒/);
  await page.screenshot({ path: path.join(output, 'eta-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: path.join(output, 'eta-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.locator('#cancel-export').click();
  assert.equal(await page.locator('#export-eta').textContent(), '');
  await page.locator('#export-button').click();
  assert.match(await page.locator('#export-eta').textContent(), /估算/);
  const done = page.waitForEvent('download');
  const download = await done;
  const target = path.join(output, 'wasm.mp3');
  await download.saveAs(target);
  assert.equal(await page.locator('#export-eta').textContent(), '');
  assert.equal(await page.locator('#export-progress').isVisible(), false);
  assert.equal(await page.evaluate(() => window.encoders.at(-1)), 'wasm', 'Chrome and Edge must use the fast encoder');
  async function validate(target) {
    const bytes = await readFile(target);
    let sync = -1;
    for (let i = 0; i < Math.min(1024, bytes.length - 4); i++)
      if (bytes[i] === 255 && (bytes[i + 1] & 224) === 224) {
        sync = i;
        break;
      }
    assert.ok(sync >= 0);
    assert.equal(bytes[sync + 2] >> 4, 11, 'MPEG1 layer III must remain 192 kbps');
    assert.equal((bytes[sync + 2] >> 2) & 3, 0, 'output remains 44.1 kHz');
    return page.evaluate(
      async (bytes) => {
        const ctx = new AudioContext({ sampleRate: 44100 });
        try {
          const data = await ctx.decodeAudioData(new Uint8Array(bytes).buffer);
          return {
            duration: data.duration,
            channels: data.numberOfChannels,
            crossings: Array.from({ length: data.numberOfChannels }, (_, c) => {
              const samples = data.getChannelData(c);
              let count = 0;
              for (let i = 44101; i < 88200; i++) if (samples[i - 1] < 0 && samples[i] >= 0) count++;
              return count;
            }),
          };
        } finally {
          await ctx.close();
        }
      },
      [...bytes],
    );
  }
  const audio = await validate(target);
  assert.ok(Math.abs(audio.duration - 90) < 0.1);
  assert.equal(audio.channels, 2);
  audio.crossings.forEach((n, c) => assert.ok(Math.abs(n - (c ? 880 : 440)) <= 1));
  await context.unroute('**/export-worker.js');
  await context.route('**/export-worker.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: 'self.WebAssembly=undefined;\n' + original }),
  );
  const fallbackDone = page.waitForEvent('download');
  await page.locator('#export-button').click();
  const fallback = await fallbackDone;
  const fallbackPath = path.join(output, 'fallback.mp3');
  await fallback.saveAs(fallbackPath);
  assert.equal(await page.evaluate(() => window.encoders.at(-1)), 'lamejs');
  const compatibility = await validate(fallbackPath);
  assert.ok(Math.abs(compatibility.duration - 90) < 0.1);
  compatibility.crossings.forEach((n, c) => assert.ok(Math.abs(n - (c ? 880 : 440)) <= 1));
  assert.deepEqual(errors, []);
  console.log(
    `PASS ${channel}: WASM 192 kbps stereo, ETA warm-up/update/reset/cancel, disk-backed download, and JavaScript fallback`,
  );
} finally {
  await context.close();
  await browser.close();
  if (server) {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

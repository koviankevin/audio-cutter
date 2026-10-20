import assert from 'node:assert/strict';
import { mkdir, open, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startServer } from '../scripts/serve.mjs';
import { wavHeader } from '../pcm.mjs';
import { runtimeInfo } from './runtime-info.mjs';
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
page.setDefaultTimeout(60000);
page.on('pageerror', (e) => errors.push(e.message));
page.on('dialog', (d) => d.accept());
let downloads = 0;
page.on('download', () => downloads++);
const original = await readFile('export-worker.js', 'utf8');
const slow =
  "const post=self.postMessage.bind(self);self.postMessage=(data,...rest)=>setTimeout(()=>post(data,...rest),data.type==='ready'?1600:data.type==='complete'?2200:data.type==='progress'?50:0);\n";
async function assertCleared() {
  for (const id of ['export-eta', 'export-elapsed', 'export-speed'])
    assert.equal(await page.locator(`#${id}`).textContent(), '');
  assert.equal(await page.evaluate(() => window.exportTimers.size), 0, 'export timers must be released');
}
try {
  await context.route('**/export-worker.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: slow + original }),
  );
  await page.addInitScript(() => {
    const interval = window.setInterval.bind(window),
      clear = window.clearInterval.bind(window);
    window.exportTimers = new Set();
    window.setInterval = (...args) => {
      const id = interval(...args);
      // Ignore browser/test-runner housekeeping timers in the same window.
      if (args[0]?.name === 'renderExportProgress') window.exportTimers.add(id);
      return id;
    };
    window.clearInterval = (id) => {
      window.exportTimers.delete(id);
      clear(id);
    };
    const Native = window.Worker;
    window.encoders = [];
    window.Worker = class extends Native {
      constructor(...args) {
        super(...args);
        if (String(args[0]).endsWith('/export-worker.js')) {
          window.exportStartedAt = performance.now();
          this.addEventListener('message', ({ data }) => {
            if (data.type === 'ready') window.encoders.push(data.encoder);
            if (data.type === 'complete') window.exportFinishedAt = performance.now();
          });
        }
      }
    };
  });
  await page.goto(url);
  await page.locator('#file-input').setInputFiles(file);
  await page.locator('#workspace').waitFor({ state: 'visible' });
  await page.locator('#export-button').click();
  assert.match(await page.locator('#export-eta').textContent(), /估算/);
  assert.equal(await page.locator('#export-elapsed').textContent(), '00:00');
  assert.equal(await page.locator('#export-speed').textContent(), '計算中…');
  assert.equal(await page.evaluate(() => window.exportTimers.size), 1);
  await page.waitForFunction(() => document.getElementById('export-elapsed').textContent === '00:01');
  assert.equal(await page.locator('#export-status').textContent(), '正在準備匯出…');
  await page.waitForFunction(() => /預估剩餘 \d/.test(document.getElementById('export-eta').textContent));
  assert.match(await page.locator('#export-speed').textContent(), /^\d+\.\d×$/);
  assert.doesNotMatch(await page.locator('#export-eta').textContent(), /NaN|Infinity|剩餘 0 秒/);
  await page.screenshot({ path: path.join(output, 'eta-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: path.join(output, 'eta-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.locator('#cancel-export').click();
  await assertCleared();
  assert.equal(await page.locator('#export-result').isVisible(), false);
  await page.waitForTimeout(600);
  await assertCleared();
  await page.locator('#export-button').click();
  assert.match(await page.locator('#export-eta').textContent(), /估算/);
  assert.equal(await page.locator('#export-elapsed').textContent(), '00:00');
  assert.equal(await page.locator('#export-speed').textContent(), '計算中…');
  await page.waitForFunction(() => document.getElementById('export-eta').textContent === '最後寫入中…');
  assert.equal(await page.locator('#export-speed').textContent(), '—');
  const finalElapsed = await page.locator('#export-elapsed').textContent();
  await page.waitForFunction(
    (before) => document.getElementById('export-elapsed').textContent !== before,
    finalElapsed,
  );
  assert.equal(await page.locator('#export-eta').textContent(), '最後寫入中…');
  await page.locator('#export-result').waitFor({ state: 'visible' });
  await assertCleared();
  const summary = await page.locator('#export-result > .export-stats').textContent();
  assert.match(await page.locator('#result-name').textContent(), /\.mp3$/);
  const actualSeconds = await page.evaluate(() => (window.exportFinishedAt - window.exportStartedAt) / 1000);
  const shownElapsed = await page.locator('#result-elapsed').textContent();
  const elapsedParts = shownElapsed.split(':').map(Number);
  const shownSeconds = elapsedParts.reduce((sum, part) => sum * 60 + part, 0);
  assert.ok(Math.abs(shownSeconds - actualSeconds) < 0.2, 'summary must include preparation and final-write delay');
  const average = parseFloat(await page.locator('#result-speed').textContent());
  assert.ok(Math.abs(average - 90 / actualSeconds) < 0.2, 'average must use the entire job duration');
  await page.screenshot({ path: path.join(output, 'result-desktop.png'), fullPage: true });
  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > innerWidth), false);
  await page.screenshot({ path: path.join(output, 'result-mobile.png'), fullPage: true });
  await page.setViewportSize({ width: 1280, height: 720 });
  await page.waitForTimeout(600);
  assert.equal(downloads, 0, 'allow reviewing the result before choosing to download');
  assert.equal(
    await page.locator('#export-result > .export-stats').textContent(),
    summary,
    'completed metrics must stop changing',
  );
  const done = page.waitForEvent('download');
  await page.locator('#download-link').click();
  const download = await done;
  const target = path.join(output, 'wasm.mp3');
  await download.saveAs(target);
  const outputBytes = (await readFile(target)).length;
  assert.equal(
    await page.locator('#result-size').getAttribute('title'),
    `${outputBytes.toLocaleString('zh-TW')} 位元組`,
  );
  assert.equal(await page.locator('#result-size').textContent(), `${(outputBytes / 1024 ** 2).toFixed(2)} MiB`);
  assert.equal(
    await page.locator('#export-result > .export-stats').textContent(),
    summary,
    'downloading must retain the summary',
  );
  await assertCleared();
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
    return page.evaluate(async (base64) => {
      const ctx = new AudioContext({ sampleRate: 44100 });
      try {
        const bytes = Uint8Array.from(atob(base64), (char) => char.charCodeAt(0));
        const data = await ctx.decodeAudioData(bytes.buffer);
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
    }, bytes.toString('base64'));
  }
  const audio = await validate(target);
  assert.ok(Math.abs(audio.duration - 90) < 0.1);
  assert.equal(audio.channels, 2);
  audio.crossings.forEach((n, c) => assert.ok(Math.abs(n - (c ? 880 : 440)) <= 1));
  await context.unroute('**/export-worker.js');
  await context.route('**/export-worker.js', (route) =>
    route.fulfill({ contentType: 'text/javascript', body: 'self.WebAssembly=undefined;\n' + original }),
  );
  await page.locator('#export-button').click();
  assert.equal(await page.locator('#export-result').isVisible(), false);
  assert.equal(await page.locator('#result-size').textContent(), '');
  await page.locator('#export-result').waitFor({ state: 'visible' });
  const fallbackDone = page.waitForEvent('download');
  await page.locator('#download-link').click();
  const fallback = await fallbackDone;
  const fallbackPath = path.join(output, 'fallback.mp3');
  await fallback.saveAs(fallbackPath);
  assert.equal(await page.evaluate(() => window.encoders.at(-1)), 'lamejs');
  const compatibility = await validate(fallbackPath);
  assert.ok(Math.abs(compatibility.duration - 90) < 0.1);
  assert.equal(compatibility.channels, 2);
  compatibility.crossings.forEach((n, c) => assert.ok(Math.abs(n - (c ? 880 : 440)) <= 1));
  await assertCleared();
  await context.unroute('**/export-worker.js');
  await context.route('**/export-worker.js', (route) =>
    route.fulfill({
      contentType: 'text/javascript',
      body: "self.onmessage=()=>setTimeout(()=>self.postMessage({type:'error',message:'測試匯出錯誤'}),1600);",
    }),
  );
  await page.locator('#export-button').click();
  await page.waitForFunction(() => document.getElementById('export-elapsed').textContent === '00:01');
  await page.waitForFunction(() => document.getElementById('notice').textContent.includes('測試匯出錯誤'));
  await assertCleared();
  assert.equal(await page.locator('#export-result').isVisible(), false);
  await page.locator('#export-button').click();
  await page.locator('#file-input').setInputFiles(file);
  await page.waitForFunction(() => document.getElementById('export-progress').hidden);
  await assertCleared();
  assert.equal(await page.locator('#export-result').isVisible(), false);
  assert.deepEqual(errors, []);
  await writeFile(path.join(output, 'report.json'), JSON.stringify({
    runtime: runtimeInfo(browser),
    fixture: { seconds: 90, channels: 2, sampleRate: 44100, synthetic: true },
    wasm: audio, fallback: compatibility,
    passed: ['wasm', '192-kbps', 'cancel-and-reexport', 'eta', 'javascript-fallback', 'retained-summary', 'manual-download', 'result-reset', 'timer-cleanup'],
  }, null, 2));
  console.log(
    `PASS ${channel}: MP3 codecs, live progress, retained total/average/actual size before manual download, frozen metrics after download, result reset and cleanup, desktop/mobile`,
  );
} finally {
  await context.close();
  await browser.close();
  if (server) {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

import assert from 'node:assert/strict';
import { mkdir, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startServer } from '../scripts/serve.mjs';
import { parseTime } from '../core.mjs';
import { runtimeInfo } from './runtime-info.mjs';
import { workerMemory } from './worker-memory.mjs';

const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright'
);
const source = path.resolve(process.env.LONG_SOURCE || 'test-results/streaming/28-minutes.mp3');
try {
  await stat(source);
} catch {
  throw Error('請先以 LONG_AUDIO=1 執行 tests/streaming.mjs 產生合成長檔，或指定 LONG_SOURCE。');
}
const output = path.resolve('test-results', `product-long-${process.env.BROWSER_CHANNEL || 'chrome'}`);
await mkdir(output, { recursive: true });
const { server, url } = await startServer({ port: 0, base: '/audio-cutter/' });
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true });
try {
  const context = await browser.newContext({ acceptDownloads: true }),
    page = await context.newPage(),
    errors = [],
    requests = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('dialog', (dialog) => dialog.accept());
  context.on('request', (request) => requests.push({ url: request.url(), method: request.method() }));
  const cdp = await context.newCDPSession(page),
    report = { runtime: runtimeInfo(browser), synthetic: true, sourceBytes: (await stat(source)).size };
  await page.goto(url);
  const loadStart = performance.now();
  await page.locator('#file-input').setInputFiles(source);
  await page.locator('#workspace').waitFor({ state: 'visible', timeout: 120000 });
  report.loadMs = performance.now() - loadStart;
  for (const [start, end] of [
    [60, 65],
    [300, 310],
    [1000, 1005],
  ]) {
    await page.locator('#selection-start').fill(String(start));
    await page.locator('#selection-end').fill(String(end));
    await page.locator('#selection-end').press('Enter');
    await page.locator('#add-deletion').click();
  }
  await page.locator('#join-fade').selectOption('5');
  const seconds = parseTime(await page.locator('#output-duration').textContent());
  assert.ok(seconds > 1600 && seconds < 1800);
  await cdp.send('HeapProfiler.collectGarbage');
  report.afterLoad = await cdp.send('Runtime.getHeapUsage');
  assert.ok(
    report.afterLoad.backingStorageSize < 20 * 1024 ** 2,
    'the long original must not stay as complete PCM in main-page buffers',
  );
  const start = performance.now();
  await page.locator('#export-button').click();
  await page.locator('#export-progress').waitFor({ state: 'visible' });
  await page.locator('#preview-result').click();
  await page.waitForFunction(() => document.getElementById('toggle-play').getAttribute('aria-label') === '暫停');
  await page.locator('#toggle-play').click();
  await page.waitForFunction(
    () => document.getElementById('progress-bar').value >= 85 || !document.getElementById('export-result').hidden,
    {},
    { timeout: 180000 },
  );
  await cdp.send('HeapProfiler.collectGarbage');
  report.nearCompleteMain = await cdp.send('Runtime.getHeapUsage');
  report.encoder = await workerMemory(browser, 'export-worker.js');
  assert.ok(report.nearCompleteMain.backingStorageSize < 20 * 1024 ** 2);
  assert.equal(report.encoder.length, 1);
  assert.ok(report.encoder[0].backingStorageSize < 32 * 1024 ** 2);
  await page.locator('#export-result').waitFor({ state: 'visible', timeout: 180000 });
  report.exportMs = performance.now() - start;
  await page.waitForFunction(() => document.getElementById('result-audio').readyState >= 1);
  report.outputSeconds = await page.locator('#result-audio').evaluate((audio) => audio.duration);
  assert.ok(Math.abs(report.outputSeconds - seconds) < 0.2);
  const download = page.waitForEvent('download');
  await page.locator('#download-link').click();
  const file = path.join(output, 'long-faded.mp3');
  await (await download).saveAs(file);
  report.outputBytes = (await stat(file)).size;
  assert.ok(Math.abs(report.outputBytes / (seconds * 24000) - 1) < 0.02, 'full 192kbps output, not a truncated file');
  assert.match(
    await page.locator('#result-size').getAttribute('title'),
    new RegExp(report.outputBytes.toLocaleString('zh-TW')),
  );
  await page.locator('#result-audio').evaluate(async (audio) => {
    audio.currentTime = audio.duration - 0.5;
    await audio.play();
  });
  await page.waitForFunction(() => document.getElementById('result-audio').ended, null, { timeout: 10000 });
  assert.deepEqual(errors, []);
  const external = requests.filter((request) => /^https?:/.test(request.url) && !request.url.startsWith(url));
  report.environmentRequestOrigins = [
    ...new Set(
      external
        .filter((request) => /^https?:\/\/(?:me|gc)\.kis\.v2\.scr\.kaspersky-labs\.com\//.test(request.url))
        .map((request) => new URL(request.url).origin),
    ),
  ];
  assert.deepEqual(
    requests
      .filter(
        (request) =>
          /^https?:/.test(request.url) &&
          !request.url.startsWith(url) &&
          !/^https?:\/\/(?:me|gc)\.kis\.v2\.scr\.kaspersky-labs\.com\//.test(request.url),
      )
      .map((request) => ({ origin: new URL(request.url).origin, method: request.method })),
    [],
  );
  assert.ok(requests.filter((request) => request.url.startsWith(url)).every((request) => request.method === 'GET'));
  report.passed = true;
  await writeFile(path.join(output, 'report.json'), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await browser.close();
  server.close();
}

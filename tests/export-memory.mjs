import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startServer } from '../scripts/serve.mjs';
import { workerMemory } from './worker-memory.mjs';
import { runtimeInfo } from './runtime-info.mjs';
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright'
);
const { server, url } = process.env.SITE_URL
  ? { server: null, url: process.env.SITE_URL }
  : await startServer({ port: 0, base: '/audio-cutter/' });
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true });
const page = await browser.newPage();
const seconds = Number(process.env.EXPORT_SECONDS || 240);
const format = process.env.EXPORT_FORMAT || 'wav';
try {
  if (process.env.EXPORT_WORKER_SOURCE) {
    const body = await readFile(process.env.EXPORT_WORKER_SOURCE, 'utf8');
    await page.route('**/export-worker.js*', (route) => route.fulfill({ contentType: 'text/javascript', body }));
  }
  await page.goto(url);
  const start = Date.now();
  await page.evaluate(
    ({ seconds, format }) => {
      window.exportAudit = { processed: 0, error: null };
      window.exportLongTasks = [];
      window.exportTicks = 0;
      window.exportTickTimer = setInterval(() => window.exportTicks++, 20);
      new PerformanceObserver((list) =>
        window.exportLongTasks.push(...list.getEntries().map((e) => e.duration)),
      ).observe({ type: 'longtask', buffered: false });
      const worker = (window.exportWorker = new Worker(new URL('./export-worker.js', location.href)));
      const frames = Math.round(seconds * 44100),
        pauseAt = Math.floor(frames * 0.85);
      window.sendExportChunk = () => {
        const count = Math.min(73728, frames - window.exportAudit.processed);
        const channels = [new Float32Array(count).buffer, new Float32Array(count).buffer];
        worker.postMessage({ type: 'chunk', channels }, channels);
      };
      worker.onmessage = ({ data }) => {
        if (data.type === 'error') window.exportAudit.error = data.message;
        else if (data.type === 'ready') window.sendExportChunk();
        else if (data.type === 'progress') {
          window.exportAudit.wasmBytes = Math.max(window.exportAudit.wasmBytes || 0, data.wasmBytes || 0);
          window.exportAudit.processed = data.processed;
          if (window.continueExport && data.processed === frames) worker.postMessage({ type: 'finish' });
          else if (window.continueExport || data.processed < pauseAt) window.sendExportChunk();
          else window.exportAudit.paused = true;
        } else if (data.type === 'complete') {
          window.exportBlob = data.blob;
          window.exportAudit.complete = true;
        }
      };
      worker.postMessage({
        type: 'init',
        format,
        channels: 2,
        sampleRate: 44100,
        frames,
        exportId: `out-${crypto.randomUUID()}`,
      });
    },
    { seconds, format },
  );
  await page.waitForFunction(() => window.exportAudit.paused || window.exportAudit.error, null, { timeout: 180000 });
  assert.equal(await page.evaluate(() => window.exportAudit.error), null);
  const heap = await workerMemory(browser, 'export-worker.js');
  assert.equal(heap.length, 1);
  const report = {
    runtime: runtimeInfo(browser),
    fixture: 'synthetic stereo silence, 44.1 kHz',
    seconds,
    format,
    processed: await page.evaluate(() => window.exportAudit.processed),
    workerHeap: heap[0],
    wasmBytes: await page.evaluate(() => window.exportAudit.wasmBytes || 0),
  };
  if (process.env.EXPORT_COMPLETE === '1') {
    await page.evaluate(() => {
      window.continueExport = true;
      window.sendExportChunk();
    });
    await page.waitForFunction(() => window.exportAudit.complete || window.exportAudit.error, null, {
      timeout: 180000,
    });
    assert.equal(await page.evaluate(() => window.exportAudit.error), null);
    report.encodeMs = Date.now() - start;
    report.finishedWorkerHeap = (await workerMemory(browser, 'export-worker.js'))[0];
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('HeapProfiler.collectGarbage');
    report.mainHeap = await cdp.send('Runtime.getHeapUsage');
    report.output = await page.evaluate(async () => {
      clearInterval(window.exportTickTimer);
      return {
        size: window.exportBlob.size,
        isFile: window.exportBlob instanceof File,
        header: [...new Uint8Array(await window.exportBlob.slice(0, 44).arrayBuffer())],
        ticks: window.exportTicks,
        longTasks: window.exportLongTasks,
      };
    });
    if (format === 'wav') {
      assert.equal(report.output.size, 44 + seconds * 44100 * 4);
      assert.equal(new DataView(new Uint8Array(report.output.header).buffer).getUint32(40, true), seconds * 44100 * 4);
    } else assert.ok(Math.abs(report.output.size - (seconds * 192000) / 8) < 5000);
    assert.equal(report.output.isFile, true, 'completed output must remain file-backed');
    assert.ok(report.finishedWorkerHeap.backingStorageSize < 16 * 1024 ** 2);
    assert.ok(report.mainHeap.backingStorageSize < 16 * 1024 ** 2);
    const downloaded = page.waitForEvent('download');
    await page.evaluate((format) => {
      const link = document.createElement('a');
      link.id = 'test-download';
      link.textContent = 'Download result';
      link.href = URL.createObjectURL(window.exportBlob);
      link.download = `long.${format}`;
      document.body.append(link);
      link.click();
    }, format);
    const download = await downloaded;
    await download.saveAs(path.resolve(`test-results/export-memory/long.${format}`));
    assert.equal(await download.failure(), null);
    const repeated = page.waitForEvent('download');
    await page.locator('#test-download').click();
    assert.equal(await (await repeated).failure(), null);
    // An in-flight download must remain valid if editing revokes the old result.
    const inflight = page.waitForEvent('download');
    await page.locator('#test-download').click();
    const ongoing = await inflight;
    await page.evaluate(async () => {
      URL.revokeObjectURL(document.getElementById('test-download').href);
      const { retireExportFile } = await import('./export-store.mjs');
      await retireExportFile({ worker: window.exportWorker, cacheName: window.exportBlob.name });
    });
    assert.equal(await ongoing.failure(), null, 'revoking an old result must not break a started download');
    report.elapsedMs = Date.now() - start;
  }
  await mkdir('test-results/export-memory', { recursive: true });
  await writeFile(
    path.resolve(`test-results/export-memory/${process.env.PERF_LABEL || 'current'}.json`),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
  assert.ok(
    heap[0].backingStorageSize < 16 * 1024 ** 2,
    'encoded output must not accumulate in Worker RAM as export length grows',
  );
  assert.ok(report.wasmBytes < 32 * 1024 ** 2, 'native encoder linear memory must remain bounded');
} finally {
  await page.evaluate(() => window.exportWorker?.terminate()).catch(() => {});
  await browser.close();
  if (server) {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

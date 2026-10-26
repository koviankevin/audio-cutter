import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startServer } from '../scripts/serve.mjs';
import { runtimeInfo } from './runtime-info.mjs';
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright'
);
const { server, url } = await startServer({ port: 0, base: '/audio-cutter/' });
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true }),
  page = await browser.newPage();
const seconds = Number(process.env.MP3_SECONDS || 60);
try {
  if (process.env.MP3_WORKER_SOURCE) {
    const body = await readFile(process.env.MP3_WORKER_SOURCE, 'utf8');
    await page.route('**/export-worker.js*', (route) => route.fulfill({ contentType: 'text/javascript', body }));
  }
  await page.goto(url);
  const report = await page.evaluate(
    (seconds) =>
      new Promise((resolve, reject) => {
        const start = performance.now(),
          worker = new Worker(new URL('./export-worker.js', location.href));
        window.encoderBenchmarkWorker = worker;
        const frames = seconds * 44100;
        let processed = 0,
          encoder,
          wasmBytes = 0;
        const next = () => {
          const count = Math.min(73728, frames - processed),
            channels = [0, 1].map(
              (c) =>
                Float32Array.from(
                  { length: count },
                  (_, i) => 0.3 * Math.sin((2 * Math.PI * (c ? 880 : 440) * (processed + i)) / 44100),
                ).buffer,
            );
          worker.postMessage({ type: 'chunk', channels }, channels);
        };
        worker.onmessage = ({ data }) => {
          if (data.type === 'error') reject(Error(data.message));
          else if (data.type === 'ready') {
            encoder = data.encoder;
            next();
          } else if (data.type === 'progress') {
            wasmBytes = Math.max(wasmBytes, data.wasmBytes || 0);
            processed = data.processed;
            if (processed < frames) next();
            else worker.postMessage({ type: 'finish' });
          } else if (data.type === 'complete') {
            window.benchmarkFile = data.blob;
            resolve({ seconds, elapsedMs: performance.now() - start, size: data.blob.size, encoder, wasmBytes });
          }
        };
        worker.onerror = (e) => reject(Error(e.message));
        worker.postMessage({
          type: 'init',
          exportId: `out-${crypto.randomUUID()}`,
          format: 'mp3',
          channels: 2,
          sampleRate: 44100,
          frames,
        });
      }),
    seconds,
  );
  report.runtime = runtimeInfo(browser);
  report.fixture = 'synthetic stereo tones, 44.1 kHz';
  await mkdir('test-results/mp3-speed', { recursive: true });
  await writeFile(
    path.resolve(`test-results/mp3-speed/${process.env.PERF_LABEL || 'current'}.json`),
    JSON.stringify(report, null, 2),
  );
  console.log(JSON.stringify(report));
  if (process.env.MP3_MAX_MS)
    assert.ok(
      report.elapsedMs < Number(process.env.MP3_MAX_MS),
      'MP3 encoding must meet the measured speed regression budget',
    );
} finally {
  await browser.close();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
}

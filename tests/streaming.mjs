import assert from 'node:assert/strict';
import { mkdir, open, readFile, writeFile, stat } from 'node:fs/promises';
import vm from 'node:vm';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startServer } from '../scripts/serve.mjs';
import { wavHeader } from '../pcm.mjs';
import { workerMemory } from './worker-memory.mjs';
import { runtimeInfo } from './runtime-info.mjs';
const { chromium } = await import(
  process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright'
);
const out = path.resolve('test-results/streaming');
await mkdir(out, { recursive: true });
const file = path.join(out, 'ninety-seconds.wav'),
  frames = 90 * 44100;
const tone = (frame, channel, rate = 44100) =>
  Math.round(Math.sin((2 * Math.PI * (channel ? 880 : 440) * frame) / rate) * 12000);
async function fixture(name, rate, channels, mp3 = false) {
  const target = path.join(out, name);
  try {
    const size = (await stat(target)).size;
    if (size >= (mp3 ? (90 * 192000) / 8 : 44 + rate * 90 * channels * 2)) return target;
  } catch {}
  const handle = await open(target, 'w');
  let encoder;
  if (mp3) {
    const scope = {};
    vm.runInNewContext(await readFile('vendor/lame.min.js', 'utf8'), scope);
    encoder = new scope.lamejs.Mp3Encoder(channels, rate, 192);
  }
  try {
    if (!mp3) await handle.write(wavHeader(rate * 90, channels, rate));
    for (let start = 0; start < rate * 90; start += 1152) {
      const count = Math.min(1152, rate * 90 - start),
        data = Array.from({ length: channels }, (_, c) =>
          Int16Array.from({ length: count }, (_, i) => tone(start + i, c, rate)),
        );
      if (mp3) await handle.write(encoder.encodeBuffer(...data));
      else {
        const bytes = Buffer.alloc(count * channels * 2);
        for (let i = 0; i < count; i++)
          for (let c = 0; c < channels; c++) bytes.writeInt16LE(data[c][i], (i * channels + c) * 2);
        await handle.write(bytes);
      }
    }
    if (mp3) await handle.write(encoder.flush());
  } finally {
    await handle.close();
  }
  return target;
}
await fixture('ninety-seconds.wav', 44100, 2);
const resampled = await fixture('48k.wav', 48000, 2),
  mp3 = await fixture('stereo.mp3', 44100, 2, true),
  mono = await fixture('mono-48k.mp3', 48000, 1, true);
const tagged = path.join(out, 'tagged.mp3'),
  tag = new Uint8Array(262154);
tag.set([73, 68, 51, 4, 0, 0, 0, 16, 0, 0]); // 256 KiB ID3v2 payload, skipped without decoding it.
tag.set([255, 251, 144, 192], 100); // A false mono MPEG sync inside the tag must be ignored.
await writeFile(tagged, Buffer.concat([tag, await readFile(mp3)]));
const { server, url } = process.env.SITE_URL
  ? { server: null, url: process.env.SITE_URL }
  : await startServer({ port: 0, base: '/audio-cutter/' });
const browser = await chromium.launch({ channel: process.env.BROWSER_CHANNEL || 'chrome', headless: true }),
  context = await browser.newContext({ acceptDownloads: true });
const page = await context.newPage();
page.on('dialog', (d) => d.accept());
const errors = [];
page.on('pageerror', (e) => errors.push(e.message));
const requests = [];
context.on('request', (r) => requests.push({ url: r.url(), method: r.method() }));
await page.addInitScript(() => {
  window.wholeReads = [];
  window.starts = [];
  window.longTasks = [];
  const read = Blob.prototype.arrayBuffer;
  Blob.prototype.arrayBuffer = function (...args) {
    if (this.size > 4 * 1024 * 1024) window.wholeReads.push(this.size);
    return read.apply(this, args);
  };
  const start = AudioBufferSourceNode.prototype.start;
  AudioBufferSourceNode.prototype.start = function (...args) {
    window.starts.push({
      length: this.buffer.length,
      channels: this.buffer.numberOfChannels,
      loop: this.loop,
      samples: Array.from({ length: this.buffer.numberOfChannels }, (_, c) =>
        [0, 44099, 44100, 88199].filter((i) => i < this.buffer.length).map((i) => this.buffer.getChannelData(c)[i]),
      ),
    });
    return start.apply(this, args);
  };
  new PerformanceObserver((list) => window.longTasks.push(...list.getEntries().map((e) => e.duration))).observe({
    type: 'longtask',
    buffered: false,
  });
});
const report = { channel: process.env.BROWSER_CHANNEL || 'chrome', runtime: runtimeInfo(browser) };
async function select(a, b) {
  await page.evaluate(
    ([a, b]) => {
      document.getElementById('selection-start').value = String(a);
      const end = document.getElementById('selection-end');
      end.value = String(b);
      end.dispatchEvent(new Event('change', { bubbles: true }));
    },
    [a, b],
  );
}
async function load(target) {
  await page.locator('#file-input').setInputFiles(target);
  await page.waitForFunction(
    (name) => document.getElementById('file-name').textContent === name && !document.getElementById('workspace').hidden,
    path.basename(target),
    { timeout: 60000 },
  );
}
async function cacheNames(target = page) {
  return target.evaluate(async () => {
    try {
      const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('yin-jian-audio-cache');
      const names = [];
      for await (const name of dir.keys()) names.push(name);
      return names;
    } catch {
      return [];
    }
  });
}
try {
  await page.goto(url);
  await page.evaluate(async () => {
    const { AudioEngine } = await import('./audio.mjs');
    const decode = AudioEngine.prototype.decode;
    AudioEngine.prototype.decode = async function (...args) {
      window.audioEngine = this;
      return decode.apply(this, args);
    };
    const duration = Object.getOwnPropertyDescriptor(HTMLMediaElement.prototype, 'duration').get;
    Object.defineProperty(HTMLMediaElement.prototype, 'duration', {
      configurable: true,
      get() {
        return window.durationEstimate ?? duration.call(this);
      },
    });
  });
  await page.waitForTimeout(100);
  await page.evaluate(() => (window.longTasks = []));
  const start = Date.now();
  await load(file);
  assert.equal(await page.locator('#original-duration').textContent(), '01:30.000');
  assert.deepEqual(
    await page.evaluate(() => window.wholeReads),
    [],
    'long files must be read as bounded slices, never one full arrayBuffer',
  );
  const cdp = await context.newCDPSession(page);
  await cdp.send('HeapProfiler.collectGarbage');
  const heap = await cdp.send('Runtime.getHeapUsage');
  assert.ok(heap.backingStorageSize < 20 * 1024 ** 2, 'long PCM must not remain as a full in-memory buffer');
  report.wav = {
    loadMs: Date.now() - start,
    backingMiB: heap.backingStorageSize / 1024 ** 2,
    longTasks: await page.evaluate(() => window.longTasks),
  };
  assert.equal(await page.evaluate(() => window.audioEngine.buffer.mode), 'file');
  const sample = await page.evaluate(async () => {
    const source = window.audioEngine.buffer;
    return (await source.readChannels(65530, 65550)).map((c) => [...c]);
  });
  sample.forEach((values, c) => values.forEach((v, i) => assert.equal(v, tone(65530 + i, c) / 32768)));
  await select(1, 2);
  await page.locator('#add-deletion').click();
  await page.locator('#loop-junction').click();
  await page.waitForTimeout(200);
  assert.equal(await page.evaluate(() => window.starts.at(-1).loop), true);
  await page.locator('#waveform').focus();
  await page.keyboard.press('2');
  await page.keyboard.press('ArrowRight');
  await page.waitForTimeout(200);
  assert.equal(
    await page.evaluate(() => window.starts.at(-1).loop),
    true,
    'loop restarts after nudge with streamed data',
  );
  await page.keyboard.press('Escape');
  await page.keyboard.press('Control+z');
  await select(3, 5);
  await page.locator('#add-deletion').click();
  await page.evaluate(() => (window.starts = []));
  await page.locator('#preview-deletions').click();
  await page.waitForTimeout(6500);
  const playback = await page.evaluate(() => ({ starts: window.starts, nodes: window.audioEngine.nodes.length }));
  assert.ok(playback.starts.length >= 5);
  assert.ok(playback.nodes <= 3, 'lookahead nodes must be retired');
  assert.ok(
    playback.starts.every((s) => s.length <= 88200),
    'playback buffers must be bounded',
  );
  playback.starts[0].samples.forEach((values, c) =>
    [0, 44099, 88200, 132299].forEach((frame, i) => assert.equal(values[i], tone(frame, c) / 32768)),
  );
  await page.locator('#waveform').focus();
  await page.keyboard.press('Space');
  await page.locator('#apply-deletions').click();
  await select(0, 6);
  await page.locator('#keep-selection').click();
  await page.locator('[name="format"][value="wav"]').check();
  const downloadPromise = page.waitForEvent('download');
  await page.locator('#export-button').click();
  await page.locator('#download-link').click();
  const download = await downloadPromise;
  const wavTarget = path.join(out, 'edited.wav');
  await download.saveAs(wavTarget);
  const wav = await readFile(wavTarget);
  assert.equal(wav.length, 44 + 44100 * 3 * 4);
  for (let frame = 0; frame < 44100 * 3; frame++) {
    const original = frame < 44100 ? frame : frame < 88200 ? frame + 44100 : frame + 3 * 44100;
    for (let c = 0; c < 2; c++) assert.ok(Math.abs(wav.readInt16LE(44 + (frame * 2 + c) * 2) - tone(original, c)) <= 1);
  }
  await load(resampled);
  const resampling = await page.evaluate(async () => {
    const source = window.audioEngine.buffer,
      data = await source.readChannels(65530, 65650);
    return { length: source.length, channels: source.numberOfChannels, data: data.map((c) => [...c]) };
  });
  assert.equal(resampling.length, frames);
  assert.equal(resampling.channels, 2);
  resampling.data.forEach((values, c) =>
    values.forEach((v, i) =>
      assert.ok(Math.abs(v - tone(65530 + i, c) / 32768) < 0.001, '48k resampling retains time and stereo'),
    ),
  );
  for (const target of [mp3, mono, tagged]) {
    // A VBR duration estimate must neither force full decoding nor falsely reject a valid file.
    await page.evaluate(
      (estimate) => (window.durationEstimate = estimate),
      target === mp3 ? 1 : target === mono ? 3600 : null,
    );
    const start = Date.now();
    await load(target);
    await page.evaluate(() => (window.durationEstimate = null));
    const details = await page.evaluate(async () => {
      const s = window.audioEngine.buffer;
      const data = await s.readChannels(44100, 88200);
      return {
        length: s.length,
        channels: s.numberOfChannels,
        mode: s.mode,
        maxReadBytes: s.maxReadBytes,
        storageBytes: s.storageBytes,
        rms: data.map((c) => Math.sqrt(c.reduce((sum, v) => sum + v * v, 0) / c.length)),
        crossings: data.map((c) => {
          let n = 0;
          for (let i = 1; i < c.length; i++) if (c[i - 1] < 0 && c[i] >= 0) n++;
          return n;
        }),
      };
    });
    assert.equal(details.mode, 'pcm-cache');
    assert.equal(details.channels, target === mono ? 1 : 2);
    assert.ok(Math.abs(details.length / 44100 - 90) < 0.1);
    assert.ok(details.maxReadBytes <= 65536);
    details.rms.forEach((v) => assert.ok(v > 0.24 && v < 0.28));
    details.crossings.forEach((n, c) => assert.ok(Math.abs(n - (c ? 880 : 440)) <= 1));
    assert.equal((await cacheNames()).length, 1);
    report[path.basename(target)] = { ...details, loadMs: Date.now() - start };
    await select(1, 4);
    await page.locator('#keep-selection').click();
    await page.locator('#preview-result').click();
    await page.waitForTimeout(100);
    await page.locator('#waveform').focus();
    await page.keyboard.press('Space');
    await page.locator('[name="format"][value="mp3"]').check();
    const next = page.waitForEvent('download');
    await page.locator('#export-button').click();
    await page.locator('#download-link').click();
    const result = await next;
    const output = path.join(out, `reencoded-${path.basename(target)}`);
    await result.saveAs(output);
    const encoded = await readFile(output);
    const decoded = await page.evaluate(
      async (bytes) => {
        const ctx = new AudioContext();
        try {
          const b = await ctx.decodeAudioData(new Uint8Array(bytes).buffer);
          return { duration: b.duration, channels: b.numberOfChannels };
        } finally {
          await ctx.close();
        }
      },
      [...encoded],
    );
    assert.ok(Math.abs(decoded.duration - 3) < 0.1);
    assert.equal(decoded.channels, details.channels);
  }
  report.workerHeaps = await workerMemory(browser);
  assert.equal(report.workerHeaps.length, 1);
  assert.ok(
    report.workerHeaps[0].backingStorageSize < 32 * 1024 ** 2,
    'MP3 worker must not retain the full decoded PCM',
  );
  if (process.env.LONG_AUDIO === '1') {
    const long = path.join(out, '28-minutes.mp3'),
      handle = await open(long, 'w'),
      piece = await readFile(mp3);
    try {
      for (let i = 0; i < 19; i++) await handle.write(piece);
    } finally {
      await handle.close();
    }
    const start = Date.now();
    await load(long);
    await cdp.send('HeapProfiler.collectGarbage');
    report.longMp3 = {
      loadMs: Date.now() - start,
      mainHeap: await cdp.send('Runtime.getHeapUsage'),
      workerHeaps: await workerMemory(browser),
      source: await page.evaluate(() => {
        const { length, storageBytes, maxReadBytes } = window.audioEngine.buffer;
        return { length, storageBytes, maxReadBytes };
      }),
    };
    assert.ok(report.longMp3.mainHeap.backingStorageSize < 20 * 1024 ** 2);
    assert.ok(report.longMp3.workerHeaps[0].backingStorageSize < 32 * 1024 ** 2);
  }
  // A second tab's cleanup must not remove an actively locked cache.
  const active = await cacheNames(),
    other = await context.newPage();
  await other.goto(url);
  const stale = await page.evaluate(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('yin-jian-audio-cache');
    const id = `pcm-${crypto.randomUUID()}`;
    await dir.getFileHandle(id, { create: true });
    return id;
  });
  await other.locator('#file-input').setInputFiles(file);
  await other.locator('#workspace').waitFor({ state: 'visible' });
  assert.deepEqual(await cacheNames(), active, 'stale cache swept; active tab cache preserved');
  assert.ok(!active.includes(stale));
  await other.close();
  await load(file);
  await page.waitForFunction(async () => {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle('yin-jian-audio-cache');
    for await (const name of dir.keys()) return false;
    return true;
  });
  // Cancel on the first MP3 progress event, before the full decode can complete.
  await page.evaluate(() => {
    const Native = window.Worker;
    window.Worker = class extends Native {
      constructor(...args) {
        super(...args);
        if (String(args[0]).includes('decode-worker'))
          this.addEventListener('message', ({ data }) => {
            if (data.type === 'progress') document.getElementById('cancel-load').click();
          });
      }
    };
  });
  await page.locator('#file-input').setInputFiles(mp3);
  await page.waitForFunction(() => document.getElementById('notice').textContent === '已取消載入。');
  await page.waitForTimeout(150);
  assert.deepEqual(await cacheNames(), [], 'cancel must remove partial local PCM');
  assert.deepEqual(await page.evaluate(() => window.wholeReads), []);
  assert.deepEqual(errors, []);
  assert.deepEqual(
    requests.filter(
      (r) =>
        /^https?:/.test(r.url) &&
        !['me.kis.v2.scr.kaspersky-labs.com', 'gc.kis.v2.scr.kaspersky-labs.com'].includes(new URL(r.url).hostname) &&
        (r.method !== 'GET' || !r.url.startsWith(url)),
    ),
    [],
    'long audio must never be uploaded',
  );
  await writeFile(path.join(out, `report-${report.channel}.json`), JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report));
} finally {
  await context.close();
  await browser.close();
  if (server) {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

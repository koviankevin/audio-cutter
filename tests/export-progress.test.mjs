import test from 'node:test';
import assert from 'node:assert/strict';
import { ExportEstimate, formatRemaining, formatElapsed, formatSpeed, exportResult } from '../export-progress.mjs';

test('remaining time warms up and includes source and disk delays in real elapsed time', () => {
  const estimate = new ExportEstimate(10000);
  estimate.start(0);
  assert.equal(estimate.sample(1000, 200), null);
  assert.equal(estimate.sample(2000, 500), null);
  assert.ok(Math.abs(estimate.sample(4000, 1000) - 1.5) < 0.1);
  const before = estimate.sample(5000, 1250),
    after = estimate.sample(6000, 4250);
  assert.ok(after > before, 'a genuine throughput drop must be reflected instead of counting down blindly');
});
test('clock anomalies and stale messages do not produce invalid estimates, and each job resets', () => {
  const estimate = new ExportEstimate(10000);
  assert.equal(estimate.sample(500, 1), null);
  estimate.start(10);
  estimate.sample(1000, 510);
  estimate.sample(4000, 1010);
  const remaining = estimate.remaining;
  assert.equal(estimate.sample(2000, 1110), remaining);
  assert.equal(estimate.sample(5000, 1000), remaining);
  assert.equal(estimate.sample(NaN, 1200), null);
  assert.equal(estimate.sample(11000, 1300), remaining);
  estimate.start(2000);
  assert.equal(estimate.sample(100, 2000), null);
  assert.equal(estimate.sample(100, 2100), null);
  assert.equal(estimate.sample(10000, 4000), 0);
});
test('remaining time is approximate, readable and never displays NaN or premature zero', () => {
  assert.equal(formatRemaining(null), '正在估算剩餘時間…');
  assert.equal(formatRemaining(Infinity), '正在估算剩餘時間…');
  assert.equal(formatRemaining(0.1), '預估剩餘 1 秒');
  assert.equal(formatRemaining(62), '預估剩餘 1 分 2 秒');
  assert.equal(formatRemaining(3661), '預估剩餘 1 小時 1 分 1 秒');
});

test('current speed uses audio seconds per wall second and reflects stalled acknowledgements', () => {
  const estimate = new ExportEstimate(441000);
  assert.deepEqual(estimate.metrics(0, 44100), { speed: null, remaining: null });
  estimate.start(100);
  estimate.sample(66150, 600);
  assert.equal(estimate.metrics(600, 44100).speed, null);
  estimate.sample(132300, 1100);
  const active = estimate.metrics(1100, 44100);
  assert.equal(active.speed, 3);
  assert.ok(Math.abs(active.remaining - 7 / 3) < 0.001);
  const stalled = estimate.metrics(6100, 44100);
  assert.ok(stalled.speed < active.speed / 2);
  assert.ok(stalled.remaining > active.remaining);
  assert.equal(estimate.metrics(900, 44100).speed, null);
  for (const rate of [0, -1, NaN, Infinity]) assert.equal(estimate.metrics(6100, rate).speed, null);
  estimate.start(7000);
  assert.deepEqual(estimate.metrics(9000, 44100), { speed: null, remaining: null });
});

test('elapsed and speed formatting handles long jobs, slow jobs and invalid measurements', () => {
  assert.equal(formatElapsed(0), '00:00');
  assert.equal(formatElapsed(61.99), '01:01');
  assert.equal(formatElapsed(3600), '01:00:00');
  assert.equal(formatElapsed(3661), '01:01:01');
  for (const value of [-1, NaN, Infinity]) assert.equal(formatElapsed(value), '00:00');
  assert.equal(formatSpeed(3), '3.0×');
  assert.equal(formatSpeed(123.456), '123.5×');
  assert.equal(formatSpeed(0), '0.0×');
  assert.equal(formatSpeed(0.001), '< 0.1×');
  for (const value of [null, -1, NaN, Infinity]) assert.equal(formatSpeed(value), '計算中…');
});

test('completed summary averages the retained audio over the whole job, including preparation and flush', () => {
  assert.deepEqual(exportResult({ frames: 90 * 44100, sampleRate: 44100, elapsedMs: 15000, bytes: 2161058 }), {
    elapsed: '00:15.0',
    speed: '6.0×',
    size: '2.06 MiB',
  });
  assert.equal(exportResult({ frames: 48000, sampleRate: 48000, elapsedMs: 2000, bytes: 44 }).speed, '0.5×');
});

test('completed summary preserves subsecond times, hour rollover and actual byte sizes', () => {
  const result = (elapsedMs, bytes) => exportResult({ frames: 44100, sampleRate: 44100, elapsedMs, bytes });
  assert.equal(result(32, 0).elapsed, '< 0.1 秒');
  assert.equal(result(345, 1).elapsed, '00:00.3');
  assert.equal(result(59999, 1023).elapsed, '01:00.0');
  assert.equal(result(3599999, 1024).elapsed, '01:00:00.0');
  assert.equal(result(1000, 1023).size, '1023 B');
  assert.equal(result(1000, 1024).size, '1.00 KiB');
  assert.equal(result(1000, 1024 ** 2).size, '1.00 MiB');
  assert.equal(result(1000, 1024 ** 3).size, '1.00 GiB');
  assert.equal(result(1000, 0).size, '0 B');
});

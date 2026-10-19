import test from 'node:test';
import assert from 'node:assert/strict';
import { ExportEstimate, formatRemaining } from '../export-progress.mjs';

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

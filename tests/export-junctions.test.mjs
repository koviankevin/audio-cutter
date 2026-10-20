import test from 'node:test';
import assert from 'node:assert/strict';
import { exportJunctions, junctionNeighbors, junctionWindow } from '../core.mjs';

test('export joins use cumulative retained samples, not original timestamps', () => {
  assert.deepEqual(
    exportJunctions(
      [
        [0, 88200],
        [176400, 264600],
        [352800, 529200],
      ],
      44100,
    ),
    [2, 4],
  );
  assert.deepEqual(
    exportJunctions(
      [
        [44100, 44101],
        [88200, 88202],
        [132300, 132301],
      ],
      44100,
    ),
    [1 / 44100, 3 / 44100],
  );
});

test('head/tail trimming, empty parts and contiguous splits do not create false joins', () => {
  assert.deepEqual(exportJunctions([], 44100), []);
  assert.deepEqual(exportJunctions([[44100, 88200]], 44100), []);
  assert.deepEqual(
    exportJunctions(
      [
        [0, 0],
        [10, 20],
        [20, 30],
        [40, 40],
        [50, 60],
      ],
      10,
    ),
    [2],
  );
});

test('navigation follows the playhead with exact boundaries and never wraps past either end', () => {
  assert.deepEqual(junctionNeighbors([], 0), { previous: -1, next: -1 });
  const times = [2, 4, 8];
  assert.deepEqual(junctionNeighbors(times, 0), { previous: -1, next: 0 });
  assert.deepEqual(junctionNeighbors(times, 3), { previous: 0, next: 1 });
  assert.deepEqual(junctionNeighbors(times, 4), { previous: 0, next: 2 });
  assert.deepEqual(junctionNeighbors(times, 10), { previous: 2, next: -1 });
});

test('repeated navigation advances by the selected join even while playing its lead-in', () => {
  const times = [0.2, 0.3, 0.4];
  assert.deepEqual(junctionNeighbors(times, 0, 0), { previous: -1, next: 1 });
  assert.deepEqual(junctionNeighbors(times, 0, 1), { previous: 0, next: 2 });
  assert.deepEqual(junctionNeighbors(times, 0, 2), { previous: 1, next: -1 });
  assert.deepEqual(junctionNeighbors(times, 0.25), { previous: 0, next: 1 });
});

test('custom context clamps to the actual file and allows one-sided listening', () => {
  assert.deepEqual(junctionWindow(2, 0.25, 0.4, 8), { start: 1.75, end: 2.4 });
  assert.deepEqual(junctionWindow(0.2, 1, 30, 8), { start: 0, end: 8 });
  assert.deepEqual(junctionWindow(7.9, 1, 1, 8), { start: 6.9, end: 8 });
  assert.deepEqual(junctionWindow(2, 0, 0.5, 8), { start: 2, end: 2.5 });
  assert.deepEqual(junctionWindow(2, 0.5, 0, 8), { start: 1.5, end: 2 });
});

test('invalid contexts never create zero-length or unbounded playback windows', () => {
  for (const [before, after] of [
    [0, 0],
    [-1, 1],
    [1, -1],
    [31, 1],
    [1, 31],
    [NaN, 1],
    [1, Infinity],
  ])
    assert.equal(junctionWindow(2, before, after, 8), null);
  assert.equal(junctionWindow(NaN, 1, 1, 8), null);
  assert.equal(junctionWindow(2, 1, 1, Infinity), null);
  assert.equal(junctionWindow(0, 1, 0, 8), null);
});

import test from 'node:test';
import assert from 'node:assert/strict';
import { exportJunctions, junctionNeighbors } from '../core.mjs';

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

import test from 'node:test';
import assert from 'node:assert/strict';
import { applyJoinFades } from '../join-fades.mjs';

test('join fades preserve trimmed ends and stereo, while both join edges reach zero', () => {
  const parts = [
      [10, 30],
      [50, 70],
    ],
    channels = [new Float32Array(20).fill(1), new Float32Array(20).fill(-0.5)];
  applyJoinFades(channels, 10, parts, 5);
  assert.deepEqual([...channels[0].slice(-5)], [1, 0.75, 0.5, 0.25, 0]);
  assert.equal(channels[0][0], 1);
  assert.equal(Math.abs(channels[1][19]), 0);
  assert.equal(channels[1][17], -0.25);
  const second = [new Float32Array(20).fill(1)];
  applyJoinFades(second, 50, parts, 5);
  assert.deepEqual([...second[0].slice(0, 5)], [0, 0.25, 0.5, 0.75, 1]);
  assert.equal(second[0][19], 1);
});
test('preview, export and arbitrary chunk boundaries produce identical faded samples', () => {
  const parts = [
    [0, 18],
    [30, 33],
    [40, 90],
  ];
  for (const [start, end] of parts) {
    const expected = new Float32Array(end - start).fill(0.8);
    applyJoinFades([expected], start, parts, 7);
    for (const size of [1, 2, 5, 11]) {
      const actual = new Float32Array(end - start);
      for (let frame = start; frame < end; frame += size) {
        const chunk = new Float32Array(Math.min(size, end - frame)).fill(0.8);
        applyJoinFades([chunk], frame, parts, 7);
        actual.set(chunk, frame - start);
      }
      assert.deepEqual(actual, expected);
      assert.ok(actual.every((sample) => Number.isFinite(sample) && sample >= 0 && sample <= 0.8 + 1e-7));
    }
  }
});
test('disabled fades and contiguous intervals preserve samples exactly', () => {
  const original = Float32Array.from([0.1, -0.2, 0.7, -0.8]),
    copy = original.slice();
  applyJoinFades(
    [copy],
    0,
    [
      [0, 2],
      [2, 4],
    ],
    10,
  );
  assert.deepEqual(copy, original);
  applyJoinFades(
    [copy],
    0,
    [
      [0, 2],
      [3, 5],
    ],
    0,
  );
  assert.deepEqual(copy, original);
});

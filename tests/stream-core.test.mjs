import test from 'node:test';
import assert from 'node:assert/strict';
import {
  inspectWav,
  decodePCM,
  StreamResampler,
  resampleRange,
  timelineSlice,
  PeakAccumulator,
} from '../stream-core.mjs';
import { wavHeader } from '../pcm.mjs';

test('WAV inspection reads headers, not the complete audio payload', async () => {
  const file = new Blob([wavHeader(441000, 2, 44100), new Uint8Array(441000 * 4)]),
    reads = [];
  const slice = file.slice.bind(file);
  file.slice = (a, b) => {
    reads.push(b - a);
    return slice(a, b);
  };
  assert.deepEqual(await inspectWav(file), {
    channels: 2,
    rate: 44100,
    align: 4,
    bits: 16,
    code: 1,
    offset: 44,
    size: 1764000,
    frames: 441000,
    length: 441000,
  });
  assert.ok(Math.max(...reads) <= 40);
});
test('invalid, empty and truncated WAVs fail before decoding', async () => {
  for (const file of [new Blob(), new Blob([wavHeader(10, 1, 44100)]), new Blob([wavHeader(0, 1, 44100)])])
    await assert.rejects(inspectWav(file));
});
test('extended PCM GUIDs, RF64 sizes and odd ancillary chunks are parsed safely', async () => {
  function chunk(tag, payload) {
    const bytes = new Uint8Array(8 + payload.length + (payload.length % 2));
    [...tag].forEach((c, i) => (bytes[i] = c.charCodeAt(0)));
    new DataView(bytes.buffer).setUint32(4, payload.length, true);
    bytes.set(payload, 8);
    return bytes;
  }
  const fmt = new Uint8Array(40),
    view = new DataView(fmt.buffer);
  view.setUint16(0, 65534, true);
  view.setUint16(2, 2, true);
  view.setUint32(4, 48000, true);
  view.setUint16(12, 6, true);
  view.setUint16(14, 24, true);
  view.setUint16(16, 22, true);
  view.setUint16(18, 24, true);
  fmt.set([1, 0, 0, 0, 0, 0, 16, 0, 128, 0, 0, 170, 0, 56, 155, 113], 24);
  const header = new Uint8Array(12);
  header.set(new TextEncoder().encode('RIFF'), 0);
  header.set(new TextEncoder().encode('WAVE'), 8);
  const data = new Uint8Array(12);
  const info = await inspectWav(
    new Blob([header, chunk('JUNK', new Uint8Array(3)), chunk('fmt ', fmt), chunk('data', data)]),
  );
  assert.equal(info.frames, 2);
  assert.equal(info.bits, 24);
  assert.equal(info.offset, 80);
  fmt[39] = 0;
  await assert.rejects(inspectWav(new Blob([header, chunk('fmt ', fmt), chunk('data', data)])), /延伸編碼/);
  const rf64 = new Uint8Array(header);
  rf64.set(new TextEncoder().encode('RF64'), 0);
  const ds64 = new Uint8Array(28);
  new DataView(ds64.buffer).setBigUint64(8, 12n, true);
  const pcm = wavHeader(3, 2, 44100).slice(20, 36),
    large = chunk('data', data);
  new DataView(large.buffer).setUint32(4, 0xffffffff, true);
  const rfInfo = await inspectWav(new Blob([rf64, chunk('ds64', ds64), chunk('fmt ', pcm), large]));
  assert.equal(rfInfo.size, 12);
  assert.equal(rfInfo.frames, 3);
});
test('PCM conversion preserves stereo and signed integer extremes', () => {
  const bytes = new Uint8Array([0, 128, 255, 127, 0, 0, 0, 64]);
  assert.deepEqual(
    decodePCM(bytes.buffer, { channels: 2, bits: 16, align: 4, code: 1 }).map((c) => [...c]),
    [
      [-1, 0],
      [32767 / 32768, 0.5],
    ],
  );
  const pcm24 = new Uint8Array([0, 0, 128, 255, 255, 127]);
  assert.deepEqual(
    [...decodePCM(pcm24.buffer, { channels: 1, bits: 24, align: 3, code: 1 })[0]],
    [-1, 8388607 / 8388608],
  );
  assert.deepEqual(
    [...decodePCM(new Uint8Array([0, 128, 255]).buffer, { channels: 1, bits: 8, align: 1, code: 1 })[0]],
    [-1, 0, 127 / 128],
  );
});
test('floating point nonfinite PCM is silenced', () => {
  assert.deepEqual(
    [
      ...decodePCM(new Float32Array([0.25, NaN, Infinity, -0.5]).buffer, {
        channels: 1,
        bits: 32,
        align: 4,
        code: 3,
      })[0],
    ],
    [0.25, 0, 0, -0.5],
  );
});
test('chunked resampling is identical across arbitrary read boundaries', () => {
  for (const rate of [8000, 22050, 44100, 48000, 96000]) {
    const data = Array.from({ length: 2 }, (_, c) =>
      Float32Array.from({ length: 10000 }, (_, i) => 0.4 * Math.sin(i * 0.04 + c)),
    );
    const expected = resampleRange(data, 0, 0, Math.round((data[0].length * 44100) / rate), rate, data[0].length);
    const resampler = new StreamResampler(rate, 2),
      parts = [[], []];
    for (let start = 0; start < data[0].length; start += 137) {
      const chunk = resampler.push(data.map((c) => c.subarray(start, start + 137)));
      chunk.forEach((c, i) => parts[i].push(...c));
    }
    resampler.push([new Float32Array(), new Float32Array()], true).forEach((c, i) => parts[i].push(...c));
    parts.forEach((c, i) => assert.deepEqual(new Float32Array(c), expected[i], `rate ${rate}, channel ${i}`));
  }
});
test('resampling a random window matches continuous output at its edges', () => {
  const rate = 48000,
    data = [Float32Array.from({ length: 10000 }, (_, i) => Math.sin(i * 0.03))],
    a = 700,
    b = 1800;
  const whole = resampleRange(data, 0, 0, 9000, rate, 10000);
  const start = Math.floor((a * rate) / 44100) - 16,
    end = Math.ceil((b * rate) / 44100) + 17;
  assert.deepEqual(
    resampleRange(
      data.map((c) => c.slice(start, end)),
      start,
      a,
      b,
      rate,
      10000,
    )[0],
    whole[0].slice(a, b),
  );
});
test('resampling retains low tones and suppresses frequencies above output Nyquist', () => {
  const amplitude = (hz) => {
    const data = [Float32Array.from({ length: 48000 }, (_, i) => Math.sin((i * 2 * Math.PI * hz) / 48000))];
    const out = resampleRange(data, 0, 0, 44100, 48000, 48000)[0].subarray(100, 44000);
    return Math.sqrt(out.reduce((s, v) => s + v * v, 0) / out.length);
  };
  assert.ok(amplitude(440) > 0.7);
  assert.ok(amplitude(23900) < 0.08);
});
test('playback chunks cross many deleted regions in source order', () => {
  assert.deepEqual(
    timelineSlice(
      [
        [0, 10],
        [20, 30],
        [40, 50],
      ],
      8,
      15,
    ),
    [
      [8, 10],
      [20, 30],
      [40, 43],
    ],
  );
  assert.deepEqual(
    timelineSlice(
      [
        [0, 10],
        [20, 30],
      ],
      10,
      100,
    ),
    [[20, 30]],
  );
  assert.deepEqual(timelineSlice([[0, 10]], 10, 10), []);
});
test('peak accumulator includes both channels and stays bounded', () => {
  const peaks = new PeakAccumulator(256);
  peaks.add([new Float32Array(256).fill(0.5), new Float32Array(256).fill(-0.75)], 0);
  assert.deepEqual([...peaks.finish(256)], [-0.75, 0.5, -0.75, 0.5]);
});

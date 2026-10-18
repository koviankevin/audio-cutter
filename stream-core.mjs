import { SAMPLE_RATE, MAX_SECONDS } from './core.mjs';
export const FILTER_RADIUS = 16;
const text = (view, offset, size) =>
  String.fromCharCode(...new Uint8Array(view.buffer, view.byteOffset + offset, size));

export async function inspectWav(file) {
  const header = new DataView(await file.slice(0, 12).arrayBuffer());
  if (header.byteLength < 12 || !['RIFF', 'RF64'].includes(text(header, 0, 4)) || text(header, 8, 4) !== 'WAVE')
    throw Error('WAV 標頭已損毀。');
  let format, data, largeSize;
  for (let offset = 12; offset + 8 <= file.size; ) {
    const head = new DataView(await file.slice(offset, offset + 8).arrayBuffer()),
      tag = text(head, 0, 4);
    let size = head.getUint32(4, true);
    if (tag === 'data' && size === 0xffffffff && largeSize !== undefined) size = largeSize;
    if (offset + 8 + size > file.size) throw Error('WAV 資料不完整或已截斷。');
    if (tag === 'ds64') {
      if (size < 28) throw Error('RF64 標頭已損毀。');
      const view = new DataView(await file.slice(offset + 8, offset + 36).arrayBuffer());
      if (view.byteLength < 28) throw Error('RF64 標頭已損毀。');
      largeSize = Number(view.getBigUint64(8, true));
    } else if (tag === 'fmt ') {
      const view = new DataView(await file.slice(offset + 8, offset + 8 + Math.min(size, 40)).arrayBuffer());
      if (view.byteLength < 16) throw Error('WAV 格式標頭不完整。');
      let code = view.getUint16(0, true);
      const channels = view.getUint16(2, true),
        rate = view.getUint32(4, true),
        align = view.getUint16(12, true),
        bits = view.getUint16(14, true);
      if (code === 65534) {
        if (view.byteLength < 40 || view.getUint16(16, true) < 22) throw Error('WAV 延伸標頭不完整。');
        const tail = [0, 0, 16, 0, 128, 0, 0, 170, 0, 56, 155, 113];
        if (tail.some((byte, index) => view.getUint8(28 + index) !== byte)) throw Error('此 WAV 延伸編碼不受支援。');
        code = view.getUint32(24, true);
      }
      if (![1, 2].includes(channels)) throw Error('第一版支援單聲道與雙聲道音訊。');
      if (
        !((code === 1 && [8, 16, 24, 32].includes(bits)) || (code === 3 && [32, 64].includes(bits))) ||
        align !== (channels * bits) / 8 ||
        rate < 8000 ||
        rate > 192000
      )
        throw Error('此 WAV 編碼不支援分段處理，請轉為 PCM WAV 或 MP3。');
      format = { channels, rate, align, bits, code };
    } else if (tag === 'data') data = { offset: offset + 8, size };
    if (format && data) break;
    offset += 8 + size + (size % 2);
  }
  if (!format || !data || !data.size || data.size % format.align) throw Error('WAV 沒有完整的音訊資料。');
  const frames = data.size / format.align,
    length = Math.round((frames * SAMPLE_RATE) / format.rate);
  if (length > SAMPLE_RATE * MAX_SECONDS) throw Error('請選擇 30 分鐘以內的音檔。');
  return { ...format, ...data, frames, length };
}
export function pcmSample(view, offset, format) {
  let sample;
  if (format.code === 3) sample = format.bits === 32 ? view.getFloat32(offset, true) : view.getFloat64(offset, true);
  else if (format.bits === 8) sample = (view.getUint8(offset) - 128) / 128;
  else if (format.bits === 16) sample = view.getInt16(offset, true) / 32768;
  else if (format.bits === 24) {
    let value = view.getUint8(offset) | (view.getUint8(offset + 1) << 8) | (view.getUint8(offset + 2) << 16);
    sample = ((value << 8) >> 8) / 8388608;
  } else sample = view.getInt32(offset, true) / 2147483648;
  return Number.isFinite(sample) ? sample : 0;
}
export function decodePCM(bytes, format) {
  const view = new DataView(bytes),
    count = bytes.byteLength / format.align,
    channels = Array.from({ length: format.channels }, () => new Float32Array(count));
  for (let channel = 0; channel < channels.length; channel++)
    for (let i = 0; i < count; i++)
      channels[channel][i] = pcmSample(view, i * format.align + (channel * format.bits) / 8, format);
  return channels;
}
const filters = new Map();
function filterTable(rate) {
  if (filters.has(rate)) return filters.get(rate);
  const table = new Float32Array(1024 * 32),
    cutoff = Math.min(1, SAMPLE_RATE / rate) * 0.95;
  for (let phase = 0; phase < 1024; phase++) {
    let sum = 0;
    for (let tap = 0; tap < 32; tap++) {
      const x = tap - 15 - phase / 1024,
        y = x * cutoff;
      const value =
        (Math.abs(y) < 1e-12 ? cutoff : Math.sin(Math.PI * y) / (Math.PI * x)) *
        (0.5 + 0.5 * Math.cos((Math.PI * x) / 16));
      table[phase * 32 + tap] = value;
      sum += value;
    }
    for (let tap = 0; tap < 32; tap++) table[phase * 32 + tap] /= sum;
  }
  filters.set(rate, table);
  return table;
}
export function resampleRange(channels, inputStart, outputStart, outputEnd, rate, totalInput) {
  // Global frame coordinates keep phase and boundary samples identical for every read.
  if (rate === SAMPLE_RATE) return channels.map((data) => data.slice(outputStart - inputStart, outputEnd - inputStart));
  const result = channels.map(() => new Float32Array(outputEnd - outputStart)),
    table = filterTable(rate);
  for (let i = outputStart; i < outputEnd; i++) {
    const pos = (i * rate) / SAMPLE_RATE,
      base = Math.floor(pos),
      phase = Math.min(1023, Math.floor((pos - base) * 1024));
    for (let channel = 0; channel < channels.length; channel++) {
      let sample = 0;
      for (let tap = 0; tap < 32; tap++)
        sample +=
          channels[channel][Math.max(0, Math.min(totalInput - 1, base + tap - 15)) - inputStart] *
          table[phase * 32 + tap];
      result[channel][i - outputStart] = sample;
    }
  }
  return result;
}
export class StreamResampler {
  constructor(rate, channels) {
    this.rate = rate;
    this.channels = channels;
    this.received = 0;
    this.emitted = 0;
    this.tail = Array.from({ length: channels }, () => new Float32Array());
  }
  push(data, final = false) {
    if (this.rate === SAMPLE_RATE) {
      this.received += data[0].length;
      this.emitted = this.received;
      return data;
    }
    const tailSize = this.tail[0].length,
      start = this.received - tailSize;
    const combined = data.map((part, c) => {
      const all = new Float32Array(tailSize + part.length);
      all.set(this.tail[c]);
      all.set(part, tailSize);
      return all;
    });
    this.received += data[0].length;
    // Retain both filter wings; only emit samples whose future input is available.
    const end = final
      ? Math.round((this.received * SAMPLE_RATE) / this.rate)
      : Math.max(this.emitted, Math.ceil((Math.max(0, this.received - 17) * SAMPLE_RATE) / this.rate));
    const result = resampleRange(combined, start, this.emitted, end, this.rate, this.received);
    this.emitted = end;
    this.tail = combined.map((part) => part.slice(-32));
    return result;
  }
}
export class PeakAccumulator {
  constructor(expectedLength) {
    this.values = new Float32Array(Math.ceil((MAX_SECONDS * SAMPLE_RATE) / 128) * 2);
    this.stride = Math.max(1, Math.floor((expectedLength || MAX_SECONDS * SAMPLE_RATE) / (24000 * 96)));
  }
  sample(frame, left, right = left) {
    const index = Math.floor(frame / 128) * 2;
    if (index >= this.values.length) return;
    this.values[index] = Math.min(this.values[index], left, right);
    this.values[index + 1] = Math.max(this.values[index + 1], left, right);
  }
  add(channels, start) {
    for (let i = Math.ceil(start / this.stride) * this.stride - start; i < channels[0].length; i += this.stride)
      this.sample(start + i, channels[0][i], channels[1]?.[i]);
  }
  finish(length) {
    const bins = Math.min(24000, Math.ceil(length / 128)),
      result = new Float32Array(bins * 2);
    for (let i = 0; i < Math.ceil(length / 128); i++) {
      const bin = Math.min(bins - 1, Math.floor(((i * 128) / length) * bins)) * 2;
      result[bin] = Math.min(result[bin], this.values[i * 2]);
      result[bin + 1] = Math.max(result[bin + 1], this.values[i * 2 + 1]);
    }
    return result;
  }
}
export function timelineSlice(ranges, offset, count) {
  if (count <= 0) return [];
  const result = [];
  for (const [a, b] of ranges) {
    if (offset >= b - a) {
      offset -= b - a;
      continue;
    }
    const start = a + offset,
      end = Math.min(b, start + count);
    result.push([start, end]);
    count -= end - start;
    offset = 0;
    if (!count) break;
  }
  return result;
}

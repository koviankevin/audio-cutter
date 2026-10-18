export const SAMPLE_RATE = 44100;
export const MAX_BYTES = 400 * 1024 * 1024;
export const MAX_SECONDS = 30 * 60;

export const totalFrames = ranges => ranges.reduce((sum, [a, b]) => sum + b - a, 0);
export const signature = ranges => JSON.stringify(ranges);

export function normalize(ranges, length) {
  const result = [];
  const ordered = ranges.map(([a, b]) => [
    Math.max(0, Math.min(length, Math.round(a))),
    Math.max(0, Math.min(length, Math.round(b))),
  ]).filter(([a, b]) => Number.isFinite(a) && Number.isFinite(b) && b > a)
    .sort((a, b) => a[0] - b[0]);
  for (const [a, b] of ordered) {
    const last = result.at(-1);
    if (last && a <= last[1]) last[1] = Math.max(last[1], b);
    else result.push([a, b]);
  }
  return result;
}

export function subtract(ranges, [start, end]) {
  if (end <= start) return ranges.map(range => [...range]);
  return ranges.flatMap(([a, b]) => {
    if (end <= a || start >= b) return [[a, b]];
    const parts = [];
    if (a < start) parts.push([a, start]);
    if (end < b) parts.push([end, b]);
    return parts;
  });
}

export function intersect(ranges, [start, end]) {
  return ranges.map(([a, b]) => [Math.max(a, start), Math.min(b, end)])
    .filter(([a, b]) => b > a);
}

export function deletedRanges(ranges, length) {
  let cursor = 0;
  const result = [];
  for (const [a, b] of ranges) {
    if (a > cursor) result.push([cursor, a]);
    cursor = b;
  }
  if (cursor < length) result.push([cursor, length]);
  return result;
}

export function subtractMany(ranges, removals) {
  const length = ranges.at(-1)?.[1] ?? 0;
  return normalize(removals, length).reduce((kept, removal) => subtract(kept, removal), ranges.map(range => [...range]));
}

export function frameAtOffset(ranges, offset) {
  for (const [a, b] of ranges) {
    if (offset < b - a) return a + Math.max(0, offset);
    offset -= b - a;
  }
  return ranges.at(-1)?.[1] ?? 0;
}

export function formatTime(seconds, milliseconds = true) {
  const ms = Math.max(0, Math.round(seconds * 1000));
  const minutes = Math.floor(ms / 60000);
  const sec = Math.floor(ms / 1000) % 60;
  return `${String(minutes).padStart(2, '0')}:${String(sec).padStart(2, '0')}${milliseconds ? `.${String(ms % 1000).padStart(3, '0')}` : ''}`;
}

export function parseTime(value) {
  const text = String(value).trim();
  if (/^\d+(\.\d{1,3})?$/.test(text)) return Number(text);
  const match = /^(\d+):([0-5]\d)(?:\.(\d{1,3}))?$/.exec(text);
  if (!match) return NaN;
  return Number(match[1]) * 60 + Number(match[2]) + Number(`0.${match[3] || 0}`);
}

export class History {
  constructor(state) { this.reset(state); }
  reset(state) { this.states = [structuredClone(state)]; this.index = 0; }
  get current() { return this.states[this.index]; }
  get canUndo() { return this.index > 0; }
  get canRedo() { return this.index < this.states.length - 1; }
  commit(state, before = this.current) {
    if (signature(state) === signature(before)) return false;
    // Capture the selection/playhead at the action boundary, without logging navigation.
    this.states[this.index] = structuredClone(before);
    this.states.splice(this.index + 1);
    this.states.push(structuredClone(state));
    // Snapshots contain small interval lists and view coordinates, never PCM audio.
    if (this.states.length > 100) this.states.shift();
    this.index = this.states.length - 1;
    return true;
  }
  undo() { if (this.canUndo) this.index--; return this.current; }
  redo() { if (this.canRedo) this.index++; return this.current; }
}

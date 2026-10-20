export const SAMPLE_RATE = 44100;
export const MAX_BYTES = 400 * 1024 * 1024;
export const MAX_SECONDS = 30 * 60;

export const totalFrames = ranges => ranges.reduce((sum, [a, b]) => sum + b - a, 0);
export const signature = ranges => JSON.stringify(ranges);

// Use the export's ordered sample intervals. Head/tail trims and boundaries
// between contiguous intervals are not joins; only removed gaps create one.
export function exportJunctions(ranges, sampleRate) {
  const result = [];
  let frames = 0, previousEnd = null;
  for (const [start, end] of ranges) {
    if (end <= start) continue;
    if (previousEnd !== null && start > previousEnd) result.push(frames / sampleRate);
    frames += end - start;
    previousEnd = end;
  }
  return result;
}

export function junctionNeighbors(times, position, selected = -1) {
  if (selected >= 0 && selected < times.length) {
    return { previous: selected > 0 ? selected - 1 : -1, next: selected + 1 < times.length ? selected + 1 : -1 };
  }
  let low = 0, high = times.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (times[middle] < position) low = middle + 1;
    else high = middle;
  }
  const next = times[low] === position ? low + 1 : low;
  return { previous: low - 1, next: next < times.length ? next : -1 };
}

export function junctionWindow(time, before, after, duration) {
  if (![time, before, after, duration].every(Number.isFinite) || duration <= 0 || time < 0 || time > duration ||
      before < 0 || after < 0 || before > 30 || after > 30 || before + after <= 0) return null;
  const start = Math.max(0, time - before), end = Math.min(duration, time + after);
  return end > start ? { start, end } : null;
}

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
  const cuts = normalize(removals, length), result = [];
  let index = 0;
  // Both timelines are ordered: visit each interval once instead of copying an
  // ever-growing retained list for every individual removal.
  for (const [start, end] of ranges) {
    let cursor = start;
    while (index < cuts.length && cuts[index][1] <= cursor) index++;
    while (index < cuts.length && cuts[index][0] < end) {
      const [a, b] = cuts[index];
      if (a > cursor) result.push([cursor, a]);
      cursor = Math.max(cursor, b);
      if (cursor >= end) break;
      index++;
    }
    if (cursor < end) result.push([cursor, end]);
  }
  return result;
}

// Take context from the final retained timeline, including any other cuts in it.
export function junctionPreview(ranges, [start, end], contextFrames) {
  const before = [], after = [];
  let remaining = contextFrames;
  const leading = intersect(ranges, [0, start]);
  for (let i = leading.length - 1; i >= 0 && remaining > 0; i--) {
    const [a, b] = leading[i], count = Math.min(b - a, remaining);
    before.unshift([b - count, b]); remaining -= count;
  }
  remaining = contextFrames;
  for (const [a, b] of ranges) {
    const first = Math.max(a, end);
    if (b <= first || remaining <= 0) continue;
    const count = Math.min(b - first, remaining);
    after.push([first, first + count]); remaining -= count;
  }
  return { parts:[...before, ...after], beforeFrames:totalFrames(before), afterFrames:totalFrames(after) };
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

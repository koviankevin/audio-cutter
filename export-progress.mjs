// Estimate wall time from acknowledged frames so reading, encoding and disk I/O
// are all included. Reset per export, warm up before showing a number, and use
// a time-weighted moving average to absorb short scheduling/JIT fluctuations.
export class ExportEstimate {
  constructor(total) {
    this.total = total;
    this.startedAt = null;
    this.rate = null;
    this.remaining = null;
  }
  start(now) {
    this.startedAt = now;
    this.lastAt = now;
    this.processed = 0;
    this.rate = null;
    this.remaining = null;
  }
  sample(processed, now) {
    if (this.startedAt === null || !Number.isFinite(now) || !Number.isFinite(processed)) return null;
    if (now <= this.lastAt || processed < this.processed || processed > this.total) return this.remaining;
    const dt = now - this.lastAt,
      delta = processed - this.processed;
    const elapsed = now - this.startedAt,
      rate = delta / dt;
    this.rate =
      elapsed < 1000 || this.rate === null
        ? processed / elapsed
        : this.rate + (rate - this.rate) * (1 - Math.exp(-dt / 2500));
    this.lastAt = now;
    this.processed = processed;
    this.remaining =
      elapsed < 1000 || processed === 0 || !(this.rate > 0)
        ? null
        : Math.max(0, (this.total - processed) / this.rate / 1000);
    return this.remaining;
  }

  metrics(now, sampleRate) {
    if (
      this.startedAt === null ||
      !Number.isFinite(now) ||
      now - this.startedAt < 1000 ||
      now < this.lastAt ||
      !(sampleRate > 0) ||
      !Number.isFinite(sampleRate) ||
      !this.processed ||
      !(this.rate > 0)
    )
      return { speed: null, remaining: null };
    // Account for time without acknowledgements too: stalled reads or disk writes
    // should lower the displayed speed, not leave an old fast measurement frozen.
    const rate = this.rate * Math.exp(-(now - this.lastAt) / 2500);
    return {
      speed: (rate * 1000) / sampleRate,
      remaining: rate > 0 ? (this.total - this.processed) / rate / 1000 : null,
    };
  }
}

export function formatElapsed(value) {
  const seconds = Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0;
  const hours = Math.floor(seconds / 3600),
    minutes = Math.floor((seconds % 3600) / 60),
    tail = seconds % 60;
  const mmss = `${String(minutes).padStart(2, '0')}:${String(tail).padStart(2, '0')}`;
  return hours ? `${String(hours).padStart(2, '0')}:${mmss}` : mmss;
}

export function formatSpeed(value) {
  if (value === null || !Number.isFinite(value) || value < 0) return '計算中…';
  if (value > 0 && value < 0.1) return '< 0.1×';
  return `${value.toFixed(1)}×`;
}

export function exportResult({ frames, sampleRate, elapsedMs, bytes }) {
  const seconds = elapsedMs / 1000;
  const rounded = Math.round(seconds * 10);
  const elapsed = seconds < 0.1 ? '< 0.1 秒' : `${formatElapsed(rounded / 10)}.${rounded % 10}`;
  const speed = seconds > 0 ? formatSpeed(frames / sampleRate / seconds) : '—';
  const units = ['B', 'KiB', 'MiB', 'GiB'];
  const unit = Math.min(3, Math.max(0, Math.floor(Math.log2(Math.max(1, bytes)) / 10)));
  const size = `${unit ? (bytes / 1024 ** unit).toFixed(2) : bytes} ${units[unit]}`;
  return { elapsed, speed, size };
}

export function formatRemaining(value) {
  if (value === null || !Number.isFinite(value) || value < 0) return '正在估算剩餘時間…';
  const seconds = Math.max(1, Math.ceil(value)),
    hours = Math.floor(seconds / 3600),
    minutes = Math.floor((seconds % 3600) / 60),
    tail = seconds % 60;
  const parts = [];
  if (hours) parts.push(`${hours} 小時`);
  if (minutes) parts.push(`${minutes} 分`);
  if (tail || !parts.length) parts.push(`${tail || 1} 秒`);
  return `預估剩餘 ${parts.join(' ')}`;
}

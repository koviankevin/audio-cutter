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

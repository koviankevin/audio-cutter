import { deletedRanges, formatTime } from './core.mjs';

export class Waveform {
  constructor(canvas, onSelection, onSeek, onAddSelection = () => {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.onSelection = onSelection; this.onSeek = onSeek; this.onAddSelection = onAddSelection;
    this.zoom = 1; this.scroll = 0; this.playhead = 0;
    this.observer = new ResizeObserver(() => this.draw()); this.observer.observe(canvas);
    canvas.addEventListener('pointerdown', event => this.pointerDown(event));
    canvas.addEventListener('pointermove', event => this.pointerMove(event));
    canvas.addEventListener('pointerup', event => this.pointerUp(event));
    canvas.addEventListener('pointercancel', () => { this.drag = null; });
    canvas.addEventListener('keydown', event => {
      if (!this.length || !['ArrowLeft', 'ArrowRight'].includes(event.key)) return;
      event.preventDefault();
      this.onSeek(Math.max(0, Math.min(this.length, this.playhead + (event.key === 'ArrowLeft' ? -1 : 1) * this.sampleRate * (event.shiftKey ? 1 : 0.1))));
    });
  }
  setAudio(buffer, peaks) {
    this.length = buffer.length; this.sampleRate = buffer.sampleRate; this.peaks = peaks;
    this.zoom = 1; this.scroll = 0; this.playhead = 0;
  }
  update(ranges, selection, playhead, pending = []) {
    this.ranges = ranges; this.selection = selection; this.playhead = playhead; this.pending = pending; this.draw();
  }
  get viewLength() { return this.length / this.zoom; }
  get viewStart() { return (this.length - this.viewLength) * this.scroll; }
  xToFrame(clientX) {
    const rect = this.canvas.getBoundingClientRect();
    return Math.round(Math.max(0, Math.min(this.length, this.viewStart + Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * this.viewLength)));
  }
  frameToX(frame) { return (frame - this.viewStart) / this.viewLength * this.canvas.getBoundingClientRect().width; }
  pointerDown(event) {
    if (!this.length || event.button !== 0) return;
    this.canvas.focus({ preventScroll: true });
    const frame = this.xToFrame(event.clientX);
    const x = event.clientX - this.canvas.getBoundingClientRect().left;
    const startDistance = Math.abs(this.frameToX(this.selection[0]) - x);
    const endDistance = Math.abs(this.frameToX(this.selection[1]) - x);
    const handle = !event.shiftKey && Math.min(startDistance, endDistance) < 11 ? (startDistance <= endDistance ? 'start' : 'end') : null;
    this.drag = { frame, x: event.clientX, selection: [...this.selection], handle, moved: false, additive: event.shiftKey };
    this.canvas.setPointerCapture(event.pointerId);
  }
  pointerMove(event) {
    if (!this.drag) return;
    const frame = this.xToFrame(event.clientX);
    if (Math.abs(event.clientX - this.drag.x) > 2) this.drag.moved = true;
    if (!this.drag.moved) return;
    let start = this.drag.frame, end = frame;
    if (this.drag.handle === 'start') { start = frame; end = this.drag.selection[1]; }
    if (this.drag.handle === 'end') { start = this.drag.selection[0]; end = frame; }
    this.onSelection([Math.min(start, end), Math.max(start, end)]);
  }
  pointerUp(event) {
    if (!this.drag) return;
    if (!this.drag.moved) this.onSeek(this.xToFrame(event.clientX));
    else if (this.drag.additive) this.onAddSelection();
    this.drag = null;
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
  }
  draw() {
    if (!this.length || !this.ranges || !this.peaks) return;
    const { width, height } = this.canvas.getBoundingClientRect();
    if (!width || !height) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (this.canvas.width !== Math.round(width * dpr) || this.canvas.height !== Math.round(height * dpr)) {
      this.canvas.width = Math.round(width * dpr); this.canvas.height = Math.round(height * dpr);
    }
    const ctx = this.ctx; ctx.setTransform(dpr, 0, 0, dpr, 0, 0); ctx.clearRect(0, 0, width, height);
    const top = 31, bottom = height - 24, middle = (top + bottom) / 2, amplitude = (bottom - top) * 0.45;
    const xOf = frame => (frame - this.viewStart) / this.viewLength * width;
    const selectedStart = Math.max(0, xOf(this.selection[0]));
    const selectedEnd = Math.min(width, xOf(this.selection[1]));
    if (selectedEnd > selectedStart) { ctx.fillStyle = '#e7f1e6'; ctx.fillRect(selectedStart, top, selectedEnd - selectedStart, bottom - top); }
    ctx.font = '9px "Segoe UI", sans-serif'; ctx.textBaseline = 'middle';
    const viewSeconds = this.viewLength / this.sampleRate;
    const intervals = [.01,.02,.05,.1,.2,.5,1,2,5,10,15,30,60,120,300,600];
    const step = intervals.find(value => value >= viewSeconds / Math.max(2, Math.floor(width / 83))) ?? 600;
    const startSeconds = this.viewStart / this.sampleRate;
    for (let seconds = Math.ceil(startSeconds / step) * step; seconds <= startSeconds + viewSeconds; seconds += step) {
      const x = xOf(seconds * this.sampleRate);
      ctx.strokeStyle = '#e8eee3'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x + .5, top); ctx.lineTo(x + .5, bottom); ctx.stroke();
      ctx.fillStyle = '#94a58a'; ctx.textAlign = x < 27 ? 'left' : x > width - 27 ? 'right' : 'center';
      ctx.fillText(formatTime(seconds, step < 1), Math.max(5, Math.min(width - 5, x)), 15);
    }
    ctx.strokeStyle = '#dce7d7'; ctx.beginPath(); ctx.moveTo(0, middle + .5); ctx.lineTo(width, middle + .5); ctx.stroke();
    const bins = this.peaks.length / 2;
    const removed = deletedRanges(this.ranges, this.length);
    let keptIndex = 0;
    for (let x = 1; x < width; x += 3) {
      const frame = this.viewStart + (x / width) * this.viewLength;
      while (keptIndex < this.ranges.length && this.ranges[keptIndex][1] <= frame) keptIndex++;
      const kept = keptIndex < this.ranges.length && this.ranges[keptIndex][0] <= frame;
      const firstBin = Math.max(0, Math.floor(frame / this.length * bins));
      const lastBin = Math.min(bins - 1, Math.ceil((frame + this.viewLength * 3 / width) / this.length * bins));
      let min = 0, max = 0;
      for (let bin = firstBin; bin <= lastBin; bin++) { min = Math.min(min, this.peaks[bin * 2]); max = Math.max(max, this.peaks[bin * 2 + 1]); }
      ctx.fillStyle = kept ? '#5b9984' : '#ccd5c8';
      const y = middle - max * amplitude;
      ctx.fillRect(x, y, 1.8, Math.max(1.6, (max - min) * amplitude));
    }
    for (const [a, b] of removed) {
      const left = Math.max(0, xOf(a)), right = Math.min(width, xOf(b));
      if (right <= left) continue;
      ctx.fillStyle = '#e4e8e14a'; ctx.fillRect(left, top, right - left, bottom - top);
      ctx.save(); ctx.beginPath(); ctx.rect(left, top, right - left, bottom - top); ctx.clip();
      ctx.strokeStyle = '#c4cfc46b'; ctx.lineWidth = 1;
      for (let x = left - height; x < right; x += 9) { ctx.beginPath(); ctx.moveTo(x, bottom); ctx.lineTo(x + height, top); ctx.stroke(); }
      ctx.restore();
    }
    for (const [index, [a, b]] of (this.pending || []).entries()) {
      const left = Math.max(0, xOf(a)), right = Math.min(width, xOf(b));
      if (right <= left) continue;
      ctx.fillStyle = '#dba0472d'; ctx.fillRect(left, top, right - left, bottom - top);
      ctx.strokeStyle = '#bd914e'; ctx.lineWidth = 1; ctx.strokeRect(left + .5, top + .5, right - left - 1, bottom - top - 1);
      if (right - left > 45) {
        ctx.fillStyle = '#95692a'; ctx.font = '9px "Segoe UI", sans-serif'; ctx.textAlign = 'left';
        ctx.fillText(`待刪 ${String(index + 1).padStart(2, '0')}`, left + 6, top + 11);
      }
    }
    if (selectedEnd > selectedStart) {
      ctx.strokeStyle = '#81a984'; ctx.lineWidth = 1; ctx.strokeRect(selectedStart + .5, top + .5, selectedEnd - selectedStart - 1, bottom - top - 1);
      for (const frame of this.selection) {
        const x = xOf(frame); if (x < 0 || x > width) continue;
        const left = Math.max(0, Math.min(width - 6, x - 3));
        ctx.fillStyle = '#628e6c'; ctx.fillRect(left, middle - 10, 6, 20);
        ctx.strokeStyle = '#f0f6eb'; ctx.beginPath(); ctx.moveTo(left + 3, middle - 5); ctx.lineTo(left + 3, middle + 5); ctx.stroke();
      }
    }
    const cursor = xOf(this.playhead);
    if (cursor >= 0 && cursor <= width) {
      ctx.strokeStyle = '#14796c'; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(cursor, top - 5); ctx.lineTo(cursor, bottom + 3); ctx.stroke();
      ctx.fillStyle = '#14796c'; ctx.beginPath(); ctx.moveTo(cursor - 4, top - 7); ctx.lineTo(cursor + 4, top - 7); ctx.lineTo(cursor, top - 2); ctx.fill();
    }
    ctx.textAlign = 'right'; ctx.fillStyle = '#9aac94'; ctx.font = '8px "Segoe UI", sans-serif'; ctx.fillText('ORIGINAL TIMELINE', width - 8, height - 10);
  }
}

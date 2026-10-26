import { deletedRanges, formatTime } from './core.mjs';

export class Waveform {
  constructor(canvas, onSelection, onSeek, onAddSelection = () => {}, onEditPending = () => {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d');
    this.background = document.createElement('canvas'); this.backgroundKey = '';
    this.onSelection = onSelection; this.onSeek = onSeek; this.onAddSelection = onAddSelection;
    this.onEditPending = onEditPending;
    this.zoom = 1; this.scroll = 0; this.playhead = 0;
    this.labelSize = 14;
    const updateLabelSize = () => { this.labelSize = parseFloat(getComputedStyle(canvas).fontSize) * .875; this.draw(); };
    this.observer = new ResizeObserver(updateLabelSize); this.observer.observe(canvas);
    window.addEventListener('font-size-change', updateLabelSize);
    canvas.addEventListener('pointerdown', event => this.pointerDown(event));
    canvas.addEventListener('pointermove', event => this.pointerMove(event));
    canvas.addEventListener('pointerup', event => this.pointerUp(event));
    canvas.addEventListener('pointercancel', event => { if (event.pointerId === this.drag?.pointerId) this.cancelDrag(); });
    canvas.addEventListener('lostpointercapture', event => { if (event.pointerId === this.drag?.pointerId) this.cancelDrag(); });
    canvas.addEventListener('pointerleave', () => { if (!this.drag) delete canvas.dataset.cursor; });
    canvas.addEventListener('keydown', event => this.keyDown(event));
    canvas.addEventListener('keyup', event => {
      if (!this.keyboardEdit) return;
      this.keyboardEdit.keys.delete(event.key);
      if (!this.keyboardEdit.keys.size) this.finishKeyboardEdit();
    });
    canvas.addEventListener('blur', () => this.finishKeyboardEdit());
    window.addEventListener('blur', () => this.finishKeyboardEdit());
  }
  setAudio(buffer, peaks) {
    this.length = buffer.length; this.sampleRate = buffer.sampleRate; this.peaks = peaks;
    this.zoom = 1; this.scroll = 0; this.playhead = 0; this.pendingMode = 'move';
    this.backgroundKey = '';
  }
  update(ranges, selection, playhead, pending = []) {
    this.ranges = ranges; this.selection = selection; this.playhead = playhead; this.pending = pending; this.draw();
  }
  get viewLength() { return this.length / this.zoom; }
  get textScale() { return (this.labelSize || 14) / 14; }
  get top() { return 31 * this.textScale; }
  get bottomPadding() { return 24 * this.textScale; }
  get viewStart() { return (this.length - this.viewLength) * this.scroll; }
  revealFrame(frame) {
    if (this.zoom === 1) return;
    const margin = this.viewLength * .1;
    const start = frame < this.viewStart + margin ? frame - margin : frame > this.viewStart + this.viewLength - margin ? frame - this.viewLength + margin : this.viewStart;
    this.scroll = Math.max(0, Math.min(1, start / (this.length - this.viewLength))); this.draw();
  }
  xToFrame(clientX) {
    const rect = this.canvas.getBoundingClientRect();
    return Math.round(Math.max(0, Math.min(this.length, this.viewStart + Math.max(0, Math.min(1, (clientX - rect.left) / rect.width)) * this.viewLength)));
  }
  frameToX(frame) { return (frame - this.viewStart) / this.viewLength * this.canvas.getBoundingClientRect().width; }
  pendingHandleAt(event) {
    const rect = this.canvas.getBoundingClientRect();
    const y = event.clientY - rect.top, x = event.clientX - rect.left;
    if (y < this.top || y > rect.height - this.bottomPadding) return null;
    let closest = null, distance = event.pointerType === 'touch' ? 22 : 12;
    for (const [index, range] of (this.pending || []).entries()) {
      for (const [endpoint, frame] of range.entries()) {
        const position = this.frameToX(frame), delta = Math.abs(position - x);
        if (position >= 0 && position <= rect.width && delta <= distance) {
          closest = { index, handle:endpoint === 0 ? 'start' : 'end', range:[...range] }; distance = delta;
        }
      }
    }
    return closest;
  }
  pendingBodyAt(event) {
    const rect = this.canvas.getBoundingClientRect();
    const y = event.clientY - rect.top, x = event.clientX - rect.left;
    if (y < this.top || y > rect.height - this.bottomPadding || x < 0 || x > rect.width) return null;
    const frame = this.xToFrame(event.clientX);
    const index = (this.pending || []).findIndex(([a, b]) => a <= frame && frame < b);
    if (index < 0) return null;
    return { index, handle:'move', range:[...this.pending[index]] };
  }
  moveLimits(index, [start, end]) {
    const span = end - start;
    const container = this.ranges.find(([a, b]) => a <= start && end <= b) || [start, end];
    // Leave one sample between markers so release cannot merge them and change length.
    const previous = this.pending[index - 1], next = this.pending[index + 1];
    return [Math.max(container[0], previous ? previous[1] + 1 : 0),
      Math.min(container[1] - span, next ? next[0] - span - 1 : this.length - span)];
  }
  keyDown(event) {
    if (!this.length || !['ArrowLeft', 'ArrowRight'].includes(event.key) || event.ctrlKey || event.metaKey || event.altKey) return;
    event.preventDefault();
    if (this.drag) return;
    const index = this.keyboardEdit?.index ?? (this.pending || []).findIndex(([a, b]) => a === this.selection[0] && b === this.selection[1]);
    if (index < 0) {
      this.onSeek(Math.max(0, Math.min(this.length, this.playhead + (event.key === 'ArrowLeft' ? -1 : 1) * this.sampleRate * (event.shiftKey ? 1 : 0.1))));
      return;
    }
    if (!this.keyboardEdit) {
      this.keyboardEdit = { index, mode:this.pendingMode || 'move', keys:new Set() };
      this.onEditPending(index, [...this.pending[index]], 'start', this.keyboardEdit.mode);
    }
    this.keyboardEdit.keys.add(event.key);
    const range = [...this.pending[index]], mode = this.keyboardEdit.mode;
    const delta = (event.key === 'ArrowLeft' ? -1 : 1) * Math.max(1, Math.round(this.sampleRate * (event.shiftKey ? .1 : .01)));
    if (mode === 'move') {
      const span = range[1] - range[0], [min, max] = this.moveLimits(index, range);
      range[0] = Math.max(min, Math.min(max, range[0] + delta)); range[1] = range[0] + span;
    } else {
      const gap = Math.min(range[1] - range[0], Math.max(1, Math.round(this.sampleRate / 1000)));
      if (mode === 'start') range[0] = Math.max(0, Math.min(range[1] - gap, range[0] + delta));
      else range[1] = Math.min(this.length, Math.max(range[0] + gap, range[1] + delta));
    }
    this.onEditPending(index, range, 'update');
  }
  finishKeyboardEdit(cancel = false) {
    if (!this.keyboardEdit) return;
    const { index } = this.keyboardEdit; this.keyboardEdit = null;
    this.onEditPending(index, null, cancel ? 'cancel' : 'end');
  }
  pointerDown(event) {
    if (!this.length || event.button !== 0 || this.drag || event.isPrimary === false) return;
    this.finishKeyboardEdit();
    event.preventDefault();
    this.canvas.focus({ preventScroll: true });
    const pending = !event.shiftKey && (this.pendingHandleAt(event) || this.pendingBodyAt(event));
    if (pending) {
      this.drag = { pointerId:event.pointerId, x:event.clientX, frame:this.xToFrame(event.clientX), selection:pending.range, handle:pending.handle, pendingIndex:pending.index, moved:false,
        limits:pending.handle === 'move' ? this.moveLimits(pending.index, pending.range) : null };
      this.canvas.dataset.cursor = pending.handle === 'move' ? 'move' : 'resize'; this.canvas.setPointerCapture(event.pointerId);
      this.onEditPending(pending.index, pending.range, 'start', pending.handle);
      return;
    }
    const frame = this.xToFrame(event.clientX);
    const x = event.clientX - this.canvas.getBoundingClientRect().left;
    const startDistance = Math.abs(this.frameToX(this.selection[0]) - x);
    const endDistance = Math.abs(this.frameToX(this.selection[1]) - x);
    const handle = !event.shiftKey && Math.min(startDistance, endDistance) < 11 ? (startDistance <= endDistance ? 'start' : 'end') : null;
    this.drag = { frame, x: event.clientX, pointerId:event.pointerId, selection: [...this.selection], handle, moved: false, additive: event.shiftKey };
    this.canvas.setPointerCapture(event.pointerId);
  }
  pointerMove(event) {
    if (!this.drag) {
      if (!event.shiftKey && this.pendingHandleAt(event)) this.canvas.dataset.cursor = 'resize';
      else if (!event.shiftKey && this.pendingBodyAt(event)) this.canvas.dataset.cursor = 'grab';
      else delete this.canvas.dataset.cursor;
      return;
    }
    if (event.pointerId !== this.drag.pointerId) return;
    const frame = this.xToFrame(event.clientX);
    if (Math.abs(event.clientX - this.drag.x) > 2) this.drag.moved = true;
    if (!this.drag.moved) return;
    if (this.drag.pendingIndex !== undefined) {
      const range = [...this.drag.selection];
      if (this.drag.handle === 'move') {
        const span = range[1] - range[0];
        const start = Math.max(this.drag.limits[0], Math.min(this.drag.limits[1], range[0] + frame - this.drag.frame));
        this.onEditPending(this.drag.pendingIndex, [start, start + span], 'update');
        return;
      }
      const gap = Math.min(range[1] - range[0], Math.max(1, Math.round(this.sampleRate / 1000)));
      if (this.drag.handle === 'start') range[0] = Math.min(frame, range[1] - gap);
      else range[1] = Math.max(frame, range[0] + gap);
      this.onEditPending(this.drag.pendingIndex, range, 'update');
      return;
    }
    let start = this.drag.frame, end = frame;
    if (this.drag.handle === 'start') { start = frame; end = this.drag.selection[1]; }
    if (this.drag.handle === 'end') { start = this.drag.selection[0]; end = frame; }
    this.onSelection([Math.min(start, end), Math.max(start, end)]);
  }
  pointerUp(event) {
    if (!this.drag || event.pointerId !== this.drag.pointerId) return;
    if (this.drag.pendingIndex !== undefined) {
      this.pointerMove(event);
      const index = this.drag.pendingIndex;
      this.drag = null; delete this.canvas.dataset.cursor;
      if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
      this.onEditPending(index, null, 'end');
      return;
    }
    if (!this.drag.moved) this.onSeek(this.xToFrame(event.clientX));
    else if (this.drag.additive) this.onAddSelection();
    this.drag = null;
    if (this.canvas.hasPointerCapture(event.pointerId)) this.canvas.releasePointerCapture(event.pointerId);
  }
  cancelDrag() {
    this.finishKeyboardEdit(true);
    const drag = this.drag;
    if (!drag) return;
    this.drag = null; delete this.canvas.dataset.cursor;
    if (this.canvas.hasPointerCapture(drag.pointerId)) this.canvas.releasePointerCapture(drag.pointerId);
    if (drag.pendingIndex !== undefined) this.onEditPending(drag.pendingIndex, null, 'cancel');
  }
  draw() {
    if (!this.length || !this.ranges || !this.peaks) return;
    const { width, height } = this.canvas.getBoundingClientRect();
    if (!width || !height) return;
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    if (this.canvas.width !== Math.round(width * dpr) || this.canvas.height !== Math.round(height * dpr)) {
      this.canvas.width = Math.round(width * dpr); this.canvas.height = Math.round(height * dpr);
    }
    const key = JSON.stringify([width, height, dpr, this.labelSize, this.zoom, this.scroll, this.ranges, this.selection, this.pending]);
    if (this.backgroundKey !== key) {
      this.background.width = this.canvas.width; this.background.height = this.canvas.height;
      const background = this.background.getContext('2d'); background.setTransform(dpr, 0, 0, dpr, 0, 0);
      this.drawBackground(background, width, height); this.backgroundKey = key;
    }
    const ctx = this.ctx;
    ctx.setTransform(1, 0, 0, 1, 0, 0); ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
    ctx.drawImage(this.background, 0, 0); ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    const cursor = (this.playhead - this.viewStart) / this.viewLength * width, top = this.top, bottom = height - this.bottomPadding;
    if (cursor >= 0 && cursor <= width) {
      ctx.strokeStyle = '#14796c'; ctx.lineWidth = 1.2; ctx.beginPath(); ctx.moveTo(cursor, top - 5); ctx.lineTo(cursor, bottom + 3); ctx.stroke();
      ctx.fillStyle = '#14796c'; ctx.beginPath(); ctx.moveTo(cursor - 4, top - 7); ctx.lineTo(cursor + 4, top - 7); ctx.lineTo(cursor, top - 2); ctx.fill();
    }
  }
  drawBackground(ctx, width, height) {
    const top = this.top, bottom = height - this.bottomPadding, middle = (top + bottom) / 2, amplitude = (bottom - top) * 0.45;
    const xOf = frame => (frame - this.viewStart) / this.viewLength * width;
    const selectedStart = Math.max(0, xOf(this.selection[0]));
    const selectedEnd = Math.min(width, xOf(this.selection[1]));
    if (selectedEnd > selectedStart) { ctx.fillStyle = '#e7f1e6'; ctx.fillRect(selectedStart, top, selectedEnd - selectedStart, bottom - top); }
    ctx.font = `${this.labelSize}px "Segoe UI", sans-serif`; ctx.textBaseline = 'middle';
    const viewSeconds = this.viewLength / this.sampleRate;
    const intervals = [.01,.02,.05,.1,.2,.5,1,2,5,10,15,30,60,120,300,600,1200,1800,3600];
    const labelWidth = ctx.measureText(formatTime((this.viewStart + this.viewLength) / this.sampleRate, true)).width + 24;
    const step = intervals.find(value => value >= viewSeconds / Math.max(1, Math.floor(width / Math.max(100, labelWidth)))) ?? 600;
    const startSeconds = this.viewStart / this.sampleRate;
    for (let seconds = Math.ceil(startSeconds / step) * step; seconds <= startSeconds + viewSeconds; seconds += step) {
      const x = xOf(seconds * this.sampleRate);
      ctx.strokeStyle = '#e8eee3'; ctx.lineWidth = 1; ctx.beginPath(); ctx.moveTo(x + .5, top); ctx.lineTo(x + .5, bottom); ctx.stroke();
      const label = formatTime(seconds, step < 1), edge = ctx.measureText(label).width / 2 + 5;
      ctx.fillStyle = '#536b61'; ctx.textAlign = x < edge ? 'left' : x > width - edge ? 'right' : 'center';
      ctx.fillText(label, Math.max(5, Math.min(width - 5, x)), top / 2);
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
      const label = `待刪 ${String(index + 1).padStart(2, '0')}`;
      if (right - left > ctx.measureText(label).width + 12) {
        ctx.fillStyle = '#795622'; ctx.textAlign = 'left';
        ctx.fillText(label, left + 6, top + 11 * this.textScale);
      }
    }
    if (selectedEnd > selectedStart) {
      ctx.strokeStyle = '#81a984'; ctx.lineWidth = 1; ctx.strokeRect(selectedStart + .5, top + .5, selectedEnd - selectedStart - 1, bottom - top - 1);
      const selectedPending = (this.pending || []).some(([a, b]) => a === this.selection[0] && b === this.selection[1]);
      for (const frame of selectedPending ? [] : this.selection) {
        const x = xOf(frame); if (x < 0 || x > width) continue;
        const left = Math.max(0, Math.min(width - 6, x - 3));
        ctx.fillStyle = '#628e6c'; ctx.fillRect(left, middle - 10, 6, 20);
        ctx.strokeStyle = '#f0f6eb'; ctx.beginPath(); ctx.moveTo(left + 3, middle - 5); ctx.lineTo(left + 3, middle + 5); ctx.stroke();
      }
    }
    for (const range of this.pending || []) {
      for (const frame of range) {
        const x = xOf(frame); if (x < 0 || x > width) continue;
        const left = Math.max(0, Math.min(width - 8, x - 4));
        ctx.fillStyle = '#b1823a'; ctx.fillRect(left, middle - 14, 8, 28);
        ctx.strokeStyle = '#fff5de'; ctx.lineWidth = 1; ctx.beginPath();
        ctx.moveTo(left + 3, middle - 7); ctx.lineTo(left + 3, middle + 7);
        ctx.moveTo(left + 5, middle - 7); ctx.lineTo(left + 5, middle + 7); ctx.stroke();
      }
    }
    ctx.textAlign = 'right'; ctx.fillStyle = '#536b61'; ctx.fillText('ORIGINAL TIMELINE', width - 8, height - this.bottomPadding / 2);
  }
}

import { SAMPLE_RATE, intersect, totalFrames, frameAtOffset } from './core.mjs';
import { ChunkSource } from './chunk-source.mjs';
import { timelineSlice } from './stream-core.mjs';
import { applyJoinFades } from './join-fades.mjs';

export class AudioEngine {
  constructor() { this.context = null; this.buffer = null; this.nodes = []; this.playing = false; this.position = 0; this.generation = 0; this.onError = () => {}; }
  getContext() {
    if (!this.context || this.context.state === 'closed') this.context = new AudioContext({ sampleRate: SAMPLE_RATE });
    return this.context;
  }
  async decode(file, { duration = 0, onProgress = () => {} } = {}) {
    // MP3 metadata duration can be an estimate for VBR files without a Xing header.
    // Always stream it so an underestimated duration cannot trigger full PCM allocation.
    if (/\.mp3$/i.test(file.name) || file.size > 4 * 1024 * 1024 || !duration || duration > 60) {
      const source = new ChunkSource(file, { duration, onProgress });
      this.loadingSource = source;
      // Keep ownership until acceptBuffer or release, including cancellation during load.
      try { return await source.ready; }
      catch (error) { source.dispose(); throw error; }
    }
    const bytes = await file.arrayBuffer();
    return this.getContext().decodeAudioData(bytes);
  }
  async readPreview(parts, generation) {
    const source = this.buffer, context = this.getContext();
    const preview = context.createBuffer(source.numberOfChannels, totalFrames(parts), source.sampleRate);
    let offset = 0;
    for (const [a, b] of parts) {
      for (let start = a; start < b; start += 88200) {
        const end = Math.min(b, start + 88200);
        const data = source.readChannels ? await source.readChannels(start, end) : Array.from({ length:source.numberOfChannels }, (_, c) => source.getChannelData(c).slice(start, end));
        if (generation !== this.generation) return null;
        applyJoinFades(data, start, this.fadeParts, this.fadeFrames);
        data.forEach((channel, index) => preview.copyToChannel(channel, index, offset));
        offset += end - start;
      }
    }
    return preview;
  }
  async playStream(generation, loop) {
    const context = this.context, frames = totalFrames(this.queue);
    this.scheduledFrames = 0;
    const fill = async () => {
      if (generation !== this.generation) return;
      // At most six seconds of playback plus one pending two-second read are resident.
      while (this.scheduledFrames < frames && (!this.playing || this.startedAt + this.scheduledFrames / SAMPLE_RATE < context.currentTime + 4)) {
        const count = Math.min(88200, frames - this.scheduledFrames);
        const preview = await this.readPreview(timelineSlice(this.queue, this.scheduledFrames, count), generation);
        if (!preview || generation !== this.generation) return;
        if (!this.playing) { this.startedAt = context.currentTime + .08; this.playing = true; }
        const when = this.startedAt + this.scheduledFrames / SAMPLE_RATE;
        if (when < context.currentTime) throw Object.assign(Error('音訊讀取速度不足，請暫停後重新播放，或關閉其他佔用磁碟的程式。'), { userFacing:true });
        const node = context.createBufferSource(); node.buffer = preview; node.connect(context.destination);
        node.onended = () => { node.disconnect(); const index = this.nodes.indexOf(node); if (index >= 0) this.nodes.splice(index, 1); };
        node.start(when); this.nodes.push(node); this.scheduledFrames += count;
      }
      if (generation === this.generation && this.scheduledFrames < frames) this.fillTimer = setTimeout(() => {
        fill().catch(error => { if (generation === this.generation) { this.pause(); this.onError(error); } });
      }, 250);
    };
    if (loop) {
      const preview = await this.readPreview(this.queue, generation);
      if (!preview || generation !== this.generation) return;
      this.startedAt = context.currentTime + .035; this.playing = true;
      const node = context.createBufferSource(); node.buffer = preview; node.loop = true;
      node.connect(context.destination); node.start(this.startedAt); this.nodes.push(node);
    } else await fill();
  }
  async play(ranges, fromFrame = 0, { loop = false, fadeFrames = 0, fadeParts = ranges } = {}) {
    this.pause();
    const generation = this.generation;
    const queue = intersect(ranges, [fromFrame, this.buffer.length]);
    this.queue = queue.length ? queue : ranges.map(range => [...range]);
    this.fadeFrames = fadeFrames; this.fadeParts = fadeParts.map(part => [...part]);
    if (!this.queue.length) return;
    const context = this.getContext();
    await context.resume();
    if (generation !== this.generation || !this.buffer) return;
    this.looping = loop;
    this.position = this.queue[0][0];
    this.playDuration = totalFrames(this.queue) / this.buffer.sampleRate;
    if (this.buffer.readChannels || fadeFrames > 0) { await this.playStream(generation, loop); return; }
    this.startedAt = context.currentTime + 0.035;
    this.playing = true;
    if (loop) {
      // Only the short junction context is copied, never the full source recording.
      const preview = context.createBuffer(this.buffer.numberOfChannels, totalFrames(this.queue), this.buffer.sampleRate);
      let offset = 0;
      for (const [a, b] of this.queue) {
        for (let channel = 0; channel < this.buffer.numberOfChannels; channel++) {
          preview.copyToChannel(this.buffer.getChannelData(channel).subarray(a, b), channel, offset);
        }
        offset += b - a;
      }
      const node = context.createBufferSource(); node.buffer = preview; node.loop = true;
      node.connect(context.destination); node.start(this.startedAt); this.nodes.push(node);
      return;
    }
    let offset = 0;
    for (const [a, b] of this.queue) {
      const node = context.createBufferSource();
      node.buffer = this.buffer; node.connect(context.destination);
      const duration = (b - a) / this.buffer.sampleRate;
      node.start(this.startedAt + offset, a / this.buffer.sampleRate, duration);
      this.nodes.push(node); offset += duration;
    }
    this.playDuration = offset;
  }
  currentFrame() {
    if (!this.playing) return this.position;
    const elapsed = Math.max(0, this.context.currentTime - this.startedAt);
    const offset = this.looping ? elapsed % this.playDuration : Math.min(elapsed, this.playDuration);
    return Math.round(frameAtOffset(this.queue, offset * this.buffer.sampleRate));
  }
  get ended() { return this.playing && !this.looping && this.context.currentTime >= this.startedAt + this.playDuration; }
  pause() {
    this.generation++;
    clearTimeout(this.fillTimer);
    this.position = this.currentFrame();
    this.playing = false; this.looping = false;
    for (const node of this.nodes) { try { node.stop(); } catch {} node.disconnect(); }
    this.nodes = [];
    return this.position;
  }
  release() {
    this.pause(); this.buffer?.dispose?.(); this.loadingSource?.dispose(); this.loadingSource = null;
    this.buffer = null; this.position = 0; this.queue = [];
  }
}

export async function makePeaks(buffer, onProgress = () => {}) {
  const bins = Math.min(24000, Math.ceil(buffer.length / 128));
  const peaks = new Float32Array(bins * 2);
  const channels = Array.from({ length: buffer.numberOfChannels }, (_, i) => buffer.getChannelData(i));
  for (let bin = 0; bin < bins; bin++) {
    const start = Math.floor(bin * buffer.length / bins);
    const end = Math.floor((bin + 1) * buffer.length / bins);
    const stride = Math.max(1, Math.floor((end - start) / 96));
    let min = 0, max = 0;
    for (let i = start; i < end; i += stride) {
      for (const channel of channels) { min = Math.min(min, channel[i]); max = Math.max(max, channel[i]); }
    }
    peaks[bin * 2] = min; peaks[bin * 2 + 1] = max;
    if (bin % 1000 === 0) { onProgress(bin / bins); await new Promise(resolve => setTimeout(resolve, 0)); }
  }
  onProgress(1);
  return peaks;
}

export function createDemo() {
  const buffer = new AudioBuffer({ length: SAMPLE_RATE * 18, numberOfChannels: 2, sampleRate: SAMPLE_RATE });
  for (let channel = 0; channel < 2; channel++) {
    const data = buffer.getChannelData(channel);
    for (let i = 0; i < data.length; i++) {
      const t = i / SAMPLE_RATE;
      const frequency = [261.63, 329.63, 392][Math.floor(t / 6)];
      const beat = t % 0.75;
      const envelope = Math.min(1, beat / 0.02) * Math.exp(-beat * 4) * Math.min(1, (18 - t) / 0.2);
      data[i] = (Math.sin(2 * Math.PI * frequency * t) + 0.2 * Math.sin(2 * Math.PI * frequency * 2 * t + channel * 0.3)) * envelope * 0.27;
    }
  }
  return buffer;
}

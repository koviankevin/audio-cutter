import { SAMPLE_RATE, intersect, totalFrames, frameAtOffset } from './core.mjs';

export class AudioEngine {
  constructor() { this.context = null; this.buffer = null; this.nodes = []; this.playing = false; this.position = 0; this.generation = 0; }
  getContext() {
    if (!this.context || this.context.state === 'closed') this.context = new AudioContext({ sampleRate: SAMPLE_RATE });
    return this.context;
  }
  async decode(file) {
    const bytes = await file.arrayBuffer();
    return this.getContext().decodeAudioData(bytes);
  }
  async play(ranges, fromFrame = 0) {
    this.pause();
    const generation = this.generation;
    const queue = intersect(ranges, [fromFrame, this.buffer.length]);
    this.queue = queue.length ? queue : ranges.map(range => [...range]);
    if (!this.queue.length) return;
    const context = this.getContext();
    await context.resume();
    if (generation !== this.generation || !this.buffer) return;
    this.startedAt = context.currentTime + 0.035;
    this.playing = true;
    this.position = this.queue[0][0];
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
    return Math.round(frameAtOffset(this.queue, Math.min(elapsed, this.playDuration) * this.buffer.sampleRate));
  }
  get ended() { return this.playing && this.context.currentTime >= this.startedAt + this.playDuration; }
  pause() {
    this.generation++;
    this.position = this.currentFrame();
    this.playing = false;
    for (const node of this.nodes) { try { node.stop(); } catch {} node.disconnect(); }
    this.nodes = [];
    return this.position;
  }
  release() { this.pause(); this.buffer = null; this.position = 0; this.queue = []; }
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

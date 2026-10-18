/* All messages are backpressured: the main thread sends one PCM chunk per acknowledgement. */
const pcm = import('./pcm.mjs');
let job = null;

self.onmessage = async ({ data }) => {
  try {
    const { floatToInt16, wavHeader, interleavePCM } = await pcm;
    if (data.type === 'init') {
      if (data.format === 'mp3' && !self.lamejs) importScripts('./vendor/lame.min.js');
      job = { ...data, processed: 0, parts: [] };
      if (data.format === 'mp3') job.encoder = new self.lamejs.Mp3Encoder(data.channels, data.sampleRate, 192);
      else job.parts.push(wavHeader(data.frames, data.channels, data.sampleRate));
      self.postMessage({ type: 'ready' });
    } else if (data.type === 'chunk') {
      if (!job) throw new Error('匯出工作尚未初始化。');
      const channels = data.channels.map(buffer => new Float32Array(buffer));
      if (job.format === 'wav') job.parts.push(interleavePCM(channels));
      else {
        const samples = channels.map(floatToInt16);
        for (let i = 0; i < samples[0].length; i += 1152) {
          const encoded = job.encoder.encodeBuffer(samples[0].subarray(i, i + 1152), samples[1]?.subarray(i, i + 1152));
          if (encoded.length) job.parts.push(new Uint8Array(encoded));
        }
      }
      job.processed += channels[0].length;
      self.postMessage({ type: 'progress', processed: job.processed });
    } else if (data.type === 'finish') {
      if (!job || job.processed !== job.frames) throw new Error('音訊資料不完整，請重試。');
      if (job.encoder) {
        const tail = job.encoder.flush();
        if (tail.length) job.parts.push(new Uint8Array(tail));
      }
      const blob = new Blob(job.parts, { type: job.format === 'mp3' ? 'audio/mpeg' : 'audio/wav' });
      self.postMessage({ type: 'complete', blob });
      job = null;
    }
  } catch (error) {
    job = null;
    self.postMessage({ type: 'error', message: error.message || '音檔編碼失敗。' });
  }
};

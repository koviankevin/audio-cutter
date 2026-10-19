/* All messages are backpressured: the main thread sends one PCM chunk per acknowledgement. */
const pcm = import('./pcm.mjs');
const storage = import('./export-store.mjs');
let job = null;

self.onmessage = async ({ data }) => {
  try {
    const { floatToInt16, wavHeader, interleavePCM } = await pcm;
    if (data.type === 'init') {
      if (
        !['mp3', 'wav'].includes(data.format) ||
        ![1, 2].includes(data.channels) ||
        data.sampleRate !== 44100 ||
        !Number.isInteger(data.frames) ||
        data.frames <= 0 ||
        data.frames > 44100 * 1800
      )
        throw Error('匯出設定無效。');
      if (data.format === 'mp3' && !self.lamejs) importScripts('./vendor/lame.min.js');
      const { ExportFile } = await storage;
      const name = `${data.exportId}.${data.format}`;
      const output = await ExportFile.create(name);
      job = { ...data, processed: 0, output };
      if (data.format === 'mp3') job.encoder = new self.lamejs.Mp3Encoder(data.channels, data.sampleRate, 192);
      else job.output.append(wavHeader(data.frames, data.channels, data.sampleRate));
      self.postMessage({ type: 'ready' });
    } else if (data.type === 'chunk') {
      if (!job) throw new Error('匯出工作尚未初始化。');
      const channels = data.channels.map((buffer) => new Float32Array(buffer));
      if (
        channels.length !== job.channels ||
        !channels[0].length ||
        channels[0].length > 73728 ||
        channels.some((channel) => channel.length !== channels[0].length) ||
        job.processed + channels[0].length > job.frames
      )
        throw Error('匯出音訊區塊無效。');
      if (job.format === 'wav') job.output.append(interleavePCM(channels));
      else {
        const samples = channels.map(floatToInt16);
        for (let i = 0; i < samples[0].length; i += 1152) {
          const encoded = job.encoder.encodeBuffer(samples[0].subarray(i, i + 1152), samples[1]?.subarray(i, i + 1152));
          if (encoded.length) job.output.append(new Uint8Array(encoded.buffer, encoded.byteOffset, encoded.byteLength));
        }
      }
      job.processed += channels[0].length;
      self.postMessage({ type: 'progress', processed: job.processed });
    } else if (data.type === 'finish') {
      if (!job || job.processed !== job.frames) throw new Error('音訊資料不完整，請重試。');
      if (job.encoder) {
        const tail = job.encoder.flush();
        if (tail.length) job.output.append(new Uint8Array(tail.buffer, tail.byteOffset, tail.byteLength));
      }
      const blob = await job.output.finish();
      self.postMessage({ type: 'complete', blob });
      job = null;
    }
  } catch (error) {
    job?.output.abort();
    job = null;
    const { exportError } = await storage;
    self.postMessage({ type: 'error', message: exportError(error) });
  }
};

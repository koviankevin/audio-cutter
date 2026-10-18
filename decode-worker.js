let file, format, info, disk, releaseLock;
const modules = import('./stream-core.mjs');
const RATE = 44100,
  MAX_FRAMES = RATE * 1800;
let maxReadBytes = 0;
async function bytes(start, end) {
  maxReadBytes = Math.max(maxReadBytes, end - start);
  return file.slice(start, end).arrayBuffer();
}
async function readWav(start, end) {
  const { decodePCM, resampleRange, FILTER_RADIUS } = await modules;
  const first = Math.max(0, Math.floor((start * format.rate) / RATE) - FILTER_RADIUS),
    last = Math.min(format.frames, Math.ceil((end * format.rate) / RATE) + FILTER_RADIUS + 1);
  const data = decodePCM(
    await bytes(format.offset + first * format.align, format.offset + last * format.align),
    format,
  );
  return resampleRange(data, first, start, end, format.rate, format.frames);
}
async function initializeWav() {
  const { inspectWav, PeakAccumulator, pcmSample } = await modules;
  format = await inspectWav(file);
  const peaks = new PeakAccumulator(format.length),
    step = Math.max(1, Math.floor(format.frames / (24000 * 96)));
  const batch = Math.max(1, Math.floor((1024 * 1024) / format.align));
  for (let first = 0; first < format.frames; first += batch) {
    const end = Math.min(format.frames, first + batch),
      view = new DataView(await bytes(format.offset + first * format.align, format.offset + end * format.align));
    for (let i = Math.ceil(first / step) * step; i < end; i += step) {
      const offset = (i - first) * format.align,
        left = pcmSample(view, offset, format),
        right = format.channels === 2 ? pcmSample(view, offset + format.bits / 8, format) : left;
      peaks.sample(Math.floor((i * RATE) / format.rate), left, right);
    }
    self.postMessage({ type: 'progress', phase: '正在分段讀取波形', progress: end / format.frames });
  }
  info = {
    length: format.length,
    sampleRate: RATE,
    numberOfChannels: format.channels,
    duration: format.length / RATE,
    mode: 'file',
    maxReadBytes,
    storageBytes: 0,
  };
  return peaks.finish(info.length);
}
async function mpegFormat() {
  const head = new Uint8Array(await bytes(0, 10));
  let offset = 0;
  if (String.fromCharCode(...head.subarray(0, 3)) === 'ID3') {
    if (head.length < 10 || head.slice(6, 10).some((value) => value & 128)) throw Error('MP3 標籤已損毀。');
    offset = 10 + ((head[6] << 21) | (head[7] << 14) | (head[8] << 7) | head[9]) + (head[5] & 16 ? 10 : 0);
  }
  const end = Math.min(file.size, offset + 1024 * 1024);
  for (let start = offset; start < end; start += 65532) {
    const data = new Uint8Array(await bytes(start, Math.min(end, start + 65536)));
    for (let i = 0; i + 4 <= data.length; i++) {
      const version = (data[i + 1] >> 3) & 3,
        layer = (data[i + 1] >> 1) & 3,
        bitrate = data[i + 2] >> 4,
        sr = (data[i + 2] >> 2) & 3;
      if (
        data[i] === 255 &&
        (data[i + 1] & 224) === 224 &&
        version !== 1 &&
        layer === 1 &&
        bitrate > 0 &&
        bitrate < 15 &&
        sr < 3
      )
        return { channels: data[i + 3] >> 6 === 3 ? 1 : 2, firstFrame: start + i };
    }
  }
  throw Error('MP3 沒有可解碼的音訊資料。');
}
async function openCache(id) {
  if (!navigator.storage?.getDirectory || !navigator.locks)
    throw Error('瀏覽器無法建立本機暫存，請使用桌面 Chrome／Edge，並確認網站儲存空間可用。');
  await new Promise((resolve, reject) => {
    navigator.locks
      .request(`yin-jian-${id}`, async () => {
        try {
          const root = await navigator.storage.getDirectory(),
            dir = await root.getDirectoryHandle('yin-jian-audio-cache', { create: true });
          const handle = await dir.getFileHandle(id, { create: true });
          disk = await handle.createSyncAccessHandle();
          resolve();
          await new Promise((done) => {
            releaseLock = done;
          });
        } catch (error) {
          reject(error);
        }
      })
      .catch(reject);
  });
}
async function initializeMp3(cacheId, duration) {
  const { StreamResampler, PeakAccumulator } = await modules,
    { channels, firstFrame } = await mpegFormat();
  await openCache(cacheId);
  importScripts('./vendor/mpg123-decoder.min.js');
  let decoder = new self['mpg123-decoder'].MPEGDecoder({ enableGapless: true });
  await decoder.ready;
  let resampler,
    rate,
    length = 0;
  const peaks = new PeakAccumulator(Math.min(MAX_FRAMES, duration * RATE));
  function save(data) {
    const count = data[0].length;
    if (!count) return;
    if (length + count > MAX_FRAMES) throw Error('請選擇 30 分鐘以內的音檔。');
    const interleaved = new Float32Array(count * channels);
    for (let i = 0; i < count; i++) for (let c = 0; c < channels; c++) interleaved[i * channels + c] = data[c][i];
    if (disk.write(interleaved, { at: length * channels * 4 }) !== interleaved.byteLength)
      throw Error('本機音訊暫存寫入不完整。');
    peaks.add(data, length);
    length += count;
  }
  try {
    // Skip ID3 artwork/tags without feeding large metadata into the decoder heap.
    for (let offset = firstFrame; offset < file.size; offset += 16384) {
      const decoded = decoder.decode(new Uint8Array(await bytes(offset, Math.min(file.size, offset + 16384))));
      if (decoded.samplesDecoded) {
        if (!resampler) {
          rate = decoded.sampleRate;
          if (rate < 8000 || rate > 192000) throw Error('MP3 取樣率不受支援。');
          resampler = new StreamResampler(rate, channels);
        }
        if (rate !== decoded.sampleRate) throw Error('MP3 途中變更取樣率，請先轉為單一格式。');
        save(resampler.push(decoded.channelData.slice(0, channels)));
      }
      self.postMessage({
        type: 'progress',
        phase: '正在分段解碼 MP3',
        progress: Math.min(1, (offset + 16384) / file.size),
      });
    }
    if (resampler)
      save(
        resampler.push(
          Array.from({ length: channels }, () => new Float32Array()),
          true,
        ),
      );
    if (!length) throw Error('MP3 沒有可解碼的音訊資料。');
    disk.flush();
    info = {
      length,
      sampleRate: RATE,
      numberOfChannels: channels,
      duration: length / RATE,
      mode: 'pcm-cache',
      storageBytes: length * channels * 4,
      maxReadBytes,
    };
    return peaks.finish(length);
  } finally {
    decoder.free();
    decoder = null;
  }
}
self.onmessage = async ({ data }) => {
  try {
    if (data.type === 'init') {
      file = data.file;
      const peaks = /\.wav$/i.test(file.name)
        ? await initializeWav()
        : await initializeMp3(data.cacheId, data.duration);
      self.postMessage({ type: 'ready', info, peaks: peaks.buffer }, [peaks.buffer]);
    } else if (data.type === 'read') {
      const { start, end } = data;
      if (
        !info ||
        !Number.isInteger(start) ||
        !Number.isInteger(end) ||
        start < 0 ||
        end > info.length ||
        end <= start ||
        end - start > 131072
      )
        throw Error('音訊分段讀取範圍無效。');
      let channels;
      if (format) channels = await readWav(start, end);
      else {
        const count = end - start,
          interleaved = new Float32Array(count * info.numberOfChannels);
        if (disk.read(interleaved, { at: start * info.numberOfChannels * 4 }) !== interleaved.byteLength)
          throw Error('音訊暫存已遺失，請重新選入音檔。');
        channels = Array.from({ length: info.numberOfChannels }, () => new Float32Array(count));
        for (let i = 0; i < count; i++)
          for (let c = 0; c < channels.length; c++) channels[c][i] = interleaved[i * channels.length + c];
      }
      const transfers = channels.map((part) => part.buffer);
      self.postMessage({ type: 'read', id: data.id, channels: transfers }, transfers);
    }
  } catch (error) {
    if (data.type === 'init') {
      try {
        disk?.close();
      } catch {}
      releaseLock?.();
    }
    const message =
      error.name === 'QuotaExceededError'
        ? '本機暫存空間不足，請釋放空間或選擇較短音檔。'
        : ['SecurityError', 'NotAllowedError', 'NotSupportedError'].includes(error.name)
          ? '瀏覽器無法存取本機音訊暫存，請確認網站儲存空間可用。'
          : error.name === 'RangeError' || /out of memory|allocation failed/i.test(error.message)
            ? '可用記憶體不足，請關閉其他分頁或選擇較短音檔。'
            : error.message || '音訊分段處理失敗，請重新選入音檔。';
    self.postMessage({ type: 'error', id: data.id, message });
  }
};

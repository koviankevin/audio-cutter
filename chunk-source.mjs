const TEMP_DIR = 'yin-jian-audio-cache';
export async function clearAudioCache(id) {
  try {
    const root = await navigator.storage.getDirectory(),
      dir = await root.getDirectoryHandle(TEMP_DIR);
    const remove = async () => {
      try {
        await dir.removeEntry(id);
      } catch (error) {
        if (error.name !== 'NotFoundError') throw error;
      }
    };
    if (navigator.locks) await navigator.locks.request(`yin-jian-${id}`, remove);
    else await remove();
  } catch {}
}
async function clearStaleCaches() {
  if (!navigator.locks || !navigator.storage?.getDirectory) return;
  try {
    const dir = await (await navigator.storage.getDirectory()).getDirectoryHandle(TEMP_DIR);
    for await (const [name] of dir.entries())
      if (/^pcm-[a-f0-9-]+$/.test(name))
        await navigator.locks.request(`yin-jian-${name}`, { ifAvailable: true }, async (lock) => {
          if (lock)
            try {
              await dir.removeEntry(name);
            } catch {}
        });
  } catch {}
}
export class ChunkSource {
  // AudioBuffer-compatible metadata; PCM is requested in bounded, transferred blocks.
  constructor(file, { duration = 0, onProgress = () => {} } = {}) {
    this.cacheId = `pcm-${crypto.randomUUID()}`;
    this.requests = new Map();
    this.sequence = 0;
    this.disposed = false;
    this.worker = new Worker(new URL('./decode-worker.js', import.meta.url));
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });
    this.worker.onmessage = ({ data }) => {
      if (data.type === 'progress') onProgress(data.progress, data.phase);
      else if (data.type === 'ready') {
        Object.assign(this, data.info);
        this.peaks = new Float32Array(data.peaks);
        this.resolveReady(this);
      } else if (data.type === 'read') {
        const request = this.requests.get(data.id);
        this.requests.delete(data.id);
        request?.resolve(data.channels.map((bytes) => new Float32Array(bytes)));
      } else if (data.type === 'error') {
        const error = Object.assign(new Error(data.message), { userFacing: true });
        if (data.id !== undefined) {
          this.requests.get(data.id)?.reject(error);
          this.requests.delete(data.id);
        } else {
          this.rejectReady(error);
          this.dispose(error);
        }
      }
    };
    this.worker.onerror = (event) => {
      event.preventDefault();
      this.dispose(Object.assign(Error('音訊分段處理中斷，請重新選入音檔或重新整理後重試。'), { userFacing: true }));
    };
    this.worker.onmessageerror = () =>
      this.dispose(Object.assign(Error('音訊分段資料傳送失敗，請重新選入音檔。'), { userFacing: true }));
    clearStaleCaches().finally(() => {
      if (!this.disposed) this.worker.postMessage({ type: 'init', file, duration, cacheId: this.cacheId });
    });
  }
  readChannels(start, end) {
    if (this.disposed) return Promise.reject(new DOMException('音檔已釋放', 'AbortError'));
    if (
      !Number.isInteger(start) ||
      !Number.isInteger(end) ||
      start < 0 ||
      end > this.length ||
      end <= start ||
      end - start > 131072
    )
      return Promise.reject(Error('音訊讀取範圍無效。'));
    return new Promise((resolve, reject) => {
      const id = ++this.sequence;
      this.requests.set(id, { resolve, reject });
      this.worker.postMessage({ type: 'read', id, start, end });
    });
  }
  dispose(error = new DOMException('已取消音訊處理', 'AbortError')) {
    if (this.disposed) return this.cleanup;
    this.disposed = true;
    this.worker.terminate();
    this.rejectReady(error);
    for (const request of this.requests.values()) request.reject(error);
    this.requests.clear();
    this.peaks = null;
    this.cleanup = clearAudioCache(this.cacheId);
    return this.cleanup;
  }
}

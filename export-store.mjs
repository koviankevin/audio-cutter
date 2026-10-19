const DIRECTORY = 'yin-jian-export-cache';
const validName = (name) => /^out-[a-f0-9-]+\.(wav|mp3)$/.test(name);
const lockName = (name) => `yin-jian-export-${name}`;
export const DOWNLOAD_GRACE_MS = 10 * 60 * 1000;

export async function retainExportFile(name) {
  if (!validName(name)) return;
  const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle(DIRECTORY);
  const marker = await directory.getFileHandle(`${name}.done`, { create: true });
  const writer = await marker.createWritable();
  try {
    await writer.write(String(Date.now() + DOWNLOAD_GRACE_MS));
    await writer.close();
  } catch (error) {
    await writer.abort().catch(() => {});
    throw error;
  }
}

export async function retireExportFile({ worker, cacheName }) {
  // Revoking a URL cannot tell us when the browser's native download has finished.
  // Refresh a small expiry marker while our Worker still holds the lock, then
  // release that Worker. Keep only the file on disk during the download grace.
  try {
    await retainExportFile(cacheName);
  } catch {
  } finally {
    worker.terminate();
  }
  setTimeout(() => removeExportFile(cacheName), DOWNLOAD_GRACE_MS);
}

export async function removeExportFile(name) {
  if (!validName(name)) return;
  try {
    await navigator.locks.request(lockName(name), async () => {
      try {
        const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle(DIRECTORY);
        await directory.removeEntry(name);
        try {
          await directory.removeEntry(`${name}.done`);
        } catch {}
      } catch (error) {
        if (error.name !== 'NotFoundError') throw error;
      }
    });
  } catch {
    /* A closed page can finish cleanup on its next visit. */
  }
}

async function sweepExports() {
  try {
    const directory = await (await navigator.storage.getDirectory()).getDirectoryHandle(DIRECTORY);
    for await (const name of directory.keys()) {
      if (!validName(name)) continue;
      await navigator.locks.request(lockName(name), { ifAvailable: true }, async (lock) => {
        if (lock) {
          try {
            const marker = await (await directory.getFileHandle(`${name}.done`)).getFile();
            if (Number(await marker.text()) > Date.now()) return;
          } catch (error) {
            if (error.name !== 'NotFoundError') throw error;
          }
          try {
            await directory.removeEntry(name);
          } catch {}
          try {
            await directory.removeEntry(`${name}.done`);
          } catch {}
        }
      });
    }
  } catch (error) {
    if (error.name !== 'NotFoundError') throw error;
  }
}

// Used only inside the encoding Worker. The lock also protects the completed
// download until its object URL is revoked and the owning Worker is terminated.
export class ExportFile {
  static async create(name) {
    if (!validName(name)) throw Error('匯出暫存名稱無效。');
    if (!navigator.storage?.getDirectory || !navigator.locks)
      throw Error('瀏覽器無法建立匯出暫存，請使用桌面 Chrome／Edge，並確認網站儲存空間可用。');
    await sweepExports();
    return new Promise((resolve, reject) => {
      navigator.locks
        .request(lockName(name), async () => {
          try {
            const directory = await (
              await navigator.storage.getDirectory()
            ).getDirectoryHandle(DIRECTORY, { create: true });
            const handle = await directory.getFileHandle(name, { create: true });
            const access = await handle.createSyncAccessHandle();
            access.truncate(0);
            const output = new ExportFile(handle, access);
            resolve(output);
            await new Promise((release) => (output.releaseLock = release));
          } catch (error) {
            reject(error);
          }
        })
        .catch(reject);
    });
  }
  constructor(handle, access) {
    this.handle = handle;
    this.access = access;
    this.buffer = new Uint8Array(256 * 1024);
    this.used = 0;
    this.position = 0;
  }
  write(bytes) {
    if (this.access.write(bytes, { at: this.position }) !== bytes.byteLength)
      throw Error('匯出暫存寫入不完整，請確認磁碟空間後重試。');
    this.position += bytes.byteLength;
  }
  flushBuffer() {
    if (this.used) this.write(this.buffer.subarray(0, this.used));
    this.used = 0;
  }
  append(bytes) {
    if (bytes.byteLength >= this.buffer.length) {
      this.flushBuffer();
      this.write(bytes);
      return;
    }
    if (this.used + bytes.byteLength > this.buffer.length) this.flushBuffer();
    this.buffer.set(bytes, this.used);
    this.used += bytes.byteLength;
  }
  async finish() {
    this.flushBuffer();
    this.access.flush();
    this.access.close();
    this.access = null;
    this.buffer = null;
    // File is backed by OPFS; no complete ArrayBuffer or new Blob is assembled.
    const file = await this.handle.getFile();
    await retainExportFile(file.name);
    return file;
  }
  abort() {
    try {
      this.access?.close();
    } catch {}
    this.access = null;
    this.buffer = null;
    this.releaseLock?.();
  }
}

export function exportError(error) {
  if (error.name === 'QuotaExceededError') return '本機匯出暫存空間不足，請釋放空間或縮短匯出範圍。';
  if (['SecurityError', 'NotAllowedError', 'NotSupportedError'].includes(error.name))
    return '瀏覽器無法存取匯出暫存，請確認網站儲存空間可用。';
  if (error.name === 'RangeError' || /out of memory|allocation failed/i.test(error.message))
    return '可用記憶體不足，請關閉其他分頁或縮短匯出範圍。';
  return error.message || '音檔編碼失敗，請重試。';
}

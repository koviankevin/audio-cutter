export function identifySource(file, { signal, onProgress = () => {} } = {}) {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('已取消檔案核對', 'AbortError'));
      return;
    }
    let worker;
    const abort = () => finish(new DOMException('已取消檔案核對', 'AbortError'));
    function finish(error, source) {
      worker?.terminate();
      signal?.removeEventListener('abort', abort);
      if (error) reject(error);
      else resolve(source);
    }
    try {
      worker = new Worker(new URL('./fingerprint-worker.mjs', import.meta.url), { type: 'module' });
      signal?.addEventListener('abort', abort, { once: true });
      worker.onmessage = ({ data }) => {
        if (data.type === 'progress') onProgress(data.progress);
        else if (data.type === 'complete') finish(null, data.source);
        else if (data.type === 'error') finish(Object.assign(new Error(data.message), { userFacing: true }));
      };
      worker.onerror = (event) => {
        event.preventDefault();
        finish(
          Object.assign(new Error('原檔核對元件無法載入，請確認網路連線後重試；原有剪輯仍保留。'), {
            userFacing: true,
          }),
        );
      };
      worker.onmessageerror = () =>
        finish(Object.assign(new Error('原檔核對資料無法傳送，請重新選入音檔。'), { userFacing: true }));
      worker.postMessage({ file });
    } catch {
      finish(
        Object.assign(new Error('瀏覽器無法啟動原檔核對，請使用桌面 Chrome／Edge 並重新載入。'), { userFacing: true }),
      );
    }
  });
}

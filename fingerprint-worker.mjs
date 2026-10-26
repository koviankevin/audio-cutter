import { fingerprintFile } from './project.mjs';
self.onmessage = async ({ data }) => {
  try {
    const source = await fingerprintFile(data.file, {
      onProgress: (progress) => self.postMessage({ type: 'progress', progress }),
    });
    self.postMessage({ type: 'complete', source });
  } catch {
    self.postMessage({ type: 'error', message: '無法核對原始音檔，請確認檔案仍可讀取後再試一次。' });
  }
};

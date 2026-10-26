const storageError = (message) => Object.assign(new Error(message), { userFacing: true });
export const megabytes = (bytes) => `${Math.ceil(bytes / 1024 / 1024)} MB`;
export function exportBytes(frames, channels, format) {
  return format === 'wav' ? frames * channels * 2 + 44 : Math.ceil((frames / 44100) * 24000) + 65536;
}
export async function checkStorage(required = 0, browser = navigator) {
  if (!browser.storage?.getDirectory || !browser.locks)
    throw storageError('瀏覽器無法建立音訊暫存。請使用桌面 Chrome／Edge，並允許網站使用本機儲存空間。');
  try {
    await browser.storage.getDirectory();
  } catch {
    throw storageError(
      '網站的本機儲存空間目前無法使用。請檢查瀏覽器儲存設定，或使用一般視窗重新開啟；原始音檔不會被更動。',
    );
  }
  let estimate;
  try {
    estimate = await browser.storage.estimate?.();
  } catch {}
  const available =
    Number.isFinite(estimate?.quota) && Number.isFinite(estimate?.usage)
      ? Math.max(0, estimate.quota - estimate.usage)
      : null;
  if (available !== null && available < required + 1024 * 1024)
    throw storageError(
      `本機暫存空間不足，這次約需 ${megabytes(required + 1024 * 1024)}，目前估計可用 ${megabytes(available)}。請先釋放裝置空間或縮短匯出範圍，再重試；目前剪輯仍會保留。`,
    );
  return {
    available,
    label: available === null ? '本機暫存可用，瀏覽器未提供容量估計' : `本機暫存估計可用 ${megabytes(available)}`,
  };
}

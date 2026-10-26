import { APP_VERSION } from './version.mjs';
let issue = null;
const issueCodes = new Set([
  'operation-failed',
  'audio-playback',
  'audio-import',
  'audio-export',
  'storage-preflight',
  'project-save',
  'project-import',
  'unexpected-error',
  'unexpected-rejection',
]);
export function recordIssue(code) {
  issue = { code: issueCodes.has(code) ? code : 'operation-failed', time: new Date().toISOString() };
}
export function diagnostics() {
  return {
    app: 'yin-jian',
    version: APP_VERSION,
    browser: navigator.userAgent,
    secureContext: isSecureContext,
    capabilities: {
      webAudio: typeof AudioContext !== 'undefined',
      worker: typeof Worker !== 'undefined',
      webAssembly: typeof WebAssembly !== 'undefined',
      privateFiles: !!navigator.storage?.getDirectory,
      locks: !!navigator.locks,
    },
    lastIssue: issue,
  };
}
const dialog = document.getElementById('help-dialog');
if (dialog) {
  document.getElementById('app-version').textContent = APP_VERSION;
  document.getElementById('open-help').addEventListener('click', () => dialog.showModal());
  document.getElementById('copy-diagnostics').addEventListener('click', async () => {
    const text = JSON.stringify(diagnostics(), null, 2),
      output = document.getElementById('diagnostics-output');
    output.value = text;
    output.hidden = false;
    try {
      await navigator.clipboard.writeText(text);
      document.getElementById('diagnostics-status').textContent =
        '診斷資訊已複製，可貼到問題回報中。不含音檔、檔名或剪輯內容。';
    } catch {
      output.focus();
      output.select();
      document.getElementById('diagnostics-status').textContent = '瀏覽器未允許自動複製，請從下方欄位手動複製。';
    }
  });
}
window.addEventListener('error', () => recordIssue('unexpected-error'));
window.addEventListener('unhandledrejection', () => recordIssue('unexpected-rejection'));

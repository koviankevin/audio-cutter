(() => {
  let ready = false;
  function failed() {
    if (ready) return;
    const status = document.getElementById('app-startup');
    if (!status) return;
    document.getElementById('startup-message').textContent =
      '剪輯元件未能完整載入。請確認網路連線後重新載入；音檔仍在你的裝置上。';
    status.classList.add('error');
    for (const id of ['choose-file', 'load-demo', 'open-project']) document.getElementById(id).disabled = true;
    const retry = document.getElementById('retry-startup');
    retry.hidden = false;
    retry.onclick = () => location.reload();
  }
  window.addEventListener('audio-cutter-ready', () => {
    ready = true;
    clearTimeout(timer);
    document.getElementById('app-startup').hidden = true;
    for (const id of ['choose-file', 'load-demo', 'open-project']) document.getElementById(id).disabled = false;
  });
  window.addEventListener('audio-cutter-legacy', () => {
    ready = true;
    clearTimeout(timer);
    const status = document.getElementById('app-startup');
    if (status) status.hidden = true;
  });
  window.addEventListener(
    'error',
    (event) => {
      if (event.target instanceof HTMLScriptElement && event.target.type === 'module') failed();
    },
    true,
  );
  const timer = setTimeout(failed, 10000);
})();

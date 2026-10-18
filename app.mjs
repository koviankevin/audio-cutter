import { SAMPLE_RATE, MAX_BYTES, MAX_SECONDS, History, totalFrames, signature, normalize, subtract, subtractMany, intersect, junctionPreview, formatTime, parseTime } from './core.mjs';
import { AudioEngine, makePeaks, createDemo } from './audio.mjs';
import { Waveform } from './waveform.mjs';

const $ = id => document.getElementById(id);
const engine = new AudioEngine();
const history = new History({ ranges:[], pending:[], selection:[0,0], cursor:0 });
let selection = [0, 0], cursor = 0, fileName = '', savedSignature = '[]';
let loadToken = 0, isLoading = false, exportJob = null, downloadURL = null, animation = 0, playingRequest = 0;
let pendingDeletions = [];
let keptRanges = [];
let pendingEdit = null;
let junctionPlayback = null;
let junctionLoop = false;
const wave = new Waveform($('waveform'), value => setSelection(value), value => seek(value), () => addPendingSelection(true), editPendingRange);
const ranges = () => keptRanges;
const outputRanges = () => subtractMany(ranges(), pendingDeletions);
const normalizedPending = () => normalize(pendingDeletions.flatMap(part => intersect(ranges(), part)), engine.buffer?.length ?? 0);
const dirty = () => !!engine.buffer && signature(ranges()) !== savedSignature;
const seconds = frames => frames / (engine.buffer?.sampleRate || SAMPLE_RATE);

function captureState() {
  return structuredClone({ ranges:keptRanges, pending:pendingDeletions, selection, cursor });
}
function recordEdit(before) {
  pendingDeletions = normalizedPending();
  const after = captureState();
  // Selection, seeking and playback alone must not create a step or discard redo.
  if (signature([before.ranges, before.pending]) === signature([after.ranges, after.pending])) return false;
  return history.commit(after, before);
}
function applyState(state) {
  const restored = structuredClone(state);
  keptRanges = restored.ranges; pendingDeletions = restored.pending; selection = restored.selection;
  cursor = restored.cursor; engine.position = cursor;
}
function navigateHistory(direction) {
  if (!engine.buffer || pendingEdit || !(direction === 'undo' ? history.canUndo : history.canRedo)) return;
  const loop = junctionLoop;
  pause(); applyState(history[direction]()); revokeDownload(); clearNotice(); render();
  if (loop && selectedPendingIndex() >= 0) previewCurrentJunction({ loop:true });
}

function notify(message, error = false) {
  $('notice').textContent = message; $('notice').classList.toggle('error', error); $('notice').hidden = false;
}
function clearNotice() { $('notice').hidden = true; }
function revokeDownload() {
  if (downloadURL) URL.revokeObjectURL(downloadURL);
  downloadURL = null; $('download-link').hidden = true; $('download-link').removeAttribute('href');
}
function updateButtons() {
  const loaded = !!engine.buffer && !isLoading;
  const hasAudio = loaded && totalFrames(ranges()) > 0;
  const hasOutput = loaded && totalFrames(outputRanges()) > 0;
  const validSelection = loaded && selection[1] > selection[0];
  $('undo').disabled = !loaded || !history.canUndo; $('redo').disabled = !loaded || !history.canRedo;
  $('reset').disabled = !loaded || (!pendingDeletions.length && signature(ranges()) === signature([[0, engine.buffer?.length]]));
  $('toggle-play').disabled = !hasOutput; $('preview-result').disabled = !hasOutput;
  $('preview-selection').disabled = !validSelection || !totalFrames(intersect(ranges(), selection));
  $('delete-selection').disabled = !validSelection || !totalFrames(intersect(ranges(), selection));
  $('keep-selection').disabled = !validSelection || !totalFrames(intersect(ranges(), selection));
  $('add-deletion').disabled = !validSelection || !totalFrames(intersect(ranges(), selection));
  $('apply-deletions').disabled = !loaded || !pendingDeletions.length;
  $('preview-deletions').disabled = !hasOutput || !pendingDeletions.length;
  $('preview-junction').disabled = !hasOutput || selectedPendingIndex() < 0;
  $('loop-junction').disabled = !junctionLoop && (!hasOutput || selectedPendingIndex() < 0);
  $('export-button').disabled = !hasAudio || !!exportJob || !hasOutput;
  $('export-button').innerHTML = `<svg><use href="#i-download"/></svg>${pendingDeletions.length ? '刪除清單並匯出' : '匯出音檔'}`;
  $('edit-indicator').textContent = pendingDeletions.length ? `待刪除 ${pendingDeletions.length} 段` : dirty() ? '尚未匯出' : signature(ranges()) === signature([[0, engine.buffer?.length]]) ? '原始音檔' : '已匯出';
}
function updateSelectionFields() {
  $('selection-start').value = formatTime(seconds(selection[0]));
  $('selection-end').value = formatTime(seconds(selection[1]));
  $('selection-start').removeAttribute('aria-invalid'); $('selection-end').removeAttribute('aria-invalid');
  $('selection-duration').textContent = `${seconds(selection[1] - selection[0]).toFixed(3)} 秒`;
  updateButtons(); wave.update(ranges(), selection, cursor, pendingDeletions);
  updatePendingKeyboardUI();
}
function updatePendingKeyboardUI() {
  const index = selectedPendingIndex();
  document.querySelectorAll('[data-pending-mode]').forEach(button => {
    button.disabled = index < 0;
    button.setAttribute('aria-pressed', String(button.dataset.pendingMode === wave.pendingMode));
  });
  document.querySelectorAll('#pending-list .pending-time').forEach((button, i) => button.setAttribute('aria-pressed', String(i === index)));
  const mode = { move:'整段移動', start:'起點', end:'終點' }[wave.pendingMode] || '整段移動';
  $('pending-keyboard-hint').textContent = index < 0 ? '按 ↓ 選第一段，↑ 選最後一段；也可點選清單或橘色段落。' : `待刪 ${String(index + 1).padStart(2, '0')}／${pendingDeletions.length} · ${mode} · ← → 10 毫秒，Shift + ← → 100 毫秒。`;
}
function selectedPendingIndex() {
  return pendingDeletions.findIndex(([a, b]) => a === selection[0] && b === selection[1]);
}
function activatePending(index, mode = wave.pendingMode) {
  const range = pendingDeletions[index];
  if (!range) return;
  const loop = junctionLoop;
  wave.pendingMode = mode; setSelection([...range]);
  const frame = mode === 'start' ? range[0] : mode === 'end' ? range[1] : (range[0] + range[1]) / 2;
  wave.revealFrame(frame); $('wave-scroll').value = String(Math.round(wave.scroll * 1000));
  const list = $('pending-list'), row = list.children[index];
  if (row) {
    const bounds = row.getBoundingClientRect(), viewport = list.getBoundingClientRect();
    if (bounds.top < viewport.top) list.scrollTop -= viewport.top - bounds.top;
    else if (bounds.bottom > viewport.bottom) list.scrollTop += bounds.bottom - viewport.bottom;
  }
  $('waveform').focus({ preventScroll:true });
  if (loop) previewCurrentJunction({ loop:true });
}
function setSelection(value) {
  if (!engine.buffer) return;
  if (junctionPlayback) pause();
  if ($('selection-start').getAttribute('aria-invalid')) clearNotice();
  selection = value.map(frame => Math.round(Math.max(0, Math.min(engine.buffer.length, frame))));
  updateSelectionFields();
}
function applyTimeFields() {
  if (!engine.buffer) return false;
  const start = parseTime($('selection-start').value), end = parseTime($('selection-end').value);
  const invalid = !Number.isFinite(start) || !Number.isFinite(end) || start < 0 || end <= start || Math.round(end * SAMPLE_RATE) > engine.buffer.length + SAMPLE_RATE * .00051;
  if (invalid) {
    $('selection-start').setAttribute('aria-invalid', 'true'); $('selection-end').setAttribute('aria-invalid', 'true');
    notify('請輸入有效時間，例如 01:23.456。終點必須晚於起點，且不能超過音檔長度。', true);
    return false;
  }
  const endFrame = Math.abs(end - engine.buffer.duration) <= .00051 ? engine.buffer.length : Math.round(end * SAMPLE_RATE);
  clearNotice(); setSelection([Math.round(start * SAMPLE_RATE), endFrame]); return true;
}
function renderSegments() {
  $('segment-list').replaceChildren();
  ranges().forEach(([a, b], index) => {
    const li = document.createElement('li');
    const number = document.createElement('span'); number.textContent = String(index + 1).padStart(2, '0');
    const times = document.createElement('span'); times.textContent = `${formatTime(seconds(a))} — ${formatTime(seconds(b))}`;
    const duration = document.createElement('span'); duration.textContent = `${seconds(b - a).toFixed(3)} 秒`;
    const play = document.createElement('button'); play.type = 'button'; play.className = 'icon-button';
    play.setAttribute('aria-label', `播放片段 ${index + 1}`); play.title = `播放片段 ${index + 1}`;
    play.innerHTML = '<svg aria-hidden="true"><use href="#i-play"/></svg>';
    play.addEventListener('click', () => startPlayback([[a, b]], a));
    li.append(number, times, duration, play); $('segment-list').append(li);
  });
  $('segment-count').textContent = ranges().length;
  $('empty-segments').hidden = ranges().length > 0;
}
function render({ normalizeQueue = true } = {}) {
  if (!engine.buffer) return;
  if (normalizeQueue) pendingDeletions = normalizedPending();
  const outputTime = formatTime(seconds(totalFrames(outputRanges())));
  const [base, millis] = outputTime.split('.');
  $('output-duration').replaceChildren(document.createTextNode(base));
  const tail = document.createElement('span'); tail.textContent = `.${millis}`; $('output-duration').append(tail);
  const removed = engine.buffer.length - totalFrames(ranges());
  $('output-duration').previousElementSibling.textContent = pendingDeletions.length ? '預計匯出長度' : '剪輯後長度';
  $('trim-summary').textContent = pendingDeletions.length ? `待套用 ${pendingDeletions.length} 段 · 共 ${formatTime(seconds(totalFrames(normalizedPending())))}` : removed ? `已剪去 ${formatTime(seconds(removed))} · ${ranges().length} 個保留片段` : '尚未刪除任何段落';
  renderSegments(); renderPending(); updateSelectionFields(); updatePlaybackUI();
}
function renderPending() {
  $('pending-panel').hidden = !pendingDeletions.length;
  $('pending-legend').hidden = !pendingDeletions.length;
  $('pending-count').textContent = pendingDeletions.length;
  $('pending-list').replaceChildren();
  pendingDeletions.forEach(([a, b], index) => {
    const li = document.createElement('li');
    const number = document.createElement('span'); number.textContent = String(index + 1).padStart(2, '0');
    const times = document.createElement('button'); times.type = 'button'; times.className = 'text-button pending-time';
    times.textContent = `${formatTime(seconds(a))} — ${formatTime(seconds(b))}`;
    times.setAttribute('aria-label', `選取待刪段落 ${index + 1}`);
    times.addEventListener('click', () => activatePending(index, 'move'));
    const duration = document.createElement('span'); duration.textContent = `${seconds(b - a).toFixed(3)} 秒`;
    const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'icon-button';
    remove.setAttribute('aria-label', `移除待刪段落 ${index + 1}`); remove.title = '從待刪清單移除，保留這段音訊';
    remove.innerHTML = '<svg aria-hidden="true"><use href="#i-close"/></svg>';
    remove.addEventListener('click', () => { pause(); const before = captureState(); pendingDeletions.splice(index, 1); recordEdit(before); clearNotice(); render(); });
    li.append(number, times, duration, remove); $('pending-list').append(li);
  });
  $('pending-summary').textContent = `共 ${formatTime(seconds(totalFrames(normalizedPending())))} · 刪除後長度 ${formatTime(seconds(totalFrames(outputRanges())))}`;
}
function editPendingRange(index, value, phase, mode) {
  if (!engine.buffer) return;
  if (phase === 'start') {
    if (!pendingDeletions[index]) return;
    if (mode) wave.pendingMode = mode;
    pause({ keepJunctionLoop:junctionLoop }); pendingEdit = { index, before:captureState() };
    selection = [...value]; updateSelectionFields();
  } else if (pendingEdit?.index === index) {
    if (phase === 'update') {
      pendingDeletions[index] = [...value]; selection = [...value]; revokeDownload();
      // Keep the dragged interval's index stable until release, even when edges overlap.
      render({ normalizeQueue:false });
    } else {
      const before = pendingEdit.before;
      if (phase === 'cancel') applyState(before);
      else {
        pendingDeletions = normalizedPending();
        const merged = pendingDeletions.find(([a, b]) => a <= selection[0] && b >= selection[1]);
        if (merged) selection = [...merged];
      }
      pendingEdit = null;
      const changed = phase === 'end' && recordEdit(before);
      render();
      if (changed) notify('已更新待刪段落，可按 Ctrl+Z 復原，或繼續調整後匯出。');
      if (junctionLoop) previewCurrentJunction({ loop:true });
    }
  }
}
function addPendingSelection(fromWave = false) {
  if (!engine.buffer || (!fromWave && !applyTimeFields())) return;
  const next = normalize([...pendingDeletions, ...intersect(ranges(), selection)], engine.buffer.length);
  if (signature(next) === signature(pendingDeletions)) { notify('這個範圍已在清單內，或沒有可刪除的音訊。'); return; }
  pause(); const before = captureState(); pendingDeletions = next; recordEdit(before); revokeDownload(); render();
  notify(`已加入待刪清單，共 ${pendingDeletions.length} 段。可繼續選段，完成後一次刪除或直接匯出。`);
}
function applyPendingDeletions() {
  if (!engine.buffer || !pendingDeletions.length) return;
  const count = pendingDeletions.length;
  const next = subtractMany(ranges(), pendingDeletions);
  commit(next, { clearPending:true });
  notify(`已一次刪除 ${count} 段，剩下的音訊已依原始順序合併。按「復原」可全部還原。`);
}
function pause({ keepJunctionLoop = false } = {}) {
  playingRequest++; cursor = engine.pause(); junctionPlayback = null;
  if (!keepJunctionLoop) junctionLoop = false;
  cancelAnimationFrame(animation); updatePlaybackUI(); updateButtons();
}
function updatePlaybackUI() {
  $('toggle-play').setAttribute('aria-label', engine.playing ? '暫停' : '播放');
  $('toggle-play').querySelector('use').setAttribute('href', engine.playing ? '#i-pause' : '#i-play');
  $('playhead-time').textContent = formatTime(seconds(cursor));
  $('junction-preview-status').hidden = !junctionPlayback && !junctionLoop;
  const status = junctionPlayback || (junctionLoop ? '循環預聽調整中：放開方向鍵或把手後，會自動播放新接點。L／Esc 停止。' : '');
  if ($('junction-preview-status').textContent !== status) $('junction-preview-status').textContent = status;
  $('loop-junction').setAttribute('aria-pressed', String(junctionLoop));
  $('loop-junction-label').textContent = junctionLoop ? '停止循環' : '循環預聽';
  wave.update(ranges(), selection, cursor, pendingDeletions);
}
async function startPlayback(parts = outputRanges(), from = cursor, junction = null, { loop = false } = {}) {
  if (!engine.buffer || !parts.length) return;
  pause(); const request = ++playingRequest;
  junctionPlayback = junction; junctionLoop = loop; updatePlaybackUI(); updateButtons();
  try {
    await engine.play(parts, from, { loop });
    if (request !== playingRequest) return;
    tick();
  } catch { if (request === playingRequest) { pause(); notify('無法播放音檔，請確認瀏覽器允許播放音訊。', true); } }
}
function previewCurrentJunction({ loop = false } = {}) {
  if (!engine.buffer || wave.drag) return;
  // Explicit preview commands replace the audition after committing a held nudge.
  if (wave.keyboardEdit) { junctionLoop = false; wave.finishKeyboardEdit(); }
  const index = selectedPendingIndex();
  if (index < 0) { pause(); notify('請先用 ↑／↓ 選取待刪段落，再按 P 或 L 預聽接點。'); return; }
  const preview = junctionPreview(outputRanges(), pendingDeletions[index], Math.round(engine.buffer.sampleRate * 1.5));
  if (!preview.parts.length) { pause(); notify('刪除後沒有保留音訊，無法預聽接點。'); return; }
  const context = !preview.beforeFrames ? '位於結果開頭，僅預聽保留的後段' : !preview.afterFrames ? '位於結果結尾，僅預聽保留的前段' : '接點前 → 接點後';
  const status = `${loop ? '循環預聽' : '預聽'}待刪 ${String(index + 1).padStart(2, '0')} 接點 · ${context}（前 ${seconds(preview.beforeFrames).toFixed(3)} 秒／後 ${seconds(preview.afterFrames).toFixed(3)} 秒）· ${loop ? '微調後自動重聽，L／Esc 停止' : 'P 重聽，Esc 停止'}`;
  clearNotice(); startPlayback(preview.parts, preview.parts[0][0], status, { loop });
}
function toggleJunctionLoop() {
  if (junctionLoop) pause();
  else previewCurrentJunction({ loop:true });
}
function tick() {
  cursor = engine.currentFrame();
  if (engine.ended) { pause(); return; }
  updatePlaybackUI();
  if (engine.playing) animation = requestAnimationFrame(tick);
}
function seek(frame) { pause(); cursor = frame; engine.position = frame; updatePlaybackUI(); }
function commit(next, { clearPending = false, nextSelection = selection } = {}) {
  pause(); clearNotice(); const before = captureState();
  keptRanges = structuredClone(next);
  if (clearPending) pendingDeletions = [];
  selection = [...nextSelection]; cursor = next[0]?.[0] ?? 0; engine.position = cursor;
  if (recordEdit(before)) revokeDownload();
  render();
}
function edit(kind) {
  if (!applyTimeFields()) return;
  commit(kind === 'delete' ? subtract(ranges(), selection) : intersect(ranges(), selection));
}

async function confirmReplacement() {
  if (!dirty() && !pendingDeletions.length) return true;
  const dialog = $('replace-dialog'); dialog.returnValue = 'cancel'; dialog.showModal();
  return new Promise(resolve => dialog.addEventListener('close', () => resolve(dialog.returnValue === 'replace'), { once: true }));
}
async function acceptBuffer(buffer, name, bytes, token) {
  if (token !== loadToken) return;
  if (![1, 2].includes(buffer.numberOfChannels)) throw new Error('第一版支援單聲道與雙聲道，請先將多聲道音訊轉為立體聲。');
  if (!buffer.length || buffer.duration > MAX_SECONDS + .01) throw new Error('請選擇 30 分鐘以內且包含音訊的檔案。');
  $('loading-title').textContent = '正在繪製聲音的輪廓';
  const peaks = await makePeaks(buffer, progress => { if (token === loadToken) $('loading-detail').textContent = `波形準備中 ${Math.round(progress * 100)}%`; });
  if (token !== loadToken) return;
  engine.buffer = buffer; fileName = name; cursor = 0; selection = [0, buffer.length];
  keptRanges = [[0, buffer.length]]; pendingDeletions = [];
  history.reset(captureState()); savedSignature = signature(ranges());
  $('file-name').textContent = name;
  $('file-meta').textContent = `${buffer.numberOfChannels === 1 ? '單聲道' : '雙聲道'} · 44.1 kHz${bytes ? ` · ${(bytes / 1024 / 1024).toFixed(1)} MB` : ' · 示範音訊'}`;
  $('original-duration').textContent = formatTime(buffer.duration);
  $('export-name').value = `${name.replace(/\.[^.]+$/, '')}-剪輯`;
  $('zoom').value = 1; $('zoom-value').textContent = '1×'; $('wave-scroll').value = 0; $('scroll-label').hidden = true;
  wave.setAudio(buffer, peaks);
  isLoading = false; $('loading').hidden = true; $('import-area').hidden = true; $('workspace').hidden = false; $('features').hidden = true;
  document.body.classList.add('has-audio');
  render();
}
function beginLoading() {
  wave.cancelDrag(); pendingEdit = null;
  pause(); cancelExport(false); revokeDownload(); clearNotice(); engine.release();
  keptRanges = []; pendingDeletions = []; selection = [0,0]; cursor = 0;
  history.reset(captureState()); isLoading = true;
  $('workspace').hidden = true; $('import-area').hidden = true; $('features').hidden = true; $('loading').hidden = false;
  $('loading-title').textContent = '正在讀取音檔'; $('loading-detail').textContent = '正在解碼，請稍候。音檔不會上傳。';
  return ++loadToken;
}
function returnToImport() {
  document.body.classList.remove('has-audio');
  $('loading').hidden = true; $('workspace').hidden = true; $('import-area').hidden = false; $('features').hidden = false;
}
async function importFile(file) {
  if (!file) return;
  if (!file.size) { notify('這個檔案是空的，請選擇包含音訊的檔案。', true); return; }
  if (file.size > MAX_BYTES) { notify('檔案超過 400 MB，請先縮短音檔或轉換為 MP3。', true); return; }
  if (!/\.(mp3|wav)$/i.test(file.name)) { notify('目前支援 MP3 與 WAV，請選擇這兩種格式的音檔。', true); return; }
  if (!(await confirmReplacement())) return;
  const token = beginLoading();
  try {
    const duration = await readDuration(file);
    if (token !== loadToken) return;
    if (duration > MAX_SECONDS + .01) throw new Error('請選擇 30 分鐘以內且包含音訊的檔案。');
    const buffer = await engine.decode(file);
    await acceptBuffer(buffer, file.name, file.size, token);
  } catch (error) {
    if (token !== loadToken) return;
    isLoading = false; returnToImport();
    notify(error.message.includes('第一版') || error.message.includes('30 分鐘') ? error.message : '無法讀取這個音檔。可能已損毀、編碼不受支援，或裝置記憶體不足。請嘗試較短的 MP3 或 WAV。', true);
  }
}
async function readDuration(file) {
  const url = URL.createObjectURL(file); const audio = document.createElement('audio');
  let timeout;
  try {
    return await new Promise(resolve => {
      timeout = setTimeout(() => resolve(0), 5000);
      audio.preload = 'metadata'; audio.onloadedmetadata = () => resolve(Number.isFinite(audio.duration) ? audio.duration : 0);
      audio.onerror = () => resolve(0); audio.src = url;
    });
  } finally { clearTimeout(timeout); audio.removeAttribute('src'); audio.load(); URL.revokeObjectURL(url); }
}
async function demo() {
  if (!(await confirmReplacement())) return;
  const token = beginLoading();
  try { await acceptBuffer(createDemo(), '午後練習曲.wav', 0, token); }
  catch { if (token === loadToken) { isLoading = false; returnToImport(); notify('無法建立示範音訊，請嘗試重新整理頁面。', true); } }
}

function cancelExport(showNotice = true) {
  if (!exportJob) return;
  exportJob.worker.terminate(); exportJob = null; $('export-progress').hidden = true; updateButtons();
  if (showNotice) notify('已取消匯出，剪輯內容仍然保留。');
}
function exportAudio() {
  if (!engine.buffer || !totalFrames(ranges()) || exportJob) return;
  if (pendingDeletions.length) applyPendingDeletions();
  if (!totalFrames(ranges())) return;
  clearNotice(); revokeDownload();
  const format = document.querySelector('[name="format"]:checked').value;
  const parts = structuredClone(ranges());
  const buffer = engine.buffer;
  const frames = totalFrames(parts);
  const name = ($('export-name').value.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/\.(mp3|wav)$/i, '') || '我的剪輯') + `.${format}`;
  let worker;
  try { worker = new Worker(new URL('./export-worker.js', import.meta.url)); }
  catch { notify('瀏覽器無法啟動匯出處理，請透過網站連結或本機伺服器開啟，並重試。', true); return; }
  const job = { worker, signature: signature(parts), token: loadToken };
  exportJob = job;
  let partIndex = 0, frame = parts[0][0];
  $('export-progress').hidden = false; $('progress-bar').value = 0; $('export-status').textContent = '正在準備匯出…'; updateButtons();
  function fail(message) {
    if (exportJob !== job) return;
    cancelExport(false); notify(message || '匯出失敗，請重試或改用 WAV。', true);
  }
  function pump() {
    if (exportJob !== job) return;
    if (partIndex >= parts.length) { $('export-status').textContent = '正在完成檔案…'; worker.postMessage({ type: 'finish' }); return; }
    const end = Math.min(parts[partIndex][1], frame + 73728);
    const chunks = Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel).slice(frame, end).buffer);
    worker.postMessage({ type: 'chunk', channels: chunks }, chunks);
    frame = end;
    if (frame >= parts[partIndex][1]) { partIndex++; frame = parts[partIndex]?.[0] ?? 0; }
  }
  worker.onmessage = ({ data }) => {
    if (exportJob !== job) return;
    if (data.type === 'ready') pump();
    else if (data.type === 'progress') {
      const progress = Math.min(99, Math.floor(data.processed / frames * 100));
      $('progress-bar').value = progress; $('export-status').textContent = `正在匯出 ${format.toUpperCase()}… ${progress}%`;
      // Yield to paint and input before handing the next chunk to the worker.
      setTimeout(pump, 0);
    } else if (data.type === 'complete') {
      worker.terminate(); exportJob = null; $('export-progress').hidden = true;
      if (job.token !== loadToken) return;
      savedSignature = job.signature;
      downloadURL = URL.createObjectURL(data.blob);
      const link = $('download-link'); link.href = downloadURL; link.download = name; link.hidden = false;
      link.click(); updateButtons(); notify('匯出完成！若下載未自動開始，可點選「下載完成的音檔」。');
    } else if (data.type === 'error') fail(data.message);
  };
  worker.onerror = event => { event.preventDefault(); fail('匯出元件載入失敗，請確認網站資源完整後重試。'); };
  worker.onmessageerror = () => fail('音訊資料傳送失敗，請重試。');
  worker.postMessage({ type: 'init', format, sampleRate: buffer.sampleRate, channels: buffer.numberOfChannels, frames });
}

$('choose-file').addEventListener('click', () => $('file-input').click());
$('replace-file').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', event => { const file = event.target.files[0]; event.target.value = ''; importFile(file); });
$('load-demo').addEventListener('click', demo);
$('cancel-load').addEventListener('click', () => { loadToken++; isLoading = false; engine.release(); returnToImport(); notify('已取消載入。'); });
for (const type of ['dragenter', 'dragover']) document.addEventListener(type, event => { event.preventDefault(); if (!isLoading) $('import-area').classList.add('drag-over'); });
document.addEventListener('dragleave', event => { if (!event.relatedTarget) $('import-area').classList.remove('drag-over'); });
document.addEventListener('drop', event => {
  event.preventDefault(); $('import-area').classList.remove('drag-over');
  if (isLoading) return;
  if (event.dataTransfer.files.length !== 1) { notify('請一次選入一個音檔。', true); return; }
  importFile(event.dataTransfer.files[0]);
});
for (const id of ['selection-start', 'selection-end']) {
  $(id).addEventListener('change', applyTimeFields);
  $(id).addEventListener('keydown', event => { if (event.key === 'Enter') { applyTimeFields(); event.target.blur(); } });
}
$('delete-selection').addEventListener('click', () => edit('delete'));
$('add-deletion').addEventListener('click', () => addPendingSelection());
$('apply-deletions').addEventListener('click', applyPendingDeletions);
$('clear-deletions').addEventListener('click', () => { pause(); const before = captureState(); pendingDeletions = []; recordEdit(before); clearNotice(); render(); });
document.querySelectorAll('[data-pending-mode]').forEach(button => button.addEventListener('click', () => {
  activatePending(selectedPendingIndex(), button.dataset.pendingMode);
}));
$('preview-deletions').addEventListener('click', () => startPlayback(outputRanges(), 0));
$('preview-junction').addEventListener('click', () => { previewCurrentJunction(); $('waveform').focus({ preventScroll:true }); });
$('loop-junction').addEventListener('click', () => { toggleJunctionLoop(); $('waveform').focus({ preventScroll:true }); });
$('keep-selection').addEventListener('click', () => edit('keep'));
$('undo').addEventListener('click', () => navigateHistory('undo'));
$('redo').addEventListener('click', () => navigateHistory('redo'));
$('reset').addEventListener('click', () => commit([[0, engine.buffer.length]], { clearPending:true, nextSelection:[0, engine.buffer.length] }));
$('toggle-play').addEventListener('click', () => engine.playing ? pause() : startPlayback());
$('preview-result').addEventListener('click', () => startPlayback(outputRanges(), 0));
$('preview-selection').addEventListener('click', () => { if (applyTimeFields()) startPlayback(intersect(ranges(), selection), selection[0]); });
$('zoom').addEventListener('input', event => {
  wave.zoom = Number(event.target.value); $('zoom-value').textContent = `${wave.zoom}×`; $('scroll-label').hidden = wave.zoom === 1; wave.draw();
});
$('wave-scroll').addEventListener('input', event => { wave.scroll = Number(event.target.value) / 1000; wave.draw(); });
document.querySelectorAll('[name="format"]').forEach(input => input.addEventListener('change', () => {
  $('format-detail').textContent = input.value === 'mp3' ? '192 kbps · 44.1 kHz' : '16-bit PCM · 44.1 kHz';
}));
$('export-button').addEventListener('click', exportAudio);
$('cancel-export').addEventListener('click', () => cancelExport());
document.addEventListener('keydown', event => {
  if (!engine.buffer || isLoading || $('replace-dialog').open || event.isComposing || event.target.isContentEditable || event.target.closest('input, textarea, select')) return;
  if (!event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'p' && !wave.drag) {
    event.preventDefault(); if (!event.repeat) previewCurrentJunction(); return;
  }
  if (!event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && event.key.toLowerCase() === 'l' && !wave.drag) {
    event.preventDefault(); if (!event.repeat) toggleJunctionLoop(); return;
  }
  const pendingShortcut = !event.ctrlKey && !event.metaKey && !event.altKey && !event.shiftKey && ['ArrowUp','ArrowDown','1','2','3'].includes(event.key);
  if (pendingShortcut && pendingDeletions.length && !wave.drag) {
    event.preventDefault();
    // Finish a held nudge before switching: normalization can merge/reindex markers.
    wave.finishKeyboardEdit();
    const index = selectedPendingIndex(), count = pendingDeletions.length;
    if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
      const next = index < 0 ? (event.key === 'ArrowDown' ? 0 : count - 1) : (index + (event.key === 'ArrowDown' ? 1 : -1) + count) % count;
      activatePending(next);
    } else activatePending(Math.max(0, index), { '1':'move', '2':'start', '3':'end' }[event.key]);
    return;
  }
  if (pendingEdit) { if (event.key === 'Escape') { event.preventDefault(); pause(); wave.cancelDrag(); } return; }
  if (event.key === 'Escape' && junctionPlayback) { event.preventDefault(); pause(); return; }
  const modified = event.ctrlKey || event.metaKey;
  if (modified && event.key.toLowerCase() === 'z') { event.preventDefault(); (event.shiftKey ? $('redo') : $('undo')).click(); }
  else if (modified && event.key.toLowerCase() === 'y') { event.preventDefault(); $('redo').click(); }
  else if (event.code === 'Space' && !event.target.closest('button,a')) { event.preventDefault(); $('toggle-play').click(); }
  else if (event.key === 'Delete' || event.key === 'Backspace') { event.preventDefault(); $('delete-selection').click(); }
});
window.addEventListener('beforeunload', event => { if (dirty() || pendingDeletions.length || exportJob) { event.preventDefault(); event.returnValue = ''; } });
window.addEventListener('pagehide', event => { cancelExport(false); pause(); if (!event.persisted) { revokeDownload(); engine.release(); engine.context?.close(); } });

// Render is entirely local: no analytics, fetch of audio, or account is required.

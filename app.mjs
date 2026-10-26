import { SAMPLE_RATE, MAX_BYTES, MAX_SECONDS, History, totalFrames, signature, normalize, subtract, subtractMany, intersect, junctionPreview, formatTime, parseTime, exportJunctions, junctionNeighbors, junctionWindow } from './core.mjs';
import { AudioEngine, makePeaks, createDemo } from './audio.mjs';
import { Waveform } from './waveform.mjs';
import { removeExportFile, retireExportFile } from './export-store.mjs';
import { ExportEstimate, formatRemaining, formatElapsed, formatSpeed, exportResult } from './export-progress.mjs';
import { MediaWindowPlayer } from './media-window.mjs';
import { ProjectSession } from './project-session.mjs';
import { sameSource, validateProject } from './project.mjs';
import { identifySource } from './source-identity.mjs';
import { checkStorage, exportBytes } from './storage-check.mjs';
import { applyJoinFades } from './join-fades.mjs';
import { recordIssue } from './support.mjs';

const $ = id => document.getElementById(id);
const setText = (element, value) => { if (element.textContent !== value) element.textContent = value; };
const setAttribute = (element, name, value) => { if (element.getAttribute(name) !== value) element.setAttribute(name, value); };
if (!$('save-project') || !$('join-fade') || !$('help-dialog')) {
  const notice = $('notice');
  if (notice) { notice.hidden = false; notice.textContent = '音剪已更新，請重新載入後再開始；若仍顯示舊版，請強制重新整理。'; }
  const reload = $('choose-file');
  if (reload) { reload.disabled = false; reload.textContent = '重新載入音剪'; reload.addEventListener('click', () => location.reload()); }
  window.dispatchEvent(new Event('audio-cutter-legacy'));
  throw new Error('音剪頁面版本較舊，請重新載入。');
}
const engine = new AudioEngine();
engine.onError = error => { pause(); notify(error.message || '音訊讀取失敗，請重新選入音檔。', true, 'audio-playback'); };
const history = new History({ ranges:[], pending:[], selection:[0,0], cursor:0 });
let selection = [0, 0], cursor = 0, fileName = '', savedSignature = '[]';
let loadToken = 0, isLoading = false, exportJob = null, downloadURL = null, animation = 0, playingRequest = 0;
let downloadResource = null;
let exportPreview = null;
const exportAudition = new MediaWindowPlayer($('result-audio'), {
  onChange:updateExportPreviewPosition,
  onManualSeek:() => { if (exportPreview) exportPreview.selected = -1; updateExportPreviewPosition(); },
  onError:() => { $('result-audio-error').hidden = false; },
});
let pendingDeletions = [];
let keptRanges = [];
let pendingEdit = null;
let junctionPlayback = null;
let junctionLoop = false;
let segmentsKey = null;
let restoreRequest = null, exportPreparation = null, loadFallback = null, identityController = null;
const wave = new Waveform($('waveform'), value => setSelection(value), value => seek(value), () => addPendingSelection(true), editPendingRange);
const projects = new ProjectSession({ snapshot:projectSnapshot, restore:requestRestore, notify });
checkStorage().then(result => { $('storage-status').textContent = `${result.label} · 容量為估計值`; }).catch(error => { $('storage-status').textContent = error.message; });
const ranges = () => keptRanges;
const outputRanges = () => subtractMany(ranges(), pendingDeletions);
const normalizedPending = () => normalize(pendingDeletions.flatMap(part => intersect(ranges(), part)), engine.buffer?.length ?? 0);
const contentSignature = (parts = ranges(), fadeMs = Number($('join-fade').value)) => signature([parts, fadeMs]);
const dirty = () => !!engine.buffer && contentSignature() !== savedSignature;
const seconds = frames => frames / (engine.buffer?.sampleRate || SAMPLE_RATE);

function captureState() {
  return structuredClone({ ranges:keptRanges, pending:pendingDeletions, selection, cursor });
}
function projectSnapshot() {
  if (!engine.buffer || isLoading) return null;
  const state = pendingEdit ? structuredClone(pendingEdit.before) : captureState();
  const states = structuredClone(history.states); states[history.index] = structuredClone(state);
  const before = Number($('result-junction-before').value), after = Number($('result-junction-after').value);
  const validContext = [before, after].every(n => Number.isFinite(n) && n >= 0 && n <= 30) && before + after > 0;
  return {
    audio:{ sampleRate:engine.buffer.sampleRate, length:engine.buffer.length, channels:engine.buffer.numberOfChannels },
    state, history:{ states, index:history.index },
    preferences:{ name:$('export-name').value, format:document.querySelector('[name="format"]:checked').value, fadeMs:Number($('join-fade').value),
      view:{ zoom:wave.zoom, scroll:wave.scroll, mode:wave.pendingMode || 'move' },
      context:validContext ? { before, after } : { before:1, after:1 } },
  };
}
async function requestRestore(value) {
  if (isLoading) { notify('請先完成或取消目前的載入，再開啟專案。', true); return; }
  const project = validateProject(value);
  if (project.source.kind === 'demo') { await demo(project); return; }
  restoreRequest = project;
  $('restore-request').hidden = false;
  $('restore-file-name').textContent = project.source.name;
  $('restore-source').focus();
}
function cancelRestore() { restoreRequest = null; $('restore-request').hidden = true; }
function restoreProjectState(project) {
  applyState(project.state); history.states = structuredClone(project.history.states); history.index = project.history.index;
  const preferences = project.preferences;
  $('export-name').value = preferences.name;
  $('join-fade').value = preferences.fadeMs;
  document.querySelector(`[name="format"][value="${preferences.format}"]`).checked = true;
  $('format-detail').textContent = preferences.format === 'mp3' ? '192 kbps · 44.1 kHz' : '16-bit PCM · 44.1 kHz';
  wave.zoom = preferences.view.zoom; wave.scroll = preferences.view.scroll; wave.pendingMode = preferences.view.mode;
  $('zoom').value = wave.zoom; $('zoom-value').textContent = `${wave.zoom}×`; $('wave-scroll').value = wave.scroll * 1000; $('scroll-label').hidden = wave.zoom === 1;
  $('result-junction-before').value = preferences.context.before; $('result-junction-after').value = preferences.context.after;
}
function recoverPreviousLoad() {
  engine.release(); isLoading = false;
  const previous = loadFallback; loadFallback = null;
  if (!previous) { returnToImport(); return false; }
  engine.buffer = previous.buffer; fileName = previous.project.source.name;
  wave.setAudio(previous.buffer, previous.peaks); restoreProjectState(previous.project);
  savedSignature = previous.savedSignature;
  $('file-name').textContent = fileName; $('file-meta').textContent = previous.meta;
  $('original-duration').textContent = formatTime(previous.buffer.duration);
  $('loading').hidden = true; $('import-area').hidden = true; $('workspace').hidden = false; $('features').hidden = true;
  $('workspace').after($('draft-panel'));
  document.body.classList.add('has-audio'); projects.activate(previous.project.source, previous.id); render();
  return true;
}
function recordEdit(before) {
  pendingDeletions = normalizedPending();
  const after = captureState();
  // Selection, seeking and playback alone must not create a step or discard redo.
  if (signature([before.ranges, before.pending]) === signature([after.ranges, after.pending])) return false;
  const changed = history.commit(after, before);
  if (changed) { if (downloadURL) revokeDownload(); projects.schedule(); }
  return changed;
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
  projects.schedule();
  if (loop && selectedPendingIndex() >= 0) previewCurrentJunction({ loop:true });
}

function notify(message, error = false, code = 'operation-failed') {
  if (error) recordIssue(code);
  $('notice').textContent = message; $('notice').classList.toggle('error', error); $('notice').hidden = false;
}
function clearNotice() { $('notice').hidden = true; }
function revokeDownload() {
  exportAudition.stop({ pause:true });
  exportPreview = null;
  $('result-junction-markers').replaceChildren();
  const preview = $('result-audio');
  if (preview.hasAttribute('src')) {
    preview.pause(); preview.removeAttribute('src'); preview.load();
    updateExportPreviewPosition();
  }
  $('result-audio-error').hidden = true;
  if (downloadURL) URL.revokeObjectURL(downloadURL);
  if (downloadResource) {
    retireExportFile(downloadResource); downloadResource = null;
  }
  downloadURL = null; $('download-link').hidden = true; $('download-link').removeAttribute('href');
  $('export-result').hidden = true;
  $('result-version-note').hidden = true;
  for (const id of ['result-name', 'result-elapsed', 'result-speed', 'result-size']) $(id).textContent = '';
  $('result-size').removeAttribute('title');
  updateExportJunctionUI(0, 0);
}
function updateButtons() {
  const loaded = !!engine.buffer && !isLoading;
  const hasAudio = loaded && totalFrames(ranges()) > 0;
  const hasOutput = loaded && totalFrames(outputRanges()) > 0;
  const validSelection = loaded && selection[1] > selection[0];
  document.querySelectorAll('.workflow-guide li').forEach((item, index) => {
    if (index === (!loaded ? 0 : downloadURL ? 2 : 1)) item.setAttribute('aria-current', 'step');
    else item.removeAttribute('aria-current');
  });
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
  $('export-button').disabled = !hasAudio || !!exportJob || !!exportPreparation || !hasOutput;
  $('save-project').disabled = !loaded;
  $('join-fade').disabled = !!exportJob || !!exportPreparation;
  $('export-name').disabled = !!exportJob || !!exportPreparation;
  document.querySelectorAll('[name="format"]').forEach(input => { input.disabled = !!exportJob || !!exportPreparation; });
  const exportLabel = pendingDeletions.length ? '刪除清單並匯出' : '匯出音檔';
  if ($('export-button').textContent !== exportLabel) $('export-button').innerHTML = `<svg><use href="#i-download"/></svg>${exportLabel}`;
  $('edit-indicator').textContent = pendingDeletions.length ? `待刪除 ${pendingDeletions.length} 段` : dirty() ? '尚未匯出' : signature(ranges()) === signature([[0, engine.buffer?.length]]) ? '原始音檔' : '已匯出';
}
function updateSelectionFields({ drawWave = true } = {}) {
  $('selection-start').value = formatTime(seconds(selection[0]));
  $('selection-end').value = formatTime(seconds(selection[1]));
  $('selection-start').removeAttribute('aria-invalid'); $('selection-end').removeAttribute('aria-invalid');
  $('selection-duration').textContent = `${seconds(selection[1] - selection[0]).toFixed(3)} 秒`;
  updateButtons(); if (drawWave) wave.update(ranges(), selection, cursor, pendingDeletions);
  updatePendingKeyboardUI();
}
function updatePendingKeyboardUI() {
  const index = selectedPendingIndex();
  document.querySelectorAll('[data-pending-mode]').forEach(button => {
    button.disabled = index < 0;
    setAttribute(button, 'aria-pressed', String(button.dataset.pendingMode === wave.pendingMode));
  });
  document.querySelectorAll('#pending-list .pending-time').forEach((button, i) => setAttribute(button, 'aria-pressed', String(i === index)));
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
  if (!pendingEdit) projects.schedule();
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
  const key = signature(ranges());
  if (segmentsKey === key) return;
  segmentsKey = key;
  $('segment-list').replaceChildren();
  ranges().forEach(([a, b], index) => {
    const li = document.createElement('li');
    const number = document.createElement('span'); number.textContent = String(index + 1).padStart(2, '0');
    const times = document.createElement('span'); times.textContent = `${formatTime(seconds(a))} — ${formatTime(seconds(b))}`;
    const duration = document.createElement('span'); duration.textContent = `${seconds(b - a).toFixed(3)} 秒`;
    const play = document.createElement('button'); play.type = 'button'; play.className = 'icon-button';
    play.setAttribute('aria-label', `播放片段 ${index + 1}`); play.title = `播放片段 ${index + 1}`;
    play.innerHTML = '<svg aria-hidden="true"><use href="#i-play"/></svg>';
    play.addEventListener('click', () => startPlayback([[a, b]], a, null, { processCuts:false }));
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
  renderSegments(); renderPending(); updateSelectionFields({ drawWave:false }); updatePlaybackUI();
}
function renderPending() {
  $('pending-panel').hidden = !pendingDeletions.length;
  $('pending-legend').hidden = !pendingDeletions.length;
  $('pending-count').textContent = pendingDeletions.length;
  const list = $('pending-list');
  while (list.children.length > pendingDeletions.length) list.lastElementChild.remove();
  pendingDeletions.forEach(([a, b], index) => {
    let li = list.children[index];
    if (!li) {
      li = document.createElement('li');
      const number = document.createElement('span'); number.textContent = String(index + 1).padStart(2, '0');
      const times = document.createElement('button'); times.type = 'button'; times.className = 'text-button pending-time';
      times.setAttribute('aria-label', `選取待刪段落 ${index + 1}`);
      times.addEventListener('click', () => activatePending(index, 'move'));
      const duration = document.createElement('span');
      const remove = document.createElement('button'); remove.type = 'button'; remove.className = 'icon-button';
      remove.setAttribute('aria-label', `移除待刪段落 ${index + 1}`); remove.title = '從待刪清單移除，保留這段音訊';
      remove.innerHTML = '<svg aria-hidden="true"><use href="#i-close"/></svg>';
      remove.addEventListener('click', () => { pause(); const before = captureState(); pendingDeletions.splice(index, 1); recordEdit(before); clearNotice(); render(); });
      li.append(number, times, duration, remove); list.append(li);
    }
    setText(li.children[1], `${formatTime(seconds(a))} — ${formatTime(seconds(b))}`);
    setText(li.children[2], `${seconds(b - a).toFixed(3)} 秒`);
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
function pause({ keepJunctionLoop = false, keepExportPreview = false } = {}) {
  if (!keepExportPreview) exportAudition.stop({ pause:true });
  playingRequest++; cursor = engine.pause(); junctionPlayback = null;
  if (!keepJunctionLoop) junctionLoop = false;
  cancelAnimationFrame(animation); updatePlaybackUI(); updateButtons();
}
function updateExportPreviewPosition() {
  const preview = $('result-audio'), seek = $('result-audio-seek');
  const duration = Number.isFinite(preview.duration) && !preview.error ? preview.duration : 0;
  const position = Math.min(duration, Math.max(0, preview.currentTime || 0));
  seek.disabled = !(duration > 0); seek.max = duration; seek.value = position;
  const label = `${formatElapsed(position)} / ${duration > 0 ? formatElapsed(duration) : '--:--'}`;
  setText($('result-audio-position'), label); setAttribute(seek, 'aria-valuetext', label);
  updateExportJunctionUI(duration, position);
}
function renderExportJunctions() {
  const fragment = document.createDocumentFragment();
  exportPreview.junctions.forEach((time, index) => {
    const marker = document.createElement('button');
    marker.type = 'button'; marker.className = 'result-junction-marker';
    marker.setAttribute('aria-label', `接點 ${index + 1}，${formatTime(time)}；依前後秒數預聽`);
    marker.title = `接點 ${index + 1} · ${formatTime(time)}`;
    marker.setAttribute('aria-pressed', 'false'); marker.disabled = true;
    marker.addEventListener('click', () => previewExportJunction(index));
    fragment.append(marker);
  });
  $('result-junction-markers').replaceChildren(fragment);
  updateExportPreviewPosition();
}
function updateExportJunctionUI(duration, position) {
  const state = exportPreview, markers = $('result-junction-markers');
  const context = exportPreviewContext();
  const ready = duration > 0 && !!state && !!context;
  const neighbors = state ? junctionNeighbors(state.junctions, position, state.selected) : { previous:-1, next:-1 };
  $('result-junction-previous').disabled = !ready || neighbors.previous < 0;
  $('result-junction-next').disabled = !ready || neighbors.next < 0;
  $('result-junction-loop').disabled = !ready || state.selected < 0;
  setAttribute($('result-junction-loop'), 'aria-pressed', String(exportAudition.looping));
  setText($('result-junction-loop'), exportAudition.looping ? '停止循環' : '循環目前接點');
  const window = exportAudition.window;
  setText($('result-junction-window'), window ? `${exportAudition.looping ? '循環範圍' : '預聽範圍'} ${formatTime(window.start)} — ${formatTime(window.end)}` : '');
  if (!state) { setText($('result-junction-status'), ''); return; }
  const scale = duration || state.duration;
  if (state.markerDuration !== scale || state.markersReady !== ready) {
    state.junctions.forEach((time, index) => {
      markers.children[index].style.left = `${Math.min(100, time / scale * 100)}%`;
      markers.children[index].disabled = !ready;
    });
    state.markerDuration = scale; state.markersReady = ready;
  }
  if (state.renderedSelection !== state.selected) {
    if (state.renderedSelection >= 0) setAttribute(markers.children[state.renderedSelection], 'aria-pressed', 'false');
    if (state.selected >= 0) setAttribute(markers.children[state.selected], 'aria-pressed', 'true');
    state.renderedSelection = state.selected;
  }
  setText($('result-junction-status'), state.selected >= 0
    ? `接點 ${state.selected + 1} / ${state.junctions.length} · ${formatTime(state.junctions[state.selected])}`
    : state.junctions.length ? `共 ${state.junctions.length} 個接點` : '這次匯出沒有剪輯接點');
}
function previewExportJunction(index) {
  const state = exportPreview, preview = $('result-audio');
  if (!state || !Number.isFinite(state.junctions[index]) || preview.readyState < 1 || preview.error) return;
  const context = exportPreviewContext();
  const window = context && junctionWindow(state.junctions[index], context.before, context.after, preview.duration);
  if (!window) return;
  state.selected = index;
  exportAudition.start(window, { loop:exportAudition.looping });
}
function exportPreviewContext() {
  const before = $('result-junction-before').valueAsNumber, after = $('result-junction-after').valueAsNumber;
  return [before, after].every(value => Number.isFinite(value) && value >= 0 && value <= 30) && before + after > 0 ? { before, after } : null;
}
function changeExportPreviewContext() {
  const context = exportPreviewContext();
  for (const id of ['result-junction-before', 'result-junction-after']) {
    if (context) $(id).removeAttribute('aria-invalid');
    else $(id).setAttribute('aria-invalid', 'true');
  }
  $('result-junction-settings-error').hidden = !!context;
  if (!context) { exportAudition.stop({ pause:true }); return; }
  if (exportPreview?.selected >= 0 && exportAudition.window) {
    const window = junctionWindow(exportPreview.junctions[exportPreview.selected], context.before, context.after, $('result-audio').duration);
    if (window) exportAudition.start(window, { loop:exportAudition.looping, play:!$('result-audio').paused });
  }
  updateExportPreviewPosition();
}
function stepExportJunction(direction) {
  if (!exportPreview) return;
  const neighbors = junctionNeighbors(exportPreview.junctions, $('result-audio').currentTime, exportPreview.selected);
  previewExportJunction(neighbors[direction]);
}
function updatePlaybackUI() {
  // Read/draw before changing text, so cursor animation doesn't force a layout.
  wave.update(ranges(), selection, cursor, pendingDeletions);
  setAttribute($('toggle-play'), 'aria-label', engine.playing ? '暫停' : '播放');
  setAttribute($('toggle-play').querySelector('use'), 'href', engine.playing ? '#i-pause' : '#i-play');
  setText($('playhead-time'), formatTime(seconds(cursor)));
  const hidden = !junctionPlayback && !junctionLoop;
  if ($('junction-preview-status').hidden !== hidden) $('junction-preview-status').hidden = hidden;
  const status = junctionPlayback || (junctionLoop ? '循環預聽調整中：放開方向鍵或把手後，會自動播放新接點。L／Esc 停止。' : '');
  if ($('junction-preview-status').textContent !== status) $('junction-preview-status').textContent = status;
  setAttribute($('loop-junction'), 'aria-pressed', String(junctionLoop));
  setText($('loop-junction-label'), junctionLoop ? '停止循環' : '循環預聽');
}
async function startPlayback(parts = outputRanges(), from = cursor, junction = null, { loop = false, processCuts = true } = {}) {
  if (!engine.buffer || !parts.length) return;
  pause(); const request = ++playingRequest;
  junctionPlayback = junction; junctionLoop = loop; updatePlaybackUI(); updateButtons();
  try {
    await engine.play(parts, from, { loop, fadeFrames:processCuts ? Math.round(Number($('join-fade').value) * SAMPLE_RATE / 1000) : 0, fadeParts:outputRanges() });
    if (request !== playingRequest) return;
    tick();
  } catch (error) { if (request === playingRequest) { pause(); notify(error.userFacing ? error.message : '無法播放音檔，請確認瀏覽器允許播放音訊。', true); } }
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
function seek(frame) { pause(); cursor = frame; engine.position = frame; updatePlaybackUI(); projects.schedule(); }
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
async function acceptBuffer(buffer, name, bytes, token, source, project = null) {
  if (token !== loadToken) { buffer.dispose?.(); return; }
  if (![1, 2].includes(buffer.numberOfChannels)) throw Object.assign(new Error('目前支援單聲道與雙聲道，請先將多聲道音訊轉為立體聲。'), { userFacing:true });
  if (!buffer.length || buffer.duration > MAX_SECONDS + .01) throw new Error('請選擇 30 分鐘以內且包含音訊的檔案。');
  if (project && (buffer.length !== project.audio.length || buffer.sampleRate !== project.audio.sampleRate || buffer.numberOfChannels !== project.audio.channels)) {
    buffer.dispose?.(); throw Object.assign(Error('原檔解碼結果與專案不同，已停止還原。請使用儲存專案時的原始音檔與支援的瀏覽器。'), { userFacing:true });
  }
  $('loading-title').textContent = '正在繪製聲音的輪廓';
  const peaks = buffer.peaks || await makePeaks(buffer, progress => { if (token === loadToken) $('loading-detail').textContent = `波形準備中 ${Math.round(progress * 100)}%`; });
  if (token !== loadToken) { buffer.dispose?.(); return; }
  engine.buffer = buffer; engine.loadingSource = null; fileName = name; cursor = 0; selection = [0, buffer.length];
  keptRanges = [[0, buffer.length]]; pendingDeletions = [];
  history.reset(captureState()); savedSignature = contentSignature(ranges(), 0);
  $('file-name').textContent = name;
  $('file-meta').textContent = `${buffer.numberOfChannels === 1 ? '單聲道' : '雙聲道'} · 44.1 kHz${bytes ? ` · ${(bytes / 1024 / 1024).toFixed(1)} MB` : ' · 示範音訊'}`;
  $('original-duration').textContent = formatTime(buffer.duration);
  $('export-name').value = `${name.replace(/\.[^.]+$/, '')}-剪輯`;
  $('join-fade').value = '0';
  $('zoom').value = 1; $('zoom-value').textContent = '1×'; $('wave-scroll').value = 0; $('scroll-label').hidden = true;
  wave.setAudio(buffer, peaks);
  if (project) restoreProjectState(project);
  isLoading = false; $('loading').hidden = true; $('import-area').hidden = true; $('workspace').hidden = false; $('features').hidden = true;
  document.body.classList.add('has-audio');
  loadFallback?.buffer.dispose?.(); loadFallback = null;
  projects.activate(source); cancelRestore();
  $('workspace').after($('draft-panel'));
  $('draft-panel').open = false;
  render();
  if (project) notify('剪輯與復原紀錄已還原。已建立新的工作備份，原備份仍保留；可繼續剪輯或重新匯出。');
}
function beginLoading() {
  identityController?.abort(); identityController = null;
  wave.cancelDrag(); pendingEdit = null;
  pause(); cancelExport(false); revokeDownload(); clearNotice();
  if (engine.buffer) loadFallback = { buffer:engine.buffer, peaks:wave.peaks, project:projects.project(), id:projects.id, savedSignature, meta:$('file-meta').textContent };
  projects.suspend(); engine.buffer = null; engine.release();
  keptRanges = []; pendingDeletions = []; selection = [0,0]; cursor = 0;
  history.reset(captureState()); isLoading = true;
  $('workspace').hidden = true; $('import-area').hidden = true; $('features').hidden = true; $('loading').hidden = false;
  $('loading-title').textContent = '正在讀取音檔'; $('loading-detail').textContent = '正在解碼，請稍候。音檔不會上傳。';
  return ++loadToken;
}
function returnToImport() {
  $('import-area').before($('draft-panel'));
  document.body.classList.remove('has-audio');
  $('loading').hidden = true; $('workspace').hidden = true; $('import-area').hidden = false; $('features').hidden = false;
}
async function importFile(file) {
  if (!file) return;
  if (!file.size) { notify('這個檔案是空的，請選擇包含音訊的檔案。', true); return; }
  if (file.size > MAX_BYTES) { notify('檔案超過 400 MB，請先縮短音檔或轉換為 MP3。', true); return; }
  if (!/\.(mp3|wav)$/i.test(file.name)) { notify('目前支援 MP3 與 WAV，請選擇這兩種格式的音檔。', true); return; }
  const project = restoreRequest;
  if (project && file.size !== project.source.size) { notify(`這不是專案的原始音檔，請重新選擇「${project.source.name}」。`, true); return; }
  if (!(await confirmReplacement())) return;
  await projects.flush();
  const token = beginLoading();
  try {
    $('loading-title').textContent = project ? '正在核對專案原檔' : '正在準備音檔';
    const controller = new AbortController(); identityController = controller;
    const source = await identifySource(file, { signal:controller.signal, onProgress:progress => {
      if (token === loadToken) $('loading-detail').textContent = `${project ? '原檔核對' : '準備中'} ${Math.round(progress * 100)}% · 音檔只在此裝置處理，不會上傳。`;
    } });
    if (identityController === controller) identityController = null;
    if (project && !sameSource(project.source, source)) throw Object.assign(Error(`檔案內容與專案不同。請選擇原始音檔「${project.source.name}」，剪輯備份仍保留。`), { userFacing:true });
    const duration = await readDuration(file);
    if (token !== loadToken) return;
    // VBR MP3 metadata may be estimated; its worker enforces the decoded sample limit.
    if (!/\.mp3$/i.test(file.name) && duration > MAX_SECONDS + .01) throw new Error('請選擇 30 分鐘以內且包含音訊的檔案。');
    if (/\.mp3$/i.test(file.name)) {
      const storage = await checkStorage();
      if (token !== loadToken) return;
      $('storage-status').textContent = `${storage.label} · 解碼期間仍可能因實際配額不足而停止`;
    }
    const buffer = await engine.decode(file, { duration, onProgress(progress, phase) {
      if (token === loadToken) { setText($('loading-title'), phase); setText($('loading-detail'), `${Math.round(progress * 100)}% · 音檔只在此裝置處理，可隨時取消。`); }
    } });
    await acceptBuffer(buffer, file.name, file.size, token, source, project);
  } catch (error) {
    if (token !== loadToken) return;
    identityController = null;
    recoverPreviousLoad();
    notify(error.userFacing ? `無法讀取音檔：${error.message}` : error.message.includes('第一版') || error.message.includes('30 分鐘') ? error.message : '無法讀取這個音檔。可能已損毀、編碼不受支援，或裝置記憶體不足。請嘗試較短的 MP3 或 WAV。', true, 'audio-import');
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
async function demo(project = null) {
  if (!(await confirmReplacement())) return;
  await projects.flush();
  const token = beginLoading();
  try { await acceptBuffer(createDemo(), '午後練習曲.wav', 0, token, { kind:'demo', name:'午後練習曲.wav', id:'afternoon-v1' }, project); }
  catch { if (token === loadToken) { recoverPreviousLoad(); notify('無法建立示範音訊，原有剪輯已保留，請重試。', true); } }
}

function clearExportProgress(job) {
  clearInterval(job.timer);
  $('export-progress').hidden = true;
  for (const id of ['export-eta', 'export-elapsed', 'export-speed']) $(id).textContent = '';
}
function cancelExport(showNotice = true) {
  exportPreparation = null;
  if (!exportJob) return;
  clearExportProgress(exportJob);
  exportJob.worker.terminate(); removeExportFile(exportJob.cacheName); exportJob = null; updateButtons();
  if (showNotice) notify('已取消匯出，剪輯內容仍然保留。');
}
async function exportAudio() {
  if (!engine.buffer || !totalFrames(ranges()) || exportJob || exportPreparation) return;
  const preparation = { buffer:engine.buffer, parts:signature(outputRanges()), token:loadToken, format:document.querySelector('[name="format"]:checked').value };
  exportPreparation = preparation; clearNotice(); revokeDownload(); updateButtons();
  try {
    const storage = await checkStorage(exportBytes(totalFrames(outputRanges()), engine.buffer.numberOfChannels, preparation.format));
    if (exportPreparation !== preparation || preparation.token !== loadToken) return;
    $('storage-status').textContent = `${storage.label} · 容量為估計值`;
  } catch (error) {
    if (exportPreparation === preparation) notify(error.message, true, 'storage-preflight');
    return;
  } finally { if (exportPreparation === preparation) { exportPreparation = null; updateButtons(); } }
  if (preparation.token !== loadToken || preparation.parts !== signature(outputRanges()) || preparation.format !== document.querySelector('[name="format"]:checked').value) { notify('剪輯或格式已變更，請再按一次匯出。'); return; }
  if (pendingDeletions.length) applyPendingDeletions();
  if (!totalFrames(ranges())) return;
  clearNotice(); revokeDownload();
  const format = document.querySelector('[name="format"]:checked').value;
  const parts = structuredClone(ranges());
  const fadeMs = Number($('join-fade').value), fadeFrames = Math.round(fadeMs * SAMPLE_RATE / 1000);
  const buffer = engine.buffer;
  const frames = totalFrames(parts);
  const name = ($('export-name').value.trim().replace(/[<>:"/\\|?*\u0000-\u001f]/g, '_').replace(/\.(mp3|wav)$/i, '') || '我的剪輯') + `.${format}`;
  let worker;
  try { worker = new Worker(new URL('./export-worker.js', import.meta.url)); }
  catch { notify('瀏覽器無法啟動匯出處理，請透過網站連結或本機伺服器開啟，並重試。', true); return; }
  const exportId = `out-${crypto.randomUUID()}`;
  const job = { worker, cacheName:`${exportId}.${format}`, signature: contentSignature(parts, fadeMs), token: loadToken, startedAt: performance.now(), finishing: false };
  exportJob = job;
  let partIndex = 0, frame = parts[0][0], lastProgress = -1;
  const estimate = new ExportEstimate(frames);
  function renderExportProgress() {
    if (exportJob !== job) return;
    const now = performance.now(), metrics = estimate.metrics(now, buffer.sampleRate);
    setText($('export-elapsed'), formatElapsed((now - job.startedAt) / 1000));
    setText($('export-speed'), job.finishing ? '—' : formatSpeed(metrics.speed));
    setText($('export-eta'), job.finishing ? '最後寫入中…' : formatRemaining(metrics.remaining));
  }
  renderExportProgress();
  job.timer = setInterval(renderExportProgress, 500);
  $('export-progress').hidden = false; $('progress-bar').value = 0; $('export-status').textContent = '正在準備匯出…'; updateButtons();
  function fail(message) {
    if (exportJob !== job) return;
    cancelExport(false); notify(message || '匯出失敗，請重試或改用 WAV。', true, 'audio-export');
  }
  async function pump() {
    if (exportJob !== job) return;
    if (partIndex >= parts.length) { job.finishing = true; $('export-status').textContent = '正在完成檔案…'; renderExportProgress(); worker.postMessage({ type: 'finish' }); return; }
    try {
      const end = Math.min(parts[partIndex][1], frame + 73728);
      const data = buffer.readChannels ? await buffer.readChannels(frame, end) : Array.from({ length: buffer.numberOfChannels }, (_, channel) => buffer.getChannelData(channel).slice(frame, end));
      if (exportJob !== job) return;
      applyJoinFades(data, frame, parts, fadeFrames);
      const chunks = data.map(channel => channel.buffer);
      worker.postMessage({ type: 'chunk', channels: chunks }, chunks);
      frame = end;
      if (frame >= parts[partIndex][1]) { partIndex++; frame = parts[partIndex]?.[0] ?? 0; }
    } catch (error) { fail(error.userFacing ? error.message : '無法讀取匯出音訊，請重新選入音檔。'); }
  }
  worker.onmessage = ({ data }) => {
    if (exportJob !== job) return;
    if (data.type === 'ready') { estimate.start(performance.now()); pump(); }
    else if (data.type === 'progress') {
      const progress = Math.min(99, Math.floor(data.processed / frames * 100));
      estimate.sample(data.processed, performance.now());
      if (lastProgress !== progress) {
        lastProgress = progress;
        $('progress-bar').value = progress; $('export-status').textContent = `正在匯出 ${format.toUpperCase()}… ${progress}%`;
      }
      // Yield to paint and input before handing the next chunk to the worker.
      setTimeout(pump, 0);
    } else if (data.type === 'complete') {
      const result = exportResult({ frames, sampleRate: buffer.sampleRate, elapsedMs: performance.now() - job.startedAt, bytes: data.blob.size });
      clearExportProgress(job); exportJob = null;
      if (job.token !== loadToken) { worker.terminate(); removeExportFile(job.cacheName); return; }
      // Retain only the idle Worker's lock and disk-backed File for re-download.
      // Revoking the download retires its Worker and schedules temporary-file cleanup.
      downloadResource = { worker, cacheName:job.cacheName };
      savedSignature = job.signature;
      const stale = contentSignature(outputRanges()) !== job.signature;
      $('result-version-note').hidden = !stale;
      downloadURL = URL.createObjectURL(data.blob);
      const link = $('download-link'); link.href = downloadURL; link.download = name; link.hidden = false;
      $('result-name').textContent = name;
      $('result-elapsed').textContent = result.elapsed;
      $('result-speed').textContent = result.speed;
      $('result-size').textContent = result.size;
      $('result-size').title = `${data.blob.size.toLocaleString('zh-TW')} 位元組`;
      exportPreview = { junctions:exportJunctions(parts, buffer.sampleRate), duration:frames / buffer.sampleRate, selected:-1, renderedSelection:-1 };
      renderExportJunctions();
      $('result-audio').src = downloadURL;
      $('export-result').hidden = false;
      updateButtons(); notify(stale ? '匯出完成，但使用的是匯出開始時的剪輯。之後的修改尚未套用，請重新匯出最新版本。' : '匯出完成！可先預聽產出的音檔並查看結果，再按「下載音檔」。');
    } else if (data.type === 'error') fail(data.message);
  };
  worker.onerror = event => { event.preventDefault(); fail('匯出元件載入失敗，請確認網站資源完整後重試。'); };
  worker.onmessageerror = () => fail('音訊資料傳送失敗，請重試。');
  worker.postMessage({ type: 'init', exportId, format, sampleRate: buffer.sampleRate, channels: buffer.numberOfChannels, frames });
}

$('choose-file').addEventListener('click', () => $('file-input').click());
$('replace-file').addEventListener('click', () => $('file-input').click());
$('file-input').addEventListener('change', event => { const file = event.target.files[0]; event.target.value = ''; importFile(file); });
$('load-demo').addEventListener('click', () => demo());
$('restore-source').addEventListener('click', () => $('file-input').click());
$('cancel-restore').addEventListener('click', cancelRestore);
$('cancel-load').addEventListener('click', () => { loadToken++; identityController?.abort(); identityController = null; const recovered = recoverPreviousLoad(); notify(recovered ? '已取消載入，原本的剪輯仍然保留。' : '已取消載入。'); });
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
$('preview-selection').addEventListener('click', () => { if (applyTimeFields()) startPlayback(intersect(ranges(), selection), selection[0], null, { processCuts:false }); });
$('join-fade').addEventListener('change', () => { pause(); revokeDownload(); projects.schedule(); notify('已更新接點處理，預聽剪輯結果與下次匯出會使用相同設定。'); });
$('zoom').addEventListener('input', event => {
  wave.zoom = Number(event.target.value); $('zoom-value').textContent = `${wave.zoom}×`; $('scroll-label').hidden = wave.zoom === 1; wave.draw();
  projects.schedule();
});
$('wave-scroll').addEventListener('input', event => { wave.scroll = Number(event.target.value) / 1000; wave.draw(); projects.schedule(); });
document.querySelectorAll('[name="format"]').forEach(input => input.addEventListener('change', () => {
  $('format-detail').textContent = input.value === 'mp3' ? '192 kbps · 44.1 kHz' : '16-bit PCM · 44.1 kHz';
  projects.schedule();
}));
$('export-name').addEventListener('input', () => projects.schedule());
for (const id of ['result-junction-before', 'result-junction-after']) $(id).addEventListener('change', () => projects.schedule());
$('export-button').addEventListener('click', exportAudio);
$('cancel-export').addEventListener('click', () => cancelExport());
$('result-audio').addEventListener('play', () => {
  if (!$('result-audio').paused) pause({ keepExportPreview:true });
});
$('result-audio').addEventListener('error', () => {
  updateExportPreviewPosition();
  if (downloadURL && $('result-audio').error) $('result-audio-error').hidden = false;
});
for (const type of ['loadedmetadata', 'durationchange', 'timeupdate', 'emptied']) {
  $('result-audio').addEventListener(type, updateExportPreviewPosition);
}
$('result-junction-previous').addEventListener('click', () => stepExportJunction('previous'));
$('result-junction-next').addEventListener('click', () => stepExportJunction('next'));
$('result-junction-loop').addEventListener('click', () => {
  if (exportAudition.looping) { exportAudition.stop({ pause:true }); return; }
  if (exportPreview?.selected >= 0) {
    const context = exportPreviewContext(), preview = $('result-audio');
    const window = context && junctionWindow(exportPreview.junctions[exportPreview.selected], context.before, context.after, preview.duration);
    if (window) exportAudition.start(window, { loop:true });
  }
});
for (const id of ['result-junction-before', 'result-junction-after']) {
  $(id).addEventListener('change', changeExportPreviewContext);
  $(id).addEventListener('keydown', event => { if (event.key === 'Enter') event.currentTarget.blur(); });
}
$('result-audio-seek').addEventListener('input', event => {
  const preview = $('result-audio');
  if (Number.isFinite(preview.duration) && preview.duration > 0 && !preview.error) {
    exportAudition.stop();
    if (exportPreview) exportPreview.selected = -1;
    preview.currentTime = Math.max(0, Math.min(preview.duration, Number(event.target.value)));
    updateExportPreviewPosition();
  }
});
document.querySelector('.result-preview').addEventListener('keydown', event => {
  if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey || event.shiftKey ||
      event.target.isContentEditable || event.target.closest('input:not([type="range"]), textarea, select') ||
      $('export-result').hidden || !exportPreview) return;
  const target = { '[':'result-junction-previous', ']':'result-junction-next', 'l':'result-junction-loop' }[event.key.toLowerCase()];
  if (!target) return;
  event.preventDefault();
  if (!event.repeat) $(target).click();
});
document.addEventListener('keydown', event => {
  if (!engine.buffer || isLoading || document.querySelector('dialog[open]') || event.isComposing || event.target.isContentEditable || event.target.closest('input, textarea, select, audio, .result-preview')) return;
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
window.addEventListener('pagehide', event => { cancelExport(false); pause(); if (!event.persisted) { identityController?.abort(); revokeDownload(); engine.release(); loadFallback?.buffer.dispose?.(); loadFallback = null; engine.context?.close(); } });

// Render is entirely local: no analytics, fetch of audio, or account is required.
window.dispatchEvent(new Event('audio-cutter-ready'));

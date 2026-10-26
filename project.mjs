import { SAMPLE_RATE, MAX_BYTES, MAX_SECONDS, signature } from './core.mjs';

export const PROJECT_LIMIT = 8 * 1024 * 1024;
const fail = () => {
  throw new Error('專案內容不完整或格式不受支援，請選擇由音剪儲存的專案檔。');
};
const integer = (value, min, max) => Number.isSafeInteger(value) && value >= min && value <= max;
const text = (value, max) => typeof value === 'string' && value.length <= max;

export function validateProject(value) {
  if (!value || value.app !== 'yin-jian' || value.version !== 1) fail();
  const { source, audio, state, history, preferences } = value;
  if (
    !audio ||
    audio.sampleRate !== SAMPLE_RATE ||
    !integer(audio.length, 1, SAMPLE_RATE * MAX_SECONDS + 441) ||
    ![1, 2].includes(audio.channels)
  )
    fail();
  if (!source || !text(source.name, 255)) fail();
  if (source.kind === 'file') {
    if (
      !integer(source.size, 1, MAX_BYTES) ||
      source.algorithm !== 'chunk-sha256-v1' ||
      !/^[a-f0-9]{64}$/.test(source.fingerprint)
    )
      fail();
  } else if (source.kind !== 'demo' || source.id !== 'afternoon-v1') fail();
  let budget = 200000;
  function intervals(parts) {
    if (!Array.isArray(parts) || parts.length > 10000 || (budget -= parts.length) < 0) fail();
    let previous = -1;
    return parts.map((part) => {
      if (
        !Array.isArray(part) ||
        part.length !== 2 ||
        !integer(part[0], 0, audio.length) ||
        !integer(part[1], part[0] + 1, audio.length) ||
        part[0] <= previous
      )
        fail();
      previous = part[1];
      return [...part];
    });
  }
  function snapshot(item) {
    if (
      !item ||
      !Array.isArray(item.selection) ||
      item.selection.length !== 2 ||
      !integer(item.selection[0], 0, audio.length) ||
      !integer(item.selection[1], item.selection[0], audio.length) ||
      !integer(item.cursor, 0, audio.length)
    )
      fail();
    const ranges = intervals(item.ranges),
      pending = intervals(item.pending);
    let index = 0;
    for (const [a, b] of pending) {
      while (ranges[index] && ranges[index][1] <= a) index++;
      if (!ranges[index] || a < ranges[index][0] || b > ranges[index][1]) fail();
    }
    return { ranges, pending, selection: [...item.selection], cursor: item.cursor };
  }
  const current = snapshot(state);
  if (
    !history ||
    !Array.isArray(history.states) ||
    !integer(history.states.length, 1, 100) ||
    !integer(history.index, 0, history.states.length - 1)
  )
    fail();
  const states = history.states.map(snapshot);
  if (
    signature([states[history.index].ranges, states[history.index].pending]) !==
    signature([current.ranges, current.pending])
  )
    fail();
  const view = preferences?.view;
  if (
    !preferences ||
    !text(preferences.name, 120) ||
    !['mp3', 'wav'].includes(preferences.format) ||
    !view ||
    !integer(view.zoom, 1, 64) ||
    !Number.isFinite(view.scroll) ||
    view.scroll < 0 ||
    view.scroll > 1 ||
    !['move', 'start', 'end'].includes(view.mode)
  )
    fail();
  const context = preferences.context;
  const fadeMs = preferences.fadeMs ?? 0;
  if (![0, 5, 10].includes(fadeMs)) fail();
  if (
    !context ||
    ![context.before, context.after].every((n) => Number.isFinite(n) && n >= 0 && n <= 30) ||
    context.before + context.after <= 0
  )
    fail();
  return {
    app: 'yin-jian',
    version: 1,
    source:
      source.kind === 'file'
        ? {
            kind: 'file',
            name: source.name,
            size: source.size,
            algorithm: source.algorithm,
            fingerprint: source.fingerprint,
          }
        : { kind: 'demo', name: source.name, id: source.id },
    audio: { sampleRate: SAMPLE_RATE, length: audio.length, channels: audio.channels },
    state: current,
    history: { states, index: history.index },
    preferences: {
      fadeMs,
      name: preferences.name,
      format: preferences.format,
      view: { zoom: view.zoom, scroll: view.scroll, mode: view.mode },
      context: { before: context.before, after: context.after },
    },
  };
}

export function parseProject(text) {
  if (typeof text !== 'string' || new TextEncoder().encode(text).length > PROJECT_LIMIT)
    throw new Error('專案檔過大，請選擇 8 MB 以內的音剪專案。');
  try {
    return validateProject(JSON.parse(text));
  } catch (error) {
    if (error instanceof SyntaxError) fail();
    throw error;
  }
}

// Hash every byte in bounded blocks. No complete-file ArrayBuffer is allocated.
export async function fingerprintFile(file, { cancelled = () => false, onProgress = () => {} } = {}) {
  const batch = 1024 * 1024,
    count = Math.ceil(file.size / batch);
  if (!file.size || file.size > MAX_BYTES) throw new Error('請選擇 400 MB 以內且包含音訊的原檔。');
  const hashes = new Uint8Array(16 + count * 32);
  const header = new DataView(hashes.buffer);
  header.setBigUint64(0, BigInt(file.size));
  header.setUint32(8, batch);
  header.setUint32(12, count);
  for (let i = 0; i < count; i++) {
    if (cancelled()) throw new DOMException('已取消檔案核對', 'AbortError');
    const bytes = await file.slice(i * batch, Math.min(file.size, (i + 1) * batch)).arrayBuffer();
    hashes.set(new Uint8Array(await crypto.subtle.digest('SHA-256', bytes)), 16 + i * 32);
    onProgress((i + 1) / count);
  }
  if (cancelled()) throw new DOMException('已取消檔案核對', 'AbortError');
  const hash = new Uint8Array(await crypto.subtle.digest('SHA-256', hashes));
  return {
    kind: 'file',
    name: file.name,
    size: file.size,
    algorithm: 'chunk-sha256-v1',
    fingerprint: Array.from(hash, (byte) => byte.toString(16).padStart(2, '0')).join(''),
  };
}

export const sameSource = (expected, actual) =>
  expected.kind === actual.kind &&
  (expected.kind === 'demo'
    ? expected.id === actual.id
    : expected.size === actual.size &&
      expected.algorithm === actual.algorithm &&
      expected.fingerprint === actual.fingerprint);

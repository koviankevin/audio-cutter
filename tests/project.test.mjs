import test from 'node:test';
import assert from 'node:assert/strict';
import { validateProject, parseProject, fingerprintFile, sameSource } from '../project.mjs';
import { checkStorage, exportBytes } from '../storage-check.mjs';
import { History } from '../core.mjs';

const state = () => ({
  ranges: [
    [0, 100],
    [200, 1000],
  ],
  pending: [[250, 300]],
  selection: [250, 300],
  cursor: 250,
});
const fixture = () => ({
  app: 'yin-jian',
  version: 1,
  source: { kind: 'demo', name: 'demo.wav', id: 'afternoon-v1' },
  audio: { sampleRate: 44100, length: 1000, channels: 2 },
  state: state(),
  history: { states: [state()], index: 0 },
  preferences: {
    fadeMs: 5,
    name: '我的剪輯',
    format: 'wav',
    view: { zoom: 4, scroll: 0.2, mode: 'start' },
    context: { before: 0.5, after: 2 },
  },
});

test('project roundtrip preserves sample intervals, undo/redo and settings, without audio payloads', () => {
  const value = fixture(),
    history = new History(value.state);
  history.commit({ ...state(), pending: [[250, 301]] });
  history.undo();
  value.history = { states: history.states, index: history.index };
  value.audio.pcm = new Uint8Array(32);
  value.source.path = 'private path';
  const restored = parseProject(JSON.stringify(value));
  assert.deepEqual(restored.state, state());
  assert.deepEqual(restored.preferences, value.preferences);
  const redo = new History(restored.state);
  Object.assign(redo, restored.history);
  assert.deepEqual(redo.redo().pending, [[250, 301]]);
  assert.equal('pcm' in restored.audio, false);
  assert.equal('path' in restored.source, false);
});

test('untrusted projects reject malformed intervals, audio mismatches, history and unsupported versions', () => {
  for (const mutate of [
    (p) => (p.version = 2),
    (p) => (p.audio.length = 44100 * 1801),
    (p) => (p.audio.channels = 6),
    (p) => (p.state.pending = [[90, 250]]),
    (p) =>
      (p.state.ranges = [
        [200, 400],
        [300, 500],
      ]),
    (p) => (p.state.cursor = NaN),
    (p) => (p.history.index = 100),
    (p) => (p.history.states[0].pending = []),
    (p) => (p.state.selection = [400, 300]),
    (p) => (p.preferences.view.scroll = Infinity),
    (p) => (p.preferences.context = { before: 0, after: 0 }),
    (p) => (p.source.kind = 'unknown'),
  ]) {
    const project = fixture();
    mutate(project);
    assert.throws(() => validateProject(project));
  }
  assert.throws(() => parseProject('{broken'));
  assert.throws(() => parseProject(' '.repeat(8 * 1024 * 1024 + 1)), /8 MB/);
});

test('version-one projects saved before optional join processing default to unchanged audio', () => {
  const project = fixture();
  delete project.preferences.fadeMs;
  assert.equal(validateProject(project).preferences.fadeMs, 0);
  project.preferences.fadeMs = 90;
  assert.throws(() => validateProject(project));
});

test('fingerprints inspect all file bytes in bounded blocks and accept renamed identical sources', async () => {
  const bytes = new Uint8Array(3 * 1024 * 1024 + 20);
  bytes[1500000] = 70;
  const file = new File([bytes], 'original.wav'),
    reads = [];
  const slice = file.slice.bind(file);
  file.arrayBuffer = () => {
    throw Error('whole-file read');
  };
  file.slice = (start, end) => {
    reads.push(end - start);
    return slice(start, end);
  };
  const original = await fingerprintFile(file);
  assert.ok(reads.every((size) => size <= 1024 * 1024));
  assert.equal(
    reads.reduce((a, b) => a + b),
    file.size,
  );
  assert.equal(sameSource(original, await fingerprintFile(new File([bytes], 'renamed.wav'))), true);
  bytes[1500000] ^= 1;
  assert.equal(sameSource(original, await fingerprintFile(new File([bytes], 'original.wav'))), false);
  let count = 0;
  await assert.rejects(fingerprintFile(file, { cancelled: () => count > 0, onProgress: () => count++ }), {
    name: 'AbortError',
  });
  assert.equal(count, 1);
});

test('storage preflight reports usable capacity and rejects unavailable or insufficient storage', async () => {
  const browser = (quota, usage) => ({
    locks: {},
    storage: { getDirectory: async () => ({}), estimate: async () => ({ quota, usage }) },
  });
  assert.equal(exportBytes(44100, 2, 'wav'), 176444);
  const result = await checkStorage(200000, browser(5 * 1024 * 1024, 100));
  assert.equal(result.available, 5 * 1024 * 1024 - 100);
  await assert.rejects(checkStorage(200000, browser(200000, 0)), /空間不足/);
  await assert.rejects(checkStorage(0, {}), /Chrome/);
  await assert.rejects(
    checkStorage(0, {
      locks: {},
      storage: {
        getDirectory: async () => {
          throw Error('denied');
        },
      },
    }),
    /儲存設定/,
  );
  assert.equal((await checkStorage(200000, browser(undefined, undefined))).available, null);
});

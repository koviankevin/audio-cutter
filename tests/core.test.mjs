import test from 'node:test';
import assert from 'node:assert/strict';
import { normalize, subtract, subtractMany, intersect, junctionPreview, deletedRanges, totalFrames, frameAtOffset, parseTime, formatTime, History } from '../core.mjs';
import { floatToInt16, interleavePCM, wavHeader } from '../pcm.mjs';
// Keep the existing CI entry point inclusive of the streaming audio regressions.
import './stream-core.test.mjs';
import './export-store.test.mjs';
import './export-progress.test.mjs';
import './export-junctions.test.mjs';
import './media-window.test.mjs';
import './project.test.mjs';

test('trimming head/tail and deleting a middle section keep chronological intervals', () => {
  assert.deepEqual(intersect([[0,100]], [20,80]), [[20,80]]);
  assert.deepEqual(subtract([[0,100]], [20,40]), [[0,20],[40,100]]);
  const edited = subtract(subtract([[0,100]], [20,40]), [60,80]);
  assert.deepEqual(edited, [[0,20],[40,60],[80,100]]);
  assert.equal(totalFrames(edited), 60);
  assert.deepEqual(intersect(edited,[10,90]), [[10,20],[40,60],[80,90]]);
  assert.deepEqual(deletedRanges(edited,100), [[20,40],[60,80]]);
});
test('selection crossing deleted gaps never resurrects deleted samples', () => {
  const parts = [[0,20],[40,60],[80,100]];
  assert.deepEqual(intersect(parts,[15,85]), [[15,20],[40,60],[80,85]]);
  assert.deepEqual(subtract(parts,[10,90]), [[0,10],[90,100]]);
  assert.deepEqual(subtract(parts,[20,40]), parts);
  assert.deepEqual(subtract(parts,[10,10]), parts);
  assert.deepEqual(subtract(parts,[0,100]), []);
  assert.deepEqual(intersect(parts,[20,40]), []);
});

test('bulk deletion merges unordered overlapping and duplicate ranges without double counting', () => {
  const original = [[0,100]];
  const removals = [[60,80],[20,35],[30,40],[20,35],[40,45]];
  const result = subtractMany(original, removals);
  assert.deepEqual(result, [[0,20],[45,60],[80,100]]);
  assert.equal(totalFrames(result),55);
  assert.deepEqual(original, [[0,100]]);
  assert.deepEqual(removals, [[60,80],[20,35],[30,40],[20,35],[40,45]]);
  assert.deepEqual(subtractMany([[0,20],[40,60],[80,100]], [[10,50],[55,90]]), [[0,10],[50,55],[90,100]]);
  assert.deepEqual(subtractMany(original, [[0,100]]), []);
  assert.deepEqual(subtractMany(original, []), original);
  assert.deepEqual(subtractMany([], [[0,100]]), []);
});

test('bulk deletion agrees with sequential cuts across seeded random gaps and sample boundaries', () => {
  let seed = 71219;
  const random = max => { seed = (Math.imul(seed,1664525)+1013904223) >>> 0; return seed % max; };
  for (let trial = 0; trial < 200; trial++) {
    const ranges = normalize(Array.from({length:20},()=>{const a=random(200);return [a,a+1+random(15)];}),220);
    const removals = Array.from({length:25},()=>{const a=random(240)-10;return [a,a+random(30)];});
    const expected = normalize(removals,ranges.at(-1)?.[1]??0).reduce((kept,cut)=>subtract(kept,cut),structuredClone(ranges));
    assert.deepEqual(subtractMany(ranges,removals),expected);
  }
});

test('junction preview takes retained context across every pending and committed cut', () => {
  const source = [[0,100]], removals = [[20,40],[45,50],[55,80]];
  const kept = subtractMany(source, removals), original = structuredClone(kept);
  assert.deepEqual(junctionPreview(kept,[20,40],15), {
    parts:[[5,20],[40,45],[50,55],[80,85]], beforeFrames:15, afterFrames:15,
  });
  assert.deepEqual(junctionPreview(kept,[55,80],15), {
    parts:[[15,20],[40,45],[50,55],[80,95]], beforeFrames:15, afterFrames:15,
  });
  assert.deepEqual(kept,original,'preview does not mutate the export timeline');
  assert.equal(totalFrames(junctionPreview(kept,[20,40],15).parts),30);
});

test('junction preview handles short context, head, tail and complete deletion', () => {
  assert.deepEqual(junctionPreview([[40,100]],[0,40],15), {parts:[[40,55]],beforeFrames:0,afterFrames:15});
  assert.deepEqual(junctionPreview([[0,20]],[20,100],15), {parts:[[5,20]],beforeFrames:15,afterFrames:0});
  assert.deepEqual(junctionPreview([[0,5],[95,100]],[5,95],15), {parts:[[0,5],[95,100]],beforeFrames:5,afterFrames:5});
  assert.deepEqual(junctionPreview([],[0,100],15), {parts:[],beforeFrames:0,afterFrames:0});
});

test('bulk deletion is one undoable operation including sample boundaries', () => {
  const history = new History([[0,441000]]);
  history.commit(subtractMany(history.current, [[88200,176400],[264600,352800]]));
  assert.deepEqual(history.current, [[0,88200],[176400,264600],[352800,441000]]);
  assert.deepEqual(history.undo(), [[0,441000]]);
  assert.equal(history.canUndo, false);
  assert.deepEqual(history.redo(), [[0,88200],[176400,264600],[352800,441000]]);
});
test('normalization and playback offset mapping respect exact sample boundaries', () => {
  assert.deepEqual(normalize([[10,20],[0,10],[30,120],[-3,2],[NaN,2]],100), [[0,20],[30,100]]);
  assert.equal(frameAtOffset([[0,10],[30,40]],9),9);
  assert.equal(frameAtOffset([[0,10],[30,40]],10),30);
  assert.equal(frameAtOffset([[0,10],[30,40]],20),40);
  assert.equal(frameAtOffset([],0),0);
});
test('undo/redo restores exact states, reset remains undoable and branching discards redo', () => {
  const history = new History([[0,100]]);
  history.commit([[10,90]]); history.commit([[10,20],[40,90]]);
  assert.deepEqual(history.undo(),[[10,90]]);
  assert.deepEqual(history.redo(),[[10,20],[40,90]]);
  history.commit([[0,100]]); assert.deepEqual(history.undo(),[[10,20],[40,90]]);
  history.commit([]); assert.equal(history.canRedo,false); assert.deepEqual(history.undo(),[[10,20],[40,90]]);
  history.reset([[0,50]]); assert.equal(history.canUndo,false); assert.equal(history.canRedo,false);
});
test('time parsing accepts milliseconds and seconds but rejects malformed times', () => {
  for (const [value,expected] of [['00:00.001',.001],['01:23.456',83.456],['29:59.999',1799.999],['2.5',2.5],['00:02.5',2.5]]) assert.equal(parseTime(value),expected);
  for (const value of ['','abc','-1','00:60','1:2','1:02.1234']) assert.ok(Number.isNaN(parseTime(value)));
  assert.equal(formatTime(59.9996),'01:00.000'); assert.equal(formatTime(1800),'30:00.000');
});

test('document history restores queued intervals, view state and merged edits as one step', () => {
  const original = { ranges:[[0,100]], pending:[[20,40],[60,80]], selection:[60,80], cursor:12 };
  const history = new History(original);
  const beforeMove = structuredClone(original); beforeMove.cursor = 18;
  const moved = { ...structuredClone(beforeMove), pending:[[30,50],[60,80]], selection:[30,50] };
  assert.equal(history.commit(moved,beforeMove),true);
  assert.deepEqual(history.undo(),beforeMove);
  assert.deepEqual(history.redo(),moved);
  const merged = { ...structuredClone(moved), pending:[[30,80]], selection:[30,80] };
  history.commit(merged);
  assert.deepEqual(history.undo(),moved);
  assert.deepEqual(history.redo(),merged);
  const applied = { ranges:[[0,30],[80,100]], pending:[], selection:[30,80], cursor:0 };
  history.commit(applied);
  assert.deepEqual(history.undo(),merged,'undoing batch deletion restores its queued markers');
  assert.deepEqual(history.redo(),applied);
  original.pending[0][0]=99; moved.pending[0][0]=99;
  assert.deepEqual(history.undo().pending,[[30,80]],'history snapshots must not alias live marker arrays');
});

test('history skips unchanged transitions, discards redo on a new branch, and stays bounded', () => {
  const history = new History({ ranges:[[0,1000]], pending:[] });
  history.commit({ ranges:[[0,1000]], pending:[[20,40]] });
  history.commit({ ranges:[[0,1000]], pending:[[30,50]] });
  history.undo();
  assert.equal(history.commit(structuredClone(history.current)),false);
  assert.equal(history.canRedo,true);
  history.commit({ ranges:[[0,1000]], pending:[[10,40]] });
  assert.equal(history.canRedo,false);
  for(let i=0;i<120;i++) history.commit({ ranges:[[0,1000]], pending:[[i,i+10]] });
  assert.equal(history.states.length,100);
  assert.equal(history.index,99);
  history.reset({ranges:[[0,500]],pending:[]});
  assert.equal(history.canUndo,false); assert.equal(history.canRedo,false);
});
test('16-bit conversion clips cleanly and WAV interleaves stereo in little endian', () => {
  assert.deepEqual([...floatToInt16(new Float32Array([-2,-1,0,1,2]))],[-32768,-32768,0,32767,32767]);
  const body = interleavePCM([new Float32Array([1,-1]),new Float32Array([.5,-.5])]);
  const view = new DataView(body.buffer);
  assert.deepEqual([0,2,4,6].map(offset=>view.getInt16(offset,true)),[32767,16384,-32768,-16384]);
  const header = wavHeader(2,2,44100); const info = new DataView(header.buffer);
  assert.equal(new TextDecoder().decode(header.slice(0,4)),'RIFF');
  assert.equal(info.getUint32(4,true),44); assert.equal(info.getUint16(22,true),2);
  assert.equal(info.getUint32(24,true),44100); assert.equal(info.getUint32(40,true),8);
  assert.throws(()=>wavHeader(0xffffffff,2,44100));
});

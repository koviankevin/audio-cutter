import assert from 'node:assert/strict';
import { mkdir, writeFile, readFile, open } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startServer } from '../scripts/serve.mjs';
import { wavHeader } from '../pcm.mjs';
import { parseTime } from '../core.mjs';

const modulePath = process.env.PLAYWRIGHT_MODULE;
const { chromium } = await import(modulePath ? pathToFileURL(modulePath).href : 'playwright');
const channel = process.env.BROWSER_CHANNEL;
const output = path.resolve('test-results', (channel || 'chromium') + (process.env.SITE_URL ? '-live' : ''));
await mkdir(output, { recursive: true });
const { server, url } = process.env.SITE_URL ? { server:null, url:process.env.SITE_URL } : await startServer({ port: 0, base: '/audio-cutter/' });
const browser = await chromium.launch({ headless: true, ...(channel ? { channel } : {}) });
const context = await browser.newContext({ viewport: { width: 1440, height: 1080 }, acceptDownloads: true });
const page = await context.newPage();
const errors = [], requests = [], blocked = new Set();
page.on('pageerror', error => errors.push(error.message));
context.on('request', request => requests.push({ url: request.url(), method: request.method(), resource: request.resourceType() }));
context.on('requestfailed', request => { if (/BLOCKED_BY_CSP/i.test(request.failure()?.errorText || '')) blocked.add(request.url()); });
page.on('dialog', dialog => dialog.accept());

async function waitFor(predicate, message) {
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) { if (await predicate()) return; await new Promise(resolve => setTimeout(resolve, 30)); }
  throw new Error(message);
}
async function select(start, end) {
  await page.locator('#selection-start').fill(String(start));
  await page.locator('#selection-end').fill(String(end));
  await page.locator('#selection-end').press('Enter');
}
async function exportFile(format) {
  await page.locator(`[name="format"][value="${format}"]`).check();
  const pending = page.waitForEvent('download');
  await page.locator('#export-button').click();
  const download = await pending; const target = path.join(output, `edited.${format}`);
  await download.saveAs(target); return target;
}
async function queuedTimes(index = 0) {
  return (await page.locator('#pending-list .pending-time').nth(index).textContent()).split(' — ').map(time => Math.round(parseTime(time) * 1000) / 1000);
}
async function holdArrow(key, count, { shift = false, during = async () => {} } = {}) {
  if (shift) await page.keyboard.down('Shift');
  for (let i = 0; i < count; i++) await page.keyboard.down(key);
  await during();
  await page.keyboard.up(key);
  if (shift) await page.keyboard.up('Shift');
}
async function dragBoundary(from, to, { zoom = 1, scroll = 0, cancel = '', during = () => {} } = {}) {
  const canvas = page.locator('#waveform'); await canvas.scrollIntoViewIfNeeded();
  const bounds = await canvas.boundingBox();
  const viewLength = 12 / zoom, viewStart = (12 - viewLength) * scroll;
  const x = seconds => bounds.x + (seconds - viewStart) / viewLength * bounds.width;
  const y = bounds.y + (31 + bounds.height - 24) / 2;
  await canvas.evaluate(element => element.addEventListener('pointerdown', event => { window.testPointerId = event.pointerId; }, { once:true }));
  await page.mouse.move(x(from), y); await page.mouse.down(); await page.mouse.move(x(to), y, { steps:8 });
  await during();
  if (cancel === 'escape') await page.keyboard.press('Escape');
  else if (cancel === 'pointercancel') await canvas.evaluate(element => element.dispatchEvent(new PointerEvent('pointercancel', { pointerId:window.testPointerId, bubbles:true })));
  await page.mouse.up();
}
const near = (actual, expected, message) => assert.ok(Math.abs(actual - expected) < .03, `${message}: ${actual} vs ${expected}`);
function peakAt(data, rate, seconds, frequency) {
  let real = 0, imaginary = 0; const count = Math.min(8192, data.length - Math.floor(seconds * rate));
  for (let i = 0; i < count; i++) {
    const value = data[Math.floor(seconds * rate) + i]; const angle = 2 * Math.PI * frequency * i / rate;
    real += value * Math.cos(angle); imaginary += value * Math.sin(angle);
  }
  return Math.hypot(real, imaginary) * 2 / count;
}
async function fixture(seconds = 12, channels = 2, name = 'three-tones.wav') {
  const rate = 44100, frames = Math.round(seconds * rate); const target = path.join(output, name);
  const file = await open(target, 'w');
  try {
    await file.write(wavHeader(frames, channels, rate));
    for (let start = 0; start < frames; start += 65536) {
      const end = Math.min(frames, start + 65536); const data = Buffer.alloc((end - start) * channels * 2);
      for (let i = start; i < end; i++) {
        const part = Math.min(2, Math.floor(i / rate / 4));
        for (let channel = 0; channel < channels; channel++) {
          const hz = [440,880,1320][part] + channel * 110;
          data.writeInt16LE(Math.round(Math.sin(2 * Math.PI * hz * i / rate) * 12000), ((i - start) * channels + channel) * 2);
        }
      }
      await file.write(data);
    }
  } finally { await file.close(); }
  return target;
}
async function decodeInfo(file) {
  const bytes = await readFile(file);
  return page.evaluate(async base64 => {
    const context = new AudioContext({ sampleRate: 44100 });
    try {
      const buffer = await context.decodeAudioData(Uint8Array.from(atob(base64), c=>c.charCodeAt(0)).buffer);
      const peak = (data, seconds, hz) => {
        let real=0,imaginary=0; const count=8192,start=Math.floor(seconds*44100);
        for(let i=0;i<count;i++){const angle=2*Math.PI*hz*i/44100; real+=data[start+i]*Math.cos(angle);imaginary+=data[start+i]*Math.sin(angle);}
        return Math.hypot(real,imaginary)*2/count;
      };
      return { duration: buffer.duration, channels: buffer.numberOfChannels, rate: buffer.sampleRate,
        tones: [[.4,440],[2.4,880],[5,1320]].map(([seconds,hz])=>({left:peak(buffer.getChannelData(0),seconds,hz),right:peak(buffer.getChannelData(1),seconds,hz+110),leak:peak(buffer.getChannelData(0),seconds,hz+110)})) };
    } finally { await context.close(); }
  }, bytes.toString('base64'));
}

try {
  await page.goto(url); assert.equal(await page.title(), '音剪 — 留下想聽的部分');
  console.log('Landing and synthetic fixture');
  await page.screenshot({ path: path.join(output, '01-landing.png'), fullPage: true });
  const source = await fixture();
  await page.locator('#file-input').setInputFiles(source);
  await page.locator('#workspace').waitFor({ state: 'visible', timeout: 20000 });
  assert.equal(await page.locator('#segment-count').textContent(),'1');
  assert.equal(await page.locator('#undo').isDisabled(),true,'a new file starts with empty history');
  await select(2,4); await page.locator('#add-deletion').click();
  await select(3,4); await page.locator('#add-deletion').click();
  assert.equal(await page.locator('#pending-count').textContent(),'1','overlapping ranges should merge');
  await select(2,4); await page.locator('#add-deletion').click();
  assert.equal(await page.locator('#pending-count').textContent(),'1','duplicate ranges should not add duration');
  await select(5,6); await page.locator('#add-deletion').click();
  await page.getByRole('button',{name:'移除待刪段落 2',exact:true}).click();
  await page.locator('#undo').click();
  assert.equal(await page.locator('#pending-count').textContent(),'2','undo restores a removed marker');
  await page.locator('#redo').click();
  assert.equal(await page.locator('#pending-count').textContent(),'1');
  await select(6,8); await page.locator('#add-deletion').click();
  assert.equal(await page.locator('#pending-count').textContent(),'2');
  assert.equal(await page.locator('#output-duration').textContent(),'00:08.000','show the projected export duration before applying the batch');
  assert.equal(await page.locator('#segment-count').textContent(),'1','queued selections must not delete audio yet');
  assert.equal(await page.locator('#undo').isEnabled(),true,'queue edits join the same history');
  assert.match(await page.locator('#pending-summary').textContent(),/00:04.000.*00:08.000/);
  await page.getByRole('button',{name:'選取待刪段落 1',exact:true}).click();
  await page.keyboard.press('ArrowRight');
  assert.deepEqual(await queuedTimes(),[2.01,4.01],'arrows move a selected marker by exactly 10ms');
  await page.keyboard.press('Shift+ArrowLeft');
  assert.deepEqual(await queuedTimes(),[1.91,3.91],'Shift increases the step to 100ms');
  assert.equal(await page.locator('#selection-duration').textContent(),'2.000 秒');
  await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z');
  await page.locator('[data-pending-mode="start"]').click();
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('Shift+ArrowLeft');
  assert.deepEqual(await queuedTimes(),[1.91,4],'start mode keeps the end fixed');
  await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z');
  await page.locator('[data-pending-mode="end"]').click();
  await page.keyboard.press('ArrowLeft'); await page.keyboard.press('Shift+ArrowRight');
  assert.deepEqual(await queuedTimes(),[2,4.09],'end mode keeps the start fixed');
  await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z');
  await page.locator('[data-pending-mode="move"]').click();
  await holdArrow('ArrowRight',3);
  assert.deepEqual(await queuedTimes(),[2.03,4.03]);
  await page.keyboard.press('Control+z'); assert.deepEqual(await queuedTimes(),[2,4],'a held key is one undo step');
  await page.keyboard.press('Control+y'); assert.deepEqual(await queuedTimes(),[2.03,4.03]);
  await page.keyboard.press('Control+z');
  await holdArrow('ArrowRight',2,{shift:true,during:async()=>page.keyboard.press('Escape')});
  assert.deepEqual(await queuedTimes(),[2,4],'Escape cancels keyboard adjustment');
  assert.equal(await page.locator('#redo').isEnabled(),true,'cancelled keyboard adjustment preserves redo');
  await page.keyboard.down('ArrowRight'); await page.locator('#export-name').focus(); await page.keyboard.up('ArrowRight');
  assert.deepEqual(await queuedTimes(),[2.01,4.01],'leaving the waveform commits a held adjustment');
  await page.keyboard.press('ArrowRight'); assert.deepEqual(await queuedTimes(),[2.01,4.01],'text input arrows do not edit markers');
  await page.locator('#waveform').focus(); await page.keyboard.press('Control+z');
  await holdArrow('ArrowRight',30,{shift:true});
  assert.equal(await page.locator('#pending-count').textContent(),'2','keyboard movement stops before a neighbor');
  assert.equal(await page.locator('#selection-duration').textContent(),'2.000 秒');
  near((await queuedTimes())[1],6,'neighbor movement boundary');
  await page.keyboard.press('Control+z');
  await holdArrow('ArrowLeft',30,{shift:true}); assert.deepEqual(await queuedTimes(),[0,2]);
  await page.keyboard.press('ArrowRight'); await page.keyboard.press('Control+z');
  await page.keyboard.press('ArrowLeft');
  assert.equal(await page.locator('#redo').isEnabled(),true,'a blocked nudge creates no history step');
  await page.keyboard.press('Control+y'); assert.deepEqual(await queuedTimes(),[.01,2.01]);
  await page.keyboard.press('Control+z'); await page.keyboard.press('Control+z');
  await page.locator('[data-pending-mode="start"]').click(); await holdArrow('ArrowRight',30,{shift:true});
  assert.equal(await page.locator('#selection-duration').textContent(),'0.001 秒','keyboard endpoints cannot cross');
  await page.keyboard.press('Control+z');
  await page.locator('[data-pending-mode="end"]').click();
  await holdArrow('ArrowRight',25,{shift:true,during:async()=>assert.equal(await page.locator('#pending-count').textContent(),'2')});
  assert.deepEqual(await queuedTimes(),[2,8],'overlapping keyboard resize merges only after release');
  await page.keyboard.press('Control+z'); assert.equal(await page.locator('#pending-count').textContent(),'2');
  await page.getByRole('button',{name:'選取待刪段落 2',exact:true}).click();
  await page.locator('[data-pending-mode="end"]').click(); await holdArrow('ArrowRight',50,{shift:true});
  assert.deepEqual(await queuedTimes(1),[6,12],'end clamps to file boundary');
  await page.keyboard.press('Control+z');
  await dragBoundary(2,2); assert.equal(await page.locator('[data-pending-mode="start"]').getAttribute('aria-pressed'),'true');
  await page.keyboard.press('ArrowLeft'); assert.deepEqual(await queuedTimes(),[1.99,4],'clicking a handle selects its keyboard mode');
  await page.keyboard.press('Control+z');
  await page.getByRole('button',{name:'選取待刪段落 1',exact:true}).click();
  await page.locator('#zoom').fill('8'); await page.locator('#zoom').dispatchEvent('input');
  await page.locator('#waveform').focus(); await page.keyboard.press('ArrowRight');
  assert.deepEqual(await queuedTimes(),[2.01,4.01],'keyboard step does not depend on zoom');
  await page.keyboard.press('Control+z');
  await page.locator('#zoom').fill('1'); await page.locator('#zoom').dispatchEvent('input');
  await page.screenshot({path:path.join(output,'07-keyboard-pending.png'),fullPage:true});
  await select(6,8);
  await dragBoundary(3,4,{during:async()=>{
    near((await queuedTimes())[0],3,'whole interval moves while dragging');
    near((await queuedTimes())[1],5,'whole interval end moves with its start');
    assert.equal(await page.locator('#selection-duration').textContent(),'2.000 秒','movement preserves length');
    assert.equal(await page.locator('#output-duration').textContent(),'00:08.000');
    assert.equal(await page.locator('#waveform').getAttribute('data-cursor'),'move');
  }});
  assert.deepEqual(await queuedTimes(1),[6,8],'moving one interval leaves the other unchanged');
  const movedState = await queuedTimes();
  await page.keyboard.press('Control+z');
  assert.deepEqual(await queuedTimes(),[2,4],'one Ctrl+Z undoes the entire move');
  assert.equal(await page.locator('#selection-start').inputValue(),'00:06.000','undo restores the previous selection');
  await page.keyboard.press('Control+Shift+Z');
  assert.deepEqual(await queuedTimes(),movedState,'Ctrl+Shift+Z redoes the move');
  await page.keyboard.press('Control+z');
  await dragBoundary(2,2);
  assert.equal(await page.locator('#redo').isEnabled(),true,'a click without movement preserves redo');
  await dragBoundary(3,4,{cancel:'escape'});
  assert.deepEqual(await queuedTimes(),[2,4]);
  assert.equal(await page.locator('#redo').isEnabled(),true,'Escape creates no history entry');
  await dragBoundary(3,4,{cancel:'pointercancel'});
  assert.equal(await page.locator('#redo').isEnabled(),true,'pointer cancellation creates no history entry');
  await page.locator('#export-name').fill('history-test'); await page.locator('#export-name').press('Control+z');
  assert.deepEqual(await queuedTimes(),[2,4],'Ctrl+Z inside a text field does not edit audio history');
  assert.equal(await page.locator('#redo').isEnabled(),true);
  await dragBoundary(4,4.5);
  assert.equal(await page.locator('#redo').isDisabled(),true,'a new adjustment after undo discards the old redo branch');
  const resizedState = await queuedTimes();
  await page.keyboard.press('Control+z'); assert.deepEqual(await queuedTimes(),[2,4]);
  await page.keyboard.press('Control+y'); assert.deepEqual(await queuedTimes(),resizedState,'Ctrl+Y redoes endpoint adjustment');
  await page.keyboard.press('Control+z');
  await dragBoundary(3,4);
  await dragBoundary(4,9);
  near((await queuedTimes())[0],4,'movement stops before the next interval');
  near((await queuedTimes())[1],6,'neighbor collision preserves both endpoints separation');
  assert.equal(await page.locator('#pending-count').textContent(),'2','movement must not merge intervals');
  assert.equal(await page.locator('#selection-duration').textContent(),'2.000 秒');
  await dragBoundary(5,.5);
  assert.deepEqual(await queuedTimes(),[0,2],'movement clamps to file start without shortening');
  await dragBoundary(1,2,{cancel:'escape'});
  assert.deepEqual(await queuedTimes(),[0,2],'Escape cancels a whole-interval move');
  await dragBoundary(1,2,{cancel:'pointercancel'});
  assert.deepEqual(await queuedTimes(),[0,2],'pointer cancellation cancels a whole-interval move');
  await dragBoundary(7,11.5);
  assert.deepEqual(await queuedTimes(1),[10,12],'movement clamps to file end without shortening');
  await page.screenshot({path:path.join(output,'06-move-pending.png'),fullPage:true});
  await page.locator('#clear-deletions').click();
  await select(2,4); await page.locator('#add-deletion').click();
  await select(6,8); await page.locator('#add-deletion').click();
  await page.locator('#zoom').fill('2'); await page.locator('#zoom').dispatchEvent('input');
  await page.locator('#wave-scroll').fill('500'); await page.locator('#wave-scroll').dispatchEvent('input');
  await dragBoundary(3.5,4,{zoom:2,scroll:.5});
  near((await queuedTimes())[0],2.5,'a partially visible interval can move in a zoomed view');
  near((await queuedTimes())[1],4.5,'zoomed movement preserves the offscreen portion');
  assert.equal(await page.locator('#selection-duration').textContent(),'2.000 秒');
  await page.locator('#zoom').fill('1'); await page.locator('#zoom').dispatchEvent('input');
  await page.locator('#clear-deletions').click();
  await select(2,4); await page.locator('#add-deletion').click();
  await page.keyboard.down('Shift'); await dragBoundary(3,5); await page.keyboard.up('Shift');
  near((await queuedTimes())[0],2,'Shift drag inside a pending interval adds a selection instead of moving it');
  near((await queuedTimes())[1],5,'Shift drag retains its add-to-queue behavior');
  await page.locator('#clear-deletions').click();
  await select(2,4); await page.locator('#add-deletion').click();
  await select(6,8); await page.locator('#add-deletion').click();
  await dragBoundary(2,1,{during:async()=>{
    near((await queuedTimes())[0],1,'left boundary updates while dragging');
    near(parseTime(await page.locator('#output-duration').textContent()),7,'live projected duration');
  }});
  near((await queuedTimes())[1],4,'resizing start preserves end');
  const leftAdjusted = await queuedTimes();
  await page.keyboard.press('Control+z'); assert.deepEqual(await queuedTimes(),[2,4],'left edge adjustment is one undo step');
  await page.keyboard.press('Control+Shift+Z'); assert.deepEqual(await queuedTimes(),leftAdjusted);
  assert.deepEqual(await queuedTimes(1),[6,8],'another queued range stays unchanged');
  await dragBoundary(4,5);
  near((await queuedTimes())[0],1,'resizing end preserves start'); near((await queuedTimes())[1],5,'right boundary is editable');
  const bothAdjusted = await queuedTimes();
  await page.keyboard.press('Control+z'); assert.deepEqual(await queuedTimes(),leftAdjusted,'first undo restores the previous right edge');
  await page.keyboard.press('Control+z'); assert.deepEqual(await queuedTimes(),[2,4],'second undo restores the previous left edge');
  await page.keyboard.press('Control+y'); assert.deepEqual(await queuedTimes(),leftAdjusted);
  await page.keyboard.press('Control+Shift+Z'); assert.deepEqual(await queuedTimes(),bothAdjusted);
  await dragBoundary(8,9);
  near((await queuedTimes(1))[1],9,'a non-active pending interval can be resized directly');
  const beforeCancel = await queuedTimes();
  await dragBoundary(1,.5,{cancel:'escape'});
  assert.deepEqual(await queuedTimes(),beforeCancel,'Escape restores the interval before the gesture');
  await page.screenshot({path:path.join(output,'05-resize-pending.png'),fullPage:true});
  await dragBoundary(5,7,{during:async()=>{
    assert.equal(await page.locator('#pending-count').textContent(),'2','keep the dragged index stable until release');
    near(parseTime(await page.locator('#output-duration').textContent()),4,'overlapping draft ranges are counted only once');
  }});
  assert.equal(await page.locator('#pending-count').textContent(),'1','overlap merges when the handle is released');
  near((await queuedTimes())[0],1,'merge preserves the union start'); near((await queuedTimes())[1],9,'merge preserves the union end');
  const mergedState = await queuedTimes();
  await page.keyboard.press('Control+z');
  assert.equal(await page.locator('#pending-count').textContent(),'2','undo splits an automatically merged adjustment back into its original markers');
  assert.deepEqual(await queuedTimes(),beforeCancel);
  await page.keyboard.press('Control+Shift+Z');
  assert.equal(await page.locator('#pending-count').textContent(),'1'); assert.deepEqual(await queuedTimes(),mergedState);
  await page.locator('#clear-deletions').click();
  await page.locator('#undo').click(); assert.deepEqual(await queuedTimes(),mergedState,'clearing markers is undoable');
  await page.locator('#redo').click(); assert.equal(await page.locator('#pending-panel').isVisible(),false);
  await select(2,4); await page.locator('#add-deletion').click();
  await select(6,8); await page.locator('#add-deletion').click();
  await page.locator('#zoom').fill('2'); await page.locator('#zoom').dispatchEvent('input');
  await page.locator('#wave-scroll').fill('500'); await page.locator('#wave-scroll').dispatchEvent('input');
  await dragBoundary(4,4.5,{zoom:2,scroll:.5});
  near((await queuedTimes())[0],2,'an offscreen start stays fixed'); near((await queuedTimes())[1],4.5,'zoomed/scrolled boundary follows pointer');
  const beforePointerCancel = await queuedTimes();
  await dragBoundary(4.5,5,{zoom:2,scroll:.5,cancel:'pointercancel'});
  assert.deepEqual(await queuedTimes(),beforePointerCancel,'pointer cancellation restores the interval');
  await page.locator('#zoom').fill('1'); await page.locator('#zoom').dispatchEvent('input');
  await dragBoundary(2,-1);
  assert.equal((await queuedTimes())[0],0,'left edge clamps to the start of the file');
  await page.locator('#clear-deletions').click();
  await select(2,4); await page.locator('#add-deletion').click();
  await dragBoundary(2,5);
  const clamped = await queuedTimes();
  assert.ok(clamped[0] < clamped[1] && clamped[0] > 3.99,'start cannot cross the end');
  await page.locator('#clear-deletions').click();
  await select(2,4); await page.locator('#add-deletion').click();
  await dragBoundary(4,13);
  assert.equal((await queuedTimes())[1],12,'right edge clamps to the end of the file');
  await page.locator('#clear-deletions').click();
  await select(2,4); await page.locator('#add-deletion').click();
  await select(6,8); await page.locator('#add-deletion').click();
  await page.locator('#preview-deletions').click(); await page.waitForTimeout(100); await page.locator('#toggle-play').click();
  await page.screenshot({path:path.join(output,'04-multi-selection.png'),fullPage:true});
  await page.locator('#apply-deletions').click();
  assert.equal(await page.locator('#pending-panel').isVisible(),false);
  assert.equal(await page.locator('#output-duration').textContent(),'00:08.000');
  await page.locator('#undo').click();
  assert.equal(await page.locator('#segment-count').textContent(),'1','undo restores the original audio before the batch');
  assert.equal(await page.locator('#pending-count').textContent(),'2','undo also restores the batch markers for further adjustment');
  assert.deepEqual(await queuedTimes(),[2,4]); assert.deepEqual(await queuedTimes(1),[6,8]);
  await page.locator('#redo').click();
  assert.equal(await page.locator('#segment-count').textContent(),'3');
  assert.equal(await page.locator('#pending-panel').isVisible(),false);
  await select(4.5,5.5); await page.locator('#add-deletion').click();
  await dragBoundary(5,7);
  assert.deepEqual(await queuedTimes(),[5,6],'movement stops at a deleted region without shortening');
  await dragBoundary(5.5,3);
  assert.deepEqual(await queuedTimes(),[4,5],'movement stays inside the same remaining audio segment');
  await page.locator('[data-pending-mode="move"]').click(); await holdArrow('ArrowLeft',20,{shift:true});
  assert.deepEqual(await queuedTimes(),[4,5],'keyboard movement cannot cross a deleted gap');
  await holdArrow('ArrowRight',20,{shift:true}); assert.deepEqual(await queuedTimes(),[5,6]);
  await page.keyboard.press('Control+z'); assert.deepEqual(await queuedTimes(),[4,5]);
  await page.locator('#clear-deletions').click();
  assert.equal(await page.locator('#segment-count').textContent(),'3');
  assert.equal(await page.locator('#output-duration').textContent(),'00:08.000');
  await select(1,10); await page.locator('#keep-selection').click();
  assert.equal(await page.locator('#output-duration').textContent(),'00:05.000');
  await page.locator('#undo').click();
  await page.locator('#waveform').focus(); await page.keyboard.press('Control+Shift+Z');
  assert.equal(await page.locator('#output-duration').textContent(),'00:05.000');
  await page.keyboard.press('Control+z');
  assert.equal(await page.locator('#output-duration').textContent(),'00:08.000');
  await select(9,7);
  assert.equal(await page.locator('#selection-start').getAttribute('aria-invalid'),'true');
  assert.equal(await page.locator('#output-duration').textContent(),'00:08.000');
  await select(2,6);
  await page.locator('#zoom').fill('8'); await page.locator('#zoom').dispatchEvent('input');
  assert.equal(await page.locator('#scroll-label').isVisible(),true);
  await page.locator('#wave-scroll').fill('500'); await page.locator('#wave-scroll').dispatchEvent('input');
  await page.locator('#zoom').fill('1'); await page.locator('#zoom').dispatchEvent('input');
  const bounds = await page.locator('#waveform').boundingBox();
  await page.mouse.move(bounds.x + bounds.width * .1, bounds.y + 80);
  await page.mouse.down(); await page.mouse.move(bounds.x + bounds.width * .3, bounds.y + 80, { steps: 8 }); await page.mouse.up();
  assert.ok(Number((await page.locator('#selection-duration').textContent()).split(' ')[0]) > 2);
  await page.locator('#preview-result').click();
  await page.waitForTimeout(180);
  assert.equal(await page.locator('#toggle-play').getAttribute('aria-label'),'暫停');
  assert.notEqual(await page.locator('#playhead-time').textContent(),'00:00.000');
  await page.locator('#toggle-play').click();
  await page.locator('#waveform').focus(); await page.keyboard.press('Space'); await page.waitForTimeout(80); await page.keyboard.press('Space');
  assert.equal(await page.locator('#toggle-play').getAttribute('aria-label'),'播放');
  await page.screenshot({ path: path.join(output, '02-editor.png'), fullPage: true });
  await page.locator('#reset').click();
  await select(2,4); await page.locator('#add-deletion').click();
  await select(6,8); await page.locator('#add-deletion').click();
  assert.match(await page.locator('#export-button').textContent(),/刪除清單並匯出/);
  const wav = await exportFile('wav'); const wavInfo = await decodeInfo(wav);
  assert.equal(await page.locator('#pending-panel').isVisible(),false);
  assert.equal(wavInfo.duration,8); assert.equal(wavInfo.channels,2); assert.equal(wavInfo.rate,44100);
  for (const tone of wavInfo.tones) {
    assert.ok(tone.left > .3, 'WAV left tone');
    assert.ok(tone.right > .3, 'WAV right tone');
    assert.ok(tone.leak < .02, 'stereo channels must not be swapped');
  }
  // Check sample-exact concatenation at both cut boundaries, allowing one PCM LSB.
  const original = await readFile(source); const result = await readFile(wav);
  let outputFrame = 0;
  for (const [a,b] of [[0,2],[4,6],[8,12]]) {
    for (let frame = a*44100; frame < b*44100; frame++,outputFrame++) {
      for (let channel = 0; channel < 2; channel++) assert.ok(Math.abs(original.readInt16LE(44+frame*4+channel*2) - result.readInt16LE(44+outputFrame*4+channel*2)) <= 1);
    }
  }
  await page.locator('#reset').click();
  await select(2,4); await page.locator('#add-deletion').click();
  await select(6,8); await page.locator('#add-deletion').click();
  await dragBoundary(4,5);
  const predicted = parseTime(await page.locator('#output-duration').textContent());
  const resizedFile = await exportFile('wav'); const resizedBytes = await readFile(resizedFile);
  const resizedDuration = (resizedBytes.length - 44) / 4 / 44100;
  assert.ok(Math.abs(resizedDuration-predicted)<.001,'export includes the resized interval'); near(resizedDuration,7,'export duration reflects the dragged end');
  await page.locator('#reset').click();
  await select(2,4); await page.locator('#add-deletion').click();
  await select(6,8); await page.locator('#add-deletion').click();
  await dragBoundary(3,4);
  const movedFile = await exportFile('wav'); const movedBytes = await readFile(movedFile);
  assert.equal(movedBytes.length,44+8*44100*4,'whole-interval move preserves the exact exported sample count');
  const movedLeft = new Float32Array(8*44100);
  for(let i=0;i<movedLeft.length;i++) movedLeft[i]=movedBytes.readInt16LE(44+i*4)/32768;
  assert.ok(peakAt(movedLeft,44100,2.4,440)>.3,'the moved cut leaves the intended source audio');
  assert.ok(peakAt(movedLeft,44100,2.4,880)<.02,'export must use the moved position instead of the old cut');
  assert.ok(peakAt(movedLeft,44100,3.4,880)>.3,'the next retained source interval stays in order');
  await page.locator('#reset').click();
  await select(2,4); await page.locator('#add-deletion').click();
  await select(6,8); await page.locator('#add-deletion').click();
  await page.getByRole('button',{name:'選取待刪段落 1',exact:true}).click();
  await page.keyboard.press('Shift+ArrowRight');
  await page.locator('[data-pending-mode="end"]').click(); await page.keyboard.press('ArrowRight');
  await page.keyboard.press('Control+z'); await page.keyboard.press('Control+y');
  const keyboardFile = await exportFile('wav'), keyboardBytes = await readFile(keyboardFile);
  assert.equal(keyboardBytes.length,44+Math.round(7.99*44100)*4,'WAV uses the keyboard-adjusted length after redo');
  let keyboardFrame = 0;
  for (const [a,b] of [[0,2.1],[4.11,6],[8,12]]) {
    for (let frame = Math.round(a*44100); frame < Math.round(b*44100); frame++,keyboardFrame++) {
      for (let channel = 0; channel < 2; channel++) assert.ok(Math.abs(original.readInt16LE(44+frame*4+channel*2) - keyboardBytes.readInt16LE(44+keyboardFrame*4+channel*2)) <= 1,'keyboard cuts preserve source samples and stereo order');
    }
  }
  await page.locator('#reset').click();
  await select(2,4); await page.locator('#add-deletion').click();
  await select(6,8); await page.locator('#add-deletion').click();
  const mp3 = await exportFile('mp3'); const mp3Info = await decodeInfo(mp3);
  console.log('WAV sample boundaries and MP3 export verified');
  assert.ok(Math.abs(mp3Info.duration - 8) < .12); assert.equal(mp3Info.channels,2);
  for (const tone of mp3Info.tones) {
    assert.ok(tone.left > .25);
    assert.ok(tone.right > .25);
  }
  await page.locator('#file-input').setInputFiles(mp3);
  await page.locator('#workspace').waitFor({ state:'visible' });
  await waitFor(async()=> (await page.locator('#file-name').textContent()) === 'edited.mp3','MP3 import did not finish');
  assert.equal(await page.locator('#segment-count').textContent(),'1');
  await page.locator('#export-button').click();
  await page.locator('#cancel-export').click();
  assert.match(await page.locator('#notice').textContent(),/已取消匯出/);
  assert.equal(await page.locator('#export-button').isEnabled(),true);
  await select(0,1); await page.locator('#delete-selection').click();
  await page.locator('#file-input').setInputFiles(source);
  await page.locator('#replace-dialog').waitFor({ state:'visible' });
  await page.locator('#replace-dialog button[value="cancel"]').click();
  assert.equal(await page.locator('#file-name').textContent(),'edited.mp3');
  await page.locator('#file-input').setInputFiles(source);
  await page.locator('#replace-dialog').waitFor({ state:'visible' });
  await page.keyboard.press('Escape');
  assert.equal(await page.locator('#file-name').textContent(),'edited.mp3');
  await page.locator('#reset').click();
  await select(0,8.046); // Use actual displayed end for compressed input.
  const end = (await page.locator('#original-duration').textContent());
  await page.locator('#selection-start').fill('0'); await page.locator('#selection-end').fill(end); await page.locator('#selection-end').press('Enter');
  await page.locator('#delete-selection').click();
  assert.equal(await page.locator('#export-button').isDisabled(),true);
  assert.equal(await page.locator('#empty-segments').isVisible(),true);
  await page.locator('#undo').click();
  assert.equal(await page.locator('#export-button').isEnabled(),true);
  // Restore original before replacement to avoid discarding unsaved work without confirmation.
  if (await page.locator('#reset').isEnabled()) await page.locator('#reset').click();
  await page.locator('#file-input').setInputFiles({ name:'empty.wav', mimeType:'audio/wav', buffer:Buffer.alloc(0) });
  assert.match(await page.locator('#notice').textContent(),/空的/);
  await page.locator('#file-input').setInputFiles({ name:'broken.wav', mimeType:'audio/wav', buffer:Buffer.from('not a wave') });
  if (await page.locator('#replace-dialog').isVisible()) await page.locator('#replace-dialog button[value="replace"]').click();
  await page.locator('#import-area').waitFor({ state:'visible', timeout:15000 });
  assert.match(await page.locator('#notice').textContent(),/無法讀取/);
  await page.locator('#load-demo').click(); await page.locator('#workspace').waitFor({ state:'visible' });
  assert.equal(await page.locator('#original-duration').textContent(),'00:18.000');
  const demoBounds = await page.locator('#waveform').boundingBox();
  await page.keyboard.down('Shift');
  for (const [start,end] of [[.1,.2],[.5,.6]]) {
    await page.mouse.move(demoBounds.x+demoBounds.width*start,demoBounds.y+80);
    await page.mouse.down(); await page.mouse.move(demoBounds.x+demoBounds.width*end,demoBounds.y+80,{steps:8}); await page.mouse.up();
  }
  await page.keyboard.up('Shift');
  assert.equal(await page.locator('#pending-count').textContent(),'2','Shift drag should collect multiple selections');
  await page.locator('#file-input').setInputFiles(source);
  await page.locator('#replace-dialog').waitFor({state:'visible'});
  await page.locator('#replace-dialog button[value="cancel"]').click();
  assert.equal(await page.locator('#original-duration').textContent(),'00:18.000','queued edits must be protected on replacement');
  await page.setViewportSize({ width:390,height:844 }); await page.screenshot({ path:path.join(output,'03-mobile.png'),fullPage:true });
  assert.equal(await page.evaluate(()=>document.documentElement.scrollWidth > innerWidth),false,'mobile must not overflow');
  await page.locator('#clear-deletions').click();
  assert.equal(await page.locator('#pending-panel').isVisible(),false);
  await select(0,18); await page.locator('#add-deletion').click();
  assert.equal(await page.locator('#export-button').isDisabled(),true,'do not export an empty projected result');
  await page.locator('#apply-deletions').click();
  assert.equal(await page.locator('#empty-segments').isVisible(),true);
  await page.locator('#undo').click();
  assert.equal(await page.locator('#segment-count').textContent(),'1');
  assert.equal(await page.locator('#pending-count').textContent(),'1');
  await page.locator('#clear-deletions').click();
  assert.equal(await page.locator('#output-duration').textContent(),'00:18.000');
  if (process.env.LONG_AUDIO === '1') {
    const long = await fixture(29*60,1,'29-minutes.wav');
    const started = Date.now();
    await page.locator('#file-input').setInputFiles(long);
    await waitFor(async()=> (await page.locator('#file-name').textContent()) === '29-minutes.wav','Long audio did not decode');
    assert.equal(await page.locator('#original-duration').textContent(),'29:00.000');
    await select(1,1739); await page.locator('#keep-selection').click();
    await page.locator('#export-button').click();
    await waitFor(async()=>Number(await page.locator('#progress-bar').getAttribute('value')) > 0,'Long export did not progress');
    await page.locator('#cancel-export').click();
    assert.equal(await page.locator('#export-button').isEnabled(),true);
    console.log(`29-minute mono import + edit + export cancellation: ${Date.now()-started} ms`);
  }
  assert.deepEqual(errors,[],'browser console errors');
  await writeFile(path.join(output,'requests.json'),JSON.stringify(requests,null,2));
  // The host's antivirus may inject its own monitoring script before the page.
  // Record that environmental traffic separately; never disable the security software.
  const environmentRequests = requests.filter(request=>['me.kis.v2.scr.kaspersky-labs.com','gc.kis.v2.scr.kaspersky-labs.com'].includes(new URL(request.url).hostname));
  const appRequests = requests.filter(request=>!environmentRequests.includes(request));
  await writeFile(path.join(output,'environment-requests.json'),JSON.stringify(environmentRequests,null,2));
  assert.deepEqual(appRequests.filter(request=>/^https?:/.test(request.url) && !blocked.has(request.url) && (request.method!=='GET' || !request.url.startsWith(url))), [], 'Audio must never be sent over the network');
  console.log(`PASS ${channel || 'chromium'}: keyboard move/start/end + Shift, key-repeat history/cancel/blur, boundary and gap clamps, keyboard WAV samples, pointer editing/history, MP3 stereo, responsive layout, local-only network.`);
} finally {
  await context.close(); await browser.close(); if (server) await new Promise(resolve=>server.close(resolve));
}

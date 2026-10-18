import assert from 'node:assert/strict';
import { mkdir, writeFile, open } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { startServer } from '../scripts/serve.mjs';
import { wavHeader } from '../pcm.mjs';
import { subtractMany } from '../core.mjs';
import { workerMemory } from './worker-memory.mjs';

const { chromium } = await import(process.env.PLAYWRIGHT_MODULE ? pathToFileURL(process.env.PLAYWRIGHT_MODULE).href : 'playwright');
const channel = process.env.BROWSER_CHANNEL || 'chrome', label = process.env.PERF_LABEL || 'current';
const output = path.resolve('test-results', `performance-${channel}`); await mkdir(output,{recursive:true});
const { server, url } = process.env.SITE_URL ? {server:null,url:process.env.SITE_URL} : await startServer({port:0,base:'/audio-cutter/'});
const browser = await chromium.launch({channel,headless:true});
const context = await browser.newContext({viewport:{width:1440,height:1080},acceptDownloads:true});
const page = await context.newPage(), errors = [];
page.on('pageerror',error=>errors.push(error.message)); page.on('dialog',dialog=>dialog.accept());
const session = await context.newCDPSession(page); await session.send('Performance.enable');
const metrics = async () => Object.fromEntries((await session.send('Performance.getMetrics')).metrics.map(item=>[item.name,item.value]));
async function selected(start,end) {
  await page.evaluate(([a,b])=>{
    document.getElementById('selection-start').value=String(a);
    const end=document.getElementById('selection-end'); end.value=String(b); end.dispatchEvent(new Event('change',{bubbles:true}));
  },[start,end]);
}
async function samplePlayback(button) {
  await page.locator(button).click(); await page.waitForTimeout(150);
  await page.evaluate(()=>window.audit.reset()); const before=await metrics();
  await page.waitForTimeout(1600); const after=await metrics();
  const result=await page.evaluate(()=>window.audit.snapshot());
  await page.locator('#waveform').focus(); await page.keyboard.press(button==='#loop-junction'?'Escape':'Space');
  return {...result,taskMs:(after.TaskDuration-before.TaskDuration)*1000,scriptMs:(after.ScriptDuration-before.ScriptDuration)*1000,layoutMs:(after.LayoutDuration-before.LayoutDuration)*1000};
}
try {
  await page.goto(url); await page.locator('#load-demo').click(); await page.locator('#workspace').waitFor({state:'visible'});
  await page.evaluate(async()=>{
    const { Waveform }=await import('./waveform.mjs'); const original=Waveform.prototype.draw;
    const times=[]; let fills=0, labelMutations=0, listMutations=0, longTasks=[];
    Waveform.prototype.draw=function(...args){const start=performance.now();const result=original.apply(this,args);times.push(performance.now()-start);return result;};
    const fill=CanvasRenderingContext2D.prototype.fillRect;
    CanvasRenderingContext2D.prototype.fillRect=function(...args){fills++;return fill.apply(this,args);};
    new MutationObserver(records=>{labelMutations+=records.length;}).observe(document.getElementById('loop-junction-label'),{childList:true,subtree:true,characterData:true});
    new MutationObserver(records=>{listMutations+=records.reduce((sum,record)=>sum+record.addedNodes.length+record.removedNodes.length,0);}).observe(document.getElementById('pending-list'),{childList:true,subtree:true});
    new PerformanceObserver(list=>longTasks.push(...list.getEntries().map(entry=>entry.duration))).observe({type:'longtask',buffered:false});
    window.audit={reset(){times.length=0;fills=0;labelMutations=0;listMutations=0;longTasks=[];},snapshot(){const ordered=[...times].sort((a,b)=>a-b);return {drawCalls:times.length,drawMs:times.reduce((a,b)=>a+b,0),drawP95:ordered[Math.floor(ordered.length*.95)]||0,staticFillRects:fills,labelMutations,listMutations,longTasks};}};
  });
  const rangeTimings=[120,500,2000].map(count=>{
    const cuts=Array.from({length:count},(_,i)=>[i*100+10,i*100+20]),start=performance.now();
    for(let i=0;i<20;i++)subtractMany([[0,count*100]],cuts);
    return {count,meanMs:(performance.now()-start)/20};
  });
  const report={channel,label,browserVersion:browser.version(),measuredAt:new Date().toISOString(),rangeTimings,playback:await samplePlayback('#preview-result')};
  const setup=await page.evaluate(()=>{
    const started=performance.now();
    for(let i=0;i<120;i++){
      document.getElementById('selection-start').value=(.1+i*.14).toFixed(3);
      const end=document.getElementById('selection-end');end.value=(.15+i*.14).toFixed(3);end.dispatchEvent(new Event('change',{bubbles:true}));
      document.getElementById('add-deletion').click();
    }
    return performance.now()-started;
  });
  assert.equal(await page.locator('#pending-count').textContent(),'120');
  await page.getByRole('button',{name:'選取待刪段落 61',exact:true}).click();
  report.markerSetupMs=setup; report.crowdedPlayback=await samplePlayback('#preview-result'); report.crowdedLoop=await samplePlayback('#loop-junction');
  report.cacheInvalidation=await page.evaluate(()=>{
    const canvas=document.getElementById('waveform'),zoom=document.getElementById('zoom'),scroll=document.getElementById('wave-scroll');
    const original=canvas.toDataURL();zoom.value='2';zoom.dispatchEvent(new Event('input',{bubbles:true}));const zoomed=canvas.toDataURL();
    scroll.value='500';scroll.dispatchEvent(new Event('input',{bubbles:true}));const scrolled=canvas.toDataURL();
    zoom.value='1';zoom.dispatchEvent(new Event('input',{bubbles:true}));
    return {zoomChanged:zoomed!==original,scrollChanged:scrolled!==zoomed,restored:canvas.toDataURL()===original};
  });
  assert.deepEqual(report.cacheInvalidation,{zoomChanged:true,scrollChanged:true,restored:true},'cached graphics must follow zoom and pan');
  await page.evaluate(()=>window.audit.reset());
  report.heldNudge=await page.evaluate(()=>{
    const wave=document.getElementById('waveform'),start=performance.now();
    for(let i=0;i<40;i++)wave.dispatchEvent(new KeyboardEvent('keydown',{key:'ArrowRight',bubbles:true,repeat:i>0}));
    wave.dispatchEvent(new KeyboardEvent('keyup',{key:'ArrowRight',bubbles:true}));
    return {elapsedMs:performance.now()-start};
  });
  await page.waitForTimeout(50); report.heldNudge={...report.heldNudge,...await page.evaluate(()=>window.audit.snapshot())};
  if(process.env.LONG_AUDIO==='1'){
    await page.locator('#reset').click();
    const seconds=29*60,channels=2,frames=seconds*44100,target=path.join(output,'29-minutes-stereo.wav');
    const file=await open(target,'w');try{await file.write(wavHeader(frames,channels,44100));await file.truncate(44+frames*channels*2);}finally{await file.close();}
    await page.evaluate(()=>{
      const read=Blob.prototype.arrayBuffer,decode=AudioContext.prototype.decodeAudioData,channel=AudioBuffer.prototype.getChannelData;
      window.importAudit={channels:[],restore(){Blob.prototype.arrayBuffer=read;AudioContext.prototype.decodeAudioData=decode;AudioBuffer.prototype.getChannelData=channel;}};
      Blob.prototype.arrayBuffer=async function(...args){const start=performance.now();try{return await read.apply(this,args);}finally{window.importAudit.readMs=performance.now()-start;}};
      AudioContext.prototype.decodeAudioData=async function(...args){const start=performance.now();try{return await decode.apply(this,args);}finally{window.importAudit.decodeMs=performance.now()-start;}};
      AudioBuffer.prototype.getChannelData=function(...args){const start=performance.now();const result=channel.apply(this,args);window.importAudit.channels.push(performance.now()-start);return result;};
    });
    if(process.env.PROFILE_IMPORT==='1'){await session.send('Profiler.enable');await session.send('Profiler.start');}
    await page.evaluate(()=>window.audit.reset()); const start=Date.now();
    await page.locator('#file-input').setInputFiles(target); await page.waitForFunction(()=>document.getElementById('file-name').textContent==='29-minutes-stereo.wav',null,{timeout:60000});
    report.longImport={elapsedMs:Date.now()-start,decodedMiB:frames*channels*4/1024**2,...await page.evaluate(()=>window.audit.snapshot())};
    report.longImport.phases=await page.evaluate(()=>{const {readMs,decodeMs,channels}=window.importAudit;window.importAudit.restore();return {readMs,decodeMs,channelAccessMs:channels};});
    report.longImport.heap=await session.send('Runtime.getHeapUsage');
    report.longImport.workerHeaps=await workerMemory(browser);
    assert.ok(report.longImport.heap.backingStorageSize<32*1024**2,'long WAV PCM must stay off the page heap');
    assert.ok(report.longImport.workerHeaps.every(heap=>heap.backingStorageSize<16*1024**2),'WAV worker must retain only bounded scratch buffers');
    if(process.env.PROFILE_IMPORT==='1'){const {profile}=await session.send('Profiler.stop');await writeFile(path.join(output,`${label}-import.cpuprofile`),JSON.stringify(profile));}
    await selected(10,20); await page.locator('#add-deletion').click(); report.longLoop=await samplePlayback('#loop-junction');
    await page.locator('#clear-deletions').click();
    await selected(0,120); await page.locator('#keep-selection').click();
    await page.locator('[name="format"][value="mp3"]').check(); await page.locator('#export-button').click();
    await page.waitForFunction(()=>Number(document.getElementById('progress-bar').value)>0); const cancel=Date.now(); await page.locator('#cancel-export').click();
    report.exportCancelMs=Date.now()-cancel; assert.equal(await page.locator('#export-button').isEnabled(),true);
    await page.locator('[name="format"][value="wav"]').check();
    const downloadPromise=page.waitForEvent('download'),exportStart=Date.now(); await page.locator('#export-button').click(); const download=await downloadPromise; await download.saveAs(path.join(output,'two-minutes.wav'));
    report.wavExportMs=Date.now()-exportStart;
    await selected(1,2); await page.locator('#add-deletion').click();
    await page.locator('#load-demo').evaluate(element=>element.click()); await page.locator('#replace-dialog button[value="replace"]').click();
    await page.waitForFunction(()=>document.getElementById('file-name').textContent==='午後練習曲.wav');
    report.replacementSucceeded=true;
    await session.send('HeapProfiler.collectGarbage');report.afterReplacementHeap=await session.send('Runtime.getHeapUsage');
  }
  assert.deepEqual(errors,[]); await writeFile(path.join(output,`${label}.json`),JSON.stringify(report,null,2)); console.log(JSON.stringify(report));
  if(process.env.PERF_ASSERT!=='0'){
    assert.equal(report.playback.staticFillRects,0,'steady playback must not rebuild the static waveform');
    assert.equal(report.crowdedLoop.labelMutations,0,'steady playback must not replace unchanged UI text');
    assert.ok(report.heldNudge.listMutations<1000,'a held nudge must update rows rather than rebuild all marker buttons');
  }
} finally {await context.close();await browser.close();if(server){server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}}

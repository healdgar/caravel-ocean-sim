// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Root executes these native-device and real-UI checks serially.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {before,after,test} from 'node:test';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';

let statsServer,statsBrowser,statsOrigin;
before(async()=>{
  statsServer=createDevServer();statsServer.listen(0,'127.0.0.1');await once(statsServer,'listening');statsOrigin='http://127.0.0.1:'+statsServer.address().port;
  statsBrowser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
});
after(async()=>{await statsBrowser?.close();if(statsServer)await new Promise(resolve=>statsServer.close(resolve));});

test('native GPU profiler allocates lazily, discards pending old epochs and restores endpoint-only timing',{timeout:120000},async t=>{
  const page=await statsBrowser.newPage();
  try{
    await page.route('**/__stats-profiler',r=>r.fulfill({contentType:'text/html',body:'<!doctype html>'}));await page.goto(statsOrigin+'/__stats-profiler');
    const result=await page.evaluate(async()=>{
      const {createGPUProfiler,GPU_PASS_NAMES}=await import('/js/profiler.js'),adapter=await navigator.gpu.requestAdapter();
      if(!adapter.features.has('timestamp-query'))throw Error('Native timestamp lifecycle qualification requires timestamp-query');
      const device=await adapter.requestDevice({requiredFeatures:['timestamp-query']}),errors=[],queries=[],buffers=[];
      device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
      const createQuery=device.createQuerySet.bind(device),createBuffer=device.createBuffer.bind(device);
      device.createQuerySet=desc=>{queries.push(desc.count);return createQuery(desc);};
      device.createBuffer=desc=>{buffers.push({label:desc.label,size:desc.size});return createBuffer(desc);};
      const profiler=createGPUProfiler(device,false),before={queries:queries.length,buffers:buffers.length};
      const encode=(index,names)=>{
        profiler.beginFrame(index);const encoder=device.createCommandEncoder(),descriptors=[];
        for(const name of names){const timestampWrites=profiler.writes(name);descriptors.push(timestampWrites?{name,count:timestampWrites.querySet.count,start:timestampWrites.beginningOfPassWriteIndex??null,end:timestampWrites.endOfPassWriteIndex??null}:null);const pass=encoder.beginComputePass({timestampWrites});pass.end();}
        const copied=profiler.resolve(encoder);device.queue.submit([encoder.finish()]);return {copied,descriptors};
      };
      // Hold only delivery of a genuine GPU map. Native timestamp commands and
      // mapAsync still run; the gate makes the mode-change race deterministic.
      const nativeMap=GPUBuffer.prototype.mapAsync;let release;
      const delivery=new Promise(resolve=>release=resolve);
      GPUBuffer.prototype.mapAsync=function(...args){const native=nativeMap.apply(this,args);return this.label==='timing read'?Promise.all([native,delivery]).then(()=>{}):native;};
      const endpoint=encode(0,['Waves + effects','Sky + clouds','Composite']),reading=profiler.read();
      await device.queue.onSubmittedWorkDone();
      profiler.setDetailed(true);profiler.setDetailed(false);profiler.setDetailed(true);
      profiler.beginFrame(8);const whilePending=profiler.writes('Waves + effects'),pendingSnapshot=profiler.snapshot(),pendingQueries=queries.slice();
      release();await reading;GPUBuffer.prototype.mapAsync=nativeMap;
      const discarded=profiler.snapshot();
      const detailed=encode(16,GPU_PASS_NAMES);await profiler.read();const detailedSnapshot=profiler.snapshot(),detailQueryCounts=queries.slice();
      let releaseDetailed;const detailedDelivery=new Promise(resolve=>releaseDetailed=resolve);
      GPUBuffer.prototype.mapAsync=function(...args){const native=nativeMap.apply(this,args);return this.label==='timing read'?Promise.all([native,detailedDelivery]).then(()=>{}):native;};
      encode(24,GPU_PASS_NAMES);const detailedReading=profiler.read();await device.queue.onSubmittedWorkDone();profiler.setDetailed(false);const cleared=profiler.snapshot();
      releaseDetailed();await detailedReading;GPUBuffer.prototype.mapAsync=nativeMap;const closedDiscarded=profiler.snapshot();
      const closed=encode(40,['Waves + effects','Sky + clouds','escort-8 Solid shadows','Composite']);await profiler.read();
      const endpointSnapshot=profiler.snapshot(),closedText=profiler.text();profiler.destroy();await device.queue.onSubmittedWorkDone();device.destroy();
      // A real device without requested timestamp-query support must still
      // permit the CPU/FPS UI; do not pretend an unsupported feature exists.
      const plain=await(await navigator.gpu.requestAdapter()).requestDevice(),unsupported=createGPUProfiler(plain,true);unsupported.beginFrame(0);
      const unsupportedResult={supported:unsupported.supported,detailed:unsupported.detailed,writes:unsupported.writes('Waves + effects')??null,enabled:unsupported.setDetailed(true),text:unsupported.text()};unsupported.destroy();plain.destroy();
      return {errors,before,endpoint,whilePending:whilePending??null,pendingSnapshot,pendingQueries,discarded,detailed,detailedSnapshot,detailQueryCounts,cleared,closedDiscarded,closed,endpointSnapshot,closedText,unsupported:unsupportedResult,names:GPU_PASS_NAMES,buffers};
    });
    t.diagnostic(JSON.stringify(result));assert.deepEqual(result.errors,[]);assert.deepEqual(result.before,{queries:0,buffers:0});
    assert.equal(result.endpoint.copied,true);assert.deepEqual(result.endpoint.descriptors.map(d=>d&&[d.count,d.start,d.end]),[[2,0,null],null,[2,null,1]]);
    assert.equal(result.whilePending,null,'a pending read cannot start a second capture');assert.deepEqual(result.pendingQueries,[2],'opening while pending cannot allocate or reuse live detailed query memory');
    assert.equal(result.pendingSnapshot.sampleCount,0);assert.equal(result.discarded.sampleCount,0);assert.equal(result.discarded.totalMs,0);assert.deepEqual(result.discarded.latest,{},'old endpoint readback cannot populate a newly opened detailed epoch');assert.equal(result.discarded.error,'');
    assert.deepEqual(result.detailQueryCounts,[2,result.names.length*2]);assert.equal(result.detailed.copied,true);assert.equal(result.detailed.descriptors.filter(Boolean).length,result.names.length);
    assert.equal(result.detailedSnapshot.detailed,true);assert.equal(result.detailedSnapshot.sampleCount,1);assert.equal(result.detailedSnapshot.error,'');assert.ok(Object.values(result.detailedSnapshot.latest).every(x=>Number.isFinite(x)&&x>=0));
    for(let escort=1;escort<=8;escort++)for(const kind of ['Solid','Canvas'])assert.ok(Object.hasOwn(result.detailedSnapshot.latest,`escort-${escort} ${kind} shadows`),'all production escort timing names are accepted');
    assert.equal(result.cleared.sampleCount,0);assert.deepEqual(result.cleared.latest,{});assert.equal(result.closedDiscarded.sampleCount,0);assert.deepEqual(result.closedDiscarded.latest,{},'an old detailed read cannot leak spans into closed-panel endpoint timing');assert.equal(result.closedDiscarded.error,'');assert.equal(result.endpointSnapshot.detailed,false);assert.equal(result.endpointSnapshot.sampleCount,1);assert.deepEqual(Object.keys(result.endpointSnapshot.latest),['Frame','Bloom']);assert.equal(result.endpointSnapshot.error,'');
    assert.deepEqual(result.closed.descriptors.map(d=>d&&[d.count,d.start,d.end]),[[2,0,null],null,null,[2,null,1]],'closing removes detailed pass-boundary descriptors');assert.match(result.closedText,/Detailed pass timing is off/);
    assert.deepEqual({supported:result.unsupported.supported,detailed:result.unsupported.detailed,writes:result.unsupported.writes,enabled:result.unsupported.enabled},{supported:false,detailed:false,writes:null,enabled:false});assert.match(result.unsupported.text,/unavailable/);
  }finally{await page.close();}
});

function instrumentStatsRuntime(){
  const r=window.statsRuntime={callback:null,now:null,device:null,errors:[],queries:[],timings:[],holdTiming:false,heldReads:[]};
  window.requestAnimationFrame=callback=>{r.callback=callback;return 1;};
  const request=GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice=async function(...args){const device=await request.apply(this,args);r.device=device;device.addEventListener('uncapturederror',e=>r.errors.push(e.error.message));return device;};
  const createQuery=GPUDevice.prototype.createQuerySet;
  GPUDevice.prototype.createQuerySet=function(desc){r.queries.push(desc.count);return createQuery.call(this,desc);};
  const map=GPUBuffer.prototype.mapAsync;
  GPUBuffer.prototype.mapAsync=function(...args){const native=map.apply(this,args);if(this.label!=='timing read'||!r.holdTiming)return native;const delivery=new Promise(resolve=>r.heldReads.push(resolve));return Promise.all([native,delivery]).then(()=>{});};
  for(const method of ['beginComputePass','beginRenderPass']){
    const original=GPUCommandEncoder.prototype[method];GPUCommandEncoder.prototype[method]=function(desc={}){if(desc.timestampWrites)r.timings.push({count:desc.timestampWrites.querySet.count,start:desc.timestampWrites.beginningOfPassWriteIndex??null,end:desc.timestampWrites.endOfPassWriteIndex??null});return original.call(this,desc);};
  }
}

async function statsStep(page,dt=.1){
  const result=await page.evaluate(async dt=>{
    const r=statsRuntime,callback=r.callback;if(typeof callback!=='function')throw Error('Missing actual stats UI RAF');r.callback=null;r.timings=[];r.now=(r.now??performance.now())+dt*1000;callback(r.now);await r.device.queue.onSubmittedWorkDone();await new Promise(resolve=>setTimeout(resolve,0));return {errors:r.errors,queries:r.queries,timings:r.timings,held:r.heldReads.length};
  },dt);assert.deepEqual(result.errors,[]);return result;
}

async function statsLayout(page){
  return page.evaluate(()=>{
    const panel=document.querySelector('#performance-panel'),button=document.querySelector('#performance-toggle'),close=panel.querySelector('button'),body=panel.querySelector('.panel-body'),viewport={width:innerWidth,height:innerHeight},rect=element=>{const b=element.getBoundingClientRect();return {x:b.x,y:b.y,width:b.width,height:b.height,right:b.right,bottom:b.bottom};};
    const b=close.getBoundingClientRect(),hit=document.elementFromPoint(b.x+b.width/2,b.y+b.height/2);
    return {viewport,panel:rect(panel),button:rect(button),close:rect(close),closeHit:!!hit&&close.contains(hit),overflow:body.scrollWidth-body.clientWidth,documentOverflow:document.documentElement.scrollWidth-innerWidth,summary:document.querySelector('#performance-summary').textContent,gpu:document.querySelector('#gpu-profile-details').textContent,canvas:{width:document.querySelector('#c').width,height:document.querySelector('#c').height},hidden:panel.hidden};
  });
}
function assertStatsLayout(layout){
  for(const key of ['panel','button','close']){const b=layout[key];assert.ok(b.width>0&&b.height>0&&b.x>=-.5&&b.y>=-.5&&b.right<=layout.viewport.width+.5&&b.bottom<=layout.viewport.height+.5,key+' remains inside the visible viewport '+JSON.stringify(layout));}
  assert.ok(layout.closeHit,'the close control must be hit-testable, not covered by the dock or a clipped panel');assert.ok(layout.overflow<=1&&layout.documentOverflow<=1,'stats text cannot create horizontal overflow');
}

for(const path of ['/', '/docs/index.html'])for(const viewport of [{width:1140,height:800},{width:320,height:568}])test(`${path}: Stats stays usable at ${viewport.width}×${viewport.height} with live metrics, resizing and pending timing reads`,{timeout:300000},async()=>{
  const mobile=viewport.width===320,page=await statsBrowser.newPage({viewport,deviceScaleFactor:mobile?2:1,isMobile:mobile,hasTouch:mobile}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(/Unknown GPU timing pass|init failed|GPU error:|Shader compile error/i.test(m.text()))errors.push(m.text());});
  await page.addInitScript(instrumentStatsRuntime);
  const query=new URLSearchParams({ship:'nina',fleet:'nina,nina',crew:'0',view:'ship',resolution:'0.5',clouds:'0',sunElev:'35',windSpeed:'8',windDir:'118',swellHs:'.25'});
  try{
    await page.goto(statsOrigin+path+'?'+query);await page.waitForFunction(()=>statsRuntime.callback||window.oceanStartup?.state==='failed'||document.querySelector('#err')?.textContent,undefined,{polling:100,timeout:180000});assert.equal(await page.locator('#err').textContent(),'',errors.join('\n'));
    await statsStep(page);await page.waitForFunction(()=>oceanStartup.state==='ready');
    const stats=page.getByRole('button',{name:'Performance stats',exact:true}),close=page.getByRole('button',{name:'Hide performance stats',exact:true});
    assert.equal(await page.locator('#performance-panel').isVisible(),false);assert.equal(await stats.getAttribute('aria-expanded'),'false');
    for(let i=0;i<8;i++)await statsStep(page);assert.ok((await page.evaluate(()=>statsRuntime.queries)).every(n=>n===2),'closed Stats allocates endpoint queries only');
    await stats.click();assert.equal(await stats.getAttribute('aria-expanded'),'true');assert.equal(await stats.getAttribute('aria-pressed'),'true');
    for(let i=0;i<12;i++)await statsStep(page);const first=await statsLayout(page);assertStatsLayout(first);
    assert.match(first.summary,/\d+(?:\.\d+)? fps/);assert.match(first.summary,/CPU frame work: \d+(?:\.\d+)? ms/);assert.match(first.summary,/Resolution: 0\.5 · 50%/);assert.match(first.summary,/Active vessels: 3/);assert.ok(first.summary.includes(`${first.canvas.width} × ${first.canvas.height} pixels`));assert.doesNotMatch(first.gpu,/Unknown GPU timing pass|unavailable: .*Error/);
    assert.ok((await page.evaluate(()=>statsRuntime.queries)).some(n=>n>2),'opening Stats actually enables detailed native timestamp resources');
    // Deliberately leave a real timestamp read pending while repeated physical
    // clicks change modes. Startup, timing and render work remain unmodified.
    await page.evaluate(()=>{statsRuntime.holdTiming=true;});let held=false;
    for(let i=0;i<16;i++)if((await statsStep(page)).held){held=true;break;}
    assert.ok(held,'the race fixture must actually overlap a GPU timestamp read');
    await close.click();await stats.click();await close.click();assert.equal(await page.locator('#performance-panel').isVisible(),false);assert.equal(await stats.getAttribute('aria-expanded'),'false');
    await page.evaluate(()=>{statsRuntime.holdTiming=false;for(const release of statsRuntime.heldReads.splice(0))release();});
    const closedTimings=[];for(let i=0;i<16;i++)closedTimings.push(...(await statsStep(page)).timings);assert.ok(closedTimings.length>=2);assert.ok(closedTimings.every(d=>d.count===2),'closing restores endpoint-only scheduling after the pending read settles');
    await stats.click();for(let i=0;i<12;i++)await statsStep(page,.025);const faster=await statsLayout(page);assert.notEqual(faster.summary,first.summary,'FPS and frame-work text update from live frames');assertStatsLayout(faster);
    await page.setViewportSize(mobile?{width:360,height:640}:{width:980,height:720});for(let i=0;i<8;i++)await statsStep(page,.05);const resized=await statsLayout(page);assertStatsLayout(resized);assert.notDeepEqual(resized.canvas,first.canvas,'actual render dimensions follow viewport resizing');assert.ok(resized.summary.includes(`${resized.canvas.width} × ${resized.canvas.height} pixels`),'Stats reports actual resized GPU output');
    await page.keyboard.press('Escape');assert.equal(await page.locator('#performance-panel').isVisible(),false);assert.equal(await stats.getAttribute('aria-expanded'),'false');assert.equal(await stats.evaluate(element=>document.activeElement===element),true,'closing restores keyboard focus');assert.deepEqual(errors,[]);
  }finally{await page.close();}
});

// Copyright (c) 2026 Six Cailloux, LLC. MIT. Root alone runs GPU checks.
// Compare complete production frames with exactly the same frozen clocks, drawn with the one continuum's Hi-Z
// occlusion (js/continuum-hiz.js) and without it (hiz=0): occlusion may only take away work nothing shows.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdir,writeFile} from 'node:fs/promises';
import {test} from 'node:test';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';
// Frames each run draws before its pictures are compared: past the coast's readiness and the occlusion pyramid's making.
const WARM_FRAMES=360;
function forestOcclusionFrameCapture(){
 const r=window.forestOcclusionFrame={waiting:new Map(),device:null,target:null,fresh:false,errors:[],indirect:[]};
 // Frames run only when the test steps them, every callback waiting for the frame at once, as a browser runs them.
 let id=0;window.requestAnimationFrame=callback=>{r.waiting.set(++id,callback);return id;};window.cancelAnimationFrame=handle=>{r.waiting.delete(handle);};
 r.step=now=>{const due=[...r.waiting.values()];r.waiting.clear();for(const callback of due)callback(now);};
 const request=GPUAdapter.prototype.requestDevice;GPUAdapter.prototype.requestDevice=async function(...args){const d=await request.apply(this,args);r.device=d;d.addEventListener('uncapturederror',e=>r.errors.push(e.error.message));d.lost.then(e=>r.lost=e.message);return d;};
 // The forest's indirect arguments in the one cut: one 16-byte drawIndirect a list (js/continuum-scene.js).
 const buffer=GPUDevice.prototype.createBuffer;GPUDevice.prototype.createBuffer=function(desc){const inspect=desc.label==='forest continuum draws',b=buffer.call(this,inspect?{...desc,usage:desc.usage|GPUBufferUsage.COPY_SRC}:desc);if(inspect)r.indirect.push(b);return b;};
 const texture=GPUCanvasContext.prototype.getCurrentTexture;GPUCanvasContext.prototype.getCurrentTexture=function(...args){r.target=texture.apply(this,args);r.fresh=true;return r.target;};
 // The frame (js/main.js frame) runs to its end at once, and its canvas texture lasts until the task does: so the
 // picture is read straight after the frame that drew it, never from a texture an earlier frame took.
 r.grab=()=>{
  if(!r.fresh)throw Error('the frame drew no picture');r.fresh=false;
  const target=r.target,row=Math.ceil(target.width*4/256)*256,read=r.device.createBuffer({size:row*target.height,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}),enc=r.device.createCommandEncoder();enc.copyTextureToBuffer({texture:target},{buffer:read,bytesPerRow:row},[target.width,target.height]);r.device.queue.submit([enc.finish()]);
  return read.mapAsync(GPUMapMode.READ).then(()=>{const raw=new Uint8Array(read.getMappedRange()),pixels=new Uint8Array(target.width*target.height*4);for(let y=0;y<target.height;y++)pixels.set(raw.subarray(y*row,y*row+target.width*4),y*target.width*4);read.unmap();read.destroy();return pixels;});
 };
}
test('GPU terrain occlusion preserves full close-forest, shore, horizon and underwater frames',{timeout:600000},async t=>{
 const server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');let browser;
 const output=process.env.FOREST_OCCLUSION_OUTPUT; if(output)await mkdir(output,{recursive:true});
 try{
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
  const rows=[],scenes=[
   // At 1280 x 720: at 1920 x 1080 the reported canopy asks some 16M triangles of the fixed 1.5 px, more than its lists
   // hold (they are sized for the one 3M budget, whose governor polygons=fixed stills), and there the room occlusion
   // frees goes to the trees it leaves in view (js/wgsl/continuum-cut.js continuumReset): finer than the reference's.
   {name:'reported-close-view',w:'1280',h:'720',cam:'-979.830347,366.080607,-5519.26402,29.742625,1.101069'},
   {name:'reported-close-view-weak-device',w:'1280',h:'720',cam:'-979.830347,366.080607,-5519.26402,29.742625,1.101069',polygons:'0.25',budgetOnly:true},
   {name:'shore',w:'640',h:'360',cam:'-1750,6,-7000,112,1'},
   {name:'horizon',w:'640',h:'360',cam:'-1800,6,10500,6.2,1'},
   {name:'underwater',w:'640',h:'360',cam:'-1800,-4,-7000,112,4'},
  ];
  for(const scene of scenes){const captures=[];
   // The reference is drawn twice, so the scene measures how far two loads of the same frame differ by themselves.
   for(const reference of scene.budgetOnly?[true,false]:[true,true,false]){
    const page=await browser.newPage({viewport:{width:1280,height:720}}),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.addInitScript(forestOcclusionFrameCapture);
    const params=new URLSearchParams({landfall:'approach',view:'free',boat:'0',follower:'0',weather:'clear',skyMode:'manual',astroDate:'2026-10-21T00:00:00.000Z',astroRate:'0',windSpeed:'5.5',windDir:'118',fetchKm:'90',swellHs:'.65',swellDir:'94',swellLength:'120',swellSpread:'48',choppy:'1.25',sunElev:'32',sunAzim:'225',exposure:'1.35',haze:'.8',clouds:'.3',cloudBase:'1.2',cloudDepth:'1.8',cloudDensity:'1',cloudAnvil:'.05',cloudQuality:'.5',bloom:'.1',rain:'0',thunder:'0',ui:'0',resolution:'native',polygons:'fixed',...scene,hiz:reference?'0':'1'});
    try{
     await page.goto('http://127.0.0.1:'+server.address().port+(process.env.FOREST_PACKAGE?'/docs/index.html':'/')+'?'+params);
     await page.waitForFunction(()=>forestOcclusionFrame.waiting.size>0||window.oceanStartup?.state==='failed',undefined,{timeout:180000,polling:50});
     const result=await page.evaluate(async WARM_FRAMES=>{
      const r=forestOcclusionFrame;if(oceanStartup.state==='failed')throw Error(document.querySelector('#err').textContent);
      // Frames at one frozen instant until the coast is ready, its forest stood and the occlusion pyramid made (once the
      // first frames are up; it culls by the depth the frame before laid).
      // Both runs draw the same number of frames, as the frame's jitter and dither follow its count (js/main.js).
      let now=1000000,frames=0;
      for(;frames<4000&&(frames<WARM_FRAMES||!(oceanStartup.state==='ready'&&window.oceanHiZ&&r.indirect.length));frames++){r.step(now);if(r.device)await r.device.queue.onSubmittedWorkDone();await new Promise(resolve=>setTimeout(resolve,10));}
      if(oceanStartup.state!=='ready')throw Error('the coast was never ready: '+oceanStartup.state);
      if(!window.oceanHiZ)throw Error('the continuum\'s occlusion pyramid was never made');
      let image=null;
      for(const step of[0,50,100,150]){r.step(now+step);image=r.grab();await r.device.queue.onSubmittedWorkDone();await image;await new Promise(resolve=>setTimeout(resolve,0));}
      const source=r.indirect[0],read=r.device.createBuffer({size:source.size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}),enc=r.device.createCommandEncoder();enc.copyBufferToBuffer(source,0,read,0,source.size);r.device.queue.submit([enc.finish()]);await read.mapAsync(GPUMapMode.READ);const commands=Array.from(new Uint32Array(read.getMappedRange()));read.unmap();read.destroy();
      // How full each family's fullest list stood (js/continuum-census.js), read a few frames late.
      const census=oceanContinuumCensus.latest,fill=census?Object.fromEntries(Object.entries(census.breakdown).map(([name,b])=>[name,b.maxFill])):null;
      return {pixels:Array.from(await image),commands,fill,errors:r.errors,lost:r.lost,occlusion:oceanHiZ.enabled,state:oceanStartup.state,frames};
     },WARM_FRAMES);
     assert.deepEqual(errors,[]);assert.deepEqual(result.errors,[]);assert.equal(result.lost,undefined);assert.equal(result.state,'ready');assert.equal(result.occlusion,!reference);assert.equal(result.frames,WARM_FRAMES,'the coast was ready within the frames both runs draw');assert.ok(result.pixels.some((v,i)=>i%4!==3&&v>5));captures.push(result);
     if(output){const name=output+'/'+scene.name+(reference?'-reference':'-occlusion')+(captures.length===2&&reference?'-again':'');await page.screenshot({path:name+'.png'});await writeFile(name+`-${scene.w}x${scene.h}.rgba`,Buffer.from(result.pixels));}
    }finally{await page.close();}
   }
   // Channels that differ by more than 8/255, which a tree shows by and dither does not, and the largest difference.
   const compare=(a,b)=>{let differences=0,maxError=0;for(let i=0;i<a.length;i++){const error=Math.abs(a[i]-b[i]);if(error>8)differences++;maxError=Math.max(maxError,error);}return {differences,maxError};};
   const reference=captures[0],occluded=captures.at(-1),noise=scene.budgetOnly?null:compare(reference.pixels,captures[1].pixels);
   // Against the nearer of the two references, so one load's own wander is not counted against occlusion.
   const {differences,maxError}=[captures[0],...(scene.budgetOnly?[]:[captures[1]])].map(c=>compare(c.pixels,occluded.pixels)).sort((a,b)=>a.differences-b.differences)[0];
   const triangles=c=>[0,1,2,3].reduce((sum,list)=>sum+c[list*4]*c[list*4+1]/3,0),row={name:scene.name,channels:reference.pixels.length,differences,maxError,noise,referenceTriangles:triangles(reference.commands),occlusionTriangles:triangles(occluded.commands)};rows.push(row);t.diagnostic(JSON.stringify(row));
   if(output)await writeFile(output+'/receipt.json',JSON.stringify(rows,null,2));
   // A frame compared is one whose cut fits its lists: past them, occlusion rightly changes which trees yield, and how
   // far (tests/continuum-plan-gpu.test.mjs).
   if(!scene.budgetOnly)for(const capture of captures)assert.ok(capture.fill&&Object.values(capture.fill).every(fill=>fill<.9),scene.name+'\'s lists hold its cut: '+JSON.stringify(capture.fill));
   // Within them a frame repeats from one load to the next to a few channels on Metal, and exactly on SwiftShader.
   // Occlusion may differ from the reference no more than the reference differs from itself: a tree it wrongly hid
   // would show past that. The quarter-budget scene exists to read its triangle count.
   if(!scene.budgetOnly)assert.ok(differences<=noise.differences*1.5+Math.ceil(row.channels*4e-5)&&maxError<=Math.max(noise.maxError+8,process.env.WEBGPU_BACKEND==='metal'?16:0),JSON.stringify(row));
  }
  // Checked once every scene has compared its pixels, so a budget miss cannot hide them.
  // Occlusion saves work where solid ground hides the forest: from the sea, the trees behind Saba's cliffs. Among the
  // trees themselves it saves little, since a crown, drawn by its samples' coverage, hides nothing whole (the pyramid
  // keeps the farthest depth of every sample), but it never adds any.
  const close=rows.find(row=>row.name==='reported-close-view'),shore=rows.find(row=>row.name==='shore');
  assert.ok(shore.occlusionTriangles<shore.referenceTriangles*.5,'the continuum\'s indirect work behind the cliffs decreases, without changing pixels: '+JSON.stringify(shore));
  assert.ok(close.occlusionTriangles<=close.referenceTriangles,'occlusion adds no work among the trees: '+JSON.stringify(close));
  // Full budget keeps foreground trees sharp; the adaptive polygon budget must then be able to shed their detail.
  const weak=rows.find(row=>row.name==='reported-close-view-weak-device');
  assert.ok(close.occlusionTriangles<=30000000,'full-budget close canopy stays within 30M indirect triangles: '+JSON.stringify(close));
  assert.ok(weak.occlusionTriangles<=close.occlusionTriangles*.55,'a quarter polygon budget sheds foreground detail: '+JSON.stringify({close,weak}));
 }finally{await browser?.close();server.closeAllConnections?.();await new Promise(r=>server.close(r));}
});

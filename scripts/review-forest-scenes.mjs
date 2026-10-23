#!/usr/bin/env node
// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Root-only rendered review. Production assets, shaders and frames stay intact.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdir,writeFile} from 'node:fs/promises';
import {resolve,join} from 'node:path';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';

const output=resolve(process.env.FOREST_SCENE_OUTPUT||'shots/forest-mass-scenes');
const entry=process.env.FOREST_SCENE_ENTRY||'/';
const stages=(process.env.FOREST_SCENE_STAGES||'horizon,approach,coast').split(',');
const width=Number(process.env.FOREST_SCENE_WIDTH||1280),height=Number(process.env.FOREST_SCENE_HEIGHT||900);
await mkdir(output,{recursive:true});
const server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');
const browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']});
const reports=[];
try{
 for(const stage of stages){
  const page=await browser.newPage({viewport:{width,height}}),errors=[],failed=[];
  page.on('pageerror',e=>{errors.push(e.message);console.log(JSON.stringify({stage,pageError:e.message}));});page.on('console',m=>{if(/init failed|GPU error:|Shader compile error/i.test(m.text()))errors.push(m.text());});
  page.on('requestfailed',r=>failed.push({url:r.url(),error:r.failure()?.errorText}));
  await page.addInitScript(()=>{
   const r=window.forestReview={device:null,buffers:[],errors:[],resident:false,frames:[],start:performance.now(),bytes:0,camera:null};
   const adapter=GPUAdapter.prototype.requestDevice;
   GPUAdapter.prototype.requestDevice=async function(...a){const d=await adapter.apply(this,a);r.device=d;d.addEventListener('uncapturederror',e=>r.errors.push(e.error.message));d.lost.then(e=>r.errors.push(e.message));return d;};
   const create=GPUDevice.prototype.createBuffer;
   GPUDevice.prototype.createBuffer=function(desc){const inspect=['forest GPU indirect draws','forest mass GPU selected blocks','forest mass GPU indirect draws'].includes(desc.label),b=create.call(this,inspect?{...desc,usage:desc.usage|GPUBufferUsage.COPY_SRC}:desc);if((desc.label||'').startsWith('forest ')){r.bytes+=desc.size;r.buffers.push({buffer:b,label:desc.label,size:desc.size,inspect});}return b;};
   const write=GPUQueue.prototype.writeBuffer;
   GPUQueue.prototype.writeBuffer=function(b,o,data,...a){const raw=ArrayBuffer.isView(data)?data.buffer:data,start=ArrayBuffer.isView(data)?data.byteOffset:0;
    if(['forest native residency','forest mass shared native residency'].includes(b.label)&&o===0)r.resident=new Uint32Array(raw,start,1)[0]===1;
    if(b.label.startsWith('frame ubo')&&o===0)r.camera=Array.from(new Float32Array(raw,start,19));
    return write.call(this,b,o,data,...a);};
   const raf=window.requestAnimationFrame;window.requestAnimationFrame=callback=>raf.call(window,time=>{if(window.oceanStartup?.state==='ready'){r.frames.push(time);if(r.frames.length>180)r.frames.shift();}callback(time);});
  });
  const query=new URLSearchParams({landfall:stage,view:'free',boat:'0',prow:'0',follower:'0',fleet:'',crew:'0',effects:'0',clouds:'0',sunElev:'35',sunAzim:'155',windSpeed:'0',swellHs:'0',ui:'0',resolution:'native',w:String(width),h:String(height)});
  if(process.env.FOREST_SCENE_MODE)query.set('forestMass',process.env.FOREST_SCENE_MODE);
  const url='http://127.0.0.1:'+server.address().port+entry+'?'+query,start=performance.now();
  console.log(JSON.stringify({stage,state:'loading',url}));
  await page.goto(url);
  const progress=setInterval(()=>page.evaluate(()=>({state:window.oceanStartup?.state,error:document.querySelector('#err')?.textContent,frames:forestReview.frames.length,resident:forestReview.resident,errors:forestReview.errors,bytes:forestReview.bytes,labels:forestReview.buffers.map(b=>b.label)})).then(status=>console.log(JSON.stringify({stage,status}))).catch(()=>{}),15000);
  try{await page.waitForFunction(()=>window.oceanStartup?.state==='ready'||window.oceanStartup?.state==='failed',undefined,{timeout:180000});}catch(error){clearInterval(progress);throw error;}
  const ready=performance.now()-start;console.log(JSON.stringify({stage,state:'ready',readyMs:ready}));
  assert.equal(await page.locator('#err').textContent(),'');
  await page.waitForFunction(()=>forestReview.resident||forestReview.errors.length,undefined,{timeout:120000});
  await page.waitForFunction(()=>forestReview.frames.length>=90,undefined,{timeout:90000});
  clearInterval(progress);
  const report=await page.evaluate(async()=>{
   const r=forestReview,d=r.device,commands={};await d.queue.onSubmittedWorkDone();
   for(const row of r.buffers.filter(b=>b.inspect)){
    const b=d.createBuffer({size:row.size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}),e=d.createCommandEncoder();e.copyBufferToBuffer(row.buffer,0,b,0,row.size);d.queue.submit([e.finish()]);await b.mapAsync(GPUMapMode.READ);commands[row.label]=Array.from(new Uint32Array(b.getMappedRange()));b.unmap();b.destroy();
   }
   const t=r.frames.slice(-60),fps=(t.length-1)*1000/(t.at(-1)-t[0]);
   return{startup:window.oceanStartup?.state,resident:r.resident,errors:r.errors,camera:r.camera,forestGpuBytes:r.bytes,buffers:r.buffers.map(({buffer,inspect,...b})=>b),commands,fps,canvas:{width:document.querySelector('canvas').width,height:document.querySelector('canvas').height}};
  });
  const screenshot=join(output,stage+'.png');await page.screenshot({path:screenshot});
  report.stage=stage;report.readyMs=ready;report.errors.push(...errors);report.failed=failed;report.screenshot=screenshot;
  const mass=report.commands['forest mass GPU selected blocks']||[];report.massSelected=mass.reduce((a,b)=>a+b,0);
  const rows=report.commands['forest GPU indirect draws']||[];report.instances=Array.from({length:rows.length/5},(_,i)=>rows[i*5+1]);
  assert.deepEqual(report.errors,[]);assert.equal(report.resident,true);assert.ok(report.massSelected>0||process.env.FOREST_SCENE_MODE==='near','actual default must use the native-derived canopy');
  reports.push(report);await writeFile(join(output,'receipt.json'),JSON.stringify({entry,reports},null,2)+'\n');
  console.log(JSON.stringify({stage,readyMs:ready,fps:report.fps,massSelected:report.massSelected,instances:report.instances,forestGpuBytes:report.forestGpuBytes,screenshot}));
  await page.close();
 }
}finally{await browser.close();server.closeAllConnections?.();await new Promise(r=>server.close(r));}

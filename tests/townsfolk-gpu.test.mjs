import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';
import {coastalRegionStageURL} from '../js/landfall.js';

let browser,server,base;
before(async()=>{
  server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');
  base=`http://127.0.0.1:${server.address().port}/`;
  browser=await chromium.launch({args:['--enable-unsafe-webgpu',`--use-angle=${process.env.WEBGPU_BACKEND||'metal'}`,'--disable-gpu-watchdog']});
});
after(async()=>{await browser?.close();server?.closeAllConnections?.();server?.close();});

const instrument=()=>{
  const pass=GPURenderPassEncoder.prototype,pipelines=new WeakMap();window.townDraws=[];window.townCapture=false;
  const setPipeline=pass.setPipeline;pass.setPipeline=function(p){pipelines.set(this,p.label||'');return setPipeline.call(this,p);};
  const indirect=pass.drawIndexedIndirect;pass.drawIndexedIndirect=function(b,o){if(window.townCapture&&pipelines.get(this)==='townsfolk')townDraws.push({buffer:b,offset:o});return indirect.call(this,b,o);};
  const createBuffer=GPUDevice.prototype.createBuffer;
  GPUDevice.prototype.createBuffer=function(d){return createBuffer.call(this,/townsfolk (draws|bodies)/.test(d.label||'')?{...d,usage:d.usage|GPUBufferUsage.COPY_SRC}:d);};
  const request=GPUAdapter.prototype.requestDevice;GPUAdapter.prototype.requestDevice=async function(...a){return window.townDevice=await request.apply(this,a);};
  window.townUploads=[];const write=GPUQueue.prototype.writeBuffer;
  GPUQueue.prototype.writeBuffer=function(b,...rest){if(window.townCapture&&/townsfolk/.test(b.label||''))townUploads.push(b.label);return write.call(this,b,...rest);};
};
const shown=page=>page.evaluate(async()=>{
  townDraws.length=0;townUploads.length=0;townCapture=true;
  await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);townCapture=false;
  if(!townDraws.length)return {bodies:0,draws:0,uploads:[...townUploads]};
  const buffer=townDraws[0].buffer,read=townDevice.createBuffer({size:buffer.size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}),encoder=townDevice.createCommandEncoder();
  encoder.copyBufferToBuffer(buffer,0,read,0,buffer.size);townDevice.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);
  const words=new Uint32Array(read.getMappedRange().slice(0));read.unmap();read.destroy();
  const perTier=[];for(let b=0;b*20<buffer.size;b++)perTier.push(words[b*5+1]);
  return {bodies:perTier.reduce((a,v)=>a+v,0),perTier,draws:townDraws.length,uploads:[...townUploads]};
});
async function open(query){
  const url=coastalRegionStageURL(base,'lisbon','dock','clear',1650);
  for(const [k,v] of Object.entries({w:960,h:540,polygons:'fixed',view:'free',prow:'0',cam:'5,70,-5760,0,-14',...query}))url.searchParams.set(k,String(v));
  const page=await browser.newPage({viewport:{width:960,height:540}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&!/404|favicon/.test(m.text()))errors.push(m.text());});
  await page.addInitScript(instrument);
  await page.goto(url.toString());
  await page.waitForFunction(()=>window.oceanStartup?.state==='ready'||window.oceanStartup?.state==='failed',null,{timeout:180000,polling:200});
  assert.equal(await page.evaluate(()=>window.oceanStartup.state),'ready');
  await page.waitForTimeout(5000);
  return {page,errors};
}

test('people walk the town by compute alone, with no pose or position sent from JavaScript',{timeout:300000},async()=>{
  const {page,errors}=await open({});
  try{
    const day=await shown(page);
    assert.ok(day.bodies>40,`only ${day.bodies} people in view: ${JSON.stringify(day)}`);
    assert.equal(day.draws%8,0,'each body model draws once per level of detail');
    // Resetting the draw counts is all that JavaScript sends once a town is laid out.
    assert.ok(day.uploads.every(label=>label==='townsfolk draws'||label==='townsfolk crowd'),JSON.stringify(day.uploads));
    await page.waitForTimeout(3000);
    const later=await shown(page);
    assert.ok(later.bodies>40,'they keep walking');
    assert.deepEqual(errors,[]);
  }finally{await page.close();}
});

test('most people are indoors at night',{timeout:300000},async()=>{
  const day=await open({sunElev:50});
  const night=await open({sunElev:-30});
  try{
    const light=await shown(day.page),dark=await shown(night.page);
    assert.ok(light.bodies>40,JSON.stringify(light));
    assert.ok(dark.bodies<light.bodies*.4,`${dark.bodies} abroad at night against ${light.bodies} by day`);
    assert.deepEqual([...day.errors,...night.errors],[]);
  }finally{await day.page.close();await night.page.close();}
});

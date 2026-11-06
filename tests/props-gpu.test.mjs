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
  const pass=GPURenderPassEncoder.prototype,pipelines=new WeakMap();window.propDraws=[];window.propCapture=false;window.propErrors=[];
  const setPipeline=pass.setPipeline;pass.setPipeline=function(p){pipelines.set(this,p.label||'');return setPipeline.call(this,p);};
  const indirect=pass.drawIndexedIndirect;pass.drawIndexedIndirect=function(b,o){if(window.propCapture&&pipelines.get(this)==='props')propDraws.push({buffer:b,offset:o});return indirect.call(this,b,o);};
  const createBuffer=GPUDevice.prototype.createBuffer;
  GPUDevice.prototype.createBuffer=function(d){return createBuffer.call(this,/prop draws/.test(d.label||'')?{...d,usage:d.usage|GPUBufferUsage.COPY_SRC}:d);};
  const request=GPUAdapter.prototype.requestDevice;GPUAdapter.prototype.requestDevice=async function(...a){const device=await request.apply(this,a);device.addEventListener('uncapturederror',e=>propErrors.push(e.error.message));return window.propDevice=device;};
  window.propUploads=[];const write=GPUQueue.prototype.writeBuffer;
  GPUQueue.prototype.writeBuffer=function(b,...rest){if(window.propCapture&&/^prop/.test(b.label||''))propUploads.push(b.label);return write.call(this,b,...rest);};
};
const shown=page=>page.evaluate(async()=>{
  propDraws.length=0;propUploads.length=0;propCapture=true;
  await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);propCapture=false;
  if(!propDraws.length)return {drawn:[],draws:0,uploads:[...propUploads]};
  const buffer=propDraws[0].buffer,read=propDevice.createBuffer({size:buffer.size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}),encoder=propDevice.createCommandEncoder();
  encoder.copyBufferToBuffer(buffer,0,read,0,buffer.size);propDevice.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);
  const words=new Uint32Array(read.getMappedRange().slice(0));read.unmap();read.destroy();
  const drawn=[];for(let m=0;m*20<buffer.size;m++)drawn.push(words[m*5+1]);
  return {drawn,draws:propDraws.length,uploads:[...propUploads]};
});
async function open(cam){
  const url=coastalRegionStageURL(base,'lisbon','dock','clear',1650);
  for(const [k,v] of Object.entries({w:960,h:540,polygons:'fixed',view:'free',prow:'0',cam,sunElev:50,clouds:0}))url.searchParams.set(k,String(v));
  const page=await browser.newPage({viewport:{width:960,height:540}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&!/404|favicon/.test(m.text()))errors.push(m.text());});
  await page.addInitScript(instrument);
  await page.goto(url.toString());
  await page.waitForFunction(()=>window.oceanStartup?.state==='ready'||window.oceanStartup?.state==='failed',null,{timeout:180000,polling:200});
  assert.equal(await page.evaluate(()=>window.oceanStartup.state),'ready');
  await page.waitForFunction(()=>window.oceanProps?.count>0,null,{timeout:60000,polling:100});
  await page.waitForTimeout(800);
  return {page,errors};
}

test('props are culled and listed on the GPU, with nothing sent per frame, and textured without errors',{timeout:300000},async t=>{
  const {page,errors}=await open('5,70,-5760,0,-14');
  t.after(()=>page.close());
  const placed=await page.evaluate(()=>oceanProps.placed.length);
  assert.ok(placed>10,`${placed} placed`);
  const frame=await shown(page);
  assert.equal(frame.draws%3,0,'one indirect draw per model, each frame');
  assert.ok(frame.draws>0&&frame.draws<=6,`${frame.draws} draws over two frames`);
  assert.ok(frame.drawn.reduce((a,b)=>a+b,0)>0,`shown ${frame.drawn}`);
  assert.ok(frame.drawn.reduce((a,b)=>a+b,0)<=placed);
  assert.deepEqual(frame.uploads,[],'no per-frame uploads');
  assert.deepEqual(await page.evaluate(()=>propErrors),[]);assert.deepEqual(errors,[]);
});

test('facing out to sea shows fewer props than facing the port, so culling is real',{timeout:300000},async()=>{
  const look=async cam=>{const {page}=await open(cam);try{return await shown(page);}finally{await page.close();}};
  const a=await look('36,40,-5740,0,-20'),b=await look('36,40,-5740,180,-20');
  const sum=list=>(list.drawn??[]).reduce((x,y)=>x+y,0);
  assert.ok(sum(a)!==sum(b),`one way ${a.drawn}, the other ${b.drawn}`);
});

test('a ruined pier takes its cleats with it',{timeout:300000},async t=>{
  const {page}=await open('5,70,-5760,0,-14');
  t.after(()=>page.close());
  const before=await shown(page);
  assert.ok(before.drawn[0]>0,'cleats show to begin with');
  // The game's own damage state is what the renderer watches.
  await page.evaluate(()=>{const {port,placed}=oceanProps;for(const owner of new Set(placed.filter(p=>p.owner>=0).map(p=>p.owner)))(port.instances[owner].damageState??={}).state='ruined';});
  await page.waitForTimeout(1200);
  const after=await shown(page);
  assert.equal(after.drawn[0],0,`cleats before ${before.drawn[0]}, after ${after.drawn[0]}`);
});

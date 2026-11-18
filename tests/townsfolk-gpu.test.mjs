// A town's people in the game itself, kept and placed by the walk pass and drawn through the people continuum
// (js/townsfolk.js on js/crew-continuum-draw.js).
import {test,before,after} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {once} from 'node:events';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';
import {coastalRegionStageURL} from '../js/landfall.js';
import {CONTINUUM_LISTS} from '../js/continuum-format.js';
import {TOWNSFOLK_DISPATCH_WORDS,TOWNSFOLK_MODELS} from '../js/wgsl/townsfolk.js';
import {townsfolkBodiesFor} from '../js/townsfolk.js';

// The bodies' streams are published, not committed: a checkout without them cannot draw people at all.
const baked=townsfolkBodiesFor().every(id=>fs.existsSync(new URL(`../assets/crew/continuum/${id}/atlas.bin.gz`,import.meta.url)));
let browser,server,base;
before(async()=>{
  server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');
  base=`http://127.0.0.1:${server.address().port}/`;
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:['--enable-unsafe-webgpu',`--use-angle=${process.env.WEBGPU_BACKEND||'metal'}`,'--disable-gpu-watchdog']});
});
after(async()=>{await browser?.close();server?.closeAllConnections?.();server?.close();});

const instrument=()=>{
  // The counts the walk pass keeps are read back, so they are made to be copied, and the latest kept.
  window.townCounts=null;window.townUploads=[];window.townCapture=false;
  const createBuffer=GPUDevice.prototype.createBuffer;
  GPUDevice.prototype.createBuffer=function(d){
    if(d.label!=='townsfolk counts')return createBuffer.call(this,d);
    return window.townCounts=createBuffer.call(this,{...d,usage:d.usage|GPUBufferUsage.COPY_SRC});
  };
  const request=GPUAdapter.prototype.requestDevice;GPUAdapter.prototype.requestDevice=async function(...a){return window.townDevice??=await request.apply(this,a);};
  const write=GPUQueue.prototype.writeBuffer;
  GPUQueue.prototype.writeBuffer=function(b,...rest){if(window.townCapture&&/townsfolk/.test(b.label||''))townUploads.push(b.label);return write.call(this,b,...rest);};
};
// How many each body's people the walk kept, and how many instances each of the one cut's lists drew, over a frame:
// its draws buffer opens with every list's indirect record, four words each.
const shown=(page,lists,dispatchWords,models)=>page.evaluate(async({lists,dispatchWords,models})=>{
  townUploads.length=0;townCapture=true;
  await new Promise(requestAnimationFrame);await new Promise(requestAnimationFrame);townCapture=false;
  const device=townDevice,folk=window.oceanTownsfolk;
  const read=async(buffer,bytes)=>{
    const copy=device.createBuffer({size:bytes,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}),encoder=device.createCommandEncoder();
    encoder.copyBufferToBuffer(buffer,0,copy,0,bytes);device.queue.submit([encoder.finish()]);
    await copy.mapAsync(GPUMapMode.READ);const words=new Uint32Array(copy.getMappedRange().slice(0));copy.destroy();return words;
  };
  const counts=townCounts?await read(townCounts,models*dispatchWords*4):null;
  const kept=counts?Array.from({length:models},(_,m)=>counts[m*dispatchWords]):[];
  const drawn=Object.fromEntries(lists.map(name=>[name,0]));
  for(const {buffer} of folk?.continuumDraws?.()??[]){
    const words=await read(buffer,lists.length*16);
    lists.forEach((name,i)=>{drawn[name]+=words[i*4+1];});
  }
  const census=window.oceanContinuumCensus?.latest?.families??null;
  return {error:folk?(folk.error?.message??null):'no town',kept,bodies:kept.reduce((a,v)=>a+v,0),drawn,census,uploads:[...townUploads]};
},{lists,dispatchWords,models});
async function open(query){
  const url=coastalRegionStageURL(base,'lisbon','dock','clear',1650);
  for(const [k,v] of Object.entries({w:960,h:540,polygons:'fixed',view:'free',prow:'0',cam:'5,70,-5760,0,-14',census:'1',...query}))url.searchParams.set(k,String(v));
  const page=await browser.newPage({viewport:{width:960,height:540}}),errors=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(m.type()==='error'&&!/404|favicon/.test(m.text()))errors.push(m.text());if(/Townsfolk|Crew continuum/.test(m.text()))errors.push(m.text());});
  await page.addInitScript(instrument);
  await page.goto(url.toString());
  await page.waitForFunction(()=>window.oceanStartup?.state==='ready'||window.oceanStartup?.state==='failed',null,{timeout:180000,polling:200});
  assert.equal(await page.evaluate(()=>window.oceanStartup.state),'ready');
  await page.waitForTimeout(8000);
  return {page,errors};
}
const look=page=>shown(page,CONTINUUM_LISTS,TOWNSFOLK_DISPATCH_WORDS,TOWNSFOLK_MODELS);

test('people walk the town by compute alone and are cut and drawn through the continuum',{skip:!baked&&'continuum bodies not baked here',timeout:300000},async()=>{
  const {page,errors}=await open({});
  try{
    const day=await look(page);
    console.log('townsfolk',JSON.stringify(day));
    assert.equal(day.error,null,'the town wears the continuum bodies');
    assert.ok(day.bodies>40,`only ${day.bodies} people kept: ${JSON.stringify(day)}`);
    const seen=day.drawn.clusters+day.drawn['small clusters']+day.drawn['far body']+day.drawn.splat;
    assert.ok(seen>0,`drawn: ${JSON.stringify(day.drawn)}`);
    assert.ok(day.drawn['shadow far body']+day.drawn['shadow clusters']>0,'and they cast shadows');
    if(day.census)assert.ok(day.census.people>0,`the census counts them: ${JSON.stringify(day.census)}`);
    // Only the hour, when it moves on, is sent once a town is laid out; the counts are emptied on the GPU.
    assert.ok(day.uploads.every(label=>label==='townsfolk crowd'),JSON.stringify(day.uploads));
    await page.waitForTimeout(3000);
    const later=await look(page);
    assert.ok(later.bodies>40,'they keep walking');
    assert.deepEqual(errors,[]);
  }finally{await page.close();}
});

test('most people are indoors at night',{timeout:300000},async()=>{
  // One page and then the other. While a page of the town is drawing as fast as the GPU lets it, a second page in
  // the same browser is never granted its device, and counting people needs no two pages at once.
  const count=async query=>{const {page,errors}=await open(query);try{return {...await look(page),errors};}finally{await page.close();}};
  const light=await count({sunElev:50}),dark=await count({sunElev:-30});
  assert.ok(light.bodies>40,JSON.stringify(light));
  assert.ok(dark.bodies<light.bodies*.4,`${dark.bodies} abroad at night against ${light.bodies} by day`);
  assert.deepEqual([...light.errors,...dark.errors],[]);
});

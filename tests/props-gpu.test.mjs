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

// Every buffer and bind group of the props, whatever it is called, is counted and every upload to one is seen.
const instrument=()=>{
  const pass=GPURenderPassEncoder.prototype,pipelines=new WeakMap();window.propDraws=[];window.propShadowDraws=0;window.propOtherDraws=0;window.propCapture=false;window.propErrors=[];
  const setPipeline=pass.setPipeline;pass.setPipeline=function(p){pipelines.set(this,p.label||'');return setPipeline.call(this,p);};
  const indirect=pass.drawIndexedIndirect;pass.drawIndexedIndirect=function(b,o){
    const label=pipelines.get(this);
    if(window.propCapture&&label==='props')propDraws.push({buffer:b,offset:o});
    if(window.propCapture&&label==='props shadow')propShadowDraws++;
    return indirect.call(this,b,o);
  };
  const indexed=pass.drawIndexed;pass.drawIndexed=function(...a){if(window.propCapture&&/prop/.test(pipelines.get(this)??''))propOtherDraws++;return indexed.apply(this,a);};
  window.propBuffers={};window.propMade=0;
  const createBuffer=GPUDevice.prototype.createBuffer;
  GPUDevice.prototype.createBuffer=function(d){
    const mine=/prop/.test(d.label||''),buffer=createBuffer.call(this,mine&&!(d.usage&(GPUBufferUsage.MAP_READ|GPUBufferUsage.MAP_WRITE))?{...d,usage:d.usage|GPUBufferUsage.COPY_SRC}:d);
    if(mine){propBuffers[d.label]=buffer;propMade++;}
    return buffer;
  };
  const createBindGroup=GPUDevice.prototype.createBindGroup;
  GPUDevice.prototype.createBindGroup=function(d){if(/prop/.test(d.label||''))propMade++;return createBindGroup.call(this,d);};
  const request=GPUAdapter.prototype.requestDevice;GPUAdapter.prototype.requestDevice=async function(...a){const device=await request.apply(this,a);device.addEventListener('uncapturederror',e=>propErrors.push(e.error.message));return window.propDevice=device;};
  window.propUploads=[];const write=GPUQueue.prototype.writeBuffer;
  GPUQueue.prototype.writeBuffer=function(b,...rest){if(window.propCapture&&/prop/.test(b.label||''))propUploads.push(b.label);return write.call(this,b,...rest);};
  window.propRead=async(label)=>{
    const buffer=propBuffers[label],read=propDevice.createBuffer({size:buffer.size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}),encoder=propDevice.createCommandEncoder();
    encoder.copyBufferToBuffer(buffer,0,read,0,buffer.size);propDevice.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);
    const bytes=read.getMappedRange().slice(0);read.unmap();read.destroy();
    return bytes;
  };
  window.propFrames=async(count)=>{for(let i=0;i<count;i++)await new Promise(requestAnimationFrame);};
};
const shown=page=>page.evaluate(async()=>{
  propDraws.length=0;propShadowDraws=0;propOtherDraws=0;propUploads.length=0;propCapture=true;
  await propFrames(2);propCapture=false;
  if(!propDraws.length)return {drawn:[],draws:0,shadowDraws:propShadowDraws,otherDraws:propOtherDraws,uploads:[...propUploads]};
  const words=new Uint32Array(await propRead('prop draws'));
  const drawn=[];for(let m=0;m*5<words.length;m++)drawn.push(words[m*5+1]);
  return {drawn,draws:propDraws.length,shadowDraws:propShadowDraws,otherDraws:propOtherDraws,uploads:[...propUploads]};
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
// One round shot into a prop, as the guns deliver it. Returns what was sent to the GPU in the two frames after.
const strike=(page,which)=>page.evaluate(async which=>{
  const {applyJettyImpactDamage,jettyLocalToWorld}=await import('/js/port-props.js');
  const {port,placed,models}=oceanProps;
  const prop=which==='cleat'?placed.find(p=>p.model===0):placed.find(p=>p.model>0);
  const model=models[prop.model],state=prop.fracture;
  const shard=state.shards.find(s=>s.tier===2&&state.alive[s.id])??state.shards.find(s=>state.alive[s.id]);
  const worldHit=jettyLocalToWorld(prop,shard.center[0],shard.center[1],shard.center[2],model);
  propUploads.length=0;propCapture=true;
  const report=applyJettyImpactDamage(prop,{shardId:shard.id,localPosition:[...shard.center],position:worldHit,surfacePosition:worldHit,velocity:[320,-10,0],mass:10.9,energy:550000,ammo:'round'},{port,terrain:oceanFleet.terrain});
  await propFrames(2);propCapture=false;
  window.struckProp=prop;
  return {index:placed.indexOf(prop),model:prop.model,owner:prop.owner,shards:state.shards.length,released:report?.releasedShards.length??0,aliveCount:state.aliveCount,flying:state.flight.flying.size,radius:model.radius,uploads:[...propUploads]};
},which);
// A prop as the GPU holds it: its reach, and its block of the shared shard records.
const held=(page,index)=>page.evaluate(async index=>{
  const words=await propRead('props'),floats=new Float32Array(words),ints=new Uint32Array(words),at=index*8;
  const records=new Float32Array(await propRead('prop shard records')),block=ints[at+4]*4,state=oceanProps.placed[index].fracture;
  const mine=[...records.subarray(block+4,block+4+state.flight.records.length)],theirs=[...state.flight.records];
  return {radius:floats[at+7],clockZero:records[block],same:mine.every((v,i)=>v===theirs[i])};
},index);

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

test('a shot breaks a jetty where it stands: the same draws, its shadow kept, its flights in the one shared buffer, and nothing sent once its timber has settled',{timeout:300000},async t=>{
  const {page,errors}=await open('5,70,-5760,0,-14');
  t.after(()=>page.close());
  const before=await shown(page),made=await page.evaluate(()=>propMade);
  assert.equal(before.otherDraws,0);
  assert.ok(before.shadowDraws>0,'props cast shadows to begin with');

  const hit=await strike(page,'jetty');
  assert.ok(hit.released>0,`the shot released ${hit.released} shards`);
  assert.deepEqual([...new Set(hit.uploads)].sort(),['prop shard records','props'],'the hit sends that prop\'s flights and its reach, and nothing else');
  const flying=await shown(page),gpu=await held(page,hit.index);
  assert.equal(flying.draws,before.draws,'the same indirect draws');
  assert.equal(flying.otherDraws,0,'and no draw of its own');
  assert.equal(flying.drawn[hit.model],before.drawn[hit.model],'the broken jetty is still listed, so it is still drawn and still casts its shadow');
  assert.equal(flying.shadowDraws,before.shadowDraws);
  assert.ok(gpu.same,'the GPU holds the flights the game computed');
  assert.ok(gpu.radius>hit.radius,`its reach grows to take in what is in the air: ${gpu.radius} past ${hit.radius}`);
  assert.ok(gpu.clockZero>=0&&gpu.clockZero<600,`its clock is set against the frame's: ${gpu.clockZero}`);

  await page.waitForFunction(()=>struckProp.fracture.flight.flying.size===0,null,{timeout:60000,polling:100});
  await page.evaluate(()=>propFrames(3));
  const settled=await shown(page),rest=await held(page,hit.index);
  assert.deepEqual(settled.uploads,[],'nothing is sent once it has settled');
  assert.equal(settled.drawn[hit.model],before.drawn[hit.model],'what is left of it still stands and is drawn');
  assert.ok(rest.same,'the GPU holds where each shard stopped');
  assert.equal(await page.evaluate(()=>propMade),made,'a hit makes no buffer and no bind group');
  assert.deepEqual(await page.evaluate(()=>propErrors),[]);
  assert.deepEqual(errors,[]);
});

test('debris keeps the simulation\'s time: paused it hangs in the air, and running it falls by the clock, not by the frame',{timeout:300000},async t=>{
  const {page}=await open('5,70,-5760,0,-14');
  t.after(()=>page.close());
  await page.evaluate(()=>document.getElementById('pause-toggle').click());
  assert.equal(await page.evaluate(()=>document.getElementById('pause-toggle').getAttribute('aria-pressed')),'true','paused');
  const hit=await strike(page,'jetty');
  assert.ok(hit.released>0&&hit.flying>0);
  const hung=await page.evaluate(async()=>{const from=struckProp.fracture.now;await propFrames(30);return struckProp.fracture.now-from;});
  assert.equal(hung,0,'no time passes for debris while the simulation is paused');
  const ran=await page.evaluate(async()=>{
    document.getElementById('pause-toggle').click();
    await propFrames(2);
    // The simulation's own step: the time between frames, and never more than a tenth of a second.
    const from=struckProp.fracture.now;let last=await new Promise(requestAnimationFrame),expected=0;
    for(let i=0;i<45;i++){const now=await new Promise(requestAnimationFrame);expected+=Math.min(0.1,(now-last)/1000);last=now;}
    return {advanced:struckProp.fracture.now-from,expected};
  });
  assert.ok(Math.abs(ran.advanced-ran.expected)<0.12,`debris clock advanced ${ran.advanced.toFixed(3)} s over ${ran.expected.toFixed(3)} s of simulation`);
});

test('a broken cleat goes with its pier when the pier is ruined',{timeout:300000},async t=>{
  const {page}=await open('5,70,-5760,0,-14');
  t.after(()=>page.close());
  const hit=await strike(page,'cleat');
  assert.ok(hit.released>0&&hit.owner>=0,`a cleat on a pier, ${hit.released} shards off`);
  await page.waitForTimeout(600);
  assert.ok((await held(page,hit.index)).radius>0,'broken, it is still drawn on its pier');
  await page.evaluate(()=>{const {port,placed}=oceanProps;for(const owner of new Set(placed.filter(p=>p.owner>=0).map(p=>p.owner)))(port.instances[owner].damageState??={}).state='ruined';});
  await page.waitForTimeout(1200);
  const after=await shown(page);
  assert.equal(after.drawn[0],0,'no cleat is listed');
  assert.equal(after.otherDraws,0,'and none is drawn any other way');
  assert.equal((await held(page,hit.index)).radius,0,'the broken one has no reach left');
});

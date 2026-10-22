// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Real source/Pages startups, resources and submitted GPU work. No substituted
// forest renderer, shader, frame source, culling result or asset response.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import {before,after,test} from 'node:test';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';

let server,browser,origin;
before(async()=>{
  server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');origin='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'
    ?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
});
after(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));});

function instrumentProductionForest(){
  const r=window.productionForestGPU={callback:null,device:null,frame:0,now:null,errors:[],lost:null,buffers:[],writes:[],dispatches:[],draws:[],manifest:null,manifestPending:null,lastCamera:null,rootUpload:null,nativeResident:false};
  window.requestAnimationFrame=callback=>{r.callback=callback;return 1;};
  const request=GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice=async function(...args){const d=await request.apply(this,args);r.device=d;d.addEventListener('uncapturederror',e=>r.errors.push(e.error.message));d.lost.then(info=>r.lost=info.message);return d;};
  const fetchOriginal=window.fetch;
  window.fetch=async function(...args){
    const response=await fetchOriginal.apply(this,args),url=new URL(typeof args[0]==='string'?args[0]:args[0].url,location.href);
    if(/\/assets\/forest-scenery\/saba\/manifest(?:\.[a-f0-9]{16})?\.json$/.test(url.pathname)&&response.ok){
      r.manifestPending=response.clone().json().then(value=>{r.manifest=value;});
    }
    return response;
  };
  const create=GPUDevice.prototype.createBuffer;
  GPUDevice.prototype.createBuffer=function(desc){
    // Readback-only usage for the existing indirect buffer; its bytes and all
    // runtime writes/dispatches remain untouched. No other usage is changed.
    const inspect=desc.label==='forest GPU indirect draws',buffer=create.call(this,inspect?{...desc,usage:desc.usage|GPUBufferUsage.COPY_SRC}:desc);
    if((desc.label||'').startsWith('forest '))r.buffers.push({buffer,label:desc.label,size:desc.size,usage:desc.usage,readbackAdded:inspect});
    return buffer;
  };
  const write=GPUQueue.prototype.writeBuffer;
  GPUQueue.prototype.writeBuffer=function(buffer,offset,data,dataOffset=0,size){
    const element=ArrayBuffer.isView(data)?data.BYTES_PER_ELEMENT??1:1;
    const backing=ArrayBuffer.isView(data)?data.buffer:data;
    const start=(ArrayBuffer.isView(data)?data.byteOffset:0)+dataOffset*element;
    const bytes=size===undefined?(ArrayBuffer.isView(data)?data.byteLength:data.byteLength)-dataOffset*element:size*element;
    const resident=buffer.label==='forest native residency'?new Uint32Array(backing,start,1)[0]:undefined;
    if(resident!==undefined)r.nativeResident=resident===1;
    if(buffer.label.startsWith('forest '))r.writes.push({frame:r.frame,label:buffer.label,offset,bytes,...(resident===undefined?{}:{resident})});
    if(buffer.label==='forest immutable root transforms'&&offset===0){
      const values=new Float32Array(backing,start,bytes/4),byPrototype={};let active=0,excluded=0;
      for(let i=0;i<values.length;i+=12){if(values[i+3]>0){active++;byPrototype[values[i+8]]=(byPrototype[values[i+8]]||0)+1;}else excluded++;}
      r.rootUpload={total:values.length/12,active,excluded,byPrototype};
    }
    if(buffer.label.startsWith('frame ubo')&&offset===0&&bytes>=128)r.lastCamera=Array.from(new Float32Array(backing,start,19));
    return size===undefined?write.call(this,buffer,offset,data,dataOffset):write.call(this,buffer,offset,data,dataOffset,size);
  };
  const computePasses=new WeakMap(),computeSet=GPUComputePassEncoder.prototype.setPipeline;
  GPUComputePassEncoder.prototype.setPipeline=function(pipeline){computePasses.set(this,pipeline.label);return computeSet.call(this,pipeline);};
  const dispatch=GPUComputePassEncoder.prototype.dispatchWorkgroups;
  GPUComputePassEncoder.prototype.dispatchWorkgroups=function(x,y=1,z=1){
    const label=computePasses.get(this);if(label?.startsWith('forest '))r.dispatches.push({frame:r.frame,label,x,y,z});
    return dispatch.call(this,x,y,z);
  };
  const groupEntries=new WeakMap(),makeGroup=GPUDevice.prototype.createBindGroup;
  GPUDevice.prototype.createBindGroup=function(desc){const g=makeGroup.call(this,desc);groupEntries.set(g,desc.entries);return g;};
  const renderPasses=new WeakMap(),renderState=pass=>{let s=renderPasses.get(pass);if(!s){s={pipeline:'',vertex:null,index:null,groups:new Map()};renderPasses.set(pass,s);}return s;};
  const renderSet=GPURenderPassEncoder.prototype.setPipeline;
  GPURenderPassEncoder.prototype.setPipeline=function(pipeline){renderState(this).pipeline=pipeline.label;return renderSet.call(this,pipeline);};
  const vertex=GPURenderPassEncoder.prototype.setVertexBuffer;
  GPURenderPassEncoder.prototype.setVertexBuffer=function(slot,buffer,...args){if(slot===0)renderState(this).vertex=buffer;return vertex.call(this,slot,buffer,...args);};
  const index=GPURenderPassEncoder.prototype.setIndexBuffer;
  GPURenderPassEncoder.prototype.setIndexBuffer=function(buffer,...args){renderState(this).index=buffer;return index.call(this,buffer,...args);};
  const group=GPURenderPassEncoder.prototype.setBindGroup;
  GPURenderPassEncoder.prototype.setBindGroup=function(slot,value,...args){renderState(this).groups.set(slot,value);return group.call(this,slot,value,...args);};
  const draw=GPURenderPassEncoder.prototype.drawIndexedIndirect;
  GPURenderPassEncoder.prototype.drawIndexedIndirect=function(buffer,offset){
    const state=renderState(this);
    if(state.pipeline.startsWith('instanced forest ')){
      const entries=groupEntries.get(state.groups.get(2))??[],label=binding=>entries.find(e=>e.binding===binding)?.resource.buffer?.label;
      r.draws.push({frame:r.frame,pipeline:state.pipeline,command:buffer.label,offset,vertex:state.vertex?.label,index:state.index?.label,roots:label(0),visible:label(1),resident:r.nativeResident});
    }
    return draw.call(this,buffer,offset);
  };
  r.snapshot=async()=>{
    await r.manifestPending;
    const record=r.buffers.find(b=>b.label==='forest GPU indirect draws');if(!record)throw Error('Actual forest indirect buffer was never allocated');
    const read=r.device.createBuffer({label:'test forest readback',size:record.size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ});
    const encoder=r.device.createCommandEncoder();encoder.copyBufferToBuffer(record.buffer,0,read,0,record.size);r.device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);
    const commands=Array.from(new Uint32Array(read.getMappedRange()));read.unmap();read.destroy();
    return {frame:r.frame,startup:window.oceanStartup?.state,errors:r.errors,lost:r.lost,manifest:r.manifest,rootUpload:r.rootUpload,camera:r.lastCamera,nativeResident:r.nativeResident,
      buffers:r.buffers.map(({buffer,...data})=>data),writes:r.writes.slice(),dispatches:r.dispatches.slice(),draws:r.draws.slice(),commands};
  };
}
async function forestFrame(page){
  await page.evaluate(async()=>{
    const r=productionForestGPU,callback=r.callback;if(typeof callback!=='function')throw Error('Missing production animation frame');
    r.callback=null;r.frame++;r.now=(r.now??performance.now())+1000/60;callback(r.now);
    await r.device.queue.onSubmittedWorkDone();await new Promise(resolve=>setTimeout(resolve,0));
  });
}
function assertGPUFrame(snapshot,frame,manifest){
  const reset=snapshot.dispatches.filter(d=>d.frame===frame&&d.label==='forest reset indirect counts');
  const cull=snapshot.dispatches.filter(d=>d.frame===frame&&d.label==='forest cull and LOD');
  assert.equal(reset.length,1,'actual forest reset dispatch on frame '+frame);assert.equal(cull.length,1,'actual forest cull dispatch on frame '+frame);
  assert.equal(reset[0].x,Math.ceil(manifest.prototypes.length*4/64));assert.equal(cull[0].x,Math.ceil(manifest.rootCount/64));
  assert.deepEqual([reset[0].y,reset[0].z,cull[0].y,cull[0].z],[1,1,1,1]);
  const draws=snapshot.draws.filter(d=>d.frame===frame);
  const resident=draws.some(d=>d.resident);assert.ok(draws.every(d=>d.resident===resident),'residency changes only between submitted frames');
  assert.equal(draws.length,manifest.prototypes.length*(resident?4:1),'native resources are addressed only after complete residency');
  assert.equal(draws.filter(d=>d.pipeline==='instanced forest forestNativeOpaqueFS').length,resident?manifest.prototypes.length*2:0);
  assert.equal(draws.filter(d=>d.pipeline==='instanced forest forestNativeLeafFS').length,resident?manifest.prototypes.length:0);
  assert.equal(draws.filter(d=>d.pipeline==='instanced forest native depth impostor').length,manifest.prototypes.length);
  assert.deepEqual(draws.map(d=>d.offset).sort((a,b)=>a-b),resident?Array.from({length:manifest.prototypes.length*4},(_,i)=>i*20):manifest.prototypes.map(p=>(p.id*4+3)*20));
  for(const draw of draws){
    assert.deepEqual([draw.command,draw.roots,draw.visible],['forest GPU indirect draws','forest immutable root transforms','forest GPU visible root IDs']);
    if(draw.pipeline==='instanced forest native depth impostor')assert.equal(draw.index,'forest immutable impostor quad indices');
    else assert.deepEqual([draw.vertex,draw.index],['forest immutable prototype vertices','forest immutable prototype indices']);
  }
}
function assertUploadedOnce(snapshot,label,size){
  const buffers=snapshot.buffers.filter(b=>b.label===label),writes=snapshot.writes.filter(w=>w.label===label).sort((a,b)=>a.offset-b.offset);
  assert.equal(buffers.length,1,label+' allocated once');assert.equal(buffers[0].size,size);
  let end=0;for(const write of writes){assert.equal(write.offset,end,label+' has no duplicate or missing byte ranges');assert.ok(write.bytes>0);end+=write.bytes;}
  assert.equal(end,size,label+' bytes uploaded exactly once');
}
function assertVisibleCounts(snapshot){
  const {manifest,commands}=snapshot;assert.equal(commands.length,manifest.prototypes.length*20);
  let visible=0;
  for(const p of manifest.prototypes){
    const counts=[];
    for(const [i,key]of ['wood','leaf','far'].entries()){
      const command=commands.slice((p.id*4+i)*5,(p.id*4+i+1)*5),range=p[key];
      assert.deepEqual([command[0],command[2],command[3],command[4]],[range.indexCount,range.firstIndex,0,0],'actual immutable draw topology for '+p.species+'/'+key);
      assert.ok(command[1]<=p.rootCount,'GPU compaction fits its actual prototype root partition');counts.push(command[1]);
    }
    const atlas=commands.slice((p.id*4+3)*5,(p.id*4+4)*5);assert.deepEqual([atlas[0],atlas[2],atlas[3],atlas[4]],[6,0,0,0]);
    assert.ok(atlas[1]<=p.rootCount);counts.push(atlas[1]);
    assert.equal(counts[0],counts[1],'wood and foliage use the same near roots');
    assert.ok(counts[0]+counts[2]+counts[3]<=p.rootCount);visible+=counts[0]+counts[2]+counts[3];
  }
  assert.ok(visible>0&&visible<=snapshot.rootUpload.active,'actual visible forest counts must be nonzero and bounded');
  return visible;
}

for(const path of ['/','/docs/index.html'])test(`${path} real forest keeps prototypes immutable and culls/draws roots on GPU after camera movement`,{timeout:360000},async t=>{
  const expected=JSON.parse(await readFile(new URL('../assets/forest-scenery/saba/manifest.json',import.meta.url),'utf8'));
  const page=await browser.newPage({viewport:{width:640,height:480}}),errors=[],requests=[];
  page.on('pageerror',e=>errors.push(e.message));page.on('console',m=>{if(/init failed|GPU error:|Shader compile error/i.test(m.text()))errors.push(m.text());});
  page.on('request',r=>{if(r.url().includes('/assets/forest-scenery/'))requests.push(r.url());});
  await page.addInitScript(instrumentProductionForest);
  let releaseNative;const nativeGate=new Promise(resolve=>releaseNative=resolve);
  // Delay actual responses, then continue their unchanged production request.
  // This proves first readiness without substituting geometry or atlas bytes.
  await page.route('**/assets/forest-scenery/**',async route=>{
    const path=new URL(route.request().url()).pathname;
    if(!path.includes('/impostors/')&&(/\/(vertices|indices)\.bin(?:\.[a-f0-9]{16})?\.gz$/.test(path)||path.endsWith('.png')))await nativeGate;
    await route.continue();
  });
  const query=new URLSearchParams({landfall:'coast',view:'free',boat:'0',prow:'0',boatX:'0',boatZ:'0',follower:'0',fleet:'',crew:'0',effects:'0',clouds:'0',sunElev:'35',windSpeed:'0',swellHs:'0',ui:'0',w:'640',h:'480'});
  try{
    await page.goto(origin+path+'?'+query);
    await page.waitForFunction(()=>productionForestGPU.callback||window.oceanStartup?.state==='failed'||document.querySelector('#err')?.textContent,undefined,{polling:100,timeout:240000});
    assert.equal(await page.locator('#err').textContent(),'',errors.join('\n'));
    for(let i=0;i<4;i++)await forestFrame(page);
    await page.waitForFunction(()=>window.oceanStartup?.state==='ready',undefined,{timeout:30000});
    const preview=await page.evaluate(()=>productionForestGPU.snapshot());
    assert.equal(preview.startup,'ready');assert.equal(preview.nativeResident,false);
    assert.equal(preview.buffers.some(b=>b.label==='forest immutable prototype vertices'||b.label==='forest immutable prototype indices'),false,'first ready frame needs no native geometry');
    for(let frame=1;frame<=preview.frame;frame++)assertGPUFrame(preview,frame,preview.manifest);
    assertVisibleCounts(preview);assert.deepEqual(preview.errors,[]);
    releaseNative();await page.waitForFunction(()=>productionForestGPU.nativeResident,undefined,{polling:100,timeout:180000});
    await forestFrame(page);const initial=await page.evaluate(()=>productionForestGPU.snapshot());
    assert.equal(initial.startup,'ready');assert.deepEqual(initial.errors,[]);assert.equal(initial.lost,null);assert.deepEqual(errors,[]);
    assert.equal(initial.manifest.format,'waterworld.forest-instances');assert.deepEqual(initial.manifest.files,expected.files);
    assert.equal(initial.manifest.prototypes.length,5);assert.ok(initial.manifest.rootCount>10000);
    assert.deepEqual([...new Set(initial.manifest.prototypes.map(p=>p.species))].sort(),['birch','chestnut','elm','maple','oak']);
    assert.equal(initial.rootUpload.total,initial.manifest.rootCount);assert.ok(initial.rootUpload.active>10000);
    assert.equal(initial.rootUpload.active+initial.rootUpload.excluded,initial.rootUpload.total);assert.equal(Object.keys(initial.rootUpload.byPrototype).length,5);
    for(const [label,size]of [['forest immutable root transforms',expected.files['roots.bin'].bytes],['forest immutable prototype vertices',expected.files['vertices.bin'].bytes],['forest immutable prototype indices',expected.files['indices.bin'].bytes],['forest prototype bounds and ranges',5*80]]){
      assertUploadedOnce(initial,label,size);
    }
    assert.deepEqual(initial.writes.filter(w=>w.label==='forest native residency').map(w=>w.resident),[0,1],'one transition after complete native uploads');
    assert.equal(initial.buffers.filter(b=>b.readbackAdded).length,1,'only the actual indirect buffer gets diagnostic COPY_SRC');
    for(let frame=1;frame<=initial.frame;frame++)assertGPUFrame(initial,frame,initial.manifest);
    const beforeVisible=assertVisibleCounts(initial);
    for(const name of ['manifest','vertices','indices','roots']){
      assert.ok(requests.some(url=>{
        const parts=new URL(url).pathname.split('/').at(-1).split('.'),extension=name==='manifest'?'json':'gz';
        if(parts[0]!==name||parts.at(-1)!==extension||(name!=='manifest'&&parts[1]!=='bin'))return false;
        return path==='/docs/index.html'?parts.length===(name==='manifest'?3:4)&&/^[a-f0-9]{16}$/.test(parts.at(-2)):parts.length===(name==='manifest'?2:3);
      }),'actual compressed production '+name+' asset request');
    }
    // Real free-camera drag and movement, not a replacement Frame UBO or a
    // fixture-only camera. The same production RAF drives the later dispatches.
    await page.mouse.move(480,300);await page.mouse.down();await page.mouse.move(410,310,{steps:4});await page.mouse.up();
    await page.keyboard.down('w');for(let i=0;i<3;i++)await forestFrame(page);await page.keyboard.up('w');
    for(let i=0;i<3;i++)await forestFrame(page);
    const moved=await page.evaluate(()=>productionForestGPU.snapshot());
    assert.notDeepEqual(moved.camera.slice(0,16),initial.camera.slice(0,16),'production camera view changed');
    assert.notDeepEqual(moved.camera.slice(16,19),initial.camera.slice(16,19),'production camera position changed');
    assert.deepEqual(moved.buffers,initial.buffers,'camera movement allocates no replacement forest geometry/roots');
    assert.deepEqual(moved.writes,initial.writes,'every forest buffer stays CPU-immutable during later frames');
    for(let frame=initial.frame+1;frame<=moved.frame;frame++)assertGPUFrame(moved,frame,moved.manifest);
    const afterVisible=assertVisibleCounts(moved);
    assert.deepEqual(moved.errors,[]);assert.equal(moved.lost,null);assert.deepEqual(errors,[]);
    t.diagnostic(JSON.stringify({path,roots:initial.rootUpload,prototypes:5,visibleBefore:beforeVisible,visibleAfter:afterVisible,frames:moved.frame,immutableUploads:initial.writes.length}));
  }finally{releaseNative();await page.close();}
});

// Copyright (c) 2026 Six Cailloux, LLC. MIT. Root alone executes checks.
// Actual sea-level production frames and assets; COPY_SRC only adds inspection.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {test} from 'node:test';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';

function observeProductionCanopy(){
  const r=window.closedForestGPU={callback:null,device:null,frame:0,now:null,errors:[],lost:null,buffers:[],writes:[],copies:[],dispatches:[],draws:[],bundles:[],executions:[],pipelines:[],pending:[],forest:null,canopy:null,roots:null,owners:null,resident:false};
  window.requestAnimationFrame=callback=>{r.callback=callback;return 1;};
  const request=GPUAdapter.prototype.requestDevice;GPUAdapter.prototype.requestDevice=async function(...args){const device=await request.apply(this,args);r.device=device;device.addEventListener('uncapturederror',e=>r.errors.push(e.error.message));device.lost.then(info=>{if(info.reason!=='destroyed')r.lost=info.message;});return device;};
  const fetchOriginal=window.fetch;window.fetch=async function(...args){
    const response=await fetchOriginal.apply(this,args),path=new URL(typeof args[0]==='string'?args[0]:args[0].url,location.href).pathname;
    if(response.ok&&/\/assets\/forest-scenery\/saba\/(?:canopy\/)?manifest(?:\.[a-f0-9]{16})?\.json$/.test(path))r.pending.push(response.clone().json().then(m=>{if(m.format==='waterworld.forest-canopy')r.canopy=m;else if(m.format==='waterworld.forest-instances')r.forest=m;}));
    if(response.ok&&/\/canopy\/root-chunks\.bin(?:\.[a-f0-9]{16})?(?:\.gz)?$/.test(path))r.pending.push((async()=>{let bytes=await response.clone().arrayBuffer();if(path.endsWith('.gz'))bytes=await new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();r.owners=new Uint32Array(bytes);})());
    return response;
  };
  const inspect=new Set(['forest GPU indirect draws','forest GPU visible root IDs','forest canopy GPU selected chunks','forest canopy GPU indirect draws']);
  const create=GPUDevice.prototype.createBuffer;GPUDevice.prototype.createBuffer=function(description){const buffer=create.call(this,inspect.has(description.label)?{...description,usage:description.usage|GPUBufferUsage.COPY_SRC}:description);if(description.label?.startsWith('forest '))r.buffers.push({buffer,label:description.label,size:description.size});return buffer;};
  const cpuWriteFrames=new WeakMap(),write=GPUQueue.prototype.writeBuffer;GPUQueue.prototype.writeBuffer=function(buffer,offset,data,dataOffset=0,size){
    cpuWriteFrames.set(buffer,r.frame);
    if(buffer.label.startsWith('forest ')){
      const element=ArrayBuffer.isView(data)?data.BYTES_PER_ELEMENT??1:1,backing=ArrayBuffer.isView(data)?data.buffer:data,start=(ArrayBuffer.isView(data)?data.byteOffset:0)+dataOffset*element;
      const bytes=size===undefined?data.byteLength-dataOffset*element:size*element;r.writes.push({frame:r.frame,label:buffer.label,offset,bytes});
      if(buffer.label==='forest native residency')r.resident=new Uint32Array(backing,start,1)[0]===1;
      if(buffer.label==='forest immutable root transforms'&&offset===0)r.roots=new Float32Array(backing.slice(start,start+bytes));
    }
    return size===undefined?write.call(this,buffer,offset,data,dataOffset):write.call(this,buffer,offset,data,dataOffset,size);
  };
  const copy=GPUCommandEncoder.prototype.copyBufferToBuffer;GPUCommandEncoder.prototype.copyBufferToBuffer=function(source,sourceOffset,destination,...args){
    const written=cpuWriteFrames.get(source);if(written!==undefined)cpuWriteFrames.set(destination,written);
    const immutable=/^forest (?:immutable |canopy immutable |prototype bounds and ranges)/.test(destination.label),cpuOutput=written===r.frame&&r.frame>0&&/^forest (?:GPU (?:visible root IDs|indirect draws)|canopy GPU indirect draws)$/.test(destination.label);
    if(immutable||cpuOutput)r.copies.push({frame:r.frame,label:destination.label,cpuOutput});return copy.call(this,source,sourceOffset,destination,...args);
  };
  const makePipeline=GPUDevice.prototype.createRenderPipelineAsync;GPUDevice.prototype.createRenderPipelineAsync=async function(description){
    if(description.label?.startsWith('forest ')||description.label?.startsWith('instanced forest '))r.pipelines.push({label:description.label,fragment:description.fragment.entryPoint,depth:description.depthStencil,msaa:description.multisample,blend:description.fragment.targets.map(t=>t.blend??null)});
    return makePipeline.call(this,description);
  };
  const computePipelines=new WeakMap(),setCompute=GPUComputePassEncoder.prototype.setPipeline;GPUComputePassEncoder.prototype.setPipeline=function(pipeline){computePipelines.set(this,pipeline.label);return setCompute.call(this,pipeline);};
  const dispatch=GPUComputePassEncoder.prototype.dispatchWorkgroups;GPUComputePassEncoder.prototype.dispatchWorkgroups=function(x,y=1,z=1){const label=computePipelines.get(this);if(label?.startsWith('forest '))r.dispatches.push({frame:r.frame,label,x,y,z});return dispatch.call(this,x,y,z);};
  const labels=new WeakMap(),setRender=GPURenderPassEncoder.prototype.setPipeline;GPURenderPassEncoder.prototype.setPipeline=function(pipeline){labels.set(this,pipeline.label);return setRender.call(this,pipeline);};
  const draw=GPURenderPassEncoder.prototype.drawIndexedIndirect;GPURenderPassEncoder.prototype.drawIndexedIndirect=function(buffer,offset){if(buffer.label.startsWith('forest '))r.draws.push({frame:r.frame,label:labels.get(this),buffer:buffer.label,offset});return draw.call(this,buffer,offset);};
  const bundleEncoders=new WeakMap(),bundleObjects=new WeakMap(),makeBundle=GPUDevice.prototype.createRenderBundleEncoder;
  GPUDevice.prototype.createRenderBundleEncoder=function(description){const encoder=makeBundle.call(this,description);bundleEncoders.set(encoder,{label:description.label,draws:[]});return encoder;};
  const bundleDraw=GPURenderBundleEncoder.prototype.drawIndexedIndirect;GPURenderBundleEncoder.prototype.drawIndexedIndirect=function(buffer,offset){bundleEncoders.get(this)?.draws.push({buffer:buffer.label,offset});return bundleDraw.call(this,buffer,offset);};
  const finish=GPURenderBundleEncoder.prototype.finish;GPURenderBundleEncoder.prototype.finish=function(...args){const bundle=finish.apply(this,args),record=bundleEncoders.get(this);if(record){bundleObjects.set(bundle,record);if(record.label?.startsWith('forest '))r.bundles.push(record);}return bundle;};
  const execute=GPURenderPassEncoder.prototype.executeBundles;GPURenderPassEncoder.prototype.executeBundles=function(bundles){for(const bundle of bundles){const record=bundleObjects.get(bundle);if(record?.label.startsWith('forest '))r.executions.push({frame:r.frame,label:record.label,draws:record.draws.length});}return execute.call(this,bundles);};
  const readBuffer=async label=>{
    const record=r.buffers.find(b=>b.label===label);if(!record)throw Error('Missing actual production buffer: '+label);
    const read=r.device.createBuffer({label:'test closed forest readback',size:record.size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}),e=r.device.createCommandEncoder();e.copyBufferToBuffer(record.buffer,0,read,0,record.size);r.device.queue.submit([e.finish()]);await read.mapAsync(GPUMapMode.READ);const values=new Uint32Array(read.getMappedRange()).slice();read.unmap();read.destroy();return values;
  };
  r.snapshot=async()=>{
    await Promise.all(r.pending);if(!r.forest||!r.canopy||!r.roots||!r.owners)throw Error('Actual source/canopy/root records missing');
    for(let root=0;root<r.owners.length;root++)if(r.roots[root*12+10]!== (r.owners[root]===0xffffffff?-1:r.owners[root]))throw Error('Production root owner differs from the exact original root-chunks stream');
    const [commands,visible,massCommands,selected]=await Promise.all(['forest GPU indirect draws','forest GPU visible root IDs','forest canopy GPU indirect draws','forest canopy GPU selected chunks'].map(readBuffer));
    const ownerVisible=new Uint32Array(r.canopy.chunks.length),duplicates=[],counts=[];let duplicateCount=0,visibleCount=0,atlasCount=0,massCount=0;
    for(const chunk of r.canopy.chunks){const command=Array.from(massCommands.subarray(chunk.id*5,chunk.id*5+5));if(command.join(',')!==[chunk.indexCount,selected[chunk.id],chunk.firstIndex,0,0].join(','))throw Error('Mass indirect topology/count mismatch');massCount+=command[1];}
    for(const p of r.forest.prototypes){
      const command=commands.subarray(p.id*20,p.id*20+20),tiers=[command[1],command[11],command[16]];counts.push({id:p.id,near:tiers[0],far:tiers[1],atlas:tiers[2]});atlasCount+=tiers[2];
      if(command[6]!==tiers[0])throw Error('Native wood/leaf root counts differ');
      for(let tier=0;tier<3;tier++)for(let i=0;i<tiers[tier];i++){
        const root=visible[p.firstRoot*3+tier*p.rootCount+i],owner=r.roots[root*12+10];visibleCount++;
        if(!Number.isInteger(root)||root>=r.forest.rootCount)throw Error('Invalid visible native root ID');
        if(owner>=0&&owner<selected.length){ownerVisible[owner]++;if(selected[owner]){duplicateCount++;if(duplicates.length<8)duplicates.push({root,owner,tier});}}
      }
    }
    return {frame:r.frame,startup:window.oceanStartup?.state,errors:r.errors,lost:r.lost,resident:r.resident,rootCount:r.forest.rootCount,chunkCount:r.canopy.chunks.length,massCount,visibleCount,atlasCount,duplicateCount,duplicates,counts,selected:Array.from(selected),ownerVisible:Array.from(ownerVisible),
      immutableSizes:{'forest canopy immutable vertices':r.canopy.files['vertices.bin'].bytes,'forest canopy immutable indices':r.canopy.files['indices.bin'].bytes,'forest canopy immutable chunks':r.canopy.chunks.length*64,'forest immutable root transforms':r.forest.files['roots.bin'].bytes,'forest immutable prototype vertices':r.forest.files['vertices.bin'].bytes,'forest immutable prototype indices':r.forest.files['indices.bin'].bytes,'forest GPU visible root IDs':r.forest.rootCount*12},
      buffers:r.buffers.map(({buffer,...d})=>d),writes:r.writes.slice(),copies:r.copies.slice(),dispatches:r.dispatches.slice(),draws:r.draws.slice(),bundles:r.bundles,pipelines:r.pipelines,executions:r.executions.slice()};
  };
}
async function productionFrame(page){await page.evaluate(async()=>{const r=closedForestGPU,callback=r.callback;if(typeof callback!=='function')throw Error('Missing production RAF');r.callback=null;r.frame++;r.now=(r.now??performance.now())+1000/60;callback(r.now);await r.device.queue.onSubmittedWorkDone();await new Promise(resolve=>setTimeout(resolve,0));});}

test('actual sea-level ridge changes from solid startup mass to opaque/native GPU LOD without transparent atlas or duplicate roots',{timeout:600000},async t=>{
  const server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');let browser,page,releaseNative;
  try{
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
    page=await browser.newPage({viewport:{width:640,height:480}});const errors=[],requests=[];page.on('pageerror',e=>errors.push(e.message));page.on('request',request=>{if(request.url().includes('/assets/forest-scenery/'))requests.push(request.url());});await page.addInitScript(observeProductionCanopy);
    const gate=new Promise(resolve=>releaseNative=resolve);
    await page.route('**/assets/forest-scenery/**',async route=>{
      const path=new URL(route.request().url()).pathname;
      if(!path.includes('/canopy/')&&(/\/(vertices|indices)\.bin(?:\.[a-f0-9]{16})?(?:\.gz)?$/.test(path)||path.endsWith('.png')))await gate;
      await route.continue();
    });
    const query=new URLSearchParams({landfall:'approach',view:'free',cam:'-1500,3,-9500,180,5',boat:'0',prow:'0',follower:'0',fleet:'',crew:'0',effects:'0',clouds:'0',sunElev:'35',windSpeed:'0',swellHs:'0',ui:'0',w:'640',h:'480'});
    await page.goto('http://127.0.0.1:'+server.address().port+'/?'+query);
    await page.waitForFunction(()=>closedForestGPU.callback||window.oceanStartup?.state==='failed'||document.querySelector('#err')?.textContent,undefined,{polling:100,timeout:240000});
    assert.equal(await page.locator('#err').textContent(),'',errors.join('\n'));for(let i=0;i<4;i++)await productionFrame(page);
    await page.waitForFunction(()=>window.oceanStartup?.state==='ready',undefined,{timeout:30000});const preview=await page.evaluate(()=>closedForestGPU.snapshot());
    assert.equal(preview.resident,false);assert.ok(preview.massCount>0,'first real sea-level frame shows solid distant forest');assert.equal(preview.visibleCount,0,'unavailable native buffers are never addressed');assert.equal(preview.atlasCount,0);
    releaseNative();await page.waitForFunction(()=>closedForestGPU.resident,undefined,{polling:100,timeout:240000});await productionFrame(page);const resident=await page.evaluate(()=>closedForestGPU.snapshot());
    assert.ok(resident.massCount>0,'steady sea-level ridge retains qualified solid distant forest');assert.ok(resident.massCount+resident.visibleCount>0);
    for(let i=0;i<preview.selected.length;i++)if(preview.selected[i])assert.ok(resident.selected[i]||resident.ownerVisible[i]>0,'visible startup chunk is still represented after residency: '+i);
    for(let i=0;i<3;i++)await productionFrame(page);const settled=await page.evaluate(()=>closedForestGPU.snapshot());
    for(const row of [preview,resident,settled]){
      assert.equal(row.startup,'ready');assert.deepEqual(row.errors,[]);assert.equal(row.lost,null);assert.equal(row.atlasCount,0,'default never chooses individual transparent atlas');assert.equal(row.duplicateCount,0,'selected mass owners have no duplicate native/far/atlas roots: '+JSON.stringify(row.duplicates));
    }
    assert.deepEqual(errors,[]);assert.equal(requests.some(url=>url.includes('/impostors/')),false,'default needs no rejected transparent atlas bytes');
    assert.equal(settled.pipelines.some(p=>/impostor/i.test(p.label)),false);assert.equal(settled.draws.some(p=>/impostor/i.test(p.label)),false);
    const pipe=settled.pipelines.filter(p=>p.label==='forest canopy opaque closed mass');assert.equal(pipe.length,1);assert.equal(pipe[0].fragment,'canopyOpaqueFS');assert.equal(pipe[0].depth.depthWriteEnabled,true);assert.equal(pipe[0].depth.depthCompare,'greater');assert.equal(pipe[0].msaa.alphaToCoverageEnabled,false);assert.ok(pipe[0].blend.every(b=>b===null));
    const massBundles=settled.bundles.filter(b=>b.label==='forest canopy immutable indirect bundle');assert.equal(massBundles.length,1,'one immutable canopy indirect bundle');assert.equal(massBundles[0].draws.length,settled.chunkCount);assert.deepEqual(massBundles[0].draws.map(d=>d.offset),Array.from({length:settled.chunkCount},(_,i)=>i*20));
    for(const [label,size]of Object.entries(settled.immutableSizes)){
      const buffers=settled.buffers.filter(b=>b.label===label),writes=settled.writes.filter(w=>w.label===label).sort((a,b)=>a.offset-b.offset);assert.equal(buffers.length,1,label+' allocated once');assert.equal(buffers[0].size,size);
      let end=0;for(const write of writes){assert.equal(write.offset,end,label+' has no duplicate/omitted upload range');assert.ok(write.bytes>0);end+=write.bytes;}assert.equal(end,size,label+' immutable source bytes upload exactly once');
    }
    assert.deepEqual(settled.buffers,resident.buffers,'steady frames allocate no replacement forest geometry');assert.deepEqual(settled.writes,resident.writes,'all source/canopy geometry and roots remain CPU immutable after residency');assert.deepEqual(settled.copies,resident.copies,'no staging copy rewrites forest geometry');
    for(let frame=1;frame<=settled.frame;frame++){
      const mass=settled.dispatches.filter(d=>d.frame===frame&&d.label==='forest canopy cull and LOD');assert.equal(mass.length,1);assert.deepEqual([mass[0].x,mass[0].y,mass[0].z],[Math.ceil(settled.chunkCount/64),1,1]);
      const native=settled.dispatches.filter(d=>d.frame===frame&&d.label==='forest cull and LOD');assert.equal(native.length,1);assert.deepEqual([native[0].x,native[0].y,native[0].z],[Math.ceil(settled.rootCount/64),1,1]);
      assert.ok(settled.dispatches.indexOf(mass[0])<settled.dispatches.indexOf(native[0]),'mass selection precedes native suppression');assert.equal(settled.executions.filter(e=>e.frame===frame&&e.label==='forest canopy immutable indirect bundle').length,1,'one O(1) indirect mass bundle execution');
    }
    t.diagnostic(JSON.stringify({camera:query.get('cam'),chunks:settled.chunkCount,previewMass:preview.massCount,residentMass:resident.massCount,residentNative:resident.visibleCount,frames:settled.frame,defaultAtlasCount:0,duplicateRoots:0}));
  }finally{releaseNative?.();await page?.close();await browser?.close();await new Promise(resolve=>server.close(resolve));}
});

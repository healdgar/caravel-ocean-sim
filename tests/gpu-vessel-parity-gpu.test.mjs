// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {readFileSync} from 'node:fs';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';
import {createShipAssetCache} from '../js/ship-mesh.js';
import {createRigGPUFrame,writeRigGPUFrame} from '../js/rig-gpu-data.js';
import {GPU_RIG_ORACLE_CASES,gpuRigOracleBoat} from './helpers/gpu-rig-oracle.mjs';

// Exact-bit indexing can deduplicate a different pair of nearly identical
// vertices in Node and Chrome. Frozen indexed ordinals belong to the source
// engine that generated them, so validate that full source before extracting
// records. Never match its samples to another engine's indexed ordinals.
function prepareFrozenVesselGPUInputs(frozen){
  const cache=createShipAssetCache();
  assert.deepEqual(GPU_RIG_ORACLE_CASES,frozen.controls,'frozen controls require an explicit reviewed change');
  return frozen.models.map(golden=>{
    const asset=cache.get(golden.id),data=asset.rigGPUData;
    assert.equal(asset.vertices.length/9,golden.vertexCount,golden.id+' Node topology must match the frozen source');
    assert.equal(createHash('sha256').update(asset.vertices).digest('hex'),golden.sourceSHA256,golden.id+' Node source must match the frozen oracle before GPU evaluation');
    assert.ok(data&&data.vertices.length===golden.vertexCount*12,golden.id+' has a binding record for every frozen source vertex');
    const indices=[...new Set(golden.cases.flatMap(c=>c.samples.map(s=>s.vertex)))].sort((a,b)=>a-b),sources=new Float32Array(indices.length*9),metadata=new Float32Array(indices.length*12);
    const lookup=new Map(indices.map((original,local)=>[original,local]));
    for(const [local,original]of indices.entries()){
      assert.ok(Number.isSafeInteger(original)&&original>=0&&original<golden.vertexCount);sources.set(asset.vertices.subarray(original*9,original*9+9),local*9);metadata.set(data.vertices.subarray(original*12,original*12+12),local*12);
    }
    const cases=GPU_RIG_ORACLE_CASES.map(c=>{
      const expected=golden.cases.find(g=>g.name===c.name),boat=gpuRigOracleBoat(asset.model,c),frame=createRigGPUFrame(data);writeRigGPUFrame(data,boat,c.time,c.wind,frame);
      assert.ok(expected,golden.id+' frozen state '+c.name);
      for(const sample of expected.samples)assert.equal(asset.vertices[sample.vertex*9+6],sample.material,golden.id+' frozen material/ordinal association');
      return {name:c.name,frame:Array.from(frame),physical:[boat.beam/asset.model.designFrame.beam,asset.model.designFrame.verticalScale,boat.length/asset.model.designFrame.length],samples:expected.samples.map(sample=>({...sample,local:lookup.get(sample.vertex)}))};
    });
    const sha=data=>createHash('sha256').update(data).digest('hex');
    return {id:golden.id,sourceSHA256:golden.sourceSHA256,sourceVertexCount:golden.vertexCount,recordSHA256:sha(sources),metadataSHA256:sha(metadata),modelSHA256:sha(data.model),indices,source:Array.from(sources),metadata:Array.from(metadata),model:Array.from(data.model),cases};
  });
}

test('actual shared GPU surface backend matches every CPU reference vertex and frozen pre-port samples',{timeout:600000},async t=>{
  const frozen=JSON.parse(readFileSync(new URL('./data/vessel-gpu-oracle.json',import.meta.url),'utf8'));
  const frozenInputs=prepareFrozenVesselGPUInputs(frozen);
  const server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');let browser;
  try{
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
    const page=await browser.newPage();await page.route('**/__gpu-vessel-parity',r=>r.fulfill({contentType:'text/html',body:'<!doctype html>'}));await page.goto('http://127.0.0.1:'+server.address().port+'/__gpu-vessel-parity');
    const result=await page.evaluate(async({frozen,frozenInputs})=>{
      const {SHIP_MODELS}=await import('/js/ship-models.js'),{createShipAssetCache}=await import('/js/ship-mesh.js'),{createVesselPose}=await import('/js/vessel-pose.js');
      const {GPU_RIG_ORACLE_CASES,gpuRigOracleBoat,gpuRigCPUOracle}=await import('/tests/helpers/gpu-rig-oracle.mjs');
      const {VESSEL_SURFACE_POSE_UPDATE}=await import('/js/wgsl/vessel-pose.js');
      const models=Object.values(SHIP_MODELS).filter(m=>m.status==='ready'&&m.geometry&&m.rig.backend==='surfaces-v1');
      const device=await(await navigator.gpu.requestAdapter()).requestDevice(),errors=[];device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
      const B=GPUBufferUsage,cache=createShipAssetCache(),rows=[],frozenRows=[];
      const buffer=(data,usage)=>{const b=device.createBuffer({size:data.byteLength,usage:usage|B.COPY_DST});device.queue.writeBuffer(b,0,data);return b;};
      const computePipe=async(code,label)=>{const module=device.createShaderModule({code,label}),bad=(await module.getCompilationInfo()).messages.filter(m=>m.type==='error');if(bad.length)throw Error(label+': '+bad.map(m=>m.message).join('\n'));return device.createComputePipelineAsync({label,layout:'auto',compute:{module,entryPoint:'main'}});};
      const hash=async data=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data))).map(v=>v.toString(16).padStart(2,'0')).join('');
      for(const model of models){
        const asset=cache.get(model.id),count=asset.vertices.length/9,raw=buffer(asset.vertices,B.STORAGE|B.VERTEX),hull=buffer(new Float32Array(52),B.UNIFORM),read=device.createBuffer({size:count*32,usage:B.MAP_READ|B.COPY_DST});
        const pose=await createVesselPose({device,computePipe,sourceBuffer:raw,vertexCount:count,hullUBO:hull,rigData:asset.rigGPUData}),oracle=gpuRigCPUOracle(asset),golden=frozen.models.find(m=>m.id===model.id);
        if(!golden)throw Error('A newly renderable surface model requires an independently frozen oracle: '+model.id);
        const sourceSHA256=await hash(asset.vertices),cases=[];let last=null,movement=0;
        for(const c of GPU_RIG_ORACLE_CASES){
          const boat=gpuRigOracleBoat(model,c),physical=[boat.beam/model.designFrame.beam,model.designFrame.verticalScale,boat.length/model.designFrame.length],expected=new Float32Array(asset.vertices);
          oracle(boat,c.time,c.wind,expected);
          const h=new Float32Array(52);h[3]=physical[1];h[12]=boat.beam;h[13]=boat.length;h[15]=boat.rudder;h[19]=c.time;h[21]=c.wind;h[22]=1;h[23]=model.modelCode;h[27]=boat.hatchesClosed;device.queue.writeBuffer(hull,0,h);
          pose.update(boat,c.time,c.wind);const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();pose.encode(pass);pass.end();encoder.copyBufferToBuffer(pose.buffer,0,read,0,count*32);device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);const actual=new Float32Array(read.getMappedRange()).slice();read.unmap();
          let position=0,normal=0,worst=null,worstPosition=null,worstNormal=null,finite=true;const byCategory={};
          for(let i=0;i<count;i++){
            const p=Math.hypot(...[0,1,2].map(k=>(actual[i*8+k]-expected[i*9+k])*physical[k])),n=Math.hypot(...[0,1,2].map(k=>actual[i*8+4+k]-expected[i*9+3+k]));
            const detail={vertex:i,material:asset.vertices[i*9+6],position:p,normal:n,uv:Array.from(asset.vertices.slice(i*9+7,i*9+9)),metadata:Array.from(asset.rigGPUData.vertices.slice(i*12,i*12+12)),gpuNormal:Array.from(actual.slice(i*8+4,i*8+7)),cpuNormal:Array.from(expected.slice(i*9+3,i*9+6))},category=asset.rigGPUData.vertices[i*12];
            if(!Number.isFinite(p+n))finite=false;if(p>position||n>normal)worst=detail;if(p>position)worstPosition=detail;if(n>normal)worstNormal=detail;
            const prior=byCategory[category]??={position:0,normal:0};if(p>prior.position){prior.position=p;prior.worstPosition=detail;}if(n>prior.normal){prior.normal=n;prior.worstNormal=detail;}
            position=Math.max(position,p);normal=Math.max(normal,n);
            if(last)movement=Math.max(movement,Math.hypot(...[0,1,2].map(k=>(actual[i*8+k]-last[i*8+k])*physical[k])));
          }
          cases.push({name:c.name,position,normal,worst,worstPosition,worstNormal,byCategory,finite});last=actual;
        }
        rows.push({id:model.id,count,sourceSHA256,nodeSourceSHA256:golden.sourceSHA256,nodeSourceCount:golden.vertexCount,indexedTopologyDiffers:count!==golden.vertexCount||sourceSHA256!==golden.sourceSHA256,movement,cases});pose.destroy();raw.destroy();hull.destroy();read.destroy();
      }
      // The production frame packer has a private WeakMap, so serialized model
      // records cannot masquerade as a registered runtime asset. This separate
      // golden gate binds the exact Node source/metadata/compact frames to the
      // production compute shader, while the full-mesh gate above exercises
      // the real createVesselPose wrapper and browser frame packer unchanged.
      const frozenPipeline=await computePipe(VESSEL_SURFACE_POSE_UPDATE,'frozen source production vessel deformation');
      for(const input of frozenInputs){
        const count=input.indices.length,sourceValues=new Float32Array(input.source),modelValues=new Float32Array(input.model),metadataValues=new Float32Array(input.metadata);
        const transferredExactly=await hash(sourceValues)===input.recordSHA256&&await hash(metadataValues)===input.metadataSHA256&&await hash(modelValues)===input.modelSHA256;
        if(!transferredExactly)throw Error('Frozen source/metadata changed during Node-to-browser transfer: '+input.id);
        const source=buffer(sourceValues,B.STORAGE),modelData=buffer(modelValues,B.STORAGE),metadata=buffer(metadataValues,B.STORAGE),live=buffer(new Float32Array(input.cases[0].frame.length),B.STORAGE),output=device.createBuffer({size:count*32,usage:B.STORAGE|B.COPY_SRC}),read=device.createBuffer({size:count*32,usage:B.COPY_DST|B.MAP_READ});
        const group=device.createBindGroup({layout:frozenPipeline.getBindGroupLayout(0),entries:[[1,source],[2,output],[3,modelData],[4,metadata],[5,live]].map(([binding,buffer])=>({binding,resource:{buffer}}))}),cases=[];
        for(const c of input.cases){
          device.queue.writeBuffer(live,0,new Float32Array(c.frame));const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(frozenPipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(count/64));pass.end();encoder.copyBufferToBuffer(output,0,read,0,count*32);device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);const actual=new Float32Array(read.getMappedRange()).slice();read.unmap();
          let position=0,normal=0,finite=actual.every(Number.isFinite),worstPosition=null,worstNormal=null;
          for(const sample of c.samples){
            const i=sample.local,p=Math.hypot(...[0,1,2].map(k=>(actual[i*8+k]-sample.position[k])*c.physical[k])),n=Math.hypot(...[0,1,2].map(k=>actual[i*8+4+k]-sample.normal[k])),detail={vertex:sample.vertex,local:i,material:sample.material,position:p,normal:n};
            if(p>position){position=p;worstPosition=detail;}if(n>normal){normal=n;worstNormal=detail;}
          }
          cases.push({name:c.name,samples:c.samples.length,position,normal,worstPosition,worstNormal,finite});
        }
        frozenRows.push({id:input.id,sourceSHA256:input.sourceSHA256,sourceVertexCount:input.sourceVertexCount,transferredExactly,records:count,cases});for(const resource of [source,modelData,metadata,live,output,read])resource.destroy();
      }
      await device.queue.onSubmittedWorkDone();device.destroy();return {errors,models:models.map(m=>m.id),rows,frozenRows};
    },{frozen,frozenInputs});
    t.diagnostic(JSON.stringify(result));assert.deepEqual(result.errors,[]);assert.deepEqual(result.models,[...frozen.models.map(m=>m.id)],'future surface models must enter this parity gate');
    for(const row of result.rows.filter(row=>row.indexedTopologyDiffers))t.diagnostic(`${row.id}: Node frozen source ${row.nodeSourceCount} vertices/${row.nodeSourceSHA256}; browser source ${row.count} vertices/${row.sourceSHA256}. Frozen samples use exact Node source records; browser parity covers every browser vertex.`);
    for(const row of result.rows){
      assert.ok(row.movement>.01,row.id+' must actually deform; an identity compute is a failure');assert.equal(row.cases.length,5);
      for(const c of row.cases){assert.ok(c.finite,row.id+'/'+c.name+' must remain finite');assert.ok(c.position<=2e-5,row.id+'/'+c.name+' physical position parity '+c.position+' '+JSON.stringify(c.worst));assert.ok(c.normal<=1e-4,row.id+'/'+c.name+' normal parity '+c.normal+' '+JSON.stringify(c.worst));}
    }
    assert.deepEqual(result.frozenRows.map(row=>row.id),frozen.models.map(model=>model.id));
    for(const row of result.frozenRows){assert.ok(row.records>0&&row.transferredExactly);assert.equal(row.cases.length,5);for(const c of row.cases){assert.ok(c.finite&&c.samples>0);assert.ok(c.position<=2e-5,row.id+'/'+c.name+' exact-source frozen position '+c.position+' '+JSON.stringify(c.worstPosition));assert.ok(c.normal<=1e-4,row.id+'/'+c.name+' exact-source frozen normal '+c.normal+' '+JSON.stringify(c.worstNormal));}}
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});

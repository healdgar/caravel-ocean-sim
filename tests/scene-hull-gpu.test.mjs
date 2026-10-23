// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Root runs native qualification serially. Compare unchanged full-model WGSL
// with filtered scene definitions on the same device and exact input bytes.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {test} from 'node:test';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';
import {HULL_PROFILE,withSceneHullProfile} from '../js/wgsl/hull.js';

test('scene hull filtering preserves IDs, complete fleets, absent-profile guards and unrelated source',()=>{
  assert.equal(withSceneHullProfile('unrelated',[999]),'unrelated');
  const full=withSceneHullProfile(HULL_PROFILE,[0,1,2,3,4,5,6,7,8]);assert.equal(full,HULL_PROFILE);
  const nina=withSceneHullProfile(HULL_PROFILE,[0,0]);assert.ok(nina.length<HULL_PROFILE.length/2);assert.doesNotMatch(nina,/fn additionalHull\d/);
  assert.match(nina,/fn victorySectionWidth/);assert.match(nina,/fn hullHalfWidth/);
  const mixed=withSceneHullProfile(HULL_PROFILE,[0,1,7,8]);assert.match(mixed,/fn additionalHull7Width/);assert.match(mixed,/fn additionalHull8Width/);assert.doesNotMatch(mixed,/fn additionalHull2Width/);
  assert.throws(()=>withSceneHullProfile(HULL_PROFILE,[]),/Unknown scene/);assert.throws(()=>withSceneHullProfile(HULL_PROFILE,[999]),/Unknown scene/);
});
test('every scene-specialized hull matches full-model GPU results at waterline, keel, deck and side boundaries',{timeout:180000},async t=>{
  const server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');let browser;
  try{
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
    const page=await browser.newPage();await page.route('**/__scene-hull',r=>r.fulfill({contentType:'text/html',body:'<!doctype html>'}));await page.goto('http://127.0.0.1:'+server.address().port+'/__scene-hull');
    const result=await page.evaluate(async()=>{
      const {HULL_PROFILE,withSceneHullProfile}=await import('/js/wgsl/hull.js'),{pruneWGSLFunctions}=await import('/js/wgsl-prune.js');
      const {readyFleetModels,fleetModelCode}=await import('/js/fleet.js'),models=readyFleetModels(),device=await(await navigator.gpu.requestAdapter()).requestDevice(),errors=[];
      device.onuncapturederror=e=>errors.push(e.error.message);const B=GPUBufferUsage;
      const tail=`@group(0)@binding(0)var<storage,read> points:array<vec4f>;
@group(0)@binding(1)var<storage,read_write> answers:array<vec4f>;
@compute @workgroup_size(64)fn main(@builtin(global_invocation_id)i:vec3u){
 if(i.x>=arrayLength(&points)){return;}let p=points[i.x];let z=p.x;let y=p.y;let model=p.z;let x=p.w;
 answers[i.x*2u]=vec4f(modelHullWidth(z,y,model),modelHullDeck(z,model),modelVesselDeckAt(z,x,model),modelHullDraft(model));
 answers[i.x*2u+1u]=vec4f(modelDeckBarrierAt(z,x,model),modelKeelHalfWidth(z,y,model),f32(modelHullExcludesOcean(vec3f(x,y,z),model)),modelVesselDeck(z,model));
}`;
      const compile=async code=>{const module=device.createShaderModule({code});const bad=(await module.getCompilationInfo()).messages.filter(m=>m.type==='error');if(bad.length)throw Error(bad.map(m=>m.message).join('\n'));return device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'main'}});};
      const reference=await compile(HULL_PROFILE+tail),rows=[];
      for(const model of models){
        const code=fleetModelCode(model),inputs=[];
        for(let z=0;z<=30;z++)for(let y=0;y<=16;y++)for(const x of [-1.8,0,1.8])inputs.push(-6.8+z*.44,-2.4+y*.45,code,x);
        const input=new Float32Array(inputs),size=input.length*8,source=device.createBuffer({size:input.byteLength,usage:B.STORAGE|B.COPY_DST}),output=device.createBuffer({size,usage:B.STORAGE|B.COPY_SRC}),read=device.createBuffer({size,usage:B.COPY_DST|B.MAP_READ});device.queue.writeBuffer(source,0,input);
        const run=async pipeline=>{const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:source}},{binding:1,resource:{buffer:output}}]}),encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(input.length/4/64));pass.end();encoder.copyBufferToBuffer(output,0,read,0,size);device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);const bytes=new Uint8Array(read.getMappedRange()).slice();read.unmap();return bytes;};
        const original=await run(reference),specialized=await run(await compile(pruneWGSLFunctions(withSceneHullProfile(HULL_PROFILE,[code])+tail)));let different=0;for(let i=0;i<size;i++)different+=original[i]===specialized[i]?0:1;
        rows.push({id:model.id,code,points:input.length/4,bytes:size,different});for(const b of [source,output,read])b.destroy();
      }
      device.destroy();return {rows,errors};
    });
    assert.deepEqual(result.errors,[]);assert.equal(result.rows.length,9);for(const row of result.rows)assert.equal(row.different,0,JSON.stringify(row));t.diagnostic(JSON.stringify(result));
  }finally{await browser?.close();server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}
});

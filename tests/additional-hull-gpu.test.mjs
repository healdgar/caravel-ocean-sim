// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {test} from 'node:test';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';

test('new hull GPU boundaries follow independent CPU lofts between knots, including deck and service draft',{timeout:120000},async()=>{
  const server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');let browser;
  try{
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
    const page=await browser.newPage();await page.route('**/__additional-hull',route=>route.fulfill({contentType:'text/html',body:'<!doctype html>'}));await page.goto('http://127.0.0.1:'+server.address().port+'/__additional-hull');
    const result=await page.evaluate(async()=>{
      const {HULL_PROFILE}=await import('/js/wgsl/hull.js'),{ADDITIONAL_DESIGNS,additionalHullWidth,additionalDeck}=await import('/js/models/additional.js');
      const designs=Object.values(ADDITIONAL_DESIGNS),byCode=new Map(designs.map(d=>[d.modelCode,d])),probes=[];
      for(const d of designs)for(let iz=0;iz<145;iz++)for(let iy=0;iy<53;iy++)probes.push([-6.3+iz*.088,-1.15+iy*.075,d.modelCode,0]);
      const input=new Float32Array(probes.flat()),device=await(await navigator.gpu.requestAdapter()).requestDevice(),errors=[];device.onuncapturederror=e=>errors.push(e.error.message);
      const module=device.createShaderModule({code:HULL_PROFILE+`
@group(0)@binding(0)var<storage,read> points:array<vec4f>;
@group(0)@binding(1)var<storage,read_write> answers:array<vec4f>;
@compute @workgroup_size(64)fn main(@builtin(global_invocation_id)i:vec3u){
 if(i.x>=arrayLength(&points)){return;}let p=points[i.x];
 answers[i.x]=vec4f(modelHullWidth(p.x,p.y,p.z),modelVesselDeck(p.x,p.z),modelDeckBarrier(p.x,p.z),modelHullDraft(p.z));
}`});
      errors.push(...(await module.getCompilationInfo()).messages.filter(m=>m.type==='error').map(m=>m.message));
      const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'main'}}),B=GPUBufferUsage;
      const source=device.createBuffer({size:input.byteLength,usage:B.STORAGE|B.COPY_DST}),output=device.createBuffer({size:input.byteLength,usage:B.STORAGE|B.COPY_SRC}),read=device.createBuffer({size:input.byteLength,usage:B.MAP_READ|B.COPY_DST});device.queue.writeBuffer(source,0,input);
      const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:source}},{binding:1,resource:{buffer:output}}]});
      const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(probes.length/64));pass.end();encoder.copyBufferToBuffer(output,0,read,0,input.byteLength);device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);
      const values=new Float32Array(read.getMappedRange()).slice();read.unmap();let maxError=0,worst=null,inside=0,outside=0;
      for(let i=0;i<probes.length;i++){
        const z=input[i*4],y=input[i*4+1],d=byCode.get(input[i*4+2]);
        const expected=[additionalHullWidth(d.id,z,y),additionalDeck(d.id,z),d.barrier,-d.profile.levels[0]+d.keel.depth];
        if(expected[0]>0)inside++;else outside++;
        for(let k=0;k<4;k++){const actual=values[i*4+k],error=Math.abs(actual-expected[k]);if(!Number.isFinite(actual))throw Error('Nonfinite GPU boundary');if(error>maxError){maxError=error;worst={modelId:d.id,z,y,k,actual,expected:expected[k]};}}
      }
      device.destroy();return {errors,count:probes.length,maxError,worst,inside,outside};
    });
    assert.deepEqual(result.errors,[]);assert.ok(result.count>15000&&result.inside>3000&&result.outside>1000);
    assert.ok(result.maxError<3e-4,JSON.stringify(result.worst));
  }finally{await browser?.close();server.close();}
});

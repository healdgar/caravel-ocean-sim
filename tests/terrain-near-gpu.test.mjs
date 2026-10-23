// Copyright (c) 2026 Six Cailloux, LLC. MIT. Root alone executes native GPU checks.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {test} from 'node:test';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';

test('production near-coast GPU height query matches rendered triangle planes rather than a bilinear saddle',{timeout:120000},async t=>{
  const server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');let browser;
  try{
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
    const page=await browser.newPage();await page.route('**/__near_terrain_gpu',r=>r.fulfill({contentType:'text/html',body:'<!doctype html>'}));
    await page.goto('http://127.0.0.1:'+server.address().port+'/__near_terrain_gpu');
    const result=await page.evaluate(async()=>{
      const {TERRAIN_NEAR_HEIGHT,TERRAIN,TERRAIN_LIGHT}=await import('/js/wgsl/terrain.js');
      const device=await(await navigator.gpu.requestAdapter()).requestDevice(),errors=[];device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
      const compile=async code=>{const module=device.createShaderModule({code});const bad=(await module.getCompilationInfo()).messages.filter(m=>m.type==='error');if(bad.length)throw Error(bad.map(m=>m.message).join('\n'));return module;};
      await compile(TERRAIN);await compile(TERRAIN_LIGHT);
      const shader=TERRAIN_NEAR_HEIGHT+`
@group(0) @binding(0) var<uniform> nearTerrain:NearLand;
@group(0) @binding(1) var<storage,read> nearElevation:array<f32>;
@group(0) @binding(2) var<storage,read> points:array<vec2f>;
@group(0) @binding(3) var<storage,read_write> result:array<vec2f>;
@compute @workgroup_size(8) fn main(@builtin(global_invocation_id) id:vec3u){
 if(id.x>=arrayLength(&points)){return;}let p=points[id.x];result[id.x]=vec2f(landNearHeight(p),select(0.0,1.0,landNearContains(p)));
}`;
      const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module:await compile(shader),entryPoint:'main'}}),B=GPUBufferUsage;
      const make=(data,usage)=>{const buffer=device.createBuffer({size:data.byteLength,usage:usage|B.COPY_DST});device.queue.writeBuffer(buffer,0,data);return buffer;};
      const points=[[-1500.5,-6900.5],[-1500,-6900],[-1499.5,-6899.5],[-1499,-6899],[-1501,-6899],[-1499,-6901],[-1498,-6900]];
      const domain=make(new Float32Array([-1500,-6900,2,1,2,0,0,0]),B.UNIFORM),height=make(new Float32Array([0,0,0,8]),B.STORAGE),samples=make(new Float32Array(points.flat()),B.STORAGE);
      const output=device.createBuffer({size:points.length*8,usage:B.STORAGE|B.COPY_SRC}),read=device.createBuffer({size:points.length*8,usage:B.MAP_READ|B.COPY_DST});
      const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[domain,height,samples,output].map((buffer,binding)=>({binding,resource:{buffer}}))});
      const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(1);pass.end();encoder.copyBufferToBuffer(output,0,read,0,read.size);device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);
      const values=Array.from(new Float32Array(read.getMappedRange()));read.unmap();device.destroy();return {errors,values};
    });
    t.diagnostic(JSON.stringify(result));assert.deepEqual(result.errors,[]);
    assert.deepEqual(result.values,[0,1,0,1,4,1,8,1,0,1,0,1,4,0],'GPU shore depth follows the actual diagonal and includes exact final edges');
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});

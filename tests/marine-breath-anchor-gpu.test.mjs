// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {test} from 'node:test';
import {chromium} from 'playwright';

test('a real whale breath samples sea under its animal root once, including slot reuse, while unseeded effects retain their fallback',{timeout:120000},async()=>{
  const port=process.env.MARINE_ANCHOR_TEST_PORT||8143;
  const server=spawn(process.execPath,['server.mjs',String(port)],{cwd:new URL('..',import.meta.url),stdio:['ignore','pipe','inherit']});let browser;
  try{
    await once(server.stdout,'data');browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
    const page=await browser.newPage();await page.route('**/__marine-anchor',route=>route.fulfill({contentType:'text/html',body:'<!doctype html>'}));await page.goto(`http://localhost:${port}/__marine-anchor`);
    const result=await page.evaluate(async()=>{
      const {MARINE_EFFECT_INIT}=await import('/js/wgsl/marine-life.js'),{CASCADES}=await import('/js/wgsl/common.js');
      const device=await(await navigator.gpu.requestAdapter()).requestDevice(),errors=[];device.onuncapturederror=e=>errors.push(e.error.message);
      const B=GPUBufferUsage,T=GPUTextureUsage,make=(data,usage)=>{const buffer=device.createBuffer({size:data.byteLength,usage:usage|B.COPY_DST});device.queue.writeBuffer(buffer,0,data);return buffer;};
      const f=new Float32Array(96);f[48]=.25;for(let i=1;i<CASCADES;i++)f[48+i]=.125;
      const frame=make(f,B.UNIFORM),events=make(new Float32Array(12),B.STORAGE),births=make(new Float32Array(48*4),B.STORAGE|B.COPY_SRC),landings=make(new Float32Array(48*64*4),B.STORAGE);
      const sea=device.createTexture({size:[4,4,CASCADES],format:'rgba16float',usage:T.TEXTURE_BINDING|T.COPY_DST});
      const sampler=device.createSampler({minFilter:'linear',magFilter:'linear',addressModeU:'repeat',addressModeV:'repeat'});
      const half=n=>n===0?0:((Math.floor(Math.log2(n))+15)<<10)|Math.round((n/2**Math.floor(Math.log2(n))-1)*1024);
      const water=lift=>{const values=new Uint16Array(4*4*4);for(let y=0;y<4;y++)for(let x=0;x<4;x++)values[(y*4+x)*4+1]=half(x+lift);device.queue.writeTexture({texture:sea},values,{bytesPerRow:32},[4,4]);};
      water(0);
      const makePipeline=async(code,entryPoint)=>{const module=device.createShaderModule({code});errors.push(...(await module.getCompilationInfo()).messages.filter(m=>m.type==='error').map(m=>m.message));return device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint}});};
      const init=await makePipeline(MARINE_EFFECT_INIT,'marineBirthCS');
      const answer=make(new Float32Array(12),B.STORAGE|B.COPY_SRC),read=device.createBuffer({size:48,usage:B.COPY_DST|B.MAP_READ});
      const probe=await makePipeline(MARINE_EFFECT_INIT+`
@group(0)@binding(12)var<storage,read_write>answers:array<vec4f>;
@compute @workgroup_size(1)fn rootProbe(){
 let s=splashes[0];answers[0]=marineBirths[u32(s.motion.w)%48u];
 answers[1]=vec4f(dolphinHeight(vec2f(1.5,.5)),dolphinHeight(s.root.xy),0,0);
 answers[2]=marineBirths[0];
}`,'rootProbe');
      const resources=[{binding:0,resource:{buffer:frame}},{binding:6,resource:sea.createView({dimension:'2d-array'})},{binding:7,resource:sampler},{binding:9,resource:{buffer:events}},{binding:10,resource:{buffer:births}}];
      const initGroup=device.createBindGroup({layout:init.getBindGroupLayout(0),entries:[...resources,{binding:11,resource:{buffer:landings}}]});
      const probeGroup=device.createBindGroup({layout:probe.getBindGroupLayout(0),entries:[...resources,{binding:12,resource:{buffer:answer}}]});
      async function sample(key,seed=false){
        device.queue.writeBuffer(events,0,new Float32Array([3.5,.5,.35,1,0,.4,3,5.2,1,0,0,key]));
        if(seed)device.queue.writeBuffer(births,(key%48)*16,new Float32Array([-key,0,1.5,.5]));
        const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(init);pass.setBindGroup(0,initGroup);pass.dispatchWorkgroups(1);pass.setPipeline(probe);pass.setBindGroup(0,probeGroup);pass.dispatchWorkgroups(1);pass.end();encoder.copyBufferToBuffer(answer,0,read,0,48);device.queue.submit([encoder.finish()]);
        await read.mapAsync(GPUMapMode.READ);const values=Array.from(new Float32Array(read.getMappedRange()));read.unmap();return values;
      }
      const anchored=await sample(7,true);water(5);const frozen=await sample(7),reused=await sample(55,true),fallback=await sample(31),zero=await sample(0);
      await device.queue.onSubmittedWorkDone();device.destroy();return {errors,anchored,frozen,reused,fallback,zero};
    });
    assert.deepEqual(result.errors,[]);
    assert.equal(result.anchored[0],7);assert.ok(Math.abs(result.anchored[1]-result.anchored[4])<1e-5,'the forehead height is based on the body-root sea');
    assert.ok(Math.abs(result.anchored[1]-result.anchored[5])>1.5,'the fixture exposes a real spatial wave-height mismatch');
    assert.deepEqual(result.frozen.slice(0,4),result.anchored.slice(0,4),'later water cannot move detached breath');
    assert.equal(result.reused[0],55);assert.ok(Math.abs(result.reused[1]-result.reused[4])<1e-5,'slot reuse captures the new root sea');
    assert.ok(result.reused[1]>result.anchored[1]+4.9);
    assert.equal(result.fallback[0],31);assert.ok(Math.abs(result.fallback[1]-result.fallback[5])<1e-5,'unseeded effects still sample their own origin');
    assert.deepEqual(result.zero.slice(8,12),[0,0,0,0],'zero is never a valid seeded birth key');
  }finally{await browser?.close();server.kill();}
});

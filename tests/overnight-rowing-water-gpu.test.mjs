// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {chromium} from 'playwright';

test('native rowing water reprojection separates ship/grid motion from actual changing water',{timeout:120000},async()=>{
  const port=process.env.ROWING_WATER_TEST_PORT||8127,server=spawn(process.execPath,['server.mjs',String(port)],{cwd:new URL('..',import.meta.url),stdio:['ignore','pipe','inherit']});
  let browser;
  try{
    await Promise.race([once(server.stdout,'data'),once(server,'exit').then(([code])=>{throw Error('Rowing-water server exited '+code);})]);
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
    const page=await browser.newPage();await page.route('**/__rowing-water',r=>r.fulfill({contentType:'text/html',body:'<!doctype html>'}));await page.goto(`http://localhost:${port}/__rowing-water`);
    const result=await page.evaluate(async()=>{
      const {createRowingWaterProbe}=await import('/js/rowing-water.js');
      const adapter=await navigator.gpu.requestAdapter(),device=await adapter.requestDevice(),B=GPUBufferUsage,T=GPUTextureUsage,errors=[];
      device.onuncapturederror=e=>errors.push(e.error.message);
      // Isolated base shader uses the shared original Frame layout. Production
      // specializes its celestial extension through the existing shader helper.
      const frame=device.createBuffer({size:384,usage:B.UNIFORM|B.COPY_DST}),values=new Float32Array(96);values[48]=1/256;device.queue.writeBuffer(frame,0,values);
      const sea=device.createTexture({size:[64,64,6],format:'rgba16float',usage:T.TEXTURE_BINDING|T.COPY_DST}),sampler=device.createSampler({minFilter:'linear',magFilter:'linear',addressModeU:'repeat',addressModeV:'repeat'});
      const half=x=>{if(x===0)return 0;const sign=x<0?0x8000:0;x=Math.abs(x);const exponent=Math.floor(Math.log2(x));return sign|((exponent+15)<<10)|Math.round((x/2**exponent-1)*1024);};
      function field(offset=0){
        const data=new Uint16Array(64*64*4);for(let j=0;j<64;j++)for(let i=0;i<64;i++)data[(j*64+i)*4+1]=half(.04*(i+.5)+offset);
        device.queue.writeTexture({texture:sea,origin:[0,0,0]},data,{bytesPerRow:512,rowsPerImage:64},[64,64,1]);
        const zero=new Uint16Array(64*64*4);for(let i=1;i<6;i++)device.queue.writeTexture({texture:sea,origin:[0,0,i]},zero,{bytesPerRow:512,rowsPerImage:64},[64,64,1]);
      }
      field();
      const probe=await createRowingWaterProbe({device,frameUBO:frame,seaView:sea.createView({dimension:'2d-array'}),seaSampler:sampler,modelId:'lusoria',computePipe:async(code,label)=>{
        const module=device.createShaderModule({code,label}),info=await module.getCompilationInfo();errors.push(...info.messages.filter(m=>m.type==='error').map(m=>m.message));
        return device.createComputePipelineAsync({label,layout:'auto',compute:{module,entryPoint:'main'}});
      }});
      const boat={modelId:'lusoria',x:128,z:128,heading:0,length:18,beam:2.8,revision:0};
      async function step(time,x=boat.x,heading=boat.heading){
        boat.x=x;boat.heading=heading;probe.update(boat,.016,{time,choppy:0});const encoder=device.createCommandEncoder();probe.encode(encoder);device.queue.submit([encoder.finish()]);probe.readback();await device.queue.onSubmittedWorkDone();
        for(let i=0;i<100&&probe.pending;i++)await new Promise(resolve=>setTimeout(resolve,0));
        if(probe.pending)throw Error('Rowing water readback did not settle');return probe.sample(128,128);
      }
      const cold=await step(0);await step(.016);await step(.032,128.5,10);const moved=await step(.048,129,20);
      field(.008);await step(.064);field(.016);const changing=await step(.080);
      boat.revision++;probe.update(boat,.016,{time:.096,choppy:0});const edited=probe.sample(128,128);
      probe.destroy();sea.destroy();frame.destroy();await device.queue.onSubmittedWorkDone();device.destroy();return {errors,cold,moved,changing,edited};
    });
    assert.deepEqual(result.errors,[]);assert.equal(result.cold,null);assert.equal(result.edited,null);
    assert.equal(result.moved.quality,'vertical-only');assert.ok(Math.abs(result.moved.height-1.28)<.005);
    assert.ok(Math.abs(result.moved.velocity[1])<.1,'moving/rotating a grid over a stationary height gradient creates no fluid velocity');
    assert.equal(result.moved.velocity[0],0);assert.equal(result.moved.velocity[2],0);
    assert.ok(Math.abs(result.changing.velocity[1]-.5)<.1,'actual changed displacement supplies vertical water velocity at zero visual chop');
  }finally{await browser?.close();server.kill();}
});

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
      const half=x=>{if(x===0)return 0;const sign=x<0?0x8000:0;x=Math.abs(x);const exponent=Math.floor(Math.log2(x)),mantissa=Math.round((x/2**exponent-1)*1024);return sign|((exponent+15+(mantissa===1024?1:0))<<10)|(mantissa===1024?0:mantissa);};
      function field(offset=0,dx=0,dz=0){
        const data=new Uint16Array(64*64*4);for(let j=0;j<64;j++)for(let i=0;i<64;i++){
          const at=(j*64+i)*4;data[at]=half(dx);data[at+1]=half(.04*(i+.5)+offset);data[at+2]=half(dz);
        }
        device.queue.writeTexture({texture:sea,origin:[0,0,0]},data,{bytesPerRow:512,rowsPerImage:64},[64,64,1]);
        const zero=new Uint16Array(64*64*4);for(let i=1;i<6;i++)device.queue.writeTexture({texture:sea,origin:[0,0,i]},zero,{bytesPerRow:512,rowsPerImage:64},[64,64,1]);
      }
      field();
      const probe=await createRowingWaterProbe({device,frameUBO:frame,seaView:sea.createView({dimension:'2d-array'}),seaSampler:sampler,modelId:'lusoria',computePipe:async(code,label)=>{
        const module=device.createShaderModule({code,label}),info=await module.getCompilationInfo();errors.push(...info.messages.filter(m=>m.type==='error').map(m=>m.message));
        return device.createComputePipelineAsync({label,layout:'auto',compute:{module,entryPoint:'main'}});
      }});
      const boat={modelId:'lusoria',x:128,z:128,heading:0,length:18,beam:2.8,revision:0};
      async function step(time,x=boat.x,heading=boat.heading,{dt=.016,choppy=0,resetSea=false}={}){
        boat.x=x;boat.heading=heading;probe.update(boat,dt,{time,choppy,resetSea});const encoder=device.createCommandEncoder();probe.encode(encoder);device.queue.submit([encoder.finish()]);probe.readback();await device.queue.onSubmittedWorkDone();
        for(let i=0;i<100&&probe.pending;i++)await new Promise(resolve=>setTimeout(resolve,0));
        if(probe.pending)throw Error('Rowing water readback did not settle');return probe.sample(128,128);
      }
      const cold=await step(0);await step(.016);await step(.032,128.5,10);const moved=await step(.048,129,20);
      field(.008);await step(.064);field(.016);const changing=await step(.080);
      // Label each actual field with its own time. Alternating 12/48 ms makes
      // a previous-frame clock/denominator error four times too large/small.
      // Current horizontal displacement contains visual chop; division must
      // recover the same real orbital velocity regardless of cadence/grid pose.
      const orbital=[.5,1,-.25],chop=.8,varying=[],stationary=[];let time=.1;
      const movingField=t=>field(orbital[1]*t,orbital[0]*t*chop,orbital[2]*t*chop);
      probe.reset();movingField(time);await step(time,128,0,{dt:.02,choppy:chop});
      for(let i=0;i<8;i++){
        const dt=i%2?.048:.012;time+=dt;movingField(time);boat.z=128+.4*Math.cos(i*.4);
        const sample=await step(time,128+.5*Math.sin(i*.6),i*7,{dt,choppy:chop});
        if(probe.state?.time===time)varying.push({time,dt,sample});
      }
      // Keep the physical material field fixed while translating/rotating its
      // sampling grid over a spatial gradient. Grid motion is never water flow.
      probe.reset();field(.24,.12,-.06);time+=.02;await step(time,128,0,{dt:.02,choppy:chop});
      for(let i=0;i<8;i++){
        const dt=i%2?.048:.012;time+=dt;boat.z=128+.4*Math.sin(i*.7);
        const sample=await step(time,128+.5*Math.cos(i*.5),-i*6,{dt,choppy:chop});
        if(probe.state?.time===time)stationary.push({time,dt,sample});
      }
      boat.revision++;probe.update(boat,.016,{time:time+.016,choppy:0});const edited=probe.sample(128,128);
      probe.destroy();sea.destroy();frame.destroy();await device.queue.onSubmittedWorkDone();device.destroy();return {errors,cold,moved,changing,edited,orbital,varying,stationary};
    });
    assert.deepEqual(result.errors,[]);assert.equal(result.cold,null);assert.equal(result.edited,null);
    assert.equal(result.moved.quality,'vertical-only');assert.ok(Math.abs(result.moved.height-1.28)<.005);
    assert.ok(Math.abs(result.moved.velocity[1])<.1,'moving/rotating a grid over a stationary height gradient creates no fluid velocity');
    assert.equal(result.moved.velocity[0],0);assert.equal(result.moved.velocity[2],0);
    assert.ok(Math.abs(result.changing.velocity[1]-.5)<.1,'actual changed displacement supplies vertical water velocity at zero visual chop');
    assert.ok(result.varying.length>=3&&result.stationary.length>=3,'each scenario must accept multiple actual GPU field readbacks');
    for(const {time,dt,sample}of result.varying){
      assert.ok(sample,`accepted orbital field at ${time}s / ${dt}s must cover the world probe point`);assert.equal(sample.quality,'surface-orbital');
      for(let k=0;k<3;k++)assert.ok(Math.abs(sample.velocity[k]-result.orbital[k])<(k===1?.15:.03),`constant orbital component ${k} at dt=${dt}: ${sample.velocity[k]}`);
    }
    for(const {time,dt,sample}of result.stationary){
      assert.ok(sample,`accepted stationary field at ${time}s / ${dt}s must cover the world probe point`);assert.equal(sample.quality,'surface-orbital');
      assert.ok(Math.abs(sample.velocity[0])<.01&&Math.abs(sample.velocity[2])<.01,'a moving grid cannot invent horizontal orbital velocity');
      assert.ok(Math.abs(sample.velocity[1])<.15,`a moving grid cannot turn the fixed height gradient into fluid velocity at dt=${dt}`);
    }
  }finally{await browser?.close();server.kill();}
});

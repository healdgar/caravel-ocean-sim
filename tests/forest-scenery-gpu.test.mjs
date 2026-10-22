// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {test} from 'node:test';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';

test('native forest compute compacts roots, resets indirect counts and responds to rendered resolution',{timeout:120000},async()=>{
  const server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');let browser;
  try{
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'
      ?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
    const page=await browser.newPage();await page.route('**/__forest-gpu',r=>r.fulfill({contentType:'text/html',body:'<!doctype html>'}));await page.goto('http://127.0.0.1:'+server.address().port+'/__forest-gpu');
    const result=await page.evaluate(async()=>{
      const {FOREST_CULL_WGSL}=await import('/js/forest-scenery.js');
      const device=await(await navigator.gpu.requestAdapter()).requestDevice(),errors=[];device.onuncapturederror=e=>errors.push(e.error.message);
      const B=GPUBufferUsage,make=(data,usage)=>{const b=device.createBuffer({size:data.byteLength,usage:usage|B.COPY_DST});device.queue.writeBuffer(b,0,data);return b;};
      const frameData=new Float32Array(96);frameData[0]=1/.6;frameData[5]=1/.45;frameData[11]=-1;frameData[14]=.1;
      frameData.set([.6,0,0],20);frameData.set([0,.45,0],24);frameData.set([0,0,-1],28);frameData.set([1920,1080,1/1920,1/1080],36);
      const frame=make(frameData,B.UNIFORM),roots=make(new Float32Array([[0,0,-20],[0,0,-2000],[0,0,20],[1000,0,-20]].flatMap(p=>[...p,1,0,1,1,1,0,0,0,0])),B.STORAGE);
      const meta=new ArrayBuffer(80),f=new Float32Array(meta),u=new Uint32Array(meta);f.set([0,1,0,2]);u.set([0,4,0,0],4);u.set([0,3,0,0,3,3,0,0,6,3,0,0],8);
      const prototypes=make(new Uint8Array(meta),B.STORAGE),visible=make(new Uint32Array(8),B.STORAGE|B.COPY_SRC),commands=make(new Uint32Array([3,999,0,0,0,3,999,3,0,0,3,999,6,0,0]),B.STORAGE|B.INDIRECT|B.COPY_SRC);
      const previous=make(new Uint32Array(4),B.STORAGE),parameterData=new Float32Array([4,1,3,0]),parameters=make(parameterData,B.UNIFORM);
      const module=device.createShaderModule({code:FOREST_CULL_WGSL});errors.push(...(await module.getCompilationInfo()).messages.filter(m=>m.type==='error').map(m=>m.message));
      const pipeline=entryPoint=>device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint}});
      const reset=await pipeline('forestReset'),cull=await pipeline('forestCull');
      const resetGroup=device.createBindGroup({layout:reset.getBindGroupLayout(0),entries:[{binding:4,resource:{buffer:commands}},{binding:6,resource:{buffer:parameters}}]});
      const cullGroup=device.createBindGroup({layout:cull.getBindGroupLayout(0),entries:[frame,roots,prototypes,visible,commands,previous,parameters].map((buffer,binding)=>({binding,resource:{buffer}}))});
      const read=device.createBuffer({size:92,usage:B.COPY_DST|B.MAP_READ});
      async function run(height,mode=0){
        frameData[37]=height;parameterData[3]=mode;device.queue.writeBuffer(frame,0,frameData);device.queue.writeBuffer(parameters,0,parameterData);
        const enc=device.createCommandEncoder(),pass=enc.beginComputePass();pass.setPipeline(reset);pass.setBindGroup(0,resetGroup);pass.dispatchWorkgroups(1);pass.setPipeline(cull);pass.setBindGroup(0,cullGroup);pass.dispatchWorkgroups(1);pass.end();
        enc.copyBufferToBuffer(commands,0,read,0,60);enc.copyBufferToBuffer(visible,0,read,60,32);device.queue.submit([enc.finish()]);await read.mapAsync(GPUMapMode.READ);
        const data=Array.from(new Uint32Array(read.getMappedRange()));read.unmap();const counts=[data[1],data[6],data[11]];
        return {counts,near:data.slice(15,15+counts[0]).sort(),far:data.slice(19,19+counts[2]).sort(),commands:data.slice(0,15)};
      }
      const normal=await run(1080),repeat=await run(1080),high=await run(2160),farDebug=await run(2160,2),nearDebug=await run(1080,1);
      await device.queue.onSubmittedWorkDone();device.destroy();return {errors,normal,repeat,high,farDebug,nearDebug};
    });
    assert.deepEqual(result.errors,[]);
    for(const name of ['normal','repeat']){assert.deepEqual(result[name].counts,[1,1,1],name);assert.deepEqual(result[name].near,[0]);assert.deepEqual(result[name].far,[1]);}
    assert.deepEqual(result.high.counts,[2,2,0],'higher rendered pixel density retains actual detail');
    assert.deepEqual(result.high.near,[0,1]);assert.deepEqual(result.farDebug.counts,[0,0,2]);assert.deepEqual(result.nearDebug.counts,[2,2,0]);
    for(const row of Object.values(result).filter(v=>v?.commands))for(let i=0;i<3;i++)assert.deepEqual(row.commands.slice(i*5,i*5+5).filter((_,k)=>k!==1),[3,i*3,0,0],'draw topology and zero firstInstance survive GPU count reset');
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});

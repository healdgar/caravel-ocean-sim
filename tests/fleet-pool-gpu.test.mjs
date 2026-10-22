// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {once} from 'node:events';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';

test('native pooled wake banks preserve two-ship pixels and independently sample the ninth layer',{timeout:120000},async t=>{
  const server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');let browser;
  try{
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'
      ?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']
      :['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
    const page=await browser.newPage();await page.route('**/__fleet-pool',route=>route.fulfill({contentType:'text/html',body:'<!doctype html>'}));
    await page.goto('http://127.0.0.1:'+server.address().port+'/__fleet-pool');
    const report=await page.evaluate(async()=>{
      const {FLEET_WAKE_SAMPLE}=await import('/js/wgsl/interaction.js');
      const {withPooledFleetWakes}=await import('/js/wgsl/fleet-wakes.js');
      const {createFleetWakePool}=await import('/js/fleet.js');
      const device=await(await navigator.gpu.requestAdapter()).requestDevice(),errors=[];device.onuncapturederror=event=>errors.push(event.error.message);
      const B=GPUBufferUsage,T=GPUTextureUsage,pool=createFleetWakePool(device,9),SIZE=256;
      const output=device.createBuffer({size:96,usage:B.STORAGE|B.COPY_SRC}),read=device.createBuffer({size:96,usage:B.COPY_DST|B.MAP_READ});
      const first=device.createBuffer({size:64,usage:B.UNIFORM|B.COPY_DST}),second=device.createBuffer({size:64,usage:B.UNIFORM|B.COPY_DST});
      const sampler=device.createSampler({minFilter:'linear',magFilter:'linear'});
      const half=value=>{const f=new Float32Array([value]),u=new Uint32Array(f.buffer)[0];return ((u>>>16)&0x8000)|((((u>>>23)&255)-112)<<10)|((u&0x7fffff)>>>13);};
      for(let bank=0;bank<2;bank++)for(let layer=0;layer<9;layer++){
        const values=new Uint16Array(SIZE*SIZE*4);
        for(let y=0;y<SIZE;y++)for(let x=0;x<SIZE;x++)for(let channel=0;channel<4;channel++)
          values[(y*SIZE+x)*4+channel]=half((bank+1)*(.125+layer*.125+channel*.0625+(x+y)/SIZE*.125));
        device.queue.writeTexture({texture:pool.textures[bank],origin:[0,0,layer]},values,{bytesPerRow:SIZE*8},[SIZE,SIZE]);
      }
      const source=FLEET_WAKE_SAMPLE+`
@group(0)@binding(0)var<uniform>I:Interaction;
@group(0)@binding(1)var wakeTex:texture_2d<f32>;
@group(0)@binding(2)var wakeSamp:sampler;
@group(0)@binding(3)var<uniform>I2:Interaction;
@group(0)@binding(4)var wakeTex2:texture_2d<f32>;
@group(0)@binding(5)var<storage,read_write>answer:array<vec4f,6>;
@compute @workgroup_size(1)fn main(@builtin(global_invocation_id)id:vec3u){
  let positions=array<vec2f,6>(vec2f(-3,-3),vec2f(-1,-1),vec2f(0,0),vec2f(1,1),vec2f(3,3),vec2f(5,5));
  answer[id.x]=wakeAt(positions[id.x]);
}`;
      const pipeline=async code=>{
        const module=device.createShaderModule({code}),messages=(await module.getCompilationInfo()).messages.filter(m=>m.type==='error');
        if(messages.length)throw Error(messages.map(m=>m.message).join('\n'));
        return device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'main'}});
      };
      const reference=await pipeline(source),pooled=[];
      for(const count of [1,2,9])pooled.push(await pipeline(withPooledFleetWakes(source,count)));
      const states=Array.from({length:9},(_,i)=>{const values=new Float32Array(16);values.set([i*.125,-i*.0625,8,8/SIZE]);values[9]=1;return {interaction:{values}};});
      const disabled=new Float32Array(states[0].interaction.values);disabled[9]=0;
      async function run(pipe,entries){
        const group=device.createBindGroup({layout:pipe.getBindGroupLayout(0),entries});
        const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(pipe);pass.setBindGroup(0,group);pass.dispatchWorkgroups(6);pass.end();
        encoder.copyBufferToBuffer(output,0,read,0,96);device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);
        const result=new Float32Array(read.getMappedRange()).slice();read.unmap();return result;
      }
      const pooledRun=index=>run(pooled[index],[{binding:0,resource:{buffer:pool.uniform}},{binding:1,resource:pool.views[pool.current]},{binding:2,resource:sampler},{binding:5,resource:{buffer:output}}]);
      const referenceRun=(a,b=1)=>run(reference,[{binding:0,resource:{buffer:first}},{binding:1,resource:pool.layer(a).views[pool.current]},{binding:2,resource:sampler},
        {binding:3,resource:{buffer:second}},{binding:4,resource:pool.layer(b).views[pool.current]},{binding:5,resource:{buffer:output}}]);
      const maxError=(a,b)=>Math.max(...a.map((x,i)=>Math.abs(x-b[i]))),two=[];
      for(let bank=0;bank<2;bank++){
        for(const flags of [[1,1],[0,1],[1,0],[0,0]]){
          states[0].interaction.values[9]=flags[0];states[1].interaction.values[9]=flags[1];pool.update(states);
          device.queue.writeBuffer(first,0,states[0].interaction.values);device.queue.writeBuffer(second,0,states[1].interaction.values);
          const old=await referenceRun(0),next=await pooledRun(1);two.push({bank,flags,error:maxError(old,next)});
        }
        pool.commit();
      }
      for(const state of states)state.interaction.values[9]=0;
      states[8].interaction.values[9]=1;pool.update(states);
      device.queue.writeBuffer(first,0,states[8].interaction.values);device.queue.writeBuffer(second,0,disabled);
      const ninthReference=await referenceRun(8,0),ninth=await pooledRun(2);
      states[8].interaction.values[9]=0;states[0].interaction.values[9]=1;pool.update(states);
      device.queue.writeBuffer(first,0,states[0].interaction.values);
      const oneReference=await referenceRun(0),one=await pooledRun(0);
      await device.queue.onSubmittedWorkDone();const result={errors,two,ninthError:maxError(ninthReference,ninth),ninthNonzero:ninth.some(x=>x>0),singleError:maxError(oneReference,one),bank:pool.current};
      pool.destroy();device.destroy();return result;
    });
    t.diagnostic(JSON.stringify(report));assert.deepEqual(report.errors,[]);
    for(const sample of report.two)assert.equal(sample.error,0,'two-ship wake fields remain exact through both banks and enable masks');
    assert.equal(report.ninthError,0);assert.equal(report.ninthNonzero,true);assert.equal(report.singleError,0);assert.equal(report.bank,0);
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});

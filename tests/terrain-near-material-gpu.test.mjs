// Copyright (c) 2026 Six Cailloux, LLC. MIT. Root alone executes native checks.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {test} from 'node:test';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';

test('near-coast material preserves fine colour and samples dry landward cliff seeds on the actual GPU',{timeout:120000},async t=>{
  const server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');let browser;
  try{
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'
      ?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
    const page=await browser.newPage();await page.route('**/__near_material_gpu',r=>r.fulfill({contentType:'text/html',body:'<!doctype html>'}));
    await page.goto('http://127.0.0.1:'+server.address().port+'/__near_material_gpu');
    const result=await page.evaluate(async()=>{
      const {TERRAIN,TERRAIN_FILTERING,TERRAIN_NEAR_MATERIAL}=await import('/js/wgsl/terrain.js');
      const {NOISE_WGSL}=await import('/js/wgsl/common.js'),{RGBA8_MIPS}=await import('/js/wgsl/sim.js');
      const adapter=await navigator.gpu.requestAdapter();if(!adapter)throw Error('WebGPU adapter unavailable');
      const d=await adapter.requestDevice(),errors=[];d.onuncapturederror=e=>errors.push(e.error.message);
      const compile=async code=>{const module=d.createShaderModule({code}),bad=(await module.getCompilationInfo()).messages.filter(m=>m.type==='error');if(bad.length)throw Error(bad.map(m=>m.message).join('\n'));return module;};
      await compile(TERRAIN);
      const code=NOISE_WGSL+TERRAIN_FILTERING+`
struct NearLand {domain:vec4f,grid:vec4f};
struct Settings {world:vec4f,normal:vec4f,dx:vec4f,dy:vec4f,coarse:vec4f};
@group(0) @binding(0) var<uniform> nearTerrain:NearLand;
@group(0) @binding(1) var nearAlbedo:texture_2d<f32>;
@group(0) @binding(2) var landSampler:sampler;
@group(0) @binding(3) var<uniform> S:Settings;
`+TERRAIN_NEAR_MATERIAL+`
@vertex fn vs(@builtin(vertex_index) i:u32)->@builtin(position) vec4f{
 let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3));return vec4f(p[i],0,1);
}
@fragment fn fs()->@location(0) vec4f{
 let n=normalize(S.normal.xyz);
 if(S.normal.w>.5){return vec4f(landNearStrata(S.world.xyz,S.dx.xyz,S.dy.xyz),
   landOrientedJoint(S.world.xyz,n,S.dx.xyz,S.dy.xyz),landOrientedDetail(S.world.xyz,n,S.dx.xyz,S.dy.xyz,1.35),1);}
 return vec4f(landNearColour(S.coarse.rgb,S.world.xyz,n,S.dx.xyz,S.dy.xyz,vec3f(0),vec3f(0),S.world.w),1);
}`;
      const module=await compile(code),pipeline=await d.createRenderPipelineAsync({layout:'auto',vertex:{module,entryPoint:'vs'},fragment:{module,entryPoint:'fs',targets:[{format:'rgba32float'}]}});
      const B=GPUBufferUsage,T=GPUTextureUsage;
      const domain=d.createBuffer({size:32,usage:B.UNIFORM|B.COPY_DST}),settings=d.createBuffer({size:80,usage:B.UNIFORM|B.COPY_DST});
      d.queue.writeBuffer(domain,0,new Float32Array([0,0,256,1,257,0,0,0]));
      const sampler=d.createSampler({magFilter:'linear',minFilter:'linear',mipmapFilter:'linear'});
      const mipPipeline=await d.createComputePipelineAsync({layout:'auto',compute:{module:await compile(RGBA8_MIPS),entryPoint:'main'}});
      const textures=[];
      const image=kind=>{
        const pixels=new Uint8Array(256*256*4);
        for(let z=0;z<256;z++)for(let x=0;x<256;x++){
          const dry=kind==='rock'||kind==='stripes'||(kind==='coast'&&x<122);
          const rgb=kind==='stripes'&&Math.floor(z/8)%2?[160,144,128,255]:[80,72,64,255];
          pixels.set(dry?rgb:[245,250,255,0],(z*256+x)*4);
        }
        const texture=d.createTexture({size:[256,256],format:'rgba8unorm',mipLevelCount:9,usage:T.TEXTURE_BINDING|T.STORAGE_BINDING|T.COPY_DST});textures.push(texture);
        d.queue.writeTexture({texture},pixels,{bytesPerRow:256*4},[256,256]);
        const encoder=d.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(mipPipeline);
        for(let m=1;m<9;m++){
          pass.setBindGroup(0,d.createBindGroup({layout:mipPipeline.getBindGroupLayout(0),entries:[
            {binding:0,resource:texture.createView({baseMipLevel:m-1,mipLevelCount:1})},{binding:1,resource:texture.createView({baseMipLevel:m,mipLevelCount:1})}]}));
          pass.dispatchWorkgroups(Math.ceil((256>>m)/8),Math.ceil((256>>m)/8));
        }
        pass.end();d.queue.submit([encoder.finish()]);return texture;
      };
      const rock=image('rock'),coast=image('coast'),water=image('water'),stripes=image('stripes');
      const target=d.createTexture({size:[1,1],format:'rgba32float',usage:T.RENDER_ATTACHMENT|T.COPY_SRC});
      const render=async(texture,{world=[0,10,0],normal=[0,1,0],dx=[.05,0,0],dy=[0,0,.05],support=1,mode=0}={})=>{
        d.queue.writeBuffer(settings,0,new Float32Array([...world,support,...normal,mode,...dx,0,...dy,0,.8,.75,.7,0]));
        const group=d.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:domain}},{binding:1,resource:texture.createView()},{binding:2,resource:sampler},{binding:3,resource:{buffer:settings}}]});
        const read=d.createBuffer({size:256,usage:B.COPY_DST|B.MAP_READ}),encoder=d.createCommandEncoder();
        const pass=encoder.beginRenderPass({colorAttachments:[{view:target.createView(),loadOp:'clear',storeOp:'store',clearValue:[0,0,0,0]}]});
        pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.draw(3);pass.end();
        encoder.copyTextureToBuffer({texture:target},{buffer:read,bytesPerRow:256},[1,1]);d.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);
        const values=Array.from(new Float32Array(read.getMappedRange()).slice(0,4));read.unmap();read.destroy();return values;
      };
      const fine=await render(rock),unsupported=await render(rock,{support:0});
      const seam=await render(rock,{world:[-128,10,0]}),halfSeam=await render(rock,{world:[-112,10,0]});
      const cliff=await render(coast,{world:[2,10,0],normal:[1,0,0]}),highCliff=await render(coast,{world:[2,90,0],normal:[1,0,0]});
      const wrongSide=await render(coast,{world:[2,10,0],normal:[-1,0,0]}),masked=await render(water);
      const minified=await render(rock,{dx:[8,0,0],dy:[0,0,8]});
      // XZ derivatives collapse to almost zero, but this cliff pixel spans 32m
      // vertically. Its colour seed must average the 8m source bands, not pick
      // one overhead row or rely only on the minimum 4m seed footprint.
      const verticalFootprint=await render(stripes,{world:[0,10,.5],normal:[1,0,0],dx:[.001,0,0],dy:[0,32,0]});
      const strata=await render(rock,{world:[0,Math.PI/10.4,0],normal:[0,0,1],dx:[.001,0,0],dy:[0,.001,0],mode:1});
      const joint=await render(rock,{world:[0,0,0],normal:[0,0,1],dx:[.001,0,0],dy:[0,.001,0],mode:1});
      const unresolved=await render(rock,{world:[1.137,7.713,4.213],normal:[0,0,1],dx:[2,0,0],dy:[0,2,0],mode:1});
      await d.queue.onSubmittedWorkDone();for(const texture of textures)texture.destroy();d.destroy();
      return {errors,fine,unsupported,seam,halfSeam,cliff,highCliff,wrongSide,masked,minified,verticalFootprint,strata,joint,unresolved};
    });
    t.diagnostic(JSON.stringify(result));assert.deepEqual(result.errors,[]);
    const coarse=[.8,.75,.7],fine=[80,72,64].map(v=>(v/255)**2.2);
    const close=(actual,expected,label)=>expected.forEach((value,i)=>assert.ok(Math.abs(actual[i]-value)<2e-6,`${label} channel ${i}: ${actual[i]} vs ${value}`));
    for(const key of ['fine','cliff','highCliff','minified'])close(result[key],fine,key+' retains the independent dark rock colour');
    for(const key of ['unsupported','seam','wrongSide','masked'])close(result[key],coarse,key+' retains registered fallback, never invalid near surf RGB');
    close(result.halfSeam,coarse.map((v,i)=>(v+fine[i])/2),'32m seam has its true half-weight at 16m');
    close(result.verticalFootprint,[120,108,96].map(v=>(v/255)**2.2),'vertical cliff footprint averages the actual source bands');
    assert.ok(Math.abs(result.strata[0]-1)<2e-6,'resolved strata have real nonzero relief');
    assert.ok(Math.abs(result.joint[1]-1)<2e-6,'resolved joints survive filtering at their own width');
    close(result.unresolved,[0,0,0],'subpixel strata, joints and grain converge without phase aliasing');
    for(const [key,value]of Object.entries(result))if(key!=='errors')assert.ok(value.every(Number.isFinite),key+' remains finite');
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});

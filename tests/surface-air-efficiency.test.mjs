// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {test} from 'node:test';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';

// Frozen fa314e7 implementation. Its distance blend remains the oracle, so a
// changed threshold or a lost solar/lunar/lightning contribution cannot pass by
// comparing two copies of the optimized function.
const reference=/* wgsl */ `
fn surfaceAirReference(color:vec3f,world:vec3f)->vec3f {
  let delta=world-F.camPos.xyz;let d=length(delta);
  let altitude=max(0.0,(world.y+F.camPos.y)*0.5);
  let marine=F.fogExt.w*clamp(F.atmo.x/3.0,0.2,3.0)*exp(-altitude/220.0);
  let extinction=max(F.fogExt.rgb,vec3f(marine))+vec3f(F.reserved.x*0.0025);
  let transmission=exp(-extinction*d);
  let direction=delta/max(d,1e-6);
  let rain=clamp(F.reserved.x,0.0,1.0);
  let zenith=skyAtmo(vec3f(0,1,0));
  let cosine=clamp(dot(direction,F.sunDir.xyz),-1.0,1.0);
  let localSun=sunIlluminance()*step(0.0,F.sunDir.y)*phaseHG(cosine,.8)*.06*mix(1.0,.15,rain);
  let localMoon=lunarIlluminance()*phaseHG(dot(direction,lunarDirection()),.8)*.06*mix(1.0,.15,rain);
  let localAir=zenith*mix(.45,.25,rain)+localSun+localMoon;
  let distantAir=mix(skyAtmo(direction),zenith*.55,rain*.7);
  let air=mix(localAir,distantAir,smoothstep(500.0,2500.0,d))+lightningCloud(direction);
  return color*transmission+air*(1.0-transmission);
}
`;

test('distance branches preserve native surface atmosphere while skipping only zero-weight lighting',{timeout:180000},async t=>{
  const server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');let browser;
  try{
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'
      ?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']
      :['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
    const page=await browser.newPage();await page.route('**/__surface-air-efficiency',r=>r.fulfill({contentType:'text/html',body:'<!doctype html>'}));
    await page.goto('http://127.0.0.1:'+server.address().port+'/__surface-air-efficiency');
    const result=await page.evaluate(async reference=>{
      const {FRAME_WGSL,ATMO_CORE_WGSL,SKY_W,SKY_H}=await import('/js/wgsl/common.js');
      const {SKY_RENDER_FUNCS}=await import('/js/wgsl/sky.js');
      const {withCelestialFrame}=await import('/js/wgsl/celestial.js');
      const {OCEAN_VISIBLE}=await import('/js/wgsl/ocean.js');
      const {CARAVEL}=await import('/js/wgsl/caravel.js');
      const {CREW_RENDER}=await import('/js/wgsl/crew.js');
      const {DECK_RENDER}=await import('/js/wgsl/deck.js');
      const {TERRAIN}=await import('/js/wgsl/terrain.js');
      const {ANCHOR_GPU_RENDER}=await import('/js/wgsl/anchor.js');
      const adapter=await navigator.gpu.requestAdapter();if(!adapter)throw Error('No WebGPU adapter');
      const device=await adapter.requestDevice(),errors=[],derivativeDiagnostics=[];
      device.onuncapturederror=e=>errors.push(e.error.message);
      async function module(code,label){
        const value=device.createShaderModule({code:withCelestialFrame(code),label});
        const info=await value.getCompilationInfo();
        errors.push(...info.messages.filter(m=>m.type==='error').map(m=>label+': '+m.message));
        derivativeDiagnostics.push(...info.messages.filter(m=>/derivative|uniformity/i.test(m.message)).map(m=>label+': '+m.message));
        return value;
      }
      // Check the unchanged shared helper in its real material consumers too;
      // their implicit gradients must not acquire non-uniform control flow.
      for(const [name,source]of Object.entries({ocean:OCEAN_VISIBLE,vessel:CARAVEL,crew:CREW_RENDER,deck:DECK_RENDER,terrain:TERRAIN,anchor:ANCHOR_GPU_RENDER}))await module(source,name);
      const B=GPUBufferUsage,T=GPUTextureUsage,eye=[0,10,0];
      const buffer=(data,usage)=>{const b=device.createBuffer({size:data.byteLength,usage:usage|B.COPY_DST});device.queue.writeBuffer(b,0,data);return b;};
      const frameData=new Float32Array(132),frame=buffer(frameData,B.UNIFORM);
      frameData.set(eye,16);frameData.set([128,8,1/128,1/8],36);frameData.set([3,.01,.3,-.4],72);
      frameData[112]=1;
      const probes=[];
      const distances=[0,1,100,499.9,499.9999694824219,500,500.0000305175781,500.1,750,1500,2499.9,2499.999755859375,2500,2500.000244140625,2500.1,5000,25000];
      const directions=[[1,0,0],[-1,0,0],[0,-1,0],[0,1,0],[1,.003,.3],[.2,-.4,-1]];
      const colors=[[.025,.07,.065],[.12,.045,.016],[.65,.58,.43],[.035,.09,.015]];
      for(const distance of distances)for(const direction of directions)for(const color of colors){
        const length=Math.hypot(...direction);
        probes.push({distance,world:direction.map((v,i)=>eye[i]+v/length*distance),color});
      }
      const source=buffer(new Float32Array(probes.flatMap(p=>[...p.world,0,...p.color,0])),B.STORAGE);
      const output=device.createBuffer({size:probes.length*32,usage:B.STORAGE|B.COPY_SRC});
      const counts=device.createBuffer({size:probes.length*12,usage:B.STORAGE|B.COPY_DST|B.COPY_SRC});
      const read=device.createBuffer({size:probes.length*44,usage:B.COPY_DST|B.MAP_READ});
      const half=value=>{if(value===0)return 0;const e=Math.floor(Math.log2(value));return ((e+15)<<10)+Math.round((value/2**e-1)*1024);};
      const pixels=new Uint16Array(SKY_W*SKY_H*4);
      for(let y=0;y<SKY_H;y++)for(let x=0;x<SKY_W;x++){
        const u=(x+.5)/SKY_W,v=(y+.5)/SKY_H,hotspot=u<.15&&v>.42&&v<.5;
        pixels.set((hotspot?[5,1.2,.08,1]:[.06+.2*u,.1+.12*v,.2+.1*u*v,1]).map(half),(y*SKY_W+x)*4);
      }
      const sky=device.createTexture({size:[SKY_W,SKY_H],format:'rgba16float',usage:T.TEXTURE_BINDING|T.COPY_DST});
      device.queue.writeTexture({texture:sky},pixels,{bytesPerRow:SKY_W*8},[SKY_W,SKY_H]);
      const trans=device.createTexture({size:[4,4],format:'rgba8unorm',usage:T.TEXTURE_BINDING|T.COPY_DST});
      const transPixels=new Uint8Array(4*4*4);
      for(let i=0;i<16;i++)transPixels.set([130+i*5,170+i*3,210+i*2,255],i*4);
      device.queue.writeTexture({texture:trans},transPixels,{bytesPerRow:16},[4,4]);
      const sampler=device.createSampler({minFilter:'linear',magFilter:'linear'});
      const common=FRAME_WGSL+ATMO_CORE_WGSL+`
@group(0)@binding(0)var<uniform>F:Frame;
@group(0)@binding(1)var transLUT:texture_2d<f32>;
@group(0)@binding(2)var skyLUT:texture_2d<f32>;
@group(0)@binding(3)var sampC:sampler;
`;
      const start=SKY_RENDER_FUNCS.indexOf('fn surfaceAir('),end=SKY_RENDER_FUNCS.indexOf('\nfn skyViewUV(',start);
      if(start<0||end<0)throw Error('Missing production surfaceAir');
      const body=SKY_RENDER_FUNCS.slice(start,end).replaceAll('skyAtmo(','countedSkyAtmo(').replaceAll('sunIlluminance(','countedSunIlluminance(').replaceAll('lunarIlluminance(','countedLunarIlluminance(');
      const instrumented=SKY_RENDER_FUNCS.slice(0,start)+body+SKY_RENDER_FUNCS.slice(end);
      const computeModule=await module(common+instrumented+reference+`
struct AirProbe{world:vec4f,color:vec4f};
@group(0)@binding(4)var<storage,read>probes:array<AirProbe>;
@group(0)@binding(5)var<storage,read_write>answers:array<vec4f>;
@group(0)@binding(6)var<storage,read_write>counts:array<atomic<u32>>;
var<private>probeIndex:u32;
fn countedSkyAtmo(d:vec3f)->vec3f{atomicAdd(&counts[probeIndex*3u],1u);return skyAtmo(d);}
fn countedSunIlluminance()->vec3f{atomicAdd(&counts[probeIndex*3u+1u],1u);return sunIlluminance();}
fn countedLunarIlluminance()->vec3f{atomicAdd(&counts[probeIndex*3u+2u],1u);return lunarIlluminance();}
@compute @workgroup_size(32)fn main(@builtin(global_invocation_id)id:vec3u){
 if(id.x>=arrayLength(&probes)){return;}probeIndex=id.x;
 let p=probes[id.x];
 answers[id.x*2u]=vec4f(surfaceAir(p.color.xyz,p.world.xyz),length(p.world.xyz-F.camPos.xyz));
 answers[id.x*2u+1u]=vec4f(surfaceAirReference(p.color.xyz,p.world.xyz),1);
}`,'distance-band comparison');
      const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module:computeModule,entryPoint:'main'}});
      const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{buffer:frame},trans.createView(),sky.createView(),sampler,{buffer:source},{buffer:output},{buffer:counts}].map((resource,binding)=>({binding,resource}))});
      // A real fragment comparison crosses both distance boundaries within a
      // draw, with ordinary implicit texture sampling and fwidth before fog.
      const fragmentFixture=entry=>`
struct AirVertex{@builtin(position)position:vec4f,@location(0)uv:vec2f,@location(1)world:vec3f};
@vertex fn airVS(@builtin(vertex_index)i:u32)->AirVertex{
 let p=vec2f(f32((i<<1u)&2u),f32(i&2u))*2.0-1.0;let uv=p*.5+.5;
 return AirVertex(vec4f(p,0,1),uv,F.camPos.xyz+vec3f(uv.x*5500.0,(uv.y-.5)*300.0,100));
}
@fragment fn airFS(v:AirVertex)->@location(0)vec4f{
 let detail=textureSample(skyLUT,sampC,v.uv).rgb;
 let material=vec3f(.08,.035,.018)+detail*.03+vec3f(fwidth(v.world.x)*.00001);
 return vec4f(${entry}(material,v.world),1);
}`;
      const renderers=[];
      for(const entry of ['surfaceAir','surfaceAirReference']){
        const m=await module(common+SKY_RENDER_FUNCS+reference+fragmentFixture(entry),entry+' fragment');
        const p=await device.createRenderPipelineAsync({layout:'auto',vertex:{module:m,entryPoint:'airVS'},fragment:{module:m,entryPoint:'airFS',targets:[{format:'rgba8unorm'}]},primitive:{topology:'triangle-list'}});
        const g=device.createBindGroup({layout:p.getBindGroupLayout(0),entries:[{buffer:frame},trans.createView(),sky.createView(),sampler].map((resource,binding)=>({binding,resource}))});
        const texture=device.createTexture({size:[128,8],format:'rgba8unorm',usage:T.RENDER_ATTACHMENT|T.COPY_SRC});
        renderers.push({pipeline:p,group:g,texture});
      }
      const renderRead=device.createBuffer({size:8192,usage:B.COPY_DST|B.MAP_READ});
      const frames=[
        {name:'day',sun:.7,moon:-.4,moonLight:0,rain:0,flash:0},
        {name:'sunset',sun:.02,moon:.3,moonLight:.00003,rain:0,flash:0},
        {name:'moonlit night',sun:-.3,moon:.6,moonLight:.00004,rain:0,flash:0},
        {name:'moonless night',sun:-.7,moon:-.3,moonLight:0,rain:0,flash:0},
        {name:'storm day',sun:.4,moon:-.3,moonLight:0,rain:1,flash:.8},
        {name:'storm night',sun:-.5,moon:.4,moonLight:.00002,rain:1,flash:.8},
        {name:'clear air',sun:.4,moon:.4,moonLight:.00002,rain:0,flash:0,clear:true},
      ],rows=[];
      for(const state of frames){
        frameData.set([Math.sqrt(1-state.sun*state.sun),state.sun,0,3],32);
        frameData.set([Math.sqrt(1-state.moon*state.moon),state.moon,0,state.moonLight],96);
        frameData.set(state.clear?[0,0,0,0]:[.00012,.00015,.00018,.00008],88);
        frameData.set([state.rain,0,state.flash,0],92);
        device.queue.writeBuffer(frame,0,frameData);device.queue.writeBuffer(counts,0,new Uint32Array(probes.length*3));
        const enc=device.createCommandEncoder(),pass=enc.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(probes.length/32));pass.end();
        enc.copyBufferToBuffer(output,0,read,0,probes.length*32);enc.copyBufferToBuffer(counts,0,read,probes.length*32,probes.length*12);
        for(const [i,r]of renderers.entries()){
          const rp=enc.beginRenderPass({colorAttachments:[{view:r.texture.createView(),clearValue:[0,0,0,1],loadOp:'clear',storeOp:'store'}]});
          rp.setPipeline(r.pipeline);rp.setBindGroup(0,r.group);rp.draw(3);rp.end();
          enc.copyTextureToBuffer({texture:r.texture},{buffer:renderRead,offset:i*4096,bytesPerRow:512},[128,8]);
        }
        device.queue.submit([enc.finish()]);await read.mapAsync(GPUMapMode.READ);await renderRead.mapAsync(GPUMapMode.READ);
        const mapped=read.getMappedRange();
        const values=new Float32Array(mapped,0,probes.length*8),calls=new Uint32Array(mapped,probes.length*32,probes.length*3);
        let worst=0,nonFinite=0,badCalls=0;const bands=[0,0,0];
        for(let i=0;i<probes.length;i++){
          const distance=values[i*8+3],band=distance<=500?0:distance<2500?1:2;bands[band]++;
          const expected=[band===0?1:2,band===2?0:1,band===2?0:1];
          if(expected.some((v,k)=>calls[i*3+k]!==v))badCalls++;
          for(let k=0;k<3;k++){
            const actual=values[i*8+k],expected=values[i*8+4+k];
            if(!Number.isFinite(actual)||!Number.isFinite(expected))nonFinite++;
            worst=Math.max(worst,Math.abs(actual-expected)/Math.max(1,Math.abs(expected)));
          }
        }
        const rendered=new Uint8Array(renderRead.getMappedRange());let worstPixel=0;
        for(let i=0;i<4096;i++)worstPixel=Math.max(worstPixel,Math.abs(rendered[i]-rendered[i+4096]));
        rows.push({name:state.name,worst,nonFinite,badCalls,bands,worstPixel});
        read.unmap();renderRead.unmap();
      }
      await device.queue.onSubmittedWorkDone();device.destroy();return {errors,derivativeDiagnostics,rows};
    },reference);
    assert.deepEqual(result.errors,[]);assert.deepEqual(result.derivativeDiagnostics,[]);
    for(const row of result.rows){
      assert.equal(row.nonFinite,0,row.name+' finite radiance');
      assert.ok(row.worst<=2e-6,row.name+' preserves original HDR radiance: '+JSON.stringify(row));
      assert.equal(row.badCalls,0,row.name+' evaluates only the nonzero-weight lighting paths');
      assert.ok(row.bands.every(n=>n>0),row.name+' covers near, blend and distant samples');
      assert.ok(row.worstPixel<=1,row.name+' preserves fragment material pixels: '+JSON.stringify(row));
    }
    t.diagnostic(JSON.stringify(result.rows));
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});

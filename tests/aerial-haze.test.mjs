// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {after,before,test} from 'node:test';
import {chromium} from 'playwright';

const port=process.env.AERIAL_HAZE_TEST_PORT||8111,origin=`http://localhost:${port}`;
let server,browser;
before(async()=>{
  server=spawn(process.execPath,['server.mjs',String(port)],{cwd:new URL('..',import.meta.url),stdio:['ignore','pipe','inherit']});
  await Promise.race([once(server.stdout,'data'),once(server,'exit').then(([code])=>{throw Error('Aerial haze test server exited '+code);})]);
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,
    args:process.env.WEBGPU_BACKEND==='metal'?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
});
after(async()=>{await browser?.close();server?.kill();});

test('shared surface atmosphere does not project the sunset horizon onto opaque objects below the camera',{timeout:120000},async()=>{
  const page=await browser.newPage();
  try{
    await page.route('**/__aerial-haze',route=>route.fulfill({contentType:'text/html',body:'<!doctype html>'}));
    await page.goto(`${origin}/__aerial-haze`);
    const result=await page.evaluate(async()=>{
      const {FRAME_WGSL,ATMO_CORE_WGSL,SKY_W,SKY_H}=await import('/js/wgsl/common.js');
      const {SKY_RENDER_FUNCS}=await import('/js/wgsl/sky.js');
      const device=await(await navigator.gpu.requestAdapter()).requestDevice(),errors=[];
      device.onuncapturederror=event=>errors.push(event.error.message);
      const B=GPUBufferUsage,T=GPUTextureUsage,buffer=(data,usage)=>{
        const value=device.createBuffer({size:data.byteLength,usage:usage|B.COPY_DST});
        device.queue.writeBuffer(value,0,data);return value;
      };
      const eye=[0,200,0],base=[.025,.015,.01],probes=[];
      const add=(name,direction,distance=200,color=base)=>{
        const length=Math.hypot(...direction)||1;
        probes.push({name,world:direction.map((v,i)=>eye[i]+v/length*distance),color});
      };
      add('nadir',[0,-1,0]);
      add('near nadir sunward',[.01,-1,0]);add('near nadir away',[-.01,-1,0]);
      add('down sunward',[1,-1,0]);add('down away',[-1,-1,0]);
      add('horizon sunward',[1,.002,0]);add('horizon away',[-1,.002,0]);
      add('distant horizon sunward',[1,.002,0],5000);add('distant horizon away',[-1,.002,0],5000);
      for(const y of [-.01,-.002,0,.002,.01])add('near horizon '+y,[1,y,0],100);
      add('eye',[0,0,0],0);
      for(const distance of [1,10,50,100,200])add('distance '+distance,[1,-1,0],distance);
      for(const x of [-.002,-.001,0,.001,.002])add('cross nadir '+x,[x,-1,0]);
      // This LUT deliberately has a narrow, bright orange sunset at the upper
      // horizon and a dim lower hemisphere. It isolates angular sampling from
      // the atmosphere integrator. Clamping every negative view elevation to
      // the horizon reproduces the reported sunward wedge on water and ships.
      const half=value=>{if(value===0)return 0;const e=Math.floor(Math.log2(value));return ((e+15)<<10)+Math.round((value/2**e-1)*1024);};
      const pixels=new Uint16Array(SKY_W*SKY_H*4);
      for(let y=0;y<SKY_H;y++)for(let x=0;x<SKY_W;x++){
        const u=(x+.5)/SKY_W,v=(y+.5)/SKY_H;
        const hotspot=u<.14&&v>.43&&v<.5;
        const color=hotspot?[6,2,.1]:[.1,.15,.25];
        pixels.set([...color.map(half),half(1)],(y*SKY_W+x)*4);
      }
      const sky=device.createTexture({size:[SKY_W,SKY_H],format:'rgba16float',usage:T.TEXTURE_BINDING|T.COPY_DST});
      device.queue.writeTexture({texture:sky},pixels,{bytesPerRow:SKY_W*8},[SKY_W,SKY_H]);
      const sampler=device.createSampler({minFilter:'linear',magFilter:'linear'});
      const trans=device.createTexture({size:[1,1],format:'rgba8unorm',usage:T.TEXTURE_BINDING|T.COPY_DST});
      device.queue.writeTexture({texture:trans},new Uint8Array([230,166,89,255]),{bytesPerRow:4},[1,1]);
      const frameData=new Float32Array(96),angle=2*Math.PI/180;
      frameData.set(eye,16);frameData.set([Math.cos(angle),Math.sin(angle),0,1],32);
      frameData.set([3,.2,0,0],72);frameData.set([.0005,.0005,.0005,0],88);
      const frame=buffer(frameData,B.UNIFORM),input=buffer(new Float32Array(probes.flatMap(p=>[...p.world,0,...p.color,0])),B.STORAGE);
      const output=device.createBuffer({size:probes.length*16,usage:B.STORAGE|B.COPY_SRC});
      const read=device.createBuffer({size:probes.length*16,usage:B.COPY_DST|B.MAP_READ});
      const code=FRAME_WGSL+ATMO_CORE_WGSL+`
@group(0)@binding(0)var<uniform>F:Frame;
@group(0)@binding(1)var transLUT:texture_2d<f32>;
@group(0)@binding(2)var skyLUT:texture_2d<f32>;
@group(0)@binding(3)var sampC:sampler;
`+SKY_RENDER_FUNCS+`
struct SurfaceProbe {world:vec4f,color:vec4f};
@group(0)@binding(4)var<storage,read>probes:array<SurfaceProbe>;
@group(0)@binding(5)var<storage,read_write>answers:array<vec4f>;
@compute @workgroup_size(32)fn main(@builtin(global_invocation_id)i:vec3u){
 if(i.x>=arrayLength(&probes)){return;}
 answers[i.x]=vec4f(surfaceAir(probes[i.x].color.xyz,probes[i.x].world.xyz),1);
}`;
      const module=device.createShaderModule({code}),info=await module.getCompilationInfo();
      errors.push(...info.messages.filter(m=>m.type==='error').map(m=>m.message));
      const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'main'}});
      const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[
        {binding:0,resource:{buffer:frame}},{binding:1,resource:trans.createView()},{binding:2,resource:sky.createView()},{binding:3,resource:sampler},
        {binding:4,resource:{buffer:input}},{binding:5,resource:{buffer:output}},
      ]});
      async function render(clear=false,rain=0){
        frameData.set(clear?[0,0,0,0]:[.0005,.0005,.0005,0],88);
        frameData[92]=rain;device.queue.writeBuffer(frame,0,frameData);
        const enc=device.createCommandEncoder(),pass=enc.beginComputePass();
        pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(probes.length/32));pass.end();
        enc.copyBufferToBuffer(output,0,read,0,probes.length*16);device.queue.submit([enc.finish()]);await read.mapAsync(GPUMapMode.READ);
        const values=new Float32Array(read.getMappedRange()).slice();read.unmap();
        return Object.fromEntries(probes.map((p,i)=>[p.name,Array.from(values.slice(i*4,i*4+3))]));
      }
      const haze=await render(),clear=await render(true),rain=await render(false,1);
      // Alter only the distant horizon image. Local finite-path scattering must
      // not change on an opaque ship 100 m away, even in pouring rain.
      for(let y=0;y<SKY_H;y++)for(let x=0;x<SKY_W;x++)pixels.set([.1,.15,.25,1].map(half),(y*SKY_W+x)*4);
      device.queue.writeTexture({texture:sky},pixels,{bytesPerRow:SKY_W*8},[SKY_W,SKY_H]);
      const flatRain=await render(false,1);
      device.destroy();return {errors,base,probes,haze,clear,rain,flatRain};
    });
    assert.deepEqual(result.errors,[]);
    const separation=(a,b)=>Math.hypot(...a.map((v,i)=>v-b[i]));
    const {haze,clear,rain,flatRain,base}=result;
    for(const frame of [haze,clear,rain])for(const [name,color]of Object.entries(frame)){
      assert.ok(color.every(v=>Number.isFinite(v)&&v>=0),`${name} must remain finite: ${color}`);
    }
    const horizonExcess=separation(haze['distant horizon sunward'],haze['distant horizon away']);
    assert.ok(horizonExcess>.2,'the test must retain a strong, legitimate sunset horizon');
    for(const [toward,away]of [['near nadir sunward','near nadir away'],['down sunward','down away']]){
      assert.ok(separation(haze[toward],haze[away])<horizonExcess*.02,
        `opaque objects viewed downward must not inherit the azimuthal horizon flare: ${JSON.stringify({toward:haze[toward],away:haze[away],horizonExcess})}`);
    }
    const previous=haze['cross nadir -0.002'];
    for(const x of [-.001,0,.001,.002])assert.ok(separation(previous,haze['cross nadir '+x])<1e-5,
      'crossing vertical must not introduce a sun-facing wedge or azimuth seam');
    for(const frame of [haze,clear,rain])assert.ok(separation(frame.eye,base)<1e-7,'a zero-length air segment preserves material radiance');
    for(const [name,color]of Object.entries(clear))assert.ok(separation(color,base)<1e-7,`${name}: clear air preserves radiance exactly`);
    let previousDistance=0;
    for(const distance of [1,10,50,100,200]){
      const difference=separation(haze['distance '+distance],base);
      assert.ok(difference>previousDistance,'distance increases the existing finite-segment atmospheric veil');
      previousDistance=difference;
    }
    for(const y of [-.01,-.002,0,.002,.01])assert.ok(separation(rain['near horizon '+y],flatRain['near horizon '+y])<1e-7,
      'nearby opaque sails must not inherit the infinite sky horizon during heavy rain');
    assert.ok(separation(rain['distant horizon sunward'],flatRain['distant horizon sunward'])>.05,
      'kilometre-scale visibility must retain distant directional scattering');
    assert.ok(separation(rain['down sunward'],rain['down away'])<horizonExcess*.02,
      'precipitation haze must not reintroduce the horizon flare below the camera');
  }finally{await page.close();}
});

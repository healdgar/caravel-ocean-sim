// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {after,before,test} from 'node:test';
import {chromium} from 'playwright';

const port=process.env.UNDERWATER_OPTICS_TEST_PORT||8123,origin=`http://localhost:${port}`;
let server,browser;
before(async()=>{
  server=spawn(process.execPath,['server.mjs',String(port)],{cwd:new URL('..',import.meta.url),stdio:['ignore','pipe','inherit']});
  await Promise.race([once(server.stdout,'data'),once(server,'exit').then(([code])=>{throw Error('Underwater optics test server exited '+code);})]);
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,
    args:process.env.WEBGPU_BACKEND==='metal'?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
});
after(async()=>{await browser?.close();server?.kill();});
async function probePage(run,argument){
  const page=await browser.newPage();
  try{await page.route('**/__underwater-optics',route=>route.fulfill({contentType:'text/html',body:'<!doctype html>'}));await page.goto(`${origin}/__underwater-optics`);return await page.evaluate(run,argument);}
  finally{await page.close();}
}

// These fixtures deliberately isolate independent optical invariants from the
// full scene, then exercise the production helper and its actual depth reads.
test('water interior Fresnel produces the physical critical angle and Snell window',{timeout:120000},async()=>{
  const result=await probePage(async()=>{
    const {WATER_OPTICS}=await import('/js/wgsl/water-optics.js');
    const device=await(await navigator.gpu.requestAdapter()).requestDevice(),errors=[];device.onuncapturederror=e=>errors.push(e.error.message);
    const critical=Math.asin(1/1.333),angles=[0,20,40,45,critical*180/Math.PI-.02,critical*180/Math.PI+.02,60,89];
    const data=new Float32Array(angles.flatMap(degrees=>[degrees*Math.PI/180,0,0,0])),B=GPUBufferUsage;
    const input=device.createBuffer({size:data.byteLength,usage:B.STORAGE|B.COPY_DST});device.queue.writeBuffer(input,0,data);
    const output=device.createBuffer({size:data.byteLength,usage:B.STORAGE|B.COPY_SRC}),read=device.createBuffer({size:data.byteLength,usage:B.COPY_DST|B.MAP_READ});
    const module=device.createShaderModule({code:WATER_OPTICS+`
@group(0)@binding(0)var<storage,read>angles:array<vec4f>;
@group(0)@binding(1)var<storage,read_write>answers:array<vec4f>;
@compute @workgroup_size(16)fn main(@builtin(global_invocation_id)i:vec3u){
 if(i.x>=arrayLength(&angles)){return;}
 let a=angles[i.x].x;let incoming=vec3f(sin(a),cos(a),0);
 let transmitted=refract(incoming,vec3f(0,-1,0),WATER_REFRACTIVE_INDEX);
 answers[i.x]=vec4f(waterInteriorFresnel(cos(a)),length(transmitted),transmitted.xy);
}`});
    errors.push(...(await module.getCompilationInfo()).messages.filter(m=>m.type==='error').map(m=>m.message));
    const pipe=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'main'}});
    const group=device.createBindGroup({layout:pipe.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:input}},{binding:1,resource:{buffer:output}}]});
    const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(pipe);pass.setBindGroup(0,group);pass.dispatchWorkgroups(1);pass.end();encoder.copyBufferToBuffer(output,0,read,0,data.byteLength);device.queue.submit([encoder.finish()]);
    await read.mapAsync(GPUMapMode.READ);const values=Array.from(new Float32Array(read.getMappedRange()));read.unmap();device.destroy();
    return {errors,critical,rows:angles.map((angle,i)=>({angle,reflection:values[i*4],length:values[i*4+1],ray:values.slice(i*4+2,i*4+4)}))};
  });
  assert.deepEqual(result.errors,[]);
  const normal=((1.333-1)/(1.333+1))**2;
  assert.ok(Math.abs(result.rows[0].reflection-normal)<1e-5,'normal incidence has the same dielectric reflectance from either side');
  for(const row of result.rows){
    assert.ok([row.reflection,row.length,...row.ray].every(Number.isFinite));assert.ok(row.reflection>=0&&row.reflection<=1);
    const radians=row.angle*Math.PI/180;
    if(radians>result.critical){assert.equal(row.reflection,1,'outside Snell window is total internal reflection');assert.equal(row.length,0,'a TIR ray cannot transmit into air');}
    else{assert.ok(Math.abs(row.length-1)<1e-5,'transmitted rays remain unit length');assert.ok(Math.abs(row.ray[0]-1.333*Math.sin(radians))<1e-5,'water-to-air refraction bends away from normal');assert.ok(row.ray[1]>=0);}
  }
  assert.ok(result.rows[4].reflection>.8&&result.rows[4].reflection<1,'reflectance approaches one continuously inside the critical angle');
});

test('wave-derived caustics focus and defocus fixed receivers and fade without sunlight or through opaque water',{timeout:120000},async()=>{
  const result=await probePage(async()=>{
    const {FRAME_WGSL,CASCADES}=await import('/js/wgsl/common.js'),{WATER_OPTICS}=await import('/js/wgsl/water-optics.js'),{waterCausticFunctions}=await import('/js/wgsl/underwater.js');
    const device=await(await navigator.gpu.requestAdapter()).requestDevice(),errors=[];device.onuncapturederror=e=>errors.push(e.error.message);
    const B=GPUBufferUsage,T=GPUTextureUsage,W=64,H=64;
    const buffer=(data,usage)=>{const b=device.createBuffer({size:data.byteLength,usage:usage|B.COPY_DST});device.queue.writeBuffer(b,0,data);return b;};
    const frameData=new Float32Array(96);frameData.set([0,1,0,14],32);frameData.fill(.25,48,54);
    const opticsData=new Float32Array([0,1,2,0]),frame=buffer(frameData,B.UNIFORM),optics=buffer(opticsData,B.UNIFORM),visibility=buffer(new Float32Array([1,0,0,0]),B.STORAGE);
    const field=device.createTexture({size:[W,H,CASCADES],format:'rgba16float',usage:T.TEXTURE_BINDING|T.COPY_DST});
    const sampler=device.createSampler({minFilter:'linear',magFilter:'linear',mipmapFilter:'linear',addressModeU:'repeat',addressModeV:'repeat'});
    const output=device.createBuffer({size:W*H*16,usage:B.STORAGE|B.COPY_SRC}),read=device.createBuffer({size:W*H*16,usage:B.COPY_DST|B.MAP_READ});
    const module=device.createShaderModule({code:FRAME_WGSL+WATER_OPTICS+`
@group(0)@binding(0)var<uniform>F:Frame;
@group(0)@binding(1)var derivTex:texture_2d_array<f32>;
@group(0)@binding(2)var sampR:sampler;
@group(0)@binding(3)var<uniform>optics:vec4f;
@group(0)@binding(4)var<storage,read>sunVis:array<f32,4>;
@group(0)@binding(5)var<storage,read_write>answer:array<vec4f>;
fn sunIlluminance()->vec3f{return vec3f(14);}
fn skyAtmo(direction:vec3f)->vec3f{return vec3f(.3);}
`+waterCausticFunctions({shadows:false})+`
@compute @workgroup_size(8,8)fn main(@builtin(global_invocation_id)i:vec3u){
 if(i.x>=64u||i.y>=64u){return;}
 let p=((vec2f(i.xy)+.5)/64.0-.5)*4.0;
 answer[i.y*64u+i.x]=vec4f(waterCausticFactor(vec3f(p.x,-optics.z,p.y),0),1);
}`});
    errors.push(...(await module.getCompilationInfo()).messages.filter(m=>m.type==='error').map(m=>m.message));
    const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'main'}});
    const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{buffer:frame},field.createView({dimension:'2d-array'}),sampler,{buffer:optics},{buffer:visibility},{buffer:output}].map((resource,binding)=>({binding,resource}))});
    const half=value=>{if(value<0)return half(-value)|32768;if(value===0)return 0;const e=Math.floor(Math.log2(value));return ((e+15)<<10)+Math.round((value/2**e-1)*1024);};
    async function render({amplitude=.22,phase=0,depth=2,turbidity=0,sun=1,visible=1}={}){
      const pixels=new Uint16Array(W*H*CASCADES*4);
      // One physically meaningful sinusoidal height field: x/y slopes are its
      // analytic derivatives. Changing its phase moves light, not the receivers.
      for(let y=0;y<H;y++)for(let x=0;x<W;x++){
        const at=((3*H+y)*W+x)*4;
        pixels[at]=half(amplitude*Math.sin((x+.5)/W*Math.PI*2+phase));pixels[at+1]=half(amplitude*.8*Math.sin((y+.5)/H*Math.PI*2+phase));
      }
      device.queue.writeTexture({texture:field},pixels,{bytesPerRow:W*8,rowsPerImage:H},[W,H,CASCADES]);
      frameData.set([0,sun,0,14],32);device.queue.writeBuffer(frame,0,frameData);opticsData.set([turbidity,1,depth,0]);device.queue.writeBuffer(optics,0,opticsData);device.queue.writeBuffer(visibility,0,new Float32Array([visible,0,0,0]));
      const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(8,8);pass.end();encoder.copyBufferToBuffer(output,0,read,0,W*H*16);device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);
      const values=Array.from(new Float32Array(read.getMappedRange())).filter((_,i)=>i%4===0);read.unmap();
      if(!values.every(Number.isFinite))throw Error('Nonfinite caustic focusing');
      const rms=Math.sqrt(values.reduce((sum,value)=>sum+(value-1)**2,0)/values.length);
      return {values,min:Math.min(...values),max:Math.max(...values),rms};
    }
    const flat=await render({amplitude:0}),waves=await render(),shifted=await render({phase:.8});
    const night=await render({sun:-1}),shadowed=await render({visible:0}),deep=await render({depth:45}),opaque=await render({turbidity:20});
    device.destroy();return {errors,flat,waves,shifted,night,shadowed,deep,opaque};
  });
  assert.deepEqual(result.errors,[]);
  for(const name of ['flat','night','shadowed','deep'])assert.ok(result[name].values.every(value=>Math.abs(value-1)<1e-6),`${name} cannot invent caustic light`);
  assert.ok(result.waves.min<.97&&result.waves.max>1.03,'a refracting curved surface produces both darker gaps and focused bright bands');
  const difference=result.waves.values.reduce((sum,value,i)=>sum+Math.abs(value-result.shifted.values[i]),0)/result.waves.values.length;
  assert.ok(difference>.02,'changing actual wave phase moves the pattern across fixed world receivers');
  assert.ok(result.opaque.rms<result.waves.rms*.2,'suspended matter suppresses underwater contrast instead of preserving clear-water caustics');
  assert.ok(result.waves.min>=0&&result.waves.max<=3.001,'local focusing remains bounded near a caustic fold');
});

for(const samples of [1,4])test(`production underwater helper respects visible depth, current GPU water height and resize (${samples} depth samples)`,{timeout:120000},async()=>{
  const result=await probePage(async(samples)=>{
    const {createUnderwater}=await import('/js/underwater.js'),{CASCADES}=await import('/js/wgsl/common.js');
    const device=await(await navigator.gpu.requestAdapter()).requestDevice(),errors=[];device.onuncapturederror=e=>errors.push(e.error.message);
    const shader=async(code,label)=>{const module=device.createShaderModule({code,label}),info=await module.getCompilationInfo();const failures=info.messages.filter(m=>m.type==='error').map(m=>label+': '+m.message);errors.push(...failures);if(failures.length)throw Error(failures.join('\n'));return module;};
    const B=GPUBufferUsage,T=GPUTextureUsage,half=value=>{if(value<0)return half(-value)|32768;if(value===0)return 0;const e=Math.floor(Math.log2(value));return Math.max(0,Math.min(65535,((e+15)<<10)+Math.round((value/2**e-1)*1024)));};
    const float=bits=>{const sign=bits&32768?-1:1,e=bits>>10&31,m=bits&1023;return sign*(e?(1+m/1024)*2**(e-15):m*2**-24);};
    const buffer=(data,usage)=>{const b=device.createBuffer({size:data.byteLength,usage:usage|B.COPY_DST});device.queue.writeBuffer(b,0,data);return b;};
    const frameData=new Float32Array(96);frameData[0]=frameData[5]=1;frameData[11]=1;frameData[14]=.05;
    frameData.set([0,-2,0,0],16);frameData.set([1,0,0,0],20);frameData.set([0,1,0,0],24);frameData.set([0,0,1,0],28);frameData.set([0,1,0,14],32);frameData[73]=.01;
    // Black volumetric albedo isolates Beer transmission from in-scattering.
    const opticsData=new Float32Array([0,1,-100,0]),probeData=new Float32Array(16);probeData[9]=0;
    const frame=buffer(frameData,B.UNIFORM),optics=buffer(opticsData,B.UNIFORM),probe=buffer(probeData,B.STORAGE),sun=buffer(new Float32Array([1,0,0,0]),B.STORAGE);
    const sampler=device.createSampler({minFilter:'linear',magFilter:'linear'}),seaSampler=device.createSampler({minFilter:'linear',magFilter:'linear',addressModeU:'repeat',addressModeV:'repeat'});
    const trans=device.createTexture({size:[1,1],format:'rgba16float',usage:T.TEXTURE_BINDING|T.COPY_DST}),sky=device.createTexture({size:[1,1],format:'rgba16float',usage:T.TEXTURE_BINDING|T.COPY_DST});
    device.queue.writeTexture({texture:trans},new Uint16Array([half(1),half(1),half(1),half(1)]),{bytesPerRow:8},[1,1]);
    device.queue.writeTexture({texture:sky},new Uint16Array([0,0,0,half(1)]),{bytesPerRow:8},[1,1]);
    const derivative=device.createTexture({size:[1,1,CASCADES],format:'rgba16float',usage:T.TEXTURE_BINDING|T.COPY_DST});
    device.queue.writeTexture({texture:derivative},new Uint16Array(CASCADES*4),{bytesPerRow:8,rowsPerImage:1},[1,1,CASCADES]);
    let filtered=null;const nativeTexture=GPUDevice.prototype.createTexture;
    GPUDevice.prototype.createTexture=function(descriptor){const selected=descriptor.label==='underwater filtered HDR';const texture=nativeTexture.call(this,selected?{...descriptor,usage:descriptor.usage|T.COPY_SRC}:descriptor);if(selected)filtered=texture;return texture;};
    const helper=await createUnderwater({device,shader,frameUBO:frame,opticsUBO:optics,transView:trans.createView(),skyView:sky.createView(),sampler,sunVis:sun,derivView:derivative.createView({dimension:'2d-array'}),seaSampler,cameraProbe:probe,samples});
    const depthParams=buffer(new Float32Array([.05/10,.05/4,0,0]),B.UNIFORM);
    const depthModule=await shader(`
@group(0)@binding(0)var<uniform>depths:vec4f;
@vertex fn vs(@builtin(vertex_index)i:u32)->@builtin(position)vec4f {let p=vec2f(f32((i<<1u)&2u),f32(i&2u))*2.0-1.0;return vec4f(p,.5,1);}
@fragment fn fs(@builtin(sample_index)sample:u32)->@builtin(frag_depth)f32 {return select(depths.x,depths.y,sample==${samples===4?1:0}u);}`,'per-sample depth fixture');
    const depthPipeline=await device.createRenderPipelineAsync({layout:'auto',vertex:{module:depthModule,entryPoint:'vs'},fragment:{module:depthModule,entryPoint:'fs',targets:[]},primitive:{topology:'triangle-list'},depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'always'},multisample:{count:samples}});
    const depthGroup=device.createBindGroup({layout:depthPipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:depthParams}}]});
    let hdr,raw,depth,width=0,height=0;
    function resize(w,h){
      hdr?.destroy();raw?.destroy();depth?.destroy();width=w;height=h;
      const color=()=>device.createTexture({size:[w,h],format:'rgba16float',usage:T.TEXTURE_BINDING|T.COPY_DST});hdr=color();raw=color();depth=device.createTexture({size:[w,h],format:'depth32float',sampleCount:samples,usage:T.RENDER_ATTACHMENT|T.TEXTURE_BINDING});
      frameData.set([w,h,1/w,1/h],36);device.queue.writeBuffer(frame,0,frameData);helper.resize({width:w,height:h,hdrView:hdr.createView(),depthView:depth.createView(),submergedView:raw.createView()});
    }
    function write(texture,color){const pixels=new Uint16Array(width*height*4);for(let i=0;i<pixels.length;i+=4)pixels.set(color.map(half),i);device.queue.writeTexture({texture},pixels,{bytesPerRow:width*8},[width,height]);}
    async function render({original=[.02,.03,.04],captured=[.8,.6,.4],rawDepth=4,forwardDepth=4,eyeY=-2,waterY=0,cpuHeight=-100,turbidity=0,missingDepth=false,active=true}={}){
      frameData[17]=eyeY;device.queue.writeBuffer(frame,0,frameData);opticsData.set([turbidity,1,cpuHeight,0]);device.queue.writeBuffer(optics,0,opticsData);probeData[9]=waterY;device.queue.writeBuffer(probe,0,probeData);
      device.queue.writeBuffer(depthParams,0,new Float32Array([.05/Math.max(forwardDepth*2.5,.001),.05/Math.max(forwardDepth,.001),0,0]));
      write(hdr,[...original,1]);write(raw,[...captured,rawDepth]);
      const encoder=device.createCommandEncoder(),pass=encoder.beginRenderPass({colorAttachments:[],depthStencilAttachment:{view:depth.createView(),depthClearValue:0,depthLoadOp:'clear',depthStoreOp:'store'}});
      if(!missingDepth){pass.setPipeline(depthPipeline);pass.setBindGroup(0,depthGroup);pass.draw(3);}pass.end();const encoded=helper.encode(encoder,active);device.queue.submit([encoder.finish()]);
      if(!encoded)return {encoded};
      const stride=256,read=device.createBuffer({size:stride*height,usage:B.COPY_DST|B.MAP_READ});const copy=device.createCommandEncoder();copy.copyTextureToBuffer({texture:filtered},{buffer:read,bytesPerRow:stride},[width,height]);device.queue.submit([copy.finish()]);await read.mapAsync(GPUMapMode.READ);
      const values=new Uint16Array(read.getMappedRange()),center=(Math.floor(height/2)*stride/2+Math.floor(width/2)*4),color=Array.from(values.slice(center,center+4),float);read.unmap();read.destroy();
      return {encoded,color,width:filtered.width,height:filtered.height};
    }
    resize(3,3);
    const clear=await render(),differentAirFog=await render({original:[.9,.05,.7]}),occluded=await render({rawDepth:9}),missingRaw=await render({rawDepth:0}),air=await render({eyeY:2,cpuHeight:100});
    const movedWater=await render({waterY:-10,cpuHeight:100}),turbid=await render({turbidity:2}),deeper=await render({eyeY:-12}),missing=await render({missingDepth:true,rawDepth:0}),captureOnly=await render({missingDepth:true}),nearerRaw=await render({forwardDepth:8}),far=await render({forwardDepth:500,rawDepth:500}),near=await render({forwardDepth:.1,rawDepth:.1}),skipped=await render({active:false});
    resize(5,3);const resized=await render();helper.destroy();GPUDevice.prototype.createTexture=nativeTexture;device.destroy();
    return {errors,samples,clear,differentAirFog,occluded,missingRaw,air,movedWater,turbid,deeper,missing,captureOnly,nearerRaw,far,near,skipped,resized};
  },samples);
  assert.deepEqual(result.errors,[]);assert.equal(result.samples,samples);
  const extinction=[.20,.065,.035],captured=[.8,.6,.4],original=[.02,.03,.04];
  // Independent optical path: 2m sunlight entry + 4m horizontal view. A second
  // view-leg attenuation or unreplaced air fog cannot satisfy this expectation.
  for(let c=0;c<3;c++)assert.ok(Math.abs(result.clear.color[c]-captured[c]*Math.exp(-extinction[c]*6))<.0015,`channel ${c}: apply each physical water segment exactly once`);
  assert.deepEqual(result.clear.color,result.differentAirFog.color,'visible raw material bypasses the pre-fogged main color');
  for(const name of ['occluded','missingRaw'])for(let c=0;c<3;c++)assert.ok(Math.abs(result[name].color[c]-original[c]*Math.exp(-extinction[c]*4))<.00015,'hidden or absent raw geometry cannot leak through the visible surface');
  for(const name of ['air','movedWater'])for(let c=0;c<3;c++)assert.ok(Math.abs(result[name].color[c]-original[c])<.00004,`${name}: current GPU eye/sea relation wins over deliberately wrong CPU height`);
  assert.ok(result.turbid.color.slice(0,3).every((value,i)=>value<result.clear.color[i]),'higher turbidity attenuates the same path more');
  assert.ok(result.deeper.color.slice(0,3).every((value,i)=>value<result.clear.color[i]),'surface sunlight weakens with actual receiver depth');
  assert.deepEqual(result.missing.color,[0,0,0,1],'a depth miss cannot expose sky or unmatched captured geometry below water');
  for(const name of ['captureOnly','nearerRaw'])assert.deepEqual(result[name].color,result.clear.color,'nearest captured seabed fills air-side omissions without shining through foreground geometry');
  assert.ok(result.far.color.slice(0,3).every(value=>Number.isFinite(value)&&value<.001),'distant paths remain finite and fade into black non-scattering water');
  assert.ok(result.near.color.slice(0,3).every((value,i)=>Number.isFinite(value)&&value>result.clear.color[i]),'near visible receivers retain more contrast');
  assert.equal(result.skipped.encoded,false,'distant air/disabled host path must encode no optional pass');
  assert.deepEqual([result.resized.width,result.resized.height],[5,3]);assert.deepEqual(result.resized.color,result.clear.color,'resize rebinds depth, capture and target without changing central ray optics');
});

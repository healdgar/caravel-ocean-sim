// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {after,before,test} from 'node:test';
import {chromium} from 'playwright';

const port=process.env.SHADOW_FILTER_TEST_PORT||8126,origin=`http://localhost:${port}`;
let server,browser;
before(async()=>{
  server=spawn(process.execPath,['server.mjs',String(port)],{cwd:new URL('..',import.meta.url),stdio:['ignore','pipe','inherit']});
  await Promise.race([once(server.stdout,'data'),once(server,'exit').then(([code])=>{throw Error('Shadow filtering server exited '+code);})]);
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,
    args:process.env.WEBGPU_BACKEND==='metal'?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
});
after(async()=>{await browser?.close();server?.kill();});

test('magnified diagonal shadows retain smooth coverage, opaque occlusion and correctly tinted canvas edges',{timeout:120000},async()=>{
  const page=await browser.newPage();let result;
  try{
    await page.route('**/__shadow-filter',route=>route.fulfill({contentType:'text/html',body:'<!doctype html>'}));await page.goto(origin+'/__shadow-filter');
    result=await page.evaluate(async()=>{
      const {SHADOW_SAMPLE}=await import('/js/wgsl/shadows.js');
      const device=await(await navigator.gpu.requestAdapter()).requestDevice(),errors=[];device.onuncapturederror=e=>errors.push(e.error.message);
      const B=GPUBufferUsage,T=GPUTextureUsage,N=32,W=128,H=128;
      const shader=async(code,label)=>{const module=device.createShaderModule({code,label}),info=await module.getCompilationInfo();const failures=info.messages.filter(m=>m.type==='error').map(m=>label+': '+m.message);errors.push(...failures);if(failures.length)throw Error(failures.join('\n'));return module;};
      const buffer=(data,usage)=>{const b=device.createBuffer({size:data.byteLength,usage:usage|B.COPY_DST});device.queue.writeBuffer(b,0,data);return b;};
      const frames=new Float32Array(28);frames[0]=frames[5]=frames[10]=frames[15]=1;frames[19]=1;frames.set([0,0,1,1],20);frames.set([2/N,2/N,0,0],24);
      const frame=buffer(frames,B.UNIFORM),pointsData=new Float32Array(W*H*4);
      for(let y=0;y<H;y++)for(let x=0;x<W;x++){
        const u=.05+.9*x/(W-1),v=.05+.9*y/(H-1);pointsData.set([u*2-1,1-v*2,.6,0],(y*W+x)*4);
      }
      const points=buffer(pointsData,B.STORAGE),answers=device.createBuffer({size:W*H*16,usage:B.STORAGE|B.COPY_SRC}),read=device.createBuffer({size:W*H*16,usage:B.COPY_DST|B.MAP_READ});
      const depth=()=>device.createTexture({size:[N,N],format:'depth32float',usage:T.TEXTURE_BINDING|T.RENDER_ATTACHMENT});
      const solid=depth(),canvas=depth();
      const color=()=>device.createTexture({size:[N,N],format:'rgba16float',usage:T.TEXTURE_BINDING|T.RENDER_ATTACHMENT});
      const filter=color(),unused=color(),compare=device.createSampler({compare:'less-equal',minFilter:'linear',magFilter:'linear'}),linear=device.createSampler({minFilter:'linear',magFilter:'linear'});
      const probeModule=await shader(SHADOW_SAMPLE+`
@group(0)@binding(0)var<storage,read>points:array<vec4f>;
@group(0)@binding(1)var<storage,read_write>answer:array<vec4f>;
@compute @workgroup_size(64)fn main(@builtin(global_invocation_id)i:vec3u){
 if(i.x>=arrayLength(&points)){return;}
 answer[i.x]=vec4f(vesselShadow(points[i.x].xyz,vec3f(0,0,1)),1);
}`,'magnified shadow coverage probe');
      const probePipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module:probeModule,entryPoint:'main'}});
      const pointGroup=device.createBindGroup({layout:probePipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:points}},{binding:1,resource:{buffer:answers}}]});
      const shadowGroup=device.createBindGroup({layout:probePipeline.getBindGroupLayout(1),entries:[{buffer:frame},solid.createView(),compare,canvas.createView(),filter.createView(),linear].map((resource,binding)=>({binding,resource}))});
      const fillModule=await shader(`
@group(0)@binding(0)var<uniform>parameters:array<vec4f,2>;
struct Filled{@builtin(frag_depth)depth:f32,@location(0)color:vec4f};
@vertex fn vs(@builtin(vertex_index)i:u32)->@builtin(position)vec4f {let p=vec2f(f32((i<<1u)&2u),f32(i&2u))*2.0-1.0;return vec4f(p,.5,1);}
@fragment fn fs(@builtin(position)pixel:vec4f)->Filled {
 let mode=u32(parameters[0].x);let diagonal=pixel.x+pixel.y<parameters[0].y;
 let thin=abs(floor(pixel.x)-floor(pixel.y))<.5;
 let caster=mode==1u||(mode==2u&&diagonal)||(mode==3u&&thin);
 return Filled(select(1.0,.25,caster),select(vec4f(0),parameters[1],caster));
}`,'low-resolution physical caster masks');
      const fillPipeline=await device.createRenderPipelineAsync({layout:'auto',vertex:{module:fillModule,entryPoint:'vs'},fragment:{module:fillModule,entryPoint:'fs',targets:[{format:'rgba16float'}]},primitive:{topology:'triangle-list'},depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'always'}});
      const fillBuffers=[0,1].map(()=>buffer(new Float32Array(8),B.UNIFORM));
      const fillGroups=fillBuffers.map(b=>device.createBindGroup({layout:fillPipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:b}}]}));
      async function render(solidMode,canvasMode,enabled=true){
        device.queue.writeBuffer(fillBuffers[0],0,new Float32Array([solidMode,N,0,0,0,0,0,1]));
        device.queue.writeBuffer(fillBuffers[1],0,new Float32Array([canvasMode,N,0,0,.2,.4,.65,1]));
        frames[19]=enabled?1:0;device.queue.writeBuffer(frame,0,frames);
        const encoder=device.createCommandEncoder();
        for(let i=0;i<2;i++){
          const pass=encoder.beginRenderPass({colorAttachments:[{view:(i?filter:unused).createView(),clearValue:[0,0,0,0],loadOp:'clear',storeOp:'store'}],depthStencilAttachment:{view:(i?canvas:solid).createView(),depthClearValue:1,depthLoadOp:'clear',depthStoreOp:'store'}});
          pass.setPipeline(fillPipeline);pass.setBindGroup(0,fillGroups[i]);pass.draw(3);pass.end();
        }
        const pass=encoder.beginComputePass();pass.setPipeline(probePipeline);pass.setBindGroup(0,pointGroup);pass.setBindGroup(1,shadowGroup);pass.dispatchWorkgroups(Math.ceil(W*H/64));pass.end();encoder.copyBufferToBuffer(answers,0,read,0,W*H*16);device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);
        const values=Array.from(new Float32Array(read.getMappedRange()));read.unmap();if(!values.every(Number.isFinite))throw Error('Nonfinite shadow reconstruction');return values;
      }
      const clear=await render(0,0),opaque=await render(1,0),cloth=await render(0,1),diagonal=await render(2,0),diagonalCloth=await render(0,2),thin=await render(3,0),disabled=await render(1,1,false);
      device.destroy();return {errors,W,H,clear,opaque,cloth,diagonal,diagonalCloth,thin,disabled};
    });
  }finally{await page.close();}
  assert.deepEqual(result.errors,[]);
  for(const name of ['clear','disabled'])for(let i=0;i<result[name].length;i++)assert.ok(Math.abs(result[name][i]-1)<2e-5,`${name} must retain full visibility and normalized energy`);
  for(let i=0;i<result.opaque.length;i+=4)assert.ok(result.opaque.slice(i,i+3).every(value=>value<1e-6),'opaque blocker interiors remain fully occluded');
  const tint=[.2,.4,.65];
  for(let i=0;i<result.cloth.length;i+=4)for(let c=0;c<3;c++)assert.ok(Math.abs(result.cloth[i+c]-tint[c])<.0005,'full canvas shadow preserves its measured transmission');
  let fractional=0,maxJump=0;
  for(let y=0;y<result.H;y++)for(let x=0;x<result.W;x++){
    const at=(y*result.W+x)*4,visibility=result.diagonal[at];
    assert.ok(visibility>=-2e-5&&visibility<=1.00002,'coverage is a bounded visibility fraction');
    if(visibility>.01&&visibility<.99)fractional++;
    if(x){const previous=result.diagonal[at-4];assert.ok(visibility>=previous-2e-5,'an increasing diagonal occlusion edge must not ring');maxJump=Math.max(maxJump,Math.abs(visibility-previous));}
    assert.ok(Math.abs(visibility-result.diagonal[(x*result.W+y)*4])<2e-5,'equal texel scales cannot introduce a preferred horizontal/vertical edge direction');
    // A partly covered colored blocker obeys the same geometric coverage as an
    // opaque one: uncovered light + covered light times material transmission.
    // Filtering a white clear color before this blend would square coverage.
    for(let c=0;c<3;c++)assert.ok(Math.abs(result.diagonalCloth[at+c]-(visibility+(1-visibility)*tint[c]))<.0007,'canvas edge tint must not be diluted twice by uncovered texels');
  }
  assert.ok(fractional>result.W*3&&fractional<result.W*18,'magnified silhouette has a smooth, bounded transition instead of a hard staircase or broad image blur');
  assert.ok(maxJump<.25,'subtexel camera motion cannot jump directly between lit and shadowed');
  assert.ok(result.thin.some((value,i)=>i%4===0&&value<.75),'texel-thin rigging retains a visible shadow');
});

test('rasterized sloped sail planes remain self-lit with geometric normals while a close separate receiver stays shadowed',{timeout:120000},async()=>{
  const page=await browser.newPage();let result;
  try{
    await page.route('**/__shadow-sloped-plane',route=>route.fulfill({contentType:'text/html',body:'<!doctype html>'}));await page.goto(origin+'/__shadow-sloped-plane');
    result=await page.evaluate(async()=>{
      const {SHADOW_SAMPLE}=await import('/js/wgsl/shadows.js');
      const device=await(await navigator.gpu.requestAdapter()).requestDevice(),errors=[];device.onuncapturederror=e=>errors.push(e.error.message);
      const B=GPUBufferUsage,T=GPUTextureUsage,N=64,W=96,H=96;
      const shader=async(code,label)=>{const module=device.createShaderModule({code,label}),info=await module.getCompilationInfo(),failures=info.messages.filter(m=>m.type==='error').map(m=>label+': '+m.message);errors.push(...failures);if(failures.length)throw Error(failures.join('\n'));return module;};
      const buffer=(data,usage)=>{const b=device.createBuffer({size:data.byteLength,usage:usage|B.COPY_DST});device.queue.writeBuffer(b,0,data);return b;};
      // Identity light projection means increasing world Z goes away from a
      // light on -Z. Preserve that sign relation, its world texel size, and the
      // production raster depth biases; a fragment-depth override would bypass
      // the very caster-plane slope integration this regression must exercise.
      const frameData=new Float32Array(28);frameData[0]=frameData[5]=frameData[10]=frameData[15]=1;frameData[19]=1;frameData.set([0,0,-1,1],20);frameData.set([2/N,2/N,0,0],24);
      const frame=buffer(frameData,B.UNIFORM),plane=buffer(new Float32Array(4),B.UNIFORM),normal=buffer(new Float32Array([0,0,1,0]),B.UNIFORM);
      const pointsData=new Float32Array(W*H*4),points=buffer(pointsData,B.STORAGE),output=device.createBuffer({size:W*H*16,usage:B.STORAGE|B.COPY_SRC}),read=device.createBuffer({size:W*H*16,usage:B.COPY_DST|B.MAP_READ});
      const solid=device.createTexture({size:[N,N],format:'depth32float',usage:T.RENDER_ATTACHMENT|T.TEXTURE_BINDING}),canvas=device.createTexture({size:[N,N],format:'depth32float',usage:T.RENDER_ATTACHMENT|T.TEXTURE_BINDING});
      const filter=device.createTexture({size:[N,N],format:'rgba16float',usage:T.RENDER_ATTACHMENT|T.TEXTURE_BINDING}),compare=device.createSampler({compare:'less-equal',minFilter:'linear',magFilter:'linear'}),linear=device.createSampler({minFilter:'linear',magFilter:'linear'});
      const module=await shader(SHADOW_SAMPLE+`
@group(0)@binding(0)var<storage,read>points:array<vec4f>;
@group(0)@binding(1)var<storage,read_write>answers:array<vec4f>;
@group(0)@binding(2)var<uniform>receiverNormal:vec4f;
@compute @workgroup_size(64)fn main(@builtin(global_invocation_id)i:vec3u){
 if(i.x>=arrayLength(&points)){return;}
 answers[i.x]=vec4f(vesselShadow(points[i.x].xyz,receiverNormal.xyz),1);
}`,'sloped self-receiver shadows');
      const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'main'}});
      const queryGroup=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{buffer:points},{buffer:output},{buffer:normal}].map((resource,binding)=>({binding,resource}))});
      const shadowGroup=device.createBindGroup({layout:pipeline.getBindGroupLayout(1),entries:[{buffer:frame},solid.createView(),compare,canvas.createView(),filter.createView(),linear].map((resource,binding)=>({binding,resource}))});
      const caster=await shader(`
@group(0)@binding(0)var<uniform>plane:vec4f;
@vertex fn vs(@builtin(vertex_index)i:u32)->@builtin(position)vec4f {
 let p=vec2f(f32((i<<1u)&2u),f32(i&2u))*2.0-1.0;
 return vec4f(p,plane.z+plane.x*p.x+plane.y*p.y,1);
}
@fragment fn canvasFS()->@location(0)vec4f{return vec4f(.2,.4,.65,1);}
`,'actual rasterized sloped caster');
      const casterPipelines=await Promise.all([false,true].map(cloth=>device.createRenderPipelineAsync({layout:'auto',vertex:{module:caster,entryPoint:'vs'},...(cloth?{fragment:{module:caster,entryPoint:'canvasFS',targets:[{format:'rgba16float'}]}}:{}),primitive:{topology:'triangle-list',cullMode:'none'},depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'less',depthBias:2,depthBiasSlopeScale:1.5}})));
      const casterGroups=casterPipelines.map(pipe=>device.createBindGroup({layout:pipe.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:plane}}]}));
      async function sample(a,b,{cloth=false,geometric=true,gap=0,scale=1}={}){
        device.queue.writeBuffer(plane,0,new Float32Array([a,b,.5,0]));
        frameData[0]=frameData[5]=frameData[10]=1/scale;frameData[23]=scale;frameData[24]=frameData[25]=2*scale/N;device.queue.writeBuffer(frame,0,frameData);
        const length=Math.hypot(a,b,1);device.queue.writeBuffer(normal,0,new Float32Array(geometric?[-a/length,-b/length,1/length,0]:[0,0,1,0]));
        for(let y=0;y<H;y++)for(let x=0;x<W;x++){
          const px=-.16+.32*x/(W-1),py=-.16+.32*y/(H-1);pointsData.set([scale*px,scale*py,scale*(.5+a*px+b*py)+gap,0],(y*W+x)*4);
        }
        device.queue.writeBuffer(points,0,pointsData);
        const encoder=device.createCommandEncoder();
        // Both resources are cleared each time. Draw only the selected material
        // so the same receiver can be tested against opaque or transmissive self.
        for(let i=0;i<2;i++){
          const pass=encoder.beginRenderPass({colorAttachments:i?[{view:filter.createView(),loadOp:'clear',storeOp:'store',clearValue:[0,0,0,0]}]:[],depthStencilAttachment:{view:(i?canvas:solid).createView(),depthClearValue:1,depthLoadOp:'clear',depthStoreOp:'store'}});
          if(i===(cloth?1:0)){pass.setPipeline(casterPipelines[i]);pass.setBindGroup(0,casterGroups[i]);pass.draw(3);}pass.end();
        }
        const pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,queryGroup);pass.setBindGroup(1,shadowGroup);pass.dispatchWorkgroups(Math.ceil(W*H/64));pass.end();encoder.copyBufferToBuffer(output,0,read,0,W*H*16);device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);
        const data=new Float32Array(read.getMappedRange()),minimum=[1,1,1],maximum=[0,0,0],sum=[0,0,0];let nonfinite=false;
        for(let i=0;i<data.length;i+=4)for(let c=0;c<3;c++){const value=data[i+c];nonfinite||=!Number.isFinite(value);minimum[c]=Math.min(minimum[c],value);maximum[c]=Math.max(maximum[c],value);sum[c]+=value;}
        read.unmap();return {a,b,cloth,geometric,gap,scale,nonfinite,minimum,maximum,mean:sum.map(value=>value/(W*H))};
      }
      const slopes=[[0,0],[.2,0],[0,-.2],[.35,-.27],[-.55,.45],[.8,.65]],self=[];
      for(const [a,b] of slopes)for(const cloth of [false,true])self.push(await sample(a,b,{cloth}));
      // Magnify world texels while retaining the same real geometric normal,
      // production slope-scale raster bias and encoded slope. A fixed world
      // receiver offset alone must not hide the 2x2 comparison-plane defect.
      for(const cloth of [false,true])self.push(await sample(.8,.65,{cloth,scale:4}));
      const mismatched=await sample(.8,.65,{cloth:true,geometric:false});
      const contact=await sample(.8,.65,{gap:.08});
      const separateOpaque=await sample(.8,.65,{gap:.16}),separateCanvas=await sample(.8,.65,{gap:.16,cloth:true});
      device.destroy();return {errors,self,mismatched,contact,separateOpaque,separateCanvas};
    });
  }finally{await page.close();}
  assert.deepEqual(result.errors,[]);
  for(const surface of result.self){
    assert.equal(surface.nonfinite,false);
    assert.ok(surface.minimum.every(value=>value>.9998),`a plane must not shadow its own rasterized surface when queried with its true normal: ${JSON.stringify(surface)}`);
    assert.ok(surface.maximum.every(value=>value<1.0002),'self-lit reconstruction remains energy normalized');
  }
  assert.ok(result.mismatched.minimum[0]<.98,'negative control must expose the lattice acne caused by a materially incorrect receiver-plane normal');
  assert.equal(result.contact.nonfinite,false);assert.ok(result.contact.minimum.every(value=>value<.95),'a caster only8cm ahead of a steep receiver must retain visible contact occlusion at this map scale');
  assert.equal(result.separateOpaque.nonfinite,false);assert.ok(result.separateOpaque.maximum.every(value=>value<.01),'preventing self-acne must not erase a separate opaque caster16cm ahead of the steep receiver');
  for(let c=0;c<3;c++)assert.ok(Math.abs(result.separateCanvas.mean[c]-[.2,.4,.65][c])<.001,'a close separate canvas caster still transmits its material tint');
});

// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import {after,before,test} from 'node:test';
import {chromium} from 'playwright';
const port=process.env.SAIL_OPACITY_TEST_PORT||8115,origin=`http://localhost:${port}`;
let server,browser;
before(async()=>{
  server=spawn(process.execPath,['server.mjs',String(port)],{cwd:new URL('..',import.meta.url),stdio:['ignore','pipe','inherit']});
  await Promise.race([once(server.stdout,'data'),once(server,'exit').then(([code])=>{throw Error('Sail opacity server exited '+code);})]);
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,
    args:process.env.WEBGPU_BACKEND==='metal'?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
});
after(async()=>{await browser?.close();server?.kill();});

test('posed Niña and Victory canvas occludes sky and ocean backgrounds while transmitting sunlight',{timeout:120000},async()=>{
  const page=await browser.newPage();
  try{
    await page.route('**/__sail-opacity',r=>r.fulfill({contentType:'text/html',body:'<!doctype html>'}));await page.goto(`${origin}/__sail-opacity`);
    const source=await readFile(new URL('../js/main.js',import.meta.url),'utf8');
    const descriptorSource=source.match(/const caravelPipe = await device\.createRenderPipelineAsync\((\{[\s\S]*?\n  \})\);/)?.[1];
    assert.ok(descriptorSource,'use the real renderer pipeline descriptor');
    const result=await page.evaluate(async descriptorSource=>{
      const {CARAVEL}=await import('/js/wgsl/caravel.js'),{createCaravelMesh}=await import('/js/caravel.js'),{createVictoryMesh}=await import('/js/victory.js');
      const {createLateenPoses,writeLateenUniform}=await import('/js/lateen.js');
      const device=await(await navigator.gpu.requestAdapter()).requestDevice(),errors=[];device.onuncapturederror=e=>errors.push(e.error.message);
      const B=GPUBufferUsage,T=GPUTextureUsage,W=128,H=128,bytesPerRow=W*8;
      const buffer=(data,usage)=>{const b=device.createBuffer({size:Math.max(4,data.byteLength),usage:usage|B.COPY_DST});device.queue.writeBuffer(b,0,data);return b;};
      const module=device.createShaderModule({code:CARAVEL+'\n@fragment fn coverageFS(in:BoatVertex)->@location(0)vec4f{return vec4f(1);}',label:'production cloth opacity'});
      const info=await module.getCompilationInfo();errors.push(...info.messages.filter(m=>m.type==='error').map(m=>m.message));
      // The actual renderer's descriptor catches blending/depth regressions too.
      // Only its shader module and target constants are supplied by this fixture.
      const descriptor=Function('caravelMod','HDR','MSAA','return ('+descriptorSource+');')(module,'rgba16float',4);
      const pipeline=await device.createRenderPipelineAsync(descriptor);
      const mask=await device.createRenderPipelineAsync({...descriptor,fragment:{module,entryPoint:'coverageFS',targets:[{format:'rgba16float'}]}});
      const backgrounds=await Promise.all([0,1].map(async variant=>{
        const bg=device.createShaderModule({code:`struct O{@builtin(position)p:vec4f,@location(0)q:vec2f};@vertex fn vs(@builtin(vertex_index)i:u32)->O{let p=array<vec2f,3>(vec2f(-1,-1),vec2f(3,-1),vec2f(-1,3))[i];return O(vec4f(p,.1,1),p);}@fragment fn fs(o:O)->@location(0)vec4f{let stripe=fract((o.q.x+o.q.y)*12.0)>.5;return vec4f(select(${variant?'vec3f(0,0,4),vec3f(4,4,0)':'vec3f(4,0,0),vec3f(0,4,4)'},stripe),1);}`});
        return device.createRenderPipelineAsync({layout:'auto',vertex:{module:bg,entryPoint:'vs'},fragment:{module:bg,entryPoint:'fs',targets:[{format:'rgba16float'}]},depthStencil:{format:'depth32float',depthWriteEnabled:false,depthCompare:'greater'},multisample:{count:4}});
      }));
      const tex=(color,layers=1)=>{const t=device.createTexture({size:[1,1,layers],format:'rgba8unorm',usage:T.TEXTURE_BINDING|T.COPY_DST});for(let i=0;i<layers;i++)device.queue.writeTexture({texture:t,origin:[0,0,i]},new Uint8Array([...color,255]),{bytesPerRow:4},[1,1]);return t;};
      const trans=tex([255,230,190]),sky=tex([35,50,75]),env=tex([35,50,75],6),water=tex([20,30,35]),sea=tex([0,0,0],3),oak=tex([128,128,128]),deck=tex([0,0,0]),filter=tex([255,255,255]);
      const depths=[0,1].map(()=>device.createTexture({size:[4,4],format:'depth32float',usage:T.RENDER_ATTACHMENT|T.TEXTURE_BINDING}));
      const sampler=device.createSampler({magFilter:'linear',minFilter:'linear'}),compare=device.createSampler({compare:'less-equal'});
      const frame=buffer(new Float32Array(96),B.UNIFORM),hull=buffer(new Float32Array(52),B.UNIFORM),sun=buffer(new Float32Array([1,0,0,0]),B.STORAGE),shadow=buffer(new Float32Array(28),B.UNIFORM),wet=buffer(new Float32Array(2),B.STORAGE);
      const colorMS=device.createTexture({size:[W,H],format:'rgba16float',sampleCount:4,usage:T.RENDER_ATTACHMENT}),output=device.createTexture({size:[W,H],format:'rgba16float',usage:T.RENDER_ATTACHMENT|T.COPY_SRC}),depth=device.createTexture({size:[W,H],format:'depth32float',sampleCount:4,usage:T.RENDER_ATTACHMENT});
      const read=device.createBuffer({size:bytesPerRow*H,usage:B.COPY_DST|B.MAP_READ});
      const shadowGroup=device.createBindGroup({layout:pipeline.getBindGroupLayout(1),entries:[{buffer:shadow},depths[0].createView(),compare,depths[1].createView(),filter.createView(),sampler].map((resource,binding)=>({binding,resource}))});
      const half=value=>{const sign=value&0x8000?-1:1,e=(value>>10)&31,m=value&1023;return sign*(e===0?m*2**-24:e===31?m?NaN:Infinity:(1+m/1024)*2**(e-15));};
      const report=[];
      for(const c of [{name:'Niña lateen',model:0,material:13+1/16,eye:[15,7,-2],range:7},{name:'Victory course',model:1,material:9+1/64,eye:[0,4.3,-15],range:3.8},{name:'Victory headsail',model:1,material:13+9/64,eye:[15,4,-5.4],range:4.5},{name:'Victory spanker',model:1,material:9+12/64,eye:[15,4.5,5],range:3.2}]){
        const raw=c.model?createVictoryMesh():createCaravelMesh(),selected=[];
        for(let i=0;i<raw.length;i+=27)if(Math.abs(raw[i+6]-c.material)<1e-6)selected.push(...raw.slice(i,i+27));
        if(!selected.length)throw Error('Missing actual cloth mesh: '+c.name);
        const mesh=new Float32Array(selected),vertices=buffer(mesh,B.VERTEX),lookup=buffer(new Uint32Array(mesh.length/9),B.STORAGE);
        const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{buffer:frame},trans.createView(),sky.createView(),sampler,env.createView({dimension:'cube'}),{buffer:sun},{buffer:hull},water.createView(),sea.createView({dimension:'2d-array'}),sampler,oak.createView(),sampler,deck.createView(),{buffer:wet},{buffer:lookup}].map((resource,binding)=>({binding,resource}))});
        const maskGroup=device.createBindGroup({layout:mask.getBindGroupLayout(0),entries:[[0,frame],[6,hull],[13,wet],[14,lookup]].map(([binding,b])=>({binding,resource:{buffer:b}}))});
        for(const deployed of [1,.5])for(const side of [-1,1]){
          const h=new Float32Array(52);h[0]=h[3]=h[5]=1;h[10]=-1;h[12]=3.6;h[13]=12;h[23]=c.model;h[19]=1.25;h[21]=6;h.set([deployed,deployed,deployed],24);h.set([-.23,.35,.8,.8],28);h.set([6,.2,6,1],32);
          const rig=createLateenPoses([deployed,deployed,deployed],1);for(const p of rig){p.opening=.3;p.fill=.8;p.pressure=1;}writeLateenUniform(h,{rig});for(let i=0;i<3;i++)if(c.model)h[39+i*4]=.8;
          device.queue.writeBuffer(hull,0,h);
          const f=new Float32Array(96),eye=c.eye.map((v,i)=>i===(c.name==='Victory course'?2:0)?v*side:v),alongZ=c.name==='Victory course';
          if(alongZ){f[0]=side/c.range;f[5]=1/c.range;f[10]=-side/40;}else{f[8]=-side/c.range;f[5]=1/c.range;f[2]=side/40;}f[14]=.9;f[15]=1;f.set(eye,16);f.set([0,.2,-Math.sqrt(.96),14],32);f.set([W,H,1/W,1/H],36);f.fill(.01,48,54);f[63]=1;f.set([3,.02,0,0],72);
          async function draw(which,{coverage=false,solar=true,after=false}={}){
            device.queue.writeBuffer(frame,0,f);device.queue.writeBuffer(sun,0,new Float32Array([solar?1:0,0,0,0]));
            const enc=device.createCommandEncoder(),pass=enc.beginRenderPass({colorAttachments:[{view:colorMS.createView(),resolveTarget:output.createView(),clearValue:[0,0,0,0],loadOp:'clear',storeOp:'discard'}],depthStencilAttachment:{view:depth.createView(),depthClearValue:0,depthLoadOp:'clear',depthStoreOp:'discard'}});
            if(!coverage&&!after){pass.setPipeline(backgrounds[which]);pass.draw(3);}
            pass.setPipeline(coverage?mask:pipeline);pass.setBindGroup(0,coverage?maskGroup:group);if(!coverage)pass.setBindGroup(1,shadowGroup);pass.setVertexBuffer(0,vertices);pass.draw(mesh.length/9);
            if(!coverage&&after){pass.setPipeline(backgrounds[which]);pass.draw(3);}pass.end();
            enc.copyTextureToBuffer({texture:output},{buffer:read,bytesPerRow},[W,H]);device.queue.submit([enc.finish()]);await read.mapAsync(GPUMapMode.READ);const colors=Array.from(new Uint16Array(read.getMappedRange()),half);read.unmap();return colors;
          }
          const coverage=await draw(0,{coverage:true}),a=await draw(0),b=await draw(1),after=await draw(1,{after:true}),shade=await draw(0,{solar:false});
          let pixels=0,maxDifference=0,maxDepthDifference=0,light=0,dark=0,backgroundDifference=0;
          for(let i=0;i<a.length;i+=4){if(coverage[i+3]>.999){pixels++;for(let k=0;k<3;k++){maxDifference=Math.max(maxDifference,Math.abs(a[i+k]-b[i+k]));maxDepthDifference=Math.max(maxDepthDifference,Math.abs(a[i+k]-after[i+k]));light+=a[i+k];dark+=shade[i+k];}}else if(coverage[i+3]<.001)for(let k=0;k<3;k++)backgroundDifference=Math.max(backgroundDifference,Math.abs(a[i+k]-b[i+k]));}
          report.push({name:c.name,deployed,side,pixels,maxDifference,maxDepthDifference,light,dark,backgroundDifference});vertices.label=c.name;
        }
        vertices.destroy();lookup.destroy();
      }
      await device.queue.onSubmittedWorkDone();device.destroy();return {errors,report};
    },descriptorSource);
    assert.deepEqual(result.errors,[]);
    for(const r of result.report){
      assert.ok(r.pixels>30,JSON.stringify(r));assert.ok(r.backgroundDifference>2,'fixture must expose a strongly changing background');
      assert.equal(r.maxDifference,0,'actual canvas must hide arbitrary sky/ocean radiance: '+JSON.stringify(r));
      assert.equal(r.maxDepthDifference,0,'canvas must also reject a later background through its depth: '+JSON.stringify(r));
      assert.ok(r.light>r.dark*1.05,'opaque canvas must retain its direct or transmitted sunlight response: '+JSON.stringify(r));
    }
  }finally{await page.close();}
});

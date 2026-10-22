// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {test} from 'node:test';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';

test('actual528-byte celestial shaders preserve lunar phase orientation, horizon rejection and material illumination',{timeout:120000},async()=>{
  const server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');let browser;
  try{
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
    const page=await browser.newPage();await page.route('**/__celestial',route=>route.fulfill({contentType:'text/html',body:'<!doctype html>'}));await page.goto('http://127.0.0.1:'+server.address().port+'/__celestial');
    const result=await page.evaluate(async()=>{
      const {FRAME_WGSL,ATMO_CORE_WGSL}=await import('/js/wgsl/common.js'),{SKY_RENDER_FUNCS}=await import('/js/wgsl/sky.js');
      const {withCelestialFrame,CELESTIAL_STAR_STUB,CELESTIAL_STARS,CELESTIAL_LINES}=await import('/js/wgsl/celestial.js');
      const device=await(await navigator.gpu.requestAdapter()).requestDevice(),errors=[];device.onuncapturederror=e=>errors.push(e.error.message);
      const B=GPUBufferUsage,T=GPUTextureUsage,frameData=new Float32Array(132);
      const buffer=(size,usage)=>device.createBuffer({size,usage});
      const frame=buffer(528,B.UNIFORM|B.COPY_DST),out=buffer(128*128*16,B.STORAGE|B.COPY_SRC),read=buffer(16*8,B.COPY_DST|B.MAP_READ);
      const trans=device.createTexture({size:[1,1],format:'rgba16float',usage:T.TEXTURE_BINDING|T.COPY_DST});device.queue.writeTexture({texture:trans},new Uint16Array([15360,15360,15360,15360]),{bytesPerRow:8},[1,1]);
      const sampler=device.createSampler({minFilter:'linear',magFilter:'linear'});
      const source=withCelestialFrame(FRAME_WGSL+ATMO_CORE_WGSL+`
@group(0)@binding(0)var<uniform>F:Frame;
@group(0)@binding(1)var transLUT:texture_2d<f32>;
@group(0)@binding(2)var sampC:sampler;
@group(0)@binding(3)var<storage,read_write>answer:array<vec4f>;
@group(0)@binding(4)var skyLUT:texture_2d<f32>;
`+SKY_RENDER_FUNCS+CELESTIAL_STAR_STUB+`
@compute @workgroup_size(8)fn main(@builtin(local_invocation_index)i:u32){
 let offsets=array<vec2f,8>(vec2f(0),vec2f(-.6,0),vec2f(.6,0),vec2f(0,-.6),vec2f(0,.6),vec2f(1.5,0),vec2f(0),vec2f(0));
 let ray=normalize(F.moonDir.xyz+F.moonRight.xyz*offsets[i].x*F.moonRight.w+F.moonUp.xyz*offsets[i].y*F.moonRight.w);
 var value=lunarDisk(ray);
 if(i==6u){value=lunarSurface(F.moonDir.xyz,F.moonDir.xyz,vec3f(.5),.8,vec3f(.04),vec3f(1));}
 if(i==7u){value=lunarIlluminance();}
 answer[i]=vec4f(value,1);
}
@compute @workgroup_size(8,8)fn integrate(@builtin(global_invocation_id)i:vec3u){
 let uv=(vec2f(i.xy)+.5)/128.0*2.0-1.0;
 let ray=normalize(F.moonDir.xyz+F.moonRight.xyz*uv.x*F.moonRight.w+F.moonUp.xyz*uv.y*F.moonRight.w);
 answer[i.y*128u+i.x]=vec4f(lunarDisk(ray),1);
}
@compute @workgroup_size(8)fn occultation(@builtin(local_invocation_index)i:u32){
 let offset=array<f32,4>(-.6,.6,-1.6,1.6)[i%4u];
 let ray=normalize(F.moonDir.xyz+F.moonRight.xyz*offset*F.moonRight.w);
 answer[i]=vec4f(celestialStarBackground(ray),1);
}`);
      const compile=async(code,label)=>{const module=device.createShaderModule({code,label});errors.push(...(await module.getCompilationInfo()).messages.filter(m=>m.type==='error').map(m=>label+': '+m.message));return module;};
      const module=await compile(source,'celestial physical light');
      await compile(withCelestialFrame(CELESTIAL_STARS),'stellar cube');await compile(withCelestialFrame(CELESTIAL_LINES),'constellation depth overlay');
      const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'main'}}),integrator=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'integrate'}}),occult=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'occultation'}}),group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:frame}},{binding:1,resource:trans.createView()},{binding:2,resource:sampler},{binding:3,resource:{buffer:out}}]});
      const integrateGroup=device.createBindGroup({layout:integrator.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:frame}},{binding:1,resource:trans.createView()},{binding:2,resource:sampler},{binding:3,resource:{buffer:out}}]});
      const cube=device.createTexture({size:[1,1,6],format:'rgba16float',usage:T.TEXTURE_BINDING|T.COPY_DST});for(let face=0;face<6;face++)device.queue.writeTexture({texture:cube,origin:[0,0,face]},new Uint16Array([15360,15360,15360,15360]),{bytesPerRow:8},[1,1]);
      const occultGroup=device.createBindGroup({layout:occult.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:frame}},{binding:2,resource:sampler},{binding:3,resource:{buffer:out}},{binding:5,resource:cube.createView({dimension:'cube'})}]});
      frameData.set([0,-1,0,14],32);frameData.set([512,512,1/512,1/512],36);frameData[73]=.01;
      frameData.set([0,.6,.8,.00003],96);frameData.set([-1,0,0,.0045],100);frameData.set([0,.8,-.6,1],104);frameData.set([0,-.6,-.8,1],108);frameData[112]=1;
      async function sample(){device.queue.writeBuffer(frame,0,frameData);const e=device.createCommandEncoder(),p=e.beginComputePass();p.setPipeline(pipeline);p.setBindGroup(0,group);p.dispatchWorkgroups(1);p.end();e.copyBufferToBuffer(out,0,read,0,128);device.queue.submit([e.finish()]);await read.mapAsync(GPUMapMode.READ);const values=Array.from(new Float32Array(read.getMappedRange()));read.unmap();return Array.from({length:8},(_,i)=>values.slice(i*4,i*4+3));}
      const full=await sample();
      const integralRead=buffer(128*128*16,B.COPY_DST|B.MAP_READ);const ie=device.createCommandEncoder(),ip=ie.beginComputePass();ip.setPipeline(integrator);ip.setBindGroup(0,integrateGroup);ip.dispatchWorkgroups(16,16);ip.end();ie.copyBufferToBuffer(out,0,integralRead,0,128*128*16);device.queue.submit([ie.finish()]);await integralRead.mapAsync(GPUMapMode.READ);const integralData=new Float32Array(integralRead.getMappedRange()),integral=[0,0,0];for(let i=0;i<128*128;i++)for(let k=0;k<3;k++)integral[k]+=integralData[i*4+k]*4/(128*128)*frameData[103]*frameData[103];integralRead.unmap();
      frameData[113]=1;frameData.set([-1,0,0,1/Math.PI],108);frameData[107]=.5;device.queue.writeBuffer(frame,0,frameData);const oe=device.createCommandEncoder(),op=oe.beginComputePass();op.setPipeline(occult);op.setBindGroup(0,occultGroup);op.dispatchWorkgroups(1);op.end();oe.copyBufferToBuffer(out,0,read,0,128);device.queue.submit([oe.finish()]);await read.mapAsync(GPUMapMode.READ);const occulted=Array.from(new Float32Array(read.getMappedRange()));read.unmap();
      frameData.set([-1,0,0,1/Math.PI],108);frameData[107]=.5;const quarterRight=await sample();
      frameData.set([0,.8,-.6,1/Math.PI],108);const quarterUp=await sample();
      frameData.set([0,.6,.8,.002],108);const fresh=await sample();
      frameData[97]=-.6;const below=await sample();frameData[99]=0;frameData[112]=0;const manual=await sample();
      device.destroy();return {errors,full,quarterRight,quarterUp,fresh,below,manual,integral,occulted};
    });
    assert.deepEqual(result.errors,[]);
    for(const [k,color]of [.98,.96,.91].entries())assert.ok(Math.abs(result.integral[k]/(.00003*color)-1)<.025,'integrated full disc matches ephemeris irradiance');
    assert.equal(result.occulted.slice(0,3).reduce((a,b)=>a+b,0),0,'dark lunar hemisphere blocks stars');assert.equal(result.occulted.slice(4,7).reduce((a,b)=>a+b,0),0,'lit lunar hemisphere blocks stars');assert.ok(result.occulted[8]+result.occulted[9]+result.occulted[10]>2.9,'stars outside lunar angular radius remain visible');
    const sum=a=>a.reduce((s,v)=>s+v,0);
    assert.ok(sum(result.full[0])>0);assert.ok(sum(result.full[1])>0&&sum(result.full[2])>0);
    assert.ok(sum(result.quarterRight[2])>sum(result.quarterRight[1])*100,'terminator points toward projected Sun');
    assert.ok(sum(result.quarterUp[4])>sum(result.quarterUp[3])*100,'limb rotates with Sun/Moon geometry');
    assert.equal(sum(result.fresh[0]),0,'new Moon has no illuminated near-side centre');
    assert.equal(sum(result.full[5]),0,'no disc outside angular extent');
    assert.ok(sum(result.full[6])>0,'moonlight reaches actual material BRDF');
    assert.equal(sum(result.below[7]),0,'below-horizon Moon cannot illuminate surfaces');
    assert.equal(sum(result.manual[6]),0);assert.equal(sum(result.manual[0]),0);
    await page.close();
  }finally{await browser?.close();server.close();}
});

test('rendered stellar cube agrees with independently rotated HYG stars instead of vertically mirroring its faces',{timeout:120000},async()=>{
  const server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');let browser;
  try{
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
    const page=await browser.newPage();await page.route('**/__stellar-direction',r=>r.fulfill({contentType:'text/html',body:'<!doctype html>'}));await page.goto('http://127.0.0.1:'+server.address().port+'/__stellar-direction');
    const result=await page.evaluate(async()=>{
      const {computeAstronomy,propagatedStars}=await import('/js/astronomy.js'),{OceanAstronomyEngine}=await import('/js/vendor/astronomy-engine.js'),{CELESTIAL_STARS,withCelestialFrame}=await import('/js/wgsl/celestial.js');
      const A=OceanAstronomyEngine,date=new Date('2026-10-21T00:00:00Z'),observer={latitude:17.635,longitude:-63.238,height:0};
      const state=computeAstronomy(date,observer),catalogue=propagatedStars(date),rotation=A.Rotation_EQJ_HOR(date,new A.Observer(observer.latitude,observer.longitude,0));
      // Expected positions use the upstream vector API and documented HOR axes,
      // independently of our Frame matrix packing and cubemap projection.
      const candidates=[32349,69673,91262,11767,24436,30438,27989,21421,97649];
      const chosen=[];
      for(const hip of candidates){const star=catalogue.find(s=>s.hip===hip);if(!star)continue;const h=A.RotateVector(rotation,new A.Vector(...star.direction,A.MakeTime(date))),world=[-h.y,h.z,-h.x];if(world[1]>.12&&Math.max(Math.abs(world[0]),Math.abs(world[2]))>.72)chosen.push({star,world});}
      if(!chosen.length)throw Error('Reference stars are unsuitable for side-face direction fixture');
      const device=await(await navigator.gpu.requestAdapter()).requestDevice(),errors=[];device.onuncapturederror=e=>errors.push(e.error.message);const B=GPUBufferUsage,T=GPUTextureUsage,size=128;
      const frameData=new Float32Array(132);frameData[113]=1;frameData[72]=3;frameData.set(state.starRotation,116);
      const frame=device.createBuffer({size:528,usage:B.UNIFORM|B.COPY_DST});device.queue.writeBuffer(frame,0,frameData);
      const module=device.createShaderModule({code:withCelestialFrame(CELESTIAL_STARS)});errors.push(...(await module.getCompilationInfo()).messages.filter(m=>m.type==='error').map(m=>m.message));
      const pipeline=await device.createRenderPipelineAsync({layout:'auto',vertex:{module,entryPoint:'vs',buffers:[{arrayStride:24,stepMode:'instance',attributes:[{shaderLocation:0,offset:0,format:'float32x3'},{shaderLocation:1,offset:12,format:'float32x3'}]}]},fragment:{module,entryPoint:'fs',targets:[{format:'rgba16float'}]},primitive:{topology:'triangle-list'}});
      const texture=device.createTexture({size:[size,size,6],format:'rgba16float',usage:T.RENDER_ATTACHMENT|T.TEXTURE_BINDING}),sampler=device.createSampler({magFilter:'linear',minFilter:'linear'});
      const vertices=device.createBuffer({size:24,usage:B.VERTEX|B.COPY_DST}),answer=device.createBuffer({size:32,usage:B.STORAGE|B.COPY_SRC}),read=device.createBuffer({size:32,usage:B.COPY_DST|B.MAP_READ});
      const faces=Array.from({length:6},(_,i)=>{const u=device.createBuffer({size:16,usage:B.UNIFORM|B.COPY_DST});device.queue.writeBuffer(u,0,new Float32Array([i,size,0,0]));return {view:texture.createView({dimension:'2d',baseArrayLayer:i,arrayLayerCount:1}),group:device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:frame}},{binding:1,resource:{buffer:u}}]})};});
      const rows=[];
      for(const {star,world}of chosen){
        device.queue.writeBuffer(vertices,0,new Float32Array([...star.direction,.01,.01,.01]));
        const target=world.map(v=>v.toFixed(12)).join(','),mirror=[world[0],-world[1],world[2]].map(v=>v.toFixed(12)).join(',');
        const sampleModule=device.createShaderModule({code:`@group(0)@binding(0)var stars:texture_cube<f32>;@group(0)@binding(1)var starSampler:sampler;@group(0)@binding(2)var<storage,read_write>out:array<vec4f>;@compute @workgroup_size(1)fn main(){out[0]=textureSampleLevel(stars,starSampler,normalize(vec3f(${target})),0);out[1]=textureSampleLevel(stars,starSampler,normalize(vec3f(${mirror})),0);}`});
        errors.push(...(await sampleModule.getCompilationInfo()).messages.filter(m=>m.type==='error').map(m=>m.message));
        const samplePipe=await device.createComputePipelineAsync({layout:'auto',compute:{module:sampleModule,entryPoint:'main'}}),group=device.createBindGroup({layout:samplePipe.getBindGroupLayout(0),entries:[{binding:0,resource:texture.createView({dimension:'cube'})},{binding:1,resource:sampler},{binding:2,resource:{buffer:answer}}]});
        const encoder=device.createCommandEncoder();for(const face of faces){const p=encoder.beginRenderPass({colorAttachments:[{view:face.view,clearValue:{r:0,g:0,b:0,a:0},loadOp:'clear',storeOp:'store'}]});p.setPipeline(pipeline);p.setBindGroup(0,face.group);p.setVertexBuffer(0,vertices);p.draw(6,1);p.end();}
        const cp=encoder.beginComputePass();cp.setPipeline(samplePipe);cp.setBindGroup(0,group);cp.dispatchWorkgroups(1);cp.end();encoder.copyBufferToBuffer(answer,0,read,0,32);device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);const values=Array.from(new Float32Array(read.getMappedRange()));read.unmap();rows.push({hip:star.hip,name:star.name,actual:values.slice(0,3),mirrored:values.slice(4,7),world});
      }
      device.destroy();return {errors,rows};
    });
    assert.deepEqual(result.errors,[]);assert.ok(result.rows.length>0);
    for(const row of result.rows){assert.ok(row.actual.reduce((s,v)=>s+v,0)>.01,'catalogue star '+row.name+' appears at documented world direction');assert.equal(row.mirrored.reduce((s,v)=>s+v,0),0,'catalogue star '+row.name+' has no mirrored face duplicate');}
    await page.close();
  }finally{await browser?.close();server.close();}
});

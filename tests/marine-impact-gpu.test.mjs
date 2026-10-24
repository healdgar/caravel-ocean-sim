// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {after,before,test} from 'node:test';
import {chromium} from 'playwright';

const port=process.env.MARINE_IMPACT_TEST_PORT||8145,origin=`http://localhost:${port}`;
let server,browser;
before(async()=>{
  server=spawn(process.execPath,['server.mjs',String(port)],{cwd:new URL('..',import.meta.url),stdio:['ignore','pipe','inherit']});
  await Promise.race([once(server.stdout,'data'),once(server,'exit').then(([code])=>{throw Error('Marine impact test server exited '+code);})]);
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,
    args:process.env.WEBGPU_BACKEND==='metal'?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
});
after(async()=>{await browser?.close();server?.kill();});

async function impactProbes(cases){
  const page=await browser.newPage();
  try{
    await page.route('**/__marine-impact',route=>route.fulfill({contentType:'text/html',body:'<!doctype html>'}));await page.goto(`${origin}/__marine-impact`);
    const result=await page.evaluate(async cases=>{
      const {MARINE_LIFE_RENDER,MARINE_IMPACT_SEGMENTS,MARINE_IMPACT_ROWS,MARINE_IMPACT_DROP_COUNT}=await import('/js/wgsl/marine-life.js');
      const device=await(await navigator.gpu.requestAdapter()).requestDevice(),errors=[];device.onuncapturederror=e=>errors.push(e.error.message);
      const B=GPUBufferUsage,data=new Float32Array(cases.flatMap(p=>[p.time,p.angle??.7,p.row??.4,p.drop?1:0,p.seed??.37,p.heading??.4,p.scale??5.2,p.strength??2.6,p.speed??3,p.key??11,p.id??0,0]));
      const input=device.createBuffer({size:data.byteLength,usage:B.STORAGE|B.COPY_DST});device.queue.writeBuffer(input,0,data);
      const bytes=cases.length*64,output=device.createBuffer({size:bytes,usage:B.STORAGE|B.COPY_SRC}),read=device.createBuffer({size:bytes,usage:B.COPY_DST|B.MAP_READ});
      // Both paths call production parcel helpers, including their analytic
      // normals and emission times, rather than a second implementation.
      const module=device.createShaderModule({code:MARINE_LIFE_RENDER+`
struct ImpactInput {event:vec4f,shape:vec4f,motion:vec4f};
struct ImpactAnswer {positionAge:vec4f,velocityOpacity:vec4f,normalRadius:vec4f,emission:vec4f};
@group(1)@binding(0)var<storage,read>impactInputs:array<ImpactInput>;
@group(1)@binding(1)var<storage,read_write>impactAnswers:array<ImpactAnswer>;
@compute @workgroup_size(32)fn impactProbe(@builtin(global_invocation_id)i:vec3u){
 if(i.x>=arrayLength(&impactInputs)){return;}let q=impactInputs[i.x];
 if(q.event.w>.5){
  let p=marineImpactDrop(q.event.x,u32(q.motion.z),q.shape.x,q.shape.y,q.shape.z,q.shape.w,q.motion.x,q.motion.y);
  impactAnswers[i.x]=ImpactAnswer(vec4f(p.offset,p.age),vec4f(p.velocity,p.opacity),vec4f(0,0,0,p.radius),vec4f(p.birth,p.life,0,0));
 }else{
  let p=marineImpactSheet(q.event.x,q.event.y,q.event.z,q.shape.x,q.shape.y,q.shape.z,q.shape.w,q.motion.x,q.motion.y);
  impactAnswers[i.x]=ImpactAnswer(vec4f(p.offset,p.age),vec4f(p.velocity,p.opacity),vec4f(p.normal,0),vec4f(p.birth,p.life,0,0));
 }
}`});
      errors.push(...(await module.getCompilationInfo()).messages.filter(m=>m.type==='error').map(m=>m.message));
      const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'impactProbe'}});
      const empty=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[]});
      const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(1),entries:[{binding:0,resource:{buffer:input}},{binding:1,resource:{buffer:output}}]});
      const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,empty);pass.setBindGroup(1,group);pass.dispatchWorkgroups(Math.ceil(cases.length/32));pass.end();
      encoder.copyBufferToBuffer(output,0,read,0,bytes);device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);
      const values=new Float32Array(read.getMappedRange()).slice();read.unmap();device.destroy();
      return {errors,segments:MARINE_IMPACT_SEGMENTS,rows:MARINE_IMPACT_ROWS,drops:MARINE_IMPACT_DROP_COUNT,values:cases.map((p,i)=>({...p,
        offset:Array.from(values.slice(i*16,i*16+3)),age:values[i*16+3],velocity:Array.from(values.slice(i*16+4,i*16+7)),opacity:values[i*16+7],
        normal:Array.from(values.slice(i*16+8,i*16+11)),radius:values[i*16+11],birth:values[i*16+12],life:values[i*16+13]}))};
    },cases);
    assert.deepEqual(result.errors,[]);return result;
  }finally{await page.close();}
}

test('marine impact water has a finite staggered birth, bounded lifetime and event-specific shape',{timeout:120000},async()=>{
  const cases=[];
  for(const drop of [false,true])for(const time of [-.1,0,.05,.3,1,4])for(const strength of [.6,2.6]){
    if(drop)for(const id of time===.05?Array.from({length:64},(_,i)=>i):[0,1,17,63])cases.push({drop,time,strength,id});
    else for(const row of [0,.4,1])cases.push({drop,time,strength,row});
  }
  cases.push({drop:false,time:.4,key:11},{drop:false,time:.4,key:12});
  const result=await impactProbes(cases);
  assert.ok(result.segments>=48&&result.segments<=96&&result.rows>=4&&result.rows<=8,'a bounded curved sheet has sufficient angular and row resolution');
  assert.ok(result.drops>24&&result.drops<=64,'impact droplets fit the existing fixed 64-record cache');
  for(const p of result.values){
    assert.ok([...p.offset,...p.velocity,...p.normal,p.age,p.opacity,p.radius,p.birth,p.life].every(Number.isFinite));
    assert.ok(p.birth>=0&&p.birth<=.180001&&p.life>.2&&p.life<3,'finite emission and flight duration');
    assert.ok(Math.abs(p.time-p.age-p.birth)<2e-6,'parcel age corresponds to its actual birth');
    assert.ok(p.opacity>=0&&p.opacity<=1);
    if(p.age<=0||p.age>=p.life)assert.equal(p.opacity,0,'unborn or returned water is invisible');
  }
  for(const drop of [false,true]){
    const early=result.values.filter(p=>p.drop===drop&&p.time===.05);
    assert.ok(early.some(p=>p.opacity>0)&&early.some(p=>p.opacity===0),'a short burst does not emit every parcel at once');
  }
  assert.ok(result.values.at(-1).offset.some((v,k)=>Math.abs(v-result.values.at(-2).offset[k])>.001),'same-age neighboring impact events have distinct stable phases');
});

test('every detached impact row and droplet has Earth gravity and velocity matching its rendered trajectory',{timeout:120000},async()=>{
  const cases=[],h=.002;
  for(const drop of [false,true])for(const time of [.6,1])for(const selector of [0,.4,1])for(const offset of [-h,0,h]){
    cases.push({drop,time:time+offset,row:selector,id:Math.round(selector*63)});
  }
  const {values}=await impactProbes(cases);
  for(let i=0;i<values.length;i+=3){
    const [before,at,after]=values.slice(i,i+3);
    for(let axis=0;axis<3;axis++){
      const velocity=(after.offset[axis]-before.offset[axis])/(2*h),acceleration=(after.velocity[axis]-before.velocity[axis])/(2*h);
      assert.ok(Math.abs(velocity-at.velocity[axis])<.002,'GPU parcel velocity differentiates its actual world trajectory');
      assert.ok(Math.abs(acceleration-(axis===1?-9.81:0))<.005,'full gravity applies to every detached row, with no continuing wave tether');
    }
  }
});

test('marine impact sheet normals are smooth across the closed seam and perpendicular to both actual surface tangents',{timeout:120000},async()=>{
  const cases=[],h=.001;
  for(const time of [.4,1])for(const row of [.2,.5,.9])cases.push({time,row,angle:0},{time,row,angle:2*Math.PI});
  for(const time of [.4,1])for(const angle of [0,.7,2.4])for(const row of [.2,.5,.9]){
    cases.push({time,angle,row},{time,angle:angle-h,row},{time,angle:angle+h,row},{time,angle,row:row-h},{time,angle,row:row+h});
  }
  const {values}=await impactProbes(cases);
  for(let i=0;i<12;i+=2){
    const [a,b]=values.slice(i,i+2);
    for(const key of ['offset','normal','velocity'])assert.ok(a[key].every((v,k)=>Math.abs(v-b[key][k])<2e-5),`${key} closes continuously at the angular seam`);
  }
  for(let i=12;i<values.length;i+=5){
    const [at,left,right,inner,outer]=values.slice(i,i+5);
    assert.ok(Math.abs(Math.hypot(...at.normal)-1)<1e-4,'analytic sheet normal is unit length');
    for(const [a,b] of [[left,right],[inner,outer]]){
      const tangent=a.offset.map((v,k)=>b.offset[k]-v),length=Math.hypot(...tangent);
      assert.ok(length>1e-6,'sampled surface tangent is nondegenerate');
      assert.ok(Math.abs(tangent.reduce((sum,v,k)=>sum+v*at.normal[k],0))/length<.002,'analytic normal follows the smooth curved sheet instead of triangle facets');
    }
  }
});

test('marine impacts freeze detached births, absorb both sheet and drops permanently, and reset recycled slots',{timeout:120000},async()=>{
  const page=await browser.newPage();
  try{
    await page.route('**/__marine-impact-contact',route=>route.fulfill({contentType:'text/html',body:'<!doctype html>'}));await page.goto(`${origin}/__marine-impact-contact`);
    const result=await page.evaluate(async()=>{
      const {MARINE_EFFECT_INIT,MARINE_LIFE_RENDER,MARINE_IMPACT_SEGMENTS,MARINE_IMPACT_ROWS,MARINE_IMPACT_DROP_COUNT}=await import('/js/wgsl/marine-life.js'),{CASCADES}=await import('/js/wgsl/common.js');
      const device=await(await navigator.gpu.requestAdapter()).requestDevice(),errors=[];device.onuncapturederror=e=>errors.push(e.error.message);
      const B=GPUBufferUsage,T=GPUTextureUsage,make=(data,usage)=>{const b=device.createBuffer({size:data.byteLength,usage:usage|B.COPY_DST});device.queue.writeBuffer(b,0,data);return b;};
      const f=new Float32Array(96);f.set([1/1103,1/211,1/39,1/7,1/1.393,1/.2617],48);
      const frame=make(f,B.UNIFORM),eventData=new Float32Array([0,0,.45,2.6,.4,.37,2,5.2,3,0,0,11]);
      const events=make(eventData,B.STORAGE),births=make(new Float32Array(48*(1+MARINE_IMPACT_DROP_COUNT)*4),B.STORAGE),contacts=make(new Float32Array(48*64*4),B.STORAGE);
      const sheetContacts=make(new Float32Array(48*MARINE_IMPACT_SEGMENTS*(MARINE_IMPACT_ROWS+1)*4),B.STORAGE);
      const sea=device.createTexture({size:[1,1,CASCADES],format:'rgba16float',usage:T.TEXTURE_BINDING|T.COPY_DST});
      for(let c=0;c<CASCADES;c++)device.queue.writeTexture({texture:sea,origin:[0,0,c]},new Uint16Array(4),{bytesPerRow:8},[1,1]);
      const sampler=device.createSampler({minFilter:'linear',magFilter:'linear',addressModeU:'repeat',addressModeV:'repeat'});
      const water=half=>device.queue.writeTexture({texture:sea,origin:[0,0,CASCADES-1]},new Uint16Array([0,half,0,0]),{bytesPerRow:8},[1,1]);
      const pipeline=async(code,entryPoint)=>{const module=device.createShaderModule({code});errors.push(...(await module.getCompilationInfo()).messages.filter(m=>m.type==='error').map(m=>m.message));return device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint}});};
      const init=await pipeline(MARINE_EFFECT_INIT,'marineBirthCS'),sheetInit=await pipeline(MARINE_EFFECT_INIT,'marineImpactContactCS');
      const answer=make(new Float32Array(44),B.STORAGE|B.COPY_SRC),read=device.createBuffer({size:176,usage:B.COPY_DST|B.MAP_READ});
      const probe=await pipeline(MARINE_LIFE_RENDER+`
@group(1)@binding(0)var<storage,read_write>impactContactAnswers:array<vec4f>;
@compute @workgroup_size(1)fn impactContactProbe(){
 let s=splashes[0];let slot=u32(s.motion.w)%48u;
 let p=marineImpactDrop(s.root.z,0u,s.shape.y,s.shape.x,s.shape.w,s.root.w,s.motion.x,s.motion.w);
 let column=7u;let row=3u;
 let sheet=marineImpactSheet(s.root.z,f32(column)*(2.0*PI)/${MARINE_IMPACT_SEGMENTS}.0,f32(row)/${MARINE_IMPACT_ROWS}.0,s.shape.y,s.shape.x,s.shape.w,s.root.w,s.motion.x,s.motion.w);
 let sheetHit=marineSheetLandings[marineSheetContactIndex(s.motion.w,column,row)];
 let world=marineImpactDropWorld(s,0u,p.offset);let hit=marineLandings[slot*64u];
 let sheetWorld=marineImpactSheetWorld(s,sheet.offset,sheetHit);
 impactContactAnswers[0]=marineOrigins[slot];impactContactAnswers[1]=vec4f(world,p.age);
 impactContactAnswers[2]=hit;impactContactAnswers[3]=vec4f(sheetWorld,sheet.age);
 impactContactAnswers[4]=vec4f(sheet.normal,0);impactContactAnswers[5]=vec4f(marineImpactOpacity(p,hit,s.motion.w),dolphinHeight(world.xz),p.opacity,p.velocity.y);
 impactContactAnswers[6]=vec4f(p.offset,p.birth);impactContactAnswers[7]=vec4f(dolphinHeight(hit.zw),s.root.z-hit.y,0,0);
 impactContactAnswers[8]=sheetHit;
 impactContactAnswers[9]=vec4f(marineSheetOpacity(sheet,sheetHit,s.motion.w),sheet.opacity,dolphinHeight(sheetWorld.xz),0);
 impactContactAnswers[10]=vec4f(f32(marineSheetContactIndex(s.motion.w,0u,row)),f32(marineSheetContactIndex(s.motion.w,${MARINE_IMPACT_SEGMENTS}u,row)),0,0);
}`,'impactContactProbe');
      const resources=[{binding:0,resource:{buffer:frame}},{binding:6,resource:sea.createView({dimension:'2d-array'})},{binding:7,resource:sampler},{binding:9,resource:{buffer:events}},{binding:10,resource:{buffer:births}},{binding:11,resource:{buffer:contacts}}];
      const sheetResource={binding:16,resource:{buffer:sheetContacts}};
      const initGroup=device.createBindGroup({layout:init.getBindGroupLayout(0),entries:resources});
      const sheetGroup=device.createBindGroup({layout:sheetInit.getBindGroupLayout(0),entries:[...resources.filter(r=>r.binding!==11),sheetResource]});
      const probeGroup=device.createBindGroup({layout:probe.getBindGroupLayout(0),entries:[...resources,sheetResource]});
      const outputGroup=device.createBindGroup({layout:probe.getBindGroupLayout(1),entries:[{binding:0,resource:{buffer:answer}}]});
      async function sample(){
        device.queue.writeBuffer(events,0,eventData);const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();
        pass.setPipeline(init);pass.setBindGroup(0,initGroup);pass.dispatchWorkgroups(1);
        pass.setPipeline(sheetInit);pass.setBindGroup(0,sheetGroup);pass.dispatchWorkgroups(1);
        pass.setPipeline(probe);pass.setBindGroup(0,probeGroup);pass.setBindGroup(1,outputGroup);pass.dispatchWorkgroups(1);pass.end();
        encoder.copyBufferToBuffer(answer,0,read,0,176);device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);
        const data=Array.from(new Float32Array(read.getMappedRange()));read.unmap();return data;
      }
      const initial=await sample();water(0x4c00);const overtaken=await sample(); // finest cascade alone rises sixteen metres
      water(0);const lowered=await sample();eventData[2]=1.1;const later=await sample();
      water(0x4400);eventData[2]=.45;eventData[6]=1;eventData[11]=59;const recycled=await sample(); // same slot, new emergence key, four-metre birth
      water(0x4c00);const recycledHit=await sample();water(0);const recycledLowered=await sample();
      device.destroy();return {errors,initial,overtaken,lowered,later,recycled,recycledHit,recycledLowered};
    });
    assert.deepEqual(result.errors,[]);
    const {initial,overtaken,lowered,later,recycled,recycledHit,recycledLowered}=result;
    assert.equal(initial[0],11);assert.equal(initial[1],0);assert.equal(initial[8],11);assert.equal(initial[9],-1);
    assert.ok(initial[20]>0&&initial[23]>0,'the fixture catches a visible, rising impact droplet');
    assert.equal(initial[32],11);assert.equal(initial[33],-1);assert.ok(initial[36]>0,'the emitted sheet vertex starts clear of water');
    for(const data of [initial,overtaken,lowered,later,recycled,recycledHit,recycledLowered])assert.equal(data[40],data[41],'the final seam column shares the first column contact record');
    for(const data of [overtaken,lowered]){
      assert.deepEqual(data.slice(0,4),initial.slice(0,4),'a later finest-scale wave cannot resample the launch origin');
      assert.deepEqual(data.slice(4,8),initial.slice(4,8),'detached droplet world position stays fixed at equal age');
      assert.deepEqual(data.slice(12,19),initial.slice(12,19),'detached sheet position and smooth normal do not ride later waves');
    }
    assert.equal(overtaken[21],16,'first contact includes the actual finest wave cascade');
    assert.equal(overtaken[8],11);assert.ok(overtaken[9]>=0&&overtaken[9]<=.451,'even a rising parcel is absorbed when overtaken by water');
    assert.equal(overtaken[20],0);
    assert.equal(overtaken[32],11);assert.ok(overtaken[33]>=0&&overtaken[33]<=.451);assert.equal(overtaken[36],0,'the actual contact compute absorbs overtaken sheet water');
    assert.equal(overtaken[38],16,'sheet contact includes the finest-scale moving water too');
    for(const data of [lowered,later]){
      assert.deepEqual(data.slice(8,12),overtaken.slice(8,12),'first contact time and impact footprint persist');
      assert.equal(data[20],0,'falling water cannot resurrect landed impact drops');
      assert.deepEqual(data.slice(32,36),overtaken.slice(32,36),'the sheet first-contact record remains latched');
      assert.equal(data[36],0,'falling water cannot resurrect absorbed sheet vertices');
    }
    assert.ok(lowered[5]>lowered[21]&&lowered[22]>0,'the no-resurrection assertion is not satisfied merely by underwater clipping or normal expiry');
    assert.equal(later[28],0);assert.ok(later[29]>0,'the contact record supplies a positive fallout age on the current surface');
    assert.ok(lowered[13]>lowered[38]&&lowered[37]>0,'the sheet no-resurrection check cannot pass by ordinary clipping or expiry');
    assert.equal(recycled[0],59);assert.equal(recycled[1],4);assert.equal(recycled[8],59);assert.equal(recycled[9],-1,'slot reuse clears the preceding event landing');
    assert.ok(recycled[20]>0&&Math.abs(recycled[5]-recycled[25]-4)<1e-5,'the replacement parcel starts above its newly sampled water');
    assert.equal(recycled[32],59);assert.equal(recycled[33],-1);assert.ok(recycled[36]>0,'a recycled key releases only the new sheet, not the absorbed old event');
    assert.equal(recycledHit[8],59);assert.ok(recycledHit[9]>=0);assert.equal(recycledHit[20],0);
    assert.deepEqual(recycledLowered.slice(8,12),recycledHit.slice(8,12));assert.equal(recycledLowered[20],0);
    assert.equal(recycledHit[32],59);assert.ok(recycledHit[33]>=0);assert.equal(recycledHit[36],0);
    assert.deepEqual(recycledLowered.slice(32,36),recycledHit.slice(32,36));assert.equal(recycledLowered[36],0);
  }finally{await page.close();}
});

test('offset impact sheet vertices and droplets sample their own local launch-footprint sea height on a sloped wave',{timeout:120000},async()=>{
  const page=await browser.newPage();
  try{
    await page.route('**/__marine-impact-slope',route=>route.fulfill({contentType:'text/html',body:'<!doctype html>'}));await page.goto(`${origin}/__marine-impact-slope`);
    const result=await page.evaluate(async()=>{
      const {MARINE_EFFECT_INIT,MARINE_LIFE_RENDER,MARINE_IMPACT_SEGMENTS,MARINE_IMPACT_ROWS,MARINE_IMPACT_DROP_COUNT}=await import('/js/wgsl/marine-life.js'),{CASCADES}=await import('/js/wgsl/common.js');
      const device=await(await navigator.gpu.requestAdapter()).requestDevice(),errors=[];device.onuncapturederror=e=>errors.push(e.error.message);
      const B=GPUBufferUsage,T=GPUTextureUsage,make=(data,usage)=>{const b=device.createBuffer({size:data.byteLength,usage:usage|B.COPY_DST});device.queue.writeBuffer(b,0,data);return b;};
      const f=new Float32Array(96);f[48]=.125;for(let i=1;i<CASCADES;i++)f[48+i]=0;
      const frame=make(f,B.UNIFORM),eventData=new Float32Array([.5,.5,.19,2.6,0,.37,2,5.2,0,0,0,17]);
      const events=make(eventData,B.STORAGE),births=make(new Float32Array(48*(1+MARINE_IMPACT_DROP_COUNT)*4),B.STORAGE),contacts=make(new Float32Array(48*64*4),B.STORAGE);
      const sheetContacts=make(new Float32Array(48*MARINE_IMPACT_SEGMENTS*(MARINE_IMPACT_ROWS+1)*4),B.STORAGE);
      const sea=device.createTexture({size:[8,8,CASCADES],format:'rgba16float',usage:T.TEXTURE_BINDING|T.COPY_DST});
      const sampler=device.createSampler({minFilter:'linear',magFilter:'linear',addressModeU:'repeat',addressModeV:'repeat'});
      const half=n=>{if(n===0)return 0;const sign=n<0?0x8000:0,a=Math.abs(n),e=Math.floor(Math.log2(a));return sign|((e+15)<<10)|Math.round((a/2**e-1)*1024);};
      // Center texel (0,0) near root (.5,.5) is a -1.5m trough; surrounding texels are +1.0m crest.
      const writeSlopedSea=crest=>{
        const values=new Uint16Array(8*8*4);
        for(let y=0;y<8;y++)for(let x=0;x<8;x++){
          const h=(x===0&&y===0)?-1.5:crest;
          values[(y*8+x)*4+1]=half(h);
        }
        device.queue.writeTexture({texture:sea,origin:[0,0,0]},values,{bytesPerRow:64},[8,8]);
      };
      writeSlopedSea(1.0);
      const pipeline=async(code,entryPoint)=>{const module=device.createShaderModule({code});errors.push(...(await module.getCompilationInfo()).messages.filter(m=>m.type==='error').map(m=>m.message));return device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint}});};
      const init=await pipeline(MARINE_EFFECT_INIT,'marineBirthCS'),sheetInit=await pipeline(MARINE_EFFECT_INIT,'marineImpactContactCS');
      const answer=make(new Float32Array(24),B.STORAGE|B.COPY_SRC),read=device.createBuffer({size:96,usage:B.COPY_DST|B.MAP_READ});
      const probe=await pipeline(MARINE_LIFE_RENDER+`
@group(1)@binding(0)var<storage,read_write>slopeAnswers:array<vec4f>;
@compute @workgroup_size(1)fn slopeProbe(){
 let s=splashes[0];let slot=u32(s.motion.w)%48u;
 let dropId=0u;
 let p=marineImpactDrop(s.root.z,dropId,s.shape.y,s.shape.x,s.shape.w,s.root.w,s.motion.x,s.motion.w);
 let dropWorld=marineImpactDropWorld(s,dropId,p.offset);
 let dropHit=marineLandings[slot*64u+dropId];
 let column=0u;let row=6u;
 let sheet=marineImpactSheet(s.root.z,0.0,1.0,s.shape.y,s.shape.x,s.shape.w,s.root.w,s.motion.x,s.motion.w);
 let sheetHit=marineSheetLandings[marineSheetContactIndex(s.motion.w,column,row)];
 let sheetWorld=marineImpactSheetWorld(s,sheet.offset,sheetHit);
 slopeAnswers[0]=vec4f(marineOrigins[slot].y,marineImpactDropBirthSea(s,dropId),marineImpactSheetBirthSea(s,sheetHit),0);
 slopeAnswers[1]=vec4f(dropWorld.y,dolphinHeight(dropWorld.xz),marineImpactOpacity(p,dropHit,s.motion.w),dropHit.y);
 slopeAnswers[2]=vec4f(sheetWorld.y,dolphinHeight(sheetWorld.xz),marineSheetOpacity(sheet,sheetHit,s.motion.w),sheetHit.y);
}`,'slopeProbe');
      const resources=[{binding:0,resource:{buffer:frame}},{binding:6,resource:sea.createView({dimension:'2d-array'})},{binding:7,resource:sampler},{binding:9,resource:{buffer:events}},{binding:10,resource:{buffer:births}},{binding:11,resource:{buffer:contacts}}];
      const sheetResource={binding:16,resource:{buffer:sheetContacts}};
      const initGroup=device.createBindGroup({layout:init.getBindGroupLayout(0),entries:resources});
      const sheetGroup=device.createBindGroup({layout:sheetInit.getBindGroupLayout(0),entries:[...resources.filter(r=>r.binding!==11),sheetResource]});
      const probeGroup=device.createBindGroup({layout:probe.getBindGroupLayout(0),entries:[...resources,sheetResource]});
      const outputGroup=device.createBindGroup({layout:probe.getBindGroupLayout(1),entries:[{binding:0,resource:{buffer:answer}}]});
      async function sample(){
        device.queue.writeBuffer(events,0,eventData);const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();
        pass.setPipeline(init);pass.setBindGroup(0,initGroup);pass.dispatchWorkgroups(1);
        pass.setPipeline(sheetInit);pass.setBindGroup(0,sheetGroup);pass.dispatchWorkgroups(1);
        pass.setPipeline(probe);pass.setBindGroup(0,probeGroup);pass.setBindGroup(1,outputGroup);pass.dispatchWorkgroups(1);pass.end();
        encoder.copyBufferToBuffer(answer,0,read,0,96);device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);
        const data=Array.from(new Float32Array(read.getMappedRange()));read.unmap();return data;
      }
      const launch=await sample();
      writeSlopedSea(8.0);
      const overtaken=await sample();
      device.destroy();return {errors,launch,overtaken};
    });
    assert.deepEqual(result.errors,[]);
    const {launch,overtaken}=result;
    // Root sea is in the -1.5m trough, while offset droplet and sheet footprints sample higher sloped water.
    assert.equal(launch[0],-1.5,'root origin records the trough at s.root.xy');
    assert.ok(launch[1]>launch[0]+1.0,'droplet launch sea samples its own offset footprint above the root trough');
    assert.ok(launch[2]>launch[0]+1.2,'sheet vertex launch sea samples its own offset footprint above the root trough');
    assert.ok(launch[4]>launch[5]&&launch[6]>0&&launch[7]===-1,'offset droplet launches clear of local sloped water instead of immediate absorption');
    assert.ok(launch[8]>launch[9]&&launch[10]>0&&launch[11]===-1,'offset sheet vertex launches clear of local sloped water instead of immediate absorption');
    assert.equal(overtaken[6],0,'rising sloped wave still absorbs the droplet');
    assert.equal(overtaken[10],0,'rising sloped wave still absorbs the sheet vertex');
  }finally{await page.close();}
});

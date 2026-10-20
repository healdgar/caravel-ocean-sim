// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {after,before,test} from 'node:test';
import {chromium} from 'playwright';

const port=process.env.WHALE_SPRAY_TEST_PORT||8112,origin=`http://localhost:${port}`;
let server,browser;
before(async()=>{
  server=spawn(process.execPath,['server.mjs',String(port)],{cwd:new URL('..',import.meta.url),stdio:['ignore','pipe','inherit']});
  await Promise.race([once(server.stdout,'data'),once(server,'exit').then(([code])=>{throw Error('Whale spray test server exited '+code);})]);
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,
    args:process.env.WEBGPU_BACKEND==='metal'?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
});
after(async()=>{await browser?.close();server?.kill();});

async function breathProbes(cases){
  const page=await browser.newPage();
  try{
    await page.route('**/__whale-spray',route=>route.fulfill({contentType:'text/html',body:'<!doctype html>'}));
    await page.goto(`${origin}/__whale-spray`);
    const result=await page.evaluate(async cases=>{
      const {MARINE_BREATH_DYNAMICS}=await import('/js/wgsl/marine-life.js');
      if(typeof MARINE_BREATH_DYNAMICS!=='string')throw Error('Missing production whale breath dynamics');
      const adapter=await navigator.gpu.requestAdapter();if(!adapter)throw Error('No WebGPU adapter');
      const device=await adapter.requestDevice(),errors=[];device.onuncapturederror=e=>errors.push(e.error.message);
      const B=GPUBufferUsage,data=new Float32Array(cases.flatMap(p=>[p.time,p.id??0,p.seed??.37,p.heading??0,...(p.wind??[0,0]),p.scale??1,p.coarse===false?0:1]));
      const input=device.createBuffer({size:data.byteLength,usage:B.STORAGE|B.COPY_DST});device.queue.writeBuffer(input,0,data);
      const bytes=cases.length*48,output=device.createBuffer({size:bytes,usage:B.STORAGE|B.COPY_SRC});
      const read=device.createBuffer({size:bytes,usage:B.COPY_DST|B.MAP_READ});
      // Probe the production analytic trajectories on the native GPU. The
      // assertions below concern motion and emission, not a copied CPU formula.
      const code=MARINE_BREATH_DYNAMICS+`
struct BreathProbe {event:vec4f,air:vec4f};
struct BreathAnswer {positionAge:vec4f,velocityRadius:vec4f,lifeOpacity:vec4f};
@group(0)@binding(0)var<storage,read>input:array<BreathProbe>;
@group(0)@binding(1)var<storage,read_write>output:array<BreathAnswer>;
@compute @workgroup_size(32)fn main(@builtin(global_invocation_id)i:vec3u){
 if(i.x>=arrayLength(&input)){return;}let p=input[i.x];
 let b=marineBreathParticle(p.event.x,u32(p.event.y),p.event.z,p.air.xy,p.event.w,p.air.z,p.air.w>.5);
 output[i.x].positionAge=vec4f(b.offset,b.age);
 output[i.x].velocityRadius=vec4f(b.velocity,b.radius);
 output[i.x].lifeOpacity=vec4f(b.life,b.opacity,0,0);
}`;
      const module=device.createShaderModule({code}),info=await module.getCompilationInfo();errors.push(...info.messages.filter(m=>m.type==='error').map(m=>m.message));
      const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'main'}});
      const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:input}},{binding:1,resource:{buffer:output}}]});
      const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(cases.length/32));pass.end();
      encoder.copyBufferToBuffer(output,0,read,0,bytes);device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);
      const values=new Float32Array(read.getMappedRange()).slice();read.unmap();device.destroy();
      return {errors,values:cases.map((p,i)=>({...p,offset:Array.from(values.slice(i*12,i*12+3)),age:values[i*12+3],velocity:Array.from(values.slice(i*12+4,i*12+7)),radius:values[i*12+7],life:values[i*12+8],opacity:values[i*12+9]}))};
    },cases);
    assert.deepEqual(result.errors,[]);return result.values;
  }finally{await page.close();}
}

test('whale exhalations emit a finite burst, fade completely and remain numerically bounded',{timeout:120000},async()=>{
  const cases=[];
  for(const coarse of [true,false])for(const id of [0,1,7,95])for(const time of [-.1,0,.05,.2,.5,1,2,4,8])cases.push({coarse,id,time,wind:[12,-4]});
  const result=await breathProbes(cases);
  for(const p of result){
    assert.ok([...p.offset,...p.velocity,p.age,p.radius,p.life,p.opacity].every(Number.isFinite),'finite breath state: '+JSON.stringify(p));
    assert.ok(p.life>0&&p.life<6&&p.radius>0&&p.radius<5,'bounded exhalation lifetime and scale: '+JSON.stringify(p));
    assert.ok(p.opacity>=0&&p.opacity<=1,'opacity is a coverage fraction');
    if(p.time<0||p.time>=8||p.age<0||p.age>=p.life)assert.equal(p.opacity,0,'un-emitted and expired droplets cannot form a persistent hose');
  }
  for(const coarse of [true,false]){
    const visible=result.filter(p=>p.coarse===coarse&&p.opacity>0);
    assert.ok(visible.length>3,'the test must observe the real exhalation');
    assert.ok(visible.every(p=>p.time-p.age>=-.00001&&p.time-p.age<=.451),'all particles belong to the same short exhalation');
    const early=result.filter(p=>p.coarse===coarse&&p.time===.05);
    assert.ok(early.some(p=>p.age<0&&p.opacity===0),'staggered emission has not released every particle immediately');
  }
});

test('coarse whale droplets decelerate under gravity, turn over and return rather than rising indefinitely',{timeout:120000},async()=>{
  const cases=[];
  for(let step=0;step<=60;step++)cases.push({time:step*.05});
  const result=await breathProbes(cases),active=result.filter(p=>p.age>.02&&p.age<p.life);
  const rising=active.find(p=>p.velocity[1]>.5),falling=active.find(p=>p.velocity[1]<-.5);
  assert.ok(rising&&falling,'a real water droplet must rise and fall during its lifetime');
  const apex=active.reduce((a,b)=>Math.abs(a.velocity[1])<Math.abs(b.velocity[1])?a:b);
  const index=result.indexOf(apex),before=result[index-1],after=result[index+1];
  assert.ok(before&&after,'the sampled apex needs adjacent trajectory points');
  const acceleration=(after.velocity[1]-before.velocity[1])/(after.time-before.time);
  assert.ok(acceleration< -7&&acceleration> -13,`vertical acceleration near the apex should be Earth gravity, measured ${acceleration} m/s²`);
  const highest=Math.max(...active.map(p=>p.offset[1]));
  assert.ok(highest>.5&&highest<8,'coarse water reaches a bounded spray height');
  assert.ok(active.some(p=>p.time>apex.time&&p.offset[1]<highest-.5),'water descends visibly after its apex');
  for(let i=1;i<result.length-1;i++){
    const p=result[i];if(p.age<.05||p.age>p.life-.05)continue;
    const velocity=(result[i+1].offset[1]-result[i-1].offset[1])/.1;
    assert.ok(Math.abs(velocity-p.velocity[1])<.15,'returned velocity must match the rendered trajectory');
  }
});

test('whale mist entrains into wind while coarse drops retain more momentum and inherit source travel',{timeout:120000},async()=>{
  const cases=[];
  for(const coarse of [true,false])for(const time of [.6,1,1.4])for(const wind of [[0,0],[10,0],[-10,0],[0,10]])cases.push({coarse,time,wind});
  for(const heading of [0,Math.PI/2,Math.PI])for(let id=0;id<96;id++)cases.push({time:.6,heading,wind:[0,0],id,seed:.19});
  const result=await breathProbes(cases);
  const find=(coarse,time,x,z)=>result.find(p=>p.coarse===coarse&&p.time===time&&p.wind[0]===x&&p.wind[1]===z);
  for(const coarse of [true,false]){
    let previous=0;
    for(const time of [.6,1,1.4]){
      const calm=find(coarse,time,0,0),east=find(coarse,time,10,0),west=find(coarse,time,-10,0),north=find(coarse,time,0,10);
      const drift=east.offset[0]-calm.offset[0];
      assert.ok(drift>previous,'wind displacement accumulates with age');previous=drift;
      assert.ok(west.offset[0]<calm.offset[0]&&north.offset[2]>calm.offset[2],'the wind vector determines drift direction');
      assert.ok(Math.abs(drift+(west.offset[0]-calm.offset[0]))<1e-4,'reversing wind reverses its displacement');
      assert.ok(east.velocity[0]>calm.velocity[0],'the wind accelerates particles toward the moving air');
    }
  }
  const fineDrift=find(false,1.4,10,0).offset[0]-find(false,1.4,0,0).offset[0];
  const coarseDrift=find(true,1.4,10,0).offset[0]-find(true,1.4,0,0).offset[0];
  assert.ok(fineDrift>coarseDrift*1.5,'fine mist entrains faster than massive water drops');
  const mean=heading=>{
    const particles=result.filter(p=>p.heading===heading),sum=field=>[0,1,2].map(i=>particles.reduce((a,p)=>a+p[field][i],0)/particles.length);
    return {offset:sum('offset'),velocity:sum('velocity')};
  };
  const forward=mean(0),sideways=mean(Math.PI/2),backward=mean(Math.PI);
  assert.ok(forward.velocity[2]<-1&&forward.offset[2]<-.3,'the exhalation retains forward momentum from the moving whale');
  assert.ok(Math.abs(forward.velocity[0])<-forward.velocity[2]*.5,'source motion dominates mean sideways jet spread');
  assert.ok(Math.abs(sideways.offset[0]+forward.offset[2])<1e-4&&Math.abs(sideways.offset[2]-forward.offset[0])<1e-4,'source momentum rotates with whale heading');
  assert.ok(Math.abs(backward.offset[0]+forward.offset[0])<1e-4&&Math.abs(backward.offset[2]+forward.offset[2])<1e-4,'opposite headings reverse inherited horizontal travel');
});

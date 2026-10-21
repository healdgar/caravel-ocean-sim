// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {test} from 'node:test';
import {chromium} from 'playwright';
import {createVictoryMesh} from '../js/victory.js';
import {createGunDefinitions} from '../js/gunnery-models.js';

test('Victory weather-deck guns retain iron annular muzzles, open centres and unit mesh normals',()=>{
  const parts=new Map();createVictoryMesh({parts});
  const guns=createGunDefinitions('victory').filter(g=>g.weatherDeck);assert.ok(guns.length>0);
  for(const gun of guns){
    const mesh=parts.get(gun.meshGroup);assert.ok(mesh,gun.meshGroup);
    const [x,y,z]=gun.muzzleDesign;let rimTriangles=0;
    for(let i=0;i<mesh.length;i+=27){
      if(Math.floor(mesh[i+6])!==3)continue;
      const vertices=[0,9,18].map(k=>Array.from(mesh.subarray(i+k,i+k+9)));
      for(const v of vertices)assert.ok(Math.abs(Math.hypot(...v.slice(3,6))-1)<2e-6,'finite unit metal normals');
      if(!vertices.every(v=>Math.abs(v[0]-x)<2e-6))continue;
      rimTriangles++;
      const a=vertices.map(v=>[v[1]-y,v[2]-z]);
      const cross=(u,v)=>u[0]*v[1]-u[1]*v[0];
      const signs=[cross(a[0],a[1]),cross(a[1],a[2]),cross(a[2],a[0])];
      assert.ok(!signs.every(v=>v>=-1e-10)&&!signs.every(v=>v<=1e-10),'no iron cap crosses the bore axis');
      assert.ok(vertices.every(v=>Math.abs(v[3])>.999),'annular lip has an axial face normal');
    }
    assert.equal(rimTriangles,24,gun.meshGroup);
  }
});

test('native iron finish separates oxide/conductor reflectance, filters unresolved relief and adds a bounded water-film lobe',{timeout:120000},async()=>{
  const port=process.env.METAL_MATERIAL_TEST_PORT||8158;
  const server=spawn(process.execPath,['server.mjs',String(port)],{cwd:new URL('..',import.meta.url),stdio:['ignore','pipe','inherit']});let browser;
  try{
    await Promise.race([once(server.stdout,'data'),once(server,'exit').then(([code])=>{throw Error('Metal fixture server exited '+code);})]);
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'
      ?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']
      :['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
    const page=await browser.newPage();await page.route('**/__metal-material',route=>route.fulfill({contentType:'text/html',body:'<!doctype html>'}));
    await page.goto(`http://localhost:${port}/__metal-material`);
    const result=await page.evaluate(async()=>{
      const {IRON_SURFACE,CARAVEL}=await import('/js/wgsl/caravel.js');
      const {NOISE_WGSL}=await import('/js/wgsl/common.js');
      const {VESSEL_LIGHTING}=await import('/js/wgsl/vessel.js');
      const {WET_MATERIAL}=await import('/js/wgsl/wetness.js');
      const adapter=await navigator.gpu.requestAdapter();if(!adapter)throw Error('No WebGPU adapter');
      const device=await adapter.requestDevice(),errors=[];device.onuncapturederror=e=>errors.push(e.error.message);
      const production=device.createShaderModule({code:CARAVEL,label:'production iron fragment validation'});
      errors.push(...(await production.getCompilationInfo()).messages.filter(e=>e.type==='error').map(e=>e.message));
      const points=[[0,0,0],[.017,.029,.043],[.13,.24,.37],[1.71,2.93,3.17]],inputs=[];
      for(const p of points)for(const footprint of [.0005,.15])for(const film of [0,.5,1])for(const cosine of [1,.15])inputs.push([...p,footprint,film,cosine,cosine,0]);
      const source=new Float32Array(inputs.flat()),code='const PI=3.141592653589793;'+NOISE_WGSL+VESSEL_LIGHTING+IRON_SURFACE+WET_MATERIAL+`
@group(0)@binding(0)var<storage,read>samples:array<vec4f>;
@group(0)@binding(1)var<storage,read_write>values:array<vec4f>;
@compute @workgroup_size(32)fn materialProbe(@builtin(global_invocation_id)i:vec3u){
 let index=i.x;if(index*2u>=arrayLength(&samples)){return;}
 let a=samples[index*2u];let b=samples[index*2u+1u];let s=vesselIronSurface(a.xyz,a.w,b.x);
 let n=vec3f(0,1,0);let v=n;let l=n;
 let base=s.albedo*(1.0-s.bare)*0.96/PI+vesselSpecular(n,v,l,s.rough,s.f0);
 let coat=vesselSpecular(n,v,l,s.filmRough,vec3f(vesselIronWaterF0));
 let peak=base*vesselIronTransmission(s.film,1.0,1.0)+s.film*coat;
 values[index*7u]=vec4f(s.albedo,s.bare);
 values[index*7u+1u]=vec4f(s.f0,s.rough);
 values[index*7u+2u]=vec4f(s.relief,s.film,s.filmRough,vesselIronTransmission(s.film,b.y,b.z));
 values[index*7u+3u]=vec4f(peak,vesselFresnel(vec3f(vesselIronWaterF0),b.y).x);
 let hit=moistureStep(vec2f(0.8,0),1.0,0.0,4u,12.0,1.0/60.0);
 let mist=moistureStep(vec2f(0),0.0,0.5,4u,12.0,1.0/60.0);
 let rain=moistureStep(vec2f(0),0.0,0.24,4u,12.0,1.0/60.0);
 values[index*7u+4u]=vec4f(hit,mist.y,rain.y);
 var ironDry=vec2f(0.8,1);var crewDry=ironDry;
 for(var tick=0u;tick<60u;tick++){
   ironDry=moistureStep(ironDry,0,0,4u,12,1.0/60.0);
   crewDry=moistureStep(crewDry,0,0,3u,12,1.0/60.0);
 }
 values[index*7u+5u]=vec4f(ironDry,crewDry);
 let dry=moistureStep(vec2f(0),0,0,4u,12,1);
 let calm=moistureStep(vec2f(0,1),0,0,4u,0,1);
 let windy=moistureStep(vec2f(0,1),0,0,4u,30,1);
 values[index*7u+6u]=vec4f(dry,calm.y,windy.y);
}`;
      const module=device.createShaderModule({code});errors.push(...(await module.getCompilationInfo()).messages.filter(e=>e.type==='error').map(e=>e.message));
      const pipe=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'materialProbe'}}),B=GPUBufferUsage;
      const input=device.createBuffer({size:source.byteLength,usage:B.STORAGE|B.COPY_DST}),size=inputs.length*112;
      const output=device.createBuffer({size,usage:B.STORAGE|B.COPY_SRC}),read=device.createBuffer({size,usage:B.COPY_DST|B.MAP_READ});
      device.queue.writeBuffer(input,0,source);
      const group=device.createBindGroup({layout:pipe.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:input}},{binding:1,resource:{buffer:output}}]});
      const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(pipe);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(inputs.length/32));pass.end();
      encoder.copyBufferToBuffer(output,0,read,0,size);device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);
      const data=Array.from(new Float32Array(read.getMappedRange()));read.unmap();await device.queue.onSubmittedWorkDone();device.destroy();
      return{errors,inputs,data,composed:CARAVEL.includes(IRON_SURFACE)};
    });
    assert.deepEqual(result.errors,[]);assert.equal(result.composed,true);
    const entries=result.inputs.map((input,i)=>({input,v:result.data.slice(i*28,i*28+28)}));
    for(const {input,v}of entries){
      assert.ok(v.every(Number.isFinite),'native material output must remain finite');
      assert.ok(v.slice(0,3).every(x=>x>0&&x<.04),'dark oxide diffuse, not conductor F0');
      assert.ok(v[3]>=.0199&&v[3]<=.1401,'exposed metal is a bounded area fraction');
      assert.ok(v.slice(4,7).every(x=>x>.04&&x<1),'conductor reflectance remains independent of dark diffuse');
      assert.ok(v[7]>=.6199&&v[7]<=.8601,'rough cast substrate');
      assert.ok(Math.abs(v[9]-input[4])<1e-6);assert.ok(v[10]<v[7],'film has its own specular lobe');
      assert.ok(v[11]>=0&&v[11]<=1,'film cannot amplify substrate transmission');
      if(input[4]===0)assert.equal(v[11],1,'a dry surface has no extra coat attenuation');
      if(input[4]===1)assert.ok(v[11]+v[15]<=1.000001,'transmitted plus first-interface reflected energy stays bounded');
      assert.equal(v[16],0,'iron never retains absorbed moisture, even from an old nonzero state');
      assert.ok(v[17]>0&&v[18]>0&&v[19]>0,'water contact, deposited mist and rain each produce iron film');
      assert.equal(v[20],0);assert.ok(v[21]>0&&v[21]<v[23]&&v[23]<1,'iron drains faster than the unchanged crew kind3');
      assert.ok(v[22]>.5,'crew kind3 still retains absorbed moisture');
      assert.deepEqual(v.slice(24,26),[0,0],'a dry unexposed iron surface cannot wet itself');
      assert.ok(v[27]>0&&v[27]<v[26]&&v[26]<1,'wind accelerates film loss without immediate disappearance');
    }
    for(let p=0;p<4;p++){
      const at=(footprint,film,cosine)=>entries.find(e=>e.input.slice(0,3).every((x,i)=>x===result.inputs[p*12][i])&&e.input[3]===footprint&&e.input[4]===film&&e.input[5]===cosine).v;
      const dry=at(.0005,0,1),wet=at(.0005,1,1),far=at(.15,0,1);
      assert.deepEqual(wet.slice(0,9),dry.slice(0,9),'water film does not turn the substrate into smooth metal');
      assert.ok(wet[12]>dry[12]*2,'aligned sunlight can glisten on the actual film lobe');
      assert.ok(far[8]===0,'unresolved pit/cast relief disappears at coarse footprint');
      assert.ok(at(.0005,1,.15)[11]<wet[11],'grazing water film attenuates the substrate more');
    }
    assert.ok(entries.some(e=>e.input[3]===.0005&&Math.abs(e.v[8])>1e-6),'close cast relief is not a flat constant');
    await page.close();
  }finally{await browser?.close();server.kill();}
});

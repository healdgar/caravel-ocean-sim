// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {after,before,test} from 'node:test';
import {chromium} from 'playwright';

const port=process.env.UNDERWATER_SCATTER_TEST_PORT||8125,origin=`http://localhost:${port}`;
let server,browser;
before(async()=>{
  server=spawn(process.execPath,['server.mjs',String(port)],{cwd:new URL('..',import.meta.url),stdio:['ignore','pipe','inherit']});
  await Promise.race([once(server.stdout,'data'),once(server,'exit').then(([code])=>{throw Error('Underwater scattering server exited '+code);})]);
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,
    args:process.env.WEBGPU_BACKEND==='metal'?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
});
after(async()=>{await browser?.close();server?.kill();});

// Reference integrates local single scattering directly. It neither subtracts
// exponentials nor shares the production shader's closed-form/near-zero branch.
function numericalSingleScatter({path,eyeDepth,rayY,lightCos,turbidity},channel){
  const depth=Math.max(0,eyeDepth),cosine=Math.max(.05,lightCos);
  const length=Math.max(0,Math.min(path,rayY>1e-5?depth/rayY:Infinity));
  if(length===0)return 0;
  const sigma=[.20,.065,.035][channel]+Math.max(0,turbidity)*[.11,.095,.085][channel];
  const samples=16384,step=length/samples;
  const density=s=>sigma*Math.exp(-sigma*s)*Math.exp(-sigma*Math.max(0,depth-rayY*s)/cosine);
  let sum=density(0)+density(length);
  for(let i=1;i<samples;i++)sum+=density(i*step)*(i%2?4:2);
  return sum*step/3;
}

test('production underwater scattering agrees with independent path quadrature and a normalized angular phase',{timeout:120000},async()=>{
  const cases=[];
  const add=(name,path,eyeDepth,rayY,lightCos,turbidity)=>cases.push({name,path,eyeDepth,rayY,lightCos,turbidity});
  // Cover both light/view geometry and optical density, including long paths,
  // surface exits, zero path, and the limit where light/view coefficients cancel.
  for(const eyeDepth of [.05,2,15])for(const rayY of [-.8,0,.7])for(const turbidity of [0,2]){
    add(`column d=${eyeDepth} y=${rayY} t=${turbidity}`,12,eyeDepth,rayY,.65,turbidity);
  }
  for(const path of [0,.001,.2,2,20,200])add(`horizontal path ${path}`,path,3,0,.65,.4);
  for(const lightCos of [.05,.25,.65,1])add(`light angle ${lightCos}`,8,2,-.3,lightCos,.5);
  for(const rayY of [.65,.6500001,.6499999,.649415,.650585,.64922,.65078]){
    add(`cancelling coefficient ${rayY}`,10,12,rayY,.65,.4);
  }
  for(const path of [2,20,200])add(`upward surface exit ${path}`,path,2,1,.65,.4);
  add('clear short upward path',.05,.1,.7,1,0);
  add('turbid downward long path',120,20,-1,.25,8);
  add('grazing light clamps to finite path',4,1,-.2,0,.5);
  add('negative distance has no participating volume',-3,2,-.3,.65,0);
  // Reference the float32 inputs actually presented to the GPU, while retaining
  // an independent double-precision integral for each physical path.
  for(const c of cases)for(const key of ['path','eyeDepth','rayY','lightCos','turbidity'])c[key]=Math.fround(c[key]);
  const phaseSamples=8192,page=await browser.newPage();let result;
  try{
    await page.route('**/__underwater-scatter',route=>route.fulfill({contentType:'text/html',body:'<!doctype html>'}));await page.goto(origin+'/__underwater-scatter');
    result=await page.evaluate(async({cases,phaseSamples})=>{
      const {FRAME_WGSL,ATMO_CORE_WGSL}=await import('/js/wgsl/common.js');
      const {WATER_OPTICS}=await import('/js/wgsl/water-optics.js');
      const {UNDERWATER_SCATTER}=await import('/js/wgsl/underwater.js');
      const device=await(await navigator.gpu.requestAdapter()).requestDevice(),errors=[];device.onuncapturederror=e=>errors.push(e.error.message);
      const B=GPUBufferUsage,count=cases.length+phaseSamples,inputs=new Float32Array(count*8);
      for(const [i,c] of cases.entries())inputs.set([c.path,c.eyeDepth,c.rayY,c.lightCos,c.turbidity,0,0,0],i*8);
      for(let i=0;i<phaseSamples;i++)inputs.set([0,1,0,1,0,-1+2*(i+.5)/phaseSamples,0,0],(cases.length+i)*8);
      const input=device.createBuffer({size:inputs.byteLength,usage:B.STORAGE|B.COPY_DST});device.queue.writeBuffer(input,0,inputs);
      const output=device.createBuffer({size:count*16,usage:B.STORAGE|B.COPY_SRC}),read=device.createBuffer({size:count*16,usage:B.COPY_DST|B.MAP_READ});
      const module=device.createShaderModule({label:'production underwater path and phase regression',code:FRAME_WGSL+ATMO_CORE_WGSL+WATER_OPTICS+UNDERWATER_SCATTER+`
struct ScatterProbe {geometry:vec4f,medium:vec4f};
@group(0)@binding(0)var<storage,read>probes:array<ScatterProbe>;
@group(0)@binding(1)var<storage,read_write>answers:array<vec4f>;
@compute @workgroup_size(64)fn main(@builtin(global_invocation_id)i:vec3u){
 if(i.x>=arrayLength(&probes)){return;}
 let p=probes[i.x];
 answers[i.x]=vec4f(underwaterLightIntegral(p.geometry.x,p.geometry.y,p.geometry.z,p.geometry.w,p.medium.x),underwaterPhase(p.medium.y));
}`});
      const info=await module.getCompilationInfo();errors.push(...info.messages.filter(m=>m.type==='error').map(m=>m.message));
      const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'main'}});
      const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{binding:0,resource:{buffer:input}},{binding:1,resource:{buffer:output}}]});
      const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(count/64));pass.end();encoder.copyBufferToBuffer(output,0,read,0,count*16);device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);
      const values=Array.from(new Float32Array(read.getMappedRange()));read.unmap();device.destroy();
      return {errors,integrals:cases.map((_,i)=>values.slice(i*4,i*4+3)),phase:values.filter((_,i)=>i>=cases.length*4&&i%4===3)};
    },{cases,phaseSamples});
  }finally{await page.close();}
  assert.deepEqual(result.errors,[]);assert.equal(result.integrals.length,cases.length);assert.equal(result.phase.length,phaseSamples);
  for(const [i,c] of cases.entries()){
    const waterLength=Math.max(0,Math.min(c.path,c.rayY>1e-5?Math.max(0,c.eyeDepth)/c.rayY:Infinity));
    for(let channel=0;channel<3;channel++){
      const actual=result.integrals[i][channel],expected=numericalSingleScatter(c,channel);
      const sigma=[.20,.065,.035][channel]+Math.max(0,c.turbidity)*[.11,.095,.085][channel];
      const removedViewEnergy=1-Math.exp(-sigma*waterLength);
      assert.ok(Number.isFinite(actual)&&actual>=0&&actual<=removedViewEnergy+2e-6,`${c.name}, channel ${channel}: scattering cannot exceed extinguished view energy`);
      assert.ok(Math.abs(actual-expected)<=2.5e-5+expected*2e-4,`${c.name}, channel ${channel}: GPU ${actual}, independent quadrature ${expected}`);
      if(waterLength===0)assert.equal(actual,0,`${c.name}: a zero water segment cannot scatter`);
    }
  }
  const at=name=>result.integrals[cases.findIndex(c=>c.name===name)];
  for(const path of [20,200])for(let channel=0;channel<3;channel++)assert.ok(Math.abs(at(`upward surface exit ${path}`)[channel]-at('upward surface exit 2')[channel])<2e-6,'extending the view above its surface exit adds no underwater scattering');
  for(let i=1;i<6;i++)for(let channel=0;channel<3;channel++){
    const paths=[0,.001,.2,2,20,200];assert.ok(at(`horizontal path ${paths[i]}`)[channel]>=at(`horizontal path ${paths[i-1]}`)[channel]-2e-6,'integrating additional submerged distance cannot remove already accumulated scattering');
  }
  assert.ok(result.phase.every(value=>Number.isFinite(value)&&value>0),'angular scattering is finite and positive over the sphere');
  const phaseIntegral=result.phase.reduce((sum,value)=>sum+value,0)*(2/phaseSamples)*2*Math.PI;
  assert.ok(Math.abs(phaseIntegral-1)<2e-4,`the phase function must redistribute one unit of light over solid angle, got ${phaseIntegral}`);
  assert.ok(result.phase.at(-1)>result.phase[0]*10,'the normalized water phase retains a forward scattering lobe');
});

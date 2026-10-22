// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Direct-light regression for the orange night-foam failure. Uses production
// SKY_RENDER_FUNCS and the actual frame-wide ocean-light cache, not screenshots.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {test} from 'node:test';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';

// Independent projected-disc area quadrature. This does not repeat the shader's
// inverse-trigonometric cap formula. A tilted sphere's local horizon is derived
// geometrically from observer radius, then the visible disc slices are summed.
function solarDiscVisibleFraction(mu,heightKm){
  const planet=6360,radius=planet+heightKm,dip=Math.acos(planet/radius),horizon=-Math.sin(dip),sunRadius=.004675;
  const boundary=(mu-horizon)/sunRadius;if(boundary<=-1)return 0;if(boundary>=1)return 1;
  const steps=16384,dy=2/steps;let visible=0;
  for(let i=0;i<steps;i++){const y=-1+(i+.5)*dy;if(y<=boundary)visible+=2*Math.sqrt(Math.max(0,1-y*y))*dy;}
  return visible/Math.PI;
}

test('actual528B direct sunlight obeys planet/finite-disc horizon while twilight and Moon stay separate',{timeout:180000},async()=>{
  const server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');let browser;
  try{
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
    const page=await browser.newPage();await page.route('**/__celestial-horizon',route=>route.fulfill({contentType:'text/html',body:'<!doctype html>'}));await page.goto('http://127.0.0.1:'+server.address().port+'/__celestial-horizon');
    const result=await page.evaluate(async()=>{
      const {FRAME_WGSL,ATMO_CORE_WGSL}=await import('/js/wgsl/common.js'),{SKY_RENDER_FUNCS}=await import('/js/wgsl/sky.js');
      const {OCEAN_LIGHTING}=await import('/js/wgsl/ocean-lighting.js'),{withCelestialFrame}=await import('/js/wgsl/celestial.js');
      const {createAstronomyClock,writeAstronomyFrame}=await import('/js/astronomy.js');
      const device=await(await navigator.gpu.requestAdapter()).requestDevice(),errors=[];device.onuncapturederror=e=>errors.push(e.error.message);
      const B=GPUBufferUsage,T=GPUTextureUsage,frameData=new Float32Array(132),frame=device.createBuffer({size:528,usage:B.UNIFORM|B.COPY_DST});
      const answer=device.createBuffer({size:48,usage:B.STORAGE|B.COPY_SRC}),cache=device.createBuffer({size:64,usage:B.STORAGE|B.COPY_SRC|B.COPY_DST}),read=device.createBuffer({size:112,usage:B.COPY_DST|B.MAP_READ});
      const sampler=device.createSampler({minFilter:'linear',magFilter:'linear',mipmapFilter:'linear'});
      function constantTexture(values,layers=1){const texture=device.createTexture({size:[1,1,layers],format:'rgba16float',usage:T.TEXTURE_BINDING|T.COPY_DST});for(let layer=0;layer<layers;layer++)device.queue.writeTexture({texture,origin:[0,0,layer]},new Uint16Array(values),{bytesPerRow:8},[1,1]);return texture;}
      // Deliberately orange, non-zero transmittance even below the planet. The
      // old clamped lookup leaks14*(1,.25,.0625) into high-exposure night foam.
      const trans=constantTexture([15360,13312,11264,15360]),sky=constantTexture([10240,11264,12288,15360]),environment=constantTexture([0,0,0,15360],6);
      const code=withCelestialFrame(FRAME_WGSL+ATMO_CORE_WGSL+`
@group(0)@binding(0)var<uniform>F:Frame;
@group(0)@binding(1)var transLUT:texture_2d<f32>;
@group(0)@binding(2)var skyLUT:texture_2d<f32>;
@group(0)@binding(3)var sampC:sampler;
@group(0)@binding(4)var<storage,read_write>answer:array<vec4f>;
`+SKY_RENDER_FUNCS+`
@compute @workgroup_size(1)fn main(){
 answer[0]=vec4f(sunIlluminance(),1);
 answer[1]=vec4f(skyAtmo(normalize(vec3f(.2,.5,.7))),1);
 answer[2]=vec4f(lunarIlluminance(),1);
}`);
      async function pipe(source,label){const module=device.createShaderModule({code:source,label});errors.push(...(await module.getCompilationInfo()).messages.filter(m=>m.type==='error').map(m=>label+': '+m.message));return device.createComputePipelineAsync({label,layout:'auto',compute:{module,entryPoint:'main'}});}
      const directPipe=await pipe(code,'production528B direct/twilight'),cachePipe=await pipe(withCelestialFrame(OCEAN_LIGHTING),'production528B ocean frame light');
      const group=(pipeline,resources)=>device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:resources.map((resource,binding)=>({binding,resource}))});
      const directGroup=group(directPipe,[{buffer:frame},trans.createView(),sky.createView(),sampler,{buffer:answer}]);
      const cacheGroup=group(cachePipe,[{buffer:frame},trans.createView(),sampler,environment.createView({dimension:'cube'}),{buffer:cache}]);
      frameData.set([0,.5,Math.sqrt(.75),14],32);frameData.set([640,400,1/640,1/400],36);frameData[112]=1;
      async function sample(name,{mu,height=0,enabled=1}={}){
        if(mu!==undefined){frameData[32]=Math.sqrt(Math.max(0,1-mu*mu));frameData[33]=mu;frameData[34]=0;}
        frameData[73]=height;frameData[112]=enabled;device.queue.writeBuffer(frame,0,frameData);device.queue.writeBuffer(cache,0,new Float32Array([1,1,0,0,...new Float32Array(12)]));
        const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(directPipe);pass.setBindGroup(0,directGroup);pass.dispatchWorkgroups(1);pass.setPipeline(cachePipe);pass.setBindGroup(0,cacheGroup);pass.dispatchWorkgroups(1);pass.end();encoder.copyBufferToBuffer(answer,0,read,0,48);encoder.copyBufferToBuffer(cache,0,read,48,64);device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);const values=Array.from(new Float32Array(read.getMappedRange()));read.unmap();return {name,mu:frameData[33],height:frameData[73],enabled,direct:values.slice(0,3),scattered:values.slice(4,7),moon:values.slice(8,11),cachedDirect:values.slice(16,19)};
      }
      const rows=[];
      rows.push(await sample('deep-night',{mu:-.9}));rows.push(await sample('day',{mu:.5}));rows.push(await sample('manual-compatibility',{mu:-.9,enabled:0}));
      for(const height of [0,.01,5]){
        const horizon=-Math.sqrt(1-(6360/(6360+height))**2);
        for(const d of [-1.2,-1,-.8,-.5,-.1,-.0001,0,.0001,.1,.5,.8,1,1.2])rows.push(await sample('cap-'+height+'-'+d,{mu:horizon+d*.004675,height}));
      }
      const nights=[];
      for(const [name,date]of [['full','2024-01-26T04:00:00Z'],['new','2024-02-10T04:00:00Z']]){
        const clock=createAstronomyClock(new URLSearchParams({skyMode:'astronomy',astroDate:date,astroRate:'0',latitude:'17.635',longitude:'-63.238'}));
        frameData.set(clock.state.sun.direction,32);writeAstronomyFrame(frameData,clock);
        const row=await sample(name,{height:.01});nights.push({...row,phase:clock.state.moon.phase,sunAltitude:clock.state.sun.altitude,moonAltitude:clock.state.moon.altitude});
      }
      device.destroy();return {errors,frameBytes:frame.size,rows,nights};
    });
    assert.deepEqual(result.errors,[]);assert.equal(result.frameBytes,528);
    const rgb=[14,3.5,.875],black=values=>values.every(value=>value===0),close=(a,b,tolerance,label)=>assert.ok(Math.abs(a-b)<=tolerance,`${label}: ${a} vs ${b}`);
    const deep=result.rows.find(row=>row.name==='deep-night'),day=result.rows.find(row=>row.name==='day'),manual=result.rows.find(row=>row.name==='manual-compatibility');
    assert.ok(black(deep.direct)&&black(deep.cachedDirect),'deep-below-horizon Sun supplies no direct solar light to materials or cached ocean foam');
    for(let k=0;k<3;k++){close(day.direct[k],rgb[k],2e-6,'above-horizon14×transmittance');close(day.cachedDirect[k],rgb[k],2e-6,'day cache parity');close(manual.direct[k],rgb[k],2e-6,'legacy manual light unchanged');}
    // A synthetic nonzero sky LUT witnesses independent scattered twilight:
    // blocking the solar disc must not multiply skyAtmo by its direct-light cap.
    assert.ok(deep.scattered.every(value=>value>.4),'twilight scattering survives direct-Sun rejection');
    for(let k=0;k<3;k++)close(deep.scattered[k],day.scattered[k],1e-6,'direct cap never gates existing scattered LUT');
    for(const height of [0,.01,5]){
      const cap=result.rows.filter(row=>row.name.startsWith('cap-'+height+'-'));let prior=-Infinity;
      for(const row of cap){
        const expected=solarDiscVisibleFraction(row.mu,row.height);
        for(let k=0;k<3;k++){assert.ok(Number.isFinite(row.direct[k])&&row.direct[k]>=0&&row.direct[k]<=rgb[k]+1e-5);close(row.direct[k]/rgb[k],expected,.012,'independent solar-disc area at '+height+'km');close(row.cachedDirect[k],row.direct[k],3e-6,'ocean/material cap parity');}
        assert.ok(row.direct[0]>=prior-1e-5,'solar cap is monotone across rise/set');prior=row.direct[0];
      }
      const middle=cap.find(row=>row.name==='cap-'+height+'-0');close(middle.direct[0]/14,.5,.012,'half-disc at curved local horizon');
      const before=cap.find(row=>row.name==='cap-'+height+'--0.0001'),after=cap.find(row=>row.name==='cap-'+height+'-0.0001');assert.ok(after.direct[0]>before.direct[0]&&after.direct[0]-before.direct[0]<.01,'finite disc is continuous through horizon');
      assert.ok(black(cap[0].direct));close(cap.at(-1).direct[0],14,2e-6,'fully emerged disc');
    }
    const highHalf=result.rows.find(row=>row.name==='cap-5-0');assert.ok(highHalf.mu<0&&highHalf.direct[0]>6,'high observer sees direct Sun below sea-level horizon');
    for(const night of result.nights){assert.ok(night.sunAltitude< -15);assert.ok(black(night.direct)&&black(night.cachedDirect),night.name+' production ephemerides cannot illuminate orange foam through clamped direct solar LUT');assert.ok(night.scattered.every(Number.isFinite));}
    assert.ok(result.nights[0].phase>.995&&result.nights[0].moonAltitude>0&&result.nights[0].moon.some(value=>value>0),'real full-Moon light remains independent');assert.ok(result.nights[1].phase<.01);
    await page.close();
  }finally{await browser?.close();server.close();}
});

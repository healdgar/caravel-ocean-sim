// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Real GPU incident-water samples -> actual blade contacts -> shared wave/foam
// texture and production sampling function. Root alone executes qualification.
import assert from 'node:assert/strict';
import test from 'node:test';
import {once} from 'node:events';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';

test('accepted GPU water and real blade crossings radiate shared height and foam through production sampling',{timeout:180000},async t=>{
  const server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');let browser;
  try{
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'
      ?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']
      :['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
    const page=await browser.newPage();await page.route('**/__rowing_surface',r=>r.fulfill({contentType:'text/html',body:'<!doctype html>'}));await page.goto('http://127.0.0.1:'+server.address().port+'/__rowing_surface');
    const result=await page.evaluate(async()=>{
      const {createRowingSurfaceEvents}=await import('/js/rowing-surface-events.js'),{advanceRowing}=await import('/js/rowing.js'),{createRowingWaterProbe}=await import('/js/rowing-water.js'),{createSurfaceWaves}=await import('/js/surface-waves.js'),{SURFACE_WAVE_SAMPLE}=await import('/js/wgsl/surface-waves.js');
      const device=await(await navigator.gpu.requestAdapter()).requestDevice(),errors=[],B=GPUBufferUsage,T=GPUTextureUsage;device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
      const computePipe=async(code,label)=>{const module=device.createShaderModule({code,label}),bad=(await module.getCompilationInfo()).messages.filter(m=>m.type==='error');if(bad.length)throw Error(label+': '+bad.map(m=>m.message).join('\n'));return device.createComputePipelineAsync({label,layout:'auto',compute:{module,entryPoint:'main'}});};
      // This isolated query uses the unchanged base Frame prefix (384 B); it
      // does not qualify the application's separate 528 B astronomy extension.
      const waves=await createSurfaceWaves({device,computePipe}),frame=device.createBuffer({size:384,usage:B.UNIFORM|B.COPY_DST}),frameData=new Float32Array(96);frameData.fill(1/256,48,54);device.queue.writeBuffer(frame,0,frameData);
      // An explicitly resolved calm GPU sea is valid water. No CPU sampler or
      // the public pose evaluator's optional flat-water default is substituted.
      const sea=device.createTexture({size:[1,1,6],format:'rgba16float',usage:T.TEXTURE_BINDING|T.COPY_DST}),sampler=device.createSampler({minFilter:'linear',magFilter:'linear',addressModeU:'repeat',addressModeV:'repeat'});
      for(let layer=0;layer<6;layer++)device.queue.writeTexture({texture:sea,origin:[0,0,layer]},new Uint16Array(4),{bytesPerRow:8},[1,1,1]);
      const boat={modelId:'oseberg',length:21.5,beam:5,showProw:true,effects:true,revision:1,x:0,z:0,heading:0,pitch:0,roll:0,heave:.8,rudder:0,surgeVelocity:0,leewayVelocity:0,
        heaveVelocity:0,pitchVelocity:0,rollVelocity:0,yawRate:0,rowingState:{phase:.22,rate:.45,cadence:.45,effortPort:1,effortStarboard:1}};
      const probe=await createRowingWaterProbe({device,frameUBO:frame,seaView:sea.createView({dimension:'2d-array'}),seaSampler:sampler,computePipe,modelId:boat.modelId,surfaceWaves:waves});boat.rowingWater=probe;
      const collector=createRowingSurfaceEvents(waves),roster=[{id:'actual-gpu-rower',boat}],events=[];let time=0,phaseUnchanged=true;
      const step=async(dt=.025)=>{
        time+=dt;advanceRowing(boat,dt,{effort:1,cadence:.45});const stroke=JSON.stringify(boat.rowingState);
        probe.update(boat,dt,{time,choppy:1});events.push(...collector.flush({time,dt}));waves.update(boat,dt);
        const enc=device.createCommandEncoder(),cp=enc.beginComputePass();waves.encode(cp);cp.end();probe.encode(enc);device.queue.submit([enc.finish()]);probe.readback();await device.queue.onSubmittedWorkDone();
        for(let i=0;i<100&&probe.pending;i++)await new Promise(resolve=>setTimeout(resolve,0));if(probe.pending)throw Error('Actual incident-water readback did not settle');
        collector.collect(roster,{time,dt});phaseUnchanged&&=JSON.stringify(boat.rowingState)===stroke;
      };
      const half=n=>{const e=(n>>10)&31,m=n&1023;return(n&32768?-1:1)*(e===31?Infinity:e?(1+m/1024)*2**(e-15):m*2**-24);};
      const readField=async()=>{
        const size=waves.textures[waves.current].width,row=size*8,buffer=device.createBuffer({size:row*size,usage:B.MAP_READ|B.COPY_DST}),enc=device.createCommandEncoder();
        enc.copyTextureToBuffer({texture:waves.textures[waves.current],origin:[0,0,0]},{buffer,bytesPerRow:row},[size,size,1]);device.queue.submit([enc.finish()]);await buffer.mapAsync(GPUMapMode.READ);
        const values=Float32Array.from(new Uint16Array(buffer.getMappedRange()),half);buffer.unmap();buffer.destroy();let positive=0,negative=0,foam=0,positiveAt=0,foamAt=0,finite=true;
        for(let i=0;i<values.length;i+=4){if(values[i]>positive){positive=values[i];positiveAt=i/4;}negative=Math.min(negative,values[i]);if(values[i+2]>foam){foam=values[i+2];foamAt=i/4;}finite&&=Number.isFinite(values[i])&&Number.isFinite(values[i+1])&&Number.isFinite(values[i+2])&&Number.isFinite(values[i+3]);}
        return {size,values,positive,negative,foam,positiveAt,foamAt,finite};
      };
      for(let i=0;i<6;i++)await step();const cold=await readField(),acceptedWater=probe.state,waterSample=probe.sample(0,0);
      for(let i=0;i<48;i++){boat.heave-=.025;boat.heaveVelocity=-1;await step();}
      const entry=await readField();
      for(let i=0;i<64;i++){boat.heave+=.025;boat.heaveVelocity=1;await step();}
      boat.heaveVelocity=0;await step();const departed=await readField();
      // Query the very production function used by ocean displacement/foam at
      // exact centres of the strongest real height and foam texture cells.
      const positions=new Float32Array(8);for(const [i,cell]of [departed.positiveAt,departed.foamAt].entries())positions.set([(cell%departed.size+.5-departed.size/2)*.5, (Math.floor(cell/departed.size)+.5-departed.size/2)*.5,0,0],i*4);
      const query=device.createBuffer({size:32,usage:B.UNIFORM|B.COPY_DST}),output=device.createBuffer({size:32,usage:B.STORAGE|B.COPY_SRC}),read=device.createBuffer({size:32,usage:B.MAP_READ|B.COPY_DST});device.queue.writeBuffer(query,0,positions);
      const code=SURFACE_WAVE_SAMPLE+`
@group(0)@binding(0)var<uniform>SW:SurfaceWaveUniform;
@group(0)@binding(1)var surfaceWaveTex:texture_2d_array<f32>;
@group(0)@binding(2)var wakeSamp:sampler;
@group(0)@binding(3)var<storage,read_write>result:array<vec4f>;
struct Query{points:array<vec4f,2>};@group(0)@binding(4)var<uniform>query:Query;
@compute @workgroup_size(1)fn main(@builtin(global_invocation_id)i:vec3u){if(i.x<2u){result[i.x]=surfaceWaveAt(query.points[i.x].xy);}}`;
      const pipeline=await computePipe(code,'actual rowing disturbance production sample'),group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[{buffer:waves.uniform},waves.view,sampler,{buffer:output},{buffer:query}].map((resource,binding)=>({binding,resource}))});
      const enc=device.createCommandEncoder(),cp=enc.beginComputePass();cp.setPipeline(pipeline);cp.setBindGroup(0,group);cp.dispatchWorkgroups(2);cp.end();enc.copyBufferToBuffer(output,0,read,0,32);device.queue.submit([enc.finish()]);await read.mapAsync(GPUMapMode.READ);const sampled=Array.from(new Float32Array(read.getMappedRange()));read.unmap();
      const summary=data=>({positive:data.positive,negative:data.negative,foam:data.foam,finite:data.finite});
      const result={errors,cold:summary(cold),acceptedWater,waterSample,entry:summary(entry),departed:summary(departed),sampled,events:events.length,entries:events.filter(e=>e.kind==='entry').length,emergences:events.filter(e=>e.kind==='emerge').length,accepted:waves.stats.accepted,phaseUnchanged};
      collector.reset();probe.destroy();waves.destroy();sea.destroy();frame.destroy();for(const buffer of [query,output,read])buffer.destroy();await device.queue.onSubmittedWorkDone();device.destroy();return result;
    });
    t.diagnostic(JSON.stringify(result));assert.deepEqual(result.errors,[]);assert.ok(result.acceptedWater&&result.waterSample,'the GPU field actually became accepted incident water');
    assert.equal(result.cold.positive,0);assert.equal(result.cold.negative,0);assert.equal(result.cold.foam,0,'cold dry blades manufacture no water disturbance');
    assert.ok(result.entries>0&&result.emergences>0&&result.accepted>0,'real crossings, not manually injected impulses, reach the shared field');
    for(const data of [result.entry,result.departed])assert.ok(data.finite&&data.positive>0&&data.negative<0&&data.foam>0,'actual gravity-wave height and persistent foam are written');
    assert.ok(Math.abs(result.sampled[0]-result.departed.positive)<1e-6,'production ocean sampling receives the same actual ripple height');
    assert.ok(Math.abs(result.sampled[6]-result.departed.foam)<1e-6,'production foam sampling receives the same actual foam');assert.equal(result.phaseUnchanged,true);
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});

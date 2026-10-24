// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {chromium} from 'playwright';

test('native underside contacts retain real first-wet events and query all six horizontally displaced cascades', {timeout:120000},async()=>{
  const port=process.env.HULL_CONTACT_TEST_PORT||8091;
  const server=spawn(process.execPath,['server.mjs',String(port)],{cwd:new URL('..',import.meta.url),stdio:['ignore','pipe','inherit']});let browser;
  try{
    await Promise.race([once(server.stdout,'data'),once(server,'exit').then(([code])=>{throw Error(`Hull contact server exited ${code}`);})]);
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'
      ?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']
      :['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
    const page=await browser.newPage();await page.route('**/__hull-contact',route=>route.fulfill({contentType:'text/html',body:'<!doctype html>'}));
    await page.goto(`http://localhost:${port}/__hull-contact`);
    const result=await page.evaluate(async()=>{
      const {HULL_CONTACT_QUERY,HULL_CONTACT_COUNT,HULL_CONTACT_RECORD_BYTES,HULL_CONTACT_FLAGS:FLAGS}=await import('/js/wgsl/hull-contact.js');
      const {createHullContactDefinitions,hullContactWorldPoint,HULL_CONTACT_LIMITS}=await import('/js/hull-contact.js');
      const {NINA_DESIGN}=await import('/js/models/nina.js');
      const {VICTORY_DESIGN}=await import('/js/models/victory.js');
      const {boatRotate}=await import('/js/boat.js');
      const adapter=await navigator.gpu.requestAdapter();if(!adapter)throw Error('No WebGPU adapter');
      const device=await adapter.requestDevice(),errors=[];
      device.onuncapturederror=event=>errors.push(event.error.message);
      const B=GPUBufferUsage,T=GPUTextureUsage;
      const frame=device.createBuffer({size:384,usage:B.UNIFORM|B.COPY_DST});
      const hull=device.createBuffer({size:96,usage:B.UNIFORM|B.COPY_DST});
      const control=device.createBuffer({size:48,usage:B.UNIFORM|B.COPY_DST});
      const input=device.createBuffer({size:HULL_CONTACT_COUNT*32,usage:B.STORAGE|B.COPY_DST});
      const output=device.createBuffer({size:HULL_CONTACT_COUNT*HULL_CONTACT_RECORD_BYTES,usage:B.STORAGE|B.COPY_SRC});
      const read=device.createBuffer({size:HULL_CONTACT_COUNT*HULL_CONTACT_RECORD_BYTES,usage:B.MAP_READ|B.COPY_DST});
      const width=32,height=32;
      const texture=device.createTexture({size:[width,height,6],format:'rgba16float',usage:T.TEXTURE_BINDING|T.COPY_DST});
      const sampler=device.createSampler({addressModeU:'repeat',addressModeV:'repeat',minFilter:'linear',magFilter:'linear'});
      const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module:device.createShaderModule({code:HULL_CONTACT_QUERY}),entryPoint:'main'}});
      const resources=[{buffer:frame},{buffer:hull},{buffer:control},{buffer:input},texture.createView({dimension:'2d-array'}),sampler,{buffer:output}];
      const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:resources.map((resource,binding)=>({binding,resource}))});
      const frameValues=new Float32Array(96);for(let i=0;i<6;i++)frameValues[48+i]=1/width;device.queue.writeBuffer(frame,0,frameValues);
      // Only finite ordinary values are used by this half-float texture fixture.
      const halfBuffer=new ArrayBuffer(4),halfF=new Float32Array(halfBuffer),halfU=new Uint32Array(halfBuffer);
      const half=value=>{
        if(value===0)return 0;halfF[0]=value;const bits=halfU[0],sign=(bits>>>16)&0x8000;
        const exponent=((bits>>>23)&255)-127+15,mantissa=(bits&0x7fffff)+0x1000;
        return sign+(exponent<<10)+(mantissa>>>13);
      };
      function sea(heights=Array(6).fill(0),ramp=false){
        const values=new Uint16Array(width*height*6*4);
        for(let layer=0;layer<6;layer++)for(let y=0;y<height;y++)for(let x=0;x<width;x++){
          const at=((layer*height+y)*width+x)*4;
          values[at]=half(ramp&&layer===5?1:0);
          values[at+1]=half(ramp&&layer===5?x+.5:heights[layer]);
        }
        device.queue.writeTexture({texture},values,{bytesPerRow:width*8,rowsPerImage:height},[width,height,6]);
      }
      const synthetic=new Float32Array(10*8);
      for(let i=0;i<10;i++)synthetic.set([3,0,3,i,0,-1,0,0],i*8);
      device.queue.writeBuffer(input,0,synthetic);sea();
      let time=0,sample=0;
      async function step({dt=.04,epoch=7,heave=.2,boat=null}={}){
        time+=Math.max(0,dt);sample++;
        const h=new Float32Array(24),b=boat??{length:12,beam:3.6,heading:0,pitch:0,roll:0,x:0,z:0,heave};
        for(const [offset,vector]of [[0,[1,0,0]],[4,[0,1,0]],[8,[0,0,-1]]])
          boatRotate(h.subarray(offset,offset+3),...vector,b.heading*Math.PI/180,b.pitch,b.roll);
        h[3]=boat?(b.modelId==='victory'?VICTORY_DESIGN:NINA_DESIGN).frame.verticalScale:1;
        h[12]=b.beam;h[13]=b.length;h[16]=b.x;h[17]=b.heave;h[18]=b.z;
        device.queue.writeBuffer(hull,0,h);
        const bytes=new ArrayBuffer(48),f=new Float32Array(bytes),u=new Uint32Array(bytes);
        f.set([dt,time,HULL_CONTACT_LIMITS.dryGap,HULL_CONTACT_LIMITS.wetGap,
          HULL_CONTACT_LIMITS.dryHold,HULL_CONTACT_LIMITS.staleSeconds,0,HULL_CONTACT_LIMITS.peakWindow]);
        u.set([epoch,1,10,sample],8);device.queue.writeBuffer(control,0,bytes);
        const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();
        pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(1);pass.end();
        encoder.copyBufferToBuffer(output,0,read,0,10*96);device.queue.submit([encoder.finish()]);
        await read.mapAsync(GPUMapMode.READ);const values=read.getMappedRange().slice(0);read.unmap();
        return {f:new Float32Array(values),u:new Uint32Array(values)};
      }
      const check=(condition,message)=>{if(!condition)throw Error(message);};
      const close=(a,b,tolerance=1e-4)=>check(Math.abs(a-b)<tolerance,`${a} versus ${b}`);
      let state=await step();check(state.u[21]===0,'initial dry seed must not emit');
      await step();state=await step();check((state.u[23]&FLAGS.armed)!==0,'GPU dry interval arms independently of CPU readback');
      state=await step({heave:-.1});check(state.u[21]===1,'descending dry bottom emits first-wet serial');
      check(state.f[19]>0,'entry stores positive closing');close(state.f[17],-.1);
      const entryPoint=Array.from(state.f.subarray(16,19)),entryTime=state.f[15],entryClosing=state.f[19];
      await step({heave:-.1});state=await step({heave:-.1});
      check(state.u[21]===1,'steady wet body does not emit repeated impacts');
      close(state.f[15],entryTime);close(state.f[19],entryClosing);
      check(entryPoint.every((v,k)=>v===state.f[16+k]),'entry point survives decimated reads');
      check(state.f[13]>.07,'event age advances each sim frame');
      state=await step({heave:-.05});check(state.u[21]===1,'rising body must not create another serial');
      await step({heave:.2});await step({heave:.2});
      sea([-.1,0,0,0,0,0]);state=await step({heave:.2});
      check(state.u[21]===1,'decreasing water level is not entry');
      sea([.35,0,0,0,0,0]);state=await step({heave:.2});
      check(state.u[21]===2,'rising sea can genuinely return to a stationary exposed bottom');
      check(state.f[8]===0&&state.f[10]<0,'encounter uses relative velocity, not hull descent alone');
      state=await step({epoch:8,heave:.2});check(state.u[21]===0,'revision/epoch seed while wet is silent');
      state=await step({epoch:8,heave:.2,dt:0});check((state.u[23]&FLAGS.valid)===0,'zero dt invalidates derivative history');
      state=await step({epoch:8,heave:.2});check(state.u[21]===0,'recovery seed is silent');

      // The final cascade alone supplies a linear height ramp AND a one-metre
      // horizontal displacement. At x=3, the inverse query must read height 2.
      sea(Array(6).fill(0),true);state=await step({epoch:9,heave:0});close(state.f[3],2,.003);
      sea([1,2,3,4,5,6]);state=await step({epoch:10,heave:0});close(state.f[3],21,.003);
      sea();let parity=0,mirrorError=0,epoch=20;
      for(const [modelId,design]of [['nina',NINA_DESIGN],['victory',VICTORY_DESIGN]]){
        const definitions=createHullContactDefinitions(modelId);device.queue.writeBuffer(input,0,definitions.values);
        const boat={modelId,...design.runtime,x:12,z:-9,heave:-.4,heading:37,pitch:.12,roll:.21};
        state=await step({epoch:epoch++,boat});
        for(let i=0;i<10;i++){
          const expected=hullContactWorldPoint(definitions.points[i],boat);
          parity=Math.max(parity,Math.hypot(...expected.map((v,k)=>v-state.f[i*24+4+k])));
        }
        const positive=state;state=await step({epoch:epoch++,boat:{...boat,roll:-boat.roll}});
        for(let i=0;i<8;i+=2){
          mirrorError=Math.max(mirrorError,Math.abs(positive.f[i*24+5]-state.f[(i+1)*24+5]),
            Math.abs(positive.f[(i+1)*24+5]-state.f[i*24+5]));
        }
      }
      check(parity<2e-5,`world transform parity ${parity}`);check(mirrorError<2e-5,`roll mirror ${mirrorError}`);
      // Small steep wave riding on a long swell at 30/60/120 Hz through WATER_CONTACTS + 8-frame readback.
      const {WATER_CONTACTS,CONTACT_COUNT,AUDIO_CONTACT_COUNT}=await import('/js/wgsl/interaction.js');
      const {createImpactDetector,createHullAudioState}=await import('/js/weather-state.js');
      const totalContacts=CONTACT_COUNT+AUDIO_CONTACT_COUNT;
      const interactionUBO=device.createBuffer({size:64,usage:B.UNIFORM|B.COPY_DST});
      const waterContacts=device.createBuffer({size:totalContacts*64,usage:B.STORAGE|B.COPY_SRC|B.COPY_DST});
      const waterRead=device.createBuffer({size:totalContacts*64,usage:B.MAP_READ|B.COPY_DST});
      const waterPipe=await device.createComputePipelineAsync({layout:'auto',compute:{module:device.createShaderModule({code:WATER_CONTACTS}),entryPoint:'main'}});
      const waterGroup=device.createBindGroup({layout:waterPipe.getBindGroupLayout(0),entries:[
        {buffer:frame},{buffer:interactionUBO},{buffer:hull},texture.createView({dimension:'2d-array'}),sampler,{buffer:waterContacts}
      ].map((resource,binding)=>({binding,resource}))});
      const swellRates={};
      for(const hz of [30,60,120]){
        const dt=1/hz,detector=createImpactDetector(CONTACT_COUNT),audio=createHullAudioState();
        device.queue.writeBuffer(waterContacts,0,new Float32Array(totalContacts*16));
        const hBuf=new Float32Array(24);
        boatRotate(hBuf.subarray(0,3),1,0,0,0,0,0);
        boatRotate(hBuf.subarray(4,7),0,1,0,0,0,0);
        boatRotate(hBuf.subarray(8,11),0,0,-1,0,0,0);
        hBuf[3]=NINA_DESIGN.frame.verticalScale;hBuf[12]=NINA_DESIGN.runtime.beam;hBuf[13]=NINA_DESIGN.runtime.length;
        device.queue.writeBuffer(hull,0,hBuf);
        let t=0,frameIdx=0,sprayLaunches=0,minWash=Infinity;const slaps=[];
        const totalSeconds=5.0,steps=Math.round(totalSeconds*hz);
        for(let stepIdx=0;stepIdx<=steps;stepIdx++){
          // Long swell (T=7.5s, A=0.45m) + steep riding wave (T=1.25s, A=0.14m) after 1.1s settle.
          const activeT=Math.max(0,t-1.1);
          const swell=activeT>0?.45*Math.sin(2*Math.PI*activeT/7.5):0;
          const chop=activeT>0?-.14*Math.sin(2*Math.PI*activeT/1.25):0;
          sea([swell+chop,0,0,0,0,0]);
          const ubo=new Float32Array([0,0,128,.5,0,0,dt,stepIdx===0?1:0,2.2,1,0,0,t,frameIdx,NINA_DESIGN.runtime.length/12,0]);
          device.queue.writeBuffer(interactionUBO,0,ubo);
          const enc=device.createCommandEncoder(),cp=enc.beginComputePass();
          cp.setPipeline(waterPipe);cp.setBindGroup(0,waterGroup);cp.dispatchWorkgroups(1);cp.end();
          const doRead=(frameIdx&7)===0;
          if(doRead)enc.copyBufferToBuffer(waterContacts,0,waterRead,0,totalContacts*64);
          device.queue.submit([enc.finish()]);
          if(doRead){
            await waterRead.mapAsync(GPUMapMode.READ);
            const raw=new Float32Array(waterRead.getMappedRange().slice(0));
            waterRead.unmap();
            for(let c=0;c<32;c++)sprayLaunches=Math.max(sprayLaunches,raw[c*16+15]);
            const event=detector.sample(raw,1,{now:t});
            audio.contact(detector.contact);
            const sound=audio.impact(event);
            if(sound)slaps.push({time:sound.time,gain:sound.gain,peakStrength:sound.peakStrength,peakClosing:sound.peakClosing,pos:sound.position});
          }
          const mix=audio.update(dt,{speed:2.2,leeway:.6});
          if(t>=1.5)minWash=Math.min(minWash,mix.wash);
          t+=dt;frameIdx++;
        }
        swellRates[hz]={count:slaps.length,sprayLaunches,minWash,slaps};
      }
      device.destroy();return {errors,parity,mirrorError,lastCascadeAndHorizontalInverse:true,firstWetSerial:2,swellRates};
    });
    assert.deepEqual(result.errors,[]);assert.ok(result.parity<2e-5);assert.ok(result.mirrorError<2e-5);
    assert.equal(result.lastCascadeAndHorizontalInverse,true);assert.equal(result.firstWetSerial,2);
    for(const hz of [30,60,120]){
      const r=result.swellRates[hz];
      assert.equal(r.sprayLaunches,0,`ordinary slaps at ${hz} Hz must not couple to ballistic spray launches`);
      assert.ok(r.minWash>.12,`continuous rush stays active at ${hz} Hz (${r.minWash})`);
      assert.equal(r.count,3,`expected 3 steep wave-face slaps on long swell at ${hz} Hz, got ${r.count}`);
      for(const slap of r.slaps){
        assert.ok(slap.peakStrength>=.045&&slap.peakClosing>=.52);
        assert.ok(Number.isFinite(slap.time)&&Number.isFinite(slap.pos.x)&&Number.isFinite(slap.pos.z));
      }
    }
  }finally{await browser?.close();server.kill();}
});

// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {chromium} from 'playwright';

test('ship wake pressure is continuous, maps both hulls, and emits actual stern waves without a ribbon', {timeout:180000},async()=>{
  const port=process.env.SHIP_WAKE_TEST_PORT||8093;
  const server=spawn(process.execPath,['server.mjs',String(port)],{cwd:new URL('..',import.meta.url),stdio:['ignore','pipe','inherit']});let browser;
  try{
    await Promise.race([once(server.stdout,'data'),once(server,'exit').then(([code])=>{throw Error(`Ship wake server exited ${code}`);})]);
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'
      ?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']
      :['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
    const page=await browser.newPage();await page.route('**/__ship-wake',route=>route.fulfill({contentType:'text/html',body:'<!doctype html>'}));
    await page.goto(`http://localhost:${port}/__ship-wake`);
    const result=await page.evaluate(async()=>{
      const {WAKE_UPDATE,WATER_CONTACTS,WAKE_SIZE}=await import('/js/wgsl/interaction.js');
      const {NINA_DESIGN}=await import('/js/models/nina.js');
      const {VICTORY_DESIGN}=await import('/js/models/victory.js');
      const adapter=await navigator.gpu.requestAdapter();if(!adapter)throw Error('No WebGPU adapter');
      const device=await adapter.requestDevice(),errors=[];device.onuncapturederror=e=>errors.push(e.error.message);
      const B=GPUBufferUsage,T=GPUTextureUsage;
      const makeBuffer=(size,usage)=>device.createBuffer({size,usage});
      const frame=makeBuffer(384,B.UNIFORM|B.COPY_DST),control=makeBuffer(64,B.UNIFORM|B.COPY_DST),hull=makeBuffer(96,B.UNIFORM|B.COPY_DST);
      const contacts=makeBuffer(40*64,B.STORAGE|B.COPY_SRC|B.COPY_DST),output=makeBuffer(4096*16,B.STORAGE|B.COPY_SRC);
      const landings=makeBuffer(WAKE_SIZE*WAKE_SIZE*4,B.STORAGE);
      const sea=device.createTexture({size:[1,1,6],format:'rgba16float',usage:T.TEXTURE_BINDING});
      const sampler=device.createSampler({minFilter:'linear',magFilter:'linear',addressModeU:'repeat',addressModeV:'repeat'});
      const textures=[0,1].map(()=>device.createTexture({size:[WAKE_SIZE,WAKE_SIZE],format:'rgba16float',usage:T.TEXTURE_BINDING|T.STORAGE_BINDING|T.COPY_SRC}));
      const shader=async(code,label,entryPoint='main')=>{
        const module=device.createShaderModule({code,label}),info=await module.getCompilationInfo();
        const bad=info.messages.filter(m=>m.type==='error');if(bad.length)throw Error(label+': '+bad.map(m=>m.message).join('\n'));
        return device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint}});
      };
      const auditCode=WAKE_UPDATE+`
@group(0) @binding(6) var<storage,read_write> audit:array<vec4f>;
@compute @workgroup_size(64) fn auditMapping(@builtin(global_invocation_id) id:vec3u){
  if(id.x>=40u){return;}
  let c=contacts[id.x];let along=dot(c.point.xz-H.origin.xz,H.forward.xz);
  audit[id.x]=vec4f(wakeForeU(along),wakeAftU(along),c.point.x,c.point.z);
}
@compute @workgroup_size(64) fn auditContinuity(@builtin(global_invocation_id) id:vec3u){
  if(id.x>=36u){return;}
  var first=0u;var count=16u;var n=id.x;
  if(id.x>=15u&&id.x<30u){first=16u;n=id.x-15u;}
  if(id.x>=30u&&id.x<33u){first=32u;count=4u;n=id.x-30u;}
  if(id.x>=33u){first=36u;count=4u;n=id.x-33u;}
  let u=(f32(n)+.5)/f32(count-1u);let a=wakeContact(first,count,u-.00001);let b=wakeContact(first,count,u+.00001);
  let p=(a.point.xz+b.point.xz)*.5+a.axis.xz*.4;
  let wa=wakePressure(p,a,1.0);let wb=wakePressure(p,b,1.0);
  audit[id.x]=vec4f(length(a.point.xyz-b.point.xyz),abs((wa.shape.x-wa.shape.y)-(wb.shape.x-wb.shape.y)),length(wa.drift-wb.drift),0);
}
@compute @workgroup_size(64) fn auditBalance(@builtin(global_invocation_id) id:vec3u){
  if(id.x>=4096u){return;}
  let p=(vec2f(f32(id.x%64u),f32(id.x/64u))+.5-32.0)*.25;
  let c=Contact(vec4f(0,0,0,.25),vec4f(1,0,0,0),vec4f(1,0,-2.48,1),vec4f(0));
  let value=wakePressure(p,c,1.0);audit[id.x]=value.shape;
}`;
      const [contactPipe,wakePipe,mappingPipe,continuityPipe,balancePipe]=await Promise.all([
        shader(WATER_CONTACTS,'wake contacts'),shader(WAKE_UPDATE,'wake height'),shader(auditCode,'contact mapping','auditMapping'),
        shader(auditCode,'pressure continuity','auditContinuity'),shader(auditCode,'balanced pressure','auditBalance')]);
      const bind=(pipe,entries)=>device.createBindGroup({layout:pipe.getBindGroupLayout(0),entries});
      const ref=buffer=>({buffer});
      const contactGroup=bind(contactPipe,[ref(frame),ref(control),ref(hull),sea.createView({dimension:'2d-array'}),sampler,ref(contacts)].map((resource,binding)=>({binding,resource})));
      const auditGroup=pipe=>bind(pipe,[{binding:0,resource:ref(control)},{binding:1,resource:ref(hull)},{binding:4,resource:ref(contacts)},{binding:6,resource:ref(output)}]);
      // Auto layouts retain only resources reached by each selected entry point.
      const mappingGroup=bind(mappingPipe,[{binding:1,resource:ref(hull)},{binding:4,resource:ref(contacts)},{binding:6,resource:ref(output)}]);
      const continuityGroup=auditGroup(continuityPipe);
      const balanceGroup=bind(balancePipe,[{binding:0,resource:ref(control)},{binding:1,resource:ref(hull)},{binding:6,resource:ref(output)}]);
      const wakeGroups=textures.map((texture,i)=>bind(wakePipe,[ref(control),ref(hull),textures[1-i].createView(),texture.createView(),ref(contacts),ref(landings)].map((resource,binding)=>({binding,resource}))));
      const f=new Float32Array(96);f.fill(1,48,54);device.queue.writeBuffer(frame,0,f);
      const h=new Float32Array(24);h[0]=h[5]=1;h[10]=-1;h[22]=1;
      const u=new Float32Array([0,0,128,.5,0,0,1/30,0,3.1,1,0,0,0,0,1,0]);
      device.queue.writeBuffer(control,0,u);
      const submit=(pipe,group,count=1,rows=1)=>{
        const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(pipe);pass.setBindGroup(0,group);pass.dispatchWorkgroups(count,rows);pass.end();device.queue.submit([encoder.finish()]);
      };
      const read=async(buffer,size)=>{
        const staging=makeBuffer(size,B.MAP_READ|B.COPY_DST),encoder=device.createCommandEncoder();encoder.copyBufferToBuffer(buffer,0,staging,0,size);device.queue.submit([encoder.finish()]);
        await staging.mapAsync(GPUMapMode.READ);const values=new Float32Array(staging.getMappedRange().slice(0));staging.unmap();staging.destroy();return values;
      };
      const mappings=[],continuities=[];
      for(const [model,design,length,beam] of [[0,NINA_DESIGN,20,6],[1,VICTORY_DESIGN,56.69,15.8]]){
        h[3]=design.frame.verticalScale;h[12]=beam;h[13]=length;h[23]=model;device.queue.writeBuffer(hull,0,h);
        u[7]=1;device.queue.writeBuffer(control,0,u);submit(contactPipe,contactGroup);
        submit(mappingPipe,mappingGroup);mappings.push(Array.from(await read(output,40*16)));
        submit(continuityPipe,continuityGroup);continuities.push(Array.from(await read(output,36*16)));
      }
      submit(balancePipe,balanceGroup,64);const balance=await read(output,4096*16);let positive=0,negative=0;
      for(let i=0;i<balance.length;i+=4){positive+=balance[i];negative+=balance[i+1];}
      // Isolate stern water from all bow/aft contact forcing. These controls are
      // explicit test fixtures; production still obtains them from the real hull.
      h[3]=NINA_DESIGN.frame.verticalScale;h[12]=6;h[13]=20;h[23]=0;device.queue.writeBuffer(hull,0,h);
      const c=new Float32Array(40*16);c[35*16]=-1;c[39*16]=1;
      let current=0;
      async function stern(speed,wet,frames,reset=true){
        c[35*16+11]=c[39*16+11]=wet;device.queue.writeBuffer(contacts,0,c);
        for(let i=0;i<frames;i++){
          u[7]=i===0&&reset?1:0;u[8]=speed;u[12]+=u[6];device.queue.writeBuffer(control,0,u);
          current=1-current;submit(wakePipe,wakeGroups[current],WAKE_SIZE/8,WAKE_SIZE/8);
        }
        const staging=makeBuffer(WAKE_SIZE*WAKE_SIZE*8,B.MAP_READ|B.COPY_DST),encoder=device.createCommandEncoder();
        encoder.copyTextureToBuffer({texture:textures[current]},{buffer:staging,bytesPerRow:WAKE_SIZE*8},[WAKE_SIZE,WAKE_SIZE]);device.queue.submit([encoder.finish()]);
        await staging.mapAsync(GPUMapMode.READ);const bits=new Uint16Array(staging.getMappedRange());
        const half=n=>{const e=(n>>10)&31,m=n&1023;return(n&32768?-1:1)*(e===31?Infinity:e?(1+m/1024)*2**(e-15):m*2**-24);};
        let peak=0,outgoing=0,crest=0,trough=0,finite=true;
        for(let i=0;i<WAKE_SIZE*WAKE_SIZE;i++){
          const value=half(bits[i*4]);const x=(i%WAKE_SIZE+.5-128)*.5,z=(Math.floor(i/WAKE_SIZE)+.5-128)*.5;
          finite&&=Number.isFinite(value)&&Number.isFinite(half(bits[i*4+1]));peak=Math.max(peak,Math.abs(value));
          crest=Math.max(crest,value);trough=Math.min(trough,value);
          if(Math.hypot(x,z)>9&&z>3)outgoing=Math.max(outgoing,Math.abs(value));
        }
        staging.unmap();staging.destroy();return{peak,outgoing,crest,trough,finite};
      }
      const stopped=await stern(0,1,2),dry=await stern(3.1,0,2),moving=await stern(3.1,1,240);
      device.destroy();return{mappings,continuities,balance:{positive,negative},stopped,dry,moving,errors};
    });
    assert.deepEqual(result.errors,[]);
    for(const values of result.mappings){
      for(let i=0;i<32;i++)assert.ok(Math.abs(values[i*4]-(i%16)/15)<1e-5,'fore contact mapping inverts the actual hull sample');
      for(let i=32;i<40;i++)assert.ok(Math.abs(values[i*4+1]-(i%4)/3)<1e-5,'aft mapping respects this model’s actual sampled span');
    }
    for(const values of result.continuities)for(let i=0;i<values.length;i+=4){
      assert.ok(values[i]<.002,'waterline position does not switch whole contacts');
      assert.ok(values[i+1]<.001,'signed displacement pressure stays continuous');
      assert.ok(values[i+2]<.001,'outward foam transport stays continuous');
    }
    assert.ok(Math.abs(result.balance.positive-result.balance.negative)/result.balance.positive<.001,'isolated local crest/trough kernels have equal integral');
    assert.equal(result.stopped.peak,0,'wet stern at zero headway creates no new wave source');
    assert.equal(result.dry.peak,0,'a dry stern creates no wave source');
    assert.ok(result.moving.finite,'retained height and vertical velocity stay finite');
    assert.ok(result.moving.crest>.001&&result.moving.trough<-.001,'stern forcing moves the actual height field both ways: '+JSON.stringify(result.moving));
    assert.ok(result.moving.outgoing>.0001,'stern-generated height travels beyond the compact source, independently of any ribbon or foam');
  }finally{await browser?.close();server.kill();}
});

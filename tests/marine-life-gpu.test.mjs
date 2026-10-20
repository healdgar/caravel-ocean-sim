import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {test} from 'node:test';
import {chromium} from 'playwright';

test('sharks, whales, wave-contact effects and blow plumes use the shared ocean depth and expire cleanly',{timeout:120000},async()=>{
  const port=process.env.MARINE_TEST_PORT||8095;
  const server=spawn(process.execPath,['server.mjs',String(port)],{cwd:new URL('..',import.meta.url),stdio:['ignore','pipe','inherit']});let browser;
  try{
    await once(server.stdout,'data');browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
    const page=await browser.newPage();await page.route('**/__marine',route=>route.fulfill({contentType:'text/html',body:'<!doctype html>'}));await page.goto(`http://localhost:${port}/__marine`);
    const result=await page.evaluate(async()=>{
      const {createMarineLife}=await import('/js/marine-life.js'),{CASCADES}=await import('/js/wgsl/common.js');
      const device=await(await navigator.gpu.requestAdapter()).requestDevice(),errors=[];device.onuncapturederror=e=>errors.push(e.error.message);
      const B=GPUBufferUsage,T=GPUTextureUsage;
      const buffer=(data,usage)=>{const b=device.createBuffer({size:data.byteLength,usage:usage|B.COPY_DST});device.queue.writeBuffer(b,0,data);return b;};
      const f=new Float32Array(96);f[0]=1/30;f[5]=1/15;f[9]=1/30;f[6]=.02;f[13]=2/3;f[14]=.7;f[15]=1;f[17]=10;
      f.set([1,0,0,0],20);f.set([0,1,0,0],24);f.set([0,.8,.6,12],32);f.set([128,128,1/128,1/128],36);
      f.set([1/1103,1/211,1/39,1/7,1/1.393,1/.2617],48);f[72]=1;f[73]=.01;
      const frame=buffer(f,B.UNIFORM),sun=buffer(new Float32Array([1,0,0,0]),B.STORAGE);
      const texture=(layers,color)=>{const t=device.createTexture({size:[1,1,layers],format:'rgba8unorm',usage:T.TEXTURE_BINDING|T.COPY_DST});for(let i=0;i<layers;i++)device.queue.writeTexture({texture:t,origin:[0,0,i]},new Uint8Array([...color,255]),{bytesPerRow:4},[1,1]);return t;};
      const trans=texture(1,[220,180,140]),sky=texture(1,[80,110,140]),env=texture(6,[40,70,100]);
      const sea=device.createTexture({size:[1,1,CASCADES],format:'rgba16float',usage:T.TEXTURE_BINDING|T.COPY_DST});
      const sampler=device.createSampler({minFilter:'linear',magFilter:'linear'}),repeat=device.createSampler({minFilter:'linear',magFilter:'linear',addressModeU:'repeat',addressModeV:'repeat'});
      const shader=async(code,label)=>{const m=device.createShaderModule({code,label}),info=await m.getCompilationInfo();for(const v of info.messages)if(v.type==='error')errors.push(v.message);return m;};
      const marine=await createMarineLife({device,frameUBO:frame,transView:trans.createView(),skyView:sky.createView(),sampler,envView:env.createView({dimension:'cube'}),sunVis:sun,seaView:sea.createView({dimension:'2d-array'}),seaSampler:repeat,shader,format:'rgba8unorm',samples:1,random:()=>.4});
      const target=device.createTexture({size:[128,128],format:'rgba8unorm',usage:T.RENDER_ATTACHMENT|T.COPY_SRC}),depth=device.createTexture({size:[128,128],format:'depth32float',usage:T.RENDER_ATTACHMENT});
      const read=device.createBuffer({size:128*128*4,usage:B.COPY_DST|B.MAP_READ}),boat={x:0,z:0,length:20,beam:6,heading:0,surgeVelocity:2};
      async function render(water=.5){const enc=device.createCommandEncoder(),compute=enc.beginComputePass();marine.encode(compute);compute.end();
        const pass=enc.beginRenderPass({colorAttachments:[{view:target.createView(),clearValue:[.02,.06,.08,1],loadOp:'clear',storeOp:'store'}],depthStencilAttachment:{view:depth.createView(),depthClearValue:water,depthLoadOp:'clear',depthStoreOp:'store'}});
        marine.draw(pass);pass.end();enc.copyTextureToBuffer({texture:target},{buffer:read,bytesPerRow:128*4},[128,128]);device.queue.submit([enc.finish()]);await read.mapAsync(GPUMapMode.READ);const data=Array.from(new Uint8Array(read.getMappedRange()));read.unmap();return data;}
      const changed=(a,b)=>a.reduce((n,v,i)=>n+(v!==b[i]?1:0),0),clearFx=()=>{for(const e of marine.state.effects){e.strength=0;e.age=10;}};
      const empty=await render();marine.trigger('shark',boat);marine.state.animals[0].x=marine.state.animals[0].z=0;marine.state.animals[0].heading=Math.PI/2;marine.update(0,boat,{});
      const shark=changed(empty,await render());marine.state.clear();marine.trigger('whale',boat,{behavior:'blow'});
      for(let i=0;i<180;i++)marine.update(1/60,boat,{});marine.state.animals[0].x=marine.state.animals[0].z=0;clearFx();marine.update(0,boat,{});
      const whale=changed(empty,await render());
      // Only the finest wave cascade rises three metres. The animal must move
      // with it; a renderer sampling just the broad swells would be occluded.
      device.queue.writeTexture({texture:sea,origin:[0,0,CASCADES-1]},new Uint16Array([0,0x4200,0,0]),{bytesPerRow:8},[1,1]);
      const raised=changed(empty,await render(.56));
      for(let i=0;i<CASCADES;i++)device.queue.writeTexture({texture:sea,origin:[0,0,i]},new Uint16Array(4),{bytesPerRow:8},[1,1]);
      for(let i=0;i<60*12;i++)marine.update(1/60,boat,{});marine.state.animals[0].x=marine.state.animals[0].z=0;clearFx();marine.update(0,boat,{});
      const submerged=changed(empty,await render());marine.state.clear();marine.update(0,boat,{});
      const inject=async(kind,age,water=.5)=>{clearFx();Object.assign(marine.state.effects[0],{x:0,z:0,age,strength:1.3,heading:.2,seed:4,kind,scale:5.2,speed:3,height:1,windX:5,windZ:2});marine.update(0,boat,{});return render(water);};
      const entry=changed(empty,await inject('entry',.25)),ripple=changed(empty,await inject('trail',1.2));
      const occluded=changed(empty,await inject('entry',.25,.95)),expired=changed(empty,await inject('entry',5));
      // Side elevation exposes the vertical plume, rather than its tiny top view.
      f[0]=1/12;f[5]=1/12;f[9]=0;f[13]=.65;device.queue.writeBuffer(frame,0,f);
      clearFx();marine.update(0,boat,{});const sideEmpty=await render(),blow=changed(sideEmpty,await inject('blow',.7)),blowExpired=changed(sideEmpty,await inject('blow',3.2));
      marine.state.clear();marine.update(0,boat,{});const cleared=changed(sideEmpty,await render());marine.destroy();device.destroy();return {errors,shark,whale,raised,submerged,entry,ripple,occluded,expired,blow,blowExpired,cleared};
    });
    assert.deepEqual(result.errors,[]);assert.ok(result.shark>20,JSON.stringify(result));assert.ok(result.whale>result.shark,JSON.stringify(result));assert.ok(result.raised>20,JSON.stringify(result));assert.equal(result.submerged,0,JSON.stringify(result));
    assert.ok(result.entry>20&&result.ripple>20&&result.blow>20,JSON.stringify(result));assert.equal(result.occluded,0,JSON.stringify(result));assert.equal(result.expired,0);assert.equal(result.blowExpired,0);assert.equal(result.cleared,0);
  }finally{await browser?.close();server.kill();}
});

test('marine spray freezes its keyed emission height while subsequent waves affect contact and new births',{timeout:120000},async()=>{
  const port=process.env.MARINE_TEST_PORT||8095;
  const server=spawn(process.execPath,['server.mjs',String(port)],{cwd:new URL('..',import.meta.url),stdio:['ignore','pipe','inherit']});let browser;
  try{
    await once(server.stdout,'data');browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
    const page=await browser.newPage();await page.route('**/__marine-birth',route=>route.fulfill({contentType:'text/html',body:'<!doctype html>'}));await page.goto(`http://localhost:${port}/__marine-birth`);
    const result=await page.evaluate(async()=>{
      const {MARINE_EFFECT_INIT,MARINE_LIFE_RENDER}=await import('/js/wgsl/marine-life.js'),{CASCADES}=await import('/js/wgsl/common.js');
      const device=await(await navigator.gpu.requestAdapter()).requestDevice(),errors=[];device.onuncapturederror=e=>errors.push(e.error.message);
      const B=GPUBufferUsage,T=GPUTextureUsage,make=(data,usage)=>{
        const b=device.createBuffer({size:data.byteLength,usage:usage|B.COPY_DST});device.queue.writeBuffer(b,0,data);return b;
      };
      const frameData=new Float32Array(96);frameData.set([1/1103,1/211,1/39,1/7,1/1.393,1/.2617],48);
      const frame=make(frameData,B.UNIFORM),eventData=new Float32Array(24);
      const event=(key,x=0)=>[x,0,.7,1,0,.37,3,5.2,1,5,2,key];
      eventData.set(event(11),0);eventData.set(event(34,3),12);
      const events=make(eventData,B.STORAGE),births=make(new Float32Array(48*4),B.STORAGE|B.COPY_SRC);
      const landings=make(new Float32Array(48*64*4),B.STORAGE|B.COPY_SRC);
      const sea=device.createTexture({size:[1,1,CASCADES],format:'rgba16float',usage:T.TEXTURE_BINDING|T.COPY_DST});
      const sampler=device.createSampler({minFilter:'linear',magFilter:'linear',addressModeU:'repeat',addressModeV:'repeat'});
      const half=n=>{if(n===0)return 0;const sign=n<0?0x8000:0,a=Math.abs(n),e=Math.floor(Math.log2(a));return sign|((e+15)<<10)|Math.round((a/2**e-1)*1024);};
      const heights=[.125,.25,-.0625,.5,.375,.0625];
      const water=values=>{for(let i=0;i<CASCADES;i++)device.queue.writeTexture({texture:sea,origin:[0,0,i]},new Uint16Array([0,half(values[i]),0,0]),{bytesPerRow:8},[1,1]);};
      water(heights);
      const answer=device.createBuffer({size:2*16,usage:B.STORAGE|B.COPY_SRC}),read=device.createBuffer({size:48*16+4*16,usage:B.COPY_DST|B.MAP_READ});
      async function pipeline(code,entry){
        const module=device.createShaderModule({code}),info=await module.getCompilationInfo();errors.push(...info.messages.filter(m=>m.type==='error').map(m=>m.message));
        return device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:entry}});
      }
      const init=await pipeline(MARINE_EFFECT_INIT,'marineBirthCS');
      // This calls the production world-position helper, including its frozen
      // sea origin, rather than duplicating the height/particle formula.
      const probe=await pipeline(MARINE_LIFE_RENDER+`
@group(0)@binding(12)var<storage,read_write>answers:array<vec4f>;
@compute @workgroup_size(1)fn birthProbe(@builtin(global_invocation_id)i:vec3u){
 let s=splashes[i.x];let p=marineBreathParticle(s.root.z,0u,s.shape.y,s.motion.yz,s.shape.x,s.shape.w/5.2,false);
 let world=marineBreathWorld(s,p);answers[i.x]=vec4f(world,dolphinHeight(world.xz));
}`,'birthProbe');
      const resources=[{binding:0,resource:{buffer:frame}},{binding:6,resource:sea.createView({dimension:'2d-array'})},{binding:7,resource:sampler},{binding:9,resource:{buffer:events}},{binding:10,resource:{buffer:births}}];
      const initGroup=device.createBindGroup({layout:init.getBindGroupLayout(0),entries:[...resources,{binding:11,resource:{buffer:landings}}]});
      const probeGroup=device.createBindGroup({layout:probe.getBindGroupLayout(0),entries:[...resources,{binding:12,resource:{buffer:answer}}]});
      async function sample(){
        device.queue.writeBuffer(events,0,eventData);
        const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();
        pass.setPipeline(init);pass.setBindGroup(0,initGroup);pass.dispatchWorkgroups(2);
        pass.setPipeline(probe);pass.setBindGroup(0,probeGroup);pass.dispatchWorkgroups(2);pass.end();
        encoder.copyBufferToBuffer(births,0,read,0,48*16);encoder.copyBufferToBuffer(answer,0,read,48*16,2*16);
        encoder.copyBufferToBuffer(landings,11*64*16,read,50*16,16);encoder.copyBufferToBuffer(landings,34*64*16,read,51*16,16);
        device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);
        const value=new Float32Array(read.getMappedRange()).slice();read.unmap();
        return {origins:Array.from(value.slice(0,48*4)),positions:[Array.from(value.slice(48*4,49*4)),Array.from(value.slice(49*4,50*4))],contacts:[Array.from(value.slice(50*4,51*4)),Array.from(value.slice(51*4,52*4))]};
      }
      const initial=await sample(),highWater=[...heights];highWater[CASCADES-1]+=8;water(highWater);
      const laterWave=await sample();eventData[2]=eventData[14]=2;const descending=await sample();
      water(heights);eventData[2]=eventData[14]=2.2;const afterContact=await sample();
      water(highWater);eventData.set(event(59),0);eventData.set(event(34,3),12);const replacement=await sample();
      // Sorting effects for draw submission must not turn their sorted index
      // into identity, nor re-sample the sea after the event is airborne.
      eventData.set(event(34,3),0);eventData.set(event(59),12);water(heights);const reordered=await sample();
      device.destroy();return {errors,cascades:CASCADES,heights,initial,laterWave,descending,afterContact,replacement,reordered};
    });
    assert.deepEqual(result.errors,[]);assert.equal(result.cascades,6,'the fixture must exercise all six production displacement bands');
    const total=result.heights.reduce((a,b)=>a+b,0),origin=(snapshot,key)=>snapshot.origins.slice(key%48*4,key%48*4+4);
    for(const key of [11,34])assert.deepEqual(origin(result.initial,key),[key,total,0,0],'birth samples the complete displaced sea');
    for(const key of [11,34])assert.deepEqual(origin(result.laterWave,key),origin(result.initial,key),'a passing wave cannot move the launch origin');
    for(let i=0;i<2;i++){
      assert.deepEqual(result.laterWave.positions[i].slice(0,3),result.initial.positions[i].slice(0,3),'detached mist stays in world space at equal event age');
      assert.equal(result.initial.positions[i][3],total);assert.equal(result.laterWave.positions[i][3],total+8,'contact still samples the current finest-scale wave');
      assert.ok(result.initial.positions[i][1]>total&&result.laterWave.positions[i][1]<total+8,'a later wave can overtake and clip the already airborne parcel');
      const hit=result.descending.contacts[i];assert.equal(hit[0],[11,34][i]);assert.ok(hit[1]>=0&&hit[1]<=2,'a descending droplet records its first actual water contact');
      assert.deepEqual(result.afterContact.contacts[i],hit,'later waves and particle age cannot move or replay an established impact');
    }
    assert.deepEqual(origin(result.replacement,59),[59,total+8,0,0],'a new serial reusing a cache slot captures its own launch sea');
    assert.deepEqual(origin(result.replacement,34),origin(result.initial,34),'recycling another slot preserves the existing event');
    assert.ok(Math.abs(result.replacement.positions[0][1]-result.initial.positions[0][1]-8)<1e-5,'only the new event starts on the new sea level');
    assert.deepEqual(result.reordered.positions[0].slice(0,3),result.replacement.positions[1].slice(0,3),'draw sorting preserves the existing event origin');
    assert.deepEqual(result.reordered.positions[1].slice(0,3),result.replacement.positions[0].slice(0,3),'draw sorting preserves the recycled event origin');
    for(const p of result.reordered.positions)assert.equal(p[3],total,'fallout/contact continues to follow subsequent water independently');
  }finally{await browser?.close();server.kill();}
});

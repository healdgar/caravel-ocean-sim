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
      async function render(water=.5){const enc=device.createCommandEncoder(),pass=enc.beginRenderPass({colorAttachments:[{view:target.createView(),clearValue:[.02,.06,.08,1],loadOp:'clear',storeOp:'store'}],depthStencilAttachment:{view:depth.createView(),depthClearValue:water,depthLoadOp:'clear',depthStoreOp:'store'}});
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

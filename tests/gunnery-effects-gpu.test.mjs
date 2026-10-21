// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {test} from 'node:test';
import {chromium} from 'playwright';

test('native cannon FX render dense volumetric smoke, brief flash, dark roundshot and physics-born splash with correct depth',{timeout:120000},async()=>{
  const port=process.env.GUNNERY_FX_TEST_PORT||8137;
  const server=spawn(process.execPath,['server.mjs',String(port)],{cwd:new URL('..',import.meta.url),stdio:['ignore','pipe','inherit']});let browser;
  try{
    await once(server.stdout,'data');
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
    const page=await browser.newPage();await page.route('**/__gunnery-fx',route=>route.fulfill({contentType:'text/html',body:'<!doctype html>'}));await page.goto(`http://localhost:${port}/__gunnery-fx`);
    const result=await page.evaluate(async()=>{
      const {createGunneryEffects}=await import('/js/gunnery-effects.js'),{CASCADES}=await import('/js/wgsl/common.js');
      const adapter=await navigator.gpu.requestAdapter(),device=await adapter.requestDevice(),errors=[];device.onuncapturederror=e=>errors.push(e.error.message);
      const B=GPUBufferUsage,T=GPUTextureUsage;
      const make=(data,usage)=>{const b=device.createBuffer({size:data.byteLength,usage:usage|B.COPY_DST});device.queue.writeBuffer(b,0,data);return b;};
      const f=new Float32Array(96);f[0]=f[5]=1;f[11]=-1;f[14]=.1;f.set([0,1,10,0],16);f.set([1,0,0,0],20);f.set([0,1,0,0],24);f.set([0,0,-1,0],28);
      f.set([0,.8,.6,2],32);f.set([256,256,1/256,1/256],36);f.set([1/1103,1/211,1/39,1/7,1/1.393,1/.2617],48);f[72]=1;f[73]=.001;
      const frame=make(f,B.UNIFORM),sun=make(new Float32Array([1,0,0,0]),B.STORAGE);
      const texture=(layers,color)=>{const t=device.createTexture({size:[1,1,layers],format:'rgba8unorm',usage:T.TEXTURE_BINDING|T.COPY_DST});for(let i=0;i<layers;i++)device.queue.writeTexture({texture:t,origin:[0,0,i]},new Uint8Array([...color,255]),{bytesPerRow:4},[1,1]);return t;};
      const sky=texture(1,[100,120,150]),trans=texture(1,[220,210,195]),env=texture(6,[70,90,110]);
      const sea=device.createTexture({size:[1,1,CASCADES],format:'rgba16float',usage:T.TEXTURE_BINDING|T.COPY_DST});
      const sampler=device.createSampler({minFilter:'linear',magFilter:'linear'}),seaSampler=device.createSampler({minFilter:'linear',magFilter:'linear',addressModeU:'repeat',addressModeV:'repeat'});
      const shader=async(code,label)=>{const module=device.createShaderModule({code,label});errors.push(...(await module.getCompilationInfo()).messages.filter(v=>v.type==='error').map(v=>v.message));return module;};
      const fx=await createGunneryEffects({device,frameUBO:frame,transView:trans.createView(),skyView:sky.createView(),sampler,envView:env.createView({dimension:'cube'}),sunVis:sun,seaView:sea.createView({dimension:'2d-array'}),seaSampler,shader,format:'rgba16float',samples:4});
      const ms=device.createTexture({size:[256,256],sampleCount:4,format:'rgba16float',usage:T.RENDER_ATTACHMENT});
      const target=device.createTexture({size:[256,256],format:'rgba16float',usage:T.RENDER_ATTACHMENT|T.COPY_SRC});
      const depth=device.createTexture({size:[256,256],sampleCount:4,format:'depth32float',usage:T.RENDER_ATTACHMENT|T.TEXTURE_BINDING});
      const read=device.createBuffer({size:256*256*8,usage:B.COPY_DST|B.MAP_READ});
      const half=n=>{const sign=n&0x8000?-1:1,e=(n>>10)&31,m=n&1023;return sign*(e===0?m*2**-24:e===31?Infinity:(1+m/1024)*2**(e-15));};
      let writes=0;const original=device.queue.writeBuffer.bind(device.queue);device.queue.writeBuffer=(...args)=>{writes++;return original(...args);};
      fx.update(.1,{wind:[10,0,0]});const idleWrites=writes;
      async function render(occlusion=0,backgroundAlpha=1){
        const encoder=device.createCommandEncoder();let pass=encoder.beginRenderPass({colorAttachments:[{view:ms.createView(),clearValue:[.02,.04,.06,backgroundAlpha],loadOp:'clear',storeOp:'store'}],depthStencilAttachment:{view:depth.createView(),depthClearValue:occlusion,depthLoadOp:'clear',depthStoreOp:'store'}});
        fx.drawProjectiles(pass);pass.end();fx.resolveDepth(encoder,depth.createView(),256,256);
        pass=encoder.beginRenderPass({colorAttachments:[{view:ms.createView(),resolveTarget:target.createView(),loadOp:'load',storeOp:'store'}],depthStencilAttachment:{view:depth.createView(),depthLoadOp:'load',depthStoreOp:'store'}});fx.draw(pass);pass.end();
        encoder.copyTextureToBuffer({texture:target},{buffer:read,bytesPerRow:256*8},[256,256]);device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);const data=Array.from(new Uint16Array(read.getMappedRange()),half);read.unmap();return data;
      }
      const empty=await render();const changed=data=>{let count=0,peak=0,sum=0,min=1e8;for(let p=0;p<256*256;p++){const i=p*4,l=(data[i]+data[i+1]+data[i+2])/3;peak=Math.max(peak,l);min=Math.min(min,l);sum+=l;if(Math.abs(data[i]-empty[i])+Math.abs(data[i+1]-empty[i+1])+Math.abs(data[i+2]-empty[i+2])>.002)count++;}return {count,peak,mean:sum/(256*256),min};};
      const panel=(pixels,label)=>{const figure=document.createElement('figure'),caption=document.createElement('figcaption'),canvas=document.createElement('canvas');canvas.width=canvas.height=256;caption.textContent=label;const ctx=canvas.getContext('2d'),data=ctx.createImageData(256,256);for(let i=0;i<data.data.length;i++)data.data[i]=i%4===3?255:Math.round(255*Math.pow(Math.max(0,pixels[i])/(1+Math.max(0,pixels[i])),1/2.2));ctx.putImageData(data,0,0);figure.append(caption,canvas);document.body.append(figure);};
      document.body.style='margin:0;background:#111;color:white;display:flex;font:16px sans-serif';
      fx.emitShot({position:[-3,1,0],direction:[1,0,0],chargeKg:3});fx.update(.025,{wind:[0,0,0],eye:[0,1,10]});const flashPixels=await render(),flash=changed(flashPixels);panel(flashPixels,'25 ms: flash');
      fx.update(.225,{wind:[0,0,0],eye:[0,1,10]});const smokePixels=await render(),smoke=changed(smokePixels),occluded=changed(await render(.03));panel(smokePixels,'250 ms: smoke');
      const smokeCounts=fx.counts;f[35]=0;device.queue.writeBuffer(frame,0,f);const night=changed(await render());
      f[35]=2;device.queue.writeBuffer(frame,0,f);for(let i=0;i<11;i++)fx.update(.25,{wind:[1,0,0],eye:[0,1,10]});const billowPixels=await render(),billow=changed(billowPixels);panel(billowPixels,'3 s: expanded billows');
      const opacityPixels=await render(0,0),alpha=[];for(let i=3;i<opacityPixels.length;i+=4)alpha.push(opacityPixels[i]);const peakOpacity=Math.max(...alpha);
      fx.clear();f[35]=2;device.queue.writeBuffer(frame,0,f);fx.setProjectiles([{position:[0,1,0],radius:.3}]);fx.update(0);const ball=changed(await render());
      fx.clear();fx.emitImpact({position:[0,0,0],velocity:[25,-35,-5],massKg:12});fx.update(.3,{wind:[7,0,0]});const splashPixels=await render(),splash=changed(splashPixels),splashOccluded=changed(await render(.03));panel(splashPixels,'300 ms: real water impact');
      const birth=Array.from(fx.state.impacts[0].position);fx.clear();fx.update(.1);const cleared=changed(await render());
      await device.queue.onSubmittedWorkDone();fx.destroy();device.destroy();return {errors,idleWrites,flash,smoke,occluded,night,billow,peakOpacity,ball,splash,splashOccluded,birth,cleared,smokeCounts};
    });
    if(process.env.GUNNERY_FX_SHOT)await page.screenshot({path:process.env.GUNNERY_FX_SHOT,fullPage:true});
    assert.deepEqual(result.errors,[],JSON.stringify(result));assert.equal(result.idleWrites,0);
    assert.ok(result.flash.count>25&&result.flash.peak>2,JSON.stringify(result));
    assert.ok(result.smoke.count>100&&result.smoke.peak<result.flash.peak*.5,JSON.stringify(result));
    assert.equal(result.smokeCounts.volumes,3);assert.equal(result.occluded.count,0,JSON.stringify(result));
    assert.ok(result.night.mean<result.smoke.mean,JSON.stringify(result));
    assert.ok(result.billow.count>result.smoke.count*2,JSON.stringify(result));
    assert.ok(result.peakOpacity>.8&&result.peakOpacity<=1,'a 3-second-old single discharge must retain a dense central powder cloud: '+JSON.stringify(result));
    assert.ok(result.ball.count>5&&result.ball.min<.035,JSON.stringify(result));
    assert.ok(result.splash.count>20,JSON.stringify(result));assert.equal(result.splashOccluded.count,0,JSON.stringify(result));
    assert.deepEqual(result.birth,[0,0,0]);assert.equal(result.cleared.count,0,JSON.stringify(result));
  }finally{await browser?.close();server.kill();}
});

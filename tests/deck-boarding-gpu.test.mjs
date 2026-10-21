// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {test} from 'node:test';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';

test('bow-only overtopping and shared scene waves enter the real deck field without below-rail leaks',{timeout:120000},async t=>{
  const server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');let browser;
  try{
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'
      ?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
    const page=await browser.newPage();await page.route('**/__boarding',r=>r.fulfill({contentType:'text/html',body:'<!doctype html>'}));
    await page.goto('http://127.0.0.1:'+server.address().port+'/__boarding');
    const result=await page.evaluate(async()=>{
      const {createDeckWash}=await import('/js/deck.js'),{DECK_COLS:W,DECK_ROWS:H}=await import('/js/wgsl/deck.js');
      const d=await(await navigator.gpu.requestAdapter()).requestDevice(),errors=[];d.onuncapturederror=e=>errors.push(e.error.message);
      const B=GPUBufferUsage,T=GPUTextureUsage,buf=n=>d.createBuffer({size:n,usage:B.UNIFORM|B.COPY_DST});
      const frame=buf(384),hull=buf(96),control=buf(64),f=new Float32Array(96),h=new Float32Array(24),u=new Float32Array(16);
      f.fill(1,48,54);h[0]=h[5]=1;h[10]=-1;h[3]=20/12;h[12]=6;h[13]=20;h[22]=1;u[6]=1/60;u[9]=1;
      const sea=d.createTexture({size:[1,1,6],format:'rgba16float',usage:T.TEXTURE_BINDING}),lut=d.createTexture({size:[32,32,6],mipLevelCount:6,format:'rgba16float',usage:T.TEXTURE_BINDING});
      const sampler=d.createSampler({minFilter:'linear',magFilter:'linear'});
      const shader=async(code,label)=>{const m=d.createShaderModule({code,label}),bad=(await m.getCompilationInfo()).messages.filter(m=>m.type==='error');if(bad.length)throw Error(bad.map(m=>m.message).join('\n'));return m;};
      const make=async({bow=false,surfaceWaves=null}={})=>createDeckWash({device:d,frameUBO:frame,hullUBO:hull,uniform:control,seaView:sea.createView({dimension:'2d-array'}),seaSampler:sampler,
        envView:lut.createView({dimension:'cube'}),transView:lut.createView({dimension:'2d',baseArrayLayer:0,arrayLayerCount:1}),shader,
        computePipe:async(code,label)=>d.createComputePipelineAsync({layout:'auto',compute:{module:await shader(bow?code.replace('return interactionDisp(q).y;','return interactionDisp(q).y+select(0.0,F.sunDir.w,p.y< -10.62);'):code,label),entryPoint:'main'}}),surfaceWaves});
      const advance=async(deck,n=1,reset=false)=>{
        u[7]=reset?1:0;d.queue.writeBuffer(frame,0,f);d.queue.writeBuffer(hull,0,h);d.queue.writeBuffer(control,0,u);
        for(let i=0;i<n;i++){const e=d.createCommandEncoder(),p=e.beginComputePass();deck.encode(p);p.end();d.queue.submit([e.finish()]);}await d.queue.onSubmittedWorkDone();
      };
      const read=async deck=>{
        const b=d.createBuffer({size:W*H*16,usage:B.COPY_DST|B.MAP_READ}),e=d.createCommandEncoder();e.copyTextureToBuffer({texture:deck.textures[0]},{buffer:b,bytesPerRow:W*16},[W,H]);d.queue.submit([e.finish()]);await b.mapAsync(GPUMapMode.READ);
        const a=new Float32Array(b.getMappedRange());let depth=0,front=0,middle=0,cabin=0,wet=0,max=0,finite=true;
        for(let i=0;i<W*H;i++){const row=Math.floor(i/W),z=(row+.5)/H*12-6.4;depth+=a[i*4];wet+=a[i*4+2];max=Math.max(max,a[i*4]);finite&&=Number.isFinite(a[i*4]);if(row===0)front+=a[i*4];if(row>2&&row<25)middle+=a[i*4];if(z>=2.7)cabin+=a[i*4];}
        b.unmap();b.destroy();return{depth,front,middle,cabin,wet,max,finite};
      };
      const bow=await make({bow:true});await advance(bow,1,true);
      f[35]=2.8;await advance(bow,30);const blocked=await read(bow); // bow cap is >3m world
      f[35]=4;await advance(bow,60);const entered=await read(bow);
      f[35]=0;await advance(bow);const retained=await read(bow);
      await advance(bow,1200);const drained=await read(bow);
      // These fixture textures supply the actual shared wave sampling path.
      // Only view1 is high: choosing a stale ping-pong view would stay dry.
      const waveUniform=buf(64),waves=[0,1].map(()=>d.createTexture({size:[2,2,2],format:'rgba16float',usage:T.TEXTURE_BINDING|T.COPY_DST}));
      const sw=new Float32Array(16);sw.set([0,0,256,128,0,0,1024,512]);sw[15]=1;d.queue.writeBuffer(waveUniform,0,sw);
      const cells=new Uint16Array(16);for(let i=1;i<cells.length;i+=4)cells[i-1]=0x4400;
      for(let layer=0;layer<2;layer++)d.queue.writeTexture({texture:waves[1],origin:[0,0,layer]},cells,{bytesPerRow:16},[2,2]);
      const scene=await make({surfaceWaves:{uniform:waveUniform,views:waves.map(t=>t.createView({dimension:'2d-array'})),current:1}});
      await advance(scene,1,true);await advance(scene,60);const shared=await read(scene);
      u[9]=0;await advance(scene);const disabled=await read(scene);d.destroy();return{errors,blocked,entered,retained,drained,shared,disabled};
    });
    t.diagnostic(JSON.stringify(result));assert.deepEqual(result.errors,[]);
    assert.equal(result.blocked.depth,0,'sub-cap water cannot seep through the solid bow');
    assert.ok(result.entered.front>.1&&result.entered.middle>.1,'a narrow bow-only pulse crosses the end face and travels aft despite dry side lips');
    assert.equal(result.entered.cabin,0,'water cannot travel through the raised cabin face');
    assert.ok(result.retained.depth>result.entered.depth*.7,'wash outlasts the external crest');
    assert.ok(result.drained.depth<result.retained.depth*.5&&result.drained.wet>0,'standing water drains before the wet film dries');
    assert.ok(result.shared.depth>1&&result.shared.finite&&result.shared.max<=1.201,'current shared scene disturbance also overtops the deck with bounded water');
    assert.equal(result.disabled.depth,0);
  }finally{await browser?.close();await new Promise(r=>server.close(r));}
});

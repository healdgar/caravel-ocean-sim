// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Her open hull fills only when the sea stands above her rail, then empties.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {test,before,after} from 'node:test';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';

let server,browser,origin;
before(async()=>{
  server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');origin='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'
    ?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
});
after(async()=>{await browser?.close();await new Promise(r=>server.close(r));});

test('the real deck field stays dry below her rail, floods above it and drains',{timeout:240000},async()=>{
  const page=await browser.newPage();
  try{
    await page.route('**/__oseberg_deck',r=>r.fulfill({contentType:'text/html',body:'<!doctype html>'}));
    await page.goto(origin+'/__oseberg_deck');
    const result=await page.evaluate(async()=>{
      const {createDeckWash}=await import('/js/deck.js'),{DECK_COLS:W,DECK_ROWS:H}=await import('/js/wgsl/deck.js'),{vesselHull}=await import('/js/hull.js');
      const hull=vesselHull('oseberg'),sy=hull.frame.verticalScale,sx=hull.runtime.beam/3.6,sz=hull.runtime.length/12;
      const d=await(await navigator.gpu.requestAdapter()).requestDevice(),errors=[];d.onuncapturederror=e=>errors.push(e.error.message);
      const B=GPUBufferUsage,T=GPUTextureUsage,buf=n=>d.createBuffer({size:n,usage:B.UNIFORM|B.COPY_DST});
      const frame=buf(384),hullUBO=buf(96),control=buf(64),f=new Float32Array(96),h=new Float32Array(24),u=new Float32Array(16);
      f.fill(1,48,54);h[0]=h[5]=1;h[10]=-1;h[3]=sy;h[12]=hull.runtime.beam;h[13]=hull.runtime.length;h[23]=4;u[6]=1/60;u[9]=1;
      const sea=d.createTexture({size:[1,1,6],format:'rgba16float',usage:T.TEXTURE_BINDING|T.COPY_DST}),lut=d.createTexture({size:[32,32,6],mipLevelCount:6,format:'rgba16float',usage:T.TEXTURE_BINDING});
      const sampler=d.createSampler({minFilter:'linear',magFilter:'linear'});
      const shader=async(code,label)=>{const m=d.createShaderModule({code,label}),bad=(await m.getCompilationInfo()).messages.filter(x=>x.type==='error');if(bad.length)throw Error(bad.map(x=>x.message).join('\n'));return m;};
      const deck=await createDeckWash({device:d,frameUBO:frame,hullUBO,uniform:control,seaView:sea.createView({dimension:'2d-array'}),seaSampler:sampler,
        envView:lut.createView({dimension:'cube'}),transView:lut.createView({dimension:'2d',baseArrayLayer:0,arrayLayerCount:1}),shader,
        computePipe:async(code,label)=>d.createComputePipelineAsync({layout:'auto',compute:{module:await shader(code,label),entryPoint:'main'}})});
      // Metres of sea above the design waterline, as a half float.
      const half=v=>{if(!v)return 0;const i=new Uint32Array(new Float32Array([v]).buffer)[0];return ((i>>16)&0x8000)|((((i>>23)&0xff)-112)<<10)|((i>>13)&0x3ff);};
      const seaHeight=v=>d.queue.writeTexture({texture:sea},new Uint16Array([0,half(v),0,0]),{bytesPerRow:8},[1,1,1]);
      const advance=async(n,reset=false)=>{
        u[7]=reset?1:0;d.queue.writeBuffer(frame,0,f);d.queue.writeBuffer(hullUBO,0,h);d.queue.writeBuffer(control,0,u);
        for(let i=0;i<n;i++){const e=d.createCommandEncoder(),p=e.beginComputePass();deck.encode(p);p.end();d.queue.submit([e.finish()]);if(i%64===63)await d.queue.onSubmittedWorkDone();}
        await d.queue.onSubmittedWorkDone();
      };
      const volume=async()=>{
        const b=d.createBuffer({size:W*H*16,usage:B.COPY_DST|B.MAP_READ}),e=d.createCommandEncoder();e.copyTextureToBuffer({texture:deck.textures[0]},{buffer:b,bytesPerRow:W*16},[W,H]);d.queue.submit([e.finish()]);await b.mapAsync(GPUMapMode.READ);
        const a=new Float32Array(b.getMappedRange().slice(0));b.unmap();b.destroy();let v=0;
        for(let j=0;j<H;j++)for(let i=0;i<W;i++)v+=a[(j*W+i)*4]*2*hull.deckWidth((j+.5)/H*12-6)*sx/W*12*sz/H;
        return v;
      };
      const fill=async height=>{await advance(1,true);seaHeight(height);await advance(120);return volume();};
      // These sea heights flooded her old .6 m rail.
      const dry=[];for(const height of [.3,.62,.7,.9])dry.push(await fill(height));
      const flooded=await fill(1.4);
      seaHeight(0);await advance(1);const retained=await volume();
      await advance(600);const after10=await volume();
      await advance(3000);const after60=await volume();
      await advance(3600);const after120=await volume();
      d.destroy();return{dry,flooded,retained,after10,after60,after120,errors};
    });
    assert.deepEqual(result.errors,[]);
    assert.deepEqual(result.dry,[0,0,0,0],'no water crosses her rail until the sea stands above it');
    assert.ok(result.flooded>5,`a crest over the rail does fill her: ${result.flooded}`);
    assert.ok(result.after10<result.retained*.8,`water leaves within seconds: ${JSON.stringify(result)}`);
    assert.ok(result.after60<result.retained*.05,`she is nearly empty after a minute: ${JSON.stringify(result)}`);
    assert.equal(result.after120,0,'and never keeps a standing pool');
  }finally{await page.close();}
});

test('in the live game she stays dry in calm water and in a one metre swell',{timeout:300000},async()=>{
  for(const swellHs of ['.3','1']){
    const page=await browser.newPage({viewport:{width:420,height:270}});
    try{
      const errors=[];page.on('pageerror',e=>errors.push(e.message));
      await page.addInitScript(()=>{
        const request=GPUAdapter.prototype.requestDevice;
        GPUAdapter.prototype.requestDevice=async function(...args){const device=await request.apply(this,args);window.__device=device;device.addEventListener('uncapturederror',e=>(window.__gpuErrors??=[]).push(e.error.message));return device;};
      });
      const q=new URLSearchParams({ship:'oseberg',fleet:'',view:'ship',ui:'0',boatHeading:'0',boatX:'0',boatZ:'0',sunElev:'40',clouds:'0',windSpeed:'4',windDir:'118',swellHs,w:'420',h:'270',polygons:'fixed'});
      await page.goto(origin+'/?'+q,{waitUntil:'load',timeout:240000});
      await page.waitForFunction(()=>window.oceanStartup?.state==='ready',null,{timeout:240000});
      const history=[];
      for(let i=0;i<20;i++){
        history.push(await page.evaluate(async()=>{
          const {DECK_COLS:W,DECK_ROWS:H}=await import('/js/wgsl/deck.js');
          const v=oceanFleet.vessels[0],d=window.__device,b=d.createBuffer({size:W*H*16,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}),e=d.createCommandEncoder();
          e.copyTextureToBuffer({texture:v.interaction.deck.textures[0]},{buffer:b,bytesPerRow:W*16},[W,H]);d.queue.submit([e.finish()]);await b.mapAsync(GPUMapMode.READ);
          const a=new Float32Array(b.getMappedRange().slice(0));b.unmap();b.destroy();let max=0;for(let i=0;i<W*H;i++)max=Math.max(max,a[i*4]);
          return {max,modelId:v.boat.modelId,sinkage:v.boat.hydrodynamics.sinkage,freeboard:v.boat.hydrodynamics.freeboard};
        }));
        await page.waitForTimeout(1000);
      }
      assert.deepEqual(errors,[]);assert.deepEqual(await page.evaluate(()=>window.__gpuErrors??[]),[]);
      assert.equal(history[0].modelId,'oseberg');assert.ok(Math.abs(history[0].sinkage)<1e-6);assert.ok(history[0].freeboard>.9);
      assert.ok(history.every(s=>s.max===0),`swell ${swellHs}: deck water ${JSON.stringify(history.map(s=>s.max))}`);
    }finally{await page.close();}
  }
});

// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {test} from 'node:test';
import {chromium} from 'playwright';

test('roundshot sweeps actual six-band displaced sea, catches narrow crests and retains unchecked paths across delayed readbacks',{timeout:120000},async()=>{
  const port=process.env.GUNNERY_SEA_TEST_PORT||8138;
  const server=spawn(process.execPath,['server.mjs',String(port)],{cwd:new URL('..',import.meta.url),stdio:['ignore','pipe','inherit']});let browser;
  try{
    await once(server.stdout,'data');
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
    const page=await browser.newPage();await page.route('**/__gunnery-sea',route=>route.fulfill({contentType:'text/html',body:'<!doctype html>'}));await page.goto(`http://localhost:${port}/__gunnery-sea`);
    const result=await page.evaluate(async()=>{
      const {createGunnerySeaProbe}=await import('/js/gunnery-sea-probe.js'),{CASCADES}=await import('/js/wgsl/common.js');
      const device=await(await navigator.gpu.requestAdapter()).requestDevice(),errors=[],B=GPUBufferUsage,T=GPUTextureUsage;
      device.onuncapturederror=e=>errors.push(e.error.message);
      const frameValues=new Float32Array(96);frameValues.set([1/16,1/16,1/16,1/16,1/16,1/16],48);
      const frame=device.createBuffer({size:384,usage:B.UNIFORM|B.COPY_DST});device.queue.writeBuffer(frame,0,frameValues);
      const sea=device.createTexture({size:[16,1,CASCADES],format:'rgba16float',usage:T.TEXTURE_BINDING|T.COPY_DST});
      const sampler=device.createSampler({minFilter:'linear',magFilter:'linear',addressModeU:'repeat',addressModeV:'repeat'});
      const shader=async(code,label)=>{const m=device.createShaderModule({code,label});errors.push(...(await m.getCompilationInfo()).messages.filter(v=>v.type==='error').map(v=>v.message));if(errors.length)throw Error(errors.join('\n'));return m;};
      const computePipe=async(code,label)=>device.createComputePipelineAsync({layout:'auto',compute:{module:await shader(code,label),entryPoint:'main'}});
      let blocked=false,releaseGate=null;
      const createBuffer=device.createBuffer.bind(device);device.createBuffer=options=>{
        const b=createBuffer(options);if(options.label==='roundshot contact readback'){
          const map=b.mapAsync.bind(b);b.mapAsync=async(...args)=>{await map(...args);if(blocked)await new Promise(resolve=>releaseGate=resolve);};
        }return b;
      };
      const probe=await createGunnerySeaProbe({device,frameUBO:frame,seaView:sea.createView({dimension:'2d-array'}),seaSampler:sampler,shader,computePipe});
      let writes=0,dispatches=0;const write=device.queue.writeBuffer.bind(device.queue);device.queue.writeBuffer=(...args)=>{writes++;return write(...args);};
      const hits=[];
      async function idle(){for(let i=0;i<1000&&probe.pending;i++)await new Promise(resolve=>setTimeout(resolve,1));if(probe.pending)throw Error('Sea probe never completed');}
      function encode(p){const enc=device.createCommandEncoder(),encoded=probe.encode(enc,p,9999);if(encoded)dispatches++;device.queue.submit([enc.finish()]);probe.read(hit=>hits.push(hit));return encoded;}
      function seaRow(layer,{height=0,dx=0,crest=false}={}){
        const pixels=new Uint16Array(16*4);for(let i=0;i<16;i++)pixels.set([dx?0x3c00:0,crest?(i===4?0x4200:0):height?0x3c00:0,0,0],i*4);
        device.queue.writeTexture({texture:sea,origin:[0,0,layer]},pixels,{bytesPerRow:128},[16,1]);
      }
      for(let i=0;i<CASCADES;i++)seaRow(i);
      const idleEncoded=encode([]),idleWrites=writes;
      // A nonzero height in only the highest-frequency FFT band must count.
      seaRow(CASCADES-1,{height:1});
      const downward={id:1,radius:.1,position:[2,0,0],previous:[0,2,0],previousTime:2,time:3,history:[{position:[0,2,0],time:2},{position:[2,0,0],time:3}]};
      encode([downward]);await idle();const highBand=hits.splice(0)[0];
      probe.clear();seaRow(CASCADES-1,{height:0,crest:true});seaRow(0,{dx:1});
      // Both endpoints are above water. A 0.75m swept search must find the
      // one-texel crest, with inverse horizontal displacement moving it +1m.
      const crossing={id:2,radius:.1,position:[10,2,0],previous:[0,2,0],previousTime:10,time:11,history:[{position:[0,2,0],time:10},{position:[10,2,0],time:11}]};
      encode([crossing]);await idle();const narrowCrest=hits.splice(0)[0];
      probe.clear();blocked=true;
      const delayed={id:3,radius:.1,position:[1,2,0],previous:[0,2,0],previousTime:20,time:20.1,history:[{position:[0,2,0],time:20},{position:[1,2,0],time:20.1}]};
      encode([delayed]);for(let i=0;i<100&&!releaseGate;i++)await new Promise(resolve=>setTimeout(resolve,1));
      const beforePendingWrites=writes;
      Object.assign(delayed,{position:[10,2,0],previous:[9,2,0],previousTime:20.9,time:21,history:[{position:[9,2,0],time:20.9},{position:[10,2,0],time:21}]});
      const pendingEncoded=encode([delayed]),pendingWrites=writes-beforePendingWrites;
      blocked=false;releaseGate();releaseGate=null;await idle();
      encode([delayed]);await idle();const delayedCrest=hits.splice(0)[0];
      const deduplicated=!encode([delayed]);await idle();const duplicates=hits.length;
      // A reset while a hit map is pending must not apply the stale shot id to
      // a new scene which happens to reuse that id.
      probe.clear();blocked=true;encode([crossing]);for(let i=0;i<100&&!releaseGate;i++)await new Promise(resolve=>setTimeout(resolve,1));
      probe.clear();blocked=false;releaseGate();await idle();const staleHits=hits.length;
      const overflow=probe.overflow;probe.destroy();await device.queue.onSubmittedWorkDone();device.destroy();
      return {errors,idleEncoded,idleWrites,pendingEncoded,pendingWrites,highBand,narrowCrest,delayedCrest,deduplicated,duplicates,staleHits,dispatches,overflow};
    });
    assert.deepEqual(result.errors,[],JSON.stringify(result));assert.equal(result.idleEncoded,false);assert.equal(result.idleWrites,0);
    assert.equal(result.highBand.shotId,1);assert.ok(Math.abs(result.highBand.position[1]-1.1)<.0001,JSON.stringify(result));
    assert.ok(Math.abs(result.highBand.time-2.45)<.0001,JSON.stringify(result));assert.ok(Math.abs(result.highBand.surfacePosition[1]-1)<1e-5);
    for(const hit of [result.narrowCrest,result.delayedCrest]){
      // Native linear texture filters quantize subtexel weights; at this
      // deliberately sharp 3m/m crest that is up to ~12mm in sampled height.
      assert.ok(hit,JSON.stringify(result));assert.ok(Math.abs(hit.position[0]-5.1333333)<.002,JSON.stringify(result));
      assert.ok(Math.abs(hit.position[1]-hit.surfacePosition[1]-.1)<.012,JSON.stringify(result));
    }
    assert.ok(Math.abs(result.narrowCrest.time-10.5133333)<.0002,JSON.stringify(result));
    assert.ok(Math.abs(result.delayedCrest.time-20.5133333)<.0002,JSON.stringify(result));
    assert.equal(result.pendingEncoded,false);assert.equal(result.pendingWrites,0);assert.equal(result.deduplicated,true);assert.equal(result.duplicates,0);assert.equal(result.staleHits,0);assert.equal(result.overflow,0);
  }finally{await browser?.close();server.kill();}
});

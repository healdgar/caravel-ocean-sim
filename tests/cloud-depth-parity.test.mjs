// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {test} from 'node:test';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';

test('cloud depth target reuse preserves actual RGBA16 history through motion and resets',{timeout:180000},async t=>{
  const server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');let browser;
  try{
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'
      ?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']
      :['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
    const page=await browser.newPage();await page.route('**/__cloud-depth-parity',r=>r.fulfill({contentType:'text/html',body:'<!doctype html>'}));
    await page.goto('http://127.0.0.1:'+server.address().port+'/__cloud-depth-parity');
    const result=await page.evaluate(async()=>{
      const {createVolumetricClouds}=await import('/js/clouds.js');
      const {createReferenceVolumetricClouds}=await import('/tests/helpers/cloud-depth-reference.mjs');
      const {withCelestialFrame}=await import('/js/wgsl/celestial.js');
      const adapter=await navigator.gpu.requestAdapter();if(!adapter)throw Error('No WebGPU adapter');
      const device=await adapter.requestDevice(),errors=[];device.onuncapturederror=e=>errors.push(e.error.message);
      const B=GPUBufferUsage,T=GPUTextureUsage;
      const computePipe=async(code,label)=>{
        const module=device.createShaderModule({code:withCelestialFrame(code),label});
        const info=await module.getCompilationInfo();errors.push(...info.messages.filter(m=>m.type==='error').map(m=>label+': '+m.message));
        return device.createComputePipelineAsync({label,layout:'auto',compute:{module,entryPoint:'main'}});
      };
      const frameUBO=device.createBuffer({size:528,usage:B.UNIFORM|B.COPY_DST});
      const lut=()=>device.createTexture({size:[1,1],format:'rgba16float',usage:T.TEXTURE_BINDING|T.COPY_DST});
      const trans=lut(),sky=lut();
      const writeLut=(texture,values)=>device.queue.writeTexture({texture},new Uint16Array(values),{bytesPerRow:8},[1,1]);
      writeLut(trans,[0x3c00,0x3b00,0x3a00,0x3c00]);writeLut(sky,[0x3400,0x3600,0x3800,0x3c00]);
      const sampler=device.createSampler({minFilter:'linear',magFilter:'linear'});
      const options={device,frameUBO,transView:trans.createView(),skyView:sky.createView(),sampler,computePipe,fieldSize:[32,16,32]};
      // Independent density/light/history resources. The immutable inputs and
      // device are identical; neither renderer receives the other's output.
      const reference=await createReferenceVolumetricClouds(options),production=await createVolumetricClouds(options);
      const frame=new Float32Array(132),settings={clouds:0,cloudBase:1,cloudDepth:2,cloudDensity:1,cloudAnvil:.8,cloudQuality:.5,haze:3};
      frame.set([0,2,0,0],16);frame.set([0,1,0,14],32);frame.set([64,48,1/64,1/48],36);
      frame.set([1,0,20,0],56);frame.set([3,.01,0,0],72);frame[112]=1;
      function camera(direction){
        const length=Math.hypot(...direction),f=direction.map(v=>v/length);
        const rLength=Math.hypot(f[1],f[0]),r=[f[1]/rLength,-f[0]/rLength,0];
        const u=[r[1]*f[2],-r[0]*f[2],r[0]*f[1]-r[1]*f[0]],sx=.6,sy=.45;
        frame.set(new Float32Array(16),0);
        for(let c=0;c<3;c++){frame[c*4]=r[c]/sx;frame[c*4+1]=u[c]/sy;frame[c*4+3]=f[c];}
        frame[14]=.1;
        frame.set(r.map(v=>v*sx),20);frame.set(u.map(v=>v*sy),24);frame.set(f,28);
      }
      camera([0,1,0]);
      const half=bits=>{const e=(bits>>10)&31,m=bits&1023;return (bits&32768?-1:1)*(e===31?(m?NaN:Infinity):e?(1+m/1024)*2**(e-15):m*2**-24);};
      async function compareOutputs(a=reference.output,b=production.output){
        if(a.width!==b.width||a.height!==b.height)throw Error('Cloud target dimensions differ');
        const bytesPerRow=Math.ceil(a.width*8/256)*256,bytes=bytesPerRow*a.height;
        const read=device.createBuffer({size:bytes*2,usage:B.COPY_DST|B.MAP_READ});
        const enc=device.createCommandEncoder();
        enc.copyTextureToBuffer({texture:a},{buffer:read,bytesPerRow},[a.width,a.height]);
        enc.copyTextureToBuffer({texture:b},{buffer:read,bytesPerRow,offset:bytes},[b.width,b.height]);
        device.queue.submit([enc.finish()]);await read.mapAsync(GPUMapMode.READ);
        const mapped=read.getMappedRange(),raw=new Uint8Array(mapped),words=new Uint16Array(mapped);
        let differentBytes=0,nonFinite=0,sumAlpha=0,maxDifference=0;let firstDifference=null;
        for(let y=0;y<a.height;y++)for(let x=0;x<a.width;x++){
          const offset=y*bytesPerRow+x*8;
          for(let byte=0;byte<8;byte++)if(raw[offset+byte]!==raw[bytes+offset+byte])differentBytes++;
          for(let c=0;c<4;c++){
            const oldBits=words[offset/2+c],newBits=words[(bytes+offset)/2+c];
            const oldValue=half(oldBits),newValue=half(newBits);
            if(!Number.isFinite(oldValue)||!Number.isFinite(newValue))nonFinite++;
            maxDifference=Math.max(maxDifference,Math.abs(oldValue-newValue));
            if(c===3)sumAlpha+=newValue;
            if(oldBits!==newBits&&!firstDifference)firstDifference={x,y,channel:c,oldBits,newBits,oldValue,newValue};
          }
        }
        read.unmap();read.destroy();
        return {width:a.width,height:a.height,differentBytes,nonFinite,maxDifference,firstDifference,meanAlpha:sumAlpha/(a.width*a.height)};
      }
      const rows=[];let elapsed=0;
      async function advance(name,history,{dt=1/60,clear=false,cloudy=false}={}){
        elapsed+=dt;frame[19]+=dt;frame[70]++;device.queue.writeBuffer(frameUBO,0,frame);
        const referenceChanged=reference.update(frame,settings,dt),productionChanged=production.update(frame,settings,dt);
        const referenceHistory=reference.historyValid,productionHistory=production.historyValid;
        const enc=device.createCommandEncoder(),pass=enc.beginComputePass();reference.encode(pass);production.encode(pass);pass.end();device.queue.submit([enc.finish()]);
        rows.push({name,expectedHistory:history,referenceHistory,productionHistory,referenceChanged,productionChanged,clear,cloudy,...await compareOutputs()});
      }
      await advance('initial clear',false,{clear:true});await advance('clear history',true,{clear:true});
      settings.clouds=.9;await advance('coverage reset',false,{cloudy:true});
      for(let i=0;i<4;i++)await advance('alternating history '+i,true);
      // Same frame, fields, jitter and accumulated constant wind, but no prior
      // history. A visible difference proves the comparisons exercise temporal
      // depth acceptance rather than merely comparing identical raw ray output.
      const fresh=await createReferenceVolumetricClouds(options);fresh.update(frame,settings,elapsed);
      {const enc=device.createCommandEncoder(),pass=enc.beginComputePass();fresh.encode(pass);pass.end();device.queue.submit([enc.finish()]);}
      const historyEffect=await compareOutputs(fresh.output,reference.output);fresh.destroy();
      frame[16]+=10;frame[18]-=7;await advance('ordinary camera translation',true);
      camera([.18,1,.12]);await advance('camera rotation reprojection',true);
      // Wind is advected through history rather than invalidating the volume.
      frame.set([.6,.8,35,0],56);await advance('wind change',true,{dt:.1});await advance('long wind advection',true,{dt:12});
      settings.cloudDensity=1.8;await advance('optical density reset',false);await advance('dense history',true);
      frame.set([.7,.5,Math.sqrt(.26),14],32);await advance('sun direction reset',false);await advance('relit history',true);
      settings.clouds=.65;await advance('second coverage reset',false);
      settings.cloudBase=1.25;await advance('base reset',false);
      settings.cloudDepth=2.7;await advance('thickness reset',false);
      settings.cloudAnvil=.4;await advance('storm shape reset',false);
      settings.haze=6;frame[72]=6;await advance('haze reset',false);
      frame.set([96,64,1/96,1/64],36);await advance('resize',false);await advance('resized history',true);
      settings.cloudQuality=.8;await advance('quality resize',false);await advance('new quality history',true);
      frame.set([Math.sqrt(.75),-.5,0,14],32);frame.set([.2,.7,Math.sqrt(.47),.00004],96);frame[115]=1;
      writeLut(sky,[0,0,0,0x3c00]);await advance('moonlit night reset',false);await advance('moonlit history',true);
      frame[16]+=1000;await advance('camera teleport reset',false);await advance('teleported history',true);
      settings.clouds=0;await advance('clear reset after history',false,{clear:true});await advance('clear remains empty',true,{clear:true});
      frame.set([1,1,1,1],36);await advance('one pixel resize',false,{clear:true});
      frame.set([64,48,1/64,1/48],36);settings.cloudQuality=.5;await advance('restore size',false,{clear:true});
      settings.clouds=.9;await advance('restore night clouds',false);await advance('restored night history',true);
      await device.queue.onSubmittedWorkDone();reference.destroy();production.destroy();device.destroy();return {errors,rows,historyEffect};
    });
    assert.deepEqual(result.errors,[]);
    assert.equal(result.historyEffect.nonFinite,0,'history witness is finite');
    assert.ok(result.historyEffect.differentBytes>0,'history must affect actual cloud pixels, not only the CPU validity flag');
    for(const row of result.rows){
      assert.equal(row.differentBytes,0,'RGBA16 bytes: '+JSON.stringify(row));
      assert.equal(row.nonFinite,0,'finite cloud radiance: '+row.name);
      assert.equal(row.referenceHistory,row.expectedHistory,'reference history: '+row.name);
      assert.equal(row.productionHistory,row.referenceHistory,'production history: '+row.name);
      assert.equal(row.productionChanged,row.referenceChanged,'dirty state: '+row.name);
      if(row.clear)assert.equal(row.meanAlpha,0,'empty sky: '+row.name);
      if(row.cloudy)assert.ok(row.meanAlpha>.05,'nontrivial cloud field: '+JSON.stringify(row));
    }
    assert.ok(result.rows.some(row=>row.width===1&&row.height===1),'tiny target covered');
    assert.ok(new Set(result.rows.map(row=>row.width+'x'+row.height)).size>=4,'distinct size/quality targets covered');
    t.diagnostic(JSON.stringify(result.rows));
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});

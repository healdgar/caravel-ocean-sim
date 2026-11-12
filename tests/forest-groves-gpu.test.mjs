// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The forest behind Jamestown, some three kilometres inland, where the trees planted one by one have
// thinned to a scatter: the groves must close it over, and must do it on the GPU alone once the coast
// has loaded. (Lisbon's farmed country has too little wood for this: full-grown trees planted one by one
// stand all through it, and the groves there are only the canopy between them.)
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {test} from 'node:test';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';
import {coastalRegionStageURL} from '../js/landfall.js';

test('groves close the far woods on the actual GPU and cost the CPU no upload a frame',{timeout:240000},async t=>{
  const server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');let browser;
  try{
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'
      ?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
    const view=async groves=>{
      const page=await browser.newPage({viewport:{width:640,height:360}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
      await page.addInitScript(()=>{
        const r=window.groveAudit={frames:0,uploads:0,draws:0,errors:[],pipelines:[]};
        const request=GPUAdapter.prototype.requestDevice;GPUAdapter.prototype.requestDevice=async function(...args){const d=await request.apply(this,args);d.addEventListener('uncapturederror',e=>r.errors.push(e.error.message));return d;};
        const grove=resource=>resource?.label?.startsWith('forest grove');
        const write=GPUQueue.prototype.writeBuffer;GPUQueue.prototype.writeBuffer=function(buffer,...rest){if(grove(buffer))r.uploads++;return write.call(this,buffer,...rest);};
        const paint=GPUQueue.prototype.writeTexture;GPUQueue.prototype.writeTexture=function(target,...rest){if(grove(target.texture))r.uploads++;return paint.call(this,target,...rest);};
        const pipeline=GPUDevice.prototype.createRenderPipelineAsync;GPUDevice.prototype.createRenderPipelineAsync=function(desc){r.pipelines.push(desc.label);return pipeline.call(this,desc);};
        const pass=GPURenderPassEncoder.prototype,set=pass.setPipeline,draw=pass.drawIndexedIndirect,current=new WeakMap();
        pass.setPipeline=function(p){current.set(this,p.label);return set.call(this,p);};
        pass.drawIndexedIndirect=function(...args){if(current.get(this)==='forest groves')r.draws++;return draw.apply(this,args);};
        const texture=GPUCanvasContext.prototype.getCurrentTexture;GPUCanvasContext.prototype.getCurrentTexture=function(...args){r.frames++;return texture.apply(this,args);};
      });
      const url=coastalRegionStageURL('http://127.0.0.1:'+server.address().port+'/','jamestown','dock','clear',1650);
      for(const [key,value] of Object.entries({w:640,h:360,view:'free',prow:'0',cam:'1500,410,-9000,0,-25',realDEM:'off',clouds:'0',follower:'0',...(groves?{}:{forestGroves:'0'})}))url.searchParams.set(key,value);
      await page.goto(url.toString());
      await page.waitForFunction(()=>oceanStartup.state==='ready'||oceanStartup.state==='failed',undefined,{timeout:150000,polling:200});
      const settled=await page.evaluate(()=>groveAudit.frames);
      await page.waitForFunction(from=>groveAudit.frames>=from+40,settled,{timeout:60000,polling:100});
      const before=await page.evaluate(()=>({...groveAudit}));
      await page.waitForFunction(from=>groveAudit.frames>=from+40,before.frames,{timeout:60000,polling:100});
      const after=await page.evaluate(()=>({state:oceanStartup.state,error:document.querySelector('#err')?.textContent,...groveAudit}));
      // The lower corners of the picture, clear of the panels: ground and wood only.
      const picture=(await page.screenshot({clip:{x:0,y:250,width:640,height:110}})).toString('base64');
      const pixels=await page.evaluate(async data=>{
        const bitmap=await createImageBitmap(await (await fetch('data:image/png;base64,'+data)).blob()),canvas=new OffscreenCanvas(bitmap.width,bitmap.height),context=canvas.getContext('2d');
        context.drawImage(bitmap,0,0);return {width:bitmap.width,height:bitmap.height,data:Array.from(context.getImageData(0,0,bitmap.width,bitmap.height).data)};
      },picture);
      await page.close();
      return {before,after,errors,pixels};
    };
    const wooded=await view(true),bare=await view(false);
    t.diagnostic(JSON.stringify({wooded:wooded.after,bare:bare.after}));
    for(const run of [wooded,bare]){assert.equal(run.after.state,'ready',run.after.error);assert.deepEqual(run.errors,[]);assert.deepEqual(run.after.errors,[]);}
    assert.ok(wooded.after.pipelines.includes('forest groves'));assert.ok(!bare.after.pipelines.includes('forest groves'));
    // Seven levels of every section are drawn each frame, by counts the GPU wrote: nothing is read back.
    const frames=wooded.after.frames-wooded.before.frames,draws=wooded.after.draws-wooded.before.draws;
    assert.ok(draws>=frames*7,`${draws} grove draws in ${frames} frames`);assert.equal(draws%7,0);
    assert.equal(bare.after.draws,0);
    // With the camera still, JavaScript sends the groves nothing.
    assert.ok(wooded.before.uploads>0);assert.equal(wooded.after.uploads,wooded.before.uploads,'groves were uploaded to while nothing changed');
    // The far hills are closed over: much of the land looks different with the groves than without.
    assert.equal(wooded.pixels.data.length,bare.pixels.data.length);
    let changed=0,land=0;
    for(let y=0;y<wooded.pixels.height;y++)for(let x=0;x<wooded.pixels.width;x++){
      if(x>170&&x<470)continue;
      const i=(y*wooded.pixels.width+x)*4;land++;
      if(Math.max(Math.abs(wooded.pixels.data[i]-bare.pixels.data[i]),Math.abs(wooded.pixels.data[i+1]-bare.pixels.data[i+1]),Math.abs(wooded.pixels.data[i+2]-bare.pixels.data[i+2]))>14)changed++;
    }
    t.diagnostic(`groves change ${(changed/land*100).toFixed(1)}% of the land in view`);
    assert.ok(changed/land>.2,`groves change only ${(changed/land*100).toFixed(1)}% of the land in view`);
  }finally{await browser?.close();server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}
});

// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Lisbon's houses, churches, towers and gates: near the camera each must be drawn as its Cairn
// type, picked and counted on the GPU, with nothing sent from JavaScript while the camera is still.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {test} from 'node:test';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';
import {coastalRegionStageURL} from '../js/landfall.js';
import {CITY_BUILDING_TYPES} from '../js/old-world-buildings.js';

test('a city\'s near buildings are Cairn types drawn by the GPU\'s own count, its far ones blocks',{timeout:300000},async t=>{
  const server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');let browser;
  try{
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'
      ?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
    const view=async buildings=>{
      const page=await browser.newPage({viewport:{width:640,height:360}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
      await page.addInitScript(()=>{
        const r=window.cityAudit={frames:0,uploads:0,counts:0,typeDraws:0,blockDraws:0,blocks:0,errors:[],pipelines:[],meshes:0};
        const request=GPUAdapter.prototype.requestDevice;GPUAdapter.prototype.requestDevice=async function(...args){const d=await request.apply(this,args);d.addEventListener('uncapturederror',e=>r.errors.push(e.error.message));return d;};
        // Everything of the city's but the draw counts, which are zeroed each frame for the GPU to count up.
        const write=GPUQueue.prototype.writeBuffer;GPUQueue.prototype.writeBuffer=function(buffer,...rest){
          if(buffer?.label==='city buildings draws')r.counts++;else if(buffer?.label?.startsWith('city'))r.uploads++;
          return write.call(this,buffer,...rest);};
        const make=GPUDevice.prototype.createBuffer;GPUDevice.prototype.createBuffer=function(desc){if(desc.label?.startsWith('city type'))r.meshes++;return make.call(this,desc);};
        const pipeline=GPUDevice.prototype.createRenderPipelineAsync;GPUDevice.prototype.createRenderPipelineAsync=function(desc){r.pipelines.push(desc.label);return pipeline.call(this,desc);};
        const pass=GPURenderPassEncoder.prototype,set=pass.setPipeline,indirect=pass.drawIndirect,draw=pass.draw,current=new WeakMap();
        pass.setPipeline=function(p){current.set(this,p.label);return set.call(this,p);};
        pass.drawIndirect=function(...args){if(current.get(this)==='city buildings')r.typeDraws++;return indirect.apply(this,args);};
        pass.draw=function(vertices,instances,...rest){if(current.get(this)==='city blocks'){r.blockDraws++;r.blocks=instances;}return draw.call(this,vertices,instances,...rest);};
        const texture=GPUCanvasContext.prototype.getCurrentTexture;GPUCanvasContext.prototype.getCurrentTexture=function(...args){r.frames++;return texture.apply(this,args);};
      });
      const url=coastalRegionStageURL('http://127.0.0.1:'+server.address().port+'/','lisbon','dock','clear',1650);
      for(const [key,value] of Object.entries({w:640,h:360,view:'free',prow:'0',cam:'0,70,-6000,0,-16',realDEM:'off',clouds:'0',follower:'0',hud:'0',ui:'0',...(buildings?{}:{cityBuildings:'0'})}))url.searchParams.set(key,value);
      await page.goto(url.toString());
      await page.waitForFunction(()=>oceanStartup.state==='ready'||oceanStartup.state==='failed',undefined,{timeout:150000,polling:200});
      const settled=await page.evaluate(()=>cityAudit.frames);
      await page.waitForFunction(from=>cityAudit.frames>=from+40,settled,{timeout:60000,polling:100});
      const before=await page.evaluate(()=>({...cityAudit}));
      await page.waitForFunction(from=>cityAudit.frames>=from+40,before.frames,{timeout:60000,polling:100});
      const after=await page.evaluate(()=>({state:oceanStartup.state,error:document.querySelector('#err')?.textContent,...cityAudit}));
      // The town above the waterfront, clear of the prompt in the middle of the screen.
      const picture=(await page.screenshot({clip:{x:0,y:90,width:640,height:150}})).toString('base64');
      const pixels=await page.evaluate(async data=>{
        const bitmap=await createImageBitmap(await (await fetch('data:image/png;base64,'+data)).blob()),canvas=new OffscreenCanvas(bitmap.width,bitmap.height),context=canvas.getContext('2d');
        context.drawImage(bitmap,0,0);return {width:bitmap.width,height:bitmap.height,data:Array.from(context.getImageData(0,0,bitmap.width,bitmap.height).data)};
      },picture);
      await page.close();
      return {before,after,errors,pixels};
    };
    const typed=await view(true),plain=await view(false);
    t.diagnostic(JSON.stringify({typed:typed.after,plain:plain.after}));
    for(const run of [typed,plain]){
      assert.equal(run.after.state,'ready',run.after.error);assert.deepEqual(run.errors,[]);assert.deepEqual(run.after.errors,[]);
      assert.ok(run.after.pipelines.includes('city blocks')&&run.after.pipelines.includes('city shadow')&&run.after.pipelines.includes('city buildings'));
      // The whole plan is one draw of one unit mesh, thousands of blocks to the call.
      const frames=run.after.frames-run.before.frames;
      assert.ok(run.after.blockDraws-run.before.blockDraws>=frames,'the blocks are drawn every frame');
      assert.ok(run.after.blocks>4000,`blocks in the one draw: ${run.after.blocks}`);
    }
    // Each type standing in the town is one indirect draw a frame, its count written by the cull.
    const frames=typed.after.frames-typed.before.frames,draws=typed.after.typeDraws-typed.before.typeDraws;
    assert.equal(typed.after.meshes,CITY_BUILDING_TYPES.length,'every type compiled once');
    assert.ok(draws>=frames*8&&draws<=(frames+2)*CITY_BUILDING_TYPES.length,`${draws} type draws in ${frames} frames`);
    assert.equal(plain.after.typeDraws,0);assert.equal(plain.after.meshes,0);
    // With the camera still, JavaScript sends the city nothing but the zeroed counts.
    assert.ok(typed.before.uploads>0);
    assert.equal(typed.after.uploads,typed.before.uploads,'the city was uploaded to while nothing changed');
    assert.ok(typed.after.counts-typed.before.counts<=frames+2);
    assert.equal(plain.after.uploads,plain.before.uploads);
    // Close to, a Cairn house is not its block: eaves, chimneys, window frames and doors change the picture.
    assert.equal(typed.pixels.data.length,plain.pixels.data.length);
    let changed=0,roofs=0;const total=typed.pixels.width*typed.pixels.height;
    for(let i=0;i<total*4;i+=4){
      const [r,g,b]=[typed.pixels.data[i],typed.pixels.data[i+1],typed.pixels.data[i+2]];
      if(Math.max(Math.abs(r-plain.pixels.data[i]),Math.abs(g-plain.pixels.data[i+1]),Math.abs(b-plain.pixels.data[i+2]))>18)changed++;
      if(r>110&&r>g*1.25&&g>b*1.1)roofs++;
    }
    t.diagnostic(`types change ${(changed/total*100).toFixed(1)}% of the town in view; ${(roofs/total*100).toFixed(1)}% of it is tiled roof`);
    assert.ok(changed/total>.04,`types change only ${(changed/total*100).toFixed(1)}% of the town in view`);
    assert.ok(roofs/total>.08,`tiled roofs fill only ${(roofs/total*100).toFixed(1)}% of the view`);
  }finally{await browser?.close();server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}
});

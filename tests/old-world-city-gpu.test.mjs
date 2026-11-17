// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Lisbon's houses, churches, towers and gates, every one drawn through the one continuum (AGENTS.md rule 3): cut on
// the GPU into the city's lists and drawn by its indirect draws, with nothing sent from JavaScript while the camera
// is still, and the town's tiled roofs filling the view.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {test} from 'node:test';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';
import {coastalRegionStageURL} from '../js/landfall.js';

test('a city\'s buildings are cut and counted by the GPU through the one continuum, its roofs in view',{timeout:300000},async t=>{
  const server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');let browser;
  try{
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'
      ?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
    const page=await browser.newPage({viewport:{width:640,height:360}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.addInitScript(()=>{
      const r=window.cityAudit={frames:0,uploads:{},draws:0,errors:[],pipelines:[],buffers:[]};
      const request=GPUAdapter.prototype.requestDevice;GPUAdapter.prototype.requestDevice=async function(...args){const d=await request.apply(this,args);d.addEventListener('uncapturederror',e=>r.errors.push(e.error.message));return d;};
      const write=GPUQueue.prototype.writeBuffer;GPUQueue.prototype.writeBuffer=function(buffer,...rest){
        if(buffer?.label?.startsWith('city'))r.uploads[buffer.label]=(r.uploads[buffer.label]??0)+1;
        return write.call(this,buffer,...rest);};
      const make=GPUDevice.prototype.createBuffer;GPUDevice.prototype.createBuffer=function(desc){const b=make.call(this,desc);if(desc.label?.startsWith('city')){r.buffers.push(desc.label);if(desc.label==='city continuum draws'){r.drawsBuffer=b;r.device=this;}}return b;};
      const pipeline=GPUDevice.prototype.createRenderPipelineAsync;GPUDevice.prototype.createRenderPipelineAsync=function(desc){r.pipelines.push(desc.label);return pipeline.call(this,desc);};
      const pass=GPURenderPassEncoder.prototype,set=pass.setPipeline,indirect=pass.drawIndirect,current=new WeakMap();
      pass.setPipeline=function(p){current.set(this,p.label);return set.call(this,p);};
      pass.drawIndirect=function(...args){if(current.get(this)==='city continuum')r.draws++;return indirect.apply(this,args);};
      const texture=GPUCanvasContext.prototype.getCurrentTexture;GPUCanvasContext.prototype.getCurrentTexture=function(...args){r.frames++;return texture.apply(this,args);};
    });
    const url=coastalRegionStageURL('http://127.0.0.1:'+server.address().port+'/','lisbon','dock','clear',1650);
    for(const [key,value] of Object.entries({w:640,h:360,view:'free',prow:'0',cam:'-70,34,-6250,0,-24',realDEM:'off',clouds:'0',follower:'0',hud:'0',ui:'0'}))url.searchParams.set(key,value);
    await page.goto(url.toString());
    await page.waitForFunction(()=>oceanStartup.state==='ready'||oceanStartup.state==='failed',undefined,{timeout:150000,polling:200});
    const settled=await page.evaluate(()=>cityAudit.frames);
    await page.waitForFunction(from=>cityAudit.frames>=from+40,settled,{timeout:60000,polling:100});
    const before=await page.evaluate(()=>JSON.parse(JSON.stringify(cityAudit)));
    await page.waitForFunction(from=>cityAudit.frames>=from+40,before.frames,{timeout:60000,polling:100});
    const after=await page.evaluate(()=>({state:oceanStartup.state,error:document.querySelector('#err')?.textContent,census:window.oceanContinuumCensus?.latest??null,...JSON.parse(JSON.stringify(cityAudit))}));
    // The cut's own counts, read back: how many clusters, small clusters, far-body pieces and splats it listed.
    const listed=await page.evaluate(async()=>{
      const {device,drawsBuffer}=cityAudit,out=device.createBuffer({size:drawsBuffer.size,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST}),encoder=device.createCommandEncoder();
      encoder.copyBufferToBuffer(drawsBuffer,0,out,0,drawsBuffer.size);device.queue.submit([encoder.finish()]);
      await out.mapAsync(GPUMapMode.READ);const words=new Uint32Array(out.getMappedRange().slice(0));out.unmap();out.destroy();
      return [0,1,2,3,4].map(i=>words[i*4+1]);
    });
    // Over the roofs a little north of the quay, looking down into the town, clear of the prompt in the middle.
    const picture=(await page.screenshot({clip:{x:0,y:90,width:640,height:150}})).toString('base64');
    const pixels=await page.evaluate(async data=>{
      const bitmap=await createImageBitmap(await (await fetch('data:image/png;base64,'+data)).blob()),canvas=new OffscreenCanvas(bitmap.width,bitmap.height),context=canvas.getContext('2d');
      context.drawImage(bitmap,0,0);return {width:bitmap.width,height:bitmap.height,data:Array.from(context.getImageData(0,0,bitmap.width,bitmap.height).data)};
    },picture);
    t.diagnostic(JSON.stringify({frames:after.frames-before.frames,draws:after.draws-before.draws,uploads:after.uploads,census:after.census?.families?.city,listed}));
    assert.equal(after.state,'ready',after.error);assert.deepEqual(errors,[]);assert.deepEqual(after.errors,[]);
    // One pipeline for the view and one for the shadow map; nothing of the old blocks or per-type meshes.
    assert.ok(after.pipelines.includes('city continuum')&&after.pipelines.includes('city continuum shadow'),after.pipelines.join(', '));
    assert.ok(!after.pipelines.some(label=>label==='city blocks'||label==='city buildings'||label==='city shadow'),'the block and type tiers are retired');
    assert.ok(!after.buffers.some(label=>label.startsWith('city type')||label==='city blocks'),'no per-type mesh or block buffer is made');
    // Every building of the plan is in the cut: four indirect draws a frame, their counts written by the GPU.
    const frames=after.frames-before.frames,draws=after.draws-before.draws;
    assert.ok(draws>=4*(frames-2)&&draws<=4*(frames+2),`${draws} city draws in ${frames} frames`);
    assert.ok(after.census?.families?.city>0,'the city reaches the continuum census');
    // Over the quay, the houses below are their clusters, the town beyond its far bodies.
    assert.ok(listed[0]+listed[1]>0,`no clusters listed: ${listed}`);
    assert.ok(listed[2]>0,`no far body listed: ${listed}`);
    // With the camera still, JavaScript sends the city nothing but, at most, its view's few numbers.
    for(const [label,n] of Object.entries(after.uploads))if(label!=='city continuum view')assert.equal(n,before.uploads[label]??0,`${label} written while still`);
    assert.ok((after.uploads['city continuum view']??0)-(before.uploads['city continuum view']??0)<=frames+2);
    // Looked down on, the town is its tiled roofs, drawn by clusters, far bodies and splats alike.
    let roofs=0;const total=pixels.width*pixels.height;
    for(let i=0;i<total*4;i+=4){const [r,g,b]=[pixels.data[i],pixels.data[i+1],pixels.data[i+2]];if(r>110&&r>g*1.25&&g>b*1.1)roofs++;}
    t.diagnostic(`${(roofs/total*100).toFixed(1)}% of the town in view is tiled roof`);
    assert.ok(roofs/total>.08,`tiled roofs fill only ${(roofs/total*100).toFixed(1)}% of the view`);
    await page.screenshot({path:'shots/city-continuum-lisbon-dock.png'});
    await page.close();
  }finally{await browser?.close();server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}
});

// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// The real production island and assets, with scheduler.yield unavailable.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {test} from 'node:test';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';

test('packaged island reaches a real rendered frame without per-batch timer stalls, its forest the continuum alone',{timeout:120000},async t=>{
  const server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');let browser;
  try{
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
    const page=await browser.newPage({viewport:{width:640,height:480}}),errors=[];page.on('pageerror',e=>errors.push(e.message));
    await page.addInitScript(()=>{
      Object.defineProperty(globalThis,'scheduler',{value:undefined,configurable:true});
      const r=window.forestStartupAudit={timers:0,tasks:0,frames:0,uploads:{},buffers:{},errors:[],pipelines:[]},timer=setTimeout,Channel=MessageChannel;
      window.setTimeout=function(callback,ms,...args){if(ms===0)r.timers++;return timer.call(this,callback,ms,...args);};
      window.MessageChannel=class extends Channel{constructor(){super();r.tasks++;}};
      const request=GPUAdapter.prototype.requestDevice;GPUAdapter.prototype.requestDevice=async function(...args){const d=await request.apply(this,args);d.addEventListener('uncapturederror',e=>r.errors.push(e.error.message));return d;};
      const create=GPUDevice.prototype.createBuffer;GPUDevice.prototype.createBuffer=function(desc){if(desc.label?.startsWith('forest '))r.buffers[desc.label]=desc.size;return create.call(this,desc);};
      const write=GPUQueue.prototype.writeBuffer;GPUQueue.prototype.writeBuffer=function(buffer,offset,data,dataOffset=0,size){
        const bytes=(size??data.byteLength/(data.BYTES_PER_ELEMENT??1)-dataOffset)*(data.BYTES_PER_ELEMENT??1);
        if(buffer.label.startsWith('forest '))r.uploads[buffer.label]=(r.uploads[buffer.label]??0)+bytes;
        return write.call(this,buffer,offset,data,dataOffset,size);
      };
      const pipeline=GPUDevice.prototype.createRenderPipelineAsync;GPUDevice.prototype.createRenderPipelineAsync=function(desc){r.pipelines.push(desc.label);return pipeline.call(this,desc);};
      const texture=GPUCanvasContext.prototype.getCurrentTexture;GPUCanvasContext.prototype.getCurrentTexture=function(...args){r.frames++;return texture.apply(this,args);};
    });
    await page.goto('http://127.0.0.1:'+server.address().port+'/docs/index.html?landfall=approach&view=free&boat=0&follower=0&clouds=0&windSpeed=0&swellHs=0&w=640&h=480');
    await page.waitForFunction(()=>oceanStartup.state==='ready'||oceanStartup.state==='failed',undefined,{timeout:60000});
    const result=await page.evaluate(()=>({state:oceanStartup.state,error:document.querySelector('#err').textContent,ready:performance.getEntriesByName('ocean-startup-ready')[0]?.startTime,...forestStartupAudit}));
    t.diagnostic(JSON.stringify(result));
    assert.equal(result.state,'ready',result.error);assert.deepEqual(errors,[]);assert.deepEqual(result.errors,[]);assert.ok(result.frames>0);
    // Without scheduler.yield, a long check pauses for the page by a message task (tests/task-yield.test.mjs); a load
    // whose checks fit their budget, as the island's certified roots do, need not pause at all. Neither sleeps.
    assert.ok(result.timers<100,'validation must not sleep after every small batch');
    // Every tree is one type of the one continuum: the pack's own vertex and index streams never reach the GPU.
    for(const label of ['forest immutable prototype vertices','forest immutable prototype indices'])assert.equal(result.buffers[label],undefined,label);
    assert.equal(result.pipelines.some(label=>label?.startsWith('instanced forest')||label?.startsWith('forest clusters')||label?.startsWith('forest crowns')),false,'no forest pipelines of its own');
    // Its atlas uploads every byte exactly once, and its view is the one cut's.
    const atlas=Object.keys(result.buffers).find(label=>/^forest .*continuum atlas$/.test(label));
    assert.ok(result.buffers[atlas]>10000000,'the forest atlas');assert.equal(result.uploads[atlas],result.buffers[atlas],'the forest atlas uploads every byte exactly once');
    assert.ok(result.pipelines.includes('forestContinuum view'),'the forest draws through the one continuum\'s view');
  }finally{await browser?.close();server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}
});

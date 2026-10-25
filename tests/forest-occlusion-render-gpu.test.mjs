// Copyright (c) 2026 Six Cailloux, LLC. MIT. Root alone runs GPU checks.
// Compare complete production frames with exactly the same frozen clocks.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {mkdir,writeFile} from 'node:fs/promises';
import {test} from 'node:test';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';
function forestOcclusionFrameCapture(){
 const r=window.forestOcclusionFrame={callback:null,device:null,target:null,capture:false,image:null,errors:[],indirect:[],pipelineSources:[]};
 window.requestAnimationFrame=callback=>{r.callback=callback;return 1;};
 const request=GPUAdapter.prototype.requestDevice;GPUAdapter.prototype.requestDevice=async function(...args){const d=await request.apply(this,args);r.device=d;d.addEventListener('uncapturederror',e=>r.errors.push(e.error.message));d.lost.then(e=>r.lost=e.message);return d;};
 const module=GPUDevice.prototype.createShaderModule;GPUDevice.prototype.createShaderModule=function(desc){if(desc.label==='forest GPU cull and compact')r.pipelineSources.push(desc.code);return module.call(this,desc);};
 const buffer=GPUDevice.prototype.createBuffer;GPUDevice.prototype.createBuffer=function(desc){const inspect=desc.label==='forest GPU indirect draws',b=buffer.call(this,inspect?{...desc,usage:desc.usage|GPUBufferUsage.COPY_SRC}:desc);if(inspect)r.indirect.push(b);return b;};
 const texture=GPUCanvasContext.prototype.getCurrentTexture;GPUCanvasContext.prototype.getCurrentTexture=function(...args){r.target=texture.apply(this,args);return r.target;};
 const submit=GPUQueue.prototype.submit;GPUQueue.prototype.submit=function(commands){submit.call(this,commands);if(!r.capture||!r.target)return;r.capture=false;
  const target=r.target,row=Math.ceil(target.width*4/256)*256,read=r.device.createBuffer({size:row*target.height,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}),enc=r.device.createCommandEncoder();enc.copyTextureToBuffer({texture:target},{buffer:read,bytesPerRow:row},[target.width,target.height]);submit.call(this,[enc.finish()]);
  r.image=read.mapAsync(GPUMapMode.READ).then(()=>{const raw=new Uint8Array(read.getMappedRange()),pixels=new Uint8Array(target.width*target.height*4);for(let y=0;y<target.height;y++)pixels.set(raw.subarray(y*row,y*row+target.width*4),y*target.width*4);read.unmap();read.destroy();return pixels;});
 };
}
test('GPU terrain occlusion preserves full close-forest, shore, horizon and underwater frames',{timeout:600000},async t=>{
 const server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');let browser;
 const output=process.env.FOREST_OCCLUSION_OUTPUT; if(output)await mkdir(output,{recursive:true});
 try{
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
  const rows=[],scenes=[
   {name:'reported-close-view',w:'1920',h:'1080',cam:'-979.830347,366.080607,-5519.26402,29.742625,1.101069'},
   {name:'shore',w:'640',h:'360',cam:'-1750,6,-7000,112,1'},
   {name:'horizon',w:'640',h:'360',cam:'-1800,6,10500,6.2,1'},
   {name:'underwater',w:'640',h:'360',cam:'-1800,-4,-7000,112,4'},
  ];
  for(const scene of scenes){const captures=[];
   for(const reference of [true,false]){
    const page=await browser.newPage({viewport:{width:1280,height:720}}),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.addInitScript(forestOcclusionFrameCapture);
    const params=new URLSearchParams({landfall:'approach',view:'free',boat:'0',follower:'0',weather:'clear',skyMode:'manual',astroDate:'2026-10-21T00:00:00.000Z',astroRate:'0',windSpeed:'5.5',windDir:'118',fetchKm:'90',swellHs:'.65',swellDir:'94',swellLength:'120',swellSpread:'48',choppy:'1.25',sunElev:'32',sunAzim:'225',exposure:'1.35',haze:'.8',clouds:'.3',cloudBase:'1.2',cloudDepth:'1.8',cloudDensity:'1',cloudAnvil:'.05',cloudQuality:'.5',bloom:'.1',rain:'0',thunder:'0',ui:'0',resolution:'native',...scene,forestOcclusion:reference?'off':'on'});
    try{
     await page.goto('http://127.0.0.1:'+server.address().port+(process.env.FOREST_PACKAGE?'/docs/index.html':'/')+'?'+params);
     await page.waitForFunction(()=>typeof forestOcclusionFrame.callback==='function'||window.oceanStartup?.state==='failed',undefined,{timeout:180000,polling:50});
     const result=await page.evaluate(async()=>{
      const r=forestOcclusionFrame;if(!r.callback)throw Error(document.querySelector('#err').textContent);
      for(const now of[1000000,1000050,1000100,1000150]){r.capture=true;r.callback(now);await r.device.queue.onSubmittedWorkDone();await r.image;await new Promise(resolve=>setTimeout(resolve,0));}
      const source=r.indirect[0],read=r.device.createBuffer({size:source.size,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}),enc=r.device.createCommandEncoder();enc.copyBufferToBuffer(source,0,read,0,source.size);r.device.queue.submit([enc.finish()]);await read.mapAsync(GPUMapMode.READ);const commands=Array.from(new Uint32Array(read.getMappedRange()));read.unmap();read.destroy();
      return {pixels:Array.from(await r.image),commands,errors:r.errors,lost:r.lost,occlusion:r.pipelineSources.some(s=>s.includes('fn forestTerrainHidden(')),state:oceanStartup.state};
     });
     assert.deepEqual(errors,[]);assert.deepEqual(result.errors,[]);assert.equal(result.lost,undefined);assert.equal(result.state,'ready');assert.equal(result.occlusion,!reference);assert.ok(result.pixels.some((v,i)=>i%4!==3&&v>5));captures.push(result);
     if(output)await page.screenshot({path:output+'/'+scene.name+(reference?'-reference':'-occlusion')+'.png'});
    }finally{await page.close();}
   }
   let differences=0,maxError=0;for(let i=0;i<captures[0].pixels.length;i++){const error=Math.abs(captures[0].pixels[i]-captures[1].pixels[i]);if(error)differences++;maxError=Math.max(maxError,error);}
   const triangles=c=>c.reduce((sum,v,i)=>i%5===0?sum+v*c[i+1]/3:sum,0),row={name:scene.name,channels:captures[0].pixels.length,differences,maxError,referenceTriangles:triangles(captures[0].commands),occlusionTriangles:triangles(captures[1].commands)};rows.push(row);t.diagnostic(JSON.stringify(row));
   if(output)await writeFile(output+'/receipt.json',JSON.stringify(rows,null,2));assert.equal(differences,0,JSON.stringify(row));
   if(scene.name==='reported-close-view'){assert.ok(row.occlusionTriangles<row.referenceTriangles*.9,'actual native indirect work decreases, without changing pixels');assert.ok(row.occlusionTriangles<=6000000,'multi-tier stand replacement keeps close-canopy indirect triangles <= 6M');}
  }
 }finally{await browser?.close();server.closeAllConnections?.();await new Promise(r=>server.close(r));}
});

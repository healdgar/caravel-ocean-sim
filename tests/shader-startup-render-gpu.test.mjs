// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Render the production Pages bundle through its actual canvas, with identical
// simulation timestamps. Compare optimized versus full, unpruned WGSL.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {test} from 'node:test';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';

function captureStartupShaders(){
  const r=window.shaderStartupAudit={callback:null,device:null,target:null,captureFrame:false,image:null,errors:[]};
  window.requestAnimationFrame=callback=>{r.callback=callback;return 1;};
  const request=GPUAdapter.prototype.requestDevice;GPUAdapter.prototype.requestDevice=async function(...args){const d=await request.apply(this,args);r.device=d;d.addEventListener('uncapturederror',e=>r.errors.push(e.error.message));return d;};
  const configure=GPUCanvasContext.prototype.configure;GPUCanvasContext.prototype.configure=function(desc){r.format=desc.format;return configure.call(this,desc);};
  const texture=GPUCanvasContext.prototype.getCurrentTexture;GPUCanvasContext.prototype.getCurrentTexture=function(...args){r.target=texture.apply(this,args);return r.target;};
  const submit=GPUQueue.prototype.submit;GPUQueue.prototype.submit=function(commands){
    submit.call(this,commands);if(!r.captureFrame||!r.target)return;r.captureFrame=false;
    const target=r.target,row=Math.ceil(target.width*4/256)*256,buffer=r.device.createBuffer({size:row*target.height,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}),encoder=r.device.createCommandEncoder();
    encoder.copyTextureToBuffer({texture:target},{buffer,bytesPerRow:row},[target.width,target.height]);submit.call(this,[encoder.finish()]);
    r.image=buffer.mapAsync(GPUMapMode.READ).then(()=>{
      const raw=new Uint8Array(buffer.getMappedRange()),pixels=new Uint8Array(target.width*target.height*4);
      for(let y=0;y<target.height;y++)pixels.set(raw.subarray(y*row,y*row+target.width*4),y*target.width*4);
      buffer.unmap();buffer.destroy();return pixels;
    });
  };
}
test('shader pruning and active-fleet hull compilation preserve actual rendered daylight, night, weather and underwater pixels',{timeout:600000},async t=>{
  const server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');let browser;
  try{
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
    const scenes=[{name:'nina',ship:'nina'},{name:'victory',ship:'victory'},{name:'flying-cloud',ship:'flying-cloud'},
      {name:'mixed',ship:'nina',fleet:'victory,flying-cloud,gipsy-moth-iv'},
      {name:'weather',ship:'victory',clouds:'.85',rain:'1',thunder:'0',windSpeed:'18',swellHs:'4'},
      {name:'moonlight',ship:'nina',skyMode:'astronomy',astroDate:'2024-01-26T04:00:00Z',astroRate:'0'},
      {name:'underwater',ship:'victory',view:'free',cam:'-35,-4,0,90,0'}],results=[];
    for(const scene of scenes){
      const {name,...values}=scene,images=[];
      for(const reference of [true,false]){
        const page=await browser.newPage({viewport:{width:384,height:256}}),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.addInitScript(captureStartupShaders);
        try{
          const qs=new URLSearchParams({view:'ship',boat:'1',fleet:'',boatHeading:'0',boatSpeed:'0',propulsion:'sail',sunElev:'30',sunAzim:'110',windSpeed:'7',windDir:'65',swellHs:'.5',clouds:'0',ui:'0',w:'384',h:'256',astroDate:'2026-10-21T16:00:00Z',astroRate:'0',...values,...(reference?{shaderModels:'all',shaderPrune:'off'}:{})});
          await page.goto('http://127.0.0.1:'+server.address().port+'/docs/index.html?'+qs);
          try{await page.waitForFunction(()=>typeof shaderStartupAudit.callback==='function'||oceanStartup.state==='failed',undefined,{timeout:180000,polling:50});}
          catch(error){t.diagnostic(JSON.stringify({name,reference,errors,state:await page.evaluate(()=>({state:window.oceanStartup?.state,stage:document.querySelector('#ocean-startup-stage')?.textContent,error:document.querySelector('#err')?.textContent}))}));throw error;}
          const result=await page.evaluate(async()=>{
            const r=shaderStartupAudit;if(typeof r.callback!=='function')throw Error(document.querySelector('#err').textContent);
            for(const now of [1000000,1000050,1000100]){r.captureFrame=true;r.callback(now);await r.device.queue.onSubmittedWorkDone();await r.image;await new Promise(resolve=>setTimeout(resolve,0));}
            return {pixels:Array.from(await r.image),state:oceanStartup.state,errors:r.errors};
          });
          assert.equal(result.state,'ready');assert.deepEqual(errors,[]);assert.deepEqual(result.errors,[]);assert.ok(result.pixels.some((v,i)=>i%4!==3&&v>5),name+' has actual visible pixels');images.push(result.pixels);
        }finally{await page.close();}
      }
      let differences=0,maxError=0;for(let i=0;i<images[0].length;i++){const error=Math.abs(images[0][i]-images[1][i]);if(error)differences++;maxError=Math.max(maxError,error);}
      const row={name,channels:images[0].length,differences,maxError};results.push(row);assert.equal(maxError,0,JSON.stringify(row));
    }
    t.diagnostic(JSON.stringify(results));
  }finally{await browser?.close();server.closeAllConnections?.();await new Promise(resolve=>server.close(resolve));}
});

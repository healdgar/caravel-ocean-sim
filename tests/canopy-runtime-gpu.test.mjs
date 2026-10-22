// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Actual modular/Pages startups and optional pack failure; root runs checks.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import {before,after,test} from 'node:test';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';
import {canopyInspectionURL} from '../js/canopy-scenery.js';

let server,browser,origin;
before(async()=>{
  server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');origin='http://127.0.0.1:'+server.address().port;
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'
    ?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
});
after(async()=>{await browser?.close();if(server)await new Promise(resolve=>server.close(resolve));});
function instrumentCanopyRuntime(){
  const r=window.canopyRuntimeGPU={callback:null,device:null,now:null,errors:[],lost:null,buffers:[],draws:{},treeWrites:{},target:null};
  window.requestAnimationFrame=callback=>{r.callback=callback;return 1;};
  const request=GPUAdapter.prototype.requestDevice;GPUAdapter.prototype.requestDevice=async function(...args){const device=await request.apply(this,args);r.device=device;device.addEventListener('uncapturederror',event=>r.errors.push(event.error.message));device.lost.then(info=>r.lost=info.message);return device;};
  const create=GPUDevice.prototype.createBuffer;GPUDevice.prototype.createBuffer=function(desc){const buffer=create.call(this,desc);r.buffers.push({label:desc.label||'',size:desc.size});return buffer;};
  const write=GPUQueue.prototype.writeBuffer;GPUQueue.prototype.writeBuffer=function(buffer,offset,data,...rest){
    if(/^tree instances /.test(buffer.label)&&offset===0&&data instanceof Float32Array)r.treeWrites[buffer.label]=Array.from(data);
    return write.call(this,buffer,offset,data,...rest);
  };
  const labels=new WeakMap(),set=GPURenderPassEncoder.prototype.setPipeline;GPURenderPassEncoder.prototype.setPipeline=function(pipeline){labels.set(this,pipeline.label);return set.call(this,pipeline);};
  const draw=GPURenderPassEncoder.prototype.draw;GPURenderPassEncoder.prototype.draw=function(vertices,instances=1,...rest){const label=labels.get(this);r.draws[label]??={vertices:0,instances:0};r.draws[label].vertices+=vertices*instances;r.draws[label].instances+=instances;return draw.call(this,vertices,instances,...rest);};
  const configs=new WeakMap(),configure=GPUCanvasContext.prototype.configure;GPUCanvasContext.prototype.configure=function(desc){configs.set(this,desc);return configure.call(this,desc);};
  GPUCanvasContext.prototype.getCurrentTexture=function(){const desc=configs.get(this),width=this.canvas.width,height=this.canvas.height;if(!r.target||r.target.width!==width||r.target.height!==height){r.target?.destroy();r.target=desc.device.createTexture({label:'canopy runtime composite',size:[width,height],format:desc.format,usage:desc.usage|GPUTextureUsage.COPY_SRC});}return r.target;};
  r.image=async()=>{
    const texture=r.target,row=Math.ceil(texture.width*4/256)*256,read=r.device.createBuffer({size:row*texture.height,usage:GPUBufferUsage.MAP_READ|GPUBufferUsage.COPY_DST}),encoder=r.device.createCommandEncoder();encoder.copyTextureToBuffer({texture},{buffer:read,bytesPerRow:row},[texture.width,texture.height]);r.device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);
    const data=new Uint8Array(read.getMappedRange());let nonblack=0;for(let y=0;y<texture.height;y++)for(let x=0;x<texture.width;x++){const i=y*row+x*4;if(Math.max(data[i],data[i+1],data[i+2])>2)nonblack++;}read.unmap();read.destroy();return {nonblack,pixels:texture.width*texture.height};
  };
}
async function openCanopyRuntime(url,{corrupt=false}={}){
  const page=await browser.newPage({viewport:{width:600,height:420}}),requests=[],errors=[];
  page.on('request',request=>{if(request.url().includes('/assets/canopy-scenery/'))requests.push(request.url());});page.on('pageerror',e=>errors.push(e.message));
  page.on('console',m=>{if(/init failed|GPU error:|Shader compile error/i.test(m.text()))errors.push(m.text());});
  if(corrupt)await page.route('**/assets/canopy-scenery/**/near.bin',async route=>{const response=await route.fetch(),bytes=Buffer.from(await response.body());assert.ok(bytes.length>100);bytes[100]^=1;await route.fulfill({response,body:bytes});});
  await page.addInitScript(instrumentCanopyRuntime);await page.goto(url);
  await page.waitForFunction(()=>canopyRuntimeGPU.callback||window.oceanStartup?.state==='failed'||document.querySelector('#err')?.textContent,undefined,{polling:100,timeout:180000});
  assert.equal(await page.locator('#err').textContent(),'',errors.join('\n'));
  for(let i=0;i<6;i++)await page.evaluate(async()=>{const r=canopyRuntimeGPU,callback=r.callback;if(typeof callback!=='function')throw Error('Missing production RAF');r.callback=null;r.draws={};r.now=(r.now??performance.now())+50;callback(r.now);await r.device.queue.onSubmittedWorkDone();await new Promise(resolve=>setTimeout(resolve,0));});
  const receipt=await page.evaluate(async()=>({startup:window.oceanStartup?.state,errors:canopyRuntimeGPU.errors,lost:canopyRuntimeGPU.lost,buffers:canopyRuntimeGPU.buffers.filter(b=>b.label.startsWith('imported canopy ')),draws:canopyRuntimeGPU.draws,trees:canopyRuntimeGPU.treeWrites,image:await canopyRuntimeGPU.image()}));
  assert.equal(receipt.startup,'ready');assert.deepEqual(receipt.errors,[]);assert.equal(receipt.lost,null);assert.deepEqual(errors,[]);assert.ok(receipt.image.nonblack>receipt.image.pixels*.1);
  return {page,requests,receipt};
}
function canopyRuntimeURL(path,params={}){return origin+path+'?'+new URLSearchParams({ship:'nina',follower:'0',boat:'0',view:'free',clouds:'0',windSpeed:'0',swellHs:'0',sunElev:'35',w:'160',h:'108',...params});}

test('open-ocean startup defers every optional imported canopy asset',{timeout:240000},async()=>{
  const scene=await openCanopyRuntime(canopyRuntimeURL('/'));
  try{assert.deepEqual(scene.requests,[]);assert.deepEqual(scene.receipt.buffers,[]);}finally{await scene.page.close();}
});

for(const path of ['/','/docs/index.html'])test(`${path} actual landfall draws the source pack through dedicated opaque and cutout pipelines`,{timeout:240000},async()=>{
  const manifest=JSON.parse(await readFile(new URL('../assets/canopy-scenery/saba/manifest.json',import.meta.url),'utf8')),url=canopyInspectionURL(canopyRuntimeURL(path),manifest),scene=await openCanopyRuntime(url);
  try{
    assert.equal(manifest.format,'waterworld.canopy-runtime');assert.equal(manifest.version,1);assert.equal(manifest.vertexLayout.strideBytes,52);
    // The packaged build addresses these exact assets by a 16-hex content
    // digest. Modular source uses the original filenames; query strings do
    // not change either filename contract or the production loader's SHA gate.
    const hash=path==='/docs/index.html'?'\\.[a-f0-9]{16}':'',requested=(name,extension)=>scene.requests.some(url=>new RegExp('/'+name+hash+'\\.'+extension+'$').test(new URL(url).pathname));
    assert.ok(requested('manifest','json'));for(const name of ['near','leaf','far'])assert.ok(requested(name,'bin'));
    assert.deepEqual(scene.receipt.buffers.map(b=>b.label).sort(),['imported canopy far','imported canopy leaf','imported canopy near']);
    assert.ok(scene.receipt.draws['imported canopy canopyOpaqueFS']?.vertices>0,'source detailed wood really draws');assert.ok(scene.receipt.draws['imported canopy canopyLeafFS']?.vertices>0,'source native foliage really draws');
  }finally{await scene.page.close();}
});

test('a corrupt optional canopy pack preserves the exact procedural instance uploads of explicit off mode',{timeout:360000},async()=>{
  const url=canopyRuntimeURL('/',{landfall:'approach'}),off=await openCanopyRuntime(url+'&canopy=off');let failed;
  try{
    failed=await openCanopyRuntime(url,{corrupt:true});assert.deepEqual(off.requests,[]);assert.ok(failed.requests.some(url=>url.endsWith('/near.bin')));
    assert.deepEqual(off.receipt.buffers,[]);assert.deepEqual(failed.receipt.buffers,[],'failed receipt cannot suppress original roots then allocate a partial imported renderer');
    assert.deepEqual(failed.receipt.trees,off.receipt.trees,'all visible procedural root/scale/species bytes match the deterministic fallback');
    const legacy=Object.entries(off.receipt.draws).filter(([label])=>/^island (trees|canopy and wood)$/.test(label)).reduce((sum,[,draw])=>sum+draw.instances,0);
    assert.ok(legacy>0,'the comparison includes actual procedural vegetation draws');
  }finally{await off.page.close();await failed?.page.close();}
});

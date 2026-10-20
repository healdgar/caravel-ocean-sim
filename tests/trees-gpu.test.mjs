// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {readFile} from 'node:fs/promises';
import {after,before,test} from 'node:test';
import {chromium} from 'playwright';

const port=process.env.TREES_TEST_PORT||8110,origin=`http://localhost:${port}`;
let server,browser;
before(async()=>{
  server=spawn(process.execPath,['server.mjs',String(port)],{cwd:new URL('..',import.meta.url),stdio:['ignore','pipe','inherit']});
  await Promise.race([once(server.stdout,'data'),once(server,'exit').then(([code])=>{throw Error('Tree test server exited '+code);})]);
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,
    args:process.env.WEBGPU_BACKEND==='metal'?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
});
after(async()=>{await browser?.close();server?.kill();});

function instrumentTrees(){
  window.treeCheck={callback:null,errors:[],render:{},pipelines:[],device:null,target:null,hideTrees:false,leafUploads:[]};
  window.requestAnimationFrame=callback=>{treeCheck.callback=callback;return 1;};
  const request=GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice=async function(...args){
    const device=await request.apply(this,args);treeCheck.device=device;
    device.addEventListener('uncapturederror',e=>treeCheck.errors.push(e.error.message));return device;
  };
  const createPipeline=GPUDevice.prototype.createRenderPipelineAsync;
  GPUDevice.prototype.createRenderPipelineAsync=function(desc){
    if(desc.label==='island trees')treeCheck.pipelines.push({samples:desc.multisample?.count,alphaCoverage:desc.multisample?.alphaToCoverageEnabled});
    return createPipeline.call(this,desc);
  };
  const copyImage=GPUQueue.prototype.copyExternalImageToTexture;
  GPUQueue.prototype.copyExternalImageToTexture=function(source,destination,...args){
    if(destination.texture.label==='procedural twig and leaf cutouts')treeCheck.leafUploads.push([source.source.width,source.source.height]);
    return copyImage.call(this,source,destination,...args);
  };
  const configurations=new WeakMap(),configure=GPUCanvasContext.prototype.configure;
  GPUCanvasContext.prototype.configure=function(desc){configurations.set(this,desc);return configure.call(this,desc);};
  GPUCanvasContext.prototype.getCurrentTexture=function(){
    const desc=configurations.get(this),{width,height}=this.canvas;
    if(!treeCheck.target||treeCheck.target.width!==width||treeCheck.target.height!==height){
      treeCheck.target?.destroy();treeCheck.target=desc.device.createTexture({size:[width,height],format:desc.format,usage:desc.usage|GPUTextureUsage.COPY_SRC});
    }
    treeCheck.format=desc.format;return treeCheck.target;
  };
  const labels=new WeakMap(),setPipeline=GPURenderPassEncoder.prototype.setPipeline,draw=GPURenderPassEncoder.prototype.draw;
  GPURenderPassEncoder.prototype.setPipeline=function(pipeline){
    labels.set(this,pipeline.label);treeCheck.render[pipeline.label]=(treeCheck.render[pipeline.label]||0)+1;return setPipeline.call(this,pipeline);
  };
  GPURenderPassEncoder.prototype.draw=function(...args){
    if(labels.get(this)==='island trees'&&treeCheck.hideTrees)return;
    return draw.apply(this,args);
  };
}

async function ready(page,url){
  await page.goto(url);
  await page.waitForFunction(()=>treeCheck.callback||treeCheck.startupFailure||document.querySelector('#err')?.textContent,undefined,{polling:100,timeout:90000});
  assert.equal(await page.locator('#err').textContent(),'');
  assert.equal(await page.evaluate(()=>typeof treeCheck.callback),'function');
}
async function frame(page){
  const result=await page.evaluate(async()=>{
    const callback=treeCheck.callback;treeCheck.callback=null;treeCheck.render={};callback(1000);
    await treeCheck.device.queue.onSubmittedWorkDone();return {errors:treeCheck.errors,render:treeCheck.render,pipelines:treeCheck.pipelines,leafUploads:treeCheck.leafUploads};
  });
  assert.deepEqual(result.errors,[]);return result;
}
function errorsFor(page){
  const errors=[];page.on('pageerror',e=>errors.push(e.message));
  page.on('console',msg=>{if(msg.text().includes('init failed')){errors.push(msg.text());page.evaluate(message=>{treeCheck.startupFailure=message;},msg.text()).catch(()=>{});}});
  return errors;
}

async function coverage(page,baseline=false){
  return page.evaluate(async baseline=>{
    const {device,target}=treeCheck,W=target.width,H=target.height,row=Math.ceil(W*4/256)*256;
    const read=device.createBuffer({size:row*H,usage:GPUBufferUsage.COPY_DST|GPUBufferUsage.MAP_READ}),enc=device.createCommandEncoder();
    enc.copyTextureToBuffer({texture:target},{buffer:read,bytesPerRow:row},[W,H]);device.queue.submit([enc.finish()]);await read.mapAsync(GPUMapMode.READ);
    const data=new Uint8Array(read.getMappedRange()).slice();read.unmap();read.destroy();
    if(baseline){treeCheck.baseline=data;return null;}
    const original=treeCheck.baseline,bgra=treeCheck.format.startsWith('bgra'),leafMask=new Uint8Array(W*H),treeMask=new Uint8Array(W*H);
    let leaves=0,wood=0,minX=W,minY=H,maxX=-1,maxY=-1;
    for(let y=0;y<H;y++)for(let x=0;x<W;x++){
      const i=y*row+x*4,p=y*W+x,difference=Math.abs(data[i]-original[i])+Math.abs(data[i+1]-original[i+1])+Math.abs(data[i+2]-original[i+2]);
      if(difference<18)continue;
      treeMask[p]=1;
      const r=data[i+(bgra?2:0)],g=data[i+1],b=data[i+(bgra?0:2)];
      if(g>r*1.05&&g>b*1.03){leafMask[p]=1;leaves++;minX=Math.min(minX,x);maxX=Math.max(maxX,x);minY=Math.min(minY,y);maxY=Math.max(maxY,y);}
      else wood++;
    }
    let interior=0,gaps=0;
    if(leaves){
      const insetX=Math.round((maxX-minX)*.18),insetY=Math.round((maxY-minY)*.18);
      for(let y=minY+insetY;y<=maxY-insetY;y++)for(let x=minX+insetX;x<=maxX-insetX;x++){
        interior++;if(!treeMask[y*W+x])gaps++;
      }
    }
    const bounds=[minX,minY,maxX,maxY],area=(maxX-minX+1)*(maxY-minY+1);
    return {leaves,wood,bounds,density:leaves/area,gaps:gaps/Math.max(1,interior),width:maxX-minX+1,height:maxY-minY+1};
  },baseline);
}

test('the production tree renderer keeps a full, perforated canopy through all distance LODs',{timeout:240000},async t=>{
  const terrain=await readFile(new URL('../js/terrain.js',import.meta.url),'utf8'),main=await readFile(new URL('../js/main.js',import.meta.url),'utf8');
  const treeMarker='trees=islandVegetation(heights,biome);',geometryMarker='treeGeometry(variant,lod)',groundMarker='pass.drawIndexed(mesh.indices.length);',cameraMarker='  const param = (key, fallback, min, max) => {';
  for(const marker of [treeMarker,geometryMarker,groundMarker])assert.ok(terrain.includes(marker),'tree fixture marker '+marker);
  assert.ok(main.includes(cameraMarker));
  // Keep one original, unmodified seeded instance. Suppressing terrain isolates
  // its true silhouette against the same production sky, lighting and tonemap.
  const geometryFixture=`(()=>{
    const data=treeGeometry(variant,Number(new URL(location.href).searchParams.get('treeTestLod')));
    if(!new URL(location.href).searchParams.has('treeTestSparse'))return data;
    const sparse=[];let leaf=0;
    for(let i=0;i<data.length;i+=TREE_VERTEX_FLOATS*6){
      if(data[i+6]!==2||leaf++%8===0)sparse.push(...data.subarray(i,i+TREE_VERTEX_FLOATS*6));
    }
    return new Float32Array(sparse);
  })()`;
  const fixture=terrain.replace(treeMarker,'trees=islandVegetation(heights,biome).slice(0,8);window.treeCheck.instance=Array.from(trees);')
    .replace(geometryMarker,geometryFixture)
    .replace(groundMarker,'');
  const results=[];
  for(const lod of [0,1,2,'sparse']){
    const page=await browser.newPage({viewport:{width:384,height:384}}),errors=errorsFor(page);let textureLoaded=false;
    page.on('response',response=>{if(new URL(response.url()).pathname.endsWith('/assets/tree-foliage.png')&&response.status()===200)textureLoaded=true;});
    try{
      await page.addInitScript(instrumentTrees);
      await page.route('**/js/terrain.js',route=>route.fulfill({contentType:'text/javascript',body:fixture}));
      await page.route('**/js/main.js',route=>route.fulfill({contentType:'text/javascript',body:main.replace(cameraMarker,'  window.treeCheck.camera=cam;\n'+cameraMarker)}));
      await ready(page,`${origin}/?landfall=coast&view=free&prow=0&follower=0&sunElev=55&sunAzim=155&clouds=0&windSpeed=0&swellHs=0&fov=45&w=384&h=384&treeTestLod=${lod==='sparse'?'2&treeTestSparse=1':lod}`);
      await page.evaluate(()=>{
        const t=treeCheck.instance;Object.assign(treeCheck.camera,{x:t[0],y:t[1]+t[4]*.55,z:t[2]+t[4]*2.6,yaw:0,pitch:0});treeCheck.hideTrees=true;
      });
      await frame(page);await frame(page);await coverage(page,true);
      await page.evaluate(()=>{treeCheck.hideTrees=false;});const rendered=await frame(page),pixels=await coverage(page);
      assert.ok(rendered.render['island trees']>0);assert.deepEqual(rendered.pipelines,[{samples:4,alphaCoverage:true}]);
      assert.equal(textureLoaded,true,'production leaf texture was fetched');assert.deepEqual(errors,[]);
      if(lod==='sparse'){
        assert.ok(pixels.density<.22,'the density gate must reject a sparse branch scaffold: '+JSON.stringify(pixels));
        t.diagnostic('Rejected sparse canopy: '+JSON.stringify(pixels));continue;
      }
      assert.ok(pixels.leaves>1000,`LOD ${lod} needs visible foliage: ${JSON.stringify(pixels)}`);
      assert.ok(pixels.density>.22&&pixels.density<.92,`LOD ${lod} must form a crown while retaining leaf gaps: ${JSON.stringify(pixels)}`);
      assert.ok(pixels.gaps>.03&&pixels.gaps<.75,`LOD ${lod} must expose sky between leaves without a bare scaffold: ${JSON.stringify(pixels)}`);
      results.push(pixels);
    }finally{await page.close();}
  }
  const near=results[2];
  for(const [lod,pixels] of results.entries()){
    assert.ok(pixels.leaves>near.leaves*.6&&pixels.leaves<near.leaves*1.6,`LOD ${lod} changes foliage coverage excessively: ${JSON.stringify(results)}`);
    assert.ok(Math.abs(pixels.width/near.width-1)<.18&&Math.abs(pixels.height/near.height-1)<.18,`LOD ${lod} changes the visible tree extent: ${JSON.stringify(results)}`);
  }
  t.diagnostic('Production canopy pixels by LOD: '+JSON.stringify(results));
});

for(const entry of ['ocean.html','ocean.min.html','docs/index.html'])test(`procedural landfall trees start and render from ${entry}`,{timeout:120000},async()=>{
  const page=await browser.newPage({viewport:{width:480,height:360}}),errors=errorsFor(page);
  try{
    await page.addInitScript(instrumentTrees);
    await ready(page,`${origin}/${entry}?landfall=coast&view=free&prow=0&follower=0&sunElev=45&clouds=0&w=144&h=108`);
    const rendered=await frame(page);assert.ok(rendered.render['island trees']>0);assert.ok(rendered.render.island>0);assert.equal(rendered.render.ocean,1);
    assert.deepEqual(rendered.pipelines,[{samples:4,alphaCoverage:true}]);assert.deepEqual(rendered.leafUploads,[[1024,1024]],'standalone bundle uploads its embedded leaf atlas');assert.deepEqual(errors,[]);
  }finally{await page.close();}
});

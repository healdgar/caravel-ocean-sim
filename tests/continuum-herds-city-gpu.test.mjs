// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Herds and the shared scenery cull on the one continuum core (AGENTS.md rule 3, items 5 and 7): the herd
// pipelines build on the GPU, a herd's cut follows the scene's pixel-error scalar through its uniform, both sides
// of its mesh-to-splat handoff carry the same share and seed, and the city continuum's draws reach the census.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {test} from 'node:test';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';
import {CONTINUUM_SPLAT_BAND_PIXELS,CONTINUUM_SPLAT_PIXELS} from '../js/continuum-core.js';

test('herds cut by the scene scalar with paired handoffs, and the city continuum counts into the continuum census',{timeout:180000},async t=>{
  const server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');let browser;
  try{
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
    const page=await browser.newPage();await page.route('**/__continuum_herds_city',r=>r.fulfill({contentType:'text/html',body:'<!doctype html>'}));
    await page.goto('http://127.0.0.1:'+server.address().port+'/__continuum_herds_city');
    const result=await page.evaluate(async()=>{
      const {requestHerdsPipelines}=await import('/js/herds.js');
      const {HERD_BUCKETS,HERD_BODY_FLOATS,HERD_FADE_BUCKET,HERD_SPLAT_BUCKET}=await import('/js/wgsl/herds.js');
      const {requestCityContinuumAtlas,requestCityContinuumPipelines,createCityContinuum}=await import('/js/city-continuum-draw.js');
      const {createContinuumCensus}=await import('/js/continuum-census.js');
      const device=await(await navigator.gpu.requestAdapter()).requestDevice(),errors=[];device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
      const shader=async(code,label)=>{const module=device.createShaderModule({code,label});const bad=(await module.getCompilationInfo()).messages.filter(m=>m.type==='error');if(bad.length)throw Error(label+': '+bad.map(m=>m.message).join('\n'));return module;};
      const pipes=await requestHerdsPipelines({device,shader,format:'rgba16float',samples:4});
      const step=pipes[4],B=GPUBufferUsage;
      const make=(data,usage)=>{const buffer=device.createBuffer({size:Math.max(16,data.byteLength),usage:usage|B.COPY_DST});device.queue.writeBuffer(buffer,0,data);return buffer;};
      // A camera at the sheep's middle height looking down +z: clip = (x, y, 0.1, z), focal 1000 px.
      const camY=1+0.75*0.62,frame=new Float32Array(96);
      frame[0]=1;frame[5]=1;frame[11]=1;frame[14]=0.1;frame.set([0,camY,0,0],16);frame.set([0.5,0,0,0],20);frame.set([0,0.5,0,0],24);frame.set([0,0,1,0],28);frame.set([0,1,0,1],32);frame.set([1000,1000,0.001,0.001],36);
      const frameUBO=make(frame,B.UNIFORM);
      const ground=device.createTexture({size:[2,2],format:'rgba8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
      device.queue.writeTexture({texture:ground},new Uint8Array(16).fill(255),{bytesPerRow:8},[2,2]);
      // A sheep (radius 0.75 m) spans 1500/d true pixels; three herd-mates stand behind the camera, culled.
      const distance=1500/4.5,seeds=new Float32Array(4*8);
      for(let i=0;i<3;i++)seeds.set([0,-200,0,0.1*i,0.5,1,0,0],i*8);
      seeds.set([0,distance,0,0.3,0.42,1,0,0],3*8);
      const run=async coarsening=>{
        const cfg=new ArrayBuffer(32);new Uint32Array(cfg,0,2).set([4,16]);new Float32Array(cfg).set([0,0,coarsening],2);
        const bodies=device.createBuffer({size:HERD_BUCKETS*16*HERD_BODY_FLOATS*4,usage:B.STORAGE|B.COPY_SRC});
        const draws=make(new Uint32Array(HERD_BUCKETS*5),B.STORAGE|B.INDIRECT|B.COPY_SRC);
        const buffers=[frameUBO,make(new Float32Array([0,0,4000,0]),B.UNIFORM),make(new Float32Array(8),B.UNIFORM),null,make(new Uint8Array(cfg),B.UNIFORM),make(seeds,B.STORAGE),bodies,draws,
          make(new Float32Array(28),B.UNIFORM),make(new Float32Array(4),B.STORAGE),make(new Uint32Array(4+8*8),B.UNIFORM),make(new Float32Array(4*8),B.STORAGE)];
        const group=device.createBindGroup({layout:step.getBindGroupLayout(0),entries:buffers.map((buffer,binding)=>({binding,resource:buffer?{buffer}:ground.createView()}))});
        const readDraws=device.createBuffer({size:HERD_BUCKETS*20,usage:B.MAP_READ|B.COPY_DST}),readBodies=device.createBuffer({size:bodies.size,usage:B.MAP_READ|B.COPY_DST});
        const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(step);pass.setBindGroup(0,group);pass.dispatchWorkgroups(1);pass.end();
        encoder.copyBufferToBuffer(draws,0,readDraws,0,readDraws.size);encoder.copyBufferToBuffer(bodies,0,readBodies,0,readBodies.size);device.queue.submit([encoder.finish()]);
        await Promise.all([readDraws.mapAsync(GPUMapMode.READ),readBodies.mapAsync(GPUMapMode.READ)]);
        const counts=new Uint32Array(readDraws.getMappedRange().slice(0)),body=new Float32Array(readBodies.getMappedRange().slice(0));readDraws.unmap();readBodies.unmap();
        const at=(bucket,word)=>body[bucket*16*HERD_BODY_FLOATS+word];
        return {solid:counts[1],fade:counts[HERD_FADE_BUCKET*5+1],splat:counts[HERD_SPLAT_BUCKET*5+1],
          meshShare:at(HERD_FADE_BUCKET,11),splatShare:at(HERD_SPLAT_BUCKET,6),meshFlags:at(HERD_FADE_BUCKET,13),splatFlags:at(HERD_SPLAT_BUCKET,13)};
      };
      const herds={finer:await run(0.5),base:await run(1),coarser:await run(2)};
      // The city continuum with one house 50 m ahead: its view's four lists offered to the census, which counts the
      // triangles the GPU's own cut put in them.
      const atlas=await requestCityContinuumAtlas(device),programs=await requestCityContinuumPipelines({device,shader,shadowFormat:'depth32float'});
      const cityCut=createCityContinuum({device,atlas,pipelines:programs,view:null,typed:new Float32Array([0,0,50,0,1,1,1,0.5]),types:new Uint32Array([0]),frame:frameUBO,shadowUniform:make(new Float32Array(28),B.UNIFORM)});
      cityCut.setShadows(false);cityCut.setPixelError(1);cityCut.setWorldOffset(0,0);
      const census=createContinuumCensus(device),encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();cityCut.encode(pass);pass.end();
      const offered=cityCut.continuumDraws();census.encode(encoder,[{name:'city',draws:offered}]);
      const readCity=device.createBuffer({size:cityCut.draws.size,usage:B.MAP_READ|B.COPY_DST});encoder.copyBufferToBuffer(cityCut.draws,0,readCity,0,readCity.size);
      device.queue.submit([encoder.finish()]);census.afterSubmit();
      await readCity.mapAsync(GPUMapMode.READ);const cityDraws=Array.from(new Uint32Array(readCity.getMappedRange()));readCity.unmap();
      for(let i=0;i<200&&!census.latest;i++)await new Promise(r=>setTimeout(r,10));
      const city={offered:offered.map(({offset,records,stride})=>({offset,records,stride})),draws:cityDraws,census:census.latest};
      census.destroy();cityCut.destroy();device.destroy();
      return {errors,herds,city};
    });
    t.diagnostic(JSON.stringify(result));
    assert.deepEqual(result.errors,[]);
    const {finer,base,coarser}=result.herds;
    // 4.5 true pixels: past the handoff when the scene sharpens, inside it at the base error, a splat when coarser.
    assert.deepEqual([finer.solid,finer.fade,finer.splat],[1,0,0],'at half the base error the sheep stays a whole mesh');
    assert.deepEqual([base.solid,base.fade,base.splat],[0,1,1],`at the base error 4.5 px lies in the core's ${CONTINUUM_SPLAT_PIXELS}..${CONTINUUM_SPLAT_BAND_PIXELS} px handoff`);
    assert.deepEqual([coarser.solid,coarser.fade,coarser.splat],[0,0,1],'at twice the base error the sheep is only its splat');
    assert.equal(base.meshShare,base.splatShare,'mesh and splat carry the identical packed share');
    assert.equal(base.meshFlags,base.splatFlags,'mesh and splat carry the identical seed');
    assert.equal(base.meshFlags,3*16,'the herd index rides above the four flag bits');
    // The core's one splat band (js/continuum-core.js), not a copy of its numbers.
    const share=(base.meshShare-Math.floor(base.meshShare+1e-4))/0.95,x=(4.5-CONTINUUM_SPLAT_PIXELS)/(CONTINUUM_SPLAT_BAND_PIXELS-CONTINUUM_SPLAT_PIXELS);
    assert.ok(Math.abs(share-x*x*(3-2*x))<1e-3,`the mesh holds smoothstep(${CONTINUUM_SPLAT_PIXELS}, ${CONTINUUM_SPLAT_BAND_PIXELS}, 4.5) of the handoff (${share})`);
    assert.deepEqual(result.city.offered,[{offset:0,records:4,stride:4}],'the view\'s four lists, read where the cut wrote them');
    const listed=[0,1,2,3].reduce((sum,i)=>sum+result.city.draws[i*4]*result.city.draws[i*4+1]/3,0);
    assert.ok(result.city.draws[1]+result.city.draws[5]>0,'the house 50 m ahead is drawn as its clusters');
    assert.equal(result.city.census?.families?.city,listed,`the census counts the ${listed} triangles the cut listed`);
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});

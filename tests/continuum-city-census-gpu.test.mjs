// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The city continuum's draws reach the continuum census (AGENTS.md rule 3, item 5). The herds' cut by the scene's
// pixel-error scalar is proven with every other animal's in tests/animal-continuum-gpu.test.mjs.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {test} from 'node:test';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';

test('the city continuum counts into the continuum census',{timeout:180000},async t=>{
  const server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');let browser;
  try{
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
    const page=await browser.newPage();await page.route('**/__continuum_city_census',r=>r.fulfill({contentType:'text/html',body:'<!doctype html>'}));
    await page.goto('http://127.0.0.1:'+server.address().port+'/__continuum_city_census');
    const result=await page.evaluate(async()=>{
      const {requestCityContinuumAtlas,createCityContinuum}=await import('/js/city-continuum-draw.js');
      const {requestContinuumPrograms}=await import('/js/continuum-scene.js');
      const {setContinuumPixelError}=await import('/js/continuum-core.js');
      const {createContinuumCensus}=await import('/js/continuum-census.js');
      const device=await(await navigator.gpu.requestAdapter()).requestDevice(),errors=[];device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
      const shader=async(code,label)=>{const module=device.createShaderModule({code,label});const bad=(await module.getCompilationInfo()).messages.filter(m=>m.type==='error');if(bad.length)throw Error(label+': '+bad.map(m=>m.message).join('\n'));return module;};
      const B=GPUBufferUsage;
      const make=(data,usage)=>{const buffer=device.createBuffer({size:Math.max(16,data.byteLength),usage:usage|B.COPY_DST});device.queue.writeBuffer(buffer,0,data);return buffer;};
      // A camera at 1.465 m looking down +z: clip = (x, y, 0.1, z), focal 1000 px.
      const camY=1+0.75*0.62,frame=new Float32Array(96);
      frame[0]=1;frame[5]=1;frame[11]=1;frame[14]=0.1;frame.set([0,camY,0,0],16);frame.set([0.5,0,0,0],20);frame.set([0,0.5,0,0],24);frame.set([0,0,1,0],28);frame.set([0,1,0,1],32);frame.set([1000,1000,0.001,0.001],36);
      const frameUBO=make(frame,B.UNIFORM);
      // The city continuum with one house 50 m ahead: its view's four lists offered to the census, which reads the
      // real triangles the GPU's own cut counted as it listed them.
      const atlas=await requestCityContinuumAtlas(device),programs=await requestContinuumPrograms({device,shader,shadowFormat:'depth32float'});
      const cityCut=createCityContinuum({device,atlas,programs,view:null,typed:new Float32Array([0,0,50,0,1,1,1,0.5]),types:new Uint32Array([0]),frame:frameUBO,shadowUniform:make(new Float32Array(28),B.UNIFORM)});
      setContinuumPixelError(1);cityCut.setShadows(false);cityCut.setWorldOffset(0,0);
      const census=createContinuumCensus(device),encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();cityCut.encode(pass);pass.end();
      const offered=cityCut.continuumDraws();census.encode(encoder,[{name:'city',draws:offered}]);
      const readCity=device.createBuffer({size:cityCut.draws.size,usage:B.MAP_READ|B.COPY_DST});encoder.copyBufferToBuffer(cityCut.draws,0,readCity,0,readCity.size);
      device.queue.submit([encoder.finish()]);census.afterSubmit();
      await readCity.mapAsync(GPUMapMode.READ);const cityDraws=Array.from(new Uint32Array(readCity.getMappedRange()));readCity.unmap();
      for(let i=0;i<200&&!census.latest;i++)await new Promise(r=>setTimeout(r,10));
      const city={offered:offered.map(({offset,records,stride})=>({offset,records,stride})),draws:cityDraws,census:census.latest};
      census.destroy();cityCut.destroy();device.destroy();
      return {errors,city};
    });
    t.diagnostic(JSON.stringify(result));
    assert.deepEqual(result.errors,[]);
    assert.deepEqual(result.city.offered,[{offset:96,records:4,stride:1}],'the view\'s four lists\' real triangles, read where the cut counted them');
    const listed=[0,1,2,3].reduce((sum,i)=>sum+result.city.draws[24+i],0);
    assert.ok(listed<=[0,1,2,3].reduce((sum,i)=>sum+result.city.draws[i*4]*result.city.draws[i*4+1]/3,0),'no more than the draws submit');
    assert.ok(result.city.draws[1]+result.city.draws[5]>0,'the house 50 m ahead is drawn as its clusters');
    assert.equal(result.city.census?.families?.city,listed,`the census counts the ${listed} triangles the cut listed`);
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});

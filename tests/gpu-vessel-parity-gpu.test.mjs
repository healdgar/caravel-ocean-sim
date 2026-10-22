// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {once} from 'node:events';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {chromium} from 'playwright';
import {createDevServer} from '../server.mjs';

test('actual shared GPU surface backend matches every CPU reference vertex and frozen pre-port samples',{timeout:600000},async t=>{
  const frozen=JSON.parse(readFileSync(new URL('./data/vessel-gpu-oracle.json',import.meta.url),'utf8'));
  const server=createDevServer();server.listen(0,'127.0.0.1');await once(server,'listening');let browser;
  try{
    browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,args:process.env.WEBGPU_BACKEND==='metal'?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--enable-unsafe-swiftshader','--disable-gpu-watchdog']});
    const page=await browser.newPage();await page.route('**/__gpu-vessel-parity',r=>r.fulfill({contentType:'text/html',body:'<!doctype html>'}));await page.goto('http://127.0.0.1:'+server.address().port+'/__gpu-vessel-parity');
    const result=await page.evaluate(async frozen=>{
      const {SHIP_MODELS}=await import('/js/ship-models.js'),{createShipAssetCache}=await import('/js/ship-mesh.js'),{createVesselPose}=await import('/js/vessel-pose.js');
      const {GPU_RIG_ORACLE_CASES,gpuRigOracleBoat,gpuRigCPUOracle}=await import('/tests/helpers/gpu-rig-oracle.mjs');
      const models=Object.values(SHIP_MODELS).filter(m=>m.status==='ready'&&m.geometry&&m.rig.backend==='surfaces-v1');
      const device=await(await navigator.gpu.requestAdapter()).requestDevice(),errors=[];device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
      const B=GPUBufferUsage,cache=createShipAssetCache(),rows=[];
      const buffer=(data,usage)=>{const b=device.createBuffer({size:data.byteLength,usage:usage|B.COPY_DST});device.queue.writeBuffer(b,0,data);return b;};
      const computePipe=async(code,label)=>{const module=device.createShaderModule({code,label}),bad=(await module.getCompilationInfo()).messages.filter(m=>m.type==='error');if(bad.length)throw Error(label+': '+bad.map(m=>m.message).join('\n'));return device.createComputePipelineAsync({label,layout:'auto',compute:{module,entryPoint:'main'}});};
      const hash=async data=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',data))).map(v=>v.toString(16).padStart(2,'0')).join('');
      for(const model of models){
        const asset=cache.get(model.id),count=asset.vertices.length/9,raw=buffer(asset.vertices,B.STORAGE|B.VERTEX),hull=buffer(new Float32Array(52),B.UNIFORM),read=device.createBuffer({size:count*32,usage:B.MAP_READ|B.COPY_DST});
        const pose=await createVesselPose({device,computePipe,sourceBuffer:raw,vertexCount:count,hullUBO:hull,rigData:asset.rigGPUData}),oracle=gpuRigCPUOracle(asset),golden=frozen.models.find(m=>m.id===model.id);
        if(!golden)throw Error('A newly renderable surface model requires an independently frozen oracle: '+model.id);
        const sourceSHA256=await hash(asset.vertices),cases=[];let last=null,movement=0;
        for(const c of GPU_RIG_ORACLE_CASES){
          const boat=gpuRigOracleBoat(model,c),physical=[boat.beam/model.designFrame.beam,model.designFrame.verticalScale,boat.length/model.designFrame.length],expected=new Float32Array(asset.vertices);
          oracle(boat,c.time,c.wind,expected);
          const h=new Float32Array(52);h[3]=physical[1];h[12]=boat.beam;h[13]=boat.length;h[15]=boat.rudder;h[19]=c.time;h[21]=c.wind;h[22]=1;h[23]=model.modelCode;h[27]=boat.hatchesClosed;device.queue.writeBuffer(hull,0,h);
          pose.update(boat,c.time,c.wind);const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();pose.encode(pass);pass.end();encoder.copyBufferToBuffer(pose.buffer,0,read,0,count*32);device.queue.submit([encoder.finish()]);await read.mapAsync(GPUMapMode.READ);const actual=new Float32Array(read.getMappedRange()).slice();read.unmap();
          let position=0,normal=0,frozenPosition=0,frozenNormal=0,worst=null,finite=true;
          for(let i=0;i<count;i++){
            const p=Math.hypot(...[0,1,2].map(k=>(actual[i*8+k]-expected[i*9+k])*physical[k])),n=Math.hypot(...[0,1,2].map(k=>actual[i*8+4+k]-expected[i*9+3+k]));
            if(!Number.isFinite(p+n))finite=false;if(p>position||n>normal)worst={vertex:i,material:asset.vertices[i*9+6],position:p,normal:n};position=Math.max(position,p);normal=Math.max(normal,n);
            if(last)movement=Math.max(movement,Math.hypot(...[0,1,2].map(k=>(actual[i*8+k]-last[i*8+k])*physical[k])));
          }
          const frozenCase=golden.cases.find(g=>g.name===c.name);if(!frozenCase)throw Error('Missing frozen control state '+model.id+'/'+c.name);
          for(const sample of frozenCase.samples){
            const i=sample.vertex;frozenPosition=Math.max(frozenPosition,Math.hypot(...[0,1,2].map(k=>(actual[i*8+k]-sample.position[k])*physical[k])));frozenNormal=Math.max(frozenNormal,Math.hypot(...[0,1,2].map(k=>actual[i*8+4+k]-sample.normal[k])));
          }
          cases.push({name:c.name,position,normal,frozenPosition,frozenNormal,worst,finite});last=actual;
        }
        rows.push({id:model.id,count,sourceSHA256,expectedSHA256:golden.sourceSHA256,expectedCount:golden.vertexCount,movement,cases});pose.destroy();raw.destroy();hull.destroy();read.destroy();
      }
      await device.queue.onSubmittedWorkDone();device.destroy();return {errors,models:models.map(m=>m.id),rows};
    },frozen);
    t.diagnostic(JSON.stringify(result));assert.deepEqual(result.errors,[]);assert.deepEqual(result.models,[...frozen.models.map(m=>m.id)],'future surface models must enter this parity gate');
    for(const row of result.rows){
      assert.equal(row.count,row.expectedCount);assert.equal(row.sourceSHA256,row.expectedSHA256,'rest topology changes require an explicit reviewed golden');assert.ok(row.movement>.01,row.id+' must actually deform; an identity compute is a failure');assert.equal(row.cases.length,5);
      for(const c of row.cases){assert.ok(c.finite,row.id+'/'+c.name+' must remain finite');assert.ok(c.position<=2e-5,row.id+'/'+c.name+' physical position parity '+c.position+' '+JSON.stringify(c.worst));assert.ok(c.normal<=1e-4,row.id+'/'+c.name+' normal parity '+c.normal+' '+JSON.stringify(c.worst));assert.ok(c.frozenPosition<=2e-5&&c.frozenNormal<=1e-4,row.id+'/'+c.name+' cannot change the shader and CPU reference together');}
    }
  }finally{await browser?.close();await new Promise(resolve=>server.close(resolve));}
});

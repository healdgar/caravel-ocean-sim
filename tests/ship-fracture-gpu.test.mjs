// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The GPU must fly a shard exactly as the reference does, and a live ship must take it without errors.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {after,before,test} from 'node:test';
import {chromium} from 'playwright';
const port=process.env.SHIP_FRACTURE_TEST_PORT||8137,origin=`http://localhost:${port}`;
let server,browser;
before(async()=>{
  server=spawn(process.execPath,['server.mjs',String(port)],{cwd:new URL('..',import.meta.url),stdio:['ignore','pipe','inherit']});
  await Promise.race([once(server.stdout,'data'),once(server,'exit').then(([code])=>{throw Error('Ship fracture server exited '+code);})]);
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,
    args:process.env.WEBGPU_BACKEND==='metal'?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--use-webgpu-adapter=swiftshader']});
});
after(async()=>{await browser?.close();server?.kill();});

test('the compute pass moves a shard as the reference does, and leaves everything else alone',{timeout:120000},async()=>{
  const page=await browser.newPage();
  try{
    await page.goto(`${origin}/tests/fixtures/forest-gpu.html`);
    const result=await page.evaluate(async()=>{
      const {SHIP_FRACTURE_POSE_UPDATE}=await import('/js/wgsl/ship-fracture.js');
      const {evaluateShardFlight,FRACTURE_RECORD_FLOATS}=await import('/js/ship-fracture.js');
      const adapter=await navigator.gpu.requestAdapter(),device=await adapter.requestDevice();
      const module=device.createShaderModule({code:SHIP_FRACTURE_POSE_UPDATE});
      const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module,entryPoint:'main'}});
      const U=GPUBufferUsage,scale=[4.4,4.72,4.72];
      const points=[[.1,2.2,.3],[.5,3,-.2],[-.4,6.5,.05],[0,1.59,.05]];
      const posed=new Float32Array(points.length*8);points.forEach((p,i)=>{posed.set([...p,0],i*8);posed.set([0,1.5,0,0],i*8+4);});
      const shards=new Uint32Array([1,1,2,0]);
      const records=new Float32Array(3*FRACTURE_RECORD_FLOATS);
      records[15]=-2;
      // Shard 1 hinges then falls. Shard 2 is gone.
      records.set([0,1.59,.05,10, 2,0,1,5, .1,.2,-.3,30, 1.5,1,.04,-1],FRACTURE_RECORD_FLOATS);
      records.set([0,1.59,.05,0, 0,0,0,0, 0,0,0,0, 0,0,0,1],2*FRACTURE_RECORD_FLOATS);
      const make=(data,usage,size=data.byteLength)=>{const b=device.createBuffer({size,usage:usage|U.COPY_DST});device.queue.writeBuffer(b,0,data);return b;};
      const out=[];
      for(const clock of [10,10.8,12,14,17]){
        const pose=make(posed,U.STORAGE|U.COPY_SRC),clockData=new Float32Array([clock,9.80665,0,0,...scale,0]);
        const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[pose,make(shards,U.STORAGE),make(records,U.STORAGE),make(clockData,U.UNIFORM)].map((buffer,binding)=>({binding,resource:{buffer}}))});
        const read=device.createBuffer({size:posed.byteLength,usage:U.COPY_DST|U.MAP_READ}),encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();
        pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(1);pass.end();
        encoder.copyBufferToBuffer(pose,0,read,0,posed.byteLength);device.queue.submit([encoder.finish()]);
        await read.mapAsync(GPUMapMode.READ);const got=new Float32Array(read.getMappedRange().slice(0));read.unmap();
        points.forEach((p,i)=>{
          const record=records.subarray(shards[i]*FRACTURE_RECORD_FLOATS,(shards[i]+1)*FRACTURE_RECORD_FLOATS);
          const want=shards[i]?evaluateShardFlight(record,clock,p,scale):p;
          out.push({clock,vertex:i,want,got:[got[i*8],got[i*8+1],got[i*8+2]],normal:Math.hypot(got[i*8+4],got[i*8+5],got[i*8+6])});
        });
      }
      return out;
    });
    for(const row of result){
      for(let c=0;c<3;c++)assert.ok(Math.abs(row.want[c]-row.got[c])<2e-3,`vertex ${row.vertex} at ${row.clock}: ${row.want} vs ${row.got}`);
      assert.ok(Math.abs(row.normal-1.5)<1e-3,'the damage carried in the normal length survives');
    }
    assert.notDeepEqual(result.find(r=>r.clock===12&&r.vertex===0).got,result.find(r=>r.clock===10&&r.vertex===0).got,'it moved');
  }finally{await page.close();}
});

function instrument(){
  window.gpuErrors=[];window.fractureDispatches=0;
  const set=GPUComputePassEncoder.prototype.setPipeline;
  GPUComputePassEncoder.prototype.setPipeline=function(pipeline){if(pipeline.label==='ship fracture')window.fractureDispatches++;return set.call(this,pipeline);};
  const request=GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice=async function(...args){const device=await request.apply(this,args);device.addEventListener('uncapturederror',e=>window.gpuErrors.push(e.error.message));return device;};
}

test('a live ship runs the pass only once something has broken, and a repair ends it',{timeout:300000},async()=>{
  const page=await browser.newPage({viewport:{width:320,height:240}});
  try{
    await page.addInitScript(instrument);
    await page.goto(`${origin}/?ship=nina&view=ship&follower=0&clouds=0&w=320&h=240`);
    await page.waitForFunction(()=>window.oceanStartup?.state==='ready'||window.oceanStartup?.state==='failed',undefined,{timeout:240000,polling:200});
    assert.equal(await page.evaluate(()=>oceanStartup.state),'ready');
    const frames=n=>page.evaluate(async n=>{for(let i=0;i<n;i++)await new Promise(requestAnimationFrame);},n);
    await frames(3);
    assert.equal(await page.evaluate(()=>{const n=fractureDispatches;fractureDispatches=0;return n;}),0,'an intact ship costs nothing');
    const broken=await page.evaluate(async()=>{
      const {applyShipImpactDamage}=await import('/js/gunnery-control.js');
      const boat=oceanFleet.vessels[0].boat;
      for(let i=0;i<8;i++)applyShipImpactDamage(boat,{hitZone:'rigging',mastGroup:'main',localPosition:[0,8,0],position:[boat.x,8,boat.z],surfacePosition:[boat.x,8,boat.z],velocity:[-400,0,0],mass:5.4,energy:400000,ammo:'round'});
      for(let i=0;i<4;i++)await new Promise(requestAnimationFrame);
      return {count:boat.damage.fracture?.brokenCount??0,state:boat.damage.mastState.main};
    });
    assert.equal(broken.state,2,'the main mast is shot away');
    assert.ok(broken.count>=4,`its sections broke (${broken.count})`);
    await frames(3);
    assert.ok(await page.evaluate(()=>fractureDispatches)>0,'the pass now runs');
    await page.evaluate(async()=>{
      const {repairVessel}=await import('/js/vessel-damage.js');
      const vessel=oceanFleet.vessels[0];
      repairVessel(vessel.boat,{hullGain:1,minRig:1,structure:true});
      vessel.pose.restoreGeometry();
    });
    await frames(3);
    await page.evaluate(()=>{fractureDispatches=0;});
    await frames(3);
    assert.equal(await page.evaluate(()=>fractureDispatches),0,'a repaired ship stops paying for it');
    assert.deepEqual(await page.evaluate(()=>gpuErrors),[]);
  }finally{await page.close();}
});

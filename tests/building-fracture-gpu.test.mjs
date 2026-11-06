// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The GPU must pose a building's shards exactly as the reference does, and a live port must take fire without errors,
// never rewriting a building's vertices from JavaScript.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {after,before,test} from 'node:test';
import {chromium} from 'playwright';
const port=process.env.BUILDING_FRACTURE_TEST_PORT||8139,origin=`http://localhost:${port}`;
let server,browser;
before(async()=>{
  server=spawn(process.execPath,['server.mjs',String(port)],{cwd:new URL('..',import.meta.url),stdio:['ignore','pipe','inherit']});
  await Promise.race([once(server.stdout,'data'),once(server,'exit').then(([code])=>{throw Error('Building fracture server exited '+code);})]);
  browser=await chromium.launch({executablePath:process.env.CHROMIUM_PATH||undefined,
    args:process.env.WEBGPU_BACKEND==='metal'?['--enable-unsafe-webgpu','--use-angle=metal','--disable-gpu-watchdog']:['--enable-unsafe-webgpu','--use-angle=swiftshader','--use-webgpu-adapter=swiftshader']});
});
after(async()=>{await browser?.close();server?.kill();});

test('the pose pass moves shards as the reference does, opens hidden faces, and leaves the rest alone',{timeout:120000},async()=>{
  const page=await browser.newPage();
  try{
    await page.goto(`${origin}/tests/fixtures/forest-gpu.html`);
    const rows=await page.evaluate(async()=>{
      const {BUILDING_FRACTURE_POSE_UPDATE}=await import('/js/wgsl/ship-fracture.js');
      const {evaluateShardFlight,FRACTURE_RECORD_FLOATS}=await import('/js/ship-fracture.js');
      const adapter=await navigator.gpu.requestAdapter(),device=await adapter.requestDevice();
      const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module:device.createShaderModule({code:BUILDING_FRACTURE_POSE_UPDATE}),entryPoint:'main'}});
      const U=GPUBufferUsage;
      // Shard 0 stays. Shard 1 flies. Shard 2 is intact and untouched. Shard 3 is intact with scorch. Its last vertex is a hidden face.
      const verts=[[1,5,2,0,1,0,11.125,.8,0],[2,6,1,1,0,0,11.125,.7,1],[3,7,2,0,0,1,11.125,.6,1],[4,8,1,0,1,0,11.125,.9,2],[5,9,2,1,0,0,11.125,.9,3],[6,9,1,0,0,1.6,11.125,.5,3]];
      const rest=new Float32Array(verts.length*8);verts.forEach((v,i)=>rest.set(v.slice(0,8),i*8));
      const shards=new Uint32Array(verts.map(v=>v[8]));
      const records=new Float32Array(4*FRACTURE_RECORD_FLOATS);for(let s=0;s<4;s++)records[s*16+15]=-2;
      records.set([2,6,1.5,10, 2,1,-1,1.2, .3,.5,-.2,-1, 0,1,0,-1],16);
      const scorch=new Float32Array([0,0,0,.4]);
      const make=(data,usage)=>{const b=device.createBuffer({size:data.byteLength,usage:usage|U.COPY_DST});device.queue.writeBuffer(b,0,data);return b;};
      const out=[];
      for(const clock of [10,10.5,11,11.2,30]){
        // A worn-out clock must not move a frozen shard: settled flights are read back at the same age.
        const clockData=new Float32Array([clock,9.80665,0,0,1,1,1,0]);
        const initial=rest.slice();initial[5*8]=5;initial[5*8+1]=9;initial[5*8+2]=1.5;
        const posed=make(initial,U.STORAGE|U.COPY_SRC);
        const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[posed,make(rest,U.STORAGE),make(shards,U.STORAGE),make(records,U.STORAGE),make(clockData,U.UNIFORM),make(scorch,U.STORAGE)].map((buffer,binding)=>({binding,resource:{buffer}}))});
        const read=device.createBuffer({size:rest.byteLength,usage:U.COPY_DST|U.MAP_READ}),encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();
        pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(1);pass.end();
        encoder.copyBufferToBuffer(posed,0,read,0,rest.byteLength);device.queue.submit([encoder.finish()]);
        await read.mapAsync(GPUMapMode.READ);const got=new Float32Array(read.getMappedRange().slice(0));read.unmap();
        const row={clock,got:[...got]};
        row.flight=[1,2].map(v=>evaluateShardFlight(records.subarray(16,32),clock,verts[v].slice(0,3),[1,1,1]));
        out.push(row);
      }
      return out;
    });
    for(const {clock,got,flight}of rows){
      const vertex=i=>got.slice(i*8,i*8+8);
      assert.deepEqual(vertex(0).slice(0,3),[1,5,2],'shard 0 stays');
      for(const [i,v] of [1,2].entries())for(let c=0;c<3;c++)assert.ok(Math.abs(vertex(v)[c]-flight[i][c])<2e-3,`flying shard at ${clock}: ${vertex(v).slice(0,3)} vs ${flight[i]}`);
      assert.ok(Math.abs(vertex(1)[6]-11.125)<1e-5&&Math.abs(vertex(1)[7]-.7)<1e-5,'kind and shade are kept');
      assert.deepEqual(vertex(3).slice(0,3),[4,8,1],'an intact shard with no scorch is not touched');
      assert.deepEqual(vertex(4).slice(0,3),[5,9,2],'an intact shard with scorch stays where it is');
      assert.ok(Math.abs(Math.hypot(...vertex(4).slice(3,6))-1.4)<1e-3,'its scorch lengthens the normal the land shader reads');
      assert.deepEqual(vertex(5).slice(0,3),[6,9,1],'a hidden face opens once its shard is exposed');
      assert.ok(Math.abs(Math.hypot(...vertex(5).slice(3,6))-1.6)<1e-3,'and it stays raw stone');
    }
    assert.notDeepEqual(rows[0].got.slice(8,11),rows[2].got.slice(8,11),'it moved');
  }finally{await page.close();}
});

function instrument(){
  window.gpuErrors=[];window.fractureDispatches=0;window.buildingWrites=[];
  const set=GPUComputePassEncoder.prototype.setPipeline;
  GPUComputePassEncoder.prototype.setPipeline=function(pipeline){if(pipeline.label==='building fracture')window.fractureDispatches++;return set.call(this,pipeline);};
  const write=GPUQueue.prototype.writeBuffer;
  GPUQueue.prototype.writeBuffer=function(buffer,...rest){if(/port prefab vertices|fracture vertices|rest vertices/.test(buffer.label||''))window.buildingWrites.push(buffer.label);return write.call(this,buffer,...rest);};
  const request=GPUAdapter.prototype.requestDevice;
  GPUAdapter.prototype.requestDevice=async function(...args){const device=await request.apply(this,args);device.addEventListener('uncapturederror',e=>window.gpuErrors.push(e.error.message));return device;};
}

test('a live port pays nothing until hit, poses while pieces fall, then stops, and no hit writes a vertex',{timeout:560000},async()=>{
  const page=await browser.newPage({viewport:{width:320,height:240}});
  try{
    await page.addInitScript(instrument);
    await page.goto(`${origin}/?region=lisbon&view=ship&ship=nina&follower=0&clouds=0&w=320&h=240&year=1650&boatSpeed=0`);
    await page.waitForFunction(()=>window.oceanStartup?.state==='ready'||window.oceanStartup?.state==='failed',undefined,{timeout:400000,polling:500});
    assert.equal(await page.evaluate(()=>oceanStartup.state),'ready');
    const frames=n=>page.evaluate(async n=>{for(let i=0;i<n;i++)await new Promise(requestAnimationFrame);},n);
    await frames(3);
    assert.equal(await page.evaluate(()=>fractureDispatches),0,'a port under no fire costs nothing');
    const before=await page.evaluate(()=>buildingWrites.length);
    const hit=await page.evaluate(async()=>{
      const {applyBuildingImpactDamage}=await import('/js/gunnery-control.js');
      const port=oceanFleet.terrain.port,building=port.instances.find(i=>i.prefabId==='stone_sea_bastion');
      if(!building)return {missing:true};
      const half=(building.depth??building.length)*.5,cos=Math.cos(building.yaw),sin=Math.sin(building.yaw),base=building.baseY??building.y;
      for(let i=0;i<6;i++){
        const x=(i-3)*1.5,z=half,y=3+i%3;
        const at=[building.x+x*cos+z*sin,base+y,building.z-x*sin+z*cos];
        applyBuildingImpactDamage(building,{localPosition:[x,y,z],position:at,surfacePosition:at,normal:[sin,0,cos],velocity:[-sin*400,0,-cos*400],mass:14.5,energy:900000,ammo:'round'});
      }
      window.fractureTarget=building;
      return {};
    });
    assert.ok(!hit.missing,'Lisbon has its bastion');
    await page.waitForFunction(()=>(fractureTarget.damageState.fracture?.brokenCount??0)>0,undefined,{timeout:60000,polling:100});
    const broken=await page.evaluate(()=>fractureTarget.damageState.fracture.brokenCount);
    assert.ok(broken>=4,`the bastion loses blocks (${broken})`);
    await frames(3);
    assert.ok(await page.evaluate(()=>fractureDispatches)>0,'the pose pass runs');
    await page.waitForFunction(()=>fractureTarget.damageState.fracture.flying.size===0,undefined,{timeout:60000,polling:200});
    await frames(3);
    await page.evaluate(()=>{fractureDispatches=0;});
    await frames(5);
    assert.equal(await page.evaluate(()=>fractureDispatches),0,'once everything has landed the pass stops');
    const writes=await page.evaluate(n=>buildingWrites.slice(n),before);
    assert.ok(writes.every(label=>/fracture vertices|rest vertices/.test(label)),`only a building's first upload writes its vertices (${[...new Set(writes)]})`);
    assert.ok(writes.length<=2,`once each (${writes.length})`);
    assert.deepEqual(await page.evaluate(()=>gpuErrors),[]);
  }finally{await page.close();}
});

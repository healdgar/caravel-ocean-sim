// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The GPU must fly a shard exactly as the reference does, and a live ship must take it without errors.
import assert from 'node:assert/strict';
import {spawn} from 'node:child_process';
import {once} from 'node:events';
import {after,before,test} from 'node:test';
import {chromium} from 'playwright';
import {createShipAssetCache} from '../js/ship-mesh.js';
import {createVesselDamageState} from '../js/gunnery-control.js';
import {SHARD_KINDS,FRACTURE_RECORD_FLOATS,FRACTURE_GRAVITY,applyFractureEvents,createShipFractureGPU,evaluateBrokenShardWorldPivot,shipSeaLevel} from '../js/ship-fracture.js';
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

// ---------------------------------------------------------------------------------------------------
// Timber adrift. The records are the ones the game writes for a real ship, taken off a device that only
// remembers what it was sent; the shader then poses her own vertices from them.
const assets=createShipAssetCache();
async function recordsFor(modelId,pose,breakHer){
  globalThis.GPUBufferUsage??={STORAGE:1,COPY_DST:2,UNIFORM:4};
  const asset=assets.get(modelId),f=asset.fracture,{length,beam}=asset.model.runtime;
  const boat={id:'t',modelId,model:asset.model,partAssembly:asset.partAssembly,length,beam,sailFore:1,sailMain:1,sailMizzen:1,...pose};
  const damage=boat.damage=createVesselDamageState(boat),buffers=new Map();
  const device={
    createBuffer:({label,size})=>{const buffer={data:new Float32Array(size/4),destroy(){}};buffers.set(label.replace(/^\S+ /,''),buffer);return buffer;},
    createBindGroup:()=>({}),
    queue:{writeBuffer:(buffer,offset,data,start=0,count=data.length-start)=>{if(data instanceof Float32Array)buffer.data.set(data.subarray(start,start+count),offset/4);}},
  };
  const gpu=await createShipFractureGPU({device,computePipe:async()=>({getBindGroupLayout:()=>({})}),posedBuffer:{},fracture:f});
  breakHer(f,damage);
  gpu.sync(damage,boat);gpu.tick(damage,0,boat);
  return {asset,f,boat,state:damage.fracture,records:buffers.get('shard flights').data,clock:buffers.get('fracture clock').data};
}
// Her vertices in those shards, thinned to a few hundred, and one more laid exactly on each pivot.
function sampleVertices({asset,f,state},shards,limit=420,keep=()=>true){
  const wanted=new Set(shards),all=[],catalog=asset.partAssembly;
  for(let v=0;v<f.vertexShards.length;v++)if(wanted.has(f.vertexShards[v])&&keep(catalog.parts[catalog.vertexPartIds[v]]?.id??''))all.push(v);
  const step=Math.max(1,Math.floor(all.length/limit)),rest=[],ids=[];
  for(let i=0;i<all.length;i+=step){rest.push([asset.vertices[all[i]*9],asset.vertices[all[i]*9+1],asset.vertices[all[i]*9+2]]);ids.push(f.vertexShards[all[i]]);}
  const pivots=[];
  for(const shard of shards){pivots.push(rest.length);rest.push([...state.records.subarray(shard*FRACTURE_RECORD_FLOATS,shard*FRACTURE_RECORD_FLOATS+3)]);ids.push(shard);}
  return {rest,ids,pivots};
}
async function poseOnGPU(page,{records,clock},{rest,ids},clocks){
  return page.evaluate(async({records,clock,rest,ids,clocks})=>{
    const {SHIP_FRACTURE_POSE_UPDATE}=await import('/js/wgsl/ship-fracture.js');
    const adapter=await navigator.gpu.requestAdapter(),device=await adapter.requestDevice(),errors=[];
    device.addEventListener('uncapturederror',e=>errors.push(e.error.message));
    const pipeline=await device.createComputePipelineAsync({layout:'auto',compute:{module:device.createShaderModule({code:SHIP_FRACTURE_POSE_UPDATE}),entryPoint:'main'}});
    const U=GPUBufferUsage,posed=new Float32Array(rest.length*8);
    rest.forEach((p,i)=>{posed.set([...p,0],i*8);posed.set([0,1.5,0,0],i*8+4);});
    const make=(data,usage)=>{const b=device.createBuffer({size:data.byteLength,usage:usage|U.COPY_DST});device.queue.writeBuffer(b,0,data);return b;};
    const shardBuffer=make(new Uint32Array(ids),U.STORAGE),recordBuffer=make(new Float32Array(records),U.STORAGE),out=[];
    for(const now of clocks){
      const pose=make(posed,U.STORAGE|U.COPY_SRC),clockData=new Float32Array(clock);clockData[0]=now;
      const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[pose,shardBuffer,recordBuffer,make(clockData,U.UNIFORM)].map((buffer,binding)=>({binding,resource:{buffer}}))});
      const read=device.createBuffer({size:posed.byteLength,usage:U.COPY_DST|U.MAP_READ}),encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();
      pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(rest.length/64));pass.end();
      encoder.copyBufferToBuffer(pose,0,read,0,posed.byteLength);device.queue.submit([encoder.finish()]);
      await read.mapAsync(GPUMapMode.READ);const got=new Float32Array(read.getMappedRange().slice(0));read.unmap();
      out.push({positions:rest.map((_,i)=>[got[i*8],got[i*8+1],got[i*8+2]]),normals:rest.map((_,i)=>Math.hypot(got[i*8+4],got[i*8+5],got[i*8+6]))});
    }
    return {out,errors};
  },{records:[...records],clock:[...clock],rest,ids,clocks});
}
// Out of her frame and into the world, by the frame the shader was given.
const worldOf=(records,scale,p)=>{
  const l=p.map((v,c)=>v*scale[c]);
  return [0,1,2].map(c=>records[3+c*4]+records[c]*l[0]+records[4+c]*l[1]-records[8+c]*l[2]);
};
const metresBetween=(a,b,scale=[1,1,1])=>Math.hypot((a[0]-b[0])*scale[0],(a[1]-b[1])*scale[1],(a[2]-b[2])*scale[2]);
// How far any pair of the points has moved apart or together since they were built.
function strain(rest,now,scale,pairs){
  let worst=0;
  for(const [a,b] of pairs)worst=Math.max(worst,Math.abs(metresBetween(now[a],now[b],scale)-metresBetween(rest[a],rest[b],scale)));
  return worst;
}
const pairsOf=(count,among=count)=>{const pairs=[];for(let i=0;i<count;i++)for(const k of [1,7,53,211])pairs.push([i,(i*k+k*17+1)%among]);return pairs;};
const POSE={x:120,z:-60,heading:40,pitch:.05,roll:.2,heave:.3,target:{heave:.45}};

test('a mast shot away falls as one rigid body and comes to lie flat on the sea, yards and all',{timeout:180000},async()=>{
  const page=await browser.newPage();
  try{
    await page.goto(`${origin}/tests/fixtures/forest-gpu.html`);
    for(const [modelId,side] of [['nina',1],['victory',-1]]){
      const ship=await recordsFor(modelId,POSE,(f,damage)=>{
        applyFractureEvents(f,damage,[{kind:'mast-break',mastGroup:'main',stage:'full',side}],0);damage.mastState.main=2;
      });
      const {f,boat,state,records}=ship,scale=f.scale,mast=f.masts.main,sea=shipSeaLevel(boat);
      const timber=[...mast.lower,...mast.upper].filter(s=>f.shards[s].kind!==SHARD_KINDS.line);
      assert.ok(timber.length>=2,`${modelId}'s main mast is several pieces (${timber.length})`);
      // The spar, its yards and its canvas. The blocks and deadeyes that belong to it but are made fast to her
      // sides go with it too, as a few specks well off its line, and say nothing about how it lies.
      const sample=sampleVertices(ship,timber,420,id=>/^(mast|yard|sail)\./.test(id)),{rest,pivots}=sample,first=timber[0]*FRACTURE_RECORD_FLOATS;
      // Every piece of it is on one flight: one pivot, one spin.
      for(const s of timber)assert.deepEqual([...state.records.subarray(s*FRACTURE_RECORD_FLOATS,s*FRACTURE_RECORD_FLOATS+16)],[...state.records.subarray(first,first+16)]);
      const start=evaluateBrokenShardWorldPivot(state,timber[0],0,boat,sea),hinge=state.records[first+12];
      const settle=hinge+Math.sqrt(2*Math.max(0,start[1]-sea)/(FRACTURE_GRAVITY*state.records[first+13]));
      const clocks=[0,hinge*.5,hinge,hinge+(settle-hinge)*.35,hinge+(settle-hinge)*.7,settle-.02,settle+.2,settle+1,settle+7,settle+31];
      const {out,errors}=await poseOnGPU(page,ship,sample,clocks);
      assert.deepEqual(errors,[]);
      // Standing, it is as tall as it was built. Before anything has moved the shader must leave it there.
      const built=rest.slice(0,-pivots.length),heights=built.map(p=>p[1]*scale[1]),tall=Math.max(...heights)-Math.min(...heights);
      // What it carries reaches across her (square yards) or along her (a lateen yard): the lesser of the two is
      // how thick the whole thing is, and so how much of it can stand out of the water once it lies down.
      const reach=c=>{const v=built.map(p=>p[c]*scale[c]);return Math.max(...v)-Math.min(...v);},thick=Math.min(reach(0),reach(2)),wide=Math.max(reach(0),reach(2));
      assert.ok(thick<tall*.3&&wide>thick*2,`${modelId}: a ${tall.toFixed(1)} m mast, ${wide.toFixed(1)} m wide and ${thick.toFixed(1)} m thick`);
      for(let i=0;i<rest.length;i++)assert.ok(metresBetween(out[0].positions[i],rest[i],scale)<4e-3,`${modelId}: at the moment it breaks vertex ${i} has not moved`);
      const pairs=pairsOf(rest.length-pivots.length);
      clocks.forEach((now,k)=>{
        const bent=strain(rest,out[k].positions,scale,pairs);
        assert.ok(bent<6e-3,`${modelId}: ${now.toFixed(2)} s after the break the mast is ${bent.toFixed(3)} m out of shape; it turns, it is never squeezed`);
        for(const length of out[k].normals)assert.ok(Math.abs(length-1.5)<2e-3,'the damage carried in the normal length survives');
        // Its foot is where the reference says it is, give or take the swell that lifts it.
        const foot=worldOf(records,scale,out[k].positions[pivots[0]]),want=evaluateBrokenShardWorldPivot(state,timber[0],now,boat,sea);
        assert.ok(Math.hypot(foot[0]-want[0],foot[2]-want[2])<5e-3&&Math.abs(foot[1]-want[1])<.14,`${modelId} at ${now.toFixed(2)} s: its foot is at ${foot.map(v=>v.toFixed(2))}, the reference at ${want.map(v=>v.toFixed(2))}`);
      });
      for(const k of [7,8,9]){
        const ys=out[k].positions.map(p=>worldOf(records,scale,p)[1]-sea),low=Math.min(...ys),high=Math.max(...ys);
        // Flat: mast, yards, tops and canvas stand no taller in the water than the whole is thick, but for the
        // little the swell tips it and the little it has sunk. Yards on end would stand as tall as it is wide.
        assert.ok(high-low<thick+tall*.03+.3&&high<thick+.4&&low>-thick-1.2,`${modelId}: ${(clocks[k]-settle).toFixed(1)} s after it meets the sea a mast ${tall.toFixed(1)} m tall, ${wide.toFixed(1)} m wide and ${thick.toFixed(1)} m thick lies between ${low.toFixed(2)} and ${high.toFixed(2)} m of the surface`);
      }
      // And it lies where it fell, over the side it went.
      const head=built.reduce((best,p,i)=>p[1]>built[best][1]?i:best,0);
      const lying=worldOf(records,scale,out[8].positions[head]),footAtRest=worldOf(records,scale,out[8].positions[pivots[0]]);
      assert.ok(Math.hypot(lying[0]-footAtRest[0],lying[2]-footAtRest[2])>tall*.8,'its length is along the water');
    }
  }finally{await page.close();}
});

test('planking adrift keeps its shape all the way down and floats on its broad side',{timeout:180000},async()=>{
  const page=await browser.newPage();
  try{
    await page.goto(`${origin}/tests/fixtures/forest-gpu.html`);
    const ship=await recordsFor('victory',POSE,(f,damage)=>{
      const side=f.strikable.filter(s=>f.shards[s].kind===SHARD_KINDS.skin&&f.shards[s].centroid[0]>.5&&f.shards[s].centroid[1]>.6).slice(0,14);
      applyFractureEvents(f,damage,side.map(s=>({kind:'hull',x:f.shards[s].centroid[0],y:f.shards[s].centroid[1],z:f.shards[s].centroid[2],severity:3,stepDepth:.5,side:1})),0);
    });
    const {f,boat,state,records}=ship,scale=f.scale,sea=shipSeaLevel(boat);
    const adrift=f.strikable.filter(s=>state.broken[s]&&state.spawnRecords[s*8+7]>.5).slice(0,10);
    assert.ok(adrift.length>=6,`she lost planking (${adrift.length})`);
    const modes=new Set();
    for(const s of adrift){
      const sample=sampleVertices(ship,[s],160),{rest,pivots}=sample,at=s*FRACTURE_RECORD_FLOATS;
      const start=evaluateBrokenShardWorldPivot(state,s,0,boat,sea),hinge=state.records[at+12],g=Math.max(.1,FRACTURE_GRAVITY*state.records[at+13]),up=Math.max(0,state.records[at+5]);
      const settle=hinge+(start[1]>sea?(up+Math.sqrt(up*up+2*g*(start[1]-sea)))/g:.25);
      const clocks=[0,settle*.3,settle*.6,settle*.9,settle+.1,settle+.6,settle+3];
      const {out,errors}=await poseOnGPU(page,ship,sample,clocks);
      assert.deepEqual(errors,[]);
      const pairs=pairsOf(rest.length-1),extents=[0,1,2].map(c=>(f.shards[s].max[c]-f.shards[s].min[c])*scale[c]),thin=Math.min(...extents),long=Math.max(...extents);
      modes.add(state.spawnRecords[s*8+6]);
      clocks.forEach((now,k)=>{
        const bent=strain(rest,out[k].positions,scale,pairs);
        assert.ok(bent<6e-3,`piece ${s}, ${extents.map(v=>v.toFixed(2)).join(' x ')} m: ${now.toFixed(2)} s after it left her it is ${bent.toFixed(3)} m out of shape`);
      });
      const ys=out[6].positions.slice(0,-1).map(p=>worldOf(records,scale,p)[1]),lies=Math.max(...ys)-Math.min(...ys);
      // On its broad side: no taller than its thinnest measure, but for the tilt the swell gives its length.
      assert.ok(lies<thin+long*.2+.05,`piece ${s}, ${extents.map(v=>v.toFixed(2)).join(' x ')} m, stands ${lies.toFixed(2)} m tall in the water`);
      assert.ok(Math.abs(worldOf(records,scale,out[6].positions[pivots[0]])[1]-sea)<.25,'and it is at the surface of the sea');
    }
    assert.ok(modes.size>=2,`pieces of more than one build were tried (${[...modes]})`);
  }finally{await page.close();}
});

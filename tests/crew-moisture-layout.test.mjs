// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createWetnessData,writeCrewWetnessData,createSurfaceWetness} from '../js/wetness.js';
import {requirePlayableShipModel} from '../js/ship-models.js';
const crewWetMesh=new Float32Array([0,0,0,0,1,0,0,0,0,1,0,0,0,1,0,0,1,0,0,0,1,0,1,0,0,0,1]);
const crewWetBoat=id=>{const m=requirePlayableShipModel(id);return {modelId:id,...m.runtime};};

test('crew moisture allocation matches each full complement and preserves hull lookup independently of actor count',()=>{
  let lookup,offset;
  for(const count of [0,1,12,26,30,32]){
    const data=createWetnessData(crewWetMesh,count);assert.equal(data.crewCount,count);assert.equal(data.points.length/8-data.crewOffset,count*4);
    if(lookup){assert.deepEqual(data.lookup,lookup);assert.equal(data.crewOffset,offset);}else{lookup=data.lookup;offset=data.crewOffset;}
    assert.ok(data.points.subarray(data.crewOffset*8).every(v=>v===0));
  }
  for(const count of [-1,1.5,Infinity,129])assert.throws(()=>createWetnessData(crewWetMesh,count),/crew count/);
});

test('last full-complement actor writes its own seated probes; absent and hidden crew cannot retain active stale probes',()=>{
  const count=32,boat=crewWetBoat('oseberg'),data=createWetnessData(crewWetMesh,count),sy=requirePlayableShipModel('oseberg').designFrame.verticalScale;
  const crew=Array.from({length:count},(_,i)=>({visible:true,position:[i*.1,.1,0],scale:[1,1,1],moisturePoints:[[i*.1,0,0],[i*.1,.4,0],[i*.1,.8,0],[i*.1,1.1,0]]}));
  const before=data.points.slice(0,data.crewOffset*8);writeCrewWetnessData(data,{crew},boat);assert.deepEqual(data.points.slice(0,data.crewOffset*8),before,'actor uploads never overwrite hull probes');
  const last=(data.crewOffset+(count-1)*4+3)*8;assert.ok(Math.abs(data.points[last+1]-1.1/sy)<1e-6);assert.equal(data.points[last+7],1);
  crew[31].visible=false;writeCrewWetnessData(data,{crew},boat);assert.equal(data.points[last+7],0,'explicit visibility deactivates that actor’s material probes');
  writeCrewWetnessData(data,{crew:crew.slice(0,1)},boat);assert.ok(data.points.subarray((data.crewOffset+4)*8).every(v=>v===0),'shrinking/absent company clears all removed actors');
  assert.throws(()=>writeCrewWetnessData(createWetnessData(crewWetMesh,1),{crew},boat),/allocated wetness probes/);
  writeCrewWetnessData(data,null,boat);assert.ok(data.points.subarray(data.crewOffset*8).every(v=>v===0));
});

test('source-mesh template cache separates crew counts while every vessel keeps independent mutable moisture',async()=>{
  const saved={B:globalThis.GPUBufferUsage,T:globalThis.GPUTextureUsage};globalThis.GPUBufferUsage={STORAGE:1,COPY_SRC:2,COPY_DST:4};globalThis.GPUTextureUsage={STORAGE_BINDING:1,TEXTURE_BINDING:2};
  const allocations=[],writes=[],device={createBuffer(descriptor){const b={...descriptor,destroy(){}};allocations.push(b);return b;},createTexture(){return {createView(){return {};},destroy(){}};},queue:{writeBuffer(buffer,offset,data){writes.push({buffer,offset,bytes:data.byteLength});}}};
  const computePipe=async()=>({getBindGroupLayout(){return {};}});
  try{
    const large=await createSurfaceWetness({device,mesh:crewWetMesh,computePipe,crewCount:32}),small=await createSurfaceWetness({device,mesh:crewWetMesh,computePipe,crewCount:1}),other=await createSurfaceWetness({device,mesh:crewWetMesh,computePipe,crewCount:32});
    assert.equal(large.probeCount-large.crewOffset,128);assert.equal(small.probeCount-small.crewOffset,4);assert.equal(other.probeCount-other.crewOffset,128);
    assert.notEqual(large.state,other.state);assert.notEqual(large.points,other.points);assert.equal(large.state.size,large.probeCount*8);assert.equal(small.state.size,small.probeCount*8);
    const company={crew:Array.from({length:32},()=>({visible:true,position:[0,.3,0],scale:[1,1,1]}))};large.updateCrew(company,crewWetBoat('oseberg'));
    const write=writes.at(-1);assert.equal(write.buffer,large.points);assert.equal(write.offset,large.crewOffset*32);assert.equal(write.bytes,32*4*32);
    assert.throws(()=>small.updateCrew(company,crewWetBoat('oseberg')),/allocated wetness probes/);
    large.destroy();small.destroy();other.destroy();assert.ok(allocations.length>0);
  }finally{if(saved.B===undefined)delete globalThis.GPUBufferUsage;else globalThis.GPUBufferUsage=saved.B;if(saved.T===undefined)delete globalThis.GPUTextureUsage;else globalThis.GPUTextureUsage=saved.T;}
});

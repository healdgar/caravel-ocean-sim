// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {SHIP_MODELS} from '../js/ship-models.js';
import {createShipAssetCache} from '../js/ship-mesh.js';
import {proceduralRigContext} from '../js/additional-rig.js';
import {ROWING_DESIGNS} from '../js/models/rowing.js';
import {rigSurfacePose} from '../js/rig-surface.js';
import {rowingStationPose,rowingSteeringPose} from '../js/rowing.js';
import {RIG_GPU_LAYOUT,createRigGPUData,createRigGPUFrame,writeRigGPUFrame} from '../js/rig-gpu-data.js';

const rigGPUDataTestHash=v=>createHash('sha256').update(new Uint8Array(v.buffer,v.byteOffset,v.byteLength)).digest('hex');
const rigGPUDataTestCache=createShipAssetCache();
const rigGPUDataTestModels=Object.values(SHIP_MODELS).filter(m=>m.status==='ready');
const rigGPUDataTestClose=(actual,expected,label)=>{
  assert.equal(actual.length,expected.length,label);
  for(let i=0;i<actual.length;i++)assert.ok(Math.abs(actual[i]-expected[i])<=Math.max(2e-6,Math.abs(expected[i])*2e-7),label+' component '+i+': '+actual[i]+' / '+expected[i]);
};

test('GPU rig packs every ready model without altering indexed positions, normals, UVs or materials',()=>{
  assert.equal(RIG_GPU_LAYOUT.vertexFloats,12);
  for(const model of rigGPUDataTestModels){
    const asset=rigGPUDataTestCache.get(model.id),sourceHash=rigGPUDataTestHash(asset.vertices),indexHash=rigGPUDataTestHash(asset.indices);
    const data=createRigGPUData(asset),packed=data.model,metadata=data.vertices,count=asset.vertices.length/9;
    assert.equal(data.modelId,model.id);assert.equal(packed[9],count,model.id);
    assert.equal(metadata.length,count*12,model.id);assert.ok(metadata.every(Number.isFinite),model.id);
    assert.ok(packed.every(Number.isFinite),model.id);assert.ok(Object.isFrozen(data),model.id);
    assert.equal(rigGPUDataTestHash(asset.vertices),sourceHash,model.id+' original vertex bytes');
    assert.equal(rigGPUDataTestHash(asset.indices),indexHash,model.id+' original index bytes');
    if(model.rig.backend!=='surfaces-v1'){
      assert.equal(packed[8],0,model.id+' canonical legacy GPU evaluator');
      assert.ok(metadata.every(v=>v===0),model.id);assert.equal(data.frameFloatCount,12);continue;
    }
    const context=proceduralRigContext(model.id),surfaceIds=new Map(context.surfaces.map((s,i)=>[s.id,i]));
    assert.equal(packed[8],1,model.id);assert.equal(packed[0],3);
    assert.equal(packed[1],context.surfaces.length);assert.equal(packed[2],3+context.surfaces.length*10);
    assert.equal(packed[3],context._surfaceCollisionSupports.length+(context.spars?.length??0));
    assert.equal(packed[4],packed[2]+packed[3]*4);assert.equal(packed[5],context.lines.length);
    assert.equal(packed[6],packed[4]+context.lines.length*10);assert.equal(packed[7],packed[6]+4);
    assert.equal(packed[11],packed[7]+1,'local table begins after unchanged global records');
    assert.equal(packed.length,(packed[11]+packed[1]*(4+3*packed[3]))*4);
    const categories=new Set();
    for(let i=0;i<count;i++){
      const at=i*9,m=i*12,kind=Math.floor(asset.vertices[at+6]),code=Math.round((asset.vertices[at+6]-kind)*64);
      const surface=surfaceIds.get(code),category=metadata[m];categories.add(category);
      if((kind===9||kind===13)&&surface!==undefined){
        assert.equal(category,1,model.id+' cloth '+i);assert.equal(metadata[m+1],surface);
        assert.equal(metadata[m+2],asset.vertices[at+7]);assert.equal(metadata[m+3],asset.vertices[at+8]);
      }else if(kind===10&&surface!==undefined){assert.equal(category,2,model.id+' spar '+i);assert.equal(metadata[m+1],surface);}
      else if(kind===12&&asset.vertices[at+7]>=100){
        assert.equal(category,3,model.id+' rope '+i);
        assert.equal(metadata[m+1],Math.round(asset.vertices[at+7]-100));assert.equal(metadata[m+2],asset.vertices[at+8]);
        assert.ok(Math.abs(Math.hypot(...metadata.subarray(m+8,m+11))-1)<2e-6,model.id+' preferred rope frame');
      }else if(Object.hasOwn(ROWING_DESIGNS,model.id)&&(kind===16||kind===17)){
        assert.equal(category,4,model.id+' actual oar/paddle '+i);
        assert.equal(metadata[m+1],kind===17?ROWING_DESIGNS[model.id].stations.length:code);
      }
    }
    assert.ok(categories.has(0),model.id+' rigid hull retained');
    if(context.surfaces.length){assert.ok(categories.has(1),model.id+' cloth');assert.ok(categories.has(2),model.id+' authored spars');assert.ok(categories.has(3),model.id+' attached ropes');}
    if(Object.hasOwn(ROWING_DESIGNS,model.id))assert.ok(categories.has(4),model.id+' propulsors');
  }
});

// The previous high/low reconstruction assertion tested stored bytes only.
// Native Metal tracing showed its compensated low terms optimized to zero.
// Validate pivot-local source differences instead; independent frozen CPU
// rest/pose goldens and native position/normal gates remain unchanged.
test('pivot-local tables reconstruct authored corners and static/moving support frames without global subtraction on the GPU',()=>{
  for(const model of rigGPUDataTestModels.filter(m=>m.rig.backend==='surfaces-v1')){
    const data=createRigGPUData(rigGPUDataTestCache.get(model.id)),packed=data.model,context=proceduralRigContext(model.id),stride=4+3*packed[3];
    const supports=[...context._surfaceCollisionSupports,...(context.spars??[]).map(s=>({a:s.a,b:s.b,r:s.radius,movingOwner:s.surface}))];
    const surfaces=new Map(context.surfaces.map(s=>[s.id,s]));
    const subtract=(a,b)=>a.map((v,k)=>v-b[k]);
    for(const [i,surface]of context.surfaces.entries()){
      const base=(packed[11]+i*stride)*4,global=(packed[0]+i*10)*4,pivot=surface.pivot;
      assert.deepEqual(packed.subarray(global+4,global+7),Float32Array.from(pivot),model.id+' global pivot unchanged');
      for(let corner=0;corner<4;corner++){
        const point=surface.corners[corner]??surface.corners[2],local=subtract(point,pivot),at=base+corner*4;
        assert.deepEqual(packed.subarray(at,at+4),Float32Array.from([...local,0]),model.id+' local corner '+i+'/'+corner);
        for(let k=0;k<3;k++)assert.ok(Math.abs(packed[at+k]+pivot[k]-point[k])<=Math.max(1e-9,Math.abs(local[k])*1e-7),model.id+' reconstructed corner');
      }
      for(const [j,support]of supports.entries()){
        const moving=support.movingOwner!==undefined,owner=moving?surfaces.get(support.movingOwner).pivot:pivot;
        const bridge=moving?subtract(owner,pivot):[0,0,0],at=base+16+j*12;
        assert.deepEqual(packed.subarray(at,at+12),Float32Array.from([...subtract(support.a,owner),support.r??0,
          ...subtract(support.b,owner),support.rEnd??support.r??0,...bridge,0]),model.id+' exact support frame '+i+'/'+j);
        const info=(packed[2]+j*4)*4+8;
        assert.equal(packed[info+2]>=0,moving,model.id+' existing owner metadata agrees');
      }
    }
    assert.equal(packed.length,(packed[11]+context.surfaces.length*stride)*4,model.id+' no residual/emulation tail');
  }
});

test('compact GPU frame follows live trim and physical propulsors with independent per-vessel storage',()=>{
  for(const model of rigGPUDataTestModels){
    const asset=rigGPUDataTestCache.get(model.id),data=createRigGPUData(asset),a=createRigGPUFrame(data),b=createRigGPUFrame(data);
    assert.notEqual(a,b);assert.equal(a.length,12+data.surfaceCount*8+data.bladeCount*16,model.id);
    const boat={modelId:model.id,...model.runtime,rudder:23,hatchesClosed:.4,
      sailState:{set:[.3,.6,.9],windSide:3.2,windForward:-2.5,rig:[0,1,2].map(i=>({yaw:.25,deployed:.2+i*.3,fill:.15+i*.2,side:-1,opening:.48,dip:.4,pressure:-.3}))},
      rowingState:{phase:.27,rate:.45,effortPort:.8,effortStarboard:.6}};
    assert.equal(writeRigGPUFrame(data,boat,7.25,14,a),a);
    assert.ok(a.every(Number.isFinite),model.id);assert.ok(b.every(v=>v===0),model.id+' second vessel untouched');
    rigGPUDataTestClose(a.subarray(0,4),[7.25,14,23*Math.PI/180,.6*Math.PI/2],model.id+' live controls');
    rigGPUDataTestClose(a.subarray(4,7),[model.runtime.beam/model.designFrame.beam,model.designFrame.verticalScale,model.runtime.length/model.designFrame.length],model.id+' design frame');
    if(model.rig.backend!=='surfaces-v1')continue;
    const context=proceduralRigContext(model.id);
    for(const [i,s]of context.surfaces.entries()){
      const p=rigSurfacePose(s,boat.sailState);
      rigGPUDataTestClose(a.subarray(12+i*8,12+(i+1)*8),[p.yaw,p.deployed,p.fill,p.side,p.opening,p.dip,p.pressure,0],model.id+' compact surface '+s.id);
    }
    if(Object.hasOwn(ROWING_DESIGNS,model.id)){
      const design=ROWING_DESIGNS[model.id],poses=design.stations.map(s=>rowingStationPose(boat,s.id,{time:7.25}));poses.push(rowingSteeringPose(boat,{time:7.25}));
      assert.equal(data.bladeCount,poses.length,model.id+' steering blade included');
      for(const [i,p]of poses.entries())rigGPUDataTestClose(a.subarray(data.bladeStateOffset+i*16,data.bladeStateOffset+(i+1)*16),
        [...p.bladeCentre,0,...p.bladeAlong,0,...p.bladeAcross,0,...p.bladeNormal,0],model.id+' physical blade '+i);
    }
    const before=new Float32Array(a);writeRigGPUFrame(data,{...boat,rudder:-13},17,20,b);assert.deepEqual(a,before,model.id+' unchanged prior vessel');
  }
});

test('live GPU frame never rereads asset vertices or static descriptor buffers',()=>{
  const model=rigGPUDataTestModels.find(m=>m.id==='flying-cloud');assert.ok(model);
  const source=new Float32Array(rigGPUDataTestCache.get(model.id).vertices),asset={model,vertices:source};
  const data=createRigGPUData(asset),frame=createRigGPUFrame(data);
  // Poison visual buffers after preparation. A hidden JavaScript deformation
  // loop or per-frame static repack would now fail or propagate NaNs.
  source.fill(NaN);data.vertices.fill(NaN);data.model.fill(NaN);
  Object.defineProperty(asset,'vertices',{get(){throw Error('Per-frame visual vertex access');}});
  writeRigGPUFrame(data,{modelId:model.id,...model.runtime},1,12,frame);
  assert.ok(frame.every(Number.isFinite));
  assert.equal(frame.length,12+proceduralRigContext(model.id).surfaces.length*8);
  assert.throws(()=>createRigGPUFrame({}),/Unknown GPU rig asset/);
  assert.throws(()=>writeRigGPUFrame(data,{modelId:'nina'},1,12,frame),/another ship model/);
  assert.throws(()=>writeRigGPUFrame(data,{modelId:model.id},1,12,new Float32Array(12)),/wrong shape/);
});

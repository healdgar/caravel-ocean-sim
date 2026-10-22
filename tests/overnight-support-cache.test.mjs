// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Exact pose parity, not a benchmark. Root alone executes this combined gate.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {PROCEDURAL_DESIGNS} from '../js/models/procedural.js';
import {ADDITIONAL_DESIGNS} from '../js/models/additional.js';
import {ROWING_DESIGNS} from '../js/models/rowing.js';
import {proceduralRigContext,laterSailSteeringPose} from '../js/additional-rig.js';
import {createAdditionalShipMesh,createAdditionalAssetPose} from '../js/additional-ships.js';
import {createRowingShipMesh,createRowingAssetPose} from '../js/rowing-ships.js';
import {createLaterSailShipMesh} from '../js/later-sail-ships.js';
import {rigSurfacePose,surfaceClothPoint,surfaceRopePoint,withRigPoseContext} from '../js/rig-surface.js';
import {indexCaravelMesh} from '../js/caravel.js';

for(const d of Object.values(PROCEDURAL_DESIGNS))test(`${d.id} static support preparation preserves actual posed vertex bytes and live cloth/rope results`,()=>{
  const context=proceduralRigContext(d.id),uncached={...context};delete uncached._surfaceCollisionSupports;
  assert.equal(proceduralRigContext(d.id),context);assert.ok(Object.isFrozen(context._surfaceCollisionSupports));
  assert.equal(context._surfaceCollisionSupports.length,(context.supports?.length??0)+(context.masts?.length??0));
  for(const support of context._surfaceCollisionSupports){assert.ok(Object.isFrozen(support)&&Object.isFrozen(support._surfaceAxis));for(const key of ['state','time','pressure','wind','poses'])assert.equal(Object.hasOwn(support,key),false);}
  const additional=Object.hasOwn(ADDITIONAL_DESIGNS,d.id),rowing=Object.hasOwn(ROWING_DESIGNS,d.id),raw=additional?createAdditionalShipMesh(d.id):rowing?createRowingShipMesh(d.id):createLaterSailShipMesh(d.id);
  const asset={model:{id:d.id},...indexCaravelMesh(raw)},makePose=c=>rowing?createRowingAssetPose(asset,{context:c}):createAdditionalAssetPose(asset,{design:d,context:c,...(!additional?{steeringPose:laterSailSteeringPose}:{})});
  const cachedPose=makePose(context),directPose=makePose(uncached),one=new Float32Array(asset.vertices),two=new Float32Array(asset.vertices),source=new Uint32Array(asset.vertices.buffer).slice();
  for(const [index,[set,fill,yaw]]of [[[1,1,1],1,0],[[.2,.4,.7],0,.40],[[.7,1,.3],.8,-.55]].entries()){
    const state={set,groupYaw:[yaw,-yaw,yaw],windSide:index===1?-8:7,windForward:6,rig:set.map(deployed=>({deployed,fill,side:index===1?1:-1,opening:.45,dip:0,pressure:1}))};
    const boat={modelId:d.id,...d.runtime,rudder:index*11-8,hatchesClosed:index*.4,sailState:state,rowingState:{phase:.2+index*.17,rate:.45,effortPort:.7,effortStarboard:.5}},time=index+1.4,wind=index===1?22:13;
    cachedPose(boat,time,wind,one);directPose(boat,time,wind,two);assert.deepEqual(new Uint32Array(one.buffer),new Uint32Array(two.buffer),'all actual compact position/normal/material/UV bytes match the uncached evaluator');
    const poses=new Map(d.surfaces.map(s=>[s.id,rigSurfacePose(s,state)])),live={...withRigPoseContext(context,state,poses),time,wind},direct={...withRigPoseContext(uncached,state,poses),time,wind};
    for(const surface of d.surfaces)for(const [u,v]of [[0,0],[.2,.3],[.5,.1]]){
      const p=poses.get(surface.id);assert.deepEqual(surfaceClothPoint(surface,u,v,p,live,time,wind),surfaceClothPoint(surface,u,v,p,direct,time,wind));
    }
    for(const line of (context.lines??[]).filter(l=>!l.static))for(const t of [0,.37,1])assert.deepEqual(surfaceRopePoint(line,t,live),surfaceRopePoint(line,t,direct));
    assert.deepEqual(new Uint32Array(asset.vertices.buffer),source,'prepared support use never mutates shared rest geometry');
  }
});

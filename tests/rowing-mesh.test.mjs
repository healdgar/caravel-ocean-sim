// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ROWING_DESIGNS,rowingRigContext} from '../js/models/rowing.js';
import {createRowingShipMesh,createRowingAssetPose} from '../js/rowing-ships.js';
import {rowingStationPose,rowingSteeringPose} from '../js/rowing.js';
import {hullLoftPoint,hullLoftBottom} from '../js/hull-loft.js';
import {surfaceClothPoint,rigSurfacePose} from '../js/rig-surface.js';
import {indexCaravelMesh} from '../js/caravel.js';

const rowingMeshTestCache=new Map(),rowingMeshTestNear=(a,b,e=2e-6)=>assert.ok(Math.abs(a-b)<=e*Math.max(1,Math.abs(a),Math.abs(b)),`${a} != ${b}`);
const rowingMeshTestKey=p=>p.map(v=>Math.round(v*1e5)).join('/');
function rowingMeshTestAsset(d){
  if(!rowingMeshTestCache.has(d.id)){const groups=[],parts=new Map(),raw=createRowingShipMesh(d.id,{groups,parts});rowingMeshTestCache.set(d.id,{model:{id:d.id},groups,parts,raw,...indexCaravelMesh(raw)});}
  return rowingMeshTestCache.get(d.id);
}
function rowingMeshTestPositions(mesh){const points=[];for(let i=0;i<mesh.length;i+=9)points.push(Array.from(mesh.subarray(i,i+3)));return points;}
test('each craft has its own closed open-top shell, seats, complete propulsors and period-specific equipment',()=>{
  for(const d of Object.values(ROWING_DESIGNS)){
    const asset=rowingMeshTestAsset(d),ids=new Set(asset.groups.map(g=>g.id));assert.equal(asset.raw.length%27,0);assert.ok(asset.raw.length/27<60_000);assert.ok(asset.raw.every(Number.isFinite));
    for(let i=0;i<asset.raw.length;i+=9)rowingMeshTestNear(Math.hypot(asset.raw[i+3],asset.raw[i+4],asset.raw[i+5]),1,1e-6);
    for(const id of ['hull.outer','hull.inner','hull.closed-shell','deck.floorboards','rowing.benches','hull.frames','hull.gunwales','helm.steering-oar','deck.stores'])assert.ok(ids.has(id),d.id+' '+id);
    assert.equal(ids.has('hull.keel'),!!d.keel);assert.equal(ids.has('hull.clinker-laps'),d.construction==='clinker-oak');
    assert.equal(asset.groups.filter(g=>g.id.startsWith('rowing.port.')).length,d.id==='oseberg'?30:0,'only the Oseberg interpretation has the thirty excavated-pattern hull oar ports');
    assert.equal(asset.groups.filter(g=>g.motion?.type==='rowing-blade').length,d.stations.length);
    assert.equal(asset.groups.filter(g=>g.id.startsWith('sail.')).length,d.surfaces.length);assert.equal(asset.groups.filter(g=>g.id.startsWith('mast.')).length,d.masts.length);
    for(const station of d.stations)assert.ok(ids.has('rowing.propulsor.'+station.id));
    for(const group of asset.groups){assert.equal(group.firstVertex%3,0);assert.equal(group.vertexCount%3,0);assert.ok(group.firstVertex+group.vertexCount<=asset.raw.length/9);}
  }
  const canoe=rowingMeshTestAsset(ROWING_DESIGNS['taino-canoe']);assert.equal(canoe.groups.some(g=>g.id.startsWith('mast.')||g.id.startsWith('sail.')),false);
});
test('rim closure meets both hull skins and only the Oseberg vessel has the authored exposed structural keel',()=>{
  for(const d of Object.values(ROWING_DESIGNS)){
    const a=rowingMeshTestAsset(d),outside=new Set(rowingMeshTestPositions(a.parts.get('hull.outer')).map(rowingMeshTestKey)),inside=new Set(rowingMeshTestPositions(a.parts.get('hull.inner')).map(rowingMeshTestKey));
    let joinedOuter=0,joinedInner=0;for(const p of rowingMeshTestPositions(a.parts.get('hull.closed-shell'))){if(outside.has(rowingMeshTestKey(p)))joinedOuter++;if(inside.has(rowingMeshTestKey(p)))joinedInner++;}
    assert.ok(joinedOuter>100&&joinedInner>100,'rim and ends close against actual skin vertices');
    for(const side of [-1,1])for(const z of d.profile.stations){const p=hullLoftPoint(d.profile,z,d.profile.deck,side);assert.ok(outside.has(rowingMeshTestKey(p)));}
    if(d.keel)for(const [x,y,z] of rowingMeshTestPositions(a.parts.get('hull.keel'))){rowingMeshTestNear(Math.abs(x),d.keel.width*.5);const gap=hullLoftBottom(d.profile,z)-y;assert.ok(Math.min(Math.abs(gap),Math.abs(gap-d.keel.depth))<2e-6);}
  }
});
test('posed blade vertices follow the exact force/hand frame while static hull records remain bit-identical',()=>{
  for(const d of Object.values(ROWING_DESIGNS)){
    const asset=rowingMeshTestAsset(d),pose=createRowingAssetPose(asset),sourceBits=new Uint32Array(asset.vertices.buffer).slice(),target=new Float32Array(asset.vertices);
    const restBoat={modelId:d.id,...d.runtime,rowingState:{phase:0,rate:0,effortPort:0,effortStarboard:0},rudder:0},scale=[d.runtime.beam/3.6,d.frame.verticalScale,d.runtime.length/12];
    const rest=d.stations.map(s=>rowingStationPose(restBoat,s.id));rest.push(rowingSteeringPose(restBoat));
    for(const phase of [.05,.22,.70]){
      const boat={modelId:d.id,...d.runtime,rowingState:{phase,rate:.45,effortPort:1,effortStarboard:.7},rudder:22,sailState:{set:[1],squareYaw:.2,windForward:4,windSide:3,rig:[{fill:.8}]}};
      assert.equal(pose(boat,1.8,7,target),true);const live=d.stations.map(s=>rowingStationPose(boat,s.id));live.push(rowingSteeringPose(boat));
      const bits=new Uint32Array(target.buffer);
      for(let i=0;i<sourceBits.length;i+=9){
        const kind=Math.floor(asset.vertices[i+6]),dynamic=[9,10,12,16,17].includes(kind);
        for(let j=0;j<9;j++)if(!dynamic||j>=6)assert.equal(bits[i+j],sourceBits[i+j]);
        rowingMeshTestNear(Math.hypot(target[i+3],target[i+4],target[i+5]),1,1e-5);
        if((kind===16||kind===17)&&i%63===0){
          const index=kind===17?d.stations.length:Math.round((asset.vertices[i+6]-kind)*64),r=rest[index],p=live[index],q=[0,1,2].map(j=>asset.vertices[i+j]*scale[j]-r.bladeCentre[j]);
          const dot=(a,b)=>a.reduce((sum,v,j)=>sum+v*b[j],0),local=[dot(q,r.bladeAlong),dot(q,r.bladeAcross),dot(q,r.bladeNormal)],axes=[p.bladeAlong,p.bladeAcross,p.bladeNormal];
          for(let j=0;j<3;j++)rowingMeshTestNear(target[i+j]*scale[j],p.bladeCentre[j]+axes.reduce((sum,a,k)=>sum+a[j]*local[k],0));
        }
        if(kind===9&&i%117===0){
          const surface=d.surfaces.find(s=>s.id===Math.round((asset.vertices[i+6]-kind)*64)),context={...rowingRigContext(d.id),state:boat.sailState},expected=surfaceClothPoint(surface,asset.vertices[i+7],asset.vertices[i+8],rigSurfacePose(surface,boat.sailState),context,1.8,7);
          for(let j=0;j<3;j++)rowingMeshTestNear(target[i+j],expected[j]);
        }
      }
    }
    assert.deepEqual(new Uint32Array(asset.vertices.buffer),sourceBits);assert.throws(()=>pose({},0,0,new Float32Array(9)),/wrong shape/);
  }
});

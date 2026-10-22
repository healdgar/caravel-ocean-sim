// Copyright (c) 2026 Six Cailloux, LLC. MIT. Root owns execution.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {ISLAND,decodeIsland,islandGeometry,terrainSurfaceSample,constrainIslandMotion,safeLandfallStart} from '../js/terrain-model.js';
import {validateTerrainNear,decodeTerrainNear,terrainNearContains,terrainNearSample,sampleTerrainNear,terrainNearGeometry,terrainNearPatchBounds,loadTerrainNear} from '../js/terrain-near.js';
import {createGroundCoverPatches} from '../js/vegetation.js';

const bytes=readFileSync(new URL('../assets/world/saba/height.bin',import.meta.url));
const base=decodeIsland(bytes.buffer.slice(bytes.byteOffset,bytes.byteOffset+bytes.byteLength));
const parent=JSON.parse(readFileSync(new URL('../assets/world/saba/manifest.json',import.meta.url),'utf8'));
const nearDomain={x:-1536,z:-6992,span:1024,size:513,spacing:2};
const receipt=length=>({bytes:length,sha256:'0'.repeat(64)});
function fixture(){
  const manifest={format:'waterworld.terrain-near',version:1,id:'wells-bay',region:'saba',domain:{...nearDomain},edgeBlendMetres:32,
    baseHeightSHA256:parent.heightSHA256,source:{sha256:parent.terrainSources[0].sha256,spacingMetres:.5,licence:'CC BY 4.0'},
    authoredWetCells:{provenance:'Synthetic test fixture only; no survey claim'},imagery:{url:'https://example.invalid/fixture',size:1024},
    files:{'height.bin':receipt(513*513*4),'measured.bin':receipt(513*513),'albedo.png':receipt(4)}};
  const heights=new Float32Array(513*513),measured=new Uint8Array(heights.length).fill(1);
  for(let j=0;j<513;j++)for(let i=0;i<513;i++)heights[j*513+i]=terrainSurfaceSample(base,-2048+i*2,-7504+j*2);
  heights[256*513+256]+=3;
  return {manifest,heights,measured};
}

test('near roots/depth use actual mesh triangles, including final edges, rather than bilinear height',()=>{
  const tile={bounds:[-1,1,-1,1],manifest:{domain:{size:2,spacing:2}},heights:new Float32Array([0,0,0,8])};
  assert.equal(terrainNearSample(tile,-.5,-.5),0);assert.equal(terrainNearSample(tile,0,0),0);
  assert.equal(terrainNearSample(tile,.5,.5),4);assert.equal(terrainNearSample(tile,1,1),8);
  assert.equal(terrainNearSample(tile,-1,1),0);assert.equal(terrainNearSample(tile,1,-1),0);
  assert.equal(terrainNearSample(tile,1.0001,0),null);assert.equal(terrainNearContains(null,0,0),false);
  const tileMoved={...tile,bounds:[-1501,-1499,-6901,-6899]};
  assert.equal(terrainNearSample(tileMoved,-1499.5,-6899.5),4,'world translation preserves physical triangles');
  assert.equal(sampleTerrainNear(null,base,-1200,-6700),terrainSurfaceSample(base,-1200,-6700));
});

test('registered near stream keeps every perimeter vertex on the original coarse triangle surface',()=>{
  const f=fixture(),before=base.slice();
  const tile=decodeTerrainNear(f.manifest,parent,f.heights.buffer,f.measured.buffer,base);
  assert.deepEqual(tile.bounds,[-2048,-1024,-7504,-6480]);assert.deepEqual(base,before,'preparing near geometry cannot change the resident survey');
  assert.equal(terrainNearSample(tile,-1536,-6992),f.heights[256*513+256]);
  for(let i=0;i<513;i++)for(const [x,z]of [[-2048+i*2,-7504],[-2048+i*2,-6480],[-2048,-7504+i*2],[-1024,-7504+i*2]])
    assert.ok(Math.abs(terrainNearSample(tile,x,z)-terrainSurfaceSample(base,x,z))<=1e-5,'shared edge has no height gap');
  const bad=f.heights.slice();bad[0]+=.01;
  assert.throws(()=>decodeTerrainNear(f.manifest,parent,bad.buffer,f.measured.buffer,base),/seam/);
  const nonfinite=f.heights.slice();nonfinite[100]=NaN;
  assert.throws(()=>decodeTerrainNear(f.manifest,parent,nonfinite.buffer,f.measured.buffer,base),/Nonfinite/);
  assert.throws(()=>decodeTerrainNear(f.manifest,parent,new ArrayBuffer(8),f.measured.buffer,base),/Incomplete/);
  assert.throws(()=>validateTerrainNear({...f.manifest,baseHeightSHA256:'bad'},parent),/registered/);
  assert.throws(()=>validateTerrainNear({...f.manifest,domain:{...nearDomain,x:nearDomain.x+1}},parent),/align/);
});

test('immutable near geometry replaces covered coarse cells and preserves positive winding and measured labels',()=>{
  const f=fixture(),tile=decodeTerrainNear(f.manifest,parent,f.heights.buffer,f.measured.buffer,base);
  tile.measured[256*513+256]=0;
  const coarse=islandGeometry(base,tile.bounds),mesh=terrainNearGeometry(tile,coarse);
  assert.equal(mesh.vertices.length,513*513*8);assert.equal(mesh.vertices[(256*513+256)*8+7],1,'authored/unmeasured support is explicitly marked');
  for(let i=0;i<mesh.vertices.length;i+=8){
    assert.ok(mesh.vertices.subarray(i,i+8).every(Number.isFinite));assert.ok(Math.abs(Math.hypot(...mesh.vertices.subarray(i+3,i+6))-1)<1e-5);
    assert.equal(mesh.vertices[i+6],1,'near material selection is mesh-owned');
  }
  for(const indices of [mesh.indices,mesh.submergedIndices])for(let i=0;i<indices.length;i+=3){
    const points=[0,1,2].map(k=>mesh.vertices.subarray(indices[i+k]*8,indices[i+k]*8+3));
    assert.ok((points[1][2]-points[0][2])*(points[2][0]-points[0][0])-(points[1][0]-points[0][0])*(points[2][2]-points[0][2])>0);
  }
  for(const indices of [coarse.indices,coarse.submergedIndices])for(let i=0;i<indices.length;i+=3){
    const x=(coarse.vertices[indices[i]*8]+coarse.vertices[indices[i+1]*8]+coarse.vertices[indices[i+2]*8])/3;
    const z=(coarse.vertices[indices[i]*8+2]+coarse.vertices[indices[i+1]*8+2]+coarse.vertices[indices[i+2]*8+2])/3;
    assert.ok(!terrainNearContains(tile,x,z),'covered coarse triangles cannot z-fight with near geometry');
  }
});

test('near detail contributes conservative ground patch bounds without changing vegetation policy',()=>{
  const heights=new Float32Array(33*33).fill(10);heights[9*33+9]=30;
  const tile={bounds:[0,64,0,64],manifest:{domain:{size:33,spacing:2}},heights};
  assert.deepEqual(terrainNearPatchBounds(tile,0,0,64),{low:10,high:30});assert.equal(terrainNearPatchBounds(tile,80,80,64),null);
  const region={x:32,z:32,span:64,size:5,vegetationSeed:1};
  const patches=createGroundCoverPatches(region,()=>10,(x,z,span)=>terrainNearPatchBounds(tile,x,z,span));
  assert.equal(patches.length,1);assert.ok(patches[0].centre[1]+patches[0].radius>=30,'fine peaks cannot escape the visibility bound');
});

test('coastal camera and full-hull clearance accept the same fine-surface sampler',()=>{
  const boat={length:20,beam:6,hydrodynamics:{draft:2},surgeVelocity:3,leewayVelocity:.2,x:-1750,z:-7000};
  let samples=0;const depth=()=>{samples++;return -30;};
  const start=safeLandfallStart(base,{x:boat.x,z:boat.z},boat,ISLAND,depth);assert.equal(start.depth,30);assert.equal(start.moved,false);assert.ok(samples>=10);
  assert.equal(constrainIslandMotion(base,boat,boat.x,boat.z,()=>0),true);assert.equal(boat.surgeVelocity,0,'fine ground prevents coastal tunneling');
});

test('absent optional near metadata causes no request or invented tile',async()=>{
  const noNear={...parent};delete noNear.nearTile;
  assert.equal(await loadTerrainNear({baseManifest:noNear,baseHeights:base,fetchAsset(){throw Error('Absent optional pack fetched');}}),null);
});

// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Proposed source regressions; root owns execution and rendered acceptance.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {TREE_VARIANTS,TREE_VERTEX_FLOATS,seedVegetation,treeSkeleton,treeCanopyGeometry,
  treeRenderGeometry,treeGeometry,createForestPatches,visibleForestIds,selectTreeLods,
  TREE_GEOMETRY_ERRORS,measureTreeLodErrors,treeProjectedError,TREE_PIXEL_ERROR} from '../js/vegetation.js';

test('increased regional density extends the same seeded plants and respects bare/wet ground',()=>{
  const region={span:512,x:0,z:0,biomeSize:8,vegetationSeed:47231,vegetationCandidates:96},mask=new Uint8Array(64).fill(255);
  const old=seedVegetation(region,()=>50,mask),dense=seedVegetation({...region,vegetationCandidates:960},()=>50,mask);
  assert.deepEqual(dense.subarray(0,old.length),old,'density cannot regrow the original roots or dimensions');
  assert.ok(dense.length>old.length*7,'larger candidate stream materially increases stand population');
  assert.deepEqual(dense,seedVegetation({...region,vegetationCandidates:960},()=>50,mask));
  assert.equal(seedVegetation(region,()=>50,new Uint8Array(64)).length,0,'bare biome stays bare');
  assert.equal(seedVegetation(region,()=>-2,mask).length,0,'water stays clear');
});

test('distant crowns are bounded opaque three-dimensional bough aggregates with a rooted trunk',()=>{
  for(let variant=0;variant<TREE_VARIANTS;variant++){
    const geometry=treeCanopyGeometry(variant),skeleton=treeSkeleton(variant),low=[Infinity,Infinity,Infinity],high=[-Infinity,-Infinity,-Infinity];
    for(const s of skeleton.sprays)for(const p of s.corners)for(let k=0;k<3;k++){low[k]=Math.min(low[k],p[k]);high[k]=Math.max(high[k],p[k]);}
    assert.ok(geometry.length/(TREE_VERTEX_FLOATS*3)<=300,'far detail is bounded independently of near branch complexity');
    let crowns=0,wood=0,trunkRoot=false;
    for(let i=0;i<geometry.length;i+=TREE_VERTEX_FLOATS){
      const v=geometry.subarray(i,i+TREE_VERTEX_FLOATS);assert.ok(v.every(Number.isFinite));
      assert.ok(Math.abs(Math.hypot(...v.subarray(3,6))-1)<1e-5);
      assert.ok(v[6]===3||v[6]===4,'distant geometry has no alpha-cutout leaves');
      if(v[6]===4){crowns++;for(let k=0;k<3;k++)assert.ok(v[k]>=low[k]-1e-6&&v[k]<=high[k]+1e-6,'aggregate remains within canonical foliage bounds');}
      else{wood++;if(v[1]===0)trunkRoot=true;}
    }
    assert.ok(crowns>100&&wood>=18&&trunkRoot,'crown masses retain visible supporting wood and the original root');
    for(let i=0;i<geometry.length;i+=TREE_VERTEX_FLOATS*3){
      const a=geometry.subarray(i,i+3),b=geometry.subarray(i+TREE_VERTEX_FLOATS,i+TREE_VERTEX_FLOATS+3),c=geometry.subarray(i+TREE_VERTEX_FLOATS*2,i+TREE_VERTEX_FLOATS*2+3);
      const u=b.map((v,k)=>v-a[k]),v=c.map((q,k)=>q-a[k]);
      assert.ok(Math.hypot(u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0])>1e-10,'aggregate triangles have finite area');
    }
    assert.equal(treeRenderGeometry(variant,0),geometry);
    for(const lod of[1,2])assert.deepEqual(treeRenderGeometry(variant,lod),treeGeometry(variant,lod),'near and middle plants stay unchanged');
  }
});

test('spatial culling uses actual projection, conservatively retains intersecting crowns and keeps source IDs',()=>{
  const trees=new Float32Array([0,0,-100,4,12,.1,0,0, 0,0,100,4,12,.5,0,0, 2000,0,-100,4,12,.9,0,0]);
  const patches=createForestPatches(trees,32),camera={x:0,y:6,z:0};
  const matrix=new Float32Array([1,0,0,0,0,1,0,0,0,0,0,-1,0,0,.05,0]);
  assert.deepEqual(visibleForestIds(patches,camera,matrix),[0],'front patch survives, rear and far-side patches do not');
  assert.deepEqual(visibleForestIds(patches,camera).sort((a,b)=>a-b),[0,1,2],'missing world projection must not guess a captain camera');
  const selected=selectTreeLods(trees,camera,new Map(),undefined,[2,0]);
  assert.deepEqual(selected.map(t=>t.id),[0,2],'culling selects stable original instance IDs');
  assert.deepEqual(trees,new Float32Array([0,0,-100,4,12,.1,0,0,0,0,100,4,12,.5,0,0,2000,0,-100,4,12,.9,0,0]));
});

test('cached geometry bounds match source and projected LOD follows actual pixels, FOV and depth',()=>{
  for(let variant=0;variant<TREE_VARIANTS;variant++)assert.deepEqual(measureTreeLodErrors(variant),TREE_GEOMETRY_ERRORS[variant]);
  const tree=new Float32Array([0,0,-1500,5,14,.1,0,0]);
  const camera={x:0,y:7,z:0,screenHeight:600,tanHalfFovY:Math.tan(Math.PI/6),forward:[0,0,-1]};
  const e=treeProjectedError(.1,tree,camera);
  assert.ok(Math.abs(treeProjectedError(.1,tree,{...camera,screenHeight:1200})/e-2)<1e-10);
  assert.ok(Math.abs(treeProjectedError(.1,tree,{...camera,tanHalfFovY:camera.tanHalfFovY/2})/e-2)<1e-10);
  const low=selectTreeLods(tree,camera),high=selectTreeLods(tree,{...camera,screenHeight:2400});
  assert.ok(high[0].lod>=low[0].lod,'more rendered pixels cannot silently reduce detail');
  for(const item of [...low,...high])assert.ok(item.projectedError<=TREE_PIXEL_ERROR*1.12,'selected geometry respects the pixel target including hysteresis');
  const many=new Float32Array(120*8);for(let i=0;i<120;i++)many.set([0,0,-10,5,14,.1,0,0],i*8);
  const near=selectTreeLods(many,camera);assert.ok(near.every(t=>t.lod===2),'a legacy count budget cannot violate visible geometric error');
  assert.ok(near.some(t=>t.qualityBudgetOverflow),'quality pressure is exposed for profiling');
});

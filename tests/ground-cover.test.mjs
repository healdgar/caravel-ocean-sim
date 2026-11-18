// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Source guards only; rendered visibility and performance require root checks.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {terrainSample,terrainSurfaceSample} from '../js/terrain-model.js';
import {GROUND_COVER,createGroundCoverPatches,groundCoverInstances} from '../js/vegetation.js';

const close=(actual,expected,tolerance=1e-6)=>assert.ok(Math.abs(actual-expected)<=tolerance,`${actual} differs from ${expected}`);
const dot=(a,b)=>a.reduce((sum,v,i)=>sum+v*b[i],0);
const region={x:0,z:0,span:128,size:9,biomeSize:8,vegetationSeed:47231};

test('ground heights follow the mesh diagonal rather than bilinear interpolation',()=>{
  // The first triangle is flat; only the opposite corner rises. Bilinear
  // interpolation incorrectly lifts props off that first rendered triangle.
  const r={x:0,z:0,span:2,size:2},h=new Float32Array([0,0,0,8]);
  close(terrainSurfaceSample(h,-.5,-.5,r),0);
  close(terrainSample(h,-.5,-.5,r),.5);
  close(terrainSurfaceSample(h,.5,.5,r),4);
  close(terrainSurfaceSample(h,0,0,r),0);
  close(terrainSurfaceSample(h,.5,-.5,r),0);
  assert.equal(terrainSurfaceSample(h,2,0,r),-120,'outside resident geometry stays ocean');
});

// Ground cover is now only the rocks lying about the land, which the boulder continuum draws; grass is the meadow's.
test('patches and their rocks are deterministic, grounded on an incline and kept off forbidden ground',()=>{
  const plane=(x,z)=>60+x*.25-z*.125;
  const a=createGroundCoverPatches(region,plane),b=createGroundCoverPatches(region,plane);
  assert.deepEqual(a,b);assert.equal(a.length,4);
  assert.ok(a.every(p=>p.instances===null),'patch creation must not eagerly expand individual rocks');
  let rocks=0;
  for(let p=0;p<a.length;p++){
    const first=groundCoverInstances(a[p],plane),second=groundCoverInstances(b[p],plane);
    assert.deepEqual(first,second);assert.equal(groundCoverInstances(a[p],()=>{throw Error('cached patch resampled');}),first);
    assert.equal(first.length,2,'two rock groups, by seed');
    for(let group=0;group<first.length;group++)for(let i=0;i<first[group].length;i+=8){
      const v=first[group].subarray(i,i+8);assert.ok(v.every(Number.isFinite));
      close(v[1],plane(v[0],v[2]),1e-5);close(v[6],.25);close(v[7],-.125);
      assert.ok(v[0]>=a[p].x&&v[0]<a[p].x+GROUND_COVER.patchSpan);
      assert.ok(v[2]>=a[p].z&&v[2]<a[p].z+GROUND_COVER.patchSpan);
      assert.equal(v[5]>.5?1:0,group,'a rock\'s group is its seed\'s');
      // The stored gradient defines the true terrain tangent plane used for
      // rigid rock alignment, rather than scaling height by the ground slope.
      const normal=[-v[6],1,-v[7]];close(dot(normal,[1,.25,0]),0);close(dot(normal,[0,-.125,1]),0);
      rocks++;
    }
    assert.ok(first[0].length+first[1].length<=GROUND_COVER.rocksPerPatch*8);
    const barred=createGroundCoverPatches(region,plane)[p],none=groundCoverInstances(barred,plane,()=>false);
    assert.equal(none[0].length+none[1].length,0,'no rock lies where the caller forbids (streets, inland water)');
  }
  assert.ok(rocks>0,'inclined fixture lays rocks');
  assert.equal(createGroundCoverPatches(region,()=>-2).length,0,'submerged patches are not resident');
  assert.equal(createGroundCoverPatches(region,()=>900).length,0,'summit exclusion remains bounded');
  const cliff=createGroundCoverPatches(region,(x)=>300+x*2);
  for(const patch of cliff){const groups=groundCoverInstances(patch,(x)=>300+x*2);assert.ok(groups.every(g=>g.length===0),'steep cliffs reject unsupported rocks');}
});


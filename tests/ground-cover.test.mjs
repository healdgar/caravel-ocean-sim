// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Source guards only; rendered visibility and performance require root checks.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {terrainSample,terrainSurfaceSample} from '../js/terrain-model.js';
import {GROUND_COVER,TREE_VERTEX_FLOATS,TREE_PIXEL_ERROR,createGroundCoverPatches,groundCoverInstances,
  groundCoverGeometry,groundCoverError,projectedGroundExtent,groundCoverVisible} from '../js/vegetation.js';

const close=(actual,expected,tolerance=1e-6)=>assert.ok(Math.abs(actual-expected)<=tolerance,`${actual} differs from ${expected}`);
const sub=(a,b)=>a.map((v,i)=>v-b[i]);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const dot=(a,b)=>a.reduce((sum,v,i)=>sum+v*b[i],0);
const region={x:0,z:0,span:128,size:9,biomeSize:8,vegetationSeed:47231};
const mask=new Uint8Array(region.biomeSize**2).fill(255);

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

test('patches and prop roots are deterministic, grounded on an incline and preserve biome exclusions',()=>{
  const plane=(x,z)=>60+x*.25-z*.125;
  const a=createGroundCoverPatches(region,plane),b=createGroundCoverPatches(region,plane);
  assert.deepEqual(a,b);assert.equal(a.length,4);
  assert.ok(a.every(p=>p.instances===null),'patch creation must not eagerly expand individual props');
  let grass=0,rocks=0;
  for(let p=0;p<a.length;p++){
    const first=groundCoverInstances(a[p],region,plane,mask),second=groundCoverInstances(b[p],region,plane,mask);
    assert.deepEqual(first,second);assert.equal(groundCoverInstances(a[p],region,()=>{throw Error('cached patch resampled');},mask),first);
    for(let variant=0;variant<first.length;variant++)for(let i=0;i<first[variant].length;i+=8){
      const v=first[variant].subarray(i,i+8);assert.ok(v.every(Number.isFinite));
      close(v[1],plane(v[0],v[2]),1e-5);close(v[6],.25);close(v[7],-.125);
      assert.ok(v[0]>=a[p].x&&v[0]<a[p].x+GROUND_COVER.patchSpan);
      assert.ok(v[2]>=a[p].z&&v[2]<a[p].z+GROUND_COVER.patchSpan);
      // The stored gradient defines the true terrain tangent plane used for
      // rigid prop alignment, rather than scaling height by the ground slope.
      const normal=[-v[6],1,-v[7]];close(dot(normal,[1,.25,0]),0);close(dot(normal,[0,-.125,1]),0);
      variant<2?rocks++:grass++;
    }
    const bare=createGroundCoverPatches(region,plane)[p],empty=groundCoverInstances(bare,region,plane,new Uint8Array(mask.length));
    assert.equal(empty[2].length+empty[3].length,0,'bare biome cannot grow grass');
  }
  assert.ok(grass>0&&rocks>0,'inclined fixture exercises both material families');
  assert.equal(createGroundCoverPatches(region,()=>-2).length,0,'submerged patches are not resident');
  assert.equal(createGroundCoverPatches(region,()=>900).length,0,'summit exclusion remains bounded');
  const cliff=createGroundCoverPatches(region,(x)=>300+x*2);
  for(const patch of cliff){const groups=groundCoverInstances(patch,region,(x)=>300+x*2,mask);assert.ok(groups.every(g=>g.length===0),'steep cliffs reject unsupported props');}
});

test('ground meshes are finite opaque 3D surfaces with valid winding and conservative physical bounds',()=>{
  for(let variant=0;variant<GROUND_COVER.variants;variant++){
    const mesh=groundCoverGeometry(variant),rock=variant<2;
    assert.equal(mesh.length%(TREE_VERTEX_FLOATS*3),0);
    assert.equal(mesh.length/(TREE_VERTEX_FLOATS*3),rock?48:90,'canonical prop geometry stays bounded');
    assert.equal(groundCoverGeometry(variant),mesh,'canonical meshes are shared across instances');
    const edges=new Map();let volume=0,grounded=false,below=false,above=false;
    for(let i=0;i<mesh.length;i+=TREE_VERTEX_FLOATS*3){
      const v=[0,1,2].map(k=>Array.from(mesh.subarray(i+k*TREE_VERTEX_FLOATS,i+(k+1)*TREE_VERTEX_FLOATS))),points=v.map(p=>p.slice(0,3));
      for(const p of v){
        assert.ok(p.every(Number.isFinite));close(Math.hypot(...p.slice(3,6)),1,1e-5);
        assert.equal(p[6],rock?6:7,'ground props never use alpha-card foliage');
        grounded||=p[1]===0;below||=p[1]<0;above||=p[1]>.5;
        // These are the maximum authored instance dimensions. Rotation to a
        // terrain normal preserves distance; the 20% envelope covers wind.
        const radius=rock?2.45:1.8,height=rock?2.1:.8;
        assert.ok(Math.hypot(p[0]*radius,p[1]*height,p[2]*radius)*1.2<=GROUND_COVER.maxExtent+1e-5);
      }
      const face=cross(sub(points[1],points[0]),sub(points[2],points[0])),area=Math.hypot(...face);
      assert.ok(area>1e-9,'no degenerate triangles');
      for(const p of v)assert.ok(dot(face,p.slice(3,6))/area>.99999,'normal agrees with triangle winding');
      if(rock){
        const outward=points[0].map((_,k)=>(points[0][k]+points[1][k]+points[2][k])/3-(k===1?.3:0));
        assert.ok(dot(face,outward)>0,'rock normals face away from its enclosed interior');
        volume+=dot(points[0],cross(points[1],points[2]))/6;
        for(let j=0;j<3;j++){
          const a=points[j].join(','),b=points[(j+1)%3].join(','),key=[a,b].sort().join('|'),edge=edges.get(key)??{count:0,balance:0};
          edge.count++;edge.balance+=a<b?1:-1;edges.set(key,edge);
        }
      }
    }
    if(rock){assert.ok(volume>0&&below&&above,'rock is a closed outward solid with a buried base');for(const edge of edges.values())assert.deepEqual(edge,{count:2,balance:0});}
    else assert.ok(grounded&&above,'grass blades attach at the ground and extend above it');
  }
});

test('ground omission uses actual render pixels, FOV, off-axis depth and stable hysteresis',()=>{
  const camera={x:0,y:0,z:0,screenHeight:800,tanHalfFovY:.6,forward:[0,0,-1]};
  const error=groundCoverError(0,0,-800,1,.7,camera);assert.ok(Number.isFinite(error)&&error>0);
  close(groundCoverError(0,0,-800,1,.7,{...camera,screenHeight:1600}),error*2);
  close(groundCoverError(0,0,-800,1,.7,{...camera,tanHalfFovY:1.2}),error*.5);
  close(groundCoverError(0,0,-800,1,.7,{...camera,forward:[0,0,-4]}),error);
  assert.ok(groundCoverError(400,0,-800,1,.7,camera)>error,'oblique projection cannot understate geometric error');
  assert.ok(projectedGroundExtent(0,0,-800,GROUND_COVER.maxExtent,camera,60)>projectedGroundExtent(0,0,-800,GROUND_COVER.maxExtent,camera));
  assert.equal(groundCoverError(0,0,5,1,.7,camera),Infinity);
  assert.equal(groundCoverError(0,0,-800,1,.7,{...camera,screenHeight:0}),Infinity,'unknown projection keeps quality');
  assert.equal(groundCoverVisible(TREE_PIXEL_ERROR+.01),true,'never omit a resolvable prop for a budget');
  assert.equal(groundCoverVisible(TREE_PIXEL_ERROR-.1),false);
  assert.equal(groundCoverVisible(TREE_PIXEL_ERROR-.1,true),true,'existing prop survives small threshold oscillations');
  assert.equal(groundCoverVisible(TREE_PIXEL_ERROR*.8,true),false);
  assert.equal(groundCoverVisible(Infinity),true);assert.equal(groundCoverVisible(NaN),true);
  // Independently project every actual mesh vertex at several offsets. The
  // runtime extent bound must dominate these sampled screen displacements.
  for(let variant=0;variant<GROUND_COVER.variants;variant++){
    const mesh=groundCoverGeometry(variant),radius=variant<2?2.45:1.8,height=variant<2?2.1:.8;
    for(const x of[0,300]){
      const z=-800,bound=groundCoverError(x,0,z,radius,height,camera),focal=camera.screenHeight/(2*camera.tanHalfFovY);
      for(let i=0;i<mesh.length;i+=TREE_VERTEX_FLOATS){
        const px=x+mesh[i]*radius,py=mesh[i+1]*height,pz=z+mesh[i+2]*radius;
        assert.ok(Math.hypot(focal*px/-pz-focal*x/-z,focal*py/-pz)<=bound+1e-6,'conservative bound contains projected prop geometry');
      }
    }
  }
});

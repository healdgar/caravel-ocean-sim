import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {ISLAND,LANDFALL_VIEWS,decodeIsland,islandGeometry,islandVegetation,terrainSample,islandCoordinates,constrainIslandMotion} from '../js/terrain-model.js';
const file=await readFile(new URL('../assets/world/saba/height.bin',import.meta.url));
const heights=decodeIsland(file.buffer.slice(file.byteOffset,file.byteOffset+file.byteLength));

test('real Saba elevation has coherent scale, winding and finite surface normals',()=>{
  const mesh=islandGeometry(heights);
  assert.equal(heights.length,257**2);assert.ok(Math.max(...heights)>850&&Math.max(...heights)<900);
  assert.ok(mesh.indices.length/3<40000,'land mesh stays bounded');
  for(let i=0;i<mesh.vertices.length;i+=8){
    assert.ok(mesh.vertices.slice(i,i+8).every(Number.isFinite));
    assert.ok(Math.abs(Math.hypot(...mesh.vertices.slice(i+3,i+6))-1)<1e-5);
  }
  for(let i=0;i<mesh.indices.length;i+=3){
    const [a,b,c]=Array.from(mesh.indices.slice(i,i+3),v=>mesh.vertices.slice(v*8,v*8+3));
    assert.ok((b[2]-a[2])*(c[0]-a[0])-(b[0]-a[0])*(c[2]-a[2])>0,'upward winding');
  }
  assert.throws(()=>decodeIsland(new ArrayBuffer(4)),/Incomplete/);
});

test('all landfall starts give the loaded ship water clearance and stable geographic coordinates',()=>{
  for(const p of Object.values(LANDFALL_VIEWS)){
    const boat={...p,length:20,beam:6,hydrodynamics:{draft:2.1}};
    assert.equal(constrainIslandMotion(heights,boat,p.x,p.z),false);
    assert.ok(terrainSample(heights,p.x,p.z)<-3);
  }
  assert.deepEqual(islandCoordinates(ISLAND.x,ISLAND.z),{latitude:ISLAND.latitude,longitude:ISLAND.longitude});
  assert.ok(islandCoordinates(ISLAND.x,ISLAND.z-1000).latitude>ISLAND.latitude);
});

test('coastal clearance sweeps the whole path and leaves open-ocean speed unchanged',()=>{
  const boat={x:0,z:-6000,length:20,beam:6,surgeVelocity:3,leewayVelocity:.1};
  assert.equal(constrainIslandMotion(heights,boat,0,0),true,'cannot tunnel into mountain');
  assert.ok(boat.z>-6000);assert.equal(boat.surgeVelocity,0);
  const open={x:0,z:1000,length:20,beam:6,surgeVelocity:3,leewayVelocity:.1};
  assert.equal(constrainIslandMotion(heights,open,0,1010),false);
  assert.equal(open.surgeVelocity,3);assert.equal(open.z,1000);
});

test('vegetation is deterministic, finite and rooted on dry ground',()=>{
  const trees=islandVegetation(heights);assert.deepEqual(trees,islandVegetation(heights));
  assert.ok(trees.length/8>2000&&trees.length/8<8000);
  for(let i=0;i<trees.length;i+=8){
    assert.ok(trees.slice(i,i+8).every(Number.isFinite));
    assert.ok(Math.abs(trees[i+1]-terrainSample(heights,trees[i],trees[i+2]))<.05);
    assert.ok(trees[i+1]>19);
  }
});

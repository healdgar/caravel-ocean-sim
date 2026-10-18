import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCaravelMesh, indexCaravelMesh } from '../js/caravel.js';
import { shadowMeshData } from '../js/shadows.js';
import { hullHalfWidth, hullSurfacePoint, HULL_DRAFT, vesselDeck, WHEEL_CENTER, HELM_EYE_Z } from '../js/hull.js';

test('indexed caravel preserves every vertex bit, triangle, and shadow partition',()=>{
  const raw=createCaravelMesh(),indexed=indexCaravelMesh(raw);
  const bits=new Uint32Array(raw.buffer),compact=new Uint32Array(indexed.vertices.buffer);
  function expand(mesh,indices){
    const out=new Uint32Array(indices.length*9);
    for(let i=0;i<indices.length;i++)out.set(mesh.subarray(indices[i]*9,indices[i]*9+9),i*9);
    return out;
  }
  assert.deepEqual(expand(compact,indexed.indices),bits);
  assert.ok(indexed.vertices.byteLength+indexed.indices.byteLength<raw.byteLength*.55);
  const oldShadows=shadowMeshData(raw),newShadows=shadowMeshData(indexed.vertices,indexed.indices);
  assert.deepEqual(newShadows.bounds,oldShadows.bounds);
  for(const part of ['solid','canvas'])assert.deepEqual(expand(compact,newShadows[part]),expand(bits,oldShadows[part]));
  // Position-only welding would destroy normal/material/UV seams and signed zero.
  const seams=new Float32Array(11*9);
  for(let i=2;i<11;i++)seams[i*9+i-2]=1;
  seams[0]=-0;
  assert.equal(indexCaravelMesh(seams).vertices.length,seams.length);
});
test('caravel mesh has finite triangles, unit normals, and a forward bowsprit', () => {
  const mesh = createCaravelMesh();
  assert.equal(mesh.length % 27, 0);
  assert.ok(mesh.every(Number.isFinite));
  let forward = 0;
  for (let i = 0; i < mesh.length; i += 9) {
    assert.ok(Math.abs(Math.hypot(mesh[i+3],mesh[i+4],mesh[i+5])-1)<1e-6);
    forward = Math.min(forward, mesh[i+2]);
  }
  assert.ok(forward < -10);
});

test('complete vessel includes stern, submerged hull, five canvas panels, and a working rudder', () => {
  const mesh=createCaravelMesh();
  const bounds=new Map();
  for(let i=0;i<mesh.length;i+=9){
    const material=mesh[i+6];
    if(!bounds.has(material))bounds.set(material,{minY:Infinity,maxY:-Infinity,minZ:Infinity,maxZ:-Infinity,count:0});
    const b=bounds.get(material);b.minY=Math.min(b.minY,mesh[i+1]);b.maxY=Math.max(b.maxY,mesh[i+1]);
    b.minZ=Math.min(b.minZ,mesh[i+2]);b.maxZ=Math.max(b.maxZ,mesh[i+2]);b.count++;
  }
  assert.ok(bounds.get(15).minY<-1.4);
  assert.ok(bounds.get(15).minZ<=-6.39 && bounds.get(15).maxZ>=5.59);
  assert.ok(bounds.get(9).count>=4*28*20*6);
  assert.ok(bounds.get(9).maxY>10 && bounds.get(9).minZ<-4);
  assert.ok(bounds.get(13).count>1000 && bounds.get(13).maxZ>6 && bounds.get(13).minY>4.1);
  assert.ok(bounds.get(16).count>100 && bounds.get(17).maxY>2.7);
  assert.ok(bounds.get(10).maxY>=11.49);
  assert.ok(bounds.get(14).maxZ>6 && bounds.get(14).minY<-1.2);
  assert.ok(bounds.get(11).minZ>3);
});

test('raked hull surface agrees with water-contact sections and stays within the mesh budget', () => {
  for(let z=-6.4;z<=5.6;z+=.2)for(let a=0;a<=Math.PI;a+=.08){
    const [x,y,station]=hullSurfacePoint(z,a);
    assert.ok(Math.abs(Math.abs(x)-hullHalfWidth(station,y))<1e-7);
  }
  assert.equal(hullHalfWidth(-6.4,-.5),0, 'raked stem clears the water ahead of the submerged bow');
  assert.equal(hullHalfWidth(0,-HULL_DRAFT-.1),0);
  assert.ok(createCaravelMesh().length/27<95000,'single ship stays below 95k triangles');
});

// Intersect actual triangles, so tests catch planking/trim occluding an opening.
function firstHit(mesh,origin,direction){
  const sub=(a,b)=>a.map((x,i)=>x-b[i]);
  const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
  const dot=(a,b)=>a.reduce((s,x,i)=>s+x*b[i],0);
  let distance=Infinity,material=-1;
  for(let i=0;i<mesh.length;i+=27){
    const a=Array.from(mesh.slice(i,i+3)),b=Array.from(mesh.slice(i+9,i+12)),c=Array.from(mesh.slice(i+18,i+21));
    const e1=sub(b,a),e2=sub(c,a),p=cross(direction,e2),det=dot(e1,p);
    if(Math.abs(det)<1e-9)continue;
    const t=sub(origin,a),u=dot(t,p)/det;if(u<0 || u>1)continue;
    const q=cross(t,e1),v=dot(direction,q)/det;if(v<0 || u+v>1)continue;
    const d=dot(e2,q)/det;
    if(d>=0 && d<distance){distance=d;material=mesh[i+6];}
  }
  return {material,point:origin.map((x,i)=>x+direction[i]*distance)};
}

test('all nine cabin windows have unobstructed recessed glazing inside real wall openings',()=>{
  const mesh=createCaravelMesh();
  for(const x of [-.7,0,.7]){
    const hit=firstHit(mesh,[x+.1,1.60,6.5],[0,0,-1]);
    assert.equal(hit.material,11,'stern planking must not cross a pane');
    assert.ok(hit.point[2]<5.55 && hit.point[2]>5.50,'glass sits behind the transom face');
  }
  for(const side of [-1,1])for(const z of [3.4,4.35,5.18]){
    const hit=firstHit(mesh,[side*3,1.60,z+.1],[-side,0,0]);
    assert.equal(hit.material,11,'side planking must not cross a pane');
    assert.ok(Math.abs(Math.abs(hit.point[0])-hullHalfWidth(z+.1,1.6)+.08)<.001);
    assert.equal(firstHit(mesh,[side*3,2.12,z+.1],[-side,0,0]).material,1,'wood closes above the arch');
  }
});

test('raised decks and lookout have solid floors; the working helm sits aft on the quarterdeck',()=>{
  const mesh=createCaravelMesh();
  for(const z of [-5,-1.9,3.1]){
    const hit=firstHit(mesh,[.3,3,z],[0,-1,0]);
    assert.equal(hit.material,0);
    assert.ok(Math.abs(hit.point[1]-vesselDeck(z))<.003,'visible deck agrees with the water floor');
  }
  const lookout=firstHit(mesh,[.5,9.2,1.0],[0,-1,0]);
  assert.equal(lookout.material,0);assert.ok(lookout.point[1]>8.3);
  assert.ok(WHEEL_CENTER[2]>4 && WHEEL_CENTER[2]<HELM_EYE_Z);
  for(let i=0;i<mesh.length;i+=9)if(mesh[i+6]===7 || mesh[i+6]===8){
    assert.ok(mesh[i+1]>vesselDeck(mesh[i+2]));
    assert.ok(Math.abs(mesh[i+2]-WHEEL_CENTER[2])<.1);
  }
});

import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCaravelMesh, indexCaravelMesh } from '../js/caravel.js';
import { shadowMeshData } from '../js/shadows.js';
import { hullHalfWidth, hullSurfacePoint, HULL_DRAFT, vesselDeck, hullDeck, TILLER_PIVOT, TILLER_HANDLE, tillerPoint, HELM_EYE_Z, HULL_VERTICAL_SCALE, hullScale } from '../js/hull.js';
import { createCompany, stepCompany } from '../js/crew.js';

test('indexed caravel preserves every vertex bit, triangle, and shadow partition',()=>{
  const raw=createCaravelMesh(),indexed=indexCaravelMesh(raw);
  const bits=new Uint32Array(raw.buffer),compact=new Uint32Array(indexed.vertices.buffer);
  function expand(mesh,indices){
    const out=new Uint32Array(indices.length*9);
    for(let i=0;i<indices.length;i++)out.set(mesh.subarray(indices[i]*9,indices[i]*9+9),i*9);
    return out;
  }
  assert.deepEqual(expand(compact,indexed.indices),bits);
  assert.ok(indexed.vertices.byteLength+indexed.indices.byteLength<raw.byteLength*.57);
  assert.ok(indexed.vertices.byteLength+indexed.indices.byteLength<4_000_000);
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
  assert.ok(forward < -8.3 && forward > -8.6);
});

test('complete vessel includes three lateen courses, single masts and a working rudder', () => {
  const mesh=createCaravelMesh();
  const bounds=new Map();
  for(let i=0;i<mesh.length;i+=9){
    const material=Math.floor(mesh[i+6]);
    if(!bounds.has(material))bounds.set(material,{minY:Infinity,maxY:-Infinity,minZ:Infinity,maxZ:-Infinity,count:0});
    const b=bounds.get(material);b.minY=Math.min(b.minY,mesh[i+1]);b.maxY=Math.max(b.maxY,mesh[i+1]);
    b.minZ=Math.min(b.minZ,mesh[i+2]);b.maxZ=Math.max(b.maxZ,mesh[i+2]);b.count++;
  }
  assert.ok(bounds.get(15).minY<=-HULL_DRAFT+.001);
  assert.ok(bounds.get(15).minZ<=-6.39 && bounds.get(15).maxZ>=5.59);
  assert.equal(bounds.has(9),false,'square courses are reserved for the future model');
  assert.ok(bounds.get(13).count>6000 && bounds.get(13).maxZ>6 && bounds.get(13).minZ<-6);
  assert.ok(bounds.get(13).minY>=2.09 && bounds.get(13).maxY>=9.19);
  assert.ok(bounds.get(16).count>100 && bounds.get(17).maxY>2.7);
  assert.ok(bounds.get(10).maxY>=8.69 && bounds.get(10).maxY<9.5);
  const panels=new Set();
  for(let i=6;i<mesh.length;i+=9)if([9,13].includes(Math.floor(mesh[i])))panels.add(Math.round(mesh[i]%1*16));
  assert.deepEqual([...panels].sort(),[1,2,3]);
  assert.ok(bounds.get(14).maxZ>6 && bounds.get(14).minY<-1.05);
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

test('two modest stern lights are recessed; cabin sides are planked',()=>{
  const mesh=createCaravelMesh();
  for(const x of [-.48,.48]){
    const hit=firstHit(mesh,[x+.065,1.62,6.5],[0,0,-1]);
    assert.equal(hit.material,11,'stern planking must not cross a pane');
    assert.ok(hit.point[2]<5.55 && hit.point[2]>5.50);
  }
  for(const side of [-1,1])for(const z of [3.4,4.35,5.18]){
    assert.equal(firstHit(mesh,[side*3,1.60,z+.1],[-side,0,0]).material,1);
  }
});

test('continuous main deck and quarterdeck support a direct tiller below the after deck',()=>{
  const mesh=createCaravelMesh();
  for(const z of [-5,-1.9,3.1]){
    const hit=firstHit(mesh,[.3,vesselDeck(z)+.15,z],[0,-1,0]);
    assert.equal(hit.material,0);
    assert.ok(Math.abs(hit.point[1]-vesselDeck(z))<.003);
  }
  assert.ok(TILLER_HANDLE[2]<TILLER_PIVOT[2]);
  const helmTriangles=[];
  for(let i=0;i<mesh.length;i+=9)if(mesh[i+6]===7||mesh[i+6]===8)helmTriangles.push(Array.from(mesh.subarray(i,i+3)));
  assert.ok(helmTriangles.length>0);
  for(const [x,y,z] of helmTriangles){
    assert.ok(y>hullDeck(z) && y<vesselDeck(z),'tiller occupies the main-deck steering space');
    assert.ok(Math.abs(x)<.2,'no wheel rim or spokes remain');
  }
  for(const rudder of [-35,0,35]){
    const b={length:20,beam:6,rudder},p=tillerPoint(b),z=p[2]/(20/12);
    assert.ok(Math.abs(p[0])+.2<hullHalfWidth(z,1.34)*(6/3.6),'full helm remains inside the hull');
  }
});

test('20 m hull grounds adult crew on real decks, keeps the helm reachable and limits stair risers',()=>{
  const mesh=createCaravelMesh(),scale=hullScale(),company=createCompany();
  // All ship geometry, including the tiller, shares the hull transform.
  for(let i=0;i<mesh.length;i+=9)for(let axis=0;axis<3;axis++){
    mesh[i+axis]*=scale[axis];
  }
  stepCompany(company,{length:20,beam:6},0,0);
  for(const sailor of company.crew){
    // Probe each boot beside any caulk gap, from below arms/torso height.
    const p=Array.from(sailor.position),hits=[-.07,.07].map(dx=>firstHit(mesh,[p[0]+dx,p[1]+.15,p[2]],[0,-1,0]));
    const hit=hits.sort((a,b)=>b.point[1]-a.point[1])[0];
    assert.equal(hit.material,0,`${sailor.id} stands on deck boards`);
    assert.ok(Math.abs(hit.point[1]-(p[1]-.028))<.015,`${sailor.id} feet match the enlarged deck`);
  }
  const helm=company.crew.find(s=>s.role==='Helmsman');
  const grip=tillerPoint({length:20,beam:6});
  assert.ok(Math.abs(helm.position[2]-grip[2]+.32)<1e-6);
  assert.ok(grip[1]-helm.position[1]>.9 && grip[1]-helm.position[1]<1.1);
  assert.ok(helm.position[1]+1.8<vesselDeck(helm.z)*scale[1],'standing head clears the quarterdeck');
  // Detect actual upper tread faces, rather than trusting the requested step count.
  for(const [xmin,xmax,zmin,zmax,minSteps,startZ] of [[.69,1.23,1.4,2.75,12,1.5]]){
    const levels=new Set();
    for(let i=0;i<mesh.length;i+=9)if(mesh[i+6]===6&&mesh[i+4]>.999&&
      mesh[i]/scale[0]>xmin&&mesh[i]/scale[0]<xmax&&mesh[i+2]/scale[2]>zmin&&mesh[i+2]/scale[2]<zmax){
      levels.add(Math.round(mesh[i+1]*10000)/10000);
    }
    const heights=[...levels].sort((a,b)=>a-b);assert.ok(heights.length>=minSteps);
    assert.ok(heights[0]-vesselDeck(startZ)*scale[1]<=.231,'first tread is reachable from the deck');
    for(let i=1;i<heights.length;i++)assert.ok(heights[i]-heights[i-1]<=.231);
  }
});

test('fine bow and stern sections retain a full midbody and four unobstructed gun muzzles',()=>{
  assert.ok(hullHalfWidth(-5.8,1.5)<.55,'foremost metre tapers into the stem');
  assert.ok(hullHalfWidth(5.0,-.7)<hullHalfWidth(5.0,0)*.7,'underwater stern has a fine run');
  assert.ok(hullHalfWidth(0,0)>1.7,'midbody buoyancy stays full');
  const mesh=createCaravelMesh();
  for(const side of [-1,1])for(const z of [3.25,4.9]){
    const hit=firstHit(mesh,[side*4,2.935,z],[-side,0,0]);
    assert.ok([3,4].includes(hit.material),'four elevated iron falconets exist');
  }
  for(const z of [-5.5,-4.2,-3.8])assert.ok(vesselDeck(z)<1.2,'continuous sheer replaces the forecastle tier');
});

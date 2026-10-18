import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCaravelMesh } from '../js/caravel.js';
import { hullHalfWidth, hullSurfacePoint, HULL_DRAFT } from '../js/hull.js';
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
  assert.ok(bounds.get(13).count>1000 && bounds.get(13).maxZ>6 && bounds.get(13).minY<3.3);
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

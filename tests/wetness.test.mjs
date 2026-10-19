import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createWetnessData } from '../js/wetness.js';
import { createCaravelMesh, indexCaravelMesh } from '../js/caravel.js';

test('moisture follows material identity across indexing, sail attachments and normal seams',()=>{
  const raw=createCaravelMesh(),indexed=indexCaravelMesh(raw),a=createWetnessData(raw),b=createWetnessData(indexed.vertices);
  assert.deepEqual(a.points,b.points);
  for(let i=0;i<indexed.indices.length;i++)assert.equal(a.lookup[i],b.lookup[indexed.indices[i]]);
  assert.ok(b.points.length/8<10000,'surface probe budget');
  assert.ok(b.points.byteLength+b.lookup.byteLength+b.points.length<750000,'probe buffers stay below 750 KB');
  assert.equal(b.points.length/8-b.crewOffset,48,'four persistent probes per sailor');
  assert.ok(b.points.subarray(b.crewOffset*8).every(v=>v===0),'crew probes start inactive');
  const vertex=(mat,v=0,n=1)=>[0,4,0,0,n,0,mat,.5,v];
  const data=createWetnessData(new Float32Array([
    ...vertex(9.0625),...vertex(9.0625,0,-1),...vertex(9.125),
    ...vertex(12.5625,0),...vertex(12.5625,1),...vertex(11),...vertex(3),
  ]),0);
  assert.equal(data.lookup[0],data.lookup[1],'opposite normals share the same fabric moisture');
  assert.notEqual(data.lookup[0],data.lookup[2],'different sails stay independent');
  assert.notEqual(data.lookup[3],data.lookup[4],'fixed and moving rope attachments stay independent');
  assert.equal(data.lookup[5],0);assert.equal(data.lookup[6],0,'glass and iron are not porous materials');
});

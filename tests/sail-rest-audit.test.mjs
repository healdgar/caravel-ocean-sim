// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {measureTriangularMaterialMesh,sampleLateenMaterialMesh} from '../scripts/sail-rest-audit.mjs';

const close=(actual,expected)=>assert.ok(Math.abs(actual-expected)<=Math.max(1,Math.abs(expected))*1e-11,
  `${actual} != ${expected}`);
const square=()=>({uv:[[0,0],[1,0],[0,1],[1,1]],triangles:[[0,1,2],[1,3,2]],
  restPoints:[[0,0,0],[1,0,0],[0,1,0],[1,1,0]]});

test('material metrics preserve rigid rotation and translation and count shared edges once',()=>{
  const mesh=square(),posedPoints=mesh.restPoints.map(([x,y,z])=>[5-y,x-2,z+3]);
  const result=measureTriangularMaterialMesh({...mesh,posedPoints});
  assert.equal(result.validGeometry,true);assert.equal(result.finite,true);
  assert.equal(result.uniqueEdges,5);
  close(result.edges.minimumRatio,1);close(result.edges.maximumRatio,1);close(result.edges.maximumExcess,0);
  close(result.areas.restTotal,1);close(result.areas.posedTotal,1);close(result.areas.ratio,1);
});

test('uniform scaling measures length and area independently in caller units',()=>{
  const mesh=square(),posedPoints=mesh.restPoints.map(p=>p.map(v=>v*2.5));
  const result=measureTriangularMaterialMesh({...mesh,posedPoints});
  assert.equal(result.validGeometry,true);
  close(result.edges.minimumRatio,2.5);close(result.edges.maximumRatio,2.5);
  close(result.edges.maximumExcess,1.5*Math.SQRT2);
  close(result.areas.restTotal,1);close(result.areas.posedTotal,6.25);close(result.areas.ratio,6.25);
});

test('one stretched edge identifies its material UVs and dimensional excess',()=>{
  // AB and AC retain unit length; moving B around A stretches only BC.
  const mesh={uv:[[0,0],[1,0],[0,1]],triangles:[[0,1,2]],
    restPoints:[[0,0,0],[1,0,0],[0,1,0]],posedPoints:[[0,0,0],[.6,-.8,0],[0,1,0]]};
  const result=measureTriangularMaterialMesh(mesh);
  assert.equal(result.validGeometry,true);
  close(result.edges.minimumRatio,1);close(result.edges.maximumRatio,Math.sqrt(1.8));
  close(result.edges.maximumExcess,Math.sqrt(3.6)-Math.SQRT2);
  assert.deepEqual(result.edges.maximum.indices,[1,2]);
  assert.deepEqual(result.edges.maximum.uv,[[1,0],[0,1]]);
  close(result.areas.ratio,.6);
});

test('invalid coordinates or topology do not produce apparently complete area metrics',()=>{
  for(const bad of [NaN,Infinity,-Infinity]){
    const mesh=square(),posedPoints=mesh.restPoints.map(p=>[...p]);posedPoints[3][1]=bad;
    const result=measureTriangularMaterialMesh({...mesh,posedPoints});
    assert.equal(result.validGeometry,false);assert.equal(result.finite,false);
    assert.deepEqual(result.invalid.posedVertices,[3]);assert.equal(result.areas,null);
  }
  const mesh=square(),invalid=measureTriangularMaterialMesh({...mesh,posedPoints:mesh.restPoints,triangles:[[0,1,99]]});
  assert.equal(invalid.validGeometry,false);assert.deepEqual(invalid.invalid.triangles,[0]);assert.equal(invalid.areas,null);
});

test('collapsed posed faces and zero rest edges are invalid geometry',()=>{
  const mesh={uv:[[0,0],[1,0],[0,1]],triangles:[[0,1,2]],restPoints:[[0,0,0],[1,0,0],[0,1,0]]};
  const collapsed=measureTriangularMaterialMesh({...mesh,posedPoints:[[0,0,0],[1,0,0],[2,0,0]]});
  assert.equal(collapsed.validGeometry,false);assert.deepEqual(collapsed.degenerate.posedTriangles,[0]);
  const duplicate=measureTriangularMaterialMesh({...mesh,restPoints:[[0,0,0],[0,0,0],[0,1,0]],posedPoints:mesh.restPoints});
  assert.equal(duplicate.validGeometry,false);assert.deepEqual(duplicate.degenerate.restEdges,['0/1']);
  assert.deepEqual(duplicate.degenerate.restTriangles,[0]);
});

test('finite input overflow does not publish partial edge extrema or area totals',()=>{
  const result=measureTriangularMaterialMesh({uv:[[0,0],[1,0],[0,1]],triangles:[[0,1,2]],
    restPoints:[[0,0,0],[1,0,0],[0,1,0]],
    posedPoints:[[1e308,0,0],[-1e308,0,0],[0,1,0]]});
  assert.equal(result.finite,true,'input coordinates themselves are finite');
  assert.equal(result.validGeometry,false);
  assert.ok(result.nonFiniteDerived.edges.includes('0/1'));
  assert.equal(result.edges,null);assert.equal(result.areas,null);
  assert.ok(result.issues.includes('non-finite-derived-geometry'));
});

test('fully filled production good-tack cloth preserves canonical rest edges on both sides',()=>{
  for(let mast=0;mast<3;mast++)for(const side of [-1,1])for(const opening of [.3,.6,1.15]){
    const pose={side,opening,pressure:1,deployed:1,fill:1,dip:0};
    const mesh=sampleLateenMaterialMesh(mast,pose,{rows:26,time:0,wind:0});
    const result=measureTriangularMaterialMesh(mesh);
    assert.equal(result.validGeometry,true,`mast ${mast}, side ${side}, opening ${opening}`);
    close(result.edges.minimumRatio,1);close(result.edges.maximumRatio,1);
    close(result.edges.maximumExcess,0);close(result.areas.ratio,1);
  }
});

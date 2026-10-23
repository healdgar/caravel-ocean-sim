// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {forestMiddleWoodPartition} from '../js/forest-mass.js';

test('volumetric crowns keep exact native-derived woody triangles and discard only middle foliage',()=>{
 const v=new Float32Array(12*13),i=new Uint32Array([3,4,5,0,1,2,6,7,8,9,10,11]);
 for(let j=0;j<12;j++)v[j*13+6]=j<3||j>=9?3:4;
 const beforeV=v.slice(),beforeI=i.slice(),p=[{id:0,firstIndex:0,indexCount:6},{id:1,firstIndex:6,indexCount:6}];
 const wood=forestMiddleWoodPartition(v,i,p);
 assert.deepEqual(wood.indices,new Uint32Array([0,1,2,9,10,11]));
 assert.deepEqual(wood.prototypes,[{id:0,firstIndex:0,indexCount:3},{id:1,firstIndex:3,indexCount:3}]);
 assert.deepEqual(v,beforeV);assert.deepEqual(i,beforeI);assert.equal(p[1].firstIndex,6);
});

test('mixed material or invalid middle indices cannot masquerade as native wood',()=>{
 const v=new Float32Array(3*13);v[6]=v[19]=v[32]=3;const p=[{id:0,firstIndex:0,indexCount:3}];
 assert.throws(()=>forestMiddleWoodPartition(v,new Uint32Array([0,1,9]),p),/Mixed or invalid/);
 v[19]=4;assert.throws(()=>forestMiddleWoodPartition(v,new Uint32Array([0,1,2]),p),/Mixed or invalid/);
 assert.throws(()=>forestMiddleWoodPartition(v,new Uint32Array([0,1,2]),[{id:0,firstIndex:0,indexCount:4}]),/range/);
});

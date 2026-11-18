// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Proposed source regressions; root owns execution and rendered acceptance.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {seedVegetation} from '../js/vegetation.js';

test('increased regional density extends the same seeded plants and respects bare/wet ground',()=>{
  const region={span:512,x:0,z:0,biomeSize:8,vegetationSeed:47231,vegetationCandidates:96},mask=new Uint8Array(64).fill(255);
  const old=seedVegetation(region,()=>50,mask),dense=seedVegetation({...region,vegetationCandidates:960},()=>50,mask);
  assert.deepEqual(dense.subarray(0,old.length),old,'density cannot regrow the original roots or dimensions');
  assert.ok(dense.length>old.length*7,'larger candidate stream materially increases stand population');
  assert.deepEqual(dense,seedVegetation({...region,vegetationCandidates:960},()=>50,mask));
  assert.equal(seedVegetation(region,()=>50,new Uint8Array(64)).length,0,'bare biome stays bare');
  assert.equal(seedVegetation(region,()=>-2,mask).length,0,'water stays clear');
});

// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// How far above the surface a submerged capture keeps a material is the caller's statement, not a guess from
// the helpers its shader happens to include.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createSubmergedShader,WATER_CAPTURE_LAND_MARGIN,WATER_CAPTURE_MARGIN} from '../js/water-optics.js';
import {TERRAIN} from '../js/wgsl/terrain.js';
import {CARAVEL} from '../js/wgsl/caravel.js';

const margin=source=>Number(/select\(captureWorld\.y>surfaceY\+([\d.]+),/.exec(source)?.[1]);

test('ground is captured to its shore margin only when the caller says it is ground',()=>{
  assert.equal(margin(createSubmergedShader(TERRAIN,'fs','in.world',false,true)),WATER_CAPTURE_LAND_MARGIN);
  assert.equal(margin(createSubmergedShader(TERRAIN,'groundFS','in.world',false,true)),WATER_CAPTURE_LAND_MARGIN);
  assert.equal(margin(createSubmergedShader(CARAVEL,'fs','in.world')),WATER_CAPTURE_MARGIN);
  // A hull whose shader came to include the cloud march must not be captured half a metre above the sea.
  const hullWithClouds=CARAVEL+'\nfn hullCloudShade(p:vec3f)->f32{let ray=marchCloudsTo(p,vec3f(0,1,0),4u,0.5,vec3f(1),vec3f(1),10.0);return ray.transmittance;}';
  assert.equal(margin(createSubmergedShader(hullWithClouds,'fs','in.world')),WATER_CAPTURE_MARGIN);
  assert.ok(WATER_CAPTURE_LAND_MARGIN>WATER_CAPTURE_MARGIN);
});

test('the terrain names its captures as ground, and the capture shader rewrites nothing by a cloud helper\'s name',()=>{
  const terrain=fs.readFileSync('js/terrain.js','utf8'),captures=[...terrain.matchAll(/wo\.capture\(\{source:TERRAIN,[^\n]*\}\),/g)].map(match=>match[0]);
  assert.equal(captures.length,2);
  for(const capture of captures)assert.ok(capture.includes('land:true'),capture);
  assert.ok(!fs.readFileSync('js/water-optics.js','utf8').includes('marchCloudsTo'),'no rewrite keyed on the cloud march remains');
});

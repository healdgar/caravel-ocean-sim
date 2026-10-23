// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {FOREST_VOLUME_WGSL,FOREST_VOLUME_SHELL_WGSL} from '../js/forest-volume.js';

test('opaque source-field shell keeps raster depth and the original mesh outline',()=>{
 assert.match(FOREST_VOLUME_SHELL_WGSL,/@vertex fn forestVolumeShellVS\(@location\(0\)position:vec3f,@location\(1\)normal:vec3f,@location\(6\)colour:vec3f/);
 assert.match(FOREST_VOLUME_SHELL_WGSL,/forestRoots\[forestVisible\[forestBin\.x\+instance\]\]/);
 assert.match(FOREST_VOLUME_SHELL_WGSL,/forestVolumeRotate\(position,root\.yawColour\.x\)\*root\.rootScale\.w/);
 assert.match(FOREST_VOLUME_SHELL_WGSL,/o\.local=position;o\.normal=normal;o\.colour=colour/);
 assert.match(FOREST_VOLUME_SHELL_WGSL,/return vec4f\(lit\.rgb,1\.\)/);
 assert.doesNotMatch(FOREST_VOLUME_SHELL_WGSL,/frag_depth|forestVolumeInterval|triangles\[|weightSum|transmittance/);
 assert.equal((FOREST_VOLUME_SHELL_WGSL.match(/discard/g)??[]).length,1);
 assert.match(FOREST_VOLUME_SHELL_WGSL,/if\(in\.local\.y<forestVolumeMeta\.highFloor\.w\)\{discard;\}/);
});

test('shell interior shading uses source moments, escape and actual geometry normals',()=>{
 assert.match(FOREST_VOLUME_SHELL_WGSL,/i<6u/);assert.match(FOREST_VOLUME_SHELL_WGSL,/ray\*\(\(f32\(i\)\+\.5\)\*\.25\)/);
 assert.match(FOREST_VOLUME_SHELL_WGSL,/pigment=moment\/densitySum;exposure=escapeMoment\/densitySum/);
 assert.match(FOREST_VOLUME_SHELL_WGSL,/var pigment=in\.colour/);
 assert.match(FOREST_VOLUME_SHELL_WGSL,/localNormal=normalize\(in\.normal\)/);
 assert.match(FOREST_VOLUME_SHELL_WGSL,/i<4u/);assert.match(FOREST_VOLUME_SHELL_WGSL,/sunlight=exp\(-forestVolumeMeta\.dimensionsExtinction\.w\*opticalDepth\)/);
 assert.match(FOREST_VOLUME_SHELL_WGSL,/landFinish\(in\.world,n,pigment\*in\.yawTint\.yzw/);
 assert.doesNotMatch(FOREST_VOLUME_SHELL_WGSL,/@group\(|textureSample\(|dpdx|dpdy|read_write|@compute/);
});

test('the exact comparison raymarch remains independently available',()=>{
 assert.match(FOREST_VOLUME_WGSL,/@vertex fn forestVolumeVS/);assert.match(FOREST_VOLUME_WGSL,/@fragment fn forestVolumeFS/);
 assert.match(FOREST_VOLUME_WGSL,/@builtin\(frag_depth\)depth:f32/);assert.match(FOREST_VOLUME_WGSL,/hit\/weightSum/);
 assert.match(FOREST_VOLUME_WGSL,/min\(64u,max\(1u,u32\(ceil/);
});

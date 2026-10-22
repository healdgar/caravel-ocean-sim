// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {SHIP_MODELS} from '../js/ship-models.js';
import {createShipAssetCache} from '../js/ship-mesh.js';
import {assertGPUVesselAssets,assertGPUVesselFrame,assertNoCPUVesselAnimation} from './helpers/gpu-vessel-contract.mjs';

const gpuRenderableIds=Object.values(SHIP_MODELS).filter(m=>m.status==='ready'&&m.geometry).map(m=>m.id);

test('every renderable ship uses the shared GPU contract, including future registered models',()=>{
  const cache=createShipAssetCache(),assets=gpuRenderableIds.map(id=>cache.get(id));
  assertGPUVesselAssets(assets,gpuRenderableIds);
  for(const a of assets)assert.equal(cache.get(a.model.id),a,'immutable model preparation remains cached');
});

test('GPU asset contract rejects a CPU fallback even when the model claims GPU support',()=>{
  const prototype={model:{id:'future-model'},gpuPose:true,vertices:new Float32Array(9),indices:new Uint32Array([0])};
  assertGPUVesselAssets([prototype],['future-model']);
  assert.throws(()=>assertGPUVesselAssets([{...prototype,gpuPose:false}],['future-model']),/must require GPU/);
  assert.throws(()=>assertGPUVesselAssets([{...prototype,pose(){}}],['future-model']),/CPU mesh animator/);
  assert.throws(()=>assertGPUVesselAssets([],['future-model']),/every renderable/);
});

test('production renderer never restores CPU asset posing or whole-mesh animation uploads',()=>{
  const source=readFileSync(new URL('../js/main.js',import.meta.url),'utf8');assertNoCPUVesselAnimation(source);
});

test('source guard rejects the former CPU deformation/upload path without outlawing offline or compact state work',()=>{
  const valid='function frame() { device.queue.writeBuffer(v.hullUBO,0,v.hullData); v.pose.update(ship,time,wind); }';
  assertNoCPUVesselAnimation(valid);
  for(const forbidden of [
    'v.asset.pose?.(ship,time,wind,v.mesh);',
    'device.queue.writeBuffer(v.vertexBuffer,0,v.mesh);',
    'device.queue.writeBuffer(v.vertexBuffer,range.byteOffset,v.mesh.buffer,range.byteOffset,range.byteLength);',
    'updateGunRecoilVertices(v.recoilMap,v.mesh,v.gunnery.state.guns,ship);',
    'v.wetness.updateGeometry(v.mesh);',
  ])assert.throws(()=>assertNoCPUVesselAnimation(valid.replace('v.pose.update(ship,time,wind);',forbidden)),/CPU pose|full animated mesh|wetness|recoil/);
});

test('observational guard rejects disabled dispatch, CPU animation and geometry uploads independently',()=>{
  const row={id:'player',model:'future-model',required:true,cpuPose:false,pose:true,dispatches:1,main:1,submerged:1,shadow:1,shadowExpected:true,wetness:1,geometryWrites:[],poseWrites:[],cpuMeshChanged:false};
  const inspect=r=>assertGPUVesselFrame({errors:[],rows:[r]},['future-model']);inspect(row);
  for(const mutation of [{required:false},{cpuPose:true},{pose:false},{dispatches:0},{main:0},{submerged:0},{shadow:0},{wetness:0},{geometryWrites:[{offset:0,bytes:36}]},{poseWrites:[{offset:0,bytes:32}]},{cpuMeshChanged:true}])assert.throws(()=>inspect({...row,...mutation}));
});

test('source guard rejects CPU staging copies into vessel geometry while preserving sparse probe readback',()=>{
  const valid='function frame() { encoder.copyBufferToBuffer(v.probe.output,0,v.probe.read,0,64); v.pose.update(ship,time,wind); }';
  assertNoCPUVesselAnimation(valid);
  for(const destination of ['v.vertexBuffer','v.pose.buffer'])
    assert.throws(()=>assertNoCPUVesselAnimation(valid.replace('v.pose.update(ship,time,wind);',`encoder.copyBufferToBuffer(cpuStaging,0,${destination},0,cpuBytes);`)),/CPU staged vertex-animation/);
});

// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// The same assertions qualify production observations and deliberate mutants.
import assert from 'node:assert/strict';

export function assertGPUVesselAssets(assets,renderableIds){
  assert.deepEqual(assets.map(a=>a.model.id).sort(),[...renderableIds].sort(),'every renderable registry entry needs a GPU asset');
  for(const asset of assets){
    assert.equal(asset.gpuPose,true,asset.model.id+' must require GPU deformation');
    assert.notEqual(typeof asset.pose,'function',asset.model.id+' must not expose a runtime CPU mesh animator');
    assert.ok(asset.vertices.length>0&&asset.vertices.length%9===0&&asset.indices.length>0,asset.model.id+' retains real source geometry');
  }
}

export function assertGPUVesselFrame(frame,renderableIds){
  assert.deepEqual(frame.errors,[],'native GPU validation must stay clean');
  assert.deepEqual(frame.rows.map(r=>r.model).sort(),[...renderableIds].sort(),'the guard must inspect every requested class');
  for(const r of frame.rows){
    const name=r.model+' / '+r.id;
    assert.equal(r.required,true,name+' cannot opt out of GPU posing');
    assert.equal(r.cpuPose,false,name+' cannot retain a hidden CPU mesh fallback');
    assert.ok(r.pose,name+' must own a posed GPU buffer');
    assert.ok(r.dispatches>0,name+' must actually dispatch the pose compute pipeline');
    assert.ok(r.main>0,name+' main draws must consume that exact computed buffer');
    assert.ok(r.submerged>0,name+' submerged capture must consume that exact computed buffer');
    if(r.shadowExpected)assert.ok(r.shadow>0,name+' shadow draws must consume that exact computed buffer');
    assert.ok(r.wetness>0,name+' wetness must consume that exact computed buffer');
    assert.equal(r.geometryWrites.length,0,name+' must not upload CPU vertex animation during an ordinary frame');
    assert.equal(r.poseWrites.length,0,name+' posed positions and normals must remain GPU-owned');
    assert.equal(r.cpuMeshChanged,false,name+' must keep rest geometry unchanged outside explicit gun recoil');
  }
}

export function assertNoCPUVesselAnimation(source){
  // An offline reference evaluator remains legal. The production renderer may
  // upload immutable geometry once and small cannon-recoil subranges, but may
  // not restore the former full-mesh CPU evaluator/upload/wetting path.
  assert.doesNotMatch(source,/\.asset\s*\.\s*pose\s*(?:\?\.)?\s*\(/,'production must not call an asset CPU pose');
  assert.doesNotMatch(source,/\.wetness\s*\.\s*updateGeometry\s*\(/,'wetness must share GPU posed geometry');
  const frame=source.slice(source.indexOf('function frame('));
  assert.ok(frame.length>source.length*.05,'inspect the actual production frame body');
  assert.doesNotMatch(frame,/writeBuffer\s*\(\s*\w+\.vertexBuffer\s*,\s*0\s*,\s*\w+\.mesh\s*\)/,'full animated mesh uploads are prohibited');
}

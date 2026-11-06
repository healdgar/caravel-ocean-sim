// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Hits must take blocks off a building, not pull its vertices around. They land on the ground, and what they held up comes down.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyBuildingFractureEvents, BUILDING_SHARD_KINDS, prepareBuildingFracture, prepareBuildingFractureSteps, supportScan } from '../js/building-fracture.js';
import { getBuildingParts, PORT_PREFABS } from '../js/coastal-world.js';
import { evaluateShardFlight, FRACTURE_RECORD_FLOATS, settleFinishedFlights } from '../js/ship-fracture.js';
import { classifyBuildingMaterial } from '../js/gunnery-control.js';
import { bakeLandImpactDeformations, sampleVoronoiBlockCell } from '../js/part-assembly.js';

const recordOf = (state, s) => state.records.subarray(s * FRACTURE_RECORD_FLOATS, (s + 1) * FRACTURE_RECORD_FLOATS);
const NOWHERE = 1e6;

function prepared(prefabId, { ground = 0, yaw = 0, x = 0, z = 0 } = {}) {
  const parts = getBuildingParts(prefabId);
  const cos = Math.cos(yaw), sin = Math.sin(yaw), vertices = new Float32Array(parts.vertices);
  for (let v = 0; v < vertices.length; v += 8) {
    const px = vertices[v], pz = vertices[v + 2];
    vertices[v] = x + px * cos + pz * sin;
    vertices[v + 2] = z - px * sin + pz * cos;
    const nx = vertices[v + 3], nz = vertices[v + 5];
    vertices[v + 3] = nx * cos + nz * sin;
    vertices[v + 5] = -nx * sin + nz * cos;
  }
  const instance = { prefabId, x, z, y: ground, baseY: ground, yaw, ...parts.dimensions };
  return {
    parts, instance, vertices,
    ...prepareBuildingFracture({ vertices, indices: parts.indices, catalog: parts.partAssembly, instanceIndex: 0, instance, materialClass: classifyBuildingMaterial(prefabId), groundAt: () => ground }),
  };
}
const shot = (x, y, z, extra = {}) => ({ kind: 'stone-crater', x, y, z, nx: 0, ny: 0, nz: -1, stepDepth: 0.44, severity: 1.1, ...extra });

test('every building, however it is built, stands intact and is within its budget', () => {
  for (const prefabId of Object.keys(PORT_PREFABS)) {
    const { fracture, vertices, indices, initial } = prepared(prefabId);
    assert.ok(fracture.shardCount > 1, `${prefabId} has pieces to lose`);
    assert.ok(fracture.shardCount < 5000, `${prefabId}: ${fracture.shardCount} shards`);
    assert.equal(fracture.vertexShards.length, vertices.length / 8);
    assert.equal(initial.length, vertices.length);
    for (let i = 0; i < indices.length; i++) assert.ok(indices[i] < vertices.length / 8);
    const hang = supportScan(fracture, new Uint8Array(fracture.shardCount));
    for (let s = 1; s < fracture.shardCount; s++) assert.notEqual(hang[s], 255, `${prefabId}: ${fracture.shards[s].partKey} falls with nothing broken`);
    for (const shard of fracture.shards) {
      if (!shard) continue;
      for (const n of shard.links) assert.ok(fracture.shards[n].links.includes(shard.index), 'links go both ways');
      for (const n of shard.below) assert.ok(fracture.shards[n].above.includes(shard.index), 'what rests on what agrees');
    }
  }
});

test('a wall is cut into closed blocks, along the masonry cells', () => {
  const { fracture, vertices } = prepared('bastion_trace_fortress');
  const walls = fracture.shards.filter((s) => s?.kind === BUILDING_SHARD_KINDS.block && s.partKey === 'foundation_scarp_walls');
  assert.ok(walls.length > 100, `${walls.length} blocks in the scarp`);
  for (const shard of walls.slice(0, 40)) {
    const size = [shard.max[0] - shard.min[0], shard.max[1] - shard.min[1], shard.max[2] - shard.min[2]];
    assert.ok(Math.max(...size) < 5.5 && Math.max(...size) > 0.3, `a block is block-sized: ${size}`);
    assert.ok(Math.min(...size) > 0.1, `a block has thickness: ${size}`);
  }
  // Cuts follow sampleVoronoiBlockCell: most blocks in a course sit in one cell at any scale.
  assert.ok(fracture.blockScale >= 1);
  const list = []; for (let v = 0; v < fracture.vertexShards.length; v++) if (fracture.vertexShards[v] === walls[0].index) list.push(v);
  assert.equal(list.length, 24, 'front, back and four sides');
  const hidden = list.filter((v) => Math.hypot(vertices[v * 8 + 3], vertices[v * 8 + 4], vertices[v * 8 + 5]) > 1.2);
  assert.equal(hidden.length, 20, 'all but the front are raw stone, inside the wall');
  assert.ok(sampleVoronoiBlockCell(1, 2, 3).blockMod > 0);
});

test('the faces inside a wall draw nothing until a break exposes them', () => {
  const { fracture, vertices, initial } = prepared('stone_sea_bastion');
  let hidden = 0, front = 0;
  for (let v = 0; v < fracture.vertexShards.length; v++) {
    if (!fracture.vertexShards[v]) continue;
    const at = v * 8, raw = Math.hypot(vertices[at + 3], vertices[at + 4], vertices[at + 5]) > 1.2;
    const same = initial[at] === vertices[at] && initial[at + 1] === vertices[at + 1] && initial[at + 2] === vertices[at + 2];
    if (raw) { hidden++; assert.ok(!same || vertices[at] === fracture.shards[fracture.vertexShards[v]].centroid[0], 'collapsed to one point'); }
    else { front++; assert.ok(same, 'a face that shows starts where it belongs'); }
  }
  assert.ok(hidden > 10000 && front > 10000, `${hidden} hidden vertices against ${front} that show`);
});

test('the same work in pieces gives the same building', () => {
  const parts = getBuildingParts('royal_warehouse'), instance = { prefabId: 'royal_warehouse', x: 0, z: 0, yaw: 0 };
  const options = { vertices: parts.vertices, indices: parts.indices, catalog: parts.partAssembly, instanceIndex: 0, instance, materialClass: 'masonry', groundAt: () => 0 };
  const steps = prepareBuildingFractureSteps(options);
  let yields = 0, step = steps.next();
  while (!step.done) { yields++; step = steps.next(); }
  assert.ok(yields > 20, `it can stop often (${yields})`);
  const whole = prepareBuildingFracture(options);
  assert.deepEqual(step.value.vertices, whole.vertices);
  assert.deepEqual(step.value.indices, whole.indices);
});

test('a shot knocks blocks out and what it does not break, it wears', () => {
  const { fracture, parts, vertices } = prepared('stone_sea_bastion');
  const before = new Float32Array(vertices), damage = {};
  const released = applyBuildingFractureEvents(fracture, damage, [shot(0, 5, -parts.dimensions.length / 2)], 0);
  assert.ok(released >= 2 && released < 40, `one heavy shot takes a few blocks (${released})`);
  assert.deepEqual(vertices, before, 'JavaScript has moved no vertex');
  const state = damage.fracture;
  assert.ok(state.records.length === fracture.shardCount * 16);
  assert.ok(state.scorch.some((v, s) => v > 0.05 && !state.broken[s]), 'neighbours are scorched');
  assert.ok(state.dirty.size >= released, 'only what changed goes to the GPU');
  const light = {};
  assert.equal(applyBuildingFractureEvents(fracture, light, [shot(0, 5, -parts.dimensions.length / 2, { stepDepth: 0.2, severity: 0.4 })], 0), 0, 'a light shot only wears');
});

test('rubble settles on the ground, not the sea, and stays', () => {
  const ground = 6.5, { fracture, parts } = prepared('stone_sea_bastion', { ground, yaw: 0.3, x: 40, z: -80 });
  const damage = {}, hits = [];
  const half = parts.dimensions.length / 2, cos = Math.cos(0.3), sin = Math.sin(0.3);
  for (let i = 0; i < 18; i++) hits.push(shot(40 + (i - 9) * cos - half * sin, ground + 2 + (i % 5), -80 - (i - 9) * sin - half * cos));
  const released = applyBuildingFractureEvents(fracture, damage, hits, 0);
  assert.ok(released > 15, `${released}`);
  const state = damage.fracture;
  let checked = 0;
  for (let s = 1; s < fracture.shardCount; s++) {
    if (!state.broken[s] || fracture.shards[s].kind === BUILDING_SHARD_KINDS.gun) continue;
    const record = recordOf(state, s), shard = fracture.shards[s], at = evaluateShardFlight(record, NOWHERE, shard.centroid, [1, 1, 1]);
    assert.ok(at[1] >= ground - 0.05, `lands on the ground, at ${at[1].toFixed(2)}`);
    assert.ok(at[1] <= shard.centroid[1] + 1e-3, 'and no higher than it started');
    assert.equal(record[11], -1, 'it is not hidden, ever');
    checked++;
  }
  assert.ok(checked > 15);
  settleFinishedFlights(state, 60);
  assert.equal(state.flying.size, 0, 'the clock can stop');
  for (let s = 1; s < fracture.shardCount; s++) if (state.broken[s]) assert.ok(recordOf(state, s)[15] >= 0, 'each holds its last pose');
});

test('over deep water stone sinks to the seabed, and timber floats off and is gone', () => {
  const stone = prepared('stone_sea_bastion', { ground: -9 }), stoneDamage = {};
  // Nothing above the bed here is rooted, so strike the wall above the water.
  applyBuildingFractureEvents(stone.fracture, stoneDamage, [shot(0, 3, -stone.parts.dimensions.length / 2)], 0);
  const sunk = stoneDamage.fracture.broken.indexOf(1);
  assert.ok(sunk > 0);
  const stoneAt = evaluateShardFlight(recordOf(stoneDamage.fracture, sunk), NOWHERE, stone.fracture.shards[sunk].centroid, [1, 1, 1]);
  assert.ok(stoneAt[1] < -7 && stoneAt[1] > -9.05, `stone on the seabed, ${stoneAt[1]}`);
  const pier = prepared('timber_mole_pier', { ground: -6 }), pierDamage = {};
  applyBuildingFractureEvents(pier.fracture, pierDamage, [shot(0, 2, 10, { kind: 'timber-splinter', stepDepth: 0.52 })], 0);
  const plank = pierDamage.fracture.broken.indexOf(1);
  assert.ok(plank > 0 && pier.fracture.shards[plank].timber);
  assert.ok(recordOf(pierDamage.fracture, plank)[11] >= 0, 'timber does not stay');
});

test('a small hole stands as an arch, and a wide breach brings down the wall above it', () => {
  const { fracture } = prepared('curtain_wall_and_gate'), shards = fracture.shards;
  // One long face, its blocks by height. The wall runs along z.
  const onFace = (s) => s?.partKey === 'curtain_wall' && s.normal[0] > 0.9;
  const face = shards.filter((s) => onFace(s) && s.below.length && s.above.length);
  assert.ok(face.length > 20, `${face.length} blocks of wall with others above and below`);
  const broken = new Uint8Array(fracture.shardCount), middle = face.sort((a, b) => a.centroid[1] - b.centroid[1] || Math.abs(a.centroid[2]) - Math.abs(b.centroid[2]))[0];
  // One block out: everything still stands.
  broken[middle.index] = 1;
  const small = supportScan(fracture, broken);
  for (const up of middle.above) assert.notEqual(small[up], 255, 'the stones over one lost stone hang from their neighbours');
  // A run of the course gone: what sat on it has nothing near enough to hang from.
  const course = shards.filter((s) => onFace(s) && Math.abs(s.centroid[1] - middle.centroid[1]) < 0.3 && Math.abs(s.centroid[2] - middle.centroid[2]) < 7);
  assert.ok(course.length >= 4, `a course to cut (${course.length})`);
  for (const s of course) broken[s.index] = 1;
  const wide = supportScan(fracture, broken);
  const over = shards.filter((s) => s && !broken[s.index] && s.below.some((b) => broken[b]) && wide[s.index] === 255);
  assert.ok(over.length > 0, 'stones over the middle of the breach lose their support');
  const released = {};
  const killer = course.map((s) => ({ ...shot(s.max[0] + 0.1, s.centroid[1], s.centroid[2]), nx: 1, nz: 0, severity: 1.4 }));
  applyBuildingFractureEvents(fracture, released, killer, 0);
  const state = released.fracture;
  const higher = shards.filter((s) => s && state.broken[s.index] && s.min[1] > middle.max[1] + 1);
  assert.ok(higher.length > 0, `the wall above comes down too (${state.brokenCount} in all)`);
  // Those let go a moment apart, and not because a shot touched them.
  assert.ok(higher.some((s) => recordOf(state, s.index)[3] > 0), 'they have a delay');
});

test('a dismounted gun is knocked off its carriage and stays', () => {
  const { fracture } = prepared('bastion_trace_fortress');
  assert.ok(fracture.guns.length >= 4, `${fracture.guns.length} guns`);
  const gun = fracture.shards[fracture.guns[0]], damage = {};
  applyBuildingFractureEvents(fracture, damage, [{ kind: 'cannon-dismount', x: gun.centroid[0], y: gun.centroid[1], z: gun.centroid[2], nx: 0, ny: 0, nz: -1, radius: 1.65, stepDepth: 0.65, severity: 1.15 }], 0);
  assert.equal(damage.fracture.brokenCount, 1);
  const record = recordOf(damage.fracture, gun.index);
  assert.equal(record[11], -1, 'it stays');
  assert.ok(record[7] < 1, 'and it does not fly');
});

test('a magazine blast throws everything near it outward', () => {
  const { fracture } = prepared('stone_sea_bastion'), damage = {};
  const released = applyBuildingFractureEvents(fracture, damage, [{ kind: 'building-explosion', x: 0, y: 8, z: 0, nx: 0, ny: 0, nz: -1, radius: 12, stepDepth: 3, severity: 1.6, powderFraction: 0.9 }], 0);
  assert.ok(released > 200, `${released}`);
  const state = damage.fracture;
  let outward = 0, count = 0;
  for (let s = 1; s < fracture.shardCount; s++) {
    if (!state.broken[s]) continue;
    const shard = fracture.shards[s], record = recordOf(state, s);
    if (record[3] > 0) continue;
    count++;
    if (shard.centroid[0] * record[4] + shard.centroid[2] * record[6] > 0) outward++;
  }
  assert.ok(outward > count * 0.8, `${outward} of ${count} go outward`);
});

test('shot on the land still marks the land, and never a building', () => {
  const stride = 8, vertices = new Float32Array([5, 3, 5, 0, 1, 0, 1.5, 0.8, 5, 3, 900, 0, 1, 0, 11.125, 0.8]);
  const dirty = bakeLandImpactDeformations(vertices, [{ kind: 'terrain-crater', x: 5, y: 3, z: 5, radius: 4, stepDepth: 0.5, severity: 1 }], stride);
  assert.ok(dirty && vertices[1] < 3, 'a crater dents the ground');
  assert.equal(vertices[stride + 1], 3, 'outside its radius nothing moves');
  const walls = new Float32Array([5, 3, 5, 0, 1, 0, 11.125, 0.8]);
  assert.equal(bakeLandImpactDeformations(walls, [{ kind: 'stone-crater', x: 5, y: 3, z: 5, radius: 4, stepDepth: 0.5, severity: 1 }], stride), null, 'a shot on stone is not this code');
  assert.equal(walls[1], 3);
});

test('a building set at an angle is cut just as it is square on', () => {
  const square = prepared('bastion_trace_fortress'), turned = prepared('bastion_trace_fortress', { yaw: 0.5, x: 300, z: -700 });
  const count = (fracture) => { const kinds = [0, 0, 0, 0, 0]; for (const s of fracture.shards) if (s) kinds[s.kind]++; return kinds; };
  const a = count(square.fracture), b = count(turned.fracture);
  for (let k = 1; k < 5; k++) assert.ok(Math.abs(a[k] - b[k]) <= Math.max(6, a[k] * 0.12), `shard kind ${k}: ${a[k]} square, ${b[k]} turned`);
  const size = (s) => [s.localMax[0] - s.localMin[0], s.localMax[1] - s.localMin[1], s.localMax[2] - s.localMin[2]];
  const blocks = turned.fracture.shards.filter((s) => s?.kind === BUILDING_SHARD_KINDS.block && s.partKey === 'foundation_scarp_walls');
  for (const shard of blocks.slice(0, 50)) assert.ok(Math.max(...size(shard)) < 5.5, `a block is block-sized at any angle: ${size(shard)}`);
});

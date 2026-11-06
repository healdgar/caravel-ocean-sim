// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Hits must take blocks off a building, not pull its vertices around. They land on the ground, and what they held up comes down.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { applyBuildingFractureEvents, BUILDING_SHARD_KINDS, buildingFractureStateOf, footingUnder, prepareBuildingFracture, prepareBuildingFractureSteps, replayBuildingFracture, supportScan, traceShotThroughBreach } from '../js/building-fracture.js';
import { getBuildingParts, PORT_PREFABS } from '../js/coastal-world.js';
import { evaluateShardFlight, FRACTURE_RECORD_FLOATS, settleFinishedFlights } from '../js/ship-fracture.js';
import { applyBuildingImpactDamage, classifyBuildingMaterial, createBuildingDamageState, createGunnerySolidSweep, sweepBuildingSegment } from '../js/gunnery-control.js';
import { createPortDamageStore } from '../js/port-damage.js';
import { createFortGarrison, stepFortGarrison } from '../js/crew.js';
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
    if (!fracture.vertexShards[v] || fracture.shards[fracture.vertexShards[v]].earth) continue;
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

test('shot on the land moves neither the land mesh nor a building', () => {
  const stride = 8, vertices = new Float32Array([5, 3, 5, 0, 1, 0, 1.5, 0.8, 5, 3, 900, 0, 1, 0, 11.125, 0.8]);
  assert.equal(bakeLandImpactDeformations(vertices, [{ kind: 'terrain-crater', x: 5, y: 3, z: 5, radius: 4, stepDepth: 0.5, severity: 1 }], stride), null, 'a crater is not cut in the 16 m mesh: see land-craters');
  assert.equal(vertices[1], 3);
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

// A block on the outer face, at mid height, away from the corners and anything built onto the wall.
function midWall(fracture) {
  const blocks = fracture.shards.filter((s) => s?.kind === BUILDING_SHARD_KINDS.block && s.normal[2] < -0.9 && s.centroid[1] > 2 && s.centroid[1] < 6 && Math.abs(s.centroid[0]) < 3);
  return blocks.sort((a, b) => a.min[2] - b.min[2])[0];
}

// A line square onto a face of a building, from outside it to well past its far side.
function shotAt(fracture, shard, along = 40) {
  const n = shard.normal, c = shard.centroid;
  return { from: [c[0] + n[0] * along, c[1], c[2] + n[2] * along], to: [c[0] - n[0] * along, c[1], c[2] - n[2] * along] };
}

test('a shot goes through a breach to whatever still stands behind it', () => {
  const { fracture } = prepared('royal_warehouse'), damage = {};
  const state = buildingFractureStateOf(damage, fracture);
  const front = midWall(fracture);
  assert.ok(front, 'there is wall to shoot');
  const { from, to } = shotAt(fracture, front);
  assert.equal(traceShotThroughBreach(null, from, to), null, 'a building with no fracture is only its box');
  const first = traceShotThroughBreach(state, from, to);
  assert.ok(first.t > 0 && first.t < 0.5 + 0.05 , `nothing has left: it strikes the wall itself (${first.t.toFixed(3)})`);
  // Shot out of the wall: the line now goes in through the gap.
  state.broken[front.index] = 1;
  state.brokenCount = 1;
  const behind = traceShotThroughBreach(state, from, to);
  assert.ok(behind, 'the way in has gone');
  const frontAt = (40 - 0.1) / 80;
  assert.ok(behind.t > frontAt, `it goes past where the wall stood (${behind.t.toFixed(3)} against ${frontAt.toFixed(3)})`);
  assert.ok(behind.t < 1, 'and meets the far wall, still standing');
  // Open the far side too, along the whole line: now it passes clean through.
  const a = fracture.toLocal(...from), b = fracture.toLocal(...to);
  for (let s = 1; s < fracture.shardCount; s++) {
    const shard = fracture.shards[s];
    let low = -Infinity, high = Infinity, misses = false;
    for (let c = 0; c < 3; c++) {
      const d = b[c] - a[c];
      if (Math.abs(d) < 1e-9) { if (a[c] < shard.localMin[c] || a[c] > shard.localMax[c]) misses = true; continue; }
      const t1 = (shard.localMin[c] - a[c]) / d, t2 = (shard.localMax[c] - a[c]) / d;
      low = Math.max(low, Math.min(t1, t2));
      high = Math.min(high, Math.max(t1, t2));
    }
    if (!misses && low <= high && !state.broken[s]) { state.broken[s] = 1; state.brokenCount++; }
  }
  const clear = traceShotThroughBreach(state, from, to);
  assert.ok(clear && !(clear.t <= 1), `nothing left on the line: ${clear?.t}`);
});

test('a ball stops in the earth behind a fort\'s facing', () => {
  const { fracture } = prepared('stone_sea_bastion'), damage = {};
  const state = buildingFractureStateOf(damage, fracture);
  const block = midWall(fracture);
  assert.equal(block.partKey, 'foundation_scarp_walls');
  const { from, to } = shotAt(fracture, block);
  state.broken[block.index] = 1;
  state.brokenCount = 1;
  const behind = traceShotThroughBreach(state, from, to);
  assert.ok(behind && behind.t <= 1, 'something stops it');
  const depth = (behind.t - 0.5) * 80;
  assert.ok(depth > 0 && depth < 4, `within a few metres of the facing (${depth.toFixed(2)} m)`);
});

test('the sweep lets a ball through a breach, and strikes what stands behind', () => {
  const { fracture, instance } = prepared('royal_warehouse'), port = { instances: [instance] };
  createBuildingDamageState(instance);
  const state = buildingFractureStateOf(instance.damageState, fracture);
  const front = midWall(fracture);
  const { from, to } = shotAt(fracture, front);
  const intact = sweepBuildingSegment(from, to, 0.08, port);
  assert.ok(intact, 'it strikes the building');
  state.broken[front.index] = 1;
  state.brokenCount = 1;
  const past = sweepBuildingSegment(from, to, 0.08, port);
  assert.ok(past && past.fraction > intact.fraction, `it strikes further on (${past?.fraction} after ${intact.fraction})`);
  assert.ok(past.normal[0] * (from[0] - to[0]) + past.normal[2] * (from[2] - to[2]) > 0, 'it faces back along the flight');
  // A short step inside the gap, before the far wall: no hit at all from this building.
  const step = (t) => [from[0] + (to[0] - from[0]) * t, from[1], from[2] + (to[2] - from[2]) * t];
  const inside = sweepBuildingSegment(step(past.fraction - 0.04), step(past.fraction - 0.02), 0.08, port);
  assert.equal(inside, null, 'between the gap and the far wall it is still flying');
  const reaches = sweepBuildingSegment(step(past.fraction - 0.02), step(past.fraction + 0.02), 0.08, port);
  assert.ok(reaches && reaches.fraction > 0.3 && reaches.fraction < 0.7, `the step that reaches the far wall strikes it (${reaches?.fraction})`);
});

test('a ball strikes down soldiers ashore on its way, and stops at the first thing standing', () => {
  const instance = { prefabId: 'stone_sea_bastion', x: 0, z: 0, baseY: 0, y: 0, yaw: 0, width: 28, length: 34, depth: 34, height: 11.5 };
  const near = { position: [0, 0, 30], scale: [1, 1, 1] }, far = { position: [0, 0, -30], scale: [1, 1, 1] };
  const port = { instances: [instance], center: { x: 0, z: 0 }, garrison: { soldiers: [near, far] } };
  const sweep = createGunnerySolidSweep({ sourceBoat: null, getVessels: () => [], getTerrain: () => ({ ports: [port], height: () => -5 }) });
  const projectile = { velocity: [0, 0, -400], mass: 10, ammo: 'round' };
  const hit = sweep([0, 1, 60], [0, 1, -60], projectile);
  assert.equal(hit?.kind, 'building', 'the bastion stops it');
  assert.equal(near.casualtyState, 'fallen', 'the man in front of it is struck');
  assert.notEqual(far.casualtyState, 'fallen', 'the man behind it is not');
});

test('a building\'s damage replays exactly from its log, with nothing left in the air', () => {
  const live = prepared('royal_warehouse'), half = live.parts.dimensions.length / 2;
  const damage = {};
  const hits = [];
  for (let i = 0; i < 10; i++) hits.push(shot((i - 5) * 1.3 + 0.123, 2 + (i % 4) * 0.77, -half - 0.017));
  hits.push({ kind: 'building-collapse', x: 0, y: 6, z: -half, radius: 6, severity: 1.1 });
  // In separate frames, as the game would take them.
  for (const [i, hit] of hits.entries()) applyBuildingFractureEvents(live.fracture, damage, [hit], i * 0.2);
  const state = damage.fracture;
  assert.ok(state.brokenCount > 20, `${state.brokenCount} pieces`);
  assert.ok(damage.fractureLog.length === hits.length * 16, `${damage.fractureLog.length} characters of log`);
  const again = prepared('royal_warehouse'), restored = {};
  assert.equal(replayBuildingFracture(again.fracture, restored, damage.fractureLog, 500), state.brokenCount, 'as many pieces are gone');
  const back = restored.fracture;
  assert.deepEqual([...back.broken], [...state.broken], 'the same ones');
  assert.equal(back.flying.size, 0, 'and none is seen to fall');
  for (let s = 1; s < again.fracture.shardCount; s++) {
    assert.equal(back.scorch[s], state.scorch[s], 'worn the same');
    if (!state.broken[s]) continue;
    const c = live.fracture.shards[s].centroid;
    const a = evaluateShardFlight(recordOf(state, s), NOWHERE, c, [1, 1, 1]), b = evaluateShardFlight(recordOf(back, s), NOWHERE, c, [1, 1, 1]);
    for (let i = 0; i < 3; i++) assert.ok(Math.abs(a[i] - b[i]) < 1e-3, `piece ${s} lies where it lay: ${a} ${b}`);
  }
  assert.equal(restored.fractureLog, damage.fractureLog, 'its log comes back too');
  const noEffect = {};
  applyBuildingFractureEvents(live.fracture, noEffect, [shot(0, 500, 0)], 0);
  assert.equal(noEffect.fractureLog ?? '', '', 'a hit that touches nothing is not kept');
});

test('a port\'s saved damage comes back on the same port, unless the town has rebuilt', () => {
  const day = 86400000, start = Date.UTC(1650, 0, 1);
  const makePort = () => ({
    regionId: 'lisbon',
    instances: [
      { id: 'fort', prefabId: 'stone_sea_bastion', x: 10, z: 20, baseY: 0, y: 0, yaw: 0, width: 28, length: 34, depth: 34, height: 11.5 },
      { id: 'shed', prefabId: 'careening_shed', x: 90, z: 20, baseY: 0, y: 0, yaw: 0, width: 11, length: 22, depth: 22, height: 5.6 },
    ],
  });
  const port = makePort(), fort = port.instances[0];
  let date = start;
  const store = createPortDamageStore();
  store.setClock(() => date);
  assert.equal(store.snapshot([port]), undefined, 'nothing hit, nothing saved');
  assert.equal(store.forLink(port), undefined);
  for (let i = 0; i < 6; i++) applyBuildingImpactDamage(fort, { localPosition: [i - 3, 3, 17], position: [10, 3, 37], surfacePosition: [10 + i - 3, 3, 37], normal: [0, 0, 1], velocity: [0, 0, -330], mass: 14.5, ammo: 'round' });
  store.noteHit(fort.damageState);
  const saved = JSON.parse(JSON.stringify(store.snapshot([port])));
  assert.deepEqual(Object.keys(saved), ['lisbon'], 'one port');
  assert.deepEqual(Object.keys(saved.lisbon), ['fort'], 'the building that was hit, and no other');
  assert.ok(saved.lisbon.fort.l.length >= 6 * 16, 'it holds the hits, not yet applied');
  assert.ok(JSON.stringify(saved).length < 2000, `small enough for a link (${JSON.stringify(saved).length})`);

  const later = makePort(), loaded = createPortDamageStore(saved, { dateMs: start + 3 * day });
  assert.equal(loaded.restore(later), 1);
  const d = later.instances[0].damageState;
  assert.equal(d.state, fort.damageState.state);
  assert.equal(d.integrity, +fort.damageState.integrity.toFixed(4));
  assert.equal(d.hits, 6);
  assert.equal(d.replayLog, saved.lisbon.fort.l, 'the next update puts its stones back');
  assert.equal(later.instances[1].damageState, undefined, 'what was not hit is not touched');

  const other = makePort();
  other.regionId = 'havana';
  assert.equal(createPortDamageStore(saved).restore(other), 0, 'another port takes nothing from it');
  const moved = makePort();
  moved.instances[0].prefabId = 'torreon_atalaya_farol';
  assert.equal(createPortDamageStore(saved).restore(moved), 0, 'nor a different building on the spot');

  const rebuilt = createPortDamageStore(saved, { dateMs: start + 400 * day }), returned = makePort();
  assert.equal(rebuilt.restore(returned), 0, 'away long enough, and the town has rebuilt it');
  assert.equal(rebuilt.snapshot([returned]), undefined, 'and nothing is saved of it');

  // Rebuilt while we watch.
  date = start + 10 * day;
  assert.equal(store.rebuildDue(fort), false, 'not yet');
  date = start + 200 * day;
  assert.equal(store.rebuildDue(fort), true, 'long enough since the last shot');
  fort.magazine.exploded = true;
  store.rebuilt(port, fort);
  assert.equal(fort.damageState.state, 'intact');
  assert.equal(fort.damageState.hits, 0);
  assert.equal(fort.magazine.exploded, false, 'its magazine is filled again');
  assert.equal(store.snapshot([port]), undefined, 'no damage is kept of it');
});

test('a port with no record costs one lookup', () => {
  const store = createPortDamageStore(), port = { regionId: 'lisbon', get instances() { throw Error('it read the buildings'); } };
  assert.equal(createPortDamageStore().restore({ regionId: 'lisbon' }), 0);
  assert.throws(() => store.restore(port), /read the buildings/, 'the getter is real');
  const untouched = { regionId: 'lisbon', instances: [{ id: 'a', prefabId: 'careening_shed', x: 0, z: 0 }] };
  assert.equal(store.restore(untouched), 0);
  assert.equal(untouched.instances[0].damageState, undefined);
});

test('a share link keeps the worst of a port, within its room', () => {
  const store = createPortDamageStore();
  const port = { regionId: 'lisbon', instances: [] };
  for (let i = 0; i < 12; i++) {
    const building = { id: `b${i}`, prefabId: 'careening_shed', x: i, z: 0, baseY: 0, yaw: 0 };
    const d = createBuildingDamageState(building);
    d.hits = 40; d.integrity = i / 20; d.state = 'breached';
    d.fractureLog = 'A'.repeat(16 * 90);
    port.instances.push(building);
  }
  const link = store.forLink(port), kept = Object.keys(link.lisbon);
  assert.ok(kept.length > 0 && kept.length < 12, `${kept.length} of 12`);
  assert.ok(kept.includes('b0'), 'the worst is in it');
  assert.ok(JSON.stringify(link).length < 10000, 'a link has room for it');
  assert.equal(Object.keys(store.snapshot([port]).lisbon).length, 12, 'the career save has room for all');
});

test('a roof comes down when the walls under it have gone', () => {
  for (const prefabId of ['stone_sea_bastion', 'royal_warehouse', 'casa_de_contratacion']) {
    const { fracture } = prepared(prefabId), shards = fracture.shards.filter(Boolean);
    const roof = shards.filter((s) => /^roof_/.test(s.partKey));
    assert.ok(roof.length > 3, `${prefabId} has a roof`);
    const fixed = roof.filter((s) => s.anchored);
    assert.ok(fixed.length < roof.length * 0.1, `${prefabId}: ${fixed.length} of ${roof.length} roof pieces are fixed in the air`);
    const broken = new Uint8Array(fracture.shardCount);
    for (const s of shards) if (!/^roof_/.test(s.partKey)) broken[s.index] = 1;
    const hang = supportScan(fracture, broken);
    const stillUp = roof.filter((s) => hang[s.index] !== 255);
    assert.ok(stillUp.length < roof.length * 0.1, `${prefabId}: ${stillUp.length} of ${roof.length} roof pieces hang on with every wall gone`);
  }
});

function garrisoned(prefabId, ground = 0) {
  const built = prepared(prefabId, { ground }), { fracture, instance } = built;
  instance.id = 'held';
  const port = { regionId: 'test', instances: [instance], center: { x: 0, z: 0 } };
  const garrison = createFortGarrison(port);
  createBuildingDamageState(instance);
  const state = buildingFractureStateOf(instance.damageState, fracture);
  return { ...built, port, garrison, state, soldiers: garrison.soldiers };
}
// Knock out whatever is under a point, as if a shot had taken it.
function breakUnder(state, x, y, z, reach = 0.2) {
  let broken = 0;
  for (const shard of state.fracture.shards) {
    if (!shard || state.broken[shard.index]) continue;
    const lo = shard.localMin, hi = shard.localMax;
    if (lo[1] > y + 0.2 || hi[1] < y - 1.1 || x < lo[0] - reach || x > hi[0] + reach || z < lo[2] - reach || z > hi[2] + reach) continue;
    state.broken[shard.index] = 1;
    state.brokenCount++;
    broken++;
  }
  return broken;
}
const onlyOnPieces = (state, soldiers) => soldiers.filter((s) => {
  const footing = footingUnder(state, s.lx, s.ly, s.lz);
  return footing.stood && footing.stands && footing.floor === null;
});

test('a man comes down with the stretch he stands on, and the rest stay at their posts', () => {
  const { state, garrison, soldiers } = garrisoned('curtain_wall_and_gate');
  assert.ok(soldiers.length >= 2, `${soldiers.length} men on the wall`);
  stepFortGarrison(garrison, 0.016);
  assert.ok(soldiers.every((s) => s.casualtyState !== 'fallen'), 'with nothing broken, nobody falls');
  const standing = onlyOnPieces(state, soldiers);
  assert.ok(standing.length >= 2, `${standing.length} men stand on pieces that can go`);
  const doomed = standing[0], from = doomed.baseLy, others = soldiers.filter((s) => s !== doomed && Math.hypot(s.lx - doomed.lx, s.lz - doomed.lz) > 3);
  assert.ok(others.length, 'there is someone away from him');
  assert.ok(breakUnder(state, doomed.lx, doomed.ly, doomed.lz) > 0);
  state.flying.add(1);
  stepFortGarrison(garrison, 0.016);
  assert.equal(doomed.casualtyState, 'fallen', 'he goes down');
  assert.ok(doomed.garrisonFall, 'and falls, it is not a jump cut');
  assert.ok(doomed.baseLy > 0.5, 'he has only just started');
  for (let i = 0; i < 200 && doomed.garrisonFall; i++) stepFortGarrison(garrison, 0.05);
  assert.equal(doomed.garrisonFall, null);
  assert.ok(doomed.baseLy < from - 1 && doomed.baseLy >= 0 && doomed.baseLy < 1.5, `he lies at the foot of the wall (${doomed.baseLy.toFixed(2)} from ${from.toFixed(2)})`);
  for (const s of others) assert.notEqual(s.casualtyState, 'fallen', 'the others stay at their posts');
});

test('a man walking a rampart keeps to what is left of his beat', () => {
  const { state, garrison, soldiers } = garrisoned('curtain_wall_and_gate');
  const walker = onlyOnPieces(state, soldiers).find((s) => s.routeZ && Math.abs(s.routeZ[1] - s.routeZ[0]) > 4);
  assert.ok(walker, 'someone walks the wall');
  const [a, b] = walker.routeZ, far = Math.abs(a - walker.lz) > Math.abs(b - walker.lz) ? a : b;
  const gapAt = walker.lz + (far - walker.lz) * 0.7;
  assert.ok(breakUnder(state, walker.lx, walker.ly, gapAt) > 0);
  stepFortGarrison(garrison, 0.016);
  assert.notEqual(walker.casualtyState, 'fallen', 'the gap is not under him');
  const [lo, hi] = [Math.min(...walker.routeZ), Math.max(...walker.routeZ)];
  assert.ok(gapAt < lo || gapAt > hi, `his beat now stops short of the gap at ${gapAt.toFixed(1)} (${lo.toFixed(1)} to ${hi.toFixed(1)})`);
  assert.ok(walker.lz >= lo - 1e-6 && walker.lz <= hi + 1e-6, 'and he is still on it');
  assert.ok(walker.targetZ >= lo - 1e-6 && walker.targetZ <= hi + 1e-6, 'walking only where he can');
  for (let i = 0; i < 400; i++) stepFortGarrison(garrison, 0.05);
  assert.ok(walker.lz >= lo - 1e-6 && walker.lz <= hi + 1e-6, `he never walks off the edge (${walker.lz.toFixed(2)})`);
});

test('men on a fort\'s deck step down to it, but do not fall, when the parapet goes', () => {
  const { state, garrison, soldiers } = garrisoned('stone_sea_bastion');
  const onDeck = soldiers.filter((s) => { const f = footingUnder(state, s.lx, s.ly, s.lz); return f.stands && f.floor !== null; });
  for (const s of soldiers) breakUnder(state, s.lx, s.ly, s.lz);
  const levels = new Map(soldiers.map((s) => [s, s.baseLy]));
  state.flying.add(1);
  stepFortGarrison(garrison, 0.016);
  for (const s of onDeck) assert.notEqual(s.casualtyState, 'fallen', `${s.role} has the rampart under him`);
  for (const s of soldiers) if (s.casualtyState !== 'fallen') assert.ok(s.baseLy <= levels.get(s) + 1e-6, 'nobody rises');
  const down = soldiers.filter((s) => s.casualtyState === 'fallen');
  assert.ok(down.every((s) => footingUnder(state, s.lx, levels.get(s), s.lz).floor === null), 'only those with no floor left fall');
});

test('a saved ruin has its men already down, and a rebuilt one has them back at their posts', () => {
  const live = garrisoned('curtain_wall_and_gate'), half = live.instance.width / 2;
  const doomed = onlyOnPieces(live.state, live.soldiers)[0];
  const events = [];
  for (let i = -2; i <= 2; i++) for (const height of [1.5, 3, 4.5]) events.push({ kind: 'stone-crater', x: half, y: height, z: doomed.lz + i * 1.2, nx: 1, ny: 0, nz: 0, stepDepth: 0.44, severity: 1.2 }, { kind: 'stone-crater', x: -half, y: height, z: doomed.lz + i * 1.2, nx: -1, ny: 0, nz: 0, stepDepth: 0.44, severity: 1.2 });
  applyBuildingFractureEvents(live.state.fracture, live.instance.damageState, events, 0);
  assert.ok(live.state.brokenCount > 10);
  stepFortGarrison(live.garrison, 0.016);
  for (let i = 0; i < 200; i++) stepFortGarrison(live.garrison, 0.05);
  const fell = live.soldiers.filter((s) => s.casualtyState === 'fallen').map((s) => s.crewIndex);
  assert.ok(fell.length > 0, 'somebody came down');
  const levels = live.soldiers.map((s) => s.baseLy);

  const back = garrisoned('curtain_wall_and_gate');
  replayBuildingFracture(back.state.fracture, back.instance.damageState, live.instance.damageState.fractureLog, 900);
  const state = back.instance.damageState.fracture;
  assert.equal(state.flying.size, 0);
  stepFortGarrison(back.garrison, 0.016);
  assert.deepEqual(back.soldiers.filter((s) => s.casualtyState === 'fallen').map((s) => s.crewIndex), fell, 'the same men are down');
  assert.ok(back.soldiers.every((s) => !s.garrisonFall), 'none of them is seen to fall');
  back.soldiers.forEach((s, i) => assert.ok(Math.abs(s.baseLy - levels[i]) < 1e-3, `${s.role} lies where he lay: ${s.baseLy} ${levels[i]}`));

  const homes = garrisoned('curtain_wall_and_gate').soldiers.map((s) => [s.baseLy, [...s.routeZ]]);
  createPortDamageStore().rebuilt(back.port, back.instance);
  stepFortGarrison(back.garrison, 0.016);
  back.soldiers.forEach((s, i) => {
    assert.notEqual(s.casualtyState, 'fallen', 'back on his feet');
    assert.equal(s.baseLy, homes[i][0], 'at his post');
    assert.deepEqual(s.routeZ, homes[i][1], 'on his old beat');
  });
});

test('what stays of a building faces up, so it reads as ground once the walls have gone', () => {
  const { fracture, vertices } = prepared('curtain_wall_and_gate');
  let flat = 0, facingDown = 0;
  for (let v = 0; v < fracture.vertexShards.length; v++) {
    if (fracture.vertexShards[v]) continue;
    const at = v * 8, ny = vertices[at + 4], length = Math.hypot(vertices[at + 3], ny, vertices[at + 5]);
    if (Math.abs(ny) / length < 0.7) continue;
    flat++;
    if (ny < 0) facingDown++;
  }
  assert.ok(flat > 0, 'there are flats that stay');
  assert.equal(facingDown, 0, 'none is lit as if it faced the ground');
});

test('a broad floor comes down in slabs, not as one sheet', () => {
  const { fracture } = prepared('curtain_wall_and_gate');
  const walk = fracture.shards.filter((s) => s?.partKey === 'terreplein_adarve_walk');
  assert.ok(walk.length > 2, `${walk.length} pieces of wall walk`);
  for (const shard of walk) assert.ok(Math.max(shard.localMax[0] - shard.localMin[0], shard.localMax[2] - shard.localMin[2]) < 14, `one is ${shard.localMax[2] - shard.localMin[2]} m long`);
});

// The firing line runs from a bearing through a point on the building, far enough out on both sides.
function hammer(prefabId, bearingDegrees, aimOf, shots = 12) {
  const { fracture, instance } = prepared(prefabId), port = { instances: [instance] };
  createBuildingDamageState(instance);
  buildingFractureStateOf(instance.damageState, fracture);
  const a = (bearingDegrees * Math.PI) / 180, d = [Math.sin(a), 0, -Math.cos(a)], aim = aimOf(instance);
  const from = [aim[0] - d[0] * 200, aim[1], aim[2] - d[2] * 200], to = [aim[0] + d[0] * 200, aim[1], aim[2] + d[2] * 200];
  let broke = 0, hits = 0;
  for (let n = 0; n < shots; n++) {
    const hit = sweepBuildingSegment(from, to, 0.07, port);
    if (!hit) continue;
    hits++;
    applyBuildingImpactDamage(instance, { ...hit, mass: 10.9, ammo: 'round', velocity: [d[0] * 420, 0, d[2] * 420], energy: 961000 });
    broke += applyBuildingFractureEvents(fracture, instance.damageState, instance.damageState.pendingBakes.splice(0), n);
  }
  return { broke, hits };
}

test('no angle on a fort\'s corner is a hard point: every bearing keeps breaking it', () => {
  for (const prefabId of ['bastion_trace_fortress', 'stone_sea_bastion']) {
    const corner = (instance) => [instance.width * 0.42, instance.height * 0.5, instance.length * 0.42];
    for (const bearing of [0, 30, 45, 90, 120, 135, 180, 225, 270, 315]) {
      const { broke, hits } = hammer(prefabId, bearing, corner);
      assert.ok(hits >= 3, `${prefabId} from ${bearing}: ${hits} hits`);
      assert.ok(broke >= 60, `${prefabId} from ${bearing}: 12 shots broke only ${broke} pieces`);
    }
  }
});

test('a ball goes on through a fort\'s facing and the earth behind it, and opens a breach', () => {
  const { fracture, instance } = prepared('stone_sea_bastion'), port = { instances: [instance] };
  createBuildingDamageState(instance);
  const state = buildingFractureStateOf(instance.damageState, fracture);
  const y = instance.height * 0.5, from = [0, y, 200], to = [0, y, -200];
  assert.ok(fracture.shards.some((shard) => shard?.earth), 'a fort has earth to break');
  const first = sweepBuildingSegment(from, to, 0.07, port).localPosition[2];
  let last = first, n = 0;
  for (; n < 40; n++) {
    const hit = sweepBuildingSegment(from, to, 0.07, port);
    if (!hit) break;
    last = hit.localPosition[2];
    applyBuildingImpactDamage(instance, { ...hit, mass: 10.9, ammo: 'round', velocity: [0, 0, -420], energy: 961000 });
    applyBuildingFractureEvents(fracture, instance.damageState, instance.damageState.pendingBakes.splice(0), n);
  }
  assert.ok(first - last > 3.5, `it digs in: from ${first.toFixed(1)} to ${last.toFixed(1)} in ${n} shots`);
  assert.ok(n >= 4, `earth takes more than one ball: ${n}`);
  assert.ok(state.broken.some((gone, s) => gone && fracture.shards[s]?.earth), 'and the earth breaks');
});

test('a breach in a fort goes on widening after the ball reaches the earth behind the facing, and replays the same', () => {
  const { fracture, instance } = prepared('stone_sea_bastion'), port = { instances: [instance] };
  createBuildingDamageState(instance);
  const state = buildingFractureStateOf(instance.damageState, fracture);
  const aim = [instance.width * 0.42, instance.height * 0.5, instance.length * 0.42], from = [aim[0], aim[1], aim[2] + 200], to = [aim[0], aim[1], aim[2] - 200];
  const counts = [];
  for (let n = 0; n < 12; n++) {
    const hit = sweepBuildingSegment(from, to, 0.07, port);
    if (!hit) break;
    applyBuildingImpactDamage(instance, { ...hit, mass: 10.9, ammo: 'round', velocity: [0, 0, -420], energy: 961000 });
    applyBuildingFractureEvents(fracture, instance.damageState, instance.damageState.pendingBakes.splice(0), n);
    counts.push(state.brokenCount);
  }
  assert.ok(counts[3] > counts[1] && counts[7] > counts[3], `still widening: ${counts.join(' ')}`);
  assert.ok(counts[11] > 120, `a wide breach: ${counts[11]}`);
  const damage = {};
  replayBuildingFracture(fracture, damage, instance.damageState.fractureLog, 100);
  assert.deepEqual([...damage.fracture.broken], [...state.broken]);
});

test('a ball meets a triangular fort\'s walls, not the air in the corners of its box', () => {
  const { fracture, instance } = prepared('english_triangular_palisade_fort'), port = { instances: [instance] };
  createBuildingDamageState(instance);
  buildingFractureStateOf(instance.damageState, fracture);
  // Across the corner of the box, where there is no wall.
  const x = instance.width * 0.42, z = instance.length * 0.42;
  assert.equal(sweepBuildingSegment([x, 3, z + 40], [x, 3, z - 4], 0.07, port), null);
  // And when it does strike, it strikes something: there is a piece where it lands.
  const hit = sweepBuildingSegment([0, 3, 200], [0, 3, -200], 0.07, port);
  assert.ok(hit, 'the fort has walls');
  const l = hit.localPosition;
  const gap = Math.min(...fracture.strikable.map((s) => {
    const { localMin: lo, localMax: hi } = fracture.shards[s];
    return Math.hypot(Math.max(lo[0] - l[0], 0, l[0] - hi[0]), Math.max(lo[1] - l[1], 0, l[1] - hi[1]), Math.max(lo[2] - l[2], 0, l[2] - hi[2]));
  }));
  assert.ok(gap < 0.5, `${gap.toFixed(2)} m from anything`);
});

test('a bastion reaching beyond the box still stops a ball', () => {
  const { fracture, instance } = prepared('bastion_trace_fortress'), port = { instances: [instance] };
  createBuildingDamageState(instance);
  buildingFractureStateOf(instance.damageState, fracture);
  const { reach } = fracture;
  assert.ok(reach.max[0] > instance.width / 2 + 2, 'the star reaches well past its nominal box');
  const hits = [];
  for (let z = reach.min[2]; z <= reach.max[2]; z += 1) {
    const hit = sweepBuildingSegment([200, 5, z], [-200, 5, z], 0.07, port);
    if (hit) hits.push(hit.localPosition[0]);
  }
  assert.ok(Math.max(...hits) > instance.width / 2 + 1, `it strikes out on the bastions (${Math.max(...hits).toFixed(1)})`);
});

test('a turned building reaches as far as a square one, and a ball meets only what is drawn', () => {
  // Every real port turns its buildings. Boxes laid square to the world used to balloon when turned.
  for (const prefabId of ['stone_quay_seawall', 'stone_sea_bastion', 'bastion_trace_fortress']) {
    const square = prepared(prefabId).fracture.reach, { fracture, instance } = prepared(prefabId, { yaw: 2.1, x: 300, z: -150 });
    for (let c = 0; c < 3; c++) {
      assert.ok(Math.abs(fracture.reach.min[c] - square.min[c]) < 0.5 && Math.abs(fracture.reach.max[c] - square.max[c]) < 0.5,
        `${prefabId}, axis ${c}: ${fracture.reach.min[c].toFixed(1)}..${fracture.reach.max[c].toFixed(1)} turned, ${square.min[c].toFixed(1)}..${square.max[c].toFixed(1)} square`);
    }
    // A line along the building, just clear of everything drawn, strikes nothing.
    createBuildingDamageState(instance);
    buildingFractureStateOf(instance.damageState, fracture);
    const { toWorld, reach } = fracture, y = instance.height * 0.5;
    const from = toWorld(reach.max[0] + 0.5, y, -300), to = toWorld(reach.max[0] + 0.5, y, 300);
    assert.equal(sweepBuildingSegment(from, to, 0.07, { center: { x: 300, z: -150 }, instances: [instance] }), null, `${prefabId}: nothing stands out there`);
  }
});

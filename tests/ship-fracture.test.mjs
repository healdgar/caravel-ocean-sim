// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Repeated hits must take pieces off a ship, not pull her vertices around.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { createShipAssetCache } from '../js/ship-mesh.js';
import { SHIP_MODELS } from '../js/ship-models.js';
import { indexCaravelMesh, createCaravelMesh } from '../js/caravel.js';
import { bakeVesselImpactMarks } from '../js/part-assembly.js';
import { applyShipImpactDamage, sweepShipSegment, stepVesselDamage } from '../js/gunnery-control.js';
import { repairVessel, vesselDamageSnapshot, restoreVesselDamageSnapshot, raiseVesselRig } from '../js/vessel-damage.js';
import { buildVesselRigConnectors } from '../js/ship-colors.js';
import { SHARD_KINDS, FRACTURE_RECORD_FLOATS, applyFractureEvents, evaluateShardFlight, settleFinishedFlights, shipFractureStateOf, syncFractureWithDamage } from '../js/ship-fracture.js';

const cache = createShipAssetCache();
const ready = Object.values(SHIP_MODELS).filter((m) => m.status === 'ready' && m.geometry);
const recordOf = (state, s) => state.records.subarray(s * FRACTURE_RECORD_FLOATS, (s + 1) * FRACTURE_RECORD_FLOATS);
const verticesOfShard = (fracture, s) => { const list = []; for (let v = 0; v < fracture.vertexShards.length; v++) if (fracture.vertexShards[v] === s) list.push(v); return list; };
const point = (vertices, v) => [vertices[v * 9], vertices[v * 9 + 1], vertices[v * 9 + 2]];

function shipOf(modelId) {
  const asset = cache.get(modelId), { length, beam } = asset.model.runtime;
  return { id: 't', modelId, model: asset.model, partAssembly: asset.partAssembly, length, beam, x: 0, z: 0, heave: 0, heading: 0, roll: 0, pitch: 0, sailFore: 1, sailMain: 1, sailMizzen: 1 };
}
function broadside(boat, shots, { mass, speed, minY, maxY, seed = 7, each = () => {} }) {
  const next = () => (seed = (seed * 16807) % 2147483647) / 2147483647;
  for (let i = 0; i < shots; i++) {
    const z = (next() - 0.5) * boat.length * 0.9, y = minY + next() * (maxY - minY);
    const hit = sweepShipSegment([boat.length, y, z], [-boat.length, y, z], 0.08, boat, { id: 'gun', x: boat.length * 2, z: 0, heave: 0, heading: 0, pitch: 0, roll: 0 });
    if (!hit) continue;
    applyShipImpactDamage(boat, { ...hit, velocity: [-speed, -2, 0], mass, energy: 0.5 * mass * speed * speed, ammo: 'round' });
    each(boat);
  }
}

test('an intact ship draws exactly the same triangles, and no earlier vertex changed', () => {
  for (const model of ready) {
    const asset = cache.get(model.id), f = asset.fracture;
    assert.ok(f, `${model.id} has a fracture table`);
    assert.equal(f.vertexShards.length, asset.vertices.length / 9, `${model.id} assigns a shard to every vertex`);
    assert.ok(asset.indices.length % 3 === 0);
    assert.ok(asset.vertices.every(Number.isFinite), `${model.id} vertices stay finite`);
    for (let t = 0; t < asset.indices.length; t += 3) {
      const s = f.vertexShards[asset.indices[t]];
      assert.equal(f.vertexShards[asset.indices[t + 1]], s, `${model.id} triangle ${t / 3} crosses a shard edge`);
      assert.equal(f.vertexShards[asset.indices[t + 2]], s, `${model.id} triangle ${t / 3} crosses a shard edge`);
    }
  }
  const raw = createCaravelMesh({}), base = indexCaravelMesh(raw), nina = cache.get('nina');
  assert.deepEqual(nina.vertices.subarray(0, base.vertices.length), base.vertices, 'Niña keeps every original vertex, byte for byte');
  for (let t = 0, n = base.indices.length; t < n; t += 3) {
    // Mast tubes were cut, so only compare triangles that kept their corners.
    const before = [0, 1, 2].map((k) => point(base.vertices, base.indices[t + k]).join());
    const after = [0, 1, 2].map((k) => point(nina.vertices, nina.indices[t + k]).join());
    if (nina.partAssembly.parts[nina.partAssembly.trianglePartIds[t / 3]].id.startsWith('mast.')) continue;
    assert.deepEqual(after, before, `triangle ${t / 3} stays where it was`);
  }
});

test('a pole mast is really cut: no triangle of any section reaches across a break', () => {
  for (const id of ['nina', 'pinta', 'santa-maria', 'flying-cloud', 'gipsy-moth-iv', 'oseberg', 'lusoria']) {
    const asset = cache.get(id), f = asset.fracture, cat = asset.partAssembly;
    for (const [mastId, mast] of Object.entries(f.masts)) {
      const part = cat.partsById[`mast.${mastId}`];
      const margin = 0.45 * 0.3;
      for (let t = 0; t < asset.indices.length; t += 3) {
        const owner = cat.parts[cat.trianglePartIds[t / 3]].id;
        if (owner !== part.id && owner !== `mast.${mastId}.cut`) continue;
        const ys = [0, 1, 2].map((k) => asset.vertices[asset.indices[t + k] * 9 + 1]);
        const lo = Math.min(...ys), hi = Math.max(...ys);
        // Short fittings sit wholly in one section. Only a long spar has to be cut.
        if (hi - lo < 0.6) continue;
        for (const cut of [mast.fullCut, mast.topCut]) {
          assert.ok(!(lo < cut - margin && hi > cut + margin), `${id} ${mastId} triangle ${t / 3} crosses ${cut}: ${lo}..${hi}`);
        }
      }
    }
  }
});

test('a battle never moves timber: a bake changes only the damage mark, and only cloth is displaced', () => {
  for (const [modelId, ball] of [['nina', { mass: 5.4, speed: 420 }], ['victory', { mass: 14.5, speed: 430 }]]) {
    const asset = cache.get(modelId), mesh = new Float32Array(asset.vertices), boat = shipOf(modelId);
    broadside(boat, 60, { ...ball, minY: 0.5, maxY: modelId === 'victory' ? 34 : 9, each: () => { for (let i = 0; i < 2; i++) stepVesselDamage(boat, 0.25); } });
    const kinds = new Set(boat.damage.pendingBakes.map((b) => b.kind ?? 'crater'));
    assert.ok(kinds.has('mast-break') && kinds.has('crater'), `${modelId} battle queued breaks and craters: ${[...kinds]}`);
    bakeVesselImpactMarks(mesh, boat.damage.pendingBakes, 9);
    let moved = 0, marked = 0;
    for (let v = 0, n = mesh.length / 9; v < n; v++) {
      const at = v * 9, mat = Math.floor(asset.vertices[at + 6]);
      if (mesh[at] !== asset.vertices[at] || mesh[at + 1] !== asset.vertices[at + 1] || mesh[at + 2] !== asset.vertices[at + 2]) {
        if (mat !== 9 && mat !== 13) moved++;
      }
      if (Math.hypot(mesh[at + 3], mesh[at + 4], mesh[at + 5]) > 1.05) marked++;
    }
    assert.equal(moved, 0, `${modelId} has no timber or rope vertex moved by damage`);
    assert.ok(marked > 200, `${modelId} still carries scorch marks (${marked})`);
  }
});

test('the Niña\'s quarterdeck and cabin roof do not belong to her mizzen, so a falling mast cannot tilt them', () => {
  const asset = cache.get('nina'), f = asset.fracture, cat = asset.partAssembly;
  for (const id of ['deck.quarter.bed', 'deck.quarter.planks', 'deck.main.planks', 'hull.keel-stem']) {
    const part = cat.partsById[id];
    assert.ok(part, id);
    for (let v = 0; v < f.vertexShards.length; v++) {
      if (cat.vertexPartIds[v] === part.partNumber) assert.equal(f.vertexShards[v], 0, `${id} stays with the ship`);
    }
  }
  const mastShards = new Set(f.shards.filter((s) => s && s.mast).map((s) => s.index));
  for (let v = 0; v < f.vertexShards.length; v++) {
    if (cat.parts[cat.vertexPartIds[v]].id === 'cabin') assert.ok(!mastShards.has(f.vertexShards[v]), 'cabin vertices never go with a mast');
  }
});

test('Victory\'s mast rings fall with the mast they are on, and never leave it', () => {
  const asset = cache.get('victory'), f = asset.fracture, cat = asset.partAssembly, vertices = asset.vertices, scale = f.scale;
  for (const mastId of ['fore', 'main', 'mizzen']) {
    const mast = f.masts[mastId], part = cat.partsById[`mast.${mastId}`], spec = { z: mast.z };
    const shaft = [], rings = [];
    for (let v = 0; v < f.vertexShards.length; v++) {
      if (cat.vertexPartIds[v] !== part.partNumber) continue;
      const mat = Math.floor(vertices[v * 9 + 6]), y = vertices[v * 9 + 1], radial = Math.hypot(vertices[v * 9], vertices[v * 9 + 2] - spec.z);
      if (mat === 21 && y > mast.fullCut + 0.01) shaft.push(v);
      if (mat === 20 && radial < 0.3 && y > mast.fullCut + 0.1 && y < mast.topCut - 0.3) rings.push(v);
    }
    assert.ok(shaft.length && rings.length > 100, `${mastId} has a shaft and a stack of rings`);
    const shardOf = new Set([...shaft, ...rings].map((v) => f.vertexShards[v]));
    assert.equal(shardOf.size, 1, `${mastId} rings and shaft are one rigid body`);

    // The worst sequence from the report: the topmast goes, then the whole mast.
    const boat = shipOf('victory');
    boat.damage = null;
    const damage = {};
    applyFractureEvents(f, damage, [{ kind: 'mast-break', mastGroup: mastId, stage: 'topmast', side: 1 }], 10);
    applyFractureEvents(f, damage, [{ kind: 'mast-break', mastGroup: mastId, stage: 'full', side: 1 }], 20);
    const state = damage.fracture, s = [...shardOf][0], record = recordOf(state, s);
    assert.equal(state.broken[s], 1);
    for (const t of [0.5, 2, 5]) {
      const clock = 20 - state.epoch + t;
      const reference = shaft.slice(0, 2).map((v) => evaluateShardFlight(record, clock, point(vertices, v), scale));
      const before = Math.hypot(...point(vertices, shaft[0]).map((x, i) => (x - point(vertices, shaft[1])[i]) * scale[i]));
      const after = Math.hypot(...reference[0].map((x, i) => (x - reference[1][i]) * scale[i]));
      assert.ok(Math.abs(before - after) < 1e-3, 'the shaft keeps its length in metres');
      for (const ring of rings.filter((_, i) => i % 40 === 0)) {
        const moved = evaluateShardFlight(record, clock, point(vertices, ring), scale);
        const was = Math.hypot(...point(vertices, ring).map((x, i) => (x - point(vertices, shaft[0])[i]) * scale[i]));
        const now = Math.hypot(...moved.map((x, i) => (x - reference[0][i]) * scale[i]));
        assert.ok(Math.abs(was - now) < 1e-3, `${mastId} ring keeps its distance to the shaft at ${t} s: ${was} vs ${now}`);
      }
    }
  }
});

test('a topmast goes first with what is on it, and the stump always stays', () => {
  for (const model of ready) {
    const f = cache.get(model.id).fracture;
    for (const [mastId, mast] of Object.entries(f.masts)) {
      assert.ok(mast.upper.length && mast.lower.length, `${model.id} ${mastId} has an upper and a lower section`);
      const damage = {};
      applyFractureEvents(f, damage, [{ kind: 'mast-break', mastGroup: mastId, stage: 'topmast', side: -1 }], 1);
      for (const s of mast.upper) assert.equal(damage.fracture.broken[s], 1);
      for (const s of mast.lower) assert.equal(damage.fracture.broken[s], 0, `${model.id} ${mastId} lower mast stands until it is shot through`);
      const standing = verticesOfShard(f, 0).length;
      assert.ok(standing > 0);
      applyFractureEvents(f, damage, [{ kind: 'mast-break', mastGroup: mastId, stage: 'full', side: -1 }], 2);
      for (const s of mast.lower) assert.equal(damage.fracture.broken[s], 1);
    }
  }
  // Sails and yards name their masts, so a foremast break takes only the foremast's.
  const santa = cache.get('santa-maria'), cat = santa.partAssembly, f = santa.fracture, damage = {};
  applyFractureEvents(f, damage, [{ kind: 'mast-break', mastGroup: 'fore', stage: 'full', side: 1 }], 1);
  const brokenPart = (id) => { const part = cat.partsById[id]; for (let v = 0; v < f.vertexShards.length; v++) if (cat.vertexPartIds[v] === part.partNumber) return damage.fracture.broken[f.vertexShards[v]] === 1; return null; };
  assert.equal(brokenPart('sail.fore-course'), true);
  assert.equal(brokenPart('sail.main-course'), false);
  assert.equal(brokenPart('yard.main-course'), false);
});

test('one light shot marks a shard and repeated shots break it, while one heavy shot goes straight through', () => {
  const f = cache.get('nina').fracture;
  const target = f.shards.find((s) => s && s.kind === SHARD_KINDS.skin && s.partId === 'cabin');
  assert.ok(target, 'the cabin has skin shards');
  const at = target.centroid, light = { x: at[0], y: at[1], z: at[2], side: 1, radius: 0.06, stepDepth: 0.12, severity: 0.5 };
  const damage = {};
  applyFractureEvents(f, damage, [light], 0);
  assert.equal(damage.fracture.broken[target.index], 0, 'one light shot leaves it on');
  assert.ok(damage.fracture.wear[target.index] > 0, 'but it takes wear');
  let hits = 1;
  while (!damage.fracture.broken[target.index] && hits < 30) { applyFractureEvents(f, damage, [light], hits); hits++; }
  assert.ok(hits > 2 && hits < 30, `compounded light shots break it (${hits})`);

  const heavy = {};
  applyFractureEvents(f, heavy, [{ ...light, stepDepth: 0.3, severity: 1 }], 0);
  assert.equal(heavy.fracture.broken[target.index], 1, 'a penetrating shot takes it at once');
});

test('a piece flies rigidly, meets the water and is gone, and what it held comes down too', () => {
  const asset = cache.get('nina'), f = asset.fracture, scale = f.scale, vertices = asset.vertices;
  const target = f.shards.find((s) => s && s.kind === SHARD_KINDS.skin && s.links.length && s.triangleCount > 12);
  const damage = {}, event = { x: target.centroid[0], y: target.centroid[1], z: target.centroid[2], side: 1, stepDepth: 0.3, severity: 1 };
  applyFractureEvents(f, damage, [event], 5);
  const state = damage.fracture, record = recordOf(state, target.index), list = verticesOfShard(f, target.index).slice(0, 8);
  assert.equal(state.broken[target.index], 1);
  const span = (t) => { const a = evaluateShardFlight(record, t, point(vertices, list[0]), scale), b = evaluateShardFlight(record, t, point(vertices, list[7]), scale); return Math.hypot(...a.map((x, i) => (x - b[i]) * scale[i])); };
  const rest = span(0);
  for (const t of [0.1, 0.4, 0.9]) assert.ok(Math.abs(span(t) - rest) < 1e-3, 'rigid in flight');
  const start = evaluateShardFlight(record, 0, target.centroid, scale), later = evaluateShardFlight(record, 0.6, target.centroid, scale);
  assert.ok(Math.hypot(...start.map((x, i) => (x - later[i]) * scale[i])) > 0.3, 'it leaves');
  const settleAt = record[7], hideAt = record[11];
  assert.ok(hideAt > settleAt && settleAt > 0);
  assert.deepEqual(evaluateShardFlight(record, hideAt + 1, point(vertices, list[0]), scale), [record[0], record[1], record[2]], 'gone at the end: its vertices meet at one point');

  // Cut a shard loose from everything around it, by removing what touches it.
  const lonely = f.shards.find((s) => s && s.kind === SHARD_KINDS.skin && !s.anchored && s.links.length && s.links.every((n) => f.shards[n].kind === SHARD_KINDS.skin));
  assert.ok(lonely, 'some skin hangs only from other skin');
  const cut = {};
  const walls = new Set();
  const collect = (s) => { for (const n of f.shards[s].links) if (!walls.has(n) && n !== lonely.index) { walls.add(n); } };
  collect(lonely.index);
  applyFractureEvents(f, cut, [...walls].map((n) => ({ x: f.shards[n].centroid[0], y: f.shards[n].centroid[1], z: f.shards[n].centroid[2], side: 1, stepDepth: 0.3, severity: 1 })), 3);
  assert.equal(cut.fracture.broken[lonely.index], 1, 'a piece with nothing left to hold it does not stand in space');
});

test('finished flights hold still, so the clock can stop', () => {
  const f = cache.get('nina').fracture, damage = {};
  applyFractureEvents(f, damage, [{ kind: 'mast-break', mastGroup: 'main', stage: 'full', side: 1 }], 100);
  const state = damage.fracture, s = f.masts.main.lower[0], record = recordOf(state, s);
  assert.equal(record[15], -1, 'on the clock while it falls');
  assert.equal(settleFinishedFlights(state, 100.5), false);
  assert.ok(state.flying.size > 0);
  const hideAt = record[11];
  settleFinishedFlights(state, 100 + hideAt + 0.1);
  assert.equal(state.flying.size, 0);
  assert.equal(record[15], hideAt, 'held at its last age');
  assert.deepEqual(evaluateShardFlight(record, 12345, f.shards[s].centroid, f.scale), [record[0], record[1], record[2]]);
});

test('guns knocked off their carriages stay aboard, and go back when remounted', () => {
  const f = cache.get('nina').fracture, damage = { dismountedGuns: 1 };
  const gun = f.shards[f.guns[0]];
  applyFractureEvents(f, damage, [{ kind: 'cannon-dismount', x: gun.centroid[0], y: gun.centroid[1], z: gun.centroid[2], side: 1 }], 1);
  const state = damage.fracture, record = recordOf(state, gun.index);
  assert.equal(state.broken[gun.index], 1);
  assert.equal(record[11], -1, 'it is never hidden');
  const moved = evaluateShardFlight(record, 5, gun.centroid, f.scale);
  assert.ok(Math.hypot(...moved.map((x, i) => (x - gun.centroid[i]) * f.scale[i])) > 0.2, 'it moved');
  assert.ok(Math.hypot(...moved.map((x, i) => (x - gun.centroid[i]) * f.scale[i])) < 2, 'but stays on deck');
  damage.dismountedGuns = 0;
  syncFractureWithDamage(f, damage);
  assert.equal(state.broken[gun.index], 0);
  assert.equal(record[15], -2);
});

test('repairs and reloads agree with the masts and shards a ship is left with', () => {
  const f = cache.get('victory').fracture, boat = shipOf('victory');
  broadside(boat, 90, { mass: 14.5, speed: 430, minY: 6, maxY: 30 });
  const damage = boat.damage;
  applyFractureEvents(f, damage, damage.pendingBakes.splice(0), 10);
  syncFractureWithDamage(f, damage);
  const state = damage.fracture;
  const gone = (mast) => f.masts[mast].lower.every((s) => state.broken[s] === 1);
  assert.ok(gone('main'), 'the main mast is down');
  assert.ok(state.brokenCount > 20, `pieces came off (${state.brokenCount})`);

  const saved = JSON.parse(JSON.stringify(vesselDamageSnapshot(boat)));
  assert.ok(saved.brokenShards.length > 5);

  // A reloaded ship shows the same wreck at once, with nothing in the air.
  const again = shipOf('victory');
  broadside(again, 1, { mass: 1, speed: 100, minY: 8, maxY: 9 });
  again.damage.pendingBakes.length = 0;
  restoreVesselDamageSnapshot(again, saved);
  syncFractureWithDamage(f, again.damage);
  const restored = again.damage.fracture;
  for (const s of saved.brokenShards) assert.equal(restored.broken[s], 1);
  assert.equal(restored.flying.size, 0);
  assert.ok(f.masts.main.lower.every((s) => restored.broken[s] === 1), 'masts come back from their state');

  raiseVesselRig(damage, 1);
  syncFractureWithDamage(f, damage);
  assert.ok(f.masts.main.lower.every((s) => state.broken[s] === 0), 'a re-raised rig stands again');
  repairVessel(boat, { structure: true });
  assert.equal(damage.fracture, null, 'a full repair puts every plank back');
});

test('a magazine blast and a broken back take pieces off, and leave her decks where they were', () => {
  const asset = cache.get('victory'), f = asset.fracture;
  const damage = {};
  applyFractureEvents(f, damage, [{ kind: 'magazine-explosion', x: 0, y: -0.35, z: -3.3, side: 1, radius: 3, stepDepth: 1.2, severity: 1.4, powderFraction: 0.9 }], 1);
  const blown = damage.fracture.brokenCount;
  assert.ok(blown > 20, `the blast blows planking off (${blown})`);
  const crack = {};
  applyFractureEvents(f, crack, [{ kind: 'hull-crack', z: 0, severity: 1.2 }], 1);
  assert.ok(crack.fracture.brokenCount > 4, `planking across the break goes (${crack.fracture.brokenCount})`);
  for (const s of f.strikable) {
    if (!crack.fracture.broken[s]) continue;
    assert.ok(!/^deck\./.test(f.shards[s].partId), 'no deck leaves');
  }
});

test('parrels and the outlicker sheet go with the mast they served', () => {
  for (const modelId of ['nina', 'pinta', 'santa-maria']) {
    const verts = (mastState) => buildVesselRigConnectors({ modelId, length: 20, beam: 6, damage: { mastState } }).length;
    const whole = verts({ fore: 0, main: 0, mizzen: 0 });
    const noMizzen = verts({ fore: 0, main: 0, mizzen: 2 });
    const noMasts = verts({ fore: 2, main: 2, mizzen: 2 });
    assert.ok(whole > 0, modelId);
    assert.ok(noMizzen < whole, `${modelId} loses the mizzen's connectors`);
    assert.ok(noMasts < noMizzen, `${modelId} loses them all with her masts`);
    assert.ok(noMasts > 0, `${modelId} keeps her stern outlicker, which stands on the hull`);
  }
});

test('a stay led to another mast comes down when that mast goes', () => {
  let found = 0;
  for (const model of ready) {
    const f = cache.get(model.id).fracture;
    for (const shard of f.shards) {
      if (!shard?.ledTo) continue;
      found++;
      const damage = {};
      applyFractureEvents(f, damage, [{ kind: 'mast-break', mastGroup: shard.ledTo.mast, stage: 'full', side: 1 }], 1);
      assert.equal(damage.fracture.broken[shard.index], 1, `${model.id} line from ${shard.mast} to ${shard.ledTo.mast}`);
      assert.equal(damage.fracture.broken[f.masts[shard.mast].lower.find((s) => !f.shards[s].ledTo)], 0, 'its own mast still stands');
      damage.mastState = { [shard.ledTo.mast]: 0, [shard.mast]: 0 };
      syncFractureWithDamage(f, damage);
      assert.equal(damage.fracture.broken[shard.index], 0, 'it returns with a re-raised rig');
    }
  }
  assert.ok(found > 0, 'some ship has a stay led mast to mast');
});

test('the release bundle carries the fracture modules', () => {
  const build = readFileSync(new URL('../build.mjs', import.meta.url), 'utf8');
  for (const file of ['js/ship-fracture.js', 'js/wgsl/ship-fracture.js']) assert.ok(build.includes(`'${file}'`), `${file} is on the flattening list`);
});

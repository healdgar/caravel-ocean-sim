// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// A ball meets the trunks the forest draws, and passes through open air and leaves. The table it meets them by is measured
// from the meshes, the grid touches only trees near the line, and what shot does is written once and kept.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { gunzipSync } from 'node:zlib';
import { applySceneryImpactDamage, sweepScenerySegment } from '../js/gunnery-control.js';
import { FOREST_TRUNK_SHAPES } from '../js/forest-trunk-shapes.js';
import { FOREST_LONG_FALLEN, buildForestTrunkGrid, foreshorePalmPlacement, forestStrikeKey, forestStrikesFromSave, forestStrikesToSave, forestTrunkShape, prepareForestTrunkGridSteps, reapplyForestStrikes, strikeForestRoot, strikeForestTree, sweepForestTrunks } from '../js/forest-trunks.js';
import { createPortDamageStore } from '../js/port-damage.js';
import { auditForestTrees, loadAuditModules } from '../scripts/model-audit.mjs';
import { FOREST_PACK_SETS, measureTrunkShape, readForestPack } from '../scripts/prepare-forest-trunks.mjs';

const root = (x, y, z, scale, yaw, prototype = 0) => [x, y, z, scale, yaw, 1, 1, 1, prototype, 0, -2, 0];
const gridOf = (species, ...roots) => buildForestTrunkGrid(new Float32Array(roots.flat()), roots.length, species);

test('every species: lines through a drawn trunk stop on it, and no ball stops in air', { timeout: 300000 }, async () => {
  const rows = auditForestTrees(await loadAuditModules(), { bearings: 6, columns: 16, rows: 24 });
  assert.equal(rows.length, 12, 'nine species and three foreshore palms');
  for (const t of rows) {
    const name = `${t.set}/${t.species}`;
    assert.ok(t.trunkLines > 100, `${name}: ${t.trunkLines} lines cross its trunk`);
    assert.ok(t.trunkStoppedPct >= 85, `${name}: ${t.trunkStoppedPct}% of lines through a trunk stopped`);
    assert.ok(t.trunkAgreePct >= 60, `${name}: ${t.trunkAgreePct}% stopped within 0.5 m of it`);
    assert.ok(t.airPct <= 0.5, `${name}: ${t.airPct}% of lines stopped in air`);
    assert.ok(t.throughPct <= 25, `${name}: ${t.throughPct}% passed thick wood`);
  }
});

test('the table is what the meshes measure', { timeout: 300000 }, () => {
  for (const set of FOREST_PACK_SETS) {
    const { manifest, vertices, indices } = readForestPack(set);
    for (const prototype of manifest.prototypes) {
      const { species, height, trunks, limbs } = measureTrunkShape(prototype, vertices, indices);
      assert.deepEqual({ height, trunks, limbs }, FOREST_TRUNK_SHAPES[species], `${species}: rerun scripts/prepare-forest-trunks.mjs`);
      assert.ok(trunks.length > 0, `${species} has a trunk`);
    }
  }
});

test('a tree stands where the shader puts it: turned and scaled, and the ball passes open air and fronds', () => {
  const shape = forestTrunkShape('palm'), scale = 1.4, yaw = 0.9, y = 3, grid = gridOf(['palm'], root(100, y, 200, scale, yaw));
  // The trunk leans. Hit it where it has leaned to, in the turn the vertex shader gives it.
  const c = Math.cos(yaw), s = Math.sin(yaw), up = 8, chain = FOREST_TRUNK_SHAPES.palm.trunks[0];
  let ax = 0, az = 0;
  for (let i = 0; i + 7 < chain.length; i += 4) if (chain[i + 1] <= up && chain[i + 5] >= up) {
    const t = (up - chain[i + 1]) / (chain[i + 5] - chain[i + 1]);
    ax = chain[i] + (chain[i + 4] - chain[i]) * t;
    az = chain[i + 2] + (chain[i + 6] - chain[i + 2]) * t;
  }
  const x = 100 + (c * ax - s * az) * scale, z = 200 + (s * ax + c * az) * scale, h = y + up * scale;
  const hit = sweepForestTrunks(grid, [x - 5, h, z], [x + 5, h, z], 0.07);
  assert.ok(hit, 'the leaning trunk is met where it is drawn');
  assert.equal(hit.sceneryType, 'palm');
  assert.ok(Math.abs(hit.fraction - 0.5) < 0.05, `entry ${hit.fraction}`);
  assert.equal(sweepForestTrunks(grid, [100 - 5, h, 200], [100 + 5, h, 200], 0.07), null, 'the vertical trunk the old sweep imagined is air');
  // A metre clear of the trunk is air, and well above it is only crown.
  assert.equal(sweepForestTrunks(grid, [x - 5, h, z + 1], [x + 5, h, z + 1], 0.07), null);
  const crown = y + (shape.top + 1.5) * scale;
  assert.equal(sweepForestTrunks(grid, [x - 8, crown, z], [x + 8, crown, z], 0.07), null, 'a ball goes through fronds');
  assert.equal(sweepForestTrunks(grid, [x - 5, h, z], [x - 3, h, z], 0.07), null, 'a step short of it meets nothing');
});

test('a ball meets a tree of the live forest through the scenery sweep, and only the nearest', () => {
  const grid = gridOf(['oak'], root(0, 0, 0, 1.2, 0), root(30, 0, 0, 1.2, 0));
  const terrain = { forestTrunks: grid, ports: [], treeData: new Float32Array(0) };
  const hit = sweepScenerySegment([40, 1.5, 0], [-40, 1.5, 0], 0.07, terrain);
  assert.equal(hit.kind, 'scenery');
  assert.equal(hit.sceneryType, 'tree');
  assert.equal(hit.forestTree.rootIndex, 1, 'the near tree of the two');
  assert.ok(hit.fraction < 0.2);
  assert.deepEqual([...hit.sceneryPos], [30, 0, 0]);
  // The port's list only says where the forest planted its palms: with a forest drawn it is no second tree.
  const palms = new Float32Array([0, 2, 60, 3.5, 22, 0.5, 1, 0]);
  assert.equal(sweepScenerySegment([-5, 3, 60], [5, 3, 60], 0.07, { forestTrunks: grid, ports: [{ center: { x: 0, z: 60 }, palms }] }), null);
});

test('with no forest a port still has palms to hit, standing as the forest would plant them', () => {
  const shape = 0.5, port = { center: { x: 0, z: 0 }, palms: new Float32Array([0, 2, 0, 3.5, 22, shape, -1, 0]) };
  const { scale, yaw, sink } = foreshorePalmPlacement(shape, 1, 0, forestTrunkShape('palm').collarRadius);
  assert.ok(Math.abs(yaw - (Math.atan2(0, 1) - Math.atan2(0.5, 1.5))) < 1e-9);
  const low = sweepScenerySegment([-5, 2 - sink + 0.5, 0], [5, 2 - sink + 0.5, 0], 0.07, { ports: [port] });
  assert.equal(low?.sceneryType, 'palm');
  assert.equal(low.palmIndex, 0);
  assert.equal(low.port, port);
  // Up the trunk it has leaned out to sea (+x), so the old cylinder's axis is air.
  const high = 2 - sink + 9 * scale;
  assert.equal(sweepScenerySegment([-5, high, 0.0], [-1, high, 0.0], 0.07, { ports: [port] }), null);
  assert.ok(sweepScenerySegment([-5, high, 0.0], [5, high, 0.0], 0.07, { ports: [port] })?.fraction > 0.5, 'it is met out over the sea');
  applySceneryImpactDamage({ ports: [port], sceneryImpacts: [] }, { ...low, position: [0, 3, 0], velocity: [300, 0, 0], mass: 11 });
  applySceneryImpactDamage({ ports: [port], sceneryImpacts: [] }, { ...low, position: [0, 3, 0], velocity: [300, 0, 0], mass: 11 });
  applySceneryImpactDamage({ ports: [port], sceneryImpacts: [] }, { ...low, position: [0, 3, 0], velocity: [300, 0, 0], mass: 11 });
  assert.equal(sweepScenerySegment([-5, high, 0.0], [5, high, 0.0], 0.07, { ports: [port] }), null, 'three hits and it is down');
});

test('the grid builds in small steps and a sweep touches only what is near', () => {
  const { manifest, roots } = (() => {
    const dir = new URL('../assets/forest-scenery/saba/', import.meta.url), raw = gunzipSync(readFileSync(new URL('roots.bin.gz', dir)));
    return { manifest: JSON.parse(readFileSync(new URL('manifest.json', dir))), roots: new Float32Array(raw.buffer.slice(raw.byteOffset, raw.byteOffset + raw.byteLength)) };
  })();
  const count = roots.length / 12, species = manifest.prototypes.map((p) => p.species);
  const steps = prepareForestTrunkGridSteps(roots, count, species);
  let yields = 0, next = steps.next();
  while (!next.done) { yields++; next = steps.next(); }
  const grid = next.value;
  assert.ok(yields >= count / 2048, `${yields} steps for ${count} trees`);
  assert.equal(grid.trees, count);
  assert.ok(grid.widest < 20, `no tree's wood reaches ${grid.widest} m`);
  // Every tree is found at its own foot.
  for (const i of [0, 1, 1000, 33333, count - 1]) {
    const at = i * 12, y = roots[at + 1] + 0.4, x = roots[at], z = roots[at + 2];
    const hit = sweepForestTrunks(grid, [x - 3, y, z], [x + 3, y, z], 0.07);
    assert.ok(hit && hit.fraction < 0.75, `tree ${i}`);
  }
  // A Victory broadside through the densest of it, following the ground, flying on past what it strikes: 52 balls, two
  // steps a frame. Measured at 0.03 ms a frame; this is here to catch something going badly wrong, not a small slip.
  let densest = 0, bx = 0, bz = 0, by = 0;
  const cells = new Map();
  for (let i = 0; i < count; i++) {
    const key = `${Math.floor(roots[i * 12] / 200)},${Math.floor(roots[i * 12 + 2] / 200)}`, n = (cells.get(key) ?? 0) + 1;
    cells.set(key, n);
    if (n > densest) { densest = n; bx = Math.floor(roots[i * 12] / 200) * 200; bz = Math.floor(roots[i * 12 + 2] / 200) * 200; by = roots[i * 12 + 1]; }
  }
  const started = performance.now();
  let sweeps = 0;
  for (let repeat = 0; repeat < 20; repeat++) for (let s = 0; s < 80; s++) for (let b = 0; b < 52; b++) {
    const x = bx + s * 2.83, z = bz + (b / 52) * 200;
    sweepForestTrunks(grid, [x, by + 2, z], [x + 2.83, by + 2, z], 0.073);
    sweeps++;
  }
  const perFrame = ((performance.now() - started) / sweeps) * 104;
  assert.ok(perFrame < 1, `${perFrame.toFixed(3)} ms a frame`);
});

test('what a ball does is real: the energy it carries against the wood it strikes', () => {
  const palm = forestTrunkShape('palm'), chestnut = forestTrunkShape('chestnut');
  // A 24-pounder at close range snaps a palm with one ball, and takes several to bring down a great chestnut.
  const strikes = new Map(), roots = new Float32Array([...root(0, 2, 0, 1.2, 0), ...root(50, 2, 0, 1.6, 0)]);
  const ball = { energy: 1200000, bearing: 0, height: 3, now: 5 };
  const snapped = strikeForestTree(roots, 0, palm, ball, strikes);
  assert.ok(snapped.felled, 'one ball snaps a palm');
  assert.ok(roots[11] < 0, 'the fall starts in the root');
  assert.ok(Math.abs(roots[11] + 5) < 1e-3, 'at the time it was struck');
  assert.equal(roots[3], Math.fround(1.2), 'it keeps its scale: it comes down, it does not vanish');
  const first = strikeForestTree(roots, 1, chestnut, ball, strikes);
  assert.equal(first.felled, false, 'a chestnut takes it');
  assert.ok(roots[12 + 11] > 0, 'and shows a wound');
  const wound = roots[12 + 11];
  assert.equal(roots[12 + 5], 1, 'a solid ball does not char the crown');
  let hits = 1;
  while (!strikeForestTree(roots, 1, chestnut, ball, strikes)?.felled && hits < 40) hits++;
  assert.ok(hits >= 2 && hits < 12, `it comes down in the end, after ${hits + 1}`);
  assert.notEqual(roots[12 + 11], wound);
  assert.equal(strikeForestTree(roots, 1, chestnut, ball, strikes), null, 'a felled tree takes no more');
  // A hot ball chars; a limb takes less than the trunk.
  const hotRoots = new Float32Array(root(0, 0, 0, 1, 0)), hot = new Map();
  strikeForestTree(hotRoots, 0, chestnut, { energy: 100000, bearing: 0, height: 2, hot: true }, hot);
  assert.ok(Math.abs(hotRoots[5] - 0.6) < 1e-6);
  const limbRoots = new Float32Array(root(0, 0, 0, 1, 0)), limb = new Map(), trunk = new Map();
  strikeForestTree(limbRoots, 0, chestnut, { energy: 100000, bearing: 0, height: 2, onTrunk: false }, limb);
  strikeForestTree(new Float32Array(root(0, 0, 0, 1, 0)), 0, chestnut, { energy: 100000, bearing: 0, height: 2 }, trunk);
  assert.ok([...limb.values()][0].damage < [...trunk.values()][0].damage);
  // A wound is not a stump: it writes its height, and leaves sink and scale for the shader.
  assert.equal(limbRoots[9], 0);
});

test('a species\' wood stands for a full-grown tree at that tree\'s size', () => {
  // A chestnut drawn 26 m tall with a trunk 1.2 m through, and the same tree kept to half that by a farmer.
  const measured = forestTrunkShape('chestnut'), grown = forestTrunkShape('chestnut', { height: 26.4, trunkRadius: 0.6 }), size = 26.4 / FOREST_TRUNK_SHAPES.chestnut.height;
  assert.equal(forestTrunkShape('chestnut', { height: 26.4, trunkRadius: 0.6 }), grown, 'compiled once');
  assert.equal(forestTrunkShape('chestnut'), measured, 'and the wood as measured is left as it was');
  assert.equal(grown.species, 'chestnut');
  for (const key of ['top', 'trunkTop', 'reach', 'collarRadius']) assert.ok(Math.abs(grown[key] - measured[key] * size) < 1e-4, key);
  assert.equal(grown.trunkRadius, 0.6);
  assert.equal(forestTrunkShape('blueberry', { height: 2, trunkRadius: 0.01 }), null, 'a shrub has no wood a ball meets');
  // The grid takes the wood itself where a species' name would not say its size.
  const grid = gridOf([grown], root(0, 0, 0, 1, 0)), high = measured.trunkTop * (size + 1) / 2;
  assert.ok(sweepForestTrunks(grid, [-3, high, 0], [3, high, 0], 0.07), 'the trunk stands above where the measured tree ends');
  assert.equal(sweepForestTrunks(gridOf(['chestnut'], root(0, 0, 0, 1, 0)), [-3, high, 0], [3, high, 0], 0.07)?.forestTree.onTrunk ?? false, false);
  // Full grown it takes several balls, and kept small in an orchard it takes one.
  const ball = { energy: 1200000, bearing: 0, height: 1.5, now: 5 }, strikes = new Map();
  const roots = new Float32Array([...root(0, 0, 0, 1, 0), ...root(50, 0, 0, 0.25, 0)]);
  assert.equal(strikeForestTree(roots, 0, grown, ball, strikes).felled, false);
  assert.equal(strikeForestTree(roots, 1, grown, ball, strikes).felled, true);
});

test('a felled tree is no trunk above its stump, and the stump still stops a ball', () => {
  const grid = gridOf(['oak'], root(0, 0, 0, 1, 0)), strikes = new Map(), roots = grid.roots;
  assert.ok(sweepForestTrunks(grid, [-3, 4, 0], [3, 4, 0], 0.07), 'standing');
  strikeForestTree(roots, 0, forestTrunkShape('oak'), { energy: 5e7, bearing: Math.PI / 2, height: 1.5, now: 2, groundAt: () => 0 }, strikes);
  assert.ok(roots[11] < 0);
  assert.equal(sweepForestTrunks(grid, [-3, 4, 0], [3, 4, 0], 0.07), null, 'above the break there is only sky');
  assert.ok(sweepForestTrunks(grid, [-3, 0.8, 0], [3, 0.8, 0], 0.07), 'the stump stands');
  const record = strikes.get(forestStrikeKey(0, 0));
  // From a break a little up the trunk its tip reaches the ground just past level.
  assert.ok(record.rest > 90 && record.rest < 100, `it comes to rest on level ground: ${record.rest}`);
});

test('marks survive streaming and a save, and a tree shot down stays down', () => {
  const shape = forestTrunkShape('oak'), roots = new Float32Array([...root(10, 1, 20, 1.2, 0.5), ...root(40, 1, 20, 1.2, 0)]), strikes = new Map();
  strikeForestTree(roots, 0, shape, { energy: 5e7, bearing: 1, height: 2, now: 7, hot: true }, strikes);
  strikeForestTree(roots, 1, shape, { energy: 1e5, bearing: 2, height: 1, now: 7 }, strikes);
  const saved = forestStrikesToSave(strikes), json = JSON.parse(JSON.stringify(saved));
  assert.equal(json.length, 2);
  // A later sitting: the coast streams its roots in another order, and only then do the marks go on.
  const back = forestStrikesFromSave(json), later = new Float32Array([...root(40, 1, 20, 1.2, 0), ...root(10, 1, 20, 1.2, 0.5), ...root(80, 1, 20, 1.2, 0)]);
  reapplyForestStrikes(later, 3, back);
  assert.equal(later[12 + 11], FOREST_LONG_FALLEN, 'down since before this sitting, with no fall to replay');
  assert.ok(later[11] > 0, 'the wounded one stands, wounded');
  assert.equal(later[24 + 11], 0, 'and a tree nobody hit is untouched');
  // The same coast laid out elsewhere on a later visit, as near as a float gets: its trees are known all the same, and
  // the next ball adds to what the tree already took.
  const origin = { x: 1000, z: -2000 }, moved = forestStrikesFromSave(forestStrikesToSave(strikes, { x: 0, z: 0 }), origin), wounded = new Float32Array(root(1040.007, 1, -1979.993, 1.2, 0));
  reapplyForestStrikes(wounded, 1, moved);
  assert.ok(wounded[11] > 0, 'wounded still, where it stands now');
  strikeForestTree(wounded, 0, shape, { energy: 1e5, bearing: 2, height: 1, now: 7 }, moved);
  assert.equal([...moved.values()].find((r) => Math.abs(r.x - 1040) < 1).hits, 2);
  assert.equal(moved.size, 2);
  assert.equal(later[12 + 9], roots[9], 'where it broke and which way it fell come back');
  assert.ok(Math.abs(later[12 + 5] - 0.6) < 1e-6, 'and its char');
  // Streaming again must not char it twice: each array of roots is fresh.
  const again = new Float32Array(root(10, 1, 20, 1.2, 0.5));
  reapplyForestStrikes(again, 1, back);
  assert.ok(Math.abs(again[5] - 0.6) < 1e-6);
  // The store keeps them with the port damage, for the career save and for a share link.
  const store = createPortDamageStore();
  assert.equal(store.snapshot([]), undefined, 'nothing struck, nothing saved');
  store.setForestStrikes('san-juan', saved);
  const snapshot = JSON.parse(JSON.stringify(store.snapshot([])));
  assert.deepEqual(createPortDamageStore(snapshot).forestStrikes('san-juan'), json, 'a career save holds it');
  const link = store.forLink(null, 'san-juan');
  assert.deepEqual(createPortDamageStore(JSON.parse(JSON.stringify(link))).forestStrikes('san-juan').length, 2, 'a link holds it');
  assert.equal(store.forestStrikes('lisbon'), null);
  store.clear();
  assert.equal(store.forestStrikes('san-juan'), null, 'a new career starts with the forest whole');
});

test('a blast near a tree still marks the nearest, and three bring it down', () => {
  const roots = new Float32Array([...root(0, 2, 0, 1.2, 0), ...root(40, 2, 0, 1.2, 0)]), strikes = new Map();
  assert.equal(strikeForestRoot(roots, 2, 1, 1, strikes), 0);
  assert.equal(strikeForestRoot(roots, 2, 0, 0, strikes), 0);
  assert.equal(roots[11], 0, 'still whole in the trunk');
  assert.equal(strikeForestRoot(roots, 2, 0, 0, strikes, { now: 3 }), 0);
  assert.ok(roots[11] < 0);
});

test('a struck forest tree queues its mark for the GPU and lays no second damage on the land', () => {
  const grid = gridOf(['palm'], root(0, 0, 0, 1.2, 0)), terrain = { forestTrunks: grid, ports: [] };
  const hit = sweepScenerySegment([-5, 1, 0], [5, 1, 0], 0.07, terrain);
  const report = applySceneryImpactDamage(terrain, { ...hit, position: [0, 1, 0], velocity: [300, 0, 0], mass: 11, time: 4, ammo: 'round' });
  assert.equal(report.kind, 'scenery');
  assert.equal(report.sceneryType, 'palm');
  assert.equal(terrain.pendingForestStrikes.length, 1);
  assert.equal(terrain.pendingForestStrikes[0].tree.rootIndex, 0);
  assert.ok(terrain.pendingForestStrikes[0].impact.energy > 400000);
  assert.equal(terrain.pendingLandBakes, undefined, 'no bake for a tree the GPU owns');
  assert.equal(grid.roots[11], 0, 'JavaScript marks it as the next frame begins');
});

test('gunnery hands the trunk model the ball it fired: its own energy, and whether it met trunk or limb', () => {
  const grid = gridOf(['chestnut'], root(0, 0, 0, 1.2, 0)), terrain = { forestTrunks: grid, ports: [] };
  const strikeOf = (hit, mass, speed) => {
    terrain.pendingForestStrikes = [];
    applySceneryImpactDamage(terrain, { ...hit, position: hit.sceneryPos, velocity: [speed, 0, 0], mass, time: 4, ammo: 'round' });
    return terrain.pendingForestStrikes[0];
  };
  const trunk = sweepScenerySegment([-5, 1, 0], [5, 1, 0], 0.07, terrain);
  assert.equal(trunk.forestTree.onTrunk, true);
  // A spent 4-pounder: far too little to fell a chestnut, and the model must be told so.
  const spent = strikeOf(trunk, 1.8, 120);
  assert.equal(spent.impact.energy, 0.5 * 1.8 * 120 * 120, 'the energy is the ball\'s, not a floor that fells anything');
  assert.equal(spent.tree.onTrunk, true);
  assert.equal(strikeOf(trunk, 11, 300).impact.energy, 0.5 * 11 * 300 * 300, 'and not a multiple of it');
  // The same on the model: that spent ball wounds, and does not bring a hardwood down.
  const roots = new Float32Array(root(0, 0, 0, 1.2, 0)), strikes = new Map();
  const outcome = strikeForestTree(roots, 0, FOREST_TRUNK_SHAPES.chestnut, { ...spent.impact, height: spent.tree.height, onTrunk: spent.tree.onTrunk }, strikes);
  assert.equal(outcome.felled, false, 'a chestnut stands after one spent ball');
  // A limb is not the trunk: the sweep's word for it reaches the model unchanged.
  let limb = null;
  for (let y = 2; y < 16 && !limb; y += 0.25) for (let z = -4; z <= 4 && !limb; z += 0.25) {
    const hit = sweepScenerySegment([-9, y, z], [9, y, z], 0.07, terrain);
    if (hit?.forestTree && !hit.forestTree.onTrunk) limb = hit;
  }
  assert.ok(limb, 'a chestnut has limbs a ball can meet');
  assert.equal(strikeOf(limb, 11, 300).tree.onTrunk, false, 'a limb hit is passed on as a limb hit');
});

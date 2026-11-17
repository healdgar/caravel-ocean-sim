// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The country model's caravans on its roads: each cart a wagon behind a yoke of oxen, each drove its beasts, laid as
// travelling seeds of the herds' GPU pass along a route buffer, proven on Lisbon's own frozen world.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { openBoard } from '../scripts/board-host.mjs';
import { CARAVAN_YOKE_AHEAD_M, caravanHerdSeeds, caravanRiderWaySeeds } from '../js/herds.js';
import { getCoachMesh, getOxCartMesh, getVehicleMeshes, getWagonMesh } from '../js/models/livestock-meshes.js';
import { HERDS_RENDER_WGSL, HERDS_STEP_WGSL } from '../js/wgsl/herds.js';
import { boardDayAt, boardDayOf } from '../js/board-life.js';

const baked = JSON.parse(readFileSync(new URL('../assets/boards/lisbon-1550.json', import.meta.url), 'utf8'));
const world = () => new Uint8Array(readFileSync(new URL('../assets/boards/lisbon-1550.world', import.meta.url)));

function assertOutwardManifoldVehicle(mesh, name) {
  assert.equal(mesh.vertices.length % 8, 0, `${name}: stride 8 floats`);
  assert.equal(mesh.indexCount, mesh.indices.length, `${name}: indexCount matches indices`);
  const triCount = mesh.indexCount / 3;
  assert.ok(triCount >= 900 && triCount <= 3200, `${name}: expected rich spoked-wheel 3D manifold, got ${triCount} tris`);

  let inverted = 0, degenerate = 0, wheelVerts = 0, tongueVerts = 0, maxTongueZ = -Infinity, minY = Infinity;
  for (let i = 0; i < mesh.vertices.length; i += 8) {
    minY = Math.min(minY, mesh.vertices[i + 1]);
    const part = Math.floor(mesh.vertices[i + 6] + 1e-4);
    if (part === 7) wheelVerts++;
    if (part === 8) {
      tongueVerts++;
      maxTongueZ = Math.max(maxTongueZ, mesh.vertices[i + 2]);
    }
  }
  assert.ok(Math.abs(minY) < 0.02, `${name}: wheels rest cleanly on ground y=0 (minY=${minY})`);
  assert.ok(wheelVerts >= 200, `${name}: 3D spoked wheels present (${wheelVerts} verts)`);
  assert.ok(tongueVerts >= 40 && maxTongueZ >= 4.5, `${name}: articulated pole + yoke reaches draft beasts (maxZ=${maxTongueZ.toFixed(3)})`);

  for (let t = 0; t < mesh.indices.length; t += 3) {
    const i0 = mesh.indices[t] * 8, i1 = mesh.indices[t + 1] * 8, i2 = mesh.indices[t + 2] * 8;
    const ax = mesh.vertices[i0], ay = mesh.vertices[i0 + 1], az = mesh.vertices[i0 + 2];
    const bx = mesh.vertices[i1], by = mesh.vertices[i1 + 1], bz = mesh.vertices[i1 + 2];
    const cx = mesh.vertices[i2], cy = mesh.vertices[i2 + 1], cz = mesh.vertices[i2 + 2];
    const ux = bx - ax, uy = by - ay, uz = bz - az;
    const vx = cx - ax, vy = cy - ay, vz = cz - az;
    const fnx = uy * vz - uz * vy;
    const fny = uz * vx - ux * vz;
    const fnz = ux * vy - uy * vx;
    const area2 = Math.hypot(fnx, fny, fnz);
    if (area2 <= 1e-9) { degenerate++; continue; }
    const vnx = mesh.vertices[i0 + 3] + mesh.vertices[i1 + 3] + mesh.vertices[i2 + 3];
    const vny = mesh.vertices[i0 + 4] + mesh.vertices[i1 + 4] + mesh.vertices[i2 + 4];
    const vnz = mesh.vertices[i0 + 5] + mesh.vertices[i1 + 5] + mesh.vertices[i2 + 5];
    if (fnx * vnx + fny * vny + fnz * vnz <= 0) inverted++;
  }
  assert.equal(degenerate, 0, `${name}: 0 degenerate triangles`);
  assert.equal(inverted, 0, `${name}: 0 inside-out CW triangles under backface culling`);
}

test('Lisbon\'s caravans come from the model with their roads, days, 1550 coaches/wagons/ox-carts and coupled draft teams', { timeout: 600000 }, async (t) => {
  const model = await openBoard(baked.request, { world: world() });
  t.after(() => model.close());
  const answer = await model.hook('caravans');
  assert.equal(answer.day, baked.world.day);
  assert.ok(answer.list.length >= 6, `${answer.list.length} caravans`);
  for (const c of answer.list) {
    assert.ok(['cart', 'river', 'sea', 'rider'].includes(c.mode), `unexpected mode ${c.mode}`);
    assert.ok(c.arrive > c.depart && c.depart <= answer.day + 0.01, `${c.key} ${c.depart}..${c.arrive}`);
    assert.ok(c.points.length >= 4 && c.points.length % 2 === 0);
    if (c.mode !== 'rider' && !c.mounted) {
      assert.ok(c.carts >= 1 && c.carts <= 4);
    }
    if (c.mode === 'cart' && c.drove === true) {
      assert.ok((c.qty ?? 0) >= 6, `genuine livestock drove must have >= 6 head, got ${c.qty}`);
    }
  }
  const origin = { x: baked.region.x, z: baked.region.z }, laid = caravanHerdSeeds(answer.list, origin);
  const carts = answer.list.filter((c) => c.mode === 'cart' && !c.mounted);
  assert.ok(laid.seeds.length > 0 && laid.seeds.length % 8 === 0);
  // Every seed names a route header whose length is the summed length of its points, and walks it.
  for (let k = 0; k < laid.seeds.length; k += 8) {
    const h = laid.seeds[k] * 4, count = laid.routes[h + 2], total = laid.routes[h + 3];
    assert.ok(laid.seeds[k + 2] <= -1 && laid.seeds[k + 2] > -2, 'a traveller is flagged by a negative roam sentinel');
    assert.ok(count >= 2 && total > 1);
    assert.ok(Math.abs(laid.routes[h + 4 + (count - 1) * 4 + 2] - total) < 1e-2);
    assert.ok([0, 1, 2, 3, 4, 5, 6].includes(laid.seeds[k + 6]), `valid species ${laid.seeds[k + 6]}`);
  }
  // Every non-drove road consignment spawns a physical 1550 vehicle (wain=4, coach=5, ox-cart=6) atomically coupled
  // to two draft beasts (oxen=1 for wains/ox-carts, horses=3 for coaches) sharing exact anchor progress `seeds[k + 1]`.
  const isGenuineDrove = (c) => ['sheep', 'cattle', 'horses', 'swine'].includes(c.good)
    && (c.drove === true || (c.drove !== false && (c.qty ?? 0) >= 6 && !c.carts));
  const vehicular = carts.filter((c) => !isGenuineDrove(c));
  const wains = [], coaches = [], oxCarts = [], draftOxen = [], draftHorses = [], mountedHorses = [];
  for (let k = 0; k < laid.seeds.length; k += 8) {
    const sp = laid.seeds[k + 6];
    if (sp === 4 || sp === 5 || sp === 6) {
      if (sp === 4) wains.push(k);
      else if (sp === 5) coaches.push(k);
      else oxCarts.push(k);
      // Immediately followed by its two coupled draft animals with identical `behind` anchor progress.
      const b1 = k + 8, b2 = k + 16;
      assert.equal(laid.seeds[b1 + 1], laid.seeds[k + 1], 'draft beast 1 shares vehicle anchor progress');
      assert.equal(laid.seeds[b2 + 1], laid.seeds[k + 1], 'draft beast 2 shares vehicle anchor progress');
      const expectedDraft = sp === 5 ? 3 : 1;
      assert.equal(laid.seeds[b1 + 6], expectedDraft);
      assert.equal(laid.seeds[b2 + 6], expectedDraft);
    } else if (laid.seeds[k + 4] < 1) {
      if (sp === 1) draftOxen.push(k);
      else if (sp === 3) draftHorses.push(k);
    } else if (sp === 3 && laid.seeds[k + 4] >= 10) {
      mountedHorses.push(k);
    }
  }
  const totalVehicles = wains.length + coaches.length + oxCarts.length;
  assert.equal(totalVehicles, vehicular.reduce((n, c) => n + c.carts, 0));
  assert.equal(draftOxen.length, (wains.length + oxCarts.length) * 2);
  assert.equal(draftHorses.length, coaches.length * 2);

  // Days go on and the model's caravans with them: some arrive, others set out, and all 3 vehicle classes serve the roads.
  await model.live(20);
  const later = await model.hook('caravans');
  assert.ok(later.list.some((c) => c.depart > answer.day), 'new loads set out');
  const combinedLaid = caravanHerdSeeds([
    ...answer.list,
    ...later.list,
    { key: 'variety-silk', mode: 'cart', good: 'silk', qty: 3, carts: 2, depart: 1, arrive: 4, points: [0, 0, 180, 0] },
    { key: 'variety-ore', mode: 'cart', good: 'ore', qty: 4, carts: 2, depart: 1, arrive: 4, points: [0, 0, 180, 0] },
  ], origin);
  const seenVehicles = new Set();
  for (let k = 0; k < combinedLaid.seeds.length; k += 8) {
    if (combinedLaid.seeds[k + 6] >= 4) seenVehicles.add(combinedLaid.seeds[k + 6]);
  }
  assert.deepEqual([...seenVehicles].sort(), [4, 5, 6], 'all 3 1550 road vehicle archetypes (carreta, coche, carro de bois) active');

  // A small 2-cow parcel never spawns vehicle-less cattle; a genuine >=6 head drove spawns loose livestock.
  const twoCowParcel = caravanHerdSeeds([{ key: 'small-cattle', mode: 'cart', good: 'cattle', qty: 2, depart: 1, arrive: 3, points: [0, 0, 120, 0] }], { x: 0, z: 0 });
  assert.equal(twoCowParcel.seeds.length / 8, 3, '2-cow consignment gets 1 physical vehicle + 2 yoked draft beasts');
  assert.ok([4, 5, 6].includes(twoCowParcel.seeds[6]), 'vehicle seed present');
  const realDrove = caravanHerdSeeds([{ key: 'real-drove', mode: 'cart', drove: true, good: 'cattle', qty: 8, carts: 1, depart: 1, arrive: 3, points: [0, 0, 120, 0] }], { x: 0, z: 0 });
  assert.equal(realDrove.seeds.length / 8, 8, 'genuine drove of 8 cattle walks loose');
});

test('all three 1550 road vehicles are closed outward CCW manifolds on spoked wheels with zero-gap yokes and Rule-3 splat WGSL', () => {
  assert.equal(CARAVAN_YOKE_AHEAD_M, 4.05);
  const [wain, coach, oxCart] = getVehicleMeshes();
  assert.equal(wain, getWagonMesh());
  assert.equal(coach, getCoachMesh());
  assert.equal(oxCart, getOxCartMesh());
  assertOutwardManifoldVehicle(wain, 'carreta (4-wheel covered wain)');
  assertOutwardManifoldVehicle(coach, 'coche (4-wheel passenger/merchant coach)');
  assertOutwardManifoldVehicle(oxCart, 'carro de bois (2-wheel cargo ox-cart)');

  let canvas = 0;
  for (let i = 0; i < wain.vertices.length; i += 8) {
    if (Math.floor(wain.vertices[i + 7]) === 2) canvas++;
  }
  assert.ok(canvas > 0, 'covered wain tilt canvas present');

  // Verify Rule-2 & Rule-3 GPU execution: atomic hitch culling, tongue articulation, MSAA sample_mask handoff,
  // 1-triangle horizon splat, the core's sub-pixel stochastic thinning with area-preserving inflation, and zero discard.
  assert.doesNotMatch(HERDS_STEP_WGSL, /\bdiscard\b/);
  assert.doesNotMatch(HERDS_RENDER_WGSL, /\bdiscard\b/);
  assert.match(HERDS_STEP_WGSL, /isHitch/);
  assert.match(HERDS_STEP_WGSL, /continuumThin\(screenPx, thinSeed\)/);
  assert.match(HERDS_RENDER_WGSL, /@builtin\(sample_mask\)/);
  assert.match(HERDS_RENDER_WGSL, /fn\s+herdsSplatVS\b/);
  assert.match(HERDS_RENDER_WGSL, /fn\s+herdsSplatFS\b/);
  assert.match(HERDS_RENDER_WGSL, /part\s*>=\s*7\.5/);

  const at = Date.UTC(1550, 2, 14, 12);
  assert.equal(Math.floor(boardDayAt(at, 1549)), boardDayOf(at, 1549));
  assert.ok(boardDayAt(at, 1549) % 1 > 0.3 && boardDayAt(at, 1549) % 1 < 0.9);

  // Mounted road couriers / envoys (`mode: 'rider'` or `mounted: true`) spawn saddled Lusitano horses (`species = 3`, `traits.x >= 10`)
  // plus coupled human rider ways (`caravanRiderWaySeeds`) in Old World / Colonial realms (and zero in Indigenous realms).
  const riders = caravanHerdSeeds([
    { key: 'correio:1', mode: 'rider', riders: 2, depart: 1, arrive: 3, phaseOffset: 0.2, points: [0, 0, 240, 60] },
  ], { x: 100, z: 200 });
  assert.equal(riders.seeds.length / 8, 2, '2 saddled courier horses spawned');
  for (let k = 0; k < riders.seeds.length; k += 8) {
    assert.equal(riders.seeds[k + 6], 3, 'species is Lusitano horse (3)');
    assert.ok(riders.seeds[k + 4] >= 10 && riders.seeds[k + 4] < 11, `saddled tack sentinel 10 + coatSeed (${riders.seeds[k + 4]})`);
    assert.ok(riders.seeds[k + 5] >= 0.98 && riders.seeds[k + 5] <= 1.04, `natural horse scale (${riders.seeds[k + 5]})`);
  }
  const coupled = caravanRiderWaySeeds([
    { key: 'correio:1', mode: 'rider', riders: 2, depart: 1, arrive: 3, phaseOffset: 0.2, points: [0, 0, 240, 60] },
  ], { x: 100, z: 200 }, null, { heightAt: () => 4.5, indigenous: false });
  assert.equal(coupled.people, 2);
  assert.equal(coupled.mountSeeds.count, 2);
  const preContact = caravanRiderWaySeeds([
    { key: 'correio:1', mode: 'rider', riders: 2, depart: 1, arrive: 3, points: [0, 0, 240, 60] },
  ], { x: 0, z: 0 }, null, { indigenous: true });
  assert.equal(preContact.people, 0);
  assert.equal(preContact.mountSeeds.count, 0);
});

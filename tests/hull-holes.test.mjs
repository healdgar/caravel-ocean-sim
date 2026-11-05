// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Round shot goes through a hull and leaves holes that let the sea in by how deep they lie.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { HULL_HOLE_LIMIT, HULL_CRATER_LIMIT } from '../js/wgsl/common.js';
import { writeHullCraters, writeHullFloodUniform, HULL_DAMAGE_UNIFORM_BYTES } from '../js/hull-flood.js';
import { addHullHole, hullHoleDepth, hullHoleInflow, stepHullHoles, plugAllHullHoles, clearHullHoles } from '../js/hull-holes.js';
import { applyShipImpactDamage, stepVesselDamage, createVesselDamageState } from '../js/gunnery-control.js';
import { repairVessel, vesselDamageSnapshot, restoreVesselDamageSnapshot } from '../js/vessel-damage.js';
import { boatHydrodynamics } from '../js/boat.js';

function caravel() {
  const boat = { x: 0, z: 0, heave: 0, heading: 0, pitch: 0, roll: 0, modelId: 'nina', length: 20, beam: 6, cargoTonnes: 0, provisionDays: 30, showProw: true };
  boat.hydrodynamics = boatHydrodynamics(boat.length, boat.beam, 30, 0, 'nina');
  createVesselDamageState(boat);
  return boat;
}
const hole = (y, x = 3, z = 0, radius = 0.15, compartment = 'midStarboard') => ({ design: [x / 2, y, z], local: [x, y, z], radius, side: Math.sign(x), compartment });

test('a hole high above the water lets nothing in, and floods once she lists onto it', () => {
  const boat = caravel(), h = addHullHole(boat.damage, hole(1.2));
  assert.ok(hullHoleDepth(boat, h) < 0);
  assert.equal(hullHoleInflow(boat, boat.damage, h), 0, 'dry above the waterline');
  boat.roll = -0.5; // Positive roll lifts starboard, so this lays the hole under.
  assert.ok(hullHoleDepth(boat, h) > 0, 'heeled under');
  assert.ok(hullHoleInflow(boat, boat.damage, h) > 0, 'now she floods through it');
});

test('deeper holes run harder, and the flow stops once the water inside has risen to meet the sea', () => {
  const boat = caravel();
  const shallow = hullHoleInflow(boat, boat.damage, hole(-0.4)), deep = hullHoleInflow(boat, boat.damage, hole(-1.6));
  assert.ok(deep > shallow * 1.5, `${deep} against ${shallow}`);
  boat.damage.floodingTonnes = 500;
  assert.equal(hullHoleInflow(boat, boat.damage, hole(-0.4)), 0, 'level inside and out');
});

test('a second ball through the same place widens the hole instead of adding one', () => {
  const { damage } = caravel(), first = addHullHole(damage, hole(0.5)), before = first.radius;
  first.plug = 0.5;
  addHullHole(damage, hole(0.55));
  assert.equal(damage.holes.length, 1);
  assert.ok(first.radius > before);
  assert.equal(first.plug, 0, 'and knocks out the plug');
  for (let i = 0; i < HULL_HOLE_LIMIT + 6; i++) addHullHole(damage, hole(0.5, 3, -9 + i * 0.7, 0.1));
  assert.ok(damage.holes.length <= HULL_HOLE_LIMIT, 'the list stays bounded');
});

test('the carpenter plugs the worst leak first, slowly, and never quite stops it', () => {
  const boat = caravel(), small = addHullHole(boat.damage, hole(-0.5, 3, -6, 0.1)), big = addHullHole(boat.damage, hole(-1.5, 3, 6, 0.2, 'aftStarboard'));
  stepHullHoles(boat, boat.damage, 10);
  assert.ok(big.plug > 0);
  assert.equal(small.plug, 0);
  for (let i = 0; i < 400; i++) stepHullHoles(boat, boat.damage, 1);
  assert.ok(big.plug <= 0.85 && small.plug > 0 && hullHoleInflow(boat, boat.damage, big) > 0, 'it still weeps');
});

test('round shot through her side leaves a hole, and enough energy goes out the far side too', () => {
  const boat = caravel();
  applyShipImpactDamage(boat, { hitZone: 'hull', surfacePosition: [3, 0.6, 2], velocity: [-420, 0, 0], mass: 5.4, radius: 0.08, ammo: 'round', energy: 476000 });
  const holes = boat.damage.holes ?? [];
  assert.ok(holes.some((h) => h.side === 1), 'entry hole on her starboard side');
  assert.ok(holes.some((h) => h.side === -1), 'exit hole on her larboard side');
  const weak = caravel();
  applyShipImpactDamage(weak, { hitZone: 'hull', surfacePosition: [3, 0.6, 2], velocity: [-120, 0, 0], mass: 1.8, radius: 0.04, ammo: 'round', energy: 13000 });
  assert.equal((weak.damage.holes ?? []).length, 0, 'a spent ball only dents her');
  const grape = caravel();
  applyShipImpactDamage(grape, { hitZone: 'hull', surfacePosition: [3, 0.6, 2], velocity: [-300, 0, 0], mass: 5, radius: 0.08, ammo: 'grape', energy: 225000 });
  assert.equal((grape.damage.holes ?? []).length, 0, 'grape does not breach a hull');
});

test('water through a hole fills the hold, lists her that way, and a yard ends it', () => {
  const boat = caravel();
  addHullHole(boat.damage, hole(-0.6, 3, 0, 0.18));
  for (let i = 0; i < 240; i++) stepVesselDamage(boat, 0.25);
  assert.ok(boat.damage.floodingTonnes > 1, `flooded ${boat.damage.floodingTonnes} t`);
  assert.ok(boat.damage.compartments.midStarboard.waterTonnes > 0);
  assert.ok(boat.damage.floodingRoll < 0, 'lists to starboard, the side holed, by lifting larboard');
  const saved = vesselDamageSnapshot(boat);
  assert.equal(saved.holes.length, 1, 'holes survive a reload');
  const restored = caravel();
  restoreVesselDamageSnapshot(restored, JSON.parse(JSON.stringify(saved)));
  assert.equal(restored.damage.holes.length, 1);
  repairVessel(boat, { leaks: true });
  assert.equal(hullHoleInflow(boat, boat.damage, boat.damage.holes[0]), 0, 'a patch stops the water');
  assert.equal(boat.damage.holes.length, 1, 'though the hole still shows');
  repairVessel(boat, { structure: true });
  assert.equal(boat.damage.holes.length, 0, 'a full refit removes it');
  plugAllHullHoles(boat.damage);
  clearHullHoles(boat.damage);
});

test('the damage uniform holds holes, flows and craters, with the newest craters kept', () => {
  assert.equal(HULL_DAMAGE_UNIFORM_BYTES, 16 * (2 + 2 * HULL_HOLE_LIMIT + HULL_CRATER_LIMIT));
  const floats = new Float32Array(HULL_CRATER_LIMIT * 4), words = new Uint32Array(floats.buffer);
  const craters = Array.from({ length: HULL_CRATER_LIMIT + 5 }, (_, i) => ({ x: i, y: 1, z: 2, radius: 0.1, depth: 0.25, hits: 2 }));
  assert.equal(writeHullCraters(floats, craters), HULL_CRATER_LIMIT);
  assert.equal(floats[0], 5, 'the oldest fall off the front');
  assert.equal(words[3] & 0xfff, 400, 'radius');
  assert.equal((words[3] >> 12) & 0xfff, 250, 'depth');
  assert.equal(words[3] >>> 24, 2, 'hits');
  const data = new Float32Array(HULL_DAMAGE_UNIFORM_BYTES / 4);
  const written = writeHullFloodUniform(data, { damage: { holes: [], craters: craters.slice(0, 3) } });
  assert.equal(written.craters, 3);
  assert.equal(data[7], 3, 'the shader finds the count in level.w');
});

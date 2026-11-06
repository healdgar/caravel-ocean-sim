// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// A ball strikes what is drawn on a ship, from every bearing, with no stand-in for it. See js/ship-collider.js.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createShipAssetCache } from '../js/ship-mesh.js';
import { applyShipImpactDamage, createGunnerySolidSweep, createVesselDamageState, sweepShipRigging, sweepShipSegment } from '../js/gunnery-control.js';
import { applyFractureEvents, fracturePartsGone, shipFractureStateOf, shipMastSpecs } from '../js/ship-fracture.js';
import { sailingState } from '../js/sailing.js';
import { modelDeck, vesselVerticalScale } from '../js/hull.js';
import { VICTORY_SAILS } from '../js/models/victory.js';
import { victoryPose, victoryYardPoint } from '../js/victory-motion.js';
import { auditMasts, auditShipCollision, FAST_FAN, loadShip, PART, SHIP_IDS, SOLID } from '../scripts/model-audit-lib.mjs';
import { loadAuditModules } from '../scripts/model-audit.mjs';

const cache = createShipAssetCache(), lib = await loadAuditModules();
function shipOf(id, extra = {}) {
  const asset = cache.get(id), { length, beam } = asset.model.runtime;
  const boat = { id: 't', modelId: id, model: asset.model, partAssembly: asset.partAssembly, length, beam, x: 0, z: 0, heave: 0, heading: 0, roll: 0, pitch: 0, sailFore: 1, sailMain: 1, sailMizzen: 1, ...extra };
  createVesselDamageState(boat);
  return boat;
}
const scaleOf = (id) => cache.get(id).fracture.scale;
const ball = () => ({ id: 1, radius: 0.08, mass: 14.5, velocity: [0, 0, 400], ammo: 'round' });
const sweepAt = (boat) => createGunnerySolidSweep({ sourceBoat: null, getVessels: () => [boat] });

test('every ship stops a ball on what she draws, from every bearing', () => {
  for (const id of SHIP_IDS) {
    const row = auditShipCollision(loadShip(id), sweepShipSegment, createVesselDamageState, FAST_FAN);
    assert.ok(row.struck > 500, `${id}: ${row.struck} lines`);
    assert.equal(row.airRigPct, 0, `${id} stops no ball in empty air around her rig`);
    assert.equal(row.airHullPct, 0, `${id} stops no ball in empty air beside her hull`);
    assert.equal(row.throughHullPct, 0, `${id} lets no ball through her hull: ${row.missedGroups}`);
    assert.equal(row.phantomMastPct, 0, `${id} credits no mast she does not have`);
    assert.equal(row.wrongMastPct <= 3, true, `${id} credits the right mast`);
    // Yards aside, which stand at rest here and as the game has set them when the game draws them: see model-audit-gpu.
    assert.ok(row.agreePct > 80, `${id} agrees with her mesh on ${row.agreePct}% of lines`);
  }
});

test('the bow and stern are as long as they are drawn', () => {
  for (const id of ['victory', 'santa-maria', 'nina']) {
    const ship = loadShip(id), boat = shipOf(id), reach = boat.beam * 3;
    let compared = 0, fore = Infinity, aft = -Infinity;
    for (let t = 0; t < ship.partOf.length; t++) {
      if (ship.partOf[t] !== PART.hull) continue;
      const z = ship.positions[ship.asset.indices[t * 3] * 3 + 2];
      fore = Math.min(fore, z);
      aft = Math.max(aft, z);
    }
    // At both ends of her, past where a shot's hull was once written to end, at every height there is anything.
    assert.ok(Math.max(-fore, aft) > boat.length * 0.52, `${id} reaches past where a formula would end her`);
    for (const z of [fore + 0.3, fore + 1, fore + 2, aft - 0.3, aft - 1, aft - 2]) {
      for (let y = 0.2; y < ship.index.max[1]; y += 0.4) {
        const solid = ship.index.first([reach, y, z], [-1, 0, 0], reach * 2, SOLID, 0, ship.isLine);
        if (!solid || ship.partOf[solid.triangle] !== PART.hull) continue;
        compared++;
        const hit = sweepShipSegment([reach, y, z], [-reach, y, z], 0, boat);
        assert.ok(hit, `${id} stops a ball at y ${y.toFixed(1)}, z ${z.toFixed(1)}, on ${ship.groupId(solid.triangle)}`);
        assert.ok(Math.abs(hit.fraction * reach * 2 - solid.t) < 0.5, `${id} stops it on the surface at y ${y.toFixed(1)}, z ${z.toFixed(1)}`);
      }
    }
    assert.ok(compared >= 4, `${id} has something at her ends: ${compared}`);
  }
});

test('masts can be struck from the rail to the top, on their real heights, and rig stops nothing where nothing is drawn', () => {
  for (const id of SHIP_IDS) {
    const m = auditMasts(loadShip(id), lib);
    if (!m.rows.length) continue;
    assert.ok(m.mastDeadBandM <= 1, `${id}: a line at a mast misses it for ${m.mastDeadBandM} m`);
    assert.ok(m.mastStruckFromM - m.railAmidshipsM <= 1.5, `${id}: a mast is struck from ${m.mastStruckFromM} m, her rail at ${m.railAmidshipsM} m`);
    assert.ok(m.mastStruckToM >= Math.max(...m.rows.map((q) => q.top)) - 1.5, `${id}: a mast is struck up to ${m.mastStruckToM} m`);
  }
  // Well clear of her masts and within the old rig box: nothing there to meet.
  const victory = shipOf('victory'), [, , sz] = scaleOf('victory'), between = ((shipMastSpecs('victory')[0][1] + shipMastSpecs('victory')[1][1]) / 2) * sz;
  for (let y = 16; y < 40; y += 3) assert.ok(!sweepShipSegment([40, y, between], [-40, y, between], 0.08, victory), `no box of air at ${y} m`);
});

// Fired along her from ahead, through her canvas and clear of her masts.
function rakingLine(id, boat) {
  const ship = loadShip(id), reach = boat.length, canvas = [];
  for (let t = 0; t < ship.partOf.length; t += 7) {
    if (ship.partOf[t] !== PART.cloth) continue;
    const at = ship.asset.indices[t * 3] * 3;
    canvas.push([ship.positions[at], ship.positions[at + 1], ship.positions[at + 2]]);
  }
  // A line that crosses cloth and no solid at all.
  for (const [x, y] of canvas) {
    if (ship.index.first([x, y, -reach], [0, 0, 1], reach * 2, SOLID) || !ship.index.first([x, y, -reach], [0, 0, 1], reach * 2, PART.cloth)) continue;
    return { from: [x, y, -reach], to: [x, y, reach] };
  }
  return null;
}

test('a ball goes through canvas, tears it and flies on, and each mast takes the hit once', () => {
  for (const id of ['santa-maria', 'victory', 'flying-cloud']) {
    const boat = shipOf(id), line = rakingLine(id, boat);
    assert.ok(line, `${id} has canvas with nothing solid along the same line`);
    assert.ok(!sweepShipSegment(line.from, line.to, 0.01, boat), `${id}: canvas does not stop a ball`);
    const crossings = sweepShipRigging(line.from, line.to, 0.01, boat);
    assert.ok(crossings.length >= 1, `${id}: the ball crosses her canvas`);
    assert.equal(new Set(crossings.map((c) => c.mastGroup)).size, crossings.length, `${id}: one crossing a mast`);
    for (const crossing of crossings) assert.ok(shipMastSpecs(id).some((spec) => spec[0] === crossing.mastGroup), `${id}: ${crossing.mastGroup} is one of her masts`);
    const damage = boat.damage, projectile = ball(), surge = boat.surgeVelocity ?? 0;
    const stopped = sweepAt(boat)(line.from, line.to, projectile);
    assert.ok(!stopped, `${id}: it flies on`);
    assert.equal(damage.rigHits, crossings.length, `${id}: every mast whose canvas it crossed takes it`);
    assert.equal(damage.sailRips, crossings.length, `${id}: and that canvas is torn`);
    assert.ok(damage.rigIntegrity < 1, `${id}: which costs her rig`);
    assert.equal(boat.surgeVelocity ?? 0, surge, `${id}: and takes nothing out of the ball`);
    const rips = damage.pendingBakes.filter((bake) => bake.kind === 'sail-rip');
    assert.equal(rips.length, crossings.length, `${id}: a tear is marked for each`);
    // Back at rest, a mark lies on the sail, which is where a tear is drawn.
    const ship = loadShip(id), scale = scaleOf(id);
    for (const rip of rips) {
      const near = ship.index.nearest([rip.x * scale[0], rip.y * scale[1], rip.z * scale[2]], PART.cloth, 3);
      assert.ok(near && near.distance < 1.5, `${id}: tear on ${rip.mastGroup} is ${near?.distance.toFixed(2)} m from her canvas`);
    }
    // The same ball crossing the same masts again hurts nothing more.
    sweepAt(boat)(line.from, line.to, projectile);
    assert.equal(damage.rigHits, crossings.length, `${id}: one ball, one hit a mast`);
  }
});

test('the HUD hears of a tear, though the ball flies on', () => {
  const boat = shipOf('santa-maria'), line = rakingLine('santa-maria', boat), reports = [];
  const sweep = createGunnerySolidSweep({ sourceBoat: null, getVessels: () => [boat], onRigTorn: (report) => reports.push(report) });
  sweep(line.from, line.to, ball());
  assert.ok(reports.length >= 1);
  for (const report of reports) {
    assert.equal(report.hitZone, 'rigging');
    assert.ok(report.sailRips >= 1);
    assert.equal(report.kind, 'ship');
  }
});

test('an aiming preview names canvas and hurts nothing, and an arrow sticks in it', () => {
  const boat = shipOf('santa-maria'), line = rakingLine('santa-maria', boat), sweep = sweepAt(boat);
  const preview = sweep(line.from, line.to, { ...ball(), previewOnly: true });
  assert.equal(preview?.hitZone, 'rigging', 'it says where the shot would first do harm');
  assert.equal(preview.hitPartId, null, 'at no cost in looking up the part');
  assert.equal(boat.damage.hits ?? 0, 0, 'and it hurts nothing');
  const arrow = sweep(line.from, line.to, { id: 2, radius: 0.01, mass: 0.05, velocity: [0, 0, 60], ammo: 'arrow' });
  assert.equal(arrow?.hitZone, 'rigging', 'an arrow stops in what a ball tears');
  assert.ok(arrow.fraction > 0 && arrow.fraction < 1);
  assert.equal(boat.damage.sailRips ?? 0, 0, 'and an arrow tears nothing by itself');
});

test('a furled sail has no canvas left to tear, and a set one stands where it is braced', () => {
  const boat = shipOf('victory'), line = rakingLine('victory', boat);
  sailingState(boat);
  assert.ok(sweepShipRigging(line.from, line.to, 0.01, boat).some((c) => c.riggingKind === 'canvas'), 'set, it is crossed');
  boat.sailState.set.fill(0);
  assert.ok(!sweepShipRigging(line.from, line.to, 0.01, boat).some((c) => c.riggingKind === 'canvas'), 'furled, there is nothing there');
  boat.sailState.set.fill(1);

  // A braced yard is struck where it has swung to, and not where it lay.
  const sail = VICTORY_SAILS.find((s) => s.name === 'main-course'), [sx, sy, sz] = scaleOf('victory');
  const tip = [sail.pivot[0] + 2.4, sail.pivot[1], sail.pivot[2]];
  // Fired straight down onto the yard, which meets nothing but the yard's own length.
  const down = (p) => { const local = [p[0] * sx, p[1] * sy, p[2] * sz]; return sweepShipSegment([local[0], local[1] + 4, local[2]], [local[0], local[1] - 4, local[2]], 0.01, boat); };
  assert.equal(down(tip)?.hitPartId, 'yard.main-course', 'square, the yard lies across her');
  boat.sailState.squareYaw = 0.4;
  const swung = victoryYardPoint(sail.id, tip, victoryPose(sail, boat.sailState));
  assert.ok(Math.hypot(swung[0] - tip[0], swung[2] - tip[2]) > 0.5, 'bracing moves its tip');
  assert.notEqual(down(tip)?.hitPartId, 'yard.main-course', 'braced, it has left where it lay');
  assert.equal(down(swung)?.hitPartId, 'yard.main-course', 'and is struck where it now is');
});

test('a hatch lid stands where it is swung', () => {
  const boat = shipOf('santa-maria', { hatchesClosed: 1 }), { collider } = cache.get('santa-maria'), [sx, sy, sz] = scaleOf('santa-maria');
  const [hx, hy, hz] = collider.hatchPart.hinge, drop = (open) => { boat.hatchesClosed = open ? 0 : 1; return sweepShipSegment([hx * sx, (hy + 0.4) * sy, (hz + 0.2) * sz], [hx * sx, (hy - 0.1) * sy, (hz + 0.2) * sz], 0.01, boat); };
  assert.equal(drop(false)?.hitPartId, 'hatch.main', 'shut, a shot from above lands on the lid');
  assert.notEqual(drop(true)?.hitPartId, 'hatch.main', 'open, it has swung out of the way');
});

test('what has left her stops nothing, and what has fallen stops nothing', () => {
  const boat = shipOf('santa-maria'), asset = cache.get('santa-maria'), f = asset.fracture, [, sy, sz] = f.scale;
  // A plank on a line that meets it first.
  const part = (id) => f.strikable.map((s) => f.shards[s]).find((s) => s.partId === id && s.centroid[0] > 0);
  const plank = part('hull.planking'), y = plank.centroid[1] * sy, z = plank.centroid[2] * sz;
  const first = sweepShipSegment([boat.length, y, z], [-boat.length, y, z], 0.01, boat);
  assert.ok(first?.localPosition[0] > 0, 'it stops on the near side');
  shipFractureStateOf(boat.damage, f);
  applyFractureEvents(f, boat.damage, [{ x: plank.centroid[0], y: plank.centroid[1], z: plank.centroid[2], side: 1, severity: 2, stepDepth: 0.4 }, { x: plank.centroid[0], y: plank.centroid[1], z: plank.centroid[2], side: 1, severity: 2, stepDepth: 0.4 }, { x: plank.centroid[0], y: plank.centroid[1], z: plank.centroid[2], side: 1, severity: 2, stepDepth: 0.4 }], 0);
  const state = boat.damage.fracture;
  assert.ok(state.brokenCount > 0, 'the plank leaves');
  const second = sweepShipSegment([boat.length, y, z], [-boat.length, y, z], 0.01, boat);
  assert.ok(!second || second.localPosition[0] < first.localPosition[0] - 0.05, 'the shot carries on past where the plank was');
  assert.ok(!fracturePartsGone(state).has(second?.hitPartId));

  // Canvas falls with its mast, and neither stands in a ball's way after.
  const yardBoat = shipOf('santa-maria'), line = rakingLine('santa-maria', yardBoat), masts = sweepShipRigging(line.from, line.to, 0.01, yardBoat).map((c) => c.mastGroup);
  assert.ok(masts.length > 0);
  for (const mast of masts) yardBoat.damage.mastState[mast] = 2;
  assert.deepEqual(sweepShipRigging(line.from, line.to, 0.01, yardBoat).filter((c) => masts.includes(c.mastGroup)), [], 'a fallen mast takes its canvas with it');
});

test('a hit says what it struck: hull, waterline, deck, castle, gun, mast and magazine', () => {
  const victory = shipOf('victory'), [sx, sy, sz] = scaleOf('victory'), beam = (boat, y, z) => sweepShipSegment([boat.length, y, z], [-boat.length, y, z], 0.08, boat);
  const low = beam(victory, 0.4, 0);
  assert.equal(low.hitZone, 'hull');
  assert.equal(low.waterline, true, 'at the waterline');
  assert.ok(Number.isInteger(low.hitLayer), 'with the layer of its part');
  assert.equal(typeof low.hitSubAssembly, 'string');
  const high = beam(victory, 6, 13.5);
  assert.equal(high.hitZone, 'hull');
  assert.equal(high.waterline, false, 'clear of the waterline');
  const deckZ = 0.5, deckY = modelDeck(victory, deckZ) * vesselVerticalScale(victory);
  const deck = sweepShipSegment([3, deckY + 3, deckZ * sz], [3, deckY - 1, deckZ * sz], 0.08, victory);
  assert.ok(deck?.hitPartId?.startsWith('deck.'), `from above it meets a deck: ${deck?.hitPartId}`);
  assert.ok(deck.normal[1] > 0.5, 'which faces up');
  // Her stern galleries are glass and castle, which is what the damage model goes by.
  const stern = sweepShipSegment([0, 8, victory.length], [0, 8, 0], 0.08, victory);
  assert.ok(/stern|hull/.test(stern?.hitPartId ?? ''), `from astern it meets her stern: ${stern?.hitPartId}`);
  const sternReport = applyShipImpactDamage(shipOf('victory'), { ...stern, targetBoat: undefined, velocity: [0, 0, -400], mass: 14.5, energy: 0.5 * 14.5 * 400 * 400, ammo: 'round' });
  assert.equal(sternReport.isSuperstructure, true, 'and counts as her upper works');

  const specs = shipMastSpecs('santa-maria'), carrack = shipOf('santa-maria'), [, cy, cz] = scaleOf('santa-maria');
  const [mastId, mastZ, topCut] = specs.find((spec) => spec[0] === 'main');
  // Across her at the mast's own station, above her rail.
  const topmast = sweepShipSegment([carrack.length, topCut * cy, mastZ * cz], [-carrack.length, topCut * cy, mastZ * cz], 0.08, carrack);
  assert.equal(topmast?.mastGroup, mastId);
  assert.equal(topmast.hitZone, 'rigging');

  const magazine = shipOf('victory'), part = cache.get('victory').partAssembly.partsById['magazine.grand'], [mx, my, mz] = part.centroid;
  const inside = sweepShipSegment([(mx + 0.01) * sx, (part.bounds.max[1] + 0.02) * sy, mz * sz], [(mx + 0.01) * sx, my * sy, mz * sz], 0.01, magazine);
  assert.ok(inside?.hitPartId?.startsWith('magazine.'), `from within her it meets the magazine: ${inside?.hitPartId}`);
  applyShipImpactDamage(magazine, { ...inside, velocity: [0, -400, 0], mass: 14.5, energy: 0.5 * 14.5 * 400 * 400, ammo: 'round' });
  assert.equal(magazine.damage.magazineHit, true, 'and it goes up');
});

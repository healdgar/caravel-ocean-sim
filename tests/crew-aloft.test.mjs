// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Pieces leave a ship, and her people have to live with it: no rail where a bulwark was, and nothing
// to stand on when the mast comes down.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCompany, stepCompany, reviveCompany } from '../js/crew.js';
import { crewClearsRail, crewRailAboveDeck, crewOpenEdgeInset } from '../js/crew-overboard.js';
import { crewNavigationClear, crewNavigationRoute, crewNavigationSegmentClear, crewNavigationStation } from '../js/crew-navigation.js';
import { crewMastTop, crewRunnerGone, crewDeckHeight } from '../js/crew-work.js';
import { ALOFT_FALL_FATAL_M, ALOFT_FALL_HURT_M } from '../js/crew-aloft.js';
import { applyShipImpactDamage, createVesselDamageState } from '../js/gunnery-control.js';
import { repairVessel } from '../js/vessel-damage.js';
import { createShipAssetCache } from '../js/ship-mesh.js';
import { applyFractureEvents, shipFractureStateOf } from '../js/ship-fracture.js';
import { boatHydrodynamics } from '../js/boat.js';
import { getShipModel } from '../js/ship-models.js';
import { modelDeck, modelDeckWidth, vesselVerticalScale } from '../js/hull.js';

const cache = createShipAssetCache();
function ship(modelId = 'nina') {
  const model = getShipModel(modelId), { length, beam } = model.runtime;
  const boat = { modelId, model, length, beam, x: 0, z: 0, heave: 0, heading: 0, pitch: 0, roll: 0, rollVelocity: 0, cargoTonnes: 0, provisionDays: 30, showProw: true, surgeVelocity: 0, leewayVelocity: 0, sailFore: 0, sailMain: 0, sailMizzen: 0, rudder: 0, hatchesClosed: 1, events: [] };
  boat.hydrodynamics = boatHydrodynamics(length, beam, 30, 0, modelId);
  createVesselDamageState(boat);
  boat.crewEvents = (event) => boat.events.push(event);
  return boat;
}
function openRail(boat, side, minZ, maxZ) {
  const { fracture: f } = cache.get(boat.modelId), events = [];
  for (const s of f.strikable) {
    const [x, y, z] = f.shards[s].centroid;
    if (Math.sign(x) === side && z >= minZ && z <= maxZ && y > modelDeck(boat, z) - 0.2) events.push({ x, y, z, side, severity: 2, stepDepth: 0.4 });
  }
  for (let pass = 0; pass < 3; pass++) applyFractureEvents(f, boat.damage, events, 0);
  return shipFractureStateOf(boat.damage, f);
}
// The real path a mast comes down by: shots at it, until it is down to that stage.
function shootMast(boat, group, stage, side = 1) {
  for (let i = 0; i < 400 && (boat.damage.mastState[group] ?? 0) < stage; i++) {
    const mass = 14.5, speed = 430;
    applyShipImpactDamage(boat, { hitZone: 'rigging', mastGroup: group, localPosition: [side, 12, 0], position: [boat.x + side, 12, boat.z], surfacePosition: [boat.x + side, 12, boat.z], velocity: [-side * speed, -2, 0], mass, energy: 0.5 * mass * speed * speed, ammo: 'round' });
  }
  assert.ok(boat.damage.mastState[group] >= stage, `${group} came down to stage ${stage}`);
}
// A hand on a mast's ratlines, at that rung. The crew code puts him there on its next step.
function handAloft(company, boat, mast, side, rung, kind = 'rig') {
  const s = company.crew.find((c) => c.id === 'leonor');
  s.job = { kind, mast, side, stage: 'ascending', elapsed: 0, rung, cursor: 0, path: [], control: mast, revision: company.revision };
  s.intent = 'work';
  s.decisionIn = 5;
  return s;
}

test('with her bulwark shot away nothing stops a body going over, on that side and at that station only', () => {
  const boat = ship(), z = -1;
  const rail = crewRailAboveDeck(boat, z, 1);
  assert.equal(crewClearsRail(boat, z, 1, 0.8), false, 'a stumble stops at the rail');
  openRail(boat, 1, z - 1, z + 1);
  assert.ok(crewRailAboveDeck(boat, z, 1) < rail / 2, 'most of the rail has gone');
  assert.equal(crewRailAboveDeck(boat, z, -1), rail, 'the other side keeps hers');
  assert.equal(crewClearsRail(boat, z, 1, 0.8), true, 'the same stumble goes over');
  assert.equal(crewClearsRail(boat, z, -1, 0.8), false, 'on the far side it still stops');
  assert.equal(crewClearsRail(boat, 4, 1, 0.8), false, 'and away from the gap');
  repairVessel(boat, { hull: true, rig: true, leaks: true, flooding: true, full: true });
  boat.damage.fracture = null;
  assert.equal(crewRailAboveDeck(boat, z, 1), rail, 'a repair puts it back');
});

test('a hand knocked toward the gap goes over, and the same blow against her rail does not take him', () => {
  for (const open of [false, true]) {
    const boat = ship(), company = createCompany();
    for (let i = 0; i < 3; i++) stepCompany(company, boat, 0.05, 6);
    const s = company.crew.find((c) => c.id === 'afonso');
    s.z = -1; s.x = modelDeckWidth(boat, -1) - 0.34 / (boat.beam / 3.6) - 0.02; s.knockbackVx = 1.0; s.knockbackVz = 0; s.knockdownTimer = 1;
    if (open) openRail(boat, 1, -2, 0);
    for (let i = 0; i < 20 && !s.overboard; i++) stepCompany(company, boat, 0.05, 6);
    assert.equal(Boolean(s.overboard), open, open ? 'through the gap' : 'against the rail');
    if (open) assert.equal(boat.events.find((e) => e.type === 'overboard')?.sailor, s);
  }
});

test('nobody walks along an open edge, but a hand caught there can leave and a route goes round', () => {
  const boat = ship(), sx = boat.beam / 3.6, sy = vesselVerticalScale(boat), sz = boat.length / 12, z = -1;
  const width = modelDeckWidth(boat, z), edge = (width - 0.3 / sx - 0.05 / sx), floor = modelDeck(boat, z) * sy;
  const along = [[edge * sx, floor, (z - 0.4) * sz], [edge * sx, floor, (z + 0.4) * sz]];
  assert.equal(crewNavigationSegmentClear(along[0], along[1], boat), true, 'she walks her rail while it stands');
  assert.equal(crewOpenEdgeInset(boat, z, 1), 0);
  openRail(boat, 1, z - 1.2, z + 1.2);
  assert.ok(crewOpenEdgeInset(boat, z, 1) > 0, 'the deck is narrower beside the gap');
  const inboard = [(edge - 0.8) * sx, floor, z * sz];
  assert.equal(crewNavigationSegmentClear(inboard, [edge * sx, floor, z * sz], boat), false, 'no walking out to it');
  assert.equal(crewNavigationSegmentClear([edge * sx, floor, z * sz], inboard, boat), true, 'a hand already there can come away');
  const route = crewNavigationRoute([[1.0, modelDeck(boat, z - 1), z - 1], [1.0, modelDeck(boat, z + 1), z + 1]], boat);
  assert.ok(route, 'a walk past the gap still has a way');
  assert.ok(route.every((p) => Math.abs(p[0]) + crewOpenEdgeInset(boat, p[2], Math.sign(p[0])) + 0.3 / sx < modelDeckWidth(boat, p[2]) + 1e-6), 'and it keeps off the edge');
});

test('a post at an open edge moves inboard, so hands sent back to it have somewhere to go', () => {
  const boat = ship(), sx = boat.beam / 3.6, z = -1, width = modelDeckWidth(boat, z), post = width - 0.3 / sx - 0.05 / sx;
  const floor = modelDeck(boat, z);
  assert.deepEqual(crewNavigationStation([post, floor, z], boat), [post, floor, z], 'she has her rail, so it stands');
  openRail(boat, 1, z - 1.2, z + 1.2);
  const moved = crewNavigationStation([post, floor, z], boat);
  assert.ok(moved, 'it is still somewhere on deck');
  assert.ok(moved[0] < post - 0.1, `it moved in from ${post.toFixed(2)} to ${moved[0].toFixed(2)}`);
  assert.ok(crewNavigationClear(moved.map((v, i) => v * [sx, vesselVerticalScale(boat), boat.length / 12][i]), boat), 'and can be stood on');
});

test('a hand left standing at an open edge moves in from it', () => {
  const boat = ship(), company = createCompany();
  for (let i = 0; i < 3; i++) stepCompany(company, boat, 0.05, 6);
  const s = company.crew.find((c) => c.id === 'afonso');
  s.job = null; s.intent = 'standby'; s.nextWatch = 1e9;
  s.z = -1; s.x = modelDeckWidth(boat, -1) - 0.05; s.home = [s.x, s.z];
  const before = s.x;
  stepCompany(company, boat, 0.05, 6);
  assert.ok(Math.abs(s.x - before) < 1e-6, 'she has her rail, so he stays');
  openRail(boat, 1, -2.2, 0.2);
  for (let i = 0; i < 60; i++) stepCompany(company, boat, 0.05, 6);
  const sx = boat.beam / 3.6;
  assert.ok(s.x < before - 0.2, `he is inboard of the edge, at ${s.x.toFixed(2)} of ${before.toFixed(2)}`);
  assert.ok(Math.abs(s.x) + crewOpenEdgeInset(boat, s.z, 1) + 0.33 / sx <= modelDeckWidth(boat, s.z) + 0.02, 'and stops at a safe distance');
});

test('a hand high on a falling mast goes with it, over the side, counted lost', () => {
  const boat = ship('victory'), company = createCompany(undefined, 'victory');
  stepCompany(company, boat, 0.05, 6);
  const s = handAloft(company, boat, 1, 1, 25);
  stepCompany(company, boat, 0.05, 6);
  const height = s.position[1], c = boat.damage.crewCasualties;
  assert.ok(height > 15, `he is aloft, at ${height.toFixed(1)} m`);
  assert.equal(s.job.rung > 0, true);
  shootMast(boat, 'main', 2);
  // The shots themselves hurt hands the game does not draw, so count from here.
  const able = c.able;
  stepCompany(company, boat, 0.05, 6);
  assert.equal(s.job, null, 'nothing left to work on');
  assert.ok(s.overboard, 'he goes with it');
  assert.equal(s.overboard.cause, 'mast-fall');
  assert.equal(boat.events.find((e) => e.type === 'overboard')?.sailor, s);
  assert.equal(c.able, able - 1);
  // Under way, so no line reaches him.
  boat.surgeVelocity = 4;
  for (let i = 0; i < 200; i++) stepCompany(company, boat, 0.05, 6);
  assert.ok(s.overboard.inWater, 'and comes down in the sea');
  assert.ok(s.position[1] < 1, `not in the air, at ${s.position[1].toFixed(1)} m`);
});

test('from the lookout\'s perch too, and the masts still standing keep their hands', () => {
  for (const id of ['nina', 'santa-maria']) {
    const boat = ship(id), company = createCompany(undefined, id);
    const lookout = company.crew.find((c) => c.role === 'Lookout');
    const atPost = () => lookout.job?.kind === 'lookout' && lookout.job.stage === 'working' && lookout.position[1] > 6;
    for (let i = 0; i < 900 && !atPost(); i++) stepCompany(company, boat, 0.1, 6);
    assert.ok(atPost(), `${id}: she got up there the normal way`);
    const group = ['fore', 'main', 'mizzen'][lookout.job.mast], other = group === 'main' ? 'fore' : 'main';
    shootMast(boat, other, 2);
    stepCompany(company, boat, 0.05, 6);
    assert.ok(lookout.job, `${id}: another mast falling leaves her where she is`);
    shootMast(boat, group, 2);
    stepCompany(company, boat, 0.05, 6);
    assert.equal(lookout.job, null, `${id}: her mast has gone`);
    assert.ok(lookout.overboard || lookout.aloftFall, `${id}: she goes with it`);
    assert.ok(!company.crew.some((s) => s !== lookout && s.overboard?.cause === 'mast-fall'), `${id}: nobody else was on it`);
    for (let i = 0; i < 100; i++) stepCompany(company, boat, 0.05, 6);
    assert.ok(lookout.position[1] < 3, `${id}: and is down, at ${lookout.position[1].toFixed(1)} m`);
  }
});

test('a fall onto her deck hurts by its height, and is counted when he lands', () => {
  // On the port shrouds, with the mast going to starboard: it throws him across her, not out of her.
  const land = (rung) => {
    const boat = ship(), company = createCompany();
    stepCompany(company, boat, 0.05, 6);
    const s = handAloft(company, boat, 1, -1, rung);
    stepCompany(company, boat, 0.05, 6);
    const sy = vesselVerticalScale(boat), c = boat.damage.crewCasualties, before = { ...c };
    const drop = s.position[1] - crewDeckHeight(boat, s.z, s.x) * sy;
    boat.damage.mastFallSide = { main: 1 };
    boat.damage.mastState.main = 2;
    stepCompany(company, boat, 0.05, 6);
    return { boat, company, s, c, before, drop, sy };
  };
  const hurt = land(12);
  assert.ok(hurt.drop > ALOFT_FALL_HURT_M && hurt.drop < ALOFT_FALL_FATAL_M, `a middling fall of ${hurt.drop.toFixed(1)} m`);
  assert.ok(hurt.s.aloftFall, 'he is falling');
  assert.ok(!hurt.s.overboard, 'not over the side');
  assert.equal(hurt.c.able, hurt.before.able, 'not counted until he lands');
  const start = hurt.s.position[1], deck = crewDeckHeight(hurt.boat, hurt.s.z, hurt.s.x) * hurt.sy;
  assert.ok(start > deck + 1, 'he starts from where he was, not on the deck');
  for (let i = 0; i < 60 && hurt.s.aloftFall; i++) stepCompany(hurt.company, hurt.boat, 0.05, 6);
  assert.equal(hurt.s.aloftFall, null);
  assert.equal(hurt.s.casualtyState, 'wounded');
  assert.equal(hurt.c.wounded, hurt.before.wounded + 1);
  assert.equal(hurt.c.killed, hurt.before.killed);
  assert.equal(hurt.c.able, hurt.before.able - 1);
  assert.ok(hurt.boat.events.some((e) => e.type === 'fell-from-aloft' && e.sailor === hurt.s && e.hurt));
  assert.ok(hurt.s.pendingWounds?.some((w) => w.kind === 'fall'), 'something breaks');
  for (let i = 0; i < 80; i++) stepCompany(hurt.company, hurt.boat, 0.05, 6);
  assert.ok(hurt.s.position[1] - crewDeckHeight(hurt.boat, hurt.s.z, hurt.s.x) * hurt.sy < 0.2, 'and he stays on the deck');

  const short = land(3);
  assert.ok(short.drop < ALOFT_FALL_HURT_M, `a short fall of ${short.drop.toFixed(1)} m`);
  for (let i = 0; i < 60 && short.s.aloftFall; i++) stepCompany(short.company, short.boat, 0.05, 6);
  assert.notEqual(short.s.casualtyState, 'wounded', 'only knocks him down');
  assert.equal(short.c.able, short.before.able);
  assert.ok(short.s.knockdownTimer > 0);
});

test('a topmast takes only the hands above its break', () => {
  const boat = ship('victory'), company = createCompany(undefined, 'victory');
  stepCompany(company, boat, 0.05, 6);
  const s = handAloft(company, boat, 1, 1, 15);
  stepCompany(company, boat, 0.05, 6);
  const sy = vesselVerticalScale(boat);
  shootMast(boat, 'main', 1);
  assert.ok(crewMastTop(boat, 1) * sy > s.position[1], 'he is below the break');
  assert.equal(crewRunnerGone(boat, 1, 1), false, 'the lower shrouds are made fast below it');
  stepCompany(company, boat, 0.05, 6);
  assert.ok(s.job, 'he is still on them');
  assert.ok(!s.overboard && !s.aloftFall);
  boat.damage.mastState.main = 2;
  stepCompany(company, boat, 0.05, 6);
  assert.ok(!s.job, 'the lower mast takes him');
});

test('a mast that has come down gets no one sent up it, and its canvas is worked from the deck', () => {
  const boat = ship(), company = createCompany();
  stepCompany(company, boat, 0.05, 6);
  boat.damage.mastState.fore = 2;
  boat.damage.mastState.main = 2;
  boat.sailMain = 0.2; boat.sailFore = 0.2;
  for (let i = 0; i < 400; i++) stepCompany(company, boat, 0.05, 6);
  assert.ok(!company.crew.some((s) => s.job?.rung > 0), 'nobody climbs');
  assert.ok(!company.crew.some((s) => s.job?.kind === 'lookout'), 'and nobody keeps a lookout from a nest that left');
});

test('a hand walking to a mast when it falls turns back', () => {
  const boat = ship(), company = createCompany();
  stepCompany(company, boat, 0.05, 6);
  const s = company.crew.find((c) => c.role === 'Lookout');
  for (let i = 0; i < 400 && s.job?.stage !== 'approach'; i++) stepCompany(company, boat, 0.05, 6);
  assert.equal(s.job?.stage, 'approach', 'she set off for the mast');
  boat.damage.mastState[['fore', 'main', 'mizzen'][s.job.mast]] = 2;
  stepCompany(company, boat, 0.05, 6);
  assert.ok(!s.job || s.job.stage === 'return' || s.job.stage === 'waiting-return', `she goes back, ${s.job?.stage}`);
  assert.ok(!s.aloftFall && !s.overboard, 'she was never on it');
});

test('a mast repaired and shot away again takes its hands again, and a revived crew are clear of it', () => {
  const boat = ship('victory'), company = createCompany(undefined, 'victory');
  stepCompany(company, boat, 0.05, 6);
  boat.damage.mastState.main = 2;
  stepCompany(company, boat, 0.05, 6);
  boat.damage.mastState.main = 0;
  stepCompany(company, boat, 0.05, 6);
  const s = handAloft(company, boat, 1, 1, 25);
  stepCompany(company, boat, 0.05, 6);
  assert.ok(s.job);
  boat.damage.mastState.main = 2;
  stepCompany(company, boat, 0.05, 6);
  assert.ok(!s.job, 'it counts as a new fall');
  reviveCompany(company);
  assert.ok(!s.aloftFall && !s.overboard && s.casualtyState === 'able');
});

// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Shots hurt the bodies they reach. Arrows stay in them, and balls can take or wreck limbs.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { sweepCrewBodies, recordCrewWound, applyCrewWounds, clearCrewWounds, crewWoundOutcome, CREW_ARROWS_PER_BODY, CREW_BALL_SEVER_CHANCE, CREW_BALL_BREAK_CHANCE } from '../js/crew-wounds.js';
import { applyArrowImpact, applyCrewCasualtiesAndMorale, createGunnerySolidSweep, createVesselDamageState, resolveWaterGunneryImpact, sweepShipSegment, vesselRailHeight } from '../js/gunnery-control.js';
import { bindVesselModel } from '../js/vessels.js';
import { reviveCompany, createFortGarrison, stepFortGarrison, reviveGarrisonSoldiers } from '../js/crew.js';

const sailor = (i, position, extra = {}) => ({ id: 's' + i, crewIndex: i, visible: true, casualtyState: 'able', health: 1, yaw: 0, scale: [1, 1, 1], position: Float32Array.from(position), ...extra });
const makeBoat = (modelId, crew, extra = {}) => {
  const boat = { id: modelId, modelId, length: 20, beam: 6, x: 0, z: 0, heave: 0, heading: 0, pitch: 0, roll: 0, ...extra };
  bindVesselModel(boat, modelId);
  boat.crewCompany = { crew };
  createVesselDamageState(boat);
  return boat;
};
// A small skeleton: every named bone is a translated identity matrix in actor space.
const animator = (bones) => {
  const names = Object.keys(bones), world = names.map((name) => Float32Array.from([1, 0, 0, 0, 0, 1, 0, 0, 0, 0, 1, 0, ...bones[name], 1]));
  const pose = names.map(() => ({ r: Float32Array.from([0, 0, 0, 1]), s: Float32Array.from([1, 1, 1]) }));
  return {
    world, pose, nodeIndex: (name) => names.indexOf(name),
    updateBranch(node) { const s = pose[node].s; world[node].set([s[0], 0, 0, 0, 0, s[1], 0, 0, 0, 0, s[2], 0], 0); },
  };
};
const skeleton = () => animator({ spine_03: [0, 1.35, 0], Head: [0, 1.62, 0], upperarm_l: [0.2, 1.4, 0], lowerarm_l: [0.42, 1.2, 0], thigh_r: [-0.1, 0.9, 0], calf_r: [-0.1, 0.48, 0] });

test('a shot meets only the bodies on its path, nearest first', () => {
  const crew = [sailor(0, [0, 0, 0]), sailor(1, [4, 0, 0.05]), sailor(2, [2, 0, 3]), sailor(3, [1, 0, 0], { casualtyState: 'fallen' }), sailor(4, [1.5, 0, 0], { visible: false })];
  const hits = sweepCrewBodies([-3, 1, 0], [7, 1, 0], 0.05, crew);
  assert.deepEqual(hits.map((hit) => hit.sailor.id), ['s0', 's1'], 'the off-line, fallen and hidden are untouched');
  assert.ok(hits[0].fraction < hits[1].fraction);
  assert.equal(sweepCrewBodies([-3, 2.2, 0], [7, 2.2, 0], 0.05, crew).length, 0, 'a shot overhead misses');
  assert.deepEqual(sweepCrewBodies([-3, 1, 0], [7, 1, 0], 0.05, crew, 0.5).map((hit) => hit.sailor.id), ['s0'], 'whatever it strikes first shields those behind');
});

test('an arrow stops in the first body and stays with that bone', () => {
  // Clear above the waist's rail, so nothing but bodies lies on the path.
  const near = sailor(0, [0, 1.2, 0]), far = sailor(1, [1, 1.2, 0]);
  const target = makeBoat('nina', [near, far]), source = makeBoat('nina', [sailor(9, [-0.3, 1.2, 0])], { id: 'source' });
  const sweep = createGunnerySolidSweep({ sourceBoat: source, getVessels: () => [source, target] });
  const hit = sweep([-5, 2.6, 0], [5, 2.6, 0], { ammo: 'arrow', radius: 0.01 });
  assert.equal(hit.hitZone, 'crew');
  assert.equal(hit.sailor, near, 'and not the sailor behind, nor anyone aboard the ship that loosed it');
  assert.notEqual(sweep([-5, 2.6, 0], [5, 2.6, 0], { ammo: 'arrow', radius: 0.01, previewOnly: true })?.hitZone, 'crew', 'aiming previews reach no one');
  assert.equal(sweep([-5, 1.7, 0], [5, 1.7, 0], { ammo: 'arrow', radius: 0.01 }).hitZone, 'hull', 'the bulwark shields whoever stands behind it');
  const report = applyArrowImpact(target, { type: 'impact', kind: 'ship', targetBoat: target, ammo: 'arrow', shotId: 3, hitZone: 'crew', sailor: near, localPosition: [0.02, 2.56, 0], velocity: [50, -3, 0], mass: 0.065, energy: 90 });
  assert.equal(report.casualtiesKilled + report.casualtiesWounded, 1);
  assert.notEqual(near.casualtyState, 'able');
  assert.equal(far.casualtyState, 'able');
  const a = skeleton();
  applyCrewWounds(a, near);
  assert.equal(near.stuckArrows.length, 1);
  assert.equal(near.stuckArrows[0].bone, 'spine_03', 'it bakes onto the nearest bone');
  const before = near.stuckArrowPoses[0].tip.slice();
  a.world[a.nodeIndex('spine_03')][13] += 0.5;
  applyCrewWounds(a, near);
  assert.ok(Math.abs(near.stuckArrowPoses[0].tip[1] - before[1] - 0.5) < 1e-5, 'and follows it');
});

test('the solid hull ends at the rail, leaving open air above a low hull', () => {
  const canoe = makeBoat('taino-canoe', [], { length: 14, beam: 1.8 });
  assert.ok(vesselRailHeight(canoe, 0) < 0.8);
  assert.equal(sweepShipSegment([-3, 1.5, 0], [3, 1.5, 0], 0.01, canoe), null, 'a shot well above her gunwale flies on');
  assert.equal(sweepShipSegment([-3, 0.2, 0], [3, 0.2, 0], 0.01, canoe).hitZone, 'hull');
  const nina = makeBoat('nina', []);
  assert.ok(vesselRailHeight(nina, 7) > vesselRailHeight(nina, 0) + 1, 'a sterncastle stands above the waist');
  assert.equal(sweepShipSegment([-6, 3.5, 7], [6, 3.5, 7], 0.01, nina).hitZone, 'hull');
  assert.equal(sweepShipSegment([-6, 3.5, 0], [6, 3.5, 0], 0.01, nina), null);
});

test('a body keeps only its latest arrows, and a lost limb takes its arrows with it', () => {
  const s = sailor(0, [0, 0, 0]);
  for (let i = 0; i < CREW_ARROWS_PER_BODY + 2; i++) recordCrewWound(s, 'arrow', [0.42, 1.2 + i * 0.01, 0], [1, 0, 0]);
  const a = skeleton();
  applyCrewWounds(a, s);
  assert.equal(s.stuckArrows.length, CREW_ARROWS_PER_BODY);
  assert.equal(s.stuckArrows[0].bone, 'lowerarm_l');
  s.crewInjuries = [{ kind: 'severed', bone: 'lowerarm_l' }];
  applyCrewWounds(a, s);
  assert.equal(s.stuckArrowPoses.length, 0);
});

test('a ball through a body kills it, may take or break a limb, and flies on', () => {
  const struck = sailor(0, [0, 1.2, 0]), beside = sailor(1, [0, 1.2, 2]);
  const target = makeBoat('nina', [struck, beside]);
  const sweep = createGunnerySolidSweep({ sourceBoat: null, getVessels: () => [target] });
  const ball = { id: 2, ammo: 'round', radius: 0.05, mass: 5.4, velocity: [400, 0, 0] };
  const hit = sweep([-5, 2.6, 0], [0.1, 2.6, 0], ball);
  sweep([0.1, 2.6, 0], [5, 2.6, 0], ball);
  assert.notEqual(hit?.hitZone, 'crew', 'the shot does not stop for a body');
  assert.equal(struck.casualtyState, 'fallen');
  assert.equal(struck.pendingWounds.length, 1, 'struck once, however many steps it spans');
  assert.equal(beside.casualtyState, 'able', 'no splash');
  assert.equal(target.damage.crewCasualties.killed, 1);
  assert.deepEqual(crewWoundOutcome('ball', 'lowerarm_l', CREW_BALL_SEVER_CHANCE - 0.01), { kind: 'severed', bone: 'lowerarm_l' });
  assert.deepEqual(crewWoundOutcome('ball', 'hand_l', 0), { kind: 'severed', bone: 'lowerarm_l' }, 'a hand parts at the forearm');
  assert.deepEqual(crewWoundOutcome('ball', 'calf_r', CREW_BALL_SEVER_CHANCE + 0.01), { kind: 'broken', bone: 'calf_r' });
  assert.equal(crewWoundOutcome('ball', 'calf_r', CREW_BALL_SEVER_CHANCE + CREW_BALL_BREAK_CHANCE + 0.01), null, 'sometimes it leaves the body whole');
  assert.deepEqual(crewWoundOutcome('ball', 'spine_02', 0), { kind: 'crushed', bone: 'spine_03' });
  assert.equal(crewWoundOutcome('ball', 'Head', 0.99), null);
  assert.equal(crewWoundOutcome('arrow', 'lowerarm_l', 0), null, 'an arrow takes no limb');
  assert.equal(crewWoundOutcome('splinter', 'spine_03', 0), null);
  assert.equal(crewWoundOutcome('splinter', 'calf_r', 0).kind, 'broken');
});

test('injuries reshape the posed skeleton and survive every later pose', () => {
  const s = sailor(0, [0, 0, 0]);
  recordCrewWound(s, 'ball', [0.42, 1.2, 0], [1, 0, 0], 0);
  const a = skeleton(), node = a.nodeIndex('lowerarm_l');
  applyCrewWounds(a, s);
  assert.deepEqual(s.crewInjuries, [{ kind: 'severed', bone: 'lowerarm_l' }]);
  assert.ok(a.pose[node].s[0] < 0.01, 'the limb collapses to its joint');
  a.pose[node].s.fill(1);
  applyCrewWounds(a, s);
  assert.ok(a.pose[node].s[0] < 0.01);
  clearCrewWounds(s);
  assert.equal(s.crewInjuries, null);
});

test('a hit no longer invents a crowd of casualties', () => {
  const count = (modelId, crew, extra, event, context) => {
    const boat = makeBoat(modelId, crew, extra);
    const r = applyCrewCasualtiesAndMorale(boat, event, context);
    return { n: r.killed + r.wounded, boat };
  };
  const ball12 = { ammo: 'round', energy: 551000, hitZone: 'hull' }, ball32 = { ammo: 'round', energy: 1720000, hitZone: 'hull' };
  assert.ok(count('nina', [], {}, ball12, {}).n <= 1, 'a 12-pounder that stays out hurts next to no one');
  assert.ok(count('nina', [], {}, ball12, { penetratedOuter: true }).n <= 2, 'even breaking through a small ship');
  assert.ok(count('victory', [], { length: 69, beam: 16 }, ball32, { penetratedOuter: true }).n <= 5, 'a crowded first rate loses a few');
  const close = sailor(0, [0, 0, 0]), far = sailor(1, [0, 0, 30]);
  const hurtClose = [];
  for (let hits = 1; hits < 40; hits++) {
    close.casualtyState = 'able'; far.casualtyState = 'able';
    const boat = makeBoat('nina', [close, far]);
    boat.damage.hits = hits;
    applyCrewCasualtiesAndMorale(boat, ball12, { penetratedOuter: true, localPos: [0, 1, 0.5] });
    hurtClose.push(close.casualtyState !== 'able');
    assert.equal(far.casualtyState, 'able', 'splinters only reach those close by');
  }
  assert.ok(hurtClose.some(Boolean) && !hurtClose.every(Boolean), 'and hurt them only sometimes');
});

test('a new ship in a pooled hull starts whole', () => {
  const s = sailor(0, [0, 0, 0], { crewInjuries: [{ kind: 'severed', bone: 'thigh_r' }], stuckArrows: [{}], stuckArrowPoses: [{}], pendingWounds: [{}] });
  reviveCompany({ crew: [s] });
  assert.equal(s.crewInjuries, null);
  assert.equal(s.stuckArrows, null);
  assert.equal(s.stuckArrowPoses, null);
  assert.equal(s.pendingWounds, null);
});

test('people on land take cannonball and crater blast damage, with bodies thrown and limbs wounded', () => {
  const fort = { id: 'fort_1', prefabId: 'torreon_atalaya_farol', x: 0, y: 0, z: 0, width: 16, length: 16, height: 6, yaw: 0, damageState: { state: 'intact', craters: [], fires: [] } };
  const port = { center: { x: 0, z: 0 }, reach: 200, instances: [fort] };
  const garrison = createFortGarrison(port);
  assert.ok(garrison.soldiers.length >= 2, 'fort spawns land garrison soldiers');
  const first = garrison.soldiers.reduce((a, b) => a.position[2] < b.position[2] ? a : b);
  const startX = first.position[0], startY = first.position[1], startZ = first.position[2];

  // 1. Direct cannonball strike throws the soldier's body and records a limb/body wound.
  const sweep = createGunnerySolidSweep({ getTerrain: () => ({ port }) });
  const ball = { id: 1, ammo: 'round', radius: 0.08, mass: 8, velocity: [0, 0, 260] };
  sweep([startX, startY + 1.1, startZ - 5], [startX, startY + 1.1, startZ + 0.5], ball);
  assert.equal(first.casualtyState, 'fallen');
  assert.equal(first.woundSeverity, 1.0);
  assert.ok(first.scorchAmount > 0);
  assert.equal(first.pendingWounds?.length, 1);
  assert.ok(first.knockbackVz > 3.0 && first.knockbackVy > 1.5, 'ball imparts forward and upward throw velocity');

  stepFortGarrison(garrison, 0.08, 0);
  assert.ok(first.position[2] > startZ + 0.2, 'thrown forward along the shot path');
  assert.ok(first.baseLy > first.homeBaseLy, 'launched upward on a ballistic arc');
  const a = skeleton();
  applyCrewWounds(a, first);
  assert.equal(first.pendingWounds, null, 'wound is baked onto the skeleton');

  // 2. Building crater blast throws and wounds nearby land soldiers/villagers.
  const second = garrison.soldiers[1];
  const secStartLx = second.lx, secStartLz = second.lz;
  fort.damageState.craters.push({ localPosition: [secStartLx - 1.0, second.ly, secStartLz - 1.0], radius: 2.2, severity: 0.9, isExplosion: true });
  stepFortGarrison(garrison, 0.08, 0);
  assert.equal(second.casualtyState, 'fallen');
  assert.equal(second.woundSeverity, 1.0);
  assert.ok(second.scorchAmount > 0.4);
  assert.ok(Math.hypot(second.lx - secStartLx, second.lz - secStartLz) > 0.15, 'blast throws the soldier away from the crater');
  assert.equal(second.pendingWounds?.length, 1);

  reviveGarrisonSoldiers(fort);
  assert.equal(first.casualtyState, 'able');
  assert.equal(first.woundSeverity, 0);
  assert.equal(first.crewInjuries, null);
  assert.equal(first.lx, first.homeLxz?.[0] ?? first.lx);
});

test('repeated cannonball and water-blast impacts maim fallen bodies and overboard swimmers in the water', () => {
  const deckCorpse = sailor(0, [0, 3.2, 0], { casualtyState: 'fallen', health: 0 });
  const swimmer = sailor(1, [14, -0.1, 8], {
    casualtyState: 'fallen',
    health: 0.8,
    overboard: { x: 14, y: -0.1, z: 8, vx: 0, vy: 0, vz: 0, age: 5, afloat: 5, inWater: true, alive: true, wounded: false, side: 1, cause: 'sinking', gone: false },
  });
  const boat = makeBoat('nina', [deckCorpse, swimmer]);
  const sweep = createGunnerySolidSweep({ sourceBoat: null, getVessels: () => [boat] });

  // 1. A low shot across the deck strikes an already-fallen corpse and severs an intact limb via ball-maim.
  sweep([-5, 3.3, 0], [5, 3.3, 0], { id: 10, ammo: 'round', radius: 0.1, mass: 8, velocity: [260, 0, 0] });
  assert.equal(deckCorpse.pendingWounds?.[0]?.kind, 'ball-maim');
  const a0 = skeleton();
  applyCrewWounds(a0, deckCorpse);
  const severedAfterFirst = (deckCorpse.crewInjuries ?? []).filter((v) => v.kind === 'severed').length;
  assert.ok(severedAfterFirst >= 1, 'fallen corpse loses a limb on re-hit');

  // 2. A water splash right next to an overboard swimmer kills, maims, and launches them out of the water.
  const waterRes = resolveWaterGunneryImpact(
    { type: 'impact', kind: 'water', ammo: 'round', shotId: 11, surfacePosition: [14.8, 0, 8.4], velocity: [0, -45, 180] },
    { getVessels: () => [boat] },
  );
  assert.equal(waterRes?.bodiesStruck, 1);
  assert.equal(swimmer.overboard.alive, false);
  assert.equal(swimmer.overboard.inWater, false);
  assert.ok(swimmer.overboard.vy > 1.5, 'water blast launches overboard body into the air');
  assert.equal(swimmer.pendingWounds?.[0]?.kind, 'ball-maim');
});

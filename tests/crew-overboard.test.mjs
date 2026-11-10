// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Bodies that clear the rail leave the ship, and the sea decides the rest.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCompany, stepCompany, reviveCompany } from '../js/crew.js';
import { crewClearsRail, sendCrewOverboard, stepCrewOverboard, stepGaleKnockdowns, loseHandInGale, OVERBOARD_DROWN_SECONDS, OVERBOARD_RESCUE_SECONDS, OVERBOARD_RESCUE_RANGE_M } from '../js/crew-overboard.js';
import * as overboard from '../js/crew-overboard.js';
import { createVesselDamageState } from '../js/gunnery-control.js';
import { boatHydrodynamics, boatRotate } from '../js/boat.js';

function ship() {
  const boat = { x: 0, z: 0, heave: 0, heading: 0, pitch: 0, roll: 0, modelId: 'nina', length: 20, beam: 6, cargoTonnes: 0, provisionDays: 30, showProw: true, surgeVelocity: 0, leewayVelocity: 0, sailFore: 0, sailMain: 0, sailMizzen: 0, rudder: 0, hatchesClosed: 1, events: [] };
  boat.hydrodynamics = boatHydrodynamics(boat.length, boat.beam, 30, 0, 'nina');
  createVesselDamageState(boat);
  boat.crewEvents = (event) => boat.events.push(event);
  return boat;
}
const hand = (position = [2.5, 1.5, 0]) => ({ name: 'Duarte', position: [...position], x: position[0] / 1.67, z: 0, casualtyState: 'able', health: 1, visible: true, crewIndex: 3 });

test('it takes real speed to clear the rail, and less when she is heeled that way', () => {
  const boat = ship();
  assert.equal(crewClearsRail(boat, 0, 1, 0.8), false, 'a stumble stops at the rail');
  assert.equal(crewClearsRail(boat, 0, 1, 5), true, 'a blast does not');
  boat.roll = -0.35; // Starboard low.
  assert.equal(crewClearsRail(boat, 0, 1, 0.8), true, 'downhill he goes over');
  assert.equal(crewClearsRail(boat, 0, -1, 0.8), false, 'uphill he does not');
});

test('a man over the side counts as lost, falls to the sea, and stays there as she sails on', () => {
  const boat = ship(), s = hand(), c = boat.damage.crewCasualties, able = c.able;
  sendCrewOverboard(boat, s, { side: 1, outward: 4 });
  assert.equal(c.able, able - 1);
  assert.equal(c.killed, 1);
  assert.equal(boat.events[0].type, 'overboard');
  assert.equal(boat.events[0].alive, true);
  for (let i = 0; i < 120; i++) stepCrewOverboard(boat, s, 1 / 30);
  assert.ok(boat.events.some((e) => e.type === 'overboard-splash'), 'hits the water');
  assert.ok(s.overboard.y < 0 && s.overboard.y > -0.3, 'floats at the surface');
  const x = s.overboard.x;
  boat.x += 200;
  stepCrewOverboard(boat, s, 1 / 30);
  assert.ok(Math.abs(s.overboard.x - x) < 0.1, 'the sea does not follow the ship');
  assert.ok(Math.abs(s.position[0] - (x - 200)) < 0.2, 'so he falls astern of her in her own frame');
});

test('bring her close and slow within time and he is hauled in, hurt', () => {
  const boat = ship(), s = hand(), c = boat.damage.crewCasualties;
  sendCrewOverboard(boat, s, { side: 1, outward: 4 });
  for (let t = 0; t < 2 + OVERBOARD_RESCUE_SECONDS + 1 && s.overboard; t += 1 / 30) stepCrewOverboard(boat, s, 1 / 30);
  assert.equal(s.overboard, null, 'hauled back aboard');
  assert.equal(s.casualtyState, 'wounded');
  assert.equal(c.killed, 0);
  assert.equal(c.wounded, 1);
  assert.ok(boat.events.some((e) => e.type === 'hauled-aboard'));
});

test('leave him and he drowns, and is gone from sight', () => {
  const boat = ship(), s = hand();
  sendCrewOverboard(boat, s, { side: 1, outward: 4 });
  boat.surgeVelocity = 4;
  for (let t = 0; t < OVERBOARD_DROWN_SECONDS + 5; t += 0.1) stepCrewOverboard(boat, s, 0.1);
  assert.equal(s.overboard.alive, false);
  assert.ok(boat.events.some((e) => e.type === 'drowned'));
  for (let t = 0; t < 120 && !s.overboard.gone; t += 0.1) stepCrewOverboard(boat, s, 0.1);
  assert.equal(s.overboard.gone, true);
  assert.equal(s.visible, false);
  const out = OVERBOARD_RESCUE_RANGE_M;
  assert.ok(out > 0);
});

test('a blast at the rail puts a sailor over through the normal crew step, and a new crew is whole again', () => {
  const boat = ship(), company = createCompany(undefined, 'nina');
  boat.crewCompany = company;
  stepCompany(company, boat, 1 / 30, 5);
  const s = company.crew.find((m) => m.visible && m.position);
  assert.ok(s, 'someone is drawn on deck');
  s.x = 1.2;
  s.knockbackVx = 9;
  s.knockbackVz = 0;
  for (let i = 0; i < 20 && !s.overboard; i++) stepCompany(company, boat, 1 / 30, 5);
  assert.ok(s.overboard, 'over he goes');
  for (let i = 0; i < 60; i++) stepCompany(company, boat, 1 / 30, 5);
  for (const v of s.position) assert.ok(Number.isFinite(v));
  assert.ok(Math.abs(s.position[0]) > 3.2, 'he is out beyond her side');
  assert.deepEqual([...s.transform.subarray(12, 15)].map((v) => +v.toFixed(3)), [...s.position].map((v) => +v.toFixed(3)), 'and is drawn where he is, not left on deck');
  reviveCompany(company);
  assert.equal(s.overboard, null);
  assert.equal(s.casualtyState, 'able');
});

test('a gale knocks hands down to leeward, and only a gale', () => {
  const boat = ship(), company = createCompany(undefined, 'nina');
  stepCompany(company, boat, 1 / 30, 5);
  boat.roll = 0.5; // Larboard low.
  let downed = 0;
  for (let t = 0; t < 300; t++) {
    stepGaleKnockdowns(boat, company, 32, 1);
    for (const s of company.crew) if (s.knockdownTimer > 0) { assert.ok(s.knockbackVx < 0, 'toward the low side'); downed++; s.knockdownTimer = 0; }
  }
  assert.ok(downed > 0, 'some go down');
  const calm = ship(), quiet = createCompany(undefined, 'nina');
  stepCompany(quiet, calm, 1 / 30, 5);
  for (let t = 0; t < 2000; t++) stepGaleKnockdowns(calm, quiet, 12, 1);
  assert.ok(quiet.crew.every((s) => !(s.knockdownTimer > 0)), 'fair weather has no such risk');
});

test('a man in the water makes away from her on his own side and faces the way he swims, whatever her heading', () => {
  for (const heading of [0, 90, -45, 180, 270]) for (const side of [1, -1]) {
    const boat = ship(), s = hand([side * 2.5, 1.5, 0]);
    boat.heading = heading;
    sendCrewOverboard(boat, s, { side, outward: 0.45, cause: 'sinking', awash: true });
    stepCrewOverboard(boat, s, 1 / 30);
    const yaw = heading * Math.PI / 180, outward = [0, 0, 0], facing = [0, 0, 0];
    boatRotate(outward, side, 0, 0, yaw, 0, 0);
    // He is drawn in her frame, so that is where his facing is kept.
    boatRotate(facing, Math.sin(s.yaw), 0, Math.cos(s.yaw), yaw, 0, 0);
    const swim = [Math.sin(s.overboard.swimYaw), Math.cos(s.overboard.swimYaw)];
    const away = swim[0] * outward[0] + swim[1] * outward[2], ahead = facing[0] * swim[0] + facing[2] * swim[1];
    assert.ok(away > 0.4, `heading ${heading}, side ${side}: he swims away from her, not into her: ${away.toFixed(2)}`);
    assert.ok(ahead > 0.98, `heading ${heading}, side ${side}: and looks where he is going: ${ahead.toFixed(2)}`);
  }
});

test('he meets the sea where it stands under him, on a crest or in a trough, and does not jump as he goes in', () => {
  for (const sea of [1.4, -1.4]) {
    const boat = ship(), s = hand();
    boat.target = { heave: sea, pitch: 0, roll: 0 };
    boat.heave = sea;
    sendCrewOverboard(boat, s, { side: 1, outward: 4 });
    let before = null;
    for (let i = 0; i < 400 && !s.overboard.inWater; i++) {
      before = s.overboard.y;
      stepCrewOverboard(boat, s, 1 / 60);
    }
    assert.ok(s.overboard.inWater, 'he reaches the water');
    // She is level and heading north, so her own height and his in her frame make his height in the world.
    const drawn = boat.heave + s.position[1];
    assert.ok(Math.abs(drawn - before) < 0.25, `sea at ${sea}: falling at ${before.toFixed(2)}, then drawn at ${drawn.toFixed(2)}`);
    assert.ok(Math.abs(drawn - sea) < 0.3, 'and that is at the surface');
  }
});

test('a swimmer thrown up by a shot leaves the water where he lay in it, and falls back into it', () => {
  const boat = ship(), s = hand();
  boat.target = { heave: 1.4, pitch: 0, roll: 0 };
  boat.heave = 1.4;
  sendCrewOverboard(boat, s, { side: 1, outward: 0.45, awash: true });
  stepCrewOverboard(boat, s, 1 / 60);
  const height = () => boat.heave + s.position[1], lying = height();
  // As a ball or its splash throws him, in js/gunnery-control.js.
  Object.assign(s.overboard, { inWater: false, alive: false, vx: 0, vy: 3, vz: 0 });
  stepCrewOverboard(boat, s, 1 / 60);
  assert.ok(Math.abs(height() - lying) < 0.12, `he rises from the surface, not from somewhere else: ${lying.toFixed(2)} then ${height().toFixed(2)}`);
  let peak = height();
  for (let i = 0; i < 600 && !s.overboard.inWater; i++) {
    stepCrewOverboard(boat, s, 1 / 60);
    peak = Math.max(peak, height());
  }
  assert.ok(s.overboard.inWater, 'he comes down');
  assert.ok(peak - lying > 0.3 && peak - lying < 0.7, `having gone up as far as he was thrown: ${(peak - lying).toFixed(2)}`);
  assert.ok(Math.abs(height() - lying) < 0.25, 'and lies in the same sea again');
});

test('the sea under a swimmer is the sea where he is, as far as she can tell it', () => {
  const boat = ship();
  boat.target = { heave: 0.5, pitch: 0, roll: 0 };
  boat.waveSlopeX = 0.1;
  boat.waveSlopeZ = 0;
  assert.ok(Math.abs(overboard.overboardSeaLevel(boat, 10, 0) - 1.5) < 1e-9, 'up the slope');
  assert.ok(Math.abs(overboard.overboardSeaLevel(boat, -10, 3) + 0.5) < 1e-9, 'and down it');
  assert.equal(overboard.overboardSeaLevel(boat, 400, 0), 0.5, 'far off she knows only the reading under her');
  let last = overboard.overboardSeaLevel(boat, 0, 0);
  for (let x = 0.5; x <= 80; x += 0.5) {
    const now = overboard.overboardSeaLevel(boat, x, 0);
    assert.ok(Math.abs(now - last) < 0.2, `no step in the sea at ${x} m`);
    last = now;
  }
  // Two men, one either side of her, ride the water each is in.
  const high = hand([2.5, 1.5, 0]), low = hand([-2.5, 1.5, 0]);
  sendCrewOverboard(boat, high, { side: 1, outward: 0.45, awash: true });
  sendCrewOverboard(boat, low, { side: -1, outward: 0.45, awash: true });
  high.overboard.x = 10; low.overboard.x = -10;
  stepCrewOverboard(boat, high, 1 / 30);
  stepCrewOverboard(boat, low, 1 / 30);
  assert.ok(high.position[1] - low.position[1] > 1.7, `two metres of sea between them: ${(high.position[1] - low.position[1]).toFixed(2)}`);
});

test('a flooded hull lying to the swell loses only the hands the sea has reached', () => {
  for (const tilt of [0.2, -0.2]) {
    const boat = ship(), company = createCompany(undefined, 'nina');
    boat.crewCompany = company;
    boat.target = { heave: 0, pitch: 0, roll: 0 };
    stepCompany(company, boat, 1 / 30, 5);
    boat.damage.floodingSinkage = 0.6;
    // Settled until her lowest hand's feet are a hand's breadth clear of a level sea.
    boat.heave = 0.1 - Math.min(...company.crew.filter((s) => s.visible && s.position).map((s) => s.position[1]));
    stepCompany(company, boat, 1 / 30, 5);
    assert.ok(!company.crew.some((s) => s.overboard), 'level and dry, nobody is taken');
    // A long swell tilts the sea and she lies to it, so each end rises and falls with the water under it.
    boat.waveSlopeZ = -tilt;
    boat.pitch = Math.atan(tilt);
    for (let i = 0; i < 5; i++) stepCompany(company, boat, 1 / 30, 5);
    assert.deepEqual(company.crew.filter((s) => s.overboard).map((s) => s.name), [], `tilt ${tilt}: her low end is as dry as her middle`);
    // Then the sea comes over her.
    boat.target.heave = 1.5;
    for (let i = 0; i < 5; i++) stepCompany(company, boat, 1 / 30, 5);
    assert.ok(company.crew.some((s) => s.overboard?.cause === 'sinking'), 'and takes whoever it reaches');
  }
});

test('whether the sea is over a hand\'s feet is judged where he stands', () => {
  const boat = ship();
  boat.target = { heave: 0, pitch: 0, roll: 0 };
  boat.waveSlopeZ = -0.1;
  boat.pitch = Math.atan(0.1);
  const forward = { position: [0, 0.3, 8] }, aft = { position: [0, 0.3, -8] }, waist = { position: [0, -0.3, 0] };
  assert.equal(overboard.crewFeetAwash(boat, forward), false, 'her low end, with the sea as low under it');
  assert.equal(overboard.crewFeetAwash(boat, aft), false, 'her high end');
  assert.equal(overboard.crewFeetAwash(boat, waist), true, 'a hand whose deck is under');
});

test('at full warp a gale simply costs a hand', () => {
  const boat = ship(), company = createCompany(undefined, 'nina'), c = boat.damage.crewCasualties, able = c.able;
  stepCompany(company, boat, 1 / 30, 5);
  const lost = loseHandInGale(boat, company, () => 0);
  assert.ok(lost);
  assert.equal(c.able, able - 1);
  assert.equal(lost.sailor.visible, false);
});

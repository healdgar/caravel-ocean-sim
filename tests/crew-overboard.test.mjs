// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Bodies that clear the rail leave the ship, and the sea decides the rest.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { createCompany, stepCompany, reviveCompany } from '../js/crew.js';
import { crewClearsRail, sendCrewOverboard, stepCrewOverboard, stepGaleKnockdowns, loseHandInGale, OVERBOARD_DROWN_SECONDS, OVERBOARD_RESCUE_SECONDS, OVERBOARD_RESCUE_RANGE_M } from '../js/crew-overboard.js';
import { createVesselDamageState } from '../js/gunnery-control.js';
import { boatHydrodynamics } from '../js/boat.js';

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

test('at full warp a gale simply costs a hand', () => {
  const boat = ship(), company = createCompany(undefined, 'nina'), c = boat.damage.crewCasualties, able = c.able;
  stepCompany(company, boat, 1 / 30, 5);
  const lost = loseHandInGale(boat, company, () => 0);
  assert.ok(lost);
  assert.equal(c.able, able - 1);
  assert.equal(lost.sailor.visible, false);
});

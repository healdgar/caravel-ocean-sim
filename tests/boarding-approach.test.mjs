// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// A boarding party ordered to the rail while the chase is still out of reach must stand down when
// there is no longer anyone to board, and the fight's log must stay the length the panel shows.
import assert from 'node:assert/strict';
import test from 'node:test';
import { BOARDING_APPROACH_STALL_S, MOORING_SHIP_REACH_M, createDockingBoardingState } from '../js/boarding-docking.js';
import { createCompany } from '../js/crew.js';
import { boatHydrodynamics } from '../js/boat.js';
import { createVesselDamageState } from '../js/gunnery-control.js';

function hull(id, x, extra = {}) {
  const boat = { id, modelId: 'nina', name: id, shipName: id, length: 20, beam: 6, heading: 0, x, z: 0, heave: 0, pitch: 0, roll: 0, propulsion: 'sail', colors: 'portugal', showProw: true, ...extra };
  boat.hydrodynamics = boatHydrodynamics(20, 6);
  createVesselDamageState(boat);
  return boat;
}
function approach(range = 200) {
  const player = hull('Santa Clara', 0);
  const company = createCompany(undefined, 'nina', { boat: player });
  const chaseBoat = hull('Black Adder', range, { colors: 'jolly-roger', battleColors: 'jolly-roger', faction: 'enemy' });
  const chase = { boat: chaseBoat, company: createCompany(undefined, 'nina', { boat: chaseBoat }), faction: 'enemy', currentEncounter: { id: 'first' } };
  const events = [];
  const db = createDockingBoardingState(player, { company, getAdditionalVessels: () => [chase], onEvent: (ev) => events.push(ev.type) });
  const ordered = db.boardVessel(chase);
  assert.equal(ordered.approaching, true, 'out of reach, the party goes to the rail and waits');
  assert.equal(db.state.boardingPhase, 'approaching');
  assert.equal(player.boardingActive, true);
  const atRail = () => company.crew.filter((s) => s.job?.kind === 'boarding').length;
  assert.ok(atRail() > 0, 'hands are at the rail');
  const run = (seconds, dt = 0.25) => { for (let t = 0; t < seconds; t += dt) db.step(dt); };
  const stoodDown = (why) => {
    assert.equal(db.state.boardingPhase, 'none', why);
    assert.equal(player.boardingActive, false, 'the ship is no longer boarding');
    assert.equal(atRail(), 0, 'and the hands have left the rail');
    assert.equal(db.state.targetVessel, null, 'with no target kept to board later by accident');
    assert.equal(events.filter((type) => type === 'boarding-abandoned').length, 1, 'said once');
  };
  return { player, chase, chaseBoat, db, events, run, stoodDown };
}

test('the party stands down when the chase sinks', () => {
  const { chaseBoat, db, run, stoodDown } = approach();
  run(2);
  assert.equal(db.state.boardingPhase, 'approaching');
  chaseBoat.damage.sunk = true;
  run(1);
  stoodDown('nobody boards a ship that has gone down');
  assert.match(db.state.statusText, /Black Adder has gone down/);
});

test('the party stands down when the chase leaves the sea or her hull comes back as another ship', () => {
  const gone = approach();
  gone.chaseBoat.showProw = false;
  gone.run(1);
  gone.stoodDown('a hull that has left the sea is not boarded');

  const reused = approach();
  // The pooled hull is given to the next encounter and placed close aboard.
  reused.chase.currentEncounter = { id: 'second' };
  reused.chaseBoat.x = 20;
  reused.run(1);
  reused.stoodDown('the order was for the first ship, not whoever has her hull now');
  assert.notEqual(reused.db.state.mooringPhase, 'throwing-lines', 'no irons are thrown at the newcomer');

  const vanished = approach();
  vanished.chase.boat = null;
  vanished.run(1);
  vanished.stoodDown('a target with no hull at all cannot hold the party at the rail');
});

test('the party waits while the range is closing and stands down once it has stopped closing', () => {
  const closing = approach(400);
  // Gaining two metres a second: slower than the stall limit would allow if it were a plain timeout.
  for (let t = 0; t < BOARDING_APPROACH_STALL_S * 2 && closing.db.state.boardingPhase === 'approaching'; t += 0.25) {
    closing.chaseBoat.x -= 0.5;
    closing.db.step(0.25);
  }
  assert.equal(closing.db.state.boardingPhase, 'approaching', 'a chase still being gained on is still chased');

  const holding = approach(400);
  holding.run(BOARDING_APPROACH_STALL_S - 2);
  assert.equal(holding.db.state.boardingPhase, 'approaching', 'she is given time');
  holding.run(4);
  holding.stoodDown('but not for ever');
  assert.match(holding.db.state.statusText, /holding her distance/);
});

test('the irons go over once she is truly in reach', () => {
  const { chaseBoat, db, run, events } = approach();
  chaseBoat.x = MOORING_SHIP_REACH_M - 4;
  run(0.5);
  assert.notEqual(db.state.boardingPhase, 'approaching');
  assert.notEqual(db.state.boardingPhase, 'none');
  assert.equal(events.includes('boarding-abandoned'), false);
});

test('repeating the order and a long fight leave the log no longer than the panel', () => {
  const { chase, db } = approach();
  const first = db.state.combatLog.length;
  for (let i = 0; i < 40; i++) db.boardVessel(chase);
  assert.equal(db.state.combatLog.length, first, 'the same order for the same chase is logged once');
  for (let i = 0; i < 40; i++) {
    db.boardVessel({ ...chase, boat: { ...chase.boat } }); // forty different chases
  }
  assert.ok(db.state.combatLog.length <= 12, `log holds ${db.state.combatLog.length} lines`);
});

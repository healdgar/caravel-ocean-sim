// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Every sailor stands on real deck, clear of what is drawn, and does what the station is for. The audit's known list
// (tests/model-audit.test.mjs) holds each ship at the watch's second second. These go further: through a long watch,
// through the whole stroke, at either rudder, and with the guns manned.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { loadAuditModules, loadCrewMeshes } from '../scripts/model-audit.mjs';
import { auditCrewBodies, crewBodiesOf, floorUnder, loadShip, SHIP_IDS, standingAt } from '../scripts/model-audit-lib.mjs';
import { crewHelmHands } from '../js/crew-work.js';
import { rowingStationPose } from '../js/rowing.js';
import { ROWING_DESIGNS } from '../js/models/rowing.js';
import { advanceSails, sailingState } from '../js/sailing.js';
import { issueCaptainOrder } from '../js/crew.js';
import { createGunDefinitions, gunMuzzlePose } from '../js/gunnery-models.js';
import { createGunneryState, gunnerySummary, prepareGunnery, stepGunnery } from '../js/gunnery-state.js';

const lib = await loadAuditModules(), meshes = loadCrewMeshes(lib);
const through = (b) => b.rows.filter((r) => r.edges >= 6 && r.deepest > 0.08).map((r) => `${r.key}${r.job ? ` (${r.job}/${r.stage})` : ''} through ${r.part} ${r.deepest.toFixed(2)}`);
const ROWED = Object.keys(ROWING_DESIGNS);
const watchBoat = (ship, extra = {}) => ship.boat({ rudder: 0, rollVelocity: 0, sailFore: 1, sailMain: 1, sailMizzen: 1, crew: false, hatchesClosed: 0, ...extra });

// The audit's own reference. It once called sailors afloat for standing on a seam between planks.
test('a plank seam is no hole under a boot, and open water is', () => {
  const victory = loadShip('victory'), y = 8.04, x = 0.52 * victory.scale[0], z = 3.7 * victory.scale[2];
  assert.ok(y - floorUnder(victory, x, y + 0.5, z).y > 2.5, 'one line at this point does fall through the seam to the deck below');
  assert.ok(Math.abs(standingAt(victory, x, y, z).floorGap) < 0.1, 'but a boot is on the deck');
  // Flying Cloud's bow pair as they were, 1.56 m out where her hull is 1.39 m wide.
  const cloud = standingAt(loadShip('flying-cloud'), 1.56, 5.12, -29.15);
  assert.equal(cloud.floorGap, null, 'over the sea');
  assert.equal(cloud.enclosed, false, 'with no hull on that side');
});

// Every six seconds of two minutes: a station's round can walk a hand into what the station itself is clear of.
test('nobody stands or walks a round in anything through a long watch', { timeout: 300000 }, () => {
  const faults = [];
  for (const id of SHIP_IDS) {
    const ship = loadShip(id), boat = watchBoat(ship), company = lib.createCompany(undefined, id, { fullWatch: true });
    if (ship.model.geometry === 'rowing-procedural-v1') boat.rowingState = { phase: 0.22, rate: 0.45, effortPort: 0.6, effortStarboard: 0.6, cadence: 0.45 };
    for (let at = 0; at < 20; at++) {
      for (let k = 0; k < 60; k++) lib.stepCompany(company, boat, 0.1, 2);
      // A hand sent on a job climbs real stairs and shrouds. Those are walked, not stood in.
      faults.push(...through(crewBodiesOf(ship, lib, meshes, company, boat, { everyNth: 4 })).filter((row) => !row.includes('(')).map((row) => `${id} at ${6 * at + 6} s: ${row}`));
    }
  }
  assert.deepEqual(faults, []);
});

test('every rower and paddler sits on the bench with boots on the floor, all through the stroke', { timeout: 200000 }, () => {
  const faults = [];
  for (const id of ROWED) for (const rowingPhase of [0, 0.08, 0.22, 0.3, 0.44, 0.6, 0.75, 0.88]) {
    const b = auditCrewBodies(loadShip(id), lib, meshes, { everyNth: 4, rowingPhase });
    faults.push(...through(b).map((row) => `${id} phase ${rowingPhase}: ${row}`));
    if (b.soleSunk) faults.push(`${id} phase ${rowingPhase}: ${b.soleSunk} sunk ${b.soleSunkMaxM}`);
  }
  assert.deepEqual(faults, []);
});

test('the seated pose leaves the oars and paddles where the water wants them', () => {
  for (const id of ROWED) {
    const d = ROWING_DESIGNS[id], boat = { modelId: id, ...d.runtime, rudder: 0, rowingState: { phase: 0, rate: 0.45, effortPort: 1, effortStarboard: 1, cadence: 0.45 } };
    for (const station of d.stations) {
      // The blade is in the water through the drive and out of it on the recovery.
      const drive = rowingStationPose(boat, station.id, { phase: d.propulsion.driveFraction * 0.5 });
      const recovery = rowingStationPose(boat, station.id, { phase: d.propulsion.driveFraction + (1 - d.propulsion.driveFraction) * 0.5 });
      assert.ok(drive.bladeCentre[1] < 0, `${id} ${station.id} blade under at the drive: ${drive.bladeCentre[1]}`);
      assert.ok(recovery.bladeCentre[1] > 0, `${id} ${station.id} blade clear on the recovery: ${recovery.bladeCentre[1]}`);
      // And a seat a thigh below the shoulder's reach of the grips, bow to stern.
      for (const hand of [...drive.hands, ...recovery.hands]) assert.ok(hand[1] > drive.seat[1] + 0.05, `${id} ${station.id} grip above the bench`);
    }
  }
});

test('a helmsman stands at his wheel or tiller, facing forward, hands on it', () => {
  for (const id of ['nina', 'pinta', 'santa-maria', 'victory', 'flying-cloud', 'gipsy-moth-iv']) {
    const ship = loadShip(id), boat = watchBoat(ship), company = lib.createCompany(undefined, id, { fullWatch: true });
    for (const rudder of [0, 12, -12]) {
      boat.rudder = rudder;
      lib.stepCompany(company, boat, 0.05, 2);
      const s = company.crew.find((c) => c.role === 'Helmsman' || c.roles?.includes('helmsman'));
      const mesh = meshes[s.sex], a = mesh.animator;
      a.sample('Idle', s.time, 'Walk', s.walkTime, s.walk);
      lib.poseCrewWork(a, s, boat);
      lib.applyCrewRealism(a, s, boat, 1 / 60);
      const world = (p) => [0, 1, 2].map((c) => s.transform[c] * p[0] + s.transform[c + 4] * p[1] + s.transform[c + 8] * p[2] + s.transform[c + 12]);
      const hands = crewHelmHands(boat);
      for (const [i, side] of ['l', 'r'].entries()) {
        const wrist = world(a.world[a.nodeIndex(`hand_${side}`)].subarray(12, 15));
        assert.ok(Math.hypot(...wrist.map((v, k) => v - hands[i][k])) < 0.09, `${id} ${side} hand at its grip, rudder ${rudder}`);
        if (rudder) continue; // The audit's mesh holds the helm amidships.
        const near = ship.index.nearest(wrist, 0xff, 0.4, (t) => !/^helm\./.test(ship.groupId(t)));
        assert.ok(near && near.distance < 0.16, `${id} ${side} wrist ${near?.distance} from the helm itself`);
      }
      // Bow is toward -z. Leave room for the turn in toward a tiller at his side, and for a yacht's bench.
      const off = Math.abs(Math.atan2(Math.sin(s.yaw - Math.PI), Math.cos(s.yaw - Math.PI)));
      if (!rudder) assert.ok(off < (id === 'gipsy-moth-iv' ? 1.4 : 0.5), `${id} faces forward: ${s.yaw}`);
    }
  }
});

// From the stations that moved: nobody is walled in, and no drill walks a hand back through what they left.
function drill(id, side) {
  const ship = loadShip(id), boat = watchBoat(ship, { x: 0, z: 0 }), company = lib.createCompany(undefined, id, { fullWatch: true });
  lib.stepCompany(company, boat, 0, 8);
  boat.gunnery = createGunneryState(createGunDefinitions(boat));
  boat.gunnerySide = side;
  prepareGunnery(boat.gunnery, side);
  const environment = { muzzle: (g) => gunMuzzlePose(g, boat), gunAttended: (g) => !g.visibleCrew || boat.gunneryAttendance?.has(g.id) };
  return { ship, boat, company, step() { lib.stepCompany(company, boat, 0.1, 8); stepGunnery(boat.gunnery, 0.1, environment); } };
}

test('the full watch mans the guns from its new stations, stands clear at them, and goes home', { timeout: 200000 }, () => {
  for (const [id, expected] of [['victory', 4], ['nina', 2], ['santa-maria', 2]]) for (const side of ['port', 'starboard']) {
    const { ship, boat, company, step } = drill(id, side);
    for (let i = 0; i < 2400; i++) step();
    const summary = gunnerySummary(boat.gunnery, side);
    assert.equal(summary.ready, summary.total, `${id} ${side} finishes the drill`);
    assert.equal(boat.gunneryAttendance.size, expected, `${id} ${side} attended`);
    const gunners = crewBodiesOf(ship, lib, meshes, company, boat, { everyNth: 4 }).rows.filter((r) => r.job === 'gunnery');
    assert.equal(gunners.length, expected * 2);
    // Gun crews are at their own gun: its barrel and carriage are theirs to touch. Anything else is a fault.
    assert.deepEqual(gunners.filter((r) => r.edges >= 6 && r.deepest > 0.08 && !/^gun/.test(r.part)).map((r) => `${r.key} through ${r.part} ${r.deepest}`), [], `${id} ${side} at the guns`);
    // Stood down, every gunner walks home and stands clear there.
    boat.gunnerySide = null;
    const gunning = () => company.crew.filter((s) => s.job?.kind === 'gunnery');
    for (let i = 0; i < 1800 && gunning().length; i++) step();
    assert.deepEqual(gunning().map((s) => `${s.stationKey} ${s.job.stage}`), [], `${id} ${side} stood down`);
    assert.deepEqual(through(crewBodiesOf(ship, lib, meshes, company, boat, { everyNth: 4 })).filter((row) => !row.includes('(')), [], `${id} ${side} home again`);
  }
});

test('the full watch still works the sails from its new stations', { timeout: 200000 }, () => {
  for (const id of ['nina', 'victory', 'santa-maria', 'pinta', 'flying-cloud']) {
    const ship = loadShip(id), boat = watchBoat(ship), company = lib.createCompany(undefined, id, { fullWatch: true });
    sailingState(boat);
    lib.stepCompany(company, boat, 0, 3);
    assert.equal(issueCaptainOrder(company, boat, 'reduced'), true);
    let done = false;
    for (let i = 0; i < 6000 && !done; i++) {
      advanceSails(boat, 0.1, 3, 0);
      lib.stepCompany(company, boat, 0.1, 3);
      done = !company.pending && !company.crew.some((s) => s.job);
    }
    assert.ok(done, `${id} hands finish and return: ${company.crew.filter((s) => s.job).map((s) => `${s.stationKey} ${s.job.kind}/${s.job.stage}`).join(', ')}`);
  }
});

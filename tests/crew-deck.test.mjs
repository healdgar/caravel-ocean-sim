// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The deck a body may leave his route onto is the deck that is drawn. If this fails because a ship's mesh changed, run
// node scripts/bake-crew-deck.mjs, and look at what it now says before believing it.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { bakeCrewDeckMask } from '../scripts/bake-crew-deck.mjs';
import { loadShip, SHIP_IDS, standingAt } from '../scripts/model-audit-lib.mjs';
import { CREW_DECK_BODY_M, crewDeckClearance, crewDeckDecode, crewDeckEncode, crewDeckField, crewDeckFloor, crewDeckLineRoom, crewDeckRoom } from '../js/crew-deck.js';
import { CREW_DECK_MASKS } from '../js/models/crew-deck-masks.js';
import { crewNavigationClear, crewNavigationObstacles } from '../js/crew-navigation.js';
import { modelDeck, modelDeckWidth, vesselHull } from '../js/hull.js';
import { getShipModel } from '../js/ship-models.js';
import { applyFractureEvents, shipFractureStateOf } from '../js/ship-fracture.js';
import { createShipAssetCache } from '../js/ship-mesh.js';
import { createVesselDamageState } from '../js/gunnery-control.js';

const boatOf = (id) => { const model = getShipModel(id); return { modelId: id, model, ...model.runtime, x: 0, z: 0, heading: 0, pitch: 0, roll: 0, heave: 0 }; };

test('the run lengths hold exactly what was put in', () => {
  const open = new Uint8Array(4000);
  for (let i = 0; i < 4000; i++) open[i] = (i * i >> 7) % 3 === 0 ? 1 : 0;
  assert.deepEqual(crewDeckDecode(crewDeckEncode(open), open.length), open);
  assert.deepEqual(crewDeckDecode(crewDeckEncode(new Uint8Array(70000)), 70000), new Uint8Array(70000));
});

test('every ship has a mask, and it is what her mesh says now', { timeout: 300000 }, () => {
  for (const id of SHIP_IDS) {
    const mask = CREW_DECK_MASKS[id];
    assert.ok(mask, id);
    const fresh = bakeCrewDeckMask(id), stored = crewDeckDecode(mask.runs, mask.nx * mask.nz);
    assert.equal(mask.nx * mask.nz, fresh.open.length, `${id} grid`);
    let differ = 0, open = 0;
    for (let i = 0; i < stored.length; i++) { if (stored[i] !== fresh.open[i]) differ++; if (fresh.open[i]) open++; }
    assert.ok(differ <= open * 0.015, `${id}: ${differ} of ${open} open cells differ from the mesh. Run node scripts/bake-crew-deck.mjs`);
  }
});

// MODEL_AUDIT.md item 23: walk grids through deckhouses, bulkheads, stairs and wheels. The field knows better.
test('nowhere the audit finds a walk cell inside something solid can a body sidestep to', { timeout: 300000 }, () => {
  for (const id of ['flying-cloud', 'gipsy-moth-iv', 'victory', 'nina', 'santa-maria']) {
    const ship = loadShip(id), boat = ship.boat(), s = ship.scale, field = crewDeckField(boat), bounds = vesselHull(boat).bounds ?? [-6, 6];
    let solid = 0, admitted = 0, worst = null;
    for (let Z = bounds[0] * s[2]; Z <= bounds[1] * s[2]; Z += 0.4) {
      const half = modelDeckWidth(boat, Z / s[2]) * s[0];
      if (!(half > 0)) continue;
      for (let X = -half; X <= half; X += 0.4) {
        const y = crewDeckFloor(boat, Z / s[2], X / s[0]) * s[1];
        if (!Number.isFinite(y) || !crewNavigationClear([X, y, Z], boat)) continue;
        const at = standingAt(ship, X, y, Z);
        // Inside what is drawn from the knee up, by more than the half cell either way the grid can be out.
        if (at.chest > 0.02 && at.knee > 0.02) continue;
        solid++;
        if (crewDeckClearance(field, X, Z) >= CREW_DECK_BODY_M) { admitted++; worst = [X, Z, at.chestPart, at.kneePart]; }
      }
    }
    assert.equal(admitted, 0, `${id}: ${admitted} of ${solid} such cells have room in the field, as at ${worst}`);
  }
});

test('the guns keep their recoil and the masts their footing, and the rail its edge', () => {
  for (const id of ['nina', 'victory', 'santa-maria']) {
    const boat = boatOf(id), field = crewDeckField(boat), obstacles = crewNavigationObstacles(boat);
    for (const o of obstacles) {
      const x = (o.min[0] + o.max[0]) / 2, z = (o.min[2] + o.max[2]) / 2, floor = crewDeckFloor(boat, z / (boat.length / 12), x / (boat.beam / 3.6));
      if (o.max[1] < floor * 1.9 || o.min[1] > floor * 2 + 1.7) continue;
      assert.ok(crewDeckClearance(field, x, z) < CREW_DECK_BODY_M, `${id} ${o.id} is no place to stand`);
    }
    assert.equal(crewDeckClearance(field, boat.beam, 0), 0, `${id} past the side there is nothing`);
    assert.equal(crewDeckClearance(field, 0, boat.length), 0, `${id} past the end of her there is nothing`);
    assert.ok(crewDeckLineRoom(field, boat, boat.beam * 0.1, 0, boat.beam, 0) === 0, `${id} a line over the side finds no room`);
  }
});

test('with her rail shot away the deck she leaves a body is that much narrower, on that side and at that station only', () => {
  const boat = boatOf('nina'), cache = createShipAssetCache(), { fracture } = cache.get('nina'), sx = boat.beam / 3.6, sz = boat.length / 12, field = crewDeckField(boat);
  boat.hydrodynamics = { sinkage: 0 };
  createVesselDamageState(boat);
  const x = (modelDeckWidth(boat, 0) * sx) - 0.7, intact = crewDeckRoom(field, boat, x, 0);
  assert.ok(intact > 0.5, `room beside the rail while she has it: ${intact}`);
  const events = [];
  for (const shard of fracture.strikable) {
    const [px, py, pz] = fracture.shards[shard].centroid;
    if (px > 0 && pz >= -0.5 && pz <= 0.5 && py > modelDeck(boat, pz) - 0.2) events.push({ x: px, y: py, z: pz, side: 1, severity: 2, stepDepth: 0.4 });
  }
  for (let pass = 0; pass < 3; pass++) applyFractureEvents(fracture, boat.damage, events, 0);
  shipFractureStateOf(boat.damage, fracture);
  assert.ok(crewDeckRoom(field, boat, x, 0) < intact - 0.2, 'less of it is his now');
  assert.ok(crewDeckRoom(field, boat, -x, 0) > 0.3, 'the other side still has hers');
  assert.ok(crewDeckRoom(field, boat, x, 3 * sz) === crewDeckClearance(field, x, 3 * sz), 'nor does it reach down the ship');
});

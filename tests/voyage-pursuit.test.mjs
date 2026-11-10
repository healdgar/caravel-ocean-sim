// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Inside battle range the game sails both hulls. The voyage controller must not haul the chase
// alongside because the player happens to be still: aground, moored or hove to.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createVoyageController } from '../js/voyage/voyage-controller.js';

function chase({ closeHullsInPursuit, mode }) {
  const boat = { x: 0, z: 0, heading: 270, length: 20, surgeVelocity: 0, leewayVelocity: 0, modelId: 'nina' };
  const target = { x: 0, z: 0, heading: 180, length: 20, surgeVelocity: 0, leewayVelocity: 0, showProw: true, damage: { hullIntegrity: 1 } };
  const P = { windSpeed: 8, windDir: 135, swellHs: 1, swellDir: 0, swellLength: 80, clouds: 0.3, rain: 0, thunder: 0, haze: 1 };
  const events = { battleRange: 0, boarded: 0, hailed: 0 };
  const ctrl = createVoyageController({
    boat, P,
    getVessels: () => [boat, target],
    closeHullsInPursuit,
    // The strange sail is sighted 520 m off; the chase under warp brings her to battle range (235 m).
    onSightVessel: (enc) => {
      const bearing = (enc.bearingDeg * Math.PI) / 180;
      target.x = boat.x + Math.sin(bearing) * 520;
      target.z = boat.z - Math.cos(bearing) * 520;
    },
    onEnterBattleRange: () => { events.battleRange++; },
    onBoardVessel: () => { events.boarded++; },
    onHailVessel: () => { events.hailed++; },
    loadLandRings: () => Promise.resolve([]),
    loadTile: () => Promise.resolve(null),
  });
  ctrl.start({ lat: 32, lon: -24 });
  assert.ok(ctrl.triggerSailEncounter(), 'a strange sail is sighted');
  ctrl.resolveInterrupt(mode);
  assert.equal(ctrl.pursuit.active, true);
  const range = () => Math.hypot(target.x - boat.x, target.z - boat.z);
  let frame = 0;
  const run = (frames) => { for (let i = 0; i < frames; i++) ctrl.update(0.1, frame++ * 100); };
  const setRange = (metres) => { const scale = metres / range(); target.x *= scale; target.z *= scale; };
  for (let i = 0; i < 80 && !events.battleRange; i++) run(1);
  assert.equal(events.battleRange, 1, 'the chase reaches battle range and time returns to the deck watch');
  assert.equal(ctrl.voyage.rate, 1);
  return { boat, target, ctrl, events, range, run, setRange };
}

test('a still player does not have her chase hauled alongside and boarded', () => {
  const { events, range, run, setRange } = chase({ mode: 'board' });
  const held = range();
  run(200); // twenty seconds with the player not moving a metre
  assert.ok(Math.abs(range() - held) < 0.01, `the chase lies where her own sailing left her (${held.toFixed(1)} m, now ${range().toFixed(1)} m)`);
  assert.equal(events.boarded, 0, 'and nobody boards across 200 m of water');
  assert.ok(held > 200, `she lies ${held.toFixed(0)} m off`);

  // 40 m is inside the 46 m reach the controller allows itself when it closes the hulls, outside the real 24 m.
  setRange(40);
  run(20);
  assert.equal(events.boarded, 0, 'no boarding at 40 m');
  assert.ok(Math.abs(range() - 40) < 0.01);
  setRange(20);
  run(2);
  assert.equal(events.boarded, 1, 'she boards once the hulls have truly closed inside grappling reach');
});

test('a still player does not have a ship she hails dragged into speaking range', () => {
  const { range, run } = chase({ mode: 'hail' });
  const held = range();
  run(200);
  assert.ok(Math.abs(range() - held) < 0.01, `the stranger keeps her distance (${held.toFixed(1)} m, now ${range().toFixed(1)} m)`);
});

test('a caller that sails no hulls and says so has the range closed for it', () => {
  const { events, range, run } = chase({ mode: 'board', closeHullsInPursuit: true });
  run(200);
  assert.equal(events.boarded, 1);
  assert.ok(range() <= 46.5, `closed to ${range().toFixed(1)} m`);
});

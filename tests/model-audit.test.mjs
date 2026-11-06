// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Hand-written numbers drift from the models they describe. This holds every ship and building to the numbers it
// measures today: nothing new may go past its limit, and nothing already past it may get worse. MODEL_AUDIT.md says
// what each known fault is. A fix shows as a stale entry: rerun `node scripts/model-audit.mjs --write-known`.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { KNOWN_FLAGS, loadAuditModules, runAudit } from '../scripts/model-audit.mjs';
import { auditMasts, auditShipCollision, FAST_FAN, flagsOf, loadShip, PART, SHIP_IDS, SOLID } from '../scripts/model-audit-lib.mjs';

const known = JSON.parse(readFileSync(KNOWN_FLAGS, 'utf8'));
const lib = await loadAuditModules();

test('no model has drifted further from its hand-written numbers', { timeout: 300000 }, async (t) => {
  const results = await runAudit({ fast: true });
  assert.equal(results.ships.length, SHIP_IDS.length);
  assert.equal(results.buildings.length, Object.keys(lib.PORT_PREFABS).length, 'every prefab is audited');
  const fresh = [], worse = [], seen = new Set();
  for (const flag of results.flags) {
    seen.add(flag.key);
    if (!(flag.key in known)) { fresh.push(`${flag.key} = ${flag.value} (limit ${flag.limit}) ${flag.note}`); continue; }
    // Distance past its limit, since a rail too low is past it the other way.
    if (Math.abs(flag.value - flag.limit) > Math.abs(known[flag.key] - flag.limit) * 1.15 + 0.1) worse.push(`${flag.key}: ${known[flag.key]} -> ${flag.value}`);
  }
  assert.deepEqual(fresh, [], 'new faults');
  assert.deepEqual(worse, [], 'known faults that got worse');
  const stale = Object.keys(known).filter((key) => !seen.has(key));
  if (stale.length) t.diagnostic(`fixed, so drop from the known list: ${stale.join(', ')}`);
});

test('an intact building is met exactly where its mesh is, whatever it is', () => {
  // Past this no building has any tolerance: the shot traces the triangles it draws.
  assert.deepEqual(Object.keys(known).filter((key) => key.startsWith('building.mesh/')), []);
  assert.deepEqual(Object.keys(known).filter((key) => key.startsWith('port.')), []);
});

// The audit must pass what is right and catch what is wrong, or it says nothing.
test('a sweep that follows the mesh agrees with it on every line', () => {
  const ship = loadShip('pinta');
  const sweep = (from, to, radius, boat) => {
    const o = [from[0], from[1] - boat.heave, from[2]], d = [to[0] - from[0], to[1] - from[1], to[2] - from[2]];
    const hit = ship.index.first(o, d, 1, SOLID);
    return hit ? { fraction: hit.t, hitZone: ship.partOf[hit.triangle] === PART.hull ? 'hull' : 'rigging', mastGroup: null } : null;
  };
  const row = auditShipCollision(ship, sweep, () => null, { ...FAST_FAN, fresh: true });
  assert.ok(row.struck > 1000, `${row.struck} lines`);
  for (const key of ['airHullPct', 'airRigPct', 'throughHullPct', 'throughMastPct']) assert.equal(row[key], 0, key);
  assert.equal(row.agreePct, 100);
});

test('a mast table a metre out is caught', () => {
  const ship = loadShip('nina'), wrong = { ...lib, shipMastSpecs: (id) => lib.shipMastSpecs(id).map((m) => [m[0], m[1] + 0.6, m[2], m[3]]) };
  const masts = auditMasts(ship, wrong);
  assert.ok(masts.rows.every((m) => m.offZ > 0.9), JSON.stringify(masts.rows.map((m) => m.offZ)));
  const flags = flagsOf({ ships: [{ id: 'nina', collision: {}, masts, guns: { rows: [] }, crewStations: {}, crewRoutes: {}, walkways: {}, nodes: {}, ropes: {}, waterline: {}, surface: { materials: {} } }] });
  assert.ok(flags.some((f) => f.key === 'mast.station/nina/main'));
});

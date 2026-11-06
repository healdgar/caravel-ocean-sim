// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The model audit measures the mesh in Node. This holds that to what the GPU really draws in the running game.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareLiveToRest, readLiveGame } from '../scripts/model-audit.mjs';
import { loadShip, SHIP_IDS } from '../scripts/model-audit-lib.mjs';

test('hull and masts stand on the GPU where the audit measures them, and a live port is known to the shot by its meshes', { timeout: 300000 }, async (t) => {
  const live = await readLiveGame(SHIP_IDS, ['lisbon']);
  for (const id of SHIP_IDS) {
    const row = compareLiveToRest(loadShip(id, live.ships[id]), live.ships[id]);
    assert.equal(row.movedM.mast ?? 0, 0, `${id}: masts stay as built`);
    // Only a hatch lid moves among what the audit calls hull.
    assert.ok(/^(hatch\.\S+ [\d.]+(, )?)*$/.test(row.hullMovers), `${id}: ${row.hullMovers}`);
    assert.equal(row.lengthOff, 0, `${id} length`);
    assert.equal(row.beamOff, 0, `${id} beam`);
    assert.equal(row.sinkageOff, 0, `${id} sinkage`);
  }
  const [port] = live.world;
  assert.ok(port.instances > 0, 'a port with buildings');
  assert.equal(port.meshed, port.instances, 'every building is known by its mesh');
  assert.equal(port.traced, port.instances, 'every building traces its mesh');
  // The forest's own roots are what a ball meets. Streaming may have added more since its grid was last built.
  assert.ok(port.treeData > 0, 'a ball can strike the forest');
  t.diagnostic(`trees drawn ${port.roots}, trees a ball can strike ${port.treeData}`);
});

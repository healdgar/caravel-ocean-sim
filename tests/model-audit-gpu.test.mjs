// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The model audit measures the mesh in Node. This holds that to what the GPU really draws in the running game.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { compareLiveToRest, readLiveGame } from '../scripts/model-audit.mjs';
import { shipColliderHatchFrame, shipColliderSailCode } from '../js/ship-collider.js';
import { createShipAssetCache } from '../js/ship-mesh.js';
import { loadShip, SHIP_IDS } from '../scripts/model-audit-lib.mjs';

// The shot moves each yard and hatch lid as one rigid body with the CPU evaluators. That holds only if the GPU agrees.
function assertSparsStandWhereDrawn(id, game) {
  const { collider, model } = createShipAssetCache().get(id), boat = { modelId: id, model, sailState: game.sailState, hatchesClosed: game.hatchesClosed };
  const lid = collider.hatchPart ? shipColliderHatchFrame(model, game.hatchesClosed).frame : null;
  let moved = 0, worst = 0, who = '';
  for (let v = 0, n = game.vertices.length / 9; v < n; v++) {
    const material = game.vertices[v * 9 + 6], kind = Math.floor(material), point = [...game.vertices.subarray(v * 9, v * 9 + 3)];
    let at = null;
    if (kind === 10) {
      const part = collider.rig.find((r) => r.sail.code === shipColliderSailCode(model, material));
      if (part) at = part.sail.yard(point, part.sail.pose(boat));
    } else if (kind === 18 && lid) at = lid.origin.map((o, c) => o + lid.x[c] * point[0] + lid.y[c] * point[1] + lid.z[c] * point[2]);
    if (!at) continue;
    moved++;
    const off = Math.hypot(at[0] - game.posed[v * 8], at[1] - game.posed[v * 8 + 1], at[2] - game.posed[v * 8 + 2]);
    if (off > worst) { worst = off; who = kind === 10 ? 'spar' : 'hatch'; }
  }
  if (collider.rig.length || lid) assert.ok(moved > 0, `${id} has spars or a lid`);
  // The rig is still moving, and a loaded machine reads the pose and the sail state a frame or two apart.
  assert.ok(worst < 0.1, `${id}: a ${who} stands ${worst.toFixed(3)} design units from where the GPU drew it`);
}

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
    assertSparsStandWhereDrawn(id, live.ships[id]);
  }
  const [port] = live.world;
  assert.ok(port.instances > 0, 'a port with buildings');
  assert.equal(port.meshed, port.instances, 'every building is known by its mesh');
  assert.equal(port.traced, port.instances, 'every building traces its mesh');
  // The forest's own roots are what a ball meets. Streaming may have added more since its grid was last built.
  assert.ok(port.treeData > 0, 'a ball can strike the forest');
  t.diagnostic(`trees drawn ${port.roots}, trees a ball can strike ${port.treeData}`);
});

// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Automated gate test ensuring every 3D model asset (.glb on disk, PROP_MODELS, PLAYABLE_SHIP_MODELS,
// PORT_PREFABS, crew skeletons, and forest tree species) is wired into a destructible cannonfire pipeline.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  PROP_MODELS,
  ensureJettyFracture,
  evaluateJettyShardPose,
  jettyLocalToWorld,
  preparePortJetties,
  readPropModel,
  stepJettyFracture,
  sweepJettySegment,
} from '../js/port-props.js';
import {
  createGunnerySolidSweep,
  resolveSolidGunneryImpact,
  classifyBuildingMaterial,
} from '../js/gunnery-control.js';
import { SHIP_MODELS } from '../js/ship-models.js';
import { createShipAssetCache } from '../js/ship-mesh.js';
import { applyFractureEvents } from '../js/ship-fracture.js';
import { PORT_PREFABS, getBuildingParts } from '../js/coastal-world.js';
import { applyBuildingFractureEvents, prepareBuildingFracture } from '../js/building-fracture.js';
import { readGLB } from '../js/gltf.js';
import { crewWoundOutcome, recordCrewWound, sweepCrewBodies } from '../js/crew-wounds.js';
import { FOREST_TRUNK_SHAPES } from '../js/forest-trunk-shapes.js';
import { buildForestTrunkGrid, forestTrunkShape, sweepForestTrunks } from '../js/forest-trunks.js';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function walkGlbFiles(dir, prefix = '') {
  const out = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      out.push(...walkGlbFiles(path.join(dir, entry.name), rel));
    } else if (entry.isFile() && entry.name.endsWith('.glb')) {
      out.push(`assets/${rel}`);
    }
  }
  return out.sort();
}

const KNOWN_CREW_GLBS = new Set([
  'assets/crew/sailor.glb',
  'assets/crew/sailor-female.glb',
  'assets/crew/sailor-classic.glb',
  'assets/crew/sailor-female-classic.glb',
  'assets/crew/captain.glb',
]);

const KNOWN_WILDLIFE_GLBS = new Set([
  'assets/wildlife/whale.glb',
]);

test('every .glb asset on disk and in build.mjs is registered in a destructible model pipeline', () => {
  const diskGlbs = walkGlbFiles(path.join(ROOT, 'assets'));
  assert.ok(diskGlbs.length >= 8, `found ${diskGlbs.length} .glb files under assets/`);

  const buildSource = readFileSync(path.join(ROOT, 'build.mjs'), 'utf8');
  const buildGlbs = [...buildSource.matchAll(/['"](assets\/[^'"]+\.glb)['"]/g)].map((m) => m[1]);
  for (const glb of buildGlbs) {
    assert.ok(diskGlbs.includes(glb), `build.mjs references ${glb} which must exist on disk`);
  }

  const propGlbs = new Set(PROP_MODELS.map((m) => m.file));
  for (const glb of diskGlbs) {
    if (glb.startsWith('assets/props/')) {
      assert.ok(
        propGlbs.has(glb),
        `Prop asset ${glb} is not registered in PROP_MODELS (js/port-props.js) — imported props must be destructible!`,
      );
      continue;
    }
    if (glb.startsWith('assets/crew/')) {
      assert.ok(
        KNOWN_CREW_GLBS.has(glb),
        `Crew asset ${glb} must be registered in the crew wound/casualty pipeline`,
      );
      continue;
    }
    if (glb.startsWith('assets/ports/1550/')) {
      const prefabId = path.basename(glb, '.glb');
      assert.ok(
        prefabId in PORT_PREFABS,
        `Port building GLB ${glb} must correspond to a destructible prefab in PORT_PREFABS (js/coastal-world.js)`,
      );
      continue;
    }
    if (KNOWN_WILDLIFE_GLBS.has(glb)) continue;

    assert.fail(
      `Unclassified 3D model ${glb}: every imported .glb must be wired into PROP_MODELS, crew-wounds, or another destructible pipeline!`,
    );
  }
});

test('every imported prop in PROP_MODELS (cleats and beach jetties) is directly destructible by cannonfire', () => {
  const models = PROP_MODELS.map((spec) =>
    readPropModel(readFileSync(path.join(ROOT, spec.file)), spec),
  );

  for (let modelIndex = 0; modelIndex < PROP_MODELS.length; modelIndex++) {
    const spec = PROP_MODELS[modelIndex];
    const model = models[modelIndex];
    assert.ok(model.fracture, `${spec.id} has a fracture partition`);
    assert.ok(model.fracture.shards.length >= 4, `${spec.id} partitions into >= 4 rigid shards`);
    assert.equal(
      model.fracture.shardOfVertex.length,
      model.vertices.length / 8,
      `${spec.id} maps every vertex to a shard`,
    );

    const prop = { model: modelIndex, x: 0, y: spec.deckShare ? null : 2.5, z: 0, yaw: 0.2, owner: -1 };
    const port = { center: { x: 0, z: 0 }, instances: [], props: [prop], groundAt: () => -1.5 };
    preparePortJetties(port, models, port.groundAt);
    const state = ensureJettyFracture(prop, model, port.groundAt);

    // Aim a cannonball ray directly through the center of one of the prop's drawn triangles.
    const targetShard = state.shards.find((s) => s.tier === 2) ?? state.shards[0];
    const i0 = model.indices[targetShard.indexStart] * 8;
    const i1 = model.indices[targetShard.indexStart + 1] * 8;
    const i2 = model.indices[targetShard.indexStart + 2] * 8;
    const triCenter = [
      (model.vertices[i0] + model.vertices[i1] + model.vertices[i2]) / 3,
      (model.vertices[i0 + 1] + model.vertices[i1 + 1] + model.vertices[i2 + 1]) / 3,
      (model.vertices[i0 + 2] + model.vertices[i1 + 2] + model.vertices[i2 + 2]) / 3,
    ];
    const from = jettyLocalToWorld(prop, triCenter[0] - 10, triCenter[1], triCenter[2], model);
    const to = jettyLocalToWorld(prop, triCenter[0] + 10, triCenter[1], triCenter[2], model);

    const sweep = createGunnerySolidSweep({ getVessels: () => [], getTerrain: () => ({ port }) });
    const hit = sweep(from, to, { radius: 0.08, ammo: 'round' });
    assert.ok(hit, `${spec.id} (${spec.file}): cannonball ray strikes drawn triangles`);
    assert.equal(hit.kind, 'jetty', `${spec.id}: hit kind is jetty`);
    assert.equal(hit.jetty, prop, `${spec.id}: hit references placed prop`);
    assert.ok(sweepJettySegment(from, to, 0.08, port), `${spec.id}: sweepJettySegment hits prop`);

    const vel = [(to[0] - from[0]) * 18, (to[1] - from[1]) * 18, (to[2] - from[2]) * 18];
    const report = resolveSolidGunneryImpact(
      {
        ...hit,
        type: 'impact',
        ammo: 'round',
        mass: 10.9,
        velocity: vel,
        position: jettyLocalToWorld(prop, ...hit.localPosition, model),
      },
      { getTerrain: () => ({ port }) },
    );
    assert.ok(report, `${spec.id}: resolveSolidGunneryImpact returns damage report`);
    assert.ok(report.releasedShards.length >= 1, `${spec.id}: impact releases rigid shards into flight`);

    const shardId = report.releasedShards[0];
    const poseStart = evaluateJettyShardPose(prop, shardId, 0);
    assert.equal(poseStart.inFlight, true, `${spec.id}: released shard enters ballistic flight`);
    stepJettyFracture(prop, 0.25);
    const poseAfter = evaluateJettyShardPose(prop, shardId);
    const moved = Math.hypot(
      poseAfter.localPosition[0] - poseStart.localPosition[0],
      poseAfter.localPosition[1] - poseStart.localPosition[1],
      poseAfter.localPosition[2] - poseStart.localPosition[2],
    );
    assert.ok(moved > 0.3, `${spec.id}: released shard flies away from its rest position (${moved.toFixed(2)} m)`);

    // Clear any remaining shards along the shot line and verify subsequent shots pass through the breach.
    for (let k = 0; k < 4; k++) {
      const nextHit = sweep(from, to, { radius: 0.08, ammo: 'round' });
      if (!nextHit) break;
      resolveSolidGunneryImpact(
        { ...nextHit, type: 'impact', ammo: 'round', mass: 10.9, velocity: vel },
        { getTerrain: () => ({ port }) },
      );
    }
    assert.equal(
      sweep(from, to, { radius: 0.08, ammo: 'round' }),
      null,
      `${spec.id}: follow-up shot passes through the broken gap`,
    );
  }
});

test('every playable ship model in SHIP_MODELS fractures into rigid shards under cannonfire', () => {
  const cache = createShipAssetCache();
  const readyShips = Object.values(SHIP_MODELS).filter((m) => m.status === 'ready' && m.geometry);
  assert.ok(readyShips.length >= 7);
  for (const model of readyShips) {
    const asset = cache.get(model.id);
    const fracture = asset.fracture;
    assert.ok(fracture, `${model.id} has a prepared ship fracture table`);
    assert.ok(fracture.shardCount > 5, `${model.id} has ${fracture.shardCount} shards`);
    assert.ok(fracture.strikable.length > 0, `${model.id} has strikable hull/superstructure shards`);

    const targetShard = fracture.shards[fracture.strikable[0]];
    const [cx, cy, cz] = targetShard.centroid;
    const damage = {};
    const released = applyFractureEvents(
      fracture,
      damage,
      [{ kind: 'hull-crater', x: cx, y: cy, z: cz, stepDepth: 0.48, severity: 1.85 }],
      0,
    );
    assert.ok(released >= 1, `${model.id}: cannonball impact releases ${released} rigid ship shards`);
    assert.ok(damage.fracture.flying.size >= 1, `${model.id}: released ship shards enter flight`);
  }
});

test('every coastal building and fort prefab in PORT_PREFABS fractures into flying rigid blocks under cannonfire', () => {
  const prefabIds = Object.keys(PORT_PREFABS);
  assert.ok(prefabIds.length >= 15);
  for (const prefabId of prefabIds) {
    const parts = getBuildingParts(prefabId);
    const instance = { prefabId, x: 0, y: 0, z: 0, baseY: 0, yaw: 0, ...parts.dimensions };
    const { fracture } = prepareBuildingFracture({
      vertices: new Float32Array(parts.vertices),
      indices: parts.indices,
      catalog: parts.partAssembly,
      instanceIndex: 0,
      instance,
      materialClass: classifyBuildingMaterial(prefabId),
      groundAt: () => 0,
    });
    assert.ok(fracture.shardCount > 1, `${prefabId} has ${fracture.shardCount} shards`);
    assert.ok(fracture.strikable.length > 0, `${prefabId} has strikable shards`);

    const target = fracture.shards[fracture.strikable.find((s) => !fracture.shards[s].earth) ?? fracture.strikable[0]];
    const [tx, ty, tz] = target.centroid;
    const damage = {};
    const released = applyBuildingFractureEvents(
      fracture,
      damage,
      [{
        kind: classifyBuildingMaterial(prefabId) === 'timber' ? 'timber-splinter' : 'stone-crater',
        x: tx,
        y: ty,
        z: tz,
        nx: target.normal[0] || 0,
        ny: target.normal[1] || 0,
        nz: target.normal[2] || -1,
        stepDepth: 0.52,
        severity: 1.35,
      }],
      0,
    );
    assert.ok(released >= 1, `${prefabId}: cannonball impact releases ${released} building shards`);
    assert.ok(damage.fracture.flying.size >= 1, `${prefabId}: released building shards fly through the air`);
  }
});

test('every human crew/soldier .glb model has destructible wound bones and responds to cannonball sweeps', () => {
  for (const glbPath of KNOWN_CREW_GLBS) {
    const asset = readGLB(readFileSync(path.join(ROOT, glbPath)));
    const nodeNames = new Set((asset.json.nodes ?? []).map((n) => n.name).filter(Boolean));
    for (const requiredBone of ['pelvis', 'spine_01', 'Head', 'upperarm_l', 'thigh_r']) {
      assert.ok(nodeNames.has(requiredBone), `${glbPath} skeleton contains wound bone ${requiredBone}`);
    }
  }
  const sailor = { position: [0, 0, 0], yaw: 0, scale: [1, 1, 1], visible: true };
  const hits = sweepCrewBodies([-5, 1.0, 0], [5, 1.0, 0], 0.08, [sailor], 1);
  assert.equal(hits.length, 1, 'cannonball ray intercepts standing crew body');
  recordCrewWound(sailor, 'ball', hits[0].point, [1, 0, 0], 0.1);
  assert.equal(sailor.pendingWounds?.length, 1, 'wound is queued on the struck body');
  assert.deepEqual(crewWoundOutcome('ball', 'lowerarm_l', 0.1), { kind: 'severed', bone: 'lowerarm_l' });
  assert.deepEqual(crewWoundOutcome('ball', 'spine_02', 0.1), { kind: 'crushed', bone: 'spine_03' });
});

test('every forest tree species has destructible trunk capsules that intercept cannonballs', () => {
  const speciesList = Object.keys(FOREST_TRUNK_SHAPES);
  assert.ok(speciesList.length >= 5);
  let woodyCount = 0;
  for (const species of speciesList) {
    const shape = forestTrunkShape(species);
    if (!shape) continue;
    woodyCount++;
    assert.ok(shape.count > 0, `${species} compiles into ${shape.count} trunk/limb capsules`);
    assert.ok(shape.trunkRadius > 0, `${species} has positive trunk radius`);

    // Place a single tree at the origin and aim a cannonball ray directly through its first capsule midpoint.
    const roots = new Float32Array(12);
    roots[0] = 0; roots[1] = 0; roots[2] = 0;
    roots[3] = 1; // scale
    roots[4] = 0; // yaw
    roots[8] = 0; // prototype 0
    const grid = buildForestTrunkGrid(roots, 1, [species]);
    const cap = shape.capsules;
    const mx = (cap[0] + cap[4]) * 0.5;
    const my = (cap[1] + cap[5]) * 0.5;
    const mz = (cap[2] + cap[6]) * 0.5;
    const hit = sweepForestTrunks(grid, [mx - 10, my, mz], [mx + 10, my, mz], 0.08);
    assert.ok(hit, `${species}: cannonball ray strikes tree trunk`);
  }
  assert.ok(woodyCount >= 5, `verified ${woodyCount} woody tree species`);
});

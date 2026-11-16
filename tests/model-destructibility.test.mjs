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
import { loadCrewGLB, readGLB } from '../js/gltf.js';
import { attachColonialGroomModel, loadGroomPackGLB } from '../js/crew.js';
import { crewWoundOutcome, recordCrewWound, sweepCrewBodies } from '../js/crew-wounds.js';
import { FOREST_TRUNK_SHAPES } from '../js/forest-trunk-shapes.js';
import { buildForestTrunkGrid, forestTrunkShape, sweepForestTrunks } from '../js/forest-trunks.js';
import { getLivestockMeshes, getVehicleMeshes } from '../js/models/livestock-meshes.js';
import {
  buildLivestockMorphBuffer,
  caravanHerdSeeds,
  evaluateHerdStateAt,
  sweepHerdHit,
} from '../js/herds.js';
import { HERD_FATE_FLOATS, HERDS_RENDER_WGSL, HERDS_STEP_WGSL } from '../js/wgsl/herds.js';

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
  'assets/crew/soldier-1550.glb',
  'assets/crew/indigenous-algonquian-male.glb',
  'assets/crew/indigenous-algonquian-female.glb',
  'assets/crew/indigenous-caribbean-male.glb',
  'assets/crew/indigenous-caribbean-female.glb',
  'assets/crew/indigenous-maya-male.glb',
  'assets/crew/indigenous-maya-female.glb',
  'assets/crew/indigenous-andean-male.glb',
  'assets/crew/indigenous-andean-female.glb',
]);

const KNOWN_CREW_ACCESSORY_GLBS = new Set([
  'assets/crew/groom-pack.glb',
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
        KNOWN_CREW_GLBS.has(glb) || KNOWN_CREW_ACCESSORY_GLBS.has(glb),
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
  const groomPack = loadGroomPackGLB(readFileSync(path.join(ROOT, 'assets/crew/groom-pack.glb')));
  assert.equal(Object.keys(groomPack.pieces).length, 10, 'groom-pack.glb contains all 10 hair/beard meshes');
  const baseSailor = loadCrewGLB(readFileSync(path.join(ROOT, 'assets/crew/sailor.glb')));
  const groomedSailor = attachColonialGroomModel(baseSailor, groomPack, 'male');
  const slotOf = Object.fromEntries(baseSailor.animator.joints.map((ni, si) => [baseSailor.animator.names[ni], si]));
  const allowedBones = new Set(['Head', 'neck_01', 'spine_03'].map((n) => slotOf[n]));
  const u16 = new Uint16Array(groomedSailor.vertices.buffer, groomedSailor.vertices.byteOffset, groomedSailor.vertexCount * 30);
  const f32 = new Float32Array(groomedSailor.vertices.buffer, groomedSailor.vertices.byteOffset, groomedSailor.vertexCount * 15);
  for (let v = baseSailor.vertexCount; v < groomedSailor.vertexCount; v++) {
    for (let k = 0; k < 4; k++) {
      if (f32[v * 15 + 11 + k] > 0) {
        assert.ok(allowedBones.has(u16[v * 30 + 18 + k]), `groom vertex ${v} binds to destructible cranial/neck wound bone`);
      }
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

test('all 7 livestock & caravan vehicle species (0..6) are physically destructible with GPU fates, stampede, hitch halt, and vehicle shard flight', () => {
  const allMeshes = [...getLivestockMeshes(), ...getVehicleMeshes()];
  assert.equal(allMeshes.length, 7, '4 livestock + 3 1550 road vehicles');
  for (let s = 0; s < allMeshes.length; s++) {
    const morphBuf = buildLivestockMorphBuffer(allMeshes[s], s >= 4);
    assert.equal(morphBuf.length, allMeshes[s].vertices.length, `${allMeshes[s].name}: GPU morph/shard buffer matches 8 floats/vertex`);
  }

  // 1. Direct hits & 38 m near-miss stampede across all 4 livestock species (0..3) wired through createGunnerySolidSweep.
  const elev = () => 3.0;
  for (let species = 0; species < 4; species++) {
    const seeds = new Float32Array([
      0, 0, 8, 0.1, species === 3 ? 10.4 : 0.4, 1.0, species, 0,
      0, 22, 8, 0.3, 0.6, 1.0, species, 0,
    ]);
    const routes = new Float32Array([0, 1, 0, 0]);
    const fates = new Float32Array(2 * HERD_FATE_FLOATS);
    const s0 = evaluateHerdStateAt(seeds, routes, fates, 0, 10, elev);
    const s1Before = evaluateHerdStateAt(seeds, routes, fates, 1, 10, elev);

    const sweep = createGunnerySolidSweep({
      getVessels: () => [],
      getTerrain: () => ({
        herdsWatch: (from, to, _best, proj) => sweepHerdHit(seeds, routes, fates, 10, elev, from, to, proj?.radius ?? 0.08),
      }),
    });
    const hit = sweep([s0.x - 10, s0.y + 0.5, s0.z], [s0.x + 10, s0.y + 0.5, s0.z], { radius: 0.08, ammo: 'round' });
    assert.ok(hit, `species ${species}: cannonball intercepts animal`);
    assert.equal(hit.kind, 'livestock');
    assert.equal(hit.species, species);
    assert.equal(fates[0], 2.0, `species ${species}: transitions to felled state (2.0)`);
    assert.equal(fates[HERD_FATE_FLOATS], 1.0, `species ${species}: bystander within 38 m enters stampede state (1.0)`);

    const report = resolveSolidGunneryImpact({ ...hit, type: 'impact', ammo: 'round', mass: 10.9, velocity: [180, 0, 0] });
    assert.equal(report?.felled, true, `species ${species}: resolveSolidGunneryImpact reports felled casualty`);

    const s0After = evaluateHerdStateAt(seeds, routes, fates, 0, 10.8, elev);
    const s1Stampede = evaluateHerdStateAt(seeds, routes, fates, 1, 13.0, elev);
    assert.ok((s0After.flags & 2) !== 0, `species ${species}: felled flag set`);
    assert.ok(Math.hypot(s0After.x - s0.x, s0After.z - s0.z) >= 0.7, `species ${species}: knockback applied`);
    assert.ok(Math.hypot(s1Stampede.x - s1Before.x, s1Stampede.z - s1Before.z) > 6.0, `species ${species}: bystander bolts radially away`);
  }

  // 2. Coupled caravan hitches for all 3 road vehicle archetypes (wain=4, coach=5, ox-cart=6):
  //    a) Felling a draft beast halts the vehicle & pitches its draft pole down onto the roadbed.
  //    b) Striking the vehicle shatters its rigid parts into ballistic flight while surviving draft beasts bolt ahead.
  for (const vehSp of [4, 5, 6]) {
    const draftSp = vehSp === 5 ? 3 : 1;
    const routes = new Float32Array([
      1, 5, 2, 400,
      0, 0, 0, 0,
      400, 0, 400, 0,
    ]);
    const seeds = new Float32Array([
      0, 8, -1.25, 0.2, 0.35, 1.0, vehSp, 0,
      0, 8, -1.25, 0.4, 0.45, 0.96, draftSp, -0.62,
      0, 8, -1.25, 0.6, 0.55, 0.96, draftSp, 0.62,
    ]);
    const laid = { routes, seeds };

    // (a) Shoot draft beast L (`idx = 1`) -> vehicle (`idx = 0`) halts and drops tongue (`flags & 8`, `tonguePitch > 0.25`)
    const fatesHalt = new Float32Array(3 * HERD_FATE_FLOATS);
    const clock0 = { time: 12, boardDay: 2.0, daysPerSecond: 0 };
    const draftPos = evaluateHerdStateAt(laid.seeds, laid.routes, fatesHalt, 1, clock0, elev);
    const hitDraft = sweepHerdHit(laid.seeds, laid.routes, fatesHalt, clock0, elev, [draftPos.x, draftPos.y + 0.7, draftPos.z - 8], [draftPos.x, draftPos.y + 0.7, draftPos.z + 8], 0.08);
    assert.equal(hitDraft?.kind, 'livestock');
    const halted1 = evaluateHerdStateAt(laid.seeds, laid.routes, fatesHalt, 0, { time: 13, boardDay: 2.0, daysPerSecond: 0 }, elev);
    const halted2 = evaluateHerdStateAt(laid.seeds, laid.routes, fatesHalt, 0, { time: 25, boardDay: 2.0, daysPerSecond: 0 }, elev);
    assert.ok((halted1.flags & 8) !== 0, 'vehicle hitch-halted flag set');
    assert.ok(halted1.tonguePitch > 0.28, `draft pole pitched down onto roadbed (${halted1.tonguePitch.toFixed(2)} rad)`);
    assert.ok(Math.hypot(halted2.x - halted1.x, halted2.z - halted1.z) < 1e-3, 'halted vehicle remains stationary');

    // (b) Shoot vehicle (`idx = 0`) directly -> shattered (`flags & 4`), shards released, surviving draft beasts (`idx = 1, 2`) bolt forward!
    const fatesShatter = new Float32Array(3 * HERD_FATE_FLOATS);
    const vehPos = evaluateHerdStateAt(laid.seeds, laid.routes, fatesShatter, 0, clock0, elev);
    const draftBefore = evaluateHerdStateAt(laid.seeds, laid.routes, fatesShatter, 1, clock0, elev);
    const hitVeh = sweepHerdHit(laid.seeds, laid.routes, fatesShatter, clock0, elev, [vehPos.x, vehPos.y + 0.9, vehPos.z - 10], [vehPos.x, vehPos.y + 0.9, vehPos.z + 10], 0.08);
    assert.equal(hitVeh?.kind, 'caravan');
    const vehRep = resolveSolidGunneryImpact({ ...hitVeh, type: 'impact', ammo: 'round', mass: 10.9, velocity: [0, 0, 180] });
    assert.ok(vehRep.releasedShards.length >= 4, 'shattered vehicle releases wheel, pole & body shards');
    const vehAfter = evaluateHerdStateAt(laid.seeds, laid.routes, fatesShatter, 0, { time: 14, boardDay: 2.0, daysPerSecond: 0 }, elev);
    const draftBolted = evaluateHerdStateAt(laid.seeds, laid.routes, fatesShatter, 1, { time: 16, boardDay: 2.0, daysPerSecond: 0 }, elev);
    assert.ok((vehAfter.flags & 4) !== 0, 'vehicle shattered flag set for GPU ballistic shard flight');
    assert.ok(draftBolted.rolled > draftBefore.rolled + 12, 'surviving unhitched draft beast breaks free and gallops ahead');
  }

  assert.match(HERDS_STEP_WGSL, /@binding\(10\)\s+var<uniform>\s+shots:\s*HerdShots/);
  assert.match(HERDS_STEP_WGSL, /@binding\(11\)\s+var<storage,\s*read_write>\s+fates:\s*array<HerdFate>/);
  assert.match(HERDS_RENDER_WGSL, /isVehicle\s*&&\s*isShattered/);
});

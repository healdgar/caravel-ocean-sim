// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import vm from 'node:vm';

import { BAKED_BOARDS, BAKED_WORLDS, boardGroundFits, boardPrefix } from '../js/board-model.js';
import { oldWorldCountry, registerBakedBoard } from '../js/old-world.js';
import { buildPortPrefabGeometry } from '../js/coastal-world.js';
import { layTownStreets } from '../js/town-streets.js';
import { terrainSurfaceSample } from '../js/terrain-model.js';
import { CITY_TYPED_FLOATS, compileCityBuildingTypes } from '../js/old-world-buildings.js';
import { createCityTargets } from '../js/city-targets.js';
import {
  applyBuildingFractureEvents,
  prepareBuildingFracture,
} from '../js/building-fracture.js';
import { applyFractureEvents } from '../js/ship-fracture.js';
import { CREW_JOINT_COUNT } from '../js/crew-skeleton.js';
import { bridgeDeckYAt, caravanHerdSeeds } from '../js/herds.js';
import { createInlandWaterSampler } from '../js/inland-water.js';
import { INLAND_WATER_FLOATS, INLAND_WATER_WGSL } from '../js/wgsl/inland-water.js';
import {
  applyShipImpactDamage,
  createGunnerySolidSweep,
  createVesselDamageState,
  stepVesselDamage,
  sweepBuildingSegment,
  sweepShipSegment,
  sweepTerrainSegment,
} from '../js/gunnery-control.js';
import {
  TRADE_VESSEL_ARCHETYPES,
  TRADE_VESSEL_CONTINUUM_MATERIAL,
  TRADE_VESSEL_CONTINUUM_CAPTURE_MATERIAL,
  TRADE_VESSEL_WAVE_WGSL,
  computeSailingPolar,
  createTradeVessels,
  createVesselAutopilotState,
  getTradeVesselArchetype,
  inspectTradeVesselArchetypes,
  sampleTradeVesselState,
  stepTradeVesselAutopilot,
} from '../js/trade-vessels.js';
import { CONTINUUM_LISTS, CONTINUUM_VIEW_LISTS } from '../js/continuum-format.js';
import { CONTINUUM_DRAW_WORDS, continuumModuleWGSL } from '../js/wgsl/continuum-cut.js';
import { WATER_CAPTURE_DIRECTIVE, waterCaptureWGSL } from '../js/water-optics.js';

// The trade vessels' material as the one cut composes it: its view, and its capture under water.
const tradeVesselView = () => continuumModuleWGSL({ pass: 'view', material: TRADE_VESSEL_CONTINUUM_MATERIAL });
const tradeVesselCapture = () => continuumModuleWGSL({
  pass: 'capture', material: TRADE_VESSEL_CONTINUUM_CAPTURE_MATERIAL,
  capture: { directive: WATER_CAPTURE_DIRECTIVE, tail: (options) => waterCaptureWGSL({ ...options, surfaceWaves: false }) },
});
import { openBoard } from '../scripts/board-host.mjs';

function upsampleSurvey(survey, targetN = 257) {
  const sN = Math.round(Math.sqrt(survey.length));
  const out = new Float32Array(targetN * targetN);
  for (let j = 0; j < targetN; j++) {
    const sy = (j / (targetN - 1)) * (sN - 1);
    const y0 = Math.min(sN - 2, Math.floor(sy)), ty = sy - y0;
    for (let i = 0; i < targetN; i++) {
      const sx = (i / (targetN - 1)) * (sN - 1);
      const x0 = Math.min(sN - 2, Math.floor(sx)), tx = sx - x0;
      const a = survey[y0 * sN + x0], b = survey[y0 * sN + x0 + 1];
      const c = survey[(y0 + 1) * sN + x0], d = survey[(y0 + 1) * sN + x0 + 1];
      out[j * targetN + i] = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
    }
  }
  return out;
}

function buildLisbonCountry() {
  const baked = JSON.parse(readFileSync(new URL('../' + BAKED_BOARDS['lisbon:1550'], import.meta.url), 'utf8'));
  const region = { ...baked.region, size: 257, biomeSize: 128, albedoSize: 256, year: 1550 };
  const heights = upsampleSurvey(baked.survey, region.size);
  assert.ok(boardGroundFits(baked.survey, heights));
  registerBakedBoard(baked);
  const port = { center: { x: region.x, z: region.z }, clearRadius: 120, instances: [] };
  port.streets = layTownStreets(port, (x, z) => terrainSurfaceSample(heights, x, z, region));
  const country = oldWorldCountry(region, heights, port);
  return { baked, region, heights, port, country };
}

function makeTestBoat(archIndex, { x = 0, z = 0, waterY = 0, heading = 0 } = {}) {
  const arch = getTradeVesselArchetype(archIndex);
  const massTonnes = arch.modelId === 'lusoria' ? 7 : Math.max(25, arch.length * arch.beam * arch.draft * 0.42);
  const massKg = massTonnes * 1000;
  const wpArea = Math.max(4, arch.length * arch.beam * 0.72);
  const boat = {
    id: `test-vessel-${archIndex}`,
    archetype: archIndex,
    modelId: arch.modelId,
    model: arch.model,
    collider: arch.collider,
    partAssembly: arch.partAssembly,
    fracture: arch.fracture,
    length: arch.length,
    beam: arch.beam,
    draft: arch.draft,
    freeboard: arch.freeboard,
    mass: massKg,
    hydrodynamics: {
      mass: massKg,
      addedMass: massKg * 0.12,
      centreOfGravity: arch.draft * 0.48,
      sinkage: 0,
      pitchInertia: Math.max(1000, massKg * (arch.length * arch.length) / 14),
      rollInertia: Math.max(400, massKg * (arch.beam * arch.beam) / 10),
      draft: arch.draft,
      freeboard: arch.freeboard,
      waterplaneArea: wpArea,
    },
    x,
    z,
    heave: waterY,
    heading,
    pitch: 0,
    roll: 0,
    sailFore: archIndex === 1 || archIndex === 3 || archIndex === 4 ? 0 : 1,
    sailMain: archIndex === 1 || archIndex === 3 || archIndex === 4 ? 0 : 1,
    sailMizzen: archIndex === 1 || archIndex === 3 || archIndex === 4 || archIndex === 6 ? 0 : 1,
    showProw: true,
    target: { heave: waterY },
    damage: null,
  };
  boat.damage = createVesselDamageState(boat);
  return boat;
}

test('real part-built boat archetypes, furled sails, low air-draft cargo barges, and -Z bow alignment', () => {
  const list = inspectTradeVesselArchetypes();
  assert.equal(list.length, TRADE_VESSEL_ARCHETYPES);
  assert.equal(TRADE_VESSEL_ARCHETYPES, 7);

  for (const arch of list) {
    assert.ok(arch.vertices.length >= 9 * 1000, `${arch.label} must build full boat geometry`);
    assert.ok(arch.indices.length >= 3 * 1000, `${arch.label} must have dense triangles`);
    assert.ok((arch.partAssembly?.partCount ?? 0) >= 40, `${arch.label} must carry >= 40 boat parts`);
    assert.ok((arch.fracture?.shardCount ?? 0) >= 50, `${arch.label} must precompute fracture shards`);
    assert.ok(arch.collider?.solidTree, `${arch.label} must carry solidTree collider`);
  }

  // Anchored cog (1) & carrack (3) should replace full billowed canvas with furled bundles (fewer vertices)
  assert.ok(list[1].vertices.length < list[0].vertices.length, 'anchored cog has furled sails');
  assert.ok(list[3].vertices.length < list[2].vertices.length, 'anchored carrack has furled sails');
  const countSailMats = (verts) => {
    let n = 0;
    for (let i = 6; i < verts.length; i += 9) if (verts[i] >= 3.5 && verts[i] <= 6.5) n++;
    return n;
  };
  assert.ok(countSailMats(list[1].vertices) > 50, 'anchored cog retains furled linen sail vertices');
  assert.ok(countSailMats(list[3].vertices) > 50, 'anchored carrack retains furled linen sail vertices');

  // Archetype 4: low air-draft unmasted river trade barge with casks, bales & sacks + animated oar marker
  const barge = list[4];
  assert.ok(barge.maxAirDraftMetres < 2.4, `river barge air draft ${barge.maxAirDraftMetres}m must clear bridges (< 2.4m)`);
  const groupIds = new Set(barge.groups.map((g) => g.id));
  for (const cargoId of ['cargo.casks', 'cargo.bales', 'cargo.sacks']) {
    assert.ok(groupIds.has(cargoId), `river barge includes ${cargoId}`);
  }
  // Her oars swing through their stroke in the DRAPED kind (js/wgsl/ship-kinds.js), on the GPU.
  assert.match(tradeVesselView(), /m==16u&&code>=1\.0/);

  // -Z bow alignment across all 4 horizontal quadrants
  for (const [dx, dz] of [[1, 1], [-1, 1], [-1, -1], [1, -1]]) {
    const len = Math.hypot(dx, dz) * 120;
    const tx = (dx * 120) / len;
    const tz = (dz * 120) / len;
    const synth = {
      id: `synth-${dx}-${dz}`,
      mode: 'sea',
      phase: 'shuttle',
      archetype: 0,
      scale: 1,
      depart: 0,
      arrive: 1,
      phaseOffset: 0,
      pts: [
        { x: 0, y: 0, z: 0, acc: 0, segLen: len, tx, ty: 0, tz },
        { x: dx * 120, y: 0, z: dz * 120, acc: len, segLen: 0, tx, ty: 0, tz },
      ],
      totalLen: len,
      speed: 3.5,
    };
    const st = sampleTradeVesselState(synth, 1, 0, 10, len * 0.5);
    const dot = st.bowDir[0] * tx + st.bowDir[1] * tz;
    assert.ok(dot > 0.99, `bowDir aligns with route tangent [${dx},${dz}]: dot=${dot}`);
    assert.ok(Math.abs(st.heading - (st.yaw * 180) / Math.PI) < 1e-4, 'heading degrees match yaw radians');
  }
});

test('cannon fire destroys both harbor ships and upland river trade barges with real hull holes, shards & flooding', () => {
  const harborCarrack = makeTestBoat(2, { x: 40, z: -20, waterY: 0, heading: 0 });
  const riverBarge = makeTestBoat(4, { x: -120, z: 85, waterY: 18, heading: 35 });

  for (const [label, boat, bedDepthRel] of [
    ['harbor carrack', harborCarrack, -6.5],
    ['upland river barge', riverBarge, -1.4],
  ]) {
    const waterY = boat.target.heave;
    const probe = sweepShipSegment([boat.x - 18, waterY + 0.25, boat.z], [boat.x + 18, waterY - 0.35, boat.z], 0.09, boat);
    assert.equal(probe?.kind, 'ship', `${label} hit detected by sweepShipSegment`);
    assert.ok(probe.hitPartId, `${label} resolves hitPartId (${probe.hitPartId})`);

    // Broadside salvo near the waterline
    const yaw = (boat.heading * Math.PI) / 180;
    const cs = Math.cos(yaw), sn = Math.sin(yaw);
    for (let s = 0; s < 14; s++) {
      const zOff = ((s % 5) - 2) * (boat.length * 0.14);
      const hit = sweepShipSegment([boat.x - 18, waterY + 0.12, boat.z + zOff], [boat.x + 18, waterY - 0.45, boat.z + zOff], 0.09, boat);
      if (!hit) continue;
      const lp = hit.localPosition;
      applyShipImpactDamage(boat, {
        ...hit,
        surfacePosition: [
          boat.x + lp[0] * cs + lp[2] * sn,
          waterY - 0.15,
          boat.z - lp[0] * sn + lp[2] * cs,
        ],
        velocity: [220, -14, 0],
        mass: 10.9,
        ammo: 'round',
      });
    }

    assert.ok(boat.damage.pendingBakes.length > 0, `${label} queued fracture bake events`);
    const released = applyFractureEvents(boat.fracture, boat.damage, boat.damage.pendingBakes, 1.0);
    assert.ok(released > 0 || (boat.damage.fracture?.brokenCount ?? 0) > 0, `${label} fractured into broken shards`);

    const relTerrain = { height: () => bedDepthRel };
    for (let i = 0; i < 60; i++) {
      boat.heave = waterY - (boat.damage.floodingSinkage ?? 0);
      boat.roll = boat.damage.floodingRoll ?? 0;
      boat.pitch = boat.damage.floodingPitch ?? 0;
      stepVesselDamage(boat, 0.25, relTerrain);
    }

    assert.ok(Number.isFinite(boat.heaveVelocity) && Number.isFinite(boat.surgeVelocity), `${label} rigid impulse velocities stay finite`);
    assert.ok(boat.damage.holes.length > 0, `${label} gained hull holes`);
    assert.ok(Object.keys(boat.damage.partDamage).length > 0, `${label} recorded per-part damage`);
    assert.ok((boat.damage.fracture?.brokenCount ?? 0) > 0, `${label} has active broken shards`);
    assert.ok(boat.damage.floodingTonnes > 0, `${label} flooded (${boat.damage.floodingTonnes} t)`);
    assert.ok((boat.damage.floodingSinkage ?? 0) > 0 || (boat.damage.sinkingDepth ?? 0) > 0, `${label} sank into water`);
    assert.ok(Math.abs(boat.damage.floodingRoll ?? 0) > 0 || boat.damage.restingOnBottom, `${label} heeled/settled on bed`);
  }
});

test('stone and timber bridges are cannon-destructible, let walkers cross, float broken timbers, and truncate caravans', () => {
  const { region, heights, port, country } = buildLisbonCountry();
  assert.ok(country.bridges.length > 0, 'Lisbon country generates bridges');
  for (const b of country.bridges) {
    assert.equal(b.collapsed, false);
    assert.ok(Array.isArray(b.cityIndices) && b.cityIndices.length > 0, `bridge carries cityIndices`);
  }

  const compiledTypes = compileCityBuildingTypes(buildPortPrefabGeometry);
  const targets = createCityTargets({ city: country.plan, types: (id) => compiledTypes[id], port });

  const b0 = country.bridges.find((b) => !b.isStone) ?? country.bridges[0];
  const bStone = country.bridges.find((b) => b.isStone);
  assert.equal(targets.inside(b0.x, b0.z, 0.4), false, 'intact bridge deck does not block street walkers');
  assert.ok(bridgeDeckYAt(b0.x, b0.z, country.bridges) > 0, 'bridgeDeckYAt returns positive deck elevation while intact');

  // Horizontal broadside shot from 12 m along river channel must strike the 3D bridge mesh rather than virtual bridgeDeckYAt terrain
  const riverDirX = b0.uz ?? 0, riverDirZ = -(b0.ux ?? 1);
  const hPos = terrainSurfaceSample(heights, b0.x + riverDirX * 12, b0.z + riverDirZ * 12, region);
  const hNeg = terrainSurfaceSample(heights, b0.x - riverDirX * 12, b0.z - riverDirZ * 12, region);
  const sgn = hPos <= hNeg ? 1 : -1;
  const mockTerrain = {
    region,
    port,
    surfaceHeight: (x, z) => terrainSurfaceSample(heights, x, z, region),
    groundSample: (x, z) => Math.max(terrainSurfaceSample(heights, x, z, region), bridgeDeckYAt(x, z, country.bridges)),
    sweepCity: (from, to, radius, opts, fn) => targets.sweep(from, to, radius, opts, fn),
  };
  const solidSweep = createGunnerySolidSweep({ sourceBoat: null, getVessels: () => [], getTerrain: () => mockTerrain });
  const horizHit = solidSweep(
    [b0.x + riverDirX * sgn * 12, b0.deckY - 0.12, b0.z + riverDirZ * sgn * 12],
    [b0.x - riverDirX * sgn * 8, b0.deckY - 0.12, b0.z - riverDirZ * sgn * 8],
    { radius: 0.064, ammo: 'round' },
  );
  assert.equal(horizHit?.kind, 'building', 'horizontal cannon sweep hits 3D bridge mesh instead of virtual bridgeDeckYAt terrain');
  assert.ok(
    horizHit.building.prefabId === 'city_timber_bridge' || horizHit.building.prefabId === 'city_stone_bridge',
    `horizontal shot struck bridge prefab (${horizHit.building.prefabId})`,
  );

  // Fire directly through the timber bridge deck at its world center so we intersect narrow piers/decks reliably.
  const hit = targets.sweep(
    [b0.x, b0.deckY + 6, b0.z],
    [b0.x, b0.deckY - 6, b0.z],
    0.25,
    {},
    sweepBuildingSegment,
  );
  assert.equal(hit?.kind, 'building', 'cannon sweep hits stood city bridge instance');
  assert.ok(
    hit.building.prefabId === 'city_timber_bridge' || hit.building.prefabId === 'city_stone_bridge',
    `struck prefab is bridge (${hit.building.prefabId})`,
  );

  // Verify stone bridge arch targeting as well
  if (bStone) {
    const so = bStone.cityIndices[0] * CITY_TYPED_FLOATS;
    const sx = country.plan.typed[so], sy = country.plan.typed[so + 1], sz = country.plan.typed[so + 2];
    assert.equal(targets.inside(sx, sz, 0.4), false, 'intact stone bridge does not block street walkers');
    const stoneHit = targets.sweep([sx, sy + 6, sz], [sx, sy - 6, sz], 0.25, {}, sweepBuildingSegment);
    assert.equal(stoneHit?.kind, 'building', 'cannon sweep hits stood stone bridge instance');
    assert.equal(stoneHit.building.prefabId, 'city_stone_bridge', 'struck stone bridge has city_stone_bridge prefabId');
  }

  // Verify masonry fracture (and floating timber shards using waterAt)
  const riverY = b0.waterY ?? Math.max(1, b0.deckY - 2.4);
  const bedY = riverY - 2.8;
  const src = hit.building.fractureSource();
  const isTimber = hit.building.prefabId === 'city_timber_bridge';
  const prepared = prepareBuildingFracture({
    vertices: src.vertices,
    indices: src.indices,
    catalog: src.partAssembly,
    instanceIndex: 0,
    instance: hit.building,
    materialClass: isTimber ? 'timber' : 'masonry',
    groundAt: () => bedY,
    waterAt: () => riverY,
  });
  assert.ok(prepared && prepared.fracture.shards.length > 0, 'bridge fracture generates shards');
  const elevatedShards = prepared.fracture.shards.filter((s) => s && /deck|beam|parapet/i.test(s.partKey ?? s.partId ?? ''));
  assert.ok(elevatedShards.length > 0 && elevatedShards.some((s) => !s.stays), 'bridge deck/beam/parapet shards are destructible (!stays)');

  const hitPt = hit.surfacePosition ?? [b0.x, b0.deckY, b0.z];
  const dmgObj = {};
  const brokenTotal = applyBuildingFractureEvents(prepared.fracture, dmgObj, [{
    kind: 'crater',
    x: hitPt[0],
    y: hitPt[1],
    z: hitPt[2],
    nx: 0,
    ny: 1,
    nz: 0,
    severity: 1.8,
    stepDepth: 1.2,
  }], 1.0);
  assert.ok(brokenTotal > 0 && (dmgObj.fracture?.brokenCount ?? 0) > 0, `cannon impact shatters bridge shards (${brokenTotal})`);

  // Also explicitly verify timber bridge shard flotation on waterAt
  const timberDummy = { ...hit.building, prefabId: 'city_timber_bridge' };
  const timberPrep = prepareBuildingFracture({
    vertices: src.vertices,
    indices: src.indices,
    catalog: src.partAssembly,
    instanceIndex: 0,
    instance: timberDummy,
    materialClass: 'timber',
    groundAt: () => bedY,
    waterAt: () => riverY,
  });
  const timberDmg = {};
  const timberBroken = applyBuildingFractureEvents(timberPrep.fracture, timberDmg, [{
    kind: 'crater',
    x: b0.x,
    y: b0.deckY,
    z: b0.z,
    nx: 0,
    ny: 1,
    nz: 0,
    severity: 1.8,
    stepDepth: 1.2,
  }], 1.0);
  assert.ok(timberBroken > 0 && (timberDmg.fracture?.brokenCount ?? 0) > 0, 'timber bridge breaks into shards');
  // Floating timber shards set positive hideAt (records[s * 16 + 11] > 0) rather than resting permanently dry (-1).
  let floatingShards = 0;
  for (let i = 0; i < timberPrep.fracture.shards.length; i++) {
    if (!timberDmg.fracture.broken[i]) continue;
    if (timberDmg.fracture.records[i * 16 + 11] > 0) floatingShards++;
  }
  assert.ok(floatingShards > 0, `broken timber bridge shards float on waterAt (${floatingShards} floating)`);

  // Collapse bridge and verify bridgeDeckYAt + caravanHerdSeeds cutoff
  const ux = b0.ux ?? 1, uz = b0.uz ?? 0;
  const spanDx = ux * 35, spanDz = uz * 35;
  const synthCaravan = [{
    key: 'test-cart-bridge',
    mode: 'cart',
    good: 'wheat',
    qty: 4,
    carts: 1,
    depart: 0,
    arrive: 2,
    points: [b0.x - spanDx, b0.z - spanDz, b0.x, b0.z, b0.x + spanDx, b0.z + spanDz],
  }];
  const intactSeeds = caravanHerdSeeds(synthCaravan, { x: 0, z: 0 }, country.bridges);
  const intactTotalLen = intactSeeds.routes[3];
  assert.ok(intactTotalLen > 50, `intact bridge permits full caravan crossing (${intactTotalLen}m)`);

  b0.collapsed = true;
  assert.equal(bridgeDeckYAt(b0.x, b0.z, country.bridges), 0, 'collapsed bridge removes elevated crossing deck');
  const collapsedSeeds = caravanHerdSeeds(synthCaravan, { x: 0, z: 0 }, country.bridges);
  const collapsedTotalLen = collapsedSeeds.routes[3];
  assert.ok(collapsedTotalLen < intactTotalLen * 0.65, `collapsed bridge truncates caravan route (${collapsedTotalLen}m < ${intactTotalLen}m)`);
});

test('revamped meandered rivers, 12-float hydraulics, estuary convergence shader, and upland river splashes', () => {
  const { region, country } = buildLisbonCountry();

  assert.ok(country.riverReaches.length > 0, 'Lisbon country has river reaches');
  // reachPts items are [wx, wz, hw, wy, depth, vx, vz, thalwegB, estuaryT]
  assert.ok(
    country.riverReaches.some((r) => Array.isArray(r.points) && r.points.length >= 2 && Number.isFinite(r.points[0][7])),
    'reaches carry meandered secondary thalwegB at index 7',
  );

  const iv = country.inlandWater;
  assert.ok(iv?.vertices instanceof Float32Array && iv.vertices.length >= INLAND_WATER_FLOATS * 3);
  assert.equal(INLAND_WATER_FLOATS, 12);
  assert.equal(iv.vertices.length % INLAND_WATER_FLOATS, 0, 'inlandWater vertices aligned to 12-float hydraulic stride');

  let maxHydroPacked = 0;
  let maxEstuaryT = 0;
  for (let i = 0; i < iv.vertices.length; i += INLAND_WATER_FLOATS) {
    const est = iv.vertices[i + 3];
    const hydro = iv.vertices[i + 11];
    assert.ok(Number.isFinite(est) && Number.isFinite(hydro));
    if (est > maxEstuaryT) maxEstuaryT = est;
    if (hydro > maxHydroPacked) maxHydroPacked = hydro;
  }
  assert.ok(maxHydroPacked > 0.01, 'hydraulic vertices pack non-zero eddy/riffle intensity');
  assert.ok(maxEstuaryT > 0.05, 'river mouths include seaward estuary plume feathering (estuaryT > 0)');

  // WGSL must sample ocean wave/spectral displacement textures for river-to-sea convergence
  assert.match(INLAND_WATER_WGSL, /textureSampleLevel\(dispTex/);
  assert.match(INLAND_WATER_WGSL, /textureSampleLevel\(derivTex/);
  assert.match(INLAND_WATER_WGSL, /textureSampleLevel\(momTex/);
  assert.match(INLAND_WATER_WGSL, /coastalWaveState/);

  const sampler = createInlandWaterSampler(country);
  let uplandPt = null;
  for (const reach of country.riverReaches) {
    for (const p of reach.points) {
      if (p[3] > 2.5) {
        uplandPt = { x: p[0], z: p[1], wy: p[3] };
        break;
      }
    }
    if (uplandPt) break;
  }
  assert.ok(uplandPt, 'upland river station above sea level exists');

  const hitWater = sampler(uplandPt.x, uplandPt.z);
  assert.ok(hitWater && hitWater.wy > 2.0 && hitWater.hw > 0, 'spatial sampler returns upland river surface height and half-width');
  assert.ok(Number.isFinite(hitWater.vx) && Number.isFinite(hitWater.vz) && Number.isFinite(hitWater.depth));

  const cannonSplash = sweepTerrainSegment(
    [uplandPt.x, hitWater.wy + 9, uplandPt.z],
    [uplandPt.x, hitWater.wy - 3, uplandPt.z],
    0.09,
    { region, groundSample: () => hitWater.wy - 1.5, inlandWaterAt: sampler },
  );
  assert.equal(cannonSplash?.kind, 'water', 'cannonball into upland river registers water splash');
  assert.ok(Math.abs(cannonSplash.waterSurfaceY - hitWater.wy) < 0.25, 'splash occurs at upland river water surface elevation');
});

function createMockTradeEnv(t) {
  const prevBuf = globalThis.GPUBufferUsage;
  const prevTex = globalThis.GPUTextureUsage;
  globalThis.GPUBufferUsage = { VERTEX: 1, INDEX: 2, UNIFORM: 4, STORAGE: 8, COPY_DST: 16, COPY_SRC: 32, INDIRECT: 256 };
  globalThis.GPUTextureUsage = { TEXTURE_BINDING: 1, COPY_DST: 2 };
  const prevStage = globalThis.GPUShaderStage;
  globalThis.GPUShaderStage = { VERTEX: 1, FRAGMENT: 2, COMPUTE: 4 };
  t.after(() => {
    if (prevBuf === undefined) delete globalThis.GPUBufferUsage; else globalThis.GPUBufferUsage = prevBuf;
    if (prevTex === undefined) delete globalThis.GPUTextureUsage; else globalThis.GPUTextureUsage = prevTex;
    if (prevStage === undefined) delete globalThis.GPUShaderStage; else globalThis.GPUShaderStage = prevStage;
  });

  let destroyedDamagedBuffers = 0;
  const mockDevice = {
    createBuffer: ({ label = '', size, usage = 0 }) => ({
      label,
      size,
      usage,
      destroy() {
        if (label.startsWith('trade vessel damaged') || label.startsWith('trade vessel hull damage') || label.startsWith('trade vessel pose')) {
          destroyedDamagedBuffers++;
        }
      },
    }),
    createTexture: () => ({ createView: () => ({}), destroy() {} }),
    createSampler: () => ({}),
    createRenderPipelineAsync: async ({ label } = {}) => ({ label, getBindGroupLayout: () => ({}) }),
    createComputePipelineAsync: async ({ label } = {}) => ({ label, getBindGroupLayout: () => ({}) }),
    createShaderModule: () => ({}),
    createBindGroup: () => ({}),
    createBindGroupLayout: () => ({}),
    createPipelineLayout: () => ({}),
    queue: { writeBuffer() {}, writeTexture() {} },
  };
  const mockResources = [0, 1, 2, 3, 4, 12, 19, 20, 21].map((b) => [b, {}]);
  // The ships' continuum bodies, read from the checkout as the game fetches them.
  const fetchAsset = async (file) => new Response(readFileSync(new URL('../' + file, import.meta.url)));
  return {
    mockDevice,
    mockResources,
    fetchAsset,
    get destroyedDamagedBuffers() { return destroyedDamagedBuffers; },
  };
}

test('trade vessels preserve damaged hulls, GPU state, and consistent yaw across setTraffic refreshes', async (t) => {
  const env = createMockTradeEnv(t);
  const { mockDevice, mockResources } = env;

  const tv = await createTradeVessels({
    device: mockDevice,
    shader: async () => ({}),
    computePipe: async () => ({ getBindGroupLayout: () => ({}) }),
    resources: mockResources,
    fetchAsset: env.fetchAsset,
  });
  t.after(() => tv.destroy());

  const origin = { x: 0, z: 0 };
  const snapshot1 = {
    day: 10,
    ships: [
      { id: 27, kind: 'carrack', phase: 'dock', t0: 9, t1: 12, berth: { x: 120, z: 40, rot: 0.72 } },
      { id: 28, kind: 'caravel', phase: 'in', t0: 8, t1: 12, points: [200, 100, 420, 180] },
    ],
    list: [],
  };
  tv.setTraffic(snapshot1, origin, [], [{ x: 0, z: 0, harbor: true, kind: 'town' }], {});
  tv.stepSimulation(0.25, 1.0, 8, null);

  const b27 = tv.getTargetVessels().find((b) => b.id === 'ship:27');
  assert.ok(b27, 'anchored dock vessel exposed as gunnery target');
  assert.ok(Math.abs(b27.yaw - 0.72) < 1e-6, 'boat.yaw matches berth orientation in radians');
  assert.ok(Math.abs(b27.heading - (0.72 * 180) / Math.PI) < 1e-4, 'boat.heading matches boat.yaw in degrees');

  // Inflict hull damage & trigger promoteDamagedBoat
  const yaw = b27.yaw;
  const nx = Math.cos(yaw), nz = Math.sin(yaw);
  const hit = sweepShipSegment(
    [b27.x + nx * 18, b27.heave + 0.3, b27.z + nz * 18],
    [b27.x - nx * 18, b27.heave - 0.2, b27.z - nz * 18],
    0.09,
    b27,
  );
  assert.equal(hit?.kind, 'ship', 'broadside sweep using boat.yaw strikes vessel hull');
  applyShipImpactDamage(b27, {
    ...hit,
    surfacePosition: [b27.x, b27.heave + 0.1, b27.z],
    velocity: [-nx * 240, -10, -nz * 240],
    mass: 10.9,
    ammo: 'round',
  });
  tv.stepSimulation(0.1, 1.1, 8, null);
  await new Promise((r) => setTimeout(r, 15));
  assert.ok(b27.damage.hits > 0 && b27.damage.holes.length > 0, 'vessel records cannon hit and hull hole');

  // Refresh board snapshot with new day while ship:27 remains, then again after ship:27 drops from snapshot
  tv.setTraffic({ ...snapshot1, day: 11 }, origin, [], [], null);
  tv.setTraffic({ day: 12, ships: [snapshot1.ships[1]], list: [] }, origin, [], [], null);
  tv.stepSimulation(0.1, 1.2, 8, null);

  const after = tv.getTargetVessels().find((b) => b.id === 'ship:27');
  assert.equal(after, b27, 'damaged boat instance is preserved across setTraffic refreshes');
  assert.ok(after.damage.hits > 0 && after.damage.holes.length > 0, 'hull damage persists after setTraffic refreshes');
  assert.equal(env.destroyedDamagedBuffers, 0, 'promoted damaged GPU buffers are not torn down during board refreshes');
});

test('windward sailing polars, storm reefing, and autonomous headwind tacking', () => {
  const windVec = [0, 9]; // Blowing southward (+Z), so upwind is due North (yaw = 0)
  const deadHead = computeSailingPolar(0, windVec, 0);
  const broadReach = computeSailingPolar(Math.PI * 0.65, windVec, 0);
  const downwind = computeSailingPolar(Math.PI, windVec, 0);
  assert.ok(broadReach.targetSpeed > deadHead.targetSpeed * 3, 'broad reach speed vastly exceeds direct headwind speed');
  assert.ok(downwind.targetSpeed > deadHead.targetSpeed * 2.5, 'downwind speed exceeds direct headwind speed');

  const cogPolar = computeSailingPolar(0, windVec, 0);
  const lateenPolar = computeSailingPolar(0, windVec, 5);
  assert.ok(lateenPolar.beta < cogPolar.beta, 'lateen caravel points closer to the wind than square-rigged cog');

  const stormPolar = computeSailingPolar(Math.PI * 0.5, [0, 18], 0, { storm: true });
  assert.ok(stormPolar.targetSailSet < 0.6, `storm gale reefs sailSet (${stormPolar.targetSailSet})`);

  // Inbound cog trying to sail due North into a southward headwind must tack cleanly without yaw snaps
  const route = {
    id: 'ship:tack',
    shipId: 101,
    mode: 'sea',
    phase: 'in',
    archetype: 0,
    scale: 1,
    pts: [
      { x: 0, y: 0, z: 400, acc: 0 },
      { x: 0, y: 0, z: -400, acc: 800 },
    ],
    totalLen: 800,
    phaseOffset: 0.2,
  };
  const ai = createVesselAutopilotState(route, 0, { x: 0, y: 0, z: 400, yaw: 0, dist: 0 }, 0);
  let sawTack = false;
  let maxYawStep = 0;
  for (let i = 1; i <= 120; i++) {
    const prevYaw = ai.yaw;
    stepTradeVesselAutopilot(ai, route, 0, { dt: 0.25, elapsedSec: i * 0.25, windVec });
    let dy = ai.yaw - prevYaw;
    while (dy > Math.PI) dy -= Math.PI * 2;
    while (dy < -Math.PI) dy += Math.PI * 2;
    maxYawStep = Math.max(maxYawStep, Math.abs(dy));
    if (ai.tacking) sawTack = true;
  }
  assert.ok(sawTack, 'cog enters autonomous tacking when course lies inside the no-go zone');
  assert.ok(maxYawStep < 0.15, `turn rate remains physically bounded per 0.25s step (maxYawStep=${maxYawStep})`);
  assert.ok(Math.abs(ai.yaw) >= 0.70, `ship steers outside headwind irons onto close-hauled tack (${ai.yaw} rad)`);
  assert.ok(ai.z < 390, `ship makes genuine northward progress while tacking (z=${ai.z})`);
});

test('zero-warp port lifecycle and smooth GPU sail brailing across setTraffic transitions', async (t) => {
  const env = createMockTradeEnv(t);
  const { mockDevice, mockResources } = env;
  const tv = await createTradeVessels({
    device: mockDevice,
    shader: async () => ({}),
    computePipe: async () => ({ getBindGroupLayout: () => ({}) }),
    resources: mockResources,
    fetchAsset: env.fetchAsset,
  });
  t.after(() => tv.destroy());

  const origin = { x: 0, z: 0 };
  const pts = [0, 260, 0, 90, 0, 25];
  const berth = { x: 0, z: 0, rot: 0.85 };
  tv.setTraffic({
    day: 1,
    ships: [{ id: 41, kind: 'carrack', phase: 'in', t0: 0, t1: 2, points: pts, portBerths: [berth] }],
    list: [],
  }, origin, [], [], {});

  // Favoring tailwind (southward wind doesn't push North; push North with northward windVec = [0, -8])
  let simTime = 0;
  for (let i = 0; i < 60; i++) {
    simTime += 0.25;
    tv.stepSimulation(0.25, simTime, { windVec: [0, -8], storm: false }, null);
  }
  const beforeDock = tv.locate().find((v) => v.id === 'ship:41');
  assert.ok(beforeDock, 'ship:41 active before dock transition');

  // Board switches phase to dock while vessel physically completes approach/docking without warping
  tv.setTraffic({
    day: 2,
    ships: [{ id: 41, kind: 'carrack', phase: 'dock', t0: 0, t1: 2, until: 6, berth, points: pts, portBerths: [berth] }],
    list: [],
  }, origin, [], [], {});
  const rightAfterDock = tv.locate().find((v) => v.id === 'ship:41');
  const jumpIn = Math.hypot(rightAfterDock.x - beforeDock.x, rightAfterDock.z - beforeDock.z);
  assert.ok(jumpIn < 1.0, `in -> dock transition causes zero teleport jump (${jumpIn}m)`);

  for (let i = 0; i < 400; i++) {
    simTime += 0.25;
    tv.stepSimulation(0.25, simTime, { windVec: [0, -8], storm: false }, null);
    if (tv.locate().find((v) => v.id === 'ship:41')?.aiState === 'docked') break;
  }
  const docked = tv.locate().find((v) => v.id === 'ship:41');
  assert.equal(docked.aiState, 'docked', 'ship autonomously maneuvers all the way into docked state');
  assert.ok(Math.hypot(docked.x - berth.x, docked.z - berth.z) <= 2.5, 'docked hull rests cleanly alongside berth');
  assert.ok(docked.sailSet < 0.20, `docked carrack smoothly brails sails (sailSet=${docked.sailSet})`);

  // Board switches phase to out: ship unfurls canvas and departs without warping
  tv.setTraffic({
    day: 6,
    ships: [{ id: 41, kind: 'carrack', phase: 'out', t0: 6, t1: 10, points: pts, portBerths: [berth] }],
    list: [],
  }, origin, [], [], {});
  const rightAfterOut = tv.locate().find((v) => v.id === 'ship:41');
  const jumpOut = Math.hypot(rightAfterOut.x - docked.x, rightAfterOut.z - docked.z);
  assert.ok(jumpOut < 1.0, `dock -> out transition causes zero teleport jump (${jumpOut}m)`);

  for (let i = 0; i < 80; i++) {
    simTime += 0.25;
    tv.stepSimulation(0.25, simTime, { windVec: [0, 8], storm: false }, null);
  }
  const departed = tv.locate().find((v) => v.id === 'ship:41');
  assert.ok(departed.aiState === 'departing' || departed.aiState === 'outbound', `departed state active (${departed.aiState})`);
  assert.ok(departed.sailSet > 0.50, `departing carrack smoothly unfurls sails (sailSet=${departed.sailSet})`);
});

test('river current drift and upstream vs downstream oar cadence', () => {
  const routeDown = {
    id: 'river:test',
    mode: 'river',
    phase: 'shuttle',
    archetype: 4,
    scale: 0.85,
    pts: [
      { x: 0, y: 4, z: 0, vx: 1.5, vz: 0, acc: 0 },
      { x: 500, y: 3, z: 0, vx: 1.5, vz: 0, acc: 500 },
    ],
    totalLen: 500,
    phaseOffset: 0.5,
  };
  const riverFlowAt = () => ({ wy: 3.5, vx: 1.5, vz: 0, depth: 2.2 });

  const aiDown = createVesselAutopilotState(routeDown, 4, { x: 250, y: 3.5, z: 0, yaw: Math.PI * 0.5, dist: 250 }, 0);
  aiDown.dirSign = 1;
  aiDown.wpIndex = 1;

  const aiUp = createVesselAutopilotState(routeDown, 4, { x: 250, y: 3.5, z: 0, yaw: -Math.PI * 0.5, dist: 250 }, 0);
  aiUp.dirSign = -1;
  aiUp.wpIndex = 0;

  for (let i = 1; i <= 16; i++) {
    stepTradeVesselAutopilot(aiDown, routeDown, 4, { dt: 0.25, elapsedSec: i * 0.25, riverFlowAt });
    stepTradeVesselAutopilot(aiUp, routeDown, 4, { dt: 0.25, elapsedSec: i * 0.25, riverFlowAt });
  }
  assert.ok(aiDown.speed > aiUp.speed + 0.4, `downstream speed (${aiDown.speed}) exceeds upstream speed (${aiUp.speed})`);
  assert.ok(aiUp.motion > aiDown.motion + 0.2, `upstream oar cadence (${aiUp.motion}) exceeds downstream drifting cadence (${aiDown.motion})`);
});

test('two-way simTick coupling delays headwind arrivals, docks physically, holds in storms, and loses sunk vessels', async () => {
  const gameSrc = readFileSync(new URL('../assets/board/game.js', import.meta.url), 'utf8');
  const runtimeSrc = readFileSync(new URL('../assets/board/runtime.js', import.meta.url), 'utf8');
  const sha = createHash('sha256').update(gameSrc).digest('hex');
  const baked = JSON.parse(readFileSync(new URL('../' + BAKED_BOARDS['lisbon:1550'], import.meta.url), 'utf8'));
  const prefix = boardPrefix({ ...baked.request, heights: null }, sha);

  const ctx = vm.createContext({
    setTimeout,
    clearTimeout,
    console,
    TextEncoder,
    TextDecoder,
    CompressionStream,
    DecompressionStream,
    Blob,
    Response,
    atob,
    btoa,
    addEventListener: () => {},
    removeEventListener: () => {},
    requestAnimationFrame: () => 0,
    postMessage: () => {},
  });
  vm.runInContext(
    `${prefix}${gameSrc}\n${runtimeSrc}\nglobalThis.__TEST = { get W() { return W; }, day, berthsOf, lordAcct, purse, fastMaritimeMode() { simTick = () => { W.clock.day++; tickShips(); tickShipDepartures(); return true; }; } };`,
    ctx,
  );
  await ctx.BOARD_MODEL.thaw(readFileSync(new URL('../' + BAKED_WORLDS['lisbon:1550'], import.meta.url)));
  ctx.__TEST.fastMaritimeMode();

  const W = ctx.__TEST.W;
  const harborSi = W.settlements.findIndex((s) => s.harbor && ctx.__TEST.berthsOf(s).length > 0);
  assert.ok(harborSi >= 0, 'thawed Lisbon board has a harbor settlement with berths');
  const s = W.settlements[harborSi];
  const curDay = ctx.__TEST.day();
  for (const o of W.ships) {
    o.phase = 'out';
    o.t1 = curDay + 100;
  }

  // 1. Headwind / slow ETA delays ship past original t1 instead of warping into berth
  const shipDelay = {
    id: 501,
    kind: 'cog',
    from: 'Bruges',
    port: harborSi,
    cargo: { spice: 30 },
    load: {},
    phase: 'in',
    t0: curDay - 5,
    t1: curDay,
    poly: [{ x: 0, z: 300 }, { x: 0, z: 20 }],
    len: 280,
    berth: null,
  };
  W.ships.push(shipDelay);
  const spiceAtStart = s.stores.spice || 0;
  ctx.BOARD_MODEL.pilotMaritime({
    day: curDay,
    ships: [{ id: 501, state: 'inbound', etaDays: 4.0, progress: 0.4 }],
  });
  await ctx.BOARD_MODEL.live(1);
  assert.equal(shipDelay.phase, 'in', 'headwind etaDays keeps ship inbound instead of forcing arrival on schedule');
  assert.equal(s.stores.spice || 0, spiceAtStart, 'delayed ship cargo has not unloaded before physical arrival');

  // 2. Physical arrival triggers docking, unloads cargo into stores, and credits customs silver
  const goldBeforeDock = ctx.__TEST.purse(ctx.__TEST.lordAcct(s));
  ctx.BOARD_MODEL.pilotMaritime({
    day: ctx.__TEST.day(),
    ships: [{ id: 501, state: 'docked', etaDays: 0, progress: 1.0 }],
  });
  await ctx.BOARD_MODEL.live(1);
  assert.equal(shipDelay.phase, 'dock', 'docked maritime report transitions ship to dock phase');
  assert.ok((s.stores.spice || 0) >= spiceAtStart + 30, 'physical arrival delivers cargo to port stores');
  assert.ok(ctx.__TEST.purse(ctx.__TEST.lordAcct(s)) > goldBeforeDock, 'physical arrival credits customs revenue to lord purse');

  // 3. Storm weather holds docked ship at quay past original until day
  shipDelay.until = ctx.__TEST.day();
  ctx.BOARD_MODEL.pilotMaritime({
    day: ctx.__TEST.day(),
    storm: true,
    ships: [{ id: 501, state: 'docked', heldByWeather: true, progress: 1.0 }],
  });
  await ctx.BOARD_MODEL.live(1);
  assert.equal(shipDelay.phase, 'dock', 'storm report holds docked ship in harbor past scheduled until day');

  // 4. Sinking removes vessel from W.ships without delivering its cargo
  const silkBefore = s.stores.silk || 0;
  const shipSunk = {
    id: 502,
    kind: 'caravel',
    from: 'Venice',
    port: harborSi,
    cargo: { silk: 25 },
    load: {},
    phase: 'in',
    t0: ctx.__TEST.day() - 4,
    t1: ctx.__TEST.day(),
    poly: [{ x: 0, z: 300 }, { x: 0, z: 20 }],
    len: 280,
    berth: null,
  };
  W.ships.push(shipSunk);
  ctx.BOARD_MODEL.pilotMaritime({
    day: ctx.__TEST.day(),
    ships: [
      { id: 501, state: 'docked', heldByWeather: false, progress: 1.0 },
      { id: 502, state: 'sunk', sunk: true },
    ],
  });
  await ctx.BOARD_MODEL.live(1);
  assert.equal(W.ships.find((x) => x.id === 502), undefined, 'sunk ship is removed from board fleet');
  assert.equal(s.stores.silk || 0, silkBefore, 'sunk ship cargo is never credited to harbor stores');
});

test('every trade vessel draws through the one continuum: clusters, far body and splat, zero-discard sample_mask shaders', () => {
  // The bodies and their guarantees are held by tests/ship-continuum-bake.test.mjs; here, the material that draws them.
  const archs = inspectTradeVesselArchetypes();
  assert.equal(archs.length, TRADE_VESSEL_ARCHETYPES);
  for (const arch of archs) assert.equal(arch.continuum, undefined, `${arch.label} carries no stand-in of its own`);
  const seen = tradeVesselView();
  for (const entry of [/@vertex\s+fn\s+continuumVS\(/, /@fragment\s+fn\s+continuumFS\(/]) assert.match(seen, entry);
  // A damaged ship is the same record with the DAMAGED flag: what shot has holed, parted or torn leaves her samples
  // through her material's mask, ANDed into the handoff's; nothing drops a fragment.
  assert.equal(TRADE_VESSEL_CONTINUUM_MATERIAL.mask, true);
  assert.match(seen, /tradeVesselContinuumMask\(/, 'the material masks a damaged vessel\'s samples');
  assert.match(seen, /@builtin\(sample_mask\)/, 'the view outputs @builtin(sample_mask)');
  assert.ok(!/\bdiscard\b/.test(seen), 'the trade vessels\' view contains zero discard statements (TBDR clean)');
  assert.ok(!/\bdiscard\b/.test(TRADE_VESSEL_CONTINUUM_MATERIAL.wgsl()), 'the trade vessels\' material contains zero discard statements');
  for (const pass of ['select', 'shadow']) assert.ok(!/\bdiscard\b/.test(continuumModuleWGSL({ pass })), `the one cut's ${pass} contains zero discard statements`);
});

test('Lisbon 1550 riverboats lock strictly inside rendered riverReaches at exact water elevation, with loaded draft, proportional Y scale, GPU wave compute, drawSubmerged & wake sources', async (t) => {
  const { baked, region, heights, port, country } = buildLisbonCountry();
  const inlandWaterAt = createInlandWaterSampler(country);
  assert.ok(country.riverReaches.length > 0, 'Lisbon country builds rendered riverReaches');

  // Verify WGSL TBDR & storage-buffer discipline
  const waveStorageCount = (TRADE_VESSEL_WAVE_WGSL.match(/var<storage\b/g) || []).length;
  assert.ok(waveStorageCount <= 8, `TRADE_VESSEL_WAVE_WGSL storage buffers (${waveStorageCount}) must stay <= 8`);
  // Under water a vessel is her own material composed through the water's capture (js/water-optics.js): single-sampled,
  // it drops what lies past the sea's surface and, by her mask, what shot has holed, parted or torn, so her holes read
  // from below as from above. Her view drops nothing.
  assert.match(tradeVesselCapture(), /fn\s+continuumCaptureVS\(/, 'the capture composes the trade vessels\' material');
  assert.match(TRADE_VESSEL_CONTINUUM_CAPTURE_MATERIAL.wgsl(), /if \(tradeVesselContinuumMask\(in, front\) == 0u\) \{ discard; \}/, 'the capture leaves out what shot took');
  assert.ok(!/\bdiscard\b/.test(TRADE_VESSEL_CONTINUUM_MATERIAL.wgsl()), 'the trade vessels\' material contains zero discard statements');
  // The hull is scaled proportionally on X/Y/Z: her record's one scale, her type's design scale (js/ship-continuum.js).
  assert.match(tradeVesselView(), /continuumTypeF\(s\.model,\s*\d+u\)/, 'the material reads her type\'s design scale');

  const env = createMockTradeEnv(t);
  const { mockDevice, mockResources } = env;
  const computeOrder = [];
  let capturedSubmergedBound = 0;
  let submergedDraws = 0;
  // The water's optics as js/water-optics.js gives them: a capture composed whole from the material's view.
  const mockWaterOptics = {
    capture() { throw Error('the trade vessels compose their capture whole'); },
    captureDirective: WATER_CAPTURE_DIRECTIVE,
    captureTail: (options) => waterCaptureWGSL({ ...options, surfaceWaves: false }),
    async captureComposed(spec) {
      assert.equal(spec.vertex.entryPoint, 'continuumCaptureVS');
      assert.ok(spec.source.includes('fn continuumCaptureVS'));
      assert.ok(spec.source.includes('fn tradeVesselContinuumShade'), 'the capture is composed from the trade vessels\' material');
      return {
        pipeline: { getBindGroupLayout: () => ({}) },
        entry: 'submergedFS',
        bindGroup: () => ({}),
        bind(pass, above) {
          assert.equal(typeof above, 'boolean');
          capturedSubmergedBound++;
        },
      };
    },
  };

  const tv = await createTradeVessels({
    device: mockDevice,
    shader: async (_src, label) => ({ label, getBindGroupLayout: () => ({}) }),
    computePipe: async (_src, label) => ({ label, getBindGroupLayout: () => ({}) }),
    resources: mockResources,
    fetchAsset: env.fetchAsset,
    oceanBridge: {
      dispTex: { createView: () => ({}) },
      waterOptics: mockWaterOptics,
    },
  });
  t.after(() => tv.destroy());

  const world = new Uint8Array(readFileSync(new URL('../' + BAKED_WORLDS['lisbon:1550'], import.meta.url)));
  const board = await openBoard(baked.request, { world });
  let snap;
  try {
    snap = await board.hook('caravans');
  } finally {
    await board.close();
  }

  const portWithCountry = { ...port, country };
  const mockTerrain = {
    region,
    bridges: country.bridges,
    inlandWaterAt,
    height: (wx, wz) => terrainSurfaceSample(heights, wx, wz, region),
    waveShelter: () => 0.85,
  };

  tv.setTraffic(snap, region, country.riverReaches, [], {
    port: portWithCountry,
    bridges: country.bridges,
    inlandWaterAt,
    region,
    heights,
  });

  let maxRiverLatRatio = 0;
  let maxWaterElevErr = 0;
  let riverStepSamples = 0;

  for (let step = 0; step < 180; step++) {
    tv.stepSimulation(0.25, step * 0.25, { windSpeed: 8.5, windDir: 0.4 }, mockTerrain);
    if (step % 15 === 0) {
      const located = tv.locate();
      const riverBoats = located.filter((v) => v.mode === 'river');
      assert.ok(riverBoats.length >= 1, `expected >= 1 active riverboat at step ${step}`);
      for (const rb of riverBoats) {
        const arch = getTradeVesselArchetype(rb.archetype);
        const halfBeam = arch.beam * rb.scale * 0.5;
        assert.ok(rb.channelHw > halfBeam, `riverboat ${rb.id} sits in navigable reach (hw=${rb.channelHw}, halfBeam=${halfBeam})`);
        const latOuter = Math.abs(rb.crossTrackM) + halfBeam;
        assert.ok(
          latOuter <= rb.channelHw + 1e-3,
          `riverboat ${rb.id} stays strictly inside channel ribbon (|dLat|+halfBeam=${latOuter.toFixed(3)} <= hw=${rb.channelHw})`,
        );
        maxRiverLatRatio = Math.max(maxRiverLatRatio, latOuter / rb.channelHw);

        const iw = inlandWaterAt(rb.worldX, rb.worldZ);
        if (iw) {
          const wyErr = Math.abs(rb.waterY - iw.wy);
          maxWaterElevErr = Math.max(maxWaterElevErr, wyErr);
          assert.ok(wyErr < 0.08, `riverboat ${rb.id} waterY=${rb.waterY.toFixed(3)} matches rendered inlandWater wy=${iw.wy.toFixed(3)} (no levitation ratchet)`);
        } else {
          // Only sea-mouth transition station can touch y=0 coastal water
          assert.ok(Math.abs(rb.waterY) < 0.08, `sea-mouth riverboat ${rb.id} transitions smoothly to sea level (waterY=${rb.waterY})`);
        }
        assert.ok(rb.draft >= 0.24 && rb.draft <= 0.35, `riverboat ${rb.id} loaded draft ${rb.draft.toFixed(3)}m sits 0.24-0.34m deep`);
        const keelImmersion = rb.waterY - (rb.y - rb.lightDraft);
        if (rb.waterY > 0.40) {
          assert.ok(rb.y < rb.waterY - 0.01 && keelImmersion >= 0.24 && keelImmersion <= 0.35, `upland riverboat ${rb.id} hull sits ${keelImmersion.toFixed(3)}m immersed below river surface (y=${rb.y.toFixed(3)} < waterY=${rb.waterY.toFixed(3)})`);
        } else {
          assert.ok(rb.sinkage >= 0.014 && keelImmersion >= 0.16, `estuary-mouth riverboat ${rb.id} rides swell while staying ${keelImmersion.toFixed(3)}m immersed`);
        }
        riverStepSamples++;
      }
    }
  }
  assert.ok(riverStepSamples >= 12, `sampled >= 12 riverboat trajectory frames (${riverStepSamples})`);
  assert.ok(maxRiverLatRatio < 0.96, `riverboat outer beam never breaches bank (max ratio ${maxRiverLatRatio.toFixed(3)})`);

  // Verify sea ship loaded hydrostatic sinkage & proportional crew foot deck height
  const finalLocated = tv.locate();
  const seaShips = finalLocated.filter((v) => v.mode === 'sea');
  assert.ok(seaShips.length >= 4, `expected >= 4 sea vessels, got ${seaShips.length}`);
  for (const sh of seaShips) {
    assert.ok(sh.sinkage >= 0.14 && sh.sinkage <= 0.50, `sea vessel ${sh.id} (${sh.archLabel}) has realistic loaded sinkage=${sh.sinkage}m`);
    if (sh.deckPeople?.length) {
      const arch = getTradeVesselArchetype(sh.archetype);
      const st0 = arch.deckStations.find((s) => s.station === sh.deckPeople[0].station);
      if (st0 && Math.abs(sh.pitch) < 1e-4 && Math.abs(sh.roll) < 1e-4) {
        const expectedFootY = sh.y + st0.localMetres[1] * sh.scale;
        assert.ok(Math.abs(sh.deckPeople[0].y - expectedFootY) < 1e-3, 'crew feet sit flush on proportionally Y-scaled deck');
      }
    }
  }

  // Verify GPU wave buoyancy compute pass runs BEFORE the continuum cut & crew-selection, and drawSubmerged executes cleanly
  const computePass = {
    setPipeline(p) { computeOrder.push(p?.label || 'unknown'); },
    setBindGroup() {},
    dispatchWorkgroups() {},
  };
  tv.encode(computePass);
  const waveIdx = computeOrder.indexOf('trade vessel wave hydro');
  const cutIdx = computeOrder.indexOf('continuum cut');
  assert.ok(waveIdx === 0, `GPU wave buoyancy pass runs first in encode() (order=${computeOrder.join(' -> ')})`);
  assert.ok(cutIdx > waveIdx, 'GPU wave buoyancy writes pose before the one continuum cut runs');

  // The continuum census reads every indirect draw draw() submits in the main pass from its own arguments: the one
  // scene's view lists, damaged vessels among them.
  const census = tv.continuumDraws();
  const vesselDraws = census.filter((d) => d.buffer.label === 'trade vessel continuum draws');
  assert.deepEqual(
    vesselDraws.map((d) => [d.offset, d.records, d.stride]),
    [[CONTINUUM_DRAW_WORDS * 4, CONTINUUM_VIEW_LISTS, 1]],
    'census lists the scene\'s view lists: clusters, small clusters, far bodies and splats',
  );
  assert.equal(vesselDraws.length, census.length, 'every vessel draw is the continuum\'s');
  for (const d of census) {
    assert.ok(d.buffer.usage & GPUBufferUsage.COPY_SRC, `${d.buffer.label} can be copied by the census`);
    assert.ok(d.offset + d.records * d.stride * 4 <= d.buffer.size, `${d.buffer.label} census region lies inside the buffer`);
  }

  const subPass = {
    setPipeline() {},
    setBindGroup() {},
    setVertexBuffer() {},
    drawIndirect(buffer, offset) { submergedDraws++; submergedArgs.push([buffer.label, offset]); },
  };
  const submergedArgs = [];
  tv.drawSubmerged(subPass, false);
  assert.equal(capturedSubmergedBound, 1, 'drawSubmerged binds waterOptics submerged capture pipeline');
  const coarse = CONTINUUM_LISTS.slice(CONTINUUM_VIEW_LISTS).map((_, k) => ['trade vessel continuum draws', (CONTINUUM_VIEW_LISTS + k) * 16]);
  assert.equal(submergedDraws, coarse.length, 'drawSubmerged draws the scene\'s coarse lists once each');
  assert.deepEqual(submergedArgs, coarse, 'the capture draws the shadow map\'s lists: the coarse cut');

  // Verify getWakeSources() returns compact moving-vessel descriptors sorted by distance
  const wakes = tv.getWakeSources({ x: region.x, z: region.z }, 24);
  assert.ok(wakes.length >= 2 && wakes.length <= 24, `expected 2..24 moving wake hulls, got ${wakes.length}`);
  for (let i = 0; i < wakes.length; i++) {
    const w = wakes[i];
    const spd = Math.hypot(w.vx, w.vz);
    assert.ok(spd > 0.20, `wake source ${i} speed ${spd.toFixed(3)} > 0.20 m/s`);
    assert.ok(w.length > 4 && w.beam > 1 && w.draft >= 0.20 && w.displacement > 0.5 && typeof w.isRiver === 'boolean');
    if (i > 0) {
      const dPrev = Math.hypot(wakes[i - 1].x - region.x, wakes[i - 1].z - region.z);
      const dCur = Math.hypot(w.x - region.x, w.z - region.z);
      assert.ok(dCur + 1e-6 >= dPrev, 'getWakeSources sorts nearest vessels first');
    }
  }
});

test('riverboat oarsmen physically grip their rotating wooden oar shafts across all 8 sweep stations and 24 stroke frames', async () => {
  const { readFileSync } = await import('node:fs');
  const { loadCrewGLB } = await import('../js/gltf.js');
  const { bakeDeckCrewClips, bargeOarPivotsForWGSL } = await import('../js/trade-vessels.js');
  const barge = getTradeVesselArchetype(4);
  const pivots = bargeOarPivotsForWGSL();
  const ds = barge.designScale;
  const bv = barge.vertices;
  const sailor = loadCrewGLB(readFileSync(new URL('../assets/crew/sailor.glb', import.meta.url)));
  const a = sailor.animator;
  a.sample(null, 0);
  const slotOf = (name) => a.joints.indexOf(a.nodeIndex(name));
  const handLSlot = slotOf('hand_l'), handRSlot = slotOf('hand_r');
  const restHandL = [...a.world[a.nodeIndex('hand_l')].subarray(12, 15)];
  const restHandR = [...a.world[a.nodeIndex('hand_r')].subarray(12, 15)];
  const { palettes, layout } = bakeDeckCrewClips(a);

  const rowStations = barge.deckStations.filter((s) => Number.isFinite(s.oarSide) && Number.isFinite(s.oarStationIdx));
  assert.equal(rowStations.length, 8, 'river barge mans 4 port + 4 starboard sweep stations');

  const pointSegDist = (p, a0, b0) => {
    const abx = b0[0] - a0[0], aby = b0[1] - a0[1], abz = b0[2] - a0[2];
    const t = Math.max(0, Math.min(1, ((p[0] - a0[0]) * abx + (p[1] - a0[1]) * aby + (p[2] - a0[2]) * abz) / (abx * abx + aby * aby + abz * abz)));
    return Math.hypot(p[0] - (a0[0] + abx * t), p[1] - (a0[1] + aby * t), p[2] - (a0[2] + abz * t));
  };

  let worstGripDist = 0;
  for (const st of rowStations) {
    const side = st.oarSide;
    const stIdx = st.oarStationIdx;
    const px = pivots[stIdx * 4 + 0], py = pivots[stIdx * 4 + 1], pz = pivots[stIdx * 4 + 2];
    let bestInboardX = Infinity;
    const oarPts = [];
    for (let i = 0; i < bv.length; i += 9) {
      const m = bv[i + 6];
      if (Math.floor(m) === 16 && Math.round((m - 16) * 64) === stIdx + 1) {
        const vx = bv[i], vy = bv[i + 1], vz = bv[i + 2];
        if ((vx - px) * side <= 0) {
          oarPts.push([vx, vy, vz]);
          if (vx * side < bestInboardX) bestInboardX = vx * side;
        }
      }
    }
    const endRing = oarPts.filter((q) => q[0] * side <= bestInboardX + 0.035);
    assert.ok(endRing.length > 0, `found inboard oar handle ring for station ${stIdx}`);
    let tx = 0, ty = 0, tz = 0;
    for (const q of endRing) { tx += q[0]; ty += q[1]; tz += q[2]; }
    tx /= endRing.length; ty /= endRing.length; tz /= endRing.length;

    const pivM = [px * ds[0], py * ds[1], pz * ds[2]];
    const clipStart = side < 0 ? layout[8] : layout[10];
    const clipFrames = side < 0 ? layout[9] : layout[11];
    const cY = Math.cos(st.yaw), sY = Math.sin(st.yaw);
    for (let f = 0; f < clipFrames; f++) {
      const ang = (f / clipFrames) * Math.PI * 2;
      const sweep = Math.sin(ang) * 0.30;
      const dip = -Math.cos(ang) * 0.12;
      const cy = Math.cos(sweep * side), sy = Math.sin(sweep * side);
      const cr = Math.cos(dip * side), sr = Math.sin(dip * side);
      const dx = tx - px, dy = ty - py, dz = tz - pz;
      const dYawX = dx * cy - dz * sy, dYawY = dy, dYawZ = dx * sy + dz * cy;
      const rotTipM = [
        (px + (dYawX * cr - dYawY * sr)) * ds[0],
        (py + (dYawX * sr + dYawY * cr)) * ds[1],
        (pz + dYawZ) * ds[2],
      ];
      const baseOff = (clipStart + f) * CREW_JOINT_COUNT * 16;
      for (const [slot, rest] of [[handLSlot, restHandL], [handRSlot, restHandR]]) {
        const m = palettes.subarray(baseOff + slot * 16, baseOff + slot * 16 + 16);
        const lx = m[0] * rest[0] + m[4] * rest[1] + m[8] * rest[2] + m[12];
        const ly = m[1] * rest[0] + m[5] * rest[1] + m[9] * rest[2] + m[13];
        const lz = m[2] * rest[0] + m[6] * rest[1] + m[10] * rest[2] + m[14];
        const shipHand = [
          st.localMetres[0] + lx * cY + lz * sY,
          st.localMetres[1] + ly,
          st.localMetres[2] + lz * cY - lx * sY,
        ];
        worstGripDist = Math.max(worstGripDist, pointSegDist(shipHand, pivM, rotTipM));
      }
    }
  }
  assert.ok(worstGripDist < 0.038, `all 8 oarsmen keep both hands within 3.8 cm of rotating oar shaft across stroke (max=${worstGripDist.toFixed(4)} m)`);
});

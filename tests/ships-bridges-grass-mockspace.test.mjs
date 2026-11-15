// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// End-to-end verification of:
// 1. Ship quality parity across all playable ships and trade-vessel archetypes
// 2. Road-aligned bridges, level multi-arch STONE_BRIDGE_SPAN decks, approach paving & street parapet/portal rules
// 3. Seamless Nanite meadow grass continuum (1.35 m tiles, low-relief Euler=2 sward morph, zero 280 m cutoff, @binding 17/18 terrain sync)
// 4. Lightweight physical GPU mocked space (8192 m sections & 1024 m frontier parcels) and first-time generation on entry

import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';

import { BAKED_BOARDS } from '../js/board-model.js';
import {
  buildMockCoastalSection,
  buildPortPrefabGeometry,
  generateProceduralCoastalPack,
  growFrontierParcel,
} from '../js/coastal-world.js';
import { MEADOW_RENDER_WGSL, MEADOW_STEP_WGSL } from '../js/meadow-grass.js';
import { OLD_WORLD_LAND, registerBakedBoard } from '../js/old-world.js';
import {
  BOARD_ROAD_BRIDGE,
  boardRoadCrossings,
  layBoardCountry,
} from '../js/old-world-board.js';
import {
  CITY_TYPE,
  CITY_TYPED_FLOATS,
  CITY_TYPED_ROOF,
  CITY_TYPES_BRIDGES,
  cityTypeTarget,
} from '../js/old-world-buildings.js';
import { CITY_BLOCK_FLOATS } from '../js/old-world-city.js';
import { createShipAssetCache } from '../js/ship-mesh.js';
import { SHIP_MODELS } from '../js/ship-models.js';
import { layTownStreets } from '../js/town-streets.js';
import { inspectTradeVesselArchetypes } from '../js/trade-vessels.js';

function upsampleSurvey(survey, targetN = 129) {
  const sN = Math.round(Math.sqrt(survey.length));
  const out = new Float32Array(targetN * targetN);
  for (let j = 0; j < targetN; j++) {
    const sy = (j / (targetN - 1)) * (sN - 1);
    const y0 = Math.min(sN - 2, Math.floor(sy));
    const ty = sy - y0;
    for (let i = 0; i < targetN; i++) {
      const sx = (i / (targetN - 1)) * (sN - 1);
      const x0 = Math.min(sN - 2, Math.floor(sx));
      const tx = sx - x0;
      const a = survey[y0 * sN + x0];
      const b = survey[y0 * sN + x0 + 1];
      const c = survey[(y0 + 1) * sN + x0];
      const d = survey[(y0 + 1) * sN + x0 + 1];
      out[j * targetN + i] = (a * (1 - tx) + b * tx) * (1 - ty) + (c * (1 - tx) + d * tx) * ty;
    }
  }
  return out;
}

function assertAllFinite(arr, label) {
  for (let i = 0; i < arr.length; i++) {
    assert.ok(Number.isFinite(arr[i]), `${label}[${i}] is non-finite (${arr[i]})`);
  }
}

test('ship quality parity across all playable ship hulls and trade-vessel archetypes', () => {
  const cache = createShipAssetCache();
  const playableIds = Object.keys(SHIP_MODELS);
  assert.ok(playableIds.length >= 9, `expected >= 9 playable ships, got ${playableIds.length}`);

  for (const id of playableIds) {
    const asset = cache.get(id);
    assert.equal(asset.gpuPose, true, `${id} must use the shared WebGPU pose pipeline`);
    assert.ok(asset.vertices?.length > 0, `${id} missing vertices`);
    assert.ok(asset.indices?.length >= 300 && asset.indices.length % 3 === 0, `${id} expected >= 100 triangles`);
    assert.ok(asset.groups?.length >= 2, `${id} expected multi-part groups`);
    assert.ok(asset.partAssembly && asset.fracture && asset.collider, `${id} missing physics/part assembly data`);
    assertAllFinite(asset.vertices, `${id}.vertices`);
    if (asset.model.rig?.backend === 'surfaces-v1') {
      assert.ok(asset.rigGPUData, `${id} missing rigGPUData`);
    }
  }

  const archetypes = inspectTradeVesselArchetypes();
  assert.equal(archetypes.length, 7, 'expected all 7 trade-vessel archetypes');
  for (const arch of archetypes) {
    assert.ok(arch.vertices?.length > 0 && arch.triangleCount > 100, `archetype ${arch.label} missing mesh`);
    assertAllFinite(arch.vertices, `arch.${arch.label}.vertices`);
    assert.ok(arch.collider && arch.partAssembly, `archetype ${arch.label} missing collider/partAssembly`);
    assert.ok(arch.continuum?.vertCount > 0 && arch.continuum?.triCount > 0, `archetype ${arch.label} missing continuum`);
    assert.ok(arch.continuum?.coreTriCount > 0, `archetype ${arch.label} missing continuum core`);
    assert.ok(
      Number.isFinite(arch.continuum?.splat?.rx) && Number.isFinite(arch.continuum?.splat?.ry),
      `archetype ${arch.label} missing horizon splat radii`
    );
  }
});

test('bridges align with road direction, use level STONE_BRIDGE_SPAN, stamp approach paving, and respect street portals', () => {
  assert.ok(CITY_TYPES_BRIDGES.has(CITY_TYPE.STONE_BRIDGE_SPAN), 'STONE_BRIDGE_SPAN must be registered in CITY_TYPES_BRIDGES');
  assert.equal(cityTypeTarget(CITY_TYPE.STONE_BRIDGE_SPAN)?.prefabId, 'city_stone_bridge');
  const cullSrc = fs.readFileSync('js/scenery-cull.js', 'utf8');
  assert.ok(cullSrc.includes('CITY_TYPE.STONE_BRIDGE_SPAN'), 'CITY_CULL must include STONE_BRIDGE_SPAN in bridge group');

  // Verify smoothed tangent alignment and acute crossing width clamping in boardRoadCrossings
  const river = { points: [0, -240, 10, 0, 0, 10, 0, 240, 10] };
  const road = { points: [-180, -90, 0, 0, 180, 90] };
  const crossings = boardRoadCrossings([road], [river]);
  assert.equal(crossings.length, 1);
  const expLen = Math.hypot(2, 1);
  assert.ok(
    Math.abs(Math.abs(crossings[0].ux) - 2 / expLen) < 0.05 &&
    Math.abs(Math.abs(crossings[0].uz) - 1 / expLen) < 0.05,
    `crossing dir (${crossings[0].ux.toFixed(3)}, ${crossings[0].uz.toFixed(3)}) did not match angled road`
  );
  assert.ok(crossings[0].span > 20, `angled crossing across 20 m river should exceed 20 m, got ${crossings[0].span}`);

  // Verify layBoardCountry emits level STONE_BRIDGE_SPAN arches, approach paving, and fence exclusion
  const lisbon = JSON.parse(fs.readFileSync(BAKED_BOARDS['lisbon:1550'], 'utf8'));
  const cloned = structuredClone(lisbon);
  cloned.board.rivers = [{ points: [0, -220, 12, 0, 0, 12, 0, 220, 12] }];
  cloned.board.roads = [{ points: [-180, -90, 0, 0, 180, 90] }];
  cloned.board.lanes = [];
  cloned.board.works = {
    ...(cloned.board.works ?? {}),
    spans: [],
    fences: [-16, 0, 16, 0, 1],
    dams: [],
    mills: [],
    yards: [],
  };
  const span = 1024;
  const size = 65;
  const heights = new Float32Array(size * size).fill(14);
  const region = { id: 'bridge-test', x: 0, z: 0, span, size, year: 1550 };
  const grid = { size, width: size, height: size, span };
  const port = { center: { x: -320, z: -320 }, clearRadius: 30, instances: [] };
  const country = layBoardCountry({
    baked: cloned,
    region,
    grid,
    heights,
    heightAt: () => 14,
    port,
    wet: () => false,
    LAND: OLD_WORLD_LAND,
    fieldAt: () => 0,
    distanceTo: () => 50,
  });

  const multiSpans = [];
  for (let i = 0; i < country.plan.typedCount; i++) {
    const t = country.plan.typedTypes[i];
    if (t === CITY_TYPE.STONE_BRIDGE_SPAN) {
      multiSpans.push({
        x: country.plan.typed[i * CITY_TYPED_FLOATS],
        y: country.plan.typed[i * CITY_TYPED_FLOATS + 1],
        z: country.plan.typed[i * CITY_TYPED_FLOATS + 2],
        yaw: country.plan.typed[i * CITY_TYPED_FLOATS + 3],
      });
    }
    if (t === CITY_TYPE.FENCE_STONE || t === CITY_TYPE.FENCE_RAIL) {
      const fx = country.plan.typed[i * CITY_TYPED_FLOATS];
      const fz = country.plan.typed[i * CITY_TYPED_FLOATS + 2];
      assert.ok(Math.hypot(fx, fz) >= 5.5, `fence spawned inside bridge crossing at (${fx.toFixed(1)}, ${fz.toFixed(1)})`);
    }
  }
  assert.ok(
    multiSpans.length >= 2 && BOARD_ROAD_BRIDGE.arch > 0,
    `expected multi-arch STONE_BRIDGE_SPAN segments, got ${multiSpans.length}`
  );
  const firstY = multiSpans[0].y;
  for (const seg of multiSpans) {
    assert.ok(Math.abs(seg.y - firstY) < 1e-4, `multi-arch span segment deck Y drifted: ${seg.y} vs ${firstY}`);
  }
  assert.ok(country.plan.paving.length >= 2, 'expected bridge approach paving stretches at both ends');

  // Verify layTownStreets uses axial end portals on stone_arch_bridge and blocks side parapets
  const brYaw = 0.35;
  const ax = Math.sin(brYaw), az = Math.cos(brYaw);
  const brLen = 28, brWidth = 8.8, brDeckHalfW = brWidth * 0.5 - 1.05;
  const streetPort = {
    center: { x: 0, z: 0 },
    clearRadius: 80,
    instances: [
      { prefabId: 'stone_arch_bridge', x: 0, y: 8.4, z: 0, yaw: brYaw, width: brWidth, length: brLen, deckHalfWidth: brDeckHalfW },
      { prefabId: 'merchant_house', x: ax * 26, y: 8, z: az * 26, yaw: brYaw, width: 10, length: 10 },
      { prefabId: 'tavern_inn', x: -ax * 26, y: 8, z: -az * 26, yaw: brYaw, width: 10, length: 10 },
    ],
  };
  const streets = layTownStreets(streetPort, () => 8, { suppressSyntheticCountryRoads: true });
  assert.ok(streets && streets.stats.stranded === 0, 'both bridge bank buildings must connect cleanly');
  const c = Math.cos(brYaw), s = Math.sin(brYaw);
  let onDeckCount = 0;
  for (let i = 0; i + 3 < streets.samples.length; i += 4) {
    const sx = streets.samples[i], sz = streets.samples[i + 2];
    const lx = sx * c - sz * s;
    const lz = sx * s + sz * c;
    if (Math.abs(lz) <= brLen * 0.5 - 2.0 && Math.abs(lx) <= brWidth * 0.5) {
      assert.ok(Math.abs(lx) <= brDeckHalfW + 0.65, `street route walked onto bridge parapet (lx=${lx.toFixed(2)})`);
      onDeckCount++;
    }
  }
  assert.ok(onDeckCount > 0, 'expected street routes to cross over the stone_arch_bridge deck');

  // Verify stone_arch_bridge emits sloped brick/cobble abutment ramps at both ends
  const brGeom = buildPortPrefabGeometry({
    instances: [{
      prefabId: 'stone_arch_bridge',
      x: 0,
      y: 2.2,
      z: 0,
      yaw: 0,
      width: 9.6,
      length: 30,
      height: 4.5,
      foundationDepth: 6.5,
      bankYNeg: 2.3,
      bankYPos: 2.4,
    }],
  });
  assert.ok(
    brGeom.groups.some((g) => g.partKey === 'bridge_approach_ramp'),
    'stone_arch_bridge must emit bridge_approach_ramp groups at both ends'
  );
  assert.ok(fs.readFileSync('js/forest-groves.js', 'utf8').includes('section.groundSize'), 'forest-groves must check groundSize on section resize');
});

test('Nanite meadow grass uses botanical-tussock-continuum manifold, loop-free D3D12-safe meadowSelect, Euler=2 morph, ballistic wakes, and terrain albedo bindings', () => {
  const manifest = JSON.parse(fs.readFileSync('assets/ground-cover/portugal/meadows-gpu/manifest.json', 'utf8'));
  assert.equal(manifest.tileMetres, 1.75);
  assert.equal(manifest.levels, 4);
  assert.equal(manifest.style, 'botanical-tussock-continuum');
  assert.ok(Array.isArray(manifest.variantRecords) && manifest.variantRecords.length === 12);

  for (const rec of manifest.variantRecords) {
    assert.equal(rec.genusZeroEuler, 2, `${rec.mix}#${rec.variant} lost Euler=2 genus-0 closure`);
    assert.ok(rec.coreTriCount >= 4 && rec.coreTriCount <= 6, `${rec.mix}#${rec.variant} must retain 4..6 core tris for gap-free continuum, got ${rec.coreTriCount}`);
    assert.ok(rec.splat?.rx >= 0.85, `${rec.mix}#${rec.variant} splat rx=${rec.splat?.rx} too narrow for 1.75 m tiles`);
    assert.ok(rec.splat?.ry <= 0.38, `${rec.mix}#${rec.variant} splat ry=${rec.splat?.ry} too tall`);
  }

  assert.equal(MEADOW_STEP_WGSL.includes('280.0'), false, 'MEADOW_STEP_WGSL must not retain hard 280.0 m clip');
  assert.equal(MEADOW_STEP_WGSL.includes('1.570796'), false, 'MEADOW_STEP_WGSL must not use 90-degree parquet tile rotations');
  assert.equal(/\b(?:for|while)\s*\(/.test(MEADOW_STEP_WGSL), false, 'MEADOW_STEP_WGSL must remain 100% loop-free for Windows D3D12 FXC/DXC');
  assert.equal(MEADOW_STEP_WGSL.includes('SplatUniform'), false, 'MEADOW_STEP_WGSL must not bind unused 384-byte SplatUniform');
  assert.equal(/\bdiscard\b/.test(MEADOW_RENDER_WGSL), false, 'MEADOW_RENDER_WGSL must remain discard-free (MSAA sample_mask)');
  assert.ok(MEADOW_RENDER_WGSL.includes('meadowWorldBillow'), 'MEADOW_RENDER_WGSL missing world-space continuum billows');
  assert.ok(MEADOW_RENDER_WGSL.includes('@binding(13)'), 'MEADOW_RENDER_WGSL missing ballistic wakes @binding(13)');
  assert.ok(MEADOW_RENDER_WGSL.includes('@binding(14)'), 'MEADOW_RENDER_WGSL missing landCraterLookup @binding(14)');
  assert.ok(MEADOW_RENDER_WGSL.includes('@binding(15)'), 'MEADOW_RENDER_WGSL missing terrain landLight @binding(15)');
  assert.ok(MEADOW_RENDER_WGSL.includes('@binding(16)'), 'MEADOW_RENDER_WGSL missing per-vertex meadowCover @binding(16)');
  assert.ok(MEADOW_RENDER_WGSL.includes('@binding(17)'), 'MEADOW_RENDER_WGSL missing terrain landAlbedo @binding(17)');
  assert.ok(MEADOW_RENDER_WGSL.includes('@binding(18)'), 'MEADOW_RENDER_WGSL missing terrain landSampler @binding(18)');
  assert.ok(MEADOW_RENDER_WGSL.includes('@binding(22)'), 'MEADOW_RENDER_WGSL missing landCraterField @binding(22)');
  assert.ok(MEADOW_RENDER_WGSL.includes('grassWindWave'), 'MEADOW_RENDER_WGSL missing grassWindWave sync');

  const meadowSrc = fs.readFileSync('js/meadow-grass.js', 'utf8');
  const reqBlock = meadowSrc.slice(meadowSrc.indexOf('async function requestMeadowPipelines'), meadowSrc.indexOf('export async function createMeadowGrass'));
  assert.equal(reqBlock.includes('Promise.all'), false, 'requestMeadowPipelines must compile pipelines sequentially to avoid D3D12 PSO OOM');
});

test('ungrown frontier parcels & neighbor sections stay mocked until player entry, then grow once on first entry', () => {
  const baked = JSON.parse(fs.readFileSync(BAKED_BOARDS['lisbon:1550'], 'utf8'));
  const region = { ...baked.region, size: 129, biomeSize: 128, albedoSize: 256, year: 1550 };
  const heights = upsampleSurvey(baked.survey, region.size);
  registerBakedBoard(baked);

  const pack = generateProceduralCoastalPack(region, {}, heights);
  assert.ok(Array.isArray(pack.frontierParcels) && pack.frontierParcels.length === 64, 'expected 8x8 = 64 frontier parcels');

  const mockedParcels = pack.frontierParcels.filter((p) => p.state === 'mocked');
  const grownParcels = pack.frontierParcels.filter((p) => p.state === 'grown');
  assert.ok(mockedParcels.length > 0 && grownParcels.length > 0, 'expected both mocked outer parcels and grown settlement parcels');

  const target = mockedParcels[0];
  assert.equal(target.generationCount, 0);
  assert.ok(target.mockCity && target.mockCity.typedTypes.length > 0, 'mocked parcel must carry physical Cairn marker geometry');
  assertAllFinite(pack.city.blocks, 'mocked pack.city.blocks');
  assertAllFinite(pack.city.typed, 'mocked pack.city.typed');
  assert.ok(pack.city.typedTypes instanceof Uint32Array, 'mocked pack.city.typedTypes must be Uint32Array for GPU scenery-cull groups');
  const prevTypedCount = pack.city.typedCount;

  // First entry triggers generation ('mocked' -> 'grown', generationCount === 1)
  const firstGrow = growFrontierParcel(pack, target, pack.heights);
  assert.equal(firstGrow, true);
  assert.equal(target.state, 'grown');
  assert.equal(target.generationCount, 1);
  assert.equal(target.mockCity, null);
  assert.ok(target.grownCity?.typedTypes?.length > 0, 'grown parcel must populate physical rural structures');
  assert.ok(pack.city.typedCount >= prevTypedCount, 'pack.city typedCount must include grown parcel geometry');
  assertAllFinite(pack.city.blocks, 'grown pack.city.blocks');
  assertAllFinite(pack.city.typed, 'grown pack.city.typed');
  assert.ok(pack.city.typedTypes instanceof Uint32Array, 'grown pack.city.typedTypes must be Uint32Array');
  assert.ok(target.grownCity.typedTypes instanceof Uint32Array, 'target.grownCity.typedTypes must be Uint32Array');
  assertAllFinite(target.grownCity.blocks, 'target.grownCity.blocks');
  for (let b = 0; b < target.grownCity.blocks.length; b += CITY_BLOCK_FLOATS) {
    assert.equal(
      Math.round(target.grownCity.blocks[b + 8]) & CITY_TYPED_ROOF,
      CITY_TYPED_ROOF,
      `grown block at ${b} missing CITY_TYPED_ROOF`
    );
  }

  // Re-entry must be idempotent (never regenerates)
  const secondGrow = growFrontierParcel(pack, target, pack.heights);
  assert.equal(secondGrow, false);
  assert.equal(target.generationCount, 1);

  // Neighbor section mock shell uses lightweight physical GPU geometry & zero-count mock state (inland north of Lisbon)
  const mockSec = buildMockCoastalSection(pack, 0, -1);
  assert.equal(mockSec.isMock, true);
  assert.equal(mockSec.state, 'mocked');
  assert.equal(mockSec.generationCount, 0);
  assert.equal(mockSec.region.size, 33);
  assert.ok(mockSec.mesh?.vertices?.length > 0 && mockSec.mesh?.indices?.length > 0);
  assertAllFinite(mockSec.mesh.vertices, 'mockSec.mesh.vertices');
});

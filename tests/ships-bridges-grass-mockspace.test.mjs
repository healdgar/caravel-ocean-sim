// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// End-to-end verification of:
// 1. Ship quality parity across all playable ships and trade-vessel archetypes
// 2. Road-aligned bridges, level multi-arch STONE_BRIDGE_SPAN decks, approach paving & street parapet/portal rules
// 3. Meadow grass on the one continuum (4 m patches cut by projected error, a 4–6 triangle core, terrain bindings)
// 4. Lightweight physical GPU mocked space: a neighbour section stays a mock shell until it is entered

import assert from 'node:assert/strict';
import { SHIP_CONTINUUM_BODIES } from '../js/ship-continuum.js';
import fs from 'node:fs';
import { test } from 'node:test';

import { BAKED_BOARDS } from '../js/board-model.js';
import {
  buildMockCoastalSection,
  generateProceduralCoastalPack,
} from '../js/coastal-world.js';
import { MEADOW_CONTINUUM_SPEC, meadowContinuumStandWGSL } from '../js/wgsl/meadow-continuum.js';
import { continuumModuleWGSL } from '../js/wgsl/continuum-cut.js';
import { MEADOW_CONTINUUM_LEVELS, validateMeadowGrass } from '../js/meadow-continuum.js';
import { OLD_WORLD_LAND, registerBakedBoard } from '../js/old-world.js';
import {
  BOARD_ROAD_BRIDGE,
  boardRoadCrossings,
  layBoardCountry,
} from '../js/old-world-board.js';
import {
  CITY_TYPE,
  CITY_TYPED_FLOATS,
  CITY_TYPES_BRIDGES,
  cityFamilyOf,
  cityTypeTarget,
} from '../js/old-world-buildings.js';
import { createShipAssetCache } from '../js/ship-mesh.js';
import { SHIP_MODELS } from '../js/ship-models.js';
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
    // Its continuum is baked offline (scripts/prepare-ship-continuum.mjs) and checked by the bake test.
    assert.equal(SHIP_CONTINUUM_BODIES.filter((b) => b.archetype === arch.index).length, 1, `archetype ${arch.label} has one continuum body`);
  }
});

test('bridges align with road direction, use level STONE_BRIDGE_SPAN, and stamp approach paving', () => {
  assert.ok(CITY_TYPES_BRIDGES.has(CITY_TYPE.STONE_BRIDGE_SPAN), 'STONE_BRIDGE_SPAN must be registered in CITY_TYPES_BRIDGES');
  assert.equal(cityTypeTarget(CITY_TYPE.STONE_BRIDGE_SPAN)?.prefabId, 'city_stone_bridge');
  // The span is baked into the city continuum like every type, so it is drawn as itself at every distance.
  const continuum = JSON.parse(fs.readFileSync('assets/city-continuum/manifest.json', 'utf8'));
  const bakedSpan = continuum.types.find((type) => type.id === CITY_TYPE.STONE_BRIDGE_SPAN);
  assert.ok(bakedSpan?.clusters.count > 0 && bakedSpan.chain.steps > 0, 'STONE_BRIDGE_SPAN must be baked into the city continuum');

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
    // Each arch is the span's variant of its arch and width; each fence section a whole number of panels or courses.
    const t = country.plan.typedTypes[i], key = cityFamilyOf(t).key;
    if (key === 'STONE_BRIDGE_SPAN') {
      multiSpans.push({
        x: country.plan.typed[i * CITY_TYPED_FLOATS],
        y: country.plan.typed[i * CITY_TYPED_FLOATS + 1],
        z: country.plan.typed[i * CITY_TYPED_FLOATS + 2],
        yaw: country.plan.typed[i * CITY_TYPED_FLOATS + 3],
      });
    }
    if (key === 'FENCE_STONE' || key === 'FENCE_RAIL') {
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

  assert.match(fs.readFileSync('js/forest-groves.js', 'utf8'), /export function forestGroveStamp[\s\S]*?region\.size/, 'a grove is planted again when its section is resized');
});

test('meadow grass is one continuum atlas cut on the GPU: clusters, the box of its square as its core, ballistic wakes and terrain bindings', () => {
  const manifest = validateMeadowGrass(JSON.parse(fs.readFileSync('assets/ground-cover/portugal/meadows-gpu/manifest.json', 'utf8')));
  assert.equal(manifest.patchMetres, 4);
  assert.equal(manifest.levels, MEADOW_CONTINUUM_LEVELS);
  assert.equal(manifest.types.length, 12);
  for (const variant of manifest.types) {
    // A sward keeps only the levels whose error lies below the far body's first step, so no level is drawn past the handoff.
    assert.ok(variant.levels.length >= 2 && variant.levels.length <= MEADOW_CONTINUUM_LEVELS, `variant ${variant.id} has ${variant.levels.length} levels`);
    assert.ok(variant.levels.every((l) => l.error < manifest.farError), `variant ${variant.id} keeps a level past the far body's start`);
    // A patch tiles, so its body ends in the 12-triangle box of its square's eight fixed corners.
    assert.equal(variant.chain.coreTriangles, 12, `variant ${variant.id} must end in the box of its square, got ${variant.chain.coreTriangles}`);
    assert.ok(variant.clusters > 0 && variant.chain.baseTriangles > variant.chain.coreTriangles);
    // Each variant's share of the ground its sward hides, which the error counts when it is lost.
    assert.ok(variant.coverage > 0 && variant.coverage <= 1);
  }
  // The one cut reads the scene's pixel error and the continuum's core; the stand pass never clips at a fixed range.
  const stand = meadowContinuumStandWGSL();
  const view = continuumModuleWGSL({ pass: 'view', material: MEADOW_CONTINUUM_SPEC });
  assert.equal(stand.includes('280.0'), false, 'the meadow stand pass must not keep a hard 280 m clip');
  assert.equal(/\bdiscard\b/.test(stand), false);
  assert.equal(/\bdiscard\b/.test(view), false, 'the meadow view must remain discard-free (MSAA sample_mask)');
  for (const [binding, name] of [[13, 'ballistic wakes'], [14, 'landCraterLookup'], [15, 'terrain landLight'], [16, 'meadowCover'], [17, 'terrain landAlbedo'], [18, 'terrain landSampler'], [22, 'landCraterField']]) {
    assert.ok(view.includes(`@group(0) @binding(${binding})`), `the meadow view is missing ${name} @binding(${binding})`);
  }
  assert.match(stand, /fn meadowWindField\(/, 'the meadow stand pass is missing the wind field grassWindWave keeps time with');

  const meadowSrc = fs.readFileSync('js/meadow-grass.js', 'utf8');
  const reqBlock = meadowSrc.slice(meadowSrc.indexOf('export function requestMeadowStand'), meadowSrc.indexOf('const MEADOW_STAND_BINDINGS'));
  assert.ok(reqBlock.includes('createComputePipelineAsync'));
  assert.equal(reqBlock.includes('Promise.all'), false, 'requestMeadowStand must compile pipelines sequentially to avoid D3D12 PSO OOM');
});

test('neighbour sections stay mocked until player entry, as light physical GPU shells', () => {
  const baked = JSON.parse(fs.readFileSync(BAKED_BOARDS['lisbon:1550'], 'utf8'));
  const region = { ...baked.region, size: 129, biomeSize: 128, albedoSize: 256, year: 1550 };
  const heights = upsampleSurvey(baked.survey, region.size);
  registerBakedBoard(baked);

  const pack = generateProceduralCoastalPack(region, {}, heights);
  assertAllFinite(pack.city.blocks, 'pack.city.blocks');
  assertAllFinite(pack.city.typed, 'pack.city.typed');
  assert.ok(pack.city.typedTypes instanceof Uint32Array, 'pack.city.typedTypes must be Uint32Array for the city continuum cut groups');

  // Neighbor section mock shell uses lightweight physical GPU geometry & zero-count mock state (inland north of Lisbon)
  const mockSec = buildMockCoastalSection(pack, 0, -1);
  assert.equal(mockSec.isMock, true);
  assert.equal(mockSec.state, 'mocked');
  assert.equal(mockSec.generationCount, 0);
  assert.equal(mockSec.region.size, 33);
  assert.ok(mockSec.mesh?.vertices?.length > 0 && mockSec.mesh?.indices?.length > 0);
  assertAllFinite(mockSec.mesh.vertices, 'mockSec.mesh.vertices');
});

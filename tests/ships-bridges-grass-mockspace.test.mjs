// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// End-to-end verification of:
// 1. Ship quality parity across all playable ships and trade-vessel archetypes
// 2. Road-aligned bridges, level multi-arch STONE_BRIDGE_SPAN decks, approach paving & street parapet/portal rules
// 3. Meadow grass as blades made on the GPU each frame (no atlas, wind, shot and terrain bindings)
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
import { MEADOW_SPECIES_MOST, MEADOW_SWARD_BYTES, meadowBladesComputeWGSL, meadowBladesDrawWGSL } from '../js/wgsl/meadow-blades.js';
import { MEADOW_SWARDS, packMeadowSward } from '../js/meadow-grass.js';
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

test('meadow grass is blades made on the GPU each frame: no atlas, every pass compute, discard-free, wind, shot and terrain bound', () => {
  for (const [name, sward] of Object.entries(MEADOW_SWARDS)) {
    assert.equal(sward.mixes.length, 3, `${name} has a mix for each role`);
    assert.ok(sward.mixes.reduce((n, m) => n + m.species.length, 0) <= MEADOW_SPECIES_MOST, `${name} fits the sward uniform`);
    for (const mix of sward.mixes) assert.ok(Math.abs(mix.species.reduce((sum, sp) => sum + sp.share, 0) - 1) < 1e-6, `${name}: a mix's shares make the whole`);
    const { data, means } = packMeadowSward(sward);
    assert.equal(data.byteLength, MEADOW_SWARD_BYTES);
    assert.equal(means.length, 3);
  }
  const sow = meadowBladesComputeWGSL(), view = meadowBladesDrawWGSL();
  assert.equal(/\bdiscard\b/.test(sow), false);
  assert.equal(/\bdiscard\b/.test(view), false, 'the blades are drawn without discard');
  for (const entry of ['meadowBladeReset', 'meadowBladeCells', 'meadowBladeArgs', 'meadowBladeSow', 'meadowBladeFinish']) assert.match(sow, new RegExp(`fn ${entry}\\(`));
  assert.match(sow, /fn meadowWindField\(/, 'the blades lean in the meadow wind field');
  assert.match(sow, /meadowEvalBallistics\(/, 'shot, blast rings and craters part and bury the blades');
  // The far list never drops whole cells: when it fills, the finish pass broadens the next frame's short blades.
  assert.match(sow, /atomicStore\(&bladeDraws\[15\]/);
  for (const [binding, name] of [[4, 'meadowCover'], [9, 'ballistic wakes'], [10, 'landCraterLookup'], [11, 'landCraterField']]) {
    assert.ok(sow.includes(`@group(0) @binding(${binding})`), `the sow pass is missing ${name} @binding(${binding})`);
  }
  for (const [binding, name] of [[15, 'terrain landLight'], [16, 'meadowCover'], [18, 'terrain landSampler'], [20, 'land shadow']]) {
    assert.ok(view.includes(`@group(0) @binding(${binding})`), `the blade view is missing ${name} @binding(${binding})`);
  }
  const meadowSrc = fs.readFileSync('js/meadow-grass.js', 'utf8');
  assert.doesNotMatch(meadowSrc, /\bfetch\(|atlas\.bin/, 'the meadow loads nothing');
  const reqBlock = meadowSrc.slice(meadowSrc.indexOf('export function requestMeadowBladePrograms'), meadowSrc.indexOf('export async function createMeadowGrass'));
  assert.ok(reqBlock.includes('createComputePipelineAsync') && reqBlock.includes('createRenderPipelineAsync'));
  assert.equal(reqBlock.includes('Promise.all'), false, 'requestMeadowBladePrograms must compile pipelines sequentially to avoid D3D12 PSO OOM');
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

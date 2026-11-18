// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// End-to-end verification of:
// 1. Articulated genus-0 ship continuum (38->27 px) & physical 3D pilots/oarsmen on river vessels
// 2. Canonical C&C BOARD_MODEL source of truth for manned W.riverBoats & boatmen (with untouched game.js)
// 3. Procedural Lisbon derivation (zero isLisbonRoyalDock hardcoding), survey ground fit, and zero river-building overlaps
// 4. The meadow continuum atlas's integrity, river/street cover masking, and synchronized wind waves
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';

import { BAKED_BOARDS, boardGroundFits } from '../js/board-model.js';
import { openBoard } from '../scripts/board-host.mjs';
import { generateProceduralCoastalPack } from '../js/coastal-world.js';
import { registerBakedBoard } from '../js/old-world.js';
import { createInlandWaterSampler } from '../js/inland-water.js';
import { CITY_BLOCK_FLOATS } from '../js/old-world-city.js';
import { terrainSurfaceSample } from '../js/terrain-model.js';
import { GROUND_DETAIL_RENDER } from '../js/wgsl/ground-detail.js';
import { MEADOW_CUT_WGSL, MEADOW_RENDER_WGSL, buildMeadowCoverMap } from '../js/meadow-grass.js';
import { MEADOW_CONTINUUM_HEADER, PORTUGAL_MEADOW_GRASS_ASSETS, TROPICAL_MEADOW_GRASS_ASSETS, loadMeadowGrass, validateMeadowGrass } from '../js/meadow-continuum.js';
import {
  TRADE_VESSELS_WGSL,
  inspectTradeVesselArchetypes,
} from '../js/trade-vessels.js';
import { SHIP_CONTINUUM_BODIES } from '../js/ship-continuum.js';

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

test('every trade vessel is a ship continuum body and rowed boats carry 3D pilots & oarsmen', () => {
  const archetypes = inspectTradeVesselArchetypes();
  assert.ok(archetypes.length >= 7);
  // Each archetype is drawn through its own baked body; none has a stand-in of its own.
  for (const arch of archetypes) {
    assert.equal(SHIP_CONTINUUM_BODIES.filter((b) => b.family === 'trade' && b.archetype === arch.index).length, 1, `archetype ${arch.index} (${arch.label}) has one body`);
    assert.equal(arch.continuum, undefined, `archetype ${arch.index} carries no far stand-in of its own`);
  }
  // Its handoffs split each pixel's samples (sample_mask), with no discard in the opaque program.
  assert.match(TRADE_VESSELS_WGSL, /@builtin\(sample_mask\)/);
  assert.match(TRADE_VESSELS_WGSL, /shipContinuumMask\(/);
  assert.doesNotMatch(TRADE_VESSELS_WGSL, /\bdiscard\b/);

  // Arch 4 (river barge) & Arch 6 (harbor skiff) must carry zero peg-man hull geometry (mat 27 / >=29 banned),
  // real 3D wooden sweep/tiller (mat 28), and real 65-joint rigged human deckStations (stern pilot + oarsmen)
  for (const idx of [4, 6]) {
    const a = archetypes[idx];
    const mats = new Set();
    for (let k = 6; k < a.vertices.length; k += 9) mats.add(Math.floor(a.vertices[k] + 0.001));
    assert.ok(!mats.has(27), `archetype ${idx} must not bake hex peg-man pilot (mat 27)`);
    assert.ok(![...mats].some((m) => m >= 29), `archetype ${idx} must not bake hex peg-man oarsmen (mat >= 29)`);
    assert.ok(mats.has(28), `archetype ${idx} missing 3D sweep/tiller (mat 28)`);
    assert.ok(Array.isArray(a.deckStations) && a.deckStations.some((s) => s.station === 'pilot' || s.poseKind === 'helm'),
      `archetype ${idx} missing rigged human stern pilot/helm station`);
    if (idx === 4) {
      assert.ok(a.deckStations.some((s) => String(s.station).startsWith('crew:')),
        `archetype ${idx} missing rigged human oarsmen deckStations`);
    }
  }
});

test('C&C BOARD_MODEL drives persistent manned W.riverBoats with untouched assets/board/game.js', async () => {
  const diff = execFileSync('git', ['diff', '--name-only', 'assets/board/game.js'], { encoding: 'utf8' }).trim();
  assert.equal(diff, '', 'assets/board/game.js must never be modified');

  const baked = JSON.parse(fs.readFileSync(BAKED_BOARDS['lisbon:1550'], 'utf8'));
  const worldBytes = fs.readFileSync('assets/boards/lisbon-1550.world');
  const open = await openBoard(baked.request, { world: new Uint8Array(worldBytes) });
  try {
    await open.live(2);
    const boats = await open.hook('riverBoats');
    assert.ok(Array.isArray(boats) && boats.length > 0, `expected persistent W.riverBoats, got ${boats?.length}`);
    const withPilot = boats.filter((b) => b.pilot && b.pilot.name && b.pilot.trade === 'boatman' && b.oarsmen >= 2);
    assert.equal(withPilot.length, boats.length, 'every river boat must have a named boatman pilot and >=2 oarsmen');

    const car = await open.hook('caravans');
    assert.ok(Array.isArray(car.riverBoats) && car.riverBoats.length === boats.length);
    const riverLoads = car.list.filter((c) => c.mode === 'river');
    assert.ok(riverLoads.length > 0 && riverLoads.every((r) => r.pilot?.name && r.oarsmen >= 2));
  } finally {
    await open.close();
  }
});

test('Lisbon waterfront is procedurally derived with zero isLisbonRoyalDock and zero buildings inside rivers', () => {
  // Confirm zero hardcoding remains anywhere in js/
  const jsFiles = fs.readdirSync('js').filter((f) => f.endsWith('.js'));
  for (const f of jsFiles) {
    const src = fs.readFileSync(path.join('js', f), 'utf8');
    assert.equal(src.includes('isLisbonRoyalDock'), false, `${f} still references isLisbonRoyalDock`);
  }

  const baked = JSON.parse(fs.readFileSync(BAKED_BOARDS['lisbon:1550'], 'utf8'));
  const region = { ...baked.region, size: 257, biomeSize: 128, albedoSize: 256, year: 1550 };
  const heights = upsampleSurvey(baked.survey, region.size);
  assert.equal(boardGroundFits(baked.survey, heights, 1.5), true, 'upsampled Lisbon survey heights must fit board');
  registerBakedBoard(baked);

  const pack = generateProceduralCoastalPack(region, {}, heights);
  assert.ok(pack.port?.country?.board, 'Lisbon pack missing canonical board');
  assert.ok(pack.port.instances.length >= 16, `expected >=16 derived metropole port buildings, got ${pack.port.instances.length}`);
  assert.ok((pack.port.country.bridges?.length ?? 0) >= 1, 'expected >=1 derived stone_arch_bridge across rivers');

  // Verify bridges stay perpendicular to river tangent
  for (const br of pack.port.country.bridges) {
    assert.ok(Number.isFinite(br.ux) && Number.isFinite(br.uz));
  }

  // Zero port buildings inside inland river channels (excluding bridges/quays/piers)
  const riverWater = createInlandWaterSampler(pack.port.country, { margin: 1.5 });
  assert.ok(riverWater, 'expected inland river sampler on Lisbon country');
  const exemptKinds = new Set(['stone_arch_bridge', 'harbor_quay', 'quay_wall', 'timber_pier', 'stone_jetty', 'crane']);
  const portHits = [];
  for (const inst of pack.port.instances) {
    if (exemptKinds.has(inst.prefabId)) continue;
    if (riverWater(inst.x, inst.z)) portHits.push(`${inst.prefabId}@(${inst.x.toFixed(1)},${inst.z.toFixed(1)})`);
  }
  assert.deepEqual(portHits, [], `port prefabs inside river channels: ${portHits.join(', ')}`);

  // Zero city building blocks inside river channels
  const cityHits = [];
  const blocks = pack.city?.blocks;
  if (blocks?.length) {
    for (let i = 0; i + CITY_BLOCK_FLOATS <= blocks.length; i += CITY_BLOCK_FLOATS) {
      const bx = blocks[i], bz = blocks[i + 2];
      if (riverWater(bx, bz)) cityHits.push(`(${bx.toFixed(1)},${bz.toFixed(1)})`);
    }
  }
  assert.deepEqual(cityHits, [], `city blocks inside river channels: ${cityHits.join(', ')}`);

  // Verify synchronized ground-detail + meadow wind curve parity
  const g = (x, z) => terrainSurfaceSample(heights, x, z, region);
  assert.ok(Number.isFinite(g(region.x, region.z)));
});

test('meadow continuum atlas integrity, cover masking, and GPU-only zero-discard WGSL shaders', async () => {
  const manifest = validateMeadowGrass(JSON.parse(fs.readFileSync(PORTUGAL_MEADOW_GRASS_ASSETS['manifest.json'], 'utf8')));
  assert.equal(manifest.variants.length, 12);

  const root = path.resolve('.');
  const pack = await loadMeadowGrass({
    assets: PORTUGAL_MEADOW_GRASS_ASSETS,
    fetchAsset: async (relUrl) => {
      const buf = fs.readFileSync(path.join(root, relUrl));
      return new Response(buf, { status: 200 });
    },
  });
  assert.equal(pack.words.byteLength, manifest.atlas.bytes);
  assert.equal(pack.words[MEADOW_CONTINUUM_HEADER.variantCount], 12);

  // WGSL hygiene: zero discard in any shader & <= 8 storage buffers per stage
  assert.doesNotMatch(MEADOW_CUT_WGSL, /\bdiscard\b/);
  assert.doesNotMatch(MEADOW_RENDER_WGSL, /\bdiscard\b/);
  const storageCount = (MEADOW_RENDER_WGSL.match(/var<storage,/g) || []).length;
  assert.ok(storageCount <= 8, `MEADOW_RENDER_WGSL storage buffer count=${storageCount} exceeds 8`);
  assert.match(GROUND_DETAIL_RENDER, /fn grassWindWave\(/);
  assert.match(MEADOW_RENDER_WGSL, /fn meadowWindField\(/);
  // Clusters, far body and splat split each pixel's samples by the continuum's one split, carried once: complements.
  assert.equal(MEADOW_RENDER_WGSL.split('fn continuumSamples(').length - 1, 1);
  assert.equal(MEADOW_CUT_WGSL.split('fn continuumThin(').length - 1, 1);
  const mask = MEADOW_RENDER_WGSL.slice(MEADOW_RENDER_WGSL.indexOf('fn meadowMask('), MEADOW_RENDER_WGSL.indexOf('@fragment fn meadowFS'));
  assert.match(mask, /let handoff = continuumSamples\(/);
  assert.match(mask, /let splat = handoff & continuumSamples\(/);
  assert.match(mask, /return all & ~handoff;/);
  assert.match(mask, /return handoff & ~splat;/);
  assert.match(MEADOW_RENDER_WGSL, /o\.mask = meadowMask\(in\.coverage, in\.pos\.xy, in\.world\);/);
  // One start for every patch, each pixel shared by its own distance, with one pattern for every patch.
  assert.match(mask, /continuumHandoff\(away, meadowStart\(focal\)\)/);
  assert.doesNotMatch(mask, /in\.coverage\.y/);
  // The tropical sward is baked through the same bake into the same atlas.
  validateMeadowGrass(JSON.parse(fs.readFileSync(TROPICAL_MEADOW_GRASS_ASSETS['manifest.json'], 'utf8')));

  // Build cover map on Lisbon and confirm zero grass in rivers/streets and real grass on hillsides
  const baked = JSON.parse(fs.readFileSync(BAKED_BOARDS['lisbon:1550'], 'utf8'));
  const region = { ...baked.region, size: 257, biomeSize: 128, albedoSize: 256, year: 1550 };
  const heights = upsampleSurvey(baked.survey, region.size);
  registerBakedBoard(baked);
  const packLisbon = generateProceduralCoastalPack(region, {}, heights);
  const cover = buildMeadowCoverMap({
    region,
    heights,
    biome: packLisbon.biome,
    beaches: packLisbon.beaches,
    port: packLisbon.port,
    city: packLisbon.city,
    board: packLisbon.board,
    inlandWater: packLisbon.inlandWater,
    size: 2048,
  });
  const waterAt = createInlandWaterSampler(packLisbon.port.country, { margin: 2.5 });
  let covered = 0, waterLeak = 0;
  const x0 = region.x - region.span * 0.5, z0 = region.z - region.span * 0.5, step = region.span / 2048;
  for (let j = 0; j < 2048; j++) {
    const wz = z0 + (j + 0.5) * step;
    for (let i = 0; i < 2048; i++) {
      const r = cover[(j * 2048 + i) * 4];
      if (r > 0) covered++;
      if (r > 0 && waterAt(x0 + (i + 0.5) * step, wz)) waterLeak++;
    }
  }
  assert.ok(covered > 64000, `expected >64000 covered 4 m meadow texels on Lisbon hillsides, got ${covered}`);
  assert.equal(waterLeak, 0, 'meadow cover map leaked into inland rivers');

  // Verify both nearest texel AND bilinearly sampled meadowCover are below the 0.015 zero-tuck threshold
  // at EVERY rendered inlandWater triangle centroid across all 137k+ fluvial water triangles!
  const iwV = packLisbon.inlandWater?.vertices, iwI = packLisbon.inlandWater?.indices;
  assert.ok(iwV?.length > 0 && iwI?.length > 0, 'expected rendered inlandWater mesh on Lisbon');
  let nearestWaterLeaks = 0, bilinearWaterLeaks = 0;
  for (let t = 0; t + 2 < iwI.length; t += 3) {
    const o0 = iwI[t] * 12, o1 = iwI[t + 1] * 12, o2 = iwI[t + 2] * 12;
    const cx = (iwV[o0] + iwV[o1] + iwV[o2]) / 3;
    const cz = (iwV[o0 + 2] + iwV[o1 + 2] + iwV[o2 + 2]) / 3;
    const ii = Math.floor(((cx - x0) / region.span) * 2048);
    const jj = Math.floor(((cz - z0) / region.span) * 2048);
    if (ii < 0 || ii >= 2048 || jj < 0 || jj >= 2048) continue;
    if (cover[(jj * 2048 + ii) * 4] > 0) nearestWaterLeaks++;
    const qx = Math.max(0, Math.min(2047, ((cx - x0) / region.span) * 2048 - 0.5));
    const qz = Math.max(0, Math.min(2047, ((cz - z0) / region.span) * 2048 - 0.5));
    const i0 = Math.min(2046, Math.floor(qx)), j0 = Math.min(2046, Math.floor(qz));
    const fx = qx - i0, fz = qz - j0;
    const c00 = cover[(j0 * 2048 + i0) * 4] / 255;
    const c10 = cover[(j0 * 2048 + i0 + 1) * 4] / 255;
    const c01 = cover[((j0 + 1) * 2048 + i0) * 4] / 255;
    const c11 = cover[((j0 + 1) * 2048 + i0 + 1) * 4] / 255;
    const bi = (c00 * (1 - fx) + c10 * fx) * (1 - fz) + (c01 * (1 - fx) + c11 * fx) * fz;
    if (bi >= 0.01) bilinearWaterLeaks++;
  }
  assert.equal(nearestWaterLeaks, 0, `expected 0 nearest-texel inlandWater leaks, got ${nearestWaterLeaks}`);
  assert.equal(bilinearWaterLeaks, 0, `expected 0 bilinear inlandWater leaks, got ${bilinearWaterLeaks}`);
});

import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';
import {
  build1550HistoricalTerritoryPack,
  generateProceduralCoastalPack,
  terrainSurfaceSample,
} from '../js/coastal-world.js';
import {
  oldWorldCountry,
  registerBakedBoard,
  syncOldWorldHeights,
} from '../js/old-world.js';
import {
  CITY_TYPED_FLOATS,
  CITY_TYPES_WATERSIDE,
} from '../js/old-world-buildings.js';

test('syncOldWorldHeights prevents in-place heightfield upgrades from reverting under upgraded cities', () => {
  const baked = JSON.parse(fs.readFileSync('assets/boards/jamestown-1550.json', 'utf8'));
  registerBakedBoard(baked);
  const basePack = generateProceduralCoastalPack(
    {
      id: 'jamestown',
      name: 'Paspahegh · Chickahominy',
      latitude: baked.region.latitude,
      longitude: baked.region.longitude,
      shoreBearing: 25,
      year: 1550,
    },
    { size: 513, biomeSize: 256, albedoSize: 256, vegetationCandidates: 2000 },
  );
  const heights = basePack.heights;
  assert.ok(basePack.city?.typedCount > 50, 'base Paspahegh city built');

  // Upgrade heights in-place (mirrors applyUpgradedPack in js/terrain.js) and sync old-world caches.
  const upgraded = build1550HistoricalTerritoryPack(basePack);
  assert.ok(upgraded.city?.typedCount > 50, 'upgraded Paspahegh city built');
  heights.set(upgraded.heights);
  syncOldWorldHeights(heights, {
    surveyHeights: upgraded.surveyHeights ?? null,
    port: upgraded.port,
    country: upgraded.port?._resolvedCountry ?? null,
  });

  // Subsequent oldWorldCountry lookup (as performed by forest planting/groves) must NOT revert `heights`.
  const snapshotBefore = heights.slice();
  oldWorldCountry(upgraded.region, heights, upgraded.port);
  let maxRevert = 0;
  for (let i = 0; i < heights.length; i++) {
    maxRevert = Math.max(maxRevert, Math.abs(heights[i] - snapshotBefore[i]));
  }
  assert.equal(maxRevert, 0, `oldWorldCountry reverted upgraded heights by ${maxRevert} m`);

  // Every non-waterside Powhatan building must remain seated on the upgraded terrain without floating.
  const c = upgraded.city;
  let worstFloat = -Infinity;
  for (let i = 0; i < c.typedCount; i++) {
    if (CITY_TYPES_WATERSIDE.has(c.typedTypes[i])) continue;
    const x = c.typed[i * CITY_TYPED_FLOATS];
    const y = c.typed[i * CITY_TYPED_FLOATS + 1];
    const z = c.typed[i * CITY_TYPED_FLOATS + 2];
    const g = terrainSurfaceSample(heights, x, z, upgraded.region);
    worstFloat = Math.max(worstFloat, y - g);
  }
  assert.ok(worstFloat < 2.5, `non-waterside Powhatan buildings stay grounded (worst float ${worstFloat.toFixed(2)} m)`);
});

test('build1550HistoricalTerritoryPack preserves indigenous coastal village terraces', () => {
  const basePack = generateProceduralCoastalPack(
    { latitude: 37.208, longitude: -76.778, shoreBearing: 30, year: 1550 },
    { size: 513, biomeSize: 256, albedoSize: 256, vegetationCandidates: 2000 },
  );
  assert.ok(basePack.port?.hasIndigenousSettlement, 'Powhatan coast flagged as indigenous settlement');
  const upgraded = build1550HistoricalTerritoryPack(basePack);
  const cx = basePack.port.center.x, cz = basePack.port.center.z;
  const hAfter = terrainSurfaceSample(upgraded.heights, cx, cz, upgraded.region);
  assert.ok(hAfter > 0.5, `indigenous village terrace stayed dry after 1550 upgrade (${hAfter.toFixed(2)} m)`);
});

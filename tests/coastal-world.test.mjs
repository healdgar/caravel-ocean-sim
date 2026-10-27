// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import {
  SPANISH_MAIN_1550_REGIONS,
  PORT_PREFABS,
  COCONUT_PALM_GENOME_SPEC,
  coastalUberNoise2D,
  resolveGlobalCoastalRegion,
  synthesizeCoastalTerrain,
  synthesizeCoastalBeaches,
  synthesizeCoastalBiome,
  synthesizeCoastalAlbedo,
  placeCoastalPort,
  portClearanceEnvelope,
  decode1550BuildingLRMBundle,
  buildPortPrefabGeometry,
  seedCoastalVegetation,
  buildCoastalMesh,
  generateProceduralCoastalPack,
  upgradeProceduralPackWithRealDEM,
  canonicalCoastalCellId,
  build1550HistoricalTerritoryPack,
  encode1550TerritoryCachePayload,
  apply1550TerritoryCachePayload,
  runLandfallDiscoveryPipeline,
  smoothCoastlineAndForeshoreBeaches,
  detectCoastalContinuationDirs,
  stitchCoastalSectionBorders,
  generateCoastalNeighborSection,
} from '../js/coastal-world.js';
import { FOREST_SPECIES, FOREST_ROOT_FLOATS } from '../js/forest-scenery.js';
import {
  terrainSample,
  safeLandfallStart,
  constrainIslandMotion,
} from '../js/terrain-model.js';
import { coastalRegionStageURL, coastalSeaForRegion } from '../js/landfall.js';
import { vegetationProbability } from '../js/vegetation.js';

test('Spanish Main ~1550 gazetteer resolves all curated ports with deterministic metadata', () => {
  const expectedIds = [
    'saba',
    'cartagena',
    'nombre-de-dios',
    'santo-domingo',
    'havana',
    'san-juan',
  ];
  assert.deepEqual(Object.keys(SPANISH_MAIN_1550_REGIONS), expectedIds);
  for (const id of expectedIds) {
    const r = resolveGlobalCoastalRegion(id);
    assert.equal(r.id, id);
    assert.equal(r.era, 1550);
    assert.ok(r.latitude > 8 && r.latitude < 25);
    assert.ok(r.longitude > -85 && r.longitude < -60);
    assert.ok(r.span >= 4096);
    assert.ok(r.size >= 65);
    assert.ok(Object.isFrozen(r));
  }
  assert.throws(() => resolveGlobalCoastalRegion('atlantis'), /Unknown Spanish Main/);
  assert.throws(() => resolveGlobalCoastalRegion({ latitude: 95, longitude: 0 }), /latitude/);
  assert.throws(() => resolveGlobalCoastalRegion({ latitude: 10, longitude: 195 }), /longitude/);
});

test('global coastal resolver generates deterministic region descriptors for any coordinate worldwide', () => {
  const globalSites = [
    { name: 'Lisbon · Tagus Estuary', latitude: 38.707, longitude: -9.136, expectedClimate: 'temperate' },
    { name: 'Acapulco · Manila Galleon Port', latitude: 16.849, longitude: -99.908, expectedClimate: 'tropical' },
    { name: 'NagasakiBay', latitude: 32.75, longitude: 129.867, expectedClimate: 'subtropical' },
    { name: 'Bergen · Fjord Coast', latitude: 60.391, longitude: 5.322, expectedClimate: 'subpolar' },
  ];
  for (const site of globalSites) {
    const a = resolveGlobalCoastalRegion(site);
    const b = resolveGlobalCoastalRegion(site);
    assert.deepEqual(a, b, 'global coordinate resolution is strictly deterministic');
    assert.equal(a.climate, site.expectedClimate);
    assert.ok(a.shoreBearing >= 0 && a.shoreBearing < 360);
    assert.ok(a.peakElevationMetres >= 40 && a.peakElevationMetres <= 900);
  }

  // Verify coastline ring normal inference
  const rings = [[[-75.6, 10.4], [-75.5, 10.4], [-75.5, 10.5]]];
  const withRings = resolveGlobalCoastalRegion({
    latitude: 10.38,
    longitude: -75.55,
    coastlineRings: rings,
  });
  assert.ok(Number.isFinite(withRings.shoreBearing));
});

test('3D coastal terrain and bathymetry synthesize navigable channels, beaches, headlands and inland relief', () => {
  for (const id of ['cartagena', 'nombre-de-dios', 'saba']) {
    const region = resolveGlobalCoastalRegion({ ...SPANISH_MAIN_1550_REGIONS[id], size: 65, biomeSize: 64, albedoSize: 64 });
    const heights = synthesizeCoastalTerrain(region);
    assert.equal(heights.length, region.size ** 2);
    let minH = Infinity;
    let maxH = -Infinity;
    for (const h of heights) {
      assert.ok(Number.isFinite(h));
      minH = Math.min(minH, h);
      maxH = Math.max(maxH, h);
    }
    assert.ok(minH <= -25 && minH >= -120, `offshore seabed reaches navigable depth (${minH}m)`);
    assert.ok(maxH >= 60 && maxH <= 895, `inland relief rises to coastal hills/peaks (${maxH}m)`);

    const mesh = buildCoastalMesh(region, heights);
    assert.ok(mesh.indices.length > 0 && mesh.indices.length % 3 === 0);
    assert.ok(mesh.submergedIndices.length > 0 && mesh.submergedIndices.length % 3 === 0);
    for (let i = 0; i < mesh.vertices.length; i += 8) {
      const nLen = Math.hypot(mesh.vertices[i + 3], mesh.vertices[i + 4], mesh.vertices[i + 5]);
      assert.ok(Math.abs(nLen - 1) < 1e-4, 'unit surface normal');
    }
  }
});

test('coastal beaches and procedural RGBA albedo distinguish swash zones, dry sand berms, cliffs and forest', () => {
  const region = resolveGlobalCoastalRegion({ ...SPANISH_MAIN_1550_REGIONS.cartagena, size: 65, biomeSize: 64, albedoSize: 64 });
  const heights = synthesizeCoastalTerrain(region);
  const beaches = synthesizeCoastalBeaches(region, heights);
  assert.equal(beaches.swashMask.length, region.biomeSize ** 2);
  assert.equal(beaches.drySandMask.length, region.biomeSize ** 2);
  assert.ok(beaches.beachCellCount > 16, 'sheltered bay produces a sandy foreshore');
  assert.ok(beaches.cells.length > 0);
  for (const cell of beaches.cells) {
    assert.ok(cell.elevation >= 0.4 && cell.elevation <= 6.5);
    assert.ok(cell.slope < 0.2);
  }

  const port = placeCoastalPort(region, heights);
  const biome = synthesizeCoastalBiome(region, heights, beaches, port);
  const albedo = synthesizeCoastalAlbedo(region, heights, beaches, port, biome);
  assert.equal(albedo.length, region.albedoSize * region.albedoSize * 4);
  for (let i = 3; i < albedo.length; i += 4) {
    assert.equal(albedo[i], 255, 'opaque terrain albedo');
  }
});

test('16th-century port prefabs place grounded waterfront piers, sea bastions and colonial buildings with valid 3D geometry', () => {
  assert.ok(Object.keys(PORT_PREFABS).length >= 7);
  const region = resolveGlobalCoastalRegion({ ...SPANISH_MAIN_1550_REGIONS['santo-domingo'], size: 65, biomeSize: 64, albedoSize: 64 });
  const heights = synthesizeCoastalTerrain(region);
  const port = placeCoastalPort(region, heights);

  assert.equal(port.regionId, 'santo-domingo');
  assert.equal(port.era, 1550);
  assert.ok(port.instances.length >= 7);
  assert.ok(port.berth.depth >= 4.5, 'mooring berth clears deep-draft vessels');

  const prefabIds = new Set(port.instances.map((i) => i.prefabId));
  for (const required of ['timber_mole_pier', 'stone_sea_bastion', 'casa_de_contratacion', 'royal_warehouse', 'mission_chapel']) {
    assert.ok(prefabIds.has(required), `port includes ${required}`);
  }

  // Pier center blocks hull clearance, while open berth clears hull envelope
  const pier = port.instances.find((i) => i.prefabId === 'timber_mole_pier');
  assert.equal(portClearanceEnvelope(port, pier.x, pier.z, 4), false);
  assert.equal(portClearanceEnvelope(port, port.berth.x, port.berth.z, 4), true);

  const geom = buildPortPrefabGeometry(port);
  assert.equal(geom.instanceCount, port.instances.length);
  assert.ok(geom.triangleCount >= port.instances.length * 10);
  assert.equal(geom.indices.length, geom.triangleCount * 3);
  for (let i = 0; i < geom.vertices.length; i += 8) {
    assert.ok(geom.vertices.subarray(i, i + 8).every(Number.isFinite));
    const nLen = Math.hypot(geom.vertices[i + 3], geom.vertices[i + 4], geom.vertices[i + 5]);
    assert.ok(Math.abs(nLen - 1) < 1e-4);
  }
});

test('coastal vegetation seeds palms, scrub and upland forest while clearing beaches and port footprints', () => {
  const region = resolveGlobalCoastalRegion({
    ...SPANISH_MAIN_1550_REGIONS['nombre-de-dios'],
    size: 65,
    biomeSize: 64,
    albedoSize: 64,
    vegetationCandidates: 12000,
  });
  const heights = synthesizeCoastalTerrain(region);
  const beaches = synthesizeCoastalBeaches(region, heights);
  const port = placeCoastalPort(region, heights);
  const biome = synthesizeCoastalBiome(region, heights, beaches, port);
  const veg = seedCoastalVegetation(region, heights, biome, beaches, port);

  assert.ok(FOREST_SPECIES.includes('palm'), 'FOREST_SPECIES registers Forestmodeler palm genome');
  assert.equal(COCONUT_PALM_GENOME_SPEC.species, 'palm');
  assert.equal(COCONUT_PALM_GENOME_SPEC.architecturalModel, 'Corner');
  assert.deepEqual(veg.trees, seedCoastalVegetation(region, heights, biome, beaches, port).trees);
  assert.ok(veg.stats.totalTrees > 250, 'dense coastal and upland stand seeded');
  assert.ok(veg.stats.palmCount > 0, 'tropical foreshore seeds palm fringe');
  assert.equal(veg.palmRoots.length, veg.stats.palmCount * FOREST_ROOT_FLOATS);
  for (let i = 0; i < veg.palms.length; i += 8) {
    const r = veg.palms[i + 3];
    const ht = veg.palms[i + 4];
    assert.ok(r >= 2.75 && r <= 4.25, 'palm plume radius matches Cocos nucifera band');
    assert.ok(ht >= 18.0 && ht <= 26.0, 'palm mature height matches Cocos nucifera band');
  }
  assert.ok(veg.stats.uplandCount > 0, 'upland slopes seed forest stands');
  assert.equal(
    veg.stats.totalTrees,
    veg.stats.palmCount + veg.stats.scrubCount + veg.stats.uplandCount
  );

  for (let i = 0; i < veg.trees.length; i += 8) {
    const x = veg.trees[i];
    const y = veg.trees[i + 1];
    const z = veg.trees[i + 2];
    assert.ok(y >= 2.4 && y <= 855, 'rooted above intertidal swash');
    assert.ok(Math.abs(y - terrainSample(heights, x, z, region)) < 0.05);
    assert.equal(portClearanceEnvelope(port, x, z, 10), true, 'tree clears port buildings and piers');
    const u = (x - region.x) / region.span + 0.5;
    const v = (z - region.z) / region.span + 0.5;
    assert.ok(vegetationProbability(biome, region.biomeSize, u, v) > 0);
  }
});

test('generateProceduralCoastalPack produces complete landfall packs and safe vessel starts for Spanish Main and global ports', () => {
  for (const spec of [
    { ...SPANISH_MAIN_1550_REGIONS.havana, size: 65, biomeSize: 64, albedoSize: 64, vegetationCandidates: 6000 },
    { name: 'Cartagena Global Probe', latitude: 10.423, longitude: -75.548, size: 65, biomeSize: 64, albedoSize: 64, vegetationCandidates: 6000 },
  ]) {
    const pack = generateProceduralCoastalPack(spec);
    assert.ok(pack.heights instanceof Float32Array);
    assert.ok(pack.biome instanceof Uint8Array);
    assert.ok(pack.albedo instanceof Uint8Array);
    assert.ok(pack.vegetation.trees instanceof Float32Array);
    assert.ok(pack.portGeometry.vertices instanceof Float32Array);

    const caravel = { length: 20, beam: 6, hydrodynamics: { draft: 2.1 } };
    for (const [stageName, view] of Object.entries(pack.views)) {
      const start = safeLandfallStart(pack.heights, view, caravel, pack.region);
      const boat = { ...caravel, ...start, surgeVelocity: 3, leewayVelocity: 0.1 };
      assert.equal(
        constrainIslandMotion(pack.heights, boat, start.x, start.z, null, pack.region),
        false,
        `${pack.region.id} ${stageName} start clears vessel hull envelope`
      );
    }
  }

  const url = coastalRegionStageURL('https://example.com/ocean.html', 'cartagena', 'coast', 'clear');
  assert.equal(url.searchParams.get('region'), 'cartagena');
  assert.equal(url.searchParams.get('landfall'), 'coast');
  assert.equal(url.searchParams.get('lat'), '10.423');
  assert.equal(url.searchParams.get('lon'), '-75.548');
});

test('architectural port materials, 3D palm geometry, beach sand vertex weights, and Terrarium DEM upgrade', async () => {
  const pack = generateProceduralCoastalPack({
    ...SPANISH_MAIN_1550_REGIONS.cartagena,
    size: 65,
    biomeSize: 64,
    albedoSize: 64,
    vegetationCandidates: 6000,
  });

  // Verify port geometry emits architectural materials (10=timber, 11=masonry, 12=stucco, 13=terracotta, 14=recess) + 3D palms (3=trunk, 4=fronds)
  const kinds = new Set();
  for (let i = 0; i < pack.portGeometry.vertices.length; i += 8) {
    kinds.add(Math.round(pack.portGeometry.vertices[i + 6]));
  }
  for (const k of [3, 4, 10, 11, 12, 13, 14]) {
    assert.ok(kinds.has(k), `port & palm geometry includes material kind ${k}`);
  }

  // Verify Uber-Noise is bounded, deterministic, and derivative-damped
  const u0 = coastalUberNoise2D(1.4, -0.8, 58109);
  const u1 = coastalUberNoise2D(1.4, -0.8, 58109);
  assert.equal(u0, u1);
  assert.ok(u0 >= 0 && u0 <= 1);

  // Verify stone_quay_seawall (Malecón) is placed and adaptive near-shore subdivision refines shoreline cells
  assert.ok(pack.port.instances.some((inst) => inst.prefabId === 'stone_quay_seawall'), 'port includes stone_quay_seawall Malecón');
  assert.ok(pack.mesh.vertices.length > pack.region.size * pack.region.size * 8, 'adaptive 3x3 near-shore subdivision adds shoreline sub-vertices');

  // Verify coastal mesh encodes beach sand weight in vertex.kind.y in [0.02, 1]
  let sandyVertices = 0;
  for (let i = 0; i < pack.mesh.vertices.length; i += 8) {
    const sandW = pack.mesh.vertices[i + 7];
    assert.ok(sandW >= 0.015 && sandW <= 1, 'procedural coast tag & sand weight bounded in [0.02, 1]');
    if (sandW > 0.25) sandyVertices++;
  }
  assert.ok(sandyVertices > 10, 'coastal mesh marks foreshore vertices with smooth sand weights');

  // Verify upgradeProceduralPackWithRealDEM upgrades pack from synthetic Terrarium DEM + satellite imagery tiles
  const fakeTile = new Uint8ClampedArray(256 * 256 * 4);
  const fakeSatTile = new Uint8ClampedArray(256 * 256 * 4);
  for (let y = 0; y < 256; y++) {
    for (let x = 0; x < 256; x++) {
      // Periodic coastal bands across the tile so any sub-window has ~50% land (+4m..+90m) and ~50% sea (0m)
      const band = (x + y) % 64;
      const h = band >= 28 ? 3 + (band - 28) * 1.8 : 0;
      const val = Math.round((h + 32768) * 256);
      const idx = (y * 256 + x) * 4;
      fakeTile[idx] = (val >> 16) & 255;
      fakeTile[idx + 1] = (val >> 8) & 255;
      fakeTile[idx + 2] = val & 255;
      fakeTile[idx + 3] = 255;
      // Satellite tile: warm sand near shoreline (band 28..31), modern concrete on band 32..38, lush forest on band 39+
      if (band < 28) {
        fakeSatTile[idx] = 18;
        fakeSatTile[idx + 1] = 56;
        fakeSatTile[idx + 2] = 78;
      } else if (band < 32) {
        fakeSatTile[idx] = 224;
        fakeSatTile[idx + 1] = 198;
        fakeSatTile[idx + 2] = 152;
      } else if (band < 39) {
        // Modern neutral concrete/roof pixel to verify 1550s historical reforestation
        fakeSatTile[idx] = 168;
        fakeSatTile[idx + 1] = 166;
        fakeSatTile[idx + 2] = 164;
      } else {
        fakeSatTile[idx] = 44;
        fakeSatTile[idx + 1] = 96;
        fakeSatTile[idx + 2] = 48;
      }
      fakeSatTile[idx + 3] = 255;
    }
  }
  const upgraded = await upgradeProceduralPackWithRealDEM(pack, {
    fetchTile: async () => fakeTile,
    fetchSatelliteTile: async () => fakeSatTile,
  });
  assert.equal(upgraded.demSource.provider, 'aws-terrarium-srtm-etopo1');
  assert.equal(upgraded.demSource.satelliteOverlay, true);
  assert.equal(upgraded.demSource.zoom, 13);
  assert.equal(upgraded.demSource.nearshoreZoom, 14);
  assert.ok(upgraded.portGeometry.triangleCount > 200);
  assert.ok(upgraded.vegetation.stats.totalTrees > 50, 'satellite + DEM upgrade seeds coastal palms and forest');

  // Verify canonical cell snapping, 1550 territory reconstruction, binary cache encoding, and First Explorer discovery workflow
  const cellA = canonicalCoastalCellId({ latitude: 18.468, longitude: -66.118 });
  const cellB = canonicalCoastalCellId({ latitude: 18.469, longitude: -66.119 });
  assert.equal(cellA.cellId, 'cell_18.48_-66.12');
  assert.equal(cellA.cellId, cellB.cellId);

  const pack1550 = build1550HistoricalTerritoryPack(upgraded);
  assert.ok(pack1550.territory1550.restoredEstuaryPct > 0);
  const encoded = encode1550TerritoryCachePayload(pack1550);
  assert.ok(encoded.byteLength > 16);
  const decodedPack = apply1550TerritoryCachePayload(upgraded, encoded);
  assert.ok(decodedPack);
  assert.equal(decodedPack.territory1550.cellId, pack1550.territory1550.cellId);

  // Simulate First Explorer (cache miss -> PUT) followed by Mariner #2 (cache hit -> GET)
  let storedPackBytes = null;
  let storedVisits = 0;
  const mockFetch = async (url, init = {}) => {
    if (url.includes('/landfall-discovery')) {
      if (!storedPackBytes) {
        return {
          ok: true,
          json: async () => ({ status: 'first_explorer', firstExplorer: true, visits: 1, hasOrthophoto: false }),
        };
      }
      storedVisits++;
      return {
        ok: true,
        json: async () => ({ status: 'cached', firstExplorer: false, visits: storedVisits, hasOrthophoto: false }),
      };
    }
    if (url.includes('/landfall-pack') && init.method === 'PUT') {
      storedPackBytes = new Uint8Array(init.body);
      storedVisits = 1;
      return { ok: true, json: async () => ({ ok: true }) };
    }
    if (url.includes('/landfall-pack')) {
      return {
        ok: Boolean(storedPackBytes),
        arrayBuffer: async () => storedPackBytes.buffer,
      };
    }
    return { ok: false };
  };

  let firstExplorerCalled = false;
  let upgradeReadyCalled = false;
  const firstRun = await runLandfallDiscoveryPipeline(upgraded, {
    fetchImpl: mockFetch,
    onFirstExplorer: () => { firstExplorerCalled = true; },
    onUpgradeReady: () => { upgradeReadyCalled = true; },
  });
  assert.equal(firstRun.status, 'first_explorer');
  assert.equal(firstExplorerCalled, true);
  assert.equal(upgradeReadyCalled, true);
  assert.ok(storedPackBytes instanceof Uint8Array);

  let cachedReadyVisits = 0;
  const secondRun = await runLandfallDiscoveryPipeline(upgraded, {
    fetchImpl: mockFetch,
    onCachedReady: (info) => { cachedReadyVisits = info.visits; },
  });
  assert.equal(secondRun.status, 'cached');
  assert.equal(cachedReadyVisits, 2);

  const { retargetForestPackToProcedural } = await import('../js/terrain.js');
  const fakeForestPack = {
    manifest: {
      prototypes: [
        { id: 0, crownRadius: 8, basalRadius: 1.1 },
        { id: 1, crownRadius: 9, basalRadius: 1.3 },
      ],
    },
  };
  const retargeted = retargetForestPackToProcedural(
    fakeForestPack,
    secondRun.upgradedPack,
    () => 12.0,
    { isMobile: true }
  );
  assert.equal(retargeted.maxRootCapacity, 16000);
  assert.ok(retargeted.roots.length >= 12);
});

test('decode1550BuildingLRMBundle decodes plumb-rectified WW3D building bundle and stamps into port geometry', () => {
  const raw = fs.readFileSync(new URL('../assets/ports/1550/buildings-1550-lrm.bin', import.meta.url));
  const templates = decode1550BuildingLRMBundle(raw);
  assert.ok(templates, 'Expected WW3D bundle to decode');
  for (const id of ['stone_sea_bastion', 'casa_de_contratacion', 'mission_chapel', 'colonial_town_block']) {
    assert.ok(templates[id], `Missing LRM template ${id}`);
    assert.ok(templates[id].vertexCount >= 6000, `Expected >=6,000 unshared flat-normal vertices for high-detail ${id}, got ${templates[id].vertexCount}`);
    assert.ok(templates[id].indexCount >= 6000, `Expected >=2,000 plumb-rectified triangles for high-detail ${id}, got ${templates[id].indexCount}`);
    assert.equal(templates[id].vertexCount, templates[id].indexCount, `Expected unshared per-face vertices for ${id} to prevent GPU material interpolation`);
  }
  const pack = generateProceduralCoastalPack('san-juan', { size: 65 });
  const geom = buildPortPrefabGeometry(pack.port, null, templates);
  assert.ok(geom.triangleCount > 12000, `Expected high-detail plumb port geometry to exceed 12,000 triangles, got ${geom.triangleCount}`);

  // Verify top-down map footprints in WW15 payload validate the AI 1550 orthophoto physical scale
  // and place 1 single 3D building per footprint rectangle (1:1, zero city-block pellet subdivision)
  const packWithFootprints = build1550HistoricalTerritoryPack(pack);
  packWithFootprints.territory1550.clusterU = 0.42;
  packWithFootprints.territory1550.clusterV = 0.48;
  packWithFootprints.territory1550.footprints = [
    { u: 0.41, v: 0.44, width: 128, length: 144, yaw: -0.22, prefabId: 'stone_sea_bastion', inlandM: 48 },
    { u: 0.38, v: 0.50, width: 96, length: 120, yaw: -0.22, prefabId: 'casa_de_contratacion', inlandM: 88 },
    { u: 0.35, v: 0.47, width: 64, length: 112, yaw: -0.22, prefabId: 'mission_chapel', inlandM: 104 },
    { u: 0.40, v: 0.52, width: 84, length: 96, yaw: -0.22, prefabId: 'colonial_town_block', inlandM: 112 },
  ];
  const encodedFp = encode1550TerritoryCachePayload(packWithFootprints);
  const appliedFp = apply1550TerritoryCachePayload(pack, encodedFp);
  assert.equal(appliedFp.port.hasOrthophotoFootprints, true);
  assert.ok(appliedFp.region.span >= 1350 && appliedFp.region.span <= 2300, `Expected AI 1550 orthophoto scale validation to adjust span into 1350..2300m, got ${appliedFp.region.span}`);
  const orthoInstances = appliedFp.port.instances.filter((inst) => inst.fromOrthophotoFootprint);
  assert.equal(orthoInstances.length, 4, `Expected 1:1 single building per footprint rectangle (zero pellet subdivision), got ${orthoInstances.length}`);
  const bastionInst = orthoInstances.find((inst) => inst.prefabId === 'stone_sea_bastion');
  assert.ok(bastionInst, 'Expected stone_sea_bastion placed from top-down footprint');
  assert.equal(bastionInst.yaw, -0.22, 'Footprint yaw must match top-down map orientation');
  for (const inst of orthoInstances) {
    assert.ok(inst.height >= 7.5 && inst.height <= 11.0, `Expected true human/tree scale eave height (7.5m–11.0m vs 18m–22m trees), got ${inst.height} for ${inst.prefabId}`);
    assert.ok(inst.width <= 44 && inst.length <= 48, `Expected individual building footprint <=44m×48m, got ${inst.width}×${inst.length} for ${inst.prefabId}`);
  }

  // Verify 513x513 full-resolution mesh has zero inner-square subdivision seam on any arbitrary port coordinate
  const fullPack = generateProceduralCoastalPack({ latitude: 29.894, longitude: -81.312 }, { size: 513, biomeSize: 128, albedoSize: 128, vegetationCandidates: 4000 });
  assert.equal(fullPack.mesh.vertices.length, 513 * 513 * 8, 'Expected single uniform 513x513 vertex grid with zero inner-square subdivision seam');
  assert.ok(fullPack.vegetation.palms.length / 8 >= 200, `Expected abundant 3D palms across subtropical canopy, got ${fullPack.vegetation.palms.length / 8}`);
});

test('bay-iterated 1550 port primitives iterate horizontal bays without stretching cross-sections or roof pitch', () => {
  const newPrimitives = [
    'single_nave_solar',
    'l_wing_u_wing_solar',
    'modular_patio_cloister',
    'royal_atarazanas_arsenal',
    'open_lonja_loggia',
    'walled_mule_corral',
    'bastion_trace_fortress',
    'torreon_atalaya_farol',
    'curtain_wall_and_gate',
    'stone_arch_bridge',
    'thatched_bohio_palafito',
    'astillero_and_moored_hull',
  ];
  for (const id of newPrimitives) {
    assert.ok(PORT_PREFABS[id], `Expected PORT_PREFABS to register ${id}`);
  }

  // Verify horizontal bay iteration: lengthening a building adds discrete architectural bays (triangles)
  // while keeping wing roof ridge height constant (never stretching roof pitch vertically)
  const buildSingleInstance = (prefabId, width, length, height = 8.0) =>
    buildPortPrefabGeometry({
      instances: [
        {
          prefabId,
          x: 0,
          y: 3.0,
          z: 0,
          yaw: 0,
          width,
          length,
          height,
          foundationDepth: 4.0,
          materialKind: PORT_PREFABS[prefabId].materialKind,
          roofPitch: PORT_PREFABS[prefabId].roofPitch,
          waterfront: PORT_PREFABS[prefabId].waterfront,
          fromOrthophotoFootprint: true,
        },
      ],
    });

  const shortHall = buildSingleInstance('single_nave_solar', 9.5, 15.0, 7.8);
  const longHall = buildSingleInstance('single_nave_solar', 9.5, 34.0, 7.8);
  assert.ok(longHall.triangleCount > shortHall.triangleCount + 180, 'Lengthening single_nave_solar iterates additional window & rafter bays');
  assert.ok(Math.abs(longHall.bounds.max[1] - shortHall.bounds.max[1]) < 1e-4, 'Roof ridge elevation remains constant when iterating horizontal bays');

  const smallCloister = buildSingleInstance('modular_patio_cloister', 22.0, 24.0, 8.2);
  const largeCloister = buildSingleInstance('modular_patio_cloister', 36.0, 42.0, 8.2);
  assert.ok(largeCloister.triangleCount > smallCloister.triangleCount + 400, 'Expanding modular_patio_cloister iterates additional courtyard arch bays');
  assert.ok(Math.abs(largeCloister.bounds.max[1] - smallCloister.bounds.max[1]) < 1e-4, 'Cloister wing depth (5.8m) and roof ridge height stay constant across footprint sizes');

  const narrowArsenal = buildSingleInstance('royal_atarazanas_arsenal', 16.0, 28.0, 8.4);
  const wideArsenal = buildSingleInstance('royal_atarazanas_arsenal', 38.0, 38.0, 8.4);
  assert.ok(wideArsenal.triangleCount > narrowArsenal.triangleCount + 250, 'Widening royal_atarazanas_arsenal iterates additional parallel gabled halls');

  const shortBridge = buildSingleInstance('stone_arch_bridge', 7.2, 18.0, 4.6);
  const longBridge = buildSingleInstance('stone_arch_bridge', 7.2, 38.0, 4.6);
  assert.ok(longBridge.triangleCount > shortBridge.triangleCount + 180, 'Lengthening stone_arch_bridge iterates additional cutwater piers and stone arches');

  // Verify all 12 new primitives emit finite unit-normal geometry and include new material kinds 15 (palm thatch) and 16 (cobbled/terreplein)
  const region = resolveGlobalCoastalRegion({ ...SPANISH_MAIN_1550_REGIONS.cartagena, size: 65, biomeSize: 64, albedoSize: 64 });
  const heights = synthesizeCoastalTerrain(region);
  const port = placeCoastalPort(region, heights);
  const geom = buildPortPrefabGeometry(port);
  const emittedKinds = new Set();
  for (let i = 0; i < geom.vertices.length; i += 8) {
    assert.ok(geom.vertices.subarray(i, i + 8).every(Number.isFinite));
    const nLen = Math.hypot(geom.vertices[i + 3], geom.vertices[i + 4], geom.vertices[i + 5]);
    assert.ok(Math.abs(nLen - 1) < 1e-4, 'unit normal on bay-iterated port vertex');
    emittedKinds.add(Math.round(geom.vertices[i + 6]));
  }
  for (const k of [10, 11, 12, 13, 14, 15, 16]) {
    assert.ok(emittedKinds.has(k), `Expected bay-iterated port geometry to emit material kind ${k}`);
  }
});

test('coastline smoothing removes beach potholes, aligns regional swells, and stitches section-by-section maps seamlessly', async () => {
  const region = resolveGlobalCoastalRegion({ ...SPANISH_MAIN_1550_REGIONS.havana, size: 65, biomeSize: 64, albedoSize: 64 });
  const n = region.size;
  const noisyHeights = new Float32Array(n * n);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      // Diagonal shoreline with a hard -2.0m cliff step and artificial beach potholes
      const s = i + j - 60;
      noisyHeights[j * n + i] = s > 0 ? 1.8 + s * 0.12 : -2.0 - Math.abs(s) * 0.4;
    }
  }
  // Punch isolated potholes into the dry beach zone
  const potholeIdx1 = 34 * n + 30;
  const potholeIdx2 = 36 * n + 32;
  noisyHeights[potholeIdx1] = -0.8;
  noisyHeights[potholeIdx2] = 0.02;

  smoothCoastlineAndForeshoreBeaches(noisyHeights, region);
  assert.ok(noisyHeights[potholeIdx1] > 1.2, `Expected beach pothole 1 to be filled (>1.2m), got ${noisyHeights[potholeIdx1]}`);
  assert.ok(noisyHeights[potholeIdx2] > 1.4, `Expected beach pothole 2 to be filled (>1.4m), got ${noisyHeights[potholeIdx2]}`);
  // Verify first wet cell (30,30) and second wet cell (29,30) next to shoreline are graded gently rather than jumping to -2.0m..-2.4m
  const firstWetCell = noisyHeights[30 * n + 30];
  const secondWetCell = noisyHeights[30 * n + 29];
  assert.ok(firstWetCell > -0.65 && firstWetCell < 0.65, `Expected first wet cell on littoral ramp near 0m, got ${firstWetCell}`);
  assert.ok(secondWetCell > -1.25 && secondWetCell < firstWetCell, `Expected monotonic littoral ramp at second wet cell, got ${secondWetCell}`);

  // Verify regional swell and wind directions orient naturally to each port's shoreBearing
  const havanaSea = coastalSeaForRegion('havana', 'coast');
  const cartagenaSea = coastalSeaForRegion('cartagena', 'coast');
  const sabaSea = coastalSeaForRegion('saba', 'coast');
  assert.equal(sabaSea.swellDir, 22);
  assert.equal(havanaSea.swellDir, (SPANISH_MAIN_1550_REGIONS.havana.shoreBearing - 90 + 360) % 360);
  assert.equal(cartagenaSea.swellDir, (SPANISH_MAIN_1550_REGIONS.cartagena.shoreBearing - 90 + 360) % 360);
  const havanaUrl = coastalRegionStageURL('https://example.com/ocean.html', 'havana', 'coast', 'clear');
  assert.equal(Number(havanaUrl.searchParams.get('swellDir')), havanaSea.swellDir);
  assert.equal(Number(havanaUrl.searchParams.get('windDir')), havanaSea.windDir);

  // Verify section-by-section neighbor generation and C0/C1 border stitching
  const basePack = generateProceduralCoastalPack({
    ...SPANISH_MAIN_1550_REGIONS.havana,
    size: 65,
    biomeSize: 64,
    albedoSize: 64,
    vegetationCandidates: 1500,
  });
  const dirs = detectCoastalContinuationDirs(basePack.rawHeights || basePack.heights, basePack.region.size, basePack.region.shoreBearing);
  assert.ok(dirs.length >= 2, 'Expected coastal continuation detector to identify adjacent coastal sections');

  const getSectionAt = (sx, sz) => (sx === 0 && sz === 0 ? basePack : null);
  const eastSection = await generateCoastalNeighborSection(basePack, 1, 0, getSectionAt, {
    size: 65,
    biomeSize: 64,
    albedoSize: 64,
    vegetationCandidates: 800,
    useRealDEM: false,
  });
  assert.equal(eastSection.secX, 1);
  assert.equal(eastSection.secZ, 0);
  assert.equal(eastSection.region.x, basePack.region.x + basePack.region.span);
  assert.equal(eastSection.region.z, basePack.region.z);

  // Verify shared border (West edge i=0 of eastSection vs East edge i=n-1 of basePack) matches with < 0.05m tolerance
  const baseSrc = basePack.rawHeights || basePack.heights;
  for (let j = 4; j < n - 4; j++) {
    const hBaseEast = baseSrc[j * n + (n - 1)];
    const hNeighborWest = eastSection.heights[j * n + 0];
    assert.ok(
      Math.abs(hBaseEast - hNeighborWest) < 0.05,
      `Expected seamless border stitch at row ${j}: baseEast=${hBaseEast}, neighborWest=${hNeighborWest}`
    );
  }
  // Verify unconnected outer East border (i=n-1 of eastSection) tapers below sea level (<= -14m) so no square cliff ends in the ocean
  for (let j = 0; j < n; j++) {
    assert.ok(
      eastSection.heights[j * n + (n - 1)] <= -14,
      `Expected unconnected outer section boundary to round below sea level (<= -14m), got ${eastSection.heights[j * n + (n - 1)]}`
    );
  }
});





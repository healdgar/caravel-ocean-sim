// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import {
  SPANISH_MAIN_1550_REGIONS,
  COLONIAL_ERAS,
  resolveColonialEra,
  HISTORICAL_1550_PORTS,
  HISTORICAL_COLONIAL_PORTS,
  findHistoricalColonialPort,
  hasHistorical1550ColonialPort,
  computeColonyGrowthProfile,
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
  classifyKoppenClimateFromNormals,
  estimateLocalClimateProfile,
  fetchPublicClimateProfile,
} from '../js/coastal-world.js';
import {
  FOREST_SPECIES,
  FOREST_ROOT_FLOATS,
  SUBTROPICAL_FOREST_ASSETS,
  loadForestScenery,
} from '../js/forest-scenery.js';
import {
  SUBTROPICAL_FOREST_MIDDLE_ASSETS,
  loadForestMiddle,
} from '../js/forest-middle.js';
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
    'lisbon',
  ];
  assert.deepEqual(Object.keys(SPANISH_MAIN_1550_REGIONS), expectedIds);
  for (const id of expectedIds) {
    const r = resolveGlobalCoastalRegion(id);
    assert.equal(r.id, id);
    assert.equal(r.era, 1550);
    assert.ok(r.latitude > 8 && r.latitude < 42);
    assert.ok(r.longitude > -85 && r.longitude < -5);
    assert.ok(r.span >= 4096);
    assert.ok(r.size >= 65);
    assert.ok(Object.isFrozen(r));
  }
  assert.throws(() => resolveGlobalCoastalRegion('atlantis'), /Unknown Spanish Main/);
  assert.throws(() => resolveGlobalCoastalRegion({ latitude: 95, longitude: 0 }), /latitude/);
  assert.throws(() => resolveGlobalCoastalRegion({ latitude: 10, longitude: 195 }), /longitude/);
});

test('1550 Lisbon departure dock (Ribeira das Naus & Cais da Índia) models L-head embarkation pier, crane, arsenal, and safe dock berth', () => {
  const pack = generateProceduralCoastalPack('lisbon', {
    size: 129,
    biomeSize: 128,
    albedoSize: 128,
    vegetationCandidates: 1500,
  });
  assert.equal(pack.region.id, 'lisbon');
  assert.equal(pack.region.portType, 'royal-arsenal-dock');
  assert.ok(pack.views.dock, 'Lisbon pack exposes a dedicated dock departure view');
  assert.equal(pack.views.dock.heading, 255, 'Lisbon dock berth faces 255° WSW down the Tagus channel past Ribeira das Naus and Torre de Belém');
  assert.ok(pack.views.dock.depth >= 5.5, `Lisbon dock berth has deep navigable water (${pack.views.dock.depth.toFixed(1)}m)`);
  assert.equal(pack.views.dock.moved, false, 'Lisbon dock berth clears the caravel draft without displacement');

  const labels = pack.port.instances.map((i) => i.label);
  assert.ok(labels.some((l) => l.includes('Ponte da Casa da Índia')), 'includes Royal Embarkation Pier');
  assert.ok(labels.some((l) => l.includes('Cais da Ribeira')), 'includes L-head Departure Mole & Crane Wharf');
  assert.ok(labels.some((l) => l.includes('Paço da Ribeira & Casa da Índia')), 'includes Casa da Índia');
  assert.ok(labels.some((l) => l.includes('Ribeira das Naus')), 'includes Ribeira das Naus Royal Shipyard');
  assert.ok(labels.some((l) => l.includes('Torre de Belém')), 'includes Torre de Belém / Baluarte river bastion');

  const piers = pack.port.instances.filter((i) => i.prefabId === 'timber_mole_pier');
  assert.equal(piers.length, 3, 'Lisbon harbor has main pier, L-head mole, and shipyard fitting-out pier');
  const distToMole = Math.min(...piers.map((p) => Math.hypot(pack.views.dock.x - p.x, pack.views.dock.z - p.z)));
  assert.ok(distToMole >= 16 && distToMole <= 46, `dock start sits right alongside the departure mole (${distToMole.toFixed(1)}m)`);
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

  // Verify multi-quad contiguity across cardinal + diagonal corner sections ((1,0), (0,1), (1,1) for Havana SE inland) with zero water trenches
  assert.ok(
    dirs.some(d => d.dx === 1 && d.dz === 1),
    'Expected detectCoastalContinuationDirs to include diagonal corner (1, 1) when East (1, 0) and South (0, 1) borders carry land'
  );
  const plannedSet = new Set(dirs.map(d => `${d.dx},${d.dz}`));
  const loadedMap = new Map([['0,0', basePack]]);
  const getMultiSectionAt = (sx, sz, includePlanned = false) => {
    const rec = loadedMap.get(`${sx},${sz}`);
    if (rec) return rec;
    if (includePlanned && plannedSet.has(`${sx},${sz}`)) return { planned: true, secX: sx, secZ: sz };
    return null;
  };
  const sec10 = await generateCoastalNeighborSection(basePack, 1, 0, getMultiSectionAt, {
    size: 65,
    biomeSize: 64,
    albedoSize: 64,
    vegetationCandidates: 800,
    useRealDEM: false,
  });
  loadedMap.set('1,0', sec10);
  const sec01 = await generateCoastalNeighborSection(basePack, 0, 1, getMultiSectionAt, {
    size: 65,
    biomeSize: 64,
    albedoSize: 64,
    vegetationCandidates: 800,
    useRealDEM: false,
  });
  loadedMap.set('0,1', sec01);
  const sec11 = await generateCoastalNeighborSection(basePack, 1, 1, getMultiSectionAt, {
    size: 65,
    biomeSize: 64,
    albedoSize: 64,
    vegetationCandidates: 800,
    useRealDEM: false,
  });
  loadedMap.set('1,1', sec11);

  // Check seam between (0, 1) East edge and (1, 1) West edge: must match within 0.05m and preserve inland elevation (> 2m) without any water trench
  for (let j = 6; j < n - 6; j++) {
    const hSouthEastEdge = sec01.heights[j * n + (n - 1)];
    const hCornerWestEdge = sec11.heights[j * n + 0];
    assert.ok(
      Math.abs(hSouthEastEdge - hCornerWestEdge) < 0.05,
      `Expected seamless stitch between (0,1) East and (1,1) West at row ${j}: ${hSouthEastEdge} vs ${hCornerWestEdge}`
    );
    assert.ok(
      hCornerWestEdge > 2.0,
      `Expected inland seam between (0,1) and (1,1) to stay above water (>2m, no water trench), got ${hCornerWestEdge} at row ${j}`
    );
  }

  // Verify 3D closed-canopy forest retargeting populates trees across extraSections as well as the center section
  const { retargetForestPackToProcedural } = await import('../js/terrain.js');
  const stubManifest = {
    bounds: [
      [-basePack.region.span * 0.5, 0, -basePack.region.span * 0.5],
      [basePack.region.span * 1.5, 180, basePack.region.span * 1.5],
    ],
    prototypes: [
      { id: 0, crownRadius: 8, basalRadius: 1.1 },
      { id: 1, crownRadius: 9, basalRadius: 1.3 },
    ],
  };
  const stubPack = {
    manifest: stubManifest,
    roots: new Float32Array(256 * 12),
    rootCount: 256,
    maxRootCapacity: 256,
  };
  const multiForest = retargetForestPackToProcedural(
    stubPack,
    basePack,
    () => 12.0,
    { isMobile: false, extraSections: [sec10, sec01, sec11], maxRootCapacity: 64000 }
  );
  let centerTrees = 0;
  let neighborTrees = 0;
  const halfSpan = basePack.region.span * 0.5;
  const totalRoots = multiForest.roots.length / 12;
  for (let i = 0; i < totalRoots; i++) {
    const x = multiForest.roots[i * 12 + 0];
    const z = multiForest.roots[i * 12 + 2];
    if (Math.abs(x - basePack.region.x) <= halfSpan && Math.abs(z - basePack.region.z) <= halfSpan) {
      centerTrees++;
    } else {
      neighborTrees++;
    }
  }
  assert.ok(centerTrees > 500, `Expected center section to have >500 3D forest roots, got ${centerTrees}`);
  assert.ok(neighborTrees > 1000, `Expected neighbor sections to have >1000 3D forest roots, got ${neighborTrees}`);
});

test('subtropical forest scenery pack, public NASA POWER climate lookup, and climate-driven species mix', async () => {
  // 1. Verify Köppen-Geiger climate classification and species weight mixes across global climate normals
  const af = classifyKoppenClimateFromNormals({
    latitude: 9.55,
    longitude: -79.65,
    monthlyTempC: [26.5, 26.8, 27.1, 27.3, 27.0, 26.8, 26.7, 26.7, 26.6, 26.4, 26.3, 26.4],
    monthlyPrecipMm: [140, 95, 85, 190, 340, 360, 380, 370, 350, 410, 460, 280],
    meanRelHumidityPct: 84,
  });
  assert.equal(af.koppenCode, 'Af');
  assert.equal(af.forestPackKind, 'subtropical');
  assert.ok(af.uplandForestWeights.ceiba > 0.30, 'Rainforest (Af) has high emergent Ceiba weight');

  const aw = classifyKoppenClimateFromNormals({
    latitude: 10.42,
    longitude: -75.55,
    monthlyTempC: [26.8, 27.0, 27.4, 28.0, 28.4, 28.4, 28.2, 28.2, 28.1, 27.8, 27.6, 27.1],
    monthlyPrecipMm: [4, 2, 5, 32, 115, 105, 95, 110, 130, 220, 145, 38],
    meanRelHumidityPct: 78,
  });
  assert.equal(aw.koppenCode, 'Aw');
  assert.equal(aw.forestPackKind, 'subtropical');
  assert.ok(
    aw.uplandForestWeights.palm > af.uplandForestWeights.palm,
    'Tropical savanna (Aw) increases drought-tolerant palm share vs wet rainforest (Af)'
  );

  const cfb = classifyKoppenClimateFromNormals({
    latitude: 50.8,
    longitude: -1.1,
    monthlyTempC: [5.2, 5.4, 7.2, 9.5, 12.8, 15.6, 17.8, 17.6, 15.1, 11.8, 8.1, 5.8],
    monthlyPrecipMm: [75, 55, 58, 52, 56, 54, 58, 65, 68, 88, 92, 84],
    meanRelHumidityPct: 79,
  });
  assert.equal(cfb.koppenCode, 'Cfb');
  assert.equal(cfb.forestPackKind, 'temperate');
  assert.ok(cfb.uplandForestWeights.oak > 0.25);

  // 2. Verify fetchPublicClimateProfile parses NASA POWER 30-year climatology JSON and falls back cleanly offline
  const mockNasaPowerResponse = {
    properties: {
      parameter: {
        T2M: {
          JAN: 25.7, FEB: 25.8, MAR: 26.2, APR: 26.8, MAY: 27.4, JUN: 27.6,
          JUL: 27.4, AUG: 27.5, SEP: 27.5, OCT: 27.1, NOV: 26.6, DEC: 26.0,
        },
        PRECTOTCORR: {
          JAN: 0.4, FEB: 0.3, MAR: 0.5, APR: 1.4, MAY: 3.9, JUN: 3.5,
          JUL: 3.1, AUG: 3.7, SEP: 4.4, OCT: 7.2, NOV: 4.8, DEC: 1.2,
        },
        RH2M: { ANN: 79.2 },
      },
    },
  };
  const liveProfile = await fetchPublicClimateProfile(10.423, -75.548, {
    fetchImpl: async () => ({
      ok: true,
      json: async () => mockNasaPowerResponse,
    }),
  });
  assert.equal(liveProfile.source, 'nasa-power-climatology');
  assert.equal(liveProfile.koppenCode, 'Aw');
  assert.equal(liveProfile.forestPackKind, 'subtropical');

  // 3. Load the 5-tier subtropical forest scenery pack & middle LOD pack and verify all 4 tropical species
  const fetchLocalAsset = async (url) => {
    const buf = fs.readFileSync(url);
    const ab = buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength);
    return {
      ok: true,
      status: 200,
      arrayBuffer: async () => ab,
      json: async () => JSON.parse(buf.toString('utf8')),
      blob: async () => new Blob([ab]),
    };
  };
  const subtropicalPack = await loadForestScenery({
    assets: SUBTROPICAL_FOREST_ASSETS,
    fetchAsset: fetchLocalAsset,
    decodeImage: async () => ({ width: 512, height: 512, close() {} }),
  });
  assert.deepEqual(
    subtropicalPack.manifest.prototypes.map((p) => p.species),
    ['royal_palm', 'palm', 'ceiba', 'mangrove']
  );
  assert.ok(subtropicalPack.volumes?.prototypes?.length === 4, 'Subtropical pack includes 4 3D optical volume fields');
  const subtropicalMiddle = await loadForestMiddle({
    forest: subtropicalPack.manifest,
    assets: SUBTROPICAL_FOREST_MIDDLE_ASSETS,
    fetchAsset: fetchLocalAsset,
  });
  assert.equal(subtropicalMiddle.prototypes.length, 4);

  // 4. Verify retargetForestPackToProcedural places all 4 subtropical species and adapts mix to climate
  const { retargetForestPackToProcedural } = await import('../js/terrain.js');
  const cartagenaBase = generateProceduralCoastalPack({
    ...SPANISH_MAIN_1550_REGIONS.cartagena,
    size: 65,
    biomeSize: 64,
    albedoSize: 64,
    vegetationCandidates: 4000,
  });
  const cartagena1550 = await runLandfallDiscoveryPipeline(cartagenaBase);
  const pack1550 = cartagena1550.upgradedPack;

  // Verify Cartagena 1550 rawHeights matches heights and detects North (0, -1), North-2 (0, -2), East (1, 0), and South (0, 1) continuations
  const cartagenaDirs = detectCoastalContinuationDirs(
    pack1550.rawHeights,
    pack1550.region.size,
    pack1550.region.shoreBearing
  );
  assert.ok(
    cartagenaDirs.some((d) => d.dx === 0 && d.dz === -1) &&
      cartagenaDirs.some((d) => d.dx === 0 && d.dz === -2),
    'Cartagena 1550 detects North (0, -1) and (0, -2) continuation quads on the left of the northeast view'
  );
  assert.ok(
    cartagenaDirs.some((d) => d.dx === 1 && d.dz === 0) &&
      cartagenaDirs.some((d) => d.dx === 1 && d.dz === -1),
    'Cartagena 1550 detects East (1, 0) and Northeast (1, -1) continuation quads'
  );

  const groundFn = (x, z) => terrainSample(pack1550.heights, x, z, pack1550.region);
  const retargetedAw = retargetForestPackToProcedural(subtropicalPack, pack1550, groundFn, {
    climateProfile: aw,
  });
  const retargetedAf = retargetForestPackToProcedural(subtropicalPack, pack1550, groundFn, {
    climateProfile: af,
  });

  const countsAw = Object.fromEntries(
    retargetedAw.manifest.prototypes.map((p) => [p.species, p.rootCount])
  );
  const countsAf = Object.fromEntries(
    retargetedAf.manifest.prototypes.map((p) => [p.species, p.rootCount])
  );
  for (const sp of ['royal_palm', 'palm', 'ceiba', 'mangrove']) {
    assert.ok(countsAw[sp] > 0, `Expected ${sp} to be placed in Cartagena subtropical forest, got ${countsAw[sp]}`);
  }
  const ceibaShareAf = countsAf.ceiba / Math.max(1, retargetedAf.manifest.rootCount);
  const ceibaShareAw = countsAw.ceiba / Math.max(1, retargetedAw.manifest.rootCount);
  assert.ok(
    ceibaShareAf > ceibaShareAw,
    `Expected humid rainforest (Af) to have higher Ceiba canopy fraction (${ceibaShareAf.toFixed(3)}) than dry savanna (Aw, ${ceibaShareAw.toFixed(3)})`
  );
});

test('deep-draft HMS Victory at Cartagena coast spawns with clear forward sea room, sails freely offshore, and runs aground at the beach', () => {
  const pack = generateProceduralCoastalPack({
    ...SPANISH_MAIN_1550_REGIONS.cartagena,
    size: 129,
    biomeSize: 64,
    albedoSize: 64,
    vegetationCandidates: 1500,
  });
  const victory = {
    length: 68,
    beam: 15.8,
    heading: 82,
    hydrodynamics: { draft: 8.8 },
  };
  const view = { ...pack.views.coast, heading: 82 };
  const start = safeLandfallStart(pack.heights, view, victory, pack.region);
  const boat = {
    ...victory,
    x: start.x,
    z: start.z,
    heading: 82,
    surgeVelocity: 4.0,
    leewayVelocity: 0.1,
  };
  // Advance 25 metres forward along heading 82°: must NOT falsely ground offshore
  const rad = (82 * Math.PI) / 180;
  const prevX = boat.x;
  const prevZ = boat.z;
  boat.x += Math.sin(rad) * 25;
  boat.z -= Math.cos(rad) * 25;
  const blockedOffshore = constrainIslandMotion(pack.heights, boat, prevX, prevZ, null, pack.region);
  assert.equal(blockedOffshore, false, 'HMS Victory sails freely offshore without hitting an invisible -9.8m contour wall');
  assert.equal(boat.aground, false);
  assert.ok(boat.surgeVelocity > 2.5, 'HMS Victory retains forward headway in navigable coastal water');

  // Now march shoreward until the hull reaches the actual beach/shoal and verify genuine grounding + refloating
  let grounded = false;
  const shoreRad = (pack.region.shoreBearing * Math.PI) / 180;
  const sx = Math.sin(shoreRad);
  const sz = -Math.cos(shoreRad);
  for (let step = 0; step < 300; step++) {
    const px = boat.x;
    const pz = boat.z;
    boat.x += sx * 8;
    boat.z += sz * 8;
    boat.surgeVelocity = 3.0;
    if (constrainIslandMotion(pack.heights, boat, px, pz, null, pack.region)) {
      grounded = true;
      assert.equal(boat.aground, true, 'Boat is marked aground when running onto the beach/shoal');
      assert.ok(Number.isFinite(boat.groundingRoll) && Number.isFinite(boat.groundingPitch));
      // Backing/steering offshore toward deeper water must allow refloating
      const gx = boat.x;
      const gz = boat.z;
      boat.x -= sx * 12;
      boat.z -= sz * 12;
      boat.surgeVelocity = -1.5;
      const blockedBackingOff = constrainIslandMotion(pack.heights, boat, gx, gz, null, pack.region);
      assert.equal(blockedBackingOff, false, 'Vessel can back or steer off a shoal into deeper water');
      break;
    }
  }
  assert.equal(grounded, true, 'HMS Victory genuinely runs aground when driven onto the Cartagena beach');
});

test('uncolonized 1550 coastlines (such as Boston) generate wilderness anchorages without Spanish colonial ports, while historical 1550 ports retain full fortifications', () => {
  assert.ok(HISTORICAL_1550_PORTS.length >= 25, 'historical 1550 port gazetteer includes c. 1550 colonial and Old World maritime hubs');
  assert.equal(hasHistorical1550ColonialPort(42.3601, -71.0589), false, 'Boston was uncolonized wilderness in 1550');
  assert.equal(hasHistorical1550ColonialPort(40.70, -74.01), false, 'New York Harbor was uncolonized wilderness in 1550');
  assert.equal(hasHistorical1550ColonialPort(10.423, -75.548), true, 'Cartagena de Indias was a fortified Spanish port in 1550');
  assert.equal(hasHistorical1550ColonialPort(38.707, -9.136), true, 'Lisbon was an Old World maritime port in 1550');

  const bostonPack = generateProceduralCoastalPack({
    name: 'Boston Harbor',
    latitude: 42.3601,
    longitude: -71.0589,
    size: 65,
    biomeSize: 64,
    albedoSize: 64,
    vegetationCandidates: 3000,
  });

  assert.equal(bostonPack.region.hasColonialPort, false);
  assert.equal(bostonPack.region.settlementKind, 'wilderness-anchorage');
  assert.equal(bostonPack.region.portType, 'wilderness-anchorage');
  assert.equal(bostonPack.port.hasColonialPort, false);
  assert.equal(bostonPack.port.settlementKind, 'wilderness-anchorage');
  assert.equal(bostonPack.port.instances.length, 0, 'no Spanish bastions, piers, or colonial buildings placed in 1550 Boston');
  assert.equal(bostonPack.port.clearRadius, 0, 'no circular cobblestone plaza or forest clearing around 1550 Boston');
  assert.equal(bostonPack.portGeometry.instanceCount, 0);
  assert.equal(bostonPack.portGeometry.triangleCount, 0);
  assert.ok(bostonPack.port.berth.depth >= 4.5, 'wilderness coast still locates a safe natural anchorage berth');
  assert.ok(Number.isFinite(bostonPack.views.coast.x) && Number.isFinite(bostonPack.views.coast.z));

  // Verify 1550 territory cache roundtrip preserves schemaVersion 2 & wilderness-anchorage metadata,
  // while legacy v1 cached payloads (from before wilderness gating) are rejected so flattened Plaza Mayor pads are not reused.
  const upgradedBoston = build1550HistoricalTerritoryPack(bostonPack);
  assert.equal(upgradedBoston.territory1550.schemaVersion, 2);
  assert.equal(upgradedBoston.territory1550.hasColonialPort, false);
  assert.equal(upgradedBoston.territory1550.settlementKind, 'wilderness-anchorage');
  assert.equal(upgradedBoston.port.instances.length, 0);

  const v2Bytes = encode1550TerritoryCachePayload(upgradedBoston);
  const decodedV2 = apply1550TerritoryCachePayload(bostonPack, v2Bytes);
  assert.ok(decodedV2, 'schemaVersion 2 wilderness cache payload is accepted');
  assert.equal(decodedV2.port.instances.length, 0);

  const legacyPack = {
    ...upgradedBoston,
    territory1550: { ...upgradedBoston.territory1550, schemaVersion: undefined },
  };
  const legacyV1Bytes = encode1550TerritoryCachePayload(legacyPack);
  const decodedLegacy = apply1550TerritoryCachePayload(bostonPack, legacyV1Bytes);
  assert.equal(decodedLegacy, null, 'legacy v1 cached heightfield is rejected for wilderness anchorages');

  // Verify historical 1550 Old World / Spanish Main coordinates resolved purely by lat/lon still place full ports
  const lisbonPack = generateProceduralCoastalPack({
    name: 'Lisbon Tagus Approach',
    latitude: 38.707,
    longitude: -9.136,
    size: 65,
    biomeSize: 64,
    albedoSize: 64,
    vegetationCandidates: 2000,
  });
  assert.equal(lisbonPack.region.hasColonialPort, true);
  assert.equal(lisbonPack.region.settlementKind, 'colonial-port');
  assert.ok(lisbonPack.port.instances.length >= 7, 'historical 1550 port coordinate places full 16th-century waterfront');
});

test('scenery pass: beach wet sand, stratified stone, baked distant canopy domes, and multi-tier tree LOD shaders', async () => {
  const { TERRAIN } = await import('../js/wgsl/terrain.js');
  const { FOREST_VERTEX_WGSL } = await import('../js/forest-scenery.js');

  // Verify WGSL terrain shader includes wet-film Fresnel reflection, active wave-swash film, capillary damp sand,
  // dual-scale wave/wind beach ripples, stepped cliff strata, and derivative-filtered baked canopy crown domes
  assert.match(TERRAIN, /waterFilm/);
  assert.match(TERRAIN, /capillaryZone/);
  assert.match(TERRAIN, /waveRipple/);
  assert.match(TERRAIN, /windRipple/);
  assert.match(TERRAIN, /ledgeStep/);
  assert.match(TERRAIN, /cragFacet/);
  assert.match(TERRAIN, /crownBillow/);
  assert.match(TERRAIN, /crownGap/);
  assert.match(TERRAIN, /skyRefl/);

  // Verify WGSL forest LOD shaders include rounded cluster dome curvature, wind flutter, and far/middle crown-clump normal relief
  assert.match(FOREST_VERTEX_WGSL, /domeCurve/);
  assert.match(FOREST_VERTEX_WGSL, /frondCurve/);
  assert.match(FOREST_VERTEX_WGSL, /farNorm/);
});

test('colony growth year-by-year and era-by-era (1550–1689): founding dates, stage progression, fortifications, chart knowledge, and 17th-century encounters', async () => {
  const { classify1550Knowledge } = await import('../js/voyage/chart-drawer.js');
  const { pickEncounterArchetype } = await import('../js/voyage/encounters.js');

  // 1. Colonial eras cover 1550 through 1689 and resolve by year or era ID
  assert.equal(COLONIAL_ERAS.length, 5);
  assert.equal(resolveColonialEra(1550).id, 'hapsburg-conquistador');
  assert.equal(resolveColonialEra(1595).id, 'iberian-union-antonelli');
  assert.equal(resolveColonialEra(1635).id, 'atlantic-planting');
  assert.equal(resolveColonialEra(1660).id, 'buccaneer-commonwealth');
  assert.equal(resolveColonialEra(1682).id, 'high-buccaneer-1680s');
  assert.equal(resolveColonialEra('high-buccaneer-1680s').year, 1680);

  // 2. Post-1550 colonial ports: Boston (founded 1630) grows from wilderness (1550..1625) -> outpost (1632) -> settlement (1655) -> citadel-metropolis (1680)
  const bostonCoord = { name: 'Boston Harbor', latitude: 42.3601, longitude: -71.0589 };
  const gridOpts = { size: 65, biomeSize: 64, albedoSize: 64, vegetationCandidates: 1200 };

  const boston1550 = generateProceduralCoastalPack({ ...bostonCoord, year: 1550, ...gridOpts });
  assert.equal(boston1550.region.hasColonialPort, false);
  assert.equal(boston1550.region.colonyGrowth.stage, 'wilderness');
  assert.equal(boston1550.port.instances.length, 0);
  assert.equal(boston1550.port.fortificationTier, 0);

  const boston1632 = generateProceduralCoastalPack({ ...bostonCoord, year: 1632, ...gridOpts });
  assert.equal(boston1632.region.hasColonialPort, true);
  assert.equal(boston1632.region.colonyGrowth.stage, 'outpost');
  assert.equal(boston1632.port.fortificationTier, 1);
  assert.ok(boston1632.port.instances.length >= 6 && boston1632.port.instances.length <= 12);

  const boston1655 = generateProceduralCoastalPack({ ...bostonCoord, year: 1655, ...gridOpts });
  assert.equal(boston1655.region.colonyGrowth.stage, 'settlement');
  assert.equal(boston1655.port.fortificationTier, 2);
  assert.ok(boston1655.port.instances.length > boston1632.port.instances.length);

  const boston1680 = generateProceduralCoastalPack({ ...bostonCoord, year: 1680, ...gridOpts });
  assert.equal(boston1680.region.colonyGrowth.stage, 'citadel-metropolis');
  assert.equal(boston1680.port.fortificationTier, 4);
  assert.ok(boston1680.port.instances.length > boston1655.port.instances.length);
  assert.ok(boston1680.portGeometry.vertices.length > boston1632.portGeometry.vertices.length);

  // 3. Port Royal, Jamaica (founded 1655) is wilderness in 1600, outpost in 1658, and buccaneer metropolis by 1680
  const portRoyal1600 = resolveGlobalCoastalRegion({ id: 'port-royal', year: 1600 });
  assert.equal(portRoyal1600.hasColonialPort, false);
  assert.equal(portRoyal1600.colonyGrowth.stage, 'wilderness');

  const portRoyal1658 = resolveGlobalCoastalRegion({ id: 'port-royal', year: 1658 });
  assert.equal(portRoyal1658.hasColonialPort, true);
  assert.equal(portRoyal1658.colonyGrowth.stage, 'outpost');

  const portRoyal1680 = generateProceduralCoastalPack({ id: 'port-royal', year: 1680, ...gridOpts });
  assert.equal(portRoyal1680.region.hasColonialPort, true);
  assert.equal(portRoyal1680.region.colonyGrowth.stage, 'citadel-metropolis');
  assert.equal(portRoyal1680.port.fortificationTier, 4);
  assert.ok(portRoyal1680.port.instances.length >= 20);

  // 4. Historical port supersession: Nombre de Dios (1510–1596) vs Portobelo (founded 1597)
  const nombre1550 = resolveGlobalCoastalRegion({ latitude: 9.58, longitude: -79.47, year: 1550 });
  const portobelo1550 = resolveGlobalCoastalRegion({ id: 'portobelo', year: 1550 });
  assert.equal(nombre1550.hasColonialPort, true);
  assert.equal(portobelo1550.hasColonialPort, false, 'Portobelo is uncolonized before 1597');

  const nombre1615 = resolveGlobalCoastalRegion({ latitude: 9.58, longitude: -79.47, year: 1615 });
  const portobelo1615 = resolveGlobalCoastalRegion({ id: 'portobelo', year: 1615 });
  assert.equal(nombre1615.colonyGrowth.stage, 'outpost', 'Nombre de Dios decayed after 1596 Drake raid');
  assert.equal(portobelo1615.hasColonialPort, true);
  assert.equal(portobelo1615.colonyGrowth.stage, 'fortified-port');

  // 5. Curated Spanish Main ports (Cartagena & Havana) expand year-by-year from 1550 to 1680
  const cartagena1550 = generateProceduralCoastalPack({ id: 'cartagena', year: 1550, ...gridOpts });
  const cartagena1605 = generateProceduralCoastalPack({ id: 'cartagena', year: 1605, ...gridOpts });
  const cartagena1680 = generateProceduralCoastalPack({ id: 'cartagena', year: 1680, ...gridOpts });
  assert.equal(cartagena1550.port.stage, 'fortified-port');
  assert.equal(cartagena1550.port.fortificationTier, 2);
  assert.equal(cartagena1605.port.stage, 'fortified-port');
  assert.equal(cartagena1605.port.fortificationTier, 3);
  assert.equal(cartagena1680.port.stage, 'citadel-metropolis');
  assert.equal(cartagena1680.port.fortificationTier, 4);
  assert.ok(cartagena1605.port.instances.length > cartagena1550.port.instances.length);
  assert.ok(cartagena1680.port.instances.length > cartagena1605.port.instances.length);

  // 6. Chart knowledge progresses from 1550 to 1680 (Manila 1565+, Cape Horn 1616+, New Holland 1644+)
  assert.equal(classify1550Knowledge(14.6, 120.98, 1550), 'rumoured');
  assert.equal(classify1550Knowledge(14.6, 120.98, 1580), 'known');
  assert.equal(classify1550Knowledge(-55.98, -67.27, 1550), 'rumoured');
  assert.equal(classify1550Knowledge(-55.98, -67.27, 1625), 'known');
  assert.equal(classify1550Knowledge(-20.0, 118.0, 1550), 'unknown');
  assert.equal(classify1550Knowledge(-20.0, 118.0, 1620), 'rumoured');
  assert.equal(classify1550Knowledge(-20.0, 118.0, 1660), 'known');

  // 7. Encounter archetypes include 17th-century buccaneers, Dutch fluyts, and English galleons in later eras
  const seen1550 = new Set();
  const seen1675 = new Set();
  for (let i = 0; i < 40; i++) {
    const r = () => ((i * 37 + 11) % 100) / 100;
    seen1550.add(pickEncounterArchetype(18.0, -76.0, r, 1550).id);
    seen1675.add(pickEncounterArchetype(18.0, -76.0, r, 1675).id);
  }
  assert.equal(seen1550.has('buccaneer-sloop'), false, 'no 17th-century buccaneer sloops in 1550');
  assert.equal(seen1675.has('buccaneer-sloop'), true, 'buccaneer sloops appear in Caribbean by 1675');
});









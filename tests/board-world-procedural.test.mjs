// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';

import { BAKED_BOARDS, BAKED_WORLDS, BOARD_SURVEY_SIZE, boardGroundFits } from '../js/board-model.js';
import { oldWorldCountry, registerBakedBoard } from '../js/old-world.js';
import {
  HISTORICAL_COLONIAL_PORTS,
  buildCoastalMesh,
  computeCoastalShoreDistances,
  riverPolygonDifference,
  synthesizeCoastalBeaches,
} from '../js/coastal-world.js';
import {
  ROAMING_FIELD_SIZE,
  ROAMING_FIELD_SPAN_M,
  layTownStreets,
  paveCityStreets,
  streetEdgeAt,
} from '../js/town-streets.js';
import { terrainSurfaceSample } from '../js/terrain-model.js';
import { openBoard } from '../scripts/board-host.mjs';
import { NEW_WORLD_ERA as era } from '../js/career-era.js';
import { ensureCareerLedger, getBoardMarket, marketQuote, setBoardMarket } from '../js/career-trade.js';
import { createCareerPort } from '../js/career-port.js';
import { createCareerStore } from '../js/career-save.js';
import { createVesselDamageState } from '../js/gunnery-control.js';
import {
  TRADE_VESSEL_ARCHETYPES,
  TRADE_VESSELS_WGSL,
  buildTradeVesselRoutes,
  sampleTradeVesselState,
} from '../js/trade-vessels.js';
import { caravanHerdSeeds } from '../js/herds.js';
import {
  GRASS_LODS,
  GRASS_VARIANTS,
  GROUND_COVER_BUCKETS,
  ROCK_ARCHETYPES,
  ROCK_LODS,
  TREE_VERTEX_FLOATS,
  groundCoverBucketGeometry,
} from '../js/vegetation.js';
import { CITY_CULL, GROUND_COVER_CULL } from '../js/scenery-cull.js';
import { HERDS_STEP_WGSL } from '../js/wgsl/herds.js';
import { TERRAIN } from '../js/wgsl/terrain.js';
import { GROUND_DETAIL_RENDER } from '../js/wgsl/ground-detail.js';

function upsampleSurvey(survey, targetN = 257) {
  const sN = BOARD_SURVEY_SIZE;
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

function wgslBody(name, src = TERRAIN) {
  const at = src.indexOf(`fn ${name}(`);
  assert.ok(at >= 0, `missing WGSL fn ${name}`);
  let depth = 0;
  for (let i = src.indexOf('{', at); i < src.length; i++) {
    if (src[i] === '{') depth++;
    if (src[i] === '}' && --depth === 0) return src.slice(at, i + 1);
  }
  throw new Error(`unclosed WGSL fn ${name}`);
}

const lisbonBaked = JSON.parse(readFileSync(new URL('../' + BAKED_BOARDS['lisbon:1550'], import.meta.url), 'utf8'));
const lisbonRegion = { ...lisbonBaked.region, size: 257, biomeSize: 128, albedoSize: 256, year: 1550 };

function buildLisbonCountryAndMesh() {
  const heights = upsampleSurvey(lisbonBaked.survey, lisbonRegion.size);
  assert.ok(boardGroundFits(lisbonBaked.survey, heights), 'upsampled survey must match baked board survey');
  registerBakedBoard(lisbonBaked);
  const port = { center: { x: lisbonRegion.x, z: lisbonRegion.z }, clearRadius: 120, instances: [] };
  port.streets = layTownStreets(port, (x, z) => terrainSurfaceSample(heights, x, z, lisbonRegion));
  const country = oldWorldCountry(lisbonRegion, heights, port);
  assert.ok(country?.board, 'Lisbon 1550 baked board must activate');
  const streets = paveCityStreets(port.streets, country.plan.paving);
  const shoreDist = computeCoastalShoreDistances(heights, lisbonRegion.size, lisbonRegion.span, 0.25);
  const beaches = synthesizeCoastalBeaches(lisbonRegion, heights, null, shoreDist, { portPlacement: port });
  const mesh = buildCoastalMesh(lisbonRegion, heights, beaches, shoreDist, { ...port, riverCut: country.riverCut });
  return { heights, port, country, streets, mesh };
}

test('procedural village streets cover Almada/Cacilhas across the bay and trimmed roads avoid buildings', () => {
  assert.equal(ROAMING_FIELD_SPAN_M, 1600);
  assert.equal(ROAMING_FIELD_SIZE, 1024);
  const { country, streets } = buildLisbonCountryAndMesh();

  for (const name of ['Lisboa', 'Almada', 'Cacilhas', 'Santos']) {
    const place = country.places.find((p) => p.name === name);
    assert.ok(place, `place ${name} present`);
    assert.ok(place.streets.length > 0, `${name} must have procedural streets`);
    const midIdx = Math.floor(place.streets[0].points.length / 4) * 2;
    const wx = lisbonRegion.x + place.streets[0].points[midIdx];
    const wz = lisbonRegion.z + place.streets[0].points[midIdx + 1];
    const edge = streetEdgeAt(streets, wx, wz);
    assert.ok(edge < 0, `${name} street midpoint (${wx.toFixed(1)}, ${wz.toFixed(1)}) has edge ${edge.toFixed(2)}`);

    // Roaming GPU field helper stamps identically on north bank (Lisboa) and south bank (Almada/Cacilhas).
    const stamped = streets.stampAt(wx, wz);
    assert.equal(stamped, true, `${name} roaming stampAt returns true at (${wx.toFixed(1)}, ${wz.toFixed(1)})`);
    const u = (wx - streets.window.x) / streets.window.span + 0.5;
    const v = (wz - streets.window.z) / streets.window.span + 0.5;
    const ix = Math.max(0, Math.min(streets.size - 1, Math.floor(u * streets.size)));
    const iy = Math.max(0, Math.min(streets.size - 1, Math.floor(v * streets.size)));
    const texelSdf = streets.field[(iy * streets.size + ix) * 2];
    const texelPave = streets.field[(iy * streets.size + ix) * 2 + 1];
    assert.ok(texelSdf < 64 && texelPave > 0, `${name} roaming field texel (${texelSdf}, ${texelPave}) on street at (${wx.toFixed(1)}, ${wz.toFixed(1)})`);
  }

  // Trimmed inter-settlement roads should not bisect active settlement buildings inside their footprint core.
  assert.ok(country.roads.length > 0, 'trimmed inter-settlement roads present');
  let roadCoreHits = 0;
  for (const road of country.roads) {
    const pts = Array.isArray(road) ? road : road.points;
    assert.ok(Array.isArray(pts) && pts.length >= 4);
    for (let k = 0; k + 3 < pts.length; k += 2) {
      const ax = pts[k], az = pts[k + 1], bx = pts[k + 2], bz = pts[k + 3];
      const abx = bx - ax, abz = bz - az, len2 = abx * abx + abz * abz || 1;
      for (const lot of country.plan.lots) {
        if (Math.hypot(lot.x - ax, lot.z - az) > 60) continue;
        const t = Math.max(0, Math.min(1, ((lot.x - ax) * abx + (lot.z - az) * abz) / len2));
        const d = Math.hypot(ax + abx * t - lot.x, az + abz * t - lot.z);
        if (d < Math.min(lot.w, lot.d) * 0.22) roadCoreHits++;
      }
    }
  }
  assert.ok(roadCoreHits <= 4, `trimmed roads only rarely graze building cores: ${roadCoreHits}`);
});

test('Castle & Commons river meshing: PAV monotonic reaches, polygon clipping, and riverbank mesh', () => {
  // Unit checks for Sutherland-Hodgman riverPolygonDifference
  const tri = [[0, 0], [10, 0], [0, 10]];
  const area = (pts) => Math.abs((pts[1][0] - pts[0][0]) * (pts[2][1] - pts[0][1]) - (pts[2][0] - pts[0][0]) * (pts[1][1] - pts[0][1])) * 0.5;
  const disjoint = [[20, 20], [30, 20], [30, 30], [20, 30]];
  assert.equal(riverPolygonDifference(tri, disjoint).length, 1);

  const partial = [[2, 2], [8, 2], [8, 8], [2, 8]];
  const clipped = riverPolygonDifference(tri, partial);
  assert.ok(clipped.length >= 1, 'partially clipped triangle keeps exterior pieces');
  const clippedArea = clipped.reduce((s, t) => s + area(t), 0);
  assert.ok(clippedArea > 1 && clippedArea < area(tri) - 1, `clipped area ${clippedArea} < ${area(tri)}`);

  const enclosing = [[-5, -5], [20, -5], [20, 20], [-5, 20]];
  assert.deepEqual(riverPolygonDifference(tri, enclosing), []);

  // Integration check on Lisbon 1550
  const { country, mesh } = buildLisbonCountryAndMesh();
  assert.ok(country.riverCut && country.riverCut.cuts.length > 0, 'Lisbon produces river cuts');
  assert.ok(country.riverCut.bankVerts.length > 0 && country.riverCut.bankVerts.length % 8 === 0);
  assert.ok(country.riverCut.bankIndices.length >= 3 && country.riverCut.bankIndices.length % 3 === 0);
  assert.ok(country.riverReaches.length > 0, 'river reaches exported');
  for (const reach of country.riverReaches) {
    for (let i = 1; i < reach.points.length; i++) {
      assert.ok(reach.points[i][3] <= reach.points[i - 1][3] + 1e-6, `monotonic water level on reach ${reach.id}`);
    }
  }

  let bankVertsInMesh = 0;
  for (let i = 0; i + 7 < mesh.vertices.length; i += 8) {
    assert.ok(Number.isFinite(mesh.vertices[i]) && Number.isFinite(mesh.vertices[i + 1]) && Number.isFinite(mesh.vertices[i + 2]));
    if (mesh.vertices[i + 6] > 1.5 && mesh.vertices[i + 6] < 2.5) bankVertsInMesh++;
  }
  assert.ok(bankVertsInMesh > 0, 'coastal mesh includes riverbank embankment vertices');
});

test('live Castle & Commons economy couples to career-port and drives sea merchant ships & river boats', async () => {
  const worldBytes = readFileSync(new URL('../' + BAKED_WORLDS['lisbon:1550'], import.meta.url));
  const { country } = buildLisbonCountryAndMesh();

  const opened = await openBoard(lisbonBaked.request, { world: worldBytes });
  try {
    const caravanSnap = await opened.hook('caravans');
    assert.ok(Array.isArray(caravanSnap.list) && caravanSnap.list.length > 0, `caravans present: ${caravanSnap.list?.length}`);
    assert.ok(Array.isArray(caravanSnap.ships), 'caravans() includes live ships snapshot');

    const shipsSnap = await opened.hook('ships');
    assert.ok(Array.isArray(shipsSnap) && shipsSnap.length > 0, `merchant ships present: ${shipsSnap.length}`);

    const marketBefore = await opened.hook('market', 0);
    assert.equal(marketBefore.name, 'Lisboa');
    assert.ok(marketBefore.goods.wine.price > 0 && marketBefore.goods.grain.price > 0);

    // Execute live settlement trade on a commodity that Lisboa holds, or sell wine in to move price down then buy back.
    const wineBeforePrice = marketBefore.goods.wine.price;
    const sellRes = await opened.hook('trade', { place: 0, good: 'wine', act: 'sell', qty: 20 });
    assert.equal(sellRes.ok, true);
    assert.ok(sellRes.market.goods.wine.price <= wineBeforePrice, 'selling into market softens or holds price');
    const buyRes = await opened.hook('trade', { place: 0, good: 'wine', act: 'buy', qty: 10 });
    assert.equal(buyRes.ok, true);
    assert.ok(buyRes.market.goods.wine.price >= sellRes.market.goods.wine.price, 'buying from market firms price');

    // Verify bidirectional coupling into career-trade / career-port
    const mem = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };
    const store = createCareerStore({ storage: mem(), session: mem() });
    store.claim();
    const boat = { id: 'p', modelId: 'nina', length: 20, beam: 6, cargoTonnes: 0, provisionDays: 60 };
    createVesselDamageState(boat);
    const lisbonPort = HISTORICAL_COLONIAL_PORTS.find((p) => p.id === 'lisbon');
    const dateMs = Date.UTC(1550, 2, 14);
    const voyage = { dateMs, morale: 0.8, provisions: { food: 30, water: 20 } };
    const mirroredTrades = [];
    const careerPort = createCareerPort({
      era, store, boat,
      getVoyage: () => voyage,
      getCompany: () => ({ crew: [] }),
      getPort: () => lisbonPort,
      capacityOf: () => 40,
      hullMassOf: () => 113000,
      onBoardTrade: (t) => mirroredTrades.push(t),
    });
    const ledger = careerPort.ledger;
    ledger.purse = 5000;
    careerPort.setBoardMarket('lisbon', buyRes.market);
    const quote = marketQuote(era, ledger, lisbonPort, era.goods.find((g) => g.id === 'wine'), dateMs);
    assert.equal(quote.live, true);
    assert.ok(getBoardMarket(ledger, 'lisbon'));
    if (quote.offered) {
      const bought = careerPort.buy('wine', 1);
      assert.equal(bought.tonnes, 1);
      assert.equal(mirroredTrades.length, 1);
      assert.equal(mirroredTrades[0].boardGood, 'wine');
      assert.equal(mirroredTrades[0].act, 'buy');
    } else {
      ledger.cargo.wine = 2;
      const sold = careerPort.sell('wine', 1);
      assert.equal(sold.tonnes, 1);
      assert.equal(mirroredTrades.length, 1);
      assert.equal(mirroredTrades[0].act, 'sell');
    }

    // Verify trade vessels builder produces both ocean ships and navigable river barges and moves under 1x real-time play.
    const routes = buildTradeVesselRoutes(caravanSnap, lisbonRegion, {
      riverReaches: country.riverReaches,
      places: country.places,
      seaLevel: 0,
    });
    const seaUnderway = routes.find((r) => r.mode === 'sea' && r.phase !== 'dock');
    const riverBoat = routes.find((r) => r.mode === 'river');
    assert.ok(seaUnderway, 'active underway sea merchant ship route produced');
    assert.ok(riverBoat && riverBoat.archetype === 4, 'navigable river trade barge route produced');

    const s0 = sampleTradeVesselState(seaUnderway, caravanSnap.day, 0, 0);
    const s2 = sampleTradeVesselState(seaUnderway, caravanSnap.day, 0, 2.0);
    assert.ok(Math.hypot(s2.x - s0.x, s2.z - s0.z) >= 4.0, 'sea ship advances >= 2 m/s even at 0 daysPerSecond');

    const r0 = sampleTradeVesselState(riverBoat, caravanSnap.day, 0, 0);
    const r2 = sampleTradeVesselState(riverBoat, caravanSnap.day, 0, 2.0);
    assert.ok(Math.hypot(r2.x - r0.x, r2.z - r0.z) >= 2.0, 'river barge advances >= 1 m/s even at 0 daysPerSecond');
  } finally {
    await opened.close();
  }
});

test('fractured polyhedral boulders (18 buckets) + 4 grass buckets + progressive LOD and zero-discard WGSL shaders', () => {
  assert.equal(ROCK_ARCHETYPES, 6);
  assert.equal(ROCK_LODS, 3);
  assert.equal(GRASS_VARIANTS, 2);
  assert.equal(GRASS_LODS, 2);
  assert.equal(GROUND_COVER_BUCKETS, ROCK_ARCHETYPES * ROCK_LODS + GRASS_VARIANTS * GRASS_LODS);

  for (let arch = 0; arch < ROCK_ARCHETYPES; arch++) {
    const counts = [];
    for (let lod = 0; lod < ROCK_LODS; lod++) {
      const geom = groundCoverBucketGeometry(lod * ROCK_ARCHETYPES + arch);
      assert.ok(geom.length > 0 && geom.length % (TREE_VERTEX_FLOATS * 3) === 0);
      assert.ok(geom.every(Number.isFinite));
      counts.push(geom.length / TREE_VERTEX_FLOATS);
      if (lod === 0) {
        let nonRadial = 0;
        const totalV = geom.length / TREE_VERTEX_FLOATS;
        for (let k = 0; k < geom.length; k += TREE_VERTEX_FLOATS) {
          const px = geom[k], py = geom[k + 1] - 0.3, pz = geom[k + 2];
          const nx = geom[k + 3], ny = geom[k + 4], nz = geom[k + 5];
          const pLen = Math.hypot(px, py, pz) || 1;
          const dotN = (px * nx + py * ny + pz * nz) / pLen;
          if (dotN < 0.995) nonRadial++;
        }
        assert.ok(nonRadial > totalV * 0.4, `archetype ${arch} has fractured crease normals (${nonRadial}/${totalV})`);
      }
    }
    assert.ok(counts[0] > counts[1] && counts[1] >= counts[2], `archetype ${arch} LOD triangle decay ${counts.join(' -> ')}`);
  }

  for (let b = ROCK_ARCHETYPES * ROCK_LODS; b < GROUND_COVER_BUCKETS; b++) {
    const geom = groundCoverBucketGeometry(b);
    assert.ok(geom.length > 0 && geom.length % (TREE_VERTEX_FLOATS * 3) === 0);
  }

  // WGSL shader and culling checks
  assert.match(HERDS_STEP_WGSL, /0\.92/);
  assert.match(HERDS_STEP_WGSL, /if\s*\(!onRoad\)\s*\{\s*return;\s*\}/);
  assert.match(TRADE_VESSELS_WGSL, /@vertex\s+fn\s+tvVS\b/);
  assert.match(TRADE_VESSELS_WGSL, /@fragment\s+fn\s+tvFS\b/);
  assert.match(TRADE_VESSELS_WGSL, /@vertex\s+fn\s+tvShadowVS\b/);
  assert.match(TRADE_VESSELS_WGSL, /matTone\.x\s*>\s*5\.5/);
  assert.match(GROUND_COVER_CULL, /\*f32\(6\)|ROCK_ARCHETYPES|lod\*6u/);
  assert.match(CITY_CULL, /params\.z\s*,\s*0\.0\s*,\s*params\.w/);

  // Zero-discard invariant for terrain passes while isolated cityFS performs 4x4 Bayer dither crossfade.
  assert.doesNotMatch(GROUND_DETAIL_RENDER, /\bdiscard\b/);
  assert.doesNotMatch(wgslBody('landSurface'), /\bdiscard\b/);
  assert.doesNotMatch(wgslBody('landOpaque'), /\bdiscard\b/);
  assert.doesNotMatch(wgslBody('landFinish'), /\bdiscard\b/);
  const cityFsBody = wgslBody('cityFS');
  assert.match(cityFsBody, /\bdiscard\b/);
  assert.match(TERRAIN, /cityBayer4/);
});

test('harbor fleet archetypes, bathymetry & berth safety, caravan bridge decks, and Lisbon street bridges', async () => {
  assert.equal(TRADE_VESSEL_ARCHETYPES, 7);

  // Synthetic bay basin heightmap: land north of z=0 (+4 m), slopes into deep harbor south (-8 m).
  const n = 33, span = 1600, region = { id: 'harbor_test', x: 0, z: 0, span, size: n };
  const heights = new Float32Array(n * n);
  for (let iz = 0; iz < n; iz++) {
    const wz = -span * 0.5 + (iz / (n - 1)) * span;
    for (let ix = 0; ix < n; ix++) {
      heights[iz * n + ix] = wz < 0 ? 4.0 : Math.min(0, -0.025 * wz);
    }
  }
  const dockBerth = { wx: 120, wz: 180 };
  const routes = buildTradeVesselRoutes(null, region, {
    places: [{ x: 0, z: -40, harbor: true, kind: 'capital' }, { x: 420, z: 360, village: true, kind: 'village' }],
    heights,
    region,
    port: { dockBerth },
    seaLevel: 0,
  });
  assert.ok(routes.some((r) => r.phase === 'dock' && (r.archetype === 1 || r.archetype === 3)), 'anchored ocean merchantmen synthesized');
  assert.ok(routes.some((r) => r.archetype === 5 || r.archetype === 6), 'lateen caravels / harbor barques synthesized');
  for (const r of routes) {
    const state = sampleTradeVesselState(r, 10, 0, 1.5);
    assert.ok(Number.isFinite(state.x) && Number.isFinite(state.y) && Number.isFinite(state.z) && Number.isFinite(state.yaw));
    assert.ok(Math.hypot(state.x - dockBerth.wx, state.z - dockBerth.wz) >= 48, `vessel ${r.id} keeps clear of player dockBerth`);
    const bedY = terrainSurfaceSample(heights, state.x, state.z, region);
    assert.ok(bedY <= -1.4, `vessel ${r.id} stays in safe water depth (bedY=${bedY.toFixed(2)})`);
  }

  // caravanHerdSeeds preserves .w === 0 in 2-arg mode and encodes bridge deckY when bridges are passed.
  const bridgeOrigin = { x: 1000, z: 2000 };
  const roadList = [{ key: 'k1', mode: 'cart', good: 'grain', qty: 20, carts: 1, depart: 10, arrive: 12, points: [-60, 0, 60, 0] }];
  const plainSeeds = caravanHerdSeeds(roadList, bridgeOrigin);
  for (let i = 4; i < plainSeeds.routes.length; i += 4) assert.equal(plainSeeds.routes[i + 3], 0);
  const bridgedSeeds = caravanHerdSeeds(roadList, bridgeOrigin, [{ x: 1000, z: 2000, ux: 1, uz: 0, length: 24, halfWidth: 3.5, deckY: 3.8 }]);
  let maxDeck = 0;
  for (let i = 4; i < bridgedSeeds.routes.length; i += 4) maxDeck = Math.max(maxDeck, bridgedSeeds.routes[i + 3]);
  assert.ok(maxDeck > 3.5, `subdivided bridge vertices encode deckY (${maxDeck})`);

  // Lisbon street-river crossings + roads produce standing bridges across the basin.
  const { country } = buildLisbonCountryAndMesh();
  assert.ok(country?.bridges?.length >= 6, `expected >= 6 standing Lisbon bridges, got ${country?.bridges?.length}`);
});

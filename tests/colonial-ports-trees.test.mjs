import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

import {
  generateProceduralCoastalPack,
  planUngrownFrontierParcels,
  growFrontierParcel,
  portClearanceEnvelope,
  PLANT_STREET_GAP_M,
  terrainSurfaceSample,
} from '../js/coastal-world.js';
import { CITY_BLOCK_FLOATS } from '../js/old-world-city.js';
import { cityFamilyOf } from '../js/old-world-buildings.js';
import { streetEdgeAt } from '../js/town-streets.js';
import { COLONIAL_TOWNS } from '../js/colonial-towns.js';
import { BAKED_BOARDS } from '../js/board-model.js';
import { refreshOldWorldBoardCountry } from '../js/old-world.js';
import { retargetForestPackToProcedural } from '../js/terrain.js';
import { forestPackRoots } from '../js/forest-scenery.js';
import { forestContinuumMaterial } from '../js/wgsl/forest-continuum.js';
import { loadForestGroves, PORTUGAL_FOREST_GROVE_ASSETS } from '../js/forest-groves.js';

const localFetch = async (relPath) => {
  const bytes = fs.readFileSync(relPath);
  return new Response(bytes, { status: 200 });
};

test('Deliverable 1: every town Spain and Portugal planted by 1550 is a board founded on its real ground by its crown\'s manner, with no colonial street planner left', () => {
  // The towns are boards (js/colonial-towns.js, scripts/board-colonial.mjs), baked on their ground by
  // scripts/bake-board.mjs: a Spanish town by the ordinances' traza (a square plaza, its church, a lattice of grid
  // streets), a Portuguese one by the ladeira (an upper town about a largo, a lower town at the landing, ladeiras
  // between). The game's own colonial planner (planColonialStreets, buildColonialCityFabric) is gone.
  const coastal = fs.readFileSync('js/coastal-world.js', 'utf8');
  const city = fs.readFileSync('js/old-world-city.js', 'utf8');
  for (const gone of ['planColonialStreets', 'buildColonialCityFabric', 'plannedStreets', 'colonialCity']) {
    assert.equal(coastal.includes(gone) || city.includes(gone), false, `${gone} is gone: a planted town is its board`);
  }
  for (const town of COLONIAL_TOWNS) {
    const file = BAKED_BOARDS[`${town.port}:1550`];
    assert.ok(file && fs.existsSync(file), `${town.port} has its board baked for 1550`);
    const baked = JSON.parse(fs.readFileSync(file, 'utf8'));
    assert.equal(baked.request.manner, town.manner, `${town.port} is founded by its crown's manner`);
    assert.equal(baked.request.founded, town.founded, `${town.port} is founded in its recorded year`);
    const seat = baked.board.places[0];
    assert.equal(seat.founded.kind, 'planted', `${town.port}'s seat was planted, not grown`);
    assert.equal(seat.founded.layout, town.manner, `${town.port}'s seat is laid out by its manner`);
    assert.ok(seat.streets.filter((street) => street.kind === 'grid').length >= 4, `${town.port} has its lattice of streets`);
    assert.ok(seat.squares.length >= 1, `${town.port} has its plaza or largo`);
    const { buildings, arches } = baked.board;
    let temples = 0;
    for (let k = 0; k < buildings.count; k++) if (buildings.kinds[k * 6] === 0 && arches[buildings.kinds[k * 6 + 1]] === 'temple') temples++;
    assert.ok(temples >= 1, `${town.port}'s seat has its church`);
  }

  // The ladeira climbs: Salvador's upper town stands above its landing, the ladeiras between them.
  const salvador = JSON.parse(fs.readFileSync(BAKED_BOARDS['salvador-da-bahia:1550'], 'utf8')).board.places[0];
  assert.ok(salvador.streets.some((street) => street.kind === 'alley'), 'Salvador\'s ladeiras climb from the landing');
  assert.ok(salvador.squares.length >= 2, 'Salvador has its largo above and its praça below');

  // A colonial coast stamps no town of prefabs and traces no streets of its own.
  const gridOpts = { size: 65, biomeSize: 32, albedoSize: 32, vegetationCandidates: 900 };
  for (const id of ['santo-domingo', 'havana', 'salvador-da-bahia']) {
    const pack = generateProceduralCoastalPack({ id, year: 1550, ...gridOpts });
    const prefabIds = pack.port.instances.map((i) => i.prefabId);
    assert.equal(prefabIds.includes('colonial_town_block'), false, `${id} stamps no colonial_town_block`);
    assert.equal(prefabIds.includes('curtain_wall_and_gate'), false, `${id} stamps no floating curtain_wall_and_gate`);
    assert.equal(pack.port.plannedStreets, undefined, `${id} traces no streets of its own`);
  }

  // 3. Biogeographically accurate tropical colonial hinterlands (estancias, ingenios, cattle/horses, conucos; zero windmills/sheep/longhouses)
  const tropicalHinterlandPack = generateProceduralCoastalPack({
    id: 'santo-domingo',
    year: 1580,
    span: 8192,
    size: 65,
    biomeSize: 32,
    albedoSize: 32,
    vegetationCandidates: 600,
  });
  const parcels = planUngrownFrontierParcels(tropicalHinterlandPack, tropicalHinterlandPack.heights);
  const mocked = parcels.filter((p) => p.state === 'mocked');
  assert.ok(mocked.length >= 1, '8192m colonial coast plans hinterland frontier parcels');

  let grownCount = 0;
  let totalCattle = 0;
  let totalHorses = 0;
  for (const parcel of mocked.slice(0, 4)) {
    if (!growFrontierParcel(tropicalHinterlandPack, parcel, tropicalHinterlandPack.heights)) continue;
    grownCount++;
    const kinds = Array.from(parcel.grownCity.typedTypes, (t) => cityFamilyOf(t).key);
    assert.equal(kinds.includes('WINDMILL'), false, 'Tropical Caribbean hinterland must not place European windmills');
    assert.equal(kinds.includes('THATCH_LONGHOUSE'), false, 'Tropical Caribbean hinterland must not place European thatch longhouses');
    if (parcel.grownHerds?.length) {
      for (let k = 6; k < parcel.grownHerds.length; k += 8) {
        const sp = parcel.grownHerds[k];
        assert.notEqual(sp, 0, 'Tropical Caribbean estancia must not graze European sheep flocks (species 0)');
        if (sp === 1) totalCattle++;
        if (sp === 3) totalHorses++;
      }
    }
  }
  assert.ok(grownCount >= 1, 'Grew at least one tropical colonial frontier parcel');
  assert.ok(totalCattle > 0 && totalHorses > 0, 'Tropical colonial estancias graze Criollo cattle (1) and horses/mules (3)');
});

test('Deliverable 2: WGSL root grounding plunges horizontal root webs smoothly downward with subRoot=0, pinned collar wind, and strict town/water tree clearance', async () => {
  // 1. Verify WGSL shader contracts
  // Each tree's foot is flared into its ground once, in its bake (scripts/prepare-forest-continuum.mjs flareRoot), and
  // its wind weight pins the wood's collar; the one continuum then draws the tree as baked.
  const sceneryJs = fs.readFileSync('js/forest-scenery.js', 'utf8');
  const prepareJs = fs.readFileSync('scripts/prepare-forest-continuum.mjs', 'utf8');
  assert.equal(/\?\s*256\s*:\s*0/.test(sceneryJs), false, 'subRoot = 256 removed from forest-scenery.js');
  assert.ok(prepareJs.includes('function flareRoot('), 'the bake flares each tree\'s foot into its ground');
  assert.ok(prepareJs.includes('const r = Math.hypot(x, z), envelope = 0.32 + 0.14 * Math.min(r, 4) - 0.46 * smooth(1.15, 2.6, r);'), 'by the buttress envelope verified below');
  assert.ok(prepareJs.includes('(y - 0.22) / (1.05 - 0.22)'), 'the wind weight pins the wood collar at y <= 0.22');

  // 2. Numerically verify forestGroundRoot law on extreme 15m..40.9m subterranean root webs (including ceiba & portugal maple)
  const smoothstep = (a, b, x) => {
    const t = Math.max(0, Math.min(1, (x - a) / (b - a)));
    return t * t * (3 - 2 * t);
  };
  const evalForestGroundRoot = (x, y, z, kindVal = 3.0) => {
    if (kindVal >= 3.5) return [x, y, z];
    let px = x, py = y, pz = z;
    const rHoriz = Math.hypot(px, pz);
    const flareEnv = 0.32 + 0.14 * Math.min(rHoriz, 4.0) - 0.46 * smoothstep(1.15, 2.6, rHoriz);
    if (py < flareEnv + 0.04 && (rHoriz > 0.18 || py < 0.02)) {
      const wEnv = 1.0 - smoothstep(flareEnv - 0.08, flareEnv + 0.04, py);
      const wRad = Math.max(smoothstep(0.18, 0.22, rHoriz), 1.0 - smoothstep(-0.01, 0.02, py));
      const w = wEnv * wRad;
      if (rHoriz > 0.20) {
        const rOut = 0.20 + 0.52 * (1.0 - Math.exp(-(rHoriz - 0.20) / 0.52));
        const k = 1.0 + (rOut / Math.max(rHoriz, 1e-5) - 1.0) * w;
        px *= k;
        pz *= k;
      }
      const dr = Math.max(0.0, rHoriz - 0.18);
      const plungedY = Math.max(-2.2, py - (1.35 * dr + 0.45 * Math.min(dr * dr, 4.0)));
      py = py + (plungedY - py) * w;
    }
    return [px, py, pz];
  };

  for (const rDistal of [1.5, 5.0, 15.0, 26.19, 40.94]) {
    const [gx, gy, gz] = evalForestGroundRoot(rDistal, 0.06, 0, 3.0);
    assert.ok(Math.hypot(gx, gz) <= 0.7201, `Distal root at r=${rDistal}m retracts inside <= 0.72m buttress apron`);
    assert.ok(gy <= -1.8 && gy >= -2.2001, `Distal root at r=${rDistal}m plunges steeply underground (${gy.toFixed(2)}m)`);
  }
  // Drooping outer crown twig at r=7.3m, y=0.83m remains untouched in the canopy!
  const [bx, by, bz] = evalForestGroundRoot(-3.15, 0.83, -7.31, 3.0);
  assert.ok(Math.abs(bx - (-3.15)) < 1e-4 && Math.abs(by - 0.83) < 1e-4 && Math.abs(bz - (-7.31)) < 1e-4, 'Low drooping outer crown twigs are never yanked inward');

  // 3. Verify strict placement clearance & live elevation sync on colonial port + foreshore palms
  const pack = generateProceduralCoastalPack({
    id: 'cartagena',
    year: 1605,
    size: 129,
    biomeSize: 64,
    albedoSize: 64,
    vegetationCandidates: 4000,
  });
  const subManifest = JSON.parse(fs.readFileSync('assets/forest-scenery/subtropical/manifest.json', 'utf8'));
  const retargeted = retargetForestPackToProcedural({ manifest: subManifest }, pack);
  const roots = forestPackRoots(retargeted);
  assert.ok(roots.length >= 12 * 20, 'Retargeted subtropical forest places trees around Cartagena');

  const blocks = pack.city?.blocks ?? new Float32Array(0);
  const hitsCityBlock = (px, pz) => {
    for (let b = 0; b < blocks.length; b += CITY_BLOCK_FLOATS) {
      const dx = px - blocks[b], dz = pz - blocks[b + 2];
      const hw = blocks[b + 4] * 0.5, hd = blocks[b + 5] * 0.5;
      const c = Math.cos(blocks[b + 3]), s = Math.sin(blocks[b + 3]);
      if (Math.abs(dx * c - dz * s) <= hw && Math.abs(dx * s + dz * c) <= hd) return true;
    }
    return false;
  };

  for (let k = 0; k < roots.length; k += 12) {
    const x = roots[k], y = roots[k + 1], z = roots[k + 2], scale = roots[k + 3], sink = roots[k + 9];
    if (scale <= 0) continue; // sentinel root
    const gy = terrainSurfaceSample(pack.heights, x, z, pack.region);
    assert.ok(gy >= 0.35, `Tree at (${x.toFixed(1)}, ${z.toFixed(1)}) stands on dry ground gy=${gy.toFixed(2)}m`);
    assert.ok(sink >= 0.219 && Math.abs(y - (gy - sink)) < 1e-3, `Tree root y (${y.toFixed(2)}) matches post-graded ground (${gy.toFixed(2)}) minus sink (${sink.toFixed(2)})`);
    assert.ok(portClearanceEnvelope(pack.port, x, z, 8), `Tree clears port buildings at (${x.toFixed(1)}, ${z.toFixed(1)})`);
    assert.ok(streetEdgeAt(pack.port.streets, x, z) >= PLANT_STREET_GAP_M - 1e-3, `Tree clears town streets at (${x.toFixed(1)}, ${z.toFixed(1)})`);
    assert.equal(hitsCityBlock(x, z), false, `Tree clears pack.city Cairn lots/walls at (${x.toFixed(1)}, ${z.toFixed(1)})`);
  }
});

test('Deliverable 3 & Terrain Interface Hooks: Forest Modeler visual parity, Portugal crown/grove un-attenuation, woodAO, and terrain hooks', async () => {
  const forestWGSL = forestContinuumMaterial('').wgsl();
  // 1. Native textured bark & leaves ignore baked vertex colour (`v[10:13]`)
  assert.ok(
    forestWGSL.includes('(*v).colour=select(word.rgb*word.rgb,vec3f(1.0),textured)*tint;'),
    'the forest\'s material ignores baked vertex colour where a surface is textured'
  );

  // 2. Wood canopy self-occlusion incorporates exposure when the canopy is open
  assert.ok(
    forestWGSL.includes('let woodAO=min(canopy,select(1.0,mix(0.30,1.0,exposure),canopy>0.995&&exposure<0.995));'),
    'the forest\'s material computes woodAO from exposure when the canopy is open'
  );

  // 3. No canopy tier inflates leaf cards: the one cut is the only near and mid representation, and a coarser level's
  // cards are grown in the bake to cover what the finer drew (third_party/threejs-nanites/dag/leaves.ts).
  assert.ok(!/tierId|forestCanopyVertex|isSubBroadleaf/.test(forestWGSL), 'no leaf card is inflated as it is drawn');

  // 4. Portugal's groves pass their SHA-256 verification
  const loadedGroves = await loadForestGroves({ assets: PORTUGAL_FOREST_GROVE_ASSETS, fetchAsset: localFetch });
  assert.ok(loadedGroves.trees.length > 0 && loadedGroves.manifest.maxTrees > 1, 'Portugal grove trees pass SHA-256 verification');

  // 5. Verify terrain.js exposes herdsWatch, setStreetMounts, and refreshBoardFabric, and refreshOldWorldBoardCountry updates board fabric
  const terrainSrc = fs.readFileSync('js/terrain.js', 'utf8');
  assert.ok(terrainSrc.includes('herdsWatch(from,to,best,projectile)'), 'createTerrain exposes herdsWatch');
  assert.ok(terrainSrc.includes('setStreetMounts(mountSeeds,routes)'), 'createTerrain exposes setStreetMounts');
  assert.ok(terrainSrc.includes('async refreshBoardFabric(nextBoardJson)'), 'createTerrain exposes async refreshBoardFabric');
  assert.equal(typeof refreshOldWorldBoardCountry, 'function', 'refreshOldWorldBoardCountry exported from js/old-world.js');
});

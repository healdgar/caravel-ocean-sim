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
import { CITY_TYPE } from '../js/old-world-buildings.js';
import { streetEdgeAt } from '../js/town-streets.js';
import { createCityTargets } from '../js/city-targets.js';
import { refreshOldWorldBoardCountry } from '../js/old-world.js';
import { retargetForestPackToProcedural } from '../js/terrain.js';
import { FOREST_VERTEX_WGSL } from '../js/forest-scenery.js';
import { FOREST_CLUSTER_VERTEX_WGSL } from '../js/forest-clusters.js';
import { FOREST_WIND_SKIN_WGSL } from '../js/forest-wind.js';
import { loadForestCrowns, PORTUGAL_FOREST_CROWN_ASSETS } from '../js/forest-crowns.js';
import { loadForestGroves, PORTUGAL_FOREST_GROVE_ASSETS } from '../js/forest-groves.js';

const localFetch = async (relPath) => {
  const bytes = fs.readFileSync(relPath);
  return new Response(bytes, { status: 200 });
};

test('Deliverable 1: procedural colonial ports generate distinct topography-adapted street plans, subdivided solares, bastioned wall circuits, and tropical hinterlands', () => {
  const gridOpts = { size: 65, biomeSize: 32, albedoSize: 32, vegetationCandidates: 900 };

  const santoDomingo = generateProceduralCoastalPack({ id: 'santo-domingo', year: 1550, ...gridOpts });
  const havana = generateProceduralCoastalPack({ id: 'havana', year: 1615, ...gridOpts });
  const salvador = generateProceduralCoastalPack({
    id: 'salvador-da-bahia',
    name: 'Salvador da Bahia',
    latitude: -12.9714,
    longitude: -38.5014,
    year: 1585,
    ...gridOpts,
  });
  const jamestown = generateProceduralCoastalPack({ id: 'jamestown', year: 1615, ...gridOpts });

  // 1. Zero monolithic colonial_town_block stamps and zero isolated floating single-segment walls
  for (const pack of [santoDomingo, havana, salvador, jamestown]) {
    const prefabIds = pack.port.instances.map((i) => i.prefabId);
    assert.equal(
      prefabIds.includes('colonial_town_block'),
      false,
      `${pack.region.id} must not stamp monolithic colonial_town_block`
    );
    assert.equal(
      prefabIds.includes('curtain_wall_and_gate'),
      false,
      `${pack.region.id} must not stamp an isolated floating curtain_wall_and_gate prefab`
    );
    assert.ok(pack.city && pack.city.typedCount > 0, `${pack.region.id} emits subdivided Cairn lots in pack.city`);
    const baseCity = pack._baseCity ?? pack.city;
    assert.ok(baseCity.count >= baseCity.typedCount, `${pack.region.id} pairs colonial Cairn lots with GPU CITY_BLOCK_FLOATS continuum blocks`);
    assert.ok(Array.isArray(pack.port.plannedStreets) && pack.port.plannedStreets.length >= 2, `${pack.region.id} traces procedural streets`);

    // Every port building & subdivided city lot/wall is physically targetable
    const targets = createCityTargets(pack.city, pack.port);
    assert.ok(targets, `${pack.region.id} enrols subdivided lots & walls into cityTargets`);
  }

  // 2. Distinct street geometry across Spanish traza (Santo Domingo vs Havana), Portuguese Cidade Baixa/Alta (Salvador), and Tidewater (Jamestown)
  const streetSignature = (pack) => {
    const ways = pack.port.plannedStreets;
    const pts = ways.flatMap((w) => w.points);
    const meanElev = pts.reduce((acc, [x, z]) => acc + terrainSurfaceSample(pack.heights, x, z, pack.region), 0) / Math.max(1, pts.length);
    return `${ways.length}:${pts.length}:${meanElev.toFixed(2)}`;
  };
  const sigSD = streetSignature(santoDomingo);
  const sigHV = streetSignature(havana);
  const sigSV = streetSignature(salvador);
  const sigJT = streetSignature(jamestown);
  assert.notEqual(sigSD, sigHV, 'Santo Domingo and Havana produce distinct street graphs from their local topography and stage');
  assert.notEqual(sigSD, sigSV, 'Spanish damero traza and Portuguese Cidade Baixa/Alta produce distinct street graphs');
  assert.notEqual(sigSD, sigJT, 'Spanish Indies and English Tidewater produce distinct street graphs');

  // Mounted street riders emitted for colonial towns
  assert.ok(havana.port.streets?.mounts?.seeds?.length >= 8, 'Havana streets emit mounted horseman seeds');
  assert.equal(havana.port.streets.mounts.seeds[6], 3, 'Mounted street riders use horse species = 3');

  // Fortified Havana (1615) encloses the landward traza with a multi-bay bastioned curtain + tower + gate circuit
  const havanaTypes = Array.from(havana.city.typedTypes);
  const curtainBays = havanaTypes.filter((t) => t === CITY_TYPE.CURTAIN_LONG || t === CITY_TYPE.CURTAIN_SHORT).length;
  const wallTowers = havanaTypes.filter((t) => t === CITY_TYPE.WALL_TOWER).length;
  assert.ok(curtainBays >= 4, `Expected continuous multi-bay landward wall circuit on fortified Havana, got ${curtainBays} bays`);
  assert.ok(wallTowers >= 3, `Expected projecting bastion/flanking towers on fortified Havana wall trace, got ${wallTowers}`);

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
    const types = Array.from(parcel.grownCity.typedTypes);
    assert.equal(types.includes(CITY_TYPE.WINDMILL), false, 'Tropical Caribbean hinterland must not place European windmills');
    assert.equal(types.includes(CITY_TYPE.THATCH_LONGHOUSE), false, 'Tropical Caribbean hinterland must not place European thatch longhouses');
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
  const sceneryJs = fs.readFileSync('js/forest-scenery.js', 'utf8');
  const clustersJs = fs.readFileSync('js/forest-clusters.js', 'utf8');
  assert.equal(/\?\s*256\s*:\s*0/.test(sceneryJs), false, 'subRoot = 256 removed from forest-scenery.js');
  assert.equal(/\?\s*256\s*:\s*0/.test(clustersJs), false, 'subRoot = 256 removed from forest-clusters.js');
  assert.equal(FOREST_VERTEX_WGSL.includes('select(posLocal,vec3f(0.),buried)'), false, 'Broken per-vertex vec3f(0.) root spear snap removed from forestPlaceSkinned');
  assert.equal(FOREST_CLUSTER_VERTEX_WGSL.includes('if(buried){position=vec3f(0.);}'), false, 'Broken per-vertex vec3f(0.) root spear snap removed from forestClusterVertex');
  assert.ok(FOREST_VERTEX_WGSL.includes('fn forestGroundRoot('), 'forestGroundRoot defined in FOREST_VERTEX_WGSL');
  assert.ok(FOREST_VERTEX_WGSL.includes('if(!fallen&&kind.x>=3.5){o.world.y=max(o.world.y,r.rootScale.y);}'), 'Upward rootScale.y clamp restricted strictly to leaves (kind.x >= 3.5)');
  assert.ok(FOREST_WIND_SKIN_WGSL.includes('smoothstep(0.22,1.05,posProto.y)'), 'Cluster wind skinning pins wood collar at y <= 0.22');
  assert.ok(FOREST_VERTEX_WGSL.includes('smoothstep(0.22,1.05,model.y)'), 'Analytical forestWind pins wood collar at y <= 0.22');

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
  const roots = retargeted.roots;
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
  // 1. Native textured bark & leaves ignore baked vertex colour (`v[10:13]`)
  assert.ok(
    FOREST_VERTEX_WGSL.includes('let baseCol=select(colour,vec3f(1.),nativeMaterial>=0.);'),
    'forestPlaceSkinned ignores baked vertex colour when nativeMaterial >= 0'
  );

  // 2. Wood canopy self-occlusion incorporates kind.y exposure when canopyAO == 1
  assert.ok(
    FOREST_VERTEX_WGSL.includes('let woodAO=min(in.canopyAO,select(1.0,mix(0.30,1.0,exposure),in.canopyAO>0.995&&exposure<0.995));'),
    'forestNativeOpaqueFS computes woodAO from kind.y exposure when canopyAO == 1'
  );

  // 3. Reduced mid-range isSubBroadleaf leaf-card inflation (0.18 / 0.22)
  assert.ok(
    FOREST_CLUSTER_VERTEX_WGSL.includes('select(.16,.18,isSubBroadleaf)'),
    'forestClusterVertex reduces isSubBroadleaf mid-range inflation from 0.48 to 0.18'
  );
  assert.ok(
    FOREST_VERTEX_WGSL.includes('select(select(.03,.18,tierId==3u),select(.08,.22,tierId==3u),isSubBroadleaf)'),
    'forestCanopyVertex reduces isSubBroadleaf mid-range inflation from 0.80 to 0.22'
  );

  // 4. Portugal prebaked crowns & groves un-attenuate arch.colour after SHA-256 verification
  const rawCrownManifest = JSON.parse(fs.readFileSync(PORTUGAL_FOREST_CROWN_ASSETS['manifest.json'], 'utf8'));
  const rawOakGreen = rawCrownManifest.prototypes[0].splat.colour[1];
  const loadedCrowns = await loadForestCrowns({ assets: PORTUGAL_FOREST_CROWN_ASSETS, fetchAsset: localFetch });
  const unattenuatedOakGreen = loadedCrowns.manifest.prototypes[0].splat.colour[1];
  assert.ok(rawOakGreen < 0.05 && unattenuatedOakGreen > 0.095, `Portugal oak splat green un-attenuated from ${rawOakGreen.toFixed(4)} to ${unattenuatedOakGreen.toFixed(4)}`);

  const loadedGroves = await loadForestGroves({ assets: PORTUGAL_FOREST_GROVE_ASSETS, fetchAsset: localFetch });
  assert.ok(loadedGroves.maps.length > 0 && loadedGroves.trees.length > 0, 'Portugal groves pass SHA-256 verification and un-attenuate cleanly');

  // 5. Verify terrain.js exposes herdsWatch, setStreetMounts, and refreshBoardFabric, and refreshOldWorldBoardCountry updates board fabric
  const terrainSrc = fs.readFileSync('js/terrain.js', 'utf8');
  assert.ok(terrainSrc.includes('herdsWatch(from,to,best,projectile)'), 'createTerrain exposes herdsWatch');
  assert.ok(terrainSrc.includes('setStreetMounts(mountSeeds,routes)'), 'createTerrain exposes setStreetMounts');
  assert.ok(terrainSrc.includes('async refreshBoardFabric(nextBoardJson)'), 'createTerrain exposes async refreshBoardFabric');
  assert.equal(typeof refreshOldWorldBoardCountry, 'function', 'refreshOldWorldBoardCountry exported from js/old-world.js');
});

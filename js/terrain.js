import { ISLAND, decodeIsland, decodeBiome, terrainSample, terrainSurfaceSample, constrainIslandMotion, safeLandfallStart, SPANISH_MAIN_1550_REGIONS, HISTORICAL_COLONIAL_PORTS, resolveColonialEra, generateProceduralCoastalPack, upgradeProceduralPackWithRealDEM } from './terrain-model.js';
import { GROUND_COVER, createGroundCoverPatches, groundCoverInstances } from './vegetation.js';
import { TERRAIN_FINISH_ONLY, TERRAIN_LAND, TERRAIN_CITY, TERRAIN_LIGHT, COASTAL_FIELD_BAKE } from './wgsl/terrain.js';
import { GROUND_DETAIL_BAKE } from './wgsl/ground-detail.js';
import { createCoastalField } from './coastal-field.js';
import { coastalClarity, coastalTurbidityScale } from './sea-colour.js';
import {loadTerrainNear,terrainNearSample,terrainNearPatchBounds,sampleTerrainNear} from './terrain-near.js';
import {chooseForestSurfaceCodec} from './forest-surfaces.js';
import {loadForestScenery,createForestRenderer,forestRootCapacity,FOREST_ASSETS,SUBTROPICAL_FOREST_ASSETS,PORTUGAL_FOREST_ASSETS} from './forest-scenery.js';
import {loadForestGroves,forestGroveCover,forestGroveOccupy,forestGroveTrees,forestGroveStamp,PORTUGAL_FOREST_GROVE_ASSETS,SUBTROPICAL_FOREST_GROVE_ASSETS} from './forest-groves.js';
import {foreshorePalmPlacement} from './forest-trunks.js';
import {createPortFractures} from './building-fracture.js';
import {bridgeDeckYAt,bridgeSurfaceAt,layTownStreets,paveCityStreets,streetEdgeAt,waterfrontDeckYAt} from './town-streets.js';
import {layPortProps} from './port-props.js';
import {bakedBoardFor,oldWorldCountry,refreshOldWorldBoardCountry,registerBakedBoard,syncOldWorldHeights} from './old-world.js';
import {nativeOwnGroundFor} from './native-towns.js';
import {boardAsKept,keptBoard} from './board-keep.js';
import {bakedBoardAsset,resolveBakedBoardYear} from './board-model.js';
import {createBoardStamp,requestBoardStampPipelines} from './board-stamp.js';
import {createInlandWater,requestInlandWaterPipeline,createInlandWaterSampler} from './inland-water.js';
import {createLivestockHerds} from './herds.js';
import {createMeadowGrass,createSectionMeadowGrass} from './meadow-grass.js';
import {createTradeVessels,requestTradeVesselsPipelines} from './trade-vessels.js';
import {CITY_BLOCK_FLOATS} from './old-world-city.js';
import {CITY_TYPED_FLOATS,CITY_TYPES_WATERSIDE,compileCityBuildingType} from './old-world-buildings.js';
import {cityContinuumMaterial} from './wgsl/city-continuum.js';
import {requestCityContinuumAtlas,createCityContinuum} from './city-continuum-draw.js';
import {requestContinuumPrograms,requestContinuumView,requestContinuumCapture} from './continuum-scene.js';
import {CONTINUUM_CARD_TINT_CITY} from './wgsl/continuum-cards.js';
import {requestContinuumCardRenderer,createContinuumCardSceneBindings,bakeContinuumCardAtlas} from './continuum-cards.js';
import {createCityTargets} from './city-targets.js';
import {createLandCraterLedger,createLandCraters,requestLandCraterPipelines,landCraterSize,landCraterMark} from './land-craters.js';
import {createLandBanks} from './land-banks.js';
import {bakeLandContinuumPiece,landContinuumSeams,requestLandContinuumPipelines,createLandContinuum} from './land-continuum.js';
import {landContinuumMaterial} from './wgsl/land-continuum.js';
import {sharedGroundDetail} from './ground-detail.js';
import {sharedNeuralPbrBank} from './neural-pbr.js';
import {withNeuralPbrLand,withNeuralPbrCity} from './wgsl/neural-pbr.js';
import {createLandShadows} from './shadows.js';
import {createBoulderContinuum,requestBoulderContinuumAtlas} from './boulder-continuum.js';
import {BOULDER_CONTINUUM_MATERIAL_SPEC} from './wgsl/boulder-continuum.js';

import {
  buildCityTypeGeometry,
  portClearanceEnvelope,
  settlePortOnWaterfront,
  PLANT_STREET_GAP_M,
  runLandfallDiscoveryPipeline,
  completeProceduralCoastalPack,
  build1550HistoricalTerritoryPack,
  detectCoastalContinuationDirs,
  prepareSectionConnectedBorders,
  stitchCoastalSectionBorders,
  restitchCoastalSection,
  buildMockCoastalSection,
  generateCoastalNeighborSection,
  smoothCoastlineAndForeshoreBeaches,
  synthesizeCoastalBeaches,
  synthesizeCoastalBiome,
  synthesizeCoastalAlbedo,
  seedCoastalVegetation,
  buildCoastalMesh,
  classifyKoppenClimateFromNormals,
  estimateLocalClimateProfile,
  fetchPublicClimateProfile,
  coastalRegionId,
} from './coastal-world.js';

function hash32Forest(value) {
  let v = value >>> 0;
  v = Math.imul(v ^ (v >>> 16), 0x7feb352d) >>> 0;
  v = Math.imul(v ^ (v >>> 15), 0x846ca68b) >>> 0;
  return (v ^ (v >>> 16)) >>> 0;
}

const FORESHORE_PALMS_MAX = 520;
// Roots in each array a section is planted into: 12 MB of records.
const FOREST_ROOT_CHUNK = 262144;
const GROUND_COVER_STREET_GAP_M = 0.4;
const SPECIES_SHADE_TOLERANCE = Object.freeze({
  ceiba: 0.25,
  royal_palm: 0.42,
  palm: 0.22,
  mangrove: 0.38,
  oak: 0.45,
  chestnut: 0.55,
  elm: 0.62,
  maple: 0.82,
  birch: 0.20,
  blueberry: 0.92,
  fir: 0.78,
  larch: 0.18,
});
const SPECIES_VETERAN_AFFINITY = Object.freeze({
  ceiba: 1.45,
  royal_palm: 1.20,
  palm: 0.72,
  mangrove: 0.75,
  oak: 1.45,
  chestnut: 1.30,
  elm: 1.00,
  maple: 0.88,
  birch: 0.58,
  blueberry: 0.35,
  fir: 1.15,
  larch: 0.90,
});

export function retargetForestPackToProcedural(
  forestPack,
  proceduralPack,
  groundSample = (x, z) => terrainSurfaceSample(proceduralPack.heights, x, z, proceduralPack.region),
  { isMobile = false, extraSections = [], maxRootCapacity = null, climateProfile = null, stand = null, rootCapacity = Infinity, near = null, owner = null } = {}
) {
  const protoCount = forestPack.manifest.prototypes.length;
  const hasCohorts = forestPack.manifest.prototypes.some((p) => Boolean(p.cohort));
  // A pack whose manifest says its trees are full grown holds each at the size it stands
  // (scripts/bake-forest-mature-pack.py), and they are drawn at about that size and spaced by the crowns
  // they have. Any other pack holds young trees, enlarged below to stand for a wood's.
  const fullGrown = forestPack.manifest.stature === 'full-grown';
  const activeClimate =
    climateProfile ??
    proceduralPack.climateProfile ??
    estimateLocalClimateProfile(
      proceduralPack.region?.latitude ?? 17.63,
      proceduralPack.region?.longitude ?? -63.23,
      proceduralPack.region
    );
  const densityMul = Math.max(0.65, Math.min(1.38, activeClimate.canopyDensityMultiplier ?? 1.0));
  const effectiveMaxCapacity =
    maxRootCapacity ?? (extraSections.length > 0 ? (isMobile ? 24000 : 112000) : (isMobile ? 16000 : 64000));
  const reservedExtra =
    extraSections.length > 0
      ? Math.min(Math.round(effectiveMaxCapacity * 0.34), extraSections.length * (isMobile ? 2400 : 11000))
      : 0;
  const baseMaxRoots = Math.max(64, effectiveMaxCapacity - reservedExtra);

  // Build cumulative probability tables per habitat zone (coastal strand, lagoon/mangrove, upland forest)
  // and cohort (veteran emergent vs canopy/drip-line nurse matrix) matched against the loaded forestPack's species.
  const buildSpeciesCdf = (weightMap, affinityFn = null, targetCohort = null) => {
    const weights = forestPack.manifest.prototypes.map((p) => {
      if (hasCohorts && targetCohort) {
        if (targetCohort === 'veteran') {
          if (p.cohort !== 'veteran' || p.species === 'blueberry') return 0;
        } else if (targetCohort === 'canopy') {
          if (p.cohort !== 'canopy' && !(p.species === 'blueberry' && p.cohort === 'veteran')) return 0;
        }
      }
      const w = weightMap?.[p.species];
      const shrubTrim = fullGrown && p.species === 'blueberry' ? 0.25 : 1;
      const baseW = Number.isFinite(w) && w > 0 ? w * shrubTrim : 0;
      return affinityFn ? baseW * affinityFn(p.species) : baseW;
    });
    let total = weights.reduce((a, b) => a + b, 0);
    if (total <= 1e-6) {
      for (let i = 0; i < protoCount; i++) weights[i] = 1;
      total = protoCount;
    }
    const cdf = new Float32Array(protoCount);
    let acc = 0;
    for (let i = 0; i < protoCount; i++) {
      acc += weights[i] / total;
      cdf[i] = i === protoCount - 1 ? 1.0 : acc;
    }
    return cdf;
  };
  const vetMod = (sp) => SPECIES_VETERAN_AFFINITY[sp] ?? 1.0;
  const shadeMod = (sp) => (sp === 'blueberry' ? (fullGrown ? 0.45 : 1.85) : 0.72 + 0.56 * (SPECIES_SHADE_TOLERANCE[sp] ?? 0.45));
  const uplandCdf = buildSpeciesCdf(activeClimate.uplandForestWeights, null, 'canopy');
  const strandCdf = buildSpeciesCdf(activeClimate.coastalStrandWeights, null, 'canopy');
  const lagoonCdf = buildSpeciesCdf(activeClimate.lagoonMangroveWeights, null, 'canopy');
  const uplandVetCdf = buildSpeciesCdf(activeClimate.uplandForestWeights, vetMod, 'veteran');
  const strandVetCdf = buildSpeciesCdf(activeClimate.coastalStrandWeights, vetMod, 'veteran');
  const lagoonVetCdf = buildSpeciesCdf(activeClimate.lagoonMangroveWeights, vetMod, 'veteran');
  const uplandShadeCdf = buildSpeciesCdf(activeClimate.uplandForestWeights, shadeMod, 'canopy');
  const strandShadeCdf = buildSpeciesCdf(activeClimate.coastalStrandWeights, shadeMod, 'canopy');
  const lagoonShadeCdf = buildSpeciesCdf(activeClimate.lagoonMangroveWeights, shadeMod, 'canopy');
  const hasMangrove = forestPack.manifest.prototypes.some((p) => p.species === 'mangrove');
  const rootIdentityZ = hasCohorts ? -1.25 : -2;

  const pickProtoFromCdf = (cdf, u01) => {
    for (let i = 0; i < protoCount - 1; i++) {
      if (u01 < cdf[i]) return i;
    }
    return protoCount - 1;
  };

  // A section's roots are written straight into arrays of records a fixed number of roots long, each filled before
  // the next is made, and the last cut to what it holds. They are never joined: the forest holds each where it lies
  // (js/forest-scenery.js), so a section's planting takes no more than its roots and one array besides.
  const rootChunks = (chunkRoots = FOREST_ROOT_CHUNK) => {
    const chunks = [];
    let data = null, length = 0, count = 0;
    return {
      push(x, y, z, scale, yaw, r, g, b, kind, sink, identityZ, struck) {
        if (!data || length === data.length) {
          data = new Float32Array(chunkRoots * 12);
          chunks.push(data);
          length = 0;
        }
        data[length] = x; data[length + 1] = y; data[length + 2] = z; data[length + 3] = scale;
        data[length + 4] = yaw; data[length + 5] = r; data[length + 6] = g; data[length + 7] = b;
        data[length + 8] = kind; data[length + 9] = sink; data[length + 10] = identityZ; data[length + 11] = struck;
        length += 12;
        count++;
      },
      get count() { return count; },
      finish() {
        if (data && length < data.length) chunks[chunks.length - 1] = data.slice(0, length);
        data = null;
        return chunks;
      },
    };
  };
  const rootsIn = (parts) => (parts ?? []).reduce((sum, part) => sum + part.length / 12, 0);
  // A section's cached trees are this terrain's own: its forest strikes them where they lie, so another terrain
  // given the same section plants its own.
  const cachedFor = (cached, key) => (cached?.key === key && cached.owner === owner ? cached : null);

  const buildCityBlockTester = (cityObj, pad = 2.6) => {
    const bl = cityObj?.blocks;
    if (!bl?.length) return null;
    const cellM = 32;
    const grid = new Map();
    const keyOf = (i, j) => (i + 32768) * 65536 + (j + 32768);
    for (let b = 0; b < bl.length; b += CITY_BLOCK_FLOATS) {
      const bx = bl[b], bz = bl[b + 2], yaw = bl[b + 3];
      const hw = bl[b + 4] * 0.5 + pad, hd = bl[b + 5] * 0.5 + pad;
      const reach = Math.hypot(hw, hd);
      const entry = { bx, bz, c: Math.cos(yaw), s: Math.sin(yaw), hw, hd };
      for (let j = Math.floor((bz - reach) / cellM); j <= Math.floor((bz + reach) / cellM); j++) {
        for (let i = Math.floor((bx - reach) / cellM); i <= Math.floor((bx + reach) / cellM); i++) {
          const k = keyOf(i, j);
          let list = grid.get(k);
          if (!list) grid.set(k, list = []);
          list.push(entry);
        }
      }
    }
    return (px, pz) => {
      const list = grid.get(keyOf(Math.floor(px / cellM), Math.floor(pz / cellM)));
      if (!list) return false;
      for (let m = 0; m < list.length; m++) {
        const e = list[m], dx = px - e.bx, dz = pz - e.bz;
        if (Math.abs(dx * e.c - dz * e.s) <= e.hw && Math.abs(dx * e.s + dz * e.c) <= e.hd) return true;
      }
      return false;
    };
  };

  const heightFingerprint = (hArr) => {
    if (!hArr?.length) return '0';
    const len = hArr.length;
    const idxs = [0, len >> 3, len >> 2, (len * 3) >> 3, len >> 1, (len * 5) >> 3, (len * 3) >> 2, (len * 7) >> 3, len - 1];
    return idxs.map((idx) => Math.round((hArr[Math.min(len - 1, idx)] || 0) * 100)).join(',');
  };

  // The trees a section plants one by one, as one array of records in the order they were planted: the town's
  // and the farmer's, then the wood's giants and the canopy round them, as many as the budget allows.
  const plantSection = (secPack, secMaxRoots) => {
    const region = secPack.region;
    const span = region.span ?? 8192;
    const areaScale = span < 4096 ? Math.max(0.45, Math.min(1, Math.pow(span / 4096, 1.15))) : 1;
    const effectiveSecMaxRoots = Math.max(64, Math.round(secMaxRoots * areaScale));
    const cacheKey = `${activeClimate.koppenCode ?? activeClimate.climate}:${protoCount}:${effectiveSecMaxRoots}:${span}:${heightFingerprint(secPack.heights)}:${secPack.port?.waterfront?.length ?? 0}:${secPack.city?.count ?? 0}`;
    const cachedPlanted = cachedFor(secPack._cachedForestPlanted, cacheKey);
    if (cachedPlanted) return cachedPlanted.roots;

    const x0 = region.x - span * 0.5;
    const z0 = region.z - span * 0.5;
    const biome = secPack.biome;
    const maskSize = region.biomeSize ?? 256;
    const beaches = secPack.beaches;
    const port = secPack.port;
    const seed = (region.vegetationSeed ?? 47231) >>> 0;
    if (!(biome instanceof Uint8Array) || biome.length !== maskSize * maskSize) return new Float32Array(0);

    const portCx = port ? port.center.x : proceduralPack.region.x;
    const portCz = port ? port.center.z : proceduralPack.region.z;
    // Tended country: trees stand where a farmer set them, apart and kept small.
    const country = port?._resolvedCountry ?? oldWorldCountry(region, secPack.heights, port);
    const secWaterAt = createInlandWaterSampler(port?.country ?? country, { margin: 3.8 });
    const secCityBlocked = buildCityBlockTester(secPack.city ?? country?.plan, 2.6);
    const tendedKinds = new Map();
    const tendedPrototypes = (tended) => {
      let ids = tendedKinds.get(tended);
      if (!ids) {
        ids = [];
        forestPack.manifest.prototypes.forEach((p, id) => {
          if (tended.species.includes(p.species) && (!hasCohorts || p.cohort === tended.cohort)) ids.push(id);
        });
        tendedKinds.set(tended, ids);
      }
      return ids;
    };

    // Pre-index vegetated land cells and stratify into harbor-framing concentric bands
    // so that large 8192m coastal tiles concentrate dense forest stands on the visible
    // harbor hills (0–1,950 m) instead of losing 89% of the tree budget 2–5.5 km inland.
    let validLandCells = [];
    let nearLandCells = [];
    let midLandCells = [];
    let farLandCells = [];
    // Tended ground is planted first and from its own cells, or a few woods would take every tree.
    const tendedCells = { all: [], near: [], mid: [], far: [] };
    const drySand = beaches?.drySandMask;
    const swash = beaches?.swashMask;
    const cellSpanM = span / maskSize;
    const baseHalf = (proceduralPack.region.span ?? 8192) * 0.5;
    for (let idx = 0; idx < maskSize * maskSize; idx++) {
      const bVal = biome[idx];
      if (bVal < 42) continue;
      if ((drySand && drySand[idx] > 110) || (swash && swash[idx] > 64)) continue;
      const bi = idx % maskSize;
      const bj = (idx / maskSize) | 0;
      const cx = x0 + (bi + 0.5) * cellSpanM;
      const cz = z0 + (bj + 0.5) * cellSpanM;
      // A city fills the ground round its port; the framing bands start at its edge (or at the main section's
      // border for streamed neighbour tiles whose port lies outside them).
      const dPort =
        secPack !== proceduralPack && (!port || !(country?.town?.area > 0))
          ? Math.hypot(
              Math.max(0, Math.abs(cx - proceduralPack.region.x) - baseHalf),
              Math.max(0, Math.abs(cz - proceduralPack.region.z) - baseHalf)
            )
          : country?.town?.area > 0
            ? country.beyondTown(cx, cz)
            : Math.hypot(cx - portCx, cz - portCz);
      if (country && bVal < 108) {
        tendedCells.all.push(idx);
        (dPort <= 950 ? tendedCells.near : dPort <= 1950 ? tendedCells.mid : tendedCells.far).push(idx);
        continue;
      }
      validLandCells.push(idx);
      const targetPool = dPort <= 950 ? nearLandCells : dPort <= 1950 ? midLandCells : farLandCells;
      targetPool.push(idx);
      if (bVal >= 135) targetPool.push(idx);
    }

    const secRoots = new Float32Array(effectiveSecMaxRoots * 12);
    // Two trees stand no nearer than this share of the sum of their crown radii. Full-grown crowns are
    // twenty to thirty metres across, so their trunks stand six to ten metres apart and the crowns lock.
    const veteranSpacingFactor = fullGrown ? (isMobile ? 0.50 : 0.44) : hasCohorts ? (isMobile ? 0.52 : 0.42) : (isMobile ? 0.56 : 0.46);
    const canopySpacingFactor = fullGrown ? (isMobile ? 0.36 : 0.30) : hasCohorts ? (isMobile ? 0.28 : 0.21) : (isMobile ? 0.30 : 0.21);
    const vetCanopySpacingFactor = fullGrown ? (isMobile ? 0.40 : 0.34) : hasCohorts ? (isMobile ? 0.25 : 0.19) : (isMobile ? 0.27 : 0.19);
    const cellSize = 20;
    const hashW = Math.ceil(span / cellSize) + 1;
    const head = new Int32Array(hashW * hashW).fill(-1);
    const next = new Int32Array(effectiveSecMaxRoots);
    const rx = new Float32Array(effectiveSecMaxRoots);
    const rz = new Float32Array(effectiveSecMaxRoots);
    const rr = new Float32Array(effectiveSecMaxRoots);
    const rProto = new Uint8Array(effectiveSecMaxRoots);
    const rVet = new Uint8Array(effectiveSecMaxRoots);
    const rGap = new Float32Array(effectiveSecMaxRoots);
    let totalPlaced = 0;
    let consecutiveCollisions = 0;

    const isTrop =
      activeClimate.climate === 'tropical' ||
      activeClimate.climate === 'subtropical' ||
      region.climate === 'tropical' ||
      region.climate === 'subtropical';
    const borderMargin = 0.05;
    const secHeights = secPack.heights;
    const sampleSecGround = (wx, wz) => {
      if (secHeights && region?.size) {
        const half = span * 0.5 - 0.01;
        const cx = Math.max(region.x - half, Math.min(region.x + half, wx));
        const cz = Math.max(region.z - half, Math.min(region.z + half, wz));
        return terrainSurfaceSample(secHeights, cx, cz, region);
      }
      return groundSample(wx, wz);
    };

    const sampleBiomeByte = (wx, wz) => {
      const u = (wx - x0) / span;
      const v = (wz - z0) / span;
      if (u < 0.0 || u > 1.0 || v < 0.0 || v > 1.0) return 0;
      const uc = Math.max(0.001, Math.min(0.999, u));
      const vc = Math.max(0.001, Math.min(0.999, v));
      const bi = Math.min(maskSize - 1, Math.floor(uc * maskSize));
      const bj = Math.min(maskSize - 1, Math.floor(vc * maskSize));
      const idx = bj * maskSize + bi;
      if ((drySand && drySand[idx] > 110) || (swash && swash[idx] > 64)) return 0;
      return biome[idx];
    };

    const tryPlaceTree = (x, z, key, isSatellite = false, isVeteran = false, isDripLine = false, planted = false, explicitTended = null) => {
      if (totalPlaced >= effectiveSecMaxRoots) return -1;
      if (
        x <= x0 + borderMargin ||
        x >= x0 + span - borderMargin ||
        z <= z0 + borderMargin ||
        z >= z0 + span - borderMargin
      ) {
        return -1;
      }

      // A tree a town or board set out by hand stands where it was put, whatever the land cover says.
      const probByte = planted ? 255 : sampleBiomeByte(x, z);
      if (probByte < 42) return -1;
      if (probByte < 108 && (hash32Forest(key + 5) & 255) > probByte + 112) return -1;
      const tended = explicitTended ?? (country ? country.treesAt(x, z) : null);
      // No forest giants and no nurse rings among a farmer's trees.
      if (tended && (tended.none || isVeteran || isSatellite)) return -1;

      if (port && (port.clearRadius > 0 || port.waterfront?.length > 0)) {
        const envPad = port.hasIndigenousSettlement ? 8.5 : (tended ? 4.5 : 10);
        const clearEnv = !portClearanceEnvelope(port, x, z, envPad);
        // Never nuke board-designated gardens, olive groves, or planted town trees with the coarse radial disc;
        // portClearanceEnvelope, secCityBlocked, and streetEdgeAt already keep them off buildings, walls, and streets.
        const clearRad =
          !planted &&
          !tended &&
          !port.hasIndigenousSettlement &&
          port.clearRadius > 0 &&
          Math.hypot(x - port.center.x, z - port.center.z) < port.clearRadius * 0.38;
        if (clearEnv || clearRad) return -1;
        if (streetEdgeAt(port.streets, x, z) < (planted ? 1.2 : PLANT_STREET_GAP_M)) return -1;
      }
      if (secWaterAt?.(x, z) || secCityBlocked?.(x, z)) return -1;

      const gy = sampleSecGround(x, z);
      const minGy = hasMangrove ? 0.35 : 0.75;
      if (!Number.isFinite(gy) || gy < minGy || gy > 845) return -1;
      const sx = (sampleSecGround(x + 2, z) - sampleSecGround(x - 2, z)) * 0.25;
      const sz = (sampleSecGround(x, z + 2) - sampleSecGround(x, z - 2)) * 0.25;
      const slope = Math.hypot(sx, sz);
      if (!Number.isFinite(slope) || slope > 0.84 || (gy < 6 && slope > 0.48)) return -1;

      const isLagoonZone = hasMangrove && gy <= 2.35 && slope < 0.22;
      const isStrandZone = !isLagoonZone && gy <= 4.8 && slope <= 0.32;
      const zoneCdf = isLagoonZone
        ? isVeteran
          ? lagoonVetCdf
          : isDripLine
            ? lagoonShadeCdf
            : lagoonCdf
        : isStrandZone
          ? isVeteran
            ? strandVetCdf
            : isDripLine
              ? strandShadeCdf
              : strandCdf
          : isVeteran
            ? uplandVetCdf
            : isDripLine
              ? uplandShadeCdf
              : uplandCdf;

      const uSpecies = (hash32Forest(key + 1) & 0xffff) / 65536;
      let protoId = pickProtoFromCdf(zoneCdf, uSpecies);
      if (tended) {
        const kinds = tendedPrototypes(tended);
        if (kinds.length) protoId = kinds[(hash32Forest(key + 7) >>> 8) % kinds.length];
      }
      if (
        (gy > 115 || slope > 0.34) &&
        (forestPack.manifest.prototypes[protoId]?.species === 'palm' ||
          forestPack.manifest.prototypes[protoId]?.species === 'royal_palm')
      ) {
        const ceibaIdx = forestPack.manifest.prototypes.findIndex((p) => p.species === 'ceiba');
        if (ceibaIdx >= 0) protoId = ceibaIdx;
      }

      const gx = Math.max(0, Math.min(hashW - 1, Math.floor((x - x0) / cellSize)));
      const gz = Math.max(0, Math.min(hashW - 1, Math.floor((z - z0) / cellSize)));

      // Check spatial hash for spacing collisions and nearest-neighbor species mixing (forestmodeler tiered_forest)
      const distPort = Math.hypot(x - portCx, z - portCz);
      const inlandBlend = Math.max(0, Math.min(1, (distPort - 100) / 480));
      const uScale = hash32Forest(key + 2) / 4294967296;
      const computeScaleAndRadius = (pid) => {
        const pr = forestPack.manifest.prototypes[pid];
        let sMin;
        let sSpan;
        if (fullGrown) {
          // A full-grown tree stands at its own size: a tenth under to a fifth over, the larger inland.
          sMin = (isVeteran || pr.cohort === 'veteran' ? 0.94 : 0.88) + inlandBlend * 0.06;
          sSpan = 0.2;
        } else if (pr.species === 'blueberry') {
          sMin = 1.45 + inlandBlend * 0.40;
          sSpan = 0.52;
        } else if (isVeteran || pr.cohort === 'veteran') {
          sMin = (hasCohorts ? 1.95 : 1.42) + inlandBlend * (hasCohorts ? 0.55 : 0.44);
          sSpan = (hasCohorts ? 0.45 : 0.38) + inlandBlend * 0.24;
          if (pr.species === 'ceiba') {
            sMin = 1.98 + inlandBlend * 0.56;
            sSpan = 0.45 + inlandBlend * 0.28;
          } else if (pr.species === 'royal_palm' || pr.species === 'palm') {
            sMin = 1.16 + inlandBlend * 0.28;
            sSpan = 0.30;
          } else if (pr.species === 'mangrove') {
            sMin = 1.05 + inlandBlend * 0.22;
            sSpan = 0.26;
          }
        } else {
          sMin = (hasCohorts ? 1.55 : 1.18) + inlandBlend * (hasCohorts ? 0.45 : 0.36);
          sSpan = (hasCohorts ? 0.42 : 0.38) + inlandBlend * 0.22;
          if (pr.species === 'ceiba') {
            sMin = 1.62 + inlandBlend * 0.48;
            sSpan = 0.42 + inlandBlend * 0.24;
          } else if (pr.species === 'royal_palm' || pr.species === 'palm') {
            sMin = 0.98 + inlandBlend * 0.24;
            sSpan = 0.32;
          } else if (pr.species === 'mangrove') {
            sMin = 0.92 + inlandBlend * 0.20;
            sSpan = 0.28;
          }
        }
        const baseCrownR = pr.crownRadius ?? pr.crownRadiusMetres ?? 8.5;
        if (tended) {
          // A farmer's tree is kept to a height. Of a full-grown tree that is a share of its own height;
          // of a young one, the share the country names for it.
          const kept = fullGrown && tended.height && pr.heightMetres > 0
            ? (tended.height[0] + uScale * tended.height[1]) / pr.heightMetres
            : tended.scale[0] + uScale * tended.scale[1];
          return { scale: kept, crownR: baseCrownR * kept, proto: pr };
        }
        const sc = sMin + uScale * sSpan;
        const spacingScale = fullGrown ? sc : hasCohorts ? (isVeteran || pr.cohort === 'veteran' ? 1.32 : 1.15) : Math.min(sc, 1.35);
        return { scale: sc, crownR: baseCrownR * spacingScale, proto: pr };
      };

      let { scale, crownR, proto } = computeScaleAndRadius(protoId);
      let collision = false;
      let nearestDistSq = Infinity;
      let nearestProto = -1;
      const gap = tended ? tended.spacing : 0;
      for (let dz = -1; dz <= 1 && !collision; dz++) {
        const nz = gz + dz;
        if (nz < 0 || nz >= hashW) continue;
        for (let dx = -1; dx <= 1; dx++) {
          const nx = gx + dx;
          if (nx < 0 || nx >= hashW) continue;
          for (let idx = head[nz * hashW + nx]; idx !== -1; idx = next[idx]) {
            const ddx = x - rx[idx];
            const ddz = z - rz[idx];
            const dSq = ddx * ddx + ddz * ddz;
            const otherIsVet = rVet[idx] === 1;
            const spacingFactor =
              isVeteran && otherIsVet
                ? veteranSpacingFactor
                : isVeteran || otherIsVet
                  ? vetCanopySpacingFactor
                  : canopySpacingFactor;
            const minD = Math.max(spacingFactor * (crownR + rr[idx]), gap, rGap[idx]);
            if (dSq < minD * minD) {
              collision = true;
              break;
            }
            if (dSq < nearestDistSq) {
              nearestDistSq = dSq;
              nearestProto = rProto[idx];
            }
          }
          if (collision) break;
        }
      }
      if (collision) {
        if (!isSatellite) consecutiveCollisions++;
        return -1;
      }

      // Interspecies nearest-neighbor mixing: penalize conspecific adjacency so stands interleave species naturally
      if (
        !isVeteran &&
        !tended &&
        protoCount > 1 &&
        nearestProto === protoId &&
        nearestDistSq < (crownR * 2.4) * (crownR * 2.4) &&
        (hash32Forest(key + 6) & 255) < 158
      ) {
        const altProtoId = pickProtoFromCdf(zoneCdf, (uSpecies + 0.381966011) % 1.0);
        if (altProtoId !== protoId) {
          const alt = computeScaleAndRadius(altProtoId);
          // Re-verify if alt crown is wider
          let altOk = true;
          if (alt.crownR > crownR) {
            for (let dz = -1; dz <= 1 && altOk; dz++) {
              const nz = gz + dz;
              if (nz < 0 || nz >= hashW) continue;
              for (let dx = -1; dx <= 1; dx++) {
                const nx = gx + dx;
                if (nx < 0 || nx >= hashW) continue;
                for (let idx = head[nz * hashW + nx]; idx !== -1; idx = next[idx]) {
                  const ddx = x - rx[idx];
                  const ddz = z - rz[idx];
                  const otherIsVet = rVet[idx] === 1;
                  const spacingFactor = otherIsVet ? vetCanopySpacingFactor : canopySpacingFactor;
                  const minD = spacingFactor * (alt.crownR + rr[idx]);
                  if (ddx * ddx + ddz * ddz < minD * minD) {
                    altOk = false;
                    break;
                  }
                }
                if (!altOk) break;
              }
            }
          }
          if (altOk) {
            protoId = altProtoId;
            scale = alt.scale;
            crownR = alt.crownR;
            proto = alt.proto;
          }
        }
      }

      const rimMinGy = proto.species === 'mangrove' ? 0.08 : 0.45;
      const rimCheckR = Math.min(4.5, crownR * 0.20);
      if (
        sampleSecGround(x + rimCheckR, z) < rimMinGy ||
        sampleSecGround(x - rimCheckR, z) < rimMinGy ||
        sampleSecGround(x, z + rimCheckR) < rimMinGy ||
        sampleSecGround(x, z - rimCheckR) < rimMinGy
      ) {
        return -1;
      }

      consecutiveCollisions = 0;
      const placedIdx = totalPlaced;
      const cell = gz * hashW + gx;
      rx[placedIdx] = x;
      rz[placedIdx] = z;
      rr[placedIdx] = crownR;
      rProto[placedIdx] = protoId;
      rVet[placedIdx] = isVeteran ? 1 : 0;
      rGap[placedIdx] = gap;
      next[placedIdx] = head[cell];
      head[cell] = placedIdx;
      totalPlaced++;

      const basal = proto.basalRadius ?? 1.2;
      const sink = Math.min(1.6, 0.22 + 0.68 * basal * scale * slope);
      const yaw = (hash32Forest(key + 3) / 4294967296) * Math.PI * 2;
      const tint = 0.92 + (hash32Forest(key + 4) / 4294967296) * 0.16;
      const climateTint = activeClimate.foliageTint ?? (isTrop ? [0.78, 1.12, 0.68] : [1.0, 1.0, 1.0]);
      const rTint = tint * climateTint[0] * (tended ? tended.tint[0] : 1);
      const gTint = tint * climateTint[1] * (tended ? tended.tint[1] : 1);
      const bTint = tint * climateTint[2] * (tended ? tended.tint[2] : 1);
      secRoots.set([x, gy - sink, z, scale, yaw, rTint, gTint, bTint, protoId, sink, rootIdentityZ, 0], placedIdx * 12);
      return placedIdx;
    };

    const isVolcanicIsland = region.coastalArchetype === 'volcanic-island';
    let nearBandCut = isVolcanicIsland ? 88 : 123;
    let midBandCut = isVolcanicIsland ? 176 : 212;
    const setBandCuts = () => {
      if (country?.board && validLandCells.length > 0) {
        const wNear = nearLandCells.length * 1.5;
        const wMid = midLandCells.length * 1.2;
        const wFar = farLandCells.length * 1.0;
        const wTot = Math.max(1, wNear + wMid + wFar);
        nearBandCut = Math.round((wNear / wTot) * 256);
        midBandCut = Math.round(((wNear + wMid) / wTot) * 256);
      } else {
        nearBandCut = isVolcanicIsland ? 88 : 123;
        midBandCut = isVolcanicIsland ? 176 : 212;
      }
    };
    setBandCuts();
    const drawCandidateXZ = (h1, h2) => {
      if (validLandCells.length > 0) {
        const bandSel = (h2 >>> 24) & 255;
        const pool =
          bandSel < nearBandCut && nearLandCells.length > 0
            ? nearLandCells
            : bandSel < midBandCut && midLandCells.length > 0
              ? midLandCells
              : farLandCells.length > 0
                ? farLandCells
                : validLandCells;
        const cellIdx = pool[h1 % pool.length];
        const bi = cellIdx % maskSize;
        const bj = (cellIdx / maskSize) | 0;
        const jitterU = ((h1 >>> 16) & 65535) / 65536;
        const jitterV = (h2 & 65535) / 65536;
        const u = (bi + jitterU) / maskSize;
        const v = (bj + jitterV) / maskSize;
        return [x0 + u * span, z0 + v * span];
      }
      return [x0 + (h1 / 4294967296) * span, z0 + (h2 / 4294967296) * span];
    };

    // Tended ground first: town squares, the board's open-country lone/copse trees, orchards, feathered wood
    // margins, and hedgerow/roadside lines take a modest share, leaving the bulk of the root budget for closed forests.
    const standing = country?.plan?.standing ?? [];
    for (let k = 0; k < standing.length; k++) tryPlaceTree(standing[k][0], standing[k][1], hash32Forest((seed ^ 0x1b873593) + Math.imul(k, 0x9e3779b1)), false, false, false, true);
    const loneTrees = country?.loneTrees ?? null;
    if (loneTrees) {
      const LONE_KINDS = [
        { spacing: 5.5, height: [10.5, 7.5], scale: [0.82, 0.42], species: ['oak', 'elm', 'chestnut'], cohort: 'veteran', tint: [0.94, 0.98, 0.9] },
        { spacing: 5.5, height: [9.5, 6.5], scale: [0.76, 0.38], species: ['oak', 'birch', 'chestnut'], cohort: 'canopy', tint: [0.88, 0.96, 0.88] },
        { spacing: 4.5, height: [5.0, 4.2], scale: [0.44, 0.28], species: ['birch', 'maple', 'oak'], cohort: 'canopy', tint: [0.93, 0.98, 0.9] },
      ];
      for (let k = 0; k + 3 < loneTrees.length; k += 4) {
        const baseSpec = LONE_KINDS[loneTrees[k + 3] | 0] ?? LONE_KINDS[2];
        const sizeMul = Math.max(0.65, Math.min(1.45, loneTrees[k + 2] || 1));
        const loneSpec = {
          ...baseSpec,
          height: [baseSpec.height[0] * sizeMul, baseSpec.height[1] * sizeMul],
          scale: [baseSpec.scale[0] * sizeMul, baseSpec.scale[1] * sizeMul],
        };
        tryPlaceTree(loneTrees[k], loneTrees[k + 1], hash32Forest((seed ^ 0x517cc1b7) + Math.imul(k, 0x9e3779b1)), false, false, false, true, loneSpec);
      }
    }
    if (tendedCells.all.length > 0) {
      const wild = [validLandCells, nearLandCells, midLandCells, farLandCells];
      [validLandCells, nearLandCells, midLandCells, farLandCells] = [tendedCells.all, tendedCells.near, tendedCells.mid, tendedCells.far];
      setBandCuts();
      const maxTendedShare = country?.board ? 0.34 : 0.48;
      const wildWeight = country?.board ? 3.2 : 1.35;
      const tendedShare = wild[0].length > 0
        ? Math.min(maxTendedShare, Math.max(0.14, tendedCells.all.length / Math.max(1, tendedCells.all.length + wild[0].length * wildWeight)))
        : 1;
      const tendedBudget = Math.min(effectiveSecMaxRoots, totalPlaced + Math.round(Math.max(0, effectiveSecMaxRoots - totalPlaced) * tendedShare));
      const tendedSeed = (seed ^ 0x3c6ef372) >>> 0;
      for (let step = 0; step < (tendedBudget - totalPlaced) * 10 && totalPlaced < tendedBudget; step++) {
        const h1 = hash32Forest(tendedSeed + Math.imul(step, 0x9e3779b1));
        const h2 = hash32Forest(h1 ^ Math.imul(step, 0x85ebca6b) ^ 0x27d4eb2f);
        const [sx, sz] = drawCandidateXZ(h1, h2);
        tryPlaceTree(sx, sz, h2, false, false, false);
      }
      [validLandCells, nearLandCells, midLandCells, farLandCells] = wild;
      setBandCuts();
      consecutiveCollisions = 0;
    }

    // Stage 1: Veteran emergent cohort (~24% of forest stand) + drip-line nurse & gap satellites
    const forestStart = totalPlaced;
    const forestBudget = Math.max(0, effectiveSecMaxRoots - forestStart);
    const veteranBudget = Math.max(16, Math.round(forestBudget * 0.24));
    const maxVetCandidates = veteranBudget * 6;
    const baseSeed = (seed ^ 0x9e3779b9) >>> 0;
    for (
      let step = 0;
      step < maxVetCandidates && totalPlaced < effectiveSecMaxRoots && consecutiveCollisions < 3600;
      step++
    ) {
      const h1 = hash32Forest(baseSeed + Math.imul(step, 0x9e3779b1));
      const h2 = hash32Forest(h1 ^ Math.imul(step, 0x85ebca6b) ^ 0xc2b2ae35);
      const [sx, sz] = drawCandidateXZ(h1, h2);
      const vetIdx = tryPlaceTree(sx, sz, h2, false, true, false);
      if (vetIdx < 0) continue;

      const vetR = rr[vetIdx];
      const baseAngle = (hash32Forest(h2 + 17) / 4294967296) * Math.PI * 2;
      // Drip-line nurse ring (0.52..1.18 * vetR) + gap-edge canopy ring (1.25..1.95 * vetR)
      for (let c = 0; c < 5 && totalPlaced < effectiveSecMaxRoots; c++) {
        const cKey = hash32Forest(h2 ^ Math.imul(c + 1, 0x27d4eb2d));
        const angle = baseAngle + c * 2.39996323 + ((cKey & 1023) / 1024 - 0.5) * 0.42;
        const isDrip = c < 3;
        const ringMin = isDrip ? 0.52 : 1.25;
        const ringSpan = isDrip ? 0.66 : 0.70;
        const dist = vetR * (ringMin + (((cKey >>> 10) & 1023) / 1024) * ringSpan);
        const nx = sx + Math.cos(angle) * dist;
        const nz = sz + Math.sin(angle) * dist;
        tryPlaceTree(nx, nz, cKey, true, false, isDrip);
      }
      if (totalPlaced - forestStart >= Math.round(forestBudget * 0.64)) break;
    }

    // Stage 2: Dense canopy & understory matrix cohort filling remaining stand capacity
    consecutiveCollisions = 0;
    const maxCanopyCandidates = effectiveSecMaxRoots * 5;
    const canopySeed = (seed ^ 0x7f4a7c15) >>> 0;
    for (
      let step = 0;
      step < maxCanopyCandidates && totalPlaced < effectiveSecMaxRoots && consecutiveCollisions < 6400;
      step++
    ) {
      const h1 = hash32Forest(canopySeed + Math.imul(step, 0x9e3779b1));
      const h2 = hash32Forest(h1 ^ Math.imul(step, 0x85ebca6b) ^ 0x165667b1);
      const [sx, sz] = drawCandidateXZ(h1, h2);
      const rootIdx = tryPlaceTree(sx, sz, h2, false, false, false);
      if (rootIdx < 0) continue;

      const baseR = rr[rootIdx];
      const baseAngle = (hash32Forest(h2 + 19) / 4294967296) * Math.PI * 2;
      for (let c = 0; c < 10 && totalPlaced < effectiveSecMaxRoots; c++) {
        const cKey = hash32Forest(h2 ^ Math.imul(c + 1, 0x27d4eb2d));
        const angle = baseAngle + c * 2.39996323 + ((cKey & 1023) / 1024 - 0.5) * 0.48;
        const ringMul = c < 5 ? 0.58 : 1.12;
        const dist = baseR * ringMul * (0.85 + (((cKey >>> 10) & 1023) / 1024) * 0.36);
        const nx = sx + Math.cos(angle) * dist;
        const nz = sz + Math.sin(angle) * dist;
        tryPlaceTree(nx, nz, cKey, true, false, c < 5);
      }
    }
    const planted = secRoots.slice(0, totalPlaced * 12);
    secPack._cachedForestPlanted = { key: cacheKey, owner, roots: planted };
    return planted;
  };

  // A planted tree keeps the ground under its crown; a grove's trees stand everywhere else that is wood.
  const groveReach = (kind, scale) => {
    const p = forestPack.manifest.prototypes[kind];
    return Math.max(2.5, Math.min(16, (p?.crownRadius ?? p?.crownRadiusMetres ?? 6) * scale * 0.9));
  };
  // The trees of the pack's grove that stand on a section (js/forest-groves.js), as records in the order they
  // were planted: on every square of its wood that no planted tree has, by the same rules a planted tree keeps.
  // Planted again only when the section's ground, marking, town or planted trees change. A section let go keeps
  // only how many its grove holds (groveCount), and is planted again when it comes back. A grove is a list of arrays
  // (rootChunks).
  const groveKey = (secPack, planted) => `${forestGroveStamp(secPack, planted)}:${activeClimate.koppenCode ?? activeClimate.climate}:${protoCount}:${isMobile ? 1 : 0}`;
  const groveCount = (secPack, planted) => cachedFor(secPack._cachedForestGrove, groveKey(secPack, planted))?.count ?? null;
  const groveSection = (secPack, planted) => {
    const region = secPack.region, heights = secPack.heights, port = secPack.port, plantedFlat = planted;
    const key = groveKey(secPack, planted);
    const cachedGrove = cachedFor(secPack._cachedForestGrove, key);
    if (cachedGrove?.roots) return cachedGrove.roots;
    const span = region.span ?? 8192, x0 = region.x - span * 0.5, z0 = region.z - span * 0.5, borderMargin = 0.05;
    const size = secPack === proceduralPack ? (isMobile ? 512 : 1024) : (isMobile ? 256 : 512);
    const cover = forestGroveCover({ region: { ...region, span }, heights, biome: secPack.biome, beaches: secPack.beaches, port, mangrove: hasMangrove, size });
    forestGroveOccupy(cover, size, { ...region, span }, plantedFlat, groveReach);
    const country = port?._resolvedCountry ?? oldWorldCountry(region, heights, port);
    const waterAt = createInlandWaterSampler(port?.country ?? country, { margin: 3.8 });
    const cityBlocked = buildCityBlockTester(secPack.city ?? country?.plan, 2.6);
    const half = span * 0.5 - 0.01;
    const ground = (wx, wz) => heights && region?.size
      ? terrainSurfaceSample(heights, Math.max(region.x - half, Math.min(region.x + half, wx)), Math.max(region.z - half, Math.min(region.z + half, wz)), region)
      : groundSample(wx, wz);
    const isTrop = ['tropical', 'subtropical'].includes(activeClimate.climate) || ['tropical', 'subtropical'].includes(region.climate);
    const climateTint = activeClimate.foliageTint ?? (isTrop ? [0.78, 1.12, 0.68] : [1.0, 1.0, 1.0]);
    const harbour = port?.center ?? proceduralPack.port?.center ?? proceduralPack.region;
    const out = rootChunks();
    forestGroveTrees({ stand, cover, size, region: { ...region, span }, harbour, visit(x, z, kind, scale, yaw, seed) {
      const proto = forestPack.manifest.prototypes[kind];
      if (!proto) return;
      if (x <= x0 + borderMargin || x >= x0 + span - borderMargin || z <= z0 + borderMargin || z >= z0 + span - borderMargin) return;
      // A grove is wild wood: none stands on a farmer's ground, in a town or by a road.
      if (country && country.treesAt(x, z) !== null) return;
      if (port && (port.clearRadius > 0 || port.waterfront?.length > 0)) {
        const envPad = port.hasIndigenousSettlement ? 8.5 : 10;
        if (!portClearanceEnvelope(port, x, z, envPad)) return;
        if (!port.hasIndigenousSettlement && port.clearRadius > 0 && Math.hypot(x - port.center.x, z - port.center.z) < port.clearRadius * 0.38) return;
        if (streetEdgeAt(port.streets, x, z) < PLANT_STREET_GAP_M) return;
      }
      if (waterAt?.(x, z) || cityBlocked?.(x, z)) return;
      const gy = ground(x, z);
      if (!Number.isFinite(gy) || gy < (hasMangrove ? 0.35 : 0.75) || gy > 845) return;
      const slope = Math.hypot(ground(x + 2, z) - ground(x - 2, z), ground(x, z + 2) - ground(x, z - 2)) * 0.25;
      if (!Number.isFinite(slope) || slope > 0.84 || (gy < 6 && slope > 0.48)) return;
      const rim = Math.min(4.5, (proto.crownRadius ?? proto.crownRadiusMetres ?? 8.5) * scale * 0.2), rimMinGy = proto.species === 'mangrove' ? 0.08 : 0.45;
      if (ground(x + rim, z) < rimMinGy || ground(x - rim, z) < rimMinGy || ground(x, z + rim) < rimMinGy || ground(x, z - rim) < rimMinGy) return;
      const sink = Math.min(1.6, 0.22 + 0.68 * (proto.basalRadius ?? 1.2) * scale * slope);
      const tint = 0.92 + ((seed >>> 8) & 0xffff) / 65536 * 0.16;
      out.push(x, gy - sink, z, scale, yaw, tint * climateTint[0], tint * climateTint[1], tint * climateTint[2], kind, sink, rootIdentityZ, 0);
    } });
    const roots = out.finish();
    secPack._cachedForestGrove = { key, owner, roots, count: out.count };
    return roots;
  };

  // Every section plants its own trees first, within the planted budget, in the order the sections came; that
  // budget is small. Then the sections are held nearest the player first (`near`, or the coast's centre), each with
  // its grove, as many as the device's roots hold (rootCapacity, js/forest-scenery.js forestRootCapacity): the first
  // that does not fit is let go with every one beyond it, whole, and planted again when it is nearer.
  const sectionPacks = [proceduralPack, ...(Array.isArray(extraSections) ? extraSections : [])];
  const plantedOf = new Map();
  let plantedTotal = 0;
  plantedOf.set(proceduralPack, plantSection(proceduralPack, baseMaxRoots));
  plantedTotal += plantedOf.get(proceduralPack).length / 12;
  const perSecBudget = isMobile ? 2600 : 15000;
  for (const sec of sectionPacks.slice(1)) {
    const remaining = effectiveMaxCapacity - plantedTotal;
    // Once the planted budget is spent a section plants none of its own, but its wood is still a grove.
    const planted = remaining < 64 ? new Float32Array(0) : plantSection(sec, Math.min(perSecBudget, remaining));
    plantedOf.set(sec, planted);
    plantedTotal += planted.length / 12;
  }

  const basePort = proceduralPack.port ?? null;
  const baseWaterAt = createInlandWaterSampler(basePort?.country ?? basePort?._resolvedCountry ?? null, { margin: 3.8 });
  const baseCityBlocked = buildCityBlockTester(proceduralPack.city ?? basePort?._resolvedCountry?.plan, 2.6);
  const isBaseClearForTree = (px, pz) => {
    if (baseWaterAt?.(px, pz) || baseCityBlocked?.(px, pz)) return false;
    if (basePort && (basePort.clearRadius > 0 || basePort.waterfront?.length > 0)) {
      const envPad = basePort.hasIndigenousSettlement ? 8.5 : 10;
      if (!portClearanceEnvelope(basePort, px, pz, envPad)) return false;
      if (!basePort.hasIndigenousSettlement && basePort.clearRadius > 0 &&
          Math.hypot(px - basePort.center.x, pz - basePort.center.z) < basePort.clearRadius * 0.38) return false;
      if (streetEdgeAt(basePort.streets, px, pz) < PLANT_STREET_GAP_M) return false;
    }
    return true;
  };

  // The coast's own section also holds its foreshore palms and, where nothing else would stand, the scrub its land
  // cover names.
  const coastTrees = rootChunks();
  const mainGrove = stand ? groveSection(proceduralPack, plantedOf.get(proceduralPack)) : null;
  if (plantedTotal === 0 && !(rootsIn(mainGrove) > 0)) {
    const sources = [
      ...(proceduralPack.vegetation?.scrub || []),
      ...(proceduralPack.vegetation?.upland || []),
    ];
    for (let i = 0; i < sources.length; i += 8) {
      const x = sources[i], z = sources[i + 2];
      if (!isBaseClearForTree(x, z)) continue;
      const legacyScale = sources[i + 3], yaw = sources[i + 4];
      const gy = groundSample(x, z);
      if (!Number.isFinite(gy) || gy < 2.0) continue;
      const sx = (groundSample(x + 1, z) - groundSample(x - 1, z)) * 0.5;
      const sz = (groundSample(x, z + 1) - groundSample(x, z - 1)) * 0.5;
      const slope = Math.hypot(sx, sz);
      if (!Number.isFinite(slope) || slope > 1.08) continue;
      const hash = ((Math.sin(x * 0.071 + z * 0.113 + yaw) * 43758.5453) % 1 + 1) % 1;
      const protoId = Math.min(protoCount - 1, Math.floor(hash * protoCount));
      const scale = Math.max(0.90, Math.min(1.36, 0.72 + legacyScale * 0.085));
      const tint = 0.92 + ((hash * 7.3) % 0.16);
      const basal = forestPack.manifest.prototypes[protoId].basalRadius ?? 1.2;
      const sink = Math.min(1.6, 0.22 + 0.68 * basal * scale * slope);
      coastTrees.push(x, gy - sink, z, scale, yaw, tint, tint, tint, protoId, sink, -2, 0);
    }
  }
  // The foreshore fringe, leaning out over the sea as coconuts do.
  const coconutId = forestPack.manifest.prototypes.findIndex((p) => p.species === 'palm');
  const foreshore = proceduralPack.vegetation?.palms;
  if (coconutId >= 0 && foreshore?.length) {
    const basal = forestPack.manifest.prototypes[coconutId].basalRadius ?? 0.3;
    for (let i = 0; i < foreshore.length && i < FORESHORE_PALMS_MAX * 8; i += 8) {
      const x = foreshore[i], z = foreshore[i + 2], shape = foreshore[i + 5], seaX = -foreshore[i + 6], seaZ = -foreshore[i + 7];
      if (!isBaseClearForTree(x, z)) continue;
      const gy = groundSample(x, z);
      if (!Number.isFinite(gy) || gy < 1.2) continue;
      const fsx = (groundSample(x + 2, z) - groundSample(x - 2, z)) * 0.25;
      const fsz = (groundSample(x, z + 2) - groundSample(x, z - 2)) * 0.25;
      const fSlope = Math.hypot(fsx, fsz);
      if (fSlope > 0.34) continue;
      const { scale, sink: baseSink, yaw } = foreshorePalmPlacement(shape, seaX, seaZ, basal);
      const sink = Math.max(baseSink, 0.22 + 0.68 * basal * scale * fSlope);
      const tint = 0.94 + shape * 0.12;
      coastTrees.push(x, gy - sink, z, scale, yaw, tint, tint, tint, coconutId, sink, -2, 0);
    }
  }
  const coastExtras = coastTrees.finish();

  const centre = near && Number.isFinite(near.x) && Number.isFinite(near.z) ? near : proceduralPack.region;
  const distanceTo = (secPack) => {
    const r = secPack.region, half = (r.span ?? 8192) * 0.5;
    return Math.hypot(Math.max(0, Math.abs(centre.x - r.x) - half), Math.max(0, Math.abs(centre.z - r.z) - half));
  };
  const ordered = sectionPacks.map((secPack, index) => ({ secPack, index, distance: distanceTo(secPack) }))
    .sort((a, b) => a.distance - b.distance || a.index - b.index);
  const sections = [];
  let total = 0, groveTotal = 0, residentPlanted = 0, sectionsReleased = 0, letGo = false;
  const release = (secPack) => {
    sectionsReleased++;
    const cached = secPack._cachedForestGrove;
    if (cached?.roots) secPack._cachedForestGrove = { ...cached, roots: null };
  };
  for (const { secPack, index } of ordered) {
    if (letGo) { release(secPack); continue; }
    const planted = plantedOf.get(secPack);
    const own = index === 0 ? coastExtras : [];
    let count = planted.length / 12 + rootsIn(own);
    let grove = null;
    if (stand) {
      // A section let go before says how large its grove is without being planted again.
      const known = index === 0 ? null : groveCount(secPack, planted);
      if (known !== null && total + count + known > rootCapacity) { letGo = true; release(secPack); continue; }
      grove = index === 0 ? mainGrove : groveSection(secPack, planted);
      count += rootsIn(grove);
    }
    if (total + count > rootCapacity) { letGo = true; release(secPack); continue; }
    total += count;
    residentPlanted += planted.length / 12;
    groveTotal += rootsIn(grove);
    const r = secPack.region;
    sections.push({ key: index === 0 ? 'coast' : `${r.x},${r.z}`, parts: [planted, ...(grove ?? []), ...own].filter((part) => part.length > 0) });
  }
  // A coast with no tree at all keeps one root out of sight below the land.
  if (total === 0) {
    sections.push({ key: 'sentinel', parts: [new Float32Array([proceduralPack.region.x, -500, proceduralPack.region.z, 0, 0, 1, 1, 1, 0, 0, -2, 0])] });
    total = 1;
  }
  const kinds = new Uint32Array(protoCount);
  for (const section of sections) for (const part of section.parts) for (let k = 8; k < part.length; k += 12) {
    const kind = part[k] | 0;
    if (kind >= 0 && kind < protoCount) kinds[kind]++;
  }
  let firstRoot = 0;
  const prototypes = forestPack.manifest.prototypes.map((p, id) => {
    const next = { ...p, firstRoot, rootCount: kinds[id] };
    firstRoot += kinds[id];
    return next;
  });
  return {
    ...forestPack,
    roots: null,
    sections,
    maxRootCapacity: effectiveMaxCapacity,
    rootCapacity,
    plantedRoots: residentPlanted,
    groveRoots: groveTotal,
    sectionsResident: sections.length,
    sectionsReleased,
    climateProfile: activeClimate,
    manifest: {
      ...forestPack.manifest,
      rootCount: total,
      prototypes,
    },
  };
}

// Ground cover is resident within this range of the camera, and leaves it a little further out.
const GROUND_RESIDENT_M = 1200;
const GROUND_RESIDENT_RELEASE = 1.15;
const GROUND_RESIDENCY_MOVE_M = 16;
const GROUND_PATCHES_PER_FRAME = 8;
// What stands no higher than this above the ground beneath it stands on the ground (CONTINUUM_GROUNDED); higher, it
// stands on a quay, a pier or a deck.
const GROUND_STANDING_M = 0.75;

export async function createTerrain({device,frameUBO,transView,skyView,sampler,envCubeView,clouds,shader,computePipe,mipPipe,format,samples,waterOptics=null,oceanBridge=null,
  region:explicitRegion=null,placement=null,options={},
  canopyMode=typeof location==='undefined'?'auto':new URLSearchParams(location.search).get('canopy')||'auto',portDamage=null,landShadows=null,boardKept=null,sceneryGate=null}){
  if(!['auto','off'].includes(canopyMode))throw Error('Unknown canopy scenery mode');
  const activeLandShadows=landShadows??createLandShadows(device,64);
  const ownsLandShadows=!landShadows;
  // createTerrain is itself deferred until landfall; optional stand downloads
  // never run on the open-ocean startup path. Failure retains all old roots.
  const search=typeof location==='undefined'?new URLSearchParams():new URLSearchParams(location.search);
  const explicitObj=explicitRegion&&typeof explicitRegion==='object'?explicitRegion:null;
  const explicitId=typeof explicitRegion==='string'?explicitRegion:(explicitObj?.id??null);
  const ignoreSearchLocation=Boolean(options?.lateSpawn||(explicitObj&&Number.isFinite(explicitObj.latitude)&&Number.isFinite(explicitObj.longitude)));
  const rawLat=Number.isFinite(explicitObj?.latitude)?Number(explicitObj.latitude):!ignoreSearchLocation&&search.has('lat')?Number(search.get('lat')):!ignoreSearchLocation&&search.has('latitude')?Number(search.get('latitude')):NaN;
  const rawLon=Number.isFinite(explicitObj?.longitude)?Number(explicitObj.longitude):!ignoreSearchLocation&&search.has('lon')?Number(search.get('lon')):!ignoreSearchLocation&&search.has('longitude')?Number(search.get('longitude')):NaN;
  const hasExplicitLatLon=(Number.isFinite(explicitObj?.latitude)&&Number.isFinite(explicitObj?.longitude))||(!ignoreSearchLocation&&search.has('lat')&&search.has('lon')&&Number.isFinite(Number(search.get('lat')))&&Number.isFinite(Number(search.get('lon'))));
  const hasCustomCoords=hasExplicitLatLon||(Number.isFinite(rawLat)&&Number.isFinite(rawLon)&&(Math.abs(rawLat-ISLAND.latitude)>0.12||Math.abs(rawLon-ISLAND.longitude)>0.12));
  const rawYearParam=explicitObj?.year??explicitObj?.era??search.get('year')??(search.get('era')&&search.get('era')!=='2026'?search.get('era'):null);
  let astroYear=null;
  if(rawYearParam==null&&search.has('astroDate')){
    const parsedAstroYear=new Date(search.get('astroDate')).getUTCFullYear();
    if(Number.isFinite(parsedAstroYear)&&parsedAstroYear>=1492&&parsedAstroYear<=1689)astroYear=parsedAstroYear;
  }
  const coordPresetMatch=hasCustomCoords
    ?Object.values(SPANISH_MAIN_1550_REGIONS).find(r=>Math.abs(rawLat-r.latitude)<0.05&&Math.abs(rawLon-r.longitude)<0.05)??null
    :null;
  const defaultLisbonDeparture=!ignoreSearchLocation&&!explicitId&&!explicitObj&&!search.has('region')&&!hasCustomCoords&&!search.has('landfall')&&search.get('ocean')!=='1';
  const regionParam=explicitId||(!ignoreSearchLocation?search.get('region'):null)||(coordPresetMatch?coordPresetMatch.id:null)||(defaultLisbonDeparture?'lisbon':null);
  const forceProcedural=search.get('procedural')==='1'||Boolean(explicitObj?.procedural);
  const spanishMainPreset=regionParam&&(regionParam!=='saba'||forceProcedural)&&Object.hasOwn(SPANISH_MAIN_1550_REGIONS,regionParam)?SPANISH_MAIN_1550_REGIONS[regionParam]:null;
  const colonialPortPreset=!spanishMainPreset&&regionParam&&(regionParam!=='saba'||forceProcedural)?HISTORICAL_COLONIAL_PORTS.find(p=>p.id===regionParam)??null:null;
  const presetMatch=spanishMainPreset||colonialPortPreset;
  const resolvedYear=rawYearParam!=null
    ?resolveColonialEra(rawYearParam).year
    :astroYear!=null
      ?resolveColonialEra(astroYear).year
      :(colonialPortPreset?.foundedYear>1550?Math.min(1685,colonialPortPreset.foundedYear+15):1550);
  const ownNativePreset=regionParam?nativeOwnGroundFor(regionParam,resolvedYear):null;
  // The id the land is made under and its board fetched, kept and looked for by (coastalRegionId): a native town asked
  // for by its own name stands on its coast's, never under a second one.
  const regionKey=regionParam?coastalRegionId({id:regionParam,year:resolvedYear}):regionParam;
  const effectivePreset=ownNativePreset
    ?{...(presetMatch||{}),id:ownNativePreset.port,name:`${ownNativePreset.name} · Chickahominy`,latitude:ownNativePreset.latitude,longitude:ownNativePreset.longitude,shoreBearing:ownNativePreset.shoreBearing??presetMatch?.shoreBearing}
    :presetMatch;
  const isKnownSpanishMain=Boolean(spanishMainPreset&&(!hasCustomCoords||(Math.abs(rawLat-spanishMainPreset.latitude)<0.05&&Math.abs(rawLon-spanishMainPreset.longitude)<0.05)));
  const isKnownColonialPreset=Boolean(effectivePreset&&(!hasCustomCoords||(Math.abs(rawLat-effectivePreset.latitude)<0.05&&Math.abs(rawLon-effectivePreset.longitude)<0.05)));
  const isCustomSabaOverride=forceProcedural||(hasCustomCoords&&regionParam==='saba'&&(Math.abs(rawLat-ISLAND.latitude)>0.05||Math.abs(rawLon-ISLAND.longitude)>0.05));
  const useProcedural=forceProcedural||isKnownColonialPreset||(hasCustomCoords&&(regionParam!=='saba'||isCustomSabaOverride));
  const targetLat=effectivePreset?effectivePreset.latitude:(Number.isFinite(rawLat)?rawLat:ISLAND.latitude);
  const targetLon=effectivePreset?effectivePreset.longitude:(Number.isFinite(rawLon)?rawLon:ISLAND.longitude);
  let activeClimate=estimateLocalClimateProfile(targetLat,targetLon,effectivePreset);
  const forestMixParam=search.get('forestMix');
  const useSubtropicalForest=forestMixParam
    ?(forestMixParam==='subtropical'||forestMixParam==='tropical')
    :(useProcedural&&activeClimate.forestPackKind==='subtropical');
  const usePortugalForest=forestMixParam
    ?(forestMixParam==='portugal'||forestMixParam==='temperate')
    :(useProcedural&&!useSubtropicalForest);
  const isMobile=typeof navigator!=='undefined'&&(/iPhone|iPad|iPod|Android/i.test(navigator.userAgent||'')||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1));
  const load=async path=>{const response=await fetch(path);if(!response.ok)throw new Error(`Saba terrain unavailable (${response.status})`);return response;};
  // Start shader compilation, foliage fetch, and forest downloads immediately in parallel with DEM/terrain loading
  const mipPipePromise=Promise.resolve(mipPipe),cloudsResolvedPromise=Promise.resolve(clouds),waterOpticsResolvedPromise=Promise.resolve(waterOptics);
  mipPipePromise.catch(()=>{});cloudsResolvedPromise.catch(()=>{});waterOpticsResolvedPromise.catch(()=>{});
  const neuralPbr=sharedNeuralPbrBank(device);
  // Specialized shader preludes: land (terrain-only), city (architectural + hardware texture_2d_array),
  // and forest (finish-only) eliminate Apple Metal register spilling and 12-20x storage-buffer arch reads.
  const landSource=withNeuralPbrLand(TERRAIN_LAND);
  const citySource=withNeuralPbrCity(TERRAIN_CITY);
  // The land itself, every piece cut by its own quadtree and drawn as a heightfield of the one family's programs
  // (js/land-continuum.js, js/wgsl/land-continuum.js): its view, and under water the captures' coarser cut.
  const landMaterial=landContinuumMaterial(landSource);
  // A city's buildings, through the one continuum: the city's material, shaded by the land's own surfaces, in a view
  // of its own (js/wgsl/city-continuum.js).
  const cityMaterial=cityContinuumMaterial(citySource);
  const cityViewPromise=requestContinuumView({device,shader,material:cityMaterial,format,samples});
  // The ground cover's rocks, through the one continuum: fractured coastal & hillside boulders (js/wgsl/boulder-continuum.js).
  const boulderViewPromise=requestContinuumView({device,shader,material:BOULDER_CONTINUUM_MATERIAL_SPEC,format,samples});
  boulderViewPromise.catch(()=>{});
  const terrainPipesPromise=Promise.all([
    computePipe(TERRAIN_LIGHT,'island sunlight'),
    cityViewPromise,
    requestContinuumView({device,shader,material:landMaterial,format,samples}).then(view=>view.pipeline),
  ]);
  terrainPipesPromise.catch(()=>{});
  const submergedPipesPromise=waterOpticsResolvedPromise.then(wo=>wo?Promise.all([
    // The land's coarser cut of the same patches, morphed at the captures' own pixel error.
    requestContinuumCapture(wo,landMaterial),
    // Waterfront piers, pilings, quay walls, and bridges captured below the waterline for physical water refraction.
    requestContinuumCapture(wo,cityMaterial),
  ]):[null,null]);
  submergedPipesPromise.catch(()=>{});
  // The rest of the land's programs, asked for now so that they compile while the land itself is being made. Left
  // until each is first needed, they compile one after another once it is.
  for(const pending of [computePipe(COASTAL_FIELD_BAKE,'coastal field'),computePipe(GROUND_DETAIL_BAKE,'ground detail bake'),
    useProcedural?requestContinuumPrograms({device,shader,shadowFormat:activeLandShadows.format}):null,
    requestCityContinuumAtlas(device),requestBoulderContinuumAtlas(device),
    requestLandCraterPipelines({computePipe}),requestLandContinuumPipelines({device,shader}),
    useProcedural?requestInlandWaterPipeline({device,shader,format,samples}):null,
    useProcedural&&!isMobile?requestTradeVesselsPipelines({device,shader,format,samples,shadowFormat:activeLandShadows.format}):null])pending?.catch(()=>{});
  // An Old World city is the board Castle and Commons' model founded for its port ahead of time: the board is fetched
  // while the rest loads, and handed over before the land is made. A city whose board is missing has no town.
  const bakedBoardYear=useProcedural&&typeof regionKey==='string'&&search.get('board')!=='off'?resolveBakedBoardYear(regionKey,resolvedYear):null;
  const bakedBoardPath=bakedBoardYear!=null?bakedBoardAsset(regionKey,bakedBoardYear):null;
  const runtimeKeepKey=!bakedBoardPath&&useProcedural&&search.get('board')!=='off'&&!placement?coastalRegionId({id:regionKey||undefined,latitude:targetLat,longitude:targetLon,year:resolvedYear}):null;
  // If the model has lived here since (js/board-keep.js), the land is laid from the board as the traveller left it:
  // whatever was built, burnt or thrown down while they were away is there on their return, never changed in sight.
  // `boardKept` is {clock, dateMs}: whose calendar the kept world must be of, and the game's date now.
  const bakedBoardPromise=bakedBoardPath?Promise.all([fetch(bakedBoardPath).then(response=>response.ok?response.json():null).catch(()=>null),
    boardKept&&Number.isFinite(boardKept.dateMs)?keptBoard(regionKey,bakedBoardYear,{clock:boardKept.clock}):null]).then(([baked,kept])=>boardAsKept(baked,kept,boardKept?.dateMs))
    :(runtimeKeepKey&&boardKept?keptBoard(runtimeKeepKey,resolvedYear,{clock:boardKept.clock}).then(kept=>kept?.board?{port:runtimeKeepKey,year:kept.year??resolvedYear,board:kept.board,lived:{day:kept.day,days:0,keptAt:kept.keptAt??null}}:null).catch(()=>null):null);
  if(bakedBoardPath||runtimeKeepKey)requestBoardStampPipelines({device,shader}).catch(()=>{});
  const useCompactScenery=isMobile||(device.limits?.maxStorageBufferBindingSize??Infinity)<256*1024*1024;
  let forestFailure=null;
  const startForestLoad=()=>canopyMode==='off'?Promise.resolve(null):loadForestScenery({
    assets:useSubtropicalForest?SUBTROPICAL_FOREST_ASSETS:usePortugalForest?PORTUGAL_FOREST_ASSETS:FOREST_ASSETS,
    skipRoots:useProcedural,
    deferSurfaces:Boolean(chooseForestSurfaceCodec(device,search.get('forestSurfaces')||'auto')),
  }).catch(error=>{forestFailure=error.message;return null;});
  // A grove is the wood of a generated coast beyond its planted trees, planted as roots of the forest pack
  // (js/forest-groves.js). A coast that cannot load its grove keeps its planted trees alone, and says why.
  let groveFailure=null;
  const groveAssets=useSubtropicalForest?SUBTROPICAL_FOREST_GROVE_ASSETS:usePortugalForest?PORTUGAL_FOREST_GROVE_ASSETS:null;
  const startGroveLoad=()=>canopyMode==='off'||!useProcedural||!groveAssets||search.get('forestGroves')==='0'?Promise.resolve(null):loadForestGroves({assets:groveAssets}).catch(error=>{groveFailure=error.message;return null;});
  let meadowFailure=null;
  // Every coast grows the grass of its climate, as its forest does: the tropical sward where the place's climate is
  // subtropical (Saba's among them), the Portuguese elsewhere. There is no cold-temperate or boreal sward or forest
  // yet, so Québec, New England and the north take the Portuguese.
  const tropicalSward=forestMixParam?useSubtropicalForest:activeClimate.forestPackKind==='subtropical';
  // The sward is a table of species (js/meadow-grass.js MEADOW_SWARDS): its blades are made on the GPU, nothing loaded.
  const startMeadowLoad=()=>Promise.resolve({sward:tropicalSward?'tropical':'portugal'});
  // On desktop, prefetch forest/groves/meadow in parallel with city/land for minimal latency.
  // On mobile, serialize heavy continuum atlas decompressions (city -> forest -> meadow) to prevent Jetsam OOM spikes.
  const forestPromise=isMobile?null:startForestLoad();
  const grovePromise=isMobile?null:startGroveLoad();
  const meadowPromise=isMobile?null:startMeadowLoad();
  const autoCurated1550=isKnownSpanishMain&&search.get('discover')!=='1'&&search.get('era')!=='2026'&&search.get('realDEM')!=='off';
  const useRealDEM=useProcedural&&search.get('realDEM')!=='off'&&!autoCurated1550;
  const proceduralGridOpts=isMobile
    ?{size:257,biomeSize:256,albedoSize:512,vegetationCandidates:12000,deferSynthesis:useRealDEM||autoCurated1550}
    :{size:513,biomeSize:512,albedoSize:1024,vegetationCandidates:24000,deferSynthesis:useRealDEM||autoCurated1550};
  const placedX=Number.isFinite(placement?.x)?Number(placement.x):Number.isFinite(explicitObj?.x)?Number(explicitObj.x):undefined;
  const placedZ=Number.isFinite(placement?.z)?Number(placement.z):Number.isFinite(explicitObj?.z)?Number(explicitObj.z):undefined;
  const hasPlacementOverride=placedX!==undefined||placedZ!==undefined;
  const proceduralSpec=isKnownSpanishMain&&!hasPlacementOverride&&(resolvedYear===1550||bakedBoardYear===1550)
    ?regionParam
    :{
      ...(effectivePreset||{}),
      id:regionKey||undefined,
      name:explicitObj?.name||(!ignoreSearchLocation?search.get('regionName'):null)||effectivePreset?.name||undefined,
      latitude:targetLat,
      longitude:targetLon,
      year:resolvedYear,
      ...(Number.isFinite(explicitObj?.shoreBearing)?{shoreBearing:Number(explicitObj.shoreBearing)}:{}),
      ...(placedX!==undefined?{x:placedX}:{}),
      ...(placedZ!==undefined?{z:placedZ}:{}),
    };
  if(bakedBoardPromise)registerBakedBoard(await bakedBoardPromise);
  const proceduralPack=useProcedural?generateProceduralCoastalPack(proceduralSpec,proceduralGridOpts):null;
  let preloaded1550=null;
  if(proceduralPack){
    if(autoCurated1550){
      try{
        const res=await runLandfallDiscoveryPipeline(proceduralPack,{snapToCoast:!options?.lateSpawn});
        if(res?.upgradedPack?.heights){
          preloaded1550=res;
          Object.assign(proceduralPack,res.upgradedPack);
        }
      }catch{/* fallback below */}
      // The pipeline leaves its base as ground and port alone. Had it failed past that, the land is dressed here.
      if(proceduralPack.heights)completeProceduralCoastalPack(proceduralPack);
    }
    if(!proceduralPack.heights){
      if(useRealDEM){
        await upgradeProceduralPackWithRealDEM(proceduralPack,{snapToCoast:!options?.lateSpawn});
      }else{
        Object.assign(proceduralPack,generateProceduralCoastalPack(proceduralPack.region,{...proceduralGridOpts,deferSynthesis:false}));
      }
    }
  }
  let activeRegion=proceduralPack?proceduralPack.region:ISLAND;
  // For tools and tests: the land as it was made. scripts/bake-board.mjs reads a port's ground from here.
  if(typeof window!=='undefined')window.oceanLand={get region(){return activeRegion;},get pack(){return proceduralPack;},get meadow(){return meadowGrass;}};
  const craterCoast=activeRegion.id??'saba',craterLedger=createLandCraterLedger(portDamage?.openGround(craterCoast),activeRegion);
  let craters=null;
  let heights,biome,nearTile=null,nearFailure=null,albedoImage=null;
  if(proceduralPack){
    heights=proceduralPack.heights;biome=proceduralPack.biome;
  }else{
    const nearDisabled=typeof location!=='undefined'&&search.get('nearTerrain')==='off';
    const heightBufPromise=load(ISLAND.assets.height).then(r=>r.arrayBuffer());
    const biomeBufPromise=load(ISLAND.assets.biome).then(r=>r.arrayBuffer());
    const albedoBitmapPromise=load(ISLAND.assets.albedo).then(r=>r.blob()).then(b=>createImageBitmap(b));albedoBitmapPromise.catch(()=>{});
    const baseManifestPromise=load('assets/world/saba/manifest.json').then(r=>r.json());
    const nearPromise=nearDisabled?Promise.resolve(null):Promise.all([heightBufPromise,baseManifestPromise]).then(([heightBuf,baseManifest])=>
      loadTerrainNear({baseManifest,baseHeights:decodeIsland(heightBuf)})).catch(error=>{nearFailure=error.message;return null;});
    const [heightBuf,biomeBuf]=await Promise.all([heightBufPromise,biomeBufPromise]);
    heights=decodeIsland(heightBuf);biome=decodeBiome(biomeBuf);
    nearTile=await nearPromise;
    albedoImage=await albedoBitmapPromise;
    if(albedoImage.width!==ISLAND.albedoSize||albedoImage.height!==ISLAND.albedoSize)throw new Error('Incomplete Saba imagery seed');
  }
  const loadedSections=new Map();
  const findNeighborSection=(x,z)=>{
    if(!proceduralPack||!loadedSections.size)return null;
    const sx=Math.round((x-activeRegion.x)/activeRegion.span);
    const sz=Math.round((z-activeRegion.z)/activeRegion.span);
    if(sx===0&&sz===0)return null;
    return loadedSections.get(`${sx},${sz}`)||null;
  };
  const clampToLoadedLandBorder=(x,z,sampleFn)=>{
    const h=sampleFn(heights,x,z,activeRegion);
    if(h>-119)return h;
    const half=activeRegion.span*0.5-1;
    const cx=Math.max(activeRegion.x-half,Math.min(activeRegion.x+half,x));
    const cz=Math.max(activeRegion.z-half,Math.min(activeRegion.z+half,z));
    if(Math.hypot(x-cx,z-cz)>250)return h;
    const edgeH=sampleFn(heights,cx,cz,activeRegion);
    return edgeH>-1.5?edgeH:h;
  };
  let inlandWaterSampler=createInlandWaterSampler(proceduralPack?.port?.country??null);
  const baseGroundSample=(x,z)=>{
    if(proceduralPack){
      const sec=findNeighborSection(x,z);
      return sec?terrainSurfaceSample(sec.heights,x,z,sec.region):clampToLoadedLandBorder(x,z,terrainSurfaceSample);
    }
    return sampleTerrainNear(nearTile,heights,x,z);
  };
  // What stands on the land itself, and so is stood on the ground the land draws (CONTINUUM_GROUNDED): at the ground's
  // own height on dry land; not on the sea's or an inland water's bed, a bridge's deck, or a quay or pier raised over it.
  const standsOnGround=(x,y,z)=>{
    const ground=baseGroundSample(x,z);
    return Number.isFinite(ground)&&ground>0&&y-ground<=GROUND_STANDING_M&&!inlandWaterSampler?.(x,z)&&!(bridgeDeckYAt(x,z,proceduralPack?.port?.country?.bridges)>0);
  };
  // A struck building's pieces and stump stand where it stood: a boulder on the ground, a city's waterside works never.
  const fractureGrounded=(instance,[x,y,z])=>Boolean(instance.boulder)||(!(instance.city&&CITY_TYPES_WATERSIDE.has(instance.city.type))&&standsOnGround(x,y,z));
  const archDeckSample=(x,z)=>{
    const sec=proceduralPack?findNeighborSection(x,z):null;
    const p=sec?.port??proceduralPack?.port;
    const bridge=bridgeDeckYAt(x,z,p?.country?.bridges);
    const wf=waterfrontDeckYAt(x,z,p?.waterfront);
    return Math.max(bridge>0?bridge:-Infinity,wf);
  };
  const groundSample=(x,z)=>{
    const base=baseGroundSample(x,z);
    const deck=archDeckSample(x,z);
    return deck>base?deck:base;
  };
  const heightSample=(x,z)=>{
    if(proceduralPack){
      const sec=findNeighborSection(x,z);
      if(sec)return terrainSample(sec.heights,x,z,sec.region);
      return clampToLoadedLandBorder(x,z,terrainSample);
    }
    return terrainNearSample(nearTile,x,z)??terrainSample(heights,x,z);
  };
  // A coast's mesh is not drawn (the land draws through the continuum); extract only the compact 1-float/grid-point
  // sand-kind array and immediately drop the 55+ MB CPU vertex/index buffers so mobile stays well below Jetsam limits.
  const landKind=(vertices,n)=>{const kind=new Float32Array(n*n);if(vertices)for(let k=0;k<n*n;k++)kind[k]=vertices[k*8+7];return kind;};
  let centerLandKind=proceduralPack?.mesh?.vertices?landKind(proceduralPack.mesh.vertices,activeRegion.size):null;
  if(proceduralPack)proceduralPack.mesh=null;
  if(preloaded1550?.upgradedPack)preloaded1550.upgradedPack.mesh=null;
  let groundPatches=createGroundCoverPatches(activeRegion,baseGroundSample,nearTile?(x,z,span)=>terrainNearPatchBounds(nearTile,x,z,span):null);
  const nearBitmapPromise=nearTile?createImageBitmap(new Blob([nearTile.albedo],{type:'image/png'})):null;
  nearBitmapPromise?.catch(()=>{});
  const buffer=(data,usage,label)=>{
    const b=device.createBuffer({size:Math.max(4,data.byteLength),usage:usage|GPUBufferUsage.COPY_DST,label});
    if(data.byteLength)device.queue.writeBuffer(b,0,data);return b;
  };
  // Buildings under fire draw from their own buffers, made when each is first hit.
  // A port set up for a side game is no part of the career: its damage is neither restored from the store nor kept in it.
  // A city's buildings are drawn through the one continuum (js/city-continuum-draw.js), and are no buildings of the
  // port until shot strikes one (js/city-targets.js). From then on it is one of the port's: its pieces are cut and
  // drawn by the port's fractures, and the continuum leaves it out.
  // Each type is built when shot first comes near one of its buildings, and kept.
  const cityCatalogue=[];
  const cityTypeCatalogue=(id)=>cityCatalogue[id]??=compileCityBuildingType(id,buildCityTypeGeometry);
  const cityTargetsFor=(city,port)=>city?.typedCount&&city.typedBlocks&&port&&search.get('cityTargets')!=='0'?createCityTargets({city,types:cityTypeCatalogue,port,onStruck:index=>cityBuildingHit(index)}):null;
  let activeCity=proceduralPack?.city??null,cityTargets=cityTargetsFor(activeCity,proceduralPack?.port);
  let cityContinuum=null,cityAim=null;
  // Buildings in pieces, and buildings shot has struck (cut finer from the first hit until the town stands them again).
  const cityStruckIndices=new Set(),cityHitIndices=new Set();
  const syncCollapsedBridges=(index,city,struck)=>{
    const bridges=proceduralPack?.port?.country?.bridges;
    if(!bridges?.length)return;
    const bx=city?.typed?.[index*CITY_TYPED_FLOATS],bz=city?.typed?.[index*CITY_TYPED_FLOATS+2];
    let changed=false;
    for(const b of bridges){
      if(!b)continue;
      const hit=b.cityIndices?.includes(index)||(Number.isFinite(bx)&&Number.isFinite(bz)&&Math.hypot(bx-b.x,bz-b.z)<=Math.max(10,(b.length||12)*0.65));
      if(!hit)continue;
      const collapsed=b.cityIndices?.length?b.cityIndices.some(i=>cityStruckIndices.has(i)):struck;
      if(b.collapsed!==collapsed){b.collapsed=collapsed;changed=true;}
    }
    if(changed)herds?.setBridges?.(bridges);
  };
  const cityBuildingStruck=instance=>{
    const index=instance.city?.index,city=activeCity;
    if(!(index>=0)||!city)return;
    cityTargets?.fractured(instance);
    cityStruckIndices.add(index);
    syncCollapsedBridges(index,city,true);
    // Its pentice, sign and ale-stake go with it.
    cityContinuum?.hide(index,1+(city.typedAttached?.[index]??0),true);
  };
  const cityBuildingHit=index=>{
    const city=activeCity;
    if(!(index>=0)||!city)return;
    cityHitIndices.add(index);
    cityContinuum?.strike(index,1+(city.typedAttached?.[index]??0),true);
  };
  const cityBuildingRebuilt=instance=>{
    const index=instance.city?.index,city=activeCity;
    if(cityHitIndices.delete(index)&&city)cityContinuum?.strike(index,1+(city.typedAttached?.[index]??0),false);
    if(!cityStruckIndices.delete(index)||!city)return;
    syncCollapsedBridges(index,city,false);
    cityContinuum?.hide(index,1+(city.typedAttached?.[index]??0),false);
  };
  // When the port's fractures are let go (another port stands in, or the coast is loaded again), the city stands whole.
  // Every building of a port is a city's (js/city-targets.js), drawn by the city's continuum: struck, it is cut finer
  // from its first hit; in pieces, the continuum leaves it out; stood again, it is drawn whole as before.
  const portBuildingHit=instance=>{if(instance.city)cityBuildingHit(instance.city.index);};
  const portBuildingStruck=instance=>{if(instance.city)cityBuildingStruck(instance);};
  const portBuildingRebuilt=instance=>{if(instance.city)cityBuildingRebuilt(instance);};
  // The cut's programs and the city's view, once made: a building shot down stands as its pieces through them.
  let fracturePrograms=null,fractureView=null;
  const fractureContinuum=()=>fracturePrograms&&fractureView?{programs:fracturePrograms,view:fractureView,frame:frameUBO,shadowUniform:activeLandShadows.uniform,samples}:null;
  const portFracturesFor=(port,targets=null)=>{
    if(!port||!targets)return null;
    const damageStore=port.transient?null:portDamage;
    // A save names the city's struck buildings; they are stood first, so that their records find them.
    if(targets&&damageStore)targets.revive(damageStore.recorded(port));
    damageStore?.restore(port);
    return createPortFractures({device,port,groundAt:(x,z)=>heightSample(x,z),waterAt:(x,z)=>inlandWaterSampler?.(x,z)?.wy??null,damageStore,continuum:fractureContinuum,grounded:fractureGrounded,
      onStruck:portBuildingHit,onFractured:portBuildingStruck,onRebuilt:portBuildingRebuilt});
  };
  let portFractures=portFracturesFor(proceduralPack?.port,cityTargets);
  let transientBoulderPort=null;
  const ensureBoulderFracturePort=()=>{
    const targetPort=proceduralPack?(proceduralPack.port??=(transientBoulderPort={regionId:activeRegion.id??'coast',name:activeRegion.name??'Coast',instances:[],transient:true})):(transientBoulderPort??={regionId:activeRegion.id??'saba',name:activeRegion.name??'Saba',instances:[],transient:true});
    portFractures??=createPortFractures({device,port:targetPort,groundAt:(x,z)=>heightSample(x,z),waterAt:(x,z)=>inlandWaterSampler?.(x,z)?.wy??null,damageStore:targetPort.transient?null:portDamage,continuum:fractureContinuum,grounded:fractureGrounded,
      onStruck:portBuildingHit,onFractured:portBuildingStruck,onRebuilt:portBuildingRebuilt});
    return targetPort;
  };
  const regionalElevationSize=!nearTile&&proceduralPack?257:0;
  const regionalElevationData=regionalElevationSize?new Float32Array(regionalElevationSize*regionalElevationSize):null;
  const worldOffset={x:0,z:0};
  const nearDomainValues=()=>nearTile
    ?[nearTile.manifest.domain.x,nearTile.manifest.domain.z,nearTile.manifest.domain.span,1,nearTile.manifest.domain.size,worldOffset.x,worldOffset.z,0]
    :regionalElevationSize
    ?[activeRegion.x,activeRegion.z,activeRegion.span*5,-1,regionalElevationSize,worldOffset.x,worldOffset.z,0]
    :[0,0,1,0,1,worldOffset.x,worldOffset.z,0];
  const nearDomain=buffer(new Float32Array(nearDomainValues()),GPUBufferUsage.UNIFORM,'Wells Bay near domain');
  // Four exact height loads from immutable storage avoid consuming another
  // sampled-texture slot in the already texture-heavy ocean fragment stage.
  const nearElevation=buffer(nearTile?.heights??regionalElevationData??new Float32Array([-120]),GPUBufferUsage.STORAGE,'Wells Bay immutable near elevation');
  // Upgrades, climate and streamed sections can all finish after the pack has been disposed.
  let terrainDisposed=false;
  function writeNearDomainUniform(){
    if(terrainDisposed)return;
    device.queue.writeBuffer(nearDomain,0,new Float32Array(nearDomainValues()));
  }
  function updateRegionalElevationGrid(){
    if(terrainDisposed||!regionalElevationData||!regionalElevationSize)return;
    const regSpan=activeRegion.span*5;
    const x0=activeRegion.x-regSpan*0.5;
    const z0=activeRegion.z-regSpan*0.5;
    const inv=regSpan/(regionalElevationSize-1);
    for(let j=0;j<regionalElevationSize;j++){
      const z=z0+j*inv;
      const row=j*regionalElevationSize;
      for(let i=0;i<regionalElevationSize;i++){
        regionalElevationData[row+i]=heightSample(x0+i*inv,z);
      }
    }
    writeNearDomainUniform();
    device.queue.writeBuffer(nearElevation,0,regionalElevationData);
    coastalField?.invalidate();
  }
  let coastalField=null;
  updateRegionalElevationGrid();
  const uniform=buffer(new Float32Array([activeRegion.x,activeRegion.z,activeRegion.span,proceduralPack?0.22:1]),GPUBufferUsage.UNIFORM,'land domain');
  const elevation=device.createTexture({label:'island elevation',size:[activeRegion.size,activeRegion.size],format:'r32float',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
  device.queue.writeTexture({texture:elevation},heights,{bytesPerRow:activeRegion.size*4},[activeRegion.size,activeRegion.size]);
  coastalField=await createCoastalField({device,computePipe,frameUBO,land:uniform,elevationView:elevation.createView(),nearDomain,nearElevation});
  coastalField.setClarity(coastalClarity(activeRegion.latitude??0,activeRegion.coastalArchetype));
  const lighting=device.createTexture({label:'island sunlight',size:[64,64],format:'rgba16float',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.STORAGE_BINDING});
  const albedoMips=1+Math.log2(activeRegion.albedoSize);
  const albedo=device.createTexture({label:'registered island imagery seed',size:[activeRegion.albedoSize,activeRegion.albedoSize],format:'rgba8unorm',mipLevelCount:albedoMips,
    usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.COPY_DST|GPUTextureUsage.RENDER_ATTACHMENT});
  if(proceduralPack){
    device.queue.writeTexture({texture:albedo},proceduralPack.albedo,{bytesPerRow:activeRegion.albedoSize*4},[activeRegion.albedoSize,activeRegion.albedoSize]);
  }else{
    device.queue.copyExternalImageToTexture({source:albedoImage},{texture:albedo},[ISLAND.albedoSize,ISLAND.albedoSize]);albedoImage.close();
  }
  // What a board's people have made of this ground, stamped over its own colours before they are filtered down.
  let boardStamp=proceduralPack?.board?await createBoardStamp({device,shader,board:proceduralPack.board}):null;
  boardStamp?.stamp(albedo,activeRegion.albedoSize);
  mipPipe=await mipPipePromise;
  const enc=device.createCommandEncoder(),cp=enc.beginComputePass();cp.setPipeline(mipPipe);
  for(let m=1;m<albedoMips;m++){
    cp.setBindGroup(0,device.createBindGroup({layout:mipPipe.getBindGroupLayout(0),entries:[
      {binding:0,resource:albedo.createView({baseMipLevel:m-1,mipLevelCount:1})},{binding:1,resource:albedo.createView({baseMipLevel:m,mipLevelCount:1})}]}));
    cp.dispatchWorkgroups(Math.ceil((activeRegion.albedoSize>>m)/8),Math.ceil((activeRegion.albedoSize>>m)/8));
  }
  cp.end();device.queue.submit([enc.finish()]);
  const groundDetail=await sharedGroundDetail({device,computePipe,mipPipe});
  let nearAlbedo=albedo;
  if(nearTile){
    const image=await nearBitmapPromise;
    if(image.width!==1024||image.height!==1024)throw Error('Incomplete Wells Bay near imagery');
    nearAlbedo=device.createTexture({label:'Wells Bay registered near imagery',size:[1024,1024],format:'rgba8unorm',mipLevelCount:11,
      usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.COPY_DST|GPUTextureUsage.RENDER_ATTACHMENT});
    device.queue.copyExternalImageToTexture({source:image},{texture:nearAlbedo},[1024,1024]);image.close();
    const encoder=device.createCommandEncoder(),pass=encoder.beginComputePass();pass.setPipeline(mipPipe);
    for(let m=1;m<11;m++){
      pass.setBindGroup(0,device.createBindGroup({layout:mipPipe.getBindGroupLayout(0),entries:[
        {binding:0,resource:nearAlbedo.createView({baseMipLevel:m-1,mipLevelCount:1})},{binding:1,resource:nearAlbedo.createView({baseMipLevel:m,mipLevelCount:1})}]}));
      pass.dispatchWorkgroups(Math.ceil((1024>>m)/8),Math.ceil((1024>>m)/8));
    }
    pass.end();device.queue.submit([encoder.finish()]);
  }
  const biomeTexture=device.createTexture({label:'regional vegetation probability',size:[activeRegion.biomeSize,activeRegion.biomeSize],format:'r8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
  device.queue.writeTexture({texture:biomeTexture},biome,{bytesPerRow:activeRegion.biomeSize},[activeRegion.biomeSize,activeRegion.biomeSize]);
  const landSampler=device.createSampler({minFilter:'linear',magFilter:'linear',mipmapFilter:'linear',addressModeU:'clamp-to-edge',addressModeV:'clamp-to-edge',maxAnisotropy:4});
  const [lightPipe,cityView,landPipe]=await terrainPipesPromise;
  const cityPipe=cityView.pipeline;
  fractureView=cityView;
  requestContinuumPrograms({device,shader,shadowFormat:activeLandShadows.format}).then(programs=>{fracturePrograms=programs;},error=>console.error('struck buildings continuum',error));
  // A block of slots a ground-cover patch: its rocks, drawn by the boulder continuum.
  const groundBlock=GROUND_COVER.rocksPerPatch;
  const groundBlocks=Math.ceil(Math.PI*(GROUND_RESIDENT_M*GROUND_RESIDENT_RELEASE/GROUND_COVER.patchSpan+1)**2);
  let boulderContinuum=null;
  const groundStats={patches:groundPatches.length,resident:0};
  const groundResident=new Map(),groundFreeBlocks=Array.from({length:groundBlocks},(_,block)=>block);
  let groundWanted=[],groundResidencyAt=null;
  function clearGroundResidency(){
    for(const block of groundResident.values()){boulderContinuum?.clearSlots(block*groundBlock,groundBlock);groundFreeBlocks.push(block);}
    groundResident.clear();groundWanted=[];groundResidencyAt=null;groundStats.resident=0;
  }
  let boulderBlockCacheCity=null,boulderBlockCacheFn=null;
  const getBoulderBlockTester=()=>{
    const cityObj=proceduralPack?.port?.city??null;
    if(cityObj===boulderBlockCacheCity)return boulderBlockCacheFn;
    boulderBlockCacheCity=cityObj;
    const bl=cityObj?.blocks;
    if(!bl?.length){boulderBlockCacheFn=null;return null;}
    const pad=12.0,cellM=32,grid=new Map(),keyOf=(i,j)=>(i+32768)*65536+(j+32768);
    for(let b=0;b<bl.length;b+=CITY_BLOCK_FLOATS){
      const bx=bl[b],bz=bl[b+2],yaw=bl[b+3],hw=bl[b+4]*0.5+pad,hd=bl[b+5]*0.5+pad,reach=Math.hypot(hw,hd);
      const entry={bx,bz,c:Math.cos(yaw),s:Math.sin(yaw),hw,hd};
      for(let j=Math.floor((bz-reach)/cellM);j<=Math.floor((bz+reach)/cellM);j++){
        for(let i=Math.floor((bx-reach)/cellM);i<=Math.floor((bx+reach)/cellM);i++){
          const k=keyOf(i,j);let list=grid.get(k);if(!list)grid.set(k,list=[]);list.push(entry);
        }
      }
    }
    boulderBlockCacheFn=(px,pz)=>{
      const list=grid.get(keyOf(Math.floor(px/cellM),Math.floor(pz/cellM)));
      if(!list)return false;
      for(let m=0;m<list.length;m++){
        const e=list[m],dx=px-e.bx,dz=pz-e.bz;
        if(Math.abs(dx*e.c-dz*e.s)<=e.hw&&Math.abs(dx*e.s+dz*e.c)<=e.hd)return true;
      }
      return false;
    };
    return boulderBlockCacheFn;
  };
  // Instances are worked out once per patch and uploaded as it comes into range; the GPU does the rest.
  function updateGroundResidency(camera){
    if(!boulderContinuum){groundStats.resident=0;return;}
    const moved=!groundResidencyAt||Math.hypot(camera.x-groundResidencyAt.x,camera.z-groundResidencyAt.z)>GROUND_RESIDENCY_MOVE_M;
    if(moved){
      groundResidencyAt={x:camera.x,z:camera.z};
      const distanceOf=patch=>Math.hypot(patch.centre[0]-camera.x,patch.centre[2]-camera.z);
      for(const [patch,block] of groundResident)if(distanceOf(patch)>GROUND_RESIDENT_M*GROUND_RESIDENT_RELEASE){
        boulderContinuum?.clearSlots(block*groundBlock,groundBlock);groundFreeBlocks.push(block);groundResident.delete(patch);
      }
      groundWanted=groundPatches.filter(patch=>!groundResident.has(patch)&&distanceOf(patch)<GROUND_RESIDENT_M).sort((a,b)=>distanceOf(b)-distanceOf(a));
    }
    const boulderCityBlock=getBoulderBlockTester();
    const boulderTown=proceduralPack?.port?.country?.town;
    const boulderTownR=boulderTown?.radius>0?boulderTown.radius+24:0;
    const streetWin=proceduralPack?.port?.streets?.window;
    const mayPlaceBoulder=(x,z)=>{
      if(streetWin&&Math.abs(x-streetWin.x)<=streetWin.span*0.52&&Math.abs(z-streetWin.z)<=streetWin.span*0.52)return false;
      if(streetEdgeAt(proceduralPack?.port?.streets,x,z)<Math.max(GROUND_COVER_STREET_GAP_M,12.0))return false;
      if(boulderCityBlock?.(x,z))return false;
      if(boulderTownR>0&&Math.hypot(x-boulderTown.x,z-boulderTown.z)<boulderTownR)return false;
      return !inlandWaterSampler?.(x,z);
    };
    for(let i=0;i<GROUND_PATCHES_PER_FRAME&&groundWanted.length&&groundFreeBlocks.length;i++){
      const patch=groundWanted.pop(),block=groundFreeBlocks.pop(),perVariant=groundCoverInstances(patch,baseGroundSample,mayPlaceBoulder);
      const floats=new Float32Array(groundBlock*8),slotGroups=new Uint32Array(groundBlock).fill(0xffffffff);let slot=0;
      perVariant.forEach((data,variant)=>{for(let k=0;k<data.length;k+=8){floats.set(data.subarray(k,k+8),slot*8);slotGroups[slot++]=variant;}});
      boulderContinuum?.setInstances(block*groundBlock,floats,slotGroups);
      groundResident.set(patch,block);
    }
    groundStats.resident=groundResident.size;
  }
  let lastCamera=null,lastView=null;
  // Where the player stood when the forest's sections were last held, and how many were let go for want of room
  // (retargetForestPackToProcedural): those are taken back as the player nears them.
  const forestOwner={};
  let forestNear=null,forestHeldAt=null,forestSectionsReleased=0;
  let checkPlayerFrontierEntry=null;
  const retireGPU=(fn)=>{if(typeof device.queue?.onSubmittedWorkDone==='function')device.queue.onSubmittedWorkDone().then(fn).catch(()=>{});else fn();};
  function updateTrees(camera,viewProjection,allowStream=false){
    if(allowStream)checkPlayerFrontierEntry?.(camera);
    updateGroundResidency(camera);
    const localCam = {x:camera.x-worldOffset.x,z:camera.z-worldOffset.z};
    if(Number.isFinite(localCam.x)&&Number.isFinite(localCam.z)){
      forestNear=localCam;
      if(forestSectionsReleased>0&&forestHeldAt&&Math.hypot(localCam.x-forestHeldAt.x,localCam.z-forestHeldAt.z)>(activeRegion.span??8192)*0.25)rebuildNeighborTreeInstances();
    }
    craters?.follow(localCam);
    activeTownField?.follow?.(localCam);
    lastCamera=camera;lastView=viewProjection;
    if(forest)pressTrees(camera);
  }
  // What presses into the trees as the frame begins (js/forest-scenery.js setPushers), in the roots' frame: the walker
  // ashore, brushing through low boughs from the knee to the head, and the hulls passing close to a bank, each from
  // its bow to its stern about its waterline. Passing shot is set with the projectiles (setBallisticProjectiles).
  function pressTrees(camera){
    const walker=[];
    if(camera.onFoot&&Number.isFinite(camera.playerX)&&Number.isFinite(camera.playerZ)){
      const x=camera.playerX-worldOffset.x,z=camera.playerZ-worldOffset.z,y=groundSample(x,z);
      if(Number.isFinite(y))walker.push({a:[x,y+.25,z],b:[x,y+1.85,z],radius:1.45,push:1150,power:1.6});
    }
    forest.setPushers('walker',walker);
    const hulls=[];
    for(const hull of camera.hulls??[]){
      if(hulls.length>=6)break;
      const x=hull.x-worldOffset.x,z=hull.z-worldOffset.z,half=Math.max(4,hull.length??20)*.42,h=hull.heading??0;
      if(!Number.isFinite(x+z+half+h))continue;
      const fx=Math.sin(h)*half,fz=-Math.cos(h)*half,y=(hull.heave??0)+1.2;
      hulls.push({a:[x+fx,y,z+fz],b:[x-fx,y,z-fz],radius:Math.max(2,(hull.beam??6)*.5+1.5),push:6000,power:1.2});
    }
    forest.setPushers('hull',hulls);
  }
  const LAND_BIND_IDS=new Set([0,1,2,3,4,5,6,7,8,9,12,13,14,15,16,17,19,20,21,22,23,24]);
  const CITY_BIND_IDS=new Set([0,1,2,3,4,5,6,8,13,17,18,19,20,21,22,23,24]);
  const landEntries=entries=>entries.filter(([b])=>LAND_BIND_IDS.has(b));
  const cityEntries=entries=>entries.filter(([b])=>CITY_BIND_IDS.has(b));
  const bind=(pipe,entries)=>device.createBindGroup({layout:pipe.getBindGroupLayout(0),entries:entries.map(([binding,resource])=>({binding,resource}))});
  const resources=[[0,{buffer:frameUBO}],[1,transView],[2,skyView],[3,sampler],[4,envCubeView],[5,lighting.createView()],[6,{buffer:uniform}],[7,albedo.createView()],[8,landSampler],[9,biomeTexture.createView()],...activeLandShadows.terrainResources];
  // Every building of a city, cut and drawn through the one continuum from the atlas baked for every type
  // (js/city-continuum-draw.js). The atlas and the cut's programs are asked for once a coast has a city. Those
  // shot down stand as pieces (js/building-fracture.js) and are left out.
  let cityContinuumMade=0,cityCardAtlas=null,cityCardKey='',cityCardRenderer=null,cityCardBindings=null;
  // Which of a city's buildings stand on the land: all but its waterside works, by standsOnGround, and what hangs from a
  // building as that building does.
  const cityGrounded=city=>{
    const grounded=new Uint8Array(city.typedCount),attached=city.typedAttached;
    for(let i=0;i<city.typedCount;){
      const at=i*CITY_TYPED_FLOATS,stands=!CITY_TYPES_WATERSIDE.has(city.typedTypes[i])&&standsOnGround(city.typed[at],city.typed[at+1],city.typed[at+2]);
      const n=1+(attached?.[i]??0);
      grounded.fill(stands?1:0,i,Math.min(city.typedCount,i+n));
      i+=n;
    }
    return grounded;
  };
  const setCityBuildings=async pack=>{
    const made=++cityContinuumMade;
    const old=cityContinuum;cityContinuum=null;if(old)retireGPU(()=>old.destroy());
    const city=pack?.city;
    if(!city?.typedCount){
      const oldCards=cityCardAtlas;cityCardAtlas=null;cityCardKey='';
      if(oldCards)retireGPU(()=>oldCards.destroy());
      return;
    }
    const [atlas,programs]=await Promise.all([requestCityContinuumAtlas(device),requestContinuumPrograms({device,shader,shadowFormat:activeLandShadows.format})]);
    if(made!==cityContinuumMade||terrainDisposed)return;
    cityContinuum=createCityContinuum({device,atlas,programs,view:cityView,typed:city.typed,types:city.typedTypes,grounded:cityGrounded(city),frame:frameUBO,shadowUniform:activeLandShadows.uniform,samples,label:'city',profile:'city'});
    cityContinuum.setWorldOffset(worldOffset.x,worldOffset.z);
    for(const index of cityStruckIndices)cityContinuum.hide(index,1+(city.typedAttached?.[index]??0),true);
    for(const index of cityHitIndices)cityContinuum.strike(index,1+(city.typedAttached?.[index]??0),true);
    cityContinuum.setAim(cityAim);
    // Bake relightable octahedral G-buffer cards for the unique building types placed in this city (reusing cached atlas if unchanged).
    const counts=new Map();
    for(let i=0;i<city.typedTypes.length;i++){const t=city.typedTypes[i];counts.set(t,(counts.get(t)??0)+1);}
    const placedTypes=[...counts.entries()].sort((a,b)=>b[1]-a[1]).map(([t])=>t);
    const nextKey=placedTypes.join(',');
    const targetScene=cityContinuum;
    if(cityCardAtlas&&cityCardKey===nextKey&&cityCardRenderer&&cityCardBindings){
      targetScene.setCards(cityCardAtlas,cityCardRenderer,cityCardBindings);
      return;
    }
    const oldCards=cityCardAtlas;cityCardAtlas=null;cityCardKey='';
    if(oldCards)retireGPU(()=>oldCards.destroy());
    Promise.all([cloudsResolvedPromise,requestContinuumCardRenderer({device,shader,format,samples,pages:atlas.pages.length})]).then(async([resolvedClouds,cardRenderer])=>{
      if(made!==cityContinuumMade||terrainDisposed||!resolvedClouds)return;
      const archSamp=groundDetail.resources.find(([b])=>b===17)?.[1];
      if(!archSamp||!groundDetail.archTextureView)return;
      const bakeGroup0Entries=[
        {binding:0,resource:archSamp},
        {binding:1,resource:groundDetail.archTextureView},
        {binding:2,resource:landSampler},
        {binding:3,resource:nearAlbedo.createView()},
      ];
      // Keep crisp 64x64 texels per view for windows/gables/tiles; mobile uses 32x32 and dense cities (>96 types) use 4x4 grid so VRAM stays lean.
      const cellSize=isMobile?32:64;
      const gridSize=placedTypes.length>96?4:6;
      const baked=await bakeContinuumCardAtlas({
        device,shader,renderer:cardRenderer,atlas,material:cityView.material,
        typeIds:placedTypes,bakeGroup0Entries,cellSize,gridSize,tintMode:CONTINUUM_CARD_TINT_CITY,salt:1,
        aboveGround:true,batchSize:8,isCancelled:()=>made!==cityContinuumMade||terrainDisposed,label:'city cards',
      });
      if(!baked)return;
      if(made!==cityContinuumMade||terrainDisposed){baked.destroy();return;}
      const cardBindings=createContinuumCardSceneBindings({device,renderer:cardRenderer,resources,clouds:resolvedClouds});
      cityCardAtlas=baked;cityCardKey=nextKey;cityCardRenderer=cardRenderer;cityCardBindings=cardBindings;
      targetScene.setCards(baked,cardRenderer,cardBindings);
    }).catch(error=>console.error('City octahedral card bake failed:',error));
  };
  // The coast is not presented until its city has landed.
  await setCityBuildings(proceduralPack);
  clouds=await cloudsResolvedPromise;waterOptics=await waterOpticsResolvedPromise;
  // Stream the 62 MiB forest continuum + 112k root placement asynchronously right after Frame 0 so initial load
  // reveals the harbor, ships, terrain and city immediately while trees stream in cleanly behind it.
  let forestPack=null,grovePack=null,forest=null;
  const streamMaxRoots=isMobile?22000:112000;
  const rootCapacity=forestRootCapacity(device);
  const forestStrikeKey=activeRegion.id??`${activeRegion.latitude},${activeRegion.longitude}`;
  const forestHeld=pack=>({roots:pack?.manifest?.rootCount??0,groveRoots:pack?.groveRoots??0,sections:pack?.sectionsResident??0,released:pack?.sectionsReleased??0});
  const forestStats={loaded:false,mode:canopyMode,error:forestFailure,groves:{loaded:false,error:groveFailure},coverage:null};
  const mobilePause=ms=>isMobile?new Promise(r=>setTimeout(r,ms)):Promise.resolve();
  // The forest's trees as the meadow reads them, for the litter under them (js/meadow-crops.js), and the game's date
  // for the season its crops and litter follow.
  const meadowTreesOf=pack=>pack?.sections?{sections:pack.sections,prototypes:pack.manifest?.prototypes??[]}:null;
  let meadowTrees=null,meadowDateMs=null;
  const forestReadyPromise=(async()=>{
    if(sceneryGate)await sceneryGate;
    if(terrainDisposed)return null;
    forestPack=await (forestPromise??startForestLoad());
    if(terrainDisposed)return null;
    grovePack=forestPack&&proceduralPack?await (grovePromise??startGroveLoad()):null;
    if(terrainDisposed)return null;
    const activeForestPack=proceduralPack&&forestPack?retargetForestPackToProcedural(forestPack,proceduralPack,baseGroundSample,{isMobile,maxRootCapacity:streamMaxRoots,climateProfile:activeClimate,stand:grovePack,rootCapacity,near:forestNear,owner:forestOwner}):forestPack;
    const made=activeForestPack?await createForestRenderer({device,shader,frameUBO,resources,clouds,format,samples,shadowFormat:activeLandShadows.format,terrainSource:TERRAIN_FINISH_ONLY,pack:activeForestPack,groundSample:proceduralPack?null:groundSample,savedStrikes:portDamage?.forestStrikes?.(forestStrikeKey)??null,strikeOrigin:{x:activeRegion.x??0,z:activeRegion.z??0},onStrikesChanged:trees=>portDamage?.setForestStrikes?.(forestStrikeKey,trees),isMobile}).catch(error=>{forestFailure=error.message;console.error('forest continuum',error);return null;}):null;
    if(terrainDisposed){made?.destroy?.();return null;}
    forest=made;
    if(forest)meadowTrees=meadowTreesOf(activeForestPack);
    if(forest?.stats)Object.assign(forestStats,forest.stats);
    forestStats.error=forestFailure;
    forestStats.groves=grovePack?{loaded:true,...forestHeld(activeForestPack),rootCapacity}:{loaded:false,error:groveFailure};
    forestStats.coverage=forestPack?.manifest.coverage??null;
    if(forest){forestSectionsReleased=activeForestPack?.sectionsReleased??0;forestHeldAt=forestNear??activeRegion;forest.setWorldOffset?.(worldOffset.x,worldOffset.z);}
    return forest;
  })();
  // The town's ways as a distance field. A coast without a town binds an empty one.
  const townField=streets=>{
    const size=streets?.size??1;
    const texture=device.createTexture({label:'town ways',size:[size,size],format:'rg8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
    device.queue.writeTexture({texture},streets?.field??new Uint8Array([255,0]),{bytesPerRow:size*2},[size,size]);
    const window=buffer(new Float32Array(streets?[streets.window.x,streets.window.z,streets.window.span,0]:[0,0,0,0]),GPUBufferUsage.UNIFORM,'town ways window');
    let lastX=streets?.window?.x??NaN,lastZ=streets?.window?.z??NaN;
    const follow=pt=>{
      if(!streets?.stampAt||!pt||!Number.isFinite(pt.x)||!Number.isFinite(pt.z))return;
      if(Math.hypot(pt.x-lastX,pt.z-lastZ)<240)return;
      lastX=pt.x;lastZ=pt.z;
      if(streets.stampAt(pt.x,pt.z)){
        device.queue.writeTexture({texture},streets.field,{bytesPerRow:size*2},[size,size]);
        device.queue.writeBuffer(window,0,new Float32Array([streets.window.x,streets.window.z,streets.window.span,0]));
      }
    };
    return {texture,window,resources:[[14,texture.createView()],[15,{buffer:window}]],follow};
  };
  let activeTownField=townField(proceduralPack?.port?.streets);
  let nearResources=[...resources,[12,{buffer:nearDomain}],[13,nearAlbedo.createView()],...activeTownField.resources,...groundDetail.resources,...neuralPbr.terrainResources];
  let cityGroup=bind(cityPipe,cityEntries(nearResources));const cityClouds=clouds.bindVolume(cityPipe,'shadow');
  const [submerged,citySubmerged]=await submergedPipesPromise;
  let submergedGroup=submerged?.bindGroup(landEntries(nearResources).map(([binding,resource])=>({binding,resource})));
  const submergedClouds=submerged?clouds.bindVolume(submerged.pipeline,'shadow'):null;
  let citySubmergedGroup=citySubmerged?.bindGroup(cityEntries(nearResources).map(([binding,resource])=>({binding,resource})));
  const citySubmergedClouds=citySubmerged?clouds.bindVolume(citySubmerged.pipeline,'shadow'):null;
  // The land: every piece cut and drawn through the one continuum (js/land-continuum.js, AGENTS.md rule 3). A piece is
  // the coast's own lattice ('0,0'; on Saba with the surveyed bay as a finer window in it) or a streamed section. One
  // is baked when it comes or its ground or a neighbour's changes, one a frame and the nearest first; every frame the
  // GPU cuts them all at the scene's one pixel error. Height queries go on reading the lattices themselves.
  const landSpecs=new Map(),landDirty=new Set();
  let landContinuum=null,landClouds=null,landOrder=0;
  // Every piece on one grid, so that two place a shared point alike: a section is 1024 units across.
  const landGridFor=()=>proceduralPack
    ?{x0:activeRegion.x-activeRegion.span/2,z0:activeRegion.z-activeRegion.span/2,g:activeRegion.span/1024}
    :{x0:ISLAND.x-ISLAND.span/2,z0:ISLAND.z-ISLAND.span/2,g:nearTile?nearTile.manifest.domain.spacing:2};
  let landGrid=landGridFor();
  // Saba's surveyed bay: a lattice at the survey's own spacing over the island's patches that hold it, the island's
  // own surface round the survey. Kind 1 inside it, and how far the survey trusts each point.
  function landSabaWindow(cell){
    const {spacing,size}=nearTile.manifest.domain,b=nearTile.bounds,g=landGrid.g,along=cell*16;
    const unit=(v,origin)=>(v-origin)/g;
    const gx0=Math.floor(unit(b[0],landGrid.x0)/along)*along,gz0=Math.floor(unit(b[2],landGrid.z0)/along)*along;
    const side=Math.max(Math.ceil(unit(b[1],landGrid.x0)/along)*along-gx0,Math.ceil(unit(b[3],landGrid.z0)/along)*along-gz0);
    const n=side*g/spacing+1,heightsOut=new Float32Array(n*n),kind=new Float32Array(n*n);
    for(let j=0;j<n;j++)for(let i=0;i<n;i++){
      const x=landGrid.x0+(gx0+i)*g,z=landGrid.z0+(gz0+j)*g,k=j*n+i;
      const surveyed=terrainNearSample(nearTile,x,z);
      heightsOut[k]=surveyed??terrainSurfaceSample(heights,x,z);
      if(surveyed!==null)kind[k]=1-nearTile.measured[Math.round((z-b[2])/spacing)*size+Math.round((x-b[0])/spacing)];
    }
    return {n,cell:spacing/g,gx:gx0,gz:gz0,heights:heightsOut,kind};
  }
  const landCentreSpec=()=>{
    const land=()=>bind(landPipe,landEntries(nearResources)),captureLand=()=>submergedGroup??null;
    if(!proceduralPack){
      const cell=ISLAND.span/(ISLAND.size-1)/landGrid.g;
      return {sx:0,sz:0,n:ISLAND.size,cell,heights,kind:null,authority:3,window:nearTile?landSabaWindow(cell):null,near:nearTile?[...nearTile.bounds]:null,land,captureLand};
    }
    const n=activeRegion.size;
    return {sx:0,sz:0,n,cell:1024/(n-1),heights,kind:centerLandKind,authority:3,window:null,near:null,land,captureLand};
  };
  const landSectionSpec=rec=>{
    const n=Math.round(Math.sqrt(rec.heights.length));
    return {sx:rec.secX,sz:rec.secZ,n,cell:1024/(n-1),heights:rec.heights,kind:rec.landKind??landKind(rec.meshVertsCpu,n),authority:rec.isMock?1:2,window:null,near:null,land:()=>rec.landGroup,captureLand:()=>rec.submergedGroup??null};
  };
  // A piece new, changed or gone (null): it and the neighbours whose shared edges follow it are baked again. Until
  // then it draws its old ground with its new textures, since the old ones go; one gone goes at once.
  function landPiece(key,spec){
    if(spec){landSpecs.set(key,{...spec,order:landSpecs.get(key)?.order??landOrder++});landContinuum?.rebind(key,spec.land(),spec.captureLand());}
    else{landSpecs.delete(key);landContinuum?.remove(key);}
    const [sx,sz]=key.split(',').map(Number);
    for(let dz=-1;dz<=1;dz++)for(let dx=-1;dx<=1;dx++){const near=`${sx+dx},${sz+dz}`;if(near===key||landSpecs.has(near))landDirty.add(near);}
  }
  // What lies on the lattice finer than it, as the land's cut keeps it: every pit shot has dug and the coast's river
  // banks, the same figures the GPU reads (landCraterWaits, landBankWaits).
  function landBake(key){
    const spec=landSpecs.get(key);
    if(!spec){landContinuum.remove(key);return;}
    const seam=spec.window?null:landContinuumSeams(landSpecs,key);
    const baked=bakeLandContinuumPiece({n:spec.n,cell:spec.cell,heights:seam?seam.heights:spec.heights,kind:spec.kind,window:spec.window,
      gx:spec.sx*1024,gz:spec.sz*1024,edges:seam?.edges,grid:landGrid,marks:[...craterLedger.records.map(landCraterMark),...(landBanks.mark?[landBanks.mark]:[])]});
    landContinuum.set(key,baked,{gx:spec.sx*1024,gz:spec.sz*1024,land:spec.land(),captureLand:spec.captureLand(),near:spec.near});
  }
  // One piece a frame, the nearest the camera first.
  function landFlush(){
    if(!landContinuum||!landDirty.size)return;
    const cam=lastCamera?{x:lastCamera.x-worldOffset.x,z:lastCamera.z-worldOffset.z}:{x:activeRegion.x,z:activeRegion.z};
    const away=key=>{const [sx,sz]=key.split(',').map(Number);return Math.hypot(activeRegion.x+sx*activeRegion.span-cam.x,activeRegion.z+sz*activeRegion.span-cam.z);};
    const key=[...landDirty].sort((a,b)=>away(a)-away(b))[0];
    landDirty.delete(key);landBake(key);
  }
  // A coast's river banks, which the board meshes finer than the lattice (riverCut), laid into the land with its centre.
  const landBanks=createLandBanks({device});
  // `riverCut` the coast's own port's, whichever port stands on it.
  function landCentre(riverCut){
    landBanks.set(riverCut,activeRegion,baseGroundSample);
    landPiece('0,0',landCentreSpec());
  }
  landCentre(proceduralPack?.port?.riverCut);
  const lightGroup=bind(lightPipe,[[0,{buffer:frameUBO}],[4,elevation.createView()],[5,lighting.createView()],[6,{buffer:uniform}],[7,{buffer:nearDomain}],[8,{buffer:nearElevation}]]);
  // Build fractured boulders, inland water, herds, and trade vessels in parallel.
  let boulderCardAtlas=null;
  let herds=null;
  const startHerds=()=>proceduralPack?createLivestockHerds({device,shader,format,samples,frameUBO,landUniform:uniform,nearDomain,elevation,landShadowUniform:activeLandShadows.uniform,resources:nearResources,clouds,initialHerds:proceduralPack.herds??null,initialBridges:proceduralPack.port?.country?.bridges??null,isMobile}).then(h=>{
    if(terrainDisposed){h?.destroy?.();return null;}
    herds=h;
    return herds;
  }).catch(error=>{console.error('livestock herds',error);return null;}):Promise.resolve(null);
  let pendingTradeSharedCrew=options?.sharedCrew??null;
  const startTradeVessels=()=>proceduralPack?createTradeVessels({device,format,samples,shader,computePipe,oceanBridge,resources:nearResources,clouds,shadowFormat:activeLandShadows.format,sharedCrew:pendingTradeSharedCrew,submerged:submerged??null,isMobile}).then(tv=>{
    if(terrainDisposed){tv?.destroy?.();return null;}
    tradeVessels=tv;
    if(tradeVessels&&pendingTradeSharedCrew)tradeVessels.setSharedCrew?.(pendingTradeSharedCrew);
    if(tradeVessels&&proceduralPack?.port?.country?.board){
      tradeVessels.setTraffic(null,activeRegion,proceduralPack.port.country.riverReaches??[],proceduralPack.port.country.places??[],{heights,region:activeRegion,port:proceduralPack.port,bridges:proceduralPack.port.country.bridges??[],inlandWaterAt:(wx,wz)=>inlandWaterSampler?inlandWaterSampler(wx,wz):null});
    }
    return tradeVessels;
  }).catch(error=>{console.error('trade vessels',error);return null;}):Promise.resolve(null);
  let tradeVessels=null;
  const [boulderRes, inlandWaterRes] = await Promise.all([
    Promise.all([requestBoulderContinuumAtlas(device),requestContinuumPrograms({device,shader,shadowFormat:activeLandShadows.format}),boulderViewPromise])
      .then(([atlas,programs,view])=>{
        const made=createBoulderContinuum({
          device,atlas,programs,view,frame:frameUBO,shadowUniform:activeLandShadows.uniform,resources:nearResources,capacity:groundBlocks*groundBlock,samples,
          getPort:()=>ensureBoulderFracturePort(),
          groundAt:(x,z)=>baseGroundSample(x,z),
          waterAt:(x,z)=>inlandWaterSampler?.(x,z)?.wy??null,
        });
        made.setWorldOffset(worldOffset.x,worldOffset.z);
        // Bake relightable 1-triangle octahedral G-buffer cards asynchronously for all 6 boulder archetypes.
        Promise.all([cloudsResolvedPromise,requestContinuumCardRenderer({device,shader,format,samples,pages:atlas.pages.length})]).then(async([resolvedClouds,cardRenderer])=>{
          if(terrainDisposed||!resolvedClouds)return;
          const typeIds=Array.from({length:atlas.types.length},(_,i)=>i);
          const baked=await bakeContinuumCardAtlas({
            device,shader,renderer:cardRenderer,atlas,material:view.material,
            typeIds,bakeGroup0Entries:[{binding:0,resource:landSampler},{binding:1,resource:albedo.createView()}],
            cellSize:isMobile?32:64,gridSize:6,tintMode:0,salt:view.material.salt??5,
            batchSize:6,isCancelled:()=>terrainDisposed,label:'boulder cards',
          });
          if(!baked)return;
          if(terrainDisposed){baked.destroy();return;}
          const cardBindings=createContinuumCardSceneBindings({device,renderer:cardRenderer,resources,clouds:resolvedClouds});
          boulderCardAtlas=baked;
          made.setCards(baked,cardRenderer,cardBindings);
        }).catch(error=>console.error('Boulder octahedral card bake failed:',error));
        return made;
      }).catch(error=>{console.error('boulder continuum',error);return null;}),
    proceduralPack?createInlandWater({device,shader,format,samples,resources:nearResources,clouds,coastalField,oceanBridge,initialGeometry:proceduralPack.inlandWater??null}):Promise.resolve(null),
    isMobile?Promise.resolve(null):startHerds(),
    isMobile?Promise.resolve(null):startTradeVessels(),
  ]);
  boulderContinuum=boulderRes;
  let inlandWater=inlandWaterRes;
  let meadowGrass=null,loadedMeadowPack=null;
  const meadowGrassStats={loaded:false,error:meadowFailure};
  const attachSectionMeadow=(rec)=>{
    if(isMobile||!rec||rec.meadowGrass||rec._meadowPending||!loadedMeadowPack||terrainDisposed)return;
    // Attach real procedural meadow grass to all adjacent coastal land sections (covering 24.5 km × 24.5 km continuously).
    if(Math.max(Math.abs(rec.secX|0),Math.abs(rec.secZ|0))>1)return;
    rec._meadowPending=true;
    createSectionMeadowGrass(rec,{
      device,shader,pack:loadedMeadowPack,nearDomain,clouds,format,samples,
      shadowFormat:activeLandShadows.format,waterOptics:waterOpticsResolvedPromise,isMobile,worldOffset,trees:meadowTrees,dateMs:meadowDateMs,
    }).then(m=>{
      rec._meadowPending=false;
      if(terrainDisposed||loadedSections.get(rec.key)!==rec){m?.destroy?.();return;}
      rec.meadowGrass=m;
      if(craters)m?.bindCraters?.(craters);
    }).catch(()=>{rec._meadowPending=false;});
  };
  const meadowReadyPromise=(async()=>{
    if(isMobile){await forestReadyPromise;await mobilePause(250);}
    if(terrainDisposed)return null;
    const meadowPack=await (meadowPromise??startMeadowLoad());
    if(!meadowPack||terrainDisposed)return null;
    try{
      const made=await createMeadowGrass({device,shader,pack:meadowPack,region:activeRegion,heights,biome,beaches:proceduralPack?.beaches??null,port:proceduralPack?.port??null,city:proceduralPack?.city??null,board:proceduralPack?.board??null,inlandWater:proceduralPack?.inlandWater??null,elevation,nearDomain,resources:nearResources,clouds,format,samples,shadowFormat:activeLandShadows.format,waterOptics:waterOpticsResolvedPromise,isMobile,worldOffset,trees:meadowTrees,dateMs:meadowDateMs});
      loadedMeadowPack=meadowPack;
      if(terrainDisposed){made?.destroy?.();return null;}
      meadowGrass=made;
      if(craters)meadowGrass.bindCraters?.(craters);
      if(meadowGrass?.stats)Object.assign(meadowGrassStats,meadowGrass.stats);
      for(const sec of loadedSections.values())attachSectionMeadow(sec);
      return meadowGrass;
    }catch(error){meadowFailure=error.message;meadowGrassStats.error=meadowFailure;console.error('meadow continuum',error);return null;}
  })();
  const sceneryReady=Promise.all([forestReadyPromise,meadowReadyPromise]).then(async()=>{
    // The forest and the meadow ready, whichever first: the litter under the trees.
    if(!terrainDisposed&&meadowTrees){meadowGrass?.setTrees?.(meadowTrees);for(const sec of loadedSections.values())sec.meadowGrass?.setTrees?.(meadowTrees);}
    if(isMobile&&!terrainDisposed){
      await mobilePause(250);
      if(!terrainDisposed&&!herds)await startHerds();
      await mobilePause(250);
      if(!terrainDisposed&&!tradeVessels)await startTradeVessels();
    }
    return true;
  });
  let tick=0;

  function regenerateTextureMips(tex,texSize){
    const mips=1+Math.log2(texSize);
    const mEnc=device.createCommandEncoder(),mPass=mEnc.beginComputePass();mPass.setPipeline(mipPipe);
    for(let m=1;m<mips;m++){
      mPass.setBindGroup(0,device.createBindGroup({layout:mipPipe.getBindGroupLayout(0),entries:[
        {binding:0,resource:tex.createView({baseMipLevel:m-1,mipLevelCount:1})},
        {binding:1,resource:tex.createView({baseMipLevel:m,mipLevelCount:1})},
      ]}));
      mPass.dispatchWorkgroups(Math.ceil((texSize>>m)/8),Math.ceil((texSize>>m)/8));
    }
    mPass.end();device.queue.submit([mEnc.finish()]);
  }

  function regenerateAlbedoMips(){
    regenerateTextureMips(albedo,activeRegion.albedoSize);
  }

  // Section-by-section continuous coastal world streaming
  const queuedSections=new Set();
  const plannedSections=new Set();
  const sectionQueue=[];
  let sectionStreamBusy=false;
  let sectionEpoch=0;
  let lastStreamCheckCam={x:NaN,z:NaN};
  let activeQueuePromise=null;

  const getSectionAt=(sx,sz,includePlanned=false)=>{
    if(sx===0&&sz===0){
      return {
        secX:0,
        secZ:0,
        region:activeRegion,
        heights,
        rawHeights:proceduralPack?.rawHeights||heights,
      };
    }
    const key=`${sx},${sz}`;
    const loaded=loadedSections.get(key);
    if(loaded)return loaded;
    if(includePlanned&&(queuedSections.has(key)||plannedSections.has(key))){
      return {planned:true,secX:sx,secZ:sz};
    }
    return null;
  };

  function doesNeighborBorderHaveLand(sx,sz){
    const checkEdge=(neighbor,edge)=>{
      if(!neighbor?.heights||!neighbor?.region?.size)return false;
      const nSize=neighbor.region.size;
      const nH=neighbor.rawHeights||neighbor.heights;
      const minCells=Math.max(4,Math.floor(nSize*0.05));
      let land=0;
      if(edge==='east'){
        const i1=Math.max(0,nSize-3);
        for(let j=0;j<nSize;j++)if(Math.max(nH[j*nSize+(nSize-1)],nH[j*nSize+i1])>0.25)land++;
      }else if(edge==='west'){
        const i1=Math.min(nSize-1,2);
        for(let j=0;j<nSize;j++)if(Math.max(nH[j*nSize],nH[j*nSize+i1])>0.25)land++;
      }else if(edge==='south'){
        const j1=Math.max(0,nSize-3);
        for(let i=0;i<nSize;i++)if(Math.max(nH[(nSize-1)*nSize+i],nH[j1*nSize+i])>0.25)land++;
      }else if(edge==='north'){
        const j1=Math.min(nSize-1,2);
        for(let i=0;i<nSize;i++)if(Math.max(nH[i],nH[j1*nSize+i])>0.25)land++;
      }
      return land>=minCells;
    };
    return (
      checkEdge(getSectionAt(sx-1,sz),'east')||
      checkEdge(getSectionAt(sx+1,sz),'west')||
      checkEdge(getSectionAt(sx,sz-1),'south')||
      checkEdge(getSectionAt(sx,sz+1),'north')
    );
  }

  function destroySectionRecord(rec){
    if(!rec)return;
    // Unless a grown section has already taken its place.
    if(loadedSections.get(rec.key)===rec||!loadedSections.has(rec.key))landPiece(rec.key,null);
    portDamage?.capture(rec.port);
    rec.portFractures?.destroy();
    rec.meadowGrass?.destroy?.();rec.meadowGrass=null;
    rec.uniform?.destroy?.();
    rec.albedo?.destroy?.();
    rec.biomeTexture?.destroy?.();
    rec.townField?.texture.destroy();rec.townField?.window.destroy();
  }

  function buildSectionGPURecord(secPack){
    const sReg=secPack.region;
    const sMesh=secPack.mesh;
    const sUniform=buffer(new Float32Array([sReg.x,sReg.z,sReg.span,0]),GPUBufferUsage.UNIFORM,`coastal section (${secPack.secX},${secPack.secZ}) domain`);
    const sAlbedoMips=1+Math.log2(sReg.albedoSize);
    const sAlbedo=device.createTexture({
      label:`coastal section (${secPack.secX},${secPack.secZ}) albedo`,
      size:[sReg.albedoSize,sReg.albedoSize],
      format:'rgba8unorm',
      mipLevelCount:sAlbedoMips,
      usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.COPY_DST|GPUTextureUsage.RENDER_ATTACHMENT,
    });
    device.queue.writeTexture({texture:sAlbedo},secPack.albedo,{bytesPerRow:sReg.albedoSize*4},[sReg.albedoSize,sReg.albedoSize]);
    regenerateTextureMips(sAlbedo,sReg.albedoSize);
    const sBiome=device.createTexture({
      label:`coastal section (${secPack.secX},${secPack.secZ}) biome`,
      size:[sReg.biomeSize,sReg.biomeSize],
      format:'r8unorm',
      usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST,
    });
    device.queue.writeTexture({texture:sBiome},secPack.biome,{bytesPerRow:sReg.biomeSize},[sReg.biomeSize,sReg.biomeSize]);
    const sTownField=townField(secPack.port?.streets);
    const secOpaqueResources=[
      [0,{buffer:frameUBO}],[1,transView],[2,skyView],[3,sampler],[4,envCubeView],
      [5,lighting.createView()],[6,{buffer:sUniform}],[7,sAlbedo.createView()],
      [8,landSampler],[9,sBiome.createView()],
      [12,{buffer:nearDomain}],[13,nearAlbedo.createView()],
      ...sTownField.resources,...groundDetail.resources,...activeLandShadows.terrainResources,...neuralPbr.terrainResources,
    ];
    const submergedSecGroup=submerged?.bindGroup(landEntries(secOpaqueResources).map(([binding,resource])=>({binding,resource})));
    const rec={
      secX:secPack.secX,
      secZ:secPack.secZ,
      key:`${secPack.secX},${secPack.secZ}`,
      isMock:Boolean(secPack.isMock),
      state:secPack.state??(secPack.isMock?'mocked':'grown'),
      generationCount:secPack.generationCount??(secPack.isMock?0:1),
      elevationSource:secPack.elevationSource,
      connectedEdges:secPack.connectedEdges??null,
      region:sReg,
      heights:secPack.heights,
      rawHeights:secPack.rawHeights,
      biome:secPack.biome,
      beaches:secPack.beaches,
      port:secPack.port,
      vegetation:secPack.vegetation,
      // Kept only as compact 1-float/grid-point sand-kind array; the section's land draws through the continuum.
      landKind:landKind(sMesh.vertices,Math.round(Math.sqrt(secPack.heights.length))),
      portFractures:null,
      uniform:sUniform,
      albedo:sAlbedo,
      biomeTexture:sBiome,
      townField:sTownField,
      resources:secOpaqueResources,
      // Its buildings shot down, drawn by the city's view with the section's own surfaces.
      cityGroup:bind(cityPipe,cityEntries(secOpaqueResources)),
      landGroup:bind(landPipe,landEntries(secOpaqueResources)),
      submergedGroup:submergedSecGroup,
    };
    landPiece(rec.key,landSectionSpec(rec));
    return rec;
  }

  let cachedPorts=null,portsDirty=true;
  function getActivePorts(){
    if(portsDirty||!cachedPorts){
      cachedPorts=proceduralPack?.port?[proceduralPack.port]:[];
      for(const sec of loadedSections.values())if(sec.port?.waterfront?.length||sec.port?.works?.length)cachedPorts.push(sec.port);
      portsDirty=false;
    }
    return cachedPorts;
  }

  function restitchNeighborSection(adjRec){
    if(!adjRec?.rawHeights||!proceduralPack)return;
    const sReg=adjRec.region;
    restitchCoastalSection(
      adjRec,
      {...proceduralPack,region:activeRegion,heights,rawHeights:proceduralPack.rawHeights||heights},
      (sx,sz,inc)=>(sx===adjRec.secX&&sz===adjRec.secZ)?null:getSectionAt(sx,sz,inc),
      {taperUnconnectedOuter:true,refreshTextures:false}
    );
    adjRec._cachedForestPlanted=null;
    if(adjRec.mesh?.vertices){adjRec.landKind=landKind(adjRec.mesh.vertices,Math.round(Math.sqrt(adjRec.heights.length)));adjRec.mesh=null;}
    landPiece(adjRec.key,landSectionSpec(adjRec));
    craters?.invalidate(sReg);
    adjRec.biome=synthesizeCoastalBiome(sReg,adjRec.heights,adjRec.beaches,adjRec.port,null);
    device.queue.writeTexture({texture:adjRec.biomeTexture},adjRec.biome,{bytesPerRow:sReg.biomeSize},[sReg.biomeSize,sReg.biomeSize]);
    const rebuiltAlbedo=synthesizeCoastalAlbedo(sReg,adjRec.heights,adjRec.beaches,adjRec.port,adjRec.biome,null);
    device.queue.writeTexture({texture:adjRec.albedo},rebuiltAlbedo,{bytesPerRow:sReg.albedoSize*4},[sReg.albedoSize,sReg.albedoSize]);
    regenerateTextureMips(adjRec.albedo,sReg.albedoSize);
    adjRec.meadowGrass?.sync?.({region:sReg,heights:adjRec.heights,biome:adjRec.biome,beaches:adjRec.beaches,port:adjRec.port});
  }

  function rebuildNeighborTreeInstances(){
    if(terrainDisposed||!proceduralPack)return;
    updateRegionalElevationGrid();
    if(forest&&forestPack){
      const extraSections=Array.from(loadedSections.values());
      proceduralPack.region=activeRegion;
      proceduralPack.heights=heights;
      proceduralPack.biome=biome;
      proceduralPack._cachedForestPlanted=null;
      const nextForestPack=retargetForestPackToProcedural(
        forestPack,
        proceduralPack,
        baseGroundSample,
        {isMobile,extraSections,maxRootCapacity:streamMaxRoots,climateProfile:activeClimate,stand:grovePack,rootCapacity,near:forestNear,owner:forestOwner}
      );
      forest.updatePack(nextForestPack);
      meadowTrees=meadowTreesOf(nextForestPack);
      meadowGrass?.setTrees?.(meadowTrees);
      for(const sec of loadedSections.values())sec.meadowGrass?.setTrees?.(meadowTrees);
      if(grovePack)Object.assign(forestStats.groves,forestHeld(nextForestPack));
      forestSectionsReleased=nextForestPack.sectionsReleased??0;forestHeldAt=forestNear??activeRegion;
      lastCamera=null;
    }
  }

  function rebindNearTownField(streets){
    const oldTownField=activeTownField;
    activeTownField=townField(streets);
    nearResources=[...resources,[12,{buffer:nearDomain}],[13,nearAlbedo.createView()],...activeTownField.resources,...groundDetail.resources,...neuralPbr.terrainResources];
    cityGroup=bind(cityPipe,cityEntries(nearResources));
    submergedGroup=submerged?.bindGroup(landEntries(nearResources).map(([binding,resource])=>({binding,resource})));
    citySubmergedGroup=citySubmerged?.bindGroup(cityEntries(nearResources).map(([binding,resource])=>({binding,resource})));
    landContinuum?.rebind('0,0',bind(landPipe,landEntries(nearResources)),submergedGroup??null);
    boulderContinuum?.rebind(nearResources);
    inlandWater?.rebind(nearResources);
    herds?.rebind(nearResources);
    meadowGrass?.rebind(nearResources);
    tradeVessels?.rebind(nearResources);
    if(oldTownField)retireGPU(()=>{oldTownField.texture?.destroy?.();oldTownField.window?.destroy?.();});
  }

  function ensureMockSection(secX,secZ,{rebuildTrees=true}={}){
    if(terrainDisposed||!proceduralPack||(secX===0&&secZ===0))return null;
    if(Math.abs(secX)>4||Math.abs(secZ)>4)return null;
    const key=`${secX},${secZ}`;
    const existing=loadedSections.get(key);
    if(existing)return existing;
    const secPack=buildMockCoastalSection(
      {...proceduralPack,region:activeRegion,heights,rawHeights:proceduralPack.rawHeights||heights},
      secX,
      secZ,
      getSectionAt,
      {
        // A lattice of 2^k + 1 points a side, as the land's continuum cuts it.
        size:proceduralPack.regionalDem?65:33,
        biomeSize:64,
        albedoSize:proceduralPack.regionalDem?128:64,
        vegetationCandidates:isMobile?180:320,
        taperUnconnectedOuter:true,
        skipStaticPalms:Boolean(forest&&forestPack),
      }
    );
    const rec=buildSectionGPURecord(secPack);
    loadedSections.set(key,rec);
    attachSectionMeadow(rec);
    for(const [dx,dz,adjEdge] of [[-1,0,'east'],[1,0,'west'],[0,-1,'south'],[0,1,'north']]){
      const adj=loadedSections.get(`${secX+dx},${secZ+dz}`);
      if(adj&&!adj.connectedEdges?.[adjEdge])restitchNeighborSection(adj);
    }
    craters?.invalidate(rec.region);
    if(rebuildTrees)rebuildNeighborTreeInstances();
    return rec;
  }

  function processSectionStreamQueue(){
    if(terrainDisposed||!proceduralPack||!sectionQueue.length)return activeQueuePromise;
    if(sectionStreamBusy&&activeQueuePromise)return activeQueuePromise;
    sectionStreamBusy=true;
    const myEpoch=sectionEpoch;
    // Synthesize neighboring coastal sections in topological distance order (cardinals before diagonals/2nd ring)
    // using real AWS Terrarium SRTM DEM geography (shared tile cache) so bays, islands, and lagoons appear directly.
    sectionQueue.sort((a,b)=>(Math.abs(a.secX)+Math.abs(a.secZ))-(Math.abs(b.secX)+Math.abs(b.secZ)));
    activeQueuePromise=(async()=>{
      let streamedCount=0,lastTreeRebuildCount=0;
      while(sectionQueue.length&&myEpoch===sectionEpoch){
        const {secX,secZ,wantRealDEM}=sectionQueue.shift();
        const key=`${secX},${secZ}`;
        const existing=loadedSections.get(key);
        try{
          if(!existing||existing.isMock){
            if(existing?.isMock)existing.state='generating';
            const useDem=Boolean(wantRealDEM&&search.get('realDEM')!=='off');
            const secPack=await generateCoastalNeighborSection(
              {...proceduralPack,region:activeRegion,heights,rawHeights:proceduralPack.rawHeights||heights},
              secX,
              secZ,
              (sx,sz,inc)=>(sx===secX&&sz===secZ)?null:getSectionAt(sx,sz,inc),
              {
                size:isMobile?65:129,
                biomeSize:isMobile?64:128,
                albedoSize:isMobile?128:256,
                vegetationCandidates:isMobile?1600:3600,
                useRealDEM:useDem,
                use1550:Boolean(discovery?.applied),
                taperUnconnectedOuter:true,
                skipStaticPalms:Boolean(forest&&forestPack),
              }
            );
            if(myEpoch!==sectionEpoch)break;
            const prevRec=loadedSections.get(key);
            const rec=buildSectionGPURecord(secPack);
            rec.isMock=false;
            rec.state='grown';
            rec.generationCount=(prevRec?.generationCount??0)+1;
            loadedSections.set(key,rec);
            attachSectionMeadow(rec);
            if(prevRec)retireGPU(()=>destroySectionRecord(prevRec));
            queuedSections.delete(key);
            portsDirty=true;
            craters?.invalidate(rec.region);
            for(const [dx,dz] of [[-1,0],[1,0],[0,-1],[0,1]]){
              const adj=loadedSections.get(`${secX+dx},${secZ+dz}`);
              if(adj)restitchNeighborSection(adj);
            }
            streamedCount++;
            if(streamedCount===4||sectionQueue.length===0){
              rebuildNeighborTreeInstances();
              lastTreeRebuildCount=streamedCount;
            }
          }else{
            queuedSections.delete(key);
          }
        }catch{
          if(existing?.isMock&&loadedSections.get(key)===existing)existing.state='mocked';
          queuedSections.delete(key);
        }
        await new Promise(r=>setTimeout(r,20));
      }
      if(myEpoch===sectionEpoch&&streamedCount>lastTreeRebuildCount){
        rebuildNeighborTreeInstances();
      }
      sectionStreamBusy=false;
      if(myEpoch===sectionEpoch&&sectionQueue.length)return processSectionStreamQueue();
      activeQueuePromise=null;
    })();
    return activeQueuePromise;
  }

  function enqueueCoastalSection(secX,secZ,{priority=false,wantRealDEM=true,deferProcess=false}={}){
    if(!proceduralPack||(secX===0&&secZ===0))return false;
    if(Math.abs(secX)>4||Math.abs(secZ)>4)return false;
    const key=`${secX},${secZ}`;
    const existing=loadedSections.get(key);
    if((existing&&!existing.isMock)||queuedSections.has(key))return false;
    if(existing?.isMock)existing.state='generating';
    queuedSections.add(key);
    const item={secX,secZ,wantRealDEM};
    if(priority)sectionQueue.unshift(item);
    else sectionQueue.push(item);
    if(!deferProcess)setTimeout(()=>processSectionStreamQueue(),20);
    return true;
  }

  function seedInitialCoastalSections(){
    if(terrainDisposed||!proceduralPack)return;
    let dirs;
    if(proceduralPack.regionalDem?.heights?.length){
      dirs=[];
      for(let dz=-2;dz<=2;dz++){
        for(let dx=-2;dx<=2;dx++){
          if(dx===0&&dz===0)continue;
          dirs.push({dx,dz});
        }
      }
      dirs.sort((a,b)=>(Math.abs(a.dx)+Math.abs(a.dz))-(Math.abs(b.dx)+Math.abs(b.dz)));
    }else{
      dirs=detectCoastalContinuationDirs(
        proceduralPack.rawHeights||heights,
        activeRegion.size,
        activeRegion.shoreBearing,
        {seawardBearing:activeRegion.seawardBearing}
      );
    }
    const connectedCenter={
      west:loadedSections.has('-1,0')||dirs.some(d=>d.dx===-1&&d.dz===0),
      east:loadedSections.has('1,0')||dirs.some(d=>d.dx===1&&d.dz===0),
      north:loadedSections.has('0,-1')||dirs.some(d=>d.dx===0&&d.dz===-1),
      south:loadedSections.has('0,1')||dirs.some(d=>d.dx===0&&d.dz===1),
    };
    let bordersModified=false;
    if(connectedCenter.west||connectedCenter.east||connectedCenter.north||connectedCenter.south){
      const modified=prepareSectionConnectedBorders(heights,activeRegion.size,connectedCenter);
      if(proceduralPack.rawHeights&&proceduralPack.rawHeights!==heights){
        prepareSectionConnectedBorders(proceduralPack.rawHeights,activeRegion.size,connectedCenter);
      }
      if(modified){
        bordersModified=true;
        proceduralPack._cachedForestPlanted=null;
        device.queue.writeTexture({texture:elevation},heights,{bytesPerRow:activeRegion.size*4},[activeRegion.size,activeRegion.size]);
        const rebuiltMesh=buildCoastalMesh(activeRegion,heights,proceduralPack.beaches,null,proceduralPack.port,proceduralPack.rawHeights||heights,{lookupNeighbor:getSectionAt,secX:0,secZ:0,isMock:false});
        centerLandKind=rebuiltMesh?.vertices?landKind(rebuiltMesh.vertices,activeRegion.size):centerLandKind;
        landCentre(proceduralPack.port?.riverCut);
        craters?.invalidate(activeRegion);
      }
    }
    let addedMocks=0;
    for(const {dx,dz} of dirs){
      if((dx!==0||dz!==0)&&Math.abs(dx)<=4&&Math.abs(dz)<=4)plannedSections.add(`${dx},${dz}`);
    }
    try{
      for(const {dx,dz} of dirs){
        if(!loadedSections.has(`${dx},${dz}`)){
          ensureMockSection(dx,dz,{rebuildTrees:false});
          addedMocks++;
        }
      }
    }finally{
      plannedSections.clear();
    }
    if(addedMocks||bordersModified)rebuildNeighborTreeInstances();
  }

  function resetStreamedSections(){
    sectionEpoch++;
    sectionQueue.length=0;
    queuedSections.clear();
    plannedSections.clear();
    activeQueuePromise=null;
    for(const rec of loadedSections.values())destroySectionRecord(rec);
    loadedSections.clear();
    portsDirty=true;
    lastStreamCheckCam={x:NaN,z:NaN};
    rebuildNeighborTreeInstances();
    seedInitialCoastalSections();
  }

  function enterPlayerPosition(lx,lz,{deferProcess=false}={}){
    if(terrainDisposed||!proceduralPack||!Number.isFinite(lx)||!Number.isFinite(lz)){
      return {parcelsGrown:0,sectionsQueued:0,mocksSeeded:0};
    }
    // A town grows by its board's own life (js/board-life.js), laid again as it grows: nothing else grows one.
    const parcelsGrown=0;

    const span=activeRegion.span;
    const halfSpan=span*0.5;
    const pSecX=Math.round((lx-activeRegion.x)/span);
    const pSecZ=Math.round((lz-activeRegion.z)/span);
    let sectionsQueued=0;
    let addedMocks=0;
    for(let dz=-1;dz<=1;dz++){
      for(let dx=-1;dx<=1;dx++){
        const sx=pSecX+dx,sz=pSecZ+dz;
        if(Math.abs(sx)>4||Math.abs(sz)>4)continue;
        const secCx=activeRegion.x+sx*span;
        const secCz=activeRegion.z+sz*span;
        const borderDist=Math.hypot(Math.max(0,Math.abs(lx-secCx)-halfSpan),Math.max(0,Math.abs(lz-secCz)-halfSpan));
        if(borderDist>1600)continue;
        const isCurrentSection=sx===pSecX&&sz===pSecZ;
        if(sx!==0||sz!==0){
          const key=`${sx},${sz}`;
          const existing=loadedSections.get(key);
          const inMosaicEnvelope=Boolean(proceduralPack.regionalDem)||(Math.abs(sx)<=2&&Math.abs(sz)<=2);
          if((!existing||existing.isMock)&&!queuedSections.has(key)){
            if(existing?.isMock||isCurrentSection||inMosaicEnvelope||doesNeighborBorderHaveLand(sx,sz)){
              if(enqueueCoastalSection(sx,sz,{priority:isCurrentSection,wantRealDEM:true,deferProcess})){
                sectionsQueued++;
              }
            }
          }
        }
        for(const [cx,cz] of [[-1,0],[1,0],[0,-1],[0,1]]){
          const nx=sx+cx,nz=sz+cz;
          if((nx===0&&nz===0)||Math.abs(nx)>4||Math.abs(nz)>4)continue;
          const nKey=`${nx},${nz}`;
          const adjInMosaic=Boolean(proceduralPack.regionalDem)||(Math.abs(nx)<=2&&Math.abs(nz)<=2);
          if(!loadedSections.has(nKey)&&!queuedSections.has(nKey)&&(adjInMosaic||doesNeighborBorderHaveLand(nx,nz))){
            ensureMockSection(nx,nz,{rebuildTrees:false});
            addedMocks++;
          }
        }
      }
    }
    if(addedMocks)rebuildNeighborTreeInstances();
    return {parcelsGrown,sectionsQueued,mocksSeeded:addedMocks};
  }

  checkPlayerFrontierEntry=camera=>{
    if(!proceduralPack||!camera||!Number.isFinite(camera.playerX)||!Number.isFinite(camera.playerZ))return;
    const lx=camera.playerX-worldOffset.x,lz=camera.playerZ-worldOffset.z;
    if(Math.hypot(lx-lastStreamCheckCam.x,lz-lastStreamCheckCam.z)<48)return;
    lastStreamCheckCam={x:lx,z:lz};
    enterPlayerPosition(lx,lz);
  };

  const whenStartupSettled=(fn,delayMs=60)=>{
    const check=()=>{
      if(terrainDisposed)return;
      if(typeof window!=='undefined'&&window.oceanStartup?.state==='loading'){
        setTimeout(check,80);
        return;
      }
      setTimeout(()=>{if(!terrainDisposed)fn();},delayMs);
    };
    setTimeout(check,delayMs);
  };
  const willAutoUpgrade1550=Boolean(proceduralPack&&!preloaded1550&&search.get('discover')!=='1'&&search.get('era')!=='2026');
  if(proceduralPack&&!willAutoUpgrade1550){
    whenStartupSettled(()=>seedInitialCoastalSections(),60);
  }

  let baseSnapshot=proceduralPack&&!preloaded1550?{
    region:activeRegion,
    heights:new Float32Array(proceduralPack.surveyHeights??heights),
    rawHeights:proceduralPack.rawHeights?new Float32Array(proceduralPack.rawHeights):new Float32Array(heights),
    regionalDem:proceduralPack.regionalDem??null,
    biome:new Uint8Array(biome),
    albedo:proceduralPack.albedo?new Uint8Array(proceduralPack.albedo):null,
    landKind:centerLandKind?new Float32Array(centerLandKind):null,
    vegetation:proceduralPack.vegetation,
    beaches:proceduralPack.beaches,
    views:proceduralPack.views,
    port:proceduralPack.port,
  }:null;

  let fabricEpoch=0;
  let refreshBoardFabricFn=null;

  function applyUpgradedPack(upgradedPack,boat=null,isUpgraded=true){
    if(terrainDisposed||!proceduralPack||!upgradedPack?.heights||!(upgradedPack?.mesh||upgradedPack?.landKind))return false;
    fabricEpoch++;
    proceduralPack._cachedForestPlanted=null;
    upgradedPack._cachedForestPlanted=null;
    if(upgradedPack.regionalDem)proceduralPack.regionalDem=upgradedPack.regionalDem;
    portsDirty=true;
    if(upgradedPack.region){
      const nextSpan=upgradedPack.region.span||activeRegion.span;
      const nextBearing=Number.isFinite(upgradedPack.region.shoreBearing)?upgradedPack.region.shoreBearing:activeRegion.shoreBearing;
      const nextSeaward=Number.isFinite(upgradedPack.region.seawardBearing)?upgradedPack.region.seawardBearing:activeRegion.seawardBearing;
      if(nextSpan!==activeRegion.span||nextBearing!==activeRegion.shoreBearing||nextSeaward!==activeRegion.seawardBearing){
        activeRegion=Object.freeze({...activeRegion,span:nextSpan,shoreBearing:nextBearing,seawardBearing:nextSeaward});
        proceduralPack.region=activeRegion;
        device.queue.writeBuffer(uniform,0,new Float32Array([activeRegion.x,activeRegion.z,activeRegion.span,0.22]));
        coastalField?.invalidate();
      }
    }
    if(upgradedPack.views)proceduralPack.views=upgradedPack.views;
    if(upgradedPack.port)proceduralPack.port=upgradedPack.port;
    if(upgradedPack.beaches)proceduralPack.beaches=upgradedPack.beaches;
    if(upgradedPack.vegetation){
      proceduralPack.vegetation=upgradedPack.vegetation;
    }
    if(upgradedPack.rawHeights)proceduralPack.rawHeights=upgradedPack.rawHeights;
    if(upgradedPack.elevationSource)proceduralPack.elevationSource=upgradedPack.elevationSource;
    heights.set(upgradedPack.heights);
    syncOldWorldHeights(heights,{
      surveyHeights:upgradedPack.surveyHeights??null,
      port:upgradedPack.port??proceduralPack.port,
      country:upgradedPack.port?._resolvedCountry??null,
    });
    device.queue.writeTexture({texture:elevation},heights,{bytesPerRow:activeRegion.size*4},[activeRegion.size,activeRegion.size]);
    if(upgradedPack.biome&&upgradedPack.biome.byteLength===biome.byteLength){
      biome.set(upgradedPack.biome);
      device.queue.writeTexture({texture:biomeTexture},biome,{bytesPerRow:activeRegion.biomeSize},[activeRegion.biomeSize,activeRegion.biomeSize]);
    }
    if(upgradedPack.albedo){
      device.queue.writeTexture({texture:albedo},upgradedPack.albedo,{bytesPerRow:activeRegion.albedoSize*4},[activeRegion.albedoSize,activeRegion.albedoSize]);
      regenerateAlbedoMips();
      // A board on the new ground is stamped as soon as its tables are on the GPU; the queue keeps the order.
      boardStamp?.dispose();boardStamp=null;
      if(upgradedPack.board)createBoardStamp({device,shader,board:upgradedPack.board}).then(stamp=>{
        if(terrainDisposed){stamp.dispose();return;}
        boardStamp=stamp;stamp.stamp(albedo,activeRegion.albedoSize);regenerateAlbedoMips();
      }).catch(()=>{});
    }
    if(upgradedPack.mesh?.vertices){
      centerLandKind=landKind(upgradedPack.mesh.vertices,activeRegion.size);
      upgradedPack.mesh=null;
    }else if(upgradedPack.landKind){
      centerLandKind=upgradedPack.landKind;
    }
    // A coast laid out wider or narrower puts every piece of land on another grid.
    if(landGrid.g!==activeRegion.span/1024){landGrid=landGridFor();landContinuum?.regrid(landGrid);for(const key of landSpecs.keys())landDirty.add(key);}
    landCentre(proceduralPack.port?.riverCut);
    rebindNearTownField(upgradedPack.port?.streets);
    inlandWaterSampler=createInlandWaterSampler(upgradedPack.port?.country??null);
    inlandWater?.setGeometry(upgradedPack.inlandWater??null);
    herds?.setBridges?.(upgradedPack.port?.country?.bridges??null);
    herds?.setHerds(upgradedPack.herds??null);
    meadowGrass?.sync({region:activeRegion,heights,biome,beaches:proceduralPack.beaches??null,port:proceduralPack.port??null,city:upgradedPack.city??proceduralPack.city??null,board:upgradedPack.board??proceduralPack.board??null,inlandWater:upgradedPack.inlandWater??proceduralPack.inlandWater??null});
    if(upgradedPack.port?.country?.board){
      tradeVessels?.setTraffic(null,activeRegion,upgradedPack.port.country.riverReaches??[],upgradedPack.port.country.places??[],{heights,region:activeRegion,port:upgradedPack.port,bridges:upgradedPack.port.country.bridges??[],inlandWaterAt:(wx,wz)=>inlandWaterSampler?inlandWaterSampler(wx,wz):null});
    }
    proceduralPack.surveyHeights=upgradedPack.surveyHeights??null;
    const registeredBoard=!upgradedPack.city?(bakedBoardFor(activeRegion)?.board??null):null;
    proceduralPack.inlandWater=upgradedPack.inlandWater??null;
    proceduralPack.herds=upgradedPack.herds??null;
    if(registeredBoard&&refreshBoardFabricFn){
      // A runtime-founded board arrived while the 1550 terrain upgrade was running: re-lay it on the new heights
      // instead of leaving pre-upgrade building elevations floating over the upgraded terrain.
      proceduralPack.board=null;
      proceduralPack.city=null;
      cityStruckIndices.clear();cityHitIndices.clear();
      setCityBuildings(null).catch(error=>console.warn('city continuum',error));
      activeCity=null;cityTargets=null;
      portFractures?.destroy();portFractures=null;
      refreshBoardFabricFn(registeredBoard).catch(error=>console.warn('board fabric refresh',error));
    }else{
      proceduralPack.board=upgradedPack.board??null;
      proceduralPack.city=upgradedPack.city??null;
      // The city is laid out again on the new ground, whole; what was shot down is put back from the record.
      portDamage?.capture(proceduralPack?.port);
      cityStruckIndices.clear();cityHitIndices.clear();
      setCityBuildings(upgradedPack).catch(error=>console.warn('city continuum',error));
      activeCity=upgradedPack.city??null;cityTargets=cityTargetsFor(activeCity,upgradedPack.port);
      portFractures?.destroy();
      portFractures=portFracturesFor(upgradedPack.port,cityTargets);
      portFractures?.restoreNow().catch((error)=>console.error('Port damage restore failed',error));
    }

    groundPatches=createGroundCoverPatches(activeRegion,baseGroundSample,null);
    groundStats.patches=groundPatches.length;
    clearGroundResidency();
    lastCamera=null;
    tick=0;

    resetStreamedSections();
    craters?.invalidate();
    if(boat&&Number.isFinite(boat.x)&&Number.isFinite(boat.z)){
      const draft=boat.hydrodynamics?.draft??2.1;
      if(heightSample(boat.x,boat.z)>-draft*1.15){
        const safe=safeLandfallStart(heights,{x:boat.x,z:boat.z,heading:boat.heading??0},boat,activeRegion,heightSample);
        boat.x=safe.x;boat.z=safe.z;
      }
    }
    discovery.applied=Boolean(isUpgraded);
    discovery.status=isUpgraded?'applied':'reverted';
    notifyDiscovery();
    return true;
  }


  const discoveryListeners=new Set();
  const discovery={
    enabled:Boolean(proceduralPack),
    status:preloaded1550?'applied':proceduralPack?'checking':'none',
    isFirstExplorer:false,
    isCurated1550:Boolean(isKnownSpanishMain),
    applied:Boolean(preloaded1550),
    visits:preloaded1550?.visits||1,
    message:preloaded1550?`1550 historical territory charted · Mariner #${preloaded1550.visits||1}`:'',
    stats:preloaded1550?.upgradedPack?.territory1550||null,
    upgradedPack:preloaded1550?.upgradedPack||null,
    climate:activeClimate,
    forestPackKind:useSubtropicalForest?'subtropical':'temperate',
    subscribe(fn){
      discoveryListeners.add(fn);
      fn(discovery);
      return ()=>discoveryListeners.delete(fn);
    },
    swapToUpgraded(boat=null){
      if(!discovery.upgradedPack){
        discovery.upgradedPack=build1550HistoricalTerritoryPack( { ...proceduralPack, heights: baseSnapshot ? baseSnapshot.heights : proceduralPack.heights });
        discovery.stats=discovery.upgradedPack.territory1550;
      }
      return applyUpgradedPack(discovery.upgradedPack,boat,true);
    },
    revertToBase(boat=null){
      if(!baseSnapshot&&proceduralPack){
        baseSnapshot=generateProceduralCoastalPack(activeRegion,{...proceduralGridOpts,deferSynthesis:false});
      }
      if(!baseSnapshot)return false;
      return applyUpgradedPack(baseSnapshot,boat,false);
    },
    toggleUpgraded(boat=null){
      return discovery.applied?discovery.revertToBase(boat):discovery.swapToUpgraded(boat);
    },
  };
  function notifyDiscovery(){
    for(const fn of discoveryListeners){
      try{fn(discovery);}catch{/* ignore UI listener error */}
    }
  }

  if(proceduralPack&&search.get('publicClimate')!=='off'){
    fetchPublicClimateProfile(activeRegion.latitude,activeRegion.longitude,{region:activeRegion}).then(liveClimate=>{
      if(terrainDisposed||!liveClimate)return;
      const prevKoppen=activeClimate?.koppenCode;
      activeClimate=liveClimate;
      discovery.climate=liveClimate;
      if(liveClimate.source==='nasa-power-climatology'||liveClimate.koppenCode!==prevKoppen){
        proceduralPack._cachedForestPlanted=null;
        for(const sec of loadedSections.values())sec._cachedForestPlanted=null;
        rebuildNeighborTreeInstances();
        notifyDiscovery();
      }
    }).catch(()=>{/* retain fallback climate */});
  }

  if(proceduralPack&&!preloaded1550&&search.get('realDEM')!=='off'){
    const forceFirstExplorer=search.get('discover')==='1';
    const autoApply1550=!forceFirstExplorer&&search.get('era')!=='2026';
    whenStartupSettled(()=>{
      if(terrainDisposed)return;
      runLandfallDiscoveryPipeline({ ...proceduralPack, heights: baseSnapshot.heights },{
        forceFirstExplorer,
        snapToCoast:!options?.lateSpawn,
        onFirstExplorer(info){
          discovery.status='charting';
          discovery.isFirstExplorer=true;
          discovery.message=`You are the first mariner to sail to ${info.name} (${info.coordLabel}). Reconstructing 1550 historical territory…`;
          notifyDiscovery();
        },
        onProgress(prog){
          discovery.status='charting';
          discovery.message=prog.message;
          notifyDiscovery();
        },
        onUpgradeReady(res){
          discovery.status='ready';
          discovery.isFirstExplorer=!autoApply1550;
          discovery.visits=1;
          discovery.upgradedPack=res.upgradedPack;
          discovery.stats=res.stats;
          discovery.message=`Congratulations on your discovery! The 1550 historical territory for ${res.name} is ready.`;
          if(autoApply1550){
            discovery.swapToUpgraded();
          }else{
            notifyDiscovery();
          }
        },
        onCachedReady(res){
          discovery.status='cached';
          discovery.isFirstExplorer=false;
          discovery.visits=res.visits;
          discovery.upgradedPack=res.upgradedPack;
          discovery.stats=res.stats;
          discovery.message=`1550 historical territory charted · Mariner #${res.visits}`;
          if(autoApply1550){
            discovery.swapToUpgraded();
          }else{
            notifyDiscovery();
          }
        },
      }).catch(()=>{
        if(willAutoUpgrade1550&&!loadedSections.size&&!queuedSections.size)seedInitialCoastalSections();
      });
    },120);
  }

  function isSectionVisible(secRegion,cam=lastCamera,matrix=lastView,maxDist=Infinity){
    if(!secRegion)return false;
    const span=secRegion.span??8192,half=span*0.5;
    const secX=secRegion.x+worldOffset.x,secZ=secRegion.z+worldOffset.z;
    if(cam&&Number.isFinite(cam.x)&&Number.isFinite(cam.z)){
      const dx=Math.max(secX-half-cam.x,0,cam.x-(secX+half));
      const dz=Math.max(secZ-half-cam.z,0,cam.z-(secZ+half));
      if(dx*dx+dz*dz>maxDist*maxDist)return false;
    }
    if(matrix&&matrix.length>=16&&cam&&Number.isFinite(cam.x)){
      const peakH=Math.max(480,secRegion.peakElevationMetres??480);
      const midY=(peakH-50)*0.5,halfY=(peakH+150)*0.5;
      const p=[secX-cam.x,midY-(cam.y??6),secZ-cam.z];
      const radius=Math.hypot(half,halfY,half);
      for(const[axis,sign]of[[0,-1],[0,1],[1,-1],[1,1],[3,0]]){
        const ax=matrix[3]+(axis===3?0:sign*matrix[axis]);
        const ay=matrix[7]+(axis===3?0:sign*matrix[4+axis]);
        const az=matrix[11]+(axis===3?0:sign*matrix[8+axis]);
        const d=matrix[15]+(axis===3?0:sign*matrix[12+axis]);
        if(ax*p[0]+ay*p[1]+az*p[2]+d<-radius*Math.hypot(ax,ay,az))return false;
      }
    }
    return true;
  }

  // Anything saved as ruined is a ruin before the port is first seen.
  await portFractures?.restoreNow();
  craters=createLandCraters({device,computePipe,ledger:craterLedger,maxLayers:isMobile?96:384,region:activeRegion,
    sectionAt(x,z){
      const sx=Math.round((x-activeRegion.x)/activeRegion.span),sz=Math.round((z-activeRegion.z)/activeRegion.span);
      if(sx===0&&sz===0)return 'main';
      return loadedSections.has(`${sx},${sz}`)?`${sx},${sz}`:null;
    },
    groundAt:(x,z)=>groundSample(x,z),
    surfaceAt:(x,z)=>baseGroundSample(x,z),
  });
  meadowGrass?.bindCraters?.(craters);
  // The land's cut and draw, its pits read from the crater tiles in the same draw.
  const landShared=()=>[...craters.resources(),...landBanks.resources()];
  landContinuum=createLandContinuum({device,pipelines:await requestLandContinuumPipelines({device,shader}),view:landPipe,capture:submerged??null,frame:frameUBO,grid:landGrid,shared:landShared(),profile:'land'});
  landClouds=clouds.bindVolume(landPipe,'shadow');
  landContinuum.setWorldOffset(worldOffset.x,worldOffset.z);
  craters.onReallocate(()=>landContinuum?.setShared(landShared()));
  landBanks.onChange(()=>landContinuum?.setShared(landShared()));
  landFlush();
  const recentBlastRings=[];
  const EMPTY_BALLISTIC_LIST=[];
  let lastBallisticClock=0;
  let hadActiveBallistics=false;
  function recordBlastRing(wx,wz,strength=1,hot=false,wy=null){
    const lx=wx-worldOffset.x,lz=wz-worldOffset.z;
    const y=Number.isFinite(wy)?wy:baseGroundSample(lx,lz);
    recentBlastRings.push({x:lx,y,z:lz,t0:lastBallisticClock,maxAge:2.2,strength,speed:26.0,hot:Boolean(hot)});
    if(recentBlastRings.length>16)recentBlastRings.splice(0,recentBlastRings.length-16);
  }
  async function refreshBoardFabric(nextBoardJson){
    if(terrainDisposed||!proceduralPack||!nextBoardJson)return false;
    const myEpoch=++fabricEpoch;
    const portObj=proceduralPack.port;
    if(!proceduralPack.surveyHeights)proceduralPack.surveyHeights=heights.slice();
    const country=refreshOldWorldBoardCountry(nextBoardJson,activeRegion,heights,portObj,proceduralPack.surveyHeights);
    if(!country)return false;
    device.queue.writeTexture({texture:elevation},heights,{bytesPerRow:activeRegion.size*4},[activeRegion.size,activeRegion.size]);
    if(portObj){
      portObj._resolvedCountry=country;
      portObj.country={
        board:country.board??null,
        places:country.places??null,
        riverReaches:country.riverReaches??null,
        ponds:country.ponds??null,
        bridges:country.bridges??null,
        rebuildHerds:country.rebuildHerds??null,
      };
      portObj.riverCut=country.riverCut??null;
      if(country.watch)portObj.watch=country.watch;
      // Its works and its waterfront as the board stands them now; the dock, ways and props are read from them again.
      portObj.works=country.works??[];
      portObj.furniture=country.furniture??[];
      settlePortOnWaterfront(portObj,heights,activeRegion,country.waterfront??[]);
      const sampleGround=(x,z)=>terrainSurfaceSample(heights,x,z,activeRegion);
      portObj.streets=layTownStreets(portObj,sampleGround,{suppressSyntheticCountryRoads:true});
      portObj.streetsOwn=null;
      portObj.props=layPortProps(portObj,sampleGround);
      if(country.plan?.paving?.length){
        portObj.streets=paveCityStreets(portObj.streets,country.plan.paving);
      }
      rebindNearTownField(portObj.streets);
    }
    const nextBaseCity=country.plan?{
      blocks:country.plan.blocks,
      count:country.plan.count,
      typed:country.plan.typed,
      typedTypes:country.plan.typedTypes,
      typedCount:country.plan.typedCount,
      typedBlocks:country.plan.typedBlocks,
      typedAttached:country.plan.typedAttached??null,
      stats:country.plan.stats,
    }:null;
    proceduralPack.board=country.board??null;
    proceduralPack.inlandWater=country.inlandWater??null;
    proceduralPack.city=nextBaseCity;
    proceduralPack.herds=country.herds??null;
    const nextBiome=synthesizeCoastalBiome(activeRegion,heights,proceduralPack.beaches,portObj);
    biome.set(nextBiome);
    proceduralPack.biome=biome;
    device.queue.writeTexture({texture:biomeTexture},biome,{bytesPerRow:activeRegion.biomeSize},[activeRegion.biomeSize,activeRegion.biomeSize]);
    proceduralPack.albedo=synthesizeCoastalAlbedo(activeRegion,heights,proceduralPack.beaches,portObj,biome);
    proceduralPack.vegetation=seedCoastalVegetation(activeRegion,heights,biome,proceduralPack.beaches,portObj);
    // The board cut its rivers into the lattice again and meshed their banks anew: the land is baked from both.
    landCentre(portObj?.riverCut);
    craters?.invalidate(activeRegion);
    inlandWaterSampler=createInlandWaterSampler(portObj?.country??null);
    inlandWater?.setGeometry?.(proceduralPack.inlandWater??null);
    herds?.setBridges?.(portObj?.country?.bridges??null);
    herds?.setHerds?.(proceduralPack.herds??null);
    if(proceduralPack.albedo){
      device.queue.writeTexture({texture:albedo},proceduralPack.albedo,{bytesPerRow:activeRegion.albedoSize*4},[activeRegion.albedoSize,activeRegion.albedoSize]);
    }
    boardStamp?.dispose();boardStamp=null;
    if(proceduralPack.board){
      const stamp=await createBoardStamp({device,shader,board:proceduralPack.board});
      if(terrainDisposed||fabricEpoch!==myEpoch){stamp.dispose();return false;}
      boardStamp=stamp;
      boardStamp.stamp(albedo,activeRegion.albedoSize);
    }
    if(terrainDisposed||fabricEpoch!==myEpoch)return false;
    regenerateAlbedoMips();
    for(const [,block] of groundResident){boulderContinuum?.clearSlots(block*groundBlock,groundBlock);groundFreeBlocks.push(block);}
    groundResident.clear();groundWanted=[];
    rebuildNeighborTreeInstances();
    cityStruckIndices.clear();cityHitIndices.clear();
    setCityBuildings(proceduralPack).catch(error=>console.warn('city continuum',error));
    activeCity=proceduralPack.city??null;cityTargets=cityTargetsFor(activeCity,portObj);
    portFractures?.destroy();
    portFractures=portFracturesFor(portObj,cityTargets);
    meadowGrass?.sync?.({
      region:activeRegion,heights,biome,beaches:proceduralPack.beaches??null,port:portObj??null,
      city:proceduralPack.city??null,board:proceduralPack.board??null,inlandWater:proceduralPack.inlandWater??null,
    });
    return true;
  }
  refreshBoardFabricFn=refreshBoardFabric;
  return {
    waterGroup:pipe=>coastalField.waterGroup(pipe),
    get turbidityScale(){return coastalTurbidityScale(activeRegion.latitude??0,activeRegion.coastalArchetype);},
    get trees(){return forest?.stats.roots??0;},
    // The forest's own roots, as a ball meets them. Null with no forest, and for a moment while one loads.
    get forestTrunks(){return forest?.trunks??null;},
    get forestStrikeKey(){return forest?forestStrikeKey:null;},
    groundStats,forestStats,sceneryReady,
    prepare:(cam,vp)=>updateTrees(cam,vp,true),groundDetail,
    // Each family's indirect draws for the continuum census (js/continuum-census.js): only the families that offer them.
    continuumSources(){
      const pieceDraws=[...(portFractures?.continuumDraws?.()??[])];
      for(const sec of loadedSections.values())if(sec.portFractures)pieceDraws.push(...(sec.portFractures.continuumDraws?.()??[]));
      const meadowDraws=[...(meadowGrass?.continuumDraws?.()??[])];
      for(const sec of loadedSections.values())if(sec.meadowGrass)meadowDraws.push(...(sec.meadowGrass.continuumDraws?.()??[]));
      return [
        ['forest',forest?.continuumDraws?.()],
        ['boulders',boulderContinuum?.continuumDraws?.()],
        ['meadow',meadowDraws],
        ['herds',herds?.continuumDraws?.()],
        ['trade vessels',tradeVessels?.continuumDraws?.()],
        ['city',cityContinuum?.continuumDraws?.()],
        ['city pieces',pieceDraws],
        ['land',landContinuum?.continuumDraws?.()],
      ].filter(([,draws])=>draws?.length).map(([name,draws])=>({name,draws}));
    },
    nearStats:{loaded:!!nearTile,error:nearFailure,domain:nearTile?.manifest.domain??null},
    // The land's cut, read back: for tests. Per piece, the view's and the captures' lists of patches.
    readLandCut:()=>landContinuum?.readCut()??null,
    // The land's pieces as baked, for tests: each piece's nodes and numbers (js/land-continuum.js).
    landPieces:()=>landContinuum?.pieces??null,
    height:(x,z)=>heightSample(x-worldOffset.x,z-worldOffset.z),
    surfaceHeight:(x,z)=>baseGroundSample(x-worldOffset.x,z-worldOffset.z),
    groundSample:(x,z)=>groundSample(x-worldOffset.x,z-worldOffset.z),
    isOnDeckAt:(x,z)=>{
      const lx=x-worldOffset.x,lz=z-worldOffset.z;
      const deck=archDeckSample(lx,lz);
      return deck>-1e6&&deck>=baseGroundSample(lx,lz)-0.08;
    },
    bridgeSurfaceAt:(x,z)=>{
      const lx=x-worldOffset.x,lz=z-worldOffset.z;
      const sec=proceduralPack?findNeighborSection(lx,lz):null;
      const p=sec?.port??proceduralPack?.port;
      return bridgeSurfaceAt(lx,lz,p?.country?.bridges);
    },
    hasLoadedHeightAt(x,z){
      const lx=x-worldOffset.x,lz=z-worldOffset.z;
      const half=activeRegion.span*0.5;
      if(Math.abs(lx-activeRegion.x)<=half&&Math.abs(lz-activeRegion.z)<=half)return true;
      if(!proceduralPack)return false;
      const sx=Math.round((lx-activeRegion.x)/activeRegion.span);
      const sz=Math.round((lz-activeRegion.z)/activeRegion.span);
      return loadedSections.has(`${sx},${sz}`);
    },
    // Whether height() can be trusted at a point: built, mocked shell, still to come, or outside this coast.
    coverageAt(x,z){
      const lx=x-worldOffset.x,lz=z-worldOffset.z;
      const sx=Math.round((lx-activeRegion.x)/activeRegion.span),sz=Math.round((lz-activeRegion.z)/activeRegion.span);
      if(sx===0&&sz===0)return 'known';
      if(!proceduralPack||Math.abs(sx)>4||Math.abs(sz)>4)return 'none';
      const rec=loadedSections.get(`${sx},${sz}`);
      if(!rec)return 'pending';
      return rec.isMock?'mocked':'known';
    },
    ensureMockAt(x,z){
      if(!proceduralPack)return null;
      const lx=x-worldOffset.x,lz=z-worldOffset.z;
      const sx=Math.round((lx-activeRegion.x)/activeRegion.span);
      const sz=Math.round((lz-activeRegion.z)/activeRegion.span);
      if((sx===0&&sz===0)||Math.abs(sx)>4||Math.abs(sz)>4)return null;
      return ensureMockSection(sx,sz);
    },
    ensureSectionAt(x,z){
      if(!proceduralPack)return;
      const lx=x-worldOffset.x,lz=z-worldOffset.z;
      const sx=Math.round((lx-activeRegion.x)/activeRegion.span);
      const sz=Math.round((lz-activeRegion.z)/activeRegion.span);
      if((sx===0&&sz===0)||Math.abs(sx)>4||Math.abs(sz)>4)return;
      const key=`${sx},${sz}`;
      const existing=loadedSections.get(key);
      if((!existing||existing.isMock)&&!queuedSections.has(key)){
        enqueueCoastalSection(sx,sz,{priority:true,wantRealDEM:true});
      }
    },
    get grownSpace(){
      const summarizeSection=(rec,keyOverride)=>{
        const key=keyOverride??rec.key;
        const queued=queuedSections.has(key);
        return {
          key,
          secX:rec.secX,
          secZ:rec.secZ,
          state:queued?'generating':(rec.state??(rec.isMock?'mocked':'grown')),
          isMock:Boolean(rec.isMock),
          generationCount:rec.generationCount??(rec.isMock?0:1),
          elevationSource:rec.elevationSource??null,
        };
      };
      return {
        get sections(){
          return Array.from(loadedSections.values(),rec=>summarizeSection(rec));
        },
        sectionAt(x,z){
          const lx=x-worldOffset.x,lz=z-worldOffset.z;
          const sx=Math.round((lx-activeRegion.x)/activeRegion.span);
          const sz=Math.round((lz-activeRegion.z)/activeRegion.span);
          if(sx===0&&sz===0){
            return {key:'0,0',secX:0,secZ:0,state:'grown',isMock:false,generationCount:1,elevationSource:proceduralPack?.elevationSource??'procedural'};
          }
          if(!proceduralPack||Math.abs(sx)>4||Math.abs(sz)>4)return null;
          const key=`${sx},${sz}`;
          const rec=loadedSections.get(key);
          if(rec)return summarizeSection(rec,key);
          return {key,secX:sx,secZ:sz,state:queuedSections.has(key)?'generating':'pending',isMock:false,generationCount:0,elevationSource:null};
        },
        async enterAt(x,z){
          if(!proceduralPack||!Number.isFinite(x)||!Number.isFinite(z)){
            return {parcelsGrown:0,sectionsQueued:0,mocksSeeded:0};
          }
          const lx=x-worldOffset.x,lz=z-worldOffset.z;
          lastStreamCheckCam={x:lx,z:lz};
          const out=enterPlayerPosition(lx,lz,{deferProcess:true});
          const pending=sectionQueue.length?processSectionStreamQueue():activeQueuePromise;
          if(pending)await pending;
          return out;
        },
        get stats(){
          let mockedSections=0,generatingSections=0,grownSections=0;
          for(const rec of loadedSections.values()){
            if(rec.isMock){
              if(rec.state==='generating'||queuedSections.has(rec.key))generatingSections++;
              else mockedSections++;
            }else{
              grownSections++;
            }
          }
          return {
            mockedSections,
            generatingSections,
            grownSections,
            totalLoadedSections:loadedSections.size,
            lastPlayerEntry:Number.isFinite(lastStreamCheckCam.x)?{x:lastStreamCheckCam.x,z:lastStreamCheckCam.z}:null,
          };
        },
      };
    },
    get region(){return worldOffset.x||worldOffset.z?{...activeRegion,x:activeRegion.x+worldOffset.x,z:activeRegion.z+worldOffset.z}:activeRegion;},
    get baseRegion(){return activeRegion;},
    // The game's date: the season the meadow's crops and litter stand in.
    setCalendar(ms){
      if(!Number.isFinite(ms))return;
      meadowDateMs=ms;
      meadowGrass?.setCalendar?.(ms);
      for(const sec of loadedSections.values())sec.meadowGrass?.setCalendar?.(ms);
    },
    get views(){return proceduralPack?.views??null;},get port(){return proceduralPack?.port??null;},
    get ports(){return getActivePorts();},
    // What a shot meets among the city's buildings, for js/gunnery-control.js.
    sweepCity(from,to,radius,options,sweepBuilding){return cityTargets?cityTargets.sweep(from,to,radius,options,sweepBuilding):null;},
    get cityTargets(){return cityTargets;},
    // A struck building of the port in view stands whole again at once (js/castle-duel.js rematch).
    rebuildPortBuilding(instance){portFractures?.rebuild(instance);},
    get inlandWater(){return inlandWater;},
    get coastalField(){return coastalField;},
    inlandWaterAt(x,z){return inlandWaterSampler?inlandWaterSampler(x-worldOffset.x,z-worldOffset.z):null;},
    get herds(){return herds;},
    // The land goes with the shot: the herd's test needs the world's shift and the ground under each beast.
    herdsWatch(from,to,best,projectile){return herds?.watchShot?herds.watchShot(from,to,best,projectile,this):best;},
    setStreetMounts(mountSeeds,routes){return herds?.setStreetMounts?.(mountSeeds,routes);},
    refreshBoardFabric,
    get meadowGrass(){return meadowGrass;},
    meadowGrassStats,
    syncHerdsFromBoard(herdsSnap){
      const rebuild=proceduralPack?.port?.country?.rebuildHerds??proceduralPack?.port?._resolvedCountry?.rebuildHerds;
      if(!rebuild||!herdsSnap?.places||!herds)return 0;
      const nextHerds=rebuild(herdsSnap.places);
      proceduralPack.herds=nextHerds??null;
      herds.setHerds?.(proceduralPack.herds);
      return nextHerds?Math.floor(nextHerds.length/8):0;
    },
    get bridges(){return proceduralPack?.port?.country?.bridges??[];},
    getLoadedSections(){
      const half=activeRegion.span*0.5;
      const out=[{
        sx:0,sz:0,
        minX:activeRegion.x+worldOffset.x-half,maxX:activeRegion.x+worldOffset.x+half,
        minZ:activeRegion.z+worldOffset.z-half,maxZ:activeRegion.z+worldOffset.z+half,
        kind:'center',label:'(0,0) CENTER',seamOk:true,
      }];
      for(const rec of loadedSections.values()){
        const r=rec.region;if(!r)continue;
        const h=(r.span??activeRegion.span)*0.5;
        const kind=rec.isMock?'mock':'dem';
        out.push({
          sx:rec.secX,sz:rec.secZ,
          minX:r.x+worldOffset.x-h,maxX:r.x+worldOffset.x+h,
          minZ:r.z+worldOffset.z-h,maxZ:r.z+worldOffset.z+h,
          kind,label:`(${rec.secX},${rec.secZ}) ${kind.toUpperCase()}`,seamOk:true,
        });
      }
      return out;
    },
    get boulderContinuum(){return boulderContinuum;},
    get nearResources(){return nearResources;},
    sweepBoulderSegment(from,to,radius,options){return boulderContinuum?boulderContinuum.sweepBoulderSegment(from,to,radius,options):null;},
    strikeBoulder(event){
      const out=boulderContinuum?boulderContinuum.strikeBoulder(event):null;
      if(out&&!event?.blastOnly){
        const pos=event?.position??event?.surfacePosition??event?.sceneryPos;
        if(Array.isArray(pos)&&Number.isFinite(pos[0])&&Number.isFinite(pos[2])){
          recordBlastRing(pos[0],pos[2],Math.min(1.8,Math.max(0.45,Math.cbrt((event.energy??4e5)/1.1e6))),Boolean(event.heated||event.hot),pos[1]);
        }
      }
      return out;
    },
    setBallisticProjectiles(projectiles,nowSec=0){
      if(Number.isFinite(nowSec))lastBallisticClock=nowSec;
      // A ball passing through the trees parts the boughs along the last of its flight: the trees in its reach take it.
      if(forest){
        const passing=[];
        if(Array.isArray(projectiles))for(let i=0;i<projectiles.length&&passing.length<6;i++){
          const p=projectiles[i];
          if(!p||p.active===false||!Number.isFinite(p.x)||!Number.isFinite(p.z))continue;
          const x=p.x-worldOffset.x,z=p.z-worldOffset.z,y=p.y??0,gy=baseGroundSample(x,z);
          if(!Number.isFinite(gy)||!Number.isFinite(y)||y>gy+45||y<gy-2)continue;
          const vx=p.vx??0,vy=p.vy??0,vz=p.vz??0,back=.12;
          if(!Number.isFinite(vx+vy+vz))continue;
          passing.push({a:[x,y,z],b:[x-vx*back,y-vy*back,z-vz*back],radius:1.6,push:2600,power:1.8});
        }
        forest.setPushers('shot',passing);
      }
      if(!meadowGrass)return;
      if((!projectiles||projectiles.length===0)&&recentBlastRings.length===0&&!hadActiveBallistics)return;
      for(let i=recentBlastRings.length-1;i>=0;i--){
        if(lastBallisticClock-recentBlastRings[i].t0>recentBlastRings[i].maxAge)recentBlastRings.splice(i,1);
      }
      const shots=[];
      if(Array.isArray(projectiles)){
        for(let i=0;i<projectiles.length&&shots.length<16;i++){
          const p=projectiles[i];
          if(!p||p.active===false||!Number.isFinite(p.x)||!Number.isFinite(p.z))continue;
          const lx=p.x-worldOffset.x,lz=p.z-worldOffset.z;
          const gy=baseGroundSample(lx,lz);
          if(!Number.isFinite(gy)||(p.y??0)>gy+8.5||(p.y??0)<gy-2.5)continue;
          shots.push({
            x:lx,
            y:p.y??gy,
            z:lz,
            vx:p.vx??0,
            vy:p.vy??0,
            vz:p.vz??0,
            radius:p.radius??0.08,
            heated:Boolean(p.heated||p.hot||p.heatedShot),
          });
        }
      }
      if(shots.length===0&&recentBlastRings.length===0){
        if(hadActiveBallistics){
          meadowGrass.setBallisticWakes(EMPTY_BALLISTIC_LIST,EMPTY_BALLISTIC_LIST);
          hadActiveBallistics=false;
        }
        return;
      }
      hadActiveBallistics=true;
      const rings=recentBlastRings.map(r=>({
        x:r.x,
        y:r.y,
        z:r.z,
        age:Math.max(0,lastBallisticClock-r.t0),
        maxAge:r.maxAge,
        strength:r.strength,
        speed:r.speed,
        hot:r.hot,
      }));
      meadowGrass.setBallisticWakes(shots,rings);
    },
    setSharedCrew(crewAssets){pendingTradeSharedCrew=crewAssets;tradeVessels?.setSharedCrew?.(crewAssets);},
    // Where the player's guns would fall now ({x,y,z,radius} in the scene's frame, or null): the city's buildings
    // there are cut finer. Four floats a frame at most, written only when they change.
    setGunneryAim(fall){cityAim=fall??null;cityContinuum?.setAim(cityAim);},
    get tradeVessels(){return tradeVessels;},
    setWorldOffset(dx=0,dz=0){
      const nx=Number.isFinite(dx)?dx:0,nz=Number.isFinite(dz)?dz:0;
      if(Math.abs(nx-worldOffset.x)<0.05&&Math.abs(nz-worldOffset.z)<0.05)return;
      worldOffset.x=nx;worldOffset.z=nz;
      cityContinuum?.setWorldOffset(nx,nz);forest?.setWorldOffset(nx,nz);
      boulderContinuum?.setWorldOffset(nx,nz);meadowGrass?.setWorldOffset(nx,nz);
      for(const sec of loadedSections.values())sec.meadowGrass?.setWorldOffset?.(nx,nz);
      landContinuum?.setWorldOffset(nx,nz);
      writeNearDomainUniform();
    },
    getWorldOffset(){return {...worldOffset};},
    commitWorldOffset({boat=null,camera=null,vessels=null,marineLife=null,dolphins=null}={}){
      const dx=worldOffset.x,dz=worldOffset.z;
      if(Math.abs(dx)<0.05&&Math.abs(dz)<0.05)return {dx:0,dz:0};
      if(boat){boat.x-=dx;boat.z-=dz;}
      if(camera&&Number.isFinite(camera.x)&&Number.isFinite(camera.z)){camera.x-=dx;camera.z-=dz;}
      if(Array.isArray(vessels)){
        for(const v of vessels){
          const vb=v?.boat??v;
          if(vb&&vb!==boat&&Number.isFinite(vb.x)&&Number.isFinite(vb.z)){vb.x-=dx;vb.z-=dz;}
        }
      }
      (marineLife?.state??marineLife)?.shift?.(-dx,-dz);
      (dolphins?.state??dolphins)?.shift?.(-dx,-dz);
      worldOffset.x=0;worldOffset.z=0;
      cityContinuum?.setWorldOffset(0,0);forest?.setWorldOffset(0,0);
      boulderContinuum?.setWorldOffset(0,0);meadowGrass?.setWorldOffset(0,0);
      for(const sec of loadedSections.values())sec.meadowGrass?.setWorldOffset?.(0,0);
      landContinuum?.setWorldOffset(0,0);
      writeNearDomainUniform();
      lastCamera=null;
      return {dx,dz};
    },
    dispose(){
      // Real-terrain upgrades and streamed sections can still arrive after this.
      terrainDisposed=true;
      sectionEpoch++;sectionQueue.length=0;queuedSections.clear();plannedSections.clear();
      for(const rec of loadedSections.values())destroySectionRecord(rec);
      loadedSections.clear();
      landContinuum?.destroy();landContinuum=null;landSpecs.clear();landDirty.clear();
      portDamage?.capture(proceduralPack?.port);
      for(const sec of loadedSections.values())portDamage?.capture(sec.port);
      craters?.dispose();landBanks.destroy();
      portFractures?.destroy();
      uniform?.destroy?.();nearDomain?.destroy?.();nearElevation?.destroy?.();coastalField?.destroy();
      elevation?.destroy?.();lighting?.destroy?.();albedo?.destroy?.();groundDetail.dispose();boardStamp?.dispose();
      activeTownField?.texture.destroy();activeTownField?.window.destroy();
      if(nearAlbedo&&nearAlbedo!==albedo)nearAlbedo?.destroy?.();
      biomeTexture?.destroy?.();
      boulderContinuum?.destroy();boulderCardAtlas?.destroy();boulderCardAtlas=null;
      cityContinuumMade++;cityContinuum?.destroy();cityContinuum=null;cityCardAtlas?.destroy();cityCardAtlas=null;cityCardKey='';cityCardRenderer=null;cityCardBindings=null;
      inlandWater?.destroy?.();
      herds?.destroy?.();
      meadowGrass?.destroy?.();
      tradeVessels?.destroy?.();
      forest?.destroy?.();
      if(ownsLandShadows)activeLandShadows.destroy();
    },
    updatePortDamage(now=0){
      let updated=false;
      // Shot at a building writes flight records, nothing else. A palm struck is the forest's to bend.
      const flushPort=(portObj,fractures)=>{
        fractures?.update(now);
        if(!Array.isArray(portObj?.sceneryBakes)||!portObj.sceneryBakes.length)return;
        for(const bake of portObj.sceneryBakes.splice(0,portObj.sceneryBakes.length))if(bake.kind==='scenery-tree')forest?.strike?.(bake.x,bake.z,now,groundSample);
      };
      if(this.pendingForestStrikes?.length){
        for(const struck of this.pendingForestStrikes.splice(0,this.pendingForestStrikes.length))forest?.strikeTree?.(struck.tree,struck.impact,now,groundSample);
      }
      forest?.settleFalls?.(now);
      flushPort(proceduralPack?.port??transientBoulderPort,portFractures);
      for(const sec of loadedSections.values()){
        if(sec.port)flushPort(sec.port,sec.portFractures);
      }
      // A crater goes in the ledger, and on the GPU, the moment its ball lands.
      if(Array.isArray(this.pendingCraters)&&this.pendingCraters.length){
        const hits=this.pendingCraters.splice(0,this.pendingCraters.length);
        for(const hit of hits){
          const local={...hit,x:hit.x-worldOffset.x,z:hit.z-worldOffset.z},record=craters.strike(local),radius=landCraterSize(record.energyJ).radius;
          // The land's cut comes down to the pit's own cell where it is, in every piece it reaches.
          const mark=landCraterMark(record);
          for(const key of landSpecs.keys())landContinuum?.raise(key,mark);
          recordBlastRing(hit.x,hit.z,Math.min(2.0,Math.max(0.45,Math.cbrt((hit.energyJ??4e5)/1.1e6))),Boolean(hit.heated||hit.hot));
          forest?.strike?.(record.x,record.z,now,groundSample);
        }
        portDamage?.setGround(craterCoast,craterLedger.snapshot());
        updated=true;
      }
      return updated;
    },
    get streamedSectionCount(){return loadedSections.size;},
    get streamBusy(){return sectionStreamBusy;},
    get craters(){return craters;},
    get forestStats(){return forest?.stats??null;},
    // How much of the ground at a point is loose sand, from none to all: what the beach survey says, or the low,
    // gentle strand with no green in this coast's imagery, which the land shader leaves bare (landGroundCover).
    sandAt(x,z){
      const lx=x-worldOffset.x,lz=z-worldOffset.z,sec=findNeighborSection(lx,lz),region=sec?.region??activeRegion,beaches=sec?sec.beaches:proceduralPack?.beaches;
      const m=region.biomeSize,u=(lx-region.x)/region.span+.5,v=(lz-region.z)/region.span+.5;
      if(!(u>=0&&v>=0&&u<1&&v<1))return 0;
      const at=Math.floor(v*m)*m+Math.floor(u*m);
      const surveyed=beaches?.drySandMask&&beaches?.swashMask?Math.max(beaches.drySandMask[at],beaches.swashMask[at])/255:0;
      const image=!sec&&proceduralPack?.albedo,size=region.albedoSize;
      if(!image||!size)return surveyed;
      const texel=(Math.floor(v*size)*size+Math.floor(u*size))*4,green=(image[texel+1]-Math.max(image[texel],image[texel+2]))/Math.max(image[texel],image[texel+1],image[texel+2],1);
      const step=(from,to,value)=>Math.max(0,Math.min(1,(value-from)/(to-from)));
      const slope=Math.hypot(heightSample(lx+2,lz)-heightSample(lx-2,lz),heightSample(lx,lz+2)-heightSample(lx,lz-2))/4;
      return Math.max(surveyed,(1-step(.12,.3,green))*(1-step(1.5,3.5,heightSample(lx,lz)))*(1-step(.12,.3,slope)));
    },
    discovery,applyUpgradedPack,
    safeStart(view,boat){return safeLandfallStart(heights,view,boat,this.region,this.height);},
    constrain(boat,x,z,extraOptions=null){return constrainIslandMotion(heights,boat,x,z,this.height,this.region,{ports:this.ports,beaches:proceduralPack?.beaches??null,onGrounding:this.onGrounding,...(extraOptions||{})});},
    waveShelter(x,z,swellDirRad=0){
      const sx=-Math.cos(swellDirRad),sz=-Math.sin(swellDirRad);
      const px=-sz,pz=sx;
      const steps=[36,85,165,280,450,700,1080,1620];
      let tC=1,tL=1,tR=1;
      for(let i=0;i<steps.length;i++){
        const d=steps[i];
        if(heightSample(x+sx*d,z+sz*d)>0.1)tC*=0.12;
        if(heightSample(x+(sx+px*0.32)*d,z+(sz+pz*0.32)*d)>0.1)tL*=0.16;
        if(heightSample(x+(sx-px*0.32)*d,z+(sz-pz*0.32)*d)>0.1)tR*=0.16;
      }
      const transmit=Math.max(0,Math.min(1,0.5*tC+0.25*tL+0.25*tR));
      const bed=heightSample(x,z);
      const surfDamp=bed>-4.2?Math.max(0.18,1-Math.max(0,Math.min(1,(bed+4.2)/4.1))*0.82):1;
      return Math.max(0.22,transmit*surfDamp*0.78+0.22);
    },
    encode(pass,changed=false,frame=null,splitPass=null){
      let p=pass;
      const split=name=>{if(!splitPass)return;const next=splitPass(name);if(next)p=next;};
      if(frame)coastalField.encode(p,frame);
      // The land first: its cut writes the ground it draws (js/continuum-ground.js), which everything after stands on.
      landFlush();landContinuum?.encode(p);
      // Every building shot down, cut as its pieces at the scene's one pixel error.
      let hasPieces=Boolean(portFractures?.continuumDraws?.()?.length);
      if(!hasPieces)for(const sec of loadedSections.values())if(sec.portFractures?.continuumDraws?.()?.length){hasPieces=true;break;}
      split('Continuum scenery');
      if(hasPieces){
        portFractures?.setWorldOffset(worldOffset.x,worldOffset.z);portFractures?.encode(p);
        for(const sec of loadedSections.values()){
          if(!sec.portFractures)continue;
          sec.portFractures.setWorldOffset(worldOffset.x,worldOffset.z);sec.portFractures.encode(p);
        }
      }
      if(boulderContinuum){split('Cut: boulders');boulderContinuum.encode(p);}
      // The city's cut reads the scene's one pixel error itself (js/continuum-scene.js).
      if(cityContinuum){split('Cut: city');cityContinuum.encode(p);}
      if(forest){split('Cut: forest');forest.encode(p);}
      // The step's clock (Frame.camPos.w), so the herd's shot test places each beast at the same instant.
      if(herds){split('Cut: herds');herds.encode(p,frame?frame[19]:null);}
      if(meadowGrass){split('Cut: meadow');meadowGrass.encode(p);}
      for(const sec of loadedSections.values())if(sec.meadowGrass&&(!lastCamera||isSectionVisible(sec.region,lastCamera,lastView,9500)))sec.meadowGrass.encode(p);
      if(tradeVessels?.encode){split('Cut: trade vessels');tradeVessels.encode(p);}
      if((tick++%8)===0||changed){
        p.setPipeline(lightPipe);p.setBindGroup(0,lightGroup);p.dispatchWorkgroups(8,8);
      }
      return p;
    },
    drawFamily(pass,which,camera={x:0,y:6,z:0},viewProjection=null){
      if(which==='land')landContinuum?.draw(pass,landClouds);
      else if(which==='city'){
        cityContinuum?.draw(pass,cityGroup,cityClouds);
        if(portFractures&&isSectionVisible(activeRegion,camera,viewProjection,9000))portFractures.draw(pass,cityGroup,cityClouds);
        for(const sec of loadedSections.values())if(sec.portFractures&&isSectionVisible(sec.region,camera,viewProjection,6500))sec.portFractures.draw(pass,sec.cityGroup,cityClouds);
      }else if(which==='meadow'){
        meadowGrass?.draw(pass);
        for(const sec of loadedSections.values())if(sec.meadowGrass&&isSectionVisible(sec.region,camera,viewProjection,9500))sec.meadowGrass.draw(pass);
      }else if(which==='forest')forest?.draw(pass);
      else if(which==='other'){
        if(boulderContinuum&&isSectionVisible(activeRegion,camera,viewProjection,8500))boulderContinuum.draw(pass);
        if(herds&&isSectionVisible(activeRegion,camera,viewProjection,4500))herds.draw(pass);
        if(tradeVessels&&isSectionVisible(activeRegion,camera,viewProjection,18000))tradeVessels.draw(pass);
      }
    },
    drawSubmerged(pass,above=false){
      if(!submerged)return;
      // Above and below the water alike, the land's coarser cut of the same patches.
      submerged.bind(pass,above);landContinuum?.drawCapture(pass,submergedClouds);
      // Draw submerged pier pilings, quay foundations, bridges, and waterfront masonry into the water refraction pass.
      if(citySubmerged&&citySubmergedGroup&&citySubmergedClouds&&(cityContinuum?.count||portFractures)){
        citySubmerged.bind(pass,above);
        pass.setBindGroup(0,citySubmergedGroup);
        pass.setBindGroup(1,citySubmergedClouds);
        if(cityContinuum?.count){
          pass.setBindGroup(citySubmerged.material.data.group,cityContinuum.dataGroup(citySubmerged.pipeline,citySubmerged.material));
          cityContinuum.drawCaptureLists(pass);
        }
        portFractures?.drawCapture?.(pass,citySubmerged);
      }
      meadowGrass?.drawSubmerged(pass,above);
      for(const sec of loadedSections.values())sec.meadowGrass?.drawSubmerged?.(pass,above);
      tradeVessels?.drawSubmerged?.(pass,above);
    },
    drawOpaqueCity(pass,camera={x:0,y:6,z:0},viewProjection=null){
      if(!lastCamera)updateTrees(camera,viewProjection);
      // Major opaque occluders (city buildings, fractured masonry, boulders) draw first so hardware HSR skips hidden
      // terrain and ocean behind them.
      cityContinuum?.draw(pass,cityGroup,cityClouds);
      if(portFractures&&isSectionVisible(activeRegion,camera,viewProjection,9000))portFractures.draw(pass,cityGroup,cityClouds);
      for(const sec of loadedSections.values()){
        if(sec.portFractures&&isSectionVisible(sec.region,camera,viewProjection,6500))sec.portFractures.draw(pass,sec.cityGroup,cityClouds);
      }
      if(boulderContinuum&&isSectionVisible(activeRegion,camera,viewProjection,8500))boulderContinuum.draw(pass);
    },
    drawOpaqueLand(pass,camera={x:0,y:6,z:0},viewProjection=null){
      // Drawn after the ocean depth prepass so hardware early-Z skips 100% of submerged seabed fragments beneath water.
      landContinuum?.draw(pass,landClouds);
      if(herds&&isSectionVisible(activeRegion,camera,viewProjection,4500))herds.draw(pass);
      if(tradeVessels&&isSectionVisible(activeRegion,camera,viewProjection,18000))tradeVessels.draw(pass);
    },
    drawFoliage(pass){
      // Sample-mask feedback foliage draws strictly after all opaque surfaces (AGENTS.md rule 2 TBDR discipline).
      forest?.draw(pass);
      meadowGrass?.draw(pass);
      for(const sec of loadedSections.values())if(sec.meadowGrass&&(!lastCamera||isSectionVisible(sec.region,lastCamera,lastView,9500)))sec.meadowGrass.draw(pass);
    },
    draw(pass,camera={x:0,y:6,z:0},viewProjection=null){
      this.drawOpaqueCity(pass,camera,viewProjection);
      this.drawOpaqueLand(pass,camera,viewProjection);
      this.drawFoliage(pass);
    },
    drawWater(pass,camera={x:0,y:6,z:0},viewProjection=null){
      if(inlandWater&&isSectionVisible(activeRegion,camera,viewProjection,10000)){
        inlandWater.draw(pass,viewProjection,{shift:[worldOffset.x,worldOffset.z],camPos:[camera.x??0,camera.y??6,camera.z??0]});
      }
    },
    drawShadow(pass,camera={x:0,y:6,z:0},viewProjection=null){
      // A building shot down, or a boulder cleaved, casts its shadow as its pieces, cut for the shadow map.
      if(portFractures&&isSectionVisible(activeRegion,camera,null,2600))portFractures.drawShadow(pass);
      for(const sec of loadedSections.values()){
        if(sec.portFractures&&isSectionVisible(sec.region,camera,null,650))sec.portFractures.drawShadow(pass);
      }
      cityContinuum?.drawShadow(pass);
      if(boulderContinuum&&isSectionVisible(activeRegion,camera,null,750))boulderContinuum.drawShadow(pass);
      forest?.drawShadow?.(pass);
      herds?.drawShadow?.(pass);
      meadowGrass?.drawShadow(pass);
      for(const sec of loadedSections.values())if(sec.meadowGrass&&isSectionVisible(sec.region,camera,null,400))sec.meadowGrass.drawShadow(pass);
      tradeVessels?.drawShadow?.(pass);
    },
    // What casts canvas into the land's canvas map (js/shadows.js createLandShadows): the fleet's sails, while any
    // vessel is out; else null.
    clothShadow(){
      return tradeVessels?.casting?pass=>tradeVessels.drawShadow(pass,true):null;
    },
  };
}

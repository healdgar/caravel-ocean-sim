import { ISLAND, decodeIsland, decodeBiome, islandGeometry, islandVegetation, terrainSample, terrainSurfaceSample, constrainIslandMotion, safeLandfallStart, SPANISH_MAIN_1550_REGIONS, HISTORICAL_COLONIAL_PORTS, resolveColonialEra, generateProceduralCoastalPack, upgradeProceduralPackWithRealDEM } from './terrain-model.js';
import { TREE_VARIANTS, TREE_VERTEX_FLOATS, TREE_PIXEL_ERROR, treeRenderGeometry,
  GROUND_COVER,createGroundCoverPatches,groundCoverInstances,groundCoverGeometry } from './vegetation.js';
import { TERRAIN, TERRAIN_LIGHT } from './wgsl/terrain.js';
import { createCoastalField } from './coastal-field.js';
import { coastalClarity, coastalTurbidityScale } from './sea-colour.js';
import { createSceneryCull, GROUND_COVER_CULL, TREE_CULL } from './scenery-cull.js';
import { loadCanopyScenery, excludeCanopyRoots, createCanopyRenderer, canopyInspectionURL } from './canopy-scenery.js';
import {loadTerrainNear,terrainNearGeometry,terrainNearContains,terrainNearSample,terrainNearPatchBounds,sampleTerrainNear} from './terrain-near.js';
import {chooseForestSurfaceCodec} from './forest-surfaces.js';
import {loadForestScenery,createForestRenderer,FOREST_VERTEX_WGSL,FOREST_SHADOW_WGSL,FOREST_ASSETS,SUBTROPICAL_FOREST_ASSETS,PORTUGAL_FOREST_ASSETS} from './forest-scenery.js';
import {foreshorePalmPlacement} from './forest-trunks.js';
import {loadForestMass,createForestMassRenderer,forestMiddleWoodPartition,FOREST_MASS_VERTEX_WGSL} from './forest-mass.js';
import {loadForestMiddle,FOREST_MIDDLE_ASSETS,SUBTROPICAL_FOREST_MIDDLE_ASSETS,PORTUGAL_FOREST_MIDDLE_ASSETS} from './forest-middle.js';
import {bakeLandImpactDeformations} from './part-assembly.js';
import {buildingFracturePipeline,createPortFractures} from './building-fracture.js';
import {streetEdgeAt} from './town-streets.js';
import {createLandCraterLedger,createLandCraters,landCraterSize} from './land-craters.js';
import {sharedGroundDetail} from './ground-detail.js';
import {createLandShadows} from './shadows.js';

import {
  portClearanceEnvelope,
  PLANT_STREET_GAP_M,
  runLandfallDiscoveryPipeline,
  build1550HistoricalTerritoryPack,
  detectCoastalContinuationDirs,
  prepareSectionConnectedBorders,
  stitchCoastalSectionBorders,
  generateCoastalNeighborSection,
  smoothCoastlineAndForeshoreBeaches,
  synthesizeCoastalBeaches,
  synthesizeCoastalBiome,
  synthesizeCoastalAlbedo,
  buildCoastalMesh,
  classifyKoppenClimateFromNormals,
  estimateLocalClimateProfile,
  fetchPublicClimateProfile,
} from './coastal-world.js';

function hash32Forest(value) {
  let v = value >>> 0;
  v = Math.imul(v ^ (v >>> 16), 0x7feb352d) >>> 0;
  v = Math.imul(v ^ (v >>> 15), 0x846ca68b) >>> 0;
  return (v ^ (v >>> 16)) >>> 0;
}

const FORESHORE_PALMS_MAX = 520;
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
  groundSample,
  { isMobile = false, extraSections = [], maxRootCapacity = null, climateProfile = null } = {}
) {
  const protoCount = forestPack.manifest.prototypes.length;
  const hasCohorts = forestPack.manifest.prototypes.some((p) => Boolean(p.cohort));
  const buckets = Array.from({ length: protoCount }, () => []);
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
    maxRootCapacity ?? (extraSections.length > 0 ? (isMobile ? 24000 : 72000) : (isMobile ? 16000 : 44000));
  const reservedExtra =
    extraSections.length > 0
      ? Math.min(Math.round(effectiveMaxCapacity * 0.35), extraSections.length * (isMobile ? 2400 : 8500))
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
      const baseW = Number.isFinite(w) && w > 0 ? w : 0;
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
  const shadeMod = (sp) => (sp === 'blueberry' ? 1.85 : 0.72 + 0.56 * (SPECIES_SHADE_TOLERANCE[sp] ?? 0.45));
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

  const appendFloats = (dst, src) => {
    for (let k = 0; k < src.length; k++) dst.push(src[k]);
  };

  const seedSectionCanopy = (secPack, secMaxRoots) => {
    const region = secPack.region;
    const span = region.span ?? 8192;
    const areaScale = span < 4096 ? Math.max(0.45, Math.min(1, Math.pow(span / 4096, 1.15))) : 1;
    const effectiveSecMaxRoots = Math.max(64, Math.round(secMaxRoots * areaScale));
    const cacheKey = `${activeClimate.koppenCode ?? activeClimate.climate}:${protoCount}:${effectiveSecMaxRoots}:${span}:${secPack.heights ? secPack.heights[0] : 0}`;
    if (secPack._cachedForestBuckets?.key === cacheKey) {
      const cached = secPack._cachedForestBuckets.buckets;
      for (let i = 0; i < protoCount; i++) {
        if (cached[i].length) appendFloats(buckets[i], cached[i]);
      }
      return;
    }

    const x0 = region.x - span * 0.5;
    const z0 = region.z - span * 0.5;
    const biome = secPack.biome;
    const maskSize = region.biomeSize ?? 256;
    const beaches = secPack.beaches;
    const port = secPack.port;
    const seed = (region.vegetationSeed ?? 47231) >>> 0;
    if (!(biome instanceof Uint8Array) || biome.length !== maskSize * maskSize) return;

    const portCx = port ? port.center.x : proceduralPack.region.x;
    const portCz = port ? port.center.z : proceduralPack.region.z;

    // Pre-index vegetated land cells and stratify into harbor-framing concentric bands
    // so that large 8192m coastal tiles concentrate dense forest stands on the visible
    // harbor hills (0–1,950 m) instead of losing 89% of the tree budget 2–5.5 km inland.
    const validLandCells = [];
    const nearLandCells = [];
    const midLandCells = [];
    const farLandCells = [];
    const drySand = beaches?.drySandMask;
    const swash = beaches?.swashMask;
    const cellSpanM = span / maskSize;
    for (let idx = 0; idx < maskSize * maskSize; idx++) {
      const bVal = biome[idx];
      if (bVal < 42) continue;
      if ((drySand && drySand[idx] > 110) || (swash && swash[idx] > 64)) continue;
      validLandCells.push(idx);
      const bi = idx % maskSize;
      const bj = (idx / maskSize) | 0;
      const cx = x0 + (bi + 0.5) * cellSpanM;
      const cz = z0 + (bj + 0.5) * cellSpanM;
      const dPort = Math.hypot(cx - portCx, cz - portCz);
      const targetPool = dPort <= 950 ? nearLandCells : dPort <= 1950 ? midLandCells : farLandCells;
      targetPool.push(idx);
      if (bVal >= 135) targetPool.push(idx);
    }

    const secBuckets = Array.from({ length: protoCount }, () => []);
    const veteranSpacingFactor = hasCohorts ? (isMobile ? 0.52 : 0.42) : (isMobile ? 0.56 : 0.46);
    const canopySpacingFactor = hasCohorts ? (isMobile ? 0.28 : 0.21) : (isMobile ? 0.30 : 0.21);
    const vetCanopySpacingFactor = hasCohorts ? (isMobile ? 0.25 : 0.19) : (isMobile ? 0.27 : 0.19);
    const cellSize = 20;
    const hashW = Math.ceil(span / cellSize) + 1;
    const head = new Int32Array(hashW * hashW).fill(-1);
    const next = new Int32Array(effectiveSecMaxRoots);
    const rx = new Float32Array(effectiveSecMaxRoots);
    const rz = new Float32Array(effectiveSecMaxRoots);
    const rr = new Float32Array(effectiveSecMaxRoots);
    const rProto = new Uint8Array(effectiveSecMaxRoots);
    const rVet = new Uint8Array(effectiveSecMaxRoots);
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

    const tryPlaceTree = (x, z, key, isSatellite = false, isVeteran = false, isDripLine = false) => {
      if (totalPlaced >= effectiveSecMaxRoots) return -1;
      if (
        x <= x0 + borderMargin ||
        x >= x0 + span - borderMargin ||
        z <= z0 + borderMargin ||
        z >= z0 + span - borderMargin
      ) {
        return -1;
      }

      const probByte = sampleBiomeByte(x, z);
      if (probByte < 42) return -1;
      if (probByte < 108 && (hash32Forest(key + 5) & 255) > probByte + 112) return -1;

      if (port && port.clearRadius > 0) {
        const envPad = port.hasOrthophotoFootprints ? 8 : port.hasIndigenousSettlement ? 8.5 : 10;
        const clearEnv = !portClearanceEnvelope(port, x, z, envPad);
        const clearRad =
          !port.hasOrthophotoFootprints &&
          !port.hasIndigenousSettlement &&
          Math.hypot(x - port.center.x, z - port.center.z) < port.clearRadius * 0.38;
        if (clearEnv || clearRad) return -1;
        if (streetEdgeAt(port.streets, x, z) < PLANT_STREET_GAP_M) return -1;
      }

      const gy = sampleSecGround(x, z);
      const minGy = hasMangrove ? 0.32 : 0.75;
      if (!Number.isFinite(gy) || gy < minGy || gy > 845) return -1;
      const sx = (sampleSecGround(x + 2, z) - sampleSecGround(x - 2, z)) * 0.25;
      const sz = (sampleSecGround(x, z + 2) - sampleSecGround(x, z - 2)) * 0.25;
      const slope = Math.hypot(sx, sz);
      if (!Number.isFinite(slope) || slope > 0.84 || (gy < 24 && slope > 0.36)) return -1;

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
        if (pr.species === 'blueberry') {
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
        const sc = sMin + uScale * sSpan;
        const baseCrownR = pr.crownRadius ?? pr.crownRadiusMetres ?? 8.5;
        const spacingScale = hasCohorts ? (isVeteran || pr.cohort === 'veteran' ? 1.32 : 1.15) : Math.min(sc, 1.35);
        return { scale: sc, crownR: baseCrownR * spacingScale, proto: pr };
      };

      let { scale, crownR, proto } = computeScaleAndRadius(protoId);
      let collision = false;
      let nearestDistSq = Infinity;
      let nearestProto = -1;
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
            const minD = spacingFactor * (crownR + rr[idx]);
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
      next[placedIdx] = head[cell];
      head[cell] = placedIdx;
      totalPlaced++;

      const basal = proto.basalRadius ?? 1.2;
      const sink = Math.min(0.85, Math.max(0.16, basal * scale * slope * 0.65 + 0.12));
      const yaw = (hash32Forest(key + 3) / 4294967296) * Math.PI * 2;
      const tint = 0.92 + (hash32Forest(key + 4) / 4294967296) * 0.16;
      const climateTint = activeClimate.foliageTint ?? (isTrop ? [0.78, 1.12, 0.68] : [1.0, 1.0, 1.0]);
      const rTint = tint * climateTint[0];
      const gTint = tint * climateTint[1];
      const bTint = tint * climateTint[2];
      secBuckets[protoId].push(x, gy - sink, z, scale, yaw, rTint, gTint, bTint, protoId, sink, rootIdentityZ, 0);
      return placedIdx;
    };

    const isVolcanicIsland = region.coastalArchetype === 'volcanic-island';
    const nearBandCut = isVolcanicIsland ? 88 : 123;
    const midBandCut = isVolcanicIsland ? 176 : 212;
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

    // Stage 1: Veteran emergent cohort (~24% of stand) + drip-line nurse & gap satellites
    const veteranBudget = Math.max(16, Math.round(effectiveSecMaxRoots * 0.24));
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
      if (totalPlaced >= Math.round(effectiveSecMaxRoots * 0.68)) break;
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
    secPack._cachedForestBuckets = { key: cacheKey, buckets: secBuckets };
    for (let i = 0; i < protoCount; i++) {
      if (secBuckets[i].length) appendFloats(buckets[i], secBuckets[i]);
    }
  };

  seedSectionCanopy(proceduralPack, baseMaxRoots);
  if (Array.isArray(extraSections) && extraSections.length > 0) {
    const perSecBudget = isMobile ? 1800 : 6500;
    for (const sec of extraSections) {
      const currentTotal = buckets.reduce((acc, b) => acc + b.length / 12, 0);
      const remaining = effectiveMaxCapacity - currentTotal;
      if (remaining < 64) break;
      seedSectionCanopy(sec, Math.min(perSecBudget, remaining));
    }
  }

  // Fallback to explicit scrub/upland arrays if biome grid did not place roots
  if (buckets.every((b) => b.length === 0)) {
    const sources = [
      ...(proceduralPack.vegetation?.scrub || []),
      ...(proceduralPack.vegetation?.upland || []),
    ];
    for (let i = 0; i < sources.length; i += 8) {
      const x = sources[i], z = sources[i + 2];
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
      const sink = Math.max(0.12, basal * scale * slope + 0.08);
      buckets[protoId].push(x, gy - sink, z, scale, yaw, tint, tint, tint, protoId, sink, -2, 0);
    }
  }
  // The foreshore fringe, leaning out over the sea as coconuts do.
  const coconutId = forestPack.manifest.prototypes.findIndex((p) => p.species === 'palm');
  const foreshore = proceduralPack.vegetation?.palms;
  if (coconutId >= 0 && foreshore?.length) {
    const basal = forestPack.manifest.prototypes[coconutId].basalRadius ?? 0.3;
    for (let i = 0; i < foreshore.length && i < FORESHORE_PALMS_MAX * 8; i += 8) {
      const x = foreshore[i], z = foreshore[i + 2], shape = foreshore[i + 5], seaX = -foreshore[i + 6], seaZ = -foreshore[i + 7];
      const gy = groundSample(x, z);
      if (!Number.isFinite(gy) || gy < 1.2) continue;
      const fsx = (groundSample(x + 2, z) - groundSample(x - 2, z)) * 0.25;
      const fsz = (groundSample(x, z + 2) - groundSample(x, z - 2)) * 0.25;
      if (Math.hypot(fsx, fsz) > 0.34) continue;
      const { scale, sink, yaw } = foreshorePalmPlacement(shape, seaX, seaZ, basal);
      const tint = 0.94 + shape * 0.12;
      buckets[coconutId].push(x, gy - sink, z, scale, yaw, tint, tint, tint, coconutId, sink, -2, 0);
    }
  }
  // Ensure at least one subterranean sentinel root if a small coral cay has 0 upland trees
  if (buckets.every(b => b.length === 0)) {
    buckets[0].push(proceduralPack.region.x, -500, proceduralPack.region.z, 0, 0, 1, 1, 1, 0, 0, -2, 0);
  }
  let firstRoot = 0;
  const prototypes = forestPack.manifest.prototypes.map((p, id) => {
    const rootCount = buckets[id].length / 12;
    const next = { ...p, firstRoot, rootCount };
    firstRoot += rootCount;
    return next;
  });
  const roots = new Float32Array(firstRoot * 12);
  let offset = 0;
  for (let id = 0; id < protoCount; id++) {
    roots.set(buckets[id], offset);
    offset += buckets[id].length;
  }
  return {
    ...forestPack,
    roots,
    maxRootCapacity: effectiveMaxCapacity,
    climateProfile: activeClimate,
    manifest: {
      ...forestPack.manifest,
      rootCount: firstRoot,
      prototypes,
    },
  };
}

// Ground cover is resident within this range of the camera, and leaves it a little further out.
const GROUND_RESIDENT_M = 1200;
const GROUND_RESIDENT_RELEASE = 1.15;
const GROUND_RESIDENCY_MOVE_M = 16;
const GROUND_PATCHES_PER_FRAME = 8;

export async function createTerrain({device,frameUBO,transView,skyView,sampler,envCubeView,clouds,shader,computePipe,mipPipe,format,samples,waterOptics=null,
  region:explicitRegion=null,placement=null,options={},
  canopyMode=typeof location==='undefined'?'auto':new URLSearchParams(location.search).get('canopy')||'auto',portDamage=null,landShadows=null}){
  if(!['auto','near','far','off'].includes(canopyMode))throw Error('Unknown canopy scenery mode');
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
  const isKnownSpanishMain=Boolean(spanishMainPreset&&(!hasCustomCoords||(Math.abs(rawLat-spanishMainPreset.latitude)<0.05&&Math.abs(rawLon-spanishMainPreset.longitude)<0.05)));
  const isKnownColonialPreset=Boolean(presetMatch&&(!hasCustomCoords||(Math.abs(rawLat-presetMatch.latitude)<0.05&&Math.abs(rawLon-presetMatch.longitude)<0.05)));
  const isCustomSabaOverride=forceProcedural||(hasCustomCoords&&regionParam==='saba'&&(Math.abs(rawLat-ISLAND.latitude)>0.05||Math.abs(rawLat-ISLAND.longitude)>0.05));
  const useProcedural=forceProcedural||isKnownColonialPreset||(hasCustomCoords&&(regionParam!=='saba'||isCustomSabaOverride));
  const targetLat=presetMatch?presetMatch.latitude:(Number.isFinite(rawLat)?rawLat:ISLAND.latitude);
  const targetLon=presetMatch?presetMatch.longitude:(Number.isFinite(rawLon)?rawLon:ISLAND.longitude);
  let activeClimate=estimateLocalClimateProfile(targetLat,targetLon,presetMatch);
  const forestMixParam=search.get('forestMix');
  const useSubtropicalForest=forestMixParam
    ?(forestMixParam==='subtropical'||forestMixParam==='tropical')
    :(useProcedural&&activeClimate.forestPackKind==='subtropical');
  const usePortugalForest=forestMixParam
    ?(forestMixParam==='portugal'||forestMixParam==='temperate')
    :(useProcedural&&!useSubtropicalForest);
  const isMobile=typeof navigator!=='undefined'&&(/iPhone|iPad|iPod|Android/i.test(navigator.userAgent||'')||(navigator.platform==='MacIntel'&&navigator.maxTouchPoints>1));
  const skipNativeForest=isMobile;
  const load=async path=>{const response=await fetch(path);if(!response.ok)throw new Error(`Saba terrain unavailable (${response.status})`);return response;};
  // Start shader compilation, foliage fetch, and forest downloads immediately in parallel with DEM/terrain loading
  const mipPipePromise=Promise.resolve(mipPipe),cloudsResolvedPromise=Promise.resolve(clouds),waterOpticsResolvedPromise=Promise.resolve(waterOptics);
  mipPipePromise.catch(()=>{});cloudsResolvedPromise.catch(()=>{});waterOpticsResolvedPromise.catch(()=>{});
  const modulePromise=shader(TERRAIN+FOREST_VERTEX_WGSL+FOREST_SHADOW_WGSL+FOREST_MASS_VERTEX_WGSL,'island terrain');
  const meshLayout={arrayStride:32,attributes:[{shaderLocation:0,offset:0,format:'float32x3'},{shaderLocation:1,offset:12,format:'float32x3'},{shaderLocation:2,offset:24,format:'float32x2'}]};
  const treeLayout={arrayStride:TREE_VERTEX_FLOATS*4,attributes:[...meshLayout.attributes,{shaderLocation:5,offset:32,format:'float32x2'}]};
  const treeBuffers=[treeLayout,{arrayStride:32,stepMode:'instance',attributes:[{shaderLocation:3,offset:0,format:'float32x4'},{shaderLocation:4,offset:16,format:'float32x4'}]}];
  const makePipe=(module,entryPoint,buffers,fragmentEntry='fs')=>device.createRenderPipelineAsync({label:entryPoint==='vs'?'island':entryPoint==='groundVS'?'island ground cover':fragmentEntry==='leafFS'?'island trees':'island canopy and wood',layout:'auto',
    vertex:{module,entryPoint,buffers},fragment:{module,entryPoint:fragmentEntry,targets:[{format}]},
    primitive:{topology:'triangle-list',cullMode:'none'},
    depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'greater'},multisample:{count:samples,alphaToCoverageEnabled:fragmentEntry==='leafFS'&&samples>1}});
  const makeShadowPipe=(module,entryPoint,buffers)=>device.createRenderPipelineAsync({
    label:entryPoint==='portShadowVS'?'port shadow':'tree shadow',layout:'auto',
    vertex:{module,entryPoint,buffers},
    primitive:{topology:'triangle-list',cullMode:'none'},
    // No constant bias: it counts in steps of the depth format, and a float's are too fine to matter.
    depthStencil:{format:activeLandShadows.format,depthWriteEnabled:true,depthCompare:'less',depthBiasSlopeScale:1.5},
  });
  const terrainPipesPromise=modulePromise.then(module=>Promise.all([
    makePipe(module,'vs',[meshLayout]),
    makePipe(module,'treeVS',treeBuffers),
    makePipe(module,'treeVS',treeBuffers,'leafFS'),
    makePipe(module,'groundVS',treeBuffers,'groundFS'),
    makeShadowPipe(module,'portShadowVS',[meshLayout]),
    makeShadowPipe(module,'treeShadowVS',treeBuffers),
    computePipe(TERRAIN_LIGHT,'island sunlight'),
    module,
  ]));
  terrainPipesPromise.catch(()=>{});
  const submergedPipesPromise=waterOpticsResolvedPromise.then(wo=>wo?Promise.all([
    wo.capture({source:TERRAIN,vertex:{buffers:[meshLayout]},world:'in.world',groups:2,land:true}),
    wo.capture({source:TERRAIN,vertex:{entryPoint:'groundVS',buffers:treeBuffers},entry:'groundFS',world:'in.world',groups:1,land:true}),
  ]):[null,null]);
  submergedPipesPromise.catch(()=>{});
  const leafBitmapPromise=load('assets/tree-foliage.png').then(r=>r.blob()).then(b=>createImageBitmap(b));
  let canopyFailure=null;
  let forestFailure=null;
  let resolveForestManifest,resolveForestRoots;
  const forestManifestPromise=new Promise(r=>{resolveForestManifest=r;});
  const forestRootsPromise=new Promise(r=>{resolveForestRoots=r;});
  const forceSubtropicalVolume=typeof location!=='undefined'&&search.get('forestVolume')==='force';
  const forestPromise=canopyMode==='off'?Promise.resolve(null):loadForestScenery({
    assets:useSubtropicalForest?SUBTROPICAL_FOREST_ASSETS:usePortugalForest?PORTUGAL_FOREST_ASSETS:FOREST_ASSETS,
    loadAtlases:!useSubtropicalForest&&!usePortugalForest,
    loadVolumes:(!useSubtropicalForest&&!usePortugalForest)||forceSubtropicalVolume,
    skipNative:skipNativeForest&&!useSubtropicalForest&&!usePortugalForest,
    deferNative:!skipNativeForest&&useProcedural&&!useSubtropicalForest&&!usePortugalForest,
    skipRoots:useProcedural,
    deferSurfaces:Boolean(chooseForestSurfaceCodec(device,search.get('forestSurfaces')||'auto')),
    onManifest:resolveForestManifest,
    onRoots:resolveForestRoots,
  }).catch(error=>{forestFailure=error.message;resolveForestManifest(null);resolveForestRoots(null);return null;});
  if(canopyMode==='off'){resolveForestManifest(null);resolveForestRoots(null);}
  const forestMassMode=typeof location==='undefined'?canopyMode:search.get('forestMass')||canopyMode;
  if(!['auto','near','far','off'].includes(forestMassMode))throw Error('Unknown native forest mass mode');
  const forestAtlasDebug=typeof location!=='undefined'&&['auto','force'].includes(search.get('forestImpostor'));
  let forestMassFailure=null,forestMiddleFailure=null,resolveMassManifest;
  const massManifestPromise=new Promise(r=>{resolveMassManifest=r;});
  const massOnly=skipNativeForest||useProcedural;
  // This is a new optional asset, never an alias of the rejected crown pack.
  // Missing/unqualified transport retains the existing native/atlas forest.
  const forestMassPromise=forestManifestPromise.then(forestManifest=>{
    if(!forestManifest||forestMassMode==='off'||useSubtropicalForest||usePortugalForest){resolveMassManifest(null);return null;}
    return loadForestMass({forest:forestManifest,rootsPromise:massOnly?null:forestRootsPromise,manifestOnly:massOnly,onManifest:resolveMassManifest}).catch(error=>{forestMassFailure=error.message;resolveMassManifest(null);return null;});
  });
  const forestMiddlePromise=Promise.all([forestManifestPromise,massManifestPromise]).then(async([forestManifest,massManifest])=>{
    if(!forestManifest||(!massManifest&&!(useSubtropicalForest&&forceSubtropicalVolume))||usePortugalForest||(useSubtropicalForest&&!forceSubtropicalVolume)||forestAtlasDebug)return null;
    try{
      const middle=await loadForestMiddle({
        forest:forestManifest,
        mass:massManifest,
        assets:useSubtropicalForest?SUBTROPICAL_FOREST_MIDDLE_ASSETS:usePortugalForest?PORTUGAL_FOREST_MIDDLE_ASSETS:FOREST_MIDDLE_ASSETS,
      });
      if(middle?.manifest.recipe.leafShading==='field'){
        const forest=await forestRootsPromise;
        if(!forest?.volumes)throw Error('Field-shaded middle requires verified native foliage fields');
      }
      return middle;
    }catch(error){forestMiddleFailure=error.message;return null;}
  });
  // Regional native trees replace the entire old population. The small legacy
  // example is a fallback, never a second stand mixed into the new forest.
  const canopyPromise=forestPromise.then(forest=>useProcedural||forest||canopyMode==='off'?null:loadCanopyScenery().catch(error=>{canopyFailure=error.message;return null;}));
  const autoCurated1550=isKnownSpanishMain&&search.get('discover')!=='1'&&search.get('era')!=='2026'&&search.get('realDEM')!=='off';
  const useRealDEM=useProcedural&&search.get('realDEM')!=='off'&&!autoCurated1550;
  const proceduralGridOpts=isMobile
    ?{size:257,biomeSize:256,albedoSize:512,vegetationCandidates:12000,deferSynthesis:useRealDEM||autoCurated1550}
    :{size:513,biomeSize:512,albedoSize:1024,vegetationCandidates:24000,deferSynthesis:useRealDEM||autoCurated1550};
  const placedX=Number.isFinite(placement?.x)?Number(placement.x):Number.isFinite(explicitObj?.x)?Number(explicitObj.x):undefined;
  const placedZ=Number.isFinite(placement?.z)?Number(placement.z):Number.isFinite(explicitObj?.z)?Number(explicitObj.z):undefined;
  const hasPlacementOverride=placedX!==undefined||placedZ!==undefined;
  const proceduralSpec=isKnownSpanishMain&&!hasPlacementOverride&&resolvedYear===1550
    ?regionParam
    :{
      ...(presetMatch||{}),
      id:regionParam||undefined,
      name:explicitObj?.name||(!ignoreSearchLocation?search.get('regionName'):null)||presetMatch?.name||undefined,
      latitude:targetLat,
      longitude:targetLon,
      year:resolvedYear,
      ...(Number.isFinite(explicitObj?.shoreBearing)?{shoreBearing:Number(explicitObj.shoreBearing)}:{}),
      ...(placedX!==undefined?{x:placedX}:{}),
      ...(placedZ!==undefined?{z:placedZ}:{}),
    };
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
  const craterCoast=activeRegion.id??'saba',craterLedger=createLandCraterLedger(portDamage?.openGround(craterCoast),activeRegion);
  let craters=null,craterLand=null,craterClouds=null;
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
  const groundSample=(x,z)=>{
    if(proceduralPack){
      const sec=findNeighborSection(x,z);
      if(sec)return terrainSurfaceSample(sec.heights,x,z,sec.region);
      return clampToLoadedLandBorder(x,z,terrainSurfaceSample);
    }
    return sampleTerrainNear(nearTile,heights,x,z);
  };
  const heightSample=(x,z)=>{
    if(proceduralPack){
      const sec=findNeighborSection(x,z);
      if(sec)return terrainSample(sec.heights,x,z,sec.region);
      return clampToLoadedLandBorder(x,z,terrainSample);
    }
    return terrainNearSample(nearTile,x,z)??terrainSample(heights,x,z);
  };
  let mesh=proceduralPack?proceduralPack.mesh:islandGeometry(heights,nearTile?.bounds);const fineMesh=nearTile?terrainNearGeometry(nearTile,mesh):null;
  const originalTrees=proceduralPack?proceduralPack.vegetation.trees:islandVegetation(heights,biome);
  // Root positions change once at asset preparation, never as an animation.
  if(nearTile)for(let i=0;i<originalTrees.length;i+=8)if(terrainNearContains(nearTile,originalTrees[i],originalTrees[i+2]))originalTrees[i+1]=groundSample(originalTrees[i],originalTrees[i+2]);
  let canopyTrees=originalTrees,trees=originalTrees;
  let groundPatches=createGroundCoverPatches(activeRegion,groundSample,nearTile?(x,z,span)=>terrainNearPatchBounds(nearTile,x,z,span):null);
  const nearBitmapPromise=nearTile?createImageBitmap(new Blob([nearTile.albedo],{type:'image/png'})):null;
  nearBitmapPromise?.catch(()=>{});
  const buffer=(data,usage,label)=>{
    const b=device.createBuffer({size:Math.max(4,data.byteLength),usage:usage|GPUBufferUsage.COPY_DST,label});
    if(data.byteLength)device.queue.writeBuffer(b,0,data);return b;
  };
  let vertices=buffer(mesh.vertices,GPUBufferUsage.VERTEX,'island vertices');
  let indices=buffer(mesh.indices,GPUBufferUsage.INDEX,'island indices');
  let submergedIndices=mesh.submergedIndices?buffer(mesh.submergedIndices,GPUBufferUsage.INDEX,'submerged island indices'):indices;
  let submergedCount=mesh.submergedIndices?.length??mesh.indices.length;
  let portVertsCpu=proceduralPack?.portGeometry?.vertices??null;
  let portMesh=proceduralPack?.portGeometry?.indices?.length?{
    vertices:buffer(proceduralPack.portGeometry.vertices,GPUBufferUsage.VERTEX,'coastal port prefab vertices'),
    indices:buffer(proceduralPack.portGeometry.indices,GPUBufferUsage.INDEX,'coastal port prefab indices'),
    count:proceduralPack.portGeometry.indices.length,
  }:null;
  // Buildings under fire draw from their own buffers, made when each is first hit.
  const portFracturesFor=(geometry,port,indexBuffer)=>port?.instances?.length&&geometry?.partAssembly&&indexBuffer
    ?(portDamage?.restore(port),createPortFractures({device,port,geometry,portIndices:indexBuffer,groundAt:(x,z)=>heightSample(x,z),damageStore:portDamage})):null;
  let portFractures=portFracturesFor(proceduralPack?.portGeometry,proceduralPack?.port,portMesh?.indices);
  if(portMesh&&proceduralPack?.port?.instances?.length)buildingFracturePipeline(device).catch(()=>{});
  const fine=fineMesh?{vertices:buffer(fineMesh.vertices,GPUBufferUsage.VERTEX,'Wells Bay immutable near vertices'),
    indices:buffer(fineMesh.indices,GPUBufferUsage.INDEX,'Wells Bay near indices'),
    submerged:buffer(fineMesh.submergedIndices,GPUBufferUsage.INDEX,'Wells Bay submerged near indices')}:null;
  const regionalElevationSize=!nearTile&&proceduralPack?257:0;
  const regionalElevationData=regionalElevationSize?new Float32Array(regionalElevationSize*regionalElevationSize):null;
  const getRegionalOcclusionRegion=()=>regionalElevationSize?{x:activeRegion.x,z:activeRegion.z,span:activeRegion.span*5,size:regionalElevationSize}:activeRegion;
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
  const leafImage=await leafBitmapPromise;
  // Preserve the exact source foliage's integrated linear colour when its
  // individual leaves are below the geometric LOD threshold. One authoring
  // image readback at load time; opaque fragments never fetch a leaf texture.
  const leafCanvas=typeof OffscreenCanvas==='function'?new OffscreenCanvas(leafImage.width,leafImage.height):Object.assign(document.createElement('canvas'),{width:leafImage.width,height:leafImage.height});
  const leafContext=leafCanvas.getContext('2d',{willReadFrequently:true});leafContext.drawImage(leafImage,0,0);
  const leafPixels=leafContext.getImageData(0,0,leafImage.width,leafImage.height).data,leafRGB=[0,0,0];let leafWeight=0;
  for(let i=0;i<leafPixels.length;i+=4){const alpha=leafPixels[i+3]/255;leafWeight+=alpha;for(let c=0;c<3;c++)leafRGB[c]+=Math.pow(leafPixels[i+c]/255,2.2)*alpha;}
  const leafMean=buffer(new Float32Array([...leafRGB.map(v=>v/Math.max(leafWeight,1)),leafWeight/(leafPixels.length/4)]),GPUBufferUsage.UNIFORM,'source foliage mean colour');
  const leafMips=1+Math.floor(Math.log2(Math.max(leafImage.width,leafImage.height)));
  const leafTexture=device.createTexture({label:'procedural twig and leaf cutouts',size:[leafImage.width,leafImage.height],format:'rgba8unorm',mipLevelCount:leafMips,
    usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.STORAGE_BINDING|GPUTextureUsage.COPY_DST|GPUTextureUsage.RENDER_ATTACHMENT});
  device.queue.copyExternalImageToTexture({source:leafImage},{texture:leafTexture},[leafImage.width,leafImage.height]);leafImage.close();
  const leafEncoder=device.createCommandEncoder(),leafPass=leafEncoder.beginComputePass();leafPass.setPipeline(mipPipe);
  for(let m=1;m<leafMips;m++){
    leafPass.setBindGroup(0,device.createBindGroup({layout:mipPipe.getBindGroupLayout(0),entries:[
      {binding:0,resource:leafTexture.createView({baseMipLevel:m-1,mipLevelCount:1})},
      {binding:1,resource:leafTexture.createView({baseMipLevel:m,mipLevelCount:1})}]}));
    leafPass.dispatchWorkgroups(Math.ceil(Math.max(1,leafTexture.width>>m)/8),Math.ceil(Math.max(1,leafTexture.height>>m)/8));
  }
  leafPass.end();device.queue.submit([leafEncoder.finish()]);
  const biomeTexture=device.createTexture({label:'regional vegetation probability',size:[activeRegion.biomeSize,activeRegion.biomeSize],format:'r8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
  device.queue.writeTexture({texture:biomeTexture},biome,{bytesPerRow:activeRegion.biomeSize},[activeRegion.biomeSize,activeRegion.biomeSize]);
  const landSampler=device.createSampler({minFilter:'linear',magFilter:'linear',mipmapFilter:'linear',addressModeU:'clamp-to-edge',addressModeV:'clamp-to-edge',maxAnisotropy:4});
  const [terrainPipe,opaqueTreePipe,treePipe,groundPipe,portShadowPipe,treeShadowPipe,lightPipe,module]=await terrainPipesPromise;
  const groundMeshes=Array.from({length:GROUND_COVER.variants},(_,variant)=>{
    const geometry=groundCoverGeometry(variant);return{buffer:buffer(geometry,GPUBufferUsage.VERTEX,`ground cover ${variant}`),count:geometry.length/TREE_VERTEX_FLOATS};
  });
  const [groundCullPipeline,treeCullPipeline]=await Promise.all([computePipe(GROUND_COVER_CULL,'ground cover cull'),computePipe(TREE_CULL,'tree cull')]);
  const groundBlock=GROUND_COVER.grassPerPatch+GROUND_COVER.rocksPerPatch;
  const groundBlocks=Math.ceil(Math.PI*(GROUND_RESIDENT_M*GROUND_RESIDENT_RELEASE/GROUND_COVER.patchSpan+1)**2);
  const groundCull=createSceneryCull({device,pipeline:groundCullPipeline,frameUBO,label:'ground cover',capacity:groundBlocks*groundBlock,
    bucketCapacities:Array.from({length:GROUND_COVER.variants},(_,variant)=>groundBlocks*(variant<2?GROUND_COVER.rocksPerPatch:GROUND_COVER.grassPerPatch)),vertexCounts:[groundMeshes.map(mesh=>mesh.count)]});
  groundCull.setPixelError(TREE_PIXEL_ERROR);
  const groundStats={patches:groundPatches.length,resident:0};
  const groundResident=new Map(),groundFreeBlocks=Array.from({length:groundBlocks},(_,block)=>block);
  let groundWanted=[],groundResidencyAt=null;
  function clearGroundResidency(){
    for(const block of groundResident.values()){groundCull.clearSlots(block*groundBlock,groundBlock);groundFreeBlocks.push(block);}
    groundResident.clear();groundWanted=[];groundResidencyAt=null;groundStats.resident=0;
  }
  // Instances are worked out once per patch and uploaded as it comes into range; the GPU does the rest.
  function updateGroundResidency(camera){
    const moved=!groundResidencyAt||Math.hypot(camera.x-groundResidencyAt.x,camera.z-groundResidencyAt.z)>GROUND_RESIDENCY_MOVE_M;
    if(moved){
      groundResidencyAt={x:camera.x,z:camera.z};
      const distanceOf=patch=>Math.hypot(patch.centre[0]-camera.x,patch.centre[2]-camera.z);
      for(const [patch,block] of groundResident)if(distanceOf(patch)>GROUND_RESIDENT_M*GROUND_RESIDENT_RELEASE){
        groundCull.clearSlots(block*groundBlock,groundBlock);groundFreeBlocks.push(block);groundResident.delete(patch);
      }
      groundWanted=groundPatches.filter(patch=>!groundResident.has(patch)&&distanceOf(patch)<GROUND_RESIDENT_M).sort((a,b)=>distanceOf(b)-distanceOf(a));
    }
    for(let i=0;i<GROUND_PATCHES_PER_FRAME&&groundWanted.length&&groundFreeBlocks.length;i++){
      const patch=groundWanted.pop(),block=groundFreeBlocks.pop(),perVariant=groundCoverInstances(patch,activeRegion,groundSample,biome,(x,z)=>streetEdgeAt(proceduralPack?.port?.streets,x,z)>=GROUND_COVER_STREET_GAP_M&&!craterLedger.covers(x,z));
      const floats=new Float32Array(groundBlock*8),slotGroups=new Uint32Array(groundBlock).fill(0xffffffff);let slot=0;
      perVariant.forEach((data,variant)=>{for(let k=0;k<data.length;k+=8){floats.set(data.subarray(k,k+8),slot*8);slotGroups[slot++]=variant;}});
      groundCull.setInstances(block*groundBlock,floats,slotGroups);groundResident.set(patch,block);
    }
    groundStats.resident=groundResident.size;
  }
  // What grew or lay where a pit has opened is worked out again without it, from the patch's same seed.
  function clearGroundCoverAt(x,z,radius){
    for(const patch of groundPatches){
      if(x+radius<patch.x||x-radius>patch.x+GROUND_COVER.patchSpan||z+radius<patch.z||z-radius>patch.z+GROUND_COVER.patchSpan)continue;
      patch.instances=null;
      const block=groundResident.get(patch);
      if(block===undefined)continue;
      groundCull.clearSlots(block*groundBlock,groundBlock);groundFreeBlocks.push(block);groundResident.delete(patch);
      groundWanted.push(patch);
    }
  }
  const treeMeshes=Array.from({length:3},(_,lod)=>Array.from({length:TREE_VARIANTS},(_,variant)=>{
    const data=treeRenderGeometry(variant,lod);let opaqueEnd=0;
    while(opaqueEnd<data.length&&data[opaqueEnd+6]!==2)opaqueEnd+=TREE_VERTEX_FLOATS*3;
    const part=(data,label)=>({buffer:buffer(data,GPUBufferUsage.VERTEX,label),count:data.length/TREE_VERTEX_FLOATS});
    return {opaque:part(data.subarray(0,opaqueEnd),`tree wood/canopy ${variant} detail ${lod}`),
      leaves:part(data.subarray(opaqueEnd),`tree leaves ${variant} detail ${lod}`)};
  }));
  let treeCull=null;
  // Rebuilt whenever the stand changes. Every tree could show at any detail, so each bucket holds its variant.
  function installTrees(next){
    treeCull?.destroy();treeCull=null;
    const count=next.length/8;if(!count)return;
    const groupOf=new Uint32Array(count),perVariant=new Array(TREE_VARIANTS).fill(0);
    for(let id=0;id<count;id++){const variant=Math.min(TREE_VARIANTS-1,Math.floor(next[id*8+5]*TREE_VARIANTS));groupOf[id]=variant;perVariant[variant]++;}
    const counts=part=>Array.from({length:3*TREE_VARIANTS},(_,bucket)=>treeMeshes[Math.floor(bucket/TREE_VARIANTS)][bucket%TREE_VARIANTS][part].count);
    treeCull=createSceneryCull({device,pipeline:treeCullPipeline,frameUBO,label:'trees',capacity:count,
      bucketCapacities:Array.from({length:3*TREE_VARIANTS},(_,bucket)=>perVariant[bucket%TREE_VARIANTS]),vertexCounts:[counts('opaque'),counts('leaves')]});
    treeCull.setInstances(0,next,groupOf);treeCull.setPixelError(currentPixelError);
  }
  let currentPixelError=TREE_PIXEL_ERROR;
  let lastCamera=null,lastView=null;
  let importedCanopy=null;
  let checkCameraSectionStreaming=null;
  function updateTrees(camera,viewProjection){
    if(Number.isFinite(camera?.pixelError)&&camera.pixelError>0&&camera.pixelError!==currentPixelError){
      currentPixelError=camera.pixelError;
      forestMass?.setPixelError?.(currentPixelError);
      forest?.setPixelError?.(currentPixelError);
      groundCull.setPixelError(currentPixelError,isMobile&&currentPixelError>3.8?1.35:1);
      treeCull?.setPixelError(currentPixelError);
    }
    checkCameraSectionStreaming?.(camera);
    importedCanopy?.prepare(camera,viewProjection);
    updateGroundResidency(camera);
    craters?.follow({x:camera.x-worldOffset.x,z:camera.z-worldOffset.z});
    lastCamera=camera;lastView=viewProjection;

  }
  const bind=(pipe,entries)=>device.createBindGroup({layout:pipe.getBindGroupLayout(0),entries:entries.map(([binding,resource])=>({binding,resource}))});
  const resources=[[0,{buffer:frameUBO}],[1,transView],[2,skyView],[3,sampler],[4,envCubeView],[5,lighting.createView()],[6,{buffer:uniform}],[7,albedo.createView()],[8,landSampler],[9,biomeTexture.createView()],[10,leafTexture.createView()],[11,{buffer:leafMean}],...activeLandShadows.terrainResources];
  const portShadowGroup=bind(portShadowPipe,[[19,{buffer:activeLandShadows.uniform}]]);
  const treeShadowGroup=bind(treeShadowPipe,[[0,{buffer:frameUBO}],[19,{buffer:activeLandShadows.uniform}]]);
  clouds=await cloudsResolvedPromise;waterOptics=await waterOpticsResolvedPromise;
  const [forestMassPack,forestMiddlePack]=await Promise.all([forestMassPromise,forestMiddlePromise]);
  let forestMass=null,proceduralMiddle=null;
  if(forestMassPack&&!forestMassPack.manifestOnly&&!proceduralPack)try{forestMass=await createForestMassRenderer({device,module,frameUBO,shader,resources,clouds,format,samples,pack:forestMassPack,middlePack:forestMiddlePack,mode:forestAtlasDebug?'near':forestMassMode,preview:false});}catch(error){forestMassFailure=error.message;}
  if((skipNativeForest||proceduralPack||useSubtropicalForest)&&(forestMiddlePack||forestMassPack)&&!forestAtlasDebug)try{
    const middleSource=forestMiddlePack??(forestMassPack?.middleVertices?{vertices:forestMassPack.middleVertices,indices:forestMassPack.middleIndices,prototypes:forestMassPack.manifest.prototypes}:null);
    if(middleSource){
      const wood=forestMiddleWoodPartition(middleSource.vertices,middleSource.indices,middleSource.prototypes);
      proceduralMiddle={
        vertices:buffer(middleSource.vertices,GPUBufferUsage.VERTEX,'procedural forest middle vertices'),
        indices:buffer(middleSource.indices,GPUBufferUsage.INDEX,'procedural forest middle indices'),
        prototypes:middleSource.prototypes,
        reduced:!!forestMiddlePack,
        woodIndices:buffer(wood.indices,GPUBufferUsage.INDEX,'procedural forest middle wood indices'),
        woodPrototypes:wood.prototypes,
      };
    }
  }catch(error){proceduralMiddle=null;forestMiddleFailure=error.message;}
  const [canopyPack,forestPack]=await Promise.all([canopyPromise,forestPromise]);
  canopyTrees=canopyPack?excludeCanopyRoots(originalTrees,canopyPack.manifest):originalTrees;
  trees=forestPack?new Float32Array(0):canopyTrees;
  installTrees(trees);
  if(canopyPack)importedCanopy=await createCanopyRenderer({device,module,resources,clouds,format,samples,pack:canopyPack,mode:canopyMode});
  const streamMaxRoots=isMobile?16000:56000;
  const activeForestPack=proceduralPack&&forestPack?retargetForestPackToProcedural(forestPack,proceduralPack,groundSample,{isMobile,maxRootCapacity:streamMaxRoots,climateProfile:activeClimate}):forestPack;
  const activeForestMiddle=forestAtlasDebug?null:(proceduralMiddle??forestMass?.middle??null);
  // What has been shot down on this coast comes back with it, and is kept with the port damage.
  const forestStrikeKey=activeRegion.id??`${activeRegion.latitude},${activeRegion.longitude}`;
  const forest=activeForestPack?await createForestRenderer({device,module,frameUBO,shader,resources,clouds,format,samples,pack:activeForestPack,groundSample:proceduralPack?null:groundSample,forestMass,forestMiddle:activeForestMiddle,mode:canopyMode,savedStrikes:portDamage?.forestStrikes?.(forestStrikeKey)??null,strikeOrigin:{x:activeRegion.x??0,z:activeRegion.z??0},onStrikesChanged:trees=>portDamage?.setForestStrikes?.(forestStrikeKey,trees),terrainOcclusion:typeof location!=='undefined'&&new URLSearchParams(location.search).get('forestOcclusion')==='off'?null:{heights:regionalElevationData??heights,region:getRegionalOcclusionRegion(),near:nearTile??(regionalElevationSize?{heights,manifest:{domain:{x:activeRegion.x,z:activeRegion.z,span:activeRegion.span,size:activeRegion.size}}}:null)}}):null;
  const forestStats=forest?.stats??{loaded:false,mode:canopyMode,error:forestFailure};
  forestStats.mass=forestMass?.stats??{loaded:false,error:forestMassFailure,appearanceErrorSupported:false};
  if(forestStats.mass.middle)forestStats.mass.middle.error=forestMiddleFailure;
  forestStats.replacedProceduralTrees=(canopyTrees.length-trees.length)/8;forestStats.coverage=forestPack?.manifest.coverage??null;
  const canopyStats=importedCanopy?.stats??{loaded:false,mode:canopyMode,error:canopyFailure};
  canopyStats.replacedProceduralTrees=(originalTrees.length-canopyTrees.length)/8;
  canopyStats.coverage=canopyPack?.manifest.coverage??null;
  const canopyInspectionLink=canopyPack&&typeof location!=='undefined'?canopyInspectionURL(location.href,canopyPack.manifest):null;
  // Opaque entry points have no leaf texture in their reachable call graph.
  // Auto layouts therefore correctly omit that binding instead of retaining a
  // dummy sample that would defeat the mobile opaque/feedback separation.
  const opaqueResources=resources.filter(([binding])=>binding!==10);
  // The town's ways as a distance field. A coast without a town binds an empty one.
  const townField=streets=>{
    const size=streets?.size??1;
    const texture=device.createTexture({label:'town ways',size:[size,size],format:'rg8unorm',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST});
    device.queue.writeTexture({texture},streets?.field??new Uint8Array([255,0]),{bytesPerRow:size*2},[size,size]);
    const window=buffer(new Float32Array(streets?[streets.window.x,streets.window.z,streets.window.span,0]:[0,0,0,0]),GPUBufferUsage.UNIFORM,'town ways window');
    return {texture,window,resources:[[14,texture.createView()],[15,{buffer:window}]]};
  };
  let activeTownField=townField(proceduralPack?.port?.streets);
  let nearResources=[...opaqueResources,[12,{buffer:nearDomain}],[13,nearAlbedo.createView()],...activeTownField.resources,...groundDetail.resources];
  const leafResources=resources.filter(([binding])=>binding!==9&&binding!==11);
  const groups=[bind(terrainPipe,nearResources),bind(opaqueTreePipe,nearResources),bind(treePipe,leafResources)];
  const groundGroup=bind(groundPipe,opaqueResources);
  const cloudGroups=[terrainPipe,opaqueTreePipe,treePipe].map(pipe=>clouds.bindVolume(pipe));
  const [submerged,submergedGround]=await submergedPipesPromise;
  let submergedGroup=submerged?.bindGroup(nearResources.map(([binding,resource])=>({binding,resource})));
  const submergedClouds=submerged?clouds.bindVolume(submerged.pipeline):null;
  const submergedGroundGroup=submergedGround?.bindGroup(opaqueResources.map(([binding,resource])=>({binding,resource})));
  const lightGroup=bind(lightPipe,[[0,{buffer:frameUBO}],[4,elevation.createView()],[5,lighting.createView()],[6,{buffer:uniform}],[7,{buffer:nearDomain}],[8,{buffer:nearElevation}]]);
  const cloudLight=clouds.bindVolume(lightPipe,true);
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
  const sectionQueue=[];
  let sectionStreamBusy=false;
  let sectionEpoch=0;
  let lastStreamCheckCam={x:NaN,z:NaN};

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
    const loaded=loadedSections.get(`${sx},${sz}`);
    if(loaded)return loaded;
    if(includePlanned&&queuedSections.has(`${sx},${sz}`)){
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
    rec.vertices?.destroy?.();
    if(rec.submergedIndices&&rec.submergedIndices!==rec.indices)rec.submergedIndices.destroy?.();
    rec.indices?.destroy?.();
    rec.portMesh?.vertices?.destroy?.();
    rec.portMesh?.indices?.destroy?.();
    portDamage?.capture(rec.port);
    rec.portFractures?.destroy();
    rec.uniform?.destroy?.();
    rec.albedo?.destroy?.();
    rec.biomeTexture?.destroy?.();
    rec.townField?.texture.destroy();rec.townField?.window.destroy();
  }

  function buildSectionGPURecord(secPack){
    const sReg=secPack.region;
    const sMesh=secPack.mesh;
    const sVerts=buffer(sMesh.vertices,GPUBufferUsage.VERTEX,`coastal section (${secPack.secX},${secPack.secZ}) vertices`);
    const sIdx=buffer(sMesh.indices,GPUBufferUsage.INDEX,`coastal section (${secPack.secX},${secPack.secZ}) indices`);
    const sSubIdx=sMesh.submergedIndices?buffer(sMesh.submergedIndices,GPUBufferUsage.INDEX,`coastal section (${secPack.secX},${secPack.secZ}) submerged`):sIdx;
    const sSubCount=sMesh.submergedIndices?.length??sMesh.indices.length;
    const needSecPort=Boolean(secPack.portGeometry?.indices?.length&&(!forest||!forestPack||secPack.port?.instances?.length));
    const sPort=needSecPort?{
      vertices:buffer(secPack.portGeometry.vertices,GPUBufferUsage.VERTEX,`coastal section (${secPack.secX},${secPack.secZ}) palms`),
      indices:buffer(secPack.portGeometry.indices,GPUBufferUsage.INDEX,`coastal section (${secPack.secX},${secPack.secZ}) palm indices`),
      count:secPack.portGeometry.indices.length,
    }:null;
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
      [8,landSampler],[9,sBiome.createView()],[11,{buffer:leafMean}],
      [12,{buffer:nearDomain}],[13,nearAlbedo.createView()],
      ...sTownField.resources,...groundDetail.resources,...activeLandShadows.terrainResources,
    ];
    const terrainGroup=bind(terrainPipe,secOpaqueResources);
    const submergedSecGroup=submerged?.bindGroup(secOpaqueResources.map(([binding,resource])=>({binding,resource})));
    return {
      secX:secPack.secX,
      secZ:secPack.secZ,
      key:`${secPack.secX},${secPack.secZ}`,
      elevationSource:secPack.elevationSource,
      connectedEdges:secPack.connectedEdges??null,
      region:sReg,
      heights:secPack.heights,
      rawHeights:secPack.rawHeights,
      biome:secPack.biome,
      beaches:secPack.beaches,
      port:secPack.port,
      vegetation:secPack.vegetation,
      vertices:sVerts,
      meshVertsCpu:sMesh.vertices,
      indices:sIdx,
      indexCount:sMesh.indices.length,
      submergedIndices:sSubIdx,
      submergedCount:sSubCount,
      portMesh:sPort,
      portVertsCpu:needSecPort?secPack.portGeometry?.vertices??null:null,
      portFractures:needSecPort?portFracturesFor(secPack.portGeometry,secPack.port,sPort?.indices):null,
      uniform:sUniform,
      albedo:sAlbedo,
      biomeTexture:sBiome,
      townField:sTownField,
      opaqueResources:secOpaqueResources,
      terrainGroup,
      submergedGroup:submergedSecGroup,
    };
  }

  let cachedPorts=null,portsDirty=true;
  function getActivePorts(){
    if(portsDirty||!cachedPorts){
      cachedPorts=proceduralPack?.port?[proceduralPack.port]:[];
      for(const sec of loadedSections.values())if(sec.port?.instances?.length)cachedPorts.push(sec.port);
      portsDirty=false;
    }
    return cachedPorts;
  }

  function restitchNeighborSection(adjRec){
    if(!adjRec?.rawHeights)return;
    const sReg=adjRec.region;
    const isRealDemSection=Boolean(adjRec.elevationSource?.startsWith('aws-terrarium'));
    const connectedEdges={
      west:Boolean(getSectionAt(adjRec.secX-1,adjRec.secZ,true)),
      east:Boolean(getSectionAt(adjRec.secX+1,adjRec.secZ,true)),
      north:Boolean(getSectionAt(adjRec.secX,adjRec.secZ-1,true)),
      south:Boolean(getSectionAt(adjRec.secX,adjRec.secZ+1,true)),
    };
    const stitched=new Float32Array(adjRec.rawHeights);
    stitchCoastalSectionBorders(stitched,sReg,adjRec.secX,adjRec.secZ,getSectionAt,{taperUnconnectedOuter:true,isRealDemSection});
    smoothCoastlineAndForeshoreBeaches(stitched,sReg,{
      port:null,
      shoreBearing:sReg.shoreBearing??0,
      connectedEdges,
      taperOuterBorders:false,
    });
    stitchCoastalSectionBorders(stitched,sReg,adjRec.secX,adjRec.secZ,getSectionAt,{taperUnconnectedOuter:true,isRealDemSection});
    adjRec.heights.set(stitched);
    adjRec.connectedEdges=connectedEdges;
    adjRec._cachedForestBuckets=null;
    adjRec.beaches=synthesizeCoastalBeaches(sReg,adjRec.heights,null);
    const rebuiltMesh=buildCoastalMesh(sReg,adjRec.heights,adjRec.beaches);
    const oldVerts=adjRec.vertices;
    const oldIdx=adjRec.indices;
    const oldSubIdx=adjRec.submergedIndices&&adjRec.submergedIndices!==adjRec.indices?adjRec.submergedIndices:null;
    adjRec.vertices=buffer(rebuiltMesh.vertices,GPUBufferUsage.VERTEX,`coastal section (${adjRec.secX},${adjRec.secZ}) restitched vertices`);
    adjRec.indices=buffer(rebuiltMesh.indices,GPUBufferUsage.INDEX,`coastal section (${adjRec.secX},${adjRec.secZ}) restitched indices`);
    adjRec.indexCount=rebuiltMesh.indices.length;
    adjRec.submergedIndices=rebuiltMesh.submergedIndices?buffer(rebuiltMesh.submergedIndices,GPUBufferUsage.INDEX,`coastal section (${adjRec.secX},${adjRec.secZ}) restitched submerged`):adjRec.indices;
    adjRec.submergedCount=rebuiltMesh.submergedIndices?.length??rebuiltMesh.indices.length;
    oldVerts?.destroy?.();
    oldIdx?.destroy?.();
    oldSubIdx?.destroy?.();
    craters?.invalidate(sReg);
    adjRec.biome=synthesizeCoastalBiome(sReg,adjRec.heights,adjRec.beaches,adjRec.port,null);
    device.queue.writeTexture({texture:adjRec.biomeTexture},adjRec.biome,{bytesPerRow:sReg.biomeSize},[sReg.biomeSize,sReg.biomeSize]);
    const rebuiltAlbedo=synthesizeCoastalAlbedo(sReg,adjRec.heights,adjRec.beaches,adjRec.port,adjRec.biome,null);
    device.queue.writeTexture({texture:adjRec.albedo},rebuiltAlbedo,{bytesPerRow:sReg.albedoSize*4},[sReg.albedoSize,sReg.albedoSize]);
    regenerateTextureMips(adjRec.albedo,sReg.albedoSize);
  }

  function rebuildNeighborTreeInstances(){
    if(terrainDisposed||!proceduralPack)return;
    updateRegionalElevationGrid();
    if(forest&&forestPack){
      trees=new Float32Array(0);
      installTrees(trees);
      const extraSections=Array.from(loadedSections.values());
      proceduralPack.region=activeRegion;
      proceduralPack.heights=heights;
      proceduralPack.biome=biome;
      const nextForestPack=retargetForestPackToProcedural(
        forestPack,
        proceduralPack,
        groundSample,
        {isMobile,extraSections,maxRootCapacity:streamMaxRoots,climateProfile:activeClimate}
      );
      forest.updatePack(nextForestPack,regionalElevationData??heights,getRegionalOcclusionRegion());
      lastCamera=null;
      return;
    }
    const baseTrees=canopyTrees;
    let totalFloats=baseTrees.length;
    for(const sec of loadedSections.values()){
      totalFloats+=sec.vegetation?.trees?.length||0;
    }
    const merged=new Float32Array(totalFloats);
    merged.set(baseTrees,0);
    let offset=baseTrees.length;
    for(const sec of loadedSections.values()){
      const st=sec.vegetation?.trees;
      if(st?.length){
        merged.set(st,offset);
        offset+=st.length;
      }
    }
    trees=merged;
    installTrees(trees);
    lastCamera=null;
  }

  async function processSectionStreamQueue(){
    if(terrainDisposed||sectionStreamBusy||!proceduralPack||!sectionQueue.length)return;
    sectionStreamBusy=true;
    const myEpoch=sectionEpoch;
    // Synthesize neighboring coastal sections in topological distance order (cardinals before diagonals/2nd ring)
    // using real AWS Terrarium SRTM DEM geography (shared tile cache) so bays, islands, and lagoons appear directly.
    sectionQueue.sort((a,b)=>(Math.abs(a.secX)+Math.abs(a.secZ))-(Math.abs(b.secX)+Math.abs(b.secZ)));
    let streamedCount=0,lastTreeRebuildCount=0;
    while(sectionQueue.length&&myEpoch===sectionEpoch){
      const {secX,secZ,wantRealDEM}=sectionQueue.shift();
      const key=`${secX},${secZ}`;
      try{
        if(!loadedSections.has(key)){
          const useDem=Boolean(wantRealDEM&&search.get('realDEM')!=='off');
          const secPack=await generateCoastalNeighborSection(
            {...proceduralPack,region:activeRegion,heights,rawHeights:proceduralPack.rawHeights||heights},
            secX,
            secZ,
            getSectionAt,
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
          const rec=buildSectionGPURecord(secPack);
          loadedSections.set(key,rec);
          portsDirty=true;
          craters?.invalidate(rec.region);
          for(const [dx,dz,adjEdge] of [[-1,0,'east'],[1,0,'west'],[0,-1,'south'],[0,1,'north']]){
            const adj=loadedSections.get(`${secX+dx},${secZ+dz}`);
            if(adj&&!adj.connectedEdges?.[adjEdge])restitchNeighborSection(adj);
          }
          streamedCount++;
          if(streamedCount===4||sectionQueue.length===0){
            rebuildNeighborTreeInstances();
            lastTreeRebuildCount=streamedCount;
          }
        }
      }catch{/* non-fatal section stream */}
      await new Promise(r=>setTimeout(r,20));
    }
    if(myEpoch===sectionEpoch&&streamedCount>lastTreeRebuildCount){
      rebuildNeighborTreeInstances();
    }
    sectionStreamBusy=false;
  }

  function enqueueCoastalSection(secX,secZ,{priority=false,wantRealDEM=true,deferProcess=false}={}){
    if(!proceduralPack||(secX===0&&secZ===0))return;
    if(Math.abs(secX)>4||Math.abs(secZ)>4)return;
    const key=`${secX},${secZ}`;
    if(loadedSections.has(key)||queuedSections.has(key))return;
    queuedSections.add(key);
    const item={secX,secZ,wantRealDEM};
    if(priority)sectionQueue.unshift(item);
    else sectionQueue.push(item);
    if(!deferProcess)setTimeout(()=>processSectionStreamQueue(),20);
  }

  function seedInitialCoastalSections(){
    if(terrainDisposed||!proceduralPack)return;
    const dirs=detectCoastalContinuationDirs(
      proceduralPack.rawHeights||heights,
      activeRegion.size,
      activeRegion.shoreBearing
    );
    for(const {dx,dz} of dirs){
      enqueueCoastalSection(dx,dz,{wantRealDEM:true,deferProcess:true});
    }
    const connectedCenter={
      west:queuedSections.has('-1,0')||loadedSections.has('-1,0'),
      east:queuedSections.has('1,0')||loadedSections.has('1,0'),
      north:queuedSections.has('0,-1')||loadedSections.has('0,-1'),
      south:queuedSections.has('0,1')||loadedSections.has('0,1'),
    };
    if(connectedCenter.west||connectedCenter.east||connectedCenter.north||connectedCenter.south){
      const modified=prepareSectionConnectedBorders(heights,activeRegion.size,connectedCenter);
      if(proceduralPack.rawHeights&&proceduralPack.rawHeights!==heights){
        prepareSectionConnectedBorders(proceduralPack.rawHeights,activeRegion.size,connectedCenter);
      }
      if(modified){
        device.queue.writeTexture({texture:elevation},heights,{bytesPerRow:activeRegion.size*4},[activeRegion.size,activeRegion.size]);
        const oldVerts=vertices,oldIdx=indices,oldSubIdx=submergedIndices!==indices?submergedIndices:null;
        mesh=buildCoastalMesh(activeRegion,heights,proceduralPack.beaches);
        vertices=buffer(mesh.vertices,GPUBufferUsage.VERTEX,'island vertices border-synced');
        indices=buffer(mesh.indices,GPUBufferUsage.INDEX,'island indices border-synced');
        submergedIndices=mesh.submergedIndices?buffer(mesh.submergedIndices,GPUBufferUsage.INDEX,'submerged island indices border-synced'):indices;
        submergedCount=mesh.submergedIndices?.length??mesh.indices.length;
        oldVerts?.destroy?.();oldIdx?.destroy?.();oldSubIdx?.destroy?.();
        craters?.invalidate(activeRegion);
      }
    }
    if(sectionQueue.length){
      setTimeout(()=>processSectionStreamQueue(),20);
    }
  }

  function resetStreamedSections(){
    sectionEpoch++;
    sectionQueue.length=0;
    queuedSections.clear();
    for(const rec of loadedSections.values())destroySectionRecord(rec);
    loadedSections.clear();
    portsDirty=true;
    lastStreamCheckCam={x:NaN,z:NaN};
    rebuildNeighborTreeInstances();
    seedInitialCoastalSections();
  }

  checkCameraSectionStreaming=camera=>{
    if(!proceduralPack||!camera||!Number.isFinite(camera.x)||!Number.isFinite(camera.z))return;
    if(Math.hypot(camera.x-lastStreamCheckCam.x,camera.z-lastStreamCheckCam.z)<activeRegion.span*0.12)return;
    lastStreamCheckCam={x:camera.x,z:camera.z};
    const span=activeRegion.span;
    const camSecX=Math.round((camera.x-activeRegion.x)/span);
    const camSecZ=Math.round((camera.z-activeRegion.z)/span);
    for(let dz=-1;dz<=1;dz++){
      for(let dx=-1;dx<=1;dx++){
        const sx=camSecX+dx,sz=camSecZ+dz;
        if((sx===0&&sz===0)||Math.abs(sx)>4||Math.abs(sz)>4)continue;
        const key=`${sx},${sz}`;
        if(loadedSections.has(key)||queuedSections.has(key))continue;
        // Stream section only if it borders a loaded section along an edge with land and is within 1.45 * span of camera
        const secCenterX=activeRegion.x+sx*span;
        const secCenterZ=activeRegion.z+sz*span;
        if(Math.hypot(camera.x-secCenterX,camera.z-secCenterZ)>span*1.45)continue;
        if(doesNeighborBorderHaveLand(sx,sz)){
          enqueueCoastalSection(sx,sz,{priority:dx===0&&dz===0,wantRealDEM:true});
        }
      }
    }
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
    heights:new Float32Array(heights),
    rawHeights:proceduralPack.rawHeights?new Float32Array(proceduralPack.rawHeights):new Float32Array(heights),
    biome:new Uint8Array(biome),
    albedo:proceduralPack.albedo?new Uint8Array(proceduralPack.albedo):null,
    mesh:proceduralPack.mesh,
    portGeometry:proceduralPack.portGeometry,
    vegetation:proceduralPack.vegetation,
    beaches:proceduralPack.beaches,
    views:proceduralPack.views,
    port:proceduralPack.port,
  }:null;

  function applyUpgradedPack(upgradedPack,boat=null,isUpgraded=true){
    if(terrainDisposed||!proceduralPack||!upgradedPack?.heights||!upgradedPack?.mesh)return false;
    proceduralPack._cachedForestBuckets=null;
    upgradedPack._cachedForestBuckets=null;
    portsDirty=true;
    if(upgradedPack.region){
      const nextSpan=upgradedPack.region.span||activeRegion.span;
      const nextBearing=Number.isFinite(upgradedPack.region.shoreBearing)?upgradedPack.region.shoreBearing:activeRegion.shoreBearing;
      if(nextSpan!==activeRegion.span||nextBearing!==activeRegion.shoreBearing){
        activeRegion=Object.freeze({...activeRegion,span:nextSpan,shoreBearing:nextBearing});
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
      canopyTrees=upgradedPack.vegetation.trees||canopyTrees;
      trees=forest?[]:canopyTrees;
      installTrees(trees);
    }
    if(upgradedPack.rawHeights)proceduralPack.rawHeights=upgradedPack.rawHeights;
    heights.set(upgradedPack.heights);
    device.queue.writeTexture({texture:elevation},heights,{bytesPerRow:activeRegion.size*4},[activeRegion.size,activeRegion.size]);
    if(upgradedPack.biome&&upgradedPack.biome.byteLength===biome.byteLength){
      biome.set(upgradedPack.biome);
      device.queue.writeTexture({texture:biomeTexture},biome,{bytesPerRow:activeRegion.biomeSize},[activeRegion.biomeSize,activeRegion.biomeSize]);
    }
    if(upgradedPack.albedo){
      device.queue.writeTexture({texture:albedo},upgradedPack.albedo,{bytesPerRow:activeRegion.albedoSize*4},[activeRegion.albedoSize,activeRegion.albedoSize]);
      regenerateAlbedoMips();
    }
    const oldVerts=vertices,oldIdx=indices,oldSubIdx=submergedIndices!==indices?submergedIndices:null,oldPort=portMesh;
    mesh=upgradedPack.mesh;
    vertices=buffer(mesh.vertices,GPUBufferUsage.VERTEX,'island vertices 1550');
    indices=buffer(mesh.indices,GPUBufferUsage.INDEX,'island indices 1550');
    submergedIndices=mesh.submergedIndices?buffer(mesh.submergedIndices,GPUBufferUsage.INDEX,'submerged island indices 1550'):indices;
    submergedCount=mesh.submergedIndices?.length??mesh.indices.length;
    portVertsCpu=upgradedPack.portGeometry?.vertices??null;
    portMesh=upgradedPack.portGeometry?.indices?.length?{
      vertices:buffer(upgradedPack.portGeometry.vertices,GPUBufferUsage.VERTEX,'coastal port prefab vertices 1550'),
      indices:buffer(upgradedPack.portGeometry.indices,GPUBufferUsage.INDEX,'coastal port prefab indices 1550'),
      count:upgradedPack.portGeometry.indices.length,
    }:null;
    oldVerts?.destroy?.();oldIdx?.destroy?.();oldSubIdx?.destroy?.();
    oldPort?.vertices?.destroy?.();oldPort?.indices?.destroy?.();
    // The buildings moved, so their ways did too.
    const oldTownField=activeTownField;
    activeTownField=townField(upgradedPack.port?.streets);
    nearResources=[...opaqueResources,[12,{buffer:nearDomain}],[13,nearAlbedo.createView()],...activeTownField.resources,...groundDetail.resources];
    groups[0]=bind(terrainPipe,nearResources);groups[1]=bind(opaqueTreePipe,nearResources);craterLand=null;
    submergedGroup=submerged?.bindGroup(nearResources.map(([binding,resource])=>({binding,resource})));
    oldTownField.texture.destroy();oldTownField.window.destroy();
    portDamage?.capture(proceduralPack?.port);
    portFractures?.destroy();
    portFractures=portFracturesFor(upgradedPack.portGeometry,upgradedPack.port,portMesh?.indices);
    portFractures?.restoreNow().catch((error)=>console.error('Port damage restore failed',error));

    groundPatches=createGroundCoverPatches(activeRegion,groundSample,null);
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

  let savedPortOverride=null;
  function setCustomPort(customPort=null,customPortGeometry=null){
    if(terrainDisposed||!proceduralPack)return false;
    portsDirty=true;
    if(customPort&&customPortGeometry){
      if(!savedPortOverride){
        savedPortOverride={port:proceduralPack.port,portGeometry:proceduralPack.portGeometry};
      }
      proceduralPack.port=customPort;
      proceduralPack.portGeometry=customPortGeometry;
    }else if(savedPortOverride){
      proceduralPack.port=savedPortOverride.port;
      proceduralPack.portGeometry=savedPortOverride.portGeometry;
      savedPortOverride=null;
    }else{
      return false;
    }
    const nextGeo=proceduralPack.portGeometry;
    const nextPort=proceduralPack.port;
    const oldPort=portMesh;
    portVertsCpu=nextGeo?.vertices??null;
    portMesh=nextGeo?.indices?.length?{
      vertices:buffer(nextGeo.vertices,GPUBufferUsage.VERTEX,'coastal port prefab vertices custom'),
      indices:buffer(nextGeo.indices,GPUBufferUsage.INDEX,'coastal port prefab indices custom'),
      count:nextGeo.indices.length,
    }:null;
    oldPort?.vertices?.destroy?.();oldPort?.indices?.destroy?.();
    portFractures?.destroy();
    portFractures=portFracturesFor(nextGeo,nextPort,portMesh?.indices);
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
        proceduralPack._cachedForestBuckets=null;
        for(const sec of loadedSections.values())sec._cachedForestBuckets=null;
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
  craters=createLandCraters({device,module,shader,computePipe,format,samples,ledger:craterLedger,maxLayers:isMobile?96:384,
    surfaces(){
      const list=[{vertices,indices,count:mesh.indices.length,region:null}];
      if(fine)list.push({vertices:fine.vertices,indices:fine.indices,count:fineMesh.indices.length,region:null});
      for(const sec of loadedSections.values())list.push({vertices:sec.vertices,indices:sec.indices,count:sec.indexCount,region:sec.region});
      return list;
    },
    sectionAt(x,z){
      const sx=Math.round((x-activeRegion.x)/activeRegion.span),sz=Math.round((z-activeRegion.z)/activeRegion.span);
      if(sx===0&&sz===0)return 'main';
      return loadedSections.has(`${sx},${sz}`)?`${sx},${sz}`:null;
    },
    groundAt:(x,z)=>groundSample(x,z),
  });
  return {
    waterGroup:pipe=>coastalField.waterGroup(pipe),
    get turbidityScale(){return coastalTurbidityScale(activeRegion.latitude??0,activeRegion.coastalArchetype);},
    get triangles(){return (mesh.indices.length+(fineMesh?.indices.length??0))/3;},
    get trees(){return trees.length/8+(forest?.stats.roots??0);},
    get treeData(){return trees;},
    // The forest's own roots, as a ball meets them. Null with no forest, and for a moment while one loads.
    get forestTrunks(){return forest?.trunks??null;},
    get forestStrikeKey(){return forest?forestStrikeKey:null;},
    farTreeTriangles:treeMeshes[0].map(mesh=>mesh.opaque.count/3),
    groundStats,groundTriangles:groundMeshes.map(mesh=>mesh.count/3),canopyStats,forestStats,canopyInspectionURL:canopyInspectionLink,
    prepare:updateTrees,groundDetail,
    setPixelError(next){if(Number.isFinite(next)&&next>0){currentPixelError=next;forestMass?.setPixelError?.(next);forest?.setPixelError?.(next);groundCull.setPixelError(next,isMobile&&next>3.8?1.35:1);treeCull?.setPixelError(next);}},
    nearStats:{loaded:!!nearTile,error:nearFailure,domain:nearTile?.manifest.domain??null,triangles:(fineMesh?.indices.length??0)/3},
    height:(x,z)=>heightSample(x-worldOffset.x,z-worldOffset.z),
    groundSample:(x,z)=>groundSample(x-worldOffset.x,z-worldOffset.z),
    hasLoadedHeightAt(x,z){
      const lx=x-worldOffset.x,lz=z-worldOffset.z;
      const half=activeRegion.span*0.5;
      if(Math.abs(lx-activeRegion.x)<=half&&Math.abs(lz-activeRegion.z)<=half)return true;
      if(!proceduralPack)return false;
      const sx=Math.round((lx-activeRegion.x)/activeRegion.span);
      const sz=Math.round((lz-activeRegion.z)/activeRegion.span);
      return loadedSections.has(`${sx},${sz}`);
    },
    // Whether height() can be trusted at a point: built, still to come, or outside this coast.
    coverageAt(x,z){
      const lx=x-worldOffset.x,lz=z-worldOffset.z;
      const sx=Math.round((lx-activeRegion.x)/activeRegion.span),sz=Math.round((lz-activeRegion.z)/activeRegion.span);
      if(sx===0&&sz===0)return 'known';
      if(!proceduralPack||Math.abs(sx)>4||Math.abs(sz)>4)return 'none';
      return loadedSections.has(`${sx},${sz}`)?'known':'pending';
    },
    ensureSectionAt(x,z){
      if(!proceduralPack)return;
      const lx=x-worldOffset.x,lz=z-worldOffset.z;
      const sx=Math.round((lx-activeRegion.x)/activeRegion.span);
      const sz=Math.round((lz-activeRegion.z)/activeRegion.span);
      if((sx===0&&sz===0)||Math.abs(sx)>4||Math.abs(sz)>4)return;
      if(!loadedSections.has(`${sx},${sz}`)&&!queuedSections.has(`${sx},${sz}`)){
        enqueueCoastalSection(sx,sz,{priority:true,wantRealDEM:true});
      }
    },
    get region(){return worldOffset.x||worldOffset.z?{...activeRegion,x:activeRegion.x+worldOffset.x,z:activeRegion.z+worldOffset.z}:activeRegion;},
    get baseRegion(){return activeRegion;},
    get views(){return proceduralPack?.views??null;},get port(){return proceduralPack?.port??null;},
    get ports(){return getActivePorts();},
    setWorldOffset(dx=0,dz=0){
      const nx=Number.isFinite(dx)?dx:0,nz=Number.isFinite(dz)?dz:0;
      if(Math.abs(nx-worldOffset.x)<0.05&&Math.abs(nz-worldOffset.z)<0.05)return;
      worldOffset.x=nx;worldOffset.z=nz;
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
      writeNearDomainUniform();
      lastCamera=null;
      return {dx,dz};
    },
    dispose(){
      // Real-terrain upgrades and streamed sections can still arrive after this.
      terrainDisposed=true;
      sectionEpoch++;sectionQueue.length=0;queuedSections.clear();
      for(const rec of loadedSections.values())destroySectionRecord(rec);
      loadedSections.clear();
      vertices?.destroy?.();
      if(submergedIndices&&submergedIndices!==indices)submergedIndices?.destroy?.();
      indices?.destroy?.();
      portDamage?.capture(proceduralPack?.port);
      for(const sec of loadedSections.values())portDamage?.capture(sec.port);
      craters?.dispose();
      portMesh?.vertices?.destroy?.();portMesh?.indices?.destroy?.();portFractures?.destroy();
      fine?.vertices?.destroy?.();fine?.indices?.destroy?.();fine?.submerged?.destroy?.();
      uniform?.destroy?.();nearDomain?.destroy?.();nearElevation?.destroy?.();coastalField?.destroy();
      elevation?.destroy?.();lighting?.destroy?.();albedo?.destroy?.();groundDetail.dispose();
      activeTownField?.texture.destroy();activeTownField?.window.destroy();
      if(nearAlbedo&&nearAlbedo!==albedo)nearAlbedo?.destroy?.();
      biomeTexture?.destroy?.();leafTexture?.destroy?.();leafMean?.destroy?.();
      for(const g of groundMeshes)g.buffer?.destroy?.();
      groundCull.destroy();
      for(const lod of treeMeshes)for(const v of lod){v.opaque?.buffer?.destroy?.();v.leaves?.buffer?.destroy?.();}
      treeCull?.destroy();
      importedCanopy?.destroy?.();
      forest?.destroy?.();
      forestMass?.destroy?.();
      if(ownsLandShadows)activeLandShadows.destroy();
      proceduralMiddle?.vertices?.destroy?.();proceduralMiddle?.indices?.destroy?.();proceduralMiddle?.woodIndices?.destroy?.();
    },
    updatePortDamage(now=0){
      let updated=false;
      // Shot at a building writes flight records, nothing else. Palms still bend in the port's own mesh.
      const flushPort=(pMesh,pVertsCpu,portObj,fractures)=>{
        fractures?.update(now);
        if(!Array.isArray(portObj?.sceneryBakes)||!portObj.sceneryBakes.length)return;
        for(const bake of portObj.sceneryBakes)if(bake.kind==='scenery-tree')forest?.strike?.(bake.x,bake.z,now,groundSample);
        const bakes=portObj.sceneryBakes.splice(0,portObj.sceneryBakes.length);
        if(!pMesh?.vertices||!pVertsCpu)return;
        const dirty=bakeLandImpactDeformations(pVertsCpu,bakes,8);
        if(dirty){
          device.queue.writeBuffer(pMesh.vertices,dirty.byteOffset,pVertsCpu.buffer,pVertsCpu.byteOffset+dirty.byteOffset,dirty.byteLength);
          updated=true;
        }
      };
      if(this.pendingForestStrikes?.length){
        for(const struck of this.pendingForestStrikes.splice(0,this.pendingForestStrikes.length))forest?.strikeTree?.(struck.tree,struck.impact,now,groundSample);
      }
      forest?.settleFalls?.(now);
      flushPort(portMesh,portVertsCpu,proceduralPack?.port,portFractures);
      for(const sec of loadedSections.values()){
        if(sec.port)flushPort(sec.portMesh,sec.portVertsCpu,sec.port,sec.portFractures);
      }
      // Standing trees where a shot has landed go down with it.
      const felled=(strikes)=>{
        if(!trees?.length)return;
        let treeChanged=false;
        for(const strike of strikes){
          for(let i=0;i<trees.length;i+=8){
            const dx=trees[i]-strike.x,dz=trees[i+2]-strike.z;
            if(dx*dx+dz*dz<=strike.rSq&&trees[i+3]>0.05){
              trees[i+3]*=0.12;
              treeChanged=true;
            }
          }
        }
        if(treeChanged){installTrees(trees);updated=true;}
      };
      if(Array.isArray(this.pendingLandBakes)&&this.pendingLandBakes.length){
        const landBakes=this.pendingLandBakes.splice(0,this.pendingLandBakes.length);
        if(mesh?.vertices&&vertices){
          const dirty=bakeLandImpactDeformations(mesh.vertices,landBakes,8);
          if(dirty){
            device.queue.writeBuffer(vertices,dirty.byteOffset,mesh.vertices.buffer,mesh.vertices.byteOffset+dirty.byteOffset,dirty.byteLength);
            updated=true;
          }
        }
        for(const sec of loadedSections.values()){
          if(sec.vertices&&sec.meshVertsCpu){
            const sDirty=bakeLandImpactDeformations(sec.meshVertsCpu,landBakes,8);
            if(sDirty){
              device.queue.writeBuffer(sec.vertices,sDirty.byteOffset,sec.meshVertsCpu.buffer,sec.meshVertsCpu.byteOffset+sDirty.byteOffset,sDirty.byteLength);
              updated=true;
            }
          }
        }
        felled(landBakes.map(b=>({x:b.x,z:b.z,rSq:Math.max(36,((b.radius??2)*2.6)**2)})));
      }
      // A crater goes in the ledger, and on the GPU, the moment its ball lands.
      if(Array.isArray(this.pendingCraters)&&this.pendingCraters.length){
        const hits=this.pendingCraters.splice(0,this.pendingCraters.length),strikes=[];
        for(const hit of hits){
          const local={...hit,x:hit.x-worldOffset.x,z:hit.z-worldOffset.z},record=craters.strike(local),radius=landCraterSize(record.energyJ).radius;
          clearGroundCoverAt(record.x,record.z,radius*1.35);
          forest?.strike?.(record.x,record.z,now,groundSample);
          strikes.push({x:record.x,z:record.z,rSq:(radius*1.6)**2});
        }
        felled(strikes);
        portDamage?.setGround(craterCoast,craterLedger.snapshot());
        updated=true;
      }
      return updated;
    },
    get streamedSectionCount(){return loadedSections.size;},
    get streamBusy(){return sectionStreamBusy;},
    get craters(){return craters;},
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
    discovery,applyUpgradedPack,setCustomPort,
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
    encode(pass,changed=false,frame=null){
      if(frame)coastalField.encode(pass,frame);
      portFractures?.encode(pass);
      for(const sec of loadedSections.values())sec.portFractures?.encode(pass);
      groundCull.encode(pass);
      treeCull?.encode(pass);
      forestMass?.encode(pass);
      forest?.encode(pass);
      if((tick++%8)!==0&&!changed)return;
      pass.setPipeline(lightPipe);pass.setBindGroup(0,lightGroup);pass.setBindGroup(1,cloudLight);pass.dispatchWorkgroups(8,8);
    },
    drawSubmerged(pass,above=false){
      if(!submerged)return;
      if(above){
        submerged.bind(pass,true);pass.setBindGroup(0,submergedGroup);pass.setBindGroup(1,submergedClouds);pass.setVertexBuffer(0,vertices);pass.setIndexBuffer(indices,'uint32');pass.drawIndexed(mesh.indices.length);
        if(fine&&fineMesh.indices.length){pass.setVertexBuffer(0,fine.vertices);pass.setIndexBuffer(fine.indices,'uint32');pass.drawIndexed(fineMesh.indices.length);}
        for(const sec of loadedSections.values()){
          if(!sec.submergedGroup||!sec.indexCount||!isSectionVisible(sec.region,lastCamera,lastView))continue;
          pass.setBindGroup(0,sec.submergedGroup);pass.setVertexBuffer(0,sec.vertices);pass.setIndexBuffer(sec.indices,'uint32');pass.drawIndexed(sec.indexCount);
        }
      }else{
        if(!submergedCount&&!fineMesh?.submergedIndices.length&&!loadedSections.size)return;
        submerged.bind(pass,false);pass.setBindGroup(0,submergedGroup);pass.setBindGroup(1,submergedClouds);
        if(submergedCount){pass.setVertexBuffer(0,vertices);pass.setIndexBuffer(submergedIndices,'uint32');pass.drawIndexed(submergedCount);}
        if(fine&&fineMesh.submergedIndices.length){pass.setVertexBuffer(0,fine.vertices);pass.setIndexBuffer(fine.submerged,'uint32');pass.drawIndexed(fineMesh.submergedIndices.length);}
        for(const sec of loadedSections.values()){
          if(!sec.submergedGroup||!sec.submergedCount||!isSectionVisible(sec.region,lastCamera,lastView,4500))continue;
          pass.setBindGroup(0,sec.submergedGroup);pass.setVertexBuffer(0,sec.vertices);pass.setIndexBuffer(sec.submergedIndices,'uint32');pass.drawIndexed(sec.submergedCount);
        }
      }
      if(submergedGround){
        submergedGround.bind(pass,above);pass.setBindGroup(0,submergedGroundGroup);
        for(let i=0;i<groundMeshes.length;i++)groundCull.draw(pass,i,0,groundMeshes[i].buffer);
      }
    },
    draw(pass,camera={x:0,y:6,z:0},viewProjection=null){
      updateTrees(camera,viewProjection);
      pass.setPipeline(terrainPipe);pass.setBindGroup(0,groups[0]);pass.setBindGroup(1,cloudGroups[0]);
      pass.setVertexBuffer(0,vertices);pass.setIndexBuffer(indices,'uint32');pass.drawIndexed(mesh.indices.length);
      if(fine&&fineMesh.indices.length){pass.setVertexBuffer(0,fine.vertices);pass.setIndexBuffer(fine.indices,'uint32');pass.drawIndexed(fineMesh.indices.length);}
      if(portMesh&&isSectionVisible(activeRegion,camera,viewProjection,4800)){pass.setVertexBuffer(0,portMesh.vertices);pass.setIndexBuffer(portMesh.indices,'uint32');pass.drawIndexed(portMesh.count);portFractures?.draw(pass);}
      for(const sec of loadedSections.values()){
        if(!isSectionVisible(sec.region,camera,viewProjection))continue;
        pass.setBindGroup(0,sec.terrainGroup);
        pass.setVertexBuffer(0,sec.vertices);pass.setIndexBuffer(sec.indices,'uint32');pass.drawIndexed(sec.indexCount);
        if(sec.portMesh&&isSectionVisible(sec.region,camera,viewProjection,3400)){pass.setVertexBuffer(0,sec.portMesh.vertices);pass.setIndexBuffer(sec.portMesh.indices,'uint32');pass.drawIndexed(sec.portMesh.count);sec.portFractures?.draw(pass);}
      }
      // Dug-up ground draws over the land it replaces, with that land's own textures.
      if(craters?.pipeline&&craters.stats.tiles){
        craterLand??=bind(craters.pipeline,nearResources);craterClouds??=clouds.bindVolume(craters.pipeline);
        craters.draw(pass,'main',craterLand,craterClouds);
        for(const sec of loadedSections.values()){
          if(!isSectionVisible(sec.region,camera,viewProjection))continue;
          sec.craterGroup??=bind(craters.pipeline,sec.opaqueResources);
          craters.draw(pass,`${sec.secX},${sec.secZ}`,sec.craterGroup,craterClouds);
        }
      }
      // Opaque ground props have no cutout/depth reconstruction and no cloud
      // ray march per blade. They remain in Apple's opaque visibility path.
      pass.setPipeline(groundPipe);pass.setBindGroup(0,groundGroup);
      for(let i=0;i<groundMeshes.length;i++)groundCull.draw(pass,i,0,groundMeshes[i].buffer);
      // Draw solid crowns/wood before cutout leaves for Apple hidden-surface
      // removal. The far tier has no alpha foliage or expensive bark fallback.
      for(const[pipe,groupIndex,part]of[[opaqueTreePipe,1,'opaque'],[treePipe,2,'leaves']]){
        // All imported wood/crowns draw before either family's cutout leaves.
        // Opaque terrain and both solid forest paths retain mobile HSR.
        if(part==='opaque'){forestMass?.drawOpaque(pass);importedCanopy?.drawOpaque(pass);forest?.drawOpaque(pass);}
        pass.setPipeline(pipe);pass.setBindGroup(0,groups[groupIndex]);pass.setBindGroup(1,cloudGroups[groupIndex]);
        for(let lod=0;lod<3;lod++)for(let variant=0;variant<TREE_VARIANTS;variant++){
          treeCull?.draw(pass,lod*TREE_VARIANTS+variant,part==='opaque'?0:1,treeMeshes[lod][variant][part].buffer);
        }
      }
      importedCanopy?.drawCutout(pass);
      forest?.drawCutout(pass);
    },
    drawShadow(pass,camera={x:0,y:6,z:0},viewProjection=null){
      pass.setPipeline(portShadowPipe);pass.setBindGroup(0,portShadowGroup);
      if(portMesh&&isSectionVisible(activeRegion,camera,null,750)){
        pass.setVertexBuffer(0,portMesh.vertices);pass.setIndexBuffer(portMesh.indices,'uint32');pass.drawIndexed(portMesh.count);
        portFractures?.draw(pass);
      }
      for(const sec of loadedSections.values()){
        if(sec.portMesh&&isSectionVisible(sec.region,camera,null,650)){
          pass.setVertexBuffer(0,sec.portMesh.vertices);pass.setIndexBuffer(sec.portMesh.indices,'uint32');pass.drawIndexed(sec.portMesh.count);
          sec.portFractures?.draw(pass);
        }
      }
      if(treeCull){
        pass.setPipeline(treeShadowPipe);pass.setBindGroup(0,treeShadowGroup);
        for(let lod=0;lod<2;lod++)for(let variant=0;variant<TREE_VARIANTS;variant++){
          treeCull.draw(pass,lod*TREE_VARIANTS+variant,0,treeMeshes[lod][variant].opaque.buffer);
          treeCull.draw(pass,lod*TREE_VARIANTS+variant,1,treeMeshes[lod][variant].leaves.buffer);
        }
      }
      forest?.drawShadow?.(pass);
    },
  };
}

// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Procedural Coastal World Generator (Spanish Main ~1550 -> Global Scale).
// Synthesizes metric 3D terrain + bathymetry, sandy beaches, biome-appropriate
// vegetation, and modular 16th-century port prefabs within several kilometres
// of shore for curated 1550s Caribbean ports or any global (lat, lon) landfall.

import {
  terrainSample,
  terrainSurfaceSample,
  safeLandfallStart,
} from './terrain-model.js';
import { vegetationProbability } from './vegetation.js';

const COASTAL_DEG_TO_RAD = Math.PI / 180;
const COASTAL_RAD_TO_DEG = 180 / Math.PI;

function coastalMulberry32(seed) {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function coastalHashCoords(lat, lon, salt = 0x51550) {
  const qLat = Math.round(lat * 10000);
  const qLon = Math.round(lon * 10000);
  let h = (salt ^ Math.imul(qLat, 374761393) ^ Math.imul(qLon, 668265263)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

function coastalHash2D(ix, iz, seed) {
  let h = (seed ^ Math.imul(ix, 374761393) ^ Math.imul(iz, 668265263)) >>> 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177) >>> 0;
  return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
}

function coastalSmoothstep(edge0, edge1, x) {
  const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0 || 1)));
  return t * t * (3 - 2 * t);
}

function coastalValueNoise2D(x, z, seed) {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const u = fx * fx * (3 - 2 * fx);
  const v = fz * fz * (3 - 2 * fz);
  const a = coastalHash2D(ix, iz, seed);
  const b = coastalHash2D(ix + 1, iz, seed);
  const c = coastalHash2D(ix, iz + 1, seed);
  const d = coastalHash2D(ix + 1, iz + 1, seed);
  return (a * (1 - u) + b * u) * (1 - v) + (c * (1 - u) + d * u) * v;
}

function coastalFbm2D(x, z, seed, octaves = 4) {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    sum += amp * coastalValueNoise2D(x * freq, z * freq, (seed + i * 1013) >>> 0);
    norm += amp;
    amp *= 0.5;
    freq *= 2.03;
  }
  return sum / norm;
}

function coastalRidgeFbm2D(x, z, seed, octaves = 4) {
  let sum = 0;
  let amp = 0.5;
  let freq = 1;
  let norm = 0;
  for (let i = 0; i < octaves; i++) {
    const n = coastalValueNoise2D(x * freq, z * freq, (seed + i * 1619) >>> 0);
    const ridge = 1 - Math.abs(2 * n - 1);
    sum += amp * ridge * ridge;
    norm += amp;
    amp *= 0.5;
    freq *= 2.07;
  }
  return sum / norm;
}

// Curated ~1550 Spanish Main & Caribbean landfalls.
export const SPANISH_MAIN_1550_REGIONS = Object.freeze({
  saba: Object.freeze({
    id: 'saba',
    name: 'Saba · Wells Bay',
    era: 1550,
    regionGroup: 'Lesser Antilles',
    latitude: 17.635,
    longitude: -63.238,
    climate: 'tropical',
    coastalArchetype: 'volcanic-island',
    portType: 'careening-anchorage',
    shoreBearing: 112,
    peakElevationMetres: 870,
    span: 8192,
    size: 129,
    biomeSize: 128,
    albedoSize: 128,
    x: 0,
    z: -6000,
    vegetationSeed: 47231,
    vegetationCandidates: 16000,
    procedural: true,
  }),
  cartagena: Object.freeze({
    id: 'cartagena',
    name: 'Cartagena de Indias',
    era: 1550,
    regionGroup: 'Tierra Firme',
    latitude: 10.423,
    longitude: -75.548,
    climate: 'tropical',
    coastalArchetype: 'sheltered-bay',
    portType: 'fortified-harbor',
    shoreBearing: 82,
    peakElevationMetres: 165,
    span: 8192,
    size: 129,
    biomeSize: 128,
    albedoSize: 128,
    x: 0,
    z: -6000,
    vegetationSeed: 58109,
    vegetationCandidates: 18000,
    procedural: true,
  }),
  'nombre-de-dios': Object.freeze({
    id: 'nombre-de-dios',
    name: 'Nombre de Dios',
    era: 1550,
    regionGroup: 'Castilla del Oro',
    latitude: 9.579,
    longitude: -79.476,
    climate: 'tropical',
    coastalArchetype: 'estuary-bay',
    portType: 'silver-terminal',
    shoreBearing: 168,
    peakElevationMetres: 310,
    span: 8192,
    size: 129,
    biomeSize: 128,
    albedoSize: 128,
    x: 0,
    z: -6000,
    vegetationSeed: 63947,
    vegetationCandidates: 20000,
    procedural: true,
  }),
  'santo-domingo': Object.freeze({
    id: 'santo-domingo',
    name: 'Santo Domingo · Río Ozama',
    era: 1550,
    regionGroup: 'Hispaniola',
    latitude: 18.472,
    longitude: -69.883,
    climate: 'tropical',
    coastalArchetype: 'river-mouth',
    portType: 'river-citadel',
    shoreBearing: 15,
    peakElevationMetres: 210,
    span: 8192,
    size: 129,
    biomeSize: 128,
    albedoSize: 128,
    x: 0,
    z: -6000,
    vegetationSeed: 71317,
    vegetationCandidates: 17000,
    procedural: true,
  }),
  havana: Object.freeze({
    id: 'havana',
    name: 'San Cristóbal de La Habana',
    era: 1550,
    regionGroup: 'Cuba',
    latitude: 23.141,
    longitude: -82.352,
    climate: 'subtropical',
    coastalArchetype: 'harbor-channel',
    portType: 'rendezvous-basin',
    shoreBearing: 145,
    peakElevationMetres: 140,
    span: 8192,
    size: 129,
    biomeSize: 128,
    albedoSize: 128,
    x: 0,
    z: -6000,
    vegetationSeed: 84221,
    vegetationCandidates: 16500,
    procedural: true,
  }),
  'san-juan': Object.freeze({
    id: 'san-juan',
    name: 'San Juan de Puerto Rico',
    era: 1550,
    regionGroup: 'Borikén',
    latitude: 18.468,
    longitude: -66.118,
    climate: 'tropical',
    coastalArchetype: 'headland-bay',
    portType: 'headland-fortress',
    shoreBearing: 132,
    peakElevationMetres: 260,
    span: 8192,
    size: 129,
    biomeSize: 128,
    albedoSize: 128,
    x: 0,
    z: -6000,
    vegetationSeed: 91753,
    vegetationCandidates: 17500,
    procedural: true,
  }),
});

export const PORT_PREFABS = Object.freeze({
  timber_mole_pier: Object.freeze({
    id: 'timber_mole_pier',
    label: 'Timber Mole & Mooring Pier',
    length: 68,
    width: 7.5,
    height: 2.8,
    foundationDepth: 8.5,
    materialKind: 10,
    roofPitch: 0,
    waterfront: true,
  }),
  stone_sea_bastion: Object.freeze({
    id: 'stone_sea_bastion',
    label: '16th-Century Stone Sea Bastion (Baluarte)',
    length: 34,
    width: 28,
    height: 11.5,
    foundationDepth: 6.0,
    materialKind: 11,
    roofPitch: 0,
    waterfront: true,
  }),
  casa_de_contratacion: Object.freeze({
    id: 'casa_de_contratacion',
    label: 'Casa de la Contratación (Royal Customhouse)',
    length: 26,
    width: 16,
    height: 8.5,
    foundationDepth: 3.5,
    materialKind: 12,
    roofPitch: 2.6,
    waterfront: false,
  }),
  royal_warehouse: Object.freeze({
    id: 'royal_warehouse',
    label: 'Almacén Real (King’s Storehouses)',
    length: 30,
    width: 14,
    height: 7.2,
    foundationDepth: 3.0,
    materialKind: 12,
    roofPitch: 2.2,
    waterfront: false,
  }),
  careening_shed: Object.freeze({
    id: 'careening_shed',
    label: 'Careening Beach Shed & Pitch Works',
    length: 22,
    width: 11,
    height: 5.6,
    foundationDepth: 2.5,
    materialKind: 10,
    roofPitch: 2.0,
    waterfront: true,
  }),
  mission_chapel: Object.freeze({
    id: 'mission_chapel',
    label: 'Iglesia & Bell Tower',
    length: 28,
    width: 13,
    height: 12.0,
    foundationDepth: 3.5,
    materialKind: 12,
    roofPitch: 3.4,
    waterfront: false,
  }),
  colonial_town_block: Object.freeze({
    id: 'colonial_town_block',
    label: 'Walled Adobe & Tile Town Block',
    length: 24,
    width: 18,
    height: 6.4,
    foundationDepth: 3.0,
    materialKind: 12,
    roofPitch: 2.0,
    waterfront: false,
  }),
});

function coastalInferBearingFromRings(lat, lon, rings) {
  if (!Array.isArray(rings) || rings.length === 0) return null;
  const cosLat = Math.max(0.1, Math.cos(lat * COASTAL_DEG_TO_RAD));
  let bestDistSq = Infinity;
  let bestBearing = null;
  for (const ring of rings) {
    if (!Array.isArray(ring) || ring.length < 2) continue;
    for (let i = 0; i < ring.length - 1; i++) {
      const [lon0, lat0] = ring[i];
      const [lon1, lat1] = ring[i + 1];
      const ax = (lon0 - lon) * cosLat;
      const ay = lat0 - lat;
      const bx = (lon1 - lon) * cosLat;
      const by = lat1 - lat;
      const dx = bx - ax;
      const dy = by - ay;
      const lenSq = dx * dx + dy * dy;
      if (lenSq < 1e-12) continue;
      const t = Math.max(0, Math.min(1, -(ax * dx + ay * dy) / lenSq));
      const px = ax + dx * t;
      const py = ay + dy * t;
      const dSq = px * px + py * py;
      if (dSq < bestDistSq) {
        bestDistSq = dSq;
        // Normal pointing from sea toward land segment or perpendicular to tangent
        const nx = px === 0 && py === 0 ? -dy : px;
        const ny = px === 0 && py === 0 ? dx : py;
        bestBearing = ((Math.atan2(nx, ny) * COASTAL_RAD_TO_DEG) % 360 + 360) % 360;
      }
    }
  }
  return bestBearing;
}

export function resolveGlobalCoastalRegion(spec = 'cartagena') {
  if (typeof spec === 'string') {
    const preset = SPANISH_MAIN_1550_REGIONS[spec];
    if (!preset) throw new RangeError(`Unknown Spanish Main coastal region: ${spec}`);
    return preset;
  }
  if (!spec || typeof spec !== 'object') {
    throw new TypeError('Coastal region spec must be a region ID or coordinate descriptor');
  }
  if (typeof spec.id === 'string' && SPANISH_MAIN_1550_REGIONS[spec.id] && spec.latitude === undefined) {
    return Object.freeze({ ...SPANISH_MAIN_1550_REGIONS[spec.id], ...spec });
  }
  const latitude = Number(spec.latitude);
  const longitude = Number(spec.longitude);
  if (!Number.isFinite(latitude) || latitude < -85 || latitude > 85) {
    throw new RangeError('Coastal region latitude must be finite within [-85, 85]');
  }
  if (!Number.isFinite(longitude) || longitude < -180 || longitude > 180) {
    throw new RangeError('Coastal region longitude must be finite within [-180, 180]');
  }
  const seed = (spec.vegetationSeed ?? coastalHashCoords(latitude, longitude)) >>> 0;
  const rand = coastalMulberry32(seed);
  const absLat = Math.abs(latitude);
  const climate = spec.climate ?? (
    absLat < 20 ? 'tropical' :
    absLat < 34 ? 'subtropical' :
    absLat < 58 ? 'temperate' : 'subpolar'
  );
  const archetypes = ['sheltered-bay', 'headland-bay', 'estuary-bay', 'river-mouth', 'harbor-channel', 'volcanic-island'];
  const portTypes = ['fortified-harbor', 'headland-fortress', 'silver-terminal', 'river-citadel', 'rendezvous-basin', 'careening-anchorage'];
  const idx = Math.floor(rand() * archetypes.length);
  const coastalArchetype = spec.coastalArchetype ?? archetypes[idx];
  const portType = spec.portType ?? portTypes[idx];
  const ringBearing = coastalInferBearingFromRings(latitude, longitude, spec.coastlineRings);
  const shoreBearing = Number.isFinite(spec.shoreBearing)
    ? ((spec.shoreBearing % 360) + 360) % 360
    : ringBearing ?? Math.round(rand() * 359);
  const peakElevationMetres = Number.isFinite(spec.peakElevationMetres)
    ? Math.max(40, Math.min(900, spec.peakElevationMetres))
    : Math.round(95 + rand() * (coastalArchetype === 'volcanic-island' ? 680 : 320));
  const size = spec.size ?? 129;
  const biomeSize = spec.biomeSize ?? (size - 1);
  const albedoSize = spec.albedoSize ?? (size - 1);
  const span = spec.span ?? 8192;
  const id = spec.id ?? `coastal-${latitude.toFixed(3)}_${longitude.toFixed(3)}`;
  const name = spec.name ?? `Coastal Landfall (${Math.abs(latitude).toFixed(2)}°${latitude >= 0 ? 'N' : 'S'}, ${Math.abs(longitude).toFixed(2)}°${longitude >= 0 ? 'E' : 'W'})`;
  return Object.freeze({
    id,
    name,
    era: spec.era ?? 1550,
    regionGroup: spec.regionGroup ?? (
      latitude >= 7 && latitude <= 26 && longitude >= -90 && longitude <= -59
        ? 'Spanish Main'
        : 'Global Coast'
    ),
    latitude,
    longitude,
    climate,
    coastalArchetype,
    portType,
    shoreBearing,
    peakElevationMetres,
    span,
    size,
    biomeSize,
    albedoSize,
    x: spec.x ?? 0,
    z: spec.z ?? -6000,
    vegetationSeed: seed,
    vegetationCandidates: spec.vegetationCandidates ?? 16000,
    procedural: true,
  });
}

// Local coastal frame: maps world (x, z) into (alongShore, inlandDist) in metres
// relative to the region center, oriented so approaching along `shoreBearing`
// travels from open water (inlandDist < 0) into the sheltered harbor & shore (inlandDist > 0).
export function coastalFrame(region, x, z) {
  const dx = x - region.x;
  const dz = z - region.z;
  const bearing = (region.shoreBearing ?? 112) * COASTAL_DEG_TO_RAD;
  // Compass heading: +sin(bearing) along +X, -cos(bearing) along +Z.
  const fwdX = Math.sin(bearing);
  const fwdZ = -Math.cos(bearing);
  const rightX = -fwdZ;
  const rightZ = fwdX;
  const inland = dx * fwdX + dz * fwdZ;
  const along = dx * rightX + dz * rightZ;
  return { inland, along, fwdX, fwdZ, rightX, rightZ };
}

export function worldFromCoastalFrame(region, along, inland) {
  const bearing = (region.shoreBearing ?? 112) * COASTAL_DEG_TO_RAD;
  const fwdX = Math.sin(bearing);
  const fwdZ = -Math.cos(bearing);
  const rightX = -fwdZ;
  const rightZ = fwdX;
  return {
    x: region.x + along * rightX + inland * fwdX,
    z: region.z + along * rightZ + inland * fwdZ,
  };
}

export function synthesizeCoastalTerrain(regionSpec = 'cartagena') {
  const region = resolveGlobalCoastalRegion(regionSpec);
  const n = region.size;
  const span = region.span;
  const seed = region.vegetationSeed >>> 0;
  const heights = new Float32Array(n * n);
  const peak = region.peakElevationMetres ?? 240;
  const isIsland = region.coastalArchetype === 'volcanic-island';
  const hasEstuary = region.coastalArchetype === 'river-mouth' || region.coastalArchetype === 'estuary-bay';

  for (let j = 0; j < n; j++) {
    const z = region.z + (j / (n - 1) - 0.5) * span;
    for (let i = 0; i < n; i++) {
      const x = region.x + (i / (n - 1) - 0.5) * span;
      const { inland, along } = coastalFrame(region, x, z);
      const nx = along / (span * 0.5);
      const nz = inland / (span * 0.5);

      const macroWarping = (coastalFbm2D(nx * 1.6 + 3.1, nz * 1.6 - 1.7, seed, 4) - 0.5) * 420;
      const mesoDetail = (coastalFbm2D(nx * 4.5 - 2.3, nz * 4.5 + 5.1, seed ^ 0x13579bdf, 4) - 0.5) * 65;
      const ridge = coastalRidgeFbm2D(nx * 2.4 + 1.1, nz * 2.4 + 0.7, seed ^ 0x2468ace0, 4);

      let signedShore;
      if (isIsland) {
        // Volcanic island centered near (along=0, inland=450m) with a concave bay at (along=0, inland=-950m)
        const radius = span * 0.27;
        const dist = Math.hypot(along, inland - 420);
        const bayIndent = 340 * Math.exp(-(along * along) / (2 * 520 * 520)) * coastalSmoothstep(600, -900, inland);
        signedShore = radius - dist - bayIndent + macroWarping * 0.45 + mesoDetail * 0.35;
      } else {
        // Mainland / major island coast with a sheltered concave bay around along = 0
        // and protective rocky headlands around |along| ~ 1050m.
        const bayIndent = 520 * Math.exp(-(along * along) / (2 * 680 * 680));
        const headlandLeft = 360 * Math.exp(-((along + 1100) ** 2) / (2 * 420 * 420));
        const headlandRight = 320 * Math.exp(-((along - 1100) ** 2) / (2 * 420 * 420));
        const shoreLineInland = -350 + bayIndent - headlandLeft - headlandRight - macroWarping - mesoDetail * 0.4;
        signedShore = inland - shoreLineInland;
      }

      // Navigable harbor channel & anchorage basin along the bay axis (along ~ 0)
      const channelWidth = 260 + coastalSmoothstep(0, -1800, signedShore) * 280;
      const inChannel = Math.exp(-(along * along) / (2 * channelWidth * channelWidth));
      // Estuary / river channel cutting inland on river-citadel or silver-terminal ports
      const riverOffset = Math.sin(inland / 380) * 140;
      const riverMask = hasEstuary
        ? Math.exp(-((along - 220 - riverOffset) ** 2) / (2 * 95 * 95)) * coastalSmoothstep(-300, 1400, signedShore)
        : 0;

      // Beach coves have gentle foreshore slope; headlands have steeper cliffs.
      const bayShelter = Math.exp(-(along * along) / (2 * 780 * 780));
      const headlandFactor = Math.max(
        Math.exp(-((along + 1100) ** 2) / (2 * 380 * 380)),
        Math.exp(-((along - 1100) ** 2) / (2 * 380 * 380))
      );

      let h;
      if (signedShore <= 0) {
        const offshoreDist = -signedShore;
        const nearShoreSlope = 0.024 * bayShelter + 0.055 * (1 - bayShelter);
        const deepShelf = Math.max(0, offshoreDist - 180) * 0.055;
        const baseDepth = -Math.min(120, offshoreDist * nearShoreSlope + deepShelf);
        const channelDepth = -Math.min(28, 14.5 + offshoreDist * 0.022) * inChannel * coastalSmoothstep(-140, -380, signedShore);
        h = Math.max(-120, Math.min(baseDepth, channelDepth));
      } else {
        // Foreshore beach zone (0..320m inland in the sheltered bay) transitions to coastal terrace and inland mountains
        const beachRamp = Math.min(signedShore, 340) * (0.018 * bayShelter + 0.065 * (1 - bayShelter) + 0.16 * headlandFactor);
        const inlandRise = Math.max(0, signedShore - 300);
        const mountainFactor = coastalSmoothstep(80, 1950, inlandRise);
        const hillHeight = peak * mountainFactor * (0.38 + 0.62 * ridge) + Math.max(0, mesoDetail) * mountainFactor * 0.45;
        // Port terrace flattening near the sheltered harbor shore (along ~ [-280, +280], signedShore ~ [40, 320])
        const terraceMask = Math.exp(-(along * along) / (2 * 340 * 340)) * coastalSmoothstep(25, 90, signedShore) * coastalSmoothstep(420, 220, signedShore);
        const rawLand = beachRamp + hillHeight;
        const terraced = rawLand * (1 - terraceMask * 0.65) + 3.8 * (terraceMask * 0.65);
        h = terraced * (1 - riverMask * 0.92) - 3.2 * riverMask;
      }

      heights[j * n + i] = Math.max(-120, Math.min(895, h));
    }
  }
  return heights;
}

export function synthesizeCoastalBeaches(regionSpec, heights) {
  const region = resolveGlobalCoastalRegion(regionSpec);
  const m = region.biomeSize;
  const span = region.span;
  const swashMask = new Uint8Array(m * m);
  const drySandMask = new Uint8Array(m * m);
  let beachCellCount = 0;
  const cells = [];

  for (let j = 0; j < m; j++) {
    const z = region.z + ((j + 0.5) / m - 0.5) * span;
    for (let i = 0; i < m; i++) {
      const x = region.x + ((i + 0.5) / m - 0.5) * span;
      const h = terrainSample(heights, x, z, region);
      const sx = (terrainSample(heights, x + 8, z, region) - terrainSample(heights, x - 8, z, region)) / 16;
      const sz = (terrainSample(heights, x, z + 8, region) - terrainSample(heights, x, z - 8, region)) / 16;
      const slope = Math.hypot(sx, sz);
      const idx = j * m + i;

      // Intertidal wet-sand swash zone: [-1.2m, +1.4m] with gentle coastal gradient
      if (h >= -1.2 && h <= 1.4 && slope < 0.18) {
        const swash = Math.round(255 * (1 - Math.abs(h - 0.1) / 1.4) * Math.max(0, 1 - slope / 0.18));
        swashMask[idx] = Math.max(0, Math.min(255, swash));
      }
      // Dry-sand foreshore & berm: [0.4m, +6.5m] with gentle slope (< 0.20)
      if (h >= 0.4 && h <= 6.5 && slope < 0.20) {
        const sand = Math.round(255 * coastalSmoothstep(6.5, 1.2, h) * Math.max(0, 1 - slope / 0.20));
        drySandMask[idx] = Math.max(0, Math.min(255, sand));
      }
      if (swashMask[idx] >= 48 || drySandMask[idx] >= 48) {
        beachCellCount++;
        if (cells.length < 64 && drySandMask[idx] >= 120) {
          cells.push({ x, z, elevation: h, slope, swash: swashMask[idx], drySand: drySandMask[idx] });
        }
      }
    }
  }

  return {
    swashMask,
    drySandMask,
    bermElevation: 3.2,
    beachCellCount,
    beachCoverageRatio: beachCellCount / (m * m),
    cells,
  };
}

export function placeCoastalPort(regionSpec, heights) {
  const region = resolveGlobalCoastalRegion(regionSpec);
  // Scan along the sheltered bay shoreline near along = 0 to find where the
  // shoreline (h = 0) meets navigable harbor water offshore and a gentle terrace inland.
  let bestShoreInland = 0;
  let bestScore = -Infinity;
  for (let inland = -1200; inland <= 800; inland += 16) {
    const p = worldFromCoastalFrame(region, 0, inland);
    const h = terrainSample(heights, p.x, p.z, region);
    const offshoreP = worldFromCoastalFrame(region, 0, inland - 72);
    const offshoreH = terrainSample(heights, offshoreP.x, offshoreP.z, region);
    const inlandP = worldFromCoastalFrame(region, 0, inland + 48);
    const inlandH = terrainSample(heights, inlandP.x, inlandP.z, region);
    if (h >= -0.6 && h <= 2.2 && offshoreH <= -3.5 && inlandH >= 1.5 && inlandH <= 18) {
      const score = -Math.abs(h - 0.5) * 4 + Math.min(12, -offshoreH) - Math.abs(inland) * 0.001;
      if (score > bestScore) {
        bestScore = score;
        bestShoreInland = inland;
      }
    }
  }

  const bearingRad = (region.shoreBearing ?? 112) * COASTAL_DEG_TO_RAD;
  const instances = [];
  const addPrefab = (prefabId, alongOffset, inlandOffset, yawOffsetDeg = 0, minElevation = null) => {
    const prefab = PORT_PREFABS[prefabId];
    const pos = worldFromCoastalFrame(region, alongOffset, bestShoreInland + inlandOffset);
    const groundY = terrainSurfaceSample(heights, pos.x, pos.z, region);
    const y = minElevation !== null ? Math.max(minElevation, groundY) : Math.max(1.2, groundY);
    const yaw = bearingRad + yawOffsetDeg * COASTAL_DEG_TO_RAD;
    instances.push({
      prefabId,
      label: prefab.label,
      x: pos.x,
      y,
      z: pos.z,
      yaw,
      length: prefab.length,
      width: prefab.width,
      height: prefab.height,
      foundationDepth: prefab.foundationDepth,
      materialKind: prefab.materialKind,
      roofPitch: prefab.roofPitch,
      waterfront: prefab.waterfront,
    });
  };

  // 1. Timber mole pier extending from the shoreline into deep water
  addPrefab('timber_mole_pier', 0, -24, 0, 2.2);
  // 2. Sea bastion guarding the harbor approach on the starboard headland side
  addPrefab('stone_sea_bastion', 110, 10, -15, 2.8);
  // 3. Careening shed on the sheltered sandy foreshore
  addPrefab('careening_shed', -75, 16, 12, 2.0);
  // 4. Casa de la Contratación (Customhouse) facing the waterfront plaza
  addPrefab('casa_de_contratacion', 0, 44, 0, 3.2);
  // 5. Almacén Real (Royal Warehouse) beside the customhouse
  addPrefab('royal_warehouse', 46, 48, 0, 3.2);
  // 6. Mission Chapel & Bell Tower on the upper plaza
  addPrefab('mission_chapel', -38, 82, 90, 4.0);
  // 7. Colonial Town Blocks flanking the plaza
  addPrefab('colonial_town_block', 28, 88, 0, 4.0);
  addPrefab('colonial_town_block', -44, 48, 0, 3.2);

  const center = worldFromCoastalFrame(region, 0, bestShoreInland + 32);
  const berthPos = worldFromCoastalFrame(region, 0, bestShoreInland - 76);
  const berthDepth = -terrainSample(heights, berthPos.x, berthPos.z, region);

  return {
    regionId: region.id,
    portType: region.portType,
    era: region.era,
    center: { x: center.x, z: center.z, shoreInland: bestShoreInland },
    clearRadius: 155,
    berth: {
      x: berthPos.x,
      z: berthPos.z,
      heading: ((region.shoreBearing ?? 112) + 90) % 360,
      depth: Math.max(4.5, berthDepth),
    },
    instances,
  };
}

export function portClearanceEnvelope(portPlacement, x, z, hullRadius = 0) {
  if (!portPlacement?.instances) return true;
  for (const inst of portPlacement.instances) {
    const dx = x - inst.x;
    const dz = z - inst.z;
    const c = Math.cos(-inst.yaw);
    const s = Math.sin(-inst.yaw);
    const localX = dx * c - dz * s;
    const localZ = dx * s + dz * c;
    const halfW = inst.width * 0.5 + hullRadius;
    const halfL = inst.length * 0.5 + hullRadius;
    if (Math.abs(localX) <= halfW && Math.abs(localZ) <= halfL) {
      return false;
    }
  }
  return true;
}

export function buildPortPrefabGeometry(portPlacement, palms = null) {
  if (!portPlacement?.instances?.length) {
    return {
      vertices: new Float32Array(0),
      indices: new Uint32Array(0),
      instanceCount: 0,
      triangleCount: 0,
      bounds: { min: [0, 0, 0], max: [0, 0, 0] },
    };
  }
  const verts = [];
  const indices = [];
  const bounds = {
    min: [Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity],
  };

  const pushVertex = (p, n, kind, shade) => {
    const idx = verts.length / 8;
    verts.push(p[0], p[1], p[2], n[0], n[1], n[2], kind, shade);
    for (let k = 0; k < 3; k++) {
      bounds.min[k] = Math.min(bounds.min[k], p[k]);
      bounds.max[k] = Math.max(bounds.max[k], p[k]);
    }
    return idx;
  };

  const pushQuad = (a, b, c, d, kind, shade) => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    const i0 = pushVertex(a, [nx, ny, nz], kind, shade);
    const i1 = pushVertex(b, [nx, ny, nz], kind, shade);
    const i2 = pushVertex(c, [nx, ny, nz], kind, shade);
    const i3 = pushVertex(d, [nx, ny, nz], kind, shade);
    indices.push(i0, i1, i2, i0, i2, i3);
  };

  const pushTri = (a, b, c, kind, shade) => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uy * vz - uz * vy;
    let ny = uz * vx - ux * vz;
    let nz = ux * vy - uy * vx;
    const len = Math.hypot(nx, ny, nz) || 1;
    nx /= len; ny /= len; nz /= len;
    const i0 = pushVertex(a, [nx, ny, nz], kind, shade);
    const i1 = pushVertex(b, [nx, ny, nz], kind, shade);
    const i2 = pushVertex(c, [nx, ny, nz], kind, shade);
    indices.push(i0, i1, i2);
  };

  // Helper to emit a 3D box (or battered frustum when topExpandX/Z != 0) in local coordinates
  const emitBox = (toWorld, x0, x1, y0, y1, z0, z1, kind, shade = 0.84, includeBottom = false, topInset = 0) => {
    const p000 = toWorld(x0, y0, z0);
    const p100 = toWorld(x1, y0, z0);
    const p101 = toWorld(x1, y0, z1);
    const p001 = toWorld(x0, y0, z1);
    const tx0 = x0 + topInset, tx1 = x1 - topInset;
    const tz0 = z0 + topInset, tz1 = z1 - topInset;
    const p010 = toWorld(tx0, y1, tz0);
    const p110 = toWorld(tx1, y1, tz0);
    const p111 = toWorld(tx1, y1, tz1);
    const p011 = toWorld(tx0, y1, tz1);

    pushQuad(p000, p100, p110, p010, kind, shade * 0.94);
    pushQuad(p100, p101, p111, p110, kind, shade);
    pushQuad(p101, p001, p011, p111, kind, shade * 0.96);
    pushQuad(p001, p000, p010, p011, kind, shade * 0.88);
    pushQuad(p010, p110, p111, p011, kind, Math.min(1, shade * 1.06));
    if (includeBottom) {
      pushQuad(p001, p101, p100, p000, kind, shade * 0.65);
    }
  };

  // Helper to emit an overhanging gabled or hipped terracotta roof (kind 13) with timber fascia (kind 10)
  const emitRoof = (toWorld, x0, x1, yEave, yPeak, z0, z1, overhang = 0.65, hipRatio = 0.25, wallKind = 12) => {
    const rx0 = x0 - overhang, rx1 = x1 + overhang;
    const rz0 = z0 - overhang, rz1 = z1 + overhang;
    const fasciaH = 0.24;
    // Timber fascia / eaves skirt
    emitBox(toWorld, rx0, rx1, yEave - fasciaH, yEave, rz0, rz1, 10, 0.72, true);
    const midX = (x0 + x1) * 0.5;
    const spanZ = rz1 - rz0;
    const zHip0 = rz0 + spanZ * hipRatio;
    const zHip1 = rz1 - spanZ * hipRatio;
    const e00 = toWorld(rx0, yEave, rz0);
    const e10 = toWorld(rx1, yEave, rz0);
    const e11 = toWorld(rx1, yEave, rz1);
    const e01 = toWorld(rx0, yEave, rz1);
    const r0 = toWorld(midX, yPeak, zHip0);
    const r1 = toWorld(midX, yPeak, zHip1);

    if (hipRatio > 0.02) {
      // Hipped roof: 2 side trapezoids + 2 end hip triangles
      pushQuad(e01, e00, r0, r1, 13, 0.94);
      pushQuad(e10, e11, r1, r0, 13, 0.88);
      pushTri(e00, e10, r0, 13, 0.90);
      pushTri(e11, e01, r1, 13, 0.91);
    } else {
      // Gable roof + masonry gable end triangles
      pushQuad(e01, e00, r0, r1, 13, 0.94);
      pushQuad(e10, e11, r1, r0, 13, 0.88);
      const g00 = toWorld(x0, yEave, z0), g10 = toWorld(x1, yEave, z0), gr0 = toWorld(midX, yPeak - 0.08, z0);
      const g01 = toWorld(x0, yEave, z1), g11 = toWorld(x1, yEave, z1), gr1 = toWorld(midX, yPeak - 0.08, z1);
      pushTri(g00, g10, gr0, wallKind, 0.84);
      pushTri(g11, g01, gr1, wallKind, 0.84);
    }
  };

  for (const inst of portPlacement.instances) {
    const hw = inst.width * 0.5;
    const hl = inst.length * 0.5;
    const yBase = inst.y - inst.foundationDepth;
    const yGround = inst.y;
    const yTop = inst.y + inst.height;
    const cosY = Math.cos(inst.yaw);
    const sinY = Math.sin(inst.yaw);
    const toWorld = (lx, ly, lz) => [
      inst.x + lx * cosY + lz * sinY,
      ly,
      inst.z - lx * sinY + lz * cosY,
    ];

    if (inst.prefabId === 'timber_mole_pier') {
      // Open timber trestle pier: planked deck + side curbs + seabed pilings + cross-bracing + bollards
      const deckBottom = yTop - 0.55;
      emitBox(toWorld, -hw, hw, deckBottom, yTop, -hl, hl, 10, 0.86, true);
      // Side wheel-guard curbs
      emitBox(toWorld, -hw, -hw + 0.34, yTop, yTop + 0.28, -hl, hl, 10, 0.78);
      emitBox(toWorld, hw - 0.34, hw, yTop, yTop + 0.28, -hl, hl, 10, 0.78);
      // Longitudinal stringer beams under deck
      emitBox(toWorld, -hw + 0.55, -hw + 1.05, deckBottom - 0.55, deckBottom, -hl + 0.4, hl - 0.4, 10, 0.68, true);
      emitBox(toWorld, hw - 1.05, hw - 0.55, deckBottom - 0.55, deckBottom, -hl + 0.4, hl - 0.4, 10, 0.68, true);
      // Paired timber pilings every 5.2m + transverse cross-beam caps & mooring bollards
      const bays = Math.max(4, Math.floor(inst.length / 5.2));
      for (let b = 0; b <= bays; b++) {
        const z = -hl + 1.2 + (b / bays) * (inst.length - 2.4);
        const pw = 0.24;
        emitBox(toWorld, -hw + 0.45 - pw, -hw + 0.45 + pw, yBase, yTop + 0.55, z - pw, z + pw, 10, 0.66);
        emitBox(toWorld, hw - 0.45 - pw, hw - 0.45 + pw, yBase, yTop + 0.55, z - pw, z + pw, 10, 0.66);
        // Transverse bent beam above water
        emitBox(toWorld, -hw + 0.3, hw - 0.3, deckBottom - 0.95, deckBottom - 0.55, z - 0.18, z + 0.18, 10, 0.62, true);
        if (b % 2 === 0) {
          // Heavy mooring bollards along the deck edge
          emitBox(toWorld, -hw + 0.55, -hw + 0.95, yTop + 0.28, yTop + 0.95, z - 0.20, z + 0.20, 14, 0.45);
          emitBox(toWorld, hw - 0.95, hw - 0.55, yTop + 0.28, yTop + 0.95, z - 0.20, z + 0.20, 14, 0.45);
        }
      }
      // Seaward pier-head stone plinth & iron cresset beacon tower
      emitBox(toWorld, -1.1, 1.1, yTop, yTop + 1.6, -hl + 0.6, -hl + 2.8, 11, 0.88);
      emitBox(toWorld, -0.22, 0.22, yTop + 1.6, yTop + 5.2, -hl + 1.48, -hl + 1.92, 10, 0.72);
      emitBox(toWorld, -0.55, 0.55, yTop + 5.2, yTop + 5.9, -hl + 1.15, -hl + 2.25, 14, 0.55, true);
    } else if (inst.prefabId === 'stone_sea_bastion') {
      // 16th-century Spanish Stone Sea Bastion (Baluarte):
      // Battered coral-limestone scarp walls + cordon moulding + crenellated parapet & embrasures + 4 corner garitas + central keep
      const yCordon = yTop - 1.6;
      emitBox(toWorld, -hw - 1.5, hw + 1.5, yBase, yCordon, -hl - 1.5, hl + 1.5, 11, 0.84, false, 1.5);
      // Projecting stone cordon course
      emitBox(toWorld, -hw - 0.35, hw + 0.35, yCordon, yCordon + 0.42, -hl - 0.35, hl + 0.35, 11, 0.92, true);
      // Terreplein gun deck
      emitBox(toWorld, -hw, hw, yCordon + 0.42, yTop - 0.9, -hl, hl, 11, 0.80);
      // Perimeter crenellated parapet walls with cannon embrasures
      const wallT = 1.65;
      const merlonY = yTop + 0.85;
      for (const sideZ of [-1, 1]) {
        const zOut = sideZ < 0 ? -hl : hl - wallT;
        const zIn = sideZ < 0 ? -hl + wallT : hl;
        emitBox(toWorld, -hw, hw, yTop - 0.9, yTop, zOut, zIn, 11, 0.86);
        for (let m = -2; m <= 2; m++) {
          const mx = m * 5.2;
          emitBox(toWorld, mx - 1.65, mx + 1.65, yTop, merlonY, zOut, zIn, 11, 0.90);
          if (m < 2) {
            // Dark cannon embrasure throat & gun barrel
            const ex = mx + 2.6;
            emitBox(toWorld, ex - 0.55, ex + 0.55, yTop - 0.25, yTop + 0.35, zOut - 0.08, zIn + 0.08, 14, 0.35);
            emitBox(toWorld, ex - 0.18, ex + 0.18, yTop + 0.05, yTop + 0.42, zOut - 0.85, zIn + 0.2, 14, 0.30, true);
          }
        }
      }
      for (const sideX of [-1, 1]) {
        const xOut = sideX < 0 ? -hw : hw - wallT;
        const xIn = sideX < 0 ? -hw + wallT : hw;
        emitBox(toWorld, xOut, xIn, yTop - 0.9, yTop, -hl + wallT, hl - wallT, 11, 0.84);
        for (let m = -2; m <= 2; m++) {
          const mz = m * 5.8;
          emitBox(toWorld, xOut, xIn, yTop, merlonY, mz - 1.8, mz + 1.8, 11, 0.88);
        }
      }
      // 4 Corner projecting bartizan sentry turrets (garitas)
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const gx = sx * (hw + 0.2), gz = sz * (hl + 0.2);
          emitBox(toWorld, gx - 1.25, gx + 1.25, yCordon - 0.8, yCordon + 0.42, gz - 1.25, gz + 1.25, 11, 0.78, true, -0.35);
          emitBox(toWorld, gx - 1.35, gx + 1.35, yCordon + 0.42, merlonY + 1.6, gz - 1.35, gz + 1.35, 11, 0.90);
          emitBox(toWorld, gx - 1.45, gx + 1.45, merlonY + 1.6, merlonY + 2.8, gz - 1.45, gz + 1.45, 11, 0.95, false, 1.15);
        }
      }
      // Interior command keep / powder magazine with limewashed walls & hipped terracotta roof
      const kw = hw * 0.44, kl = hl * 0.46, yKeep = merlonY + 4.2;
      emitBox(toWorld, -kw - 0.3, kw + 0.3, yTop - 0.9, yTop + 0.6, -kl - 0.3, kl + 0.3, 11, 0.82);
      emitBox(toWorld, -kw, kw, yTop + 0.6, yKeep, -kl, kl, 12, 0.90);
      emitRoof(toWorld, -kw, kw, yKeep, yKeep + 2.6, -kl, kl, 0.65, 0.28, 12);
    } else if (inst.prefabId === 'casa_de_contratacion') {
      // Royal Customhouse (Casa de la Contratación):
      // Ashlar stone plinth + ground-floor 5-bay waterfront arcade + 2nd-story cantilevered timber balcony + hipped tile roof
      const yPlinth = yGround + 0.85;
      emitBox(toWorld, -hw - 0.8, hw + 0.8, yBase, yPlinth, -hl - 0.8, hl + 0.8, 11, 0.82);
      // Main two-story stucco block recessed behind front loggia
      const loggiaD = 2.6;
      emitBox(toWorld, -hw, hw, yPlinth, yTop, -hl + loggiaD, hl, 12, 0.88);
      // Upper floor extending over the waterfront loggia
      const yMid = yPlinth + (yTop - yPlinth) * 0.48;
      emitBox(toWorld, -hw, hw, yMid, yTop, -hl, -hl + loggiaD, 12, 0.90, true);
      // Corner ashlar stone quoins
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const qx = sx * hw, qz = sz * hl;
          emitBox(toWorld, qx - (sx > 0 ? 0.65 : 0.08), qx + (sx < 0 ? 0.65 : 0.08), yPlinth, yTop, qz - (sz > 0 ? 0.65 : 0.08), qz + (sz < 0 ? 0.65 : 0.08), 11, 0.84);
        }
      }
      // Ground-floor waterfront colonnade pillars & dark recessed arcade bays
      const cols = 6;
      for (let c = 0; c < cols; c++) {
        const lz = -hl + 0.6 + (c / (cols - 1)) * (inst.length - 1.2);
        emitBox(toWorld, -hw - 0.05, -hw + 0.65, yPlinth, yMid, lz - 0.38, lz + 0.38, 11, 0.86);
        emitBox(toWorld, hw - 0.65, hw + 0.05, yPlinth, yMid, lz - 0.38, lz + 0.38, 11, 0.86);
        if (c < cols - 1) {
          const bz = lz + (inst.length - 1.2) / (2 * (cols - 1));
          // Deep shadowed arcade opening + upper shuttered window
          emitBox(toWorld, -hw + 0.5, -hw + loggiaD + 0.06, yPlinth + 0.1, yMid - 0.35, bz - 1.1, bz + 1.1, 14, 0.32);
          emitBox(toWorld, -hw - 0.06, -hw + 0.12, yMid + 0.75, yTop - 0.75, bz - 0.68, bz + 0.68, 14, 0.38);
          emitBox(toWorld, hw - 0.12, hw + 0.06, yMid + 0.75, yTop - 0.75, bz - 0.68, bz + 0.68, 14, 0.38);
        }
      }
      // Cantilevered 2nd-story timber balcony along both long facades
      emitBox(toWorld, -hw - 1.05, -hw, yMid - 0.22, yMid + 0.95, -hl + 0.8, hl - 0.8, 10, 0.76, true);
      emitBox(toWorld, hw, hw + 1.05, yMid - 0.22, yMid + 0.95, -hl + 0.8, hl - 0.8, 10, 0.76, true);
      emitRoof(toWorld, -hw - 0.2, hw + 0.2, yTop, yTop + (inst.roofPitch ?? 2.8), -hl - 0.2, hl + 0.2, 0.85, 0.22, 12);
    } else if (inst.prefabId === 'mission_chapel') {
      // 16th-century Spanish Colonial Iglesia & Bell Tower (Campanario)
      const yPlinth = yGround + 0.75;
      emitBox(toWorld, -hw - 0.7, hw + 0.7, yBase, yPlinth, -hl - 0.7, hl + 0.7, 11, 0.82);
      // Nave walls
      emitBox(toWorld, -hw, hw, yPlinth, yTop, -hl, hl, 12, 0.90);
      // 5 pairs of exterior masonry buttresses along the nave walls
      for (let b = 0; b < 5; b++) {
        const bz = -hl + 1.2 + (b / 4) * (inst.length - 2.4);
        emitBox(toWorld, -hw - 0.65, -hw, yPlinth, yTop - 0.6, bz - 0.42, bz + 0.42, 11, 0.84);
        emitBox(toWorld, hw, hw + 0.65, yPlinth, yTop - 0.6, bz - 0.42, bz + 0.42, 11, 0.84);
        if (b < 4) {
          const wz = bz + (inst.length - 2.4) / 8;
          emitBox(toWorld, -hw - 0.08, hw + 0.08, yPlinth + 2.8, yTop - 1.4, wz - 0.55, wz + 0.55, 14, 0.36);
        }
      }
      // West facade stone portal surround, recessed doorway & choir window
      emitBox(toWorld, -2.4, 2.4, yPlinth, yPlinth + 5.8, -hl - 0.45, -hl, 11, 0.88);
      emitBox(toWorld, -1.35, 1.35, yPlinth, yPlinth + 4.4, -hl - 0.52, -hl + 0.1, 14, 0.30);
      emitBox(toWorld, -1.1, 1.1, yPlinth + 6.5, yTop - 1.1, -hl - 0.12, -hl + 0.1, 14, 0.35);
      emitRoof(toWorld, -hw, hw, yTop, yTop + (inst.roofPitch ?? 3.4), -hl, hl, 0.75, 0.0, 12);
      // 3-Stage Spanish Colonial Bell Tower (Campanario) on the front-right corner
      const tx0 = hw - 2.2, tx1 = hw + 2.6, tz0 = -hl - 1.2, tz1 = -hl + 3.6;
      const yT1 = yTop + 2.8, yT2 = yT1 + 3.8, yT3 = yT2 + 3.2;
      emitBox(toWorld, tx0, tx1, yPlinth, yT1, tz0, tz1, 12, 0.92);
      emitBox(toWorld, tx0 - 0.2, tx1 + 0.2, yT1 - 0.3, yT1, tz0 - 0.2, tz1 + 0.2, 11, 0.88, true);
      emitBox(toWorld, tx0 + 0.35, tx1 - 0.35, yT1, yT2, tz0 + 0.35, tz1 - 0.35, 12, 0.94);
      // Belfry arched openings on all 4 sides
      const tmx = (tx0 + tx1) * 0.5, tmz = (tz0 + tz1) * 0.5;
      emitBox(toWorld, tx0 + 0.28, tx1 - 0.28, yT1 + 0.65, yT2 - 0.55, tmz - 0.65, tmz + 0.65, 14, 0.32);
      emitBox(toWorld, tmx - 0.65, tmx + 0.65, yT1 + 0.65, yT2 - 0.55, tz0 + 0.28, tz1 - 0.28, 14, 0.32);
      emitBox(toWorld, tx0 + 0.15, tx1 - 0.15, yT2 - 0.28, yT2, tz0 + 0.15, tz1 - 0.15, 11, 0.90, true);
      // Pyramidal terracotta bell-tower roof
      emitBox(toWorld, tx0 + 0.45, tx1 - 0.45, yT2, yT3, tz0 + 0.45, tz1 - 0.45, 13, 0.95, false, 1.75);
    } else if (inst.prefabId === 'careening_shed') {
      // Open-sided timber boatyard pavilion on the beach + careening capstan
      const yApron = yGround + 0.45;
      emitBox(toWorld, -hw - 0.6, hw + 0.6, yBase, yApron, -hl - 0.6, hl + 0.6, 10, 0.74);
      const cols = 4;
      for (let c = 0; c < cols; c++) {
        const cz = -hl + 1.0 + (c / (cols - 1)) * (inst.length - 2.0);
        emitBox(toWorld, -hw + 0.35, -hw + 0.85, yApron, yTop, cz - 0.25, cz + 0.25, 10, 0.78);
        emitBox(toWorld, hw - 0.85, hw - 0.35, yApron, yTop, cz - 0.25, cz + 0.25, 10, 0.78);
        emitBox(toWorld, -hw + 0.2, hw - 0.2, yTop - 0.45, yTop, cz - 0.22, cz + 0.22, 10, 0.72, true);
      }
      // Pitch-boiling stone hearth & chimney at one end
      emitBox(toWorld, -1.8, 1.8, yApron, yTop + 2.4, hl - 2.2, hl - 0.2, 11, 0.80, false, 0.45);
      emitRoof(toWorld, -hw, hw, yTop, yTop + (inst.roofPitch ?? 2.1), -hl, hl, 0.75, 0.12, 10);
    } else {
      // Royal Warehouse (Almacén Real) & Colonial Courtyard Town Blocks:
      // Multi-wing masonry + stone plinth + buttresses/quoins + recessed doors/windows + overhanging terracotta roofs
      const yPlinth = yGround + 0.68;
      emitBox(toWorld, -hw - 0.6, hw + 0.6, yBase, yPlinth, -hl - 0.6, hl + 0.6, 11, 0.80);
      if (inst.prefabId === 'colonial_town_block') {
        // Two-wing L-shaped courtyard (patio) house + perimeter courtyard wall
        const mainW = hw * 1.15;
        emitBox(toWorld, -hw, -hw + mainW, yPlinth, yTop + 1.1, -hl, hl, 12, 0.88);
        emitRoof(toWorld, -hw, -hw + mainW, yTop + 1.1, yTop + 1.1 + (inst.roofPitch ?? 2.1), -hl, hl, 0.65, 0.22, 12);
        // Secondary cross-wing
        const wingL = hl * 0.95;
        emitBox(toWorld, -hw + mainW * 0.7, hw, yPlinth, yTop - 0.4, -hl, -hl + wingL, 12, 0.85);
        emitRoof(toWorld, -hw + mainW * 0.7, hw, yTop - 0.4, yTop - 0.4 + 1.8, -hl, -hl + wingL, 0.60, 0.25, 12);
        // Courtyard enclosure wall with limewashed coping & terracotta cap
        emitBox(toWorld, hw - 1.1, hw, yPlinth, yPlinth + 3.2, -hl + wingL, hl, 12, 0.82);
        emitBox(toWorld, -hw + mainW, hw, yPlinth, yPlinth + 3.2, hl - 1.1, hl, 12, 0.82);
        // Street windows, doors & timber balcony on main wing
        for (let w = -2; w <= 2; w++) {
          const wz = w * (hl * 0.36);
          emitBox(toWorld, -hw - 0.08, -hw + 0.15, yPlinth + 0.8, yPlinth + 2.5, wz - 0.55, wz + 0.55, 14, 0.35);
          emitBox(toWorld, -hw - 0.08, -hw + 0.15, yPlinth + 3.8, yTop + 0.3, wz - 0.55, wz + 0.55, 14, 0.35);
        }
        emitBox(toWorld, -hw - 0.85, -hw, yPlinth + 3.2, yPlinth + 4.1, -hl * 0.65, hl * 0.65, 10, 0.74, true);
      } else {
        // Royal Warehouse (Almacén Real): buttressed masonry hall with 4 large arched cargo portals
        emitBox(toWorld, -hw, hw, yPlinth, yTop, -hl, hl, 12, 0.87);
        for (let b = 0; b < 5; b++) {
          const bz = -hl + 1.0 + (b / 4) * (inst.length - 2.0);
          emitBox(toWorld, -hw - 0.45, -hw, yPlinth, yTop - 0.3, bz - 0.36, bz + 0.36, 11, 0.82);
          emitBox(toWorld, hw, hw + 0.45, yPlinth, yTop - 0.3, bz - 0.36, bz + 0.36, 11, 0.82);
          if (b < 4) {
            const pz = bz + (inst.length - 2.0) / 8;
            // Cargo portal & timber lintel
            emitBox(toWorld, -hw - 0.08, hw + 0.08, yPlinth + 0.1, yPlinth + 3.4, pz - 1.05, pz + 1.05, 14, 0.32);
            emitBox(toWorld, -hw - 0.18, hw + 0.18, yPlinth + 3.4, yPlinth + 3.85, pz - 1.25, pz + 1.25, 10, 0.72, true);
            // Clerestory window
            emitBox(toWorld, -hw - 0.08, hw + 0.08, yPlinth + 4.6, yTop - 0.9, pz - 0.65, pz + 0.65, 14, 0.38);
          }
        }
        emitRoof(toWorld, -hw, hw, yTop, yTop + (inst.roofPitch ?? 2.4), -hl, hl, 0.75, 0.15, 12);
      }
    }
  }

  // Optional 3D Corner-model Coconut Palms (Cocos nucifera: curved ringed trunk + 12 arching pinnate fronds)
  // along the sandy foreshore berm so tropical beaches have authentic silhouette palms
  if (palms instanceof Float32Array && palms.length >= 8) {
    const maxPalms = Math.min(palms.length / 8, 96);
    for (let idx = 0; idx < maxPalms; idx++) {
      const base = idx * 8;
      const px = palms[base], py = palms[base + 1], pz = palms[base + 2];
      const plumeR = palms[base + 3], ht = palms[base + 4], shape = palms[base + 5];
      const leanAngle = shape * Math.PI * 2;
      const leanDirX = Math.cos(leanAngle), leanDirZ = Math.sin(leanAngle);
      const leanMag = 1.6 + (shape * 7 % 1) * 1.8;
      const segs = 5;
      let prevX = px, prevY = py - 0.35, prevZ = pz, prevR = 0.42;
      for (let s = 1; s <= segs; s++) {
        const t = s / segs;
        const curY = py + t * ht;
        const curve = t * t * leanMag;
        const curX = px + leanDirX * curve;
        const curZ = pz + leanDirZ * curve;
        const curR = 0.38 * (1 - 0.58 * t);
        // 4-sided trunk prism segment (kind = 3.0 bark)
        for (let k = 0; k < 4; k++) {
          const a0 = (k * Math.PI) / 2, a1 = ((k + 1) * Math.PI) / 2;
          const c0 = Math.cos(a0), s0 = Math.sin(a0), c1 = Math.cos(a1), s1 = Math.sin(a1);
          pushQuad(
            [prevX + c0 * prevR, prevY, prevZ + s0 * prevR],
            [prevX + c1 * prevR, prevY, prevZ + s1 * prevR],
            [curX + c1 * curR, curY, curZ + s1 * curR],
            [curX + c0 * curR, curY, curZ + s0 * curR],
            3,
            0.45 + 0.45 * t
          );
        }
        prevX = curX; prevY = curY; prevZ = curZ; prevR = curR;
      }
      // 12 arching pinnate fronds radiating from the crownshaft (kind = 4.0 tropical foliage)
      const frondCount = 12;
      for (let f = 0; f < frondCount; f++) {
        const tier = f < 6 ? 0 : 1;
        const az = (f / frondCount) * Math.PI * 2 + shape * 3.1;
        const fx = Math.cos(az), fz = Math.sin(az);
        const tx = -fz, tz = fx;
        const len = plumeR * (tier === 0 ? 1.08 : 0.88);
        const midR = len * 0.55;
        const midY = prevY + (tier === 0 ? 0.85 : 1.55);
        const tipY = prevY - (tier === 0 ? 1.35 : 0.35);
        const w = 0.58;
        const rootP = [prevX, prevY + 0.15, prevZ];
        const midLeft = [prevX + fx * midR - tx * w, midY, prevZ + fz * midR - tz * w];
        const midRight = [prevX + fx * midR + tx * w, midY, prevZ + fz * midR + tz * w];
        const tipP = [prevX + fx * len, tipY, prevZ + fz * len];
        const exposure = tier === 0 ? 0.72 : 0.92;
        pushTri(rootP, midRight, midLeft, 4, exposure);
        pushTri(midLeft, midRight, tipP, 4, exposure);
      }
    }
  }

  return {
    vertices: new Float32Array(verts),
    indices: new Uint32Array(indices),
    instanceCount: portPlacement.instances.length,
    triangleCount: indices.length / 3,
    bounds,
  };
}

export function synthesizeCoastalBiome(regionSpec, heights, beaches = null, portPlacement = null) {
  const region = resolveGlobalCoastalRegion(regionSpec);
  const m = region.biomeSize;
  const span = region.span;
  const seed = (region.vegetationSeed ^ 0x7f4a7c15) >>> 0;
  const beachData = beaches ?? synthesizeCoastalBeaches(region, heights);
  const mask = new Uint8Array(m * m);

  for (let j = 0; j < m; j++) {
    const z = region.z + ((j + 0.5) / m - 0.5) * span;
    for (let i = 0; i < m; i++) {
      const x = region.x + ((i + 0.5) / m - 0.5) * span;
      const idx = j * m + i;
      const h = terrainSample(heights, x, z, region);
      if (h < 2.2 || beachData.swashMask[idx] > 80 || beachData.drySandMask[idx] > 140) {
        mask[idx] = 0;
        continue;
      }
      if (portPlacement) {
        const distPort = Math.hypot(x - portPlacement.center.x, z - portPlacement.center.z);
        if (distPort < portPlacement.clearRadius * 0.72 || !portClearanceEnvelope(portPlacement, x, z, 12)) {
          mask[idx] = 0;
          continue;
        }
      }
      const sx = (terrainSample(heights, x + 12, z, region) - terrainSample(heights, x - 12, z, region)) / 24;
      const sz = (terrainSample(heights, x, z + 12, region) - terrainSample(heights, x, z - 12, region)) / 24;
      const slope = Math.hypot(sx, sz);
      if (slope > 1.12) {
        mask[idx] = 0;
        continue;
      }
      const u = (i + 0.5) / m;
      const v = (j + 0.5) / m;
      const patchNoise = coastalFbm2D(u * 6.5 + 1.9, v * 6.5 - 2.4, seed, 4);
      const moisture = coastalSmoothstep(2.5, 28, h) * coastalSmoothstep(1.12, 0.35, slope);
      const density = Math.round(255 * Math.min(1, moisture * (0.42 + 0.72 * patchNoise)));
      mask[idx] = Math.max(0, Math.min(255, density));
    }
  }
  return mask;
}

export function synthesizeCoastalAlbedo(regionSpec, heights, beaches = null, portPlacement = null, biome = null) {
  const region = resolveGlobalCoastalRegion(regionSpec);
  const size = region.albedoSize;
  const span = region.span;
  const seed = (region.vegetationSeed ^ 0x9e3779b9) >>> 0;
  const beachData = beaches ?? synthesizeCoastalBeaches(region, heights);
  const biomeMask = biome ?? synthesizeCoastalBiome(region, heights, beachData, portPlacement);
  const rgba = new Uint8Array(size * size * 4);

  for (let j = 0; j < size; j++) {
    const v = (j + 0.5) / size;
    const z = region.z + (v - 0.5) * span;
    for (let i = 0; i < size; i++) {
      const u = (i + 0.5) / size;
      const x = region.x + (u - 0.5) * span;
      const h = terrainSample(heights, x, z, region);
      const sx = (terrainSample(heights, x + 8, z, region) - terrainSample(heights, x - 8, z, region)) / 16;
      const sz = (terrainSample(heights, x, z + 8, region) - terrainSample(heights, x, z - 8, region)) / 16;
      const slope = Math.hypot(sx, sz);

      const veg = vegetationProbability(biomeMask, region.biomeSize, u, v);
      const sandNoise = (coastalFbm2D(u * 22 + 3.1, v * 22 - 1.7, seed, 3) - 0.5) * 2;
      const fineGrain = (coastalValueNoise2D(u * 68, v * 68, seed ^ 0x55aa55aa) - 0.5) * 14;

      // Base inland colour: continuous blend between dry coastal earth, lush forest canopy, and exposed cliff stone
      const forestR = 118 - veg * 66 + sandNoise * 6;
      const forestG = 128 - veg * 36 + sandNoise * 6;
      const forestB = 86 - veg * 42 + sandNoise * 4;
      const cliffWeight = coastalSmoothstep(0.42, 0.78, slope);
      const rockR = 114 + sandNoise * 10 + fineGrain * 0.6;
      const rockG = 108 + sandNoise * 9 + fineGrain * 0.5;
      const rockB = 98 + sandNoise * 8 + fineGrain * 0.5;

      let r = forestR * (1 - cliffWeight) + rockR * cliffWeight;
      let g = forestG * (1 - cliffWeight) + rockG * cliffWeight;
      let b = forestB * (1 - cliffWeight) + rockB * cliffWeight;

      // Colonial waterfront plaza & town cobble apron (smooth radial blend, no hard ring)
      if (portPlacement && h > 0.2) {
        const distPort = Math.hypot(x - portPlacement.center.x, z - portPlacement.center.z);
        const plazaWeight =
          coastalSmoothstep(portPlacement.clearRadius * 0.78, portPlacement.clearRadius * 0.32, distPort) *
          coastalSmoothstep(0.3, 1.8, h) *
          (1 - cliffWeight);
        if (plazaWeight > 0) {
          const cobbleR = 166 + fineGrain * 0.8;
          const cobbleG = 148 + fineGrain * 0.7;
          const cobbleB = 122 + fineGrain * 0.6;
          r = r * (1 - plazaWeight) + cobbleR * plazaWeight;
          g = g * (1 - plazaWeight) + cobbleG * plazaWeight;
          b = b * (1 - plazaWeight) + cobbleB * plazaWeight;
        }
      }

      // Continuous dry coral/quartz beach berm & backshore dune sand (no blocky grid threshold)
      const gentleSlope = coastalSmoothstep(0.28, 0.09, slope);
      const bermTop = 5.4 + sandNoise * 1.1;
      const drySandWeight =
        coastalSmoothstep(-0.3, 0.7, h) *
        coastalSmoothstep(bermTop, 1.4, h) *
        gentleSlope;
      if (drySandWeight > 0) {
        const dryR = 214 + sandNoise * 8 + fineGrain * 0.7;
        const dryG = 196 + sandNoise * 7 + fineGrain * 0.6;
        const dryB = 158 + sandNoise * 6 + fineGrain * 0.5;
        r = r * (1 - drySandWeight) + dryR * drySandWeight;
        g = g * (1 - drySandWeight) + dryG * drySandWeight;
        b = b * (1 - drySandWeight) + dryB * drySandWeight;
      }

      // Continuous wet intertidal swash sand & wrack line around the waterline [-1.1m, +1.3m]
      const swashWeight =
        Math.max(0, 1 - Math.abs(h - 0.12 - sandNoise * 0.18) / 1.25) *
        coastalSmoothstep(0.26, 0.08, slope);
      if (swashWeight > 0) {
        const wetR = 148 + fineGrain * 0.5;
        const wetG = 134 + fineGrain * 0.45;
        const wetB = 106 + fineGrain * 0.4;
        r = r * (1 - swashWeight) + wetR * swashWeight;
        g = g * (1 - swashWeight) + wetG * swashWeight;
        b = b * (1 - swashWeight) + wetB * swashWeight;
      }

      // Submerged coral sand shallows & offshore seabed transition (h < 0.15m)
      if (h < 0.15) {
        const subWeight = coastalSmoothstep(0.15, -0.45, h);
        const shallow = coastalSmoothstep(-26, -0.6, h);
        const shoalR = 26 + shallow * 116 + sandNoise * 5;
        const shoalG = 56 + shallow * 112 + sandNoise * 5;
        const shoalB = 72 + shallow * 76 + sandNoise * 4;
        r = r * (1 - subWeight) + shoalR * subWeight;
        g = g * (1 - subWeight) + shoalG * subWeight;
        b = b * (1 - subWeight) + shoalB * subWeight;
      }

      const outIdx = (j * size + i) * 4;
      rgba[outIdx] = Math.max(0, Math.min(255, Math.round(r)));
      rgba[outIdx + 1] = Math.max(0, Math.min(255, Math.round(g)));
      rgba[outIdx + 2] = Math.max(0, Math.min(255, Math.round(b)));
      rgba[outIdx + 3] = 255;
    }
  }
  return rgba;
}

// Coconut palm (Cocos nucifera L.) genome profile matching Forestmodeler's
// Corner architectural model (Hallé, Oldeman & Tomlinson 1978; Tomlinson 1990).
export const COCONUT_PALM_GENOME_SPEC = Object.freeze({
  species: 'palm',
  binomial: 'Cocos nucifera',
  architecturalModel: 'Corner',
  maxBranchOrder: 1,
  whorlCount: 7,
  activeFronds: 28,
  frondLengthRangeMetres: Object.freeze([4.0, 6.0]),
  matureHeightRangeMetres: Object.freeze([18.0, 26.0]),
  plumeSpreadRangeMetres: Object.freeze([5.5, 8.5]),
  plumeRadiusRangeMetres: Object.freeze([2.75, 4.25]),
  spreadToHeightRange: Object.freeze([0.22, 0.60]),
  crownProjectedLAI: Object.freeze({ min: 2.2, mean: 3.3, max: 4.8 }),
  basalRadiusMetres: 0.42,
  basalFlare: 0.68,
  flareHeightMetres: 0.85,
  wood: Object.freeze({
    modulusOfRuptureMPa: 46.0,
    modulusOfElasticityGPa: 7.2,
    densityKgM3: 760.0,
  }),
});

export function seedCoastalVegetation(regionSpec, heights, biome = null, beaches = null, portPlacement = null, palmPrototypeId = 5) {
  const region = resolveGlobalCoastalRegion(regionSpec);
  const beachData = beaches ?? synthesizeCoastalBeaches(region, heights);
  const biomeMask = biome ?? synthesizeCoastalBiome(region, heights, beachData, portPlacement);
  const rand = coastalMulberry32(region.vegetationSeed ?? 47231);
  const candidates = region.vegetationCandidates ?? 16000;

  const allTrees = [];
  const palms = [];
  const palmRoots = [];
  const scrub = [];
  const upland = [];

  for (let id = 0; id < candidates; id++) {
    const u = rand();
    const v = rand();
    const density = rand();
    const shape = rand();
    const baseRadius = 3.2 + rand() * 4.4;
    const baseHeight = 8 + rand() * 10;

    const x = region.x + (u - 0.5) * region.span;
    const z = region.z + (v - 0.5) * region.span;
    const h = terrainSample(heights, x, z, region);
    if (h < 2.4 || h > 855) continue;

    if (portPlacement) {
      const distPort = Math.hypot(x - portPlacement.center.x, z - portPlacement.center.z);
      if (distPort < portPlacement.clearRadius * 0.72 || !portClearanceEnvelope(portPlacement, x, z, 10)) {
        continue;
      }
    }

    const sx = (terrainSample(heights, x + 12, z, region) - terrainSample(heights, x - 12, z, region)) / 24;
    const sz = (terrainSample(heights, x, z + 12, region) - terrainSample(heights, x, z - 12, region)) / 24;
    const slope = Math.hypot(sx, sz);
    if (slope > 1.12) continue;

    const prob = vegetationProbability(biomeMask, region.biomeSize, u, v);
    if (prob <= 0 || density > prob * 0.92) continue;

    if (h < 12) {
      // Foreshore coconut palm fringe (Corner's model: 18-26m height, 2.75-4.25m plume radius)
      // & coastal sea-grape / mangrove band just above the beach berm
      const isPalm = region.climate === 'tropical' || region.climate === 'subtropical';
      const tNorm = (baseRadius - 3.2) / 4.4;
      const hNorm = (baseHeight - 8) / 10;
      const r = isPalm
        ? COCONUT_PALM_GENOME_SPEC.plumeRadiusRangeMetres[0] +
          tNorm * (COCONUT_PALM_GENOME_SPEC.plumeRadiusRangeMetres[1] - COCONUT_PALM_GENOME_SPEC.plumeRadiusRangeMetres[0])
        : baseRadius * 0.85;
      const ht = isPalm
        ? COCONUT_PALM_GENOME_SPEC.matureHeightRangeMetres[0] +
          hNorm * (COCONUT_PALM_GENOME_SPEC.matureHeightRangeMetres[1] - COCONUT_PALM_GENOME_SPEC.matureHeightRangeMetres[0])
        : baseHeight * 0.75;
      const tuple = [x, h, z, r, ht, shape, sx, sz];
      allTrees.push(...tuple);
      if (isPalm) {
        palms.push(...tuple);
        const scale = ht / 22.0;
        const yaw = shape * Math.PI * 2;
        const sink = Math.max(0.12, COCONUT_PALM_GENOME_SPEC.basalRadiusMetres * scale * slope + 0.08);
        const tint = 0.94 + 0.12 * tNorm;
        palmRoots.push(
          x,
          h - sink,
          z,
          scale,
          yaw,
          tint,
          0.96 + 0.08 * hNorm,
          0.92 + 0.1 * tNorm,
          palmPrototypeId,
          sink,
          -1,
          0
        );
      } else {
        scrub.push(...tuple);
      }
    } else if (h < 32) {
      // Coastal scrub & lowland woodland transition
      const tuple = [x, h, z, baseRadius * 0.9, baseHeight * 0.88, shape, sx, sz];
      allTrees.push(...tuple);
      scrub.push(...tuple);
    } else {
      // Upland forest stand (feeds directly into the 5-tier perceptual LOD & stand mass pipeline)
      const tuple = [x, h, z, baseRadius, baseHeight, shape, sx, sz];
      allTrees.push(...tuple);
      upland.push(...tuple);
    }
  }

  return {
    trees: new Float32Array(allTrees),
    palms: new Float32Array(palms),
    palmRoots: new Float32Array(palmRoots),
    scrub: new Float32Array(scrub),
    upland: new Float32Array(upland),
    stats: {
      totalTrees: allTrees.length / 8,
      palmCount: palms.length / 8,
      scrubCount: scrub.length / 8,
      uplandCount: upland.length / 8,
    },
  };
}

export function buildCoastalMesh(regionSpec, heights) {
  const region = resolveGlobalCoastalRegion(regionSpec);
  const n = region.size;
  const step = region.span / (n - 1);
  const vertices = new Float32Array(n * n * 8);
  const indices = [];
  const submergedIndices = [];

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const h = heights[k];
      const x = region.x + (i / (n - 1) - 0.5) * region.span;
      const z = region.z + (j / (n - 1) - 0.5) * region.span;
      const dx = (heights[j * n + Math.max(0, i - 1)] - heights[j * n + Math.min(n - 1, i + 1)]) / (2 * step);
      const dz = (heights[Math.max(0, j - 1) * n + i] - heights[Math.min(n - 1, j + 1) * n + i]) / (2 * step);
      const length = Math.hypot(dx, 1, dz) || 1;
      const slope = Math.hypot(dx, dz);
      // Encode beach sand weight in kind.y (with kind.x = 0) so the terrain shader
      // suppresses jagged mountain fissure/block noise across sandy beaches.
      const sandWeight =
        coastalSmoothstep(-2.0, 0.2, h) *
        coastalSmoothstep(6.8, 1.6, h) *
        coastalSmoothstep(0.28, 0.09, slope);
      vertices.set([x, h, z, dx / length, 1 / length, dz / length, 0, sandWeight], k * 8);
      if (i < n - 1 && j < n - 1 && Math.max(h, heights[k + 1], heights[k + n], heights[k + n + 1]) > -0.5) {
        indices.push(k, k + n, k + 1, k + 1, k + n, k + n + 1);
      }
      if (
        i < n - 1 &&
        j < n - 1 &&
        Math.min(h, heights[k + 1], heights[k + n], heights[k + n + 1]) < 0 &&
        Math.max(h, heights[k + 1], heights[k + n], heights[k + n + 1]) > -45
      ) {
        submergedIndices.push(k, k + n, k + 1, k + 1, k + n, k + n + 1);
      }
    }
  }
  return {
    vertices,
    indices: new Uint32Array(indices),
    submergedIndices: new Uint32Array(submergedIndices),
  };
}

export function createCoastalViews(regionSpec, heights, portPlacement = null) {
  const region = resolveGlobalCoastalRegion(regionSpec);
  const heading = region.shoreBearing ?? 112;
  const shoreInland = portPlacement?.center?.shoreInland ?? -350;
  const rawHorizon = worldFromCoastalFrame(region, -300, shoreInland - 9500);
  const rawApproach = worldFromCoastalFrame(region, -120, shoreInland - 2600);
  const rawCoast = worldFromCoastalFrame(region, 0, shoreInland - 780);
  const rawHarbor = worldFromCoastalFrame(region, 0, shoreInland - 260);

  const caravel = { length: 20, beam: 6, hydrodynamics: { draft: 2.1 } };
  const wrap = (pos, pitch = 1) =>
    safeLandfallStart(
      heights,
      { x: pos.x, z: pos.z, y: 6, yaw: heading, pitch, heading },
      caravel,
      region
    );

  return Object.freeze({
    horizon: Object.freeze(wrap(rawHorizon, 1)),
    approach: Object.freeze(wrap(rawApproach, 4)),
    coast: Object.freeze(wrap(rawCoast, 1)),
    harbor: Object.freeze(wrap(rawHarbor, 1)),
  });
}

export function generateProceduralCoastalPack(regionSpec = 'cartagena') {
  const region = resolveGlobalCoastalRegion(regionSpec);
  const heights = synthesizeCoastalTerrain(region);
  const mesh = buildCoastalMesh(region, heights);
  const beaches = synthesizeCoastalBeaches(region, heights);
  const port = placeCoastalPort(region, heights);
  const biome = synthesizeCoastalBiome(region, heights, beaches, port);
  const albedo = synthesizeCoastalAlbedo(region, heights, beaches, port, biome);
  const vegetation = seedCoastalVegetation(region, heights, biome, beaches, port);
  const portGeometry = buildPortPrefabGeometry(port, vegetation.palms);
  const views = createCoastalViews(region, heights, port);

  return {
    region,
    heights,
    mesh,
    beaches,
    port,
    portGeometry,
    biome,
    albedo,
    vegetation,
    views,
    elevationSource: 'procedural-geomorphology',
  };
}

// Fetch real global SRTM + ETOPO1 elevation tiles from AWS Open Data Registry's
// Mapzen/Tilezen Terrarium service (https://s3.amazonaws.com/elevation-tiles-prod/terrarium/{z}/{x}/{y}.png,
// CORS-enabled, no API key required) around (region.latitude, region.longitude).
// Blends real-world coastal topography with navigable nearshore bathymetry and
// falls back seamlessly to the procedural pack if offline or over open ocean.
export async function upgradeProceduralPackWithRealDEM(pack, { fetchTile = null, zoom = 12 } = {}) {
  const effectiveFetch = fetchTile || (typeof fetch === 'function' && typeof createImageBitmap === 'function' ? fetch : null);
  if (!pack?.region || !effectiveFetch) return pack;
  const { region } = pack;
  const n = region.size;
  const span = region.span;
  const cosLat = Math.max(0.1, Math.cos(region.latitude * COASTAL_DEG_TO_RAD));
  const halfLat = (span * 0.55) / 111195;
  const halfLon = (span * 0.55) / (111195 * cosLat);
  const numTiles = 2 ** zoom;
  const lonToTileX = (lon) => Math.floor(((lon + 180) / 360) * numTiles);
  const latToTileY = (lat) => {
    const r = Math.max(-85, Math.min(85, lat)) * COASTAL_DEG_TO_RAD;
    return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * numTiles);
  };
  const tx0 = lonToTileX(region.longitude - halfLon);
  const tx1 = lonToTileX(region.longitude + halfLon);
  const ty0 = latToTileY(region.latitude + halfLat);
  const ty1 = latToTileY(region.latitude - halfLat);
  const cols = tx1 - tx0 + 1;
  const rows = ty1 - ty0 + 1;
  if (cols < 1 || cols > 4 || rows < 1 || rows > 4) return pack;

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 3200);
    const w = cols * 256;
    const h = rows * 256;
    const pixels = new Uint8ClampedArray(w * h * 4);
    const tilePromises = [];
    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const wrappedX = ((tx % numTiles) + numTiles) % numTiles;
        const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${zoom}/${wrappedX}/${ty}.png`;
        tilePromises.push(
          Promise.resolve(
            fetchTile ? fetchTile(url, { tx: wrappedX, ty, zoom, signal: controller.signal }) : fetch(url, { signal: controller.signal, mode: 'cors' })
          ).then(async (res) => {
            if (res instanceof Uint8Array || res instanceof Uint8ClampedArray) {
              return { tx, ty, rgba: res };
            }
            if (!res?.ok) throw new Error(`Terrarium HTTP ${res?.status}`);
            const bmp = await createImageBitmap(await res.blob(), {
              premultiplyAlpha: 'none',
              colorSpaceConversion: 'none',
            });
            return { tx, ty, bmp };
          })
        );
      }
    }
    const loaded = await Promise.all(tilePromises);
    clearTimeout(timer);

    if (loaded.every((t) => t.rgba)) {
      for (const { tx, ty, rgba } of loaded) {
        const ox = (tx - tx0) * 256;
        const oy = (ty - ty0) * 256;
        for (let row = 0; row < 256; row++) {
          const srcStart = row * 256 * 4;
          const dstStart = ((oy + row) * w + ox) * 4;
          pixels.set(rgba.subarray(srcStart, srcStart + 256 * 4), dstStart);
        }
      }
    } else {
      const canvas =
        typeof OffscreenCanvas === 'function'
          ? new OffscreenCanvas(w, h)
          : Object.assign(document.createElement('canvas'), { width: w, height: h });
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      for (const { tx, ty, bmp } of loaded) {
        ctx.drawImage(bmp, (tx - tx0) * 256, (ty - ty0) * 256);
        bmp.close();
      }
      pixels.set(ctx.getImageData(0, 0, w, h).data);
    }
    const decodePx = (px, py) => {
      const ix = Math.max(0, Math.min(w - 1, px));
      const iy = Math.max(0, Math.min(h - 1, py));
      const k = (iy * w + ix) * 4;
      return pixels[k] * 256 + pixels[k + 1] + pixels[k + 2] / 256 - 32768;
    };
    const sampleTerrarium = (lat, lon) => {
      const fx = ((lon + 180) / 360) * numTiles - tx0;
      const r = Math.max(-85, Math.min(85, lat)) * COASTAL_DEG_TO_RAD;
      const fy = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * numTiles - ty0;
      const px = fx * 256 - 0.5;
      const py = fy * 256 - 0.5;
      const x0 = Math.floor(px), y0 = Math.floor(py);
      const ax = px - x0, ay = py - y0;
      const h00 = decodePx(x0, y0), h10 = decodePx(x0 + 1, y0);
      const h01 = decodePx(x0, y0 + 1), h11 = decodePx(x0 + 1, y0 + 1);
      return (h00 * (1 - ax) + h10 * ax) * (1 - ay) + (h01 * (1 - ax) + h11 * ax) * ay;
    };

    const rawDem = new Float32Array(n * n);
    let landCount = 0;
    let maxDem = -Infinity;
    for (let j = 0; j < n; j++) {
      const z = region.z + (j / (n - 1) - 0.5) * span;
      const lat = region.latitude - (z - region.z) / 111195;
      for (let i = 0; i < n; i++) {
        const x = region.x + (i / (n - 1) - 0.5) * span;
        const lon = region.longitude + (x - region.x) / (111195 * cosLat);
        const elev = sampleTerrarium(lat, lon);
        rawDem[j * n + i] = elev;
        if (elev > 1.0) landCount++;
        if (elev > maxDem) maxDem = elev;
      }
    }
    const landRatio = landCount / (n * n);
    // Require both real land and real water in the 8.2km coastal window
    if (landRatio < 0.06 || landRatio > 0.88 || maxDem < 6) return pack;

    // 2-pass Chamfer distance transform (in metres) from shoreline (rawDem = 1.0m)
    const step = span / (n - 1);
    const distLand = new Float32Array(n * n).fill(1e6);
    const distWater = new Float32Array(n * n).fill(1e6);
    for (let k = 0; k < n * n; k++) {
      if (rawDem[k] > 1.0) distLand[k] = 0;
      else distWater[k] = 0;
    }
    const sweepDist = (arr) => {
      const diag = step * Math.SQRT2;
      for (let j = 0; j < n; j++) {
        for (let i = 0; i < n; i++) {
          const k = j * n + i;
          let d = arr[k];
          if (i > 0) d = Math.min(d, arr[k - 1] + step);
          if (j > 0) d = Math.min(d, arr[k - n] + step);
          if (i > 0 && j > 0) d = Math.min(d, arr[k - n - 1] + diag);
          if (i < n - 1 && j > 0) d = Math.min(d, arr[k - n + 1] + diag);
          arr[k] = d;
        }
      }
      for (let j = n - 1; j >= 0; j--) {
        for (let i = n - 1; i >= 0; i--) {
          const k = j * n + i;
          let d = arr[k];
          if (i < n - 1) d = Math.min(d, arr[k + 1] + step);
          if (j < n - 1) d = Math.min(d, arr[k + n] + step);
          if (i < n - 1 && j < n - 1) d = Math.min(d, arr[k + n + 1] + diag);
          if (i > 0 && j < n - 1) d = Math.min(d, arr[k + n - 1] + diag);
          arr[k] = d;
        }
      }
    };
    sweepDist(distLand);
    sweepDist(distWater);

    const heights = new Float32Array(n * n);
    const seed = region.vegetationSeed >>> 0;
    for (let j = 0; j < n; j++) {
      const z = region.z + (j / (n - 1) - 0.5) * span;
      for (let i = 0; i < n; i++) {
        const k = j * n + i;
        const x = region.x + (i / (n - 1) - 0.5) * span;
        const { along } = coastalFrame(region, x, z);
        const demH = rawDem[k];
        const micro = (coastalFbm2D((x / span) * 14, (z / span) * 14, seed, 3) - 0.5) * 3.2;
        if (demH > 1.0) {
          const inlandM = distWater[k];
          const beachBlend = coastalSmoothstep(0, 75, inlandM);
          const foreshore = Math.min(inlandM * 0.042, 3.2);
          heights[k] = Math.min(895, foreshore * (1 - beachBlend) + (demH + micro * beachBlend) * beachBlend);
        } else {
          const offshoreM = distLand[k];
          const inChannel = Math.exp(-(along * along) / (2 * 320 * 320));
          const shelfDepth = -(offshoreM * 0.032 + Math.max(0, offshoreM - 160) * 0.048);
          const channelDepth = -Math.min(24, 11.5 + offshoreM * 0.02) * inChannel * coastalSmoothstep(65, 240, offshoreM);
          heights[k] = Math.max(-120, Math.min(demH < -2 ? demH : shelfDepth, shelfDepth, channelDepth));
        }
      }
    }

    const mesh = buildCoastalMesh(region, heights);
    const beaches = synthesizeCoastalBeaches(region, heights);
    const port = placeCoastalPort(region, heights);
    const biome = synthesizeCoastalBiome(region, heights, beaches, port);
    const albedo = synthesizeCoastalAlbedo(region, heights, beaches, port, biome);
    const vegetation = seedCoastalVegetation(region, heights, biome, beaches, port);
    const portGeometry = buildPortPrefabGeometry(port, vegetation.palms);
    const views = createCoastalViews(region, heights, port);

    return Object.assign(pack, {
      heights,
      mesh,
      beaches,
      port,
      portGeometry,
      biome,
      albedo,
      vegetation,
      views,
      elevationSource: `aws-terrarium-srtm-z${zoom}`,
      demSource: {
        provider: 'aws-terrarium-srtm-etopo1',
        zoom,
        tiles: loaded.length,
      },
    });
  } catch {
    return pack;
  }
}

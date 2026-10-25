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

export function buildPortPrefabGeometry(portPlacement) {
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

  for (const inst of portPlacement.instances) {
    const hw = inst.width * 0.5;
    const hl = inst.length * 0.5;
    const y0 = inst.y - inst.foundationDepth;
    const y1 = inst.y + inst.height;
    const y2 = y1 + (inst.roofPitch ?? 0);
    const cosY = Math.cos(inst.yaw);
    const sinY = Math.sin(inst.yaw);
    const toWorld = (lx, ly, lz) => [
      inst.x + lx * cosY + lz * sinY,
      ly,
      inst.z - lx * sinY + lz * cosY,
    ];

    const p000 = toWorld(-hw, y0, -hl);
    const p100 = toWorld(hw, y0, -hl);
    const p101 = toWorld(hw, y0, hl);
    const p001 = toWorld(-hw, y0, hl);

    const p010 = toWorld(-hw, y1, -hl);
    const p110 = toWorld(hw, y1, -hl);
    const p111 = toWorld(hw, y1, hl);
    const p011 = toWorld(-hw, y1, hl);

    // 4 exterior walls
    pushQuad(p000, p100, p110, p010, inst.materialKind, 0.78);
    pushQuad(p100, p101, p111, p110, inst.materialKind, 0.84);
    pushQuad(p101, p001, p011, p111, inst.materialKind, 0.80);
    pushQuad(p001, p000, p010, p011, inst.materialKind, 0.74);

    if (inst.roofPitch > 0) {
      const r0 = toWorld(0, y2, -hl);
      const r1 = toWorld(0, y2, hl);
      // Gable roof slopes + end gables
      pushQuad(p011, p010, r0, r1, inst.materialKind + 1, 0.92);
      pushQuad(p110, p111, r1, r0, inst.materialKind + 1, 0.88);
      pushTri(p010, p110, r0, inst.materialKind, 0.82);
      pushTri(p111, p011, r1, inst.materialKind, 0.82);
    } else {
      // Flat deck / parapet top
      pushQuad(p010, p110, p111, p011, inst.materialKind, 0.90);
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
  const beachData = beaches ?? synthesizeCoastalBeaches(region, heights);
  const biomeMask = biome ?? synthesizeCoastalBiome(region, heights, beachData, portPlacement);
  const rgba = new Uint8Array(size * size * 4);

  for (let j = 0; j < size; j++) {
    const v = (j + 0.5) / size;
    const z = region.z + (v - 0.5) * span;
    const bj = Math.min(region.biomeSize - 1, Math.floor(v * region.biomeSize));
    for (let i = 0; i < size; i++) {
      const u = (i + 0.5) / size;
      const x = region.x + (u - 0.5) * span;
      const bi = Math.min(region.biomeSize - 1, Math.floor(u * region.biomeSize));
      const bIdx = bj * region.biomeSize + bi;
      const h = terrainSample(heights, x, z, region);
      const sx = (terrainSample(heights, x + 8, z, region) - terrainSample(heights, x - 8, z, region)) / 16;
      const sz = (terrainSample(heights, x, z + 8, region) - terrainSample(heights, x, z - 8, region)) / 16;
      const slope = Math.hypot(sx, sz);

      let r = 82, g = 104, b = 72;
      if (h < 0) {
        // Shallow shoal & seabed tint
        const shallow = coastalSmoothstep(-25, 0, h);
        r = Math.round(28 + shallow * 118);
        g = Math.round(58 + shallow * 116);
        b = Math.round(74 + shallow * 82);
      } else if (beachData.swashMask[bIdx] > 90) {
        // Wet intertidal sand
        r = 166; g = 152; b = 124;
      } else if (beachData.drySandMask[bIdx] > 90) {
        // Warm dry coral/quartz beach sand
        r = 218; g = 201; b = 165;
      } else if (portPlacement && Math.hypot(x - portPlacement.center.x, z - portPlacement.center.z) < portPlacement.clearRadius * 0.65) {
        // Packed earth & limestone cobble colonial plaza
        r = 168; g = 148; b = 122;
      } else if (slope > 0.68) {
        // Exposed coastal cliff / basalt / limestone rock
        r = 118; g = 112; b = 104;
      } else {
        // Vegetated coastal plain & upland forest canopy
        const veg = biomeMask[bIdx] / 255;
        r = Math.round(124 - veg * 68);
        g = Math.round(132 - veg * 38);
        b = Math.round(92 - veg * 44);
      }

      const outIdx = (j * size + i) * 4;
      rgba[outIdx] = r;
      rgba[outIdx + 1] = g;
      rgba[outIdx + 2] = b;
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
      vertices.set([x, h, z, dx / length, 1 / length, dz / length, 0, 0], k * 8);
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
  const portGeometry = buildPortPrefabGeometry(port);
  const biome = synthesizeCoastalBiome(region, heights, beaches, port);
  const albedo = synthesizeCoastalAlbedo(region, heights, beaches, port, biome);
  const vegetation = seedCoastalVegetation(region, heights, biome, beaches, port);
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
  };
}

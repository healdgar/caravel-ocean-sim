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

function coastalValueNoiseDeriv2D(x, z, seed) {
  const ix = Math.floor(x);
  const iz = Math.floor(z);
  const fx = x - ix;
  const fz = z - iz;
  const u = fx * fx * (3 - 2 * fx);
  const v = fz * fz * (3 - 2 * fz);
  const du = 6 * fx * (1 - fx);
  const dv = 6 * fz * (1 - fz);
  const a = coastalHash2D(ix, iz, seed);
  const b = coastalHash2D(ix + 1, iz, seed);
  const c = coastalHash2D(ix, iz + 1, seed);
  const d = coastalHash2D(ix + 1, iz + 1, seed);
  const k1 = b - a;
  const k2 = c - a;
  const k3 = a - b - c + d;
  return {
    val: a + k1 * u + k2 * v + k3 * u * v,
    dx: (k1 + k3 * v) * du,
    dz: (k2 + k3 * u) * dv,
  };
}

// No Man's Sky-style "Uber-Noise": combines 2D domain warping with analytical
// derivative-damped erosion (1 / (1 + erosion * |grad|^2)) and ridge folding so
// mountain crests stay sharp while lower flanks erode into smooth coastal plains.
export function coastalUberNoise2D(
  x,
  z,
  seed,
  { octaves = 5, warp = 0.36, erosion = 1.45, sharpness = 0.52 } = {}
) {
  const wx =
    warp > 0
      ? (coastalFbm2D(x * 0.85 + 3.7, z * 0.85 - 2.1, (seed ^ 0x13579bdf) >>> 0, 3) - 0.5) * warp
      : 0;
  const wz =
    warp > 0
      ? (coastalFbm2D(x * 0.85 - 5.3, z * 0.85 + 4.9, (seed ^ 0x2468ace1) >>> 0, 3) - 0.5) * warp
      : 0;
  let px = x + wx;
  let pz = z + wz;
  let sum = 0;
  let norm = 0;
  let amp = 0.5;
  let freq = 1.0;
  let gxSum = 0;
  let gzSum = 0;
  for (let i = 0; i < octaves; i++) {
    const { val, dx, dz } = coastalValueNoiseDeriv2D(px * freq, pz * freq, (seed + i * 2029) >>> 0);
    const s = 2 * val - 1;
    const ridge = 1 - Math.abs(s);
    const ridgeSign = s >= 0 ? -2 : 2;
    const blended = val * (1 - sharpness) + ridge * ridge * sharpness;
    const dBlendedX = dx * (1 - sharpness + sharpness * 2 * ridge * ridgeSign);
    const dBlendedZ = dz * (1 - sharpness + sharpness * 2 * ridge * ridgeSign);
    gxSum += dBlendedX * amp;
    gzSum += dBlendedZ * amp;
    const damp = 1 / (1 + erosion * (gxSum * gxSum + gzSum * gzSum));
    sum += amp * blended * damp;
    norm += amp * (1 - 0.18 * sharpness);
    amp *= 0.5;
    freq *= 2.04;
  }
  return Math.max(0, Math.min(1, sum / Math.max(1e-4, norm)));
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
  stone_quay_seawall: Object.freeze({
    id: 'stone_quay_seawall',
    label: 'Malecón y Muelle de Piedra (Stone Seawall & Wharf)',
    length: 14,
    width: 112,
    height: 2.4,
    foundationDepth: 5.5,
    materialKind: 11,
    roofPitch: 0,
    waterfront: true,
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
      // NMS-style Uber-Noise: domain-warped + derivative-eroded mountain ridges and alluvial plains
      const uber = coastalUberNoise2D(nx * 2.2 + 1.1, nz * 2.2 + 0.7, seed ^ 0x2468ace0, {
        octaves: 5,
        warp: 0.38,
        erosion: 1.55,
        sharpness: 0.54,
      });

      let signedShore;
      if (isIsland) {
        // Volcanic island centered near (along=0, inland=450m) with a concave bay at (along=0, inland=-950m)
        const radius = span * 0.27;
        const dist = Math.hypot(along, inland - 420);
        const bayIndent = 340 * Math.exp(-(along * along) / (2 * 520 * 520)) * coastalSmoothstep(600, -900, inland);
        signedShore = radius - dist - bayIndent + macroWarping * 0.45 + mesoDetail * 0.35;
      } else {
        // Mainland / major island coast with a sheltered concave bay around along = 0,
        // protective rocky headlands around |along| ~ 1050m, and a harbor-guarding Morro headland at along ~ +115m.
        const bayIndent = 520 * Math.exp(-(along * along) / (2 * 680 * 680));
        const headlandLeft = 360 * Math.exp(-((along + 1100) ** 2) / (2 * 420 * 420));
        const headlandRight = 320 * Math.exp(-((along - 1100) ** 2) / (2 * 420 * 420));
        const morroPromontory = 34 * Math.exp(-((along - 115) ** 2) / (2 * 55 * 55));
        const shoreLineInland = -350 + bayIndent - headlandLeft - headlandRight - morroPromontory - macroWarping - mesoDetail * 0.4;
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
        // Foreshore beach zone (0..320m inland in the sheltered bay) transitions to coastal terrace and derivative-eroded mountains
        const beachRamp = Math.min(signedShore, 340) * (0.018 * bayShelter + 0.065 * (1 - bayShelter) + 0.16 * headlandFactor);
        const inlandRise = Math.max(0, signedShore - 300);
        const mountainFactor = coastalSmoothstep(80, 1950, inlandRise);
        const hillHeight = peak * mountainFactor * (0.32 + 0.68 * uber) + Math.max(0, mesoDetail) * mountainFactor * 0.38;
        // Port terrace flattening near the sheltered harbor shore (along ~ [-280, +280], signedShore ~ [10, 320])
        const terraceMask = Math.exp(-(along * along) / (2 * 320 * 320)) * coastalSmoothstep(8, 65, signedShore) * coastalSmoothstep(420, 210, signedShore);
        const rawLand = beachRamp + hillHeight;
        const terraced = rawLand * (1 - terraceMask * 0.72) + 3.4 * (terraceMask * 0.72);
        h = terraced * (1 - riverMask * 0.92) - 3.2 * riverMask;
      }

      heights[j * n + i] = Math.max(-120, Math.min(895, h));
    }
  }
  return heights;
}

export function computeCoastalShoreDistances(heights, n, span, shoreThreshold = 0.25) {
  const step = span / (n - 1);
  const diag = step * Math.SQRT2;
  const distLand = new Float32Array(n * n).fill(1e6);
  const distWater = new Float32Array(n * n).fill(1e6);
  for (let k = 0; k < n * n; k++) {
    if (heights[k] > shoreThreshold) distLand[k] = 0;
    else distWater[k] = 0;
  }
  const sweep = (arr) => {
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
  sweep(distLand);
  sweep(distWater);
  return { distLand, distWater, step };
}

function sampleSatelliteEquirectangular(satelliteData, u, v) {
  if (!satelliteData?.rgba || !satelliteData.size) return null;
  const s = satelliteData.size;
  const px = Math.max(0, Math.min(s - 1, Math.floor(u * s)));
  const py = Math.max(0, Math.min(s - 1, Math.floor(v * s)));
  const k = (py * s + px) * 4;
  const r = satelliteData.rgba[k];
  const g = satelliteData.rgba[k + 1];
  const b = satelliteData.rgba[k + 2];
  const luma = 0.2126 * r + 0.7152 * g + 0.0722 * b;
  let localLuma = luma;
  if (satelliteData.lowLuma && satelliteData.lowSize) {
    const ls = satelliteData.lowSize;
    const lx = Math.max(0, Math.min(ls - 1, u * ls - 0.5));
    const ly = Math.max(0, Math.min(ls - 1, v * ls - 0.5));
    const x0 = Math.floor(lx), y0 = Math.floor(ly);
    const x1 = Math.min(ls - 1, x0 + 1), y1 = Math.min(ls - 1, y0 + 1);
    const ax = lx - x0, ay = ly - y0;
    const l00 = satelliteData.lowLuma[y0 * ls + x0], l10 = satelliteData.lowLuma[y0 * ls + x1];
    const l01 = satelliteData.lowLuma[y1 * ls + x0], l11 = satelliteData.lowLuma[y1 * ls + x1];
    localLuma = (l00 * (1 - ax) + l10 * ax) * (1 - ay) + (l01 * (1 - ax) + l11 * ax) * ay;
  }
  const exG = (2 * g) / Math.max(1, r + b);
  const rawGreen = g > b ? Math.max(0, Math.min(1, (exG - 1.00) * 2.15)) : 0;
  // Deep closed-canopy tropical forest often has dark emerald shadow reflectance
  const shadowCanopy =
    g >= r * 0.94 && g > b * 1.05 && luma >= 15 && luma <= 118
      ? coastalSmoothstep(0.94, 1.15, g / Math.max(1, r)) * 0.78
      : 0;
  const greenness = Math.max(rawGreen, shadowCanopy);
  // Warm, high-luminance foreshore beach sand chromaticity (R >= G > B, low greenness)
  const sandChroma =
    r >= g * 0.88 && g >= b * 1.02 && luma >= 86
      ? coastalSmoothstep(86, 152, luma) *
        coastalSmoothstep(0.28, 0.04, greenness) *
        coastalSmoothstep(0.96, 1.18, (r + g) / Math.max(1, 2 * b))
      : 0;
  const maxC = Math.max(r, g, b);
  const minC = Math.min(r, g, b);
  const chroma = (maxC - minC) / Math.max(1, maxC);
  // Modern urban concrete/asphalt/roof detection on non-vegetated inland pixels
  const isUrban =
    greenness < 0.14 &&
    (chroma < 0.25 || b >= g * 0.96 || (minC > 114 && maxC - minC < 52) || (r > g * 1.22 && luma > 96));
  return { r, g, b, luma, localLuma, greenness, sandChroma, isUrban };
}

export function synthesizeCoastalBeaches(regionSpec, heights, satelliteData = null, shoreDist = null) {
  const region = resolveGlobalCoastalRegion(regionSpec);
  const m = region.biomeSize;
  const n = region.size;
  const span = region.span;
  const distInfo = shoreDist ?? computeCoastalShoreDistances(heights, n, span, 0.25);
  const { distWater, step } = distInfo;
  const swashMask = new Uint8Array(m * m);
  const drySandMask = new Uint8Array(m * m);
  let beachCellCount = 0;
  const cells = [];
  const baseBeachInland = Math.max(85, step * 2.2);
  const satWideBeachInland = Math.max(115, step * 2.6);
  const maxSwashInland = Math.max(42, step * 1.5);

  for (let j = 0; j < m; j++) {
    const v = (j + 0.5) / m;
    const z = region.z + (v - 0.5) * span;
    const gj = Math.min(n - 1, Math.max(0, Math.round(v * (n - 1))));
    for (let i = 0; i < m; i++) {
      const u = (i + 0.5) / m;
      const x = region.x + (u - 0.5) * span;
      const gi = Math.min(n - 1, Math.max(0, Math.round(u * (n - 1))));
      const inlandM = distWater[gj * n + gi];
      const h = terrainSample(heights, x, z, region);
      const sx = (terrainSample(heights, x + 8, z, region) - terrainSample(heights, x - 8, z, region)) / 16;
      const sz = (terrainSample(heights, x, z + 8, region) - terrainSample(heights, x, z - 8, region)) / 16;
      const slope = Math.hypot(sx, sz);
      const idx = j * m + i;
      const sat = sampleSatelliteEquirectangular(satelliteData, u, v);
      // When satellite imagery is present, suppress dry beach sand where coastal mangrove/forest
      // reaches the water's edge, and widen the beach berm where warm spectral sand is detected.
      const satBeachFactor = sat
        ? Math.max(0.22, Math.min(1.35, 0.65 + sat.sandChroma * 0.85 - sat.greenness * 0.62))
        : 1.0;
      const maxBeachInland = sat && sat.sandChroma > 0.35 ? satWideBeachInland : baseBeachInland;

      // Intertidal wet-sand swash zone: [-1.2m, +1.4m] within foreshore distance of water
      if (h >= -1.2 && h <= 1.4 && slope < 0.18 && inlandM <= maxSwashInland) {
        const swash = Math.round(
          255 *
            (1 - Math.abs(h - 0.1) / 1.4) *
            Math.max(0, 1 - slope / 0.18) *
            coastalSmoothstep(maxSwashInland, maxSwashInland * 0.33, inlandM)
        );
        swashMask[idx] = Math.max(0, Math.min(255, swash));
      }
      // Dry-sand foreshore & berm: [0.4m, +6.5m] with gentle slope (< 0.20) adjacent to the coast
      if (h >= 0.4 && h <= 6.5 && slope < 0.20 && inlandM <= maxBeachInland) {
        const shoreFade = coastalSmoothstep(maxBeachInland, maxBeachInland * 0.38, inlandM);
        const sand = Math.round(
          255 *
            coastalSmoothstep(6.5, 1.2, h) *
            Math.max(0, 1 - slope / 0.20) *
            shoreFade *
            satBeachFactor
        );
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

export function extractOrthophotoBuildingFootprints(regionSpec, heights, satelliteData, shoreDist = null) {
  if (!satelliteData) return null;
  const region = resolveGlobalCoastalRegion(regionSpec);
  const n = region.size;
  const span = region.span;

  if (Array.isArray(satelliteData.precomputedFootprints?.footprints) && satelliteData.precomputedFootprints.footprints.length >= 4) {
    const pre = satelliteData.precomputedFootprints;
    const clusterX = region.x + ((pre.clusterU ?? 0.5) - 0.5) * span;
    const clusterZ = region.z + ((pre.clusterV ?? 0.5) - 0.5) * span;
    const footprints = pre.footprints.map((fp) => {
      const x = Number.isFinite(fp.u) ? region.x + (fp.u - 0.5) * span : fp.x;
      const z = Number.isFinite(fp.v) ? region.z + (fp.v - 0.5) * span : fp.z;
      const y = Math.max(1.8, terrainSample(heights, x, z, region));
      const width = fp.width ?? 22;
      const length = fp.length ?? 26;
      return {
        x,
        z,
        y,
        yaw: fp.yaw ?? 0,
        width,
        length,
        area: width * length,
        inlandM: fp.inlandM ?? 64,
        prefabId: fp.prefabId || null,
      };
    });
    return { clusterX, clusterZ, footprints };
  }

  if (!satelliteData.rgba || !satelliteData.size) return null;
  if (!satelliteData.is1550Orthophoto && !satelliteData.allowFootprints) return null;
  const distInfo = shoreDist ?? computeCoastalShoreDistances(heights, n, span, 0.25);
  const { distWater } = distInfo;

  const gSize = 384;
  const cellStep = span / gSize;
  const mask = new Uint8Array(gSize * gSize);
  for (let gz = 0; gz < gSize; gz++) {
    const v = (gz + 0.5) / gSize;
    const hj = Math.min(n - 1, Math.max(0, Math.round(v * (n - 1))));
    for (let gx = 0; gx < gSize; gx++) {
      const u = (gx + 0.5) / gSize;
      const hi = Math.min(n - 1, Math.max(0, Math.round(u * (n - 1))));
      const kH = hj * n + hi;
      const h = heights[kH];
      const inlandM = distWater[kH];
      if (h < 0.45 || h > 68 || inlandM < 32 || inlandM > 960) continue;
      const sat = sampleSatelliteEquirectangular(satelliteData, u, v);
      if (!sat) continue;
      // 1550 AI orthophoto terracotta barrel-tile & weathered timber/shingle roof signature
      const isTerracotta = sat.r > 92 && sat.r < 236 && sat.g < 164 && sat.r - sat.g >= 24 && sat.r - sat.b >= 42;
      const isBrownShingle =
        sat.r > 90 &&
        sat.r < 200 &&
        sat.r - sat.g >= 16 &&
        sat.r - sat.b >= 30 &&
        sat.luma < 122 &&
        sat.g > sat.b + 8;
      if (isTerracotta || isBrownShingle) {
        mask[gz * gSize + gx] = 1;
      }
    }
  }

  const visited = new Uint8Array(gSize * gSize);
  const rawBlobs = [];
  const q = new Int32Array(gSize * gSize);
  for (let idx = 0; idx < gSize * gSize; idx++) {
    if (!mask[idx] || visited[idx]) continue;
    let head = 0, tail = 0;
    q[tail++] = idx;
    visited[idx] = 1;
    const pts = [];
    let sumX = 0, sumZ = 0, sumH = 0, sumInland = 0;
    while (head < tail) {
      const cur = q[head++];
      const gz = Math.floor(cur / gSize);
      const gx = cur - gz * gSize;
      const u = (gx + 0.5) / gSize;
      const v = (gz + 0.5) / gSize;
      const wx = region.x + (u - 0.5) * span;
      const wz = region.z + (v - 0.5) * span;
      const hi = Math.min(n - 1, Math.max(0, Math.round(u * (n - 1))));
      const hj = Math.min(n - 1, Math.max(0, Math.round(v * (n - 1))));
      const kH = hj * n + hi;
      pts.push([wx, wz]);
      sumX += wx;
      sumZ += wz;
      sumH += heights[kH];
      sumInland += distWater[kH];
      for (let dz = -1; dz <= 1; dz++) {
        const nz = gz + dz;
        if (nz < 0 || nz >= gSize) continue;
        for (let dx = -1; dx <= 1; dx++) {
          if (dx === 0 && dz === 0) continue;
          const nx = gx + dx;
          if (nx < 0 || nx >= gSize) continue;
          const nIdx = nz * gSize + nx;
          if (mask[nIdx] && !visited[nIdx]) {
            visited[nIdx] = 1;
            q[tail++] = nIdx;
          }
        }
      }
    }
    if (pts.length >= 2 && pts.length <= 2400) {
      const count = pts.length;
      rawBlobs.push({
        cx: sumX / count,
        cz: sumZ / count,
        meanH: sumH / count,
        meanInland: sumInland / count,
        count,
        pts,
      });
    }
  }

  if (rawBlobs.length < 1) return null;

  // Identify dominant 1550 colonial settlement cluster
  let bestClusterScore = -Infinity;
  let seedX = 0, seedZ = 0;
  for (const b of rawBlobs) {
    let localWeight = 0;
    for (const other of rawBlobs) {
      const d = Math.hypot(other.cx - b.cx, other.cz - b.cz);
      if (d <= 650) localWeight += other.count * (1 - d / 750);
    }
    const centerBias = -Math.hypot(b.cx - region.x, b.cz - region.z) * 0.015;
    const score = localWeight + centerBias;
    if (score > bestClusterScore) {
      bestClusterScore = score;
      seedX = b.cx;
      seedZ = b.cz;
    }
  }

  let wSum = 0, clusterX = 0, clusterZ = 0;
  const clusterBlobs = [];
  for (const b of rawBlobs) {
    if (Math.hypot(b.cx - seedX, b.cz - seedZ) <= 920) {
      clusterBlobs.push(b);
      clusterX += b.cx * b.count;
      clusterZ += b.cz * b.count;
      wSum += b.count;
    }
  }
  if (wSum < 6) return null;
  clusterX /= wSum;
  clusterZ /= wSum;

  // Minimum-Area Oriented Bounding Box (Rotating Calipers) so square & courtyard blocks lock onto true wall angles
  const computeMinAreaOBB = (pts, mx, mz) => {
    let bestArea = Infinity;
    let bestX = mx, bestZ = mz, bestW = 24, bestL = 28, bestYaw = 0;
    for (let deg = -45; deg < 45; deg += 3) {
      const a = deg * COASTAL_DEG_TO_RAD;
      const ca = Math.cos(a), sa = Math.sin(a);
      let u0 = Infinity, u1 = -Infinity, v0 = Infinity, v1 = -Infinity;
      for (const [px, pz] of pts) {
        const dx = px - mx, dz = pz - mz;
        const u = dx * ca + dz * sa;
        const v = -dx * sa + dz * ca;
        if (u < u0) u0 = u;
        if (u > u1) u1 = u;
        if (v < v0) v0 = v;
        if (v > v1) v1 = v;
      }
      const su = Math.max(cellStep * 0.9, u1 - u0 + cellStep * 0.75);
      const sv = Math.max(cellStep * 0.9, v1 - v0 + cellStep * 0.75);
      const area = su * sv;
      if (area < bestArea) {
        bestArea = area;
        const cu = 0.5 * (u0 + u1);
        const cv = 0.5 * (v0 + v1);
        bestX = mx + cu * ca - cv * sa;
        bestZ = mz + cu * sa + cv * ca;
        if (su <= sv) {
          bestW = su;
          bestL = sv;
          bestYaw = -a;
        } else {
          bestW = sv;
          bestL = su;
          bestYaw = -(a + Math.PI * 0.5);
        }
      }
    }
    return { x: bestX, z: bestZ, width: bestW, length: bestL, yaw: bestYaw, area: bestW * bestL };
  };

  const candidates = [];
  for (const b of clusterBlobs) {
    const obb = computeMinAreaOBB(b.pts, b.cx, b.cz);
    const hGround = terrainSample(heights, obb.x, obb.z, region);
    if (hGround < 0.4) continue;
    candidates.push({
      x: obb.x,
      z: obb.z,
      y: hGround,
      yaw: obb.yaw,
      length: obb.length,
      width: obb.width,
      area: obb.area,
      inlandM: b.meanInland,
    });
  }

  candidates.sort((a, b) => b.area - a.area);
  const footprints = [];
  for (const c of candidates) {
    if (footprints.length >= 32) break;
    let overlaps = false;
    for (const existing of footprints) {
      const minSep = 0.42 * (Math.min(c.width, c.length) + Math.min(existing.width, existing.length));
      if (Math.hypot(c.x - existing.x, c.z - existing.z) < Math.max(18, minSep)) {
        overlaps = true;
        break;
      }
    }
    if (!overlaps) footprints.push(c);
  }

  return footprints.length >= 4 ? { clusterX, clusterZ, footprints } : null;
}

export function placeCoastalPort(regionSpec, heights, { preserveRealCoast = false, satelliteData = null, shoreDist = null } = {}) {
  const region = resolveGlobalCoastalRegion(regionSpec);
  const orthoFootprints = extractOrthophotoBuildingFootprints(region, heights, satelliteData, shoreDist);
  const hasOrthoFootprints = Boolean(orthoFootprints?.footprints?.length >= 4);
  const clusterFrame = orthoFootprints
    ? coastalFrame(region, orthoFootprints.clusterX, orthoFootprints.clusterZ)
    : null;

  // Scan a 2D coastal window (anchored to the 1550 orthophoto settlement cluster when present)
  // to find where the shoreline (h ~ 0) meets navigable harbor water offshore and buildable land inland.
  let bestShoreAlong = clusterFrame ? clusterFrame.along : 0;
  let bestShoreInland = 0;
  let bestScore = -Infinity;
  const probePoint = (alongProbe, inland) => {
    const p = worldFromCoastalFrame(region, alongProbe, inland);
    const h = terrainSample(heights, p.x, p.z, region);
    const offshoreP = worldFromCoastalFrame(region, alongProbe, inland - 72);
    const offshoreH = terrainSample(heights, offshoreP.x, offshoreP.z, region);
    const inlandP = worldFromCoastalFrame(region, alongProbe, inland + 48);
    const inlandH = terrainSample(heights, inlandP.x, inlandP.z, region);
    if (h >= -1.2 && h <= 2.8 && offshoreH <= -2.0 && inlandH >= 0.8 && inlandH <= 38) {
      const clusterDistPenalty = clusterFrame
        ? Math.hypot(alongProbe - clusterFrame.along, inland - clusterFrame.inland) * 0.018
        : Math.abs(inland) * 0.001 + Math.abs(alongProbe) * 0.004;
      const score = -Math.abs(h - 0.5) * 4 + Math.min(12, -offshoreH) - clusterDistPenalty;
      if (score > bestScore) {
        bestScore = score;
        bestShoreAlong = alongProbe;
        bestShoreInland = inland;
      }
    }
  };
  if (clusterFrame) {
    for (let dAlong = -560; dAlong <= 560; dAlong += 32) {
      for (let dInland = -640; dInland <= 520; dInland += 16) {
        probePoint(clusterFrame.along + dAlong, clusterFrame.inland + dInland);
      }
    }
  }
  for (const alongProbe of [0, -120, 120, -240, 240, -380, 380]) {
    for (let inland = -1200; inland <= 800; inland += 16) {
      probePoint(alongProbe, inland);
    }
    if (bestScore > -Infinity && alongProbe === 0 && !clusterFrame) break;
  }
  // If real-world DEM shoreline lies outside the default synthetic bay window, scan wider coastal frame
  if (bestScore === -Infinity) {
    for (let alongProbe = -1800; alongProbe <= 1800; alongProbe += 120) {
      for (let inland = -2200; inland <= 2200; inland += 24) {
        probePoint(alongProbe, inland);
      }
    }
  }

  // NMS-style Feature Stamp Terraforming: grade the harbor pier berth and level foundation pads
  // so every port building sits flush on level ground and the pier reaches deep water.
  const n = region.size;
  const span = region.span;
  const plazaRadiusAlong = preserveRealCoast ? 72 : 105;
  const plazaRadiusInland = preserveRealCoast ? 105 : 145;
  for (let j = 0; j < n; j++) {
    const z = region.z + (j / (n - 1) - 0.5) * span;
    for (let i = 0; i < n; i++) {
      const x = region.x + (i / (n - 1) - 0.5) * span;
      const { along, inland } = coastalFrame(region, x, z);
      const relAlong = along - bestShoreAlong;
      const relInland = inland - bestShoreInland;
      if (Math.abs(relAlong) > 260 || relInland < -220 || relInland > 220) continue;
      const k = j * n + i;
      let h = heights[k];

      // 1. Dredged harbor berth & pier approach channel (relInland in [-180, -8], |relAlong| < 64)
      if (relInland < -4 && Math.abs(relAlong) < 76) {
        const acrossW = Math.exp(-(relAlong * relAlong) / (2 * 36 * 36));
        const berthW = coastalSmoothstep(-4, -38, relInland) * coastalSmoothstep(-190, -110, relInland);
        const targetDepth = -Math.min(11.5, 4.2 + (-relInland) * 0.085);
        h = Math.min(h, h * (1 - acrossW * berthW) + targetDepth * (acrossW * berthW));
      }

      if (!hasOrthoFootprints) {
        // 2. Level Waterfront Quay & Plaza Mayor terrace (synthetic ports without top-down footprints)
        if (relInland >= -2 && relInland <= plazaRadiusInland && Math.abs(relAlong) <= plazaRadiusAlong) {
          const alongW = coastalSmoothstep(plazaRadiusAlong, plazaRadiusAlong * 0.55, Math.abs(relAlong));
          const inlandW =
            coastalSmoothstep(-2, 14, relInland) *
            coastalSmoothstep(plazaRadiusInland, plazaRadiusInland * 0.64, relInland);
          const stampW = alongW * inlandW;
          const targetPlazaY = 2.6 + Math.max(0, relInland - 12) * 0.016;
          h = h * (1 - stampW * 0.88) + targetPlazaY * (stampW * 0.88);
        }

        // 3. Commanding Starboard Headland Battery (El Morro) at (relAlong ~ +110, relInland ~ +10)
        const dBastion = Math.hypot(relAlong - 110, relInland - 10);
        if (dBastion < 48) {
          const bW = coastalSmoothstep(48, 22, dBastion);
          h = h * (1 - bW * 0.9) + 4.8 * (bW * 0.9);
        }
      }

      heights[k] = h;
    }
  }

  // Grade flat building pads directly under each top-down footprint
  if (hasOrthoFootprints) {
    const step = span / (n - 1);
    for (const fp of orthoFootprints.footprints) {
      const padY = Math.max(2.6, terrainSample(heights, fp.x, fp.z, region));
      const cosY = Math.cos(fp.yaw);
      const sinY = Math.sin(fp.yaw);
      const hw = fp.width * 0.5;
      const hl = fp.length * 0.5;
      const rad = Math.hypot(hw + 16, hl + 16);
      const i0 = Math.max(0, Math.floor(((fp.x - rad - region.x) / span + 0.5) * (n - 1)));
      const i1 = Math.min(n - 1, Math.ceil(((fp.x + rad - region.x) / span + 0.5) * (n - 1)));
      const j0 = Math.max(0, Math.floor(((fp.z - rad - region.z) / span + 0.5) * (n - 1)));
      const j1 = Math.min(n - 1, Math.ceil(((fp.z + rad - region.z) / span + 0.5) * (n - 1)));
      for (let j = j0; j <= j1; j++) {
        const wz = region.z + (j / (n - 1) - 0.5) * span;
        for (let i = i0; i <= i1; i++) {
          const wx = region.x + (i / (n - 1) - 0.5) * span;
          const dx = wx - fp.x;
          const dz = wz - fp.z;
          const lx = Math.abs(dx * cosY - dz * sinY);
          const lz = Math.abs(dx * sinY + dz * cosY);
          if (lx > hw + 16 || lz > hl + 16) continue;
          const wxBlend = Math.max(0, Math.min(1, 1 - (lx - hw) / Math.max(step, 16)));
          const wzBlend = Math.max(0, Math.min(1, 1 - (lz - hl) / Math.max(step, 16)));
          const wBlend = wxBlend * wzBlend * 0.90;
          const k = j * n + i;
          heights[k] = heights[k] * (1 - wBlend) + padY * wBlend;
        }
      }
      fp.y = padY;
    }
  }

  const bearingRad = (region.shoreBearing ?? 112) * COASTAL_DEG_TO_RAD;
  const instances = [];
  const addPrefab = (prefabId, alongOffset, inlandOffset, yawOffsetDeg = 0, minElevation = null) => {
    const prefab = PORT_PREFABS[prefabId];
    const pos = worldFromCoastalFrame(region, bestShoreAlong + alongOffset, bestShoreInland + inlandOffset);
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

  // 1. Timber mole pier extending from the harbor shoreline into deep water
  addPrefab('timber_mole_pier', 0, -24, 0, 2.2);

  if (hasOrthoFootprints) {
    const fps = orthoFootprints.footprints.slice();
    const hasPreassigned = fps.some((f) => Boolean(f.prefabId));
    let bastionIdx = 0;
    let casaIdx = -1;
    let chapelIdx = -1;

    if (!hasPreassigned) {
      let bestBastionScore = Infinity;
      for (let i = 0; i < fps.length; i++) {
        const s = fps[i].inlandM - fps[i].y * 1.5;
        if (s < bestBastionScore) {
          bestBastionScore = s;
          bastionIdx = i;
        }
      }
      const used = new Set([bastionIdx]);
      for (let i = 0; i < fps.length; i++) {
        if (used.has(i)) continue;
        if (casaIdx === -1 || fps[i].area - fps[i].inlandM * 1.2 > fps[casaIdx].area - fps[casaIdx].inlandM * 1.2) {
          casaIdx = i;
        }
      }
      if (casaIdx >= 0) used.add(casaIdx);
      for (let i = 0; i < fps.length; i++) {
        if (used.has(i)) continue;
        const aspect = fps[i].length / Math.max(1, fps[i].width);
        const curScore = aspect * 65 + fps[i].area * 0.12;
        const bestChapelScore =
          chapelIdx === -1
            ? -Infinity
            : (fps[chapelIdx].length / Math.max(1, fps[chapelIdx].width)) * 65 + fps[chapelIdx].area * 0.12;
        if (curScore > bestChapelScore) {
          chapelIdx = i;
        }
      }
    }

    let warehouseAssigned = false;
    for (let i = 0; i < fps.length; i++) {
      const fp = fps[i];
      let prefabId = fp.prefabId || 'colonial_town_block';
      if (!fp.prefabId) {
        if (i === bastionIdx) prefabId = 'stone_sea_bastion';
        else if (i === casaIdx) prefabId = 'casa_de_contratacion';
        else if (i === chapelIdx) prefabId = 'mission_chapel';
        else if (!warehouseAssigned && fp.inlandM < 180) {
          prefabId = 'royal_warehouse';
          warehouseAssigned = true;
        }
      }
      const prefab = PORT_PREFABS[prefabId] || PORT_PREFABS.colonial_town_block;
      const groundY = terrainSurfaceSample(heights, fp.x, fp.z, region);
      const y = Math.max(2.2, groundY);
      // Match the exact width & length of the top-down footprint on the map (no miniature clamping!)
      const scaleW = Math.max(12, fp.width);
      const scaleL = Math.max(14, fp.length);
      const minSpan = Math.min(scaleW, scaleL);
      const heightRatio =
        prefabId === 'mission_chapel'
          ? 0.56
          : prefabId === 'casa_de_contratacion'
            ? 0.40
            : prefabId === 'stone_sea_bastion'
              ? 0.34
              : 0.36;
      const pitchRatio =
        prefabId === 'mission_chapel'
          ? 0.18
          : prefabId === 'stone_sea_bastion'
            ? 0.08
            : 0.13;
      const scaledHeight = Math.max(prefab.height, minSpan * heightRatio);
      const scaledPitch = Math.max(prefab.roofPitch ?? 2.4, minSpan * pitchRatio);

      instances.push({
        prefabId,
        label: prefab.label,
        x: fp.x,
        y,
        z: fp.z,
        yaw: fp.yaw,
        length: scaleL,
        width: scaleW,
        height: scaledHeight,
        foundationDepth: Math.max(prefab.foundationDepth, 6.0),
        materialKind: prefab.materialKind,
        roofPitch: scaledPitch,
        waterfront: prefab.waterfront,
        fromOrthophotoFootprint: true,
      });
    }
  } else {
    // 2. Continuous Stone Seawall & Wharf (Malecón) along the harbor edge
    addPrefab('stone_quay_seawall', 4, 8, 0, 2.4);
    // 3. Careening shed on the sheltered sandy foreshore
    addPrefab('careening_shed', -75, 16, 12, 2.2);
    // 4. Sea bastion (Castillo) guarding the harbor entrance on the starboard headland battery
    addPrefab('stone_sea_bastion', 110, 10, -15, 4.6);
    // 5. Casa de la Contratación (Customhouse) facing the waterfront plaza
    addPrefab('casa_de_contratacion', 0, 44, 0, 3.2);
    // 6. Almacén Real (Royal Warehouse) beside the customhouse
    addPrefab('royal_warehouse', 46, 48, 0, 3.2);
    // 7. Mission Chapel & Bell Tower on the upper plaza
    addPrefab('mission_chapel', -38, 82, 90, 3.8);
    // 8. Colonial Town Blocks flanking the plaza
    addPrefab('colonial_town_block', 28, 88, 0, 3.8);
    addPrefab('colonial_town_block', -44, 48, 0, 3.2);
  }

  const center = orthoFootprints
    ? { x: orthoFootprints.clusterX, z: orthoFootprints.clusterZ }
    : worldFromCoastalFrame(region, bestShoreAlong, bestShoreInland + 32);
  const berthPos = worldFromCoastalFrame(region, bestShoreAlong, bestShoreInland - 76);
  const berthDepth = -terrainSample(heights, berthPos.x, berthPos.z, region);

  return {
    regionId: region.id,
    portType: region.portType,
    era: region.era,
    shoreBearing: region.shoreBearing ?? 112,
    center: { x: center.x, z: center.z, shoreAlong: bestShoreAlong, shoreInland: bestShoreInland },
    clearRadius: 155,
    hasOrthophotoFootprints: hasOrthoFootprints,
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

let cachedLRMBuildingTemplates = null;
let pendingLRMBuildingPromise = null;

export function decode1550BuildingLRMBundle(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer);
  if (bytes.byteLength < 12) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, false) !== 0x57573344) return null; // 'WW3D'
  const manifestLen = view.getUint32(8, true);
  if (bytes.byteLength < 12 + manifestLen) return null;
  let manifest;
  try {
    manifest = JSON.parse(new TextDecoder().decode(bytes.subarray(12, 12 + manifestLen)));
  } catch {
    return null;
  }
  const payloadBase = bytes.byteOffset + 12 + manifestLen;
  const templates = {};
  for (const entry of manifest) {
    const vFloats = new Float32Array(
      bytes.buffer,
      payloadBase + entry.vertexByteOffset,
      entry.vertexCount * 8
    );
    const iShorts = new Uint16Array(
      bytes.buffer,
      payloadBase + entry.indexByteOffset,
      entry.indexCount
    );
    templates[entry.id] = {
      id: entry.id,
      vertices: vFloats,
      indices: iShorts,
      vertexCount: entry.vertexCount,
      indexCount: entry.indexCount,
    };
  }
  return templates;
}

export async function load1550BuildingLRMTemplates(fetchImpl = typeof fetch === 'function' ? fetch : null) {
  if (cachedLRMBuildingTemplates) return cachedLRMBuildingTemplates;
  if (!fetchImpl) return null;
  if (!pendingLRMBuildingPromise) {
    pendingLRMBuildingPromise = fetchImpl('assets/ports/1550/buildings-1550-lrm.bin')
      .then(async (res) => {
        if (!res?.ok) return null;
        const decoded = decode1550BuildingLRMBundle(await res.arrayBuffer());
        if (decoded) cachedLRMBuildingTemplates = decoded;
        return decoded;
      })
      .catch(() => null);
  }
  return pendingLRMBuildingPromise;
}

export function buildPortPrefabGeometry(portPlacement, palms = null, lrmTemplates = cachedLRMBuildingTemplates) {
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

  // Stamp a Hunyuan3D-2mv multi-view reconstructed 3D building mesh into world coordinates
  const emitLRMMesh = (toWorld, tmpl, widthX, y0, y1, lengthZ, cosY, sinY) => {
    const baseVertex = verts.length / 8;
    const spanY = Math.max(1.0, y1 - y0);
    const vArr = tmpl.vertices;
    const vCount = tmpl.vertexCount;
    for (let v = 0; v < vCount; v++) {
      const off = v * 8;
      const lx = vArr[off] * widthX;
      const ly = y0 + vArr[off + 1] * spanY;
      const lz = vArr[off + 2] * lengthZ;
      const wp = toWorld(lx, ly, lz);
      const lnx = vArr[off + 3] / Math.max(1, widthX);
      const lny = vArr[off + 4] / spanY;
      const lnz = vArr[off + 5] / Math.max(1, lengthZ);
      let wx = lnx * cosY + lnz * sinY;
      let wy = lny;
      let wz = -lnx * sinY + lnz * cosY;
      const nLen = Math.hypot(wx, wy, wz) || 1;
      wx /= nLen; wy /= nLen; wz /= nLen;
      pushVertex(wp, [wx, wy, wz], vArr[off + 6], vArr[off + 7]);
    }
    const iArr = tmpl.indices;
    for (let i = 0; i < iArr.length; i++) {
      indices.push(baseVertex + iArr[i]);
    }
  };

  const pushQuad = (a, b, c, d, kind, shade) => {
    const ux = b[0] - a[0], uy = b[1] - a[1], uz = b[2] - a[2];
    const vx = c[0] - a[0], vy = c[1] - a[1], vz = c[2] - a[2];
    let nx = uz * vy - uy * vz;
    let ny = ux * vz - uz * vx;
    let nz = uy * vx - ux * vy;
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
    let nx = uz * vy - uy * vz;
    let ny = ux * vz - uz * vx;
    let nz = uy * vx - ux * vy;
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

  // Helper to emit an N-sided cylindrical or conical prism (turrets, domes, cannon barrels, round columns)
  const emitCylinder = (toWorld, cx, cz, y0, y1, r0, r1, segs = 8, kind = 11, shade = 0.88, capTop = true) => {
    const topCenter = toWorld(cx, y1, cz);
    for (let s = 0; s < segs; s++) {
      const a0 = (s / segs) * Math.PI * 2;
      const a1 = ((s + 1) / segs) * Math.PI * 2;
      const c0 = Math.cos(a0), s0 = Math.sin(a0);
      const c1 = Math.cos(a1), s1 = Math.sin(a1);
      const p00 = toWorld(cx + c0 * r0, y0, cz + s0 * r0);
      const p10 = toWorld(cx + c1 * r0, y0, cz + s1 * r0);
      const p11 = toWorld(cx + c1 * r1, y1, cz + s1 * r1);
      const p01 = toWorld(cx + c0 * r1, y1, cz + s0 * r1);
      const facetShade = shade * (0.90 + 0.10 * Math.cos(a0 - 0.7));
      pushQuad(p00, p10, p11, p01, kind, facetShade);
      if (capTop && r1 > 0.04) {
        pushTri(p01, p11, topCenter, kind, Math.min(1, shade * 1.05));
      }
    }
  };

  // Helper to emit a 3D radial stone voussoir arch & shadowed barrel vault along the Z axis (for X-facing facades)
  const emitStoneArchZ = (toWorld, xFace, depthSign, yFloor, ySpring, radius, zCenter, archSegs = 6) => {
    const xOut = xFace + depthSign * 0.14;
    const xIn = xFace - depthSign * 0.55;
    // Recessed dark barrel-vaulted interior opening (kind 14)
    emitBox(
      toWorld,
      Math.min(xFace, xIn),
      Math.max(xFace, xIn),
      yFloor,
      ySpring + radius * 0.86,
      zCenter - radius * 0.92,
      zCenter + radius * 0.92,
      14,
      0.28
    );
    // Stone jamb piers flanking the arch
    const jambW = 0.34;
    emitBox(
      toWorld,
      Math.min(xOut, xIn),
      Math.max(xOut, xIn),
      yFloor,
      ySpring,
      zCenter - radius - jambW,
      zCenter - radius,
      11,
      0.86
    );
    emitBox(
      toWorld,
      Math.min(xOut, xIn),
      Math.max(xOut, xIn),
      yFloor,
      ySpring,
      zCenter + radius,
      zCenter + radius + jambW,
      11,
      0.86
    );
    // Radial stone voussoir arch ring (kind 11)
    const rOuter = radius + 0.36;
    for (let s = 0; s < archSegs; s++) {
      const a0 = (s / archSegs) * Math.PI;
      const a1 = ((s + 1) / archSegs) * Math.PI;
      const z0i = zCenter - Math.cos(a0) * radius, y0i = ySpring + Math.sin(a0) * radius;
      const z1i = zCenter - Math.cos(a1) * radius, y1i = ySpring + Math.sin(a1) * radius;
      const z0o = zCenter - Math.cos(a0) * rOuter, y0o = ySpring + Math.sin(a0) * rOuter;
      const z1o = zCenter - Math.cos(a1) * rOuter, y1o = ySpring + Math.sin(a1) * rOuter;
      const vShade = 0.85 + (s % 2) * 0.06;
      if (depthSign < 0) {
        pushQuad(toWorld(xOut, y0i, z0i), toWorld(xOut, y1i, z1i), toWorld(xOut, y1o, z1o), toWorld(xOut, y0o, z0o), 11, vShade);
      } else {
        pushQuad(toWorld(xOut, y1i, z1i), toWorld(xOut, y0i, z0i), toWorld(xOut, y0o, z0o), toWorld(xOut, y1o, z1o), 11, vShade);
      }
    }
  };

  // Helper to emit a cantilevered Spanish Colonial timber balcony with corbel brackets & open wooden balusters (kind 10)
  const emitBalustradeZ = (toWorld, xWall, outSign, yFloor, z0, z1) => {
    const xOuter = xWall + outSign * 1.15;
    const xMin = Math.min(xWall, xOuter), xMax = Math.max(xWall, xOuter);
    // Planked balcony floor deck
    emitBox(toWorld, xMin, xMax, yFloor - 0.18, yFloor, z0, z1, 10, 0.78, true);
    // Top & bottom balustrade rails
    const rMin = Math.min(xOuter - outSign * 0.14, xOuter), rMax = Math.max(xOuter - outSign * 0.14, xOuter);
    emitBox(toWorld, rMin, rMax, yFloor + 0.88, yFloor + 1.02, z0, z1, 10, 0.82, true);
    emitBox(toWorld, rMin, rMax, yFloor, yFloor + 0.12, z0, z1, 10, 0.74);
    // Carved timber floor corbels (ménsulas) & vertical wooden balusters
    const spanZ = z1 - z0;
    const postCount = Math.max(4, Math.floor(spanZ / 1.15));
    for (let p = 0; p <= postCount; p++) {
      const pz = z0 + (p / postCount) * spanZ;
      emitBox(toWorld, rMin, rMax, yFloor + 0.12, yFloor + 0.88, pz - 0.06, pz + 0.06, 10, 0.75);
      if (p % 2 === 0) {
        emitBox(toWorld, xMin, xMax, yFloor - 0.46, yFloor - 0.18, pz - 0.09, pz + 0.09, 10, 0.68, true);
      }
    }
  };

  // Helper to emit an overhanging gabled or hipped terracotta roof (kind 13) with timber rafter tails (kind 10) & ridge cap
  const emitRoof = (toWorld, x0, x1, yEave, yPeak, z0, z1, overhang = 0.65, hipRatio = 0.25, wallKind = 12) => {
    const rx0 = x0 - overhang, rx1 = x1 + overhang;
    const rz0 = z0 - overhang, rz1 = z1 + overhang;
    const fasciaH = 0.24;
    // Timber fascia / eaves skirt
    emitBox(toWorld, rx0, rx1, yEave - fasciaH, yEave, rz0, rz1, 10, 0.72, true);
    // Projecting Spanish timber rafter tails (canecillos) under the eaves
    const rafterCount = Math.max(4, Math.floor((z1 - z0) / 1.8));
    for (let r = 0; r <= rafterCount; r++) {
      const rz = z0 + (r / rafterCount) * (z1 - z0);
      emitBox(toWorld, rx0 - 0.12, x0 + 0.1, yEave - fasciaH - 0.14, yEave - 0.04, rz - 0.08, rz + 0.08, 10, 0.66, true);
      emitBox(toWorld, x1 - 0.1, rx1 + 0.12, yEave - fasciaH - 0.14, yEave - 0.04, rz - 0.08, rz + 0.08, 10, 0.66, true);
    }
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
    // Raised terracotta ridge tile cap (caballete)
    if (zHip1 > zHip0 + 0.4) {
      emitBox(toWorld, midX - 0.22, midX + 0.22, yPeak - 0.08, yPeak + 0.18, zHip0, zHip1, 13, 0.98, false, 0.06);
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

    const lrmKey = inst.prefabId === 'royal_warehouse' ? 'colonial_town_block' : inst.prefabId;
    const lrmTmpl = lrmTemplates?.[lrmKey];
    if (lrmTmpl) {
      // Grounded coral-limestone foundation plinth anchoring the Hunyuan3D-2mv 3D mesh into sloped coastal terrain
      const yPlinth = yGround + 0.68;
      emitBox(toWorld, -hw - 0.55, hw + 0.55, yBase, yPlinth, -hl - 0.55, hl + 0.55, 11, 0.82);
      const minSpan = Math.min(inst.width, inst.length);
      const peakExtra =
        inst.prefabId === 'mission_chapel'
          ? (inst.roofPitch ?? 3.4) + Math.max(5.8, minSpan * 0.24)
          : inst.prefabId === 'stone_sea_bastion'
            ? Math.max(4.8, minSpan * 0.16)
            : (inst.roofPitch ?? 2.6) + Math.max(1.2, minSpan * 0.06);
      const yPeak = yTop + peakExtra;
      // LRM mesh vertices are normalized to [-0.46, +0.46] (span 0.92), so scale by 1/0.92 = 1.087 to cover 100% of the footprint
      emitLRMMesh(toWorld, lrmTmpl, inst.width * 1.087, yPlinth - 0.18, yPeak, inst.length * 1.087, cosY, sinY);
      continue;
    }

    if (inst.prefabId === 'timber_mole_pier') {
      // Open timber trestle pier: planked deck + side curbs + seabed pilings + cross-bracing + bollards + cargo crane
      const deckBottom = yTop - 0.55;
      emitBox(toWorld, -hw, hw, deckBottom, yTop, -hl, hl, 10, 0.86, true);
      // Side wheel-guard curbs
      emitBox(toWorld, -hw, -hw + 0.34, yTop, yTop + 0.28, -hl, hl, 10, 0.78);
      emitBox(toWorld, hw - 0.34, hw, yTop, yTop + 0.28, -hl, hl, 10, 0.78);
      // Longitudinal stringer beams under deck
      emitBox(toWorld, -hw + 0.55, -hw + 1.05, deckBottom - 0.55, deckBottom, -hl + 0.4, hl - 0.4, 10, 0.68, true);
      emitBox(toWorld, hw - 1.05, hw - 0.55, deckBottom - 0.55, deckBottom, -hl + 0.4, hl - 0.4, 10, 0.68, true);
      // Paired cylindrical timber pilings every 5.2m + transverse cross-beam caps & mooring bollards
      const bays = Math.max(4, Math.floor(inst.length / 5.2));
      for (let b = 0; b <= bays; b++) {
        const z = -hl + 1.2 + (b / bays) * (inst.length - 2.4);
        emitCylinder(toWorld, -hw + 0.48, z, yBase, yTop + 0.58, 0.26, 0.24, 6, 10, 0.66, true);
        emitCylinder(toWorld, hw - 0.48, z, yBase, yTop + 0.58, 0.26, 0.24, 6, 10, 0.66, true);
        // Transverse bent beam above water
        emitBox(toWorld, -hw + 0.3, hw - 0.3, deckBottom - 0.95, deckBottom - 0.55, z - 0.18, z + 0.18, 10, 0.62, true);
        if (b % 2 === 0) {
          // Heavy iron mooring bollards along the deck edge
          emitCylinder(toWorld, -hw + 0.75, z, yTop + 0.28, yTop + 0.96, 0.22, 0.26, 6, 14, 0.45, true);
          emitCylinder(toWorld, hw - 0.75, z, yTop + 0.28, yTop + 0.96, 0.22, 0.26, 6, 14, 0.45, true);
        }
      }
      // Seaward pier-head stone plinth, iron cresset beacon tower & timber cargo derrick crane
      emitBox(toWorld, -1.2, 1.2, yTop, yTop + 1.7, -hl + 0.6, -hl + 3.0, 11, 0.88);
      emitCylinder(toWorld, 0, -hl + 1.8, yTop + 1.7, yTop + 5.4, 0.24, 0.18, 6, 10, 0.72, true);
      emitCylinder(toWorld, 0, -hl + 1.8, yTop + 5.4, yTop + 6.2, 0.52, 0.68, 6, 14, 0.52, true);
      // Timber treadwheel cargo crane mid-pier
      emitCylinder(toWorld, hw - 1.2, -hl * 0.35, yTop, yTop + 4.8, 0.32, 0.26, 6, 10, 0.76, true);
      emitBox(toWorld, hw - 1.4, hw + 2.2, yTop + 3.9, yTop + 4.35, -hl * 0.35 - 0.2, -hl * 0.35 + 0.2, 10, 0.74, true);
    } else if (inst.prefabId === 'stone_quay_seawall') {
      // Continuous Colonial Stone Seawall & Wharf (Malecón y Muelle de Piedra):
      // Battered coral-limestone seawall + stone coping parapet + boat-landing stairs + mooring bollards + arched stone customs gate
      const yCoping = yTop - 0.35;
      emitBox(toWorld, -hw - 0.8, hw + 0.8, yBase, yCoping, -hl - 0.8, hl + 0.4, 11, 0.84, false, 0.6);
      // Heavy cut-stone coping course & paved wharf apron
      emitBox(toWorld, -hw, hw, yCoping, yTop, -hl, hl, 11, 0.92, true);
      // Low seaward parapet wall with gaps for the central timber pier & two boat-landing stairways
      emitBox(toWorld, -hw, -22, yTop, yTop + 0.65, -hl, -hl + 1.1, 11, 0.88);
      emitBox(toWorld, -15, -5.5, yTop, yTop + 0.65, -hl, -hl + 1.1, 11, 0.88);
      emitBox(toWorld, 5.5, 15, yTop, yTop + 0.65, -hl, -hl + 1.1, 11, 0.88);
      emitBox(toWorld, 22, hw, yTop, yTop + 0.65, -hl, -hl + 1.1, 11, 0.88);
      // Stepped stone boat-landing stairs at x in [-22, -15] and [15, 22]
      for (const stairX of [-18.5, 18.5]) {
        for (let stepIdx = 0; stepIdx < 5; stepIdx++) {
          const sy1 = yTop - stepIdx * 0.42;
          const sy0 = sy1 - 0.45;
          const sz0 = -hl - 0.4 - stepIdx * 0.45;
          emitBox(toWorld, stairX - 3.2, stairX + 3.2, sy0, sy1, sz0, -hl + 1.2, 11, 0.78 - stepIdx * 0.04);
        }
      }
      // Cylindrical stone & iron mooring bollards along the quay edge
      for (let bx = -hw + 6; bx <= hw - 6; bx += 14) {
        if (Math.abs(bx) < 5 || (Math.abs(bx) > 14 && Math.abs(bx) < 23)) continue;
        emitCylinder(toWorld, bx, -hl + 0.6, yTop + 0.65, yTop + 1.38, 0.34, 0.38, 6, 14, 0.42, true);
      }
    } else if (inst.prefabId === 'stone_sea_bastion') {
      // 16th-century Spanish Stone Sea Bastion (Baluarte / Castillo):
      // Battered coral-limestone scarp walls + cordon moulding + crenellated parapet & naval cannons
      // + 4 cylindrical corbeled domed sentry turrets (garitas) + central arched keep
      const yCordon = yTop - 1.6;
      emitBox(toWorld, -hw - 1.6, hw + 1.6, yBase, yCordon, -hl - 1.6, hl + 1.6, 11, 0.84, false, 1.6);
      // Projecting semicircular stone cordon moulding (bocel)
      emitBox(toWorld, -hw - 0.42, hw + 0.42, yCordon, yCordon + 0.46, -hl - 0.42, hl + 0.42, 11, 0.93, true);
      // Terreplein gun deck
      emitBox(toWorld, -hw, hw, yCordon + 0.46, yTop - 0.9, -hl, hl, 11, 0.80);
      // Perimeter crenellated parapet walls with sloped cannon embrasures & naval guns
      const wallT = 1.75;
      const merlonY = yTop + 0.92;
      for (const sideZ of [-1, 1]) {
        const zOut = sideZ < 0 ? -hl : hl - wallT;
        const zIn = sideZ < 0 ? -hl + wallT : hl;
        emitBox(toWorld, -hw, hw, yTop - 0.9, yTop, zOut, zIn, 11, 0.86);
        for (let m = -2; m <= 2; m++) {
          const mx = m * 5.2;
          emitBox(toWorld, mx - 1.65, mx + 1.65, yTop, merlonY, zOut, zIn, 11, 0.90, false, 0.12);
          if (m < 2) {
            // Stepped wooden naval gun carriage (kind 10) + bronze/iron cannon barrel (kind 14)
            const ex = mx + 2.6;
            const cZ = sideZ < 0 ? zIn + 0.4 : zOut - 0.4;
            emitBox(toWorld, ex - 0.52, ex + 0.52, yTop - 0.85, yTop + 0.08, cZ - 0.75, cZ + 0.75, 10, 0.72);
            emitBox(toWorld, ex - 0.58, ex + 0.58, yTop - 0.25, yTop + 0.35, zOut - 0.08, zIn + 0.08, 14, 0.35);
            emitBox(
              toWorld,
              ex - 0.20,
              ex + 0.20,
              yTop + 0.06,
              yTop + 0.46,
              sideZ < 0 ? zOut - 0.95 : zIn - 0.2,
              sideZ < 0 ? zIn + 0.2 : zIn + 0.95,
              14,
              0.28,
              true
            );
          }
        }
      }
      for (const sideX of [-1, 1]) {
        const xOut = sideX < 0 ? -hw : hw - wallT;
        const xIn = sideX < 0 ? -hw + wallT : hw;
        emitBox(toWorld, xOut, xIn, yTop - 0.9, yTop, -hl + wallT, hl - wallT, 11, 0.84);
        for (let m = -2; m <= 2; m++) {
          const mz = m * 5.8;
          emitBox(toWorld, xOut, xIn, yTop, merlonY, mz - 1.8, mz + 1.8, 11, 0.88, false, 0.12);
        }
      }
      // 4 Corner Cylindrical Bartizan Sentry Turrets (Garitas) with inverted-cone corbels & stone cupolas
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const gx = sx * (hw + 0.35), gz = sz * (hl + 0.35);
          // Corbeled inverted-cone stone bracket
          emitCylinder(toWorld, gx, gz, yCordon - 1.4, yCordon + 0.35, 0.35, 1.48, 8, 11, 0.78, false);
          // Molded stone ring collar
          emitCylinder(toWorld, gx, gz, yCordon + 0.35, yCordon + 0.65, 1.58, 1.58, 8, 11, 0.92, true);
          // Cylindrical sentry drum with spy-slit embrasures
          emitCylinder(toWorld, gx, gz, yCordon + 0.65, merlonY + 1.65, 1.38, 1.38, 8, 11, 0.90, true);
          emitBox(toWorld, gx - 1.44, gx + 1.44, yCordon + 1.35, merlonY + 1.05, gz - 0.22, gz + 0.22, 14, 0.30);
          emitBox(toWorld, gx - 0.22, gx + 0.22, yCordon + 1.35, merlonY + 1.05, gz - 1.44, gz + 1.44, 14, 0.30);
          // Eave cornice + hemispherical stone cupola dome & finial ball
          emitCylinder(toWorld, gx, gz, merlonY + 1.65, merlonY + 1.88, 1.52, 1.52, 8, 11, 0.94, true);
          emitCylinder(toWorld, gx, gz, merlonY + 1.88, merlonY + 2.75, 1.42, 0.72, 8, 11, 0.95, false);
          emitCylinder(toWorld, gx, gz, merlonY + 2.75, merlonY + 3.25, 0.72, 0.14, 8, 11, 0.97, true);
        }
      }
      // Interior command keep / Gobernador's citadel with arched stone portal, limewashed walls & hipped terracotta roof
      const kw = hw * 0.46, kl = hl * 0.48, yKeep = merlonY + 4.4;
      emitBox(toWorld, -kw - 0.35, kw + 0.35, yTop - 0.9, yTop + 0.65, -kl - 0.35, kl + 0.35, 11, 0.84);
      emitBox(toWorld, -kw, kw, yTop + 0.65, yKeep, -kl, kl, 12, 0.91);
      emitStoneArchZ(toWorld, -kw, -1, yTop + 0.65, yTop + 2.4, 1.15, 0, 6);
      emitRoof(toWorld, -kw, kw, yKeep, yKeep + 2.8, -kl, kl, 0.72, 0.26, 12);
    } else if (inst.prefabId === 'casa_de_contratacion') {
      // Royal Customhouse (Casa de la Contratación):
      // Cut-stone plinth + 5-arch radial stone voussoir waterfront loggia + 2nd-story cantilevered balustrade balcony + hipped tile roof
      const yPlinth = yGround + 0.85;
      emitBox(toWorld, -hw - 0.85, hw + 0.85, yBase, yPlinth, -hl - 0.85, hl + 0.85, 11, 0.82);
      const loggiaD = 2.65;
      emitBox(toWorld, -hw, hw, yPlinth, yTop, -hl + loggiaD, hl, 12, 0.89);
      const yMid = yPlinth + (yTop - yPlinth) * 0.48;
      emitBox(toWorld, -hw, hw, yMid, yTop, -hl, -hl + loggiaD, 12, 0.91, true);
      // Molded stone belt course between ground arcade and piano nobile
      emitBox(toWorld, -hw - 0.18, hw + 0.18, yMid - 0.22, yMid + 0.12, -hl - 0.18, hl + 0.18, 11, 0.88, true);
      // Alternating tooth-stone ashlar corner quoins
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          const qx = sx * hw, qz = sz * hl;
          for (let q = 0; q < 6; q++) {
            const qy0 = yPlinth + (q / 6) * (yTop - yPlinth);
            const qy1 = qy0 + (yTop - yPlinth) / 6 - 0.06;
            const qSpan = q % 2 === 0 ? 0.78 : 0.48;
            emitBox(
              toWorld,
              qx - (sx > 0 ? qSpan : 0.09),
              qx + (sx < 0 ? qSpan : 0.09),
              qy0,
              qy1,
              qz - (sz > 0 ? qSpan : 0.09),
              qz + (sz < 0 ? qSpan : 0.09),
              11,
              0.85
            );
          }
        }
      }
      // 5-Bay Radial Stone Voussoir Arched Waterfront Colonnade & Upper Shuttered Balcony Doors
      const bays = 5;
      const baySpan = (inst.length - 1.6) / bays;
      for (let b = 0; b < bays; b++) {
        const bz = -hl + 0.8 + (b + 0.5) * baySpan;
        emitStoneArchZ(toWorld, -hw, -1, yPlinth, yPlinth + 2.05, Math.min(1.32, baySpan * 0.36), bz, 6);
        emitStoneArchZ(toWorld, hw, 1, yPlinth, yPlinth + 2.05, Math.min(1.32, baySpan * 0.36), bz, 6);
        // Upper floor tall arched shuttered doors opening onto the balcony + stone pediments
        emitBox(toWorld, -hw - 0.08, -hw + 0.14, yMid + 0.25, yTop - 0.68, bz - 0.68, bz + 0.68, 14, 0.34);
        emitBox(toWorld, -hw - 0.16, -hw + 0.18, yTop - 0.68, yTop - 0.42, bz - 0.82, bz + 0.82, 11, 0.86, true);
        emitBox(toWorld, hw - 0.14, hw + 0.08, yMid + 0.25, yTop - 0.68, bz - 0.68, bz + 0.68, 14, 0.34);
        emitBox(toWorld, hw - 0.18, hw + 0.16, yTop - 0.68, yTop - 0.42, bz - 0.82, bz + 0.82, 11, 0.86, true);
      }
      // Open cantilevered timber balustrade balconies on both long facades
      emitBalustradeZ(toWorld, -hw, -1, yMid + 0.08, -hl + 0.8, hl - 0.8);
      emitBalustradeZ(toWorld, hw, 1, yMid + 0.08, -hl + 0.8, hl - 0.8);
      emitRoof(toWorld, -hw - 0.2, hw + 0.2, yTop, yTop + (inst.roofPitch ?? 2.8), -hl - 0.2, hl + 0.2, 0.85, 0.22, 12);
    } else if (inst.prefabId === 'mission_chapel') {
      // 16th-century Spanish Colonial Iglesia, Stepped Espadaña Facade & 3-Stage Arched Campanario
      const yPlinth = yGround + 0.78;
      emitBox(toWorld, -hw - 0.75, hw + 0.75, yBase, yPlinth, -hl - 0.75, hl + 0.75, 11, 0.82);
      // Nave walls + semicircular apse sanctuary at the east (+hl) end
      emitBox(toWorld, -hw, hw, yPlinth, yTop, -hl, hl, 12, 0.91);
      emitCylinder(toWorld, 0, hl + 0.4, yPlinth, yTop - 1.1, hw * 0.62, hw * 0.62, 8, 12, 0.89, true);
      emitCylinder(toWorld, 0, hl + 0.4, yTop - 1.1, yTop + 0.9, hw * 0.66, 0.18, 8, 13, 0.93, true);
      // 5 pairs of stepped exterior masonry flying/pilaster buttresses along the nave walls
      for (let b = 0; b < 5; b++) {
        const bz = -hl + 1.2 + (b / 4) * (inst.length - 2.4);
        emitBox(toWorld, -hw - 0.82, -hw, yPlinth, yTop - 0.4, bz - 0.45, bz + 0.45, 11, 0.84, false, 0.18);
        emitBox(toWorld, hw, hw + 0.82, yPlinth, yTop - 0.4, bz - 0.45, bz + 0.45, 11, 0.84, false, 0.18);
        if (b < 4) {
          const wz = bz + (inst.length - 2.4) / 8;
          emitStoneArchZ(toWorld, -hw, -1, yPlinth + 2.6, yTop - 2.2, 0.62, wz, 5);
          emitStoneArchZ(toWorld, hw, 1, yPlinth + 2.6, yTop - 2.2, 0.62, wz, 5);
        }
      }
      // West facade Plateresque carved stone portal frame, arched doorway, flanking pilasters & rose choir window
      emitBox(toWorld, -2.85, 2.85, yPlinth, yPlinth + 6.4, -hl - 0.48, -hl, 11, 0.88);
      emitCylinder(toWorld, -2.35, -hl - 0.48, yPlinth, yPlinth + 5.8, 0.28, 0.24, 6, 11, 0.91, true);
      emitCylinder(toWorld, 2.35, -hl - 0.48, yPlinth, yPlinth + 5.8, 0.28, 0.24, 6, 11, 0.91, true);
      emitBox(toWorld, -3.1, 3.1, yPlinth + 5.8, yPlinth + 6.4, -hl - 0.65, -hl, 11, 0.92, true);
      emitBox(toWorld, -1.45, 1.45, yPlinth, yPlinth + 4.8, -hl - 0.56, -hl + 0.1, 14, 0.28);
      // Octagonal/rose choir window above portal
      emitCylinder(toWorld, 0, -hl - 0.22, yPlinth + 7.2, yPlinth + 9.2, 1.15, 1.15, 8, 11, 0.88, true);
      emitBox(toWorld, -0.82, 0.82, yPlinth + 7.45, yPlinth + 8.95, -hl - 0.36, -hl + 0.08, 14, 0.32);
      // Stepped baroque stone gable parapet (Espadaña) rising above the west facade
      const yPeak = yTop + (inst.roofPitch ?? 3.4);
      emitBox(toWorld, -hw * 0.72, hw * 0.72, yTop, yPeak - 0.6, -hl - 0.35, -hl + 0.35, 12, 0.92);
      emitBox(toWorld, -hw * 0.38, hw * 0.38, yPeak - 0.6, yPeak + 1.2, -hl - 0.35, -hl + 0.35, 11, 0.90);
      emitRoof(toWorld, -hw, hw, yTop, yPeak, -hl, hl, 0.78, 0.0, 12);
      // 3-Stage Spanish Colonial Bell Tower (Campanario) with arched belfries, bronze bells & octagonal cupola
      const tx0 = hw - 2.2, tx1 = hw + 2.8, tz0 = -hl - 1.3, tz1 = -hl + 3.7;
      const tmx = (tx0 + tx1) * 0.5, tmz = (tz0 + tz1) * 0.5;
      const yT1 = yTop + 2.8, yT2 = yT1 + 4.1, yT3 = yT2 + 3.4;
      emitBox(toWorld, tx0, tx1, yPlinth, yT1, tz0, tz1, 12, 0.92);
      emitBox(toWorld, tx0 - 0.28, tx1 + 0.28, yT1 - 0.34, yT1, tz0 - 0.28, tz1 + 0.28, 11, 0.90, true);
      emitBox(toWorld, tx0 + 0.35, tx1 - 0.35, yT1, yT2, tz0 + 0.35, tz1 - 0.35, 12, 0.94);
      // Arched belfry openings + suspended bronze bell in center of belfry
      emitStoneArchZ(toWorld, tx1 - 0.35, 1, yT1 + 0.45, yT2 - 1.35, 0.78, tmz, 5);
      emitStoneArchZ(toWorld, tx0 + 0.35, -1, yT1 + 0.45, yT2 - 1.35, 0.78, tmz, 5);
      emitBox(toWorld, tmx - 0.72, tmx + 0.72, yT1 + 0.55, yT2 - 0.65, tz0 + 0.26, tz1 - 0.26, 14, 0.30);
      emitCylinder(toWorld, tmx, tmz, yT1 + 1.45, yT1 + 2.45, 0.58, 0.24, 8, 10, 0.76, true);
      emitBox(toWorld, tx0 + 0.12, tx1 - 0.12, yT2 - 0.32, yT2, tz0 + 0.12, tz1 - 0.12, 11, 0.91, true);
      // Octagonal terracotta bell-tower dome & wrought-iron cross finial
      emitCylinder(toWorld, tmx, tmz, yT2, yT3, 2.05, 0.22, 8, 13, 0.95, true);
      emitBox(toWorld, tmx - 0.08, tmx + 0.08, yT3, yT3 + 1.35, tmz - 0.08, tmz + 0.08, 14, 0.42);
      emitBox(toWorld, tmx - 0.48, tmx + 0.48, yT3 + 0.75, yT3 + 0.92, tmz - 0.08, tmz + 0.08, 14, 0.42);
    } else if (inst.prefabId === 'careening_shed') {
      // Open-sided timber boatyard pavilion on the beach (Atarazana / Carenero) + king-post roof trusses + pitch furnace
      const yApron = yGround + 0.45;
      emitBox(toWorld, -hw - 0.6, hw + 0.6, yBase, yApron, -hl - 0.6, hl + 0.6, 10, 0.74);
      const cols = 5;
      for (let c = 0; c < cols; c++) {
        const cz = -hl + 1.0 + (c / (cols - 1)) * (inst.length - 2.0);
        emitCylinder(toWorld, -hw + 0.58, cz, yApron, yTop, 0.28, 0.25, 6, 10, 0.78, true);
        emitCylinder(toWorld, hw - 0.58, cz, yApron, yTop, 0.28, 0.25, 6, 10, 0.78, true);
        // Tie-beam & king-post truss
        emitBox(toWorld, -hw + 0.2, hw - 0.2, yTop - 0.42, yTop, cz - 0.20, cz + 0.20, 10, 0.72, true);
        emitBox(toWorld, -0.18, 0.18, yTop, yTop + 1.85, cz - 0.18, cz + 0.18, 10, 0.70);
      }
      // Pitch-boiling stone hearth & tapered chimney at the inland end + wooden careening capstan
      emitBox(toWorld, -1.9, 1.9, yApron, yTop + 2.6, hl - 2.3, hl - 0.2, 11, 0.80, false, 0.48);
      emitCylinder(toWorld, 0, -hl + 2.6, yApron, yApron + 1.45, 0.68, 0.52, 8, 10, 0.76, true);
      emitBox(toWorld, -2.1, 2.1, yApron + 1.15, yApron + 1.32, -hl + 2.48, -hl + 2.72, 10, 0.82, true);
      emitRoof(toWorld, -hw, hw, yTop, yTop + (inst.roofPitch ?? 2.1), -hl, hl, 0.78, 0.12, 10);
    } else {
      // Royal Warehouse (Almacén Real) & Colonial Courtyard Town Blocks (Casa Solariega):
      const yPlinth = yGround + 0.68;
      emitBox(toWorld, -hw - 0.65, hw + 0.65, yBase, yPlinth, -hl - 0.65, hl + 0.65, 11, 0.80);
      if (inst.prefabId === 'colonial_town_block') {
        // Two-wing L-shaped Spanish Colonial courtyard townhouse (Casa Solariega) + arched courtyard gate + wooden rejas
        const mainW = hw * 1.15;
        emitBox(toWorld, -hw, -hw + mainW, yPlinth, yTop + 1.15, -hl, hl, 12, 0.89);
        emitRoof(toWorld, -hw, -hw + mainW, yTop + 1.15, yTop + 1.15 + (inst.roofPitch ?? 2.1), -hl, hl, 0.68, 0.22, 12);
        // Secondary cross-wing
        const wingL = hl * 0.95;
        emitBox(toWorld, -hw + mainW * 0.7, hw, yPlinth, yTop - 0.35, -hl, -hl + wingL, 12, 0.86);
        emitRoof(toWorld, -hw + mainW * 0.7, hw, yTop - 0.35, yTop - 0.35 + 1.85, -hl, -hl + wingL, 0.62, 0.25, 12);
        // Courtyard enclosure wall with terracotta tile coping & radial stone arched carriage portal (zaguán)
        emitBox(toWorld, hw - 1.1, hw, yPlinth, yPlinth + 3.4, -hl + wingL, hl, 12, 0.84);
        emitBox(toWorld, hw - 1.25, hw + 0.15, yPlinth + 3.4, yPlinth + 3.72, -hl + wingL, hl, 13, 0.92, true);
        emitStoneArchZ(toWorld, hw, 1, yPlinth, yPlinth + 2.0, 1.05, (-hl + wingL + hl) * 0.5, 5);
        emitBox(toWorld, -hw + mainW, hw, yPlinth, yPlinth + 3.4, hl - 1.1, hl, 12, 0.84);
        emitBox(toWorld, -hw + mainW, hw + 0.15, yPlinth + 3.4, yPlinth + 3.72, hl - 1.25, hl + 0.15, 13, 0.92, true);
        // Street arched portal, wooden spindle window grilles (rejas) & cantilevered 2nd-story balustrade balcony
        emitStoneArchZ(toWorld, -hw, -1, yPlinth, yPlinth + 2.15, 1.12, 0, 5);
        for (const wz of [-hl * 0.64, -hl * 0.34, hl * 0.34, hl * 0.64]) {
          emitBox(toWorld, -hw - 0.14, -hw + 0.14, yPlinth + 0.85, yPlinth + 2.55, wz - 0.58, wz + 0.58, 14, 0.34);
          emitBox(toWorld, -hw - 0.24, -hw + 0.05, yPlinth + 0.72, yPlinth + 2.68, wz - 0.66, wz + 0.66, 10, 0.72, true);
        }
        for (let w = -2; w <= 2; w++) {
          const wz = w * (hl * 0.34);
          emitBox(toWorld, -hw - 0.08, -hw + 0.15, yPlinth + 3.65, yTop + 0.45, wz - 0.56, wz + 0.56, 14, 0.34);
        }
        emitBalustradeZ(toWorld, -hw, -1, yPlinth + 3.45, -hl * 0.72, hl * 0.72);
      } else {
        // Royal Warehouse (Almacén Real): buttressed masonry hall with 4 radial stone voussoir arched cargo portals
        emitBox(toWorld, -hw, hw, yPlinth, yTop, -hl, hl, 12, 0.88);
        for (let b = 0; b < 5; b++) {
          const bz = -hl + 1.0 + (b / 4) * (inst.length - 2.0);
          emitBox(toWorld, -hw - 0.55, -hw, yPlinth, yTop - 0.25, bz - 0.40, bz + 0.40, 11, 0.83, false, 0.12);
          emitBox(toWorld, hw, hw + 0.55, yPlinth, yTop - 0.25, bz - 0.40, bz + 0.40, 11, 0.83, false, 0.12);
          if (b < 4) {
            const pz = bz + (inst.length - 2.0) / 8;
            // Radial stone voussoir cargo portal + timber hoist beam + clerestory oculus
            emitStoneArchZ(toWorld, -hw, -1, yPlinth, yPlinth + 2.25, 1.18, pz, 6);
            emitStoneArchZ(toWorld, hw, 1, yPlinth, yPlinth + 2.25, 1.18, pz, 6);
            emitBox(toWorld, -hw - 0.08, hw + 0.08, yPlinth + 4.65, yTop - 0.85, pz - 0.65, pz + 0.65, 14, 0.36);
          }
        }
        emitRoof(toWorld, -hw, hw, yTop, yTop + (inst.roofPitch ?? 2.4), -hl, hl, 0.78, 0.15, 12);
      }
    }
  }

  // Optional 3D Corner-model Coconut Palms (Cocos nucifera: seaward-leaning ringed trunk + 12 arching pinnate fronds)
  // along the sandy foreshore berm so tropical beaches have authentic silhouette palms
  if (palms instanceof Float32Array && palms.length >= 8) {
    const maxPalms = Math.min(palms.length / 8, 420);
    const seawardRad = ((portPlacement.shoreBearing ?? 112) + 180) * COASTAL_DEG_TO_RAD;
    const defaultSeaX = Math.sin(seawardRad);
    const defaultSeaZ = -Math.cos(seawardRad);
    for (let idx = 0; idx < maxPalms; idx++) {
      const base = idx * 8;
      const px = palms[base], py = palms[base + 1], pz = palms[base + 2];
      const plumeR = palms[base + 3], ht = palms[base + 4], shape = palms[base + 5];
      const psx = palms[base + 6] || 0, psz = palms[base + 7] || 0;
      const gradLen = Math.hypot(psx, psz);
      // Lean seaward down the local beach slope (-sx, -sz) when available
      const seaX = gradLen > 0.008 ? -psx / gradLen : defaultSeaX;
      const seaZ = gradLen > 0.008 ? -psz / gradLen : defaultSeaZ;
      const azSpread = (shape - 0.5) * 1.15;
      const leanAngle = Math.atan2(seaZ, seaX) + azSpread;
      const leanDirX = Math.cos(leanAngle), leanDirZ = Math.sin(leanAngle);
      const leanMag = 2.1 + ((shape * 7) % 1) * 2.2;
      const segs = 5;
      let prevX = px, prevY = py - 0.35, prevZ = pz, prevR = 0.42;
      for (let s = 1; s <= segs; s++) {
        const t = s / segs;
        const curY = py + t * ht;
        // Phototropic S-curve: leans strongly seaward near base/mid-trunk, then rights toward crown
        const curve = (1.35 * t - 0.35 * t * t) * leanMag;
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

export function synthesizeCoastalBiome(regionSpec, heights, beaches = null, portPlacement = null, satelliteData = null) {
  const region = resolveGlobalCoastalRegion(regionSpec);
  const m = region.biomeSize;
  const span = region.span;
  const seed = (region.vegetationSeed ^ 0x7f4a7c15) >>> 0;
  const beachData = beaches ?? synthesizeCoastalBeaches(region, heights, satelliteData);
  const mask = new Uint8Array(m * m);

  const is1550Ortho = Boolean(satelliteData?.is1550Orthophoto);
  const minTreeElev = is1550Ortho ? 1.2 : 1.5;

  for (let j = 0; j < m; j++) {
    const v = (j + 0.5) / m;
    const z = region.z + (v - 0.5) * span;
    for (let i = 0; i < m; i++) {
      const u = (i + 0.5) / m;
      const x = region.x + (u - 0.5) * span;
      const idx = j * m + i;
      const h = terrainSample(heights, x, z, region);
      if (h < minTreeElev || beachData.swashMask[idx] > 80 || beachData.drySandMask[idx] > 140) {
        mask[idx] = 0;
        continue;
      }
      if (portPlacement) {
        const distPort = Math.hypot(x - portPlacement.center.x, z - portPlacement.center.z);
        const clearEnvelope = !portClearanceEnvelope(portPlacement, x, z, is1550Ortho ? 8 : 12);
        const clearCircle = !portPlacement.hasOrthophotoFootprints && distPort < portPlacement.clearRadius * 0.72;
        if (clearEnvelope || clearCircle) {
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
      const patchNoise = coastalFbm2D(u * 6.5 + 1.9, v * 6.5 - 2.4, seed, 4);
      const moisture = coastalSmoothstep(minTreeElev, 7.5, h) * coastalSmoothstep(1.12, 0.35, slope);
      const proceduralVeg = Math.min(1, moisture * (0.54 + 0.62 * patchNoise));
      const sat = sampleSatelliteEquirectangular(satelliteData, u, v);
      let vegProb = proceduralVeg;
      if (sat) {
        if (is1550Ortho) {
          // Top-down 1550 map is ground truth: bake forest into all green forest/canopy areas of the map,
          // and keep dirt plazas, streets, courtyards, beaches, and building roofs open.
          const isForest1550 =
            sat.greenness > 0.036 ||
            (sat.g >= sat.r - 3 && sat.g > sat.b + 6 && sat.luma >= 16 && sat.luma <= 148);
          const isWarmClearingOrRoof =
            (sat.r > sat.g + 8 && sat.r > sat.b + 18) || sat.sandChroma > 0.34;
          vegProb =
            isForest1550 && !isWarmClearingOrRoof
              ? Math.min(1, 0.72 + sat.greenness * 1.15) * coastalSmoothstep(1.12, 0.42, slope)
              : 0;
        } else {
          // Combine 2026 satellite spectral excess-green index with 1550s historical reforestation
          // of modern urban concrete/roofs so natural beaches/cliffs stay open while cities revert to jungle.
          const satGreen = Math.min(1, sat.greenness * 1.18);
          const restoredUrban =
            sat.isUrban && h > 1.6 && slope < 0.65 && sat.sandChroma < 0.35
              ? (0.68 + 0.26 * patchNoise) * moisture
              : 0;
          vegProb = Math.max(satGreen, restoredUrban, proceduralVeg * 0.65) * coastalSmoothstep(1.12, 0.42, slope);
        }
      }
      mask[idx] = Math.max(0, Math.min(255, Math.round(255 * vegProb)));
    }
  }
  return mask;
}

export function synthesizeCoastalAlbedo(
  regionSpec,
  heights,
  beaches = null,
  portPlacement = null,
  biome = null,
  satelliteData = null,
  shoreDist = null
) {
  const region = resolveGlobalCoastalRegion(regionSpec);
  const size = region.albedoSize;
  const n = region.size;
  const span = region.span;
  const seed = (region.vegetationSeed ^ 0x9e3779b9) >>> 0;
  const distInfo = shoreDist ?? computeCoastalShoreDistances(heights, n, span, 0.25);
  const beachData = beaches ?? synthesizeCoastalBeaches(region, heights, satelliteData, distInfo);
  const biomeMask = biome ?? synthesizeCoastalBiome(region, heights, beachData, portPlacement, satelliteData);
  const rgba = new Uint8Array(size * size * 4);

  for (let j = 0; j < size; j++) {
    const v = (j + 0.5) / size;
    const z = region.z + (v - 0.5) * span;
    const gj = Math.min(n - 1, Math.max(0, Math.round(v * (n - 1))));
    for (let i = 0; i < size; i++) {
      const u = (i + 0.5) / size;
      const x = region.x + (u - 0.5) * span;
      const gi = Math.min(n - 1, Math.max(0, Math.round(u * (n - 1))));
      const inlandM = distInfo.distWater[gj * n + gi];
      const h = terrainSample(heights, x, z, region);
      const sx = (terrainSample(heights, x + 8, z, region) - terrainSample(heights, x - 8, z, region)) / 16;
      const sz = (terrainSample(heights, x, z + 8, region) - terrainSample(heights, x, z - 8, region)) / 16;
      const slope = Math.hypot(sx, sz);

      const veg = vegetationProbability(biomeMask, region.biomeSize, u, v);
      const sandNoise = (coastalFbm2D(u * 22 + 3.1, v * 22 - 1.7, seed, 3) - 0.5) * 2;
      const fineGrain = (coastalValueNoise2D(u * 68, v * 68, seed ^ 0x55aa55aa) - 0.5) * 14;

      // Base inland colour: continuous blend between dry coastal earth, lush forest canopy, and exposed cliff stone
      const forestR = 112 - veg * 64 + sandNoise * 6;
      const forestG = 126 - veg * 34 + sandNoise * 6;
      const forestB = 82 - veg * 40 + sandNoise * 4;
      const cliffWeight = coastalSmoothstep(0.42, 0.78, slope);
      const rockR = 114 + sandNoise * 10 + fineGrain * 0.6;
      const rockG = 108 + sandNoise * 9 + fineGrain * 0.5;
      const rockB = 98 + sandNoise * 8 + fineGrain * 0.5;

      let r = forestR * (1 - cliffWeight) + rockR * cliffWeight;
      let g = forestG * (1 - cliffWeight) + rockG * cliffWeight;
      let b = forestB * (1 - cliffWeight) + rockB * cliffWeight;

      const sat = sampleSatelliteEquirectangular(satelliteData, u, v);
      if (sat && h > 0.15) {
        // Bounded local shadow lifting matching scripts/prepare-land-imagery.py:153
        const lift =
          Math.min(1.35, Math.max(0.90, Math.pow(Math.max(sat.localLuma, 32) / Math.max(sat.luma, 10), 0.25))) *
          1.08;
        const satR = Math.min(255, sat.r * lift);
        const satG = Math.min(255, sat.g * lift);
        const satB = Math.min(255, sat.b * lift);
        if (!satelliteData?.is1550Orthophoto && sat.isUrban && cliffWeight < 0.45 && (inlandM > 45 || sat.sandChroma < 0.3)) {
          // 1550s historical cleanup: replace modern concrete/roof chromaticity with natural tropical canopy/soil
          // while preserving subtle topographic luminance texture from the satellite orthophoto
          const reliefMod = Math.max(0.76, Math.min(1.22, (sat.luma * lift) / Math.max(42, sat.localLuma)));
          r = r * reliefMod;
          g = g * reliefMod;
          b = b * reliefMod;
        } else {
          // Co-registered natural satellite orthophoto color (canopy, soil, rocky cliffs, and sandy berms)
          const satBlend = coastalSmoothstep(0.15, 1.4, h) * 0.78;
          r = r * (1 - satBlend) + satR * satBlend;
          g = g * (1 - satBlend) + satG * satBlend;
          b = b * (1 - satBlend) + satB * satBlend;
        }
      }

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

      // Foreshore-constrained dry coral/quartz beach berm & backshore dune sand
      const gentleSlope = coastalSmoothstep(0.28, 0.09, slope);
      const shoreBand = coastalSmoothstep(95, 32, inlandM);
      const bermTop = 5.4 + sandNoise * 1.1;
      const drySandWeight =
        coastalSmoothstep(-0.3, 0.7, h) *
        coastalSmoothstep(bermTop, 1.4, h) *
        gentleSlope *
        shoreBand;
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
        coastalSmoothstep(0.26, 0.08, slope) *
        coastalSmoothstep(48, 16, inlandM);
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

export function seedCoastalVegetation(
  regionSpec,
  heights,
  biome = null,
  beaches = null,
  portPlacement = null,
  palmPrototypeId = 5,
  shoreDist = null
) {
  const region = resolveGlobalCoastalRegion(regionSpec);
  const n = region.size;
  const m = region.biomeSize;
  const distInfo = shoreDist ?? computeCoastalShoreDistances(heights, n, region.span, 0.25);
  const beachData = beaches ?? synthesizeCoastalBeaches(region, heights, null, distInfo);
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

    const prob = vegetationProbability(biomeMask, m, u, v);
    if (prob <= 0 || density > prob * 0.92) continue;

    const gi = Math.min(n - 1, Math.max(0, Math.round(u * (n - 1))));
    const gj = Math.min(n - 1, Math.max(0, Math.round(v * (n - 1))));
    const inlandM = distInfo.distWater[gj * n + gi];
    const bi = Math.min(m - 1, Math.max(0, Math.floor(u * m)));
    const bj = Math.min(m - 1, Math.max(0, Math.floor(v * m)));
    const bIdx = bj * m + bi;
    const nearSandyShore = beachData.drySandMask[bIdx] >= 24 || beachData.swashMask[bIdx] >= 16 || inlandM <= 75;

    if (h < 10.5 && nearSandyShore) {
      // Foreshore coconut palm fringe (Corner's model: 18-26m height, 2.75-4.25m plume radius)
      // along sandy beach berms & littoral coves
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
        // NMS-style Poisson-clustered littoral palm groves: seed 1 companion palm nearby on the beach berm
        if (h >= 2.5 && h <= 8.5 && shape > 0.38) {
          const satAngle = shape * 19.7;
          const satDist = 7.5 + ((shape * 31) % 7.5);
          const gx = x + Math.cos(satAngle) * satDist;
          const gz = z + Math.sin(satAngle) * satDist;
          const gh = terrainSample(heights, gx, gz, region);
          const gu = (gx - region.x) / region.span + 0.5;
          const gv = (gz - region.z) / region.span + 0.5;
          if (
            gh >= 2.45 &&
            gh <= 9.5 &&
            gu > 0.02 &&
            gu < 0.98 &&
            gv > 0.02 &&
            gv < 0.98 &&
            vegetationProbability(biomeMask, m, gu, gv) > 0 &&
            (!portPlacement ||
              (Math.hypot(gx - portPlacement.center.x, gz - portPlacement.center.z) >=
                portPlacement.clearRadius * 0.72 &&
                portClearanceEnvelope(portPlacement, gx, gz, 10)))
          ) {
            const gsx = (terrainSample(heights, gx + 12, gz, region) - terrainSample(heights, gx - 12, gz, region)) / 24;
            const gsz = (terrainSample(heights, gx, gz + 12, region) - terrainSample(heights, gx, gz - 12, region)) / 24;
            const gSlope = Math.hypot(gsx, gsz);
            if (gSlope <= 1.05) {
              const gr = Math.max(
                COCONUT_PALM_GENOME_SPEC.plumeRadiusRangeMetres[0],
                Math.min(COCONUT_PALM_GENOME_SPEC.plumeRadiusRangeMetres[1], r * 0.94)
              );
              const ght = Math.max(
                COCONUT_PALM_GENOME_SPEC.matureHeightRangeMetres[0],
                Math.min(COCONUT_PALM_GENOME_SPEC.matureHeightRangeMetres[1], ht * 0.92)
              );
              const gShape = (shape * 3.7 + 0.29) % 1;
              const gTuple = [gx, gh, gz, gr, ght, gShape, gsx, gsz];
              allTrees.push(...gTuple);
              palms.push(...gTuple);
              const gScale = ght / 22.0;
              const gSink = Math.max(0.12, COCONUT_PALM_GENOME_SPEC.basalRadiusMetres * gScale * gSlope + 0.08);
              palmRoots.push(
                gx,
                gh - gSink,
                gz,
                gScale,
                gShape * Math.PI * 2,
                tint,
                0.96 + 0.08 * hNorm,
                0.92 + 0.1 * tNorm,
                palmPrototypeId,
                gSink,
                -1,
                0
              );
            }
          }
        }
      } else {
        scrub.push(...tuple);
      }
    } else if (h < 28) {
      // Lowland coastal woodland & peninsula forest (includes inland plains at 2.4m..28m)
      const tuple = [x, h, z, baseRadius * 0.96, baseHeight * 0.94, shape, sx, sz];
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

export function buildCoastalMesh(regionSpec, heights, beaches = null, shoreDist = null) {
  const region = resolveGlobalCoastalRegion(regionSpec);
  const n = region.size;
  const m = region.biomeSize;
  const step = region.span / (n - 1);
  const distInfo = shoreDist ?? computeCoastalShoreDistances(heights, n, region.span, 0.25);
  const extraVerts = [];
  const baseVertices = new Float32Array(n * n * 8);
  const indices = [];
  const submergedIndices = [];

  const maxMeshBeachInland = Math.max(92, step * 2.2);
  const computeVertexAttribs = (x, z, h, dx, dz) => {
    const length = Math.hypot(dx, 1, dz) || 1;
    const slope = Math.hypot(dx, dz);
    const u = Math.max(0, Math.min(1, (x - region.x) / region.span + 0.5));
    const v = Math.max(0, Math.min(1, (z - region.z) / region.span + 0.5));
    const gi = Math.min(n - 1, Math.max(0, Math.round(u * (n - 1))));
    const gj = Math.min(n - 1, Math.max(0, Math.round(v * (n - 1))));
    const inlandM = distInfo.distWater[gj * n + gi];
    let sandWeight =
      coastalSmoothstep(-2.4, 0.2, h) *
      coastalSmoothstep(6.2, 1.4, h) *
      coastalSmoothstep(0.30, 0.08, slope) *
      coastalSmoothstep(maxMeshBeachInland, maxMeshBeachInland * 0.35, inlandM);
    if (beaches?.drySandMask && beaches?.swashMask) {
      const bi = Math.min(m - 1, Math.max(0, Math.floor(u * m)));
      const bj = Math.min(m - 1, Math.max(0, Math.floor(v * m)));
      const bIdx = bj * m + bi;
      const maskSand = Math.max(beaches.drySandMask[bIdx], beaches.swashMask[bIdx]) / 255;
      sandWeight = Math.max(sandWeight * 0.55, maskSand);
    }
    // Encode 0.02 + 0.98 * sandWeight in kind.y so the WGSL terrain shader recognizes
    // procedural coastal terrain (kind.y > 0.015) while keeping Saba (kind.y = 0) untouched.
    const encodedSand = Math.min(1, 0.02 + 0.98 * sandWeight);
    return [x, h, z, dx / length, 1 / length, dz / length, 0, encodedSand];
  };

  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      const k = j * n + i;
      const h = heights[k];
      const x = region.x + (i / (n - 1) - 0.5) * region.span;
      const z = region.z + (j / (n - 1) - 0.5) * region.span;
      const dx = (heights[j * n + Math.max(0, i - 1)] - heights[j * n + Math.min(n - 1, i + 1)]) / (2 * step);
      const dz = (heights[Math.max(0, j - 1) * n + i] - heights[Math.min(n - 1, j + 1) * n + i]) / (2 * step);
      baseVertices.set(computeVertexAttribs(x, z, h, dx, dz), k * 8);
    }
  }

  // Identify near-harbor shoreline cells (`hi > -6 && lo < 10` within central coastal zone) for crack-free subdivision
  const subRadius = region.span * (n >= 513 ? 0.14 : 0.22);
  const M = n >= 513 ? 2 : 3;
  const cellSub = new Uint8Array((n - 1) * (n - 1));
  for (let j = 0; j < n - 1; j++) {
    const zCell = region.z + ((j + 0.5) / (n - 1) - 0.5) * region.span;
    for (let i = 0; i < n - 1; i++) {
      const xCell = region.x + ((i + 0.5) / (n - 1) - 0.5) * region.span;
      if (Math.hypot(xCell - region.x, zCell - region.z) > subRadius) continue;
      const k = j * n + i;
      const h00 = heights[k], h10 = heights[k + 1], h01 = heights[k + n], h11 = heights[k + n + 1];
      const lo = Math.min(h00, h10, h01, h11);
      const hi = Math.max(h00, h10, h01, h11);
      if (hi > -6 && lo < 10) {
        cellSub[j * (n - 1) + i] = 1;
      }
    }
  }

  const subVertCache = new Map();
  const getSubVertex = (gi, gj, isCollinearEdge, hLinear) => {
    // Coincides with a base grid corner?
    if (gi % M === 0 && gj % M === 0) {
      return (gj / M) * n + gi / M;
    }
    const key = (gj * (n * M) + gi) * 2 + (isCollinearEdge ? 1 : 0);
    const cached = subVertCache.get(key);
    if (cached !== undefined) return cached;
    const u = gi / (M * (n - 1));
    const v = gj / (M * (n - 1));
    const x = region.x + (u - 0.5) * region.span;
    const z = region.z + (v - 0.5) * region.span;
    const h = isCollinearEdge ? hLinear : terrainSample(heights, x, z, region);
    const eps = step / M;
    const dx = (terrainSample(heights, x - eps, z, region) - terrainSample(heights, x + eps, z, region)) / (2 * eps);
    const dz = (terrainSample(heights, x, z - eps, region) - terrainSample(heights, x, z + eps, region)) / (2 * eps);
    const idx = n * n + extraVerts.length / 8;
    extraVerts.push(...computeVertexAttribs(x, z, h, dx, dz));
    subVertCache.set(key, idx);
    return idx;
  };

  for (let j = 0; j < n - 1; j++) {
    for (let i = 0; i < n - 1; i++) {
      const k = j * n + i;
      const h00 = heights[k], h10 = heights[k + 1], h01 = heights[k + n], h11 = heights[k + n + 1];
      const lo = Math.min(h00, h10, h01, h11);
      const hi = Math.max(h00, h10, h01, h11);
      if (!cellSub[j * (n - 1) + i]) {
        if (hi > -0.5) {
          indices.push(k, k + n, k + 1, k + 1, k + n, k + n + 1);
        }
        if (lo < 0 && hi > -45) {
          submergedIndices.push(k, k + n, k + 1, k + 1, k + n, k + n + 1);
        }
        continue;
      }
      // Subdivide coastal cell into M x M sub-quads; keep outer edges shared with unsubdivided
      // neighbors strictly collinear with the coarse edge so there are zero T-junction cracks.
      const topCoarse = j === 0 || !cellSub[(j - 1) * (n - 1) + i];
      const botCoarse = j === n - 2 || !cellSub[(j + 1) * (n - 1) + i];
      const leftCoarse = i === 0 || !cellSub[j * (n - 1) + (i - 1)];
      const rightCoarse = i === n - 2 || !cellSub[j * (n - 1) + (i + 1)];

      const gridIdx = (si, sj) => {
        const a = si / M;
        const b = sj / M;
        const onTop = sj === 0 && topCoarse;
        const onBot = sj === M && botCoarse;
        const onLeft = si === 0 && leftCoarse;
        const onRight = si === M && rightCoarse;
        const isCollinear = onTop || onBot || onLeft || onRight;
        const hLin =
          onTop ? h00 * (1 - a) + h10 * a :
          onBot ? h01 * (1 - a) + h11 * a :
          onLeft ? h00 * (1 - b) + h01 * b :
          onRight ? h10 * (1 - b) + h11 * b :
          (h00 * (1 - a) + h10 * a) * (1 - b) + (h01 * (1 - a) + h11 * a) * b;
        return getSubVertex(i * M + si, j * M + sj, isCollinear, hLin);
      };

      for (let sj = 0; sj < M; sj++) {
        for (let si = 0; si < M; si++) {
          const v00 = gridIdx(si, sj);
          const v10 = gridIdx(si + 1, sj);
          const v01 = gridIdx(si, sj + 1);
          const v11 = gridIdx(si + 1, sj + 1);
          if (hi > -0.5) {
            indices.push(v00, v01, v10, v10, v01, v11);
          }
          if (lo < 0 && hi > -45) {
            submergedIndices.push(v00, v01, v10, v10, v01, v11);
          }
        }
      }
    }
  }

  const vertices = new Float32Array(baseVertices.length + extraVerts.length);
  vertices.set(baseVertices, 0);
  if (extraVerts.length) vertices.set(extraVerts, baseVertices.length);

  return {
    vertices,
    indices: new Uint32Array(indices),
    submergedIndices: new Uint32Array(submergedIndices),
  };
}

export function createCoastalViews(regionSpec, heights, portPlacement = null) {
  const region = resolveGlobalCoastalRegion(regionSpec);
  const heading = region.shoreBearing ?? 112;
  const shoreAlong = portPlacement?.center?.shoreAlong ?? 0;
  const shoreInland = portPlacement?.center?.shoreInland ?? -350;
  const rawHorizon = worldFromCoastalFrame(region, shoreAlong - 300, shoreInland - 9500);
  const rawApproach = worldFromCoastalFrame(region, shoreAlong - 120, shoreInland - 2600);
  const rawCoast = worldFromCoastalFrame(region, shoreAlong, shoreInland - 780);
  const rawHarbor = worldFromCoastalFrame(region, shoreAlong, shoreInland - 260);

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

function finalizeProceduralCoastalPack(
  pack,
  heights,
  elevationSource = 'procedural-geomorphology',
  satelliteData = null,
  preserveRealCoast = false
) {
  const { region } = pack;
  const preShoreDist = computeCoastalShoreDistances(heights, region.size, region.span, 0.25);
  const port = placeCoastalPort(region, heights, { preserveRealCoast, satelliteData, shoreDist: preShoreDist });
  const shoreDist = computeCoastalShoreDistances(heights, region.size, region.span, 0.25);
  const beaches = synthesizeCoastalBeaches(region, heights, satelliteData, shoreDist);
  const mesh = buildCoastalMesh(region, heights, beaches, shoreDist);
  const biome = synthesizeCoastalBiome(region, heights, beaches, port, satelliteData);
  const albedo = synthesizeCoastalAlbedo(region, heights, beaches, port, biome, satelliteData, shoreDist);
  const vegetation = seedCoastalVegetation(region, heights, biome, beaches, port, 5, shoreDist);
  const portGeometry = buildPortPrefabGeometry(port, vegetation.palms);
  const views = createCoastalViews(region, heights, port);

  return Object.assign(pack, {
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
    elevationSource,
  });
}

export function generateProceduralCoastalPack(regionSpec = 'cartagena', overrides = {}) {
  const mergedSpec =
    overrides && Object.keys(overrides).length > 0
      ? typeof regionSpec === 'string'
        ? { ...(SPANISH_MAIN_1550_REGIONS[regionSpec] || {}), id: regionSpec, ...overrides }
        : { ...regionSpec, ...overrides }
      : regionSpec;
  const region = resolveGlobalCoastalRegion(mergedSpec);
  if (overrides?.deferSynthesis) {
    return { region, elevationSource: 'pending-dem' };
  }
  return finalizeProceduralCoastalPack({ region }, synthesizeCoastalTerrain(region));
}

function rasterizeTileGrid(loaded, tx0, ty0, w, h) {
  const pixels = new Uint8ClampedArray(w * h * 4);
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
    return pixels;
  }
  const canvas =
    typeof OffscreenCanvas === 'function'
      ? new OffscreenCanvas(w, h)
      : Object.assign(document.createElement('canvas'), { width: w, height: h });
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  for (const { tx, ty, bmp } of loaded) {
    if (!bmp) continue;
    ctx.drawImage(bmp, (tx - tx0) * 256, (ty - ty0) * 256);
    bmp.close();
  }
  pixels.set(ctx.getImageData(0, 0, w, h).data);
  return pixels;
}

// Fetch real high-resolution SRTM/NED/ETOPO1 elevation tiles from AWS Terrarium
// (zoom 13 + zoom 14 nearshore = ~9m-18m resolution) AND co-registered Esri World Imagery
// satellite orthophoto tiles (https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x})
// in parallel. Applies Saba's coastal bathymetry skirt model and spectral satellite
// auto-placement of 3D forests, coconut palms, and sandy beaches.
export async function upgradeProceduralPackWithRealDEM(
  pack,
  { fetchTile = null, fetchSatelliteTile = null, zoom = 13, timeoutMs = 1500 } = {}
) {
  const ensureFallback = (p) => (p?.heights ? p : p?.region ? finalizeProceduralCoastalPack(p, synthesizeCoastalTerrain(p.region)) : p);
  const effectiveFetch = fetchTile || (typeof fetch === 'function' && typeof createImageBitmap === 'function' ? fetch : null);
  if (!pack?.region || !effectiveFetch) return ensureFallback(pack);
  const { region } = pack;
  const n = region.size;
  const span = region.span;
  const cosLat = Math.max(0.1, Math.cos(region.latitude * COASTAL_DEG_TO_RAD));
  const halfLat = (span * 0.51) / 111195;
  const halfLon = (span * 0.51) / (111195 * cosLat);
  const numTiles = 2 ** zoom;
  const lonToTileX = (lon, nTiles = numTiles) => Math.floor(((lon + 180) / 360) * nTiles);
  const latToTileY = (lat, nTiles = numTiles) => {
    const r = Math.max(-85, Math.min(85, lat)) * COASTAL_DEG_TO_RAD;
    return Math.floor(((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * nTiles);
  };
  const tx0 = lonToTileX(region.longitude - halfLon);
  const tx1 = lonToTileX(region.longitude + halfLon);
  const ty0 = latToTileY(region.latitude + halfLat);
  const ty1 = latToTileY(region.latitude - halfLat);
  const cols = tx1 - tx0 + 1;
  const rows = ty1 - ty0 + 1;
  if (cols < 1 || cols > 6 || rows < 1 || rows > 6) return ensureFallback(pack);

  try {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const w = cols * 256;
    const h = rows * 256;
    const tilePromises = [];
    const satPromises = [];
    const wantSatellite = Boolean(fetchSatelliteTile || (!fetchTile && typeof fetch === 'function' && typeof createImageBitmap === 'function'));

    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const wrappedX = ((tx % numTiles) + numTiles) % numTiles;
        const demUrl = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${zoom}/${wrappedX}/${ty}.png`;
        tilePromises.push(
          Promise.resolve(
            fetchTile ? fetchTile(demUrl, { tx: wrappedX, ty, zoom, signal: controller.signal }) : fetch(demUrl, { signal: controller.signal, mode: 'cors' })
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
        if (wantSatellite) {
          const satUrl = `https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/${zoom}/${ty}/${wrappedX}`;
          satPromises.push(
            Promise.resolve(
              fetchSatelliteTile
                ? fetchSatelliteTile(satUrl, { tx: wrappedX, ty, zoom, signal: controller.signal })
                : fetch(satUrl, { signal: controller.signal, mode: 'cors' })
            )
              .then(async (res) => {
                if (res instanceof Uint8Array || res instanceof Uint8ClampedArray) {
                  return { tx, ty, rgba: res };
                }
                if (!res?.ok) return null;
                const bmp = await createImageBitmap(await res.blob(), {
                  premultiplyAlpha: 'none',
                  colorSpaceConversion: 'none',
                });
                return { tx, ty, bmp };
              })
              .catch(() => null)
          );
        }
      }
    }

    // Also fetch central 2x2 high-resolution zoom+1 (~9m/px) DEM tiles when using live fetch at zoom 13
    const nearZoom = zoom + 1;
    const nearNumTiles = 2 ** nearZoom;
    const ncx = lonToTileX(region.longitude, nearNumTiles);
    const ncy = latToTileY(region.latitude, nearNumTiles);
    const ntx0 = ncx - 1, ntx1 = ncx;
    const nty0 = ncy - 1, nty1 = ncy;
    const nearDemPromises = [];
    if (!fetchTile && zoom === 13 && typeof fetch === 'function' && typeof createImageBitmap === 'function') {
      for (let ty = nty0; ty <= nty1; ty++) {
        for (let tx = ntx0; tx <= ntx1; tx++) {
          const wrappedX = ((tx % nearNumTiles) + nearNumTiles) % nearNumTiles;
          const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${nearZoom}/${wrappedX}/${ty}.png`;
          nearDemPromises.push(
            fetch(url, { signal: controller.signal, mode: 'cors' })
              .then(async (res) => {
                if (!res?.ok) return null;
                const bmp = await createImageBitmap(await res.blob(), {
                  premultiplyAlpha: 'none',
                  colorSpaceConversion: 'none',
                });
                return { tx, ty, bmp };
              })
              .catch(() => null)
          );
        }
      }
    }

    const [loaded, satLoaded, nearDemLoaded] = await Promise.all([
      Promise.all(tilePromises),
      satPromises.length ? Promise.all(satPromises) : Promise.resolve([]),
      nearDemPromises.length ? Promise.all(nearDemPromises) : Promise.resolve([]),
      !fetchTile ? load1550BuildingLRMTemplates() : Promise.resolve(null),
    ]);
    clearTimeout(timer);

    const pixels = rasterizeTileGrid(loaded, tx0, ty0, w, h);
    let nearPixels = null;
    const nearW = 512, nearH = 512;
    if (nearDemLoaded.length === 4 && nearDemLoaded.every(Boolean)) {
      nearPixels = rasterizeTileGrid(nearDemLoaded, ntx0, nty0, nearW, nearH);
    } else {
      for (const item of nearDemLoaded) item?.bmp?.close?.();
    }

    const decodeGridPx = (buf, gw, gh, px, py) => {
      const ix = Math.max(0, Math.min(gw - 1, px));
      const iy = Math.max(0, Math.min(gh - 1, py));
      const k = (iy * gw + ix) * 4;
      return buf[k] * 256 + buf[k + 1] + buf[k + 2] / 256 - 32768;
    };
    const sampleTerrariumGrid = (buf, gw, gh, gx0, gy0, gTiles, lat, lon) => {
      const fx = ((lon + 180) / 360) * gTiles - gx0;
      const r = Math.max(-85, Math.min(85, lat)) * COASTAL_DEG_TO_RAD;
      const fy = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * gTiles - gy0;
      const px = fx * 256 - 0.5;
      const py = fy * 256 - 0.5;
      const x0 = Math.floor(px), y0 = Math.floor(py);
      const ax = px - x0, ay = py - y0;
      const h00 = decodeGridPx(buf, gw, gh, x0, y0), h10 = decodeGridPx(buf, gw, gh, x0 + 1, y0);
      const h01 = decodeGridPx(buf, gw, gh, x0, y0 + 1), h11 = decodeGridPx(buf, gw, gh, x0 + 1, y0 + 1);
      return (h00 * (1 - ax) + h10 * ax) * (1 - ay) + (h01 * (1 - ax) + h11 * ax) * ay;
    };
    const sampleTerrarium = (lat, lon) => {
      const baseH = sampleTerrariumGrid(pixels, w, h, tx0, ty0, numTiles, lat, lon);
      if (!nearPixels) return baseH;
      const fx = ((lon + 180) / 360) * nearNumTiles - ntx0;
      const r = Math.max(-85, Math.min(85, lat)) * COASTAL_DEG_TO_RAD;
      const fy = ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * nearNumTiles - nty0;
      if (fx <= 0.05 || fx >= 1.95 || fy <= 0.05 || fy >= 1.95) return baseH;
      const nearHVal = sampleTerrariumGrid(nearPixels, nearW, nearH, ntx0, nty0, nearNumTiles, lat, lon);
      const edge = Math.min(fx, 2 - fx, fy, 2 - fy);
      const blend = coastalSmoothstep(0.05, 0.25, edge);
      return baseH * (1 - blend) + nearHVal * blend;
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
        if (elev > 0.25) landCount++;
        if (elev > maxDem) maxDem = elev;
      }
    }
    const landRatio = landCount / (n * n);
    // Require both real land and real water in the 8.2km coastal window
    if (landRatio < 0.015 || landRatio > 0.95 || maxDem < 2.5) {
      for (const item of satLoaded) item?.bmp?.close?.();
      return ensureFallback(pack);
    }

    // Co-register satellite imagery from Web Mercator tiles to the local equirectangular grid
    let satelliteData = null;
    if (satLoaded.length === loaded.length && satLoaded.every(Boolean)) {
      const satGridPixels = rasterizeTileGrid(satLoaded, tx0, ty0, w, h);
      const satSize = region.albedoSize;
      const regRgba = new Uint8ClampedArray(satSize * satSize * 4);
      for (let j = 0; j < satSize; j++) {
        const z = region.z + ((j + 0.5) / satSize - 0.5) * span;
        const lat = region.latitude - (z - region.z) / 111195;
        const rLat = Math.max(-85, Math.min(85, lat)) * COASTAL_DEG_TO_RAD;
        const fy = ((1 - Math.log(Math.tan(rLat) + 1 / Math.cos(rLat)) / Math.PI) / 2) * numTiles - ty0;
        const py = Math.max(0, Math.min(h - 1, fy * 256 - 0.5));
        const y0 = Math.floor(py), y1 = Math.min(h - 1, y0 + 1), ay = py - y0;
        for (let i = 0; i < satSize; i++) {
          const x = region.x + ((i + 0.5) / satSize - 0.5) * span;
          const lon = region.longitude + (x - region.x) / (111195 * cosLat);
          const fx = ((lon + 180) / 360) * numTiles - tx0;
          const px = Math.max(0, Math.min(w - 1, fx * 256 - 0.5));
          const x0 = Math.floor(px), x1 = Math.min(w - 1, x0 + 1), ax = px - x0;
          const k00 = (y0 * w + x0) * 4, k10 = (y0 * w + x1) * 4;
          const k01 = (y1 * w + x0) * 4, k11 = (y1 * w + x1) * 4;
          const dst = (j * satSize + i) * 4;
          for (let c = 0; c < 3; c++) {
            const v0 = satGridPixels[k00 + c] * (1 - ax) + satGridPixels[k10 + c] * ax;
            const v1 = satGridPixels[k01 + c] * (1 - ax) + satGridPixels[k11 + c] * ax;
            regRgba[dst + c] = Math.round(v0 * (1 - ay) + v1 * ay);
          }
          regRgba[dst + 3] = 255;
        }
      }
      // Compute 16x-downsampled local luminance field for Saba-style shadow de-lighting
      const lowSize = Math.max(8, satSize >> 4);
      const block = Math.max(1, Math.floor(satSize / lowSize));
      const lowLuma = new Float32Array(lowSize * lowSize);
      for (let lj = 0; lj < lowSize; lj++) {
        for (let li = 0; li < lowSize; li++) {
          let sum = 0, count = 0;
          for (let dy = 0; dy < block; dy++) {
            const sy = Math.min(satSize - 1, lj * block + dy);
            for (let dx = 0; dx < block; dx++) {
              const sx = Math.min(satSize - 1, li * block + dx);
              const k = (sy * satSize + sx) * 4;
              sum += 0.2126 * regRgba[k] + 0.7152 * regRgba[k + 1] + 0.0722 * regRgba[k + 2];
              count++;
            }
          }
          lowLuma[lj * lowSize + li] = sum / Math.max(1, count);
        }
      }
      satelliteData = { rgba: regRgba, size: satSize, lowLuma, lowSize };
    } else {
      for (const item of satLoaded) item?.bmp?.close?.();
    }

    // Apply Saba's exact coastal bathymetry model (scripts/prepare-land-imagery.py:76-83):
    // Measured land elevations > 0.25m are retained verbatim; wet cells use the shore-distance skirt
    // depth = min(120, 2 + 0.15 * shoreDistanceMetres) so real coastlines, headlands, and bays are preserved 1:1.
    const { distLand, step } = computeCoastalShoreDistances(rawDem, n, span, 0.25);
    const heights = new Float32Array(n * n);
    for (let k = 0; k < n * n; k++) {
      const demH = rawDem[k];
      if (demH > 0.25) {
        heights[k] = Math.min(895, demH);
      } else {
        const shoreDistance = Math.max(0, distLand[k] - step * 0.5);
        const authoredDepth = Math.min(120, 2 + 0.15 * shoreDistance);
        heights[k] = Math.max(-120, demH < -2 ? Math.min(demH, -authoredDepth) : -authoredDepth);
      }
    }

    finalizeProceduralCoastalPack(
      pack,
      heights,
      `aws-terrarium-srtm-z${nearPixels ? nearZoom : zoom}`,
      satelliteData,
      true
    );
    pack.satelliteData = satelliteData;
    pack.rawDem = rawDem;
    pack.demSource = {
      provider: 'aws-terrarium-srtm-etopo1',
      zoom,
      nearshoreZoom: nearZoom,
      effectiveZoom: nearPixels ? nearZoom : zoom,
      satelliteOverlay: Boolean(satelliteData),
      tiles: loaded.length + (nearPixels ? nearDemLoaded.length : 0),
    };
    pack.imagerySource = satelliteData
      ? {
          provider: 'esri-world-imagery',
          zoom,
          textureSize: satelliteData.size,
          tiles: satLoaded.length,
        }
      : null;
    return pack;
  } catch {
    return ensureFallback(pack);
  }
}

export function canonicalCoastalCellId(regionSpec) {
  const region = resolveGlobalCoastalRegion(regionSpec);
  const gridLat = Math.round(region.latitude / 0.04) * 0.04;
  const gridLon = Math.round(region.longitude / 0.04) * 0.04;
  const latStr = gridLat.toFixed(2);
  const lonStr = gridLon.toFixed(2);
  const cellId = `cell_${latStr}_${lonStr}`;
  const ns = region.latitude >= 0 ? 'N' : 'S';
  const ew = region.longitude >= 0 ? 'E' : 'W';
  const coordLabel = `${Math.abs(region.latitude).toFixed(3)}°${ns}, ${Math.abs(region.longitude).toFixed(3)}°${ew}`;
  return {
    cellId,
    gridLat: Number(latStr),
    gridLon: Number(lonStr),
    regionId: region.id,
    name: region.name || 'Uncharted Coast',
    coordLabel,
  };
}

export function build1550HistoricalTerritoryPack(basePack, options = {}) {
  const region = resolveGlobalCoastalRegion(basePack.region);
  const n = region.size;
  const span = region.span;
  const seed = region.seed || region.vegetationSeed || coastalHashCoords(region.latitude, region.longitude);
  const baseHeights = basePack.heights || options.precomputedHeights1550;
  const satSource = options.orthophoto1550 || basePack.satelliteData || null;
  const hasDedicated1550Ortho = Boolean(options.orthophoto1550);
  const baseShoreDist = computeCoastalShoreDistances(baseHeights, n, span, 0.25);
  const { distWater, step } = baseShoreDist;

  let heights1550 = options.precomputedHeights1550 || null;
  let lowCoastalCells = 0;
  let reclaimedCellsCarved = 0;

  if (!heights1550) {
    // Step 1: Hybrid 1550 Geomorphic Reconstruction
    // - Lock natural hills & headlands (h > 7.5m, e.g. El Morro bluff) and add canopy/bluff micro-relief.
    // - Carve 20th-century low-lying coastal landfill (modern piers, container yards, airport runways at 0.15m..6.2m)
    //   back into 1550s winding tidal mangrove estuaries, lagoons, and shoals.
    const carvedDem = new Float32Array(n * n);

    for (let j = 0; j < n; j++) {
      const v = j / (n - 1);
      const z = region.z + (v - 0.5) * span;
      for (let i = 0; i < n; i++) {
        const u = i / (n - 1);
        const x = region.x + (u - 0.5) * span;
        const k = j * n + i;
        const h = baseHeights[k];
        const inlandM = distWater[k];
        const sat = sampleSatelliteEquirectangular(satSource, u, v);

        // Protect the immediate 1550 colonial bastion & careening wharf core so historical structures stay grounded
        const portClear = basePack.port ? portClearanceEnvelope(x, z, basePack.port) : 0;
        const inBastionCore = portClear > 0.45;

        if (h > 0.25) {
          // High-frequency canopy & headland ridge micro-relief (Depth-Anything V2 high-pass detail proxy)
          const ridgeDetail =
            (coastalUberNoise2D(x * 0.0055, z * 0.0055, seed + 701, 3, 0.38) - 0.48) * 3.2 +
            (sat ? (sat.greenness - 0.22) * 2.1 : 0);

          if (h <= 6.2 && inlandM <= 340 && !inBastionCore) {
            lowCoastalCells++;
            // Shadow-proof 1550 water check: requires blue/turquoise excess so dark building/wall shadows on land are never carved into water
            const is1550Water =
              hasDedicated1550Ortho &&
              sat &&
              ((sat.b - sat.r >= 7 && sat.b >= sat.g * 0.78 && sat.greenness < 0.08 && sat.luma < 176 && sat.luma >= 26) ||
                (sat.g - sat.r >= 8 && sat.b - sat.r >= 1 && sat.b > 75 && sat.luma < 172 && sat.luma >= 28));
            const creekNoise = coastalUberNoise2D(
              x * 0.0038 + 0.7 * coastalFbm2D(x * 0.0016, z * 0.0016, seed + 719, 2),
              z * 0.0038 + 0.7 * coastalFbm2D(z * 0.0016 + 9.4, x * 0.0016, seed + 727, 2),
              seed + 733,
              3,
              0.25
            );
            const isModernFillCarve =
              !hasDedicated1550Ortho &&
              ((sat && sat.isUrban && h <= 5.2 && inlandM <= 260) ||
                (h <= 3.4 && inlandM <= 180 && creekNoise < 0.34));

            if (is1550Water || isModernFillCarve) {
              reclaimedCellsCarved++;
              // Carve into 1550 winding tidal mangrove channel (-2.2m..-0.6m) with occasional mangrove islets (+0.7m)
              const channelVal = creekNoise;
              if (channelVal > 0.68 && !is1550Water) {
                carvedDem[k] = 0.65 + (channelVal - 0.68) * 3.2;
              } else {
                carvedDem[k] = -0.65 - (1 - channelVal) * 1.85;
              }
              continue;
            }
          }
          // Natural 1550 headland/inland relief with sharpened bluffs and old-growth canopy domes
          const reliefBoost = h > 7.5 ? ridgeDetail * 0.85 : Math.max(-0.4, ridgeDetail * 0.45);
          carvedDem[k] = Math.max(0.45, Math.min(895, h + reliefBoost));
        } else {
          // If 1550 orthophoto shows land/forest/settlement here, elevate above sea level
          const is1550Land =
            hasDedicated1550Ortho &&
            sat &&
            !((sat.b - sat.r >= 7 && sat.b >= sat.g * 0.78 && sat.greenness < 0.08 && sat.luma < 176) ||
              (sat.g - sat.r >= 8 && sat.b - sat.r >= 1 && sat.b > 75 && sat.luma < 172));
          carvedDem[k] = is1550Land ? 2.4 + sat.greenness * 1.8 : h;
        }
      }
    }

    // Step 2: Recompute 1550 coastal bathymetry skirt + turquoise coral-reef shoal benches
    const shoreDist1550 = computeCoastalShoreDistances(carvedDem, n, span, 0.25);
    heights1550 = new Float32Array(n * n);
    for (let j = 0; j < n; j++) {
      const v = j / (n - 1);
      const z = region.z + (v - 0.5) * span;
      for (let i = 0; i < n; i++) {
        const u = i / (n - 1);
        const x = region.x + (u - 0.5) * span;
        const k = j * n + i;
        const demH = carvedDem[k];
        if (demH > 0.25) {
          heights1550[k] = demH;
        } else {
          const sat = sampleSatelliteEquirectangular(satSource, u, v);
          // Optical reef turquoise factor slows nearshore drop-off over coral flats
          const turquoise = sat
            ? Math.max(0, Math.min(1, ((sat.g * 0.65 + sat.b * 0.35) / 255 - 0.16) / 0.38))
            : 0.3;
          const reefBench = 0.68 + 0.32 * (1 - turquoise * 0.55);
          const shoreDistance = Math.max(0, shoreDist1550.distLand[k] - step * 0.5);
          const authoredDepth = Math.min(120, 1.8 + 0.145 * shoreDistance * reefBench);
          heights1550[k] = Math.max(-120, demH < -2.5 ? Math.min(demH, -authoredDepth) : -authoredDepth);
        }
      }
    }
  }
  const shoreDist1550 = computeCoastalShoreDistances(heights1550, n, span, 0.25);

  // Step 3: Build 100% De-Urbanized 1550 Orthophoto Imagery Seed
  const precomputedFootprints = options.precomputedFootprints || satSource?.precomputedFootprints || null;
  let sat1550 = satSource
    ? { ...satSource, is1550Orthophoto: hasDedicated1550Ortho, precomputedFootprints }
    : precomputedFootprints
      ? { is1550Orthophoto: true, precomputedFootprints }
      : null;
  if (satSource && !hasDedicated1550Ortho) {
    const sz = satSource.size;
    const rgba1550 = new Uint8ClampedArray(satSource.rgba.length);
    for (let j = 0; j < sz; j++) {
      const v = (j + 0.5) / sz;
      const z = region.z + (v - 0.5) * span;
      const gj = Math.min(n - 1, Math.max(0, Math.round(v * (n - 1))));
      for (let i = 0; i < sz; i++) {
        const u = (i + 0.5) / sz;
        const x = region.x + (u - 0.5) * span;
        const gi = Math.min(n - 1, Math.max(0, Math.round(u * (n - 1))));
        const kGrid = gj * n + gi;
        const h = heights1550[kGrid];
        const inlandM = shoreDist1550.distWater[kGrid];
        const idx = (j * sz + i) * 4;
        const r = satSource.rgba[idx], g = satSource.rgba[idx + 1], b = satSource.rgba[idx + 2];
        const mottle = coastalFbm2D(x * 0.009, z * 0.009, seed + 751, 3) - 0.5;
        if (h <= 0.25) {
          // 1550 turquoise estuary & coral shoal water
          const shoal = Math.max(0, Math.min(1, 1 - Math.abs(h) / 14));
          rgba1550[idx] = Math.round(16 + shoal * 26);
          rgba1550[idx + 1] = Math.round(48 + shoal * 78 + mottle * 10);
          rgba1550[idx + 2] = Math.round(68 + shoal * 74 + mottle * 10);
          rgba1550[idx + 3] = 255;
        } else if (h <= 3.8 && inlandM <= 75) {
          // Warm 1550 coral-sand beach berm
          rgba1550[idx] = Math.min(255, Math.round(224 + mottle * 18));
          rgba1550[idx + 1] = Math.min(255, Math.round(198 + mottle * 16));
          rgba1550[idx + 2] = Math.min(255, Math.round(150 + mottle * 14));
          rgba1550[idx + 3] = 255;
        } else {
          // Convert any urban/road/cleared pixels into lush 1550 primary tropical rainforest or mangrove
          const isMangrove = h < 3.2 && inlandM < 190;
          const baseR = isMangrove ? 36 : 42;
          const baseG = isMangrove ? 78 : 88;
          const baseB = isMangrove ? 38 : 42;
          const keepNat = g > r * 1.06 && g > b * 1.10 ? 0.45 : 0.0;
          rgba1550[idx] = Math.max(18, Math.min(140, Math.round(baseR * (1 - keepNat) + r * keepNat + mottle * 16)));
          rgba1550[idx + 1] = Math.max(38, Math.min(175, Math.round(baseG * (1 - keepNat) + g * keepNat + mottle * 22)));
          rgba1550[idx + 2] = Math.max(18, Math.min(125, Math.round(baseB * (1 - keepNat) + b * keepNat + mottle * 12)));
          rgba1550[idx + 3] = 255;
        }
      }
    }
    sat1550 = {
      rgba: rgba1550,
      size: sz,
      lowLuma: satSource.lowLuma,
      lowSize: satSource.lowSize,
      precomputedFootprints,
    };
  }

  const upgradedPack = {
    ...basePack,
    region,
    satelliteData: sat1550,
  };
  finalizeProceduralCoastalPack(
    upgradedPack,
    heights1550,
    hasDedicated1550Ortho ? 'ai-1550-orthophoto-srtm-hybrid' : 'hybrid-1550-estuary-srtm',
    sat1550,
    true
  );

  const cellInfo = canonicalCoastalCellId(region);
  const restoredEstuaryPct =
    lowCoastalCells > 0
      ? Math.max(4.5, Math.min(48.0, Number(((reclaimedCellsCarved / lowCoastalCells) * 100).toFixed(1))))
      : 12.4;
  upgradedPack.territory1550 = {
    cellId: cellInfo.cellId,
    name: cellInfo.name,
    coordLabel: cellInfo.coordLabel,
    restoredEstuaryPct,
    reclaimedCellsCarved,
    palmCount: upgradedPack.vegetation?.stats?.palmCount ?? 0,
    beachCellCount: upgradedPack.beaches?.beachCellCount ?? 0,
    hasOrthophoto1550: hasDedicated1550Ortho,
    discoveredAt: options.discoveredAt || new Date().toISOString(),
  };
  return upgradedPack;
}

export function encode1550TerritoryCachePayload(upgradedPack) {
  const heights = upgradedPack.heights;
  const n = upgradedPack.region.size;
  const metaJson = JSON.stringify(upgradedPack.territory1550 || {});
  const metaBytes = new TextEncoder().encode(metaJson);
  const headerBytes = 16;
  const heightsBytes = n * n * 2;
  const totalBytes = headerBytes + heightsBytes + metaBytes.byteLength;
  const buf = new ArrayBuffer(totalBytes);
  const view = new DataView(buf);
  // Magic 'WW15' (0x57573135)
  view.setUint32(0, 0x57573135, false);
  view.setUint16(4, 1, true); // version 1
  view.setUint16(6, n, true); // grid size
  view.setUint32(8, metaBytes.byteLength, true);
  view.setUint32(12, Math.round((upgradedPack.territory1550?.restoredEstuaryPct || 0) * 10), true);
  const qHeights = new Int16Array(buf, headerBytes, n * n);
  for (let i = 0; i < n * n; i++) {
    // Encode elevation in decimetres (0.1m resolution, range -3276.8m..+3276.7m)
    qHeights[i] = Math.max(-32767, Math.min(32767, Math.round(heights[i] * 10)));
  }
  new Uint8Array(buf, headerBytes + heightsBytes).set(metaBytes);
  return new Uint8Array(buf);
}

export function apply1550TerritoryCachePayload(basePack, payloadBytes, orthophoto1550 = null) {
  const bytes = payloadBytes instanceof Uint8Array ? payloadBytes : new Uint8Array(payloadBytes);
  if (bytes.byteLength < 16) return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  if (view.getUint32(0, false) !== 0x57573135) return null;
  const n = view.getUint16(6, true);
  const metaLen = view.getUint32(8, true);
  const heightsBytes = n * n * 2;
  if (bytes.byteLength < 16 + heightsBytes + metaLen) return null;
  const qHeights = new Int16Array(bytes.buffer, bytes.byteOffset + 16, n * n);
  const decodedHeights = new Float32Array(n * n);
  for (let i = 0; i < n * n; i++) {
    decodedHeights[i] = qHeights[i] * 0.1;
  }
  let meta = {};
  try {
    meta = JSON.parse(new TextDecoder().decode(bytes.subarray(16 + heightsBytes, 16 + heightsBytes + metaLen)));
  } catch { /* ignore malformed meta */ }

  const region = resolveGlobalCoastalRegion(basePack.region);
  let heights1550 = decodedHeights;
  if (n !== region.size) {
    // Bilinear resample if cached grid size differs (e.g. PC 513 vs Mobile 257)
    heights1550 = new Float32Array(region.size * region.size);
    for (let j = 0; j < region.size; j++) {
      const fy = (j / (region.size - 1)) * (n - 1);
      const y0 = Math.floor(fy), y1 = Math.min(n - 1, y0 + 1), ay = fy - y0;
      for (let i = 0; i < region.size; i++) {
        const fx = (i / (region.size - 1)) * (n - 1);
        const x0 = Math.floor(fx), x1 = Math.min(n - 1, x0 + 1), ax = fx - x0;
        const v0 = decodedHeights[y0 * n + x0] * (1 - ax) + decodedHeights[y0 * n + x1] * ax;
        const v1 = decodedHeights[y1 * n + x0] * (1 - ax) + decodedHeights[y1 * n + x1] * ax;
        heights1550[j * region.size + i] = v0 * (1 - ay) + v1 * ay;
      }
    }
  }
  const precomputedFootprints =
    Array.isArray(meta.footprints) && meta.footprints.length >= 4
      ? { clusterU: meta.clusterU, clusterV: meta.clusterV, footprints: meta.footprints }
      : null;
  const built = build1550HistoricalTerritoryPack(basePack, {
    orthophoto1550,
    discoveredAt: meta.discoveredAt,
    precomputedHeights1550: heights1550,
    precomputedFootprints,
  });
  built.territory1550 = { ...built.territory1550, ...meta };
  return built;
}

export async function runLandfallDiscoveryPipeline(basePack, {
  apiBase = '/waterworld/api',
  onFirstExplorer = null,
  onProgress = null,
  onUpgradeReady = null,
  onCachedReady = null,
  fetchImpl = typeof fetch === 'function' ? fetch : null,
  forceFirstExplorer = false,
} = {}) {
  const cellInfo = canonicalCoastalCellId(basePack.region);
  await load1550BuildingLRMTemplates(fetchImpl);
  const localKey = `waterworld.discovery.v1.${cellInfo.cellId}`;
  let status = 'first_explorer';
  let visits = 1;
  let discoveredAt = new Date().toISOString();
  let hasOrthophoto = false;
  let remoteAvailable = false;

  if (!forceFirstExplorer && fetchImpl) {
    try {
      const q = new URLSearchParams({
        cell: cellInfo.cellId,
        lat: String(basePack.region.latitude),
        lon: String(basePack.region.longitude),
        name: cellInfo.name,
      });
      const res = await fetchImpl(`${apiBase}/landfall-discovery?${q.toString()}`);
      if (res && res.ok) {
        const info = await res.json();
        remoteAvailable = true;
        status = info.status || 'first_explorer';
        visits = Number(info.visits) || 1;
        discoveredAt = info.discoveredAt || discoveredAt;
        hasOrthophoto = Boolean(info.hasOrthophoto);
      }
    } catch { /* fallback to localStorage when offline */ }
  }

  if (!remoteAvailable && !forceFirstExplorer && typeof localStorage !== 'undefined') {
    try {
      const raw = localStorage.getItem(localKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        status = 'cached';
        visits = (Number(parsed.visits) || 1) + 1;
        discoveredAt = parsed.discoveredAt || discoveredAt;
        localStorage.setItem(localKey, JSON.stringify({ ...parsed, visits }));
      }
    } catch { /* ignore storage errors */ }
  }

  // Helper to optionally load a 1550 AI orthophoto if available on the Worker
  const loadOrthophoto1550 = async () => {
    if (!hasOrthophoto || !fetchImpl || typeof createImageBitmap !== 'function') return null;
    try {
      const res = await fetchImpl(`${apiBase}/landfall-orthophoto?cell=${encodeURIComponent(cellInfo.cellId)}`);
      if (!res.ok) return null;
      const bmp = await createImageBitmap(await res.blob());
      const sz = basePack.region.albedoSize;
      const canvas = typeof OffscreenCanvas === 'function'
        ? new OffscreenCanvas(sz, sz)
        : Object.assign(document.createElement('canvas'), { width: sz, height: sz });
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0, sz, sz);
      bmp.close?.();
      const rgba = ctx.getImageData(0, 0, sz, sz).data;
      const lowSize = Math.max(8, sz >> 4);
      const block = Math.max(1, Math.floor(sz / lowSize));
      const lowLuma = new Float32Array(lowSize * lowSize);
      for (let lj = 0; lj < lowSize; lj++) {
        for (let li = 0; li < lowSize; li++) {
          let sum = 0, count = 0;
          for (let dy = 0; dy < block; dy++) {
            const sy = Math.min(sz - 1, lj * block + dy);
            for (let dx = 0; dx < block; dx++) {
              const sx = Math.min(sz - 1, li * block + dx);
              const k = (sy * sz + sx) * 4;
              sum += 0.2126 * rgba[k] + 0.7152 * rgba[k + 1] + 0.0722 * rgba[k + 2];
              count++;
            }
          }
          lowLuma[lj * lowSize + li] = sum / Math.max(1, count);
        }
      }
      return { rgba, size: sz, lowLuma, lowSize, is1550Orthophoto: true };
    } catch {
      return null;
    }
  };

  if (status === 'cached' && !forceFirstExplorer) {
    let upgradedPack = null;
    const orthophoto1550 = await loadOrthophoto1550();
    if (remoteAvailable && fetchImpl) {
      try {
        const res = await fetchImpl(`${apiBase}/landfall-pack?cell=${encodeURIComponent(cellInfo.cellId)}`);
        if (res && res.ok) {
          const buf = new Uint8Array(await res.arrayBuffer());
          upgradedPack = apply1550TerritoryCachePayload(basePack, buf, orthophoto1550);
        }
      } catch { /* fallback to local rebuild */ }
    }
    if (!upgradedPack) {
      upgradedPack = build1550HistoricalTerritoryPack(basePack, { orthophoto1550, discoveredAt });
    }
    upgradedPack.territory1550.visits = visits;
    upgradedPack.territory1550.isFirstExplorer = false;
    onCachedReady?.({
      cellId: cellInfo.cellId,
      name: cellInfo.name,
      coordLabel: cellInfo.coordLabel,
      visits,
      discoveredAt,
      upgradedPack,
      stats: upgradedPack.territory1550,
    });
    return { status: 'cached', isFirstExplorer: false, visits, upgradedPack };
  }

  // First Explorer path! Notify the player immediately that they are the first mariner here
  onFirstExplorer?.({
    cellId: cellInfo.cellId,
    name: cellInfo.name,
    coordLabel: cellInfo.coordLabel,
    discoveredAt,
  });

  // Yield briefly so the First Explorer banner renders smoothly while the ship sails at 60 FPS
  await new Promise((resolve) => setTimeout(resolve, 650));
  onProgress?.({
    stage: 'orthophoto',
    message: `Analyzing satellite coast & 1550 mangrove channels for ${cellInfo.name}…`,
  });

  const orthophoto1550 = await loadOrthophoto1550();
  await new Promise((resolve) => setTimeout(resolve, 550));
  onProgress?.({
    stage: 'carving',
    message: 'Removing modern coastal fill & reconstructing 1550 relief, beaches and primary canopy…',
  });

  await new Promise((resolve) => setTimeout(resolve, 450));
  const upgradedPack = build1550HistoricalTerritoryPack(basePack, { orthophoto1550, discoveredAt });
  upgradedPack.territory1550.visits = 1;
  upgradedPack.territory1550.isFirstExplorer = true;

  // Cache the newly built 1550 territory in Cloudflare R2 (and localStorage) for all future mariners
  const payload = encode1550TerritoryCachePayload(upgradedPack);
  if (remoteAvailable && fetchImpl) {
    try {
      await fetchImpl(
        `${apiBase}/landfall-pack?cell=${encodeURIComponent(cellInfo.cellId)}&lat=${encodeURIComponent(basePack.region.latitude)}&lon=${encodeURIComponent(basePack.region.longitude)}&name=${encodeURIComponent(cellInfo.name)}`,
        {
          method: 'PUT',
          headers: { 'Content-Type': 'application/octet-stream' },
          body: payload,
        }
      );
    } catch { /* non-fatal if offline */ }
  }
  if (typeof localStorage !== 'undefined') {
    try {
      localStorage.setItem(
        localKey,
        JSON.stringify({
          cellId: cellInfo.cellId,
          name: cellInfo.name,
          lat: basePack.region.latitude,
          lon: basePack.region.longitude,
          visits: 1,
          discoveredAt,
          restoredEstuaryPct: upgradedPack.territory1550.restoredEstuaryPct,
        })
      );
    } catch { /* ignore quota errors */ }
  }

  onUpgradeReady?.({
    cellId: cellInfo.cellId,
    name: cellInfo.name,
    coordLabel: cellInfo.coordLabel,
    visits: 1,
    discoveredAt,
    upgradedPack,
    stats: upgradedPack.territory1550,
    isFirstExplorer: true,
  });

  return { status: 'first_explorer', isFirstExplorer: true, visits: 1, upgradedPack };
}

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
import {
  BUILDING_SUB_ASSEMBLIES,
  PART_CUTAWAY_MODES,
  createPartAssemblyCatalog,
  createPartAssemblyState,
  locatePartAtLocalPoint,
} from './part-assembly.js';

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
  single_nave_solar: Object.freeze({
    id: 'single_nave_solar',
    label: 'Casa de Una Nave / Barracón (Single-Span Hall)',
    length: 22,
    width: 9.5,
    height: 7.2,
    foundationDepth: 3.5,
    materialKind: 12,
    roofPitch: 2.0,
    waterfront: false,
  }),
  l_wing_u_wing_solar: Object.freeze({
    id: 'l_wing_u_wing_solar',
    label: 'Casa Solariega en L / U con Corral (Corner Courtyard House)',
    length: 24,
    width: 17,
    height: 7.4,
    foundationDepth: 3.5,
    materialKind: 12,
    roofPitch: 2.1,
    waterfront: false,
  }),
  modular_patio_cloister: Object.freeze({
    id: 'modular_patio_cloister',
    label: 'Casa de Patio / Convento Claustral (Arcaded Courtyard Cloister)',
    length: 30,
    width: 26,
    height: 8.2,
    foundationDepth: 4.0,
    materialKind: 12,
    roofPitch: 2.3,
    waterfront: false,
  }),
  royal_atarazanas_arsenal: Object.freeze({
    id: 'royal_atarazanas_arsenal',
    label: 'Reales Atarazanas / Almacenes de Naves Paralelas (Multi-Gable Arsenal)',
    length: 36,
    width: 26,
    height: 8.2,
    foundationDepth: 4.5,
    materialKind: 11,
    roofPitch: 2.5,
    waterfront: true,
  }),
  open_lonja_loggia: Object.freeze({
    id: 'open_lonja_loggia',
    label: 'Lonja de Mercaderes / Feria Porticada (Open Market Loggia)',
    length: 26,
    width: 13.5,
    height: 7.4,
    foundationDepth: 3.5,
    materialKind: 11,
    roofPitch: 2.3,
    waterfront: true,
  }),
  walled_mule_corral: Object.freeze({
    id: 'walled_mule_corral',
    label: 'Corral del Rey / Caballerizas Reales (Walled Stable Compound)',
    length: 34,
    width: 30,
    height: 5.8,
    foundationDepth: 3.0,
    materialKind: 12,
    roofPitch: 1.9,
    waterfront: false,
  }),
  bastion_trace_fortress: Object.freeze({
    id: 'bastion_trace_fortress',
    label: 'Fuerte Abaluartado con Foso y Polvorín (Bastioned Star Fort)',
    length: 42,
    width: 38,
    height: 9.8,
    foundationDepth: 6.5,
    materialKind: 11,
    roofPitch: 0,
    waterfront: true,
  }),
  torreon_atalaya_farol: Object.freeze({
    id: 'torreon_atalaya_farol',
    label: 'Torre del Homenaje / Torreón y Atalaya (Watchtower & Beacon)',
    length: 13,
    width: 13,
    height: 15.5,
    foundationDepth: 5.5,
    materialKind: 11,
    roofPitch: 0,
    waterfront: true,
  }),
  curtain_wall_and_gate: Object.freeze({
    id: 'curtain_wall_and_gate',
    label: 'Muralla Real y Puerta de la Ciudad (Curtain Wall & Gatehouse)',
    length: 34,
    width: 6.2,
    height: 6.6,
    foundationDepth: 4.5,
    materialKind: 11,
    roofPitch: 0,
    waterfront: false,
  }),
  stone_arch_bridge: Object.freeze({
    id: 'stone_arch_bridge',
    label: 'Puente de Piedra con Tajamares (Multi-Arch Cutwater Bridge)',
    length: 32,
    width: 7.2,
    height: 4.6,
    foundationDepth: 6.5,
    materialKind: 11,
    roofPitch: 0,
    waterfront: true,
  }),
  thatched_bohio_palafito: Object.freeze({
    id: 'thatched_bohio_palafito',
    label: 'Bohío / Caney de Palma y Palafito (Palm-Thatch House & Stilt Hut)',
    length: 14,
    width: 8.5,
    height: 4.8,
    foundationDepth: 4.5,
    materialKind: 15,
    roofPitch: 3.0,
    waterfront: false,
  }),
  astillero_and_moored_hull: Object.freeze({
    id: 'astillero_and_moored_hull',
    label: 'Astillero con Carabela en Grada / Barco de Puerto (Slipway & Hull)',
    length: 23,
    width: 8.2,
    height: 5.2,
    foundationDepth: 3.5,
    materialKind: 10,
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

const CLIMATE_MONTH_KEYS = Object.freeze([
  'JAN', 'FEB', 'MAR', 'APR', 'MAY', 'JUN',
  'JUL', 'AUG', 'SEP', 'OCT', 'NOV', 'DEC',
]);
const CLIMATE_PROFILE_CACHE = new Map();

function normalizeSpeciesWeights(weights) {
  let sum = 0;
  for (const v of Object.values(weights)) {
    if (Number.isFinite(v) && v > 0) sum += v;
  }
  if (sum <= 1e-9) return weights;
  const out = {};
  for (const [k, v] of Object.entries(weights)) {
    out[k] = Math.round((Math.max(0, v) / sum) * 10000) / 10000;
  }
  return Object.freeze(out);
}

// Classify Köppen-Geiger climate zone and derive ecological plant species mix weights
// from 12 monthly mean temperatures (°C), 12 monthly precipitation rates (mm/day), and mean relative humidity (%).
export function classifyKoppenClimateFromNormals({
  monthlyTempC,
  monthlyPrecipMmDay,
  monthlyPrecipMm: rawMonthlyPrecipMm,
  meanHumidityPct,
  meanRelHumidityPct,
  latitude = 15,
  longitude = -75,
  source = 'bioclimatic-model',
} = {}) {
  const effectiveHumidityPct = Number.isFinite(meanHumidityPct)
    ? meanHumidityPct
    : Number.isFinite(meanRelHumidityPct)
    ? meanRelHumidityPct
    : 76;
  const temps = Array.isArray(monthlyTempC) && monthlyTempC.length === 12
    ? monthlyTempC.map(Number)
    : Array(12).fill(26);
  const monthlyPrecipMm = Array.isArray(rawMonthlyPrecipMm) && rawMonthlyPrecipMm.length === 12
    ? rawMonthlyPrecipMm.map(v => Math.max(0, Number(v) || 0))
    : (Array.isArray(monthlyPrecipMmDay) && monthlyPrecipMmDay.length === 12
        ? monthlyPrecipMmDay.map(v => Math.max(0, Number(v) || 0) * 30.4375)
        : Array(12).fill(4.2 * 30.4375));

  const meanAnnualTempC = temps.reduce((a, b) => a + b, 0) / 12;
  const coldestMonthTempC = Math.min(...temps);
  const warmestMonthTempC = Math.max(...temps);
  const annualPrecipMm = monthlyPrecipMm.reduce((a, b) => a + b, 0);
  const driestMonthPrecipMm = Math.min(...monthlyPrecipMm);
  const wettestMonthPrecipMm = Math.max(...monthlyPrecipMm);
  const drySeasonMonths = monthlyPrecipMm.filter(p => p < 60).length;

  const isNorthern = latitude >= 0;
  const summerIndices = isNorthern ? [3, 4, 5, 6, 7, 8] : [9, 10, 11, 0, 1, 2];
  const winterIndices = isNorthern ? [9, 10, 11, 0, 1, 2] : [3, 4, 5, 6, 7, 8];
  const summerPrecipMm = summerIndices.reduce((acc, idx) => acc + monthlyPrecipMm[idx], 0);
  const winterPrecipMm = winterIndices.reduce((acc, idx) => acc + monthlyPrecipMm[idx], 0);
  const driestSummerMm = Math.min(...summerIndices.map(idx => monthlyPrecipMm[idx]));
  const wettestWinterMm = Math.max(...winterIndices.map(idx => monthlyPrecipMm[idx]));

  const precipSeasonOffset = summerPrecipMm >= 0.7 * Math.max(1, annualPrecipMm)
    ? 280
    : winterPrecipMm >= 0.7 * Math.max(1, annualPrecipMm)
      ? 0
      : 140;
  const aridityThresholdMm = Math.max(120, 20 * meanAnnualTempC + precipSeasonOffset);

  let koppenCode = 'Am';
  let koppenLabel = 'Tropical Monsoon Coast';
  let climateZone = 'tropical';

  if (annualPrecipMm < 0.5 * aridityThresholdMm) {
    koppenCode = meanAnnualTempC >= 18 ? 'BWh' : 'BWk';
    koppenLabel = meanAnnualTempC >= 18 ? 'Hot Arid Coastal Desert' : 'Cool Arid Steppe Coast';
    climateZone = 'arid';
  } else if (annualPrecipMm < aridityThresholdMm) {
    koppenCode = meanAnnualTempC >= 18 ? 'BSh' : 'BSk';
    koppenLabel = meanAnnualTempC >= 18 ? 'Tropical / Subtropical Semi-Arid Scrub' : 'Temperate Semi-Arid Coast';
    climateZone = 'arid';
  } else if (coldestMonthTempC >= 18.0) {
    climateZone = 'tropical';
    if (driestMonthPrecipMm >= 60.0) {
      koppenCode = 'Af';
      koppenLabel = 'Equatorial / Tropical Rainforest';
    } else if (driestMonthPrecipMm >= 100.0 - annualPrecipMm / 25.0) {
      koppenCode = 'Am';
      koppenLabel = 'Tropical Monsoon Forest';
    } else {
      koppenCode = 'Aw';
      koppenLabel = 'Tropical Wet-Dry Savanna & Gallery Forest';
    }
  } else if (
    coldestMonthTempC >= 9.5 ||
    (Math.abs(latitude) < 34.0 && warmestMonthTempC >= 21.5 && coldestMonthTempC > 5.0)
  ) {
    if (
      Math.abs(latitude) >= 27.5 &&
      driestSummerMm < 40.0 &&
      driestSummerMm < wettestWinterMm / 3.0
    ) {
      koppenCode = warmestMonthTempC >= 22.0 ? 'Csa' : 'Csb';
      koppenLabel = 'Mediterranean Warm-Summer Coast';
      climateZone = 'mediterranean';
    } else {
      koppenCode = driestMonthPrecipMm < 30.0 ? 'Cwa' : 'Cfa';
      koppenLabel = 'Humid Subtropical Coast';
      climateZone = 'subtropical';
    }
  } else if (warmestMonthTempC < 15.0 || Math.abs(latitude) >= 58.0) {
    koppenCode = 'Dfc';
    koppenLabel = 'Subpolar / Boreal Fjord Coast';
    climateZone = 'boreal';
  } else {
    koppenCode = coldestMonthTempC < -2.0 ? 'Dfb' : 'Cfb';
    koppenLabel = coldestMonthTempC < -2.0 ? 'Humid Continental Hardwood Coast' : 'Oceanic Temperate Broadleaf Coast';
    climateZone = 'temperate';
  }

  // Use the tropical/subtropical plant mix (royal_palm, palm, ceiba, mangrove) for all tropical,
  // subtropical, and warm semi-arid/arid coastal regions.
  const isTropicalOrSubtropical =
    climateZone === 'tropical' ||
    climateZone === 'subtropical' ||
    (climateZone === 'arid' && (meanAnnualTempC >= 18.0 || Math.abs(latitude) < 33.5));
  const forestPackKind = isTropicalOrSubtropical ? 'subtropical' : 'temperate';

  const moistureNorm = Math.max(0, Math.min(1.5, annualPrecipMm / 1800));
  const humidityNorm = Math.max(0, Math.min(1.2, (effectiveHumidityPct - 45) / 45));
  const warmthNorm = Math.max(0, Math.min(1.2, (coldestMonthTempC - 8) / 16));
  const drySeasonIntensity = Math.max(0, Math.min(1, drySeasonMonths / 8));

  let uplandForestWeights;
  let coastalStrandWeights;
  let lagoonMangroveWeights;
  let canopyDensityMultiplier = 1.0;
  let foliageTint = [0.82, 1.08, 0.72];

  if (forestPackKind === 'subtropical') {
    // Dynamically balance the 4 tropical/subtropical species (royal_palm, palm, ceiba, mangrove)
    // according to local rainfall, dry-season length, humidity, and winter minimum temperature:
    // - Af (Rainforest): tall emergent Ceiba pentandra + Cuban Royal Palm + Coconut Palm + estuarine Mangrove
    // - Am (Monsoon): abundant Cuban Royal Palm + Coconut Palm + Ceiba + Mangrove
    // - Aw (Wet-Dry Savanna): sunlit Royal Palm & Coconut Palm groves with gallery Ceiba and lagoon Mangroves
    // - Cfa/Cwa (Humid Subtropical): Sabal/Royal Palm + broadleaf Ceiba hammock + coastal Palm & Mangrove
    // - BSh/BWh (Warm Semi-Arid/Arid): Coconut/Date Palm & Royal Palm oasis mix
    const ceibaShare =
      climateZone === 'arid'
        ? 0.06
        : Math.max(0.10, Math.min(0.55, 0.14 + 0.28 * moistureNorm - 0.12 * drySeasonIntensity + 0.05 * warmthNorm));
    const royalPalmShare =
      climateZone === 'arid'
        ? 0.28
        : Math.max(0.24, Math.min(0.44, 0.32 + 0.06 * warmthNorm + 0.04 * drySeasonIntensity));
    const coconutPalmShare =
      climateZone === 'arid'
        ? 0.50
        : Math.max(0.14, Math.min(0.42, 0.24 + 0.14 * drySeasonIntensity - 0.08 * moistureNorm));
    const mangroveUplandShare =
      climateZone === 'arid'
        ? 0.16
        : Math.max(0.10, Math.min(0.22, 0.11 + 0.05 * humidityNorm + 0.03 * moistureNorm));

    uplandForestWeights = normalizeSpeciesWeights({
      royal_palm: royalPalmShare,
      palm: coconutPalmShare,
      ceiba: ceibaShare,
      mangrove: mangroveUplandShare,
    });
    coastalStrandWeights = normalizeSpeciesWeights({
      palm: 0.52 + 0.08 * drySeasonIntensity,
      royal_palm: 0.28,
      mangrove: 0.14 + 0.06 * moistureNorm,
      ceiba: 0.06,
    });
    lagoonMangroveWeights = normalizeSpeciesWeights({
      mangrove: 0.62 + 0.08 * humidityNorm,
      palm: 0.22,
      royal_palm: 0.10,
      ceiba: 0.06,
    });

    canopyDensityMultiplier =
      climateZone === 'arid'
        ? 0.52
        : Math.max(0.75, Math.min(1.22, 0.78 + 0.28 * moistureNorm + 0.08 * humidityNorm));
    foliageTint =
      koppenCode === 'Af'
        ? [0.76, 1.14, 0.66]
        : koppenCode === 'Aw' || climateZone === 'arid'
          ? [0.88, 1.06, 0.70]
          : [0.80, 1.11, 0.68];
  } else {
    // Temperate / Mediterranean / Boreal broadleaf & mixed stand modulation
    const oakShare =
      climateZone === 'mediterranean'
        ? 0.46
        : climateZone === 'boreal'
          ? 0.12
          : Math.max(0.20, Math.min(0.42, 0.26 + 0.12 * warmthNorm));
    const mapleShare =
      climateZone === 'mediterranean'
        ? 0.10
        : Math.max(0.18, Math.min(0.34, 0.28 - 0.04 * drySeasonIntensity));
    const birchShare =
      climateZone === 'boreal'
        ? 0.46
        : climateZone === 'mediterranean'
          ? 0.04
          : Math.max(0.10, Math.min(0.32, 0.22 - 0.12 * warmthNorm));
    const elmShare = Math.max(0.08, Math.min(0.22, 0.14 + 0.04 * moistureNorm));
    const chestnutShare =
      climateZone === 'mediterranean'
        ? 0.26
        : Math.max(0.06, Math.min(0.20, 0.12 + 0.06 * warmthNorm));

    uplandForestWeights = normalizeSpeciesWeights({
      oak: oakShare,
      maple: mapleShare,
      birch: birchShare,
      elm: elmShare,
      chestnut: chestnutShare,
    });
    coastalStrandWeights = normalizeSpeciesWeights({
      oak: oakShare * 1.15,
      birch: birchShare * 1.1,
      elm: elmShare * 1.2,
      maple: mapleShare * 0.8,
      chestnut: chestnutShare * 0.8,
    });
    lagoonMangroveWeights = normalizeSpeciesWeights({
      elm: 0.34,
      birch: 0.28,
      maple: 0.20,
      oak: 0.12,
      chestnut: 0.06,
    });
    canopyDensityMultiplier =
      climateZone === 'mediterranean'
        ? 0.78
        : Math.max(0.72, Math.min(1.15, 0.82 + 0.22 * moistureNorm));
    foliageTint =
      climateZone === 'mediterranean'
        ? [0.94, 0.98, 0.78]
        : [0.92, 1.02, 0.88];
  }

  return Object.freeze({
    source,
    latitude: Number(latitude.toFixed(4)),
    longitude: Number(longitude.toFixed(4)),
    koppenCode,
    koppenLabel,
    climate: climateZone,
    climateZone,
    forestPackKind,
    meanAnnualTempC: Number(meanAnnualTempC.toFixed(1)),
    coldestMonthTempC: Number(coldestMonthTempC.toFixed(1)),
    warmestMonthTempC: Number(warmestMonthTempC.toFixed(1)),
    annualPrecipMm: Math.round(annualPrecipMm),
    driestMonthPrecipMm: Math.round(driestMonthPrecipMm),
    wettestMonthPrecipMm: Math.round(wettestMonthPrecipMm),
    drySeasonMonths,
    meanHumidityPct: Math.round(effectiveHumidityPct),
    canopyDensityMultiplier: Number(canopyDensityMultiplier.toFixed(3)),
    foliageTint: Object.freeze(foliageTint),
    speciesWeights: uplandForestWeights,
    uplandForestWeights,
    coastalStrandWeights,
    lagoonMangroveWeights,
  });
}

// Instantaneous bioclimatic estimator from (latitude, longitude) and regional geography.
export function estimateLocalClimateProfile(latitude = 10.423, longitude = -75.548, region = null) {
  const lat = Number.isFinite(Number(latitude)) ? Number(latitude) : region?.latitude ?? 10.423;
  const lon = Number.isFinite(Number(longitude)) ? Number(longitude) : region?.longitude ?? -75.548;
  const absLat = Math.abs(lat);
  const latRad = absLat * COASTAL_DEG_TO_RAD;

  // Base sea-level mean temperature and seasonal amplitude
  const baseMeanTemp = 28.4 - 22.5 * Math.pow(Math.sin(latRad), 1.35);
  const seasonalAmp = Math.min(14.5, 1.1 + 11.8 * Math.pow(Math.sin(latRad), 1.25));

  // Regional trade-wind / monsoon / ocean-current moisture & temperature adjustments
  const isCaribbean = lat >= 7 && lat <= 25 && lon >= -92 && lon <= -58;
  const isPanamaIsthmus = lat >= 7 && lat <= 10.1 && lon >= -83 && lon <= -77;
  const isSubtropicalWestAtlantic = lat > 25 && lat <= 34 && lon >= -85 && lon <= -74;
  const isMediterranean = lat >= 30 && lat <= 45 && lon >= -10 && lon <= 36;
  const isSubtropicalAridBelt =
    absLat >= 18 &&
    absLat <= 31 &&
    !isCaribbean &&
    !isSubtropicalWestAtlantic &&
    ((lon >= -118 && lon <= -104) || (lon >= -18 && lon <= 58) || (lon >= 112 && lon <= 125));

  let annualRainMm = 1450;
  let dryRatio = 0.25;
  let wetRatio = 1.85;
  let meanHumidity = 78;

  if (isPanamaIsthmus) {
    annualRainMm = 2850;
    dryRatio = 0.48;
    wetRatio = 1.65;
    meanHumidity = 85;
  } else if (isCaribbean) {
    // Distinguish southern Caribbean dry-season Savanna/Monsoon (Cartagena, Havana) from wetter trade-wind islands (San Juan, Saba, Santo Domingo)
    const tradeWindWetness = coastalSmoothstep(-78, -62, lon) * 0.45 + coastalSmoothstep(10, 19, lat) * 0.25;
    annualRainMm = Math.round(1180 + tradeWindWetness * 920);
    dryRatio = 0.10 + tradeWindWetness * 0.36;
    wetRatio = 1.95 - tradeWindWetness * 0.25;
    meanHumidity = Math.round(77 + tradeWindWetness * 7);
  } else if (isSubtropicalWestAtlantic) {
    annualRainMm = 1340;
    dryRatio = 0.52;
    wetRatio = 1.55;
    meanHumidity = 76;
  } else if (isMediterranean) {
    annualRainMm = 580;
    dryRatio = 0.08;
    wetRatio = 2.15;
    meanHumidity = 64;
  } else if (isSubtropicalAridBelt) {
    annualRainMm = 260;
    dryRatio = 0.05;
    wetRatio = 2.1;
    meanHumidity = 52;
  } else if (absLat < 12) {
    annualRainMm = 2350;
    dryRatio = 0.55;
    wetRatio = 1.55;
    meanHumidity = 84;
  } else if (absLat < 23.5) {
    annualRainMm = 1520;
    dryRatio = 0.18;
    wetRatio = 1.9;
    meanHumidity = 79;
  } else if (absLat < 35) {
    annualRainMm = 1120;
    dryRatio = 0.45;
    wetRatio = 1.55;
    meanHumidity = 73;
  } else {
    annualRainMm = 940;
    dryRatio = 0.65;
    wetRatio = 1.35;
    meanHumidity = 74;
  }

  const isNorthern = lat >= 0;
  const monthlyTempC = [];
  const monthlyPrecipMmDay = [];
  const meanDailyMm = annualRainMm / 365.25;

  for (let m = 0; m < 12; m++) {
    // Peak warmth in July (m=6) for Northern Hemisphere, January (m=0) for Southern Hemisphere
    const phase = ((m - (isNorthern ? 6 : 0)) / 12) * Math.PI * 2;
    const temp = baseMeanTemp + seasonalAmp * Math.cos(phase);
    monthlyTempC.push(temp);

    // Mediterranean has dry summer; tropics/subtropics have wet summer/autumn
    const rainPhase = isMediterranean ? phase + Math.PI : phase - 0.45;
    const seasonWave = 0.5 + 0.5 * Math.cos(rainPhase);
    const mult = dryRatio + (wetRatio - dryRatio) * seasonWave;
    monthlyPrecipMmDay.push(meanDailyMm * mult);
  }

  return classifyKoppenClimateFromNormals({
    monthlyTempC,
    monthlyPrecipMmDay,
    meanHumidityPct: meanHumidity,
    latitude: lat,
    longitude: lon,
    source: 'bioclimatic-model',
  });
}

// Fetch real 30-year monthly climatological normals (T2M, PRECTOTCORR, RH2M) from the public,
// zero-API-key NASA POWER Climatology API, with local caching and automatic offline fallback.
export async function fetchPublicClimateProfile(
  latitude,
  longitude,
  { fetchImpl = globalThis.fetch, timeoutMs = 4500, region = null } = {}
) {
  const lat = Number(latitude);
  const lon = Number(longitude);
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) {
    return estimateLocalClimateProfile(10.423, -75.548, region);
  }
  const cacheKey = `${lat.toFixed(1)},${lon.toFixed(1)}`;
  if (CLIMATE_PROFILE_CACHE.has(cacheKey)) {
    return CLIMATE_PROFILE_CACHE.get(cacheKey);
  }
  const storageKey = `waterworld_climate_v1_${cacheKey}`;
  try {
    if (typeof localStorage !== 'undefined') {
      const raw = localStorage.getItem(storageKey);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && parsed.koppenCode && parsed.uplandForestWeights) {
          CLIMATE_PROFILE_CACHE.set(cacheKey, parsed);
          return parsed;
        }
      }
    }
  } catch { /* ignore storage access errors */ }

  if (typeof fetchImpl !== 'function') {
    const est = estimateLocalClimateProfile(lat, lon, region);
    CLIMATE_PROFILE_CACHE.set(cacheKey, est);
    return est;
  }

  const controller = typeof AbortController === 'function' ? new AbortController() : null;
  const timer = controller ? setTimeout(() => controller.abort(), timeoutMs) : null;
  try {
    const url =
      `https://power.larc.nasa.gov/api/temporal/climatology/point` +
      `?parameters=T2M,PRECTOTCORR,RH2M&community=RE` +
      `&longitude=${encodeURIComponent(lon.toFixed(3))}` +
      `&latitude=${encodeURIComponent(lat.toFixed(3))}&format=JSON`;
    const res = await fetchImpl(url, controller ? { signal: controller.signal } : undefined);
    if (!res.ok) throw new Error(`NASA POWER HTTP ${res.status}`);
    const data = await res.json();
    const param = data?.properties?.parameter;
    const t2m = param?.T2M;
    const prec = param?.PRECTOTCORR;
    const rh = param?.RH2M;
    if (!t2m || !prec) throw new Error('Incomplete NASA POWER climatology payload');

    const monthlyTempC = CLIMATE_MONTH_KEYS.map(k => Number(t2m[k]));
    const monthlyPrecipMmDay = CLIMATE_MONTH_KEYS.map(k => Number(prec[k]));
    if (monthlyTempC.some(v => !Number.isFinite(v) || v < -80 || v > 65)) {
      throw new Error('Invalid monthly temperature values');
    }
    const meanHumidityPct = Number.isFinite(Number(rh?.ANN)) ? Number(rh.ANN) : 76;

    const profile = classifyKoppenClimateFromNormals({
      monthlyTempC,
      monthlyPrecipMmDay,
      meanHumidityPct,
      latitude: lat,
      longitude: lon,
      source: 'nasa-power-climatology',
    });
    CLIMATE_PROFILE_CACHE.set(cacheKey, profile);
    try {
      if (typeof localStorage !== 'undefined') {
        localStorage.setItem(storageKey, JSON.stringify(profile));
      }
    } catch { /* ignore quota error */ }
    return profile;
  } catch {
    const fallback = estimateLocalClimateProfile(lat, lon, region);
    CLIMATE_PROFILE_CACHE.set(cacheKey, fallback);
    return fallback;
  } finally {
    if (timer) clearTimeout(timer);
  }
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

function coastalSampleClamped(heights, x, z, region) {
  const half = region.span * 0.5 - 1e-3;
  const cx = Math.max(region.x - half, Math.min(region.x + half, x));
  const cz = Math.max(region.z - half, Math.min(region.z + half, z));
  return terrainSample(heights, cx, cz, region);
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
      const h = coastalSampleClamped(heights, x, z, region);
      const sx = (coastalSampleClamped(heights, x + 8, z, region) - coastalSampleClamped(heights, x - 8, z, region)) / 16;
      const sz = (coastalSampleClamped(heights, x, z + 8, region) - coastalSampleClamped(heights, x, z - 8, region)) / 16;
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
        roofClass: fp.roofClass ?? 1,
        fillRatio: fp.fillRatio ?? null,
        holeRatio: fp.holeRatio ?? null,
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
  // Multi-class 1550 roof & fortification mask:
  // 1 = terracotta tile / dark wood shingle roof
  // 2 = palm-thatch bohío / caney / palafito roof
  // 3 = grey ashlar / coquina fortification, tower, or bridge
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
      if (h < -0.6 || h > 68 || inlandM > 960) continue;
      const sat = sampleSatelliteEquirectangular(satelliteData, u, v);
      if (!sat) continue;
      // Class 1: 1550 AI orthophoto terracotta barrel-tile & weathered timber/shingle roof signature
      const isTerracotta = sat.r > 92 && sat.r < 236 && sat.g < 164 && sat.r - sat.g >= 24 && sat.r - sat.b >= 42;
      const isBrownShingle =
        sat.r > 90 &&
        sat.r < 200 &&
        sat.r - sat.g >= 16 &&
        sat.r - sat.b >= 30 &&
        sat.luma < 122 &&
        sat.g > sat.b + 8;
      if (h >= 0.45 && inlandM >= 8 && (isTerracotta || isBrownShingle)) {
        mask[gz * gSize + gx] = 1;
        continue;
      }
      if (satelliteData.is1550Orthophoto) {
        // Class 2: Warm tan / golden-ochre palm-thatch roofs (bohíos, caneyes & mangrove palafitos)
        const isPalmThatch =
          h >= -0.4 &&
          h <= 26 &&
          inlandM >= 2 &&
          inlandM <= 360 &&
          sat.r >= 118 &&
          sat.r <= 196 &&
          sat.g >= 96 &&
          sat.g <= 168 &&
          sat.b >= 58 &&
          sat.b <= 128 &&
          sat.r - sat.g >= 13 &&
          sat.r - sat.g <= 30 &&
          sat.g - sat.b >= 18 &&
          sat.r - sat.b >= 36 &&
          sat.luma >= 100 &&
          sat.luma <= 164;
        if (isPalmThatch) {
          mask[gz * gSize + gx] = 2;
          continue;
        }
        // Class 3: Grey-stone ashlar fortifications, watchtowers & cutwater bridges
        const isGreyStone =
          h >= -0.5 &&
          h <= 42 &&
          inlandM <= 160 &&
          Math.abs(sat.r - sat.g) <= 11 &&
          Math.abs(sat.g - sat.b) <= 13 &&
          sat.r >= sat.b - 4 &&
          sat.luma >= 116 &&
          sat.luma <= 182;
        if (isGreyStone) {
          mask[gz * gSize + gx] = 3;
        }
      }
    }
  }

  const visited = new Uint8Array(gSize * gSize);
  const rawBlobs = [];
  const q = new Int32Array(gSize * gSize);
  for (let idx = 0; idx < gSize * gSize; idx++) {
    const curClass = mask[idx];
    if (!curClass || visited[idx]) continue;
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
          if (mask[nIdx] === curClass && !visited[nIdx]) {
            visited[nIdx] = 1;
            q[tail++] = nIdx;
          }
        }
      }
    }
    const minPts = curClass === 1 ? 2 : 4;
    const maxPts = curClass === 3 ? 1600 : 2400;
    if (pts.length >= minPts && pts.length <= maxPts) {
      const count = pts.length;
      rawBlobs.push({
        cx: sumX / count,
        cz: sumZ / count,
        meanH: sumH / count,
        meanInland: sumInland / count,
        count,
        roofClass: curClass,
        pts,
      });
    }
  }

  if (rawBlobs.length < 1) return null;

  // Identify dominant 1550 colonial settlement cluster (weighted toward terracotta & thatch roof blobs)
  let bestClusterScore = -Infinity;
  let seedX = 0, seedZ = 0;
  for (const b of rawBlobs) {
    let localWeight = 0;
    for (const other of rawBlobs) {
      const d = Math.hypot(other.cx - b.cx, other.cz - b.cz);
      const classW = other.roofClass === 1 ? 1.0 : other.roofClass === 2 ? 0.65 : 0.35;
      if (d <= 650) localWeight += other.count * classW * (1 - d / 750);
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
      const cw = b.roofClass === 1 ? b.count : b.count * 0.5;
      clusterX += b.cx * cw;
      clusterZ += b.cz * cw;
      wSum += cw;
    }
  }
  if (wSum < 6) return null;
  clusterX /= wSum;
  clusterZ /= wSum;

  // Minimum-Area Oriented Bounding Box (Rotating Calipers) + Interior Courtyard Vacancy (holeRatio)
  const computeMinAreaOBB = (pts, mx, mz) => {
    let bestArea = Infinity;
    let bestX = mx, bestZ = mz, bestW = 24, bestL = 28, bestYaw = 0, bestAngle = 0;
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
          bestAngle = a;
        } else {
          bestW = sv;
          bestL = su;
          bestYaw = -(a + Math.PI * 0.5);
          bestAngle = a + Math.PI * 0.5;
        }
      }
    }
    const ca = Math.cos(bestAngle), sa = Math.sin(bestAngle);
    let coreCount = 0;
    const coreW = bestW * 0.22;
    const coreL = bestL * 0.22;
    for (const [px, pz] of pts) {
      const dx = px - bestX, dz = pz - bestZ;
      const u = Math.abs(dx * ca + dz * sa);
      const v = Math.abs(-dx * sa + dz * ca);
      if (u <= coreW && v <= coreL) coreCount++;
    }
    const cellArea = cellStep * cellStep;
    const fillRatio = Math.min(1, (pts.length * cellArea) / Math.max(cellArea, bestW * bestL));
    const expectedCore = Math.max(1, (bestW * 0.44 * bestL * 0.44) / cellArea);
    const holeRatio = Math.max(0, Math.min(1, 1 - coreCount / expectedCore));
    return {
      x: bestX,
      z: bestZ,
      width: bestW,
      length: bestL,
      yaw: bestYaw,
      area: bestW * bestL,
      fillRatio,
      holeRatio,
    };
  };

  const candidates = [];
  for (const b of clusterBlobs) {
    const obb = computeMinAreaOBB(b.pts, b.cx, b.cz);
    const hGround = terrainSample(heights, obb.x, obb.z, region);
    if (b.roofClass === 1 && hGround < 0.4) continue;
    if (b.roofClass !== 1 && hGround < -1.2) continue;
    candidates.push({
      x: obb.x,
      z: obb.z,
      y: Math.max(0.5, hGround),
      yaw: obb.yaw,
      length: obb.length,
      width: obb.width,
      area: obb.area,
      inlandM: b.meanInland,
      roofClass: b.roofClass,
      fillRatio: obb.fillRatio,
      holeRatio: obb.holeRatio,
    });
  }

  // Sort terracotta & landmark structures first, then by area
  candidates.sort((a, b) => (a.roofClass === 1 ? 1 : 0) !== (b.roofClass === 1 ? 1 : 0)
    ? (b.roofClass === 1 ? 1 : -1)
    : b.area - a.area);
  const footprints = [];
  for (const c of candidates) {
    if (footprints.length >= 32) break;
    let overlaps = false;
    for (const existing of footprints) {
      const minSep = 0.42 * (Math.min(c.width, c.length) + Math.min(existing.width, existing.length));
      if (Math.hypot(c.x - existing.x, c.z - existing.z) < Math.max(8, minSep)) {
        overlaps = true;
        break;
      }
    }
    if (!overlaps) footprints.push(c);
  }

  return footprints.length >= 4 ? { clusterX, clusterZ, footprints } : null;
}

export function validateOrthophotoScale1550(regionSpec, satelliteData = null, precomputedFootprints = null) {
  const region = resolveGlobalCoastalRegion(regionSpec);
  const pre = precomputedFootprints || satelliteData?.precomputedFootprints || null;

  if (Number.isFinite(pre?.span) && pre.span >= 1200 && pre.span <= 2600) {
    return {
      spanM: Math.round(pre.span),
      metersPerPixel: Number((pre.span / 1024).toFixed(3)),
      footprintScale: 1,
    };
  }

  if (Array.isArray(pre?.footprints) && pre.footprints.length >= 3) {
    const widths = pre.footprints
      .filter((fp) => fp.prefabId !== 'stone_sea_bastion')
      .map((fp) => Number(fp.width) || 20)
      .sort((a, b) => a - b);
    const allWidths = (widths.length >= 2 ? widths : pre.footprints.map((fp) => Number(fp.width) || 20)).sort(
      (a, b) => a - b
    );
    const medW = allWidths[Math.floor(allWidths.length * 0.5)] || 20;
    if (medW > 28) {
      // Footprints were measured against an unvalidated wide map span; rescale to true ~20m single-building width
      const footprintScale = 20.0 / medW;
      const spanM = Math.round(Math.max(1350, Math.min(2300, region.span * footprintScale)));
      return {
        spanM,
        metersPerPixel: Number((spanM / 1024).toFixed(3)),
        footprintScale: spanM / region.span,
      };
    }
    const spanM =
      region.span > 2600
        ? Math.round(Math.max(1350, Math.min(2300, 1024 * (medW / 13.0))))
        : Math.round(region.span);
    return {
      spanM,
      metersPerPixel: Number((spanM / 1024).toFixed(3)),
      footprintScale: 1,
    };
  }

  if (satelliteData?.rgba && satelliteData?.size && (satelliteData.is1550Orthophoto || satelliteData.allowFootprints)) {
    const sz = satelliteData.size;
    const rgba = satelliteData.rgba;
    const gSize = 256;
    const mask = new Uint8Array(gSize * gSize);
    for (let gz = 0; gz < gSize; gz++) {
      const sy = Math.min(sz - 1, Math.floor(((gz + 0.5) / gSize) * sz));
      for (let gx = 0; gx < gSize; gx++) {
        const sx = Math.min(sz - 1, Math.floor(((gx + 0.5) / gSize) * sz));
        const k = (sy * sz + sx) * 4;
        const r = rgba[k], g = rgba[k + 1], b = rgba[k + 2];
        const luma = 0.299 * r + 0.587 * g + 0.114 * b;
        const isRoof =
          (r > 92 && r < 236 && g < 164 && r - g >= 24 && r - b >= 42) ||
          (r > 90 && r < 200 && r - g >= 16 && r - b >= 30 && luma < 122 && g > b + 8);
        if (isRoof) mask[gz * gSize + gx] = 1;
      }
    }
    const visited = new Uint8Array(gSize * gSize);
    const q = new Int32Array(gSize * gSize);
    const pxScale = 1024 / gSize;
    const bldgPxWidths = [];
    for (let idx = 0; idx < gSize * gSize; idx++) {
      if (!mask[idx] || visited[idx]) continue;
      let head = 0, tail = 0;
      q[tail++] = idx;
      visited[idx] = 1;
      let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
      while (head < tail) {
        const cur = q[head++];
        const gz = Math.floor(cur / gSize);
        const gx = cur - gz * gSize;
        if (gx < minX) minX = gx;
        if (gx > maxX) maxX = gx;
        if (gz < minZ) minZ = gz;
        if (gz > maxZ) maxZ = gz;
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
      if (tail >= 2 && tail <= 90) {
        const wPx = (Math.min(maxX - minX + 1, maxZ - minZ + 1) + 0.5) * pxScale;
        if (wPx >= 6 && wPx <= 28) bldgPxWidths.push(wPx);
      }
    }
    bldgPxWidths.sort((a, b) => a - b);
    const medBldgPx = bldgPxWidths.length >= 3 ? bldgPxWidths[Math.floor(bldgPxWidths.length * 0.5)] : 13.0;
    const mpp = Math.max(1.32, Math.min(2.25, 20.0 / medBldgPx));
    const spanM = Math.round(1024 * mpp);
    return {
      spanM,
      metersPerPixel: Number(mpp.toFixed(3)),
      footprintScale: spanM / region.span,
    };
  }

  if (satelliteData?.is1550Orthophoto) {
    const spanM = 1600;
    return {
      spanM,
      metersPerPixel: Number((spanM / 1024).toFixed(3)),
      footprintScale: spanM / region.span,
    };
  }

  return {
    spanM: region.span,
    metersPerPixel: Number((region.span / 1024).toFixed(3)),
    footprintScale: 1,
  };
}

function extractAndCarveHarborQuaysAndPiers(region, heights, orthoFootprints) {
  const n = region.size;
  const span = region.span;
  const distInfo = computeCoastalShoreDistances(heights, n, span, 0.25);
  const coreFloats = new Float32Array(n * n);
  for (let k = 0; k < n * n; k++) {
    coreFloats[k] = heights[k] > 0.25 && (distInfo.distWater[k] >= 17.5 || heights[k] > 8.0) ? 1.0 : -1.0;
  }
  const coreDist = computeCoastalShoreDistances(coreFloats, n, span, 0.0);
  const isProtrusion = new Uint8Array(n * n);
  for (let k = 0; k < n * n; k++) {
    if (heights[k] > 0.20 && coreDist.distLand[k] > 20.5) isProtrusion[k] = 1;
  }

  const bldgs = orthoFootprints?.footprints || [];
  const clusterX = orthoFootprints?.clusterX ?? region.x;
  const clusterZ = orthoFootprints?.clusterZ ?? region.z;
  const vis = new Uint8Array(n * n);
  const rawPiers = [];
  const step = span / (n - 1);
  const searchR = Math.ceil(46 / step);

  for (let idx = 0; idx < n * n; idx++) {
    if (!isProtrusion[idx] || vis[idx]) continue;
    const q = [idx];
    vis[idx] = 1;
    const cells = [];
    let minD = Infinity;
    let maxD = -Infinity;
    let tipX = 0, tipZ = 0, baseX = 0, baseZ = 0, sumX = 0, sumZ = 0;
    while (q.length) {
      const c = q.pop();
      const cj = Math.floor(c / n);
      const ci = c - cj * n;
      const wx = region.x + (ci / (n - 1) - 0.5) * span;
      const wz = region.z + (cj / (n - 1) - 0.5) * span;
      const d = coreDist.distLand[c];
      cells.push([ci, cj]);
      sumX += wx;
      sumZ += wz;
      if (d < minD) {
        minD = d;
        baseX = wx;
        baseZ = wz;
      }
      if (d > maxD) {
        maxD = d;
        tipX = wx;
        tipZ = wz;
      }
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const ni = ci + dx, nj = cj + dz;
          if (ni >= 0 && ni < n && nj >= 0 && nj < n) {
            const nk = nj * n + ni;
            if (isProtrusion[nk] && !vis[nk]) {
              vis[nk] = 1;
              q.push(nk);
            }
          }
        }
      }
    }
    const blobAreaM2 = cells.length * step * step;
    if (cells.length < 2 || blobAreaM2 < 24 || blobAreaM2 > 6500) continue;

    // Carve narrow AI boat/pier outlines in the harbor back into navigable water depth
    for (const [ci, cj] of cells) {
      for (let dz = -1; dz <= 1; dz++) {
        for (let dx = -1; dx <= 1; dx++) {
          const ni = ci + dx, nj = cj + dz;
          if (ni >= 0 && ni < n && nj >= 0 && nj < n) {
            const nk = nj * n + ni;
            if (coreDist.distLand[nk] > 18.0 && heights[nk] > -2.4) {
              heights[nk] = -Math.min(10.5, 2.4 + 0.15 * Math.max(0, coreDist.distLand[nk] - 17.5));
            }
          }
        }
      }
    }

    const cx = sumX / cells.length;
    const cz = sumZ / cells.length;
    let minBldgDist = Math.hypot(cx - clusterX, cz - clusterZ);
    for (const b of bldgs) {
      const bd = Math.hypot(cx - b.x, cz - b.z);
      if (bd < minBldgDist) minBldgDist = bd;
    }

    if (blobAreaM2 >= 65 && minBldgDist <= 310 && minD <= 42 + step) {
      const bi = Math.round(((baseX - region.x) / span + 0.5) * (n - 1));
      const bj = Math.round(((baseZ - region.z) / span + 0.5) * (n - 1));
      const shoreMinD = Math.max(6.0, 15.5 - step * 0.85);
      const shoreMaxD = 18.5 + step * 0.85;
      let rootX = baseX, rootZ = baseZ, bestRDist = Infinity;
      for (let dj = -searchR; dj <= searchR; dj++) {
        const nj = bj + dj;
        if (nj < 0 || nj >= n) continue;
        for (let di = -searchR; di <= searchR; di++) {
          const ni = bi + di;
          if (ni < 0 || ni >= n) continue;
          const nk = nj * n + ni;
          if (coreDist.distLand[nk] >= shoreMinD && coreDist.distLand[nk] <= shoreMaxD && heights[nk] > 0.35) {
            const wx = region.x + (ni / (n - 1) - 0.5) * span;
            const wz = region.z + (nj / (n - 1) - 0.5) * span;
            const dd = Math.hypot(wx - baseX, wz - baseZ);
            if (dd < bestRDist) {
              bestRDist = dd;
              rootX = wx;
              rootZ = wz;
            }
          }
        }
      }
      const dx = tipX - rootX;
      const dz = tipZ - rootZ;
      const reach = Math.hypot(dx, dz);
      if (reach >= 14 && bestRDist < 55) {
        rawPiers.push({
          cells: cells.length,
          rootX,
          rootZ,
          tipX,
          tipZ,
          reach,
          ux: dx / reach,
          uz: dz / reach,
        });
      }
    }
  }

  rawPiers.sort((a, b) => b.reach - a.reach);
  const selected = [];
  for (const p of rawPiers) {
    if (selected.length >= 5) break;
    const tooClose = selected.some(
      (s) => Math.hypot(p.rootX - s.rootX, p.rootZ - s.rootZ) < 18 || Math.hypot(p.tipX - s.tipX, p.tipZ - s.tipZ) < 18
    );
    if (!tooClose) selected.push(p);
  }
  return selected;
}

export function placeCoastalPort(regionSpec, heights, { preserveRealCoast = false, satelliteData = null, shoreDist = null } = {}) {
  const region = resolveGlobalCoastalRegion(regionSpec);
  const orthoFootprints = extractOrthophotoBuildingFootprints(region, heights, satelliteData, shoreDist);
  const hasOrthoFootprints = Boolean(orthoFootprints?.footprints?.length >= 4);
  const extractedHarborPiers =
    hasOrthoFootprints || satelliteData?.is1550Orthophoto
      ? extractAndCarveHarborQuaysAndPiers(region, heights, orthoFootprints)
      : [];
  const clusterFrame = orthoFootprints
    ? coastalFrame(region, orthoFootprints.clusterX, orthoFootprints.clusterZ)
    : null;
  const scaleFactor = Math.min(1, region.span / 4096);
  const probeOffshoreM = Math.max(24, 72 * scaleFactor);
  const probeInlandM = Math.max(18, 48 * scaleFactor);

  // Scan a 2D coastal window (anchored to the 1550 orthophoto settlement cluster when present)
  // to find where the shoreline (h ~ 0) meets navigable harbor water offshore and buildable land inland.
  let bestShoreAlong = clusterFrame ? clusterFrame.along : 0;
  let bestShoreInland = 0;
  let bestScore = -Infinity;
  const probePoint = (alongProbe, inland) => {
    const p = worldFromCoastalFrame(region, alongProbe, inland);
    const h = terrainSample(heights, p.x, p.z, region);
    const offshoreP = worldFromCoastalFrame(region, alongProbe, inland - probeOffshoreM);
    const offshoreH = terrainSample(heights, offshoreP.x, offshoreP.z, region);
    const offshoreMidP = worldFromCoastalFrame(region, alongProbe, inland - probeOffshoreM * 2.2);
    const offshoreMidH = terrainSample(heights, offshoreMidP.x, offshoreMidP.z, region);
    const offshoreFarP = worldFromCoastalFrame(region, alongProbe, inland - probeOffshoreM * 3.8);
    const offshoreFarH = terrainSample(heights, offshoreFarP.x, offshoreFarP.z, region);
    const inlandP = worldFromCoastalFrame(region, alongProbe, inland + probeInlandM);
    const inlandH = terrainSample(heights, inlandP.x, inlandP.z, region);
    if (
      h >= -1.2 &&
      h <= 2.8 &&
      offshoreH <= -2.0 &&
      offshoreMidH <= -2.5 &&
      offshoreFarH <= -3.0 &&
      inlandH >= 0.8 &&
      inlandH <= 38
    ) {
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
    const scanAlong = Math.round(560 * Math.max(0.45, scaleFactor));
    const scanInland = Math.round(640 * Math.max(0.45, scaleFactor));
    const scanStep = Math.max(8, Math.round(24 * Math.max(0.45, scaleFactor)));
    for (let dAlong = -scanAlong; dAlong <= scanAlong; dAlong += scanStep) {
      for (let dInland = -scanInland; dInland <= scanInland; dInland += scanStep) {
        probePoint(clusterFrame.along + dAlong, clusterFrame.inland + dInland);
      }
    }
  }
  for (const alongProbe of [0, -120, 120, -240, 240, -380, 380]) {
    for (let inland = -1200; inland <= 800; inland += 16) {
      probePoint(alongProbe * scaleFactor, inland * scaleFactor);
    }
    if (bestScore > -Infinity && alongProbe === 0 && !clusterFrame) break;
  }
  // If real-world DEM shoreline lies outside the default synthetic bay window, scan wider coastal frame
  if (bestScore === -Infinity) {
    const halfSpan = region.span * 0.45;
    const stepScan = Math.max(12, Math.round(region.span / 96));
    for (let alongProbe = -halfSpan; alongProbe <= halfSpan; alongProbe += stepScan) {
      for (let inland = -halfSpan; inland <= halfSpan; inland += stepScan) {
        probePoint(alongProbe, inland);
      }
    }
  }
  // Ultimate fallback: scan heightfield cells directly for any true coastline (never default to (0,0) inland!)
  if (bestScore === -Infinity) {
    const n = region.size;
    const span = region.span;
    const targetX = orthoFootprints ? orthoFootprints.clusterX : region.x;
    const targetZ = orthoFootprints ? orthoFootprints.clusterZ : region.z;
    for (let j = 4; j < n - 4; j += 2) {
      const wz = region.z + (j / (n - 1) - 0.5) * span;
      for (let i = 4; i < n - 4; i += 2) {
        const h = heights[j * n + i];
        if (h < -0.8 || h > 2.2) continue;
        const hN = heights[Math.max(0, j - 3) * n + i];
        const hS = heights[Math.min(n - 1, j + 3) * n + i];
        const hW = heights[j * n + Math.max(0, i - 3)];
        const hE = heights[j * n + Math.min(n - 1, i + 3)];
        const minNeighbor = Math.min(hN, hS, hW, hE);
        const maxNeighbor = Math.max(hN, hS, hW, hE);
        if (minNeighbor <= -1.5 && maxNeighbor >= 1.2) {
          const wx = region.x + (i / (n - 1) - 0.5) * span;
          const distPenalty = Math.hypot(wx - targetX, wz - targetZ) * 0.02;
          const score = -minNeighbor - distPenalty;
          if (score > bestScore) {
            bestScore = score;
            const cf = coastalFrame(region, wx, wz);
            bestShoreAlong = cf.along;
            bestShoreInland = cf.inland;
          }
        }
      }
    }
  }

  // NMS-style Feature Stamp Terraforming: grade the harbor pier berth and level foundation pads
  // so every port building sits flush on level ground and the pier reaches deep water.
  const n = region.size;
  const span = region.span;
  const plazaRadiusAlong = preserveRealCoast ? 72 : 105;
  const plazaRadiusInland = preserveRealCoast ? 105 : 145;
  const berthHalfW = Math.max(18, 36 * scaleFactor);
  const berthMaxOffshore = Math.max(80, 190 * scaleFactor);
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

      // 1. Dredged harbor berth & pier approach channel (ONLY deepens existing water/shoals h <= 0.25; NEVER carves dry land into a lake!)
      if (h <= 0.25 && relInland < -4 && Math.abs(relAlong) < berthHalfW * 2.1) {
        const acrossW = Math.exp(-(relAlong * relAlong) / (2 * berthHalfW * berthHalfW));
        const berthW =
          coastalSmoothstep(-4, -Math.max(18, 38 * scaleFactor), relInland) *
          coastalSmoothstep(-berthMaxOffshore, -berthMaxOffshore * 0.58, relInland);
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

  // Grade flat building pads directly under each top-down single-building footprint (never elevating water)
  if (hasOrthoFootprints) {
    const step = span / (n - 1);
    const padMargin = Math.max(step * 1.5, 4.5);
    for (const fp of orthoFootprints.footprints) {
      const padY = Math.max(2.6, terrainSample(heights, fp.x, fp.z, region));
      const cosY = Math.cos(fp.yaw);
      const sinY = Math.sin(fp.yaw);
      const hw = fp.width * 0.5;
      const hl = fp.length * 0.5;
      const rad = Math.hypot(hw + padMargin, hl + padMargin);
      const i0 = Math.max(0, Math.floor(((fp.x - rad - region.x) / span + 0.5) * (n - 1)));
      const i1 = Math.min(n - 1, Math.ceil(((fp.x + rad - region.x) / span + 0.5) * (n - 1)));
      const j0 = Math.max(0, Math.floor(((fp.z - rad - region.z) / span + 0.5) * (n - 1)));
      const j1 = Math.min(n - 1, Math.ceil(((fp.z + rad - region.z) / span + 0.5) * (n - 1)));
      for (let j = j0; j <= j1; j++) {
        const wz = region.z + (j / (n - 1) - 0.5) * span;
        for (let i = i0; i <= i1; i++) {
          const k = j * n + i;
          if (heights[k] <= 0.15) continue;
          const wx = region.x + (i / (n - 1) - 0.5) * span;
          const dx = wx - fp.x;
          const dz = wz - fp.z;
          const lx = Math.abs(dx * cosY - dz * sinY);
          const lz = Math.abs(dx * sinY + dz * cosY);
          if (lx > hw + padMargin || lz > hl + padMargin) continue;
          const wxBlend = Math.max(0, Math.min(1, 1 - (lx - hw) / padMargin));
          const wzBlend = Math.max(0, Math.min(1, 1 - (lz - hl) / padMargin));
          const wBlend = wxBlend * wzBlend * 0.90;
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

  // 1. Timber mole piers & stone quays derived from harbor boat/pier outlines (or fallback shoreline pier)
  if (extractedHarborPiers.length > 0) {
    const pierPrefab = PORT_PREFABS.timber_mole_pier;
    const quayPrefab = PORT_PREFABS.stone_quay_seawall;
    for (const hp of extractedHarborPiers) {
      const pierYaw = Math.atan2(-hp.ux, -hp.uz);
      const pierLen = Math.min(76, Math.max(24, hp.reach + 7));
      const pierX = hp.rootX + hp.ux * (pierLen * 0.5 - 5.5);
      const pierZ = hp.rootZ + hp.uz * (pierLen * 0.5 - 5.5);
      const quayW = Math.min(38, Math.max(20, hp.reach * 0.55));
      const quayX = hp.rootX - hp.ux * 2.5;
      const quayZ = hp.rootZ - hp.uz * 2.5;
      const rootGroundY = Math.max(1.2, Math.min(2.8, terrainSurfaceSample(heights, hp.rootX, hp.rootZ, region)));
      instances.push({
        prefabId: 'stone_quay_seawall',
        label: quayPrefab.label,
        x: quayX,
        y: rootGroundY,
        z: quayZ,
        yaw: pierYaw,
        length: 11,
        width: quayW,
        height: 1.4,
        foundationDepth: 5.5,
        materialKind: quayPrefab.materialKind,
        roofPitch: 0,
        waterfront: true,
        fromOrthophotoFootprint: true,
      });
      instances.push({
        prefabId: 'timber_mole_pier',
        label: pierPrefab.label,
        x: pierX,
        y: rootGroundY - 0.15,
        z: pierZ,
        yaw: pierYaw,
        length: pierLen,
        width: pierPrefab.width,
        height: 1.4,
        foundationDepth: pierPrefab.foundationDepth,
        materialKind: pierPrefab.materialKind,
        roofPitch: 0,
        waterfront: true,
        fromOrthophotoFootprint: true,
      });
    }
  } else {
    const pierTipPos = worldFromCoastalFrame(region, bestShoreAlong, bestShoreInland - 32);
    if (terrainSample(heights, pierTipPos.x, pierTipPos.z, region) <= -0.5) {
      addPrefab('timber_mole_pier', 0, -24, 0, 2.2);
    }
  }

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

    // 1 Footprint Rectangle = 1 Single 3D Building classified by footprint topology & material class
    let warehouseAssigned = false;
    let arsenalAssigned = false;
    let lonjaAssigned = false;
    let corralAssigned = false;
    const maxOrthoBuildings = 32;
    for (let i = 0; i < fps.length && i < maxOrthoBuildings; i++) {
      const fp = fps[i];
      const aspect = fp.length / Math.max(1, fp.width);
      const rClass = fp.roofClass ?? 1;
      const holeR = fp.holeRatio ?? (fp.width >= 21 && aspect <= 1.55 ? 0.38 : 0.08);
      const fillR = fp.fillRatio ?? 0.78;
      let prefabId = fp.prefabId || null;

      if (!prefabId || (fps.length > 4 && prefabId === 'colonial_town_block')) {
        if (!fp.prefabId && i === bastionIdx) {
          prefabId = rClass === 3 && fp.width >= 26 ? 'bastion_trace_fortress' : 'stone_sea_bastion';
        } else if (!fp.prefabId && i === casaIdx) {
          prefabId = 'casa_de_contratacion';
        } else if (!fp.prefabId && i === chapelIdx) {
          prefabId = 'mission_chapel';
        } else if (rClass === 2) {
          prefabId = 'thatched_bohio_palafito';
        } else if (rClass === 3) {
          if (fp.width <= 16.5 && fp.length <= 18.5) prefabId = 'torreon_atalaya_farol';
          else if (aspect >= 2.2 && fp.y <= 3.0) prefabId = 'stone_arch_bridge';
          else if (aspect >= 2.4) prefabId = 'curtain_wall_and_gate';
          else prefabId = 'bastion_trace_fortress';
        } else if (!arsenalAssigned && fp.width >= 21 && fp.length >= 25 && holeR < 0.24 && fp.inlandM < 135) {
          prefabId = 'royal_atarazanas_arsenal';
          arsenalAssigned = true;
        } else if (!lonjaAssigned && fp.width <= 16.5 && fp.length >= 19 && fp.inlandM < 98) {
          prefabId = 'open_lonja_loggia';
          lonjaAssigned = true;
        } else if (!warehouseAssigned && fp.inlandM < 120 && aspect >= 1.55) {
          prefabId = 'royal_warehouse';
          warehouseAssigned = true;
        } else if (!corralAssigned && fp.width >= 23 && holeR >= 0.48) {
          prefabId = 'walled_mule_corral';
          corralAssigned = true;
        } else if (fp.width <= 13.2 || (aspect >= 1.78 && holeR < 0.22)) {
          prefabId = 'single_nave_solar';
        } else if (fp.width < 20.2 || (fillR < 0.72 && holeR < 0.42)) {
          prefabId = 'l_wing_u_wing_solar';
        } else {
          prefabId = 'modular_patio_cloister';
        }
      }

      const prefab = PORT_PREFABS[prefabId] || PORT_PREFABS.colonial_town_block;
      const isFort = prefabId === 'stone_sea_bastion' || prefabId === 'bastion_trace_fortress';
      const maxW = isFort ? 44 : prefabId === 'mission_chapel' ? 28 : 38;
      const maxL = isFort ? 48 : prefabId === 'mission_chapel' ? 42 : 44;
      const minW = prefabId === 'curtain_wall_and_gate' || prefabId === 'stone_arch_bridge' ? 6.0 : 7.5;
      const scaleW = Math.min(maxW, Math.max(minW, fp.width));
      const scaleL = Math.min(maxL, Math.max(10, fp.length));

      // True 16th-century human & tree scale (7.6m–10.8m eave/parapet height vs 18m–24m mature tropical forest trees)
      const heightVar = (i % 3) * 0.45;
      const trueHeight =
        prefabId === 'mission_chapel' || prefabId === 'torreon_atalaya_farol'
          ? 10.2
          : isFort
            ? 9.8
            : prefabId === 'casa_de_contratacion' || prefabId === 'royal_atarazanas_arsenal'
              ? 9.4
              : 7.8 + heightVar;
      const truePitch =
        prefabId === 'mission_chapel'
          ? 3.2
          : prefabId === 'thatched_bohio_palafito'
            ? 3.0
            : prefabId === 'casa_de_contratacion'
              ? 2.8
              : isFort
                ? 2.2
                : 2.4;

      const groundY = terrainSurfaceSample(heights, fp.x, fp.z, region);
      const y = Math.max(2.2, groundY);

      instances.push({
        prefabId,
        label: prefab.label,
        x: fp.x,
        y,
        z: fp.z,
        yaw: fp.yaw,
        length: scaleL,
        width: scaleW,
        height: trueHeight,
        foundationDepth: Math.max(prefab.foundationDepth, 6.0),
        materialKind: prefab.materialKind,
        roofPitch: truePitch,
        waterfront: prefab.waterfront,
        fromOrthophotoFootprint: true,
      });
    }
  } else {
    // 2. Continuous Stone Seawall & Wharf (Malecón) along the harbor edge
    addPrefab('stone_quay_seawall', 4, 8, 0, 2.4);
    // 3. Careening shed & Astillero slipway with skeletal caravel hull on the sheltered foreshore
    addPrefab('careening_shed', -75, 16, 12, 2.2);
    addPrefab('astillero_and_moored_hull', -52, 12, 6, 1.8);
    // 4. Sea bastion (Castillo) & Star-Bastioned Fort / Watchtower guarding the harbor entrance headlands
    addPrefab('stone_sea_bastion', 110, 10, -15, 4.6);
    addPrefab('bastion_trace_fortress', -112, 14, 14, 4.2);
    addPrefab('torreon_atalaya_farol', 132, -8, 0, 4.8);
    // 5. Casa de la Contratación (Customhouse) & Open Market Loggia (Lonja) facing the waterfront plaza
    addPrefab('casa_de_contratacion', 0, 44, 0, 3.2);
    addPrefab('open_lonja_loggia', -24, 24, 90, 2.8);
    // 6. Almacén Real (Royal Warehouse) & Multi-Gable Reales Atarazanas Arsenal beside the customhouse
    addPrefab('royal_warehouse', 46, 48, 0, 3.2);
    addPrefab('royal_atarazanas_arsenal', 78, 36, 0, 3.0);
    // 7. Mission Chapel & Bell Tower on the upper plaza
    addPrefab('mission_chapel', -38, 82, 90, 3.8);
    // 8. Bay-Iterated Courtyard Cloisters, L/U-Wing Solares, Single-Nave Row Houses & Walled Corral
    addPrefab('colonial_town_block', 28, 88, 0, 3.8);
    addPrefab('colonial_town_block', -44, 48, 0, 3.2);
    addPrefab('modular_patio_cloister', -4, 88, 0, 3.8);
    addPrefab('l_wing_u_wing_solar', 60, 84, 90, 3.6);
    addPrefab('single_nave_solar', -74, 52, 0, 3.2);
    addPrefab('walled_mule_corral', 22, 122, 0, 4.0);
    // 9. City Curtain Wall & Gatehouse, Cutwater Stone Arch Bridge & Frontier Palm-Thatch Bohíos
    addPrefab('curtain_wall_and_gate', -36, 118, 90, 4.0);
    addPrefab('stone_arch_bridge', -98, 38, 18, 2.2);
    addPrefab('thatched_bohio_palafito', -94, 18, -12, 2.0);
  }

  for (const inst of instances) {
    inst._cosNegYaw = Math.cos(-inst.yaw);
    inst._sinNegYaw = Math.sin(-inst.yaw);
    inst._boundR = Math.hypot(inst.width, inst.length) * 0.5;
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
  if (portPlacement.center) {
    const cdx = x - portPlacement.center.x;
    const cdz = z - portPlacement.center.z;
    const maxClusterR = 620 + hullRadius;
    if (cdx * cdx + cdz * cdz > maxClusterR * maxClusterR) return true;
  }
  for (const inst of portPlacement.instances) {
    const dx = x - inst.x;
    const dz = z - inst.z;
    const rBound = (inst._boundR ?? Math.hypot(inst.width, inst.length) * 0.5) + hullRadius;
    if (dx * dx + dz * dz > rBound * rBound) continue;
    const c = inst._cosNegYaw ?? Math.cos(-inst.yaw);
    const s = inst._sinNegYaw ?? Math.sin(-inst.yaw);
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
      groups: [],
      partAssembly: null,
      instanceCount: 0,
      triangleCount: 0,
      bounds: { min: [0, 0, 0], max: [0, 0, 0] },
    };
  }
  const verts = [];
  const indices = [];
  const groups = [];
  const bounds = {
    min: [Infinity, Infinity, Infinity],
    max: [-Infinity, -Infinity, -Infinity],
  };

  let activeInstTag = '';
  let activePrefabId = '';
  let activeInstIndex = 0;
  let partGroupDepth = 0;
  let sectionStart = 0;
  let currentSectionKey = null;
  const instPartCounters = new Map();

  const nextPartId = (baseKey) => {
    const count = instPartCounters.get(baseKey) ?? 0;
    instPartCounters.set(baseKey, count + 1);
    const numberedKey = count === 0 ? baseKey : `${baseKey}_${count}`;
    return {
      id: activeInstTag ? `${activeInstTag}:${numberedKey}` : numberedKey,
      partKey: baseKey,
    };
  };

  const flushSection = () => {
    if (currentSectionKey && indices.length > sectionStart) {
      const { id, partKey } = nextPartId(currentSectionKey);
      groups.push({
        id,
        prefabId: activePrefabId,
        instanceIndex: activeInstIndex,
        partKey,
        firstIndex: sectionStart,
        indexCount: indices.length - sectionStart,
      });
    }
    sectionStart = indices.length;
  };

  const beginSection = (partKey) => {
    flushSection();
    currentSectionKey = partKey;
  };

  const withPartGroup = (baseKey, fn) => {
    if (partGroupDepth === 0) {
      flushSection();
    }
    const firstIndex = indices.length;
    const { id, partKey } = nextPartId(baseKey);
    partGroupDepth++;
    fn();
    partGroupDepth--;
    const indexCount = indices.length - firstIndex;
    if (indexCount > 0) {
      groups.push({
        id,
        prefabId: activePrefabId,
        instanceIndex: activeInstIndex,
        partKey,
        firstIndex,
        indexCount,
      });
    }
    if (partGroupDepth === 0) {
      sectionStart = indices.length;
    }
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

  // Stamp a reconstructed 3D building mesh into world coordinates with zero per-vertex array allocations
  const emitLRMMesh = (instX, instZ, tmpl, widthX, y0, y1, lengthZ, cosY, sinY) =>
    withPartGroup('lrm_superstructure', () => {
      const baseVertex = verts.length / 8;
      const spanY = Math.max(1.0, y1 - y0);
      const invW = 1 / Math.max(1, widthX);
      const invY = 1 / spanY;
      const invL = 1 / Math.max(1, lengthZ);
      const vArr = tmpl.vertices;
      const vCount = tmpl.vertexCount;
      for (let v = 0; v < vCount; v++) {
        const off = v * 8;
        const lx = vArr[off] * widthX;
        const py = y0 + vArr[off + 1] * spanY;
        const lz = vArr[off + 2] * lengthZ;
        const px = instX + lx * cosY + lz * sinY;
        const pz = instZ - lx * sinY + lz * cosY;
        const lnx = vArr[off + 3] * invW;
        const lny = vArr[off + 4] * invY;
        const lnz = vArr[off + 5] * invL;
        let wx = lnx * cosY + lnz * sinY;
        let wy = lny;
        let wz = -lnx * sinY + lnz * cosY;
        const nLen = Math.hypot(wx, wy, wz) || 1;
        wx /= nLen; wy /= nLen; wz /= nLen;
        verts.push(px, py, pz, wx, wy, wz, vArr[off + 6], vArr[off + 7]);
        if (px < bounds.min[0]) bounds.min[0] = px;
        if (px > bounds.max[0]) bounds.max[0] = px;
        if (py < bounds.min[1]) bounds.min[1] = py;
        if (py > bounds.max[1]) bounds.max[1] = py;
        if (pz < bounds.min[2]) bounds.min[2] = pz;
        if (pz > bounds.max[2]) bounds.max[2] = pz;
      }
      const iArr = tmpl.indices;
      for (let i = 0; i < iArr.length; i++) {
        indices.push(baseVertex + iArr[i]);
      }
    });

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
  const emitStoneArchZ = (toWorld, xFace, depthSign, yFloor, ySpring, radius, zCenter, archSegs = 6) =>
    withPartGroup('stone_arch', () => {
      const xOut = xFace + depthSign * 0.14;
      const xIn = xFace - depthSign * 0.55;
      // Recessed dark barrel-vaulted interior opening (kind 14)
      withPartGroup('arch_vault', () => {
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
      });
      // Stone jamb piers flanking the arch
      const jambW = 0.34;
      withPartGroup('arch_jambs', () => {
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
      });
      // Radial stone voussoir arch ring (kind 11)
      withPartGroup('arch_voussoirs', () => {
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
      });
    });

  // Helper to emit a cantilevered Spanish Colonial timber balcony with corbel brackets & open wooden balusters (kind 10)
  const emitBalustradeZ = (toWorld, xWall, outSign, yFloor, z0, z1) =>
    withPartGroup('balcony_balustrade', () => {
      const xOuter = xWall + outSign * 1.15;
      const xMin = Math.min(xWall, xOuter), xMax = Math.max(xWall, xOuter);
      // Planked balcony floor deck
      withPartGroup('balcony_deck_slab', () => {
        emitBox(toWorld, xMin, xMax, yFloor - 0.18, yFloor, z0, z1, 10, 0.78, true);
      });
      // Top & bottom balustrade rails
      const rMin = Math.min(xOuter - outSign * 0.14, xOuter), rMax = Math.max(xOuter - outSign * 0.14, xOuter);
      withPartGroup('balcony_rails', () => {
        emitBox(toWorld, rMin, rMax, yFloor + 0.88, yFloor + 1.02, z0, z1, 10, 0.82, true);
        emitBox(toWorld, rMin, rMax, yFloor, yFloor + 0.12, z0, z1, 10, 0.74);
      });
      // Carved timber floor corbels (ménsulas) & vertical wooden balusters
      withPartGroup('balcony_balusters', () => {
        const spanZ = z1 - z0;
        const postCount = Math.max(4, Math.floor(spanZ / 1.15));
        for (let p = 0; p <= postCount; p++) {
          const pz = z0 + (p / postCount) * spanZ;
          emitBox(toWorld, rMin, rMax, yFloor + 0.12, yFloor + 0.88, pz - 0.06, pz + 0.06, 10, 0.75);
          if (p % 2 === 0) {
            emitBox(toWorld, xMin, xMax, yFloor - 0.46, yFloor - 0.18, pz - 0.09, pz + 0.09, 10, 0.68, true);
          }
        }
      });
    });

  // Helper to emit an overhanging gabled or hipped roof (kind 13 terracotta or kind 15 palm thatch) with timber rafter tails (kind 10) & ridge cap
  const emitRoof = (toWorld, x0, x1, yEave, yPeak, z0, z1, overhang = 0.65, hipRatio = 0.25, wallKind = 12, roofKind = 13) =>
    withPartGroup('roof_assembly', () => {
      const rx0 = x0 - overhang, rx1 = x1 + overhang;
      const rz0 = z0 - overhang, rz1 = z1 + overhang;
      const fasciaH = 0.24;
      // Timber fascia / eaves skirt
      withPartGroup('roof_eaves_fascia', () => {
        emitBox(toWorld, rx0, rx1, yEave - fasciaH, yEave, rz0, rz1, 10, 0.72, true);
      });
      // Projecting Spanish timber rafter tails (canecillos) under the eaves, iterated every 1.6m
      const rafterCount = Math.max(4, Math.round((z1 - z0) / 1.6));
      withPartGroup('roof_rafters', () => {
        for (let r = 0; r <= rafterCount; r++) {
          const rz = z0 + (r / rafterCount) * (z1 - z0);
          emitBox(toWorld, rx0 - 0.12, x0 + 0.1, yEave - fasciaH - 0.14, yEave - 0.04, rz - 0.08, rz + 0.08, 10, 0.66, true);
          emitBox(toWorld, x1 - 0.1, rx1 + 0.12, yEave - fasciaH - 0.14, yEave - 0.04, rz - 0.08, rz + 0.08, 10, 0.66, true);
        }
      });
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

      withPartGroup('roof_slopes', () => {
        if (hipRatio > 0.02) {
          // Hipped roof: 2 side trapezoids + 2 end hip triangles
          pushQuad(e01, e00, r0, r1, roofKind, 0.94);
          pushQuad(e10, e11, r1, r0, roofKind, 0.88);
          pushTri(e00, e10, r0, roofKind, 0.90);
          pushTri(e11, e01, r1, roofKind, 0.91);
        } else {
          // Gable roof + masonry gable end triangles
          pushQuad(e01, e00, r0, r1, roofKind, 0.94);
          pushQuad(e10, e11, r1, r0, roofKind, 0.88);
          const g00 = toWorld(x0, yEave, z0), g10 = toWorld(x1, yEave, z0), gr0 = toWorld(midX, yPeak - 0.08, z0);
          const g01 = toWorld(x0, yEave, z1), g11 = toWorld(x1, yEave, z1), gr1 = toWorld(midX, yPeak - 0.08, z1);
          pushTri(g00, g10, gr0, wallKind, 0.84);
          pushTri(g11, g01, gr1, wallKind, 0.84);
        }
      });
      // Raised ridge tile / thatch ridge pole cap (caballete)
      if (zHip1 > zHip0 + 0.4) {
        withPartGroup('roof_ridge_cap', () => {
          const capKind = roofKind === 15 ? 10 : roofKind;
          emitBox(toWorld, midX - 0.22, midX + 0.22, yPeak - 0.08, yPeak + 0.18, zHip0, zHip1, capKind, 0.96, false, 0.06);
        });
      }
    });

  // Right-handed +90° rotation in local XZ (det = +1) so X-aligned wings/arches/balconies reuse Z helpers with outward normals intact
  const rot90 = (toWorld) => (lx, ly, lz) => toWorld(lz, ly, -lx);
  const emitStoneArchX = (toWorld, zFace, depthSign, yFloor, ySpring, radius, xCenter, archSegs = 6) =>
    emitStoneArchZ(rot90(toWorld), -zFace, -depthSign, yFloor, ySpring, radius, xCenter, archSegs);
  const emitBalustradeX = (toWorld, zWall, outSign, yFloor, x0, x1) =>
    emitBalustradeZ(rot90(toWorld), -zWall, -outSign, yFloor, x0, x1);
  const emitRoofX = (toWorld, x0, x1, yEave, yPeak, z0, z1, overhang = 0.65, hipRatio = 0.25, wallKind = 12, roofKind = 13) =>
    emitRoof(rot90(toWorld), -z1, -z0, yEave, yPeak, x0, x1, overhang, hipRatio, wallKind, roofKind);

  // Horizontal Bay Iteration constants & helpers (never stretch features; repeat bays with constant cross-sections!)
  const WING_DEPTH = 5.8; // Standard 1550 Spanish single-bay beam span (~20 pies castellanos)
  const ROOF_TAN = 0.42; // Constant 23° barrel-tile roof pitch slope
  const roofRise = (spanW, tanSlope = ROOF_TAN) => Math.max(1.15, (spanW * 0.5) * tanSlope);
  const snapBays = (span, nominalBay, minBays = 2) => Math.max(minBays, Math.round(span / nominalBay));

  // Helper to emit a single iterated ~3.8m Spanish colonial window & upper balcony-door bay along a Z-running wall
  const emitFacadeBayZ = (toWorld, xWall, outSign, yPlinth, yMid, yTop, bz, hasUpper = true) =>
    withPartGroup('facade_bay', () => {
      const xIn = Math.min(xWall - outSign * 0.08, xWall + outSign * 0.14);
      const xOut = Math.max(xWall - outSign * 0.08, xWall + outSign * 0.14);
      const xRejaMin = Math.min(xWall, xWall + outSign * 0.24);
      const xRejaMax = Math.max(xWall, xWall + outSign * 0.24);
      // Ground-floor recessed window opening (kind 14) + projecting wooden spindle grille (reja, kind 10) + stone sill
      withPartGroup('facade_window_reja', () => {
        emitBox(toWorld, xIn, xOut, yPlinth + 0.78, Math.min(yMid - 0.32, yPlinth + 2.45), bz - 0.56, bz + 0.56, 14, 0.34);
        emitBox(toWorld, xRejaMin, xRejaMax, yPlinth + 0.68, Math.min(yMid - 0.22, yPlinth + 2.55), bz - 0.66, bz + 0.66, 10, 0.72, true);
        emitBox(toWorld, xRejaMin - 0.04, xRejaMax + 0.04, yPlinth + 0.54, yPlinth + 0.68, bz - 0.74, bz + 0.74, 11, 0.86, true);
      });
      if (hasUpper && yTop - yMid >= 2.2) {
        // Upper-story shuttered balcony window/door (kind 14) + molded stone lintel pediment (kind 11)
        withPartGroup('facade_upper_window', () => {
          emitBox(toWorld, xIn, xOut, yMid + 0.24, yTop - 0.58, bz - 0.58, bz + 0.58, 14, 0.34);
          emitBox(toWorld, xRejaMin, xRejaMax, yTop - 0.58, yTop - 0.36, bz - 0.74, bz + 0.74, 11, 0.88, true);
        });
      }
    });
  const emitFacadeBayX = (toWorld, zWall, outSign, yPlinth, yMid, yTop, bx, hasUpper = true) =>
    emitFacadeBayZ(rot90(toWorld), -zWall, -outSign, yPlinth, yMid, yTop, bx, hasUpper);

  // Helper to emit alternating tooth-stone ashlar corner quoins (esquinales de sillería) at the 4 corners of a wing
  const emitCornerQuoins = (toWorld, x0, x1, y0, y1, z0, z1, courses = 5) =>
    withPartGroup('corner_quoins', () => {
      const hSpan = Math.max(1.5, y1 - y0);
      for (const [qx, sx] of [[x0, -1], [x1, 1]]) {
        for (const [qz, sz] of [[z0, -1], [z1, 1]]) {
          for (let q = 0; q < courses; q++) {
            const qy0 = y0 + (q / courses) * hSpan;
            const qy1 = qy0 + hSpan / courses - 0.06;
            const qLong = q % 2 === 0 ? 0.68 : 0.42;
            const qShort = q % 2 === 0 ? 0.42 : 0.68;
            emitBox(
              toWorld,
              sx < 0 ? qx - 0.08 : qx - qLong,
              sx < 0 ? qx + qLong : qx + 0.08,
              qy0,
              qy1,
              sz < 0 ? qz - 0.08 : qz - qShort,
              sz < 0 ? qz + qShort : qz + 0.08,
              11,
              0.85
            );
          }
        }
      }
    });

  for (let instIdx = 0; instIdx < portPlacement.instances.length; instIdx++) {
    const inst = portPlacement.instances[instIdx];
    activeInstIndex = instIdx;
    activePrefabId = inst.prefabId ?? 'colonial_town_block';
    activeInstTag = portPlacement.singleBuildingPrefab
      ? activePrefabId
      : (inst.id ?? `${activePrefabId}_${instIdx}`);
    instPartCounters.clear();
    currentSectionKey = null;
    sectionStart = indices.length;

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

    // Only use static LRM template mesh if the instance is at canonical unstretched prefab dimensions (never stretch footprints!)
    const basePrefab = PORT_PREFABS[inst.prefabId];
    const isUnstretchedCanonical =
      !inst.fromOrthophotoFootprint &&
      basePrefab &&
      Math.abs(inst.width - basePrefab.width) < 0.6 &&
      Math.abs(inst.length - basePrefab.length) < 0.6 &&
      (inst.prefabId === 'mission_chapel' || inst.prefabId === 'casa_de_contratacion');
    const lrmTmpl = isUnstretchedCanonical ? lrmTemplates?.[inst.prefabId] : null;
    if (lrmTmpl) {
      beginSection('foundation_plinth');
      const yPlinth = yGround + 0.65;
      emitBox(toWorld, -hw - 0.55, hw + 0.55, yBase, yPlinth, -hl - 0.55, hl + 0.55, 11, 0.82);
      const peakExtra = inst.prefabId === 'mission_chapel' ? 9.2 : (inst.roofPitch ?? 2.6);
      const yPeak = yTop + peakExtra;
      emitLRMMesh(inst.x, inst.z, lrmTmpl, inst.width * 1.087, yPlinth - 0.18, yPeak, inst.length * 1.087, cosY, sinY);
      flushSection();
      continue;
    }

    if (inst.prefabId === 'timber_mole_pier') {
      // Open timber trestle pier: planked deck + side curbs + seabed pilings + cross-bracing + bollards + cargo crane
      const deckBottom = yTop - 0.55;
      beginSection('pier_deck_slab');
      emitBox(toWorld, -hw, hw, deckBottom, yTop, -hl, hl, 10, 0.86, true);
      // Side wheel-guard curbs
      beginSection('pier_wheel_curbs');
      emitBox(toWorld, -hw, -hw + 0.34, yTop, yTop + 0.28, -hl, hl, 10, 0.78);
      emitBox(toWorld, hw - 0.34, hw, yTop, yTop + 0.28, -hl, hl, 10, 0.78);
      // Longitudinal stringer beams under deck
      beginSection('pier_stringers');
      emitBox(toWorld, -hw + 0.55, -hw + 1.05, deckBottom - 0.55, deckBottom, -hl + 0.4, hl - 0.4, 10, 0.68, true);
      emitBox(toWorld, hw - 1.05, hw - 0.55, deckBottom - 0.55, deckBottom, -hl + 0.4, hl - 0.4, 10, 0.68, true);
      // Paired cylindrical timber pilings iterated every 4.8m + transverse cross-beam caps & mooring bollards
      const bays = snapBays(inst.length - 2.4, 4.8, 4);
      for (let b = 0; b <= bays; b++) {
        const z = -hl + 1.2 + (b / bays) * (inst.length - 2.4);
        beginSection('foundation_pilings');
        emitCylinder(toWorld, -hw + 0.48, z, yBase, yTop + 0.58, 0.26, 0.24, 6, 10, 0.66, true);
        emitCylinder(toWorld, hw - 0.48, z, yBase, yTop + 0.58, 0.26, 0.24, 6, 10, 0.66, true);
        beginSection('pier_cross_beams');
        emitBox(toWorld, -hw + 0.3, hw - 0.3, deckBottom - 0.95, deckBottom - 0.55, z - 0.18, z + 0.18, 10, 0.62, true);
        if (b % 2 === 0) {
          beginSection('mooring_bollards');
          emitCylinder(toWorld, -hw + 0.75, z, yTop + 0.28, yTop + 0.96, 0.22, 0.26, 6, 14, 0.45, true);
          emitCylinder(toWorld, hw - 0.75, z, yTop + 0.28, yTop + 0.96, 0.22, 0.26, 6, 14, 0.45, true);
        }
      }
      // Seaward pier-head stone plinth, iron cresset beacon tower & timber cargo derrick crane
      beginSection('pier_beacon_and_crane');
      emitBox(toWorld, -1.2, 1.2, yTop, yTop + 1.7, -hl + 0.6, -hl + 3.0, 11, 0.88);
      emitCylinder(toWorld, 0, -hl + 1.8, yTop + 1.7, yTop + 5.4, 0.24, 0.18, 6, 10, 0.72, true);
      emitCylinder(toWorld, 0, -hl + 1.8, yTop + 5.4, yTop + 6.2, 0.52, 0.68, 6, 14, 0.52, true);
      emitCylinder(toWorld, hw - 1.2, -hl * 0.35, yTop, yTop + 4.8, 0.32, 0.26, 6, 10, 0.76, true);
      emitBox(toWorld, hw - 1.4, hw + 2.2, yTop + 3.9, yTop + 4.35, -hl * 0.35 - 0.2, -hl * 0.35 + 0.2, 10, 0.74, true);
    } else if (inst.prefabId === 'stone_quay_seawall') {
      // Continuous Colonial Stone Seawall & Wharf (Malecón y Muelle de Piedra)
      const yCoping = yTop - 0.35;
      beginSection('foundation_seawall_scarp');
      emitBox(toWorld, -hw - 0.8, hw + 0.8, yBase, yCoping, -hl - 0.8, hl + 0.4, 11, 0.84, false, 0.6);
      beginSection('quay_coping_deck_slab');
      emitBox(toWorld, -hw, hw, yCoping, yTop, -hl, hl, 11, 0.92, true);
      const qs = Math.min(1, hw / 26);
      beginSection('quay_parapet_walls');
      emitBox(toWorld, -hw, -22 * qs, yTop, yTop + 0.65, -hl, -hl + 1.1, 11, 0.88);
      emitBox(toWorld, -15 * qs, -5.5 * qs, yTop, yTop + 0.65, -hl, -hl + 1.1, 11, 0.88);
      emitBox(toWorld, 5.5 * qs, 15 * qs, yTop, yTop + 0.65, -hl, -hl + 1.1, 11, 0.88);
      emitBox(toWorld, 22 * qs, hw, yTop, yTop + 0.65, -hl, -hl + 1.1, 11, 0.88);
      beginSection('quay_landing_steps');
      for (const stairX of [-18.5 * qs, 18.5 * qs]) {
        for (let stepIdx = 0; stepIdx < 5; stepIdx++) {
          const sy1 = yTop - stepIdx * 0.42;
          const sy0 = sy1 - 0.45;
          const sz0 = -hl - 0.4 - stepIdx * 0.45;
          emitBox(toWorld, stairX - 3.2 * qs, stairX + 3.2 * qs, sy0, sy1, sz0, -hl + 1.2, 11, 0.78 - stepIdx * 0.04);
        }
      }
      beginSection('mooring_bollards');
      const bStep = Math.max(6, 14 * qs);
      for (let bx = -hw + 4 * qs; bx <= hw - 4 * qs; bx += bStep) {
        if (Math.abs(bx) < 5 * qs || (Math.abs(bx) > 14 * qs && Math.abs(bx) < 23 * qs)) continue;
        emitCylinder(toWorld, bx, -hl + 0.6, yTop + 0.65, yTop + 1.38, 0.34, 0.38, 6, 14, 0.42, true);
      }
    } else if (inst.prefabId === 'stone_sea_bastion' || inst.prefabId === 'bastion_trace_fortress') {
      // 16th-Century Spanish Bastion & Star-Bastioned Trace-Italienne Fortress (Baluarte / Fuerte Abaluartado con Foso y Polvorín):
      // Battered ashlar/coquina scarp walls + projecting diamond corner bastions (on bastion_trace_fortress) + iterated cannon embrasures
      // + 4 corbeled domed sentry garitas + packed-earth terreplein + internal bay-iterated barracks & circular domed polvorín
      const isStarFort = inst.prefabId === 'bastion_trace_fortress';
      const yCordon = yTop - 1.5;
      beginSection('foundation_scarp_walls');
      emitBox(toWorld, -hw - 1.6, hw + 1.6, yBase, yCordon, -hl - 1.6, hl + 1.6, 11, 0.84, false, 1.6);
      beginSection('scarp_cordon_cornice');
      emitBox(toWorld, -hw - 0.42, hw + 0.42, yCordon, yCordon + 0.46, -hl - 0.42, hl + 0.42, 11, 0.93, true);
      // Packed-earth / cobble terreplein gun deck (kind 16)
      beginSection('terreplein_gun_deck');
      emitBox(toWorld, -hw, hw, yCordon + 0.46, yTop - 0.85, -hl, hl, 16, 0.82);

      // If star-bastioned trace fort (St. Augustine / San Juan de Ulúa), emit 4 projecting corner bastions & seaward V-ravelin
      const bOut = isStarFort ? 4.2 : 0.0;
      if (isStarFort) {
        for (const sx of [-1, 1]) {
          for (const sz of [-1, 1]) {
            beginSection('corner_bastion');
            const bx0 = sx < 0 ? -hw - bOut : hw - 3.6;
            const bx1 = sx < 0 ? -hw + 3.6 : hw + bOut;
            const bz0 = sz < 0 ? -hl - bOut : hl - 3.6;
            const bz1 = sz < 0 ? -hl + 3.6 : hl + bOut;
            emitBox(toWorld, bx0 - 0.9, bx1 + 0.9, yBase, yCordon, bz0 - 0.9, bz1 + 0.9, 11, 0.83, false, 0.95);
            emitBox(toWorld, bx0 - 0.25, bx1 + 0.25, yCordon, yCordon + 0.44, bz0 - 0.25, bz1 + 0.25, 11, 0.92, true);
            emitBox(toWorld, bx0, bx1, yCordon + 0.44, yTop + 0.65, bz0, bz1, 11, 0.86);
            emitBox(toWorld, bx0 + 1.1, bx1 - 1.1, yCordon + 0.48, yTop - 0.35, bz0 + 1.1, bz1 - 1.1, 16, 0.80);
          }
        }
        // Detached V-shaped seaward ravelin (revellín) + timber drawbridge spanning the moat
        beginSection('seaward_ravelin_and_drawbridge');
        const rZ0 = -hl - bOut - 7.8, rZ1 = -hl - bOut - 1.8;
        emitBox(toWorld, -6.5, 6.5, yBase, yCordon - 1.2, rZ0, rZ1, 11, 0.82, false, 0.8);
        emitBox(toWorld, -5.6, 5.6, yCordon - 1.2, yCordon + 0.2, rZ0 + 0.5, rZ1, 11, 0.88);
        emitBox(toWorld, -1.6, 1.6, yCordon - 0.6, yCordon - 0.15, rZ1, -hl, 10, 0.76, true);
      }

      // Perimeter crenellated parapet walls iterating 4.6m cannon embrasure bays along X and Z
      const wallT = 1.75;
      const merlonY = yTop + 0.92;
      const nBaysX = snapBays(inst.width - 3.2, 4.6, 3);
      const baySpanX = (inst.width - 3.2) / nBaysX;
      for (const sideZ of [-1, 1]) {
        const zOut = sideZ < 0 ? -hl : hl - wallT;
        const zIn = sideZ < 0 ? -hl + wallT : hl;
        beginSection('parapet_wall');
        emitBox(toWorld, -hw, hw, yTop - 0.85, yTop, zOut, zIn, 11, 0.86);
        for (let m = 0; m <= nBaysX; m++) {
          const mx = -hw + 1.6 + m * baySpanX;
          beginSection('parapet_merlons');
          emitBox(toWorld, mx - 1.35, mx + 1.35, yTop, merlonY, zOut, zIn, 11, 0.90, false, 0.12);
          if (m < nBaysX) {
            beginSection('cannon_embrasure');
            const ex = mx + baySpanX * 0.5;
            const cZ = sideZ < 0 ? zIn + 0.4 : zOut - 0.4;
            emitBox(toWorld, ex - 0.50, ex + 0.50, yTop - 0.82, yTop + 0.08, cZ - 0.72, cZ + 0.72, 10, 0.72);
            emitBox(toWorld, ex - 0.54, ex + 0.54, yTop - 0.25, yTop + 0.35, zOut - 0.08, zIn + 0.08, 14, 0.35);
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
      const nBaysZ = snapBays(inst.length - 3.2, 4.8, 3);
      const baySpanZ = (inst.length - 3.2) / nBaysZ;
      for (const sideX of [-1, 1]) {
        const xOut = sideX < 0 ? -hw : hw - wallT;
        const xIn = sideX < 0 ? -hw + wallT : hw;
        beginSection('parapet_wall');
        emitBox(toWorld, xOut, xIn, yTop - 0.85, yTop, -hl + wallT, hl - wallT, 11, 0.84);
        for (let m = 0; m <= nBaysZ; m++) {
          const mz = -hl + 1.6 + m * baySpanZ;
          beginSection('parapet_merlons');
          emitBox(toWorld, xOut, xIn, yTop, merlonY, mz - 1.45, mz + 1.45, 11, 0.88, false, 0.12);
        }
      }
      // 4 Corner Cylindrical Bartizan Sentry Turrets (Garitas) with inverted-cone corbels & stone cupolas
      for (const sx of [-1, 1]) {
        for (const sz of [-1, 1]) {
          beginSection('sentry_garita');
          const gx = sx * (hw + bOut + 0.35), gz = sz * (hl + bOut + 0.35);
          emitCylinder(toWorld, gx, gz, yCordon - 1.4, yCordon + 0.35, 0.35, 1.48, 8, 11, 0.78, false);
          emitCylinder(toWorld, gx, gz, yCordon + 0.35, yCordon + 0.65, 1.58, 1.58, 8, 11, 0.92, true);
          emitCylinder(toWorld, gx, gz, yCordon + 0.65, merlonY + 1.65, 1.38, 1.38, 8, 11, 0.90, true);
          emitBox(toWorld, gx - 1.44, gx + 1.44, yCordon + 1.35, merlonY + 1.05, gz - 0.22, gz + 0.22, 14, 0.30);
          emitBox(toWorld, gx - 0.22, gx + 0.22, yCordon + 1.35, merlonY + 1.05, gz - 1.44, gz + 1.44, 14, 0.30);
          emitCylinder(toWorld, gx, gz, merlonY + 1.65, merlonY + 1.88, 1.52, 1.52, 8, 11, 0.94, true);
          emitCylinder(toWorld, gx, gz, merlonY + 1.88, merlonY + 2.75, 1.42, 0.72, 8, 11, 0.95, false);
          emitCylinder(toWorld, gx, gz, merlonY + 2.75, merlonY + 3.25, 0.72, 0.14, 8, 11, 0.97, true);
        }
      }
      if (isStarFort) {
        // Star fort interior: 2 narrow single-nave tiled barracks along the flanks + circular domed stone Polvorín (Portobelo / St. Augustine)
        const barW = 4.8;
        const barL = Math.max(10.0, (hl - wallT - 2.6) * 1.4);
        const yBarEave = yTop + 3.2;
        const yBarPeak = yBarEave + roofRise(barW);
        for (const sideX of [-1, 1]) {
          const bx0 = sideX < 0 ? -hw + wallT + 1.2 : hw - wallT - 1.2 - barW;
          const bx1 = bx0 + barW;
          beginSection('interior_barracks');
          emitBox(toWorld, bx0, bx1, yTop - 0.85, yBarEave, -barL * 0.5, barL * 0.5, 12, 0.90);
          emitRoof(toWorld, bx0, bx1, yBarEave, yBarPeak, -barL * 0.5, barL * 0.5, 0.52, 0.22, 12);
        }
        // Circular domed stone powder magazine (Polvorín) in the rear corner of the parade
        const pR = Math.min(4.2, hw * 0.24);
        const pZ = hl * 0.32;
        beginSection('polvorin_magazine');
        emitCylinder(toWorld, 0, pZ, yTop - 0.85, yTop + 3.0, pR + 0.25, pR, 10, 11, 0.88, true);
        beginSection('polvorin_dome');
        emitCylinder(toWorld, 0, pZ, yTop + 3.0, yTop + 4.8, pR + 0.15, pR * 0.46, 10, 11, 0.93, false);
        emitCylinder(toWorld, 0, pZ, yTop + 4.8, yTop + 5.6, pR * 0.46, 0.18, 10, 11, 0.96, true);
      } else {
        // Headland Sea Bastion interior command keep / Gobernador's citadel with constant-pitch roof
        const kw = Math.min(6.4, hw * 0.46), kl = Math.min(8.5, hl * 0.48), yKeep = merlonY + 4.2;
        beginSection('citadel_keep');
        emitBox(toWorld, -kw - 0.35, kw + 0.35, yTop - 0.85, yTop + 0.65, -kl - 0.35, kl + 0.35, 11, 0.84);
        emitBox(toWorld, -kw, kw, yTop + 0.65, yKeep, -kl, kl, 12, 0.91);
        emitStoneArchZ(toWorld, -kw, -1, yTop + 0.65, yTop + 2.4, 1.15, 0, 6);
        emitRoof(toWorld, -kw, kw, yKeep, yKeep + roofRise(kw * 2), -kl, kl, 0.72, 0.26, 12);
      }
    } else if (inst.prefabId === 'casa_de_contratacion') {
      // Royal Customhouse (Casa de la Contratación): Bay-iterated radial stone voussoir waterfront loggia + 2nd-story cantilevered balcony
      const yPlinth = yGround + 0.85;
      beginSection('foundation_plinth');
      emitBox(toWorld, -hw - 0.85, hw + 0.85, yBase, yPlinth, -hl - 0.85, hl + 0.85, 11, 0.82);
      const loggiaD = 2.65;
      beginSection('customhouse_hall_walls');
      emitBox(toWorld, -hw, hw, yPlinth, yTop, -hl + loggiaD, hl, 12, 0.89);
      const yMid = yPlinth + (yTop - yPlinth) * 0.48;
      emitBox(toWorld, -hw, hw, yMid, yTop, -hl, -hl + loggiaD, 12, 0.91, true);
      emitBox(toWorld, -hw - 0.18, hw + 0.18, yMid - 0.22, yMid + 0.12, -hl - 0.18, hl + 0.18, 11, 0.88, true);
      emitCornerQuoins(toWorld, -hw, hw, yPlinth, yTop, -hl, hl, 6);
      // Iterate 4.2m stone arch bays along Z (never stretching arches into ellipses!)
      const bays = snapBays(inst.length - 1.6, 4.2, 3);
      const baySpan = (inst.length - 1.6) / bays;
      const archR = Math.min(1.32, baySpan * 0.36);
      for (let b = 0; b < bays; b++) {
        const bz = -hl + 0.8 + (b + 0.5) * baySpan;
        emitStoneArchZ(toWorld, -hw, -1, yPlinth, yPlinth + 2.05, archR, bz, 6);
        emitStoneArchZ(toWorld, hw, 1, yPlinth, yPlinth + 2.05, archR, bz, 6);
        emitFacadeBayZ(toWorld, -hw, -1, yPlinth, yMid, yTop, bz, true);
        emitFacadeBayZ(toWorld, hw, 1, yPlinth, yMid, yTop, bz, true);
      }
      // Iterate end-wall window bays along X
      const baysX = snapBays(inst.width - 1.6, 4.0, 2);
      const baySpanX = (inst.width - 1.6) / baysX;
      for (let bxIdx = 0; bxIdx < baysX; bxIdx++) {
        const bx = -hw + 0.8 + (bxIdx + 0.5) * baySpanX;
        emitFacadeBayX(toWorld, -hl, -1, yPlinth, yMid, yTop, bx, true);
        emitFacadeBayX(toWorld, hl, 1, yPlinth, yMid, yTop, bx, true);
      }
      emitBalustradeZ(toWorld, -hw, -1, yMid + 0.08, -hl + 0.8, hl - 0.8);
      emitBalustradeZ(toWorld, hw, 1, yMid + 0.08, -hl + 0.8, hl - 0.8);
      emitRoof(toWorld, -hw - 0.2, hw + 0.2, yTop, yTop + roofRise(Math.min(16, inst.width)), -hl - 0.2, hl + 0.2, 0.85, 0.22, 12);
    } else if (inst.prefabId === 'mission_chapel') {
      // 16th-century Spanish Colonial Iglesia, Stepped Espadaña Facade & 3-Stage Arched Campanario
      // Nave width is locked to authentic single-nave span (<= 14m) while buttress & clerestory bays iterate along Z
      const naveHW = Math.min(hw, 7.2);
      const yPlinth = yGround + 0.78;
      beginSection('foundation_plinth');
      emitBox(toWorld, -hw - 0.75, hw + 0.75, yBase, yPlinth, -hl - 0.75, hl + 0.75, 11, 0.82);
      beginSection('nave_walls');
      emitBox(toWorld, -naveHW, naveHW, yPlinth, yTop, -hl, hl, 12, 0.91);
      beginSection('apse_walls');
      emitCylinder(toWorld, 0, hl + 0.4, yPlinth, yTop - 1.1, naveHW * 0.62, naveHW * 0.62, 8, 12, 0.89, true);
      beginSection('apse_dome');
      emitCylinder(toWorld, 0, hl + 0.4, yTop - 1.1, yTop + 0.9, naveHW * 0.66, 0.18, 8, 13, 0.93, true);
      const nButtressBays = snapBays(inst.length - 2.4, 5.2, 4);
      const buttressSpan = (inst.length - 2.4) / nButtressBays;
      for (let b = 0; b <= nButtressBays; b++) {
        const bz = -hl + 1.2 + b * buttressSpan;
        beginSection('nave_buttresses');
        emitBox(toWorld, -naveHW - 0.82, -naveHW, yPlinth, yTop - 0.4, bz - 0.45, bz + 0.45, 11, 0.84, false, 0.18);
        emitBox(toWorld, naveHW, naveHW + 0.82, yPlinth, yTop - 0.4, bz - 0.45, bz + 0.45, 11, 0.84, false, 0.18);
        if (b < nButtressBays) {
          const wz = bz + buttressSpan * 0.5;
          emitStoneArchZ(toWorld, -naveHW, -1, yPlinth + 2.6, yTop - 2.2, 0.62, wz, 5);
          emitStoneArchZ(toWorld, naveHW, 1, yPlinth + 2.6, yTop - 2.2, 0.62, wz, 5);
        }
      }
      // West facade Plateresque carved stone portal frame, arched doorway, flanking pilasters & rose choir window
      beginSection('west_portal_and_rose_window');
      emitBox(toWorld, -2.85, 2.85, yPlinth, yPlinth + 6.4, -hl - 0.48, -hl, 11, 0.88);
      emitCylinder(toWorld, -2.35, -hl - 0.48, yPlinth, yPlinth + 5.8, 0.28, 0.24, 6, 11, 0.91, true);
      emitCylinder(toWorld, 2.35, -hl - 0.48, yPlinth, yPlinth + 5.8, 0.28, 0.24, 6, 11, 0.91, true);
      emitBox(toWorld, -3.1, 3.1, yPlinth + 5.8, yPlinth + 6.4, -hl - 0.65, -hl, 11, 0.92, true);
      emitBox(toWorld, -1.45, 1.45, yPlinth, yPlinth + 4.8, -hl - 0.56, -hl + 0.1, 14, 0.28);
      emitCylinder(toWorld, 0, -hl - 0.22, yPlinth + 7.2, yPlinth + 9.2, 1.15, 1.15, 8, 11, 0.88, true);
      emitBox(toWorld, -0.82, 0.82, yPlinth + 7.45, yPlinth + 8.95, -hl - 0.36, -hl + 0.08, 14, 0.32);
      const yPeak = yTop + roofRise(naveHW * 2, 0.48);
      beginSection('espadana_gable_wall');
      emitBox(toWorld, -naveHW * 0.72, naveHW * 0.72, yTop, yPeak - 0.6, -hl - 0.35, -hl + 0.35, 12, 0.92);
      emitBox(toWorld, -naveHW * 0.38, naveHW * 0.38, yPeak - 0.6, yPeak + 1.2, -hl - 0.35, -hl + 0.35, 11, 0.90);
      emitRoof(toWorld, -naveHW, naveHW, yTop, yPeak, -hl, hl, 0.78, 0.0, 12);
      // 3-Stage Spanish Colonial Bell Tower (Campanario)
      const tx0 = naveHW - 2.2, tx1 = naveHW + 2.8, tz0 = -hl - 1.3, tz1 = -hl + 3.7;
      const tmx = (tx0 + tx1) * 0.5, tmz = (tz0 + tz1) * 0.5;
      const yT1 = yTop + 2.8, yT2 = yT1 + 4.1, yT3 = yT2 + 3.4;
      beginSection('campanario_tower_walls');
      emitBox(toWorld, tx0, tx1, yPlinth, yT1, tz0, tz1, 12, 0.92);
      emitBox(toWorld, tx0 - 0.28, tx1 + 0.28, yT1 - 0.34, yT1, tz0 - 0.28, tz1 + 0.28, 11, 0.90, true);
      emitBox(toWorld, tx0 + 0.35, tx1 - 0.35, yT1, yT2, tz0 + 0.35, tz1 - 0.35, 12, 0.94);
      emitStoneArchZ(toWorld, tx1 - 0.35, 1, yT1 + 0.45, yT2 - 1.35, 0.78, tmz, 5);
      emitStoneArchZ(toWorld, tx0 + 0.35, -1, yT1 + 0.45, yT2 - 1.35, 0.78, tmz, 5);
      beginSection('campanario_bell_chamber');
      emitBox(toWorld, tmx - 0.72, tmx + 0.72, yT1 + 0.55, yT2 - 0.65, tz0 + 0.26, tz1 - 0.26, 14, 0.30);
      emitCylinder(toWorld, tmx, tmz, yT1 + 1.45, yT1 + 2.45, 0.58, 0.24, 8, 10, 0.76, true);
      emitBox(toWorld, tx0 + 0.12, tx1 - 0.12, yT2 - 0.32, yT2, tz0 + 0.12, tz1 - 0.12, 11, 0.91, true);
      beginSection('campanario_cupola_spire');
      emitCylinder(toWorld, tmx, tmz, yT2, yT3, 2.05, 0.22, 8, 13, 0.95, true);
      emitBox(toWorld, tmx - 0.08, tmx + 0.08, yT3, yT3 + 1.35, tmz - 0.08, tmz + 0.08, 14, 0.42);
      emitBox(toWorld, tmx - 0.48, tmx + 0.48, yT3 + 0.75, yT3 + 0.92, tmz - 0.08, tmz + 0.08, 14, 0.42);
    } else if (inst.prefabId === 'careening_shed') {
      // Open-sided timber boatyard pavilion on the beach (Atarazana / Carenero) iterating king-post roof trusses every 4.2m
      const yApron = yGround + 0.45;
      beginSection('foundation_apron');
      emitBox(toWorld, -hw - 0.6, hw + 0.6, yBase, yApron, -hl - 0.6, hl + 0.6, 10, 0.74);
      const cols = snapBays(inst.length - 2.0, 4.2, 4) + 1;
      for (let c = 0; c < cols; c++) {
        const cz = -hl + 1.0 + (c / (cols - 1)) * (inst.length - 2.0);
        beginSection('arcade_timber_columns');
        emitCylinder(toWorld, -hw + 0.58, cz, yApron, yTop, 0.28, 0.25, 6, 10, 0.78, true);
        emitCylinder(toWorld, hw - 0.58, cz, yApron, yTop, 0.28, 0.25, 6, 10, 0.78, true);
        beginSection('roof_kingpost_trusses');
        emitBox(toWorld, -hw + 0.2, hw - 0.2, yTop - 0.42, yTop, cz - 0.20, cz + 0.20, 10, 0.72, true);
        emitBox(toWorld, -0.18, 0.18, yTop, yTop + 1.85, cz - 0.18, cz + 0.18, 10, 0.70);
      }
      beginSection('pitch_furnace_and_capstan');
      emitBox(toWorld, -1.9, 1.9, yApron, yTop + 2.6, hl - 2.3, hl - 0.2, 11, 0.80, false, 0.48);
      emitCylinder(toWorld, 0, -hl + 2.6, yApron, yApron + 1.45, 0.68, 0.52, 8, 10, 0.76, true);
      emitBox(toWorld, -2.1, 2.1, yApron + 1.15, yApron + 1.32, -hl + 2.48, -hl + 2.72, 10, 0.82, true);
      emitRoof(toWorld, -hw, hw, yTop, yTop + roofRise(inst.width), -hl, hl, 0.78, 0.12, 10);
    } else if (inst.prefabId === 'royal_atarazanas_arsenal') {
      // Primitive #4: Reales Atarazanas / Almacenes de Naves Paralelas (Multi-Gable Parallel Vaulted Naval Arsenal)
      // Iterates K = round(W / 7.5m) parallel gabled masonry halls side-by-side (Seville / Veracruz / Havana)
      const yPlinth = yGround + 0.75;
      beginSection('foundation_plinth');
      emitBox(toWorld, -hw - 0.75, hw + 0.75, yBase, yPlinth, -hl - 0.75, hl + 0.75, 11, 0.82);
      const nGables = Math.max(2, Math.min(7, Math.round(inst.width / 7.5)));
      const naveW = inst.width / nGables;
      const navePeak = yTop + roofRise(naveW, 0.46);
      const nBaysZ = snapBays(inst.length - 2.0, 4.6, 4);
      const baySpanZ = (inst.length - 2.0) / nBaysZ;

      beginSection('arsenal_nave_walls');
      emitBox(toWorld, -hw, hw, yPlinth, yTop, -hl, hl, 12, 0.89);
      emitCornerQuoins(toWorld, -hw, hw, yPlinth, yTop, -hl, hl, 6);

      // Iterate parallel gabled roofs & seaward/landward stone arch ship/cargo portals for each nave
      for (let g = 0; g < nGables; g++) {
        const nx0 = -hw + g * naveW;
        const nx1 = nx0 + naveW;
        const nMidX = (nx0 + nx1) * 0.5;
        emitRoof(toWorld, nx0, nx1, yTop, navePeak, -hl, hl, 0.45, 0.0, 12);
        // Large arched shipway / cargo portal on both gable ends (-hl and +hl) + circular oculus window above
        const archR = Math.min(2.1, naveW * 0.32);
        emitStoneArchX(toWorld, -hl, -1, yPlinth, yPlinth + 2.8, archR, nMidX, 6);
        emitStoneArchX(toWorld, hl, 1, yPlinth, yPlinth + 2.8, archR, nMidX, 6);
        beginSection('facade_oculus_and_gutters');
        emitCylinder(toWorld, nMidX, -hl - 0.15, yTop - 1.4, yTop - 0.3, 0.58, 0.58, 6, 14, 0.32, true);
        emitCylinder(toWorld, nMidX, hl + 0.15, yTop - 1.4, yTop - 0.3, 0.58, 0.58, 6, 14, 0.32, true);
        if (g > 0) {
          // Shared valley gutter beam between adjacent parallel roofs
          emitBox(toWorld, nx0 - 0.24, nx0 + 0.24, yTop - 0.15, yTop + 0.18, -hl - 0.35, hl + 0.35, 11, 0.84, true);
        }
      }
      // Iterate exterior stepped masonry buttresses & side arched cargo bays along Z
      for (let b = 0; b <= nBaysZ; b++) {
        const bz = -hl + 1.0 + b * baySpanZ;
        beginSection('arsenal_buttresses');
        emitBox(toWorld, -hw - 0.65, -hw, yPlinth, yTop - 0.3, bz - 0.42, bz + 0.42, 11, 0.84, false, 0.16);
        emitBox(toWorld, hw, hw + 0.65, yPlinth, yTop - 0.3, bz - 0.42, bz + 0.42, 11, 0.84, false, 0.16);
        if (b < nBaysZ) {
          const pz = bz + baySpanZ * 0.5;
          emitStoneArchZ(toWorld, -hw, -1, yPlinth, yPlinth + 2.15, Math.min(1.18, baySpanZ * 0.32), pz, 6);
          emitStoneArchZ(toWorld, hw, 1, yPlinth, yPlinth + 2.15, Math.min(1.18, baySpanZ * 0.32), pz, 6);
        }
      }
    } else if (inst.prefabId === 'open_lonja_loggia') {
      // Primitive #5: Lonja de Mercaderes / Feria Porticada (Open-Sided Stone-Arched Waterfront Market Pavilion)
      const yPlinth = yGround + 0.85;
      beginSection('foundation_plinth');
      emitBox(toWorld, -hw - 0.85, hw + 0.85, yBase, yPlinth - 0.22, -hl - 0.85, hl + 0.85, 11, 0.82);
      emitBox(toWorld, -hw - 0.35, hw + 0.35, yPlinth - 0.22, yPlinth, -hl - 0.35, hl + 0.35, 16, 0.88, true);
      // Entablature frieze & cornice beam supported on iterated Tuscan stone columns & radial arches around all 4 sides
      const ySpring = yPlinth + (yTop - yPlinth) * 0.56;
      beginSection('lonja_entablature_walls');
      emitBox(toWorld, -hw, hw, ySpring + 1.15, yTop, -hl, hl, 11, 0.90, true);
      // Shadowed interior vault core recessed slightly behind the perimeter colonnade
      beginSection('interior_vault_core');
      emitBox(toWorld, -hw + 1.4, hw - 1.4, yPlinth, ySpring + 1.15, -hl + 1.4, hl - 1.4, 12, 0.78);

      const nBaysZ = snapBays(inst.length - 1.4, 4.0, 4);
      const baySpanZ = (inst.length - 1.4) / nBaysZ;
      const archRZ = Math.min(1.35, baySpanZ * 0.36);
      for (let b = 0; b <= nBaysZ; b++) {
        const cz = -hl + 0.7 + b * baySpanZ;
        beginSection('arcade_columns');
        emitCylinder(toWorld, -hw + 0.45, cz, yPlinth, ySpring + 1.15, 0.34, 0.30, 8, 11, 0.91, true);
        emitCylinder(toWorld, hw - 0.45, cz, yPlinth, ySpring + 1.15, 0.34, 0.30, 8, 11, 0.91, true);
        if (b < nBaysZ) {
          const bz = cz + baySpanZ * 0.5;
          emitStoneArchZ(toWorld, -hw, -1, yPlinth, ySpring, archRZ, bz, 6);
          emitStoneArchZ(toWorld, hw, 1, yPlinth, ySpring, archRZ, bz, 6);
        }
      }
      const nBaysX = snapBays(inst.width - 1.4, 4.0, 2);
      const baySpanX = (inst.width - 1.4) / nBaysX;
      const archRX = Math.min(1.35, baySpanX * 0.36);
      for (let bxIdx = 0; bxIdx < nBaysX; bxIdx++) {
        const bx = -hw + 0.7 + (bxIdx + 0.5) * baySpanX;
        emitStoneArchX(toWorld, -hl, -1, yPlinth, ySpring, archRX, bx, 6);
        emitStoneArchX(toWorld, hl, 1, yPlinth, ySpring, archRX, bx, 6);
      }
      emitRoof(toWorld, -hw, hw, yTop, yTop + roofRise(Math.min(14, inst.width)), -hl, hl, 0.85, 0.24, 11);
    } else if (inst.prefabId === 'walled_mule_corral') {
      // Primitive #6: Corral del Rey / Caballerizas Reales (Walled Pack-Mule Compound & Stable Yard — Portobelo / Seville)
      const yPlinth = yGround + 0.58;
      beginSection('foundation_plinth');
      emitBox(toWorld, -hw - 0.6, hw + 0.6, yBase, yPlinth - 0.15, -hl - 0.6, hl + 0.6, 11, 0.80);
      // Cobbled courtyard yard floor (kind 16)
      beginSection('courtyard_cobble_floor');
      emitBox(toWorld, -hw, hw, yPlinth - 0.15, yPlinth, -hl, hl, 16, 0.84, true);
      // Single constant-depth (5.8m) tiled stable wing along the +X side of the compound
      const stableD = Math.min(WING_DEPTH, inst.width * 0.35);
      const sx0 = hw - stableD, sx1 = hw;
      beginSection('stable_wing_walls');
      emitBox(toWorld, sx0, sx1, yPlinth, yTop, -hl, hl, 12, 0.88);
      emitRoof(toWorld, sx0, sx1, yTop, yTop + roofRise(stableD), -hl, hl, 0.65, 0.20, 12);
      // Iterated timber stable stalls & stone watering troughs facing the courtyard
      const nStalls = snapBays(inst.length - 2.0, 3.8, 4);
      const stallSpan = (inst.length - 2.0) / nStalls;
      for (let s = 0; s < nStalls; s++) {
        const sz = -hl + 1.0 + (s + 0.5) * stallSpan;
        emitStoneArchZ(toWorld, sx0, -1, yPlinth, yPlinth + 2.0, Math.min(1.15, stallSpan * 0.34), sz, 5);
        if (s % 2 === 0) {
          beginSection('courtyard_watering_troughs');
          emitBox(toWorld, sx0 - 2.2, sx0 - 0.8, yPlinth, yPlinth + 0.85, sz - 1.1, sz + 1.1, 11, 0.82);
        }
      }
      // Perimeter 3.2m masonry corral wall with terracotta tile coping & iterated 4.2m stone pilaster bays on the remaining 3 sides
      const yWall = yPlinth + 3.2;
      const wallT = 0.95;
      beginSection('corral_perimeter_walls');
      emitBox(toWorld, -hw, -hw + wallT, yPlinth, yWall, -hl, hl, 12, 0.85);
      emitBox(toWorld, -hw - 0.14, -hw + wallT + 0.14, yWall, yWall + 0.32, -hl - 0.1, hl + 0.1, 13, 0.92, true);
      emitBox(toWorld, -hw, sx0, yPlinth, yWall, -hl, -hl + wallT, 12, 0.85);
      emitBox(toWorld, -hw - 0.1, sx0 + 0.1, yWall, yWall + 0.32, -hl - 0.14, -hl + wallT + 0.14, 13, 0.92, true);
      emitBox(toWorld, -hw, sx0, yPlinth, yWall, hl - wallT, hl, 12, 0.85);
      emitBox(toWorld, -hw - 0.1, sx0 + 0.1, yWall, yWall + 0.32, hl - wallT - 0.14, hl + 0.14, 13, 0.92, true);
      for (let b = 0; b <= nStalls; b++) {
        const bz = -hl + 1.0 + b * stallSpan;
        emitBox(toWorld, -hw - 0.32, -hw, yPlinth, yWall, bz - 0.32, bz + 0.32, 11, 0.84);
      }
      // Arched stone carriage gatehouse on the -X street wall
      beginSection('carriage_gatehouse');
      emitBox(toWorld, -hw - 0.38, -hw + wallT + 0.25, yPlinth, yWall + 1.4, -2.4, 2.4, 11, 0.88);
      emitStoneArchZ(toWorld, -hw - 0.25, -1, yPlinth, yPlinth + 2.2, 1.35, 0, 6);
    } else if (inst.prefabId === 'torreon_atalaya_farol') {
      // Primitive #8: Torre del Homenaje / Torreón Redondo (Torre del Oro) / Atalaya de Madera & Farol Beacon
      const rBase = Math.min(hw, hl);
      const yPlinth = yGround + 0.85;
      beginSection('foundation_plinth');
      emitBox(toWorld, -rBase - 0.9, rBase + 0.9, yBase, yPlinth, -rBase - 0.9, rBase + 0.9, 11, 0.82, false, 0.65);
      if (inst.materialKind === 10) {
        // Open X-braced 4-post timber frontier Atalaya watchtower on sandy barrier spit (St. Augustine)
        const postR = rBase * 0.62;
        const yDeck = yTop;
        beginSection('atalaya_timber_posts');
        for (const sx of [-1, 1]) {
          for (const sz of [-1, 1]) {
            emitCylinder(toWorld, sx * postR, sz * postR, yPlinth, yDeck + 2.4, 0.32, 0.24, 6, 10, 0.74, true);
          }
        }
        beginSection('atalaya_tier_decks');
        for (let tier = 0; tier < 3; tier++) {
          const ty = yPlinth + (tier + 1) * ((yDeck - yPlinth) / 3);
          emitBox(toWorld, -postR - 0.2, postR + 0.2, ty - 0.22, ty, -postR - 0.2, postR + 0.2, 10, 0.78, true);
        }
        emitBalustradeZ(toWorld, -postR, -1, yDeck, -postR, postR);
        emitBalustradeZ(toWorld, postR, 1, yDeck, -postR, postR);
        emitRoof(toWorld, -postR - 0.3, postR + 0.3, yDeck + 2.4, yDeck + 4.8, -postR - 0.3, postR + 0.3, 0.65, 0.48, 10, 15);
      } else {
        // 12-sided polygonal/circular stone Torreón (Seville Torre del Oro / Veracruz & Havana headland lighthouse keep)
        const yBody1 = yPlinth + (yTop - yPlinth) * 0.58;
        const yBody2 = yTop;
        const yLantern = yTop + 3.4;
        beginSection('torreon_lower_drum_walls');
        emitCylinder(toWorld, 0, 0, yPlinth, yBody1, rBase * 0.92, rBase * 0.84, 12, 11, 0.88, true);
        emitCylinder(toWorld, 0, 0, yBody1 - 0.28, yBody1 + 0.18, rBase * 0.94, rBase * 0.94, 12, 11, 0.94, true);
        beginSection('torreon_upper_drum_walls');
        emitCylinder(toWorld, 0, 0, yBody1 + 0.18, yBody2, rBase * 0.82, rBase * 0.78, 12, 12, 0.91, true);
        // Crenellated corbel ring around tower crown
        beginSection('parapet_merlons');
        emitCylinder(toWorld, 0, 0, yBody2 - 0.35, yBody2 + 0.65, rBase * 0.88, rBase * 0.90, 12, 11, 0.92, true);
        for (let s = 0; s < 8; s++) {
          const a = (s / 8) * Math.PI * 2;
          const mx = Math.cos(a) * rBase * 0.78;
          const mz = Math.sin(a) * rBase * 0.78;
          emitBox(toWorld, mx - 0.55, mx + 0.55, yBody2 + 0.65, yBody2 + 1.35, mz - 0.55, mz + 0.55, 11, 0.90);
        }
        // Upper octagonal lantern turret + glazed dome + iron fire-basket Farol beacon
        beginSection('lantern_farol_beacon');
        emitCylinder(toWorld, 0, 0, yBody2 + 0.65, yLantern, rBase * 0.44, rBase * 0.42, 8, 11, 0.92, true);
        beginSection('lantern_cupola_dome');
        emitCylinder(toWorld, 0, 0, yLantern, yLantern + 1.85, rBase * 0.46, 0.16, 8, 13, 0.96, true);
        emitCylinder(toWorld, 0, 0, yLantern + 1.85, yLantern + 2.85, 0.14, 0.48, 6, 14, 0.45, true);
      }
    } else if (inst.prefabId === 'curtain_wall_and_gate') {
      // Primitive #9: Muralla Real / Muro de las Argollas y Puerta de la Ciudad (Bay-Iterated City Curtain Wall & Gatehouse)
      const yWalk = yTop - 0.95;
      const wallHW = Math.min(3.4, hw);
      beginSection('foundation_plinth');
      emitBox(toWorld, -wallHW - 0.85, wallHW + 0.85, yBase, yGround + 0.65, -hl - 0.65, hl + 0.65, 11, 0.82, false, 0.55);
      // Battered ashlar curtain wall body + rampart walk (adarve)
      beginSection('curtain_wall');
      emitBox(toWorld, -wallHW, wallHW, yGround + 0.65, yWalk, -hl, hl, 11, 0.87, false, 0.35);
      beginSection('terreplein_adarve_walk');
      emitBox(toWorld, -wallHW + 0.55, wallHW - 0.55, yWalk - 0.15, yWalk + 0.05, -hl, hl, 16, 0.82, true);

      // Iterate 4.0m merlon-and-embrasure bays along the full curtain wall length + mooring rings
      const nBays = snapBays(inst.length - 1.6, 4.0, 4);
      const baySpan = (inst.length - 1.6) / nBays;
      for (let b = 0; b <= nBays; b++) {
        const bz = -hl + 0.8 + b * baySpan;
        if (Math.abs(bz) > 3.6) {
          beginSection('parapet_merlons');
          emitBox(toWorld, -wallHW, -wallHW + 0.85, yWalk, yTop, bz - 1.15, bz + 1.15, 11, 0.91, false, 0.08);
          emitBox(toWorld, wallHW - 0.85, wallHW, yWalk, yTop, bz - 1.15, bz + 1.15, 11, 0.89, false, 0.08);
        }
        if (b % 2 === 0) {
          // Bronze/iron mooring ring bosses (Muro de las Argollas) on the outer scarp face
          beginSection('mooring_rings');
          emitCylinder(toWorld, -wallHW - 0.25, bz, yGround + 1.4, yGround + 1.95, 0.32, 0.32, 6, 14, 0.38, true);
        }
      }
      // Central twin-turret arched city gatehouse (Puerta de la Mar / Puerta de Tierra)
      const gHW = wallHW + 1.15;
      const yGateTop = yTop + 2.8;
      beginSection('city_gatehouse');
      emitBox(toWorld, -gHW, gHW, yGround + 0.65, yGateTop, -3.8, 3.8, 11, 0.90);
      emitBox(toWorld, -gHW - 0.25, gHW + 0.25, yGateTop - 0.32, yGateTop, -4.05, 4.05, 11, 0.94, true);
      for (const mz of [-2.8, 0, 2.8]) {
        emitBox(toWorld, -gHW, gHW, yGateTop, yGateTop + 0.85, mz - 0.85, mz + 0.85, 11, 0.92);
      }
      emitStoneArchZ(toWorld, -gHW, -1, yGround + 0.65, yGround + 3.2, 1.65, 0, 6);
      emitStoneArchZ(toWorld, gHW, 1, yGround + 0.65, yGround + 3.2, 1.65, 0, 6);
    } else if (inst.prefabId === 'stone_arch_bridge') {
      // Primitive #10: Puente de Piedra con Tajamares (Bay-Iterated Multi-Arch Stone Bridge with Triangular Cutwater Piers)
      const bridgeHW = Math.min(4.2, hw);
      const yDeck = yTop - 0.85;
      const nSpans = snapBays(inst.length - 2.4, 6.8, 3);
      const spanLen = (inst.length - 2.4) / nSpans;
      const archR = Math.min(2.35, spanLen * 0.36);
      const ySpring = yDeck - archR - 0.55;

      // Bridge roadway body, cobbled deck (kind 16), and cut-stone side parapets (kind 11)
      beginSection('bridge_roadway_walls');
      emitBox(toWorld, -bridgeHW, bridgeHW, ySpring, yDeck, -hl, hl, 11, 0.88);
      beginSection('courtyard_bridge_deck_slab');
      emitBox(toWorld, -bridgeHW + 0.55, bridgeHW - 0.55, yDeck, yDeck + 0.14, -hl, hl, 16, 0.84, true);
      emitBox(toWorld, -bridgeHW - 0.18, bridgeHW + 0.18, yDeck - 0.24, yDeck, -hl - 0.2, hl + 0.2, 11, 0.93, true);
      beginSection('parapet_walls');
      emitBox(toWorld, -bridgeHW, -bridgeHW + 0.58, yDeck, yTop, -hl, hl, 11, 0.90);
      emitBox(toWorld, bridgeHW - 0.58, bridgeHW, yDeck, yTop, -hl, hl, 11, 0.90);

      // Iterate deep seabed piers, triangular upstream/downstream cutwaters (tajamares), and radial voussoir arches
      for (let s = 0; s <= nSpans; s++) {
        const pz = -hl + 1.2 + s * spanLen;
        beginSection('foundation_bridge_piers');
        emitBox(toWorld, -bridgeHW - 0.35, bridgeHW + 0.35, yBase, ySpring + 0.2, pz - 0.95, pz + 0.95, 11, 0.83);
        // Triangular cutwater beaks (tajamares) projecting from -bridgeHW and +bridgeHW
        beginSection('foundation_cutwaters');
        for (const sideX of [-1, 1]) {
          const xFace = sideX * (bridgeHW + 0.35);
          const xBeak = sideX * (bridgeHW + 1.85);
          const b00 = toWorld(xFace, yBase, pz - 0.95);
          const b10 = toWorld(xFace, yBase, pz + 0.95);
          const bTip0 = toWorld(xBeak, yBase, pz);
          const t00 = toWorld(xFace, ySpring + 0.35, pz - 0.95);
          const t10 = toWorld(xFace, ySpring + 0.35, pz + 0.95);
          const tTip0 = toWorld(xBeak, ySpring + 0.35, pz);
          if (sideX < 0) {
            pushQuad(b00, bTip0, tTip0, t00, 11, 0.86);
            pushQuad(bTip0, b10, t10, tTip0, 11, 0.82);
            pushTri(t00, tTip0, t10, 11, 0.92);
          } else {
            pushQuad(bTip0, b00, t00, tTip0, 11, 0.86);
            pushQuad(b10, bTip0, tTip0, t10, 11, 0.82);
            pushTri(t10, tTip0, t00, 11, 0.92);
          }
        }
        if (s < nSpans) {
          const az = pz + spanLen * 0.5;
          emitStoneArchZ(toWorld, -bridgeHW, -1, yBase + 0.5, ySpring, archR, az, 6);
          emitStoneArchZ(toWorld, bridgeHW, 1, yBase + 0.5, ySpring, archR, az, 6);
        }
      }
    } else if (inst.prefabId === 'thatched_bohio_palafito') {
      // Primitive #11: Bohío / Caney de Palma y Palafito de Manglar (Palm-Thatch House & Over-Water Stilt Hut)
      const hutHW = Math.min(5.2, hw);
      const isPalafito = inst.y <= 3.2 || inst.waterfront;
      const yDeck = isPalafito ? yGround + 1.15 : yGround + 0.45;
      const yEave = yTop;
      const nPostsZ = snapBays(inst.length - 1.2, 3.0, 3);
      const postSpanZ = (inst.length - 1.2) / nPostsZ;

      if (isPalafito) {
        // Raised timber stilt platform (palafito) + submerged mangrove pilings + seaward planked catwalk jetty
        beginSection('interior_deck_slab');
        emitBox(toWorld, -hutHW - 0.85, hutHW + 0.85, yDeck - 0.28, yDeck, -hl - 1.4, hl + 0.8, 10, 0.80, true);
        emitBox(toWorld, -1.1, 1.1, yDeck - 0.25, yDeck, -hl - 4.8, -hl - 1.4, 10, 0.78, true);
        beginSection('foundation_pilings');
        for (let p = 0; p <= nPostsZ; p++) {
          const pz = -hl + 0.6 + p * postSpanZ;
          emitCylinder(toWorld, -hutHW - 0.45, pz, yBase, yDeck + 0.85, 0.22, 0.19, 6, 10, 0.68, true);
          emitCylinder(toWorld, hutHW + 0.45, pz, yBase, yDeck + 0.85, 0.22, 0.19, 6, 10, 0.68, true);
        }
      } else {
        beginSection('foundation_plinth');
        emitBox(toWorld, -hutHW - 0.45, hutHW + 0.45, yBase, yDeck, -hl - 0.45, hl + 0.45, 16, 0.78);
      }

      // Wattle-and-daub (bahareque, kind 12) walls with iterated exterior mangrove timber posts (kind 10)
      beginSection('bohio_bahareque_walls');
      emitBox(toWorld, -hutHW, hutHW, yDeck, yEave, -hl, hl, 12, 0.86);
      for (let p = 0; p <= nPostsZ; p++) {
        const pz = -hl + 0.6 + p * postSpanZ;
        beginSection('arcade_timber_columns');
        emitCylinder(toWorld, -hutHW - 0.08, pz, yDeck, yEave, 0.20, 0.18, 6, 10, 0.74, true);
        emitCylinder(toWorld, hutHW + 0.08, pz, yDeck, yEave, 0.20, 0.18, 6, 10, 0.74, true);
        if (p < nPostsZ) {
          beginSection('facade_window_openings');
          const wz = pz + postSpanZ * 0.5;
          emitBox(toWorld, -hutHW - 0.08, -hutHW + 0.12, yDeck + 0.65, yEave - 0.55, wz - 0.48, wz + 0.48, 14, 0.32);
          emitBox(toWorld, hutHW - 0.12, hutHW + 0.08, yDeck + 0.65, yEave - 0.55, wz - 0.48, wz + 0.48, 14, 0.32);
        }
      }
      // Steep 38° multi-tiered palm-thatch hipped roof (kind 15)
      const yPeak = yEave + roofRise(hutHW * 2, 0.68);
      emitRoof(toWorld, -hutHW, hutHW, yEave, yPeak, -hl, hl, 0.92, 0.32, 10, 15);
    } else if (inst.prefabId === 'astillero_and_moored_hull') {
      // Primitive #12: Astillero con Carabela en Grada / Barco de Puerto (Foreshore Slipway & Skeletal Caravel Hull)
      const hullHW = Math.min(3.6, hw * 0.78);
      const hullHL = Math.min(11.5, hl * 0.85);
      const ySlip = yGround + 0.35;
      // Sloped timber slipway (varadero) iterating transverse oak sleepers every 2.0m
      const nSleepers = snapBays(inst.length - 1.6, 2.0, 6);
      const sleeperSpan = (inst.length - 1.6) / nSleepers;
      beginSection('foundation_slipway_apron');
      emitBox(toWorld, -hullHW - 1.2, hullHW + 1.2, yBase, ySlip - 0.15, -hl, hl, 16, 0.76);
      beginSection('foundation_sleepers');
      for (let s = 0; s <= nSleepers; s++) {
        const sz = -hl + 0.8 + s * sleeperSpan;
        emitBox(toWorld, -hullHW - 0.95, hullHW + 0.95, ySlip - 0.15, ySlip + 0.16, sz - 0.22, sz + 0.22, 10, 0.70, true);
      }
      // Heavy oak keel, curved stempost (-hullHL), sternpost (+hullHL) & transom
      const yKeel = ySlip + 0.75;
      const yGunwale = yKeel + 3.2;
      beginSection('caravel_keel_and_posts');
      emitBox(toWorld, -0.28, 0.28, ySlip + 0.16, yKeel + 0.45, -hullHL, hullHL, 10, 0.66, true);
      emitBox(toWorld, -0.26, 0.26, yKeel, yGunwale + 1.4, -hullHL - 1.2, -hullHL + 0.4, 10, 0.72, false, 0.18);
      emitBox(toWorld, -hullHW * 0.68, hullHW * 0.68, yKeel + 0.4, yGunwale + 1.6, hullHL - 0.55, hullHL + 0.35, 10, 0.74);

      // Iterate 9 U-shaped oak hull rib frames (cuadernas) with longitudinal bilge & sheer strakes
      const nFrames = 9;
      for (let f = 0; f < nFrames; f++) {
        beginSection('caravel_rib_frames');
        const u = f / (nFrames - 1);
        const fz = -hullHL + 1.2 + u * (hullHL * 2 - 2.4);
        const beamProfile = Math.sin(Math.max(0.15, Math.min(0.92, u)) * Math.PI);
        const curHW = hullHW * (0.48 + 0.52 * beamProfile);
        // Bilge floor timber + port & starboard futtock ribs
        emitBox(toWorld, -curHW * 0.78, curHW * 0.78, yKeel, yKeel + 0.42, fz - 0.16, fz + 0.16, 10, 0.74, true);
        emitBox(toWorld, -curHW, -curHW + 0.32, yKeel + 0.32, yGunwale, fz - 0.16, fz + 0.16, 10, 0.78, true);
        emitBox(toWorld, curHW - 0.32, curHW, yKeel + 0.32, yGunwale, fz - 0.16, fz + 0.16, 10, 0.78, true);
        emitBox(toWorld, -curHW + 0.2, curHW - 0.2, yGunwale - 0.35, yGunwale - 0.08, fz - 0.14, fz + 0.14, 10, 0.76, true);
      }
      // Longitudinal sheer strake & wale planks + A-frame sheerlegs crane & smoking pitch cauldron beside the hull
      beginSection('caravel_sheer_strakes');
      emitBox(toWorld, -hullHW - 0.12, -hullHW + 0.18, yGunwale - 0.65, yGunwale, -hullHL * 0.78, hullHL * 0.85, 10, 0.82, true);
      emitBox(toWorld, hullHW - 0.18, hullHW + 0.12, yGunwale - 0.65, yGunwale, -hullHL * 0.78, hullHL * 0.85, 10, 0.82, true);
      beginSection('sheerlegs_crane_and_pitch_cauldron');
      emitCylinder(toWorld, hw - 0.8, 0, ySlip, yGunwale + 2.8, 0.26, 0.18, 6, 10, 0.74, true);
      emitCylinder(toWorld, -hw + 1.1, hl * 0.55, ySlip, ySlip + 1.25, 0.75, 0.85, 8, 14, 0.36, true);
    } else if (inst.prefabId === 'royal_warehouse') {
      // Royal Warehouse (Almacén Real): Bay-iterated buttressed masonry hall with radial stone voussoir cargo portals
      const yPlinth = yGround + 0.68;
      const whHW = Math.min(7.8, hw);
      beginSection('foundation_plinth');
      emitBox(toWorld, -hw - 0.65, hw + 0.65, yBase, yPlinth, -hl - 0.65, hl + 0.65, 11, 0.80);
      beginSection('warehouse_hall_walls');
      emitBox(toWorld, -whHW, whHW, yPlinth, yTop, -hl, hl, 12, 0.88);
      emitCornerQuoins(toWorld, -whHW, whHW, yPlinth, yTop, -hl, hl, 5);
      const nBays = snapBays(inst.length - 2.0, 4.6, 4);
      const baySpan = (inst.length - 2.0) / nBays;
      for (let b = 0; b <= nBays; b++) {
        const bz = -hl + 1.0 + b * baySpan;
        beginSection('warehouse_buttresses');
        emitBox(toWorld, -whHW - 0.55, -whHW, yPlinth, yTop - 0.25, bz - 0.40, bz + 0.40, 11, 0.83, false, 0.12);
        emitBox(toWorld, whHW, whHW + 0.55, yPlinth, yTop - 0.25, bz - 0.40, bz + 0.40, 11, 0.83, false, 0.12);
        if (b < nBays) {
          const pz = bz + baySpan * 0.5;
          const archR = Math.min(1.18, baySpan * 0.32);
          emitStoneArchZ(toWorld, -whHW, -1, yPlinth, yPlinth + 2.25, archR, pz, 6);
          emitStoneArchZ(toWorld, whHW, 1, yPlinth, yPlinth + 2.25, archR, pz, 6);
          beginSection('facade_clerestory_windows');
          emitBox(toWorld, -whHW - 0.08, whHW + 0.08, yPlinth + 4.45, yTop - 0.85, pz - 0.62, pz + 0.62, 14, 0.36);
        }
      }
      emitRoof(toWorld, -whHW, whHW, yTop, yTop + roofRise(whHW * 2), -hl, hl, 0.78, 0.15, 12);
    } else {
      // Bay-Iterated Spanish Colonial Residential & Civic Blocks:
      // Dispatches cleanly between:
      //  - Primitive #1 (`single_nave_solar` or narrow footprint `width <= 13.2m`): Solid single-ridge hall (no crushed courtyard slit!)
      //  - Primitive #2 (`l_wing_u_wing_solar` or medium footprint `13.2m < width < 20.5m`): Constant 5.8m-deep L/U wings + walled corral
      //  - Primitive #3 (`modular_patio_cloister` or wide `colonial_town_block` `width >= 20.5m`): 4 constant 5.8m-deep wings + arcaded courtyard
      const yPlinth = yGround + 0.68;
      const yMid = yPlinth + (yTop - yPlinth) * 0.50;
      beginSection('foundation_plinth');
      emitBox(toWorld, -hw - 0.65, hw + 0.65, yBase, yPlinth, -hl - 0.65, hl + 0.65, 11, 0.80);

      const isSingleNave =
        inst.prefabId === 'single_nave_solar' ||
        (inst.prefabId !== 'modular_patio_cloister' && inst.prefabId !== 'l_wing_u_wing_solar' && inst.width <= 13.2);
      const isCloister =
        inst.prefabId === 'modular_patio_cloister' ||
        (inst.prefabId === 'colonial_town_block' && inst.width >= 20.5 && inst.length >= 21.5);

      if (isSingleNave) {
        // Primitive #1: Casa de Una Nave / Barracón (Single-Span Rectangular Hall with Iterated 3.8m Facade Bays)
        const spanW = Math.min(12.8, inst.width);
        const sHW = spanW * 0.5;
        beginSection('single_nave_walls');
        emitBox(toWorld, -sHW, sHW, yPlinth, yTop, -hl, hl, 12, 0.90);
        emitBox(toWorld, -sHW - 0.15, sHW + 0.15, yMid - 0.18, yMid + 0.10, -hl - 0.15, hl + 0.15, 11, 0.86, true);
        emitCornerQuoins(toWorld, -sHW, sHW, yPlinth, yTop, -hl, hl, 5);

        const nBaysZ = snapBays(inst.length - 1.2, 3.8, 3);
        const baySpanZ = (inst.length - 1.2) / nBaysZ;
        const doorBay = Math.floor(nBaysZ * 0.5);
        for (let b = 0; b < nBaysZ; b++) {
          const bz = -hl + 0.6 + (b + 0.5) * baySpanZ;
          if (b === doorBay) {
            emitStoneArchZ(toWorld, -sHW, -1, yPlinth, yPlinth + 2.05, Math.min(1.08, baySpanZ * 0.32), bz, 5);
            emitFacadeBayZ(toWorld, -sHW, -1, yPlinth, yMid, yTop, bz, true);
          } else {
            emitFacadeBayZ(toWorld, -sHW, -1, yPlinth, yMid, yTop, bz, true);
          }
          emitFacadeBayZ(toWorld, sHW, 1, yPlinth, yMid, yTop, bz, true);
        }
        const nBaysX = snapBays(spanW - 1.0, 3.6, 2);
        const baySpanX = (spanW - 1.0) / nBaysX;
        for (let bxIdx = 0; bxIdx < nBaysX; bxIdx++) {
          const bx = -sHW + 0.5 + (bxIdx + 0.5) * baySpanX;
          emitFacadeBayX(toWorld, -hl, -1, yPlinth, yMid, yTop, bx, true);
          emitFacadeBayX(toWorld, hl, 1, yPlinth, yMid, yTop, bx, true);
        }
        emitBalustradeZ(toWorld, -sHW, -1, yMid + 0.08, -hl + 0.9, hl - 0.9);
        emitRoof(toWorld, -sHW, sHW, yTop, yTop + roofRise(spanW), -hl, hl, 0.68, 0.22, 12);
      } else if (isCloister) {
        // Primitive #3: Casa de Patio / Convento Claustral (4 Constant-Depth 5.8m Wings + Iterated Arcaded Courtyard)
        const wingD = Math.min(WING_DEPTH, Math.max(4.6, Math.min(inst.width, inst.length) * 0.28));
        const wingPeak = yTop + roofRise(wingD);
        const ix0 = -hw + wingD, ix1 = hw - wingD;
        const iz0 = -hl + wingD, iz1 = hl - wingD;

        // Cobbled central courtyard floor (kind 16) + octagonal stone patio fountain (Fuente de Patio)
        beginSection('courtyard_floor_and_fountain');
        emitBox(toWorld, ix0, ix1, yPlinth - 0.12, yPlinth + 0.04, iz0, iz1, 16, 0.84, true);
        emitCylinder(toWorld, 0, 0, yPlinth + 0.04, yPlinth + 0.88, 1.45, 1.55, 8, 11, 0.88, true);
        emitCylinder(toWorld, 0, 0, yPlinth + 0.88, yPlinth + 2.35, 0.34, 0.24, 8, 11, 0.92, true);

        // 4 Perimeter Wings with constant wingD thickness and constant-angle roofs
        beginSection('cloister_west_wing_walls');
        emitBox(toWorld, -hw, ix0, yPlinth, yTop, -hl, hl, 12, 0.90);
        beginSection('cloister_east_wing_walls');
        emitBox(toWorld, ix1, hw, yPlinth, yTop, -hl, hl, 12, 0.89);
        beginSection('cloister_north_wing_walls');
        emitBox(toWorld, ix0, ix1, yPlinth, yTop, -hl, iz0, 12, 0.88);
        beginSection('cloister_south_wing_walls');
        emitBox(toWorld, ix0, ix1, yPlinth, yTop, iz1, hl, 12, 0.88);
        emitCornerQuoins(toWorld, -hw, hw, yPlinth, yTop, -hl, hl, 5);

        emitRoof(toWorld, -hw, ix0, yTop, wingPeak, -hl, hl, 0.62, 0.20, 12);
        emitRoof(toWorld, ix1, hw, yTop, wingPeak, -hl, hl, 0.62, 0.20, 12);
        emitRoofX(toWorld, -hw, hw, yTop, wingPeak, -hl, iz0, 0.62, 0.20, 12);
        emitRoofX(toWorld, -hw, hw, yTop, wingPeak, iz1, hl, 0.62, 0.20, 12);

        // Corner Mirador Watch-Turret (Torre Mirador) rising 2.6m above the southwest corner
        const yMirador = yTop + 2.6;
        beginSection('mirador_watch_turret');
        emitBox(toWorld, -hw, ix0, yTop, yMirador, -hl, iz0, 12, 0.92);
        emitStoneArchZ(toWorld, -hw, -1, yTop + 0.3, yMirador - 0.9, 0.65, (-hl + iz0) * 0.5, 5);
        emitRoof(toWorld, -hw, ix0, yMirador, yMirador + roofRise(wingD, 0.48), -hl, iz0, 0.58, 0.45, 12);

        // Iterate 3.6m semicircular stone arches around all 4 interior courtyard walls (ground & upper cloister galleries)
        const patioL = Math.max(4.0, iz1 - iz0);
        const patioW = Math.max(4.0, ix1 - ix0);
        const nPatioZ = snapBays(patioL, 3.6, 2);
        const pSpanZ = patioL / nPatioZ;
        const pArchRZ = Math.min(1.12, pSpanZ * 0.34);
        for (let b = 0; b < nPatioZ; b++) {
          const pz = iz0 + (b + 0.5) * pSpanZ;
          emitStoneArchZ(toWorld, ix0, 1, yPlinth, yPlinth + 1.95, pArchRZ, pz, 5);
          emitStoneArchZ(toWorld, ix1, -1, yPlinth, yPlinth + 1.95, pArchRZ, pz, 5);
          emitStoneArchZ(toWorld, ix0, 1, yMid, yMid + 1.65, pArchRZ * 0.88, pz, 5);
          emitStoneArchZ(toWorld, ix1, -1, yMid, yMid + 1.65, pArchRZ * 0.88, pz, 5);
        }
        const nPatioX = snapBays(patioW, 3.6, 2);
        const pSpanX = patioW / nPatioX;
        const pArchRX = Math.min(1.12, pSpanX * 0.34);
        for (let b = 0; b < nPatioX; b++) {
          const px = ix0 + (b + 0.5) * pSpanX;
          emitStoneArchX(toWorld, iz0, 1, yPlinth, yPlinth + 1.95, pArchRX, px, 5);
          emitStoneArchX(toWorld, iz1, -1, yPlinth, yPlinth + 1.95, pArchRX, px, 5);
        }

        // Iterate 3.8m exterior street facade bays along Z and X
        const nExtZ = snapBays(inst.length - 1.4, 3.8, 4);
        const extSpanZ = (inst.length - 1.4) / nExtZ;
        const midBayZ = Math.floor(nExtZ * 0.5);
        for (let b = 0; b < nExtZ; b++) {
          const bz = -hl + 0.7 + (b + 0.5) * extSpanZ;
          if (b === midBayZ) {
            emitStoneArchZ(toWorld, -hw, -1, yPlinth, yPlinth + 2.15, 1.18, bz, 6);
            emitStoneArchZ(toWorld, hw, 1, yPlinth, yPlinth + 2.15, 1.18, bz, 6);
          }
          emitFacadeBayZ(toWorld, -hw, -1, yPlinth, yMid, yTop, bz, true);
          emitFacadeBayZ(toWorld, hw, 1, yPlinth, yMid, yTop, bz, true);
        }
        const nExtX = snapBays(inst.width - 1.4, 3.8, 3);
        const extSpanX = (inst.width - 1.4) / nExtX;
        for (let b = 0; b < nExtX; b++) {
          const bx = -hw + 0.7 + (b + 0.5) * extSpanX;
          emitFacadeBayX(toWorld, -hl, -1, yPlinth, yMid, yTop, bx, true);
          emitFacadeBayX(toWorld, hl, 1, yPlinth, yMid, yTop, bx, true);
        }
        emitBalustradeZ(toWorld, -hw, -1, yMid + 0.08, -hl + 1.0, hl - 1.0);
        emitBalustradeZ(toWorld, hw, 1, yMid + 0.08, -hl + 1.0, hl - 1.0);
      } else {
        // Primitive #2: Casa Solariega en L / U con Corral (Constant 5.8m-Deep L-Wing or U-Wing + Walled Corner Patio)
        const wingD = Math.min(WING_DEPTH, Math.max(4.8, inst.width * 0.36));
        const mainPeak = yTop + 0.85 + roofRise(wingD);
        const crossEave = yTop - 0.25;
        const crossPeak = crossEave + roofRise(wingD);
        const ix0 = -hw + wingD;
        const iz0 = -hl + wingD;
        const hasUWing = inst.length >= 23.0;
        const iz1 = hasUWing ? hl - wingD : hl - 1.05;

        // Cobbled side patio floor (kind 16) + stone wellhead (brocal de pozo)
        beginSection('courtyard_floor_and_wellhead');
        emitBox(toWorld, ix0, hw, yPlinth - 0.12, yPlinth + 0.04, iz0, hl, 16, 0.83, true);
        emitCylinder(toWorld, (ix0 + hw) * 0.5, (iz0 + iz1) * 0.5, yPlinth + 0.04, yPlinth + 1.05, 0.88, 0.92, 8, 11, 0.86, true);

        // Main street wing [-hw, ix0] running full length [-hl, hl]
        beginSection('main_street_wing_walls');
        emitBox(toWorld, -hw, ix0, yPlinth, yTop + 0.85, -hl, hl, 12, 0.90);
        emitCornerQuoins(toWorld, -hw, ix0, yPlinth, yTop + 0.85, -hl, hl, 5);
        emitRoof(toWorld, -hw, ix0, yTop + 0.85, mainPeak, -hl, hl, 0.65, 0.22, 12);

        // North cross-wing [ix0 - 0.6, hw] × [-hl, iz0]
        beginSection('north_cross_wing_walls');
        emitBox(toWorld, ix0 - 0.6, hw, yPlinth, crossEave, -hl, iz0, 12, 0.87);
        emitRoofX(toWorld, ix0 - 0.6, hw, crossEave, crossPeak, -hl, iz0, 0.60, 0.22, 12);

        if (hasUWing) {
          // South cross-wing [ix0 - 0.6, hw] × [iz1, hl] completing the U-plan
          beginSection('south_cross_wing_walls');
          emitBox(toWorld, ix0 - 0.6, hw, yPlinth, crossEave, iz1, hl, 12, 0.87);
          emitRoofX(toWorld, ix0 - 0.6, hw, crossEave, crossPeak, iz1, hl, 0.60, 0.22, 12);
        } else {
          // South limewashed tapia corral wall closing the L-plan
          beginSection('south_corral_wall');
          emitBox(toWorld, ix0, hw, yPlinth, yPlinth + 3.35, hl - 1.05, hl, 12, 0.84);
          emitBox(toWorld, ix0, hw + 0.15, yPlinth + 3.35, yPlinth + 3.68, hl - 1.2, hl + 0.15, 13, 0.92, true);
        }

        // East courtyard enclosure wall with terracotta tile coping & arched carriage portal (zaguán)
        beginSection('east_courtyard_wall');
        emitBox(toWorld, hw - 1.05, hw, yPlinth, yPlinth + 3.35, iz0, iz1, 12, 0.84);
        emitBox(toWorld, hw - 1.2, hw + 0.15, yPlinth + 3.35, yPlinth + 3.68, iz0, iz1, 13, 0.92, true);
        emitStoneArchZ(toWorld, hw, 1, yPlinth, yPlinth + 2.0, 1.08, (iz0 + iz1) * 0.5, 5);

        // Iterate 3.8m street facade bays on -hw and interior patio colonnade arches on ix0
        const nBaysZ = snapBays(inst.length - 1.2, 3.8, 3);
        const baySpanZ = (inst.length - 1.2) / nBaysZ;
        const midBay = Math.floor(nBaysZ * 0.5);
        for (let b = 0; b < nBaysZ; b++) {
          const bz = -hl + 0.6 + (b + 0.5) * baySpanZ;
          if (b === midBay) {
            emitStoneArchZ(toWorld, -hw, -1, yPlinth, yPlinth + 2.15, 1.12, bz, 5);
          }
          emitFacadeBayZ(toWorld, -hw, -1, yPlinth, yMid, yTop + 0.85, bz, true);
          if (bz > iz0 + 0.8 && bz < iz1 - 0.8) {
            emitStoneArchZ(toWorld, ix0, 1, yPlinth, yPlinth + 1.95, Math.min(1.08, baySpanZ * 0.32), bz, 5);
          }
        }
        emitBalustradeZ(toWorld, -hw, -1, yMid + 0.08, -hl + 0.9, hl - 0.9);
      }
    }
    flushSection();
  }

  // 2-tier 3D Corner-model Palms (Cocos nucifera coconut palms on foreshore + Roystonea regia royal palms & Sabal palmetto in lowland/inland canopy)
  if (palms instanceof Float32Array && palms.length >= 8) {
    activeInstIndex = portPlacement.instances.length;
    activePrefabId = 'palm_grove';
    activeInstTag = 'palms';
    instPartCounters.clear();
    currentSectionKey = null;
    sectionStart = indices.length;
    beginSection('palm_canopy_grove');
    const maxPalms = Math.min(palms.length / 8, 520);
    const seawardRad = ((portPlacement.shoreBearing ?? 112) + 180) * COASTAL_DEG_TO_RAD;
    const defaultSeaX = Math.sin(seawardRad);
    const defaultSeaZ = -Math.cos(seawardRad);
    for (let idx = 0; idx < maxPalms; idx++) {
      const base = idx * 8;
      const px = palms[base], py = palms[base + 1], pz = palms[base + 2];
      const plumeR = palms[base + 3], ht = palms[base + 4], shape = palms[base + 5];
      const psx = palms[base + 6] || 0, psz = palms[base + 7] || 0;
      const gradLen = Math.hypot(psx, psz);
      // Lean seaward down the local beach slope (-sx, -sz) when available; inland royal/sabal palms stand more upright
      const seaX = gradLen > 0.008 ? -psx / gradLen : defaultSeaX;
      const seaZ = gradLen > 0.008 ? -psz / gradLen : defaultSeaZ;
      const azSpread = (shape - 0.5) * 1.15;
      const leanAngle = Math.atan2(seaZ, seaX) + azSpread;
      const leanDirX = Math.cos(leanAngle), leanDirZ = Math.sin(leanAngle);
      const isForeshore = py < 9.5;
      const leanMag = isForeshore ? 2.1 + ((shape * 7) % 1) * 2.2 : 0.55 + ((shape * 7) % 1) * 0.85;
      // Tier 0 (first 160 palms): 5-segment curved trunk + 12 arching fronds; Tier 1 (palms 160..520): 3-segment trunk + 6 arching fronds
      const isNearTier = idx < 160;
      const segs = isNearTier ? 5 : 3;
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
      // Arching pinnate fronds radiating from the crownshaft (kind = 4.0 tropical foliage)
      const frondCount = isNearTier ? 12 : 6;
      const halfFronds = frondCount >> 1;
      for (let f = 0; f < frondCount; f++) {
        const tier = f < halfFronds ? 0 : 1;
        const az = (f / frondCount) * Math.PI * 2 + shape * 3.1;
        const fx = Math.cos(az), fz = Math.sin(az);
        const tx = -fz, tz = fx;
        const len = plumeR * (tier === 0 ? 1.12 : 0.92);
        const midR = len * 0.55;
        const midY = prevY + (tier === 0 ? 0.95 : 1.65);
        const tipY = prevY - (tier === 0 ? 1.35 : 0.35);
        const w = isNearTier ? 0.62 : 0.78;
        const rootP = [prevX, prevY + 0.15, prevZ];
        const midLeft = [prevX + fx * midR - tx * w, midY, prevZ + fz * midR - tz * w];
        const midRight = [prevX + fx * midR + tx * w, midY, prevZ + fz * midR + tz * w];
        const tipP = [prevX + fx * len, tipY, prevZ + fz * len];
        const exposure = tier === 0 ? 0.72 : 0.92;
        pushTri(rootP, midRight, midLeft, 4, exposure);
        pushTri(midLeft, midRight, tipP, 4, exposure);
      }
    }
    flushSection();
  }

  const outVertices = new Float32Array(verts);
  const outIndices = new Uint32Array(indices);
  const partAssembly = createPartAssemblyCatalog({
    domain: 'building',
    modelId: portPlacement.regionId ?? 'port',
    vertices: outVertices,
    vertexStride: 8,
    indices: outIndices,
    groups,
  });

  return {
    vertices: outVertices,
    indices: outIndices,
    groups,
    partAssembly,
    instanceCount: portPlacement.instances.length,
    triangleCount: indices.length / 3,
    bounds,
  };
}

const BUILDING_PARTS_CACHE = new Map();

export function getBuildingParts(prefabId, options = {}) {
  const prefab = PORT_PREFABS[prefabId];
  if (!prefab) {
    throw new Error(`Unknown port building prefab: ${prefabId}`);
  }
  const hasCustomOptions =
    options &&
    (options.length !== undefined ||
      options.width !== undefined ||
      options.height !== undefined ||
      options.foundationDepth !== undefined ||
      options.materialKind !== undefined ||
      options.roofPitch !== undefined);
  if (!hasCustomOptions && BUILDING_PARTS_CACHE.has(prefab.id)) {
    return BUILDING_PARTS_CACHE.get(prefab.id);
  }
  const inst = {
    id: prefab.id,
    prefabId: prefab.id,
    label: prefab.label,
    x: 0,
    y: 0,
    z: 0,
    yaw: 0,
    length: options.length ?? prefab.length,
    width: options.width ?? prefab.width,
    height: options.height ?? prefab.height,
    foundationDepth: options.foundationDepth ?? prefab.foundationDepth,
    materialKind: options.materialKind ?? prefab.materialKind,
    roofPitch: options.roofPitch ?? prefab.roofPitch,
    waterfront: options.waterfront ?? prefab.waterfront,
    fromOrthophotoFootprint: true,
  };
  const geo = buildPortPrefabGeometry(
    {
      regionId: prefab.id,
      singleBuildingPrefab: true,
      instances: [inst],
    },
    null,
    null
  );
  const adapter = Object.freeze({
    id: prefab.id,
    prefabId: prefab.id,
    label: prefab.label,
    domain: 'building',
    dimensions: Object.freeze({
      length: inst.length,
      width: inst.width,
      height: inst.height,
      foundationDepth: inst.foundationDepth,
      roofPitch: inst.roofPitch,
    }),
    materialKind: inst.materialKind,
    waterfront: inst.waterfront,
    bounds: geo.bounds,
    vertexStride: 8,
    vertexCount: geo.vertices.length / 8,
    triangleCount: geo.triangleCount,
    vertices: geo.vertices,
    indices: geo.indices,
    groups: geo.groups,
    partAssembly: geo.partAssembly,
    subAssemblies: BUILDING_SUB_ASSEMBLIES,
    cutawayModes: PART_CUTAWAY_MODES,
    createAssemblyState: (stateOpts = {}) => createPartAssemblyState(geo.partAssembly, stateOpts),
    locatePartAtLocalPoint: (localPoint, locateOpts = {}) =>
      locatePartAtLocalPoint(geo.partAssembly, localPoint, locateOpts),
  });
  if (!hasCustomOptions) {
    BUILDING_PARTS_CACHE.set(prefab.id, adapter);
  }
  return adapter;
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
      const sx = (coastalSampleClamped(heights, x + 12, z, region) - coastalSampleClamped(heights, x - 12, z, region)) / 24;
      const sz = (coastalSampleClamped(heights, x, z + 12, region) - coastalSampleClamped(heights, x, z - 12, region)) / 24;
      const slope = Math.hypot(sx, sz);
      if (slope > 1.12) {
        mask[idx] = 0;
        continue;
      }
      const patchNoise = coastalFbm2D(u * 6.5 + 1.9, v * 6.5 - 2.4, seed, 4);
      const moisture = coastalSmoothstep(minTreeElev, 5.2, h) * coastalSmoothstep(1.12, 0.35, slope);
      const proceduralVeg = Math.min(1, moisture * (0.76 + 0.38 * patchNoise));
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
              ? (0.76 + 0.22 * patchNoise) * moisture
              : 0;
          vegProb = Math.max(satGreen, restoredUrban, proceduralVeg * 0.88) * coastalSmoothstep(1.12, 0.42, slope);
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
      const sandNoise = (coastalFbm2D(u * 22 + 3.1, v * 22 - 1.7, seed, 3) - 0.5) * 2;
      if (h <= -0.45) {
        const shallow = coastalSmoothstep(-26, -0.6, h);
        const shoalR = 26 + shallow * 116 + sandNoise * 5;
        const shoalG = 56 + shallow * 112 + sandNoise * 5;
        const shoalB = 72 + shallow * 76 + sandNoise * 4;
        const outIdx = (j * size + i) * 4;
        rgba[outIdx] = Math.max(0, Math.min(255, Math.round(shoalR)));
        rgba[outIdx + 1] = Math.max(0, Math.min(255, Math.round(shoalG)));
        rgba[outIdx + 2] = Math.max(0, Math.min(255, Math.round(shoalB)));
        rgba[outIdx + 3] = 255;
        continue;
      }
      const sx = (coastalSampleClamped(heights, x + 8, z, region) - coastalSampleClamped(heights, x - 8, z, region)) / 16;
      const sz = (coastalSampleClamped(heights, x, z + 8, region) - coastalSampleClamped(heights, x, z - 8, region)) / 16;
      const slope = Math.hypot(sx, sz);

      const veg = vegetationProbability(biomeMask, region.biomeSize, u, v);
      const fineGrain = (coastalValueNoise2D(u * 68, v * 68, seed ^ 0x55aa55aa) - 0.5) * 14;
      const canopyMottle = (coastalFbm2D(x * 0.0085, z * 0.0085, seed ^ 0x3c6ef372, 3) - 0.5) * 2;

      // Base inland colour: continuous blend between coastal earth, deep 1550 tropical rainforest canopy, and cliff stone
      const canopyBlend = coastalSmoothstep(0.08, 0.72, veg);
      const soilR = 88 + sandNoise * 6;
      const soilG = 96 + sandNoise * 6;
      const soilB = 64 + sandNoise * 4;
      const lushR = 29 + canopyMottle * 6 + fineGrain * 0.30;
      const lushG = 66 + canopyMottle * 10 + fineGrain * 0.40;
      const lushB = 30 + canopyMottle * 5 + fineGrain * 0.25;
      const forestR = soilR * (1 - canopyBlend) + lushR * canopyBlend;
      const forestG = soilG * (1 - canopyBlend) + lushG * canopyBlend;
      const forestB = soilB * (1 - canopyBlend) + lushB * canopyBlend;
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
        } else if (
          satelliteData?.is1550Orthophoto &&
          ((sat.r > 92 && sat.r - sat.g >= 18 && sat.r - sat.b >= 34) ||
            (inlandM <= 95 && sat.greenness < 0.08 && sat.luma < sat.localLuma * 0.85) ||
            (portPlacement && !portClearanceEnvelope(portPlacement, x, z, 8)))
        ) {
          // Replace 2D painted terracotta/shingle roof & shadow pixels on the ground beneath & between 3D colonial buildings
          // with warm 1550 Spanish colonial coral-limestone cobblestone & flagstone courtyard paving
          const reliefMod = Math.max(0.92, Math.min(1.10, (sat.luma * lift) / Math.max(48, sat.localLuma)));
          const cobbleR = (176 + fineGrain * 0.85) * reliefMod;
          const cobbleG = (158 + fineGrain * 0.75) * reliefMod;
          const cobbleB = (130 + fineGrain * 0.65) * reliefMod;
          const satBlend = coastalSmoothstep(0.15, 1.4, h) * 0.86;
          r = r * (1 - satBlend) + cobbleR * satBlend;
          g = g * (1 - satBlend) + cobbleG * satBlend;
          b = b * (1 - satBlend) + cobbleB * satBlend;
        } else {
          // Co-registered natural satellite orthophoto color (canopy, soil, rocky cliffs, and sandy berms),
          // fading smoothly near outer section borders so ground albedo matches stitched neighbor quads seamlessly.
          const edgeDist = Math.min(Math.min(u, 1 - u), Math.min(v, 1 - v));
          const borderFade = coastalSmoothstep(0.0, 0.14, edgeDist);
          const satBlend = coastalSmoothstep(0.15, 1.4, h) * 0.78 * borderFade;
          r = r * (1 - satBlend) + satR * satBlend;
          g = g * (1 - satBlend) + satG * satBlend;
          b = b * (1 - satBlend) + satB * satBlend;
        }
      }

      // Colonial waterfront plaza & town cobble apron (smooth radial blend, no hard ring)
      if (portPlacement && portPlacement.clearRadius > 0 && h > 0.2) {
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
      const hullMargin = portPlacement.hasOrthophotoFootprints ? 4 : 10;
      if (
        (!portPlacement.hasOrthophotoFootprints && distPort < portPlacement.clearRadius * 0.72) ||
        !portClearanceEnvelope(portPlacement, x, z, hullMargin)
      ) {
        continue;
      }
    }

    const sx = (coastalSampleClamped(heights, x + 12, z, region) - coastalSampleClamped(heights, x - 12, z, region)) / 24;
    const sz = (coastalSampleClamped(heights, x, z + 12, region) - coastalSampleClamped(heights, x, z - 12, region)) / 24;
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
    const isPalmClimate = region.climate === 'tropical' || region.climate === 'subtropical';
    const isLowlandOrInlandPalm = isPalmClimate && h <= 110 && (nearSandyShore || shape < 0.48);

    if ((h < 10.5 && nearSandyShore) || isLowlandOrInlandPalm) {
      // Foreshore coconut palm fringe (Cocos nucifera: 18-26m height) + lowland/inland Roystonea regia & Sabal palmetto palms
      const isPalm = isPalmClimate;
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
              ((portPlacement.hasOrthophotoFootprints ||
                Math.hypot(gx - portPlacement.center.x, gz - portPlacement.center.z) >=
                  portPlacement.clearRadius * 0.72) &&
                portClearanceEnvelope(portPlacement, gx, gz, portPlacement.hasOrthophotoFootprints ? 4 : 10)))
          ) {
            const gsx = (coastalSampleClamped(heights, gx + 12, gz, region) - coastalSampleClamped(heights, gx - 12, gz, region)) / 24;
            const gsz = (coastalSampleClamped(heights, gx, gz + 12, region) - coastalSampleClamped(heights, gx, gz - 12, region)) / 24;
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
  // (Uniform 257x257 mobile and 513x513 full-resolution grids avoid inner-square subdivision overhead)
  const subRadius = n === 257 || n >= 513 ? 0 : region.span * 0.22;
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
    const h = isCollinearEdge ? hLinear : coastalSampleClamped(heights, x, z, region);
    const eps = step / M;
    const dx = (coastalSampleClamped(heights, x - eps, z, region) - coastalSampleClamped(heights, x + eps, z, region)) / (2 * eps);
    const dz = (coastalSampleClamped(heights, x, z - eps, region) - coastalSampleClamped(heights, x, z + eps, region)) / (2 * eps);
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
        const useMainDiag = Math.abs(h00 - h11) < Math.abs(h10 - h01) - 0.01;
        if (hi > -0.5) {
          if (useMainDiag) {
            indices.push(k, k + n, k + n + 1, k, k + n + 1, k + 1);
          } else {
            indices.push(k, k + n, k + 1, k + 1, k + n, k + n + 1);
          }
        }
        if (lo < 0 && hi > -22) {
          if (useMainDiag) {
            submergedIndices.push(k, k + n, k + n + 1, k, k + n + 1, k + 1);
          } else {
            submergedIndices.push(k, k + n, k + 1, k + 1, k + n, k + n + 1);
          }
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

      const useSubMainDiag = Math.abs(h00 - h11) < Math.abs(h10 - h01) - 0.01;
      for (let sj = 0; sj < M; sj++) {
        for (let si = 0; si < M; si++) {
          const v00 = gridIdx(si, sj);
          const v10 = gridIdx(si + 1, sj);
          const v01 = gridIdx(si, sj + 1);
          const v11 = gridIdx(si + 1, sj + 1);
          if (hi > -0.5) {
            if (useSubMainDiag) {
              indices.push(v00, v01, v11, v00, v11, v10);
            } else {
              indices.push(v00, v01, v10, v10, v01, v11);
            }
          }
          if (lo < 0 && hi > -22) {
            if (useSubMainDiag) {
              submergedIndices.push(v00, v01, v11, v00, v11, v10);
            } else {
              submergedIndices.push(v00, v01, v10, v10, v01, v11);
            }
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
  const viewScale = Math.min(1, region.span / 3200);
  const rawHorizon = worldFromCoastalFrame(
    region,
    shoreAlong - 300 * viewScale,
    shoreInland - Math.max(2200, 9500 * viewScale)
  );
  const rawApproach = worldFromCoastalFrame(
    region,
    shoreAlong - 120 * viewScale,
    shoreInland - Math.max(720, 2600 * viewScale)
  );
  const rawCoast = worldFromCoastalFrame(region, shoreAlong, shoreInland - Math.max(240, 780 * viewScale));
  const rawHarbor = worldFromCoastalFrame(region, shoreAlong, shoreInland - Math.max(110, 260 * viewScale));

  const snapToNavigableBay = (pos) => {
    if (terrainSample(heights, pos.x, pos.z, region) <= -4.2) return pos;
    const n = region.size;
    const span = region.span;
    let bestX = pos.x, bestZ = pos.z, bestDist2 = Infinity;
    for (let j = 2; j < n - 2; j += 2) {
      const wz = region.z + (j / (n - 1) - 0.5) * span;
      for (let i = 2; i < n - 2; i += 2) {
        const wx = region.x + (i / (n - 1) - 0.5) * span;
        const h = heights[j * n + i];
        if (h <= -4.5) {
          const d2 = (wx - pos.x) * (wx - pos.x) + (wz - pos.z) * (wz - pos.z);
          if (d2 < bestDist2) {
            bestDist2 = d2;
            bestX = wx;
            bestZ = wz;
          }
        }
      }
    }
    return { x: bestX, z: bestZ };
  };

  const caravel = { length: 20, beam: 6, hydrodynamics: { draft: 2.1 } };
  const wrap = (pos, pitch = 1, snapBay = false) => {
    const startPos = snapBay ? snapToNavigableBay(pos) : pos;
    return safeLandfallStart(
      heights,
      { x: startPos.x, z: startPos.z, y: 6, yaw: heading, pitch, heading },
      caravel,
      region
    );
  };

  return Object.freeze({
    horizon: Object.freeze(wrap(rawHorizon, 1, false)),
    approach: Object.freeze(wrap(rawApproach, 4, false)),
    coast: Object.freeze(wrap(rawCoast, 1, true)),
    harbor: Object.freeze(wrap(rawHarbor, 1, true)),
  });
}

// Smooth stair-stepped / blocky DEM & 1550 coastline contours, eliminate the -1.8m..-2.0m
// shoreline cliff step via a continuous signed-distance littoral ramp, fill beach potholes
// (local depressions in coastal sand), and round unconnected outer borders into natural capes.
export function smoothCoastlineAndForeshoreBeaches(
  heights,
  region,
  { preservePortCore = null, connectedEdges = null, taperOuterBorders = false } = {}
) {
  const n = region.size;
  const span = region.span;
  const seed = region.seed || region.vegetationSeed || coastalHashCoords(region.latitude, region.longitude);

  const isPortProtected = (i, j) => {
    if (
      connectedEdges &&
      ((connectedEdges.west && i === 0) ||
        (connectedEdges.east && i === n - 1) ||
        (connectedEdges.north && j === 0) ||
        (connectedEdges.south && j === n - 1))
    ) {
      return true;
    }
    if (!preservePortCore) return false;
    const x = region.x + (i / (n - 1) - 0.5) * span;
    const z = region.z + (j / (n - 1) - 0.5) * span;
    return !portClearanceEnvelope(preservePortCore, x, z, 14);
  };

  // Pass 1: Morphological despeckling of 1-cell water pits on land/beaches and 1-cell dry spikes in water
  const work = new Float32Array(heights);
  for (let pass = 0; pass < 2; pass++) {
    for (let j = 1; j < n - 1; j++) {
      for (let i = 1; i < n - 1; i++) {
        if (isPortProtected(i, j)) continue;
        const k = j * n + i;
        const h = work[k];
        if (Math.abs(h) > 8.5) continue;
        let dryCount = 0, wetCount = 0;
        let drySum = 0, wetSum = 0;
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            if (di === 0 && dj === 0) continue;
            const nh = work[(j + dj) * n + (i + di)];
            if (nh > 0.28) {
              dryCount++;
              drySum += nh;
            } else if (nh <= 0.12) {
              wetCount++;
              wetSum += nh;
            }
          }
        }
        // Isolated water pit / pothole surrounded by dry beach or land
        if (h <= 0.25 && dryCount >= 5) {
          heights[k] = drySum / dryCount;
        } else if (h > 0.25 && h < 4.5 && wetCount >= 6) {
          // Isolated 1-cell dry speckle in bay
          heights[k] = wetSum / wetCount;
        }
      }
    }
    work.set(heights);
  }

  // Pass 2: Continuous signed-distance littoral ramp across the 0.0m shoreline contour
  // Eliminates the discontinuous jump from +0.25m..+2.4m down to -1.8m..-2.0m at shoreDistance=0
  const shoreDist = computeCoastalShoreDistances(heights, n, span, 0.25);
  const { distWater, distLand, step } = shoreDist;
  const sdf = new Float32Array(n * n);
  const sdfTmp = new Float32Array(n * n);
  for (let k = 0; k < n * n; k++) {
    sdf[k] = heights[k] > 0.25
      ? Math.max(0.1, distWater[k] - step * 0.45)
      : -Math.max(0.1, distLand[k] - step * 0.45);
  }

  // Smooth the signed distance field with 3 separable Gaussian [1, 2, 1]/4 passes
  // so the sdf = 0 contour is a C2 curve with zero grid-aligned staircase blockiness
  for (let iter = 0; iter < 3; iter++) {
    for (let j = 0; j < n; j++) {
      const row = j * n;
      sdfTmp[row] = sdf[row];
      sdfTmp[row + n - 1] = sdf[row + n - 1];
      for (let i = 1; i < n - 1; i++) {
        sdfTmp[row + i] = 0.25 * sdf[row + i - 1] + 0.5 * sdf[row + i] + 0.25 * sdf[row + i + 1];
      }
    }
    for (let j = 1; j < n - 1; j++) {
      const row = j * n;
      for (let i = 0; i < n; i++) {
        sdf[row + i] = 0.25 * sdfTmp[row - n + i] + 0.5 * sdfTmp[row + i] + 0.25 * sdfTmp[row + n + i];
      }
    }
  }

  const maxLittoralM = Math.max(48, step * 2.8);
  const maxBeachM = Math.max(44, step * 2.5);
  for (let j = 0; j < n; j++) {
    for (let i = 0; i < n; i++) {
      if (isPortProtected(i, j)) continue;
      const k = j * n + i;
      const s = sdf[k];
      const h = heights[k];
      if (s <= 0 && s >= -maxLittoralM && h < 5.5) {
        // Continuous multi-cell nearshore shoal ramp: 0.0m at s=0, ~-0.45m at 1st wet cell, -2.1m at maxLittoralM
        const dSea = -s;
        const uSea = Math.min(1, dSea / maxLittoralM);
        const targetSea = -(0.12 + 1.98 * Math.pow(uSea, 0.92));
        const wRamp = 1 - coastalSmoothstep(0.35, 1.0, uSea);
        heights[k] = h * (1 - wRamp) + Math.max(h, targetSea) * wRamp;
      } else if (s > 0 && s <= maxBeachM && h < 8.5) {
        // Continuous multi-cell foreshore beach ramp: 0.05m at s=0, ~+0.42m at 1st dry cell, rising smoothly inland
        const uLand = Math.min(1, s / maxBeachM);
        const minBeachFloor = 0.05 + 1.45 * uLand;
        const gentleBeachTarget = Math.max(minBeachFloor, Math.min(h, 0.08 + 2.35 * Math.pow(uLand, 0.92)));
        const wBeach = (1 - coastalSmoothstep(0.3, 1.0, uLand)) * (1 - coastalSmoothstep(5.0, 8.5, h));
        heights[k] = Math.max(minBeachFloor, h * (1 - wBeach * 0.78) + gentleBeachTarget * (wBeach * 0.78));
      }
    }
  }

  // Pass 3: Fill beach potholes (depression filling across coastal sand & low foreshore <= 185m from water)
  for (let iter = 0; iter < 3; iter++) {
    work.set(heights);
    for (let j = 1; j < n - 1; j++) {
      for (let i = 1; i < n - 1; i++) {
        if (isPortProtected(i, j)) continue;
        const k = j * n + i;
        const s = sdf[k];
        const h = work[k];
        if (s < -step * 1.5 || s > 185 || h > 8.2) continue;
        let sum8 = 0;
        let higherCount = 0;
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            if (di === 0 && dj === 0) continue;
            const nh = work[(j + dj) * n + (i + di)];
            sum8 += nh;
            if (nh > h + 0.04) higherCount++;
          }
        }
        const mean8 = sum8 * 0.125;
        // Fill local pothole / sunken pit if lower than neighbor mean
        if (h < mean8 - 0.025 && higherCount >= 4) {
          heights[k] = mean8 * 0.84 + h * 0.16;
        }
        // Enforce positive monotonic foreshore floor on dry side of smoothed contour so no puddle forms in a beach
        if (s > 0.25 && s <= 95 && heights[k] < 6.0) {
          const foreshoreFloor = Math.min(1.65, 0.06 + 0.022 * s);
          if (heights[k] < foreshoreFloor) {
            heights[k] = foreshoreFloor;
          }
        }
      }
    }
  }

  // Pass 4: Isotropic 3x3 Gaussian contour polish along the littoral & beach zone (|sdf| <= 52m, |h| <= 6.5m)
  const smoothBandM = Math.max(46, step * 3.4);
  for (let iter = 0; iter < 2; iter++) {
    work.set(heights);
    for (let j = 1; j < n - 1; j++) {
      for (let i = 1; i < n - 1; i++) {
        if (isPortProtected(i, j)) continue;
        const k = j * n + i;
        const s = sdf[k];
        const h = work[k];
        if (Math.abs(s) > smoothBandM || h > 6.5 || h < -8.0) continue;
        const g =
          (work[(j - 1) * n + (i - 1)] +
            2 * work[(j - 1) * n + i] +
            work[(j - 1) * n + (i + 1)] +
            2 * work[j * n + (i - 1)] +
            4 * h +
            2 * work[j * n + (i + 1)] +
            work[(j + 1) * n + (i - 1)] +
            2 * work[(j + 1) * n + i] +
            work[(j + 1) * n + (i + 1)]) *
          0.0625;
        const w = (1 - coastalSmoothstep(smoothBandM * 0.45, smoothBandM, Math.abs(s))) * (1 - coastalSmoothstep(4.2, 6.5, Math.max(0, h)));
        heights[k] = h * (1 - w * 0.82) + g * (w * 0.82);
      }
    }
  }

  // Optional Pass 5: Round any unconnected outer world boundary into a natural cape/shoal
  if (taperOuterBorders) {
    const connW = Boolean(connectedEdges?.west);
    const connE = Boolean(connectedEdges?.east);
    const connN = Boolean(connectedEdges?.north);
    const connS = Boolean(connectedEdges?.south);
    for (let j = 0; j < n; j++) {
      const v = j / (n - 1);
      const z = region.z + (v - 0.5) * span;
      for (let i = 0; i < n; i++) {
        const u = i / (n - 1);
        const x = region.x + (u - 0.5) * span;
        let dEdge = 1.0;
        if (!connW && u < dEdge) dEdge = u;
        if (!connE && 1 - u < dEdge) dEdge = 1 - u;
        if (!connN && v < dEdge) dEdge = v;
        if (!connS && 1 - v < dEdge) dEdge = 1 - v;
        if (dEdge >= 0.11) continue;
        const k = j * n + i;
        if (heights[k] <= -14) continue;
        const capeNoise = coastalFbm2D(x * 0.0022, z * 0.0022, seed + 941, 2);
        const margin = 0.055 + 0.045 * capeNoise;
        if (dEdge >= margin) continue;
        const t = coastalSmoothstep(0.0, margin, dEdge);
        const shelfDepth = -16 - (1 - t) * 8;
        heights[k] = shelfDepth * (1 - t) + heights[k] * t;
      }
    }
  }
  return heights;
}

function finalizeProceduralCoastalPack(
  pack,
  heights,
  elevationSource = 'procedural-geomorphology',
  satelliteData = null,
  preserveRealCoast = false
) {
  const { region } = pack;
  if (!pack.skipPortPlacement && !pack.taperOuterBorders) {
    const dirs = detectCoastalContinuationDirs(heights, region.size, region.shoreBearing);
    const dirSet = new Set(dirs.map((d) => `${d.dx},${d.dz}`));
    const autoConnected = pack.connectedEdges || {
      west: dirSet.has('-1,0'),
      east: dirSet.has('1,0'),
      north: dirSet.has('0,-1'),
      south: dirSet.has('0,1'),
    };
    pack.connectedEdges = autoConnected;
    prepareSectionConnectedBorders(heights, region.size, autoConnected);
  }
  // Retain un-tapered raw heights so adjacent streaming sections stitch C0/C1-continuously
  pack.rawHeights = new Float32Array(heights);
  smoothCoastlineAndForeshoreBeaches(heights, region, {
    connectedEdges: pack.connectedEdges || null,
    taperOuterBorders: Boolean(pack.taperOuterBorders),
  });
  const preShoreDist = computeCoastalShoreDistances(heights, region.size, region.span, 0.25);
  const port = pack.skipPortPlacement
    ? {
        regionId: region.id,
        name: region.name,
        era: 1550,
        center: { x: region.x, z: region.z, elevation: 2.5, shoreAlong: 0 },
        berth: { x: region.x, z: region.z, depth: 8, heading: region.shoreBearing ?? 112 },
        clearRadius: 0,
        instances: [],
      }
    : placeCoastalPort(region, heights, { preserveRealCoast, satelliteData, shoreDist: preShoreDist });
  if (!pack.skipPortPlacement) {
    smoothCoastlineAndForeshoreBeaches(heights, region, {
      preservePortCore: port,
      connectedEdges: pack.connectedEdges || null,
      taperOuterBorders: Boolean(pack.taperOuterBorders),
    });
  }
  const shoreDist = computeCoastalShoreDistances(heights, region.size, region.span, 0.25);
  const beaches = synthesizeCoastalBeaches(region, heights, satelliteData, shoreDist);
  const mesh = buildCoastalMesh(region, heights, beaches, shoreDist);
  const biome = synthesizeCoastalBiome(region, heights, beaches, port, satelliteData);
  const albedo = synthesizeCoastalAlbedo(region, heights, beaches, port, biome, satelliteData, shoreDist);
  const vegetation = seedCoastalVegetation(region, heights, biome, beaches, port, 5, shoreDist);
  const portGeometry = buildPortPrefabGeometry(port, vegetation.palms);
  const views = pack.skipPortPlacement ? null : createCoastalViews(region, heights, port);

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

let _cachedCoastlineRings = null;
async function loadCoastlineRingsForSnap(fetchFn) {
  if (_cachedCoastlineRings) return _cachedCoastlineRings;
  try {
    const res = await fetchFn('assets/world/land.json');
    if (res && res.ok) {
      _cachedCoastlineRings = await res.json();
      return _cachedCoastlineRings;
    }
  } catch { /* ignore */ }
  return null;
}

export function snapCoordinateToCoastlineRings(lat, lon, rings, maxDeg = 3.5) {
  if (!Array.isArray(rings) || rings.length === 0) return null;
  const cosLat = Math.max(0.1, Math.cos(lat * COASTAL_DEG_TO_RAD));
  let bestLat = lat, bestLon = lon, bestScore = Infinity;
  for (const ring of rings) {
    if (!Array.isArray(ring) || ring.length < 2) continue;
    for (let i = 0; i < ring.length - 1; i++) {
      const [x0, y0] = ring[i];
      const [x1, y1] = ring[i + 1];
      const dx = x1 - x0, dy = y1 - y0;
      const lenSq = dx * dx + dy * dy;
      const t = lenSq > 1e-12 ? Math.max(0, Math.min(1, ((lon - x0) * dx + (lat - y0) * dy) / lenSq)) : 0;
      const px = x0 + t * dx;
      const py = y0 + t * dy;
      const dLon = (px - lon) * cosLat;
      const dLat = py - lat;
      const degDist = Math.hypot(dLon, dLat);
      if (degDist > maxDeg) continue;
      // Weight latitude 2.4x so inland clicks on a peninsula snap East/West to the coast at the same latitude
      const score = Math.hypot(dLon, dLat * 2.4);
      if (score < bestScore) {
        bestScore = score;
        bestLat = Number(py.toFixed(4));
        bestLon = Number(px.toFixed(4));
      }
    }
  }
  return bestScore < Infinity ? { latitude: bestLat, longitude: bestLon } : null;
}

// Search a ~300km x 300km regional AWS Terrarium DEM mosaic (2x2 tiles at zoom 8)
// to locate the true 0m shoreline for ANY inland or offshore coordinate worldwide.
export async function findNearestCoastlineInRealDEM(lat, lon, fetchFn = null, _triedWest = false) {
  const effectiveFetch = fetchFn || (typeof fetch === 'function' && typeof createImageBitmap === 'function' ? fetch : null);
  if (!effectiveFetch) return null;
  const z = 8;
  const nTiles = 2 ** z;
  const fx = ((lon + 180) / 360) * nTiles;
  const rLat = Math.max(-85, Math.min(85, lat)) * COASTAL_DEG_TO_RAD;
  const fy = ((1 - Math.log(Math.tan(rLat) + 1 / Math.cos(rLat)) / Math.PI) / 2) * nTiles;
  const tx0 = Math.floor(fx - 0.5);
  const ty0 = Math.max(0, Math.min(nTiles - 2, Math.floor(fy - 0.5)));
  const w = 512, h = 512;
  try {
    const reqs = [];
    for (let ty = ty0; ty <= ty0 + 1; ty++) {
      for (let tx = tx0; tx <= tx0 + 1; tx++) {
        const wrappedX = ((tx % nTiles) + nTiles) % nTiles;
        const url = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${wrappedX}/${ty}.png`;
        reqs.push(
          Promise.resolve(effectiveFetch(url, { mode: 'cors' })).then(async (res) => {
            if (res instanceof Uint8Array || res instanceof Uint8ClampedArray) return { tx, ty, rgba: res };
            if (!res?.ok) return null;
            const bmp = await createImageBitmap(await res.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
            return { tx, ty, bmp };
          }).catch(() => null)
        );
      }
    }
    const loaded = await Promise.all(reqs);
    if (!loaded.every(Boolean)) {
      for (const item of loaded) item?.bmp?.close?.();
      return null;
    }
    const pixels = rasterizeTileGrid(loaded, tx0, ty0, w, h);
    const elev = new Float32Array(w * h);
    for (let i = 0; i < w * h; i++) {
      const k = i * 4;
      elev[i] = pixels[k] * 256 + pixels[k + 1] + pixels[k + 2] / 256 - 32768;
    }
    const cx = (fx - tx0) * 256;
    const cy = (fy - ty0) * 256;
    let bestPx = -1, bestPy = -1, bestScore = Infinity;
    for (let py = 4; py < h - 4; py++) {
      for (let px = 4; px < w - 4; px++) {
        const e = elev[py * w + px];
        if (e <= 0.35 || e > 250) continue;
        // Require adjacent sea-level water (<= 0.05m) AND open water 3 pixels (~1.6km) further in that direction
        const hasWater =
          (elev[py * w + (px - 1)] <= 0.05 && elev[py * w + (px - 3)] <= 0.0) ||
          (elev[py * w + (px + 1)] <= 0.05 && elev[py * w + (px + 3)] <= 0.0) ||
          (elev[(py - 1) * w + px] <= 0.05 && elev[(py - 3) * w + px] <= 0.0) ||
          (elev[(py + 1) * w + px] <= 0.05 && elev[(py + 3) * w + px] <= 0.0);
        if (!hasWater) continue;
        const dx = px - cx;
        const dy = (py - cy) * 2.0; // Prefer East/West coast snap at the same latitude
        const score = dx * dx + dy * dy;
        if (score < bestScore) {
          bestScore = score;
          bestPx = px;
          bestPy = py;
        }
      }
    }
    if (bestPx >= 0) {
      const outTileX = tx0 + (bestPx + 0.5) / 256;
      const outTileY = ty0 + (bestPy + 0.5) / 256;
      const outLon = (outTileX / nTiles) * 360 - 180;
      const nMerc = Math.PI - (2 * Math.PI * outTileY) / nTiles;
      const outLat = Math.atan(0.5 * (Math.exp(nMerc) - Math.exp(-nMerc))) * COASTAL_RAD_TO_DEG;
      return { latitude: Number(outLat.toFixed(4)), longitude: Number(outLon.toFixed(4)) };
    }
    // If user typed a positive longitude (e.g. 81.312 instead of -81.312 for 81.312°W) that landed in landlocked Eurasia, try -lon!
    if (!_triedWest && lon > 30 && lon < 130 && lat > 5 && lat < 50) {
      return findNearestCoastlineInRealDEM(lat, -lon, effectiveFetch, true);
    }
  } catch { /* ignore */ }
  return null;
}

const _terrariumTileRgbaCache = new Map();

function fetchCachedTerrariumTileRgba(demUrl, signal) {
  let cached = _terrariumTileRgbaCache.get(demUrl);
  if (cached) return cached;
  const p = fetch(demUrl, { signal, mode: 'cors' })
    .then(async (res) => {
      if (!res?.ok) throw new Error(`Terrarium HTTP ${res?.status}`);
      const bmp = await createImageBitmap(await res.blob(), {
        premultiplyAlpha: 'none',
        colorSpaceConversion: 'none',
      });
      const canvas =
        typeof OffscreenCanvas === 'function'
          ? new OffscreenCanvas(256, 256)
          : Object.assign(document.createElement('canvas'), { width: 256, height: 256 });
      const ctx = canvas.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0);
      bmp.close();
      const rgba = new Uint8ClampedArray(256 * 256 * 4);
      rgba.set(ctx.getImageData(0, 0, 256, 256).data);
      return rgba;
    })
    .catch((err) => {
      _terrariumTileRgbaCache.delete(demUrl);
      throw err;
    });
  if (_terrariumTileRgbaCache.size >= 96) {
    const oldestKey = _terrariumTileRgbaCache.keys().next().value;
    _terrariumTileRgbaCache.delete(oldestKey);
  }
  _terrariumTileRgbaCache.set(demUrl, p);
  return p;
}

// Fetch real high-resolution SRTM/NED/ETOPO1 elevation tiles from AWS Terrarium
// (zoom 13 = ~18m resolution) AND co-registered Esri World Imagery
// satellite orthophoto tiles (https://services.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x})
// in parallel. Applies Saba's coastal bathymetry skirt model and spectral satellite
// auto-placement of 3D forests, coconut palms, and sandy beaches.
export async function upgradeProceduralPackWithRealDEM(
  pack,
  { fetchTile = null, fetchSatelliteTile = null, zoom = 13, demSpan = null, timeoutMs = 12000, _snapAttempted = false, isNeighborSection = false } = {}
) {
  const ensureFallback = (p) => (p?.heights ? p : p?.region ? finalizeProceduralCoastalPack(p, synthesizeCoastalTerrain(p.region)) : p);
  const effectiveFetch = fetchTile || (typeof fetch === 'function' && typeof createImageBitmap === 'function' ? fetch : null);
  if (!pack?.region || !effectiveFetch) return ensureFallback(pack);
  let { region } = pack;
  const n = region.size;
  const span = region.span;
  const sampleSpan = demSpan || span;
  const cosLat = Math.max(0.1, Math.cos(region.latitude * COASTAL_DEG_TO_RAD));
  const halfLat = (sampleSpan * 0.51) / 111195;
  const halfLon = (sampleSpan * 0.51) / (111195 * cosLat);
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
    const lrmPromise = !fetchTile ? load1550BuildingLRMTemplates() : Promise.resolve(null);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    const w = cols * 256;
    const h = rows * 256;
    const tilePromises = [];
    const satPromises = [];
    const wantSatellite =
      !isNeighborSection &&
      Boolean(fetchSatelliteTile || (!fetchTile && typeof fetch === 'function' && typeof createImageBitmap === 'function'));

    for (let ty = ty0; ty <= ty1; ty++) {
      for (let tx = tx0; tx <= tx1; tx++) {
        const wrappedX = ((tx % numTiles) + numTiles) % numTiles;
        const demUrl = `https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${zoom}/${wrappedX}/${ty}.png`;
        tilePromises.push(
          fetchTile
            ? Promise.resolve(fetchTile(demUrl, { tx: wrappedX, ty, zoom, signal: controller.signal })).then(async (res) => {
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
            : fetchCachedTerrariumTileRgba(demUrl, controller.signal).then((rgba) => ({ tx, ty, rgba }))
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

    // Single uniform tile grid across the entire territory (no inner 2x2 Z14 square composite seam)
    const nearZoom = zoom + 1;
    const nearDemPromises = [];

    const [loaded, satLoaded, nearDemLoaded] = await Promise.all([
      Promise.all(tilePromises),
      satPromises.length ? Promise.all(satPromises) : Promise.resolve([]),
      nearDemPromises.length ? Promise.all(nearDemPromises) : Promise.resolve([]),
    ]);
    clearTimeout(timer);
    await lrmPromise;

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
    const landElevs = [];
    let sumWaterX = 0, sumWaterZ = 0, waterCount = 0;
    let sumLandX = 0, sumLandZ = 0;
    for (let j = 0; j < n; j++) {
      const vNorm = j / (n - 1) - 0.5;
      const z = region.z + vNorm * span;
      const lat = region.latitude - (vNorm * sampleSpan) / 111195;
      for (let i = 0; i < n; i++) {
        const uNorm = i / (n - 1) - 0.5;
        const x = region.x + uNorm * span;
        const lon = region.longitude + (uNorm * sampleSpan) / (111195 * cosLat);
        const elev = sampleTerrarium(lat, lon);
        rawDem[j * n + i] = elev;
        if (elev > 0.25) {
          landCount++;
          sumLandX += x - region.x;
          sumLandZ += z - region.z;
          if ((i + j) % 2 === 0) landElevs.push(elev);
        } else {
          waterCount++;
          sumWaterX += x - region.x;
          sumWaterZ += z - region.z;
        }
        if (elev > maxDem) maxDem = elev;
      }
    }
    const landRatio = landCount / (n * n);
    // If user clicked or entered coordinates slightly inland (landRatio > 0.94) or offshore (landRatio < 0.02),
    // search the surrounding ~300km x 300km real AWS Terrarium Zoom-8 DEM to snap to the true 0m shoreline and retry once!
    if (!isNeighborSection && (landRatio < 0.02 || landRatio > 0.94) && !_snapAttempted && !fetchTile && typeof fetch === 'function') {
      for (const item of satLoaded) item?.bmp?.close?.();
      let snapped = await findNearestCoastlineInRealDEM(region.latitude, region.longitude, fetch);
      if (!snapped) {
        const rings = await loadCoastlineRingsForSnap(fetch);
        snapped = snapCoordinateToCoastlineRings(region.latitude, region.longitude, rings, 3.5);
      }
      if (snapped && (Math.abs(snapped.latitude - region.latitude) > 1e-3 || Math.abs(snapped.longitude - region.longitude) > 1e-3)) {
        pack.region = resolveGlobalCoastalRegion({
          ...region,
          latitude: snapped.latitude,
          longitude: snapped.longitude,
          ...(snapped.shoreBearing !== undefined ? { shoreBearing: snapped.shoreBearing } : {}),
        });
        return upgradeProceduralPackWithRealDEM(pack, { fetchTile, fetchSatelliteTile, zoom, demSpan, timeoutMs, _snapAttempted: true });
      }
    }
    // Require real land and real water in the primary coastal window (neighbor sections preserve any real DEM land/water ratio!)
    if (!isNeighborSection && (landRatio < 0.015 || landRatio > 0.97 || maxDem < 0.35)) {
      for (const item of satLoaded) item?.bmp?.close?.();
      return ensureFallback(pack);
    }

    // Damp SRTM tree-canopy / bridge radar spikes on flat low-lying coastal plains (e.g. Florida barrier islands where median land < 7m)
    if (!isNeighborSection) {
      landElevs.sort((a, b) => a - b);
      const medLand = landElevs.length ? landElevs[Math.floor(landElevs.length * 0.5)] : 5;
      if (medLand < 7.0) {
        const softCap = Math.max(4.0, medLand + 3.0);
        maxDem = 0;
        for (let k = 0; k < n * n; k++) {
          if (rawDem[k] > softCap) {
            rawDem[k] = softCap + (rawDem[k] - softCap) * 0.22;
          }
          if (rawDem[k] > maxDem) maxDem = rawDem[k];
        }
      }
    }

    // Infer true shoreBearing from the real DEM water-to-land center of mass for custom coordinates
    if (!isNeighborSection && !Object.hasOwn(SPANISH_MAIN_1550_REGIONS, region.id) && waterCount > 50 && landCount > 50) {
      const dx = sumLandX / landCount - sumWaterX / waterCount;
      const dz = sumLandZ / landCount - sumWaterZ / waterCount;
      const demBearing = Math.round(((Math.atan2(dx, -dz) * COASTAL_RAD_TO_DEG) % 360 + 360) % 360);
      region = Object.freeze({
        ...region,
        shoreBearing: demBearing,
        peakElevationMetres: Math.max(4, Math.round(maxDem)),
      });
      pack.region = region;
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
  const baseRegion = resolveGlobalCoastalRegion(basePack.region);
  const satSource = options.orthophoto1550 || basePack.satelliteData || null;
  const hasDedicated1550Ortho = Boolean(options.orthophoto1550);
  const rawPrecomputedFootprints = options.precomputedFootprints || satSource?.precomputedFootprints || null;

  // Validate physical ground scale (metersPerPixel & spanM) of the AI 1550 orthophoto / footprints
  const scaleInfo =
    hasDedicated1550Ortho || rawPrecomputedFootprints
      ? validateOrthophotoScale1550(
          baseRegion,
          satSource ? { ...satSource, is1550Orthophoto: hasDedicated1550Ortho } : null,
          rawPrecomputedFootprints
        )
      : { spanM: baseRegion.span, metersPerPixel: Number((baseRegion.span / 1024).toFixed(3)), footprintScale: 1 };

  const region =
    scaleInfo.spanM !== baseRegion.span
      ? resolveGlobalCoastalRegion({ ...baseRegion, span: scaleInfo.spanM })
      : baseRegion;
  const precomputedFootprints =
    rawPrecomputedFootprints && Math.abs(scaleInfo.footprintScale - 1) > 1e-3
      ? {
          ...rawPrecomputedFootprints,
          span: region.span,
          metersPerPixel: scaleInfo.metersPerPixel,
          footprints: rawPrecomputedFootprints.footprints.map((fp) => ({
            ...fp,
            width: Number((fp.width * scaleInfo.footprintScale).toFixed(1)),
            length: Number((fp.length * scaleInfo.footprintScale).toFixed(1)),
            inlandM: Number(((fp.inlandM ?? 64) * scaleInfo.footprintScale).toFixed(1)),
          })),
        }
      : rawPrecomputedFootprints;

  const n = region.size;
  const span = region.span;
  const seed = region.seed || region.vegetationSeed || coastalHashCoords(region.latitude, region.longitude);

  let heights1550 = options.precomputedHeights1550 || null;
  let lowCoastalCells = 0;
  let reclaimedCellsCarved = 0;

  if (!heights1550) {
    const rawBaseHeights = basePack.heights;
    let baseHeights = rawBaseHeights;
    if (rawBaseHeights && Math.abs(region.span - baseRegion.span) > 1.0) {
      baseHeights = new Float32Array(n * n);
      for (let j = 0; j < n; j++) {
        const z = region.z + (j / (n - 1) - 0.5) * span;
        for (let i = 0; i < n; i++) {
          const x = region.x + (i / (n - 1) - 0.5) * span;
          baseHeights[j * n + i] = terrainSample(rawBaseHeights, x, z, baseRegion);
        }
      }
    }
    const baseShoreDist = computeCoastalShoreDistances(baseHeights, n, span, 0.25);
    const { distWater, step } = baseShoreDist;

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
        const portClear = basePack.port ? portClearanceEnvelope(basePack.port, x, z) : 0;
        const inBastionCore = portClear > 0.45;

        if (h > 0.25) {
          // High-frequency canopy & headland ridge micro-relief (Depth-Anything V2 high-pass detail proxy)
          const ridgeDetail =
            (coastalUberNoise2D(x * 0.0055, z * 0.0055, seed + 701, 3, 0.38) - 0.48) * 3.2 +
            (sat ? (sat.greenness - 0.22) * 2.1 : 0);

          if (h <= 6.2 && inlandM <= 340 && !inBastionCore) {
            lowCoastalCells++;
            // Shadow-proof 1550 water check: includes deep teal bay & tributary river channels (e.g. Havana Bay, Río Ozama)
            const is1550Water =
              hasDedicated1550Ortho &&
              sat &&
              ((sat.b - sat.r >= 6 && sat.b >= sat.g * 0.76 && sat.luma < 185 && sat.luma >= 15) ||
                (sat.b - sat.r >= 9 && sat.b >= sat.g * 0.70 && sat.g - sat.b <= 18 && sat.luma < 180 && sat.luma >= 16) ||
                (sat.g - sat.r >= 12 && sat.b - sat.r >= 5 && sat.b >= 55 && sat.b >= sat.g * 0.73 && sat.luma < 180));
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
                (h <= 2.2 && inlandM <= 36 && creekNoise < 0.28));

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
          // Natural 1550 headland/inland relief with sharpened bluffs and old-growth canopy domes (kept subtle on flat barrier islands)
          const reliefBoost =
            h > 7.5 ? ridgeDetail * 0.85 : Math.max(-0.25, ridgeDetail * Math.min(0.45, Math.max(0.06, (h - 1.5) * 0.07)));
          carvedDem[k] = Math.max(0.45, Math.min(895, h + reliefBoost));
        } else {
          // If 1550 orthophoto shows land/forest/settlement here, elevate above sea level
          const is1550Land =
            hasDedicated1550Ortho &&
            sat &&
            !((sat.b - sat.r >= 6 && sat.b >= sat.g * 0.76 && sat.luma < 185) ||
              (sat.b - sat.r >= 9 && sat.b >= sat.g * 0.70 && sat.g - sat.b <= 18 && sat.luma < 180) ||
              (sat.g - sat.r >= 12 && sat.b - sat.r >= 5 && sat.b >= 55 && sat.b >= sat.g * 0.73 && sat.luma < 180));
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
  // Step 3: Build 100% De-Urbanized 1550 Orthophoto Imagery Seed
  let sat1550 = satSource
    ? { ...satSource, is1550Orthophoto: hasDedicated1550Ortho, precomputedFootprints }
    : precomputedFootprints
      ? { is1550Orthophoto: true, precomputedFootprints }
      : null;
  if (satSource && !hasDedicated1550Ortho) {
    const shoreDist1550 = computeCoastalShoreDistances(heights1550, n, span, 0.25);
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
    span: region.span,
    metersPerPixel: scaleInfo.metersPerPixel,
    restoredEstuaryPct,
    reclaimedCellsCarved,
    palmCount: upgradedPack.vegetation?.stats?.palmCount ?? 0,
    beachCellCount: upgradedPack.beaches?.beachCellCount ?? 0,
    hasOrthophoto1550: hasDedicated1550Ortho,
    baseElevationSource: basePack.elevationSource || 'procedural-geomorphology',
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

  // Reject unverified legacy R2 cache entries that were baked from synthetic procedural fallback before real-DEM verification
  const isVerifiedCache = Boolean(
    meta.curated1550 ||
    meta.baseElevationSource?.startsWith('aws-terrarium') ||
    basePack.elevationSource === 'procedural-geomorphology' ||
    basePack.elevationSource === 'pending-dem'
  );
  if (!isVerifiedCache) return null;

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
      ? {
          clusterU: meta.clusterU,
          clusterV: meta.clusterV,
          span: meta.span,
          metersPerPixel: meta.metersPerPixel,
          footprints: meta.footprints,
        }
      : null;
  const built = build1550HistoricalTerritoryPack(basePack, {
    orthophoto1550,
    discoveredAt: meta.discoveredAt,
    precomputedHeights1550: heights1550,
    precomputedFootprints,
  });
  built.territory1550 = {
    ...built.territory1550,
    ...meta,
    span: built.region.span,
    metersPerPixel: built.territory1550.metersPerPixel,
    footprints: precomputedFootprints?.footprints || built.territory1550.footprints,
  };
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
  const ensureBaseDem = async () => {
    if (
      (basePack.elevationSource === 'procedural-geomorphology' || basePack.elevationSource === 'pending-dem' || !basePack.heights) &&
      fetchImpl &&
      typeof createImageBitmap === 'function'
    ) {
      await upgradeProceduralPackWithRealDEM(basePack, { timeoutMs: 10000 });
    }
    if (!basePack.heights && basePack.region) {
      finalizeProceduralCoastalPack(basePack, synthesizeCoastalTerrain(basePack.region));
    }
  };
  const cellInfo = canonicalCoastalCellId(basePack.region);
  const lrmPromise = load1550BuildingLRMTemplates(fetchImpl);
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
  await lrmPromise;

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
    const [orthophoto1550, packBuf] = await Promise.all([
      loadOrthophoto1550(),
      remoteAvailable && fetchImpl
        ? fetchImpl(`${apiBase}/landfall-pack?cell=${encodeURIComponent(cellInfo.cellId)}&v=5`)
            .then((res) => (res && res.ok ? res.arrayBuffer() : null))
            .then((ab) => (ab ? new Uint8Array(ab) : null))
            .catch(() => null)
        : Promise.resolve(null),
    ]);
    if (packBuf) {
      try {
        upgradedPack = apply1550TerritoryCachePayload(basePack, packBuf, orthophoto1550);
      } catch { /* fallback to local rebuild */ }
    }
    if (!upgradedPack) {
      await ensureBaseDem();
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

  await ensureBaseDem();
  // First Explorer path! Notify the player immediately that they are the first mariner here
  onFirstExplorer?.({
    cellId: cellInfo.cellId,
    name: cellInfo.name,
    coordLabel: cellInfo.coordLabel,
    discoveredAt,
  });

  // Yield a frame so the First Explorer banner renders smoothly while the ship sails at 60 FPS
  await new Promise((resolve) => setTimeout(resolve, 16));
  onProgress?.({
    stage: 'orthophoto',
    message: `Analyzing satellite coast & 1550 mangrove channels for ${cellInfo.name}…`,
  });

  const orthophoto1550 = await loadOrthophoto1550();
  await new Promise((resolve) => setTimeout(resolve, 16));
  onProgress?.({
    stage: 'carving',
    message: 'Removing modern coastal fill & reconstructing 1550 relief, beaches and primary canopy…',
  });

  await new Promise((resolve) => setTimeout(resolve, 16));
  const upgradedPack = build1550HistoricalTerritoryPack(basePack, { orthophoto1550, discoveredAt });
  upgradedPack.territory1550.visits = 1;
  upgradedPack.territory1550.isFirstExplorer = true;

  // Cache the newly built 1550 territory in Cloudflare R2 (ONLY if built from real SRTM DEM, never synthetic fallback!)
  const payload = encode1550TerritoryCachePayload(upgradedPack);
  const isRealDemBacked = basePack.elevationSource !== 'procedural-geomorphology' || Boolean(orthophoto1550);
  if (remoteAvailable && fetchImpl && isRealDemBacked) {
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

// Inspect a section's border elevations to determine which neighboring sections (secX + dx, secZ + dz)
// continue the coastline or landmass across the section boundary (including diagonal corners and 2nd-ring coastal horizon).
export function detectCoastalContinuationDirs(heights, n, shoreBearing = 112) {
  if (!heights || heights.length < n * n) return [];
  const inset1 = Math.min(4, Math.max(1, Math.floor(n * 0.03)));
  const inset2 = Math.min(12, Math.max(2, Math.floor(n * 0.075)));
  const inset3 = Math.min(36, Math.max(4, Math.floor(n * 0.105)));
  const inset4 = Math.min(72, Math.max(6, Math.floor(n * 0.135)));
  let westLand = 0, eastLand = 0, northLand = 0, southLand = 0;
  for (let t = 0; t < n; t++) {
    const hw = Math.max(heights[t * n], heights[t * n + inset1], heights[t * n + inset2], heights[t * n + inset3], heights[t * n + inset4]);
    const he = Math.max(heights[t * n + (n - 1)], heights[t * n + (n - 1 - inset1)], heights[t * n + (n - 1 - inset2)], heights[t * n + (n - 1 - inset3)], heights[t * n + (n - 1 - inset4)]);
    const hn = Math.max(heights[t], heights[inset1 * n + t], heights[inset2 * n + t], heights[inset3 * n + t], heights[inset4 * n + t]);
    const hs = Math.max(heights[(n - 1) * n + t], heights[(n - 1 - inset1) * n + t], heights[(n - 1 - inset2) * n + t], heights[(n - 1 - inset3) * n + t], heights[(n - 1 - inset4) * n + t]);
    if (hw > 0.25) westLand++;
    if (he > 0.25) eastLand++;
    if (hn > 0.25) northLand++;
    if (hs > 0.25) southLand++;
  }
  const rad = (shoreBearing ?? 112) * COASTAL_DEG_TO_RAD;
  const shoreDirX = Math.sin(rad);
  const shoreDirZ = -Math.cos(rad);
  const tangX = -shoreDirZ;
  const tangZ = shoreDirX;

  const minLandCells = Math.max(2, Math.floor(n * 0.025));
  const candidates = [
    { dx: -1, dz: 0, edge: 'west', land: westLand },
    { dx: 1, dz: 0, edge: 'east', land: eastLand },
    { dx: 0, dz: -1, edge: 'north', land: northLand },
    { dx: 0, dz: 1, edge: 'south', land: southLand },
  ];
  // Only stream sections across borders that actually carry land or coastline (never spawn islands in open ocean!)
  const active = candidates.filter((c) => c.land >= minLandCells);
  active.sort((a, b) => {
    const aCoastMix = a.land > 0 && a.land < n * 0.92 ? 1000 : 0;
    const bCoastMix = b.land > 0 && b.land < n * 0.92 ? 1000 : 0;
    const aTang = Math.abs(a.dx * tangX + a.dz * tangZ) * 200;
    const bTang = Math.abs(b.dx * tangX + b.dz * tangZ) * 200;
    return (bCoastMix + bTang + b.land) - (aCoastMix + aTang + a.land);
  });

  const out = active.map(({ dx, dz, edge, land }) => ({ dx, dz, edge, landCells: land }));
  const hasEdge = new Set(out.map((d) => `${d.dx},${d.dz}`));

  // Automatically include diagonal inland/coastal corner sections whenever both adjacent cardinal edges have land
  const diagCandidates = [
    { dx: -1, dz: -1, edge: 'northwest', c1: '-1,0', c2: '0,-1', land: Math.min(westLand, northLand) },
    { dx: 1, dz: -1, edge: 'northeast', c1: '1,0', c2: '0,-1', land: Math.min(eastLand, northLand) },
    { dx: -1, dz: 1, edge: 'southwest', c1: '-1,0', c2: '0,1', land: Math.min(westLand, southLand) },
    { dx: 1, dz: 1, edge: 'southeast', c1: '1,0', c2: '0,1', land: Math.min(eastLand, southLand) },
  ];
  for (const d of diagCandidates) {
    if (hasEdge.has(d.c1) && hasEdge.has(d.c2)) {
      out.push({ dx: d.dx, dz: d.dz, edge: d.edge, landCells: d.land });
      hasEdge.add(`${d.dx},${d.dz}`);
    }
  }

  const pushUnique = (dx, dz, edge, landCells) => {
    const key = `${dx},${dz}`;
    if (!hasEdge.has(key)) {
      hasEdge.add(key);
      out.push({ dx, dz, edge, landCells });
    }
  };
  // Include coastal bay/island flanking corners along active longitudinal borders (e.g. Southwest (-1, 1) for Isla de Tierra Bomba)
  if (hasEdge.has('0,1')) {
    pushUnique(-1, 1, 'southwest', southLand);
    pushUnique(1, 1, 'southeast', Math.max(eastLand, southLand));
  }
  if (hasEdge.has('0,-1') && hasEdge.has('1,0')) {
    pushUnique(1, -1, 'northeast', Math.min(eastLand, northLand));
  }
  // Extend a 2nd coastal ring along active lateral and longitudinal shorelines so distant coastlines remain visible from the boat viewpoint
  if (hasEdge.has('-1,0')) {
    pushUnique(-2, 0, 'west-2', westLand);
    if (hasEdge.has('-1,-1')) pushUnique(-2, -1, 'northwest-2', Math.min(westLand, northLand));
    if (hasEdge.has('-1,1')) pushUnique(-2, 1, 'southwest-2', Math.min(westLand, southLand));
  }
  if (hasEdge.has('1,0')) {
    pushUnique(2, 0, 'east-2', eastLand);
    if (hasEdge.has('1,-1')) pushUnique(2, -1, 'northeast-2', Math.min(eastLand, northLand));
    if (hasEdge.has('1,1')) pushUnique(2, 1, 'southeast-2', Math.min(eastLand, southLand));
  }
  if (hasEdge.has('0,-1')) {
    pushUnique(0, -2, 'north-2', northLand);
    if (hasEdge.has('-1,-1')) pushUnique(-1, -2, 'north-northwest-2', Math.min(westLand, northLand));
    if (hasEdge.has('1,-1')) pushUnique(1, -2, 'north-northeast-2', Math.min(eastLand, northLand));
  }
  if (hasEdge.has('0,1')) {
    pushUnique(0, 2, 'south-2', southLand);
    if (hasEdge.has('-1,1')) pushUnique(-1, 2, 'south-southwest-2', southLand);
    if (hasEdge.has('1,1')) pushUnique(1, 2, 'south-southeast-2', Math.max(eastLand, southLand));
  }
  return out;
}

// Lift any 1..6-cell border dip on connected edges of a section so adjacent sections meet at full inland elevation
export function prepareSectionConnectedBorders(heights, regionOrSize, connectedEdges = null) {
  const n = typeof regionOrSize === 'number' ? regionOrSize : regionOrSize?.size;
  if (!heights || !n || !connectedEdges) return false;
  const countEdgeLand = (edge, d) => {
    let c = 0;
    for (let t = 0; t < n; t++) {
      const h =
        edge === 'west'
          ? heights[t * n + d]
          : edge === 'east'
            ? heights[t * n + (n - 1 - d)]
            : edge === 'north'
              ? heights[d * n + t]
              : heights[(n - 1 - d) * n + t];
      if (h > 0.45) c++;
    }
    return c;
  };
  const edgeMaxInset = (edge) => {
    const c2 = countEdgeLand(edge, 2);
    const c20 = countEdgeLand(edge, Math.min(n - 1, 20));
    // If the edge already has untapered land right up to d=2, only sync the outermost 3 cells
    if (c2 >= 8 && c2 >= c20 * 0.7) return 3;
    return Math.min(20, Math.max(5, Math.floor(n * 0.038)));
  };
  let modified = false;
  if (connectedEdges.west) {
    const maxInset = edgeMaxInset('west');
    for (let j = 0; j < n; j++) {
      let bestIn = heights[j * n + maxInset];
      let bestIdx = maxInset;
      for (let k = 2; k <= maxInset; k++) {
        if (heights[j * n + k] > bestIn) {
          bestIn = heights[j * n + k];
          bestIdx = k;
        }
      }
      if (bestIn > 0.45) {
        for (let i = 0; i < bestIdx; i++) {
          const target = bestIn * (0.94 + 0.06 * (i / bestIdx));
          if (heights[j * n + i] < target) {
            heights[j * n + i] = target;
            modified = true;
          }
        }
      }
    }
  }
  if (connectedEdges.east) {
    const maxInset = edgeMaxInset('east');
    for (let j = 0; j < n; j++) {
      let bestIn = heights[j * n + (n - 1 - maxInset)];
      let bestD = maxInset;
      for (let d = 2; d <= maxInset; d++) {
        if (heights[j * n + (n - 1 - d)] > bestIn) {
          bestIn = heights[j * n + (n - 1 - d)];
          bestD = d;
        }
      }
      if (bestIn > 0.45) {
        for (let d = 0; d < bestD; d++) {
          const i = n - 1 - d;
          const target = bestIn * (0.94 + 0.06 * (d / bestD));
          if (heights[j * n + i] < target) {
            heights[j * n + i] = target;
            modified = true;
          }
        }
      }
    }
  }
  if (connectedEdges.north) {
    const maxInset = edgeMaxInset('north');
    for (let i = 0; i < n; i++) {
      let bestIn = heights[maxInset * n + i];
      let bestJ = maxInset;
      for (let j = 2; j <= maxInset; j++) {
        if (heights[j * n + i] > bestIn) {
          bestIn = heights[j * n + i];
          bestJ = j;
        }
      }
      if (bestIn > 0.45) {
        for (let j = 0; j < bestJ; j++) {
          const target = bestIn * (0.94 + 0.06 * (j / bestJ));
          if (heights[j * n + i] < target) {
            heights[j * n + i] = target;
            modified = true;
          }
        }
      }
    }
  }
  if (connectedEdges.south) {
    const maxInset = edgeMaxInset('south');
    for (let i = 0; i < n; i++) {
      let bestIn = heights[(n - 1 - maxInset) * n + i];
      let bestD = maxInset;
      for (let d = 2; d <= maxInset; d++) {
        if (heights[(n - 1 - d) * n + i] > bestIn) {
          bestIn = heights[(n - 1 - d) * n + i];
          bestD = d;
        }
      }
      if (bestIn > 0.45) {
        for (let d = 0; d < bestD; d++) {
          const j = n - 1 - d;
          const target = bestIn * (0.94 + 0.06 * (d / bestD));
          if (heights[j * n + i] < target) {
            heights[j * n + i] = target;
            modified = true;
          }
        }
      }
    }
  }
  return modified;
}

// Stitch a coastal section's heightfield C0/C1-continuously to all already-loaded neighboring sections
// along shared world borders, and organically round any unconnected outer world boundary into a natural cape.
export function stitchCoastalSectionBorders(
  heights,
  region,
  secX,
  secZ,
  getNeighborSection,
  { taperUnconnectedOuter = true, isRealDemSection = false } = {}
) {
  const n = region.size;
  const span = region.span;
  const westSec = typeof getNeighborSection === 'function' ? getNeighborSection(secX - 1, secZ) : null;
  const eastSec = typeof getNeighborSection === 'function' ? getNeighborSection(secX + 1, secZ) : null;
  const northSec = typeof getNeighborSection === 'function' ? getNeighborSection(secX, secZ - 1) : null;
  const southSec = typeof getNeighborSection === 'function' ? getNeighborSection(secX, secZ + 1) : null;

  // Check if neighbor exists OR is queued/planned in the contiguous coastal block
  const hasWest = Boolean(westSec || (typeof getNeighborSection === 'function' && getNeighborSection(secX - 1, secZ, true)));
  const hasEast = Boolean(eastSec || (typeof getNeighborSection === 'function' && getNeighborSection(secX + 1, secZ, true)));
  const hasNorth = Boolean(northSec || (typeof getNeighborSection === 'function' && getNeighborSection(secX, secZ - 1, true)));
  const hasSouth = Boolean(southSec || (typeof getNeighborSection === 'function' && getNeighborSection(secX, secZ + 1, true)));

  const sampleNeighborEdge = (neighbor, wx, wz) => {
    const srcHeights = neighbor.rawHeights || neighbor.heights;
    const nr = neighbor.region;
    const half = nr.span * 0.5 - 1e-3;
    const cx = Math.max(nr.x - half, Math.min(nr.x + half, wx));
    const cz = Math.max(nr.z - half, Math.min(nr.z + half, wz));
    return terrainSample(srcHeights, cx, cz, nr);
  };

  const blendBand = isRealDemSection ? 0.14 : 0.24;
  const xWest = region.x - span * 0.5;
  const xEast = region.x + span * 0.5;
  const zNorth = region.z - span * 0.5;
  const zSouth = region.z + span * 0.5;

  // 1. Smooth interior transition band + exact boundary lock on West and East borders
  if (westSec?.heights) {
    for (let j = 0; j < n; j++) {
      const z = region.z + (j / (n - 1) - 0.5) * span;
      const hEdge = sampleNeighborEdge(westSec, xWest, z);
      const delta = hEdge - heights[j * n];
      heights[j * n] = hEdge;
      for (let i = 1; i < n; i++) {
        const u = i / (n - 1);
        if (u >= blendBand) break;
        const w = (1 - coastalSmoothstep(0, blendBand, u)) * (eastSec?.heights ? 1 - u : 1);
        heights[j * n + i] += delta * w;
      }
    }
  }
  if (eastSec?.heights) {
    for (let j = 0; j < n; j++) {
      const z = region.z + (j / (n - 1) - 0.5) * span;
      const hEdge = sampleNeighborEdge(eastSec, xEast, z);
      const delta = hEdge - heights[j * n + (n - 1)];
      heights[j * n + (n - 1)] = hEdge;
      for (let i = n - 2; i >= 0; i--) {
        const u = (n - 1 - i) / (n - 1);
        if (u >= blendBand) break;
        const w = (1 - coastalSmoothstep(0, blendBand, u)) * (westSec?.heights ? 1 - u : 1);
        heights[j * n + i] += delta * w;
      }
    }
  }

  // 2. Smooth interior transition band + exact boundary lock on North and South borders
  if (northSec?.heights) {
    for (let i = 0; i < n; i++) {
      const x = region.x + (i / (n - 1) - 0.5) * span;
      const hEdge = sampleNeighborEdge(northSec, x, zNorth);
      const delta = hEdge - heights[i];
      heights[i] = hEdge;
      for (let j = 1; j < n; j++) {
        const v = j / (n - 1);
        if (v >= blendBand) break;
        const w = (1 - coastalSmoothstep(0, blendBand, v)) * (southSec?.heights ? 1 - v : 1);
        const ewWeight =
          westSec?.heights && i === 0
            ? 0
            : eastSec?.heights && i === n - 1
              ? 0
              : westSec?.heights && i / (n - 1) < blendBand
                ? coastalSmoothstep(0, blendBand, i / (n - 1))
                : eastSec?.heights && (n - 1 - i) / (n - 1) < blendBand
                  ? coastalSmoothstep(0, blendBand, (n - 1 - i) / (n - 1))
                  : 1;
        heights[j * n + i] += delta * w * ewWeight;
      }
    }
  }
  if (southSec?.heights) {
    for (let i = 0; i < n; i++) {
      const x = region.x + (i / (n - 1) - 0.5) * span;
      const hEdge = sampleNeighborEdge(southSec, x, zSouth);
      const delta = hEdge - heights[(n - 1) * n + i];
      heights[(n - 1) * n + i] = hEdge;
      for (let j = n - 2; j >= 0; j--) {
        const v = (n - 1 - j) / (n - 1);
        if (v >= blendBand) break;
        const w = (1 - coastalSmoothstep(0, blendBand, v)) * (northSec?.heights ? 1 - v : 1);
        const ewWeight =
          westSec?.heights && i === 0
            ? 0
            : eastSec?.heights && i === n - 1
              ? 0
              : westSec?.heights && i / (n - 1) < blendBand
                ? coastalSmoothstep(0, blendBand, i / (n - 1))
                : eastSec?.heights && (n - 1 - i) / (n - 1) < blendBand
                  ? coastalSmoothstep(0, blendBand, (n - 1 - i) / (n - 1))
                  : 1;
        heights[j * n + i] += delta * w * ewWeight;
      }
    }
  }

  // 3. Carve any unconnected outer world boundary into an organic multi-scale cape/bay contour with rounded corners
  if (taperUnconnectedOuter) {
    const seed = region.seed || region.vegetationSeed || coastalHashCoords(region.latitude, region.longitude);
    const connW = hasWest;
    const connE = hasEast;
    const connN = hasNorth;
    const connS = hasSouth;
    const maxOuterEdge = isRealDemSection ? 0.11 : 0.39;
    for (let j = 0; j < n; j++) {
      const v = j / (n - 1);
      const z = region.z + (v - 0.5) * span;
      for (let i = 0; i < n; i++) {
        const u = i / (n - 1);
        const x = region.x + (u - 0.5) * span;
        const dW = !connW ? u : 1.0;
        const dE = !connE ? 1 - u : 1.0;
        const dN = !connN ? v : 1.0;
        const dS = !connS ? 1 - v : 1.0;
        const dX = Math.min(dW, dE);
        const dZ = Math.min(dN, dS);
        const dEdge = Math.min(dX, dZ);
        if (dEdge >= maxOuterEdge) continue;
        const k = j * n + i;
        if (heights[k] <= -16) continue;
        const capeMajor = coastalFbm2D(x * 0.00048, z * 0.00048, seed + 947, 3);
        const capeMinor = coastalFbm2D(x * 0.0016, z * 0.0016, seed + 1319, 2);
        const margin = isRealDemSection
          ? Math.max(0.035, Math.min(0.10, 0.035 + 0.045 * capeMajor + 0.02 * capeMinor))
          : Math.max(0.055, Math.min(0.38, 0.06 + 0.24 * capeMajor + 0.08 * capeMinor));
        const oX = Math.max(0, margin - dX);
        const oZ = Math.max(0, margin - dZ);
        const pen = Math.hypot(oX, oZ);
        if (pen <= 0) continue;
        const onConnectedEdge =
          (connW && i === 0) || (connE && i === n - 1) || (connN && j === 0) || (connS && j === n - 1);
        if (onConnectedEdge) continue;
        let connLock = 1.0;
        if (dEdge > 0) {
          if (connW && u < 0.14) connLock = Math.min(connLock, coastalSmoothstep(0.0, 0.14, u));
          if (connE && 1 - u < 0.14) connLock = Math.min(connLock, coastalSmoothstep(0.0, 0.14, 1 - u));
          if (connN && v < 0.14) connLock = Math.min(connLock, coastalSmoothstep(0.0, 0.14, v));
          if (connS && 1 - v < 0.14) connLock = Math.min(connLock, coastalSmoothstep(0.0, 0.14, 1 - v));
        }
        const t = 1 - coastalSmoothstep(0.0, margin, Math.min(margin, pen));
        const blend = 1 - (1 - t) * connLock;
        const shelfDepth = -16 - (1 - t) * 10;
        heights[k] = shelfDepth * (1 - blend) + heights[k] * blend;
      }
    }
  }
  return heights;
}

// Generate a continuous neighboring coastal section at section coordinates (secX, secZ) relative to basePack.
// Propagates connected neighbor boundary elevation profiles C0/C1-continuously with matching coastal orientation,
// 1550 rainforest biome/albedo, and real SRTM DEM surrounding geography (islands, bays, lagoons, and hills).
export async function generateCoastalNeighborSection(
  basePack,
  secX,
  secZ,
  getNeighborSection = null,
  {
    size = 129,
    biomeSize = 128,
    albedoSize = 256,
    vegetationCandidates = 4500,
    useRealDEM = true,
    use1550 = true,
    fetchTile = null,
    fetchSatelliteTile = null,
    taperUnconnectedOuter = true,
  } = {}
) {
  const baseRegion = basePack.region;
  const span = baseRegion.span;
  const geoSpan = baseRegion.demGeoSpan || (span < 4000 ? 6800 : span);
  const cosLat = Math.max(0.1, Math.cos(baseRegion.latitude * COASTAL_DEG_TO_RAD));
  const secLat = Number((baseRegion.latitude - (secZ * geoSpan) / 111195).toFixed(6));
  const secLon = Number((baseRegion.longitude + (secX * geoSpan) / (111195 * cosLat)).toFixed(6));
  const secWorldX = baseRegion.x + secX * span;
  const secWorldZ = baseRegion.z + secZ * span;
  const secId = `${baseRegion.id}_sec_${secX}_${secZ}`;

  const sectionRegion = resolveGlobalCoastalRegion({
    id: secId,
    name: `${baseRegion.name} (${secX >= 0 ? '+' : ''}${secX}, ${secZ >= 0 ? '+' : ''}${secZ})`,
    latitude: secLat,
    longitude: secLon,
    shoreBearing: baseRegion.shoreBearing,
    harborShelter: baseRegion.harborShelter,
    peakElevationMetres: baseRegion.peakElevationMetres,
    climate: baseRegion.climate,
    x: secWorldX,
    z: secWorldZ,
    span,
    size,
    biomeSize,
    albedoSize,
    vegetationCandidates,
  });

  const lookupNeighbor = (nx, nz, includePlanned = false) => {
    if (typeof getNeighborSection === 'function') {
      const found = getNeighborSection(nx, nz, includePlanned);
      if (found) return found;
    }
    if (nx === 0 && nz === 0) return basePack;
    return null;
  };

  // Synthesize continuous coastal & inland terrain directly by propagating connected neighbor boundary profiles
  // so shoreline position, land/water orientation, rivers, and hills continue seamlessly across every section seam.
  const synthContinuousHeights = () => {
    const heights = new Float32Array(size * size);
    const seed = baseRegion.seed || coastalHashCoords(baseRegion.latitude, baseRegion.longitude);
    const peak = Math.min(280, Math.max(48, baseRegion.peakElevationMetres ?? 140));

    const westSec = lookupNeighbor(secX - 1, secZ, false);
    const eastSec = lookupNeighbor(secX + 1, secZ, false);
    const northSec = lookupNeighbor(secX, secZ - 1, false);
    const southSec = lookupNeighbor(secX, secZ + 1, false);

    const sampleCleanEdge = (neighbor, wx, wz) => {
      const src = neighbor.rawHeights || neighbor.heights;
      const nr = neighbor.region;
      const half = nr.span * 0.5 - 1e-3;
      const cx = Math.max(nr.x - half, Math.min(nr.x + half, wx));
      const cz = Math.max(nr.z - half, Math.min(nr.z + half, wz));
      return terrainSample(src, cx, cz, nr);
    };

    const xWest = secWorldX - span * 0.5;
    const xEast = secWorldX + span * 0.5;
    const zNorth = secWorldZ - span * 0.5;
    const zSouth = secWorldZ + span * 0.5;

    const westProfile = westSec?.heights ? new Float32Array(size) : null;
    const eastProfile = eastSec?.heights ? new Float32Array(size) : null;
    const northProfile = northSec?.heights ? new Float32Array(size) : null;
    const southProfile = southSec?.heights ? new Float32Array(size) : null;

    if (westProfile) {
      for (let j = 0; j < size; j++) {
        const z = secWorldZ + (j / (size - 1) - 0.5) * span;
        westProfile[j] = sampleCleanEdge(westSec, xWest, z);
      }
    }
    if (eastProfile) {
      for (let j = 0; j < size; j++) {
        const z = secWorldZ + (j / (size - 1) - 0.5) * span;
        eastProfile[j] = sampleCleanEdge(eastSec, xEast, z);
      }
    }
    if (northProfile) {
      for (let i = 0; i < size; i++) {
        const x = secWorldX + (i / (size - 1) - 0.5) * span;
        northProfile[i] = sampleCleanEdge(northSec, x, zNorth);
      }
    }
    if (southProfile) {
      for (let i = 0; i < size; i++) {
        const x = secWorldX + (i / (size - 1) - 0.5) * span;
        southProfile[i] = sampleCleanEdge(southSec, x, zSouth);
      }
    }

    const calcLandFrac = (prof) => {
      if (!prof) return 0;
      let c = 0;
      for (let i = 0; i < size; i++) {
        if (prof[i] > 0.25) c++;
      }
      return c / size;
    };
    const buildEnclosedWaterMask = (prof, landFrac) => {
      if (!prof) return null;
      const mask = new Float32Array(size);
      const maxLeft = new Float32Array(size);
      const maxRight = new Float32Array(size);
      let ml = -999;
      for (let i = 0; i < size; i++) {
        if (prof[i] > ml) ml = prof[i];
        maxLeft[i] = ml;
      }
      let mr = -999;
      for (let i = size - 1; i >= 0; i--) {
        if (prof[i] > mr) mr = prof[i];
        maxRight[i] = mr;
      }
      for (let i = 0; i < size; i++) {
        if (maxLeft[i] > 0.65 && maxRight[i] > 0.65) {
          mask[i] = 1.0;
        } else {
          mask[i] = 0.0;
        }
      }
      // Smooth the enclosed water mask over ~6 cells so the transition between coastal spit and open ocean is gradual
      const smoothed = new Float32Array(size);
      for (let i = 0; i < size; i++) {
        let s = 0, cnt = 0;
        for (let d = -5; d <= 5; d++) {
          const idx = Math.max(0, Math.min(size - 1, i + d));
          s += mask[idx];
          cnt++;
        }
        smoothed[i] = s / cnt;
      }
      return smoothed;
    };
    const westLandFrac = calcLandFrac(westProfile);
    const eastLandFrac = calcLandFrac(eastProfile);
    const northLandFrac = calcLandFrac(northProfile);
    const southLandFrac = calcLandFrac(southProfile);
    const westEnclosed = buildEnclosedWaterMask(westProfile, westLandFrac);
    const eastEnclosed = buildEnclosedWaterMask(eastProfile, eastLandFrac);
    const northEnclosed = buildEnclosedWaterMask(northProfile, northLandFrac);
    const southEnclosed = buildEnclosedWaterMask(southProfile, southLandFrac);

    const sample1D = (prof, t) => {
      const clamped = Math.max(0, Math.min(1, t));
      const f = clamped * (size - 1);
      const i0 = Math.floor(f);
      const i1 = Math.min(size - 1, i0 + 1);
      const a = f - i0;
      return prof[i0] * (1 - a) + prof[i1] * a;
    };

    const evalEdgePropagation = (
      prof,
      enclosedMask,
      profLandFrac,
      tCoord,
      dNorm,
      x,
      z,
      dirSeed,
      lockLowT,
      lockHighT
    ) => {
      const dRamp = coastalSmoothstep(0.0, 0.26, dNorm);
      const lowDamp = lockLowT ? coastalSmoothstep(0.0, 0.2, tCoord) : 1.0;
      const highDamp = lockHighT ? coastalSmoothstep(0.0, 0.2, 1.0 - tCoord) : 1.0;
      const fbmLarge = coastalFbm2D(x * 0.00038, z * 0.00038, seed + dirSeed, 3) - 0.5;
      const fbmMeso = coastalFbm2D(x * 0.0011, z * 0.0011, seed + dirSeed + 71, 3) - 0.5;
      // Preserve diagonal coastline trajectory when a shoreline clips the corner of a border profile
      let cornerDrift = 0;
      if (prof[0] <= 0.25 && prof[size - 1] > 0.25 && profLandFrac < 0.22 && !lockHighT) {
        cornerDrift = -0.82 * dNorm;
      } else if (prof[0] > 0.25 && prof[size - 1] <= 0.25 && profLandFrac < 0.22 && !lockLowT) {
        cornerDrift = 0.82 * dNorm;
      } else if (prof[0] <= 0.25 && prof[size - 1] > 0.25 && profLandFrac > 0.88 && !lockLowT) {
        cornerDrift = 0.82 * dNorm;
      } else if (prof[0] > 0.25 && prof[size - 1] <= 0.25 && profLandFrac > 0.88 && !lockHighT) {
        cornerDrift = -0.82 * dNorm;
      }
      const meander = cornerDrift + (fbmLarge * 0.42 + fbmMeso * 0.22) * dRamp * lowDamp * highDamp;
      const hBase = sample1D(prof, tCoord + meander);
      const enclosed = enclosedMask ? sample1D(enclosedMask, tCoord + meander) : 0;
      const ridge = coastalUberNoise2D(x * 0.00065, z * 0.00065, seed + 43, 4, 0.42);
      const micro = (coastalFbm2D(x * 0.0024, z * 0.0024, seed + 109, 3) - 0.48) * 5.2;

      // Only close off water segments that are enclosed by land on both sides (lagoons, estuaries, creeks)
      // or lie along a predominantly inland border; never turn the open sea side of a coastline into land.
      if (enclosed > 0.05 && hBase <= 0.25) {
        const bayReach = 0.26 + 0.34 * coastalFbm2D(x * 0.00042, z * 0.00042, seed + dirSeed + 313, 3);
        const inlandClose = coastalSmoothstep(bayReach * 0.42, bayReach, dNorm) * enclosed;
        const valleyFloor = 4.2 + 14.0 * ridge + Math.max(0, micro);
        const closedH = hBase * (1 - inlandClose) + valleyFloor * inlandClose;
        if (closedH > 0.25) {
          const hillGain = dRamp * Math.min(peak * 0.42, (6.0 + closedH * 0.5) * (0.35 + 0.65 * ridge));
          return Math.max(2.4, Math.min(895, closedH + hillGain));
        }
        return closedH;
      }

      if (hBase > 0.25) {
        const inlandRise = profLandFrac >= 0.35 ? coastalSmoothstep(0.06, 0.22, dNorm) * 3.8 : 0;
        const hillGain =
          inlandRise + dRamp * Math.min(peak * 0.52, (7.5 + hBase * 0.58) * (0.34 + 0.66 * ridge) + micro);
        return Math.max(0.55, Math.min(895, hBase + hillGain));
      }
      return Math.max(-120, hBase - dRamp * (5.0 + 18.0 * dNorm));
    };

    const hasAnyProfile = Boolean(westProfile || eastProfile || northProfile || southProfile);

    // Fallback true shore vector inferred from basePack.heights if a detached section is ever requested
    const rad = (baseRegion.shoreBearing ?? 112) * COASTAL_DEG_TO_RAD;
    const shoreDirX = Math.sin(rad);
    const shoreDirZ = -Math.cos(rad);
    const tangX = -shoreDirZ;
    const tangZ = shoreDirX;

    for (let j = 0; j < size; j++) {
      const v = j / (size - 1);
      const z = secWorldZ + (v - 0.5) * span;
      for (let i = 0; i < size; i++) {
        const u = i / (size - 1);
        const x = secWorldX + (u - 0.5) * span;

        if (hasAnyProfile) {
          let wSum = 0;
          let hSum = 0;
          if (westProfile) {
            const w = 1 / Math.pow(Math.max(1e-4, u), 2.35);
            const hW = evalEdgePropagation(
              westProfile,
              westEnclosed,
              westLandFrac,
              v,
              u,
              x,
              z,
              31,
              Boolean(northProfile),
              Boolean(southProfile)
            );
            wSum += w;
            hSum += w * hW;
          }
          if (eastProfile) {
            const w = 1 / Math.pow(Math.max(1e-4, 1 - u), 2.35);
            const hE = evalEdgePropagation(
              eastProfile,
              eastEnclosed,
              eastLandFrac,
              v,
              1 - u,
              x,
              z,
              47,
              Boolean(northProfile),
              Boolean(southProfile)
            );
            wSum += w;
            hSum += w * hE;
          }
          if (northProfile) {
            const w = 1 / Math.pow(Math.max(1e-4, v), 2.35);
            const hN = evalEdgePropagation(
              northProfile,
              northEnclosed,
              northLandFrac,
              u,
              v,
              x,
              z,
              61,
              Boolean(westProfile),
              Boolean(eastProfile)
            );
            wSum += w;
            hSum += w * hN;
          }
          if (southProfile) {
            const w = 1 / Math.pow(Math.max(1e-4, 1 - v), 2.35);
            const hS = evalEdgePropagation(
              southProfile,
              southEnclosed,
              southLandFrac,
              u,
              1 - v,
              x,
              z,
              79,
              Boolean(westProfile),
              Boolean(eastProfile)
            );
            wSum += w;
            hSum += w * hS;
          }
          heights[j * size + i] = hSum / wSum;
          continue;
        }

        const dx = (x - baseRegion.x) / span;
        const dz = (z - baseRegion.z) / span;
        const across = dx * shoreDirX + dz * shoreDirZ;
        const along = dx * tangX + dz * tangZ;
        const coastWobble =
          0.18 * (coastalFbm2D(x * 0.00045, z * 0.00045, seed + 19, 3) - 0.5) +
          0.08 * Math.sin(along * 2.1 + 0.7);
        const signedShore = across + coastWobble;
        if (signedShore > 0) {
          const ridge = coastalUberNoise2D(x * 0.00065, z * 0.00065, seed + 43, 4, 0.42);
          const ramp = coastalSmoothstep(0, 0.55, signedShore);
          heights[j * size + i] = Math.min(895, 0.35 + signedShore * 22 + ramp * peak * (0.28 + 0.72 * ridge));
        } else {
          const seaDistM = Math.abs(signedShore) * span;
          heights[j * size + i] = -Math.min(120, 0.5 + 0.12 * seaDistM);
        }
      }
    }
    return heights;
  };

  const sectionPack = {
    region: sectionRegion,
    secX,
    secZ,
    skipPortPlacement: true,
    elevationSource: 'procedural-continuation',
  };

  let contHeights = null;
  let isRealDemSection = false;

  // Use real AWS Terrarium SRTM DEM geography (bays, islands, lagoons, and hills) when available,
  // smoothly stitched around the (0, 0) center quad via a globally continuous 2D border transition field.
  if (useRealDEM && (fetchTile || (typeof fetch === 'function' && typeof createImageBitmap === 'function'))) {
    try {
      const demProbe = { region: sectionRegion, skipPortPlacement: true };
      await upgradeProceduralPackWithRealDEM(demProbe, {
        fetchTile,
        fetchSatelliteTile: null,
        zoom: geoSpan >= 5000 ? 12 : 13,
        demSpan: geoSpan,
        timeoutMs: 8000,
        isNeighborSection: true,
        _snapAttempted: true,
      });
      if (demProbe.rawDem && demProbe.rawDem.length === size * size) {
        contHeights = new Float32Array(size * size);
        const elevScale = span < geoSpan ? Math.max(0.45, Math.sqrt(span / geoSpan)) : 1.0;
        const baseSrc = basePack.rawHeights || basePack.heights;
        const half0 = span * 0.5;
        const blendDist = span * 0.25;
        const blendedDem = new Float32Array(size * size);
        for (let j = 0; j < size; j++) {
          const v = j / (size - 1);
          const z = secWorldZ + (v - 0.5) * span;
          for (let i = 0; i < size; i++) {
            const u = i / (size - 1);
            const x = secWorldX + (u - 0.5) * span;
            const k = j * size + i;
            const rawH = demProbe.rawDem[k];
            let h = rawH > 0.25 ? Math.min(895, 0.25 + (rawH - 0.25) * elevScale) : Math.min(-6.0, Math.max(-120, rawH));
            if (baseSrc) {
              const cx = Math.max(baseRegion.x - half0 + 1e-3, Math.min(baseRegion.x + half0 - 1e-3, x));
              const cz = Math.max(baseRegion.z - half0 + 1e-3, Math.min(baseRegion.z + half0 - 1e-3, z));
              const d0 = Math.hypot(x - cx, z - cz);
              if (d0 < blendDist) {
                const w0 = 1 - coastalSmoothstep(0, blendDist, d0);
                const hBaseEdge = terrainSample(baseSrc, cx, cz, baseRegion);
                const effBase = hBaseEdge <= 0.25 ? Math.min(hBaseEdge, -10.5) : hBaseEdge;
                h = effBase * w0 + h * (1 - w0);
              }
            }
            blendedDem[k] = h;
          }
        }
        const { distLand, step } = computeCoastalShoreDistances(blendedDem, size, span, 0.25);
        for (let k = 0; k < size * size; k++) {
          const bh = blendedDem[k];
          if (bh > 0.25) {
            contHeights[k] = bh;
          } else {
            const shoreDistance = Math.max(0, distLand[k] - step * 0.5);
            const authoredDepth = Math.min(120, 2 + 0.15 * shoreDistance);
            contHeights[k] = Math.max(-120, bh < -2 ? Math.min(bh, -authoredDepth) : -authoredDepth);
          }
        }
        isRealDemSection = true;
        sectionPack.elevationSource = demProbe.elevationSource || `aws-terrarium-srtm-z${geoSpan >= 5000 ? 12 : 13}`;
      }
    } catch { /* fallback to boundary-propagated continuous coast */ }
  }

  if (!contHeights) {
    contHeights = synthContinuousHeights();
  }

  const connectedEdges = {
    west: Boolean(lookupNeighbor(secX - 1, secZ, true)),
    east: Boolean(lookupNeighbor(secX + 1, secZ, true)),
    north: Boolean(lookupNeighbor(secX, secZ - 1, true)),
    south: Boolean(lookupNeighbor(secX, secZ + 1, true)),
  };

  // Keep pristine un-tapered heights for future outer neighbors to stitch against
  const rawHeights = new Float32Array(contHeights);
  sectionPack.rawHeights = rawHeights;

  // Smooth coastline & foreshore beaches while protecting connected borders, then lock exact borders & round outer capes
  const stitched = new Float32Array(rawHeights);
  stitchCoastalSectionBorders(stitched, sectionRegion, secX, secZ, lookupNeighbor, {
    taperUnconnectedOuter,
    isRealDemSection,
  });
  smoothCoastlineAndForeshoreBeaches(stitched, sectionRegion, {
    connectedEdges,
    taperOuterBorders: false,
  });
  stitchCoastalSectionBorders(stitched, sectionRegion, secX, secZ, lookupNeighbor, {
    taperUnconnectedOuter,
    isRealDemSection,
  });

  const port = {
    regionId: sectionRegion.id,
    name: sectionRegion.name,
    era: 1550,
    center: { x: sectionRegion.x, z: sectionRegion.z, elevation: 2.5, shoreAlong: 0 },
    berth: { x: sectionRegion.x, z: sectionRegion.z, depth: 8, heading: sectionRegion.shoreBearing ?? 112 },
    clearRadius: 0,
    instances: [],
  };
  sectionPack.port = port;

  const shoreDist = computeCoastalShoreDistances(stitched, size, span, 0.25);
  const beaches = synthesizeCoastalBeaches(sectionRegion, stitched, null, shoreDist);
  const mesh = buildCoastalMesh(sectionRegion, stitched, beaches, shoreDist);
  const biome = synthesizeCoastalBiome(sectionRegion, stitched, beaches, port, null);
  const albedo = synthesizeCoastalAlbedo(
    sectionRegion,
    stitched,
    beaches,
    port,
    biome,
    null,
    shoreDist
  );
  const vegetation = seedCoastalVegetation(sectionRegion, stitched, biome, beaches, port, 5, shoreDist);
  const portGeometry = buildPortPrefabGeometry(port, vegetation.palms);

  return Object.assign(sectionPack, {
    heights: stitched,
    beaches,
    mesh,
    biome,
    albedo,
    vegetation,
    portGeometry,
  });
}

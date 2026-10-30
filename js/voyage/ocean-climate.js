// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Global open-ocean climate for the c. 1550 Chart Course passage layer.
//
// Everything here is deterministic and pure: (latitude, longitude, time) -> wind, current,
// weather and magnetic variation. It is a gameplay climatology, not a reanalysis: the
// prevailing wind belts, seasonal ITCZ / monsoon shifts, major surface currents and travelling
// weather systems are authored so that historically real routes (volta do mar, trade-wind
// crossings, the Gulf Stream run home) emerge from play.
//
// Conventions shared with the renderer (js/sailing.js, js/main.js):
// - Compass bearings are degrees clockwise from true north.
// - World X = east, world Z = south.
// - P.windDir / P.swellDir are *propagation* angles θ with velocity (cos θ, sin θ) in X/Z,
//   so a wind blowing FROM compass bearing B has θ = B + 90°.

export const EARTH_RADIUS_M = 6371000;
export const METRES_PER_NM = 1852;
export const DAY_MS = 86400000;
const RAD = Math.PI / 180;
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const smooth = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const wrap360 = (d) => ((d % 360) + 360) % 360;
const wrapLon = (d) => ((((d + 180) % 360) + 360) % 360) - 180;

// ---------------------------------------------------------------------------------------------
// Direction conventions
// ---------------------------------------------------------------------------------------------
/** Compass "from" bearing (deg) -> renderer propagation angle θ (deg). */
export function rendererDirFromCompassFrom(fromBearing) {
  return wrap360(fromBearing + 90);
}
/** Renderer propagation angle θ (deg) -> compass "from" bearing (deg). */
export function compassFromRendererDir(theta) {
  return wrap360(theta - 90);
}
/** Velocity vector (east, north) m/s -> { speed, fromBearing, toBearing }. */
export function vectorToBearing(east, north) {
  const speed = Math.hypot(east, north);
  const toBearing = wrap360(Math.atan2(east, north) / RAD);
  return { speed, toBearing, fromBearing: wrap360(toBearing + 180) };
}
/** Wind blowing FROM bearing at speed -> velocity (east, north) it blows toward. */
export function windVector(fromBearing, speed) {
  const to = (fromBearing + 180) * RAD;
  return { east: Math.sin(to) * speed, north: Math.cos(to) * speed };
}

// ---------------------------------------------------------------------------------------------
// Deterministic hashing & smooth value noise
// ---------------------------------------------------------------------------------------------
export function hash32(...values) {
  let h = 2166136261 >>> 0;
  for (const v of values) {
    let x = Math.floor(v * 1000) | 0;
    for (let i = 0; i < 4; i++) {
      h ^= x & 255;
      h = Math.imul(h, 16777619) >>> 0;
      x >>= 8;
    }
  }
  h ^= h >>> 15;
  h = Math.imul(h, 2246822507) >>> 0;
  h ^= h >>> 13;
  return h >>> 0;
}
export function hashUnit(...values) {
  return hash32(...values) / 4294967296;
}
export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
/** 1D smooth value noise in [-1, 1] over continuous t (units of one lattice step). */
function noise1(t, seed) {
  const i = Math.floor(t), f = t - i;
  const u = f * f * (3 - 2 * f);
  const a = hashUnit(i, seed) * 2 - 1, b = hashUnit(i + 1, seed) * 2 - 1;
  return a + (b - a) * u;
}

// ---------------------------------------------------------------------------------------------
// Calendar helpers (internal time is proleptic-Gregorian UTC ms, as JS Date uses)
// ---------------------------------------------------------------------------------------------
export function dayOfYear(ms) {
  const d = new Date(ms);
  const start = Date.UTC(d.getUTCFullYear(), 0, 1);
  return (ms - start) / DAY_MS;
}
/**
 * Julian-calendar date parts for display. Spain used the Julian calendar until October 1582;
 * in the 16th century Julian = Gregorian − 10 days.
 */
export function julianDateParts(ms) {
  const d = new Date(ms - 10 * DAY_MS);
  return { year: d.getUTCFullYear(), month: d.getUTCMonth() + 1, day: d.getUTCDate(), hours: d.getUTCHours() + d.getUTCMinutes() / 60 };
}
const SPANISH_MONTHS = ['enero', 'febrero', 'marzo', 'abril', 'mayo', 'junio', 'julio', 'agosto', 'septiembre', 'octubre', 'noviembre', 'diciembre'];
export function formatJulianDate(ms) {
  const j = julianDateParts(ms);
  return `${j.day} de ${SPANISH_MONTHS[j.month - 1]} de ${j.year}`;
}
/** Approximate local apparent solar time (hours 0..24) at longitude, incl. equation of time. */
export function localSolarHours(ms, lon) {
  const d = new Date(ms);
  const utc = d.getUTCHours() + d.getUTCMinutes() / 60 + d.getUTCSeconds() / 3600 + d.getUTCMilliseconds() / 3600000;
  const B = (2 * Math.PI * (dayOfYear(ms) - 81)) / 364;
  const eotMinutes = 9.87 * Math.sin(2 * B) - 7.53 * Math.cos(B) - 1.5 * Math.sin(B);
  return (((utc + lon / 15 + eotMinutes / 60) % 24) + 24) % 24;
}
/** Solar declination (deg), Cooper's approximation – plenty for astrolabe-grade sights. */
export function solarDeclination(ms) {
  return 23.44 * Math.sin((2 * Math.PI * (284 + dayOfYear(ms))) / 365);
}

// ---------------------------------------------------------------------------------------------
// Prevailing wind belts
// ---------------------------------------------------------------------------------------------
/** Seasonal latitude of the ITCZ (doldrums) at a longitude. Peaks north in August. */
export function itczLatitude(lon, ms) {
  const season = Math.cos((2 * Math.PI * (dayOfYear(ms) - 220)) / 365.25);
  // The Indian Ocean / South Asian monsoon drags the ITCZ much further north in summer.
  const indian = smooth(30, 50, lon) * (1 - smooth(100, 125, lon));
  const base = 5 + indian * 3;
  const amp = 4 + indian * 10;
  return base + amp * season;
}

/** Climatological (no weather systems) wind as compass FROM bearing and speed m/s. */
export function prevailingWind(lat, lon, ms) {
  lon = wrapLon(lon);
  const itcz = itczLatitude(lon, ms);
  const season = Math.cos((2 * Math.PI * (dayOfYear(ms) - 15)) / 365.25); // +1 mid-Jan (NH winter)
  const winterNH = clamp(season, 0, 1), winterSH = clamp(-season, 0, 1);
  const north = lat >= itcz;
  // Latitude measured away from the ITCZ inside the tropics, true latitude poleward.
  const phi = Math.abs(lat - itcz);
  const absLat = Math.abs(lat);

  // Each belt: weight, from-bearing (NH; SH mirrored), speed.
  const doldrums = 1 - smooth(2.5, 6, phi);
  const trades = smooth(3, 7, phi) * (1 - smooth(25, 31, absLat));
  const horse = smooth(25, 31, absLat) * (1 - smooth(32, 38, absLat));
  const westerlies = smooth(33, 39, absLat) * (1 - smooth(60, 66, absLat));
  const polar = smooth(61, 67, absLat);

  const tradeFrom = north ? 60 : 120; // NE trades / SE trades
  const tradeSpeed = 6.5 + 1.5 * Math.sin(clamp((phi - 4) / 18, 0, 1) * Math.PI);
  const westFrom = north ? 250 : 290; // WSW in the north, WNW "roaring forties" in the south
  const westSpeed = north ? 8 + 3 * winterNH : 10 + 3 * winterSH + 2 * smooth(40, 50, absLat);
  const polarFrom = north ? 70 : 110;

  let e = 0, n = 0, w = 0;
  const add = (weight, from, speed) => {
    if (weight <= 1e-4) return;
    const v = windVector(from, speed);
    e += v.east * weight; n += v.north * weight; w += weight;
  };
  add(trades, tradeFrom, tradeSpeed);
  add(horse, north ? 20 : 160, 3.2);
  add(westerlies, westFrom, westSpeed);
  add(polar, polarFrom, 6);
  // Doldrums: light, shifting airs – direction wanders slowly with time.
  if (doldrums > 1e-4) {
    const wander = noise1(ms / (DAY_MS * 0.6), hash32(Math.round(lat), Math.round(lon / 10))) * 180;
    add(doldrums, wrap360(90 + wander), 1.6);
  }

  // Indian Ocean monsoon overrides the trades between 40°E–100°E, 10°S–25°N.
  const monsoonBox = smooth(35, 45, lon) * (1 - smooth(98, 108, lon)) * smooth(-12, -6, lat) * (1 - smooth(24, 30, lat));
  if (monsoonBox > 1e-4) {
    const doy = dayOfYear(ms);
    const sw = smooth(140, 165, doy) * (1 - smooth(260, 285, doy)); // SW monsoon Jun–Sep
    const ne = 1 - smooth(75, 100, doy) + smooth(320, 345, doy); // NE monsoon Dec–Mar
    const vSw = windVector(225, 9.5), vNe = windVector(45, 6.5);
    const me = vSw.east * sw + vNe.east * clamp(ne, 0, 1);
    const mn = vSw.north * sw + vNe.north * clamp(ne, 0, 1);
    const k = monsoonBox * clamp(sw + ne, 0, 1);
    if (w > 0) { e /= w; n /= w; w = 1; }
    e = e * (1 - k) + me * k;
    n = n * (1 - k) + mn * k;
  } else if (w > 0) {
    e /= w; n /= w;
  }
  const b = vectorToBearing(e, n);
  // Mixing opposed belts cancels vectors; never let the result collapse to a dead calm.
  return { fromBearing: b.fromBearing, speed: Math.max(b.speed, doldrums > 0.5 ? 0.8 : 2.2) };
}

// ---------------------------------------------------------------------------------------------
// Travelling weather systems (mid-latitude lows, tropical cyclones)
// ---------------------------------------------------------------------------------------------
const SYSTEM_EPOCH_DAYS = 3; // a new batch of candidate systems every three days

/**
 * Deterministic weather systems alive at time `ms` near (lat, lon).
 * Each system: { kind, lat, lon, radiusKm, maxWind, age01, rain, hemisphere }.
 */
export function weatherSystemsAt(ms, { seed = 1550, lat = null, lon = null, rangeKm = 2500 } = {}) {
  const out = [];
  const epoch = Math.floor(ms / (DAY_MS * SYSTEM_EPOCH_DAYS));
  // Systems live up to ~8 days, so examine the last few batches.
  for (let k = epoch - 3; k <= epoch; k++) {
    const batch = 7;
    for (let i = 0; i < batch; i++) {
      // Each system owns its random stream so that whether a sibling is alive at `ms` never
      // changes this system's track (keeps systems temporally continuous).
      const r = mulberry32(hash32(seed, k, i));
      const kindRoll = r();
      const birthMs = (k * SYSTEM_EPOCH_DAYS + r() * SYSTEM_EPOCH_DAYS) * DAY_MS;
      let sys = null;
      if (kindRoll < 0.78) {
        // Mid-latitude low: forms 35–55°, drifts east ~9 m/s, 4–6 days.
        const hemi = r() < 0.55 ? 1 : -1;
        const lat0 = hemi * (36 + r() * 18);
        const lon0 = -180 + r() * 360;
        const lifeDays = 4 + r() * 2.5;
        const ageDays = (ms - birthMs) / DAY_MS;
        if (ageDays < 0 || ageDays > lifeDays) continue;
        const travelKm = ageDays * 86400 * (8 + r() * 4) / 1000;
        const latNow = lat0 + hemi * ageDays * 0.9;
        const lonNow = wrapLon(lon0 + (travelKm / (111.2 * Math.cos(latNow * RAD))));
        const winterBoost = hemi > 0
          ? 0.6 + 0.4 * Math.cos((2 * Math.PI * (dayOfYear(ms) - 15)) / 365.25)
          : 0.6 - 0.4 * Math.cos((2 * Math.PI * (dayOfYear(ms) - 15)) / 365.25);
        const age01 = ageDays / lifeDays;
        sys = { kind: 'gale', lat: latNow, lon: lonNow, radiusKm: 650 + r() * 450, maxWind: (11 + r() * 12) * (0.55 + winterBoost * 0.6), age01, rain: 0.55, hemisphere: hemi };
      } else {
        // Tropical cyclone: North Atlantic / NW Pacific / Bay of Bengal / S Indian, in season.
        const basinRoll = r();
        const doy = dayOfYear(ms);
        let basin;
        if (basinRoll < 0.4) basin = { lat: [11, 20], lon: [-60, -25], season: [152, 334], hemi: 1, drift: -1 }; // N Atlantic (Jun–Nov)
        else if (basinRoll < 0.75) basin = { lat: [10, 20], lon: [130, 160], season: [130, 350], hemi: 1, drift: -1 }; // W Pacific
        else if (basinRoll < 0.87) basin = { lat: [10, 18], lon: [84, 94], season: [120, 330], hemi: 1, drift: -1 }; // Bay of Bengal
        else basin = { lat: [-18, -10], lon: [55, 95], season: [-30, 110], hemi: -1, drift: -1 }; // S Indian (Dec–Apr)
        const inSeason = basin.season[0] < 0
          ? doy >= 365 + basin.season[0] || doy <= basin.season[1]
          : doy >= basin.season[0] && doy <= basin.season[1];
        const lat0 = basin.lat[0] + r() * (basin.lat[1] - basin.lat[0]);
        const lon0 = basin.lon[0] + r() * (basin.lon[1] - basin.lon[0]);
        const lifeDays = 6 + r() * 4;
        const strength = r();
        if (!inSeason) continue;
        const ageDays = (ms - birthMs) / DAY_MS;
        if (ageDays < 0 || ageDays > lifeDays) continue;
        // Track: westward ~5 m/s in the trades, then recurving poleward and east.
        const recurve = smooth(0.45, 0.8, ageDays / lifeDays);
        const kmDay = 430;
        const west = ageDays * kmDay * (1 - recurve * 0.8);
        const pole = ageDays * kmDay * (0.25 + recurve * 0.75);
        const latNow = lat0 + basin.hemi * pole / 111.2;
        const lonNow = wrapLon(lon0 + basin.drift * west / (111.2 * Math.cos(latNow * RAD)) + recurve * recurve * ageDays * 2.5);
        const age01 = ageDays / lifeDays;
        sys = { kind: 'hurricane', lat: latNow, lon: lonNow, radiusKm: 260 + r() * 200, maxWind: 22 + strength * 30, age01, rain: 1, hemisphere: basin.hemi };
      }
      if (!sys) continue;
      // Grow, mature, decay.
      sys.intensity = smooth(0, 0.2, sys.age01) * (1 - smooth(0.75, 1, sys.age01));
      if (lat !== null && lon !== null && greatCircleKm(lat, lon, sys.lat, sys.lon) > rangeKm) continue;
      out.push(sys);
    }
  }
  return out;
}

/** Rankine-like vortex wind contribution of a system at a point (east, north m/s). */
function systemWind(sys, lat, lon) {
  const dKm = greatCircleKm(lat, lon, sys.lat, sys.lon);
  const rMax = sys.radiusKm * (sys.kind === 'hurricane' ? 0.16 : 0.35);
  if (dKm > sys.radiusKm * 1.6) return null;
  const speed = sys.maxWind * sys.intensity * (dKm < rMax ? dKm / rMax : Math.pow(rMax / dKm, 0.65)) * (1 - smooth(sys.radiusKm, sys.radiusKm * 1.6, dKm));
  // Bearing from centre to point; cyclonic flow is counter-clockwise in the north (clockwise south),
  // with ~20° of inflow toward the low.
  const brg = initialBearing(sys.lat, sys.lon, lat, lon);
  const tangential = brg + (sys.hemisphere > 0 ? -90 : 90);
  const inflow = sys.hemisphere > 0 ? -20 : 20;
  const to = (tangential + inflow) * RAD;
  const near = 1 - smooth(rMax * 0.6, sys.radiusKm, dKm);
  return { east: Math.sin(to) * speed, north: Math.cos(to) * speed, weight: speed, rain: sys.rain * sys.intensity * near, dKm, sys };
}

// ---------------------------------------------------------------------------------------------
// Full weather sample
// ---------------------------------------------------------------------------------------------
/**
 * Complete weather at a place and time. Returns compass and renderer conventions plus sky values:
 * { windSpeed, windFrom, windDir, swellHs, swellDir, swellLength, clouds, rain, thunder, haze,
 *   cloudBase, cloudDepth, cloudDensity, cloudAnvil, systems, nearestSystem, beaufort, description }
 */
export function sampleOceanWeather(lat, lon, ms, { seed = 1550 } = {}) {
  const base = prevailingWind(lat, lon, ms);
  const v = windVector(base.fromBearing, base.speed);
  // Gentle diurnal/synoptic variability: ±18% speed, ±14° direction on ~10 h scales.
  const vs = hash32(seed, Math.round(lat / 4), Math.round(lon / 4));
  const gustiness = noise1(ms / (DAY_MS * 0.42), vs) * 0.18 + noise1(ms / (DAY_MS * 0.11), vs + 7) * 0.06;
  const veer = noise1(ms / (DAY_MS * 0.5), vs + 13) * 14;
  let e = v.east * (1 + gustiness), n = v.north * (1 + gustiness);
  {
    const c = Math.cos(veer * RAD), s = Math.sin(veer * RAD);
    const e2 = e * c + n * s, n2 = -e * s + n * c;
    e = e2; n = n2;
  }
  let rain = 0, nearest = null;
  const systems = weatherSystemsAt(ms, { seed, lat, lon, rangeKm: 2600 });
  for (const sys of systems) {
    const w = systemWind(sys, lat, lon);
    if (!w) continue;
    const k = clamp(w.weight / Math.max(1, base.speed), 0, 1);
    e = e * (1 - k * 0.6) + w.east;
    n = n * (1 - k * 0.6) + w.north;
    rain = Math.max(rain, w.rain);
    if (!nearest || w.dKm / w.sys.radiusKm < nearest.dKm / nearest.sys.radiusKm) nearest = w;
  }
  const wind = vectorToBearing(e, n);
  const windSpeed = clamp(wind.speed, 0.3, 34);
  const itcz = itczLatitude(lon, ms);
  const doldrums = 1 - smooth(2.5, 6, Math.abs(lat - itcz));
  // Convective doldrum showers come and go.
  const shower = doldrums * clamp(noise1(ms / (DAY_MS * 0.08), vs + 29) * 1.4, 0, 1);
  rain = clamp(Math.max(rain, shower * 0.7), 0, 1);
  const absLat = Math.abs(lat);
  const baseClouds = 0.28 + 0.3 * smooth(32, 45, absLat) + 0.35 * doldrums + noise1(ms / (DAY_MS * 0.7), vs + 31) * 0.12;
  const clouds = clamp(Math.max(baseClouds, rain * 0.95), 0.05, 0.98);
  // Wind sea: Pierson–Moskowitz Hs ≈ 0.0246 U², plus a long background swell in westerly belts.
  const windSea = 0.0246 * windSpeed * windSpeed;
  const background = 0.6 + 1.0 * smooth(30, 50, absLat);
  const swellHs = clamp(Math.hypot(windSea, background), 0.3, 8);
  const hurricane = nearest?.sys?.kind === 'hurricane' ? nearest.sys.intensity * (1 - smooth(0, nearest.sys.radiusKm, nearest.dKm)) : 0;
  const thunder = clamp(Math.max(hurricane * 1.2, shower > 0.5 ? (shower - 0.5) * 1.2 : 0, rain > 0.8 ? (rain - 0.8) * 2 : 0), 0, 1);
  const windDir = rendererDirFromCompassFrom(wind.fromBearing);
  const beaufort = beaufortNumber(windSpeed);
  return {
    windSpeed,
    windFrom: wind.fromBearing,
    windDir,
    swellHs,
    swellDir: windDir,
    swellLength: clamp(40 + windSpeed * 6 + background * 20, 40, 260),
    clouds,
    rain,
    thunder,
    haze: clamp(0.8 + rain * 5 + (absLat < 25 ? 0.6 : 0), 0.5, 8),
    cloudBase: clamp(1.25 - rain * 0.6, 0.35, 1.6),
    cloudDepth: clamp(1.6 + rain * 2.8 + doldrums * 1.5, 1, 4.8),
    cloudDensity: clamp(1 + rain * 0.8, 0.8, 1.9),
    cloudAnvil: clamp(thunder * 0.9 + doldrums * 0.25, 0, 1),
    systems,
    nearestSystem: nearest ? { kind: nearest.sys.kind, distanceKm: nearest.dKm, bearing: initialBearing(lat, lon, nearest.sys.lat, nearest.sys.lon), intensity: nearest.sys.intensity, radiusKm: nearest.sys.radiusKm } : null,
    beaufort,
    description: windDescription(windSpeed),
  };
}

export function beaufortNumber(speed) {
  const limits = [0.5, 1.6, 3.4, 5.5, 8, 10.8, 13.9, 17.2, 20.8, 24.5, 28.5, 32.7];
  let b = 0;
  while (b < limits.length && speed >= limits[b]) b++;
  return b;
}
/** Period-flavoured mariner's description of wind strength. */
export function windDescription(speed) {
  const names = ['flat calm', 'light airs', 'a light breeze', 'a gentle breeze', 'a moderate breeze', 'a fresh breeze', 'a strong breeze', 'a near gale', 'a gale', 'a strong gale', 'a storm', 'a violent storm', 'a hurricane'];
  return names[beaufortNumber(speed)];
}

// ---------------------------------------------------------------------------------------------
// Ocean surface currents
// ---------------------------------------------------------------------------------------------
// Authored as polylines [lat, lon] with a core speed (m/s) and half-width (km). The current at a
// point is the sum of Gaussian-falloff jets aligned with the nearest segment of each polyline.
export const OCEAN_CURRENTS = Object.freeze([
  { name: 'Florida Current', speed: 1.6, widthKm: 70, path: [[21.8, -86.0], [23.6, -84.5], [24.3, -81.5], [25.6, -79.9], [28.5, -79.9]] },
  { name: 'Gulf Stream', speed: 1.5, widthKm: 90, path: [[28.5, -79.9], [32, -78.6], [35, -75], [37.5, -71], [39.5, -65], [41, -57], [42, -50]] },
  { name: 'North Atlantic Drift', speed: 0.35, widthKm: 380, path: [[42, -50], [45, -40], [48, -30], [51, -20], [55, -12], [60, -5]] },
  { name: 'Portugal & Canary Current', speed: 0.3, widthKm: 320, path: [[44, -12], [38, -12], [32, -14], [27, -16.5], [21, -19], [15, -21]] },
  { name: 'North Equatorial Current', speed: 0.38, widthKm: 520, path: [[15, -21], [14, -32], [13.5, -45], [14, -56], [15.5, -64]] },
  { name: 'Caribbean Current', speed: 0.55, widthKm: 260, path: [[14.5, -63], [14.8, -70], [15.5, -77], [17.5, -82], [20, -85], [21.8, -86]] },
  { name: 'Antilles Current', speed: 0.25, widthKm: 220, path: [[19, -60], [22, -67], [25, -73], [28.5, -77.5]] },
  { name: 'Guinea Current', speed: 0.45, widthKm: 220, path: [[7, -15], [5, -8], [4, 0], [3.5, 6]] },
  { name: 'Atlantic South Equatorial Current', speed: 0.5, widthKm: 480, path: [[-1, 8], [-1.5, -5], [-3, -18], [-5, -30], [-6.5, -34]] },
  { name: 'North Brazil Current', speed: 0.8, widthKm: 180, path: [[-5.5, -35], [-2, -40], [1.5, -46], [5, -51], [8.5, -57], [11, -61]] },
  { name: 'Brazil Current', speed: 0.4, widthKm: 160, path: [[-9, -34.5], [-15, -38], [-22, -40], [-28, -46], [-34, -50], [-38, -54]] },
  { name: 'Benguela Current', speed: 0.3, widthKm: 300, path: [[-34.5, 17], [-29, 14.5], [-22, 12], [-15, 10.5], [-8, 9]] },
  { name: 'Agulhas Current', speed: 1.4, widthKm: 100, path: [[-24, 35.5], [-28, 32.8], [-31.5, 30], [-34.5, 26], [-36.5, 21]] },
  { name: 'Mozambique Current', speed: 0.6, widthKm: 180, path: [[-11, 42], [-16, 41], [-21, 37.5], [-24, 35.5]] },
  { name: 'Indian South Equatorial Current', speed: 0.35, widthKm: 450, path: [[-12, 105], [-12, 90], [-13, 75], [-14, 60], [-14, 50]] },
  { name: 'Kuroshio', speed: 1.5, widthKm: 100, path: [[19, 122.5], [23, 123], [27, 127], [31, 132], [34, 139], [35.5, 145], [37, 152]] },
  { name: 'North Pacific Current', speed: 0.2, widthKm: 400, path: [[38, 152], [40, 170], [41, -170], [42, -150], [44, -135]] },
  { name: 'California Current', speed: 0.25, widthKm: 300, path: [[46, -127], [40, -126], [34, -122], [28, -116.5], [22, -112]] },
  { name: 'Pacific North Equatorial Current', speed: 0.3, widthKm: 600, path: [[16, -110], [14, -130], [13, -155], [13, -180], [13, 160], [14, 140], [16, 126]] },
  { name: 'Pacific Equatorial Countercurrent', speed: 0.35, widthKm: 230, path: [[6.5, 135], [6.5, 165], [7, -165], [7, -130], [7, -95]] },
  { name: 'Pacific South Equatorial Current', speed: 0.4, widthKm: 500, path: [[-2, -85], [-3, -105], [-4, -130], [-6, -155], [-9, -180], [-12, 165]] },
  { name: 'Humboldt (Peru) Current', speed: 0.28, widthKm: 330, path: [[-42, -76], [-34, -74], [-26, -72], [-18, -73], [-10, -79], [-4, -83]] },
  { name: 'East Australian Current', speed: 0.8, widthKm: 120, path: [[-14, 154], [-20, 155], [-27, 154.5], [-33, 153], [-37, 151]] },
]);

/** Ocean current (east, north) m/s at a point. Includes the Antarctic Circumpolar Current band. */
export function oceanCurrentAt(lat, lon) {
  lon = wrapLon(lon);
  let e = 0, n = 0, strongest = null, strongestSpeed = 0;
  for (const c of OCEAN_CURRENTS) {
    let best = Infinity, dirE = 0, dirN = 0;
    for (let i = 0; i < c.path.length - 1; i++) {
      const seg = segmentProximityKm(lat, lon, c.path[i], c.path[i + 1]);
      if (seg.dKm < best) { best = seg.dKm; dirE = seg.dirE; dirN = seg.dirN; }
    }
    if (best > c.widthKm * 3) continue;
    const k = Math.exp(-0.5 * (best / c.widthKm) ** 2);
    const s = c.speed * k;
    e += dirE * s; n += dirN * s;
    if (s > strongestSpeed) { strongestSpeed = s; strongest = c.name; }
  }
  // Antarctic Circumpolar Current – broad eastward set between 45°S and 60°S.
  const acc = smooth(-62, -55, lat) * (1 - smooth(-48, -42, lat)) * 0.32;
  if (acc > 0) {
    e += acc;
    if (acc > strongestSpeed) { strongestSpeed = acc; strongest = 'Antarctic Circumpolar Current'; }
  }
  const b = vectorToBearing(e, n);
  return { east: e, north: n, speed: b.speed, setBearing: b.toBearing, name: strongest };
}

function segmentProximityKm(lat, lon, a, b) {
  // Local equirectangular projection around the query point (adequate for jet widths).
  const kx = 111.32 * Math.cos(lat * RAD), ky = 110.57;
  const ax = wrapLon(a[1] - lon) * kx, ay = (a[0] - lat) * ky;
  const bx = wrapLon(b[1] - lon) * kx, by = (b[0] - lat) * ky;
  const vx = bx - ax, vy = by - ay;
  const len2 = vx * vx + vy * vy || 1;
  const t = clamp(-(ax * vx + ay * vy) / len2, 0, 1);
  const px = ax + vx * t, py = ay + vy * t;
  const len = Math.sqrt(len2);
  return { dKm: Math.hypot(px, py), dirE: vx / len, dirN: vy / len };
}

// ---------------------------------------------------------------------------------------------
// Magnetic variation c. 1550
// ---------------------------------------------------------------------------------------------
// Positive = easterly (compass needle points east of true north): true = magnetic + variation.
// Control points follow 16th-century observations: easterly variation in Iberia and the Canaries,
// the agonic line near the Azores where Columbus saw the needle swing from "northeasting" to
// "northwesting" (1492), westerly variation in the Caribbean, and a near-true needle at Cabo das
// Agulhas ("Cape of Needles"). Values are approximate and intended for gameplay.
export const VARIATION_1550_CONTROL_POINTS = Object.freeze([
  [51.5, 0, 11], [43, -9, 9], [38.7, -9.1, 8], [36.5, -6.3, 7.5], [28, -15.5, 6], [16, -24, 3],
  [38, -28, 0], [30, -40, -2.5], [24, -50, -4.5], [18, -66, -6], [23, -82, -4], [27, -92, -2],
  [47, -53, -9], [42, -66, -11], [5, -40, 1], [-8, -35, 5], [-23, -43, 7], [-35, -55, 9],
  [-12, -78, 8], [17, -100, 5], [-34.8, 20, 0], [-25, 33, -6], [-12, 45, -11], [12, 55, -13],
  [15, 73.5, -14], [6, 80, -10], [2.2, 102, -3], [14, 121, 1], [32.7, 129.9, 2], [-5, 5, 2],
  [0, -15, 4], [60, -20, 6], [-50, -30, 10], [-45, 60, -20], [20, -150, 10], [-20, -150, 8],
  [0, 170, 6], [-30, 110, -5], [40, 160, 0],
]);
export function magneticVariation1550(lat, lon) {
  let num = 0, den = 0;
  for (const [plat, plon, v] of VARIATION_1550_CONTROL_POINTS) {
    const d = greatCircleKm(lat, lon, plat, plon);
    if (d < 1) return v;
    const w = 1 / (d * d);
    num += v * w; den += w;
  }
  return den > 0 ? num / den : 0;
}

// ---------------------------------------------------------------------------------------------
// Spherical geometry
// ---------------------------------------------------------------------------------------------
export function greatCircleKm(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * RAD, p2 = lat2 * RAD;
  const dp = p2 - p1, dl = wrapLon(lon2 - lon1) * RAD;
  const a = Math.sin(dp / 2) ** 2 + Math.cos(p1) * Math.cos(p2) * Math.sin(dl / 2) ** 2;
  return (2 * EARTH_RADIUS_M * Math.asin(Math.min(1, Math.sqrt(a)))) / 1000;
}
export function initialBearing(lat1, lon1, lat2, lon2) {
  const p1 = lat1 * RAD, p2 = lat2 * RAD, dl = wrapLon(lon2 - lon1) * RAD;
  const y = Math.sin(dl) * Math.cos(p2);
  const x = Math.cos(p1) * Math.sin(p2) - Math.sin(p1) * Math.cos(p2) * Math.cos(dl);
  return wrap360(Math.atan2(y, x) / RAD);
}
/** Move a geographic point by local east/north metres (small-step dead reckoning). */
export function offsetLatLon(lat, lon, eastM, northM) {
  const newLat = clamp(lat + (northM / EARTH_RADIUS_M) / RAD, -89.5, 89.5);
  const midLat = (lat + newLat) / 2;
  const newLon = wrapLon(lon + (eastM / (EARTH_RADIUS_M * Math.max(0.01, Math.cos(midLat * RAD)))) / RAD);
  return { lat: newLat, lon: newLon };
}
/** East/north metres from point A to point B (local tangent plane; fine for < ~500 km). */
export function eastNorthMetres(latA, lonA, latB, lonB) {
  const midLat = (latA + latB) / 2;
  return {
    east: wrapLon(lonB - lonA) * RAD * EARTH_RADIUS_M * Math.cos(midLat * RAD),
    north: (latB - latA) * RAD * EARTH_RADIUS_M,
  };
}

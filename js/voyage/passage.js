// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// The Chart Course passage: a "covert" time warp.
//
// Waves, hull, sails, crew and the helmsman always run in real time (1×), so the ship still
// feels sailed. Only the *voyage clock* is warped: the sun and stars race, the weather evolves at
// the same accelerated pace, and the ship's geographic position advances by
//     Δposition = warp × (live hull velocity over the ground + ocean current) × Δt_real.
//
// Navigation is 1550 dead reckoning. The pilot plots a DR position from the COMPASS heading
// (corrected only by the variation he knew at departure) and an eyeball/sandglass estimate of
// speed. Leeway, current and changing variation are invisible to him, so DR and truth diverge.
// A noon sun sight resets latitude (± astrolabe error); longitude stays uncertain until landfall.

import {
  DAY_MS,
  METRES_PER_NM,
  sampleOceanWeather,
  oceanCurrentAt,
  magneticVariation1550,
  localSolarHours,
  solarDeclination,
  offsetLatLon,
  greatCircleKm,
  mulberry32,
  hash32,
  formatJulianDate,
  windDescription,
} from './ocean-climate.js';
import { compassPointName, compassPointWords, formatLatitude } from './compass.js';
import { boatForwardSpeed } from '../boat.js';

const PASSAGE_RAD = Math.PI / 180;
const passageClamp = (v, a, b) => Math.max(a, Math.min(b, v));
const passageWrap360 = (d) => ((d % 360) + 360) % 360;

/** Spanish legua used by Casa de Contratación pilots: 17½ leagues to a degree of latitude. */
export const NM_PER_LEAGUE = 60 / 17.5;

export const WARP_TIERS = Object.freeze([
  Object.freeze({ id: 'deck', label: 'On deck', rate: 1 }),
  Object.freeze({ id: 'watch', label: 'Watch', rate: 60 }),
  Object.freeze({ id: 'passage', label: 'Passage', rate: 600 }),
  Object.freeze({ id: 'crossing', label: 'Crossing', rate: 3600 }),
]);
export const warpTier = (id) => WARP_TIERS.find((t) => t.id === id) ?? WARP_TIERS[0];

/** Default departure: Lisboa · Ribeira das Naus (Tagus Estuary), spring 1550 (proleptic Gregorian UTC). */
export const DEFAULT_DEPARTURE = Object.freeze({
  name: 'Lisboa · Ribeira das Naus',
  lat: 38.707,
  lon: -9.136,
  dateMs: Date.UTC(1550, 2, 24, 8, 0, 0), // = 14 March 1550 Julian
});

/**
 * Create a new voyage (plain serializable data).
 */
export function createVoyage({
  lat = DEFAULT_DEPARTURE.lat,
  lon = DEFAULT_DEPARTURE.lon,
  dateMs = DEFAULT_DEPARTURE.dateMs,
  departureName = DEFAULT_DEPARTURE.name,
  modelId = 'nina',
  shipName = 'Niña',
  crew = 24,
  foodDays = 60,
  waterDays = 45,
  difficulty = 'pilot',
  seed = 1550,
  compassCourse = 247,
  destination = null,
} = {}) {
  const rand = mulberry32(hash32(seed, lat, lon));
  const variation = magneticVariation1550(lat, lon);
  return {
    version: 1,
    seed,
    difficulty,
    modelId,
    shipName,
    crew,
    departure: { name: departureName, lat, lon, dateMs },
    destination,
    startMs: dateMs,
    dateMs,
    tier: 'deck',
    rate: 1,
    warpCap: 3600,
    true: { lat, lon },
    dr: { lat, lon },
    trueTrack: [[lat, lon, dateMs]],
    drTrack: [[lat, lon, dateMs]],
    trackSampleMs: dateMs,
    fixes: [],
    marks: [],
    log: [],
    latUncNm: 0,
    lonUncNm: 0,
    distanceLoggedNm: 0,
    distanceTrueNm: 0,
    compassCourse: passageWrap360(compassCourse),
    canvas: 'full',
    pilot: {
      // The variation the pilot believes applies (what he knew at the port of departure).
      variationEstimate: Math.round(variation),
      // Persistent eyeball bias in judging the ship's speed, plus per-watch scatter.
      logBias: 0.9 + rand() * 0.2,
      watchScatter: 1,
      watchIndex: -1,
      sightErrorSeed: Math.floor(rand() * 1e9),
    },
    provisions: { food: foodDays, water: waterDays },
    crewHealth: 1,
    morale: 0.85,
    lastSolarHours: localSolarHours(dateMs, lon),
    lastNoonDay: -1,
    dayAtSea: 0,
    noonLogNm: 0,
    weather: null,
    weatherSampleMs: -Infinity,
    current: { east: 0, north: 0, speed: 0, setBearing: 0, name: null },
    variation,
    interrupt: null,
    lastBeaufort: null,
    arrived: false,
  };
}

export function setWarpTier(voyage, id) {
  voyage.tier = warpTier(id).id;
  return voyage;
}

/** Drop the warp and raise a decision for the player (lookout call, storm, land ho…). */
export function raiseInterrupt(voyage, interrupt, dropTo = 'watch') {
  voyage.interrupt = { ...interrupt, dateMs: voyage.dateMs };
  const target = warpTier(dropTo);
  if (warpTier(voyage.tier).rate > target.rate) voyage.tier = target.id;
  voyage.rate = Math.min(voyage.rate, target.rate);
  if (interrupt.log) addLog(voyage, interrupt.log);
  return voyage.interrupt;
}
export function clearInterrupt(voyage) {
  voyage.interrupt = null;
}

export function addLog(voyage, text, kind = 'entry') {
  voyage.log.push({ dateMs: voyage.dateMs, day: voyage.dayAtSea, text, kind });
  if (voyage.log.length > 400) voyage.log.splice(0, voyage.log.length - 400);
}
export function addMark(voyage, mark) {
  voyage.marks.push({ dateMs: voyage.dateMs, ...mark });
}

/** Ground-referenced hull velocity (east, north m/s) from the live vessel. */
export function hullVelocity(boat) {
  const h = (boat.heading ?? 0) * PASSAGE_RAD;
  const s = boatForwardSpeed(boat);
  const surge = Number.isFinite(s) ? s : 0;
  const rawSway = Number.isFinite(boat.leewayVelocity) ? boat.leewayVelocity : 0;
  const maxSway = Math.max(0, surge) * 0.08;
  const sway = surge > 0.05 ? Math.max(-maxSway, Math.min(maxSway, rawSway)) : rawSway;
  return { east: Math.sin(h) * surge + Math.cos(h) * sway, north: Math.cos(h) * surge - Math.sin(h) * sway, surge };
}

/**
 * Advance the voyage by one real-time frame.
 * @returns {Array} events: {type:'noon'|'day'|'weather'|'provisions'|'storm', ...}
 */
export function stepVoyage(voyage, realDt, { boat, weatherIntervalMs = 15 * 60000, ignoreCurrent = false } = {}) {
  const events = [];
  voyage.lastStep = { eastM: 0, northM: 0, gameDt: 0 };
  if (!boat || !(realDt > 0)) return events;
  realDt = Math.min(realDt, 0.25);
  // Ease the effective rate toward min(tier, governor) so the sky never jerks.
  const target = Math.min(warpTier(voyage.tier).rate, voyage.warpCap ?? 3600);
  const k = 1 - Math.exp(-realDt * (target < voyage.rate ? 4 : 1.2));
  voyage.rate = voyage.rate + (target - voyage.rate) * k;
  if (Math.abs(voyage.rate - target) < 0.5) voyage.rate = target;
  const gameDt = realDt * voyage.rate;
  const prevMs = voyage.dateMs;
  voyage.dateMs += gameDt * 1000;

  // --- True track: real hull motion over the water + ocean current, warped.
  const v = hullVelocity(boat);
  const cur = oceanCurrentAt(voyage.true.lat, voyage.true.lon);
  voyage.current = cur;
  // Near a streamed coast at 1× the local frame is authoritative and has no current field.
  const curScale = ignoreCurrent ? 0 : Math.min(1, Math.max(0, v.surge) / 2.2);
  const ce = cur.east * curScale, cn = cur.north * curScale;
  const eastM = (v.east + ce) * gameDt, northM = (v.north + cn) * gameDt;
  voyage.lastStep = { eastM, northM, gameDt };
  const np = offsetLatLon(voyage.true.lat, voyage.true.lon, eastM, northM);
  voyage.distanceTrueNm += Math.hypot(eastM, northM) / METRES_PER_NM;
  voyage.true.lat = np.lat;
  voyage.true.lon = np.lon;
  voyage.variation = magneticVariation1550(np.lat, np.lon);

  // --- Dead reckoning: compass heading + believed variation, eyeballed speed, no leeway/current.
  const watch = Math.floor((voyage.dateMs - voyage.startMs) / (4 * 3600000));
  if (watch !== voyage.pilot.watchIndex) {
    voyage.pilot.watchIndex = watch;
    const r = mulberry32(hash32(voyage.seed, watch, 17));
    voyage.pilot.watchScatter = 0.94 + r() * 0.12;
  }
  const compassHeading = passageWrap360((boat.heading ?? 0) - voyage.variation);
  const drBearing = passageWrap360(compassHeading + voyage.pilot.variationEstimate);
  const estSpeed = Math.max(0, v.surge) * voyage.pilot.logBias * voyage.pilot.watchScatter;
  const drDist = estSpeed * gameDt;
  const dp = offsetLatLon(voyage.dr.lat, voyage.dr.lon, Math.sin(drBearing * PASSAGE_RAD) * drDist, Math.cos(drBearing * PASSAGE_RAD) * drDist);
  voyage.dr.lat = dp.lat;
  voyage.dr.lon = dp.lon;
  const loggedNm = drDist / METRES_PER_NM;
  voyage.distanceLoggedNm += loggedNm;
  voyage.noonLogNm += loggedNm;
  // Uncertainty grows with distance run and with time (unknown set & drift).
  const hours = gameDt / 3600;
  voyage.latUncNm += loggedNm * 0.05 + hours * 0.12;
  voyage.lonUncNm += loggedNm * 0.07 + hours * 0.18;

  // --- Track sampling (every 30 voyage-minutes, and always on the first sample).
  if (voyage.dateMs - voyage.trackSampleMs >= 30 * 60000) {
    voyage.trackSampleMs = voyage.dateMs;
    voyage.trueTrack.push([voyage.true.lat, voyage.true.lon, voyage.dateMs]);
    voyage.drTrack.push([voyage.dr.lat, voyage.dr.lon, voyage.dateMs]);
    const cap = 6000;
    if (voyage.trueTrack.length > cap) { voyage.trueTrack = passageDecimate(voyage.trueTrack); voyage.drTrack = passageDecimate(voyage.drTrack); }
  }

  // --- Weather (sampled on voyage time so it evolves exactly as fast as the sun moves).
  if (voyage.dateMs - voyage.weatherSampleMs >= weatherIntervalMs || !voyage.weather) {
    voyage.weatherSampleMs = voyage.dateMs;
    const w = sampleOceanWeather(voyage.true.lat, voyage.true.lon, voyage.dateMs, { seed: voyage.seed });
    const prevB = voyage.lastBeaufort;
    voyage.weather = w;
    voyage.lastBeaufort = w.beaufort;
    if (prevB !== null && Math.abs(w.beaufort - prevB) >= 2) {
      events.push({ type: 'weather', from: prevB, to: w.beaufort, weather: w });
    }
    if (!voyage.passive && voyage.distanceTrueNm > 5 && w.nearestSystem && w.nearestSystem.intensity > 0.35 && w.nearestSystem.distanceKm < w.nearestSystem.radiusKm * 1.1 && !voyage.stormWarned) {
      voyage.stormWarned = true;
      events.push({ type: 'storm', system: w.nearestSystem, weather: w });
    } else if (!w.nearestSystem || w.nearestSystem.distanceKm > w.nearestSystem.radiusKm * 1.6) {
      voyage.stormWarned = false;
    }
  }

  // --- Provisions, health and morale (per voyage day).
  const days = gameDt / 86400;
  voyage.provisions.food = Math.max(0, voyage.provisions.food - days);
  voyage.provisions.water = Math.max(0, voyage.provisions.water - days);
  const elapsedDays = (voyage.dateMs - voyage.startMs) / DAY_MS;
  const scurvy = elapsedDays > 56 ? (elapsedDays - 56) * 0.004 : 0;
  const thirst = voyage.provisions.water <= 0 ? 0.06 : 0;
  const hunger = voyage.provisions.food <= 0 ? 0.03 : 0;
  voyage.crewHealth = passageClamp(voyage.crewHealth - (scurvy + thirst + hunger) * days, 0, 1);
  const moraleDrift = -0.004 - (voyage.provisions.water < 7 ? 0.02 : 0) - (voyage.crewHealth < 0.7 ? 0.015 : 0);
  voyage.morale = passageClamp(voyage.morale + moraleDrift * days, 0, 1);
  for (const [key, label] of [['water', 'water'], ['food', 'biscuit and salt meat']]) {
    for (const threshold of [14, 7, 3]) {
      const flag = `${key}${threshold}`;
      if (voyage.provisions[key] <= threshold && !voyage[flag]) {
        voyage[flag] = true;
        events.push({ type: 'provisions', key, days: threshold, text: `The steward reports ${threshold} days of ${label} remaining.` });
      }
    }
  }

  // --- Local apparent noon: sun sight and the ship's day (which ran noon to noon).
  const solar = localSolarHours(voyage.dateMs, voyage.true.lon);
  const crossedNoon = gameDt < 20 * 3600 && voyage.lastSolarHours < 12 && solar >= 12 && solar - voyage.lastSolarHours < 12;
  voyage.lastSolarHours = solar;
  if (crossedNoon) events.push(...takeNoonSight(voyage, boat));
  void prevMs;
  return events;
}

/** Noon routine: astrolabe sight (weather permitting) and the day's log entry. */
export function takeNoonSight(voyage, boat = null) {
  const events = [];
  voyage.dayAtSea += 1;
  const w = voyage.weather;
  const overcast = w && (w.clouds > 0.86 || w.rain > 0.45);
  // Sun altitude at noon decides whether an astrolabe sight is even possible (sun too high
  // near the zenith is awkward but workable; we just widen the error).
  const dec = solarDeclination(voyage.dateMs);
  const zenithDistance = Math.abs(voyage.true.lat - dec);
  let fixText;
  if (!overcast) {
    const r = mulberry32(hash32(voyage.pilot.sightErrorSeed, voyage.dayAtSea));
    const sigma = zenithDistance < 6 ? 0.45 : 0.22; // degrees
    const gauss = Math.sqrt(-2 * Math.log(Math.max(1e-9, r()))) * Math.cos(2 * Math.PI * r());
    const observedLat = voyage.true.lat + gauss * sigma * (w?.beaufort >= 7 ? 1.8 : 1);
    voyage.dr.lat = observedLat;
    voyage.latUncNm = sigma * 60;
    voyage.fixes.push({ kind: 'noon', lat: observedLat, lon: voyage.dr.lon, dateMs: voyage.dateMs });
    fixText = `Noon sun by the astrolabe gives ${formatLatitude(observedLat)}`;
    events.push({ type: 'noon', fix: true, lat: observedLat });
  } else {
    fixText = 'Sky overcast at noon; no sun to be had';
    events.push({ type: 'noon', fix: false });
  }
  const wind = w ? `Wind ${compassPointName(w.windFrom)}, ${windDescription(w.windSpeed)}` : 'Wind variable';
  const leagues = voyage.noonLogNm / NM_PER_LEAGUE;
  const course = `steering ${compassPointWords(voyage.compassCourse)} by the compass`;
  const morale = voyage.morale > 0.7 ? 'The men are content.' : voyage.morale > 0.45 ? 'The men grumble at the length of the voyage.' : 'The men are sullen and talk of turning back.';
  addLog(voyage, `${formatJulianDate(voyage.dateMs)}, day ${voyage.dayAtSea} at sea. ${wind}; ${course}. Made good by reckoning ${leagues.toFixed(0)} leagues. ${fixText}. ${morale}`, 'day');
  voyage.noonLogNm = 0;
  events.push({ type: 'day', day: voyage.dayAtSea });
  void boat;
  return events;
}

/** Reconcile DR with truth (landfall, recognised headland). Returns the reckoning error. */
export function revealTruePosition(voyage, reason = 'landfall') {
  const errorKm = greatCircleKm(voyage.dr.lat, voyage.dr.lon, voyage.true.lat, voyage.true.lon);
  const errorLeagues = errorKm / 1.852 / NM_PER_LEAGUE;
  voyage.fixes.push({ kind: reason, lat: voyage.true.lat, lon: voyage.true.lon, dateMs: voyage.dateMs, errorLeagues });
  voyage.dr = { ...voyage.true };
  voyage.latUncNm = 0;
  voyage.lonUncNm = 0;
  return { errorKm, errorLeagues };
}

/** Pilot's verdict on the reckoning error at landfall. */
export function reckoningVerdict(errorLeagues, daysAtSea) {
  const perDay = errorLeagues / Math.max(1, daysAtSea);
  if (errorLeagues < 8) return { rank: 'Piloto Mayor', text: 'A masterful reckoning — worthy of the Casa de Contratación.' };
  if (perDay < 1.2) return { rank: 'Piloto', text: 'A sound reckoning. The pilots of Seville would sign your chart.' };
  if (perDay < 2.5) return { rank: 'Marinero', text: 'An honest reckoning, though the sea carried you further than you knew.' };
  return { rank: 'Grumete', text: 'The currents made sport of your reckoning. Trust the noon sun, and watch the set of the sea.' };
}

/** Compact data for the chart drawer. Hides the true position unless revealed/easy. */
export function voyageSnapshot(voyage) {
  const revealTrue = voyage.difficulty === 'easy' || voyage.arrived;
  return {
    date: new Date(voyage.dateMs).toISOString(),
    dateMs: voyage.dateMs,
    dateLabel: `${formatJulianDate(voyage.dateMs)} · day ${voyage.dayAtSea} at sea`,
    drPos: { ...voyage.dr },
    drTrack: voyage.drTrack.map(([a, b]) => [a, b]),
    revealTrue,
    truePos: revealTrue ? { ...voyage.true } : undefined,
    trueTrack: revealTrue ? voyage.trueTrack.map(([a, b]) => [a, b]) : undefined,
    fixes: voyage.fixes.map((f) => ({ ...f, date: new Date(f.dateMs).toISOString() })),
    uncertaintyNm: Math.hypot(voyage.latUncNm, voyage.lonUncNm),
    latUncNm: voyage.latUncNm,
    lonUncNm: voyage.lonUncNm,
    courseCompass: voyage.compassCourse,
    courseTrue: passageWrap360(voyage.compassCourse + voyage.pilot.variationEstimate),
    destination: voyage.destination,
    marks: voyage.marks,
    discoveries: voyage.discoveries ?? [],
    warp: voyage.rate,
    tier: voyage.tier,
    warpTiers: WARP_TIERS,
    log: voyage.log.map((e) => ({ date: new Date(e.dateMs).toISOString(), text: e.text, kind: e.kind })),
    provisions: { daysFood: voyage.provisions.food, daysWater: voyage.provisions.water },
    crewHealth: voyage.crewHealth,
    morale: voyage.morale,
    ship: { name: voyage.shipName, modelId: voyage.modelId },
    distanceLoggedLeagues: voyage.distanceLoggedNm / NM_PER_LEAGUE,
    weather: voyage.weather ? { windFrom: voyage.weather.windFrom, windSpeed: voyage.weather.windSpeed, description: voyage.weather.description } : null,
  };
}

export function serializeVoyage(voyage) {
  const { weather, ...rest } = voyage;
  void weather;
  return JSON.stringify(rest);
}
export function restoreVoyage(json) {
  const v = typeof json === 'string' ? JSON.parse(json) : json;
  if (!v || v.version !== 1 || !v.true || !v.dr) return null;
  v.weather = null;
  v.weatherSampleMs = -Infinity;
  v.interrupt = null;
  v.rate = 1;
  v.tier = 'deck';
  return v;
}

function passageDecimate(track) {
  return track.filter((_, i) => i % 2 === 0 || i === track.length - 1);
}

// ---------------------------------------------------------------------------------------------
// Weather driver: eases the renderer/physics settings toward the voyage weather.
// ---------------------------------------------------------------------------------------------
const PASSAGE_SKY_KEYS = ['clouds', 'rain', 'thunder', 'haze', 'cloudBase', 'cloudDepth', 'cloudDensity', 'cloudAnvil'];

/**
 * Creates a driver that writes voyage weather into the live settings object `P` each frame.
 * Wind used by the sails eases continuously; the FFT wave spectrum (which resets the sea when
 * regenerated) is only refreshed when the sea state has drifted noticeably, and at most every
 * `minSpectrumSeconds` of real time. Returns { update(P, weather, rate, realDt) -> {spectrum, env} }.
 */
export function createWeatherDriver({ minSpectrumSeconds = 9, gameTauHours = 1.2, minTauSeconds = 1.5 } = {}) {
  let sinceSpectrum = Infinity;
  let spectrumWind = null, spectrumDir = null, spectrumSwell = null;
  return {
    update(P, weather, rate, realDt) {
      const result = { spectrum: false, env: false };
      if (!weather || !(realDt > 0)) return result;
      sinceSpectrum += realDt;
      const tau = Math.max(minTauSeconds, (gameTauHours * 3600) / Math.max(1, rate));
      const k = 1 - Math.exp(-realDt / tau);
      P.windSpeed = Number((P.windSpeed + (weather.windSpeed - P.windSpeed) * k).toFixed(3));
      let dd = ((weather.windDir - P.windDir + 540) % 360) - 180;
      P.windDir = Number((((P.windDir + dd * k) % 360 + 360) % 360).toFixed(2));
      let envDelta = 0;
      for (const key of PASSAGE_SKY_KEYS) {
        if (weather[key] === undefined) continue;
        const before = P[key] ?? weather[key];
        P[key] = before + (weather[key] - before) * k;
        envDelta += Math.abs(P[key] - before);
      }
      result.env = envDelta > 0.002;
      if (spectrumWind === null) { spectrumWind = P.windSpeed; spectrumDir = P.windDir; spectrumSwell = P.swellHs ?? weather.swellHs; }
      const swellTarget = weather.swellHs;
      const dirDrift = Math.abs(((P.windDir - spectrumDir + 540) % 360) - 180);
      const drifted = Math.abs(P.windSpeed - spectrumWind) >= 1.5 || dirDrift >= 14 || Math.abs((P.swellHs ?? swellTarget) - swellTarget) >= 0.6;
      if (drifted && sinceSpectrum >= minSpectrumSeconds) {
        sinceSpectrum = 0;
        spectrumWind = P.windSpeed;
        spectrumDir = P.windDir;
        P.swellHs = Number(((P.swellHs ?? swellTarget) + (swellTarget - (P.swellHs ?? swellTarget)) * 0.7).toFixed(2));
        P.swellDir = Math.round(weather.swellDir);
        P.swellLength = Math.round(weather.swellLength);
        spectrumSwell = P.swellHs;
        result.spectrum = true;
      }
      void spectrumSwell;
      return result;
    },
    reset() { sinceSpectrum = Infinity; spectrumWind = spectrumDir = spectrumSwell = null; },
  };
}

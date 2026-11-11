// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  prevailingWind,
  sampleOceanWeather,
  oceanCurrentAt,
  magneticVariation1550,
  weatherSystemsAt,
  rendererDirFromCompassFrom,
  compassFromRendererDir,
  julianDateParts,
  formatJulianDate,
  localSolarHours,
  greatCircleKm,
} from '../js/voyage/ocean-climate.js';
import {
  visibilityRangeKm,
  curvatureDropM,
  hiddenHeightM,
  createCoastlineIndex,
  createDemProbe,
  scanForLand,
  coastlineToward,
  warpStandoffM,
  warpCapForHazard,
  visibleLandPoint,
  approachStage,
  approachWarpCap,
  regionLocalOrigin,
  destinationPoint,
  lonLatToTile,
} from '../js/voyage/landfall-approach.js';
import { createHelmsman, steerHelmsman, orderCourse, applyCanvasOrder, canvasAdvice, MIN_BEAT_LEG_REAL_S } from '../js/voyage/helmsman.js';
import { compassPointName, compassPointWords, relativeBearingCall, formatLatitude } from '../js/voyage/compass.js';
import {
  createVoyage,
  stepVoyage,
  setWarpTier,
  raiseInterrupt,
  clearInterrupt,
  revealTruePosition,
  reckoningVerdict,
  voyageSnapshot,
  serializeVoyage,
  restoreVoyage,
  createWeatherDriver,
  WARP_TIERS,
} from '../js/voyage/passage.js';
import { createEncounterDirector } from '../js/voyage/encounters.js';
import { createVoyageController } from '../js/voyage/voyage-controller.js';
import { constrainIslandMotion } from '../js/terrain-model.js';
import { createAstronomyClock, computeAstronomy } from '../js/astronomy.js';

// The controller holds warp until the coastline it was promised has arrived: let that promise settle.
const chartsAboard = () => new Promise((resolve) => setImmediate(resolve));
const MARCH_1550 = Date.UTC(1550, 2, 24, 12);
const JULY_1550 = Date.UTC(1550, 6, 15, 12);
const JAN_1550 = Date.UTC(1550, 0, 15, 12);
const inArc = (deg, lo, hi) => (lo <= hi ? deg >= lo && deg <= hi : deg >= lo || deg <= hi);

test('prevailing wind belts reproduce trades, doldrums, westerlies, roaring forties and the monsoon', () => {
  const ne = prevailingWind(16, -40, MARCH_1550);
  assert.ok(inArc(ne.fromBearing, 30, 100), `NE trades from ${ne.fromBearing.toFixed(0)}°`);
  assert.ok(ne.speed > 5 && ne.speed < 10);
  const se = prevailingWind(-15, -20, MARCH_1550);
  assert.ok(inArc(se.fromBearing, 90, 160), `SE trades from ${se.fromBearing.toFixed(0)}°`);
  const west = prevailingWind(46, -30, JAN_1550);
  assert.ok(inArc(west.fromBearing, 200, 300), `westerlies from ${west.fromBearing.toFixed(0)}°`);
  assert.ok(west.speed > 8, 'winter westerlies blow fresh');
  const forties = prevailingWind(-45, 60, JULY_1550);
  assert.ok(inArc(forties.fromBearing, 250, 330) && forties.speed > 10, 'roaring forties');
  const doldrums = prevailingWind(3, -25, MARCH_1550);
  assert.ok(doldrums.speed < 3, `doldrums are light (${doldrums.speed.toFixed(1)} m/s)`);
  const swMonsoon = prevailingWind(12, 65, JULY_1550);
  assert.ok(inArc(swMonsoon.fromBearing, 180, 270), `SW monsoon from ${swMonsoon.fromBearing.toFixed(0)}°`);
  const neMonsoon = prevailingWind(12, 65, JAN_1550);
  assert.ok(inArc(neMonsoon.fromBearing, 0, 90), `NE monsoon from ${neMonsoon.fromBearing.toFixed(0)}°`);
});

test('renderer wind convention round-trips with compass bearings', () => {
  assert.equal(rendererDirFromCompassFrom(0), 90, 'north wind blows toward +Z (south)');
  for (const b of [0, 45, 123, 270, 359]) assert.ok(Math.abs(compassFromRendererDir(rendererDirFromCompassFrom(b)) - b) < 1e-9);
});

test('ocean currents: Gulf Stream, Canary, Agulhas and a quiet mid-gyre', () => {
  const gs = oceanCurrentAt(30, -79.9);
  assert.ok(gs.speed > 1 && inArc(gs.setBearing, 340, 60), `Gulf Stream ${gs.speed.toFixed(2)} m/s toward ${gs.setBearing.toFixed(0)}°`);
  const canary = oceanCurrentAt(30, -15);
  assert.ok(inArc(canary.setBearing, 150, 240), `Canary current sets ${canary.setBearing.toFixed(0)}°`);
  const agulhas = oceanCurrentAt(-31.5, 30);
  assert.ok(agulhas.speed > 0.8 && inArc(agulhas.setBearing, 180, 260));
  assert.ok(oceanCurrentAt(30, -45).speed < 0.25, 'Sargasso Sea is quiet');
});

test('1550 magnetic variation: easterly in Iberia, agonic near the Azores, westerly in the Caribbean, true at Agulhas', () => {
  assert.ok(magneticVariation1550(38.7, -9.1) > 6);
  assert.ok(Math.abs(magneticVariation1550(38, -28)) < 1.5);
  assert.ok(magneticVariation1550(18, -66) < -3);
  assert.ok(Math.abs(magneticVariation1550(-34.8, 20)) < 1.5);
});

test('weather is deterministic, continuous in time, and hurricanes respect the season', () => {
  const a = sampleOceanWeather(25, -50, MARCH_1550, { seed: 7 });
  const b = sampleOceanWeather(25, -50, MARCH_1550, { seed: 7 });
  assert.deepEqual({ ...a, systems: null }, { ...b, systems: null });
  let maxJump = 0;
  for (let i = 0; i < 200; i++) {
    const t = MARCH_1550 + i * 3 * 3600000;
    const w0 = sampleOceanWeather(40, -35, t, { seed: 3 });
    const w1 = sampleOceanWeather(40, -35, t + 60000, { seed: 3 });
    maxJump = Math.max(maxJump, Math.abs(w1.windSpeed - w0.windSpeed));
    for (const w of [w0, w1]) {
      assert.ok(w.windSpeed >= 0.3 && w.windSpeed <= 34);
      assert.ok(w.swellHs >= 0.3 && w.swellHs <= 8);
      assert.ok(w.clouds >= 0 && w.clouds <= 1 && w.rain >= 0 && w.rain <= 1);
    }
  }
  assert.ok(maxJump < 1.5, `one voyage-minute never jumps the wind (${maxJump.toFixed(2)} m/s)`);
  const atlanticHurricanes = (from, to) => {
    let n = 0;
    for (let t = from; t < to; t += 86400000) n += weatherSystemsAt(t, { seed: 1550 }).filter((s) => s.kind === 'hurricane' && s.lon < -20 && s.lon > -100 && s.lat > 5).length;
    return n;
  };
  assert.ok(atlanticHurricanes(Date.UTC(1550, 7, 1), Date.UTC(1550, 9, 31)) > 0, 'hurricane season produces storms');
  assert.equal(atlanticHurricanes(Date.UTC(1550, 1, 1), Date.UTC(1550, 3, 15)), 0, 'no Atlantic hurricanes in spring');
});

test('calendar: 1550 dates display in the Julian calendar and solar time follows longitude', () => {
  const j = julianDateParts(Date.UTC(1550, 2, 24, 8));
  assert.deepEqual([j.year, j.month, j.day], [1550, 3, 14]);
  assert.equal(formatJulianDate(Date.UTC(1550, 2, 24, 8)), '14 de marzo de 1550');
  const noonGreenwich = localSolarHours(Date.UTC(1550, 3, 15, 12), 0);
  const noonWest = localSolarHours(Date.UTC(1550, 3, 15, 12), -90);
  assert.ok(Math.abs(noonGreenwich - 12) < 0.3 && Math.abs(noonWest - 6) < 0.3);
});

test('masthead visibility and earth curvature follow navigators’ distance-of-horizon tables', () => {
  const r = visibilityRangeKm(20, 300);
  assert.ok(r > 78 && r < 90, `300 m peak from a 20 m masthead: ${r.toFixed(1)} km`);
  const lowCoast = visibilityRangeKm(20, 10);
  assert.ok(lowCoast > 25 && lowCoast < 32);
  const drop = curvatureDropM(40000);
  assert.ok(drop > 100 && drop < 120, `40 km drop ${drop.toFixed(0)} m`);
  assert.ok(hiddenHeightM(10000, 25) < 1, 'nothing hidden inside the horizon');
});

test('coastline index answers land and nearest-coast queries', () => {
  const ring = [[-10, 10], [10, 10], [10, 30], [-10, 30], [-10, 10]];
  const idx = createCoastlineIndex([ring]);
  assert.equal(idx.isLand(20, 0), true);
  assert.equal(idx.isLand(5, 0), false);
  const c = idx.nearestCoast(8, 0, 600);
  assert.ok(c && Math.abs(c.distanceKm - 221) < 10 && Math.abs(c.bearing) < 2);
  assert.equal(idx.nearestCoast(-10, 0, 300), null);
});

test('DEM probe sights a high island only once it tops the horizon and finds the shoreline toward it', async () => {
  const islandLat = 20, islandLon = -60;
  const loadTile = (z, x, y) => {
    const data = new Float32Array(256 * 256).fill(-3000);
    const n = 2 ** z;
    for (let py = 0; py < 256; py++) for (let px = 0; px < 256; px++) {
      const lon = ((x + (px + 0.5) / 256) / n) * 360 - 180;
      const yy = y + (py + 0.5) / 256;
      const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * yy) / n))) * 180) / Math.PI;
      const d = greatCircleKm(lat, lon, islandLat, islandLon);
      if (d < 12) data[py * 256 + px] = 600 * (1 - d / 12) + 2;
    }
    return data;
  };
  const probe = createDemProbe({ loadTile });
  const far = destinationPoint(islandLat, islandLon, 90, 140);
  await probe.prefetch(far.lat, far.lon, 170);
  const scanFar = scanForLand(probe, far.lat, far.lon, { eyeM: 20, maxKm: 160 });
  assert.equal(scanFar.complete, true);
  assert.equal(scanFar.visible, null, '600 m island is hull-down at 140 km');
  assert.ok(scanFar.nearest && scanFar.nearest.distanceKm < 140);
  const near = destinationPoint(islandLat, islandLon, 90, 70);
  await probe.prefetch(near.lat, near.lon, 170);
  const scanNear = scanForLand(probe, near.lat, near.lon, { eyeM: 20, maxKm: 160 });
  assert.ok(scanNear.visible, 'island visible at ~70 km');
  assert.ok(Math.abs(((scanNear.visible.bearing - 270 + 540) % 360) - 180) < 8, 'land bears west');
  const shore = coastlineToward(probe, near.lat, near.lon, scanNear.visible);
  assert.ok(shore.distanceKm > 50 && shore.distanceKm < 62, `shoreline ~58 km away (${shore.distanceKm.toFixed(1)})`);
  assert.ok(lonLatToTile(0, 0, 6).x === 32);
});

test('approach staging and warp governor never let the covert warp skip a coastline', () => {
  assert.equal(approachStage({ coastKm: 900 }), 'open');
  assert.equal(approachStage({ coastKm: 200, sightKm: 60 }), 'prefetch');
  assert.equal(approachStage({ coastKm: 100, sightKm: 60 }), 'preload');
  assert.equal(approachStage({ coastKm: 50, visible: true }), 'sighting');
  assert.equal(approachWarpCap({ coastKm: 2000, sightKm: 60, groundSpeed: 3 }), 3600);
  const cap = approachWarpCap({ coastKm: 120, sightKm: 60, groundSpeed: 3, leadSeconds: 25 });
  assert.ok(cap < 1000 && cap >= 30, `cap near land ${cap.toFixed(0)}`);
  // At the capped rate, real seconds until the horizon is reached stays >= the lead time.
  const secondsLeft = ((120 - 60 - 8) * 1000) / (3 * cap);
  assert.ok(secondsLeft >= 24.9);
  const origin = regionLocalOrigin({ shipLat: 18, shipLon: -66, shipX: 100, shipZ: -50, regionLat: 18, regionLon: -66 + 10 / (111.195 * Math.cos((18 * Math.PI) / 180)) });
  assert.ok(Math.abs(origin.x - 10100) < 5 && Math.abs(origin.z + 50) < 1);
});

test('compass points, spoken courses, and lookout calls', () => {
  assert.equal(compassPointName(0), 'N');
  assert.equal(compassPointName(236), 'SW by W');
  assert.equal(compassPointName(348.75), 'N by W');
  assert.equal(compassPointWords(236), 'south-west by west');
  assert.equal(compassPointWords(247.5), 'west-southwest');
  assert.equal(relativeBearingCall(0), 'dead ahead');
  assert.equal(relativeBearingCall(22.5), 'two points off the starboard bow');
  assert.equal(relativeBearingCall(-90), 'on the larboard beam');
  assert.equal(relativeBearingCall(135), 'broad on the starboard quarter');
  assert.equal(relativeBearingCall(180), 'right astern');
  assert.equal(formatLatitude(21.6667), '21° 40′ N');
});

test('helmsman holds a compass course with the rudder and reports when it lies inside the wind', () => {
  const boat = { modelId: 'nina', heading: 0, yawRate: 0, surgeVelocity: 3, leewayVelocity: 0, length: 20 };
  const helm = createHelmsman({ compassCourse: 40 });
  // Wind from the west (θ = 270+90 = 0 rad in renderer convention).
  steerHelmsman(helm, boat, 0.1, { windSpeed: 8, windDirection: 0, variation: 0 });
  assert.ok(boat.rudderTarget > 0, 'turns to starboard toward 040');
  assert.equal(helm.canLieCourse, true);
  orderCourse(helm, 270);
  steerHelmsman(helm, boat, 0.1, { windSpeed: 8, windDirection: 0, variation: 0 });
  assert.equal(helm.canLieCourse, false, 'cannot steer dead into a westerly');
  assert.match(helm.status, /Close-hauled/);
  // Variation: compass 000 with 10° E variation means a true course of 010 (wind from the south).
  const helm2 = createHelmsman({ compassCourse: 0 });
  boat.heading = 10;
  steerHelmsman(helm2, boat, 0.1, { windSpeed: 8, windDirection: -Math.PI / 2, variation: 10 });
  assert.ok(Math.abs(helm2.trueCourse - 10) < 1e-9);
  assert.ok(Math.abs(boat.rudderTarget) < 2, 'already on course');
  applyCanvasOrder(boat, 'reduced');
  assert.deepEqual([boat.sailFore, boat.sailMain, boat.sailMizzen], [0.6, 0.6, 0.5]);
  assert.equal(canvasAdvice('full', 19).severity, 'warning');
  assert.equal(canvasAdvice('reduced', 9), null);
});

test('covert warp: real-time hull, warped voyage clock, DR diverges from truth, noon sights fix latitude', () => {
  const voyage = createVoyage({ lat: 28, lon: -16, dateMs: Date.UTC(1550, 3, 1, 6), seed: 11, compassCourse: 260 });
  setWarpTier(voyage, 'crossing');
  const boat = { modelId: 'nina', heading: 252, surgeVelocity: 3, leewayVelocity: 0.25, yawRate: 0 };
  let noons = 0, fixes = 0, steps = 0;
  const start = voyage.dateMs;
  while (voyage.dateMs - start < 3 * 86400000 && steps < 200000) {
    for (const e of stepVoyage(voyage, 1 / 30, { boat })) {
      if (e.type === 'noon') { noons++; if (e.fix) fixes++; }
    }
    steps++;
  }
  assert.ok(Math.abs(voyage.rate - 3600) < 1, 'rate eases up to the crossing tier');
  assert.ok(steps < 3 * 86400 / 3600 * 30 * 1.2, 'three voyage days take ~72 real seconds at 3600×');
  assert.ok(noons === 3 || noons === 2, `local noon happens once a day (${noons})`);
  assert.ok(voyage.log.some((e) => e.kind === 'day'), 'daily log written');
  const sailedKm = greatCircleKm(28, -16, voyage.true.lat, voyage.true.lon);
  assert.ok(sailedKm > 600 && sailedKm < 1100, `three days of 3 m/s plus current ≈ 780 km (${sailedKm.toFixed(0)})`);
  const errKm = greatCircleKm(voyage.dr.lat, voyage.dr.lon, voyage.true.lat, voyage.true.lon);
  assert.ok(errKm > 2, 'leeway, current, and variation make DR diverge from truth');
  if (fixes) assert.ok(Math.abs(voyage.dr.lat - voyage.true.lat) < 1.2, 'noon fix pulls DR latitude near the truth');
  assert.ok(voyage.provisions.water < 45 - 2.9);
  const snap = voyageSnapshot(voyage);
  assert.equal(snap.revealTrue, false);
  assert.equal(snap.truePos, undefined, 'true position hidden in pilot mode');
  assert.ok(snap.drTrack.length > 100);
  const restored = restoreVoyage(serializeVoyage(voyage));
  assert.equal(restored.true.lat, voyage.true.lat);
  const result = revealTruePosition(voyage);
  assert.ok(result.errorLeagues >= 0);
  assert.ok(reckoningVerdict(3, 30).rank === 'Piloto Mayor');
  assert.equal(WARP_TIERS.at(-1).rate, 3600);
});

test('warp governor caps and interrupts drop the warp', () => {
  const voyage = createVoyage({ seed: 2 });
  setWarpTier(voyage, 'crossing');
  voyage.warpCap = 120;
  const boat = { heading: 250, surgeVelocity: 2.5, leewayVelocity: 0 };
  for (let i = 0; i < 300; i++) stepVoyage(voyage, 1 / 30, { boat });
  assert.ok(voyage.rate <= 120.5, 'cap respected');
  raiseInterrupt(voyage, { type: 'sail-ho', text: 'Sail ho!' }, 'deck');
  assert.equal(voyage.tier, 'deck');
  assert.equal(voyage.rate, 1);
});

test('weather driver eases sail wind continuously but rate-limits wave-spectrum regeneration', () => {
  const P = { windSpeed: 5, windDir: 0, swellHs: 1, swellDir: 0, swellLength: 80, clouds: 0.3, rain: 0, thunder: 0, haze: 1, cloudBase: 1.2, cloudDepth: 1.8, cloudDensity: 1, cloudAnvil: 0.05 };
  const driver = createWeatherDriver({ minSpectrumSeconds: 9 });
  const target = { windSpeed: 15, windDir: 60, swellHs: 4, swellDir: 60, swellLength: 140, clouds: 0.8, rain: 0.5, thunder: 0, haze: 3, cloudBase: 0.9, cloudDepth: 3, cloudDensity: 1.4, cloudAnvil: 0.2 };
  let regenerations = 0;
  for (let i = 0; i < 30 * 20; i++) if (driver.update(P, target, 3600, 1 / 30).spectrum) regenerations++;
  assert.ok(P.windSpeed > 14.5, 'sail wind reached the target');
  assert.ok(regenerations >= 1 && regenerations <= 3, `spectrum regenerated ${regenerations}× in 20 s`);
});

test('always-on 1× real-time sailing continuously integrates true and dead-reckoning lat/lon', () => {
  const voyage = createVoyage({ lat: 36.72, lon: -6.52, seed: 1550, compassCourse: 250 });
  assert.equal(voyage.tier, 'deck');
  assert.equal(voyage.rate, 1);
  const boat = { heading: 250, surgeVelocity: 3.5, leewayVelocity: 0.15 };
  for (let i = 0; i < 600; i++) {
    stepVoyage(voyage, 0.1, { boat });
  }
  assert.ok(voyage.true.lon < -6.52, 'sailing WSW at 1× real-time advances true longitude westward');
  assert.ok(voyage.dr.lon < -6.52, 'sailing WSW at 1× real-time advances DR longitude westward');
  assert.ok(voyage.distanceTrueNm > 0.1, 'accumulates true nautical miles at 1×');
});

test('open-ocean encounter director triggers whale breaches and strange-sail lookout choices', () => {
  const voyage = createVoyage({ lat: 24.0, lon: -45.0, seed: 42, compassCourse: 255 });
  setWarpTier(voyage, 'crossing');
  voyage.rate = 3600;
  const boat = { heading: 255, surgeVelocity: 3.2, leewayVelocity: 0 };
  const director = createEncounterDirector({ seed: 101 });

  let whaleTriggered = false;
  const marineLife = { state: { trigger: () => { whaleTriggered = true; } } };
  const wEnc = director.spawnWhaleEncounter(voyage, boat, { marineLife });
  assert.equal(wEnc.kind, 'whale');
  assert.equal(whaleTriggered, true, 'triggers live 3D humpback whale encounter');

  const sEnc = director.spawnSailEncounter(voyage, boat, {});
  assert.equal(sEnc.kind, 'sail');
  assert.ok(voyage.interrupt && voyage.interrupt.type === 'sail', 'raises lookout sail interrupt');
  assert.equal(voyage.tier, 'watch', 'drops warp from crossing to watch');

  // Force friendly encounter to test hailing & comparing pilot reckoning
  sEnc.actuallyHostile = false;
  voyage.dr.lat = voyage.true.lat + 1.5;
  voyage.dr.lon = voyage.true.lon - 2.5;
  voyage.lonUncNm = 40;
  clearInterrupt(voyage);
  const hailRes = director.resolveDecision('hail', voyage, boat, null, {});
  assert.equal(hailRes.combatStarted, false);
  assert.ok(Math.abs(voyage.dr.lon - voyage.true.lon) < 1.0, 'hailing a friendly pilot refines DR longitude');
  assert.ok(voyage.lonUncNm < 25, 'hailing reduces longitude uncertainty');
});

test('high-warp ship heading into a continent stops offshore in navigable water and commits terrain offset', async () => {
  // 1. Coarse coastline index forwardCoast & overland guard when terrain is still generating
  const iberiaRing = [[-9.5, 37.0], [-7.0, 37.0], [-7.0, 42.0], [-9.5, 42.0], [-9.5, 37.0]];
  const coastIdx = createCoastlineIndex([iberiaRing]);
  const fwd = coastIdx.forwardCoast(38.7, -9.8, 90, { maxKm: 120, halfAngle: 55 });
  assert.ok(fwd && fwd.distanceKm > 10 && fwd.distanceKm < 40, 'forwardCoast detects continent ahead');

  // 2. Resident coastal terrain shoreline guard + zero uncommitted worldOffset (trees stay locked to ground)
  const worldOffset = { x: 0, z: 0 };
  const mockTerrain = {
    region: { x: 0, z: -6000, span: 8192 },
    // Shoreline at z = -6000: south (z > -6000) is -16 m water; north (z < -6000) rises into +35 m land
    height(x, z) {
      const lz = z - worldOffset.z;
      return lz >= -6000 ? -16 : Math.min(35, (-6000 - lz) * 0.25 - 2);
    },
    setWorldOffset(dx, dz) {
      worldOffset.x = dx;
      worldOffset.z = dz;
    },
    getWorldOffset() {
      return { ...worldOffset };
    },
    commitWorldOffset({ boat, camera }) {
      const dx = worldOffset.x, dz = worldOffset.z;
      if (boat) { boat.x -= dx; boat.z -= dz; }
      if (camera) { camera.x -= dx; camera.z -= dz; }
      worldOffset.x = 0;
      worldOffset.z = 0;
      return { dx, dz };
    },
  };

  const boat = {
    x: 0,
    z: -2500,
    heading: 0, // Heading due North straight into the continent!
    surgeVelocity: 4.5,
    leewayVelocity: 0,
    modelId: 'nina',
    hydrodynamics: { draft: 2.0 },
  };
  const cam = { x: 0, z: -2480, y: 6 };
  const P = { windSpeed: 7, windDir: 180, swellHs: 1, swellDir: 0, swellLength: 80, clouds: 0.3, rain: 0, thunder: 0, haze: 1, cloudBase: 1.2, cloudDepth: 1.8, cloudDensity: 1, cloudAnvil: 0.05 };

  const ctrl = createVoyageController({
    boat,
    P,
    getTerrain: () => mockTerrain,
    getCamera: () => cam,
    loadLandRings: () => Promise.resolve([iberiaRing]),
    loadTile: () => Promise.resolve(null),
  });
  await chartsAboard();
  ctrl.start({ lat: 38.70, lon: -9.14, compassCourse: 0 });
  ctrl.setWarp('crossing');

  for (let i = 0; i < 400; i++) {
    ctrl.update(0.05, i * 50);
  }

  assert.equal(worldOffset.x, 0, 'worldOffset.x is committed so trees never detach from ground');
  assert.equal(worldOffset.z, 0, 'worldOffset.z is committed so trees never detach from ground');
  assert.ok(mockTerrain.height(boat.x, boat.z) <= -2.2, `ship stopped in navigable water before the shore (bed=${mockTerrain.height(boat.x, boat.z).toFixed(2)}m, z=${boat.z.toFixed(1)})`);
  assert.equal(ctrl.voyage.tier, 'deck', 'dropped warp to 1× real time upon reaching shoal water ahead');
  assert.equal(ctrl.voyage.canvas, 'furl', 'warp leaves her with sail struck, safe even with nobody at the helm');
  const shoreM = Math.abs(-6000 - boat.z);
  assert.ok(shoreM >= warpStandoffM(4.5) - 150, `warp stopped with room to turn (${shoreM.toFixed(0)} m off the shore)`);
  ctrl.setWarp('crossing');
  ctrl.update(0.05, 400 * 50);
  ctrl.update(0.05, 401 * 50);
  assert.equal(ctrl.voyage.rate, 1, 'warp cannot be forced any closer');
});

test('sighting and hailing a vessel invokes onSightVessel and onHailVessel with historical ship colors', () => {
  const director = createEncounterDirector({ seed: 0x1550beef });
  const v = createVoyage({ lat: 36.5, lon: -14.0 });
  const boat = { x: 0, z: 0, heading: 225, surgeVelocity: 3.1, leewayVelocity: 0 };
  let sightedEnc = null;
  let hailedEnc = null;

  const enc = director.spawnSailEncounter(v, boat, {
    onSightVessel: (e) => { sightedEnc = e; },
  });
  assert.ok(sightedEnc && sightedEnc === enc, 'onSightVessel fires immediately when a strange sail is sighted');
  assert.ok(typeof enc.colors === 'string' && enc.colors.length > 0, 'encounter specifies historical ship colors');
  assert.ok(typeof enc.battleColors === 'string' && enc.battleColors.length > 0, 'encounter specifies battle colors');

  // Force non-hostile to verify peaceful hailing alongside
  enc.actuallyHostile = false;
  const outcome = director.resolveDecision('hail', v, boat, createHelmsman(), {
    onHailVessel: (e) => { hailedEnc = e; },
  });
  assert.equal(outcome.hailed, true, 'hailing a friendly/neutral ship marks outcome.hailed = true');
  assert.equal(hailedEnc, enc, 'onHailVessel fires so the 3D vessel is placed within speaking-trumpet range');
});

test('passive Lisbon departure engages helmsman on warp and keeps waves at 1x in open ocean', async () => {
  let commits = 0;
  const mockTerrain = {
    region: { x: 0, z: 0, span: 8192, latitude: 38.707, longitude: -9.136, name: 'Lisboa' },
    worldOffset: { x: 0, z: 0 },
    height: () => -60,
    setWorldOffset(x, z) { this.worldOffset.x = x; this.worldOffset.z = z; },
    commitWorldOffset({ boat }) {
      commits++;
      boat.x -= this.worldOffset.x;
      boat.z -= this.worldOffset.z;
      this.worldOffset.x = 0;
      this.worldOffset.z = 0;
    },
  };
  const boat = {
    x: -16000, // 16 km offshore in the open Atlantic (> 13.5 km coastal pack radius)
    z: 5000,
    heading: 252,
    length: 22,
    surgeVelocity: 3.5,
    leewayVelocity: 0,
    modelId: 'nina',
    hydrodynamics: { draft: 2.0 },
  };
  const P = { windSpeed: 7, windDir: 132, swellHs: 1, swellDir: 0, swellLength: 80, clouds: 0.3, rain: 0, thunder: 0, haze: 1, cloudBase: 1.2, cloudDepth: 1.8, cloudDensity: 1, cloudAnvil: 0.05 };
  const ctrl = createVoyageController({
    boat,
    P,
    getTerrain: () => mockTerrain,
    loadLandRings: () => Promise.resolve([]),
    loadTile: () => Promise.resolve(null),
  });
  await chartsAboard();
  ctrl.start({ passive: true, lat: 38.68, lon: -9.32 });
  assert.equal(ctrl.helmsman.engaged, false, 'passive start leaves helmsman disengaged');

  ctrl.setWarp('passage');
  assert.equal(ctrl.helmsman.engaged, true, 'activating warp from passive departure engages helmsman');

  const startX = boat.x;
  const startDate = ctrl.voyage.dateMs;
  for (let i = 0; i < 10; i++) {
    // Simulate 1x real-time wave/hull motion of ~0.175 m per 50ms frame
    boat.x -= 0.16;
    boat.z += 0.05;
    ctrl.update(0.05, i * 50);
  }
  assert.equal(commits, 0, 'open-ocean warp does not scroll boat.x/boat.z via commitWorldOffset');
  assert.ok(Math.abs(boat.x - startX) < 5, 'boat local wave coordinates move at 1x real-time speed');
  assert.ok(ctrl.voyage.dateMs > startDate + 100000, 'voyage clock advances at warped rate');
  assert.ok(ctrl.voyage.distanceTrueNm > 0.1, 'geographic distance advances at warped rate');
});

test('sail encounter supports spyglass inspection, steers toward target ship, and stops time dilation at battle range', async () => {
  const boat = {
    x: 0,
    z: 0,
    heading: 270,
    length: 20,
    surgeVelocity: 3.6,
    leewayVelocity: 0,
    modelId: 'nina',
    sailFore: 1,
    sailMain: 1,
    sailMizzen: 1,
  };
  const targetBoat = {
    x: -480,
    z: -180,
    heading: 180,
    length: 20,
    surgeVelocity: 2.8,
    leewayVelocity: 0,
    showProw: true,
    damage: { hullIntegrity: 1.0 },
  };
  const P = { windSpeed: 8, windDir: 135, swellHs: 1, swellDir: 0, swellLength: 80, clouds: 0.3, rain: 0, thunder: 0, haze: 1, cloudBase: 1.2, cloudDepth: 1.8, cloudDensity: 1, cloudAnvil: 0.05 };

  let spyglassInspected = false;
  let enteredBattleRange = false;
  let boardedAtGrappleRange = false;

  const ctrl = createVoyageController({
    boat,
    P,
    getVessels: () => [boat, targetBoat],
    closeHullsInPursuit: true, // nothing sails these hulls, so the controller closes the range itself
    onSightVessel: (enc) => {
      const brgRad = (enc.bearingDeg * Math.PI) / 180;
      targetBoat.x = boat.x + Math.sin(brgRad) * 520;
      targetBoat.z = boat.z - Math.cos(brgRad) * 520;
    },
    onInspectEncounter: () => {
      spyglassInspected = true;
      return undefined;
    },
    onEnterBattleRange: () => {
      enteredBattleRange = true;
    },
    onBoardVessel: () => {
      boardedAtGrappleRange = true;
    },
    loadLandRings: () => Promise.resolve([]),
    loadTile: () => Promise.resolve(null),
  });
  await chartsAboard();

  ctrl.start({ lat: 32.0, lon: -24.0, compassCourse: 270 });
  ctrl.setWarp('crossing');
  const enc = ctrl.triggerSailEncounter();
  assert.ok(enc && ctrl.voyage.interrupt?.type === 'sail', 'triggers sail encounter interrupt');

  // 1. Inspect from Crow's Nest with Spyglass — interrupt remains open for tactical order
  ctrl.resolveInterrupt('spyglass');
  assert.equal(spyglassInspected, true, 'invokes Crow’s Nest spyglass inspection');
  assert.equal(enc.spyglassInspected, true, 'marks encounter as inspected through spyglass');
  assert.ok(ctrl.voyage.interrupt && ctrl.voyage.interrupt.type === 'sail', 'keeps tactical order choices open after spyglass');

  // 2. Order Grapple & Board — ship steers toward target under Watch warp until reaching battle range (~235 m)
  ctrl.resolveInterrupt('board');
  assert.equal(ctrl.pursuit.active, true, 'starts active 3D pursuit toward target ship');
  assert.equal(ctrl.helmsman.engaged, true, 'engages helmsman to steer toward target');
  assert.equal(ctrl.voyage.tier, 'watch', 'maintains Watch time dilation while closing from horizon to battle range');
  assert.equal(boardedAtGrappleRange, false, 'does not prematurely trigger boarding while 520 m away');

  // Step until entering battle range (<= 235 m)
  for (let i = 0; i < 60 && !enteredBattleRange; i++) {
    ctrl.update(0.1, i * 100);
  }
  const distAtBattleRange = Math.hypot(targetBoat.x - boat.x, targetBoat.z - boat.z);
  assert.equal(enteredBattleRange, true, 'fires onEnterBattleRange upon closing to battle range');
  assert.ok(distAtBattleRange <= 235, `target closed inside battle range (${distAtBattleRange.toFixed(1)} m)`);
  assert.equal(ctrl.voyage.tier, 'deck', 'automatically stops time dilation (drops to 1× On deck) at battle range');
  assert.equal(ctrl.voyage.rate, 1, 'voyage rate is 1× real time inside battle range');

  // Continue stepping at 1× real time until closing into grappling range (<= 46 m)
  for (let i = 0; i < 160 && !boardedAtGrappleRange; i++) {
    ctrl.update(0.1, 6000 + i * 100);
  }
  const finalDist = Math.hypot(targetBoat.x - boat.x, targetBoat.z - boat.z);
  assert.equal(boardedAtGrappleRange, true, 'triggers boarding once ships close within grappling range');
  assert.ok(finalDist <= 46.5, `ships closed alongside to grappling distance (${finalDist.toFixed(1)} m)`);
});

test('warping toward land or a village with fleet vessels does not double-shift hull, stops safely offshore, and preserves daylight', () => {
  const worldOffset = { x: 0, z: 0 };
  const villagePort = {
    center: { x: 0, z: -5920 },
    clearRadius: 320,
    instances: [
      { x: 0, z: -5920, y: 1.8, baseY: 1.8, width: 28, depth: 60, yaw: 0, foundationDepth: 5.5 },
    ],
  };
  const mockTerrain = {
    region: { x: 0, z: -6000, span: 8192, latitude: 43.68, longitude: -70.18 },
    port: villagePort,
    ports: [villagePort],
    height(x, z) {
      const lz = z - worldOffset.z;
      return lz >= -6000 ? -14 : Math.min(35, (-6000 - lz) * 0.35 - 1.5);
    },
    setWorldOffset(dx, dz) {
      worldOffset.x = dx;
      worldOffset.z = dz;
    },
    commitWorldOffset({ boat: b, camera: c, vessels }) {
      const dx = worldOffset.x, dz = worldOffset.z;
      if (b) { b.x -= dx; b.z -= dz; }
      if (c) { c.x -= dx; c.z -= dz; }
      if (Array.isArray(vessels)) {
        for (const vb of vessels) {
          if (vb && vb !== b) { vb.x -= dx; vb.z -= dz; }
        }
      }
      worldOffset.x = 0;
      worldOffset.z = 0;
      return { dx, dz };
    },
    constrain(b, prevX, prevZ, extraOptions = null) {
      return constrainIslandMotion(null, b, prevX, prevZ, (px, pz) => this.height(px, pz), this.region, {
        ports: this.ports,
        ...(extraOptions || {}),
      });
    },
  };

  const boat = {
    x: 0,
    z: -5650,
    heading: 0, // Pointed straight North at the village pier and shoreline
    length: 20,
    beam: 6,
    surgeVelocity: 4.2,
    leewayVelocity: 0,
    modelId: 'nina',
    hydrodynamics: { draft: 2.0 },
  };
  const companion = { x: 40, z: -5660 };
  const cam = { x: 0, z: -5640, y: 5.4 };
  const P = {
    sunElev: 32,
    sunAzim: 225,
    windSpeed: 5.5,
    windDir: 251,
    swellHs: 1.2,
    swellDir: 215,
    swellLength: 95,
    clouds: 0.3,
    rain: 0,
    thunder: 0,
    haze: 0.8,
    cloudBase: 1.2,
    cloudDepth: 1.8,
    cloudDensity: 1,
    cloudAnvil: 0.05,
  };
  const astronomy = createAstronomyClock(new URLSearchParams({
    skyMode: 'manual',
    astroDate: '2026-10-21T00:00:00.000Z', // 00:00 UTC is night in Maine (-70.18°), while manual sunElev is 32° daylight
    latitude: '43.68',
    longitude: '-70.18',
  }));

  const ctrl = createVoyageController({
    boat,
    P,
    astronomy,
    getTerrain: () => mockTerrain,
    getCamera: () => cam,
    getVessels: () => [boat, companion], // vessels[0] === boat just like main.js
    loadLandRings: () => Promise.resolve([]),
    loadTile: () => Promise.resolve(null),
  });

  // Start in passive coastal mode with a saved UTC timestamp that corresponds to night at lon -70.18°
  ctrl.start({
    passive: true,
    lat: 43.68,
    lon: -70.18,
    compassCourse: 0,
    saved: {
      v: 1,
      active: false,
      day: 0,
      dateMs: Date.UTC(1550, 2, 24, 2, 0, 0), // 02:00 UTC = ~21:20 local night at -70.18°
      canvas: 'full',
      course: 0,
      warp: 'deck',
      autopilot: true,
    },
  });

  // Player hits faster time warp (Crossing 3600×) while looking right at the village/land
  ctrl.setWarp('crossing');
  for (let i = 0; i < 30; i++) {
    ctrl.update(0.05, i * 50);
  }

  assert.equal(ctrl.voyage.tier, 'deck', 'drops back to 1× real time before hitting the village or shore');
  assert.ok(boat.z > -5900, `ship stopped clear of the village pier at z=-5920 and shore at z=-6000 (z=${boat.z.toFixed(1)})`);
  assert.ok(mockTerrain.height(boat.x, boat.z) <= -3.2, `ship remains in deep navigable water (bed=${mockTerrain.height(boat.x, boat.z).toFixed(2)}m)`);
  assert.equal(Boolean(boat.aground), false, 'ship is not wedged aground');
  assert.ok(astronomy.state.sun.altitude > 5, `astronomy clock aligned to local daytime instead of going dark (sun altitude=${astronomy.state.sun.altitude.toFixed(1)}°)`);

  // Verify user can manually adjust sky mode back to manual and syncAstronomy respects it
  astronomy.set({ mode: 'manual' }, boat);
  ctrl.update(0.05, 2000);
  assert.equal(astronomy.mode, 'manual', 'manual sky adjustment is respected during active voyage');
});

test('warped approach from 80 km out preloads 3D terrain, slides it from >40 km into visual range, and only fires Land Ho when 3D land is visible ahead', async () => {
  const islandLat = 20.0;
  const islandLon = -60.0;
  const loadTile = (z, x, y) => {
    const data = new Float32Array(256 * 256).fill(-3000);
    const n = 2 ** z;
    for (let py = 0; py < 256; py++) {
      for (let px = 0; px < 256; px++) {
        const lon = ((x + (px + 0.5) / 256) / n) * 360 - 180;
        const yy = y + (py + 0.5) / 256;
        const lat = (Math.atan(Math.sinh(Math.PI * (1 - (2 * yy) / n))) * 180) / Math.PI;
        const d = greatCircleKm(lat, lon, islandLat, islandLon);
        if (d < 10) data[py * 256 + px] = 420 * (1 - d / 10) + 5;
      }
    }
    return data;
  };

  let activeTerrain = null;
  let spawnCalls = 0;
  let landHoDistM = Infinity;

  const boat = {
    x: 0,
    z: 0,
    heading: 270, // Sailing due West toward the island at (20.0, -60.0)
    length: 20,
    beam: 6,
    surgeVelocity: 4.5,
    leewayVelocity: 0,
    modelId: 'nina',
    hydrodynamics: { draft: 2.0 },
  };
  const cam = { x: 0, z: 20, y: 5.5 };
  const P = {
    sunElev: 35,
    sunAzim: 180,
    windSpeed: 8,
    windDir: 90,
    swellHs: 1.2,
    swellDir: 90,
    swellLength: 90,
    clouds: 0.25,
    rain: 0,
    thunder: 0,
    haze: 0.8,
    cloudBase: 1.2,
    cloudDepth: 1.8,
    cloudDensity: 1,
    cloudAnvil: 0.05,
  };

  const startPos = destinationPoint(islandLat, islandLon, 90, 82); // 82 km East of island center (~72 km from east shore)
  const ctrl = createVoyageController({
    boat,
    P,
    getTerrain: () => activeTerrain,
    getCamera: () => cam,
    demLoader: loadTile,
    loadLandRings: () => Promise.resolve([]),
    spawnTerrain: async ({ placement, lat, lon, name }) => {
      spawnCalls++;
      const worldOffset = { x: 0, z: 0 };
      const baseRegion = {
        x: placement.x,
        z: placement.z,
        span: 8192,
        latitude: lat,
        longitude: lon,
        name: name || 'Sighted Island',
      };
      activeTerrain = {
        get region() {
          return worldOffset.x || worldOffset.z
            ? { ...baseRegion, x: baseRegion.x + worldOffset.x, z: baseRegion.z + worldOffset.z }
            : baseRegion;
        },
        get baseRegion() {
          return baseRegion;
        },
        height(qx, qz) {
          const lx = qx - worldOffset.x - baseRegion.x;
          const lz = qz - worldOffset.z - baseRegion.z;
          // West of the shoreline (lx < 0) rises onto land; East (lx > 0) is open ocean (-40 m)
          if (Math.abs(lx) > 4096 || Math.abs(lz) > 4096) return -120;
          return lx < 0 ? Math.min(80, -lx * 0.08 + 2) : -40;
        },
        setWorldOffset(dx, dz) {
          worldOffset.x = dx;
          worldOffset.z = dz;
        },
        commitWorldOffset({ boat: b, camera: c }) {
          const dx = worldOffset.x, dz = worldOffset.z;
          if (b) { b.x -= dx; b.z -= dz; }
          if (c) { c.x -= dx; c.z -= dz; }
          worldOffset.x = 0;
          worldOffset.z = 0;
          return { dx, dz };
        },
      };
      return activeTerrain;
    },
  });

  ctrl.subscribe((ev, payload) => {
    if (ev === 'land-ho' && activeTerrain) {
      landHoDistM = Math.hypot(boat.x - activeTerrain.region.x, boat.z - activeTerrain.region.z);
      void payload;
    }
  });

  ctrl.start({ lat: startPos.lat, lon: startPos.lon, compassCourse: 270 });
  ctrl.setWarp('crossing');

  for (let i = 0; i < 160; i++) {
    ctrl.update(0.05, i * 50);
    await new Promise((r) => setImmediate(r));
    if (ctrl.voyage.interrupt?.type === 'land-ho') break;
  }

  assert.equal(spawnCalls, 1, 'spawnTerrain called once to preload the destination coast');
  assert.ok(activeTerrain, '3D coastal terrain is active when Land Ho arrives');
  assert.equal(ctrl.voyage.interrupt?.type, 'land-ho', 'Land Ho notification raised');
  assert.ok(landHoDistM <= 18500, `3D terrain slid from ~60 km into visual range before Land Ho fired (dist=${landHoDistM.toFixed(0)} m)`);
  assert.ok(activeTerrain.region.x < boat.x, `3D coast lies West ahead of the ship (region.x=${activeTerrain.region.x.toFixed(0)}, boat.x=${boat.x.toFixed(0)})`);
});




test('time warp is refused and dropped while an enemy is in range', async () => {
  const boat = { x: 0, z: 0, heading: 225, surgeVelocity: 2, leewayVelocity: 0 };
  const P = { windSpeed: 7, windDir: 180, swellHs: 1, swellDir: 0, swellLength: 80, clouds: 0.3, rain: 0, thunder: 0, haze: 1 };
  let engaged = false;
  const ctrl = createVoyageController({
    boat,
    P,
    getTerrain: () => null,
    getCamera: () => ({ x: 0, z: 0, y: 6 }),
    loadLandRings: () => Promise.resolve([]),
    loadTile: () => Promise.resolve(null),
    isBattleActive: () => engaged,
  });
  await chartsAboard();
  ctrl.start({ lat: 30, lon: -40, compassCourse: 0 });
  ctrl.setWarp('crossing');
  assert.ok(ctrl.voyage.rate > 1, 'warps freely in open water');
  engaged = true;
  ctrl.update(0.05, 50);
  assert.equal(ctrl.voyage.rate, 1, 'an enemy coming into range drops her to deck watch');
  ctrl.setWarp('crossing');
  assert.equal(ctrl.voyage.rate, 1, 'warp stays refused while she is in range');
  engaged = false;
  ctrl.setWarp('crossing');
  assert.ok(ctrl.voyage.rate > 1, 'warp returns once she is clear');
});

test('warp slows toward danger and stops short of it, whatever is asked', () => {
  assert.equal(warpCapForHazard(Infinity, 3), 3600, 'open water is unlimited');
  assert.equal(warpCapForHazard(warpStandoffM(3), 3), 1, 'at the standoff warp is over');
  assert.equal(warpCapForHazard(warpStandoffM(3) + 30, 3), 1, 'and it ends before the last few seconds of the gap');
  assert.ok(warpCapForHazard(5000, 3) > warpCapForHazard(2000, 3), 'further off runs faster');
  assert.ok(warpStandoffM(0) >= 800, 'always room to turn');
  assert.ok(warpStandoffM(6) > warpStandoffM(3), 'a fast ship needs further to stop');
});

test('the glass only finds land that stands above the horizon', () => {
  // A hill 12 km north of the ship, and a low cay 30 km north that the curve of the sea hides.
  const hill = (x, z) => (Math.hypot(x, z + 12000) < 1500 ? 300 : -100);
  const found = visibleLandPoint(hill, 0, 0, 0, { eyeM: 20 });
  assert.ok(found && Math.abs(found.distanceM - 12000) < 1600, 'finds the hill');
  const cay = (x, z) => (Math.hypot(x, z + 30000) < 1500 ? 4 : -100);
  assert.equal(visibleLandPoint(cay, 0, 0, 0, { eyeM: 20 }), null, 'a low cay beyond the horizon is not land in sight');
  assert.equal(visibleLandPoint(hill, 0, 0, 180, { eyeM: 20, searchDeg: 30 }), null, 'land astern is outside the search');
});

test('at deck watch in harbour shallows the clock runs, she keeps her way, and the land stays put', () => {
  // A first-rate in nine metres over a bed that rises gently to the west: shoal by the warp guard's measure all round.
  const worldOffset = { x: 0, z: 0 };
  let slides = 0;
  const harbour = {
    region: { x: 0, z: -6000, span: 8192, latitude: 38.7, longitude: -9.14 },
    ports: [],
    height(x) { return Math.min(20, -9 - (x - worldOffset.x) * 0.01); },
    setWorldOffset(dx, dz) { worldOffset.x = dx; worldOffset.z = dz; slides++; },
    commitWorldOffset({ boat: b }) {
      const dx = worldOffset.x, dz = worldOffset.z;
      if (b) { b.x -= dx; b.z -= dz; }
      worldOffset.x = 0; worldOffset.z = 0;
      return { dx, dz };
    },
  };
  const boat = { x: 0, z: -5000, heading: 0, length: 69, beam: 16, surgeVelocity: 3, leewayVelocity: 0.9, modelId: 'victory', hydrodynamics: { draft: 8.7 } };
  const ctrl = createVoyageController({
    boat,
    P: { sunElev: 32, sunAzim: 225, windSpeed: 6, windDir: 251, swellHs: 0.4, swellDir: 215, swellLength: 60, clouds: 0.3, rain: 0, thunder: 0, haze: 0.8 },
    getTerrain: () => harbour,
    getVessels: () => [boat],
    loadLandRings: () => Promise.resolve([]),
    loadTile: () => Promise.resolve(null),
  });
  ctrl.start({ passive: true, lat: 38.7, lon: -9.14, compassCourse: 0 });
  const startMs = ctrl.voyage.dateMs, startLat = ctrl.voyage.true.lat;
  // Twenty seconds of real sailing: north at 3 m/s, sagging to leeward faster than the reckoning allows for.
  for (let i = 0; i < 400; i++) {
    boat.z -= boat.surgeVelocity * 0.05;
    boat.x += boat.leewayVelocity * 0.05;
    ctrl.update(0.05, i * 50);
  }
  assert.equal(ctrl.voyage.rate, 1, 'she is at deck watch throughout');
  assert.ok(Math.abs((ctrl.voyage.dateMs - startMs) / 1000 - 20) < 0.5, `twenty seconds pass on the ship's clock (${((ctrl.voyage.dateMs - startMs) / 1000).toFixed(2)} s did)`);
  assert.equal(boat.surgeVelocity, 3, 'nothing checks her way');
  assert.equal(slides, 0, 'the land is not slid under a hull sailing in real time');
  assert.ok(Math.abs(boat.z + 5060) < 1e-6 && Math.abs(boat.x - 18) < 1e-6, 'nor is she shifted');
  assert.ok(ctrl.voyage.true.lat > startLat, 'and her latitude follows her northward');
});

test('warp tells the scene how far it carried her past what the hull sailed, and deck watch carries nothing', async () => {
  const boat = { x: 0, z: 0, heading: 0, length: 20, beam: 6, surgeVelocity: 4, leewayVelocity: 0, modelId: 'nina', hydrodynamics: { draft: 2 } };
  const carried = { x: 0, z: 0, calls: 0 };
  const ctrl = createVoyageController({
    boat,
    P: { sunElev: 32, sunAzim: 135, windSpeed: 6, windDir: 180, swellHs: 0.6, swellDir: 215, swellLength: 80, clouds: 0.2, rain: 0, thunder: 0, haze: 0.8 },
    getTerrain: () => null,
    getVessels: () => [boat],
    loadLandRings: () => Promise.resolve([]),
    loadTile: () => Promise.resolve(null),
    onWarpCarry: (dx, dz) => { carried.x += dx; carried.z += dz; carried.calls++; },
  });
  await chartsAboard();
  ctrl.start({ lat: 30, lon: -30, compassCourse: 0 });
  const sail = (frames, from) => { for (let i = 0; i < frames; i++) { boat.z -= boat.surgeVelocity * 0.05; ctrl.update(0.05, (from + i) * 50); } };
  sail(100, 0);
  assert.equal(carried.calls, 0, 'at deck watch the hull sails every metre herself');
  ctrl.setWarp('watch');
  const logged = ctrl.voyage.distanceTrueNm;
  sail(200, 100);
  assert.ok(ctrl.voyage.rate > 30, 'she is warping');
  const warpedM = (ctrl.voyage.distanceTrueNm - logged) * 1852, sailedM = 200 * 0.05 * 4;
  const carriedM = Math.hypot(carried.x, carried.z);
  assert.ok(carried.z < 0 && Math.abs(carried.x) < carriedM * 0.2, 'she is carried the way she heads, give or take the set of the current');
  assert.ok(Math.abs(carriedM - (warpedM - sailedM)) < warpedM * 0.02, `the carry is the warped run less the sailed one (${carriedM.toFixed(0)} m of ${warpedM.toFixed(0)} m)`);
});

test('warp waits for the coastline to arrive, then runs', async () => {
  const boat = { x: 0, z: 0, heading: 0, length: 20, beam: 6, surgeVelocity: 4, leewayVelocity: 0, modelId: 'nina', hydrodynamics: { draft: 2 } };
  let deliver;
  const ctrl = createVoyageController({
    boat,
    P: { sunElev: 32, sunAzim: 135, windSpeed: 6, windDir: 180, swellHs: 0.6, swellDir: 215, swellLength: 80, clouds: 0.2, rain: 0, thunder: 0, haze: 0.8 },
    getTerrain: () => null,
    getVessels: () => [boat],
    loadLandRings: () => new Promise((resolve) => { deliver = resolve; }),
    loadTile: () => Promise.resolve(null),
  });
  await chartsAboard();
  ctrl.start({ lat: 30, lon: -30, compassCourse: 0 });
  // A reloaded voyage asks for its old warp at once, before anything is known of the land.
  ctrl.setWarp('crossing');
  const logged = ctrl.voyage.distanceTrueNm;
  for (let i = 0; i < 60; i++) ctrl.update(0.05, i * 50);
  assert.equal(ctrl.voyage.rate, 1, 'she does not run blind');
  assert.ok((ctrl.voyage.distanceTrueNm - logged) * 1852 < 15, 'three seconds at four metres a second, no more');
  deliver([]);
  await chartsAboard();
  for (let i = 60; i < 120; i++) ctrl.update(0.05, i * 50);
  assert.ok(ctrl.voyage.rate > 60, `with the coastline aboard the warp she asked for answers (${ctrl.voyage.rate.toFixed(0)}×)`);
});

test('fire aboard or a gaining leak drops the warp and refuses it until she is safe', async () => {
  const boat = { x: 0, z: 0, heading: 0, length: 20, beam: 6, surgeVelocity: 4, leewayVelocity: 0, modelId: 'nina', hydrodynamics: { draft: 2 }, damage: { fireIntensity: 0, floodingRate: 0 } };
  const ctrl = createVoyageController({
    boat,
    P: { sunElev: 32, sunAzim: 135, windSpeed: 6, windDir: 180, swellHs: 0.6, swellDir: 215, swellLength: 80, clouds: 0.2, rain: 0, thunder: 0, haze: 0.8 },
    getTerrain: () => null,
    getVessels: () => [boat],
    loadLandRings: () => Promise.resolve([]),
    loadTile: () => Promise.resolve(null),
  });
  await chartsAboard();
  ctrl.start({ lat: 30, lon: -30, compassCourse: 0 });
  let frame = 0;
  const run = (frames) => { for (let i = 0; i < frames; i++) ctrl.update(0.05, frame++ * 50); };
  ctrl.setWarp('passage');
  run(40);
  assert.ok(ctrl.voyage.rate > 60, 'she warps while all is well');
  for (const [peril, field] of [['fire', 'fireIntensity'], ['a gaining leak', 'floodingRate']]) {
    boat.damage[field] = 0.4;
    run(2);
    assert.equal(ctrl.voyage.tier, 'deck', `${peril} brings her back to deck watch`);
    assert.equal(ctrl.voyage.rate, 1);
    ctrl.setWarp('passage');
    assert.equal(ctrl.voyage.tier, 'deck', `and warp is refused while ${peril} lasts`);
    boat.damage[field] = 0;
    ctrl.setWarp('passage');
    run(40);
    assert.ok(ctrl.voyage.rate > 60, `with ${peril} dealt with she warps again`);
  }
});

test('beating under warp, a board lasts long enough in real seconds to bring her about', () => {
  const boat = { modelId: 'nina', heading: 315, yawRate: 0, surgeVelocity: 3, leewayVelocity: 0, length: 20 };
  const helm = createHelmsman({ compassCourse: 270 });
  orderCourse(helm, 270, { beat: true });
  // Dead into a westerly at 3600×: four hours of the voyage pass every four real seconds.
  const steer = (seconds) => { for (let t = 0; t < seconds; t += 0.1) steerHelmsman(helm, boat, 0.1, { windSpeed: 8, windDirection: 0, variation: 0, gameDt: 360 }); };
  steer(1);
  const first = helm.tack;
  assert.notEqual(first, 0, 'she is put on a tack');
  steer(MIN_BEAT_LEG_REAL_S - 5);
  assert.equal(helm.tack, first, 'and holds it though many four-hour legs have passed on the clock');
  steer(6);
  assert.equal(helm.tack, -first, 'then goes about');
  // At deck watch the four-hour leg still rules.
  const slow = createHelmsman({ compassCourse: 270 });
  orderCourse(slow, 270, { beat: true });
  for (let t = 0; t < MIN_BEAT_LEG_REAL_S * 2; t += 0.1) steerHelmsman(slow, boat, 0.1, { windSpeed: 8, windDirection: 0, variation: 0 });
  assert.ok(Math.abs(slow.tack) === 1 && slow.legGameSeconds > MIN_BEAT_LEG_REAL_S, 'in real time she stays on her board for the four hours');
});

test('the coast she leaves stays with her down its river, and is let go once she is clear of it', async () => {
  // A river two kilometres wide running north from the port to the sea, twenty kilometres of it, between high banks.
  const mouthZ = -20000;
  let disposed = null;
  const river = {
    region: { x: 0, z: 0, span: 8192, latitude: 38.7, longitude: -9.14, name: 'Rio' },
    worldOffset: { x: 0, z: 0 },
    ports: [],
    height(x, z) {
      const lx = x - this.worldOffset.x, lz = z - this.worldOffset.z;
      return lz > mouthZ && Math.abs(lx) > 1000 ? 120 : -40;
    },
    setWorldOffset(x, z) { this.worldOffset.x = x; this.worldOffset.z = z; },
    commitWorldOffset({ boat: b }) {
      b.x -= this.worldOffset.x; b.z -= this.worldOffset.z;
      this.worldOffset.x = 0; this.worldOffset.z = 0;
    },
  };
  let terrain = river;
  const boat = { x: 0, z: -7000, heading: 0, length: 20, beam: 6, surgeVelocity: 3, leewayVelocity: 0, modelId: 'nina', hydrodynamics: { draft: 2 } };
  const ctrl = createVoyageController({
    boat,
    P: { sunElev: 32, sunAzim: 135, windSpeed: 6, windDir: 180, swellHs: 0.6, swellDir: 215, swellLength: 80, clouds: 0.2, rain: 0, thunder: 0, haze: 0.8 },
    getTerrain: () => terrain,
    getVessels: () => [boat],
    disposeTerrain: (t) => { disposed = { at: boat.z, bank: t.height(boat.x + 3000, boat.z) }; terrain = null; },
    loadLandRings: () => Promise.resolve([]),
    loadTile: () => Promise.resolve(null),
  });
  await chartsAboard();
  ctrl.start({ lat: 38.76, lon: -9.14, compassCourse: 0 });
  ctrl.setWarp('watch');
  let frame = 0;
  const sail = (frames) => { for (let i = 0; i < frames && terrain; i++) { boat.z -= boat.surgeVelocity * 0.05; ctrl.update(0.05, frame++ * 50); } };
  // Two minutes of watch warp carries her some twenty kilometres: past where the coast used to be dropped (7.8 km).
  sail(600);
  assert.equal(disposed, null, 'eight kilometres down the river the banks are still there');
  assert.ok(ctrl.voyage.distanceTrueNm > 2, `she has run on down it under warp (${ctrl.voyage.distanceTrueNm.toFixed(1)} nm)`);
  sail(6000);
  assert.ok(disposed, 'out past the mouth the coast is let go');
  assert.ok(disposed.bank < 0, 'and by then there is no bank beside her');
  // Thirteen kilometres of river lay ahead of her, and the coast is held until its land is nine kilometres off.
  assert.ok(ctrl.voyage.distanceTrueNm * 1852 > 13000 + 8000, `she was well clear of the mouth when it went (${(ctrl.voyage.distanceTrueNm * 1.852).toFixed(1)} km run)`);
});

test('lay to until first light waits for the dawn where she lies, whatever the hour', async () => {
  // The Channel on a December evening: dark by ten past five, when a fixed-hour rule still called it day.
  const lat = 50, lon = 0, evening = Date.UTC(1550, 11, 20, 17, 10);
  const boat = { x: 0, z: 0, heading: 0, length: 20, beam: 6, surgeVelocity: 2, leewayVelocity: 0, modelId: 'nina', hydrodynamics: { draft: 2 } };
  const ctrl = createVoyageController({
    boat,
    P: { sunElev: -10, sunAzim: 250, windSpeed: 6, windDir: 180, swellHs: 0.6, swellDir: 215, swellLength: 80, clouds: 0.2, rain: 0, thunder: 0, haze: 0.8 },
    getTerrain: () => null,
    getVessels: () => [boat],
    loadLandRings: () => Promise.resolve([]),
    loadTile: () => Promise.resolve(null),
  });
  await chartsAboard();
  ctrl.start({ lat, lon, dateMs: evening, compassCourse: 0 });
  const observer = { latitude: lat, longitude: lon, height: 0 };
  assert.ok(computeAstronomy(ctrl.voyage.dateMs, observer).sun.altitude < -6, 'it is night');
  const before = ctrl.voyage.dateMs;
  raiseInterrupt(ctrl.voyage, { type: 'lay-to', title: 'Night', text: '', choices: [{ id: 'lay-to', label: 'Lay to until first light' }] }, 'deck');
  ctrl.resolveInterrupt('lay-to');
  const waitedH = (ctrl.voyage.dateMs - before) / 3600000;
  const sun = computeAstronomy(ctrl.voyage.dateMs, observer).sun.altitude;
  assert.ok(waitedH > 10 && waitedH < 16, `she lay to through the long night (${waitedH.toFixed(1)} h)`);
  assert.ok(sun > -6 && sun < 4, `and it is first light, the Sun ${sun.toFixed(1)}° from the horizon`);
});

test('a date set backward does not stop the track or the weather', () => {
  const voyage = createVoyage({ lat: 30, lon: -30, dateMs: Date.UTC(1550, 5, 1, 12), seed: 7, compassCourse: 250 });
  const boat = { heading: 250, surgeVelocity: 3.5, leewayVelocity: 0.1 };
  stepVoyage(voyage, 0.1, { boat });
  // The sky panel can set the calendar anywhere in her era: here, five days earlier.
  voyage.dateMs -= 5 * 86400000;
  voyage.tier = 'crossing';
  voyage.rate = 3600;
  const points = voyage.trueTrack.length;
  for (let i = 0; i < 40; i++) stepVoyage(voyage, 0.25, { boat });
  assert.ok(voyage.trueTrack.length > points + 5, `the track goes on being drawn (${voyage.trueTrack.length - points} new points in ten hours)`);
  assert.ok(voyage.weatherSampleMs <= voyage.dateMs && voyage.dateMs - voyage.weatherSampleMs < 3600000, 'and the weather is sampled on her new calendar');
});

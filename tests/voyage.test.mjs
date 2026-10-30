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
  approachStage,
  approachWarpCap,
  regionLocalOrigin,
  destinationPoint,
  lonLatToTile,
} from '../js/voyage/landfall-approach.js';
import { createHelmsman, steerHelmsman, orderCourse, applyCanvasOrder, canvasAdvice } from '../js/voyage/helmsman.js';
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

test('high-warp ship heading into a continent stops offshore in navigable water and commits terrain offset', () => {
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
    z: -5200,
    heading: 0, // Heading due North straight into the continent!
    surgeVelocity: 4.5,
    leewayVelocity: 0,
    modelId: 'nina',
    hydrodynamics: { draft: 2.0 },
  };
  const cam = { x: 0, z: -5180, y: 6 };
  const P = { windSpeed: 7, windDir: 180, swellHs: 1, swellDir: 0, swellLength: 80, clouds: 0.3, rain: 0, thunder: 0, haze: 1, cloudBase: 1.2, cloudDepth: 1.8, cloudDensity: 1, cloudAnvil: 0.05 };

  const ctrl = createVoyageController({
    boat,
    P,
    getTerrain: () => mockTerrain,
    getCamera: () => cam,
    loadLandRings: () => Promise.resolve([iberiaRing]),
    loadTile: () => Promise.resolve(null),
  });
  ctrl.start({ lat: 38.70, lon: -9.14, compassCourse: 0 });
  ctrl.setWarp('crossing');

  for (let i = 0; i < 60; i++) {
    ctrl.update(0.05, i * 50);
  }

  assert.equal(worldOffset.x, 0, 'worldOffset.x is committed so trees never detach from ground');
  assert.equal(worldOffset.z, 0, 'worldOffset.z is committed so trees never detach from ground');
  assert.ok(mockTerrain.height(boat.x, boat.z) <= -2.2, `ship stopped in navigable water before the shore (bed=${mockTerrain.height(boat.x, boat.z).toFixed(2)}m, z=${boat.z.toFixed(1)})`);
  assert.equal(ctrl.voyage.tier, 'deck', 'dropped warp to 1× real time upon reaching shoal water ahead');
});

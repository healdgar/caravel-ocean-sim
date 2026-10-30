// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  COMPASS_POINTS_32,
  SPANISH_COMPASS_POINTS_32,
  compassPointName,
  spanishCompassPointName,
  rhumbBearing,
  rhumbDistanceNm,
  rhumbDestination,
  rhumbPath,
  nmToLeagues,
  leaguesToNm,
  NM_PER_LEAGUE,
  LEAGUES_PER_DEGREE,
  chartProject,
  chartUnproject,
  chartWrapLonNear,
  classify1550Knowledge,
  KNOWLEDGE_1550_REGIONS,
  formatPeriodDate,
  formatLatLon,
  createChartDrawer,
} from '../js/voyage/chart-drawer.js';

const CADIZ = [36.53, -6.29];
const SANTO_DOMINGO = [18.47, -69.9];

test('32-point compass names box the compass from north', () => {
  assert.equal(COMPASS_POINTS_32.length, 32);
  assert.equal(SPANISH_COMPASS_POINTS_32.length, 32);
  assert.equal(compassPointName(0), 'N');
  assert.equal(compassPointName(360), 'N');
  assert.equal(compassPointName(11.25), 'N by E');
  assert.equal(compassPointName(22.5), 'NNE');
  assert.equal(compassPointName(45), 'NE');
  assert.equal(compassPointName(90), 'E');
  assert.equal(compassPointName(180), 'S');
  assert.equal(compassPointName(236), 'SW by W');
  assert.equal(compassPointName(270), 'W');
  assert.equal(compassPointName(348.75), 'N by W');
  assert.equal(compassPointName(-11.25), 'N by W');
  assert.equal(compassPointName(5), 'N'); // nearest point
  assert.equal(compassPointName(6), 'N by E');
});

test('Spanish rumbos follow the same order', () => {
  assert.equal(spanishCompassPointName(0), 'Norte');
  assert.equal(spanishCompassPointName(11.25), 'Norte cuarta al Nordeste');
  assert.equal(spanishCompassPointName(22.5), 'Nornordeste');
  assert.equal(spanishCompassPointName(236), 'Sudoeste cuarta al Oeste');
  assert.equal(spanishCompassPointName(348.75), 'Norte cuarta al Noroeste');
  assert.equal(spanishCompassPointName(NaN), '');
});

test('rhumb bearing from Cádiz to Santo Domingo is about WSW', () => {
  const b = rhumbBearing(...CADIZ, ...SANTO_DOMINGO);
  assert.ok(b > 250 && b < 262, `bearing ${b}`);
  assert.equal(compassPointName(b), 'WSW');
  // Cardinal sanity checks
  assert.ok(Math.abs(rhumbBearing(0, 0, 10, 0) - 0) < 1e-9);
  assert.ok(Math.abs(rhumbBearing(0, 0, 0, 10) - 90) < 1e-9);
  assert.ok(Math.abs(rhumbBearing(10, 0, 0, 0) - 180) < 1e-9);
  assert.ok(Math.abs(rhumbBearing(0, 10, 0, 0) - 270) < 1e-9);
  // The shorter way across the antimeridian is east
  assert.ok(Math.abs(rhumbBearing(0, 179, 0, -179) - 90) < 1e-9);
});

test('rhumb distance is sane', () => {
  const nm = rhumbDistanceNm(...CADIZ, ...SANTO_DOMINGO);
  assert.ok(nm > 3500 && nm < 3700, `distance ${nm}`);
  assert.ok(Math.abs(rhumbDistanceNm(0, 0, 1, 0) - 60) < 1e-9); // 1° of latitude = 60 nm
  assert.ok(Math.abs(rhumbDistanceNm(60, 0, 60, 1) - 30) < 1e-6); // along a parallel: 60 cos φ
  assert.ok(Math.abs(rhumbDistanceNm(0, 179.5, 0, -179.5) - 60) < 1e-6);
});

test('rhumbDestination inverts bearing and distance', () => {
  const brg = rhumbBearing(...CADIZ, ...SANTO_DOMINGO), nm = rhumbDistanceNm(...CADIZ, ...SANTO_DOMINGO);
  const end = rhumbDestination(...CADIZ, brg, nm);
  assert.ok(Math.abs(end.lat - SANTO_DOMINGO[0]) < 1e-6, `lat ${end.lat}`);
  assert.ok(Math.abs(end.lon - SANTO_DOMINGO[1]) < 1e-6, `lon ${end.lon}`);
  const east = rhumbDestination(20, 0, 90, 600);
  assert.ok(Math.abs(east.lat - 20) < 1e-9);
  assert.ok(Math.abs(east.lon - 10 / Math.cos((20 * Math.PI) / 180)) < 1e-6);
});

test('rhumbPath runs between its endpoints with continuous longitude', () => {
  const path = rhumbPath(...CADIZ, ...SANTO_DOMINGO, 16);
  assert.equal(path.length, 17);
  assert.deepEqual(path[0].map((v) => +v.toFixed(6)), CADIZ);
  assert.ok(Math.abs(path[16][0] - SANTO_DOMINGO[0]) < 1e-6 && Math.abs(path[16][1] - SANTO_DOMINGO[1]) < 1e-6);
  const across = rhumbPath(0, 170, 0, -170, 4);
  assert.ok(across.every(([, lon], i) => i === 0 || lon > across[i - 1][1]), 'eastward across ±180 stays monotonic');
});

test('Castilian leagues are 17.5 to the degree', () => {
  assert.equal(LEAGUES_PER_DEGREE, 17.5);
  assert.ok(Math.abs(NM_PER_LEAGUE - 3.4286) < 1e-3);
  assert.ok(Math.abs(nmToLeagues(60) - 17.5) < 1e-12);
  assert.ok(Math.abs(leaguesToNm(17.5) - 60) < 1e-12);
  assert.ok(Math.abs(nmToLeagues(leaguesToNm(412)) - 412) < 1e-9);
});

test('chart projection round-trips through pan and zoom', () => {
  const view = { cx: -40, cy: 25, scale: 7.5, width: 1200, height: 800 };
  const centre = chartProject(25, -40, view);
  assert.deepEqual(centre, { x: 600, y: 400 });
  const north = chartProject(26, -40, view);
  assert.ok(north.y < centre.y, 'north is up');
  for (const [lat, lon] of [CADIZ, SANTO_DOMINGO, [-33.9, 151.2], [0, 0]]) {
    const p = chartProject(lat, lon, view), q = chartUnproject(p.x, p.y, view);
    assert.ok(Math.abs(q.lat - lat) < 1e-9 && Math.abs(q.lon - lon) < 1e-9);
  }
  assert.equal(chartWrapLonNear(-179, 175), 181);
  assert.equal(chartWrapLonNear(10, 0), 10);
});

test('1550 knowledge of the world', () => {
  assert.equal(classify1550Knowledge(38.72, -9.14), 'known'); // Lisbon
  assert.equal(classify1550Knowledge(23.14, -82.36), 'known'); // Havana
  assert.equal(classify1550Knowledge(42.36, -71.06), 'rumoured'); // Boston
  assert.equal(classify1550Knowledge(-33.87, 151.21), 'unknown'); // Sydney
  assert.equal(classify1550Knowledge(47.61, -122.33), 'unknown'); // Seattle
  assert.equal(classify1550Knowledge(-34.36, 18.47), 'known'); // Cape of Good Hope
  assert.equal(classify1550Knowledge(2.19, 102.25), 'known'); // Malacca
  assert.equal(classify1550Knowledge(-12.05, -77.04), 'known'); // Lima
  assert.equal(classify1550Knowledge(-53.5, -70.9), 'rumoured'); // Strait of Magellan
  assert.equal(classify1550Knowledge(-0.8, 127.4), 'rumoured'); // Moluccas (Ternate)
  assert.equal(classify1550Knowledge(35, 139.7), 'rumoured'); // Japan
  assert.equal(classify1550Knowledge(47.5, -52.7), 'rumoured'); // Newfoundland
  assert.equal(classify1550Knowledge(-41.3, 174.8), 'unknown'); // Wellington
  assert.equal(classify1550Knowledge(-75, 0), 'unknown'); // Antarctica
  assert.equal(classify1550Knowledge(72, -40), 'unknown'); // Greenland ice
  assert.equal(classify1550Knowledge(64.1, -21.9), 'known'); // Reykjavík
  assert.equal(classify1550Knowledge(21.3, -157.8), 'unknown'); // Honolulu
  assert.equal(classify1550Knowledge(NaN, 0), 'unknown');
  for (const r of KNOWLEDGE_1550_REGIONS) {
    const [, k, s, n, w, e] = r;
    assert.ok(['known', 'rumoured', 'unknown'].includes(k));
    assert.ok(s < n && w < e, `${r[0]} box is well-formed`);
  }
});

test('period date line uses the Julian calendar', () => {
  // 24 March 1550 (proleptic Gregorian) is 14 March 1550 in the Julian calendar used in Spain.
  assert.equal(formatPeriodDate('1550-03-24T12:00:00Z', 12), '14 de marzo de 1550 · day 12 at sea');
  assert.equal(formatPeriodDate(Date.parse('1550-03-24T12:00:00Z')), '14 de marzo de 1550');
  assert.equal(formatPeriodDate('not a date'), '');
  assert.equal(formatPeriodDate(undefined, 3), '');
});

test('lat/lon format in degrees and minutes', () => {
  assert.equal(formatLatLon(36.5, -6.25), '36° 30′ N, 6° 15′ W');
  assert.equal(formatLatLon(-10, 190), '10° 00′ S, 170° 00′ W');
});

test('the DOM factory is exported', () => {
  assert.equal(typeof createChartDrawer, 'function');
});

// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Chart Drawer: the pilot's "carta de marear" for open-ocean Chart Course voyages, c. 1550.
//
// The drawer shows a plane chart (plate carrée, the "carta plana" of the Casa de la
// Contratación; Mercator's conformal projection did not appear until 1569) on procedural
// vellum. It shows only what a 1550 pilot knew: known coasts are drawn in ink, rumoured coasts
// are dashed, and the unknown world is left blank. Over the chart the pilot pricks the
// dead-reckoning (DR) track, lays courses with a parallel rule, and measures with dividers.
//
// The pure helpers at the top run in node and are unit tested in tests/chart-drawer.test.mjs.
// The DOM factory, createChartDrawer, comes last.
//
// Bundling note: build.mjs concatenates every module into a single scope. Every private
// top-level name here therefore carries a `chart`/`CHART_` prefix so it cannot collide.

import { controlIcon } from '../controls.js';
import { COMPASS_POINTS_32, compassPointName, formatLatitude, formatLongitude } from './compass.js';
import { formatJulianDate } from './ocean-climate.js';
import { NM_PER_LEAGUE } from './passage.js';
export { COMPASS_POINTS_32, compassPointName } from './compass.js';
export { NM_PER_LEAGUE } from './passage.js';

// ---------------------------------------------------------------------------------------------
// Compass points (Spanish names)
// ---------------------------------------------------------------------------------------------
/** The 32 rumbos in Castilian pilot usage, clockwise from Norte, in the same order as COMPASS_POINTS_32. */
export const SPANISH_COMPASS_POINTS_32 = Object.freeze([
  'Norte', 'Norte cuarta al Nordeste', 'Nornordeste', 'Nordeste cuarta al Norte',
  'Nordeste', 'Nordeste cuarta al Este', 'Estenordeste', 'Este cuarta al Nordeste',
  'Este', 'Este cuarta al Sudeste', 'Estesudeste', 'Sudeste cuarta al Este',
  'Sudeste', 'Sudeste cuarta al Sur', 'Sursudeste', 'Sur cuarta al Sudeste',
  'Sur', 'Sur cuarta al Sudoeste', 'Sursudoeste', 'Sudoeste cuarta al Sur',
  'Sudoeste', 'Sudoeste cuarta al Oeste', 'Oestesudoeste', 'Oeste cuarta al Sudoeste',
  'Oeste', 'Oeste cuarta al Noroeste', 'Oestenoroeste', 'Noroeste cuarta al Oeste',
  'Noroeste', 'Noroeste cuarta al Norte', 'Nornoroeste', 'Norte cuarta al Noroeste',
]);

const CHART_RAD = Math.PI / 180;
function chartNormDeg(d) { return ((d % 360) + 360) % 360; }
function chartClamp(v, lo, hi) { return Math.min(hi, Math.max(lo, v)); }
/** Signed longitude difference wrapped to [-180, 180). */
function chartLonDelta(d) { return chartNormDeg(d + 180) - 180; }

export function spanishCompassPointName(deg) {
  if (!Number.isFinite(deg)) return '';
  return SPANISH_COMPASS_POINTS_32[Math.round(chartNormDeg(deg) / 11.25) % 32];
}

// ---------------------------------------------------------------------------------------------
// Rhumb lines (loxodromes): what a pilot actually sails when holding one compass point
// ---------------------------------------------------------------------------------------------
/** Mercator ("isometric") latitude ψ in radians. */
function chartMercatorY(latDeg) {
  const phi = chartClamp(latDeg, -89.9, 89.9) * CHART_RAD;
  return Math.log(Math.tan(Math.PI / 4 + phi / 2));
}

/** True rhumb-line bearing in degrees [0, 360) from one point to another. The shorter way round the antimeridian is used. */
export function rhumbBearing(fromLat, fromLon, toLat, toLon) {
  const dLon = chartLonDelta(toLon - fromLon) * CHART_RAD;
  const dPsi = chartMercatorY(toLat) - chartMercatorY(fromLat);
  if (dLon === 0 && dPsi === 0) return 0;
  return chartNormDeg(Math.atan2(dLon, dPsi) / CHART_RAD);
}

/** Rhumb-line distance in nautical miles on a sphere (1 nm = 1′ of arc). */
export function rhumbDistanceNm(fromLat, fromLon, toLat, toLon) {
  const dPhi = (toLat - fromLat) * CHART_RAD;
  const dLon = chartLonDelta(toLon - fromLon) * CHART_RAD;
  const dPsi = chartMercatorY(toLat) - chartMercatorY(fromLat);
  // For a course near east-west, Δφ/Δψ is ill-conditioned. Use cos φ instead.
  const q = Math.abs(dPsi) > 1e-12 ? dPhi / dPsi : Math.cos(fromLat * CHART_RAD);
  return (Math.hypot(dPhi, q * dLon) / CHART_RAD) * 60;
}

/** The point reached by running `distNm` along a constant true bearing. Longitude is wrapped to [-180, 180). */
export function rhumbDestination(lat, lon, bearingDeg, distNm) {
  const delta = (distNm / 60) * CHART_RAD;
  const theta = bearingDeg * CHART_RAD;
  const phi1 = lat * CHART_RAD;
  const phi2 = chartClamp(phi1 + delta * Math.cos(theta), -89.9 * CHART_RAD, 89.9 * CHART_RAD);
  const dPsi = chartMercatorY(phi2 / CHART_RAD) - chartMercatorY(lat);
  const q = Math.abs(dPsi) > 1e-12 ? (phi2 - phi1) / dPsi : Math.cos(phi1);
  const dLon = (delta * Math.sin(theta)) / q;
  return { lat: phi2 / CHART_RAD, lon: chartLonDelta(lon + dLon / CHART_RAD) };
}

/**
 * Samples a rhumb line as [lat, lon] pairs. The line is straight in Mercator space (ψ, λ), so
 * both are interpolated linearly. Longitudes stay continuous, so they may run past ±180.
 */
export function rhumbPath(fromLat, fromLon, toLat, toLon, steps = 32) {
  const dLon = chartLonDelta(toLon - fromLon);
  const psi1 = chartMercatorY(fromLat), psi2 = chartMercatorY(toLat);
  const pts = [];
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const lat = Math.abs(psi2 - psi1) < 1e-12
      ? fromLat
      : (2 * Math.atan(Math.exp(psi1 + t * (psi2 - psi1))) - Math.PI / 2) / CHART_RAD;
    pts.push([lat, fromLon + t * dLon]);
  }
  return pts;
}

/** The Castilian legua of 17½ to the degree used by the Casa de la Contratación. */
export const LEAGUES_PER_DEGREE = 17.5;
export function nmToLeagues(nm) { return nm / NM_PER_LEAGUE; }
export function leaguesToNm(leagues) { return leagues * NM_PER_LEAGUE; }

// ---------------------------------------------------------------------------------------------
// Plate carrée chart projection with a pan and zoom view
// view = { cx, cy (centre lon/lat in degrees), scale (CSS px per degree), width, height (CSS px) }
// ---------------------------------------------------------------------------------------------
export function chartProject(lat, lon, view) {
  return { x: view.width / 2 + (lon - view.cx) * view.scale, y: view.height / 2 - (lat - view.cy) * view.scale };
}
export function chartUnproject(x, y, view) {
  return { lat: view.cy - (y - view.height / 2) / view.scale, lon: view.cx + (x - view.width / 2) / view.scale };
}
/** Returns the copy of `lon` (±360°) nearest `refLon`. This keeps overlays continuous across the antimeridian. */
export function chartWrapLonNear(lon, refLon) { return refLon + chartLonDelta(lon - refLon); }

// ---------------------------------------------------------------------------------------------
// What a Castilian pilot knew c. 1550
// ---------------------------------------------------------------------------------------------
// The list is ordered: the first box containing the point wins, and anything unmatched is
// 'unknown'. Specific exceptions (Australia, Greenland) come before the broad boxes.
// Sources, in brief:
//  - Diogo Ribeiro, Carta Universal (Padrón Real, Seville, 1529): Atlantic, African and Indian
//    Ocean coasts, Brazil and the Plate, the Caribbean, Gulf of Mexico and Pacific Panama–Peru,
//    with North America north of Florida drawn from the 1524–25 Verrazzano and Gómez voyages.
//  - Alonso de Santa Cruz, Islario general (c. 1541–60), and Sebastian Cabot's world map (1544):
//    Plate and Patagonia, Strait of Magellan (1520), and "Tierra de Bacallaos" (Newfoundland).
//  - Portuguese roteiros: Malacca (1511), Moluccas (1512), Canton (1517), Japan (1543).
//  - Ulloa (1539) and Cabrillo (1542): Gulf of California and Alta California, rumoured.
//  - Valdivia: Chile to about 37° S by 1550. Galápagos sighted by Berlanga in 1535.
// Australia (1606), New Zealand (1642), the Pacific Northwest, the Arctic and Antarctica were
// unknown.
// Each entry is [name, knowledge, south, north, west, east] in degrees.
export const KNOWLEDGE_1550_REGIONS = Object.freeze([
  ['Australia (first charted 1606)', 'unknown', -46, -10.4, 112, 155],
  ['Iceland', 'known', 63, 67, -25, -13],
  ['Greenland & Baffin', 'unknown', 59, 84, -75, -10],
  ['Europe', 'known', 34, 71.5, -25, 42],
  ['Mediterranean & Black Sea', 'known', 30, 48, -10, 42],
  ['Azores, Madeira, Canaries & Cape Verde', 'known', 14, 40, -32, -12],
  ['North & West Africa, Gulf of Guinea', 'known', -6, 37, -26, 35],
  ['Ascension & St Helena', 'known', -17, -7, -15, -5],
  ['Angola to the Cape of Good Hope', 'known', -36, -6, 8, 36],
  ['East Africa & Madagascar', 'known', -27, 12, 30, 52],
  ['Mascarenes', 'known', -22, -19, 54, 58],
  ['Red Sea, Arabia & Hormuz', 'known', 12, 31, 32, 60],
  ['Persia, Makran & Gujarat', 'known', 20, 30, 56, 73],
  ['Malabar, Ceylon & Coromandel', 'known', 5, 25, 68, 81],
  ['Maldives', 'known', -1, 5, 71, 75],
  ['Bengal, Pegu, Siam & Malacca', 'known', 0, 24, 80, 105],
  ['Sumatra', 'known', -6, 6, 95, 106],
  ['Champa & Annam', 'rumoured', 8, 23, 104, 110],
  ['Java, Moluccas, Philippines & New Guinea', 'rumoured', -11, 21, 105, 152],
  ['China coast & Formosa', 'rumoured', 18, 41, 105, 123],
  ['Japan (Cipango)', 'rumoured', 30, 46, 128, 146],
  ['Antilles, Yucatán & Spanish Main', 'known', 7, 24, -90, -59],
  ['Bahamas & Atlantic Florida', 'known', 21, 31, -82, -72],
  ['Gulf of Mexico', 'known', 18, 31, -98, -80],
  ['Bermuda', 'known', 31.5, 33, -66, -64],
  ['Pacific New Spain & Central America', 'known', 7, 24, -112, -77],
  ['Pacific Colombia, Peru & Chile', 'known', -37.5, 8, -82, -68],
  ['Galápagos', 'rumoured', -2, 1, -92.5, -89],
  ['California & Sea of Cortés', 'rumoured', 23, 43, -126, -105],
  ['Brazil', 'known', -35, 5, -53, -34],
  ['Guiana coast', 'rumoured', 1, 10, -62, -51],
  ['Río de la Plata', 'known', -36.8, -33, -59, -53],
  ['Patagonia & Strait of Magellan', 'rumoured', -56, -36.8, -76, -55],
  ['Tierra de Bacallaos (Newfoundland, Labrador)', 'rumoured', 45, 59, -70, -52],
  ['Atlantic North America (Verrazzano, Gómez)', 'rumoured', 31, 46, -82, -60],
].map((r) => Object.freeze(r)));

/**
 * Classifies a coordinate as 'known', 'rumoured' or 'unknown' for a historical chart from 1550 through the 1680s.
 * Defaults to 1550 (Padrón Real of the Casa de la Contratación) when `year` is omitted.
 */
export function classify1550Knowledge(lat, lon, year = 1550) {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return 'unknown';
  const x = chartLonDelta(lon);
  const y = Number.isFinite(Number(year)) ? Number(year) : 1550;

  if (y > 1555) {
    // Post-1550 chronological discoveries up to the 1680s:
    // 1. Australia / New Holland (Janszoon 1606, Hartog 1616, Tasman 1642–1644)
    if (lat >= -44.5 && lat <= -10.4 && x >= 112 && x <= 154) {
      if (y >= 1644 && x <= 148) return 'known';
      if (y >= 1606 && x <= 143 && lat >= -35) return 'rumoured';
      if (y >= 1642) return 'rumoured';
      return 'unknown';
    }
    // 2. New Zealand / Staten Landt (Abel Tasman 1642)
    if (lat >= -48 && lat <= -34 && x >= 165 && x <= 179.5) {
      return y >= 1642 ? 'rumoured' : 'unknown';
    }
    // 3. Davis Strait, West Greenland & Baffin (Frobisher 1576, Davis 1585, Baffin 1616)
    if (lat >= 59 && lat <= 78 && x >= -75 && x <= -10) {
      if (y >= 1616 && lat <= 74) return 'known';
      if (y >= 1576 && lat <= 70) return 'rumoured';
      return 'unknown';
    }
    // 4. Hudson Bay (Hudson 1610, James & Foxe 1631, HBC 1670)
    if (lat >= 51 && lat <= 64 && x >= -95 && x <= -75) {
      if (y >= 1632) return 'known';
      if (y >= 1610) return 'rumoured';
    }
    // 5. Cape Horn & Le Maire Strait (Schouten & Le Maire 1616)
    if (lat >= -57.5 && lat <= -52 && x >= -76 && x <= -62 && y >= 1616) {
      return 'known';
    }
    // 6. Atlantic North America, Newfoundland & Guiana (settled & charted 1565–1630)
    if (y >= 1585 && lat >= 31 && lat <= 59 && x >= -82 && x <= -52) {
      return 'known';
    }
    if (y >= 1580 && lat >= 1 && lat <= 10 && x >= -62 && x <= -51) {
      return 'known';
    }
    // 7. Philippines, East Indies, China coast & Japan (Legazpi/Urdaneta 1565, Macao 1557, VOC 1602+)
    if (y >= 1565 && lat >= -11 && lat <= 41 && x >= 104 && x <= 135) {
      return 'known';
    }
    if (y >= 1580 && lat >= 30 && lat <= 46 && x >= 128 && x <= 146) {
      return y >= 1615 ? 'known' : 'rumoured';
    }
    // 8. California & Manila Galleon landfall coast (Vizcaíno 1602)
    if (y >= 1602 && lat >= 23 && lat <= 43 && x >= -126 && x <= -105) {
      return 'known';
    }
    // 9. Patagonia, Chile & Galápagos (Sarmiento 1580, buccaneer charts 1670+)
    if (y >= 1585 && lat >= -56 && lat <= -36.8 && x >= -76 && x <= -55) {
      return 'known';
    }
    if (y >= 1650 && lat >= -2 && lat <= 1 && x >= -92.5 && x <= -89) {
      return 'known';
    }
  }

  for (const [, k, s, n, w, e] of KNOWLEDGE_1550_REGIONS) if (lat >= s && lat <= n && x >= w && x <= e) return k;
  return 'unknown';
}

// ---------------------------------------------------------------------------------------------
// Formatting
// ---------------------------------------------------------------------------------------------
export function formatLatLon(lat, lon) {
  return `${formatLatitude(lat)}, ${formatLongitude(chartLonDelta(lon))}`;
}
function chartDateMs(date) {
  if (date instanceof Date) return date.getTime();
  if (typeof date === 'number') return date;
  if (typeof date === 'string') return Date.parse(date);
  return NaN;
}
/**
 * Formats a date as a period line, e.g. "14 de marzo de 1550 · day 12 at sea". Spain kept the
 * Julian calendar until 1582, so a proleptic-Gregorian timestamp is shown as its Julian date.
 * Accepts an ISO string, a millisecond timestamp or a Date. `dayAtSea` is the ordinal day.
 */
export function formatPeriodDate(date, dayAtSea) {
  const ms = chartDateMs(date);
  if (!Number.isFinite(ms)) return '';
  const day = Number.isFinite(dayAtSea) ? ` · day ${Math.max(1, Math.floor(dayAtSea))} at sea` : '';
  return formatJulianDate(ms) + day;
}

/** Accepts [lat, lon] or {lat, lon} and returns [lat, lon] or null. */
function chartLL(p) {
  if (!p) return null;
  const lat = Array.isArray(p) ? p[0] : p.lat, lon = Array.isArray(p) ? p[1] : p.lon;
  return Number.isFinite(lat) && Number.isFinite(lon) ? [lat, lon] : null;
}
function chartFormatLeagues(nm) {
  const lg = nmToLeagues(nm);
  return `${lg < 10 ? lg.toFixed(1) : Math.round(lg).toLocaleString('en-US')} leagues`;
}
function chartFormatNm(nm) { return `${Math.round(nm).toLocaleString('en-US')} nm`; }
function chartCourseText(deg) { return `${compassPointName(deg)} (${String(Math.round(chartNormDeg(deg)) % 360).padStart(3, '0')}°)`; }

// ---------------------------------------------------------------------------------------------
// Rendering (canvas, browser only)
// ---------------------------------------------------------------------------------------------
const CHART_FONT = "'IM Fell English','Palatino Linotype',Palatino,'Book Antiqua',Georgia,serif";
const CHART_INK = '#3a2412';
const CHART_PENCIL = 'rgba(64,64,70,.88)';
const CHART_RED = '#8b2a1a';
const CHART_TORDESILLAS_LON = -46.62; // 370 leagues west of Cape Verde (1494)
const CHART_ZARAGOZA_LON = 144.5; // 297½ leagues east of the Moluccas (1529)

function chartMulberry(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// Stains are fixed in world coordinates so they pan with the chart.
const CHART_STAINS = (() => {
  const r = chartMulberry(1529);
  return Array.from({ length: 34 }, () => ({ lat: -75 + r() * 150, lon: -180 + r() * 360, rad: 4 + r() * 22, a: 0.03 + r() * 0.07 }));
})();

// Portolan wind-rose centres, from which the 32 rhumbs radiate.
const CHART_ROSES = Object.freeze([
  { lat: 27, lon: -38, main: true },
  { lat: -8, lon: 70 },
  { lat: -4, lon: -122 },
]);

const CHART_LETTERING = Object.freeze([
  { t: 'Mar Océano', lat: 31, lon: -50, size: 1.25, kind: 'sea' },
  { t: 'Mar del Sur', lat: -14, lon: -108, size: 1.4, kind: 'sea' },
  { t: 'Mar de la India', lat: -16, lon: 78, size: 1.2, kind: 'sea' },
  { t: 'Mar Mediterráneo', lat: 34.3, lon: 18, size: 0.55, kind: 'sea' },
  { t: 'Terra Incognita', lat: 52, lon: -112, size: 1.1, kind: 'unknown' },
  { t: 'Terra Incognita', lat: -25, lon: 134, size: 1, kind: 'unknown' },
  { t: 'Terra Australis Incognita', lat: -66, lon: -20, size: 1.2, kind: 'unknown' },
  { t: 'Tierra de Bacallaos', lat: 52.5, lon: -60, size: 0.55, kind: 'land' },
  { t: 'La Florida', lat: 31.5, lon: -85, size: 0.55, kind: 'land' },
  { t: 'Nueva España', lat: 21, lon: -101, size: 0.65, kind: 'land' },
  { t: 'Perú', lat: -10, lon: -74, size: 0.75, kind: 'land' },
  { t: 'Brasil', lat: -9, lon: -45, size: 0.75, kind: 'land' },
  { t: 'Europa', lat: 50, lon: 15, size: 0.75, kind: 'land' },
  { t: 'África', lat: 8, lon: 20, size: 0.9, kind: 'land' },
  { t: 'Asia', lat: 45, lon: 85, size: 0.9, kind: 'land' },
  { t: 'India', lat: 21, lon: 78, size: 0.55, kind: 'land' },
  { t: 'Catayo', lat: 34, lon: 112, size: 0.6, kind: 'land' },
  { t: 'Cipango', lat: 37, lon: 139, size: 0.5, kind: 'land' },
  { t: 'Malucos', lat: 0.5, lon: 127.5, size: 0.5, kind: 'land' },
]);

let chartNoiseTile = null, chartHatchTile = null;
function chartTile(size, paint) {
  const c = document.createElement('canvas');
  c.width = c.height = size;
  paint(c.getContext('2d'), size);
  return c;
}
function chartNoise() {
  if (!chartNoiseTile) chartNoiseTile = chartTile(160, (g, n) => {
    const img = g.createImageData(n, n), r = chartMulberry(1550);
    for (let i = 0; i < n * n; i++) {
      const v = r(), o = i * 4;
      img.data[o] = 92; img.data[o + 1] = 62; img.data[o + 2] = 28;
      img.data[o + 3] = v > 0.986 ? 60 + r() * 90 : v * 24; // fine grain plus occasional fibre flecks
    }
    g.putImageData(img, 0, 0);
  });
  return chartNoiseTile;
}
function chartHatch() {
  if (!chartHatchTile) chartHatchTile = chartTile(6, (g) => {
    g.strokeStyle = 'rgba(58,36,18,.55)'; g.lineWidth = 0.8;
    g.beginPath(); g.moveTo(0, 6); g.lineTo(6, 0); g.moveTo(-1, 1); g.lineTo(1, -1); g.moveTo(5, 7); g.lineTo(7, 5); g.stroke();
  });
  return chartHatchTile;
}

/** World copies (longitude offsets) that intersect the view. */
function chartCopies(v) {
  const half = v.width / 2 / v.scale, lo = v.cx - half, hi = v.cx + half;
  return [-360, 0, 360].filter((o) => hi >= -180 + o && lo <= 180 + o);
}

/** Splits land rings into runs of uniform historical knowledge for `year` (1550..1689). */
function chartPrepareCoasts(rings, year = 1550) {
  const out = [];
  for (const raw of Array.isArray(rings) ? rings : []) {
    const ring = raw.filter((p) => Array.isArray(p) && Number.isFinite(p[0]) && Number.isFinite(p[1]));
    if (ring.length < 3) continue;
    let w = Infinity, e = -Infinity, s = Infinity, n = -Infinity;
    for (const [lon, lat] of ring) { w = Math.min(w, lon); e = Math.max(e, lon); s = Math.min(s, lat); n = Math.max(n, lat); }
    const runs = [];
    let cur = null;
    for (let i = 0; i < ring.length; i++) {
      const a = ring[i], b = ring[(i + 1) % ring.length];
      if (Math.abs(b[0] - a[0]) > 180) { cur = null; continue; } // seam at the antimeridian
      const k = classify1550Knowledge((a[1] + b[1]) / 2, (a[0] + b[0]) / 2, year);
      if (!cur || cur.k !== k) { cur = { k, pts: [a] }; runs.push(cur); }
      cur.pts.push(b);
    }
    // Merge the closing run into the first when the ring closes through the same knowledge.
    if (runs.length > 1 && runs[0].k === runs[runs.length - 1].k && runs[runs.length - 1].pts.at(-1) === runs[0].pts[0]) {
      const last = runs.pop();
      runs[0].pts = last.pts.concat(runs[0].pts.slice(1));
    }
    const kinds = new Set(runs.map((r) => r.k));
    if (!kinds.has('known') && !kinds.has('rumoured')) continue;
    out.push({ ring, runs, box: { w, e, s, n }, known: kinds.has('known'), rumoured: kinds.has('rumoured') });
  }
  return out;
}

/** Adds a [lon, lat] polyline to a path, skipping sub-pixel steps. */
function chartTraceLonLat(path, pts, off, v, close = false) {
  let lx = NaN, ly = NaN;
  for (let i = 0; i < pts.length; i++) {
    const p = chartProject(pts[i][1], pts[i][0] + off, v);
    if (i === 0) { path.moveTo(p.x, p.y); lx = p.x; ly = p.y; continue; }
    if (i < pts.length - 1 && Math.abs(p.x - lx) + Math.abs(p.y - ly) < 0.8) continue;
    path.lineTo(p.x, p.y); lx = p.x; ly = p.y;
  }
  if (close) path.closePath();
}

function chartDrawVellum(ctx, v) {
  const { width: w, height: h } = v;
  const g = ctx.createLinearGradient(0, 0, w, h);
  g.addColorStop(0, '#f1e3c2'); g.addColorStop(0.55, '#ead6ac'); g.addColorStop(1, '#dfc593');
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);
  for (const off of chartCopies(v)) for (const s of CHART_STAINS) {
    const p = chartProject(s.lat, s.lon + off, v), r = Math.max(18, s.rad * v.scale);
    if (p.x < -r || p.x > w + r || p.y < -r || p.y > h + r) continue;
    const rg = ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r);
    rg.addColorStop(0, `rgba(140,98,44,${s.a})`); rg.addColorStop(0.7, `rgba(140,98,44,${s.a * 0.45})`); rg.addColorStop(1, 'rgba(140,98,44,0)');
    ctx.fillStyle = rg; ctx.fillRect(p.x - r, p.y - r, 2 * r, 2 * r);
  }
  const pattern = ctx.createPattern(chartNoise(), 'repeat');
  if (pattern) {
    const o = chartProject(0, 0, v);
    if (pattern.setTransform && typeof DOMMatrix === 'function') pattern.setTransform(new DOMMatrix([1, 0, 0, 1, o.x % 160, o.y % 160]));
    ctx.fillStyle = pattern; ctx.fillRect(0, 0, w, h);
  }
  const vg = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.35, w / 2, h / 2, Math.hypot(w, h) * 0.62);
  vg.addColorStop(0, 'rgba(96,62,24,0)'); vg.addColorStop(1, 'rgba(96,62,24,.34)');
  ctx.fillStyle = vg; ctx.fillRect(0, 0, w, h);
}

function chartDrawRhumbs(ctx, v) {
  ctx.lineWidth = 0.7;
  for (const off of chartCopies(v)) for (const rose of CHART_ROSES) {
    const c = chartProject(rose.lat, rose.lon + off, v);
    const L = Math.hypot(c.x - v.width / 2, c.y - v.height / 2) + v.width + v.height;
    for (let i = 0; i < 32; i++) {
      // Tradition: the 8 winds in black, 8 half-winds in green, 16 quarter-winds in red.
      ctx.strokeStyle = i % 4 === 0 ? 'rgba(43,29,16,.34)' : i % 2 === 0 ? 'rgba(47,107,58,.32)' : 'rgba(155,47,34,.26)';
      const b = i * 11.25 * CHART_RAD;
      ctx.beginPath(); ctx.moveTo(c.x, c.y); ctx.lineTo(c.x + Math.sin(b) * L, c.y - Math.cos(b) * L); ctx.stroke();
    }
    ctx.strokeStyle = 'rgba(43,29,16,.16)'; ctx.setLineDash([2, 4]);
    ctx.beginPath(); ctx.arc(c.x, c.y, 24 * v.scale, 0, Math.PI * 2); ctx.stroke(); ctx.setLineDash([]);
  }
}

function chartLabel(ctx, text, x, y, { size = 12, italic = true, alpha = 0.6, color = CHART_INK, align = 'center', spacing = 0, baseline = 'middle', weight = '', halo = '' } = {}) {
  ctx.save();
  ctx.globalAlpha = alpha; ctx.fillStyle = color;
  ctx.font = `${italic ? 'italic ' : ''}${weight}${weight ? ' ' : ''}${size}px ${CHART_FONT}`;
  ctx.textAlign = align; ctx.textBaseline = baseline;
  if ('letterSpacing' in ctx) ctx.letterSpacing = `${spacing}px`;
  if (halo) { ctx.strokeStyle = halo; ctx.lineWidth = 3; ctx.lineJoin = 'round'; ctx.strokeText(text, x, y); } // keeps overlay text legible over rhumbs and roses
  ctx.fillText(text, x, y);
  ctx.restore();
}

function chartDrawParallels(ctx, v) {
  const lines = [
    [0, 'Línea Equinocial', [], 0.55],
    [23.5, 'Trópico de Cáncer', [6, 4], 0.4], // obliquity c. 1550 ≈ 23° 30′
    [-23.5, 'Trópico de Capricornio', [6, 4], 0.4],
    [66.5, 'Círculo Ártico', [2, 5], 0.28],
    [-66.5, 'Círculo Antártico', [2, 5], 0.28],
  ];
  ctx.save();
  for (const [lat, name, dash, a] of lines) {
    const y = chartProject(lat, 0, v).y;
    if (y < -10 || y > v.height + 10) continue;
    ctx.strokeStyle = `rgba(58,36,18,${a})`; ctx.lineWidth = lat === 0 ? 1.1 : 0.8; ctx.setLineDash(dash);
    ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(v.width, y); ctx.stroke();
    chartLabel(ctx, name, 26, y - 4, { size: 11, alpha: a + 0.2, align: 'left', baseline: 'bottom' });
  }
  // Demarcation lines of Tordesillas and Zaragoza.
  for (const [lon, name] of [[CHART_TORDESILLAS_LON, 'Línea de Tordesillas · 1494'], [CHART_ZARAGOZA_LON, 'Raya de Zaragoza · 1529']]) {
    for (const off of chartCopies(v)) {
      const x = chartProject(0, lon + off, v).x;
      if (x < -10 || x > v.width + 10) continue;
      ctx.strokeStyle = 'rgba(139,42,26,.32)'; ctx.lineWidth = 0.9; ctx.setLineDash([8, 3, 2, 3]);
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, v.height); ctx.stroke();
      // Degree graduations along the meridian, after the pilots' charts.
      ctx.setLineDash([]); ctx.strokeStyle = 'rgba(139,42,26,.45)';
      const top = chartUnproject(0, 0, v).lat, bot = chartUnproject(0, v.height, v).lat;
      const step = v.scale >= 6 ? 1 : 5;
      for (let lat = Math.ceil(bot / step) * step; lat <= top; lat += step) {
        const y = chartProject(lat, 0, v).y, len = lat % 5 === 0 ? 5 : 2.5;
        ctx.beginPath(); ctx.moveTo(x - len, y); ctx.lineTo(x + len, y); ctx.stroke();
      }
      ctx.save(); ctx.translate(x - 5, v.height * 0.32); ctx.rotate(-Math.PI / 2);
      chartLabel(ctx, name, 0, 0, { size: 11, alpha: 0.55, color: CHART_RED });
      ctx.restore();
    }
  }
  ctx.restore();
}

function chartDrawCoasts(ctx, v, coasts) {
  const hatch = ctx.createPattern(chartHatch(), 'repeat');
  ctx.save(); ctx.lineJoin = 'round'; ctx.lineCap = 'round';
  for (const off of chartCopies(v)) for (const c of coasts) {
    const a = chartProject(c.box.n, c.box.w + off, v), b = chartProject(c.box.s, c.box.e + off, v);
    if (b.x < -12 || a.x > v.width + 12 || b.y < -12 || a.y > v.height + 12) continue;
    if (c.known) {
      const known = new Path2D();
      for (const r of c.runs) if (r.k === 'known') chartTraceLonLat(known, r.pts, off, v);
      // Inland hatching: a wide stroke clipped to the land polygon only shades the landward side.
      // Unknown parts of the outline are never revealed.
      const poly = new Path2D(); chartTraceLonLat(poly, c.ring, off, v, true);
      ctx.save(); ctx.clip(poly);
      if (hatch) { ctx.strokeStyle = hatch; ctx.lineWidth = 10; ctx.stroke(known); }
      ctx.strokeStyle = 'rgba(120,78,36,.2)'; ctx.lineWidth = 4; ctx.stroke(known);
      ctx.restore();
      ctx.setLineDash([]); ctx.strokeStyle = CHART_INK; ctx.lineWidth = 1.3; ctx.globalAlpha = 0.92; ctx.stroke(known); ctx.globalAlpha = 1;
    }
    if (c.rumoured) {
      const rum = new Path2D();
      for (const r of c.runs) if (r.k === 'rumoured') chartTraceLonLat(rum, r.pts, off, v);
      ctx.setLineDash([4, 3.5]); ctx.strokeStyle = 'rgba(58,36,18,.5)'; ctx.lineWidth = 1; ctx.stroke(rum); ctx.setLineDash([]);
    }
  }
  ctx.restore();
}

function chartDrawLettering(ctx, v) {
  const base = chartClamp(v.scale * 2.2, 10, 30);
  for (const off of chartCopies(v)) for (const l of CHART_LETTERING) {
    const p = chartProject(l.lat, l.lon + off, v), size = Math.max(9, base * l.size);
    if (p.x < -400 || p.x > v.width + 400 || p.y < -40 || p.y > v.height + 40) continue;
    if (l.kind === 'land') chartLabel(ctx, l.t.toUpperCase(), p.x, p.y, { size, italic: false, alpha: 0.42, spacing: size * 0.25 });
    else chartLabel(ctx, l.t, p.x, p.y, { size, alpha: l.kind === 'unknown' ? 0.3 : 0.52, spacing: size * 0.12 });
  }
}

/** Decorative fleur-de-lis, drawn with its base at the origin and pointing up. */
function chartFleur(ctx, s) {
  ctx.beginPath();
  ctx.moveTo(0, -s);
  ctx.bezierCurveTo(s * 0.3, -s * 0.72, s * 0.24, -s * 0.36, 0, -s * 0.16);
  ctx.bezierCurveTo(-s * 0.24, -s * 0.36, -s * 0.3, -s * 0.72, 0, -s);
  for (const side of [1, -1]) {
    ctx.moveTo(side * s * 0.06, -s * 0.2);
    ctx.bezierCurveTo(side * s * 0.36, -s * 0.6, side * s * 0.8, -s * 0.48, side * s * 0.58, -s * 0.14);
    ctx.bezierCurveTo(side * s * 0.5, -s * 0.32, side * s * 0.32, -s * 0.26, side * s * 0.12, -s * 0.08);
    ctx.closePath();
  }
  ctx.rect(-s * 0.3, -s * 0.16, s * 0.6, s * 0.09);
  ctx.moveTo(-s * 0.12, -s * 0.07); ctx.lineTo(0, s * 0.12); ctx.lineTo(s * 0.12, -s * 0.07); ctx.closePath();
  ctx.fill();
}

function chartDrawRose(ctx, x, y, r, full = true) {
  ctx.save(); ctx.translate(x, y); ctx.lineWidth = 0.8; ctx.strokeStyle = CHART_INK;
  ctx.fillStyle = 'rgba(241,227,194,.55)';
  ctx.beginPath(); ctx.arc(0, 0, r * 0.94, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.arc(0, 0, r * 0.86, 0, Math.PI * 2); ctx.stroke();
  for (let i = 0; i < 32; i++) { // the compass card's point ticks
    const b = i * 11.25 * CHART_RAD, l = i % 2 ? 0.9 : 0.86;
    ctx.beginPath(); ctx.moveTo(Math.sin(b) * r * l, -Math.cos(b) * r * l); ctx.lineTo(Math.sin(b) * r * 0.94, -Math.cos(b) * r * 0.94); ctx.stroke();
  }
  const point = (i, len, width, dark, light) => {
    const b = i * 11.25 * CHART_RAD, tip = [Math.sin(b) * len, -Math.cos(b) * len];
    const px = Math.cos(b) * width, py = Math.sin(b) * width;
    ctx.fillStyle = dark; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(tip[0], tip[1]); ctx.lineTo(-px, -py); ctx.closePath(); ctx.fill(); ctx.stroke();
    ctx.fillStyle = light; ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(tip[0], tip[1]); ctx.lineTo(px, py); ctx.closePath(); ctx.fill(); ctx.stroke();
  };
  if (full) for (let i = 1; i < 32; i += 2) point(i, r * 0.6, r * 0.05, '#9b2f22', '#e8cfa0');
  for (let i = 2; i < 32; i += 4) point(i, r * 0.76, r * 0.08, '#2f6b3a', '#e8d7b0');
  for (let i = 0; i < 32; i += 4) point(i, r * (i === 0 ? 0.86 : 1), r * 0.11, CHART_INK, '#f2e4c4');
  ctx.fillStyle = '#c99a4a'; ctx.beginPath(); ctx.arc(0, 0, r * 0.07, 0, Math.PI * 2); ctx.fill(); ctx.stroke();
  // Fleur-de-lis at north; a cross at east, towards the Holy Land, as on Iberian roses.
  ctx.fillStyle = CHART_INK; ctx.save(); ctx.translate(0, -r * 0.86); chartFleur(ctx, r * 0.3); ctx.restore();
  ctx.lineWidth = Math.max(1, r * 0.025); ctx.beginPath();
  ctx.moveTo(r * 1.02, 0); ctx.lineTo(r * 1.16, 0); ctx.moveTo(r * 1.09, -r * 0.07); ctx.lineTo(r * 1.09, r * 0.07); ctx.stroke();
  ctx.restore();
}

function chartDrawLatScale(ctx, v) {
  const w = 16;
  ctx.save();
  ctx.fillStyle = 'rgba(214,188,140,.85)'; ctx.fillRect(0, 0, w, v.height);
  ctx.strokeStyle = CHART_INK; ctx.lineWidth = 0.8;
  ctx.beginPath(); ctx.moveTo(w + 0.5, 0); ctx.lineTo(w + 0.5, v.height); ctx.stroke();
  const step = v.scale >= 10 ? 1 : v.scale >= 3 ? 5 : 10, major = step === 1 ? 5 : step === 5 ? 10 : 30;
  const top = chartUnproject(0, 0, v).lat, bot = chartUnproject(0, v.height, v).lat;
  for (let lat = Math.ceil(bot / step) * step; lat <= top; lat += step) {
    if (Math.abs(lat) > 90) continue;
    const y = Math.round(chartProject(lat, 0, v).y) + 0.5, isMajor = lat % major === 0;
    ctx.beginPath(); ctx.moveTo(w - (isMajor ? 10 : 5), y); ctx.lineTo(w, y); ctx.stroke();
    if (isMajor) chartLabel(ctx, `${Math.abs(lat)}°${lat ? (lat > 0 ? 'N' : 'S') : ''}`, w + 3, y, { size: 10, italic: false, alpha: 0.75, align: 'left' });
  }
  ctx.restore();
}

/** Cartouche and league scale (top right). On a plane chart this scale is true only along a meridian. */
function chartDrawCartouche(ctx, v) {
  // Narrow (phone) charts skip the cartouche: the wrapped toolbar covers that corner, and the dividers still measure.
  if (v.width < 560) return;
  const right = v.width - 14;
  chartLabel(ctx, 'Carta universal', right, 20, { size: 17, alpha: 0.8, align: 'right' });
  chartLabel(ctx, 'en que se contiene todo lo que del mundo se ha descubierto', right, 37, { size: 10.5, alpha: 0.6, align: 'right' });
  const pxPerLeague = v.scale / LEAGUES_PER_DEGREE;
  const nice = [5, 10, 25, 50, 100, 200, 250, 500, 1000, 2000];
  const leagues = nice.find((n) => n * pxPerLeague >= 70) ?? 2000;
  const px = leagues * pxPerLeague, y = 54, x0 = right - px;
  ctx.save(); ctx.strokeStyle = CHART_INK; ctx.lineWidth = 0.8;
  for (let i = 0; i < 5; i++) {
    ctx.fillStyle = i % 2 ? 'rgba(241,227,194,.9)' : 'rgba(58,36,18,.8)';
    ctx.fillRect(x0 + (px / 5) * i, y, px / 5, 4);
  }
  ctx.strokeRect(x0, y, px, 4);
  ctx.restore();
  chartLabel(ctx, `Escala de leguas · ${leagues}`, right, y + 15, { size: 10.5, alpha: 0.75, align: 'right', halo: 'rgba(236,220,182,.85)' });
}

function chartDrawBase(ctx, v, coasts) {
  chartDrawVellum(ctx, v);
  chartDrawRhumbs(ctx, v);
  chartDrawParallels(ctx, v);
  if (coasts) chartDrawCoasts(ctx, v, coasts);
  chartDrawLettering(ctx, v);
  ctx.save(); ctx.globalAlpha = 0.82; // roses sit back so the pencilled track reads above them
  for (const off of chartCopies(v)) for (const rose of CHART_ROSES) {
    const p = chartProject(rose.lat, rose.lon + off, v);
    const r = rose.main ? chartClamp(v.scale * 6, 30, 96) : chartClamp(v.scale * 4, 18, 60);
    if (p.x > -r * 1.3 && p.x < v.width + r * 1.3 && p.y > -r * 1.3 && p.y < v.height + r * 1.3) chartDrawRose(ctx, p.x, p.y, r, rose.main);
  }
  ctx.restore();
  chartDrawLatScale(ctx, v);
  chartDrawCartouche(ctx, v);
}

// --- overlay glyphs --------------------------------------------------------------------------
function chartDrawShip(ctx, x, y, s, color) {
  ctx.save(); ctx.translate(x, y); ctx.lineWidth = 1.1; ctx.strokeStyle = color; ctx.fillStyle = color; ctx.lineJoin = 'round';
  ctx.beginPath(); ctx.moveTo(-s, 0); ctx.lineTo(s, -s * 0.12); ctx.lineTo(s * 0.62, s * 0.4); ctx.lineTo(-s * 0.7, s * 0.4); ctx.closePath(); ctx.fill();
  ctx.beginPath(); ctx.moveTo(0, 0); ctx.lineTo(0, -s * 1.5); ctx.moveTo(-s * 0.55, 0); ctx.lineTo(-s * 0.55, -s * 1.05); ctx.stroke();
  ctx.fillStyle = '#f3e6c6';
  ctx.beginPath(); ctx.moveTo(-s * 0.42, -s * 1.3); ctx.quadraticCurveTo(0, -s * 1.2, s * 0.42, -s * 1.3); ctx.quadraticCurveTo(s * 0.55, -s * 0.85, s * 0.42, -s * 0.38);
  ctx.quadraticCurveTo(0, -s * 0.48, -s * 0.42, -s * 0.38); ctx.quadraticCurveTo(-s * 0.3, -s * 0.85, -s * 0.42, -s * 1.3); ctx.fill(); ctx.stroke();
  ctx.beginPath(); ctx.moveTo(-s * 0.55, -s * 1.05); ctx.lineTo(-s * 0.95, -s * 0.15); ctx.lineTo(-s * 0.55, -s * 0.15); ctx.closePath(); ctx.fill(); ctx.stroke(); // lateen mizzen
  ctx.fillStyle = CHART_RED; ctx.beginPath(); ctx.moveTo(0, -s * 1.5); ctx.lineTo(s * 0.45, -s * 1.42); ctx.lineTo(0, -s * 1.34); ctx.fill();
  ctx.restore();
}
function chartDrawStar(ctx, x, y, r) {
  ctx.beginPath();
  for (let i = 0; i < 10; i++) {
    const a = (i * Math.PI) / 5 - Math.PI / 2, rr = i % 2 ? r * 0.42 : r;
    i ? ctx.lineTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr) : ctx.moveTo(x + Math.cos(a) * rr, y + Math.sin(a) * rr);
  }
  ctx.closePath();
}
function chartDrawMarkGlyph(ctx, kind, x, y) {
  ctx.save(); ctx.strokeStyle = CHART_INK; ctx.fillStyle = CHART_INK; ctx.lineWidth = 1.1;
  const k = String(kind || '').toLowerCase();
  if (k.includes('land') || k.includes('coast') || k.includes('island')) {
    ctx.beginPath(); ctx.moveTo(x - 7, y + 3); ctx.lineTo(x - 3, y - 4); ctx.lineTo(x, y); ctx.lineTo(x + 3, y - 6); ctx.lineTo(x + 8, y + 3); ctx.stroke();
  } else if (k.includes('ship') || k.includes('sail') || k.includes('encounter') || k.includes('vessel')) {
    chartDrawShip(ctx, x, y + 2, 5, CHART_INK);
  } else if (k.includes('wreck') || k.includes('danger') || k.includes('shoal') || k.includes('reef')) {
    ctx.beginPath(); ctx.moveTo(x - 4, y - 4); ctx.lineTo(x + 4, y + 4); ctx.moveTo(x + 4, y - 4); ctx.lineTo(x - 4, y + 4); ctx.stroke();
    ctx.beginPath(); ctx.arc(x, y, 6, 0, Math.PI * 2); ctx.setLineDash([1.5, 2]); ctx.stroke();
  } else {
    ctx.beginPath(); ctx.arc(x, y, 3.5, 0, Math.PI * 2); ctx.stroke();
    ctx.beginPath(); ctx.arc(x, y, 1, 0, Math.PI * 2); ctx.fill();
  }
  ctx.restore();
}
function chartArrowHead(ctx, x, y, angle, size) {
  ctx.beginPath();
  ctx.moveTo(x, y);
  ctx.lineTo(x - Math.cos(angle - 0.4) * size, y - Math.sin(angle - 0.4) * size);
  ctx.lineTo(x - Math.cos(angle + 0.4) * size, y - Math.sin(angle + 0.4) * size);
  ctx.closePath(); ctx.fill();
}

// ---------------------------------------------------------------------------------------------
// DOM factory
// ---------------------------------------------------------------------------------------------
const CHART_TOOL_HINTS = Object.freeze({
  pan: 'Drag to pan · scroll or pinch to zoom',
  rule: 'Parallel rule: drag from the ship to a point, or tap a point to lay a course',
  dividers: 'Dividers: drag between two points, or tap twice, to measure',
});

/**
 * Creates the chart drawer: a toolbar button appended to `dock` and a slide-out chart panel.
 *
 * @param {object} o
 * @param {HTMLElement} [o.dock] container for the #chart-button toggle
 * @param {string} [o.landRingsUrl] Natural Earth rings, as an array of [[lon, lat], ...]
 * @param {(c:{courseTrue:number, compassPoint:string, target:{lat:number,lon:number}, from:{lat:number,lon:number}|null, fromShip:boolean, distanceNm:number, setDestination?:boolean})=>void} [o.onSetCourse]
 * @param {(target:{lat:number,lon:number})=>void} [o.onSetDestination] optional. Without it, "Set as destination" calls onSetCourse with setDestination:true.
 * @param {()=>void} [o.onClose]
 * @param {(tierId:string)=>void} [o.onWarp]
 * @param {()=>object} [o.getSnapshot] polled about every 250 ms while the drawer is open
 */
export function createChartDrawer({ dock, landRingsUrl = 'assets/world/land.json', onSetCourse, onSetDestination, onClose, onWarp, getSnapshot } = {}) {
  const button = controlIcon(document.createElement('button'), 'chart', 'Chart');
  button.id = 'chart-button';
  button.setAttribute('aria-controls', 'chart-drawer');
  button.setAttribute('aria-expanded', 'false');

  const root = document.createElement('section');
  root.id = 'chart-drawer'; root.hidden = true;
  root.setAttribute('aria-labelledby', 'chart-drawer-title');
  root.innerHTML = `<div class="panel-header"><div class="chart-heading"><strong id="chart-drawer-title">Carta de marear</strong><span class="chart-subtitle"></span></div></div>
    <div class="chart-layout">
      <div class="chart-stage" data-tool="pan">
        <canvas class="chart-canvas" role="img" tabindex="0" aria-label="Sea chart"></canvas>
        <div class="chart-toolbar" role="group" aria-label="Chart tools">
          <button type="button" data-tool="pan" aria-pressed="true" title="Pan and zoom the chart">Pan</button>
          <button type="button" data-tool="rule" aria-pressed="false" title="Lay a course with the parallel rule">Parallel rule</button>
          <button type="button" data-tool="dividers" aria-pressed="false" title="Measure a distance with the dividers">Dividers</button>
          <button type="button" data-action="centre" title="Centre the chart on the ship">Centre on ship</button>
          <button type="button" data-action="zoom-in" aria-label="Zoom in" title="Zoom in">+</button>
          <button type="button" data-action="zoom-out" aria-label="Zoom out" title="Zoom out">−</button>
        </div>
        <div class="chart-readout">
          <p class="chart-readout-text"></p>
          <output class="chart-cursor" aria-live="off"></output>
          <div class="chart-readout-actions">
            <button type="button" data-action="lay" disabled>Lay this course</button>
            <button type="button" data-action="destination" disabled>Set as destination</button>
            <button type="button" data-action="clear" disabled>Clear</button>
          </div>
          <p class="chart-sr-only" role="status" aria-live="polite"></p>
        </div>
      </div>
      <aside class="chart-side" aria-label="Voyage">
        <section class="chart-side-block" aria-labelledby="chart-time-title"><h3 id="chart-time-title">Time at sea</h3>
          <p class="chart-date-line">—</p><div class="chart-warp" role="group" aria-label="Time warp"></div></section>
        <section class="chart-side-block" aria-labelledby="chart-provisions-title"><h3 id="chart-provisions-title">Provisions</h3>
          <div class="chart-provision"><span id="chart-food-label">Biscuit &amp; salt meat</span><meter aria-labelledby="chart-food-label" min="0" max="60" low="10" high="25" optimum="60" value="0"></meter><output data-prov="food">—</output></div>
          <div class="chart-provision"><span id="chart-water-label">Water &amp; wine</span><meter aria-labelledby="chart-water-label" min="0" max="60" low="10" high="25" optimum="60" value="0"></meter><output data-prov="water">—</output></div></section>
        <section class="chart-side-block chart-log-block" aria-labelledby="chart-log-title"><h3 id="chart-log-title">Ship’s Log</h3>
          <ol class="chart-log"></ol><p class="chart-log-empty">No entries yet.</p></section>
      </aside>
    </div>`;
  const header = root.querySelector('.panel-header');
  const closeButton = controlIcon(document.createElement('button'), 'close', 'Close chart');
  header.append(closeButton);
  const $ = (sel) => root.querySelector(sel);
  const stage = $('.chart-stage'), canvas = $('.chart-canvas'), ctx = canvas.getContext('2d');
  const subtitle = $('.chart-subtitle'), readoutText = $('.chart-readout-text'), cursorOut = $('.chart-cursor'), srStatus = $('.chart-sr-only');
  const layButton = $('[data-action=lay]'), destButton = $('[data-action=destination]'), clearButton = $('[data-action=clear]');
  const dateLine = $('.chart-date-line'), warpGroup = $('.chart-warp'), logList = $('.chart-log'), logEmpty = $('.chart-log-empty');
  const foodMeter = $('[aria-labelledby=chart-food-label]'), waterMeter = $('[aria-labelledby=chart-water-label]');
  const foodOut = $('[data-prov=food]'), waterOut = $('[data-prov=water]');
  const toolButtons = [...root.querySelectorAll('[data-tool]')].filter((b) => b.tagName === 'BUTTON');
  const reducedMotion = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : { matches: false };

  // --- state ---
  const view = { cx: -40, cy: 25, scale: 4, width: 0, height: 0 };
  let dpr = 1, viewReady = false, open = false;
  let snap = {}, canvasSig = null, sideSig = null, logSig = null, warpSig = null;
  let rawRings = null, coasts = null, coastYearBucket = 1550, coastVersion = 0, ringsState = 'idle';
  const base = document.createElement('canvas'), baseCtx = base.getContext('2d');
  let baseKey = '';
  let tool = 'pan', rule = null, dividers = null;
  let drag = null, pinch = null, rafId = 0, pollId = 0, anim = null, hover = null;
  const pointers = new Map();

  // --- view helpers ---
  const minScale = () => Math.max(0.5, Math.min(view.width / 360, view.height / 165));
  const maxScale = 180;
  function clampView() {
    view.scale = chartClamp(view.scale, minScale(), maxScale);
    view.cy = chartClamp(view.cy, -82, 82);
    view.cx = chartLonDelta(view.cx);
  }
  function zoomAt(x, y, factor) {
    const before = chartUnproject(x, y, view);
    view.scale = chartClamp(view.scale * factor, minScale(), maxScale);
    view.cx = before.lon - (x - view.width / 2) / view.scale;
    view.cy = before.lat + (y - view.height / 2) / view.scale;
    clampView(); requestDraw();
  }
  function panBy(dx, dy) { view.cx -= dx / view.scale; view.cy += dy / view.scale; clampView(); requestDraw(); }
  function initView() {
    const dr = chartLL(snap.drPos);
    view.scale = chartClamp(view.width / 80, minScale(), maxScale);
    if (dr) { view.cy = dr[0]; view.cx = dr[1]; } else { view.cy = 25; view.cx = -40; }
    clampView(); viewReady = true;
  }
  function centreOnShip() {
    const dr = chartLL(snap.drPos);
    if (!dr) { announce('No reckoned position yet.'); return; }
    const target = { cx: chartWrapLonNear(dr[1], view.cx), cy: dr[0] };
    if (reducedMotion.matches) { view.cx = target.cx; view.cy = target.cy; clampView(); requestDraw(); return; }
    anim = { from: { cx: view.cx, cy: view.cy }, to: target, t0: performance.now(), dur: 380 };
    requestDraw();
  }

  // --- drawing ---
  function requestDraw() { if (open && !rafId) rafId = requestAnimationFrame(frame); }
  function frame(now) {
    rafId = 0;
    if (!open || !view.width || !view.height) return;
    if (anim) {
      const t = Math.min(1, (now - anim.t0) / anim.dur), e = 1 - (1 - t) ** 3;
      view.cx = anim.from.cx + (anim.to.cx - anim.from.cx) * e; view.cy = anim.from.cy + (anim.to.cy - anim.from.cy) * e;
      clampView();
      if (t >= 1) anim = null; else requestDraw();
    }
    // The static layer (vellum, rhumbs, coasts and lettering) is cached per view.
    const key = `${view.cx.toFixed(5)}|${view.cy.toFixed(5)}|${view.scale.toFixed(5)}|${view.width}|${view.height}|${dpr}|${coastVersion}`;
    if (key !== baseKey) {
      baseKey = key;
      baseCtx.setTransform(dpr, 0, 0, dpr, 0, 0);
      chartDrawBase(baseCtx, view, coasts);
    }
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(base, 0, 0);
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    drawOverlays();
  }

  const P = (lat, lon, ref = view.cx) => chartProject(lat, chartWrapLonNear(lon, ref), view);
  /** Strokes a [lat, lon] polyline, unwrapping longitudes so it stays continuous across ±180°. */
  function tracePolyline(pts) {
    let prevLon = null, lx = NaN, ly = NaN, started = false;
    ctx.beginPath();
    for (let i = 0; i < pts.length; i++) {
      const ll = chartLL(pts[i]); if (!ll) continue;
      const lon = prevLon === null ? chartWrapLonNear(ll[1], view.cx) : chartWrapLonNear(ll[1], prevLon);
      prevLon = lon;
      const p = chartProject(ll[0], lon, view);
      if (!started) { ctx.moveTo(p.x, p.y); started = true; lx = p.x; ly = p.y; continue; }
      if (i < pts.length - 1 && Math.abs(p.x - lx) + Math.abs(p.y - ly) < 1.2) continue;
      ctx.lineTo(p.x, p.y); lx = p.x; ly = p.y;
    }
    ctx.stroke();
  }
  /** Screen direction of a rhumb at latitude `lat`. On a plane chart, east-west distances are stretched by 1/cos φ. */
  function rhumbScreenDir(bearing, lat) {
    const b = bearing * CHART_RAD, dx = Math.sin(b) / Math.max(0.05, Math.cos(lat * CHART_RAD)), dy = -Math.cos(b);
    const l = Math.hypot(dx, dy) || 1;
    return [dx / l, dy / l];
  }
  function smallLabel(text, x, y, opts = {}) { chartLabel(ctx, text, x, y, { size: 11.5, alpha: 0.9, align: 'left', halo: 'rgba(241,227,194,.9)', ...opts }); }
  function liveRuleStart() {
    if (!rule) return null;
    if (rule.fromShip) { const dr = chartLL(snap.drPos); return dr ? { lat: dr[0], lon: dr[1] } : rule.a; }
    return rule.a;
  }

  function drawOverlays() {
    const s = snap || {}, dr = chartLL(s.drPos), reveal = !!s.revealTrue;
    ctx.save(); ctx.lineCap = 'round'; ctx.lineJoin = 'round';

    // Destination
    const dest = chartLL(s.destination);
    if (dest) {
      const p = P(dest[0], dest[1]);
      ctx.strokeStyle = CHART_RED; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.arc(p.x, p.y, 6, 0, Math.PI * 2); ctx.moveTo(p.x - 9, p.y); ctx.lineTo(p.x + 9, p.y); ctx.moveTo(p.x, p.y - 9); ctx.lineTo(p.x, p.y + 9); ctx.stroke();
      const name = s.destination.name || 'Destination';
      smallLabel(name, p.x + 10, p.y - 9, { color: CHART_RED });
      if (dr) smallLabel(chartFormatLeagues(rhumbDistanceNm(dr[0], dr[1], dest[0], dest[1])), p.x + 10, p.y + 5, { color: CHART_RED, size: 10, alpha: 0.7 });
    }
    // Discoveries: ink stars
    for (const d of Array.isArray(s.discoveries) ? s.discoveries : []) {
      const ll = chartLL(d); if (!ll) continue;
      const p = P(ll[0], ll[1]);
      ctx.fillStyle = CHART_INK; ctx.strokeStyle = '#b8862e'; ctx.lineWidth = 1;
      chartDrawStar(ctx, p.x, p.y, 7); ctx.fill(); ctx.stroke();
      if (d.name) smallLabel(d.name, p.x + 9, p.y - 2, { weight: '600' });
      if (d.by) smallLabel(`descubierta por ${d.by}`, p.x + 9, p.y + 11, { size: 9.5, alpha: 0.65 });
    }
    // Marks (encounters, land sightings)
    for (const m of Array.isArray(s.marks) ? s.marks : []) {
      const ll = chartLL(m); if (!ll) continue;
      const p = P(ll[0], ll[1]);
      chartDrawMarkGlyph(ctx, m.kind, p.x, p.y);
      if (m.label) smallLabel(m.label, p.x + 9, p.y, { size: 10.5, alpha: 0.75 });
    }
    // True track and position: revealed in easy mode or after landfall
    if (reveal && Array.isArray(s.trueTrack) && s.trueTrack.length > 1) {
      ctx.strokeStyle = 'rgba(139,42,26,.75)'; ctx.lineWidth = 1.5; ctx.setLineDash([5, 4]); tracePolyline(s.trueTrack); ctx.setLineDash([]);
    }
    // Dead-reckoning track in pencil
    if (Array.isArray(s.drTrack) && s.drTrack.length > 1) {
      ctx.strokeStyle = CHART_PENCIL; ctx.lineWidth = 1.6; tracePolyline(s.drTrack);
    }
    // Latitude fixes: a short pencil line across the DR longitude
    const fixes = Array.isArray(s.fixes) ? s.fixes : [];
    const uNm = Number.isFinite(s.uncertaintyNm) ? s.uncertaintyNm : 0;
    fixes.forEach((f, i) => {
      if (!Number.isFinite(f?.lat)) return;
      const lon = Number.isFinite(f.lon) ? f.lon : dr ? dr[1] : null;
      if (lon === null) return;
      const p = P(f.lat, lon), halfDeg = Math.max(uNm, 30) / 60 / Math.max(0.1, Math.cos(f.lat * CHART_RAD));
      const half = Math.max(16, halfDeg * view.scale);
      ctx.strokeStyle = CHART_PENCIL; ctx.lineWidth = 1.2;
      ctx.beginPath(); ctx.moveTo(p.x - half, p.y); ctx.lineTo(p.x + half, p.y);
      ctx.moveTo(p.x - half, p.y - 3); ctx.lineTo(p.x - half, p.y + 3); ctx.moveTo(p.x + half, p.y - 3); ctx.lineTo(p.x + half, p.y + 3); ctx.stroke();
      if (i >= fixes.length - 12) { // label only recent fixes to avoid clutter
        const glyph = f.kind === 'polaris' ? '✶' : '☉';
        const ms = chartDateMs(f.date);
        const when = Number.isFinite(ms) ? formatJulianDate(ms).replace(/ de \d+$/, '') : '';
        smallLabel(`${glyph} ${when}`.trim(), p.x + half + 4, p.y, { size: 9.5, alpha: 0.7, color: '#3c3c42' });
      }
    });
    // Uncertainty of the reckoning, shown as an ellipse on the plane chart
    if (dr && uNm > 0) {
      const p = P(dr[0], dr[1]), ry = (uNm / 60) * view.scale, rx = ry / Math.max(0.1, Math.cos(dr[0] * CHART_RAD));
      if (rx < 4000) {
        ctx.fillStyle = 'rgba(64,64,70,.06)'; ctx.strokeStyle = 'rgba(64,64,70,.55)'; ctx.lineWidth = 1; ctx.setLineDash([3, 3]);
        ctx.beginPath(); ctx.ellipse(p.x, p.y, Math.max(rx, 3), Math.max(ry, 3), 0, 0, Math.PI * 2); ctx.fill(); ctx.stroke(); ctx.setLineDash([]);
      }
    }
    // Course: a solid heading ray from the DR position, plus a faint rhumb running ahead
    if (dr && Number.isFinite(s.courseTrue)) {
      const p = P(dr[0], dr[1]);
      const end = rhumbDestination(dr[0], dr[1], s.courseTrue, 900);
      const ahead = rhumbPath(dr[0], dr[1], end.lat, end.lon, 30);
      ctx.strokeStyle = 'rgba(139,42,26,.4)'; ctx.lineWidth = 1; ctx.setLineDash([2, 5]); tracePolyline(ahead); ctx.setLineDash([]);
      const [ux, uy] = rhumbScreenDir(s.courseTrue, dr[0]), L = 64;
      ctx.strokeStyle = CHART_RED; ctx.fillStyle = CHART_RED; ctx.lineWidth = 1.8;
      ctx.beginPath(); ctx.moveTo(p.x + ux * 10, p.y + uy * 10); ctx.lineTo(p.x + ux * L, p.y + uy * L); ctx.stroke();
      chartArrowHead(ctx, p.x + ux * (L + 6), p.y + uy * (L + 6), Math.atan2(uy, ux), 9);
      const label = compassPointName(s.courseTrue) + (Number.isFinite(s.courseCompass) ? ` · comp. ${Math.round(chartNormDeg(s.courseCompass))}°` : '');
      smallLabel(label, p.x + ux * (L + 12) + (ux >= 0 ? 4 : -4), p.y + uy * (L + 12), { color: CHART_RED, align: ux >= 0 ? 'left' : 'right', size: 10.5 });
    }
    // DR ship
    if (dr) {
      const p = P(dr[0], dr[1]);
      // A soft vellum ground keeps the ship readable where it crosses a rose or dense rhumbs.
      const halo = ctx.createRadialGradient(p.x, p.y - 6, 0, p.x, p.y - 6, 20);
      halo.addColorStop(0, 'rgba(241,227,194,.92)'); halo.addColorStop(0.6, 'rgba(241,227,194,.7)'); halo.addColorStop(1, 'rgba(241,227,194,0)');
      ctx.fillStyle = halo; ctx.beginPath(); ctx.arc(p.x, p.y - 6, 20, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = CHART_PENCIL; ctx.fillStyle = CHART_PENCIL; ctx.lineWidth = 1.3;
      ctx.beginPath(); ctx.arc(p.x, p.y, 4.5, 0, Math.PI * 2); ctx.stroke();
      ctx.beginPath(); ctx.arc(p.x, p.y, 1.3, 0, Math.PI * 2); ctx.fill();
      chartDrawShip(ctx, p.x, p.y - 10, 8, CHART_INK);
      smallLabel(s.ship?.name || 'DR', p.x + 10, p.y + 9, { size: 10, alpha: 0.75 });
    }
    if (reveal) {
      const tp = chartLL(s.truePos);
      if (tp) {
        const p = P(tp[0], tp[1]);
        ctx.strokeStyle = CHART_RED; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(p.x, p.y, 6, 0, Math.PI * 2); ctx.moveTo(p.x - 6, p.y); ctx.lineTo(p.x + 6, p.y); ctx.moveTo(p.x, p.y - 6); ctx.lineTo(p.x, p.y + 6); ctx.stroke();
        smallLabel('True position', p.x + 9, p.y - 9, { color: CHART_RED, size: 10 });
      }
    }
    drawTools(dr);
    ctx.restore();
  }

  function drawTools(dr) {
    // Parallel rule
    const a = liveRuleStart(), b = rule?.b;
    if (b && !a) {
      const p = P(b.lat, b.lon); ctx.strokeStyle = CHART_RED; ctx.lineWidth = 1.4;
      ctx.beginPath(); ctx.arc(p.x, p.y, 5, 0, Math.PI * 2); ctx.stroke();
    }
    if (a && b) {
      const pa = P(a.lat, a.lon), pb = P(b.lat, b.lon, chartWrapLonNear(a.lon, view.cx));
      const ang = Math.atan2(pb.y - pa.y, pb.x - pa.x), len = Math.hypot(pb.x - pa.x, pb.y - pa.y);
      // The rule itself: a translucent boxwood straightedge lying beside the line.
      ctx.save(); ctx.translate(pa.x, pa.y); ctx.rotate(ang);
      ctx.fillStyle = 'rgba(176,132,70,.22)'; ctx.strokeStyle = 'rgba(92,60,26,.55)'; ctx.lineWidth = 1;
      ctx.fillRect(-14, 2, len + 28, 18); ctx.strokeRect(-14, 2, len + 28, 18);
      for (let x = 0; x < len; x += 12) { ctx.beginPath(); ctx.moveTo(x, 2); ctx.lineTo(x, x % 60 === 0 ? 8 : 5); ctx.stroke(); }
      ctx.restore();
      ctx.strokeStyle = CHART_RED; ctx.lineWidth = 1.6;
      tracePolyline(rhumbPath(a.lat, a.lon, b.lat, b.lon, 40));
      ctx.fillStyle = CHART_RED;
      for (const p of [pa, pb]) { ctx.beginPath(); ctx.arc(p.x, p.y, 3, 0, Math.PI * 2); ctx.fill(); }
      const brg = rhumbBearing(a.lat, a.lon, b.lat, b.lon), nm = rhumbDistanceNm(a.lat, a.lon, b.lat, b.lon);
      // A rule walked off elsewhere on the chart is transferred to the ship's position.
      if (!rule.fromShip && dr) {
        const end = rhumbDestination(dr[0], dr[1], brg, nm);
        ctx.strokeStyle = 'rgba(139,42,26,.55)'; ctx.lineWidth = 1.2; ctx.setLineDash([6, 4]);
        tracePolyline(rhumbPath(dr[0], dr[1], end.lat, end.lon, 40)); ctx.setLineDash([]);
      }
      smallLabel(`${chartCourseText(brg)} · ${chartFormatLeagues(nm)}`, (pa.x + pb.x) / 2 + 8, (pa.y + pb.y) / 2 - 14, { color: CHART_RED, size: 11 });
    }
    // Dividers
    if (dividers?.a) {
      const pa = P(dividers.a.lat, dividers.a.lon);
      const bb = dividers.b ?? null;
      ctx.strokeStyle = '#6d5226'; ctx.fillStyle = '#6d5226'; ctx.lineWidth = 2;
      if (!bb) { ctx.beginPath(); ctx.arc(pa.x, pa.y, 4, 0, Math.PI * 2); ctx.stroke(); return; }
      const pb = P(bb.lat, bb.lon, chartWrapLonNear(dividers.a.lon, view.cx));
      const mx = (pa.x + pb.x) / 2, my = (pa.y + pb.y) / 2, len = Math.hypot(pb.x - pa.x, pb.y - pa.y) || 1;
      let nx = -(pb.y - pa.y) / len, ny = (pb.x - pa.x) / len; if (ny > 0) { nx = -nx; ny = -ny; } // apex above the line
      const h = Math.min(60, Math.max(18, len * 0.35)), ax = mx + nx * h, ay = my + ny * h;
      ctx.beginPath(); ctx.moveTo(pa.x, pa.y); ctx.lineTo(ax, ay); ctx.lineTo(pb.x, pb.y); ctx.stroke();
      ctx.beginPath(); ctx.arc(ax, ay, 3.5, 0, Math.PI * 2); ctx.fill();
      ctx.strokeStyle = 'rgba(64,64,70,.6)'; ctx.lineWidth = 1; ctx.setLineDash([2, 3]);
      tracePolyline(rhumbPath(dividers.a.lat, dividers.a.lon, bb.lat, bb.lon, 30)); ctx.setLineDash([]);
      const nm = rhumbDistanceNm(dividers.a.lat, dividers.a.lon, bb.lat, bb.lon);
      smallLabel(`${chartFormatLeagues(nm)} · ${chartFormatNm(nm)}`, ax + 8, ay - 4, { color: '#5a4320', size: 11 });
    }
  }

  // --- readouts ---
  function toolReadout() {
    if (tool === 'rule' && rule) {
      const a = liveRuleStart(), b = rule.b;
      if (a && b) {
        const brg = rhumbBearing(a.lat, a.lon, b.lat, b.lon), nm = rhumbDistanceNm(a.lat, a.lon, b.lat, b.lon);
        return `Course ${chartCourseText(brg)} · ${chartFormatLeagues(nm)}${rule.fromShip ? '' : ' · transferred to the ship'}`;
      }
      if (b) return `Point marked at ${formatLatLon(b.lat, b.lon)}`;
    }
    if (tool === 'dividers' && dividers?.a) {
      if (!dividers.b) return 'Dividers: pick the second point';
      const nm = rhumbDistanceNm(dividers.a.lat, dividers.a.lon, dividers.b.lat, dividers.b.lon);
      return `Dividers · ${chartFormatLeagues(nm)} (${chartFormatNm(nm)})`;
    }
    return CHART_TOOL_HINTS[tool];
  }
  function refreshReadout(announceIt = false) {
    const text = toolReadout();
    readoutText.textContent = text;
    const hasRule = tool === 'rule' && rule;
    layButton.disabled = !(hasRule && liveRuleStart() && rule.b);
    destButton.disabled = !(hasRule && rule.b);
    clearButton.disabled = clearButton.hidden = !(rule || dividers);
    layButton.hidden = destButton.hidden = tool !== 'rule';
    if (announceIt) announce(text);
  }
  function announce(text) { srStatus.textContent = text; }
  function updateCursor() {
    cursorOut.textContent = hover ? `Cursor ${formatLatLon(hover.lat, hover.lon)}` : '';
  }
  function updateAria() {
    const s = snap || {}, dr = chartLL(s.drPos), parts = ['Sea chart, c. 1550.'];
    if (dr) parts.push(`Dead-reckoning position ${formatLatLon(dr[0], dr[1])}.`);
    if (Number.isFinite(s.courseTrue)) parts.push(`Course ${chartCourseText(s.courseTrue)} true.`);
    if (Number.isFinite(s.uncertaintyNm) && s.uncertaintyNm > 0) parts.push(`Reckoning uncertain by about ${chartFormatLeagues(s.uncertaintyNm)}.`);
    const dest = chartLL(s.destination);
    if (dest && dr) parts.push(`${s.destination.name || 'Destination'} lies ${compassPointName(rhumbBearing(dr[0], dr[1], dest[0], dest[1]))}, ${chartFormatLeagues(rhumbDistanceNm(dr[0], dr[1], dest[0], dest[1]))}.`);
    const tp = chartLL(s.truePos);
    if (s.revealTrue && tp) parts.push(`True position ${formatLatLon(tp[0], tp[1])}.`);
    canvas.setAttribute('aria-label', parts.join(' '));
  }

  // --- side strip ---
  function dayAtSea(s) {
    if (Number.isFinite(s.dayAtSea)) return s.dayAtSea;
    if (Number.isFinite(s.daysAtSea)) return Math.floor(s.daysAtSea) + 1;
    const d0 = chartDateMs(s.departureDate), d1 = chartDateMs(s.date);
    return Number.isFinite(d0) && Number.isFinite(d1) ? Math.floor((d1 - d0) / 86400000) + 1 : undefined;
  }
  function updateSide() {
    const s = snap || {};
    const day = dayAtSea(s), dateText = formatPeriodDate(s.date, day);
    const tiers = Array.isArray(s.warpTiers) ? s.warpTiers : [];
    const p = s.provisions || {};
    const sig = [dateText, s.ship?.name ?? '', s.warp ?? '', s.tier ?? '', tiers.map((t) => t.id).join(','), p.daysFood, p.daysWater].join('|');
    if (sig !== sideSig) {
      sideSig = sig;
      dateLine.textContent = dateText || '—';
      subtitle.textContent = [s.ship?.name, dateText].filter(Boolean).join(' · ');
      const tierSig = tiers.map((t) => `${t.id}:${t.label}`).join(',');
      if (tierSig !== warpSig) {
        warpSig = tierSig;
        warpGroup.replaceChildren(...tiers.map((t) => {
          const b = document.createElement('button');
          b.type = 'button'; b.dataset.tier = String(t.id); b.textContent = t.label ?? String(t.id);
          if (Number.isFinite(t.rate)) b.title = `${t.rate.toLocaleString('en-US')}× time`;
          b.onclick = () => {
            onWarp?.(t.id);
            if (getSnapshot) update(getSnapshot());
            if (Number(t.rate) > 1) {
              readoutText.textContent = `Time warp: ${t.label} (${Number(t.rate).toLocaleString('en-US')}×) — press M or Esc to watch from the deck`;
            }
          };
          return b;
        }));
        warpGroup.hidden = tiers.length === 0;
      }
      for (const b of warpGroup.children) {
        const t = tiers.find((x) => String(x.id) === b.dataset.tier);
        const pressed = Boolean(t && (s.tier ? String(t.id) === String(s.tier) : (t.rate === s.warp || t.id === s.warp)));
        b.setAttribute('aria-pressed', String(pressed));
      }
      for (const [meter, out, val] of [[foodMeter, foodOut, p.daysFood], [waterMeter, waterOut, p.daysWater]]) {
        const ok = Number.isFinite(val);
        meter.max = Math.max(60, ok ? Math.ceil(val) : 0); meter.value = ok ? Math.max(0, val) : 0;
        out.textContent = ok ? `${Math.max(0, Math.floor(val))} days` : '—';
      }
    }
    const log = Array.isArray(s.log) ? s.log : [];
    const lsig = `${log.length}|${log.at(-1)?.text ?? ''}|${log[0]?.text ?? ''}`;
    if (lsig !== logSig) {
      logSig = lsig;
      // Newest first, by date where dates parse, otherwise in reverse insertion order.
      const items = log.map((e, i) => ({ e, i, t: chartDateMs(e?.date) }))
        .sort((x, y) => (Number.isFinite(y.t) && Number.isFinite(x.t) && y.t !== x.t ? y.t - x.t : y.i - x.i))
        .slice(0, 80);
      logList.replaceChildren(...items.map(({ e, t }) => {
        const li = document.createElement('li');
        if (e?.date) {
          const time = document.createElement('time');
          if (Number.isFinite(t)) { time.dateTime = new Date(t).toISOString(); time.textContent = formatJulianDate(t); } else time.textContent = String(e.date);
          li.append(time);
        }
        const text = document.createElement('span'); text.textContent = String(e?.text ?? e ?? '');
        li.append(text);
        return li;
      }));
      logEmpty.hidden = items.length > 0;
    }
  }

  // --- snapshot intake ---
  function canvasSignature(s) {
    const ll = (p) => { const q = chartLL(p); return q ? `${q[0].toFixed(3)},${q[1].toFixed(3)}` : '-'; };
    const arr = (a) => (Array.isArray(a) && a.length ? `${a.length}:${ll(a[a.length - 1])}` : '-');
    const num = (x, d = 1) => (Number.isFinite(x) ? x.toFixed(d) : '-');
    return [ll(s.drPos), arr(s.drTrack), s.revealTrue ? `T${ll(s.truePos)}${arr(s.trueTrack)}` : 'F', arr(s.fixes), num(s.uncertaintyNm),
      num(s.courseTrue), num(s.courseCompass), ll(s.destination), s.destination?.name ?? '', arr(s.marks), arr(s.discoveries), s.ship?.name ?? ''].join('|');
  }
  function getSnapshotYearBucket(s) {
    const ms = chartDateMs(s?.date);
    if (!Number.isFinite(ms)) return 1550;
    const y = new Date(ms).getUTCFullYear();
    if (!Number.isFinite(y) || y < 1492 || y > 1750) return 1550;
    return Math.floor(y / 5) * 5;
  }
  function update(snapshot) {
    if (!snapshot || typeof snapshot !== 'object') return;
    snap = snapshot;
    if (!open) return; // stored for when the drawer opens; closed drawers do no work
    const yBucket = getSnapshotYearBucket(snap);
    if (rawRings && yBucket !== coastYearBucket) {
      coastYearBucket = yBucket;
      coasts = chartPrepareCoasts(rawRings, coastYearBucket);
      coastVersion++;
    }
    const sig = canvasSignature(snap);
    if (sig !== canvasSig) {
      canvasSig = sig;
      if (!viewReady && view.width) initView();
      updateAria(); requestDraw();
      if (rule?.fromShip) refreshReadout();
    }
    updateSide();
  }

  // --- coastline data ---
  async function loadRings() {
    if (ringsState === 'loading' || ringsState === 'ready') return;
    ringsState = 'loading';
    try {
      const response = await fetch(landRingsUrl);
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      rawRings = await response.json();
      coastYearBucket = getSnapshotYearBucket(snap);
      coasts = chartPrepareCoasts(rawRings, coastYearBucket);
      coastVersion++; ringsState = 'ready'; requestDraw();
    } catch {
      ringsState = 'idle';
      announce('The coastlines could not be loaded. Close and reopen the chart to retry.');
      readoutText.textContent = 'Coastlines unavailable. Close and reopen the chart to retry.';
    }
  }

  // --- open / close ---
  function setOpen(next, { returnFocus = true } = {}) {
    if (next === open) return;
    open = next;
    root.hidden = !open;
    button.setAttribute('aria-expanded', String(open));
    document.body.classList.toggle('chart-open', open);
    if (open) {
      if (document.pointerLockElement) document.exitPointerLock();
      loadRings();
      canvasSig = sideSig = logSig = null; // force a full refresh
      update(getSnapshot?.() ?? snap);
      if (getSnapshot) pollId = setInterval(() => update(getSnapshot()), 250);
      refreshReadout();
      closeButton.focus({ preventScroll: true });
      requestDraw();
    } else {
      clearInterval(pollId); pollId = 0;
      if (rafId) cancelAnimationFrame(rafId); rafId = 0;
      drag = pinch = anim = null; pointers.clear();
      if (returnFocus && root.contains(document.activeElement)) button.focus({ preventScroll: true });
      onClose?.();
    }
  }
  const openDrawer = () => setOpen(true), closeDrawer = () => setOpen(false);
  button.addEventListener('click', () => setOpen(!open));
  closeButton.addEventListener('click', () => { setOpen(false); button.focus({ preventScroll: true }); });

  // --- tools and actions ---
  function setTool(next) {
    tool = next; stage.dataset.tool = next;
    for (const b of toolButtons) b.setAttribute('aria-pressed', String(b.dataset.tool === next));
    refreshReadout(); requestDraw();
  }
  for (const b of toolButtons) b.addEventListener('click', () => setTool(b.dataset.tool));
  $('[data-action=centre]').addEventListener('click', centreOnShip);
  $('[data-action=zoom-in]').addEventListener('click', () => zoomAt(view.width / 2, view.height / 2, 1.5));
  $('[data-action=zoom-out]').addEventListener('click', () => zoomAt(view.width / 2, view.height / 2, 1 / 1.5));
  clearButton.addEventListener('click', () => { rule = dividers = null; refreshReadout(true); requestDraw(); });
  layButton.addEventListener('click', () => {
    const a = liveRuleStart(), b = rule?.b; if (!a || !b) return;
    const courseTrue = rhumbBearing(a.lat, a.lon, b.lat, b.lon), compassPoint = compassPointName(courseTrue);
    onSetCourse?.({ courseTrue, compassPoint, target: { lat: b.lat, lon: b.lon }, from: { lat: a.lat, lon: a.lon }, fromShip: !!rule.fromShip, distanceNm: rhumbDistanceNm(a.lat, a.lon, b.lat, b.lon) });
    rule = null; refreshReadout(); announce(`Course laid: ${chartCourseText(courseTrue)}.`); readoutText.textContent = `Course laid: ${chartCourseText(courseTrue)}`; requestDraw();
  });
  destButton.addEventListener('click', () => {
    const b = rule?.b; if (!b) return;
    const target = { lat: b.lat, lon: chartLonDelta(b.lon) };
    if (onSetDestination) onSetDestination(target);
    else {
      const dr = chartLL(snap.drPos), courseTrue = dr ? rhumbBearing(dr[0], dr[1], target.lat, target.lon) : NaN;
      onSetCourse?.({ courseTrue, compassPoint: Number.isFinite(courseTrue) ? compassPointName(courseTrue) : '', target, from: dr ? { lat: dr[0], lon: dr[1] } : null, fromShip: !!dr, distanceNm: dr ? rhumbDistanceNm(dr[0], dr[1], target.lat, target.lon) : NaN, setDestination: true });
    }
    rule = null; refreshReadout(); announce(`Destination set at ${formatLatLon(target.lat, target.lon)}.`); requestDraw();
  });

  // --- pointer input (mouse, pen and touch share one path) ---
  const local = (e) => { const r = canvas.getBoundingClientRect(); return { x: e.clientX - r.left, y: e.clientY - r.top }; };
  const toLL = (p) => { const q = chartUnproject(p.x, p.y, view); return { lat: chartClamp(q.lat, -89, 89), lon: q.lon }; };
  function pinchState() {
    const [a, b] = [...pointers.values()];
    return { dist: Math.hypot(b.x - a.x, b.y - a.y) || 1, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2 };
  }
  function shipAnchor(p) {
    const dr = chartLL(snap.drPos);
    if (dr) {
      // Snap to the ship when the drag starts on the DR mark or on the ship glyph drawn above it.
      const sp = P(dr[0], dr[1]);
      if (Math.hypot(sp.x - p.x, sp.y - p.y) < 22 || Math.hypot(sp.x - p.x, sp.y - 10 - p.y) < 18) return { ship: true, ll: { lat: dr[0], lon: dr[1] } };
    }
    return { ship: false, ll: toLL(p) };
  }
  canvas.addEventListener('pointerdown', (e) => {
    if (e.pointerType === 'mouse' && e.button > 2) return;
    canvas.focus({ preventScroll: true });
    canvas.setPointerCapture?.(e.pointerId);
    const p = local(e); pointers.set(e.pointerId, p); anim = null;
    if (pointers.size === 2) { pinch = pinchState(); drag = null; return; } // two fingers always pan and zoom
    if (pointers.size > 2) return;
    const kind = e.button === 1 || e.button === 2 || tool === 'pan' ? 'pan' : tool;
    drag = { kind, id: e.pointerId, x0: p.x, y0: p.y, lx: p.x, ly: p.y, moved: false, anchor: kind === 'rule' ? shipAnchor(p) : kind === 'dividers' ? { ll: toLL(p) } : null };
    if (kind === 'pan') stage.dataset.panning = 'true';
    e.preventDefault();
  });
  canvas.addEventListener('pointermove', (e) => {
    const p = local(e);
    if (e.pointerType !== 'touch') { hover = toLL(p); updateCursor(); }
    if (!pointers.has(e.pointerId)) return;
    pointers.set(e.pointerId, p);
    if (pinch && pointers.size >= 2) {
      const n = pinchState();
      panBy(n.mx - pinch.mx, n.my - pinch.my);
      zoomAt(n.mx, n.my, n.dist / pinch.dist);
      pinch = n; return;
    }
    if (!drag || drag.id !== e.pointerId) return;
    if (!drag.moved && Math.hypot(p.x - drag.x0, p.y - drag.y0) > 5) drag.moved = true;
    if (drag.kind === 'pan') panBy(p.x - drag.lx, p.y - drag.ly);
    else if (drag.moved && drag.kind === 'rule') { rule = { a: drag.anchor.ll, b: toLL(p), fromShip: drag.anchor.ship }; refreshReadout(); requestDraw(); }
    else if (drag.moved && drag.kind === 'dividers') { dividers = { a: drag.anchor.ll, b: toLL(p) }; refreshReadout(); requestDraw(); }
    drag.lx = p.x; drag.ly = p.y;
  });
  function endPointer(e, cancelled) {
    pointers.delete(e.pointerId);
    if (pinch && pointers.size < 2) { pinch = null; drag = null; }
    if (!drag || drag.id !== e.pointerId) return;
    const d = drag; drag = null; delete stage.dataset.panning;
    if (cancelled) return;
    const pt = toLL({ x: d.lx, y: d.ly });
    if (d.kind === 'rule') {
      if (!d.moved) { // a tap: run the rule from the ship to the tapped point
        const dr = chartLL(snap.drPos);
        rule = dr ? { a: { lat: dr[0], lon: dr[1] }, b: pt, fromShip: true } : { a: null, b: pt, fromShip: false };
      }
      refreshReadout(true); requestDraw();
    } else if (d.kind === 'dividers') {
      if (!d.moved) dividers = !dividers || dividers.b ? { a: pt, b: null } : { a: dividers.a, b: pt };
      refreshReadout(true); requestDraw();
    }
  }
  canvas.addEventListener('pointerup', (e) => endPointer(e, false));
  canvas.addEventListener('pointercancel', (e) => endPointer(e, true));
  canvas.addEventListener('pointerleave', () => { hover = null; updateCursor(); });
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    const unit = e.deltaMode === 1 ? 16 : e.deltaMode === 2 ? view.height : 1;
    const p = local(e);
    zoomAt(p.x, p.y, Math.exp(-e.deltaY * unit * (e.ctrlKey ? 0.01 : 0.0018)));
  }, { passive: false });

  // --- keyboard ---
  canvas.addEventListener('keydown', (e) => {
    const step = e.shiftKey ? 160 : 48;
    const keys = { ArrowLeft: () => panBy(step, 0), ArrowRight: () => panBy(-step, 0), ArrowUp: () => panBy(0, step), ArrowDown: () => panBy(0, -step),
      '+': () => zoomAt(view.width / 2, view.height / 2, 1.5), '=': () => zoomAt(view.width / 2, view.height / 2, 1.5),
      '-': () => zoomAt(view.width / 2, view.height / 2, 1 / 1.5), c: centreOnShip, C: centreOnShip };
    if (keys[e.key]) { keys[e.key](); e.preventDefault(); }
  });
  // Keys pressed inside the drawer must not reach the helm or camera shortcuts on window.
  root.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      if (drag || pinch) { drag = pinch = null; pointers.clear(); requestDraw(); }
      else { setOpen(false); button.focus({ preventScroll: true }); }
    }
    e.stopPropagation();
  });
  const onWindowKey = (e) => {
    if (e.key === 'Escape' && open && !root.contains(e.target)) { setOpen(false, { returnFocus: false }); button.focus({ preventScroll: true }); }
  };
  addEventListener('keydown', onWindowKey);

  // --- sizing (devicePixelRatio aware) ---
  const ro = typeof ResizeObserver === 'function' ? new ResizeObserver(() => {
    const rect = stage.getBoundingClientRect();
    const w = Math.round(rect.width), h = Math.round(rect.height);
    if (!w || !h) return;
    dpr = Math.min(2, window.devicePixelRatio || 1);
    view.width = w; view.height = h;
    canvas.width = base.width = Math.round(w * dpr);
    canvas.height = base.height = Math.round(h * dpr);
    baseKey = '';
    if (!viewReady) initView(); else clampView();
    requestDraw();
  }) : null;
  ro?.observe(stage);

  dock?.append(button);
  document.body.append(root);
  setTool('pan');

  function destroy() {
    setOpen(false, { returnFocus: false });
    ro?.disconnect(); removeEventListener('keydown', onWindowKey);
    button.remove(); root.remove();
  }

  return {
    root, button,
    open: openDrawer, close: closeDrawer, toggle: () => setOpen(!open),
    get isOpen() { return open; },
    update, destroy,
  };
}

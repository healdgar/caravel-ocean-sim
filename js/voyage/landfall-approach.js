// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Landfall approach for the Chart Course passage: when can land be seen from the masthead,
// how fast may the time warp run without sailing through a coast, and where should the
// coastal terrain pack be streamed so the "Land ho!" view is geographically accurate.
//
// Two land sources are combined:
// 1. A coarse coastline index built from Natural Earth rings (assets/world/land.json). It is
//    always available, cheap, and used for "is there any coast within a few hundred km?".
//    Small islands are missing from it, so it is never trusted on its own near land.
// 2. A DEM probe over AWS Terrarium elevation tiles (zoom 6 ≈ 2.4 km/px at the equator) that
//    sees islands, headlands and inland peaks, and so drives the actual sighting and the
//    warp governor once the ship is within the prefetch radius.

import { EARTH_RADIUS_M, greatCircleKm, initialBearing, offsetLatLon } from './ocean-climate.js';

const APPROACH_RAD = Math.PI / 180;
const approachClamp = (v, a, b) => Math.max(a, Math.min(b, v));
const approachWrapLon = (d) => ((((d + 180) % 360) + 360) % 360) - 180;

/** Standard terrestrial refraction coefficient used by navigators' distance-of-horizon tables. */
export const REFRACTION_K = 0.13;
export const effectiveEarthRadius = (k = REFRACTION_K) => EARTH_RADIUS_M / (1 - k);

/** Geometric+refracted distance (km) at which an object of height targetM tops the horizon. */
export function visibilityRangeKm(eyeM, targetM, k = REFRACTION_K) {
  const R = effectiveEarthRadius(k);
  return (Math.sqrt(2 * R * Math.max(0, eyeM)) + Math.sqrt(2 * R * Math.max(0, targetM))) / 1000;
}
/** How far (m) a point at distance distM sinks below the observer's tangent plane. */
export function curvatureDropM(distM, k = REFRACTION_K) {
  return (distM * distM) / (2 * effectiveEarthRadius(k));
}
/** Height (m) of a distant object still hidden below the horizon from eye height eyeM. */
export function hiddenHeightM(distM, eyeM, k = REFRACTION_K) {
  const R = effectiveEarthRadius(k);
  const horizon = Math.sqrt(2 * R * Math.max(0, eyeM));
  const beyond = Math.max(0, distM - horizon);
  return (beyond * beyond) / (2 * R);
}

/** Masthead lookout eye height (m) for the playable ship models. */
export function lookoutEyeHeight(modelId) {
  const table = { victory: 52, 'santa-maria': 24, nina: 19, pinta: 20, oseberg: 9, lusoria: 4, 'taino-canoe': 1.6, 'flying-cloud': 42, 'gipsy-moth-iv': 14 };
  return table[modelId] ?? 20;
}

// ---------------------------------------------------------------------------------------------
// Coarse coastline index (Natural Earth rings)
// ---------------------------------------------------------------------------------------------
const APPROACH_CELL_DEG = 2;
/**
 * Build a bucketed coastline index from rings of [lon, lat] points.
 * Returns { isLand(lat, lon), nearestCoast(lat, lon, maxKm) -> {distanceKm, lat, lon, bearing} | null }.
 */
export function createCoastlineIndex(rings) {
  const buckets = new Map();
  const ringBoxes = [];
  const key = (i, j) => `${i}|${j}`;
  rings.forEach((ring, r) => {
    let minLon = Infinity, maxLon = -Infinity, minLat = Infinity, maxLat = -Infinity;
    for (let p = 0; p < ring.length; p++) {
      const [lon, lat] = ring[p];
      minLon = Math.min(minLon, lon); maxLon = Math.max(maxLon, lon);
      minLat = Math.min(minLat, lat); maxLat = Math.max(maxLat, lat);
      const q = ring[(p + 1) % ring.length];
      // Register the segment in every bucket its bounding box touches.
      const i0 = Math.floor(Math.min(lon, q[0]) / APPROACH_CELL_DEG), i1 = Math.floor(Math.max(lon, q[0]) / APPROACH_CELL_DEG);
      const j0 = Math.floor(Math.min(lat, q[1]) / APPROACH_CELL_DEG), j1 = Math.floor(Math.max(lat, q[1]) / APPROACH_CELL_DEG);
      if (i1 - i0 > 90) continue; // antimeridian-spanning segment; ignore for proximity
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) {
        const k = key(i, j);
        if (!buckets.has(k)) buckets.set(k, []);
        buckets.get(k).push([lon, lat, q[0], q[1]]);
      }
    }
    ringBoxes.push({ r, minLon, maxLon, minLat, maxLat });
  });

  function isLand(lat, lon) {
    lon = approachWrapLon(lon);
    let inside = false;
    for (const box of ringBoxes) {
      if (lat < box.minLat || lat > box.maxLat || lon < box.minLon || lon > box.maxLon) continue;
      const ring = rings[box.r];
      let c = false;
      for (let a = 0, b = ring.length - 1; a < ring.length; b = a++) {
        const [xa, ya] = ring[a], [xb, yb] = ring[b];
        if ((ya > lat) !== (yb > lat) && lon < ((xb - xa) * (lat - ya)) / (yb - ya) + xa) c = !c;
      }
      if (c) inside = !inside;
    }
    return inside;
  }

  function nearestCoast(lat, lon, maxKm = 600) {
    lon = approachWrapLon(lon);
    const kx = 111.32 * Math.cos(lat * APPROACH_RAD), ky = 110.57;
    const reachLat = Math.ceil(maxKm / ky / APPROACH_CELL_DEG) + 1;
    const reachLon = Math.ceil(maxKm / Math.max(10, kx) / APPROACH_CELL_DEG) + 1;
    const ci = Math.floor(lon / APPROACH_CELL_DEG), cj = Math.floor(lat / APPROACH_CELL_DEG);
    let best = null, bestD = Infinity;
    const seen = new Set();
    for (let di = -reachLon; di <= reachLon; di++) for (let dj = -reachLat; dj <= reachLat; dj++) {
      const list = buckets.get(key(ci + di, cj + dj));
      if (!list) continue;
      for (const seg of list) {
        if (seen.has(seg)) continue;
        seen.add(seg);
        const ax = approachWrapLon(seg[0] - lon) * kx, ay = (seg[1] - lat) * ky;
        const bx = approachWrapLon(seg[2] - lon) * kx, by = (seg[3] - lat) * ky;
        const vx = bx - ax, vy = by - ay, len2 = vx * vx + vy * vy || 1e-9;
        const t = approachClamp(-(ax * vx + ay * vy) / len2, 0, 1);
        const px = ax + vx * t, py = ay + vy * t, d = Math.hypot(px, py);
        if (d < bestD) { bestD = d; best = { x: px, y: py }; }
      }
    }
    if (!best || bestD > maxKm) return null;
    const cLat = lat + best.y / ky, cLon = approachWrapLon(lon + best.x / kx);
    return { distanceKm: bestD, lat: cLat, lon: cLon, bearing: initialBearing(lat, lon, cLat, cLon) };
  }
  return { isLand, nearestCoast, ringCount: rings.length };
}

// ---------------------------------------------------------------------------------------------
// DEM probe (AWS Terrarium tiles)
// ---------------------------------------------------------------------------------------------
export const DEM_PROBE_ZOOM = 6;
const APPROACH_TILE = 256;
export function lonLatToTile(lat, lon, z) {
  const n = 2 ** z;
  const r = approachClamp(lat, -85, 85) * APPROACH_RAD;
  return { x: ((approachWrapLon(lon) + 180) / 360) * n, y: ((1 - Math.log(Math.tan(r) + 1 / Math.cos(r)) / Math.PI) / 2) * n };
}
export function tileToLonLat(x, y, z) {
  const n = 2 ** z;
  const lon = (x / n) * 360 - 180;
  const lat = Math.atan(Math.sinh(Math.PI * (1 - (2 * y) / n))) / APPROACH_RAD;
  return { lat, lon };
}
export function decodeTerrariumRGBA(rgba) {
  const out = new Float32Array(rgba.length / 4);
  for (let i = 0, k = 0; k < out.length; i += 4, k++) out[k] = rgba[i] * 256 + rgba[i + 1] + rgba[i + 2] / 256 - 32768;
  return out;
}
/** Browser tile loader: fetch a Terrarium PNG and decode it to a Float32Array of metres. */
export async function fetchTerrariumTile(z, x, y, fetchImpl = typeof fetch === 'function' ? fetch : null) {
  if (!fetchImpl || typeof createImageBitmap !== 'function') return null;
  const res = await fetchImpl(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${x}/${y}.png`, { mode: 'cors' });
  if (!res?.ok) return null;
  const bmp = await createImageBitmap(await res.blob(), { premultiplyAlpha: 'none', colorSpaceConversion: 'none' });
  const canvas = typeof OffscreenCanvas === 'function' ? new OffscreenCanvas(APPROACH_TILE, APPROACH_TILE) : Object.assign(document.createElement('canvas'), { width: APPROACH_TILE, height: APPROACH_TILE });
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  ctx.drawImage(bmp, 0, 0);
  bmp.close?.();
  return decodeTerrariumRGBA(ctx.getImageData(0, 0, APPROACH_TILE, APPROACH_TILE).data);
}

/**
 * Cached DEM probe. `loadTile(z, x, y)` resolves to Float32Array(256*256) metres or null.
 * Lookups are synchronous against already-loaded tiles; `prefetch` schedules loads.
 */
export function createDemProbe({ loadTile = fetchTerrariumTile, zoom = DEM_PROBE_ZOOM, maxTiles = 48 } = {}) {
  const tiles = new Map(); // key -> { data | null, promise, used }
  let tick = 0;
  const n = 2 ** zoom;
  const tileKey = (x, y) => `${x}/${y}`;
  function request(x, y) {
    x = ((x % n) + n) % n;
    if (y < 0 || y >= n) return null;
    const k = tileKey(x, y);
    let t = tiles.get(k);
    if (!t) {
      t = { data: undefined, used: ++tick, promise: null };
      t.promise = Promise.resolve()
        .then(() => loadTile(zoom, x, y))
        .then((d) => { t.data = d || null; return t.data; })
        .catch(() => { t.data = null; return null; });
      tiles.set(k, t);
      if (tiles.size > maxTiles) {
        let oldest = null;
        for (const [kk, v] of tiles) if (v.data !== undefined && (!oldest || v.used < oldest[1].used)) oldest = [kk, v];
        if (oldest) tiles.delete(oldest[0]);
      }
    }
    t.used = ++tick;
    return t;
  }
  /** Elevation (m) or undefined if the covering tile is not loaded yet. */
  function elevation(lat, lon) {
    const p = lonLatToTile(lat, lon, zoom);
    const tx = Math.floor(p.x), ty = Math.floor(p.y);
    const t = tiles.get(tileKey(((tx % n) + n) % n, ty));
    if (!t || t.data === undefined) return undefined;
    if (t.data === null) return -1000; // unavailable tile: treat as open sea
    t.used = ++tick;
    const px = approachClamp(Math.floor((p.x - tx) * APPROACH_TILE), 0, APPROACH_TILE - 1), py = approachClamp(Math.floor((p.y - ty) * APPROACH_TILE), 0, APPROACH_TILE - 1);
    return t.data[py * APPROACH_TILE + px];
  }
  /** Request every tile covering a circle of radiusKm around the point. Returns a promise. */
  function prefetch(lat, lon, radiusKm) {
    const dLat = radiusKm / 110.57, dLon = radiusKm / Math.max(5, 111.32 * Math.cos(lat * APPROACH_RAD));
    const a = lonLatToTile(lat + dLat, lon - dLon, zoom), b = lonLatToTile(lat - dLat, lon + dLon, zoom);
    const ps = [];
    for (let x = Math.floor(a.x); x <= Math.floor(b.x); x++) for (let y = Math.floor(a.y); y <= Math.floor(b.y); y++) {
      const t = request(x, y);
      if (t) ps.push(t.promise);
    }
    return Promise.all(ps);
  }
  function coverage(lat, lon, radiusKm) {
    const dLat = radiusKm / 110.57, dLon = radiusKm / Math.max(5, 111.32 * Math.cos(lat * APPROACH_RAD));
    const a = lonLatToTile(lat + dLat, lon - dLon, zoom), b = lonLatToTile(lat - dLat, lon + dLon, zoom);
    let total = 0, ready = 0;
    for (let x = Math.floor(a.x); x <= Math.floor(b.x); x++) for (let y = Math.floor(a.y); y <= Math.floor(b.y); y++) {
      if (y < 0 || y >= n) continue;
      total++;
      const t = tiles.get(tileKey(((x % n) + n) % n, y));
      if (t && t.data !== undefined) ready++;
    }
    return total ? ready / total : 1;
  }
  return { elevation, prefetch, coverage, zoom, get tileCount() { return tiles.size; } };
}

/**
 * Scan the DEM around the ship for land that is (a) above the masthead horizon, and (b) the
 * nearest land at all. Samples on polar rings so cost stays ~2–3k lookups.
 * Returns { visible: {lat, lon, elevation, distanceKm, bearing} | null,
 *           nearest: {lat, lon, distanceKm, bearing} | null, complete: boolean }.
 */
export function scanForLand(probe, lat, lon, { eyeM = 20, maxKm = 160, ringStepKm = 3, bearings = 72, headingDeg = null, forwardHalfAngle = 55 } = {}) {
  let visible = null, nearest = null, highest = null, complete = true;
  let forwardVisible = null, forwardNearest = null, forwardHighest = null;
  const hasHeading = Number.isFinite(headingDeg);
  for (let d = ringStepKm; d <= maxKm; d += ringStepKm * (d < 40 ? 1 : 1.5)) {
    const nb = Math.max(24, Math.round(bearings * Math.min(2, d / 40)));
    for (let b = 0; b < nb; b++) {
      const brg = (b / nb) * 360;
      const p = destinationPoint(lat, lon, brg, d);
      const h = probe.elevation(p.lat, p.lon);
      if (h === undefined) { complete = false; continue; }
      if (h <= 0.5) continue;
      const inForward = hasHeading && Math.abs((((brg - headingDeg + 540) % 360) - 180)) <= forwardHalfAngle;
      if (!nearest) nearest = { lat: p.lat, lon: p.lon, distanceKm: d, bearing: brg };
      if (inForward && !forwardNearest) forwardNearest = { lat: p.lat, lon: p.lon, distanceKm: d, bearing: brg };
      // Land that will top the horizon soonest relative to its distance (prominence ratio).
      const rise = visibilityRangeKm(eyeM, h) - d;
      if (!highest || rise > highest.rise) highest = { lat: p.lat, lon: p.lon, elevation: h, distanceKm: d, bearing: brg, rise };
      if (inForward && (!forwardHighest || rise > forwardHighest.rise)) {
        forwardHighest = { lat: p.lat, lon: p.lon, elevation: h, distanceKm: d, bearing: brg, rise };
      }
      // Above the horizon by a margin that a lookout could make out (≥ 4 m of land showing).
      const showing = h - hiddenHeightM(d * 1000, eyeM);
      if (showing >= 4 && (!visible || showing / d > visible.showing / visible.distanceKm)) {
        visible = { lat: p.lat, lon: p.lon, elevation: h, distanceKm: d, bearing: brg, showing };
      }
      if (inForward && showing >= 4 && (!forwardVisible || showing / d > forwardVisible.showing / forwardVisible.distanceKm)) {
        forwardVisible = { lat: p.lat, lon: p.lon, elevation: h, distanceKm: d, bearing: brg, showing };
      }
    }
    // Once we have the nearest coast and are well beyond any possible visibility, stop early.
    if (nearest && d > nearest.distanceKm + 40 && (visible || d > visibilityRangeKm(eyeM, 3000))) break;
  }
  return { visible, nearest, highest, forwardVisible, forwardNearest, forwardHighest, complete };
}

/**
 * Walk from a visible landmark back toward the ship along the bearing and return the first
 * coastline crossing (where elevation drops to sea level). This is where the coastal terrain
 * pack should be centred so the sighted land and its shore are inside the streamed region.
 */
export function coastlineToward(probe, shipLat, shipLon, target, stepKm = 1.2) {
  const dist = greatCircleKm(shipLat, shipLon, target.lat, target.lon);
  const brg = initialBearing(shipLat, shipLon, target.lat, target.lon);
  let last = { lat: shipLat, lon: shipLon };
  for (let d = 0; d <= dist; d += stepKm) {
    const p = destinationPoint(shipLat, shipLon, brg, d);
    const h = probe.elevation(p.lat, p.lon);
    if (h !== undefined && h > 0.5) return { lat: last.lat, lon: last.lon, distanceKm: Math.max(0, d - stepKm), bearing: brg };
    last = p;
  }
  return { lat: target.lat, lon: target.lon, distanceKm: dist, bearing: brg };
}

export function destinationPoint(lat, lon, bearingDeg, distKm) {
  const d = (distKm * 1000) / EARTH_RADIUS_M, b = bearingDeg * APPROACH_RAD, p1 = lat * APPROACH_RAD, l1 = lon * APPROACH_RAD;
  const p2 = Math.asin(Math.sin(p1) * Math.cos(d) + Math.cos(p1) * Math.sin(d) * Math.cos(b));
  const l2 = l1 + Math.atan2(Math.sin(b) * Math.sin(d) * Math.cos(p1), Math.cos(d) - Math.sin(p1) * Math.sin(p2));
  return { lat: p2 / APPROACH_RAD, lon: approachWrapLon(l2 / APPROACH_RAD) };
}

// ---------------------------------------------------------------------------------------------
// Approach staging & warp governor
// ---------------------------------------------------------------------------------------------
/**
 * Approach stage from distances (km):
 *  'open'      – no land within the prefetch radius.
 *  'prefetch'  – land within ~250 km: load DEM tiles around the ship.
 *  'preload'   – land expected to rise above the horizon within ~60 km of further sailing:
 *                build the coastal terrain pack at the predicted landfall point.
 *  'sighting'  – the lookout can see land: warp drops to watch/real time.
 *  'inshore'   – inside the streamed coastal pack.
 */
export function approachStage({ coastKm = Infinity, sightKm = 40, visible = false, inPack = false } = {}) {
  if (inPack) return 'inshore';
  if (visible) return 'sighting';
  if (coastKm <= sightKm + 60) return 'preload';
  if (coastKm <= 250) return 'prefetch';
  return 'open';
}

/**
 * Highest warp rate that still leaves at least `leadSeconds` of real time to stream terrain and
 * call the sighting before land rises above the horizon. `groundSpeed` in m/s.
 */
export function approachWarpCap({ coastKm = Infinity, sightKm = 40, groundSpeed = 3, leadSeconds = 25, stage = 'open', demComplete = true } = {}) {
  if (stage === 'inshore') return 1;
  if (stage === 'sighting') return 30;
  const speed = Math.max(0.5, groundSpeed);
  // Unknown DEM coverage near land: be conservative so a missing island can't be skipped.
  const margin = demComplete ? 8 : 25;
  const remaining = Math.max(0, (coastKm - sightKm - margin) * 1000);
  return approachClamp(remaining / (speed * leadSeconds), 30, 3600);
}

/**
 * Local placement for a coastal region centred at (regionLat, regionLon) relative to a ship that
 * is at local world (shipX, shipZ) and geographic (shipLat, shipLon). World X = east, Z = south.
 */
export function regionLocalOrigin({ shipLat, shipLon, shipX = 0, shipZ = 0, regionLat, regionLon }) {
  const dLat = regionLat - shipLat, dLon = approachWrapLon(regionLon - shipLon);
  const mid = (regionLat + shipLat) / 2;
  const east = dLon * APPROACH_RAD * EARTH_RADIUS_M * Math.cos(mid * APPROACH_RAD);
  const north = dLat * APPROACH_RAD * EARTH_RADIUS_M;
  return { x: shipX + east, z: shipZ - north, east, north };
}

/** Nearest landfall point for "Land ho!" calls, re-exported for convenience. */
export { offsetLatLon } from './ocean-climate.js';

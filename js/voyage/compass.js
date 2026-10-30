// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Boxing the compass: the 32 points used by 16th-century pilots, plus lookout call phrasing.

const wrap360 = (d) => ((d % 360) + 360) % 360;

/** The 32 points of the mariner's compass, clockwise from north (11.25° apart). */
export const COMPASS_POINTS_32 = Object.freeze([
  'N', 'N by E', 'NNE', 'NE by N', 'NE', 'NE by E', 'ENE', 'E by N',
  'E', 'E by S', 'ESE', 'SE by E', 'SE', 'SE by S', 'SSE', 'S by E',
  'S', 'S by W', 'SSW', 'SW by S', 'SW', 'SW by W', 'WSW', 'W by S',
  'W', 'W by N', 'WNW', 'NW by W', 'NW', 'NW by N', 'NNW', 'N by W',
]);

export function compassPointIndex(deg) {
  return Math.round(wrap360(deg) / 11.25) % 32;
}
export function compassPointName(deg) {
  return COMPASS_POINTS_32[compassPointIndex(deg)];
}
export function compassPointBearing(index) {
  return wrap360(index * 11.25);
}
/** Spoken form for log entries: "SW by W" -> "south-west by west". */
export function compassPointWords(deg) {
  const words = { N: 'north', E: 'east', S: 'south', W: 'west' };
  const name = compassPointName(deg);
  return name
    .split(' by ')
    .map((part) => {
      if (part.length === 3) return `${words[part[0]]}-${words[part[1]]}${words[part[2]]}`;
      if (part.length === 2) return `${words[part[0]]}-${words[part[1]]}`;
      return words[part];
    })
    .join(' by ');
}

const POINT_WORDS = ['', 'a point', 'two points', 'three points', 'four points', 'five points', 'six points', 'seven points'];
/**
 * Lookout call for an object at a bearing relative to the bow (deg, + = starboard).
 * e.g. 22.5 -> "two points off the starboard bow", -90 -> "on the larboard beam".
 */
export function relativeBearingCall(relDeg) {
  let r = ((relDeg + 540) % 360) - 180;
  const side = r >= 0 ? 'starboard' : 'larboard';
  const p = Math.round(Math.abs(r) / 11.25);
  if (p === 0) return 'dead ahead';
  if (p === 16) return 'right astern';
  if (p < 4) return `${POINT_WORDS[p]} off the ${side} bow`;
  if (p === 4) return `broad on the ${side} bow`;
  if (p < 8) return `${POINT_WORDS[8 - p]} forward of the ${side} beam`;
  if (p === 8) return `on the ${side} beam`;
  if (p < 12) return `${POINT_WORDS[p - 8]} abaft the ${side} beam`;
  if (p === 12) return `broad on the ${side} quarter`;
  return `${POINT_WORDS[16 - p]} off the ${side} quarter`;
}

/** Degrees and minutes for latitude/longitude display: 21.667 -> "21° 40′ N". */
export function formatLatitude(lat) {
  const a = Math.abs(lat);
  let d = Math.floor(a), m = Math.round((a - d) * 60);
  if (m === 60) { d += 1; m = 0; }
  return `${d}° ${String(m).padStart(2, '0')}′ ${lat >= 0 ? 'N' : 'S'}`;
}
export function formatLongitude(lon) {
  const a = Math.abs(lon);
  let d = Math.floor(a), m = Math.round((a - d) * 60);
  if (m === 60) { d += 1; m = 0; }
  return `${d}° ${String(m).padStart(2, '0')}′ ${lon >= 0 ? 'E' : 'W'}`;
}

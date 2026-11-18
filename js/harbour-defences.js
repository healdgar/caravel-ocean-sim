// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// What a port takes from the record of its harbour: where on the real globe a place of the record stands in the
// region's frame, a channel the elevation data lost, and which way the nearest water lies from a spot. Its forts,
// batteries and watchtowers are its board's (scripts/board-forts.mjs, js/old-world-board.js). See FORTS.md.

const METRES_PER_DEGREE = 111195;
const SHORE_RAYS = 24;
const SHORE_SEARCH_M = 700;

// A place on the real globe as a place in this region's frame: x east, z south.
export function worldOfPosition(region, latitude, longitude) {
  const cosLat = Math.max(0.1, Math.cos((region.latitude * Math.PI) / 180));
  return { x: region.x + (longitude - region.longitude) * METRES_PER_DEGREE * cosLat, z: region.z - (latitude - region.latitude) * METRES_PER_DEGREE };
}

// Open a channel the elevation data has lost: it reads the water as low ground, so a bay would have no way in.
export function carveRecordedChannel(heights, region, channel) {
  if (!channel) return 0;
  const n = region.size, span = region.span, step = span / (n - 1), half = channel.width * 0.5, feather = Math.max(step * 1.5, 30), depth = 7;
  const line = channel.line.map(([lat, lon]) => worldOfPosition(region, lat, lon));
  let carved = 0;
  for (let j = 0; j < n; j++) {
    const z = region.z + (j / (n - 1) - 0.5) * span;
    for (let i = 0; i < n; i++) {
      const x = region.x + (i / (n - 1) - 0.5) * span;
      let nearest = Infinity;
      for (let s = 0; s + 1 < line.length; s++) {
        const a = line[s], b = line[s + 1], dx = b.x - a.x, dz = b.z - a.z, t = Math.max(0, Math.min(1, ((x - a.x) * dx + (z - a.z) * dz) / (dx * dx + dz * dz || 1)));
        nearest = Math.min(nearest, Math.hypot(a.x + dx * t - x, a.z + dz * t - z));
      }
      if (nearest >= half + feather) continue;
      const k = j * n + i, weight = nearest <= half ? 1 : 1 - (nearest - half) / feather;
      // The banks come down to the water. High ground either side of the line is left alone by the feather.
      const target = weight >= 1 ? -depth : Math.min(heights[k], heights[k] * (1 - weight) + -depth * weight);
      if (target < heights[k]) { heights[k] = target; carved++; }
    }
  }
  return carved;
}

// The direction of the nearest water, read round a spot: what a wall on this shore looks out on.
export function shoreNormal(harbour, x, z) {
  const { grid } = harbour;
  let sumX = 0, sumZ = 0;
  for (let r = 0; r < SHORE_RAYS; r++) {
    const angle = (r / SHORE_RAYS) * Math.PI * 2, dx = Math.cos(angle), dz = Math.sin(angle);
    for (let d = grid.cell; d <= SHORE_SEARCH_M; d += grid.cell) {
      const k = grid.at(x + dx * d, z + dz * d);
      if (k >= 0 && grid.ground[k] >= 0) continue;
      const pull = 1 / (d * d);
      sumX += dx * pull;
      sumZ += dz * pull;
      break;
    }
  }
  const length = Math.hypot(sumX, sumZ);
  return length ? { x: sumX / length, z: sumZ / length } : null;
}

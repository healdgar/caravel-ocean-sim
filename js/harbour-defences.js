// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Which forts a harbour has in a given year, where each stands, which way it looks and what shape the ground gives it.
// The record says what stood and where, when there is a record and the coast is the real one. Otherwise the geography
// says where the same job is. Worked out once when a port is laid out. See FORTS.md.
import { HARBOUR_GUN_RANGE_M, bestGroundNear, commandFrom, waterRound } from './harbour-geography.js';
import { drawFortTrace } from './fort-plan.js';
import { fortRecordsFor } from './fort-records.js';

const METRES_PER_DEGREE = 111195;
const CHART_MARGIN_M = 180;
// A fort off the chart stands in for its place only if it is near enough to be part of this harbour's defences.
const OFF_CHART_ANY_M = 6500;
const OFF_CHART_APPROACH_M = 20000;
const APPROACH_ROLES = new Set(['mouth', 'narrows', 'river']);
const FORTS_MOST = 5;
const FORT_APART_M = 150;
const SIDE_WAYS = Object.freeze({ north: [0, -1], south: [0, 1], east: [1, 0], west: [-1, 0], northeast: [0.7, -0.7], northwest: [-0.7, -0.7], southeast: [0.7, 0.7], southwest: [-0.7, 0.7] });
const HEIGHT_OF_SHAPE = Object.freeze({ battery: 4.4, drum: 7.4, star: 8.4, headland: 9.8, islet: 6.6, fitted: 8.6 });
const PREFAB_OF_SHAPE = Object.freeze({ battery: 'stone_sea_bastion', drum: 'stone_sea_bastion', star: 'bastion_trace_fortress', headland: 'bastion_trace_fortress', islet: 'bastion_trace_fortress', fitted: 'bastion_trace_fortress' });
const GROUND_FOR_WALL_M = 0.45;
const SHORE_RAYS = 24;
const SHORE_SEARCH_M = 700;

const RULE_NAMES = Object.freeze({
  spain: ['Batería del Puerto', 'Fuerte de la Entrada', 'Castillo del Puerto'],
  portugal: ['Baluarte da Ribeira', 'Forte da Barra', 'Fortaleza do Porto'],
  england: ['Harbour Battery', 'Harbour Crossfire Timber Battery', 'Harbour Fort'],
  france: ['Batterie du Port', 'Fort de la Passe', 'Fort du Port'],
  netherlands: ['Havenbatterij', 'Fort aan de Haven', 'Fort aan de Haven'],
});

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

function rankWays(side) { return side ? (SIDE_WAYS[side] ?? null) : null; }

// Which hand of the way out a compass side is on, at a narrow place.
function handOfSide(place, way) {
  if (!way || !place.left || !place.right) return null;
  const left = (place.left.x - place.x) * way[0] + (place.left.z - place.z) * way[1];
  const right = (place.right.x - place.x) * way[0] + (place.right.z - place.z) * way[1];
  return left >= right ? -1 : 1;
}

function shoreOf(place, hand) { return hand < 0 ? place.left : place.right; }

function nearerHand(place, town) {
  return Math.hypot(place.left.x - town.x, place.left.z - town.z) <= Math.hypot(place.right.x - town.x, place.right.z - town.z) ? -1 : 1;
}

const sideLine = (place, hand) => ({ x: place.x, z: place.z, ux: place.ux, uz: place.uz, hand });

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

// Which job a fort does on this coast and the ground for it, when the record cannot say exactly.
function groundForRole(harbour, role, side, taken, region) {
  const { mouth, narrows, anchorage, townWater, opening, route, town } = harbour;
  const way = rankWays(side);
  const options = { taken, apart: FORT_APART_M };
  const onShore = (place) => {
    const hand = handOfSide(place, way) ?? nearerHand(place, town);
    for (const trying of [hand, -hand]) {
      if (taken.some((spot) => spot.place === place && spot.hand === trying)) continue;
      const near = shoreOf(place, trying);
      const spot = bestGroundNear(harbour, near, { ...options, reach: 620, side: sideLine(place, trying), commandWeight: 1, nearWeight: 0.8, pointWeight: 0.3 });
      if (spot) return { ...spot, place, hand: trying };
    }
    return null;
  };
  if (role === 'mouth' && mouth) return onShore(mouth);
  if (role === 'narrows' && narrows.length) return onShore(narrows[0]);
  if (role === 'mouth' || role === 'narrows' || role === 'river' || role === 'headland') {
    // Along the way out, on a bank the record names if it names one: the first land that commands the water there.
    const reachOut = role === 'river' ? 1500 : 2500;
    const along = opening && role !== 'river' ? opening : route.find((p) => p.s >= reachOut) ?? anchorage;
    const near = { ...options, commandWeight: 1, pointWeight: 0.6, nearWeight: 0.2, apart: 240 };
    return bestGroundNear(harbour, along, { ...near, reach: 1500 }) ?? bestGroundNear(harbour, anchorage, { ...near, reach: 2600 });
  }
  if (role === 'island') return bestGroundNear(harbour, anchorage, { ...options, reach: 2200, commandWeight: 1, pointWeight: 0.9, nearWeight: 0.2, apart: 240 });
  // A citadel holds the town from behind it, on the rising ground.
  if (role === 'citadel') return bestGroundNear(harbour, town, { ...options, reach: 900, leastFromWater: 130, furthestFromWater: 800, highest: 120, commandWeight: 0, pointWeight: 0, nearWeight: 0.4, mostRise: 16 });
  return bestGroundNear(harbour, townWater ?? anchorage, { ...options, reach: 1000, apart: 200, commandWeight: 1, pointWeight: 0.4, nearWeight: 0.7 });
}

// The hand of the way out that a compass side lies on, as a line a fort must stand beyond.
function sideOfWay(harbour, near, way) {
  const { route } = harbour, index = Math.max(0, route.findIndex((p) => p === near));
  const a = route[Math.max(0, index - 4)], b = route[Math.min(route.length - 1, index + 4)], length = Math.hypot(b.x - a.x, b.z - a.z) || 1;
  const ux = (b.x - a.x) / length, uz = (b.z - a.z) / length;
  return { x: near.x, z: near.z, ux, uz, hand: -uz * way[0] + ux * way[1] >= 0 ? 1 : -1 };
}

// A place that is off the chart stands on its bank, as far along towards the truth as the chart goes.
function pulledIntoChart(region, at) {
  const dx = at.x - region.x, dz = at.z - region.z, limit = region.span * 0.5 - 500, over = Math.max(Math.abs(dx), Math.abs(dz)) / limit;
  return over <= 1 ? at : { x: region.x + dx / over, z: region.z + dz / over };
}

function siteRecordedFort(harbour, record, region, coastIsReal, taken) {
  const options = { taken, apart: FORT_APART_M };
  if (coastIsReal) {
    const at = worldOfPosition(region, record.lat, record.lon);
    const off = Math.max(Math.abs(at.x - region.x), Math.abs(at.z - region.z));
    const inChart = off <= region.span * 0.5 - CHART_MARGIN_M;
    const citadel = record.role === 'citadel';
    if (inChart) {
      const spot = bestGroundNear(harbour, at, {
        ...options, reach: record.rough ? 480 : 300, furthestFromWater: citadel ? 1500 : record.rough ? 170 : 300, highest: citadel ? 180 : 110,
        commandWeight: citadel ? 0 : record.rough ? 0.8 : 0.35, nearWeight: record.rough ? 0.8 : 1.5, pointWeight: 0.15, mostRise: 16,
      });
      if (spot) return { ...spot, source: 'record' };
    } else {
      const distance = Math.hypot(at.x - region.x, at.z - region.z);
      if (citadel || distance > (APPROACH_ROLES.has(record.role) ? OFF_CHART_APPROACH_M : OFF_CHART_ANY_M)) return null;
      const stand = pulledIntoChart(region, at);
      // A work that held the way in holds it here, as near the way out of the chart as there is ground that sees it.
      let near = stand;
      if (APPROACH_ROLES.has(record.role) && harbour.route.length) {
        let best = Infinity;
        for (const point of harbour.route) {
          const d = Math.hypot(point.x - stand.x, point.z - stand.z);
          if (d < best) { best = d; near = point; }
        }
      }
      const way = rankWays(record.side);
      const side = way && harbour.route.length ? sideOfWay(harbour, near, way) : null;
      const spot = bestGroundNear(harbour, near, { ...options, reach: 1600, side, commandWeight: 1.2, nearWeight: 0.5, pointWeight: 0.5 })
        ?? bestGroundNear(harbour, near, { ...options, reach: 1600, commandWeight: 1.2, nearWeight: 0.5, pointWeight: 0.5 });
      if (spot) return { ...spot, source: 'moved' };
    }
  }
  const spot = groundForRole(harbour, record.role, record.side, taken, region);
  return spot ? { ...spot, source: coastIsReal ? 'moved' : 'role' } : null;
}

// Where forts go by the rule alone, best first.
function ruleSites(harbour, count, taken) {
  const { mouth, narrows, anchorage, townWater, opening, town, kind } = harbour;
  const sites = [], options = () => ({ taken: [...taken, ...sites], apart: FORT_APART_M });
  const push = (spot, what) => { if (spot) sites.push({ ...spot, what }); };
  if (mouth && mouth.left && mouth.right) {
    const hand = nearerHand(mouth, town);
    for (const trying of [hand, -hand]) {
      if (sites.length >= count) break;
      push(bestGroundNear(harbour, shoreOf(mouth, trying), { ...options(), reach: 620, side: sideLine(mouth, trying), commandWeight: 1, nearWeight: 0.8, pointWeight: 0.3 }), 'mouth');
    }
  } else if (opening) {
    push(bestGroundNear(harbour, opening, { ...options(), reach: 1100, commandWeight: 1, pointWeight: 0.7, nearWeight: 0.4 }), 'opening');
  }
  if (sites.length < count && narrows.length > 1) push(bestGroundNear(harbour, shoreOf(narrows[0], nearerHand(narrows[0], town)), { ...options(), reach: 620, commandWeight: 1, nearWeight: 0.8 }), 'narrows');
  // The water off the town itself: the nearest point of land that sees the anchorage.
  while (sites.length < count) {
    const before = sites.length;
    push(bestGroundNear(harbour, townWater ?? anchorage, { ...options(), reach: 1300, apart: 260, commandWeight: 1, pointWeight: 0.6, nearWeight: 0.55 }), kind === 'river' ? 'river' : 'anchorage');
    if (sites.length === before) break;
  }
  return sites;
}

// A town's first work is a battery at the water. A second, once it can pay for one, is drawn to its ground.
function ruleShape(harbour, spot, index) {
  if (index === 0) return 'battery';
  const pointed = waterRound(harbour.grid, spot.x, spot.z, 110);
  return pointed >= 0.55 ? 'headland' : pointed >= 0.42 ? 'fitted' : index === 1 ? 'star' : 'battery';
}

const describeGuard = (harbour, role, what) => {
  const widthOf = (place) => (place ? ` ${Math.round(place.width / 10) * 10} m wide` : '');
  if (what === 'mouth' || role === 'mouth') return `the mouth${widthOf(harbour.mouth)}`;
  if (what === 'narrows' || role === 'narrows') return `the narrows${widthOf(harbour.narrows[0])}`;
  if (what === 'opening') return 'the opening of the anchorage';
  if (role === 'river' || what === 'river') return 'the river reach';
  if (role === 'headland') return 'the approach, from a point';
  if (role === 'island') return 'the anchorage, from an islet';
  if (role === 'citadel') return 'the town';
  return 'the anchorage off the town';
};

/**
 * Draw one fort at its site: which way it looks, the line of its walls, and where that puts it. fits(x, z, yaw, width,
 * length) says whether the footprint is clear of what stands there. Returns what an instance needs, or null.
 */
export function drawFortAt(harbour, spot, { shape, sizeM = null, bastions = 4, earth = false, terraces = false, groundAt, fits, town }) {
  const { grid } = harbour;
  const command = commandFrom(harbour, spot.x, spot.z);
  const shore = shoreNormal(harbour, spot.x, spot.z);
  // A battery lies along its shore. Anything else squares up to the water it holds.
  let faceX = command.faceX, faceZ = command.faceZ;
  if (shape === 'battery' && shore) { faceX = shore.x; faceZ = shore.z; }
  if (!faceX && !faceZ) {
    // Nothing it guards is in range, as with a record's fort far along the shore: it looks the way ships come from.
    let nearest = Infinity, mark = harbour.townWater ?? harbour.anchorage;
    for (const target of harbour.targets) {
      const d = Math.hypot(target.x - spot.x, target.z - spot.z);
      if (d < nearest) { nearest = d; mark = target; }
    }
    faceX = (mark?.x ?? spot.x + 1) - spot.x;
    faceZ = (mark?.z ?? spot.z) - spot.z;
  }
  const length = Math.hypot(faceX, faceZ) || 1;
  faceX /= length; faceZ /= length;
  const yaw = Math.atan2(-faceX, -faceZ), cos = Math.cos(yaw), sin = Math.sin(yaw);
  const worldX = (lx, lz) => spot.x + lx * cos + lz * sin, worldZ = (lx, lz) => spot.z - lx * sin + lz * cos;
  const landAt = (lx, lz) => groundAt(worldX(lx, lz), worldZ(lx, lz)) >= GROUND_FOR_WALL_M;
  const openAt = (lx, lz, nx, nz) => {
    const wx = worldX(lx, lz), wz = worldZ(lx, lz), dx = nx * cos + nz * sin, dz = -nx * sin + nz * cos;
    let wet = 0, tried = 0;
    for (let d = 24; d <= 360; d += 24) {
      tried++;
      const k = grid.at(wx + dx * d, wz + dz * d);
      if (k < 0 || grid.ground[k] < 0) wet++;
      else if (grid.ground[k] > 6 && d > 48) break;
    }
    return wet / tried;
  };
  // The gate looks away from the water and towards the town.
  const toTownX = town.x - spot.x, toTownZ = town.z - spot.z, townLength = Math.hypot(toTownX, toTownZ) || 1;
  const wantX = -faceX + (toTownX / townLength) * 0.9, wantZ = -faceZ + (toTownZ / townLength) * 0.9;
  const gateToward = [wantX * cos - wantZ * sin, wantX * sin + wantZ * cos];
  const trial = (scale, drawnShape) => drawFortTrace({
    shape: drawnShape, sizeM: sizeM ? [sizeM[0] * scale, sizeM[1] * scale] : scale < 1 ? [60 * scale, 60 * scale] : null, bastions, landAt, openAt, gateToward, earth, terraces,
  });
  for (const [scale, drawnShape] of [[1, shape], [0.85, shape], [0.7, shape], [0.8, shape === 'star' ? 'fitted' : shape], [0.6, shape === 'star' ? 'fitted' : shape]]) {
    const drawn = trial(scale, drawnShape);
    const x = worldX(drawn.offsetX, drawn.offsetZ), z = worldZ(drawn.offsetX, drawn.offsetZ);
    const outline = drawn.trace.outline;
    const landWalls = outline.filter(([lx, lz]) => groundAt(x + lx * cos + lz * sin, z - lx * sin + lz * cos) >= GROUND_FOR_WALL_M).length;
    // Half its walls on the land at least, or it is not a fort but a wreck. A drum or a battery may stand with its feet in the water.
    if (landWalls < outline.length * (drawnShape === 'battery' || drawnShape === 'drum' || drawnShape === 'islet' ? 0.34 : 0.55)) continue;
    if (!fits(x, z, yaw, drawn.width, drawn.length)) continue;
    const heights = outline.map(([lx, lz]) => groundAt(x + lx * cos + lz * sin, z - lx * sin + lz * cos)).sort((a, b) => a - b);
    const level = Math.max(1.6, heights[Math.floor(heights.length * 0.6)]), lowest = Math.max(heights[0], -5);
    return { x, z, yaw, width: drawn.width, length: drawn.length, trace: drawn.trace, level, lowest, shape: drawnShape, height: (HEIGHT_OF_SHAPE[drawnShape] ?? 8) - (earth ? 1 : 0), prefabId: PREFAB_OF_SHAPE[drawnShape], faceBearing: ((Math.atan2(faceX, -faceZ) * 180) / Math.PI + 360) % 360 };
  }
  return null;
}

/**
 * The forts of this harbour this year, sited but not yet drawn. A fort that holds its settlement inside it is the
 * caller's to place, and comes back as `enclosure`.
 */
export function planHarbourDefences({ harbour, region, portId, year, coastIsReal, stage, expansionTier = 0, crown = null, withEnclosure = false }) {
  const { forts: standing } = fortRecordsFor(portId, year);
  const out = [], taken = [];
  const enclosure = standing.find((record) => record.encloses) ?? null;
  for (const record of standing) {
    if (record.encloses) continue;
    if (out.length >= FORTS_MOST) break;
    const spot = siteRecordedFort(harbour, record, region, coastIsReal, taken);
    if (!spot) continue;
    taken.push(spot);
    out.push({ record, spot, name: record.name, role: record.role, shape: record.shape, sizeM: record.sizeM ?? null, bastions: record.bastions ?? 4, earth: Boolean(record.earth), terraces: Boolean(record.terraces), landmark: record.landmark ?? null, source: spot.source, what: describeGuard(harbour, record.role, null) });
  }
  if (out.length || enclosure) return { forts: out, enclosure };
  // No record stands yet, or there is none: what a port of this stage would have. The town-holding fort is counted apart.
  const count = withEnclosure
    ? (expansionTier >= 5 ? 1 : 0)
    : stage === 'outpost' ? 0 : stage === 'settlement' ? 1 : stage === 'citadel-metropolis' ? (expansionTier >= 6 ? 3 : 2) : 2;
  const names = RULE_NAMES[crown] ?? RULE_NAMES.spain;
  ruleSites(harbour, count, taken).forEach((spot, index) => {
    const shape = withEnclosure ? 'battery' : ruleShape(harbour, spot, index);
    out.push({ record: null, spot, name: names[index] ?? names[0], role: spot.what === 'mouth' ? 'mouth' : spot.what, shape, sizeM: null, bastions: 4, earth: crown === 'england' && year < 1680, terraces: false, landmark: null, source: 'rule', what: describeGuard(harbour, null, spot.what) });
  });
  return { forts: out, enclosure };
}

export { HARBOUR_GUN_RANGE_M };

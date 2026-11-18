// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Old World country. A port of Portugal or Spain is no clearing in a forest. It is a city grown
// over centuries on its own shore, with walled gardens under it, olives and vines on the slopes,
// corn on the easy ground, rough grazing and scrub on the heights, and a wood only here and there.
// Every city here is its board: Castle and Commons' own generator (assets/board/game.js), fitted
// to this game's ground and founded on it ahead of time (scripts/bake-board.mjs, js/board-model.js).
// The board decides what stands where; js/old-world-board.js stands it as this game's Cairn types,
// forests and water, and the rules here only colour and plant it. Ground that holds no city is a
// lattice of holdings, each put to the use its own ground suits.

import { CITY_TREES } from './old-world-city.js';
import { layBoardCountry } from './old-world-board.js';

const DEG = Math.PI / 180;
const OLD_WORLD_METRES_PER_DEGREE = 111195;

// Returned for ground where no tree may stand.
export const OLD_WORLD_NO_TREES = Object.freeze({ none: true });

// What a holding is put to. The order is the order a shader will read them in.
export const OLD_WORLD_LAND = Object.freeze({ CITY: 0, GARDEN: 1, OLIVES: 2, VINES: 3, CORN: 4, FALLOW: 5, PASTURE: 6, SCRUB: 7, WOOD: 8 });

// A holding is one cell of a jittered lattice of strips laid in world metres, so it runs unbroken
// across the borders of streamed sections and a shader can find the same holding from the same
// hash. The strips lie one of two ways, district by district, and bend a little with the country.
export const OLD_WORLD_HOLDING_METRES = Object.freeze([46, 104]);
const HOLDING_JITTER = 0.5;
const HOLDING_LIE = Object.freeze([0.31, 1.28].map((a) => Object.freeze([Math.cos(a), Math.sin(a)])));
const HOLDING_BEND_METRES = 80;

// People by year, read from period counts and later estimates, to the nearest few thousand; where
// the record is thin the figure is a judgement. A city's ground follows from its people. `port` is the
// coast (js/coastal-world.js) whose ground holds the city and under whose name its board is baked. `culture`
// is the tongue its board's people speak and name their places in (scripts/board-tuning.mjs adds the
// Portuguese and Dutch tongues to the eight of Castle and Commons). Seville and Porto stand on tidal rivers
// whose water the survey reads above the datum; their ground reads it at its own level (js/river-water.js).
export const OLD_WORLD_CITIES = Object.freeze([
  { id: 'lisbon', name: 'Lisboa', latitude: 38.7075, longitude: -9.1365, port: 'lisbon', culture: 'portuguese', people: [[1500, 65000], [1550, 100000], [1620, 150000], [1690, 180000]] },
  { id: 'seville', name: 'Sevilla', latitude: 37.3826, longitude: -5.9963, port: 'seville', culture: 'iberian', people: [[1500, 60000], [1550, 100000], [1600, 130000], [1650, 70000], [1690, 80000]] },
  { id: 'porto', name: 'Porto', latitude: 41.1406, longitude: -8.6110, port: 'porto', culture: 'portuguese', people: [[1500, 12000], [1620, 20000], [1690, 25000]] },
  { id: 'cadiz', name: 'Cádiz', latitude: 36.5297, longitude: -6.2927, port: 'cadiz', culture: 'iberian', people: [[1500, 3000], [1600, 7000], [1650, 22000], [1690, 40000]] },
  { id: 'sanlucar', name: 'Sanlúcar de Barrameda', latitude: 36.7783, longitude: -6.3515, port: 'sanlucar', culture: 'iberian', people: [[1500, 6000], [1580, 10000], [1690, 9000]] },
  { id: 'palos', name: 'Palos de la Frontera', latitude: 37.2289, longitude: -6.8936, port: 'palos-huelva', culture: 'iberian', people: [[1500, 2700], [1550, 1500], [1690, 600]] },
  { id: 'huelva', name: 'Huelva', latitude: 37.2583, longitude: -6.9508, port: 'huelva', culture: 'iberian', people: [[1500, 3500], [1690, 5000]] },
  { id: 'la-coruna', name: 'La Coruña', latitude: 43.3709, longitude: -8.3959, port: 'la-coruna', culture: 'iberian', people: [[1500, 3000], [1600, 5000], [1690, 7000]] },
  { id: 'setubal', name: 'Setúbal', latitude: 38.5244, longitude: -8.8926, port: 'setubal', culture: 'portuguese', people: [[1500, 6000], [1690, 12000]] },
].map((city) => Object.freeze({ ...city, people: Object.freeze(city.people.map(Object.freeze)) })));

// The towns, villages and religious houses that stood round a city by the middle of the sixteenth century: name,
// latitude, longitude, and weight (9 a town that must stand, 6 a hamlet that should). The board's founders favour
// these spots over any other and its places take these names (js/board-model.js). Positions are to a few hundred
// metres; a place beyond the city's ground (some 3.8 km from its middle) is left to the ground that holds it.
export const OLD_WORLD_PLACES = Object.freeze({
  lisbon: Object.freeze([
    ['Alcântara', 38.7052, -9.1745, 8], ['Santos', 38.7068, -9.1552, 6], ['Xabregas', 38.7262, -9.1127, 7],
    ['Almada', 38.6835, -9.1583, 8], ['Cacilhas', 38.6869, -9.1483, 7], ['Arroios', 38.7335, -9.1355, 6],
    ['Campolide', 38.7307, -9.1668, 6], ['São Sebastião da Pedreira', 38.7345, -9.1525, 6], ['Beato', 38.7335, -9.1050, 6],
    ['Marvila', 38.7415, -9.1040, 6],
  ].map(Object.freeze)),
  // The Franciscan friary on the bluff over the meeting of the Tinto and the Odiel.
  palos: Object.freeze([['La Rábida', 37.2085, -6.9256, 7]].map(Object.freeze)),
  // The hermitage of the Virgin of La Cinta on the cabezo north-east of the town.
  huelva: Object.freeze([['Nuestra Señora de la Cinta', 37.2747, -6.9361, 6]].map(Object.freeze)),
  // The fishermen's quarter below the walls, and the parishes of the isthmus.
  'la-coruna': Object.freeze([
    ['A Pescadería', 43.3685, -8.4040, 7], ['Monelos', 43.3560, -8.4100, 6], ['Elviña', 43.3430, -8.4200, 6],
  ].map(Object.freeze)),
  // The river beach the fleets sailed from, and the anchorage of Bonanza up the Guadalquivir.
  sanlucar: Object.freeze([['Bajo de Guía', 36.7841, -6.3584, 6], ['Bonanza', 36.8025, -6.3355, 6]].map(Object.freeze)),
  // Triana over the river from the Arenal, the arrabales outside the walls, and the Carthusians and Hieronymites.
  seville: Object.freeze([
    ['Triana', 37.3846, -6.0030, 9], ['San Bernardo', 37.3815, -5.9830, 6], ['San Roque', 37.3880, -5.9800, 6],
    ['Santa María de las Cuevas', 37.3997, -6.0045, 6], ['San Jerónimo de Buenavista', 37.4170, -5.9850, 6],
  ].map(Object.freeze)),
  // Gaia over the Douro from the Ribeira, and the parishes outside the walls.
  porto: Object.freeze([
    ['Vila Nova de Gaia', 41.1345, -8.6125, 8], ['Miragaia', 41.1435, -8.6190, 6], ['Massarelos', 41.1480, -8.6320, 6],
    ['Cedofeita', 41.1560, -8.6205, 6], ['Campanhã', 41.1490, -8.5860, 6],
  ].map(Object.freeze)),
});

// How far a city shapes the use of the land around it, beyond its own edge.
const CITY_INFLUENCE_METRES = 2400;
// A crowded Mediterranean city housed about this many to the hectare; a small town, fewer.
const cityDensityPerHectare = (people) => 240 + 150 * smooth(4000, 40000, people);

function smooth(a, b, x) {
  const t = Math.max(0, Math.min(1, (x - a) / (b - a || 1)));
  return t * t * (3 - 2 * t);
}

// The peninsula and its islands, by a box with France and Africa cut off its corners.
export function inIberia(latitude, longitude) {
  if (!(latitude > 35.95 && latitude < 43.85)) return false;
  if (longitude > -9.6 && longitude < 3.4) {
    if (longitude > -1.7 && latitude > 43.4) return false;
    if (longitude > 0.6 && latitude > 42.5) return false;
    return true;
  }
  return longitude >= 3.4 && longitude < 4.4 && latitude > 38.6 && latitude < 40.15;
}

export function oldWorldPeople(city, year = 1550) {
  const counts = city.people;
  if (year <= counts[0][0]) return counts[0][1];
  for (let i = 1; i < counts.length; i++) {
    if (year <= counts[i][0]) {
      const t = (year - counts[i - 1][0]) / (counts[i][0] - counts[i - 1][0]);
      return Math.round(counts[i - 1][1] + (counts[i][1] - counts[i - 1][1]) * t);
    }
  }
  return counts[counts.length - 1][1];
}

// The city whose recorded site lies on a region's own ground, or none: the city its board founds there.
export function oldWorldCityHeld(region) {
  if (!region || !Number.isFinite(region.latitude) || !Number.isFinite(region.longitude) || !inIberia(region.latitude, region.longitude)) return null;
  const geoSpan = region.demGeoSpan || (region.span < 4000 ? 6800 : region.span), scale = region.span / geoSpan, half = region.span / 2;
  const cos = Math.max(0.1, Math.cos(region.latitude * DEG));
  let best = null, least = Infinity;
  for (const city of OLD_WORLD_CITIES) {
    const x = (city.longitude - region.longitude) * OLD_WORLD_METRES_PER_DEGREE * cos * scale;
    const z = (region.latitude - city.latitude) * OLD_WORLD_METRES_PER_DEGREE * scale;
    if (Math.abs(x) >= half || Math.abs(z) >= half) continue;
    if (Math.hypot(x, z) < least) { least = Math.hypot(x, z); best = city; }
  }
  return best;
}

// The city whose country this spot lies in, or none.
export function oldWorldCityNear(latitude, longitude, withinMetres = 16000) {
  let best = null, least = withinMetres;
  const cos = Math.cos(latitude * DEG);
  for (const city of OLD_WORLD_CITIES) {
    const d = Math.hypot((city.longitude - longitude) * cos, city.latitude - latitude) * OLD_WORLD_METRES_PER_DEGREE;
    if (d < least) { least = d; best = city; }
  }
  return best;
}

// An Old World port stands on the ground of the city it serves. A port recorded between two (Cádiz and Sanlúcar,
// each some 14 km off) would have ground holding neither, and no board: its ground is laid round the site of the
// nearest city within that city's country instead, which its board then founds. A port whose recorded site already
// holds a city on ground `span` metres across keeps it.
export function oldWorldPortOnCity(port, span) {
  if (!port || !inIberia(port.latitude, port.longitude) || oldWorldCityHeld({ ...port, span })) return port;
  const city = oldWorldCityNear(port.latitude, port.longitude);
  return city ? Object.freeze({ ...port, latitude: city.latitude, longitude: city.longitude }) : port;
}

// One 32-bit hash of a lattice cell. Integer arithmetic only, so WGSL gives the same bits.
export function oldWorldHash(i, j, salt = 0) {
  let h = (Math.imul(i | 0, 0x27d4eb2d) ^ Math.imul(j | 0, 0x165667b1) ^ salt) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return (h ^ (h >>> 15)) >>> 0;
}
const unit = (h) => h / 4294967296;

function valueNoise(x, z, salt) {
  const i = Math.floor(x), j = Math.floor(z), a = x - i, b = z - j;
  const u = a * a * (3 - 2 * a), v = b * b * (3 - 2 * b);
  const p = unit(oldWorldHash(i, j, salt)), q = unit(oldWorldHash(i + 1, j, salt));
  const r = unit(oldWorldHash(i, j + 1, salt)), s = unit(oldWorldHash(i + 1, j + 1, salt));
  return (p * (1 - u) + q * u) * (1 - v) + (r * (1 - u) + s * u) * v;
}
const drift = (x, z, metres, salt) => valueNoise(x / metres, z / metres, salt) * 0.65 + valueNoise(x / (metres * 0.43) + 7.3, z / (metres * 0.43) - 3.1, salt ^ 0x5bd1e995) * 0.35;

const bendAt = (x, z) => [(drift(x, z, 310, 0x6a09e667) - 0.5) * HOLDING_BEND_METRES, (drift(x, z, 310, 0xbb67ae85) - 0.5) * HOLDING_BEND_METRES];

// The holding a point lies in: which way its district's strips lie, its lattice cell, the seat of
// that cell in the strips' own frame, and how far the point stands from the holding's boundary.
export function oldWorldHolding(x, z) {
  const lie = valueNoise(x / 950, z / 950, 0x3c6ef372) > 0.5 ? 1 : 0, [c, s] = HOLDING_LIE[lie];
  const [bx, bz] = bendAt(x, z), wx = x + bx, wz = z + bz;
  const u = wx * c + wz * s, v = wz * c - wx * s;
  const [across, along] = OLD_WORLD_HOLDING_METRES, ci = Math.floor(u / across), cj = Math.floor(v / along);
  let bi = 0, bj = 0, pu = 0, pv = 0, best = Infinity, qu = 0, qv = 0, second = Infinity;
  for (let dj = -1; dj <= 1; dj++) {
    for (let di = -1; di <= 1; di++) {
      const i = ci + di, j = cj + dj, h = oldWorldHash(i, j, 0x4f1bbcdc + lie);
      const su = (i + 0.5 + ((h & 0xffff) / 65536 - 0.5) * HOLDING_JITTER) * across;
      const sv = (j + 0.5 + ((h >>> 16) / 65536 - 0.5) * HOLDING_JITTER) * along;
      const d = (su - u) * (su - u) + (sv - v) * (sv - v);
      if (d < best) { second = best; qu = pu; qv = pv; best = d; bi = i; bj = j; pu = su; pv = sv; }
      else if (d < second) { second = d; qu = su; qv = sv; }
    }
  }
  const between = Math.hypot(qu - pu, qv - pv);
  return { lie, i: bi, j: bj, u: pu, v: pv, edge: between > 1e-6 ? (second - best) / (2 * between) : across };
}

// Where a holding's seat lies in the world: its place in the strips' frame, with the bend undone.
export function oldWorldHoldingSeat(hold) {
  const [c, s] = HOLDING_LIE[hold.lie], wx = hold.u * c - hold.v * s, wz = hold.u * s + hold.v * c;
  let x = wx, z = wz;
  for (let pass = 0; pass < 3; pass++) { const [bx, bz] = bendAt(x, z); x = wx - bx; z = wz - bz; }
  return { x, z };
}

function sampler(heights, region) {
  const n = Math.round(Math.sqrt(heights.length)), span = region.span, s = (n - 1) / span;
  const x0 = region.x - span / 2, z0 = region.z - span / 2, top = n - 1.0001;
  return {
    n, step: span / (n - 1), x0, z0,
    at(x, z) {
      const u = Math.max(0, Math.min(top, (x - x0) * s)), v = Math.max(0, Math.min(top, (z - z0) * s));
      const i = Math.floor(u), j = Math.floor(v), a = u - i, b = v - j, k = j * n + i;
      return (heights[k] * (1 - a) + heights[k + 1] * a) * (1 - b) + (heights[k + n] * (1 - a) + heights[k + n + 1] * a) * b;
    },
  };
}

function fieldAt(field, grid, x, z) {
  const top = grid.n - 1.0001, s = 1 / grid.step;
  const u = Math.max(0, Math.min(top, (x - grid.x0) * s)), v = Math.max(0, Math.min(top, (z - grid.z0) * s));
  const i = Math.floor(u), j = Math.floor(v), a = u - i, b = v - j, k = j * grid.n + i, n = grid.n;
  return (field[k] * (1 - a) + field[k + 1] * a) * (1 - b) + (field[k + n] * (1 - a) + field[k + n + 1] * a) * b;
}

// Distance in metres from every lattice point to the nearest marked one, by two chamfer sweeps.
function distanceTo(marked, n, step) {
  const d = new Float32Array(n * n), diag = step * Math.SQRT2;
  for (let k = 0; k < d.length; k++) d[k] = marked[k] ? 0 : 1e9;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const k = j * n + i; let v = d[k];
    if (i > 0) v = Math.min(v, d[k - 1] + step);
    if (j > 0) { v = Math.min(v, d[k - n] + step); if (i > 0) v = Math.min(v, d[k - n - 1] + diag); if (i < n - 1) v = Math.min(v, d[k - n + 1] + diag); }
    d[k] = v;
  }
  for (let j = n - 1; j >= 0; j--) for (let i = n - 1; i >= 0; i--) {
    const k = j * n + i; let v = d[k];
    if (i < n - 1) v = Math.min(v, d[k + 1] + step);
    if (j < n - 1) { v = Math.min(v, d[k + n] + step); if (i < n - 1) v = Math.min(v, d[k + n + 1] + diag); if (i > 0) v = Math.min(v, d[k + n - 1] + diag); }
    d[k] = v;
  }
  return d;
}

// Every stretch of road sorted into a coarse grid, so the nearest one to a point is quick to find.
function indexRoads(roads, region) {
  const cell = 96, x0 = region.x - region.span / 2, z0 = region.z - region.span / 2, w = Math.ceil(region.span / cell) + 1;
  const bins = new Array(w * w).fill(null), close = new Uint8Array(w * w);
  roads.forEach((line, id) => {
    let arc = 0;
    for (let at = 0; at < line.length - 1; at++) {
      const [ax, az] = line[at], [bx, bz] = line[at + 1], length = Math.hypot(bx - ax, bz - az);
      const i0 = Math.floor((Math.min(ax, bx) - x0) / cell), i1 = Math.floor((Math.max(ax, bx) - x0) / cell);
      const j0 = Math.floor((Math.min(az, bz) - z0) / cell), j1 = Math.floor((Math.max(az, bz) - z0) / cell);
      for (let j = Math.max(0, j0); j <= Math.min(w - 1, j1); j++) for (let i = Math.max(0, i0); i <= Math.min(w - 1, i1); i++) {
        (bins[j * w + i] ??= []).push(ax, az, bx, bz, arc, id);
        for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
          if (i + di >= 0 && j + dj >= 0 && i + di < w && j + dj < w) close[(j + dj) * w + i + di] = 1;
        }
      }
      arc += length;
    }
  });
  // The nearest road within a stone's throw: how far, which road, and how far along it.
  return (x, z) => {
    const i = Math.floor((x - x0) / cell), j = Math.floor((z - z0) / cell);
    if (i < 0 || j < 0 || i >= w || j >= w || !close[j * w + i]) return null;
    let best = cell * cell, arc = 0, id = -1;
    for (let dj = -1; dj <= 1; dj++) for (let di = -1; di <= 1; di++) {
      const bin = i + di >= 0 && j + dj >= 0 && i + di < w && j + dj < w ? bins[(j + dj) * w + i + di] : null;
      if (!bin) continue;
      for (let k = 0; k < bin.length; k += 6) {
        const ax = bin[k], az = bin[k + 1], ex = bin[k + 2] - ax, ez = bin[k + 3] - az, len = ex * ex + ez * ez;
        const t = len > 0 ? Math.max(0, Math.min(1, ((x - ax) * ex + (z - az) * ez) / len)) : 0;
        const d = (ax + ex * t - x) ** 2 + (az + ez * t - z) ** 2;
        if (d < best) { best = d; arc = bin[k + 4] + Math.sqrt(len) * t; id = bin[k + 5]; }
      }
    }
    return id < 0 ? null : { distance: Math.sqrt(best), arc, id };
  };
}

const countries = new WeakMap();

// Boards founded ahead of time, by port and year. One is handed in before its port's land is made.
const bakedBoards = new Map();
const uncarvedSurveys = new WeakMap();
export function registerBakedBoard(baked) {
  if (baked && baked.board && baked.port) bakedBoards.set(`${baked.port}:${baked.year}`, baked);
}
export function bakedBoardFor(region) {
  return bakedBoards.get(`${region.id}:${region.year ?? 1550}`) || null;
}
// A city on ground that holds it, with no board founded there: it stands as open country, and says why once.
const unbakedSaid = new Set();
function unbakedCity(city, region, baked) {
  const key = `${region.id}:${region.year ?? 1550}`;
  if (unbakedSaid.has(key)) return;
  unbakedSaid.add(key);
  console.error(baked
    ? `${city.name}: its board of ${region.year ?? 1550} was founded on ${baked.board?.span} m of ground, not this ${region.span}; bake it again (node scripts/bake-board.mjs ${region.id})`
    : `${city.name} has no board for ${region.id} in ${region.year ?? 1550}: bake one (node scripts/bake-board.mjs ${region.id})`);
}

// The country a region's ground belongs to, or null where the old rules of a wild shore hold.
// One is made per elevation field and kept, since land cover, ground colour and planting all ask.
export function oldWorldCountry(region, heights, port = null) {
  if (!region || !heights || !Number.isFinite(region.latitude) || !Number.isFinite(region.longitude)) return null;
  if (!inIberia(region.latitude, region.longitude)) return null;
  const kept = countries.get(heights);
  if (kept && kept.port === port) return kept.country;
  const country = makeCountry(region, heights, port);
  countries.set(heights, { port, country });
  return country;
}

export function refreshOldWorldBoardCountry(nextBoardJson, region, heights, port = null, surveyHeights = null) {
  if (!nextBoardJson || !region || !heights || !inIberia(region.latitude, region.longitude)) return null;
  if (surveyHeights instanceof Float32Array && surveyHeights.length === heights.length && !uncarvedSurveys.has(heights)) {
    uncarvedSurveys.set(heights, surveyHeights.slice());
  }
  const baseBaked = bakedBoardFor(region);
  const nextBaked = {
    ...(baseBaked || { port: region.id || 'lisbon', year: region.year ?? 1550 }),
    board: nextBoardJson,
  };
  registerBakedBoard(nextBaked);
  countries.delete(heights);
  const country = makeCountry(region, heights, port, nextBaked);
  countries.set(heights, { port, country });
  return country;
}

function makeCountry(region, heights, port, explicitBaked = null) {
  const grid = sampler(heights, region), heightAt = grid.at;
  const geoSpan = region.demGeoSpan || (region.span < 4000 ? 6800 : region.span), scale = region.span / geoSpan;
  const cos = Math.max(0.1, Math.cos(region.latitude * DEG));
  // The city whose site lies on this ground is its board's; one beyond it only shapes the use of the country.
  const held = oldWorldCityHeld(region), city = held ?? oldWorldCityNear(region.latitude, region.longitude);
  const year = region.year ?? 1550;
  const people = city ? oldWorldPeople(city, year) : 0;
  const cityArea = city ? (people / cityDensityPerHectare(people)) * 10000 : 0;
  const cityX = city ? region.x + (city.longitude - region.longitude) * OLD_WORLD_METRES_PER_DEGREE * cos * scale : 0;
  const cityZ = city ? region.z - (city.latitude - region.latitude) * OLD_WORLD_METRES_PER_DEGREE * scale : 0;
  const cityRadius = Math.sqrt(cityArea / Math.PI) * 1.15;
  const holdsCity = Boolean(held && port && port.clearRadius > 0 && port.center);
  const marked = () => { const w = new Uint8Array(heights.length); for (let k = 0; k < w.length; k++) w[k] = heights[k] <= 0.25 ? 1 : 0; return w; };
  // The city is its board, founded for this port on the ground the game makes for it (scripts/bake-board.mjs). A
  // city with no board founded for this ground has no town: it is baked, never grown here.
  const baked = explicitBaked ?? (holdsCity ? bakedBoardFor(region) : null);
  const standsBoard = Boolean(baked && baked.board?.span === region.span);
  if (holdsCity && !standsBoard) unbakedCity(city, region, baked);
  if (uncarvedSurveys.has(heights)) heights.set(uncarvedSurveys.get(heights));
  if (standsBoard && !uncarvedSurveys.has(heights)) uncarvedSurveys.set(heights, heights.slice());
  const stood = standsBoard
    ? layBoardCountry({ baked, region, grid, heights, heightAt, port, wet: marked(), LAND: OLD_WORLD_LAND, fieldAt, distanceTo }) : null;
  const town = stood ? stood.town : null;
  const inland = town ? town.inland : distanceTo(marked(), grid.n, grid.step);
  const beyondTown = (x, z) => town ? fieldAt(town.beyond, grid, x, z) : city ? Math.max(0, Math.hypot(x - cityX, z - cityZ) - cityRadius) : 1e9;
  const roads = stood ? stood.roads : [];
  const roadNear = roads.length ? indexRoads(roads, region) : null;
  // The city itself: its streets, lots, walls, castle, churches and squares, as the board laid them.
  const plan = stood ? stood.plan : null;
  // Trees line a road near the town and by stretches beyond it.
  const roadLined = (way, x, z) => beyondTown(x, z) < 600 || unit(oldWorldHash(way.id, Math.floor(way.arc / 260), 0x2ffd72db)) < 0.5;
  const holdings = new Map();

  const HEDGED = [0, 0.6, 0.3, 0.3, 0.25, 0.25, 0.22, 0, 0];
  const holdingUse = (hold) => {
    const key = ((hold.i + 32768) * 65536 + (hold.j + 32768)) * 2 + hold.lie;
    let use = holdings.get(key);
    if (use) return use;
    const { x, z } = oldWorldHoldingSeat(hold), h = heightAt(x, z);
    const gx = (heightAt(x + 24, z) - heightAt(x - 24, z)) / 48, gz = (heightAt(x, z + 24) - heightAt(x, z - 24)) / 48;
    const slope = Math.hypot(gx, gz);
    let around = 0;
    for (let a = 0; a < 8; a++) around += heightAt(x + Math.cos(a * Math.PI / 4) * 110, z + Math.sin(a * Math.PI / 4) * 110);
    around /= 8;
    const hollow = Math.max(0, Math.min(1, (around - h) / 5)), crest = Math.max(0, Math.min(1, (h - around) / 8));
    const near = 1 - smooth(250, CITY_INFLUENCE_METRES, beyondTown(x, z));
    const easy = 1 - smooth(0.1, 0.24, slope);
    const terraced = smooth(0.035, 0.09, slope) * (1 - smooth(0.26, 0.4, slope));
    const steep = smooth(0.24, 0.42, slope);
    // North is -z, so ground falling toward +z faces the sun.
    const sunny = slope > 1e-4 ? 0.5 - 0.5 * gz / slope : 0.5;
    // A district leans hard to one use, so a hillside is all vines and a plateau all corn.
    const district = (salt) => Math.exp(7 * (drift(x, z, 640, salt) - 0.5));
    const woodland = smooth(0.66, 0.8, drift(x, z, 900, 0x1f83d9ab));
    const want = [
      0,
      near * near * (0.25 + 0.75 * Math.max(hollow, easy * 0.5)) * (1 - steep) * 1.7 * district(0x243f6a88),
      (0.3 + 0.5 * near) * (0.35 + 0.65 * terraced) * (1 - steep) * district(0x85a308d3),
      (0.22 + 0.45 * near) * terraced * (0.45 + 0.55 * sunny) * district(0x13198a2e),
      (0.5 + 0.2 * (1 - near)) * easy * district(0x03707344),
      0,
      (0.14 + 0.3 * (1 - near) * (0.4 + 0.6 * crest) + 0.25 * steep) * district(0xa4093822),
      steep * 1.3 + (0.1 + crest * 0.25) * (1 - near),
      (1 - near) * (0.02 + 6 * woodland) * (0.6 + 0.4 * (1 - sunny)),
    ];
    let total = 0;
    for (const w of want) total += w;
    const lot = oldWorldHash(hold.i, hold.j, 0x299f31d0 + hold.lie);
    let pick = unit(lot) * total, kind = OLD_WORLD_LAND.PASTURE;
    for (let k = 1; k < want.length; k++) { pick -= want[k]; if (pick <= 0) { kind = k; break; } }
    // Corn stands one year in two; the other half of the country lies fallow, by whole furlongs
    // with a strip here and there out of step.
    const turn = unit(oldWorldHash(hold.i, hold.j, 0x082efa98 + hold.lie));
    const resting = (drift(x, z, 420, 0x452821e6) > 0.5) !== (turn > 0.88);
    if (kind === OLD_WORLD_LAND.CORN && resting) kind = OLD_WORLD_LAND.FALLOW;
    use = {
      kind, turn, slope,
      shade: unit(oldWorldHash(hold.i, hold.j, 0xec4e6c89 + hold.lie)),
      wooded: kind === OLD_WORLD_LAND.PASTURE && drift(x, z, 500, 0x38d01377) > 0.52,
      // Some holdings are bounded by a line of trees.
      hedged: unit(oldWorldHash(hold.i, hold.j, 0xd1310ba6 + hold.lie)) < HEDGED[kind],
    };
    holdings.set(key, use);
    return use;
  };

  // The parcel a point lies in: what it is put to, how far inside its bounds the point is, and two numbers that
  // name it. A board's furlongs where one stands; the lattice of holdings otherwise.
  const parcelAt = stood ? stood.parcelAt : (x, z) => {
    const hold = oldWorldHolding(x, z);
    return { use: holdingUse(hold), edge: hold.edge, i: hold.i, j: hold.j };
  };

  // Ground colours, in the 0-255 the baked albedo is written in, for the dry sailing season.
  const COLOUR = [
    [150, 134, 110], // trodden city ground
    [84, 104, 52], // watered gardens
    [128, 122, 82], // olives over dry grass
    [112, 122, 66], // vines over pale earth
    [182, 158, 98], // ripe corn and stubble
    [136, 104, 74], // ploughed fallow
    [154, 142, 92], // summer pasture
    [88, 94, 58], // scrub
    [40, 70, 34], // wood
  ];
  const BOUNDARY = [null, [62, 72, 44, 0.8], [146, 136, 114, 0.5], [150, 140, 118, 0.55], [128, 120, 80, 0.4], [118, 108, 76, 0.4], [134, 126, 98, 0.3], null, null];
  const VEGETATION = [0, 0.18, 0.235, 0, 0, 0, 0, 0.19, 0.96];
  const STOOD_VEGETATION = [0, 0.18, 0.235, 0, 0, 0, 0, 0, 0.96];
  const SOME_TREES = 0.18;

  // What stands at a point of dry ground: its use, how much of it bears trees (as the vegetation
  // mask counts it), and the colour of its ground.
  const landAt = (x, z, slope = 0) => {
    const hold = parcelAt(x, z), use = hold.use;
    const urban = town ? fieldAt(town.urban, grid, x, z) : 0;
    let kind = use.kind;
    // A holding cannot farm a cliff: its steep corners go back to scrub.
    if (slope > 0.44 && kind !== OLD_WORLD_LAND.WOOD) kind = OLD_WORLD_LAND.SCRUB;
    if (urban >= 0.5) kind = OLD_WORLD_LAND.CITY;
    if (stood) {
      // A board's country keeps the colours of its geography: its parcels, roads and town ground are stamped onto
      // them by the GPU (js/board-stamp.js). Here only what bears trees is said, for the forest and the planting.
      let vegetation = STOOD_VEGETATION[kind];
      if (kind === OLD_WORLD_LAND.CITY) vegetation = plan.treesAt(x, z) !== CITY_TREES.NONE ? SOME_TREES : 0;
      else {
        if (hold.woodEdge > 0 && (kind === OLD_WORLD_LAND.PASTURE || kind === OLD_WORLD_LAND.SCRUB || kind === OLD_WORLD_LAND.FALLOW)) {
          vegetation = Math.max(vegetation, 0.18 + hold.woodEdge * 0.08);
        }
        if (use.hedged && hold.edge < 10) vegetation = Math.max(vegetation, SOME_TREES);
      }
      if (urban > 0 && urban < 0.5) vegetation *= 1 - urban * 2;
      const way = kind !== OLD_WORLD_LAND.CITY && kind !== OLD_WORLD_LAND.WOOD && roadNear ? roadNear(x, z) : null;
      if (way && way.distance < 14 && roadLined(way, x, z)) vegetation = Math.max(vegetation, SOME_TREES);
      return { kind, vegetation };
    }
    // Ground that holds no board is open country: no town stands on it, and its holdings are coloured here.
    const base = COLOUR[kind], fine = drift(x, z, 22, 0x38d01377) - 0.5, broad = drift(x, z, 140, 0xbe5466cf) - 0.5;
    const tone = 1 + (use.shade - 0.5) * 0.22 + fine * 0.16 + broad * 0.12;
    let r = base[0] * tone, g = base[1] * tone, b = base[2] * tone;
    if (kind === OLD_WORLD_LAND.GARDEN) {
      // Beds a few paces wide: green crops and turned earth by turns.
      const bed = unit(oldWorldHash(Math.floor(x / 9), Math.floor(z / 9), hold.i * 31 + hold.j));
      if (bed > 0.6) { r = 98 * tone; g = 78 * tone; b = 56 * tone; }
    } else if (kind === OLD_WORLD_LAND.OLIVES) {
      // Each tree is a dark crown on pale ground, too small for this image: stipple them.
      const crown = unit(oldWorldHash(Math.floor(x / 9.5), Math.floor(z / 9.5), 0x3f84d5b5));
      if (crown > 0.52) { r = 82 * tone; g = 94 * tone; b = 64 * tone; }
    } else if (kind === OLD_WORLD_LAND.PASTURE && use.wooded) {
      const crown = unit(oldWorldHash(Math.floor(x / 14), Math.floor(z / 14), 0xb5470917));
      if (crown > 0.78) { r = 70 * tone; g = 84 * tone; b = 50 * tone; }
    } else if (kind === OLD_WORLD_LAND.FALLOW && use.turn > 0.6) {
      r = 132 * tone; g = 128 * tone; b = 78 * tone;
    }
    let vegetation = kind === OLD_WORLD_LAND.PASTURE && use.wooded ? SOME_TREES : VEGETATION[kind];
    const line = BOUNDARY[kind];
    if (line) {
      const hedge = use.hedged, w = (1 - smooth(1.5, 6.5, hold.edge)) * (hedge ? 0.85 : line[3]);
      r += ((hedge ? 58 : line[0]) - r) * w; g += ((hedge ? 76 : line[1]) - g) * w; b += ((hedge ? 44 : line[2]) - b) * w;
      if (hedge && hold.edge < 10) vegetation = Math.max(vegetation, SOME_TREES);
    }
    return { kind, vegetation, r, g, b };
  };

  // How trees stand on tended ground: far apart, kept to size, of the kinds a farmer plants, and
  // in lines along a boundary or a road. Null on wild ground, where the forest's own rules hold;
  // NO_TREES where none may stand.
  // `height` is how tall the tree is kept, in metres: the least, and how much more the tallest stands. A
  // forest pack of full-grown trees is drawn to it (js/terrain.js), so an olive or a yard tree is a grown
  // tree's shape at an orchard tree's size. `scale` is the same for a pack of young trees: a share of the
  // prototype, least and range.
  const NO_TREES = OLD_WORLD_NO_TREES;
  const TENDED = [
    NO_TREES,
    { spacing: 12, height: [5.2, 3.4], scale: [0.55, 0.25], species: ['birch'], cohort: 'veteran', tint: [1, 1, 0.94] },
    { spacing: 10.5, height: [10.0, 3.8], scale: [0.58, 0.22], species: ['oak'], cohort: 'veteran', tint: [0.86, 0.94, 0.9] },
    NO_TREES, NO_TREES, NO_TREES,
    { spacing: 48, height: [13.5, 7.5], scale: [0.82, 0.42], species: ['oak', 'elm'], cohort: 'veteran', tint: [0.94, 0.98, 0.9] },
    { spacing: 36, height: [5.2, 3.6], scale: [0.55, 0.28], species: ['birch'], cohort: 'veteran', tint: [0.92, 0.96, 0.88] },
    null,
  ];
  const WOOD_EDGE = { spacing: 6.2, height: [10.2, 6.0], scale: [0.56, 0.32], species: ['birch', 'oak', 'maple', 'chestnut'], cohort: 'veteran', tint: [0.94, 0.99, 0.9] };
  const HEDGEROW = { spacing: 10, height: [11.5, 6.0], scale: [0.7, 0.35], species: ['elm', 'chestnut', 'maple'], cohort: 'veteran', tint: [0.96, 1, 0.92] };
  const ROADSIDE = { spacing: 11, height: [14.0, 8.0], scale: [0.85, 0.38], species: ['elm', 'maple', 'oak'], cohort: 'veteran', tint: [0.96, 1, 0.92] };
  // In the town: a ring of shade trees round a square, a walled garden's orchard, a tree in a yard.
  const SQUARE_TREES = { spacing: 9, height: [11.5, 5.0], scale: [0.64, 0.25], species: ['maple', 'oak', 'elm'], cohort: 'veteran', tint: [0.96, 1, 0.92] };
  const PARK_TREES = { spacing: 8, height: [10.5, 5.5], scale: [0.58, 0.28], species: ['maple', 'birch', 'oak', 'chestnut'], cohort: 'veteran', tint: [0.94, 1, 0.9] };
  const YARD_TREES = { spacing: 13, height: [5.0, 3.2], scale: [0.55, 0.25], species: ['birch'], cohort: 'veteran', tint: [1, 1, 0.94] };
  const treesAt = (x, z) => {
    if (stood && fieldAt(inland, grid, x, z) < 4) return NO_TREES;
    if (town && fieldAt(town.urban, grid, x, z) >= 0.5) {
      const where = plan ? plan.treesAt(x, z) : CITY_TREES.NONE;
      return where === CITY_TREES.SQUARE ? SQUARE_TREES : where === CITY_TREES.PARK ? PARK_TREES : where === CITY_TREES.YARD ? YARD_TREES : NO_TREES;
    }
    const way = roadNear ? roadNear(x, z) : null;
    if (way && way.distance < 4) return NO_TREES;
    const hold = parcelAt(x, z), use = hold.use;
    if (use.kind === OLD_WORLD_LAND.WOOD) return null;
    if (way && way.distance < 8.5 && roadLined(way, x, z)) return ROADSIDE;
    if (use.hedged && hold.edge < 3.2) return HEDGEROW;
    if (stood) {
      if (hold.woodEdge > 0 && (use.kind === OLD_WORLD_LAND.PASTURE || use.kind === OLD_WORLD_LAND.SCRUB || use.kind === OLD_WORLD_LAND.FALLOW)) return WOOD_EDGE;
      if (use.kind === OLD_WORLD_LAND.PASTURE || use.kind === OLD_WORLD_LAND.SCRUB) return NO_TREES;
    }
    return use.kind === OLD_WORLD_LAND.PASTURE && !use.wooded ? NO_TREES : TENDED[use.kind];
  };

  return { city, people, year, cityX, cityZ, cityRadius, cityArea, town, roads, plan, grid, inland, landAt, treesAt, beyondTown, board: stood ? stood.stamp : null, places: stood ? stood.places : null, watch: stood ? stood.watch : null, inlandWater: stood ? stood.inlandWater : null, ponds: stood ? stood.ponds : null, herds: stood ? stood.herds : null, loneTrees: stood ? stood.loneTrees : null, bridges: stood ? stood.bridges : null, riverCut: stood ? stood.riverCut : null, riverReaches: stood ? stood.riverReaches : null };
}

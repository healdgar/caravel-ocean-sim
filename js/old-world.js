// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Old World country. A port of Portugal or Spain is no clearing in a forest. It is a city grown
// over centuries on its own shore, with walled gardens under it, olives and vines on the slopes,
// corn on the easy ground, rough grazing and scrub on the heights, and a wood only here and there.
// Every city here is its board: Castle and Commons' own generator (assets/board/game.js), fitted
// to this game's ground and founded on it ahead of time (scripts/bake-board.mjs, js/board-model.js).
// The board decides what stands where; js/old-world-board.js stands it as this game's Cairn types,
// forests and water, and the rules here only colour and plant it. Ground with no board standing has
// no country of its own: no town is grown and no fields are laid there without one, and the rules of
// a wild shore hold.

import { CITY_TREES } from './old-world-city.js';
import { layBoardCountry } from './old-world-board.js';
import { nativeTownHeld } from './native-towns.js';
import { colonialTownHeld } from './colonial-towns.js';
import { BOARD_RIVERS, boardRequest, boardSeat } from './board-model.js';
import { FORT_RECORDS, fortPhaseFor, fortRecordsFor } from './fort-records.js';

const DEG = Math.PI / 180;
const OLD_WORLD_METRES_PER_DEGREE = 111195;

// Returned for ground where no tree may stand.
export const OLD_WORLD_NO_TREES = Object.freeze({ none: true });

// What a board's furlong is put to. The order is the order a shader will read them in.
export const OLD_WORLD_LAND = Object.freeze({ CITY: 0, GARDEN: 1, OLIVES: 2, VINES: 3, CORN: 4, FALLOW: 5, PASTURE: 6, SCRUB: 7, WOOD: 8 });

// People by year, read from period counts and later estimates, to the nearest few thousand; where
// the record is thin the figure is a judgement. A city's ground follows from its people. `port` is the
// coast (js/coastal-world.js) whose ground holds the city and under whose name its board is baked. `culture`
// is the tongue its board's people speak and name their places in (scripts/board-upstream.mjs adds the
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

// The town a region's ground holds and its board founds: an Old World city, a town of the peoples of the Americas in
// its own year (js/native-towns.js), or a town Spain or Portugal planted overseas, from its founding on
// (js/colonial-towns.js).
export function boardTownHeld(region) {
  return oldWorldCityHeld(region) ?? nativeTownHeld(region) ?? colonialTownHeld(region);
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

// One 32-bit hash of a pair of integers. Integer arithmetic only, so WGSL gives the same bits.
export function oldWorldHash(i, j, salt = 0) {
  let h = (Math.imul(i | 0, 0x27d4eb2d) ^ Math.imul(j | 0, 0x165667b1) ^ salt) | 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d);
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39);
  return (h ^ (h >>> 15)) >>> 0;
}
const unit = (h) => h / 4294967296;

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
  const key = runtimeBoardPortKey(region);
  return key ? bakedBoards.get(`${key}:${region.year ?? 1550}`) || null : null;
}
// A city on ground that holds it, with no board founded there: it has no town and no country, and says why once.
const unbakedSaid = new Set();
function unbakedCity(city, region, baked) {
  const key = `${region.id}:${region.year ?? 1550}`;
  if (unbakedSaid.has(key)) return;
  unbakedSaid.add(key);
  console.error(baked
    ? `${city.name}: its board of ${region.year ?? 1550} was founded on ${baked.board?.span} m of ground, not this ${region.span}; bake it again (node scripts/bake-board.mjs ${region.id})`
    : `${city.name} has no board for ${region.id} in ${region.year ?? 1550}: bake one (node scripts/bake-board.mjs ${region.id})`);
}

const RUNTIME_BOARD_CROWN = Object.freeze({
  spain: Object.freeze({ culture: 'iberian', manner: 'traza' }),
  portugal: Object.freeze({ culture: 'portuguese', manner: 'ladeira' }),
  england: Object.freeze({ culture: 'anglo', manner: null }),
  netherlands: Object.freeze({ culture: 'dutch', manner: null }),
  france: Object.freeze({ culture: 'french', manner: null }),
});
const RUNTIME_BOARD_WORK_KIND = Object.freeze({ tower: 'tower', 'artillery-tower': 'tower', battery: 'battery', enclosed: 'fort', bastioned: 'fort', citadel: 'fort' });
const RUNTIME_BOARD_WORK_SIZE = Object.freeze({ tower: [12, 12], 'artillery-tower': [22, 22], battery: [44, 14], enclosed: [52, 52], bastioned: [76, 76], citadel: [120, 120] });

function runtimeBoardNativeCulture(cultureId, latitude = 0) {
  switch (cultureId) {
    case 'abenaki-algonquian': return latitude >= 45.5 ? 'iroquoian' : 'massachusett';
    case 'mid-atlantic-algonquian': return latitude >= 38.6 ? 'lenape' : 'powhatan';
    case 'tupinamba-brazil-guiana': return 'tupi';
    case 'pacific-indigenous-coast': return latitude >= 20 ? 'powhatan' : 'taino';
    default: return 'taino';
  }
}

function runtimeBoardFoundingSite(heights, span, x, z) {
  const n = Math.round(Math.sqrt(heights.length)), step = span / Math.max(1, n - 1);
  const at = (i, j) => (i < 0 || j < 0 || i >= n || j >= n ? -1 : heights[j * n + i]);
  const clampX = Math.max(-span * 0.42, Math.min(span * 0.42, x));
  const clampZ = Math.max(-span * 0.42, Math.min(span * 0.42, z));
  const i0 = Math.round((clampX + span / 2) / step), j0 = Math.round((clampZ + span / 2) / step);
  if (at(i0, j0) >= 1) return { x: clampX, z: clampZ };
  const fits = (i, j) => at(i, j) >= 4 && [[-2, 0], [2, 0], [0, -2], [0, 2], [-2, -2], [2, 2], [-2, 2], [2, -2]].every(([di, dj]) => at(i + di, j + dj) > 1);
  let best = null, least = Infinity;
  for (let r = 0; r * step <= 2000 && r <= least; r++) for (let j = j0 - r; j <= j0 + r; j++) for (let i = i0 - r; i <= i0 + r; i++) {
    if (Math.max(Math.abs(i - i0), Math.abs(j - j0)) !== r || !fits(i, j)) continue;
    const d = Math.hypot(i - i0, j - j0);
    if (d < least) { least = d; best = { x: i * step - span / 2, z: j * step - span / 2 }; }
  }
  if (best) return best;
  for (let r = 0; r * step <= 2000 && r <= least; r++) for (let j = j0 - r; j <= j0 + r; j++) for (let i = i0 - r; i <= i0 + r; i++) {
    if (Math.max(Math.abs(i - i0), Math.abs(j - j0)) !== r || at(i, j) < 1.2) continue;
    const d = Math.hypot(i - i0, j - j0);
    if (d < least) { least = d; best = { x: i * step - span / 2, z: j * step - span / 2 }; }
  }
  return best ?? { x: clampX, z: clampZ };
}

export function runtimeBoardPortKey(region) {
  if (!region) return null;
  if (region.id) return region.id;
  if (Number.isFinite(region.latitude) && Number.isFinite(region.longitude)) {
    return `coast_${region.latitude.toFixed(3)}_${region.longitude.toFixed(3)}`;
  }
  return null;
}

// Builds a runtime Castle & Commons board request for any unbaked inhabited coast (native villages, non-1550 years,
// and English, Dutch, French, Spanish or Portuguese colonial ports); returns null on uninhabited pelagic shores.
export function runtimeBoardFor({ region, heights, port }) {
  if (!region || !heights || !port?.center || !Number.isFinite(region.latitude) || !Number.isFinite(region.longitude)) return null;
  const year = Math.round(region.year ?? 1550), span = region.span;
  const cos = Math.max(0.1, Math.cos(region.latitude * DEG));
  const east = (lon) => (lon - region.longitude) * cos * OLD_WORLD_METRES_PER_DEGREE;
  const south = (lat) => (region.latitude - lat) * OLD_WORLD_METRES_PER_DEGREE;
  const held = boardTownHeld(region);
  const indig = port.indigenousSettlement ?? null;
  const isColonial = Boolean(port.hasColonialPort);
  const isIndigenous = Boolean(!isColonial && indig?.hasIndigenousSettlement);
  if (!held && !isColonial && !isIndigenous) return null;

  let name, culture, seat, walls = null, manner = null, founded = null, settled = null, places = [];
  let rawX = port.center.x - (region.x ?? 0), rawZ = port.center.z - (region.z ?? 0);
  if (held) {
    const people = oldWorldPeople(held, year);
    name = held.name;
    culture = held.culture;
    seat = held.seat ?? boardSeat(people);
    walls = held.walls ?? null;
    manner = held.manner ?? null;
    founded = held.founded ?? null;
    settled = held.settled ?? null;
    places = (OLD_WORLD_PLACES[held.id] || held.places || []).map(([n, lat, lon, w]) => ({ name: n, x: east(lon), z: south(lat), weight: w }));
    if (held.native || held.colonial) { rawX = Math.round(east(held.longitude)); rawZ = Math.round(south(held.latitude)); }
  } else if (isColonial) {
    const crownKey = port.colonyGrowth?.crown ?? region.crown ?? 'spain';
    const crownSpec = RUNTIME_BOARD_CROWN[crownKey] ?? RUNTIME_BOARD_CROWN.spain;
    const people = Math.max(120, port.colonyGrowth?.population || 600);
    name = String(region.name || 'Port').split(' · ')[0];
    culture = crownSpec.culture;
    manner = crownSpec.manner;
    founded = port.colonyGrowth?.foundedYear ?? region.foundedYear ?? year;
    settled = Math.max(0.08, Math.min(0.65, 0.1 + Math.max(0, year - founded) / 220));
    seat = Math.max(0.05, Math.min(2.0, people / (manner ? 4500 : 12400)));
    walls = { capital: 0, town: 0, village: 0 };
  } else {
    const people = Math.max(180, indig.estimatedVillagePopulation || 300);
    culture = runtimeBoardNativeCulture(indig.cultureId, region.latitude);
    name = indig.capitalName || String(region.name || indig.shortName || 'Village').split(' · ')[0];
    seat = Math.max(0.28, Math.min(0.75, people / 750));
    walls = { capital: (indig.fortified || indig.isSovereignPolity || culture === 'tupi') ? 1 : 0, town: 0, village: 0 };
  }

  const works = [];
  if (isColonial || (held && !held.native)) {
    const named = new Set();
    for (const id of Object.keys(FORT_RECORDS)) for (const record of fortRecordsFor(id, year).forts) {
      const phase = fortPhaseFor(record, year);
      if (named.has(record.name) || !phase) continue;
      const wx = Math.round(east(record.lon)), wz = Math.round(south(record.lat));
      if (Math.abs(wx) >= span * 0.47 || Math.abs(wz) >= span * 0.47) continue;
      named.add(record.name);
      const form = phase.form, kind = RUNTIME_BOARD_WORK_KIND[form];
      const size = form === 'battery' ? [record.sizeM?.[0] ?? RUNTIME_BOARD_WORK_SIZE.battery[0], Math.min(16, Math.max(10, record.sizeM?.[1] ?? RUNTIME_BOARD_WORK_SIZE.battery[1]))]
        : form === 'tower' ? RUNTIME_BOARD_WORK_SIZE.tower
          : form === 'artillery-tower' ? (record.sizeM ?? (phase.battery ? [36, 40] : RUNTIME_BOARD_WORK_SIZE['artillery-tower']))
            : record.sizeM ?? RUNTIME_BOARD_WORK_SIZE[form];
      works.push({
        kind, form, ...(phase.round ? { round: true } : {}), ...(phase.battery ? { battery: true } : {}), ...(phase.earth ?? record.earth ? { earth: true } : {}),
        name: record.name, x: wx, z: wz, size, from: phase.from, until: record.until ?? null,
        role: record.role ?? '', side: record.side ?? '', ...(record.rough ? { rough: true } : {}),
        ...(record.landmark ? { landmark: record.landmark } : {}), ...(record.encloses ? { encloses: record.encloses } : {}), ...(record.gate ? { gate: record.gate } : {}),
      });
    }
  }

  const sitePos = runtimeBoardFoundingSite(heights, span, rawX, rawZ);
  const seed = (region.vegetationSeed ?? region.seed ?? ((Math.imul(Math.round(region.latitude * 1000), 73856093) ^ Math.imul(Math.round(region.longitude * 1000), 19349663)) >>> 0)) || 1550;
  const request = boardRequest({
    heights, span, seed, era: year, seat,
    ...(walls ? { walls } : {}),
    site: { name, culture, x: sitePos.x, z: sitePos.z },
    places,
    lived: false,
    ...(manner ? { manner, founded, settled } : founded != null ? { founded, settled } : {}),
    works,
    rivers: BOARD_RIVERS,
  });
  return { port: runtimeBoardPortKey(region) ?? 'coast', year, request, runtime: true, world: null };
}

// The country a board founded on a region's ground, or null where none stands and the rules of a wild shore hold.
// One is made per elevation field and kept, since land cover, ground colour and planting all ask.
export function oldWorldCountry(region, heights, port = null) {
  if (!region || !heights || !Number.isFinite(region.latitude) || !Number.isFinite(region.longitude)) return null;
  const kept = countries.get(heights);
  if (kept && kept.port === port) return kept.country;
  if (!inIberia(region.latitude, region.longitude) && !boardTownHeld(region) && !bakedBoardFor(region)) return null;
  const country = makeCountry(region, heights, port);
  countries.set(heights, { port, country });
  return country;
}

// Synchronizes cached country lookups and uncarved survey snapshots whenever a persistent `heights` buffer is
// replaced in-place (e.g. during a 1550 historical territory or real-DEM upgrade), preventing subsequent
// `oldWorldCountry` calls from reverting `heights` back to a stale pre-upgrade survey.
export function syncOldWorldHeights(heights, { surveyHeights = null, port = null, country = null } = {}) {
  if (!heights) return;
  countries.delete(heights);
  uncarvedSurveys.delete(heights);
  if (surveyHeights instanceof Float32Array && surveyHeights.length === heights.length) {
    uncarvedSurveys.set(heights, surveyHeights.slice());
  }
  if (country && port) {
    countries.set(heights, { port, country });
  }
}

export function refreshOldWorldBoardCountry(nextBoardJson, region, heights, port = null, surveyHeights = null) {
  if (!nextBoardJson || !region || !heights) return null;
  if (surveyHeights instanceof Float32Array && surveyHeights.length === heights.length && !uncarvedSurveys.has(heights)) {
    uncarvedSurveys.set(heights, surveyHeights.slice());
  }
  const baseBaked = bakedBoardFor(region);
  const nextBaked = {
    ...(baseBaked || { port: runtimeBoardPortKey(region) || 'lisbon', year: region.year ?? 1550 }),
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
  const held = boardTownHeld(region), city = held ?? oldWorldCityNear(region.latitude, region.longitude);
  const year = region.year ?? 1550;
  const people = city ? oldWorldPeople(city, year) : 0;
  // A native town stands by an anchorage, with no port cleared for it.
  const registered = bakedBoardFor(region);
  const holdsCity = Boolean((held || registered) && port && (port.clearRadius > 0 || held?.native || registered) && port.center);
  // The city is its board, founded for this port on the ground the game makes for it (scripts/bake-board.mjs) or
  // founded at runtime by the board worker. Ground with no board standing has no country.
  const baked = explicitBaked ?? (holdsCity ? registered : null);
  const standsBoard = Boolean(baked && baked.board?.span === region.span);
  if (uncarvedSurveys.has(heights)) heights.set(uncarvedSurveys.get(heights));
  if (!standsBoard) {
    if (holdsCity) unbakedCity(city, region, baked);
    return null;
  }
  if (!uncarvedSurveys.has(heights)) uncarvedSurveys.set(heights, heights.slice());
  const marked = () => { const w = new Uint8Array(heights.length); for (let k = 0; k < w.length; k++) w[k] = heights[k] <= 0.25 ? 1 : 0; return w; };
  const stood = layBoardCountry({ baked, region, grid, heights, heightAt, port, wet: marked(), LAND: OLD_WORLD_LAND, fieldAt, distanceTo });
  const { town, roads, plan, parcelAt } = stood, inland = town.inland;
  const beyondTown = (x, z) => fieldAt(town.beyond, grid, x, z);
  const roadNear = roads.length ? indexRoads(roads, region) : null;
  // Trees line a road near the town and by stretches beyond it.
  const roadLined = (way, x, z) => beyondTown(x, z) < 600 || unit(oldWorldHash(way.id, Math.floor(way.arc / 260), 0x2ffd72db)) < 0.5;
  const VEGETATION = [0, 0.24, 0.28, 0, 0, 0, 0, 0, 0.96];
  const SOME_TREES = 0.19;

  // What stands at a point of dry ground: its use, and how much of it bears trees (as the vegetation mask counts it).
  // A board's country keeps the colours of its geography: its parcels, roads and town ground are stamped onto them by
  // the GPU (js/board-stamp.js). Here only what bears trees is said, for the forest and the planting.
  const landAt = (x, z, slope = 0) => {
    const hold = parcelAt(x, z), use = hold.use;
    const urban = fieldAt(town.urban, grid, x, z);
    let kind = use.kind;
    // A furlong cannot farm a cliff: its steep corners go back to scrub.
    if (slope > 0.44 && kind !== OLD_WORLD_LAND.WOOD) kind = OLD_WORLD_LAND.SCRUB;
    if (urban >= 0.5) kind = OLD_WORLD_LAND.CITY;
    let vegetation = VEGETATION[kind];
    if (kind === OLD_WORLD_LAND.CITY) vegetation = plan.treesAt(x, z) !== CITY_TREES.NONE ? SOME_TREES : 0;
    else {
      if (hold.woodEdge > 0 && (kind === OLD_WORLD_LAND.PASTURE || kind === OLD_WORLD_LAND.SCRUB || kind === OLD_WORLD_LAND.FALLOW)) {
        vegetation = Math.max(vegetation, 0.18 + hold.woodEdge * 0.08);
      }
      if (use.hedged && hold.edge < 10) vegetation = Math.max(vegetation, SOME_TREES);
    }
    // Preserve walled gardens and olive groves right outside the town walls instead of attenuating them below biome < 42.
    if (urban > 0 && urban < 0.5 && kind !== OLD_WORLD_LAND.GARDEN && kind !== OLD_WORLD_LAND.OLIVES) {
      vegetation *= 1 - urban * 2;
    }
    const way = kind !== OLD_WORLD_LAND.CITY && kind !== OLD_WORLD_LAND.WOOD && roadNear ? roadNear(x, z) : null;
    if (way && way.distance < 14 && roadLined(way, x, z)) vegetation = Math.max(vegetation, SOME_TREES);
    return { kind, vegetation };
  };

  // How trees stand on tended ground: far apart, kept to size, of the kinds a farmer plants, and
  // in lines along a boundary or a road. Null on wild ground, where the forest's own rules hold;
  // NO_TREES where none may stand.
  // `height` is how tall the tree is kept, in metres: the least, and how much more the tallest stands. A
  // forest pack of full-grown trees is drawn to it (js/terrain.js), so an olive or a yard tree is a grown
  // tree's shape at an orchard tree's size. `scale` is the same for a pack of young trees: a share of the
  // prototype, least and range.
  const NO_TREES = OLD_WORLD_NO_TREES;
  const GARDEN_TREES = { spacing: 12, height: [7.2, 4.2], scale: [0.55, 0.25], species: ['oak', 'chestnut', 'maple', 'birch'], cohort: 'veteran', tint: [0.94, 0.98, 0.92] };
  const OLIVE_TREES = { spacing: 10.5, height: [10.0, 3.8], scale: [0.58, 0.22], species: ['oak'], cohort: 'veteran', tint: [0.86, 0.94, 0.9] };
  const WOOD_EDGE = { spacing: 6.2, height: [10.2, 6.0], scale: [0.56, 0.32], species: ['birch', 'oak', 'maple', 'chestnut'], cohort: 'veteran', tint: [0.94, 0.99, 0.9] };
  const HEDGEROW = { spacing: 10, height: [11.5, 6.0], scale: [0.7, 0.35], species: ['elm', 'chestnut', 'maple'], cohort: 'veteran', tint: [0.96, 1, 0.92] };
  const ROADSIDE = { spacing: 11, height: [14.0, 8.0], scale: [0.85, 0.38], species: ['elm', 'maple', 'oak'], cohort: 'veteran', tint: [0.96, 1, 0.92] };
  // In the town: a ring of shade trees round a square, a walled garden's orchard, a tree in a yard.
  const SQUARE_TREES = { spacing: 9, height: [11.5, 5.0], scale: [0.64, 0.25], species: ['maple', 'oak', 'elm'], cohort: 'veteran', tint: [0.96, 1, 0.92] };
  const PARK_TREES = { spacing: 8, height: [10.5, 5.5], scale: [0.58, 0.28], species: ['maple', 'birch', 'oak', 'chestnut'], cohort: 'veteran', tint: [0.94, 1, 0.9] };
  const YARD_TREES = { spacing: 13, height: [6.8, 3.8], scale: [0.55, 0.25], species: ['oak', 'maple', 'birch'], cohort: 'veteran', tint: [0.94, 0.98, 0.92] };
  const treesAt = (x, z) => {
    if (fieldAt(inland, grid, x, z) < 4) return NO_TREES;
    if (fieldAt(town.urban, grid, x, z) >= 0.5) {
      const where = plan.treesAt(x, z);
      return where === CITY_TREES.SQUARE ? SQUARE_TREES : where === CITY_TREES.PARK ? PARK_TREES : where === CITY_TREES.YARD ? YARD_TREES : NO_TREES;
    }
    const way = roadNear ? roadNear(x, z) : null;
    if (way && way.distance < 4) return NO_TREES;
    const hold = parcelAt(x, z), use = hold.use;
    if (use.kind === OLD_WORLD_LAND.WOOD) return null;
    if (way && way.distance < 8.5 && roadLined(way, x, z)) return ROADSIDE;
    if (use.hedged && hold.edge < 3.2) return HEDGEROW;
    if (hold.woodEdge > 0 && (use.kind === OLD_WORLD_LAND.PASTURE || use.kind === OLD_WORLD_LAND.SCRUB || use.kind === OLD_WORLD_LAND.FALLOW)) return WOOD_EDGE;
    return use.kind === OLD_WORLD_LAND.GARDEN ? GARDEN_TREES : use.kind === OLD_WORLD_LAND.OLIVES ? OLIVE_TREES : NO_TREES;
  };

  return { city, people, year, town, roads, plan, grid, inland, landAt, treesAt, beyondTown, board: stood.stamp, places: stood.places, watch: stood.watch, works: stood.works, waterfront: stood.waterfront, furniture: stood.furniture ?? [], landmarks: stood.landmarks, inlandWater: stood.inlandWater, ponds: stood.ponds, herds: stood.herds, loneTrees: stood.loneTrees, bridges: stood.bridges, riverCut: stood.riverCut, riverReaches: stood.riverReaches };
}

// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The towns of the peoples of the Americas that stood where this game's ports were later planted, as they stood in
// 1550, each founded by Castle and Commons' model in its people's own ways (scripts/board-native.mjs) and baked as
// an Old World city is (scripts/bake-board.mjs; js/old-world.js stands it). A port of these is no port yet: the
// coast is an anchorage, and the town is its board. After the colony's founding the port is the colony's.
//   `port` is the coast (js/coastal-world.js) whose ground holds the town and under whose name its board is baked;
//   `culture` the people's tongue in the model; `people` by year, as for an Old World city; `seat` how many times the
//   model's capital the town is (its people are the model's capital times its people's scale, in board-native.mjs);
//   `walls` what each kind of its places is ringed by (1 a palisade); `places` real neighbours, as OLD_WORLD_PLACES.
// Sources: Cartier's relations (1535, Stadacona); Champlain and Gookin (the Massachusett and Patuxet before 1617);
// Van der Donck and Lindeström (the Lenape of Manhattan and the Delaware); Smith and Strachey (the Paspahegh);
// Staden (1557) and Léry (1578) (the Tupinambá of Guanabara). Counts are judgements of the period's estimates.
export const NATIVE_TOWNS = Object.freeze([
  { id: 'stadacona', name: 'Stadacona', port: 'quebec', latitude: 46.818, longitude: -71.218, culture: 'iroquoian', people: [[1550, 600]], seat: 0.4, walls: { capital: 1, town: 1, village: 0 } },
  { id: 'mishawum', name: 'Mishawum', port: 'boston', latitude: 42.372, longitude: -71.062, culture: 'massachusett', people: [[1550, 300]], seat: 0.4, walls: { capital: 0, town: 0, village: 0 } },
  { id: 'patuxet', name: 'Patuxet', port: 'plymouth-colony', latitude: 41.957, longitude: -70.666, culture: 'massachusett', people: [[1550, 450]], seat: 0.6, walls: { capital: 0, town: 0, village: 0 } },
  { id: 'werpoes', name: 'Werpoes', port: 'new-amsterdam', latitude: 40.716, longitude: -74.002, culture: 'lenape', people: [[1550, 300]], seat: 0.4, walls: { capital: 0, town: 0, village: 0 } },
  { id: 'shackamaxon', name: 'Shackamaxon', port: 'philadelphia', latitude: 39.969, longitude: -75.128, culture: 'lenape', people: [[1550, 300]], seat: 0.4, walls: { capital: 0, town: 0, village: 0 } },
  { id: 'paspahegh', name: 'Paspahegh', port: 'jamestown', latitude: 37.226, longitude: -76.800, culture: 'powhatan', people: [[1550, 300]], seat: 0.4, walls: { capital: 1, town: 0, village: 0 } },
  { id: 'urucumirim', name: 'Uruçumirim', port: 'rio-de-janeiro', latitude: -22.925, longitude: -43.176, culture: 'tupi', people: [[1550, 600]], seat: 0.5, walls: { capital: 1, town: 1, village: 1 } },
].map((town) => Object.freeze({ ...town, native: true, people: Object.freeze(town.people.map(Object.freeze)), walls: Object.freeze(town.walls) })));
// The last year each stands as its own: from the colony's founding the ground is the colony's.
const NATIVE_TOWN_UNTIL = 1550;
const NATIVE_METRES_PER_DEGREE = 111195;

// The native town whose recorded site lies on a region's own ground in its year, or none: the town its board founds there.
export function nativeTownHeld(region) {
  if (!region || !Number.isFinite(region.latitude) || !Number.isFinite(region.longitude) || (region.year ?? 1550) > NATIVE_TOWN_UNTIL) return null;
  const geoSpan = region.demGeoSpan || (region.span < 4000 ? 6800 : region.span), scale = region.span / geoSpan, half = region.span / 2;
  const cos = Math.max(0.1, Math.cos(region.latitude * Math.PI / 180));
  let best = null, least = Infinity;
  for (const town of NATIVE_TOWNS) {
    if (region.id && region.id !== town.port) continue;
    const x = (town.longitude - region.longitude) * NATIVE_METRES_PER_DEGREE * cos * scale, z = (region.latitude - town.latitude) * NATIVE_METRES_PER_DEGREE * scale;
    if (Math.abs(x) >= half || Math.abs(z) >= half) continue;
    if (Math.hypot(x, z) < least) { least = Math.hypot(x, z); best = town; }
  }
  return best;
}

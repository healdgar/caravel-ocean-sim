// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The board: a coast's towns, roads, fields and people, as Castle and Commons' own generator founds them on this
// game's ground. The generator is that game's whole program (assets/board/game.js), tuned by scripts/board-tuning.mjs and
// driven by assets/board/runtime.js; it takes a minute or more to found a country, so it never runs on the page's own thread.
// This module is what both sides share: what to ask of the model, and the words that set it up before it runs.

export const BOARD_VERSION = 3;
// The source houses four people to a building and stops a capital at 620 buildings. A town house of this game's
// port cities stands several storeys and holds some twenty.
export const BOARD_PEOPLE_PER_BUILDING = 20;
export const BOARD_SOURCE_CAPITAL_BUILDINGS = 620;
export const BOARD_SEAT_RANGE = Object.freeze([0.25, 8]);
// Water fitted to surveyed ground. A watercourse runs where this much ground (square metres) drains to it; it is
// `width` metres across for each root square kilometre drained, never less than twice `least`; and of the bed the
// source would cut, this share is cut, the survey having its valleys already.
export const BOARD_RIVERS = Object.freeze({ catchment: 1.0e6, width: 2.2, least: 1.2, carve: 0.3 });

// How many times the source's capital a seat of so many people is.
export function boardSeat(people) {
  const seat = people / BOARD_PEOPLE_PER_BUILDING / BOARD_SOURCE_CAPITAL_BUILDINGS;
  return Math.max(BOARD_SEAT_RANGE[0], Math.min(BOARD_SEAT_RANGE[1], Number.isFinite(seat) ? seat : 1));
}

// What is asked of the model for one ground. `heights` are this game's: a square of samples from edge to edge of
// `span` metres, row by row from the north, in metres above the sea. The model reads a survey as cells, each height
// at a cell's middle, so the square is handed over as the means of its meshes. `site` is where the seat stands, in
// metres east and south of the ground's middle; `places` are the towns and villages that really stood round it
// ({name, x, z, weight}: 1 to 3 as the source weighs a town it may or may not found, up to 9 for one it should),
// which the model's founders favour and whose names its places take. `lived` founds the realm in 850 and lets it
// live every day to `era` (hours of work for a city: only ever for a board baked ahead).
export function boardRequest({ heights, span, site, seed, era = 1550, seat = 1, walls = { capital: 2, town: 1, village: 0 }, fate = 1, places = [], rivers = BOARD_RIVERS, lived = false }) {
  const n = Math.round(Math.sqrt(heights.length));
  if (n * n !== heights.length || n < 3) throw new Error('A board is founded on a square of heights');
  const size = n - 1, survey = new Float32Array(size * size);
  for (let j = 0; j < size; j++) for (let i = 0; i < size; i++) {
    const k = j * n + i;
    survey[j * size + i] = (heights[k] + heights[k + 1] + heights[k + n] + heights[k + n + 1]) / 4;
  }
  return {
    version: BOARD_VERSION, span, size, heights: survey, seed: seed >>> 0, fate: fate >>> 0, era: Math.round(era),
    seat: Math.round(seat * 1000) / 1000, walls: { capital: walls.capital | 0, town: walls.town | 0, village: walls.village | 0 },
    site: { name: String(site.name || 'Seat'), culture: String(site.culture || 'iberian'), x: Math.round(site.x * 10) / 10, z: Math.round(site.z * 10) / 10 },
    places: places.filter((p) => Math.abs(p.x) < span * 0.47 && Math.abs(p.z) < span * 0.47)
      .map((p) => ({ name: String(p.name), x: Math.round(p.x), z: Math.round(p.z), weight: Math.max(1, Math.min(9, p.weight | 0 || 1)) })),
    rivers: { catchment: Math.round(rivers.catchment), width: +rivers.width, least: +rivers.least, carve: +rivers.carve },
    lived: Boolean(lived),
  };
}

// A name for a request that two requests share only if the model would found the same board for both: the ground
// to the centimetre, and everything else asked.
export function boardKey(request) {
  let a = 0x811c9dc5, b = 0x9e3779b9;
  const mix = (v) => { a = Math.imul(a ^ v, 0x01000193) >>> 0; b = (Math.imul(b ^ (v + 0x7f4a7c15), 0x85ebca6b) + (b << 13 | b >>> 19)) >>> 0; };
  for (let k = 0; k < request.heights.length; k++) mix(Math.round(request.heights[k] * 100) | 0);
  const rest = JSON.stringify([request.version, request.span, request.size, request.seed, request.fate, request.era, request.seat, request.walls, request.site, request.places, request.rivers, request.lived]);
  for (let k = 0; k < rest.length; k++) mix(rest.charCodeAt(k));
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

// A short name for a ground alone, to the decimetre: a baked board says which ground it was founded on, and the page
// says so if the ground it now has is another.
export function boardGroundDigest(heights) {
  let a = 0x811c9dc5, b = 0x9e3779b9;
  for (let k = 0; k < heights.length; k++) {
    const v = Math.round(heights[k] * 10) | 0;
    a = Math.imul(a ^ v, 0x01000193) >>> 0; b = (Math.imul(b ^ (v + 0x7f4a7c15), 0x85ebca6b) + (b << 13 | b >>> 19)) >>> 0;
  }
  return a.toString(16).padStart(8, '0') + b.toString(16).padStart(8, '0');
}

// A ground in brief: its heights at a lattice of 33 by 33, to the decimetre. A baked board carries the survey of the
// ground it was founded on, and stands only on ground that agrees with it: the same coast made again, to a little
// more than a metre on the mean, whatever its lattice; never a coast made by other rules.
export const BOARD_SURVEY_SIZE = 33;
export function boardGroundSurvey(heights) {
  const n = Math.round(Math.sqrt(heights.length)), out = [];
  for (let j = 0; j < BOARD_SURVEY_SIZE; j++) for (let i = 0; i < BOARD_SURVEY_SIZE; i++) {
    const row = Math.round(j * (n - 1) / (BOARD_SURVEY_SIZE - 1)), column = Math.round(i * (n - 1) / (BOARD_SURVEY_SIZE - 1));
    out.push(Math.round(heights[row * n + column] * 10) / 10);
  }
  return out;
}
export function boardGroundFits(survey, heights, withinMetres = 1.5) {
  if (!survey || survey.length !== BOARD_SURVEY_SIZE * BOARD_SURVEY_SIZE) return false;
  const now = boardGroundSurvey(heights);
  let off = 0;
  for (let k = 0; k < now.length; k++) off += Math.abs(now[k] - survey[k]);
  return off / now.length < withinMetres;
}

// The boards founded ahead of time (scripts/bake-board.mjs), by port and year, and where each is kept.
export const BAKED_BOARDS = Object.freeze({ 'lisbon:1550': 'assets/boards/lisbon-1550.json' });
export function bakedBoardAsset(port, year) { return BAKED_BOARDS[`${port}:${year}`] ?? null; }
// And the whole world each was founded as: the model's own save of everything it holds, frozen on its first day.
// The game takes it up in a worker and lets it live; nothing of it was chosen or left out.
export const BAKED_WORLDS = Object.freeze({ 'lisbon:1550': 'assets/boards/lisbon-1550.world' });
export function bakedWorldAsset(port, year) { return BAKED_WORLDS[`${port}:${year}`] ?? null; }

function boardBase64(bytes) {
  let text = '';
  for (let k = 0; k < bytes.length; k += 0x8000) text += String.fromCharCode.apply(null, bytes.subarray(k, k + 0x8000));
  return btoa(text);
}

// The words that go before the model's program: what it is to found, read by it as it loads. `program` is the
// hash of the program's own text, under which a world is frozen and taken up again. A request with no heights is
// for a world to be taken up frozen: its ground comes with it.
export function boardPrefix(request, program = null) {
  const options = {
    hash: `#s=${request.seed}&f=${request.fate}&c=sea&y=${request.era}&map=board&worker=off`,
    board: { spanMetres: request.span, seat: request.seat, walls: request.walls, rivers: request.rivers, lived: request.lived, program },
  };
  const at = (name, x, z, weight) => ({ n: name, u: x / request.span, v: z / request.span, c: request.site.culture, w: weight });
  const sites = [at(request.site.name, request.site.x, request.site.z, 300), ...request.places.map((p) => at(p.name, p.x, p.z, p.weight))];
  const heights = request.heights
    ? `new Float32Array(Uint8Array.from(atob('${boardBase64(new Uint8Array(request.heights.buffer, request.heights.byteOffset, request.heights.byteLength))}'),c=>c.charCodeAt(0)).buffer)`
    : `new Float32Array(${request.size * request.size})`;
  return 'globalThis.FURLONG_HEADLESS=true;globalThis.FURLONG_OPTIONS=' + JSON.stringify(options) + ';' +
    `globalThis.KA_MAPS={board:{w:${request.size},h:${request.size},hgt:${heights},` +
    `vscale:1,crown:${JSON.stringify(request.site.culture)},sites:${JSON.stringify(sites)},title:${JSON.stringify(request.site.name)}}};\n`;
}

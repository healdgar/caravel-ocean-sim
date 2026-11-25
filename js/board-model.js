// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The board: a coast's towns, roads, fields and people, as Castle and Commons' own generator founds them on this
// game's ground. The generator is that game's whole program (assets/board/game.js), fitted by scripts/board-tuning.mjs,
// extended by scripts/board-upstream.mjs and driven by assets/board/runtime.js; it takes a minute or more to found a country, so it never runs on the page's own thread.
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
// live every day to `era` (hours of work for a city: only ever for a board baked ahead). A colony's seat says the
// `manner` its crown planted its towns by ('traza', 'ladeira': scripts/board-colonial.mjs), the year it was `founded`,
// and how `settled` its country was (0 to 1 of an Old World country's towns and villages). `works` are the forts,
// batteries and watchtowers the record says stood on this ground ({kind: 'fort', 'battery' or 'tower', form (its form in
// the year: js/fort-records.js FORT_FORMS), round, battery (a battery at a gun tower's foot), earth, name, x, z, size:
// [across, deep], from, until, role, side, rough}), which the model sets on their ground before its towns are laid
// and stands as buildings of the nearest place (scripts/board-forts.mjs).
export const BOARD_WORK_KINDS = Object.freeze(['fort', 'battery', 'tower']);
export function boardRequest({ heights, span, site, seed, era = 1550, seat = 1, walls = { capital: 2, town: 1, village: 0 }, fate = 1, places = [], rivers = BOARD_RIVERS, lived = false, manner = null, founded = null, settled = null, works = [] }) {
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
    lived: typeof lived === 'number' && Number.isFinite(lived) && lived > 0 ? Math.round(lived) : Boolean(lived),
    ...(manner ? { manner: String(manner), founded: Math.round(founded ?? era), settled: Math.max(0, Math.min(1, settled ?? 1)) } : founded != null ? { founded: Math.round(founded), settled: Math.max(0, Math.min(1, settled ?? 1)) } : {}),
    ...((kept) => (kept.length ? { works: kept } : {}))(boardWorks(works, span)),
  };
}
// A request's works as the model is asked for them: on the ground, of a kind it knows, each to the metre.
function boardWorks(works, span) {
  return works.filter((w) => BOARD_WORK_KINDS.includes(w.kind) && Math.abs(w.x) < span * 0.47 && Math.abs(w.z) < span * 0.47).map((w) => ({
    kind: w.kind, name: String(w.name), x: Math.round(w.x), z: Math.round(w.z),
    size: [Math.round(Math.max(6, w.size?.[0] ?? 40)), Math.round(Math.max(6, w.size?.[1] ?? w.size?.[0] ?? 40))],
    from: w.from ?? null, until: w.until ?? null, role: String(w.role || ''), side: String(w.side || ''),
    form: String(w.form || (w.kind === 'battery' ? 'battery' : w.kind === 'tower' ? 'tower' : 'enclosed')),
    ...(w.round ? { round: true } : {}), ...(w.battery ? { battery: true } : {}), ...(w.earth ? { earth: true } : {}), ...(w.rough ? { rough: true } : {}),
    ...(w.landmark ? { landmark: String(w.landmark) } : {}), ...(w.encloses ? { encloses: String(w.encloses) } : {}), ...(w.gate ? { gate: String(w.gate) } : {}),
  }));
}

// A name for a request that two requests share only if the model would found the same board for both: the ground
// to the centimetre, and everything else asked.
export function boardKey(request) {
  let a = 0x811c9dc5, b = 0x9e3779b9;
  const mix = (v) => { a = Math.imul(a ^ v, 0x01000193) >>> 0; b = (Math.imul(b ^ (v + 0x7f4a7c15), 0x85ebca6b) + (b << 13 | b >>> 19)) >>> 0; };
  for (let k = 0; k < request.heights.length; k++) mix(Math.round(request.heights[k] * 100) | 0);
  const rest = JSON.stringify([request.version, request.span, request.size, request.seed, request.fate, request.era, request.seat, request.walls, request.site, request.places, request.rivers, request.lived,
    ...(request.manner ? [request.manner, request.founded, request.settled] : request.founded != null ? [null, request.founded, request.settled] : []), ...(request.works?.length ? [request.works] : [])]);
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
// ground it was founded on. The board is the city: it stands on its port's ground whenever the game makes it, and
// the bake reads that ground back from the game and checks it agrees (scripts/bake-board.mjs): the same coast made
// again, to a little more than a metre on the mean, whatever its lattice.
export const BOARD_SURVEY_SIZE = 33;
export function boardGroundSurvey(heights) {
  const n = Math.round(Math.sqrt(heights.length)), out = [];
  for (let j = 0; j < BOARD_SURVEY_SIZE; j++) for (let i = 0; i < BOARD_SURVEY_SIZE; i++) {
    const row = Math.round(j * (n - 1) / (BOARD_SURVEY_SIZE - 1)), column = Math.round(i * (n - 1) / (BOARD_SURVEY_SIZE - 1));
    out.push(Math.round(heights[row * n + column] * 10) / 10);
  }
  return out;
}
// How far a ground lies from a survey, in metres on the mean; Infinity for no survey.
export function boardGroundOff(survey, heights) {
  if (!survey || survey.length !== BOARD_SURVEY_SIZE * BOARD_SURVEY_SIZE) return Infinity;
  const now = boardGroundSurvey(heights);
  let off = 0;
  for (let k = 0; k < now.length; k++) off += Math.abs(now[k] - survey[k]);
  return off / now.length;
}
export function boardGroundFits(survey, heights, withinMetres = 1.5) {
  return boardGroundOff(survey, heights) < withinMetres;
}

// The boards founded ahead of time (scripts/bake-board.mjs), by port and year, and where each is kept: one for every
// Old World city with ground of the game's making (js/old-world.js OLD_WORLD_CITIES, by its `port`), every town of
// the Americas (js/native-towns.js) and every town Spain and Portugal planted (js/colonial-towns.js). Spelled out,
// since the build publishes the files named here.
export const BAKED_BOARDS = Object.freeze({
  'lisbon:1550': 'assets/boards/lisbon-1550.json',
  'lisbon:1650': 'assets/boards/lisbon-1650.json',
  'cadiz:1550': 'assets/boards/cadiz-1550.json',
  'sanlucar:1550': 'assets/boards/sanlucar-1550.json',
  'palos-huelva:1550': 'assets/boards/palos-huelva-1550.json',
  'huelva:1550': 'assets/boards/huelva-1550.json',
  'la-coruna:1550': 'assets/boards/la-coruna-1550.json',
  'setubal:1550': 'assets/boards/setubal-1550.json',
  'seville:1550': 'assets/boards/seville-1550.json',
  'porto:1550': 'assets/boards/porto-1550.json',
  'cadiz-sanlucar:1550': 'assets/boards/cadiz-sanlucar-1550.json',
  // The towns of the peoples of the Americas in 1550 (js/native-towns.js), by the port later planted there.
  'quebec:1550': 'assets/boards/quebec-1550.json',
  'boston:1550': 'assets/boards/boston-1550.json',
  'plymouth-colony:1550': 'assets/boards/plymouth-colony-1550.json',
  'new-amsterdam:1550': 'assets/boards/new-amsterdam-1550.json',
  'philadelphia:1550': 'assets/boards/philadelphia-1550.json',
  'jamestown:1550': 'assets/boards/jamestown-1550.json',
  'jamestown:1607': 'assets/boards/jamestown-1607.json',
  'rio-de-janeiro:1550': 'assets/boards/rio-de-janeiro-1550.json',
  // The towns Spain and Portugal had planted by 1550 (js/colonial-towns.js), by their ports.
  'santo-domingo:1550': 'assets/boards/santo-domingo-1550.json',
  'havana:1550': 'assets/boards/havana-1550.json',
  // Havana in 1600: the castle duel's place (js/castle-duel.js), the Morro and La Punta across its mouth.
  'havana:1600': 'assets/boards/havana-1600.json',
  'san-juan:1550': 'assets/boards/san-juan-1550.json',
  'cartagena:1550': 'assets/boards/cartagena-1550.json',
  'nombre-de-dios:1550': 'assets/boards/nombre-de-dios-1550.json',
  'veracruz:1550': 'assets/boards/veracruz-1550.json',
  'campeche:1550': 'assets/boards/campeche-1550.json',
  'santa-marta:1550': 'assets/boards/santa-marta-1550.json',
  'cumana:1550': 'assets/boards/cumana-1550.json',
  'coro:1550': 'assets/boards/coro-1550.json',
  'panama-viejo:1550': 'assets/boards/panama-viejo-1550.json',
  'acapulco:1550': 'assets/boards/acapulco-1550.json',
  'santiago-de-cuba:1550': 'assets/boards/santiago-de-cuba-1550.json',
  'trujillo:1550': 'assets/boards/trujillo-1550.json',
  'callao:1550': 'assets/boards/callao-1550.json',
  'las-palmas:1550': 'assets/boards/las-palmas-1550.json',
  'tenerife:1550': 'assets/boards/tenerife-1550.json',
  'funchal:1550': 'assets/boards/funchal-1550.json',
  'angra:1550': 'assets/boards/angra-1550.json',
  'ribeira-grande:1550': 'assets/boards/ribeira-grande-1550.json',
  'salvador-da-bahia:1550': 'assets/boards/salvador-da-bahia-1550.json',
  'sao-vicente:1550': 'assets/boards/sao-vicente-1550.json',
  'olinda:1550': 'assets/boards/olinda-1550.json',
  'goa:1550': 'assets/boards/goa-1550.json',
  'malacca:1550': 'assets/boards/malacca-1550.json',
  'malacca:1600': 'assets/boards/malacca-1600.json',
  'nagasaki:1550': 'assets/boards/nagasaki-1550.json',
});
export function bakedBoardAsset(port, year, { exact = false } = {}) {
  if (typeof port !== 'string' || !port) return null;
  if (exact) return BAKED_BOARDS[`${port}:${year}`] ?? null;
  const resolved = resolveBakedBoardYear(port, year, BAKED_BOARDS);
  return resolved != null ? BAKED_BOARDS[`${port}:${resolved}`] ?? null : null;
}
// And the whole world each was founded as: the model's own save of everything it holds, frozen on its first day.
// The game takes it up in a worker and lets it live; nothing of it was chosen or left out.
export const BAKED_WORLDS = Object.freeze({
  'lisbon:1550': 'assets/boards/lisbon-1550.world',
  'lisbon:1650': 'assets/boards/lisbon-1650.world',
  'cadiz:1550': 'assets/boards/cadiz-1550.world',
  'sanlucar:1550': 'assets/boards/sanlucar-1550.world',
  'palos-huelva:1550': 'assets/boards/palos-huelva-1550.world',
  'huelva:1550': 'assets/boards/huelva-1550.world',
  'la-coruna:1550': 'assets/boards/la-coruna-1550.world',
  'setubal:1550': 'assets/boards/setubal-1550.world',
  'seville:1550': 'assets/boards/seville-1550.world',
  'porto:1550': 'assets/boards/porto-1550.world',
  'cadiz-sanlucar:1550': 'assets/boards/cadiz-sanlucar-1550.world',
  'quebec:1550': 'assets/boards/quebec-1550.world',
  'boston:1550': 'assets/boards/boston-1550.world',
  'plymouth-colony:1550': 'assets/boards/plymouth-colony-1550.world',
  'new-amsterdam:1550': 'assets/boards/new-amsterdam-1550.world',
  'philadelphia:1550': 'assets/boards/philadelphia-1550.world',
  'jamestown:1550': 'assets/boards/jamestown-1550.world',
  'jamestown:1607': 'assets/boards/jamestown-1607.world',
  'rio-de-janeiro:1550': 'assets/boards/rio-de-janeiro-1550.world',
  'santo-domingo:1550': 'assets/boards/santo-domingo-1550.world',
  'havana:1550': 'assets/boards/havana-1550.world',
  'havana:1600': 'assets/boards/havana-1600.world',
  'san-juan:1550': 'assets/boards/san-juan-1550.world',
  'cartagena:1550': 'assets/boards/cartagena-1550.world',
  'nombre-de-dios:1550': 'assets/boards/nombre-de-dios-1550.world',
  'veracruz:1550': 'assets/boards/veracruz-1550.world',
  'campeche:1550': 'assets/boards/campeche-1550.world',
  'santa-marta:1550': 'assets/boards/santa-marta-1550.world',
  'cumana:1550': 'assets/boards/cumana-1550.world',
  'coro:1550': 'assets/boards/coro-1550.world',
  'panama-viejo:1550': 'assets/boards/panama-viejo-1550.world',
  'acapulco:1550': 'assets/boards/acapulco-1550.world',
  'santiago-de-cuba:1550': 'assets/boards/santiago-de-cuba-1550.world',
  'trujillo:1550': 'assets/boards/trujillo-1550.world',
  'callao:1550': 'assets/boards/callao-1550.world',
  'las-palmas:1550': 'assets/boards/las-palmas-1550.world',
  'tenerife:1550': 'assets/boards/tenerife-1550.world',
  'funchal:1550': 'assets/boards/funchal-1550.world',
  'angra:1550': 'assets/boards/angra-1550.world',
  'ribeira-grande:1550': 'assets/boards/ribeira-grande-1550.world',
  'salvador-da-bahia:1550': 'assets/boards/salvador-da-bahia-1550.world',
  'sao-vicente:1550': 'assets/boards/sao-vicente-1550.world',
  'olinda:1550': 'assets/boards/olinda-1550.world',
  'goa:1550': 'assets/boards/goa-1550.world',
  'malacca:1550': 'assets/boards/malacca-1550.world',
  'malacca:1600': 'assets/boards/malacca-1600.world',
  'nagasaki:1550': 'assets/boards/nagasaki-1550.world',
});
function indexBakedEpochs(table) {
  const byPort = new Map();
  for (const key of Object.keys(table)) {
    const sep = key.lastIndexOf(':');
    if (sep <= 0) continue;
    const port = key.slice(0, sep), y = Number(key.slice(sep + 1));
    if (!Number.isFinite(y)) continue;
    let years = byPort.get(port);
    if (!years) { years = []; byPort.set(port, years); }
    years.push(y);
  }
  for (const years of byPort.values()) years.sort((a, b) => a - b);
  return byPort;
}
const BAKED_BOARD_EPOCHS = indexBakedEpochs(BAKED_BOARDS);
const BAKED_WORLD_EPOCHS = indexBakedEpochs(BAKED_WORLDS);

function pickBakedEpochYear(years, year) {
  if (!years?.length) return null;
  let best = null;
  for (let i = 0; i < years.length; i++) {
    const y = years[i];
    if (y === year) return y;
    if (y <= year) best = y;
    else break;
  }
  return best ?? years[0];
}

// Resolve a port's baked epoch for `year`: exact match if present, else the closest baked epoch <= year,
// else the earliest baked epoch for that port (null if the port has no baked boards at all).
// `source` may be a table object (default BAKED_BOARDS), a Map, or an iterable of `${port}:${year}` keys.
export function resolveBakedBoardYear(port, year, source = BAKED_BOARDS) {
  if (typeof port !== 'string' || !port) return null;
  const target = year == null || year === '' ? NaN : Number(year);
  if (!Number.isFinite(target)) return null;
  if (source === BAKED_BOARDS) return pickBakedEpochYear(BAKED_BOARD_EPOCHS.get(port), target);
  if (source === BAKED_WORLDS) return pickBakedEpochYear(BAKED_WORLD_EPOCHS.get(port), target);
  if (!source) return null;
  const keys = source instanceof Map ? source.keys() : (typeof source[Symbol.iterator] === 'function' ? source : Object.keys(source));
  const prefix = `${port}:`;
  const years = [];
  for (const key of keys) {
    if (typeof key !== 'string' || !key.startsWith(prefix)) continue;
    const y = Number(key.slice(prefix.length));
    if (Number.isFinite(y)) years.push(y);
  }
  if (!years.length) return null;
  years.sort((a, b) => a - b);
  return pickBakedEpochYear(years, target);
}

export function bakedWorldAsset(port, year, { exact = false } = {}) {
  if (typeof port !== 'string' || !port) return null;
  if (exact) return BAKED_WORLDS[`${port}:${year}`] ?? null;
  const resolved = resolveBakedBoardYear(port, year, BAKED_WORLDS);
  return resolved != null ? BAKED_WORLDS[`${port}:${resolved}`] ?? null : null;
}

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
  const placeEdgeShim = 'globalThis.placeEdge=(p)=>{const r=p?.r,n=r?.length||24;return Array.from({length:n+1},(_,k)=>{const a=(k/n)*Math.PI*2,rad=r?r[k%n]:(p?.rad||20);return{x:p.x+Math.cos(a)*rad,z:p.z+Math.sin(a)*rad};});};';
  return 'globalThis.FURLONG_HEADLESS=true;globalThis.FURLONG_OPTIONS=' + JSON.stringify(options) + ';' + placeEdgeShim +
    `globalThis.KA_MAPS={board:{w:${request.size},h:${request.size},hgt:${heights},` +
    `vscale:1,crown:${JSON.stringify(request.site.culture)},sites:${JSON.stringify(sites)},title:${JSON.stringify(request.site.name)}` +
    (request.manner ? `,manners:${JSON.stringify({ [request.site.culture]: request.manner })},founded:${request.founded},settled:${request.settled}` : request.founded != null ? `,founded:${request.founded},settled:${request.settled}` : '') +
    (request.works?.length ? `,works:${JSON.stringify(request.works.map((w) => ({ kind: w.kind, form: w.form, name: w.name, u: w.x / request.span, v: w.z / request.span, w: w.size[0], d: w.size[1], from: w.from, until: w.until, role: w.role, side: w.side, ...(w.round ? { round: true } : {}), ...(w.battery ? { battery: true } : {}), ...(w.earth ? { earth: true } : {}), ...(w.rough ? { rough: true } : {}), ...(w.landmark ? { landmark: w.landmark } : {}), ...(w.encloses ? { encloses: w.encloses } : {}), ...(w.gate ? { gate: w.gate } : {}) })))}` : '') + '}};\n';
}

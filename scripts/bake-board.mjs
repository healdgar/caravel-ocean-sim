// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Founds an Old World city's board ahead of time: the city is its board, there the moment its land is. The ground is
// the game's own: the page is run headless (no window is opened), its land read as made, and Castle and Commons' model
// founded on it here; once written, the land is made again with the board standing and checked to be the same ground. The same request founded in play gives the same board; a baked one only saves the wait.
// With the board goes the whole world as founded (the .world file beside it): the model's own save of everything it
// holds, which the game takes up and lets live. Nothing of it is chosen or left out.
//   node scripts/bake-board.mjs lisbon [--year 1550] [--seat n] [--seed n] [--out assets/boards/lisbon-1550.json] [--ground file] [--no-check]
// The port is the coast whose ground holds the city (js/old-world.js OLD_WORLD_CITIES, its `port`), the town of a
// people of the Americas in its year (js/native-towns.js NATIVE_TOWNS), or a town Spain or Portugal planted overseas
// (js/colonial-towns.js COLONIAL_TOWNS): its ground is read in that year, the town founded at its recorded site, with
// the seat, walls and neighbours the record gives it, and a planted town by its crown's manner, in its colony's year.
// --lived founds the realm in 850 and lets it live every day to the year: its cities are then grown by their own
// history. That is hours or days of one core for a great city; the progress is written as the years pass.
// The model founds another country for every seed; a home port is baked with the one whose seat best matches the record.
// Baked again, a port keeps the seed of the record it has, unless --seed asks for another.
// --ground keeps the land read from the game in a file and reads it from there the next time, for trying the
// tuning without loading the game each time.
// CHROMIUM_PATH names a browser other than Playwright's; WEBGPU_BACKEND=metal a real GPU on a Mac.
import { once } from 'node:events';
import { createHash } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createDevServer } from '../server.mjs';
import { BOARD_RIVERS, boardGroundDigest, boardGroundOff, boardGroundSurvey, boardKey, boardRequest, boardSeat, bakedBoardAsset, bakedWorldAsset } from '../js/board-model.js';
import { coastalRegionStageURL } from '../js/landfall.js';
import { OLD_WORLD_PLACES, boardTownHeld, oldWorldPeople } from '../js/old-world.js';
import { NATIVE_TOWNS } from '../js/native-towns.js';
import { COLONIAL_TOWNS } from '../js/colonial-towns.js';
import { FORT_RECORDS, fortPhaseFor, fortRecordsFor } from '../js/fort-records.js';
import { openBoard } from './board-host.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), port = args.find((a) => !a.startsWith('--')) || 'lisbon';
const option = (name, fallback) => { const k = args.indexOf('--' + name); return k >= 0 ? args[k + 1] : fallback; };
const year = Number(option('year', 1550));
const say = (text) => process.stderr.write(text + '\n');
// A native or planted town's coast is asked for in its own year: the coast's own year is its colony's.
const recordedTown = NATIVE_TOWNS.find((town) => town.port === port) ?? COLONIAL_TOWNS.find((town) => town.port === port) ?? null;

// The land as the game makes it for a player arriving at this port in this year: the page's own pipeline, read the
// moment the land is made (window.oceanLand), before anything is drawn. A board is founded on the land as it is with
// no board standing (board=off): a board already baked for the port would otherwise lay the ground, and the port's
// centre, that the next is founded on, and each bake would drift from the last. `standing` reads it with the baked
// board stood, as the game shows it (surveyHeights: the ground it was laid on, before its rivers are cut).
async function groundOf(portId, standing = false) {
  const server = createDevServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: process.env.WEBGPU_BACKEND === 'metal'
    ? ['--enable-unsafe-webgpu', '--use-angle=metal', '--disable-gpu-watchdog'] : ['--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-watchdog'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const url = coastalRegionStageURL('http://127.0.0.1:' + server.address().port + '/', portId, 'dock', 'clear', year);
    for (const [key, value] of Object.entries({ w: 640, h: 360, clouds: '0', follower: '0', hud: '0', ui: '0', ...(standing ? {} : { board: 'off' }), ...(recordedTown ? { year: String(year) } : {}) })) url.searchParams.set(key, value);
    await page.goto(url.toString());
    await page.waitForFunction(() => window.oceanLand?.pack?.heights || window.oceanStartup?.state === 'failed', undefined, { timeout: 300000, polling: 250 });
    const land = await page.evaluate(() => {
      const { region, pack } = window.oceanLand, src = pack.surveyHeights || pack.heights, bytes = new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
      let text = ''; for (let k = 0; k < bytes.length; k += 0x8000) text += String.fromCharCode.apply(null, bytes.subarray(k, k + 0x8000));
      return {
        state: window.oceanStartup?.state, source: pack.elevationSource, stood: Boolean(pack.board),
        region: { id: region.id, name: region.name, x: region.x, z: region.z, span: region.span, size: region.size, year: region.year, latitude: region.latitude, longitude: region.longitude, seed: region.vegetationSeed, demGeoSpan: region.demGeoSpan },
        centre: { x: pack.port.center.x, z: pack.port.center.z }, heights: btoa(text),
      };
    });
    if (land.state === 'failed' || !land.heights) throw new Error('The game did not make the land');
    return { ...land, heights: new Float32Array(Uint8Array.from(Buffer.from(land.heights, 'base64')).buffer) };
  } finally { await browser.close(); server.close(); }
}

const kept = option('ground', null);
let land;
if (kept && existsSync(kept)) {
  const was = JSON.parse(readFileSync(kept, 'utf8'));
  land = { ...was, heights: new Float32Array(Uint8Array.from(Buffer.from(was.heights, 'base64')).buffer) };
} else {
  land = await groundOf(port);
  if (kept) writeFileSync(kept, JSON.stringify({ ...land, heights: Buffer.from(land.heights.buffer).toString('base64') }));
}
const { region } = land;
say(`${region.name}: ${region.size} by ${region.size} heights over ${region.span} m, from ${land.source}; port at ${Math.round(land.centre.x - region.x)}, ${Math.round(land.centre.z - region.z)}`);
const city = boardTownHeld(region);
if (!city) throw new Error(`${port}'s ground holds no Old World city, native town nor planted town in ${year}`);
const people = oldWorldPeople(city, year), seat = Number(option('seat', city.seat ?? boardSeat(people)));
// Where a spot of the globe lies on this ground: metres east and south of its middle.
const east = (longitude) => (longitude - region.longitude) * Math.cos(region.latitude * Math.PI / 180) * 111195;
const south = (latitude) => (region.latitude - latitude) * 111195;
const number = (name, fallback) => Number(option(name, fallback));
// A town's recorded site on dry ground, however low on its bank, is where it is founded. Only where this ground puts
// the site in the water or on the strand (a harbour's channel surveyed a little wide, a record's point set in the
// river) does the town stand elsewhere: on the nearest terrace some metres above the water, with dry ground about it,
// as its founders stood it on the shore of the water the survey shows.
const STRAND = 1, FOUNDING_GROUND = 4, FOUNDING_REACH = 1600;
function onFoundingGround(x, z) {
  const n = Math.round(Math.sqrt(land.heights.length)), step = region.span / (n - 1), at = (i, j) => i < 0 || j < 0 || i >= n || j >= n ? -1 : land.heights[j * n + i];
  const i0 = Math.round((x + region.span / 2) / step), j0 = Math.round((z + region.span / 2) / step);
  const fits = (i, j) => at(i, j) >= FOUNDING_GROUND && [[-2, 0], [2, 0], [0, -2], [0, 2], [-2, -2], [2, 2], [-2, 2], [2, -2]].every(([di, dj]) => at(i + di, j + dj) > STRAND);
  say(`recorded site (${x}, ${z}) stands on ${at(i0, j0).toFixed(1)} m of ground`);
  if (at(i0, j0) >= STRAND) return { x, z };
  let best = null, least = Infinity;
  for (let r = 0; r * step <= FOUNDING_REACH && r <= least; r++) for (let j = j0 - r; j <= j0 + r; j++) for (let i = i0 - r; i <= i0 + r; i++) {
    if (Math.max(Math.abs(i - i0), Math.abs(j - j0)) !== r || !fits(i, j)) continue;
    const d = Math.hypot(i - i0, j - j0);
    if (d < least) { least = d; best = { x: i * step - region.span / 2, z: j * step - region.span / 2 }; }
  }
  if (best) say(`  in the water: founded ${Math.round(Math.hypot(best.x - x, best.z - z))} m off, at (${Math.round(best.x)}, ${Math.round(best.z)})`);
  return best ?? { x, z };
}
// The works the record says stood on this ground in this year (js/fort-records.js), wherever on it they stood and
// whichever port's record names them: each in the form its phase in this year had (fortPhaseFor), as big as the
// record says or as its form is, which the model sets on dry ground and stands as a building of the nearest place.
// To the model a tower of either kind is a tower and a castle or bastioned work a fort; the form goes with it, for the
// board to build it by (js/old-world-board.js).
const WORK_KIND = Object.freeze({ tower: 'tower', 'artillery-tower': 'tower', battery: 'battery', enclosed: 'fort', bastioned: 'fort', citadel: 'fort' });
const WORK_SIZE = Object.freeze({ tower: [12, 12], 'artillery-tower': [22, 22], battery: [44, 14], enclosed: [52, 52], bastioned: [76, 76], citadel: [120, 120] });
function workOf(record, phase) {
  const form = phase.form, kind = WORK_KIND[form];
  // A gun tower with a battery at its foot holds the ground of both, the battery toward the water.
  const size = form === 'battery' ? [record.sizeM?.[0] ?? WORK_SIZE.battery[0], Math.min(16, Math.max(10, record.sizeM?.[1] ?? WORK_SIZE.battery[1]))]
    : form === 'tower' ? WORK_SIZE.tower
      : form === 'artillery-tower' ? (record.sizeM ?? (phase.battery ? [36, 40] : WORK_SIZE['artillery-tower']))
        : record.sizeM ?? WORK_SIZE[form];
  return {
    kind, form, ...(phase.round ? { round: true } : {}), ...(phase.battery ? { battery: true } : {}), ...(phase.earth ?? record.earth ? { earth: true } : {}),
    name: record.name, x: Math.round(east(record.lon)), z: Math.round(south(record.lat)), size, from: phase.from, until: record.until ?? null,
    role: record.role ?? '', side: record.side ?? '', ...(record.rough ? { rough: true } : {}),
    ...(record.landmark ? { landmark: record.landmark } : {}),
    ...(record.encloses ? { encloses: record.encloses } : {}),
    ...(record.gate ? { gate: record.gate } : {}),
  };
}
const works = [], named = new Set();
for (const id of Object.keys(FORT_RECORDS)) for (const record of fortRecordsFor(id, year).forts) {
  const phase = fortPhaseFor(record, year);
  if (named.has(record.name) || !phase) continue;
  named.add(record.name);
  works.push(workOf(record, phase));
}
// A port already baked for this year keeps the country it was given: its seed, unless another is asked for.
const keptRecord = bakedBoardAsset(port, year) && existsSync(resolve(root, bakedBoardAsset(port, year))) ? JSON.parse(readFileSync(resolve(root, bakedBoardAsset(port, year)), 'utf8')).request : null;
const livedIndex = args.indexOf('--lived');
const livedArg = livedIndex >= 0 ? (args[livedIndex + 1] && !args[livedIndex + 1].startsWith('--') && Number.isFinite(Number(args[livedIndex + 1])) ? Number(args[livedIndex + 1]) : true) : false;
const request = boardRequest({
  heights: land.heights, span: region.span, seed: number('seed', keptRecord?.seed ?? region.seed ?? 1550), era: year, seat,
  ...(city.walls ? { walls: city.walls } : {}),
  // An Old World city is founded about its port; a native or planted town at its own recorded site.
  site: { name: city.name, culture: city.culture, ...(city.native || city.colonial ? onFoundingGround(Math.round(east(city.longitude)), Math.round(south(city.latitude))) : { x: land.centre.x - region.x, z: land.centre.z - region.z }) },
  places: (OLD_WORLD_PLACES[city.id] || city.places || []).map(([name, latitude, longitude, weight]) => ({ name, x: east(longitude), z: south(latitude), weight })),
  lived: livedArg,
  ...(city.manner ? { manner: city.manner, founded: city.founded, settled: city.settled } : city.founded != null ? { founded: city.founded, settled: city.settled } : {}),
  works,
  rivers: { catchment: number('catchment', BOARD_RIVERS.catchment), width: number('width', BOARD_RIVERS.width), least: number('least', BOARD_RIVERS.least), carve: number('carve', BOARD_RIVERS.carve) },
});
say(`real places on this ground: ${request.places.map((p) => `${p.name} (${p.x}, ${p.z})`).join(', ') || 'none'}`);
say(`works the record stands on it: ${(request.works ?? []).map((w) => `${w.kind} ${w.name} (${w.x}, ${w.z})`).join(', ') || 'none'}`);
say(`founding ${city.name} of ${people} people in ${year}: seat ${request.seat}, request ${boardKey(request)}`);
const began = performance.now();
const open = await openBoard(request, { onProgress: (text) => { if (!/\(\d+ of \d+\)/.test(text)) say(`  ${((performance.now() - began) / 1000).toFixed(1)} s  ${text}`); } });
const board = open.board;
// Everything, as founded: the model's own save, and a count of what its own display record holds of it.
const world = Buffer.from(await open.freeze()), record = await open.request('view', { kind: 'bootstrap' });
await open.close();
say(`founded in ${((performance.now() - began) / 1000).toFixed(1)} s: ${board.places.map((p) => `${p.kind} ${p.name} (${p.people})`).join(', ')}; ${board.buildings.count} buildings, ${board.fields.length} furlongs, ${board.people} people`);

const out = resolve(root, option('out', bakedBoardAsset(port, year) ?? `assets/boards/${port}-${year}.json`));
const worldOut = option('out', null) ? out.replace(/\.json$/, '') + '.world' : resolve(root, bakedWorldAsset(port, year) ?? `assets/boards/${port}-${year}.world`);
mkdirSync(dirname(out), { recursive: true });
writeFileSync(worldOut, world);
const held = Object.fromEntries(['settlements', 'houses', 'buildings', 'fields', 'roads', 'bridges', 'armies', 'ships', 'caravans', 'envoys', 'travellers', 'banditCamps', 'memorials', 'projects', 'tracks', 'fences', 'trees', 'petitions']
  .map((name) => [name, Array.isArray(record[name]) ? record[name].length : 0]));
held.abbeys = record.world?.abbeys?.length ?? 0; held.churchBodies = record.world?.churchBodies?.length ?? 0;
say(`froze the whole world: ${world.length} bytes; it holds ${Object.entries(held).map(([name, count]) => `${count} ${name}`).join(', ')}`);
writeFileSync(out, JSON.stringify({
  port, year, key: boardKey(request), ground: boardGroundDigest(land.heights), groundSource: land.source, survey: boardGroundSurvey(land.heights),
  region: { id: region.id, x: region.x, z: region.z, span: region.span, size: region.size, latitude: region.latitude, longitude: region.longitude },
  // The whole world as founded, kept beside this board: the model's own save, taken up only by the same program.
  world: { bytes: world.length, sha256: createHash('sha256').update(world).digest('hex'), program: open.program, day: board.day, year: board.year, holds: held },
  request: { span: request.span, size: request.size, seed: request.seed, fate: request.fate, era: request.era, seat: request.seat, walls: request.walls, site: request.site, places: request.places, rivers: request.rivers, lived: request.lived,
    ...(request.manner ? { manner: request.manner, founded: request.founded, settled: request.settled } : request.founded != null ? { founded: request.founded, settled: request.settled } : {}), ...(request.works ? { works: request.works } : {}) },
  board,
}) + '\n');
say(`wrote ${out}`);
// The land made again, now with this board standing: it must be the ground the board was founded on.
if (!args.includes('--no-check') && !option('out', null)) {
  const again = await groundOf(port, true), off = boardGroundOff(boardGroundSurvey(land.heights), again.heights);
  say(`made again with the board standing (${again.stood ? 'stood' : 'NOT STOOD'}): ${off.toFixed(2)} m from the ground it was founded on`);
  if (!again.stood || !(off < 1.5)) process.exitCode = 1;
}

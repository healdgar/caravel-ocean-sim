// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Founds a home port's board ahead of time, so the port is there the moment its land is. The ground is the game's
// own: the page is run headless (no window is opened), its land read as made, and Castle and Commons' model founded
// on it here. The same request founded in play gives the same board; a baked one only saves the wait.
// With the board goes the whole world as founded (the .world file beside it): the model's own save of everything it
// holds, which the game takes up and lets live. Nothing of it is chosen or left out.
//   node scripts/bake-board.mjs lisbon [--year 1550] [--seat n] [--seed n] [--out assets/boards/lisbon-1550.json] [--ground file]
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
import { BOARD_RIVERS, boardGroundDigest, boardGroundSurvey, boardKey, boardRequest, boardSeat, bakedBoardAsset, bakedWorldAsset } from '../js/board-model.js';
import { coastalRegionStageURL } from '../js/landfall.js';
import { OLD_WORLD_PLACES, oldWorldCityNear, oldWorldPeople } from '../js/old-world.js';
import { openBoard } from './board-host.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2), port = args.find((a) => !a.startsWith('--')) || 'lisbon';
const option = (name, fallback) => { const k = args.indexOf('--' + name); return k >= 0 ? args[k + 1] : fallback; };
const year = Number(option('year', 1550));
const say = (text) => process.stderr.write(text + '\n');

// The land as the game makes it for a player arriving at this port in this year.
async function groundOf(portId) {
  const server = createDevServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  const browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: process.env.WEBGPU_BACKEND === 'metal'
    ? ['--enable-unsafe-webgpu', '--use-angle=metal', '--disable-gpu-watchdog'] : ['--enable-unsafe-webgpu', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--disable-gpu-watchdog'] });
  try {
    const page = await browser.newPage({ viewport: { width: 1280, height: 720 } });
    const url = coastalRegionStageURL('http://127.0.0.1:' + server.address().port + '/', portId, 'dock', 'clear', year);
    for (const [key, value] of Object.entries({ w: 640, h: 360, clouds: '0', follower: '0', hud: '0', ui: '0' })) url.searchParams.set(key, value);
    await page.goto(url.toString());
    await page.waitForFunction(() => window.oceanStartup?.state === 'ready' || window.oceanStartup?.state === 'failed', undefined, { timeout: 300000, polling: 250 });
    const land = await page.evaluate(() => {
      const { region, pack } = window.oceanLand, src = pack.surveyHeights || pack.heights, bytes = new Uint8Array(src.buffer, src.byteOffset, src.byteLength);
      let text = ''; for (let k = 0; k < bytes.length; k += 0x8000) text += String.fromCharCode.apply(null, bytes.subarray(k, k + 0x8000));
      return {
        state: window.oceanStartup.state, source: pack.elevationSource,
        region: { id: region.id, name: region.name, x: region.x, z: region.z, span: region.span, size: region.size, year: region.year, latitude: region.latitude, longitude: region.longitude, seed: region.vegetationSeed },
        centre: { x: pack.port.center.x, z: pack.port.center.z }, heights: btoa(text),
      };
    });
    if (land.state !== 'ready') throw new Error('The game did not load');
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
const city = oldWorldCityNear(region.latitude, region.longitude);
if (!city) throw new Error(`${port} is not an Old World city`);
const people = oldWorldPeople(city, year), seat = Number(option('seat', boardSeat(people)));
// Where a spot of the globe lies on this ground: metres east and south of its middle.
const east = (longitude) => (longitude - region.longitude) * Math.cos(region.latitude * Math.PI / 180) * 111195;
const south = (latitude) => (region.latitude - latitude) * 111195;
const number = (name, fallback) => Number(option(name, fallback));
// A port already baked for this year keeps the country it was given: its seed, unless another is asked for.
const keptRecord = bakedBoardAsset(port, year) && existsSync(resolve(root, bakedBoardAsset(port, year))) ? JSON.parse(readFileSync(resolve(root, bakedBoardAsset(port, year)), 'utf8')).request : null;
const livedIndex = args.indexOf('--lived');
const livedArg = livedIndex >= 0 ? (args[livedIndex + 1] && !args[livedIndex + 1].startsWith('--') && Number.isFinite(Number(args[livedIndex + 1])) ? Number(args[livedIndex + 1]) : true) : false;
const request = boardRequest({
  heights: land.heights, span: region.span, seed: number('seed', keptRecord?.seed ?? region.seed ?? 1550), era: year, seat,
  site: { name: city.name, culture: 'iberian', x: land.centre.x - region.x, z: land.centre.z - region.z },
  places: (OLD_WORLD_PLACES[city.id] || []).map(([name, latitude, longitude, weight]) => ({ name, x: east(longitude), z: south(latitude), weight })),
  lived: livedArg,
  rivers: { catchment: number('catchment', BOARD_RIVERS.catchment), width: number('width', BOARD_RIVERS.width), least: number('least', BOARD_RIVERS.least), carve: number('carve', BOARD_RIVERS.carve) },
});
say(`real places on this ground: ${request.places.map((p) => `${p.name} (${p.x}, ${p.z})`).join(', ') || 'none'}`);
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
  request: { span: request.span, size: request.size, seed: request.seed, fate: request.fate, era: request.era, seat: request.seat, walls: request.walls, site: request.site, places: request.places, rivers: request.rivers, lived: request.lived },
  board,
}) + '\n');
say(`wrote ${out}`);

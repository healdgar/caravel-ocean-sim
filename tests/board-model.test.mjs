// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Castle and Commons' own model, whole, founding a coast on this game's ground and living on it.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { BOARD_TUNING, tuneBoardSource } from '../scripts/board-tuning.mjs';
import { BOARD_RIVERS, boardKey, boardPrefix, boardRequest, boardSeat } from '../js/board-model.js';
import { openBoard } from '../scripts/board-host.mjs';

const asset = (name) => readFileSync(new URL(`../assets/board/${name}`, import.meta.url), 'utf8');

// A bay on a south-facing shore: land rising to the north, a headland to the east, a stream valley down the middle.
const SPAN = 4096, SAMPLES = 129;
function bayHeight(x, z) {
  const shore = 600 + 260 * Math.cos(x / 700) - 0.00012 * x * x, inland = shore - z;
  if (inland <= 0) return Math.max(-60, inland * 0.05);
  return Math.min(180, inland * 0.07 + 18 * Math.sin(x / 310) * Math.sin(z / 270) * Math.min(1, inland / 400)
    - 9 * Math.exp(-(x * x) / (2 * 120 * 120)) * Math.min(1, inland / 300));
}
function bay() {
  const heights = new Float32Array(SAMPLES * SAMPLES);
  for (let j = 0; j < SAMPLES; j++) for (let i = 0; i < SAMPLES; i++) heights[j * SAMPLES + i] = bayHeight((i / (SAMPLES - 1) - 0.5) * SPAN, (j / (SAMPLES - 1) - 0.5) * SPAN);
  return heights;
}
const SITE = { name: 'Porto Novo', culture: 'iberian', x: 150, z: 380 };
const ask = (more = {}) => boardRequest({ heights: bay(), span: SPAN, site: SITE, seed: 1550, era: 1550, seat: 0.5, ...more });

test('the model here is Castle and Commons\' program as recorded, changed by the tuning table and nothing else', () => {
  const source = JSON.parse(asset('SOURCE.json')), game = asset('game.js');
  const body = game.replace(/^(\/\/.*\n)+/, '');
  assert.match(game, new RegExp(`^// Castle and Commons: the game program, from ${source.commit}\\.`));
  assert.equal(source.tuned, BOARD_TUNING.length);
  // Every passage stands as tuned, once, and the source's own words for it are gone.
  let restored = body;
  for (const { find, replace, count = 1 } of BOARD_TUNING) {
    assert.equal(restored.split(replace).length - 1, count, `tuned passage present: ${find.slice(0, 60)}`);
    restored = restored.split(replace).join(find);
  }
  assert.equal(restored.length, source.characters);
  assert.equal(createHash('sha256').update(restored).digest('hex'), source.sha256);
  assert.equal(tuneBoardSource(restored), body);
  // A passage the source no longer has stops the vendoring instead of passing silently.
  assert.throws(() => tuneBoardSource(restored.replace(BOARD_TUNING[0].find, '')), /Castle and Commons has changed/);
  assert.match(asset('LICENSE'), /MIT License/);
});

test('a seat is sized by its people, and a request is named by everything it asks', () => {
  assert.equal(boardSeat(12400), 1);
  assert.equal(boardSeat(100000), 8);
  assert.equal(boardSeat(1000), 0.25);
  assert.equal(boardSeat(NaN), 1);
  const a = ask(), b = ask(), wider = ask({ seat: 1 }), moved = ask({ site: { ...SITE, x: SITE.x + 40 } });
  const raised = bay(); raised[5000] += 0.02;
  const lifted = boardRequest({ heights: raised, span: SPAN, site: SITE, seed: 1550, era: 1550, seat: 0.5 });
  assert.equal(a.size, SAMPLES - 1);
  assert.equal(a.heights.length, (SAMPLES - 1) ** 2);
  assert.equal(boardKey(a), boardKey(b));
  for (const other of [wider, moved, lifted]) assert.notEqual(boardKey(a), boardKey(other));
  // What is asked of the rivers, the real places round the seat, and a lived history are part of the name too.
  const placed = ask({ places: [{ name: 'Vila Franca', x: 900, z: -400, weight: 7 }, { name: 'Far Away', x: 2000, z: 0, weight: 3 }, { name: 'Heavy', x: -300, z: -900, weight: 40 }, { name: 'Light', x: 300, z: -900 }] });
  assert.deepEqual(placed.places, [{ name: 'Vila Franca', x: 900, z: -400, weight: 7 }, { name: 'Heavy', x: -300, z: -900, weight: 9 }, { name: 'Light', x: 300, z: -900, weight: 1 }],
    'a place off the ground is left out, and a weight kept between 1 and 9');
  assert.deepEqual(a.rivers, { ...BOARD_RIVERS }); assert.equal(a.lived, false); assert.deepEqual(a.places, []);
  for (const other of [placed, ask({ rivers: { ...BOARD_RIVERS, catchment: 2e6 } }), ask({ rivers: { ...BOARD_RIVERS, carve: 1 } }), ask({ lived: true })]) assert.notEqual(boardKey(a), boardKey(other));
  assert.match(boardPrefix(placed), /"n":"Porto Novo","u":[-\d.e]+,"v":[-\d.e]+,"c":"iberian","w":300\},\{"n":"Vila Franca"/, 'the seat first and heaviest, then the places');
  assert.match(boardPrefix(a), /"rivers":\{"catchment":1000000,"width":2\.2,"least":1\.2,"carve":0\.3\},"lived":false/);
  assert.match(boardPrefix(ask({ lived: true })), /"lived":true/);
  const prefix = boardPrefix(a);
  assert.match(prefix, /^globalThis\.FURLONG_HEADLESS=true;/);
  assert.match(prefix, /"spanMetres":4096/);
  assert.throws(() => boardRequest({ heights: new Float32Array(10), span: SPAN, site: SITE, seed: 1 }), /square/);
});

test('the model founds a walled Iberian port where it is asked, houses its people, founds it the same again, and lives on', { timeout: 900000 }, async (t) => {
  const request = ask(), open = await openBoard(request), board = open.board;
  t.diagnostic(JSON.stringify({ places: board.places.map((p) => [p.kind, p.name, p.people, p.x, p.z]), buildings: board.buildings.count, fields: board.fields.length, people: board.people, roads: board.roads.length, rivers: board.rivers.length }));
  assert.equal(board.span, SPAN);
  assert.equal(board.year, 1550);
  const seat = board.places[0];
  assert.equal(seat.kind, 'capital');
  assert.equal(seat.name, SITE.name);
  assert.equal(seat.culture, 'iberian');
  assert.ok(Math.hypot(seat.x - SITE.x, seat.z - SITE.z) < 250, `the seat stands at its site: ${seat.x}, ${seat.z}`);
  assert.ok(seat.wall && seat.wall.rad.length === 144 && seat.wall.gates.length >= 1, 'the seat is walled, with a gate');
  assert.ok(seat.streets.length >= 8, `streets: ${seat.streets.length}`);
  assert.ok(board.places.length >= 2, 'the seat has neighbours');
  for (const place of board.places) assert.ok(place.name && place.people > 0);

  // Buildings: six numbers each for where they stand, on dry ground inside the survey.
  const { count, stand, form, kinds } = board.buildings;
  assert.ok(count > 250, `buildings: ${count}`);
  assert.equal(stand.length, count * 6); assert.equal(form.length, count * 3); assert.equal(kinds.length, count * 6);
  let dry = 0, housesOfTheSeat = 0;
  for (let k = 0; k < count; k++) {
    const x = stand[k * 6], z = stand[k * 6 + 1], w = stand[k * 6 + 3], d = stand[k * 6 + 4], h = stand[k * 6 + 5];
    assert.ok(Math.abs(x) < SPAN / 2 && Math.abs(z) < SPAN / 2 && w > 1 && d > 1 && h > 1, `building ${k}`);
    assert.ok(board.arches[kinds[k * 6 + 1]], `building ${k} is of a known kind`);
    if (bayHeight(x, z) > 0) dry++;
    if (kinds[k * 6] === 0) housesOfTheSeat++;
  }
  assert.ok(dry >= count * 0.99, `buildings on dry ground: ${dry} of ${count}`);
  assert.ok(housesOfTheSeat > count * 0.4, 'most buildings are the seat\'s');

  // Every furlong of the ground, some tilled and some wood, each a closed figure about its own site.
  assert.ok(board.fields.length > 300, `fields: ${board.fields.length}`);
  const states = new Set(board.fields.map((f) => f.state));
  assert.ok(states.has(board.fieldStates.TILLED) && states.has(board.fieldStates.WOOD), 'tilled ground and woodland');
  assert.ok(board.fields.some((f) => f.place < 0) && board.fields.some((f) => f.place === 0), 'held and unheld ground');
  for (const field of board.fields) assert.ok(field.points.length >= 6 && Number.isFinite(field.x) && Number.isFinite(field.z));

  // The people: each a name, an age, a trade and a roof in their own place.
  const souls = board.souls, each = souls.each;
  assert.equal(each.length, board.people * 6);
  assert.ok(board.people > 1500, `people: ${board.people}`);
  let homed = 0;
  for (let k = 0; k < board.people; k++) {
    const home = each[k * 6 + 5];
    assert.ok(souls.given[each[k * 6 + 1]], `soul ${k} has a name`);
    if (home >= 0) { assert.equal(kinds[home * 6], each[k * 6], `soul ${k} lives where they belong`); homed++; }
  }
  assert.ok(homed >= board.people * 0.95, `housed: ${homed} of ${board.people}`);
  assert.ok(souls.trades.includes('fisher') || souls.trades.includes('boatman'), 'a port has people of the water');

  // Founded again from the same request, it is the same board to the last number.
  const again = await openBoard(request);
  assert.equal(JSON.stringify(again.board), JSON.stringify(board));
  await again.close();

  // And it lives: days pass, people are born and die, the towns stand.
  const later = await open.live(5);
  assert.equal(later.day, board.day + 5);
  assert.ok(Math.abs(later.people - board.people) < board.people * 0.1, `people after five days: ${later.people}`);
  assert.ok(later.buildings.count >= count * 0.95);
  // Any hook of the runtime can be asked for by name.
  assert.equal((await open.hook('board')).day, later.day);
  await open.close();
});

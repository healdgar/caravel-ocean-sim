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
  assert.equal(ask({ lived: 1 }).lived, 1);
  for (const other of [placed, ask({ rivers: { ...BOARD_RIVERS, catchment: 2e6 } }), ask({ rivers: { ...BOARD_RIVERS, carve: 1 } }), ask({ lived: true }), ask({ lived: 1 })]) assert.notEqual(boardKey(a), boardKey(other));
  assert.notEqual(boardKey(ask({ lived: true })), boardKey(ask({ lived: 1 })));
  assert.match(boardPrefix(placed), /"n":"Porto Novo","u":[-\d.e]+,"v":[-\d.e]+,"c":"iberian","w":300\},\{"n":"Vila Franca"/, 'the seat first and heaviest, then the places');
  assert.match(boardPrefix(a), /"rivers":\{"catchment":1000000,"width":2\.2,"least":1\.2,"carve":0\.3\},"lived":false/);
  assert.match(boardPrefix(ask({ lived: true })), /"lived":true/);
  assert.match(boardPrefix(ask({ lived: 1 })), /"lived":1/);
  const prefix = boardPrefix(a);
  assert.match(prefix, /^globalThis\.FURLONG_HEADLESS=true;/);
  assert.match(prefix, /"spanMetres":4096/);
  // A host that freezes or takes up a world names its program, and a world taken up brings its own ground.
  assert.match(prefix, /"lived":false,"program":null/);
  assert.match(boardPrefix(a, 'abc123'), /"lived":false,"program":"abc123"/);
  assert.ok(boardPrefix({ ...a, heights: null }).includes(`hgt:new Float32Array(${a.size * a.size}),`));
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
  for (const place of board.places) {
    assert.ok(place.name && place.people > 0);
    assert.ok(place.herds && Number.isInteger(place.herds.sheep) && Number.isInteger(place.herds.cattle) && Number.isInteger(place.herds.horses) && Number.isInteger(place.herds.swine), 'standing herd counts exported');
    assert.ok('pond' in place, 'pond slot exported');
  }
  for (const river of board.rivers) {
    assert.equal(river.levels.length, river.points.length / 3, 'river profile levels exported');
  }

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

test('the whole world is frozen at its founding, taken up again without its survey, lives the same days, and answers as the source\'s own worker does', { timeout: 900000 }, async (t) => {
  const request = ask(), open = await openBoard(request);
  assert.equal(open.program, createHash('sha256').update(asset('game.js')).digest('hex'), 'a program is named by the model\'s own text');
  const frozen = await open.freeze();
  assert.ok(frozen instanceof Uint8Array && frozen.length > 200000 && frozen[0] === 0x1f && frozen[1] === 0x8b, `the model's own save, zipped: ${frozen.length} bytes`);
  const kept = Uint8Array.from(frozen), thawed = await openBoard(request, { world: frozen });
  assert.equal(thawed.program, open.program);
  assert.equal(JSON.stringify(thawed.board), JSON.stringify(open.board), 'the same board to the last number');

  // The model's whole display record: everything it would draw, whether or not this game draws it yet.
  const record = await thawed.request('view', { kind: 'bootstrap' });
  for (const key of ['world', 'houses', 'monarch', 'settlements', 'armies', 'caravans', 'envoys', 'travellers', 'ships', 'banditCamps', 'dragon', 'memorials', 'petitions', 'buildings', 'roads', 'bridges', 'projects', 'fields', 'tracks', 'fences', 'static']) assert.ok(key in record, `the record holds ${key}`);
  for (const key of ['h', 'water', 'biome', 'dom', 'roadCells', 'rivStrips', 'treeSpots']) assert.ok(key in record.static, `and of its ground, ${key}`);
  assert.ok('abbeys' in record.world && 'churchBodies' in record.world, 'and the church');
  assert.equal(record.settlements.length, open.board.places.length);
  assert.ok(record.houses.length >= 2 && record.monarch, 'great houses and a crown');
  t.diagnostic(JSON.stringify({ frozen: frozen.length, houses: record.houses.length, buildings: record.buildings.length, fields: record.fields.length }));

  // Days lived by the keeper after the thaw are the days the unbroken realm lives.
  const unbroken = await open.live(6), reply = await thawed.request('advance', { days: 6 });
  assert.deepEqual(reply, { day: open.board.day + 6, complete: true });
  assert.equal(JSON.stringify(await thawed.hook('board')), JSON.stringify(unbroken));
  await assert.rejects(thawed.request('advance', { days: 0 }));

  // The realm's own account of itself, its annals, and anything in it found and read by name.
  const state = await thawed.request('view', { kind: 'ui', panel: 'advisor-state' });
  assert.match(state.date, /AD 1550/); assert.ok(state.people > 1500 && state.monarch, JSON.stringify(state).slice(0, 300));
  const annals = await thawed.request('view', { kind: 'ui', panel: 'advisor-annals', n: 50 });
  assert.ok(Array.isArray(annals));
  for (const line of annals) assert.ok(Number.isInteger(line.day) && line.date && line.cat && line.text);
  const found = await thawed.request('view', { kind: 'ui', panel: 'advisor-find', name: SITE.name, n: 10 });
  assert.ok(found.some((hit) => hit.code === 's0'), JSON.stringify(found).slice(0, 300));
  const seat = await thawed.request('view', { kind: 'ui', panel: 'advisor-inspect', code: 's0', full: true });
  assert.equal(seat.code, 's0', JSON.stringify(seat).slice(0, 400)); assert.equal(seat.kind, 'settlement'); assert.ok(seat.card.startsWith(SITE.name), seat.card.slice(0, 80));
  const summary = await thawed.request('view', { kind: 'summary' });
  assert.equal(summary.day, open.board.day + 6); assert.equal(summary.settlements[0].name, SITE.name);

  // Its people, as they walk the seat today: each a name, a calling, an age and a way to go.
  const { citizens } = await thawed.request('view', { kind: 'actors', si: 0, fraction: 0.5 });
  assert.equal(citizens.si, 0);
  assert.ok(citizens.people.length > 20, `citizens abroad: ${citizens.people.length}`);
  for (const one of citizens.people) {
    assert.ok(one.name && Number.isFinite(one.x) && Number.isFinite(one.z) && Number.isFinite(one.age), JSON.stringify(one).slice(0, 200));
    assert.ok(one.track instanceof Float32Array);
  }
  // Any of them can be read whole: their household, kin, living and holdings, as the model keeps them.
  const someone = citizens.people[0], card = await thawed.request('view', { kind: 'ui', panel: 'advisor-inspect', code: 'p' + someone.id, full: true });
  assert.equal(card.kind, 'person'); assert.ok(card.card.startsWith(someone.name), card.card.slice(0, 80));
  assert.match(card.card, /Household/);
  t.diagnostic(card.card.split('\n').slice(0, 6).join(' | '));

  // Its townsfolk by the model's own plan of their day: who lives nearest the eye, where each is bound and the way
  // they take; more of them when more are asked for, and others of the place by name. Looking changes nothing.
  const before = JSON.stringify(await thawed.hook('board')), whole = Buffer.from(await thawed.freeze()).toString('base64');
  const folk = await thawed.hook('folk', 0, { most: 60, others: 25 });
  assert.equal(folk.si, 0); assert.equal(folk.day, reply.day); assert.equal(folk.sunday, reply.day % 7 === 0);
  assert.equal(folk.people.length, 60); assert.equal(folk.others.length, 25);
  const ids = new Set([...folk.people, ...folk.others].map((one) => one.id));
  assert.equal(ids.size, 85, 'no one twice');
  const half = thawed.board.span / 2;
  for (const one of folk.people) {
    assert.ok(one.name && one.surname && Number.isFinite(one.age) && ['m', 'f'].includes(one.sex), JSON.stringify({ ...one, route: 0 }));
    assert.ok(['work', 'errand', 'church', 'play'].includes(one.goal) && typeof one.there === 'string' && one.there, `${one.goal}: ${one.there}`);
    assert.ok(one.pace > 0.3 && one.pace < 3, `pace ${one.pace}`);
    assert.ok(Array.isArray(one.route) && one.route.length >= 4 && one.route.length % 2 === 0, `a way of ${one.route.length / 2} points`);
    assert.ok(one.route.every((v) => Number.isFinite(v) && Math.abs(v) <= half), 'on the board');
    assert.ok(Math.hypot(one.route[0] - one.home[0], one.route[1] - one.home[1]) < 40, 'from their own door');
    if (one.age < 14) assert.equal(one.role, null, 'a child has no calling of their own');
  }
  assert.equal(folk.others.every((one) => one.name && one.age >= 16 && one.age < 66), true);
  // The eye elsewhere, other people: those who live nearest it.
  const middle = thawed.board.places[0], near = (list) => list.reduce((sum, one) => sum + Math.hypot(one.home[0] - middle.x - 150, one.home[1] - middle.z), 0) / list.length;
  const aside = await thawed.hook('folk', 0, { focus: { x: middle.x + 150, z: middle.z }, most: 60 });
  assert.ok(near(aside.people) < near(folk.people), `${near(aside.people).toFixed(0)} m against ${near(folk.people).toFixed(0)} m`);
  assert.deepEqual(aside.others, []);
  assert.equal((await thawed.hook('folk', 0, { most: 5 })).people.length, 5);
  assert.deepEqual((await thawed.hook('folk', 99)).people, [], 'no such place, no one');
  assert.equal(JSON.stringify(await thawed.hook('board')), before);
  assert.equal(Buffer.from(await thawed.freeze()).toString('base64') === whole, true, 'the whole world, frozen, is byte for byte what it was');
  assert.equal(JSON.stringify(await thawed.hook('folk', 0, { most: 60, others: 25 })), JSON.stringify(folk), 'and asked again, the same plan');
  t.diagnostic(`folk: ${folk.people.map((one) => one.goal).reduce((count, goal) => ({ ...count, [goal]: (count[goal] || 0) + 1 }), {}) && JSON.stringify(folk.people.slice(0, 2).map((one) => [one.name, one.age, one.role, one.goal, one.there, one.via, one.route.length / 2]))}`);
  // Its soldiers, by the model's own rolls: the watch it keeps and pays is named man by man, the poorest householders
  // first; the same roll is in the place's record, from which a port's posts are manned. Asking changes nothing.
  const roll = await thawed.hook('watch', 0, { most: 40 });
  assert.equal(roll.si, 0); assert.ok(roll.garrison > 0, `a watch of ${roll.garrison}`);
  assert.equal(roll.men.length, Math.min(40, roll.garrison)); assert.equal(new Set(roll.men.map((one) => one.id)).size, roll.men.length, 'no one twice');
  for (const one of roll.men) {
    assert.ok(one.name && one.surname && ['m', 'f'].includes(one.sex) && ['watch', 'host'].includes(one.of), JSON.stringify(one));
    if (one.of === 'watch') assert.ok(one.age >= 14 && one.age < 50, `${one.name} is ${one.age}`);
  }
  assert.ok(Array.isArray(roll.hosts)); assert.ok(roll.captain === null || roll.captain.of === 'office');
  const watchman = roll.men[0], theirs = await thawed.request('view', { kind: 'ui', panel: 'advisor-inspect', code: 'p' + watchman.id, full: true });
  assert.equal(theirs.kind, 'person'); assert.ok(theirs.card.startsWith(watchman.name), theirs.card.slice(0, 80));
  assert.equal(JSON.stringify(await thawed.hook('watch', 0, { most: 40 })), JSON.stringify(roll), 'asked again, the same roll');
  const seatWatch = (await thawed.hook('board')).places[0].watch;
  assert.equal(seatWatch.garrison, roll.garrison); assert.deepEqual(seatWatch.men.slice(0, roll.men.length), roll.men, 'the record keeps the same roll');
  assert.deepEqual((await thawed.hook('watch', 99)).men, [], 'no such place, no watch');
  assert.equal(JSON.stringify(await thawed.hook('board')), before);
  assert.equal(Buffer.from(await thawed.freeze()).toString('base64') === whole, true, 'and the whole world is still what it was');
  t.diagnostic(`watch: ${roll.garrison} posts; ${roll.men.slice(0, 3).map((one) => `${one.name}, ${one.role}, ${one.age}`).join('; ')}`);
  // A world is not taken up from bytes that are not one.
  await assert.rejects(openBoard(request, { world: kept.slice(0, 5000) }));
  await open.close(); await thawed.close();
});

test('a short lived span unlocks all era technologies, keeps household grain ledgers balanced, and breeds standing herds', { timeout: 900000 }, async () => {
  const open = await openBoard(ask({ seat: 0.25, lived: 1 }));
  const board = open.board;
  assert.equal(board.year, 1550);
  assert.equal(board.day, 360);
  const totalAnimals = board.places.reduce((sum, p) => sum + p.herds.sheep + p.herds.cattle + p.herds.horses + p.herds.swine, 0);
  assert.ok(totalAnimals > 0, `standing livestock after 1 lived year: ${totalAnimals}`);
  await open.close();
});

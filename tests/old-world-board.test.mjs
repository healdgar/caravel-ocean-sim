// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// A board Castle and Commons' model founded, stood up in this game: its buildings this game's Cairn types on dry
// ground, its furlongs the land's uses, its woods the forest's, its ground the colour of its geography with the
// board's parcels left to the GPU; and a board founded on other ground refused, so the rules here make the town.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { test } from 'node:test';
import { BAKED_BOARDS, BAKED_WORLDS, BOARD_RIVERS, BOARD_SURVEY_SIZE, BOARD_VERSION, bakedBoardAsset, bakedWorldAsset, boardGroundFits, boardGroundSurvey, boardRequest } from '../js/board-model.js';
import { BOARD_WAY_FLOATS, boardStampTables } from '../js/board-stamp.js';
import { BOARD_INDEX_SIZE, BOARD_STREETFRONT, BOARD_THATCHED, BOARD_WORKS, boardRoadCrossings } from '../js/old-world-board.js';
import { CITY_BLOCK_FLOATS, CITY_TREES } from '../js/old-world-city.js';
import { CITY_BUILDING_TYPES, CITY_THATCH_ROOF, CITY_TYPE, CITY_TYPE_SLIGHT_FROM, CITY_TYPED_FLOATS, CITY_TYPES_OVERHEAD, CITY_TYPES_SLIGHT } from '../js/old-world-buildings.js';
import { WORKS_FENCE_M, WORKS_WHEEL } from '../js/old-world-works.js';
import { OLD_WORLD_LAND, OLD_WORLD_NO_TREES, OLD_WORLD_PLACES, bakedBoardFor, oldWorldCountry, registerBakedBoard } from '../js/old-world.js';
import { openBoard } from '../scripts/board-host.mjs';

// The bay of tests/board-model.test.mjs, set down where Lisbon is so that the country round it is Old World.
const SPAN = 4096, SAMPLES = 129, SITE = { name: 'Porto Novo', culture: 'iberian', x: 150, z: 380 };
function bayHeight(x, z) {
  const shore = 600 + 260 * Math.cos(x / 700) - 0.00012 * x * x, inland = shore - z;
  if (inland <= 0) return Math.max(-60, inland * 0.05);
  return Math.min(180, inland * 0.07 + 18 * Math.sin(x / 310) * Math.sin(z / 270) * Math.min(1, inland / 400)
    - 9 * Math.exp(-(x * x) / (2 * 120 * 120)) * Math.min(1, inland / 300));
}
function ground(samples = SAMPLES, height = bayHeight) {
  const heights = new Float32Array(samples * samples);
  for (let j = 0; j < samples; j++) for (let i = 0; i < samples; i++) heights[j * samples + i] = height((i / (samples - 1) - 0.5) * SPAN, (j / (samples - 1) - 0.5) * SPAN);
  return heights;
}
const region = (more = {}) => ({ id: 'test-bay', latitude: 38.707, longitude: -9.136, x: 0, z: 0, span: SPAN, size: SAMPLES, biomeSize: 128, albedoSize: 256, year: 1550, ...more });
const port = () => ({ center: { x: SITE.x, z: SITE.z }, clearRadius: 120, instances: [] });

test('a ground is known again by its survey, whatever its lattice, and another ground is not', () => {
  const heights = ground(), survey = boardGroundSurvey(heights);
  assert.equal(survey.length, BOARD_SURVEY_SIZE * BOARD_SURVEY_SIZE);
  assert.ok(boardGroundFits(survey, heights));
  assert.ok(boardGroundFits(survey, ground(257)), 'the same bay made on a finer lattice');
  assert.ok(boardGroundFits(JSON.parse(JSON.stringify(survey)), heights), 'a survey read back from a file');
  assert.ok(!boardGroundFits(survey, ground(SAMPLES, (x, z) => bayHeight(-x, z) + (bayHeight(-x, z) > 0 ? 4 : 0))), 'the bay turned about and raised');
  assert.ok(!boardGroundFits(survey, ground(SAMPLES, (x, z) => bayHeight(x, z - 400))), 'the shore moved 400 m');
  assert.ok(!boardGroundFits(survey.slice(0, 100), heights) && !boardGroundFits(undefined, heights), 'no survey, no fit');
});

test('a road is bridged where it crosses a river: once, along the road, as wide as the water lies across its way', () => {
  // A river running north and south, 4 m to a side, widening to 6; a road straight across it, one askew, and one beside.
  const river = { points: [100, -200, 4, 100, 0, 4, 100, 200, 6] };
  const square = boardRoadCrossings([{ points: [0, 50, 60, 50, 200, 50] }], [river]);
  assert.equal(square.length, 1);
  assert.ok(Math.abs(square[0].x - 100) < 1e-6 && Math.abs(square[0].z - 50) < 1e-6 && Math.abs(square[0].ux - 1) < 1e-9 && Math.abs(square[0].uz) < 1e-9, JSON.stringify(square));
  assert.ok(Math.abs(square[0].span - 9) < 1e-6, `the water is 2 × 4.5 m across there: ${square[0].span}`);
  const askew = boardRoadCrossings([{ points: [0, -150, 200, 50] }], [river]);
  assert.equal(askew.length, 1);
  assert.ok(Math.abs(askew[0].span - 8 * Math.SQRT2) < 1e-6, `across at 45°: ${askew[0].span}`);
  assert.deepEqual(boardRoadCrossings([{ points: [0, -200, 0, 200] }, { points: [150, -100, 150, 100] }], [river]), [], 'a road beside a river needs none');
  // Two roads over the same crossing share its bridge; a river with no road, or none at all, has none.
  assert.equal(boardRoadCrossings([{ points: [0, 50, 200, 50] }, { points: [0, 53, 200, 51] }], [river]).length, 1);
  assert.deepEqual(boardRoadCrossings([], [river]), []); assert.deepEqual(boardRoadCrossings([{ points: [0, 0, 9, 9] }], undefined), []);
});

test('a founded board stands in the game as its own buildings, land and woods, and only on its own ground', { timeout: 900000 }, async (t) => {
  const heights = ground();
  const open = await openBoard(boardRequest({ heights, span: SPAN, site: SITE, seed: 1550, era: 1550, seat: 0.5 }));
  const board = open.board; await open.close();
  const baked = { port: 'test-bay', year: 1550, survey: boardGroundSurvey(heights), board };
  registerBakedBoard(baked);
  assert.equal(bakedBoardFor(region()), baked);
  assert.equal(bakedBoardFor(region({ year: 1650 })), null, 'a board is for its year');

  const country = oldWorldCountry(region(), heights, port()), plan = country.plan, stats = plan.stats;
  t.diagnostic(JSON.stringify({ founded: board.buildings.count, stats }));
  assert.ok(country.board, 'the board stands');
  assert.equal(country.places.length, board.places.length);
  assert.equal(country.places[0].name, SITE.name);
  // Who mans the seat goes with the country, for the port's posts.
  assert.ok(country.watch && country.watch.place === SITE.name && country.watch.day === board.day, JSON.stringify(country.watch).slice(0, 200));
  assert.equal(country.watch.garrison, board.places[0].watch.garrison); assert.deepEqual(country.watch.men, board.places[0].watch.men);
  assert.ok(country.watch.men.length > 0 && country.watch.men.length <= 96 && country.watch.men.every((one) => one.id > 0 && one.name));

  // Its wall: the model says of each stretch how its line was chosen (0 open ground, 1 a cliff that is itself the
  // wall, 2 along a bank, 3 a crest), and every stretch but a cliff is built. So the circuit stands here in stone,
  // with towers along it and a gate where the model has one, and is not taken for open where its kind is 0.
  const wall = board.places[0].wall, towers = plan.typedTypes.reduce((n, type) => n + (type === CITY_TYPE.WALL_TOWER ? 1 : 0), 0);
  t.diagnostic(JSON.stringify({ walls: board.places[0].walls, kinds: wall && [0, 1, 2, 3].map((kind) => wall.kind.filter((k) => k === kind).length), gates: stats.gates, towers }));
  assert.ok(wall && board.places[0].walls >= 2, 'the seat is walled in stone');
  assert.ok(wall.kind.filter((k) => k === 0).length > wall.kind.length / 2, 'and most of its circuit runs over open ground');
  const round = wall.rad.reduce((sum, r) => sum + r, 0) / wall.rad.length * 2 * Math.PI;
  assert.ok(stats.gates >= 1 && towers >= round / 56 * 0.5, `${towers} towers and ${stats.gates} gates on a circuit of ${Math.round(round)} m`);

  // Its poorest houses: the model roofs its tier 0 in thatch across villages, towns and the seat alike, each as a type
  // of its own; its far block is roofed in straw as it is, and no other block is.
  let hovels = 0, townHovels = 0, thatched = 0;
  for (let k = 0; k < board.buildings.count; k++) {
    if (board.buildings.kinds[k * 6 + 2] !== 0 || !BOARD_THATCHED[board.arches[board.buildings.kinds[k * 6 + 1]]]) continue;
    hovels++;
    if (board.places[board.buildings.kinds[k * 6]]?.kind !== 'village') townHovels++;
  }
  for (let i = 0; i < plan.typedCount; i++) {
    const type = plan.typedTypes[i], own = plan.typedBlocks[i * 2 + 1], straw = type === CITY_TYPE.THATCH_HOUSE || type === CITY_TYPE.THATCH_LONGHOUSE;
    if (straw) thatched++;
    for (let b = 0; b < own; b++) assert.equal(plan.blocks[(plan.typedBlocks[i * 2] + b) * CITY_BLOCK_FLOATS + 8] >= CITY_THATCH_ROOF, straw || type === CITY_TYPE.COT, `the far roof of building ${i}`);
  }
  t.diagnostic(JSON.stringify({ hovels, townHovels, thatched }));
  assert.equal(thatched, stats.built.thatched);
  assert.ok(hovels > 0 && townHovels > 0, 'the model has tier-0 thatch buildings in villages and in towns');
  assert.ok(thatched > hovels * 0.8 && thatched <= hovels, `${thatched} under thatch of ${hovels} tier-0 buildings across all settlements`);

  // Its inland rivers carve smooth channels into the ground, emit freshwater ribbon geometry, and place grazing herds.
  if (board.rivers.length > 0) {
    assert.ok(country.inlandWater && country.inlandWater.vertices.length >= 24 && country.inlandWater.indices.length >= 12, 'inland water ribbons built');
    let carvedCells = 0;
    const rawGround = ground();
    for (let i = 0; i < heights.length; i++) if (heights[i] < rawGround[i] - 0.05) carvedCells++;
    assert.ok(carvedCells > 10, `carved ${carvedCells} river bed cells into terrain heights`);
  }
  assert.ok(country.herds && country.herds.length >= 24 && country.herds.length % 8 === 0, `standing herds placed: ${(country.herds?.length ?? 0) / 8}`);

  // Its buildings: this game's types, nearly all of those founded, each on dry ground and none in another.
  assert.equal(plan.typed.length, plan.typedCount * CITY_TYPED_FLOATS);
  assert.equal(plan.typedTypes.length, plan.typedCount);
  assert.equal(plan.blocks.length % CITY_BLOCK_FLOATS, 0);
  // Every building the model founded stands as a house or as its own kind of work.
  const B = stats.built, stood = stats.houses + stats.churches + B.windmills + B.watermills + B.stores + B.sheds + B.halls + B.others + B.ruins;
  assert.ok(stood > board.buildings.count * 0.8, `${stood} stand of ${board.buildings.count} founded`);
  const dropped = stats.dropped.wet + stats.dropped.port + stats.dropped.steep + stats.dropped.edge;
  assert.ok(dropped < board.buildings.count * 0.1, `dropped ${JSON.stringify(stats.dropped)}`);
  assert.ok(stats.churches >= 1 && stats.streets >= 8, `churches ${stats.churches}, streets ${stats.streets}`);
  for (let i = 0; i < plan.typedCount; i++) {
    const at = plan.typed.subarray(i * CITY_TYPED_FLOATS, (i + 1) * CITY_TYPED_FLOATS);
    assert.ok(at.every(Number.isFinite) && plan.typedTypes[i] < CITY_BUILDING_TYPES.length, `building ${i}`);
    if (![CITY_TYPE.WHARF, CITY_TYPE.FOOTBRIDGE, CITY_TYPE.STONE_BRIDGE].includes(plan.typedTypes[i])) assert.ok(bayHeight(at[0], at[2]) > 0.5, `building ${i} stands in the water at ${at[0]}, ${at[2]}`);
  }
  assert.ok(stats.milliseconds < 2000, `laid in ${stats.milliseconds} ms`);

  // Its streets are furnished as the model's own towns are: a trade's front carries its pentice, sign or ale-stake,
  // fixed to the wall that faces its street; the market place has its cross and stalls; none has a block of its own.
  const trades = new Set(Object.keys(BOARD_STREETFRONT)), marketAt = board.quarters.indexOf('market');
  let tradeHouses = 0;
  for (let k = 0; k < board.buildings.count; k++) {
    const arch = board.arches[board.buildings.kinds[k * 6 + 1]];
    if (trades.has(arch) || (arch === 'burgher' && board.buildings.quarter[k] === marketAt)) tradeHouses++;
  }
  assert.equal(board.buildings.quarter.length, board.buildings.count);
  assert.ok(tradeHouses > 0 && stats.fronts > tradeHouses * 0.6 && stats.fronts <= tradeHouses, `fronts ${stats.fronts} of ${tradeHouses} houses of trade`);
  const furnished = { [CITY_TYPE.PENTICE]: 0, [CITY_TYPE.SIGN]: 0, [CITY_TYPE.ALE_STAKE]: 0, [CITY_TYPE.STALL]: 0, [CITY_TYPE.MARKET_CROSS]: 0, [CITY_TYPE.WELL]: 0 };
  for (let i = 0; i < plan.typedCount; i++) {
    const type = plan.typedTypes[i];
    // A slighter work (a length of fence, a bridge, graves, a tent) has no block either; whatever else stands has.
    if (type >= CITY_TYPE_SLIGHT_FROM) { assert.equal(plan.typedBlocks[i * 2 + 1], 0, 'a slight work has no block'); continue; }
    if (!(type in furnished)) { assert.ok(plan.typedBlocks[i * 2 + 1] >= 1, `building ${i} has its block`); continue; }
    furnished[type]++;
    assert.equal(plan.typedBlocks[i * 2 + 1], 0, 'a thing of the street has no block');
    const at = plan.typed.subarray(i * CITY_TYPED_FLOATS, (i + 1) * CITY_TYPED_FLOATS), paint = Math.floor(at[7]);
    assert.ok(paint >= 0 && paint <= 10 && at[5] === 1 && at[6] === 1, `painted ${paint}, unstretched but across`);
    if (CITY_TYPES_OVERHEAD.has(type)) {
      // Fixed above a head, on the front of a house that stands there.
      const ground = bayHeight(at[0], at[2]);
      assert.ok(at[1] - ground > 1.6 && at[1] - ground < 12, `hung ${at[1] - ground} m up`);
      assert.ok(plan.lots.some((f) => Math.hypot(f.x - at[0], f.z - at[2]) < Math.hypot(f.w, f.d) / 2 + 0.5), 'on a house');
    }
  }
  // What hangs on a house follows it in the plan and is counted as its own.
  let hung = 0;
  for (let i = 0; i < plan.typedCount; i++) {
    const own = plan.typedAttached[i];
    hung += own;
    for (let k = 1; k <= own; k++) assert.ok(CITY_TYPES_OVERHEAD.has(plan.typedTypes[i + k]) && !CITY_TYPES_OVERHEAD.has(plan.typedTypes[i]), 'a house and what hangs on it');
  }
  assert.equal(hung, furnished[CITY_TYPE.PENTICE] + furnished[CITY_TYPE.SIGN] + furnished[CITY_TYPE.ALE_STAKE]);
  t.diagnostic(JSON.stringify({ tradeHouses, furnished }));
  assert.ok(furnished[CITY_TYPE.SIGN] > 0 && furnished[CITY_TYPE.PENTICE] > 0, 'signs and pentices');
  assert.equal(furnished[CITY_TYPE.STALL], stats.stalls);
  assert.ok(stats.stalls >= 4 && furnished[CITY_TYPE.MARKET_CROSS] >= 1, `stalls ${stats.stalls}`);

  // Whatever else the model built is stood as what it is: a mill is a mill, a granary a granary, an outbuilding
  // an outbuilding. Each kind is counted where the model has it and stood as its type nearly every time.
  const founded = {}, of = new Array(CITY_BUILDING_TYPES.length).fill(0);
  for (let k = 0; k < board.buildings.count; k++) { const arch = board.arches[board.buildings.kinds[k * 6 + 1]]; if (BOARD_WORKS[arch]) founded[BOARD_WORKS[arch][0]] = (founded[BOARD_WORKS[arch][0]] ?? 0) + 1; }
  for (let i = 0; i < plan.typedCount; i++) of[plan.typedTypes[i]]++;
  t.diagnostic(JSON.stringify({ founded, built: B }));
  assert.ok(Object.keys(founded).length >= 2, `the model founded ${Object.keys(founded)}`);
  for (const [key, n] of Object.entries(founded)) assert.ok(of[CITY_TYPE[key]] <= n && of[CITY_TYPE[key]] >= Math.floor(n * 0.7), `${key}: ${of[CITY_TYPE[key]]} stand of ${n} founded`);
  // A type is fitted to its plot, never beyond recognition; a ruin alone is as large as what fell.
  for (let i = 0; i < plan.typedCount; i++) {
    const type = plan.typedTypes[i], at = plan.typed.subarray(i * CITY_TYPED_FLOATS, (i + 1) * CITY_TYPED_FLOATS);
    if (type >= CITY_TYPE.WINDMILL && type < CITY_TYPE.RUIN) assert.ok(at[4] > 0.79 && at[4] < 1.36 && at[6] > 0.79 && at[6] < 1.36 && at[5] > 0.9 && at[5] < 1.1, `${CITY_BUILDING_TYPES[type].name} stretched ${at[4]}, ${at[5]}, ${at[6]}`);
  }
  // A watermill's wheel is on the side of it where the model's wheel turns.
  const wheels = board.works.wheels;
  for (let w = 0; w < wheels.length; w += 3) {
    const k = wheels[w], x = board.buildings.stand[k * 6], z = board.buildings.stand[k * 6 + 1];
    for (let i = 0; i < plan.typedCount; i++) {
      const at = plan.typed.subarray(i * CITY_TYPED_FLOATS, (i + 1) * CITY_TYPED_FLOATS);
      if (plan.typedTypes[i] !== CITY_TYPE.WATERMILL || Math.hypot(at[0] - x, at[2] - z) > 0.2) continue;
      const out = (CITY_BUILDING_TYPES[CITY_TYPE.WATERMILL].width / 2 + WORKS_WHEEL.out) * at[4], wx = at[0] + out * Math.cos(at[3]), wz = at[2] - out * Math.sin(at[3]);
      assert.ok(Math.hypot(wx - wheels[w + 1], wz - wheels[w + 2]) < 4.5, `a wheel ${Math.hypot(wx - wheels[w + 1], wz - wheels[w + 2])} m from its water`);
    }
  }
  // Its worked furlongs are fenced a length at a time, of rail or of dry stone as the model has them, each length on
  // dry ground and near its own measure; a churchyard is walled; none of these is a gun's target or stops a walker.
  const fenced = board.works.fences.length / 5;
  let lengths = 0;
  for (let i = 0; i < plan.typedCount; i++) {
    const type = plan.typedTypes[i];
    if (type !== CITY_TYPE.FENCE_RAIL && type !== CITY_TYPE.FENCE_STONE) continue;
    const at = plan.typed.subarray(i * CITY_TYPED_FLOATS, (i + 1) * CITY_TYPED_FLOATS);
    lengths++;
    assert.ok(at[4] === 1 && at[5] === 1 && at[6] > 0.3 && at[6] < 1.5, `a length of fence stretched ${at[6]}`);
    assert.ok(CITY_TYPES_SLIGHT.has(type));
  }
  assert.equal(lengths, B.fences);
  assert.ok(fenced > 0 && lengths > fenced, `${lengths} lengths of fence on ${fenced} runs`);
  assert.ok(WORKS_FENCE_M > 2 && board.works.yards.length === B.yards);
  assert.equal(of[CITY_TYPE.FOOTBRIDGE] + of[CITY_TYPE.STONE_BRIDGE], B.bridges);

  // Its land: uses only, no colour (the ground keeps its geography's; the GPU stamps the parcels on it).
  const kinds = new Set(); let woods = 0, forest = 0, town = 0;
  for (let z = -SPAN / 2 + 40; z < SPAN / 2; z += 37) for (let x = -SPAN / 2 + 40; x < SPAN / 2; x += 37) {
    if (bayHeight(x, z) < 0.6) continue;
    const land = country.landAt(x, z, 0), trees = country.treesAt(x, z);
    assert.equal(land.r, undefined);
    assert.ok(land.vegetation >= 0 && land.vegetation <= 1);
    kinds.add(land.kind);
    if (land.kind === OLD_WORLD_LAND.CITY) { town++; assert.ok(trees === OLD_WORLD_NO_TREES || trees.spacing >= 8, 'a town tree is a planted one'); }
    if (land.kind === OLD_WORLD_LAND.WOOD) { woods++; assert.ok(trees === null || trees === OLD_WORLD_NO_TREES, 'a wood keeps the forest\'s rules'); if (trees === null) forest++; }
  }
  for (const kind of [OLD_WORLD_LAND.CITY, OLD_WORLD_LAND.WOOD, OLD_WORLD_LAND.CORN, OLD_WORLD_LAND.PASTURE]) assert.ok(kinds.has(kind), `land of kind ${kind}; seen ${[...kinds]}`);
  assert.ok(woods > 20 && forest > woods * 0.8, `woodland handed to the forest: ${forest} of ${woods}`);
  assert.ok(town > 20, `town ground: ${town}`);
  assert.ok(plan.standing.every(([x, z]) => plan.treesAt(x, z) !== CITY_TREES.NONE), 'every planted tree stands where a tree may');

  // What the GPU is handed: the furlong of every cell, a row for every furlong, a capsule for every way.
  const stamp = country.board, tables = boardStampTables(stamp);
  assert.equal(stamp.size, BOARD_INDEX_SIZE);
  assert.ok(stamp.index instanceof Uint16Array && stamp.index.length === BOARD_INDEX_SIZE ** 2);
  let most = 0, held = 0;
  for (let k = 0; k < stamp.index.length; k++) { most = Math.max(most, stamp.index[k]); if (stamp.index[k]) held++; }
  assert.equal(most, stamp.uses.length, 'the last furlong has its cells, and no cell names a furlong there is not');
  assert.ok(held > stamp.index.length * 0.3, `cells in a furlong: ${held}`);
  assert.equal(tables.parcels.length, (stamp.uses.length + 1) * 8);
  assert.ok(tables.parcels.subarray(0, 8).every((v) => v === 0), 'ground in no furlong is left as it is');
  assert.equal(tables.ways.length, tables.wayCount * BOARD_WAY_FLOATS);
  assert.ok(tables.wayCount > plan.houses, `ways ${tables.wayCount}: a roof for every house, and the roads, lanes and streets`);
  assert.ok(tables.parcels.every(Number.isFinite) && tables.ways.every(Number.isFinite));
  let tinted = 0, wild = 0;
  stamp.uses.forEach((use, k) => { if (tables.parcels[(k + 1) * 8 + 3] > 0) tinted++; else wild++; });
  assert.ok(tinted > 50 && wild > 0, `furlongs tinted ${tinted}, left to the ground's own colour ${wild}`);

  // The same port on other ground: the board is left aside and the rules here make the town.
  const other = ground(SAMPLES, (x, z) => bayHeight(x, z - 400)), made = oldWorldCountry(region(), other, port());
  assert.equal(made.board, null);
  assert.ok(made.plan && made.plan.houses > 0, 'a town is made all the same');
  let coloured = 0;
  for (let x = -1500; x < 1500; x += 90) { const land = made.landAt(x, -900, 0); if (land.r !== undefined) coloured++; }
  assert.ok(coloured > 20, 'and its land is coloured by the rules here');
  // And in another year.
  assert.equal(oldWorldCountry(region({ year: 1650 }), ground(), port()).board, null);
});

test('Lisbon\'s board of 1550 is baked from this model, fitted to its ground and its real places', () => {
  assert.equal(bakedBoardAsset('lisbon', 1550), BAKED_BOARDS['lisbon:1550']);
  assert.equal(bakedBoardAsset('lisbon', 1650), null);
  const path = new URL('../' + BAKED_BOARDS['lisbon:1550'], import.meta.url);
  assert.ok(existsSync(path));
  const baked = JSON.parse(readFileSync(path, 'utf8')), board = baked.board;
  assert.equal(baked.port, 'lisbon'); assert.equal(baked.year, 1550);
  assert.equal(board.version, BOARD_VERSION);
  assert.equal(board.span, 8192); assert.equal(baked.region.span, 8192);
  assert.match(baked.key, /^[0-9a-f]{16}$/);
  assert.equal(baked.survey.length, BOARD_SURVEY_SIZE ** 2);
  assert.ok(baked.survey.some((h) => h < 0) && baked.survey.some((h) => h > 60), 'a survey of sea and hills');
  assert.deepEqual(baked.request.rivers, { ...BOARD_RIVERS });
  assert.equal(baked.request.lived, 1);
  // The valleys' streams, not a brook to every hectare.
  assert.ok(board.rivers.length >= 2 && board.rivers.length <= 12, `rivers: ${board.rivers.length}`);
  // Its places are the real ones.
  const real = new Set(OLD_WORLD_PLACES.lisbon.map(([name]) => name)), named = board.places.filter((p) => real.has(p.name));
  assert.equal(board.places[0].kind, 'capital'); assert.equal(board.places[0].name, 'Lisboa');
  assert.ok(named.length >= 6, `real places: ${named.map((p) => p.name)}`);
  assert.ok(board.people > 18000 && board.places[0].people > 6000 && board.buildings.count > 4000, `${board.people} total people (${board.places[0].people} in Lisboa), ${board.buildings.count} buildings`);
  const lisbonHerds = board.places.reduce((s, p) => s + (p.herds?.sheep || 0) + (p.herds?.cattle || 0) + (p.herds?.horses || 0) + (p.herds?.swine || 0), 0);
  assert.ok(lisbonHerds > 1000, `Lisbon lived herds: ${lisbonHerds}`);
  // And the page is given it.
  const build = readFileSync(new URL('../build.mjs', import.meta.url), 'utf8');
  assert.ok(build.includes(`'${BAKED_BOARDS['lisbon:1550']}'`), 'the build publishes the baked board');
});

test('Lisbon\'s whole founded world is frozen beside its board, by the program that is here', () => {
  assert.equal(bakedWorldAsset('lisbon', 1550), BAKED_WORLDS['lisbon:1550']);
  assert.equal(bakedWorldAsset('lisbon', 1650), null);
  const baked = JSON.parse(readFileSync(new URL('../' + BAKED_BOARDS['lisbon:1550'], import.meta.url), 'utf8')), world = baked.world;
  const bytes = readFileSync(new URL('../' + BAKED_WORLDS['lisbon:1550'], import.meta.url));
  assert.equal(bytes.length, world.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'), world.sha256);
  assert.ok(bytes[0] === 0x1f && bytes[1] === 0x8b, 'the model\'s own save, zipped');
  // A world is taken up only by the program that froze it: the model's text as it stands here.
  assert.equal(world.program, createHash('sha256').update(readFileSync(new URL('../assets/board/game.js', import.meta.url), 'utf8')).digest('hex'));
  assert.equal(world.day, baked.board.day); assert.equal(world.year, 1550);
  // Everything is kept, whether or not the game draws it yet.
  const holds = world.holds;
  assert.equal(holds.settlements, baked.board.places.length);
  // Its seat's watch is in the record by name: more men than the port has posts.
  const kept = baked.board.places[0].watch;
  assert.ok(kept.garrison > 500 && kept.men.length === 96 && new Set(kept.men.map((one) => one.id)).size === 96, `a watch of ${kept.garrison}, ${kept.men.length} named`);
  assert.equal(holds.buildings, baked.board.buildings.count);
  assert.ok(holds.houses >= 4 && holds.fields > 1500 && holds.roads >= 4 && holds.trees > 1000, JSON.stringify(holds));
  for (const key of ['armies', 'ships', 'caravans', 'abbeys', 'churchBodies', 'projects', 'tracks', 'fences']) assert.ok(Number.isInteger(holds[key]), `it counts its ${key}`);
  // And the page is given the world and the program that lives it, fetched when wanted and never embedded.
  const build = readFileSync(new URL('../build.mjs', import.meta.url), 'utf8');
  for (const path of [BAKED_WORLDS['lisbon:1550'], 'assets/board/game.js', 'assets/board/runtime.js']) assert.ok(build.split(`'${path}'`).length >= 3, `the build publishes ${path} and leaves it outside a downloaded page`);
});

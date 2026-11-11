// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The houses of an Old World town, written in Cairn by rule: each height in several manners (plain, jettied timber
// frame, dressed stone, shop, arcade, low and hipped), the particulars thrown by each type's own dice; the two words
// the Cairn language gained for them; and the mix of heights a sixteenth-century Iberian port stood at.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { buildPortPrefabGeometry } from '../js/coastal-world.js';
import { CITY_BUILDING_TYPES, CITY_HOUSE_STOREYS, CITY_HOUSE_TYPES, CITY_STOREY_M, CITY_TYPE, cityHousePick, cityHouseType, cityTypeTarget, compileCityBuildingTypes } from '../js/old-world-buildings.js';
import { oldWorldCountry } from '../js/old-world.js';

const houses = CITY_BUILDING_TYPES.slice(0, CITY_HOUSE_TYPES);
const storeysOf = (spec) => Math.round(spec.height / CITY_STOREY_M);
const named = (spec, name) => spec.primitives.filter((p) => typeof p.name === 'string' && p.name.startsWith(name));
const build = (spec) => buildPortPrefabGeometry({ singleBuildingPrefab: true, instances: [{ prefabId: 'test', id: 'test', x: 0, y: 0, z: 0, yaw: 0, width: spec.width, length: spec.length, depth: spec.length, height: spec.height, foundationDepth: 1, materialKind: 12, roofPitch: 2, cairnSpec: spec }] }, null);

test('every height of house is built in several manners, each a type of its own, and none asked is the plain house', () => {
  assert.ok(CITY_HOUSE_TYPES >= 2 * CITY_HOUSE_STOREYS + 16, `house types: ${CITY_HOUSE_TYPES}`);
  assert.equal(CITY_TYPE.CHURCH_LEFT, CITY_HOUSE_TYPES, 'the houses come first, every other type after them');
  assert.equal(new Set(CITY_BUILDING_TYPES.map((spec) => spec.name)).size, CITY_BUILDING_TYPES.length, 'every type has its own name');
  for (let type = 0; type < CITY_BUILDING_TYPES.length; type++) assert.equal(cityTypeTarget(type).prefabId === 'city_house', type < CITY_HOUSE_TYPES);
  const manners = new Set();
  for (const eaves of [true, false]) for (let storeys = 1; storeys <= CITY_HOUSE_STOREYS; storeys++) {
    const plain = cityHouseType(storeys, eaves);
    assert.equal(plain, (eaves ? CITY_TYPE.HOUSE_EAVES : CITY_TYPE.HOUSE_GABLE) + storeys - 1);
    assert.equal(CITY_BUILDING_TYPES[plain].manner, 'plain');
    const met = new Map();
    for (let k = 0; k < 4000; k++) { const type = cityHouseType(storeys, eaves, (k + 0.5) / 4000); met.set(type, (met.get(type) || 0) + 1); }
    assert.ok(met.size >= 2 && met.has(plain), `${storeys} storeys: ${met.size} manners`);
    for (const [type, count] of met) {
      const spec = CITY_BUILDING_TYPES[type];
      assert.ok(type < CITY_HOUSE_TYPES && storeysOf(spec) === storeys, `${spec.name} for ${storeys} storeys`);
      assert.equal(/eaves to the street\)$/.test(spec.name), eaves, spec.name);
      assert.deepEqual([spec.width, spec.length, spec.height], [CITY_BUILDING_TYPES[plain].width, CITY_BUILDING_TYPES[plain].length, CITY_BUILDING_TYPES[plain].height], 'a manner keeps the plot and height of its plain house');
      assert.ok(count > 4000 * 0.08, `${spec.name} is met with: ${count} in 4000`);
      manners.add(spec.manner);
    }
  }
  assert.deepEqual([...manners].sort(), ['arcada', 'baixa', 'cantaria', 'loja', 'plain', 'ressalto']);
  assert.equal(cityHouseType(9, true, 0.5), cityHouseType(CITY_HOUSE_STOREYS, true, 0.5));
  // A house's throw is its own: the same where it stands, another next door.
  assert.equal(cityHousePick(120.4, -33.1), cityHousePick(120.4, -33.1));
  const throws = new Set(); for (let k = 0; k < 200; k++) throws.add(Math.floor(cityHousePick(k * 6.3, k * -2.1) * 10));
  assert.equal(throws.size, 10, 'throws fall across the whole range');
});

test('each manner is built by its rule: timber only above stone, jetties stepping out, an arcade on its columns', () => {
  for (const spec of houses) {
    const storeys = storeysOf(spec), fronts = named(spec, 'street_front_'), hd = spec.length / 2;
    assert.equal(fronts.length, storeys, spec.name);
    const out = fronts.map((wall) => -hd - (wall.from[2] - wall.thickness / 2)), timber = fronts.map((wall) => wall.surround === 'oak');
    assert.ok(!timber[0], `${spec.name}: the ground floor is masonry`);
    for (let s = 1; s < storeys; s++) {
      assert.ok(out[s] >= out[s - 1] - 1e-9 || s === 1 && out[0] < 0, `${spec.name}: floor ${s} stands back of the one below`);
      assert.ok(out[s] <= 1.1 + 1e-9, `${spec.name}: floor ${s} jettied ${out[s]} m`);
      assert.equal(timber[s], named(spec, `timber_frame_${s}`).length > 0, `${spec.name}: floor ${s} is framed if and only if its openings are`);
      if (timber[s]) assert.ok(out[s] > 0.3 && fronts[s].thickness < 0.35, `${spec.name}: a framed floor is thin and jettied`);
      if (timber[s] && s + 1 < storeys) assert.ok(timber[s + 1], `${spec.name}: no stone over timber`);
      if (out[s] > out[s - 1] + 0.01 && out[s - 1] >= 0) assert.ok(named(spec, `jetty_floor_${s}`).length === 1 && named(spec, `jetty_brackets_${s}`).length >= 3, `${spec.name}: floor ${s} is carried on brackets`);
    }
    const framed = timber.some(Boolean), columns = spec.primitives.filter((p) => p.primitive === 'cylinder').length;
    if (spec.manner === 'ressalto') assert.ok(framed && named(spec, 'balcony').length === 0, spec.name);
    if (spec.manner === 'plain' || spec.manner === 'cantaria' || spec.manner === 'loja' || spec.manner === 'baixa') assert.ok(!framed, spec.name);
    if (spec.manner === 'arcada') {
      const bays = Math.max(2, Math.round(spec.width / 2.4));
      assert.equal(columns, bays + 1, `${spec.name}: a column to each bay line`);
      assert.ok(out[0] < -2 && storeys >= 3, `${spec.name}: the ground floor stands back behind them`);
      assert.ok(named(spec, 'arcade_beam').length === 1);
    } else { assert.equal(columns, 0, spec.name); assert.equal(out[0], 0, spec.name); }
    if (spec.manner === 'cantaria') assert.ok(named(spec, 'quoins').length === 2 && named(spec, 'cornice').length === 1, spec.name);
    if (spec.manner === 'loja') assert.ok(named(spec, 'shop_counter').length === 1 && fronts[0].openings.some((o) => o.door) && fronts[0].openings.some((o) => !o.door && o.width > 1.8), spec.name);
    if (spec.manner === 'baixa') assert.ok(storeys === 1 && spec.primitives.some((p) => p.primitive === 'roof' && p.style === 'hip' || p.children?.some((c) => c.style === 'hip')), spec.name);
    assert.ok(fronts[0].openings.filter((o) => o.door).length === 1, `${spec.name}: one street door`);
  }
});

test('every house compiles to a mesh within its budget, stands on its plot, and is the same house made again', async () => {
  const types = compileCityBuildingTypes(buildPortPrefabGeometry);
  for (let id = 0; id < CITY_HOUSE_TYPES; id++) {
    const type = types[id], spec = CITY_BUILDING_TYPES[id], { min, max } = type.source, kinds = new Set();
    for (let k = 6; k < type.source.vertices.length; k += 8) kinds.add(Math.floor(type.source.vertices[k] + 0.01));
    assert.ok(type.triangles > 600 && type.triangles < 4600, `${spec.name}: ${type.triangles} triangles`);
    for (const kind of [10, 11, 12, 13, 14]) assert.ok(kinds.has(kind), `${spec.name} has material ${kind}`);
    assert.ok([...kinds].every((kind) => kind >= 10 && kind <= 18), `${spec.name}: materials ${[...kinds]}`);
    assert.ok(type.source.vertices.every(Number.isFinite));
    // Its sides are its plot's (eaves and a chimney cap may pass them by a hand); its front may stand out over the
    // street as far as a jetty, a balcony or a pentice and the eaves over that; its back is its plot's.
    assert.ok(min[0] > -spec.width / 2 - 0.66 && max[0] < spec.width / 2 + 0.66, `${spec.name} across: ${min[0]} to ${max[0]}`);
    assert.ok(min[2] > -spec.length / 2 - 1.75 && max[2] < spec.length / 2 + 0.66, `${spec.name} along: ${min[2]} to ${max[2]}`);
    assert.ok(max[1] > spec.height + 0.8 && max[1] < spec.height + 4.6, `${spec.name} roof and chimney: ${max[1]} over walls of ${spec.height}`);
    if (spec.manner === 'ressalto') {
      // Oak out over the street above the ground floor: the frame, the brackets and the floor they carry.
      let oak = 0;
      for (let k = 0; k < type.source.vertices.length; k += 8) if (Math.floor(type.source.vertices[k + 6] + 0.01) === 10 && type.source.vertices[k + 2] < -spec.length / 2 - 0.2 && type.source.vertices[k + 1] > CITY_STOREY_M - 0.6) oak++;
      assert.ok(oak > 150, `${spec.name}: ${oak} corners of oak over the street`);
    }
  }
  const again = await import('../js/old-world-buildings.js?again');
  assert.notEqual(again.CITY_BUILDING_TYPES, CITY_BUILDING_TYPES);
  assert.deepEqual(again.CITY_BUILDING_TYPES, CITY_BUILDING_TYPES, 'the dice are each type\'s own');
});

test('Cairn turns a part about any axis, and frames a wall\'s openings in what the wall says', () => {
  const spec = (primitives) => ({ schemaVersion: '0.4', name: 'test', width: 6, length: 6, height: 4, foundationDepth: 1, materialKind: 12, roofPitch: 0, waterfront: false, primitives });
  const bounds = (built) => { const min = [Infinity, Infinity, Infinity], max = [-Infinity, -Infinity, -Infinity]; for (let k = 0; k < built.vertices.length; k += 8) if (Math.floor(built.vertices[k + 6] + 0.01) === 10) for (let a = 0; a < 3; a++) { min[a] = Math.min(min[a], built.vertices[k + a]); max[a] = Math.max(max[a], built.vertices[k + a]); } return { min, max }; };
  const bar = { primitive: 'box', from: [-1, -0.1, -0.05], to: [1, 0.1, 0.05], material: 'oak' };
  const close = (got, want, what) => got.forEach((v, a) => assert.ok(Math.abs(v - want[a]) < 1e-6, `${what}: ${got} for ${want}`));
  const level = bounds(build(spec([{ primitive: 'group', position: [0, 2, 0], children: [bar] }])));
  close(level.min, [-1, 1.9, -0.05], 'level'); close(level.max, [1, 2.1, 0.05], 'level');
  const upright = bounds(build(spec([{ primitive: 'group', position: [0, 2, 0], rotation: [0, 0, 90], children: [bar] }])));
  close(upright.min, [-0.1, 1, -0.05], 'turned about z'); close(upright.max, [0.1, 3, 0.05], 'turned about z');
  const tipped = bounds(build(spec([{ primitive: 'group', position: [0, 2, 0], rotation: [90, 0, 0], children: [bar] }])));
  close(tipped.min, [-1, 1.95, -0.1], 'turned about x'); close(tipped.max, [1, 2.05, 0.1], 'turned about x');
  const brace = bounds(build(spec([{ primitive: 'group', position: [0, 2, 0], rotation: [0, 0, 45], children: [bar] }])));
  assert.ok(Math.abs(brace.max[0] - brace.max[1] + 2) < 1e-6 && brace.max[0] > 0.7 && brace.max[0] < 0.8, `a brace at 45 degrees: ${brace.max}`);
  const turned = bounds(build(spec([{ primitive: 'group', position: [0, 2, 0], rotation: [0, 90, 0], children: [bar] }])));
  close(turned.min, [-0.05, 1.9, -1], 'turned about the vertical, as before'); close(turned.max, [0.05, 2.1, 1], 'turned about the vertical, as before');

  const wall = (more) => build(spec([{ primitive: 'wall', from: [-3, 0, 0], to: [3, 0, 0], height: 3, thickness: 0.3, material: 'stucco', openings: [{ offset: 3, width: 1, height: 1.2, sill: 0.9 }], ...more }]));
  // The builder sets every building on a footing of its own stone: count what the wall itself adds to it.
  const count = (built, kind) => { let n = 0; for (let k = 6; k < built.vertices.length; k += 8) if (Math.floor(built.vertices[k] + 0.01) === kind) n++; return n; };
  const blind = build(spec([{ primitive: 'wall', from: [-3, 0, 0], to: [3, 0, 0], height: 3, thickness: 0.3, material: 'stucco' }]));
  const stone = wall({}), oak = wall({ surround: 'oak' });
  assert.ok(count(stone, 11) > count(blind, 11) && count(stone, 10) === count(blind, 10), 'dressed stone, unless the wall says otherwise');
  assert.equal(count(oak, 11), count(blind, 11), 'a timber front has no stone about its window');
  assert.equal(count(oak, 10) - count(blind, 10), count(stone, 11) - count(blind, 11), 'the same jambs and lintel, in oak');
  assert.ok(count(oak, 14) > 0 && count(oak, 14) === count(stone, 14) && count(oak, 12) === count(stone, 12));
  assert.equal(wall({}).vertices.length, wall({ surround: 'oak' }).vertices.length);
});

test('a town made by the rules here stands mostly one to three floors, in every manner', () => {
  // The shore of tests/old-world.test.mjs with a height the town can climb.
  const region = { id: 'test-shore', latitude: 38.7, longitude: -9.14, x: 0, z: 0, span: 4096, size: 257, biomeSize: 128, albedoSize: 256 };
  const n = region.size, heights = new Float32Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const x = (i / (n - 1) - 0.5) * region.span, z = (j / (n - 1) - 0.5) * region.span;
    heights[j * n + i] = z > 0 ? -4 - z * 0.01 : 1.5 - z * 0.02 + 90 * Math.exp(-((x - 700) ** 2 + (z + 650) ** 2) / (2 * 170 ** 2)) + 70 * Math.exp(-((x + 450) ** 2 + (z + 520) ** 2) / (2 * 330 ** 2));
  }
  const plan = oldWorldCountry(region, heights, { center: { x: 0, z: -30 }, clearRadius: 150, instances: [] }).plan;
  const byStoreys = new Array(CITY_HOUSE_STOREYS + 1).fill(0), byManner = {};
  let all = 0;
  for (const type of plan.typedTypes) if (type < CITY_HOUSE_TYPES) { const spec = CITY_BUILDING_TYPES[type]; byStoreys[storeysOf(spec)]++; byManner[spec.manner] = (byManner[spec.manner] || 0) + 1; all++; }
  assert.equal(all, plan.houses);
  assert.ok(all > 1500, `houses: ${all}`);
  const share = (k) => byStoreys[k] / all;
  assert.ok(share(1) + share(2) + share(3) > 0.88, `one to three floors: ${byStoreys}`);
  assert.ok(share(4) + share(5) > 0.01 && share(4) + share(5) < 0.12, `four and five floors are the merchants' few: ${byStoreys}`);
  assert.ok(share(5) < 0.03 && share(5) < share(4), `five the fewest: ${byStoreys}`);
  assert.ok(share(1) > 0.1 && share(2) > 0.25, `low houses are the most of it: ${byStoreys}`);
  for (const manner of ['plain', 'ressalto', 'cantaria', 'loja', 'arcada', 'baixa']) assert.ok(byManner[manner] > all * 0.01, `${manner}: ${byManner[manner]} of ${all}`);
  assert.ok(byManner.plain < all * 0.6, `plain houses are not the whole town: ${byManner.plain} of ${all}`);
});

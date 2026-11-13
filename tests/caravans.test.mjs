// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The country model's caravans on its roads: each cart a wagon behind a yoke of oxen, each drove its beasts, laid as
// travelling seeds of the herds' GPU pass along a route buffer, proven on Lisbon's own frozen world.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { openBoard } from '../scripts/board-host.mjs';
import { caravanHerdSeeds } from '../js/herds.js';
import { getWagonMesh } from '../js/models/livestock-meshes.js';
import { boardDayAt, boardDayOf } from '../js/board-life.js';

const baked = JSON.parse(readFileSync(new URL('../assets/boards/lisbon-1550.json', import.meta.url), 'utf8'));
const world = () => new Uint8Array(readFileSync(new URL('../assets/boards/lisbon-1550.world', import.meta.url)));

test('Lisbon\'s caravans come from the model with their roads, days, wagons and goods', { timeout: 600000 }, async (t) => {
  const model = await openBoard(baked.request, { world: world() });
  t.after(() => model.close());
  const answer = await model.hook('caravans');
  assert.equal(answer.day, baked.world.day);
  assert.ok(answer.list.length >= 6, `${answer.list.length} caravans`);
  for (const c of answer.list) {
    assert.ok(['cart', 'river', 'sea'].includes(c.mode));
    assert.ok(c.arrive > c.depart && c.depart <= answer.day, `${c.key} ${c.depart}..${c.arrive}`);
    assert.ok(c.points.length >= 4 && c.points.length % 2 === 0);
    assert.ok(c.carts >= 1 && c.carts <= 4);
  }
  const origin = { x: baked.region.x, z: baked.region.z }, laid = caravanHerdSeeds(answer.list, origin);
  const carts = answer.list.filter((c) => c.mode === 'cart');
  assert.ok(laid.seeds.length > 0 && laid.seeds.length % 8 === 0);
  // Every seed names a route header whose length is the summed length of its points, and walks it.
  for (let k = 0; k < laid.seeds.length; k += 8) {
    const h = laid.seeds[k] * 4, count = laid.routes[h + 2], total = laid.routes[h + 3];
    assert.equal(laid.seeds[k + 2], -1, 'a traveller is flagged by a negative roam');
    assert.ok(count >= 2 && total > 1);
    assert.ok(Math.abs(laid.routes[h + 4 + (count - 1) * 4 + 2] - total) < 1e-2);
    assert.ok([0, 1, 2, 3, 4].includes(laid.seeds[k + 6]));
  }
  // A load of goods is a wagon behind two oxen; a drove is beasts of its kind alone.
  const wagons = [], oxen = [];
  for (let k = 0; k < laid.seeds.length; k += 8) {
    if (laid.seeds[k + 6] === 4) wagons.push(k);
    else if (laid.seeds[k + 4] < 1 && laid.seeds[k + 6] === 1) oxen.push(k);
  }
  const goods = carts.filter((c) => !['sheep', 'cattle', 'horses', 'swine'].includes(c.good));
  assert.equal(wagons.length, goods.reduce((n, c) => n + c.carts, 0));
  assert.equal(oxen.length, wagons.length * 2);
  // Days go on and the model's caravans with them: some arrive, others set out.
  await model.live(20);
  const later = await model.hook('caravans');
  assert.ok(later.list.some((c) => c.depart > answer.day), 'new loads set out');
});

test('a wagon is a closed, outward body on four wheels and a pole, and the model\'s day has its fraction', () => {
  const w = getWagonMesh();
  assert.equal(w.vertices.length % 8, 0);
  assert.ok(w.indexCount / 3 > 200 && w.indexCount / 3 < 1200, `${w.indexCount / 3} triangles`);
  let wheels = 0, canvas = 0, front = -Infinity;
  for (let i = 0; i < w.vertices.length; i += 8) {
    if (w.vertices[i + 6] === 7) wheels++;
    if (Math.floor(w.vertices[i + 7]) === 2) canvas++;
    front = Math.max(front, w.vertices[i + 2]);
  }
  assert.ok(wheels > 0 && canvas > 0);
  assert.ok(front > 3, 'the pole reaches forward to the yoke');
  const at = Date.UTC(1550, 2, 14, 12);
  assert.equal(Math.floor(boardDayAt(at, 1549)), boardDayOf(at, 1549));
  assert.ok(boardDayAt(at, 1549) % 1 > 0.3 && boardDayAt(at, 1549) % 1 < 0.9);
});

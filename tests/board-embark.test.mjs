// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Going to sea as the captain's mate, in the model's own terms. A person of a founded port who signs on leaves the
// town's roll as one of the model's travellers, bound home and not arriving until put ashore: the town's monthly
// reckoning cannot bury them while they are gone, the model's card still knows them, the frozen world keeps them
// at sea, and put ashore they are on the roll again. Proven on Lisbon's own world, beside one where no one goes.
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { test } from 'node:test';
import { openBoard } from '../scripts/board-host.mjs';
import { mateShortlist } from '../js/storyteller.js';

const baked = JSON.parse(readFileSync(new URL('../assets/boards/lisbon-1550.json', import.meta.url), 'utf8'));
const world = () => new Uint8Array(readFileSync(new URL('../assets/boards/lisbon-1550.world', import.meta.url)));
const card = (model, id) => model.request('view', { kind: 'ui', panel: 'advisor-inspect', code: 'p' + id, full: true });
const grown = async (model) => new Map((await model.hook('folk', 0, { most: 1, others: 100000 })).others.map((soul) => [soul.id, soul]));

test('a mate who goes to sea is off the town\'s roll and out of its reckoning, known still, kept so, and comes home', { timeout: 900000 }, async (t) => {
  const home = await openBoard(baked.request, { world: world() }), sea = await openBoard(baked.request, { world: world() });
  t.after(() => { home.close(); sea.close(); });
  // The same people might sign on in either world: they are one world yet.
  const asked = await sea.hook('folk', 0, { most: 1, others: 900 });
  assert.equal(JSON.stringify(await home.hook('folk', 0, { most: 1, others: 900 })), JSON.stringify(asked));
  const six = mateShortlist(asked.others, { n: 6 });
  assert.equal(six.length, 6);

  // They sign on: each is told off the roll once, and asked again is at sea already.
  const before = await grown(sea);
  for (const one of six) {
    assert.ok(before.has(one.id));
    const gone = await sea.hook('embark', one.id);
    assert.deepEqual({ id: gone.id, name: gone.name, home: gone.home, already: gone.already }, { id: one.id, name: one.name, home: 0, already: false });
    assert.equal((await sea.hook('embark', one.id)).already, true);
  }
  const after = await grown(sea);
  assert.equal(after.size, before.size - 6); for (const one of six) assert.ok(!after.has(one.id), `${one.name} walks the town no more`);
  // The model's own card still knows them, and its finder; their life says where they went.
  const theirs = await card(sea, six[0].id);
  assert.equal(theirs.kind, 'person'); assert.ok(theirs.card.startsWith(six[0].name), theirs.card.slice(0, 80));
  assert.match(theirs.card, /Went to sea from Lisboa as a ship's mate/);
  // No one unknown, no child, no one twice; and no one is put ashore who never went.
  await assert.rejects(sea.hook('embark', 987654321), /knows no one of that number/);
  assert.deepEqual(await sea.hook('disembark', 987654321), { id: 987654321, ashore: false });
  const child = (await sea.hook('folk', 0, { most: 400 })).people.find((one) => one.age < 12);
  if (child) await assert.rejects(sea.hook('embark', child.id), /not free to go/);

  // Both worlds live past the month's reckoning of the town (the eighth day). At home it buries whom it buries;
  // of those at sea it can bury none.
  const days = 9;
  await Promise.all([home.live(days), sea.live(days)]);
  const fate = async (model, id) => { const answer = await card(model, id); return /: Died |†/.test(answer.card.split('\n').filter((line) => /Died/.test(line)).join('\n')) ? 'dead' : 'alive'; };
  const atHome = [], atSea = [];
  for (const one of six) { atHome.push(await fate(home, one.id)); atSea.push(await fate(sea, one.id)); }
  t.diagnostic(`after ${days} days: at home ${six.map((one, i) => `${one.name} ${atHome[i]}`).join(', ')}`);
  assert.deepEqual(atSea, six.map(() => 'alive'));
  assert.equal((await sea.hook('embark', six[0].id)).already, true, 'still at sea, not landed by the days');

  // Frozen and taken up again, the world keeps them at sea.
  const frozen = await sea.freeze(), again = await openBoard(baked.request, { world: frozen });
  t.after(() => again.close());
  for (const one of six) assert.equal((await again.hook('embark', one.id)).already, true, `${one.name} kept at sea`);

  // Put ashore, they are on the roll again in their own town, and the world lives on.
  const landed = await sea.hook('disembark', six[0].id);
  assert.deepEqual(landed, { id: six[0].id, name: six[0].name, home: 0, ashore: true });
  assert.deepEqual(await sea.hook('disembark', six[0].id), { id: six[0].id, ashore: false });
  assert.ok((await grown(sea)).has(six[0].id), 'on the roll again');
  assert.match((await card(sea, six[0].id)).card, /Came home to Lisboa from the sea/);
  assert.equal((await sea.hook('embark', six[1].id)).already, true, 'the others sail on');
  await sea.live(2);
  assert.equal(await fate(sea, six[1].id), 'alive');
});

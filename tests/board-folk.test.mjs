// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The model's people as the walkers the GPU walks, and what each says of themselves when asked.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { FOLK_WAY_MOST_M, boardFolkStreets, folkDoing, folkRoll } from '../js/board-folk.js';
import { folkCardFacts, folkSoulOfTitle, folkSpeech } from '../js/folk-card.js';
import { ROUTE_STEP_M, WALKER_WORDS, townSolids } from '../js/town-streets.js';
import { townWalkerStride } from '../js/audio.js';

const person = (id, more = {}) => ({ id, name: `Soul ${id}`, surname: 'Soul', sex: id % 2 ? 'f' : 'm', age: 30, role: 'brewer', goal: 'work', there: 'brewing', via: 'Market street',
  open: false, run: false, pace: 1.2, home: [0, 0], route: [0, 0, 60, 0, 60, 40], ...more });
const plan = (people, others = []) => ({ si: 0, day: 12, date: 'Spring 13, AD 1550', sunday: false, people, others });
// A port's own streets: two who walk between its buildings on a way of ten samples.
function ownStreets() {
  const samples = new Float32Array(10 * 4), walkers = new Float32Array(2 * WALKER_WORDS), words = new Uint32Array(walkers.buffer);
  for (let k = 0; k < 10; k++) samples.set([500 + k * ROUTE_STEP_M, 2, 900, 1.5], k * 4);
  for (let w = 0; w < 2; w++) { const at = w * WALKER_WORDS; words[at] = w * 5; words[at + 1] = 5; walkers[at + 3] = 1.3; walkers[at + 8] = 4 * ROUTE_STEP_M; words[at + 10] = 7; words[at + 11] = 8 | (w ? 0 : 1); }
  return { samples, walkers, people: 2, window: { x: 500, z: 900, span: 400 }, ways: ['kept'] };
}

test('a soul\'s rolls are its own: the same each time, apart from another\'s, and within one', () => {
  const seen = new Set();
  for (let id = 1; id < 400; id++) for (let salt = 0; salt < 4; salt++) {
    const roll = folkRoll(id, salt);
    assert.ok(roll >= 0 && roll < 1);
    assert.equal(roll, folkRoll(id, salt));
    seen.add(roll);
  }
  assert.ok(seen.size > 1590, `${seen.size} of 1596 rolls differ`);
});

test('the model\'s plan becomes ways and walkers the GPU walks, each one a soul', () => {
  const heightAt = (x, z) => 3 + x * 0.01;
  const people = [
    person(11),
    person(12, { goal: 'play', there: 'at play', age: 8, role: null, run: true, pace: 1.5, route: [0, 0, 10, 0], home: [0, 0] }),
    person(13, { route: [5, 5, 6, 5] }),
    person(14, { goal: 'work', open: true, there: 'ploughing', route: [0, 0, 3000, 0] }),
    person(15, { goal: 'errand', there: 'at the market', via: '', open: true }),
  ];
  const others = [{ id: 71, name: 'Ana Barqueiro', surname: 'Barqueiro', sex: 'f', age: 40, role: 'fisher' }];
  const base = ownStreets(), streets = boardFolkStreets({ plan: plan(people, others), origin: { x: 1000, z: 2000 }, heightAt, base });

  // A way too short to walk has no walker; the port names one other, so one of its own two walks.
  assert.equal(streets.people, 5);
  assert.deepEqual(streets.folk, { day: 12, date: 'Spring 13, AD 1550', sunday: false, planned: 4, own: 1, cut: 0 });
  assert.equal(streets.walkers.length, 5 * WALKER_WORDS);
  assert.deepEqual(streets.souls.map((soul) => soul.id), [11, 12, 14, 15, 71]);
  assert.equal(streets.window, base.window); assert.equal(streets.ways, base.ways);
  assert.equal(base.people, 2, 'and the port\'s own streets are as they were');

  const words = new Uint32Array(streets.walkers.buffer), f = streets.walkers;
  // The port's own samples come first, so its walkers' ways still begin where they did.
  assert.deepEqual([...streets.samples.subarray(0, 40)], [...base.samples]);
  // Soul 11: a hundred metres by the corner, a sample every step, on the ground, to one side of the model's line.
  assert.equal(words[0], 10); assert.equal(words[1], Math.floor(100 / ROUTE_STEP_M) + 1);
  assert.equal(f[8], 80 * ROUTE_STEP_M);
  const sample = (k) => [...streets.samples.subarray((10 + k) * 4, (10 + k) * 4 + 4)];
  assert.deepEqual(sample(0), [1000, Math.fround(heightAt(1000, 2000)), 2000, Math.fround(0.45)]);
  assert.deepEqual(sample(48).slice(0, 3), [1060, Math.fround(heightAt(1060, 2000)), 2000], 'the corner, sixty metres on');
  assert.deepEqual(sample(80).slice(0, 3), [1060, Math.fround(heightAt(1060, 2040)), 2040], 'and the far end');
  assert.ok(f[3] >= 0.7 && f[3] <= 2.4); assert.equal(f[3], Math.fround(1.2));
  assert.ok(f[7] >= 150 && f[7] <= 420, 'at work a while');
  assert.equal(words[11], 1, 'a woman, indoors at both ends');
  assert.deepEqual(streets.souls[0], { id: 11, name: 'Soul 11', surname: 'Soul', sex: 'f', age: 30, role: 'brewer', goal: 'work', there: 'brewing', via: 'Market street', home: [1000, 2000], to: [1060, 2040], planned: true });

  // A child at play runs, stays in the open at both ends and is in before dark.
  const child = WALKER_WORDS;
  assert.equal(f[child + 3], Math.fround(2.25)); assert.equal(words[child + 11] & 6, 6);
  assert.ok(f[child + 9] >= 0.55); assert.equal(f[child + 5], 0, 'and does not stop to talk');
  assert.ok(f[child + 7] >= 4 && f[child + 7] <= 18);
  // Fields half an hour off are walked only so far, and the walker goes in at the far end, not seen to vanish in the open.
  const far = 2 * WALKER_WORDS;
  assert.equal(f[far + 8], Math.floor(FOLK_WAY_MOST_M / ROUTE_STEP_M) * ROUTE_STEP_M); assert.equal(words[far + 11] & 4, 0);
  // An errand to the market ends in the open.
  assert.equal(words[3 * WALKER_WORDS + 11], 1 | 4);
  // One of the port's own walkers, now someone: their way as it was, their sex and look their own.
  const own = 4 * WALKER_WORDS;
  assert.equal(words[own], 0); assert.equal(words[own + 1], 5); assert.equal(f[own + 3], Math.fround(1.3));
  assert.equal(words[own + 11], 8 | 1); assert.equal(words[own + 10], Math.floor(folkRoll(71, 8) * 0xffff));
  assert.deepEqual(streets.souls[4], { ...others[0], goal: 'about', there: 'about the waterside', via: '', home: null, to: null, planned: false });

  // Laid the same again from the same plan: who stands where does not shift when a plan is asked for anew.
  const again = boardFolkStreets({ plan: plan(people, others), origin: { x: 1000, z: 2000 }, heightAt, base });
  assert.deepEqual([...new Uint32Array(again.walkers.buffer)], [...words]);
  assert.deepEqual([...again.samples], [...streets.samples]);

  // A way taken in the last plan too is not asked of the ground again; a way that has changed is, and whoever is
  // gone from the plan is forgotten.
  let asked = 0;
  const counted = (x, z) => { asked++; return heightAt(x, z); }, kept = new Map();
  const first = boardFolkStreets({ plan: plan(people, others), origin: { x: 1000, z: 2000 }, heightAt: counted, base, kept });
  assert.deepEqual([...first.samples], [...streets.samples]); assert.ok(asked > 1200, `${asked} points of ground`);
  assert.deepEqual([...kept.keys()], [11, 12, 13, 14, 15]);
  asked = 0;
  const moved = people.slice(0, 4).map((one) => one.id === 11 ? { ...one, route: [0, 0, 60, 0, 60, 45] } : one);
  const second = boardFolkStreets({ plan: plan(moved, others), origin: { x: 1000, z: 2000 }, heightAt: counted, base, kept });
  assert.equal(asked, Math.floor(105 / ROUTE_STEP_M) + 1, 'only the way that changed');
  assert.equal(second.people, 4); assert.deepEqual([...kept.keys()], [11, 12, 13, 14]);
  assert.equal(second.walkers[8], 84 * ROUTE_STEP_M);

  // And they walk: as the GPU walks them, by the clock, out along the way and home again.
  const seen = { out: 0, back: 0, in: 0 };
  for (let clock = 0; clock < 1500; clock += 7) {
    const stride = townWalkerStride(streets, 0, clock, 1);
    if (!stride) { seen.in++; continue; }
    seen[stride.back ? 'back' : 'out']++;
    assert.ok(stride.position.x >= 999 && stride.position.x <= 1061 && stride.position.z >= 1999 && stride.position.z <= 2041, `on the way at ${clock}s`);
    assert.ok(Math.abs(stride.position.y - heightAt(stride.position.x, stride.position.z)) < 0.05, 'and on the ground');
  }
  assert.ok(seen.out > 3 && seen.back > 3 && seen.in > 20, JSON.stringify(seen));

  // With no streets of the port's own, the plan's people are all there are.
  const bare = boardFolkStreets({ plan: plan(people.slice(0, 1), others), origin: { x: 0, z: 0 }, heightAt });
  assert.equal(bare.people, 1); assert.equal(new Uint32Array(bare.walkers.buffer)[0], 0);
  assert.deepEqual(bare.folk, { day: 12, date: 'Spring 13, AD 1550', sunday: false, planned: 1, own: 0, cut: 0 });
});

test('a way the model laid through one of the port\'s own buildings is walked only in the open', () => {
  // A hall across the first street, forty to fifty-six metres along it, and a pier, which is walked on.
  const port = { instances: [
    { prefabId: 'great_hall', x: 1048, z: 2000, width: 16, length: 30, yaw: 0 },
    { prefabId: 'timber_mole_pier', x: 1010, z: 2000, y: 0, height: 2, width: 8, length: 40, yaw: 0 },
  ] };
  const blocked = townSolids(port);
  assert.equal(blocked(1048, 2000), true); assert.equal(blocked(1048, 2014), true); assert.equal(blocked(1048, 2017), false);
  assert.equal(blocked(1039, 2000), false, 'clear of its wall'); assert.equal(blocked(1010, 2000), false, 'a pier is no wall');
  assert.equal(blocked(3000, 3000), false);
  // Turned a quarter, its long side lies along the street.
  const turned = townSolids({ instances: [{ ...port.instances[0], yaw: Math.PI / 2 }] });
  assert.equal(turned(1062, 2000), true); assert.equal(turned(1048, 2014), false);

  const heightAt = () => 2, origin = { x: 1000, z: 2000 };
  const walk = (route, more = {}) => boardFolkStreets({ plan: plan([person(21, { route, ...more })]), origin, heightAt, blocked });
  // Door to hall: thirty-nine metres in the open, then in at its wall. They do not stand about in the open there.
  const near = walk([0, 0, 80, 0], { open: true });
  assert.equal(near.folk.cut, 1); assert.equal(near.people, 1);
  const count = new Uint32Array(near.walkers.buffer)[1], last = near.samples[(count - 1) * 4];
  assert.ok(last < 1039.3 && last > 1037.9, `the walk ends at ${last}`); assert.equal(near.samples[0], 1000);
  assert.equal(near.walkers[8], (count - 1) * ROUTE_STEP_M); assert.equal(new Uint32Array(near.walkers.buffer)[11] & 4, 0);
  for (let k = 0; k < count; k++) assert.equal(blocked(near.samples[k * 4], near.samples[k * 4 + 2]), false);
  // A long way beyond it: the far side is the longer walk, so they come out of the hall and go on.
  const far = walk([0, 0, 300, 0], { open: true }), farWords = new Uint32Array(far.walkers.buffer);
  assert.ok(far.samples[0] > 1056.7 && far.samples[0] < 1058.1, `the walk begins at ${far.samples[0]}`);
  assert.equal(far.samples[(farWords[1] - 1) * 4], 1300); assert.equal(farWords[11] & 4, 4, 'and it reaches the open work');
  // A child whose door is behind the hall is not left standing at its wall.
  const child = walk([0, 0, 300, 0], { goal: 'play', age: 8 });
  assert.equal(new Uint32Array(child.walkers.buffer)[11] & 6, 4);
  // A way wholly within it is not walked at all, and is counted.
  const within = walk([42, 0, 54, 0]);
  assert.equal(within.people, 0); assert.equal(within.folk.cut, 1);
  // With nothing in the way nothing is cut.
  assert.equal(walk([0, 30, 100, 30]).folk.cut, 0);
});

test('what someone is about is told from where their walker is on its way', () => {
  const brewer = { planned: true, goal: 'work', there: 'brewing', via: 'Market street' }, walking = { stopped: false, walked: 40, back: false };
  assert.equal(folkDoing(brewer, walking, 100), 'walking to work by the market street');
  assert.equal(folkDoing({ ...brewer, via: 'the Roman street' }, walking, 100), 'walking to work by the roman street');
  assert.equal(folkDoing({ ...brewer, via: '' }, { ...walking, back: true }, 100), 'walking home');
  assert.equal(folkDoing(brewer, { stopped: true, walked: 100, back: false }, 100), 'brewing');
  assert.equal(folkDoing(brewer, { stopped: true, walked: 40, back: false }, 100), 'walking to work by the market street', 'a word with a neighbour on the way');
  assert.equal(folkDoing(brewer, null, 100), 'indoors');
  assert.equal(folkDoing({ ...brewer, goal: 'church', there: 'at mass' }, walking, 100), 'walking to mass by the market street');
  assert.equal(folkDoing({ ...brewer, goal: 'errand', there: 'at the baker', via: '' }, walking, 100), 'out on an errand');
  assert.equal(folkDoing({ planned: true, goal: 'play', there: 'at play', via: '' }, walking, 30), 'at play');
  assert.equal(folkDoing({ planned: true, goal: 'play', there: 'at play', via: '' }, null, 30), 'at home');
  assert.equal(folkDoing({ planned: false, there: 'about the waterside' }, walking, 30), 'about the waterside');
});

// Two cards as Castle and Commons' model writes them (Lisbon, founded 1550).
const MERCHANT = `Vela Rubio — 33, husband · merchant · Lisboa
← Lisboa
Home La Balanza de Oro in the market quarter
Wife María Guantero
Children Marina Rubio , Godo Rubio
Credit and coin
Household worth 16 crowns
Living merchant : about 10 crowns a year here
Personal status Free
Family Rubio — named for how a founder looked or carried himself, first in Lisboa
Family tree
Household goods in Lisboa
Good | Held | For sale | Beasts | Reserve target
None recorded.
Household property and holdings
Place | Property | Right
None recorded.
Household members
Person | Age | Place
Vela Rubio | 33 | Lisboa
María Guantero | 32 | Lisboa
Learning and skills
Skill | Ability
letters | skilled · 61.5%
reckoning | master · 81.94%
scripture | untaught · 16.06%
arms | some · 30.88%
Nature warm, plain, fair-haired
Learning skilled letters, master reckoning, some arms
Life
Born Summer 24, AD 1516
Married María Guantero, Spring 3, AD 1540`;
const GIRL = `Marina Moreno — 11, girl · Lisboa
← Lisboa
Home Tienda García in the market quarter
Mother Ermesenda Bosque
Father Antolín Moreno
Credit and coin
Household of Antolín Moreno ; worth 29 crowns
Living glover : about 9 crowns a year here
Personal status Free
Family Moreno — named for how a founder looked or carried himself, first in Lisboa
Family tree
Household members
Person | Age | Place
Antolín Moreno | 31 | Lisboa
Ermesenda Bosque | 29 | Lisboa
Godo Moreno | 4 | Lisboa
Marina Moreno | 11 | Lisboa
Learning and skills
Skill | Ability
craft | some · 39.41%
Nature cold, dark-haired
Learning some craft
Life
Born Winter 61, AD 1538`;

test('the model\'s card of a person is read as it is written', () => {
  const card = folkCardFacts(MERCHANT);
  assert.equal(card.title, 'Vela Rubio — 33, husband · merchant · Lisboa');
  assert.deepEqual(card.facts, {
    Home: 'La Balanza de Oro in the market quarter', Wife: 'María Guantero', Children: 'Marina Rubio, Godo Rubio', 'Household worth': '16 crowns',
    Living: 'merchant: about 10 crowns a year here', 'Personal status': 'Free', Family: 'Rubio — named for how a founder looked or carried himself, first in Lisboa',
  });
  assert.deepEqual(card.notes, []);
  assert.deepEqual(card.household, [{ name: 'Vela Rubio', age: 33, place: 'Lisboa' }, { name: 'María Guantero', age: 32, place: 'Lisboa' }]);
  assert.deepEqual(card.skills, [{ skill: 'letters', ability: 'skilled' }, { skill: 'reckoning', ability: 'master' }, { skill: 'scripture', ability: 'untaught' }, { skill: 'arms', ability: 'some' }]);
  assert.equal(card.nature, 'warm, plain, fair-haired'); assert.equal(card.learning, 'skilled letters, master reckoning, some arms');
  assert.deepEqual(card.life, ['Born Summer 24, AD 1516', 'Married María Guantero, Spring 3, AD 1540']);

  const girl = folkCardFacts(GIRL);
  assert.equal(girl.facts['Household of'], 'Antolín Moreno; worth 29 crowns'); assert.equal(girl.facts.Mother, 'Ermesenda Bosque');
  assert.equal(girl.household.length, 4); assert.deepEqual(girl.life, ['Born Winter 61, AD 1538']);
  // Nothing, or a card of some other kind, is no one's facts and no error.
  assert.deepEqual(folkCardFacts(''), { title: '', facts: {}, notes: [], household: [], skills: [], nature: '', learning: '', life: [] });
  assert.deepEqual(folkCardFacts(undefined).facts, {});

  assert.deepEqual(folkSoulOfTitle(17501, card.title), { id: 17501, name: 'Vela Rubio', age: 33, role: 'merchant', planned: false, there: '' });
  assert.deepEqual(folkSoulOfTitle(837, girl.title), { id: 837, name: 'Marina Moreno', age: 11, role: null, planned: false, there: '' });
});

test('asked, they say who they are from the model\'s record of them and nothing else', () => {
  const merchant = { id: 17501, name: 'Vela Rubio', age: 33.7, role: 'merchant' };
  assert.equal(folkSpeech(merchant, folkCardFacts(MERCHANT), 'walking to work by the market street'),
    'Vela Rubio, merchant. Born in the summer of 1516. I live at La Balanza de Oro, in the market quarter. My wife is María Guantero, and we have Marina and Godo. '
    + 'The work brings some 10 crowns in a year. I can read and write. Just now I am walking to work by the market street.');
  assert.equal(folkSpeech({ id: 837, name: 'Marina Moreno', age: 11.1, role: null }, folkCardFacts(GIRL), 'at mass'),
    'I\'m Marina. I am 11. We live at Tienda García, in the market quarter. With my father Antolín and my mother Ermesenda. You find me at mass.');
  // Grown, and still under a father's roof; unfree; poor; a widow.
  const son = folkCardFacts(GIRL.replace('11, girl', '19, son').replace('about 9 crowns', 'about 4 crowns').replace('Personal status Free', 'Personal status Bound to the land'));
  assert.equal(folkSpeech({ id: 837, name: 'Godo Moreno', age: 19, role: 'glover' }, son, 'indoors'),
    'Godo Moreno, glover. Born in the winter of 1538. I live at Tienda García, in the market quarter. I keep under my father\'s roof. It is a thin living: 4 crowns in a year. I am bound to the land.');
  const widow = folkCardFacts('Sibila Cervecero — 61, widow · brewer · Lisboa\nHome Mesón de la Luna de Bronce in the market quarter\nWidow of Juan Cervecero\nChildren Ana Cervecero\nFamily tree');
  assert.equal(folkSpeech({ id: 9, name: 'Vicente Viejo', age: 32, role: 'chandler' }, folkCardFacts('Vicente Viejo — 32, husband · chandler · Lisboa\nHome hovel-built house in the residential quarter\nFamily tree')),
    'Vicente Viejo, chandler. I live in a hovel-built house in the residential quarter.');
  assert.equal(folkSpeech({ id: 262, name: 'Sibila Cervecero', age: 61, role: 'brewer' }, widow),
    'Sibila Cervecero, brewer. I live at Mesón de la Luna de Bronce, in the market quarter. I am the widow of Juan Cervecero. I have Ana.');
  // With no card at all they still give their name.
  assert.equal(folkSpeech({ id: 1, name: 'Ana Barqueiro', age: 40, role: null }, null, 'about the waterside'), 'Ana Barqueiro. You find me about the waterside.');
});

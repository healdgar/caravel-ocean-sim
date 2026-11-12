// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The game's side of the storyteller: where a pairing code leads, who of a port might sign on as mate, what is told
// of someone to whoever plays them, the door itself over a socket that is the test's own, and the mate's figure
// walking a step behind the captain ashore.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { storytellerAddress, mateShortlist, storytellerScene, createStoryteller, MATE_CALLINGS, STORYTELLER_PORT } from '../js/storyteller.js';
import { createMateFigure, stepMateFigure, mateDoing, MATE_SETS_OFF_M, MATE_STOPS_M, MATE_RUN_MS } from '../js/first-mate.js';

test('a pairing code leads to this machine and nowhere else', () => {
  assert.equal(storytellerAddress('abcde3'), `ws://127.0.0.1:${STORYTELLER_PORT + 3}/?code=ABCDE3`);
  assert.equal(storytellerAddress('  QWERT0 '), `ws://127.0.0.1:${STORYTELLER_PORT}/?code=QWERT0`);
  for (const no of ['', null, 'ABCDE', 'ABCD12', 'ABCDEF', 'ABCDE0&x=1', 'evil.example/ABCDE0', 'ABCDE0@evil.example', 'ÀBCDE0']) assert.equal(storytellerAddress(no), null, String(no));
});

test('a mate is shortlisted from the port\'s grown people: the sea\'s callings first, no post-holder, the same every time', () => {
  const souls = [];
  for (let i = 0; i < 400; i++) souls.push({ id: 1000 + i, name: 'N' + i, sex: i % 2 ? 'm' : 'f', age: 6 + (i * 7) % 70, role: ['farmer', 'boatman', 'fisher', 'weaver', null, 'carpenter', 'priest', 'roper'][i % 8] });
  const away = new Set(souls.filter((soul) => soul.role === 'boatman').slice(0, 20).map((soul) => soul.id));
  const list = mateShortlist(souls, { n: 6, away });
  assert.equal(list.length, 6);
  for (const one of list) { assert.ok(one.age >= 18 && one.age <= 46, `${one.age}`); assert.ok(!away.has(one.id)); }
  assert.deepEqual(list.map((one) => one.role), ['boatman', 'boatman', 'fisher', 'fisher', 'roper', 'roper']);
  assert.deepEqual(mateShortlist([...souls].reverse(), { n: 6, away }).map((one) => one.id), list.map((one) => one.id), 'whatever order they come in');
  // Where no one follows the sea, the land's people of the right age stand; children and the old never.
  const land = mateShortlist([{ id: 1, age: 12, role: 'boatman' }, { id: 2, age: 70, role: 'fisher' }, { id: 3, age: 30, role: 'farmer' }, { id: 4, age: 29, role: null }, null], {});
  assert.deepEqual(land.map((one) => one.id), [3, 4]);
  assert.ok(MATE_CALLINGS.includes('boatman'));
  assert.deepEqual(mateShortlist(null), []);
});

// A person's card as the model writes it: a line to a fact, the key and its value with no colon between.
const CARD = ['Millán Bueno — 41, husband · boatman · Lisboa', '← Lisboa', 'Home Casa de la Barca in the strand quarter', 'Wife Elvira Bueno', 'Household of Millán Bueno ; worth 12 crowns', 'Personal status Free', 'Family tree', 'Household members', 'Person | Age | Place',
  'Millán Bueno | 41 | Lisboa', 'Elvira Bueno | 38 | Lisboa', 'Learning and skills', 'Skill | Ability', 'craft | skilled · 71%', 'Nature steady, proud', 'Learning skilled craft', 'Life', 'Born Summer 3, AD 1508'].join('\n');
test('what is told of someone is the game\'s card of them, where they are and the day: nothing else', () => {
  const scene = storytellerScene({ soul: { id: 4821, name: 'Millán Bueno', age: 41.6, sex: 'm', role: 'boatman' }, answer: { card: CARD, links: [] }, doing: 'mending a net', place: { name: 'Lisboa', kind: 'port' },
    status: { date: 'Spring 2, AD 1550', day: 201455, year: 1550, weather: 'clear', treasury: 2200 }, news: Array.from({ length: 14 }, (_, i) => ({ date: 'd' + i, text: 't' + i, cat: 'town' })) });
  assert.deepEqual(scene.person, { id: 4821, name: 'Millán Bueno', age: 41.6, sex: 'm', role: 'boatman' });
  assert.equal(scene.doing, 'mending a net'); assert.equal(scene.date.text, 'Spring 2, AD 1550'); assert.equal(scene.weather, 'clear');
  assert.equal(scene.news.length, 10); assert.deepEqual(scene.news.at(-1), { date: 'd13', text: 't13' });
  assert.deepEqual(Object.keys(scene).sort(), ['card', 'date', 'doing', 'harbour', 'news', 'person', 'place', 'weather']);
  assert.deepEqual(scene.card.facts, { Home: 'Casa de la Barca in the strand quarter', Wife: 'Elvira Bueno', 'Household of': 'Millán Bueno; worth 12 crowns', 'Personal status': 'Free' });
  assert.deepEqual(scene.card.household, [{ name: 'Millán Bueno', age: 41, place: 'Lisboa' }, { name: 'Elvira Bueno', age: 38, place: 'Lisboa' }]);
  assert.equal(scene.card.nature, 'steady, proud'); assert.deepEqual(scene.card.life, ['Born Summer 3, AD 1508']);
  assert.ok(!JSON.stringify(scene).includes('2200'), 'the crown\'s purse is not a boatman\'s to know');
  // Someone the card names but the streets do not show still has a name.
  assert.equal(storytellerScene({ soul: { id: 7 }, answer: { card: CARD } }).person.name, 'Millán Bueno');
});

// A socket that is the test's: what the door sends is kept, and the test speaks as the storyteller.
function fakeSocket() {
  const made = [];
  class Socket {
    constructor(address) { this.address = address; this.sent = []; this.on = {}; made.push(this); }
    addEventListener(kind, handler) { (this.on[kind] ??= []).push(handler); }
    send(text) { this.sent.push(JSON.parse(text)); }
    close() { this.closed = true; }
    fire(kind, event = {}) { for (const handler of this.on[kind] ?? []) handler(event); }
  }
  return { Socket, made };
}
const storageOf = () => { const kept = new Map(); return { getItem: (key) => kept.get(key) ?? null, setItem: (key, value) => kept.set(key, String(value)), removeItem: (key) => kept.delete(key), kept }; };
const settle = () => new Promise((resolve) => setTimeout(resolve, 5));

test('the door answers what the storyteller asks from the game, tells it what the player does, and opens to no wrong code', async () => {
  const { Socket, made } = fakeSocket(), storage = storageOf(), states = [];
  let mate = null;
  const game = {
    situation: () => ({ where: { name: 'Lisboa' }, mate }), world: (path) => ({ path }), find: (name, n) => [{ name, n }], inspect: (code, name) => ({ code, name }), chronicle: (args) => args, panel: (args) => args,
    nearby: () => ({ inSight: [] }), person: async (id) => { if (id === 9) throw new Error('The game knows no one of that number'); return { person: { id } }; },
    mateCandidates: (n) => [{ id: 4821, n }], mateChoose: (id) => { mate = { id, name: 'Millán Bueno' }; return { person: mate }; }, nameOf: async (person) => (person == null ? mate?.name ?? 'The mate' : 'Inés Roldán'), mate: () => mate,
  };
  const door = createStoryteller({ game, documentRef: null, Socket, storage, onState: (state) => states.push(state) });
  assert.equal(door.state, 'apart'); assert.equal(door.tell({ kind: 'ashore' }), false, 'no one is told while apart');
  assert.equal(door.pair('nonsense'), false); assert.equal(made.length, 0);
  assert.equal(door.pair('abcde2'), true);
  const socket = made[0]; assert.equal(socket.address, `ws://127.0.0.1:${STORYTELLER_PORT + 2}/?code=ABCDE2`); assert.equal(door.state, 'joining');
  socket.fire('open'); assert.equal(door.state, 'paired'); assert.equal(storage.kept.get('waterworld.storyteller.code'), 'ABCDE2');
  assert.deepEqual(socket.sent, [{ event: { kind: 'joined' } }]);

  const ask = async (id, op, args) => { socket.fire('message', { data: JSON.stringify({ id, op, args }) }); await settle(); return socket.sent.find((one) => one.id === id); };
  assert.deepEqual(await ask(1, 'situation'), { id: 1, result: { where: { name: 'Lisboa' }, mate: null } });
  assert.deepEqual(await ask(2, 'world', { path: 'settlement:Lisboa' }), { id: 2, result: { path: 'settlement:Lisboa' } });
  assert.deepEqual(await ask(3, 'person', { id: '4821' }), { id: 3, result: { person: { id: 4821 } } });
  assert.deepEqual(await ask(4, 'person', { id: 9 }), { id: 4, error: 'The game knows no one of that number' });
  assert.match((await ask(5, 'constructor')).error, /does not know how to "constructor"/);
  assert.match((await ask(6, 'eval', { text: 'x' })).error, /does not know how/);
  assert.deepEqual(await ask(7, 'mateChoose', { id: 4821 }), { id: 7, result: { person: { id: 4821, name: 'Millán Bueno' } } });
  // What the storyteller says is kept as lines, by whom; an empty line is refused.
  assert.deepEqual(await ask(8, 'say', { text: 'Wind is backing, captain.' }), { id: 8, result: { shown: true } });
  assert.deepEqual(await ask(9, 'say', { person: 77, text: 'Fresh sardines!' }), { id: 9, result: { shown: true } });
  assert.deepEqual(await ask(10, 'narrate', { text: 'Gulls wheel over the quay.' }), { id: 10, result: { shown: true } });
  assert.match((await ask(11, 'say', { text: '   ' })).error, /Nothing to say/);
  assert.deepEqual(door.lines.map((line) => [line.kind, line.who, line.person, line.text]), [['say', 'Millán Bueno', 4821, 'Wind is backing, captain.'], ['say', 'Inés Roldán', 77, 'Fresh sardines!'], ['narrate', '', null, 'Gulls wheel over the quay.']]);
  socket.fire('message', { data: 'not json' }); socket.fire('message', { data: '{"no":"op"}' });

  // The player speaks: to the mate when no one is named, to a person otherwise; and it is told what they do.
  socket.sent.length = 0;
  assert.equal(door.speak(null, '  What do they say of the Queen?  '), true);
  assert.equal(door.speak({ id: 77, name: 'Inés Roldán' }, 'How much for the basket?'), true);
  assert.equal(door.speak(null, '   '), false);
  assert.equal(door.speak(null, 'x'.repeat(900)), true);
  assert.equal(door.tell({ kind: 'ashore', place: 'Lisboa' }), true);
  assert.deepEqual(socket.sent.slice(0, 2), [{ event: { kind: 'spoke', to: 'mate', person: 4821, name: 'Millán Bueno', text: 'What do they say of the Queen?' } }, { event: { kind: 'spoke', to: 'person', person: 77, name: 'Inés Roldán', text: 'How much for the basket?' } }]);
  assert.equal(socket.sent[2].event.text.length, 600); assert.deepEqual(socket.sent[3], { event: { kind: 'ashore', place: 'Lisboa' } });

  // A wrong code is forgotten and not tried again; too many are said to be so.
  socket.fire('close', { code: 4003 });
  assert.equal(door.state, 'apart'); assert.match(door.said, /not the storyteller's code/); assert.equal(storage.kept.has('waterworld.storyteller.code'), false); assert.equal(made.length, 1);
  door.pair('ABCDE2'); made[1].fire('close', { code: 4008 }); assert.match(door.said, /Too many wrong codes/); assert.equal(made.length, 2);
  // One that never answered is not looked for again; a kept code is tried after a reload.
  door.pair('ABCDE2'); made[2].fire('close', { code: 1006 }); assert.match(door.said, /No storyteller answered/); assert.equal(made.length, 3);
  storage.setItem('waterworld.storyteller.code', 'ZZZZZ9'); assert.equal(door.resume(), true); assert.equal(made[3].address, `ws://127.0.0.1:${STORYTELLER_PORT + 9}/?code=ZZZZZ9`);
  door.close(); assert.equal(door.state, 'apart'); assert.equal(made[3].closed, true);
  assert.ok(states.includes('paired') && states.at(-1) === 'apart');
});

test('with no storyteller by, the mate answers the captain\'s questions from the game; one that is by hears what was said', async () => {
  const { Socket, made } = fakeSocket(), storage = storageOf();
  let mate = null, port = true;
  const asked = [];
  const counsel = {
    who: () => ({ name: mate?.name ?? 'Tomás' }),
    topics: () => (port ? [{ id: 'port', label: 'What is this place?' }, { id: 'sign', label: 'Who here would sign on as mate?' }] : [{ id: 'where', label: 'Where are we?' }]),
    answer: async (id) => {
      asked.push(id);
      if (id === 'sign') return { text: 'These would come: Juana Cubero, 40, cooper.', topics: [{ id: 'take:2580', label: 'Sign Juana on' }, { id: 'back', label: 'Not now' }] };
      if (id === 'take:2580') { mate = { id: 2580, name: 'Juana Cubero' }; return { text: 'Aye, captain.' }; }
      if (id === 'fails') throw new Error('the model is asleep');
      if (id === 'empty') return { text: '   ' };
      return { text: id === 'port' ? 'Lisboa, captain.' : 'In 36° N.' };
    },
  };
  const door = createStoryteller({ game: { mate: () => mate, nameOf: async () => mate?.name ?? 'The mate' }, counsel, documentRef: null, Socket, storage });
  // Apart from any storyteller: the questions of the moment, an answer, and what was asked and said kept as lines.
  assert.equal(door.state, 'apart'); assert.deepEqual(door.topics.map((topic) => topic.id), ['port', 'sign']);
  assert.equal(await door.ask(door.topics[0]), true);
  assert.deepEqual(door.lines.map((line) => [line.kind, line.who, line.text]), [['mine', 'You', 'What is this place?'], ['say', 'Tomás', 'Lisboa, captain.']]);
  assert.equal(made.length, 0, 'no socket is opened to answer');
  // An answer may lead on: its own questions stand until one is taken or put by.
  await door.ask(door.topics[1]);
  assert.deepEqual(door.topics, [{ id: 'take:2580', label: 'Sign Juana on' }, { id: 'back', label: 'Not now' }]);
  await door.ask(door.topics[1]); assert.deepEqual(door.topics.map((topic) => topic.id), ['port', 'sign'], 'put by');
  assert.deepEqual(asked, ['port', 'sign'], 'putting by asks nothing of the game');
  await door.ask(door.topics[1]); await door.ask(door.topics[0]);
  assert.deepEqual(door.lines.slice(-2).map((line) => [line.kind, line.who, line.person, line.text]), [['mine', 'You', null, 'Sign Juana on'], ['say', 'Juana Cubero', 2580, 'Aye, captain.']], 'the one signed on answers under their own name');
  assert.deepEqual(door.topics.map((topic) => topic.id), ['port', 'sign']);
  // The questions follow the moment; a question that cannot be answered is said to be so, and nothing breaks.
  port = false; assert.deepEqual(door.topics, [{ id: 'where', label: 'Where are we?' }]);
  await door.ask({ id: 'fails', label: 'Why?' }); assert.equal(door.lines.at(-1).text, 'I cannot say, captain.');
  await door.ask({ id: 'empty', label: 'And?' }); assert.equal(door.lines.at(-1).text, 'I cannot say, captain.');
  assert.equal(await door.ask(null), false);
  // A storyteller who is by is told what was asked and what the mate said, to keep to it.
  door.pair('ABCDE1'); made[0].fire('open'); made[0].sent.length = 0;
  await door.ask(door.topics[0]);
  assert.deepEqual(made[0].sent, [{ event: { kind: 'counsel', topic: 'where', asked: 'Where are we?', answer: 'In 36° N.' } }]);
  // With no counsel given there are no questions, and asking does nothing.
  const bare = createStoryteller({ game: { mate: () => null }, documentRef: null, Socket, storage: storageOf() });
  assert.deepEqual(bare.topics, []); assert.equal(await bare.ask({ id: 'port', label: 'x' }), false); assert.equal(bare.lines.length, 0);
});

test('ashore the mate walks a step behind the captain, runs to catch up, goes round what is shut, and is put away aboard', () => {
  const mate = createMateFigure({ id: 4821, name: 'Elvira Bueno', sex: 'f', age: 38, role: 'fisher' });
  const s = mate.figure;
  assert.equal(s.name, 'Elvira Bueno'); assert.equal(s.sex, 'female'); assert.equal(s.soul.id, 4821); assert.equal(s.visible, false);
  assert.equal(mate.garrison.soldiers.length, 1); assert.equal(mate.port.garrison, mate.garrison);
  const ground = (x, z) => 3 + x * 0.01, open = () => true;
  const captain = { x: 5000, z: -7000, yaw: 0 };
  // First step ashore: placed beside the captain (behind them: the captain looks along -z), the garrison brought to them.
  assert.equal(stepMateFigure(mate, 1 / 60, { ashore: true, captain, ground, open }), true);
  assert.equal(s.visible, true); assert.deepEqual(mate.garrison.origin, [5000, 0, -7000]);
  assert.ok(Math.abs(Math.hypot(s.x - captain.x, s.z - captain.z) - MATE_STOPS_M) < 1e-6); assert.ok(s.z > captain.z, 'behind');
  assert.ok(Math.abs(s.position[1] - (ground(s.x, s.z) + 0.028)) < 1e-6);
  assert.equal(mateDoing(mate), 'with the captain, as first mate');
  // Standing near, they do not shuffle: the captain may turn and step a little and the mate stays put.
  const stood = [s.x, s.z];
  for (let i = 0; i < 120; i++) stepMateFigure(mate, 1 / 60, { ashore: true, captain: { ...captain, x: captain.x + 0.6 }, ground, open });
  assert.deepEqual([s.x, s.z], stood); assert.ok(s.walk < 0.01);
  // The captain walks off 30 m: the mate sets off, runs, and comes to rest a step and a half away, facing them.
  captain.x += 30;
  let fastest = 0, moved = false;
  for (let i = 0; i < 60 * 12; i++) { const was = [s.x, s.z]; moved = stepMateFigure(mate, 1 / 60, { ashore: true, captain, ground, open }) || moved; fastest = Math.max(fastest, Math.hypot(s.x - was[0], s.z - was[1]) * 60); if (i === 30) assert.equal(mateDoing(mate), 'following the captain'); }
  const away = Math.hypot(s.x - captain.x, s.z - captain.z);
  assert.ok(away <= MATE_SETS_OFF_M && away >= MATE_STOPS_M * 0.85, `${away} m off`); assert.ok(fastest > 3 && fastest <= MATE_RUN_MS + 1e-6, `${fastest} m/s`);
  assert.equal(moved, false, 'a walk within the town moves no origin');
  assert.ok(Math.abs(Math.atan2(Math.sin(s.yaw - Math.PI / 2), Math.cos(s.yaw - Math.PI / 2))) < 0.2, 'faces the captain, who is to the east');
  assert.ok(Math.abs(s.transform[12] - (s.x - mate.garrison.origin[0])) < 1e-4 && Math.abs(s.transform[14] - (s.z - mate.garrison.origin[2])) < 1e-4, 'drawn about the garrison\'s origin');
  // A wall straight ahead: they slide along it and are never inside it.
  captain.x += 12;
  const wall = (x, z) => !(x > captain.x - 8 && x < captain.x - 7 && Math.abs(z - captain.z) < 0.4);
  for (let i = 0; i < 60 * 8; i++) { stepMateFigure(mate, 1 / 60, { ashore: true, captain, ground, open: wall }); assert.ok(wall(s.x, s.z)); }
  assert.ok(Math.hypot(s.x - captain.x, s.z - captain.z) <= MATE_SETS_OFF_M + 1e-6, 'and still they come up with the captain (found beside them if nothing else serves)');
  // Carried far off (a boat, another quay): found beside the captain, and the garrison's origin follows.
  captain.x += 900;
  assert.equal(stepMateFigure(mate, 1 / 60, { ashore: true, captain, ground, open }), true);
  assert.ok(Math.hypot(s.x - captain.x, s.z - captain.z) <= MATE_STOPS_M + 1e-6);
  // Back aboard: put away, and stood afresh at the next landing.
  assert.equal(stepMateFigure(mate, 1 / 60, { ashore: false, captain: null, ground, open }), false); assert.equal(s.visible, false);
  assert.equal(stepMateFigure(mate, 1 / 60, { ashore: true, captain: { x: 10, z: 10, yaw: 1 }, ground, open }), true); assert.equal(s.visible, true);
  // Nowhere open about the captain (a skiff's thwart): they stand where the captain does rather than nowhere.
  const pent = createMateFigure({ id: 2, name: 'Rui', sex: 'm', age: 30 });
  stepMateFigure(pent, 1 / 60, { ashore: true, captain: { x: 1, z: 2, yaw: 0 }, ground, open: () => false });
  assert.deepEqual([pent.figure.x, pent.figure.z], [1, 2]); assert.equal(pent.figure.sex, 'male');
  for (const value of s.transform) assert.ok(Number.isFinite(value));
});

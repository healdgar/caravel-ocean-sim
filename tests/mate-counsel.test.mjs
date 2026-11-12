// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The first mate's own counsel, with no storyteller by: which questions fit the moment, and what the mate answers
// to each from what the game and the country's model hold. Every word of an answer is read from what it is given.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mateTopics, mateCounsel, mateCandidateLine, mateCandidateAccount, mateAbout, counselSouls, counselPointOfSail } from '../js/mate-counsel.js';
import { folkCardFacts } from '../js/folk-card.js';

// A person's card as the model writes it: a line to a fact, the key and its value with no colon between.
const CARD = ['Juana Cubero — 40, wife · cooper · Lisboa', '← Lisboa', 'Home Tienda de la Llave de Bronce in the market quarter', 'Husband Vela Cerro', 'Children Rui Cerro, Ana Cerro', 'Credit and coin', 'Household of Vela Cerro ; worth 29 crowns',
  'Living cooper : about 591 crowns a year here', 'Personal status Free', 'Family Cubero — named for a founder\'s trade, first in Lisboa', 'Family tree', 'Household members', 'Person | Age | Place', 'Vela Cerro | 44 | Lisboa', 'Juana Cubero | 40 | Lisboa',
  'Learning and skills', 'Skill | Ability', 'letters | untaught · 7%', 'craft | skilled · 75.56%', 'Nature tall, bold, idle, fair-haired', 'Learning skilled craft', 'Life', 'Born Summer 27, AD 1509', 'Spring 1, AD 1550: Went to sea from Lisboa as a ship\'s mate'].join('\n');
const juana = { id: 2580, name: 'Juana Cubero', model: true, sex: 'f', age: 40, role: 'cooper', port: 'Lisboa', about: mateAbout(folkCardFacts(CARD)) };
const tomas = { name: 'Tomás', model: false };
// The model's own record of the port, as its advisor gives it.
const TOWN = { name: 'Lisboa', code: 's0', kind: 'capital', role: 'seat', tongue: 'Castilian', lord: 'House de Lisboa', people: 19448, prosperity: 50, unrest: 8, hunger: 0, plague: false, besieged: false, walls: 'stone', garrison: 778,
  trades: { weaver: 918, merchant: 1353, fisher: 400, cooper: 120 } };
const realm = { name: 'Castilla', monarch: 'King Fernando', places: 41, people: 61234, legitimacy: 72, war: null, feuds: [], plague: false, priceLevel: 1.02 };
const ship = { windFrom: 315, windWords: 'a fresh breeze', headingDeg: 225, compassCourse: 230, knots: 6.4, foodDays: 41.7, waterDays: 8.2, hands: 38 };
const captain = { coin: 1240, currency: 'reales', cargo: [{ good: 'salt', name: 'Salt', units: 12 }, { good: 'wine', name: 'Wine', units: 3.5 }, { good: 'iron', units: 0 }] };
const atSea = { where: { kind: 'sea', ashore: false, lat: 36.2, lon: -11.4 }, realm: null, ship, captain, voyage: { from: 'Lisboa', to: 'Funchal', daysOut: 3.4, leagues: 87, log: ['Sighted a sail to leeward'], toGo: { leagues: 112.6, bearing: 221 } } };
const inPort = { where: { kind: 'port', ashore: true, living: true, name: 'Lisboa' }, realm, ship: { ...ship, knots: 0 }, captain, voyage: { from: 'Lisboa', to: null, daysOut: 0, leagues: 0, log: [] } };
const ines = { id: 77, name: 'Inés Roldán', age: 31, sex: 'f', role: 'fisher', doing: 'mending a net' };
const near = { place: 'Lisboa', inSight: [ines], atPosts: [{ id: 90, name: 'Gil Peón', age: 26, sex: 'm', role: null, doing: 'keeping watch' }], lastAskedAfter: null };
const news = [{ date: 'Spring 1', text: 'Wheat is dear at Lisboa', cat: 'trade' }, { date: 'Spring 2', text: 'The Queen has borne a son.', cat: 'court' }, { date: 'Spring 3', text: 'A fire in the market quarter', cat: 'town' }];
const market = [{ name: 'Salt', buy: 8, sell: 6, offered: true, held: 12, usual: 12 }, { name: 'Wine', buy: 30, sell: 26, offered: true, held: 3.5, usual: 28 }, { name: 'Sugar', buy: 80, sell: 74, offered: false, held: 0, usual: 60 }];
const ids = (about, most) => mateTopics(about, most).map((topic) => topic.id);

test('the questions on offer are those that fit where the ship and the captain are', () => {
  // At sea with the ship's own mate: the reckoning, the sailing, the log, the stores. No port, no people, no one to sign.
  assert.deepEqual(ids({ mate: tomas, now: atSea, near: null, news: [], town: null, market: null }), ['where', 'sail', 'news', 'stores']);
  // In a living port with no one yet signed on: who is in sight, the place, its market, its talk, and who would come.
  assert.deepEqual(ids({ mate: tomas, now: inPort, near, news, town: TOWN, market }, 12), ['who', 'port', 'trade', 'news', 'sign', 'stores', 'realm']);
  // A mate who is one of the model's people has a life to tell of, and is not asked who else would sign.
  const withJuana = { mate: juana, now: inPort, near: { ...near, lastAskedAfter: { id: 90, name: 'Gil Peón' } }, news, town: TOWN, market };
  assert.deepEqual(ids(withJuana, 12), ['who', 'port', 'trade', 'news', 'stores', 'realm', 'self', 'home']);
  assert.equal(mateTopics(withJuana, 12)[0].label, 'Who is Gil?', 'the one last pointed at is asked after by name');
  assert.deepEqual(ids({ mate: juana, now: atSea, near: null, news, town: null, market: null }), ['where', 'sail', 'news', 'stores', 'self', 'home']);
  // The mate's own life gives way first when few can be shown; never none; a port with no living model offers no sign-on.
  assert.deepEqual(ids(withJuana, 3), ['who', 'port', 'trade']); assert.equal(ids(withJuana, 0).length, 1);
  assert.ok(!ids({ mate: tomas, now: { ...inPort, where: { kind: 'port', ashore: true, living: false, name: 'Funchal' } }, near: null, news: [], town: null, market: null }).includes('sign'));
  assert.ok(!ids({ mate: { ...juana, about: { ...juana.about, spouse: '', children: '', head: '' } }, now: atSea }).includes('home'), 'no one at home is not asked after');
  assert.deepEqual(mateTopics(null), []); assert.deepEqual(mateTopics({}), []);
  for (const topic of mateTopics(withJuana, 12)) assert.ok(topic.label.length <= 34 && /^[A-Z]/.test(topic.label), topic.label);
});

test('at sea the mate gives the reckoning, how she lies to the wind, and what is left to eat and drink', () => {
  const about = { mate: tomas, now: atSea, near: null, news: [], town: null, market: null };
  assert.equal(mateCounsel('where', about), 'By my reckoning we are in 36° 12′ N, 11° 24′ W, captain. 3 days out of Lisboa, with 87 leagues on the log. Funchal bears SW, some 113 leagues off.');
  assert.equal(mateCounsel('sail', about), 'The wind is a fresh breeze from the NW, captain. She heads SW, steering SW by the compass, and makes 6.4 knots. She has the wind on the beam.');
  assert.equal(mateCounsel('stores', about), 'We have food for 41 days and water for 8, with 38 hands to feed, captain. The water is the worry: we must fill the casks soon. There are 1,240 reales in the chest. In the hold: 12 tonnes of salt and 3.5 tonnes of wine.');
  assert.equal(mateCounsel('news', about), 'Nothing but what is in the log, captain. Sighted a sail to leeward.');
  // No port named: said so. A dead-reckoned place is given before the true one.
  assert.match(mateCounsel('where', { now: { ...atSea, where: { lat: 1, lon: 2, reckoned: { lat: 36.5, lon: -11 } }, voyage: { ...atSea.voyage, to: null } } }), /36° 30′ N, 11° 00′ W.*You have named no port to make for\.$/);
  assert.match(mateCounsel('stores', { now: { ship: { foodDays: 4, waterDays: 30 }, captain: { coin: 1, cargo: [] } } }), /The bread is the worry.*There is a single coin in the chest\. The hold is empty\.$/);
  assert.match(mateCounsel('sail', { now: { ship: { ...ship, knots: 0.1 } } }), /makes no way/);
  assert.deepEqual([0, 50, 90, 130, 180, 270, 359].map((from) => counselPointOfSail(from, 0).split(/[:.]/)[0]), ['She is in irons, or near it', 'She is close-hauled', 'She has the wind on the beam', 'She has it on the quarter', 'She runs before it', 'She has the wind on the beam', 'She is in irons, or near it']);
});

test('in port the mate tells the place from the model\'s record of it, its talk, its prices, its crown and who stands by', () => {
  const about = { mate: juana, now: inPort, near, news, town: TOWN, market };
  assert.equal(mateCounsel('port', about), 'Lisboa, captain: the seat of King Fernando. Some 19,000 souls within stone walls, held by House de Lisboa, with some 800 men under arms. Most who work here are merchants, weavers and fishers. They speak Castilian. It is a quiet town, and does well enough.');
  assert.match(mateCounsel('port', { ...about, town: { ...TOWN, role: 'town', kind: 'village', walls: 'none', garrison: 0, plague: true, besieged: true, hunger: 0.4, unrest: 60 } }), /^Lisboa, captain: a village\. Some 19,000 souls, held by House de Lisboa\. .*pestilence.*under siege\. There is hunger here\. The streets are restless\.$/);
  assert.equal(mateCounsel('port', { now: { where: { name: 'Funchal' } } }), 'This is Funchal, captain. I know no more of it than the chart does.');
  // The talk of the town before the merchants' lines; what is said is what the annals say.
  assert.equal(mateCounsel('news', about), 'The talk is this, captain. The Queen has borne a son. A fire in the market quarter.');
  assert.equal(mateCounsel('news', { news: [news[0]] }), 'The talk is this, captain. Wheat is dear at Lisboa.');
  assert.equal(mateCounsel('trade', about), 'Salt (8) is cheap here, captain, in reales the tonne. They pay well for sugar (74). Our salt would fetch 6: I would carry it on. Our wine would fetch 26: I would carry it on.');
  assert.equal(mateCounsel('realm', about), 'King Fernando rules Castilla: 41 towns and villages and some 61,000 souls. The crown\'s right is not questioned. The realm is at peace.');
  assert.match(mateCounsel('realm', { now: { realm: { ...realm, legitimacy: 20, war: { with: 'x' }, feuds: [1, 2], plague: true, priceLevel: 1.4 } } }), /Few think the crown rightly held\. The realm is at war\. The great houses feud: 2 quarrels that I know of\. There is pestilence in the land\. Prices run high this year\.$/);
  // Who stands by: the nearest in sight, or the one last pointed at; one of the mate's own town is said to be.
  assert.equal(mateCounsel('who', about), 'That is Inés Roldán, a fisher of 31. She is mending a net. One of my own town.');
  assert.equal(mateCounsel('who', { ...about, mate: tomas, near: { ...near, lastAskedAfter: { id: 90, name: 'Gil Peón' } } }), 'That is Gil Peón, 26. He is keeping watch.');
  // Nothing known: said so, and nothing made up.
  assert.deepEqual(['port', 'who', 'news', 'realm', 'trade', 'stores', 'sail', 'where'].map((id) => mateCounsel(id, {})), ['I know nothing of this place, captain.', 'I see no one I can name, captain.', 'I have heard nothing new, captain.',
    'I do not know who holds this coast, captain.', 'I have seen no merchant\'s list here, captain.', 'The hold is empty.', 'I cannot tell how she lies, captain.', 'I have no reckoning to give you, captain.']);
  assert.equal(mateCounsel('nope', about), null); assert.equal(mateCounsel('constructor', about), null);
});

test('a mate of the model tells their own life from their card, and who would sign on is told from theirs', () => {
  assert.deepEqual(juana.about, { born: 'Born Summer 27, AD 1509', home: 'Tienda de la Llave de Bronce in the market quarter', spouse: 'Vela Cerro', children: 'Rui Cerro, Ana Cerro', head: 'Vela Cerro; worth 29 crowns', nature: 'tall, bold, idle, fair-haired', learning: 'skilled craft' });
  const about = { mate: juana, now: atSea };
  assert.equal(mateCounsel('self', about), 'Juana Cubero, captain: a cooper of Lisboa before I was your mate. I was born in the summer of 1509. My house is Tienda de la Llave de Bronce in the market quarter. They will tell you I am tall, bold, idle and fair-haired. For learning I have skilled craft.');
  assert.equal(mateCounsel('home', about), 'Vela Cerro, my husband, and our Rui and Ana. Vela keeps the household while I am at sea.');
  assert.equal(mateCounsel('home', { mate: { name: 'Rui Cerro', sex: 'm', model: true, about: { spouse: '', children: '', head: '' } } }), 'No one, captain. The ship is my house now.');
  assert.equal(mateCounsel('home', { mate: { name: 'Rui Cerro', sex: 'm', model: true, about: { spouse: 'Ana Gil', children: '', head: 'Rui Cerro; worth 3 crowns' } } }), 'Ana Gil, my wife. The household is mine, and they keep it for me.');
  assert.deepEqual(mateAbout(null), { born: '', home: '', spouse: '', children: '', head: '', nature: '', learning: '' });
  assert.equal(mateCandidateLine({ name: 'Juana Cubero', age: 40, role: 'cooper' }), 'Juana Cubero, 40, cooper'); assert.equal(mateCandidateLine({ name: 'Gil Peón', age: 26, role: null }), 'Gil Peón, 26');
  assert.equal(mateCandidateAccount({ name: 'Juana Cubero', age: 40, sex: 'f', role: 'cooper', home: 'Tienda de la Llave de Bronce in the market quarter', kin: ['Husband: Vela Cerro'], nature: 'tall, bold, idle, fair-haired', learning: 'skilled craft' }),
    'Juana Cubero: a cooper of 40, of Tienda de la Llave de Bronce in the market quarter. Husband Vela Cerro. They say she is tall, bold, idle and fair-haired. Learning: skilled craft.');
  assert.equal(mateCandidateAccount({ name: 'Gil Peón', age: 26 }), 'Gil Peón: 26, of no trade.');
  assert.deepEqual([0, 42, 778, 19448].map(counselSouls), ['no one', '42', 'some 800', 'some 19,000']);
});

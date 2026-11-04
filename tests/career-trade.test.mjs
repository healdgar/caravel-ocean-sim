// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The money rules of a trading life, and a whole voyage's worth of business through them.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { NEW_WORLD_ERA as era } from '../js/career-era.js';
import {
  ensureCareerLedger, marketRegion, marketQuote, goodsInSeason, buyGood, sellGood, cargoLoad, cargoCapacityTonnes, wagesQuote, payWages,
  provisionQuote, crewQuote, repairQuote, shipOffers, careerWorth, careerTitle, careerEnding, hullValue, MARKET_SUPPLY_LIMIT,
} from '../js/career-trade.js';
import { createCareerPort } from '../js/career-port.js';
import { createCareerStore, parseCareerSave, applyShipwreckRecovery } from '../js/career-save.js';
import { createVesselDamageState } from '../js/gunnery-control.js';
import { setVesselHullIntegrity } from '../js/vessel-damage.js';
import { HISTORICAL_COLONIAL_PORTS } from '../js/coastal-world.js';
import { boatHydrodynamics } from '../js/boat.js';
import { getShipModel } from '../js/ship-models.js';
import { readFileSync } from 'node:fs';
import { createCoastlineIndex, pilotDropPoint } from '../js/voyage/landfall-approach.js';

const DAY = 86400000;
const date = Date.UTC(1550, 2, 14);
const port = (id) => HISTORICAL_COLONIAL_PORTS.find((p) => p.id === id);
const good = (id) => era.goods.find((g) => g.id === id);
const fresh = (purse = 300) => { const l = ensureCareerLedger({}, era, date); l.purse = purse; return l; };
const memoryStorage = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k) }; };

test('every port in the era belongs to a trading region', () => {
  for (const p of HISTORICAL_COLONIAL_PORTS) assert.ok(marketRegion(era, p), p.id);
  assert.equal(marketRegion(era, port('lisbon')), 'europe');
  assert.equal(marketRegion(era, port('havana')), 'caribbean');
  assert.equal(marketRegion(era, port('jamestown')), 'north-america');
  assert.equal(marketRegion(era, port('manila')), 'asia');
  assert.equal(marketRegion(era, port('salvador-da-bahia')), 'brazil');
  assert.equal(marketRegion(era, port('funchal')), 'isles');
});

test('no good represents a person, and no later rule can quietly add one', () => {
  const words = /slave|captive|enslav|servant|indenture|negro|person|people|labou?r/i;
  for (const g of era.goods) assert.ok(!words.test(`${g.id} ${g.name}`), g.id);
});

test('goods only appear in the years they were traded', () => {
  const ids = (year) => goodsInSeason(era, year).map((g) => g.id);
  assert.ok(!ids(1550).includes('tobacco'));
  assert.ok(ids(1620).includes('tobacco'));
  assert.ok(!ids(1600).includes('furs') && !ids(1640).includes('rum'));
  assert.ok(ids(1660).includes('rum'));
});

test('a market offers only what it can supply, and buys anything', () => {
  const ledger = fresh();
  const lisbon = port('lisbon'), havana = port('havana');
  assert.equal(marketQuote(era, ledger, lisbon, good('cloth'), date).offered, true);
  assert.equal(marketQuote(era, ledger, lisbon, good('sugar'), date).offered, false, 'Lisbon does not grow sugar');
  assert.equal(marketQuote(era, ledger, havana, good('sugar'), date).offered, true);
  for (const g of era.goods) for (const region of Object.keys(g.regions)) assert.ok(Number.isFinite(g.regions[region]));
  assert.ok(MARKET_SUPPLY_LIMIT > 1);
  ledger.cargo.sugar = 1;
  assert.equal(sellGood(ledger, era, lisbon, good('sugar'), 1, { dateMs: date }).tonnes, 1);
});

test('carrying sugar to Europe and cloth to the Indies pays, and a round trip in one port loses', () => {
  const lisbon = port('lisbon'), havana = port('havana');
  const sugarHere = marketQuote(era, fresh(), havana, good('sugar'), date), sugarThere = marketQuote(era, fresh(), lisbon, good('sugar'), date);
  assert.ok(sugarThere.sell > sugarHere.buy * 1.5, `sugar ${sugarHere.buy} to ${sugarThere.sell}`);
  const clothHere = marketQuote(era, fresh(), lisbon, good('cloth'), date), clothThere = marketQuote(era, fresh(), havana, good('cloth'), date);
  assert.ok(clothThere.sell > clothHere.buy * 1.5, `cloth ${clothHere.buy} to ${clothThere.sell}`);
  const ledger = fresh(1000);
  buyGood(ledger, era, lisbon, good('cloth'), 3, { dateMs: date, capacity: 40 });
  sellGood(ledger, era, lisbon, good('cloth'), 3, { dateMs: date });
  assert.ok(ledger.purse < 1000, 'the merchant keeps a spread each way');
});

test('a big trade moves the price against the trader, and the market recovers in time', () => {
  const lisbon = port('lisbon'), ledger = fresh(100000);
  const first = marketQuote(era, ledger, lisbon, good('cloth'), date).buy;
  buyGood(ledger, era, lisbon, good('cloth'), 40, { dateMs: date, capacity: 100 });
  const after = marketQuote(era, ledger, lisbon, good('cloth'), date).buy;
  assert.ok(after > first * 1.2, `${first} to ${after}`);
  const later = marketQuote(era, ledger, lisbon, good('cloth'), date + 360 * DAY).buy;
  assert.ok(later < after && Math.abs(later - first) < first * 0.25, `recovers to ${later}`);
});

test('a purchase stops at the purse and the hold', () => {
  const lisbon = port('lisbon');
  const poor = fresh(250);
  const r = buyGood(poor, era, lisbon, good('cloth'), 10, { dateMs: date, capacity: 40 });
  assert.ok(r.tonnes >= 1 && r.tonnes < 4);
  assert.ok(poor.purse >= 0);
  const full = fresh(100000);
  assert.equal(buyGood(full, era, lisbon, good('salt'), 10, { dateMs: date, capacity: 4 }).tonnes, 4);
  assert.equal(cargoLoad(full), 4);
  assert.equal(buyGood(fresh(), era, lisbon, good('sugar'), 1, { dateMs: date, capacity: 40 }).tonnes, 0, 'nothing to buy here');
});

test('capacity follows the hull, within what hydrostatics counts', () => {
  const mass = (id) => { const rt = getShipModel(id).runtime; return boatHydrodynamics(rt.length, rt.beam, 30, 0, id).mass; };
  const capacity = (id) => cargoCapacityTonnes(mass(id));
  assert.ok(capacity('taino-canoe') <= 4);
  assert.ok(capacity('nina') > 30 && capacity('nina') < 50);
  assert.ok(capacity('santa-maria') > capacity('pinta') && capacity('pinta') > capacity('nina'));
  assert.equal(capacity('victory'), 100);
});

test('wages run with the calendar, and a short purse pays what it can', () => {
  const ledger = fresh(10);
  assert.deepEqual(wagesQuote(era, ledger, 20, date + 30 * DAY), { days: 30, due: 40 });
  const short = payWages(era, ledger, 20, date + 30 * DAY);
  assert.deepEqual(short, { paid: 10, cleared: false });
  assert.equal(ledger.purse, 0);
  assert.equal(wagesQuote(era, ledger, 20, date + 30 * DAY).due, 30, 'the rest stays owed');
  ledger.purse = 100;
  assert.equal(payWages(era, ledger, 20, date + 30 * DAY).cleared, true);
  assert.equal(wagesQuote(era, ledger, 20, date + 30 * DAY).due, 0);
});

test('stores, hands and repairs are priced by what is actually needed', () => {
  assert.equal(provisionQuote(era, { food: 120, water: 90 }, 22).cost, 0);
  assert.ok(provisionQuote(era, { food: 30, water: 30 }, 22).cost > provisionQuote(era, { food: 30, water: 30 }, 10).cost);
  assert.deepEqual(crewQuote(era, { killed: 2, wounded: 3 }), { needed: 5, cost: 30 });
  const whole = repairQuote(port('havana'), 1500, { hullIntegrity: 1, rigIntegrity: 1, floodingTonnes: 0 });
  assert.equal(whole.needed, false);
  assert.equal(whole.cost, 0);
  const hurt = repairQuote(port('havana'), 1500, { hullIntegrity: 0.5, rigIntegrity: 0.8, floodingTonnes: 3 });
  assert.equal(hurt.limit, 1);
  assert.ok(hurt.cost > 300 && hurt.days >= 5);
  const patch = repairQuote(port('saba'), 1500, { hullIntegrity: 0.5, rigIntegrity: 1, floodingTonnes: 0 });
  assert.equal(patch.limit, 0.8, 'a small port only patches');
  assert.ok(patch.cost < hurt.cost);
  assert.equal(repairQuote(port('saba'), 1500, { hullIntegrity: 0.9, rigIntegrity: 1, floodingTonnes: 0 }).needed, false);
});

test('a yard offers its hulls against part exchange, if the cargo would fit', () => {
  const capacityOf = (id) => ({ nina: 40, pinta: 58, 'santa-maria': 66 })[id];
  const offers = shipOffers(era, port('havana'), { currentId: 'nina', currentValue: 1500, hullIntegrity: 0.5, cargoTonnes: 60, capacityOf });
  assert.deepEqual(offers.map((o) => o.id), ['pinta', 'santa-maria']);
  assert.equal(offers[0].tradeIn, 450, 'a battered hull is worth less');
  assert.equal(offers[0].cost, 1950);
  assert.equal(offers[0].fits, false);
  assert.equal(offers[1].fits, true);
  assert.deepEqual(shipOffers(era, port('saba'), { currentId: 'nina', currentValue: 1500, capacityOf }), [], 'no yard at a small port');
});

test('worth counts purse, cargo and hull, and sets how a life is remembered', () => {
  const ledger = fresh(1000);
  ledger.cargo.sugar = 10;
  assert.equal(careerWorth(era, ledger, { value: 1500, hullIntegrity: 0.5 }), 1000 + 600 + 750);
  assert.equal(careerTitle(era, 100), 'A poor shipmaster');
  assert.equal(careerTitle(era, 10000), 'A prosperous merchant');
  assert.equal(careerTitle(era, 9e9), 'One of the richest traders of the age');
  ledger.portsVisited.push('lisbon', 'havana');
  const ending = careerEnding(era, ledger, { portName: 'Lisboa', dateMs: date + 730.5 * DAY, value: 1500 });
  assert.equal(ending.ports, 2);
  assert.ok(Math.abs(ending.years - 2) < 0.01);
  assert.equal(ending.title, 'A shipmaster of modest means');
});

test('hull value comes from the era, and an out-of-era hull from its mass', () => {
  assert.equal(hullValue(era, 'nina', 113000), 1500);
  assert.equal(hullValue(era, 'victory', 4742000), 56904);
});

// A whole run of business through the live pieces, with a stand-in for the game.
function makeGame(startPort = 'lisbon') {
  const store = createCareerStore({ storage: memoryStorage(), session: memoryStorage() });
  store.claim();
  const boat = { id: 'player', modelId: 'nina', length: 20, beam: 6, cargoTonnes: 0, provisionDays: 60 };
  createVesselDamageState(boat);
  const voyage = { dateMs: date, morale: 0.7, provisions: { food: 30, water: 20 } };
  const game = { store, boat, voyage, here: port(startPort), repaired: [], crewed: 0, bought: null, retired: null, saves: 0, passed: 0 };
  game.port = createCareerPort({
    era, store, boat,
    getVoyage: () => voyage,
    getCompany: () => ({ crew: [] }),
    getPort: () => game.here,
    capacityOf: () => 40,
    hullMassOf: () => 113000,
    saveVoyage: () => { game.saves++; },
    passDays: (days) => { game.passed += days; voyage.dateMs += days * DAY; },
    onRepaired: (whole) => game.repaired.push(whole),
    onCrewRestored: () => { game.crewed++; },
    onShipBought: (id, p) => { game.bought = { id, port: p.id }; },
    onRetired: (ending) => { game.retired = ending; },
  });
  return game;
}

test('a round voyage turns cloth and sugar into money, and every step survives a reload', () => {
  const game = makeGame(), { port: p, boat, voyage, store } = game;
  assert.equal(p.purse, era.startingPurse);
  const bought = p.buy('cloth', 2);
  assert.equal(bought.tonnes, 2);
  assert.equal(boat.cargoTonnes, 2, 'the hold really weighs on her');
  assert.equal(p.view().hold.used, 2);
  assert.equal(parseCareerSave(JSON.stringify(store.read())).career.cargo.cloth, 2, 'saved at once');
  assert.equal(voyage.keepSaved, true, 'even a voyage with no course yet is kept');
  assert.ok(game.saves > 0);
  const spent = era.startingPurse - p.purse;
  voyage.dateMs += 40 * DAY; game.here = port('havana');
  const sold = p.sell('cloth');
  assert.equal(sold.tonnes, 2);
  assert.equal(boat.cargoTonnes, 0);
  assert.ok(sold.income > spent * 1.5, `${spent} became ${sold.income}`);
  p.recordVisit(port('havana'));
  p.recordVisit(port('havana'));
  assert.deepEqual(p.ledger.portsVisited, ['havana']);
});

test('flood water in the hold stays separate from the goods', () => {
  const game = makeGame(), { port: p, boat } = game;
  boat.cargoTonnes = 5; // flooding carried as weight
  p.buy('cloth', 1);
  assert.equal(boat.cargoTonnes, 6);
  p.sell('cloth');
  assert.equal(boat.cargoTonnes, 5);
});

test('port services spend real money and change the real ship', () => {
  const game = makeGame('havana'), { port: p, boat, voyage } = game;
  p.ledger.purse = 5000;
  voyage.dateMs += 60 * DAY;
  const due = p.view().wages.due;
  assert.ok(due > 0);
  assert.equal(p.payWages().cleared, true);
  assert.equal(p.purse, 5000 - due);
  assert.ok(voyage.morale > 0.7);
  const before = p.purse;
  assert.equal(p.provision(), true);
  assert.equal(voyage.provisions.food, 120);
  assert.equal(voyage.provisions.water, 90);
  assert.ok(p.purse < before);
  assert.equal(p.provision(), false, 'nothing more to buy');
  const c = boat.damage.crewCasualties;
  c.killed = 3; c.wounded = 2; c.able = c.total - 5;
  assert.equal(p.hireCrew(), true);
  assert.equal(c.able, c.total);
  assert.equal(p.ledger.handsLost, 3);
  assert.equal(game.crewed, 1);
  setVesselHullIntegrity(boat.damage, 0.5);
  const dateBefore = voyage.dateMs, repair = p.view().repair;
  assert.equal(p.repair(), true);
  assert.equal(boat.damage.hullIntegrity, 1);
  assert.deepEqual(game.repaired, [true]);
  assert.equal(voyage.dateMs, dateBefore + repair.days * DAY, 'the work takes time');
  assert.equal(p.repair(), false, 'nothing left to mend');
});

test('a service a purse cannot cover changes nothing', () => {
  const game = makeGame('havana'), { port: p, boat } = game;
  p.ledger.purse = 0;
  setVesselHullIntegrity(boat.damage, 0.5);
  assert.equal(p.repair(), false);
  assert.equal(boat.damage.hullIntegrity, 0.5);
  const c = boat.damage.crewCasualties;
  c.killed = 3; c.able = c.total - 3;
  assert.equal(p.hireCrew(), false);
  assert.equal(c.killed, 3);
  assert.equal(p.provision(), false);
  assert.equal(p.buyShip('santa-maria'), false);
  assert.equal(game.bought, null);
});

test('buying a ship writes the new hull to the save and asks the game to reload', () => {
  const game = makeGame('havana'), { port: p, store } = game;
  p.ledger.purse = 5000;
  assert.equal(p.buyShip('santa-maria'), true);
  assert.deepEqual(game.bought, { id: 'santa-maria', port: 'havana' });
  assert.equal(store.read().vessel.modelId, 'santa-maria');
  assert.ok(p.purse < 5000);
});

test('retiring ends the life and clears the save for the next one', () => {
  const game = makeGame(), { port: p, store, voyage } = game;
  p.ledger.purse = 7000;
  p.buy('cloth', 1);
  assert.ok(store.read());
  const ending = p.retire();
  assert.equal(game.retired, ending);
  assert.equal(ending.title, 'A prosperous merchant');
  assert.equal(store.read(), null, 'the slate is clean');
  assert.equal(voyage.keepSaved, false, 'and nothing writes the old life back');
  assert.equal(voyage.passive, true);
});

test('a shipwreck loses the cargo and half the purse', () => {
  const save = { career: { purse: 1000, cargo: { sugar: 12 }, shipsLost: 0 }, vessel: { cargoTonnes: 12 } };
  const next = applyShipwreckRecovery(save, { voyage: null, damage: null, port: port('havana') });
  assert.deepEqual(next.career.cargo, {});
  assert.equal(next.career.purse, 500);
  assert.equal(next.career.shipsLost, 1);
  assert.equal(next.vessel.cargoTonnes, 0);
});

test('a pilot takes his fee, or whatever a short purse has', () => {
  const game = makeGame(), { port: p } = game;
  assert.equal(p.hirePilot(), era.costs.pilotFee);
  assert.equal(p.purse, era.startingPurse - era.costs.pilotFee);
  p.ledger.purse = 5;
  assert.equal(p.hirePilot(), 5);
  assert.equal(p.purse, 0);
  assert.equal(p.hirePilot(), 0, 'and a broke ship still gets in');
});

test('a grounded hull grinds slowly at a crawl, but a hard strike always counts', async () => {
  const { applyGroundingImpactDamage } = await import('../js/gunnery-control.js');
  const boat = { id: 'g', modelId: 'nina', length: 20, beam: 6, x: 0, z: 0, heave: 0, heading: 0, pitch: 0, roll: 0 };
  createVesselDamageState(boat);
  const contact = (impactSpeed) => ({ type: 'hard', substrateInfo: { id: 'test', label: 'test', safeTouchSpeed: 0.18, damageMultiplier: 1 }, impactSpeed, position: [0, 0, 0], localPosition: [0, -1, 0], normal: [0, 1, 0] });
  assert.ok(applyGroundingImpactDamage(boat, contact(0.9), { nowMs: 1000 }));
  assert.equal(applyGroundingImpactDamage(boat, contact(0.9), { nowMs: 1016 }), null, 'the next frame adds nothing');
  assert.ok(applyGroundingImpactDamage(boat, contact(0.9), { nowMs: 2600 }), 'but she keeps working on the bottom');
  assert.ok(applyGroundingImpactDamage(boat, contact(3), { nowMs: 2616 }), 'and striking hard always counts');
});

test('prize coin reaches the purse and counts the prize', () => {
  const game = makeGame(), { port: p } = game;
  p.earn(180, { prize: true });
  assert.equal(p.purse, era.startingPurse + 180);
  assert.equal(p.ledger.prizesTaken, 1);
});

test('a harbor pilot can leave a ship in open sea off every port', () => {
  const land = JSON.parse(readFileSync(new URL('../assets/world/land.json', import.meta.url), 'utf8'));
  const coast = createCoastlineIndex(Array.isArray(land) ? land : land.rings ?? land.land);
  for (const port of HISTORICAL_COLONIAL_PORTS) {
    const drop = pilotDropPoint(port.latitude, port.longitude, port.shoreBearing, coast, { drop: port.pilotDrop });
    assert.ok(drop, `${port.id} has no drop point`);
    assert.equal(coast.isLand(drop.lat, drop.lon), false, `${port.id} drops on land`);
    assert.equal(coast.nearestCoast(drop.lat, drop.lon, 18), null, `${port.id} drops inshore`);
    assert.ok(drop.distanceKm >= 30, `${port.id} drops too close to the port`);
  }
});

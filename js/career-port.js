// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// A ship's business in port: applies the trade rules to the live vessel and voyage, and
// saves the ledger after every change. The game passes in whatever touches rendering.
import {
  ensureCareerLedger, goodsInSeason, marketQuote, buyGood, sellGood, cargoLoad, wagesQuote, payWages, payPilot, provisionQuote, crewQuote,
  setBoardMarket, getBoardMarket,
  hullValue, repairQuote, shipOffers, careerWorth, careerEnding, CAREER_FOOD_DAYS_LIMIT, CAREER_WATER_DAYS_LIMIT,
} from './career-trade.js';
import { repairVessel } from './vessel-damage.js';
import { DEFAULT_DEPARTURE, voyageDateInEra } from './voyage/passage.js';

const WAGES_MORALE_GAIN = 0.1;

export function createCareerPort({ era, store, boat, getVoyage, getCompany, getPort, capacityOf, hullMassOf, saveVoyage = () => {}, passDays = () => {}, onPutToSea = () => {}, onRepaired = () => {}, onCrewRestored = () => {}, onShipBought = () => {}, onRetired = () => {}, onBoardTrade = () => {} }) {
  let ledger = null;
  const boardMarkets = Object.create(null);
  // The voyage keeps its own date inside the era (normaliseVoyageEra); only a ship with no voyage needs a date lent to her.
  const dateMs = () => {
    const raw = getVoyage()?.dateMs;
    return voyageDateInEra(raw) ? raw : DEFAULT_DEPARTURE.dateMs;
  };
  const load = () => {
    ledger ??= ensureCareerLedger(store.read()?.career ?? {}, era, dateMs());
    for (const [portId, snapshot] of Object.entries(boardMarkets)) setBoardMarket(ledger, portId, snapshot);
    return ledger;
  };
  const save = () => {
    const voyage = getVoyage();
    // Business done in port is worth keeping, even before a course has been laid.
    if (voyage) voyage.keepSaved = true;
    store.write({ career: ledger });
    saveVoyage();
  };
  const year = () => new Date(dateMs()).getUTCFullYear();
  const casualties = () => boat.damage?.crewCasualties;
  const hands = () => casualties()?.able ?? 0;
  const capacity = () => capacityOf(boat.modelId);
  const value = () => hullValue(era, boat.modelId, hullMassOf(boat.modelId));
  const goodById = (id) => goodsInSeason(era, year()).find((g) => g.id === id);
  const stowCargo = (delta) => { boat.cargoTonnes = Math.max(0, (boat.cargoTonnes ?? 0) + delta); };

  return {
    era,
    get ledger() { return load(); },
    get here() { return getPort(); },
    // A new life in the same tab starts from whatever the save now says.
    reset() { ledger = null; },
    get purse() { return load().purse; },
    // Coin that comes aboard at sea, such as a prize's strongbox.
    earn(amount, { prize = false } = {}) {
      load().purse += amount;
      if (prize) ledger.prizesTaken += 1;
      save();
    },
    recordVisit(port) {
      load();
      if (!ledger.portsVisited.includes(port.id)) { ledger.portsVisited.push(port.id); save(); }
    },
    view() {
      const port = getPort();
      if (!port) return null;
      load();
      const date = dateMs(), voyage = getVoyage(), damage = boat.damage;
      const repair = repairQuote(port, value(), damage), wages = wagesQuote(era, ledger, hands(), date);
      const stores = provisionQuote(era, voyage?.provisions, hands()), crew = crewQuote(era, casualties());
      return {
        port,
        power: era.powers[port.crown] ?? null,
        purse: ledger.purse,
        currency: era.currency,
        hold: { used: cargoLoad(ledger), capacity: capacity() },
        goods: goodsInSeason(era, year()).map((good) => marketQuote(era, ledger, port, good, date)),
        wages,
        stores: { ...stores, foodDays: voyage?.provisions?.food ?? 0, waterDays: voyage?.provisions?.water ?? 0 },
        crew: { ...crew, able: hands(), total: casualties()?.total ?? 0 },
        repair,
        pilotFee: era.costs.pilotFee,
        ships: shipOffers(era, port, { currentId: boat.modelId, currentValue: value(), hullIntegrity: damage?.hullIntegrity ?? 1, cargoTonnes: cargoLoad(ledger), capacityOf }),
        worth: careerWorth(era, ledger, { value: value(), hullIntegrity: damage?.hullIntegrity ?? 1 }),
      };
    },
    setBoardMarket(portId, snapshot) {
      if (!portId) return;
      if (snapshot) boardMarkets[portId] = snapshot;
      else delete boardMarkets[portId];
      if (ledger) setBoardMarket(ledger, portId, snapshot);
    },
    buy(goodId, tonnes) {
      const good = goodById(goodId), port = getPort();
      if (!good || !port) return { tonnes: 0, cost: 0 };
      const current = load();
      const result = buyGood(current, era, port, good, tonnes, { dateMs: dateMs(), capacity: capacity() });
      if (result.tonnes) {
        stowCargo(result.tonnes);
        save();
        if (good.boardGood && getBoardMarket(current, port.id)) {
          onBoardTrade({ port, good, act: 'buy', tonnes: result.tonnes, boardGood: good.boardGood, qty: result.tonnes * (good.boardPerTonne || 10) });
        }
      }
      return result;
    },
    sell(goodId, tonnes = Infinity) {
      const good = goodById(goodId) ?? era.goods.find((g) => g.id === goodId), port = getPort();
      if (!good || !port) return { tonnes: 0, income: 0 };
      const current = load();
      const result = sellGood(current, era, port, good, tonnes, { dateMs: dateMs() });
      if (result.tonnes) {
        stowCargo(-result.tonnes);
        save();
        if (good.boardGood && getBoardMarket(current, port.id)) {
          onBoardTrade({ port, good, act: 'sell', tonnes: result.tonnes, boardGood: good.boardGood, qty: result.tonnes * (good.boardPerTonne || 10) });
        }
      }
      return result;
    },
    payWages() {
      const result = payWages(era, load(), hands(), dateMs());
      if (result.paid > 0) {
        const voyage = getVoyage();
        if (voyage && result.cleared) voyage.morale = Math.min(1, (voyage.morale ?? 0.85) + WAGES_MORALE_GAIN);
        save();
      }
      return result;
    },
    provision() {
      const voyage = getVoyage();
      if (!voyage?.provisions) return false;
      const quote = provisionQuote(era, voyage.provisions, hands());
      if (quote.cost <= 0 || quote.cost > load().purse) return false;
      ledger.purse -= quote.cost;
      voyage.provisions.food = CAREER_FOOD_DAYS_LIMIT;
      voyage.provisions.water = CAREER_WATER_DAYS_LIMIT;
      // Fresh food ashore is the cure for scurvy, and its clock starts again from here.
      voyage.freshStoresMs = voyage.dateMs;
      voyage.crewHealth = 1;
      save();
      return true;
    },
    hireCrew() {
      const c = casualties(), quote = crewQuote(era, c);
      if (!c || quote.needed <= 0 || quote.cost > load().purse) return false;
      ledger.purse -= quote.cost;
      ledger.handsLost += c.killed;
      c.killed = 0; c.wounded = 0; c.able = c.total;
      if (boat.damage) { boat.damage.moraleShock = 0; boat.damage.battleMorale = 1; boat.damage.moraleState = 'steady'; }
      onCrewRestored(getCompany());
      save();
      return true;
    },
    repair() {
      const port = getPort();
      if (!port) return false;
      const quote = repairQuote(port, value(), boat.damage);
      if (!quote.needed || quote.cost > load().purse) return false;
      ledger.purse -= quote.cost;
      const whole = quote.limit >= 1;
      repairVessel(boat, { minHull: quote.limit, minRig: quote.limit, leaks: true, flooding: true, guns: true, fires: true, structure: whole });
      if (whole && boat.damage) { boat.damage.hullCracked = false; boat.damage.bendingStrain = 0; }
      passDays(quote.days);
      onRepaired(whole);
      save();
      return true;
    },
    buyShip(modelId) {
      const port = getPort();
      const offer = port && shipOffers(era, port, { currentId: boat.modelId, currentValue: value(), hullIntegrity: boat.damage?.hullIntegrity ?? 1, cargoTonnes: cargoLoad(load()), capacityOf }).find((s) => s.id === modelId);
      if (!offer || !offer.fits || offer.cost > ledger.purse) return false;
      ledger.purse -= offer.cost;
      store.write({ career: ledger, vessel: { modelId, cargoTonnes: cargoLoad(ledger), provisionDays: boat.provisionDays } });
      onShipBought(modelId, port);
      return true;
    },
    // Whichever way the pilot takes her, the fee comes out of the purse.
    hirePilot() {
      const paid = payPilot(era, load());
      save();
      return paid;
    },
    putToSea() {
      const port = getPort();
      if (!port) return false;
      this.hirePilot();
      onPutToSea(port);
      return true;
    },
    retire() {
      const port = getPort(), date = dateMs();
      if (!port) return null;
      const ending = careerEnding(era, load(), { portName: port.name, dateMs: date, value: value(), hullIntegrity: boat.damage?.hullIntegrity ?? 1 });
      // Nothing may write this life back into the save after it has ended.
      const voyage = getVoyage();
      if (voyage) { voyage.passive = true; voyage.keepSaved = false; }
      store.clear();
      onRetired(ending);
      return ending;
    },
  };
}

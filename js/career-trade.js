// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Money, markets and the bills of a ship in port. Pure rules over a plain ledger that
// lives in the save: no DOM, no GPU and nothing specific to one era.
export const MARKET_SUPPLY_LIMIT = 1.1;
export const MARKET_SPREAD = 0.05;
export const CAREER_FOOD_DAYS_LIMIT = 120;
export const CAREER_WATER_DAYS_LIMIT = 90;
export const YARD_MIN_TIER = 2;

const BOARD_MARKETS = new WeakMap();
export function setBoardMarket(ledger, portId, snapshot) {
  if (!ledger || typeof ledger !== 'object' || !portId) return;
  let map = BOARD_MARKETS.get(ledger);
  if (!map) BOARD_MARKETS.set(ledger, map = Object.create(null));
  if (snapshot) map[portId] = snapshot;
  else delete map[portId];
}
export function getBoardMarket(ledger, portId) {
  if (!ledger || !portId) return null;
  return ledger.boardMarkets?.[portId] ?? BOARD_MARKETS.get(ledger)?.[portId] ?? null;
}
const TRADE_DAY_MS = 86400000;
const MARKET_PRESSURE_LIMIT = 0.6;
const MARKET_PRESSURE_HALF_LIFE_DAYS = 45;
const YARD_TRADE_IN = 0.6;
const POOR_YARD_HULL_LIMIT = 0.8;

const tradeWhole = (x) => Math.round(x);

// Stable 0 to 1 for a pair of ids, so each port has its own lasting prices.
function tradeHash(text) {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) { h ^= text.charCodeAt(i); h = Math.imul(h, 16777619); }
  return (h >>> 0) / 4294967296;
}

export function ensureCareerLedger(career, era, dateMs) {
  const ledger = career ?? {};
  ledger.purse ??= era.startingPurse;
  ledger.cargo ??= {};
  ledger.market ??= {};
  ledger.startMs ??= dateMs;
  ledger.wagesPaidMs ??= dateMs;
  ledger.shipsLost ??= 0;
  ledger.handsLost ??= 0;
  ledger.prizesTaken ??= 0;
  ledger.tonnesTraded ??= 0;
  ledger.portsVisited ??= [];
  return ledger;
}

export function marketRegion(era, port) {
  return era.regions.find((r) => port.latitude >= r.latMin && port.latitude < r.latMax && port.longitude >= r.lonMin && port.longitude < r.lonMax)?.id ?? null;
}
export function marketDepth(port) { return Math.max(1, port.baseTier ?? 2) * 30; }
export function goodsInSeason(era, year) {
  return era.goods.filter((g) => (g.fromYear ?? -Infinity) <= year && year <= (g.toYear ?? Infinity));
}
// Places with no record of a good pay over the odds for it and cannot supply it.
const goodRegionFactor = (good, region) => good.regions[region] ?? 1.25;

function marketPressure(ledger, port, goodId, dateMs) {
  const record = ledger.market[port.id];
  const pressure = record?.pressure?.[goodId] ?? 0;
  if (!pressure) return 0;
  const days = Math.max(0, dateMs - (record.lastMs ?? dateMs)) / TRADE_DAY_MS;
  return pressure * 0.5 ** (days / MARKET_PRESSURE_HALF_LIFE_DAYS);
}
// The market's own price for a tonne today, before the merchant's cut either way.
function marketMidPrice(era, port, good, dateMs, pressure) {
  const h = tradeHash(`${port.id}/${good.id}`);
  const yearFraction = (dateMs / (365.25 * TRADE_DAY_MS)) % 1;
  const season = 1 + 0.1 * Math.sin(2 * Math.PI * (yearFraction + h));
  return good.price * goodRegionFactor(good, marketRegion(era, port)) * (0.92 + 0.16 * h) * season * (1 + pressure);
}
export function marketQuote(era, ledger, port, good, dateMs) {
  const bm = getBoardMarket(ledger, port?.id), bEntry = good?.boardGood ? bm?.goods?.[good.boardGood] : null;
  if (bEntry && bEntry.price > 0) {
    const perTonne = good.boardPerTonne || 10;
    const mid = bEntry.price * perTonne;
    const units = bEntry.onMarket ?? bEntry.store ?? 0;
    const offered = !bm.closed && units >= perTonne * 0.5;
    return {
      id: good.id,
      name: good.name,
      buy: tradeWhole(mid * (1 + MARKET_SPREAD)),
      sell: Math.max(1, tradeWhole(mid * (1 - MARKET_SPREAD))),
      offered,
      held: ledger.cargo[good.id] ?? 0,
      live: true,
      availTonnes: +(units / perTonne).toFixed(1),
    };
  }
  const mid = marketMidPrice(era, port, good, dateMs, marketPressure(ledger, port, good.id, dateMs));
  return {
    id: good.id,
    name: good.name,
    buy: tradeWhole(mid * (1 + MARKET_SPREAD)),
    sell: Math.max(1, tradeWhole(mid * (1 - MARKET_SPREAD))),
    offered: goodRegionFactor(good, marketRegion(era, port)) <= MARKET_SUPPLY_LIMIT,
    held: ledger.cargo[good.id] ?? 0,
  };
}
function moveMarket(ledger, port, good, dateMs, direction) {
  const goodId = typeof good === 'string' ? good : good.id;
  const bm = getBoardMarket(ledger, port?.id), bEntry = typeof good === 'object' && good?.boardGood ? bm?.goods?.[good.boardGood] : null;
  if (bEntry && bEntry.price > 0) {
    const perTonne = good.boardPerTonne || 10;
    const base = Math.max(0.1, bEntry.base || bEntry.price);
    const depth = Math.max(12, (bEntry.store || 0) + (bEntry.needMonth || 0) * 0.1 + 18);
    if (direction > 0) {
      bEntry.onMarket = Math.max(0, (bEntry.onMarket ?? bEntry.store ?? 0) - perTonne);
      bEntry.store = Math.max(0, (bEntry.store ?? 0) - perTonne);
      bEntry.price = Math.min(base * 4.5, Math.max(base * 0.25, bEntry.price * Math.exp(0.22 * Math.tanh(perTonne / depth))));
    } else {
      bEntry.onMarket = (bEntry.onMarket ?? bEntry.store ?? 0) + perTonne;
      bEntry.store = (bEntry.store ?? 0) + perTonne;
      bEntry.price = Math.min(base * 4.5, Math.max(base * 0.25, bEntry.price * Math.exp(-0.20 * Math.tanh(perTonne / depth))));
    }
    return;
  }
  const settled = marketPressure(ledger, port, goodId, dateMs);
  const record = (ledger.market[port.id] ??= { lastMs: dateMs, pressure: {} });
  // Bring every price up to date before moving the clock.
  for (const key of Object.keys(record.pressure)) record.pressure[key] = marketPressure(ledger, port, key, dateMs);
  record.lastMs = dateMs;
  record.pressure[goodId] = Math.max(-MARKET_PRESSURE_LIMIT, Math.min(MARKET_PRESSURE_LIMIT, settled + direction / marketDepth(port)));
}

export function cargoLoad(ledger) {
  return Object.values(ledger.cargo).reduce((sum, tonnes) => sum + tonnes, 0);
}
// A hull carries about a third of her own laden mass before she sails badly. Hydrostatics
// stops counting cargo at 100 tonnes, so nothing above that would weigh on her.
export function cargoCapacityTonnes(hullMassKg) {
  return Math.max(1, Math.min(100, Math.round(0.35 * hullMassKg / 1000)));
}

// Buying and selling a tonne at a time moves the price against the trader as it goes.
export function buyGood(ledger, era, port, good, tonnes, { dateMs, capacity }) {
  let bought = 0, cost = 0;
  while (bought < tonnes && cargoLoad(ledger) + 1 <= capacity) {
    const quote = marketQuote(era, ledger, port, good, dateMs);
    if (!quote.offered || quote.buy > ledger.purse) break;
    ledger.purse -= quote.buy;
    ledger.cargo[good.id] = (ledger.cargo[good.id] ?? 0) + 1;
    ledger.tonnesTraded += 1;
    moveMarket(ledger, port, good, dateMs, 1);
    bought++; cost += quote.buy;
  }
  return { tonnes: bought, cost };
}
export function sellGood(ledger, era, port, good, tonnes, { dateMs }) {
  let sold = 0, income = 0;
  while (sold < tonnes && (ledger.cargo[good.id] ?? 0) >= 1) {
    const quote = marketQuote(era, ledger, port, good, dateMs);
    ledger.purse += quote.sell;
    ledger.cargo[good.id] -= 1;
    if (ledger.cargo[good.id] <= 0) delete ledger.cargo[good.id];
    ledger.tonnesTraded += 1;
    moveMarket(ledger, port, good, dateMs, -1);
    sold++; income += quote.sell;
  }
  return { tonnes: sold, income };
}

// A pilot takes what a short purse has rather than leave a ship stranded.
export function payPilot(era, ledger) {
  const paid = Math.min(era.costs.pilotFee, Math.max(0, Math.floor(ledger.purse)));
  ledger.purse -= paid;
  return paid;
}

export function wagesQuote(era, ledger, hands, dateMs) {
  const days = Math.floor(Math.max(0, (dateMs - ledger.wagesPaidMs) / TRADE_DAY_MS));
  return { days, due: Math.ceil(hands * era.costs.wagePerHandMonth * days / 30) };
}
// A short purse pays what it can, and the rest stays owed.
export function payWages(era, ledger, hands, dateMs) {
  const { due } = wagesQuote(era, ledger, hands, dateMs);
  if (due <= 0) return { paid: 0, cleared: true };
  const paid = Math.min(due, Math.floor(ledger.purse));
  ledger.purse -= paid;
  ledger.wagesPaidMs += (dateMs - ledger.wagesPaidMs) * (paid / due);
  return { paid, cleared: paid >= due };
}

export function provisionQuote(era, provisions, hands) {
  const food = Math.max(0, CAREER_FOOD_DAYS_LIMIT - (provisions?.food ?? 0));
  const water = Math.max(0, CAREER_WATER_DAYS_LIMIT - (provisions?.water ?? 0));
  const cost = Math.ceil(hands * (food * era.costs.foodPerHandDay + water * era.costs.waterPerHandDay));
  return { food, water, cost };
}
export function crewQuote(era, casualties) {
  const needed = (casualties?.killed ?? 0) + (casualties?.wounded ?? 0);
  return { needed, cost: needed * era.costs.handBounty };
}

export function hullValue(era, modelId, hullMassKg = 0) {
  return era.ships.find((s) => s.id === modelId)?.price ?? tradeWhole(12 * hullMassKg / 1000);
}
// A small port patches what it can. A yard's work takes time, and wages keep running.
export function repairQuote(port, value, damage) {
  const hull = 1 - (damage?.hullIntegrity ?? 1), rig = 1 - (damage?.rigIntegrity ?? 1), flooding = damage?.floodingTonnes ?? 0;
  const limit = (port.baseTier ?? 2) >= YARD_MIN_TIER ? 1 : POOR_YARD_HULL_LIMIT;
  const hullWork = Math.max(0, limit - (damage?.hullIntegrity ?? 1)), rigWork = Math.max(0, limit - (damage?.rigIntegrity ?? 1));
  const needed = hullWork > 0.001 || rigWork > 0.001 || flooding > 0.01;
  return {
    needed,
    limit,
    hull,
    rig,
    cost: needed ? Math.max(1, tradeWhole(value * (0.5 * hullWork + 0.2 * rigWork) + flooding * 2)) : 0,
    days: needed ? Math.ceil(10 * hullWork + 5 * rigWork + (flooding > 0.01 ? 1 : 0)) : 0,
  };
}

// What this yard will build for you, against your present hull in part exchange.
export function shipOffers(era, port, { currentId, currentValue, hullIntegrity = 1, cargoTonnes = 0, capacityOf }) {
  if ((port.baseTier ?? 2) < YARD_MIN_TIER) return [];
  const tradeIn = tradeWhole(currentValue * hullIntegrity * YARD_TRADE_IN);
  return era.ships.filter((s) => s.id !== currentId).map((s) => ({
    id: s.id,
    name: s.name,
    price: s.price,
    tradeIn,
    cost: Math.max(0, s.price - tradeIn),
    capacity: capacityOf(s.id),
    fits: cargoTonnes <= capacityOf(s.id),
  }));
}

export function careerWorth(era, ledger, { value = 0, hullIntegrity = 1 } = {}) {
  let cargo = 0;
  for (const [id, tonnes] of Object.entries(ledger.cargo)) cargo += (era.goods.find((g) => g.id === id)?.price ?? 0) * tonnes;
  return tradeWhole(ledger.purse + cargo + value * hullIntegrity);
}
export function careerTitle(era, worth) {
  return era.fortunes.find((f) => worth < f.below)?.title ?? era.fortunes.at(-1).title;
}
export function careerEnding(era, ledger, { portName, dateMs, value = 0, hullIntegrity = 1 }) {
  const worth = careerWorth(era, ledger, { value, hullIntegrity });
  return {
    title: careerTitle(era, worth),
    portName,
    dateMs,
    worth,
    currency: era.currency,
    years: Math.max(0, (dateMs - ledger.startMs) / (365.25 * TRADE_DAY_MS)),
    ports: ledger.portsVisited.length,
    tonnesTraded: ledger.tonnesTraded,
    prizesTaken: ledger.prizesTaken,
    shipsLost: ledger.shipsLost,
    handsLost: ledger.handsLost,
  };
}

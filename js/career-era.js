// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// What the core game needs to know about one era of history. Career code reads goods,
// currency, powers, hulls and fortunes from here, so another era is another record.
// Prices are authored for play, in pesos per tonne. The goods and dates were written
// from memory and must be checked against sources before they become final in-game text.
//
// People are not goods. No entry here or in any later era may represent a person.
export const NEW_WORLD_ERA = Object.freeze({
  id: 'new-world',
  startYear: 1492,
  endYear: 1689,
  currency: Object.freeze({ singular: 'peso', plural: 'pesos' }),
  startingPurse: 300,
  powers: Object.freeze({ spain: 'Spanish', portugal: 'Portuguese', england: 'English', france: 'French', netherlands: 'Dutch' }),
  // Trading regions, first match wins.
  regions: Object.freeze([
    Object.freeze({ id: 'asia', latMin: -60, latMax: 60, lonMin: 60, lonMax: 180 }),
    Object.freeze({ id: 'cape', latMin: -60, latMax: -20, lonMin: 0, lonMax: 60 }),
    Object.freeze({ id: 'europe', latMin: 34, latMax: 70, lonMin: -30, lonMax: 40 }),
    Object.freeze({ id: 'isles', latMin: 10, latMax: 34, lonMin: -30, lonMax: -10 }),
    Object.freeze({ id: 'north-america', latMin: 27, latMax: 70, lonMin: -100, lonMax: -50 }),
    Object.freeze({ id: 'brazil', latMin: -40, latMax: 5, lonMin: -60, lonMax: -28 }),
    Object.freeze({ id: 'peru', latMin: -40, latMax: 0, lonMin: -90, lonMax: -60 }),
    Object.freeze({ id: 'caribbean', latMin: 5, latMax: 27, lonMin: -110, lonMax: -55 }),
  ]),
  // `regions` holds each place's price against `price`. A market only sells what it can
  // supply, so anything above MARKET_SUPPLY_LIMIT in career-trade.js it will buy but not offer.
  goods: Object.freeze([
    Object.freeze({ id: 'sugar', name: 'Sugar', price: 60, regions: Object.freeze({ caribbean: 0.62, brazil: 0.55, isles: 0.85, europe: 1.6, 'north-america': 1.35 }) }),
    Object.freeze({ id: 'tobacco', name: 'Tobacco', price: 90, fromYear: 1590, regions: Object.freeze({ caribbean: 0.78, 'north-america': 0.55, brazil: 0.8, europe: 1.7 }) }),
    Object.freeze({ id: 'hides', name: 'Hides', price: 40, fromYear: 1530, boardGood: 'hides', boardPerTonne: 30, regions: Object.freeze({ caribbean: 0.6, brazil: 0.8, peru: 0.7, europe: 1.5 }) }),
    Object.freeze({ id: 'cacao', name: 'Cacao', price: 120, fromYear: 1530, regions: Object.freeze({ caribbean: 0.62, peru: 0.85, europe: 1.7 }) }),
    Object.freeze({ id: 'indigo', name: 'Indigo', price: 260, fromYear: 1560, regions: Object.freeze({ caribbean: 0.66, europe: 1.6 }) }),
    Object.freeze({ id: 'cochineal', name: 'Cochineal', price: 900, fromYear: 1530, regions: Object.freeze({ caribbean: 0.62, peru: 0.9, europe: 1.7 }) }),
    Object.freeze({ id: 'dyewood', name: 'Dyewood', price: 30, regions: Object.freeze({ caribbean: 0.66, brazil: 0.5, europe: 1.6 }) }),
    Object.freeze({ id: 'furs', name: 'Furs', price: 240, fromYear: 1605, regions: Object.freeze({ 'north-america': 0.55, europe: 1.6 }) }),
    Object.freeze({ id: 'fish', name: 'Salt fish', price: 30, boardGood: 'fish', boardPerTonne: 12, regions: Object.freeze({ 'north-america': 0.55, europe: 1.0, caribbean: 1.5 }) }),
    Object.freeze({ id: 'naval-stores', name: 'Timber and tar', price: 25, boardGood: 'timber', boardPerTonne: 9, regions: Object.freeze({ 'north-america': 0.6, europe: 1.05, caribbean: 1.5, isles: 1.3 }) }),
    Object.freeze({ id: 'salt', name: 'Salt', price: 12, regions: Object.freeze({ isles: 0.5, europe: 0.8, caribbean: 1.2, 'north-america': 1.5 }) }),
    Object.freeze({ id: 'wine', name: 'Wine', price: 55, boardGood: 'wine', boardPerTonne: 5, regions: Object.freeze({ isles: 0.6, europe: 0.7, cape: 0.9, caribbean: 1.8, 'north-america': 1.6, brazil: 1.6, peru: 1.8, asia: 1.7 }) }),
    Object.freeze({ id: 'oil', name: 'Olive oil', price: 50, regions: Object.freeze({ europe: 0.7, isles: 1.05, caribbean: 1.7, brazil: 1.6, peru: 1.8 }) }),
    Object.freeze({ id: 'flour', name: 'Flour', price: 30, boardGood: 'grain', boardPerTonne: 11, regions: Object.freeze({ europe: 0.75, 'north-america': 0.8, cape: 0.8, caribbean: 1.6, isles: 1.2, brazil: 1.4 }) }),
    Object.freeze({ id: 'wool', name: 'Wool', price: 72, boardGood: 'wool', boardPerTonne: 18, regions: Object.freeze({ europe: 0.75, isles: 0.9, caribbean: 1.5, 'north-america': 1.6 }) }),
    Object.freeze({ id: 'leather', name: 'Leather', price: 72, boardGood: 'leather', boardPerTonne: 18, regions: Object.freeze({ europe: 0.8, isles: 1.05, caribbean: 1.5, 'north-america': 1.4, brazil: 1.5 }) }),
    Object.freeze({ id: 'cloth', name: 'Cloth', price: 150, boardGood: 'cloth', boardPerTonne: 15, regions: Object.freeze({ europe: 0.7, asia: 1.0, caribbean: 1.7, 'north-america': 1.6, brazil: 1.6, peru: 2.0 }) }),
    Object.freeze({ id: 'ironware', name: 'Ironware', price: 110, boardGood: 'tools', boardPerTonne: 8, regions: Object.freeze({ europe: 0.65, asia: 1.1, caribbean: 1.8, 'north-america': 1.7, brazil: 1.7, peru: 2.0 }) }),
    Object.freeze({ id: 'rum', name: 'Rum', price: 70, fromYear: 1650, regions: Object.freeze({ caribbean: 0.6, 'north-america': 1.4, europe: 1.3 }) }),
    Object.freeze({ id: 'spices', name: 'Spices', price: 500, boardGood: 'spice', boardPerTonne: 24, regions: Object.freeze({ asia: 0.45, cape: 1.3, europe: 1.9, isles: 1.5, caribbean: 1.6, brazil: 1.6 }) }),
    Object.freeze({ id: 'silk', name: 'Silk', price: 650, boardGood: 'silk', boardPerTonne: 39, regions: Object.freeze({ asia: 0.5, europe: 1.8, caribbean: 1.6, peru: 1.8 }) }),
  ]),
  // Hulls a yard can build in this era. Others can still be valued from their mass.
  ships: Object.freeze([
    Object.freeze({ id: 'nina', name: 'Niña-type caravel', price: 1500 }),
    Object.freeze({ id: 'pinta', name: 'Pinta-type caravel', price: 2400 }),
    Object.freeze({ id: 'santa-maria', name: 'Santa María-type nao', price: 4200 }),
  ]),
  costs: Object.freeze({ wagePerHandMonth: 2, handBounty: 6, foodPerHandDay: 0.1, waterPerHandDay: 0.02, pilotFee: 12 }),
  prizeCoin: Object.freeze({ surrendered: 180, fought: 280 }),
  // How a life at sea is remembered. Each title applies below its worth; the last has no limit.
  fortunes: Object.freeze([
    Object.freeze({ below: 1500, title: 'A poor shipmaster' }),
    Object.freeze({ below: 6000, title: 'A shipmaster of modest means' }),
    Object.freeze({ below: 25000, title: 'A prosperous merchant' }),
    Object.freeze({ below: 100000, title: 'A merchant prince' }),
    Object.freeze({ below: Infinity, title: 'One of the richest traders of the age' }),
  ]),
});

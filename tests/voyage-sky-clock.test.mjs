// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Who owns the sky clock and the voyage date: free sail leaves the sky to the sky panel, a voyage
// under way drives it, and a date from after the era never dates the log.
import assert from 'node:assert/strict';
import test from 'node:test';
import { createAstronomyClock } from '../js/astronomy.js';
import { createVoyageController } from '../js/voyage/voyage-controller.js';
import { DEFAULT_DEPARTURE, VOYAGE_LAST_YEAR, createVoyage, normaliseVoyageEra, restoreVoyage, serializeVoyage, voyageDateInEra } from '../js/voyage/passage.js';

const DAY_MS = 86400000;
const year = (ms) => new Date(ms).getUTCFullYear();
function harness(search = {}) {
  const boat = { x: 0, z: 0, heading: 90, speed: 0, surgeVelocity: 0, modelId: 'nina', model: { name: 'Niña' }, sailState: { set: [1, 1, 1] } };
  const P = { windSpeed: 7, windDir: 60, sunElev: 32, sunAzim: 135, swellHs: 1, swellDir: 200, swellLength: 90, clouds: 0.2, rain: 0, thunder: 0, haze: 0.5 };
  const astronomy = createAstronomyClock(new URLSearchParams({ latitude: '20', longitude: '-40', ...search }));
  const ctrl = createVoyageController({
    boat, P, astronomy,
    getTerrain: () => null,
    getCamera: () => ({ pos: [0, 10, 0] }),
    getVessels: () => [boat],
    loadLandRings: () => Promise.resolve([]),
    loadTile: () => Promise.resolve(null),
  });
  // One frame as the game runs it: the voyage steps, then the sky clock advances.
  const frames = (count, dt = 0.05) => { for (let i = 0; i < count; i++) { ctrl.update(dt, i * dt * 1000); astronomy.update(dt, boat); } };
  return { boat, P, astronomy, ctrl, frames };
}

test('free sail leaves the sky clock running at the rate the sky panel set', () => {
  const { astronomy, ctrl, frames } = harness({ skyMode: 'astronomy', astroDate: '1550-06-01T12:00:00Z', astroRate: '600' });
  ctrl.start({ passive: true, lat: 20, lon: -40 });
  frames(40);
  assert.ok(Math.abs(astronomy.elapsedSeconds - 40 * 0.05 * 600) < 1, `two seconds at 600x is twenty minutes of sky, got ${astronomy.elapsedSeconds.toFixed(1)} s`);
  assert.equal(astronomy.epochMs, Date.parse('1550-06-01T12:00:00Z'), 'the epoch the panel set is left alone');
  assert.equal(astronomy.rate, 600, 'and so is its rate');
});

test('a night picked from our own century stays in the free-sail sky and never dates the log', () => {
  const { boat, astronomy, ctrl, frames } = harness({ skyMode: 'manual' });
  ctrl.start({ passive: true, lat: 20, lon: -40 });
  const departed = ctrl.voyage.dateMs;
  astronomy.set({ mode: 'astronomy', date: '2026-06-15T02:00:00Z', rate: 1 }, boat);
  frames(20);
  assert.equal(year(astronomy.epochMs), 2026, 'the sky shows the night that was asked for');
  assert.equal(year(Date.parse(astronomy.state.date)), 2026);
  assert.equal(year(ctrl.voyage.dateMs), 1550, 'the log keeps its own age');
  assert.ok(ctrl.voyage.dateMs >= departed && ctrl.voyage.dateMs - departed < DAY_MS, 'and has only lived the second that passed');
});

test('a date picked inside the era dates the free-sail log once and is not rewritten', () => {
  const { boat, astronomy, ctrl, frames } = harness({ skyMode: 'manual' });
  ctrl.start({ passive: true, lat: 20, lon: -40 });
  astronomy.set({ mode: 'astronomy', date: '1620-09-06T10:00:00Z', rate: 0 }, boat);
  frames(10);
  assert.equal(year(ctrl.voyage.dateMs), 1620);
  assert.equal(year(astronomy.epochMs), 1620);
});

test('a voyage under way drives the sky, and a date from after its era is refused whole', () => {
  const { boat, astronomy, ctrl, frames } = harness({ skyMode: 'manual' });
  const departed = Date.UTC(1600, 5, 1, 12);
  ctrl.start({ lat: 20, lon: -40, dateMs: departed });
  frames(5);
  assert.equal(astronomy.mode, 'astronomy');
  assert.equal(astronomy.epochMs, ctrl.voyage.dateMs, 'the sky follows the voyage clock');
  // 1820 lay between the two thresholds the code once used: taken as the date, then rewritten to 1550 a frame later.
  astronomy.set({ mode: 'astronomy', date: '1820-01-01T12:00:00Z' }, boat);
  frames(5);
  assert.ok(ctrl.voyage.dateMs >= departed && ctrl.voyage.dateMs - departed < DAY_MS, 'the voyage keeps its date');
  assert.equal(year(astronomy.epochMs), 1600, 'and the sky returns to it');
});

test('one rule says which dates belong to the era, and it is applied where a date enters a voyage', () => {
  assert.equal(voyageDateInEra(Date.UTC(VOYAGE_LAST_YEAR, 11, 31)), true);
  assert.equal(voyageDateInEra(Date.UTC(VOYAGE_LAST_YEAR + 1, 0, 1)), false);
  assert.equal(voyageDateInEra(NaN), false);
  assert.equal(voyageDateInEra(undefined), false);

  const inEra = createVoyage({ dateMs: Date.UTC(1689, 4, 2, 9) });
  normaliseVoyageEra(inEra);
  assert.equal(inEra.dateMs, Date.UTC(1689, 4, 2, 9), 'a date inside the era is left exactly as it was');

  const modern = createVoyage({ dateMs: Date.UTC(2026, 5, 15) });
  modern.dayAtSea = 12;
  const restored = restoreVoyage(serializeVoyage(modern));
  assert.equal(restored.dateMs, DEFAULT_DEPARTURE.dateMs + 11 * DAY_MS, 'a save dated after the era sails again from the default departure, keeping her days at sea');

  const { ctrl } = harness();
  ctrl.start({ passive: true, lat: 20, lon: -40, dateMs: Date.UTC(1999, 0, 1) });
  assert.equal(year(ctrl.voyage.dateMs), 1550, 'a start asked for after the era is brought back into it');
});

test('the voyage date is not rewritten while she sails, whatever it was set to after loading', () => {
  // The old per-frame rewrite fought whoever set the date; the rule now runs only where a date enters.
  const { ctrl, frames } = harness({ skyMode: 'manual' });
  ctrl.start({ passive: true, lat: 20, lon: -40 });
  const set = Date.UTC(1586, 2, 24, 12);
  ctrl.voyage.dateMs = set;
  frames(10);
  assert.ok(ctrl.voyage.dateMs >= set && ctrl.voyage.dateMs - set < DAY_MS);
});

// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The founded world alive in play: the model's days kept to this game's calendar, and its annals told as they are written.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BOARD_YEAR_DAYS, boardDayOf, boardEpochYear, createBoardLife } from '../js/board-life.js';

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));
const baked = (more = {}) => ({ port: 'lisbon', year: 1550, request: { seed: 7, fate: 9, era: 1550 }, world: { bytes: 4, program: 'the-program', day: 0, year: 1550, ...more } });
const fetched = (bytes = [1, 2, 3, 4], ok = true) => async (url) => ({ ok, status: ok ? 200 : 404, url, arrayBuffer: async () => Uint8Array.from(bytes).buffer });

// A model that keeps a day and writes a line of annals for every tenth one.
function model({ program = 'the-program', refuse = null } = {}) {
  const made = { day: 0, asked: [], closed: false, opened: null };
  const open = async (request, options) => {
    made.opened = { request, bytes: options.world.length };
    return {
      program, on: {}, ready: Promise.resolve({ day: made.day }),
      async request(type, payload) {
        made.asked.push([type, payload]);
        if (refuse && type === refuse) throw new Error('refused');
        if (type === 'advance') { made.day += payload.days; return { day: made.day, complete: true }; }
        if (type === 'view' && payload.panel === 'advisor-state') return { date: `day ${made.day}`, people: 100 + made.day };
        if (type === 'view' && payload.panel === 'advisor-annals') {
          const lines = [];
          for (let d = Math.ceil(payload.from / 10) * 10; d <= made.day; d += 10) if (d > 0) lines.push({ day: d, date: `day ${d}`, cat: d % 20 ? 'trade' : 'crown', text: `the news of day ${d}` });
          return lines;
        }
        if (type === 'view') return { kind: payload.kind, payload };
        return { type, payload };
      },
      hook: async (name) => ({ hook: name, day: made.day }),
      close() { made.closed = true; },
    };
  };
  return { made, open };
}

test('the model\'s year of 360 days is laid over this game\'s year, spring first', () => {
  assert.equal(BOARD_YEAR_DAYS, 360);
  assert.equal(boardDayOf(Date.UTC(1550, 2, 1), 1550), 0);
  assert.equal(boardDayOf(Date.UTC(1550, 2, 1, 23, 59), 1550), 0);
  assert.equal(boardDayOf(Date.UTC(1550, 2, 24), 1550), 22);
  assert.equal(boardDayOf(Date.UTC(1550, 8, 1), 1550), 181, 'the first of September, 184 days of 365 on');
  assert.equal(boardDayOf(Date.UTC(1551, 1, 28), 1550), 359);
  assert.equal(boardDayOf(Date.UTC(1551, 2, 1), 1550), 360);
  assert.equal(boardDayOf(Date.UTC(1553, 2, 1), 1550), 1080);
  assert.equal(boardDayOf(Date.UTC(1550, 0, 15), 1550), 0, 'before the world\'s first spring nothing has passed');
  // A leap year is spread the same: every true day is a model day or none, never two, and none goes back.
  let last = 0;
  for (let ms = Date.UTC(1551, 2, 1); ms <= Date.UTC(1553, 2, 1); ms += 86400000) {
    const day = boardDayOf(ms, 1550);
    assert.ok(day === last || day === last + 1 || last === 0, `${new Date(ms).toISOString()}: ${last} then ${day}`);
    last = day;
  }
  assert.equal(last, 1080);
  assert.equal(boardEpochYear({ year: 1550, day: 0 }), 1550);
  assert.equal(boardEpochYear({ year: 1552, day: 725 }), 1550);
});

test('a frozen world is taken up, lives the days the calendar is ahead by a stride at a time, and tells its annals', async () => {
  const { made, open } = model(), states = [], heard = [];
  const life = createBoardLife({ baked: baked(), fetchImpl: fetched(), open, onState: (state) => states.push(state), onNews: (lines) => heard.push(lines.map((line) => line.day)), stride: 30 });
  assert.equal(life.state, 'asleep');
  await assert.rejects(life.record(), /asleep/, 'nothing is asked of a world not taken up');
  life.tick(Date.UTC(1550, 5, 1));
  assert.equal(life.wanted, 0, 'and it lives no days asleep');
  await life.start();
  assert.deepEqual(states, ['waking', 'alive']);
  assert.deepEqual(made.opened, { request: baked().request, bytes: 4 });
  assert.deepEqual(life.status, { date: 'day 0', people: 100 });

  // The eleventh of June, 1550: a hundred days of the model's year on.
  const june = Date.UTC(1550, 5, 11);
  life.tick(june);
  assert.equal(life.wanted, boardDayOf(june, 1550)); assert.equal(life.wanted, 100);
  life.tick(june);
  await settle();
  assert.equal(life.day, 30, 'one stride, however often it is asked while that stride is lived');
  assert.equal(made.asked.filter(([type]) => type === 'advance').length, 1);
  for (let k = 0; k < 6; k++) { life.tick(june); await settle(); }
  assert.equal(life.day, 100); assert.equal(life.lived, 100);
  assert.deepEqual(made.asked.filter(([type]) => type === 'advance').map(([, payload]) => payload.days), [30, 30, 30, 10]);
  assert.deepEqual(heard, [[10, 20, 30], [40, 50, 60], [70, 80, 90], [100]], 'each line told once, as its stride ends');
  assert.equal(life.news.length, 10);
  assert.deepEqual(life.status, { date: 'day 100', people: 200 });
  // The calendar never asks it back.
  life.tick(Date.UTC(1550, 3, 1)); await settle();
  assert.equal(life.day, 100); assert.equal(life.wanted, 100);

  // Everything the model's keeper answers is open by name.
  assert.deepEqual(await life.record(), { kind: 'bootstrap', payload: { kind: 'bootstrap' } });
  assert.deepEqual(await life.people(0, { focus: [1, 2] }), { kind: 'actors', payload: { kind: 'actors', si: 0, focus: [1, 2] } });
  assert.deepEqual(await life.find('Lisboa', 5), { kind: 'ui', payload: { kind: 'ui', panel: 'advisor-find', name: 'Lisboa', n: 5 } });
  assert.deepEqual(await life.inspect('h0', true), { kind: 'ui', payload: { kind: 'ui', panel: 'advisor-inspect', code: 'h0', full: true } });
  assert.deepEqual(await life.command({ kind: 'tax', rate: 2 }), { type: 'command', payload: { kind: 'tax', rate: 2 } });
  assert.deepEqual(await life.board(), { hook: 'board', day: 100 });
  assert.deepEqual(await life.freeze(), { hook: 'freeze', day: 100 });

  life.close();
  assert.equal(made.closed, true); assert.equal(life.state, 'asleep');
});

test('a world that cannot be taken up fails quietly and says why', async () => {
  const none = createBoardLife({ baked: { port: 'lisbon', year: 1550, request: {} }, fetchImpl: fetched(), open: model().open });
  await none.start();
  assert.equal(none.state, 'failed'); assert.match(none.error, /no frozen world/);

  const elsewhere = createBoardLife({ baked: { ...baked(), port: 'nowhere' }, fetchImpl: fetched(), open: model().open });
  await elsewhere.start();
  assert.equal(elsewhere.state, 'failed');

  const short = createBoardLife({ baked: baked(), fetchImpl: fetched([1, 2, 3]), open: model().open });
  await short.start();
  assert.equal(short.state, 'failed'); assert.match(short.error, /3 bytes, not the 4/);

  const missing = createBoardLife({ baked: baked(), fetchImpl: fetched([], false), open: model().open });
  await missing.start();
  assert.equal(missing.state, 'failed'); assert.match(missing.error, /404/);

  const other = model({ program: 'another-program' }), strange = createBoardLife({ baked: baked(), fetchImpl: fetched(), open: other.open });
  await strange.start();
  assert.equal(strange.state, 'failed'); assert.match(strange.error, /another program/);
  assert.equal(other.made.closed, true, 'and the worker is not left running');
  strange.tick(Date.UTC(1551, 0, 1));
  assert.equal(strange.wanted, 0);

  // A day the model will not take stops the life, not the game.
  const stuck = model({ refuse: 'advance' }), states = [], halted = createBoardLife({ baked: baked(), fetchImpl: fetched(), open: stuck.open, onState: (state) => states.push(state) });
  await halted.start();
  halted.tick(Date.UTC(1550, 5, 11)); await settle();
  assert.deepEqual(states, ['waking', 'alive', 'failed']); assert.match(halted.error, /refused/);
});

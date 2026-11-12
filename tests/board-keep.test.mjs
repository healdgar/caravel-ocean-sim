// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// A founded world kept as the traveller left it: what the model has built since its founding is laid in when the
// port's land is next made, never before the traveller's eyes; and the model goes on from the world that was kept.
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { BOARD_KEEP_CAREER, boardAsKept, boardKeepKey, boardShape, forgetKeptBoards, keepBoard, keptBoard } from '../js/board-keep.js';
import { BOARD_KEEP_DAYS, createBoardLife } from '../js/board-life.js';

// As much of IndexedDB as the keeper uses: one database of one store, kept in a Map.
function fakeIndexedDB() {
  const stores = new Map(), names = { contains: (name) => stores.has(name) };
  const later = (fn) => setTimeout(fn, 0);
  return {
    stores,
    open() {
      const asked = { result: null, onupgradeneeded: null, onsuccess: null, onerror: null };
      later(() => {
        const fresh = stores.size === 0;
        asked.result = {
          objectStoreNames: names, close() {},
          createObjectStore(name) { stores.set(name, new Map()); },
          transaction(name) {
            const tx = { oncomplete: null, onerror: null, onabort: null }, rows = stores.get(name);
            later(() => tx.oncomplete?.());
            tx.objectStore = () => ({
              put(value, key) { rows.set(key, structuredClone(value)); return { result: key }; },
              get(key) { return { result: rows.has(key) ? structuredClone(rows.get(key)) : undefined }; },
              clear() { rows.clear(); return { result: undefined }; },
            });
            return tx;
          },
        };
        if (fresh) asked.onupgradeneeded?.();
        asked.onsuccess?.();
      });
      return asked;
    },
  };
}

const board = (more = {}) => ({ version: 3, span: 8192, year: 1550, day: 0, places: [], buildings: { count: 0, stand: [], form: [], kinds: [], quarter: [], state: [] }, works: { fences: [], wheels: [] }, ...more });
const baked = () => ({ port: 'lisbon', year: 1550, survey: [1, 2], request: { seed: 7 }, world: { bytes: 4, program: 'the-program', day: 0, year: 1550 }, board: board() });

test('a kept world is found again by its port, year and calendar, and forgotten with the career', async () => {
  const idb = fakeIndexedDB(), lived = board({ day: 240, buildings: { count: 1, stand: [1, 2, 0, 5, 5, 3], form: [0, 0, 0], kinds: [0, 1, 0, 0, 0, 0], quarter: [1], state: [1] } });
  assert.equal(await keptBoard('lisbon', 1550, { idb }), null);
  assert.equal(await keepBoard({ port: 'lisbon', year: 1550, program: 'the-program', day: 240, board: lived, world: Uint8Array.of(9, 8, 7) }, idb), true);
  const kept = await keptBoard('lisbon', 1550, { idb });
  assert.equal(kept.day, 240); assert.deepEqual([...kept.world], [9, 8, 7]); assert.equal(kept.shape, boardShape(lived)); assert.ok(kept.keptAt > 0); assert.equal(kept.clock, BOARD_KEEP_CAREER);
  assert.equal(await keptBoard('lisbon', 1650, { idb }), null, 'a world is kept for its year');
  assert.equal(boardKeepKey('lisbon', 1550), 'lisbon:1550:career'); assert.equal(boardKeepKey('lisbon', 1550, 'visit-a'), 'lisbon:1550:visit');
  assert.equal(await keepBoard({ port: 'lisbon', year: 1550, program: 'the-program', day: 250, board: null, world: Uint8Array.of(1) }, idb), false, 'nothing is kept without its board');
  // A visit (no career being played) keeps beside the career's world, never over it, and reads only its own.
  assert.equal(await keepBoard({ port: 'lisbon', year: 1550, program: 'the-program', day: 12, board: board({ day: 12 }), world: Uint8Array.of(4), clock: 'visit-a' }, idb), true);
  assert.equal((await keptBoard('lisbon', 1550, { idb })).day, 240, 'the career\'s world is as it was');
  assert.equal((await keptBoard('lisbon', 1550, { clock: 'visit-a', idb })).day, 12);
  assert.equal(await keptBoard('lisbon', 1550, { clock: 'visit-b', idb }), null, 'another visit\'s world is not this one\'s');
  assert.equal(await forgetKeptBoards(idb), true);
  assert.equal(await keptBoard('lisbon', 1550, { idb }), null); assert.equal(await keptBoard('lisbon', 1550, { clock: 'visit-a', idb }), null);
  // Where there is no store (a page that may keep nothing), nothing is kept and nothing fails.
  assert.equal(await keepBoard({ port: 'lisbon', year: 1550, program: 'p', day: 1, board: lived, world: Uint8Array.of(1) }), false);
  assert.equal(await keptBoard('lisbon', 1550), null);
});

// The model's day 240 of a world founded in the spring of 1550 falls in November; day 0 is the first of March.
const epoch = Date.UTC(1550, 2, 1), dayMs = 365 / 360 * 86400000, onDay = (day) => epoch + (day + 0.5) * dayMs;

test('a port\'s land is laid from the board that was kept, if this program saved it, it is of the founding one\'s shape and its day is not after today', () => {
  const founded = baked(), lived = board({ day: 240 });
  const kept = { port: 'lisbon', year: 1550, program: 'the-program', day: 240, board: lived, shape: boardShape(lived), keptAt: 5 };
  const laid = boardAsKept(founded, kept, onDay(240));
  assert.equal(laid.board, lived); assert.deepEqual(laid.lived, { day: 240, days: 240, keptAt: 5 });
  assert.equal(laid.survey, founded.survey); assert.equal(laid.world, founded.world); assert.equal(laid.request, founded.request);
  assert.equal(founded.board.day, 0, 'the founded record is left as it was');
  assert.equal(boardAsKept(founded, kept, onDay(900)).board, lived, 'come back to years after');
  assert.equal(boardAsKept(founded, kept, onDay(240 - BOARD_KEEP_DAYS)).board, lived, 'a keeping may run a few days ahead of the save');
  // None kept, or one that cannot be laid here: the land is laid as it was founded.
  assert.equal(boardAsKept(founded, null, onDay(240)), founded);
  assert.equal(boardAsKept(founded, kept), founded, 'with no date to hold it to');
  assert.equal(boardAsKept(founded, kept, onDay(240 - BOARD_KEEP_DAYS - 2)), founded, 'a world from after today is another voyage\'s');
  assert.equal(boardAsKept(founded, kept, onDay(0)), founded, 'a voyage begun again');
  assert.equal(boardAsKept(founded, { ...kept, program: 'another-program' }, onDay(240)), founded, 'saved by another program');
  assert.equal(boardAsKept(founded, { ...kept, port: 'porto' }, onDay(240)), founded, 'of another port');
  assert.equal(boardAsKept(founded, { ...kept, shape: boardShape({ ...lived, works: { fences: [] } }) }, onDay(240)), founded, 'of another shape');
  assert.equal(boardAsKept(founded, { ...kept, board: { ...lived, span: 4096 } }, onDay(240)), founded, 'of another span');
  assert.equal(boardAsKept(founded, { ...kept, day: -1 }, onDay(240)), founded, 'from before the founding');
  assert.equal(boardAsKept(null, kept, onDay(240)), null);
});

// A model that counts its days, gives its board and its frozen self when asked, and remembers what it was opened on.
function model(day = 0) {
  const made = { day, opened: null };
  const open = async (request, options) => {
    made.opened = [...options.world];
    made.day = options.world[0] === 77 ? options.world[1] : day;
    return {
      program: 'the-program', on: {}, ready: Promise.resolve({ day: made.day }),
      async request(type, payload) {
        if (type === 'advance') { made.day += payload.days; return { day: made.day }; }
        if (type === 'view' && payload.panel === 'advisor-annals') return [];
        return { day: made.day };
      },
      hook: async (name) => name === 'board' ? board({ day: made.day }) : name === 'freeze' ? Uint8Array.of(77, made.day) : null,
      close() {},
    };
  };
  return { made, open };
}
const settle = async () => { for (let k = 0; k < 6; k++) await new Promise((resolve) => setTimeout(resolve, 0)); };
const fetched = async () => ({ ok: true, status: 200, arrayBuffer: async () => Uint8Array.of(1, 2, 3, 4).buffer });

test('the living world is kept as it goes, and taken up again from where it was kept', async () => {
  const idb = fakeIndexedDB(), founded = baked(), first = model();
  const options = (m) => ({ baked: founded, fetchImpl: fetched, open: m.open, stride: 6, kept: () => keptBoard('lisbon', 1550, { idb }), keep: (record) => keepBoard(record, idb) });
  const life = createBoardLife(options(first));
  await life.start();
  assert.equal(life.state, 'alive'); assert.deepEqual(first.made.opened, [1, 2, 3, 4], 'none kept: the founding world'); assert.equal(life.resumed, null);
  // Days pass; once enough have, the world is kept without being asked.
  for (let turn = 0; turn < 4; turn++) { life.tick(epoch + (BOARD_KEEP_DAYS + 3) * dayMs); await settle(); }
  assert.ok(life.day >= BOARD_KEEP_DAYS, `lived ${life.day} days`);
  await settle();
  const kept = await keptBoard('lisbon', 1550, { idb });
  assert.ok(kept && kept.day >= BOARD_KEEP_DAYS && kept.day <= life.day, `kept at day ${kept?.day}`);
  assert.equal(kept.board.day, kept.day); assert.deepEqual([...kept.world], [77, kept.day]); assert.equal(kept.program, 'the-program');
  // Asked, it is kept as it stands now.
  life.tick(epoch + 40 * dayMs); await settle(); life.tick(epoch + 40 * dayMs); await settle();
  assert.equal(await life.keep(), true);
  assert.equal((await keptBoard('lisbon', 1550, { idb })).day, life.day);
  const left = life.day;
  life.close();
  // The next time the port is come to: the land from the kept board, the model from the kept world.
  assert.equal(boardAsKept(founded, await keptBoard('lisbon', 1550, { idb }), onDay(left)).board.day, left);
  const second = model(), again = createBoardLife(options(second));
  await again.start();
  assert.equal(again.state, 'alive'); assert.deepEqual(second.made.opened, [77, left]); assert.equal(again.day, left); assert.equal(again.resumed, left);
  // A world kept by another program is left aside for the founding one.
  await keepBoard({ port: 'lisbon', year: 1550, program: 'another-program', day: 900, board: board({ day: 900 }), world: Uint8Array.of(77, 900 % 256) }, idb);
  const third = model(), afresh = createBoardLife(options(third));
  await afresh.start();
  assert.deepEqual(third.made.opened, [1, 2, 3, 4]); assert.equal(afresh.resumed, null);
});

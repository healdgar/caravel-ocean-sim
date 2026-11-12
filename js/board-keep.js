// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// A founded world as the traveller left it. The model lives on while a port is in sight and while the ship is away
// (js/board-life.js); what it builds, burns and rebuilds in that time is not altered before the traveller's eyes.
// Instead the world is kept here as it stands: the model's own save of everything, and its board as this game reads
// it. When the port's land is next laid (on return, or the next time the game is opened) it is laid from the board
// that was kept, with the new roads, houses, mills, ruins and works in hand the model has made since; and the model
// is taken up again from the world that was kept, not from its founding.
//
// A kept world belongs to a calendar: the career's, or, where no career is being played (a stage link, a new voyage
// beside a save), that visit's alone. The career's is never written by a visit, and a visit reads only what it kept
// itself. Neither is taken up on a date earlier than its own day: a world from after today is another voyage's.
import { BOARD_KEEP_DAYS, boardDayOf, boardEpochYear } from './board-life.js';

const BOARD_KEEP_DB = 'waterworld-boards', BOARD_KEEP_STORE = 'kept';
export const BOARD_KEEP_CAREER = 'career';

export const boardKeepKey = (port, year, clock = BOARD_KEEP_CAREER) => `${port}:${year}:${clock === BOARD_KEEP_CAREER ? 'career' : 'visit'}`;
// What makes a kept board one this game can still lay: the parts of its record, by name.
export const boardShape = (board) => board ? `${board.version}:${Object.keys(board).sort().join(',')}:${Object.keys(board.buildings ?? {}).sort().join(',')}:${Object.keys(board.works ?? {}).sort().join(',')}` : '';

// The record a port's land is laid from on the game's date `dateMs`: its baked record as founded, or, where a world
// was kept that this program saved, whose board is of the shape the founding one has and whose day is not after that
// date (but for the days a keeping may run ahead of a save), the same with the kept board in place of the founded.
export function boardAsKept(baked, kept, dateMs = null) {
  if (!baked?.board || !kept?.board || !baked.world || !Number.isFinite(dateMs)) return baked ?? null;
  if (kept.port !== baked.port || kept.year !== baked.year || kept.program !== baked.world.program || kept.shape !== boardShape(baked.board)) return baked;
  if (kept.board.span !== baked.board.span || !(kept.day >= baked.world.day)) return baked;
  if (kept.day > boardDayOf(dateMs, boardEpochYear(baked.world)) + BOARD_KEEP_DAYS) return baked;
  return { ...baked, board: kept.board, lived: { day: kept.day, days: kept.day - baked.world.day, keptAt: kept.keptAt ?? null } };
}

function boardKeepOpen(idb) {
  return new Promise((resolve, reject) => {
    const asked = idb.open(BOARD_KEEP_DB, 1);
    asked.onupgradeneeded = () => { if (!asked.result.objectStoreNames.contains(BOARD_KEEP_STORE)) asked.result.createObjectStore(BOARD_KEEP_STORE); };
    asked.onsuccess = () => resolve(asked.result);
    asked.onerror = () => reject(asked.error);
    asked.onblocked = () => reject(new Error('The kept boards are held open elsewhere'));
  });
}
async function boardKeepDo(idb, mode, work) {
  const db = await boardKeepOpen(idb);
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(BOARD_KEEP_STORE, mode), asked = work(tx.objectStore(BOARD_KEEP_STORE));
      tx.oncomplete = () => resolve(asked?.result ?? null);
      tx.onerror = tx.onabort = () => reject(tx.error ?? new Error('The kept board could not be reached'));
    });
  } finally { db.close(); }
}
const boardKeepStore = (idb) => idb ?? (typeof indexedDB === 'undefined' ? null : indexedDB);

// Keep a world: `{port, year, program, day, board, world, clock}` with `world` the bytes the model froze and `clock`
// the calendar it belongs to (the career's if none is named). Resolves true when kept, false where nothing can be
// kept (no store, or it refused).
export async function keepBoard(record, idb = null) {
  const store = boardKeepStore(idb);
  if (!store || !record?.board || !record.world) return false;
  const clock = record.clock ?? BOARD_KEEP_CAREER;
  try {
    await boardKeepDo(store, 'readwrite', (kept) => kept.put({ ...record, clock, shape: boardShape(record.board), keptAt: Date.now() }, boardKeepKey(record.port, record.year, clock)));
    return true;
  } catch (fault) { console.warn('The board was not kept:', fault); return false; }
}
// The world kept for a port and year by the calendar `clock` (the career's if none is named), or null.
export async function keptBoard(port, year, { clock = BOARD_KEEP_CAREER, idb = null } = {}) {
  const store = boardKeepStore(idb);
  if (!store) return null;
  try {
    const kept = await boardKeepDo(store, 'readonly', (rows) => rows.get(boardKeepKey(port, year, clock)));
    return kept && (kept.clock ?? BOARD_KEEP_CAREER) === clock ? kept : null;
  } catch { return null; }
}
// Forget every kept world: a new career begins from each port's founding.
export async function forgetKeptBoards(idb = null) {
  const store = boardKeepStore(idb);
  if (!store) return false;
  try { await boardKeepDo(store, 'readwrite', (kept) => kept.clear()); return true; } catch { return false; }
}

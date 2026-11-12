// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The founded world, alive in play. A port's country is Castle and Commons' whole model: its households, markets,
// great houses, church, armies and annals. The game takes up the world frozen at its founding (the model's own
// save of everything, assets/boards/*.world) in a worker, and lets it live a day for each day of this game's own
// calendar, at whatever pace the game keeps: at anchor, under sail, or at warp. What happens there is told as it
// happens, and every view and every command the model has is open to the game through `request`.
import { bakedWorldAsset } from './board-model.js';
import { openBoardWorker } from './board-worker.js';

// The model's year: four seasons of ninety days, spring first.
export const BOARD_YEAR_DAYS = 360;
// The model's day for a date of this game's calendar. Its year begins with spring, on the first of March, and its
// 360 days are spread over that year's true length; `epochYear` is the year its day 0 began.
export function boardDayOf(dateMs, epochYear) {
  const year = new Date(dateMs).getUTCFullYear(), march = Date.UTC(year, 2, 1), spring = dateMs >= march ? year : year - 1;
  const from = Date.UTC(spring, 2, 1), to = Date.UTC(spring + 1, 2, 1);
  return Math.max(0, Math.floor((spring - epochYear + (dateMs - from) / (to - from)) * BOARD_YEAR_DAYS));
}
// The year a frozen world's day 0 began, from the day and year it was frozen at.
export function boardEpochYear(world) { return world.year - Math.floor(world.day / BOARD_YEAR_DAYS); }

const BOARD_NEWS_KEPT = 2000;

// `baked` is a port's baked record (its board, the request that founded it, and what its frozen world is).
// `start()` takes the world up; `tick(dateMs)` is called as the game's date moves and lives the days it is behind,
// `stride` at a time, so a command or a question is never kept waiting long; `onNews(lines)` hears the annals as
// they are written ({day, date, cat, text}); `onState(state)` each change of state. Asleep until started, waking
// while the program and world are fetched and taken up, then alive; failed (with `error`) if they cannot be, in
// which case the board stands as it was founded and nothing else is lost.
export function createBoardLife({ baked, fetchImpl = fetch, open = openBoardWorker, onNews = null, onState = null, stride = 6 }) {
  const world = baked?.world ?? null, asset = world ? bakedWorldAsset(baked.port, baked.year) : null;
  let model = null, busy = false, told = world?.day ?? 0;
  const life = {
    state: 'asleep', error: null, port: baked?.port ?? null, year: baked?.year ?? null,
    // The model's day now, the day the game's calendar asks for, and how many days it has lived here.
    day: world?.day ?? 0, wanted: world?.day ?? 0, lived: 0,
    // The model's own word on the realm: date, monarch, treasury, people, war, feuds, plague, weather.
    status: null, news: [],
    start, tick, close,
    // Anything the model's keeper answers: 'view' {kind: bootstrap | landscape | summary | inspect | ui | overlay |
    // actors | household | plan-quote | storage-preview}, 'command', 'watch', 'advance', 'speed', 'pause', 'save'.
    request: (type, payload) => need().then(() => model.request(type, payload)),
    view: (kind, payload = {}) => life.request('view', { kind, ...payload }),
    command: (command) => life.request('command', command),
    // The model's panels: 'advisor-state', 'advisor-annals', 'advisor-find', 'advisor-inspect', 'advisor-panel',
    // 'advisor-persona', 'annals', 'crown', 'petitions', 'house-panel', 'reference', 'info'.
    panel: (panel, payload = {}) => life.view('ui', { panel, ...payload }),
    find: (name, n = 60) => life.panel('advisor-find', { name, n }),
    inspect: (code, full = false) => life.panel('advisor-inspect', { code, full }),
    annals: (payload = {}) => life.panel('advisor-annals', payload),
    // The whole display record of the world as it stands: every place, building, field, road, army, ship, caravan,
    // envoy, abbey and project the model would draw.
    record: () => life.view('bootstrap'),
    // The people of a place as they walk it now.
    people: (place, payload = {}) => life.view('actors', { si: place, ...payload }),
    // Who is about in a place today and the way each takes, by the model's own plan of its townsfolk: the `most`
    // who live nearest `focus` (metres on the board), and `others` more of its grown people by name.
    folk: (place, options = {}) => need().then(() => model.hook('folk', place, options)),
    // Anyone, by their number: the model's whole card of them, and what it links to.
    person: (id, full = true) => life.inspect('p' + id, full),
    // This game's own report of the board (js/old-world-board.js stands it), and the whole world frozen as it is now.
    board: () => need().then(() => model.hook('board')),
    freeze: () => need().then(() => model.hook('freeze')),
  };
  const state = (next, error = null) => { life.state = next; life.error = error; try { onState?.(next, error); } catch (fault) { console.error(fault); } };
  const need = () => life.state === 'alive' ? Promise.resolve() : Promise.reject(new Error(`The board is ${life.state}`));

  async function start() {
    if (life.state !== 'asleep') return life;
    if (!world || !asset) { state('failed', 'This port has no frozen world'); return life; }
    state('waking');
    try {
      const response = await fetchImpl(asset);
      if (!response.ok) throw new Error(`The frozen world could not be fetched: ${response.status}`);
      const bytes = new Uint8Array(await response.arrayBuffer());
      if (bytes.length !== world.bytes) throw new Error(`The frozen world is ${bytes.length} bytes, not the ${world.bytes} its board was founded with`);
      model = await open(baked.request, { world: bytes, fetchImpl });
      if (model.program !== world.program) throw new Error('The frozen world was saved by another program than the one here');
      model.on.fault = (fault) => state('failed', String(fault?.error || fault));
      const summary = await model.ready;
      life.day = summary.day; told = summary.day;
      life.status = await model.request('view', { kind: 'ui', panel: 'advisor-state' });
      state('alive');
    } catch (error) { model?.close(); model = null; state('failed', String(error?.message || error)); }
    return life;
  }

  // Live the days the game's calendar is ahead by, a stride at a time. Returns at once; the days pass in the worker.
  function tick(dateMs) {
    if (life.state !== 'alive') return;
    life.wanted = Math.max(life.wanted, boardDayOf(dateMs, boardEpochYear(world)));
    if (busy || life.wanted <= life.day) return;
    busy = true;
    model.request('advance', { days: Math.min(stride, life.wanted - life.day) }).then(async (reply) => {
      life.lived += reply.day - life.day; life.day = reply.day;
      const lines = await model.request('view', { kind: 'ui', panel: 'advisor-annals', from: told + 1, n: 400 });
      told = life.day;
      life.status = await model.request('view', { kind: 'ui', panel: 'advisor-state' });
      if (lines.length) {
        life.news.push(...lines);
        if (life.news.length > BOARD_NEWS_KEPT) life.news.splice(0, life.news.length - BOARD_NEWS_KEPT);
        try { onNews?.(lines); } catch (fault) { console.error(fault); }
      }
    }).catch((error) => { if (life.state === 'alive') state('failed', String(error?.message || error)); }).finally(() => { busy = false; });
  }

  function close() { model?.close(); model = null; if (life.state !== 'failed') state('asleep'); }
  return life;
}

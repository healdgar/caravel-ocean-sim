// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// What the dungeon master reports of its use, and what it cannot. It reports counts, timings, sizes and the game's
// own figures (the date, the port, the realm's people and treasury, the captain's worth), under the player's Caiioo
// account. It does not report what is said: no word of the player's, the storyteller's or a character's, no page of
// the lore, no brief, no search, no name of a file or folder. That is not a promise kept by care at each call but by
// the shape below: an event is rebuilt from nothing, field by field, and a field that is not listed for its kind, or
// is not a number, a yes or no, or one short listed word, never leaves this module.

// Kinds of event, and for each the fields it may carry: numbers, flags (yes or no) and words (short names from the
// game or the program, never sentences).
export const TELEMETRY_SHAPE = Object.freeze({
  // A session begins: which agent app and which build of this server.
  session: { words: ['client', 'clientVersion', 'server', 'platform', 'node', 'protocol'], numbers: [], flags: [] },
  // One tool call: how long it took, whether it failed and in what way, and how many characters went in and came
  // out (sizes only).
  tool: { words: ['tool', 'error'], numbers: ['ms', 'in', 'out'], flags: ['failed'] },
  prompt: { words: ['prompt'], numbers: [], flags: [] },
  // The game joined or left.
  paired: { words: [], numbers: [], flags: [] },
  unpaired: { words: [], numbers: [], flags: [] },
  // What the player did in the game since last asked, by kind: so many words spoken to someone, so many landfalls.
  played: { words: ['what'], numbers: ['n'], flags: [] },
  // The game's own figures at a moment.
  game: { words: ['date', 'realm', 'port', 'ship', 'title', 'mateRole'], numbers: ['day', 'year', 'people', 'treasury', 'places', 'worth', 'coin', 'cargo', 'daysOut', 'leagues', 'lat', 'lon', 'mate', 'mateAge', 'portPeople'], flags: ['war', 'plague', 'ashore', 'mateChosen'] },
  // How much lore is kept (never what it says).
  lore: { words: ['kept'], numbers: ['pages', 'people', 'places', 'entries'], flags: ['captainWritten', 'mateChosen'] },
  // A session ends.
  end: { words: [], numbers: ['seconds', 'calls', 'errors', 'briefs', 'persons'], flags: [] },
});
// The ways a tool can fail, as far as is reported: the message itself may hold a path or a name, so it stays here.
export const TELEMETRY_ERRORS = Object.freeze(['account', 'unpaired', 'silent', 'lore', 'game', 'other']);
// A word: a name of the game's or the program's. Letters, digits and a little punctuation, forty-eight at most.
const WORD = /^[\p{L}\p{N}][\p{L}\p{N} .,:'+/()_-]{0,47}$/u;
export const TELEMETRY_BATCH = 100, TELEMETRY_HELD = 2000;

// An event as it may leave: its kind, when, and the listed fields that are what they should be. null for a kind
// that is not listed.
export function telemetryEvent(kind, fields = {}, at = new Date()) {
  const shape = TELEMETRY_SHAPE[kind];
  if (!shape) return null;
  const when = at instanceof Date ? at : new Date(at);
  const out = { k: kind, at: (Number.isFinite(when.getTime()) ? when : new Date()).toISOString() };
  for (const key of shape.numbers) { const v = fields[key]; if (typeof v === 'number' && Number.isFinite(v)) out[key] = Math.round(v * 1000) / 1000; }
  for (const key of shape.flags) { const v = fields[key]; if (typeof v === 'boolean') out[key] = v; }
  for (const key of shape.words) {
    const v = fields[key];
    if (typeof v !== 'string' || !WORD.test(v)) continue;
    if (key === 'error' && !TELEMETRY_ERRORS.includes(v)) continue;
    out[key] = v;
  }
  return out;
}

// Which way a failure went, from what it said.
export function telemetryError(error) {
  const said = String(error?.message || error || '');
  if (/Caiioo|sign in|signed in/i.test(said)) return 'account';
  if (/not paired/i.test(said)) return 'unpaired';
  if (/did not answer/i.test(said)) return 'silent';
  if (/lore|page|Markdown|folder/i.test(said)) return 'lore';
  if (/unknown tool/i.test(said)) return 'other';
  return 'game';
}

// The game's figures out of what the page answers to `situation`.
export function telemetryGame(now = {}) {
  const n = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : undefined), w = (v) => (typeof v === 'string' ? v.slice(0, 48) : undefined);
  const cargo = Array.isArray(now.captain?.cargo) ? now.captain.cargo.reduce((sum, one) => sum + (Number(one?.units) || 0), 0) : n(now.captain?.cargo);
  return {
    date: w(now.date?.text), day: n(now.date?.day), year: n(now.date?.year),
    realm: w(now.realm?.name), people: n(now.realm?.people), treasury: n(now.realm?.treasury), places: n(now.realm?.places), war: typeof now.realm?.war === 'boolean' ? now.realm.war : undefined, plague: typeof now.realm?.plague === 'boolean' ? now.realm.plague : undefined,
    port: w(now.where?.name), portPeople: n(now.where?.people), ashore: typeof now.where?.ashore === 'boolean' ? now.where.ashore : undefined, lat: n(now.where?.lat), lon: n(now.where?.lon),
    ship: w(now.ship?.class), title: w(now.captain?.title), worth: n(now.captain?.worth), coin: n(now.captain?.coin), cargo,
    daysOut: n(now.voyage?.daysOut), leagues: n(now.voyage?.leagues),
    mateChosen: !!now.mate, mate: n(now.mate?.id), mateAge: n(now.mate?.age), mateRole: w(now.mate?.role),
  };
}

/**
 * The reporter. `send(events)` posts a batch under the player's account and resolves true when it was taken;
 * until it is, events wait (the oldest are let go past TELEMETRY_HELD). `spool` may give {load(), save(events)} to
 * keep what was not sent from one session to the next.
 */
export function createTelemetry({ send, spool = null, clock = () => new Date(), every = 60000 } = {}) {
  let held = [];
  try { held = (spool?.load?.() ?? []).map((one) => telemetryEvent(one?.k, one ?? {}, one?.at ?? clock())).filter(Boolean); } catch { held = []; }
  const began = clock().getTime(), tally = { calls: 0, errors: 0, briefs: 0, persons: new Set() };
  let sending = null, lastGame = 0, timer = null;
  function note(kind, fields) {
    const event = telemetryEvent(kind, fields, clock());
    if (!event) return null;
    held.push(event);
    if (held.length > TELEMETRY_HELD) held.splice(0, held.length - TELEMETRY_HELD);
    if (held.length >= TELEMETRY_BATCH) flush();
    return event;
  }
  // One tool call. `sizes` are character counts of what went in and came out.
  function tool(name, ms, error = null, sizes = {}) {
    tally.calls++; if (error) tally.errors++;
    return note('tool', { tool: name, ms, failed: !!error, error: error ? telemetryError(error) : undefined, in: sizes.in, out: sizes.out });
  }
  function briefed(person) { tally.briefs++; if (Number.isFinite(Number(person))) tally.persons.add(Number(person)); }
  // The game's figures, at most once in five minutes unless `always`.
  function game(now, always = false) {
    const at = clock().getTime();
    if (!always && at - lastGame < 300000) return null;
    lastGame = at;
    return note('game', telemetryGame(now));
  }
  // What the player did, by kind.
  function played(events = []) {
    const by = new Map();
    for (const one of events) { const what = typeof one?.kind === 'string' ? one.kind : 'other'; by.set(what, (by.get(what) ?? 0) + 1); }
    for (const [what, n] of by) note('played', { what, n });
  }
  async function flush() {
    if (sending || !held.length || !send) return sending ?? false;
    const batch = held.slice(0, TELEMETRY_BATCH);
    sending = (async () => {
      let taken = false;
      try { taken = (await send(batch)) === true; } catch { taken = false; }
      if (taken) held = held.filter((one) => !batch.includes(one));
      sending = null;
      return taken;
    })();
    return sending;
  }
  const summary = () => ({ seconds: Math.round((clock().getTime() - began) / 1000), calls: tally.calls, errors: tally.errors, briefs: tally.briefs, persons: tally.persons.size, waiting: held.length });
  // The session's end: its sum is noted, what can be sent is, and what cannot waits in the spool.
  async function end() {
    if (timer) clearInterval(timer);
    note('end', summary());
    for (let tries = 0; held.length && tries < 1 + Math.ceil(TELEMETRY_HELD / TELEMETRY_BATCH); tries++) if (!(await flush())) break;
    try { spool?.save?.(held); } catch { /* what cannot be kept is lost, and nothing else */ }
  }
  if (every > 0) { timer = setInterval(() => { flush(); }, every); timer.unref?.(); }
  return { note, tool, briefed, game, played, flush, summary, end, get waiting() { return held.length; }, peek: () => held.map((one) => ({ ...one })) };
}

// What is reported, in words, for the player who asks.
export const TELEMETRY_STATEMENT = 'Reported under your Caiioo account: which tools the storyteller used and how long each took, whether they failed, how many characters went in and out, how much lore is kept (counts only), and the game\'s own figures (date, port, realm, the captain\'s worth, the mate\'s number and calling). Never reported: anything said by you, the storyteller or a character, any page of the lore, any brief, any search, or the name of any file or folder.';

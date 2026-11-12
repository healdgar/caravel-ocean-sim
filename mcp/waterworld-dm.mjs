#!/usr/bin/env node
// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// waterworld-dm: a dungeon master for the game of Waterworld the player has open in a browser on this machine. It is
// an MCP server over stdio with no dependencies, for any agent app:
//   claude mcp add waterworld-dm -- node /path/to/waterworld/mcp/waterworld-dm.mjs
// The agent it instructs is the storyteller, and in the story the captain's first mate, who goes everywhere with
// them. It sees the game's whole model of the country (every person, town, house, price and annal), keeps the lore
// of this game in a folder the player chooses (mcp/dm-lore.mjs), and has each person the captain speaks with played
// by a subagent that is told only that person (mcp/dm-text.mjs).
// It works only for a player signed in with their Caiioo account (mcp/dm-account.mjs), and reports its use under
// that account: counts, timings and the game's figures, never what is said (mcp/dm-telemetry.mjs).
// The game pairs with it from its Storyteller dialog, with a code this server gives in its answers; they speak over
// a WebSocket on 127.0.0.1 only (WATERWORLD_DM_PORT to change the port, default 7467; ten are tried in turn).
import http from 'node:http';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createAccount, signInPage, trustedBase } from './dm-account.mjs';
import { createLore } from './dm-lore.mjs';
import { createTelemetry, TELEMETRY_STATEMENT } from './dm-telemetry.mjs';
import { BRIEF_USE, DM_INSTRUCTIONS, characterBrief, matePage } from './dm-text.mjs';

const VERSION = '0.1.0';
const PORT = +(process.env.WATERWORLD_DM_PORT || 7467), PORTS = 10;
const BASE = (process.env.WATERWORLD_DM_CODE || crypto.randomBytes(12).toString('base64').replace(/[^A-Z]/gi, '').toUpperCase()).slice(0, 5).padEnd(5, 'X');
// Five letters, then which of the ten ports this server took: the game goes straight to it.
let CODE = BASE + '0';
const log = (...words) => process.stderr.write('[waterworld-dm] ' + words.join(' ') + '\n');
if (process.argv.includes('--version')) { process.stdout.write(VERSION + '\n'); process.exit(0); }
const lore = createLore();

/* ---- the player's Caiioo account, and what is reported under it ---- */
const account = createAccount({ agent: 'waterworld-dm/' + VERSION });
// Where use is reported: Waterworld's own endpoint, which checks the session with Caiioo and keeps none of it.
const STATS = trustedBase(process.env.WATERWORLD_DM_STATS, 'https://sixcailloux.com/waterworld/api/dm');
const SESSION = crypto.randomBytes(9).toString('base64url');
const SPOOL = process.env.WATERWORLD_DM_SPOOL || path.join(os.homedir(), '.config', 'waterworld-dm', 'unsent.json');
const telemetry = createTelemetry({
  async send(events) {
    const bearer = account.bearer();
    if (!bearer) return false;
    const response = await fetch(STATS + '/telemetry', { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + bearer, 'user-agent': 'waterworld-dm/' + VERSION }, body: JSON.stringify({ v: 1, session: SESSION, events }), signal: AbortSignal.timeout(10000) });
    return response.ok;
  },
  spool: {
    load: () => { try { return JSON.parse(fs.readFileSync(SPOOL, 'utf8')); } catch { return []; } },
    save: (events) => { if (events.length) { fs.mkdirSync(path.dirname(SPOOL), { recursive: true, mode: 0o700 }); fs.writeFileSync(SPOOL, JSON.stringify(events), { mode: 0o600 }); } else fs.rmSync(SPOOL, { force: true }); },
  },
});
// The key of this session's sign-in page: no other page in the player's browser can speak to it.
const SIGN_KEY = crypto.randomBytes(18).toString('base64url');
const sameKey = (given) => { const a = Buffer.from(String(given ?? '')), b = Buffer.from(SIGN_KEY); return a.length === b.length && crypto.timingSafeEqual(a, b); };

/* ---- the game: one WebSocket on this machine, opened by the page when the player enters the code ---- */
let sock = null, nextId = 1;
const waiting = new Map();
// What the player has done in the game since the storyteller last asked: whom they spoke to and what they said,
// landfalls, the realm's news. Kept in order; the oldest are let go past EVENTS_KEPT.
const EVENTS_KEPT = 200, events = [];
let listener = null;
function frame(text) {
  const body = Buffer.from(text), n = body.length;
  const head = n < 126 ? Buffer.from([0x81, n]) : n < 65536 ? Buffer.from([0x81, 126, n >> 8, n & 255]) : (() => { const b = Buffer.alloc(10); b[0] = 0x81; b[1] = 127; b.writeBigUInt64BE(BigInt(n), 2); return b; })();
  return Buffer.concat([head, body]);
}
function heard(message) {
  if (message.event) {
    events.push({ at: new Date().toISOString(), ...message.event });
    if (events.length > EVENTS_KEPT) events.splice(0, events.length - EVENTS_KEPT);
    listener?.();
    return;
  }
  const wait = waiting.get(message.id);
  if (wait) { waiting.delete(message.id); wait(message); }
}
function attach(socket) {
  let held = Buffer.alloc(0), parts = [];
  socket.on('data', (chunk) => {
    held = Buffer.concat([held, chunk]);
    for (;;) {
      if (held.length < 2) return;
      const fin = held[0] & 0x80, op = held[0] & 15, masked = held[1] & 0x80;
      let length = held[1] & 127, at = 2;
      if (length === 126) { if (held.length < 4) return; length = held.readUInt16BE(2); at = 4; }
      else if (length === 127) { if (held.length < 10) return; length = Number(held.readBigUInt64BE(2)); at = 10; }
      const key = masked ? held.subarray(at, at + 4) : null; if (masked) at += 4;
      if (held.length < at + length) return;
      const data = Buffer.from(held.subarray(at, at + length)); held = held.subarray(at + length);
      if (key) for (let i = 0; i < data.length; i++) data[i] ^= key[i & 3];
      if (op === 8) { socket.end(); return; }
      if (op === 9) { socket.write(Buffer.concat([Buffer.from([0x8a, data.length]), data])); continue; }
      if (op === 1 || op === 0) {
        parts.push(data);
        if (fin) { const text = Buffer.concat(parts).toString(); parts = []; try { heard(JSON.parse(text)); } catch { /* not a message of the game's */ } }
      }
    }
  });
  socket.on('close', () => { if (sock === socket) { sock = null; telemetry.note('unpaired'); log('the game closed the connection'); } });
  socket.on('error', () => { });
}
// Besides the game's socket, this machine is served one page: where the player types the code Caiioo shows them.
const server = http.createServer(async (request, response) => {
  const send = (status, type, body) => { response.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff', 'referrer-policy': 'no-referrer', 'content-security-policy': "default-src 'none'; style-src 'unsafe-inline'; script-src 'unsafe-inline'; connect-src 'self'; form-action 'none'; frame-ancestors 'none'; base-uri 'none'" }); response.end(body); };
  const plain = 'text/plain; charset=utf-8', json = 'application/json; charset=utf-8';
  try {
    const url = new URL(request.url, 'http://x'), host = String(request.headers.host || '');
    // Asked for by its own address only: a page elsewhere that points a name of its own at this machine is not served.
    const here = host === `127.0.0.1:${port}` || host === `localhost:${port}`;
    if (here && url.pathname === '/sign-in' && request.method === 'GET') {
      if (!sameKey(url.searchParams.get('k'))) return send(403, plain, 'This link is not for this session of the storyteller. Ask it for a new one.');
      const who = account.who();
      let link = account.link;
      if (!who.signedIn && (!link || link.state !== 'pending' && link.state !== 'awaiting_code')) link = await account.begin();
      return send(200, 'text/html; charset=utf-8', signInPage({ key: SIGN_KEY, approve: link?.approve ?? account.relay, name: who.signedIn ? who.name : '' }));
    }
    if (here && url.pathname === '/sign-in/code' && request.method === 'POST') {
      const origin = request.headers.origin;
      if (origin && origin !== `http://${host}`) return send(403, json, JSON.stringify({ error: 'Not from the storyteller\'s own page.' }));
      if (!/^application\/json\b/i.test(String(request.headers['content-type'] || ''))) return send(415, json, JSON.stringify({ error: 'Not understood.' }));
      let body = '';
      for await (const chunk of request) { body += chunk; if (body.length > 2048) return send(413, json, JSON.stringify({ error: 'Too long.' })); }
      let asked; try { asked = JSON.parse(body); } catch { asked = null; }
      if (!asked || !sameKey(asked.k)) return send(403, json, JSON.stringify({ error: 'This page is not for this session of the storyteller. Ask it for a new link.' }));
      if (!/^\d{6}$/.test(String(asked.code ?? ''))) return send(400, json, JSON.stringify({ error: 'The code is six digits.' }));
      return send(200, json, JSON.stringify(await account.poll(String(asked.code))));
    }
    send(200, plain, 'The Waterworld dungeon master. Pair from the game\'s Storyteller dialog.');
  } catch (error) { send(502, plain, String(error?.message || error)); }
});
// Who may open the game's socket: the game's own pages (the published one, or one served from this machine), or a
// program that names no page at all. Any other page in the player's browser is refused before its code is looked at.
const GAME_ORIGINS = new Set(['https://sixcailloux.com', 'https://www.sixcailloux.com', ...String(process.env.WATERWORLD_DM_ORIGINS || '').split(',').map((one) => one.trim()).filter(Boolean)]);
const gameOrigin = (origin) => !origin || GAME_ORIGINS.has(origin) || /^http:\/\/(127\.0\.0\.1|localhost|\[::1\])(:\d{1,5})?$/.test(origin);
// Wrong codes are counted: after WRONG_MOST of them in a minute no code is heard for a minute, so the code cannot be had by trying them all.
const WRONG_MOST = 5, WRONG_SPAN_MS = 60000;
const wrong = [];
let deafUntil = 0;
const closing = (code, why) => { const text = Buffer.from(why); return Buffer.concat([Buffer.from([0x88, 2 + text.length, code >> 8, code & 255]), text]); };
server.on('upgrade', (request, socket) => {
  const url = new URL(request.url, 'http://x'), key = request.headers['sec-websocket-key'], host = String(request.headers.host || '');
  if (!key) { socket.end('HTTP/1.1 400 Bad Request\r\n\r\n'); return; }
  if (host !== `127.0.0.1:${port}` && host !== `localhost:${port}` || !gameOrigin(request.headers.origin)) { socket.end('HTTP/1.1 403 Forbidden\r\n\r\n'); return; }
  const accept = crypto.createHash('sha1').update(key + '258EAFA5-E914-47DA-95CA-C5AB0DC85B11').digest('base64');
  socket.write('HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ' + accept + '\r\n\r\n');
  // A wrong code is closed with 4003 after the handshake: a refused handshake would make the browser hold back its next tries.
  const now = Date.now();
  if (now < deafUntil) { socket.end(closing(4008, 'too many wrong codes')); return; }
  const given = Buffer.from((url.searchParams.get('code') || '').toUpperCase()), mine = Buffer.from(CODE);
  if (given.length !== mine.length || !crypto.timingSafeEqual(given, mine)) {
    while (wrong.length && now - wrong[0] > WRONG_SPAN_MS) wrong.shift();
    wrong.push(now);
    if (wrong.length >= WRONG_MOST) { deafUntil = now + WRONG_SPAN_MS; wrong.length = 0; log('too many wrong pairing codes: deaf to them for a minute'); }
    socket.end(closing(4003, 'not my code'));
    return;
  }
  wrong.length = 0;
  if (sock) try { sock.end(); } catch { /* already gone */ }
  sock = socket; attach(socket); telemetry.note('paired'); log('paired with the game');
});
let port = PORT;
server.on('error', (error) => { if (error.code === 'EADDRINUSE' && port < PORT + PORTS - 1) { port++; server.listen(port, '127.0.0.1'); } else log('cannot listen on port ' + port + ': ' + error.message); });
server.on('listening', () => { CODE = BASE + (port - PORT); log(`listening on 127.0.0.1:${port}; pairing code ${CODE}`); });
server.listen(port, '127.0.0.1');

const unpaired = () => `The game is not paired yet. Ask the player to open Waterworld, open its Storyteller dialog, and enter the pairing code ${CODE}.`;
function ask(op, args = {}, patience = 20000) {
  if (!sock) return Promise.resolve({ error: unpaired() });
  const id = nextId++;
  return new Promise((resolve) => {
    const timer = setTimeout(() => { waiting.delete(id); resolve({ error: 'The game did not answer (is its tab asleep?)' }); }, patience);
    waiting.set(id, (message) => { clearTimeout(timer); resolve(message); });
    sock.write(frame(JSON.stringify({ id, op, args })));
  });
}
// What the game answers, or a plain Error with what it said was wrong.
async function game(op, args) { const reply = await ask(op, args); if (reply.error) throw new Error(String(reply.error)); return reply.result; }

/* ---- MCP over stdio ---- */
const str = (description) => ({ type: 'string', description }), num = (description) => ({ type: 'number', description });
const TOOLS = [
  { name: 'sign_in', description: 'Sign the player in with their Caiioo account, which every other tool needs. Answers with a link for the player to open in their browser on this computer: there they approve this program in Caiioo and type the six-digit code Caiioo shows them. Never ask for that code, a password or a key in the chat.', inputSchema: { type: 'object', properties: {} } },
  { name: 'account', description: 'Which Caiioo account is signed in, what is reported under it (counts, timings and the game\'s figures: never what is said) and this session\'s sum. With sign_out, sign out and unpair this program.', inputSchema: { type: 'object', properties: { sign_out: { type: 'boolean', description: 'sign out of Caiioo here' } } } },
  { name: 'lore_open', description: 'Open the lore of this game: with no arguments, wherever it was kept before. To begin it, pass the folder the player chose (it is made, with its first pages, if new), or `elsewhere` naming another store you will keep it in with your own tools. Call this first in every session.',
    inputSchema: { type: 'object', properties: { folder: str('a folder on this computer for the lore, e.g. ~/Documents/Waterworld lore'), elsewhere: str('where else the lore is kept, e.g. "Notion page Waterworld lore"') } } },
  { name: 'lore_read', description: 'Read a page of the lore: player.md, mate.md, plot.md, chronicle.md, people/p<number>-<name>.md, places/<name>.md.',
    inputSchema: { type: 'object', properties: { file: str('the page, e.g. plot.md') }, required: ['file'] } },
  { name: 'lore_write', description: 'Write a page of the lore (Markdown). mode "append" adds to it, "replace" rewrites it, "create" makes it only if new. Put what no character may be told under a "## Private" heading.',
    inputSchema: { type: 'object', properties: { file: str('the page, e.g. people/p1234-millan-bueno.md'), text: str('Markdown'), mode: { type: 'string', enum: ['append', 'replace', 'create'] } }, required: ['file', 'text'] } },
  { name: 'lore_list', description: 'List the pages of the lore, or of one of its folders (people, places).', inputSchema: { type: 'object', properties: { dir: str('people or places; omit for all') } } },
  { name: 'lore_search', description: 'Find passages of the lore by words.', inputSchema: { type: 'object', properties: { query: str('words to look for') }, required: ['query'] } },
  { name: 'record', description: 'Set down what just happened: an entry in the chronicle under the game\'s date and place, and a line on the page of each person it concerns. Use it after every meeting, bargain, promise, fight, death or landfall.',
    inputSchema: { type: 'object', properties: { entry: str('what happened, in a few sentences'), people: { type: 'array', description: 'who it concerns', items: { type: 'object', properties: { id: num('their number in the game'), name: str('their name') }, required: ['id'] } }, thread: str('the plot thread it belongs to, if any') }, required: ['entry'] } },
  { name: 'situation', description: 'Where the game stands now: the date, the ship and her company (the first mate by name), where she lies or sails and under what wind, the captain\'s purse, cargo and standing, whether the captain is ashore, the port in sight and the realm about it.', inputSchema: { type: 'object', properties: {} } },
  { name: 'world', description: 'The game\'s own state of the country, by path: "realm", "settlements", "settlement:<name>" (works, garrison, port, herds, stores, prices), "houses", "house:<name>", "monarch", "armies", "caravans", "envoys", "camps", "wars", "projects", "prices:<place>", "rates", "technology", "learning", "petitions", "overlays". With no path, the realm in brief (date, monarch, treasury, people, war, plague).',
    inputSchema: { type: 'object', properties: { path: str('e.g. settlement:Lisboa') } } },
  { name: 'find', description: 'Find places, houses and people of the country by name. Each has a code (s0 a settlement, h2 a house, p1234 a person) for inspect.', inputSchema: { type: 'object', properties: { name: str('part of a name'), n: num('how many at most (60)') }, required: ['name'] } },
  { name: 'inspect', description: 'The game\'s whole card of a person, place or house, by code or by name: a person\'s household, kin, living, learning and life; a town\'s works and stores.', inputSchema: { type: 'object', properties: { code: str('e.g. p1234, s0, h2'), name: str('a name, if the code is not known') } } },
  { name: 'chronicle', description: 'The annals of the realm as the game writes them: the last n, or those that match words, a kind (crown, war, trade, church, town…) or a span of years.', inputSchema: { type: 'object', properties: { n: num('how many (20)'), q: str('words to match'), cat: str('a kind of entry'), fromAD: num('from this year'), toAD: num('to this year') } } },
  { name: 'panel', description: 'One of the model\'s own reports: crown, accounts (town optional), timeline, about, petitions, houses, house (house), storage (town), plan, victory.', inputSchema: { type: 'object', properties: { kind: str('which report'), town: str('a town\'s name or number'), house: str('a house\'s name or number') }, required: ['kind'] } },
  { name: 'mate_candidates', description: 'People of the port the captain starts from who might sign on as first mate: each a real person of the game (number, name, age, calling, household, nature). For a new game, before a mate is chosen.', inputSchema: { type: 'object', properties: { n: num('how many (6)') } } },
  { name: 'mate_choose', description: 'Make one of the port\'s people the first mate: the game names its mate for them and they go where the captain goes; mate.md is written from the game\'s card of them (what they were born and raised as). From then on you are that person in the story. A mate who is replaced keeps their page under people/.', inputSchema: { type: 'object', properties: { person: num('their number in the game') }, required: ['person'] } },
  { name: 'nearby', description: 'Who is about the captain now: the people in sight in the port (each with their number, name, calling and what they are at), those at the forts\' posts, and whom the player last pointed at or spoke to.', inputSchema: { type: 'object', properties: {} } },
  { name: 'character_brief', description: 'The brief for a subagent that plays one person the captain speaks with: who they are and their life as the game keeps it, where they are and the day, what is common talk, and only what they could know of the captain. `direction` is your word to them for this scene (what they want just now, something they know). Give the brief whole and alone to a fresh subagent.',
    inputSchema: { type: 'object', properties: { person: num('their number in the game'), direction: str('for this scene only, optional') }, required: ['person'] } },
  { name: 'say', description: 'Put words on the player\'s screen as spoken by someone: a person by number, or the first mate (omit person).', inputSchema: { type: 'object', properties: { person: num('who speaks; omit for the first mate'), text: str('what they say') }, required: ['text'] } },
  { name: 'narrate', description: 'Put a line of narration on the player\'s screen.', inputSchema: { type: 'object', properties: { text: str('the narration') }, required: ['text'] } },
  { name: 'events', description: 'What the player has done in the game since you last asked: whom they spoke to and what they said, whom they asked after, landfalls and sailings, the realm\'s news. Waits up to `wait` seconds for something to happen.', inputSchema: { type: 'object', properties: { wait: num('seconds to wait if nothing has happened yet (0 to 50; 25)') } } },
];
const PROMPTS = [
  { name: 'dungeon_master', description: 'Take up the game as its storyteller and the captain\'s first mate.' },
  { name: 'play_character', description: 'The brief for playing one person of the game.', arguments: [{ name: 'person', description: 'their number in the game', required: true }, { name: 'direction', description: 'for this scene only', required: false }] },
];

const text = (value) => ({ content: [{ type: 'text', text: typeof value === 'string' ? value : JSON.stringify(value, null, 1) }] });
// Until the lore has a home, every answer says so: an agent whose app does not show it the server's instructions
// still learns its first duty.
const reminded = (value) => lore.folder || lore.elsewhere ? text(value) : text({ first: 'No lore is kept yet. Ask the player where this game\'s lore should be kept, then call lore_open.', answer: value });

async function briefFor(person, direction = '') {
  const scene = await game('person', { id: Number(person) });
  let captain = '', memories = '';
  if (lore.folder) { captain = lore.captain(); memories = lore.memories(Number(person)); }
  return { scene, brief: characterBrief(scene, { captain, memories, direction }) };
}

// The tools that work for anyone: the two by which an account is signed in and looked at.
const OPEN_TOOLS = new Set(['sign_in', 'account']);
const signInLink = () => `http://127.0.0.1:${port}/sign-in?k=${SIGN_KEY}`;
async function call(name, args = {}) {
  if (!OPEN_TOOLS.has(name)) await account.need();
  switch (name) {
    case 'sign_in': {
      if (account.who().signedIn) { try { await account.need(); return text({ ...account.who(), note: 'Already signed in.' }); } catch { /* that session has ended: begin again */ } }
      const link = await account.begin();
      return text({ open: signInLink(), tell: 'Ask the player to open this link in their browser on this computer. It sends them to Caiioo to approve this program for their account, then asks for the six-digit code Caiioo shows them. The code is typed into that page: never ask for it here. When they say it is done, call account.', expiresIn: link.expiresIn });
    }
    case 'account': {
      if (args.sign_out) { await account.signOut(); return text({ signedIn: false, note: 'Signed out; this program is unpaired from the account.' }); }
      let stands = null;
      if (account.who().signedIn) { try { await account.need(); } catch (error) { stands = String(error?.message || error); } }
      const who = account.who();
      return text({ ...who, ...(stands ? { trouble: stands } : {}), ...(who.signedIn ? {} : { next: account.link ? `A sign-in is under way (${account.link.said || account.link.state}): the player finishes it at ${signInLink()}` : 'Call sign_in.' }), reported: TELEMETRY_STATEMENT, session: telemetry.summary() });
    }
    case 'lore_open': {
      const status = lore.open({ folder: args.folder || null, elsewhere: args.elsewhere || null });
      telemetry.note('lore', status);
      return text({ ...status, game: sock ? 'paired' : unpaired() });
    }
    case 'lore_read': return text(lore.read(args.file).text || `(${args.file} is not written yet)`);
    case 'lore_write': return text(lore.write(args.file, args.text, args.mode || 'append'));
    case 'lore_list': return text(lore.list(args.dir || ''));
    case 'lore_search': return text(lore.search(args.query));
    case 'record': {
      // The game's date and place, where it is paired; an entry is written either way.
      const now = sock ? await ask('situation') : null, at = now?.result ?? {};
      return text(lore.record({ entry: args.entry, people: args.people, thread: args.thread, date: at.date?.text || '', place: at.where?.name || '' }));
    }
    case 'situation': { const now = await game('situation'); telemetry.game(now); return reminded(now); }
    case 'world': return reminded(await game('world', { path: args.path || '' }));
    case 'find': return reminded(await game('find', { name: args.name, n: args.n }));
    case 'inspect': return reminded(await game('inspect', { code: args.code, name: args.name }));
    case 'chronicle': return reminded(await game('chronicle', { n: args.n, q: args.q, cat: args.cat, fromAD: args.fromAD, toAD: args.toAD }));
    case 'panel': return reminded(await game('panel', { kind: args.kind, town: args.town, house: args.house }));
    case 'mate_candidates': return reminded(await game('mateCandidates', { n: args.n }));
    case 'mate_choose': {
      const scene = await game('mateChoose', { id: Number(args.person) });
      let page = null;
      if (lore.folder) {
        const was = lore.read('mate.md').text, before = /Number in the game: p(\d+)/.exec(was);
        if (before && Number(before[1]) === Number(scene.person.id)) page = { file: 'mate.md', was: 'already theirs: left as it is' };
        else {
          // Whoever was mate before keeps what was written of them, among the people the story has touched.
          if (before) lore.write(lore.personPage(Number(before[1]), /^# ([^,\n]+)/.exec(was)?.[1] || ''), '\n## When they were first mate\n\n' + was.replace(/^# .*\n+/, ''));
          page = lore.write('mate.md', matePage(scene), 'replace');
        }
      }
      return reminded({ mate: scene.person, page, next: 'Read mate.md and inspect their card: from now on you speak as them.' });
    }
    case 'nearby': return reminded(await game('nearby'));
    case 'character_brief': { const { brief } = await briefFor(args.person, args.direction); telemetry.briefed(args.person); return text(BRIEF_USE + '\n\n---\n\n' + brief); }
    case 'say': return text(await game('say', { person: args.person ?? null, text: String(args.text ?? '') }));
    case 'narrate': return text(await game('narrate', { text: String(args.text ?? '') }));
    case 'events': {
      if (!sock) return text({ events: [], game: unpaired() });
      const patience = Math.max(0, Math.min(50, Number.isFinite(args.wait) ? args.wait : 25)) * 1000;
      if (!events.length && patience) await new Promise((resolve) => { const timer = setTimeout(done, patience); function done() { clearTimeout(timer); if (listener === done) listener = null; resolve(); } listener = done; });
      const drained = events.splice(0, events.length);
      telemetry.played(drained);
      return text({ events: drained });
    }
    default: throw new Error('unknown tool ' + name);
  }
}

async function prompt(name, args = {}) {
  if (name === 'dungeon_master') return { description: PROMPTS[0].description, messages: [{ role: 'user', content: { type: 'text', text: DM_INSTRUCTIONS + `\n\nPairing code for this session: ${CODE}. Begin.` } }] };
  if (name === 'play_character') { await account.need(); const { brief } = await briefFor(args.person, args.direction); telemetry.briefed(args.person); return { description: PROMPTS[1].description, messages: [{ role: 'user', content: { type: 'text', text: brief } }] }; }
  throw new Error('unknown prompt ' + name);
}

const reply = (id, result) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, result }) + '\n');
const fail = (id, code, message) => process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id, error: { code, message } }) + '\n');
async function answer(message) {
  if (message.id === undefined) return; // a notification
  try {
    switch (message.method) {
      case 'initialize': {
        const client = message.params?.clientInfo ?? {};
        telemetry.note('session', { client: String(client.name ?? ''), clientVersion: String(client.version ?? ''), server: VERSION, platform: process.platform, node: process.versions.node, protocol: String(message.params?.protocolVersion ?? '') });
      } return reply(message.id, { protocolVersion: message.params?.protocolVersion || '2025-06-18', capabilities: { tools: {}, prompts: {} }, serverInfo: { name: 'waterworld-dm', version: VERSION }, instructions: DM_INSTRUCTIONS + `\nPairing code for this session: ${CODE}.` });
      case 'tools/list': return reply(message.id, { tools: TOOLS });
      case 'prompts/list': return reply(message.id, { prompts: PROMPTS });
      case 'prompts/get': telemetry.note('prompt', { prompt: String(message.params?.name ?? '') }); return reply(message.id, await prompt(message.params?.name, message.params?.arguments));
      case 'ping': return reply(message.id, {});
      case 'tools/call':
        // What goes wrong inside a tool is told to the agent as the tool's answer, so that it can put it right.
        {
          // How long it took and how much went in and out is noted; what it said is not.
          const began = Date.now(), name = String(message.params?.name ?? ''), args = message.params?.arguments ?? {}, size = (value) => (typeof value === 'string' ? value.length : 0);
          const sent = Object.values(args).reduce((sum, value) => sum + size(value), 0);
          try { const result = await call(name, args); telemetry.tool(name, Date.now() - began, null, { in: sent, out: size(result.content?.[0]?.text) }); return reply(message.id, result); }
          catch (error) { telemetry.tool(name, Date.now() - began, error, { in: sent }); return reply(message.id, { content: [{ type: 'text', text: String(error?.message || error) }], isError: true }); }
        }
      default: return fail(message.id, -32601, 'method not found');
    }
  } catch (error) { fail(message.id, -32000, String(error?.message || error)); }
}
let inbox = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  inbox += chunk;
  for (let at; (at = inbox.indexOf('\n')) >= 0;) {
    const line = inbox.slice(0, at).trim(); inbox = inbox.slice(at + 1);
    if (!line) continue;
    let message; try { message = JSON.parse(line); } catch { continue; }
    answer(message);
  }
});
// The session's end: its sum is reported (or kept for next time), within a few seconds at most.
let ending = false;
function end() { if (ending) return; ending = true; const quit = () => process.exit(0); setTimeout(quit, 4000).unref(); telemetry.end().then(quit, quit); }
process.stdin.on('end', end);
process.on('SIGTERM', end); process.on('SIGINT', end);

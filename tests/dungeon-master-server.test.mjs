// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The dungeon master's server, whole: run as an agent app would run it (a child process spoken to over stdio),
// against a stand-in for Caiioo's relay that keeps the relay's device-link contract, a stand-in for the game's page
// on its socket, and the statistics endpoint's own handler. It works for no one who has not signed in with a Caiioo
// account; the code Caiioo shows goes in by the program's own page and never through the agent; and what is
// reported under the account holds nothing that was said.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { handleDmApi, dmTally, DM_API } from '../mcp/dm-stats-api.mjs';
import { trustedBase, sessionClaims, CAIIOO_RELAY } from '../mcp/dm-account.mjs';

const SERVER = fileURLToPath(new URL('../mcp/waterworld-dm.mjs', import.meta.url));
const listen = async (handler) => { const server = http.createServer(handler); server.listen(0, '127.0.0.1'); await once(server, 'listening'); return { server, base: `http://127.0.0.1:${server.address().port}` }; };
const bodyOf = async (request) => { let text = ''; for await (const chunk of request) text += chunk; return text; };
const sessionFor = (sub, email, ms = 7 * 24 * 3600 * 1000) => `pf_${Buffer.from(JSON.stringify({ typ: 'session', sub, email, iat: Date.now(), exp: Date.now() + ms, fam: 'f1' })).toString('base64url')}.${crypto.randomBytes(32).toString('base64url')}`;

// Caiioo's relay, as far as this program meets it: the device link, who-am-I, renewal and sign-out.
async function standInRelay({ clients = ['waterworld'], ahead = 5000 } = {}) {
  const links = new Map(), live = new Set(), seen = { me: 0, start: 0, poll: 0, logout: 0, agents: new Set() };
  const user = { id: 'u_test_1', email: 'ada.lovelace@example.com', name: null, avatar_url: null, tier: 'free' };
  const { server, base } = await listen(async (request, response) => {
    const send = (status, data) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(data)); };
    const url = new URL(request.url, 'http://x'), bearer = /^Bearer (.+)$/.exec(request.headers.authorization || '')?.[1];
    seen.agents.add(request.headers['user-agent']);
    if (request.headers.origin) return send(403, { error: 'Cross-origin', code: 'FORBIDDEN' });
    const body = request.method === 'POST' ? JSON.parse((await bodyOf(request)) || '{}') : {};
    if (url.pathname === '/api/auth/link/start') {
      seen.start++;
      if (!clients.includes(body.client)) return send(400, { error: 'Unknown client', code: 'BAD_REQUEST' });
      const linkId = crypto.randomBytes(16).toString('base64url'), pollSecret = crypto.randomBytes(32).toString('base64url');
      links.set(linkId, { pollSecret, key: crypto.createPublicKey({ key: body.devicePublicKey, format: 'jwk' }), approved: false, code: null, wrong: 0 });
      return send(200, { linkId, pollSecret, expiresIn: 600, interval: 0.05, approvalPath: `/link?l=${linkId}`, serverTime: Date.now() + ahead });
    }
    if (url.pathname === '/api/auth/link/poll') {
      seen.poll++;
      const link = links.get(body.linkId);
      const proved = link && body.pollSecret === link.pollSecret && Math.abs(body.ts - (Date.now() + ahead)) < 60000
        && crypto.verify('sha256', Buffer.from(`caiioo-device-link-poll\n${body.linkId}\n${body.ts}`), { key: link.key, dsaEncoding: 'ieee-p1363' }, Buffer.from(String(body.signature), 'base64url'));
      if (!proved) return send(401, { error: 'Invalid link or proof', code: 'INVALID_LINK' });
      if (!link.approved) return send(200, { status: 'pending', interval: 0.05 });
      if (body.code === undefined) return send(200, { status: 'awaiting_code' });
      if (body.code !== link.code) { link.wrong++; return send(200, { status: 'awaiting_code', codeError: 'CODE_INVALID', attemptsLeft: 5 - link.wrong }); }
      const token = sessionFor(user.id, user.email); live.add(token); links.delete(body.linkId);
      return send(200, { status: 'approved', token, user });
    }
    if (url.pathname === '/api/auth/me') {
      seen.me++;
      if (!live.has(bearer)) return send(401, { error: 'Invalid or expired token', code: 'INVALID_TOKEN' });
      return send(200, { user: { ...user, onboarding_complete: true }, subscription: null, license: { key: 'PFLOW-AAAA-BBBB-CCCC' }, effective_tier: 'free', is_staff: false });
    }
    if (url.pathname === '/api/auth/refresh') { if (!live.has(body.token)) return send(401, { error: 'no', code: 'INVALID_TOKEN' }); live.delete(body.token); const token = sessionFor(user.id, user.email); live.add(token); return send(200, { token, user }); }
    if (url.pathname === '/api/auth/logout') { seen.logout++; live.delete(bearer); return send(200, { ok: true }); }
    send(404, { error: 'not found' });
  });
  // What the player does in Caiioo's own page: approve the newest link, and read the code it shows.
  const approve = () => { const link = [...links.values()].at(-1); link.approved = true; link.code = '428513'; return link.code; };
  return { server, base, links, live, seen, approve, user };
}

// The statistics endpoint, served by its own handler over an R2 bucket that is a Map.
async function standInStats(relay) {
  const kept = new Map();
  const bucket = { get: async (key) => (kept.has(key) ? { json: async () => JSON.parse(kept.get(key)) } : null), put: async (key, value) => { kept.set(key, String(value)); } };
  const { server, base } = await listen(async (request, response) => {
    const text = request.method === 'POST' ? await bodyOf(request) : undefined;
    const answer = await handleDmApi(new Request('http://x' + request.url, { method: request.method, headers: request.headers, body: text }), { LANDFALL_CACHE: bucket }, {}, { relay });
    response.writeHead(answer.status, Object.fromEntries(answer.headers)); response.end(await answer.text());
  });
  return { server, base: base + DM_API.replace(/\/$/, ''), kept, bucket };
}

// The dungeon master as an agent app runs it.
function runServer(env) {
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, ...env }, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map(), said = [];
  let id = 0, held = '', errs = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { errs += chunk; });
  child.stdout.on('data', (chunk) => {
    held += chunk;
    for (let at; (at = held.indexOf('\n')) >= 0;) { const line = held.slice(0, at); held = held.slice(at + 1); if (!line.trim()) continue; said.push(line); const message = JSON.parse(line); waiting.get(message.id)?.(message); waiting.delete(message.id); }
  });
  const rpc = (method, params) => new Promise((resolve) => { const mine = ++id; waiting.set(mine, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: mine, method, params }) + '\n'); });
  const tool = async (name, args = {}) => { const { result } = await rpc('tools/call', { name, arguments: args }); const text = result.content[0].text; let data = text; try { data = JSON.parse(text); } catch { /* words, not data */ } return { failed: !!result.isError, text, data }; };
  const close = async () => { child.stdin.end(); if (child.exitCode === null) await once(child, 'exit'); };
  return { child, rpc, tool, close, said, get errs() { return errs; } };
}

const SITUATION = {
  date: { text: 'Spring 2, AD 1550', day: 201455, year: 1550 }, realm: { name: 'Altoón', monarch: 'Queen Petronila', people: 23371, treasury: 2200, places: 11, war: false, plague: false },
  where: { name: 'Lisboa', kind: 'port', people: 19448, ashore: true, lat: 38.7, lon: -9.13 }, ship: { name: 'Santa Clara', class: 'caravel' },
  captain: { title: 'Master', worth: 812, coin: 300, cargo: [{ good: 'wine', units: 12 }] }, voyage: { daysOut: 0, leagues: 0 }, mate: null,
};
const SCENE = {
  person: { id: 4821, name: 'Millán Bueno', age: 41.6, sex: 'm', role: 'boatman' },
  card: { facts: { Home: 'a cot by the strand', Wife: 'Elvira Bueno' }, household: [{ name: 'Millán Bueno', age: 41 }, { name: 'Elvira Bueno', age: 38 }], nature: 'steady, proud', life: ['Born Summer 3, AD 1508'] },
  doing: 'mending a net by the quay', place: { name: 'Lisboa', kind: 'capital', people: 19448, realm: 'Altoón', ruler: 'Queen Petronila' }, date: { text: 'Spring 2, AD 1550' }, weather: 'clear', news: [],
};
// The game's page on its socket: it answers what it is asked as the game would, and keeps what it was asked.
function standInPage(port, code) {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/?code=${code}`), asked = [];
  let mate = null;
  socket.addEventListener('message', (event) => {
    const { id, op, args } = JSON.parse(event.data); asked.push({ op, args });
    const result = op === 'situation' ? { ...SITUATION, mate } : op === 'person' ? SCENE : op === 'mateCandidates' ? [{ id: 4821, name: 'Millán Bueno', age: 41, sex: 'm', role: 'boatman', household: 2, nature: 'steady, proud' }]
      : op === 'mateChoose' ? ((mate = { id: SCENE.person.id, name: SCENE.person.name, age: 41, sex: 'm', role: 'boatman' }), { person: SCENE.person, card: SCENE.card, place: SCENE.place, date: SCENE.date })
        : op === 'say' || op === 'narrate' ? { shown: true } : op === 'fails' ? null : { op, args };
    socket.send(JSON.stringify(op === 'world' && args.path === 'nowhere' ? { id, error: 'No such path' } : { id, result }));
  });
  return { socket, asked, opened: once(socket, 'open'), closed: new Promise((resolve) => socket.addEventListener('close', (event) => resolve(event.code))), tell: (event) => socket.send(JSON.stringify({ event })) };
}
const scratch = (t) => { const dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ww-dms-'))); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return dir; };
const freePort = () => 20000 + Math.floor(Math.random() * 20000);

test('a session goes only to Caiioo or to this machine, and says of itself only what it is', () => {
  assert.equal(trustedBase(undefined, CAIIOO_RELAY), CAIIOO_RELAY);
  assert.equal(trustedBase('https://relay.caiioo.ai/', CAIIOO_RELAY), CAIIOO_RELAY);
  assert.equal(trustedBase('http://127.0.0.1:9000/x/', CAIIOO_RELAY), 'http://127.0.0.1:9000/x');
  for (const stranger of ['https://relay.caiioo.ai.evil.example', 'http://relay.caiioo.ai', 'https://example.com', 'https://127.0.0.1:9', 'http://10.0.0.5:9']) assert.throws(() => trustedBase(stranger, CAIIOO_RELAY), /only to relay\.caiioo\.ai/, stranger);
  assert.equal(sessionClaims(sessionFor('u1', 'a@b.c')).sub, 'u1');
  for (const not of ['', 'pf_', 'pf_abc', 'PFLOW-AAAA-BBBB-CCCC', 'pf_!!!.sig']) assert.equal(sessionClaims(not), null, not);
});

test('the statistics endpoint keeps counts under the account Caiioo names, and nothing else', async (t) => {
  const relay = await standInRelay(), stats = await standInStats(relay.base);
  t.after(() => { relay.server.close(); stats.server.close(); });
  const good = sessionFor('u_test_1', 'ada.lovelace@example.com'); relay.live.add(good);
  const post = (bearer, body, route = '/telemetry') => fetch(stats.base + route, { method: 'POST', headers: { 'content-type': 'application/json', ...(bearer ? { authorization: 'Bearer ' + bearer } : {}) }, body: typeof body === 'string' ? body : JSON.stringify(body) });
  // No session, something that is not one, and one that has ended are refused without troubling the relay.
  for (const bearer of [null, 'PFLOW-AAAA-BBBB-CCCC', 'pf_abc.def', sessionFor('u_test_1', 'x@y.z', -1000)]) assert.equal((await post(bearer, { events: [] })).status, 401);
  assert.equal(relay.seen.me, 0);
  // One the relay does not know is asked about once, then remembered as refused.
  const forged = sessionFor('u_test_1', 'x@y.z');
  assert.equal((await post(forged, { events: [{ k: 'tool', tool: 'say' }] })).status, 401); assert.equal((await post(forged, { events: [] })).status, 401);
  assert.equal(relay.seen.me, 1); assert.equal(stats.kept.size, 0);
  const said = 'the captain confessed the killing in Sevilla';
  const taken = await (await post(good, { v: 1, session: 'abcdef123', events: [
    { k: 'session', client: 'claude-code', clientVersion: '2.1.0', server: '0.1.0', platform: 'darwin', email: 'ada.lovelace@example.com' },
    { k: 'tool', tool: 'say', ms: 20, failed: false, in: said.length, text: said }, { k: 'tool', tool: 'inspect', ms: 30, failed: true, error: said },
    { k: 'conversation', text: said }, { k: 'played', what: 'spoke', n: 3 }, { k: 'game', people: 23371, port: 'Lisboa', note: said }, { k: 'end', seconds: 61, calls: 2, errors: 1, briefs: 1 }, 'nonsense', null,
  ] })).json();
  assert.deepEqual(taken, { taken: 6 });
  assert.equal(relay.seen.me, 2, 'a session that stands is asked about once');
  assert.equal((await (await post(good, { events: [{ k: 'tool', tool: 'say', ms: 5 }] })).json()).taken, 1); assert.equal(relay.seen.me, 2);
  const sum = await (await fetch(stats.base + '/me', { headers: { authorization: 'Bearer ' + good } })).json();
  assert.equal(sum.account, 'u_test_1'); assert.equal(sum.sessions, 1); assert.equal(sum.calls, 3); assert.equal(sum.errors, 1); assert.equal(sum.seconds, 61); assert.equal(sum.briefs, 1);
  assert.deepEqual(sum.tools, { say: { n: 2, failed: 0, ms: 25 }, inspect: { n: 1, failed: 1, ms: 30 } }); assert.deepEqual(sum.played, { spoke: 3 }); assert.deepEqual(sum.clients, { 'claude-code': 1 }); assert.equal(sum.game.port, 'Lisboa');
  const everything = [...stats.kept].flat().join('\n');
  assert.deepEqual([...stats.kept.keys()].map((key) => key.replace(/\d{4}-\d\d-\d\d|\d{13}-[0-9a-f]{8}/g, '*')).sort(), ['dm/accounts/u_test_1.json', 'dm/events/*/u_test_1/*.json', 'dm/events/*/u_test_1/*.json']);
  for (const never of [said, 'Sevilla', 'pf_', 'PFLOW', 'example.com', 'ada']) assert.ok(!everything.includes(never), never);
  assert.equal((await post(good, 'x'.repeat(300 * 1024))).status, 413); assert.equal((await post(good, '{not json')).status, 400);
  assert.equal((await fetch(stats.base + '/everything', { headers: { authorization: 'Bearer ' + good } })).status, 404);
  assert.equal((await handleDmApi(new Request('http://x/waterworld/api/dm/me', { headers: { authorization: 'Bearer ' + good } }), {}, {}, { relay: relay.base })).status, 503, 'with no bucket bound, nothing is kept and it says so');
  assert.equal(dmTally({ sessions: 0, calls: 0, errors: 0, seconds: 0, briefs: 0, tools: {}, played: {}, clients: {} }, Array.from({ length: 80 }, (_, i) => ({ k: 'tool', tool: 't' + i })), new Date()).calls, 80);
});

test('the dungeon master serves no one until a Caiioo account is signed in, and then plays the game and reports only figures', { timeout: 120000 }, async (t) => {
  const dir = scratch(t), relay = await standInRelay(), stats = await standInStats(relay.base), port = freePort();
  t.after(() => { relay.server.close(); stats.server.close(); });
  const env = { WATERWORLD_DM_RELAY: relay.base, WATERWORLD_DM_STATS: stats.base, WATERWORLD_DM_ACCOUNT_FILE: path.join(dir, 'account.json'), WATERWORLD_DM_SPOOL: path.join(dir, 'unsent.json'), WATERWORLD_DM_CONFIG: path.join(dir, 'config.json'), WATERWORLD_DM_PORT: String(port), WATERWORLD_DM_CODE: 'ABCDE' };
  const dm = runServer(env); t.after(() => dm.child.kill());

  const hello = (await dm.rpc('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'test-agent', version: '1.2.3' }, capabilities: {} })).result;
  assert.equal(hello.serverInfo.name, 'waterworld-dm');
  for (const told of [/you are the captain's first mate/, /sign_in/, /Pairing code for this session: ABCDE0\./]) assert.match(hello.instructions, told);
  const tools = (await dm.rpc('tools/list')).result.tools.map((one) => one.name);
  for (const name of ['sign_in', 'account', 'lore_open', 'record', 'situation', 'world', 'find', 'inspect', 'chronicle', 'panel', 'mate_candidates', 'mate_choose', 'nearby', 'character_brief', 'say', 'narrate', 'events']) assert.ok(tools.includes(name), name);
  assert.deepEqual((await dm.rpc('ping')).result, {});

  // Unsigned, nothing of the game or the lore is served: every such tool says how to sign in.
  for (const [name, args] of [['situation', {}], ['lore_open', { folder: path.join(dir, 'lore') }], ['world', {}], ['character_brief', { person: 4821 }], ['lore_read', { file: 'plot.md' }]]) {
    const refused = await dm.tool(name, args);
    assert.ok(refused.failed && /No Caiioo account is signed in\. Call sign_in/.test(refused.text), name);
  }
  assert.ok(!fs.existsSync(path.join(dir, 'lore')), 'no lore was begun for someone not signed in');
  assert.equal((await dm.tool('account')).data.signedIn, false);

  // Signing in: the agent is given a link to this machine, and the player does the rest in their browser.
  const begun = (await dm.tool('sign_in')).data;
  assert.match(begun.open, new RegExp(`^http://127\\.0\\.0\\.1:${port}/sign-in\\?k=[A-Za-z0-9_-]{20,}$`)); assert.match(begun.tell, /never ask for it here/);
  const page = await (await fetch(begun.open)).text();
  assert.match(page, new RegExp(`href="${relay.base}/link\\?l=[A-Za-z0-9_-]+"`)); assert.match(page, /never shown to the AI/);
  assert.equal(relay.seen.start, 1, 'opening the page joins the sign-in already begun');
  assert.equal((await fetch(begun.open.replace(/k=.*/, 'k=guess'))).status, 403);
  // Under another name (a page elsewhere pointing its own name at this machine), there is no sign-in page.
  const otherName = await new Promise((resolve) => http.get({ host: '127.0.0.1', port, path: new URL(begun.open).pathname + new URL(begun.open).search, headers: { host: 'evil.example' } }, async (response) => resolve(await bodyOf(response))));
  assert.ok(!/six-digit/.test(otherName) && /Pair from the game/.test(otherName));
  const key = new URL(begun.open).searchParams.get('k');
  const code = (body, headers = {}) => fetch(`http://127.0.0.1:${port}/sign-in/code`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });
  assert.equal((await code({ k: key, code: '428513' }, { origin: 'https://evil.example' })).status, 403);
  assert.equal((await code({ k: 'guess', code: '428513' })).status, 403);
  assert.equal((await code({ k: key, code: '12345' })).status, 400);
  assert.equal((await fetch(`http://127.0.0.1:${port}/sign-in/code`, { method: 'POST', headers: { 'content-type': 'text/plain' }, body: JSON.stringify({ k: key, code: '428513' }) })).status, 415);
  // Before the player has approved in Caiioo, a code does nothing.
  const early = await (await code({ k: key, code: '428513' })).json();
  assert.equal(early.state, 'pending'); assert.match(early.said, /Not approved yet/);
  assert.equal((await dm.tool('situation')).failed, true);
  const shown = relay.approve();
  const wrong = await (await code({ k: key, code: '000000' })).json();
  assert.equal(wrong.state, 'awaiting_code'); assert.match(wrong.said, /not the code Caiioo showed \(4 tries left\)/);
  const right = await (await code({ k: key, code: shown })).json();
  assert.equal(right.state, 'approved'); assert.equal(right.said, 'Signed in as a***@example.com.');
  assert.match(await (await fetch(begun.open)).text(), /Signed in as a\*\*\*@example\.com\. You can close this tab\./);

  // The session is kept in one file, for the player alone; the agent is told who, never the session.
  const file = path.join(dir, 'account.json'), kept = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.equal(fs.statSync(file).mode & 0o777, 0o600); assert.ok(relay.live.has(kept.token)); assert.deepEqual(kept.user, { id: 'u_test_1', name: 'a***@example.com', tier: 'free' });
  const who = (await dm.tool('account')).data;
  assert.equal(who.signedIn, true); assert.equal(who.account, 'u_test_1'); assert.equal(who.name, 'a***@example.com'); assert.match(who.reported, /Never reported: anything said/);
  assert.equal((await dm.tool('sign_in')).data.note, 'Already signed in.');

  // Signed in but with no game: it says how to pair. A wrong code is turned away; the right one joins.
  const unpaired = await dm.tool('situation');
  assert.ok(unpaired.failed && /not paired yet.*pairing code ABCDE0/.test(unpaired.text));
  assert.equal(await standInPage(port, 'WRONG0').closed, 4003);
  const game = standInPage(port, 'abcde0'); await game.opened; t.after(() => game.socket.close());
  // Until the lore has a home, every answer from the game says so.
  assert.match((await dm.tool('situation')).data.first, /No lore is kept yet/);
  const lore = (await dm.tool('lore_open', { folder: path.join(dir, 'lore') })).data;
  assert.equal(lore.kept, 'folder'); assert.equal(lore.game, 'paired'); assert.equal(lore.mateChosen, false);
  const now = (await dm.tool('situation')).data;
  assert.equal(now.realm.people, 23371); assert.equal(now.mate, null);

  // The first mate is one of the port's own people, and their page begins from the game's card of them.
  assert.equal((await dm.tool('mate_candidates')).data[0].name, 'Millán Bueno');
  const chosen = (await dm.tool('mate_choose', { person: 4821 })).data;
  assert.equal(chosen.mate.name, 'Millán Bueno'); assert.equal(chosen.page.file, 'mate.md');
  const matePage = (await dm.tool('lore_read', { file: 'mate.md' })).text;
  assert.match(matePage, /^# Millán Bueno, first mate\n\nNumber in the game: p4821\. Signed on at Lisboa, Spring 2, AD 1550\./); assert.match(matePage, /- Calling before the sea: boatman/); assert.match(matePage, /Left at home: Elvira Bueno \(38\)\./);
  assert.equal((await dm.tool('mate_choose', { person: 4821 })).data.page.was, 'already theirs: left as it is');
  assert.equal((await dm.tool('situation')).data.mate.id, 4821);

  // A character is briefed with what they could know, and not with what is private to the storyteller.
  const secret = 'The captain is wanted in Sevilla for a killing';
  await dm.tool('lore_write', { file: 'player.md', mode: 'replace', text: `# The captain\n\n## As anyone can see\n\nTall and sunburnt.\n\n## Private\n\n${secret}.` });
  const brief = (await dm.tool('character_brief', { person: 4821, direction: 'He wants a berth for his nephew' })).text;
  assert.match(brief, /^Give the brief below, whole and alone, to a subagent/); assert.match(brief, /You are playing one person in a story, and no one else: Millán Bueno, 41, boatman of Lisboa\./);
  assert.match(brief, /Tall and sunburnt\./); assert.match(brief, /He wants a berth for his nephew\./); assert.ok(!brief.includes('Sevilla'));

  // What is said is shown in the game, and what happens is set down under the game's date and place.
  const spoken = 'Captain, the harbour master wants his due before the tide';
  assert.deepEqual((await dm.tool('say', { text: spoken })).data, { shown: true });
  assert.deepEqual(game.asked.at(-1), { op: 'say', args: { person: null, text: spoken } });
  const entry = 'The captain paid the harbour due and took Millán on as mate';
  await dm.tool('record', { entry, people: [{ id: 4821, name: 'Millán Bueno' }], thread: 'the crew' });
  assert.match((await dm.tool('lore_read', { file: 'chronicle.md' })).text, new RegExp(`## Spring 2, AD 1550 · Lisboa\\n\\n${entry}`));
  // What the player does in the game reaches the storyteller when it asks.
  const words = 'Find me a pilot who knows the bar at Aveiro';
  game.tell({ kind: 'spoke', person: 4821, text: words }); game.tell({ kind: 'landfall', place: 'Lisboa' });
  const heard = (await dm.tool('events', { wait: 5 })).data.events;
  assert.deepEqual(heard.map((one) => [one.kind, one.text ?? one.place]), [['spoke', words], ['landfall', 'Lisboa']]);
  assert.deepEqual((await dm.tool('events', { wait: 0 })).data.events, []);
  // What goes wrong in the game or the lore is told as the tool's answer.
  const lost = await dm.tool('world', { path: 'nowhere' }); assert.ok(lost.failed && lost.text === 'No such path');
  const outside = await dm.tool('lore_write', { file: '../outside.md', text: 'x' }); assert.ok(outside.failed && /outside|not a page/.test(outside.text));
  assert.equal((await dm.rpc('nonsense')).error.code, -32601);
  const prompt = (await dm.rpc('prompts/get', { name: 'play_character', arguments: { person: 4821 } })).result.messages[0].content.text;
  assert.match(prompt, /^You are playing one person in a story/);

  // The agent was never shown the session, the licence, the code or the account's address.
  const all = dm.said.join('\n');
  for (const never of ['pf_', 'PFLOW', shown, 'ada.lovelace', kept.token.slice(4, 30)]) assert.ok(!all.includes(never), `the agent saw ${never}`);

  // At the session's end its use is reported under the account: figures, and not one word of what was said.
  await dm.close();
  const sum = JSON.parse(stats.kept.get('dm/accounts/u_test_1.json'));
  assert.equal(sum.sessions, 1); assert.deepEqual(sum.clients, { 'test-agent': 1 }); assert.equal(sum.briefs, 2);
  assert.equal(sum.calls, 28); assert.equal(sum.errors, 9);
  assert.equal(sum.tools.say.n, 1); assert.equal(sum.tools.situation.failed, 3); assert.deepEqual(sum.played, { spoke: 1, landfall: 1 });
  assert.equal(sum.game.people, 23371); assert.equal(sum.game.port, 'Lisboa'); assert.equal(sum.game.worth, 812); assert.equal(sum.lore.kept, 'folder');
  const reported = [...stats.kept.values()].join('\n');
  const events = [...stats.kept].filter(([key]) => key.startsWith('dm/events/')).flatMap(([, value]) => JSON.parse(value).events);
  assert.deepEqual(events.filter((one) => one.k === 'tool' && one.tool === 'say').map((one) => [one.in, one.failed]), [[spoken.length, false]], 'how much was said, not what');
  assert.deepEqual(events.find((one) => one.k === 'tool' && one.error === 'account') && true, true);
  for (const never of [spoken, entry, words, secret, 'Sevilla', 'harbour', 'Aveiro', 'nephew', 'Millán', dir, 'pf_', 'PFLOW', 'example.com', shown]) assert.ok(!reported.includes(never), `reported: ${never}`);
  assert.ok(!fs.existsSync(path.join(dir, 'unsent.json')), 'nothing was left unsent');
  assert.ok(!dm.errs.includes('pf_'), 'the session is not logged');

  // Another session finds the account signed in, and asks Caiioo itself before it believes the file.
  const asked = relay.seen.me, again = runServer(env); t.after(() => again.child.kill());
  await again.rpc('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'test-agent', version: '1.2.3' } });
  assert.match((await again.tool('situation')).text, /not paired yet/); assert.ok(relay.seen.me > asked);
  // Signing out unpairs the program at Caiioo and forgets the session here.
  assert.equal((await again.tool('account', { sign_out: true })).data.signedIn, false);
  assert.equal(relay.seen.logout, 1); assert.equal(relay.live.size, 0); assert.ok(!fs.existsSync(file));
  assert.match((await again.tool('lore_read', { file: 'plot.md' })).text, /No Caiioo account is signed in/);
  await again.close();
  assert.ok([...relay.seen.agents].every((agent) => /^waterworld-dm/.test(agent)));
});

test('a session Caiioo has withdrawn is forgotten, and a relay that does not know this program says so plainly', { timeout: 60000 }, async (t) => {
  const dir = scratch(t), relay = await standInRelay({ clients: ['word'] }), stats = await standInStats(relay.base);
  t.after(() => { relay.server.close(); stats.server.close(); });
  const file = path.join(dir, 'account.json');
  // A session put there by hand (or left from before) that the relay no longer honours.
  fs.writeFileSync(file, JSON.stringify({ token: sessionFor('u_test_1', 'ada.lovelace@example.com'), user: { id: 'u_test_1', name: 'x', tier: 'free' }, verifiedAt: Date.now() }));
  const dm = runServer({ WATERWORLD_DM_RELAY: relay.base, WATERWORLD_DM_STATS: stats.base, WATERWORLD_DM_ACCOUNT_FILE: file, WATERWORLD_DM_SPOOL: path.join(dir, 'unsent.json'), WATERWORLD_DM_CONFIG: path.join(dir, 'config.json'), WATERWORLD_DM_PORT: String(freePort()), WATERWORLD_DM_CODE: 'QQQQQ' });
  t.after(() => dm.child.kill());
  await dm.rpc('initialize', { protocolVersion: '2025-06-18' });
  const ended = await dm.tool('situation');
  assert.ok(ended.failed && /session has ended or was withdrawn/.test(ended.text)); assert.ok(!fs.existsSync(file));
  const refused = await dm.tool('sign_in');
  assert.ok(refused.failed && /Caiioo does not yet admit this program: its relay's list of clients that may link has no "waterworld"/.test(refused.text));
  await dm.close();
  // What could not be reported (no one is signed in) waits for the next session, cleaned, on this machine.
  const unsent = JSON.parse(fs.readFileSync(path.join(dir, 'unsent.json'), 'utf8'));
  assert.deepEqual(unsent.map((one) => one.k), ['session', 'tool', 'tool', 'end']); assert.equal(stats.kept.size, 0);
});

// One try at the game's socket as a browser makes it: 101 when the way opens, else the status it was refused with.
const knock = (port, { code = 'ABCDE0', origin, host } = {}) => new Promise((resolve, reject) => {
  const request = http.request({ host: '127.0.0.1', port, path: '/?code=' + code, headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': crypto.randomBytes(16).toString('base64'), ...(origin ? { Origin: origin } : {}), ...(host ? { Host: host } : {}) } });
  request.on('upgrade', (response, socket, head) => {
    // What it says next, if it shuts the way at once: the close code of its first frame (which may come with the handshake).
    let done = false; const say = (closed) => { if (!done) { done = true; resolve({ status: 101, closed, socket }); } };
    const read = (chunk) => { if (chunk.length >= 4 && (chunk[0] & 15) === 8) say(chunk.readUInt16BE(2)); };
    read(head); socket.on('data', read);
    setTimeout(() => say(null), 400);
  });
  request.on('response', (response) => { response.resume(); resolve({ status: response.statusCode }); });
  request.on('error', reject); request.end();
});

test('the game\'s socket opens only to the game\'s own pages, and goes deaf to a run of wrong codes', { timeout: 60000 }, async (t) => {
  const dir = scratch(t), port = freePort();
  const dm = runServer({ WATERWORLD_DM_RELAY: 'http://127.0.0.1:9', WATERWORLD_DM_STATS: 'http://127.0.0.1:9', WATERWORLD_DM_ACCOUNT_FILE: path.join(dir, 'account.json'), WATERWORLD_DM_SPOOL: path.join(dir, 'unsent.json'), WATERWORLD_DM_CONFIG: path.join(dir, 'config.json'), WATERWORLD_DM_PORT: String(port), WATERWORLD_DM_CODE: 'ABCDE' });
  t.after(() => dm.child.kill());
  await dm.rpc('initialize', { protocolVersion: '2025-06-18' });
  // Another site's page in the player's browser, or a name of its own pointed at this machine: refused before the code is looked at.
  for (const origin of ['https://evil.example', 'https://sixcailloux.com.evil.example', 'http://sixcailloux.com', 'null', 'http://192.168.1.4:8080']) assert.equal((await knock(port, { origin })).status, 403, origin);
  assert.equal((await knock(port, { host: `evil.example:${port}` })).status, 403);
  // The published game, the game served from this machine, and a program that names no page: let in with the code.
  for (const origin of ['https://sixcailloux.com', 'https://www.sixcailloux.com', 'http://127.0.0.1:8123', 'http://localhost:5173', undefined]) {
    const way = await knock(port, { origin }); assert.equal(way.status, 101, String(origin)); assert.equal(way.closed, null, String(origin)); way.socket.destroy();
  }
  // Five wrong codes within the minute, and it hears no code at all for the next one: not even the right one.
  for (let i = 0; i < 5; i++) { const way = await knock(port, { code: 'WRONG' + i, origin: 'https://sixcailloux.com' }); assert.equal(way.closed, 4003, 'try ' + i); way.socket.destroy(); }
  const deaf = await knock(port, { origin: 'https://sixcailloux.com' }); assert.equal(deaf.closed, 4008); deaf.socket.destroy();
  assert.match(dm.errs, /too many wrong pairing codes/);
});

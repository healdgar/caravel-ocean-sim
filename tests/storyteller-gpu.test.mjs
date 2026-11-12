// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The dungeon master and the running game, whole: the real server (mcp/waterworld-dm.mjs, run as an agent app runs
// it, signed in against a stand-in for Caiioo's relay) and the real page at Lisbon in 1550. Before any storyteller
// is paired the ship's mate answers the captain's questions by buttons from the game and the model, and one of the
// port's own people is signed on as mate that way. Paired, the storyteller learns where the game stands from the
// game and is that person from then on; the mate walks behind the captain ashore and no longer about the streets,
// can be pointed at and spoken to, what the storyteller says is on the player's screen, and the town's reckoning
// does not bury someone who is at sea.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { chromium } from 'playwright';
import { createDevServer } from '../server.mjs';
import { coastalRegionStageURL } from '../js/landfall.js';

const SERVER = fileURLToPath(new URL('../mcp/waterworld-dm.mjs', import.meta.url));
const SHOTS = fileURLToPath(new URL('../shots/proof/', import.meta.url));
let browser, server, base, relay, dm, dir, reported = [];
const session = `pf_${Buffer.from(JSON.stringify({ typ: 'session', sub: 'u_story', email: 'captain@example.com', iat: Date.now(), exp: Date.now() + 6 * 24 * 3600 * 1000 })).toString('base64url')}.${'s'.repeat(43)}`;

before(async () => {
  server = createDevServer(); server.listen(0, '127.0.0.1'); await once(server, 'listening');
  base = `http://127.0.0.1:${server.address().port}/`;
  // Caiioo's relay as far as a signed-in program meets it, and the statistics endpoint, in one.
  relay = http.createServer(async (request, response) => {
    let body = ''; for await (const chunk of request) body += chunk;
    const send = (status, data) => { response.writeHead(status, { 'content-type': 'application/json' }); response.end(JSON.stringify(data)); };
    if (request.url === '/api/auth/me') return request.headers.authorization === 'Bearer ' + session ? send(200, { user: { id: 'u_story', email: 'captain@example.com', name: null, tier: 'free' } }) : send(401, { code: 'INVALID_TOKEN' });
    if (request.url === '/stats/telemetry') { const batch = JSON.parse(body); reported.push(...batch.events); return send(200, { taken: batch.events.length }); }
    send(404, {});
  });
  relay.listen(0, '127.0.0.1'); await once(relay, 'listening');
  const at = `http://127.0.0.1:${relay.address().port}`;
  dir = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'ww-story-')));
  fs.writeFileSync(path.join(dir, 'account.json'), JSON.stringify({ token: session }), { mode: 0o600 });
  const child = spawn(process.execPath, [SERVER], { env: { ...process.env, WATERWORLD_DM_RELAY: at, WATERWORLD_DM_STATS: at + '/stats', WATERWORLD_DM_ACCOUNT_FILE: path.join(dir, 'account.json'), WATERWORLD_DM_SPOOL: path.join(dir, 'unsent.json'), WATERWORLD_DM_CONFIG: path.join(dir, 'config.json'), WATERWORLD_DM_CODE: 'STORY' }, stdio: ['pipe', 'pipe', 'pipe'] });
  const waiting = new Map(); let id = 0, held = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { held += chunk; for (let cut; (cut = held.indexOf('\n')) >= 0;) { const line = held.slice(0, cut); held = held.slice(cut + 1); if (!line.trim()) continue; const message = JSON.parse(line); waiting.get(message.id)?.(message); waiting.delete(message.id); } });
  const rpc = (method, params) => new Promise((resolve) => { const mine = ++id; waiting.set(mine, resolve); child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: mine, method, params }) + '\n'); });
  const tool = async (name, args = {}) => { const { result } = await rpc('tools/call', { name, arguments: args }); const text = result.content[0].text; let data = text; try { data = JSON.parse(text); } catch { /* words */ } return { failed: !!result.isError, text, data }; };
  dm = { child, rpc, tool };
  await rpc('initialize', { protocolVersion: '2025-06-18', clientInfo: { name: 'test', version: '1' } });
  browser = await chromium.launch({ executablePath: process.env.CHROMIUM_PATH || undefined, args: ['--enable-unsafe-webgpu', `--use-angle=${process.env.WEBGPU_BACKEND || 'metal'}`, '--disable-gpu-watchdog'] });
});
after(async () => { await browser?.close(); dm?.child.kill(); relay?.close(); server?.closeAllConnections?.(); server?.close(); if (dir) fs.rmSync(dir, { recursive: true, force: true }); });

test('at Lisbon the mate answers by buttons and is signed on from the port\'s people; paired, the storyteller is that mate, who follows the captain ashore', { timeout: 900000 }, async (t) => {
  const url = coastalRegionStageURL(base, 'lisbon', 'dock', 'clear', 1550);
  for (const [k, v] of Object.entries({ w: 1280, h: 860, clouds: 0, follower: 0 })) url.searchParams.set(k, String(v));
  const page = await browser.newPage({ viewport: { width: 1280, height: 860 } }), errors = [];
  page.on('pageerror', (e) => errors.push(e.message)); page.on('console', (m) => { if (m.type() === 'error' && !/404|favicon/.test(m.text())) errors.push(m.text()); });
  await page.goto(url.toString());
  await page.waitForFunction(() => window.oceanStartup?.state === 'ready' || window.oceanStartup?.state === 'failed', null, { timeout: 300000, polling: 200 });
  assert.equal(await page.evaluate(() => window.oceanStartup.state), 'ready');
  await page.waitForFunction(() => window.oceanBoard?.state === 'alive', null, { timeout: 240000, polling: 300 });

  // With no storyteller paired, the ship's own mate is there to be asked: a bar at the lower left that opens to the
  // questions of the moment, each answered from what the game and the model hold.
  assert.equal(await page.evaluate(() => oceanStoryteller.door.state), 'apart');
  await page.waitForFunction(() => { const el = document.getElementById('storyteller-says'); return el && !el.hidden && /, first mate$/.test(el.querySelector('.mate-bar').textContent); }, null, { timeout: 20000, polling: 200 });
  const shipsMate = await page.evaluate(() => document.querySelector('#storyteller-says .mate-bar').textContent);
  await page.waitForFunction(() => oceanStoryteller.knows().town?.name === 'Lisboa', null, { timeout: 60000, polling: 300 });
  assert.equal(await page.evaluate(() => document.querySelector('#storyteller-says .mate-body').hidden), true, 'folded away until it is wanted');
  await page.click('#storyteller-says .mate-bar');
  const topics = () => page.evaluate(() => [...document.querySelectorAll('#storyteller-says .mate-topics button')].map((button) => button.textContent));
  const answered = async (label) => {
    const had = await page.evaluate(() => oceanStoryteller.door.lines.length);
    await page.locator('#storyteller-says .mate-topics button', { hasText: label }).first().click();
    await page.waitForFunction((n) => oceanStoryteller.door.lines.length >= n + 2 && oceanStoryteller.door.lines.at(-1).kind === 'say' && !document.querySelector('#storyteller-says .mate-topics button')?.disabled, had, { timeout: 60000, polling: 100 });
    const said = await page.evaluate(() => oceanStoryteller.door.lines.at(-1));
    assert.ok(said.text && !/undefined|NaN|null|\[object/.test(said.text), said.text);
    return said;
  };
  const offered = await topics();
  for (const label of ['What is this place?', 'Who rules here?', 'How are our stores?', 'Who here would sign on as mate?']) assert.ok(offered.includes(label), offered.join(' | '));
  assert.ok(!offered.includes('Tell me of yourself') && offered.length <= 8, offered.join(' | '));
  const monarch = await page.evaluate(() => oceanBoard.status.monarch);
  const place = await answered('What is this place?');
  assert.match(place.text, /^Lisboa, captain: the seat of .*souls within .* walls.*They speak Castilian\./); assert.ok(place.text.includes(monarch), place.text);
  const crown = await answered('Who rules here?');
  assert.ok(crown.text.startsWith(monarch + ' rules') && /The realm is at (peace|war)\./.test(crown.text), crown.text);
  const stores = await answered('How are our stores?');
  t.diagnostic(`${shipsMate}: ${place.text} | ${crown.text} | ${stores.text}`);
  // Who would sign on: the port's own people, each told of from the model's card of them; one is signed on.
  const would = await answered('Who here would sign on as mate?');
  assert.match(would.text, /^These would come if you asked them, captain: /);
  const names = await topics();
  assert.ok(names.length >= 4 && names.at(-1) === 'Not now', names.join(' | '));
  const account = await answered(names[0]);
  assert.ok(account.text.startsWith(names[0].split(',')[0] + ': '), account.text);
  assert.deepEqual((await topics()).slice(1), ['Someone else', 'Not now']);
  assert.equal(await page.evaluate(() => oceanStoryteller.mate), null, 'no one is signed on by being asked after');
  const aye = await answered('Sign ' + names[0].split(' ')[0] + ' on');
  const chosen = await page.evaluate(() => ({ id: oceanStoryteller.mate.id, name: oceanStoryteller.mate.name, port: oceanStoryteller.mate.port, about: oceanStoryteller.mate.about }));
  assert.equal(chosen.name, names[0].split(',')[0]); assert.equal(chosen.port, 'Lisboa'); assert.ok(chosen.about.born.startsWith('Born '), JSON.stringify(chosen.about));
  assert.equal(aye.text, `Aye, captain. ${chosen.name}, at your word. I will fetch my chest and come aboard.`); assert.equal(aye.who, chosen.name);
  assert.equal(await page.evaluate(() => document.querySelector('#storyteller-says .mate-bar').textContent), chosen.name + ', first mate');
  // The one signed on has a life of their own to tell, and is not asked who else would come.
  const own = await topics();
  assert.ok(own.includes('Tell me of yourself') && !own.includes('Who here would sign on as mate?'), own.join(' | '));
  const self = await answered('Tell me of yourself');
  assert.ok(self.text.startsWith(chosen.name + ', captain') && /I was born in the \w+ of 1[45]\d\d\./.test(self.text), self.text);
  t.diagnostic(`${account.text} | ${self.text}`);
  await page.screenshot({ path: path.join(SHOTS, 'first-mate-counsel.png') });

  // Not paired: the storyteller says how; a wrong code is said to be wrong in the game's own dialog.
  // (The page looks for the storyteller only on its own ten ports of this machine, so it runs on one of those.)
  const code = /not paired yet.*pairing code (STORY\d)/.exec((await dm.tool('situation')).text)?.[1];
  assert.ok(code, 'the storyteller says how to pair');
  assert.equal(await page.evaluate(() => oceanStoryteller.door.state), 'apart');
  assert.equal(await page.evaluate(() => Boolean(document.getElementById('storyteller-code'))), true, 'its place is in the Captain panel');
  await page.evaluate((wrong) => oceanStoryteller.door.pair(wrong), 'WRONG' + code[5]);
  await page.waitForFunction(() => /not the storyteller's code/.test(oceanStoryteller.door.said), null, { timeout: 20000 });
  // Typed into the game's own dialog, the right one joins.
  await page.evaluate((right) => { const field = document.getElementById('storyteller-code'); field.value = right.toLowerCase(); field.form.requestSubmit(); }, code);
  await page.waitForFunction(() => oceanStoryteller.door.state === 'paired', null, { timeout: 20000 });

  // The lore's home, then where the game stands: from the model and the game's own state.
  const lore = (await dm.tool('lore_open', { folder: path.join(dir, 'lore') })).data;
  assert.equal(lore.game, 'paired'); assert.equal(lore.mateChosen, false);
  const now = (await dm.tool('situation')).data;
  assert.equal(now.where.name, 'Lisboa'); assert.equal(now.where.living, true); assert.equal(now.where.ashore, false); assert.equal(now.mate.name, chosen.name, 'the mate signed on in the game is the storyteller\'s to be');
  assert.ok(now.ship.headingDeg >= 0 && now.ship.headingDeg < 360 && now.ship.windFrom >= 0 && now.ship.windFrom < 360 && now.ship.windWords, JSON.stringify(now.ship));
  assert.equal(now.date.year, 1550); assert.ok(now.realm.people > 10000 && now.realm.monarch, JSON.stringify(now.realm)); assert.ok(now.ship.class, JSON.stringify(now.ship));
  t.diagnostic(`${now.date.text}; ${now.realm.monarch}; ${now.realm.people} people; treasury ${now.realm.treasury}; ${now.ship.name ?? now.ship.class}`);
  const town = (await dm.tool('world', { path: 'settlement:Lisboa' })).data;
  assert.ok(JSON.stringify(town).length > 200, 'the town as the model keeps it');
  const found = (await dm.tool('find', { name: 'Lisboa' })).data;
  assert.ok(JSON.stringify(found).includes('Lisboa'));

  // Who else might sign on: real people of the port, none of them at a post, and not the one already at sea. The
  // storyteller takes the mate the player signed on: their page is written, and nothing in the game is changed.
  const candidates = (await dm.tool('mate_candidates', { n: 6 })).data;
  assert.ok(Array.isArray(candidates) && candidates.length >= 3, JSON.stringify(candidates).slice(0, 300));
  const posted = new Set(await page.evaluate(() => oceanFolk.posts.map((p) => p.soul.id)));
  for (const one of candidates) { assert.ok(Number.isFinite(one.id) && one.name && one.age >= 18 && one.age <= 46 && !posted.has(one.id) && one.id !== chosen.id, JSON.stringify(one)); }
  t.diagnostic(candidates.map((one) => `${one.name}, ${one.age}, ${one.role ?? 'no calling'}`).join(' | '));
  const signed = (await dm.tool('mate_choose', { person: chosen.id })).data;
  assert.equal(signed.mate.name, chosen.name);
  const matePage = fs.readFileSync(path.join(dir, 'lore', 'mate.md'), 'utf8');
  assert.ok(matePage.startsWith(`# ${chosen.name}, first mate`) && matePage.includes(`Number in the game: p${chosen.id}.`) && /Signed on at Lisboa/.test(matePage), matePage.slice(0, 300));
  assert.deepEqual(await page.evaluate(() => ({ id: oceanStoryteller.mate.id, name: oceanStoryteller.mate.name, port: oceanStoryteller.mate.port })), { id: chosen.id, name: chosen.name, port: 'Lisboa' });
  assert.equal((await dm.tool('situation')).data.mate.name, chosen.name);

  // Aboard there is no figure of them ashore. The captain lands: the mate stands beside them, drawn by the GPU.
  assert.equal(await page.evaluate(() => oceanStoryteller.figure), null);
  await page.evaluate(() => oceanCaptain.walk());
  assert.equal(await page.evaluate(() => oceanCaptain.ashore), true);
  await page.waitForFunction(() => oceanStoryteller.figure?.drawn, null, { timeout: 30000, polling: 100 });
  const landed = await page.evaluate(() => ({ figure: oceanStoryteller.figure, eye: oceanCaptain.eye }));
  assert.equal(landed.figure.name, chosen.name); assert.ok(landed.figure.fromCaptain < 2.6, `${landed.figure.fromCaptain} m`);
  // They walk the streets no more.
  await page.waitForFunction((id) => oceanFolk.plan.laid >= 1 && !oceanFolk.souls.some((soul) => soul?.id === id), chosen.id, { timeout: 240000, polling: 300 });

  // The captain walks on; the mate comes after, and stops a step behind.
  const startAt = landed.eye;
  await page.keyboard.down('ShiftLeft'); await page.keyboard.down('KeyW'); await page.waitForTimeout(5000);
  const during = await page.evaluate(() => oceanStoryteller.figure);
  await page.keyboard.up('KeyW'); await page.keyboard.up('ShiftLeft'); await page.waitForTimeout(3500);
  const after = await page.evaluate(() => ({ figure: oceanStoryteller.figure, eye: oceanCaptain.eye }));
  const walked = Math.hypot(after.eye.x - startAt.x, after.eye.z - startAt.z), followed = Math.hypot(after.figure.at.x - landed.figure.at.x, after.figure.at.z - landed.figure.at.z);
  t.diagnostic(`the captain walked ${walked.toFixed(1)} m, the mate ${followed.toFixed(1)} m; ${after.figure.fromCaptain.toFixed(2)} m apart at rest`);
  assert.ok(walked > 6, `the captain walked ${walked} m`); assert.ok(followed > walked - 4, `the mate came ${followed} m of ${walked}`);
  assert.ok(after.figure.fromCaptain <= 2.6 && after.figure.going === false, JSON.stringify(after.figure)); assert.ok(during, 'in being all the way');

  // Asked by a button while a storyteller is by, the mate still answers at once, and the storyteller is told.
  const again = await answered('How are our stores?');

  // Turned to face them, the mate is under the pointer by name, and their card has a place to speak to them.
  await page.evaluate(() => { const f = oceanStoryteller.figure, eye = oceanCaptain.eye; oceanCaptain.look(Math.atan2(f.at.x - eye.x, -(f.at.z - eye.z)), -0.2); });
  await page.waitForFunction(() => oceanStoryteller.figure?.seen?.tall > 60, null, { timeout: 15000, polling: 100 });
  await page.waitForTimeout(600);
  const seen = await page.evaluate(() => oceanStoryteller.figure.seen);
  await page.screenshot({ path: path.join(SHOTS, 'first-mate-ashore.png') });
  await page.mouse.move(seen.x + 30, seen.y + 30); await page.mouse.move(seen.x, seen.y, { steps: 4 }); await page.waitForTimeout(400);
  const label = await page.evaluate(() => { const el = document.getElementById('folk-name'); return el && !el.hidden ? el.textContent : null; });
  assert.ok(label && label.startsWith(chosen.name) && label.endsWith(' · first mate'), String(label));
  await page.mouse.down(); await page.mouse.up();
  await page.waitForFunction(() => document.querySelector('#folk-card .folk-talk input'), null, { timeout: 60000, polling: 200 });
  await page.fill('#folk-card .folk-talk input', 'What do they say of the Queen in the taverns?'); await page.keyboard.press('Enter');

  // The storyteller hears what the player did, in order, and answers on the player's screen as the mate.
  const heard = (await dm.tool('events', { wait: 5 })).data;
  const kinds = heard.events.map((one) => one.kind);
  assert.ok(kinds.includes('joined') && kinds.includes('ashore') && kinds.includes('spoke') && kinds.includes('counsel'), kinds.join(','));
  const counsel = heard.events.find((one) => one.kind === 'counsel');
  assert.deepEqual({ topic: counsel.topic, asked: counsel.asked, answer: counsel.answer }, { topic: 'stores', asked: 'How are our stores?', answer: again.text }, 'what the mate said by a button is told to the storyteller');
  const spoke = heard.events.find((one) => one.kind === 'spoke');
  assert.deepEqual({ to: spoke.to, person: spoke.person, name: spoke.name, text: spoke.text }, { to: 'mate', person: chosen.id, name: chosen.name, text: 'What do they say of the Queen in the taverns?' });
  assert.equal((await dm.tool('say', { text: 'That she counts her coin twice, captain, and her friends once.' })).failed, false);
  assert.equal((await dm.tool('narrate', { text: 'A bell rings over the Ribeira.' })).failed, false);
  await page.waitForFunction(() => /counts her coin twice/.test(document.getElementById('storyteller-says')?.innerText ?? ''), null, { timeout: 10000 });
  const says = await page.evaluate(() => document.getElementById('storyteller-says').innerText);
  assert.ok(says.includes(chosen.name + ': ') && says.includes('A bell rings over the Ribeira.') && says.includes('You: '), says);
  await page.screenshot({ path: path.join(SHOTS, 'first-mate-speaks.png') });

  // Someone else in sight is briefed for a subagent from the game's card of them, with only what they could know of the captain.
  const about = (await dm.tool('nearby')).data;
  assert.equal(about.ashore, true); assert.ok(about.aboutTheTown > 100, `${about.aboutTheTown} about the town`);
  const other = [...about.inSight, ...about.atPosts].find((one) => one.id !== chosen.id);
  if (other) {
    const brief = (await dm.tool('character_brief', { person: other.id, direction: 'They are wary of strangers today.' })).text;
    assert.ok(brief.includes(other.name) && /Lisboa/.test(brief) && /wary of strangers/.test(brief), brief.slice(0, 400));
    assert.ok(!/pf_|captain@example\.com|u_story/.test(brief));
    t.diagnostic(`briefed ${other.name}: ${brief.length} characters`);
  }

  // The town's monthly reckoning (its eighth day) comes and goes: the model has not buried someone who is at sea,
  // and its card of them says where they went.
  await page.waitForFunction(() => { const at = /^(\w+) (\d+), AD/.exec(oceanBoard.status?.date ?? ''); return at && (at[1] !== 'Spring' || Number(at[2]) >= 9); }, null, { timeout: 300000, polling: 500 });
  const theirs = await page.evaluate((id) => oceanBoard.person(id).then((answer) => answer.card), chosen.id);
  assert.ok(theirs.startsWith(chosen.name) && /Went to sea from Lisboa as a ship's mate/.test(theirs) && !/Died at/.test(theirs), theirs.slice(-300));
  t.diagnostic(`${await page.evaluate(() => oceanBoard.status.date)}: ${theirs.split('\n').at(-1)}`);

  // Back aboard: no figure ashore. The mate is kept with the page's session, so a reload has them still.
  await page.evaluate(() => oceanCaptain.walk());
  await page.waitForFunction(() => oceanStoryteller.figure === null, null, { timeout: 10000 });
  assert.equal(await page.evaluate(() => { try { return JSON.parse(sessionStorage.getItem('waterworld.mate') ?? 'null')?.name ?? oceanStoryteller.mate.name; } catch { return null; } }), chosen.name);
  assert.deepEqual(errors, []);
  await page.close();
  // What went out under the account: figures only.
  dm.child.stdin.end(); await once(dm.child, 'exit');
  const sent = JSON.stringify(reported);
  assert.ok(reported.some((one) => one.k === 'game') && reported.some((one) => one.k === 'tool'), reported.map((one) => one.k).join(','));
  assert.ok(!/Queen in the taverns|counts her coin|bell rings|wary of strangers|in the chest|hands to feed|pf_/.test(sent) && !sent.includes(chosen.name), 'nothing said, and no one named');
});

// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The dungeon master's own parts, without the game: the lore it keeps in a folder of the player's, what a character
// it has played is told and is not, the first mate's page, and what it reports of its use (never what is said).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLore, lorePublic, LORE_MARKER, LORE_PAGES } from '../mcp/dm-lore.mjs';
import { DM_INSTRUCTIONS, characterBrief, matePage } from '../mcp/dm-text.mjs';
import { createTelemetry, telemetryEvent, telemetryError, telemetryGame, TELEMETRY_SHAPE, TELEMETRY_BATCH } from '../mcp/dm-telemetry.mjs';

const scratch = (t) => { const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ww-dm-')); t.after(() => fs.rmSync(dir, { recursive: true, force: true })); return fs.realpathSync(dir); };
const SCENE = {
  person: { id: 4821, name: 'Millán Bueno', age: 41.6, sex: 'm', role: 'merchant' },
  card: { facts: { Home: 'a house of two floors by the strand', Wife: 'Elvira Bueno', Children: 'Tomás (12), Inés (9)', Guild: 'the merchants of Lisboa', Unlisted: 'never shown' }, household: [{ name: 'Millán Bueno', age: 41 }, { name: 'Elvira Bueno', age: 38 }], nature: 'shrewd, proud', learning: 'letters and reckoning', life: ['Born Summer 3, AD 1508', 'Married Elvira, AD 1535'] },
  doing: 'on watch on the crown of the Torreão do Paço da Ribeira',
  place: { name: 'Lisboa', kind: 'capital', people: 19448, realm: 'Altoón', ruler: 'Queen Petronila' },
  date: { text: 'Spring 2, AD 1550' }, weather: 'clear', news: [{ date: 'Winter 80, AD 1549', text: 'The price of wheat rose in Lisboa.' }], harbour: 'A carrack lies in the roads',
};

test('the lore begins in a folder of its own, with pages that say what belongs on them', (t) => {
  const dir = scratch(t), config = path.join(dir, 'config.json'), folder = path.join(dir, 'lore');
  const lore = createLore({ configPath: config });
  assert.equal(lore.status().kept, 'nowhere');
  assert.throws(() => lore.read('plot.md'), /No lore is kept yet/);
  const opened = lore.open({ folder });
  assert.equal(opened.kept, 'folder'); assert.equal(opened.fresh, true); assert.equal(opened.captainWritten, false); assert.equal(opened.mateChosen, false);
  for (const name of Object.keys(LORE_PAGES)) assert.ok(fs.existsSync(path.join(folder, name)), name);
  assert.ok(fs.existsSync(path.join(folder, LORE_MARKER)) && fs.statSync(path.join(folder, 'people')).isDirectory());
  assert.match(lore.read('README.md').text, /mate\.md/);
  // The choice is remembered: another session opens the same lore without being told where, and overwrites nothing.
  lore.write('plot.md', '## Threads in play\n\n- The debt to the Buenos.', 'replace');
  const again = createLore({ configPath: config }), back = again.open();
  assert.equal(back.folder, lore.folder); assert.equal(back.fresh, false);
  assert.match(again.read('plot.md').text, /debt to the Buenos/);
  // The whole disk or the home folder is not a lore.
  assert.throws(() => lore.open({ folder: os.homedir() }), /folder of its own/);
  assert.throws(() => lore.open({ folder: path.parse(dir).root }), /folder of its own/);
});

test('only Markdown inside the folder is ever read or written', (t) => {
  const dir = scratch(t), lore = createLore({ configPath: path.join(dir, 'c.json') });
  lore.open({ folder: path.join(dir, 'lore') });
  for (const bad of ['../outside.md', '/etc/passwd', 'people/../../x.md', '.hidden.md', 'people/.x.md', 'notes.txt', '', 'people//x.md']) assert.throws(() => lore.write(bad, 'x'), /not a page|outside|Markdown/, bad);
  fs.writeFileSync(path.join(dir, 'secret.md'), 'not lore');
  fs.symlinkSync(path.join(dir, 'secret.md'), path.join(lore.folder, 'link.md'));
  assert.throws(() => lore.read('link.md'), /link, not a page/);
  fs.symlinkSync(dir, path.join(lore.folder, 'out'));
  assert.throws(() => lore.read('out/secret.md'), /leads outside/);
  assert.ok(!lore.list().some((one) => /link|out\//.test(one.file)));
  assert.throws(() => lore.write('big.md', 'x'.repeat(300 * 1024)), /too much/);
  assert.deepEqual(lore.write('places/lisboa.md', '# Lisboa', 'create').was, 'new');
  assert.throws(() => lore.write('places/lisboa.md', 'again', 'create'), /already written/);
  lore.write('places/lisboa.md', 'The Ribeira smells of tar.');
  assert.equal(lore.read('places/lisboa.md').text, '# Lisboa\nThe Ribeira smells of tar.\n');
  assert.equal(lore.search('tar ribeira')[0].file, 'places/lisboa.md');
});

test('what is recorded goes into the chronicle under the game\'s date and onto each person\'s page', (t) => {
  const dir = scratch(t), lore = createLore({ configPath: path.join(dir, 'c.json'), now: () => new Date('2026-11-11T10:00:00Z') });
  lore.open({ folder: path.join(dir, 'lore') });
  const done = lore.record({ entry: 'The captain bought wine of Millán Bueno and promised to carry his letter.', people: [{ id: 4821, name: 'Millán Bueno' }], place: 'Lisboa', date: 'Spring 2, AD 1550', thread: 'the letter' });
  assert.deepEqual(done.people, ['people/p4821-millan-bueno.md']);
  const chronicle = lore.read('chronicle.md').text;
  assert.match(chronicle, /## Spring 2, AD 1550 · Lisboa\n\nThe captain bought wine/); assert.match(chronicle, /With: Millán Bueno \(p4821\)\./); assert.match(chronicle, /Thread: the letter\./);
  lore.record({ entry: 'Millán was paid.', people: [{ id: 4821, name: 'Millan B.' }], place: 'Lisboa', date: 'Spring 9, AD 1550' });
  assert.equal(lore.list('people').length, 1, 'one page for one person, whatever they are called the second time');
  assert.equal((lore.read('people/p4821-millan-bueno.md').text.match(/^- /gm) ?? []).length, 2);
  assert.equal(lore.status().entries, 2);
  assert.throws(() => lore.record({ entry: '  ' }), /Say what happened/);
});

test('what is under "Private" never reaches a character', (t) => {
  const page = '# The captain\n\n## As anyone can see\n\nTall, sunburnt, a Biscayan accent.\n\n## Private\n\nWanted in Sevilla for a killing.\n\n### More\n\nAnd owes the crown.\n\n## Known hereabouts\n\nPays his debts.';
  const shown = lorePublic(page);
  assert.match(shown, /Tall, sunburnt/); assert.match(shown, /Pays his debts/);
  assert.doesNotMatch(shown, /Sevilla|owes the crown|Private/);
  const dir = scratch(t), lore = createLore({ configPath: path.join(dir, 'c.json') });
  lore.open({ folder: path.join(dir, 'lore') });
  lore.write('player.md', page, 'replace');
  lore.record({ entry: 'They quarrelled over the price.', people: [{ id: 4821, name: 'Millán Bueno' }], date: 'Spring 2, AD 1550' });
  lore.write(lore.personPage(4821), '\n## Private\n\nThe storyteller means him to betray the captain.');
  const brief = characterBrief(SCENE, { captain: lore.captain(), memories: lore.memories(4821), direction: 'He wants the letter carried to Porto' });
  assert.match(brief, /You are playing one person in a story, and no one else: Millán Bueno, 41, merchant of Lisboa\. It is Spring 2, AD 1550\./);
  assert.match(brief, /Tall, sunburnt/); assert.match(brief, /They quarrelled over the price/); assert.match(brief, /He wants the letter carried to Porto\./);
  assert.doesNotMatch(brief, /Sevilla|betray|owes the crown/);
});

test('a brief holds the person as the game keeps them, and nothing of the storyteller\'s', () => {
  const brief = characterBrief(SCENE);
  for (const told of ['- Wife: Elvira Bueno', '- Guild: the merchants of Lisboa', 'Under your roof: Millán Bueno (41), Elvira Bueno (38).', 'Your nature: shrewd, proud.', '- Married Elvira, AD 1535', 'the realm\'s chief town', 'in the realm of Altoón under Queen Petronila', 'Just now you are on watch on the crown of the Torreão do Paço da Ribeira.', 'The price of wheat rose in Lisboa.', 'A ship\'s captain, a stranger to you.', 'You have never met.']) assert.ok(brief.includes(told), told);
  assert.doesNotMatch(brief, /Unlisted|never shown|dungeon master|treasury/i);
  assert.match(characterBrief({ ...SCENE, person: { ...SCENE.person, age: 9, role: '' } }), /a child of 9/);
  // With nothing known, there is still someone to play.
  assert.match(characterBrief({ person: { name: 'Ana' } }), /You are playing one person in a story, and no one else: Ana\./);
});

test('the dungeon master is told it is the first mate, and the mate\'s page begins from the game\'s card', () => {
  for (const told of [/you are the captain's first mate/, /lore_open/, /mate_candidates/, /mate_choose/, /character_brief/, /Play no one but the mate/, /What the voyage has made of them/, /never make the captain a slaver/, /sign_in/, /signed a mate on in the game itself/, /tells you each as a counsel/, /That was you speaking: keep to it/]) assert.match(DM_INSTRUCTIONS, told);
  const page = matePage({ person: SCENE.person, card: SCENE.card, place: SCENE.place, date: SCENE.date });
  assert.match(page, /^# Millán Bueno, first mate\n\nNumber in the game: p4821\. Signed on at Lisboa, Spring 2, AD 1550\./);
  for (const told of ['- Age at signing on: 41', '- Calling before the sea: merchant', '- Nature: shrewd, proud', 'Left at home: Elvira Bueno (38).', '- Born Summer 3, AD 1508', '## How they speak', '## What the voyage has made of them', '## What they think of the captain']) assert.ok(page.includes(told), told);
  assert.doesNotMatch(page, /Not yet chosen/);
});

test('what is reported is rebuilt field by field: no sentence can ride along', () => {
  const said = 'I told the captain that Millán means to betray him at the fair';
  const event = telemetryEvent('tool', { tool: 'say', ms: 12.3456, failed: false, in: said.length, out: 2, text: said, error: said, entry: said, file: '/Users/someone/lore/plot.md', tool2: 'x' }, new Date('2026-11-11T10:00:00Z'));
  assert.deepEqual(event, { k: 'tool', at: '2026-11-11T10:00:00.000Z', ms: 12.346, in: said.length, out: 2, failed: false, tool: 'say' });
  assert.equal(telemetryEvent('conversation', { text: said }), null, 'a kind that is not listed is not an event');
  // A word is a short name; a sentence, a path or anything long is not.
  assert.equal(telemetryEvent('tool', { tool: said }).tool, undefined);
  assert.equal(telemetryEvent('tool', { tool: 'x'.repeat(49) }).tool, undefined);
  assert.equal(telemetryEvent('game', { port: 'São Vicente de Belém', date: 'Spring 2, AD 1550' }).port, 'São Vicente de Belém');
  assert.equal(telemetryEvent('game', { port: 'a\nb' }).port, undefined);
  assert.equal(telemetryEvent('tool', { error: 'game' }).error, 'game');
  assert.equal(telemetryEvent('tool', { error: 'something else' }).error, undefined);
  assert.equal(telemetryEvent('game', { people: '19448', war: 'yes', treasury: Infinity }).people, undefined);
  // Every listed field is a number, a flag or a word: there is no free text anywhere in the shape.
  for (const [kind, shape] of Object.entries(TELEMETRY_SHAPE)) assert.deepEqual(Object.keys(shape).sort(), ['flags', 'numbers', 'words'], kind);
  assert.equal(telemetryError(new Error('The game is not paired yet. Ask the player…')), 'unpaired');
  assert.equal(telemetryError(new Error('"../x.md" is outside the lore')), 'lore');
  assert.equal(telemetryError(new Error('Sign in with a Caiioo account first')), 'account');
});

test('the game\'s figures are taken from its situation; the reporter batches, keeps what is not taken, and sums a session', async () => {
  const figures = telemetryGame({ date: { text: 'Spring 2, AD 1550', day: 201455, year: 1550 }, realm: { name: 'Altoón', people: 23371, treasury: 2200, places: 11, war: false, plague: false }, where: { name: 'Lisboa', people: 19448, ashore: true, lat: 38.7, lon: -9.13 }, ship: { class: 'caravel' }, captain: { title: 'Master', worth: 812, coin: 300, cargo: [{ good: 'wine', units: 12 }, { good: 'salt', units: 30 }], note: 'never sent' }, voyage: { daysOut: 3, leagues: 41 }, mate: { id: 4821, name: 'Millán Bueno', age: 41, role: 'merchant' } });
  const event = telemetryEvent('game', figures);
  assert.equal(event.people, 23371); assert.equal(event.cargo, 42); assert.equal(event.mate, 4821); assert.equal(event.mateRole, 'merchant'); assert.equal(event.mateChosen, true); assert.equal(event.port, 'Lisboa');
  assert.ok(!JSON.stringify(event).includes('Millán'), 'the mate is a number and a calling, not a name');
  const sent = [], kept = [];
  let up = false, at = Date.parse('2026-11-11T10:00:00Z');
  const telemetry = createTelemetry({ send: async (batch) => { if (!up) return false; sent.push(batch); return true; }, spool: { load: () => [{ k: 'tool', at: '2026-11-10T09:00:00.000Z', tool: 'find', ms: 4, text: 'left over' }, { k: 'nonsense' }], save: (events) => kept.push(events) }, clock: () => new Date(at), every: 0 });
  assert.equal(telemetry.waiting, 1, 'what an earlier session could not send waits, cleaned again');
  telemetry.tool('say', 20, null, { in: 80, out: 2 }); telemetry.tool('inspect', 35, new Error('The game did not answer (is its tab asleep?)'));
  telemetry.briefed(4821); telemetry.briefed(4821); telemetry.briefed(77);
  telemetry.played([{ kind: 'spoke', text: 'a secret' }, { kind: 'spoke' }, { kind: 'landfall' }]);
  assert.ok(telemetry.game({ realm: { people: 5 } })); assert.equal(telemetry.game({ realm: { people: 6 } }), null, 'the figures are noted once in five minutes');
  assert.equal(await telemetry.flush(), false); assert.equal(telemetry.waiting, 6);
  assert.ok(!JSON.stringify(telemetry.peek()).includes('secret') && !JSON.stringify(telemetry.peek()).includes('left over'));
  assert.deepEqual(telemetry.peek().filter((one) => one.k === 'played').map((one) => [one.what, one.n]), [['spoke', 2], ['landfall', 1]]);
  assert.equal(telemetry.peek()[2].error, 'silent');
  up = true; at += 90000;
  for (let i = 0; i < TELEMETRY_BATCH + 5; i++) telemetry.tool('world', 1);
  await telemetry.end();
  assert.equal(telemetry.waiting, 0);
  const all = sent.flat();
  assert.ok(sent.every((batch) => batch.length <= TELEMETRY_BATCH)); assert.equal(all.length, 6 + TELEMETRY_BATCH + 5 + 1);
  assert.deepEqual({ ...all.at(-1), at: undefined }, { k: 'end', at: undefined, seconds: 90, calls: TELEMETRY_BATCH + 7, errors: 1, briefs: 3, persons: 2 });
  assert.deepEqual(kept, [[]], 'nothing is left for the next session');
});

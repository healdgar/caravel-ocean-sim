// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The lore of one game of Waterworld, kept as plain Markdown in a folder the player chose: who the captain is, what
// has happened, the threads of the plot, and a page for everyone and every place the story has touched. The dungeon
// master (mcp/waterworld-dm.mjs) reads and writes it through this store and through nothing else: no file outside
// the folder is touched, and only Markdown is written. Where the player keeps the lore somewhere this program
// cannot reach (a notes app, a drive), only that choice is remembered, and the agent keeps the same layout there
// with its own tools.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export const LORE_MARKER = 'waterworld-lore.json';
export const LORE_WRITE_MOST = 256 * 1024;
// A heading under which the storyteller keeps what no character may be told. It ends at the next heading of its
// rank or higher, or at the end of the page.
const PRIVATE_HEAD = /^(#{1,6})\s+private\b/i;

// The pages a new lore folder begins with. Each says what belongs on it, so the layout explains itself.
export const LORE_PAGES = Object.freeze({
  'README.md': `# The lore of this game

Kept by the dungeon master of Waterworld. Everything here is plain Markdown and may be read or edited by hand.

- \`player.md\`: the captain. What anyone can see, what is known of them in each port, and (under "Private") what only the storyteller knows.
- \`mate.md\`: the first mate, who is the storyteller's own voice in the story: what the game made them, how they speak, and what the voyages and the captain have made of them since.
- \`chronicle.md\`: what has happened, in order, dated by the game's calendar. Added to, never rewritten.
- \`plot.md\`: the threads in play: promises, debts, enemies, secrets, what the captain wants next.
- \`people/\`: a page for each person the story has touched, named by their number in the game (\`p1234-name.md\`): what passed between them and the captain, and what they now think. A "Private" section is never shown to the one who plays them.
- \`places/\`: a page for each port or place that matters.

What the game's own record says (the realm's annals, a person's household, a town's stores) is fact. What the storyteller made up is marked *(invented)* and kept consistent afterwards.
`,
  'player.md': `# The captain

## As anyone can see

(Looks, dress, bearing, speech. Not yet written: ask the player.)

## Known hereabouts

(What is said of the captain, port by port. Nothing yet.)

## Private

(What only the storyteller knows: what the captain wants, fears and hides.)
`,
  'mate.md': `# The first mate

(Not yet chosen. They are one of the people of the port the captain starts from: mate_candidates, then mate_choose.)
`,
  'chronicle.md': `# Chronicle

What has happened, in order. Each entry is dated by the game's calendar.
`,
  'plot.md': `# The plot

## Threads in play

(None yet.)

## Promises and debts

## Enemies and friends

## Secrets *(invented unless marked otherwise)*
`,
});

const slug = (text) => String(text ?? '').normalize('NFKD').replace(/[̀-ͯ]/g, '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 48);
const expand = (folder) => path.resolve(String(folder).replace(/^~(?=$|[\\/])/, os.homedir()));

// A page without what is under its "Private" headings: what a character, or anyone but the storyteller, may be told.
export function lorePublic(text) {
  const kept = [];
  let hidden = 0;
  for (const line of String(text ?? '').split('\n')) {
    const head = /^(#{1,6})\s/.exec(line);
    if (head) {
      if (PRIVATE_HEAD.test(line)) { hidden = head[1].length; continue; }
      if (hidden && head[1].length <= hidden) hidden = 0;
    }
    if (!hidden) kept.push(line);
  }
  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim();
}

/**
 * The store. `configPath` is where the player's choice of folder is remembered from one session to the next;
 * `now()` the clock entries are stamped by. Every method that touches a page throws a plain Error, with what to do
 * about it, when no folder is open or the page is not one of the lore's.
 */
export function createLore({ configPath = process.env.WATERWORLD_DM_CONFIG || path.join(os.homedir(), '.config', 'waterworld-dm', 'config.json'), now = () => new Date() } = {}) {
  let root = null, elsewhere = null;
  const remembered = () => { try { return JSON.parse(fs.readFileSync(configPath, 'utf8')); } catch { return {}; } };
  const remember = () => { try { fs.mkdirSync(path.dirname(configPath), { recursive: true }); fs.writeFileSync(configPath, JSON.stringify({ folder: root, elsewhere }, null, 1) + '\n'); } catch { /* a choice that cannot be remembered is asked for again */ } };
  const need = () => { if (!root) throw new Error(elsewhere ? `The lore is kept elsewhere (${elsewhere}): read and write it there with your own tools, in the layout lore_open described.` : 'No lore is kept yet. Ask the player where this game\'s lore should be kept, then call lore_open.'); return root; };

  // The page a name means: inside the folder, Markdown, no hidden files, and not through a link that leads out.
  function page(file) {
    const base = need(), name = String(file ?? '').replace(/\\/g, '/').replace(/^\/+/, '');
    if (!name || name.split('/').some((part) => !part || part.startsWith('.'))) throw new Error(`"${file}" is not a page of the lore`);
    if (!/\.md$/i.test(name)) throw new Error('The lore is kept as Markdown: a page\'s name ends in .md');
    const full = path.resolve(base, name);
    if (full !== base && !full.startsWith(base + path.sep)) throw new Error(`"${file}" is outside the lore`);
    let dir = path.dirname(full);
    while (!fs.existsSync(dir)) dir = path.dirname(dir);
    const real = fs.realpathSync(dir);
    if (real !== base && !real.startsWith(base + path.sep)) throw new Error(`"${file}" leads outside the lore`);
    if (fs.existsSync(full) && fs.lstatSync(full).isSymbolicLink()) throw new Error(`"${file}" is a link, not a page`);
    return { full, name };
  }
  const pages = (dir = '') => {
    const out = [], walk = (rel) => {
      for (const entry of fs.readdirSync(path.join(root, rel), { withFileTypes: true })) {
        if (entry.name.startsWith('.') || entry.isSymbolicLink()) continue;
        const at = rel ? rel + '/' + entry.name : entry.name;
        if (entry.isDirectory()) walk(at); else if (/\.md$/i.test(entry.name)) out.push(at);
      }
    };
    const from = String(dir ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (from) { const { full } = page(from + '/x.md'); if (!fs.existsSync(path.dirname(full))) return out; }
    walk(from);
    return out.sort();
  };

  // Open the lore: in `folder` (made, with its first pages, if it is new), or noted as kept `elsewhere`; with
  // neither, whatever was chosen before. Answers where it is and what it holds.
  function open({ folder = null, elsewhere: other = null } = {}) {
    if (!folder && !other) { const was = remembered(); folder = was.folder ?? null; other = folder ? null : was.elsewhere ?? null; }
    if (folder) {
      const dir = expand(folder);
      if (dir === path.parse(dir).root || dir === os.homedir()) throw new Error('Choose a folder of its own for the lore, not the whole disk or the home folder');
      fs.mkdirSync(dir, { recursive: true });
      const real = fs.realpathSync(dir), fresh = !fs.existsSync(path.join(real, LORE_MARKER));
      root = real; elsewhere = null;
      if (fresh) fs.writeFileSync(path.join(real, LORE_MARKER), JSON.stringify({ game: 'waterworld', version: 1, begun: now().toISOString() }, null, 1) + '\n');
      for (const [name, text] of Object.entries(LORE_PAGES)) if (!fs.existsSync(path.join(real, name))) fs.writeFileSync(path.join(real, name), text);
      for (const dir of ['people', 'places']) fs.mkdirSync(path.join(real, dir), { recursive: true });
      remember();
      return { ...status(), fresh };
    }
    if (other) { root = null; elsewhere = String(other).slice(0, 400); remember(); }
    return status();
  }
  function status() {
    if (root) {
      const all = pages(), chronicle = read('chronicle.md').text.split(/\n(?=## )/).slice(1);
      return { kept: 'folder', folder: root, pages: all.length, people: all.filter((p) => p.startsWith('people/')).length, places: all.filter((p) => p.startsWith('places/')).length,
        entries: chronicle.length, last: chronicle.slice(-3).map((entry) => entry.trim()), captainWritten: !/Not yet written/.test(read('player.md').text), mateChosen: !/Not yet chosen/.test(read('mate.md').text) };
    }
    if (elsewhere) return { kept: 'elsewhere', elsewhere, layout: Object.keys(LORE_PAGES).concat('people/p<number>-<name>.md', 'places/<name>.md'), pages: LORE_PAGES };
    return { kept: 'nowhere', ask: 'Ask the player where the lore of this game should be kept: a folder on this computer (lore_open {folder}), or another store you have tools for (lore_open {elsewhere: what and where}).' };
  }

  function read(file) { const { full, name } = page(file); return { file: name, text: fs.existsSync(full) ? fs.readFileSync(full, 'utf8') : '' }; }
  // `mode` is 'append' (the text goes after what is there), 'replace' (the page becomes the text) or 'create' (only
  // if there is no such page yet).
  function write(file, text, mode = 'append') {
    const { full, name } = page(file), body = String(text ?? '');
    if (Buffer.byteLength(body) > LORE_WRITE_MOST) throw new Error('That is too much for one writing: write it in parts');
    if (!['append', 'replace', 'create'].includes(mode)) throw new Error('mode is append, replace or create');
    const had = fs.existsSync(full);
    if (mode === 'create' && had) throw new Error(`${name} is already written: read it, then append or replace`);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    if (mode === 'append' && had) { const before = fs.readFileSync(full, 'utf8'); fs.writeFileSync(full, before + (before.endsWith('\n') ? '' : '\n') + body + (body.endsWith('\n') ? '' : '\n')); }
    else fs.writeFileSync(full, body + (body.endsWith('\n') ? '' : '\n'));
    return { file: name, bytes: fs.statSync(full).size, was: had ? 'there' : 'new' };
  }
  const list = (dir = '') => { need(); return pages(dir).map((file) => ({ file, bytes: fs.statSync(path.join(root, file)).size })); };
  // The passages that best answer some words: a page's paragraphs, scored by how often the words are in them.
  function search(query, most = 8) {
    need();
    const words = String(query ?? '').toLowerCase().split(/\s+/).filter(Boolean), found = [];
    if (!words.length) return found;
    for (const file of pages()) {
      const title = file.toLowerCase();
      for (const passage of fs.readFileSync(path.join(root, file), 'utf8').split(/\n\s*\n/)) {
        const low = passage.toLowerCase(), score = words.reduce((sum, word) => sum + (low.split(word).length - 1) + (title.includes(word) ? 0.5 : 0), 0);
        if (score >= 1) found.push({ file, score, text: passage.trim().slice(0, 700) });
      }
    }
    return found.sort((a, b) => b.score - a.score).slice(0, most);
  }

  // The page of a person, by their number in the game: the one already kept, or the name a new one would have.
  function personPage(id, name = '') {
    need();
    const prefix = `p${Number(id)}`, had = pages('people').find((file) => new RegExp(`^people/${prefix}(-|\\.md$)`).test(file));
    return had ?? `people/${prefix}${slug(name) ? '-' + slug(name) : ''}.md`;
  }
  // What a person's page holds that the one who plays them may be told (not its "Private" part), or ''.
  function memories(id) { const file = personPage(id), text = read(file).text; return text ? lorePublic(text) : ''; }
  // What anyone may know of the captain: the captain's page without its "Private" part.
  const captain = () => lorePublic(read('player.md').text);

  // Set down what happened: an entry in the chronicle under the game's date, and a line on the page of each person
  // it concerns. `people` are {id, name}; `date` and `place` come from the game where it is paired.
  function record({ entry, people = [], place = '', thread = '', date = '' }) {
    const what = String(entry ?? '').trim();
    if (!what) throw new Error('Say what happened');
    const who = (people ?? []).filter((one) => one && Number.isFinite(Number(one.id))).map((one) => ({ id: Number(one.id), name: String(one.name ?? '').trim() }));
    const head = `## ${date || 'Date not known'}${place ? ' · ' + place : ''}`, stamp = now().toISOString().slice(0, 16).replace('T', ' ');
    write('chronicle.md', `\n${head}\n\n${what}\n${who.length ? `\nWith: ${who.map((one) => `${one.name || 'someone'} (p${one.id})`).join(', ')}.\n` : ''}${thread ? `\nThread: ${thread}.\n` : ''}\n<!-- written ${stamp} -->`);
    const touched = [];
    for (const one of who) {
      const file = personPage(one.id, one.name);
      if (!read(file).text) write(file, `# ${one.name || 'p' + one.id}\n\nNumber in the game: p${one.id}. What the game keeps of them is read with inspect; this page is what has passed between them and the captain.\n\n## What has passed\n`, 'create');
      write(file, `- ${date || 'Date not known'}${place ? ', ' + place : ''}: ${what.replace(/\s*\n\s*/g, ' ')}`);
      touched.push(file);
    }
    return { chronicle: 'chronicle.md', people: touched };
  }

  return { open, status, read, write, list, search, record, memories, captain, personPage, get folder() { return root; }, get elsewhere() { return elsewhere; } };
}

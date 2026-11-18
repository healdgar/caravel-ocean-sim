// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Takes Castle and Commons' program out of its one page and stands it in assets/board/game.js, tuned by
// scripts/board-tuning.mjs.
// The other repository is only read, and only its index.html as committed at the commit pinned in
// assets/board/SOURCE.json (git show, so its working tree is never touched and nothing newer comes in):
//   node scripts/vendor-castle-and-commons.mjs [path to its checkout] [--commit <sha>]
// --commit pins another commit, when that game's generator has moved on and this one is to follow it.
// Or, when only the table has changed, tune again the program already taken, without the other repository:
//   node scripts/vendor-castle-and-commons.mjs --retune
// That undoes the passages it was tuned by (as many as SOURCE.json records), checks the program so recovered is the one
// taken to the character, and tunes it by the table as it stands.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOARD_TUNING, tuneBoardSource, untuneBoardSource } from './board-tuning.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const board = join(root, 'assets', 'board');
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const args = process.argv.slice(2), option = (name) => { const k = args.indexOf('--' + name); return k >= 0 ? args[k + 1] : null; };
const taken = JSON.parse(readFileSync(join(board, 'SOURCE.json'), 'utf8'));
const headerOf = (commit) => `// Castle and Commons: the game program, from ${commit}.\n` +
  '// Copyright (c) 2026 healdgar. MIT License; see assets/board/LICENSE. Its Math functions are fdlibm as ported in V8.\n' +
  '// Taken by scripts/vendor-castle-and-commons.mjs and tuned by scripts/board-tuning.mjs. Do not edit: change the table and take it again.\n';
let source, commit;
if (args.includes('--retune')) {
  const program = readFileSync(join(board, 'game.js'), 'utf8');
  let cut = 0;
  for (let line = 0; line < 3; line++) cut = program.indexOf('\n', cut) + 1;
  source = untuneBoardSource(program.slice(cut), taken.tuned);
  if (source.length !== taken.characters || sha256(source) !== taken.sha256) {
    throw new Error(`assets/board/game.js, untuned, is not the program taken from ${taken.commit.slice(0, 7)}: take it again from its repository`);
  }
  commit = taken.commit;
} else {
  const theirs = resolve(args.find((a, k) => !a.startsWith('--') && args[k - 1] !== '--commit') || join(root, '..', 'furlong-kingdom-annals'));
  commit = option('commit') || taken.commit;
  if (!/^[0-9a-f]{40}$/.test(commit)) throw new Error(`Pin a whole commit, not "${commit}"`);
  const html = execFileSync('git', ['-C', theirs, 'show', `${commit}:index.html`], { encoding: 'utf8', maxBuffer: 1 << 28 });
  // The page holds two bare scripts: a surveyed map, then the game. The same rule as its own tools/simulation-boundary.mjs.
  const open = '<script>', first = html.indexOf(open), start = html.indexOf(open, first + open.length), end = html.indexOf('</script>', start);
  if (first < 0 || start < 0 || end < 0) throw new Error(`Could not find the game program in index.html at ${commit}`);
  source = html.slice(start + open.length, end);
  if (!source.includes('function simTick(') || !source.includes('async function generateWorld(')) throw new Error('That script is not the game program');
}
writeFileSync(join(board, 'game.js'), headerOf(commit) + tuneBoardSource(source));
writeFileSync(join(board, 'SOURCE.json'), JSON.stringify({
  repository: 'furlong-kingdom-annals', commit, dirty: false, characters: source.length, sha256: sha256(source), tuned: BOARD_TUNING.length,
}, null, 2) + '\n');
console.log(`assets/board/game.js: ${source.length} characters of ${commit.slice(0, 7)}, ${BOARD_TUNING.length} passages tuned`);

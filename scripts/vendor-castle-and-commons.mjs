// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Takes Castle and Commons' program out of its one page and stands it in assets/board/game.js, tuned by
// scripts/board-tuning.mjs.
// The other repository is only read. Run again when that game's generator moves on:
//   node scripts/vendor-castle-and-commons.mjs [path to its checkout]
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
let source, commit, dirty, header;
if (process.argv[2] === '--retune') {
  const taken = JSON.parse(readFileSync(join(board, 'SOURCE.json'), 'utf8'));
  const program = readFileSync(join(board, 'game.js'), 'utf8');
  let cut = 0;
  for (let line = 0; line < 3; line++) cut = program.indexOf('\n', cut) + 1;
  header = program.slice(0, cut);
  source = untuneBoardSource(program.slice(cut), taken.tuned);
  if (source.length !== taken.characters || sha256(source) !== taken.sha256) {
    throw new Error(`assets/board/game.js, untuned, is not the program taken from ${taken.commit.slice(0, 7)}: take it again from its repository`);
  }
  ({ commit, dirty } = taken);
} else {
  const theirs = resolve(process.argv[2] || join(root, '..', 'furlong-kingdom-annals'));
  const html = readFileSync(join(theirs, 'index.html'), 'utf8');
  // The page holds two bare scripts: a surveyed map, then the game. The same rule as its own tools/simulation-boundary.mjs.
  const open = '<script>', first = html.indexOf(open), start = html.indexOf(open, first + open.length), end = html.indexOf('</script>', start);
  if (first < 0 || start < 0 || end < 0) throw new Error('Could not find the game program in ' + join(theirs, 'index.html'));
  source = html.slice(start + open.length, end);
  if (!source.includes('function simTick(') || !source.includes('async function generateWorld(')) throw new Error('That script is not the game program');
  const git = (...args) => execFileSync('git', ['-C', theirs, ...args], { encoding: 'utf8' }).trim();
  commit = git('rev-parse', 'HEAD');
  dirty = git('status', '--porcelain', '--', 'index.html') !== '';
  header = `// Castle and Commons: the game program, from ${commit}${dirty ? ' with uncommitted changes' : ''}.\n` +
    '// Copyright (c) 2026 healdgar. MIT License; see assets/board/LICENSE. Its Math functions are fdlibm as ported in V8.\n' +
    '// Taken by scripts/vendor-castle-and-commons.mjs and tuned by scripts/board-tuning.mjs. Do not edit: change the table and take it again.\n';
  writeFileSync(join(board, 'LICENSE'), readFileSync(join(theirs, 'LICENSE'), 'utf8'));
}
writeFileSync(join(board, 'game.js'), header + tuneBoardSource(source));
writeFileSync(join(board, 'SOURCE.json'), JSON.stringify({
  repository: 'furlong-kingdom-annals', commit, dirty, characters: source.length, sha256: sha256(source), tuned: BOARD_TUNING.length,
}, null, 2) + '\n');
console.log(`assets/board/game.js: ${source.length} characters of ${commit.slice(0, 7)}${dirty ? ' (dirty)' : ''}, ${BOARD_TUNING.length} passages tuned`);

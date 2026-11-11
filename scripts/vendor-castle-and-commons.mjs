// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Takes Castle and Commons' program out of its one page and stands it in assets/board/game.js, tuned by
// scripts/board-tuning.mjs.
// The other repository is only read. Run again when that game's generator moves on:
//   node scripts/vendor-castle-and-commons.mjs [path to its checkout]
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOARD_TUNING, tuneBoardSource } from './board-tuning.mjs';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const theirs = resolve(process.argv[2] || join(root, '..', 'furlong-kingdom-annals'));
const html = readFileSync(join(theirs, 'index.html'), 'utf8');
// The page holds two bare scripts: a surveyed map, then the game. The same rule as its own tools/simulation-boundary.mjs.
const open = '<script>', first = html.indexOf(open), start = html.indexOf(open, first + open.length), end = html.indexOf('</script>', start);
if (first < 0 || start < 0 || end < 0) throw new Error('Could not find the game program in ' + join(theirs, 'index.html'));
const source = html.slice(start + open.length, end);
if (!source.includes('function simTick(') || !source.includes('async function generateWorld(')) throw new Error('That script is not the game program');
const git = (...args) => execFileSync('git', ['-C', theirs, ...args], { encoding: 'utf8' }).trim();
const commit = git('rev-parse', 'HEAD'), dirty = git('status', '--porcelain', '--', 'index.html') !== '';
const header = `// Castle and Commons: the game program, from ${commit}${dirty ? ' with uncommitted changes' : ''}.\n` +
  '// Copyright (c) 2026 healdgar. MIT License; see assets/board/LICENSE. Its Math functions are fdlibm as ported in V8.\n' +
  '// Taken by scripts/vendor-castle-and-commons.mjs and tuned by scripts/board-tuning.mjs. Do not edit: change the table and take it again.\n';
writeFileSync(join(root, 'assets', 'board', 'game.js'), header + tuneBoardSource(source));
writeFileSync(join(root, 'assets', 'board', 'LICENSE'), readFileSync(join(theirs, 'LICENSE'), 'utf8'));
writeFileSync(join(root, 'assets', 'board', 'SOURCE.json'), JSON.stringify({
  repository: 'furlong-kingdom-annals', commit, dirty, characters: source.length,
  sha256: createHash('sha256').update(source).digest('hex'), tuned: BOARD_TUNING.length,
}, null, 2) + '\n');
console.log(`assets/board/game.js: ${source.length} characters of ${commit.slice(0, 7)}${dirty ? ' (dirty)' : ''}, ${BOARD_TUNING.length} passages tuned`);

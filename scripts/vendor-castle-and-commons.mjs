// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Takes Castle and Commons' program out of its one page and stands it in assets/board/game.js, fitted to this game by
// scripts/board-tuning.mjs and extended by the upstream copy-back tables in order: scripts/board-upstream.mjs,
// scripts/board-native.mjs, scripts/board-colonial.mjs, and scripts/board-forts.mjs.
// The other repository is only read, and only its index.html as committed at the commit pinned in
// assets/board/SOURCE.json (git show, so its working tree is never touched and nothing newer comes in):
//   node scripts/vendor-castle-and-commons.mjs [path to its checkout] [--commit <sha>]
// --commit pins another commit, when that game's generator has moved on and this one is to follow it.
// Or, when only the tables have changed, tune again the program already taken, without the other repository:
//   node scripts/vendor-castle-and-commons.mjs --retune
// That undoes the passages it was tuned by (as many of each table as SOURCE.json records), checks the program so
// recovered is the one taken to the character, and tunes it by the tables as they stand.
// Or, to verify offline without writing any files or touching any baked .world save:
//   node scripts/vendor-castle-and-commons.mjs --check   (aliases: --dry-run, --verify)
// That verifies SOURCE.json, untuning/retuning byte-for-byte against assets/board/game.js, AND verifies that every
// staged upstream copy-back passage in BOARD_UPSTREAM_PENDING applies cleanly to both raw and tuned sources, parses
// as valid JavaScript, stays free of Waterworld globals, and maps to its guarded runtime shim in assets/board/runtime.js.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { BOARD_TABLES, tuneBoardSource, untuneBoardSource } from './board-tuning.mjs';
import { BOARD_UPSTREAM_PENDING, applyPendingUpstream, undoPendingUpstream } from './board-upstream.mjs';

const defaultRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const sha256 = (text) => createHash('sha256').update(text).digest('hex');
const headerOf = (commit) => `// Castle and Commons: the game program, from ${commit}.\n` +
  '// Copyright (c) 2026 healdgar. MIT License; see assets/board/LICENSE. Its Math functions are fdlibm as ported in V8.\n' +
  '// Taken by scripts/vendor-castle-and-commons.mjs; tuned by scripts/board-tuning.mjs, then scripts/board-upstream.mjs. Do not edit: change the tables and take it again.\n';

const HOST_ONLY_PATTERNS = Object.freeze([
  /\bFURLONG_OPTIONS\b/,
  /\bPARTNER_PORTS_SEED\b/,
  /\bBOARD_MODEL\b/,
  /Tagus Estuary/,
  /\bLisboa\b/,
]);

function splitHeader(program) {
  let cut = 0;
  for (let line = 0; line < 3; line++) {
    const next = program.indexOf('\n', cut);
    if (next < 0) throw new Error('assets/board/game.js is missing its 3-line vendoring header');
    cut = next + 1;
  }
  return { header: program.slice(0, cut), body: program.slice(cut) };
}

export function verifyBoardVendoring({ root = defaultRoot } = {}) {
  const board = join(root, 'assets', 'board');
  const taken = JSON.parse(readFileSync(join(board, 'SOURCE.json'), 'utf8'));
  const program = readFileSync(join(board, 'game.js'), 'utf8');
  const runtime = readFileSync(join(board, 'runtime.js'), 'utf8');
  const { header, body } = splitHeader(program);

  if (header !== headerOf(taken.commit)) {
    throw new Error(`assets/board/game.js header does not match SOURCE.json commit ${taken.commit}`);
  }
  const appliedCounts = {};
  for (const { name, table } of BOARD_TABLES) {
    appliedCounts[name] = table.length;
    if (taken[name] !== table.length) {
      throw new Error(`SOURCE.json records ${name}=${taken[name]} but table has ${table.length} passages`);
    }
  }

  const rawSource = untuneBoardSource(body, taken);
  if (rawSource.length !== taken.characters || sha256(rawSource) !== taken.sha256) {
    throw new Error(`assets/board/game.js, untuned, is not the program taken from ${taken.commit.slice(0, 7)}`);
  }
  const retuned = tuneBoardSource(rawSource);
  if (retuned !== body) {
    throw new Error('tuneBoardSource(untuneBoardSource(game.js)) did not reproduce assets/board/game.js byte-for-byte');
  }

  // Verify every staged upstream copy-back passage applies cleanly to both raw and tuned Castle and Commons,
  // round-trips cleanly, compiles as valid JS, stays free of Waterworld host globals, and matches runtime.js.
  const seenIds = new Set();
  for (const entry of BOARD_UPSTREAM_PENDING) {
    if (!entry.id || seenIds.has(entry.id)) throw new Error(`Duplicate or missing staged upstream id: ${entry.id}`);
    seenIds.add(entry.id);
    if (!entry.why || !entry.find || !entry.replace) throw new Error(`Incomplete staged upstream entry: ${entry.id}`);
    for (const rx of HOST_ONLY_PATTERNS) {
      if (rx.test(entry.replace)) throw new Error(`Staged upstream entry "${entry.id}" leaks host-specific symbol matching ${rx}`);
    }
    if (!entry.runtimeHook || !runtime.includes(entry.runtimeHook)) {
      throw new Error(`Staged upstream entry "${entry.id}" runtimeHook "${entry.runtimeHook}" not found in assets/board/runtime.js`);
    }
    if (!entry.runtimeShim || !runtime.includes(entry.runtimeShim)) {
      throw new Error(`Staged upstream entry "${entry.id}" runtimeShim "${entry.runtimeShim}" not found in assets/board/runtime.js`);
    }
  }

  const rawWithPending = applyPendingUpstream(rawSource);
  if (undoPendingUpstream(rawWithPending) !== rawSource) {
    throw new Error('BOARD_UPSTREAM_PENDING did not round-trip cleanly against raw Castle and Commons source');
  }
  const tunedWithPending = applyPendingUpstream(body);
  if (undoPendingUpstream(tunedWithPending) !== body) {
    throw new Error('BOARD_UPSTREAM_PENDING did not round-trip cleanly against tuned assets/board/game.js');
  }

  // Compile-check the staged patched program in-memory to guarantee zero syntax regressions.
  new vm.Script(tunedWithPending, { filename: 'assets/board/game.js' });

  return {
    commit: taken.commit,
    characters: rawSource.length,
    sha256: taken.sha256,
    appliedCounts,
    pendingCount: BOARD_UPSTREAM_PENDING.length,
    pendingIds: BOARD_UPSTREAM_PENDING.map((entry) => entry.id),
  };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const root = defaultRoot;
  const board = join(root, 'assets', 'board');
  const args = process.argv.slice(2), option = (name) => { const k = args.indexOf('--' + name); return k >= 0 ? args[k + 1] : null; };
  if (args.includes('--check') || args.includes('--dry-run') || args.includes('--verify')) {
    const info = verifyBoardVendoring({ root });
    console.log(
      `OK assets/board/game.js: ${info.characters} characters of ${info.commit.slice(0, 7)}, ` +
      `applied ${JSON.stringify(info.appliedCounts)}, staged pending ${info.pendingCount} (${info.pendingIds.join(', ')})`,
    );
    process.exit(0);
  }
  const taken = JSON.parse(readFileSync(join(board, 'SOURCE.json'), 'utf8'));
  let source, commit;
  if (args.includes('--retune')) {
    const { body } = splitHeader(readFileSync(join(board, 'game.js'), 'utf8'));
    source = untuneBoardSource(body, taken);
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
  const counts = Object.fromEntries(BOARD_TABLES.map(({ name, table }) => [name, table.length]));
  writeFileSync(join(board, 'SOURCE.json'), JSON.stringify({
    repository: 'furlong-kingdom-annals', commit, dirty: false, characters: source.length, sha256: sha256(source), ...counts,
  }, null, 2) + '\n');
  console.log(`assets/board/game.js: ${source.length} characters of ${commit.slice(0, 7)}, passages ${JSON.stringify(counts)}`);
}

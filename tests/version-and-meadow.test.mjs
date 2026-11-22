// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { test } from 'node:test';
import { waterworldChannel, waterworldApiBase, getWaterworldBuild, formatBuildLabel } from '../js/version.js';

test('waterworldChannel and waterworldApiBase distinguish prod, test, and local mounts', () => {
  assert.equal(waterworldChannel({ pathname: '/waterworld/' }), 'prod');
  assert.equal(waterworldChannel({ pathname: '/waterworld' }), 'prod');
  assert.equal(waterworldChannel({ pathname: '/waterworld-test/' }), 'test');
  assert.equal(waterworldChannel({ pathname: '/waterworld-test' }), 'test');
  assert.equal(waterworldChannel({ pathname: '/waterworld-test/index.html' }), 'test');
  assert.equal(waterworldChannel({ pathname: '/' }), 'local');

  assert.equal(waterworldApiBase({ pathname: '/waterworld/' }), '/waterworld/api');
  assert.equal(waterworldApiBase({ pathname: '/waterworld-test/' }), '/waterworld-test/api');
  assert.equal(waterworldApiBase({ pathname: '/' }), '/waterworld/api');
});

test('getWaterworldBuild and formatBuildLabel format stamped build metadata cleanly', () => {
  const prev = globalThis.__WATERWORLD_BUILD__;
  try {
    globalThis.__WATERWORLD_BUILD__ = { version: '1.0.953', build: 953, commit: '1446384', branch: 'career-foundation', dirty: false, builtAt: '2026-11-22T03:40:00.000Z' };
    const info = getWaterworldBuild({ pathname: '/waterworld-test/' });
    assert.equal(info.channel, 'test');
    assert.equal(info.build, 953);
    assert.equal(formatBuildLabel(info), 'Build #953 · v1.0.953 (1446384)');
  } finally {
    if (prev === undefined) delete globalThis.__WATERWORLD_BUILD__;
    else globalThis.__WATERWORLD_BUILD__ = prev;
  }
});

test('createMeadowGrass never dereferences pack after clearing pack = null', () => {
  const src = fs.readFileSync(new URL('../js/meadow-grass.js', import.meta.url), 'utf8');
  const start = src.indexOf('export async function createMeadowGrass');
  const clearAt = src.indexOf('pack = null;', start);
  const end = src.indexOf('export async function createSectionMeadowGrass', clearAt);
  assert.ok(start >= 0 && clearAt > start && end > clearAt, 'found createMeadowGrass bounds');
  const afterClear = src.slice(clearAt + 'pack = null;'.length, end);
  assert.doesNotMatch(afterClear, /\bpack\./, 'pack.* must not be referenced after pack = null');
});

test('inland-water WGSL avoids world-coordinate lever-arm phase moire with rotating flow/shore vectors', () => {
  const src = fs.readFileSync(new URL('../js/wgsl/inland-water.js', import.meta.url), 'utf8');
  assert.doesNotMatch(src, /dot\(\s*p\s*,\s*kAxis\s*\)/, 'riverBarWave must not dot worldXZ with rotating kAxis');
  assert.doesNotMatch(src, /dot\(\s*p\s*,\s*kSide\s*\)/, 'riverBarWave must not dot worldXZ with rotating kSide');
  assert.doesNotMatch(src, /dot\(\s*pos[AB]\s*,\s*(?:across|dir)\s*\)/, 'fluvial UV/undulation must use intrinsic channel coords, not dot(worldXZ, rotatingFlow)');
  assert.match(src, /fn riverBarWave\(p:\s*vec2f,\s*chCoord:\s*vec2f/, 'riverBarWave takes intrinsic curvilinear channel coordinates');
  assert.match(src, /let\s+overSea\s*=\s*smoothstep\(/, 'estuary wings feather laterally whenever overlapping submerged sea bed');
});

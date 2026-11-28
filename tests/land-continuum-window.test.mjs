// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// A piece with a finer survey in it (Saba's bay) waits for every point's error outside the survey as well as in it.
// Until 2026-11-27 the coarse lattice's points were given no error to wait for whenever a window made the finest level
// finer than theirs, so they never left their coarser neighbours' line: all of Saba outside the bay was drawn as the
// plane between the piece's corners, under the sea.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bakeLandContinuumPiece } from '../js/land-continuum.js';

test('a windowed piece waits for the error of every coarse point outside its window, as one with no window does', () => {
  const grid = { x0: 0, z0: 0, g: 2 }, n = 33, cell = 8, heights = new Float32Array(n * n);
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) heights[j * n + i] = 40 * Math.sin(i * 0.37) * Math.cos(j * 0.29) + 3 * i;
  const wn = 65, wg = 128, win = new Float32Array(wn * wn);
  for (let j = 0; j < wn; j++) for (let i = 0; i < wn; i++) win[j * wn + i] = heights[((wg + j) >> 3) * n + ((wg + i) >> 3)];
  const plain = bakeLandContinuumPiece({ n, cell, heights, gx: 0, gz: 0, grid });
  const windowed = bakeLandContinuumPiece({ n, cell, heights, gx: 0, gz: 0, grid, window: { n: wn, cell: 1, gx: wg, gz: wg, heights: win } });
  let outside = 0, waiting = 0;
  for (let j = 0; j < n; j++) for (let i = 0; i < n; i++) {
    const x = i * cell, z = j * cell;
    if (x >= wg && x <= wg + wn - 1 && z >= wg && z <= wg + wn - 1) continue;
    if (plain.waitsAt(i, j) <= 0) continue;
    outside++;
    if (windowed.waitsAt(x, z) > 0) waiting++;
  }
  assert.ok(outside > 500, `${outside} coarse points wait for an error with no window`);
  assert.equal(waiting, outside, 'every one of them waits for one beside a window too');
});

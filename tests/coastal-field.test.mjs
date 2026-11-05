import assert from 'node:assert/strict';
import { test } from 'node:test';
import { coastalFieldStaleTiles, createCoastalFieldState } from '../js/coastal-field.js';
import { COASTAL_FIELD_SIZE, COASTAL_FIELD_SPAN_M, COASTAL_FIELD_TILE_TEXELS } from '../js/wgsl/terrain.js';

const TILES = COASTAL_FIELD_SIZE / COASTAL_FIELD_TILE_TEXELS, TILE_M = COASTAL_FIELD_SPAN_M / TILES;
const bake = (state, stale) => {
  for (const { slot, x, z } of stale) { state.ownerX[slot] = x; state.ownerZ[slot] = z; state.bakedGeneration[slot] = state.generation; }
};

test('a new field bakes every tile, nearest the camera first', () => {
  const { stale } = coastalFieldStaleTiles(createCoastalFieldState(), 100, 200);
  assert.equal(stale.length, TILES * TILES);
  assert.equal(new Set(stale.map((tile) => tile.slot)).size, TILES * TILES, 'each tile has its own slot');
  for (let i = 1; i < stale.length; i++) assert.ok(stale[i].distance >= stale[i - 1].distance);
});

test('sailing across a tile boundary rebakes only the row coming into range', () => {
  const state = createCoastalFieldState();
  bake(state, coastalFieldStaleTiles(state, 100, 100).stale);
  assert.equal(coastalFieldStaleTiles(state, 110, 110).stale.length, 0, 'moving within a tile costs nothing');
  const { stale } = coastalFieldStaleTiles(state, 100 + TILE_M, 100);
  assert.equal(stale.length, TILES);
  assert.ok(stale.every((tile) => tile.x === stale[0].x), 'a single column along the leading edge');
});

test('the window centre moves in whole tiles, so baked texels never shift under it', () => {
  const state = createCoastalFieldState();
  const a = coastalFieldStaleTiles(state, 10, 10), b = coastalFieldStaleTiles(state, 20, 20);
  assert.deepEqual([a.centreX, a.centreZ], [b.centreX, b.centreZ]);
  assert.equal(a.centreX % TILE_M, 0);
});

test('a change of ground or swell makes every tile stale again', () => {
  const state = createCoastalFieldState();
  bake(state, coastalFieldStaleTiles(state, 0, 0).stale);
  state.generation++;
  assert.equal(coastalFieldStaleTiles(state, 0, 0).stale.length, TILES * TILES);
});

// A river's banks are ground of the land's continuum: worked into tiles of how far they move the lattice's ground,
// and kept by the land's cut block by block, down to the banks' own cell where they move it and nowhere else.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { bakeLandBanks, landBankMark } from '../js/land-banks.js';
import { bakeLandContinuumPiece } from '../js/land-continuum.js';
import { LAND_CONTINUUM_NODE_WORDS } from '../js/wgsl/land-continuum.js';
import { LAND_BANK_LEVEL, LAND_BANK_TEXELS } from '../js/wgsl/land-banks.js';

// Flat ground 5 m up, and a bank strip a metre below it from x = 40 to 80 m, z = 60 to 64 m: two triangles, as the
// board meshes them (x y z, normal, kind 2, wetness).
const GROUND = 5;
const strip = () => {
  const v = (x, z) => [x, GROUND - 1, z, 0, 1, 0, 2, 0.8];
  return { bankVerts: new Float32Array([...v(40, 60), ...v(80, 60), ...v(80, 64), ...v(40, 64)]), bankIndices: new Uint32Array([0, 2, 1, 0, 3, 2]) };
};
const REGION = { x: 64, z: 64, span: 128 };

test('a bank is laid in tiles of how far it moves the ground, how much is bank and how wet', () => {
  const baked = bakeLandBanks(strip(), REGION, () => GROUND);
  assert.ok(baked && baked.tiles.length >= 2 && baked.tiles.length <= 6, `${baked?.tiles.length} tiles`);
  const at = (x, z) => {
    const tile = baked.tiles.find((t) => x >= t.x && x <= t.x + 32 && z >= t.z && z <= t.z + 32 && t.texels[((Math.round((z - t.z) * 2)) * LAND_BANK_TEXELS + Math.round((x - t.x) * 2)) * 4 + 1] > 0);
    if (!tile) return [0, 0, 0];
    const k = (Math.round((z - tile.z) * 2) * LAND_BANK_TEXELS + Math.round((x - tile.x) * 2)) * 4;
    return [...tile.texels.subarray(k, k + 3)];
  };
  const [moved, cover, wet] = at(60, 62);
  assert.ok(Math.abs(moved + 1) < 1e-6 && cover === 1 && Math.abs(wet - 0.8) < 1e-6, `${moved} ${cover} ${wet}`);
  assert.deepEqual(at(60, 70), [0, 0, 0], 'off the bank, the lattice');
  assert.equal(bakeLandBanks(null, REGION, () => GROUND), null, 'no river, no banks');
});

test('the land\'s cut keeps the banks block by block, down to their own cell where they move the ground and nowhere else', () => {
  const mark = landBankMark(bakeLandBanks(strip(), REGION, () => GROUND));
  assert.equal(mark.finest, LAND_BANK_LEVEL);
  assert.equal(mark.at(60, 62), 1, 'the strip moves its ground a metre');
  assert.equal(mark.at(60, 90), 0);
  assert.equal(mark.over(0, 32, 96, 128), 0, 'ground the banks leave as it was');
  assert.equal(mark.over(0, 128, 0, 128), 1);
  for (let i = 0; i < 300; i++) {
    const ax = (i * 37) % 120, az = 40 + ((i * 53) % 40), w = 0.5 + (i % 9) * 1.5, over = mark.over(ax, ax + w, az, az + w);
    for (let k = 0; k <= 4; k++) assert.ok(mark.at(ax + w * k / 4, az + w * ((k * 3) % 5) / 4) <= over, `a point of [${ax}, ${ax + w}] x [${az}, ${az + w}]`);
  }
  // A flat coast of 17 points 8 m apart, the bank laid on it.
  const n = 17, grid = { x0: 0, z0: 0, g: 1 }, baked = bakeLandContinuumPiece({ n, cell: 8, heights: new Float32Array(n * n).fill(GROUND), gx: 0, gz: 0, grid, marks: [mark] });
  const W = LAND_CONTINUUM_NODE_WORDS, words = baked.nodes, floats = new Float32Array(words.buffer, words.byteOffset, words.length);
  const unit = grid.g * 2 ** baked.shiftF;
  let finest = 0;
  for (let i = 0; i < baked.count; i++) {
    const o = i * W, level = words[o + 8], w = words[o + 9] * 2 ** level * unit, x0 = words[o + 6] * unit, z0 = words[o + 7] * unit;
    const under = mark.over(x0, x0 + w, z0, z0 + w), leaf = words[o + 11] === 1;
    if (!leaf) {
      assert.ok(under > 0 || level > baked.bs, `a patch over ground the banks leave as it was is not split: level ${level} at ${x0}, ${z0}`);
      assert.ok(floats[o + 4] >= under, `a patch keeps what the banks move under it: ${floats[o + 4]} < ${under}`);
    } else if (under > 0) assert.equal(level, LAND_BANK_LEVEL, `a patch over the bank comes down to the bank's cell: level ${level} at ${x0}, ${z0}`);
    if (leaf && level === LAND_BANK_LEVEL) finest++;
  }
  assert.ok(finest > 0 && finest < 64, `${finest} patches at the bank's cell, of 256 over the whole coast`);
});

test('the banks are the land\'s, drawn by its continuum and by no mesh of their own', () => {
  const read = (path) => fs.readFileSync(new URL(`../${path}`, import.meta.url), 'utf8');
  const terrain = read('js/terrain.js'), banks = read('js/land-banks.js'), render = read('js/wgsl/land-continuum.js');
  assert.match(terrain, /landBanks\.set\(riverCut,activeRegion,baseGroundSample\)/);
  assert.match(terrain, /marks:\[\.\.\.craterLedger\.records\.map\(landCraterMark\),\.\.\.\(landBanks\.mark\?\[landBanks\.mark\]:\[\]\)\]/);
  assert.match(render, /vec2f\(2\.0,bank\.z\),bank\.y>0\.5/, 'bank ground is drawn as bank (kind 2), as wet as it is');
  assert.doesNotMatch(banks, /createRenderPipeline|beginRenderPass|draw(Indexed)?\(/, 'the banks draw nothing of their own');
});

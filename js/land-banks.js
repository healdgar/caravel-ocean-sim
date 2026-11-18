// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// A river's banks, laid into the land (js/wgsl/land-banks.js for what the GPU reads). The board cuts its rivers' beds
// into the land's lattice and meshes their banks finer than the lattice can hold them (riverCut in
// js/old-world-board.js: bank vertices x y z, normal, kind 2, wetness). Once, when a coast's land is laid or its board
// changes, that mesh is worked into tiles of how far it moves the lattice's ground (the land's continuum draws the
// lattice with it, js/wgsl/land-continuum.js), how much of the ground is bank, and how wet; and into blocks of the most
// it moves the ground, which the land's cut keeps (landContinuumDig in js/land-continuum.js) so it comes down to the
// banks' own cell where they are and nowhere else. Height queries keep the lattice, as they did beside the old mesh.
import {
  LAND_BANK_TILE_M, LAND_BANK_CELLS, LAND_BANK_CELL_M, LAND_BANK_TEXELS, LAND_BANK_ATLAS_TILES, LAND_BANK_BLOCK_M,
  LAND_BANK_BLOCKS, LAND_BANK_LEVEL,
} from './wgsl/land-banks.js';

// Less than this the banks move the ground is left to the lattice's own triangles.
const LAND_BANK_LEAST_M = 0.01;
// Edges this near a block's are counted as touching it, whichever side a float rounds a point to.
const LAND_BANK_EDGE_M = 0.01;
// The atlas is at most this many rows of tiles (a texture's side, 8192, over a tile's texels).
const LAND_BANK_ATLAS_ROWS = Math.floor(8192 / LAND_BANK_TEXELS);

const landBankFloat = new Float32Array(1), landBankBits = new Uint32Array(landBankFloat.buffer);
// A half float's bits, rounded to nearest.
function landBankHalf(value) {
  landBankFloat[0] = value;
  const x = landBankBits[0], sign = (x >>> 16) & 0x8000, exp = (x >>> 23) & 0xff, mant = x & 0x7fffff;
  if (exp === 0xff) return sign | 0x7c00 | (mant ? 0x200 : 0);
  const e = exp - 112;
  if (e >= 31) return sign | 0x7c00;
  if (e <= 0) return e < -10 ? sign : sign | ((((mant | 0x800000) >> (1 - e)) + 0x1000) >> 13);
  return sign | (((e << 10) | (mant >> 13)) + ((mant >> 12) & 1));
}

/**
 * The banks of a coast, worked out. `riverCut` {bankVerts, bankIndices}; `region` the coast's {x, z, span}, which the
 * lookup covers; `surfaceAt(x, z)` the lattice's own ground, which the tiles hold the banks' departure from. Null with
 * no banks. Each tile: its place, its texels (moved, bank, wet) and the most it moves the ground over each block.
 */
export function bakeLandBanks(riverCut, region, surfaceAt) {
  const V = riverCut?.bankVerts, I = riverCut?.bankIndices;
  if (!V?.length || !I?.length || !region) return null;
  const T = LAND_BANK_TILE_M, C = LAND_BANK_CELL_M, X = LAND_BANK_TEXELS;
  const ox = Math.floor((region.x - region.span / 2) / T) * T, oz = Math.floor((region.z - region.span / 2) / T) * T;
  const across = Math.ceil((region.x + region.span / 2 - ox) / T) + 1;
  const tiles = new Map();
  const tileAt = (ix, iz) => {
    const key = iz * across + ix;
    let tile = tiles.get(key);
    if (!tile) tiles.set(key, tile = { ix, iz, x: ox + ix * T, z: oz + iz * T, top: new Float32Array(X * X).fill(-Infinity), wet: new Float32Array(X * X) });
    return tile;
  };
  // Every triangle onto every texel it covers; where two strips cross, the higher ground, as it was seen.
  for (let t = 0; t + 2 < I.length; t += 3) {
    const a = I[t] * 8, b = I[t + 1] * 8, c = I[t + 2] * 8;
    const ax = V[a], az = V[a + 2], bx = V[b], bz = V[b + 2], cx = V[c], cz = V[c + 2];
    const den = (bz - cz) * (ax - cx) + (cx - bx) * (az - cz);
    if (Math.abs(den) < 1e-9) continue;
    const x0 = Math.min(ax, bx, cx), x1 = Math.max(ax, bx, cx), z0 = Math.min(az, bz, cz), z1 = Math.max(az, bz, cz);
    const ix0 = Math.max(0, Math.floor((x0 - ox) / T)), ix1 = Math.min(across - 1, Math.floor((x1 - ox) / T));
    const iz0 = Math.max(0, Math.floor((z0 - oz) / T)), iz1 = Math.min(across - 1, Math.floor((z1 - oz) / T));
    for (let iz = iz0; iz <= iz1; iz++) for (let ix = ix0; ix <= ix1; ix++) {
      const tx = ox + ix * T, tz = oz + iz * T;
      const i0 = Math.max(0, Math.ceil((x0 - tx) / C - 1e-6)), i1 = Math.min(X - 1, Math.floor((x1 - tx) / C + 1e-6));
      const j0 = Math.max(0, Math.ceil((z0 - tz) / C - 1e-6)), j1 = Math.min(X - 1, Math.floor((z1 - tz) / C + 1e-6));
      if (i0 > i1 || j0 > j1) continue;
      let tile = null;
      for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
        const px = tx + i * C, pz = tz + j * C;
        const u = ((bz - cz) * (px - cx) + (cx - bx) * (pz - cz)) / den, v = ((cz - az) * (px - cx) + (ax - cx) * (pz - cz)) / den, w = 1 - u - v;
        if (u < -1e-6 || v < -1e-6 || w < -1e-6) continue;
        const y = u * V[a + 1] + v * V[b + 1] + w * V[c + 1], k = j * X + i;
        tile ??= tileAt(ix, iz);
        if (y > tile.top[k]) { tile.top[k] = y; tile.wet[k] = Math.max(0, Math.min(1, u * V[a + 7] + v * V[b + 7] + w * V[c + 7])); }
      }
    }
  }
  if (!tiles.size) return null;
  const list = [...tiles.values()].slice(0, LAND_BANK_ATLAS_TILES * LAND_BANK_ATLAS_ROWS);
  const B = LAND_BANK_BLOCKS, step = LAND_BANK_BLOCK_M / C;
  let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
  list.forEach((tile, slot) => {
    tile.slot = slot;
    tile.texels = new Float32Array(X * X * 4);
    for (let j = 0; j < X; j++) for (let i = 0; i < X; i++) {
      const k = j * X + i;
      if (tile.top[k] === -Infinity) continue;
      tile.texels.set([tile.top[k] - surfaceAt(tile.x + i * C, tile.z + j * C), 1, tile.wet[k], 0], k * 4);
    }
    // Each block's most: every texel its ground is drawn from, its edges' too.
    tile.blocks = new Float32Array(B * B);
    tile.most = 0;
    for (let bj = 0; bj < B; bj++) for (let bi = 0; bi < B; bi++) {
      let most = 0;
      for (let j = bj * step; j <= (bj + 1) * step; j++) for (let i = bi * step; i <= (bi + 1) * step; i++) most = Math.max(most, Math.abs(tile.texels[(j * X + i) * 4]));
      tile.blocks[bj * B + bi] = most < LAND_BANK_LEAST_M ? 0 : most;
      tile.most = Math.max(tile.most, tile.blocks[bj * B + bi]);
    }
    delete tile.top; delete tile.wet;
    x0 = Math.min(x0, tile.x); x1 = Math.max(x1, tile.x + T); z0 = Math.min(z0, tile.z); z1 = Math.max(z1, tile.z + T);
  });
  return { ox, oz, across, tiles: list, bounds: [x0, x1, z0, z1], dropped: tiles.size - list.length };
}

/**
 * The banks as the land's cut keeps them (landContinuumDig in js/land-continuum.js): the square they reach; `over`,
 * the most they move the ground over the blocks a world rectangle touches; `at`, over the block a point is in, the
 * figure the GPU reads (landBankWaits); and the level their own cell is drawn at.
 */
export function landBankMark(baked) {
  const T = LAND_BANK_TILE_M, B = LAND_BANK_BLOCK_M, N = LAND_BANK_BLOCKS, E = LAND_BANK_EDGE_M, { ox, oz, across } = baked;
  const slots = new Int32Array(across * across).fill(-1);
  for (const tile of baked.tiles) slots[tile.iz * across + tile.ix] = tile.slot;
  const [x0, x1, z0, z1] = baked.bounds;
  const block = (gx, gz) => {
    const ix = Math.floor(gx / N), iz = Math.floor(gz / N);
    if (ix < 0 || iz < 0 || ix >= across || iz >= across) return 0;
    const slot = slots[iz * across + ix];
    return slot < 0 ? 0 : baked.tiles[slot].blocks[(gz - iz * N) * N + (gx - ix * N)];
  };
  return {
    x0, x1, z0, z1, finest: LAND_BANK_LEVEL,
    over(ax, bx, az, bz) {
      if (bx < x0 - E || ax > x1 + E || bz < z0 - E || az > z1 + E) return 0;
      // The blocks touched, by their place from the lookup's origin, and the tiles that hold them.
      const gx0 = Math.ceil((ax - E - ox) / B) - 1, gx1 = Math.floor((bx + E - ox) / B), gz0 = Math.ceil((az - E - oz) / B) - 1, gz1 = Math.floor((bz + E - oz) / B);
      const ix0 = Math.max(0, Math.floor(gx0 / N)), ix1 = Math.min(across - 1, Math.floor(gx1 / N)), iz0 = Math.max(0, Math.floor(gz0 / N)), iz1 = Math.min(across - 1, Math.floor(gz1 / N));
      let most = 0;
      const visit = (tile) => {
        if (tile.ix < ix0 || tile.ix > ix1 || tile.iz < iz0 || tile.iz > iz1 || tile.most <= most) return;
        const bi0 = Math.max(0, gx0 - tile.ix * N), bi1 = Math.min(N - 1, gx1 - tile.ix * N), bj0 = Math.max(0, gz0 - tile.iz * N), bj1 = Math.min(N - 1, gz1 - tile.iz * N);
        if (bi0 === 0 && bj0 === 0 && bi1 === N - 1 && bj1 === N - 1) { most = tile.most; return; }
        for (let bj = bj0; bj <= bj1; bj++) for (let bi = bi0; bi <= bi1; bi++) most = Math.max(most, tile.blocks[bj * N + bi]);
      };
      // Few tiles under a small rectangle, read through the lookup; under a large one, every tile there is.
      if ((ix1 - ix0 + 1) * (iz1 - iz0 + 1) < baked.tiles.length) {
        for (let iz = iz0; iz <= iz1; iz++) for (let ix = ix0; ix <= ix1; ix++) { const slot = slots[iz * across + ix]; if (slot >= 0) visit(baked.tiles[slot]); }
      } else for (const tile of baked.tiles) visit(tile);
      return most;
    },
    at(x, z) { return block(Math.floor((x - ox) / B), Math.floor((z - oz) / B)); },
  };
}

/**
 * The banks on the GPU: the lookup, the atlas of tiles, their blocks, and where they lie. `resources()` is what the
 * land's group 2 holds of them; `set` lays a coast's banks (or none) and calls `onChange` with new textures.
 */
export function createLandBanks({ device }) {
  const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST;
  const place = device.createBuffer({ label: 'land banks place', size: 32, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  let lookup = null, field = null, blocks = null, mark = null, stats = { tiles: 0, dropped: 0, bytes: 0 };
  const listeners = new Set();
  const texture = (label, size, format) => device.createTexture({ label, size, format, usage });
  function release() { for (const t of [lookup, field, blocks]) t?.destroy(); }
  function empty() {
    lookup = texture('land banks lookup', [1, 1], 'r16sint'); field = texture('land banks', [1, 1], 'rgba16float'); blocks = texture('land banks blocks', [1, 1], 'r32float');
    device.queue.writeTexture({ texture: lookup }, new Int16Array([-1, 0]), { bytesPerRow: 4 }, [1, 1]);
    device.queue.writeBuffer(place, 0, new Float32Array([0, 0, 0, 0, 1, 0, 1, 0]));
  }
  empty();
  function set(riverCut, region, surfaceAt) {
    const baked = bakeLandBanks(riverCut, region, surfaceAt);
    release();
    if (!baked) { empty(); mark = null; stats = { tiles: 0, dropped: 0, bytes: 0 }; }
    else {
      const X = LAND_BANK_TEXELS, N = LAND_BANK_BLOCKS, A = LAND_BANK_ATLAS_TILES, rows = Math.ceil(baked.tiles.length / A);
      const slots = new Int16Array(baked.across * baked.across).fill(-1);
      const halves = new Uint16Array(A * X * rows * X * 4), most = new Float32Array(A * N * rows * N);
      for (const tile of baked.tiles) {
        slots[tile.iz * baked.across + tile.ix] = tile.slot;
        const cx = (tile.slot % A) * X, cz = Math.floor(tile.slot / A) * X, bx = (tile.slot % A) * N, bz = Math.floor(tile.slot / A) * N;
        for (let j = 0; j < X; j++) for (let i = 0; i < X; i++) for (let c = 0; c < 4; c++) halves[((cz + j) * A * X + cx + i) * 4 + c] = landBankHalf(tile.texels[(j * X + i) * 4 + c]);
        for (let j = 0; j < N; j++) for (let i = 0; i < N; i++) most[(bz + j) * A * N + bx + i] = tile.blocks[j * N + i];
      }
      lookup = texture('land banks lookup', [baked.across, baked.across], 'r16sint');
      field = texture('land banks', [A * X, rows * X], 'rgba16float');
      blocks = texture('land banks blocks', [A * N, rows * N], 'r32float');
      // r16sint rows padded to 256 bytes as writeTexture asks only of copies from buffers; from memory any row is fine.
      device.queue.writeTexture({ texture: lookup }, slots, { bytesPerRow: baked.across * 2 }, [baked.across, baked.across]);
      device.queue.writeTexture({ texture: field }, halves, { bytesPerRow: A * X * 8 }, [A * X, rows * X]);
      device.queue.writeTexture({ texture: blocks }, most, { bytesPerRow: A * N * 4 }, [A * N, rows * N]);
      device.queue.writeBuffer(place, 0, new Float32Array([baked.ox, baked.oz, baked.across, 1, ...baked.bounds]));
      mark = landBankMark(baked);
      stats = { tiles: baked.tiles.length, dropped: baked.dropped, bytes: slots.byteLength + halves.byteLength + most.byteLength };
    }
    for (const fn of listeners) fn();
  }
  return {
    set,
    get mark() { return mark; },
    get stats() { return stats; },
    // What the land's group 2 holds of the banks (LAND_BANK_WGSL in js/wgsl/land-banks.js).
    resources() { return [[58, lookup.createView()], [59, field.createView()], [60, blocks.createView()], [61, { buffer: place }]]; },
    onChange(fn) { listeners.add(fn); return () => listeners.delete(fn); },
    destroy() { release(); place.destroy(); listeners.clear(); },
  };
}

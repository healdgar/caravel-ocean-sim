// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// What shot has done to the ground. The ledger is the record of it: a few numbers per crater, and what is saved.
// Everything drawn follows from the ledger. JavaScript runs here only when a ball lands or a piece of land comes
// or goes, and then writes the tiles concerned. Each frame the land draws what they hold: its vertices stand in the
// pits and its fragments are lit as dug ground (js/wgsl/land-continuum.js and LAND_CRATER_PIT).
//
// Height queries do not see the pits: shot, walkers and hulls keep the land's lattice (js/terrain.js height and
// groundSample), and the land's cut comes down to that lattice wherever a pit lies (js/land-continuum.js).
import { LAND_CRATER_BAKE, LAND_CRATER_BLOCK_M, LAND_CRATER_BLOCKS, LAND_CRATER_CELL_M, LAND_CRATER_GUTTER, LAND_CRATER_LOOKUP_SIZE, LAND_CRATER_MOST_LAYERS, LAND_CRATER_PER_TILE, LAND_CRATER_REACH, LAND_CRATER_TEXELS, LAND_CRATER_TILE_M } from './wgsl/land-craters.js';

const CRATER_REFERENCE_J = 1.1e6;
const CRATER_MERGE_WITHIN = 0.8;
const CRATER_LEDGER_LIMIT = 512;
const CRATER_SAVED_NUMBERS = 6;
const CRATER_RECORD_FLOATS = 10;
const CRATER_FIRST_LAYERS = 32;

// A 24-pounder at 450 m/s digs about a cubic metre: a pit you could lie in, thrown out over a few paces. Energy
// goes as the volume dug, so repeated hits on one spot widen and deepen it by the cube root of what they add up to.
export function landCraterSize(energyJ) {
  const scale = Math.cbrt(Math.max(energyJ, 2e4) / CRATER_REFERENCE_J);
  const depth = Math.min(2.8, 0.55 * scale);
  return { radius: Math.min(6.5, 1.2 * scale), depth, rim: depth * 0.32 };
}

// How far from its centre a crater can touch anything, on sand, the widest ground.
export function landCraterReach(record) {
  return landCraterSize(record.energyJ).radius * 1.14 * LAND_CRATER_REACH * (1 + 0.32 * record.grazing);
}
// Less than this a crater does to the ground is left to the lattice's own triangles.
const LAND_CRATER_LEAST_M = 0.01;
// Edges this near a block's are counted as touching it, whichever side of the edge a float rounds a point to.
const LAND_CRATER_EDGE_M = 0.01;
/**
 * The most a crater can dig or throw up `distance` metres from its centre: landCraterStamp in js/wgsl/land-craters.js,
 * bounded. Its bowl to the crest of its rim, then the spoil thinning as the cube of the distance and the clods on it,
 * nothing past its reach; never more further out. A flat shot drives the bowl long and on ahead, and its noise
 * moves its edge, so the bowl is taken as far out as either can carry it.
 */
export function landCraterEnvelope(record, distance) {
  const size = landCraterSize(record.energyJ), sand = record.sand ?? 0, grazing = record.grazing ?? 0;
  const radius = size.radius * (1 + 0.14 * sand), depth = size.depth * (1 - 0.28 * sand), rim = depth * 0.32 * (1.06 + 0.38 * grazing);
  if (distance >= radius * LAND_CRATER_REACH * (1 + 0.32 * grazing)) return 0;
  const r = 0.85 * Math.max(0, distance - 0.22 * grazing * radius) / ((1 + 0.32 * grazing) * radius);
  const fading = Math.min(1, Math.max(0, (r - 1.2) / 1.8)), clods = 0.078 * depth * (1 - 0.55 * sand) * (1 - fading * fading * (3 - 2 * fading));
  const amount = (r < 1.06 ? Math.max(depth, rim) : rim / (r * r * r)) + clods;
  return amount < LAND_CRATER_LEAST_M ? 0 : amount;
}
const craterDistance = (record, x0, x1, z0, z1) => Math.hypot(Math.max(x0 - record.x, 0, record.x - x1), Math.max(z0 - record.z, 0, record.z - z1));
// The most a crater does over one block, by the block's corner: what the GPU reads for a point in it (landCraterWaits).
export function landCraterBlockAmount(record, x, z) {
  return landCraterEnvelope(record, craterDistance(record, x, x + LAND_CRATER_BLOCK_M, z, z + LAND_CRATER_BLOCK_M));
}
/**
 * A crater as the land's cut keeps it (landContinuumDig in js/land-continuum.js): the square of blocks it reaches at
 * all; `over`, the most it does over the blocks a world rectangle touches; `at`, over the block a point is in. A patch
 * keeps what its pit does where it is, so ground the pit leaves flat is not split for it. Its pits are worked out to
 * the crater tiles' cell, the finest the land is cut (level 0).
 */
export function landCraterMark(record) {
  const B = LAND_CRATER_BLOCK_M, E = LAND_CRATER_EDGE_M;
  const reach = landCraterSize(record.energyJ).radius * (1 + 0.14 * (record.sand ?? 0)) * LAND_CRATER_REACH * (1 + 0.32 * (record.grazing ?? 0));
  const x0 = Math.floor((record.x - reach) / B) * B, x1 = (Math.floor((record.x + reach) / B) + 1) * B;
  const z0 = Math.floor((record.z - reach) / B) * B, z1 = (Math.floor((record.z + reach) / B) + 1) * B;
  const lo = (v) => (Math.ceil((v - E) / B) - 1) * B, hi = (v) => (Math.floor((v + E) / B) + 1) * B;
  return {
    x0, x1, z0, z1, finest: 0,
    over(ax, bx, az, bz) {
      if (bx < x0 - E || ax > x1 + E || bz < z0 - E || az > z1 + E) return 0;
      return landCraterEnvelope(record, craterDistance(record, lo(ax), hi(bx), lo(az), hi(bz)));
    },
    at(x, z) { return landCraterBlockAmount(record, Math.floor(x / B) * B, Math.floor(z / B) * B); },
  };
}

const craterSeed = (x, z) => { const value = Math.sin(x * 12.9898 + z * 78.233) * 43758.5453; return value - Math.floor(value); };
const craterRound = (value) => Math.round(value * 10) / 10;

/**
 * The craters of one coast. `saved` is what `snapshot` gave; positions are saved from the coast's own centre,
 * since the same coast can be laid out elsewhere on a later visit.
 */
export function createLandCraterLedger(saved = null, origin = { x: 0, z: 0 }) {
  const records = [];
  if (Array.isArray(saved)) {
    for (let at = 0; at + CRATER_SAVED_NUMBERS <= saved.length; at += CRATER_SAVED_NUMBERS) {
      const [x, z, kj, heading, grazing, sand] = saved.slice(at, at + CRATER_SAVED_NUMBERS);
      if (![x, z, kj, heading, grazing, sand].every(Number.isFinite)) continue;
      const angle = heading * Math.PI / 180;
      records.push({ x: origin.x + x / 10, z: origin.z + z / 10, energyJ: kj * 1000, hx: Math.cos(angle), hz: Math.sin(angle), grazing: grazing / 100, sand: sand / 100 });
    }
  }
  const nearest = (x, z, within) => {
    let best = null, bestDistance = Infinity;
    for (const record of records) {
      const distance = Math.hypot(record.x - x, record.z - z), reach = within(record);
      if (distance <= reach && distance < bestDistance) { best = record; bestDistance = distance; }
    }
    return best;
  };
  return {
    records,
    // A ball lands. Near an old crater it adds to that crater, which grows toward the new hit; otherwise it starts one.
    strike({ x, z, energyJ, velocity = [0, -1, 0], normal = [0, 1, 0], sand = 0 }) {
      const speed = Math.hypot(velocity[0], velocity[1], velocity[2]) || 1, level = Math.hypot(velocity[0], velocity[2]) || 1;
      const hx = velocity[0] / level, hz = velocity[2] / level;
      const grazing = Math.max(0, Math.min(1, 1 - Math.abs(velocity[0] * normal[0] + velocity[1] * normal[1] + velocity[2] * normal[2]) / speed));
      let record = nearest(x, z, (old) => landCraterSize(old.energyJ).radius * CRATER_MERGE_WITHIN);
      if (!record && records.length >= CRATER_LEDGER_LIMIT) record = nearest(x, z, () => Infinity);
      if (!record) {
        record = { x: craterRound(x), z: craterRound(z), energyJ, hx, hz, grazing, sand };
        records.push(record);
        return record;
      }
      const total = record.energyJ + energyJ, share = energyJ / total;
      record.x = craterRound(record.x + (x - record.x) * share);
      record.z = craterRound(record.z + (z - record.z) * share);
      const mx = record.hx + (hx - record.hx) * share, mz = record.hz + (hz - record.hz) * share, ml = Math.hypot(mx, mz) || 1;
      record.hx = mx / ml; record.hz = mz / ml;
      record.grazing += (grazing - record.grazing) * share;
      record.sand += (sand - record.sand) * share;
      record.energyJ = total;
      return record;
    },
    // Whether a point lies in a bowl or under its rim, where nothing goes on growing.
    covers(x, z) {
      for (const record of records) if (Math.hypot(record.x - x, record.z - z) < landCraterSize(record.energyJ).radius * 1.35) return true;
      return false;
    },
    // Six numbers a crater, the largest first so that a share link can keep what shows most.
    snapshot(limit = Infinity) {
      if (!records.length) return undefined;
      const out = [];
      for (const record of [...records].sort((a, b) => b.energyJ - a.energyJ).slice(0, limit)) {
        out.push(Math.round((record.x - origin.x) * 10), Math.round((record.z - origin.z) * 10), Math.round(record.energyJ / 1000),
          Math.round(Math.atan2(record.hz, record.hx) * 180 / Math.PI), Math.round(record.grazing * 100), Math.round(record.sand * 100));
      }
      return out;
    },
  };
}

// The pits' program, asked for once.
export function requestLandCraterPipelines({ computePipe }) {
  return computePipe(LAND_CRATER_BAKE, 'land crater tiles');
}

/**
 * Keeps tiles of damaged ground in step with a ledger.
 *   sectionAt(x,z)   which piece of land a point belongs to, or null where no land is loaded
 *   groundAt(x,z)    a rough height, as the tile's zero
 *   surfaceAt(x,z)   the land's own lattice surface, which a tile's ground is written from
 */
export function createLandCraters({ device, computePipe, ledger, sectionAt, groundAt, surfaceAt = groundAt, maxLayers: wantedLayers = LAND_CRATER_MOST_LAYERS, region: initialRegion = null }) {
  const maxLayers = Math.min(wantedLayers, LAND_CRATER_MOST_LAYERS);
  const tiles = new Map();
  let groundTexture = null, fieldTexture = null, layerCount = 0;
  const freeLayers = [];
  let recordBuffer = null, jobBuffer = null, listBuffer = null, bakePipeline = null;
  const retired = [];
  const reallocateListeners = new Set();
  let overflow = false, anchor = { x: 0, z: 0 }, movedFrom = null, wanting = false, disposed = false;
  const stats = { tiles: 0, layers: 0, grounds: 0, bakes: 0, overflow: false, get craters() { return ledger.records.length; } };
  const keyOf = (ix, iz) => `${ix},${iz}`;

  const snapOrigin = (c, span) => Math.floor(((c ?? 0) - (span ?? 8192) * 0.5) / LAND_CRATER_TILE_M) * LAND_CRATER_TILE_M;
  const regionOrigin = new Float32Array([-4096, -4096]);
  Object.defineProperties(regionOrigin, {
    x: { get() { return regionOrigin[0]; }, enumerable: true },
    z: { get() { return regionOrigin[1]; }, enumerable: true },
  });
  const lookupData = new Int16Array(LAND_CRATER_LOOKUP_SIZE * LAND_CRATER_LOOKUP_SIZE).fill(-1);
  const singleLookupTexel = new Int16Array(1);
  const lookupTexture = device.createTexture({
    label: 'land crater tile lookup',
    size: [LAND_CRATER_LOOKUP_SIZE, LAND_CRATER_LOOKUP_SIZE],
    format: 'r16sint',
    usage: GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_DST,
  });
  // Where the lookup starts and 1 to look, then the rectangle every tile in use lies in, then the most each layer's
  // craters dig or throw up over each of its blocks: what the land reads (landCraterPlace), so that ground with no pit
  // near reads no texture and the land's cut knows how much a point there waits for.
  const blocks = LAND_CRATER_BLOCKS * LAND_CRATER_BLOCKS;
  const placed = new Float32Array(8 + LAND_CRATER_MOST_LAYERS * blocks);
  const place = device.createBuffer({ label: 'land crater lookup place', size: placed.byteLength, usage: GPUBufferUsage.UNIFORM | GPUBufferUsage.COPY_DST });
  const writePlace = () => {
    let x0 = Infinity, x1 = -Infinity, z0 = Infinity, z1 = -Infinity;
    placed.fill(0, 8);
    for (const tile of tiles.values()) {
      x0 = Math.min(x0, tile.x); x1 = Math.max(x1, tile.x + LAND_CRATER_TILE_M);
      z0 = Math.min(z0, tile.z); z1 = Math.max(z1, tile.z + LAND_CRATER_TILE_M);
      for (let b = 0; b < blocks; b++) {
        const bx = tile.x + (b % LAND_CRATER_BLOCKS) * LAND_CRATER_BLOCK_M, bz = tile.z + Math.floor(b / LAND_CRATER_BLOCKS) * LAND_CRATER_BLOCK_M;
        let most = 0;
        for (const index of tile.craters) most = Math.max(most, landCraterBlockAmount(ledger.records[index], bx, bz));
        placed[8 + tile.layer * blocks + b] = most;
      }
    }
    placed.set([regionOrigin[0], regionOrigin[1], 1, 0, ...(tiles.size ? [x0, x1, z0, z1] : [1, 0, 1, 0])]);
    device.queue.writeBuffer(place, 0, placed);
  };
  const sampler = device.createSampler({ label: 'crater tiles', minFilter: 'linear', magFilter: 'linear', addressModeU: 'clamp-to-edge', addressModeV: 'clamp-to-edge' });

  const coastRegion = (hint) => (hint && Number.isFinite(hint.x) && Number.isFinite(hint.z) && hint.span >= 4096 ? hint : initialRegion);
  const startReg = coastRegion(initialRegion);
  if (startReg) {
    regionOrigin[0] = snapOrigin(startReg.x, startReg.span);
    regionOrigin[1] = snapOrigin(startReg.z, startReg.span);
  }
  writePlace();
  device.queue.writeTexture(
    { texture: lookupTexture },
    lookupData,
    { bytesPerRow: LAND_CRATER_LOOKUP_SIZE * 2, rowsPerImage: LAND_CRATER_LOOKUP_SIZE },
    [LAND_CRATER_LOOKUP_SIZE, LAND_CRATER_LOOKUP_SIZE],
  );

  function writeLookupTile(tileX, tileZ, val) {
    const tx = Math.round((tileX - regionOrigin[0]) / LAND_CRATER_TILE_M);
    const tz = Math.round((tileZ - regionOrigin[1]) / LAND_CRATER_TILE_M);
    if (tx < 0 || tx >= LAND_CRATER_LOOKUP_SIZE || tz < 0 || tz >= LAND_CRATER_LOOKUP_SIZE) return;
    const idx = tz * LAND_CRATER_LOOKUP_SIZE + tx;
    if (lookupData[idx] === val) return;
    lookupData[idx] = val;
    singleLookupTexel[0] = val;
    device.queue.writeTexture({ texture: lookupTexture, origin: [tx, tz, 0] }, singleLookupTexel, { offset: 0 }, [1, 1]);
  }

  function syncRegionOrigin(hint = null) {
    const reg = coastRegion(hint);
    if (!reg) return false;
    const ox = snapOrigin(reg.x, reg.span), oz = snapOrigin(reg.z, reg.span);
    if (ox === regionOrigin[0] && oz === regionOrigin[1]) return false;
    regionOrigin[0] = ox;
    regionOrigin[1] = oz;
    writePlace();
    lookupData.fill(-1);
    for (const tile of tiles.values()) {
      const tx = Math.round((tile.x - ox) / LAND_CRATER_TILE_M);
      const tz = Math.round((tile.z - oz) / LAND_CRATER_TILE_M);
      if (tx >= 0 && tx < LAND_CRATER_LOOKUP_SIZE && tz >= 0 && tz < LAND_CRATER_LOOKUP_SIZE) {
        lookupData[tz * LAND_CRATER_LOOKUP_SIZE + tx] = tile.layer;
      }
    }
    device.queue.writeTexture(
      { texture: lookupTexture },
      lookupData,
      { bytesPerRow: LAND_CRATER_LOOKUP_SIZE * 2, rowsPerImage: LAND_CRATER_LOOKUP_SIZE },
      [LAND_CRATER_LOOKUP_SIZE, LAND_CRATER_LOOKUP_SIZE],
    );
    return true;
  }

  function storage(current, bytes, label) {
    if (current && current.size >= bytes) return current;
    current?.destroy();
    return device.createBuffer({ label, size: Math.max(256, bytes * 2), usage: GPUBufferUsage.STORAGE | GPUBufferUsage.COPY_DST });
  }
  function ensureLayers(encoder, needed) {
    if (needed <= layerCount) return false;
    let next = Math.max(CRATER_FIRST_LAYERS, layerCount);
    while (next < needed) next *= 2;
    next = Math.min(next, Math.max(maxLayers, needed));
    const size = [LAND_CRATER_TEXELS, LAND_CRATER_TEXELS, next];
    const usage = GPUTextureUsage.TEXTURE_BINDING | GPUTextureUsage.COPY_SRC | GPUTextureUsage.COPY_DST;
    const ground = device.createTexture({ label: 'land as it was, by crater tile', size, format: 'rgba32float', usage });
    const field = device.createTexture({ label: 'land dug up, by crater tile', size, format: 'rgba16float', usage: usage | GPUTextureUsage.STORAGE_BINDING });
    if (layerCount) {
      const copied = [LAND_CRATER_TEXELS, LAND_CRATER_TEXELS, layerCount];
      encoder.copyTextureToTexture({ texture: groundTexture }, { texture: ground }, copied);
      encoder.copyTextureToTexture({ texture: fieldTexture }, { texture: field }, copied);
      // The old pair is in use by this encoder until it is submitted.
      retired.push(groundTexture, fieldTexture);
    }
    for (let layer = next - 1; layer >= layerCount; layer--) freeLayers.push(layer);
    groundTexture = ground; fieldTexture = field; layerCount = next; stats.layers = next;
    return true;
  }
  // The first layers, so that the land has a field to read before any shot lands.
  ensureLayers(null, 1);
  // Every tile each crater reaches, and each tile's craters. Where too many crowd one, the nearest its middle count.
  function tilesWanted() {
    const wanted = new Map();
    ledger.records.forEach((record, index) => {
      const reach = landCraterReach(record);
      const x0 = Math.floor((record.x - reach) / LAND_CRATER_TILE_M), x1 = Math.floor((record.x + reach) / LAND_CRATER_TILE_M);
      const z0 = Math.floor((record.z - reach) / LAND_CRATER_TILE_M), z1 = Math.floor((record.z + reach) / LAND_CRATER_TILE_M);
      for (let iz = z0; iz <= z1; iz++) for (let ix = x0; ix <= x1; ix++) {
        const key = keyOf(ix, iz);
        let tile = wanted.get(key);
        if (!tile) {
          const x = ix * LAND_CRATER_TILE_M, z = iz * LAND_CRATER_TILE_M, section = sectionAt(x + LAND_CRATER_TILE_M / 2, z + LAND_CRATER_TILE_M / 2);
          if (section === null) continue;
          tile = { key, x, z, section, craters: [] };
          wanted.set(key, tile);
        }
        tile.craters.push(index);
      }
    });
    overflow = wanted.size > maxLayers;
    stats.overflow = overflow;
    if (overflow) {
      const away = (tile) => Math.hypot(tile.x + LAND_CRATER_TILE_M / 2 - anchor.x, tile.z + LAND_CRATER_TILE_M / 2 - anchor.z);
      const far = [...wanted.values()].sort((a, b) => away(b) - away(a));
      for (const tile of far.slice(0, wanted.size - maxLayers)) wanted.delete(tile.key);
    }
    for (const tile of wanted.values()) {
      if (tile.craters.length <= LAND_CRATER_PER_TILE) continue;
      const away = (index) => Math.hypot(ledger.records[index].x - tile.x - LAND_CRATER_TILE_M / 2, ledger.records[index].z - tile.z - LAND_CRATER_TILE_M / 2);
      tile.craters.sort((a, b) => away(a) - away(b));
      tile.craters.length = LAND_CRATER_PER_TILE;
    }
    return wanted;
  }
  const touches = (tile, region) => {
    const half = region.span / 2;
    return tile.x + LAND_CRATER_TILE_M + 1 >= region.x - half && tile.x - 1 <= region.x + half && tile.z + LAND_CRATER_TILE_M + 1 >= region.z - half && tile.z - 1 <= region.z + half;
  };
  // The land as it was under a tile, from its own lattice: height above the tile's floor, the normal's x and z, and
  // below zero where no land is loaded. Written when the tile first comes into use or its land changes.
  const T = LAND_CRATER_TEXELS, groundTexels = new Float32Array(T * T * 4), groundHeights = new Float32Array(T * T);
  function writeGround(tile) {
    const at = (i, j) => groundHeights[Math.min(T - 1, Math.max(0, j)) * T + Math.min(T - 1, Math.max(0, i))];
    const xAt = (i) => tile.x + (i - LAND_CRATER_GUTTER) * LAND_CRATER_CELL_M, zAt = (j) => tile.z + (j - LAND_CRATER_GUTTER) * LAND_CRATER_CELL_M;
    for (let j = 0; j < T; j++) for (let i = 0; i < T; i++) groundHeights[j * T + i] = surfaceAt(xAt(i), zAt(j));
    for (let j = 0; j < T; j++) for (let i = 0; i < T; i++) {
      const dx = (at(i - 1, j) - at(i + 1, j)) / (2 * LAND_CRATER_CELL_M), dz = (at(i, j - 1) - at(i, j + 1)) / (2 * LAND_CRATER_CELL_M), length = Math.hypot(dx, 1, dz);
      groundTexels.set([groundHeights[j * T + i] - tile.floorY, dx / length, dz / length, sectionAt(xAt(i), zAt(j)) === null ? -1 : 0], (j * T + i) * 4);
    }
    device.queue.writeTexture({ texture: groundTexture, origin: [0, 0, tile.layer] }, groundTexels, { bytesPerRow: T * 16, rowsPerImage: T }, [T, T, 1]);
    tile.grounded = true;
    stats.grounds++;
  }
  function bake(encoder, list) {
    const packed = new Float32Array(ledger.records.length * CRATER_RECORD_FLOATS);
    ledger.records.forEach((record, index) => {
      const size = landCraterSize(record.energyJ);
      packed.set([record.x, record.z, size.radius, size.depth, record.hx, record.hz, record.grazing, craterSeed(record.x, record.z), record.sand], index * CRATER_RECORD_FLOATS);
    });
    const jobs = new ArrayBuffer(list.length * 32), floats = new Float32Array(jobs), words = new Uint32Array(jobs), craterList = [];
    list.forEach((tile, index) => {
      floats.set([tile.x, tile.z, tile.floorY], index * 8);
      words.set([tile.layer, craterList.length, tile.craters.length], index * 8 + 3);
      craterList.push(...tile.craters);
      stats.bakes++;
    });
    const lists = new Uint32Array(craterList.length || 1);
    lists.set(craterList);
    recordBuffer = storage(recordBuffer, packed.byteLength, 'craters');
    jobBuffer = storage(jobBuffer, jobs.byteLength, 'crater tiles to work out');
    listBuffer = storage(listBuffer, lists.byteLength, 'craters by tile');
    device.queue.writeBuffer(recordBuffer, 0, packed);
    device.queue.writeBuffer(jobBuffer, 0, jobs);
    device.queue.writeBuffer(listBuffer, 0, lists);
    const pass = encoder.beginComputePass({ label: 'work out crater tiles' });
    pass.setPipeline(bakePipeline);
    pass.setBindGroup(0, device.createBindGroup({ layout: bakePipeline.getBindGroupLayout(0), entries: [
      { binding: 0, resource: { buffer: recordBuffer } },
      { binding: 1, resource: { buffer: jobBuffer } },
      { binding: 2, resource: { buffer: listBuffer } },
      { binding: 3, resource: groundTexture.createView({ dimension: '2d-array' }) },
      { binding: 4, resource: fieldTexture.createView({ dimension: '2d-array' }) },
    ] }));
    pass.dispatchWorkgroups(9, 9, list.length);
    pass.end();
  }
  // Bring tiles in line with the ledger. `changed`, if given, is the one crater that moved.
  function refresh(changed = null) {
    if (disposed) return;
    if (!bakePipeline) { wanting = true; return; }
    const originChanged = syncRegionOrigin();
    const wanted = tilesWanted();
    for (const [key, tile] of tiles) {
      if (!wanted.has(key)) {
        writeLookupTile(tile.x, tile.z, -1);
        freeLayers.push(tile.layer);
        tiles.delete(key);
      }
    }
    // Grown layers are copied first, so the ground written after lands in the new pair.
    const grow = device.createCommandEncoder({ label: 'crater tiles grown' });
    const reallocated = ensureLayers(grow, wanted.size);
    device.queue.submit([grow.finish()]);
    const touched = changed ? ledger.records.indexOf(changed) : -1, toBake = [];
    for (const [key, want] of wanted) {
      let tile = tiles.get(key);
      if (!tile) {
        tile = { ...want, layer: freeLayers.pop(), floorY: groundAt(want.x + LAND_CRATER_TILE_M / 2, want.z + LAND_CRATER_TILE_M / 2), grounded: false, baked: false };
        tiles.set(key, tile);
      } else {
        tile.section = want.section;
      }
      writeLookupTile(tile.x, tile.z, tile.layer);
      const moved = tile.craters.length !== want.craters.length || tile.craters.some((v, i) => v !== want.craters[i]);
      tile.craters = want.craters;
      if (!tile.baked || moved || want.craters.includes(touched)) toBake.push(tile);
    }
    for (const tile of toBake) if (!tile.grounded) writeGround(tile);
    if (toBake.length) {
      const encoder = device.createCommandEncoder({ label: 'crater tiles' });
      bake(encoder, toBake);
      device.queue.submit([encoder.finish()]);
      for (const tile of toBake) tile.baked = true;
    }
    stats.tiles = tiles.size;
    writePlace();
    for (const texture of retired.splice(0)) texture.destroy();
    if (reallocated || originChanged) {
      for (const fn of reallocateListeners) fn(fieldTexture);
    }
  }
  const ready = (async () => {
    const compute = await requestLandCraterPipelines({ computePipe });
    if (disposed) return;
    bakePipeline = compute;
    if (wanting || ledger.records.length) refresh();
  })();
  ready.catch((error) => console.error('Land craters unavailable', error));
  return {
    stats, ledger, ready,
    get fieldTexture() { return fieldTexture; },
    get lookupTexture() { return lookupTexture; },
    get regionOrigin() { return regionOrigin; },
    // What the land's group 2 holds of the pits (LAND_CRATER_PIT in js/wgsl/land-craters.js).
    resources() {
      return [[54, lookupTexture.createView()], [55, fieldTexture.createView({ dimension: '2d-array' })], [56, sampler], [57, place]];
    },
    onReallocate(fn) {
      if (typeof fn !== 'function') return () => {};
      reallocateListeners.add(fn);
      return () => { reallocateListeners.delete(fn); };
    },
    // A ball has landed. Worked out and on the GPU before this frame's drawing starts.
    strike(hit) {
      const record = ledger.strike(hit);
      anchor = { x: hit.x, z: hit.z };
      refresh(record);
      return record;
    },
    // Land has changed under the tiles, or a section has come or gone. `region` limits it to the tiles there.
    invalidate(region = null) {
      const originChanged = syncRegionOrigin(region);
      for (const tile of tiles.values()) if (!region || touches(tile, region)) { tile.grounded = false; tile.baked = false; }
      if (ledger.records.length || tiles.size) {
        refresh();
      } else if (originChanged) {
        for (const fn of reallocateListeners) fn(fieldTexture);
      }
    },
    // When the craters will not all fit, the ones nearest the camera get the tiles.
    follow(camera) {
      if (!overflow) return;
      if (movedFrom && Math.hypot(camera.x - movedFrom.x, camera.z - movedFrom.z) < 64) return;
      movedFrom = { x: camera.x, z: camera.z };
      anchor = movedFrom;
      refresh();
    },
    // What the tiles hold at a point. For tests and for looking into what went wrong.
    async probe(x, z) {
      const tile = tiles.get(keyOf(Math.floor(x / LAND_CRATER_TILE_M), Math.floor(z / LAND_CRATER_TILE_M)));
      if (!tile) return null;
      const texel = (world, origin) => Math.round((world - origin) / LAND_CRATER_CELL_M) + LAND_CRATER_GUTTER;
      const read = device.createBuffer({ size: 512, usage: GPUBufferUsage.COPY_DST | GPUBufferUsage.MAP_READ });
      const encoder = device.createCommandEncoder();
      for (const [index, texture] of [groundTexture, fieldTexture].entries()) {
        encoder.copyTextureToBuffer({ texture, origin: [texel(x, tile.x), texel(z, tile.z), tile.layer] }, { buffer: read, offset: index * 256, bytesPerRow: 256 }, [1, 1, 1]);
      }
      device.queue.submit([encoder.finish()]);
      await read.mapAsync(GPUMapMode.READ);
      const bytes = read.getMappedRange().slice(0), ground = new Float32Array(bytes, 0, 4), half = new Uint16Array(bytes, 256, 4);
      read.destroy();
      const value = (bits) => { const sign = bits & 0x8000 ? -1 : 1, e = (bits >> 10) & 31, m = bits & 1023; return sign * (e === 0 ? m * 2 ** -24 : e === 31 ? Infinity : (1 + m / 1024) * 2 ** (e - 15)); };
      return { groundY: tile.floorY + ground[0], kind: ground[3], height: value(half[0]), soil: value(half[1]), sand: value(half[2]), cover: value(half[3]) };
    },
    dispose() {
      disposed = true;
      reallocateListeners.clear();
      groundTexture?.destroy(); fieldTexture?.destroy();
      lookupTexture?.destroy(); place.destroy();
      recordBuffer?.destroy(); jobBuffer?.destroy(); listBuffer?.destroy();
    },
  };
}

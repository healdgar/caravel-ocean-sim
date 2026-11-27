// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Groves: the wood of a coast wherever its ground is marked as forest, however far it runs, planted tree by
// tree as roots of the forest pack (retargetForestPackToProcedural, js/terrain.js). A pack's grove is a baked
// square of closed wood (scripts/prepare-forest-stands.mjs): where each of its trees stands, its turn and
// scale and kind. It repeats over every wooded square of a section, round the trees planted there one by one,
// and every tree of it is drawn, struck, swayed and saved as any other root: clusters near, crowns, then
// splat and thinning at the horizon, under the one scene budget.
import { terrainSurfaceSample } from './terrain-model.js';
import { portClearanceEnvelope, PLANT_STREET_GAP_M } from './coastal-world.js';
import { streetEdgeAt } from './town-streets.js';
import { createInlandWaterSampler } from './inland-water.js';

// A pack bakes this many groves that stand beside each other in any order.
export const FOREST_GROVE_VARIANTS = 4;
// A tree of a grove: where it stands in its square, its turn and scale, which tree of the pack it is, its
// crown's radius and height, and whether every grove shares it.
export const FOREST_GROVE_TREE_FLOATS = 8;
// A planted tree's record in the forest's roots (js/terrain.js): where it stands, its scale and its kind.
const FOREST_GROVE_ROOT_FLOATS = 12;
// A grove's tree stands where the cover says a wood's edge is passed and the ground is not a planted tree's:
// the wood thickens from FOREST_GROVE_EDGE to FOREST_GROVE_FULL of the cover, planted trees have the ground
// from FOREST_GROVE_TAKEN of it, and a tree stands where what is left is at least FOREST_GROVE_STANDS.
const FOREST_GROVE_EDGE = 0.45, FOREST_GROVE_FULL = 0.95, FOREST_GROVE_TAKEN = 0.9, FOREST_GROVE_STANDS = 0.5;
// The trees of a wood's mantle are smaller: this share of their size where the wood just stands.
const FOREST_GROVE_MANTLE = 0.8;
// Trees by a harbour are planted smaller than those inland (retargetForestPackToProcedural, js/terrain.js),
// and a grove's are as much smaller there: this share of their size at the port, all of it from
// FOREST_GROVE_INLAND_METRES[1] away. A grove of full-grown trees, which are planted at nearly one size
// everywhere, names a share of its own (harbourHeight in its manifest).
const FOREST_GROVE_HARBOUR_HEIGHT = 0.78, FOREST_GROVE_INLAND_METRES = [100, 580];

// Literal paths: build.mjs finds what to publish by reading them from the source.
// Saba has no entry: its woods are the trees of its own survey.
export const PORTUGAL_FOREST_GROVE_ASSETS = Object.freeze({
  'manifest.json': 'assets/forest-scenery/portugal/groves/manifest.json',
  'trees.bin.gz': 'assets/forest-scenery/portugal/groves/trees.bin.gz',
});
export const NORTHERN_FOREST_GROVE_ASSETS = Object.freeze({
  'manifest.json': 'assets/forest-scenery/northern/groves/manifest.json',
  'trees.bin.gz': 'assets/forest-scenery/northern/groves/trees.bin.gz',
});
export const SUBTROPICAL_FOREST_GROVE_ASSETS = Object.freeze({
  'manifest.json': 'assets/forest-scenery/subtropical/groves/manifest.json',
  'trees.bin.gz': 'assets/forest-scenery/subtropical/groves/trees.bin.gz',
});

export function validateForestGroves(manifest) {
  if (manifest?.format !== 'waterworld.forest-groves' || manifest.version !== 2 || manifest.variants !== FOREST_GROVE_VARIANTS ||
    manifest.treeFloats !== FOREST_GROVE_TREE_FLOATS) throw Error('Invalid forest grove manifest');
  if (!(manifest.tileMetres > 0)) throw Error('Forest groves name no size');
  if (manifest.harbourHeight !== undefined && !(manifest.harbourHeight > 0 && manifest.harbourHeight <= 1)) throw Error('Forest groves name no height by the harbour');
  if (!Number.isInteger(manifest.maxTrees) || manifest.maxTrees < 2) throw Error('Forest groves hold no trees');
  if (manifest.files?.['trees.bin']?.bytes !== FOREST_GROVE_VARIANTS * manifest.maxTrees * FOREST_GROVE_TREE_FLOATS * 4) throw Error('Forest grove trees do not match their manifest');
  return manifest;
}

export async function loadForestGroves({ assets, fetchAsset = fetch, signal } = {}) {
  const get = async (name) => {
    const response = await fetchAsset(assets[name], signal ? { signal } : undefined);
    if (!response.ok) throw Error(`Forest groves unavailable (${response.status}): ${name}`);
    return response;
  };
  const manifest = validateForestGroves(await (await get('manifest.json')).json());
  const receipt = manifest.files['trees.bin'], response = await get('trees.bin.gz');
  const bytes = new Uint8Array(await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  if (bytes.byteLength !== receipt.bytes) throw Error('Forest grove trees have the wrong size');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  if (Array.from(digest, (v) => v.toString(16).padStart(2, '0')).join('') !== receipt.sha256) throw Error('Forest grove trees failed verification');
  return { manifest, trees: new Float32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4) };
}

// Where a wood may stand on one section of coast, as two bytes for each of size by size squares of it.
// The first is how far, of 255, into a wood the square lies: nothing on water, sand, bare or steep ground,
// in a town, or a few squares outside a wood; half at a wood's edge; and all of it three squares inside. They
// are the rules by which js/terrain.js plants a tree, so a grove ends where planted trees would, and its
// mantle thins over the squares before that edge. The second byte is forestGroveOccupy's.
export function forestGroveCover({ region, heights, biome, beaches = null, port = null, mangrove = false, size }) {
  const span = region.span, x0 = region.x - span / 2, z0 = region.z - span / 2, step = span / size, mask = region.biomeSize;
  const cover = new Uint8Array(size * size * 2);
  if (!(biome instanceof Uint8Array) || biome.length !== mask * mask) return cover;
  const dry = beaches?.drySandMask, swash = beaches?.swashMask, lowest = mangrove ? 0.32 : 0.75;
  const inside = span / 2 - 0.01;
  const ground = (x, z) => terrainSurfaceSample(heights, Math.max(region.x - inside, Math.min(region.x + inside, x)), Math.max(region.z - inside, Math.min(region.z + inside, z)), region);
  const town = port?.clearRadius > 0 ? port : null;
  const pad = town ? (town.hasIndigenousSettlement ? 8.5 : 10) : 0;
  const cleared = town && !town.hasIndigenousSettlement ? (town.clearRadius * 0.38) ** 2 : 0;
  const waterWide = port?.country ? createInlandWaterSampler(port.country, { margin: 8.0 }) : null;
  for (let j = 0; j < size; j++) {
    const z = z0 + (j + 0.5) * step, row = Math.min(mask - 1, Math.floor((j + 0.5) * mask / size)) * mask;
    for (let i = 0; i < size; i++) {
      const cell = row + Math.min(mask - 1, Math.floor((i + 0.5) * mask / size)), marked = biome[cell];
      if (marked < 42 || (dry && dry[cell] > 110) || (swash && swash[cell] > 64)) continue;
      const x = x0 + (i + 0.5) * step, y = ground(x, z);
      if (!(y >= lowest) || y > 845) continue;
      if (waterWide?.(x, z)) continue;
      const slope = Math.hypot(ground(x + 2, z) - ground(x - 2, z), ground(x, z + 2) - ground(x, z - 2)) * 0.25;
      if (!(slope <= 0.84) || (y < 24 && slope > 0.36)) continue;
      if (town && (!portClearanceEnvelope(town, x, z, pad) || (x - town.center.x) ** 2 + (z - town.center.z) ** 2 < cleared || streetEdgeAt(town.streets, x, z) < PLANT_STREET_GAP_M)) continue;
      // Ground marked thinly is a wood's margin: scrub, then trees.
      cover[(j * size + i) * 2] = marked >= 108 ? 255 : Math.round((marked - 41) / 67 * 255);
    }
  }
  // Each square takes in its neighbours four times over, so the edge of a wood is a slope and not a step.
  const line = new Float32Array(size);
  for (let pass = 0; pass < 4; pass++) for (const stride of [2, size * 2]) for (let row = 0; row < size; row++) {
    const first = stride === 2 ? row * size * 2 : row * 2;
    for (let k = 0; k < size; k++) line[k] = cover[first + k * stride];
    for (let k = 0; k < size; k++) cover[first + k * stride] = Math.round((line[Math.max(0, k - 1)] + line[k] + line[Math.min(size - 1, k + 1)]) / 3);
  }
  if (port?.country) {
    const waterChannel = createInlandWaterSampler(port.country, { margin: 3.5 });
    if (waterChannel) {
      for (let j = 0; j < size; j++) {
        const z = z0 + (j + 0.5) * step;
        for (let i = 0; i < size; i++) {
          if (waterChannel(x0 + (i + 0.5) * step, z)) cover[(j * size + i) * 2] = 0;
        }
      }
    }
  }
  return cover;
}

// Marks, in a cover's second byte, how much of each square planted trees have: all of it at a trunk,
// a third at the edge of its crown, and none a quarter of a crown beyond. A grove's trees keep off that
// ground, so a planted tree stands in a clearing of the grove that its own crown fills, with the wood
// closed round it.
export function forestGroveOccupy(cover, size, region, roots, reach) {
  for (let k = 1; k < cover.length; k += 2) cover[k] = 0;
  if (!roots?.length) return cover;
  const step = region.span / size, x0 = region.x - region.span / 2, z0 = region.z - region.span / 2;
  for (let k = 0; k + FOREST_GROVE_ROOT_FLOATS <= roots.length; k += FOREST_GROVE_ROOT_FLOATS) {
    const scale = roots[k + 3];
    if (!(scale > 0)) continue;
    // A crown narrower than a square still takes the square its trunk stands in.
    const u = (roots[k] - x0) / step, v = (roots[k + 2] - z0) / step, crown = reach(roots[k + 8], scale) / step, r = Math.max(crown * 1.25, 1.2), all = Math.min(crown * 0.5, r - 0.7);
    if (u < -r || v < -r || u > size + r || v > size + r) continue;
    const i0 = Math.max(0, Math.floor(u - r)), i1 = Math.min(size - 1, Math.floor(u + r)), j0 = Math.max(0, Math.floor(v - r)), j1 = Math.min(size - 1, Math.floor(v + r));
    for (let j = j0; j <= j1; j++) for (let i = i0; i <= i1; i++) {
      const taken = Math.round(255 * Math.min(1, (r - Math.hypot(i + 0.5 - u, j + 0.5 - v)) / (r - all))), at = (j * size + i) * 2 + 1;
      if (taken > cover[at]) cover[at] = taken;
    }
  }
  return cover;
}

const groveSmoothstep = (a, b, x) => { const t = Math.min(1, Math.max(0, (x - a) / (b - a))); return t * t * (3 - 2 * t); };
// How much of a wood stands at a place, from a cover read between its squares: none where no wood is
// marked or a planted tree has the ground, and all of it a square or two of the cover further in.
export function forestGroveStanding(cover, size, region, x, z) {
  const u = Math.min(size - 1, Math.max(0, (x - (region.x - region.span / 2)) / region.span * size - 0.5));
  const v = Math.min(size - 1, Math.max(0, (z - (region.z - region.span / 2)) / region.span * size - 0.5));
  const i = Math.min(size - 2, Math.floor(u)), j = Math.min(size - 2, Math.floor(v)), fu = u - i, fv = v - j;
  const read = (k) => {
    const a = cover[(j * size + i) * 2 + k], b = cover[(j * size + i + 1) * 2 + k], c = cover[((j + 1) * size + i) * 2 + k], d = cover[((j + 1) * size + i + 1) * 2 + k];
    return ((a * (1 - fu) + b * fu) * (1 - fv) + (c * (1 - fu) + d * fu) * fv) / 255;
  };
  return groveSmoothstep(FOREST_GROVE_EDGE, FOREST_GROVE_FULL, read(0)) * (1 - groveSmoothstep(0, FOREST_GROVE_TAKEN, read(1)));
}

const groveHash = (a, b) => {
  let v = (Math.imul(a | 0, 0x9e3779b1) ^ Math.imul(b | 0, 0x85ebca6b) ^ 0x27d4eb2f) >>> 0;
  v = Math.imul(v ^ (v >>> 16), 0x7feb352d) >>> 0;
  v = Math.imul(v ^ (v >>> 15), 0x846ca68b) >>> 0;
  return (v ^ (v >>> 16)) >>> 0;
};

// Every tree of the pack's grove that stands on one section: each square of the grove laid over the section
// from its corner, as one of the baked groves chosen by where it lies, and of its trees those where the cover
// says the wood stands. visit(x, z, kind, scale, yaw, seed) is told each; the section's own rules for a tree
// (js/terrain.js) say whether it is planted. A grove's square holds its trees whole, so a tree is visited by
// the one square it stands in, and any grove beside any other keeps its trees apart.
export function forestGroveTrees({ stand, cover, size, region, harbour, visit }) {
  const m = stand.manifest, tile = m.tileMetres, trees = stand.trees, span = region.span;
  const x0 = region.x - span / 2, z0 = region.z - span / 2, side = Math.ceil(span / tile - 1e-6), per = size / span * tile;
  const harbourShare = m.harbourHeight ?? FOREST_GROVE_HARBOUR_HEIGHT;
  for (let tj = 0; tj < side; tj++) for (let ti = 0; ti < side; ti++) {
    // A square with no wood in its cover holds no tree.
    const a0 = Math.max(0, Math.floor(ti * per)), a1 = Math.min(size, Math.ceil((ti + 1) * per)), b0 = Math.max(0, Math.floor(tj * per)), b1 = Math.min(size, Math.ceil((tj + 1) * per));
    let wooded = false;
    search: for (let j = b0; j < b1; j++) for (let i = a0; i < a1; i++) {
      const at = (j * size + i) * 2;
      if (cover[at] > FOREST_GROVE_EDGE * 255 && cover[at + 1] < FOREST_GROVE_TAKEN * 255) { wooded = true; break search; }
    }
    if (!wooded) continue;
    const tx = x0 + ti * tile, tz = z0 + tj * tile, placeX = Math.round(tx / tile), placeZ = Math.round(tz / tile);
    const variant = groveHash(placeX, placeZ) % FOREST_GROVE_VARIANTS;
    for (let id = 1; id < m.maxTrees; id++) {
      const at = (variant * m.maxTrees + id) * FOREST_GROVE_TREE_FLOATS, scale = trees[at + 3];
      if (!(scale > 0)) continue;
      const x = tx + trees[at], z = tz + trees[at + 1];
      if (x <= x0 || z <= z0 || x >= x0 + span || z >= z0 + span) continue;
      const standing = forestGroveStanding(cover, size, region, x, z);
      if (standing < FOREST_GROVE_STANDS) continue;
      const mantle = FOREST_GROVE_MANTLE + (1 - FOREST_GROVE_MANTLE) * groveSmoothstep(FOREST_GROVE_STANDS, 1, standing);
      const inland = groveSmoothstep(FOREST_GROVE_INLAND_METRES[0], FOREST_GROVE_INLAND_METRES[1], Math.hypot(x - harbour.x, z - harbour.z));
      const seed = groveHash(groveHash(placeX, placeZ), id);
      // The same grove laid twice is turned differently tree by tree, so no square repeats another.
      const yaw = (trees[at + 2] + seed / 4294967296 * Math.PI * 2) % (Math.PI * 2);
      visit(x, z, trees[at + 4] | 0, scale * mantle * (harbourShare + (1 - harbourShare) * inland), yaw, seed);
    }
  }
}

// What tells one state of a section's ground from another, so that its grove is planted again only when its
// ground, its marking, its town or its planted trees have changed.
export function forestGroveStamp(section, planted) {
  const { region, heights, biome } = section;
  let ground = 0, marked = 0, trees = planted.length;
  for (let i = 0; i < heights.length; i += 7) ground = (ground * 31 + Math.round(heights[i] * 64)) | 0;
  for (let i = 0; i < biome.length; i += 5) marked = (marked * 33 + biome[i]) | 0;
  for (let i = 0; i < planted.length; i += FOREST_GROVE_ROOT_FLOATS) trees = (trees * 31 + Math.round(planted[i] * 8) + Math.round(planted[i + 2] * 8) * 7) | 0;
  return [region.x, region.z, region.span, region.size, region.biomeSize, ground, marked, trees, section.port?.waterfront?.length ?? 0, section.port?.streets?.size ?? 0, section.beaches?.drySandMask ? 1 : 0, section.port?.country?.riverReaches?.length ?? 0].join(',');
}

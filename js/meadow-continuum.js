// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Meadow grass in the one continuum (AGENTS.md rule 3). Each 4 m sward of the Portuguese meadow groves (forestmodeler's
// tiles: cocksfoot, wild oat, ripgut brome and ribwort plantain, plant by plant at full resolution) is baked by
// scripts/prepare-meadow-grass.mjs into one atlas: a cluster hierarchy the GPU cuts by projected error, whose coarser
// levels keep fewer organs of every plant and widen the kept ones to cover what the whole plant did; a closed canopy
// body over the patch that collapses one half-edge at a time down to a few triangles; and a single splat. A meadow is
// these patches laid edge to edge on the ground. The GPU side is in js/meadow-grass.js.

export const MEADOW_CONTINUUM_FORMAT = 'waterworld.meadow-continuum';
export const MEADOW_CONTINUUM_VERSION = 1;
export const MEADOW_CONTINUUM_MAGIC = 0x4d43_4e43;
// The side of one patch, in metres: the source's own tile.
export const MEADOW_PATCH_METRES = 4;
// Levels of the hierarchy inside a patch: cells 16 to a side at the finest, one at the coarsest.
export const MEADOW_CONTINUUM_LEVELS = 5;
export const MEADOW_CONTINUUM_CELLS = 16;
// The atlas: a header, one record a variant, the clusters of every variant, the vertices, the indices, then each
// variant's far body (collapse records, triangles in order of death, steps). Every number a 32-bit word.
export const MEADOW_CONTINUUM_HEADER_WORDS = 24;
export const MEADOW_CONTINUUM_HEADER = Object.freeze({
  magic: 0, version: 1, variantCount: 2, variantsAt: 3, clustersAt: 4, clusterCount: 5, verticesAt: 6, vertexCount: 7,
  indicesAt: 8, indexCount: 9, chainsAt: 10, words: 11, patch: 12, low: 13, span: 16,
});
export const MEADOW_CONTINUUM_VARIANT_WORDS = 32;
// Where each of a variant's numbers lies in its record. Positions are in the patch's own metres, its corner at the
// origin; `sphere` bounds everything it can draw, overhang included; `growth` is how much each level widens the
// organs it keeps (1 at the finest).
export const MEADOW_CONTINUUM_VARIANT = Object.freeze({
  clusterFirst: 0, clusterCount: 1, chainVertices: 2, chainVertexCount: 3, records: 4, triangles: 5, steps: 6, stepCount: 7,
  chainTriangleCount: 8, farFirst: 9, baseError: 10, canopy: 11, sphere: 12, topColour: 16, sideColour: 19, mix: 22,
  sourceTriangles: 23, growth: 24,
});
// A cluster: its LOD sphere, its parent cell's, its culling sphere, its error and its parent's (metres), the first of
// its indices, and its triangles | level << 8. A variant's clusters are stored coarsest parent first.
export const MEADOW_CONTINUUM_CLUSTER_WORDS = 16;
export const MEADOW_CONTINUUM_CLUSTER_TRIANGLES = 128;
// A vertex: x | y << 16; z | along << 16 | stiffness << 24 | clump << 28; octahedral normal (8 + 8) and the widening
// offset's x and y (signed, 1/1024 m); colour (gamma 2.2, 8 + 8 + 8) and the offset's z.
export const MEADOW_CONTINUUM_VERTEX_WORDS = 4;
export const MEADOW_CONTINUUM_OFFSET_UNIT = 1 / 1024;
export const MEADOW_CONTINUUM_STIFFNESS_UNIT = 1.5;
// A far-body step: triangles alive (a prefix), error in metres, how far along its normals the surface is grown to
// keep the outline its collapses take in, and a spare word.
export const MEADOW_CONTINUUM_STEP_WORDS = 4;
// A far-body triangle: its three corners and a spare word.
export const MEADOW_CONTINUUM_TRIANGLE_WORDS = 4;
// A far-body vertex that never collapses holds this step in its record (step | target << 16).
export const MEADOW_CONTINUUM_NEVER = 65535;
// The most collapses one far-body vertex may pass through, as far as the GPU follows them.
export const MEADOW_CONTINUUM_HOPS = 128;
// The far body is drawn in pieces of this many triangles.
export const MEADOW_CONTINUUM_CHUNK_TRIANGLES = 32;

// The baked atlas and its manifest. Spelled out, not composed, because the build publishes (and versions) only the
// asset paths it finds quoted in the source.
export const PORTUGAL_MEADOW_GRASS_ASSETS = Object.freeze({
  'manifest.json': 'assets/ground-cover/portugal/meadows-gpu/manifest.json',
  'atlas.bin.gz': 'assets/ground-cover/portugal/meadows-gpu/atlas.bin.gz',
});

const meadowUnit = (v, bits) => Math.max(0, Math.min((1 << bits) - 1, Math.round(v * ((1 << bits) - 1))));
const meadowSigned8 = (v) => Math.max(-127, Math.min(127, Math.round(v / MEADOW_CONTINUUM_OFFSET_UNIT))) & 255;
// Octahedral normal, so two numbers hold a whole direction.
export function meadowContinuumOctahedral([x, y, z]) {
  const length = Math.abs(x) + Math.abs(y) + Math.abs(z) || 1;
  let u = x / length, v = y / length;
  if (z / length < 0) { const a = u; u = (1 - Math.abs(v)) * (a >= 0 ? 1 : -1); v = (1 - Math.abs(a)) * (v >= 0 ? 1 : -1); }
  return [u * 0.5 + 0.5, v * 0.5 + 0.5];
}
// One vertex as four words, its position quantized over the atlas's `low` and `span`.
export function packMeadowContinuumVertex({ position, normal, colour, along = 0, stiffness = 0, clump = 0, offset = [0, 0, 0] }, { low, span }) {
  const q = position.map((v, a) => meadowUnit((v - low[a]) / span, 16));
  const n = meadowContinuumOctahedral(normal), c = colour.map((v) => meadowUnit(Math.max(0, v) ** (1 / 2.2), 8));
  const stiff = Math.max(0, Math.min(15, Math.round(stiffness / MEADOW_CONTINUUM_STIFFNESS_UNIT)));
  return [
    (q[0] | (q[1] << 16)) >>> 0,
    (q[2] | (meadowUnit(along, 8) << 16) | (stiff << 24) | (Math.max(0, Math.min(15, Math.floor(clump * 16))) << 28)) >>> 0,
    (meadowUnit(n[0], 8) | (meadowUnit(n[1], 8) << 8) | (meadowSigned8(offset[0]) << 16) | (meadowSigned8(offset[1]) << 24)) >>> 0,
    (c[0] | (c[1] << 8) | (c[2] << 16) | (meadowSigned8(offset[2]) << 24)) >>> 0,
  ];
}
export function unpackMeadowContinuumVertex(words, at, { low, span }) {
  const w = (k) => words[at + k], s8 = (v) => ((v & 255) << 24 >> 24) * MEADOW_CONTINUUM_OFFSET_UNIT;
  const q = [w(0) & 65535, w(0) >>> 16, w(1) & 65535];
  const e = [(w(2) & 255) / 255, ((w(2) >>> 8) & 255) / 255], fx = e[0] * 2 - 1, fy = e[1] * 2 - 1, n = [fx, fy, 1 - Math.abs(fx) - Math.abs(fy)], t = Math.max(-n[2], 0);
  n[0] += n[0] >= 0 ? -t : t; n[1] += n[1] >= 0 ? -t : t;
  const l = Math.hypot(...n) || 1;
  return {
    position: q.map((v, a) => low[a] + (v / 65535) * span),
    normal: n.map((x) => x / l),
    colour: [0, 8, 16].map((b) => (((w(3) >>> b) & 255) / 255) ** 2.2),
    along: ((w(1) >>> 16) & 255) / 255,
    stiffness: ((w(1) >>> 24) & 15) * MEADOW_CONTINUUM_STIFFNESS_UNIT,
    clump: ((w(1) >>> 28) + 0.5) / 16,
    offset: [s8(w(2) >>> 16), s8(w(2) >>> 24), s8(w(3) >>> 24)],
  };
}
export function packMeadowContinuumCluster({ lod, parentLod, cull, error, parentError, first, triangles, level }) {
  const words = new ArrayBuffer(MEADOW_CONTINUUM_CLUSTER_WORDS * 4), f = new Float32Array(words), u = new Uint32Array(words);
  if (!(triangles > 0 && triangles <= MEADOW_CONTINUUM_CLUSTER_TRIANGLES)) throw Error(`A meadow cluster holds ${triangles} triangles`);
  f.set(lod, 0); f.set(parentLod, 4); f.set(cull, 8);
  f[12] = error; f[13] = Math.min(parentError, 1e30);
  u[14] = first;
  u[15] = (triangles | (Math.min(level, 255) << 8)) >>> 0;
  return u;
}

export function validateMeadowGrass(manifest) {
  if (manifest?.format !== MEADOW_CONTINUUM_FORMAT || manifest.version !== MEADOW_CONTINUUM_VERSION) throw Error('Invalid meadow continuum manifest');
  if (manifest.patchMetres !== MEADOW_PATCH_METRES || manifest.levels !== MEADOW_CONTINUUM_LEVELS) throw Error('The meadow continuum has another patch or hierarchy');
  const { variants, atlas } = manifest;
  if (!Array.isArray(variants) || variants.length !== 12) throw Error('The meadow continuum needs its 12 variants');
  variants.forEach((variant, id) => {
    if (variant.id !== id || !(variant.mix >= 0 && variant.mix < 3)) throw Error(`Meadow continuum variant ${id} is malformed`);
    if (!(variant.clusters > 0) || !(variant.chain?.baseTriangles >= 4) || !(variant.chain.steps >= 1 && variant.chain.steps < MEADOW_CONTINUUM_NEVER)) throw Error(`Meadow continuum variant ${id} is incomplete`);
    if (!(variant.chain.coreTriangles >= 4 && variant.chain.coreTriangles <= 6)) throw Error(`Meadow continuum variant ${id} ends in ${variant.chain.coreTriangles} triangles`);
  });
  if (!(atlas?.words > MEADOW_CONTINUUM_HEADER_WORDS) || atlas.bytes !== atlas.words * 4 || !/^[0-9a-f]{64}$/.test(atlas.sha256 ?? '') || !atlas.gzip?.file) throw Error('The meadow continuum atlas is malformed');
  return manifest;
}

// The atlas, fetched, unpacked and checked against its receipt. Resolves to { manifest, words }.
export async function loadMeadowGrass({ assets = PORTUGAL_MEADOW_GRASS_ASSETS, fetchAsset = fetch, signal } = {}) {
  const get = async (name) => {
    const response = await fetchAsset(assets[name], signal ? { signal } : undefined);
    if (!response.ok) throw Error(`Meadow continuum unavailable (${response.status}): ${name}`);
    return response;
  };
  const manifest = validateMeadowGrass(await (await get('manifest.json')).json());
  const response = await get('atlas.bin.gz');
  const bytes = new Uint8Array(await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  if (bytes.byteLength !== manifest.atlas.bytes) throw Error('The meadow continuum atlas has the wrong size');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  if (Array.from(digest, (v) => v.toString(16).padStart(2, '0')).join('') !== manifest.atlas.sha256) throw Error('The meadow continuum atlas failed verification');
  const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  if (words[MEADOW_CONTINUUM_HEADER.magic] !== MEADOW_CONTINUUM_MAGIC || words[MEADOW_CONTINUUM_HEADER.version] !== MEADOW_CONTINUUM_VERSION) throw Error('The meadow continuum atlas is of another format');
  return { manifest, words };
}

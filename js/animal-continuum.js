// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Every animal in the one continuum (AGENTS.md rule 3): the herds' sheep, cattle, swine and horses, the road's wains,
// coaches and ox-carts, and the sea's dolphins, sharks and whale. scripts/prepare-animal-continuum.mjs bakes each
// type from the mesh its builder makes into a cluster hierarchy the GPU cuts by projected error, a closed far body
// that collapses one half-edge at a time to a few triangles, and a single splat. Every vertex carries its skin (the
// herd rig's part, coat and shard; a sea animal's colour; the whale's joints, weights and texture place), so clusters
// and far body alike are posed on the GPU as the full mesh is, and each cluster's bounds hold every pose its rig can
// take (its pose slack). One atlas holds them all; js/wgsl/animal-continuum.js cuts and reads it, and
// js/animal-continuum-draw.js keeps each family's lists.

export const ANIMAL_CONTINUUM_FORMAT = 'waterworld.animal-continuum';
export const ANIMAL_CONTINUUM_VERSION = 1;
export const ANIMAL_CONTINUUM_MAGIC = 0x4c4d_4e41;
// The atlas: a header, one record a type, the clusters of every type, their vertices and indices, then each type's
// far body (vertices, collapse records, triangles in order of death, steps). Every number a 32-bit word.
export const ANIMAL_CONTINUUM_HEADER_WORDS = 16;
export const ANIMAL_CONTINUUM_HEADER = Object.freeze({ magic: 0, version: 1, typeCount: 2, typesAt: 3, clustersAt: 4, clusterCount: 5, verticesAt: 6, vertexCount: 7, indicesAt: 8, indexCount: 9, chainsAt: 10, words: 11 });
export const ANIMAL_CONTINUUM_TYPE_WORDS = 48;
// Where each of a type's numbers lies in its record, in the type's own metres at rest. `sphere` bounds everything it
// draws in every pose its rig takes standing; `felledRadius` the same about the same centre, lying felled. The splat
// is the outline's ellipse seen from the side and from the front. `neck` and `legs` are a herd type's rig.
export const ANIMAL_CONTINUUM_TYPE = Object.freeze({
  low: 0, span: 3, sphere: 4, clusterFirst: 8, clusterCount: 9, chainVertices: 10, stepCount: 11, chainVertexCount: 12, records: 13,
  triangles: 14, steps: 15, baseError: 16, rootError: 17, splatRxSide: 18, splatRxFront: 19, splatRy: 20, splatCentre: 21, splatColour: 24,
  felledRadius: 27, chainTriangleCount: 28, family: 29, sourceTriangles: 30, farFirst: 31, neck: 32, legs: 36, shatterReach: 40,
});
// A cluster: its LOD sphere, its parent group's, its culling sphere (each grown by its pose slack), its error and its
// parent's (metres, measured posed), the first of its indices, and its triangles | level << 8 | part << 16.
export const ANIMAL_CONTINUUM_CLUSTER_WORDS = 16;
// A vertex: x | y << 16, z, octahedral normal, then five words of skin (ANIMAL_CONTINUUM_SKIN).
export const ANIMAL_CONTINUUM_VERTEX_WORDS = 8;
export const ANIMAL_CONTINUUM_SKIN_WORDS = 5;
// A far-body step: triangles alive (a prefix), error in metres, how far along its normals the surface is grown to keep
// the outline its collapses take in, and a spare word. A far-body triangle: its three corners and a spare word.
export const ANIMAL_CONTINUUM_STEP_WORDS = 4;
export const ANIMAL_CONTINUUM_TRIANGLE_WORDS = 4;
// A far-body vertex that never collapses holds this step in its record (step | target << 16).
export const ANIMAL_CONTINUUM_NEVER = 65535;
// The most collapses one far-body vertex may pass through, as far as the GPU follows them.
export const ANIMAL_CONTINUUM_HOPS = 256;
// The far body is drawn in pieces of this many triangles; clusters of at most ANIMAL_CONTINUUM_SMALL_CLUSTER
// triangles from a list of their own.
export const ANIMAL_CONTINUUM_CHUNK_TRIANGLES = 32;
export const ANIMAL_CONTINUUM_CLUSTER_TRIANGLES = 128;
export const ANIMAL_CONTINUUM_SMALL_CLUSTER = 32;

// The catalogue. A herd's species is its type; the sea's animals follow.
export const ANIMAL_CONTINUUM_TYPES = Object.freeze(['sheep', 'cattle', 'swine', 'horse', 'wain', 'coach', 'ox cart', 'dolphin', 'shark', 'whale']);
export const ANIMAL_TYPE = Object.freeze({ sheep: 0, cattle: 1, swine: 2, horse: 3, wain: 4, coach: 5, oxCart: 6, dolphin: 7, shark: 8, whale: 9 });
// How a type is skinned and shaded: a herd beast (part and coat), a road vehicle (part, coat and shard), a sea animal
// bent by its stroke (colour), the whale (colour, joints, weights and its texture's place).
export const ANIMAL_FAMILY = Object.freeze({ livestock: 0, vehicle: 1, sea: 2, whale: 3 });
// The herd rig's largest downward neck-and-head pitch while grazing, by species (radians).
export const ANIMAL_CONTINUUM_GRAZE_PITCH = Object.freeze([0.52, 0.44, 0.28, 0.40, 0, 0, 0]);

// An animal's place, sixteen floats, written by its family each frame (the herds' GPU step, the sea's CPU state):
//   root   x, y, z (the drawn world: the herds' shifted, the sea's y its depth about the mean sea), yaw
//   frame  pitch, roll, scale (0 hides it), code = type + ANIMAL_PLACE_CODE * flags + ANIMAL_PLACE_SEED * seed
//   pose, more: the family's own (js/wgsl/herds.js, js/wgsl/dolphins.js for the sea)
// It is placed as root + Ry(yaw) Rx(pitch) Rz(roll) (scale * the posed point). The seed (12 bits) thins its splat at
// the horizon; animals sharing it (a wagon and its team) thin together. The code stays below 2^24, exact in a float.
export const ANIMAL_PLACE_FLOATS = 16;
export const ANIMAL_PLACE_CODE = 256;
export const ANIMAL_PLACE_SEED = 4096;
export function animalPlaceCode(type, flags = 0, seed = 0) { return type + ANIMAL_PLACE_CODE * (flags & 15) + ANIMAL_PLACE_SEED * (seed & 4095); }
// Flags of a place. An exact animal (felled, shattered, anything its rig's slack does not bound) is cut as one body at
// its nearest point, every cluster at the finest its error bound allows there. A shattered one never hands off to a
// far body or splat, which would cross its shards. A sea animal stands on the waves, which its bounds allow for.
export const ANIMAL_PLACE_EXACT = 1;
export const ANIMAL_PLACE_SHATTERED = 2;
export const ANIMAL_PLACE_SEA = 4;
// How far the sea's waves and swell may lift or drop an animal from the mean sea, in metres.
export const ANIMAL_CONTINUUM_SEA_REACH = 5;

// The baked atlas and its manifest. Spelled out, not composed, because the build publishes (and versions) only the
// asset paths it finds quoted in the source. Both are kept in git: every animal is drawn from nothing else.
export const ANIMAL_CONTINUUM_ASSETS = Object.freeze({
  'manifest.json': 'assets/animal-continuum/manifest.json',
  'atlas.bin.gz': 'assets/animal-continuum/atlas.bin.gz',
});

const animalUnit16 = (v) => Math.max(0, Math.min(65535, Math.round(v * 65535)));
const animalBits = new DataView(new ArrayBuffer(4));
// A float's bits, as the skin's words carry it.
export function animalContinuumFloatBits(value) { animalBits.setFloat32(0, value, true); return animalBits.getUint32(0, true); }
export function animalContinuumBitsFloat(word) { animalBits.setUint32(0, word >>> 0, true); return animalBits.getFloat32(0, true); }
// Two numbers in 0..1 as one word, 16 bits each.
export function animalContinuumUnorm2(a, b) { return (animalUnit16(a) | (animalUnit16(b) << 16)) >>> 0; }
// Octahedral normal, so two 16-bit values hold a whole direction.
export function animalContinuumOctahedral([x, y, z]) {
  const length = Math.abs(x) + Math.abs(y) + Math.abs(z) || 1;
  let u = x / length, v = y / length;
  if (z / length < 0) { const a = u; u = (1 - Math.abs(v)) * (a >= 0 ? 1 : -1); v = (1 - Math.abs(a)) * (v >= 0 ? 1 : -1); }
  return [u * 0.5 + 0.5, v * 0.5 + 0.5];
}
export function animalContinuumOctahedralNormal([u, v]) {
  const fx = u * 2 - 1, fy = v * 2 - 1, n = [fx, fy, 1 - Math.abs(fx) - Math.abs(fy)], t = Math.max(-n[2], 0);
  n[0] += n[0] >= 0 ? -t : t; n[1] += n[1] >= 0 ? -t : t;
  const l = Math.hypot(...n) || 1;
  return n.map((x) => x / l);
}
// One vertex as eight words, its position quantized over its type's `low` and `span`, its skin as baked.
export function packAnimalContinuumVertex({ position, normal, skin }, { low, span }) {
  const p = position.map((v, a) => animalUnit16((v - low[a]) / span)), n = animalContinuumOctahedral(normal);
  if (skin.length !== ANIMAL_CONTINUUM_SKIN_WORDS) throw Error('An animal vertex needs five words of skin');
  return [(p[0] | (p[1] << 16)) >>> 0, p[2] >>> 0, animalContinuumUnorm2(n[0], n[1]), ...Array.from(skin, (w) => w >>> 0)];
}
export function unpackAnimalContinuumVertex(words, at, { low, span }) {
  const w = (k) => words[at + k];
  return {
    position: [w(0) & 65535, w(0) >>> 16, w(1) & 65535].map((v, a) => low[a] + (v / 65535) * span),
    normal: animalContinuumOctahedralNormal([(w(2) & 65535) / 65535, (w(2) >>> 16) / 65535]),
    skin: Array.from({ length: ANIMAL_CONTINUUM_SKIN_WORDS }, (_, k) => w(3 + k)),
  };
}
export function packAnimalContinuumCluster({ lod, parentLod, cull, error, parentError, first, triangles, level, part }) {
  const words = new ArrayBuffer(ANIMAL_CONTINUUM_CLUSTER_WORDS * 4), f = new Float32Array(words), u = new Uint32Array(words);
  if (!(triangles > 0 && triangles <= ANIMAL_CONTINUUM_CLUSTER_TRIANGLES)) throw Error(`An animal cluster holds ${triangles} triangles`);
  f.set(lod, 0); f.set(parentLod, 4); f.set(cull, 8);
  f[12] = error; f[13] = Math.min(parentError, 1e30);
  u[14] = first;
  u[15] = (triangles | (Math.min(level, 255) << 8) | ((part & 65535) << 16)) >>> 0;
  return u;
}

export function validateAnimalContinuumManifest(manifest) {
  if (manifest?.format !== ANIMAL_CONTINUUM_FORMAT || manifest.version !== ANIMAL_CONTINUUM_VERSION) throw Error('Invalid animal continuum manifest');
  const { types, atlas } = manifest;
  if (!Array.isArray(types) || types.length !== ANIMAL_CONTINUUM_TYPES.length) throw Error('The animal continuum does not hold every type');
  types.forEach((type, id) => {
    if (type.id !== id || type.name !== ANIMAL_CONTINUUM_TYPES[id] || !/^[0-9a-f]{64}$/.test(type.fingerprint ?? '')) throw Error(`Animal continuum type ${id} is malformed`);
    if (!(type.clusters?.count > 0) || !(type.chain?.baseTriangles >= 4) || !(type.chain.steps >= 1 && type.chain.steps < ANIMAL_CONTINUUM_NEVER)) throw Error(`Animal continuum type ${id} is incomplete`);
  });
  if (!(atlas?.words > ANIMAL_CONTINUUM_HEADER_WORDS) || atlas.bytes !== atlas.words * 4 || !/^[0-9a-f]{64}$/.test(atlas.sha256 ?? '') || !atlas.gzip?.file) throw Error('The animal continuum atlas is malformed');
  return manifest;
}

// The atlas, fetched, unpacked and checked against its receipt. Resolves to { manifest, words }.
export async function loadAnimalContinuum({ fetchAsset = fetch } = {}) {
  const get = async (path) => {
    const response = await fetchAsset(path);
    if (!response.ok) throw Error(`Animal continuum unavailable (${response.status}): ${path}`);
    return response;
  };
  const manifest = validateAnimalContinuumManifest(await (await get(ANIMAL_CONTINUUM_ASSETS['manifest.json'])).json());
  const response = await get(ANIMAL_CONTINUUM_ASSETS['atlas.bin.gz']);
  const bytes = new Uint8Array(await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  if (bytes.byteLength !== manifest.atlas.bytes) throw Error('The animal continuum atlas has the wrong size');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  if (Array.from(digest, (v) => v.toString(16).padStart(2, '0')).join('') !== manifest.atlas.sha256) throw Error('The animal continuum atlas failed verification');
  const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  if (words[ANIMAL_CONTINUUM_HEADER.magic] !== ANIMAL_CONTINUUM_MAGIC || words[ANIMAL_CONTINUUM_HEADER.version] !== ANIMAL_CONTINUUM_VERSION) throw Error('The animal continuum atlas is of another format');
  return { manifest, words };
}

// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The port props and round shot in the one continuum (AGENTS.md rule 3). Each prop model (js/port-props.js
// PROP_MODELS) is baked by scripts/prepare-prop-continuum.mjs from the very mesh its physics strikes, shard by shard,
// into a cluster hierarchy the GPU cuts by projected error, a closed far body wrapped round it that collapses one
// half-edge at a time to a few triangles, and a single splat; round shot is a cast-iron sphere baked the same way.
// The bake is the city's (scripts/prepare-city-continuum.mjs), and so is the atlas's layout (js/city-continuum.js):
// a header, a record a type, clusters, their vertices and indices, then each type's far body. Only a vertex's last
// word differs: a prop's surface is its texture, so it carries its UV where a building carries its kind. One atlas
// holds every type, so props and shot are cut by one program (js/wgsl/prop-continuum.js) and drawn by one list a
// pass (js/prop-continuum-draw.js).
import { PROP_MODELS } from './port-props.js';
import { cityContinuumOctahedral } from './city-continuum.js';

export const PROP_CONTINUUM_FORMAT = 'waterworld.prop-continuum';
export const PROP_CONTINUUM_VERSION = 1;
export const PROP_CONTINUUM_MAGIC = 0x5052_4e43;
// A type's record: the city's (CITY_CONTINUUM_TYPE), but where a building keeps its roof and walls a prop keeps the
// layer of its pigment (PROP_CONTINUUM_PLAIN for none), and a plain type its albedo (linear) and roughness.
export const PROP_CONTINUUM_TYPE = Object.freeze({
  low: 0, span: 3, sphere: 4, clusterFirst: 8, clusterCount: 9, chainVertices: 10, stepCount: 11,
  chainVertexCount: 12, records: 13, triangles: 14, steps: 15, baseError: 16, rootError: 17, splatRx: 18, splatRy: 19,
  splatCentre: 20, layer: 23, albedo: 24, roughness: 27, chainTriangleCount: 28, flags: 29, sourceTriangles: 30, farFirst: 31,
});
export const PROP_CONTINUUM_PLAIN = 0xffffffff;
// What the crews work their guns, keep watch and fight with, and the arrows that strike them, each piece at its own
// size (js/crew-work.js crewGunneryTool, js/gunnery-models.js VESSEL_SIDEARMS, js/crew-wounds.js CREW_ARROW_LENGTH):
// a round rod `length` metres up its own +y from its origin, `radius` across, of `material` (0 iron or brass, 1 wood,
// 2 fibre: fleece, hemp or feather), turned to lie along whatever holds it. A fall of tackle is the one piece drawn
// out to the length it is hauled to.
export const PROP_CONTINUUM_TOOLS = Object.freeze([
  { name: 'rammer-staff', length: 1.32, radius: 0.021, material: 1 },
  { name: 'rammer-head', length: 0.12, radius: 0.044, material: 1 },
  { name: 'sponge-head', length: 0.12, radius: 0.065, material: 2 },
  { name: 'spyglass-tube', length: 0.38, radius: 0.014, material: 1 },
  { name: 'spyglass-cell', length: 0.14, radius: 0.022, material: 0 },
  { name: 'swivel-chamber', length: 0.24, radius: 0.055, material: 0 },
  { name: 'cutlass', length: 0.72, radius: 0.012, material: 0 },
  { name: 'macana', length: 0.66, radius: 0.03, material: 1 },
  { name: 'tackle-fall', length: 1, radius: 0.019, material: 2, hauled: true },
  { name: 'arrow-shaft', length: 0.66, radius: 0.011, material: 1 },
  { name: 'arrow-fletching', length: 0.1, radius: 0.02, material: 2 },
].map((tool) => Object.freeze(tool)));
// Each material's albedo (linear) and roughness, as the tools were always lit.
export const PROP_CONTINUUM_TOOL_MATERIALS = Object.freeze([
  Object.freeze({ albedo: Object.freeze([0.032, 0.035, 0.038]), roughness: 0.38 }),
  Object.freeze({ albedo: Object.freeze([0.11, 0.075, 0.037]), roughness: 0.8 }),
  Object.freeze({ albedo: Object.freeze([0.07, 0.055, 0.04]), roughness: 0.8 }),
]);
// A round rod's sides.
export const PROP_CONTINUUM_TOOL_SIDES = 16;
// The catalogue: every port prop in PROP_MODELS order, its pigment in the layer of the same number, then round shot,
// then the tools.
export const PROP_CONTINUUM_SHOT = PROP_MODELS.length;
export const PROP_CONTINUUM_TOOL_FIRST = PROP_CONTINUUM_SHOT + 1;
export const PROP_CONTINUUM_TYPES = Object.freeze([...PROP_MODELS.map((spec) => spec.id), 'round-shot', ...PROP_CONTINUUM_TOOLS.map((tool) => tool.name)]);
export const propContinuumTool = (name) => {
  const at = PROP_CONTINUUM_TOOLS.findIndex((tool) => tool.name === name);
  if (at < 0) throw Error(`No such tool: ${name}`);
  return at;
};
// Round shot: a cast-iron sphere of unit radius, placed at each ball's own. Iron dark with its scale and black lead.
export const PROP_CONTINUUM_SHOT_IRON = Object.freeze({ albedo: Object.freeze([0.038, 0.034, 0.029]), roughness: 0.62 });
export const PROP_CONTINUUM_SHOT_SUBDIVISIONS = 4;
// The pigments are one array of layers this many texels square, every model's image fitted to it.
export const PROP_CONTINUUM_PIGMENT_SIZE = 1024;

// The baked atlas and its manifest. Spelled out, not composed, because the build publishes (and versions) only the
// asset paths it finds quoted in the source. Both are kept in git: props and shot are drawn from nothing else.
export const PROP_CONTINUUM_ASSETS = Object.freeze({
  'manifest.json': 'assets/prop-continuum/manifest.json',
  'atlas.bin.gz': 'assets/prop-continuum/atlas.bin.gz',
});

const propUnit16 = (v) => Math.max(0, Math.min(65535, Math.round(v * 65535)));
// A UV pair in one word, two 16-bit fractions.
export function packPropContinuumUV([u, v]) {
  if (!(u >= 0 && u <= 1 && v >= 0 && v <= 1)) throw Error(`A prop's UV lies outside its pigment: ${u}, ${v}`);
  return (propUnit16(u) | (propUnit16(v) << 16)) >>> 0;
}
export const unpackPropContinuumUV = (word) => [(word & 65535) / 65535, (word >>> 16) / 65535];
// One vertex as four 32-bit words: position quantized over its type's `low` and `span`, an octahedral normal, its UV.
export function packPropContinuumVertex({ position, normal, uv }, { low, span }) {
  const p = position.map((v, a) => propUnit16((v - low[a]) / span)), n = cityContinuumOctahedral(normal);
  return [(p[0] | (p[1] << 16)) >>> 0, p[2] >>> 0, (propUnit16(n[0]) | (propUnit16(n[1]) << 16)) >>> 0, packPropContinuumUV(uv)];
}

// Round shot as cast: a sphere of unit radius, an icosahedron halved `subdivisions` times over and pushed out to the
// sphere, as the bake reads a prop (eight floats a corner: position, normal, UV; one part). It is drawn at each
// ball's own radius, so its near detail is a true sphere at any size a gun throws.
export function roundShotSource(subdivisions = PROP_CONTINUUM_SHOT_SUBDIVISIONS) {
  const t = (1 + Math.sqrt(5)) / 2;
  let points = [[-1, t, 0], [1, t, 0], [-1, -t, 0], [1, -t, 0], [0, -1, t], [0, 1, t], [0, -1, -t], [0, 1, -t], [t, 0, -1], [t, 0, 1], [-t, 0, -1], [-t, 0, 1]].map((p) => { const l = Math.hypot(...p); return p.map((x) => x / l); });
  let faces = [[0, 11, 5], [0, 5, 1], [0, 1, 7], [0, 7, 10], [0, 10, 11], [1, 5, 9], [5, 11, 4], [11, 10, 2], [10, 7, 6], [7, 1, 8], [3, 9, 4], [3, 4, 2], [3, 2, 6], [3, 6, 8], [3, 8, 9], [4, 9, 5], [2, 4, 11], [6, 2, 10], [8, 6, 7], [9, 8, 1]];
  for (let s = 0; s < subdivisions; s++) {
    const middle = new Map(), next = [];
    const mid = (a, b) => {
      const key = a < b ? `${a}:${b}` : `${b}:${a}`;
      if (!middle.has(key)) { const p = points[a].map((x, k) => x + points[b][k]), l = Math.hypot(...p); middle.set(key, points.push(p.map((x) => x / l)) - 1); }
      return middle.get(key);
    };
    for (const [a, b, c] of faces) { const ab = mid(a, b), bc = mid(b, c), ca = mid(c, a); next.push([a, ab, ca], [b, bc, ab], [c, ca, bc], [ab, bc, ca]); }
    faces = next;
  }
  const vertices = new Float32Array(faces.length * 24);
  faces.forEach((face, f) => face.forEach((v, k) => vertices.set([...points[v], ...points[v], 0, 0], (f * 3 + k) * 8)));
  return { name: 'round-shot', vertices, triangles: faces.length, parts: new Uint32Array(faces.length) };
}

// A tool as the bake reads a type: a closed round rod up +y, its ends capped, one part. Its length is its own up, so
// its splat (which stands along a body's up) runs along it; it is closed, so it is its own far body's base.
export function toolContinuumSource({ name, length, radius }, sides = PROP_CONTINUUM_TOOL_SIDES) {
  const corners = [];
  const put = (position, normal) => corners.push(...position, ...normal, 0, 0);
  const ring = (k) => { const a = ((k % sides) / sides) * Math.PI * 2; return [Math.cos(a), Math.sin(a)]; };
  for (let k = 0; k < sides; k++) {
    const [c0, s0] = ring(k), [c1, s1] = ring(k + 1), p = (c, s, y) => [c * radius, y, -s * radius], n = (c, s) => [c, 0, -s];
    // The side, wound outward, then each end's fan.
    put(p(c0, s0, 0), n(c0, s0)); put(p(c1, s1, 0), n(c1, s1)); put(p(c1, s1, length), n(c1, s1));
    put(p(c0, s0, 0), n(c0, s0)); put(p(c1, s1, length), n(c1, s1)); put(p(c0, s0, length), n(c0, s0));
    put([0, 0, 0], [0, -1, 0]); put(p(c1, s1, 0), [0, -1, 0]); put(p(c0, s0, 0), [0, -1, 0]);
    put([0, length, 0], [0, 1, 0]); put(p(c0, s0, length), [0, 1, 0]); put(p(c1, s1, length), [0, 1, 0]);
  }
  const vertices = Float32Array.from(corners), triangles = vertices.length / 24;
  return { name, vertices, triangles, parts: new Uint32Array(triangles), closed: true };
}

// A prop model as its physics holds it (js/port-props.js readPropModel: cut into shards, every shard's vertices its
// own), as the bake reads a type: eight floats a corner, and its shard as each triangle's part. A shard's clusters
// are then its own, so a broken prop's every shard is a cut of its part riding that shard's flight.
export function propContinuumSource(model, name) {
  const T = model.indices.length / 3, vertices = new Float32Array(T * 24), parts = new Uint32Array(T), shardOf = model.fracture.shardOfVertex;
  for (let t = 0; t < T; t++) {
    for (let k = 0; k < 3; k++) { const v = model.indices[t * 3 + k]; vertices.set(model.vertices.subarray(v * 8, v * 8 + 8), (t * 3 + k) * 8); }
    parts[t] = shardOf[model.indices[t * 3]];
  }
  return { name, vertices, triangles: T, parts };
}

export function validatePropContinuumManifest(manifest) {
  if (manifest?.format !== PROP_CONTINUUM_FORMAT || manifest.version !== PROP_CONTINUUM_VERSION) throw Error('Invalid prop continuum manifest');
  const { types, atlas } = manifest;
  if (!Array.isArray(types) || types.length !== PROP_CONTINUUM_TYPES.length) throw Error('The prop continuum holds the wrong types');
  types.forEach((type, id) => {
    if (type.id !== id || type.name !== PROP_CONTINUUM_TYPES[id] || !/^[0-9a-f]{64}$/.test(type.fingerprint ?? '')) throw Error(`Prop continuum type ${id} is malformed`);
    if (!(type.clusters?.count > 0) || !(type.chain?.baseTriangles >= 4) || !(type.chain.steps >= 1 && type.chain.steps < 65535)) throw Error(`Prop continuum type ${id} is incomplete`);
  });
  if (!(atlas?.words > 16) || atlas.bytes !== atlas.words * 4 || !/^[0-9a-f]{64}$/.test(atlas.sha256 ?? '') || !atlas.gzip?.file) throw Error('The prop continuum atlas is malformed');
  return manifest;
}

// The atlas, fetched, unpacked and checked against its receipt. Resolves to { manifest, words }.
export async function loadPropContinuum({ fetchAsset = fetch } = {}) {
  const get = async (path) => {
    const response = await fetchAsset(path);
    if (!response.ok) throw Error(`Prop continuum unavailable (${response.status}): ${path}`);
    return response;
  };
  const manifest = validatePropContinuumManifest(await (await get(PROP_CONTINUUM_ASSETS['manifest.json'])).json());
  const response = await get(PROP_CONTINUUM_ASSETS['atlas.bin.gz']);
  const bytes = new Uint8Array(await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  if (bytes.byteLength !== manifest.atlas.bytes) throw Error('The prop continuum atlas has the wrong size');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  if (Array.from(digest, (v) => v.toString(16).padStart(2, '0')).join('') !== manifest.atlas.sha256) throw Error('The prop continuum atlas failed verification');
  const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  if (words[0] !== PROP_CONTINUUM_MAGIC || words[1] !== PROP_CONTINUUM_VERSION) throw Error('The prop continuum atlas is of another format');
  return { manifest, words };
}

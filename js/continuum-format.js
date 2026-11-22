// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The one continuum's data (AGENTS.md rule 3): the atlas every family's bodies are baked into, and the instance record
// every family places them with. The one cut (js/wgsl/continuum-cut.js) reads nothing else, so a family brings only
// its source mesh, its instance records, how its points are posed (js/wgsl/continuum-kinds.js) and how its surface is
// worn (a material); never its own selection, handoff or budget.
//
// THE ATLAS. One array of 32-bit words: a header, one record a type, every type's clusters, every vertex, every
// cluster's indices, every type's far body, then the side streams. A family's atlas is assembled from bodies baked
// anywhere (offline, or in the page's bake worker), each packed relocatable (packContinuumBody) and moved into place
// (assembleContinuumAtlas). A loader rejects an atlas of any version but this one: there is no reader of old atlases,
// only a rebake.
//   header  CONTINUUM_HEADER: where each section lies and how long it is, the hop limit and chunk size it was baked
//           for (the cut's own, checked on load), and which side streams it carries and where.
//   type    CONTINUUM_TYPE_WORDS words: its quantization, its bounding sphere, its clusters, its far body (vertices,
//           collapse records, triangles in order of death, steps), the first step the far body is drawn from, its
//           splat (radii, centre, and the baked area factor that shrinks the splat's triangle to its outline's area),
//           its flags, and a block of CONTINUUM_MATERIAL_WORDS that is its family material's own (a city's roof and
//           walls; a prop's pigment layer, albedo and roughness).
//   cluster CONTINUUM_CLUSTER_WORDS: its LOD sphere, its parent group's, its culling sphere, its error and its
//           parent's (metres), the first of its indices, and triangles | level << 8 | part << 16. A type's clusters
//           are stored coarsest parent first, so what can be drawn at an instance's nearest point is a prefix.
//   vertex  CONTINUUM_VERTEX_WORDS: x | y << 16 and z | high << 16 (quantized over the type's low and span), an
//           octahedral normal, and a word. `high` (16 bits) and the word are the family material's: a building's
//           kind.y and its material | fraction << 8. A type's cluster vertices come first, then its far body's.
//   far     a type's far body: a record a vertex (the step it collapses at | the far vertex it joins << 16), its
//           triangles (three far vertices and a word the material reads: a building's kind, a prop's UV), and its
//           steps (CONTINUUM_STEP_WORDS each, js/continuum-core.js), then its optical moments (CONTINUUM_OPTICS_WORDS a
//           far vertex and one more for the whole body: js/continuum-bake.js continuumFarOptics), which the morph carries
//           down the chain with the points.
//   streams optional, each a run of words a vertex in the vertices' own order, so a stream is read by the same
//           index as the vertex: skin (two words: four joints, four weights), UV (u | v << 16, unorm), rider source
//           (the posed vertex it rides), wind (the family's sway word) and surface (raw | scorch << 8, unorm over
//           CONTINUUM_SURFACE_RANGE: how much a face is raw stone or timber, where a cut opened it, and how burnt).
//           A type without a stream the atlas carries reads zeros.
//
// THE RECORD. CONTINUUM_RECORD_WORDS words an instance, written on the CPU when an instance is placed, struck or
// moved, or by a family's own compute pass (a pose pass that stands its records each frame):
//   position (3 f32), scale (f32), turn (a unit quaternion, 4 f32: yaw, pitch and roll in one), packed (type | kind
//   << 16 | flags), pose (where its pose data begins in the scene's pose buffer, in vec4f), seed (u32, which thins
//   its splat and splits its samples), reach (f32: how far past its type's sphere its points may lie), and four spare
//   words its family's fetch and material read as they will: identity, phase, motion, furl.
import { CONTINUUM_STEP_WORDS, CONTINUUM_HOPS, CONTINUUM_OPTICS_WORDS, CONTINUUM_SPLAT_AREA, CONTINUUM_TRIANGLE_BUDGET } from './continuum-core.js';

// ------------------------------------------------------------------------------------------------ the atlas
export const CONTINUUM_ATLAS_MAGIC = 0x4d54_4e43;
export const CONTINUUM_ATLAS_VERSION = 3;
export const CONTINUUM_HEADER_WORDS = 32;
export const CONTINUUM_HEADER = Object.freeze({
  magic: 0, version: 1, typeCount: 2, typesAt: 3, clustersAt: 4, clusterCount: 5, verticesAt: 6, vertexCount: 7, indicesAt: 8, indexCount: 9,
  chainsAt: 10, words: 11, hops: 12, chunkTriangles: 13, clusterTriangles: 14, streams: 15, skin: 16, uv: 17, rider: 18, wind: 19, surface: 20,
  cones: 21,
});
export const CONTINUUM_TYPE_WORDS = 32;
export const CONTINUUM_TYPE = Object.freeze({
  low: 0, span: 3, sphere: 4, clusterFirst: 8, clusterCount: 9, chainVertices: 10, stepCount: 11, chainVertexCount: 12, records: 13,
  triangles: 14, steps: 15, farFirst: 16, splatRx: 17, splatRy: 18, splatCentre: 19, splatArea: 22, flags: 23, material: 24,
});
// The family material's block: the last words of a type's record.
export const CONTINUUM_MATERIAL_WORDS = CONTINUUM_TYPE_WORDS - CONTINUUM_TYPE.material;
// A type's flags. SLIGHT: a slight thing (a fence, a grave, a sign) that never stands as a target in its own right.
// PIECES: a body of pieces (a struck building's), drawn as clusters alone: it has no far body and no splat.
export const CONTINUUM_TYPE_SLIGHT = 1;
export const CONTINUUM_TYPE_PIECES = 2;
// The count of a type's leading clusters that are its detail layer (relief thinner than a ball, rule 3.6: a ship's
// lines and her anchor's iron), in its flags from this bit up. Each is a root of error 0, so it is drawn with the
// clusters; its coarse cut (the shadow map's, and what is seen under water) takes it too, whole or not.
export const CONTINUUM_TYPE_DETAIL_SHIFT = 8;
export const CONTINUUM_CLUSTER_WORDS = 16;
export const CONTINUUM_VERTEX_WORDS = 4;
export const CONTINUUM_TRIANGLE_WORDS = 4;
// A far-body vertex that never collapses holds this step in its record.
export const CONTINUUM_NEVER = 65535;
// The far body is drawn in pieces of this many triangles; clusters of at most CONTINUUM_SMALL_CLUSTER triangles are
// drawn from a list of their own, so a cut of many small parts does not pay for full-size draws.
export const CONTINUUM_CHUNK_TRIANGLES = 32;
export const CONTINUUM_CLUSTER_TRIANGLES = 128;
export const CONTINUUM_SMALL_CLUSTER = 32;
// The side streams, in the order they follow the far bodies, and the bit each sets in the header's mask.
export const CONTINUUM_STREAMS = Object.freeze([
  Object.freeze({ name: 'skin', bit: 1, words: 2 }), Object.freeze({ name: 'uv', bit: 2, words: 1 }), Object.freeze({ name: 'rider', bit: 4, words: 1 }),
  Object.freeze({ name: 'wind', bit: 8, words: 1 }), Object.freeze({ name: 'surface', bit: 16, words: 1 }),
]);
// A surface word's raw and scorch, each a byte over this many units of damage: the land's shading reads a face's damage
// on this scale (js/wgsl/terrain.js landSurface, its normal's length less one).
export const CONTINUUM_SURFACE_RANGE = 1.5;
export const CONTINUUM_BODY_MAGIC = 0x5944_4243;
export const CONTINUUM_BODY_HEAD = 16;

// ------------------------------------------------------------------------------------------------ the record
export const CONTINUUM_RECORD_WORDS = 16;
export const CONTINUUM_RECORD = Object.freeze({ position: 0, scale: 3, turn: 4, packed: 8, pose: 9, seed: 10, reach: 11, identity: 12, phase: 13, motion: 14, furl: 15 });
// How an instance's points are posed (js/wgsl/continuum-kinds.js has each kind's contract).
export const CONTINUUM_KIND = Object.freeze({ RIGID: 0, SHARDED: 1, SKINNED: 2, RIDER: 3, WIND: 4, DRAPED: 5, HEIGHTFIELD: 6 });
export const CONTINUUM_KIND_SHIFT = 16;
// The flags, above the type and the kind in the packed word:
//   GONE       not drawn at all: a building standing as pieces drawn elsewhere, a prop sunk, a slot unused.
//   STRUCK     shot has struck it, until it is stood again: cut at the core's CONTINUUM_IMPORTANT share of the error.
//   BROKEN     in pieces, each riding its shard's flight (kind SHARDED): drawn as clusters alone, cut finer.
//   EXACT      drawn at its finest cut, clusters alone, whatever the scene's error.
//   SEA        afloat: culled by the frustum alone, with no bending by the earth's curve.
//   IMPORTANT  what the player looks at, speaks to or fires upon: cut at CONTINUUM_IMPORTANT of the error.
//   SHATTERED  broken up by the family's own fracture: drawn as clusters alone, cut finer.
//   DAMAGED    holed, flooding or wounded: drawn as clusters alone (no simplified surface spans its parts), cut finer.
//   STRETCHED  stretched along its type's axes before it is turned: its pose data begins with one vec4f (x, y, z,
//              and the shear of y along z), and its kind's own data follows.
//   GROUNDED   (1 << 29) stands on the land: raised at its anchor by how far the land draws its ground above the
//              true ground there, in the view and its shadow by the view's cut, under water by the captures'. Never
//              set for what stands on water, a quay or a bridge. It is the drawn ground's own (js/continuum-ground.js
//              CONTINUUM_GROUNDED), kept out of this file so that the bake, which never reads it, keeps its version.
export const CONTINUUM_GONE = 1 << 20;
export const CONTINUUM_STRUCK = 1 << 21;
export const CONTINUUM_BROKEN = 1 << 22;
export const CONTINUUM_EXACT = 1 << 23;
export const CONTINUUM_SEA = 1 << 24;
export const CONTINUUM_IMPORTANT_FLAG = 1 << 25;
export const CONTINUUM_SHATTERED = 1 << 26;
export const CONTINUUM_DAMAGED = 1 << 27;
export const CONTINUUM_STRETCHED = 1 << 28;

// The lists an instance can be entered in, each with its own indirect draw, the vertices of one entry, and the
// triangles one full entry submits. The view's lists come first; the shadow map's (and an under-water capture's) are
// the rest. An entry is (instance, item | what << 28): a cluster, a far-body chunk, or a splat.
export const CONTINUUM_LISTS = Object.freeze(['clusters', 'small clusters', 'far body', 'splat', 'shadow far body', 'shadow clusters']);
export const CONTINUUM_VIEW_LISTS = 4;
export const CONTINUUM_ENTRY_TRIANGLES = Object.freeze([CONTINUUM_CLUSTER_TRIANGLES, CONTINUUM_SMALL_CLUSTER, CONTINUUM_CHUNK_TRIANGLES, 1, CONTINUUM_CHUNK_TRIANGLES, CONTINUUM_CLUSTER_TRIANGLES]);
export const CONTINUUM_CLUSTER_ENTRY = 1, CONTINUUM_FAR_ENTRY = 2, CONTINUUM_SPLAT_ENTRY = 3;

const continuumUnit16 = (v) => Math.max(0, Math.min(65535, Math.round(v * 65535)));
const continuumBits = new Float32Array(1), continuumBitsWord = new Uint32Array(continuumBits.buffer);
// A float's bits, for a word of a record or a material block.
export function continuumFloatWord(value) { continuumBits[0] = value; return continuumBitsWord[0]; }
// Octahedral normal, so two 16-bit values hold a whole direction.
export function continuumOctahedral([x, y, z]) {
  const length = Math.abs(x) + Math.abs(y) + Math.abs(z) || 1;
  let u = x / length, v = y / length;
  if (z / length < 0) { const a = u; u = (1 - Math.abs(v)) * (a >= 0 ? 1 : -1); v = (1 - Math.abs(a)) * (v >= 0 ? 1 : -1); }
  return [u * 0.5 + 0.5, v * 0.5 + 0.5];
}
export function continuumOctahedralNormal([u, v]) {
  const fx = u * 2 - 1, fy = v * 2 - 1, n = [fx, fy, 1 - Math.abs(fx) - Math.abs(fy)], t = Math.max(-n[2], 0);
  n[0] += n[0] >= 0 ? -t : t; n[1] += n[1] >= 0 ? -t : t;
  const l = Math.hypot(...n) || 1;
  return n.map((x) => x / l);
}
// One vertex as four words, quantized over its type's `low` and `span`; `high` and `word` its material's.
export function packContinuumVertex({ position, normal, high = 0, word = 0 }, { low, span }) {
  const p = position.map((v, a) => continuumUnit16((v - low[a]) / span)), n = continuumOctahedral(normal);
  if (!(high >= 0 && high <= 65535)) throw Error(`A continuum vertex's high half-word is out of range: ${high}`);
  return [(p[0] | (p[1] << 16)) >>> 0, (p[2] | (high << 16)) >>> 0, (continuumUnit16(n[0]) | (continuumUnit16(n[1]) << 16)) >>> 0, word >>> 0];
}
export function unpackContinuumVertex(words, at, { low, span }) {
  const w = (k) => words[at + k], q = [w(0) & 65535, w(0) >>> 16, w(1) & 65535];
  return {
    position: q.map((v, a) => low[a] + (v / 65535) * span),
    normal: continuumOctahedralNormal([(w(2) & 65535) / 65535, (w(2) >>> 16) / 65535]),
    high: w(1) >>> 16, word: w(3),
  };
}
// A UV pair in one word, two 16-bit fractions.
export function packContinuumUV([u, v]) {
  if (!(u >= 0 && u <= 1 && v >= 0 && v <= 1)) throw Error(`A continuum UV lies outside its image: ${u}, ${v}`);
  return (continuumUnit16(u) | (continuumUnit16(v) << 16)) >>> 0;
}
export const unpackContinuumUV = (word) => [(word & 65535) / 65535, (word >>> 16) / 65535];
// A surface word: how raw a face is and how scorched, each over CONTINUUM_SURFACE_RANGE.
export function packContinuumSurface(raw, scorch = 0) {
  const byte = (v) => Math.max(0, Math.min(255, Math.round((v / CONTINUUM_SURFACE_RANGE) * 255)));
  return (byte(raw) | (byte(scorch) << 8)) >>> 0;
}
export function packContinuumCluster({ lod, parentLod, cull, error, parentError, first, triangles, level, part }) {
  const words = new ArrayBuffer(CONTINUUM_CLUSTER_WORDS * 4), f = new Float32Array(words), u = new Uint32Array(words);
  if (!(triangles > 0 && triangles <= CONTINUUM_CLUSTER_TRIANGLES)) throw Error(`A continuum cluster holds ${triangles} triangles`);
  if (!(part >= 0 && part <= 65535)) throw Error(`A continuum cluster's part is out of range: ${part}`);
  f.set(lod, 0); f.set(parentLod, 4); f.set(cull, 8);
  f[12] = error; f[13] = Math.min(parentError, 1e30);
  u[14] = first;
  u[15] = (triangles | (Math.min(level, 255) << 8) | ((part & 65535) << 16)) >>> 0;
  return u;
}

// ------------------------------------------------------------------------------------------------ a body
// One baked body (js/continuum-bake.js bakeContinuumBody) as the words it adds to an atlas: a head, its type record,
// its clusters, its vertices (clusters' then far body's), its indices, its far body and its side streams; every place
// in them counted from the body's own start, so that an atlas is assembled from bodies baked anywhere by moving them.
// `packing` is its family's: `triangles` its source triangle count, `flags` its type's, `material` its block (up to
// CONTINUUM_MATERIAL_WORDS words), `vertex(v)` a welded vertex's { high, word }, `farWord(t)` a far triangle's word,
// `streams` a stream's words for a welded vertex (`{ uv: (v) => [word] }`), `farStreams` the same for far vertex i
// (`{ rider: (i) => [word] }` for a far body posed by what its vertices ride; a skinned body's far points wear the
// skin of the source nearest them; a far vertex without reads zeros), each packed only where some vertex's words are
// not all zero, and `splatArea` the outline's area (an ellipse's if not given). `frame` ({ low, span }): the
// quantization, for a family whose types must share one (a meadow's patches, which tile and drape alike at their
// seams); every point must lie within it.
export function packContinuumBody(packing, { welded, clusters, far }) {
  const { triangles = 0, flags = 0, material = [], vertex = () => ({}), farWord = () => 0, streams = {}, farStreams = {}, splat = far.splat, frame = null } = packing;
  if (material.length > CONTINUUM_MATERIAL_WORDS) throw Error(`A continuum material block holds ${material.length} words`);
  const low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity];
  for (const P of [welded.position, far.position]) for (let v = 0; v < P.length / 3; v++) for (let k = 0; k < 3; k++) { low[k] = Math.min(low[k], P[v * 3 + k]); high[k] = Math.max(high[k], P[v * 3 + k]); }
  if (frame && [0, 1, 2].some((k) => low[k] < frame.low[k] || high[k] > frame.low[k] + frame.span)) throw Error(`A continuum body reaches outside its frame: ${low.map((v) => v.toFixed(3))} to ${high.map((v) => v.toFixed(3))}`);
  const span = frame ? frame.span : Math.max(...high.map((v, k) => v - low[k]), 1e-6), quant = frame ? { low: [...frame.low], span } : { low, span };
  // Every point it can draw, grown by the far body's largest inflation, within one sphere.
  const centre = low.map((v, k) => (v + high[k]) / 2);
  let radius = 0;
  for (const P of [welded.position, far.position]) for (let v = 0; v < P.length / 3; v++) radius = Math.max(radius, Math.hypot(P[v * 3] - centre[0], P[v * 3 + 1] - centre[1], P[v * 3 + 2] - centre[2]));
  // And every sphere its clusters are cut by: the cut tries a prefix of them bounded by this one (continuumPrefix,
  // js/wgsl/continuum-cut.js), and would miss a cluster whose group's sphere pokes out of it.
  for (const r of clusters.records) for (const s of [r.lod, r.parentLod, r.cull]) radius = Math.max(radius, Math.hypot(s[0] - centre[0], s[1] - centre[1], s[2] - centre[2]) + s[3]);
  radius += far.stats.inflateMax + 0.01;
  const ownVertices = clusters.order.length, V = far.position.length / 3, T = far.index.length / 3, S = far.chain.steps.length, vertices = ownVertices + V;
  if (V > 65535) throw Error(`A far body of ${V} vertices: its collapse records hold 16-bit targets`);
  // Which streams it carries: those with a word that is not zero.
  const farCarries = (name) => farStreams[name] && Array.from({ length: V }, (_, i) => i).some((i) => farStreams[name](i).some((w) => w !== 0));
  const carried = CONTINUUM_STREAMS.filter(({ name }) => (streams[name] && clusters.order.some((v) => streams[name](v).some((w) => w !== 0))) || farCarries(name));
  const streamWords = carried.reduce((n, { words }) => n + words * vertices, 0);
  const optics = far.optics ?? null;
  if (V && optics?.length !== (V + 1) * CONTINUUM_OPTICS_WORDS) throw Error(`A far body of ${V} vertices has ${optics?.length ?? 'no'} words of optical moments: bake them (js/continuum-bake.js continuumFarOptics)`);
  const chainWords = V + T * CONTINUUM_TRIANGLE_WORDS + far.steps.length + (V ? optics.length : 0);
  const typeAt = CONTINUUM_BODY_HEAD, clustersAt = typeAt + CONTINUUM_TYPE_WORDS, verticesAt = clustersAt + clusters.count * CONTINUUM_CLUSTER_WORDS;
  const indicesAt = verticesAt + vertices * CONTINUUM_VERTEX_WORDS, chainAt = indicesAt + clusters.indices.length, streamsAt = chainAt + chainWords;
  const words = new Uint32Array(streamsAt + streamWords), floats = new Float32Array(words.buffer);
  words.set([CONTINUUM_BODY_MAGIC, CONTINUUM_ATLAS_VERSION, clusters.count, vertices, clusters.indices.length, chainWords, triangles, carried.reduce((m, s) => m | s.bit, 0), ownVertices, streamWords], 0);
  clusters.records.forEach((record, k) => words.set(packContinuumCluster(record), clustersAt + k * CONTINUUM_CLUSTER_WORDS));
  clusters.order.forEach((v, i) => words.set(packContinuumVertex({ position: welded.position.subarray(v * 3, v * 3 + 3), normal: welded.normal.subarray(v * 3, v * 3 + 3), ...vertex(v) }, quant), verticesAt + i * CONTINUUM_VERTEX_WORDS));
  for (let i = 0; i < V; i++) words.set(packContinuumVertex({ position: far.position.subarray(i * 3, i * 3 + 3), normal: far.normal.subarray(i * 3, i * 3 + 3) }, quant), verticesAt + (ownVertices + i) * CONTINUUM_VERTEX_WORDS);
  words.set(clusters.indices, indicesAt);
  // The far body: each vertex's collapse (the step it goes at, and where), triangles in order of death with their
  // words, and steps.
  const trianglesAt = V, stepsAt = trianglesAt + T * CONTINUUM_TRIANGLE_WORDS;
  for (let i = 0; i < V; i++) words[chainAt + i] = ((far.chain.dieStep[i] < 0 ? CONTINUUM_NEVER : far.chain.dieStep[i]) | ((far.chain.target[i] < 0 ? i : far.chain.target[i]) << 16)) >>> 0;
  far.order.forEach((t, k) => {
    for (let c = 0; c < 3; c++) words[chainAt + trianglesAt + k * CONTINUUM_TRIANGLE_WORDS + c] = far.index[t * 3 + c];
    words[chainAt + trianglesAt + k * CONTINUUM_TRIANGLE_WORDS + 3] = farWord(t) >>> 0;
  });
  words.set(far.steps, chainAt + stepsAt);
  if (V) words.set(optics, chainAt + stepsAt + far.steps.length);
  let streamAt = streamsAt;
  for (const { name, words: n } of carried) {
    if (streams[name]) clusters.order.forEach((v, i) => words.set(streams[name](v), streamAt + i * n));
    if (farStreams[name]) for (let i = 0; i < V; i++) words.set(farStreams[name](i), streamAt + (ownVertices + i) * n);
    streamAt += n * vertices;
  }
  // The type's record, its places counted from the body's own clusters, vertices and far body.
  const F = CONTINUUM_TYPE, rx = splat.rx, ry = splat.ry, area = splat.area ?? Math.PI * rx * ry;
  floats.set([...quant.low, span], typeAt + F.low);
  floats.set([...centre, radius], typeAt + F.sphere);
  words.set([0, clusters.count, ownVertices, S, V, 0, trianglesAt, stepsAt, far.farFirst], typeAt + F.clusterFirst);
  // The splat's triangle circumscribes its outline's ellipse (corners (0, 2) and (±√3, -1) of its radii, an area of
  // 3√3 rx ry); this shrinks it to the outline's own area.
  floats.set([rx, ry, ...splat.centre, rx > 0 && ry > 0 ? Math.sqrt(area / (3 * Math.sqrt(3) * rx * ry)) : CONTINUUM_SPLAT_AREA], typeAt + F.splatRx);
  words[typeAt + F.flags] = flags >>> 0;
  words.set(Uint32Array.from(material, (w) => w >>> 0), typeAt + F.material);
  return { words, low: quant.low, span, centre, radius };
}
// A body of pieces (js/building-fracture.js): a struck building's, each piece a part. It is drawn as clusters alone,
// every cluster riding its piece's flight, so it carries no far body, no chain and no splat.
export function continuumPiecesFar() {
  return {
    position: new Float32Array(0), normal: new Float32Array(0), index: new Uint32Array(0), order: [],
    chain: { steps: [], dieStep: new Int32Array(0), target: new Int32Array(0) }, steps: new Uint32Array(0), optics: new Uint32Array(0), stats: { inflateMax: 0 },
    farFirst: 0, splat: { rx: 0, ry: 0, centre: [0, 0, 0] },
  };
}
export function packContinuumPieces(packing, { welded, clusters }) {
  return packContinuumBody({ ...packing, flags: (packing.flags ?? 0) | CONTINUUM_TYPE_PIECES, splat: undefined }, { welded, clusters, far: continuumPiecesFar() });
}
// A body of pieces' finest level, made in the page the moment the pieces are cut: each piece's triangles in clusters
// of at most CONTINUUM_CLUSTER_TRIANGLES, ordered along the piece's longest side, every one a root of error 0. The
// worker's bake of its coarser levels replaces it when it lands.
export function continuumFinestClusters(welded) {
  const { position: P, index, part } = welded, T = index.length / 3, byPart = new Map();
  for (let t = 0; t < T; t++) {
    const p = part[index[t * 3]];
    if (!byPart.has(p)) byPart.set(p, []);
    byPart.get(p).push(t);
  }
  const records = [], order = [], indices = [], local = new Int32Array(welded.count).fill(-1);
  const centroid = (t, k) => (P[index[t * 3] * 3 + k] + P[index[t * 3 + 1] * 3 + k] + P[index[t * 3 + 2] * 3 + k]) / 3;
  for (const [p, list] of [...byPart].sort((a, b) => a[0] - b[0])) {
    const lo = [Infinity, Infinity, Infinity], hi = [-Infinity, -Infinity, -Infinity];
    for (const t of list) for (let k = 0; k < 3; k++) { const c = centroid(t, k); lo[k] = Math.min(lo[k], c); hi[k] = Math.max(hi[k], c); }
    const axis = [0, 1, 2].reduce((best, k) => (hi[k] - lo[k] > hi[best] - lo[best] ? k : best), 0);
    list.sort((a, b) => centroid(a, axis) - centroid(b, axis));
    for (let first = 0; first < list.length; first += CONTINUUM_CLUSTER_TRIANGLES) {
      const chunk = list.slice(first, first + CONTINUUM_CLUSTER_TRIANGLES), low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity];
      const at = indices.length;
      for (const t of chunk) for (let c = 0; c < 3; c++) {
        const v = index[t * 3 + c];
        for (let k = 0; k < 3; k++) { low[k] = Math.min(low[k], P[v * 3 + k]); high[k] = Math.max(high[k], P[v * 3 + k]); }
        if (local[v] < 0) { local[v] = order.length; order.push(v); }
        indices.push(local[v]);
      }
      const centre = low.map((v, k) => (v + high[k]) / 2);
      let radius = 0;
      for (let i = at; i < indices.length; i++) { const v = order[indices[i]]; radius = Math.max(radius, Math.hypot(P[v * 3] - centre[0], P[v * 3 + 1] - centre[1], P[v * 3 + 2] - centre[2])); }
      const sphere = [...centre, radius + 1e-3];
      records.push({ lod: sphere, parentLod: sphere, cull: sphere, error: 0, parentError: Infinity, first: at, triangles: chunk.length, level: 0, part: p });
    }
  }
  return { records, order, indices, count: records.length, levels: 1, roots: records.length, finestTriangles: T, rootError: 0 };
}
// The parts of a packed body, checked.
export function continuumBodyParts(words) {
  if (words[0] !== CONTINUUM_BODY_MAGIC || words[1] !== CONTINUUM_ATLAS_VERSION) throw Error('A continuum body of another format');
  const [clusters, vertices, indices, chain, sourceTriangles, streams, ownVertices, streamWords] = words.subarray(2, 10), typeAt = CONTINUUM_BODY_HEAD, clustersAt = typeAt + CONTINUUM_TYPE_WORDS;
  const verticesAt = clustersAt + clusters * CONTINUUM_CLUSTER_WORDS, indicesAt = verticesAt + vertices * CONTINUUM_VERTEX_WORDS, chainAt = indicesAt + indices, streamsAt = chainAt + chain;
  if (streamsAt + streamWords !== words.length) throw Error('A continuum body does not add up');
  return { clusters, vertices, indices, chain, sourceTriangles, streams, ownVertices, typeAt, clustersAt, verticesAt, indicesAt, chainAt, streamsAt };
}
// An atlas of packed bodies, type i being bodies[i]: header, type records, every body's clusters, vertices and
// indices, every far body, then each stream any body carries; each body's places moved to where it now lies.
export function assembleContinuumAtlas(bodies) {
  const parts = bodies.map(continuumBodyParts), sum = (key) => parts.reduce((n, p) => n + p[key], 0), H = CONTINUUM_HEADER, F = CONTINUUM_TYPE;
  const typesAt = CONTINUUM_HEADER_WORDS, clustersAt = typesAt + bodies.length * CONTINUUM_TYPE_WORDS, totalClusters = sum('clusters');
  const verticesAt = clustersAt + totalClusters * CONTINUUM_CLUSTER_WORDS, totalVertices = sum('vertices'), indicesAt = verticesAt + totalVertices * CONTINUUM_VERTEX_WORDS;
  const totalIndices = sum('indices'), chainsAt = indicesAt + totalIndices, streamsAt = chainsAt + sum('chain');
  const mask = parts.reduce((m, p) => m | p.streams, 0), carried = CONTINUUM_STREAMS.filter((s) => mask & s.bit);
  const words = streamsAt + carried.reduce((n, s) => n + s.words * totalVertices, 0);
  const atlas = new Uint32Array(words);
  atlas.set([CONTINUUM_ATLAS_MAGIC, CONTINUUM_ATLAS_VERSION, bodies.length, typesAt, clustersAt, totalClusters, verticesAt, totalVertices, indicesAt, totalIndices, chainsAt, words, CONTINUUM_HOPS, CONTINUUM_CHUNK_TRIANGLES, CONTINUUM_CLUSTER_TRIANGLES, mask], 0);
  const streamAt = {};
  let at = streamsAt;
  for (const s of carried) { streamAt[s.name] = at; atlas[H[s.name]] = at; at += s.words * totalVertices; }
  let clusterAt = 0, vertexAt = 0, indexAt = 0, chainAt = chainsAt;
  bodies.forEach((body, id) => {
    const p = parts[id], typeAt = typesAt + id * CONTINUUM_TYPE_WORDS;
    atlas.set(body.subarray(p.typeAt, p.typeAt + CONTINUUM_TYPE_WORDS), typeAt);
    atlas[typeAt + F.clusterFirst] = clusterAt;
    atlas[typeAt + F.chainVertices] += vertexAt;
    atlas[typeAt + F.records] += chainAt;
    for (const field of [F.triangles, F.steps]) atlas[typeAt + field] += chainAt;
    const clusterWords = clustersAt + clusterAt * CONTINUUM_CLUSTER_WORDS;
    atlas.set(body.subarray(p.clustersAt, p.verticesAt), clusterWords);
    for (let k = 0; k < p.clusters; k++) atlas[clusterWords + k * CONTINUUM_CLUSTER_WORDS + 14] += indexAt;
    atlas.set(body.subarray(p.verticesAt, p.indicesAt), verticesAt + vertexAt * CONTINUUM_VERTEX_WORDS);
    for (let i = 0; i < p.indices; i++) atlas[indicesAt + indexAt + i] = body[p.indicesAt + i] + vertexAt;
    atlas.set(body.subarray(p.chainAt, p.streamsAt), chainAt);
    let from = p.streamsAt;
    for (const s of CONTINUUM_STREAMS) {
      if (!(p.streams & s.bit)) continue;
      atlas.set(body.subarray(from, from + s.words * p.vertices), streamAt[s.name] + vertexAt * s.words);
      from += s.words * p.vertices;
    }
    clusterAt += p.clusters; vertexAt += p.vertices; indexAt += p.indices; chainAt += p.chain;
  });
  if (chainAt !== streamsAt || at !== words) throw Error('The continuum atlas layout does not add up');
  return atlas;
}
// What a bake read of a body, byte for byte: its drawn triangles and their parts. A manifest keeps each type's digest
// of these, so a builder changed since the bake is caught.
export function continuumSourceBytes(type) {
  const vertices = new Uint8Array(type.vertices.buffer, type.vertices.byteOffset, type.vertices.byteLength);
  const parts = new Uint8Array(type.parts.buffer, type.parts.byteOffset, type.parts.byteLength), out = new Uint8Array(vertices.length + parts.length);
  out.set(vertices, 0); out.set(parts, vertices.length);
  return out;
}
// An atlas this cut can read, or an error: its magic, its version, and the hop limit and chunk size it was baked for.
export function checkContinuumAtlas(words, label = 'continuum') {
  const H = CONTINUUM_HEADER;
  if (words[H.magic] !== CONTINUUM_ATLAS_MAGIC) throw Error(`The ${label} atlas is not a continuum atlas`);
  if (words[H.version] !== CONTINUUM_ATLAS_VERSION) throw Error(`The ${label} atlas is of version ${words[H.version]}, not ${CONTINUUM_ATLAS_VERSION}: rebake it`);
  if (words[H.hops] !== CONTINUUM_HOPS || words[H.chunkTriangles] !== CONTINUUM_CHUNK_TRIANGLES || words[H.clusterTriangles] !== CONTINUUM_CLUSTER_TRIANGLES) throw Error(`The ${label} atlas was baked for another cut`);
  if (words[H.words] !== words.length) throw Error(`The ${label} atlas has the wrong size`);
  return words;
}
// A family's baked atlas, fetched, unpacked, checked against its manifest's receipt and checked as an atlas. `assets`
// names its 'manifest.json' and 'atlas.bin.gz'; `validate` checks its manifest. Resolves to { manifest, words }.
// Streams decompressed bytes directly into a single exact-sized Uint8Array so large atlases never double-buffer on CPU.
export async function loadContinuumAtlas({ assets, validate, label, fetchAsset = fetch, verifySha256 = false }) {
  const get = async (path) => {
    const response = await fetchAsset(path);
    if (!response.ok) throw Error(`The ${label} continuum is unavailable (${response.status}): ${path}`);
    return response;
  };
  // Fetch manifest and compressed atlas concurrently to save a full round-trip on every continuum family.
  const [manifestRes, atlasRes] = await Promise.all([get(assets['manifest.json']), get(assets['atlas.bin.gz'])]);
  const manifest = validate(await manifestRes.json());
  const expectedBytes = manifest.atlas.bytes;
  let bytes;
  const stream = atlasRes.body?.pipeThrough ? atlasRes.body.pipeThrough(new DecompressionStream('gzip')) : null;
  if (stream?.getReader) {
    bytes = new Uint8Array(expectedBytes);
    const reader = stream.getReader();
    let offset = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        if (offset + value.byteLength > expectedBytes) {
          await reader.cancel();
          throw Error(`The ${label} continuum atlas has the wrong size`);
        }
        bytes.set(value, offset);
        offset += value.byteLength;
      }
    } finally {
      reader.releaseLock();
    }
    if (offset !== expectedBytes) throw Error(`The ${label} continuum atlas has the wrong size`);
  } else {
    const bytesBuf = await new Response(atlasRes.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    bytes = new Uint8Array(bytesBuf);
    if (bytes.byteLength !== expectedBytes) throw Error(`The ${label} continuum atlas has the wrong size`);
  }
  const wantVerify = verifySha256 || (typeof location !== 'undefined' && new URLSearchParams(location.search).get('verifyAssets') === '1');
  if (wantVerify) {
    const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
    if (Array.from(digest, (v) => v.toString(16).padStart(2, '0')).join('') !== manifest.atlas.sha256) throw Error(`The ${label} continuum atlas failed verification`);
  }
  return { manifest, words: checkContinuumAtlas(new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4), label) };
}
// Compact CPU metadata prefix of an atlas (header + type table + cluster table, typically <2% of atlas size),
// sufficient for card-bake cluster cuts, type material reads, and GPU page counts after raw vertices are uploaded.
export function continuumAtlasMetaWords(words) {
  const cut = words[CONTINUUM_HEADER.verticesAt];
  if (!(cut > 0) || words.length <= cut) return words;
  return words.slice(0, cut);
}
// What each type of an atlas can enter in the lists at most: all its clusters, and its far body at the heaviest step
// it is drawn at, in chunks.
export function continuumAtlasTypes(words) {
  const H = CONTINUUM_HEADER, T = CONTINUUM_TYPE;
  return Array.from({ length: words[H.typeCount] }, (_, t) => {
    const at = words[H.typesAt] + t * CONTINUUM_TYPE_WORDS, pieces = (words[at + T.flags] & CONTINUUM_TYPE_PIECES) !== 0;
    const heaviest = pieces ? 0 : words[words[at + T.steps] + words[at + T.farFirst] * CONTINUUM_STEP_WORDS];
    return { clusters: words[at + T.clusterCount], farChunks: Math.ceil(heaviest / CONTINUUM_CHUNK_TRIANGLES) };
  });
}
// Total words an atlas occupies on the GPU once its per-cluster normal cone table is appended (1 u32/cluster when
// absent on disk), so continuumAtlasPages and uploadContinuumAtlas agree without changing on-disk packs.
export function continuumAtlasTotalWords(words) {
  const H = CONTINUUM_HEADER;
  return (words[H.words] || words.length) + (words[H.cones] ? 0 : words[H.clusterCount]);
}
// Builds one pack4x8snorm-compatible u32 normal cone [nx, ny, nz, sinHalfAngle] per cluster directly from the atlas's
// quantized vertices and triangle indices. Full-sphere clusters encode (0, 1, 0, 1.0) -> 0x7f007f00 to disable culling.
// Watertight DAG propagation ensures a flat child (sinHalf < 0.45) never relaxes parentPx more than its parent relaxes ownPx.
export function buildContinuumClusterCones(words) {
  const H = CONTINUUM_HEADER, T = CONTINUUM_TYPE;
  const clusterCount = words[H.clusterCount];
  const cones = new Uint32Array(clusterCount);
  if (!clusterCount) return cones;
  const clustersAt = words[H.clustersAt], verticesAt = words[H.verticesAt], indicesAt = words[H.indicesAt];
  const typesAt = words[H.typesAt], typeCount = words[H.typeCount];
  const f32 = new Float32Array(words.buffer, words.byteOffset, words.length);
  const tnx = new Float32Array(CONTINUUM_CLUSTER_TRIANGLES);
  const tny = new Float32Array(CONTINUUM_CLUSTER_TRIANGLES);
  const tnz = new Float32Array(CONTINUUM_CLUSTER_TRIANGLES);
  const axArr = new Float32Array(clusterCount);
  const ayArr = new Float32Array(clusterCount);
  const azArr = new Float32Array(clusterCount);
  const shArr = new Float32Array(clusterCount);
  for (let c = 0; c < clusterCount; c++) {
    const cb = clustersAt + c * CONTINUUM_CLUSTER_WORDS;
    const first = indicesAt + words[cb + 14];
    const tris = words[cb + 15] & 255;
    let sx = 0, sy = 0, sz = 0, valid = 0;
    for (let t = 0; t < tris; t++) {
      const i0 = first + t * 3;
      const v0 = verticesAt + words[i0] * CONTINUUM_VERTEX_WORDS;
      const v1 = verticesAt + words[i0 + 1] * CONTINUUM_VERTEX_WORDS;
      const v2 = verticesAt + words[i0 + 2] * CONTINUUM_VERTEX_WORDS;
      const w0 = words[v0], x0 = w0 & 65535, y0 = w0 >>> 16, z0 = words[v0 + 1] & 65535;
      const w1 = words[v1], x1 = w1 & 65535, y1 = w1 >>> 16, z1 = words[v1 + 1] & 65535;
      const w2 = words[v2], x2 = w2 & 65535, y2 = w2 >>> 16, z2 = words[v2 + 1] & 65535;
      const e1x = x1 - x0, e1y = y1 - y0, e1z = z1 - z0;
      const e2x = x2 - x0, e2y = y2 - y0, e2z = z2 - z0;
      const cx = e1y * e2z - e1z * e2y;
      const cy = e1z * e2x - e1x * e2z;
      const cz = e1x * e2y - e1y * e2x;
      const len = Math.sqrt(cx * cx + cy * cy + cz * cz);
      if (len > 1e-6) {
        sx += cx; sy += cy; sz += cz;
        const inv = 1 / len;
        tnx[valid] = cx * inv; tny[valid] = cy * inv; tnz[valid] = cz * inv;
        valid++;
      }
    }
    const sumLen = Math.sqrt(sx * sx + sy * sy + sz * sz);
    if (valid === 0 || sumLen < 1e-6) {
      axArr[c] = 0; ayArr[c] = 1; azArr[c] = 0; shArr[c] = 1.0;
    } else {
      const invSum = 1 / sumLen;
      const ax = sx * invSum, ay = sy * invSum, az = sz * invSum;
      let minDot = 1.0;
      for (let m = 0; m < valid; m++) {
        const d = tnx[m] * ax + tny[m] * ay + tnz[m] * az;
        if (d < minDot) minDot = d;
      }
      axArr[c] = ax; ayArr[c] = ay; azArr[c] = az;
      shArr[c] = minDot <= 0 ? 1.0 : Math.min(1.0, Math.sqrt(Math.max(0, 1 - minDot * minDot)));
    }
  }
  // Keep DAG cuts watertight for perspective weighting: clusters are stored coarsest parent first, so propagating
  // parent sinHalf downward within the flat band (< 0.45) guarantees child.pPx >= parent.oPx with zero holes while
  // preserving backface culling (sinHalf <= 0.45 < 0.96).
  for (let ty = 0; ty < typeCount; ty++) {
    const tb = typesAt + ty * CONTINUUM_TYPE_WORDS;
    const first = words[tb + T.clusterFirst], cnt = words[tb + T.clusterCount];
    let anyFlat = false;
    for (let i = 0; i < cnt; i++) { if (shArr[first + i] < 0.45) { anyFlat = true; break; } }
    if (!anyFlat) continue;
    const byLod = new Map();
    for (let i = 0; i < cnt; i++) {
      const c = first + i, cb = clustersAt + c * CONTINUUM_CLUSTER_WORDS;
      const key = `${words[cb]},${words[cb + 1]},${words[cb + 2]},${words[cb + 3]},${words[cb + 12]}`;
      const prev = byLod.get(key);
      if (prev === undefined || shArr[c] > prev) byLod.set(key, shArr[c]);
    }
    for (let i = 0; i < cnt; i++) {
      const c = first + i, cb = clustersAt + c * CONTINUUM_CLUSTER_WORDS;
      if (shArr[c] >= 0.45 || f32[cb + 13] > 1e20) continue;
      const pkey = `${words[cb + 4]},${words[cb + 5]},${words[cb + 6]},${words[cb + 7]},${words[cb + 13]}`;
      const psh = byLod.get(pkey);
      if (psh !== undefined && psh > shArr[c]) {
        shArr[c] = Math.min(psh, 0.45);
        const ownKey = `${words[cb]},${words[cb + 1]},${words[cb + 2]},${words[cb + 3]},${words[cb + 12]}`;
        if (shArr[c] > (byLod.get(ownKey) ?? 0)) byLod.set(ownKey, shArr[c]);
      }
    }
  }
  for (let c = 0; c < clusterCount; c++) {
    const sh = shArr[c];
    if (sh >= 0.99) { cones[c] = 0x7f007f00; continue; }
    const bx = Math.max(-127, Math.min(127, Math.round(axArr[c] * 127))) & 0xff;
    const by = Math.max(-127, Math.min(127, Math.round(ayArr[c] * 127))) & 0xff;
    const bz = Math.max(-127, Math.min(127, Math.round(azArr[c] * 127))) & 0xff;
    const bw = Math.min(127, Math.ceil(sh * 127)) & 0xff;
    cones[c] = (bx | (by << 8) | (bz << 16) | (bw << 24)) >>> 0;
  }
  return cones;
}
// How full an entry of a list is taken to be at least, on the mean, when its lists are sized: a cut of real bodies
// fills its clusters and chunks far better than this, so a scene within the budget never fills a list.
export const CONTINUUM_ENTRY_FILL = 0.25;
// The one room scheme every scene's lists are sized by, so that every family draws from one budget: each list holds
// what its instances could enter at once (every cluster of each one's type, its far body at its heaviest step, one
// splat), but never more than the whole scene's budget could need of it: CONTINUUM_TRIANGLE_BUDGET over the triangles
// an entry submits at CONTINUUM_ENTRY_FILL. Within the budget nothing is refused; past it the cut yields each instance
// to a coarser cut that fits, the census counts what was asked, and the budget's governor coarsens the one scalar
// (js/wgsl/continuum-cut.js). `types` as continuumAtlasTypes gives them, `counts` how many instances of each type a
// scene may hold. Returns the scene's capacity and each list's room.
export function continuumRoom(types, counts) {
  let clusters = 0, far = 0, capacity = 0;
  counts.forEach((n, t) => { if (!n) return; capacity += n; clusters += n * types[t].clusters; far += n * types[t].farChunks; });
  const room = [clusters, clusters, far, capacity, far, clusters].map((n, list) => Math.max(1, Math.min(n, Math.ceil(CONTINUUM_TRIANGLE_BUDGET / (CONTINUUM_ENTRY_TRIANGLES[list] * CONTINUUM_ENTRY_FILL)))));
  return { capacity, room };
}

// ------------------------------------------------------------------------------------------------ writing a record
const continuumQuatMultiply = (a, b) => [
  a[3] * b[0] + a[0] * b[3] + a[1] * b[2] - a[2] * b[1],
  a[3] * b[1] - a[0] * b[2] + a[1] * b[3] + a[2] * b[0],
  a[3] * b[2] + a[0] * b[1] - a[1] * b[0] + a[2] * b[3],
  a[3] * b[3] - a[0] * b[0] - a[1] * b[1] - a[2] * b[2],
];
// The record of instance `index` into `words` (and `floats`, the same memory): stood at `position`, its type grown by
// `scale`, turned by the unit quaternion `turn` and then by `yaw` about the vertical (folded into its turn), of `kind`
// with `flags`, its pose data at `pose` (vec4f), seeded by `seed`, its points within `reach` of its type's sphere, and
// its family's spare words (f32 unless `spareWords` gives them as bits).
export function writeContinuumRecord(words, floats, index, { position, scale = 1, turn = [0, 0, 0, 1], yaw = 0, type, kind = CONTINUUM_KIND.RIGID, flags = 0, pose = 0, seed = index, reach = 0, identity = 0, phase = 0, motion = 0, furl = 0, spareWords = null }) {
  const at = index * CONTINUUM_RECORD_WORDS, R = CONTINUUM_RECORD;
  if (!(type >= 0 && type <= 65535)) throw Error(`A continuum record's type is out of range: ${type}`);
  floats.set(position, at + R.position);
  floats[at + R.scale] = scale;
  floats.set(yaw ? continuumQuatMultiply([0, Math.sin(yaw / 2), 0, Math.cos(yaw / 2)], turn) : turn, at + R.turn);
  words[at + R.packed] = ((type & 0xffff) | ((kind & 15) << CONTINUUM_KIND_SHIFT) | flags) >>> 0;
  words[at + R.pose] = pose >>> 0;
  words[at + R.seed] = seed >>> 0;
  floats[at + R.reach] = reach;
  if (spareWords) words.set(spareWords, at + R.identity);
  else floats.set([identity, phase, motion, furl], at + R.identity);
}

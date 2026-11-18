// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// A city's buildings in the one continuum (AGENTS.md rule 3). Each Cairn type (js/old-world-buildings.js), houses,
// churches, towers, walls, gates, works and bridges, is baked by scripts/prepare-city-continuum.mjs from the mesh its
// builder makes, part by part, into a cluster hierarchy the GPU cuts by projected error, a closed far body wrapped
// round it that collapses one half-edge at a time to a few triangles, and a single splat. The bake is offline and per
// type: the types are a fixed catalogue, every building of every plan is one of them placed, stretched and tinted, and
// the browser then holds no simplifier. All of it is one atlas, so a city is cut by one dispatch and drawn by one list
// a pass. The GPU side is js/wgsl/city-continuum.js; js/city-continuum-draw.js keeps a city's lists and draws.

export const CITY_CONTINUUM_FORMAT = 'waterworld.city-continuum';
export const CITY_CONTINUUM_VERSION = 1;
export const CITY_CONTINUUM_MAGIC = 0x4354_4e43;
// The atlas: a header, one record a type, the clusters of every type, their vertices and indices, then each type's
// far body (vertices, collapse records, triangles in order of death, steps). Every number a 32-bit word.
export const CITY_CONTINUUM_HEADER_WORDS = 16;
export const CITY_CONTINUUM_HEADER = Object.freeze({ magic: 0, version: 1, typeCount: 2, typesAt: 3, clustersAt: 4, clusterCount: 5, verticesAt: 6, vertexCount: 7, indicesAt: 8, indexCount: 9, chainsAt: 10, words: 11 });
export const CITY_CONTINUUM_TYPE_WORDS = 32;
// Where each of a type's numbers lies in its record. Positions are in the type's own metres, before a building
// stretches it; `low` and `span` quantize its vertices; `sphere` bounds everything it can draw.
export const CITY_CONTINUUM_TYPE = Object.freeze({
  low: 0, span: 3, sphere: 4, clusterFirst: 8, clusterCount: 9, chainVertices: 10, stepCount: 11,
  chainVertexCount: 12, records: 13, triangles: 14, steps: 15, baseError: 16, rootError: 17, splatRx: 18, splatRy: 19,
  splatCentre: 20, roofShare: 23, wallKind: 24, roofKind: 26, chainTriangleCount: 28, flags: 29, sourceTriangles: 30, farFirst: 31,
});
// A cluster: its LOD sphere, its parent group's, its culling sphere, its error and its parent's (metres), the first of
// its indices, and its triangles | level << 8 | part << 16. Clusters of a type are stored coarsest parent first.
export const CITY_CONTINUUM_CLUSTER_WORDS = 16;
// A vertex: x | y << 16, z | kind.y << 16, octahedral normal, material | kind fraction << 8.
export const CITY_CONTINUUM_VERTEX_WORDS = 4;
// A far-body step: triangles alive (a prefix), error in metres, how far along its normals the surface is grown to
// keep the outline its collapses take in, and a spare word.
export const CITY_CONTINUUM_STEP_WORDS = 4;
// A far-body triangle: its three corners and its kind (material | fraction << 8 | kind.y << 20).
export const CITY_CONTINUUM_TRIANGLE_WORDS = 4;
// A far-body vertex that never collapses holds this step in its record (step | target << 16).
export const CITY_CONTINUUM_NEVER = 65535;
// The most collapses one far-body vertex may pass through, as far as the GPU follows them.
export const CITY_CONTINUUM_HOPS = 256;
// The largest kind.y a type carries (a timber's shade plus twice its grain), for quantizing it.
export const CITY_CONTINUUM_KIND_Y = 8;
// The far body is drawn in pieces of this many triangles; clusters of at most CITY_CONTINUUM_SMALL_CLUSTER triangles
// are drawn from a list of their own, so a cut of many small parts does not pay for 128-triangle draws.
export const CITY_CONTINUUM_CHUNK_TRIANGLES = 32;
export const CITY_CONTINUUM_CLUSTER_TRIANGLES = 128;
export const CITY_CONTINUUM_SMALL_CLUSTER = 32;
// Flags of a type: the slight things (fences, graves, signs) that never stand as a target in their own right.
export const CITY_CONTINUUM_SLIGHT = 1;

// The baked atlas and its manifest. Spelled out, not composed, because the build publishes (and versions) only the
// asset paths it finds quoted in the source. Both are kept in git: the city is drawn from nothing else.
export const CITY_CONTINUUM_ASSETS = Object.freeze({
  'manifest.json': 'assets/city-continuum/manifest.json',
  'atlas.bin.gz': 'assets/city-continuum/atlas.bin.gz',
});

const cityUnit16 = (v) => Math.max(0, Math.min(65535, Math.round(v * 65535)));
// Octahedral normal, so two 16-bit values hold a whole direction.
export function cityContinuumOctahedral([x, y, z]) {
  const length = Math.abs(x) + Math.abs(y) + Math.abs(z) || 1;
  let u = x / length, v = y / length;
  if (z / length < 0) { const a = u; u = (1 - Math.abs(v)) * (a >= 0 ? 1 : -1); v = (1 - Math.abs(a)) * (v >= 0 ? 1 : -1); }
  return [u * 0.5 + 0.5, v * 0.5 + 0.5];
}
export function cityContinuumOctahedralNormal([u, v]) {
  const fx = u * 2 - 1, fy = v * 2 - 1, n = [fx, fy, 1 - Math.abs(fx) - Math.abs(fy)], t = Math.max(-n[2], 0);
  n[0] += n[0] >= 0 ? -t : t; n[1] += n[1] >= 0 ? -t : t;
  const l = Math.hypot(...n) || 1;
  return n.map((x) => x / l);
}
// A kind (material + fraction, kind.y) split into its parts.
function cityKindParts([x, y]) {
  const material = Math.floor(x + 0.01);
  return { material, fraction: Math.min(Math.max(x - material, 0), 0.999999), y: Math.min(Math.max(y / CITY_CONTINUUM_KIND_Y, 0), 1) };
}
// One vertex as four 32-bit words, quantized over its type's `low` and `span`.
export function packCityContinuumVertex({ position, normal, kind = [0, 0] }, { low, span }) {
  const p = position.map((v, a) => cityUnit16((v - low[a]) / span)), n = cityContinuumOctahedral(normal), k = cityKindParts(kind);
  if (!(k.material >= 0 && k.material < 256)) throw Error(`A city vertex has a material out of range: ${kind[0]}`);
  return [
    (p[0] | (p[1] << 16)) >>> 0,
    (p[2] | (cityUnit16(k.y) << 16)) >>> 0,
    (cityUnit16(n[0]) | (cityUnit16(n[1]) << 16)) >>> 0,
    (k.material | (Math.round(k.fraction * 16777215) << 8)) >>> 0,
  ];
}
export function unpackCityContinuumVertex(words, at, { low, span }) {
  const w = (k) => words[at + k];
  const q = [w(0) & 65535, w(0) >>> 16, w(1) & 65535];
  return {
    position: q.map((v, a) => low[a] + (v / 65535) * span),
    normal: cityContinuumOctahedralNormal([(w(2) & 65535) / 65535, (w(2) >>> 16) / 65535]),
    kind: [(w(3) & 255) + (w(3) >>> 8) / 16777215, ((w(1) >>> 16) / 65535) * CITY_CONTINUUM_KIND_Y],
  };
}
// A far-body triangle's kind in one word.
export function packCityContinuumKind(kind) {
  const k = cityKindParts(kind);
  return (k.material | (Math.round(k.fraction * 4095) << 8) | (Math.round(k.y * 4095) << 20)) >>> 0;
}
export function unpackCityContinuumKind(word) {
  return [(word & 255) + ((word >>> 8) & 4095) / 4095, ((word >>> 20) / 4095) * CITY_CONTINUUM_KIND_Y];
}
export function packCityContinuumCluster({ lod, parentLod, cull, error, parentError, first, triangles, level, part }) {
  const words = new ArrayBuffer(CITY_CONTINUUM_CLUSTER_WORDS * 4), f = new Float32Array(words), u = new Uint32Array(words);
  if (!(triangles > 0 && triangles <= CITY_CONTINUUM_CLUSTER_TRIANGLES)) throw Error(`A city cluster holds ${triangles} triangles`);
  f.set(lod, 0); f.set(parentLod, 4); f.set(cull, 8);
  f[12] = error; f[13] = Math.min(parentError, 1e30);
  u[14] = first;
  u[15] = (triangles | (Math.min(level, 255) << 8) | ((part & 65535) << 16)) >>> 0;
  return u;
}
// One baked body (js/continuum-bake.js bakeContinuumBody) as the words it adds to an atlas: a short head, its type
// record, its clusters, their vertices and indices, and its far body; every place in them counted from the body's own
// start, so that an atlas is assembled from bodies baked anywhere (offline, or in the page's worker) by moving them.
// `triangles` is the body's source triangle count, `slight` whether it never stands as a target in its own right.
export const CITY_CONTINUUM_BODY_MAGIC = 0x5944_4243;
export const CITY_CONTINUUM_BODY_HEAD = 8;
export function packCityContinuumBody({ triangles, slight = false }, { welded, clusters, far }) {
  const low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity];
  for (const P of [welded.position, far.position]) for (let v = 0; v < P.length / 3; v++) for (let k = 0; k < 3; k++) { low[k] = Math.min(low[k], P[v * 3 + k]); high[k] = Math.max(high[k], P[v * 3 + k]); }
  const span = Math.max(...high.map((v, k) => v - low[k])), quant = { low, span };
  // Every point it can draw, grown by the far body's largest inflation, within one sphere.
  const centre = low.map((v, k) => (v + high[k]) / 2);
  let radius = 0;
  for (const P of [welded.position, far.position]) for (let v = 0; v < P.length / 3; v++) radius = Math.max(radius, Math.hypot(P[v * 3] - centre[0], P[v * 3 + 1] - centre[1], P[v * 3 + 2] - centre[2]));
  radius += far.stats.inflateMax + 0.01;
  const V = far.position.length / 3, T = far.index.length / 3, S = far.chain.steps.length;
  const chainWords = V * (CITY_CONTINUUM_VERTEX_WORDS + 1) + T * CITY_CONTINUUM_TRIANGLE_WORDS + far.steps.length;
  const typeAt = CITY_CONTINUUM_BODY_HEAD, clustersAt = typeAt + CITY_CONTINUUM_TYPE_WORDS, verticesAt = clustersAt + clusters.count * CITY_CONTINUUM_CLUSTER_WORDS;
  const indicesAt = verticesAt + clusters.order.length * CITY_CONTINUUM_VERTEX_WORDS, chainAt = indicesAt + clusters.indices.length;
  const words = new Uint32Array(chainAt + chainWords), floats = new Float32Array(words.buffer);
  words.set([CITY_CONTINUUM_BODY_MAGIC, CITY_CONTINUUM_VERSION, clusters.count, clusters.order.length, clusters.indices.length, chainWords, triangles, 0], 0);
  clusters.records.forEach((record, k) => words.set(packCityContinuumCluster(record), clustersAt + k * CITY_CONTINUUM_CLUSTER_WORDS));
  clusters.order.forEach((v, i) => words.set(packCityContinuumVertex({ position: welded.position.subarray(v * 3, v * 3 + 3), normal: welded.normal.subarray(v * 3, v * 3 + 3), kind: welded.kind.subarray(v * 2, v * 2 + 2) }, quant), verticesAt + i * CITY_CONTINUUM_VERTEX_WORDS));
  words.set(clusters.indices, indicesAt);
  // The far body: vertices, each vertex's collapse (the step it goes at, and where), triangles in order of death
  // with their kinds, and steps.
  const recordsAt = V * CITY_CONTINUUM_VERTEX_WORDS, trianglesAt = recordsAt + V, stepsAt = trianglesAt + T * CITY_CONTINUUM_TRIANGLE_WORDS;
  for (let i = 0; i < V; i++) {
    words.set(packCityContinuumVertex({ position: far.position.subarray(i * 3, i * 3 + 3), normal: far.normal.subarray(i * 3, i * 3 + 3) }, quant), chainAt + i * CITY_CONTINUUM_VERTEX_WORDS);
    words[chainAt + recordsAt + i] = ((far.chain.dieStep[i] < 0 ? CITY_CONTINUUM_NEVER : far.chain.dieStep[i]) | ((far.chain.target[i] < 0 ? i : far.chain.target[i]) << 16)) >>> 0;
  }
  far.order.forEach((t, k) => {
    for (let c = 0; c < 3; c++) words[chainAt + trianglesAt + k * CITY_CONTINUUM_TRIANGLE_WORDS + c] = far.index[t * 3 + c];
    words[chainAt + trianglesAt + k * CITY_CONTINUUM_TRIANGLE_WORDS + 3] = packCityContinuumKind([far.kinds[t * 2], far.kinds[t * 2 + 1]]);
  });
  words.set(far.steps, chainAt + stepsAt);
  // The type's record, its places counted from the body's own clusters and far body.
  const F = CITY_CONTINUUM_TYPE;
  floats.set([...low, span], typeAt + F.low);
  floats.set([...centre, radius], typeAt + F.sphere);
  words.set([0, clusters.count, 0, S, V, recordsAt, trianglesAt, stepsAt], typeAt + F.clusterFirst);
  floats.set([far.baseError, clusters.rootError, far.splat.rx, far.splat.ry, ...far.splat.centre, far.splat.roofShare, ...far.splat.wallKind, ...far.splat.roofKind], typeAt + F.baseError);
  words.set([T, slight ? CITY_CONTINUUM_SLIGHT : 0, triangles, far.farFirst], typeAt + F.chainTriangleCount);
  return { words, low, span, centre, radius };
}
// A broken body (js/building-fracture.js): a struck building's pieces, each piece a part. It is drawn as clusters alone,
// every cluster riding its piece's flight, so it carries no far body, no chain and no splat.
export function cityContinuumPiecesFar() {
  return {
    position: new Float32Array(0), normal: new Float32Array(0), index: new Uint32Array(0), kinds: new Float32Array(0), order: [],
    chain: { steps: [], dieStep: new Int32Array(0), target: new Int32Array(0) }, steps: new Uint32Array(0), stats: { inflateMax: 0 },
    baseError: 0, farFirst: 0, splat: { rx: 0, ry: 0, centre: [0, 0, 0], roofShare: 0, wallKind: [0, 0], roofKind: [0, 0] },
  };
}
export function packCityContinuumPieces({ triangles }, { welded, clusters }) {
  return packCityContinuumBody({ triangles }, { welded, clusters, far: cityContinuumPiecesFar() });
}
// A broken body's finest level, made in the page the moment the pieces are cut: each piece's triangles in clusters
// of at most CITY_CONTINUUM_CLUSTER_TRIANGLES, ordered along the piece's longest side, every one a root of error 0.
// The worker's bake of its coarser levels (js/prefab-continuum.js bakeFracturePieces) replaces it when it lands.
export function cityContinuumFinestClusters(welded) {
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
    for (let first = 0; first < list.length; first += CITY_CONTINUUM_CLUSTER_TRIANGLES) {
      const chunk = list.slice(first, first + CITY_CONTINUUM_CLUSTER_TRIANGLES), low = [Infinity, Infinity, Infinity], high = [-Infinity, -Infinity, -Infinity];
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
export function cityContinuumBodyParts(words) {
  if (words[0] !== CITY_CONTINUUM_BODY_MAGIC || words[1] !== CITY_CONTINUUM_VERSION) throw Error('A continuum body of another format');
  const [clusters, vertices, indices, chain] = words.subarray(2, 6), typeAt = CITY_CONTINUUM_BODY_HEAD, clustersAt = typeAt + CITY_CONTINUUM_TYPE_WORDS;
  const verticesAt = clustersAt + clusters * CITY_CONTINUUM_CLUSTER_WORDS, indicesAt = verticesAt + vertices * CITY_CONTINUUM_VERTEX_WORDS, chainAt = indicesAt + indices;
  if (chainAt + chain !== words.length) throw Error('A continuum body does not add up');
  return { clusters, vertices, indices, chain, sourceTriangles: words[6], typeAt, clustersAt, verticesAt, indicesAt, chainAt };
}
// An atlas of packed bodies, type i being bodies[i]: header, type records, every body's clusters, vertices and
// indices, then every far body, each body's places moved to where it now lies.
export function assembleCityContinuumAtlas(bodies) {
  const parts = bodies.map(cityContinuumBodyParts), sum = (key) => parts.reduce((n, p) => n + p[key], 0);
  const typesAt = CITY_CONTINUUM_HEADER_WORDS, clustersAt = typesAt + bodies.length * CITY_CONTINUUM_TYPE_WORDS, totalClusters = sum('clusters');
  const verticesAt = clustersAt + totalClusters * CITY_CONTINUUM_CLUSTER_WORDS, totalVertices = sum('vertices'), indicesAt = verticesAt + totalVertices * CITY_CONTINUUM_VERTEX_WORDS;
  const totalIndices = sum('indices'), chainsAt = indicesAt + totalIndices, words = chainsAt + sum('chain');
  const atlas = new Uint32Array(words), F = CITY_CONTINUUM_TYPE;
  atlas.set([CITY_CONTINUUM_MAGIC, CITY_CONTINUUM_VERSION, bodies.length, typesAt, clustersAt, totalClusters, verticesAt, totalVertices, indicesAt, totalIndices, chainsAt, words], 0);
  let clusterAt = 0, vertexAt = 0, indexAt = 0, chainAt = chainsAt;
  bodies.forEach((body, id) => {
    const p = parts[id], at = typesAt + id * CITY_CONTINUUM_TYPE_WORDS;
    atlas.set(body.subarray(p.typeAt, p.typeAt + CITY_CONTINUUM_TYPE_WORDS), at);
    atlas[at + F.clusterFirst] = clusterAt;
    atlas[at + F.chainVertices] = chainAt;
    for (const field of [F.records, F.triangles, F.steps]) atlas[at + field] += chainAt;
    const clusterWords = clustersAt + clusterAt * CITY_CONTINUUM_CLUSTER_WORDS;
    atlas.set(body.subarray(p.clustersAt, p.verticesAt), clusterWords);
    for (let k = 0; k < p.clusters; k++) atlas[clusterWords + k * CITY_CONTINUUM_CLUSTER_WORDS + 14] += indexAt;
    atlas.set(body.subarray(p.verticesAt, p.indicesAt), verticesAt + vertexAt * CITY_CONTINUUM_VERTEX_WORDS);
    for (let i = 0; i < p.indices; i++) atlas[indicesAt + indexAt + i] = body[p.indicesAt + i] + vertexAt;
    atlas.set(body.subarray(p.chainAt), chainAt);
    clusterAt += p.clusters; vertexAt += p.vertices; indexAt += p.indices; chainAt += p.chain;
  });
  if (chainAt !== words) throw Error('The atlas layout does not add up');
  return atlas;
}
// What the bake read of a type, byte for byte: its drawn triangles and their parts. The manifest keeps each type's
// digest of these, so a builder changed since the bake is caught (tests/city-continuum-bake.test.mjs).
export function cityContinuumSourceBytes(type) {
  const vertices = new Uint8Array(type.vertices.buffer, type.vertices.byteOffset, type.vertices.byteLength);
  const parts = new Uint8Array(type.parts.buffer, type.parts.byteOffset, type.parts.byteLength), out = new Uint8Array(vertices.length + parts.length);
  out.set(vertices, 0); out.set(parts, vertices.length);
  return out;
}

export function validateCityContinuumManifest(manifest) {
  if (manifest?.format !== CITY_CONTINUUM_FORMAT || manifest.version !== CITY_CONTINUUM_VERSION) throw Error('Invalid city continuum manifest');
  const { types, atlas } = manifest;
  if (!Array.isArray(types) || !types.length) throw Error('The city continuum holds no types');
  types.forEach((type, id) => {
    if (type.id !== id || !/^[0-9a-f]{64}$/.test(type.fingerprint ?? '')) throw Error(`City continuum type ${id} is malformed`);
    if (!(type.clusters?.count > 0) || !(type.chain?.baseTriangles >= 4) || !(type.chain.steps >= 1 && type.chain.steps < CITY_CONTINUUM_NEVER)) throw Error(`City continuum type ${id} is incomplete`);
  });
  if (!(atlas?.words > CITY_CONTINUUM_HEADER_WORDS) || atlas.bytes !== atlas.words * 4 || !/^[0-9a-f]{64}$/.test(atlas.sha256 ?? '') || !atlas.gzip?.file) throw Error('The city continuum atlas is malformed');
  return manifest;
}

// The atlas, fetched, unpacked and checked against its receipt. Resolves to { manifest, words }.
export async function loadCityContinuum({ fetchAsset = fetch } = {}) {
  const get = async (path) => {
    const response = await fetchAsset(path);
    if (!response.ok) throw Error(`City continuum unavailable (${response.status}): ${path}`);
    return response;
  };
  const manifest = validateCityContinuumManifest(await (await get(CITY_CONTINUUM_ASSETS['manifest.json'])).json());
  const response = await get(CITY_CONTINUUM_ASSETS['atlas.bin.gz']);
  const bytes = new Uint8Array(await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  if (bytes.byteLength !== manifest.atlas.bytes) throw Error('The city continuum atlas has the wrong size');
  const digest = new Uint8Array(await crypto.subtle.digest('SHA-256', bytes));
  if (Array.from(digest, (v) => v.toString(16).padStart(2, '0')).join('') !== manifest.atlas.sha256) throw Error('The city continuum atlas failed verification');
  const words = new Uint32Array(bytes.buffer, bytes.byteOffset, bytes.byteLength / 4);
  if (words[CITY_CONTINUUM_HEADER.magic] !== CITY_CONTINUUM_MAGIC || words[CITY_CONTINUUM_HEADER.version] !== CITY_CONTINUUM_VERSION) throw Error('The city continuum atlas is of another format');
  return { manifest, words };
}

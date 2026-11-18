// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Ships in the one continuum (AGENTS.md rule 3). Each ship body, assembled from its real parts (a trade vessel's
// archetype, js/trade-vessels.js, or a ship the player sails, js/ship-mesh.js), is baked by
// scripts/prepare-ship-continuum.mjs into one body of the one atlas format (js/continuum-format.js): a cluster
// hierarchy of its own triangles, split where a part or a fracture shard ends; a closed far body that collapses one
// half-edge at a time to a few triangles; a splat; and, first among its clusters, its detail layer (her lines and her
// anchor's iron, rule 3.6). Every atlas vertex names the assembly vertex it rides (js/wgsl/ship-kinds.js), so the one
// cut draws a ship posed as her physics poses her. This module is the family's data: its bodies, their receipts, and
// how a family's atlas is assembled from them.
import {
  CONTINUUM_ATLAS_VERSION, CONTINUUM_STREAMS, CONTINUUM_TYPE, CONTINUUM_TYPE_DETAIL_SHIFT, assembleContinuumAtlas, checkContinuumAtlas, continuumBodyParts,
  continuumFloatWord, packContinuumBody, packContinuumUV,
} from './continuum-format.js';
import { SHIP_RIDER_FAR, SHIP_RIDER_LINE } from './wgsl/ship-kinds.js';

export const SHIP_CONTINUUM_FORMAT = 'waterworld.ship-continuum';
// A ship manifest is of the atlas's own version: a rebake is the only way to a new one.
export const SHIP_CONTINUUM_VERSION = CONTINUUM_ATLAS_VERSION;
// A ship type's material block (CONTINUUM_TYPE.material): design units to the type's metres (x, y, z, f32), and the
// colour her far body's outline shows side on (sqrt-encoded rgb8).
export const SHIP_CONTINUUM_MATERIAL = Object.freeze({ designScale: CONTINUUM_TYPE.material, splat: CONTINUUM_TYPE.material + 3 });

// The bodies, by id: each trade vessel archetype (js/trade-vessels.js ARCHETYPE_SPECS) and each ship the player can
// sail (js/ship-models.js SHIP_MODELS), each baked from the assembly the game builds of it.
export const SHIP_CONTINUUM_BODIES = Object.freeze([
  { id: 'trade-cog-underway', family: 'trade', archetype: 0 },
  { id: 'trade-cog-anchored', family: 'trade', archetype: 1 },
  { id: 'trade-carrack-underway', family: 'trade', archetype: 2 },
  { id: 'trade-carrack-anchored', family: 'trade', archetype: 3 },
  { id: 'trade-river-barge', family: 'trade', archetype: 4 },
  { id: 'trade-lateen-caravel', family: 'trade', archetype: 5 },
  { id: 'trade-harbor-barque', family: 'trade', archetype: 6 },
  { id: 'player-victory', family: 'player', model: 'victory' },
  { id: 'player-nina', family: 'player', model: 'nina' },
  { id: 'player-pinta', family: 'player', model: 'pinta' },
  { id: 'player-santa-maria', family: 'player', model: 'santa-maria' },
  { id: 'player-oseberg', family: 'player', model: 'oseberg' },
  { id: 'player-lusoria', family: 'player', model: 'lusoria' },
  { id: 'player-taino-canoe', family: 'player', model: 'taino-canoe' },
  { id: 'player-flying-cloud', family: 'player', model: 'flying-cloud' },
  { id: 'player-gipsy-moth-iv', family: 'player', model: 'gipsy-moth-iv' },
].map(Object.freeze));
// The files of a body, by family: its packed body; then for a trade vessel the assembly it was baked from (vertices of
// 9 floats: position, normal, material, uv) with each vertex's fracture shard, which a damaged vessel scars and breaks;
// and for a player's ship the assembly's own corners as baked (its index buffer), by which her riders are renumbered
// onto the ship as built where she is drawn (an engine that rounds a sine in the last place welds a few vertices
// otherwise), so she draws, poses, wets and breaks the one mesh her physics uses.
export const SHIP_CONTINUUM_STREAMS = Object.freeze({
  trade: Object.freeze(['body.bin', 'vertices.bin', 'shards.bin']),
  player: Object.freeze(['body.bin', 'corners.bin']),
});
export const shipContinuumStreams = (family) => SHIP_CONTINUUM_STREAMS[family] ?? [];
// Every file of every body, by body and file name, for loading and for build.mjs to publish. Spelled out, not
// composed, because the build publishes (and versions) only the asset paths it finds quoted in the source.
export const SHIP_CONTINUUM_ASSETS = Object.freeze({
  'trade-cog-underway': Object.freeze({
    'manifest.json': 'assets/ships/continuum/trade-cog-underway/manifest.json',
    'body.bin.gz': 'assets/ships/continuum/trade-cog-underway/body.bin.gz',
    'vertices.bin.gz': 'assets/ships/continuum/trade-cog-underway/vertices.bin.gz',
    'shards.bin.gz': 'assets/ships/continuum/trade-cog-underway/shards.bin.gz',
  }),
  'trade-cog-anchored': Object.freeze({
    'manifest.json': 'assets/ships/continuum/trade-cog-anchored/manifest.json',
    'body.bin.gz': 'assets/ships/continuum/trade-cog-anchored/body.bin.gz',
    'vertices.bin.gz': 'assets/ships/continuum/trade-cog-anchored/vertices.bin.gz',
    'shards.bin.gz': 'assets/ships/continuum/trade-cog-anchored/shards.bin.gz',
  }),
  'trade-carrack-underway': Object.freeze({
    'manifest.json': 'assets/ships/continuum/trade-carrack-underway/manifest.json',
    'body.bin.gz': 'assets/ships/continuum/trade-carrack-underway/body.bin.gz',
    'vertices.bin.gz': 'assets/ships/continuum/trade-carrack-underway/vertices.bin.gz',
    'shards.bin.gz': 'assets/ships/continuum/trade-carrack-underway/shards.bin.gz',
  }),
  'trade-carrack-anchored': Object.freeze({
    'manifest.json': 'assets/ships/continuum/trade-carrack-anchored/manifest.json',
    'body.bin.gz': 'assets/ships/continuum/trade-carrack-anchored/body.bin.gz',
    'vertices.bin.gz': 'assets/ships/continuum/trade-carrack-anchored/vertices.bin.gz',
    'shards.bin.gz': 'assets/ships/continuum/trade-carrack-anchored/shards.bin.gz',
  }),
  'trade-river-barge': Object.freeze({
    'manifest.json': 'assets/ships/continuum/trade-river-barge/manifest.json',
    'body.bin.gz': 'assets/ships/continuum/trade-river-barge/body.bin.gz',
    'vertices.bin.gz': 'assets/ships/continuum/trade-river-barge/vertices.bin.gz',
    'shards.bin.gz': 'assets/ships/continuum/trade-river-barge/shards.bin.gz',
  }),
  'trade-lateen-caravel': Object.freeze({
    'manifest.json': 'assets/ships/continuum/trade-lateen-caravel/manifest.json',
    'body.bin.gz': 'assets/ships/continuum/trade-lateen-caravel/body.bin.gz',
    'vertices.bin.gz': 'assets/ships/continuum/trade-lateen-caravel/vertices.bin.gz',
    'shards.bin.gz': 'assets/ships/continuum/trade-lateen-caravel/shards.bin.gz',
  }),
  'trade-harbor-barque': Object.freeze({
    'manifest.json': 'assets/ships/continuum/trade-harbor-barque/manifest.json',
    'body.bin.gz': 'assets/ships/continuum/trade-harbor-barque/body.bin.gz',
    'vertices.bin.gz': 'assets/ships/continuum/trade-harbor-barque/vertices.bin.gz',
    'shards.bin.gz': 'assets/ships/continuum/trade-harbor-barque/shards.bin.gz',
  }),
  'player-victory': Object.freeze({
    'manifest.json': 'assets/ships/continuum/player-victory/manifest.json',
    'body.bin.gz': 'assets/ships/continuum/player-victory/body.bin.gz',
    'corners.bin.gz': 'assets/ships/continuum/player-victory/corners.bin.gz',
  }),
  'player-nina': Object.freeze({
    'manifest.json': 'assets/ships/continuum/player-nina/manifest.json',
    'body.bin.gz': 'assets/ships/continuum/player-nina/body.bin.gz',
    'corners.bin.gz': 'assets/ships/continuum/player-nina/corners.bin.gz',
  }),
  'player-pinta': Object.freeze({
    'manifest.json': 'assets/ships/continuum/player-pinta/manifest.json',
    'body.bin.gz': 'assets/ships/continuum/player-pinta/body.bin.gz',
    'corners.bin.gz': 'assets/ships/continuum/player-pinta/corners.bin.gz',
  }),
  'player-santa-maria': Object.freeze({
    'manifest.json': 'assets/ships/continuum/player-santa-maria/manifest.json',
    'body.bin.gz': 'assets/ships/continuum/player-santa-maria/body.bin.gz',
    'corners.bin.gz': 'assets/ships/continuum/player-santa-maria/corners.bin.gz',
  }),
  'player-oseberg': Object.freeze({
    'manifest.json': 'assets/ships/continuum/player-oseberg/manifest.json',
    'body.bin.gz': 'assets/ships/continuum/player-oseberg/body.bin.gz',
    'corners.bin.gz': 'assets/ships/continuum/player-oseberg/corners.bin.gz',
  }),
  'player-lusoria': Object.freeze({
    'manifest.json': 'assets/ships/continuum/player-lusoria/manifest.json',
    'body.bin.gz': 'assets/ships/continuum/player-lusoria/body.bin.gz',
    'corners.bin.gz': 'assets/ships/continuum/player-lusoria/corners.bin.gz',
  }),
  'player-taino-canoe': Object.freeze({
    'manifest.json': 'assets/ships/continuum/player-taino-canoe/manifest.json',
    'body.bin.gz': 'assets/ships/continuum/player-taino-canoe/body.bin.gz',
    'corners.bin.gz': 'assets/ships/continuum/player-taino-canoe/corners.bin.gz',
  }),
  'player-flying-cloud': Object.freeze({
    'manifest.json': 'assets/ships/continuum/player-flying-cloud/manifest.json',
    'body.bin.gz': 'assets/ships/continuum/player-flying-cloud/body.bin.gz',
    'corners.bin.gz': 'assets/ships/continuum/player-flying-cloud/corners.bin.gz',
  }),
  'player-gipsy-moth-iv': Object.freeze({
    'manifest.json': 'assets/ships/continuum/player-gipsy-moth-iv/manifest.json',
    'body.bin.gz': 'assets/ships/continuum/player-gipsy-moth-iv/body.bin.gz',
    'corners.bin.gz': 'assets/ships/continuum/player-gipsy-moth-iv/corners.bin.gz',
  }),
});

const shipUnit8 = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));
// A linear colour as one word, sqrt-encoded, with a byte above it.
export const shipContinuumColourWord = (colour, top = 0) => (shipUnit8(Math.sqrt(Math.max(0, colour[0]))) | (shipUnit8(Math.sqrt(Math.max(0, colour[1]))) << 8) | (shipUnit8(Math.sqrt(Math.max(0, colour[2]))) << 16) | ((top & 255) << 24)) >>> 0;

// One ship as a body of the atlas (js/continuum-format.js packContinuumBody). `vertices` are its welded points: their
// metres, normals, materials, UVs and riders (the assembly vertex each is, or SHIP_RIDER_LINE | j for a line vertex);
// `clusters` its detail layer's `detail` clusters first, then its hierarchy; `far` its far body, with the assembly
// vertex each far vertex rides and each far vertex's colour and class. Its material block is its design scale and its
// splat's colour.
export function packShipContinuumBody({ triangles, designScale, detail, vertices, clusters, far }) {
  const own = clusters.order.length, at = new Map();
  clusters.order.forEach((v, i) => { const r = vertices.rider[v]; if (!(r & SHIP_RIDER_LINE) && !at.has(r)) at.set(r, i); });
  const unit = (x) => Math.max(0, Math.min(1, x));
  return packContinuumBody({
    triangles, flags: detail << CONTINUUM_TYPE_DETAIL_SHIFT,
    material: [...Array.from(designScale, continuumFloatWord), shipContinuumColourWord(far.splat.colour)],
    vertex: (v) => ({ word: continuumFloatWord(vertices.material[v]) }),
    farWord: (t) => {
      const c = [0, 1, 2].map((k) => (far.colour[far.index[t * 3] * 3 + k] + far.colour[far.index[t * 3 + 1] * 3 + k] + far.colour[far.index[t * 3 + 2] * 3 + k]) / 3);
      return shipContinuumColourWord(c, far.region[far.index[t * 3]]);
    },
    streams: { uv: (v) => [packContinuumUV([unit(vertices.uv[v * 2]), unit(vertices.uv[v * 2 + 1])])], rider: (v) => [vertices.rider[v] >>> 0] },
    farStreams: {
      rider: (i) => {
        if (!at.has(far.rides[i])) throw Error(`Far vertex ${i} rides vertex ${far.rides[i]}, which no cluster draws`);
        return [(SHIP_RIDER_FAR | (own + i - at.get(far.rides[i]))) >>> 0];
      },
    },
  }, { welded: vertices, clusters, far });
}

// What a body is baked from, in terms every JavaScript engine builds alike: its triangles' part groups and fracture
// shards, exactly. Its vertices are welded by their exact bits, and engines that round a sine in the last place weld a
// few more or fewer; so a body draws (and fractures) the vertices it was baked with, and the bake test, run where the
// bake runs, holds those to the ship as it is built now.
export function shipContinuumSourceKey(arch) {
  return JSON.stringify({
    indices: arch.indices.length,
    groups: arch.groups.map((g) => [g.id, g.firstVertex, g.vertexCount]),
    shards: arch.fracture.shards.map((s) => s && [s.kind, s.partId, s.family ?? null, s.mast ?? null, s.segment ?? null, s.triangleCount ?? null]),
  });
}
// A body's surface: each material's area (m² at design scale) and the whole's centroid. Floating-point noise moves these
// only in their last digits; a ship built otherwise moves them more than SHIP_CONTINUUM_SURFACE_TOLERANCE of its area.
export const SHIP_CONTINUUM_SURFACE_TOLERANCE = 1e-6;
export function shipContinuumSurface(vertices, indices, floats = 9) {
  let area = 0;
  const centroid = [0, 0, 0], materials = {};
  for (let t = 0; t < indices.length; t += 3) {
    const a = indices[t] * floats, b = indices[t + 1] * floats, c = indices[t + 2] * floats;
    const ex = vertices[b] - vertices[a], ey = vertices[b + 1] - vertices[a + 1], ez = vertices[b + 2] - vertices[a + 2];
    const fx = vertices[c] - vertices[a], fy = vertices[c + 1] - vertices[a + 1], fz = vertices[c + 2] - vertices[a + 2];
    const A = 0.5 * Math.hypot(ey * fz - ez * fy, ez * fx - ex * fz, ex * fy - ey * fx);
    area += A;
    for (let k = 0; k < 3; k++) centroid[k] += (A * (vertices[a + k] + vertices[b + k] + vertices[c + k])) / 3;
    const m = Math.floor(vertices[a + 6]);
    materials[m] = (materials[m] ?? 0) + A;
  }
  return { area, centroid: centroid.map((v) => v / (area || 1)), materials };
}
export function shipContinuumSurfaceMatches(baked, built, tolerance = SHIP_CONTINUUM_SURFACE_TOLERANCE) {
  const scale = Math.max(baked.area, 1e-9), near = (x, y, unit) => Math.abs(x - y) <= tolerance * unit;
  if (!near(baked.area, built.area, scale)) return false;
  if (!baked.centroid.every((v, k) => near(v, built.centroid[k], Math.max(1, Math.abs(v))))) return false;
  return [...new Set([...Object.keys(baked.materials), ...Object.keys(built.materials)])].every((m) => near(baked.materials[m] ?? 0, built.materials[m] ?? 0, scale));
}

export function validateShipContinuumManifest(manifest) {
  if (manifest?.format !== SHIP_CONTINUUM_FORMAT || manifest.version !== SHIP_CONTINUUM_VERSION) throw Error(`Invalid ship continuum manifest ${manifest?.id ?? ''}: rebake it`);
  const body = SHIP_CONTINUUM_BODIES.find((b) => b.id === manifest.id);
  if (!body || body.family !== manifest.family || body.archetype !== manifest.archetype || body.model !== manifest.model) throw Error(`Unknown ship continuum body: ${manifest.id}`);
  const { source, files, detail } = manifest;
  if (!(source?.vertices > 0) || !(source.indices > 0) || !/^[0-9a-f]{64}$/.test(source.key ?? '') || !(source.surface?.area > 0) || source.surface.centroid?.length !== 3 || source.designScale?.length !== 3) throw Error(`Ship continuum source is malformed: ${manifest.id}`);
  if (!(detail?.clusters >= 0) || !(manifest.clusters?.count > detail.clusters) || !(manifest.far?.baseTriangles >= 4)) throw Error(`Ship continuum body is incomplete: ${manifest.id}`);
  const sized = { 'vertices.bin': source.vertices * 36, 'shards.bin': source.vertices * 4, 'corners.bin': source.indices * 4 };
  for (const name of shipContinuumStreams(body.family)) {
    if (name in sized && files?.[name]?.bytes !== sized[name]) throw Error(`Ship continuum stream sizes disagree: ${manifest.id} ${name}`);
    if (!(files?.[name]?.bytes > 0) || !files[name].gzip?.file || !/^[0-9a-f]{64}$/.test(files[name].sha256 ?? '')) throw Error(`Ship continuum stream missing: ${manifest.id} ${name}`);
  }
  return manifest;
}

const shipContinuumHex = (bytes) => Array.from(new Uint8Array(bytes), (v) => v.toString(16).padStart(2, '0')).join('');
// One file of a body, unpacked and checked against its receipt.
async function shipContinuumFile(manifest, name, fetchAsset) {
  const receipt = manifest.files[name], response = await fetchAsset(SHIP_CONTINUUM_ASSETS[manifest.id][receipt.gzip.file]);
  if (!response.ok) throw Error(`Ship continuum unavailable (${response.status}): ${manifest.id} ${name}`);
  const bytes = new Uint8Array(await new Response(response.body.pipeThrough(new DecompressionStream('gzip'))).arrayBuffer());
  if (bytes.byteLength !== receipt.bytes) throw Error(`Ship continuum stream has the wrong size: ${manifest.id} ${name}`);
  if (shipContinuumHex(await crypto.subtle.digest('SHA-256', bytes)) !== receipt.sha256) throw Error(`Ship continuum stream failed verification: ${manifest.id} ${name}`);
  return bytes;
}
// Where a packed body keeps its rider stream, in words from its start.
function shipContinuumRiders(words) {
  const parts = continuumBodyParts(words);
  let from = parts.streamsAt;
  for (const s of CONTINUUM_STREAMS) {
    if (!(parts.streams & s.bit)) continue;
    if (s.name === 'rider') return { at: from, count: parts.ownVertices };
    from += s.words * parts.vertices;
  }
  throw Error('A ship continuum body carries no riders');
}

// A family's atlas, type b being ids[b]: each body fetched and checked against its receipts and against the ship as
// built here (`sources[b]`: a body drawn over another assembly would not be the ship the physics strikes, so a stale
// bake stops the game here). A player's riders are renumbered, corner by corner of her assembly (the same triangles in
// the same order, whatever an engine's welding), onto her as built. Resolves to { manifest: the bodies' manifests,
// words, assemblies }: each trade body's assembly as baked (vertices, their shards), for a damaged vessel's own copy.
export async function loadShipContinuum({ ids, sources, label = 'ship', fetchAsset = fetch }) {
  const loaded = await Promise.all(ids.map(async (id, b) => {
    const response = await fetchAsset(SHIP_CONTINUUM_ASSETS[id]['manifest.json']);
    if (!response.ok) throw Error(`Ship continuum unavailable (${response.status}): ${id}`);
    const manifest = validateShipContinuumManifest(await response.json()), source = sources[b], names = shipContinuumStreams(manifest.family);
    const key = shipContinuumHex(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(shipContinuumSourceKey(source))));
    if (key !== manifest.source.key || source.fracture.shardCount !== manifest.source.shards || !shipContinuumSurfaceMatches(manifest.source.surface, shipContinuumSurface(source.vertices, source.indices))) {
      throw Error(`Ship continuum ${manifest.id} was baked from another assembly; run node scripts/prepare-ship-continuum.mjs`);
    }
    const files = Object.fromEntries(await Promise.all(names.map(async (name) => [name, await shipContinuumFile(manifest, name, fetchAsset)])));
    const words32 = (name) => new Uint32Array(files[name].buffer, files[name].byteOffset, files[name].byteLength / 4);
    const body = words32('body.bin').slice();
    if (files['corners.bin']) {
      const corners = words32('corners.bin'), built = new Uint32Array(manifest.source.vertices);
      if (corners.length !== source.indices.length) throw Error(`Ship continuum ${manifest.id} has another assembly's corners`);
      for (let i = 0; i < corners.length; i++) built[corners[i]] = source.indices[i];
      const { at, count } = shipContinuumRiders(body);
      for (let i = 0; i < count; i++) { const w = body[at + i]; if (!(w & (SHIP_RIDER_FAR | SHIP_RIDER_LINE))) body[at + i] = built[w]; }
      return { manifest, body, assembly: null };
    }
    const vertices = new Float32Array(files['vertices.bin'].buffer, files['vertices.bin'].byteOffset, files['vertices.bin'].byteLength / 4);
    return { manifest, body, assembly: { vertices, vertexShards: words32('shards.bin'), vertexCount: vertices.length / 9 } };
  }));
  return { manifest: loaded.map((l) => l.manifest), words: checkContinuumAtlas(assembleContinuumAtlas(loaded.map((l) => l.body)), label), assemblies: loaded.map((l) => l.assembly) };
}

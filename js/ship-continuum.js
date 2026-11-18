// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Ships in the one continuum (AGENTS.md rule 3). Each ship body, assembled from its real parts (the trade vessels'
// archetypes of js/trade-vessels.js), is baked by scripts/prepare-ship-continuum.mjs into a cluster hierarchy of its
// own triangles, split where a part or a fracture shard ends, and a closed far body that collapses one half-edge at a
// time to a few triangles, then a single splat. The GPU cuts every ship by projected error through the shared core
// (js/continuum-core.js, js/wgsl/ship-continuum.js); this module supplies only the family's data and its format.

export const SHIP_CONTINUUM_FORMAT = 'waterworld.ship-continuum';
export const SHIP_CONTINUUM_VERSION = 2;
// A cluster: its LOD sphere, its parent's, its culling sphere (each xyz r, metres in the ship's frame at scale 1),
// its error and its parent's (metres), the first word of its triangles in the body's index stream, and
// triangles | level << 8. Every sphere holds its points in every pose the body takes, so none is posed on the GPU.
export const SHIP_CONTINUUM_CLUSTER_WORDS = 16;
// A far-body vertex: x y z (f32, design units, as the vertex stage takes the ship's own vertices), its normal
// (octahedral, 2 x 16 bits, design units), its colour (sqrt-encoded rgb8) and class (8 bits), and the ship vertex it
// rides: the far body moves as that vertex does (oars, helm, brailed canvas).
export const SHIP_CONTINUUM_FAR_VERTEX_WORDS = 6;
// A far-body step: triangles alive (a prefix), error in metres, how far along its normals the surface is grown to
// keep the outline the collapses take in, and a spare word.
export const SHIP_CONTINUUM_STEP_WORDS = 4;
// A far-body vertex that never collapses holds this step in its record (step | target << 16).
export const SHIP_CONTINUUM_NEVER = 65535;
// Every ancestor walk on the GPU stops after this many hops; the bake holds each chain under it.
export const SHIP_CONTINUUM_MAX_DEPTH = 96;

// The bodies, by id, and the trade vessel archetype each is baked from (js/trade-vessels.js ARCHETYPE_SPECS).
export const SHIP_CONTINUUM_BODIES = Object.freeze([
  { id: 'trade-cog-underway', family: 'trade', archetype: 0 },
  { id: 'trade-cog-anchored', family: 'trade', archetype: 1 },
  { id: 'trade-carrack-underway', family: 'trade', archetype: 2 },
  { id: 'trade-carrack-anchored', family: 'trade', archetype: 3 },
  { id: 'trade-river-barge', family: 'trade', archetype: 4 },
  { id: 'trade-lateen-caravel', family: 'trade', archetype: 5 },
  { id: 'trade-harbor-barque', family: 'trade', archetype: 6 },
].map(Object.freeze));
// The streams of a body: its clusters and their corners, the seam copies they name, its far body, and the assembly it
// was baked from (vertices of 9 floats: position, normal, material, uv) with each vertex's fracture shard.
export const SHIP_CONTINUUM_STREAMS = Object.freeze(['clusters.bin', 'indices.bin', 'copies.bin', 'far.bin', 'vertices.bin', 'shards.bin']);
// Every file of every body, by body and file name, for loading and for build.mjs to publish. Spelled out, not
// composed, because the build publishes (and versions) only the asset paths it finds quoted in the source; the bake
// test holds this table to SHIP_CONTINUUM_BODIES and SHIP_CONTINUUM_STREAMS.
export const SHIP_CONTINUUM_ASSETS = Object.freeze({
  'trade-cog-underway': Object.freeze({
    'manifest.json': 'assets/ships/continuum/trade-cog-underway/manifest.json',
    'clusters.bin.gz': 'assets/ships/continuum/trade-cog-underway/clusters.bin.gz',
    'indices.bin.gz': 'assets/ships/continuum/trade-cog-underway/indices.bin.gz',
    'copies.bin.gz': 'assets/ships/continuum/trade-cog-underway/copies.bin.gz',
    'far.bin.gz': 'assets/ships/continuum/trade-cog-underway/far.bin.gz',
    'vertices.bin.gz': 'assets/ships/continuum/trade-cog-underway/vertices.bin.gz',
    'shards.bin.gz': 'assets/ships/continuum/trade-cog-underway/shards.bin.gz',
  }),
  'trade-cog-anchored': Object.freeze({
    'manifest.json': 'assets/ships/continuum/trade-cog-anchored/manifest.json',
    'clusters.bin.gz': 'assets/ships/continuum/trade-cog-anchored/clusters.bin.gz',
    'indices.bin.gz': 'assets/ships/continuum/trade-cog-anchored/indices.bin.gz',
    'copies.bin.gz': 'assets/ships/continuum/trade-cog-anchored/copies.bin.gz',
    'far.bin.gz': 'assets/ships/continuum/trade-cog-anchored/far.bin.gz',
    'vertices.bin.gz': 'assets/ships/continuum/trade-cog-anchored/vertices.bin.gz',
    'shards.bin.gz': 'assets/ships/continuum/trade-cog-anchored/shards.bin.gz',
  }),
  'trade-carrack-underway': Object.freeze({
    'manifest.json': 'assets/ships/continuum/trade-carrack-underway/manifest.json',
    'clusters.bin.gz': 'assets/ships/continuum/trade-carrack-underway/clusters.bin.gz',
    'indices.bin.gz': 'assets/ships/continuum/trade-carrack-underway/indices.bin.gz',
    'copies.bin.gz': 'assets/ships/continuum/trade-carrack-underway/copies.bin.gz',
    'far.bin.gz': 'assets/ships/continuum/trade-carrack-underway/far.bin.gz',
    'vertices.bin.gz': 'assets/ships/continuum/trade-carrack-underway/vertices.bin.gz',
    'shards.bin.gz': 'assets/ships/continuum/trade-carrack-underway/shards.bin.gz',
  }),
  'trade-carrack-anchored': Object.freeze({
    'manifest.json': 'assets/ships/continuum/trade-carrack-anchored/manifest.json',
    'clusters.bin.gz': 'assets/ships/continuum/trade-carrack-anchored/clusters.bin.gz',
    'indices.bin.gz': 'assets/ships/continuum/trade-carrack-anchored/indices.bin.gz',
    'copies.bin.gz': 'assets/ships/continuum/trade-carrack-anchored/copies.bin.gz',
    'far.bin.gz': 'assets/ships/continuum/trade-carrack-anchored/far.bin.gz',
    'vertices.bin.gz': 'assets/ships/continuum/trade-carrack-anchored/vertices.bin.gz',
    'shards.bin.gz': 'assets/ships/continuum/trade-carrack-anchored/shards.bin.gz',
  }),
  'trade-river-barge': Object.freeze({
    'manifest.json': 'assets/ships/continuum/trade-river-barge/manifest.json',
    'clusters.bin.gz': 'assets/ships/continuum/trade-river-barge/clusters.bin.gz',
    'indices.bin.gz': 'assets/ships/continuum/trade-river-barge/indices.bin.gz',
    'copies.bin.gz': 'assets/ships/continuum/trade-river-barge/copies.bin.gz',
    'far.bin.gz': 'assets/ships/continuum/trade-river-barge/far.bin.gz',
    'vertices.bin.gz': 'assets/ships/continuum/trade-river-barge/vertices.bin.gz',
    'shards.bin.gz': 'assets/ships/continuum/trade-river-barge/shards.bin.gz',
  }),
  'trade-lateen-caravel': Object.freeze({
    'manifest.json': 'assets/ships/continuum/trade-lateen-caravel/manifest.json',
    'clusters.bin.gz': 'assets/ships/continuum/trade-lateen-caravel/clusters.bin.gz',
    'indices.bin.gz': 'assets/ships/continuum/trade-lateen-caravel/indices.bin.gz',
    'copies.bin.gz': 'assets/ships/continuum/trade-lateen-caravel/copies.bin.gz',
    'far.bin.gz': 'assets/ships/continuum/trade-lateen-caravel/far.bin.gz',
    'vertices.bin.gz': 'assets/ships/continuum/trade-lateen-caravel/vertices.bin.gz',
    'shards.bin.gz': 'assets/ships/continuum/trade-lateen-caravel/shards.bin.gz',
  }),
  'trade-harbor-barque': Object.freeze({
    'manifest.json': 'assets/ships/continuum/trade-harbor-barque/manifest.json',
    'clusters.bin.gz': 'assets/ships/continuum/trade-harbor-barque/clusters.bin.gz',
    'indices.bin.gz': 'assets/ships/continuum/trade-harbor-barque/indices.bin.gz',
    'copies.bin.gz': 'assets/ships/continuum/trade-harbor-barque/copies.bin.gz',
    'far.bin.gz': 'assets/ships/continuum/trade-harbor-barque/far.bin.gz',
    'vertices.bin.gz': 'assets/ships/continuum/trade-harbor-barque/vertices.bin.gz',
    'shards.bin.gz': 'assets/ships/continuum/trade-harbor-barque/shards.bin.gz',
  }),
});

const shipUnit16 = (v) => Math.max(0, Math.min(65535, Math.round(v * 65535)));
const shipUnit8 = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));
// Octahedral normal, so two 16-bit values hold a whole direction.
export function shipContinuumOctahedral([x, y, z]) {
  const length = Math.abs(x) + Math.abs(y) + Math.abs(z) || 1;
  let u = x / length, v = y / length;
  if (z / length < 0) { const a = u; u = (1 - Math.abs(v)) * (a >= 0 ? 1 : -1); v = (1 - Math.abs(a)) * (v >= 0 ? 1 : -1); }
  return [u * 0.5 + 0.5, v * 0.5 + 0.5];
}
// One far-body vertex as six words.
export function packShipContinuumFarVertex({ position, normal, colour, kind = 0, source }) {
  const words = new ArrayBuffer(SHIP_CONTINUUM_FAR_VERTEX_WORDS * 4), f = new Float32Array(words), u = new Uint32Array(words);
  f.set(position, 0);
  const n = shipContinuumOctahedral(normal);
  u[3] = (shipUnit16(n[0]) | (shipUnit16(n[1]) << 16)) >>> 0;
  u[4] = (shipUnit8(Math.sqrt(Math.max(0, colour[0]))) | (shipUnit8(Math.sqrt(Math.max(0, colour[1]))) << 8) | (shipUnit8(Math.sqrt(Math.max(0, colour[2]))) << 16) | ((kind & 255) << 24)) >>> 0;
  u[5] = source >>> 0;
  return u;
}
// One cluster as sixteen words.
export function packShipContinuumCluster({ lod, parentLod, cull, error, parentError, first, triangles, level }) {
  const words = new ArrayBuffer(SHIP_CONTINUUM_CLUSTER_WORDS * 4), f = new Float32Array(words), u = new Uint32Array(words);
  f.set(lod, 0); f.set(parentLod, 4); f.set(cull, 8);
  f[12] = error; f[13] = Math.min(parentError, 1e30);
  u[14] = first;
  u[15] = (triangles | (level << 8)) >>> 0;
  return u;
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
  if (manifest?.format !== SHIP_CONTINUUM_FORMAT || manifest.version !== SHIP_CONTINUUM_VERSION || manifest.clusterWords !== SHIP_CONTINUUM_CLUSTER_WORDS || manifest.farVertexWords !== SHIP_CONTINUUM_FAR_VERTEX_WORDS || manifest.stepWords !== SHIP_CONTINUUM_STEP_WORDS) throw Error('Invalid ship continuum manifest');
  const body = SHIP_CONTINUUM_BODIES.find((b) => b.id === manifest.id);
  if (!body || body.archetype !== manifest.archetype) throw Error(`Unknown ship continuum body: ${manifest.id}`);
  const { source, clusterCount, indexCount, copyCount, far, splat, bound, files } = manifest;
  if (!(source?.vertices > 0) || !(source.indices > 0) || !/^[0-9a-f]{64}$/.test(source.key ?? '') || !(source.surface?.area > 0) || source.surface.centroid?.length !== 3 || source.designScale?.length !== 3) throw Error(`Ship continuum source is malformed: ${manifest.id}`);
  if (!(clusterCount > 0) || !(indexCount > 0) || indexCount % 3 || !(copyCount >= 0)) throw Error(`Ship continuum counts are malformed: ${manifest.id}`);
  if (!(far?.vertexCount > 0 && far.vertexCount < SHIP_CONTINUUM_NEVER) || !(far.triangleCount >= 4) || !(far.stepCount >= 1 && far.stepCount < SHIP_CONTINUUM_NEVER) || !(far.depth <= SHIP_CONTINUUM_MAX_DEPTH)) throw Error(`Ship continuum far body is malformed: ${manifest.id}`);
  const { vertices, records, triangles, steps } = far.offsets ?? {};
  if (vertices !== 0 || records !== far.vertexCount * SHIP_CONTINUUM_FAR_VERTEX_WORDS || triangles !== records + far.vertexCount || steps !== triangles + far.triangleCount * 3 || files?.['far.bin']?.bytes !== (steps + (far.stepCount + 1) * SHIP_CONTINUUM_STEP_WORDS) * 4) throw Error(`Ship continuum far body layout is malformed: ${manifest.id}`);
  if (!(far.baseError > 0)) throw Error(`Ship continuum far body has no error: ${manifest.id}`);
  if (!splat || splat.centre?.length !== 3 || !(splat.ry > 0) || !(splat.rxSide > 0) || !(splat.rxEnd > 0) || splat.colour?.length !== 3) throw Error(`Ship continuum splat is malformed: ${manifest.id}`);
  if (!bound || bound.centre?.length !== 3 || !(bound.radius > 0)) throw Error(`Ship continuum bound is malformed: ${manifest.id}`);
  if (files?.['clusters.bin']?.bytes !== clusterCount * SHIP_CONTINUUM_CLUSTER_WORDS * 4 || files?.['indices.bin']?.bytes !== indexCount * 4 || files?.['copies.bin']?.bytes !== copyCount * 4 || files?.['vertices.bin']?.bytes !== source.vertices * 36 || files?.['shards.bin']?.bytes !== source.vertices * 4) throw Error(`Ship continuum stream sizes disagree: ${manifest.id}`);
  for (const name of SHIP_CONTINUUM_STREAMS) if (!files?.[name]?.gzip?.file || !/^[0-9a-f]{64}$/.test(files[name].sha256 ?? '')) throw Error(`Ship continuum stream missing: ${manifest.id} ${name}`);
  return manifest;
}

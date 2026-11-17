// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// People in the one continuum (AGENTS.md rule 3). Each high-detail body, fitted to the crew skeleton by
// scripts/fit-crew-body.py, is baked by scripts/prepare-crew-continuum.mjs into a cluster hierarchy that carries its
// skin, and a closed far body that collapses one half-edge at a time, then a single splat. The GPU cuts every person
// by projected error through the shared core (js/continuum-core.js); this module supplies only the family's data.
import { CREW_JOINT_NAMES, CREW_JOINT_PARENTS, CREW_JOINT_COUNT } from './crew-skeleton.js';

export const CREW_CONTINUUM_FORMAT = 'waterworld.crew-continuum';
export const CREW_CONTINUUM_VERSION = 1;
export const CREW_CONTINUUM_VERTEX_WORDS = 6;
export const CREW_CONTINUUM_CLUSTER_WORDS = 20;
// A far-body step: triangles alive (a prefix), error in metres, how far along its normals the surface is grown to
// keep the outline the collapses take in, and a spare word.
export const CREW_CONTINUUM_STEP_WORDS = 4;
// A far-body vertex that never collapses holds this step in its record (step | target << 16).
export const CREW_CONTINUUM_NEVER = 65535;

// A body splits where a ball takes a limb (CREW_LIMB_JOINTS in js/crew-wounds.js), and at the neck. A cluster
// holds one part, and simplification never makes a triangle that spans two.
export const CREW_CONTINUUM_PARTS = Object.freeze(['trunk', 'head', 'upperarm_l', 'lowerarm_l', 'upperarm_r', 'lowerarm_r', 'thigh_l', 'calf_l', 'thigh_r', 'calf_r']);
const CREW_PART_ROOTS = Object.freeze({ neck_01: 'head', upperarm_l: 'upperarm_l', lowerarm_l: 'lowerarm_l', upperarm_r: 'upperarm_r', lowerarm_r: 'lowerarm_r', thigh_l: 'thigh_l', calf_l: 'calf_l', thigh_r: 'thigh_r', calf_r: 'calf_r' });
// Each joint's part: the nearest part root at or above it, or the trunk.
export const CREW_CONTINUUM_JOINT_PART = Object.freeze(CREW_JOINT_NAMES.map((name, slot) => {
  for (let at = slot; at >= 0; at = CREW_JOINT_PARENTS[at]) {
    const root = CREW_PART_ROOTS[CREW_JOINT_NAMES[at]];
    if (root) return CREW_CONTINUUM_PARTS.indexOf(root);
  }
  return 0;
}));
// What the fit says each point of a body is (`_REGION` in scripts/fit-crew-body.py). Paint is worn as it was made;
// the rest take each person's own colours.
export const CREW_CONTINUUM_REGIONS = Object.freeze(['paint', 'shirt', 'trousers', 'skin', 'hair']);

// The twelve bodies, and who wears each.
export const CREW_CONTINUUM_BODIES = Object.freeze([
  { id: 'sailor-male', sex: 'male', role: 'hand' },
  { id: 'villager-female', sex: 'female', role: 'hand' },
  { id: 'captain', sex: 'male', role: 'captain' },
  { id: 'soldier', sex: 'male', role: 'soldier' },
  { id: 'algonquian-male', sex: 'male', role: 'algonquian' },
  { id: 'algonquian-female', sex: 'female', role: 'algonquian' },
  { id: 'caribbean-male', sex: 'male', role: 'caribbean' },
  { id: 'caribbean-female', sex: 'female', role: 'caribbean' },
  { id: 'maya-male', sex: 'male', role: 'maya' },
  { id: 'maya-female', sex: 'female', role: 'maya' },
  { id: 'andean-male', sex: 'male', role: 'andean' },
  { id: 'andean-female', sex: 'female', role: 'andean' },
].map(Object.freeze));
// The baked streams of each body, by file. A body is fetched only when a scene first has someone to wear it.
export const CREW_CONTINUUM_STREAMS = Object.freeze(['vertices.bin', 'indices.bin', 'clusters.bin', 'chain.bin', 'albedo.bc7.bin', 'albedo.astc.bin']);
// Every file of every body, by body and file name, for loading and for build.mjs to publish. The streams are
// written by scripts/prepare-crew-continuum.mjs and kept out of git; only the manifests are committed. Spelled out,
// not composed, because the build publishes (and versions) only the asset paths it finds quoted in the source; the
// bake test holds this table to CREW_CONTINUUM_BODIES and CREW_CONTINUUM_STREAMS.
export const CREW_CONTINUUM_ASSETS = Object.freeze({
  'sailor-male': Object.freeze({
    'manifest.json': 'assets/crew/continuum/sailor-male/manifest.json',
    'body.glb': 'assets/crew/continuum/sailor-male/body.glb',
    'vertices.bin.gz': 'assets/crew/continuum/sailor-male/vertices.bin.gz',
    'indices.bin.gz': 'assets/crew/continuum/sailor-male/indices.bin.gz',
    'clusters.bin.gz': 'assets/crew/continuum/sailor-male/clusters.bin.gz',
    'chain.bin.gz': 'assets/crew/continuum/sailor-male/chain.bin.gz',
    'albedo.bc7.bin.gz': 'assets/crew/continuum/sailor-male/albedo.bc7.bin.gz',
    'albedo.astc.bin.gz': 'assets/crew/continuum/sailor-male/albedo.astc.bin.gz',
  }),
  'villager-female': Object.freeze({
    'manifest.json': 'assets/crew/continuum/villager-female/manifest.json',
    'body.glb': 'assets/crew/continuum/villager-female/body.glb',
    'vertices.bin.gz': 'assets/crew/continuum/villager-female/vertices.bin.gz',
    'indices.bin.gz': 'assets/crew/continuum/villager-female/indices.bin.gz',
    'clusters.bin.gz': 'assets/crew/continuum/villager-female/clusters.bin.gz',
    'chain.bin.gz': 'assets/crew/continuum/villager-female/chain.bin.gz',
    'albedo.bc7.bin.gz': 'assets/crew/continuum/villager-female/albedo.bc7.bin.gz',
    'albedo.astc.bin.gz': 'assets/crew/continuum/villager-female/albedo.astc.bin.gz',
  }),
  'captain': Object.freeze({
    'manifest.json': 'assets/crew/continuum/captain/manifest.json',
    'body.glb': 'assets/crew/continuum/captain/body.glb',
    'vertices.bin.gz': 'assets/crew/continuum/captain/vertices.bin.gz',
    'indices.bin.gz': 'assets/crew/continuum/captain/indices.bin.gz',
    'clusters.bin.gz': 'assets/crew/continuum/captain/clusters.bin.gz',
    'chain.bin.gz': 'assets/crew/continuum/captain/chain.bin.gz',
    'albedo.bc7.bin.gz': 'assets/crew/continuum/captain/albedo.bc7.bin.gz',
    'albedo.astc.bin.gz': 'assets/crew/continuum/captain/albedo.astc.bin.gz',
  }),
  'soldier': Object.freeze({
    'manifest.json': 'assets/crew/continuum/soldier/manifest.json',
    'body.glb': 'assets/crew/continuum/soldier/body.glb',
    'vertices.bin.gz': 'assets/crew/continuum/soldier/vertices.bin.gz',
    'indices.bin.gz': 'assets/crew/continuum/soldier/indices.bin.gz',
    'clusters.bin.gz': 'assets/crew/continuum/soldier/clusters.bin.gz',
    'chain.bin.gz': 'assets/crew/continuum/soldier/chain.bin.gz',
    'albedo.bc7.bin.gz': 'assets/crew/continuum/soldier/albedo.bc7.bin.gz',
    'albedo.astc.bin.gz': 'assets/crew/continuum/soldier/albedo.astc.bin.gz',
  }),
  'algonquian-male': Object.freeze({
    'manifest.json': 'assets/crew/continuum/algonquian-male/manifest.json',
    'body.glb': 'assets/crew/continuum/algonquian-male/body.glb',
    'vertices.bin.gz': 'assets/crew/continuum/algonquian-male/vertices.bin.gz',
    'indices.bin.gz': 'assets/crew/continuum/algonquian-male/indices.bin.gz',
    'clusters.bin.gz': 'assets/crew/continuum/algonquian-male/clusters.bin.gz',
    'chain.bin.gz': 'assets/crew/continuum/algonquian-male/chain.bin.gz',
    'albedo.bc7.bin.gz': 'assets/crew/continuum/algonquian-male/albedo.bc7.bin.gz',
    'albedo.astc.bin.gz': 'assets/crew/continuum/algonquian-male/albedo.astc.bin.gz',
  }),
  'algonquian-female': Object.freeze({
    'manifest.json': 'assets/crew/continuum/algonquian-female/manifest.json',
    'body.glb': 'assets/crew/continuum/algonquian-female/body.glb',
    'vertices.bin.gz': 'assets/crew/continuum/algonquian-female/vertices.bin.gz',
    'indices.bin.gz': 'assets/crew/continuum/algonquian-female/indices.bin.gz',
    'clusters.bin.gz': 'assets/crew/continuum/algonquian-female/clusters.bin.gz',
    'chain.bin.gz': 'assets/crew/continuum/algonquian-female/chain.bin.gz',
    'albedo.bc7.bin.gz': 'assets/crew/continuum/algonquian-female/albedo.bc7.bin.gz',
    'albedo.astc.bin.gz': 'assets/crew/continuum/algonquian-female/albedo.astc.bin.gz',
  }),
  'caribbean-male': Object.freeze({
    'manifest.json': 'assets/crew/continuum/caribbean-male/manifest.json',
    'body.glb': 'assets/crew/continuum/caribbean-male/body.glb',
    'vertices.bin.gz': 'assets/crew/continuum/caribbean-male/vertices.bin.gz',
    'indices.bin.gz': 'assets/crew/continuum/caribbean-male/indices.bin.gz',
    'clusters.bin.gz': 'assets/crew/continuum/caribbean-male/clusters.bin.gz',
    'chain.bin.gz': 'assets/crew/continuum/caribbean-male/chain.bin.gz',
    'albedo.bc7.bin.gz': 'assets/crew/continuum/caribbean-male/albedo.bc7.bin.gz',
    'albedo.astc.bin.gz': 'assets/crew/continuum/caribbean-male/albedo.astc.bin.gz',
  }),
  'caribbean-female': Object.freeze({
    'manifest.json': 'assets/crew/continuum/caribbean-female/manifest.json',
    'body.glb': 'assets/crew/continuum/caribbean-female/body.glb',
    'vertices.bin.gz': 'assets/crew/continuum/caribbean-female/vertices.bin.gz',
    'indices.bin.gz': 'assets/crew/continuum/caribbean-female/indices.bin.gz',
    'clusters.bin.gz': 'assets/crew/continuum/caribbean-female/clusters.bin.gz',
    'chain.bin.gz': 'assets/crew/continuum/caribbean-female/chain.bin.gz',
    'albedo.bc7.bin.gz': 'assets/crew/continuum/caribbean-female/albedo.bc7.bin.gz',
    'albedo.astc.bin.gz': 'assets/crew/continuum/caribbean-female/albedo.astc.bin.gz',
  }),
  'maya-male': Object.freeze({
    'manifest.json': 'assets/crew/continuum/maya-male/manifest.json',
    'body.glb': 'assets/crew/continuum/maya-male/body.glb',
    'vertices.bin.gz': 'assets/crew/continuum/maya-male/vertices.bin.gz',
    'indices.bin.gz': 'assets/crew/continuum/maya-male/indices.bin.gz',
    'clusters.bin.gz': 'assets/crew/continuum/maya-male/clusters.bin.gz',
    'chain.bin.gz': 'assets/crew/continuum/maya-male/chain.bin.gz',
    'albedo.bc7.bin.gz': 'assets/crew/continuum/maya-male/albedo.bc7.bin.gz',
    'albedo.astc.bin.gz': 'assets/crew/continuum/maya-male/albedo.astc.bin.gz',
  }),
  'maya-female': Object.freeze({
    'manifest.json': 'assets/crew/continuum/maya-female/manifest.json',
    'body.glb': 'assets/crew/continuum/maya-female/body.glb',
    'vertices.bin.gz': 'assets/crew/continuum/maya-female/vertices.bin.gz',
    'indices.bin.gz': 'assets/crew/continuum/maya-female/indices.bin.gz',
    'clusters.bin.gz': 'assets/crew/continuum/maya-female/clusters.bin.gz',
    'chain.bin.gz': 'assets/crew/continuum/maya-female/chain.bin.gz',
    'albedo.bc7.bin.gz': 'assets/crew/continuum/maya-female/albedo.bc7.bin.gz',
    'albedo.astc.bin.gz': 'assets/crew/continuum/maya-female/albedo.astc.bin.gz',
  }),
  'andean-male': Object.freeze({
    'manifest.json': 'assets/crew/continuum/andean-male/manifest.json',
    'body.glb': 'assets/crew/continuum/andean-male/body.glb',
    'vertices.bin.gz': 'assets/crew/continuum/andean-male/vertices.bin.gz',
    'indices.bin.gz': 'assets/crew/continuum/andean-male/indices.bin.gz',
    'clusters.bin.gz': 'assets/crew/continuum/andean-male/clusters.bin.gz',
    'chain.bin.gz': 'assets/crew/continuum/andean-male/chain.bin.gz',
    'albedo.bc7.bin.gz': 'assets/crew/continuum/andean-male/albedo.bc7.bin.gz',
    'albedo.astc.bin.gz': 'assets/crew/continuum/andean-male/albedo.astc.bin.gz',
  }),
  'andean-female': Object.freeze({
    'manifest.json': 'assets/crew/continuum/andean-female/manifest.json',
    'body.glb': 'assets/crew/continuum/andean-female/body.glb',
    'vertices.bin.gz': 'assets/crew/continuum/andean-female/vertices.bin.gz',
    'indices.bin.gz': 'assets/crew/continuum/andean-female/indices.bin.gz',
    'clusters.bin.gz': 'assets/crew/continuum/andean-female/clusters.bin.gz',
    'chain.bin.gz': 'assets/crew/continuum/andean-female/chain.bin.gz',
    'albedo.bc7.bin.gz': 'assets/crew/continuum/andean-female/albedo.bc7.bin.gz',
    'albedo.astc.bin.gz': 'assets/crew/continuum/andean-female/albedo.astc.bin.gz',
  }),
});

const crewUnit16 = (v) => Math.max(0, Math.min(65535, Math.round(v * 65535)));
const crewUnit8 = (v) => Math.max(0, Math.min(255, Math.round(v * 255)));
// Octahedral normal, so two 16-bit values hold a whole direction.
export function crewContinuumOctahedral([x, y, z]) {
  const length = Math.abs(x) + Math.abs(y) + Math.abs(z) || 1;
  let u = x / length, v = y / length;
  if (z / length < 0) { const a = u; u = (1 - Math.abs(v)) * (a >= 0 ? 1 : -1); v = (1 - Math.abs(a)) * (v >= 0 ? 1 : -1); }
  return [u * 0.5 + 0.5, v * 0.5 + 0.5];
}
// Four weights as bytes that sum to exactly 255, the largest taking what rounding leaves.
export function crewContinuumWeightBytes(weights) {
  const sum = weights.reduce((s, w) => s + Math.max(0, w), 0) || 1;
  const bytes = weights.map((w) => Math.round((Math.max(0, w) / sum) * 255));
  let largest = 0;
  for (let k = 1; k < 4; k++) if (weights[k] > weights[largest]) largest = k;
  bytes[largest] += 255 - bytes.reduce((s, b) => s + b, 0);
  return bytes;
}
// One vertex as six 32-bit words. `uv` for a textured cluster vertex, `colour` (linear) for a far-body vertex.
export function packCrewContinuumVertex({ position, normal, uv = null, colour = null, joints, weights, part, region }, { low, posScale, uvLow = [0, 0], uvScale = [1, 1] }) {
  const p = position.map((v, a) => crewUnit16((v - low[a]) / posScale)), n = crewContinuumOctahedral(normal), w = crewContinuumWeightBytes(weights);
  if (joints.some((j) => !(j >= 0 && j < CREW_JOINT_COUNT))) throw Error('A crew vertex names a joint the skeleton lacks');
  const surface = colour
    ? (crewUnit8(Math.sqrt(colour[0])) | (crewUnit8(Math.sqrt(colour[1])) << 8) | (crewUnit8(Math.sqrt(colour[2])) << 16)) >>> 0
    : (crewUnit16((uv[0] - uvLow[0]) / uvScale[0]) | (crewUnit16((uv[1] - uvLow[1]) / uvScale[1]) << 16)) >>> 0;
  return [
    (p[0] | (p[1] << 16)) >>> 0,
    (p[2] | ((part & 255) << 16) | ((region & 255) << 24)) >>> 0,
    (crewUnit16(n[0]) | (crewUnit16(n[1]) << 16)) >>> 0,
    surface,
    (joints[0] | (joints[1] << 8) | (joints[2] << 16) | (joints[3] << 24)) >>> 0,
    (w[0] | (w[1] << 8) | (w[2] << 16) | (w[3] << 24)) >>> 0,
  ];
}
// The inverse, for tests and the bake's own checks.
export function unpackCrewContinuumVertex(words, at, { low, posScale, uvLow = [0, 0], uvScale = [1, 1] }) {
  const w = (k) => words[at * CREW_CONTINUUM_VERTEX_WORDS + k];
  const q = [w(0) & 65535, w(0) >>> 16, w(1) & 65535];
  return {
    position: q.map((v, a) => low[a] + (v / 65535) * posScale),
    part: (w(1) >>> 16) & 255, region: w(1) >>> 24,
    uv: [uvLow[0] + ((w(3) & 65535) / 65535) * uvScale[0], uvLow[1] + ((w(3) >>> 16) / 65535) * uvScale[1]],
    colour: [w(3) & 255, (w(3) >>> 8) & 255, (w(3) >>> 16) & 255].map((v) => (v / 255) ** 2),
    joints: [w(4) & 255, (w(4) >>> 8) & 255, (w(4) >>> 16) & 255, w(4) >>> 24],
    weights: [w(5) & 255, (w(5) >>> 8) & 255, (w(5) >>> 16) & 255, w(5) >>> 24].map((v) => v / 255),
  };
}

// One cluster as twenty words. Each sphere is held in its joint's bind space and is posed on the GPU by that joint,
// with its radius grown by how far the cluster's points stray from that joint's motion in any pose the body takes.
export function packCrewContinuumCluster({ lod, parentLod, cull, error, parentError, first, triangles, ownJoint, parentJoint, cullJoint, part, level }) {
  const words = new ArrayBuffer(CREW_CONTINUUM_CLUSTER_WORDS * 4), f = new Float32Array(words), u = new Uint32Array(words);
  f.set(lod, 0); f.set(parentLod, 4); f.set(cull, 8);
  f[12] = error; f[13] = Math.min(parentError, 1e30);
  u[14] = first; u[15] = triangles;
  u[16] = (ownJoint | (parentJoint << 8) | (cullJoint << 16) | (part << 24)) >>> 0;
  u[17] = level;
  return u;
}

export function validateCrewContinuumManifest(manifest) {
  if (manifest?.format !== CREW_CONTINUUM_FORMAT || manifest.version !== CREW_CONTINUUM_VERSION || manifest.vertexWords !== CREW_CONTINUUM_VERTEX_WORDS || manifest.clusterWords !== CREW_CONTINUUM_CLUSTER_WORDS || manifest.stepWords !== CREW_CONTINUUM_STEP_WORDS) throw Error('Invalid crew continuum manifest');
  if (!CREW_CONTINUUM_BODIES.some((b) => b.id === manifest.id)) throw Error(`Unknown crew continuum body: ${manifest.id}`);
  const { vertexCount, indexCount, clusterCount, chain, splat, texture, files } = manifest;
  if (!(vertexCount > 0) || !(indexCount > 0) || indexCount % 3 || !(clusterCount > 0)) throw Error(`Crew continuum counts are malformed: ${manifest.id}`);
  if (!(chain?.vertexCount > 0 && chain.vertexCount < CREW_CONTINUUM_NEVER) || !(chain.triangleCount >= 4) || !(chain.stepCount >= 1 && chain.stepCount < CREW_CONTINUUM_NEVER)) throw Error(`Crew continuum far body is malformed: ${manifest.id}`);
  const { vertices, records, indices, steps } = chain.offsets ?? {};
  if (vertices !== 0 || records !== chain.vertexCount * CREW_CONTINUUM_VERTEX_WORDS || indices !== records + chain.vertexCount || steps !== indices + chain.triangleCount * 3 || files?.['chain.bin']?.bytes !== (steps + (chain.stepCount + 1) * CREW_CONTINUUM_STEP_WORDS) * 4) throw Error(`Crew continuum far body layout is malformed: ${manifest.id}`);
  if (!splat || splat.centre?.length !== 3 || !(splat.rx > 0) || !(splat.ry > 0) || !(splat.joint >= 0 && splat.joint < CREW_JOINT_COUNT) || splat.regions?.length !== CREW_CONTINUUM_REGIONS.length) throw Error(`Crew continuum splat is malformed: ${manifest.id}`);
  if (!(texture?.width > 0) || !(texture.levels?.length > 0)) throw Error(`Crew continuum texture is malformed: ${manifest.id}`);
  if (files?.['vertices.bin']?.bytes !== vertexCount * CREW_CONTINUUM_VERTEX_WORDS * 4 || files?.['indices.bin']?.bytes !== indexCount * 4 || files?.['clusters.bin']?.bytes !== clusterCount * CREW_CONTINUUM_CLUSTER_WORDS * 4) throw Error(`Crew continuum stream sizes disagree: ${manifest.id}`);
  for (const name of CREW_CONTINUUM_STREAMS) if (!files?.[name]?.gzip?.file || !/^[0-9a-f]{64}$/.test(files[name].sha256 ?? '')) throw Error(`Crew continuum stream missing: ${manifest.id} ${name}`);
  return manifest;
}

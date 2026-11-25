// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// People in the one continuum (AGENTS.md rule 3). Each high-detail body, fitted to the crew skeleton by
// scripts/fit-crew-body.py, is baked by scripts/prepare-crew-continuum.mjs through the one bake (js/continuum-bake.js)
// into an atlas of the one format (js/continuum-format.js): its clusters, far body and splat, every point carrying its
// skin (the skin stream) and its picture's place (the UV stream). A person is a record of the SKINNED kind
// (js/wgsl/continuum-kinds.js), stood with the crew's own joints by js/wgsl/crew-continuum.js, cut by the one select
// and shaded by the crew's material; this module holds only the family's data.
import { CONTINUUM_ATLAS_VERSION, CONTINUUM_HEADER_WORDS, CONTINUUM_NEVER } from './continuum-format.js';
import { CREW_JOINT_NAMES, CREW_JOINT_PARENTS, CREW_JOINT_COUNT } from './crew-skeleton.js';

export const CREW_CONTINUUM_FORMAT = 'waterworld.crew-continuum';
export const CREW_CONTINUUM_VERSION = CONTINUUM_ATLAS_VERSION;

// A body is clustered in pieces, each a run of the skeleton from its root down to the next piece's: the trunk in two,
// the neck, the head, and each limb by its segments (where a ball takes a forearm, a shin or the head, js/crew-wounds.js
// CREW_LIMB_JOINTS, a piece begins). No simplified triangle spans two pieces, and each piece's clusters ride the joint
// its points weigh on most.
export const CREW_CONTINUUM_PIECES = Object.freeze([
  'pelvis', 'spine_03', 'neck_01', 'head', 'clavicle_l', 'upperarm_l', 'lowerarm_l', 'hand_l', 'clavicle_r', 'upperarm_r', 'lowerarm_r', 'hand_r',
  'thigh_l', 'calf_l', 'foot_l', 'thigh_r', 'calf_r', 'foot_r',
]);
// Each joint's piece: the nearest piece root at or above it (the root itself goes with the pelvis).
export const CREW_CONTINUUM_JOINT_PIECE = Object.freeze(CREW_JOINT_NAMES.map((name, slot) => {
  for (let at = slot; at >= 0; at = CREW_JOINT_PARENTS[at]) {
    const piece = CREW_CONTINUUM_PIECES.indexOf(CREW_JOINT_NAMES[at]);
    if (piece >= 0) return piece;
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
// The baked streams of each body, by file: its atlas (one type of the one format) and its picture in each codec. A
// body is fetched only when a scene first has someone to wear it.
export const CREW_CONTINUUM_STREAMS = Object.freeze(['atlas.bin', 'albedo.bc7.bin', 'albedo.astc.bin']);
// Every file of every body, by body and file name, for loading and for build.mjs to publish. The streams are
// written by scripts/prepare-crew-continuum.mjs and kept out of git; only the manifests are committed. Spelled out,
// not composed, because the build publishes (and versions) only the asset paths it finds quoted in the source; the
// bake test holds this table to CREW_CONTINUUM_BODIES and CREW_CONTINUUM_STREAMS.
export const CREW_CONTINUUM_ASSETS = Object.freeze({
  'sailor-male': Object.freeze({
    'manifest.json': 'assets/crew/continuum/sailor-male/manifest.json',
    'body.glb': 'assets/crew/continuum/sailor-male/body.glb',
    'atlas.bin.gz': 'assets/crew/continuum/sailor-male/atlas.bin.gz',
    'albedo.bc7.bin.gz': 'assets/crew/continuum/sailor-male/albedo.bc7.bin.gz',
    'albedo.astc.bin.gz': 'assets/crew/continuum/sailor-male/albedo.astc.bin.gz',
  }),
  'villager-female': Object.freeze({
    'manifest.json': 'assets/crew/continuum/villager-female/manifest.json',
    'body.glb': 'assets/crew/continuum/villager-female/body.glb',
    'atlas.bin.gz': 'assets/crew/continuum/villager-female/atlas.bin.gz',
    'albedo.bc7.bin.gz': 'assets/crew/continuum/villager-female/albedo.bc7.bin.gz',
    'albedo.astc.bin.gz': 'assets/crew/continuum/villager-female/albedo.astc.bin.gz',
  }),
  'captain': Object.freeze({
    'manifest.json': 'assets/crew/continuum/captain/manifest.json',
    'body.glb': 'assets/crew/continuum/captain/body.glb',
    'atlas.bin.gz': 'assets/crew/continuum/captain/atlas.bin.gz',
    'albedo.bc7.bin.gz': 'assets/crew/continuum/captain/albedo.bc7.bin.gz',
    'albedo.astc.bin.gz': 'assets/crew/continuum/captain/albedo.astc.bin.gz',
  }),
  'soldier': Object.freeze({
    'manifest.json': 'assets/crew/continuum/soldier/manifest.json',
    'body.glb': 'assets/crew/continuum/soldier/body.glb',
    'atlas.bin.gz': 'assets/crew/continuum/soldier/atlas.bin.gz',
    'albedo.bc7.bin.gz': 'assets/crew/continuum/soldier/albedo.bc7.bin.gz',
    'albedo.astc.bin.gz': 'assets/crew/continuum/soldier/albedo.astc.bin.gz',
  }),
  'algonquian-male': Object.freeze({
    'manifest.json': 'assets/crew/continuum/algonquian-male/manifest.json',
    'body.glb': 'assets/crew/continuum/algonquian-male/body.glb',
    'atlas.bin.gz': 'assets/crew/continuum/algonquian-male/atlas.bin.gz',
    'albedo.bc7.bin.gz': 'assets/crew/continuum/algonquian-male/albedo.bc7.bin.gz',
    'albedo.astc.bin.gz': 'assets/crew/continuum/algonquian-male/albedo.astc.bin.gz',
  }),
  'algonquian-female': Object.freeze({
    'manifest.json': 'assets/crew/continuum/algonquian-female/manifest.json',
    'body.glb': 'assets/crew/continuum/algonquian-female/body.glb',
    'atlas.bin.gz': 'assets/crew/continuum/algonquian-female/atlas.bin.gz',
    'albedo.bc7.bin.gz': 'assets/crew/continuum/algonquian-female/albedo.bc7.bin.gz',
    'albedo.astc.bin.gz': 'assets/crew/continuum/algonquian-female/albedo.astc.bin.gz',
  }),
  'caribbean-male': Object.freeze({
    'manifest.json': 'assets/crew/continuum/caribbean-male/manifest.json',
    'body.glb': 'assets/crew/continuum/caribbean-male/body.glb',
    'atlas.bin.gz': 'assets/crew/continuum/caribbean-male/atlas.bin.gz',
    'albedo.bc7.bin.gz': 'assets/crew/continuum/caribbean-male/albedo.bc7.bin.gz',
    'albedo.astc.bin.gz': 'assets/crew/continuum/caribbean-male/albedo.astc.bin.gz',
  }),
  'caribbean-female': Object.freeze({
    'manifest.json': 'assets/crew/continuum/caribbean-female/manifest.json',
    'body.glb': 'assets/crew/continuum/caribbean-female/body.glb',
    'atlas.bin.gz': 'assets/crew/continuum/caribbean-female/atlas.bin.gz',
    'albedo.bc7.bin.gz': 'assets/crew/continuum/caribbean-female/albedo.bc7.bin.gz',
    'albedo.astc.bin.gz': 'assets/crew/continuum/caribbean-female/albedo.astc.bin.gz',
  }),
  'maya-male': Object.freeze({
    'manifest.json': 'assets/crew/continuum/maya-male/manifest.json',
    'body.glb': 'assets/crew/continuum/maya-male/body.glb',
    'atlas.bin.gz': 'assets/crew/continuum/maya-male/atlas.bin.gz',
    'albedo.bc7.bin.gz': 'assets/crew/continuum/maya-male/albedo.bc7.bin.gz',
    'albedo.astc.bin.gz': 'assets/crew/continuum/maya-male/albedo.astc.bin.gz',
  }),
  'maya-female': Object.freeze({
    'manifest.json': 'assets/crew/continuum/maya-female/manifest.json',
    'body.glb': 'assets/crew/continuum/maya-female/body.glb',
    'atlas.bin.gz': 'assets/crew/continuum/maya-female/atlas.bin.gz',
    'albedo.bc7.bin.gz': 'assets/crew/continuum/maya-female/albedo.bc7.bin.gz',
    'albedo.astc.bin.gz': 'assets/crew/continuum/maya-female/albedo.astc.bin.gz',
  }),
  'andean-male': Object.freeze({
    'manifest.json': 'assets/crew/continuum/andean-male/manifest.json',
    'body.glb': 'assets/crew/continuum/andean-male/body.glb',
    'atlas.bin.gz': 'assets/crew/continuum/andean-male/atlas.bin.gz',
    'albedo.bc7.bin.gz': 'assets/crew/continuum/andean-male/albedo.bc7.bin.gz',
    'albedo.astc.bin.gz': 'assets/crew/continuum/andean-male/albedo.astc.bin.gz',
  }),
  'andean-female': Object.freeze({
    'manifest.json': 'assets/crew/continuum/andean-female/manifest.json',
    'body.glb': 'assets/crew/continuum/andean-female/body.glb',
    'atlas.bin.gz': 'assets/crew/continuum/andean-female/atlas.bin.gz',
    'albedo.bc7.bin.gz': 'assets/crew/continuum/andean-female/albedo.bc7.bin.gz',
    'albedo.astc.bin.gz': 'assets/crew/continuum/andean-female/albedo.astc.bin.gz',
  }),
});
// Compact mobile crew continuum packs (scripts/prepare-mobile-continuum.mjs): pruned cluster depth (~25k-50k tris) and
// 1024x1024 compressed albedo mip chains (~3-5 MiB VRAM per body instead of ~98 MiB) so iOS Safari never hits Jetsam
// when multiple crew bodies load simultaneously. Shares the light rig mesh body.glb with the desktop pack.
export const CREW_CONTINUUM_MOBILE_ASSETS = Object.freeze({
  'sailor-male': Object.freeze({
    'manifest.json': 'assets/mobile-continuum/crew/sailor-male/manifest.json',
    'body.glb': 'assets/crew/continuum/sailor-male/body.glb',
    'atlas.bin.gz': 'assets/mobile-continuum/crew/sailor-male/atlas.bin.gz',
    'albedo.bc7.bin.gz': 'assets/mobile-continuum/crew/sailor-male/albedo.bc7.bin.gz',
    'albedo.astc.bin.gz': 'assets/mobile-continuum/crew/sailor-male/albedo.astc.bin.gz',
  }),
  'villager-female': Object.freeze({
    'manifest.json': 'assets/mobile-continuum/crew/villager-female/manifest.json',
    'body.glb': 'assets/crew/continuum/villager-female/body.glb',
    'atlas.bin.gz': 'assets/mobile-continuum/crew/villager-female/atlas.bin.gz',
    'albedo.bc7.bin.gz': 'assets/mobile-continuum/crew/villager-female/albedo.bc7.bin.gz',
    'albedo.astc.bin.gz': 'assets/mobile-continuum/crew/villager-female/albedo.astc.bin.gz',
  }),
  'captain': Object.freeze({
    'manifest.json': 'assets/mobile-continuum/crew/captain/manifest.json',
    'body.glb': 'assets/crew/continuum/captain/body.glb',
    'atlas.bin.gz': 'assets/mobile-continuum/crew/captain/atlas.bin.gz',
    'albedo.bc7.bin.gz': 'assets/mobile-continuum/crew/captain/albedo.bc7.bin.gz',
    'albedo.astc.bin.gz': 'assets/mobile-continuum/crew/captain/albedo.astc.bin.gz',
  }),
  'soldier': Object.freeze({
    'manifest.json': 'assets/mobile-continuum/crew/soldier/manifest.json',
    'body.glb': 'assets/crew/continuum/soldier/body.glb',
    'atlas.bin.gz': 'assets/mobile-continuum/crew/soldier/atlas.bin.gz',
    'albedo.bc7.bin.gz': 'assets/mobile-continuum/crew/soldier/albedo.bc7.bin.gz',
    'albedo.astc.bin.gz': 'assets/mobile-continuum/crew/soldier/albedo.astc.bin.gz',
  }),
  'algonquian-male': Object.freeze({
    'manifest.json': 'assets/mobile-continuum/crew/algonquian-male/manifest.json',
    'body.glb': 'assets/crew/continuum/algonquian-male/body.glb',
    'atlas.bin.gz': 'assets/mobile-continuum/crew/algonquian-male/atlas.bin.gz',
    'albedo.bc7.bin.gz': 'assets/mobile-continuum/crew/algonquian-male/albedo.bc7.bin.gz',
    'albedo.astc.bin.gz': 'assets/mobile-continuum/crew/algonquian-male/albedo.astc.bin.gz',
  }),
  'algonquian-female': Object.freeze({
    'manifest.json': 'assets/mobile-continuum/crew/algonquian-female/manifest.json',
    'body.glb': 'assets/crew/continuum/algonquian-female/body.glb',
    'atlas.bin.gz': 'assets/mobile-continuum/crew/algonquian-female/atlas.bin.gz',
    'albedo.bc7.bin.gz': 'assets/mobile-continuum/crew/algonquian-female/albedo.bc7.bin.gz',
    'albedo.astc.bin.gz': 'assets/mobile-continuum/crew/algonquian-female/albedo.astc.bin.gz',
  }),
  'caribbean-male': Object.freeze({
    'manifest.json': 'assets/mobile-continuum/crew/caribbean-male/manifest.json',
    'body.glb': 'assets/crew/continuum/caribbean-male/body.glb',
    'atlas.bin.gz': 'assets/mobile-continuum/crew/caribbean-male/atlas.bin.gz',
    'albedo.bc7.bin.gz': 'assets/mobile-continuum/crew/caribbean-male/albedo.bc7.bin.gz',
    'albedo.astc.bin.gz': 'assets/mobile-continuum/crew/caribbean-male/albedo.astc.bin.gz',
  }),
  'caribbean-female': Object.freeze({
    'manifest.json': 'assets/mobile-continuum/crew/caribbean-female/manifest.json',
    'body.glb': 'assets/crew/continuum/caribbean-female/body.glb',
    'atlas.bin.gz': 'assets/mobile-continuum/crew/caribbean-female/atlas.bin.gz',
    'albedo.bc7.bin.gz': 'assets/mobile-continuum/crew/caribbean-female/albedo.bc7.bin.gz',
    'albedo.astc.bin.gz': 'assets/mobile-continuum/crew/caribbean-female/albedo.astc.bin.gz',
  }),
  'maya-male': Object.freeze({
    'manifest.json': 'assets/mobile-continuum/crew/maya-male/manifest.json',
    'body.glb': 'assets/crew/continuum/maya-male/body.glb',
    'atlas.bin.gz': 'assets/mobile-continuum/crew/maya-male/atlas.bin.gz',
    'albedo.bc7.bin.gz': 'assets/mobile-continuum/crew/maya-male/albedo.bc7.bin.gz',
    'albedo.astc.bin.gz': 'assets/mobile-continuum/crew/maya-male/albedo.astc.bin.gz',
  }),
  'maya-female': Object.freeze({
    'manifest.json': 'assets/mobile-continuum/crew/maya-female/manifest.json',
    'body.glb': 'assets/crew/continuum/maya-female/body.glb',
    'atlas.bin.gz': 'assets/mobile-continuum/crew/maya-female/atlas.bin.gz',
    'albedo.bc7.bin.gz': 'assets/mobile-continuum/crew/maya-female/albedo.bc7.bin.gz',
    'albedo.astc.bin.gz': 'assets/mobile-continuum/crew/maya-female/albedo.astc.bin.gz',
  }),
  'andean-male': Object.freeze({
    'manifest.json': 'assets/mobile-continuum/crew/andean-male/manifest.json',
    'body.glb': 'assets/crew/continuum/andean-male/body.glb',
    'atlas.bin.gz': 'assets/mobile-continuum/crew/andean-male/atlas.bin.gz',
    'albedo.bc7.bin.gz': 'assets/mobile-continuum/crew/andean-male/albedo.bc7.bin.gz',
    'albedo.astc.bin.gz': 'assets/mobile-continuum/crew/andean-male/albedo.astc.bin.gz',
  }),
  'andean-female': Object.freeze({
    'manifest.json': 'assets/mobile-continuum/crew/andean-female/manifest.json',
    'body.glb': 'assets/crew/continuum/andean-female/body.glb',
    'atlas.bin.gz': 'assets/mobile-continuum/crew/andean-female/atlas.bin.gz',
    'albedo.bc7.bin.gz': 'assets/mobile-continuum/crew/andean-female/albedo.bc7.bin.gz',
    'albedo.astc.bin.gz': 'assets/mobile-continuum/crew/andean-female/albedo.astc.bin.gz',
  }),
});
// People are drawn through the continuum alone: there are no old bodies to stand in. A body that is not baked is an
// error, for the build (build.mjs) and at load (js/crew-continuum-draw.js), and this says which files are missing,
// by body, and how they are made. `missing` holds paths from CREW_CONTINUUM_ASSETS.
export function crewContinuumMissingMessage(missing) {
  const ids = Object.keys(CREW_CONTINUUM_ASSETS).filter((id) => Object.values(CREW_CONTINUUM_ASSETS[id]).some((file) => missing.includes(file)));
  return `Crew continuum bodies not baked (${ids.join(', ')}); people are drawn through the continuum alone. Missing:\n  ${missing.join('\n  ')}\n`
    + `Bake each with \`node scripts/prepare-crew-continuum.mjs --only=<body> --fits=<absolute path of .tripo/1550-hd/fit-regions>\` from its fit`
    + ` (scripts/fit-crew-body.py --textured --full-texture), or copy a baked assets/crew/continuum/ into this checkout.`;
}

// A body's rig as its stand reads it (js/wgsl/crew-continuum.js), CREW_CONTINUUM_RIG_VEC4S vec4f: [joints, pose slack,
// 0, 0], then the sphere about each joint's points at rest (a radius below 0: a joint that carries none).
export const CREW_CONTINUUM_RIG_VEC4S = 1 + CREW_JOINT_COUNT;
export function crewContinuumRig(manifest) {
  const table = new Float32Array(CREW_CONTINUUM_RIG_VEC4S * 4);
  table.set([CREW_JOINT_COUNT, manifest.rig.slack, 0, 0], 0);
  manifest.rig.spheres.forEach((sphere, j) => table.set(sphere, (1 + j) * 4));
  return table;
}
// What a body's material reads of it (js/wgsl/crew-continuum.js crewWear), CREW_CONTINUUM_WEAR_VEC4S vec4f: each
// region's median colour (w 1 where the body has any of it), then each region's mean colour on the splat and its
// share of the splat's outline (w).
export const CREW_CONTINUUM_WEAR_VEC4S = CREW_CONTINUUM_REGIONS.length * 2;
export function crewContinuumWear(manifest) {
  const table = new Float32Array(CREW_CONTINUUM_WEAR_VEC4S * 4);
  CREW_CONTINUUM_REGIONS.forEach((_, r) => {
    const median = manifest.regionMedians[r], region = manifest.splat.regions[r];
    table.set(median ? [...median, 1] : [0.5, 0.5, 0.5, 0], r * 4);
    table.set([...(region.mean ?? [0, 0, 0]), region.share], (CREW_CONTINUUM_REGIONS.length + r) * 4);
  });
  return table;
}

export function validateCrewContinuumManifest(manifest) {
  if (manifest?.format !== CREW_CONTINUUM_FORMAT || manifest.version !== CREW_CONTINUUM_VERSION) throw Error('Invalid crew continuum manifest: rebake it');
  if (!CREW_CONTINUUM_BODIES.some((b) => b.id === manifest.id)) throw Error(`Unknown crew continuum body: ${manifest.id}`);
  const { atlas, rig, clusters, chain, splat, texture, files } = manifest;
  if (!(atlas?.words > CONTINUUM_HEADER_WORDS) || atlas.bytes !== atlas.words * 4 || files?.['atlas.bin']?.bytes !== atlas.bytes) throw Error(`Crew continuum atlas is malformed: ${manifest.id}`);
  if (!(clusters?.count > 0) || !(chain?.baseTriangles >= 4) || !(chain.steps >= 1 && chain.steps < CONTINUUM_NEVER)) throw Error(`Crew continuum body is incomplete: ${manifest.id}`);
  if (rig?.joints !== CREW_JOINT_COUNT || !(rig.slack >= 0) || rig.spheres?.length !== CREW_JOINT_COUNT || rig.spheres.some((s) => s?.length !== 4)) throw Error(`Crew continuum rig is malformed: ${manifest.id}`);
  if (!splat || splat.centre?.length !== 3 || !(splat.rx > 0) || !(splat.ry > 0) || splat.regions?.length !== CREW_CONTINUUM_REGIONS.length) throw Error(`Crew continuum splat is malformed: ${manifest.id}`);
  if (manifest.regionMedians?.length !== CREW_CONTINUUM_REGIONS.length) throw Error(`Crew continuum regions are malformed: ${manifest.id}`);
  if (!(texture?.width > 0) || !(texture.levels?.length > 0)) throw Error(`Crew continuum texture is malformed: ${manifest.id}`);
  for (const name of CREW_CONTINUUM_STREAMS) if (!files?.[name]?.gzip?.file || !/^[0-9a-f]{64}$/.test(files[name].sha256 ?? '')) throw Error(`Crew continuum stream missing: ${manifest.id} ${name}`);
  return manifest;
}

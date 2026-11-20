// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Every animal in the one continuum (AGENTS.md rule 3): the herds' sheep, cattle, swine and horses, the road's wains,
// coaches and ox-carts, and the sea's dolphins, sharks and whale. scripts/prepare-animal-continuum.mjs bakes each type
// from the mesh its builder makes by the one bake (js/continuum-bake.js) into one atlas of the one format
// (js/continuum-format.js); each is placed by a record of the one format and posed by the SKINNED kind
// (js/wgsl/continuum-kinds.js): every point carries its skin (up to four of its type's joints and their weights), and
// its family's compute pass writes each instance's joint palette (js/wgsl/herds.js for the herds, js/wgsl/dolphins.js
// for the sea), so clusters, far body and splat are posed on the GPU as the full mesh is.
import { CONTINUUM_ATLAS_VERSION, CONTINUUM_HEADER_WORDS, CONTINUUM_NEVER, CONTINUUM_TYPE, loadContinuumAtlas } from './continuum-format.js';

export const ANIMAL_CONTINUUM_FORMAT = 'waterworld.animal-continuum';
export const ANIMAL_CONTINUUM_VERSION = CONTINUUM_ATLAS_VERSION;

// The catalogue. A herd's species is its type; the sea's animals follow.
export const ANIMAL_CONTINUUM_TYPES = Object.freeze(['sheep', 'cattle', 'swine', 'horse', 'wain', 'coach', 'ox cart', 'dolphin', 'shark', 'whale']);
export const ANIMAL_TYPE = Object.freeze({ sheep: 0, cattle: 1, swine: 2, horse: 3, wain: 4, coach: 5, oxCart: 6, dolphin: 7, shark: 8, whale: 9 });
// How a type is jointed and worn: a herd beast (its coat), a road vehicle (its coat; a joint a shard), a sea animal
// bent by its stroke (its colour), the whale (its colour and its texture's place).
export const ANIMAL_FAMILY = Object.freeze({ livestock: 0, vehicle: 1, sea: 2, whale: 3 });
// The herd rig's largest downward neck-and-head pitch while grazing, by species (radians).
export const ANIMAL_CONTINUUM_GRAZE_PITCH = Object.freeze([0.52, 0.44, 0.28, 0.40, 0, 0, 0]);

// The joints. A herd beast: its body, neck, four legs, the four feet each leg lifts, its tail, its saddle and its
// bridle (both gathered to nothing on a beast without tack). A road vehicle: a joint a shard it breaks into (wheels
// 0..3 by side and axle, the pole 4, the body's pieces from 8), each riding its own flight once shattered. A dolphin or
// shark: ANIMAL_SEA_STATIONS stations along its spine, bent by its stroke. The whale: its rig's own bones.
export const ANIMAL_JOINT = Object.freeze({ body: 0, neck: 1, leg: 2, foot: 6, tail: 10, saddle: 11, bridle: 12 });
export const ANIMAL_FAMILY_JOINTS = Object.freeze([13, 32, 6, 18]);
export const ANIMAL_SEA_STATIONS = 6;
// The most joints a type has, and so the pose data each instance takes in its scene's pose buffer (vec4f;
// js/wgsl/skinned-pose.js skinnedPoseVec4s).
export const ANIMAL_POSE_JOINTS = 32;
export const ANIMAL_POSE_VEC4S = 1 + ANIMAL_POSE_JOINTS * 4;

// A type's material block (the last words of its type record): its family, its height (a herd type's legs.w), and its
// splat's linear colour (-1 for a beast coated by zones, whose rule the GPU follows).
export const ANIMAL_CONTINUUM_MATERIAL = Object.freeze({ family: CONTINUUM_TYPE.material, height: CONTINUUM_TYPE.material + 1, colour: CONTINUUM_TYPE.material + 2 });

// Each type's rig, as its family's pass reads it, ANIMAL_RIG_VEC4S vec4f a type: the herd rig's neck (pivot, graze
// pitch) and legs (legY, frontZ, backZ, height), [joints, pose slack, family, spine length], then the sphere about each
// joint's points at rest (a radius below 0: a joint with none).
export const ANIMAL_RIG_VEC4S = 3 + ANIMAL_POSE_JOINTS;
export function animalRigTable(manifest) {
  const table = new Float32Array(manifest.types.length * ANIMAL_RIG_VEC4S * 4);
  manifest.types.forEach((type, id) => {
    const at = id * ANIMAL_RIG_VEC4S * 4, { rig } = type;
    table.set([...rig.neck, ...rig.legs, rig.joints, rig.slack, ANIMAL_FAMILY[type.family], rig.spine ?? 0], at);
    for (let j = 0; j < ANIMAL_POSE_JOINTS; j++) table.set(rig.spheres[j] ?? [0, 0, 0, -1], at + (3 + j) * 4);
  });
  return table;
}

// The baked atlas and its manifest. Spelled out, not composed, because the build publishes (and versions) only the
// asset paths it finds quoted in the source. Both are kept in git: every animal is drawn from nothing else.
export const ANIMAL_CONTINUUM_ASSETS = Object.freeze({
  'manifest.json': 'assets/animal-continuum/manifest.json',
  'atlas.bin.gz': 'assets/animal-continuum/atlas.bin.gz',
});
// High-resolution Tripo H3.1 livestock basecolor textures (0=sheep, 1=cattle, 2=swine, 3=horse),
// spelled out literally so build.mjs publishes and versions every file.
export const LIVESTOCK_TEXTURE_ASSETS = Object.freeze([
  'assets/animal-continuum/livestock-sheep.jpg',
  'assets/animal-continuum/livestock-cattle.jpg',
  'assets/animal-continuum/livestock-swine.jpg',
  'assets/animal-continuum/livestock-horse.jpg',
]);

export function validateAnimalContinuumManifest(manifest) {
  if (manifest?.format !== ANIMAL_CONTINUUM_FORMAT || manifest.version !== ANIMAL_CONTINUUM_VERSION) throw Error('Invalid animal continuum manifest: rebake it');
  const { types, atlas } = manifest;
  if (!Array.isArray(types) || types.length !== ANIMAL_CONTINUUM_TYPES.length) throw Error('The animal continuum does not hold every type');
  types.forEach((type, id) => {
    if (type.id !== id || type.name !== ANIMAL_CONTINUUM_TYPES[id] || !/^[0-9a-f]{64}$/.test(type.fingerprint ?? '')) throw Error(`Animal continuum type ${id} is malformed`);
    if (!(type.clusters?.count > 0) || !(type.chain?.baseTriangles >= 4) || !(type.chain.steps >= 1 && type.chain.steps < CONTINUUM_NEVER)) throw Error(`Animal continuum type ${id} is incomplete`);
    const { rig } = type;
    if (!(type.family in ANIMAL_FAMILY) || rig?.joints !== ANIMAL_FAMILY_JOINTS[ANIMAL_FAMILY[type.family]] || !(rig.slack >= 0) || rig.spheres?.length !== rig.joints) throw Error(`Animal continuum type ${id} has no rig`);
  });
  if (!(atlas?.words > CONTINUUM_HEADER_WORDS) || atlas.bytes !== atlas.words * 4 || !/^[0-9a-f]{64}$/.test(atlas.sha256 ?? '') || !atlas.gzip?.file) throw Error('The animal continuum atlas is malformed');
  return manifest;
}

// The atlas, fetched, unpacked and checked against its receipt and the cut. Resolves to { manifest, words }.
export function loadAnimalContinuum({ fetchAsset = fetch } = {}) {
  return loadContinuumAtlas({ assets: ANIMAL_CONTINUUM_ASSETS, validate: validateAnimalContinuumManifest, label: 'animal', fetchAsset });
}

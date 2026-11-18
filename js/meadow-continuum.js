// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Meadow grass in the one continuum (AGENTS.md rule 3). Each 4 m sward of a pack of meadow groves (the Portuguese:
// forestmodeler's cocksfoot, wild oat, ripgut brome and ribwort plantain; the tropical: native Caribbean grasses from
// scripts/prepare-tropical-sward.mjs; plant by plant at full resolution) is baked by scripts/prepare-meadow-grass.mjs
// into one type of an atlas of the one format (js/continuum-format.js): a cluster hierarchy cut by projected error,
// whose coarser levels keep fewer organs of every plant and widen the kept ones to cover what the whole plant did; a
// closed canopy body over the patch, carrying the share of ground the sward lets the eye see, that collapses one
// half-edge at a time down to a few triangles; and a single splat. A meadow is these patches laid edge to edge on the
// ground, each a record of the one cut, draped over the ground and swayed by the WIND kind (js/wgsl/continuum-wind.js);
// js/wgsl/meadow-continuum.js stands them and wears them. This is what a patch puts in the atlas:
//   a vertex   high: how far along its stalk it stands (8 bits) | its stiffness (4 bits, MEADOW_CONTINUUM_STIFFNESS_UNIT) |
//              its clump's hash (4 bits); word: its colour (each channel's square root, 8 bits); the wind stream its
//              sway weight and its clump's phase.
//   a far vertex    the wind stream: the sway weight of the sward at its height, and a phase by where it lies.
//   a far body's optical moments  its albedo the sward's colour, and the share of ground it hides from above
//              (scripts/prepare-meadow-grass.mjs, js/continuum-bake.js packFarOptics).
//   a type's material block  its colour from above and from the side (far words), the along its seen sward shows, its
//              cover from above, its canopy's height, its sway at full weight, its mix.
// Every type shares one quantization frame (its manifest's `frame`), so every patch drapes over the ground alike and two
// of any mix meet without a step.
import { CONTINUUM_ATLAS_VERSION, CONTINUUM_HEADER_WORDS, CONTINUUM_NEVER, CONTINUUM_TYPE, continuumFloatWord, packContinuumBody, loadContinuumAtlas } from './continuum-format.js';

export const MEADOW_CONTINUUM_FORMAT = 'waterworld.meadow-continuum';
export const MEADOW_CONTINUUM_VERSION = CONTINUUM_ATLAS_VERSION;
// The side of one patch, in metres: the source's own tile.
export const MEADOW_PATCH_METRES = 4;
// Where a canopy body's floor lies over the ground it stands on, in metres: a little clear of the land under it, so a
// collapse that folds a top onto the floor lays that face on the ground, never under it.
export const MEADOW_BODY_FLOOR = 0.02;
// Levels of the hierarchy inside a patch: cells 16 to a side at the finest, halving to one by the fifth; each level
// keeps half the organs of the one below.
export const MEADOW_CONTINUUM_LEVELS = 8;
export const MEADOW_CONTINUUM_CELLS = 16;
export const meadowContinuumCellsAt = (level) => MEADOW_CONTINUUM_CELLS >> Math.min(level, 4);
export const MEADOW_CONTINUUM_STIFFNESS_UNIT = 1.5;
// A type's material block (js/continuum-format.js CONTINUUM_TYPE.material).
export const MEADOW_CONTINUUM_MATERIAL = Object.freeze({
  top: CONTINUUM_TYPE.material, side: CONTINUUM_TYPE.material + 1, seenAlong: CONTINUUM_TYPE.material + 2, coverage: CONTINUUM_TYPE.material + 3,
  canopy: CONTINUUM_TYPE.material + 4, sway: CONTINUUM_TYPE.material + 5, mix: CONTINUUM_TYPE.material + 6,
});

// Each pack's baked atlas and its manifest. Spelled out, not composed, because the build publishes (and versions) only
// the asset paths it finds quoted in the source.
export const PORTUGAL_MEADOW_GRASS_ASSETS = Object.freeze({
  'manifest.json': 'assets/ground-cover/portugal/meadows-gpu/manifest.json',
  'atlas.bin.gz': 'assets/ground-cover/portugal/meadows-gpu/atlas.bin.gz',
});
export const TROPICAL_MEADOW_GRASS_ASSETS = Object.freeze({
  'manifest.json': 'assets/ground-cover/tropical/meadows-gpu/manifest.json',
  'atlas.bin.gz': 'assets/ground-cover/tropical/meadows-gpu/atlas.bin.gz',
});
// What each of a pack's three mixes is sown where (js/meadow-grass.js, buildMeadowCoverMap): the first on open
// lowland, the second on slopes, heights and scrub, the third on field margins or, for a pack that has one, the strand.
export const MEADOW_MIX_ROLES = Object.freeze(['lowland', 'upland', 'margin']);

const meadowUnit = (v, bits) => Math.max(0, Math.min((1 << bits) - 1, Math.round(Math.max(0, Math.min(1, v)) * ((1 << bits) - 1))));
// A linear colour as three square roots in a word's low 24 bits, and `top` (0 to 1) in its high 8.
export function meadowContinuumColourWord(colour, top = 0) {
  const root = colour.map((c) => Math.sqrt(Math.max(0, c)));
  return (meadowUnit(root[0], 8) | (meadowUnit(root[1], 8) << 8) | (meadowUnit(root[2], 8) << 16) | (meadowUnit(top, 8) << 24)) >>> 0;
}
// A sward vertex's material words.
export function meadowContinuumVertex({ colour, along, stiffness, clump }) {
  const stiff = Math.max(0, Math.min(15, Math.round(stiffness / MEADOW_CONTINUUM_STIFFNESS_UNIT)));
  return { high: (meadowUnit(along, 8) | (stiff << 8) | (Math.max(0, Math.min(15, Math.floor(clump * 16))) << 12)) >>> 0, word: meadowContinuumColourWord(colour) };
}
// How a patch is packed (js/continuum-format.js packContinuumBody). `high`, `word` and `wind` hold each welded sward
// vertex's words (meadowContinuumVertex, packContinuumWind); `farWind` each far vertex's wind word, so its canopy body
// sways as its sward does; `look` the type's { top, side,
// seenAlong, coverage, canopy, mix }; `sway` the metres its tips move at full gust strength; `frame` the quantization
// every patch shares.
export function packMeadowContinuumBody({ triangles, high, word, wind, farWind, look, sway, frame }, baked) {
  return packContinuumBody({
    triangles, frame,
    material: [meadowContinuumColourWord(look.top), meadowContinuumColourWord(look.side), continuumFloatWord(look.seenAlong), continuumFloatWord(look.coverage),
      continuumFloatWord(look.canopy), continuumFloatWord(sway), look.mix >>> 0],
    vertex: (v) => ({ high: high[v], word: word[v] }),
    streams: { wind: (v) => [wind[v]] },
    farStreams: { wind: (i) => [farWind[i]] },
  }, baked);
}

export function validateMeadowGrass(manifest) {
  if (manifest?.format !== MEADOW_CONTINUUM_FORMAT || manifest.version !== MEADOW_CONTINUUM_VERSION) throw Error('Invalid meadow continuum manifest: rebake it');
  if (manifest.patchMetres !== MEADOW_PATCH_METRES || manifest.levels !== MEADOW_CONTINUUM_LEVELS) throw Error('The meadow continuum has another patch or hierarchy');
  const { types, atlas, mixes } = manifest;
  if (!Array.isArray(mixes) || mixes.length !== MEADOW_MIX_ROLES.length) throw Error('The meadow continuum needs its three mixes');
  if (!Array.isArray(types) || types.length !== 12) throw Error('The meadow continuum needs its 12 variants');
  types.forEach((type, id) => {
    if (type.id !== id || !(type.mix >= 0 && type.mix < 3)) throw Error(`Meadow continuum variant ${id} is malformed`);
    if (!(type.clusters > 0) || !(type.chain?.baseTriangles >= 4) || !(type.chain.steps >= 1 && type.chain.steps < CONTINUUM_NEVER)) throw Error(`Meadow continuum variant ${id} is incomplete`);
    // A patch's body ends in the box of its square's eight corners (scripts/prepare-meadow-grass.mjs), so it tiles.
    if (type.chain.coreTriangles !== 12) throw Error(`Meadow continuum variant ${id} ends in ${type.chain.coreTriangles} triangles, not its box`);
    if (!(type.coverage > 0 && type.coverage <= 1)) throw Error(`Meadow continuum variant ${id} has no coverage`);
  });
  if (!(manifest.farError > 0)) throw Error('The meadow continuum has no far error');
  if (!(atlas?.words > CONTINUUM_HEADER_WORDS) || atlas.bytes !== atlas.words * 4 || !/^[0-9a-f]{64}$/.test(atlas.sha256 ?? '') || !atlas.gzip?.file) throw Error('The meadow continuum atlas is malformed');
  return manifest;
}

// The atlas, fetched, unpacked and checked against its receipt. Resolves to { manifest, words }.
export function loadMeadowGrass({ assets = PORTUGAL_MEADOW_GRASS_ASSETS, fetchAsset = fetch } = {}) {
  return loadContinuumAtlas({ assets, validate: validateMeadowGrass, label: 'meadow', fetchAsset });
}

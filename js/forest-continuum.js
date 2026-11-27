// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// A forest pack's trees in the one continuum (AGENTS.md rule 3). Each prototype of a pack (js/forest-scenery.js), its
// wood and its leaf cards, is baked by scripts/prepare-forest-continuum.mjs with the one simplifier
// (js/continuum-bake.js): its wood into a cluster hierarchy cut by projected error, its leaves beside it, each coarser
// level fewer cards grown to cover what the finer did, the whole tree wrapped in one closed far body (its crown and
// trunk) that collapses a half-edge at a time to a few triangles, and one splat. All of it is one atlas of the one
// format (js/continuum-format.js), drawn through the WIND pose kind (js/wgsl/continuum-wind.js) by the forest's
// material (js/wgsl/forest-continuum.js). This is what a tree puts in the atlas:
//   a vertex   high: its layer (the prototype's own; FOREST_CONTINUUM_UNTEXTURED if colour alone) | leaf << 4 | exposure << 5 (8 bits); word: its colour
//              (each channel's square root, 8 bits) | the light its own canopy lets through << 24 (8 bits); the UV
//              stream its texture coordinates over its type's range; the wind stream the bones that carry it
//              (packContinuumWindBones), as does every vertex of its far body.
//   a far triangle  leaf | material << 1, of the surface nearest it. What the far body and the splat look like (the
//              colour of what is seen, whether it is leaf, the sky, depth and light through) is their optical moments
//              (js/continuum-bake.js continuumFarOptics), which scripts/prepare-forest-continuum.mjs casts against
//              the bark and the cards.
//   a type's material block  its texture coordinates' range, its splat's look (a far word), and its first layer
//              among the pack's materials.
//   its manifest's type  its skeleton's rest (wind.bones: CONTINUUM_WIND_BONES of FOREST_CONTINUUM_BONE_FLOATS, as
//              scripts/prepare-forest-continuum.mjs windSkeleton lays them), which js/wgsl/forest-continuum.js steps.
import {
  CONTINUUM_ATLAS_VERSION, CONTINUUM_HEADER_WORDS, CONTINUUM_NEVER, CONTINUUM_TYPE, continuumFloatWord, packContinuumBody, packContinuumUV, loadContinuumAtlas,
} from './continuum-format.js';
import { CONTINUUM_WIND_BONES } from './wgsl/continuum-wind.js';

export const FOREST_CONTINUUM_FORMAT = 'waterworld.forest-continuum';
export const FOREST_CONTINUUM_VERSION = CONTINUUM_ATLAS_VERSION;
// A type's material block (js/continuum-format.js CONTINUUM_TYPE.material).
export const FOREST_CONTINUUM_MATERIAL = Object.freeze({
  uvLow: CONTINUUM_TYPE.material, uvScale: CONTINUUM_TYPE.material + 2, splat: CONTINUUM_TYPE.material + 4, firstLayer: CONTINUUM_TYPE.material + 5,
});
// A bone's rest, in floats: [pivot, parent + 1 | group << 6 | 1 << 8], [axis, how far out along the tree], [lever to
// where the wind presses what it carries, that drag area], [stiffness, natural angular frequency, damping, largest bend].
export const FOREST_CONTINUUM_BONE_FLOATS = 16;
// A body's kind floats (js/continuum-bake.js): [FOREST_CONTINUUM_BARK or _LEAF, the source vertex].
export const FOREST_CONTINUUM_BARK = 0, FOREST_CONTINUUM_LEAF = 1;

// The baked atlas of each pack, and its manifest. Spelled out: the build publishes only the asset paths it finds quoted.
export const FOREST_CONTINUUM_ASSETS = Object.freeze({
  'manifest.json': 'assets/forest-scenery/saba/continuum/manifest.json',
  'atlas.bin.gz': 'assets/forest-scenery/saba/continuum/atlas.bin.gz',
});
export const SUBTROPICAL_FOREST_CONTINUUM_ASSETS = Object.freeze({
  'manifest.json': 'assets/forest-scenery/subtropical/continuum/manifest.json',
  'atlas.bin.gz': 'assets/forest-scenery/subtropical/continuum/atlas.bin.gz',
});
export const PORTUGAL_FOREST_CONTINUUM_ASSETS = Object.freeze({
  'manifest.json': 'assets/forest-scenery/portugal/continuum/manifest.json',
  'atlas.bin.gz': 'assets/forest-scenery/portugal/continuum/atlas.bin.gz',
});
export const NORTHERN_FOREST_CONTINUUM_ASSETS = Object.freeze({
  'manifest.json': 'assets/forest-scenery/northern/continuum/manifest.json',
  'atlas.bin.gz': 'assets/forest-scenery/northern/continuum/atlas.bin.gz',
});
// Compact mobile continuum packs (scripts/prepare-mobile-continuum.mjs): same physical 3D tree clusters, wind bones,
// and far-body morphs with sub-centimetre finest levels pruned so mobile & 128 MiB GPUs stay inside one page and VRAM budget.
export const FOREST_CONTINUUM_MOBILE_ASSETS = Object.freeze({
  'manifest.json': 'assets/mobile-continuum/saba-forest/manifest.json',
  'atlas.bin.gz': 'assets/mobile-continuum/saba-forest/atlas.bin.gz',
});
export const PORTUGAL_FOREST_CONTINUUM_MOBILE_ASSETS = Object.freeze({
  'manifest.json': 'assets/mobile-continuum/portugal-forest/manifest.json',
  'atlas.bin.gz': 'assets/mobile-continuum/portugal-forest/atlas.bin.gz',
});
export const NORTHERN_FOREST_CONTINUUM_MOBILE_ASSETS = Object.freeze({
  'manifest.json': 'assets/mobile-continuum/northern-forest/manifest.json',
  'atlas.bin.gz': 'assets/mobile-continuum/northern-forest/atlas.bin.gz',
});

// A surface's layer among its prototype's materials, or FOREST_CONTINUUM_UNTEXTURED for one the pack colours alone (its
// source layer -1): its vertex colour is then its albedo.
export const FOREST_CONTINUUM_UNTEXTURED = 15;
function forestContinuumLayer(material) {
  if (material < 0) return FOREST_CONTINUUM_UNTEXTURED;
  if (!(material < FOREST_CONTINUUM_UNTEXTURED)) throw Error(`A forest surface has a layer out of range: ${material}`);
  return material;
}
const forestUnit = (v, bits) => Math.max(0, Math.min((1 << bits) - 1, Math.round(Math.max(0, Math.min(1, v)) * ((1 << bits) - 1))));
// What one source vertex of a pack gives a tree's surface: its layer, whether it is a leaf, its colour, its exposure
// (how open it stands to the sky) and the light its own canopy lets through.
export function forestContinuumVertex({ material, leaf, colour, exposure, canopy }) {
  const layer = forestContinuumLayer(material), root = colour.map((c) => Math.sqrt(Math.max(0, c)));
  return {
    high: (layer | (leaf ? 16 : 0) | (forestUnit(exposure, 8) << 5)) >>> 0,
    word: (forestUnit(root[0], 8) | (forestUnit(root[1], 8) << 8) | (forestUnit(root[2], 8) << 16) | (forestUnit(canopy, 8) << 24)) >>> 0,
  };
}
export function forestContinuumFarWord({ material, leaf }) {
  return ((leaf ? 1 : 0) | (forestContinuumLayer(material) << 1)) >>> 0;
}
// How a tree is packed (js/continuum-format.js packContinuumBody). `surface(v)` gives a packed vertex's source
// attributes (forestContinuumVertex's), `uv(v)` its texture coordinates and `wind(v)` its wind word (its bones,
// packContinuumWindBones), `farWind(i)` far vertex i's; `farSurface(t)` a far triangle's; `look` the splat's (a far
// word's attributes); `uvRange` [low u, low v, span u, span v]; `firstLayer` its first among the pack's materials.
export function packForestContinuumBody({ triangles, surface, uv, wind, farWind, farSurface, look, uvRange, firstLayer }, baked) {
  const [lowU, lowV, spanU, spanV] = uvRange;
  return packContinuumBody({
    triangles,
    material: [continuumFloatWord(lowU), continuumFloatWord(lowV), continuumFloatWord(spanU), continuumFloatWord(spanV), forestContinuumFarWord(look), firstLayer >>> 0],
    vertex: (v) => forestContinuumVertex(surface(v)),
    farWord: (t) => forestContinuumFarWord(farSurface(t)),
    streams: {
      uv: (v) => { const [u, w] = uv(v); return [packContinuumUV([Math.max(0, Math.min(1, (u - lowU) / spanU)), Math.max(0, Math.min(1, (w - lowV) / spanV))])]; },
      wind: (v) => [wind(v)],
    },
    farStreams: { wind: (i) => [farWind(i)] },
  }, baked);
}

export function validateForestContinuumManifest(manifest) {
  if (manifest?.format !== FOREST_CONTINUUM_FORMAT || manifest.version !== FOREST_CONTINUUM_VERSION) throw Error('Invalid forest continuum manifest: rebake it');
  const { types, atlas } = manifest;
  if (!Array.isArray(types) || !types.length) throw Error('The forest continuum holds no types');
  types.forEach((type, id) => {
    if (type.id !== id || !/^[0-9a-f]{64}$/.test(type.fingerprint ?? '')) throw Error(`Forest continuum type ${id} is malformed`);
    if (!(type.clusters?.count > 0) || !(type.chain?.baseTriangles >= 4) || !(type.chain.steps >= 1 && type.chain.steps < CONTINUUM_NEVER)) throw Error(`Forest continuum type ${id} is incomplete`);
    if (type.wind?.bones?.length !== CONTINUUM_WIND_BONES * FOREST_CONTINUUM_BONE_FLOATS || !type.wind.bones.every(Number.isFinite) || !(type.wind.bones[3] > 0)) throw Error(`Forest continuum type ${id} has no skeleton: rebake it`);
  });
  if (!(atlas?.words > CONTINUUM_HEADER_WORDS) || atlas.bytes !== atlas.words * 4 || !/^[0-9a-f]{64}$/.test(atlas.sha256 ?? '') || !atlas.gzip?.file) throw Error('The forest continuum atlas is malformed');
  return manifest;
}
// A pack's atlas, fetched, unpacked and checked. Resolves to { manifest, words }.
export function loadForestContinuum({ assets, fetchAsset = fetch }) {
  return loadContinuumAtlas({ assets, validate: validateForestContinuumManifest, label: 'forest', fetchAsset });
}
// The atlas of the pack a manifest describes, and its prototypes' fingerprint: a pack's continuum is its own.
export function forestContinuumAssetsFor(manifest, { mobile = false } = {}) {
  const kind = forestPackKindOf(manifest);
  if (kind === 'subtropical') return SUBTROPICAL_FOREST_CONTINUUM_ASSETS;
  if (kind === 'northern') return mobile ? NORTHERN_FOREST_CONTINUUM_MOBILE_ASSETS : NORTHERN_FOREST_CONTINUUM_ASSETS;
  if (kind === 'portugal') return mobile ? PORTUGAL_FOREST_CONTINUUM_MOBILE_ASSETS : PORTUGAL_FOREST_CONTINUUM_ASSETS;
  return mobile ? FOREST_CONTINUUM_MOBILE_ASSETS : FOREST_CONTINUUM_ASSETS;
}
// Which pack a manifest is (saba, subtropical, portugal or northern): its bake names it
// (scripts/bake-forest-mature-pack.py), and a pack baked before bakes did is told by its trees.
export function forestPackKindOf(manifest) {
  if (manifest?.bake?.pack) return manifest.bake.pack;
  const species = new Set(manifest.prototypes.map((p) => p.species));
  if (species.has('royal_palm') || species.has('ceiba') || species.has('mangrove')) return 'subtropical';
  if (species.has('fir') || species.has('larch')) return 'northern';
  return manifest.prototypes.some((p) => Boolean(p.cohort)) ? 'portugal' : 'saba';
}

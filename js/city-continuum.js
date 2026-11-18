// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// A city's buildings in the one continuum (AGENTS.md rule 3). Each Cairn type (js/old-world-buildings.js), houses,
// churches, towers, walls, gates, works and bridges, is baked by scripts/prepare-city-continuum.mjs from the mesh its
// builder makes, part by part, into a cluster hierarchy the GPU cuts by projected error, a closed far body wrapped
// round it that collapses one half-edge at a time to a few triangles, and a single splat. The bake is offline and per
// type: the types are a fixed catalogue, every building of every plan is one of them placed at its own size and
// tinted, and the browser then holds no simplifier. All of it is one atlas of the one format (js/continuum-format.js);
// this is what a city puts in it: a vertex's kind, a far-body triangle's, a type's roof and walls, and how raw a face is.
// js/wgsl/city-continuum.js is its material; js/city-continuum-draw.js places a city's buildings.
import {
  CONTINUUM_ATLAS_VERSION, CONTINUUM_HEADER_WORDS, CONTINUUM_NEVER, CONTINUUM_TYPE, CONTINUUM_TYPE_SLIGHT, continuumFloatWord,
  packContinuumBody, packContinuumPieces, packContinuumSurface, loadContinuumAtlas,
} from './continuum-format.js';

export const CITY_CONTINUUM_FORMAT = 'waterworld.city-continuum';
// A city's manifest is of the atlas's own version: a rebake is the only way to a new one.
export const CITY_CONTINUUM_VERSION = CONTINUUM_ATLAS_VERSION;
// A city type's material block (js/continuum-format.js CONTINUUM_TYPE.material): its splat's roof share, its walls'
// kind and its roof's (f32), as the splat wears them.
export const CITY_CONTINUUM_MATERIAL = Object.freeze({ roofShare: CONTINUUM_TYPE.material, wallKind: CONTINUUM_TYPE.material + 1, roofKind: CONTINUUM_TYPE.material + 3 });
// The largest kind.y a type carries (a timber's shade plus twice its grain), for quantizing it.
export const CITY_CONTINUUM_KIND_Y = 8;

// The baked atlas and its manifest. Spelled out, not composed, because the build publishes (and versions) only the
// asset paths it finds quoted in the source. Both are kept in git: the city is drawn from nothing else.
export const CITY_CONTINUUM_ASSETS = Object.freeze({
  'manifest.json': 'assets/city-continuum/manifest.json',
  'atlas.bin.gz': 'assets/city-continuum/atlas.bin.gz',
});

const cityUnit16 = (v) => Math.max(0, Math.min(65535, Math.round(v * 65535)));
// A kind (material + fraction, kind.y) split into its parts.
function cityKindParts([x, y]) {
  const material = Math.floor(x + 0.01);
  if (!(material >= 0 && material < 256)) throw Error(`A city surface has a material out of range: ${x}`);
  return { material, fraction: Math.min(Math.max(x - material, 0), 0.999999), y: Math.min(Math.max(y / CITY_CONTINUUM_KIND_Y, 0), 1) };
}
// A vertex's kind as its high half-word (kind.y) and its word (material | fraction << 8).
export function cityContinuumVertexKind(kind) {
  const k = cityKindParts(kind);
  return { high: cityUnit16(k.y), word: (k.material | (Math.round(k.fraction * 16777215) << 8)) >>> 0 };
}
export const unpackCityContinuumVertexKind = (high, word) => [(word & 255) + (word >>> 8) / 16777215, (high / 65535) * CITY_CONTINUUM_KIND_Y];
// A far-body triangle's kind in one word.
export function packCityContinuumKind(kind) {
  const k = cityKindParts(kind);
  return (k.material | (Math.round(k.fraction * 4095) << 8) | (Math.round(k.y * 4095) << 20)) >>> 0;
}
export function unpackCityContinuumKind(word) {
  return [(word & 255) + ((word >>> 8) & 4095) / 4095, ((word >>> 20) / 4095) * CITY_CONTINUUM_KIND_Y];
}
// How a city body is packed (js/continuum-format.js packContinuumBody): each vertex's kind, each far triangle's, its
// roof and walls, and the surface stream where a face is raw (its welded normal longer than one, as a cut through a
// struck building's stone or timber is drawn).
function cityContinuumPacking({ triangles, slight = false }, { welded, far = null }) {
  const N = welded.normal, splat = far?.splat;
  return {
    triangles, flags: slight ? CONTINUUM_TYPE_SLIGHT : 0,
    material: splat ? [splat.roofShare, ...splat.wallKind, ...splat.roofKind].map(continuumFloatWord) : [],
    vertex: (v) => cityContinuumVertexKind([welded.kind[v * 2], welded.kind[v * 2 + 1]]),
    farWord: (t) => packCityContinuumKind([far.kinds[t * 2], far.kinds[t * 2 + 1]]),
    streams: { surface: (v) => [packContinuumSurface(Math.max(0, Math.hypot(N[v * 3], N[v * 3 + 1], N[v * 3 + 2]) - 1))] },
  };
}
// One baked body (js/continuum-bake.js bakeContinuumBody) as a city type: `triangles` its source triangle count,
// `slight` whether it never stands as a target in its own right.
export function packCityContinuumBody(meta, baked) { return packContinuumBody(cityContinuumPacking(meta, baked), baked); }
// A struck building's pieces (js/building-fracture.js), each piece a part, drawn as clusters alone.
export function packCityContinuumPieces(meta, baked) { return packContinuumPieces(cityContinuumPacking(meta, baked), baked); }

export function validateCityContinuumManifest(manifest) {
  if (manifest?.format !== CITY_CONTINUUM_FORMAT || manifest.version !== CITY_CONTINUUM_VERSION) throw Error('Invalid city continuum manifest: rebake it');
  const { types, atlas } = manifest;
  if (!Array.isArray(types) || !types.length) throw Error('The city continuum holds no types');
  types.forEach((type, id) => {
    if (type.id !== id || !/^[0-9a-f]{64}$/.test(type.fingerprint ?? '')) throw Error(`City continuum type ${id} is malformed`);
    if (!(type.clusters?.count > 0) || !(type.chain?.baseTriangles >= 4) || !(type.chain.steps >= 1 && type.chain.steps < CONTINUUM_NEVER)) throw Error(`City continuum type ${id} is incomplete`);
  });
  if (!(atlas?.words > CONTINUUM_HEADER_WORDS) || atlas.bytes !== atlas.words * 4 || !/^[0-9a-f]{64}$/.test(atlas.sha256 ?? '') || !atlas.gzip?.file) throw Error('The city continuum atlas is malformed');
  return manifest;
}

// The atlas, fetched, unpacked and checked against its receipt and the cut. Resolves to { manifest, words }.
export function loadCityContinuum({ fetchAsset = fetch } = {}) {
  return loadContinuumAtlas({ assets: CITY_CONTINUUM_ASSETS, validate: validateCityContinuumManifest, label: 'city', fetchAsset });
}

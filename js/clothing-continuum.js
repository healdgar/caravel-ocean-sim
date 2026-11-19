// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Modular 3D GPU-skinned kinematic 1550 clothing in the one continuum (AGENTS.md rules 1, 2, 3).
// Built offline by scripts/prepare-clothing-continuum.mjs directly around the clean undressed male and female
// anatomical base bodies on the 93-joint Unreal skeleton, carrying both the skin stream (exact 4-joint skeletal
// weight transfer) and the wind stream (per-vertex cloth hem flex + fold phase) so skirts, sleeves, tunics, and
// shoulder cloaks physically billow in wind and sway with walking stride on the GPU — eliminating baked garment
// intersection and color-bleed stains permanently.
import {
  CONTINUUM_ATLAS_VERSION, CONTINUUM_HEADER_WORDS, CONTINUUM_NEVER,
  continuumAtlasTypes, loadContinuumAtlas,
} from './continuum-format.js';
import { uploadContinuumAtlas } from './continuum-scene.js';

export const CLOTHING_CONTINUUM_FORMAT = 'waterworld.clothing-continuum';
export const CLOTHING_CONTINUUM_VERSION = CONTINUUM_ATLAS_VERSION;

// Spelled out literally so build.mjs discovers, versions, and publishes both files.
export const CLOTHING_CONTINUUM_ASSETS = Object.freeze({
  'manifest.json': 'assets/crew/clothing-continuum/manifest.json',
  'atlas.bin.gz': 'assets/crew/clothing-continuum/atlas.bin.gz',
});

// Fourteen separate physical 3D garments (3 slots per person: upper, lower+belt+shoes, optional cloak):
//   0..6   upper garments (shirts, doublets, jerkins, blouses, bodices, tunics, huipils)
//   7..12  lower garments + belts + footwear (mariner slops, trunk hose, pleated skirts, apron skirts, wrap skirts)
//   13     optional flowing 1550 Iberian shoulder cloak/cape
export const CLOTHING_CONTINUUM_TYPES = Object.freeze([
  { index: 0, id: 'male-linen-shirt', sex: 'male', slot: 'upper' },
  { index: 1, id: 'male-doublet', sex: 'male', slot: 'upper' },
  { index: 2, id: 'male-soldier-jerkin', sex: 'male', slot: 'upper' },
  { index: 3, id: 'female-chemise-blouse', sex: 'female', slot: 'upper' },
  { index: 4, id: 'female-laced-bodice', sex: 'female', slot: 'upper' },
  { index: 5, id: 'indigenous-tunic-m', sex: 'male', slot: 'upper' },
  { index: 6, id: 'indigenous-huipil-f', sex: 'female', slot: 'upper' },
  { index: 7, id: 'male-mariner-slops', sex: 'male', slot: 'lower' },
  { index: 8, id: 'male-trunk-hose', sex: 'male', slot: 'lower' },
  { index: 9, id: 'female-pleated-skirt', sex: 'female', slot: 'lower' },
  { index: 10, id: 'female-apron-skirt', sex: 'female', slot: 'lower' },
  { index: 11, id: 'indigenous-breechcloth-m', sex: 'male', slot: 'lower' },
  { index: 12, id: 'indigenous-wrap-skirt-f', sex: 'female', slot: 'lower' },
  { index: 13, id: 'shoulder-cloak', sex: 'male', slot: 'over' },
].map(Object.freeze));

// Role codes encoded into clothingInfo uniform so the GPU clothing stand pass picks authentic 1550 outfits per body.
export const CLOTHING_ROLE_CODE = Object.freeze({
  hand: 0,
  captain: 1,
  soldier: 2,
  indigenous: 3,
});

export function clothingInfoFor(bodyId, sex = 'male', role = 'hand') {
  const isFemale = sex === 'female' ? 1 : 0;
  let roleCode = CLOTHING_ROLE_CODE.hand;
  if (role === 'captain' || bodyId === 'captain') roleCode = CLOTHING_ROLE_CODE.captain;
  else if (role === 'soldier' || bodyId === 'soldier') roleCode = CLOTHING_ROLE_CODE.soldier;
  else if (['algonquian', 'caribbean', 'maya', 'andean'].includes(role) || /^(algonquian|caribbean|maya|andean)-/.test(bodyId || '')) {
    roleCode = CLOTHING_ROLE_CODE.indigenous;
  }
  return new Uint32Array([0, isFemale, roleCode, 0]);
}

export function validateClothingContinuumManifest(manifest) {
  if (manifest?.format !== CLOTHING_CONTINUUM_FORMAT || manifest.version !== CLOTHING_CONTINUUM_VERSION) {
    throw Error('Invalid clothing continuum manifest: rebake with `node scripts/prepare-clothing-continuum.mjs`');
  }
  const { atlas, types } = manifest;
  if (!(atlas?.words > CONTINUUM_HEADER_WORDS) || atlas.bytes !== atlas.words * 4) {
    throw Error('Clothing continuum atlas header is malformed');
  }
  if (!Array.isArray(types) || types.length !== CLOTHING_CONTINUUM_TYPES.length) {
    throw Error(`Clothing continuum manifest expected ${CLOTHING_CONTINUUM_TYPES.length} types`);
  }
  types.forEach((t, i) => {
    if (t.id !== CLOTHING_CONTINUUM_TYPES[i].id) throw Error(`Clothing continuum type ${i} mismatch: ${t.id}`);
    if (!(t.clusters?.count > 0) || !(t.chain?.baseTriangles >= 4) || !(t.chain?.steps >= 0 && t.chain.steps < CONTINUUM_NEVER)) {
      throw Error(`Clothing continuum type ${t.id} is incomplete`);
    }
  });
  return manifest;
}

const clothingContinuumCache = new WeakMap();

export function loadClothingContinuum(device, { fetchAsset = fetch } = {}) {
  let pending = clothingContinuumCache.get(device);
  if (!pending) {
    pending = loadContinuumAtlas({
      assets: CLOTHING_CONTINUUM_ASSETS,
      validate: validateClothingContinuumManifest,
      label: 'clothing continuum',
      fetchAsset,
    }).then(({ manifest, words }) => ({
      manifest,
      words,
      types: continuumAtlasTypes(words),
      atlas: uploadContinuumAtlas(device, words, 'clothing continuum'),
    })).catch((err) => {
      if (clothingContinuumCache.get(device) === pending) clothingContinuumCache.delete(device);
      throw err;
    });
    clothingContinuumCache.set(device, pending);
  }
  return pending;
}

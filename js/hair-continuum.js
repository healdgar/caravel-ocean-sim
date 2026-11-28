// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Algorithmic strand hair and beards in the one continuum (AGENTS.md rule 3).
// Built offline by scripts/prepare-hair-continuum.mjs as multi-segment 3D V-arched hair locks and fine flyaway fibers
// rooted onto the fitted crew skulls and jaws, carrying both the skin stream (following head, neck, spine and jaw
// joints) and the wind stream (along-strand cantilever flex + per-lock curl phase) so strands bend dynamically with
// live wind, gusts, curl flutter, and walking/turning motion on the GPU, cut by the one select under the 'hair'
// continuum profile and shaded with anisotropic dual-lobe fiber highlights.
import {
  CONTINUUM_ATLAS_VERSION, CONTINUUM_HEADER_WORDS, CONTINUUM_NEVER, continuumAtlasMetaWords, loadContinuumAtlas,
} from './continuum-format.js';
import { uploadContinuumAtlas } from './continuum-scene.js';

export const HAIR_CONTINUUM_FORMAT = 'waterworld.hair-continuum';
export const HAIR_CONTINUUM_VERSION = CONTINUUM_ATLAS_VERSION;

// Spelled out literally so build.mjs discovers, versions, and publishes both files.
export const HAIR_CONTINUUM_ASSETS = Object.freeze({
  'manifest.json': 'assets/crew/hair-continuum/manifest.json',
  'atlas.bin.gz': 'assets/crew/hair-continuum/atlas.bin.gz',
});

// Twelve physical 3D strand grooms:
//   0..4   male scalp grooms
//   5..8   female scalp grooms
//   9..11  male facial hair grooms (moustache, Iberian barba, full mariner sea-beard)
export const HAIR_CONTINUUM_TYPES = Object.freeze([
  { index: 0, id: 'cropped-curls', sex: 'male', slot: 'scalp' },
  { index: 1, id: 'parted-locks', sex: 'male', slot: 'scalp' },
  { index: 2, id: 'mariner-queue', sex: 'male', slot: 'scalp' },
  { index: 3, id: 'indigenous-long', sex: 'male', slot: 'scalp' },
  { index: 4, id: 'tonsure-fringe', sex: 'male', slot: 'scalp' },
  { index: 5, id: 'parted-waves', sex: 'female', slot: 'scalp' },
  { index: 6, id: 'nape-chignon', sex: 'female', slot: 'scalp' },
  { index: 7, id: 'crown-braids', sex: 'female', slot: 'scalp' },
  { index: 8, id: 'indigenous-long-f', sex: 'female', slot: 'scalp' },
  { index: 9, id: 'moustache', sex: 'male', slot: 'beard' },
  { index: 10, id: 'iberian-barba', sex: 'male', slot: 'beard' },
  { index: 11, id: 'sea-beard', sex: 'male', slot: 'beard' },
].map(Object.freeze));

// Measured cranial (crownY, skullMidZ) and oral (lipY, lipZ) bind-space landmarks across all twelve fitted crew bodies
// relative to sailor-male (male reference) and villager-female (female reference), so one 12-type strand atlas seats
// flush on every body's skull and upper lip/jaw in every pose.
export const HAIR_REF_ANCHORS = Object.freeze({
  male: Object.freeze({ crownY: 1.7714, midZ: 0.0328, lipY: 1.5927, lipZ: 0.1507 }),
  female: Object.freeze({ crownY: 1.7018, midZ: -0.0250, lipY: 1.5375, lipZ: 0.0812 }),
});

export const HAIR_BODY_ANCHORS = Object.freeze({
  'sailor-male': Object.freeze({ sex: 'male', scalp: [0, 0, 0], beard: [0, 0, 0] }),
  'villager-female': Object.freeze({ sex: 'female', scalp: [0, 0, 0], beard: [0, 0, 0] }),
  'captain': Object.freeze({ sex: 'male', scalp: [0, -0.0059, -0.0160], beard: [0, -0.0001, -0.0193] }),
  'soldier': Object.freeze({ sex: 'male', scalp: [0, -0.0064, -0.0185], beard: [0, -0.0052, -0.0138] }),
  'algonquian-male': Object.freeze({ sex: 'male', scalp: [0, -0.0102, -0.0619], beard: [0, 0.0055, -0.0668] }),
  'algonquian-female': Object.freeze({ sex: 'female', scalp: [-0.0066, -0.0033, -0.0067], beard: [0, 0, 0] }),
  'caribbean-male': Object.freeze({ sex: 'male', scalp: [0, -0.0010, -0.0320], beard: [0, 0.0021, -0.0298] }),
  'caribbean-female': Object.freeze({ sex: 'female', scalp: [0, 0.0045, -0.0116], beard: [0, 0, 0] }),
  'maya-male': Object.freeze({ sex: 'male', scalp: [0, -0.0025, -0.0637], beard: [0, -0.0190, -0.0654] }),
  'maya-female': Object.freeze({ sex: 'female', scalp: [0, 0.0062, 0.0135], beard: [0, 0, 0] }),
  'andean-male': Object.freeze({ sex: 'male', scalp: [-0.0069, 0.0056, -0.0686], beard: [-0.0069, 0.0030, -0.0650] }),
  'andean-female': Object.freeze({ sex: 'female', scalp: [-0.0067, 0.0113, -0.0057], beard: [0, 0, 0] }),
});

export function hairContinuumShiftsFor(bodyId, defaultFemale = false) {
  const entry = HAIR_BODY_ANCHORS[bodyId];
  const female = entry ? entry.sex === 'female' : Boolean(defaultFemale);
  const scalp = entry?.scalp ?? [0, 0, 0];
  const beard = entry?.beard ?? [0, 0, 0];
  return new Float32Array([
    scalp[0], scalp[1], scalp[2], female ? 1 : 0,
    beard[0], beard[1], beard[2], 0,
  ]);
}

export function validateHairContinuumManifest(manifest) {
  if (manifest?.format !== HAIR_CONTINUUM_FORMAT || manifest.version !== HAIR_CONTINUUM_VERSION) {
    throw Error('Invalid hair continuum manifest: rebake with `node scripts/prepare-hair-continuum.mjs`');
  }
  const { atlas, types } = manifest;
  if (!(atlas?.words > CONTINUUM_HEADER_WORDS) || atlas.bytes !== atlas.words * 4) {
    throw Error('Hair continuum atlas header is malformed');
  }
  if (!Array.isArray(types) || types.length !== HAIR_CONTINUUM_TYPES.length) {
    throw Error(`Hair continuum manifest expected ${HAIR_CONTINUUM_TYPES.length} types`);
  }
  types.forEach((t, i) => {
    if (t.id !== HAIR_CONTINUUM_TYPES[i].id) throw Error(`Hair continuum type ${i} mismatch: ${t.id}`);
    if (!(t.clusters?.count > 0) || !(t.chain?.baseTriangles >= 4) || !(t.chain?.steps >= 0 && t.chain.steps < CONTINUUM_NEVER)) {
      throw Error(`Hair continuum type ${t.id} is incomplete`);
    }
  });
  return manifest;
}

const hairContinuumCache = new WeakMap();

export function loadHairContinuum(device, { fetchAsset = fetch, verifySha256 } = {}) {
  let pending = hairContinuumCache.get(device);
  if (!pending) {
    const wantVerify = verifySha256 !== false
      && !(typeof location !== 'undefined' && new URLSearchParams(location.search).get('verifyAssets') === '0')
      && Boolean(globalThis.crypto?.subtle?.digest);
    pending = loadContinuumAtlas({
      assets: HAIR_CONTINUUM_ASSETS,
      validate: validateHairContinuumManifest,
      label: 'hair continuum',
      fetchAsset,
      verifySha256: wantVerify,
    }).then(({ manifest, words }) => {
      // Past its strands a groom wears its baked far shell, down the one chain to the splat.
      const atlas = uploadContinuumAtlas(device, words, 'hair continuum');
      return { manifest, words: continuumAtlasMetaWords(words), types: atlas.types, atlas };
    }).catch((err) => {
      if (hairContinuumCache.get(device) === pending) hairContinuumCache.delete(device);
      throw err;
    });
    hairContinuumCache.set(device, pending);
  }
  return pending;
}

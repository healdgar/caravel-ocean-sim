// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Algorithmic strand hair and beards in the one continuum (AGENTS.md rule 3).
// Built offline by scripts/prepare-hair-continuum.mjs as multi-segment 3D V-arched hair locks and fine flyaway fibers
// rooted onto the fitted crew skulls and jaws, carrying both the skin stream (following head, neck, spine and jaw
// joints) and the wind stream (along-strand cantilever flex + per-lock curl phase) so strands bend dynamically with
// live wind, gusts, curl flutter, and walking/turning motion on the GPU, cut by the one select under the 'hair'
// continuum profile and shaded with anisotropic dual-lobe fiber highlights.
import {
  CONTINUUM_ATLAS_VERSION, CONTINUUM_CHUNK_TRIANGLES, CONTINUUM_CLUSTER_WORDS, CONTINUUM_HEADER,
  CONTINUUM_HEADER_WORDS, CONTINUUM_NEVER, CONTINUUM_SURFEL_HEADER_WORDS, CONTINUUM_SURFEL_SCALE_MAX,
  CONTINUUM_SURFEL_WORDS, CONTINUUM_TYPE, CONTINUUM_TYPE_WORDS, CONTINUUM_VERTEX_WORDS,
  continuumAtlasMetaWords, loadContinuumAtlas,
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

function hairMortonPart1By2(n) {
  let x = n & 0x3ff;
  x = (x | (x << 16)) & 0x030000ff;
  x = (x | (x << 8)) & 0x0300f00f;
  x = (x | (x << 4)) & 0x030c30c3;
  x = (x | (x << 2)) & 0x09249249;
  return x >>> 0;
}

function hairReverseBits32(v) {
  let x = v >>> 0;
  x = ((x >>> 1) & 0x55555555) | ((x & 0x55555555) << 1);
  x = ((x >>> 2) & 0x33333333) | ((x & 0x33333333) << 2);
  x = ((x >>> 4) & 0x0f0f0f0f) | ((x & 0x0f0f0f0f) << 4);
  x = ((x >>> 8) & 0x00ff00ff) | ((x & 0x00ff00ff) << 8);
  return (((x >>> 16) | (x << 16)) >>> 0);
}

// Builds fine blue-noise hair surfels directly from each groom's Level-0 strand vertices so crisp 3D hair strands stay
// active through mid-range (>= 18..25 m) and hand off into dense sub-pixel surfels (1536..2048 scalp, 768..1024 beard,
// tight relRadius = 0.78) only once individual 6..10 mm ribbons are genuinely <= ~1 px wide — never giant 8 m blotches.
export function appendHairContinuumSurfels(words) {
  const H = CONTINUUM_HEADER, T = CONTINUUM_TYPE;
  const typeCount = words[H.typeCount];
  const counts = new Uint32Array(typeCount);
  if (!typeCount || words[H.surfels] !== 0) return { words, counts };
  const typesAt = words[H.typesAt], clustersAt = words[H.clustersAt];
  const verticesAt = words[H.verticesAt], indicesAt = words[H.indicesAt];
  const f32 = new Float32Array(words.buffer, words.byteOffset, words.length);
  const perType = new Array(typeCount);
  const permCache = new Map();
  const bitRevPerm = (n) => {
    let cached = permCache.get(n);
    if (!cached) {
      const revRank = new Uint32Array(n), perm = new Uint32Array(n);
      for (let r = 0; r < n; r++) { revRank[r] = hairReverseBits32(r); perm[r] = r; }
      perm.sort((a, b) => revRank[a] - revRank[b]);
      permCache.set(n, (cached = perm));
    }
    return cached;
  };
  let totalSurfels = 0;
  const relU16 = Math.max(1, Math.min(65535, Math.round((0.78 / CONTINUUM_SURFEL_SCALE_MAX) * 65535)));

  for (let ty = 0; ty < typeCount; ty++) {
    const tb = typesAt + ty * CONTINUUM_TYPE_WORDS;
    const first = words[tb + T.clusterFirst], cnt = words[tb + T.clusterCount];
    const span = f32[tb + T.span];
    if (!(span > 0) || !cnt) { perType[ty] = null; continue; }
    const qScale = span / 65535, qAreaScale = qScale * qScale;
    const rx = Math.max(f32[tb + T.splatRx], 0.04), ry = Math.max(f32[tb + T.splatRy], 0.04);
    const isBeard = HAIR_CONTINUUM_TYPES[ty]?.slot === 'beard';

    let lv0Tris = 0;
    for (let i = 0; i < cnt; i++) {
      const pk = words[clustersAt + (first + i) * CONTINUUM_CLUSTER_WORDS + 15];
      if (((pk >>> 8) & 255) === 0) lv0Tris += pk & 255;
    }
    if (lv0Tris < 256) { perType[ty] = null; continue; }

    const stride = lv0Tris > 65536 ? Math.ceil(lv0Tris / 65536) : 1;
    const maxCand = Math.ceil(lv0Tris / stride) + 16;
    const candCdf = new Float64Array(maxCand);
    const candV0 = new Uint32Array(maxCand), candV1 = new Uint32Array(maxCand), candV2 = new Uint32Array(maxCand);
    const candPart = new Uint16Array(maxCand);
    let candCount = 0, totalWeight = 0, sampledArea = 0, triSkip = 0;

    for (let i = 0; i < cnt; i++) {
      const cb = clustersAt + (first + i) * CONTINUUM_CLUSTER_WORDS;
      const pk = words[cb + 15];
      if (((pk >>> 8) & 255) !== 0) continue;
      const tris = pk & 255, part = pk >>> 16, iFirst = indicesAt + words[cb + 14];
      for (let t = 0; t < tris; t++) {
        if (triSkip > 0) { triSkip--; continue; }
        triSkip = stride - 1;
        const i0 = iFirst + t * 3;
        const iv0 = words[i0], iv1 = words[i0 + 1], iv2 = words[i0 + 2];
        const v0 = verticesAt + iv0 * CONTINUUM_VERTEX_WORDS;
        const v1 = verticesAt + iv1 * CONTINUUM_VERTEX_WORDS;
        const v2 = verticesAt + iv2 * CONTINUUM_VERTEX_WORDS;
        const x0 = words[v0] & 65535, y0 = words[v0] >>> 16, z0 = words[v0 + 1] & 65535;
        const x1 = words[v1] & 65535, y1 = words[v1] >>> 16, z1 = words[v1 + 1] & 65535;
        const x2 = words[v2] & 65535, y2 = words[v2] >>> 16, z2 = words[v2 + 1] & 65535;
        const e1x = x1 - x0, e1y = y1 - y0, e1z = z1 - z0;
        const e2x = x2 - x0, e2y = y2 - y0, e2z = z2 - z0;
        const cx = e1y * e2z - e1z * e2y, cy = e1z * e2x - e1x * e2z, cz = e1x * e2y - e1y * e2x;
        const area = 0.5 * Math.sqrt(cx * cx + cy * cy + cz * cz) * qAreaScale;
        if (!(area > 1e-10)) continue;
        totalWeight += area;
        sampledArea += area;
        candCdf[candCount] = totalWeight;
        candV0[candCount] = iv0; candV1[candCount] = iv1; candV2[candCount] = iv2;
        candPart[candCount] = part;
        candCount++;
      }
    }
    if (!candCount || !(totalWeight > 0)) { perType[ty] = null; continue; }

    const rawEffArea = sampledArea * stride;
    const diskArea = Math.PI * rx * ry, shellArea = 4 * diskArea;
    const visProjArea = Math.min(rawEffArea * 0.55, diskArea * (1.28 + 0.62 * Math.log(1 + rawEffArea / Math.max(shellArea, 1e-4))));
    const areaRadius = Math.sqrt(Math.max(visProjArea, 1e-4) / Math.PI);
    const targetCount = Math.max(512, Math.min(isBeard ? 1024 : 2048, lv0Tris));
    // Hold crisp 3D strand clusters out to ~18..25 m before activating fine sub-pixel hair surfels.
    const handoffError = Math.max(isBeard ? 0.010 : 0.015, 0.72 * areaRadius / Math.sqrt(targetCount));

    const sVerts = new Uint32Array(targetCount), sParts = new Uint16Array(targetCount);
    const sMorton = new Uint32Array(targetCount), order = new Uint32Array(targetCount);
    let cursor = 0;
    for (let k = 0; k < targetCount; k++) {
      const targetW = ((k + 0.5) / targetCount) * totalWeight;
      while (cursor + 1 < candCount && candCdf[cursor] < targetW) cursor++;
      const corner = k % 3;
      const vIdx = corner === 0 ? candV0[cursor] : corner === 1 ? candV1[cursor] : candV2[cursor];
      sVerts[k] = vIdx;
      sParts[k] = candPart[cursor];
      const va = verticesAt + vIdx * CONTINUUM_VERTEX_WORDS;
      const x10 = (words[va] & 65535) >>> 6, y10 = (words[va] >>> 16) >>> 6, z10 = (words[va + 1] & 65535) >>> 6;
      sMorton[k] = (hairMortonPart1By2(x10) | (hairMortonPart1By2(y10) << 1) | (hairMortonPart1By2(z10) << 2)) >>> 0;
      order[k] = k;
    }
    order.sort((a, b) => sMorton[a] - sMorton[b]);

    const perm = bitRevPerm(targetCount);
    const packed = new Uint32Array(targetCount * CONTINUUM_SURFEL_WORDS);
    for (let i = 0; i < targetCount; i++) {
      const src = order[perm[i]];
      packed[i * 2] = sVerts[src];
      packed[i * 2 + 1] = (relU16 | ((sParts[src] & 65535) << 16)) >>> 0;
    }
    counts[ty] = targetCount;
    perType[ty] = { first: totalSurfels, count: targetCount, areaRadius, handoffError, packed };
    totalSurfels += targetCount;
  }

  if (!totalSurfels) return { words, counts };
  const dirWords = typeCount * CONTINUUM_SURFEL_HEADER_WORDS;
  const surfelSection = new Uint32Array(dirWords + totalSurfels * CONTINUUM_SURFEL_WORDS);
  const surfelF32 = new Float32Array(surfelSection.buffer);
  for (let ty = 0; ty < typeCount; ty++) {
    const info = perType[ty];
    if (!info) continue;
    const hAt = ty * CONTINUUM_SURFEL_HEADER_WORDS;
    surfelSection[hAt] = info.first;
    surfelSection[hAt + 1] = info.count;
    surfelF32[hAt + 2] = info.areaRadius;
    surfelF32[hAt + 3] = info.handoffError;
    surfelSection.set(info.packed, dirWords + info.first * CONTINUUM_SURFEL_WORDS);
  }
  const out = new Uint32Array(words.length + surfelSection.length);
  out.set(words, 0);
  out.set(surfelSection, words.length);
  out[H.surfels] = words.length;
  out[H.words] = out.length;
  return { words: out, counts };
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
      const { words: withSurfels, counts } = appendHairContinuumSurfels(words);
      const atlas = uploadContinuumAtlas(device, withSurfels, 'hair continuum');
      for (let t = 0; t < atlas.types.length; t++) {
        if (counts[t] > 0) atlas.types[t].farChunks = Math.max(atlas.types[t].farChunks, Math.ceil(counts[t] / CONTINUUM_CHUNK_TRIANGLES));
      }
      return { manifest, words: continuumAtlasMetaWords(withSurfels), types: atlas.types, atlas };
    }).catch((err) => {
      if (hairContinuumCache.get(device) === pending) hairContinuumCache.delete(device);
      throw err;
    });
    hairContinuumCache.set(device, pending);
  }
  return pending;
}

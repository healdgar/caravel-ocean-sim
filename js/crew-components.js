// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Modular 3D character component attachment & deterministic 15-bit GPU appearance packing
// for crew, fort garrisons, and port townsfolk. Zero extra draw calls; zero fragment discard.
import { CREW_COMPONENT_PACKS } from './models/crew-components.js';

function decodeCrewComponentB64(b64) {
  if (typeof Buffer !== 'undefined') {
    const buf = Buffer.from(b64, 'base64');
    return new Uint8Array(buf.buffer, buf.byteOffset, buf.byteLength);
  }
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function hashCrewAppearance(seed, salt = 0) {
  let h = (Math.imul((seed | 0) + 1, 0x9e3779b1) ^ Math.imul((salt | 0) + 1, 0x85ebca6b)) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x2c1b3c6d) >>> 0;
  h = Math.imul(h ^ (h >>> 12), 0x297a2d39) >>> 0;
  return ((h ^ (h >>> 15)) >>> 0) / 4294967296;
}

function hashCrewString(str) {
  const text = String(str ?? '');
  let h = 2166136261 >>> 0;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619) >>> 0;
  }
  return h | 0;
}

// Bit layout (15 bits, 0..32767):
//   bits  0..2  hair    (0=bald, 1=cropped, 2=parted locks, 3=queue, 4=nape bun, 5=crown braids)
//   bits  3..5  hat     (0=none, 1=barrete cap, 2=wide-brim hat, 3=headscarf/lenço, 4=morion/cocked hat)
//   bits  6..7  beard   (0=clean-shaven, 1=moustache, 2=Iberian barba, 3=full sea beard; male only)
//   bits  8..10 garment (0=base shirt/slops, 1=jerkin, 2=apron, 3=saia overskirt [female], 4=waist sash)
//   bits 11..12 build   (0=average, 1=lean, 2=broad/muscular, 3=stocky/portly)
//   bits 13..14 accent  (0=leather/umber, 1=madder crimson, 2=indigo wool, 3=straw/ochre)
export function packCrewCompMask({ hair = 0, hat = 0, beard = 0, garment = 0, build = 0, accent = 0 } = {}) {
  return (
    ((hair & 7) << 0) |
    ((hat & 7) << 3) |
    ((beard & 3) << 6) |
    ((garment & 7) << 8) |
    ((build & 3) << 11) |
    ((accent & 3) << 13)
  ) >>> 0;
}

export function unpackCrewCompMask(mask) {
  const m = (mask | 0) >>> 0;
  return {
    hair: m & 7,
    hat: (m >>> 3) & 7,
    beard: (m >>> 6) & 3,
    garment: (m >>> 8) & 7,
    build: (m >>> 11) & 3,
    accent: (m >>> 13) & 3,
  };
}

// Encodes both eyeOpen (~0.78..1.04) and 15-bit compMask into face.w without touching Indigenous (face.w > 1.5).
export function packCrewFaceW(faceW, compMask = 0, isIndigenous = false) {
  if (isIndigenous || faceW > 1.5) return faceW > 1.5 ? faceW : faceW + 2.0;
  const eyeOpen = faceW < 0 ? (-faceW) - Math.floor((-faceW) * 0.5) * 2.0 : faceW;
  const m = (compMask | 0) & 0x7fff;
  if (m <= 0) return eyeOpen;
  return -(m * 2.0 + eyeOpen);
}

const NAMED_CREW_PRESETS = Object.freeze({
  tomas:    { hair: 2, hat: 1, beard: 2, garment: 1, build: 2, accent: 2 }, // Mate: parted locks, indigo barrete, Iberian barba, jerkin, broad
  beatriz:  { hair: 4, hat: 3, beard: 0, garment: 4, build: 0, accent: 1 }, // Boatswain: nape bun under crimson-tinted lenço, sash
  duarte:   { hair: 0, hat: 0, beard: 3, garment: 1, build: 2, accent: 0 }, // Foremast: bald dome, full sea beard, leather jerkin, broad
  joao:     { hair: 3, hat: 0, beard: 1, garment: 4, build: 1, accent: 1 }, // Mainmast: tied queue, moustache, crimson mariner sash, lean
  catarina: { hair: 5, hat: 0, beard: 0, garment: 1, build: 0, accent: 0 }, // Mainmast: redhead crown braids, leather jerkin
  leonor:   { hair: 2, hat: 0, beard: 0, garment: 2, build: 0, accent: 3 }, // Sailmaker: parted wavy locks, sailmaker linen apron
  rui:      { hair: 1, hat: 2, beard: 2, garment: 2, build: 3, accent: 3 }, // Carpenter: cropped red hair, sun hat, barba, carpenter apron, stocky
  maria:    { hair: 3, hat: 1, beard: 0, garment: 0, build: 1, accent: 2 }, // Lookout: queue beneath knitted barrete, lean
  afonso:   { hair: 0, hat: 1, beard: 0, garment: 0, build: 0, accent: 1 }, // Foredeck: bald/clean-shaven under red barrete
  isabel:   { hair: 4, hat: 2, beard: 0, garment: 4, build: 1, accent: 3 }, // Mizzen: blonde nape bun under straw chapéu, waist sash
  pedro:    { hair: 2, hat: 0, beard: 3, garment: 1, build: 3, accent: 2 }, // Helmsman: parted locks, full sea beard, navy wool jerkin, stocky
});

function pickWeightedIndex(roll, weights) {
  let total = 0;
  for (let i = 0; i < weights.length; i++) total += weights[i];
  let r = roll * total;
  for (let i = 0; i < weights.length; i++) {
    r -= weights[i];
    if (r <= 0) return i;
  }
  return weights.length - 1;
}

export function crewComponentMaskForActor(s, index = 0, options = {}) {
  if (!s || s.indigenous) return 0;
  const female = s.sex === 'female';
  const pirate = Boolean(options.pirate || s.attireTheme === 'pirate-brown-black');
  const garrison = Boolean(options.garrison || s.garrison);
  const namedKey = !pirate && !garrison && !s.soul && s.id && NAMED_CREW_PRESETS[s.id] ? s.id : null;
  if (namedKey) {
    const preset = NAMED_CREW_PRESETS[namedKey];
    return packCrewCompMask({ ...preset, beard: female ? 0 : preset.beard });
  }

  const seed = hashCrewString(`${s.soul?.id ?? ''}:${s.id ?? ''}:${s.name ?? ''}:${index}:${pirate ? 'p' : garrison ? 'g' : 'c'}`);
  const rHair = hashCrewAppearance(seed, 1);
  const rHat = hashCrewAppearance(seed, 2);
  const rBeard = hashCrewAppearance(seed, 3);
  const rGar = hashCrewAppearance(seed, 4);
  const rBuild = hashCrewAppearance(seed, 5);
  const rAcc = hashCrewAppearance(seed, 6);

  const hair = female
    ? [0, 2, 3, 4, 5][pickWeightedIndex(rHair, [0.06, 0.25, 0.21, 0.26, 0.22])]
    : [0, 1, 2, 3][pickWeightedIndex(rHair, [0.20, 0.26, 0.28, 0.26])];

  let hat = 0;
  if (garrison) {
    hat = [0, 1, 2, 4][pickWeightedIndex(rHat, [0.10, 0.12, 0.20, 0.58])];
  } else if (pirate) {
    hat = [0, 1, 2, 3, 4][pickWeightedIndex(rHat, [0.28, 0.26, 0.16, 0.22, 0.08])];
  } else {
    hat = female
      ? [0, 1, 2, 3][pickWeightedIndex(rHat, [0.48, 0.20, 0.14, 0.18])]
      : [0, 1, 2, 3][pickWeightedIndex(rHat, [0.50, 0.28, 0.14, 0.08])];
  }

  const beard = female
    ? 0
    : garrison
      ? [0, 1, 2, 3][pickWeightedIndex(rBeard, [0.24, 0.28, 0.36, 0.12])]
      : [0, 1, 2, 3][pickWeightedIndex(rBeard, [0.30, 0.22, 0.26, 0.22])];

  let garment = 0;
  const roleText = String(s.role ?? '').toLowerCase();
  if (/carpenter|sailmaker|cook|surgeon|cooper/.test(roleText) && !garrison && !pirate) {
    garment = 2;
  } else if (garrison) {
    garment = [0, 1, 4][pickWeightedIndex(rGar, [0.18, 0.60, 0.22])];
  } else if (pirate) {
    garment = [0, 1, 4][pickWeightedIndex(rGar, [0.20, 0.36, 0.44])];
  } else {
    garment = [0, 1, 2, 4][pickWeightedIndex(rGar, [0.42, 0.26, 0.08, 0.24])];
  }

  const build = [0, 1, 2, 3][pickWeightedIndex(rBuild, [0.40, 0.22, 0.22, 0.16])];
  const accent = garrison && hat === 4
    ? (rAcc < 0.78 ? (rAcc < 0.45 ? 0 : 3) : (rAcc < 0.90 ? 1 : 2))
    : Math.floor(rAcc * 4) & 3;

  return packCrewCompMask({ hair, hat, beard, garment, build, accent });
}

export function townComponentMaskForLook(modelIndex, lookIndex, random, elite = false) {
  const female = modelIndex === 1;
  const roll = (salt) => (typeof random === 'function' ? random() : hashCrewAppearance(lookIndex * 31 + modelIndex * 97, salt));
  const rHair = roll(1);
  const rHat = roll(2);
  const rBeard = roll(3);
  const rGar = roll(4);
  const rBuild = roll(5);
  const rAcc = roll(6);

  const hair = female
    ? [0, 2, 3, 4, 5][pickWeightedIndex(rHair, [0.04, 0.22, 0.18, 0.30, 0.26])]
    : [0, 1, 2, 3][pickWeightedIndex(rHair, [0.22, 0.28, 0.28, 0.22])];

  const hat = female
    ? [0, 1, 2, 3][pickWeightedIndex(rHat, elite ? [0.45, 0.05, 0.35, 0.15] : [0.44, 0.06, 0.18, 0.32])]
    : [0, 1, 2, 4][pickWeightedIndex(rHat, elite ? [0.30, 0.10, 0.35, 0.25] : [0.48, 0.22, 0.24, 0.06])];

  const beard = female
    ? 0
    : [0, 1, 2, 3][pickWeightedIndex(rBeard, elite ? [0.20, 0.25, 0.45, 0.10] : [0.36, 0.22, 0.26, 0.16])];

  const garment = female
    ? [0, 1, 2, 3, 4][pickWeightedIndex(rGar, [0.08, 0.12, 0.22, 0.50, 0.08])]
    : [0, 1, 2, 4][pickWeightedIndex(rGar, elite ? [0.15, 0.60, 0.05, 0.20] : [0.34, 0.30, 0.22, 0.14])];

  const build = [0, 1, 2, 3][pickWeightedIndex(rBuild, [0.42, 0.22, 0.20, 0.16])];
  const accent = elite ? (rAcc < 0.55 ? 1 : 2) : (Math.floor(rAcc * 4) & 3);

  return packCrewCompMask({ hair, hat, beard, garment, build, accent });
}

// Appends quantized 3D component vertices and near/low LOD index slices onto a loaded crew GLB model.
// Leaves `model.distantIndices` untouched so distant crowd and shadow passes stay <= 320 triangles.
export function attachCrewComponents(model, sex = 'male') {
  if (!model || model.componentsAttached) return model;
  const pack = CREW_COMPONENT_PACKS[sex === 'female' ? 'female' : 'male'];
  if (!pack) return model;

  const baseVertCount = model.vertexCount ?? (model.vertices.byteLength / 60);
  const compVertCount = pack.vertexCount;
  const totalVertCount = baseVertCount + compVertCount;

  const qBytes = decodeCrewComponentB64(pack.verticesQ20B64);
  if (qBytes.byteLength !== compVertCount * 20) {
    throw Error(`Invalid crew component vertex pack (${sex}): ${qBytes.byteLength} bytes`);
  }
  const qView = new DataView(qBytes.buffer, qBytes.byteOffset, qBytes.byteLength);

  const vertices = new Uint8Array(totalVertCount * 60);
  vertices.set(model.vertices, 0);
  const vf = new Float32Array(vertices.buffer, vertices.byteOffset, totalVertCount * 15);
  const vu = new Uint16Array(vertices.buffer, vertices.byteOffset, totalVertCount * 30);

  for (let i = 0; i < compVertCount; i++) {
    const qOff = i * 20;
    const vIdx = baseVertCount + i;
    const fOff = vIdx * 15;
    const uOff = vIdx * 30;

    const px = qView.getInt16(qOff + 0, true) * 1e-4;
    const py = qView.getInt16(qOff + 2, true) * 1e-4;
    const pz = qView.getInt16(qOff + 4, true) * 1e-4;
    const nx0 = qView.getInt8(qOff + 6) / 127;
    const ny0 = qView.getInt8(qOff + 7) / 127;
    const nz0 = qView.getInt8(qOff + 8) / 127;
    const nLen = Math.hypot(nx0, ny0, nz0) || 1;

    const compId = qBytes[qOff + 9];
    const slot = qBytes[qOff + 10];
    const shade = 0.50 + (qBytes[qOff + 11] / 255) * 0.75;

    const j0 = qBytes[qOff + 12];
    const j1 = qBytes[qOff + 13];
    const j2 = qBytes[qOff + 14];
    const j3 = qBytes[qOff + 15];
    const w0 = qBytes[qOff + 16];
    const w1 = qBytes[qOff + 17];
    const w2 = qBytes[qOff + 18];
    const w3 = qBytes[qOff + 19];
    const wSum = (w0 + w1 + w2 + w3) || 255;

    vf[fOff + 0] = px;
    vf[fOff + 1] = py;
    vf[fOff + 2] = pz;
    vf[fOff + 3] = nx0 / nLen;
    vf[fOff + 4] = ny0 / nLen;
    vf[fOff + 5] = nz0 / nLen;
    vf[fOff + 6] = shade;
    vf[fOff + 7] = shade + 2.0 * compId;
    vf[fOff + 8] = shade + 2.0 * slot;
    vu[uOff + 18] = j0;
    vu[uOff + 19] = j1;
    vu[uOff + 20] = j2;
    vu[uOff + 21] = j3;
    vf[fOff + 11] = w0 / wSum;
    vf[fOff + 12] = w1 / wSum;
    vf[fOff + 13] = w2 / wSum;
    vf[fOff + 14] = w3 / wSum;
  }

  const decodeShiftedIndices = (b64) => {
    const raw = decodeCrewComponentB64(b64);
    const dv = new DataView(raw.buffer, raw.byteOffset, raw.byteLength);
    const count = raw.byteLength >> 1;
    const out = new Uint32Array(count);
    for (let i = 0; i < count; i++) out[i] = baseVertCount + dv.getUint16(i * 2, true);
    return out;
  };

  const nearExtra = decodeShiftedIndices(pack.nearIndicesB64);
  const lowExtra = decodeShiftedIndices(pack.lowIndicesB64);

  const baseIndices = model.indices;
  const mergedNear = new Uint32Array(baseIndices.length + nearExtra.length);
  mergedNear.set(baseIndices, 0);
  mergedNear.set(nearExtra, baseIndices.length);

  model.baseVertexCount = baseVertCount;
  model.baseTriangleCount = baseIndices.length / 3;
  model.vertices = vertices;
  model.vertexCount = totalVertCount;
  model.indices = mergedNear;
  if (Array.isArray(model.lods)) {
    model.lods = model.lods.map((tier, level) => {
      if (level === 0) {
        return Object.freeze({
          ...tier,
          indices: mergedNear,
          indexCount: mergedNear.length,
          triangles: mergedNear.length / 3,
          ratio: 1,
        });
      }
      const mergedTier = new Uint32Array(tier.indices.length + lowExtra.length);
      mergedTier.set(tier.indices, 0);
      mergedTier.set(lowExtra, tier.indices.length);
      return Object.freeze({
        ...tier,
        indices: mergedTier,
        indexCount: mergedTier.length,
        triangles: mergedTier.length / 3,
        ratio: mergedTier.length / mergedNear.length,
      });
    });
  }
  model.componentsAttached = true;
  return model;
}

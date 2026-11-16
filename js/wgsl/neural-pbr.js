// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Shared In-Shader WebGPU Neural PBR Material Bank (NPBR v1).
//
// Decodes 12 physical materials directly inside surface shaders using:
//   - Zero sampled textures & zero samplers (respects the 16-texture WebGPU stage ceiling)
//   - 1 read-only storage buffer of Dual-Band snorm8x4 latent mip pyramids (512.25 KB total)
//   - 1 16-byte-aligned uniform buffer of mat4x4f shared PReLU decoder weights (2,384 B)
//   - Positive-homogeneous zero-bias PReLU architecture: f(0) == exact identity (albedoMul=1,
//     normalTS=0, roughDelta=0, cavityAO=1, aniso=0) and mip 6 == 0, guaranteeing zero pop
//     on frame 0 before async asset load and zero far-field mip drift.
//   - Physical Burley/Heitz anisotropic GGX specular NDF that reduces algebraically bit-for-bit
//     to vesselSpecular when aniso == 0.
//
// Designed as a standalone, branch-portable module (`withNeuralPbrVessel`, `withNeuralPbrTerrain`,
// `withNeuralPbrProps`) ready for direct import into `main`.

import {
  NEURAL_PBR_WORDS_PER_BAND,
  NEURAL_PBR_WORDS_PER_MATERIAL,
  NEURAL_PBR_ROT_COS,
  NEURAL_PBR_ROT_SIN,
  NEURAL_PBR_LEAKY_SLOPE,
} from '../models/neural-pbr-weights.js';

export const NEURAL_PBR_MAT = Object.freeze({
  OAK_TIMBER: 0,
  PINE_SPAR: 1,
  WEATHERED_DECK: 2,
  PEDRA_LIOZ: 3,
  LIME_STUCCO: 4,
  TERRACOTTA_TILE: 5,
  LINEN_CANVAS: 6,
  BRAIDED_HEMP: 7,
  CAST_IRON: 8,
  PATINATED_COPPER: 9,
  VOLCANIC_BASALT: 10,
  COBBLE_SOIL: 11,
});

export function createNeuralPbrWGSL({
  group = 0,
  latentBinding = 16,
  weightBinding = 17,
} = {}) {
  return /* wgsl */ `
struct NeuralPbrWeights {
  params: vec4f,
  uvScale: array<vec4f, 12>,
  matMeso: array<vec4f, 12>,
  matMicro: array<vec4f, 12>,
  matGate: array<vec4f, 48>,
  w1Meso0: mat4x4f,
  w1Meso1: mat4x4f,
  w1Meso2: mat4x4f,
  w1Meso3: mat4x4f,
  w1Micro0: mat4x4f,
  w1Micro1: mat4x4f,
  w1Micro2: mat4x4f,
  w1Micro3: mat4x4f,
  w2A0: mat4x4f,
  w2A1: mat4x4f,
  w2A2: mat4x4f,
  w2A3: mat4x4f,
  w2B0: mat4x4f,
  w2B1: mat4x4f,
  w2B2: mat4x4f,
  w2B3: mat4x4f,
};

struct NeuralPbrSample {
  albedoMul: vec3f,
  roughDelta: f32,
  normalTS: vec2f,
  cavityAO: f32,
  aniso: f32,
};

@group(${group}) @binding(${latentBinding}) var<storage, read> neuralPbrLatents: array<u32>;
@group(${group}) @binding(${weightBinding}) var<uniform> NPBR: NeuralPbrWeights;

fn neuralPbrMipOffset(mip: u32) -> u32 {
  return (16384u - (16384u >> (min(mip, 6u) * 2u))) / 3u;
}

fn neuralPbrSampleMip(baseWord: u32, uvWrap: vec2f, mip: u32) -> vec4f {
  if (mip >= 6u) {
    return vec4f(0.0);
  }
  let sz = 64u >> mip;
  let mask = sz - 1u;
  let coord = uvWrap * f32(sz) - 0.5;
  let fl = floor(coord);
  let f = coord - fl;
  let i0 = bitcast<vec2u>(vec2i(fl)) & vec2u(mask);
  let i1 = (i0 + vec2u(1u)) & vec2u(mask);
  let off = baseWord + neuralPbrMipOffset(mip);
  let s00 = unpack4x8snorm(neuralPbrLatents[off + i0.y * sz + i0.x]);
  let s10 = unpack4x8snorm(neuralPbrLatents[off + i0.y * sz + i1.x]);
  let s01 = unpack4x8snorm(neuralPbrLatents[off + i1.y * sz + i0.x]);
  let s11 = unpack4x8snorm(neuralPbrLatents[off + i1.y * sz + i1.x]);
  return mix(mix(s00, s10, f.x), mix(s01, s11, f.x), f.y);
}

fn sampleNeuralPbrBand(matId: u32, band: u32, uv: vec2f, lod: f32) -> vec4f {
  if (lod >= 6.0) {
    return vec4f(0.0);
  }
  let uvWrap = uv - floor(uv);
  let baseWord = min(matId, 11u) * ${NEURAL_PBR_WORDS_PER_MATERIAL}u + band * ${NEURAL_PBR_WORDS_PER_BAND}u;
  let clod = clamp(lod, 0.0, 6.0);
  let m0 = u32(floor(clod));
  let ft = clod - f32(m0);
  let a = neuralPbrSampleMip(baseWord, uvWrap, m0);
  if (ft <= 0.001) {
    return a;
  }
  let b = neuralPbrSampleMip(baseWord, uvWrap, min(m0 + 1u, 6u));
  return mix(a, b, ft);
}

fn evalNeuralPbr(
  matId: u32,
  surfUV: vec2f,
  dUVdx: vec2f,
  dUVdy: vec2f,
  camDist: f32,
  maskWeight: f32
) -> NeuralPbrSample {
  let m = min(matId, 11u);
  let sc = NPBR.uvScale[m];
  let distFade = 1.0 - smoothstep(NPBR.params.w * 0.55, NPBR.params.w, camDist);
  let strength = clamp(NPBR.params.x, 0.0, 2.0) * distFade * clamp(maskWeight, 0.0, 1.0);
  if (strength <= 0.002) {
    return NeuralPbrSample(vec3f(1.0), 0.0, vec2f(0.0), 1.0, 0.0);
  }
  let footM = max(length(dUVdx), length(dUVdy));
  let lod0 = clamp(log2(max(footM * sc.x * 46.0, 1.0)), 0.0, 6.0);
  if (lod0 >= 5.995) {
    return NeuralPbrSample(vec3f(1.0), 0.0, vec2f(0.0), 1.0, 0.0);
  }
  let lod1 = clamp(log2(max(footM * sc.y * 46.0, 1.0)), 0.0, 6.0);
  let uv0 = surfUV * sc.x + vec2f(sc.w, sc.w * 0.618034);
  let uv1 = vec2f(
    uv0.x * ${NEURAL_PBR_ROT_COS} - uv0.y * ${NEURAL_PBR_ROT_SIN},
    uv0.x * ${NEURAL_PBR_ROT_SIN} + uv0.y * ${NEURAL_PBR_ROT_COS}
  ) * 6.85410197;

  let z0 = sampleNeuralPbrBand(m, 0u, uv0, lod0);
  let z1 = sampleNeuralPbrBand(m, 1u, uv1, lod1);
  if (all(z0 == vec4f(0.0)) && all(z1 == vec4f(0.0))) {
    return NeuralPbrSample(vec3f(1.0), 0.0, vec2f(0.0), 1.0, 0.0);
  }

  let m0 = z0 * NPBR.matMeso[m];
  let m1 = z1 * NPBR.matMicro[m];
  let gBase = m * 4u;
  let p0 = NPBR.w1Meso0 * m0 + NPBR.w1Micro0 * m1;
  let p1 = NPBR.w1Meso1 * m0 + NPBR.w1Micro1 * m1;
  let p2 = NPBR.w1Meso2 * m0 + NPBR.w1Micro2 * m1;
  let p3 = NPBR.w1Meso3 * m0 + NPBR.w1Micro3 * m1;
  let slope = f32(${NEURAL_PBR_LEAKY_SLOPE});
  let h0 = select(p0 * slope, p0, p0 >= vec4f(0.0)) * NPBR.matGate[gBase];
  let h1 = select(p1 * slope, p1, p1 >= vec4f(0.0)) * NPBR.matGate[gBase + 1u];
  let h2 = select(p2 * slope, p2, p2 >= vec4f(0.0)) * NPBR.matGate[gBase + 2u];
  let h3 = select(p3 * slope, p3, p3 >= vec4f(0.0)) * NPBR.matGate[gBase + 3u];

  let outA = clamp(
    (NPBR.w2A0 * h0 + NPBR.w2A1 * h1 + NPBR.w2A2 * h2 + NPBR.w2A3 * h3) * 1.35,
    vec4f(-0.68, -0.68, -0.68, -0.42),
    vec4f(0.68, 0.68, 0.68, 0.42)
  ) * strength;
  let outB = clamp(
    (NPBR.w2B0 * h0 + NPBR.w2B1 * h1 + NPBR.w2B2 * h2 + NPBR.w2B3 * h3) * 1.35,
    vec4f(-0.78, -0.78, -0.44, -0.88),
    vec4f(0.78, 0.78, 0.44, 0.88)
  ) * strength;

  return NeuralPbrSample(
    exp2(outA.xyz),
    outA.w * NPBR.params.z,
    outB.xy * NPBR.params.y,
    clamp(1.0 + outB.z, 0.45, 1.15),
    clamp((sc.z * (1.0 - lod0 / 6.0)) * strength + outB.w, -0.90, 0.90)
  );
}

fn neuralPbrTangentBasis(n: vec3f, hintT: vec3f) -> mat2x3f {
  var t = hintT - n * dot(n, hintT);
  if (dot(t, t) < 1e-6) {
    let fallback = select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 0.0, 1.0), abs(n.x) > 0.85);
    t = fallback - n * dot(n, fallback);
  }
  t = normalize(t);
  let b = cross(n, t);
  return mat2x3f(t, b);
}

fn applyNeuralPbrNormal(n: vec3f, basis: mat2x3f, normalTS: vec2f) -> vec3f {
  return normalize(n + basis[0] * normalTS.x + basis[1] * normalTS.y);
}

// Physical Burley/Heitz Anisotropic GGX Specular BRDF.
// Reduces algebraically bit-for-bit to vesselSpecular when aniso == 0.
fn neuralPbrAnisoSpecular(
  n: vec3f,
  basis: mat2x3f,
  v: vec3f,
  l: vec3f,
  rough: f32,
  aniso: f32,
  f0: vec3f
) -> vec3f {
  if (abs(aniso) < 1e-5) {
    return vesselSpecular(n, v, l, rough, f0);
  }
  let h = (v + l) / max(length(v + l), 0.00001);
  let nv = clamp(dot(n, v), 0.001, 1.0);
  let nl = clamp(dot(n, l), 0.0, 1.0);
  let nh = clamp(dot(n, h), 0.0, 1.0);
  let vh = clamp(dot(v, h), 0.0, 1.0);
  // Re-orthonormalize tangent frame around perturbed normal n
  var t = basis[0] - n * dot(n, basis[0]);
  if (dot(t, t) < 1e-6) {
    return vesselSpecular(n, v, l, rough, f0);
  }
  t = normalize(t);
  let b = cross(n, t);
  let a = rough * rough;
  let aspect = sqrt(1.0 - 0.85 * clamp(abs(aniso), 0.0, 0.90));
  let ax = max(0.02, select(a / aspect, a * aspect, aniso >= 0.0));
  let ay = max(0.02, select(a * aspect, a / aspect, aniso >= 0.0));
  let th = dot(t, h) / ax;
  let bh = dot(b, h) / ay;
  let denom = th * th + bh * bh + nh * nh;
  let d = 1.0 / (PI * ax * ay * max(denom * denom, 1e-7));
  let k = pow(rough + 1.0, 2.0) / 8.0;
  let g = (nv / (nv * (1.0 - k) + k)) * (nl / (nl * (1.0 - k) + k));
  return d * g * vesselFresnel(f0, vh) / (4.0 * nv * max(nl, 0.001));
}
`;
}

function neuralPbrReplaceRequired(source, pattern, replacement, label) {
  if (typeof pattern !== 'string') {
    if (!pattern.test(source)) {
      throw new Error(`NeuralPbr WGSL transform missing anchor (${label}): ${pattern}`);
    }
    return source.replace(pattern, replacement);
  }
  const idx = source.indexOf(pattern);
  if (idx === -1) {
    throw new Error(`NeuralPbr WGSL transform missing anchor (${label}): ${String(pattern).slice(0, 80)}`);
  }
  return source.slice(0, idx) + replacement + source.slice(idx + pattern.length);
}

/**
 * Injects Shared Neural PBR Material Bank evaluation & anisotropic GGX fiber/grain specular
 * into CARAVEL / CARAVEL_DAMAGED (compatible across `main`, feature branches, and minified WGSL).
 */
export function withNeuralPbrVessel(source, { group = 0, latentBinding = 16, weightBinding = 17 } = {}) {
  const block = createNeuralPbrWGSL({ group, latentBinding, weightBinding });
  let out = neuralPbrReplaceRequired(
    source,
    /@group\(0\)\s*@binding\(14\)\s*var<storage,\s*read>\s*wetLookup\s*:\s*array<u32>\s*;/,
    match => `${match}\n${block}`,
    'vessel bindings'
  );

  // Compute metric 3D and sail-UV derivatives in uniform control flow
  out = neuralPbrReplaceRequired(
    out,
    /let\s+grainUV\s*=\s*in\.uv\s*;/,
    `let grainUV = in.uv;
  let npbrMetres = p * vec3f(hull.size.x / 3.6, max(hull.right.w, 0.5), hull.size.y / 12.0);
  let npbrDxM = dpdx(npbrMetres);
  let npbrDyM = dpdy(npbrMetres);
  let npbrWorldFootM = max(length(dpdx(in.world)), length(dpdy(in.world)));
  let npbrSailScale = clamp(hull.size.y * 0.34, 6.0, 14.0);
  let npbrSailM = in.uv * npbrSailScale;
  let npbrRawSailDx = dpdx(npbrSailM);
  let npbrRawSailDy = dpdy(npbrSailM);
  let npbrRawSailFoot = max(max(length(npbrRawSailDx), length(npbrRawSailDy)), 1e-6);
  let npbrSailRatio = clamp(npbrWorldFootM / npbrRawSailFoot, 0.18, 2.5);
  let npbrSailDx = npbrRawSailDx * npbrSailRatio;
  let npbrSailDy = npbrRawSailDy * npbrSailRatio;`,
    'vessel uniform derivatives'
  );

  // Decode neural PBR material right before lighting (`let v=normalize(...)`), where all material flags & albedo/rough are finalized
  out = neuralPbrReplaceRequired(
    out,
    /let\s+v\s*=\s*normalize\(\s*F\.camPos\.xyz\s*-\s*in\.world\s*\)\s*;\s*let\s+l\s*=\s*F\.sunDir\.xyz\s*;/,
    `var npbrMatId = 0u;
  var npbrMask = 0.0;
  var npbrUV = vec2f(npbrMetres.z + board * 0.41, npbrMetres.y);
  var npbrDuDx = vec2f(npbrDxM.z, npbrDxM.y);
  var npbrDuDy = vec2f(npbrDyM.z, npbrDyM.y);
  var npbrHintT = rotateHull(vec3f(0.0, 0.0, 1.0));
  let npbrRowingOar = hull.rig.w > 3.5 && hull.rig.w < 6.5 && (in.material == 16u || in.material == 17u) && abs(p.x) > 0.35;
  if (in.material == 11u) {
    npbrMask = 0.0;
  } else if (isCopper || isGilt) {
    npbrMatId = 9u;
    npbrMask = select(0.95, 0.72, isGilt);
    npbrUV = vec2f(npbrMetres.z, npbrMetres.y);
    npbrHintT = rotateHull(vec3f(0.0, 0.0, 1.0));
  } else if (isIron) {
    npbrMatId = 8u;
    npbrMask = 0.92;
    npbrUV = vec2f(npbrMetres.z + npbrMetres.x * 0.5, npbrMetres.y + npbrMetres.x * 0.5);
    npbrDuDx = vec2f(npbrDxM.z + npbrDxM.x * 0.5, npbrDxM.y + npbrDxM.x * 0.5);
    npbrDuDy = vec2f(npbrDyM.z + npbrDyM.x * 0.5, npbrDyM.y + npbrDyM.x * 0.5);
  } else if (in.material == 9u || in.material == 13u) {
    npbrMatId = 6u;
    npbrMask = 0.94;
    npbrUV = npbrSailM;
    npbrDuDx = npbrSailDx;
    npbrDuDy = npbrSailDy;
    npbrHintT = rotateHull(vec3f(0.0, 1.0, 0.0));
  } else if (in.material == 2u || in.material == 12u || in.material == 19u) {
    npbrMatId = 7u;
    npbrMask = 0.92;
    let ropeVertical = abs(in.normalLocal.y) < 0.55;
    npbrUV = select(vec2f(npbrMetres.z + npbrMetres.x, npbrMetres.y), vec2f(npbrMetres.y, npbrMetres.x + npbrMetres.z), ropeVertical);
    npbrDuDx = select(vec2f(npbrDxM.z + npbrDxM.x, npbrDxM.y), vec2f(npbrDxM.y, npbrDxM.x + npbrDxM.z), ropeVertical);
    npbrDuDy = select(vec2f(npbrDyM.z + npbrDyM.x, npbrDyM.y), vec2f(npbrDyM.y, npbrDyM.x + npbrDyM.z), ropeVertical);
    npbrHintT = rotateHull(select(vec3f(0.0, 0.0, 1.0), vec3f(0.0, 1.0, 0.0), ropeVertical));
  } else if (isMastSpar || npbrRowingOar) {
    npbrMatId = 1u;
    npbrMask = 1.0;
    let mastUpright = abs(in.normalLocal.y) < 0.55 && !npbrRowingOar;
    npbrUV = select(vec2f(npbrMetres.x + npbrMetres.z, npbrMetres.y), vec2f(npbrMetres.y, npbrMetres.x - npbrMetres.z), mastUpright);
    npbrDuDx = select(vec2f(npbrDxM.x + npbrDxM.z, npbrDxM.y), vec2f(npbrDxM.y, npbrDxM.x - npbrDxM.z), mastUpright);
    npbrDuDy = select(vec2f(npbrDyM.x + npbrDyM.z, npbrDyM.y), vec2f(npbrDyM.y, npbrDyM.x - npbrDyM.z), mastUpright);
    npbrHintT = rotateHull(select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), mastUpright));
  } else if (in.material == 0u) {
    npbrMatId = 2u;
    npbrMask = 1.0;
    npbrUV = vec2f(npbrMetres.z + deckPlankId * 0.37, npbrMetres.x);
    npbrDuDx = vec2f(npbrDxM.z, npbrDxM.x);
    npbrDuDy = vec2f(npbrDyM.z, npbrDyM.x);
    npbrHintT = rotateHull(vec3f(0.0, 0.0, 1.0));
  } else if (isWood) {
    npbrMatId = 0u;
    npbrMask = select(1.0, 0.85, paintedWood);
    let transomFace = abs(in.normalLocal.z) > 0.75 && in.material != 15u;
    npbrUV = select(vec2f(npbrMetres.z + board * 0.41, npbrMetres.y), vec2f(npbrMetres.x + board * 0.41, npbrMetres.y), transomFace);
    npbrDuDx = select(vec2f(npbrDxM.z, npbrDxM.y), vec2f(npbrDxM.x, npbrDxM.y), transomFace);
    npbrDuDy = select(vec2f(npbrDyM.z, npbrDyM.y), vec2f(npbrDyM.x, npbrDyM.y), transomFace);
    npbrHintT = rotateHull(select(vec3f(0.0, 0.0, 1.0), vec3f(1.0, 0.0, 0.0), transomFace));
  }
  let npbrBasis = neuralPbrTangentBasis(n, npbrHintT);
  let npbrCamDist = distance(in.world, F.camPos.xyz);
  let npbr = evalNeuralPbr(npbrMatId, npbrUV, npbrDuDx, npbrDuDy, npbrCamDist, npbrMask * (1.0 - wet.x * 0.25));
  let npbrAlbedoWeight = select(1.0, 0.45, paintedWood && !isCopper && !isGilt);
  let npbrNormalWeight = select(1.0, 0.78, paintedWood && !isCopper && !isGilt);
  albedo = clamp(albedo * mix(vec3f(1.0), npbr.albedoMul, npbrAlbedoWeight), vec3f(0.004), vec3f(0.98));
  rough = clamp(rough + npbr.roughDelta * (1.0 - wet.x * 0.55), 0.06, 0.98);
  n = applyNeuralPbrNormal(n, npbrBasis, npbr.normalTS * npbrNormalWeight * (1.0 - wet.x * 0.35));
  let v=normalize(F.camPos.xyz-in.world); let l=F.sunDir.xyz;`,
    'vessel material eval'
  );

  out = neuralPbrReplaceRequired(
    out,
    /let\s+ao\s*=\s*mix\(\s*0?\.65\s*,\s*1(?:\.0?)?\s*,\s*smoothstep\(\s*0?\.72\s*,\s*1\.5\s*,\s*p\.y\s*\)\s*\)\s*;/,
    'let ao=mix(0.65,1.0,smoothstep(0.72,1.5,p.y))*npbr.cavityAO;',
    'vessel cavity ao'
  );

  out = neuralPbrReplaceRequired(
    out,
    /let\s+spec\s*=\s*vesselSpecular\(\s*n\s*,\s*v\s*,\s*l\s*,\s*rough\s*,\s*f0\s*\)\s*;/,
    'let spec=neuralPbrAnisoSpecular(n,npbrBasis,v,l,rough,npbr.aniso,f0);',
    'vessel anisotropic specular'
  );

  return out;
}

/**
 * Injects Shared Neural PBR Material Bank evaluation & dry dielectric microfacet sheen
 * into TERRAIN (buildings, roofs, Pedra Lioz masonry, limewash stucco, cobbles, cliffs).
 * Uses `var<private> landNpbrGloss` so non-`landSurface` entry points (`leafFS`, `groundFS`,
 * `canopyOpaqueFS`) never touch the Neural PBR bindings in WebGPU auto-layout reflection.
 */
export function withNeuralPbrTerrain(source, { group = 0, latentBinding = 22, weightBinding = 23 } = {}) {
  const block = createNeuralPbrWGSL({ group, latentBinding, weightBinding });
  let out = neuralPbrReplaceRequired(
    source,
    /@group\(0\)\s*@binding\(15\)\s*var<uniform>\s*townWindow\s*:\s*vec4f\s*;/,
    match => `${match}\n${block}`,
    'terrain bindings'
  );

  out = neuralPbrReplaceRequired(
    out,
    /var<private>\s*landNormalSpread\s*:\s*f32\s*=\s*0(?:\.0?)?\s*;/,
    'var<private> landNormalSpread:f32=0.0;\nvar<private> landNpbrGloss:f32=0.0;',
    'terrain private gloss var'
  );

  // Unlock physical dry dielectric sky reflection & solar specular highlights for smooth microfacets
  // (vitrified terracotta glaze, calcite limestone crystals, burnished stucco, foot-worn cobbles)
  out = neuralPbrReplaceRequired(
    out,
    /let\s+smoothFilm\s*=\s*select\(\s*clamp\(\s*\(\s*0?\.46\s*-\s*effRough\s*\)\s*\/\s*0?\.34\s*,\s*0(?:\.0?)?\s*,\s*1(?:\.0?)?\s*\)\s*\*\s*effWet\s*,\s*1(?:\.0?)?\s*,\s*isMetal\s*\)\s*;/,
    `let npbrDryGloss=clamp((0.68-effRough)/0.42,0.0,1.0)*landNpbrGloss;
  let smoothFilm=select(max(clamp((0.46-effRough)/0.34,0.0,1.0)*effWet,npbrDryGloss*0.52),1.0,isMetal);`,
    'terrain smoothFilm'
  );

  out = neuralPbrReplaceRequired(
    out,
    /let\s+specMask\s*=\s*select\(\s*clamp\(\s*\(\s*0?\.72\s*-\s*effRough\s*\)\s*\/\s*0?\.42\s*,\s*0(?:\.0?)?\s*,\s*1(?:\.0?)?\s*\)\s*\*\s*\(\s*0?\.08\s*\+\s*0?\.92\s*\*\s*effWet\s*\)\s*,\s*0?\.65\s*,\s*isMetal\s*\)\s*;/,
    'let specMask=select(clamp((0.72-effRough)/0.42,0.0,1.0)*max(0.08+0.92*effWet,npbrDryGloss*0.64),0.65,isMetal);',
    'terrain specMask'
  );

  out = neuralPbrReplaceRequired(
    out,
    /let\s+reliefX\s*=\s*dpdx\(\s*relief\s*\)\s*;\s*let\s+reliefY\s*=\s*dpdy\(\s*relief\s*\)\s*;\s*n\s*=\s*landFilteredBump\(\s*n\s*,\s*dx\s*,\s*dy\s*,\s*reliefX\s*,\s*reliefY\s*\)\s*;/,
    `let reliefX=dpdx(relief);let reliefY=dpdy(relief);
  n=landFilteredBump(n,dx,dy,reliefX,reliefY);
  {
    var npbrMat = 10u;
    var npbrWeight = 0.0;
    let horizFace = abs(n.y) > 0.65;
    let wallAlongX = abs(n.z) >= abs(n.x);
    var npbrUV = select(select(vec2f(world.z, world.y), vec2f(world.x, world.y), wallAlongX), world.xz, horizFace);
    var npbrDuDx = select(select(vec2f(dx.z, dx.y), vec2f(dx.x, dx.y), wallAlongX), dx.xz, horizFace);
    var npbrDuDy = select(select(vec2f(dy.z, dy.y), vec2f(dy.x, dy.y), wallAlongX), dy.xz, horizFace);
    var npbrHint = select(select(vec3f(0.0, 0.0, 1.0), vec3f(1.0, 0.0, 0.0), wallAlongX), vec3f(1.0, 0.0, 0.0), horizFace);
    if (in.kind.x < 2.5) {
      let isCobbleWay = roughness < 0.89 && rocky < 0.35;
      npbrMat = select(10u, 11u, isCobbleWay);
      npbrWeight = clamp(max(rocky * 0.92, select(0.0, 0.88, isCobbleWay)) * (1.0 - max(pit.cover, 0.0)), 0.0, 1.0);
    } else if (in.kind.x < 3.5) {
      npbrMat = 0u;
      npbrWeight = 0.65;
      npbrUV = vec2f(world.y, world.x + world.z);
      npbrDuDx = vec2f(dx.y, dx.x + dx.z);
      npbrDuDy = vec2f(dy.y, dy.x + dy.z);
      npbrHint = vec3f(0.0, 1.0, 0.0);
    } else if (in.kind.x >= 9.5 && in.kind.x < 10.5) {
      npbrMat = select(0u, 8u, surfaceWet < -0.01);
      npbrWeight = 0.96;
    } else if (in.kind.x >= 10.5 && in.kind.x < 11.5) {
      npbrMat = 3u;
      npbrWeight = 0.98;
    } else if (in.kind.x >= 11.5 && in.kind.x < 12.5) {
      npbrMat = 4u;
      npbrWeight = 0.94;
    } else if (in.kind.x >= 12.5 && in.kind.x < 13.5) {
      npbrMat = 5u;
      npbrWeight = 1.0;
    } else if (in.kind.x >= 13.5 && in.kind.x < 14.5) {
      npbrMat = 8u;
      npbrWeight = select(0.0, 0.88, surfaceWet < -0.01);
    } else if (in.kind.x >= 14.5 && in.kind.x < 15.5) {
      npbrMat = 7u;
      npbrWeight = 0.82;
    } else if (in.kind.x >= 15.5 && in.kind.x < 16.5) {
      npbrMat = 11u;
      npbrWeight = 0.98;
    } else if (in.kind.x >= 16.5 && in.kind.x < 17.5) {
      npbrMat = 2u;
      npbrWeight = 0.90;
    } else if (in.kind.x >= 17.5 && in.kind.x < 18.5) {
      npbrMat = 8u;
      npbrWeight = 0.95;
    } else if (in.kind.x >= 18.5 && in.kind.x < 19.5) {
      let isPaintedBoards = floor(in.kind.y) > 4.5;
      npbrMat = select(4u, 0u, isPaintedBoards);
      let lumaCur = dot(albedo, vec3f(0.2126, 0.7152, 0.0722));
      npbrWeight = smoothstep(0.035, 0.09, lumaCur) * 0.94;
    } else if (in.kind.x >= 19.5) {
      npbrMat = 3u;
      npbrWeight = 0.78;
    }
    let npbrCamDist = distance(world, F.camPos.xyz);
    landNpbrGloss = clamp(NPBR.params.z, 0.0, 1.5) * clamp(NPBR.params.x, 0.0, 1.5) * (1.0 - smoothstep(NPBR.params.w * 0.55, NPBR.params.w, npbrCamDist));
    let npbr = evalNeuralPbr(npbrMat, npbrUV, npbrDuDx, npbrDuDy, npbrCamDist, npbrWeight);
    let npbrBasis = neuralPbrTangentBasis(n, npbrHint);
    albedo = clamp(albedo * npbr.albedoMul, vec3f(0.005), vec3f(0.98));
    roughness = clamp(roughness + npbr.roughDelta, 0.08, 0.98);
    ambientVisibility = clamp(ambientVisibility * npbr.cavityAO, 0.05, 1.0);
    n = applyNeuralPbrNormal(n, npbrBasis, npbr.normalTS);
  }`,
    'terrain landSurface neural pbr'
  );

  return out;
}

/**
 * Injects Shared Neural PBR Material Bank evaluation & anisotropic GGX specular
 * into PROPS_RENDER (dockside crates, barrels, timber balks, cordage, stone bollards, canvas bales).
 * Works across both `main` and feature branches (plus minified WGSL).
 */
export function withNeuralPbrProps(source, { group = 0, latentBinding = 14, weightBinding = 15 } = {}) {
  const block = createNeuralPbrWGSL({ group, latentBinding, weightBinding });
  let out = neuralPbrReplaceRequired(
    source,
    /@group\(0\)\s*@binding\(12\)\s*var\s+pigmentSampler\s*:\s*sampler\s*;/,
    match => `${match}\n${block}`,
    'props bindings'
  );

  out = neuralPbrReplaceRequired(
    out,
    /let\s+albedo\s*=\s*textureSample\(\s*pigment\s*,\s*pigmentSampler\s*,\s*v\.uv\s*\)\.rgb\s*;/,
    'var albedo=textureSample(pigment,pigmentSampler,v.uv).rgb;',
    'props mutable albedo'
  );

  // Classify prop surface chromaticity/luminance into timber, hemp/canvas, stone, or iron hardware
  out = neuralPbrReplaceRequired(
    out,
    /n\s*=\s*normalize\(\s*n\s*-\s*clamp\(\s*propGrad\s*,\s*vec3f\(\s*-0?\.26\s*\)\s*,\s*vec3f\(\s*0?\.26\s*\)\s*\)\s*\)\s*;/,
    `n=normalize(n-clamp(propGrad,vec3f(-0.26),vec3f(0.26)));
  let npbrHoriz = abs(n.y) > 0.65;
  let npbrAlongX = abs(n.z) >= abs(n.x);
  let npbrUV = select(select(vec2f(v.world.z, v.world.y), vec2f(v.world.x, v.world.y), npbrAlongX), v.world.xz, npbrHoriz);
  let npbrDuDx = select(select(vec2f(dx.z, dx.y), vec2f(dx.x, dx.y), npbrAlongX), dx.xz, npbrHoriz);
  let npbrDuDy = select(select(vec2f(dy.z, dy.y), vec2f(dy.x, dy.y), npbrAlongX), dy.xz, npbrHoriz);
  let npbrHint = select(select(vec3f(0.0, 0.0, 1.0), vec3f(1.0, 0.0, 0.0), npbrAlongX), vec3f(1.0, 0.0, 0.0), npbrHoriz);
  let npbrWarmth = (albedo.r - albedo.b) / max(luma, 0.04);
  var npbrMat = 0u;
  if (luma < 0.085 && abs(npbrWarmth) < 0.22) {
    npbrMat = 8u;
  } else if (luma > 0.42 && npbrWarmth < 0.32) {
    npbrMat = 6u;
  } else if (abs(npbrWarmth) < 0.16) {
    npbrMat = 3u;
  }
  let npbrBasis = neuralPbrTangentBasis(n, npbrHint);
  let npbr = evalNeuralPbr(npbrMat, npbrUV, npbrDuDx, npbrDuDy, distance(v.world, F.camPos.xyz), 0.94);
  albedo = clamp(albedo * npbr.albedoMul * npbr.cavityAO, vec3f(0.015), vec3f(0.96));
  n = applyNeuralPbrNormal(n, npbrBasis, npbr.normalTS);`,
    'props normal eval'
  );

  out = neuralPbrReplaceRequired(
    out,
    /let\s+rough\s*=\s*clamp\(([^;]+)\)\s*;\s*let\s+f0\s*=\s*vec3f\(\s*0?\.04\s*\)\s*;\s*let\s+spec\s*=\s*vesselSpecular\(\s*n\s*,\s*view\s*,\s*sun\s*,\s*rough\s*,\s*f0\s*\)\s*;/,
    (_m, roughArgs) =>
      `let rough=clamp(clamp(${roughArgs})+npbr.roughDelta,0.12,0.94);let f0=vec3f(.04);let spec=neuralPbrAnisoSpecular(n,npbrBasis,view,sun,rough,npbr.aniso,f0);`,
    'props rough spec'
  );

  return out;
}

/**
 * Injects Shared Neural PBR Material Bank evaluation & anisotropic GGX specular
 * into TRADE_VESSELS (`tradeVesselsSource`: cogs, carracks, caravels, harbor barques, river barges).
 */
export function withNeuralPbrTradeVessels(source, { group = 1, latentBinding = 3, weightBinding = 4 } = {}) {
  const block = createNeuralPbrWGSL({ group, latentBinding, weightBinding });
  let out = neuralPbrReplaceRequired(
    source,
    /@group\(1\)\s*@binding\(1\)\s*var\s+oakSampler\s*:\s*sampler\s*;/,
    match => `${match}\n${block}`,
    'trade vessels bindings'
  );

  out = neuralPbrReplaceRequired(
    out,
    /let\s+tvNpbrMarker\s*=\s*1\s*;/,
    `let npbrDxM = dpdx(tvMetres);
  let npbrDyM = dpdy(tvMetres);
  let npbrWorldFootM = max(length(dpdx(in.world)), length(dpdy(in.world)));
  let npbrSailScale = clamp(tvScaleMetres.z * 3.8, 5.5, 13.5);
  let npbrSailM = in.uv * npbrSailScale;
  let npbrRawSailDx = dpdx(npbrSailM);
  let npbrRawSailDy = dpdy(npbrSailM);
  let npbrRawSailFoot = max(max(length(npbrRawSailDx), length(npbrRawSailDy)), 1e-6);
  let npbrSailRatio = clamp(npbrWorldFootM / npbrRawSailFoot, 0.18, 2.5);
  let npbrSailDx = npbrRawSailDx * npbrSailRatio;
  let npbrSailDy = npbrRawSailDy * npbrSailRatio;`,
    'trade vessels uniform derivatives'
  );

  out = neuralPbrReplaceRequired(
    out,
    /let\s+sunDir\s*=\s*normalize\(\s*F\.sunDir\.xyz\s*\)\s*;\s*let\s+viewDir\s*=\s*normalize\(\s*F\.camPos\.xyz\s*-\s*in\.world\s*\)\s*;/,
    `var npbrMatId = 0u;
  var npbrMask = 0.0;
  var npbrUV = vec2f(tvMetres.z + floor(course) * 0.41, tvMetres.y);
  var npbrDuDx = vec2f(npbrDxM.z, npbrDxM.y);
  var npbrDuDy = vec2f(npbrDyM.z, npbrDyM.y);
  var npbrHintT = rotateVessel(vec3f(0.0, 0.0, 1.0), tvYaw, tvPitch, tvRoll);
  let tvPaintedWood = (m >= 20u && m <= 26u && m != 22u && m != 23u && m != 25u);
  if (m == 11u) {
    npbrMask = 0.0;
  } else if (m == 22u || m == 25u) {
    npbrMatId = 9u;
    npbrMask = select(0.95, 0.72, m == 25u);
    npbrUV = vec2f(tvMetres.z, tvMetres.y);
  } else if (m == 27u) {
    npbrMatId = 5u;
    npbrMask = 0.94;
    npbrUV = vec2f(tvMetres.x + tvMetres.z, tvMetres.y);
    npbrDuDx = vec2f(npbrDxM.x + npbrDxM.z, npbrDxM.y);
    npbrDuDy = vec2f(npbrDyM.x + npbrDyM.z, npbrDyM.y);
  } else if (m == 3u || m == 8u) {
    npbrMatId = 8u;
    npbrMask = 0.92;
    npbrUV = vec2f(tvMetres.z + tvMetres.x * 0.5, tvMetres.y + tvMetres.x * 0.5);
    npbrDuDx = vec2f(npbrDxM.z + npbrDxM.x * 0.5, npbrDxM.y + npbrDxM.x * 0.5);
    npbrDuDy = vec2f(npbrDyM.z + npbrDyM.x * 0.5, npbrDyM.y + npbrDyM.x * 0.5);
  } else if (m == 9u || m == 13u || m == 23u) {
    npbrMatId = 6u;
    npbrMask = 0.94;
    npbrUV = select(vec2f(tvMetres.x + tvMetres.z, tvMetres.y), npbrSailM, m != 23u);
    npbrDuDx = select(vec2f(npbrDxM.x + npbrDxM.z, npbrDxM.y), npbrSailDx, m != 23u);
    npbrDuDy = select(vec2f(npbrDyM.x + npbrDyM.z, npbrDyM.y), npbrSailDy, m != 23u);
    npbrHintT = rotateVessel(vec3f(0.0, 1.0, 0.0), tvYaw, tvPitch, tvRoll);
  } else if (m == 2u || m == 12u || m == 19u) {
    npbrMatId = 7u;
    npbrMask = 0.92;
    let ropeVertical = abs(in.normalLocal.y) < 0.55;
    npbrUV = select(vec2f(tvMetres.z + tvMetres.x, tvMetres.y), vec2f(tvMetres.y, tvMetres.x + tvMetres.z), ropeVertical);
    npbrDuDx = select(vec2f(npbrDxM.z + npbrDxM.x, npbrDxM.y), vec2f(npbrDxM.y, npbrDxM.x + npbrDxM.z), ropeVertical);
    npbrDuDy = select(vec2f(npbrDyM.z + npbrDyM.x, npbrDyM.y), vec2f(npbrDyM.y, npbrDyM.x + npbrDyM.z), ropeVertical);
    npbrHintT = rotateVessel(select(vec3f(0.0, 0.0, 1.0), vec3f(0.0, 1.0, 0.0), ropeVertical), tvYaw, tvPitch, tvRoll);
  } else if (m == 10u || isLusoriaOar || isLusoriaSweep) {
    npbrMatId = 1u;
    npbrMask = 1.0;
    let mastUpright = abs(in.normalLocal.y) < 0.55 && !isLusoriaOar && !isLusoriaSweep;
    npbrUV = select(vec2f(tvMetres.x + tvMetres.z, tvMetres.y), vec2f(tvMetres.y, tvMetres.x - tvMetres.z), mastUpright);
    npbrDuDx = select(vec2f(npbrDxM.x + npbrDxM.z, npbrDxM.y), vec2f(npbrDxM.y, npbrDxM.x - npbrDxM.z), mastUpright);
    npbrDuDy = select(vec2f(npbrDyM.x + npbrDyM.z, npbrDyM.y), vec2f(npbrDyM.y, npbrDyM.x - npbrDyM.z), mastUpright);
    npbrHintT = rotateVessel(select(vec3f(1.0, 0.0, 0.0), vec3f(0.0, 1.0, 0.0), mastUpright), tvYaw, tvPitch, tvRoll);
  } else if (m == 0u) {
    npbrMatId = 2u;
    npbrMask = 1.0;
    npbrUV = vec2f(tvMetres.z + floor(deckCourse) * 0.37, tvMetres.x);
    npbrDuDx = vec2f(npbrDxM.z, npbrDxM.x);
    npbrDuDy = vec2f(npbrDyM.z, npbrDyM.x);
    npbrHintT = rotateVessel(vec3f(0.0, 0.0, 1.0), tvYaw, tvPitch, tvRoll);
  } else if (isWoodMat(m) || m == 28u || tvPaintedWood) {
    npbrMatId = 0u;
    npbrMask = select(1.0, 0.85, tvPaintedWood);
    let transomFace = abs(in.normalLocal.z) > 0.72 && m != 15u;
    npbrUV = select(vec2f(tvMetres.z + floor(course) * 0.41, tvMetres.y), vec2f(tvMetres.x + floor(course) * 0.41, tvMetres.y), transomFace);
    npbrDuDx = select(vec2f(npbrDxM.z, npbrDxM.y), vec2f(npbrDxM.x, npbrDxM.y), transomFace);
    npbrDuDy = select(vec2f(npbrDyM.z, npbrDyM.y), vec2f(npbrDyM.x, npbrDyM.y), transomFace);
    npbrHintT = rotateVessel(select(vec3f(0.0, 0.0, 1.0), vec3f(1.0, 0.0, 0.0), transomFace), tvYaw, tvPitch, tvRoll);
  }
  let npbrBasis = neuralPbrTangentBasis(n, npbrHintT);
  let npbrCamDist = distance(in.world, F.camPos.xyz);
  let npbr = evalNeuralPbr(npbrMatId, npbrUV, npbrDuDx, npbrDuDy, npbrCamDist, npbrMask * (1.0 - tvWet * 0.25));
  let npbrAlbedoWeight = select(1.0, 0.45, tvPaintedWood);
  let npbrNormalWeight = select(1.0, 0.78, tvPaintedWood);
  albedo = clamp(albedo * mix(vec3f(1.0), npbr.albedoMul, npbrAlbedoWeight), vec3f(0.004), vec3f(0.98));
  rough = clamp(rough + npbr.roughDelta * (1.0 - tvWet * 0.55), 0.06, 0.98);
  n = applyNeuralPbrNormal(n, npbrBasis, npbr.normalTS * npbrNormalWeight * (1.0 - tvWet * 0.35));
  let sunDir = normalize(F.sunDir.xyz);
  let viewDir = normalize(F.camPos.xyz - in.world);`,
    'trade vessels material eval'
  );

  out = neuralPbrReplaceRequired(
    out,
    /let\s+spec\s*=\s*select\(\s*vec3f\(\s*0(?:\.0?)?\s*\)\s*,\s*vesselSpecular\(\s*n\s*,\s*viewDir\s*,\s*sunDir\s*,\s*rough\s*,\s*f0\s*\)\s*\*\s*sunRad\s*\*\s*nDotL\s*,\s*nDotL\s*>\s*0(?:\.0?)?\s*\)\s*;/,
    'let spec = select(vec3f(0.0), neuralPbrAnisoSpecular(n, npbrBasis, viewDir, sunDir, rough, npbr.aniso, f0) * sunRad * nDotL, nDotL > 0.0);',
    'trade vessels anisotropic specular'
  );

  out = neuralPbrReplaceRequired(
    out,
    /let\s+lit\s*=\s*diffTint\s*\*\s*amb\s*\*\s*0?\.82/,
    'let lit = diffTint * amb * (0.82 * npbr.cavityAO)',
    'trade vessels cavity ao'
  );

  return out;
}

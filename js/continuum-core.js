// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The one continuum's shared core (AGENTS.md rule 3, item 7). Every family drawn across distance takes from here
// its projected error, its sample-mask handoff, its splat and thinning limits, and the scene's one pixel-error
// scalar, so the continuum is defined once and families supply only data. Loaded early in the bundle, before any
// family that reads it; nothing here may name a family.

// Below this projected span, in pixels at the base pixel error (and in proportion to the error the cut allows), a
// body morphs into its single view-facing horizon splat.
export const CONTINUUM_SPLAT_PIXELS = 3.5;
// From this span down to CONTINUUM_SPLAT_PIXELS a body's coarsest mesh hands over to its splat, smoothly: by
// morphing its last step into the splat's shape, or by giving the splat a rising share of each pixel's samples.
export const CONTINUUM_SPLAT_BAND_PIXELS = 5.25;
// Below this span the splat is thinned by a deterministic hash and the survivors are inflated to keep its area.
export const CONTINUUM_MIN_PIXELS = 1.0;
// A splat is the triangle that circumscribes its outline's ellipse (corners (0, 2) and (±√3, -1) of the ellipse's
// radii), shrunk by this to the ellipse's own area: √(π / 3√3).
export const CONTINUUM_SPLAT_AREA = Math.sqrt(Math.PI / (3 * Math.sqrt(3)));
// Where a finer side of a body hands over to a coarser one (clusters to the far body, leaves to the crown), both
// are worn, sample by sample, over this share of the distance at which the handoff begins.
export const CONTINUUM_HANDOFF_BAND = 0.3;
// The scene's one triangle budget, in submitted triangles (rule 3, item 5).
export const CONTINUUM_TRIANGLE_BUDGET = 3_000_000;
// The pixel error the scene's cut is drawn at before any governor moves it.
export const CONTINUUM_BASE_PIXEL_ERROR = 3;
// What the player is looking at, speaking to or firing upon, and whatever is wounded or struck, is cut at this share
// of the base pixel error (rule 3, item 5), and yields to the budget only as the square root of the scene's coarsening:
// when a governor doubles the scene's error, an important instance's grows by √2, so it keeps four times the share of
// the budget it had. Every family's importance is this one weight.
export const CONTINUUM_IMPORTANT = 0.5;
// The nearest an eye is taken to be to any surface, in metres (the camera's near plane): a cluster or body whose
// bound holds the eye is judged at this distance, so the eye inside a body sees it at its finest, never culled.
export const CONTINUUM_NEAREST = 0.05;
// A far body's collapse step, as the one bake writes it and the one cut reads it: the triangles alive (a prefix of
// the far body's triangles in order of death), the error in metres, how far along its normals the surface is grown to
// keep the outline its collapses take in, and a spare word.
export const CONTINUUM_STEP_WORDS = 4;
// The most collapses one far-body vertex may pass through, as far as the GPU follows them: the bake refuses a body
// deeper than this, and an atlas records it in its header.
export const CONTINUUM_HOPS = 256;
// A far-body vertex's optical moments, as the one bake writes them after its steps (js/continuum-bake.js
// continuumFarOptics) and the one cut morphs them (js/wgsl/continuum-cut.js continuumFarOptic): its own and its
// region's normal, agreement, sky, depth, through and albedo, in this many words; one more entry, the whole body's.
export const CONTINUUM_OPTICS_WORDS = 5;

// How fast the scalar glides toward the error a governor aims it at: it closes this share of the way a second (as a
// ratio: in its logarithm), and never moves faster than CONTINUUM_GLIDE_MOST of its logarithm a second, so detail comes
// and goes through the morph and the sample-mask bands, a little each frame, and never at once (rule 3, item 5).
export const CONTINUUM_GLIDE_RATE = 2.5;
export const CONTINUUM_GLIDE_MOST = 0.6;

let continuumScenePixelError = CONTINUUM_BASE_PIXEL_ERROR, continuumScenePixelAim = CONTINUUM_BASE_PIXEL_ERROR;
// The scene's one pixel-error scalar. Every family's cut reads it each frame; only a frame-time or budget governor
// moves it, and it is the only thing a governor may move.
export function continuumPixelError() { return continuumScenePixelError; }
// The error the scalar is gliding toward.
export function continuumAimedPixelError() { return continuumScenePixelAim; }
// How much coarser than its own base each family's cut is drawn: 1 at the base error, 2 when it has doubled.
export function continuumCoarsening() { return continuumScenePixelError / CONTINUUM_BASE_PIXEL_ERROR; }
// Sets the scalar at once, where nothing is yet drawn by it (a scene laid out, a test's measure).
export function setContinuumPixelError(pixels) {
  if (Number.isFinite(pixels) && pixels > 0) continuumScenePixelError = continuumScenePixelAim = pixels;
  return continuumScenePixelError;
}
// A governor's word: the error the scalar is to glide to (stepContinuumPixelError).
export function aimContinuumPixelError(pixels) {
  if (Number.isFinite(pixels) && pixels > 0) continuumScenePixelAim = pixels;
  return continuumScenePixelAim;
}
// The scalar moved `seconds` further toward its aim, once a frame before the cuts read it.
export function stepContinuumPixelError(seconds) {
  const gap = Math.log(continuumScenePixelAim / continuumScenePixelError);
  if (!(Math.abs(gap) > 1e-4)) { continuumScenePixelError = continuumScenePixelAim; return continuumScenePixelError; }
  if (!(seconds > 0)) return continuumScenePixelError;
  const step = Math.sign(gap) * Math.min(Math.abs(gap) * (1 - Math.exp(-CONTINUUM_GLIDE_RATE * Math.min(seconds, 0.25))), CONTINUUM_GLIDE_MOST * Math.min(seconds, 0.25));
  continuumScenePixelError *= Math.exp(step);
  return continuumScenePixelError;
}

// One symmetric parameter schema for any scene's Continuum cut: every field has a neutral identity default so an
// unprofiled scene behaves identically to the raw core constants, while profiled scenes supply data through the same
// uniform layout (curve: vec4f, limits: vec4f) without branching or per-family selection code.
export const CONTINUUM_DEFAULT_PROFILE = Object.freeze({
  errorScale: 1,
  taperMetres: 0,
  taperPower: 1,
  splatScale: 1,
  minPixels: CONTINUUM_MIN_PIXELS,
  maxDistance: 0,
  shadowMinError: 0,
  shadowMaxDistance: 0,
});

export function normalizeContinuumProfile(spec = null) {
  const s = spec && typeof spec === 'object' ? spec : CONTINUUM_DEFAULT_PROFILE;
  const pos = (v, d) => (Number.isFinite(v) && v > 0 ? v : d);
  const nonNeg = (v, d) => (Number.isFinite(v) && v >= 0 ? v : d);
  return Object.freeze({
    errorScale: pos(s.errorScale, CONTINUUM_DEFAULT_PROFILE.errorScale),
    taperMetres: nonNeg(s.taperMetres, CONTINUUM_DEFAULT_PROFILE.taperMetres),
    taperPower: pos(s.taperPower, CONTINUUM_DEFAULT_PROFILE.taperPower),
    splatScale: pos(s.splatScale, CONTINUUM_DEFAULT_PROFILE.splatScale),
    minPixels: pos(s.minPixels, CONTINUUM_DEFAULT_PROFILE.minPixels),
    maxDistance: nonNeg(s.maxDistance, CONTINUUM_DEFAULT_PROFILE.maxDistance),
    shadowMinError: nonNeg(s.shadowMinError, CONTINUUM_DEFAULT_PROFILE.shadowMinError),
    shadowMaxDistance: nonNeg(s.shadowMaxDistance, CONTINUUM_DEFAULT_PROFILE.shadowMaxDistance),
  });
}

// Packs a normalized profile into 8 floats: curve (errorScale, invTaperMetres, splatScale, taperPower) and
// limits (minPixels, maxDistance, shadowMinError, shadowMaxDistance).
export function packContinuumProfile(spec = null, out = new Float32Array(8), offset = 0) {
  const p = normalizeContinuumProfile(spec);
  out[offset] = p.errorScale;
  out[offset + 1] = p.taperMetres > 0 ? 1 / p.taperMetres : 0;
  out[offset + 2] = p.splatScale;
  out[offset + 3] = p.taperPower;
  out[offset + 4] = p.minPixels;
  out[offset + 5] = p.maxDistance;
  out[offset + 6] = p.shadowMinError;
  out[offset + 7] = p.shadowMaxDistance;
  return out;
}

// The same core for the GPU. A shader takes it once, at the top of its source; it defines only `continuum*` names.
export const CONTINUUM_CORE_WGSL = /* wgsl */`
const CONTINUUM_SPLAT_PIXELS: f32 = ${CONTINUUM_SPLAT_PIXELS.toFixed(4)};
const CONTINUUM_SPLAT_BAND_PIXELS: f32 = ${CONTINUUM_SPLAT_BAND_PIXELS.toFixed(4)};
const CONTINUUM_MIN_PIXELS: f32 = ${CONTINUUM_MIN_PIXELS.toFixed(4)};
const CONTINUUM_SPLAT_AREA: f32 = ${CONTINUUM_SPLAT_AREA.toFixed(6)};
const CONTINUUM_HANDOFF_BAND: f32 = ${CONTINUUM_HANDOFF_BAND.toFixed(4)};
const CONTINUUM_IMPORTANT: f32 = ${CONTINUUM_IMPORTANT.toFixed(4)};
const CONTINUUM_BASE_PIXEL_ERROR: f32 = ${CONTINUUM_BASE_PIXEL_ERROR.toFixed(4)};
const CONTINUUM_NEAREST: f32 = ${CONTINUUM_NEAREST.toFixed(4)};
// The pixel error an instance is cut at: the scene's, or for one that matters CONTINUUM_IMPORTANT of the geometric
// mean of the scene's and the base error, so it stays sharp as the budget coarsens the scene and yields only slowly.
fn continuumImportance(pixels: f32, important: bool) -> f32 {
  if (!important) { return pixels; }
  return min(pixels, CONTINUUM_IMPORTANT * sqrt(pixels * CONTINUUM_BASE_PIXEL_ERROR));
}
fn continuumHash(value: u32) -> u32 {
  var x = value;
  x = (x ^ (x >> 16u)) * 0x7feb352du;
  x = (x ^ (x >> 15u)) * 0x846ca68bu;
  return x ^ (x >> 16u);
}
// How many pixels a length of 'size' metres spans at 'distance' metres, for a focal length given in pixels.
fn continuumPixels(size: f32, focal: f32, distance: f32) -> f32 { return size * focal / max(distance, 1e-4); }
// The geometric error, in metres, a cut may leave at 'distance' and stay within 'pixels' on screen.
fn continuumAllowedError(pixels: f32, focal: f32, distance: f32) -> f32 { return pixels * distance / max(focal, 1e-4); }
// The coarser side's share of a handoff that begins 'start' metres away, at 'distance': 0 short of it, 1 once
// the band (CONTINUUM_HANDOFF_BAND of 'start') is crossed.
fn continuumHandoff(distance: f32, start: f32) -> f32 { return clamp((distance - start) / max(start * CONTINUUM_HANDOFF_BAND, 1e-6), 0.0, 1.0); }
// The splat's share of a body that spans 'pixels' where the cut allows 'error' pixels: 0 above
// CONTINUUM_SPLAT_BAND_PIXELS, 1 at and below CONTINUUM_SPLAT_PIXELS, at the base error and in proportion to the
// error allowed. A body whose whole span is about the error allowed is no more than its splat, so as the one scalar
// coarsens the scene the splat takes over sooner, as every other step of the cut does, and an important body later.
// A family either morphs its last step toward the splat by it or splits samples by it.
fn continuumSplatShare(pixels: f32, error: f32) -> f32 {
  return 1.0 - smoothstep(CONTINUUM_SPLAT_PIXELS, CONTINUUM_SPLAT_BAND_PIXELS, pixels * CONTINUUM_BASE_PIXEL_ERROR / max(error, 1e-3));
}
// The samples of a pixel, of 'samples' (1 to 8), that the coarser side of a handoff takes when it holds 'share'
// of the pixel. The finer side gives up exactly these (the same call, inverted against the full mask), so each
// sample is drawn once and the change needs no blending. Every pixel rounds the share its own way, which spreads
// the change evenly; 'seed' lets overlapping bodies differ, and 0 gives the forest's own pattern.
fn continuumSamples(share: f32, pixel: vec2f, samples: u32, seed: u32) -> u32 {
  if (share <= 0.0) { return 0u; }
  let n = clamp(samples, 1u, 8u);
  let p = vec2u(pixel);
  let random = continuumHash(p.x ^ continuumHash((p.y * 0x9e3779b9u + 0x51ed270bu) ^ seed));
  let count = min(n, u32(floor(share * f32(n) + f32(random & 65535u) / 65536.0)));
  let bits = (1u << count) - 1u;
  let rotation = (random >> 16u) % n;
  return ((bits << rotation) | (bits >> (n - rotation))) & ((1u << n) - 1u);
}
// A horizon splat under CONTINUUM_MIN_PIXELS is kept by a deterministic hash of 'seed' with probability
// (pixels / CONTINUUM_MIN_PIXELS)^2 and the survivors are inflated by CONTINUUM_MIN_PIXELS / pixels, so the
// horizon keeps its covered area without sub-pixel shimmer. 0 means thinned away; otherwise the radius scale.
fn continuumThin(pixels: f32, seed: u32) -> f32 {
  if (pixels >= CONTINUUM_MIN_PIXELS) { return 1.0; }
  let least = 0.16 * CONTINUUM_MIN_PIXELS;
  let keep = pixels / CONTINUUM_MIN_PIXELS;
  if (pixels < least || f32(continuumHash(seed) & 65535u) / 65535.0 > keep * keep) { return 0.0; }
  return CONTINUUM_MIN_PIXELS / max(pixels, least);
}
// Symmetric profile evaluation on the GPU: curve = (errorScale, invTaperMetres, splatScale, taperPower),
// limits = (minPixels, maxDistance, shadowMinError, shadowMaxDistance). Reduces identically to the base core at
// CONTINUUM_DEFAULT_PROFILE while allowing rich near-field detail and rapid, pop-free distance taper per scene.
fn continuumProfilePixels(pixels: f32, important: bool, distance: f32, curve: vec4f) -> f32 {
  let base = continuumImportance(pixels, important) * max(curve.x, 0.05);
  let taperRate = max(curve.y, 0.0) * select(1.0, CONTINUUM_IMPORTANT, important);
  let u = max(distance, 0.0) * taperRate;
  let power = max(curve.w, 1.0);
  return base * (1.0 + select(u, pow(max(u, 1e-6), power), u > 0.0 && abs(power - 1.0) > 1e-3));
}
fn continuumProfileSplatShare(pixels: f32, error: f32, curve: vec4f) -> f32 {
  let scale = max(curve.z, 0.25);
  return 1.0 - smoothstep(CONTINUUM_SPLAT_PIXELS * scale, CONTINUUM_SPLAT_BAND_PIXELS * scale, pixels * CONTINUUM_BASE_PIXEL_ERROR / max(error, 1e-3));
}
fn continuumProfileThin(pixels: f32, distance: f32, limits: vec4f, seed: u32) -> f32 {
  let maxDist = limits.y;
  if (maxDist > 0.0 && distance >= maxDist) { return 0.0; }
  let minPx = max(limits.x, 0.1);
  var scale = 1.0;
  var keepProb = 1.0;
  if (pixels < minPx) {
    let least = 0.16 * minPx;
    if (pixels < least) { return 0.0; }
    let keep = pixels / minPx;
    keepProb = keep * keep;
    scale = minPx / max(pixels, least);
  }
  if (maxDist > 0.0 && distance > maxDist * 0.80) {
    keepProb *= 1.0 - smoothstep(maxDist * 0.80, maxDist, distance);
  }
  if (keepProb < 1.0 && f32(continuumHash(seed) & 65535u) / 65535.0 > keepProb) { return 0.0; }
  return scale;
}
// The cluster cut's own test: a cluster is drawn where its projected error is within 'allowed' pixels and its
// parent's is not, so exactly one level of every part of the hierarchy is drawn. Errors are in metres at the
// instance's scale, and each sphere's centre is already placed relative to the camera, however the family places
// it (a joint matrix, a yaw and scale, a hull frame). A sphere that holds the eye is judged at CONTINUUM_NEAREST, as
// the cut's candidate prefix is, so the clusters an eye inside a body needs are always among those tried.
fn continuumClusterDrawn(ownError: f32, ownCentre: vec3f, ownRadius: f32, parentError: f32, parentCentre: vec3f, parentRadius: f32, focal: f32, allowed: f32) -> bool {
  if (continuumPixels(parentError, focal, max(length(parentCentre) - parentRadius, CONTINUUM_NEAREST)) <= allowed) { return false; }
  return continuumPixels(ownError, focal, max(length(ownCentre) - ownRadius, CONTINUUM_NEAREST)) <= allowed;
}
`;

// The cut's two searches, written once and bound to each family's own tables. WGSL functions cannot take a
// storage array portably, so each search is generated around an expression that reads the family's table.
//
// Clusters are stored coarsest parent first, so the clusters that can be drawn at an instance's nearest point are a
// prefix: those whose parent's error is above 'finest' (metres, at the instance's scale). 'parentErrorAt' maps a
// WGSL index expression to that cluster's parent error.
export function continuumClusterPrefixWGSL(name, parentErrorAt) {
  return /* wgsl */`
fn ${name}(first: u32, count: u32, finest: f32) -> u32 {
  var low = 0u; var high = count;
  while (low < high) { let middle = (low + high) / 2u; if (${parentErrorAt('first + middle')} > finest) { low = middle + 1u; } else { high = middle; } }
  return low;
}`;
}
// A progressive mesh's collapse steps carry rising errors. The step drawn is the last whose error is within
// 'allowed' metres, morphing toward the next by how far 'allowed' has gone between them: vec2f(step, morphT).
// 'errorAt' maps a WGSL step expression to that step's error, so any base, stride or packing reads the same.
export function continuumMorphStepWGSL(name, errorAt) {
  return /* wgsl */`
fn ${name}(steps: u32, allowed: f32) -> vec2f {
  var low = 0u; var high = steps;
  while (low < high) { let middle = (low + high + 1u) / 2u; if (${errorAt('middle')} <= allowed) { low = middle; } else { high = middle - 1u; } }
  if (low >= steps) { return vec2f(f32(steps), 0.0); }
  let e0 = ${errorAt('low')}; let e1 = ${errorAt('low + 1u')};
  return vec2f(f32(low), clamp((allowed - e0) / max(e1 - e0, 1e-5), 0.0, 1.0));
}`;
}

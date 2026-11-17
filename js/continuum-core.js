// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The one continuum's shared core (AGENTS.md rule 3, item 7). Every family drawn across distance takes from here
// its projected error, its sample-mask handoff, its splat and thinning limits, and the scene's one pixel-error
// scalar, so the continuum is defined once and families supply only data. Loaded early in the bundle, before any
// family that reads it; nothing here may name a family.

// Below this projected span, in pixels, a body morphs into its single view-facing horizon splat.
export const CONTINUUM_SPLAT_PIXELS = 3.5;
// Below this span the splat is thinned by a deterministic hash and the survivors are inflated to keep its area.
export const CONTINUUM_MIN_PIXELS = 1.0;
// The scene's one triangle budget, in submitted triangles (rule 3, item 5).
export const CONTINUUM_TRIANGLE_BUDGET = 3_000_000;
// The pixel error the scene's cut is drawn at before any governor moves it.
export const CONTINUUM_BASE_PIXEL_ERROR = 3;

let continuumScenePixelError = CONTINUUM_BASE_PIXEL_ERROR;
// The scene's one pixel-error scalar. Every family's cut reads it each frame; only a frame-time or budget governor
// sets it, and it is the only thing a governor may move.
export function continuumPixelError() { return continuumScenePixelError; }
// How much coarser than its own base each family's cut is drawn: 1 at the base error, 2 when it has doubled.
export function continuumCoarsening() { return continuumScenePixelError / CONTINUUM_BASE_PIXEL_ERROR; }
export function setContinuumPixelError(pixels) {
  if (Number.isFinite(pixels) && pixels > 0) continuumScenePixelError = pixels;
  return continuumScenePixelError;
}

// The same core for the GPU. A shader takes it once, at the top of its source; it defines only `continuum*` names.
export const CONTINUUM_CORE_WGSL = /* wgsl */`
const CONTINUUM_SPLAT_PIXELS: f32 = ${CONTINUUM_SPLAT_PIXELS.toFixed(4)};
const CONTINUUM_MIN_PIXELS: f32 = ${CONTINUUM_MIN_PIXELS.toFixed(4)};
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
// The cluster cut's own test: a cluster is drawn where its projected error is within 'allowed' pixels and its
// parent's is not, so exactly one level of every part of the hierarchy is drawn. Errors are in metres at the
// instance's scale, and each sphere's centre is already placed relative to the camera, however the family places
// it (a joint matrix, a yaw and scale, a hull frame).
fn continuumClusterDrawn(ownError: f32, ownCentre: vec3f, ownRadius: f32, parentError: f32, parentCentre: vec3f, parentRadius: f32, focal: f32, allowed: f32) -> bool {
  if (continuumPixels(parentError, focal, max(length(parentCentre) - parentRadius, 0.001)) <= allowed) { return false; }
  return continuumPixels(ownError, focal, max(length(ownCentre) - ownRadius, 0.001)) <= allowed;
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

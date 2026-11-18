// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The ground the land draws (AGENTS.md rule 3). The land's continuum cut (js/land-continuum.js) draws its ground off
// the true ground by up to about the scene's pixel error: a coarse patch lies on its corners' line, and a point comes
// down to the ground only as the error it waits for falls under what the scene allows. Every family that stands on
// the ground stands on the true ground, so each frame the land publishes, on the GPU, how far its drawn ground lies
// from the true one: a field about the camera of (drawn height - true height), written from the patches and morphs its
// cut has just chosen (landGroundWrite in js/wgsl/land-continuum.js). A family adds it where it stands
// (continuumGroundLift): at an instance's anchor, or at each vertex of what is draped on the ground. Physics, gunnery,
// footing and collision go on standing on the true ground; this is only where the ground is drawn.
//
// The field is a stack of levels, each CONTINUUM_GROUND_TEXELS square about the camera at twice the last's spacing,
// so a texel spans about the same share of its distance everywhere; one stack for the view's cut and one for the
// water captures', which are cut coarser. A level's texels stay fixed on the world as the camera moves. Loaded early
// in the bundle, before the land and every family that reads it.

// Texels across a level, and the spacing of the finest, in metres.
export const CONTINUUM_GROUND_TEXELS = 256;
export const CONTINUUM_GROUND_TEXEL_M = 0.5;
// Levels in a stack: the coarsest reaches some 64 km from the camera, past every piece of land drawn.
export const CONTINUUM_GROUND_LEVELS = 11;
// The land's cuts the field is written for: the view's, then the water captures' (js/water-optics.js).
export const CONTINUUM_GROUND_CUTS = 2;
// The share of a level's reach over which it hands over to the next coarser level.
export const CONTINUUM_GROUND_BLEND = 0.15;
// The square of texels one workgroup writes.
export const CONTINUUM_GROUND_TILE = 8;
// How far the drawn ground may lie from the true one, in multiples of the error the scene allows at that distance
// (with the morph's handoff band): what a family's culling sphere leaves room for when it stands on the drawn ground.
export const CONTINUUM_GROUND_REACH = 2.0;

// The field's texture, one for every device: the land writes it each frame, and every family reads it. Until the
// land writes it, it holds nothing: every family stands on the true ground.
const continuumGroundFields = new WeakMap();
export function continuumGroundField(device) {
  let field = continuumGroundFields.get(device);
  if (!field) {
    const T = globalThis.GPUTextureUsage;
    const texture = device.createTexture({
      label: 'continuum ground field',
      size: [CONTINUUM_GROUND_TEXELS, CONTINUUM_GROUND_TEXELS, CONTINUUM_GROUND_CUTS * CONTINUUM_GROUND_LEVELS],
      format: 'r32float', dimension: '2d',
      usage: T.STORAGE_BINDING | T.TEXTURE_BINDING | T.COPY_DST,
    });
    field = { texture, view: texture.createView({ dimension: '2d-array' }) };
    continuumGroundFields.set(device, field);
  }
  return field;
}
// The view every family binds (continuumGroundWGSL).
export const continuumGroundView = (device) => continuumGroundField(device).view;
// No land any longer: the field is emptied, and every family stands on the true ground again.
export function continuumGroundForget(device) {
  const field = continuumGroundFields.get(device);
  if (!field) return;
  const R = CONTINUUM_GROUND_TEXELS, layers = CONTINUUM_GROUND_CUTS * CONTINUUM_GROUND_LEVELS;
  device.queue.writeTexture({ texture: field.texture }, new Float32Array(R * R * layers), { bytesPerRow: R * 4, rowsPerImage: R }, [R, R, layers]);
}

// Where each level lies, for the land that writes the field and every family that reads it: in the frame's world
// (the frame of Frame.camPos). Names only `continuumGround*`.
export const CONTINUUM_GROUND_PLACE_WGSL = /* wgsl */`
const CONTINUUM_GROUND_TEXELS: i32 = ${CONTINUUM_GROUND_TEXELS};
const CONTINUUM_GROUND_LEVELS: u32 = ${CONTINUUM_GROUND_LEVELS}u;
const CONTINUUM_GROUND_TEXEL_M: f32 = ${CONTINUUM_GROUND_TEXEL_M.toFixed(4)};
const CONTINUUM_GROUND_BLEND: f32 = ${CONTINUUM_GROUND_BLEND.toFixed(4)};
const CONTINUUM_GROUND_REACH: f32 = ${CONTINUUM_GROUND_REACH.toFixed(4)};
// A level's spacing: a power of two of the finest's, so every level's place below is exact.
fn continuumGroundSpacing(level: u32) -> f32 { return ldexp(CONTINUUM_GROUND_TEXEL_M, i32(level)); }
// The world x and z of a level's first texel's corner, about the camera 'eye' (x, z) on the level's own grid.
fn continuumGroundOrigin(level: u32, eye: vec2f) -> vec2f {
  let spacing = continuumGroundSpacing(level);
  return (floor(eye / spacing) - f32(CONTINUUM_GROUND_TEXELS / 2)) * spacing;
}
// How far from the camera, along either axis, a level is read to: every texel a point's bilinear read takes there
// lies in the level, wherever the camera stands in its centre texel.
fn continuumGroundReachOf(level: u32) -> f32 { return f32(CONTINUUM_GROUND_TEXELS / 2 - 2) * continuumGroundSpacing(level); }
// How far, along either axis, the finer levels serve every point without this one: within it, nothing reads it.
fn continuumGroundUnread(level: u32) -> f32 {
  if (level == 0u) { return -1.0; }
  return continuumGroundReachOf(level - 1u) * (1.0 - CONTINUUM_GROUND_BLEND) - 2.0 * continuumGroundSpacing(level);
}
`;

// What a family adds to read the field: the texture at (group, binding), and continuumGroundLift(xz), how far the
// land draws its ground above the true ground at a point of the frame's world, for the view's cut (or, with
// continuumGroundLiftCut, cut 1: the water captures'). The source it is added to names its frame 'F'.
export function continuumGroundWGSL(group, binding) {
  return CONTINUUM_GROUND_PLACE_WGSL + /* wgsl */`
@group(${group}) @binding(${binding}) var continuumGroundTexture: texture_2d_array<f32>;
fn continuumGroundAt(xz: vec2f, cut: u32, level: u32) -> f32 {
  let spacing = continuumGroundSpacing(level);
  let q = (xz - continuumGroundOrigin(level, F.camPos.xz)) / spacing - 0.5;
  let i = clamp(vec2i(floor(q)), vec2i(0), vec2i(CONTINUUM_GROUND_TEXELS - 2));
  let f = clamp(q - vec2f(i), vec2f(0.0), vec2f(1.0));
  let layer = i32(cut * CONTINUUM_GROUND_LEVELS + level);
  let a = textureLoad(continuumGroundTexture, i, layer, 0).r;
  let b = textureLoad(continuumGroundTexture, i + vec2i(1, 0), layer, 0).r;
  let c = textureLoad(continuumGroundTexture, i + vec2i(0, 1), layer, 0).r;
  let d = textureLoad(continuumGroundTexture, i + vec2i(1, 1), layer, 0).r;
  return mix(mix(a, b, f.x), mix(c, d, f.x), f.y);
}
// The finest level that reaches a point, handing over to the next across the last CONTINUUM_GROUND_BLEND of its
// reach; nothing past the coarsest.
fn continuumGroundLiftCut(xz: vec2f, cut: u32) -> f32 {
  let away = max(abs(xz.x - F.camPos.x), abs(xz.y - F.camPos.z));
  var level = u32(clamp(ceil(log2(max(away, 1e-3) / continuumGroundReachOf(0u))), 0.0, f32(CONTINUUM_GROUND_LEVELS - 1u)));
  if (level > 0u && away <= continuumGroundReachOf(level - 1u)) { level -= 1u; }
  if (away > continuumGroundReachOf(level) && level + 1u < CONTINUUM_GROUND_LEVELS) { level += 1u; }
  let reach = continuumGroundReachOf(level);
  if (away >= reach) { return 0.0; }
  let lift = continuumGroundAt(xz, cut, level);
  let start = reach * (1.0 - CONTINUUM_GROUND_BLEND);
  if (away <= start) { return lift; }
  let next = select(0.0, continuumGroundAt(xz, cut, level + 1u), level + 1u < CONTINUUM_GROUND_LEVELS);
  return mix(lift, next, smoothstep(start, reach, away));
}
fn continuumGroundLift(xz: vec2f) -> f32 { return continuumGroundLiftCut(xz, 0u); }
// How far the drawn ground may lie from the true one 'distance' metres from the camera, for a cut at 'pixels' of
// error and a focal length of 'focal' pixels: what a culling sphere grows by to hold what stands on the drawn ground.
fn continuumGroundBound(pixels: f32, focal: f32, distance: f32) -> f32 {
  return CONTINUUM_GROUND_REACH * (1.0 + CONTINUUM_HANDOFF_BAND) * pixels * max(distance, 0.0) / max(focal, 1e-4);
}
`;
}

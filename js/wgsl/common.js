// Shared constants and WGSL snippets.
export const N = 256;          // FFT resolution per cascade
export const LOGN = 8;
export const CASCADES = 6;
export const SKY_W = 256;      // sky-view LUT size
export const SKY_H = 144;
export const ENV_SIZE = 256;   // environment cube face size
export const ENV_MIPS = 9;
// Battle damage a hull's uniform buffer holds. See hull-flood.js.
export const HULL_HOLE_LIMIT = 24;
export const HULL_CRATER_LIMIT = 127;
// The frame's clock, Frame.camPos.w, starts again after this many seconds: the spectrum's time loop.
export const SIM_CLOCK_LOOP_S = 600;

// The frame block has no vec4 to spare, so its two fire lights ride in components nothing else reads
// (see Frame below, and worldFireSurface in sky.js): light 0 is x, y, z, intensity at floats 23, 27, 31, 54,
// light 1 at 55, 61, 62, 87. One patch from the first to the last of them carries a change to the GPU.
export const FRAME_FIRE_SLOTS = Object.freeze([23, 27, 31, 54, 55, 61, 62, 87]);
export const FRAME_FIRE_PATCH_FIRST = 23;
export const FRAME_FIRE_PATCH_FLOATS = 65;
const FRAME_FIRE_MERGE_M2 = 144;   // fires within 12 m burn as one light
const FRAME_FIRE_SUN_Y = 33, FRAME_FIRE_EXPOSURE = 68;
let frameFireClusters = new Float64Array(4 * 16);   // x, y, z, weight; grown only past its high-water mark

/**
 * Chooses the two fire lights the frame can carry and writes them into its fire slots, touching no
 * other float. Fires close together merge into one light at their weighted centre; the two that
 * matter most from the eye win. Reads the sun's height and the exposure from the frame, so it runs
 * after those are written. Returns whether any slot changed, so an unchanged frame needs no upload.
 */
export function packFrameFireLights(frame, fires, eyeX, eyeY, eyeZ) {
  let count = 0, clusters = frameFireClusters;
  const total = Array.isArray(fires) ? fires.length : 0;
  for (let i = 0; i < total; i++) {
    const fire = fires[i], position = fire?.position, strength = fire?.intensity ?? 0;
    if (!position || !(strength > 0.01)) continue;
    let merged = false;
    for (let c = 0; c < count * 4; c += 4) {
      const dx = clusters[c] - position[0], dy = clusters[c + 1] - position[1], dz = clusters[c + 2] - position[2];
      if (dx * dx + dy * dy + dz * dz >= FRAME_FIRE_MERGE_M2) continue;
      const weight = clusters[c + 3], sum = weight + strength;
      clusters[c] = (clusters[c] * weight + position[0] * strength) / sum;
      clusters[c + 1] = (clusters[c + 1] * weight + position[1] * strength) / sum;
      clusters[c + 2] = (clusters[c + 2] * weight + position[2] * strength) / sum;
      clusters[c + 3] = Math.min(3.6, sum);
      merged = true;
      break;
    }
    if (merged) continue;
    if (count * 4 === clusters.length) {
      const larger = new Float64Array(clusters.length * 2);
      larger.set(clusters);
      clusters = frameFireClusters = larger;
    }
    const c = count++ * 4;
    clusters[c] = position[0]; clusters[c + 1] = position[1]; clusters[c + 2] = position[2];
    clusters[c + 3] = Math.min(3.2, strength);
  }
  // The strongest two as seen from the eye; the earlier fire keeps its place in a tie.
  let first = -1, second = -1, firstScore = -Infinity, secondScore = -Infinity;
  for (let c = 0; c < count * 4; c += 4) {
    const score = clusters[c + 3] / (1 + Math.hypot(clusters[c] - eyeX, clusters[c + 1] - eyeY, clusters[c + 2] - eyeZ) * 0.02);
    if (score > firstScore) { second = first; secondScore = firstScore; first = c; firstScore = score; }
    else if (score > secondScore) { second = c; secondScore = score; }
  }
  // Fires hold their own against a bright exposure and carry further at night.
  const night = 1 - Math.max(0, Math.min(1, (frame[FRAME_FIRE_SUN_Y] + 0.06) / 0.24));
  const exposure = Math.min(1.0, 1.35 / Math.max(frame[FRAME_FIRE_EXPOSURE] || 1, 1e-3)) * (1.0 + 2.8 * night);
  let changed = false;
  for (let light = 0; light < 2; light++) {
    const c = light ? second : first, slot = light * 4;
    for (let k = 0; k < 4; k++) {
      const value = Math.fround(c < 0 ? 0 : k < 3 ? clusters[c + k] : clusters[c + 3] * exposure);
      const at = FRAME_FIRE_SLOTS[slot + k];
      if (frame[at] !== value) { frame[at] = value; changed = true; }
    }
  }
  return changed;
}

// Per-frame uniform block shared by every render / sky shader.
// Layout must match the Float32Array offsets in main.js (FR_* constants).
export const FRAME_WGSL = /* wgsl */ `
// Earth-curvature drop (metres) for a camera-relative position, with standard
// refraction (k = 0.13 -> effective radius 6371 km / (1 - k)). The ocean stays a
// flat plane at y = 0, so the eye-height geometric horizon distance is removed
// first: the drop is exactly zero inside ~8-13 km (landfall range unchanged) and
// beyond it land sinks so that h < (d - dh)^2 / 2R' is hidden behind the sea.
// Pure (eye height passed in) so it compiles in every module including Frame.
fn earthDrop(rel: vec3f, eyeY: f32) -> f32 {
  let RE = 7.32298851e6;
  let dh = sqrt(2.0 * RE * max(eyeY, 0.5));
  let e = max(length(rel.xz) - dh, 0.0);
  return e * e / (2.0 * RE);
}
// Camera-relative position bent by earthDrop: use for clip-space only.
fn earthCurve(rel: vec3f, eyeY: f32) -> vec3f {
  return vec3f(rel.x, rel.y - earthDrop(rel, eyeY), rel.z);
}
struct Frame {
  viewProj: mat4x4f,   // camera-relative view-projection (reverse-Z, infinite)
  camPos:   vec4f,     // xyz metres, w = time (s)
  camRight: vec4f,     // xyz * tan(fovX/2), w = fire light 0 x
  camUp:    vec4f,     // xyz * tan(fovY/2), w = fire light 0 y
  camFwd:   vec4f,     // xyz, w = fire light 0 z
  sunDir:   vec4f,     // xyz towards sun, w = solar illuminance scale
  screen:   vec4f,     // w, h, 1/w, 1/h
  cascL:    array<vec4f, 2>,  // cascade patch sizes (m), index [c>>2][c&3]; past the last cascade, [1].zw = swell height, swell length
  cascInvL: array<vec4f, 2>,  // their reciprocals; past the last cascade, [1].z = fire light 0 intensity, [1].w = fire light 1 x
  windP:    array<vec4f, 2>,  // [0] = wind direction xy, wind speed, swell direction; [1] = hull heading, fire light 1 y, fire light 1 z, reflection enable
  lodP:     vec4f,     // CDLOD base range, grid quads per node, foam level sizes
  post:     vec4f,     // exposure, bloom strength, frame index, debug view
  atmo:     vec4f,     // haze, camera altitude km, lightning horizontal direction x/z
  waterCol: vec4f,     // body scatter colour rgb, unresolved slope variance
  sssCol:   vec4f,     // sss colour rgb, sss strength
  foamP:    vec4f,     // J threshold, J gain, foam intensity, fire light 1 intensity
  fogExt:   vec4f,     // rgb extinction per metre near sea level
  reserved: vec4f,     // precipitation intensity/type, lightning radiance, weather clock
};
`;

export const ATMO_CORE_WGSL = /* wgsl */ `
const PI: f32 = 3.14159265358979;
const RG: f32 = 6360.0;
const RT: f32 = 6460.0;
const RAY_S: vec3f = vec3f(5.802e-3, 13.558e-3, 33.1e-3);
const MIE_S: f32 = 3.996e-3;
const MIE_E: f32 = 4.40e-3;
const OZO_A: vec3f = vec3f(0.650e-3, 1.881e-3, 0.085e-3);
const SUN_ANG_R: f32 = 0.004675;
const TRANS_W: f32 = 256.0;
const TRANS_H: f32 = 64.0;
const MS_SIZE: f32 = 32.0;

// Fraction of an angular disc visible above a spherical opaque planet.
// Separate from atmosphere transmittance: LUT clamping cannot supply occlusion.
fn planetDiskVisibility(radius:f32,mu:f32,angularRadius:f32)->f32 {
  let r=max(radius,RG);let horizon=-sqrt(max(0.0,1.0-(RG/r)*(RG/r)));
  let d=clamp((mu-horizon)/angularRadius,-1.0,1.0);
  return (acos(-d)+d*sqrt(max(0.0,1.0-d*d)))/PI;
}

struct Medium { ext: vec3f, rayS: vec3f, mieS: f32 };

fn medium(h: f32, haze: f32) -> Medium {
  let hh = max(h, 0.0);
  let dR = exp(-hh / 8.0);
  // aerosols: regular 1.2 km layer plus a dense marine boundary layer
  let dM = exp(-hh / 1.2);
  let dO = max(0.0, 1.0 - abs(hh - 25.0) / 15.0);
  var m: Medium;
  m.rayS = RAY_S * dR;
  m.mieS = MIE_S * dM * haze;
  m.ext = m.rayS + vec3f(MIE_E * dM * haze) + OZO_A * dO;
  return m;
}

fn raySphere(ro: vec3f, rd: vec3f, R: f32) -> vec2f {
  let l = length(ro);
  let b = dot(ro, rd);
  let c = (l - R) * (l + R);
  let d = b * b - c;
  if (d < 0.0) { return vec2f(-1.0, -1.0); }
  let s = sqrt(d);
  return vec2f(-b - s, -b + s);
}

fn rhoOf(r: f32) -> f32 { return sqrt(max(0.0, (r - RG) * (r + RG))); }

fn transRMuToUV(r: f32, mu: f32) -> vec2f {
  let H = sqrt(RT * RT - RG * RG);
  let rho = rhoOf(r);
  let disc = r * r * (mu * mu - 1.0) + RT * RT;
  let d = max(0.0, -r * mu + sqrt(max(disc, 0.0)));
  let dMin = RT - r;
  let dMax = rho + H;
  let x = (d - dMin) / (dMax - dMin);
  let y = rho / H;
  return vec2f(x, y);
}

fn transUVToRMu(uv: vec2f) -> vec2f {
  let H = sqrt(RT * RT - RG * RG);
  let rho = H * uv.y;
  let r = sqrt(rho * rho + RG * RG);
  let dMin = RT - r;
  let dMax = rho + H;
  let d = dMin + uv.x * (dMax - dMin);
  var mu = 1.0;
  if (d > 0.0) { mu = (H * H - rho * rho - d * d) / (2.0 * r * d); }
  return vec2f(r, clamp(mu, -1.0, 1.0));
}

fn fromUnitToSubUvs(u: f32, res: f32) -> f32 { return (u + 0.5 / res) * (res / (res + 1.0)); }
fn fromSubUvsToUnit(u: f32, res: f32) -> f32 { return (u - 0.5 / res) * (res / (res - 1.0)); }

fn phaseRayleigh(c: f32) -> f32 { return 3.0 / (16.0 * PI) * (1.0 + c * c); }
fn phaseMie(c: f32, g: f32) -> f32 {
  let g2 = g * g;
  return 3.0 / (8.0 * PI) * ((1.0 - g2) * (1.0 + c * c)) / ((2.0 + g2) * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
}
fn phaseHG(c: f32, g: f32) -> f32 {
  let g2 = g * g;
  return (1.0 - g2) / (4.0 * PI * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5));
}

// true when the sun is below the geometric horizon of a point at radius r
fn sunBelowHorizon(r: f32, mu: f32) -> bool {
  return mu < -rhoOf(r) / r;
}
`;

// Hashing helpers used by the procedural texture generators.
export const NOISE_WGSL = /* wgsl */ `
fn pcgHash(v: u32) -> u32 {
  let s = v * 747796405u + 2891336453u;
  let w = ((s >> ((s >> 28u) + 4u)) ^ s) * 277803737u;
  return (w >> 22u) ^ w;
}
fn hashGrad(i: vec2i) -> vec2f {
  let h = pcgHash(u32(i.x) * 1664525u + pcgHash(u32(i.y) + 1013904223u));
  let a = f32(h) * (6.28318530718 / 4294967296.0);
  return vec2f(cos(a), sin(a));
}
fn gnoise(p: vec2f) -> f32 {
  let i = vec2i(floor(p));
  let f = p - floor(p);
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  let a = dot(hashGrad(i), f);
  let b = dot(hashGrad(i + vec2i(1, 0)), f - vec2f(1.0, 0.0));
  let c = dot(hashGrad(i + vec2i(0, 1)), f - vec2f(0.0, 1.0));
  let d = dot(hashGrad(i + vec2i(1, 1)), f - vec2f(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
`;

// Periodic (tileable) noise for procedural textures. Requires NOISE_WGSL.
export const PERIODIC_WGSL = /* wgsl */ `
fn pnoise(p: vec2f, period: i32) -> f32 {
  let i = vec2i(floor(p));
  let f = p - floor(p);
  let u = f * f * f * (f * (f * 6.0 - 15.0) + 10.0);
  let i00 = (i % period + period) % period;
  let i10 = ((i + vec2i(1, 0)) % period + period) % period;
  let i01 = ((i + vec2i(0, 1)) % period + period) % period;
  let i11 = ((i + vec2i(1, 1)) % period + period) % period;
  let a = dot(hashGrad(i00), f);
  let b = dot(hashGrad(i10), f - vec2f(1.0, 0.0));
  let c = dot(hashGrad(i01), f - vec2f(0.0, 1.0));
  let d = dot(hashGrad(i11), f - vec2f(1.0, 1.0));
  return mix(mix(a, b, u.x), mix(c, d, u.x), u.y);
}
fn pfbm(p: vec2f, period: i32, oct: i32) -> f32 {
  var s = 0.0; var a = 0.5; var q = p; var per = period;
  for (var o = 0; o < oct; o++) {
    s += a * pnoise(q, per);
    q *= 2.0; per *= 2; a *= 0.5;
  }
  return s;
}
`;

// Fractional coverage, with bounded production and decay; no additive saturation.
export const FOAM_MODEL = /* wgsl */ `
fn breakingCompression(jxx: f32, jzz: f32, jxz: f32, threshold: f32) -> f32 {
  let least=1.0+0.5*(jxx+jzz)-sqrt(0.25*(jxx-jzz)*(jxx-jzz)+jxz*jxz);
  return smoothstep(0.0,0.65,threshold-least);
}
fn foamCoverage(previous: f32, breaking: f32, amount: f32, decay: f32, dt: f32) -> f32 {
  let production=breaking*amount*2.2;
  let rate=production+decay;
  let equilibrium=production/max(rate,0.001);
  return clamp(equilibrium+(previous-equilibrium)*exp(-rate*dt),0.0,1.0);
}
`;

// Only a NaN's bits can be trusted: WGSL lets a compiler assume there is none, so a comparison with
// itself may be folded away. The whole pixel goes black, since one channel going would leave the
// colour of the other two as a coloured dot. Infinity is the top of the half-float range, which is
// where any overflow lands on Apple's GPUs, and so a sun too bright for the format stays white.
export const SANE_HDR = /* wgsl */ `
fn saneHDR(c: vec3f) -> vec3f {
  let nan = (bitcast<vec3u>(c) & vec3u(0x7fffffffu)) > vec3u(0x7f800000u);
  return select(clamp(c, vec3f(0.0), vec3f(65504.0)), vec3f(0.0), any(nan));
}
`;

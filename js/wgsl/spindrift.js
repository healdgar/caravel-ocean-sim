import { FRAME_WGSL, ATMO_CORE_WGSL, NOISE_WGSL, FOAM_MODEL } from './common.js';
import { HULL_PROFILE } from './hull.js';
import { SHADOW_SAMPLE } from './shadows.js';

export const SPINDRIFT_COUNT = 1024;
export const SPINDRIFT_STATE = /* wgsl */ `
struct CrestPlume {
  origin: vec4f, // birth position, age
  launch: vec4f, // initial velocity, lifetime (zero = vacant)
  crest: vec4f,  // crest tangent, initial half width
  shape: vec4f,  // strength, seed, birth wind x/z
};
// Aerodynamic entrainment of a mist parcel, with an authored settling rate.
// Birth data stays in world space when the camera or wind changes.
fn plumePosition(p: CrestPlume, t: f32) -> vec3f {
  let wind = vec3f(p.shape.z, 0.0, p.shape.w) * 0.68;
  let entrain = (1.0 - exp(-1.5 * t)) / 1.5;
  let horizontal = wind * t + (vec3f(p.launch.x, 0.0, p.launch.z) - wind) * entrain;
  return p.origin.xyz + horizontal + vec3f(0.0, p.launch.y * t - 1.25 * t * t, 0.0);
}
`;

export const SPINDRIFT_UPDATE = /* wgsl */ `
${FRAME_WGSL}
${SPINDRIFT_STATE}
${FOAM_MODEL}
${NOISE_WGSL}
${HULL_PROFILE}
struct CrestControl { step: vec4f }; // dt, reset, amount, frame
struct CrestHull { right: vec4f, up: vec4f, forward: vec4f, size: vec4f, origin: vec4f, rig: vec4f };
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<uniform> C: CrestControl;
@group(0) @binding(2) var<uniform> hull: CrestHull;
@group(0) @binding(3) var displacement: texture_2d_array<f32>;
@group(0) @binding(4) var derivatives: texture_2d_array<f32>;
@group(0) @binding(5) var seaSampler: sampler;
@group(0) @binding(6) var<storage, read_write> plumes: array<CrestPlume>;
fn crestRandom(seed: u32) -> f32 { return f32(pcgHash(seed)) / 4294967296.0; }
fn crestDisplacement(q: vec2f) -> vec3f {
  var d = vec3f(0.0);
  for (var c = 0u; c < 6u; c++) {
    let invL = F.cascInvL[c >> 2u][c & 3u];
    let mip = max(0.0, log2(256.0 * invL * 0.65));
    d += textureSampleLevel(displacement, seaSampler, fract(q * invL), i32(c), mip).xyz;
  }
  return d;
}
@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) id: vec3u) {
  if (id.x >= ${SPINDRIFT_COUNT}u) { return; }
  var p = plumes[id.x];
  if (C.step.y > 0.5 || C.step.z <= 0.0) {
    p.launch.w = 0.0; plumes[id.x] = p; return;
  }
  let dt = C.step.x;
  if (p.launch.w > 0.0) {
    p.origin.w += dt;
    let head = plumePosition(p, p.origin.w);
    var landed = false;
    // Stagger collision work. Two displacement samples invert the horizontal wave offset.
    if ((id.x + u32(C.step.w)) % 4u == 0u && p.origin.w > 0.25) {
      let q = head.xz - crestDisplacement(head.xz).xz;
      landed = head.y < crestDisplacement(q).y - 0.15;
    }
    if (p.origin.w >= p.launch.w || distance(head.xz, F.camPos.xz) > 85.0 || landed) { p.launch.w = 0.0; }
    plumes[id.x] = p;
    return;
  }
  let seed = pcgHash(id.x + u32(C.step.w) * 104729u);
  let wind = F.windP[0].xy * F.windP[0].z;
  // A smooth, authored onset: breaking alone does not make airborne spindrift.
  let windLift = smoothstep(8.0, 19.0, F.windP[0].z);
  if (windLift == 0.0 || crestRandom(seed) > 1.0 - exp(-4.0 * windLift * C.step.z * dt)) { return; }
  let cell = vec2f(f32(id.x % 32u), f32(id.x / 32u)) - 15.5;
  let jitter = vec2f(crestRandom(seed + 1u), crestRandom(seed + 2u)) - 0.5;
  let q = floor(F.camPos.xz / 4.0) * 4.0 + (cell + jitter) * 4.0;
  if (distance(q, F.camPos.xz) > 70.0) { return; }
  // Reject samples behind the observer before fetching the six cascades.
  if (dot(vec3f(q.x, F.camPos.y, q.y) - F.camPos.xyz, F.camFwd.xyz) < -8.0) { return; }
  var d = vec4f(0.0); var deriv = vec4f(0.0);
  for (var c = 0u; c < 6u; c++) {
    let invL = F.cascInvL[c >> 2u][c & 3u];
    let mip = max(0.0, log2(256.0 * invL * 0.65));
    d += textureSampleLevel(displacement, seaSampler, fract(q * invL), i32(c), mip);
    deriv += textureSampleLevel(derivatives, seaSampler, fract(q * invL), i32(c), mip);
  }
  let breaking = breakingCompression(deriv.z, deriv.w, d.w, 0.45);
  if (crestRandom(seed + 3u) >= breaking) { return; }
  let origin = vec3f(q.x + d.x, d.y + 0.12, q.y + d.z);
  if (hull.rig.z > 0.5) {
    let delta = origin - hull.origin.xyz;
    let local = vec3f(dot(delta, hull.right.xyz) * 3.6 / hull.size.x,
      dot(delta, hull.up.xyz), -dot(delta, hull.forward.xyz) * 12.0 / hull.size.y);
    if (hullExcludesOcean(local)) { return; }
  }
  // The compressed principal direction gives the local crest's tangent.
  let angle = 0.5 * atan2(2.0 * d.w, deriv.z - deriv.w);
  let tangent = vec3f(cos(angle), 0.0, sin(angle));
  let strength = windLift * mix(0.4, 1.0, breaking);
  p.origin = vec4f(origin, 0.0);
  p.launch = vec4f(wind.x * 0.12, 1.1 + 1.5 * strength + crestRandom(seed + 4u) * 0.7,
    wind.y * 0.12, 1.1 + 1.1 * strength);
  p.crest = vec4f(tangent, 0.45 + crestRandom(seed + 5u) * 0.7);
  p.shape = vec4f(strength, crestRandom(seed + 6u) * 100.0, wind);
  plumes[id.x] = p;
}
`;

export const SPINDRIFT_RENDER = /* wgsl */ `
${FRAME_WGSL}
${ATMO_CORE_WGSL}
${SPINDRIFT_STATE}
${NOISE_WGSL}
${SHADOW_SAMPLE}
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<storage, read> plumes: array<CrestPlume>;
@group(0) @binding(2) var environment: texture_cube<f32>;
@group(0) @binding(3) var lightSampler: sampler;
@group(0) @binding(4) var transmittance: texture_2d<f32>;
@group(0) @binding(5) var<storage, read> sunVisibility: vec4f;
struct CrestVertex {
  @builtin(position) position: vec4f,
  @location(0) uv: vec2f,
  @location(1) light: vec3f,
  @location(2) shape: vec3f, // opacity, seed, age
};
@vertex fn crestVS(@builtin(vertex_index) vertex: u32, @builtin(instance_index) instance: u32) -> CrestVertex {
  let p = plumes[instance];
  var o: CrestVertex;
  o.position = vec4f(2.0, 2.0, 0.0, 1.0); o.uv = vec2f(0.0); o.light = vec3f(0.0); o.shape = vec3f(0.0);
  if (p.launch.w <= 0.0) { return o; }
  let corner = array<vec2f, 6>(vec2f(0.0,-1.0),vec2f(1.0,-1.0),vec2f(0.0,1.0),vec2f(0.0,1.0),vec2f(1.0,-1.0),vec2f(1.0,1.0))[vertex % 6u];
  let u = (f32(vertex / 6u) + corner.x) / 4.0;
  let age = p.origin.w;
  let head = plumePosition(p, age);
  let distanceToEye = length(head - F.camPos.xyz);
  let metresPerPixel = max(distanceToEye, 1.0) * 2.0 * length(F.camUp.xyz) * F.screen.w;
  let trailTime = min(age, 0.65);
  let tail = plumePosition(p, max(0.0, age - trailTime));
  let lengthLimit = min(1.0, 150.0 * metresPerPixel / max(length(head - tail), 0.01));
  let t = max(0.0, age - trailTime * (1.0 - u) * lengthLimit);
  let center = plumePosition(p, t);
  let view = normalize(F.camPos.xyz - center);
  let path = normalize(head - tail + vec3f(0.0, 0.01, 0.0));
  let across = cross(path, view);
  let facingSide = normalize(across + normalize(F.camRight.xyz) * 0.01);
  // Start spread along the actual crest, then billow toward the view as it disperses.
  let crestSide = p.crest.xyz * select(-1.0, 1.0, dot(p.crest.xyz, facingSide) >= 0.0);
  let side = normalize(mix(crestSide, facingSide, 0.25 + 0.6 * smoothstep(0.0, 1.0, t)));
  let width = min(p.crest.w * (0.65 + t * 0.8), metresPerPixel * 26.0);
  let world = center + side * corner.y * width;
  o.position = F.viewProj * vec4f(world - F.camPos.xyz, 1.0);
  o.uv = vec2f(u, corner.y);
  let sky = textureSampleLevel(environment, lightSampler, vec3f(0.0,1.0,0.0), 5.0).rgb;
  let sunlight = textureSampleLevel(transmittance, lightSampler, transRMuToUV(RG + F.atmo.y, F.sunDir.y), 0.0).rgb;
  let phase = 0.35 + 1.5 * pow(max(dot(-view, F.sunDir.xyz), 0.0), 12.0);
  let shadow = vesselShadow(center, vec3f(0.0,1.0,0.0));
  o.light = sky * 0.7 + sunlight * F.sunDir.w * sunVisibility.x * phase * shadow;
  let fade = smoothstep(0.0, 0.18, age) * (1.0 - smoothstep(0.45, 1.0, age / p.launch.w));
  o.shape = vec3f((0.12 + 0.14 * p.shape.x) * fade * smoothstep(2.0, 6.0, distanceToEye)
    * (1.0 - smoothstep(55.0, 80.0, distanceToEye)), p.shape.y, age);
  return o;
}
@fragment fn crestFS(o: CrestVertex) -> @location(0) vec4f {
  let uv = o.uv;
  let flow = vec2f(uv.x * 4.0 - o.shape.z * 0.7, uv.y * 1.8) + o.shape.y;
  let billows = 0.55 + 0.65 * gnoise(flow) + 0.3 * gnoise(flow * 2.3);
  let edge = 1.0 - smoothstep(0.2, 1.0, abs(uv.y));
  let ends = smoothstep(0.0, 0.25, uv.x) * (1.0 - smoothstep(0.65, 1.0, uv.x));
  let alpha = o.shape.x * edge * ends * smoothstep(0.1, 0.8, billows);
  return vec4f(o.light * alpha, alpha);
}
`;

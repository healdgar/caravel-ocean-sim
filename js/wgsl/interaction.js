// Local hull response and spray. Bounded visual approximation, not a fluid solver.
import { FRAME_WGSL, CASCADES, ATMO_CORE_WGSL, NOISE_WGSL } from './common.js';

export const WAKE_SIZE = 256;
export const SPRAY_COUNT = 8192;
export const CONTACT_COUNT = 32;
export const INTERACTION_TYPES = /* wgsl */ `
struct Interaction {
  domain: vec4f,   // world centre xz, extent, texel size
  previous: vec4f, // previous centre xz, dt, reset
  motion: vec4f,   // speed m/s, enabled, wind velocity xz
  phase: vec4f,    // time, frame, reserved
};
struct Contact { point: vec4f, axis: vec4f, flow: vec4f, state: vec4f };
struct Drop { position: vec4f, velocity: vec4f, shape: vec4f };
struct InteractionHull { right: vec4f, up: vec4f, forward: vec4f, size: vec4f, origin: vec4f, rig: vec4f };
`;
// All consumers query the same world-space field, including the buoyancy probe.
export const WAKE_SAMPLE = INTERACTION_TYPES + /* wgsl */ `
fn wakeAt(p: vec2f) -> vec4f {
  let uv = (p - I.domain.xy) / I.domain.z + 0.5;
  let edge = max(abs(uv.x - 0.5), abs(uv.y - 0.5));
  if (I.motion.y < 0.5 || edge >= 0.495) { return vec4f(0.0); }
  return textureSampleLevel(wakeTex, wakeSamp, uv, 0.0) * (1.0 - smoothstep(0.45, 0.495, edge)) * I.motion.y;
}
`;
const INTERACTION_SEA = /* wgsl */ `
fn interactionDisp(p: vec2f) -> vec3f {
  var d = vec3f(0.0);
  for (var c = 0u; c < ${CASCADES}u; c++) {
    d += textureSampleLevel(seaTex, seaSamp, p * F.cascInvL[c >> 2u][c & 3u], c, 0.0).xyz;
  }
  return d;
}
fn interactionSea(p: vec2f) -> f32 {
  var q = p;
  for (var k = 0; k < 3; k++) { q = p - interactionDisp(q).xz; }
  return interactionDisp(q).y;
}
fn interactionRandom(n: u32) -> f32 {
  var x = n * 747796405u + 2891336453u;
  x = ((x >> ((x >> 28u) + 4u)) ^ x) * 277803737u;
  return f32((x >> 22u) ^ x) / 4294967296.0;
}
`;

export const WATER_CONTACTS = FRAME_WGSL + INTERACTION_TYPES + /* wgsl */ `
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<uniform> I: Interaction;
@group(0) @binding(2) var<uniform> H: InteractionHull;
@group(0) @binding(3) var seaTex: texture_2d_array<f32>;
@group(0) @binding(4) var seaSamp: sampler;
@group(0) @binding(5) var<storage, read_write> contacts: array<Contact, ${CONTACT_COUNT}>;
` + INTERACTION_SEA + /* wgsl */ `
@compute @workgroup_size(32) fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  let u = f32(i % 16u) / 15.0;
  let side = select(-1.0, 1.0, i >= 16u);
  let a = mix(0.28, 0.992, u);
  let z = -6.4 * a;
  let deck = 0.7 + 0.47 * a * a * a;
  let halfWidth = (1.8 * sqrt(max(0.0006, 1.0 - a * a)) + 0.105) * H.size.x / 3.6;
  let spine = H.origin.xyz - H.forward.xyz * (z * H.size.y / 12.0);
  let rest = spine + H.right.xyz * side * halfWidth * 0.9;
  var p = rest;
  var level = 0.0;
  var localY = 0.0;
  var width = halfWidth * 0.9;
  for (var j = 0; j < 3; j++) {
    level = interactionSea(p.xz);
    localY = (level - spine.y - H.right.y * side * width) / max(0.35, H.up.y);
    let depth = clamp((deck - localY) / (deck + 1.45), 0.0, 1.0);
    width = halfWidth * sqrt(max(0.001, 1.0 - depth * depth));
    p = spine + H.right.xyz * side * width + H.up.xyz * localY;
  }
  p.y = level;
  let signedWater = level - rest.y;
  let old = contacts[i];
  let reset = I.previous.w > 0.5 || old.state.y < 0.5;
  let closing = select(clamp((signedWater - old.state.x) / max(I.previous.z, 0.001), 0.0, 7.0), 0.0, reset);
  let wet = smoothstep(-1.42, -0.9, localY) * (1.0 - smoothstep(deck + 0.3, deck + 1.1, localY)) * I.motion.y;
  let speed = max(I.motion.x, 0.0);
  let drive = wet * min(2.6, (0.13 * speed + 0.46 * closing) * mix(0.3, 1.0, u));
  let strength = select(mix(old.point.w, drive, 1.0 - exp(-I.previous.z * 14.0)), drive, reset);
  let outward = normalize(H.right.xyz * side + H.forward.xyz * (0.18 + 0.35 * a * a));
  contacts[i].point = vec4f(p, strength * I.motion.y);
  contacts[i].axis = vec4f(outward, strength);
  contacts[i].flow = vec4f(H.forward.xyz * speed + outward * (speed * 0.45 + closing * 0.6), wet);
  contacts[i].state = vec4f(signedWater, 1.0, closing, u);
}
`;

export const WAKE_UPDATE = INTERACTION_TYPES + /* wgsl */ `
@group(0) @binding(0) var<uniform> I: Interaction;
@group(0) @binding(1) var<uniform> H: InteractionHull;
@group(0) @binding(2) var prevWake: texture_2d<f32>;
@group(0) @binding(3) var dstWake: texture_storage_2d<rgba16float, write>;
@group(0) @binding(4) var<storage, read> contacts: array<Contact, ${CONTACT_COUNT}>;
@group(0) @binding(5) var<storage, read_write> landings: array<atomic<u32>>;
fn previousCell(q: vec2i) -> vec4f {
  if (any(q < vec2i(1)) || any(q >= vec2i(${WAKE_SIZE - 1})) || I.previous.w > 0.5) { return vec4f(0.0); }
  return textureLoad(prevWake, q, 0);
}
@compute @workgroup_size(8, 8) fn main(@builtin(global_invocation_id) id: vec3u) {
  let q = vec2i(id.xy);
  let deposited = f32(atomicExchange(&landings[id.y * ${WAKE_SIZE}u + id.x], 0u)) / 4096.0;
  if (I.motion.y < 0.5) { textureStore(dstWake, q, vec4f(0.0)); return; }
  let shift = vec2i(round((I.domain.xy - I.previous.xy) / I.domain.w));
  let pq = q + shift;
  let old = previousCell(pq);
  let lap = previousCell(pq + vec2i(1,0)).x + previousCell(pq - vec2i(1,0)).x + previousCell(pq + vec2i(0,1)).x + previousCell(pq - vec2i(0,1)).x - 4.0 * old.x;
  let p = (vec2f(id.xy) + 0.5 - ${WAKE_SIZE / 2}.0) * I.domain.w + I.domain.xy;
  let delta = p - H.origin.xz;
  let along = dot(delta, H.forward.xz);
  let side = select(0u, 16u, dot(delta, H.right.xz) >= 0.0);
  let u = clamp((along / max(H.size.y * 6.4 / 12.0, 0.1) - 0.28) / 0.712, 0.0, 1.0);
  let contact = contacts[side + u32(round(u * 15.0))];
  let width = max(0.55, H.size.x * 0.18);
  let toContact = p - contact.point.xz;
  let r = length(toContact) / width;
  // A crest outside the hull and a shallow trough behind it displace water to either side.
  let outside = dot(toContact, contact.axis.xz);
  let source = exp(-r * r * 1.4) * smoothstep(-0.2, 0.25, outside) * contact.point.w;
  let stern = exp(-pow((along + H.size.y * 0.44) / max(0.7, H.size.y * 0.1), 2.0) - pow(dot(delta, H.right.xz) / max(0.6, H.size.x * 0.45), 2.0));
  let sternWet = (contacts[0].flow.w + contacts[16].flow.w) * 0.5;
  let forcing = source * 8.0 - stern * sternWet * min(0.65, I.motion.x * 0.05);
  let dt = I.previous.z;
  // c=2.5 m/s and dx>=0.5 m remain CFL-stable at the host's maximum dt=0.1 s.
  let velocity = clamp((old.y + (6.25 * lap / (I.domain.w * I.domain.w) + forcing - old.x * 2.0) * dt) * exp(-dt * 1.25), -3.0, 3.0);
  let edge = 1.0 - smoothstep(0.43, 0.495, max(abs(p.x - I.domain.x), abs(p.y - I.domain.y)) / I.domain.z);
  let height = clamp(old.x + velocity * dt, -0.7, 1.1) * edge;
  let foamSource = source * 2.5 + stern * sternWet * min(1.5, I.motion.x * 0.12);
  let foam = clamp(old.z * exp(-dt * 0.45) + foamSource * dt + deposited, 0.0, 1.0) * edge;
  textureStore(dstWake, q, vec4f(height, velocity * edge, foam, max(foamSource * dt, deposited)));
}
`;

export const SPRAY_UPDATE = FRAME_WGSL + WAKE_SAMPLE + /* wgsl */ `
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<uniform> I: Interaction;
@group(0) @binding(2) var seaTex: texture_2d_array<f32>;
@group(0) @binding(3) var seaSamp: sampler;
@group(0) @binding(4) var wakeTex: texture_2d<f32>;
@group(0) @binding(5) var wakeSamp: sampler;
@group(0) @binding(6) var<storage, read> contacts: array<Contact, ${CONTACT_COUNT}>;
@group(0) @binding(7) var<storage, read_write> drops: array<Drop, ${SPRAY_COUNT}>;
@group(0) @binding(8) var<storage, read_write> landings: array<atomic<u32>>;
` + INTERACTION_SEA + /* wgsl */ `
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id: vec3u) {
  let i = id.x;
  var d = drops[i];
  let dt = I.previous.z;
  if (I.motion.y < 0.5 || I.previous.w > 0.5) { drops[i].position.w = 0.0; return; }
  if (d.position.w > 0.0) {
    d.position.w -= dt;
    let mist = d.shape.z;
    let drag = 1.0 - exp(-dt * mix(0.35, 2.2, mist));
    d.velocity = vec4f(mix(d.velocity.xyz, vec3f(I.motion.z * 0.5, 0.0, I.motion.w * 0.5), drag), d.velocity.w);
    d.velocity.y -= mix(9.81, 3.0, mist) * dt;
    d.position = vec4f(d.position.xyz + d.velocity.xyz * dt, d.position.w);
    let level = interactionSea(d.position.xz) + wakeAt(d.position.xz + I.domain.xy - I.previous.xy).x;
    if (d.position.y <= level && d.velocity.y < 0.0) {
      let cell = vec2i(floor((d.position.xz - I.domain.xy) / I.domain.w + ${WAKE_SIZE / 2}.0));
      if (all(cell >= vec2i(0)) && all(cell < vec2i(${WAKE_SIZE}))) {
        atomicAdd(&landings[u32(cell.y) * ${WAKE_SIZE}u + u32(cell.x)], select(100u, 24u, mist > 0.5));
      }
      d.position.w = 0.0;
    }
    drops[i] = d;
    return;
  }
  let seed = i * 1399u + u32(I.phase.y) * 7919u;
  let r0 = interactionRandom(seed); let r1 = interactionRandom(seed + 1u); let r2 = interactionRandom(seed + 2u);
  let contact = contacts[u32(r0 * 31.999)];
  let rate = contact.point.w * 0.75;
  if (r1 > 1.0 - exp(-rate * dt)) { return; }
  let mist = select(0.0, 1.0, i % 7u == 0u);
  let life = mix(0.65 + r2 * 0.6, 1.0 + r2 * 0.7, mist);
  let lift = 1.1 + sqrt(max(contact.point.w, 0.0)) * (2.2 + r2 * 2.0);
  let velocity = contact.flow.xyz * (0.65 + r2 * 0.35) + vec3f(0.0, lift, 0.0);
  let p = contact.point.xyz + contact.axis.xyz * (0.05 + r2 * 0.18) + vec3f(0.0, 0.12 + wakeAt(contact.point.xz + I.domain.xy - I.previous.xy).x, 0.0);
  drops[i].position = vec4f(p, life);
  drops[i].velocity = vec4f(velocity, life);
  drops[i].shape = vec4f(mix(0.012 + r0 * 0.021, 0.045 + r0 * 0.055, mist), r2, mist, contact.point.w);
}
`;

// Both populations share the ocean's sky/sun illumination and reverse-Z depth buffer.
export const WATER_EFFECTS = FRAME_WGSL + ATMO_CORE_WGSL + NOISE_WGSL + WAKE_SAMPLE + /* wgsl */ `
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<uniform> I: Interaction;
@group(0) @binding(2) var<storage, read> contacts: array<Contact, ${CONTACT_COUNT}>;
@group(0) @binding(3) var<storage, read> drops: array<Drop, ${SPRAY_COUNT}>;
@group(0) @binding(4) var envCube: texture_cube<f32>;
@group(0) @binding(5) var effectSamp: sampler;
@group(0) @binding(6) var transLUT: texture_2d<f32>;
@group(0) @binding(7) var wakeTex: texture_2d<f32>;
@group(0) @binding(8) var wakeSamp: sampler;
struct EffectVertex { @builtin(position) position: vec4f, @location(0) world: vec3f, @location(1) normal: vec3f, @location(2) uv: vec2f, @location(3) data: vec4f };
fn sheetPoint(station: u32, side: u32, q: f32) -> vec3f {
  let c = contacts[station + side * 16u];
  // Smooth short-wave contact jitter along the continuous sheet; droplets retain it.
  var strength = 0.0;
  for (var j = -2; j <= 2; j++) {
    strength += contacts[u32(clamp(i32(station) + j, 0, 15)) + side * 16u].point.w * f32(3 - abs(j));
  }
  strength /= 9.0;
  let width = 0.15 + strength * 1.1;
  let ripple = sin(f32(station) * 1.7 + I.phase.x * 9.0 + q * 7.0) * 0.035 * strength * q;
  let outward = width * (0.85 * q + 0.42 * sin(q * 3.14159));
  let lift = strength * sin(q * 2.95) + ripple + 0.025;
  return c.point.xyz + c.axis.xyz * outward + vec3f(0.0, lift + wakeAt(c.point.xz).x, 0.0);
}
@vertex fn sheetVS(@builtin(vertex_index) vi: u32) -> EffectVertex {
  let corners = array<vec2u, 6>(vec2u(0,0),vec2u(1,0),vec2u(1,1),vec2u(0,0),vec2u(1,1),vec2u(0,1));
  let cell = vi / 6u;
  let side = cell / 150u;
  let local = cell % 150u;
  let corner = corners[vi % 6u];
  let station = local / 10u + corner.x;
  let q = f32(local % 10u + corner.y) / 10.0;
  let p = sheetPoint(station, side, q);
  let a = sheetPoint(min(15u, station + 1u), side, q) - sheetPoint(select(0u, station - 1u, station > 0u), side, q);
  let b = sheetPoint(station, side, min(1.0, q + 0.03)) - sheetPoint(station, side, max(0.0, q - 0.03));
  let crossN = cross(a, b);
  let n = crossN / max(length(crossN), 0.0001);
  var o: EffectVertex;
  o.position = F.viewProj * vec4f(p - F.camPos.xyz, 1.0);
  o.world = p; o.normal = n; o.uv = vec2f(f32(station) / 15.0, q);
  o.data = vec4f(contacts[station + side * 16u].point.w, 0.0, 0.0, 0.0);
  return o;
}
@vertex fn dropVS(@builtin(vertex_index) vi: u32, @builtin(instance_index) i: u32) -> EffectVertex {
  let corners = array<vec2f, 6>(vec2f(-1,-1),vec2f(1,-1),vec2f(1,1),vec2f(-1,-1),vec2f(1,1),vec2f(-1,1));
  let d = drops[i];
  let age = clamp(1.0 - d.position.w / max(0.01, d.velocity.w), 0.0, 1.0);
  let distanceToEye = distance(d.position.xyz, F.camPos.xyz);
  let size = min(d.shape.x * mix(1.0, 1.0 + age * 2.4, d.shape.z), distanceToEye * length(F.camUp.xyz) * mix(6.0, 18.0, d.shape.z) / F.screen.y);
  let uv = corners[vi];
  let right = normalize(F.camRight.xyz); let up = normalize(F.camUp.xyz);
  let projected = vec2f(dot(d.velocity.xyz, right), dot(d.velocity.xyz, up));
  let direction = (projected + vec2f(0.0, 0.001)) / max(length(projected + vec2f(0.0, 0.001)), 0.001);
  let stretch = mix(1.0 + min(1.3, length(projected) * 0.06), 1.0, d.shape.z);
  let offset = direction * uv.y * stretch + vec2f(direction.y, -direction.x) * uv.x;
  let p = d.position.xyz + (right * offset.x + up * offset.y) * size;
  var o: EffectVertex;
  o.position = F.viewProj * vec4f(p - F.camPos.xyz, 1.0);
  o.world = p; o.normal = vec3f(0,1,0); o.uv = uv;
  o.data = vec4f(select(0.0, smoothstep(0.35, 1.2, distanceToEye), d.position.w > 0.0), age, d.shape.z, d.shape.y);
  return o;
}
fn sprayLight(p: vec3f) -> vec3f {
  let sky = textureSampleLevel(envCube, effectSamp, vec3f(0,1,0), 5.0).rgb;
  let sun = textureSampleLevel(transLUT, effectSamp, transRMuToUV(RG + F.atmo.y, F.sunDir.y), 0.0).rgb * F.sunDir.w;
  let view = normalize(F.camPos.xyz - p);
  let scatter = pow(max(dot(-view, F.sunDir.xyz), 0.0), 12.0);
  return sky * 0.85 + sun * (0.12 + scatter * 0.65);
}
@fragment fn sheetFS(o: EffectVertex) -> @location(0) vec4f {
  let n = normalize(o.normal + vec3f(0.0, 0.0001, 0.0));
  let view = normalize(F.camPos.xyz - o.world);
  let reflected = textureSampleLevel(envCube, effectSamp, reflect(-view, n), 1.3).rgb;
  let bands = clamp(0.5 + gnoise(o.uv * vec2f(22.0, 7.0) - vec2f(I.phase.x * 0.6, I.phase.x * 2.0)), 0.0, 1.0);
  let brokenLip = smoothstep(0.48, 0.93, o.uv.y) * (0.45 + 0.55 * bands);
  let foam = clamp(brokenLip + o.data.x * 0.045, 0.0, 0.85);
  let color = mix(reflected * 0.8 + F.waterCol.rgb * 0.4, sprayLight(o.world), foam);
  let ends = smoothstep(0.0, 0.1, o.uv.x) * (1.0 - smoothstep(0.94, 1.0, o.uv.x));
  let alpha = smoothstep(0.02, 0.16, o.data.x) * ends * (1.0 - smoothstep(0.78 + bands * 0.16, 1.0, o.uv.y)) * (0.36 + foam * 0.48) * I.motion.y;
  return vec4f(color * alpha, alpha);
}
@fragment fn dropFS(o: EffectVertex) -> @location(0) vec4f {
  let r2 = dot(o.uv, o.uv);
  let alpha = exp(-r2 * mix(3.5, 2.5, o.data.z)) * (1.0 - smoothstep(0.65, 1.0, r2)) * (1.0 - smoothstep(0.55, 1.0, o.data.y)) * mix(0.65, 0.055, o.data.z) * o.data.x * I.motion.y;
  return vec4f(sprayLight(o.world) * alpha, alpha);
}
`;

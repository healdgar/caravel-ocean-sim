// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// 100% GPU compute + indirect instanced rendering for Old World grazing herds
// (sheep, cattle, swine, horses). JS uploads herd anchors once when a coast loads;
// every frame's pasture drift, grazing pauses, ground-triangle seating, frustum
// & sub-pixel culling, articulated 4-beat gait, and shadow casting run on the GPU.
import { FRAME_WGSL, ATMO_CORE_WGSL } from './common.js';
import { SKY_RENDER_FUNCS } from './sky.js';
import { CLOUD_SAMPLE } from './clouds.js';
import { SHADOW_FRAME } from './shadows.js';

export const HERD_SEED_FLOATS = 8;
export const HERD_BODY_FLOATS = 12;
export const HERD_DRAW_WORDS = 5;
// Sheep, cattle, swine, horse, and the carter's wagon (species 4) that its oxen draw along a caravan's road.
export const HERD_SPECIES = 5;
export const HERD_BUCKETS = HERD_SPECIES * 2; // 0..4 main pass, 5..9 shadow pass
// A caravan's route in the herds' route buffer: a header (departDay, arriveDay, points, length in metres), then each
// point as (x, z, metres along, 0) in world metres.
export const HERD_ROUTE_HEADER = 1;

const HERD_RIG_FN = /* wgsl */ `
struct HerdBody {
  posYaw: vec4f,     // worldX (unshifted), groundY, worldZ (unshifted), yaw
  animCoat: vec4f,   // walkPhase, walkAmp, grazeAmt, coatSeed
  slopeScale: vec4f, // slopePitch, scale, tailPhase, species
};

struct HerdSpeciesRig {
  neck: vec4f, // pivotX, pivotY, pivotZ, maxGrazePitch
  legs: vec4f, // legY, frontZ, backZ, height
};

struct HerdPosed {
  localPos: vec3f,
  localNrm: vec3f,
};

fn rotX3(v: vec3f, a: f32) -> vec3f {
  let c = cos(a);
  let s = sin(a);
  return vec3f(v.x, v.y * c - v.z * s, v.y * s + v.z * c);
}

fn rotY3(v: vec3f, a: f32) -> vec3f {
  let c = cos(a);
  let s = sin(a);
  return vec3f(v.x * c + v.z * s, v.y, -v.x * s + v.z * c);
}

fn poseLivestockVertex(pos: vec3f, nrm: vec3f, part: f32, body: HerdBody, rig: HerdSpeciesRig) -> HerdPosed {
  var p = pos;
  var n = nrm;
  let walkPhase = body.animCoat.x;
  let walkAmp = body.animCoat.y;
  let grazeAmt = body.animCoat.z;
  let tailPhase = body.slopeScale.z;

  if (part >= 1.0 && part < 1.995) {
    // Smoothly weighted neck & head pitch around chest/withers pivot while cropping grass.
    let w = clamp(part - 1.0, 0.0, 1.0);
    let nibble = 0.055 * sin(tailPhase * 3.4) * grazeAmt;
    let pitch = (grazeAmt * rig.neck.w + nibble) * w;
    let yawTurn = 0.14 * sin(tailPhase * 0.73) * grazeAmt * w;
    let piv = rig.neck.xyz;
    var rel = rotX3(p - piv, pitch);
    rel = rotY3(rel, yawTurn);
    p = piv + rel;
    n = rotY3(rotX3(n, pitch), yawTurn);
  } else if (part >= 1.995 && part < 5.5) {
    // 4-beat lateral walk: FL(2)=0, BR(5)=0.25, FR(3)=0.5, BL(4)=0.75.
    let legIdx = i32(round(part));
    var beat = 0.0;
    var pivZ = rig.legs.y;
    if (legIdx == 3) { beat = 3.14159265; pivZ = rig.legs.y; }
    else if (legIdx == 4) { beat = 4.71238898; pivZ = rig.legs.z; }
    else if (legIdx == 5) { beat = 1.57079633; pivZ = rig.legs.z; }
    let ph = walkPhase + beat;
    let swing = sin(ph) * 0.36 * walkAmp;
    let lift = max(0.0, cos(ph)) * 0.045 * walkAmp * clamp(1.0 - p.y / max(0.2, rig.legs.x), 0.0, 1.0);
    let piv = vec3f(p.x, rig.legs.x, pivZ);
    p = piv + rotX3(p - piv, swing) + vec3f(0.0, lift, 0.0);
    n = rotX3(n, swing);
  } else if (part >= 6.5) {
    // A wagon's wheel, turned about its axle by the distance rolled (walkPhase is metres for a wagon).
    let front = p.z > 0.0;
    let r = select(0.6, 0.5, front);
    let az = select(-1.1, 1.05, front);
    let piv = vec3f(p.x, r, az);
    let turn = walkPhase / r;
    p = piv + rotX3(p - piv, turn);
    n = rotX3(n, turn);
  } else if (part >= 5.5) {
    // Gentle fly-whisking tail sway.
    let sway = 0.18 * sin(tailPhase * 2.1);
    let piv = vec3f(0.0, rig.legs.x * 1.15, rig.legs.z - 0.18);
    let d = p - piv;
    let c = cos(sway);
    let s = sin(sway);
    p = piv + vec3f(d.x * c - d.y * s, d.x * s + d.y * c, d.z);
  }

  // Subtle breathing & gait bounce on torso/head.
  let isWagon = body.slopeScale.w > 3.5;
  let bob = select(0.014 * abs(sin(walkPhase)), 0.006 * abs(sin(walkPhase * 2.7)), isWagon) * walkAmp;
  p = p * body.slopeScale.y + vec3f(0.0, bob * body.slopeScale.y, 0.0);

  // Align to terrain slope along facing direction, then turn to world yaw.
  p = rotX3(p, body.slopeScale.x);
  n = rotX3(n, body.slopeScale.x);
  p = rotY3(p, body.posYaw.w);
  n = normalize(rotY3(n, body.posYaw.w));
  return HerdPosed(p + body.posYaw.xyz, n);
}
`;

export const HERDS_STEP_WGSL = FRAME_WGSL + SHADOW_FRAME + /* wgsl */ `
struct HerdLand { domain: vec4f };
struct HerdNearDomain { domain: vec4f, grid: vec4f };
struct HerdConfig {
  count: u32,
  bucketSpan: u32,
  // The country's model's day now, with its fraction, and how many of its days pass in a second of play.
  boardDay: f32,
  daysPerSecond: f32,
};
struct HerdSeed {
  anchor: vec4f, // anchorX, anchorZ, roamRadius, phase
  traits: vec4f, // coatSeed, scale, species, flockHeading
};
struct HerdBody {
  posYaw: vec4f,
  animCoat: vec4f,
  slopeScale: vec4f,
};

@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<uniform> LAND: HerdLand;
@group(0) @binding(2) var<uniform> nearTerrain: HerdNearDomain;
@group(0) @binding(3) var elevation: texture_2d<f32>;
@group(0) @binding(4) var<uniform> cfg: HerdConfig;
@group(0) @binding(5) var<storage, read> seeds: array<HerdSeed>;
@group(0) @binding(6) var<storage, read_write> bodies: array<HerdBody>;
@group(0) @binding(7) var<storage, read_write> draws: array<atomic<u32>>;
@group(0) @binding(8) var<uniform> landSH: ShadowFrame;
@group(0) @binding(9) var<storage, read> routes: array<vec4f>;

struct HerdRouteSample { pos: vec2f, dir: vec2f, deckY: f32 };

// Where along a caravan's route a beast or wagon is s metres from the start: its place, the way the road runs, and any bridge deck height.
fn herdRouteAt(header: u32, s: f32) -> HerdRouteSample {
  let count = u32(routes[header].z);
  let total = routes[header].w;
  let d = clamp(s, 0.0, total);
  var lo = 0u;
  var hi = max(count, 2u) - 1u;
  loop {
    if (hi - lo <= 1u) { break; }
    let mid = (lo + hi) / 2u;
    if (routes[header + 1u + mid].z <= d) { lo = mid; } else { hi = mid; }
  }
  let a = routes[header + 1u + lo];
  let b = routes[header + 1u + hi];
  let span = max(b.z - a.z, 1e-3);
  let t = clamp((d - a.z) / span, 0.0, 1.0);
  let dir = b.xy - a.xy;
  let nDir = select(vec2f(0.0, 1.0), dir / max(length(dir), 1e-4), length(dir) > 1e-4);
  return HerdRouteSample(mix(a.xy, b.xy, t), nDir, mix(a.w, b.w, t));
}

fn herdGroundY(p: vec2f) -> f32 {
  let dim = vec2i(textureDimensions(elevation));
  let limit = max(dim - vec2i(1), vec2i(1));
  let uv = clamp((p - LAND.domain.xy) / LAND.domain.z + 0.5, vec2f(0.0), vec2f(1.0));
  let q = uv * vec2f(limit);
  let i = min(vec2i(floor(q)), max(limit - vec2i(1), vec2i(0)));
  let f = q - vec2f(i);
  let nx = min(i + vec2i(1, 0), limit);
  let ny = min(i + vec2i(0, 1), limit);
  let nxy = min(i + vec2i(1, 1), limit);
  let a = textureLoad(elevation, i, 0).r;
  let b = textureLoad(elevation, nx, 0).r;
  let c = textureLoad(elevation, ny, 0).r;
  let d = textureLoad(elevation, nxy, 0).r;
  return select(d + (1.0 - f.x) * (c - d) + (1.0 - f.y) * (b - d), a + f.x * (b - a) + f.y * (c - a), f.x + f.y <= 1.0);
}

fn herdLissajous(tau: f32, phase: f32, flockAngle: f32) -> vec2f {
  let lx = sin(tau * 0.21 + phase) * 0.68 + sin(tau * 0.09 + phase * 1.7) * 0.32;
  let lz = cos(tau * 0.17 + phase * 1.3) * 0.68 + sin(tau * 0.11 - phase * 0.8) * 0.32;
  let c = cos(flockAngle);
  let s = sin(flockAngle);
  return vec2f(lx * c - lz * s, lx * s + lz * c);
}

// Piecewise-smooth pasture clock: alternates ~19 s calm grazing with ~9 s slow ambling.
fn pastureWalkTime(t: f32, phase: f32) -> vec2f {
  let period = 28.0;
  let u = t + phase * 4.456;
  let cyc = floor(u / period);
  let f = u - cyc * period;
  // Move during f in [0, 8.5], rest & graze during [8.5, 28].
  let moveWindow = 8.5;
  var localMove = 0.0;
  var speed = 0.0;
  if (f < moveWindow) {
    let x = f / moveWindow;
    // Smooth bell velocity profile (integral over [0, 1] is 0.5 * moveWindow)
    localMove = moveWindow * (x * x * (3.0 - 2.0 * x)) * 0.5;
    speed = 6.0 * x * (1.0 - x) * 0.5; // peak = 0.75
  } else {
    localMove = moveWindow * 0.5;
    speed = 0.0;
  }
  return vec2f((cyc * moveWindow * 0.5 + localMove), clamp(speed / 0.75, 0.0, 1.0));
}

@compute @workgroup_size(64)
fn main(@builtin(global_invocation_id) gid: vec3u) {
  let idx = gid.x;
  if (idx >= cfg.count) { return; }
  let seed = seeds[idx];
  let species = min(4u, u32(round(seed.traits.z)));
  let roamR = seed.anchor.z;
  let phase = seed.anchor.w;
  let flockHeading = seed.traits.w;
  let t = F.camPos.w;
  let travelling = roamR < 0.0;

  var tau = 0.0;
  var moveAmt = 0.0;
  var worldXZ = seed.anchor.xy;
  var walkYaw = flockHeading;
  // How far a travelling beast or wagon has gone along its road, in metres: its gait is paced by it, so no hoof slides.
  var rolled = 0.0;
  var routeDeckY = 0.0;
  var routeHeader = 0u;
  if (travelling) {
    // A caravan of the country's model: where it is, is the share of its road its days have run (the model's own
    // closed form), less how far behind the head of the train this one walks. A drove wanders a little about it.
    routeHeader = u32(seed.anchor.x);
    let head = routes[routeHeader];
    let days = max(head.y - head.x, 1e-3);
    let share = clamp((cfg.boardDay - head.x) / days, 0.0, 1.0);
    let calSpeed = head.w / days * cfg.daysPerSecond;
    // In 1x real-time play calendar motion is ~6 mm/s; give active trains a 0.92 m/s visual pace driven by t
    // that yields cleanly back to exact calendar speed once Chart Course time-warp reaches walking speed.
    let paceFloor = max(0.0, 0.92 - calSpeed);
    let cycle = max(head.w + 48.0, 1.0);
    let rawDist = share * head.w + paceFloor * t;
    let wrappedDist = rawDist - cycle * floor(rawDist / cycle);
    let headDist = select(share * head.w, wrappedDist, calSpeed < 0.92 && head.w > 1.0);
    // A driven beast's coat word is lifted by one; a yoked ox's and a wagon's are not.
    let wander = select(0.0, 1.0, species != 4u && seed.traits.x >= 1.0);
    let behind = seed.anchor.y + wander * 0.9 * sin(t * 0.11 + phase * 3.0);
    rolled = headDist - behind;
    let at = herdRouteAt(routeHeader, rolled);
    routeDeckY = at.deckY;
    let lateral = seed.traits.w + wander * 1.1 * sin(t * 0.13 + phase * 7.0);
    worldXZ = at.pos + vec2f(at.dir.y, -at.dir.x) * lateral;
    walkYaw = atan2(at.dir.x, at.dir.y) + wander * 0.25 * sin(t * 0.21 + phase * 5.0);
    let onRoad = cfg.boardDay >= head.x && cfg.boardDay <= head.y + 0.05 && rolled > 0.0 && rolled < head.w;
    if (!onRoad) { return; }
    let visSpeed = max(calSpeed, 0.92);
    moveAmt = clamp(visSpeed / 0.9, 0.0, 1.0);
    tau = rolled;
  } else {
    let clock = pastureWalkTime(t, phase);
    tau = clock.x;
    moveAmt = clock.y;

    let offset0 = herdLissajous(tau, phase, flockHeading) * roamR;
    let offset1 = herdLissajous(tau + 0.12, phase, flockHeading) * roamR;
    worldXZ = seed.anchor.xy + offset0;

    let vel = offset1 - offset0;
    let velLen = length(vel);
    walkYaw = select(flockHeading + 0.55 * sin(phase * 3.1 + floor((t + phase * 4.456) / 28.0)), atan2(vel.x, vel.y), velLen > 1e-4);
  }

  let groundY = herdGroundY(worldXZ);
  let onBridge = travelling && routeDeckY > 0.25;
  let wy = select(groundY, max(groundY, routeDeckY), onBridge);
  if (wy < 0.32 && !onBridge) { return; }

  let shiftXZ = vec2f(nearTerrain.grid.y, nearTerrain.grid.z);
  let scale = seed.traits.y;
  let bodyRadius = select(select(select(0.75, 1.35, species == 1u), select(0.68, 1.45, species == 3u), species >= 2u), 2.1, species == 4u) * scale;
  let center = vec3f(worldXZ.x + shiftXZ.x, wy + bodyRadius * 0.65, worldXZ.y + shiftXZ.y);
  let curved = earthCurve(center - F.camPos.xyz, F.camPos.y);
  let dist = length(curved);
  if (dist > 2350.0) { return; }
  // Sub-pixel screen-size cull (~1.1 px threshold at 1080p).
  if (dist > 35.0 && (bodyRadius / dist) < 0.00052) { return; }

  let clip = F.viewProj * vec4f(curved, 1.0);
  if (clip.w <= 0.05 || abs(clip.x) > clip.w * 1.18 || abs(clip.y) > clip.w * 1.18) { return; }

  let fwd = vec2f(sin(walkYaw), cos(walkYaw));
  let reach = select(0.55, 1.1, species == 4u);
  var hFront = herdGroundY(worldXZ + fwd * reach);
  var hBack = herdGroundY(worldXZ - fwd * reach);
  if (travelling) {
    let atF = herdRouteAt(routeHeader, rolled + reach);
    let atB = herdRouteAt(routeHeader, rolled - reach);
    if (atF.deckY > 0.25) { hFront = max(hFront, atF.deckY); }
    if (atB.deckY > 0.25) { hBack = max(hBack, atB.deckY); }
  }
  let slopePitch = clamp(-atan2(hFront - hBack, reach * 2.0), -0.45, 0.45);

  // Swine root, sheep & cattle crop grass deeply, horses graze ~65% of pauses and look alert ~35%.
  let alertCycle = sin(t * 0.31 + phase * 5.7);
  let wantGraze = select(1.0, smoothstep(-0.15, 0.25, alertCycle), species == 3u);
  // Yoked oxen and a wagon never stoop to graze; a drove halted on the road may.
  let yoked = travelling && seed.traits.x < 1.0;
  let grazeAmt = select((1.0 - smoothstep(0.05, 0.45, moveAmt)) * wantGraze, 0.0, yoked);
  let walkFreq = select(select(4.6, 3.1, species == 1u), select(5.2, 3.3, species == 3u), species >= 2u);
  // On the road a stride is paced by the ground covered (about 1.6 m a cycle); a wagon's phase is the metres rolled.
  let roadPhase = select(rolled * 6.2831853 / 1.6 + phase * 6.2831853, rolled, species == 4u);
  let walkPhase = select(tau * walkFreq + phase * 6.2831853, roadPhase, travelling);
  let tailPhase = t * (1.2 + 0.35 * fract(phase * 7.13)) + phase * 9.1;

  let body = HerdBody(
    vec4f(worldXZ.x, wy, worldXZ.y, walkYaw),
    vec4f(walkPhase, moveAmt, grazeAmt, seed.traits.x),
    vec4f(slopePitch, scale, tailPhase, f32(species)),
  );

  let slot = atomicAdd(&draws[species * 5u + 1u], 1u);
  if (slot < cfg.bucketSpan) {
    bodies[species * cfg.bucketSpan + slot] = body;
  }

  // Shadow caster bucket if inside landShadow frustum.
  if (landSH.origin.w > 0.5 && dist < 420.0) {
    let sp = landSH.lightView * vec4f(center - landSH.origin.xyz, 1.0);
    if (abs(sp.x) <= 1.08 && abs(sp.y) <= 1.08 && sp.z >= -0.08 && sp.z <= 1.08) {
      let shBucket = species + ${HERD_SPECIES}u;
      let shSlot = atomicAdd(&draws[shBucket * 5u + 1u], 1u);
      if (shSlot < cfg.bucketSpan) {
        bodies[shBucket * cfg.bucketSpan + shSlot] = body;
      }
    }
  }
}
`;

export const HERDS_RENDER_WGSL = FRAME_WGSL + ATMO_CORE_WGSL + /* wgsl */ `
struct HerdNearDomain { domain: vec4f, grid: vec4f };
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var transLUT: texture_2d<f32>;
@group(0) @binding(2) var skyLUT: texture_2d<f32>;
@group(0) @binding(3) var sampC: sampler;
@group(0) @binding(4) var envCube: texture_cube<f32>;
@group(0) @binding(12) var<uniform> nearTerrain: HerdNearDomain;
@group(0) @binding(16) var<storage, read> herdBodies: array<HerdBody>;
@group(0) @binding(17) var<uniform> herdRig: HerdSpeciesRig;
` + SHADOW_FRAME + SKY_RENDER_FUNCS + CLOUD_SAMPLE + HERD_RIG_FN + /* wgsl */ `
@group(0) @binding(19) var<uniform> landSH: ShadowFrame;
@group(0) @binding(20) var landSolidShadow: texture_depth_2d;
@group(0) @binding(21) var landShadowCompare: sampler_comparison;

struct HerdVertexOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) normal: vec3f,
  @location(2) coatInfo: vec4f, // coatZone, aoShade, coatSeed, species
  @location(3) localXZ: vec2f,
};

fn herdShadowVis(world: vec3f, normal: vec3f) -> f32 {
  if (landSH.origin.w < 0.5) { return 1.0; }
  let p = landSH.lightView * vec4f(world - landSH.origin.xyz + normal * 0.03 + landSH.sun.xyz * 0.025, 1.0);
  let uv = p.xy * vec2f(0.5, -0.5) + 0.5;
  let edge = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
  let fade = smoothstep(0.0, 0.06, edge) * step(0.0, p.z) * step(p.z, 1.0);
  if (fade <= 0.0) { return 1.0; }
  let refZ = min(p.z - 0.08 / max(landSH.sun.w, 1.0), 0.99999);
  let s = textureSampleCompareLevel(landSolidShadow, landShadowCompare, uv, refZ);
  return mix(1.0, s, fade);
}

fn herdCloudShadow(world: vec3f) -> f32 {
  if (CF.screen.w <= 0.5 || F.sunDir.y <= 0.0) { return 1.0; }
  let cMid = cloudUV(world * 0.001 + F.sunDir.xyz * (max(CF.shape.x, 0.5) / max(F.sunDir.y, 0.15)));
  let cD = textureSampleLevel(cloudDensity, cloudSampler, clamp(cMid, vec3f(0.0), vec3f(1.0)), 1.0).r;
  let cL = textureSampleLevel(cloudLight, cloudSampler, clamp(cMid, vec3f(0.0), vec3f(1.0)), 1.0).b;
  return clamp(exp(-max(cD, 0.0) * CF.shape.z * 0.6) * mix(1.0, cL, 0.5), 0.0, 1.0);
}

fn livestockCoatAlbedo(species: u32, zone: u32, seed: f32, localXZ: vec2f) -> vec3f {
  let h1 = fract(seed * 13.713);
  let h2 = fract(seed * 47.219);
  if (species == 0u) {
    // Sheep: Merino warm cream, lanolin ivory, grey Churra, or black Iberian sheep (~12%).
    var fleece = mix(vec3f(0.58, 0.53, 0.43), vec3f(0.70, 0.65, 0.54), h1);
    if (h2 < 0.12) { fleece = vec3f(0.055, 0.048, 0.044); }
    else if (h2 < 0.26) { fleece = vec3f(0.32, 0.30, 0.27); }
    if (zone == 1u) {
      // Churra dark face/ears/hooves or warm tan Merino face.
      return select(vec3f(0.26, 0.20, 0.16), vec3f(0.06, 0.05, 0.045), h2 < 0.58);
    }
    let crimp = gnoise(localXZ * 18.0 + vec2f(seed * 31.0, 0.0)) * 0.08;
    return fleece * (1.0 + crimp);
  }
  if (species == 1u) {
    // Cattle: Barrosã rich russet/chestnut, Mertolenga mahogany/piebald, Avileña black, Minhota golden.
    var hide = vec3f(0.24, 0.105, 0.052);
    if (h1 < 0.24) { hide = vec3f(0.048, 0.042, 0.040); }
    else if (h1 < 0.52) { hide = vec3f(0.31, 0.15, 0.068); }
    else if (h1 < 0.74) { hide = vec3f(0.42, 0.27, 0.14); }
    // Mertolenga / Frisian piebald patches on ~28% of cattle.
    if (h2 < 0.28) {
      let piebald = gnoise(localXZ * 2.4 + vec2f(seed * 19.0, seed * 7.0));
      if (piebald > 0.08 || zone == 2u) { hide = vec3f(0.62, 0.58, 0.50); }
    } else if (zone == 2u) {
      hide *= 1.18;
    }
    if (zone == 1u) {
      // Horns (higher up) vs dark muzzle/hooves.
      return select(vec3f(0.055, 0.048, 0.045), vec3f(0.48, 0.43, 0.34), localXZ.y > 0.78);
    }
    if (zone == 3u) { return hide * 0.45; }
    return hide;
  }
  if (species == 2u) {
    // Swine: dark slate-black Porco Preto Ibérico & reddish-brown Iberian hog.
    var bristle = select(vec3f(0.065, 0.058, 0.056), vec3f(0.19, 0.10, 0.075), h1 < 0.34);
    if (h2 < 0.18) { bristle = vec3f(0.36, 0.24, 0.20); }
    if (zone == 1u) { return mix(bristle * 0.7, vec3f(0.22, 0.14, 0.13), 0.45); }
    if (zone == 2u) { return bristle * 1.15 + vec3f(0.025, 0.018, 0.014); }
    return bristle;
  }
  if (species == 4u) {
    // A carter's wagon: weathered oak and chestnut boards, black iron, and a tilt of linen or oiled canvas dyed or
    // stained by what it carries (C&C's own cargo colours: grain, wine, wool, ore, salt, cloth, timber, hay).
    let grain = 0.88 + 0.12 * gnoise(localXZ * vec2f(1.4, 22.0) + vec2f(seed * 9.0, 0.0));
    if (zone == 1u) { return vec3f(0.045, 0.043, 0.042); }
    if (zone == 2u) {
      let cargo = u32(floor(fract(seed) * 8.0));
      var cloth = vec3f(0.62, 0.58, 0.48);
      if (cargo == 1u) { cloth = vec3f(0.42, 0.18, 0.16); }
      else if (cargo == 2u) { cloth = vec3f(0.70, 0.67, 0.60); }
      else if (cargo == 3u) { cloth = vec3f(0.36, 0.33, 0.30); }
      else if (cargo == 4u) { cloth = vec3f(0.74, 0.73, 0.70); }
      else if (cargo == 5u) { cloth = vec3f(0.30, 0.34, 0.46); }
      else if (cargo == 6u) { cloth = vec3f(0.46, 0.38, 0.26); }
      else if (cargo == 7u) { cloth = vec3f(0.60, 0.55, 0.34); }
      let weave = 0.94 + 0.06 * gnoise(localXZ * 9.0 + vec2f(seed * 17.0));
      return cloth * weave;
    }
    return mix(vec3f(0.20, 0.15, 0.10), vec3f(0.30, 0.24, 0.17), h1) * grain;
  }
  // Horse (3): bay, Lusitano grey/white, chestnut, dark brown.
  var coat = vec3f(0.22, 0.095, 0.048); // bay
  var mane = vec3f(0.035, 0.032, 0.030);
  if (h1 < 0.28) {
    // Lusitano dapple-grey / white
    let dapple = 0.92 + 0.08 * gnoise(localXZ * 7.5 + vec2f(seed * 13.0));
    coat = vec3f(0.58, 0.57, 0.55) * dapple;
    mane = vec3f(0.44, 0.43, 0.42);
  } else if (h1 < 0.54) {
    // Chestnut / sorrel
    coat = vec3f(0.30, 0.13, 0.058);
    mane = vec3f(0.22, 0.10, 0.045);
  } else if (h1 < 0.76) {
    // Dark seal-brown
    coat = vec3f(0.075, 0.052, 0.040);
  }
  if (zone == 3u) { return mane; }
  if (zone == 1u) { return mane * 0.9; }
  return coat;
}

@vertex fn herdsVS(
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) partZone: vec2f,
  @builtin(instance_index) inst: u32,
) -> HerdVertexOut {
  let body = herdBodies[inst];
  let posed = poseLivestockVertex(position, normal, partZone.x, body, herdRig);
  let shifted = posed.localPos + vec3f(nearTerrain.grid.y, 0.0, nearTerrain.grid.z);
  let zone = floor(partZone.y + 0.001);
  let ao = clamp(partZone.y - zone, 0.08, 0.98);
  var o: HerdVertexOut;
  o.world = shifted;
  o.normal = posed.localNrm;
  o.coatInfo = vec4f(zone, ao, body.animCoat.w, body.slopeScale.w);
  o.localXZ = vec2f(position.z, position.y);
  o.pos = F.viewProj * vec4f(earthCurve(shifted - F.camPos.xyz, F.camPos.y), 1.0);
  return o;
}

@fragment fn herdsFS(in: HerdVertexOut) -> @location(0) vec4f {
  let n = normalize(in.normal);
  let species = min(4u, u32(round(in.coatInfo.w)));
  let zone = u32(round(in.coatInfo.x));
  let ao = in.coatInfo.y;
  let albedo = livestockCoatAlbedo(species, zone, in.coatInfo.z, in.localXZ);

  let shadow = herdShadowVis(in.world, n) * herdCloudShadow(in.world);
  let sunVis = solarShadowVisibility(vec3f(shadow));
  let nDotL = max(dot(n, F.sunDir.xyz), 0.0);
  let wrap = max(0.0, dot(n, F.sunDir.xyz) * 0.65 + 0.35) * select(0.12, 0.28, species == 0u);
  let direct = sunIlluminance() * sunVis * (nDotL + wrap);

  let skyDir = normalize(vec3f(n.x * 0.65, max(n.y, 0.12), n.z * 0.65));
  let envIrr = textureSampleLevel(envCube, sampC, skyDir, 6.0).rgb;
  let skyUp = skyAtmo(vec3f(0.0, 1.0, 0.0));
  let groundBounce = skyUp * vec3f(0.24, 0.21, 0.14) * (1.0 - max(n.y, 0.0)) * 0.45;
  let ambient = (envIrr * 0.88 + groundBounce) * (0.38 + 0.68 * ao);

  let v = normalize(F.camPos.xyz - in.world);
  let h = normalize(v + F.sunDir.xyz);
  let rough = select(0.56, 0.92, species == 0u);
  let specPow = select(18.0, 4.0, species == 0u);
  let sheen = pow(max(dot(n, h), 0.0), specPow) * select(0.055, 0.012, species == 0u) * nDotL;

  var col = albedo * (direct / PI + ambient) + sunIlluminance() * sunVis * sheen;
  col += lunarSurface(n, v, albedo, rough, vec3f(0.035), lunarShadowVisibility(vec3f(shadow)));
  col = surfaceAir(col, in.world);
  return vec4f(col, 1.0);
}
`;

export const HERDS_SHADOW_WGSL = SHADOW_FRAME + HERD_RIG_FN + /* wgsl */ `
struct HerdNearDomain { domain: vec4f, grid: vec4f };
@group(0) @binding(0) var<uniform> landSH: ShadowFrame;
@group(0) @binding(1) var<uniform> nearTerrain: HerdNearDomain;
@group(0) @binding(2) var<storage, read> herdBodies: array<HerdBody>;
@group(0) @binding(3) var<uniform> herdRig: HerdSpeciesRig;

@vertex fn herdsShadowVS(
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) partZone: vec2f,
  @builtin(instance_index) inst: u32,
) -> @builtin(position) vec4f {
  let body = herdBodies[inst];
  let posed = poseLivestockVertex(position, normal, partZone.x, body, herdRig);
  let shifted = posed.localPos + vec3f(nearTerrain.grid.y, 0.0, nearTerrain.grid.z);
  return landSH.lightView * vec4f(shifted - landSH.origin.xyz, 1.0);
}
`;

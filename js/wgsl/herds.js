// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// 100% GPU compute + indirect instanced rendering for Old World grazing herds
// (sheep, cattle, swine, Lusitano horses + 1550 sela à gineta tack), mounted urban/road riders,
// and 16th-century road caravan vehicles:
//   species 4 = carreta (4-wheel covered wain),
//   species 5 = coche (4-wheel passenger/merchant coach),
//   species 6 = carro de bois (2-wheel heavy cargo ox-cart).
// Every beast and vehicle is drawn through the one continuum (js/animal-continuum.js): the step below stands each one's
// record (16 words, of the SKINNED kind) and writes its joints, and the one cut (js/wgsl/continuum-cut.js) chooses its
// clusters, far body or splat, poses them by those joints, casts its shadow and draws it in the herds' material below.
// Also: atomic coupled hitch culling & hitch destruction, ballistic vehicle shard flight, livestock felling & 38 m
// stampedes.
import { FRAME_WGSL, ATMO_CORE_WGSL, SIM_CLOCK_LOOP_S } from './common.js';
import { SKY_RENDER_FUNCS } from './sky.js';
import { continuumGroundWGSL } from '../continuum-ground.js';
import { worldBodiesWGSL } from '../world-bodies.js';
import { CLOUD_SHADOW_BINDINGS } from './clouds.js';
import { SHADOW_FRAME, LAND_CLOTH_SHADOW } from './shadows.js';
import { ROUTE_STEP_M } from '../town-streets.js';
import { CONTINUUM_KIND } from '../continuum-format.js';
import { CONTINUUM_RECORD_WGSL } from './continuum-cut.js';
import { SKINNED_POSE_WGSL } from './skinned-pose.js';
import { ANIMAL_CONTINUUM_TYPES, ANIMAL_CONTINUUM_MATERIAL, ANIMAL_POSE_VEC4S, ANIMAL_RIG_VEC4S } from '../animal-continuum.js';

export const HERD_SEED_FLOATS = 8;
export const HERD_FATE_FLOATS = 8;
export const HERD_SHOT_LIMIT = 8;
export const HERD_SHOT_FLOATS = 8;
export const HERD_SHOTS_WORDS = 4 + HERD_SHOT_LIMIT * HERD_SHOT_FLOATS;
export const HERD_SPECIES = 7;
export const HERD_ROUTE_HEADER = 1;
export const HERD_STAMPEDE_RADIUS_M = 38.0;

// The herd rig as joints (js/animal-continuum.js ANIMAL_JOINT; mirrored by scripts/prepare-animal-continuum.mjs, whose
// bake measures every cluster and far step in these very poses). A beast: its body; its neck and head pitched about the
// withers while it grazes (or lifted in alarm); four legs swung in a four-beat walk about the shoulder and hip, or
// folded when felled; each leg's foot lifted as it swings forward; its tail whisking; its saddle and bridle, gathered to
// nothing and hidden on a beast without tack. Felled, the whole rolls onto its flank. A road vehicle: a joint a shard,
// its wheels turned by the distance rolled and its pole swung toward its team; shattered, each shard on its own
// ballistic flight. Each joint is written with its bound (the sphere about its points at rest, from the rig table).
const HERD_JOINTS_WGSL = SKINNED_POSE_WGSL + /* wgsl */ `
const HERD_POSE_VEC4S: u32 = ${ANIMAL_POSE_VEC4S}u;
const HERD_RIG_VEC4S: u32 = ${ANIMAL_RIG_VEC4S}u;
fn herdRigAt(species: u32, k: u32) -> vec4f { return herdRig[species * HERD_RIG_VEC4S + k]; }
fn herdJointBound(species: u32, j: u32) -> vec4f { return herdRig[species * HERD_RIG_VEC4S + 3u + j]; }

// walk: walk phase, walk amount, graze (or the pole's yaw), tail phase (or the pole's pitch); hit: hit age, the hit's
// bearing about the beast's own heading, the coat seed.
fn herdWriteJoints(at: u32, species: u32, flags: u32, walk: vec4f, hit: vec3f) {
  let neck = herdRigAt(species, 0u);
  let legs = herdRigAt(species, 1u);
  let head = herdRigAt(species, 2u);
  let count = u32(head.x);
  let slack = head.y;
  skinnedWriteHead(at, count, slack);
  let tack = (flags & 1u) != 0u;
  let felled = (flags & 2u) != 0u;
  let shattered = (flags & 4u) != 0u;
  let walkPhase = walk.x;
  let walkAmp = walk.y;
  let graze = walk.z;
  let tail = walk.w;
  let hitAge = max(0.0, hit.x);
  if (species >= 4u) {
    let bob = skinnedTranslate(vec3f(0.0, 0.005 * abs(sin(walkPhase * 2.7)) * walkAmp, 0.0));
    for (var shard = 0u; shard < count; shard++) {
      let wheel = shard < 4u;
      let pole = shard == 4u;
      let front = (shard & 2u) != 0u;
      var m = bob;
      if (!shattered) {
        if (wheel) {
          let r = max(0.2, select(legs.x, neck.x, front));
          m = skinnedThen(bob, skinnedAbout(vec3f(0.0, r, select(legs.z, legs.y, front)), skinnedRotX(walkPhase / r)));
        } else if (pole) {
          m = skinnedThen(bob, skinnedAbout(vec3f(0.0, neck.y, neck.z), skinnedThen(skinnedRotY(graze), skinnedRotX(tail))));
        }
      } else {
        // Shattered 1550 road vehicle (carreta, coche, carro de bois): deterministic per-piece rigid ballistic flight.
        let sF = f32(shard);
        let h0 = fract(sin(sF * 12.9898 + hit.z * 78.233) * 43758.5453);
        let h1 = fract(sin(sF * 39.3467 + hit.z * 19.19) * 24634.6345);
        var piv = vec3f(select(-0.44, 0.44, (shard & 1u) != 0u), select(0.92, 1.46, (shard & 4u) != 0u), select(-0.68, 0.68, front));
        if (pole) { piv = vec3f(0.0, neck.y + 0.24, 2.75); }
        else if (wheel) { piv = vec3f(select(-0.86, 0.86, (shard & 1u) != 0u), max(0.2, select(legs.x, neck.x, front)), select(legs.z, legs.y, front)); }
        let hitDirL = vec2f(sin(hit.y), cos(hit.y));
        let radDirL = select(vec2f(h0 - 0.5, h1 - 0.5), normalize(piv.xz), length(piv.xz) > 0.08);
        let horizDir = normalize(radDirL * 0.72 + hitDirL * 0.68 + vec2f(1e-4, 0.0));
        let horizSpeed = (2.7 + 3.9 * h0) * select(1.0, 1.25, wheel);
        let vy0 = 2.9 + 3.3 * h1;
        let g = 9.81;
        let dropH = max(0.05, piv.y - select(0.14, 0.08, wheel || pole));
        let tImpact = (vy0 + sqrt(vy0 * vy0 + 2.0 * g * dropH)) / g;
        let flyT = min(hitAge, tImpact);
        let groundT = max(0.0, hitAge - tImpact);
        let slideT = select(0.0, (1.0 - exp(-groundT * 4.5)) * 0.18, groundT > 0.0);
        let dispXZ = horizDir * horizSpeed * (flyT + slideT);
        var dy = vy0 * flyT - 0.5 * g * flyT * flyT;
        if (hitAge >= tImpact) { dy = -dropH + select(0.0, sin((groundT / 0.34) * 3.14159265) * 0.22 * (0.5 + 0.5 * h1), groundT < 0.34); }
        let spinT = flyT + slideT * 0.5;
        let spinX = (2.4 + 3.5 * h0) * spinT * select(1.0, -1.0, h1 < 0.5);
        let spinZ = mix((1.8 + 2.8 * h1) * spinT, select(-1.46, 1.46, piv.x >= 0.0), smoothstep(tImpact * 0.7, tImpact + 0.25, hitAge));
        m = skinnedThen(skinnedTranslate(vec3f(dispXZ.x, dy, dispXZ.y)), skinnedAbout(piv, skinnedThen(skinnedRotZ(spinZ), skinnedRotX(spinX))));
      }
      skinnedWriteJoint(at, count, shard, m, herdJointBound(species, shard), slack, false);
    }
    return;
  }
  let fall = smoothstep(0.0, 0.38, hitAge);
  var whole = skinnedTranslate(vec3f(0.0, 0.014 * abs(sin(walkPhase)) * walkAmp, 0.0));
  if (felled) {
    // Felled livestock roll 90 degrees onto their flank, resting physically on the ground.
    let barrelY = legs.x * 1.05;
    let flank = 0.28 * legs.x + 0.08;
    let hop = select(0.0, sin((hitAge / 0.36) * 3.14159265) * 0.16, hitAge < 0.36);
    let roll = select(-1.0, 1.0, sin(hit.y) >= 0.0) * 1.5707963 * fall;
    whole = skinnedThen(skinnedTranslate(vec3f(0.0, -(barrelY - flank) * fall + hop, 0.0)), skinnedAbout(vec3f(0.0, barrelY, 0.0), skinnedRotZ(roll)));
  }
  let nibble = 0.055 * sin(tail * 3.4) * max(0.0, graze);
  let neckM = skinnedAbout(neck.xyz, skinnedThen(skinnedRotY(select(0.14 * sin(tail * 0.73) * graze, 0.0, felled)), skinnedRotX(select(graze * neck.w + nibble, 0.26, felled))));
  skinnedWriteJoint(at, count, 0u, whole, herdJointBound(species, 0u), slack, false);
  skinnedWriteJoint(at, count, 1u, skinnedThen(whole, neckM), herdJointBound(species, 1u), slack, false);
  for (var leg = 0u; leg < 4u; leg++) {
    let piv = vec3f(0.0, legs.x, select(legs.z, legs.y, leg < 2u));
    var m: SkinnedJoint;
    var foot: SkinnedJoint;
    if (felled) {
      m = skinnedAbout(piv, skinnedThen(skinnedScale(vec3f(1.0, 1.0 - 0.42 * fall, 1.0)), skinnedRotX(select(-0.72, 0.72, leg < 2u) * fall)));
      foot = m;
    } else {
      let ph = walkPhase + array<f32, 4>(0.0, 3.14159265, 4.71238898, 1.57079633)[leg];
      m = skinnedAbout(piv, skinnedRotX(sin(ph) * 0.36 * walkAmp));
      foot = skinnedThen(skinnedTranslate(vec3f(0.0, max(0.0, cos(ph)) * 0.045 * walkAmp, 0.0)), m);
    }
    skinnedWriteJoint(at, count, 2u + leg, skinnedThen(whole, m), herdJointBound(species, 2u + leg), slack, false);
    skinnedWriteJoint(at, count, 6u + leg, skinnedThen(whole, foot), herdJointBound(species, 6u + leg), slack, false);
  }
  let tailM = skinnedAbout(vec3f(0.0, legs.x * 1.15, legs.z - 0.18), skinnedRotZ(select(0.18 * sin(tail * 2.1), 0.0, felled)));
  skinnedWriteJoint(at, count, 10u, skinnedThen(whole, tailM), herdJointBound(species, 10u), slack, false);
  // A 1550 Iberian sela à gineta saddle and alforjas, and the headstall bridle, curb bit and reins, which ride the neck.
  var saddle = skinnedGather(vec3f(0.0, legs.x, 0.0));
  var bridle = saddle;
  if (tack) { saddle = whole; bridle = skinnedThen(whole, neckM); }
  skinnedWriteJoint(at, count, 11u, saddle, herdJointBound(species, 11u), slack, !tack);
  skinnedWriteJoint(at, count, 12u, bridle, herdJointBound(species, 12u), slack, !tack);
}
`;

export const HERDS_STEP_WGSL = FRAME_WGSL + CONTINUUM_RECORD_WGSL + /* wgsl */ `
struct HerdLand { domain: vec4f };
struct HerdNearDomain { domain: vec4f, grid: vec4f };
struct HerdConfig {
  count: u32,
  spare: u32,
  boardDay: f32,
  daysPerSecond: f32,
};
struct HerdSeed {
  anchor: vec4f, // pasture: (anchorX, anchorZ, roamRadius, phase); caravan: (routeHeader, behindAnchor, roamSentinel, phase)
  traits: vec4f, // coatSeed (+10 when saddled), scale, species, flockHeading_or_lateralOffset
};
struct HerdShot {
  a: vec4f, // (ax, ay, az, radius) in shifted world space
  b: vec4f, // (bx, by, bz, shotTime) in shifted world space
};
struct HerdShots {
  header: vec4u, // (count, 0, 0, 0)
  list: array<HerdShot, ${HERD_SHOT_LIMIT}>,
};
struct HerdFate {
  status: vec4f, // (state: 0=ok, 1=stampede, 2=felled/shattered; hitTime; hitDirX; hitDirZ)
  motion: vec4f, // (haltedRolled, savedZ, savedX, savedYaw)
};

const CARAVAN_YOKE_AHEAD_M: f32 = 4.05;
const HERD_STAMPEDE_M: f32 = ${HERD_STAMPEDE_RADIUS_M.toFixed(1)};
const HERD_STAMPEDE_SPAN_S: f32 = 14.0;

@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var<uniform> LAND: HerdLand;
@group(0) @binding(2) var<uniform> nearTerrain: HerdNearDomain;
@group(0) @binding(3) var elevation: texture_2d<f32>;
@group(0) @binding(4) var<uniform> cfg: HerdConfig;
@group(0) @binding(5) var<storage, read> seeds: array<HerdSeed>;
// Each beast's record in the one continuum, and its joints in the scene's pose buffer, which the cut reads next; and
// each type's rig (js/animal-continuum.js animalRigTable).
@group(0) @binding(6) var<storage, read_write> herdRecords: array<ContinuumRecord>;
@group(0) @binding(7) var<storage, read_write> skinnedPoses: array<vec4f>;
@group(0) @binding(8) var<uniform> herdRig: array<vec4f, ${ANIMAL_CONTINUUM_TYPES.length * ANIMAL_RIG_VEC4S}>;
@group(0) @binding(9) var<storage, read> routes: array<vec4f>;
@group(0) @binding(10) var<uniform> shots: HerdShots;
@group(0) @binding(11) var<storage, read_write> fates: array<HerdFate>;
` + continuumGroundWGSL(0, 12) + /* wgsl */ `
@group(0) @binding(13) var<storage, read_write> herdAvoid: array<vec4f>;
` + worldBodiesWGSL(0, 14, 'read_write') + HERD_JOINTS_WGSL + /* wgsl */ `

// Not drawn this frame.
fn herdGone(idx: u32) {
  herdRecords[idx] = ContinuumRecord(vec4f(0.0), vec4f(0.0, 0.0, 0.0, 1.0), vec4u(CONTINUUM_GONE, idx * HERD_POSE_VEC4S, idx, 0u), vec4u(0u));
  if (idx < WB_HERD_MAX) {
    worldBodies[WB_HERD_BASE + idx] = WorldBody(vec4f(0.0), vec4f(0.0));
  }
}
fn herdBodyDims(species: u32, scale: f32) -> vec2f {
  if (species == 0u) { return vec2f(0.36, 0.38) * scale; }
  if (species == 1u) { return vec2f(0.56, 0.88) * scale; }
  if (species == 2u) { return vec2f(0.32, 0.36) * scale; }
  if (species == 3u) { return vec2f(0.50, 0.98) * scale; }
  return vec2f(1.15, 1.65) * scale;
}
fn herdTurnDelta(fromYaw: f32, toYaw: f32) -> f32 {
  return atan2(sin(toYaw - fromYaw), cos(toYaw - fromYaw));
}
// Stood at the drawn (shifted) world place, turned to its heading and pitched to its slope, at its scale; its joints
// posed by its walk and its fate; its spare words its coat seed and its herd flags (1 tack), for its material.
fn herdStand(idx: u32, species: u32, at: vec3f, yaw: f32, pitch: f32, scale: f32, flags: u32, seed: u32, herdFlags: u32, walk: vec4f, hit: vec3f) {
  herdRecords[idx] = ContinuumRecord(vec4f(at, scale), skinnedTurn(yaw, pitch, 0.0),
    vec4u(species | (${CONTINUUM_KIND.SKINNED}u << CONTINUUM_KIND_SHIFT) | flags, idx * HERD_POSE_VEC4S, seed, 0u), vec4u(bitcast<u32>(hit.z), herdFlags, 0u, 0u));
  herdWriteJoints(idx * HERD_POSE_VEC4S, species, herdFlags, walk, hit);
}

struct HerdRouteSample { pos: vec2f, dir: vec2f, deckY: f32 };

fn herdSecondsSince(since: f32, now: f32) -> f32 {
  let age = now - since;
  return select(age, age + ${SIM_CLOCK_LOOP_S.toFixed(1)}, age < 0.0);
}

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

fn herdSurfaceY(p: vec2f, deckY: f32) -> f32 {
  let g = herdGroundY(p);
  return select(g, max(g, deckY), deckY > 0.25);
}

fn herdLissajous(tau: f32, phase: f32, flockAngle: f32) -> vec2f {
  let lx = sin(tau * 0.21 + phase) * 0.68 + sin(tau * 0.09 + phase * 1.7) * 0.32;
  let lz = cos(tau * 0.17 + phase * 1.3) * 0.68 + sin(tau * 0.11 - phase * 0.8) * 0.32;
  let c = cos(flockAngle);
  let s = sin(flockAngle);
  return vec2f(lx * c - lz * s, lx * s + lz * c);
}

fn pastureWalkTime(t: f32, phase: f32) -> vec2f {
  let period = 28.0;
  let u = t + phase * 4.456;
  let cyc = floor(u / period);
  let f = u - cyc * period;
  let moveWindow = 8.5;
  var localMove = 0.0;
  var speed = 0.0;
  if (f < moveWindow) {
    let x = f / moveWindow;
    localMove = moveWindow * (x * x * (3.0 - 2.0 * x)) * 0.5;
    speed = 6.0 * x * (1.0 - x) * 0.5;
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
  // Not drawn unless it is stood below.
  herdGone(idx);
  let seed = seeds[idx];
  let species = min(${HERD_SPECIES - 1}u, u32(round(seed.traits.z)));
  let isVehicle = species >= 4u;
  let hasTack = species == 3u && seed.traits.x >= 10.0;
  let coatSeed = select(seed.traits.x, fract(seed.traits.x), hasTack);
  let roamR = seed.anchor.z;
  let phase = seed.anchor.w;
  let flockHeading = seed.traits.w;
  let t = F.camPos.w;
  let isStreetMount = roamR <= -10.0;
  let travelling = roamR < 0.0 && !isStreetMount;
  let isDraftBeast = travelling && !isVehicle && seed.traits.x < 1.0;
  let isHitch = travelling && (isVehicle || isDraftBeast);

  var fate = fates[idx];
  var flags = select(0u, 1u, hasTack);
  var hitAge = 0.0;
  var hitDirAngle = 0.0;

  var tau = 0.0;
  var moveAmt = 0.0;
  var worldXZ = seed.anchor.xy;
  var walkYaw = flockHeading;
  var rolled = 0.0;
  var anchorRolled = 0.0;
  var routeDeckY = 0.0;
  var routeHeader = 0u;
  var yokeSample = HerdRouteSample(vec2f(0.0), vec2f(0.0, 1.0), 0.0);
  var wayGroundY = -1000.0;
  var streetMountOnDeck = false;
  var streetMountStopped = false;
  var streetMountWalkerIdx = 0xffffffffu;
  var streetMountHalfW = 0.45;
  var streetMountCrossSlope = 0.0;
  var streetMountCenterY = 0.0;
  var streetMountCenterXZ = vec2f(0.0);
  var streetMountForward = vec2f(0.0, 1.0);
  var streetMountGoing = 1.0;
  var streetMountSide = 0.35;
  var streetMountSpeed = 2.5;
  var isPanicking = false;
  let shiftXZ = vec2f(nearTerrain.grid.y, nearTerrain.grid.z);
  let scale = seed.traits.y;

  if (isStreetMount) {
    // Urban street mount coupled 1:1 with TOWNSFOLK_WALK via worldBodies[WB_MOUNT_POSE_BASE + walkerIdx].
    let rawWIdx = seed.traits.w;
    if (rawWIdx >= 0.0 && rawWIdx < f32(WB_MOUNT_POSE_MAX)) {
      streetMountWalkerIdx = u32(rawWIdx + 0.5);
      worldBodies[WB_MOUNT_POSE_BASE + streetMountWalkerIdx] = WorldBody(vec4f(0.0), vec4f(0.0));
    }
    routeHeader = u32(seed.anchor.x);
    let mHead0 = routes[routeHeader];      // (sampleCount, lengthM, speed, indoors)
    let mHead1 = routes[routeHeader + 1u]; // (pauseAt, pauseFor, side, walkerFlags)
    let sampleCount = u32(mHead0.x);
    let lengthM = mHead0.y;
    let speed = max(mHead0.z, 0.1);
    let indoors = mHead0.w;
    let pauseAt = mHead1.x;
    let pauseFor = mHead1.y;
    let side = mHead1.z;
    let wFlags = u32(mHead1.w + 0.5);
    let abroad = -roamR - 10.0;
    streetMountSide = side;
    streetMountSpeed = speed;

    if (fate.status.x < 1.5) {
      if (abroad > 0.1 + 0.9 * smoothstep(-0.1, 0.14, F.sunDir.y)) { return; }
      let av0 = herdAvoid[idx];
      let hasInit = av0.z >= 0.5;
      let clkDelay = select(0.0, av0.y, hasInit);
      let walking = lengthM / speed;
      let leg = walking + pauseFor + indoors;
      let turn = fract((t - clkDelay) / (2.0 * leg) + phase) * 2.0 * leg;
      let back = turn >= leg;
      let inLeg = turn - select(0.0, leg, back);
      let arrived = inLeg >= walking + pauseFor;
      if (arrived && ((wFlags >> select(2u, 1u, back)) & 1u) == 0u) { return; }
      let stopAt = walking * pauseAt;
      let stopped = arrived || (pauseFor > 0.0 && inLeg >= stopAt && inLeg < stopAt + pauseFor);
      streetMountStopped = stopped;
      let walked = min(lengthM, (min(inLeg, stopAt) + max(0.0, inLeg - stopAt - pauseFor)) * speed);
      let metres = select(walked, lengthM - walked, back);
      let going = select(1.0, -1.0, back);
      streetMountGoing = going;
      let along = metres / ${ROUTE_STEP_M.toFixed(4)};
      let si = min(u32(max(along, 0.0)), max(sampleCount, 2u) - 2u);
      let s0 = routes[routeHeader + 2u + si];
      let s1 = routes[routeHeader + 2u + si + 1u];
      let sFrac = clamp(along - f32(si), 0.0, 1.0);
      let hereXYZ = mix(s0.xyz, s1.xyz, sFrac);
      let v0 = u32(max(s0.w - 16.0, 0.0) + 0.5);
      let v1 = u32(max(s1.w - 16.0, 0.0) + 0.5);
      let w0 = select(vec2f(f32(v0 & 511u) * 0.01, f32((v0 >> 9u) & 2047u) * 0.001 - 0.5), vec2f(s0.w, 0.0), s0.w < 16.0);
      let w1 = select(vec2f(f32(v1 & 511u) * 0.01, f32((v1 >> 9u) & 2047u) * 0.001 - 0.5), vec2f(s1.w, 0.0), s1.w < 16.0);
      streetMountOnDeck = ((s0.w >= 16.0 && (v0 >> 20u) != 0u) || (s1.w >= 16.0 && (v1 >> 20u) != 0u));
      let ws = mix(w0, w1, sFrac);
      streetMountHalfW = max(ws.x, 0.45);
      streetMountCrossSlope = ws.y;
      streetMountCenterY = hereXYZ.y;
      streetMountCenterXZ = hereXYZ.xz;
      let aheadIdx = min(si + 3u, sampleCount - 1u);
      let behindIdx = u32(max(i32(si) - 2, 0));
      let ahead = routes[routeHeader + 2u + aheadIdx].xz - routes[routeHeader + 2u + behindIdx].xz;
      let forward = normalize(ahead + vec2f(1e-4, 0.0));
      streetMountForward = forward;
      let prefLat = going * side * ws.x;
      let curLat = select(prefLat, av0.x, hasInit);
      let aside = vec2f(forward.y, -forward.x) * curLat;
      worldXZ = vec2f(hereXYZ.x + aside.x, hereXYZ.z + aside.y);
      wayGroundY = hereXYZ.y + curLat * ws.y;
      let facing = forward * going;
      walkYaw = atan2(facing.x, facing.y);
      rolled = walked;
      tau = walked;
      moveAmt = select(clamp(speed / 2.2, 0.35, 1.0), 0.0, stopped);
    } else {
      wayGroundY = herdGroundY(vec2f(fate.motion.z, fate.motion.y));
    }
  } else if (travelling) {
    routeHeader = u32(seed.anchor.x);
    let head = routes[routeHeader];
    let days = max(head.y - head.x, 1e-3);
    let share = clamp((cfg.boardDay - head.x) / days, 0.0, 1.0);
    let phaseOffset = clamp(-roamR - 1.0, 0.0, 0.9999);
    let phaseShare = fract(share + phaseOffset);
    let calSpeed = head.w / days * cfg.daysPerSecond;
    // Active trains pace at 0.92 m/s; mounted road couriers/envoys trot/canter at 2.85 m/s.
    let basePace = select(0.92, 2.85, hasTack);
    let paceFloor = max(0.0, basePace - calSpeed);
    let cycle = max(head.w + 48.0, 1.0);
    let rawDist = fract(share + phaseOffset) * head.w + paceFloor * t;
    let wrappedDist = rawDist - cycle * floor(rawDist / cycle);
    let headDist = select(phaseShare * head.w, wrappedDist, calSpeed < basePace && head.w > 1.0);

    let wander = select(0.0, 1.0, !isHitch && !hasTack);
    let behind = seed.anchor.y + wander * 0.9 * sin(t * 0.11 + phase * 3.0);
    anchorRolled = headDist - behind;
    let yokeRolled = anchorRolled + CARAVAN_YOKE_AHEAD_M;
    rolled = select(anchorRolled, yokeRolled, isDraftBeast);

    let atVeh = herdRouteAt(routeHeader, anchorRolled);
    yokeSample = herdRouteAt(routeHeader, yokeRolled);
    var at = atVeh;
    if (isDraftBeast) { at = yokeSample; }
    routeDeckY = at.deckY;

    let lateral = seed.traits.w + wander * 1.1 * sin(t * 0.13 + phase * 7.0);
    worldXZ = at.pos + vec2f(at.dir.y, -at.dir.x) * lateral;
    walkYaw = atan2(at.dir.x, at.dir.y) + wander * 0.25 * sin(t * 0.21 + phase * 5.0);

    // Check coupled hitch destruction state ([vehicle = base, draftL = base+1, draftR = base+2]).
    var hitchDamaged = fate.status.x >= 1.5;
    var unhitchedBolt = false;
    if (isHitch) {
      var vehIdx = idx;
      if (isDraftBeast) {
        vehIdx = select(idx - 2u, idx - 1u, seed.traits.w < 0.0);
      }
      let draftL = vehIdx + 1u;
      let draftR = vehIdx + 2u;
      if (vehIdx < cfg.count && draftR < cfg.count && abs(seeds[vehIdx].anchor.y - seed.anchor.y) < 1e-3) {
        let vf = fates[vehIdx];
        let dlf = fates[draftL];
        let drf = fates[draftR];
        if (vf.status.x >= 1.5) {
          hitchDamaged = true;
          if (isVehicle) {
            flags = flags | 4u;
            hitAge = herdSecondsSince(vf.status.y, t);
            hitDirAngle = atan2(vf.status.z, vf.status.w);
            anchorRolled = vf.motion.x;
            worldXZ = vec2f(vf.motion.z, vf.motion.y);
            walkYaw = vf.motion.w;
            moveAmt = 0.0;
          } else if (fate.status.x < 1.5) {
            // Vehicle shattered: surviving unhitched draft beast breaks free and gallops ahead!
            unhitchedBolt = true;
            let boltAge = herdSecondsSince(vf.status.y, t);
            rolled = vf.motion.x + CARAVAN_YOKE_AHEAD_M + min(boltAge, 32.0) * 4.4;
            let boltAt = herdRouteAt(routeHeader, rolled);
            routeDeckY = boltAt.deckY;
            let veer = seed.traits.w * (1.0 + 0.45 * smoothstep(0.0, 2.0, boltAge));
            worldXZ = boltAt.pos + vec2f(boltAt.dir.y, -boltAt.dir.x) * veer;
            walkYaw = atan2(boltAt.dir.x, boltAt.dir.y);
          }
        } else if (dlf.status.x >= 1.5 || drf.status.x >= 1.5) {
          // One or both draft beasts felled: vehicle halts on roadbed and drops draft pole!
          hitchDamaged = true;
          let useLeft = dlf.status.x >= 1.5;
          let hfStatus = select(drf.status, dlf.status, useLeft);
          let hfMotion = select(drf.motion, dlf.motion, useLeft);
          anchorRolled = hfMotion.x - CARAVAN_YOKE_AHEAD_M;
          let haltedVeh = herdRouteAt(routeHeader, anchorRolled);
          yokeSample = herdRouteAt(routeHeader, hfMotion.x);
          if (isVehicle) {
            flags = flags | 8u;
            hitAge = herdSecondsSince(hfStatus.y, t);
            worldXZ = haltedVeh.pos;
            routeDeckY = haltedVeh.deckY;
            walkYaw = atan2(haltedVeh.dir.x, haltedVeh.dir.y);
          } else if (fate.status.x < 1.5) {
            rolled = hfMotion.x;
            worldXZ = yokeSample.pos + vec2f(yokeSample.dir.y, -yokeSample.dir.x) * seed.traits.w;
            routeDeckY = yokeSample.deckY;
            walkYaw = atan2(yokeSample.dir.x, yokeSample.dir.y);
          }
        }
      }
    }

    // Atomic hitch culling for intact hitches; damaged/wrecked hitches remain visible on the road.
    let vehSurfY = herdSurfaceY(atVeh.pos, atVeh.deckY);
    let yokeSurfY = herdSurfaceY(yokeSample.pos, yokeSample.deckY);
    let hitchDry = (vehSurfY >= 0.32 || atVeh.deckY > 0.25) && (yokeSurfY >= 0.32 || yokeSample.deckY > 0.25);
    let hitchSpanOk = anchorRolled > 0.5 && yokeRolled < head.w - 0.5 && hitchDry;
    let singleSpanOk = rolled > 0.0 && rolled < head.w;
    let onRoad = hitchDamaged || (cfg.boardDay >= head.x && cfg.boardDay <= head.y + 0.05 && select(singleSpanOk, hitchSpanOk, isHitch && !unhitchedBolt));
    if (!onRoad) { return; }
    let visSpeed = max(calSpeed, basePace);
    if (unhitchedBolt) {
      moveAmt = 1.0;
      tau = rolled * 1.35;
      isPanicking = true;
    } else if ((flags & 12u) != 0u || hitchDamaged) {
      moveAmt = 0.0;
      tau = rolled;
    } else {
      moveAmt = clamp(visSpeed / select(0.9, 2.2, hasTack), 0.0, 1.0);
      tau = rolled;
    }
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

  // Apply existing panic/stampede or felled state BEFORE evaluating new incoming shots.
  if (!isVehicle && fate.status.x > 0.5 && fate.status.x < 1.5) {
    let panicAge = herdSecondsSince(fate.status.y, t);
    if (panicAge < HERD_STAMPEDE_SPAN_S) {
      let topSpeed = select(4.5, 6.4, species == 3u);
      let runDist = topSpeed * (panicAge - 0.35 * panicAge * panicAge / HERD_STAMPEDE_SPAN_S);
      let fleeDir = vec2f(fate.status.z, fate.status.w);
      let runPos = vec2f(fate.motion.z, fate.motion.y) + fleeDir * runDist;
      let dryOk = herdGroundY(runPos) >= 0.45;
      let safePos = select(vec2f(fate.motion.z, fate.motion.y), runPos, dryOk);
      let settle = smoothstep(HERD_STAMPEDE_SPAN_S - 2.5, HERD_STAMPEDE_SPAN_S, panicAge);
      worldXZ = mix(safePos, worldXZ, settle);
      walkYaw = atan2(fleeDir.x, fleeDir.y);
      moveAmt = mix(1.0, moveAmt, settle);
      tau = runDist * 1.45;
      isPanicking = settle < 0.85;
    } else {
      fate.status.x = 0.0;
      fates[idx] = fate;
    }
  }

  // Unified GPU physical-space collision, anticipatory steering & body-turning (js/world-bodies.js).
  // Every live animal and street mount occupies real 2D capsule volume and steers cleanly around
  // static square monuments (Pelourinhos, wells, stalls), the ashore captain, vehicles, other animals, and pedestrians.
  let selfDims = herdBodyDims(species, scale);
  let selfR = selfDims.x;
  let selfHL = selfDims.y;
  if (!isVehicle && !isHitch && fate.status.x < 1.5 && !isPanicking) {
    let av = herdAvoid[idx];
    let hasInit = av.z >= 0.5;
    let dt = select(0.0, clamp(herdSecondsSince(av.z - 1.0, t), 0.0, 0.25), hasInit);
    let hdr = worldBodies[WB_HEADER_SLOT].pos;
    let nStatic = min(u32(hdr.x + 0.5), WB_STATIC_MAX);
    let nHerds = min(u32(hdr.y + 0.5), WB_HERD_MAX);
    let nWalkers = min(u32(hdr.z + 0.5), WB_WALKER_MAX);

    if (isStreetMount) {
      let curLat = select(streetMountGoing * streetMountSide * streetMountHalfW, av.x, hasInit);
      let curDelay = select(0.0, av.y, hasInit);
      let selfW = worldXZ + shiftXZ;
      let facing0 = streetMountForward * streetMountGoing;
      let right0 = vec2f(facing0.y, -facing0.x);
      let curRightM = curLat * streetMountGoing;
      let prefRightM = streetMountSide * streetMountHalfW;
      let selfY = select(herdGroundY(worldXZ), wayGroundY, wayGroundY > -500.0);

      var steerRightM = 0.0;
      var pushRightM = 0.0;
      var moveFrac = 1.0;
      var sawStatic = false;
      var sawNear = false;

      // Scan captain (slot 1), static square obstacles, all other herds/mounts/vehicles, and pedestrians.
      for (var passKind = 0u; passKind < 4u; passKind++) {
        var bStart = WB_CAPTAIN_SLOT;
        var bEnd = WB_CAPTAIN_SLOT + 1u;
        if (passKind == 1u) { bStart = WB_STATIC_BASE; bEnd = WB_STATIC_BASE + nStatic; }
        else if (passKind == 2u) { bStart = WB_HERD_BASE; bEnd = WB_HERD_BASE + nHerds; }
        else if (passKind == 3u) { bStart = WB_WALKER_BASE; bEnd = WB_WALKER_BASE + nWalkers; }
        for (var bi = bStart; bi < bEnd; bi++) {
          if (passKind == 2u && bi == WB_HERD_BASE + idx) { continue; }
          if (passKind == 3u && streetMountWalkerIdx < WB_WALKER_MAX && bi == WB_WALKER_BASE + streetMountWalkerIdx) { continue; }
          let ob = worldBodies[bi];
          if (ob.pos.w <= 0.01) { continue; }
          let dXZ = ob.pos.xz - selfW;
          if (abs(dXZ.x) > 7.5 || abs(dXZ.y) > 7.5 || abs(ob.pos.y - selfY) > 2.6) { continue; }
          let oFlags = u32(ob.dir.w + 0.5);
          if ((oFlags & WB_FLAG_ACTIVE) == 0u) { continue; }
          let isStat = (oFlags & WB_FLAG_STATIC) != 0u;
          let isCap = (oFlags & WB_FLAG_CAPTAIN) != 0u;
          let isVeh = (oFlags & WB_FLAG_VEHICLE) != 0u;
          let isPeerMount = (oFlags & (WB_FLAG_MOUNT | WB_FLAG_ANIMAL)) != 0u;
          let obDir = vec2f(sin(ob.dir.x), cos(ob.dir.x));
          let ct = wbCapsuleContact(selfW, facing0, selfHL, selfR, ob.pos.xz, obDir, ob.dir.y, ob.pos.w);
          let sep = ct.xy; // from B to A
          let gap = ct.z;
          let pen = ct.w;
          let fwd = dot(dXZ, facing0);
          let lat = dot(dXZ, right0);
          let lookDist = select(select(3.6, 4.8, isPeerMount || isCap), 6.2, isStat || isVeh);
          let backDist = select(-1.4, -2.8, isStat || isVeh);
          if (fwd > backDist && fwd < lookDist && gap < select(1.4, 2.8, isStat || isVeh)) {
            sawNear = true;
            if (isStat) { sawStatic = true; }
            let prox = 1.0 - clamp(max(gap, 0.0) / select(1.8, 3.2, isStat || isVeh), 0.0, 1.0);
            let sideSign = select(select(-1.0, 1.0, lat < 0.0), select(-1.0, 1.0, (idx & 1u) == 0u), abs(lat) < 0.12);
            let sameDir = dot(facing0, obDir);
            var passSign = sideSign;
            if (!isStat && sameDir < -0.25) { passSign = 1.0; }
            let clearNeed = max(0.0, (selfR + ob.pos.w + select(0.45, 1.15, isStat || isVeh)) - abs(lat));
            let gain = select(select(0.65, 1.15, isPeerMount || isCap), 2.1, isStat || isVeh);
            steerRightM += passSign * (0.45 + clearNeed) * prox * gain;
          }
          if (!streetMountStopped && fwd > 0.10 && gap < select(0.65, 1.25, isStat || isVeh || isPeerMount) && abs(lat) < (selfR + ob.pos.w) * 0.92) {
            let qCap = clamp(gap / select(0.65, 1.25, isStat || isVeh || isPeerMount), 0.0, 1.0);
            if (isStat || isCap || isVeh) {
              moveFrac = min(moveFrac, max(0.22, qCap));
            } else {
              let oStopped = (oFlags & WB_FLAG_STOPPED) != 0u || ob.dir.z < 0.08;
              let yieldTie = !isPeerMount || (idx > (bi - WB_HERD_BASE));
              if (yieldTie || oStopped) { moveFrac = min(moveFrac, max(0.05, qCap)); }
            }
          }
          if (pen > 0.0) {
            if (isStat) { sawStatic = true; }
            let latPush = dot(sep, right0);
            let pushSign = select(sign(latPush), select(-1.0, 1.0, lat < 0.0), abs(latPush) < 0.15);
            let wPush = select(select(0.65, 1.05, isCap || isVeh), 1.65, isStat);
            pushRightM += pushSign * (pen + select(0.05, 0.22, isStat)) * wPush;
            if (fwd > 0.0) { moveFrac = min(moveFrac, 0.06); }
          }
        }
      }

      let maxLat = max(streetMountHalfW, select(0.55, 5.6, sawStatic));
      let wantRightM = clamp(prefRightM + clamp(steerRightM, -maxLat * 1.4, maxLat * 1.4), -maxLat, maxLat);
      let latRate = select(1.85, 3.6, sawStatic || abs(pushRightM) > 0.05);
      let maxLatStep = max(0.03, dt * latRate);
      let smoothRightM = curRightM + clamp(wantRightM - curRightM, -maxLatStep, maxLatStep);
      let finalRightM = clamp(smoothRightM + clamp(pushRightM, -1.6, 1.6), -maxLat, maxLat);
      let newLat = finalRightM * streetMountGoing;
      let latVel = select(0.0, (finalRightM - curRightM) / max(dt, 0.016), dt > 1e-4);
      let newDelay = curDelay + select(0.0, dt * (1.0 - moveFrac), !streetMountStopped && dt > 0.0);

      let asideNew = vec2f(streetMountForward.y, -streetMountForward.x) * newLat;
      worldXZ = streetMountCenterXZ + asideNew;
      let onWideSquare = abs(newLat) > streetMountHalfW + 0.18 && !streetMountOnDeck;
      wayGroundY = select(streetMountCenterY + newLat * streetMountCrossSlope, herdGroundY(worldXZ), onWideSquare);
      if (moveFrac < 0.14) { streetMountStopped = true; }
      moveAmt = select(clamp((streetMountSpeed * moveFrac) / 2.2, 0.20, 1.0), 0.0, streetMountStopped);

      // Turn the horse's physical heading smoothly into the maneuver when curving around obstacles/crowds.
      let baseYaw = atan2(facing0.x, facing0.y);
      let travelVec = facing0 * max(0.45, streetMountSpeed * moveFrac) + right0 * clamp(latVel, -2.4, 2.4);
      let targetYaw = select(baseYaw, atan2(travelVec.x, travelVec.y), !streetMountStopped && (sawNear || abs(latVel) > 0.06));
      let prevYaw = select(baseYaw, av.w, hasInit);
      let maxTurn = max(0.08, dt * 3.0);
      walkYaw = prevYaw + clamp(herdTurnDelta(prevYaw, targetYaw), -maxTurn, maxTurn);
      herdAvoid[idx] = vec4f(newLat, newDelay, t + 1.0, walkYaw);
    } else {
      // Pasture livestock & loose caravan droves/riders: 2D world-space capsule avoidance + body turning.
      let nomXZ = worldXZ;
      let curOff = select(vec2f(0.0), av.xy, hasInit);
      let curXZ = nomXZ + curOff;
      let selfW = curXZ + shiftXZ;
      let selfDir = vec2f(sin(walkYaw), cos(walkYaw));
      let selfRight = vec2f(selfDir.y, -selfDir.x);
      let selfY = herdGroundY(curXZ);

      var steerXZ = vec2f(0.0);
      var pushXZ = vec2f(0.0);
      var moveFrac = 1.0;

      for (var passKind = 0u; passKind < 4u; passKind++) {
        var bStart = WB_CAPTAIN_SLOT;
        var bEnd = WB_CAPTAIN_SLOT + 1u;
        if (passKind == 1u) { bStart = WB_STATIC_BASE; bEnd = WB_STATIC_BASE + nStatic; }
        else if (passKind == 2u) { bStart = WB_HERD_BASE; bEnd = WB_HERD_BASE + nHerds; }
        else if (passKind == 3u) { bStart = WB_WALKER_BASE; bEnd = WB_WALKER_BASE + nWalkers; }
        for (var bi = bStart; bi < bEnd; bi++) {
          if (passKind == 2u && bi == WB_HERD_BASE + idx) { continue; }
          let ob = worldBodies[bi];
          if (ob.pos.w <= 0.01) { continue; }
          let dXZ = ob.pos.xz - selfW;
          if (abs(dXZ.x) > 5.5 || abs(dXZ.y) > 5.5 || abs(ob.pos.y - selfY) > 2.4) { continue; }
          let oFlags = u32(ob.dir.w + 0.5);
          if ((oFlags & WB_FLAG_ACTIVE) == 0u) { continue; }
          let isStat = (oFlags & WB_FLAG_STATIC) != 0u;
          let isCap = (oFlags & WB_FLAG_CAPTAIN) != 0u;
          let isVeh = (oFlags & WB_FLAG_VEHICLE) != 0u;
          let obDir = vec2f(sin(ob.dir.x), cos(ob.dir.x));
          let ct = wbCapsuleContact(selfW, selfDir, selfHL, selfR, ob.pos.xz, obDir, ob.dir.y, ob.pos.w);
          let sep = ct.xy;
          let gap = ct.z;
          let pen = ct.w;
          let fwd = dot(dXZ, selfDir);
          let lat = dot(dXZ, selfRight);
          let lookGap = select(1.15, 2.2, isStat || isCap || isVeh);
          if (gap < lookGap && fwd > -0.4) {
            let prox = 1.0 - clamp(max(gap, 0.0) / lookGap, 0.0, 1.0);
            let tang = select(-selfRight, selfRight, lat < 0.0);
            steerXZ += (sep * 0.65 + tang * 0.85) * prox * select(0.9, 1.8, isStat || isCap || isVeh);
            if (fwd > 0.1 && gap < 0.45 && abs(lat) < (selfR + ob.pos.w) * 0.8) {
              moveFrac = min(moveFrac, clamp(gap / 0.45, 0.12, 1.0));
            }
          }
          if (pen > 0.0) {
            let wPush = select(0.58, 1.0, isStat || isCap || isVeh);
            pushXZ += sep * (pen + 0.02) * wPush;
            if (fwd > 0.0) { moveFrac = min(moveFrac, 0.15); }
          }
        }
      }

      let decay = exp(-dt * 0.45);
      let stepVec = clamp(steerXZ, vec2f(-2.0), vec2f(2.0)) * dt * 1.35 + clamp(pushXZ, vec2f(-0.75), vec2f(0.75));
      let candOff = curOff * decay + stepVec;
      let maxOff = max(abs(roamR) + 3.0, 5.2);
      let candLen = length(candOff);
      let clampedOff = select(candOff, candOff * (maxOff / candLen), candLen > maxOff);
      let candXZ = nomXZ + clampedOff;
      let drySafe = herdGroundY(candXZ) >= 0.40 || (travelling && routeDeckY > 0.25);
      let finalOff = select(curOff, clampedOff, drySafe);
      worldXZ = nomXZ + finalOff;
      let dispVel = select(vec2f(0.0), (finalOff - curOff) / max(dt, 0.016), dt > 1e-4);
      let baseSpd = select(0.65, 1.25, species == 3u) * moveAmt * moveFrac;
      let combinedV = selfDir * baseSpd + dispVel;
      let vLen = length(combinedV);
      let prevYaw = select(walkYaw, av.w, hasInit);
      let targetYaw = select(walkYaw, atan2(combinedV.x, combinedV.y), vLen > 0.18);
      let maxTurn = max(0.06, dt * 2.4);
      walkYaw = prevYaw + clamp(herdTurnDelta(prevYaw, targetYaw), -maxTurn, maxTurn);
      moveAmt = max(moveAmt * moveFrac, clamp(length(dispVel) / 1.4, 0.0, 0.85));
      herdAvoid[idx] = vec4f(finalOff.x, finalOff.y, t + 1.0, walkYaw);
    }
  }

  var groundY = herdGroundY(worldXZ);
  if (isStreetMount && fate.status.x < 1.5 && wayGroundY > -500.0) {
    groundY = wayGroundY;
  } else if (isStreetMount && wayGroundY > -500.0) {
    groundY = max(groundY, wayGroundY);
  }
  let onBridge = travelling && routeDeckY > 0.25;
  var wy = select(groundY, max(groundY, routeDeckY), onBridge);

  // Evaluate incoming cannonball / roundshot sweeps (shots).
  if (shots.header.x > 0u && fate.status.x < 1.5) {
    var hitH = 0.90 * scale;
    var hitR = 0.48 * scale;
    if (species == 1u) { hitH = 1.52 * scale; hitR = 0.88 * scale; }
    else if (species == 2u) { hitH = 0.72 * scale; hitR = 0.44 * scale; }
    else if (species == 3u) { hitH = select(1.75, 2.20, hasTack) * scale; hitR = 0.86 * scale; }
    else if (isVehicle) { hitH = 2.02 * scale; hitR = 1.45 * scale; }

    let shotCount = min(shots.header.x, ${HERD_SHOT_LIMIT}u);
    for (var sIdx = 0u; sIdx < shotCount; sIdx = sIdx + 1u) {
      let sh = shots.list[sIdx];
      let sa = vec3f(sh.a.x - shiftXZ.x, sh.a.y, sh.a.z - shiftXZ.y);
      let sb = vec3f(sh.b.x - shiftXZ.x, sh.b.y, sh.b.z - shiftXZ.y);
      let seg = sb - sa;
      let segLen2 = dot(seg, seg);
      let midC = vec3f(worldXZ.x, wy + hitH * 0.5, worldXZ.y);
      let tSeg = select(0.0, clamp(dot(midC - sa, seg) / segLen2, 0.0, 1.0), segLen2 > 1e-6);
      let closest = sa + seg * tSeg;
      let dxz = worldXZ - closest.xz;
      let dyBox = max(max(wy - closest.y, closest.y - (wy + hitH)), 0.0);
      let distShot = length(vec3f(dxz.x, dyBox, dxz.y));
      if (distShot <= hitR + sh.a.w) {
        let rawDir = select(dxz, seg.xz, dot(seg.xz, seg.xz) > 1e-4);
        let hitDir = select(vec2f(0.0, 1.0), normalize(rawDir), dot(rawDir, rawDir) > 1e-6);
        let savedRoll = select(rolled, anchorRolled, isVehicle);
        fate.status = vec4f(2.0, t, hitDir.x, hitDir.y);
        fate.motion = vec4f(savedRoll, worldXZ.y, worldXZ.x, walkYaw);
        fates[idx] = fate;
        if (isVehicle) {
          flags = flags | 4u;
          hitAge = 0.0;
          hitDirAngle = atan2(hitDir.x, hitDir.y);
        }
        break;
      } else if (!isVehicle && !isHitch && !isStreetMount && distShot < HERD_STAMPEDE_M) {
        let away = worldXZ - closest.xz;
        let fleeDir = select(vec2f(sin(walkYaw), cos(walkYaw)), normalize(away), dot(away, away) > 1e-4);
        fate.status = vec4f(1.0, t, fleeDir.x, fleeDir.y);
        fate.motion = vec4f(rolled, worldXZ.y, worldXZ.x, walkYaw);
        fates[idx] = fate;
        isPanicking = true;
        moveAmt = 1.0;
      }
    }
  }

  // Apply felled knockback & stationary resting placement for struck livestock (species 0..3).
  if (!isVehicle && fate.status.x >= 1.5) {
    flags = flags | 2u;
    hitAge = herdSecondsSince(fate.status.y, t);
    hitDirAngle = atan2(fate.status.z, fate.status.w);
    let kbDist = (0.8 + 1.0 * fract(phase * 13.7 + 0.31)) * (1.0 - exp(-hitAge * 5.5));
    let kbPos = vec2f(fate.motion.z, fate.motion.y) + vec2f(fate.status.z, fate.status.w) * kbDist;
    let kbGround = herdGroundY(kbPos);
    worldXZ = select(vec2f(fate.motion.z, fate.motion.y), kbPos, kbGround >= 0.35 || onBridge || isStreetMount);
    walkYaw = fate.motion.w;
    moveAmt = 0.0;
    groundY = herdGroundY(worldXZ);
    if (isStreetMount && wayGroundY > -500.0) { groundY = max(groundY, wayGroundY); }
    wy = select(groundY, max(groundY, routeDeckY), onBridge);
  }

  if (wy < 0.32 && !onBridge && !isStreetMount) { return; }
  // Drawn standing on the ground the land draws there (js/continuum-ground.js), where it stands on the land and not on
  // a deck or a street raised over it; street mounts mirror TOWNSFOLK_WALK's dry-land ground lift so horse & rider stay flush.
  if (isStreetMount) {
    if (wy > -0.02 && !streetMountOnDeck) { wy += continuumGroundLift(worldXZ + shiftXZ); }
  } else if (wy <= herdGroundY(worldXZ) + 0.01) {
    wy += continuumGroundLift(worldXZ + shiftXZ);
  }

  // Axle-to-axle pitch and articulated draft tongue orientation.
  var slopePitch = 0.0;
  var tongueYaw = 0.0;
  var tonguePitch = 0.0;
  if (isVehicle && travelling) {
    let zFront = select(select(1.05, 1.18, species == 5u), 0.95, species == 6u);
    let zBack = select(select(-1.10, -1.18, species == 5u), -0.95, species == 6u);
    let atF = herdRouteAt(routeHeader, anchorRolled + zFront);
    let atB = herdRouteAt(routeHeader, anchorRolled + zBack);
    let chord = atF.pos - atB.pos;
    if ((flags & 4u) == 0u && length(chord) > 0.15) {
      walkYaw = atan2(chord.x, chord.y);
    }
    let hFront = herdSurfaceY(atF.pos, atF.deckY);
    let hBack = herdSurfaceY(atB.pos, atB.deckY);
    slopePitch = clamp(-atan2(hFront - hBack, max(0.8, zFront - zBack)), -0.42, 0.42);

    if ((flags & 8u) != 0u) {
      // Draft team felled: draft pole pitches down onto the roadbed!
      tonguePitch = mix(0.0, 0.34, smoothstep(0.0, 0.45, hitAge));
      tongueYaw = 0.0;
    } else {
      let pivZ = select(select(1.35, 1.40, species == 5u), 1.15, species == 6u) * scale;
      let fwdVeh = vec2f(sin(walkYaw), cos(walkYaw));
      let pivXZ = worldXZ + fwdVeh * pivZ;
      let toYoke = yokeSample.pos - pivXZ;
      let yokeDist = max(1.6, length(toYoke));
      let dYaw = atan2(toYoke.x, toYoke.y) - walkYaw;
      tongueYaw = clamp(atan2(sin(dYaw), cos(dYaw)), -0.56, 0.56);
      let yokeGroundY = herdSurfaceY(yokeSample.pos, yokeSample.deckY);
      let resY = (yokeGroundY - wy) + yokeDist * sin(slopePitch);
      tonguePitch = clamp(-atan2(resY, yokeDist), -0.34, 0.34);
    }
  } else if (!isStreetMount) {
    let fwd = vec2f(sin(walkYaw), cos(walkYaw));
    let reach = 0.55;
    var hFront = herdGroundY(worldXZ + fwd * reach);
    var hBack = herdGroundY(worldXZ - fwd * reach);
    if (travelling) {
      let atF = herdRouteAt(routeHeader, rolled + reach);
      let atB = herdRouteAt(routeHeader, rolled - reach);
      if (atF.deckY > 0.25) { hFront = max(hFront, atF.deckY); }
      if (atB.deckY > 0.25) { hBack = max(hBack, atB.deckY); }
    }
    slopePitch = clamp(-atan2(hFront - hBack, reach * 2.0), -0.45, 0.45);
  }

  let alertCycle = sin(t * 0.31 + phase * 5.7);
  let wantGraze = select(1.0, smoothstep(-0.15, 0.25, alertCycle), species == 3u);
  var grazeAmt = select((1.0 - smoothstep(0.05, 0.45, moveAmt)) * wantGraze, 0.0, isHitch || isVehicle || hasTack);
  if (isPanicking) {
    grazeAmt = -0.28; // Head raised in alarm while stampeding!
  }
  let walkFreq = select(select(4.6, 3.1, species == 1u), select(5.2, 3.3, species == 3u), species >= 2u);
  let roadPhase = select(rolled * 6.2831853 / select(1.6, 2.2, hasTack) + phase * 6.2831853, rolled, isVehicle);
  let walkPhase = select(tau * walkFreq + phase * 6.2831853, roadPhase, travelling || isStreetMount);
  let tailPhase = t * (1.2 + 0.35 * fract(phase * 7.13)) + phase * 9.1;
  // Where it is drawn: its record in the one continuum, which the cut reads next. A felled beast is wounded and a
  // shattered vehicle's pieces fly apart: each is cut as clusters alone (its far body was never measured in those
  // poses); a stampeding beast or a halted hitch is what the eye is on, and is cut finer.
  var continuumFlags = 0u;
  if (isPanicking || (flags & 8u) != 0u) { continuumFlags = CONTINUUM_IMPORTANT_FLAG; }
  if ((flags & 2u) != 0u) { continuumFlags = CONTINUUM_DAMAGED; }
  if ((flags & 4u) != 0u) { continuumFlags = CONTINUUM_SHATTERED; }
  // An intact hitch thins at the horizon as one, keyed by its route and place in the train.
  let useHitchMid = isHitch && (flags & 14u) == 0u && !isPanicking;
  let thinSeed = select(idx, u32(max(floor(seed.anchor.x * 131.0 + seed.anchor.y * 17.0), 0.0)), useHitchMid);
  let outWorldPos = vec3f(worldXZ.x + shiftXZ.x, wy, worldXZ.y + shiftXZ.y);
  if (idx < WB_HERD_MAX) {
    let bFlags = WB_FLAG_ACTIVE
      | select(WB_FLAG_ANIMAL, WB_FLAG_VEHICLE, isVehicle)
      | select(0u, WB_FLAG_MOUNT, isStreetMount)
      | select(0u, WB_FLAG_STOPPED, moveAmt < 0.06 || fate.status.x >= 1.5);
    let effSpd = select(select(0.9, 2.2, species == 3u) * moveAmt, streetMountSpeed * moveAmt, isStreetMount);
    worldBodies[WB_HERD_BASE + idx] = WorldBody(
      vec4f(outWorldPos, selfR),
      vec4f(walkYaw, selfHL, effSpd, f32(bFlags))
    );
  }
  if (isStreetMount && streetMountWalkerIdx < WB_MOUNT_POSE_MAX && fate.status.x < 1.5) {
    worldBodies[WB_MOUNT_POSE_BASE + streetMountWalkerIdx] = WorldBody(
      vec4f(outWorldPos, walkYaw),
      vec4f(rolled, moveAmt, select(0.0, 1.0, streetMountStopped || moveAmt < 0.05), 1.0)
    );
  }
  herdStand(idx, species, outWorldPos, walkYaw, slopePitch, scale, continuumFlags, thinSeed, flags,
    vec4f(walkPhase, moveAmt, select(grazeAmt, tongueYaw, isVehicle), select(tailPhase, tonguePitch, isVehicle)),
    vec3f(hitAge, hitDirAngle - walkYaw, coatSeed));
}
`;

// The herds' material in the one continuum's pipeline family (js/wgsl/continuum-cut.js): how a beast's coat and a
// vehicle's timber and cloth are worn and lit. Group 0: the frame, the sky's light and the land's shadow map; group 1
// the clouds' volume (their shadow); group 2 the scene's data.
const herdContinuumPreludeWGSL = () => FRAME_WGSL + ATMO_CORE_WGSL + /* wgsl */ `
@group(0) @binding(0) var<uniform> F: Frame;
@group(0) @binding(1) var transLUT: texture_2d<f32>;
@group(0) @binding(2) var skyLUT: texture_2d<f32>;
@group(0) @binding(3) var sampC: sampler;
@group(0) @binding(4) var envCube: texture_cube<f32>;
` + SHADOW_FRAME + SKY_RENDER_FUNCS + CLOUD_SHADOW_BINDINGS + /* wgsl */ `
@group(0) @binding(19) var<uniform> landSH: ShadowFrame;
@group(0) @binding(20) var landSolidShadow: texture_depth_2d;
@group(0) @binding(21) var landShadowCompare: sampler_comparison;
` + LAND_CLOTH_SHADOW;

const HERD_CONTINUUM_MATERIAL_WGSL = () => /* wgsl */ `

fn herdShadowVis(world: vec3f, normal: vec3f) -> vec3f {
  if (landSH.origin.w < 0.5) { return vec3f(1.0); }
  let p = landSH.lightView * vec4f(world - landSH.origin.xyz + normal * 0.03 + landSH.sun.xyz * 0.025, 1.0);
  let uv = p.xy * vec2f(0.5, -0.5) + 0.5;
  let edge = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
  let fade = smoothstep(0.0, 0.06, edge) * step(0.0, p.z) * step(p.z, 1.0);
  let refZ = min(p.z - 0.08 / max(landSH.sun.w, 1.0), 0.99999);
  let at = clamp(uv, vec2f(0.0), vec2f(1.0));
  let s = textureSampleCompareLevel(landSolidShadow, landShadowCompare, at, refZ);
  return mix(vec3f(1.0), s * landClothShadow(at, refZ), fade);
}

fn herdCloudShadow(world: vec3f) -> f32 {
  return solarShadowVisibility(vec3f(cloudShadowAt(world * 0.001, F.sunDir.xyz))).x;
}

fn livestockCoatAlbedo(species: u32, coatCode: f32, texColor: vec3f, seed: f32, localXZ: vec2f) -> vec3f {
  let h1 = fract(seed * 13.713);
  let h2 = fract(seed * 47.219);
  if (coatCode >= 16.0) {
    let rgb15 = u32(round(coatCode - 16.0));
    let baseTex = vec3f(f32((rgb15 >> 10u) & 31u), f32((rgb15 >> 5u) & 31u), f32(rgb15 & 31u)) / 31.0;
    var col = select(baseTex * baseTex, max(texColor, vec3f(0.0)), texColor.x >= 0.0);
    let lum = dot(col, vec3f(0.2126, 0.7152, 0.0722));
    if (species == 0u) {
      let woolMask = smoothstep(0.14, 0.28, lum);
      let fleeceTint = mix(vec3f(0.90, 0.88, 0.82), vec3f(1.12, 1.09, 1.03), h1);
      col = mix(col, col * fleeceTint, woolMask * 0.75);
      if (h2 < 0.12) {
        col = mix(col, col * vec3f(0.14, 0.12, 0.11), woolMask * 0.90);
      } else if (h2 < 0.26) {
        col = mix(col, col * vec3f(0.55, 0.52, 0.48), woolMask * 0.80);
      }
      return col;
    }
    if (species == 1u) {
      let hornKeep = smoothstep(1.14, 1.26, localXZ.y) * smoothstep(0.18, 0.32, lum);
      let hideMask = smoothstep(0.03, 0.09, lum) * (1.0 - hornKeep);
      if (h1 < 0.22) {
        col = mix(col, vec3f(lum * 0.38, lum * 0.34, lum * 0.32), hideMask * 0.88);
      } else if (h1 < 0.52) {
        col = mix(col, col * vec3f(1.06, 0.96, 0.88), hideMask * 0.65);
      } else if (h1 < 0.78) {
        col = mix(col, vec3f(col.r * 1.28, col.g * 1.55 + 0.02, col.b * 1.65 + 0.015), hideMask * 0.75);
      }
      if (h2 < 0.22) {
        let coatPatch = smoothstep(0.05, 0.22, gnoise(localXZ * 2.4 + vec2f(seed * 19.0, seed * 7.0)));
        col = mix(col, vec3f(0.56, 0.52, 0.44) * (0.65 + 0.70 * lum), hideMask * coatPatch * 0.85);
      }
      return col;
    }
    if (species == 2u) {
      let bristleMask = smoothstep(0.015, 0.055, lum);
      if (h1 < 0.32) {
        col = mix(col, col * vec3f(1.65, 1.12, 0.88) + vec3f(0.032, 0.012, 0.005), bristleMask * 0.75);
      } else {
        col *= mix(0.86, 1.18, h1);
      }
      return col;
    }
    // Horse (species == 3u): preserve dark eyes/nostrils/hooves/mane while varying bay, chestnut, seal-brown, and dapple-grey coats.
    let coatMask = smoothstep(0.024, 0.065, lum);
    if (h1 < 0.16) {
      let dapple = 0.84 + 0.16 * gnoise(localXZ * 8.5 + vec2f(seed * 13.0));
      let grey = vec3f(0.44, 0.42, 0.39) * dapple * clamp(0.45 + lum * 4.2, 0.35, 1.15);
      col = mix(col, grey, smoothstep(0.012, 0.045, lum) * 0.90);
    } else if (h1 < 0.48) {
      col = mix(col, col * vec3f(1.38, 1.22, 0.95) + vec3f(0.028, 0.010, 0.002), coatMask * 0.78);
    } else if (h1 < 0.74) {
      col = mix(col, col * vec3f(0.52, 0.56, 0.62), coatMask * 0.82);
    } else {
      col = mix(col, col * vec3f(1.08, 1.02, 0.96), coatMask * 0.50);
    }
    return col;
  }
  let zone = u32(round(coatCode));
  if (species == 0u) {
    var fleece = mix(vec3f(0.58, 0.53, 0.43), vec3f(0.70, 0.65, 0.54), h1);
    if (h2 < 0.12) { fleece = vec3f(0.055, 0.048, 0.044); }
    else if (h2 < 0.26) { fleece = vec3f(0.32, 0.30, 0.27); }
    if (zone == 1u) {
      return select(vec3f(0.26, 0.20, 0.16), vec3f(0.06, 0.05, 0.045), h2 < 0.58);
    }
    let crimp = gnoise(localXZ * 18.0 + vec2f(seed * 31.0, 0.0)) * 0.08;
    return fleece * (1.0 + crimp);
  }
  if (species == 1u) {
    var hide = vec3f(0.24, 0.105, 0.052);
    if (h1 < 0.24) { hide = vec3f(0.048, 0.042, 0.040); }
    else if (h1 < 0.52) { hide = vec3f(0.31, 0.15, 0.068); }
    else if (h1 < 0.74) { hide = vec3f(0.42, 0.27, 0.14); }
    if (h2 < 0.28) {
      let piebald = gnoise(localXZ * 2.4 + vec2f(seed * 19.0, seed * 7.0));
      if (piebald > 0.08 || zone == 2u) { hide = vec3f(0.62, 0.58, 0.50); }
    } else if (zone == 2u) {
      hide *= 1.18;
    }
    if (zone == 1u) {
      return select(vec3f(0.055, 0.048, 0.045), vec3f(0.48, 0.43, 0.34), localXZ.y > 0.78);
    }
    if (zone == 3u) { return hide * 0.45; }
    return hide;
  }
  if (species == 2u) {
    var bristle = select(vec3f(0.065, 0.058, 0.056), vec3f(0.19, 0.10, 0.075), h1 < 0.34);
    if (h2 < 0.18) { bristle = vec3f(0.36, 0.24, 0.20); }
    if (zone == 1u) { return mix(bristle * 0.7, vec3f(0.22, 0.14, 0.13), 0.45); }
    if (zone == 2u) { return bristle * 1.15 + vec3f(0.025, 0.018, 0.014); }
    return bristle;
  }
  if (species == 4u) {
    // Covered freight wain (carreta): seasoned oak/chestnut, forged iron, and cargo-dyed linen/canvas tilt.
    let grain = 0.88 + 0.12 * gnoise(localXZ * vec2f(1.4, 22.0) + vec2f(seed * 9.0, 0.0));
    if (zone == 1u) { return vec3f(0.048, 0.045, 0.044); }
    if (zone == 2u) {
      let cargo = u32(floor(fract(seed) * 8.0));
      var cloth = vec3f(0.66, 0.61, 0.50);
      if (cargo == 1u) { cloth = vec3f(0.46, 0.19, 0.16); }
      else if (cargo == 2u) { cloth = vec3f(0.74, 0.70, 0.62); }
      else if (cargo == 3u) { cloth = vec3f(0.42, 0.39, 0.35); }
      else if (cargo == 4u) { cloth = vec3f(0.76, 0.74, 0.70); }
      else if (cargo == 5u) { cloth = vec3f(0.30, 0.35, 0.48); }
      else if (cargo == 6u) { cloth = vec3f(0.52, 0.43, 0.30); }
      else if (cargo == 7u) { cloth = vec3f(0.64, 0.58, 0.36); }
      let weave = 0.94 + 0.06 * gnoise(localXZ * 9.0 + vec2f(seed * 17.0));
      return cloth * weave;
    }
    return mix(vec3f(0.23, 0.16, 0.10), vec3f(0.34, 0.26, 0.17), h1) * grain;
  }
  if (species == 5u) {
    // Renaissance passenger/merchant coach (coche): oiled walnut/cherry panelling, crimson/burgundy/indigo velvet & leather roof, gilt trim.
    let polish = 0.90 + 0.10 * gnoise(localXZ * vec2f(2.0, 18.0) + vec2f(seed * 11.0, 0.0));
    if (zone == 1u) { return vec3f(0.040, 0.036, 0.035); }
    if (zone == 3u) { return vec3f(0.64, 0.48, 0.16); }
    if (zone == 2u) {
      var livery = vec3f(0.44, 0.09, 0.08); // Venetian crimson
      if (h2 < 0.28) { livery = vec3f(0.11, 0.15, 0.32); }       // Ultramarine / merchant navy
      else if (h2 < 0.52) { livery = vec3f(0.28, 0.12, 0.07); }  // Cordovan oiled leather
      else if (h2 < 0.74) { livery = vec3f(0.12, 0.24, 0.14); }  // Forest velvet green
      return livery * (0.94 + 0.06 * gnoise(localXZ * 8.0 + vec2f(seed * 23.0)));
    }
    return mix(vec3f(0.18, 0.095, 0.052), vec3f(0.28, 0.16, 0.085), h1) * polish;
  }
  if (species == 6u) {
    // 2-wheel Iberian cargo ox-cart (carro de bois): golden oak frame & coopered wine casks, iron hoops, hemp grain sacks.
    let grain = 0.88 + 0.12 * gnoise(localXZ * vec2f(1.6, 20.0) + vec2f(seed * 7.0, 0.0));
    if (zone == 1u) { return vec3f(0.052, 0.048, 0.046); }
    if (zone == 3u) { return vec3f(0.52, 0.43, 0.27); }
    if (zone == 2u) {
      let sack = mix(vec3f(0.58, 0.51, 0.38), vec3f(0.68, 0.62, 0.48), h2);
      return sack * (0.92 + 0.08 * gnoise(localXZ * 12.0 + vec2f(seed * 19.0)));
    }
    return mix(vec3f(0.25, 0.17, 0.10), vec3f(0.38, 0.27, 0.16), h1) * grain;
  }
  // Horse (3): rich bay, chestnut, dark seal-brown, warm Lusitano dapple-grey, plus 1550 sela à gineta tack zones (4..6).
  if (zone == 4u) {
    // Oiled Cordovan saddle leather, breastplate, crupper, headstall & reins.
    let grain = 0.92 + 0.08 * gnoise(localXZ * 16.0 + vec2f(seed * 29.0));
    return mix(vec3f(0.20, 0.078, 0.038), vec3f(0.31, 0.135, 0.062), fract(seed * 23.7)) * grain;
  }
  if (zone == 5u) {
    // Forged iron gineta stirrups, curb bit & harness bosses.
    return vec3f(0.33, 0.34, 0.36);
  }
  if (zone == 6u) {
    // Dyed 1550 royal courier saddlecloth (xairel) & alforjas saddlebags: crimson, royal blue, forest green, or ochre.
    var cloth = vec3f(0.46, 0.08, 0.075);
    if (h2 < 0.26) { cloth = vec3f(0.09, 0.15, 0.36); }
    else if (h2 < 0.50) { cloth = vec3f(0.10, 0.24, 0.13); }
    else if (h2 < 0.72) { cloth = vec3f(0.52, 0.36, 0.11); }
    return cloth * (0.93 + 0.07 * gnoise(localXZ * 11.0 + vec2f(seed * 17.0)));
  }
  var coat = vec3f(0.22, 0.095, 0.048);
  var mane = vec3f(0.035, 0.032, 0.030);
  if (h1 < 0.14) {
    let dapple = 0.84 + 0.16 * gnoise(localXZ * 8.5 + vec2f(seed * 13.0));
    coat = vec3f(0.46, 0.43, 0.38) * dapple;
    mane = vec3f(0.24, 0.22, 0.20);
  } else if (h1 < 0.52) {
    coat = vec3f(0.30, 0.13, 0.058);
    mane = vec3f(0.22, 0.10, 0.045);
  } else if (h1 < 0.76) {
    coat = vec3f(0.075, 0.052, 0.040);
  }
  if (zone == 3u) { return mane; }
  if (zone == 1u) { return mane * 0.9; }
  return coat;
}

fn shadeHerdSurface(world: vec3f, n: vec3f, albedo: vec3f, ao: f32, species: u32, zone: u32) -> vec3f {
  let shadow = herdShadowVis(world, n) * herdCloudShadow(world);
  let sunVis = solarShadowVisibility(shadow);
  let nDotL = max(dot(n, F.sunDir.xyz), 0.0);
  let wrap = max(0.0, dot(n, F.sunDir.xyz) * 0.65 + 0.35) * select(0.12, 0.28, species == 0u);
  let direct = sunIlluminance() * sunVis * (nDotL + wrap);

  let skyDir = normalize(vec3f(n.x * 0.65, max(n.y, 0.12), n.z * 0.65));
  let envIrr = textureSampleLevel(envCube, sampC, skyDir, 6.0).rgb;
  let skyUp = skyAtmo(vec3f(0.0, 1.0, 0.0));
  let groundBounce = skyUp * vec3f(0.24, 0.21, 0.14) * (1.0 - max(n.y, 0.0)) * 0.45;
  let ambient = (envIrr * 0.88 + groundBounce) * (0.38 + 0.68 * ao);

  let v = normalize(F.camPos.xyz - world);
  let hRaw = v + F.sunDir.xyz;
  let h = select(vec3f(0.0, 1.0, 0.0), normalize(hRaw), length(hRaw) > 1e-5);
  let isPolished = species == 5u || (species == 3u && (zone == 4u || zone == 5u));
  let isIron = species == 3u && zone == 5u;
  let rough = select(select(0.56, 0.34, isPolished), 0.92, species == 0u);
  let specPow = select(select(18.0, select(34.0, 56.0, isIron), isPolished), 4.0, species == 0u);
  let sheenAmt = select(select(0.055, select(0.105, 0.22, isIron), isPolished), 0.012, species == 0u);
  let sheen = pow(max(dot(n, h), 0.0), specPow) * sheenAmt * nDotL;

  var col = albedo * (direct / PI + ambient) + sunIlluminance() * sunVis * sheen;
  col += lunarSurface(n, v, albedo, rough, vec3f(0.035), lunarShadowVisibility(shadow));
  return surfaceAir(col, world);
}

fn herdTexColor(coat: f32) -> vec3f {
  if (coat < 16.0) { return vec3f(-1.0); }
  let rgb15 = u32(round(coat - 16.0));
  let base = vec3f(f32((rgb15 >> 10u) & 31u), f32((rgb15 >> 5u) & 31u), f32(rgb15 & 31u)) / 31.0;
  return base * base;
}

// A corner of whatever the cut chose for a beast: its coat (a cluster point's own, a far triangle's the nearest the
// bake found; zone + shade, or 16 + RGB555), its height at rest; a splat's colour (its type's mean, or -1 for a coat
// by zones) and its corner, about a dome over its outline whose corners lean out and whose middle faces the eye.
fn herdContinuumVarying(s: ContinuumSurface, v: ptr<function, ContinuumVarying>) {
  let species = min(${HERD_SPECIES - 1}u, s.model);
  let seed = bitcast<f32>(s.record.spare.x);
  (*v).flags = s.record.spare.y;
  if (s.what == CONTINUUM_SPLAT_ENTRY) {
    let toward = s.normal;
    let lift = continuumQuat(s.record.turn, vec3f(0.0, 1.0, 0.0));
    let up = normalize(lift - toward * dot(lift, toward) + vec3f(0.0, 1e-4, 0.0));
    let right = normalize(cross(up, toward));
    let corner = s.corner * 0.5;
    (*v).normal = normalize(right * (corner.x * 0.55) + up * (corner.y * 0.65) + toward * 0.2828);
    let colour = vec3f(continuumTypeF(s.model, ${ANIMAL_CONTINUUM_MATERIAL.colour}u), continuumTypeF(s.model, ${ANIMAL_CONTINUUM_MATERIAL.colour + 1}u), continuumTypeF(s.model, ${ANIMAL_CONTINUUM_MATERIAL.colour + 2}u));
    (*v).coatInfo = vec4f(select(0.0, 16.0, colour.x >= 0.0), 0.5, seed, f32(species));
    (*v).texColor = colour;
    (*v).localXZ = corner;
    return;
  }
  let coatA = bitcast<f32>(s.word);
  let rest = continuumPointAt(s.model, s.vertex).position;
  var coat = floor(coatA + 0.001);
  var ao = clamp(coatA - coat, 0.08, 0.98);
  if (coatA >= 16.0) {
    coat = coatA;
    ao = clamp(0.42 + 0.33 * clamp(rest.y / max(continuumTypeF(s.model, ${ANIMAL_CONTINUUM_MATERIAL.height}u), 0.4), 0.0, 1.0) + 0.23 * (0.5 + 0.5 * s.normal.y), 0.12, 0.96);
  }
  // Far, the sky its optical moments say reaches what is seen of the beast, morphed with its points.
  if (s.what == CONTINUUM_FAR_ENTRY) { ao = clamp(s.optics.x, 0.08, 0.98); }
  (*v).coatInfo = vec4f(coat, ao, seed, f32(species));
  (*v).texColor = herdTexColor(coatA);
  (*v).localXZ = vec2f(rest.z, rest.y);
}

fn herdContinuumShade(v: ContinuumVarying, front: bool) -> vec4f {
  let species = min(${HERD_SPECIES - 1}u, u32(round(v.coatInfo.w)));
  var coatCode = v.coatInfo.x;
  var ao = v.coatInfo.y;
  var zone = select(u32(round(coatCode)), 0u, coatCode >= 16.0);
  var localXZ = v.localXZ;
  if (v.coverage.x == CONTINUUM_SPLAT_ENTRY) {
    // A splat's upper half is a vehicle's tilt or roof (zone 2); a saddled horse's crest, its saddlecloth (zone 6).
    let uv = v.localXZ;
    if (coatCode < 16.0) {
      zone = select(0u, 2u, species >= 4u && uv.y > -0.05);
      if ((v.flags & 1u) != 0u && uv.y > 0.15 && abs(uv.x) < 0.45) { zone = 6u; }
      coatCode = f32(zone);
    }
    ao = clamp(0.56 + 0.34 * uv.y, 0.25, 0.95);
    localXZ = uv * 0.5;
  }
  let albedo = livestockCoatAlbedo(species, coatCode, v.texColor, v.coatInfo.z, localXZ);
  return vec4f(shadeHerdSurface(v.world, normalize(v.normal), albedo, ao, species, zone), 1.0);
}
`;

// The herds' material (js/wgsl/continuum-cut.js). Their bodies are closed and wound outward.
export const HERD_CONTINUUM_MATERIAL_SPEC = Object.freeze({
  name: 'herdContinuum', prelude: herdContinuumPreludeWGSL, core: false, data: Object.freeze({ group: 2, binding: 0 }),
  varyings: [['coatInfo', 'vec4f'], ['localXZ', 'vec2f'], ['texColor', 'vec3f'], ['flags', 'u32', true]],
  wgsl: HERD_CONTINUUM_MATERIAL_WGSL, salt: 11, cullMode: 'back', air: false, capture: false,
});

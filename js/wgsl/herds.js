// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// 100% GPU compute + indirect instanced rendering for Old World grazing herds
// (sheep, cattle, swine, horses) and 16th-century road caravan vehicles:
//   species 4 = carreta (4-wheel covered wain),
//   species 5 = coche (4-wheel passenger/merchant coach),
//   species 6 = carro de bois (2-wheel heavy cargo ox-cart).
// Includes atomic coupled hitch culling, articulated draft poles/yokes, and Rule-3
// continuous MSAA sample-mask crossfade into a 1-triangle horizon splat + hash thinning.
import { FRAME_WGSL, ATMO_CORE_WGSL } from './common.js';
import { SKY_RENDER_FUNCS } from './sky.js';
import { CLOUD_SAMPLE } from './clouds.js';
import { SHADOW_FRAME } from './shadows.js';

export const HERD_SEED_FLOATS = 8;
export const HERD_BODY_FLOATS = 12;
export const HERD_DRAW_WORDS = 5;
export const HERD_SPECIES = 7;
export const HERD_SPLAT_BUCKET = HERD_SPECIES * 2; // 14: 1-triangle far horizon splat bucket
export const HERD_BUCKETS = HERD_SPECIES * 2 + 1;  // 0..6 main meshes, 7..13 shadow meshes, 14 horizon splats
export const HERD_ROUTE_HEADER = 1;

const HERD_RIG_FN = /* wgsl */ `
struct HerdBody {
  posYaw: vec4f,     // worldX (unshifted), groundY, worldZ (unshifted), yaw
  animCoat: vec4f,   // walkPhase, walkAmp, grazeAmt_or_tongueYaw, coatSeed
  slopeScale: vec4f, // slopePitch, scale, tailPhase_or_tonguePitch, speciesPlusFade
};

struct HerdSpeciesRig {
  neck: vec4f, // livestock: (pivotX, pivotY, pivotZ, maxGrazePitch); vehicles: (frontWheelR, tonguePivY, tonguePivZ, 0)
  legs: vec4f, // livestock: (legY, frontZ, backZ, height); vehicles: (rearWheelR, frontAxleZ, rearAxleZ, height)
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

fn herdOrderedMask(instHash: u32, pix: vec2u, keep: f32, invert: bool) -> u32 {
  let nKeep = clamp(u32(round(keep * 4.0)), 0u, 4u);
  if (!invert && nKeep >= 4u) { return 0xfu; }
  if (!invert && nKeep == 0u) { return 0u; }
  if (invert && nKeep == 0u) { return 0xfu; }
  if (invert && nKeep >= 4u) { return 0u; }
  let rot = (instHash ^ (pix.x * 3u + pix.y * 5u)) & 3u;
  var m = 0u;
  for (var s = 0u; s < 4u; s = s + 1u) {
    let rank = (s + rot) & 3u;
    if (rank < nKeep) {
      m = m | (1u << s);
    }
  }
  return select(m, 0xfu ^ m, invert);
}

fn poseLivestockVertex(pos: vec3f, nrm: vec3f, part: f32, body: HerdBody, rig: HerdSpeciesRig) -> HerdPosed {
  var p = pos;
  var n = nrm;
  let walkPhase = body.animCoat.x;
  let walkAmp = body.animCoat.y;
  let grazeOrTongueYaw = body.animCoat.z;
  let tailOrTonguePitch = body.slopeScale.z;
  let isVehicle = body.slopeScale.w >= 3.95;

  if (!isVehicle && part >= 1.0 && part < 1.995) {
    // Smoothly weighted neck & head pitch around chest/withers pivot while cropping grass.
    let w = clamp(part - 1.0, 0.0, 1.0);
    let nibble = 0.055 * sin(tailOrTonguePitch * 3.4) * grazeOrTongueYaw;
    let pitch = (grazeOrTongueYaw * rig.neck.w + nibble) * w;
    let yawTurn = 0.14 * sin(tailOrTonguePitch * 0.73) * grazeOrTongueYaw * w;
    let piv = rig.neck.xyz;
    var rel = rotX3(p - piv, pitch);
    rel = rotY3(rel, yawTurn);
    p = piv + rel;
    n = rotY3(rotX3(n, pitch), yawTurn);
  } else if (!isVehicle && part >= 1.995 && part < 5.5) {
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
  } else if (part >= 7.5) {
    // Articulated draft pole + yoke / horse harness (part == 8): turns & pitches cleanly toward the draft team.
    let piv = vec3f(0.0, rig.neck.y, rig.neck.z);
    var rel = rotX3(p - piv, tailOrTonguePitch);
    rel = rotY3(rel, grazeOrTongueYaw);
    p = piv + rel;
    n = rotY3(rotX3(n, tailOrTonguePitch), grazeOrTongueYaw);
  } else if (part >= 6.5) {
    // Spoked wooden wheel (part == 7), turned around its front or rear axle by the distance rolled.
    let midAxleZ = 0.5 * (rig.legs.y + rig.legs.z);
    let front = p.z > midAxleZ;
    let r = max(0.2, select(rig.legs.x, rig.neck.x, front));
    let az = select(rig.legs.z, rig.legs.y, front);
    let piv = vec3f(p.x, r, az);
    let turn = walkPhase / r;
    p = piv + rotX3(p - piv, turn);
    n = rotX3(n, turn);
  } else if (!isVehicle && part >= 5.5) {
    // Gentle fly-whisking tail sway.
    let sway = 0.18 * sin(tailOrTonguePitch * 2.1);
    let piv = vec3f(0.0, rig.legs.x * 1.15, rig.legs.z - 0.18);
    let d = p - piv;
    let c = cos(sway);
    let s = sin(sway);
    p = piv + vec3f(d.x * c - d.y * s, d.x * s + d.y * c, d.z);
  }

  // Subtle breathing & gait bounce on torso/head, or gentle road-rut jounce on vehicle springs/bed.
  let bob = select(0.014 * abs(sin(walkPhase)), 0.005 * abs(sin(walkPhase * 2.7)), isVehicle) * walkAmp;
  p = p * body.slopeScale.y + vec3f(0.0, bob * body.slopeScale.y, 0.0);

  // Align to terrain/axle slope along facing direction, then turn to world yaw.
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
  boardDay: f32,
  daysPerSecond: f32,
};
struct HerdSeed {
  anchor: vec4f, // pasture: (anchorX, anchorZ, roamRadius, phase); caravan: (routeHeader, behindAnchor, roamSentinel, phase)
  traits: vec4f, // coatSeed, scale, species, flockHeading_or_lateralOffset
};
struct HerdBody {
  posYaw: vec4f,
  animCoat: vec4f,
  slopeScale: vec4f,
};

const CARAVAN_YOKE_AHEAD_M: f32 = 4.05;
const HERD_SPLAT_LO_PX: f32 = 3.5;
const HERD_SPLAT_HI_PX: f32 = 5.4;
const HERD_MIN_PX: f32 = 1.0;

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
  let seed = seeds[idx];
  let species = min(${HERD_SPECIES - 1}u, u32(round(seed.traits.z)));
  let isVehicle = species >= 4u;
  let roamR = seed.anchor.z;
  let phase = seed.anchor.w;
  let flockHeading = seed.traits.w;
  let t = F.camPos.w;
  let travelling = roamR < 0.0;
  let isDraftBeast = travelling && !isVehicle && seed.traits.x < 1.0;
  let isHitch = travelling && (isVehicle || isDraftBeast);

  var tau = 0.0;
  var moveAmt = 0.0;
  var worldXZ = seed.anchor.xy;
  var walkYaw = flockHeading;
  var rolled = 0.0;
  var anchorRolled = 0.0;
  var routeDeckY = 0.0;
  var routeHeader = 0u;
  var yokeSample = HerdRouteSample(vec2f(0.0), vec2f(0.0, 1.0), 0.0);
  var hitchMidXZ = vec2f(0.0);

  if (travelling) {
    routeHeader = u32(seed.anchor.x);
    let head = routes[routeHeader];
    let days = max(head.y - head.x, 1e-3);
    let share = clamp((cfg.boardDay - head.x) / days, 0.0, 1.0);
    let phaseOffset = clamp(-roamR - 1.0, 0.0, 0.9999);
    let phaseShare = fract(share + phaseOffset);
    let calSpeed = head.w / days * cfg.daysPerSecond;
    // In 1x real-time play calendar motion is ~6 mm/s; give active trains a 0.92 m/s visual pace driven by t
    // that yields cleanly back to exact calendar speed once Chart Course time-warp reaches walking speed.
    let paceFloor = max(0.0, 0.92 - calSpeed);
    let cycle = max(head.w + 48.0, 1.0);
    let rawDist = fract(share + phaseOffset) * head.w + paceFloor * t;
    let wrappedDist = rawDist - cycle * floor(rawDist / cycle);
    let headDist = select(phaseShare * head.w, wrappedDist, calSpeed < 0.92 && head.w > 1.0);

    let wander = select(0.0, 1.0, !isHitch);
    let behind = seed.anchor.y + wander * 0.9 * sin(t * 0.11 + phase * 3.0);
    anchorRolled = headDist - behind;
    let yokeRolled = anchorRolled + CARAVAN_YOKE_AHEAD_M;
    rolled = select(anchorRolled, yokeRolled, isDraftBeast);

    let atVeh = herdRouteAt(routeHeader, anchorRolled);
    yokeSample = herdRouteAt(routeHeader, yokeRolled);
    var at = atVeh;
    if (isDraftBeast) { at = yokeSample; }
    routeDeckY = at.deckY;
    hitchMidXZ = 0.5 * (atVeh.pos + yokeSample.pos);

    let lateral = seed.traits.w + wander * 1.1 * sin(t * 0.13 + phase * 7.0);
    worldXZ = at.pos + vec2f(at.dir.y, -at.dir.x) * lateral;
    walkYaw = atan2(at.dir.x, at.dir.y) + wander * 0.25 * sin(t * 0.21 + phase * 5.0);

    // Atomic hitch culling: vehicle + both paired draft beasts appear/disappear together on dry road/bridges.
    let vehSurfY = herdSurfaceY(atVeh.pos, atVeh.deckY);
    let yokeSurfY = herdSurfaceY(yokeSample.pos, yokeSample.deckY);
    let hitchDry = (vehSurfY >= 0.32 || atVeh.deckY > 0.25) && (yokeSurfY >= 0.32 || yokeSample.deckY > 0.25);
    let hitchSpanOk = anchorRolled > 0.5 && yokeRolled < head.w - 0.5 && hitchDry;
    let singleSpanOk = rolled > 0.0 && rolled < head.w;
    let onRoad = cfg.boardDay >= head.x && cfg.boardDay <= head.y + 0.05 && select(singleSpanOk, hitchSpanOk, isHitch);
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
  var baseRadius = 0.75;
  if (species == 1u) { baseRadius = 1.35; }
  else if (species == 2u) { baseRadius = 0.68; }
  else if (species == 3u) { baseRadius = 1.45; }
  else if (species == 4u) { baseRadius = 2.15; }
  else if (species == 5u) { baseRadius = 2.25; }
  else if (species == 6u) { baseRadius = 1.95; }
  let bodyRadius = baseRadius * scale;

  let cullXZ = select(worldXZ, hitchMidXZ, isHitch);
  let center = vec3f(worldXZ.x + shiftXZ.x, wy + bodyRadius * 0.62, worldXZ.y + shiftXZ.y);
  let cullCenter = vec3f(cullXZ.x + shiftXZ.x, wy + bodyRadius * 0.62, cullXZ.y + shiftXZ.y);
  let curved = earthCurve(center - F.camPos.xyz, F.camPos.y);
  let cullCurved = earthCurve(cullCenter - F.camPos.xyz, F.camPos.y);
  let dist = length(cullCurved);
  if (dist > 4200.0) { return; }

  let clip = F.viewProj * vec4f(cullCurved, 1.0);
  let frustumPad = select(1.18, 1.28, isHitch);
  if (clip.w <= 0.05 || abs(clip.x) > clip.w * frustumPad || abs(clip.y) > clip.w * frustumPad) { return; }

  // Rule-3 screen-space projected span in pixels (pxSpan).
  let pxWorld = max(dist * 2.0 * length(F.camUp.xyz) / max(F.screen.y, 1.0), 1e-5);
  let pxSpan = (2.0 * bodyRadius) / pxWorld;
  if (pxSpan < 0.16) { return; }

  // Sub-pixel stochastic hash thinning below 1.0 px with area-preserving radius inflation.
  var inflate = 1.0;
  if (pxSpan < HERD_MIN_PX) {
    let keepProb = clamp(pxSpan * pxSpan, 0.025, 1.0);
    let thinKey = select(f32(idx), floor(seed.anchor.x * 131.0 + seed.anchor.y * 17.0), isHitch);
    let hThin = fract(sin(thinKey * 12.9898 + phase * 78.233) * 43758.5453);
    if (hThin > keepProb) { return; }
    inflate = min(6.0, inverseSqrt(keepProb));
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
    if (length(chord) > 0.15) {
      walkYaw = atan2(chord.x, chord.y);
    }
    let hFront = herdSurfaceY(atF.pos, atF.deckY);
    let hBack = herdSurfaceY(atB.pos, atB.deckY);
    slopePitch = clamp(-atan2(hFront - hBack, max(0.8, zFront - zBack)), -0.42, 0.42);

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
  } else {
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
  let grazeAmt = select((1.0 - smoothstep(0.05, 0.45, moveAmt)) * wantGraze, 0.0, isHitch || isVehicle);
  let walkFreq = select(select(4.6, 3.1, species == 1u), select(5.2, 3.3, species == 3u), species >= 2u);
  let roadPhase = select(rolled * 6.2831853 / 1.6 + phase * 6.2831853, rolled, isVehicle);
  let walkPhase = select(tau * walkFreq + phase * 6.2831853, roadPhase, travelling);
  let tailPhase = t * (1.2 + 0.35 * fract(phase * 7.13)) + phase * 9.1;

  let meshKeep = select(1.0, smoothstep(HERD_SPLAT_LO_PX, HERD_SPLAT_HI_PX, pxSpan), pxSpan < HERD_SPLAT_HI_PX);

  // 1. Near/mid physical 3D mesh bucket (full coverage above 5.4 px, MSAA crossfade over 3.5..5.4 px).
  if (pxSpan >= HERD_SPLAT_LO_PX) {
    let packedSpecies = f32(species) + clamp(meshKeep, 0.0, 1.0) * 0.95;
    let body = HerdBody(
      vec4f(worldXZ.x, wy, worldXZ.y, walkYaw),
      vec4f(walkPhase, moveAmt, select(grazeAmt, tongueYaw, isVehicle), seed.traits.x),
      vec4f(slopePitch, scale, select(tailPhase, tonguePitch, isVehicle), packedSpecies),
    );
    let slot = atomicAdd(&draws[species * 5u + 1u], 1u);
    if (slot < cfg.bucketSpan) {
      bodies[species * cfg.bucketSpan + slot] = body;
    }

    if (landSH.origin.w > 0.5 && dist < 420.0 && meshKeep >= 0.45) {
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

  // 2. Far continuum 1-triangle view-facing horizon splat bucket (crossfades in over 5.4..3.5 px, sole representation < 3.5 px).
  if (pxSpan < HERD_SPLAT_HI_PX) {
    let toCamXZ = F.camPos.xz - (worldXZ + shiftXZ);
    let viewAz = select(0.0, atan2(toCamXZ.x, toCamXZ.y), dot(toCamXZ, toCamXZ) > 1e-8);
    let broadside = abs(sin(viewAz - walkYaw));
    var halfLen = bodyRadius * 0.85;
    var halfWid = bodyRadius * 0.42;
    var halfHgt = bodyRadius * 0.62;
    if (isVehicle) {
      halfLen = bodyRadius * 0.82;
      halfWid = bodyRadius * 0.44;
      halfHgt = bodyRadius * select(0.48, 0.54, species == 5u);
    }
    let rx = mix(halfWid, halfLen, broadside) * inflate;
    let ry = halfHgt * inflate;
    let centerY = halfHgt * 0.92;
    let splatBody = HerdBody(
      vec4f(worldXZ.x, wy, worldXZ.y, walkYaw),
      vec4f(rx, ry, meshKeep, seed.traits.x),
      vec4f(centerY, scale, f32(idx & 1023u), f32(species)),
    );
    let splatBucket = ${HERD_SPLAT_BUCKET}u;
    let splatSlot = atomicAdd(&draws[splatBucket * 5u + 1u], 1u);
    if (splatSlot < cfg.bucketSpan) {
      bodies[splatBucket * cfg.bucketSpan + splatSlot] = splatBody;
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
  @location(4) lodInfo: vec2f,  // meshKeep (0..1), instHash
};

struct HerdSplatOut {
  @builtin(position) pos: vec4f,
  @location(0) world: vec3f,
  @location(1) uv: vec2f,
  @location(2) coatInfo: vec4f, // meshKeep, coatSeed, species, instHash
  @location(3) basisUp: vec3f,
};

struct HerdFragOut {
  @location(0) color: vec4f,
  @builtin(sample_mask) mask: u32,
};

fn herdShadowVis(world: vec3f, normal: vec3f) -> f32 {
  if (landSH.origin.w < 0.5) { return 1.0; }
  let p = landSH.lightView * vec4f(world - landSH.origin.xyz + normal * 0.03 + landSH.sun.xyz * 0.025, 1.0);
  let uv = p.xy * vec2f(0.5, -0.5) + 0.5;
  let edge = min(min(uv.x, 1.0 - uv.x), min(uv.y, 1.0 - uv.y));
  let fade = smoothstep(0.0, 0.06, edge) * step(0.0, p.z) * step(p.z, 1.0);
  let refZ = min(p.z - 0.08 / max(landSH.sun.w, 1.0), 0.99999);
  let s = textureSampleCompareLevel(landSolidShadow, landShadowCompare, clamp(uv, vec2f(0.0), vec2f(1.0)), refZ);
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
  // Horse (3): rich bay, chestnut, dark seal-brown, and occasional warm Lusitano dapple-grey.
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

fn shadeHerdSurface(world: vec3f, n: vec3f, albedo: vec3f, ao: f32, species: u32) -> vec3f {
  let shadow = herdShadowVis(world, n) * herdCloudShadow(world);
  let sunVis = solarShadowVisibility(vec3f(shadow));
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
  let isCoach = species == 5u;
  let rough = select(select(0.56, 0.38, isCoach), 0.92, species == 0u);
  let specPow = select(select(18.0, 34.0, isCoach), 4.0, species == 0u);
  let sheenAmt = select(select(0.055, 0.095, isCoach), 0.012, species == 0u);
  let sheen = pow(max(dot(n, h), 0.0), specPow) * sheenAmt * nDotL;

  var col = albedo * (direct / PI + ambient) + sunIlluminance() * sunVis * sheen;
  col += lunarSurface(n, v, albedo, rough, vec3f(0.035), lunarShadowVisibility(vec3f(shadow)));
  return surfaceAir(col, world);
}

@vertex fn herdsVS(
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) partZone: vec2f,
  @builtin(instance_index) inst: u32,
) -> HerdVertexOut {
  let body = herdBodies[inst];
  let spFloor = floor(body.slopeScale.w + 1e-4);
  let meshKeep = clamp((body.slopeScale.w - spFloor) / 0.95, 0.0, 1.0);
  let posed = poseLivestockVertex(position, normal, partZone.x, body, herdRig);
  let shifted = posed.localPos + vec3f(nearTerrain.grid.y, 0.0, nearTerrain.grid.z);
  let zone = floor(partZone.y + 0.001);
  let ao = clamp(partZone.y - zone, 0.08, 0.98);
  var o: HerdVertexOut;
  o.world = shifted;
  o.normal = posed.localNrm;
  o.coatInfo = vec4f(zone, ao, body.animCoat.w, spFloor);
  o.localXZ = vec2f(position.z, position.y);
  o.lodInfo = vec2f(meshKeep, f32(inst & 255u));
  o.pos = F.viewProj * vec4f(earthCurve(shifted - F.camPos.xyz, F.camPos.y), 1.0);
  return o;
}

@fragment fn herdsFS(in: HerdVertexOut) -> HerdFragOut {
  let pix = vec2u(in.pos.xy);
  let mask = herdOrderedMask(u32(in.lodInfo.y), pix, in.lodInfo.x, false);
  let n = normalize(in.normal);
  let species = min(${HERD_SPECIES - 1}u, u32(round(in.coatInfo.w)));
  let zone = u32(round(in.coatInfo.x));
  let ao = in.coatInfo.y;
  let albedo = livestockCoatAlbedo(species, zone, in.coatInfo.z, in.localXZ);
  let col = shadeHerdSurface(in.world, n, albedo, ao, species);
  return HerdFragOut(vec4f(col, 1.0), mask);
}

// Rule-3 1-triangle view-facing horizon splat (3 vertices per instance, circumscribed around the integrated silhouette ellipse).
@vertex fn herdsSplatVS(
  @builtin(vertex_index) vid: u32,
  @builtin(instance_index) inst: u32,
) -> HerdSplatOut {
  let b = herdBodies[inst];
  let worldBase = vec3f(b.posYaw.x + nearTerrain.grid.y, b.posYaw.y + b.slopeScale.x, b.posYaw.z + nearTerrain.grid.z);
  let curvedCenter = earthCurve(worldBase - F.camPos.xyz, F.camPos.y);
  let toCamRaw = -curvedCenter;
  let toCam = select(vec3f(0.0, 0.0, 1.0), normalize(toCamRaw), length(toCamRaw) > 1e-5);
  let camR0 = select(vec3f(1.0, 0.0, 0.0), normalize(F.camRight.xyz), length(F.camRight.xyz) > 1e-5);
  let zenithUp = select(vec3f(0.0, 1.0, 0.0), vec3f(0.0, 0.0, 1.0), abs(toCam.y) > 0.999);
  let camR = select(camR0, normalize(cross(zenithUp, toCam)), abs(dot(camR0, toCam)) > 0.995 || abs(toCam.y) > 0.999);
  let camU = normalize(cross(camR, toCam));

  // Single equilateral triangle circumscribing unit circle r = 1: (0, 2), (-sqrt(3), -1), (+sqrt(3), -1).
  var triUV = vec2f(0.0, 2.0);
  if (vid == 1u) { triUV = vec2f(-1.7320508, -1.0); }
  else if (vid == 2u) { triUV = vec2f(1.7320508, -1.0); }

  let rx = b.animCoat.x;
  let ry = b.animCoat.y;
  let offset = camR * (triUV.x * rx) + camU * (triUV.y * ry);
  var o: HerdSplatOut;
  o.world = worldBase + offset;
  o.uv = triUV;
  o.coatInfo = vec4f(b.animCoat.z, b.animCoat.w, b.slopeScale.w, b.slopeScale.z);
  o.basisUp = camU;
  o.pos = F.viewProj * vec4f(curvedCenter + offset, 1.0);
  return o;
}

@fragment fn herdsSplatFS(in: HerdSplatOut) -> HerdFragOut {
  let r2 = dot(in.uv, in.uv);
  let pix = vec2u(in.pos.xy);
  let crossMask = herdOrderedMask(u32(in.coatInfo.w), pix, in.coatInfo.x, true);
  let insideEllipse = r2 <= 1.0;
  let mask = select(0u, crossMask, insideEllipse);

  let species = min(${HERD_SPECIES - 1}u, u32(round(in.coatInfo.z)));
  let seed = in.coatInfo.y;
  // Upper half of vehicle splats carries tilt/coach-roof colour (zone = 2), lower half timber/wheel base (zone = 0).
  let isVeh = species >= 4u;
  let zone = select(0u, 2u, isVeh && in.uv.y > -0.05);
  let albedo = livestockCoatAlbedo(species, zone, seed, in.uv * 0.5);

  let toCam = normalize(F.camPos.xyz - in.world);
  let camR = normalize(F.camRight.xyz);
  let camU = normalize(in.basisUp);
  let nz = sqrt(max(0.08, 1.0 - min(0.92, r2 * 0.85)));
  let n = normalize(camR * (in.uv.x * 0.55) + camU * (in.uv.y * 0.65) + toCam * nz);
  let ao = clamp(0.56 + 0.34 * in.uv.y, 0.25, 0.95);
  let col = shadeHerdSurface(in.world, n, albedo, ao, species);
  return HerdFragOut(vec4f(col, 1.0), mask);
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

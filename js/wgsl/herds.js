// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// 100% GPU compute + indirect instanced rendering for Old World grazing herds
// (sheep, cattle, swine, Lusitano horses + 1550 sela à gineta tack), mounted urban/road riders,
// and 16th-century road caravan vehicles:
//   species 4 = carreta (4-wheel covered wain),
//   species 5 = coche (4-wheel passenger/merchant coach),
//   species 6 = carro de bois (2-wheel heavy cargo ox-cart).
// Includes progressive half-edge collapse continuum (`herdMorph`), atomic coupled hitch culling &
// hitch destruction, ballistic vehicle shard flight, livestock felling & 38 m stampedes, and Rule-3
// continuous MSAA sample-mask crossfade into a 1-triangle horizon splat + sub-pixel hash thinning.
import { FRAME_WGSL, ATMO_CORE_WGSL, SIM_CLOCK_LOOP_S } from './common.js';
import { SKY_RENDER_FUNCS } from './sky.js';
import { CLOUD_SAMPLE } from './clouds.js';
import { SHADOW_FRAME } from './shadows.js';
import { ROUTE_STEP_M } from '../town-streets.js';

export const HERD_SEED_FLOATS = 8;
export const HERD_BODY_FLOATS = 16;
export const HERD_FATE_FLOATS = 8;
export const HERD_SHOT_LIMIT = 8;
export const HERD_SHOT_FLOATS = 8;
export const HERD_SHOTS_WORDS = 4 + HERD_SHOT_LIMIT * HERD_SHOT_FLOATS;
export const HERD_DRAW_WORDS = 5;
export const HERD_SPECIES = 7;
export const HERD_SPLAT_BUCKET = HERD_SPECIES * 2; // 14: 1-triangle far horizon splat bucket
export const HERD_BUCKETS = HERD_SPECIES * 2 + 1;  // 0..6 main meshes, 7..13 shadow meshes, 14 horizon splats
export const HERD_ROUTE_HEADER = 1;
export const HERD_MORPH_HI_PX = 26.0;
export const HERD_STAMPEDE_RADIUS_M = 38.0;

const HERD_RIG_FN = /* wgsl */ `
struct HerdBody {
  posYaw: vec4f,     // worldX (unshifted), groundY, worldZ (unshifted), yaw
  animCoat: vec4f,   // walkPhase, walkAmp, grazeAmt_or_tongueYaw, coatSeed
  slopeScale: vec4f, // slopePitch, scale, tailPhase_or_tonguePitch, speciesPlusFade
  extra: vec4f,      // morphLevel (0..1), flags (1=tack, 2=felled, 4=shattered, 8=halted), hitAge, hitDirAngle
};

struct HerdSpeciesRig {
  neck: vec4f, // livestock: (pivotX, pivotY, pivotZ, maxGrazePitch); vehicles: (frontWheelR, tonguePivY, tonguePivZ, 0)
  legs: vec4f, // livestock: (legY, frontZ, backZ, height); vehicles: (rearWheelR, frontAxleZ, rearAxleZ, height)
};

struct HerdPosed {
  localPos: vec3f,
  localNrm: vec3f,
};

struct HerdMorphed {
  pos: vec3f,
  nrm: vec3f,
  part: f32,
  shardId: u32,
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

fn rotZ3(v: vec3f, a: f32) -> vec3f {
  let c = cos(a);
  let s = sin(a);
  return vec3f(v.x * c - v.y * s, v.x * s + v.y * c, v.z);
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

fn poseLivestockVertex(pos: vec3f, nrm: vec3f, part: f32, shardId: u32, body: HerdBody, rig: HerdSpeciesRig) -> HerdPosed {
  var p = pos;
  var n = nrm;
  let walkPhase = body.animCoat.x;
  let walkAmp = body.animCoat.y;
  let grazeOrTongueYaw = body.animCoat.z;
  let tailOrTonguePitch = body.slopeScale.z;
  let isVehicle = body.slopeScale.w >= 3.99;
  let flags = u32(body.extra.y + 0.5);
  let hasTack = (flags & 1u) != 0u;
  let isFelled = (flags & 2u) != 0u;
  let isShattered = (flags & 4u) != 0u;
  let hitAge = max(0.0, body.extra.z);
  let localHitAngle = body.extra.w - body.posYaw.w;

  // Shattered 1550 road vehicle (carreta, coche, carro de bois): deterministic per-piece rigid ballistic flight.
  if (isVehicle && isShattered) {
    let sF = f32(shardId);
    let h0 = fract(sin(sF * 12.9898 + body.animCoat.w * 78.233) * 43758.5453);
    let h1 = fract(sin(sF * 39.3467 + body.animCoat.w * 19.19) * 24634.6345);
    var piv = vec3f(0.0, 0.95, 0.0);
    if (part >= 7.5) {
      piv = vec3f(0.0, rig.neck.y + 0.24, 2.75);
    } else if (part >= 6.5) {
      let sideS = select(-0.86, 0.86, (shardId & 1u) != 0u);
      let frontS = (shardId & 2u) != 0u;
      let rW = max(0.2, select(rig.legs.x, rig.neck.x, frontS));
      let zW = select(rig.legs.z, rig.legs.y, frontS);
      piv = vec3f(sideS, rW, zW);
    } else {
      let qx = select(-0.44, 0.44, (shardId & 1u) != 0u);
      let qz = select(-0.68, 0.68, (shardId & 2u) != 0u);
      let qy = select(0.92, 1.46, (shardId & 4u) != 0u);
      piv = vec3f(qx, qy, qz);
    }
    let hitDirL = vec2f(sin(localHitAngle), cos(localHitAngle));
    let radDirL = select(vec2f(h0 - 0.5, h1 - 0.5), normalize(piv.xz), length(piv.xz) > 0.08);
    let horizDir = normalize(radDirL * 0.72 + hitDirL * 0.68 + vec2f(1e-4, 0.0));
    let isWheelShard = part >= 6.5 && part < 7.5;
    let horizSpeed = (2.7 + 3.9 * h0) * select(1.0, 1.25, isWheelShard);
    let vy0 = 2.9 + 3.3 * h1;
    let g = 9.81;
    let restY = select(0.14, 0.08, part >= 6.5);
    let dropH = max(0.05, piv.y - restY);
    let tImpact = (vy0 + sqrt(vy0 * vy0 + 2.0 * g * dropH)) / g;
    let flyT = min(hitAge, tImpact);
    let groundT = max(0.0, hitAge - tImpact);
    let bounceSpan = 0.34;
    let slideT = select(0.0, (1.0 - exp(-groundT * 4.5)) * 0.18, groundT > 0.0);
    let dispXZ = horizDir * horizSpeed * (flyT + slideT);
    var dy = vy0 * flyT - 0.5 * g * flyT * flyT;
    if (hitAge >= tImpact) {
      let bY = select(0.0, sin((groundT / bounceSpan) * 3.14159265) * 0.22 * (0.5 + 0.5 * h1), groundT < bounceSpan);
      dy = -dropH + bY;
    }
    let spinT = flyT + slideT * 0.5;
    let endTiltZ = select(-1.46, 1.46, piv.x >= 0.0);
    let spinX = (2.4 + 3.5 * h0) * spinT * select(1.0, -1.0, h1 < 0.5);
    let spinZ = mix((1.8 + 2.8 * h1) * spinT, endTiltZ, smoothstep(tImpact * 0.7, tImpact + 0.25, hitAge));
    let relS = rotZ3(rotX3(p - piv, spinX), spinZ);
    var nrmS = rotZ3(rotX3(n, spinX), spinZ);
    p = (piv + relS + vec3f(dispXZ.x, dy, dispXZ.y)) * body.slopeScale.y;
    p.y = max(0.02, p.y);
    p = rotX3(p, body.slopeScale.x);
    nrmS = rotX3(nrmS, body.slopeScale.x);
    p = rotY3(p, body.posYaw.w);
    nrmS = normalize(rotY3(nrmS, body.posYaw.w));
    return HerdPosed(p + body.posYaw.xyz, nrmS);
  }

  if (!isVehicle && part >= 8.5) {
    // 1550 Iberian sela à gineta saddle & alforjas (part == 9) + headstall bridle, curb bit & reins (part in [10, 11)).
    if (!hasTack) {
      p = vec3f(0.0, rig.legs.x, 0.0);
    } else if (part >= 9.95 && part < 11.0) {
      let w = clamp(part - 10.0, 0.0, 1.0);
      let nibble = 0.055 * sin(tailOrTonguePitch * 3.4) * max(0.0, grazeOrTongueYaw);
      let pitch = select(grazeOrTongueYaw * rig.neck.w + nibble, 0.26, isFelled) * w;
      let yawTurn = select(0.14 * sin(tailOrTonguePitch * 0.73) * grazeOrTongueYaw * w, 0.0, isFelled);
      let piv = rig.neck.xyz;
      var rel = rotX3(p - piv, pitch);
      rel = rotY3(rel, yawTurn);
      p = piv + rel;
      n = rotY3(rotX3(n, pitch), yawTurn);
    }
  } else if (!isVehicle && part >= 1.0 && part < 1.995) {
    // Smoothly weighted neck & head pitch around chest/withers pivot while cropping grass (or lifted in alarm).
    let w = clamp(part - 1.0, 0.0, 1.0);
    let nibble = 0.055 * sin(tailOrTonguePitch * 3.4) * max(0.0, grazeOrTongueYaw);
    let pitch = select(grazeOrTongueYaw * rig.neck.w + nibble, 0.26, isFelled) * w;
    let yawTurn = select(0.14 * sin(tailOrTonguePitch * 0.73) * grazeOrTongueYaw * w, 0.0, isFelled);
    let piv = rig.neck.xyz;
    var rel = rotX3(p - piv, pitch);
    rel = rotY3(rel, yawTurn);
    p = piv + rel;
    n = rotY3(rotX3(n, pitch), yawTurn);
  } else if (!isVehicle && part >= 1.995 && part < 5.5) {
    // 4-beat lateral walk/gallop, or inward leg fold when felled by gunfire.
    let legIdx = i32(round(part));
    var beat = 0.0;
    var pivZ = rig.legs.y;
    if (legIdx == 3) { beat = 3.14159265; pivZ = rig.legs.y; }
    else if (legIdx == 4) { beat = 4.71238898; pivZ = rig.legs.z; }
    else if (legIdx == 5) { beat = 1.57079633; pivZ = rig.legs.z; }
    let piv = vec3f(p.x, rig.legs.x, pivZ);
    if (isFelled) {
      let fallT = smoothstep(0.0, 0.38, hitAge);
      let foldAng = select(-0.72, 0.72, legIdx <= 3) * fallT;
      var relL = rotX3(p - piv, foldAng);
      relL.y = relL.y * (1.0 - 0.42 * fallT);
      p = piv + relL;
      n = rotX3(n, foldAng);
    } else {
      let ph = walkPhase + beat;
      let swing = sin(ph) * 0.36 * walkAmp;
      let lift = max(0.0, cos(ph)) * 0.045 * walkAmp * clamp(1.0 - p.y / max(0.2, rig.legs.x), 0.0, 1.0);
      p = piv + rotX3(p - piv, swing) + vec3f(0.0, lift, 0.0);
      n = rotX3(n, swing);
    }
  } else if (isVehicle && part >= 7.5) {
    // Articulated draft pole + yoke / horse harness (part == 8): turns & pitches cleanly toward the draft team (or roadbed if halted).
    let piv = vec3f(0.0, rig.neck.y, rig.neck.z);
    var rel = rotX3(p - piv, tailOrTonguePitch);
    rel = rotY3(rel, grazeOrTongueYaw);
    p = piv + rel;
    n = rotY3(rotX3(n, tailOrTonguePitch), grazeOrTongueYaw);
  } else if (isVehicle && part >= 6.5) {
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
    // Gentle fly-whisking tail sway while standing or walking.
    let sway = select(0.18 * sin(tailOrTonguePitch * 2.1), 0.0, isFelled);
    let piv = vec3f(0.0, rig.legs.x * 1.15, rig.legs.z - 0.18);
    let d = p - piv;
    let c = cos(sway);
    let s = sin(sway);
    p = piv + vec3f(d.x * c - d.y * s, d.x * s + d.y * c, d.z);
  }

  // Felled livestock roll 90 degrees onto their flank resting physically on groundY.
  if (!isVehicle && isFelled) {
    let fallT = smoothstep(0.0, 0.38, hitAge);
    let rollSign = select(-1.0, 1.0, sin(localHitAngle) >= 0.0);
    let rollAng = rollSign * 1.5707963 * fallT;
    let barrelY = rig.legs.x * 1.05;
    let flankHalfW = 0.28 * rig.legs.x + 0.08;
    let hopY = select(0.0, sin((hitAge / 0.36) * 3.14159265) * 0.16, hitAge < 0.36);
    p = vec3f(0.0, barrelY, 0.0) + rotZ3(p - vec3f(0.0, barrelY, 0.0), rollAng);
    p.y = p.y - (barrelY - flankHalfW) * fallT + hopY;
    n = rotZ3(n, rollAng);
  }

  // Subtle breathing & gait bounce on torso/head, or gentle road-rut jounce on vehicle springs/bed.
  let bob = select(0.014 * abs(sin(walkPhase)), 0.005 * abs(sin(walkPhase * 2.7)), isVehicle) * walkAmp * select(1.0, 0.0, isFelled);
  p = p * body.slopeScale.y + vec3f(0.0, bob * body.slopeScale.y, 0.0);

  // Align to terrain/axle slope along facing direction, then turn to world yaw.
  p = rotX3(p, body.slopeScale.x);
  n = rotX3(n, body.slopeScale.x);
  p = rotY3(p, body.posYaw.w);
  n = normalize(rotY3(n, body.posYaw.w));
  return HerdPosed(p + body.posYaw.xyz, n);
}
`;

const HERD_MORPH_EVAL_FN = /* wgsl */ `
fn morphLivestockVertex(vid: u32, pos: vec3f, nrm: vec3f, part: f32, morphLevel: f32) -> HerdMorphed {
  let baseMeta = bitcast<u32>(herdMorph[vid * 2u + 1u].w);
  let shardId = (baseMeta >> 24u) & 255u;
  var mPos = pos;
  var mNrm = nrm;
  var mPart = part;
  if (morphLevel > 0.001) {
    var cur = vid;
    for (var step = 0u; step < 9u; step = step + 1u) {
      let m0 = herdMorph[cur * 2u];
      let m1 = herdMorph[cur * 2u + 1u];
      let pIdx = u32(m0.w + 0.5);
      if (pIdx == cur || morphLevel <= m1.x) { break; }
      let t = clamp((morphLevel - m1.x) / max(m1.y, 1e-4), 0.0, 1.0);
      mPos = mix(mPos, m0.xyz, t);
      let pk = bitcast<u32>(m1.w) & 0x00ffffffu;
      let pNrm = unpack4x8snorm(pk).xyz;
      if (dot(pNrm, pNrm) > 1e-4) {
        mNrm = normalize(mix(mNrm, pNrm, t));
      }
      if (t >= 0.999) {
        mPart = m1.z;
        cur = pIdx;
      } else {
        break;
      }
    }
  }
  return HerdMorphed(mPos, mNrm, mPart, shardId);
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
  traits: vec4f, // coatSeed (+10 when saddled), scale, species, flockHeading_or_lateralOffset
};
struct HerdBody {
  posYaw: vec4f,
  animCoat: vec4f,
  slopeScale: vec4f,
  extra: vec4f,
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
const HERD_SPLAT_LO_PX: f32 = 3.5;
const HERD_SPLAT_HI_PX: f32 = 5.4;
const HERD_MORPH_HI_PX: f32 = ${HERD_MORPH_HI_PX.toFixed(1)};
const HERD_MIN_PX: f32 = 1.0;
const HERD_STAMPEDE_M: f32 = ${HERD_STAMPEDE_RADIUS_M.toFixed(1)};
const HERD_STAMPEDE_SPAN_S: f32 = 14.0;

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
@group(0) @binding(10) var<uniform> shots: HerdShots;
@group(0) @binding(11) var<storage, read_write> fates: array<HerdFate>;

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
  var hitchMidXZ = vec2f(0.0);
  var wayGroundY = -1000.0;
  var isPanicking = false;

  if (isStreetMount) {
    // Urban street mount coupled 1:1 with TOWNSFOLK_WALK wayAt(w, metres, lane).
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

    if (fate.status.x < 1.5) {
      if (abroad > 0.1 + 0.9 * smoothstep(-0.1, 0.14, F.sunDir.y)) { return; }
      let walking = lengthM / speed;
      let leg = walking + pauseFor + indoors;
      let turn = fract(t / (2.0 * leg) + phase) * 2.0 * leg;
      let back = turn >= leg;
      let inLeg = turn - select(0.0, leg, back);
      let arrived = inLeg >= walking + pauseFor;
      if (arrived && ((wFlags >> select(2u, 1u, back)) & 1u) == 0u) { return; }
      let stopAt = walking * pauseAt;
      let stopped = arrived || (pauseFor > 0.0 && inLeg >= stopAt && inLeg < stopAt + pauseFor);
      let walked = min(lengthM, (min(inLeg, stopAt) + max(0.0, inLeg - stopAt - pauseFor)) * speed);
      let metres = select(walked, lengthM - walked, back);
      let going = select(1.0, -1.0, back);
      let along = metres / ${ROUTE_STEP_M.toFixed(4)};
      let si = min(u32(max(along, 0.0)), max(sampleCount, 2u) - 2u);
      let s0 = routes[routeHeader + 2u + si];
      let s1 = routes[routeHeader + 2u + si + 1u];
      let here = mix(s0, s1, clamp(along - f32(si), 0.0, 1.0));
      let aheadIdx = min(si + 3u, sampleCount - 1u);
      let behindIdx = u32(max(i32(si) - 2, 0));
      let ahead = routes[routeHeader + 2u + aheadIdx].xz - routes[routeHeader + 2u + behindIdx].xz;
      let forward = normalize(ahead + vec2f(1e-4, 0.0));
      let aside = vec2f(forward.y, -forward.x) * going * side * here.w;
      worldXZ = vec2f(here.x + aside.x, here.z + aside.y);
      wayGroundY = here.y;
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
    hitchMidXZ = 0.5 * (atVeh.pos + yokeSample.pos);

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
            hitchMidXZ = worldXZ;
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
            hitchMidXZ = worldXZ;
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
          hitchMidXZ = 0.5 * (haltedVeh.pos + yokeSample.pos);
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

  let shiftXZ = vec2f(nearTerrain.grid.y, nearTerrain.grid.z);
  let scale = seed.traits.y;

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

  var groundY = herdGroundY(worldXZ);
  if (isStreetMount && wayGroundY > -500.0) {
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

  var baseRadius = 0.75;
  if (species == 1u) { baseRadius = 1.35; }
  else if (species == 2u) { baseRadius = 0.68; }
  else if (species == 3u) { baseRadius = 1.45; }
  else if (species == 4u) { baseRadius = 2.15; }
  else if (species == 5u) { baseRadius = 2.25; }
  else if (species == 6u) { baseRadius = 1.95; }
  let bodyRadius = baseRadius * scale;

  let useHitchMid = isHitch && (flags & 14u) == 0u && !isPanicking;
  let cullXZ = select(worldXZ, hitchMidXZ, useHitchMid);
  let center = vec3f(worldXZ.x + shiftXZ.x, wy + bodyRadius * 0.62, worldXZ.y + shiftXZ.y);
  let cullCenter = vec3f(cullXZ.x + shiftXZ.x, wy + bodyRadius * 0.62, cullXZ.y + shiftXZ.y);
  let curved = earthCurve(center - F.camPos.xyz, F.camPos.y);
  let cullCurved = earthCurve(cullCenter - F.camPos.xyz, F.camPos.y);
  let dist = length(cullCurved);
  if (dist > 4200.0) { return; }

  let clip = F.viewProj * vec4f(cullCurved, 1.0);
  let frustumPad = select(1.18, 1.32, isHitch || (flags & 4u) != 0u);
  if (clip.w <= 0.05 || abs(clip.x) > clip.w * frustumPad || abs(clip.y) > clip.w * frustumPad) { return; }

  // Rule-3 screen-space projected span in pixels (pxSpan).
  let pxWorld = max(dist * 2.0 * length(F.camUp.xyz) / max(F.screen.y, 1.0), 1e-5);
  let pxSpan = (2.0 * bodyRadius) / pxWorld;
  if (pxSpan < 0.16) { return; }

  // Sub-pixel stochastic hash thinning below 1.0 px with area-preserving radius inflation.
  var inflate = 1.0;
  if (pxSpan < HERD_MIN_PX) {
    let keepProb = clamp(pxSpan * pxSpan, 0.025, 1.0);
    let thinKey = select(f32(idx), floor(seed.anchor.x * 131.0 + seed.anchor.y * 17.0), useHitchMid);
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

  // Continuous Rule-3 half-edge collapse continuum level (0 above 26 px -> 1 at 5.4 px).
  let morphLevel = select(clamp((HERD_MORPH_HI_PX - pxSpan) / (HERD_MORPH_HI_PX - HERD_SPLAT_HI_PX), 0.0, 1.0), 0.0, (flags & 4u) != 0u);
  let meshKeep = select(1.0, smoothstep(HERD_SPLAT_LO_PX, HERD_SPLAT_HI_PX, pxSpan), pxSpan < HERD_SPLAT_HI_PX);

  // 1. Near/mid physical 3D mesh bucket (full coverage above 5.4 px, MSAA crossfade over 3.5..5.4 px).
  if (pxSpan >= HERD_SPLAT_LO_PX) {
    let packedSpecies = f32(species) + clamp(meshKeep, 0.0, 1.0) * 0.95;
    let body = HerdBody(
      vec4f(worldXZ.x, wy, worldXZ.y, walkYaw),
      vec4f(walkPhase, moveAmt, select(grazeAmt, tongueYaw, isVehicle), coatSeed),
      vec4f(slopePitch, scale, select(tailPhase, tonguePitch, isVehicle), packedSpecies),
      vec4f(morphLevel, f32(flags), hitAge, hitDirAngle),
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
    if ((flags & 6u) != 0u) {
      halfHgt *= 0.48;
      halfWid *= 1.35;
    }
    let rx = mix(halfWid, halfLen, broadside) * inflate;
    let ry = halfHgt * inflate;
    let centerY = halfHgt * 0.92;
    let splatBody = HerdBody(
      vec4f(worldXZ.x, wy, worldXZ.y, walkYaw),
      vec4f(rx, ry, meshKeep, coatSeed),
      vec4f(centerY, scale, f32(idx & 1023u), f32(species)),
      vec4f(0.0, f32(flags), 0.0, 0.0),
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
@group(0) @binding(18) var<storage, read> herdMorph: array<vec4f>;
` + SHADOW_FRAME + SKY_RENDER_FUNCS + CLOUD_SAMPLE + HERD_RIG_FN + HERD_MORPH_EVAL_FN + /* wgsl */ `
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
  let isPolished = species == 5u || (species == 3u && (zone == 4u || zone == 5u));
  let isIron = species == 3u && zone == 5u;
  let rough = select(select(0.56, 0.34, isPolished), 0.92, species == 0u);
  let specPow = select(select(18.0, select(34.0, 56.0, isIron), isPolished), 4.0, species == 0u);
  let sheenAmt = select(select(0.055, select(0.105, 0.22, isIron), isPolished), 0.012, species == 0u);
  let sheen = pow(max(dot(n, h), 0.0), specPow) * sheenAmt * nDotL;

  var col = albedo * (direct / PI + ambient) + sunIlluminance() * sunVis * sheen;
  col += lunarSurface(n, v, albedo, rough, vec3f(0.035), lunarShadowVisibility(vec3f(shadow)));
  return surfaceAir(col, world);
}

@vertex fn herdsVS(
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) partZone: vec2f,
  @builtin(vertex_index) vid: u32,
  @builtin(instance_index) inst: u32,
) -> HerdVertexOut {
  let body = herdBodies[inst];
  let spFloor = floor(body.slopeScale.w + 1e-4);
  let meshKeep = clamp((body.slopeScale.w - spFloor) / 0.95, 0.0, 1.0);
  let morphed = morphLivestockVertex(vid, position, normal, partZone.x, body.extra.x);
  let posed = poseLivestockVertex(morphed.pos, morphed.nrm, morphed.part, morphed.shardId, body, herdRig);
  let shifted = posed.localPos + vec3f(nearTerrain.grid.y, 0.0, nearTerrain.grid.z);
  let zone = floor(partZone.y + 0.001);
  let ao = clamp(partZone.y - zone, 0.08, 0.98);
  var o: HerdVertexOut;
  o.world = shifted;
  o.normal = posed.localNrm;
  o.coatInfo = vec4f(zone, ao, body.animCoat.w, spFloor);
  o.localXZ = vec2f(morphed.pos.z, morphed.pos.y);
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
  let col = shadeHerdSurface(in.world, n, albedo, ao, species, zone);
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
  let splatFlags = u32(b.extra.y + 0.5);
  let packedSpecies = b.slopeScale.w + select(0.0, 10.0, (splatFlags & 1u) != 0u);
  o.coatInfo = vec4f(b.animCoat.z, b.animCoat.w, packedSpecies, b.slopeScale.z);
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

  let rawSp = in.coatInfo.z;
  let hasTack = rawSp >= 9.5;
  let species = min(${HERD_SPECIES - 1}u, u32(round(select(rawSp, rawSp - 10.0, hasTack))));
  let seed = in.coatInfo.y;
  // Upper half of vehicle splats carries tilt/coach-roof colour (zone = 2), saddled horse splat crest shows saddlecloth (zone = 6).
  let isVeh = species >= 4u;
  var zone = select(0u, 2u, isVeh && in.uv.y > -0.05);
  if (hasTack && in.uv.y > 0.15 && abs(in.uv.x) < 0.45) { zone = 6u; }
  let albedo = livestockCoatAlbedo(species, zone, seed, in.uv * 0.5);

  let toCam = normalize(F.camPos.xyz - in.world);
  let camR = normalize(F.camRight.xyz);
  let camU = normalize(in.basisUp);
  let nz = sqrt(max(0.08, 1.0 - min(0.92, r2 * 0.85)));
  let n = normalize(camR * (in.uv.x * 0.55) + camU * (in.uv.y * 0.65) + toCam * nz);
  let ao = clamp(0.56 + 0.34 * in.uv.y, 0.25, 0.95);
  let col = shadeHerdSurface(in.world, n, albedo, ao, species, zone);
  return HerdFragOut(vec4f(col, 1.0), mask);
}
`;

export const HERDS_SHADOW_WGSL = SHADOW_FRAME + HERD_RIG_FN + /* wgsl */ `
struct HerdNearDomain { domain: vec4f, grid: vec4f };
@group(0) @binding(0) var<uniform> landSH: ShadowFrame;
@group(0) @binding(1) var<uniform> nearTerrain: HerdNearDomain;
@group(0) @binding(2) var<storage, read> herdBodies: array<HerdBody>;
@group(0) @binding(3) var<uniform> herdRig: HerdSpeciesRig;
@group(0) @binding(4) var<storage, read> herdMorph: array<vec4f>;
` + HERD_MORPH_EVAL_FN + /* wgsl */ `

@vertex fn herdsShadowVS(
  @location(0) position: vec3f,
  @location(1) normal: vec3f,
  @location(2) partZone: vec2f,
  @builtin(vertex_index) vid: u32,
  @builtin(instance_index) inst: u32,
) -> @builtin(position) vec4f {
  let body = herdBodies[inst];
  let morphed = morphLivestockVertex(vid, position, normal, partZone.x, body.extra.x);
  let posed = poseLivestockVertex(morphed.pos, morphed.nrm, morphed.part, morphed.shardId, body, herdRig);
  let shifted = posed.localPos + vec3f(nearTerrain.grid.y, 0.0, nearTerrain.grid.z);
  return landSH.lightView * vec4f(shifted - landSH.origin.xyz, 1.0);
}
`;

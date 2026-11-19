// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// 2D GPU Shallow Water Equations (Saint-Venant) solver for river bridge piers, cutwaters,
// harbor pilings/breakwaters, coastal shoaling/diffraction, beach swash, and breaking-surf spawn detection.
// Runs directly on Layer 2 of the ping-pong surfaceWaveTex array (zero extra texture bindings in water shaders).

export const SHALLOW_WATER_LIMITS = Object.freeze({
  obstacles: 256,
  reaches: 256,
  hulls: 24,
  spraySpawns: 128,
  sprayParticles: 2048,
});

export const SHALLOW_WATER_TYPES = /* wgsl */ `
struct SweUniform {
  domain: vec4f,        // cx, cz, extent (256 m), dx (0.5 m)
  prevAndCounts: vec4f, // prevCx, prevCz, packedCounts (obs | reach<<10 | hull<<20), flags (bit0=clear, bit1=hasCoast, bit2=hasRiver, bit3=emitSpray)
  coastalWin: vec4f,    // coastalCenterX, coastalCenterZ, coastalHalfSpan, fieldSpanM
  forcing: vec4f,       // dt, time, swellDirX, swellDirZ
  seaParams: vec4f,     // swellHs, swellK0, swellOmega, windSpeed
};
struct SweObstacle {
  posDir: vec4f,        // cx, cz, ux, uz (unit orientation)
  dims: vec4f,          // halfLen (along u), halfWid (across u), kind (0=box, 1=cutwater pier, 2=cylinder), waterY
};
struct SweReach {
  seg: vec4f,           // ax, az, bx, bz
  hydro: vec4f,         // halfWidth, depth, flowU, flowV
  info: vec4f,          // waterY0, waterY1, estuaryT, pad
};
struct SweHull {
  posVel: vec4f,        // x, z, vx, vz
  dims: vec4f,          // length, beam, draft, signedDisp
};
struct SweSpraySpawn {
  posEnergy: vec4f,     // wx, wy, wz, energy
  velKind: vec4f,       // u, v, upSpeed, kind (0=pier/obstacle, 1=surf breaker)
};
`;

// Pass A: Rasterize static coastal DEM bathymetry + river reaches + bridge piers/cutwaters/piles + moving hulls
// into sweEnv (r = rest depth h0, g = ambient u0, b = ambient v0, a = solid obstacle mask in [0, 1]).
export const SHALLOW_WATER_ENV_WGSL = SHALLOW_WATER_TYPES + /* wgsl */ `
@group(0) @binding(0) var<uniform> sweU: SweUniform;
@group(0) @binding(1) var coastalShelter: texture_2d<f32>;
@group(0) @binding(2) var coastalSamp: sampler;
@group(0) @binding(3) var<storage, read> sweObstacles: array<SweObstacle>;
@group(0) @binding(4) var<storage, read> sweReaches: array<SweReach>;
@group(0) @binding(5) var<storage, read> sweHulls: array<SweHull>;
@group(0) @binding(6) var sweEnvOut: texture_storage_2d<rgba16float, write>;
@group(0) @binding(7) var sweWaterYOut: texture_storage_2d<r32float, write>;

fn swePointSeg(p: vec2f, a: vec2f, b: vec2f) -> vec2f {
  let ab = b - a;
  let len2 = max(dot(ab, ab), 1e-6);
  let t = clamp(dot(p - a, ab) / len2, 0.0, 1.0);
  let q = a + ab * t;
  return vec2f(length(p - q), t);
}

fn sweCutwaterSdf(local: vec2f, halfLen: f32, halfWid: f32) -> f32 {
  // Oriented stone bridge pier with pointed triangular cutwaters along +/- local.y (across bridge, into river current).
  let ax = abs(local.x);
  let ay = abs(local.y);
  let bodyY = max(0.0, halfWid - halfLen * 1.15);
  if (ay <= bodyY) {
    return ax - halfLen;
  }
  let tipLen = max(0.25, halfWid - bodyY);
  let t = (ay - bodyY) / tipLen;
  let allowedX = halfLen * max(0.0, 1.0 - t);
  let dSide = (ax - allowedX) * 0.72;
  let dTip = ay - halfWid;
  return max(dSide, dTip);
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = vec2i(textureDimensions(sweEnvOut));
  let q = vec2i(id.xy);
  if (any(q >= size)) { return; }

  let p = (vec2f(q) + 0.5 - vec2f(size) * 0.5) * sweU.domain.w + sweU.domain.xy;
  let packed = u32(max(0.0, sweU.prevAndCounts.z) + 0.5);
  let obsCount = packed & 1023u;
  let reachCount = (packed >> 10u) & 1023u;
  let hullCount = (packed >> 20u) & 1023u;
  let flags = u32(max(0.0, sweU.prevAndCounts.w) + 0.5);
  let hasCoast = (flags & 2u) != 0u;
  let hasRiver = (flags & 4u) != 0u;

  // 1. Coastal bathymetry from the shared coastalShelter DEM texture (shelter.z = bed elevation in metres).
  var h0 = -2.0;
  if (hasCoast) {
    let off = abs(p - sweU.coastalWin.xy);
    let inside = 1.0 - smoothstep(sweU.coastalWin.z - 220.0, sweU.coastalWin.z - 20.0, max(off.x, off.y));
    let uv = p / max(sweU.coastalWin.w, 1.0);
    let sh = textureSampleLevel(coastalShelter, coastalSamp, uv, 0.0);
    let bed = mix(-40.0, sh.z, inside);
    h0 = -bed;
  }

  // 2. River reaches: parabolic cross-section depth and ambient downstream velocity (u0, v0).
  var u0 = 0.0;
  var v0 = 0.0;
  var riverW = 0.0;
  var waterY = 0.0;
  if (hasRiver && reachCount > 0u) {
    var bestDepth = -2.0;
    var bestU = 0.0;
    var bestV = 0.0;
    var bestW = 0.0;
    var bestY = 0.0;
    for (var i = 0u; i < reachCount; i++) {
      let r = sweReaches[i];
      let hw = r.hydro.x;
      let minP = min(r.seg.xy, r.seg.zw) - vec2f(hw + 3.0);
      let maxP = max(r.seg.xy, r.seg.zw) + vec2f(hw + 3.0);
      if (any(p < minP) || any(p > maxP)) { continue; }
      let st = swePointSeg(p, r.seg.xy, r.seg.zw);
      let d = st.x;
      if (d < hw + 2.0) {
        let bankFrac = clamp(d / max(hw, 0.5), 0.0, 1.25);
        // Parabolic channel depth profile tapering smoothly to shallow wet bank edge
        let chDepth = select(-0.4 * (bankFrac - 1.0), r.hydro.y * max(0.08, 1.0 - 0.72 * bankFrac * bankFrac), bankFrac < 1.0);
        let w = 1.0 - smoothstep(0.85, 1.06, bankFrac);
        if (chDepth > bestDepth) {
          bestDepth = chDepth;
          // Velocity peaks in thalweg and slows slightly along banks
          let velProf = mix(0.45, 1.12, max(0.0, 1.0 - bankFrac * bankFrac));
          bestU = r.hydro.z * velProf;
          bestV = r.hydro.w * velProf;
          bestW = w;
          bestY = mix(r.info.x, r.info.y, st.y);
        }
      }
    }
    if (bestDepth > h0) {
      h0 = bestDepth;
    }
    if (bestW > 0.01) {
      u0 = bestU * bestW;
      v0 = bestV * bestW;
      riverW = bestW;
      waterY = bestY;
    }
  }

  // 3. Static physical obstructions: stone bridge piers & pointed cutwaters, timber pile bents, harbor pilings, boulders.
  var obs = 0.0;
  let cellSoft = sweU.domain.w * 0.65;
  for (var i = 0u; i < obsCount; i++) {
    let o = sweObstacles[i];
    let rel = p - o.posDir.xy;
    let bound = max(o.dims.x, o.dims.y) + cellSoft + 0.5;
    if (abs(rel.x) > bound || abs(rel.y) > bound) { continue; }
    let u = o.posDir.zw;
    let perp = vec2f(-u.y, u.x);
    let local = vec2f(dot(rel, u), dot(rel, perp));
    var sdf = 10.0;
    if (o.dims.z > 1.5) {
      // Cylinder (timber bridge pile bent, harbor piling, boulder)
      sdf = length(rel) - o.dims.x;
    } else if (o.dims.z > 0.5) {
      // Pointed stone cutwater pier
      sdf = sweCutwaterSdf(local, o.dims.x, o.dims.y);
    } else {
      // Oriented rectangular box (quay wall, stone abutment, rubble block)
      let d = abs(local) - o.dims.xy;
      sdf = length(max(d, vec2f(0.0))) + min(max(d.x, d.y), 0.0);
    }
    let m = 1.0 - smoothstep(-cellSoft * 0.35, cellSoft * 0.85, sdf);
    obs = max(obs, m);
  }

  // 4. Moving ship & river-barge hulls stamped as dynamic obstacles (generates bow pileup & deflected currents in rivers/harbors).
  for (var h = 0u; h < hullCount; h++) {
    let hull = sweHulls[h];
    let rel = p - hull.posVel.xy;
    let halfL = max(hull.dims.x * 0.5, 2.0);
    let halfB = max(hull.dims.y * 0.5, 0.8);
    let bound = halfL + cellSoft + 1.0;
    if (abs(rel.x) > bound || abs(rel.y) > bound) { continue; }
    let spd = length(hull.posVel.zw);
    let fwd = select(vec2f(0.0, 1.0), hull.posVel.zw / spd, spd > 0.05);
    let right = vec2f(-fwd.y, fwd.x);
    let s = dot(rel, fwd);
    let y = abs(dot(rel, right));
    let uLong = clamp(s / halfL, -1.0, 1.0);
    let planform = halfB * clamp(1.0 - pow(abs(uLong), 2.2) * 0.85, 0.12, 1.0);
    let sdf = max(abs(s) - halfL, y - planform);
    let m = 1.0 - smoothstep(-cellSoft * 0.3, cellSoft * 0.8, sdf);
    obs = max(obs, m);
  }

  // Clamp dry-bank elevation to keep half-float precision high around water surface.
  h0 = clamp(h0, -6.0, 48.0);
  textureStore(sweEnvOut, q, vec4f(h0, u0, v0, obs));
  textureStore(sweWaterYOut, q, vec4f(waterY, 0.0, 0.0, 0.0));
}
`;

// Pass B: Flux-conservative 2D Shallow Water Equations (Saint-Venant) + vorticity confinement + breaking-surf spawn emitter.
export const SHALLOW_WATER_STEP_WGSL = SHALLOW_WATER_TYPES + /* wgsl */ `
@group(0) @binding(0) var<uniform> sweU: SweUniform;
@group(0) @binding(1) var prevSurface: texture_2d_array<f32>;
@group(0) @binding(2) var nextLayer2: texture_storage_2d<rgba16float, write>;
@group(0) @binding(3) var sweEnv: texture_2d<f32>;
@group(0) @binding(4) var sweWaterY: texture_2d<f32>;
@group(0) @binding(5) var<storage, read_write> sprayCount: atomic<u32>;
@group(0) @binding(6) var<storage, read_write> spraySpawns: array<SweSpraySpawn>;

const SWE_G: f32 = 9.81;

fn sweClean1(x: f32) -> f32 {
  let bits = bitcast<u32>(x) & 0x7fffffffu;
  if ((x != x) || !(x == x) || bits >= 0x7f800000u || abs(x) > 50.0) { return 0.0; }
  return x;
}
fn sweClean4(v: vec4f) -> vec4f {
  return vec4f(sweClean1(v.x), sweClean1(v.y), sweClean1(v.z), clamp(sweClean1(v.w), 0.0, 1.0));
}

fn loadPrev(q: vec2i, size: vec2i, doClear: bool) -> vec4f {
  if (doClear || any(q < vec2i(1)) || any(q >= size - 1)) { return vec4f(0.0); }
  return sweClean4(textureLoad(prevSurface, q, 2, 0));
}

fn loadEnv(q: vec2i, size: vec2i) -> vec4f {
  let cq = clamp(q, vec2i(0), size - 1);
  return textureLoad(sweEnv, cq, 0);
}

fn samplePrevBilinear(qf: vec2f, size: vec2i, doClear: bool) -> vec4f {
  if (doClear) { return vec4f(0.0); }
  let c = clamp(qf, vec2f(1.0), vec2f(size) - 2.001);
  let i0 = vec2i(floor(c));
  let f = c - vec2f(i0);
  let s00 = loadPrev(i0, size, false);
  let s10 = loadPrev(i0 + vec2i(1, 0), size, false);
  let s01 = loadPrev(i0 + vec2i(0, 1), size, false);
  let s11 = loadPrev(i0 + vec2i(1, 1), size, false);
  return mix(mix(s00, s10, f.x), mix(s01, s11, f.x), f.y);
}

fn sweHash(q: vec2i, frameSeed: u32) -> f32 {
  var h = (bitcast<u32>(q.x) * 73856093u) ^ (bitcast<u32>(q.y) * 19349663u) ^ (frameSeed * 83492791u);
  h = (h ^ (h >> 16u)) * 0x45d9f3bu;
  h = h ^ (h >> 16u);
  return f32(h & 65535u) / 65535.0;
}

@compute @workgroup_size(8, 8)
fn main(@builtin(global_invocation_id) id: vec3u) {
  let size = vec2i(textureDimensions(sweEnv));
  let q = vec2i(id.xy);
  if (any(q >= size)) { return; }

  let flags = u32(max(0.0, sweU.prevAndCounts.w) + 0.5);
  let doClear = (flags & 1u) != 0u;
  let hasCoast = (flags & 2u) != 0u;
  let emitSpray = (flags & 8u) != 0u;

  let dx = max(sweU.domain.w, 0.25);
  let dt = clamp(sweU.forcing.x, 0.0, 0.032);
  let t = sweU.forcing.y;
  let shift = vec2i(round((sweU.domain.xy - sweU.prevAndCounts.xy) / dx));
  let oldQ = q + shift;

  let envC = loadEnv(q, size);
  let h0 = envC.x;
  let uAmb = envC.yz;
  let obsC = envC.w;
  let ambSpeed = length(uAmb);
  let isRiver = ambSpeed > 0.06;

  // Solid obstacle cell (bridge pier, cutwater, piling, boulder, hull): zero velocity, zero displacement.
  if (obsC > 0.72 || h0 < -1.2) {
    textureStore(nextLayer2, q, vec4f(0.0));
    return;
  }

  let envL = loadEnv(q + vec2i(-1, 0), size);
  let envR = loadEnv(q + vec2i(1, 0), size);
  let envD = loadEnv(q + vec2i(0, -1), size);
  let envU = loadEnv(q + vec2i(0, 1), size);

  let solidL = envL.w > 0.55 || envL.x < -0.55;
  let solidR = envR.w > 0.55 || envR.x < -0.55;
  let solidD = envD.w > 0.55 || envD.x < -0.55;
  let solidU = envU.w > 0.55 || envU.x < -0.55;
  let nearSolid = solidL || solidR || solidD || solidU;

  // Load current & neighbor states (with no-penetration reflective wall boundary conditions against solid piers!)
  var stC = loadPrev(oldQ, size, doClear);
  // Seed river velocity smoothly from ambient channel flow on clear or freshly shifted border cells
  if (doClear || any(oldQ < vec2i(2)) || any(oldQ >= size - 2)) {
    stC = vec4f(0.0, uAmb.x, uAmb.y, 0.0);
  }

  var stL = loadPrev(oldQ + vec2i(-1, 0), size, doClear);
  var stR = loadPrev(oldQ + vec2i(1, 0), size, doClear);
  var stD = loadPrev(oldQ + vec2i(0, -1), size, doClear);
  var stU = loadPrev(oldQ + vec2i(0, 1), size, doClear);

  // Solid wall reflection: mirror free-surface eta and invert normal velocity component so momentum converts into physical bow pileup!
  if (solidL) { stL = vec4f(stC.x, -stC.y, stC.z * 0.78, stC.w); }
  if (solidR) { stR = vec4f(stC.x, -stC.y, stC.z * 0.78, stC.w); }
  if (solidD) { stD = vec4f(stC.x, stC.y * 0.78, -stC.z, stC.w); }
  if (solidU) { stU = vec4f(stC.x, stC.y * 0.78, -stC.z, stC.w); }

  // Effective water depths H = max(0, h0 + eta) with smooth wetting/drying for beaches.
  let hDry = 0.04;
  let HC = max(0.0, h0 + stC.x);
  let HL = max(0.0, select(envL.x, h0, solidL) + stL.x);
  let HR = max(0.0, select(envR.x, h0, solidR) + stR.x);
  let HD = max(0.0, select(envD.x, h0, solidD) + stD.x);
  let HU = max(0.0, select(envU.x, h0, solidU) + stU.x);

  // Cap wave speed for unconditional CFL stability at dx = 0.5 m (cMax = 4.6 m/s => CFL <= 0.30 at 60 FPS)
  let hEffC = min(max(HC, hDry), 2.2);
  let hEffL = min(max(HL, hDry), 2.2);
  let hEffR = min(max(HR, hDry), 2.2);
  let hEffD = min(max(HD, hDry), 2.2);
  let hEffU = min(max(HU, hDry), 2.2);

  // 1. Mass conservation (flux-conservative Rusanov / Lax-Friedrichs finite volume):
  //    d(eta)/dt + d(H*u)/dx + d(H*v)/dz = 0
  let qxL = hEffL * stL.y;
  let qxR = hEffR * stR.y;
  let qzD = hEffD * stD.z;
  let qzU = hEffU * stU.z;
  let divQ = (qxR - qxL + qzU - qzD) / (2.0 * dx);

  // Gentle Lax-Friedrichs numerical diffusion proportional to local wave speed c = sqrt(g * hEff)
  let cWave = sqrt(SWE_G * hEffC);
  let etaAvg = 0.25 * (stL.x + stR.x + stD.x + stU.x);
  let lfDiff = clamp(0.16 * cWave * dt / dx, 0.015, 0.22);
  var etaNew = mix(stC.x, etaAvg, lfDiff) - dt * divQ;

  // 2. Semi-Lagrangian advection of velocity (u, v) and foam along live SWE velocity:
  let velOld = stC.yz;
  let backPos = vec2f(oldQ) - clamp(velOld * (dt / dx), vec2f(-1.5), vec2f(1.5));
  let adv = samplePrevBilinear(backPos, size, doClear);
  var uNew = adv.y;
  var vNew = adv.z;
  var foamNew = adv.w;

  // 3. Pressure gradient acceleration (-g * grad(eta)):
  //    Uses wet-dry aware central difference so water rushes up dry beach slopes when eta > -h0 and drains back down!
  let dEtaDx = (stR.x - stL.x) / (2.0 * dx);
  let dEtaDz = (stU.x - stD.x) / (2.0 * dx);
  let wetMask = smoothstep(-0.08, 0.10, max(h0 + etaNew, max(HL, max(HR, max(HD, HU)))));
  uNew -= SWE_G * dEtaDx * dt * wetMask;
  vNew -= SWE_G * dEtaDz * dt * wetMask;

  // 4. Vorticity confinement (preserves crisp Kármán vortex eddies shedding off bridge piers & cutwaters!):
  let omegaC = ((stR.z - stL.z) - (stU.y - stD.y)) / (2.0 * dx);
  let stLL = loadPrev(oldQ + vec2i(-2, 0), size, doClear);
  let stRR = loadPrev(oldQ + vec2i(2, 0), size, doClear);
  let stDD = loadPrev(oldQ + vec2i(0, -2), size, doClear);
  let stUU = loadPrev(oldQ + vec2i(0, 2), size, doClear);
  let omegaL = abs(((stC.z - stLL.z) - (loadPrev(oldQ + vec2i(-1, 1), size, doClear).y - loadPrev(oldQ + vec2i(-1, -1), size, doClear).y)) / (2.0 * dx));
  let omegaR = abs(((stRR.z - stC.z) - (loadPrev(oldQ + vec2i(1, 1), size, doClear).y - loadPrev(oldQ + vec2i(1, -1), size, doClear).y)) / (2.0 * dx));
  let omegaD = abs(((loadPrev(oldQ + vec2i(1, -1), size, doClear).z - loadPrev(oldQ + vec2i(-1, -1), size, doClear).z) - (stC.y - stDD.y)) / (2.0 * dx));
  let omegaU = abs(((loadPrev(oldQ + vec2i(1, 1), size, doClear).z - loadPrev(oldQ + vec2i(-1, 1), size, doClear).z) - (stUU.y - stC.y)) / (2.0 * dx));
  let gradW = vec2f(omegaR - omegaL, omegaU - omegaD) / (2.0 * dx);
  let gLen = length(gradW);
  if (gLen > 1e-3 && isRiver) {
    let N = gradW / gLen;
    // N x (0, omega, 0) in XZ plane => (N.y * omega, -N.x * omega)
    let vortEps = 0.22 * dx;
    let vortForce = vec2f(N.y * omegaC, -N.x * omegaC) * vortEps;
    uNew += clamp(vortForce.x, -1.8, 1.8) * dt;
    vNew += clamp(vortForce.y, -1.8, 1.8) * dt;
  }

  // 5. Physical bottom friction (Manning/Chezy quadratic drag) + viscous smoothing:
  let spdNew = length(vec2f(uNew, vNew));
  let dragCoeff = select(0.018, 0.045, HC < 0.35);
  let drag = exp(-dragCoeff * spdNew / max(HC, 0.12) * dt);
  uNew *= drag;
  vNew *= drag;

  // 6. River current maintenance & pier stagnation/bow-wave enhancement:
  if (isRiver) {
    // Gently restore bulk channel flow away from solid obstacles so river keeps flowing steadily through the scrolling window,
    // while piers freely stall, deflect, accelerate (Venturi), and shed eddies locally!
    let restoreRate = select(0.65, 0.15, nearSolid);
    let blend = 1.0 - exp(-restoreRate * dt);
    uNew = mix(uNew, uAmb.x, blend);
    vNew = mix(vNew, uAmb.y, blend);
    // Direct stagnation pressure conversion on the upstream face of a bridge pier/cutwater:
    // If ambient flow drives into an adjacent solid wall, add physical velocity-head pileup (v^2 / 2g)
    if (nearSolid) {
      let wallN = normalize(vec2f(
        select(0.0, -1.0, solidR) + select(0.0, 1.0, solidL),
        select(0.0, -1.0, solidU) + select(0.0, 1.0, solidD)
      ) + vec2f(1e-5, 0.0));
      // wallN points FROM solid INTO water; impact is when flow opposes wallN (-dot(u, wallN) > 0)
      let impact = max(0.0, -dot(uAmb, wallN));
      let head = min(0.28, impact * impact / (2.0 * SWE_G) * 2.4);
      etaNew += (head - etaNew * 0.35) * min(1.0, dt * 4.5);
      // Tangential slip around the cutwater shoulders
      let vn = dot(vec2f(uNew, vNew), wallN);
      if (vn < 0.0) {
        uNew -= wallN.x * vn;
        vNew -= wallN.y * vn;
      }
    }
    // Mild restoring damping on eta so mean river elevation stays anchored to rest surface
    etaNew *= exp(-0.42 * dt);
  } else if (hasCoast) {
    // 7. Shallow coastal ocean: inject incoming swell waves at the outer shoaling band (h0 in 2.5..12 m)
    //    so waves physically refract/diffract around piers & headlands, steepen over bars, and run up beaches!
    let p = (vec2f(q) + 0.5 - vec2f(size) * 0.5) * dx + sweU.domain.xy;
    let swellDir = sweU.forcing.zw;
    let hs = clamp(sweU.seaParams.x, 0.0, 3.2);
    let k0 = sweU.seaParams.y;
    let omega = sweU.seaParams.z;
    let phase = dot(p, swellDir) * k0 - t * omega;
    let targetAmp = min(0.55, hs * 0.24);
    let targetEta = targetAmp * sin(phase);
    let cOrb = sqrt(SWE_G * clamp(h0, 0.2, 6.0));
    let targetU = (SWE_G / max(cOrb, 1.0)) * targetEta * swellDir.x;
    let targetV = (SWE_G / max(cOrb, 1.0)) * targetEta * swellDir.y;
    // Drive smoothly at outer deeper rim (h0 > 3.5 m), leaving shallow surf zone (h0 < 3.5 m) & pier vicinity 100% free PDE!
    let driveBand = smoothstep(2.4, 7.0, h0) * (1.0 - smoothstep(11.0, 18.0, h0)) * select(1.0, 0.0, nearSolid);
    if (driveBand > 0.01 && hs > 0.05) {
      let kDrive = 1.0 - exp(-1.8 * driveBand * dt);
      etaNew = mix(etaNew, targetEta, kDrive);
      uNew = mix(uNew, targetU, kDrive);
      vNew = mix(vNew, targetV, kDrive);
    }
    // Deep water (> 16 m) damps cleanly to zero so open ocean remains pure spectral FFT + wakes
    let deepDamp = smoothstep(13.0, 22.0, h0);
    etaNew *= mix(exp(-0.22 * dt), exp(-4.0 * dt), deepDamp);
    uNew *= mix(1.0, exp(-4.0 * dt), deepDamp);
    vNew *= mix(1.0, exp(-4.0 * dt), deepDamp);
  }

  // Soft sponge boundary along the 256 m scrolling window rim (prevents edge reflections)
  let edgeFrac = max(abs((vec2f(q) + 0.5) / vec2f(size) - 0.5).x, abs((vec2f(q) + 0.5) / vec2f(size) - 0.5).y);
  let sponge = smoothstep(0.41, 0.495, edgeFrac);
  if (sponge > 0.0) {
    etaNew *= (1.0 - sponge * 0.45);
    uNew = mix(uNew, uAmb.x, sponge * 0.45);
    vNew = mix(vNew, uAmb.y, sponge * 0.45);
    foamNew *= (1.0 - sponge * 0.45);
  }

  // Clamp physical bounds for guaranteed stability
  etaNew = clamp(etaNew, -0.85, 0.85);
  let velMag = length(vec2f(uNew, vNew));
  if (velMag > 5.5) {
    let sc = 5.5 / velMag;
    uNew *= sc;
    vNew *= sc;
  }
  // Dry cells above swash water level cannot hold velocity
  if (h0 + etaNew <= 0.02) {
    uNew *= 0.25;
    vNew *= 0.25;
  }

  // 8. Advected whitewater foam generation (pier bow collars, vortex wake ribbons, shallow breaking surf):
  let divU = ((stR.y - stL.y) + (stU.z - stD.z)) / (2.0 * dx);
  let conv = max(0.0, -divU);
  let slopeMag = length(vec2f(dEtaDx, dEtaDz));
  let pierImpact = select(0.0, clamp(conv * 1.1 + abs(omegaC) * 0.45 + max(0.0, etaNew) * 3.2, 0.0, 1.5), nearSolid);
  let wakeShear = select(0.0, smoothstep(0.45, 1.8, abs(omegaC)) * smoothstep(0.30, 1.3, ambSpeed) * 0.95, isRiver);
  // Shallow wave breaking criterion (H_wave / depth > 0.72 => eta / max(h0, 0.22) > 0.36, or steep face)
  let breakRatio = select(0.0, max(0.0, etaNew) / max(h0, 0.22), !isRiver && h0 > -0.15 && h0 < 4.5);
  let surfBreak = select(0.0, smoothstep(0.28, 0.72, breakRatio) + smoothstep(0.26, 0.65, slopeMag) * smoothstep(4.5, 0.4, h0), !isRiver && h0 > -0.25 && h0 < 5.0);

  let foamGen = (pierImpact * 2.6 + wakeShear * 1.65 + surfBreak * 2.8) * dt;
  let foamDecay = select(0.42, 0.22, isRiver);
  foamNew = clamp(foamNew * exp(-foamDecay * dt) + foamGen, 0.0, 1.0);
  // Keep wake foam slightly stronger right behind piers and vanish cleanly in deep open sea
  if (!isRiver && h0 > 14.0) { foamNew *= exp(-3.5 * dt); }

  // 9. GPU breaking-crest & pier-impact spray emitter (zero CPU readback — feeds Tier 3 ballistic spray!)
  if (emitSpray && (pierImpact > 0.42 || surfBreak > 0.48)) {
    let p = (vec2f(q) + 0.5 - vec2f(size) * 0.5) * dx + sweU.domain.xy;
    let seed = sweHash(q, u32(t * 60.0));
    let threshold = select(0.92, 0.86, pierImpact > 0.55 || surfBreak > 0.78);
    if (seed > threshold) {
      let slot = atomicAdd(&sprayCount, 1u);
      if (slot < ${SHALLOW_WATER_LIMITS.spraySpawns}u) {
        let energy = clamp(max(pierImpact, surfBreak), 0.3, 1.5);
        let isSurf = select(0.0, 1.0, surfBreak >= pierImpact);
        let upVel = mix(1.4, 3.8, clamp(energy * 0.75, 0.0, 1.0));
        let wy = textureLoad(sweWaterY, q, 0).r;
        spraySpawns[slot] = SweSpraySpawn(
          vec4f(p.x, wy + etaNew, p.y, energy),
          vec4f(uNew, vNew, upVel, isSurf)
        );
      }
    }
  }

  textureStore(nextLayer2, q, vec4f(etaNew, uNew, vNew, foamNew));
}
`;

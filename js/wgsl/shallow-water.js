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
@group(0) @binding(7) var sweWaterYOut: texture_storage_2d<rgba16float, write>;

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

  // 1. Coastal bathymetry & wave-exposure transmission from shared coastalShelter (x = rawTransmit, z = bed elevation).
  var h0 = -2.0;
  var rawTransmit = 1.0;
  if (hasCoast) {
    let off = abs(p - sweU.coastalWin.xy);
    let inside = 1.0 - smoothstep(sweU.coastalWin.z - 220.0, sweU.coastalWin.z - 20.0, max(off.x, off.y));
    let uv = p / max(sweU.coastalWin.w, 1.0);
    let sh = textureSampleLevel(coastalShelter, coastalSamp, uv, 0.0);
    let bed = mix(-40.0, sh.z, inside);
    h0 = -bed;
    rawTransmit = clamp(mix(1.0, sh.x, inside), 0.0, 1.0);
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

  // 3. Static physical obstructions: stone bridge piers & pointed cutwaters, timber pile bents, harbor pilings.
  var obs = 0.0;
  var obsProx = 0.0;
  let cellSoft = sweU.domain.w * 0.65;
  for (var i = 0u; i < obsCount; i++) {
    let o = sweObstacles[i];
    let rel = p - o.posDir.xy;
    let bound = max(o.dims.x, o.dims.y) + cellSoft + 3.0;
    if (abs(rel.x) > bound || abs(rel.y) > bound) { continue; }
    let u = o.posDir.zw;
    let perp = vec2f(-u.y, u.x);
    let local = vec2f(dot(rel, u), dot(rel, perp));
    var sdf = 10.0;
    if (o.dims.z > 1.5) {
      // Cylinder (timber bridge pile bent, harbor piling)
      sdf = length(rel) - o.dims.x;
    } else if (o.dims.z > 0.5) {
      // Pointed stone cutwater pier
      sdf = sweCutwaterSdf(local, o.dims.x, o.dims.y);
    } else {
      // Oriented rectangular box (solid stone mole, breakwater, abutment)
      let d = abs(local) - o.dims.xy;
      sdf = length(max(d, vec2f(0.0))) + min(max(d.x, d.y), 0.0);
    }
    let m = 1.0 - smoothstep(-cellSoft * 0.35, cellSoft * 0.85, sdf);
    obs = max(obs, m);
    obsProx = max(obsProx, 1.0 - smoothstep(0.0, 2.4, max(0.0, sdf)));
  }

  // 4. Moving ship & river-barge hulls stamped as dynamic obstacles (generates bow pileup & deflected currents in rivers/harbors).
  for (var h = 0u; h < hullCount; h++) {
    let hull = sweHulls[h];
    let rel = p - hull.posVel.xy;
    let halfL = max(hull.dims.x * 0.5, 2.0);
    let halfB = max(hull.dims.y * 0.5, 0.8);
    let bound = halfL + cellSoft + 2.5;
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
    obsProx = max(obsProx, 1.0 - smoothstep(0.0, 2.0, max(0.0, sdf)));
  }

  // Clamp dry-bank elevation to keep half-float precision high around water surface.
  h0 = clamp(h0, -6.0, 48.0);
  textureStore(sweEnvOut, q, vec4f(h0, u0, v0, obs));
  textureStore(sweWaterYOut, q, vec4f(waterY, rawTransmit, obsProx, riverW));
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
  let metaC = textureLoad(sweWaterY, q, 0);
  let h0 = envC.x;
  let uAmb = envC.yz;
  let obsC = envC.w;
  let waterY = metaC.x;
  let rawTransmit = clamp(metaC.y, 0.0, 1.0);
  let obsProx = clamp(metaC.z, 0.0, 1.0);
  let ambSpeed = length(uAmb);
  let isRiver = ambSpeed > 0.06;

  // Solid obstacle cell (bridge pier, cutwater, piling, hull): zero velocity, zero displacement.
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

  // Load current & neighbor states
  var stC = loadPrev(oldQ, size, doClear);
  // Seed river velocity smoothly from ambient channel flow on clear or freshly shifted border cells
  if (doClear || any(oldQ < vec2i(2)) || any(oldQ >= size - 2)) {
    stC = vec4f(0.0, uAmb.x, uAmb.y, 0.0);
  }

  var stL = loadPrev(oldQ + vec2i(-1, 0), size, doClear);
  var stR = loadPrev(oldQ + vec2i(1, 0), size, doClear);
  var stD = loadPrev(oldQ + vec2i(0, -1), size, doClear);
  var stU = loadPrev(oldQ + vec2i(0, 1), size, doClear);

  // Solid wall mirror state (no-penetration slip reflection for tangent/vorticity terms)
  if (solidL) { stL = vec4f(stC.x, -stC.y, stC.z * 0.88, stC.w); }
  if (solidR) { stR = vec4f(stC.x, -stC.y, stC.z * 0.88, stC.w); }
  if (solidD) { stD = vec4f(stC.x, stC.y * 0.88, -stC.z, stC.w); }
  if (solidU) { stU = vec4f(stC.x, stC.y * 0.88, -stC.z, stC.w); }

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

  let cC = sqrt(SWE_G * hEffC);
  let cL = sqrt(SWE_G * hEffL);
  let cR = sqrt(SWE_G * hEffR);
  let cD = sqrt(SWE_G * hEffD);
  let cU = sqrt(SWE_G * hEffU);

  // 1. True Monotone Rusanov / Local Lax-Friedrichs Finite-Volume Fluxes on Half-Cell Faces (i±1/2, j±1/2):
  //    Couples directly adjacent cells (C <-> L,R,D,U) so 2-dx Nyquist checkerboard ringing is mathematically damped!
  //    At solid faces (cutwater piers, pilings, quay walls): exact zero mass flux and acoustic wall reflection pressure.
  let aR = max(abs(stC.y) + cC, abs(stR.y) + cR);
  let aL = max(abs(stC.y) + cC, abs(stL.y) + cL);
  let aU = max(abs(stC.z) + cC, abs(stU.z) + cU);
  let aD = max(abs(stC.z) + cC, abs(stD.z) + cD);

  let fHR = select(0.5 * (hEffC * stC.y + hEffR * stR.y) - 0.5 * aR * (stR.x - stC.x), 0.0, solidR);
  let fHL = select(0.5 * (hEffL * stL.y + hEffC * stC.y) - 0.5 * aL * (stC.x - stL.x), 0.0, solidL);
  let fHU = select(0.5 * (hEffC * stC.z + hEffU * stU.z) - 0.5 * aU * (stU.x - stC.x), 0.0, solidU);
  let fHD = select(0.5 * (hEffD * stD.z + hEffC * stC.z) - 0.5 * aD * (stC.x - stD.x), 0.0, solidD);

  var etaNew = stC.x - (dt / dx) * ((fHR - fHL) + (fHU - fHD));

  // Acoustic Riemann face elevations (couples pressure gradient to immediate neighbors, zero odd-even decoupling):
  let etaFaceR = select(
    0.5 * (stC.x + stR.x) - 0.5 * (hEffR * stR.y - hEffC * stC.y) / max(aR, 0.6),
    stC.x + clamp((hEffC * stC.y) / max(cC, 0.8), -0.18, 0.22),
    solidR
  );
  let etaFaceL = select(
    0.5 * (stL.x + stC.x) - 0.5 * (hEffC * stC.y - hEffL * stL.y) / max(aL, 0.6),
    stC.x - clamp((hEffC * stC.y) / max(cC, 0.8), -0.22, 0.18),
    solidL
  );
  let etaFaceU = select(
    0.5 * (stC.x + stU.x) - 0.5 * (hEffU * stU.z - hEffC * stC.z) / max(aU, 0.6),
    stC.x + clamp((hEffC * stC.z) / max(cC, 0.8), -0.18, 0.22),
    solidU
  );
  let etaFaceD = select(
    0.5 * (stD.x + stC.x) - 0.5 * (hEffC * stC.z - hEffD * stD.z) / max(aD, 0.6),
    stC.x - clamp((hEffC * stC.z) / max(cC, 0.8), -0.22, 0.18),
    solidD
  );

  // 2. Semi-Lagrangian advection of velocity (u, v) and foam along live SWE velocity:
  let velOld = stC.yz;
  let backPos = vec2f(oldQ) - clamp(velOld * (dt / dx), vec2f(-1.5), vec2f(1.5));
  let adv = samplePrevBilinear(backPos, size, doClear);
  var uNew = adv.y;
  var vNew = adv.z;
  var foamNew = adv.w;

  // 3. Pressure gradient acceleration (-g * grad(eta)) from Riemann face states:
  let dEtaDx = (etaFaceR - etaFaceL) / dx;
  let dEtaDz = (etaFaceU - etaFaceD) / dx;
  let wetMask = smoothstep(-0.08, 0.10, max(h0 + etaNew, max(HL, max(HR, max(HD, HU)))));
  uNew -= SWE_G * dEtaDx * dt * wetMask;
  vNew -= SWE_G * dEtaDz * dt * wetMask;

  // Mild physical kinematic eddy viscosity on velocity to keep streamlines silky-smooth around piers & pilings
  let velAvg = 0.25 * (stL.yz + stR.yz + stD.yz + stU.yz);
  let viscBlend = clamp(0.18 * dt / (dx * dx), 0.0, 0.10);
  uNew = mix(uNew, velAvg.x, viscBlend);
  vNew = mix(vNew, velAvg.y, viscBlend);

  // 4. Vorticity confinement (strictly localized to shed vortex wakes behind piers — silent in laminar channel flow!):
  let omegaC = ((stR.z - stL.z) - (stU.y - stD.y)) / (2.0 * dx);
  if (isRiver && abs(omegaC) > 0.55) {
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
    if (gLen > 1e-3) {
      let N = gradW / gLen;
      let vortEps = 0.14 * dx * smoothstep(0.55, 1.8, abs(omegaC));
      let vortForce = vec2f(N.y * omegaC, -N.x * omegaC) * vortEps;
      uNew += clamp(vortForce.x, -1.2, 1.2) * dt;
      vNew += clamp(vortForce.y, -1.2, 1.2) * dt;
    }
  }

  // 5. Physical bottom friction (Manning/Chezy quadratic drag):
  let spdNew = length(vec2f(uNew, vNew));
  let dragCoeff = select(0.020, 0.048, HC < 0.35);
  let drag = exp(-dragCoeff * spdNew / max(HC, 0.12) * dt);
  uNew *= drag;
  vNew *= drag;

  // 6. River current maintenance & smooth aquadynamic cutwater bow cushion + parting:
  var pierBowImpact = 0.0;
  if (isRiver) {
    let restoreRate = mix(0.75, 0.12, max(obsProx, select(0.0, 1.0, nearSolid)));
    let blend = 1.0 - exp(-restoreRate * dt);
    uNew = mix(uNew, uAmb.x, blend);
    vNew = mix(vNew, uAmb.y, blend);
    if (nearSolid) {
      let wallN = normalize(vec2f(
        select(0.0, -1.0, solidR) + select(0.0, 1.0, solidL),
        select(0.0, -1.0, solidU) + select(0.0, 1.0, solidD)
      ) + vec2f(1e-5, 0.0));
      // wallN points FROM solid INTO water; upstream nose receives positive impact (-dot(uAmb, wallN) > 0)
      let impact = max(0.0, -dot(uAmb, wallN));
      pierBowImpact = impact;
      // Physical stagnation head (v^2 / 2g): smooth glassy meniscus/bow pillow up to +16 cm on fast piers
      let head = min(0.18, impact * impact / (2.0 * SWE_G) * 1.9);
      etaNew += (head - etaNew * 0.25) * min(1.0, dt * 3.8);
      // Clean tangential parting along cutwater faces (no wall penetration)
      let vn = dot(vec2f(uNew, vNew), wallN);
      if (vn < 0.0) {
        uNew -= wallN.x * vn;
        vNew -= wallN.y * vn;
      }
    }
    // Gentle restoring damping on eta so mean river surface stays anchored while diverging V-wakes travel cleanly
    etaNew *= exp(-0.36 * dt);
  } else if (hasCoast) {
    // 7. Shallow coastal ocean (additive layer on top of coastalWaveState shoreline/seawall/pier reflections):
    //    Respects coastalShelter rawTransmit strictly so sheltered harbors stay completely calm and undisturbed,
    //    while exposed surf zones gain subtle physical shallow-water diffraction & swash detail without fighting coastalWaveState.
    let exposure = smoothstep(0.32, 0.82, rawTransmit);
    let p = (vec2f(q) + 0.5 - vec2f(size) * 0.5) * dx + sweU.domain.xy;
    let swellDir = sweU.forcing.zw;
    let hs = clamp(sweU.seaParams.x, 0.0, 3.2) * exposure;
    let k0 = sweU.seaParams.y;
    let omega = sweU.seaParams.z;
    let phase = dot(p, swellDir) * k0 - t * omega;
    let targetAmp = min(0.26, hs * 0.13);
    let targetEta = targetAmp * sin(phase);
    let cOrb = sqrt(SWE_G * clamp(h0, 0.2, 6.0));
    let targetU = (SWE_G / max(cOrb, 1.0)) * targetEta * swellDir.x;
    let targetV = (SWE_G / max(cOrb, 1.0)) * targetEta * swellDir.y;
    // Drive gently at outer shoaling rim (h0 in 3.0..13 m) ONLY where exposed to open sea
    let driveBand = smoothstep(3.0, 7.5, h0) * (1.0 - smoothstep(10.5, 16.0, h0)) * exposure * select(1.0, 0.0, nearSolid);
    if (driveBand > 0.01 && hs > 0.08) {
      let kDrive = 1.0 - exp(-1.35 * driveBand * dt);
      etaNew = mix(etaNew, targetEta, kDrive);
      uNew = mix(uNew, targetU, kDrive);
      vNew = mix(vNew, targetV, kDrive);
    }
    // Sheltered harbors & deep open ocean damp smoothly to zero so coastalWaveState & surfaceWaves shine cleanly
    let shelterDamp = 1.0 - exposure;
    let deepDamp = smoothstep(11.0, 18.0, h0);
    let dampRate = mix(0.32, 3.4, max(deepDamp, shelterDamp * 0.85));
    etaNew *= exp(-dampRate * dt);
    let velDamp = exp(-mix(0.20, 3.6, max(deepDamp, shelterDamp * 0.65)) * dt);
    uNew *= velDamp;
    vNew *= velDamp;
    // Never pull shallow coastal water troughs below the shallow sandy harbor floor
    if (h0 > 0.05) {
      let minEta = -min(0.28, h0 * mix(0.14, 0.36, exposure));
      etaNew = max(etaNew, minEta);
    }
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
  etaNew = clamp(etaNew, -0.65, 0.65);
  let velMag = length(vec2f(uNew, vNew));
  if (velMag > 5.0) {
    let sc = 5.0 / velMag;
    uNew *= sc;
    vNew *= sc;
  }
  // Dry cells above swash water level cannot hold velocity
  if (h0 + etaNew <= 0.02) {
    uNew *= 0.25;
    vNew *= 0.25;
  }

  // 8. Advected whitewater foam: strictly localized to real cutwater collars, strong pier shear wakes, and exposed surf!
  //    Zero uniform background river froth and zero fake foam lines on calm sheltered docks.
  let exposureFoam = smoothstep(0.32, 0.78, rawTransmit);
  let divU = ((stR.y - stL.y) + (stU.z - stD.z)) / (2.0 * dx);
  let conv = max(0.0, -divU);
  let slopeMag = length(vec2f(dEtaDx, dEtaDz));
  let pierCollar = select(
    0.0,
    clamp(smoothstep(0.20, 1.30, pierBowImpact) * 1.05 + smoothstep(0.30, 1.5, conv) * 0.50 + max(0.0, etaNew - 0.020) * 4.5, 0.0, 1.15),
    isRiver && nearSolid
  );
  // Slender separation ribbons peeling off cutwater shoulders & trailing pier shear layers (zero in open laminar channel!)
  let shoulderShear = select(
    0.0,
    smoothstep(0.45, 1.65, abs(omegaC)) * smoothstep(0.45, 1.45, ambSpeed) * mix(0.48, 0.95, obsProx),
    isRiver
  );
  // Shallow ocean wave breaking ONLY on genuinely exposed surf coasts (rawTransmit > 0.32)
  let breakRatio = select(0.0, max(0.0, etaNew) / max(h0, 0.24), !isRiver && h0 > -0.10 && h0 < 3.8);
  let surfBreak = select(
    0.0,
    (smoothstep(0.34, 0.78, breakRatio) + smoothstep(0.32, 0.72, slopeMag) * smoothstep(3.8, 0.35, h0)) * exposureFoam,
    !isRiver && h0 > -0.20 && h0 < 4.2
  );

  let foamGen = (pierCollar * 2.1 + shoulderShear * 1.55 + surfBreak * 2.2) * dt;
  let foamDecay = select(0.48, 0.34, isRiver);
  foamNew = clamp(foamNew * exp(-foamDecay * dt) + foamGen, 0.0, 1.0);
  // Calm sheltered harbors and deep open sea clear foam cleanly
  if (!isRiver && (h0 > 12.0 || exposureFoam < 0.05)) { foamNew *= exp(-3.5 * dt); }

  // 9. Tier 3 ballistic spray mist: ONLY genuine exposed open-coast crashing surf breakers!
  //    Never spawn smoke-card spray billboards at river bridge piers or calm sheltered harbor docks.
  if (emitSpray && !isRiver && rawTransmit > 0.48 && surfBreak > 0.68 && h0 > 0.05 && h0 < 2.2) {
    let p = (vec2f(q) + 0.5 - vec2f(size) * 0.5) * dx + sweU.domain.xy;
    let seed = sweHash(q, u32(t * 60.0));
    if (seed > 0.93) {
      let slot = atomicAdd(&sprayCount, 1u);
      if (slot < ${SHALLOW_WATER_LIMITS.spraySpawns}u) {
        let energy = clamp(surfBreak * exposureFoam, 0.35, 1.25);
        let upVel = mix(1.1, 2.8, clamp(energy * 0.7, 0.0, 1.0));
        spraySpawns[slot] = SweSpraySpawn(
          vec4f(p.x, waterY + etaNew, p.y, energy),
          vec4f(uNew, vNew, upVel, 1.0)
        );
      }
    }
  }

  textureStore(nextLayer2, q, vec4f(etaNew, uNew, vNew, foamNew));
}
`;

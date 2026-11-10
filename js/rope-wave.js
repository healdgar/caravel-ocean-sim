// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Shared 1D damped wave-equation normal modes and coupled hanging-chain pendulum
// dynamics for vessel standing and running rigging across CPU and WebGPU shaders.

const vesselRopeChainStates = new WeakMap();

function ropeWaveClamp(x, lo, hi) {
  return Math.max(lo, Math.min(hi, x));
}

/**
 * Steps the per-vessel 2D coupled chain-pendulum oscillator driven by hull roll,
 * pitch, angular velocities, angular accelerations, and heave.
 * Runs in O(1). The vessel's physics step advances it; a vessel whose physics
 * did not run this frame is advanced by packRopeChainUniform instead, so the
 * oscillator moves by exactly one frame of time whichever path runs. A step of
 * no duration (paused) leaves the state untouched.
 */
export function stepVesselRopeChain(boat, dt = 0) {
  if (!boat || typeof boat !== 'object') {
    return { active: 0, swayX: 0, swayZ: 0 };
  }
  let state = vesselRopeChainStates.get(boat);
  const roll = Number.isFinite(boat.roll) ? boat.roll : 0;
  const pitch = Number.isFinite(boat.pitch) ? boat.pitch : 0;
  const rollVel = Number.isFinite(boat.rollVelocity) ? boat.rollVelocity : 0;
  const pitchVel = Number.isFinite(boat.pitchVelocity) ? boat.pitchVelocity : 0;

  if (!state) {
    state = {
      active: 1,
      swayX: ropeWaveClamp(-Math.sin(roll) - 0.35 * rollVel, -0.85, 0.85),
      swayZ: ropeWaveClamp(Math.sin(pitch) + 0.35 * pitchVel, -0.85, 0.85),
      velX: 0,
      velZ: 0,
      lastRollVel: rollVel,
      lastPitchVel: pitchVel,
      steppedSinceUniform: false,
    };
    vesselRopeChainStates.set(boat, state);
  }

  state.active = 1;

  if (dt > 0 && Number.isFinite(dt)) {
    const clampedDt = Math.min(dt, 0.25);
    const invDt = 1 / Math.max(clampedDt, 1 / 240);
    const rollAccel = ropeWaveClamp((rollVel - state.lastRollVel) * invDt, -8.0, 8.0);
    const pitchAccel = ropeWaveClamp((pitchVel - state.lastPitchVel) * invDt, -8.0, 8.0);
    state.lastRollVel = rollVel;
    state.lastPitchVel = pitchVel;

    // Effective gravity tilt + mast-whip Euler inertial forcing on hanging chains
    const forceX = -Math.sin(roll) - 0.38 * rollVel - 0.22 * rollAccel;
    const forceZ = Math.sin(pitch) + 0.38 * pitchVel + 0.22 * pitchAccel;

    // Underdamped pendulum natural frequency and damping
    const omega0 = 2.85;
    const omega0Sq = omega0 * omega0;
    const damping = 2 * 0.20 * omega0;
    const steps = Math.max(1, Math.min(8, Math.ceil(clampedDt * 120)));
    const h = clampedDt / steps;

    for (let i = 0; i < steps; i++) {
      const ax = omega0Sq * (forceX - state.swayX) - damping * state.velX;
      const az = omega0Sq * (forceZ - state.swayZ) - damping * state.velZ;
      state.velX = ropeWaveClamp(state.velX + ax * h, -3.5, 3.5);
      state.velZ = ropeWaveClamp(state.velZ + az * h, -3.5, 3.5);
      state.swayX = ropeWaveClamp(state.swayX + state.velX * h, -0.85, 0.85);
      state.swayZ = ropeWaveClamp(state.swayZ + state.velZ * h, -0.85, 0.85);
    }
    state.steppedSinceUniform = true;
  }

  return state;
}

/**
 * Resolves the current rope chain state for a vessel. Returns active = 0 for
 * static offline test fixtures that have not been stepped by the simulation.
 */
export function resolveVesselRopeChain(boat) {
  if (!boat || typeof boat !== 'object') {
    return { active: 0, swayX: 0, swayZ: 0 };
  }
  if (boat.ropeChain && typeof boat.ropeChain === 'object') {
    return {
      active: boat.ropeChain.active ? 1 : 0,
      swayX: ropeWaveClamp(boat.ropeChain.swayX ?? 0, -0.85, 0.85),
      swayZ: ropeWaveClamp(boat.ropeChain.swayZ ?? 0, -0.85, 0.85),
    };
  }
  const tracked = vesselRopeChainStates.get(boat);
  // The live state is read back through the packed hull uniform, so crew hands,
  // posed meshes and every shader see one and the same quantised sway.
  if (tracked?.active) {
    return unpackRopeChainUniform(Math.fround(encodeRopeChainFloat(tracked.swayX, tracked.swayZ)));
  }
  return { active: 0, swayX: 0, swayZ: 0 };
}

/**
 * Packs the active chain-pendulum state (swayX, swayZ) into a single positive float
 * for hull.size.z (data[14] in Hull UBO). Values > 0.5 indicate live wave/chain mode.
 * Called once per vessel per frame: it advances the oscillator only when the
 * vessel's own physics step has not already done so since the last call.
 */
export function packRopeChainUniform(boat, dt = 0) {
  if (!boat || typeof boat !== 'object') return 0;
  const state = vesselRopeChainStates.get(boat);
  if (state?.steppedSinceUniform) state.steppedSinceUniform = false;
  else stepVesselRopeChain(boat, dt).steppedSinceUniform = false;
  const chain = resolveVesselRopeChain(boat);
  return chain.active ? encodeRopeChainFloat(chain.swayX, chain.swayZ) : 0;
}

export function encodeRopeChainFloat(swayX = 0, swayZ = 0) {
  const qx = ropeWaveClamp(swayX, -0.85, 0.85);
  const qz = ropeWaveClamp(swayZ, -0.85, 0.85);
  const intPart = ropeWaveClamp(Math.round((qx + 1.0) * 500.0), 1, 999);
  const fracPart = ropeWaveClamp((qz + 1.0) * 0.45 + 0.05, 0.05, 0.95);
  return intPart + fracPart;
}

export function unpackRopeChainUniform(packed = 0, rightY = 0, forwardY = 0) {
  if (packed > 0.5) {
    const intPart = Math.floor(packed);
    const fracPart = packed - intPart;
    return {
      active: 1,
      swayX: (intPart - 500.0) * 0.002,
      swayZ: (fracPart - 0.5) / 0.45,
    };
  }
  if (Math.abs(rightY) + Math.abs(forwardY) > 1e-4) {
    return {
      active: 1,
      swayX: ropeWaveClamp(-rightY, -0.85, 0.85),
      swayZ: ropeWaveClamp(forwardY, -0.85, 0.85),
    };
  }
  return { active: 0, swayX: 0, swayZ: 0 };
}

/**
 * Evaluates the 3 spatial normal modes (n = 1, 2, 3) of the damped 1D wave equation
 * and hanging-chain pendulum perpendicular to the rope chord (b - a).
 */
export function computeRopeWaveModes(a, b, index, compliance, swayX, swayZ, time, wind) {
  const dx = b[0] - a[0];
  const dy = b[1] - a[1];
  const dz = b[2] - a[2];
  const span = Math.hypot(dx, dy, dz);
  if (!(span > 1e-4) || !(compliance > 0)) {
    return { mode1: [0, 0, 0], mode2: [0, 0, 0], mode3: [0, 0, 0] };
  }
  const dir = [dx / span, dy / span, dz / span];
  const vertical = Math.abs(dir[1]) > 0.9;
  const refX = vertical ? 1.0 : 0.0;
  const refY = vertical ? 0.0 : 1.0;
  const cx = -dir[2] * refY;
  const cy = dir[2] * refX;
  const cz = dir[0] * refY - dir[1] * refX;
  const cLen = Math.max(1e-12, Math.hypot(cx, cy, cz));
  const across = [cx / cLen, cy / cLen, cz / cLen];
  const normalPerp = [
    dir[1] * across[2] - dir[2] * across[1],
    dir[2] * across[0] - dir[0] * across[2],
    dir[0] * across[1] - dir[1] * across[0],
  ];

  const midY = ropeWaveClamp((a[1] + b[1]) * 0.5, 0.4, 12.0);
  const leverage = 0.55 + 0.085 * midY;
  const effSpan = ropeWaveClamp(span, 0.35, 6.5);

  const waveSpeed = ropeWaveClamp(0.18 / Math.sqrt(Math.max(compliance, 0.008)), 0.9, 2.4);
  const omega1 = (2.15 * waveSpeed) / Math.sqrt(effSpan);
  const omega2 = omega1 * 2.06;
  const omega3 = omega1 * 3.18;
  const phase = index * 1.618034 + (a[2] + b[2]) * 0.37;
  const windFactor = ropeWaveClamp(wind / 12.0, 0.15, 1.35);

  const horizRatio = Math.sqrt(Math.max(0.0, 1.0 - dir[1] * dir[1]));
  const dynSag = compliance * effSpan * horizRatio * (0.28 + 0.08 * Math.sin(time * omega1 + phase));
  const rawX = swayX * leverage * effSpan * compliance * 1.35;
  const rawY = -dynSag;
  const rawZ = swayZ * leverage * effSpan * compliance * 1.35;
  const rawDot = rawX * dir[0] + rawY * dir[1] + rawZ * dir[2];
  const pendX = rawX - dir[0] * rawDot;
  const pendY = rawY - dir[1] * rawDot;
  const pendZ = rawZ - dir[2] * rawDot;

  const w1 = compliance * effSpan * (0.22 * windFactor);
  const s1 = w1 * Math.sin(time * omega1 + phase);
  const c1 = w1 * 0.65 * Math.cos(time * (omega1 * 0.87) + phase * 1.3);
  const mode1 = [
    pendX + across[0] * s1 + normalPerp[0] * c1,
    pendY + across[1] * s1 + normalPerp[1] * c1,
    pendZ + across[2] * s1 + normalPerp[2] * c1,
  ];

  const whipAmp = compliance * effSpan * (0.14 * windFactor + 0.28 * (Math.abs(swayX) + Math.abs(swayZ)));
  const c2 = whipAmp * Math.cos(time * omega2 - phase * 1.7);
  const s2 = whipAmp * 0.75 * Math.sin(time * omega2 + phase * 0.9);
  const mode2 = [
    across[0] * c2 + normalPerp[0] * s2,
    across[1] * c2 + normalPerp[1] * s2,
    across[2] * c2 + normalPerp[2] * s2,
  ];

  const rippleAmp = compliance * effSpan * (0.055 * windFactor);
  const s3 = rippleAmp * Math.sin(time * omega3 - phase * 2.3);
  const c3 = rippleAmp * 0.5 * Math.cos(time * omega3 + phase * 1.5);
  const mode3 = [
    across[0] * s3 + normalPerp[0] * c3,
    across[1] * s3 + normalPerp[1] * c3,
    across[2] * s3 + normalPerp[2] * c3,
  ];

  return { mode1, mode2, mode3 };
}

export function evaluateRopeWaveDisplacement(a, b, t, index, compliance, swayX, swayZ, time, wind) {
  const s = ropeWaveClamp(t, 0.0, 1.0);
  if (s <= 0.0 || s >= 1.0 || !(compliance > 0)) return [0, 0, 0];
  const { mode1, mode2, mode3 } = computeRopeWaveModes(a, b, index, compliance, swayX, swayZ, time, wind);
  const h1 = Math.sin(Math.PI * s);
  const h2 = Math.sin(2.0 * Math.PI * s);
  const h3 = Math.sin(3.0 * Math.PI * s);
  return [
    mode1[0] * h1 + mode2[0] * h2 + mode3[0] * h3,
    mode1[1] * h1 + mode2[1] * h2 + mode3[1] * h3,
    mode1[2] * h1 + mode2[2] * h2 + mode3[2] * h3,
  ];
}

export const ROPE_WAVE_WGSL = /* wgsl */ `
struct RopeWaveModes {
  mode1: vec3f,
  mode2: vec3f,
  mode3: vec3f,
};
struct RopeChainState {
  enabled: f32,
  swayX: f32,
  swayZ: f32,
};
fn computeRopeWaveModes(
  a: vec3f,
  b: vec3f,
  index: f32,
  compliance: f32,
  swayX: f32,
  swayZ: f32,
  time: f32,
  wind: f32
) -> RopeWaveModes {
  let chord = b - a;
  let span = length(chord);
  if (span <= 1e-4 || compliance <= 0.0) {
    return RopeWaveModes(vec3f(0.0), vec3f(0.0), vec3f(0.0));
  }
  let dir = chord / span;
  let refAxis = select(vec3f(0.0, 1.0, 0.0), vec3f(1.0, 0.0, 0.0), abs(dir.y) > 0.9);
  let rawAcross = cross(dir, refAxis);
  let across = rawAcross / max(1e-12, length(rawAcross));
  let normalPerp = cross(dir, across);

  let midY = clamp((a.y + b.y) * 0.5, 0.4, 12.0);
  let leverage = 0.55 + 0.085 * midY;
  let effSpan = clamp(span, 0.35, 6.5);

  let waveSpeed = clamp(0.18 / sqrt(max(compliance, 0.008)), 0.9, 2.4);
  let omega1 = (2.15 * waveSpeed) / sqrt(effSpan);
  let omega2 = omega1 * 2.06;
  let omega3 = omega1 * 3.18;
  let phase = index * 1.618034 + (a.z + b.z) * 0.37;
  let windFactor = clamp(wind / 12.0, 0.15, 1.35);

  let horizRatio = sqrt(max(0.0, 1.0 - dir.y * dir.y));
  let dynSag = compliance * effSpan * horizRatio * (0.28 + 0.08 * sin(time * omega1 + phase));
  let rawPendulum = vec3f(
    swayX * leverage * effSpan * compliance * 1.35,
    -dynSag,
    swayZ * leverage * effSpan * compliance * 1.35
  );
  let pendulumPerp = rawPendulum - dir * dot(rawPendulum, dir);

  let w1 = compliance * effSpan * (0.22 * windFactor);
  let s1 = w1 * sin(time * omega1 + phase);
  let c1 = w1 * 0.65 * cos(time * (omega1 * 0.87) + phase * 1.3);
  let mode1 = pendulumPerp + across * s1 + normalPerp * c1;

  let whipAmp = compliance * effSpan * (0.14 * windFactor + 0.28 * (abs(swayX) + abs(swayZ)));
  let c2 = whipAmp * cos(time * omega2 - phase * 1.7);
  let s2 = whipAmp * 0.75 * sin(time * omega2 + phase * 0.9);
  let mode2 = across * c2 + normalPerp * s2;

  let rippleAmp = compliance * effSpan * (0.055 * windFactor);
  let s3 = rippleAmp * sin(time * omega3 - phase * 2.3);
  let c3 = rippleAmp * 0.5 * cos(time * omega3 + phase * 1.5);
  let mode3 = across * s3 + normalPerp * c3;

  return RopeWaveModes(mode1, mode2, mode3);
}
fn unpackHullRopeChain(packed: f32, rightY: f32, forwardY: f32) -> RopeChainState {
  if (packed > 0.5) {
    let intPart = floor(packed);
    let fracPart = packed - intPart;
    return RopeChainState(1.0, (intPart - 500.0) * 0.002, (fracPart - 0.5) / 0.45);
  }
  if (abs(rightY) + abs(forwardY) > 1e-4) {
    return RopeChainState(1.0, clamp(-rightY, -0.85, 0.85), clamp(forwardY, -0.85, 0.85));
  }
  return RopeChainState(0.0, 0.0, 0.0);
}
fn evaluateRopeWaveAt(
  a: vec3f,
  b: vec3f,
  t: f32,
  index: f32,
  compliance: f32,
  chain: RopeChainState,
  time: f32,
  wind: f32
) -> vec3f {
  let s = clamp(t, 0.0, 1.0);
  if (chain.enabled <= 0.0 || s <= 0.0 || s >= 1.0 || compliance <= 0.0) {
    return vec3f(0.0);
  }
  let modes = computeRopeWaveModes(a, b, index, compliance * chain.enabled, chain.swayX, chain.swayZ, time, wind);
  let pi = 3.141592653589793;
  return modes.mode1 * sin(pi * s) + modes.mode2 * sin(2.0 * pi * s) + modes.mode3 * sin(3.0 * pi * s);
}
`;

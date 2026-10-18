import { HELM_EYE_Z, HULL_DRAFT, hullHalfWidth } from './hull.js';
import { advanceSails, sailForces } from './sailing.js';

export const KNOT_TO_MPS = 0.514444;
// Displacement of the canonical mesh below its mean waterline, in cubic metres.
// Hull dimensions scale horizontally; its draft currently stays at HULL_DRAFT.
const BOAT_VOLUME = (() => {
  let volume = 0;
  const dz = 12 / 96, dy = HULL_DRAFT / 32;
  for (let z = 0; z < 96; z++) for (let y = 0; y < 32; y++) {
    volume += 2 * hullHalfWidth(-6.4 + (z + 0.5) * dz, -HULL_DRAFT + (y + 0.5) * dy) * dz * dy;
  }
  return volume;
})();

export function boatHydrodynamics(length, beam) {
  const volume = BOAT_VOLUME * length / 12 * beam / 3.6;
  const mass = 1025 * volume;
  // Authored effective coefficients, not a calibrated resistance curve.
  const wettedArea = 0.85 * length * (beam + 2 * HULL_DRAFT);
  return { length, beam, volume, mass, addedMass: mass * 0.08, drag: 0.5 * 1025 * 0.012 * wettedArea };
}

export function boatForwardSpeed(boat) {
  return boat.surgeVelocity ?? (boat.propulsion === 'sail' ? 0 : boat.speed * KNOT_TO_MPS);
}

// World-space, incident-wave slopes arrive in the existing asynchronous probe.
// Never hold an old force indefinitely after a stalled readback or a scene edit.
export function boatWaveSlope(boat, time) {
  const age = time - boat.waveSampleTime;
  if (boat.waveRevision !== boat.revision || !(age >= 0)) return 0;
  const freshness = Math.exp(-Math.max(0, age - 0.25) / 0.25);
  const heading = boat.heading * Math.PI / 180;
  return (boat.waveSlopeX * Math.sin(heading) - boat.waveSlopeZ * Math.cos(heading)) * freshness;
}

// Long-wave Froude–Krylov approximation: F = -rho*g*volume*mean(wave slope).
// Sailing uses apparent-wind forces; manual mode retains the calm-water thrust.
// Both integrate through vessel inertia, resistance and incident-wave pressure.
export function stepBoatSurge(boat, slope, dt, windSpeed = 0, windDirection = 0) {
  boat.leewayDistance = 0;
  boat.leewayVelocity ??= 0;
  boat.sailHeel ??= 0;
  if (!(dt > 0) || !Number.isFinite(dt)) return 0;
  let hydro = boat.hydrodynamics;
  if (!hydro || hydro.length !== boat.length || hydro.beam !== boat.beam) {
    hydro = boat.hydrodynamics = boatHydrodynamics(boat.length, boat.beam);
  }
  const inertia = hydro.mass + hydro.addedMass;
  const sailing = boat.propulsion === 'sail';
  advanceSails(boat, dt, windSpeed, windDirection);
  const target = boat.speed * KNOT_TO_MPS;
  const thrust = hydro.drag * target * Math.abs(target);
  const waveForce = -1025 * 9.81 * hydro.volume * slope;
  const initial = boatForwardSpeed(boat);
  let velocity = initial, distance = 0, sideways = boat.leewayVelocity ?? 0, sidewaysDistance = 0;
  const steps = Math.ceil(dt * 120), h = dt / steps;
  for (let i = 0; i < steps; i++) {
    const loads = sailing ? sailForces(boat, windSpeed, windDirection, velocity, sideways) : null;
    const force = (loads ? loads.forward : thrust) + waveForce;
    const free = velocity + force / inertia * h;
    const froude = Math.abs(velocity) / Math.sqrt(9.81 * boat.length);
    const drag = hydro.drag * (sailing ? 1 + 80 * Math.max(0, froude - 0.28) ** 2 : 1);
    // Implicit signed quadratic drag: stable through zero and during reversals.
    const next = 2 * free / (1 + Math.sqrt(1 + 4 * drag / inertia * h * Math.abs(free)));
    distance += (velocity + next) * 0.5 * h;
    velocity = next;
    // Keel/hull resistance bounds sideways drift instead of converting it into forward drive.
    const lateralInertia = hydro.mass * 1.8, keelDrag = 0.5 * 1025 * boat.length * HULL_DRAFT * 0.8;
    const lateralFree = sideways + (loads?.side ?? 0) / lateralInertia * h;
    const nextSide = 2 * lateralFree / (1 + Math.sqrt(1 + 4 * keelDrag / lateralInertia * h * Math.abs(lateralFree)));
    sidewaysDistance += (sideways + nextSide) * 0.5 * h; sideways = nextSide;
  }
  boat.surgeVelocity = velocity;
  boat.surgeAcceleration = (velocity - initial) / dt;
  boat.leewayVelocity = sideways; boat.leewayDistance = sidewaysDistance;
  const loads = sailForces(boat, windSpeed, windDirection, velocity, sideways);
  boat.sailHeel = sailing ? -Math.max(-0.42, Math.min(0.42, Math.atan2(loads.side * 5, hydro.mass * 9.81 * boat.beam * 0.22))) : 0;
  return distance;
}

// Approximate rigid hull response to a 3 x 3 grid of actual ocean heights.
export function boatTargets(heights, length, beam) {
  const mean = (a, b, c) => (heights[a] + heights[b] + heights[c]) / 3;
  return {
    heave: heights.reduce((a, b) => a + b, 0) / 9,
    pitch: Math.atan2(mean(6, 7, 8) - mean(0, 1, 2), length),
    roll: Math.atan2(mean(2, 5, 8) - mean(0, 3, 6), beam),
  };
}

// Exact critically damped spring step: stable even when frame rate varies.
export function boatSpring(state, key, target, omega, dt, targetVelocity = 0) {
  const velocity = key + 'Velocity';
  const offset = state[key] - target;
  const relativeVelocity = (state[velocity] || 0) - targetVelocity;
  const c = relativeVelocity + omega * offset;
  const decay = Math.exp(-omega * dt);
  state[key] = target + targetVelocity * dt + (offset + c * dt) * decay;
  state[velocity] = targetVelocity + (relativeVelocity - omega * c * dt) * decay;
}

// Transform a local look vector by hull roll, pitch, then compass heading.
export function boatRotate(out, x, y, z, heading, pitch, roll) {
  const cr = Math.cos(roll), sr = Math.sin(roll);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const ch = Math.cos(heading), sh = Math.sin(heading);
  const xx = cr * x - sr * y, yy = sr * x + cr * y;
  const yp = cp * yy - sp * z, zp = sp * yy + cp * z;
  out[0] = ch * xx - sh * zp; out[1] = yp; out[2] = sh * xx + ch * zp;
}
// Rudder lag and yaw inertia; a simple speed-dependent displacement-hull model.
export function stepBoatSteering(boat, command, dt) {
  boat.rudderTarget = Math.max(-35, Math.min(35, boat.rudderTarget + command * 28 * dt));
  boatSpring(boat, 'rudder', boat.rudderTarget, 9, dt);
  const speed = boatForwardSpeed(boat);
  const desired = speed / Math.max(boat.length, 3) * Math.tan(boat.rudder * Math.PI / 180) * 0.65;
  const previous = boat.yawRate || 0;
  boat.yawRate = desired + (previous - desired) * Math.exp(-dt / (0.9 + boat.length * 0.06));
  boat.heading = ((boat.heading + (previous + boat.yawRate) * 0.5 * dt * 180 / Math.PI) % 360 + 360) % 360;
}

// World-space eye anchor; keeping it separate from the vessel allows inspection.
export function boatEyePosition(out, boat) {
  boatRotate(out, 0, boat.eye, HELM_EYE_Z * boat.length / 12, boat.heading * Math.PI / 180, boat.pitch, boat.roll);
  out[0] += boat.x; out[1] += boat.heave; out[2] += boat.z;
  return out;
}

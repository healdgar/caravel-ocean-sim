import { HELM_EYE_Z } from './hull.js';
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
  const speed = boat.speed * 0.514444;
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

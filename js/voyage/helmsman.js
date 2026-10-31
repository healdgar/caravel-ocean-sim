// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// The helmsman: holds an ordered COMPASS course with the real rudder. Like js/follower.js it is a
// helm policy only – it writes boat.rudderTarget and never sets velocity or heading directly, so
// the hull, sails and waves keep running through the ordinary real-time sailing model even while
// the voyage clock is warped.
//
// Sail trim (yard brace / lateen sheet) is already automatic in js/sailing.js `apparentWind`;
// the helmsman therefore only has to steer. How much canvas is set remains the captain's order.

import { boatForwardSpeed } from '../boat.js';

const HELMSMAN_RAD = Math.PI / 180;
const helmsmanWrap = (a) => Math.atan2(Math.sin(a), Math.cos(a));
const helmsmanWrap360 = (d) => ((d % 360) + 360) % 360;
const helmsmanClamp = (v, a, b) => Math.max(a, Math.min(b, v));

/** Canvas orders a 1550 master would give, as fractions for [fore, main, mizzen]. */
export const CANVAS_ORDERS = Object.freeze({
  full: Object.freeze({ id: 'full', label: 'All plain sail', sails: Object.freeze([1, 1, 1]) }),
  reduced: Object.freeze({ id: 'reduced', label: 'Shorten sail', sails: Object.freeze([0.6, 0.6, 0.5]) }),
  storm: Object.freeze({ id: 'storm', label: 'Storm canvas', sails: Object.freeze([0.3, 0.25, 0]) }),
  hove: Object.freeze({ id: 'hove', label: 'Heave to', sails: Object.freeze([0.25, 0, 0.35]) }),
  furl: Object.freeze({ id: 'furl', label: 'Strike all sail', sails: Object.freeze([0, 0, 0]) }),
});

/** Closest a hull will lie to the true wind with way on (degrees), by rig type. */
export function closestPointOfSail(modelId) {
  const table = { nina: 58, pinta: 62, 'santa-maria': 67, victory: 66, oseberg: 70, lusoria: 75, 'taino-canoe': 80, 'flying-cloud': 60, 'gipsy-moth-iv': 42 };
  return table[modelId] ?? 64;
}

export function createHelmsman({ compassCourse = 0, engaged = true } = {}) {
  return {
    engaged,
    compassCourse: helmsmanWrap360(compassCourse),
    trueCourse: helmsmanWrap360(compassCourse),
    steeredTrue: helmsmanWrap360(compassCourse),
    tack: 0, // +1 wind on starboard side of the bow, −1 larboard, 0 not beating
    beat: false, // tack automatically toward the ordered course when it lies upwind
    beatLegHours: 4,
    legGameSeconds: 0,
    helmTrim: 0,
    ironsTime: 0,
    recovering: false,
    status: 'Steady as she goes',
    canLieCourse: true,
  };
}

/** Order a new compass course (degrees magnetic). */
export function orderCourse(state, compassCourse, { beat = state.beat } = {}) {
  state.compassCourse = helmsmanWrap360(compassCourse);
  state.beat = Boolean(beat);
  state.engaged = true;
  state.legGameSeconds = 0;
  state.recovering = false;
  return state;
}

/** Come about onto the other tack (when close-hauled). */
export function orderTack(state) {
  state.tack = state.tack ? -state.tack : 1;
  state.legGameSeconds = 0;
  return state;
}

/**
 * Steer one real-time step.
 * @param {object} state  helmsman state
 * @param {object} boat   live vessel (heading deg true, yawRate rad/s, surge/leeway velocities)
 * @param {number} dt     real seconds
 * @param {object} env    { windSpeed m/s, windDirection rad (renderer propagation θ), variation deg,
 *                          gameDt seconds of voyage time elapsed (for beat legs) }
 */
export function steerHelmsman(state, boat, dt, { windSpeed = 7, windDirection = 0, variation = 0, gameDt = dt } = {}) {
  if (!state.engaged) return state;
  dt = Number.isFinite(dt) ? helmsmanClamp(dt, 0, 0.25) : 0;
  const speedRaw = boatForwardSpeed(boat);
  const speed = Number.isFinite(speedRaw) ? speedRaw : 0;
  const heading = (boat.heading ?? 0) * HELMSMAN_RAD;
  // The compass reads magnetic; the hull turns in true bearings. true = magnetic + variation(E+).
  const desired = helmsmanWrap360(state.compassCourse + variation);
  state.trueCourse = desired;
  const windFrom = Math.atan2(-Math.cos(windDirection), Math.sin(windDirection));
  const noGo = closestPointOfSail(boat.modelId) * HELMSMAN_RAD;
  let course = desired * HELMSMAN_RAD;
  const relative = helmsmanWrap(course - windFrom);
  state.canLieCourse = !(Math.abs(relative) < noGo && windSpeed > 0.6);
  if (!state.canLieCourse) {
    if (!state.tack) state.tack = Math.sign(helmsmanWrap(heading - windFrom)) || Math.sign(relative) || 1;
    if (state.beat) {
      state.legGameSeconds += gameDt;
      if (state.legGameSeconds >= state.beatLegHours * 3600) {
        state.tack = -state.tack;
        state.legGameSeconds = 0;
      }
    }
    course = windFrom + state.tack * noGo;
    state.status = state.beat ? `Beating to windward on the ${state.tack > 0 ? 'starboard' : 'larboard'} tack` : 'Close-hauled · she will not lie the course';
  } else {
    state.tack = 0;
    state.legGameSeconds = 0;
    state.status = 'Steady as she goes';
  }

  // In irons: bear away to a beam reach on the chosen side before trying again.
  state.ironsTime = Math.abs(helmsmanWrap(heading - windFrom)) < 42 * HELMSMAN_RAD && speed < 0.35 ? state.ironsTime + dt : 0;
  if (!state.recovering && state.ironsTime > 4) state.recovering = true;
  if (state.recovering && speed > 0.45 && Math.abs(helmsmanWrap(heading - windFrom)) > 75 * HELMSMAN_RAD) state.recovering = false;
  let rudder;
  if (state.recovering) {
    const side = state.tack || Math.sign(helmsmanWrap(heading - windFrom)) || 1;
    course = windFrom + side * 100 * HELMSMAN_RAD;
    rudder = helmsmanClamp((helmsmanWrap(course - heading) / HELMSMAN_RAD) * 1.4, -35, 35) * (speed < -0.12 ? -1 : 1);
    state.helmTrim = 0;
    state.status = 'In irons · bearing away';
  } else {
    const clampedSway = speed > 0.5 && Number.isFinite(boat.leewayVelocity)
      ? helmsmanClamp(boat.leewayVelocity, -speed * 0.08, speed * 0.08)
      : 0;
    const leewayRad = speed > 0.5 ? Math.atan2(clampedSway, speed) : 0;
    const error = helmsmanWrap(course - leewayRad - heading) / HELMSMAN_RAD;
    const damping = ((boat.yawRate ?? 0) / HELMSMAN_RAD) * 5;
    const before = error * 1.1 - damping + state.helmTrim;
    if (speed > 0.4 && Math.abs(error) < 35 && (Math.abs(before) < 35 || Math.sign(before) !== Math.sign(error))) {
      state.helmTrim = helmsmanClamp(state.helmTrim + error * 0.06 * dt, -20, 20);
    } else if (speed <= 0.4) {
      state.helmTrim *= Math.exp(-dt * 0.1);
    }
    rudder = helmsmanClamp(error * 1.1 - damping + state.helmTrim, -35, 35);
    if (speed < -0.12) rudder = -rudder;
    if (speed > 0.4 && Number.isFinite(boat.steeringLoadAcceleration) && Number.isFinite(boat.steeringResponse)) {
      // Same flow-gated inversion of the measured helm response as the follower policy.
      const blend = 1 - Math.exp(-dt * 2);
      state.loadAcceleration = (state.loadAcceleration ?? boat.steeringLoadAcceleration) + (boat.steeringLoadAcceleration - (state.loadAcceleration ?? boat.steeringLoadAcceleration)) * blend;
      const rate = boat.yawRate ?? 0, targetRate = helmsmanClamp((error * HELMSMAN_RAD) / 15, -0.035, 0.035);
      const requested = rate + boat.steeringResponse * ((targetRate - rate) * 0.5 - state.loadAcceleration);
      rudder = helmsmanClamp(Math.atan((requested * Math.max(boat.length ?? 20, 3)) / (speed * 0.65)) / HELMSMAN_RAD, -35, 35);
      state.helmTrim *= Math.exp(-dt * 0.5);
    }
  }
  state.steeredTrue = helmsmanWrap360(course / HELMSMAN_RAD);
  boat.propulsion = 'sail';
  boat.rudderTarget = rudder;
  return state;
}

/** Apply a canvas order to the boat's sail controls (respects damaged masts). */
export function applyCanvasOrder(boat, orderId) {
  const order = CANVAS_ORDERS[orderId] ?? CANVAS_ORDERS.full;
  const groups = ['fore', 'main', 'mizzen'];
  const keys = ['sailFore', 'sailMain', 'sailMizzen'];
  keys.forEach((key, i) => {
    const cap = boat.damage?.sunk ? 0 : boat.damage?.mastIntegrity?.[groups[i]] ?? 1;
    boat[key] = Math.min(order.sails[i], cap);
  });
  return order;
}

/**
 * Advice from the sailing master when canvas does not suit the wind (Beaufort-based).
 * Returns null when the set canvas is seamanlike.
 */
export function canvasAdvice(orderId, windSpeed) {
  if (windSpeed >= 24 && orderId !== 'storm' && orderId !== 'hove' && orderId !== 'furl') return { severity: 'danger', text: 'A storm is upon us — strike the topsails and lie under storm canvas, or heave to!' };
  if (windSpeed >= 17 && orderId === 'full') return { severity: 'warning', text: 'It blows a gale, Captain. She is overpressed — shorten sail before we spring a spar.' };
  if (windSpeed <= 6 && (orderId === 'reduced' || orderId === 'storm')) return { severity: 'info', text: 'The wind has moderated. Shall we make all plain sail?' };
  return null;
}

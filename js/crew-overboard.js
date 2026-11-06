// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// A body that clears the rail leaves the ship. It falls to the sea, stays where the sea is
// while she moves on, and drowns unless she comes back for it. Few sailors of the age could
// swim, so nobody survives long. Everything here is in metres, in the world frame or hers.
import { boatRotate } from './boat.js';
import { modelDeck, modelHullDeck, modelDeckWidth, vesselVerticalScale } from './hull.js';
import { gltfTRS } from './gltf.js';
import { fractureSideTop } from './ship-fracture.js';

const OVERBOARD_GRAVITY = 9.81;
const OVERBOARD_DEFAULT_RAIL_M = 1;
const OVERBOARD_BODY_CENTRE_M = 0.7;
const OVERBOARD_MIN_CLIMB_M = 0.25;
const OVERBOARD_AWASH_ALIVE_M = 0.2;
const OVERBOARD_AWASH_DEAD_M = 0.3;
const OVERBOARD_DRIFT_MPS = 0.18;
const OVERBOARD_LAUNCH_LIMIT_MPS = 5;
const OVERBOARD_FLOAT_Y = -0.05;
// How long a man lasts in the water, whole or hurt, in seconds of real time at sea.
export const OVERBOARD_DROWN_SECONDS = 150;
export const OVERBOARD_DROWN_WOUNDED_SECONDS = 50;
// A line reaches this far, once she has slowed enough to get one across and haul on it.
export const OVERBOARD_RESCUE_RANGE_M = 28;
export const OVERBOARD_RESCUE_SPEED_MPS = 1.6;
export const OVERBOARD_RESCUE_SECONDS = 6;
const OVERBOARD_LOST_RANGE_M = 450;
// Nothing left above the deck to this height is no rail at all, and a hand keeps this far from such an edge.
const OPEN_EDGE_RAIL_M = 0.5;
const OPEN_EDGE_KEEP_M = 0.45;
// A body is out of sight of the deck this long after it stops moving.
const OVERBOARD_BODY_FLOATS_SECONDS = 90;
// Gale knockdowns, per exposed hand per second at unit severity.
const GALE_KNOCKDOWN_RATE = 0.0005;

function overboardBasis(boat) {
  const yaw = ((boat.heading ?? 0) * Math.PI) / 180, pitch = boat.pitch ?? 0, roll = boat.roll ?? 0;
  const ax = [0, 0, 0], ay = [0, 0, 0], az = [0, 0, 0];
  boatRotate(ax, 1, 0, 0, yaw, pitch, roll);
  boatRotate(ay, 0, 1, 0, yaw, pitch, roll);
  boatRotate(az, 0, 0, 1, yaw, pitch, roll);
  return { ax, ay, az };
}
const overboardDot = (a, x, y, z) => a[0] * x + a[1] * y + a[2] * z;

// Height of the rail above the deck at a station, in metres. An open hull's gunwale is
// its shell; a decked ship's is her bulwark. Given a side, only what is left of it there counts.
export function crewRailAboveDeck(boat, zDesign, side = 0) {
  const vertical = vesselVerticalScale(boat);
  const deck = modelDeck(boat, zDesign) * vertical, shell = modelHullDeck(boat, zDesign) * vertical;
  const rail = shell > deck + 0.2 ? shell - deck : OVERBOARD_DEFAULT_RAIL_M;
  if (!side || !boat.damage?.fracture?.brokenCount) return rail;
  const left = fractureSideTop(boat.damage.fracture, side, zDesign, (z) => modelDeck(boat, z));
  return left === null ? rail : Math.max(0, Math.min(rail, left * vertical - deck));
}

// How much of the deck's width, in design units, a hand gives up beside an open edge. Zero where she has her
// rail, however low she was built. A boat's gunwale is open only once it has lost half its height.
export function crewOpenEdgeInset(boat, zDesign, side) {
  const state = boat.damage?.fracture;
  if (!state?.brokenCount || !side) return 0;
  if (fractureSideTop(state, side, zDesign, (z) => modelDeck(boat, z)) === null) return 0;
  const left = crewRailAboveDeck(boat, zDesign, side), built = crewRailAboveDeck(boat, zDesign);
  return left < Math.min(OPEN_EDGE_RAIL_M, built * 0.5) ? OPEN_EDGE_KEEP_M / ((boat.beam ?? 3.6) / 3.6) : 0;
}

// Does a body moving outward this fast go over rather than strike the rail and drop? Heel
// to that side helps it, and heel away from that side is a climb. Positive roll lifts starboard.
export function crewClearsRail(boat, zDesign, side, outwardMetresPerSecond) {
  if (!(outwardMetresPerSecond > 0)) return false;
  const lean = -Math.sin(boat.roll ?? 0) * side * (boat.beam ?? 3.6) * 0.5;
  // Even a low rail stops a stumble on a level deck. Heel down to it takes that away, and so does a shot.
  const rail = crewRailAboveDeck(boat, zDesign, side);
  const floor = Math.max(0.03, Math.min(OVERBOARD_MIN_CLIMB_M, rail) - Math.max(0, lean));
  const climb = Math.max(floor, rail - OVERBOARD_BODY_CENTRE_M - lean);
  return outwardMetresPerSecond >= Math.sqrt(2 * OVERBOARD_GRAVITY * climb);
}

// A man over the side counts as lost at once, and is restored if he is hauled back in.
function overboardCountLost(boat, s) {
  const c = boat?.damage?.crewCasualties;
  if (!c) return;
  if (s.casualtyState === 'fallen') return;
  if (s.casualtyState === 'wounded') c.wounded = Math.max(0, (c.wounded ?? 0) - 1);
  c.killed = (c.killed ?? 0) + 1;
  c.able = Math.max(0, (c.total ?? 0) - c.killed - (c.wounded ?? 0));
}

export function sendCrewOverboard(boat, s, { side = Math.sign(s.x || 1) || 1, outward = 2.5, cause = 'blast', dead = false, hurt = false } = {}) {
  if (!boat || !s?.position || s.overboard) return null;
  const alive = !dead && s.casualtyState !== 'fallen';
  const wounded = hurt || s.casualtyState === 'wounded';
  overboardCountLost(boat, s);
  const { ax, ay, az } = overboardBasis(boat);
  const [lx, ly, lz] = s.position;
  const launchX = lx + side * 0.3, launch = Math.min(outward, OVERBOARD_LAUNCH_LIMIT_MPS);
  s.overboard = {
    x: (boat.x ?? 0) + launchX * ax[0] + ly * ay[0] + lz * az[0],
    y: (boat.heave ?? 0) + launchX * ax[1] + ly * ay[1] + lz * az[1],
    z: (boat.z ?? 0) + launchX * ax[2] + ly * ay[2] + lz * az[2],
    vx: side * launch * ax[0], vy: 1.4, vz: side * launch * ax[2],
    age: 0, afloat: 0, inWater: false, alive, wounded, side, cause, hauling: 0, gone: false,
    drownAt: alive ? (wounded ? OVERBOARD_DROWN_WOUNDED_SECONDS : OVERBOARD_DROWN_SECONDS) : 0,
    heading: boat.heading ?? 0,
  };
  s.casualtyState = 'fallen';
  s.health = alive ? Math.max(0.2, s.health ?? 1) : 0;
  s.job = null;
  s.seatedPose = null;
  s.knockbackVx = 0;
  s.knockbackVz = 0;
  s.knockdownTimer = 0;
  boat.crewEvents?.({ type: 'overboard', sailor: s, alive, side, cause, position: [s.overboard.x, s.overboard.y, s.overboard.z] });
  return s.overboard;
}

// Brings him back aboard at the rail on his own side, hurt.
function overboardHaulIn(boat, s) {
  const c = boat?.damage?.crewCasualties;
  if (c) {
    c.killed = Math.max(0, (c.killed ?? 0) - 1);
    c.wounded = (c.wounded ?? 0) + 1;
    c.able = Math.max(0, (c.total ?? 0) - c.killed - c.wounded);
  }
  const side = s.overboard.side;
  s.overboard = null;
  s.casualtyState = 'wounded';
  s.health = Math.min(s.health ?? 0.5, 0.55);
  s.woundSeverity = Math.max(s.woundSeverity ?? 0, 0.45);
  s.climbPitch = 0;
  s.x = side * Math.max(0.2, modelDeckWidth(boat, s.z ?? 0) - 0.4);
  s.navigationY = null;
  s.navigationPath = null;
  s.navigationKey = null;
  if (s.ragdoll) s.ragdoll.active = false;
  boat.crewEvents?.({ type: 'hauled-aboard', sailor: s });
}

// Runs in place of everything a sailor on deck would do this step. Writes where he now is in
// her frame, since that is where the crew are drawn.
export function stepCrewOverboard(boat, s, dt) {
  const o = s.overboard;
  if (!o || o.gone) return;
  o.age += dt;
  const boatX = boat.x ?? 0, boatZ = boat.z ?? 0;
  if (!o.inWater) {
    o.vy -= OVERBOARD_GRAVITY * dt;
    o.y += o.vy * dt;
    o.x += o.vx * dt;
    o.z += o.vz * dt;
    if (o.y <= OVERBOARD_FLOAT_Y) {
      o.y = OVERBOARD_FLOAT_Y;
      o.vx = o.vy = o.vz = 0;
      o.inWater = true;
      boat.crewEvents?.({ type: 'overboard-splash', sailor: s, position: [o.x, 0, o.z] });
    }
  } else {
    o.afloat += dt;
    // Wind and sea carry him a little, and much less than they carry a hull.
    o.x += Math.sin(o.age * 0.11) * OVERBOARD_DRIFT_MPS * dt;
    o.z += Math.cos(o.age * 0.07) * OVERBOARD_DRIFT_MPS * dt;
    o.y = OVERBOARD_FLOAT_Y + Math.sin(o.age * 1.3 + (s.crewIndex ?? 0)) * 0.05;
    const range = Math.hypot(o.x - boatX, o.z - boatZ);
    if (o.alive && o.afloat >= o.drownAt) {
      o.alive = false;
      boat.crewEvents?.({ type: 'drowned', sailor: s });
    }
    if (o.alive) {
      const speed = Math.hypot(boat.surgeVelocity ?? 0, boat.leewayVelocity ?? 0);
      o.hauling = range <= OVERBOARD_RESCUE_RANGE_M && speed <= OVERBOARD_RESCUE_SPEED_MPS ? o.hauling + dt : 0;
      if (o.hauling >= OVERBOARD_RESCUE_SECONDS && !boat.damage?.sunk) {
        overboardHaulIn(boat, s);
        return;
      }
    }
    if (range > OVERBOARD_LOST_RANGE_M || (!o.alive && o.afloat > o.drownAt + OVERBOARD_BODY_FLOATS_SECONDS)) {
      if (o.alive) boat.crewEvents?.({ type: 'drowned', sailor: s });
      o.alive = false;
      o.gone = true;
      s.visibleBeforeOverboard = s.visible;
      s.visible = false;
      if (s.ragdoll) s.ragdoll.active = false;
      return;
    }
  }
  const { ax, ay, az } = overboardBasis(boat);
  const dx = o.x - boatX, dy = o.y - (boat.heave ?? 0), dz = o.z - boatZ;
  const lx = overboardDot(ax, dx, dy, dz), ly = overboardDot(ay, dx, dy, dz), lz = overboardDot(az, dx, dy, dz);
  const sx = (boat.beam ?? 3.6) / 3.6, sz = (boat.length ?? 12) / 12, sy = vesselVerticalScale(boat) || 1;
  s.position[0] = lx;
  s.position[1] = ly;
  s.position[2] = lz;
  s.x = lx / sx;
  s.z = lz / sz;
  // The ragdoll lies on whatever this says is the floor. A body floats nearly awash, with little
  // more than the back or head showing, and a man still alive holds himself a little higher.
  s.navigationY = (ly - (o.alive ? OVERBOARD_AWASH_ALIVE_M : OVERBOARD_AWASH_DEAD_M)) / sy;
  s.walk = 0;
  s.brace = 0;
  // The crew are drawn from this matrix, which the deck step would otherwise have written.
  s.yaw = s.collapseYaw ?? s.yaw ?? 0;
  s.climbPitch = (s.fallDir ?? 1) * Math.PI * 0.47;
  if (s.transform && s.rotation) {
    const sinYaw = Math.sin(s.yaw / 2), cosYaw = Math.cos(s.yaw / 2), sinPitch = Math.sin(s.climbPitch / 2), cosPitch = Math.cos(s.climbPitch / 2);
    s.rotation.set([cosYaw * sinPitch, sinYaw * cosPitch, -sinYaw * sinPitch, cosYaw * cosPitch]);
    gltfTRS(s.transform, s.position, s.rotation, s.scale);
  }
}

// Repeatable from the company's own seed, so one gale plays the same way twice.
function galeRandom(company) {
  company.galeSeed = (Math.imul(company.galeSeed ?? 0x2f6e2b1, 1664525) + 1013904223) >>> 0;
  return company.galeSeed / 4294967296;
}

// Heavy weather knocks hands off their feet to leeward, where the rail decides the rest.
export function stepGaleKnockdowns(boat, company, wind, dt, random = () => galeRandom(company)) {
  const heel = Math.abs(boat.roll ?? 0);
  const severity = Math.max(0, (wind - 22) / 8) + Math.max(0, (heel - 0.3) / 0.25);
  if (!(severity > 0) || !(dt > 0)) return;
  const lee = (boat.roll ?? 0) >= 0 ? -1 : 1;
  const chance = GALE_KNOCKDOWN_RATE * severity * severity * dt;
  for (const s of company.crew) {
    if (s.overboard || s.casualtyState === 'fallen' || (s.knockdownTimer ?? 0) > 0 || s.visible === false || s.seatedPose) continue;
    // A hand with something to hold on to is twice as hard to shift.
    if (random() >= chance * ((s.brace ?? 0) > 0.3 ? 0.5 : 1)) continue;
    s.knockdownTimer = 1.6;
    s.fallDir = lee;
    s.knockbackVx = lee * (1.5 + severity * 1.8);
    s.knockbackVz = 0;
  }
}

// The same loss when time is passing too fast to watch it: one hand gone, no body to see.
export function loseHandInGale(boat, company, random = Math.random) {
  const hands = (company?.crew ?? []).filter((s) => !s.overboard && s.casualtyState !== 'fallen' && s.visible !== false && s.position);
  const c = boat?.damage?.crewCasualties;
  if (!hands.length) {
    if (!c || !(c.able > 0)) return null;
    c.killed = (c.killed ?? 0) + 1;
    c.able = Math.max(0, (c.total ?? 0) - c.killed - (c.wounded ?? 0));
    return { abstract: true };
  }
  const s = hands[Math.floor(random() * hands.length)];
  overboardCountLost(boat, s);
  s.casualtyState = 'fallen';
  s.health = 0;
  s.job = null;
  s.seatedPose = null;
  s.overboard = { x: 0, y: OVERBOARD_FLOAT_Y, z: 0, vx: 0, vy: 0, vz: 0, age: 0, afloat: 0, alive: false, wounded: false, side: 1, cause: 'gale', hauling: 0, gone: true, drownAt: 0, heading: 0 };
  s.visibleBeforeOverboard = s.visible;
  s.visible = false;
  return { sailor: s };
}

export function clearCrewOverboard(s) {
  if (s.overboard?.gone && s.visibleBeforeOverboard !== undefined) s.visible = s.visibleBeforeOverboard;
  s.visibleBeforeOverboard = undefined;
  s.overboard = null;
}

// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// A mast section takes whoever is on it, and so does the loss of what a runner's foot stands on. A hand comes
// away and lands where that leaves him: over the side, or on her deck from however high he was. Metres, in her frame.
import { gltfTRS } from './gltf.js';
import { modelDeckWidth, vesselVerticalScale } from './hull.js';
import { crewDeckHeight, crewMastName, crewMastTop, crewRunnerFootGone, crewRunnerGone } from './crew-work.js';
import { sendCrewOverboard } from './crew-overboard.js';
import { recordCrewWound } from './crew-wounds.js';

const ALOFT_GRAVITY = 9.81;
// A section throws a body off harder the further it is above the break.
const ALOFT_THROW_MPS = 1;
const ALOFT_THROW_PER_METRE = 0.5;
const ALOFT_THROW_LIMIT_MPS = 5;
// Below the first of these a fall only knocks him down. Above the second it kills him on the deck.
export const ALOFT_FALL_HURT_M = 2.2;
export const ALOFT_FALL_FATAL_M = 7;
// Water is no softer from this high.
export const ALOFT_SEA_FATAL_M = 30;

function crewOnMast(j) {
  return (j.kind === 'rig' || j.kind === 'lookout') && ((j.rung ?? 0) > 0 || j.lookoutAtStation || j.stage === 'lookout-approach' || j.stage === 'lookout-return');
}

// Is what he stands on still there? A nest or a footrope stands if it is below the break. Ratlines also
// need their head, which may have been made fast above it.
function crewStillHeld(boat, s, j) {
  if (s.position[1] / vesselVerticalScale(boat) >= crewMastTop(boat, j.mast)) return false;
  return j.lookoutAtStation || j.stage === 'lookout-approach' || j.stage === 'lookout-return' || !crewRunnerGone(boat, j.mast, j.side);
}

export function crewThrowFromMast(boat, s, side, cause) {
  const sx = boat.beam / 3.6, sy = vesselVerticalScale(boat), sz = boat.length / 12, [x, y, z] = s.position;
  const brokenAt = crewMastTop(boat, s.job.mast) * sy, drop = Math.max(0, y - crewDeckHeight(boat, z / sz, x / sx) * sy);
  const throwSpeed = Math.min(ALOFT_THROW_LIMIT_MPS, ALOFT_THROW_MPS + Math.max(0, y - brokenAt) * ALOFT_THROW_PER_METRE);
  const lands = x + side * throwSpeed * Math.sqrt((2 * drop) / ALOFT_GRAVITY), edge = modelDeckWidth(boat, z / sz) * sx;
  s.job = null;
  if (s.observation) s.observation.job = null;
  s.seatedPose = null;
  s.navigationPath = null;
  s.navigationKey = null;
  s.navigationY = null;
  s.walk = 0;
  s.collapseYaw = s.yaw ?? 0;
  s.fallDir = side;
  if (Math.abs(lands) > edge) {
    sendCrewOverboard(boat, s, { side: Math.sign(lands), outward: throwSpeed, cause, dead: y + (boat.heave ?? 0) >= ALOFT_SEA_FATAL_M, hurt: true });
    return;
  }
  s.aloftFall = { vx: side * throwSpeed, vy: 0, drop, before: s.casualtyState, cause };
  // Down as far as everything else aboard is concerned, until he lands and it is known how badly.
  s.casualtyState = 'fallen';
  boat.crewEvents?.({ type: 'falling-from-aloft', sailor: s, drop, cause });
}

// Called each crew step, and does nothing unless a mast has lost something since the last.
export function crewLoseHandsAloft(company, boat) {
  const state = boat.damage?.mastState;
  if (!state) return;
  const seen = (company.mastStageSeen ??= {});
  for (const group in state) {
    const stage = state[group], before = seen[group] ?? 0;
    seen[group] = stage;
    if (stage <= before) continue;
    for (const s of company.crew) {
      const j = s.job;
      if (j && crewOnMast(j) && crewMastName(boat, j.mast) === group && !crewStillHeld(boat, s, j)) crewThrowFromMast(boat, s, boat.damage.mastFallSide?.[group] || Math.sign(s.position[0]) || 1, 'mast-fall');
    }
  }
  if (boat.damage.fracture?.brokenCount) for (const s of company.crew) crewCheckRunnerFoot(boat, s);
}

// The foot of a runner can go with the mast still standing. Slack shrouds hold nobody, and neither does a
// chainwale that has left, so whoever is on either comes off outward.
function crewCheckRunnerFoot(boat, s) {
  const j = s.job;
  if (!j || (j.kind !== 'rig' && j.kind !== 'lookout') || !crewRunnerFootGone(boat, j.mast, j.side)) return;
  if (j.lookoutAtStation || j.stage === 'lookout-approach' || j.stage === 'lookout-return') return;
  const sx = boat.beam / 3.6, outboard = Math.abs(s.position[0]) / sx > modelDeckWidth(boat, s.position[2] / (boat.length / 12)) + 0.02;
  if (!((j.rung ?? 0) > 0) && !outboard) return;
  // Coming down from the top he need not use the side that has gone.
  if (j.lookoutEntry && !crewRunnerGone(boat, j.mast, -j.side)) {
    j.side = -j.side;
    return;
  }
  crewThrowFromMast(boat, s, Math.sign(s.position[0]) || 1, 'shrouds-gone');
}

function crewLandFromAloft(boat, s, f) {
  const c = boat.damage?.crewCasualties, wasWounded = f.before === 'wounded';
  const killed = f.drop >= ALOFT_FALL_FATAL_M, hurt = !killed && f.drop >= ALOFT_FALL_HURT_M;
  s.aloftFall = null;
  if (killed) {
    s.health = 0;
    s.woundSeverity = 1;
    if (c) {
      if (wasWounded) c.wounded = Math.max(0, (c.wounded ?? 0) - 1);
      c.killed = (c.killed ?? 0) + 1;
    }
  } else {
    s.casualtyState = hurt || wasWounded ? 'wounded' : f.before;
    s.knockdownTimer = hurt ? 2.4 : 1.6;
    if (hurt) {
      s.health = Math.max(0.25, (s.health ?? 1) - 0.45);
      s.woundSeverity = Math.min(1, Math.max(0.45, 1 - s.health));
      if (c && !wasWounded) c.wounded = (c.wounded ?? 0) + 1;
      // Wherever he lands on, that limb gives.
      recordCrewWound(s, 'fall', s.position, [0, -1, 0], ((s.crewIndex ?? 0) * 0.7548776662) % 1);
    }
  }
  if (c) c.able = Math.max(0, (c.total ?? 0) - (c.killed ?? 0) - (c.wounded ?? 0));
  boat.crewEvents?.({ type: 'fell-from-aloft', sailor: s, killed, hurt, cause: f.cause });
}

// Runs in place of everything a sailor on deck would do this step, until he lands.
export function stepCrewAloftFall(boat, s, dt) {
  const f = s.aloftFall;
  if (!f) return;
  const sx = boat.beam / 3.6, sy = vesselVerticalScale(boat), sz = boat.length / 12;
  f.vy -= ALOFT_GRAVITY * dt;
  s.position[0] += f.vx * dt;
  s.position[1] += f.vy * dt;
  s.x = s.position[0] / sx;
  s.z = s.position[2] / sz;
  const edge = Math.max(0, modelDeckWidth(boat, s.z) - 0.34 / sx);
  if (Math.abs(s.x) > edge) {
    s.x = Math.sign(s.x) * edge;
    s.position[0] = s.x * sx;
  }
  const deck = crewDeckHeight(boat, s.z, s.x) * sy;
  s.yaw = s.collapseYaw ?? s.yaw ?? 0;
  s.climbPitch = (s.fallDir ?? 1) * Math.PI * 0.47;
  if (s.position[1] <= deck) {
    s.position[1] = deck;
    crewLandFromAloft(boat, s, f);
  }
  if (s.transform && s.rotation) {
    const sinYaw = Math.sin(s.yaw / 2), cosYaw = Math.cos(s.yaw / 2), sinPitch = Math.sin(s.climbPitch / 2), cosPitch = Math.cos(s.climbPitch / 2);
    s.rotation.set([cosYaw * sinPitch, sinYaw * cosPitch, -sinYaw * sinPitch, cosYaw * cosPitch]);
    gltfTRS(s.transform, s.position, s.rotation, s.scale);
  }
}

// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Holes shot right through a hull. Each one lets the sea in according to how far it lies below
// the water right now, so a hole above the waterline floods once she lists or settles, and a
// hole stops flooding once the water inside has risen to meet the sea outside.
import { boatRotate } from './boat.js';

export const HULL_HOLE_LIMIT = 24;
const HULL_HOLE_DISCHARGE = 0.62;
const HULL_HOLE_GRAVITY = 9.81;
const SEA_TONNES_PER_CUBIC_METRE = 1.025;
// Seas slop into a hole this far above the mean surface, and only a part of it at a time.
const HULL_HOLE_WASH_METRES = 0.35;
const HULL_HOLE_WASH_SHARE = 0.18;
const HULL_HOLD_AREA_SHARE = 0.55;
// A carpenter's crew with all hands takes this long to drive a shot plug and nail lead over it.
// Even then it weeps.
const HULL_HOLE_PLUG_SECONDS = 75;
const HULL_HOLE_PLUG_LIMIT = 0.85;

const holeClamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const holeDepthRotation = [0, 0, 0];

// One more ball through about the same place makes the hole bigger, not a new one.
export function addHullHole(damage, { design, local, radius, side, compartment }) {
  const holes = (damage.holes ??= []);
  let nearest = null, nearestDistance = Infinity;
  for (const hole of holes) {
    if (hole.side !== side) continue;
    const distance = Math.hypot(hole.local[0] - local[0], hole.local[1] - local[1], hole.local[2] - local[2]);
    if (distance < nearestDistance) { nearest = hole; nearestDistance = distance; }
  }
  const touching = nearest && nearestDistance < (nearest.radius + radius) * 0.8;
  if (nearest && (touching || holes.length >= HULL_HOLE_LIMIT)) {
    nearest.radius = +Math.min(0.9, Math.hypot(nearest.radius, radius)).toFixed(3);
    nearest.plug = 0;
    damage.holesRevision = (damage.holesRevision ?? 0) + 1;
    return nearest;
  }
  const hole = {
    design: design.map((v) => +v.toFixed(3)),
    local: local.map((v) => +v.toFixed(3)),
    radius: +radius.toFixed(3),
    side,
    compartment,
    plug: 0,
    flow: 0,
  };
  holes.push(hole);
  damage.holesRevision = (damage.holesRevision ?? 0) + 1;
  return hole;
}

// Metres below the mean sea right now. Negative is above it.
export function hullHoleDepth(boat, hole) {
  boatRotate(holeDepthRotation, hole.local[0], hole.local[1], hole.local[2], 0, boat.pitch ?? 0, boat.roll ?? 0);
  return -((boat.heave ?? 0) + holeDepthRotation[1]);
}

// Height of the water standing in the hold, in her own frame, and whether there is any.
export function hullFloodLevel(boat, damage) {
  const tonnes = damage?.floodingTonnes ?? 0;
  const area = Math.max(1, (boat.length ?? 20) * (boat.beam ?? 6) * HULL_HOLD_AREA_SHARE);
  const keel = -(boat.hydrodynamics?.draft ?? 2) - (boat.heave ?? 0);
  return keel + tonnes / (SEA_TONNES_PER_CUBIC_METRE * area);
}

// Tonnes a second coming in through one hole.
export function hullHoleInflow(boat, damage, hole) {
  const depth = hullHoleDepth(boat, hole), r = hole.radius;
  const below = holeClamp((depth + r) / (2 * r), 0, 1);
  const share = Math.max(below, depth + r > -HULL_HOLE_WASH_METRES ? HULL_HOLE_WASH_SHARE : 0);
  if (share <= 0) return 0;
  const standing = Math.max(0, hullFloodLevel(boat, damage) - hole.local[1]);
  // A hole across the waterline runs under the head at the middle of its wetted part.
  const head = (depth >= r ? depth : Math.max(0.05, (depth + r) * 0.5)) - standing;
  if (head <= 0) return 0;
  const area = Math.PI * r * r * share * (1 - (hole.plug ?? 0));
  return HULL_HOLE_DISCHARGE * area * Math.sqrt(2 * HULL_HOLE_GRAVITY * head) * SEA_TONNES_PER_CUBIC_METRE;
}

// Works out this step's flow through every hole, adds it up by compartment, and lets the
// carpenter's crew work on the worst leak they can reach.
export function stepHullHoles(boat, damage, dt) {
  const byCompartment = {};
  let area = 0;
  const holes = damage?.holes;
  if (!holes?.length) return { byCompartment, area };
  let worst = null;
  for (const hole of holes) {
    hole.flow = hullHoleInflow(boat, damage, hole);
    if (hole.flow <= 0) continue;
    byCompartment[hole.compartment] = (byCompartment[hole.compartment] ?? 0) + hole.flow;
    area += Math.PI * hole.radius * hole.radius * (1 - (hole.plug ?? 0));
    if ((hole.plug ?? 0) < HULL_HOLE_PLUG_LIMIT && (!worst || hole.flow > worst.flow)) worst = hole;
  }
  const c = damage.crewCasualties;
  const hands = c?.total ? holeClamp((c.able / c.total) * 1.5, 0, 1) : 1;
  if (worst && !damage.surrendered && !damage.sunk) {
    worst.plug = Math.min(HULL_HOLE_PLUG_LIMIT, (worst.plug ?? 0) + (dt * hands) / HULL_HOLE_PLUG_SECONDS);
  }
  return { byCompartment, area };
}

// A yard's patch stops the water, though the planks still show until a proper refit.
export function plugAllHullHoles(damage) {
  for (const hole of damage?.holes ?? []) { hole.plug = 1; hole.flow = 0; }
}
export function clearHullHoles(damage) {
  if (damage?.holes?.length) {
    damage.holes.length = 0;
    damage.holesRevision = (damage.holesRevision ?? 0) + 1;
  }
}

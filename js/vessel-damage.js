// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Repairs, restores and refloats of a vessel's damage. Fresh hits live in
// gunnery-control.js. Hull integrity is derived from accumulated joules and
// flooding is carried as cargo weight, so changing one without the other is
// silently undone by the next hit or damage step.
import { remountVesselGuns } from './gunnery-state.js';

const VESSEL_COMPARTMENT_KEYS = ['forePort', 'foreStarboard', 'midPort', 'midStarboard', 'aftPort', 'aftStarboard'];
const VESSEL_MAST_GROUPS = ['fore', 'main', 'mizzen'];
// Plain numbers restored as saved. Everything else needs its own handling.
const VESSEL_SNAPSHOT_NUMBERS = [
  'hullDamageJoules', 'superstructureDamageJoules', 'superstructureIntegrity', 'rigDamageJoules', 'rigIntegrity',
  'waterlineBreachArea', 'breachSideMoment', 'breachTrimMoment', 'floodingTonnes', 'floodingSinkage',
  'floodingRoll', 'floodingPitch', 'bendingStrain', 'sinkingDepth', 'battleMorale',
];
const vesselDamageClamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));

export function setVesselHullIntegrity(damage, integrity) {
  const hull = vesselDamageClamp(Number(integrity) || 0, 0, 1);
  damage.hullIntegrity = hull;
  if (Number.isFinite(damage.maxHullEnergy)) damage.hullDamageJoules = (1 - hull) * damage.maxHullEnergy;
  return hull;
}

// Plugs every hole; water already aboard stays until pumped out.
export function stopVesselLeaks(damage) {
  for (const key of VESSEL_COMPARTMENT_KEYS) {
    if (damage.compartments?.[key]) damage.compartments[key].breachArea = 0;
  }
  damage.waterlineBreachArea = 0;
  damage.breachArea = 0;
  damage.breachSideMoment = 0;
  damage.breachTrimMoment = 0;
  damage.bendingStrain = 0;
  damage.hullCracked = false;
}

export function pumpVesselDry(boat) {
  const damage = boat?.damage;
  if (!damage) return;
  if (damage.floodingTonnes > 0) boat.cargoTonnes = Math.max(0, (boat.cargoTonnes ?? 0) - damage.floodingTonnes);
  for (const key of VESSEL_COMPARTMENT_KEYS) {
    if (damage.compartments?.[key]) damage.compartments[key].waterTonnes = 0;
  }
  damage.floodingTonnes = 0;
  damage.floodingSinkage = 0;
  damage.floodingRoll = 0;
  damage.floodingPitch = 0;
}

export function refloatVessel(boat) {
  const damage = boat?.damage;
  if (!damage) return;
  damage.sunk = false;
  damage.settledWreck = false;
  damage.restingOnBottom = false;
  damage.bottomTime = 0;
  damage.sinkingDepth = 0;
}

export function vesselMastStateFor(integrity) {
  return integrity <= 0.18 ? 2 : integrity <= 0.58 ? 1 : 0;
}

export function raiseVesselRig(damage, minIntegrity = 1) {
  const floor = vesselDamageClamp(minIntegrity, 0, 1);
  let sum = 0;
  for (const group of VESSEL_MAST_GROUPS) {
    const integrity = Math.max(floor, damage.mastIntegrity?.[group] ?? 1);
    if (damage.mastIntegrity) damage.mastIntegrity[group] = integrity;
    if (damage.mastState) damage.mastState[group] = vesselMastStateFor(integrity);
    sum += integrity;
  }
  damage.rigIntegrity = sum / VESSEL_MAST_GROUPS.length;
  if (Number.isFinite(damage.maxRigEnergy)) damage.rigDamageJoules = (1 - damage.rigIntegrity) * damage.maxRigEnergy;
}

// The one way to repair a ship. `hullGain` adds to the hull and `minHull`/`minRig`
// set floors; each other option restores one aspect of the vessel in full.
export function repairVessel(boat, { hullGain = 0, minHull = 0, minRig = 0, leaks = false, flooding = false, guns = false, fires = false, structure = false } = {}) {
  const damage = boat?.damage;
  if (!damage) return null;
  const current = Number.isFinite(damage.hullIntegrity) ? damage.hullIntegrity : 1;
  setVesselHullIntegrity(damage, Math.max(minHull, current + hullGain));
  if (minRig > 0) raiseVesselRig(damage, minRig);
  if (leaks) stopVesselLeaks(damage);
  if (flooding) pumpVesselDry(boat);
  if (guns) remountVesselGuns(boat);
  if (fires) {
    if (Array.isArray(damage.fires)) damage.fires.length = 0;
    damage.fireCount = 0;
    damage.fireIntensity = 0;
  }
  if (structure) {
    if (Array.isArray(damage.craters)) damage.craters.length = 0;
    if (Array.isArray(damage.impactSites)) damage.impactSites.length = 0;
    if (Array.isArray(damage.pendingBakes)) damage.pendingBakes.length = 0;
    if (damage.partDamage) for (const key of Object.keys(damage.partDamage)) damage.partDamage[key] = 0;
    damage.throughBreaches = 0;
    damage.breaches = 0;
  }
  damage.revision = (damage.revision ?? 0) + 1;
  return damage;
}

// JSON-safe copy of what must survive a reload. Baked mesh dents are not saved.
export function vesselDamageSnapshot(boat) {
  const damage = boat?.damage;
  if (!damage) return null;
  const snapshot = {
    hullIntegrity: damage.hullIntegrity,
    surrendered: Boolean(damage.surrendered),
    sunk: Boolean(damage.sunk),
    hullCracked: Boolean(damage.hullCracked),
    mastIntegrity: { ...damage.mastIntegrity },
    mastState: { ...damage.mastState },
    compartments: JSON.parse(JSON.stringify(damage.compartments ?? {})),
    crewCasualties: damage.crewCasualties ? {
      total: damage.crewCasualties.total,
      able: damage.crewCasualties.able,
      wounded: damage.crewCasualties.wounded,
      killed: damage.crewCasualties.killed,
    } : null,
    dismountedGunIds: (boat.gunnery?.guns ?? []).filter(gun => gun.dismounted).map(gun => gun.id),
    powderKg: boat.magazine?.powderKg,
  };
  for (const key of VESSEL_SNAPSHOT_NUMBERS) snapshot[key] = damage[key];
  return snapshot;
}

// Accepts partial snapshots: anything absent keeps the pristine value.
export function restoreVesselDamageSnapshot(boat, snapshot) {
  const damage = boat?.damage;
  if (!damage || !snapshot) return false;
  for (const key of VESSEL_SNAPSHOT_NUMBERS) {
    if (Number.isFinite(snapshot[key])) damage[key] = snapshot[key];
  }
  if (Number.isFinite(snapshot.hullIntegrity)) {
    const joules = Number.isFinite(snapshot.hullDamageJoules) ? snapshot.hullDamageJoules : null;
    setVesselHullIntegrity(damage, snapshot.hullIntegrity);
    if (joules !== null) damage.hullDamageJoules = joules;
  }
  for (const group of VESSEL_MAST_GROUPS) {
    if (damage.mastIntegrity && Number.isFinite(snapshot.mastIntegrity?.[group])) damage.mastIntegrity[group] = snapshot.mastIntegrity[group];
    if (damage.mastState && Number.isFinite(snapshot.mastState?.[group])) damage.mastState[group] = snapshot.mastState[group];
  }
  for (const key of VESSEL_COMPARTMENT_KEYS) {
    const saved = snapshot.compartments?.[key];
    if (saved && damage.compartments?.[key]) Object.assign(damage.compartments[key], saved);
  }
  if (snapshot.crewCasualties && damage.crewCasualties) {
    for (const key of ['total', 'able', 'wounded', 'killed']) {
      if (Number.isFinite(snapshot.crewCasualties[key])) damage.crewCasualties[key] = snapshot.crewCasualties[key];
    }
  }
  if (Array.isArray(snapshot.dismountedGunIds)) {
    const ids = new Set(snapshot.dismountedGunIds);
    for (const gun of boat.gunnery?.guns ?? []) {
      if (!ids.has(gun.id)) continue;
      gun.dismounted = true;
      gun.loading = false;
      gun.queued = false;
    }
    damage.dismountedGuns = snapshot.dismountedGunIds.length;
  }
  if (Number.isFinite(snapshot.powderKg) && boat.magazine) boat.magazine.powderKg = snapshot.powderKg;
  if (snapshot.hullCracked) damage.hullCracked = true;
  if (snapshot.surrendered) damage.surrendered = true;
  if (snapshot.sunk) damage.sunk = true;
  damage.revision = (damage.revision ?? 0) + 1;
  return true;
}

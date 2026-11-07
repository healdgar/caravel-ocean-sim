// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
import { pumpVesselDry } from './vessel-damage.js';
import { remountVesselGuns, createGunneryState, prepareGunnery, fireGunnery, stepGunnery, gunnerySummary, resolveGunneryImpact, gunneryOffline, GUNNERY_AMMO_TYPES, isArrowAmmo, gunneryWeapon, gunneryAmmoFlight } from './gunnery-state.js';
import { sweepCrewBodies, recordCrewWound } from './crew-wounds.js';
import { addHullHole, stepHullHoles } from './hull-holes.js';
import { modelDeck, modelHullDeck, vesselVerticalScale } from './hull.js';
import { createGunDefinitions, createNavalBattleGunDefinitions, gunMuzzlePose, gunElevationRange, gunTraverseRange, vesselCarriesPowder, bowElevationDegrees } from './gunnery-models.js';
import { GUNNERY_ORDER_SECONDS } from './gunnery-audio.js';
import { boatRotate, boatHydrodynamics, boatForwardSpeed } from './boat.js';
import { SHIP_MODELS } from './ship-models.js';
import { createShipAssetCache } from './ship-mesh.js';
import { PORT_PREFABS, getBuildingParts } from './coastal-world.js';
import { GROUNDING_SUBSTRATES, classifyGroundingSubstrate, setGroundingDamageHandler } from './terrain-model.js';
import { locatePartAtLocalPoint, isSuperstructurePartId, computeArchetypeScaleSpec } from './part-assembly.js';
import { shipMastSpecs, fracturePartsGone } from './ship-fracture.js';
import { shipColliderCrossings, shipColliderNormal, shipColliderTrace } from './ship-collider.js';
import { buildingReach, traceShotAtBuilding } from './building-fracture.js';
import { sweepJettySegment, applyJettyImpactDamage } from './port-props.js';
import { TRACE_GUN_ARC_COS, enclosurePlan } from './fort-plan.js';
import { HARBOUR_GUN_RANGE_M } from './harbour-geography.js';
import { FOREST_LONG_FALLEN, buildForestTrunkGrid, foreshorePalmPlacement, forestTrunkShape, sweepForestTrunks } from './forest-trunks.js';
import { landCraterSize } from './land-craters.js';
import { createFortGarrison, stepFortGarrison } from './crew.js';
import { DEFAULT_SHIP_COLORS, strikeVesselColors } from './ship-colors.js';

export { GROUNDING_SUBSTRATES, classifyGroundingSubstrate };

let gunneryShipAssetCache = null;

const getModelMastSpecs = shipMastSpecs;

// A mast section is coming down. The crew read the side it falls to from here, once the queue has gone.
function queueMastBreak(damage, event) {
  (damage.mastFallSide ??= {})[event.mastGroup] = event.side || 1;
  damage.pendingBakes.push(event);
}

function computeModelRigIntegrity(damage, mastSpecs) {
  if (!mastSpecs || mastSpecs.length === 0) return 1;
  let sum = 0;
  for (const [mGroup] of mastSpecs) {
    sum += damage.mastIntegrity?.[mGroup] ?? 1;
  }
  return sum / mastSpecs.length;
}

function getModelBulkheadZs(modelId) {
  if (modelId === 'victory') return [5.95, 4.35, 1.65, -3.92];
  if (modelId === 'nina') return [5.55, 2.7];
  if (modelId === 'pinta') return [5.85, 2.8, -3.2];
  if (modelId === 'santa-maria') return [5.85, 3.6, 1.4, -2.8];
  if (modelId === 'flying-cloud') return [3.4, 1.2, -1.6, -3.8];
  if (modelId === 'gipsy-moth-iv') return [1.8, -1.4];
  return [4.2, 1.8, -3.0];
}

function hullHoleCompartment(boat, localZ, side) {
  const halfL = Math.max(6, (boat.length ?? 20) * 0.5);
  const section = localZ < -halfL * 0.28 ? 'fore' : localZ > halfL * 0.28 ? 'aft' : 'mid';
  return `${section}${side >= 0 ? 'Starboard' : 'Port'}`;
}

function localToShipDesignPoint(targetBoat, localPosition) {
  if (!targetBoat || !Array.isArray(localPosition)) return null;
  const modelId = targetBoat.model?.id ?? targetBoat.modelId;
  const model = modelId ? SHIP_MODELS[modelId] : null;
  const f = model?.designFrame;
  const L = targetBoat.length ?? f?.length ?? 20;
  const B = targetBoat.beam ?? f?.beam ?? 6;
  const sx = f?.beam ? B / f.beam : 1;
  const sy = f?.verticalScale ?? 1;
  const sz = f?.length ? L / f.length : 1;
  return [
    localPosition[0] / (sx || 1),
    localPosition[1] / (sy || 1),
    localPosition[2] / (sz || 1),
  ];
}

function resolveShipHitPart(targetBoat, localPosition, hitZone, struckTriangle = -1) {
  if (!targetBoat || !Array.isArray(localPosition)) return null;
  const modelId = targetBoat.model?.id ?? targetBoat.modelId;
  const model = modelId ? SHIP_MODELS[modelId] : null;
  if (!model || model.status !== 'ready') return null;
  try {
    let partAssembly = targetBoat.partAssembly?.catalog ?? targetBoat.partAssembly ?? targetBoat.asset?.partAssembly;
    if (!partAssembly?.parts) {
      if (!gunneryShipAssetCache) gunneryShipAssetCache = createShipAssetCache();
      partAssembly = gunneryShipAssetCache.get(modelId)?.partAssembly;
    }
    if (!partAssembly) return null;
    // A shot that came through a gap already knows what stopped it.
    const struck = struckTriangle >= 0 ? partAssembly.parts?.[partAssembly.trianglePartIds?.[struckTriangle]] : null;
    if (struck) return struck;
    const designPt = localToShipDesignPoint(targetBoat, localPosition);
    const subAssemblies =
      hitZone === 'rigging'
        ? ['masts-and-spars', 'rigging-and-sails']
        : ['keel-and-frame', 'decks-and-interior', 'ordnance-and-helm', 'hull-and-bulwarks'];
    const fracture = targetBoat.damage?.fracture;
    return locatePartAtLocalPoint(partAssembly, designPt, { subAssemblies, gone: fracture?.brokenCount ? fracturePartsGone(fracture) : null });
  } catch {
    return null;
  }
}

function resolveBuildingHitPart(building, localPosition) {
  if (!building || !building.prefabId || !PORT_PREFABS[building.prefabId] || !Array.isArray(localPosition)) {
    return null;
  }
  try {
    const adapter = getBuildingParts(building.prefabId);
    const clampedPt = [localPosition[0], Math.max(0.1, localPosition[1]), localPosition[2]];
    return adapter.locatePartAtLocalPoint(clampedPt);
  } catch {
    return null;
  }
}

export function applyRigidHullImpulse(boat, worldPosition, impulse) {
  const h = boat?.hydrodynamics;
  if (!h || !worldPosition || !impulse) return;
  const centre = [0, 0, 0];
  boatRotate(centre, 0, h.centreOfGravity - (h.draft - h.sinkage), 0, (boat.heading ?? 0) * Math.PI / 180, boat.pitch ?? 0, boat.roll ?? 0);
  const r = worldPosition.map((x, i) => x - ([boat.x ?? 0, boat.heave ?? 0, boat.z ?? 0][i] + centre[i]));
  const heading = (boat.heading ?? 0) * Math.PI / 180, sn = Math.sin(heading), cs = Math.cos(heading);
  boat.surgeVelocity = (boat.surgeVelocity ?? 0) + (impulse[0] * sn - impulse[2] * cs) / (h.mass + h.addedMass);
  boat.leewayVelocity = (boat.leewayVelocity ?? 0) + (impulse[0] * cs + impulse[2] * sn) / (h.mass * 1.8);
  boat.heaveVelocity = (boat.heaveVelocity ?? 0) + impulse[1] / (h.mass + h.addedMass);
  const torque = [r[1] * impulse[2] - r[2] * impulse[1], r[2] * impulse[0] - r[0] * impulse[2], r[0] * impulse[1] - r[1] * impulse[0]];
  const axis = (x, y, z) => { const a = [0, 0, 0]; boatRotate(a, x, y, z, (boat.heading ?? 0) * Math.PI / 180, boat.pitch ?? 0, boat.roll ?? 0); return a; };
  const dot = (a, b) => a.reduce((n, x, i) => n + x * b[i], 0);
  const yawI = h.mass * ((boat.length ?? 20) ** 2 + (boat.beam ?? 6) ** 2) / 12 * 1.5;
  const axes = [axis(1, 0, 0), axis(0, 1, 0), axis(0, 0, 1)], inertia = [h.pitchInertia, yawI, h.rollInertia];
  const omega = [0, 0, 0];
  for (let j = 0; j < 3; j++) { const d = dot(torque, axes[j]) / inertia[j]; for (let i = 0; i < 3; i++) omega[i] += axes[j][i] * d; }
  // Convert a principal-axis angular impulse back to this integrator's Euler
  // rates. Directly adding body-axis rates is wrong on a pitched/heeled ship.
  const cosPitch = Math.max(0.1, Math.cos(boat.pitch ?? 0));
  const omegaH = [cs * omega[0] + sn * omega[2], omega[1], -sn * omega[0] + cs * omega[2]], dRoll = omegaH[2] / cosPitch;
  boat.pitchVelocity = (boat.pitchVelocity ?? 0) + omegaH[0];
  boat.rollVelocity = (boat.rollVelocity ?? 0) + dRoll;
  boat.yawRate = (boat.yawRate ?? 0) - omegaH[1] - Math.sin(boat.pitch ?? 0) * dRoll;
}

export function createVesselMagazineState(boat) {
  if (!boat) return null;
  if (boat.magazine && Number.isFinite(boat.magazine.initialPowderKg)) {
    if (boat.damage) boat.damage.magazine = boat.magazine;
    return boat.magazine;
  }
  const modelId = boat.model?.id ?? boat.modelId ?? 'caravel';
  const gunCount = boat.gunnery?.guns?.length ?? (modelId === 'victory' ? 104 : 4);
  const isFirstRate = modelId === 'victory' || gunCount >= 50;
  // Historical Royal Navy 1st-rate allowance: ~350 whole 90-lb (40.8 kg) copper-hooped barrels
  // of corned black powder (~14,280 kg) stowed in the Grand and Aft Magazines below the orlop deck,
  // plus shot-locker allowances of round, furnace-heated hot, chain, and quilted grape shot.
  const barrelMassKg = 40.8;
  const carriesPowder = vesselCarriesPowder(modelId);
  const barrelsTotal = !carriesPowder ? 0 : isFirstRate ? 350 : Math.max(8, gunCount * 3);
  const initialPowderKg = +(barrelsTotal * barrelMassKg).toFixed(1);
  const initialRounds = carriesPowder ? {
    round: isFirstRate ? 6200 : gunCount * 50,
    hot: isFirstRate ? 240 : gunCount * 6,
    chain: isFirstRate ? 620 : gunCount * 10,
    grape: isFirstRate ? 840 : gunCount * 12,
  } : { round: 0, hot: 0, chain: 0, grape: 0 };
  boat.magazine = {
    initialPowderKg,
    powderKg: initialPowderKg,
    powderFraction: 1,
    barrelMassKg,
    barrelsTotal,
    barrelsRemaining: barrelsTotal,
    rounds: { ...initialRounds },
    initialRounds: { ...initialRounds },
    shotsFired: 0,
    powderConsumedKg: 0,
    hitCount: 0,
    exploded: false,
    deflagrated: false,
    explosionYieldMj: 0,
    detonationCause: null,
  };
  if (boat.damage) boat.damage.magazine = boat.magazine;
  return boat.magazine;
}

export function consumeMagazineOrdnance(boat, event = {}) {
  const mag = createVesselMagazineState(boat);
  if (!mag || mag.exploded || isArrowAmmo(event.ammo)) return mag;
  const shotMass = Number.isFinite(event.mass) ? event.mass : 5.4;
  // Service charge of black powder is ~1/3 the weight of the cast-iron round shot.
  const chargeKg = Number.isFinite(event.chargeKg)
    ? Math.max(0.25, event.chargeKg)
    : +Math.max(0.35, shotMass / 3).toFixed(2);
  const actualUsed = Math.min(mag.powderKg, chargeKg);
  mag.powderKg = +Math.max(0, mag.powderKg - actualUsed).toFixed(2);
  mag.powderConsumedKg = +(mag.powderConsumedKg + actualUsed).toFixed(2);
  mag.powderFraction = mag.initialPowderKg > 0 ? +(mag.powderKg / mag.initialPowderKg).toFixed(4) : 0;
  mag.barrelsRemaining = Math.ceil(mag.powderKg / mag.barrelMassKg);
  mag.shotsFired = (mag.shotsFired ?? 0) + 1;
  const ammo = GUNNERY_AMMO_TYPES.includes(event.ammo) ? event.ammo : (boat.gunnery?.ammo ?? 'round');
  if (mag.rounds && typeof mag.rounds[ammo] === 'number') {
    mag.rounds[ammo] = Math.max(0, mag.rounds[ammo] - 1);
  }
  return mag;
}

export function getMoraleStateLabel(morale = 1, surrendered = false) {
  if (surrendered) return 'surrendered';
  if (morale >= 0.72) return 'steady';
  if (morale >= 0.45) return 'shaken';
  if (morale >= 0.20) return 'wavering';
  return 'broken';
}

export function computeCrewEfficiency(boat) {
  const damage = boat?.damage;
  if (!damage) return 1.0;
  if (damage.surrendered || damage.sunk) return 0.0;
  const c = damage.crewCasualties;
  const total = Math.max(1, c?.total ?? 24);
  const able = Math.max(0, c?.able ?? total);
  const wounded = Math.max(0, c?.wounded ?? 0);
  const effectiveHands = (able + wounded * 0.35) / total;
  const moraleFactor = 0.45 + 0.55 * Math.max(0, Math.min(1, damage.battleMorale ?? 1));
  return +Math.max(0.15, Math.min(1.0, effectiveHands * moraleFactor)).toFixed(3);
}

function defaultVesselCrewComplement(boat) {
  const modelId = boat?.model?.id ?? boat?.modelId ?? 'caravel';
  if (Number.isFinite(boat?.crewComplement) && boat.crewComplement > 0) return Math.round(boat.crewComplement);
  if (modelId === 'victory') return 820;
  if (modelId === 'santa-maria') return 42;
  if (modelId === 'pinta') return 26;
  if (modelId === 'nina') return 22;
  if (modelId === 'taino-canoe') return 30;
  return Math.max(18, Math.round((boat?.length ?? 20) * 1.2));
}

export function createVesselDamageState(boat) {
  const magazine = createVesselMagazineState(boat);
  if (!boat.colors) boat.colors = DEFAULT_SHIP_COLORS;
  const totalCrew = defaultVesselCrewComplement(boat);
  const makeCrewCasualties = () => ({
    total: totalCrew,
    able: totalCrew,
    wounded: 0,
    killed: 0,
    hitsWithCasualties: 0,
    lastCasualties: null,
  });
  const makeCompartments = () => ({
    forePort: { breachArea: 0, waterTonnes: 0 },
    foreStarboard: { breachArea: 0, waterTonnes: 0 },
    midPort: { breachArea: 0, waterTonnes: 0 },
    midStarboard: { breachArea: 0, waterTonnes: 0 },
    aftPort: { breachArea: 0, waterTonnes: 0 },
    aftStarboard: { breachArea: 0, waterTonnes: 0 },
  });
  if (boat.damage) {
    boat.damage.magazine = magazine;
    if (!boat.damage.partDamage) boat.damage.partDamage = {};
    if (!boat.damage.mastState) boat.damage.mastState = { fore: 0, main: 0, mizzen: 0 };
    if (!boat.damage.compartments) boat.damage.compartments = makeCompartments();
    if (!boat.damage.crewCasualties || !Number.isFinite(boat.damage.crewCasualties.total)) {
      boat.damage.crewCasualties = makeCrewCasualties();
    }
    if (!Number.isFinite(boat.damage.battleMorale)) boat.damage.battleMorale = 1.0;
    if (!Number.isFinite(boat.damage.moraleShock)) boat.damage.moraleShock = 0;
    if (typeof boat.damage.surrendered !== 'boolean') boat.damage.surrendered = boat.colors === 'surrender';
    if (!boat.damage.moraleState) {
      boat.damage.moraleState = getMoraleStateLabel(boat.damage.battleMorale, boat.damage.surrendered);
    }
    if (!Array.isArray(boat.damage.impactSites)) boat.damage.impactSites = [];
    if (!Array.isArray(boat.damage.craters)) boat.damage.craters = [];
    if (!Array.isArray(boat.damage.pendingBakes)) boat.damage.pendingBakes = [];
    if (!Array.isArray(boat.damage.fires)) boat.damage.fires = [];
    if (!Array.isArray(boat.damage.worldFires)) boat.damage.worldFires = [];
    if (!Number.isFinite(boat.damage.dismountedGuns)) boat.damage.dismountedGuns = 0;
    if (!Number.isFinite(boat.damage.throughBreaches)) boat.damage.throughBreaches = 0;
    if (!Number.isFinite(boat.damage.windowHits)) boat.damage.windowHits = 0;
    if (!Number.isFinite(boat.damage.backWallHits)) boat.damage.backWallHits = 0;
    if (!Number.isFinite(boat.damage.superstructureHits)) boat.damage.superstructureHits = 0;
    if (!Number.isFinite(boat.damage.superstructureDamageJoules)) boat.damage.superstructureDamageJoules = 0;
    if (!Number.isFinite(boat.damage.superstructureIntegrity)) boat.damage.superstructureIntegrity = 1;
    if (!Number.isFinite(boat.damage.sailRips)) boat.damage.sailRips = 0;
    if (!Number.isFinite(boat.damage.fireCount)) boat.damage.fireCount = 0;
    if (!Number.isFinite(boat.damage.fireIntensity)) boat.damage.fireIntensity = 0;
    if (typeof boat.damage.magazineHit !== 'boolean') boat.damage.magazineHit = false;
    if (typeof boat.damage.magazineExploded !== 'boolean') boat.damage.magazineExploded = false;
    if (!Number.isFinite(boat.damage.magazineExplosionYieldMj)) boat.damage.magazineExplosionYieldMj = 0;
    if (!Number.isFinite(boat.damage.waterlineBreachArea)) boat.damage.waterlineBreachArea = 0;
    if (!Number.isFinite(boat.damage.breachSideMoment)) boat.damage.breachSideMoment = 0;
    if (!Number.isFinite(boat.damage.breachTrimMoment)) boat.damage.breachTrimMoment = 0;
    if (!Number.isFinite(boat.damage.floodingSinkage)) boat.damage.floodingSinkage = 0;
    if (!Number.isFinite(boat.damage.floodingRoll)) boat.damage.floodingRoll = 0;
    if (!Number.isFinite(boat.damage.floodingPitch)) boat.damage.floodingPitch = 0;
    if (!Number.isFinite(boat.damage.bendingStrain)) boat.damage.bendingStrain = 0;
    if (typeof boat.damage.hullCracked !== 'boolean') boat.damage.hullCracked = false;
    if (!Number.isFinite(boat.damage.sinkingDepth)) boat.damage.sinkingDepth = 0;
    if (typeof boat.damage.restingOnBottom !== 'boolean') boat.damage.restingOnBottom = false;
    if (!Number.isFinite(boat.damage.bottomTime)) boat.damage.bottomTime = 0;
    if (typeof boat.damage.settledWreck !== 'boolean') boat.damage.settledWreck = false;
    if (!Number.isFinite(boat.damage.revision)) boat.damage.revision = 0;
    return boat.damage;
  }
  const mass = boat.hydrodynamics?.mass ?? 120000;
  boat.damage = {
    magazine,
    maxHullEnergy: mass >= 60000 ? Math.max(1800000, mass * 42) : Math.max(65000, mass * 28),
    maxRigEnergy: mass >= 60000 ? Math.max(150000, mass * 6) : Math.max(35000, mass * 5.5),
    hullIntegrity: 1,
    superstructureIntegrity: 1,
    rigIntegrity: 1,
    mastIntegrity: { fore: 1, main: 1, mizzen: 1 },
    mastState: { fore: 0, main: 0, mizzen: 0 },
    compartments: makeCompartments(),
    crewCasualties: makeCrewCasualties(),
    battleMorale: 1.0,
    moraleShock: 0,
    moraleState: 'steady',
    surrendered: false,
    surrenderReason: null,
    hullDamageJoules: 0,
    superstructureDamageJoules: 0,
    rigDamageJoules: 0,
    hits: 0,
    hullHits: 0,
    superstructureHits: 0,
    rigHits: 0,
    sailRips: 0,
    breaches: 0,
    throughBreaches: 0,
    dismountedGuns: 0,
    windowHits: 0,
    backWallHits: 0,
    fireCount: 0,
    fireIntensity: 0,
    magazineHit: false,
    magazineExploded: false,
    magazineExplosionYieldMj: 0,
    waterlineBreachArea: 0,
    breachSideMoment: 0,
    breachTrimMoment: 0,
    floodingTonnes: 0,
    floodingSinkage: 0,
    floodingRoll: 0,
    floodingPitch: 0,
    bendingStrain: 0,
    hullCracked: false,
    sinkingDepth: 0,
    restingOnBottom: false,
    bottomTime: 0,
    settledWreck: false,
    sunk: false,
    partDamage: {},
    impactSites: [],
    craters: [],
    pendingBakes: [],
    fires: [],
    worldFires: [],
    revision: 0,
    lastHit: null,
  };
  return boat.damage;
}

// A new ship in the same pooled hull: nothing of the previous one carries over.
export function resetVesselDamageState(boat) {
  pumpVesselDry(boat);
  boat.damage = null;
  boat.magazine = null;
  boat.groundingRoll = 0;
  boat.groundingPitch = 0;
  const damage = createVesselDamageState(boat);
  remountVesselGuns(boat);
  return damage;
}

// A body struck directly goes down where the shot carried it.
function fellCrewBody({ sailor: s, direction, speed = 3 }, killed, wounded, ammo = null) {
  if (!killed && !wounded) return;
  if (ammo !== 'arrow') s.scorchAmount = Math.min(1, (s.scorchAmount ?? 0) + (ammo === 'hot' ? (killed ? 0.72 : 0.55) : ammo === 'fire-arrow' ? 0.3 : killed ? 0.35 : 0.22));
  const n = Math.hypot(direction?.[0] ?? 0, direction?.[2] ?? 0) || 1;
  const dirX = (direction?.[0] ?? 0) / n, dirZ = (direction?.[2] ?? 1) / n;
  s.knockbackVx = dirX * speed;
  s.knockbackVz = dirZ * speed;
  s.fallDir = (s.crewIndex ?? 0) % 2 === 0 ? 1 : -1;
  if (killed) {
    s.casualtyState = 'fallen';
    s.health = 0;
    s.woundSeverity = 1;
    s.collapseYaw = Math.atan2(dirX, dirZ);
  } else {
    s.casualtyState = 'wounded';
    s.health = Math.max(0.25, (s.health ?? 1) - 0.45);
    s.woundSeverity = Math.min(1, Math.max(0.45, 1 - s.health));
  }
}

// Oak splinters fly from where a shot breaks through or strikes a bulwark, and only
// hurt those close by.
function woundCrewBySplinters(targetBoat, damage, localPos, energy, ammo) {
  const counts = { killed: 0, wounded: 0, sex: null };
  const crew = targetBoat.crewCompany?.crew;
  if (!Array.isArray(crew) || !localPos) return counts;
  const reach = Math.min(3.2, 1.2 + Math.sqrt(energy / 500000) * 1.4);
  for (const s of crew) {
    if (!s.position || s.visible === false || s.casualtyState === 'fallen') continue;
    const dx = s.position[0] - localPos[0], dy = s.position[1] + 0.9 - localPos[1], dz = s.position[2] - localPos[2];
    const distance = Math.hypot(dx, dy, dz);
    if (distance > reach) continue;
    const roll = ((damage.hits ?? 1) * 0.6180339887 + (s.crewIndex ?? 0) * 0.7548776662) % 1;
    const chance = 0.5 * (1 - distance / reach);
    if (roll >= chance) continue;
    const killed = roll < chance * 0.25;
    fellCrewBody({ sailor: s, direction: [dx, dy, dz], speed: 2.3 * (1 - distance / reach) + 0.4 }, killed, !killed, ammo);
    if (killed) counts.killed++; else counts.wounded++;
    if (!counts.sex && s.sex) counts.sex = s.sex;
    recordCrewWound(s, 'splinter', [s.position[0] - dx * 0.4, s.position[1] + 0.9 - dy * 0.4, s.position[2] - dz * 0.4], [dx, dy, dz], (roll * 7.3890560989) % 1);
  }
  return counts;
}

// A ball goes straight through whoever it meets and flies on. It kills outright.
function strikeSoldierWithBall(hit, projectile, port = null) {
  const struck = (projectile.struckBodies ??= new Set());
  if (struck.has(hit.sailor)) return;
  struck.add(hit.sailor);
  const speed = Math.hypot(...(projectile.velocity ?? [0, 0, 0]));
  if (0.5 * (projectile.mass ?? 1) * speed * speed < 200) return;
  hit.sailor.casualtyState = 'fallen';
  hit.sailor._poseReady = false;
  if (port?.garrison) {
    (port.garrison.audioEvents ??= []).push({
      type: 'casualty-scream',
      sex: hit.sailor.sex ?? 'male',
      cause: 'ball',
      position: hit.point ?? [hit.sailor.x ?? 0, hit.sailor.y ?? 2, hit.sailor.z ?? 0],
    });
  }
}

function strikeCrewBodyWithBall(targetBoat, hit, projectile, direction) {
  const struck = (projectile.struckBodies ??= new Set());
  if (struck.has(hit.sailor)) return;
  struck.add(hit.sailor);
  const speed = Math.hypot(...(projectile.velocity ?? [0, 0, 0]));
  const energy = 0.5 * (projectile.mass ?? 1) * speed * speed;
  if (energy < 200) return;
  const roll = (((projectile.id ?? 1) * 0.7548776662 + (hit.sailor.crewIndex ?? 0) * 0.5698402909) % 1 + 1) % 1;
  recordCrewWound(hit.sailor, 'ball', hit.point, direction, roll);
  const damage = createVesselDamageState(targetBoat);
  damage.hits = (damage.hits ?? 0) + 1;
  applyCrewCasualtiesAndMorale(targetBoat, { ammo: projectile.ammo, energy, hitZone: 'crew' }, {
    casualties: { killed: 1, wounded: 0 },
    // A round shot flings what it strikes, right over the far rail on a narrow deck.
    struck: { sailor: hit.sailor, direction, speed: Math.min(9, 3 + speed / 80) },
    cause: 'round-shot',
    hitZone: 'crew',
  });
}

export function applyCrewCasualtiesAndMorale(targetBoat, event = {}, context = {}) {
  if (!targetBoat) return null;
  const damage = createVesselDamageState(targetBoat);
  const c = damage.crewCasualties;
  const ammo = event.ammo ?? context.ammo ?? 'round';
  const energy = Number.isFinite(event.energy) ? Math.max(5000, event.energy) : 120000;
  const hitZone = event.hitZone ?? context.hitZone ?? 'hull';
  const cause = context.cause ?? (isArrowAmmo(ammo) ? 'arrow-wound' : ammo === 'grape' ? 'grape-hail' : ammo === 'hot' ? 'hot-shot-burns' : hitZone === 'rigging' ? 'falling-spars' : 'oak-splinters');

  let newKilled = 0;
  let newWounded = 0;
  let casualtySex = context.struck?.sailor?.sex ?? null;
  if (context.casualties) {
    newKilled = Math.min(c.able, context.casualties.killed ?? 0);
    newWounded = Math.min(c.able - newKilled, context.casualties.wounded ?? 0);
  } else if (context.isMagazineBlast) {
    const frac = Math.min(0.65, 0.22 + 0.35 * (context.powderFrac ?? 0.5));
    newKilled = Math.min(c.able, Math.max(2, Math.round(c.total * frac * 0.55)));
    newWounded = Math.min(Math.max(0, c.able - newKilled), Math.max(2, Math.round(c.total * frac * 0.45)));
  } else if (c.able > 0) {
    // A shot hurts the bodies it meets, which the sweep and splinters below handle. This
    // count stands in only for hands the game does not draw, in proportion to how many
    // share the deck, and mostly when a shot breaks through to where they stand.
    const crew = Array.isArray(targetBoat.crewCompany?.crew) ? targetBoat.crewCompany.crew : [];
    const drawn = crew.filter((s) => s.visible !== false && s.casualtyState !== 'fallen').length;
    const crowding = Math.min(1.5, Math.max(0, c.able - drawn) / Math.max(1, (targetBoat.length ?? 20) * (targetBoat.beam ?? 6) * 0.35));
    const penetrating = context.penetratedOuter || context.enteredThroughWindow;
    // A bulwark is thin: a shot striking it showers those at the rail even if it stays out.
    const rail = context.localPos ? vesselRailHeight(targetBoat, context.localPos[2]) : null;
    const topside = rail !== null && context.localPos[1] >= rail - VESSEL_BULWARK_METRES - 0.2;
    const reach = (penetrating ? 1 : topside ? 0.4 : 0.1) * Math.min(2, Math.sqrt(energy / 500000));
    const ammoReach = ammo === 'grape' || ammo === 'hot' ? 1.25 : hitZone === 'rigging' ? 0.2 : 1;
    const deterministic = ((damage.hits ?? 1) * 0.6180339) % 1;
    const count = Math.floor(reach * ammoReach * crowding + deterministic);
    newKilled = Math.min(c.able, Math.floor(count / 3 + deterministic));
    newWounded = Math.min(c.able - newKilled, Math.max(0, count - newKilled));
    if (penetrating || topside) {
      const splintered = woundCrewBySplinters(targetBoat, damage, context.localPos, energy, ammo);
      newKilled = Math.min(c.able, newKilled + splintered.killed);
      newWounded = Math.min(c.able - newKilled, newWounded + splintered.wounded);
      if (!casualtySex && splintered.sex) casualtySex = splintered.sex;
    }
    // One shot strikes one part of the ship: however heavy, it cannot reach the whole company.
    const perHitLimit = Math.max(2, Math.ceil(c.total * 0.3));
    newKilled = Math.min(newKilled, perHitLimit);
    newWounded = Math.min(newWounded, perHitLimit - newKilled);
  }
  if (!casualtySex && (newKilled > 0 || newWounded > 0)) {
    const crew = Array.isArray(targetBoat.crewCompany?.crew) ? targetBoat.crewCompany.crew : [];
    const femalePresent = crew.some((s) => s.sex === 'female');
    casualtySex = femalePresent && ((damage.hits ?? 1) % 2 === 0) ? 'female' : 'male';
  }

  c.killed += newKilled;
  c.wounded += newWounded;
  c.able = Math.max(0, c.total - c.killed - c.wounded);
  if (newKilled > 0 || newWounded > 0) {
    c.hitsWithCasualties = (c.hitsWithCasualties ?? 0) + 1;
  }

  // Propagate casualties to visible 3D deck crew actors if present on the vessel.
  const crewActors = targetBoat.crewCompany?.crew;
  if (context.struck) {
    fellCrewBody(context.struck, newKilled > 0, newWounded > 0, ammo);
  } else if (Array.isArray(crewActors) && context.isMagazineBlast) {
    const designPt = context.designPt ?? [0, 0, 0];
    const candidates = crewActors
      .filter(s => s.casualtyState !== 'fallen')
      .map(s => {
        const dx = (s.x ?? 0) - (designPt[0] ?? 0);
        const dz = (s.z ?? 0) - (designPt[2] ?? 0);
        return {
          sailor: s,
          dx,
          dz,
          dist: Math.hypot(dx, dz),
        };
      })
      .sort((a, b) => a.dist - b.dist);

    const actorScale = Math.max(1, Math.round(c.total / Math.max(1, crewActors.length)));
    let actorFallenBudget = Math.ceil(newKilled / actorScale);
    let actorWoundedBudget = Math.ceil(newWounded / actorScale);
    const blastSpeed = context.isMagazineBlast ? 9 : ammo === 'grape' ? 1.8 : 2.3;
    for (const item of candidates) {
      const s = item.sailor;
      const invD = item.dist > 1e-3 ? 1 / item.dist : 1;
      const dirX = item.dist > 1e-3 ? item.dx * invD : (((s.crewIndex ?? 0) % 2 === 0) ? 1 : -1);
      const dirZ = item.dist > 1e-3 ? item.dz * invD : 0.5;
      const falloff = Math.max(0.25, 1 - item.dist / 3.8);
      if (actorFallenBudget > 0) {
        s.casualtyState = 'fallen';
        s.health = 0;
        s.woundSeverity = 1.0;
        s.scorchAmount = Math.min(1, (s.scorchAmount ?? 0) + (ammo === 'hot' || context.isMagazineBlast ? 0.72 : 0.35));
        s.collapseYaw = Math.atan2(dirX, dirZ);
        s.fallDir = ((s.crewIndex ?? 0) % 2 === 0) ? 1 : -1;
        s.knockbackVx = dirX * blastSpeed * falloff;
        s.knockbackVz = dirZ * blastSpeed * falloff;
        actorFallenBudget--;
      } else if (actorWoundedBudget > 0 && s.casualtyState !== 'wounded') {
        s.casualtyState = 'wounded';
        s.health = Math.max(0.25, (s.health ?? 1) - 0.45);
        s.woundSeverity = Math.min(1, Math.max(0.45, 1 - s.health));
        s.scorchAmount = Math.min(1, (s.scorchAmount ?? 0) + (ammo === 'hot' || context.isMagazineBlast ? 0.55 : 0.22));
        s.fallDir = ((s.crewIndex ?? 0) % 2 === 0) ? 1 : -1;
        s.knockbackVx = dirX * blastSpeed * 0.65 * falloff;
        s.knockbackVz = dirZ * blastSpeed * 0.65 * falloff;
        if (context.isMagazineBlast || item.dist < 1.6) {
          s.knockdownTimer = context.isMagazineBlast ? 2.4 : 1.35;
        }
        actorWoundedBudget--;
      } else if (context.isMagazineBlast && item.dist < 2.8) {
        s.knockdownTimer = Math.max(s.knockdownTimer ?? 0, 1.4);
        s.scorchAmount = Math.min(1, (s.scorchAmount ?? 0) + 0.35);
        s.knockbackVx = dirX * blastSpeed * 0.45 * falloff;
        s.knockbackVz = dirZ * blastSpeed * 0.45 * falloff;
      }
      if (actorFallenBudget <= 0 && actorWoundedBudget <= 0 && !context.isMagazineBlast) break;
    }
  }

  // Battle Morale impact: casualties, shock from grape/hot/magazine blasts, hull & rig loss.
  const casualtyRatio = (c.killed + c.wounded * 0.6) / Math.max(1, c.total);
  const shockAdd = Math.min(
    0.45,
    ((newKilled * 1.6 + newWounded * 0.85) / Math.max(8, c.total)) * 1.35 +
      (ammo === 'arrow' ? 0.002 : ammo === 'fire-arrow' ? 0.006 : ammo === 'grape' ? 0.055 : ammo === 'hot' ? 0.045 : 0.018) +
      (context.isMagazineBlast ? 0.38 : 0),
  );
  damage.moraleShock = +Math.min(0.65, (damage.moraleShock ?? 0) + shockAdd).toFixed(4);
  const hullLoss = 1 - Math.max(0, Math.min(1, damage.hullIntegrity ?? 1));
  const rigLoss = 1 - Math.max(0, Math.min(1, damage.rigIntegrity ?? 1));
  const firePenalty = Math.min(0.25, (damage.fireIntensity ?? 0) * 0.12);
  const targetMorale = Math.max(
    0,
    Math.min(1, 1.0 - casualtyRatio * 1.15 - hullLoss * 0.42 - rigLoss * 0.18 - firePenalty - damage.moraleShock),
  );
  damage.battleMorale = +targetMorale.toFixed(3);
  damage.moraleState = getMoraleStateLabel(damage.battleMorale, damage.surrendered);

  c.lastCasualties = {
    killed: newKilled,
    wounded: newWounded,
    sex: casualtySex ?? 'male',
    cause,
    ammo,
    ableRemaining: c.able,
    total: c.total,
    battleMorale: damage.battleMorale,
    moraleState: damage.moraleState,
  };
  if ((newKilled > 0 || newWounded > 0) && typeof targetBoat.crewEvents === 'function') {
    targetBoat.crewEvents({
      type: 'casualty-scream',
      sex: casualtySex ?? 'male',
      killed: newKilled,
      wounded: newWounded,
      cause,
      position: [targetBoat.x ?? 0, (targetBoat.heave ?? 0) + 2, targetBoat.z ?? 0],
    });
  }

  // Automatic surrender when battle morale breaks or the crew is decimated under heavy damage (AI/non-player vessels, or if autoSurrender !== false).
  if (
    !damage.surrendered &&
    !damage.sunk &&
    targetBoat.isPlayerVessel !== true &&
    (damage.battleMorale <= 0.18 || (c.able / Math.max(1, c.total) <= 0.25 && (damage.hullIntegrity ?? 1) < 0.55))
  ) {
    strikeVesselColors(
      targetBoat,
      damage.battleMorale <= 0.18 ? 'Crew battle morale broke under fire' : 'Heavy crew casualties & hull damage',
    );
  }

  return c.lastCasualties;
}

export function detonateVesselMagazine(targetBoat, { magId = 'magazine.grand', designPt = [0, -0.48, -3.3], localPos = [0, -1.2, -8.0], cause = 'shot' } = {}) {
  if (!targetBoat) return null;
  const damage = createVesselDamageState(targetBoat);
  const mag = createVesselMagazineState(targetBoat);
  mag.hitCount = (mag.hitCount ?? 0) + 1;
  damage.magazineHit = true;
  damage.partDamage[magId] = Math.min(1, +((damage.partDamage[magId] ?? 0) + 0.65).toFixed(3));

  const powderKg = Math.max(0, mag.powderKg ?? 0);
  const powderFrac = mag.initialPowderKg > 0 ? Math.max(0, Math.min(1, powderKg / mag.initialPowderKg)) : 0;
  if (powderKg <= 0 || powderFrac <= 0.005 || mag.exploded) {
    return {
      triggered: false,
      exploded: mag.exploded,
      deflagrated: mag.deflagrated,
      powderFraction: +powderFrac.toFixed(4),
      yieldMj: 0,
    };
  }

  // Black powder specific chemical energy release is ~3.0 MJ/kg.
  const yieldMj = +(powderKg * 3.0).toFixed(1);
  mag.powderConsumedKg = +(mag.powderConsumedKg + powderKg).toFixed(2);
  mag.powderKg = 0;
  mag.powderFraction = 0;
  mag.barrelsRemaining = 0;
  mag.explosionYieldMj = yieldMj;
  mag.detonationCause = cause;
  damage.magazineExplosionYieldMj = yieldMj;

  const magZ = magId === 'magazine.aft' ? 3.15 : -3.30;
  const magY = magId === 'magazine.aft' ? -0.44 : -0.48;
  const hitSide = (designPt?.[0] ?? localPos?.[0] ?? 0) >= 0 ? 1 : -1;

  // Low remaining powder (< 20%): violent internal deflagration & shipboard fire rather than full hull rupture.
  if (powderFrac < 0.20) {
    mag.deflagrated = true;
    const deflagHullJoules = damage.maxHullEnergy * (0.18 + powderFrac * 1.45);
    damage.hullDamageJoules += deflagHullJoules;
    damage.hullIntegrity = Math.max(0, 1 - damage.hullDamageJoules / damage.maxHullEnergy);
    damage.partDamage[magId] = 1;
    damage.partDamage['deck.orlop.internal'] = Math.min(1, +((damage.partDamage['deck.orlop.internal'] ?? 0) + 0.75).toFixed(3));
    damage.partDamage['deck.lower.internal'] = Math.min(1, +((damage.partDamage['deck.lower.internal'] ?? 0) + 0.45).toFixed(3));

    damage.pendingBakes.push({
      kind: 'magazine-explosion',
      x: 0,
      y: magY,
      z: magZ,
      side: hitSide,
      radius: +(0.95 + powderFrac * 2.2).toFixed(3),
      stepDepth: +(0.25 + powderFrac * 0.85).toFixed(3),
      severity: +(0.65 + powderFrac * 1.5).toFixed(3),
      powderFraction: +Math.max(0.08, powderFrac).toFixed(3),
      hits: 2,
    });

    const fireCountAdd = 2;
    for (let i = 0; i < fireCountAdd; i++) {
      if (damage.fires.length >= 12) break;
      damage.fires.push({
        localPosition: [
          (i === 0 ? 1 : -1) * 0.8,
          0.6 + i * 0.5,
          (localPos?.[2] ?? (magZ * 2.5)) + (i - 0.5) * 1.4,
        ],
        hitZone: 'hull',
        mastGroup: magId === 'magazine.aft' ? 'mizzen' : 'fore',
        intensity: +(0.95 + powderFrac * 2.2).toFixed(3),
        age: 0,
        seed: ((damage.hits * 0.618 + i * 0.29) % 1) || 0.41,
      });
    }
    damage.fireCount = (damage.fireCount ?? 0) + fireCountAdd;
    damage.fireIntensity = +damage.fires.reduce((s, f) => s + f.intensity, 0).toFixed(3);
    const worldPt = [
      (targetBoat.x ?? 0) + (localPos?.[0] ?? 0),
      (targetBoat.heave ?? 0) + (localPos?.[1] ?? 0),
      (targetBoat.z ?? 0) + (localPos?.[2] ?? 0),
    ];
    const mass = targetBoat.hydrodynamics?.mass ?? 120000;
    applyRigidHullImpulse(targetBoat, worldPt, [hitSide * mass * 0.35, mass * (0.55 + powderFrac * 1.8), 0]);
    damage.revision = (damage.revision ?? 0) + 1;
    return {
      triggered: true,
      exploded: false,
      deflagrated: true,
      powderFraction: +powderFrac.toFixed(4),
      yieldMj,
    };
  }

  // Substantial powder remaining (powderFrac >= 0.20): catastrophic magazine explosion!
  mag.exploded = true;
  damage.magazineExploded = true;
  const blastHullJoules = damage.maxHullEnergy * (0.58 + 0.92 * powderFrac);
  damage.hullDamageJoules += blastHullJoules;
  damage.hullIntegrity = Math.max(0, 1 - damage.hullDamageJoules / damage.maxHullEnergy);
  damage.partDamage[magId] = 1;
  damage.partDamage['deck.orlop.internal'] = 1;
  damage.partDamage['deck.lower.internal'] = 1;
  damage.partDamage['deck.middle.internal'] = Math.min(1, +(0.65 + 0.35 * powderFrac).toFixed(3));
  damage.partDamage['deck.upper.internal'] = Math.min(1, +(0.45 + 0.55 * powderFrac).toFixed(3));
  damage.partDamage['hull.planking'] = Math.min(1, +((damage.partDamage['hull.planking'] ?? 0) + 0.72 * powderFrac).toFixed(3));

  // Queue the explosion: it scorches what is left and throws what it reaches (js/ship-fracture.js).
  damage.pendingBakes.push({
    kind: 'magazine-explosion',
    x: 0,
    y: magY,
    z: magZ,
    side: hitSide,
    radius: +(1.6 + 1.8 * powderFrac).toFixed(3),
    stepDepth: +(0.55 + 0.85 * powderFrac).toFixed(3),
    severity: +(0.95 + 0.55 * powderFrac).toFixed(3),
    powderFraction: +powderFrac.toFixed(3),
    hits: 4,
  });

  // Add outward hull craters on both port and starboard sides at the magazine station.
  for (const sSign of [-1, 1]) {
    damage.craters.push({
      x: +(sSign * 1.38).toFixed(3),
      y: +(magY + 0.55).toFixed(3),
      z: +magZ.toFixed(3),
      side: sSign,
      radius: +(0.18 + 0.035 * powderFrac).toFixed(3),
      depth: +(0.65 + 0.65 * powderFrac).toFixed(3),
      severity: +(1.1 + 0.4 * powderFrac).toFixed(3),
      hits: 4,
    });
  }
  damage.cratersRevision = (damage.cratersRevision ?? 0) + 1;

  // Dismount guns above the magazine and across the gundecks.
  const dismountAdd = Math.max(2, Math.round((4 + 18 * powderFrac) * ((targetBoat.modelId ?? 'victory') === 'victory' ? 1 : 0.25)));
  damage.dismountedGuns = (damage.dismountedGuns ?? 0) + dismountAdd;
  const targetGuns = targetBoat.gunnery?.guns ?? targetBoat.gunnery?.state?.guns;
  if (Array.isArray(targetGuns)) {
    let left = dismountAdd;
    for (const g of targetGuns) {
      if (left <= 0) break;
      if (!g.dismounted) {
        g.dismounted = true;
        g.loading = false;
        g.queued = false;
        left--;
      }
    }
  }

  // Upward blast wave unsteps and collapses masts over the board depending on magazine station & powder fraction.
  const primaryMast = magId === 'magazine.aft' ? 'mizzen' : 'fore';
  const mastsToCollapse = [primaryMast];
  if (powderFrac >= 0.40) mastsToCollapse.push('main');
  if (powderFrac >= 0.72) mastsToCollapse.push(magId === 'magazine.aft' ? 'fore' : 'mizzen');
  for (const mGroup of mastsToCollapse) {
    damage.mastIntegrity[mGroup] = 0;
    const sailKey = mGroup === 'fore' ? 'sailFore' : mGroup === 'mizzen' ? 'sailMizzen' : 'sailMain';
    if (typeof targetBoat[sailKey] === 'number') targetBoat[sailKey] = 0;
  }
  damage.rigIntegrity = +((damage.mastIntegrity.fore + damage.mastIntegrity.main + damage.mastIntegrity.mizzen) / 3).toFixed(4);

  // Massive underwater hull breach and immediate flooding from blown-out garboard & lower futtocks.
  const blastBreaches = Math.max(2, Math.round(3 + 6 * powderFrac));
  damage.breaches += blastBreaches;
  damage.throughBreaches = (damage.throughBreaches ?? 0) + Math.max(1, Math.round(2 + 4 * powderFrac));
  const blastBreachArea = +(0.35 + 1.45 * powderFrac).toFixed(4);
  damage.waterlineBreachArea = +(damage.waterlineBreachArea + blastBreachArea).toFixed(5);
  damage.breachSideMoment = +(damage.breachSideMoment + hitSide * blastBreachArea * 0.45).toFixed(5);
  damage.breachTrimMoment = +(damage.breachTrimMoment + Math.sign(magZ) * blastBreachArea * 0.75).toFixed(5);

  const blastFlood = +(18 + 68 * powderFrac).toFixed(2);
  damage.floodingTonnes = +(damage.floodingTonnes + blastFlood).toFixed(3);
  targetBoat.cargoTonnes = Math.min(100, (targetBoat.cargoTonnes ?? 0) + blastFlood);
  if (targetBoat.hydrodynamics && Number.isFinite(targetBoat.length) && Number.isFinite(targetBoat.beam)) {
    targetBoat.hydrodynamics = boatHydrodynamics(
      targetBoat.length,
      targetBoat.beam,
      targetBoat.provisionDays ?? 30,
      targetBoat.cargoTonnes,
      targetBoat.modelId,
    );
  }
  const wpArea = Math.max(18, targetBoat.hydrodynamics?.waterplaneArea ?? ((targetBoat.length ?? 20) * (targetBoat.beam ?? 6) * 0.72));
  damage.floodingSinkage = +((damage.floodingTonnes * 1000) / (1025 * wpArea)).toFixed(4);
  if (powderFrac >= 0.35 || damage.hullIntegrity <= 0.08) {
    damage.sunk = true;
  }

  // Towering fireball and conflagration across the shattered decks.
  const numFires = Math.min(6, Math.max(3, Math.round(3 + 3 * powderFrac)));
  const zScale = (targetBoat.length ?? 56) / 12.6;
  const xScale = (targetBoat.beam ?? 15.8) / 3.4;
  for (let i = 0; i < numFires; i++) {
    if (damage.fires.length >= 12) damage.fires.shift();
    const fx = ((i % 2 === 0 ? 1 : -1) * (0.25 + 0.35 * (i % 3))) * xScale;
    const fy = 0.8 + (i % 3) * 1.1;
    const fz = (magZ + (i - (numFires - 1) * 0.5) * 0.85) * zScale;
    damage.fires.push({
      localPosition: [fx, fy, fz],
      hitZone: i === numFires - 1 ? 'rigging' : 'hull',
      mastGroup: primaryMast,
      intensity: +(Math.min(1.6, 1.15 + 0.45 * powderFrac)).toFixed(3),
      age: 0,
      seed: ((damage.hits * 0.6180339 + i * 0.23) % 1) || 0.53,
    });
  }
  damage.fireCount = (damage.fireCount ?? 0) + numFires;
  damage.fireIntensity = +damage.fires.reduce((s, f) => s + f.intensity, 0).toFixed(3);

  // Populate worldFires immediately so the fireball/plume renders on the exact frame of detonation.
  const yaw = ((targetBoat.heading ?? 0) * Math.PI) / 180;
  const pitch = targetBoat.pitch ?? 0;
  const roll = targetBoat.roll ?? 0;
  damage.worldFires.length = 0;
  for (const f of damage.fires) {
    const rot = [0, 0, 0];
    boatRotate(rot, f.localPosition[0], f.localPosition[1], f.localPosition[2], yaw, pitch, roll);
    damage.worldFires.push({
      position: [(targetBoat.x ?? 0) + rot[0], (targetBoat.heave ?? 0) + rot[1], (targetBoat.z ?? 0) + rot[2]],
      intensity: f.intensity,
      age: f.age,
      seed: f.seed,
    });
  }

  // Massive 6-DOF upward & rolling blast impulse at the magazine station.
  const mass = targetBoat.hydrodynamics?.mass ?? 120000;
  const blastWorld = [0, 0, 0];
  boatRotate(blastWorld, hitSide * 1.2, -0.5, magZ * zScale, yaw, pitch, roll);
  blastWorld[0] += targetBoat.x ?? 0;
  blastWorld[1] += targetBoat.heave ?? 0;
  blastWorld[2] += targetBoat.z ?? 0;
  applyRigidHullImpulse(targetBoat, blastWorld, [
    hitSide * mass * (0.95 + 1.45 * powderFrac),
    mass * (1.85 + 2.85 * powderFrac),
    Math.sign(magZ) * mass * (0.45 + 0.75 * powderFrac),
  ]);

  applyCrewCasualtiesAndMorale(
    targetBoat,
    { ammo: cause === 'hot-shot' ? 'hot' : 'round', energy: Math.max(500000, yieldMj * 1000000), hitZone: 'magazine' },
    { isMagazineBlast: true, powderFrac, designPt, cause: 'magazine-blast' },
  );

  damage.revision = (damage.revision ?? 0) + 1;
  return {
    triggered: true,
    exploded: true,
    deflagrated: false,
    powderFraction: +powderFrac.toFixed(4),
    yieldMj,
  };
}

function vesselBasisAxes(boat, ax = [0, 0, 0], ay = [0, 0, 0], az = [0, 0, 0]) {
  const yaw = (boat.heading ?? 0) * Math.PI / 180, pitch = boat.pitch ?? 0, roll = boat.roll ?? 0;
  boatRotate(ax, 1, 0, 0, yaw, pitch, roll);
  boatRotate(ay, 0, 1, 0, yaw, pitch, roll);
  boatRotate(az, 0, 0, 1, yaw, pitch, roll);
  return { ax, ay, az };
}

function vesselWorldToLocal(boat, worldPt) {
  const dx = worldPt[0] - (boat.x ?? 0), dy = worldPt[1] - (boat.heave ?? 0), dz = worldPt[2] - (boat.z ?? 0);
  const { ax, ay, az } = vesselBasisAxes(boat);
  return [
    dx * ax[0] + dy * ax[1] + dz * ax[2],
    dx * ay[0] + dy * ay[1] + dz * ay[2],
    dx * az[0] + dy * az[1] + dz * az[2],
  ];
}

function vesselWorldToLocalVector(boat, worldVec) {
  const { ax, ay, az } = vesselBasisAxes(boat);
  return [
    worldVec[0] * ax[0] + worldVec[1] * ax[1] + worldVec[2] * ax[2],
    worldVec[0] * ay[0] + worldVec[1] * ay[1] + worldVec[2] * ay[2],
    worldVec[0] * az[0] + worldVec[1] * az[1] + worldVec[2] * az[2],
  ];
}

function vesselLocalToWorldNormal(boat, localNormal) {
  const out = [0, 0, 0];
  boatRotate(out, localNormal[0], localNormal[1], localNormal[2], (boat.heading ?? 0) * Math.PI / 180, boat.pitch ?? 0, boat.roll ?? 0);
  const len = Math.hypot(out[0], out[1], out[2]) || 1;
  return [out[0] / len, out[1] / len, out[2] / len];
}

// Top of the solid hull along her length, in metres above the waterline: the gunwale of an
// open hull, or the deck plus its bulwark. Anything above it is open air and whoever
// stands there. Sampled once per hull shape, since a shot asks many times per step.
const VESSEL_RAIL_PROFILES = new Map();
const VESSEL_RAIL_STATIONS = 33;
const VESSEL_BULWARK_METRES = 1;
function vesselRailProfile(boat) {
  const modelId = boat?.model?.id ?? boat?.modelId;
  const f = (modelId ? SHIP_MODELS[modelId] : null)?.designFrame;
  if (!f?.length) return null;
  const key = `${modelId}/${boat.length}/${boat.beam}`;
  if (VESSEL_RAIL_PROFILES.has(key)) return VESSEL_RAIL_PROFILES.get(key);
  let profile = null;
  try {
    const vertical = vesselVerticalScale(boat);
    const heights = Array.from({ length: VESSEL_RAIL_STATIONS }, (_, i) => {
      const z = (i / (VESSEL_RAIL_STATIONS - 1) - 0.5) * f.length * 1.04;
      const deck = modelDeck(boat, z) * vertical, shell = modelHullDeck(boat, z) * vertical;
      return shell > deck + 0.2 ? shell : deck + VESSEL_BULWARK_METRES;
    });
    profile = { heights, designLength: f.length };
  } catch { /* an unfinished hull keeps the generic volume */ }
  VESSEL_RAIL_PROFILES.set(key, profile);
  return profile;
}
export function vesselRailHeight(boat, localZ = 0) {
  const profile = vesselRailProfile(boat);
  if (!profile) return null;
  const u = Math.max(0, Math.min(1, localZ / (boat.length ?? profile.designLength) / 1.04 + 0.5)) * (VESSEL_RAIL_STATIONS - 1);
  const i = Math.min(VESSEL_RAIL_STATIONS - 2, Math.floor(u));
  return profile.heights[i] + (profile.heights[i + 1] - profile.heights[i]) * (u - i);
}

// Built with each model's mesh. A boat with no model of her own is the Niña, as everywhere else, and a model with
// nothing drawn has nothing to strike.
const SHIP_COLLIDERS = new Map();
function shipColliderOf(boat) {
  const modelId = boat.model?.id ?? boat.modelId ?? 'nina';
  let collider = SHIP_COLLIDERS.get(modelId);
  if (collider === undefined) {
    if (!gunneryShipAssetCache) gunneryShipAssetCache = createShipAssetCache();
    try { collider = gunneryShipAssetCache.get(modelId).collider; } catch { collider = null; }
    SHIP_COLLIDERS.set(modelId, collider);
  }
  return collider;
}

// A segment in her own frame and in her design units, or null if it cannot come near what `bounds` holds. Nearly every
// segment of a flight, and of a preview, ends in the first two tests.
function shipSegmentInFrame(from, to, radius, boat, collider, bounds) {
  const frame = collider.frame, { runtime } = collider.model, { min, max } = bounds;
  const sx = (boat.beam ?? runtime.beam) / frame.beam, sy = frame.verticalScale ?? 1, sz = (boat.length ?? runtime.length) / frame.length;
  const across = Math.hypot(Math.max(-min[0], max[0]) * sx, Math.max(-min[2], max[2]) * sz) + radius;
  const bx = boat.x ?? 0, bz = boat.z ?? 0, heave = boat.heave ?? 0;
  const midX = (from[0] + to[0]) * 0.5 - bx, midZ = (from[2] + to[2]) * 0.5 - bz;
  const segLen = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
  if (Math.hypot(midX, midZ) > across + segLen * 0.5) return null;
  const sphere = Math.hypot(across, Math.max(-min[1], max[1]) * sy);
  if (Math.max(from[1], to[1]) < heave - sphere || Math.min(from[1], to[1]) > heave + sphere) return null;

  const { ax, ay, az } = vesselBasisAxes(boat);
  const dx0 = from[0] - bx, dy0 = from[1] - heave, dz0 = from[2] - bz;
  const dx1 = to[0] - bx, dy1 = to[1] - heave, dz1 = to[2] - bz;
  const p0 = [dx0 * ax[0] + dy0 * ax[1] + dz0 * ax[2], dx0 * ay[0] + dy0 * ay[1] + dz0 * ay[2], dx0 * az[0] + dy0 * az[1] + dz0 * az[2]];
  const p1 = [dx1 * ax[0] + dy1 * ax[1] + dz1 * ax[2], dx1 * ay[0] + dy1 * ay[1] + dz1 * ay[2], dx1 * az[0] + dy1 * az[1] + dz1 * az[2]];
  const ox = p0[0] / sx, oy = p0[1] / sy, oz = p0[2] / sz, dx = p1[0] / sx - ox, dy = p1[1] / sy - oy, dz = p1[2] / sz - oz;
  // Design units stretch a little differently along each axis: the ball is near enough round in them.
  const r = radius / Math.cbrt(sx * sy * sz);
  let tEnter = 0, tExit = 1;
  for (let c = 0; c < 3; c++) {
    const o = c === 0 ? ox : c === 1 ? oy : oz, d = c === 0 ? dx : c === 1 ? dy : dz, lo = min[c] - r, hi = max[c] + r;
    if (Math.abs(d) < 1e-9) {
      if (o < lo || o > hi) return null;
      continue;
    }
    const t1 = (lo - o) / d, t2 = (hi - o) / d;
    tEnter = Math.max(tEnter, Math.min(t1, t2));
    tExit = Math.min(tExit, Math.max(t1, t2));
    if (tEnter > tExit) return null;
  }
  return { p0, p1, ox, oy, oz, dx, dy, dz, r, sx, sy, sz };
}

// A shot into an old wound carries on into it: what its craters have eaten of her side no longer stops a ball, and it
// goes no further than the centre of her. Returns how far along the segment it now stops.
function shipFractionPastCraters(craters, segment, t) {
  const { ox, oy, oz, dx, dy, dz } = segment, x = ox + dx * t, y = oy + dy * t, z = oz + dz * t, side = x >= 0 ? 1 : -1;
  if (dx * side >= 0) return t;
  let eaten = 0;
  for (let c = 0; c < craters.length; c++) {
    const crater = craters[c];
    if (crater.side !== side) continue;
    const away = Math.hypot(y - crater.y, z - crater.z), reach = Math.max(0.18, crater.radius * 1.85);
    if (away < reach) eaten += crater.depth * (1 - away / reach) ** 2;
  }
  if (eaten <= 0) return t;
  const across = Math.min(Math.abs(x), eaten) / Math.abs(dx), along = eaten / Math.hypot(dx, dy, dz);
  return Math.min(1, t + Math.min(across, along));
}

export function sweepShipSegment(from, to, radius = 0.08, targetBoat, sourceBoat = null, options = null) {
  if (!targetBoat || targetBoat === sourceBoat || targetBoat.showProw === false) return null;
  const collider = shipColliderOf(targetBoat);
  if (!collider) return null;
  const segment = shipSegmentInFrame(from, to, radius, targetBoat, collider, collider.bounds);
  if (!segment) return null;
  const { p0, p1, sx, sy, sz } = segment, damage = targetBoat.damage;
  const hit = shipColliderTrace(collider, targetBoat, damage, segment.ox, segment.oy, segment.oz, segment.dx, segment.dy, segment.dz, segment.r);
  if (!hit) return null;
  const previewOnly = options?.previewOnly === true, mast = collider.mastOf[hit.triangle];
  const hitZone = mast ? 'rigging' : 'hull', struck = hit.triangle;
  const [nx, ny, nz] = shipColliderNormal(collider, hit);
  let t = Math.min(1, hit.t);
  if (!previewOnly && !mast && damage?.craters?.length) t = shipFractionPastCraters(damage.craters, segment, t);
  const localPosition = [p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t, p0[2] + (p1[2] - p0[2]) * t];
  // A normal stretches inversely to the frame, and faces back along the flight whichever side was struck.
  const faces = Math.sign((p1[0] - p0[0]) * nx / sx + (p1[1] - p0[1]) * ny / sy + (p1[2] - p0[2]) * nz / sz) || 1;
  const hitPart = previewOnly ? null : resolveShipHitPart(targetBoat, localPosition, hitZone, struck);
  return {
    fraction: t,
    kind: 'ship',
    targetBoat,
    targetId: targetBoat.id ?? targetBoat.modelId ?? 'ship',
    targetName: targetBoat.model?.name ?? targetBoat.modelId ?? 'Vessel',
    hitZone,
    mastGroup: mast ? collider.masts[mast - 1] : null,
    hitPartId: hitPart?.id ?? null,
    hitSubAssembly: hitPart?.subAssembly ?? null,
    hitLayer: hitPart?.layer ?? null,
    waterline: hitZone === 'hull' && localPosition[1] <= 0.75,
    localPosition,
    normal: vesselLocalToWorldNormal(targetBoat, [-faces * nx / sx, -faces * ny / sy, -faces * nz / sz]),
  };
}

// What a ball tears on its way through her, nearest first, up to `limit` along the segment. Canvas and rope do not stop
// it, so sweepShipSegment never answers for them. Costs nothing away from her.
const SHIP_NO_CROSSINGS = Object.freeze([]);
export function sweepShipRigging(from, to, radius = 0.08, targetBoat, sourceBoat = null, limit = 1, previewOnly = false) {
  if (!targetBoat || targetBoat === sourceBoat || targetBoat.showProw === false) return SHIP_NO_CROSSINGS;
  const collider = shipColliderOf(targetBoat);
  if (!collider) return SHIP_NO_CROSSINGS;
  const segment = shipSegmentInFrame(from, to, radius, targetBoat, collider, collider.softBounds);
  if (!segment) return SHIP_NO_CROSSINGS;
  const { p0, p1 } = segment;
  const crossings = shipColliderCrossings(collider, targetBoat, targetBoat.damage, segment.ox, segment.oy, segment.oz, segment.dx, segment.dy, segment.dz, segment.r, limit);
  return crossings.map(({ t, mast, triangle, rest, kind }) => {
    const localPosition = [p0[0] + (p1[0] - p0[0]) * t, p0[1] + (p1[1] - p0[1]) * t, p0[2] + (p1[2] - p0[2]) * t];
    const hitPart = previewOnly ? null : resolveShipHitPart(targetBoat, localPosition, 'rigging', triangle);
    return {
      fraction: t,
      kind: 'ship',
      targetBoat,
      targetId: targetBoat.id ?? targetBoat.modelId ?? 'ship',
      targetName: targetBoat.model?.name ?? targetBoat.modelId ?? 'Vessel',
      hitZone: 'rigging',
      riggingKind: kind,
      mastGroup: mast,
      hitPartId: hitPart?.id ?? null,
      hitSubAssembly: hitPart?.subAssembly ?? null,
      hitLayer: hitPart?.layer ?? null,
      waterline: false,
      localPosition,
      ripDesign: rest,
      normal: vesselLocalToWorldNormal(targetBoat, [p0[0] - p1[0], p0[1] - p1[1], p0[2] - p1[2]]),
    };
  });
}

// A ball that crosses a mast's canvas or rope flies on, and that mast's rig takes the hit, once a ball however many
// lines it parts. It is the same hit as any other on the rig, but for the ball's momentum, which it keeps.
// A tear's reach is in metres, whatever the size of the ship. The sail's mesh is in design units.
function sailRipRadius(boat, model, ammo) {
  const metres = ammo === 'grape' ? 3.2 : ammo === 'chain' ? 2.9 : 2.1, frame = model?.designFrame;
  return metres / Math.max(0.1, frame?.length ? (boat.length ?? frame.length) / frame.length : 1);
}

// The most a mast loses to one ball passing through its canvas or rope, the same limit as a hit near its foot.
const TEAR_MAST_LOSS = 0.065;

function tearRigWithBall(crossing, projectile, from, to, sourceBoat) {
  const { targetBoat: boat, mastGroup: mast } = crossing, torn = (projectile.tornRigs ??= new Map());
  const masts = torn.get(boat) ?? torn.set(boat, new Set()).get(boat);
  if (masts.has(mast)) return null;
  masts.add(mast);
  const velocity = projectile.velocity ?? [to[0] - from[0], to[1] - from[1], to[2] - from[2]], speed = Math.hypot(...velocity), mass = projectile.mass ?? 1;
  const at = [0, 1, 2].map((c) => from[c] + (to[c] - from[c]) * crossing.fraction);
  return applyShipImpactDamage(boat, { ...crossing, sourceBoat, position: at, surfacePosition: at, velocity, mass, radius: projectile.radius, ammo: projectile.ammo, energy: 0.5 * mass * speed * speed, passedThrough: true });
}

// A new fire joins any burning within 3.5 m, so repeated hits on one spot outrun the crew.
function addVesselFire(damage, localPos, event, addIntensity) {
  damage.fireCount = (damage.fireCount ?? 0) + 1;
  let mergedFire = false;
  for (const f of damage.fires) {
    const dist = Math.hypot(
      (f.localPosition[0] ?? 0) - (localPos?.[0] ?? 0),
      (f.localPosition[1] ?? 0) - (localPos?.[1] ?? 0),
      (f.localPosition[2] ?? 0) - (localPos?.[2] ?? 0),
    );
    if (dist < 3.5) {
      f.intensity = Math.min(1.6, f.intensity + addIntensity * 0.65);
      mergedFire = true;
      break;
    }
  }
  if (!mergedFire && damage.fires.length < 12) {
    damage.fires.push({
      localPosition: [...(localPos ?? [0, 1.5, 0])],
      hitZone: event.hitZone ?? 'hull',
      mastGroup: event.mastGroup ?? null,
      intensity: addIntensity,
      age: 0,
      seed: ((damage.hits * 0.61803398875) % 1) || 0.37,
    });
  }
  damage.fireIntensity = +damage.fires.reduce((s, f) => s + f.intensity, 0).toFixed(3);
}

// An arrow cannot breach a hull. It wounds only a body it reaches, and a lit one can
// catch tarred rope or canvas. Crews douse a lone small fire, but several landing
// together grow past what they can put out.
export const ARROW_FIRE_INTENSITY = 0.22;
export function applyArrowImpact(targetBoat, event) {
  const damage = createVesselDamageState(targetBoat);
  damage.hits = (damage.hits ?? 0) + 1;
  const c = damage.crewCasualties;
  const hitZone = event.hitZone ?? 'hull';
  const roll = (damage.hits * 0.6180339887 + (event.shotId ?? 0) * 0.7548776662) % 1;
  // Only a body the arrow reached is hurt, and the arrow stays in it.
  const killed = event.sailor ? (roll < 0.2 ? 1 : 0) : 0;
  const wounded = event.sailor && !killed ? 1 : 0;
  if (event.sailor) recordCrewWound(event.sailor, 'arrow', event.localPosition, vesselWorldToLocalVector(targetBoat, event.velocity ?? [0, 0, 1]));
  const casualties = applyCrewCasualtiesAndMorale(targetBoat, event, {
    casualties: { killed, wounded },
    hitZone,
    struck: event.sailor ? { sailor: event.sailor, direction: vesselWorldToLocalVector(targetBoat, event.velocity ?? [0, 0, 1]), speed: 0.5 } : null,
  });
  event.casualties = (casualties?.killed ?? 0) + (casualties?.wounded ?? 0);
  event.sex = event.sailor?.sex ?? casualties?.sex ?? 'male';
  const localPos = event.localPosition ?? vesselWorldToLocal(targetBoat, event.surfacePosition ?? event.position ?? [targetBoat.x ?? 0, 1, targetBoat.z ?? 0]);
  const catchChance = event.ammo !== 'fire-arrow' || event.waterline ? 0 : hitZone === 'rigging' ? 0.55 : 0.28;
  const fireRoll = (roll * 7.3890560989) % 1;
  if (fireRoll < catchChance) addVesselFire(damage, localPos, event, ARROW_FIRE_INTENSITY);
  damage.revision = (damage.revision ?? 0) + 1;
  const report = {
    kind: 'ship',
    ammo: event.ammo,
    targetId: targetBoat.id ?? targetBoat.modelId ?? 'ship',
    targetName: targetBoat.model?.name ?? targetBoat.modelId ?? 'Vessel',
    hitZone,
    mastGroup: event.mastGroup ?? null,
    hitPartId: event.hitPartId ?? null,
    hullIntegrity: +(damage.hullIntegrity ?? 1).toFixed(3),
    rigIntegrity: +(damage.rigIntegrity ?? 1).toFixed(3),
    breaches: damage.breaches ?? 0,
    fires: damage.fires?.length ?? 0,
    fireIntensity: +(damage.fireIntensity ?? 0).toFixed(2),
    sunk: Boolean(damage.sunk),
    casualtiesKilled: casualties?.killed ?? 0,
    casualtiesWounded: casualties?.wounded ?? 0,
    crewAble: c?.able ?? 0,
    crewWounded: c?.wounded ?? 0,
    crewKilled: c?.killed ?? 0,
    crewTotal: c?.total ?? 0,
    battleMorale: +(damage.battleMorale ?? 1).toFixed(3),
    moraleState: damage.moraleState ?? 'steady',
    surrendered: Boolean(damage.surrendered),
    colors: targetBoat.colors ?? DEFAULT_SHIP_COLORS,
  };
  damage.lastHit = report;
  return report;
}

export function applyShipImpactDamage(targetBoat, event) {
  if (!targetBoat || !event) return null;
  const damage = createVesselDamageState(targetBoat);
  let estimatedLeak = null;
  const vel = event.velocity ?? [200, 0, 0];
  const speed = Math.hypot(vel[0], vel[1], vel[2]);
  const mass = event.mass ?? 5.4;
  const energy = event.energy ?? (0.5 * mass * speed * speed);
  const pos = event.surfacePosition ?? event.position ?? [targetBoat.x ?? 0, targetBoat.heave ?? 0, targetBoat.z ?? 0];
  const scale = event.passedThrough ? 0 : event.hitZone === 'rigging' ? 0.35 : 1.0;
  applyRigidHullImpulse(targetBoat, pos, [vel[0] * mass * scale, vel[1] * mass * scale, vel[2] * mass * scale]);

  const localPos = event.localPosition ?? vesselWorldToLocal(targetBoat, pos);
  const resolvedPart = event.hitPartId
    ? { id: event.hitPartId, subAssembly: event.hitSubAssembly ?? null, layer: event.hitLayer ?? null }
    : resolveShipHitPart(targetBoat, localPos, event.hitZone);
  const hitPartId = resolvedPart?.id ?? (event.hitZone === 'rigging' ? `sail.${event.mastGroup ?? 'main'}` : 'hull.shell');
  const hitSubAssembly =
    resolvedPart?.subAssembly ?? (event.hitZone === 'rigging' ? 'rigging-and-sails' : 'hull-and-bulwarks');

  const ammo = GUNNERY_AMMO_TYPES.includes(event.ammo) ? event.ammo : 'round';
  const rigMul = ammo === 'chain' ? 3.2 : ammo === 'grape' ? 2.4 : ammo === 'hot' ? 1.35 : 1.0;
  const hullPenMul = ammo === 'chain' ? 0.32 : ammo === 'grape' ? 0.25 : ammo === 'hot' ? 0.85 : 1.0;
  const effectiveRigEnergy = energy * rigMul;
  const effectiveHullEnergy = energy * hullPenMul;

  const modelId = targetBoat.model?.id ?? targetBoat.modelId;
  const model = modelId ? SHIP_MODELS[modelId] : null;
  const mastSpecs = getModelMastSpecs(modelId);
  const designPt = localToShipDesignPoint(targetBoat, localPos);
  const isSuperstructureHit =
    event.hitZone !== 'rigging' &&
    (isSuperstructurePartId(hitPartId) || (designPt != null && designPt[1] >= 1.42));
  damage.hits++;
  if (event.hitZone === 'rigging') {
    damage.rigHits++;
    damage.sailRips = (damage.sailRips ?? 0) + 1;
    // A ball through canvas or rope tears it and flies on. That is no blow to the mast, however heavy the ball.
    const rigBlow = event.passedThrough ? Math.min(effectiveRigEnergy, (TEAR_MAST_LOSS / 1.8) * damage.maxRigEnergy) : effectiveRigEnergy;
    damage.rigDamageJoules += rigBlow;
    const validGroups = mastSpecs.map((m) => m[0]);
    const requestedGroup = event.mastGroup && Object.hasOwn(damage.mastIntegrity, event.mastGroup) ? event.mastGroup : 'main';
    const group =
      validGroups.length === 0 || validGroups.includes(requestedGroup)
        ? requestedGroup
        : validGroups[0];
    const prevInt = Math.max(0.05, damage.mastIntegrity[group] ?? 1);
    damage.mastIntegrity[group] = Math.max(0, damage.mastIntegrity[group] - (rigBlow / damage.maxRigEnergy) * 1.8);
    damage.rigIntegrity = computeModelRigIntegrity(damage, mastSpecs);
    const sailKey = group === 'fore' ? 'sailFore' : group === 'mizzen' ? 'sailMizzen' : 'sailMain';
    if (typeof targetBoat[sailKey] === 'number') {
      const ratio = damage.mastIntegrity[group] / prevInt;
      targetBoat[sailKey] = Math.min(targetBoat[sailKey] * ratio, damage.mastIntegrity[group]);
    }
    const specEntry = mastSpecs.find((m) => m[0] === group);
    const mastDefaultZ = specEntry ? specEntry[1] : group === 'fore' ? -3.55 : group === 'mizzen' ? 3.53 : 0.05;
    // A ball through canvas knows where on the sail it went. Anything else tears what hangs near where it struck.
    const ripX = event.ripDesign?.[0] ?? (designPt ? Math.max(-1.85, Math.min(1.85, designPt[0])) : 0);
    const ripY = event.ripDesign?.[1] ?? (designPt ? Math.max(2.4, Math.min(8.4, designPt[1])) : 4.8);
    const ripZ = event.ripDesign?.[2] ?? (designPt ? Math.max(-5.6, Math.min(5.6, designPt[2])) : mastDefaultZ);
    const ripRadius = sailRipRadius(targetBoat, model, ammo);
    const ripSeverity = ammo === 'chain' ? 1.40 : ammo === 'grape' ? 1.25 : 0.92;
    damage.pendingBakes.push({
      kind: 'sail-rip',
      modelId,
      x: +ripX.toFixed(3),
      y: +ripY.toFixed(3),
      z: +ripZ.toFixed(3),
      mastGroup: group,
      ammo,
      radius: ripRadius,
      severity: ripSeverity,
      hits: damage.sailRips,
    });
  } else {
    damage.hullHits++;
    damage.hullDamageJoules += effectiveHullEnergy;
    damage.hullIntegrity = Math.max(0, 1 - damage.hullDamageJoules / damage.maxHullEnergy);
    if (isSuperstructureHit) {
      damage.superstructureHits = (damage.superstructureHits ?? 0) + 1;
      damage.superstructureDamageJoules = (damage.superstructureDamageJoules ?? 0) + effectiveHullEnergy;
      const maxSuperEnergy = Math.max(25000, damage.maxHullEnergy * 0.38);
      damage.superstructureIntegrity = Math.max(
        0,
        +(1 - damage.superstructureDamageJoules / maxSuperEnergy).toFixed(4)
      );
    }
    const hitSideSign = (localPos?.[0] ?? 0) >= 0 ? 1 : -1;
    const hitTrimSign = Math.max(-1, Math.min(1, (localPos?.[2] ?? 0) / Math.max(6, (targetBoat.length ?? 20) * 0.4)));
    const trimWeight = Math.abs(hitTrimSign) > 0.08 ? hitTrimSign : -0.35;
    damage.hullSideMoment = (damage.hullSideMoment ?? 0) + hitSideSign * effectiveHullEnergy;
    damage.hullTrimMoment = (damage.hullTrimMoment ?? 0) + trimWeight * effectiveHullEnergy;
    const halfL = Math.max(6, (targetBoat.length ?? 20) * 0.5);
    const localZ = localPos?.[2] ?? 0;
    const compSection = localZ < -halfL * 0.28 ? 'fore' : localZ > halfL * 0.28 ? 'aft' : 'mid';
    const compSide = hitSideSign >= 0 ? 'Starboard' : 'Port';
    const compKey = `${compSection}${compSide}`;
    const comp = damage.compartments?.[compKey];
    const lowGunDeckBreach = (localPos?.[1] ?? 99) <= 2.65 && effectiveHullEnergy >= 180000;
    const nearWaterline = event.waterline || pos[1] <= (targetBoat.heave ?? 0) + 0.85 || lowGunDeckBreach;
    if (nearWaterline && ammo !== 'chain') {
      damage.breaches++;
      const lowDeckScale = event.waterline || pos[1] <= (targetBoat.heave ?? 0) + 0.85 ? 1.0 : 0.42;
      const holeR = Math.max(0.065, event.radius ?? 0.08) * 1.75;
      const holeArea = Math.PI * holeR * holeR * (ammo === 'grape' ? 0.22 : 1.0) * lowDeckScale;
      damage.waterlineBreachArea = +(damage.waterlineBreachArea + holeArea).toFixed(5);
      if (comp) comp.breachArea = +(comp.breachArea + holeArea).toFixed(5);
      estimatedLeak = { comp, area: holeArea };
      damage.breachSideMoment = +(damage.breachSideMoment + hitSideSign * holeArea).toFixed(5);
      damage.breachTrimMoment = +(damage.breachTrimMoment + trimWeight * holeArea).toFixed(5);
      // Initial splash ingress at the instant of breach is small; the bulk of seawater pours in progressively over time.
      const floodAdd = (mass / 24) * (1.0 + (1 - damage.hullIntegrity) * 0.8) * (ammo === 'grape' ? 0.25 : 1.0) * lowDeckScale;
      if (comp) comp.waterTonnes = +(comp.waterTonnes + floodAdd).toFixed(3);
      damage.floodingTonnes = +(damage.floodingTonnes + floodAdd).toFixed(3);
      targetBoat.cargoTonnes = Math.min(100, (targetBoat.cargoTonnes ?? 0) + floodAdd);
      if (targetBoat.hydrodynamics && Number.isFinite(targetBoat.length) && Number.isFinite(targetBoat.beam)) {
        targetBoat.hydrodynamics = boatHydrodynamics(
          targetBoat.length,
          targetBoat.beam,
          targetBoat.provisionDays ?? 30,
          targetBoat.cargoTonnes,
          targetBoat.modelId,
        );
      }
      const wpArea = Math.max(2.5, targetBoat.hydrodynamics?.waterplaneArea ?? ((targetBoat.length ?? 20) * (targetBoat.beam ?? 6) * 0.72));
      damage.floodingSinkage = +((damage.floodingTonnes * 1000) / (1025 * wpArea)).toFixed(4);
    } else if (damage.hullIntegrity <= 0.15 && ammo !== 'chain' && (!isSuperstructureHit || (designPt && designPt[1] <= 1.25))) {
      // Heavy topside battering springs garboard & waterline oak seams so water begins leaking into the hold over time.
      const seamArea = 0.018;
      damage.breaches++;
      damage.waterlineBreachArea = +(damage.waterlineBreachArea + seamArea).toFixed(5);
      if (comp) comp.breachArea = +(comp.breachArea + seamArea).toFixed(5);
    }
  }

  // Hot shot (heated to ~900 C in a shot furnace) lodges in timber or canvas and ignites shipboard fires.
  // Heavy solid-shot battering on damaged upper decks/superstructures can also ignite spilled cartridge powder and tarred oakum.
  const canCombatIgnite =
    ammo === 'round' &&
    !event.waterline &&
    (localPos?.[1] ?? 1) >= 0.45 &&
    damage.hullIntegrity < 0.72 &&
    (damage.hits % 3 === 0) &&
    damage.fires.length < 3;
  if (ammo === 'hot' || canCombatIgnite) {
    const addIntensity = ammo === 'hot'
      ? Math.min(1.2, 0.48 + energy / 550000)
      : Math.min(0.92, 0.56 + energy / 680000);
    addVesselFire(damage, localPos, event, addIntensity);
  }

  const partBudget = Math.min(
    1100000,
    (event.hitZone === 'rigging' ? damage.maxRigEnergy : damage.maxHullEnergy) * 0.18
  );
  const deltaDamage = (event.passedThrough ? Math.min(energy, (TEAR_MAST_LOSS / 1.8) * damage.maxRigEnergy) : energy) / Math.max(10000, partBudget);
  const prevPartDamage = damage.partDamage[hitPartId] ?? 0;
  const nextPartDamage = Math.min(1, +(prevPartDamage + deltaDamage).toFixed(3));
  damage.partDamage[hitPartId] = nextPartDamage;

  if (designPt && model?.status === 'ready') {
    try {
      let catalog = targetBoat.partAssembly?.catalog ?? targetBoat.partAssembly ?? targetBoat.asset?.partAssembly;
      if (!catalog?.parts) {
        if (!gunneryShipAssetCache) gunneryShipAssetCache = createShipAssetCache();
        catalog = gunneryShipAssetCache.get(modelId)?.partAssembly;
      }
      if (catalog?.parts) {
        const splashR = 0.78;
        for (const part of catalog.parts) {
          const b = part.bounds;
          const spanZ = b.max[2] - b.min[2];
          if (
            part.id === hitPartId ||
            part.triangleCount <= 0 ||
            spanZ > 3.2 ||
            part.id.startsWith('hull.planking') ||
            part.id.startsWith('deck.')
          ) {
            continue;
          }
          const dx = designPt[0] < b.min[0] ? b.min[0] - designPt[0] : designPt[0] > b.max[0] ? designPt[0] - b.max[0] : 0;
          const dy = designPt[1] < b.min[1] ? b.min[1] - designPt[1] : designPt[1] > b.max[1] ? designPt[1] - b.max[1] : 0;
          const dz = designPt[2] < b.min[2] ? b.min[2] - designPt[2] : designPt[2] > b.max[2] ? designPt[2] - b.max[2] : 0;
          const d = Math.hypot(dx, dy, dz);
          if (d <= splashR) {
            const falloff = 1 - d / splashR;
            const add = deltaDamage * (0.55 + 0.55 * falloff);
            damage.partDamage[part.id] = Math.min(1, +((damage.partDamage[part.id] ?? 0) + add).toFixed(3));
          }
        }
      }
    } catch {
      // Ignore optional splash catalog errors.
    }
  }

  let penetratedOuter = false;
  let enteredThroughWindow = false;
  let hitBackWall = false;
  if (designPt && event.hitZone !== 'rigging') {
    const side = designPt[0] >= 0 ? 1 : -1;
    const surfaceX = Math.max(-1.62, Math.min(1.62, designPt[0]));
    const siteSeverity = Math.min(1, Math.max(0.48, Math.cbrt(energy / 95000) * 0.65));

    const victoryGunDecks = [
      { centre: 0.38, n: 15, start: -5.12, end: 5.05 },
      { centre: 0.88, n: 14, start: -4.9, end: 4.85 },
      { centre: 1.38, n: 15, start: -5.05, end: 5.05 },
      { centre: 1.88, n: 6, start: 1.98, end: 4.12 },
      { centre: 1.88, n: 2, start: -4.65, end: -4.12 },
    ];
    const isVictory = (modelId ?? 'victory') === 'victory';
    const isGlazedWindow =
      hitPartId?.includes('window') ||
      hitPartId?.includes('gallery') ||
      (isVictory && designPt[2] >= 5.25 && designPt[1] >= 0.80 && designPt[1] <= 2.65) ||
      (!isVictory && designPt[2] >= 4.10 && designPt[1] >= 0.55 && Math.abs(designPt[0]) <= 1.25);
    let isOpenGunport = Boolean(hitPartId?.startsWith('gun.'));
    if (!isOpenGunport && isVictory) {
      for (const gd of victoryGunDecks) {
        if (Math.abs(designPt[1] - gd.centre) > 0.115) continue;
        const step = (gd.end - gd.start) / (gd.n - 1);
        const idx = Math.max(0, Math.min(gd.n - 1, Math.round((designPt[2] - gd.start) / step)));
        const gz = gd.start + idx * step;
        if (Math.abs(designPt[2] - gz) <= 0.125) {
          isOpenGunport = true;
          break;
        }
      }
    }
    enteredThroughWindow = isGlazedWindow || isOpenGunport;
    if (enteredThroughWindow) {
      damage.windowHits = (damage.windowHits ?? 0) + 1;
    }

    // Stage 1: Outer oak planking, window glass, or open gunport penetration physics.
    // Glass windows (12 kJ) and open gunports (35 kJ) let cannonballs pass straight into the
    // ship's interior with nearly full kinetic energy; solid hull planking scales by vessel class.
    const hullPlankingCost = isVictory
      ? 210000
      : modelId === 'flying-cloud'
        ? 65000
        : modelId === 'santa-maria' || modelId === 'nina' || modelId === 'pinta'
          ? 28000
          : modelId === 'taino-canoe'
            ? 6000
            : 14000;
    const energyCostOuter = isGlazedWindow ? 12000 : isOpenGunport ? 35000 : hullPlankingCost;
    const penEnergy = isGlazedWindow ? energy : effectiveHullEnergy;
    penetratedOuter = penEnergy >= energyCostOuter;
    let residualEnergy = Math.max(0, penEnergy - energyCostOuter);
    if (penetratedOuter) damage.throughBreaches = (damage.throughBreaches ?? 0) + 1;
    const bustsThrough = penetratedOuter && !enteredThroughWindow && localPos && (ammo === 'round' || ammo === 'hot');
    // Oak tears well beyond the ball itself, and more on the way out.
    const holeRadius = Math.max(0.07, event.radius ?? 0.08) * 2.6;
    if (bustsThrough) {
      // A shot recorded as striking at the waterline holes her there, wherever its contact point was taken.
      const holeLocal = [...localPos];
      if (event.waterline) holeLocal[1] = Math.min(holeLocal[1], -(targetBoat.heave ?? 0) - holeRadius * 0.5);
      addHullHole(damage, { design: [surfaceX, designPt[1], designPt[2]], local: holeLocal, radius: holeRadius, side, compartment: hullHoleCompartment(targetBoat, localPos[2], side) });
      // The real hole now governs the water, in place of the leak estimated from the hit alone.
      if (estimatedLeak) {
        if (estimatedLeak.comp) estimatedLeak.comp.breachArea = Math.max(0, +(estimatedLeak.comp.breachArea - estimatedLeak.area).toFixed(5));
        damage.waterlineBreachArea = Math.max(0, +(damage.waterlineBreachArea - estimatedLeak.area).toFixed(5));
      }
    }

    const isAftCabinShock = isVictory && designPt[2] >= 3.85 && designPt[1] >= 0.72 && energy >= 45000;
    if (isGlazedWindow || isAftCabinShock) {
      let winBakeX, winBakeY, winBakeZ;
      if (isVictory) {
        const winTier = designPt[1] < 1.32 ? 0 : designPt[1] < 1.82 ? 1 : 2;
        const tierCenterY = [1.03, 1.55, 2.05][winTier];
        const winPart = `stern.gallery.${winTier}.windows`;
        damage.partDamage[winPart] = Math.min(1, +((damage.partDamage[winPart] ?? 0) + Math.max(0.45, deltaDamage * 1.4)).toFixed(3));
        damage.partDamage['stern.galleries'] = Math.min(1, +((damage.partDamage['stern.galleries'] ?? 0) + deltaDamage * 0.85).toFixed(3));
        winBakeX = Math.abs(designPt[0]) < 0.95 ? designPt[0] : side * (0.45 + ((damage.hits * 0.29) % 0.65));
        winBakeZ = Math.abs(designPt[0]) < 0.95 || !isGlazedWindow ? 6.16 : Math.max(5.45, designPt[2]);
        winBakeY = isGlazedWindow ? Math.max(0.95, Math.min(2.25, designPt[1])) : tierCenterY;
      } else {
        const winPart = hitPartId?.includes('window')
          ? hitPartId
          : designPt[2] >= 4.0
            ? 'stern.windows'
            : hitPartId;
        if (winPart) {
          damage.partDamage[winPart] = Math.min(1, +((damage.partDamage[winPart] ?? 0) + Math.max(0.45, deltaDamage * 1.4)).toFixed(3));
        }
        if (modelId === 'nina') {
          damage.partDamage.cabin = Math.min(1, +((damage.partDamage.cabin ?? 0) + deltaDamage * 0.85).toFixed(3));
        }
        winBakeX = designPt[0];
        winBakeY = designPt[1];
        winBakeZ = designPt[2] >= 4.8 ? Math.max(5.55, designPt[2]) : designPt[2];
      }
      damage.pendingBakes.push({
        kind: 'window-shatter',
        modelId,
        x: +winBakeX.toFixed(3),
        y: +winBakeY.toFixed(3),
        z: +winBakeZ.toFixed(3),
        side,
        radius: 0.44,
        stepDepth: 0.28,
        severity: 1.05,
        hits: 1,
      });
      damage.craters.push({
        x: +winBakeX.toFixed(3),
        y: +winBakeY.toFixed(3),
        z: +winBakeZ.toFixed(3),
        side,
        radius: 0.14,
        depth: 0.32,
        severity: 1.15,
        hits: 2,
      });
    }

    const stepDepth = penetratedOuter
      ? Math.min(0.42, Math.max(0.24, siteSeverity * 0.32))
      : Math.min(0.19, Math.max(0.11, siteSeverity * 0.16));
    const baseRadius = penetratedOuter
      ? Math.min(0.088, Math.max(0.068, 0.060 + siteSeverity * 0.026))
      : Math.min(0.062, Math.max(0.048, 0.044 + siteSeverity * 0.016));

    let matchedCrater = null;
    let bestCrater = null;
    let bestDist = Infinity;
    let sideCraters = 0;
    for (const cr of damage.craters) {
      if (cr.side !== side) continue;
      sideCraters++;
      const dist = Math.hypot((cr.y - designPt[1]) * 1.12, (cr.z - designPt[2]) * 1.02);
      if (dist < bestDist) {
        bestDist = dist;
        bestCrater = cr;
      }
    }
    if (bestCrater && (bestDist < 0.27 || (sideCraters >= 34 && bestDist < 0.58))) {
      const cr = bestCrater;
      cr.hits = (cr.hits ?? 1) + 1;
      cr.depth = Math.min(1.45, +(cr.depth + stepDepth * 0.85).toFixed(3));
      const rStep = 0.052 / Math.sqrt(Math.max(1, cr.hits - 0.6));
      cr.radius = Math.min(0.215, +(cr.radius + rStep).toFixed(3));
      cr.severity = Math.min(1.5, +(cr.severity + siteSeverity * 0.52).toFixed(3));
      cr.x = +(cr.x - side * stepDepth * 0.65).toFixed(3);
      cr.y = +(cr.y * 0.84 + designPt[1] * 0.16).toFixed(3);
      cr.z = +(cr.z * 0.84 + designPt[2] * 0.16).toFixed(3);
      matchedCrater = cr;
    }
    if (!matchedCrater) {
      matchedCrater = {
        x: +surfaceX.toFixed(3),
        y: +designPt[1].toFixed(3),
        z: +designPt[2].toFixed(3),
        side,
        radius: +baseRadius.toFixed(3),
        depth: +stepDepth.toFixed(3),
        severity: +siteSeverity.toFixed(3),
        hits: 1,
      };
      damage.craters.push(matchedCrater);
    }
    damage.cratersRevision = (damage.cratersRevision ?? 0) + 1;

    damage.pendingBakes.push({
      modelId,
      superstructure: isSuperstructureHit,
      x: matchedCrater.x,
      y: +designPt[1].toFixed(3),
      z: +designPt[2].toFixed(3),
      side,
      radius: matchedCrater.radius,
      stepDepth: +stepDepth.toFixed(3),
      totalDepth: matchedCrater.depth,
      severity: +siteSeverity.toFixed(3),
      totalSeverity: matchedCrater.severity,
      hits: matchedCrater.hits,
    });

    // Stage 2: Direct cannon hits & interior gun-deck penetration.
    // Check if the shot struck an entry-side cannon or, after penetrating, an opposite-side cannon.
    // boat.gunnery is the gun state itself on live vessels.
    const targetGuns = targetBoat.gunnery?.guns ?? targetBoat.gunnery?.state?.guns;
    if (Array.isArray(targetGuns) && targetGuns.length > 0) {
      for (const g of targetGuns) {
        if (g.dismounted) continue;
        const gSide = g.side === 'starboard' ? 1 : -1;
        if (gSide !== side && (!penetratedOuter || residualEnergy < 220000)) continue;
        const mPt = g.muzzleDesign ?? g.breechDesign;
        if (!mPt) continue;
        const dGun = Math.hypot(mPt[1] - designPt[1], mPt[2] - designPt[2]);
        if (dGun < (gSide === side ? 0.25 : 0.20)) {
          g.dismounted = true;
          g.loading = false;
          g.queued = false;
          damage.dismountedGuns = (damage.dismountedGuns ?? 0) + 1;
          residualEnergy = Math.max(0, residualEnergy - 320000);
          damage.pendingBakes.push({
            kind: 'cannon-dismount',
            x: +(gSide * 1.35).toFixed(3),
            y: +mPt[1].toFixed(3),
            z: +mPt[2].toFixed(3),
            side: gSide,
            radius: 0.24,
            stepDepth: 0.28,
            severity: 0.95,
            hits: 2,
          });
          break;
        }
      }
    } else if (isVictory) {
      damage.dismountedPorts ??= new Set();
      for (const gd of victoryGunDecks) {
        if (Math.abs(designPt[1] - gd.centre) > 0.24) continue;
        const step = (gd.end - gd.start) / (gd.n - 1);
        const idx = Math.max(0, Math.min(gd.n - 1, Math.round((designPt[2] - gd.start) / step)));
        const gz = gd.start + idx * step;
        const key = `${side}:${gd.centre.toFixed(2)}:${idx}`;
        if (Math.abs(designPt[2] - gz) < 0.26 && !damage.dismountedPorts.has(key)) {
          damage.dismountedPorts.add(key);
          damage.dismountedGuns = (damage.dismountedGuns ?? 0) + 1;
          residualEnergy = Math.max(0, residualEnergy - 320000);
          damage.pendingBakes.push({
            kind: 'cannon-dismount',
            x: +(side * 1.45).toFixed(3),
            y: +gd.centre.toFixed(3),
            z: +gz.toFixed(3),
            side,
            radius: 0.26,
            stepDepth: 0.28,
            severity: 0.95,
            hits: 2,
          });
          break;
        }
      }
    }

    // Stage 3: 3D interior trajectory through cabin bulkheads, internal gun decks, transverse beams,
    // lower mast trunks, and the far/back wall of the hull.
    if (penetratedOuter && residualEnergy > 45000) {
      const localVel = vesselWorldToLocalVector(targetBoat, vel);
      const rawDir = localToShipDesignPoint(targetBoat, localVel) ?? [-side, 0, 0];
      const dirLen = Math.hypot(rawDir[0], rawDir[1], rawDir[2]) || 1;
      const dir = [rawDir[0] / dirLen, rawDir[1] / dirLen, rawDir[2] / dirLen];
      const midPt = [
        designPt[0] + dir[0] * 0.85,
        designPt[1] + dir[1] * 0.85,
        designPt[2] + dir[2] * 0.85,
      ];

      // 3a. Cabin back wall & internal bulkheads (e.g. shot entering through stern/quarter windows)
      if (isGlazedWindow || Math.abs(dir[2]) > 0.32) {
        for (const bz of getModelBulkheadZs(modelId)) {
          const crossesBulkhead =
            (designPt[2] - bz) * (designPt[2] + dir[2] * 3.2 - bz) <= 0 ||
            Math.abs(designPt[2] - bz) < 0.35;
          if (crossesBulkhead && residualEnergy > 45000) {
            const bPart =
              modelId === 'nina'
                ? 'cabin'
                : bz > 5.0
                  ? 'hull.closure.stern'
                  : `deck.bulkhead.${bz}`;
            damage.partDamage[bPart] = Math.min(1, +((damage.partDamage[bPart] ?? 0) + Math.max(0.32, deltaDamage * 0.95)).toFixed(3));
            if (isVictory && bz > 5.0) {
              const winTier = designPt[1] < 1.29 ? 0 : designPt[1] < 1.80 ? 1 : 2;
              const rearPart = `stern.gallery.${winTier}.rear`;
              damage.partDamage[rearPart] = Math.min(1, +((damage.partDamage[rearPart] ?? 0) + Math.max(0.35, deltaDamage)).toFixed(3));
            }
            hitBackWall = true;
            damage.backWallHits = (damage.backWallHits ?? 0) + 1;
            const sBulk = Math.abs(dir[2]) > 0.15 ? Math.max(0.1, Math.min(3.2, (bz - designPt[2]) / dir[2])) : 0.4;
            damage.pendingBakes.push({
              kind: 'internal-deck',
              modelId,
              x: +Math.max(-1.35, Math.min(1.35, designPt[0] + dir[0] * sBulk)).toFixed(3),
              y: +Math.max(-0.35, Math.min(2.15, designPt[1] + dir[1] * sBulk)).toFixed(3),
              z: +bz.toFixed(3),
              side,
              radius: 0.32,
              stepDepth: 0.24,
              severity: 0.85,
              hits: 1,
            });
            residualEnergy = Math.max(0, residualEnergy - 110000);
          }
        }
      }

      // 3b. Internal gun decks and transverse oak deck beams along the interior trajectory
      const sampleY = midPt[1];
      const deckId =
        sampleY < -0.18
          ? 'orlop'
          : sampleY < 0.35
            ? 'lower'
            : sampleY < 0.85
              ? 'middle'
              : 'upper';
      const intDeckPart = `deck.${deckId}.internal`;
      const intBeamPart = `frames.beams.${deckId === 'orlop' ? 'lower' : deckId}`;
      damage.partDamage[intDeckPart] = Math.min(1, +((damage.partDamage[intDeckPart] ?? 0) + deltaDamage * 0.85).toFixed(3));
      damage.partDamage[intBeamPart] = Math.min(1, +((damage.partDamage[intBeamPart] ?? 0) + deltaDamage * 0.75).toFixed(3));
      damage.pendingBakes.push({
        kind: 'internal-deck',
        modelId,
        x: +Math.max(-1.1, Math.min(1.1, midPt[0])).toFixed(3),
        y: +sampleY.toFixed(3),
        z: +Math.max(-5.4, Math.min(5.6, midPt[2])).toFixed(3),
        side,
        radius: 0.28,
        stepDepth: 0.20,
        severity: 0.75,
        hits: 1,
      });
      residualEnergy = Math.max(0, residualEnergy - 140000);

      // 3c. Penetrating shot striking an internal lower mast trunk/partners or severing chainwale shrouds
      // Evaluate closest approach along the interior ray segment [designPt, designPt + dir * 2.8]
      for (const [mGroup, mastZ] of mastSpecs) {
        let minDzMast = Math.abs(designPt[2] - mastZ);
        let minDxMast = Math.abs(designPt[0]);
        if (Math.abs(dir[2]) > 0.15) {
          const sM = Math.max(0, Math.min(2.8, (mastZ - designPt[2]) / dir[2]));
          const dZ = Math.abs(designPt[2] + dir[2] * sM - mastZ);
          const dX = Math.abs(designPt[0] + dir[0] * sM);
          if (dZ < minDzMast) {
            minDzMast = dZ;
            minDxMast = dX;
          }
        }
        if (minDzMast < 0.85 && (residualEnergy > 90000 || designPt[1] > 0.65)) {
          const isTrunkHit = minDzMast < 0.26 && minDxMast < 0.65;
          const maxStep = isTrunkHit ? 0.12 : 0.075;
          const rawDrop = (energy / damage.maxRigEnergy) * (isTrunkHit ? 0.95 : 0.55);
          const mastDrop = Math.min(maxStep, Math.max(isTrunkHit ? 0.075 : 0.045, rawDrop));
          const prevInt = Math.max(0.05, damage.mastIntegrity[mGroup] ?? 1);
          damage.mastIntegrity[mGroup] = Math.max(0, +(damage.mastIntegrity[mGroup] - mastDrop).toFixed(4));
          damage.rigIntegrity = computeModelRigIntegrity(damage, mastSpecs);
          const trunkPart = `mast.trunk.${mGroup}`;
          damage.partDamage[trunkPart] = Math.min(1, +((damage.partDamage[trunkPart] ?? 0) + deltaDamage * 1.1).toFixed(3));
          const sailKey = mGroup === 'fore' ? 'sailFore' : mGroup === 'mizzen' ? 'sailMizzen' : 'sailMain';
          if (typeof targetBoat[sailKey] === 'number') {
            const ratio = damage.mastIntegrity[mGroup] / prevInt;
            targetBoat[sailKey] = Math.min(targetBoat[sailKey] * ratio, damage.mastIntegrity[mGroup]);
          }
          residualEnergy = Math.max(0, residualEnergy - 280000);
          break;
        }
      }

      // 3c-ii. Upper-works / bulwark hits sever sheets, braces, halyards and lower courses overhead
      if (mastSpecs.length > 0 && (designPt[1] >= 0.85 || ammo === 'chain' || ammo === 'grape')) {
        let nearSpec = mastSpecs[0];
        let bestMastDz = Infinity;
        for (const spec of mastSpecs) {
          const d = Math.abs(designPt[2] - spec[1]);
          if (d < bestMastDz) {
            bestMastDz = d;
            nearSpec = spec;
          }
        }
        const nearGroup = nearSpec[0];
        const sheetDrop = Math.min(0.065, (effectiveRigEnergy / damage.maxRigEnergy) * (ammo === 'chain' ? 0.85 : ammo === 'grape' ? 0.65 : 0.42));
        if (sheetDrop > 0.004) {
          const prevInt = Math.max(0.05, damage.mastIntegrity[nearGroup] ?? 1);
          damage.mastIntegrity[nearGroup] = Math.max(0, +(damage.mastIntegrity[nearGroup] - sheetDrop).toFixed(4));
          damage.rigIntegrity = computeModelRigIntegrity(damage, mastSpecs);
          const sailKey = nearGroup === 'fore' ? 'sailFore' : nearGroup === 'mizzen' ? 'sailMizzen' : 'sailMain';
          if (typeof targetBoat[sailKey] === 'number') {
            const ratio = damage.mastIntegrity[nearGroup] / prevInt;
            targetBoat[sailKey] = Math.min(targetBoat[sailKey] * ratio, damage.mastIntegrity[nearGroup]);
          }
          if (designPt[1] >= 1.15 || ammo === 'chain' || ammo === 'grape') {
            damage.sailRips = (damage.sailRips ?? 0) + 1;
            const mastDefaultZ = nearSpec[1];
            damage.pendingBakes.push({
              kind: 'sail-rip',
              modelId,
              x: +Math.max(-1.65, Math.min(1.65, designPt[0] * 0.85)).toFixed(3),
              y: +(2.85 + ((damage.sailRips * 0.618) % 1) * 2.6).toFixed(3),
              z: +Math.max(-5.2, Math.min(5.2, mastDefaultZ + (designPt[2] - mastDefaultZ) * 0.35)).toFixed(3),
              mastGroup: nearGroup,
              ammo,
              radius: sailRipRadius(targetBoat, model, ammo),
              severity: ammo === 'chain' ? 1.25 : 0.85,
              hits: damage.sailRips,
            });
          }
        }
      }

      // 3d. Striking the back wall of the hull (opposite-side inner hull wall) after crossing the interior
      // A ball with enough left in it goes out through her far side as well.
      if (bustsThrough && dir[0] * side < -0.2 && residualEnergy >= energyCostOuter) {
        const farDesign = Math.abs(designPt[0]);
        const across = (-side * farDesign - designPt[0]) / dir[0];
        const exitDesign = [-side * farDesign, designPt[1] + dir[1] * across, designPt[2] + dir[2] * across];
        const toLocal = (i) => (Math.abs(designPt[i]) > 1e-3 ? localPos[i] / designPt[i] : 1);
        const exitLocal = [-localPos[0], localPos[1] + (exitDesign[1] - designPt[1]) * toLocal(1), localPos[2] + (exitDesign[2] - designPt[2]) * toLocal(2)];
        addHullHole(damage, { design: exitDesign, local: exitLocal, radius: holeRadius * 1.15, side: -side, compartment: hullHoleCompartment(targetBoat, exitLocal[2], -side) });
        damage.exitHoles = (damage.exitHoles ?? 0) + 1;
      }

      if (Math.abs(dir[0]) > 0.20 && residualEnergy >= 75000) {
        const backSide = dir[0] < 0 ? -1 : 1;
        if (backSide !== side || Math.abs(designPt[0]) < 0.65) {
          const targetBackX = backSide * Math.max(1.18, Math.abs(surfaceX));
          const sBack = Math.max(0.5, Math.min(3.6, (targetBackX - designPt[0]) / (dir[0] || backSide)));
          const backY = Math.max(-0.55, Math.min(2.15, designPt[1] + dir[1] * sBack));
          const backZ = Math.max(-5.5, Math.min(5.75, designPt[2] + dir[2] * sBack));
          hitBackWall = true;
          damage.backWallHits = (damage.backWallHits ?? 0) + 1;
          damage.partDamage['hull.planking'] = Math.min(1, +((damage.partDamage['hull.planking'] ?? 0) + deltaDamage * 0.65).toFixed(3));

          const backStepDepth = residualEnergy >= 220000 ? 0.25 : 0.15;
          damage.pendingBakes.push({
            kind: 'back-wall',
            x: +targetBackX.toFixed(3),
            y: +backY.toFixed(3),
            z: +backZ.toFixed(3),
            side: backSide,
            radius: 0.24,
            stepDepth: backStepDepth,
            severity: Math.min(1, +(siteSeverity * 0.85).toFixed(3)),
            hits: 1,
          });
        }
      }

      // 3e. Penetrating shot reaching the Grand or Aft Powder Magazine below the orlop deck.
      if (ammo !== 'chain' && ammo !== 'grape' && (residualEnergy >= 55000 || ammo === 'hot')) {
        let struckMagId =
          hitPartId === 'magazine.grand' || hitPartId === 'magazine.aft'
            ? hitPartId
            : event.hitZone === 'magazine'
              ? (designPt[2] > 0 ? 'magazine.aft' : 'magazine.grand')
              : null;
        if (!struckMagId) {
          for (let step = 0; step <= 8; step++) {
            const s = (step / 8) * 2.6;
            const px = designPt[0] + dir[0] * s;
            const py = designPt[1] + dir[1] * s;
            const pz = designPt[2] + dir[2] * s;
            if (py <= -0.18 && py >= -0.82 && Math.abs(px) <= 0.68) {
              if (pz >= -3.85 && pz <= -2.75) {
                struckMagId = 'magazine.grand';
                break;
              }
              if (pz >= 2.75 && pz <= 3.55 && Math.abs(px) <= 0.58) {
                struckMagId = 'magazine.aft';
                break;
              }
            }
          }
        }
        if (struckMagId) {
          detonateVesselMagazine(targetBoat, {
            magId: struckMagId,
            designPt,
            localPos,
            cause: ammo === 'hot' ? 'hot-shot' : 'shot',
          });
        }
      }
    } else if (
      (hitPartId === 'magazine.grand' || hitPartId === 'magazine.aft' || event.hitZone === 'magazine') &&
      ammo !== 'chain' &&
      ammo !== 'grape'
    ) {
      const struckMagId =
        hitPartId === 'magazine.aft' || (designPt && designPt[2] > 0) ? 'magazine.aft' : 'magazine.grand';
      detonateVesselMagazine(targetBoat, {
        magId: struckMagId,
        designPt,
        localPos,
        cause: ammo === 'hot' ? 'hot-shot' : 'shot',
      });
    }

    let merged = false;
    for (const site of damage.impactSites) {
      if (Math.hypot(site[0] - surfaceX, site[1] - designPt[1], site[2] - designPt[2]) < 0.28) {
        site[0] = matchedCrater.x;
        site[3] = Math.min(1.5, +(site[3] + siteSeverity * 0.55).toFixed(3));
        merged = true;
        break;
      }
    }
    if (!merged) {
      if (damage.impactSites.length >= 24) damage.impactSites.shift();
      damage.impactSites.push([
        +surfaceX.toFixed(3),
        +designPt[1].toFixed(3),
        +designPt[2].toFixed(3),
        +siteSeverity.toFixed(3),
      ]);
    }
  }

  // Stage 4: Progressive mast structural collapse (topmast shot away -> full mast dismasted by the board).
  const hitSide = designPt ? (designPt[0] >= 0 ? 1 : -1) : 1;
  damage.mastState ??= { fore: 0, main: 0, mizzen: 0 };
  let mastSpring = false, mastSnap = false;
  for (const [mGroup, mastZ, topPivotY, fullPivotY] of mastSpecs) {
    const mInt = damage.mastIntegrity[mGroup] ?? 1;
    const prevStage = damage.mastState[mGroup] ?? 0;
    if (mInt <= 0.62 && prevStage < 1) {
      damage.mastState[mGroup] = 1;
      mastSpring = true;
      queueMastBreak(damage, {
        kind: 'mast-break',
        modelId,
        mastGroup: mGroup,
        stage: 'topmast',
        side: hitSide,
        pivotY: topPivotY,
        pivotZ: mastZ,
      });
    }
    if (mInt <= 0.24 && prevStage < 2) {
      damage.mastState[mGroup] = 2;
      mastSnap = true;
      const sailKey = mGroup === 'fore' ? 'sailFore' : mGroup === 'mizzen' ? 'sailMizzen' : 'sailMain';
      if (typeof targetBoat[sailKey] === 'number') targetBoat[sailKey] = 0;
      queueMastBreak(damage, {
        kind: 'mast-break',
        modelId,
        mastGroup: mGroup,
        stage: 'full',
        side: hitSide,
        hadTopmastBreak: prevStage >= 1,
        pivotY: fullPivotY,
        pivotZ: mastZ,
      });
    }
  }
  damage.revision = (damage.revision ?? 0) + 1;

  const casualties = applyCrewCasualtiesAndMorale(
    targetBoat,
    { ammo, energy, hitZone: event.hitZone ?? 'hull' },
    {
      designPt,
      localPos,
      penetratedOuter,
      enteredThroughWindow,
      hitBackWall,
      isSuperstructureHit,
    },
  );
  const c = damage.crewCasualties;
  event.casualties = (casualties?.killed ?? 0) + (casualties?.wounded ?? 0);
  event.sex = casualties?.sex ?? 'male';
  event.mastSnap = mastSnap;
  event.mastSpring = mastSpring;
  event.timberCrumble = event.hitZone !== 'rigging';
  if ((mastSnap || mastSpring) && typeof targetBoat.crewEvents === 'function') {
    targetBoat.crewEvents({
      type: 'mast-snap',
      mastGroup: event.mastGroup ?? 'main',
      stage: mastSnap ? 'full' : 'topmast',
      position: pos,
    });
  }

  const mag = targetBoat.magazine ?? damage.magazine;
  const report = {
    kind: 'ship',
    ammo,
    targetId: targetBoat.id ?? targetBoat.modelId ?? 'ship',
    targetName: targetBoat.model?.name ?? targetBoat.modelId ?? 'Vessel',
    hitZone: event.hitZone ?? 'hull',
    mastGroup: event.mastGroup ?? null,
    hitPartId,
    hitSubAssembly,
    isSuperstructure: Boolean(isSuperstructureHit),
    partDamage: damage.partDamage[hitPartId] ?? nextPartDamage,
    hullIntegrity: +damage.hullIntegrity.toFixed(3),
    superstructureIntegrity: +(damage.superstructureIntegrity ?? 1).toFixed(3),
    superstructureHits: damage.superstructureHits ?? 0,
    rigIntegrity: +damage.rigIntegrity.toFixed(3),
    breaches: damage.breaches,
    throughBreaches: damage.throughBreaches ?? 0,
    dismountedGuns: damage.dismountedGuns ?? 0,
    windowHits: damage.windowHits ?? 0,
    backWallHits: damage.backWallHits ?? 0,
    enteredThroughWindow,
    hitBackWall,
    penetratedOuter,
    fires: damage.fires?.length ?? 0,
    fireIntensity: +(damage.fireIntensity ?? 0).toFixed(2),
    magazineHit: Boolean(damage.magazineHit),
    magazineExploded: Boolean(damage.magazineExploded),
    magazineDeflagrated: Boolean(mag?.deflagrated && !mag?.exploded),
    magazineExplosionYieldMj: +(damage.magazineExplosionYieldMj ?? 0).toFixed(1),
    powderRemainingKg: +(mag?.powderKg ?? 0).toFixed(1),
    sailRips: damage.sailRips ?? 0,
    bendingStrain: +(damage.bendingStrain ?? 0).toFixed(3),
    hullCracked: Boolean(damage.hullCracked),
    floodingTonnes: damage.floodingTonnes,
    floodingSinkage: +(damage.floodingSinkage ?? 0).toFixed(3),
    sunk: damage.sunk,
    energyKj: +(energy / 1000).toFixed(1),
    casualtiesKilled: casualties?.killed ?? 0,
    casualtiesWounded: casualties?.wounded ?? 0,
    crewAble: c?.able ?? 0,
    crewWounded: c?.wounded ?? 0,
    crewKilled: c?.killed ?? 0,
    crewTotal: c?.total ?? 0,
    battleMorale: +(damage.battleMorale ?? 1).toFixed(3),
    moraleState: damage.moraleState ?? 'steady',
    surrendered: Boolean(damage.surrendered),
    colors: targetBoat.colors ?? DEFAULT_SHIP_COLORS,
  };
  damage.lastHit = report;
  return report;
}

// Continuous time-domain progression of compartmentalized waterline breach flooding
// (Torricelli orifice flow minus bilge pumps & carpenter shot-plugging), asymmetric
// bow/stern rearing & beam-ends heel, longitudinal hull bending strain & back-cracking,
// and active shipboard fires started by glowing hot shot.
export function stepVesselDamage(boat, dt, terrain = null) {
  const damage = boat?.damage;
  if (!damage || damage.settledWreck || !(dt > 0) || !Number.isFinite(dt)) return;
  const clampedDt = Math.min(0.25, dt);

  // 1. Compartmentalized seawater ingress through waterline breaches: Q = Cd * A * sqrt(2 * g * h_eff).
  const hydro = boat.hydrodynamics;
  const wpArea = Math.max(2.5, hydro?.waterplaneArea ?? ((boat.length ?? 20) * (boat.beam ?? 6) * 0.72));
  const baseFreeboard = Math.max(0.35, Math.min(2.6, hydro?.freeboard ?? 1.8));
  const reserveBuoyancyTonnes = Math.max(1.5, (wpArea * baseFreeboard * 1025) / 1000);
  const maxFloodTonnes = Math.max(reserveBuoyancyTonnes * 1.65, wpArea >= 18 ? 200 : reserveBuoyancyTonnes * 1.65);
  const holeFlows = damage.holes?.length ? stepHullHoles(boat, damage, clampedDt) : null;
  if ((damage.waterlineBreachArea > 0 || holeFlows?.area > 0) && damage.floodingTonnes < maxFloodTonnes) {
    const comps = damage.compartments ?? (damage.compartments = {
      forePort: { breachArea: 0, waterTonnes: 0 },
      foreStarboard: { breachArea: 0, waterTonnes: 0 },
      midPort: { breachArea: 0, waterTonnes: 0 },
      midStarboard: { breachArea: 0, waterTonnes: 0 },
      aftPort: { breachArea: 0, waterTonnes: 0 },
      aftStarboard: { breachArea: 0, waterTonnes: 0 },
    });
    const compKeys = ['forePort', 'foreStarboard', 'midPort', 'midStarboard', 'aftPort', 'aftStarboard'];
    let sumCompBreach = 0;
    for (const k of compKeys) sumCompBreach += comps[k]?.breachArea ?? 0;
    if (sumCompBreach < damage.waterlineBreachArea * 0.5) {
      const fbSec = damage.breachTrimMoment < -1e-4 ? 'fore' : damage.breachTrimMoment > 1e-4 ? 'aft' : 'mid';
      const fbSide = damage.breachSideMoment >= 0 ? 'Starboard' : 'Port';
      const fbKey = `${fbSec}${fbSide}`;
      comps[fbKey].breachArea += damage.waterlineBreachArea - sumCompBreach;
    }

    // Carpenter's crew plugs minor shot holes and chain pumps discharge ~0.04 to 0.32 t/s.
    const pumpCapacity = (boat.modelId === 'victory' ? 0.32 : 0.045) * Math.max(0.2, damage.hullIntegrity);
    const curRoll = boat.roll ?? damage.floodingRoll ?? 0;
    const curPitch = boat.pitch ?? damage.floodingPitch ?? 0;
    const compMaxTonnes = maxFloodTonnes * 0.38;
    let totalBreachArea = 0;
    let totalNetAdd = 0;

    for (const k of compKeys) {
      const c = comps[k];
      const xSign = k.endsWith('Starboard') ? 1 : -1;
      const zSign = k.startsWith('fore') ? -1 : k.startsWith('aft') ? 1 : 0;
      const holeRate = holeFlows?.byCompartment[k] ?? 0;
      if (c.breachArea > 0 || holeRate > 0) {
        c.breachArea = Math.max(0, c.breachArea - 0.000025 * clampedDt * damage.hullIntegrity);
        totalBreachArea += c.breachArea;
        // Positive roll lifts her starboard side, and positive pitch lifts her bow.
        const heelSub = Math.max(-0.20, -curRoll * xSign * (boat.beam ?? 6) * 0.35);
        const trimSub = Math.max(-0.30, curPitch * zSign * (boat.length ?? 20) * 0.22);
        const headMetres = Math.max(0.18, 0.36 + (damage.floodingSinkage ?? 0) * 0.90 + heelSub + trimSub);
        const flowVelocity = 0.78 * Math.sqrt(2 * 9.81 * headMetres) * (1.55 + 1.15 * (1 - damage.hullIntegrity));
        const grossRate = (c.breachArea * flowVelocity * 1025) / 1000 + holeRate;
        const netRate = Math.max(0, grossRate - pumpCapacity * 0.22);
        if (netRate > 0 && c.waterTonnes < compMaxTonnes) {
          const add = Math.min(compMaxTonnes - c.waterTonnes, netRate * clampedDt);
          c.waterTonnes = +(c.waterTonnes + add).toFixed(3);
          totalNetAdd += add;
        }
      }
    }
    damage.waterlineBreachArea = +totalBreachArea.toFixed(5);
    damage.holeLeakArea = +(holeFlows?.area ?? 0).toFixed(5);

    // Slow bulkhead seepage / limber-hole spillover between adjacent compartments so one flooded
    // end sinks deep first before water gradually equalizes along the hold.
    const seep = 0.028 * clampedDt;
    for (const side of ['Port', 'Starboard']) {
      const f = comps[`fore${side}`], m = comps[`mid${side}`], a = comps[`aft${side}`];
      const fm = (f.waterTonnes - m.waterTonnes) * seep;
      const ma = (m.waterTonnes - a.waterTonnes) * seep;
      f.waterTonnes = Math.max(0, f.waterTonnes - fm);
      m.waterTonnes = Math.max(0, m.waterTonnes + fm - ma);
      a.waterTonnes = Math.max(0, a.waterTonnes + ma);
    }
    for (const sec of ['fore', 'mid', 'aft']) {
      const p = comps[`${sec}Port`], s = comps[`${sec}Starboard`];
      const ps = (s.waterTonnes - p.waterTonnes) * seep * 0.65;
      s.waterTonnes = Math.max(0, s.waterTonnes - ps);
      p.waterTonnes = Math.max(0, p.waterTonnes + ps);
    }

    const foreWater = comps.forePort.waterTonnes + comps.foreStarboard.waterTonnes;
    const midWater = comps.midPort.waterTonnes + comps.midStarboard.waterTonnes;
    const aftWater = comps.aftPort.waterTonnes + comps.aftStarboard.waterTonnes;
    const portWater = comps.forePort.waterTonnes + comps.midPort.waterTonnes + comps.aftPort.waterTonnes;
    const starboardWater = comps.foreStarboard.waterTonnes + comps.midStarboard.waterTonnes + comps.aftStarboard.waterTonnes;
    const sumCompWater = foreWater + midWater + aftWater;

    damage.floodingTonnes = +Math.max(damage.floodingTonnes + totalNetAdd, sumCompWater).toFixed(3);
    boat.cargoTonnes = Math.min(100, (boat.cargoTonnes ?? 0) + totalNetAdd);
    damage.floodingSinkage = +((damage.floodingTonnes * 1000) / (1025 * wpArea)).toFixed(4);

    // Longitudinal bending & shear strain from uneven compartment flooding (e.g., flooded bow/stern
    // pulling down while buoyant opposite end rears out of the water, or hogging/sagging across midships).
    const endCapacity = Math.max(12, reserveBuoyancyTonnes * 0.28);
    const sideCapacity = Math.max(12, reserveBuoyancyTonnes * 0.30);
    const trimImbalance = (aftWater - foreWater) / endCapacity;
    const heelImbalance = (starboardWater - portWater) / sideCapacity;

    const endShear = Math.abs(foreWater - aftWater) / Math.max(12, reserveBuoyancyTonnes * 0.25);
    const hogSag = Math.abs((foreWater + aftWater) - 1.3 * midWater) / Math.max(14, reserveBuoyancyTonnes * 0.30);
    const weakness = 1.0 + (1.0 - (damage.hullIntegrity ?? 1)) * 1.25;

    if (!damage.sunk) {
      const sinkFrac = Math.min(1.6, damage.floodingSinkage / baseFreeboard);
      // Water on her starboard side lists her to starboard, and positive roll lifts that side.
      const sideSign = damage.breachSideMoment >= 0 ? -1 : 1;
      const trimSign = damage.breachTrimMoment >= 0 ? 1 : -1;
      const targetRoll = Math.abs(heelImbalance) > 0.03
        ? Math.max(-0.54, Math.min(0.54, -heelImbalance * 0.44))
        : sideSign * Math.min(0.32, sinkFrac * 0.22);
      // When one end floods heavily while the opposite end remains buoyant, the flooded end plunges
      // deep and raises the buoyant opposite end steeply out of the water (up to ~33 deg pitch).
      const targetPitch = Math.abs(trimImbalance) > 0.03
        ? Math.max(-0.58, Math.min(0.58, trimImbalance * 0.50))
        : trimSign * Math.min(0.18, sinkFrac * 0.13);
      damage.floodingRoll = +targetRoll.toFixed(4);
      damage.floodingPitch = +targetPitch.toFixed(4);
    }

    const pitchLever = Math.abs(damage.floodingPitch ?? 0) * 1.20;
    const instantStrain = (Math.max(endShear, hogSag * 0.85) * 0.78 + pitchLever * 0.52) * weakness;
    damage.bendingStrain = +Math.min(1.6, Math.max(damage.bendingStrain ?? 0, instantStrain)).toFixed(4);

    // When longitudinal bending strain exceeds the oak hull girder's ultimate strength, the ship's
    // back cracks open across the midbody and both halves founder.
    if (damage.bendingStrain >= 1.0 && !damage.hullCracked) {
      damage.hullCracked = true;
      damage.sunk = true;
      const crackZ = foreWater > aftWater * 1.15 ? -1.05 : aftWater > foreWater * 1.15 ? 1.05 : 0.0;
      damage.pendingBakes.push({
        kind: 'hull-crack',
        z: crackZ,
        severity: +Math.min(1.4, Math.max(0.95, damage.bendingStrain)).toFixed(3),
      });
      comps.midPort.breachArea += 0.35;
      comps.midStarboard.breachArea += 0.35;
      damage.waterlineBreachArea = +(damage.waterlineBreachArea + 0.70).toFixed(5);
      damage.revision = (damage.revision ?? 0) + 1;
    }

    if (
      !damage.sunk &&
      (damage.floodingSinkage >= baseFreeboard * 0.98 ||
        (Math.abs(damage.floodingPitch) >= 0.48 && damage.floodingSinkage >= baseFreeboard * 0.55) ||
        (damage.hullIntegrity <= 0.10 && damage.floodingSinkage >= baseFreeboard * 0.55))
    ) {
      damage.sunk = true;
    }
  }

  // 1b. Continuous wave & current pounding while stranded aground on rocks, reef, shoal, or sand.
  if (boat.aground && !damage.sunk) {
    const subId = boat.groundingContact?.substrate ?? damage.groundingSubstrate ?? 'shoal';
    const subInfo = GROUNDING_SUBSTRATES[subId] ?? GROUNDING_SUBSTRATES.shoal;
    damage.groundingSubstrate = subInfo.id;
    damage.agroundTime = +((damage.agroundTime ?? 0) + clampedDt).toFixed(3);
    if (subInfo.wavePoundMultiplier >= 0.5) {
      const poundJoules = damage.maxHullEnergy * 0.028 * subInfo.wavePoundMultiplier * clampedDt;
      damage.hullDamageJoules = (damage.hullDamageJoules ?? 0) + poundJoules;
      damage.hullIntegrity = Math.max(0, 1 - damage.hullDamageJoules / damage.maxHullEnergy);
      damage.partDamage['keel.main'] = Math.min(1, +((damage.partDamage['keel.main'] ?? 0) + 0.035 * subInfo.wavePoundMultiplier * clampedDt).toFixed(3));
      damage.partDamage['hull.planking'] = Math.min(1, +((damage.partDamage['hull.planking'] ?? 0) + 0.028 * subInfo.wavePoundMultiplier * clampedDt).toFixed(3));
      const strainAdd = 0.038 * subInfo.wavePoundMultiplier * clampedDt;
      damage.bendingStrain = +Math.min(1.6, (damage.bendingStrain ?? 0) + strainAdd).toFixed(4);
      const seamAdd = 0.0032 * subInfo.wavePoundMultiplier * clampedDt;
      damage.waterlineBreachArea = +((damage.waterlineBreachArea ?? 0) + seamAdd).toFixed(5);
      damage.breachArea = damage.waterlineBreachArea;
      const comps = damage.compartments;
      if (comps?.midPort && comps?.midStarboard) {
        comps.midPort.breachArea = +(comps.midPort.breachArea + seamAdd * 0.5).toFixed(5);
        comps.midStarboard.breachArea = +(comps.midStarboard.breachArea + seamAdd * 0.5).toFixed(5);
      }
      if (damage.hullIntegrity <= 0.12 || damage.bendingStrain >= 1.0) {
        damage.sunk = true;
        if (subInfo.id === 'stone' || subInfo.id === 'reef') {
          damage.wreckedOnRocks = true;
        }
        if (damage.bendingStrain >= 1.0 && !damage.hullCracked) {
          damage.hullCracked = true;
          damage.pendingBakes.push({
            kind: 'hull-crack',
            z: 0.0,
            severity: +Math.min(1.4, Math.max(0.95, damage.bendingStrain)).toFixed(3),
          });
          damage.revision = (damage.revision ?? 0) + 1;
        }
      }
    }
  } else if (!boat.aground) {
    damage.agroundTime = 0;
  }

  if (damage.sunk) {
    // Submerge until the hull rests on the seabed/rocks (if coastal terrain is present) or reaches full abyssal depth.
    const openOceanMaxSink = Math.max(24, (boat.length ?? 20) * 1.05);
    const freeboard = boat.hydrodynamics?.freeboard ?? 1.8;
    const draft = boat.hydrodynamics?.draft ?? 2.2;
    let maxSink = openOceanMaxSink;
    if (terrain && typeof terrain.height === 'function') {
      const bedY = terrain.height(boat.x ?? 0, boat.z ?? 0);
      if (Number.isFinite(bedY)) {
        if (bedY >= -freeboard * 0.85 || boat.aground || damage.wreckedOnRocks) {
          maxSink = Math.max(0.18, Math.min(1.35, Math.max(0, -bedY) * 0.45 + 0.35));
        } else if (bedY < 0) {
          const bedMaxSink = Math.max(0.5, -bedY - freeboard - draft * 0.45);
          maxSink = Math.min(openOceanMaxSink, bedMaxSink);
        }
      }
    } else if (boat.aground || damage.wreckedOnRocks) {
      maxSink = 0.65;
    }
    damage.maxSinkDepth = +maxSink.toFixed(3);
    // Downflooding through gunports and weather-deck hatches accelerates descent once awash.
    const sinkRate = 0.65 + Math.min(1.85, (damage.sinkingDepth ?? 0) * 0.12);
    damage.sinkingDepth = Math.min(maxSink, (damage.sinkingDepth ?? 0) + sinkRate * clampedDt);
    damage.floodingSinkage = Math.max(damage.floodingSinkage ?? 0, freeboard + damage.sinkingDepth);

    // Free-surface flooding eliminates transverse metacentric stability (GM -> 0) and floods
    // bow/stern compartments unevenly, causing the foundering vessel to heel heavily onto its
    // beam-ends (~20-45 deg roll) and plunge by the head or stern (~15-33 deg pitch).
    // She goes over toward the side holding more water, and positive roll lifts starboard.
    const sunkComps = damage.compartments ?? {};
    const sunkWaterSide = (sunkComps.foreStarboard?.waterTonnes ?? 0) + (sunkComps.midStarboard?.waterTonnes ?? 0) + (sunkComps.aftStarboard?.waterTonnes ?? 0)
      - (sunkComps.forePort?.waterTonnes ?? 0) - (sunkComps.midPort?.waterTonnes ?? 0) - (sunkComps.aftPort?.waterTonnes ?? 0);
    const sideSign = Math.abs(sunkWaterSide) > 1
      ? -Math.sign(sunkWaterSide)
      : Math.abs(damage.breachSideMoment) > 1e-6
        ? -Math.sign(damage.breachSideMoment)
        : -(Math.sign(damage.hullSideMoment || 0) || 1);
    const rawTrim = Math.abs(damage.breachTrimMoment) > 1e-4
      ? damage.breachTrimMoment
      : (damage.hullTrimMoment || -1);
    const trimSign = rawTrim >= 0 ? 1 : -1;
    const sinkTiltFrac = Math.min(1, (damage.sinkingDepth ?? 0) / Math.max(8, (boat.length ?? 20) * 0.32));
    const targetSinkRoll = sideSign * (0.28 + 0.48 * sinkTiltFrac);
    const basePitchMag = Math.max(0.18, Math.abs(damage.floodingPitch ?? 0));
    const targetSinkPitch = trimSign * (basePitchMag + 0.24 * sinkTiltFrac);
    const tiltBlend = 1 - Math.exp(-clampedDt * 1.35);
    damage.floodingRoll = +((damage.floodingRoll ?? 0) + (targetSinkRoll - (damage.floodingRoll ?? 0)) * tiltBlend).toFixed(4);
    damage.floodingPitch = +((damage.floodingPitch ?? 0) + (targetSinkPitch - (damage.floodingPitch ?? 0)) * tiltBlend).toFixed(4);

    for (const k of ['sailFore', 'sailMain', 'sailMizzen']) {
      if (typeof boat[k] === 'number') boat[k] = Math.max(0, boat[k] - 0.55 * clampedDt);
    }

    if (damage.sinkingDepth >= maxSink - 1e-3) {
      damage.sinkingDepth = +maxSink.toFixed(3);
      damage.restingOnBottom = true;
      damage.bottomTime = +((damage.bottomTime ?? 0) + clampedDt).toFixed(3);
      if (damage.bottomTime >= 1.5) {
        for (const k of ['sailFore', 'sailMain', 'sailMizzen']) {
          if (typeof boat[k] === 'number') boat[k] = 0;
        }
        damage.settledWreck = true;
      }
    }
  }

  // 2. Active shipboard fires from hot shot.
  if (Array.isArray(damage.fires) && damage.fires.length > 0) {
    const yaw = ((boat.heading ?? 0) * Math.PI) / 180;
    const pitch = boat.pitch ?? 0;
    const roll = boat.roll ?? 0;
    damage.worldFires.length = 0;
    let totalIntensity = 0;
    for (let i = damage.fires.length - 1; i >= 0; i--) {
      const f = damage.fires[i];
      f.age += clampedDt;
      // Intense multi-shot fires grow and spread; isolated small fires are slowly doused by the crew.
      const growth = f.intensity > 0.72 ? 0.012 : -0.014;
      f.intensity = Math.max(0, Math.min(1.6, f.intensity + growth * clampedDt));
      if (f.intensity <= 0.02 || damage.sunk) {
        damage.fires.splice(i, 1);
        continue;
      }
      totalIntensity += f.intensity;
      const burnEnergy = f.intensity * 14000 * clampedDt;
      if (f.hitZone === 'rigging') {
        damage.rigDamageJoules += burnEnergy;
        const mGroup = f.mastGroup && Object.hasOwn(damage.mastIntegrity, f.mastGroup) ? f.mastGroup : 'main';
        damage.mastIntegrity[mGroup] = Math.max(0, damage.mastIntegrity[mGroup] - (burnEnergy / damage.maxRigEnergy) * 1.2);
        damage.rigIntegrity = (damage.mastIntegrity.fore + damage.mastIntegrity.main + damage.mastIntegrity.mizzen) / 3;
      } else {
        damage.hullDamageJoules += burnEnergy;
        damage.hullIntegrity = Math.max(0, 1 - damage.hullDamageJoules / damage.maxHullEnergy);
      }
      const rot = [0, 0, 0];
      boatRotate(rot, f.localPosition[0], f.localPosition[1], f.localPosition[2], yaw, pitch, roll);
      damage.worldFires.push({
        position: [(boat.x ?? 0) + rot[0], (boat.heave ?? 0) + rot[1], (boat.z ?? 0) + rot[2]],
        localPosition: f.localPosition,
        hitZone: f.hitZone ?? 'hull',
        intensity: f.intensity,
        age: f.age,
        seed: f.seed,
      });
      // Inject charred timber scorch marks on the hull/superstructure around sustained fires
      if (!f.scorchBaked && f.age > 1.2 && Array.isArray(damage.craters) && damage.craters.length < 120) {
        f.scorchBaked = true;
        const invBeam = 3.6 / Math.max(1.2, boat.beam ?? 6);
        const invLen = 12 / Math.max(4, boat.length ?? 20);
        const invVert = 1 / Math.max(0.35, (boat.beam ?? 6) / 6);
        damage.craters.push({
          x: (f.localPosition[0] ?? 0) * invBeam,
          y: (f.localPosition[1] ?? 1.2) * invVert,
          z: (f.localPosition[2] ?? 0) * invLen,
          radius: 0.16,
          depth: 0.14,
          char: 0.96,
          breach: 0,
          hits: 2,
        });
      }
      // Roaring deck fires spread fore/aft along tarred seams or climb into rigging
      if (!f.spreadDone && f.intensity > 0.88 && f.age > 5.5 && damage.fires.length < 8) {
        f.spreadDone = true;
        const spreadZ = ((f.seed ?? 0.5) > 0.5 ? 1 : -1) * 1.65;
        const climbRig = (f.seed ?? 0.5) > 0.68 && f.hitZone !== 'rigging';
        damage.fires.push({
          localPosition: [
            (f.localPosition[0] ?? 0) * (climbRig ? 0.35 : 0.85),
            (f.localPosition[1] ?? 1.4) + (climbRig ? 1.85 : 0.12),
            Math.max(-5.2, Math.min(5.2, (f.localPosition[2] ?? 0) + (climbRig ? 0 : spreadZ))),
          ],
          hitZone: climbRig ? 'rigging' : (f.hitZone ?? 'hull'),
          mastGroup: f.mastGroup ?? 'main',
          intensity: 0.62,
          age: 0,
          seed: ((f.seed ?? 0.37) * 1.6180339) % 1,
        });
      }
    }
    damage.fireIntensity = +totalIntensity.toFixed(3);
    // Unchecked shipboard conflagration reaching critical intensity burns down to the powder magazine.
    const mag = boat.magazine ?? damage.magazine;
    if (damage.fireIntensity >= 2.15 && mag && !mag.exploded && !mag.deflagrated && mag.powderKg > 0) {
      detonateVesselMagazine(boat, { magId: 'magazine.grand', cause: 'fire' });
      damage.mastState ??= { fore: 0, main: 0, mizzen: 0 };
      for (const [mGroup, mastZ] of [['fore', -3.55], ['main', 0.05], ['mizzen', 3.53]]) {
        if ((damage.mastIntegrity[mGroup] ?? 1) <= 0.24 && (damage.mastState[mGroup] ?? 0) < 2) {
          damage.mastState[mGroup] = 2;
          queueMastBreak(damage, {
            kind: 'mast-break',
            mastGroup: mGroup,
            stage: 'full',
            side: 1,
            pivotY: mGroup === 'main' ? 1.55 : 2.05,
            pivotZ: mastZ,
          });
        }
      }
    }
  } else if (damage.worldFires?.length) {
    damage.worldFires.length = 0;
    damage.fireIntensity = 0;
  }

  // 3. Ongoing battle morale & fire/flooding human attrition.
  if (damage.crewCasualties) {
    const c = damage.crewCasualties;
    if ((damage.fireIntensity ?? 0) > 0.45 && c.able > 0 && !damage.sunk) {
      damage.fireBurnAccum = (damage.fireBurnAccum ?? 0) + (damage.fireIntensity - 0.35) * clampedDt * 0.14;
      if (damage.fireBurnAccum >= 1) {
        const burnWounded = Math.min(c.able, Math.floor(damage.fireBurnAccum));
        damage.fireBurnAccum -= burnWounded;
        c.wounded += burnWounded;
        c.able = Math.max(0, c.total - c.killed - c.wounded);
      }
    }
    const quiet = (damage.fireIntensity ?? 0) < 0.1 && (damage.waterlineBreachArea ?? 0) < 0.01;
    if (quiet && (damage.moraleShock ?? 0) > 0 && !damage.surrendered) {
      damage.moraleShock = +Math.max(0, damage.moraleShock - 0.008 * clampedDt).toFixed(4);
    }
    const casualtyRatio = (c.killed + c.wounded * 0.6) / Math.max(1, c.total);
    const hullLoss = 1 - Math.max(0, Math.min(1, damage.hullIntegrity ?? 1));
    const rigLoss = 1 - Math.max(0, Math.min(1, damage.rigIntegrity ?? 1));
    const firePenalty = Math.min(0.28, (damage.fireIntensity ?? 0) * 0.14);
    const floodPenalty = Math.min(0.25, ((damage.floodingSinkage ?? 0) / Math.max(0.5, baseFreeboard)) * 0.25);
    const nextMorale = damage.surrendered
      ? Math.min(damage.battleMorale ?? 0.15, 0.15)
      : Math.max(
          0,
          Math.min(
            1,
            1.0 - casualtyRatio * 1.15 - hullLoss * 0.42 - rigLoss * 0.18 - firePenalty - floodPenalty - (damage.moraleShock ?? 0),
          ),
        );
    damage.battleMorale = +nextMorale.toFixed(3);
    damage.moraleState = getMoraleStateLabel(damage.battleMorale, damage.surrendered);

    if (
      !damage.surrendered &&
      !damage.sunk &&
      boat.isPlayerVessel !== true &&
      (damage.battleMorale <= 0.18 || (c.able / Math.max(1, c.total) <= 0.25 && (damage.hullIntegrity ?? 1) < 0.55))
    ) {
      strikeVesselColors(
        boat,
        damage.battleMorale <= 0.18 ? 'Crew battle morale broke under fire' : 'Heavy crew casualties & hull damage',
      );
    }
  }
}

export function sweepBuildingSegment(from, to, radius = 0.08, port, options = null) {
  const instances = port?.instances;
  if (!Array.isArray(instances) || !instances.length) return sweepJettySegment(from, to, radius, port, options);
  const midX = (from[0] + to[0]) * 0.5;
  const midZ = (from[2] + to[2]) * 0.5;
  const segHalf = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]) * 0.5;
  const portAnchorX = port.center?.x ?? port.berth?.x ?? instances[0].x ?? 0;
  const portAnchorZ = port.center?.z ?? port.berth?.z ?? instances[0].z ?? 0;
  if (Math.hypot(midX - portAnchorX, midZ - portAnchorZ) > Math.max(1800, port.reach ?? 0) + segHalf) return null;
  const segMinY = Math.min(from[1], to[1]);
  const segMaxY = Math.max(from[1], to[1]);
  const previewOnly = options?.previewOnly === true, exact = !previewOnly || options?.exact === true;
  let best = sweepJettySegment(from, to, radius, port, options);
  for (const inst of instances) {
    if (inst === options?.ignore) continue;
    const baseY = inst.baseY ?? inst.y ?? 0;
    const reach = buildingReach(inst);
    const foundDepth = Math.max(0, inst.foundationDepth ?? 4.5);
    const roofExtra = Math.max(
      inst.roofHeight ?? inst.roofPitch ?? 2.0,
      inst.prefabId === 'mission_chapel' ? 9.2 : inst.prefabId === 'timber_mole_pier' ? 6.2 : 1.5,
    );
    const instHeight = inst.height ?? 10;
    const collapseDropFrac = Math.max(0, Math.min(0.65, inst.damageState?.collapseDropFrac ?? 0));
    const effTopY = Math.max(3.2, (instHeight + roofExtra) * (1 - collapseDropFrac * 0.72));
    const lowY = reach ? reach.min[1] : baseY - foundDepth, highY = reach ? reach.max[1] : baseY + effTopY;
    if (segMaxY < lowY - radius || segMinY > highY + radius) continue;
    const depthZ = inst.depth ?? inst.length ?? 20;
    const widthX = inst.width ?? 12;
    const halfDiag = (reach
      ? Math.hypot(Math.max(-reach.min[0], reach.max[0]), Math.max(-reach.min[2], reach.max[2]))
      : Math.hypot(widthX, depthZ) * 0.5) + radius;
    const bdx = midX - inst.x, bdz = midZ - inst.z;
    const maxReach = halfDiag + segHalf;
    if (bdx * bdx + bdz * bdz > maxReach * maxReach) continue;

    // Match coastal-world.js toWorld: wx = inst.x + lx * cosY + lz * sinY, wz = inst.z - lx * sinY + lz * cosY
    // Inverse (world-to-local): lx = dx * cosY - dz * sinY, lz = dx * sinY + dz * cosY
    const cosY = Math.cos(inst.yaw ?? 0), sinY = Math.sin(inst.yaw ?? 0);
    const dx0 = from[0] - inst.x, dy0 = from[1] - baseY, dz0 = from[2] - inst.z;
    const dx1 = to[0] - inst.x, dy1 = to[1] - baseY, dz1 = to[2] - inst.z;
    const p0 = [dx0 * cosY - dz0 * sinY, dy0, dx0 * sinY + dz0 * cosY];
    const p1 = [dx1 * cosY - dz1 * sinY, dy1, dx1 * sinY + dz1 * cosY];
    const d = [p1[0] - p0[0], p1[1] - p0[1], p1[2] - p0[2]];
    const minB = reach
      ? [reach.min[0] - radius, reach.min[1] - baseY - radius, reach.min[2] - radius]
      : [-widthX * 0.5 - radius, -foundDepth - radius, -depthZ * 0.5 - radius];
    const maxB = reach
      ? [reach.max[0] + radius, reach.max[1] - baseY + radius, reach.max[2] + radius]
      : [widthX * 0.5 + radius, effTopY + radius, depthZ * 0.5 + radius];
    let tMin = 0, tMax = 1, hitAxis = 0, hitSign = 1;
    let valid = true;
    for (let a = 0; a < 3; a++) {
      if (Math.abs(d[a]) < 1e-9) {
        if (p0[a] < minB[a] || p0[a] > maxB[a]) { valid = false; break; }
      } else {
        let t1 = (minB[a] - p0[a]) / d[a], t2 = (maxB[a] - p0[a]) / d[a], s = -1;
        if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; s = 1; }
        if (t1 > tMin) { tMin = t1; hitAxis = a; hitSign = s; }
        if (t2 < tMax) tMax = t2;
        if (tMin > tMax) { valid = false; break; }
      }
    }
    if (!valid || tMin < 0 || tMin > 1) continue;
    // The box only says the ball is near. It strikes the first thing really standing on its line, and it may
    // meet nothing in this step, or anywhere in this building: a fort's box is mostly air at the corners.
    const met = exact ? traceShotAtBuilding(inst, from, to) : null;
    if (met) {
      if (!(met.t <= 1)) continue;
      tMin = Math.max(0, met.t);
    }
    if (!best || tMin < best.fraction) {
      const ln = [0, 0, 0]; ln[hitAxis] = hitSign;
      // What it strikes faces back along its flight.
      const dLength = Math.hypot(d[0], d[1], d[2]) || 1;
      const normal = met
        ? [(from[0] - to[0]) / dLength, (from[1] - to[1]) / dLength, (from[2] - to[2]) / dLength]
        : [ln[0] * cosY + ln[2] * sinY, ln[1], -ln[0] * sinY + ln[2] * cosY];
      const localPosition = [p0[0] + d[0] * tMin, p0[1] + d[1] * tMin, p0[2] + d[2] * tMin];
      const hitPart = previewOnly ? null : resolveBuildingHitPart(inst, localPosition);
      best = {
        fraction: tMin,
        kind: 'building',
        building: inst,
        buildingId: inst.id,
        buildingName: inst.label ?? inst.prefabId,
        prefabId: inst.prefabId,
        hitPartId: hitPart?.id ?? null,
        hitSubAssembly: hitPart?.subAssembly ?? null,
        hitLayer: hitPart?.layer ?? null,
        localPosition,
        normal,
      };
    }
  }
  return best;
}

const FORTIFIED_STONE_PREFABS = new Set([
  'stone_sea_bastion',
  'bastion_trace_fortress',
  'stone_quay_seawall',
]);

const TIMBER_BUILDING_PREFABS = new Set([
  'timber_mole_pier',
  'careening_shed',
  'wooden_watchtower_beacon',
  'drying_fish_flakes_racks',
  'ropewalk_cordage_shed',
  'cooperage_barrel_yard',
  'indigenous_bohio_village_compound',
  'palisade_stockade_wall',
  'english_triangular_palisade_fort',
  'english_half_timber_hall',
  'english_timber_cottage',
]);

export function classifyBuildingMaterial(building) {
  const prefabId = typeof building === 'string' ? building : building?.prefabId ?? '';
  if (FORTIFIED_STONE_PREFABS.has(prefabId)) return 'fortified-stone';
  if (TIMBER_BUILDING_PREFABS.has(prefabId)) return 'timber';
  return 'masonry';
}

function buildingLocalToWorld(building, localPt) {
  const cosY = Math.cos(building?.yaw ?? 0);
  const sinY = Math.sin(building?.yaw ?? 0);
  const baseY = building?.baseY ?? building?.y ?? 0;
  const lx = localPt?.[0] ?? 0;
  const ly = localPt?.[1] ?? 0;
  const lz = localPt?.[2] ?? 0;
  return [
    (building?.x ?? 0) + lx * cosY + lz * sinY,
    baseY + ly,
    (building?.z ?? 0) - lx * sinY + lz * cosY,
  ];
}

function buildingFireLocalToWorld(building, localPt) {
  const dropFrac = Math.max(0, Math.min(0.72, building?.damageState?.collapseDropFrac ?? 0));
  const ly = Math.max(0.65, (localPt?.[1] ?? 1.2) * (1 - dropFrac * 0.72));
  return buildingLocalToWorld(building, [localPt?.[0] ?? 0, ly, localPt?.[2] ?? 0]);
}

export function createBuildingMagazineState(building) {
  if (!building) return null;
  if (building.magazine && Number.isFinite(building.magazine.initialPowderKg)) {
    if (building.damageState) building.damageState.magazine = building.magazine;
    return building.magazine;
  }
  const prefabId = building.prefabId ?? '';
  const isFortress = prefabId === 'bastion_trace_fortress';
  const isBastion = prefabId === 'stone_sea_bastion';
  const isTimberFort = prefabId === 'english_triangular_palisade_fort';
  const isArsenal = prefabId === 'royal_atarazanas_arsenal';
  const isArmedPier = Boolean(building.armed || building.hasMagazine);
  const barrelMassKg = 40.8;
  const barrelsTotal = isFortress
    ? 280
    : isBastion
      ? 120
      : isArsenal
        ? 80
        : isTimberFort
          ? 48
          : isArmedPier
            ? 24
            : 0;
  const initialPowderKg = +(barrelsTotal * barrelMassKg).toFixed(1);
  const initialRounds = barrelsTotal > 0
    ? {
        round: barrelsTotal * 15,
        hot: barrelsTotal * 3,
        chain: Math.round(barrelsTotal * 1.5),
        grape: barrelsTotal * 2,
      }
    : { round: 0, hot: 0, chain: 0, grape: 0 };
  building.magazine = {
    initialPowderKg,
    powderKg: initialPowderKg,
    powderFraction: barrelsTotal > 0 ? 1 : 0,
    barrelMassKg,
    barrelsTotal,
    barrelsRemaining: barrelsTotal,
    rounds: { ...initialRounds },
    initialRounds: { ...initialRounds },
    shotsFired: 0,
    powderConsumedKg: 0,
    hitCount: 0,
    exploded: false,
    deflagrated: false,
    explosionYieldMj: 0,
    detonationCause: null,
  };
  if (building.damageState) building.damageState.magazine = building.magazine;
  return building.magazine;
}

export function createBuildingDamageState(building) {
  if (!building) return null;
  const magazine = createBuildingMagazineState(building);
  const materialClass = classifyBuildingMaterial(building);
  const prefabId = building.prefabId ?? '';
  const isBastionOrFort = prefabId === 'stone_sea_bastion' || prefabId === 'bastion_trace_fortress';
  const defaultMaxEnergy = isBastionOrFort
    ? 3200000
    : materialClass === 'fortified-stone'
      ? 1450000
      : materialClass === 'timber'
        ? 860000
        : 920000;
  const defaultOuterPenJoules = materialClass === 'fortified-stone'
    ? 155000
    : materialClass === 'masonry'
      ? 85000
      : 32000;
  if (!building.damageState) {
    building.damageState = {
      materialClass,
      magazine,
      maxEnergy: defaultMaxEnergy,
      outerPenetrationJoules: defaultOuterPenJoules,
      integrity: 1,
      damageJoules: 0,
      hits: 0,
      breaches: 0,
      throughBreaches: 0,
      dismountedGuns: 0,
      fireCount: 0,
      fireIntensity: 0,
      magazineHit: false,
      magazineExploded: false,
      magazineExplosionYieldMj: 0,
      state: 'intact',
      partDamage: {},
      craters: [],
      pendingBakes: [],
      fires: [],
      worldFires: [],
      revision: 0,
      lastHit: null,
    };
    return building.damageState;
  }
  const d = building.damageState;
  d.materialClass ??= materialClass;
  d.magazine = magazine;
  d.maxEnergy ??= defaultMaxEnergy;
  d.outerPenetrationJoules ??= defaultOuterPenJoules;
  if (!d.partDamage) d.partDamage = {};
  if (!Array.isArray(d.craters)) d.craters = [];
  if (!Array.isArray(d.pendingBakes)) d.pendingBakes = [];
  if (!Array.isArray(d.fires)) d.fires = [];
  if (!Array.isArray(d.worldFires)) d.worldFires = [];
  if (!Number.isFinite(d.breaches)) d.breaches = 0;
  if (!Number.isFinite(d.throughBreaches)) d.throughBreaches = 0;
  if (!Number.isFinite(d.dismountedGuns)) d.dismountedGuns = 0;
  if (!Number.isFinite(d.fireCount)) d.fireCount = 0;
  if (!Number.isFinite(d.fireIntensity)) d.fireIntensity = 0;
  if (typeof d.magazineHit !== 'boolean') d.magazineHit = false;
  if (typeof d.magazineExploded !== 'boolean') d.magazineExploded = false;
  if (!Number.isFinite(d.magazineExplosionYieldMj)) d.magazineExplosionYieldMj = 0;
  if (!Number.isFinite(d.revision)) d.revision = 0;
  return d;
}

export function detonateBuildingMagazine(building, { localPos = [0, 2.2, 0], cause = 'shot' } = {}) {
  if (!building) return null;
  const d = createBuildingDamageState(building);
  const mag = createBuildingMagazineState(building);
  mag.hitCount = (mag.hitCount ?? 0) + 1;
  d.magazineHit = true;
  const magPartId = `${building.prefabId ?? 'fort'}:polvorin_magazine`;
  d.partDamage[magPartId] = 1;

  const powderKg = Math.max(0, mag.powderKg ?? 0);
  const powderFrac = mag.initialPowderKg > 0 ? Math.max(0, Math.min(1, powderKg / mag.initialPowderKg)) : 0;
  if (powderKg <= 0 || powderFrac <= 0.005 || mag.exploded) {
    return {
      triggered: false,
      exploded: mag.exploded,
      deflagrated: mag.deflagrated,
      powderFraction: +powderFrac.toFixed(4),
      yieldMj: 0,
    };
  }

  const yieldMj = +(powderKg * 3.0).toFixed(1);
  mag.powderConsumedKg = +(mag.powderConsumedKg + powderKg).toFixed(2);
  mag.powderKg = 0;
  mag.powderFraction = 0;
  mag.barrelsRemaining = 0;
  mag.explosionYieldMj = yieldMj;
  mag.detonationCause = cause;
  d.magazineExplosionYieldMj = yieldMj;

  const worldBlastPt = buildingLocalToWorld(building, localPos);
  if (powderFrac < 0.20) {
    mag.deflagrated = true;
    d.damageJoules += d.maxEnergy * (0.20 + powderFrac * 1.4);
  } else {
    mag.exploded = true;
    d.magazineExploded = true;
    d.damageJoules += d.maxEnergy * (0.65 + powderFrac * 0.85);
    d.breaches += Math.max(2, Math.round(3 + 5 * powderFrac));
    d.throughBreaches += Math.max(1, Math.round(2 + 4 * powderFrac));
  }
  d.integrity = Math.max(0, 1 - d.damageJoules / d.maxEnergy);
  d.state = d.integrity > 0.75 ? 'intact' : d.integrity > 0.4 ? 'damaged' : d.integrity > 0.1 ? 'breached' : 'ruined';

  const dismountAdd = Math.max(2, Math.round(4 + 8 * powderFrac));
  d.dismountedGuns = (d.dismountedGuns ?? 0) + dismountAdd;
  const guns = building.gunnery?.state?.guns ?? building.gunnery?.guns;
  if (Array.isArray(guns)) {
    for (const g of guns) {
      g.dismounted = true;
      g.loading = false;
      g.queued = false;
    }
    d.dismountedGuns = guns.length;
    d.silenced = true;
  }

  d.collapseDropFrac = Math.min(0.72, (d.collapseDropFrac ?? 0) + 0.32 * (0.4 + 0.6 * powderFrac));
  d.pendingBakes.push({
    kind: 'building-explosion',
    x: +worldBlastPt[0].toFixed(3),
    y: +worldBlastPt[1].toFixed(3),
    z: +worldBlastPt[2].toFixed(3),
    radius: +(Math.max(8.5, Math.min(building.width ?? 24, building.depth ?? building.length ?? 24) * (0.55 + 0.35 * powderFrac))).toFixed(3),
    stepDepth: +(1.85 + 1.85 * powderFrac).toFixed(3),
    severity: +(1.25 + 0.48 * powderFrac).toFixed(3),
    powderFraction: +powderFrac.toFixed(3),
  });

  const numFires = Math.min(3, Math.max(1, Math.round(1 + 2 * powderFrac)));
  for (let i = 0; i < numFires; i++) {
    if (d.fires.length >= 4) d.fires.shift();
    const flx = ((i % 2 === 0 ? 1 : -1) * (building.width ?? 14) * 0.14);
    const fly = Math.max(0.85, Math.min(2.6, (building.height ?? 5) * 0.34));
    const flz = ((i - (numFires - 1) * 0.5) * (building.depth ?? 14) * 0.12);
    const fWorld = buildingFireLocalToWorld(building, [flx, fly, flz]);
    d.fires.push({
      localPosition: [flx, fly, flz],
      intensity: +(0.88 + 0.35 * powderFrac).toFixed(3),
      age: 0,
      seed: ((d.hits * 0.618 + i * 0.27) % 1) || 0.43,
    });
    d.worldFires.push({
      position: fWorld,
      intensity: +(0.88 + 0.35 * powderFrac).toFixed(3),
      age: 0,
      seed: ((d.hits * 0.618 + i * 0.27) % 1) || 0.43,
    });
  }
  d.fireCount = (d.fireCount ?? 0) + numFires;
  d.fireIntensity = +d.fires.reduce((s, f) => s + f.intensity, 0).toFixed(3);
  d.revision = (d.revision ?? 0) + 1;

  return {
    triggered: true,
    exploded: mag.exploded,
    deflagrated: mag.deflagrated,
    powderFraction: +powderFrac.toFixed(4),
    yieldMj,
  };
}

export function applyBuildingImpactDamage(building, event) {
  if (!building || !event) return null;
  if (event.kind === 'jetty' || (typeof building.model === 'number' && !building.prefabId)) {
    return applyJettyImpactDamage(event.jetty ?? building, event);
  }
  const d = createBuildingDamageState(building);
  if (event.sourceBoat) (d.attackers ??= new Set()).add(event.sourceBoat);
  const mag = d.magazine;
  const materialClass = d.materialClass;
  const vel = event.velocity ?? [200, 0, 0];
  const speed = Math.hypot(vel[0], vel[1], vel[2]);
  const mass = event.mass ?? 5.4;
  const energy = event.energy ?? (0.5 * mass * speed * speed);
  const ammo = GUNNERY_AMMO_TYPES.includes(event.ammo) ? event.ammo : 'round';

  // Material-specific ballistic response:
  // - Fortified stone & masonry resist chain/grape shot (which bounce off ashlar blocks) but spall/crater under heavy roundshot.
  // - Timber structures (mole piers, careening sheds, watchtowers) splinter under round, hot, and chain shot.
  const hasExplicitAmmo = Boolean(event.ammo && GUNNERY_AMMO_TYPES.includes(event.ammo));
  const ammoStructuralMul = !hasExplicitAmmo
    ? 1.0
    : materialClass === 'timber'
      ? (ammo === 'hot' ? 1.25 : ammo === 'chain' ? 0.85 : ammo === 'grape' ? 0.55 : 1.0)
      : (ammo === 'hot' ? 0.92 : ammo === 'chain' ? 0.18 : ammo === 'grape' ? 0.12 : 1.0);
  const effectiveEnergy = energy * ammoStructuralMul;
  // A single solid iron ball punches a localized hole along its path and cannot transfer its entire
  // point-blank muzzle energy (~1.2 MJ) into global structural collapse of the whole building at once.
  const maxSingleShotStructural = materialClass === 'fortified-stone'
    ? d.maxEnergy * 0.20
    : materialClass === 'timber'
      ? d.maxEnergy * 0.30
      : d.maxEnergy * 0.28;
  const absorbedStructuralEnergy = effectiveEnergy <= 245000
    ? effectiveEnergy
    : Math.min(maxSingleShotStructural, 245000 + (effectiveEnergy - 245000) * 0.08);

  d.hits++;
  d.damageJoules += absorbedStructuralEnergy;
  d.integrity = Math.max(0, 1 - d.damageJoules / d.maxEnergy);
  d.state = d.integrity > 0.75 ? 'intact' : d.integrity > 0.4 ? 'damaged' : d.integrity > 0.1 ? 'breached' : 'ruined';

  const localPos = event.localPosition ?? [0, Math.min(2.5, (building.height ?? 5) * 0.5), 0];
  const resolvedPart = event.hitPartId
    ? { id: event.hitPartId, subAssembly: event.hitSubAssembly ?? null, layer: event.hitLayer ?? null }
    : resolveBuildingHitPart(building, localPos);
  const hitPartId = resolvedPart?.id ?? `${building.prefabId ?? 'building'}:walls`;
  const hitSubAssembly = resolvedPart?.subAssembly ?? 'walls-and-bastions';
  const partBudget = d.maxEnergy * 0.18;
  const prevPartDamage = d.partDamage[hitPartId] ?? 0;
  const nextPartDamage = Math.min(1, +(prevPartDamage + effectiveEnergy / Math.max(25000, partBudget)).toFixed(3));
  d.partDamage[hitPartId] = nextPartDamage;

  const isEmbrasure = Boolean(hitPartId?.includes('embrasure') || hitSubAssembly === 'ordnance-and-embrasures');
  const penThreshold = isEmbrasure ? 45000 : d.outerPenetrationJoules;
  const penetratedOuter = ammo !== 'chain' && ammo !== 'grape' && effectiveEnergy >= penThreshold;
  if (penetratedOuter) {
    d.breaches = (d.breaches ?? 0) + 1;
    d.throughBreaches = (d.throughBreaches ?? 0) + 1;
  }

  const worldHitPos = event.surfacePosition ?? event.position ?? buildingLocalToWorld(building, localPos);
  const worldNormal = event.normal ?? [0, 0, 1];
  const siteSeverity = Math.min(1.4, Math.max(0.38, Math.cbrt(effectiveEnergy / 110000) * 0.68));
  const craterRadius = materialClass === 'timber'
    ? Math.min(1.45, Math.max(0.55, 0.50 + siteSeverity * 0.45))
    : Math.min(1.65, Math.max(0.62, 0.55 + siteSeverity * 0.52));
  const stepDepth = penetratedOuter
    ? (materialClass === 'timber' ? 0.52 : 0.44)
    : (materialClass === 'timber' ? 0.28 : 0.22);

  d.craters.push({
    position: [...worldHitPos],
    localPosition: [...localPos],
    normal: [...worldNormal],
    radius: +craterRadius.toFixed(3),
    depth: +stepDepth.toFixed(3),
    severity: +siteSeverity.toFixed(3),
  });
  if (d.craters.length > 32) d.craters.shift();

  d.pendingBakes.push({
    kind: materialClass === 'timber' ? 'timber-splinter' : 'stone-crater',
    x: +worldHitPos[0].toFixed(3),
    y: +worldHitPos[1].toFixed(3),
    z: +worldHitPos[2].toFixed(3),
    nx: +worldNormal[0].toFixed(3),
    ny: +worldNormal[1].toFixed(3),
    nz: +worldNormal[2].toFixed(3),
    radius: +craterRadius.toFixed(3),
    stepDepth: +stepDepth.toFixed(3),
    severity: +siteSeverity.toFixed(3),
    materialClass,
  });

  // When repeated shots batter the lower scarp/foundation wall, propagate shock & spalling up into the
  // upper scarp and parapet crenellations directly above the impact bay so the battlements crumble visibly.
  const bHeight = building.height ?? 8.0;
  if (d.hits >= 2 && (localPos[1] ?? 0) < bHeight * 0.55 && effectiveEnergy >= 45000) {
    const upperLocal = [
      localPos[0] ?? 0,
      Math.min(bHeight + 0.4, Math.max((localPos[1] ?? 0) + 4.5, bHeight * 0.78)),
      localPos[2] ?? 0,
    ];
    const upperWorld = buildingLocalToWorld(building, upperLocal);
    d.pendingBakes.push({
      kind: materialClass === 'timber' ? 'timber-splinter' : 'stone-crater',
      x: +upperWorld[0].toFixed(3),
      y: +upperWorld[1].toFixed(3),
      z: +upperWorld[2].toFixed(3),
      nx: +worldNormal[0].toFixed(3),
      ny: +worldNormal[1].toFixed(3),
      nz: +worldNormal[2].toFixed(3),
      radius: +(craterRadius * 1.05).toFixed(3),
      stepDepth: +(stepDepth * 1.05).toFixed(3),
      severity: +(siteSeverity * 0.90).toFixed(3),
      materialClass,
    });
  }

  // Check if the shot struck near a shore-battery embrasure cannon (or undermined its wall bay) and dismounted it.
  const bGuns = building.gunnery?.state?.guns ?? building.gunnery?.guns;
  let dismountedNow = false;
  const dismountGunWithBake = (g) => {
    g.dismounted = true;
    g.loading = false;
    g.queued = false;
    d.dismountedGuns = (d.dismountedGuns ?? 0) + 1;
    dismountedNow = true;
    const gWorld = buildingLocalToWorld(building, g.localPosition ?? localPos);
    d.pendingBakes.push({
      kind: 'cannon-dismount',
      x: +gWorld[0].toFixed(3),
      y: +gWorld[1].toFixed(3),
      z: +gWorld[2].toFixed(3),
      nx: +worldNormal[0].toFixed(3),
      ny: +worldNormal[1].toFixed(3),
      nz: +worldNormal[2].toFixed(3),
      radius: 1.65,
      stepDepth: 0.65,
      severity: 1.15,
    });
  };
  if (Array.isArray(bGuns) && bGuns.length > 0) {
    for (const g of bGuns) {
      if (g.dismounted) continue;
      const dxL = (g.localPosition?.[0] ?? 0) - (localPos[0] ?? 0);
      const dyL = (g.localPosition?.[1] ?? 0) - (localPos[1] ?? 0);
      const dzL = (g.localPosition?.[2] ?? 0) - (localPos[2] ?? 0);
      const distLocal = Math.hypot(dxL, dyL, dzL);
      const hDistLocal = Math.hypot(dxL, dzL);
      if (
        distLocal < 2.8 ||
        (isEmbrasure && hDistLocal < 4.5) ||
        (penetratedOuter && hDistLocal < 4.2 && Math.abs(dyL) < 9.5)
      ) {
        dismountGunWithBake(g);
        break;
      }
    }
    // Progressive structural attrition also dismounts guns as the fort's ramparts are pounded down
    const maxSurvivingGuns = d.state === 'ruined' ? 0 : Math.max(0, Math.ceil(bGuns.length * Math.pow(d.integrity, 0.85)));
    let currentActiveGuns = bGuns.filter((g) => !g.dismounted).length;
    if (currentActiveGuns > maxSurvivingGuns) {
      // Dismount the active gun closest horizontally to the impact
      let closestGun = null;
      let closestDist = Infinity;
      for (const g of bGuns) {
        if (g.dismounted) continue;
        const hd = Math.hypot((g.localPosition?.[0] ?? 0) - (localPos[0] ?? 0), (g.localPosition?.[2] ?? 0) - (localPos[2] ?? 0));
        if (hd < closestDist) {
          closestDist = hd;
          closestGun = g;
        }
      }
      if (closestGun) dismountGunWithBake(closestGun);
    }
  } else if (isEmbrasure && effectiveEnergy >= 85000) {
    d.dismountedGuns = (d.dismountedGuns ?? 0) + 1;
    dismountedNow = true;
    d.pendingBakes.push({
      kind: 'cannon-dismount',
      x: +worldHitPos[0].toFixed(3),
      y: +worldHitPos[1].toFixed(3),
      z: +worldHitPos[2].toFixed(3),
      nx: +worldNormal[0].toFixed(3),
      ny: +worldNormal[1].toFixed(3),
      nz: +worldNormal[2].toFixed(3),
      radius: 1.65,
      stepDepth: 0.65,
      severity: 1.15,
    });
  }

  // Hot shot & heavy bombardment fire ignition:
  // - Timber buildings (piers, careening sheds, watchtowers) ignite rapidly with high intensity.
  // - Masonry buildings ignite roof rafters and interior timber floors.
  // - Fortified stone ignites internal barracks/carriages/stores when penetrated, struck by hot shot, or heavily breached.
  if (ammo === 'hot' || (penetratedOuter && (d.breaches >= 3 || (materialClass !== 'fortified-stone' && d.breaches >= 2)) && d.fires.length < 3)) {
    const canIgniteStone =
      ammo === 'hot' ||
      materialClass !== 'fortified-stone' ||
      penetratedOuter ||
      isEmbrasure ||
      dismountedNow ||
      hitPartId?.includes('polvorin') ||
      hitPartId?.includes('citadel') ||
      (localPos[1] ?? 0) >= (building.height ?? 5) * 0.45;
    if (canIgniteStone) {
      d.fireCount = (d.fireCount ?? 0) + 1;
      const baseIgnite = ammo === 'hot'
        ? (materialClass === 'timber' ? 0.68 : materialClass === 'masonry' ? 0.46 : 0.40)
        : (materialClass === 'timber' ? 0.36 : 0.28);
      const addIntensity = Math.min(1.25, baseIgnite + energy / (materialClass === 'timber' ? 420000 : 680000));
      const bH = building.height ?? 8;
      const rawFireY = (localPos[1] ?? 0) > 0.8 ? (localPos[1] ?? 1.5) * 0.58 : bH * 0.36;
      const fireLocal = [
        (localPos[0] ?? 0) * 0.55,
        Math.max(0.75, Math.min(rawFireY, bH * 0.44)),
        (localPos[2] ?? 0) * 0.55,
      ];
      let merged = false;
      for (const f of d.fires) {
        const dist = Math.hypot(
          (f.localPosition[0] ?? 0) - fireLocal[0],
          (f.localPosition[1] ?? 0) - fireLocal[1],
          (f.localPosition[2] ?? 0) - fireLocal[2],
        );
        if (dist < 6.5) {
          f.intensity = Math.min(1.45, +(f.intensity + addIntensity * 0.55).toFixed(3));
          merged = true;
          break;
        }
      }
      if (!merged && d.fires.length < 4) {
        d.fires.push({
          localPosition: fireLocal,
          intensity: +addIntensity.toFixed(3),
          age: 0,
          seed: ((d.hits * 0.6180339) % 1) || 0.39,
        });
      }
      d.worldFires = d.fires.map((f) => ({
        position: buildingFireLocalToWorld(building, f.localPosition),
        intensity: f.intensity,
        age: f.age,
        seed: f.seed,
      }));
      d.fireIntensity = +d.fires.reduce((s, f) => s + f.intensity, 0).toFixed(3);
    }
  }

  // Polvorín (fort powder magazine) penetration & detonation check.
  if (mag && mag.initialPowderKg > 0 && !mag.exploded && ammo !== 'chain' && ammo !== 'grape') {
    const isPolvorinPart =
      hitPartId?.includes('polvorin') ||
      hitPartId?.includes('magazine') ||
      event.hitZone === 'magazine' ||
      (hitPartId?.includes('citadel') && penetratedOuter && (d.breaches >= 3 || ammo === 'hot'));
    const hl = (building.depth ?? building.length ?? 18) * 0.5;
    const centralStrike = Math.abs(localPos[0] ?? 0) <= (building.width ?? 16) * 0.34;
    const nearPolvorinVault =
      centralStrike &&
      d.breaches >= 3 &&
      ((penetratedOuter && Math.abs((localPos[2] ?? 0) - hl * 0.32) <= Math.max(3.5, hl * 0.35)) ||
        (penetratedOuter && d.breaches >= 4 && (localPos[1] ?? 0) >= (building.height ?? 8) * 0.35) ||
        (ammo === 'hot' && (localPos[1] ?? 0) >= (building.height ?? 8) * 0.30));
    if ((isPolvorinPart || nearPolvorinVault) && (penetratedOuter || ammo === 'hot' || event.hitZone === 'magazine')) {
      detonateBuildingMagazine(building, {
        localPos,
        cause: ammo === 'hot' ? 'hot-shot' : 'shot',
      });
    }
  }

  // Progressive structural collapse bakes when a fort or building becomes damaged, breached, or ruined
  // over sustained fire (never all cascading on a single non-explosive shot).
  const minSpan = Math.min(building.width ?? 16, building.depth ?? building.length ?? 16);
  let emittedCollapseThisHit = false;
  const activeGunsLeft = Array.isArray(bGuns) ? bGuns.filter((g) => !g.dismounted).length : 0;
  const totalGunsCount = Array.isArray(bGuns) ? bGuns.length : 0;
  const isRuinedOrSilenced = d.state === 'ruined' || (totalGunsCount > 0 && activeGunsLeft === 0 && d.integrity <= 0.45);
  if (isRuinedOrSilenced) {
    d.silenced = true;
    if (Array.isArray(bGuns)) {
      for (const g of bGuns) {
        g.dismounted = true;
        g.loading = false;
        g.queued = false;
      }
      d.dismountedGuns = bGuns.length;
    }
  }
  if (d.hits >= 2 && d.state !== 'intact' && materialClass !== 'fortified-stone' && !d.damageCollapseBaked) {
    d.damageCollapseBaked = true;
    emittedCollapseThisHit = true;
    d.collapseDropFrac = Math.min(0.72, (d.collapseDropFrac ?? 0) + 0.12);
    const roofCavePt = buildingLocalToWorld(building, [
      (localPos[0] ?? 0) * 0.65,
      (building.height ?? 7) * 0.85,
      (localPos[2] ?? 0) * 0.65,
    ]);
    d.pendingBakes.push({
      kind: 'building-collapse',
      x: +roofCavePt[0].toFixed(3),
      y: +roofCavePt[1].toFixed(3),
      z: +roofCavePt[2].toFixed(3),
      radius: +(Math.min(8.0, Math.max(4.5, minSpan * 0.42))).toFixed(3),
      stepDepth: 1.35,
      severity: 0.95,
      powderFraction: 0.40,
    });
  } else if (d.hits >= 2 && (d.state === 'breached' || d.state === 'ruined') && !d.breachCollapseBaked) {
    d.breachCollapseBaked = true;
    emittedCollapseThisHit = true;
    d.collapseDropFrac = Math.min(0.72, (d.collapseDropFrac ?? 0) + 0.16);
    const collapsePt = buildingLocalToWorld(building, [
      (localPos[0] ?? 0) * 0.6,
      (building.height ?? 8) * 0.72,
      (localPos[2] ?? 0) * 0.6,
    ]);
    d.pendingBakes.push({
      kind: 'building-collapse',
      x: +collapsePt[0].toFixed(3),
      y: +collapsePt[1].toFixed(3),
      z: +collapsePt[2].toFixed(3),
      radius: +(Math.min(9.0, Math.max(5.0, minSpan * 0.45))).toFixed(3),
      stepDepth: 1.65,
      severity: 1.15,
      powderFraction: 0.55,
    });
  } else if (d.hits >= 3 && isRuinedOrSilenced && !d.ruinCollapseBaked) {
    d.ruinCollapseBaked = true;
    emittedCollapseThisHit = true;
    d.collapseDropFrac = Math.min(0.72, (d.collapseDropFrac ?? 0) + 0.22);
    const centerCollapsePt = buildingLocalToWorld(building, [
      (localPos[0] ?? 0) * 0.5,
      (building.height ?? 8) * 0.68,
      (localPos[2] ?? 0) * 0.5,
    ]);
    d.pendingBakes.push({
      kind: 'building-collapse',
      x: +centerCollapsePt[0].toFixed(3),
      y: +centerCollapsePt[1].toFixed(3),
      z: +centerCollapsePt[2].toFixed(3),
      radius: +(Math.min(10.0, Math.max(5.5, minSpan * 0.52))).toFixed(3),
      stepDepth: 2.35,
      severity: 1.35,
      powderFraction: 0.85,
    });
  }
  // Multi-round bombardment progression: keep lowering collapseDropFrac on subsequent hits so fires and OBB top sink with the crumbling walls
  if (!emittedCollapseThisHit && d.state !== 'intact' && effectiveEnergy >= 35000) {
    d.collapseDropFrac = Math.min(0.72, (d.collapseDropFrac ?? 0) + 0.018);
  }
  if (d.fires.length > 0) {
    d.worldFires = d.fires.map((f) => ({
      position: buildingFireLocalToWorld(building, f.localPosition),
      intensity: f.intensity,
      age: f.age,
      seed: f.seed,
    }));
  }

  const finalActiveGuns = Array.isArray(bGuns) ? bGuns.filter((g) => !g.dismounted).length : 0;
  if (totalGunsCount > 0 && finalActiveGuns === 0) {
    d.silenced = true;
  }

  d.revision = (d.revision ?? 0) + 1;
  event.materialClass = materialClass;
  event.collapsed = Boolean(emittedCollapseThisHit || d.state === 'ruined');
  event.breached = Boolean(penetratedOuter);
  const bName = building.label ?? building.prefabId;
  const report = {
    kind: 'building',
    buildingId: building.id,
    buildingName: bName,
    targetName: bName,
    prefabId: building.prefabId,
    materialClass,
    collapsed: Boolean(emittedCollapseThisHit || d.state === 'ruined'),
    ammo,
    hitPartId,
    hitSubAssembly,
    partDamage: d.partDamage[hitPartId] ?? nextPartDamage,
    penetratedOuter,
    breaches: d.breaches ?? 0,
    throughBreaches: d.throughBreaches ?? 0,
    dismountedGuns: d.dismountedGuns ?? 0,
    activeGuns: finalActiveGuns,
    totalGuns: totalGunsCount,
    silenced: Boolean(d.silenced || d.state === 'ruined' || d.magazineExploded),
    fires: d.fires.length,
    fireIntensity: +(d.fireIntensity ?? 0).toFixed(2),
    magazineHit: Boolean(d.magazineHit),
    magazineExploded: Boolean(d.magazineExploded),
    magazineExplosionYieldMj: +(d.magazineExplosionYieldMj ?? 0).toFixed(1),
    integrity: +d.integrity.toFixed(3),
    state: d.state,
    hits: d.hits,
    energyKj: +(energy / 1000).toFixed(1),
  };
  d.lastHit = report;
  return report;
}

export function stepBuildingDamage(building, dt) {
  const d = building?.damageState;
  if (!d || !(dt > 0) || !Number.isFinite(dt)) return;
  const clampedDt = Math.min(0.25, dt);
  if (!Array.isArray(d.fires) || d.fires.length === 0) {
    if (d.worldFires?.length) d.worldFires.length = 0;
    d.fireIntensity = 0;
    return;
  }
  const matClass = d.materialClass ?? classifyBuildingMaterial(building);
  const growthRate = matClass === 'timber' ? 0.026 : matClass === 'masonry' ? 0.010 : -0.008;
  const burnRateJoules = matClass === 'timber' ? 28000 : matClass === 'masonry' ? 14000 : 6500;
  d.worldFires.length = 0;
  let totalIntensity = 0;
  for (let i = d.fires.length - 1; i >= 0; i--) {
    const f = d.fires[i];
    f.age += clampedDt;
    const netGrowth = f.intensity > 0.85 ? Math.max(0.008, growthRate) : growthRate;
    f.intensity = Math.max(0, Math.min(1.65, f.intensity + netGrowth * clampedDt));
    if (f.intensity <= 0.02) {
      d.fires.splice(i, 1);
      continue;
    }
    totalIntensity += f.intensity;
    d.damageJoules += f.intensity * burnRateJoules * clampedDt;
    d.worldFires.push({
      position: buildingFireLocalToWorld(building, f.localPosition),
      intensity: f.intensity,
      age: f.age,
      seed: f.seed,
    });
  }
  d.integrity = Math.max(0, 1 - d.damageJoules / d.maxEnergy);
  d.state = d.integrity > 0.75 ? 'intact' : d.integrity > 0.4 ? 'damaged' : d.integrity > 0.1 ? 'breached' : 'ruined';
  d.fireIntensity = +totalIntensity.toFixed(3);
  const minSpan = Math.min(building.width ?? 18, building.depth ?? building.length ?? 18);
  if ((d.state === 'breached' || d.state === 'ruined') && !d.breachCollapseBaked) {
    d.breachCollapseBaked = true;
    d.collapseDropFrac = Math.min(0.72, (d.collapseDropFrac ?? 0) + 0.16);
    const collapsePt = buildingLocalToWorld(building, [0, (building.height ?? 7) * 0.72, 0]);
    d.pendingBakes.push({
      kind: 'building-collapse',
      x: +collapsePt[0].toFixed(3),
      y: +collapsePt[1].toFixed(3),
      z: +collapsePt[2].toFixed(3),
      radius: +(Math.min(9.0, Math.max(5.0, minSpan * 0.48))).toFixed(3),
      stepDepth: 1.65,
      severity: 1.15,
      powderFraction: 0.55,
    });
  }
  if (d.state === 'ruined' && !d.ruinCollapseBaked) {
    d.ruinCollapseBaked = true;
    d.collapseDropFrac = Math.min(0.72, (d.collapseDropFrac ?? 0) + 0.22);
    const ruinPt = buildingLocalToWorld(building, [0, (building.height ?? 7) * 0.68, 0]);
    d.pendingBakes.push({
      kind: 'building-collapse',
      x: +ruinPt[0].toFixed(3),
      y: +ruinPt[1].toFixed(3),
      z: +ruinPt[2].toFixed(3),
      radius: +(Math.min(10.0, Math.max(5.5, minSpan * 0.52))).toFixed(3),
      stepDepth: 2.25,
      severity: 1.30,
      powderFraction: 0.75,
    });
  }

  const mag = building.magazine ?? d.magazine;
  if (d.fireIntensity >= 1.85 && mag && !mag.exploded && !mag.deflagrated && mag.powderKg > 0) {
    detonateBuildingMagazine(building, {
      localPos: [0, (building.height ?? 5) * 0.75, (building.depth ?? 16) * 0.16],
      cause: 'fire',
    });
  }
}

export function stepPortDamage(port, dt) {
  const instances = port?.instances;
  if (Array.isArray(instances)) {
    for (const inst of instances) {
      if (inst?.damageState) stepBuildingDamage(inst, dt);
    }
  }
  if (Array.isArray(port?.sceneryFires) && port.sceneryFires.length && dt > 0 && Number.isFinite(dt)) {
    const clampedDt = Math.min(0.25, dt);
    for (let i = port.sceneryFires.length - 1; i >= 0; i--) {
      const f = port.sceneryFires[i];
      f.age = (f.age ?? 0) + clampedDt;
      f.intensity = Math.max(0, (f.intensity ?? 0.6) - 0.022 * clampedDt);
      if (f.intensity <= 0.02 || f.age > 35) {
        port.sceneryFires.splice(i, 1);
      }
    }
  }
}

export function createBuildingGunDefinitions(building) {
  if (!building) return [];
  const prefabId = building.prefabId ?? '';
  const hw = (building.width ?? 16) * 0.5;
  const hl = (building.depth ?? building.length ?? 16) * 0.5;
  const yTop = building.height ?? 6.0;
  const guns = [];
  const addEmbrasureGun = (side, sideSign, lx, ly, lz, dirLocal, calibre = 24) => {
    guns.push({
      id: guns.length,
      side,
      sideSign,
      deck: 'parapet',
      meshGroup: `${prefabId}:embrasure:${guns.length}`,
      localPosition: [lx, ly, lz],
      muzzleDesign: [lx + dirLocal[0] * 0.55, ly, lz + dirLocal[2] * 0.55],
      breechDesign: [lx - dirLocal[0] * 0.45, ly, lz - dirLocal[2] * 0.45],
      directionDesign: [...dirLocal],
      station: [lx - dirLocal[0] * 0.85, Math.max(0, yTop - 0.15), lz - dirLocal[2] * 0.85],
      floorDesign: Math.max(0, yTop - 0.15),
      visibleCrew: false,
      weatherDeck: true,
      calibre,
      type: 'long-gun',
      kind: 'long-gun',
      recoilLength: 0.75,
      recoilDuration: 0.75,
    });
  };

  if (building.trace) {
    // A fort drawn to its ground has its guns where its trace puts them, each with its own arc.
    const drop = building.trace.lowDrop ?? 0, lowZ = building.trace.lowZ;
    for (const gun of building.trace.guns) {
      const y = yTop + 0.25 - (lowZ !== null && gun.z < lowZ ? drop : 0);
      addEmbrasureGun(gun.nz <= 0 ? 'port' : 'starboard', gun.nz <= 0 ? -1 : 1, gun.x + gun.nx * 0.15, y, gun.z + gun.nz * 0.15, [gun.nx, 0, gun.nz], prefabId === 'stone_sea_bastion' ? 24 : 32);
      guns[guns.length - 1].arcCos = TRACE_GUN_ARC_COS;
    }
  } else if (prefabId === 'bastion_trace_fortress') {
    for (let i = -1.5; i <= 1.5; i += 1.0) {
      const gx = i * (hw * 0.34);
      addEmbrasureGun('port', -1, gx, yTop + 0.25, -hl - 0.15, [0, 0, -1], 32);
    }
    for (let i = -1.5; i <= 1.5; i += 1.0) {
      const gx = i * (hw * 0.34);
      addEmbrasureGun('starboard', 1, gx, yTop + 0.25, hl + 0.15, [0, 0, 1], 32);
    }
    addEmbrasureGun('port', -1, -hw - 0.15, yTop + 0.25, 0, [-1, 0, 0], 24);
    addEmbrasureGun('starboard', 1, hw + 0.15, yTop + 0.25, 0, [1, 0, 0], 24);
  } else if (prefabId === 'stone_sea_bastion') {
    for (let i = -1; i <= 1; i++) {
      const gx = i * (hw * 0.48);
      addEmbrasureGun('port', -1, gx, yTop + 0.25, -hl - 0.15, [0, 0, -1], 24);
    }
    for (let i = -0.5; i <= 0.5; i += 1.0) {
      const gx = i * (hw * 0.50);
      addEmbrasureGun('starboard', 1, gx, yTop + 0.25, hl + 0.15, [0, 0, 1], 24);
    }
  } else if (prefabId === 'english_triangular_palisade_fort') {
    const yBulwark = 0.35 + Math.max(4.4, (building.height ?? 6.8) * 0.68) - 0.35;
    for (const gun of enclosurePlan(building).guns) {
      addEmbrasureGun(gun.nz <= 0 ? 'port' : 'starboard', gun.nz <= 0 ? -1 : 1, gun.x + gun.nx * 1.6, yBulwark, gun.z + gun.nz * 1.6, [gun.nx, 0, gun.nz], 12);
      guns[guns.length - 1].arcCos = TRACE_GUN_ARC_COS;
    }
  } else if (building.armed && (prefabId === 'stone_quay_seawall' || prefabId === 'timber_mole_pier')) {
    addEmbrasureGun('port', -1, -hw * 0.35, yTop + 0.35, -hl, [0, 0, -1], 12);
    addEmbrasureGun('starboard', 1, hw * 0.35, yTop + 0.35, hl, [0, 0, 1], 12);
  }
  return guns;
}

// Whether a gun can be laid on a mark on the water. A gun with an arc looks out over its own wall; one without
// serves whichever side of its fort the mark is on.
export function buildingGunBears(gun, building, x, z) {
  const cos = Math.cos(building?.yaw ?? 0), sin = Math.sin(building?.yaw ?? 0), dx = x - (building?.x ?? 0), dz = z - (building?.z ?? 0);
  const lx = dx * cos - dz * sin, lz = dx * sin + dz * cos;
  if (gun.arcCos === undefined) return gun.side === (lz <= 0 ? 'port' : 'starboard');
  const mx = lx - (gun.localPosition?.[0] ?? 0), mz = lz - (gun.localPosition?.[2] ?? 0), length = Math.hypot(mx, mz) || 1, way = gun.directionDesign;
  return (mx * way[0] + mz * way[2]) / length >= gun.arcCos;
}

export function buildingGunMuzzlePose(gun, building) {
  const cosY = Math.cos(building?.yaw ?? 0);
  const sinY = Math.sin(building?.yaw ?? 0);
  const baseY = building?.baseY ?? building?.y ?? 0;
  const mLocal = gun.muzzleDesign ?? gun.localPosition ?? [0, (building?.height ?? 5) + 0.25, 0];
  const dLocal = gun.aimDirectionLocal ?? gun.directionDesign ?? [0, 0, -1];
  const elevDeg = Number.isFinite(gun.elevation)
    ? gun.elevation
    : Number.isFinite(building?.gunneryElevation)
      ? building.gunneryElevation
      : 0;
  const elevRad = (Math.max(-8, Math.min(18, elevDeg)) * Math.PI) / 180;
  const hLen = Math.hypot(dLocal[0], dLocal[2]) || 1;
  const wx0 = (dLocal[0] / hLen) * cosY + (dLocal[2] / hLen) * sinY;
  const wz0 = -(dLocal[0] / hLen) * sinY + (dLocal[2] / hLen) * cosY;
  const ce = Math.cos(elevRad);
  const se = Math.sin(elevRad);
  const direction = [wx0 * ce, se, wz0 * ce];
  const offset = Math.max(0, Number.isFinite(gun.offset) ? gun.offset : 0);
  const position = [
    (building?.x ?? 0) + mLocal[0] * cosY + mLocal[2] * sinY - direction[0] * offset,
    baseY + mLocal[1] - direction[1] * offset,
    (building?.z ?? 0) - mLocal[0] * sinY + mLocal[2] * cosY - direction[2] * offset,
  ];
  return {
    position,
    direction,
    velocity: [0, 0, 0],
    localPosition: [...mLocal],
  };
}

const GUN_PARAPET_M = 6;

export function createBuildingGunnery(building, { onEvent = () => {}, getVessels = () => [], getTerrain = () => null, sweep = null, town = null } = {}) {
  const defs = createBuildingGunDefinitions(building);
  const state = createGunneryState(defs);
  building.gunnery = state;
  for (const i of createBuildingDamageState(building).restoredGuns ?? []) if (state.guns[i]) state.guns[i].dismounted = true;
  const solidSweep = sweep ?? createGunnerySolidSweep({ sourceBoat: null, sourceBuilding: building, getVessels, getTerrain, onRigTorn: (report) => { lastDamageReport = report; if (damageLog.length >= 32) damageLog.shift(); damageLog.push(report); } });
  const damageLog = [];
  let lastDamageReport = null;

  const hasPowder = () => !building.magazine || (!building.magazine.exploded && building.magazine.powderKg > 0);
  // No gunner lays a piece through his own town: a gun whose line to its mark crosses one of the port's
  // buildings, or the fort it stands on, holds its fire.
  const ownGround = town ?? { instances: [building], center: { x: building.x ?? 0, z: building.z ?? 0 } };
  const lineFouled = (gun, pose) => {
    if (!gun.aimPoint) return false;
    // It fires over its own parapet, so what stands right before the muzzle does not count.
    const to = gun.aimPoint, from = pose.position, share = Math.min(1, GUN_PARAPET_M / (Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]) || 1));
    const clear = [from[0] + (to[0] - from[0]) * share, from[1] + (to[1] - from[1]) * share, from[2] + (to[2] - from[2]) * share];
    return !!sweepBuildingSegment(clear, to, 0.08, ownGround, { previewOnly: true, exact: true });
  };
  const readyAtQuarters = (side = null) => {
    for (const g of state.guns) {
      if (!side || g.side === side) {
        if (!g.dismounted) {
          g.stage = 'ready';
          g.loading = false;
          g.progress = 1;
          g.offset = 0;
          g.queued = false;
        }
      }
    }
    return true;
  };
  readyAtQuarters();

  return {
    building,
    state,
    damageLog,
    get magazine() { return building.magazine; },
    get lastDamageReport() { return lastDamageReport; },
    readyAtQuarters,
    setAmmo(type) {
      const next = GUNNERY_AMMO_TYPES.includes(type) ? type : 'round';
      state.ammo = next;
      return next;
    },
    setElevation(degrees) {
      const next = Number.isFinite(Number(degrees)) ? Math.max(-8, Math.min(18, Number(degrees))) : 0;
      building.gunneryElevation = next;
      for (const g of state.guns) g.elevation = next;
      return next;
    },
    fire(side = 'port') {
      if (!hasPowder() || building.damageState?.state === 'ruined') return 0;
      readyAtQuarters(side);
      return fireGunnery(state, side, { interval: 0.12, ammo: state.ammo });
    },
    fireAtTarget(targetBoat, { ammo = null } = {}) {
      if (!targetBoat || !hasPowder() || building.damageState?.state === 'ruined' || !state.guns.length) return 0;
      if (ammo && GUNNERY_AMMO_TYPES.includes(ammo)) state.ammo = ammo;
      const tx = (targetBoat.x ?? 0) - (building.x ?? 0);
      const tz = (targetBoat.z ?? 0) - (building.z ?? 0);
      const distH = Math.hypot(tx, tz) || 1;
      const cosY = Math.cos(building.yaw ?? 0);
      const sinY = Math.sin(building.yaw ?? 0);
      const localTx = tx * cosY - tz * sinY;
      const localTz = tx * sinY + tz * cosY;
      const localDir = [localTx / distH, 0, localTz / distH];
      const bearing = state.guns.filter((g) => buildingGunBears(g, building, targetBoat.x ?? 0, targetBoat.z ?? 0));
      if (!bearing.length) return 0;

      // Ballistic elevation solution for shore battery firing down/out at an offshore vessel.
      const muzzleY = (building.baseY ?? building.y ?? 0) + (building.height ?? 6) + 0.25;
      const targetY = (targetBoat.heave ?? 0) + 1.1;
      const dy = targetY - muzzleY;
      const v0 = 435; // 24-pdr / 32-pdr muzzle velocity (m/s)
      const gravDropDeg = (0.5 * Math.asin(Math.max(-0.95, Math.min(0.95, (9.81 * distH) / (v0 * v0)))) * 180) / Math.PI;
      const directAngleDeg = (Math.atan2(dy, distH) * 180) / Math.PI;
      const aimElevDeg = Math.max(-8, Math.min(16, directAngleDeg + gravDropDeg * 1.08));

      for (const g of bearing) {
        if (!g.dismounted) {
          g.aimDirectionLocal = [...localDir];
          g.aimPoint = [targetBoat.x ?? 0, targetY, targetBoat.z ?? 0];
          g.elevation = aimElevDeg;
          g.stage = 'ready';
          g.loading = false;
          g.progress = 1;
          g.offset = 0;
          g.queued = false;
        }
      }
      let queued = 0;
      for (const side of ['port', 'starboard']) queued += fireGunnery(state, side, { interval: 0.10, ammo: state.ammo, only: bearing });
      return queued;
    },
    update(dt, wind = [0, 0, 0], { skipBuildingDamage = false } = {}) {
      if (!skipBuildingDamage) stepBuildingDamage(building, dt);
      if (state.projectiles.length === 0 && state.queue.length === 0) {
        let anyActiveGun = false;
        const guns = state.guns;
        for (let i = 0; i < guns.length; i++) {
          const g = guns[i];
          if (g.loading || g.queued || g.stage !== 'ready' || Math.abs(g.offset ?? 0) > 1e-4) {
            anyActiveGun = true;
            break;
          }
        }
        if (!anyActiveGun) {
          if (dt > 0 && Number.isFinite(dt)) state.time = (state.time ?? 0) + dt;
          if (state.flash) state.flash = null;
          return [];
        }
      }
      return stepGunnery(state, dt, {
        deferSeaCollision: false,
        windVelocity: wind,
        muzzle: (gun) => buildingGunMuzzlePose(gun, building),
        sweep: solidSweep,
        gunAttended: (gun) => !gun.dismounted,
        canFire: (gun, pose) => !gun.dismounted && hasPowder() && !lineFouled(gun, pose),
        onEvent: (event) => {
          if (event.type === 'shot' && building.magazine && !building.magazine.exploded) {
            const chargeKg = +(Math.max(0.5, (event.mass ?? 10.9) / 3)).toFixed(2);
            building.magazine.powderKg = +Math.max(0, building.magazine.powderKg - chargeKg).toFixed(2);
            building.magazine.powderConsumedKg = +(building.magazine.powderConsumedKg + chargeKg).toFixed(2);
            building.magazine.powderFraction = building.magazine.initialPowderKg > 0
              ? +(building.magazine.powderKg / building.magazine.initialPowderKg).toFixed(4)
              : 0;
            building.magazine.barrelsRemaining = Math.ceil(building.magazine.powderKg / building.magazine.barrelMassKg);
            building.magazine.shotsFired = (building.magazine.shotsFired ?? 0) + 1;
          }
          if (event.type === 'impact' && event.kind !== 'water') {
            const report = resolveSolidGunneryImpact(event, { getTerrain });
            if (report) {
              event.damageReport = report;
              lastDamageReport = report;
              if (damageLog.length >= 32) damageLog.shift();
              damageLog.push(report);
            }
          }
          if (event.type !== 'ready') onEvent(event);
        },
      });
    },
  };
}

export function createPortGunnery(port, { onEvent = () => {}, getVessels = () => [], getTerrain = () => null, autoReturnFire = true, returnFireRange = HARBOUR_GUN_RANGE_M } = {}) {
  const batteries = [];
  const instances = port?.instances ?? [];
  for (const inst of instances) {
    createBuildingDamageState(inst);
    const defs = createBuildingGunDefinitions(inst);
    if (defs.length > 0) {
      batteries.push(createBuildingGunnery(inst, { onEvent, getVessels, getTerrain, town: port }));
    }
  }
  const garrison = port ? (port.garrison ?? createFortGarrison(port)) : null;
  let cooldown = 4.5;
  const cachedProjectiles = [];
  const cachedWorldFires = [];
  return {
    port,
    batteries,
    garrison,
    get soldiers() {
      return garrison?.soldiers ?? [];
    },
    get projectiles() {
      cachedProjectiles.length = 0;
      for (let i = 0; i < batteries.length; i++) {
        const list = batteries[i].state.projectiles;
        for (let j = 0; j < list.length; j++) cachedProjectiles.push(list[j]);
      }
      return cachedProjectiles;
    },
    get worldFires() {
      cachedWorldFires.length = 0;
      for (let i = 0; i < instances.length; i++) {
        const list = instances[i].damageState?.worldFires;
        if (list) for (let j = 0; j < list.length; j++) cachedWorldFires.push(list[j]);
      }
      if (Array.isArray(port?.sceneryFires)) {
        for (let j = 0; j < port.sceneryFires.length; j++) cachedWorldFires.push(port.sceneryFires[j]);
      }
      return cachedWorldFires;
    },
    // The same pooled hull coming back as a different ship owes this port nothing.
    forgetAttacker(boat) {
      for (const inst of instances) inst.damageState?.attackers?.delete(boat);
    },
    fireAtTarget(targetBoat, opts = {}) {
      let totalQueued = 0;
      for (const b of batteries) {
        totalQueued += b.fireAtTarget(targetBoat, opts);
      }
      return totalQueued;
    },
    update(dt, wind = [0, 0, 0]) {
      stepPortDamage(port, dt);
      if (garrison) stepFortGarrison(garrison, dt, Math.hypot(wind[0] ?? 0, wind[2] ?? 0));
      const allEvents = [];
      for (const b of batteries) {
        const evs = b.update(dt, wind, { skipBuildingDamage: true });
        if (evs?.length) allEvents.push(...evs);
      }
      if (autoReturnFire && batteries.length > 0 && dt > 0) {
        // Old wounds, and what the free camera's cannon did, give a garrison no ship to blame.
        const portAttacked = instances.some((inst) => (inst.damageState?.hits ?? 0) > (inst.damageState?.forgivenHits ?? 0));
        // A fort answers the ships that fired on it, not whichever hull lies closest.
        const attackers = new Set();
        for (const inst of instances) for (const b of inst.damageState?.attackers ?? []) attackers.add(b);
        const hasFriendlyIndigenousBattery = batteries.some((b) => b.building?.indigenous || b.building?.friendlyToPlayer);
        cooldown -= dt;
        if (cooldown <= 0 && (portAttacked || hasFriendlyIndigenousBattery)) {
          const vessels = getVessels() ?? [];
          let nearestBoat = null;
          let nearestDist = Infinity;
          for (let vIdx = 0; vIdx < vessels.length; vIdx++) {
            const entry = vessels[vIdx];
            const boat = entry?.boat ?? entry;
            if (!boat || boat.damage?.sunk || boat.damage?.surrendered) continue;
            const isHostileEnemy = entry?.faction === 'enemy' || boat?.faction === 'enemy';
            if (attackers.size > 0 && !attackers.has(boat) && !hasFriendlyIndigenousBattery) continue;
            // Allied Indigenous coastal batteries actively defend the harbor against hostile European vessels
            // without firing on the allied player (vIdx === 0) unless the port was directly bombarded when no enemy is present.
            if (hasFriendlyIndigenousBattery && !portAttacked && !isHostileEnemy) continue;
            if (hasFriendlyIndigenousBattery && vIdx === 0 && vessels.some((v) => (v?.faction ?? v?.boat?.faction) === 'enemy')) continue;
            for (const b of batteries) {
              const d = Math.hypot((boat.x ?? 0) - (b.building.x ?? 0), (boat.z ?? 0) - (b.building.z ?? 0));
              if (d < nearestDist) {
                nearestDist = d;
                nearestBoat = boat;
              }
            }
          }
          if (nearestBoat && nearestDist <= returnFireRange) {
            // Only those in range: a fort at the mouth has no shot at a ship off the town.
            let firedAny = 0, voiceBattery = null;
            for (const b of batteries) {
              if (Math.hypot((nearestBoat.x ?? 0) - (b.building.x ?? 0), (nearestBoat.z ?? 0) - (b.building.z ?? 0)) <= returnFireRange) {
                const q = b.fireAtTarget(nearestBoat);
                if (q > 0) {
                  firedAny += q;
                  if (!voiceBattery) voiceBattery = b.building;
                }
              }
            }
            if (firedAny > 0 && voiceBattery) {
              onEvent({
                type: 'enemy-voice',
                action: 'fire',
                position: [voiceBattery.x ?? 0, (voiceBattery.baseY ?? voiceBattery.y ?? 0) + (voiceBattery.height ?? 6), voiceBattery.z ?? 0],
              });
            }
            cooldown = 9.5;
          } else {
            cooldown = 2.0;
          }
        }
      }
      return allEvents;
    },
  };
}

function intersectVerticalCylinder(from, to, cx, cz, yMin, yMax, cylRadius) {
  const dx = to[0] - from[0];
  const dy = to[1] - from[1];
  const dz = to[2] - from[2];
  const ox = from[0] - cx;
  const oz = from[2] - cz;
  const a = dx * dx + dz * dz;
  if (a < 1e-9) {
    if (ox * ox + oz * oz > cylRadius * cylRadius) return -1;
    const minY = Math.min(from[1], to[1]);
    const maxY = Math.max(from[1], to[1]);
    if (maxY < yMin || minY > yMax) return -1;
    return 0;
  }
  const b = 2 * (ox * dx + oz * dz);
  const c = ox * ox + oz * oz - cylRadius * cylRadius;
  const disc = b * b - 4 * a * c;
  if (disc < 0) return -1;
  const sqrtD = Math.sqrt(disc);
  let t0 = (-b - sqrtD) / (2 * a);
  let t1 = (-b + sqrtD) / (2 * a);
  if (t1 < 0 || t0 > 1) return -1;
  const tEnter = Math.max(0, t0);
  const tExit = Math.min(1, t1);
  const yEnter = from[1] + dy * tEnter;
  const yExit = from[1] + dy * tExit;
  if (Math.max(yEnter, yExit) < yMin || Math.min(yEnter, yExit) > yMax) return -1;
  if (yEnter >= yMin && yEnter <= yMax) return tEnter;
  if (Math.abs(dy) > 1e-6) {
    const tCap = dy > 0 ? (yMin - from[1]) / dy : (yMax - from[1]) / dy;
    if (tCap >= tEnter && tCap <= tExit) return tCap;
  }
  return tEnter;
}

const FORESHORE_PALMS_SHOOTABLE = 520, PALM_FELLED_AT = 3;
function foreshorePalmGrid(port) {
  if (port.palmGrid?.palms === port.palms) return port.palmGrid.grid;
  const palms = port.palms, count = Math.min(palms.length / 8, FORESHORE_PALMS_SHOOTABLE), roots = new Float32Array(count * 12), basal = forestTrunkShape('palm')?.collarRadius ?? 0.3;
  for (let i = 0; i < count; i++) {
    const at = i * 8, shape = palms[at + 5], { scale, sink, yaw } = foreshorePalmPlacement(shape, -palms[at + 6], -palms[at + 7], basal);
    roots.set([palms[at], palms[at + 1] - sink, palms[at + 2], scale, yaw, 1, 1, 1, 0, sink, -2, (port.damagedPalms?.[i] ?? 0) >= PALM_FELLED_AT ? FOREST_LONG_FALLEN : 0], i * 12);
  }
  const grid = buildForestTrunkGrid(roots, count, ['palm']);
  port.palmGrid = { palms, grid };
  return grid;
}

export function sweepScenerySegment(from, to, radius = 0.08, terrain, options = null) {
  if (!terrain) return null;
  const midX = (from[0] + to[0]) * 0.5;
  const midZ = (from[2] + to[2]) * 0.5;
  const segHalf = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]) * 0.5;
  const segMinY = Math.min(from[1], to[1]);
  const segMaxY = Math.max(from[1], to[1]);
  let best = null;

  // A live forest draws every tree and foreshore palm, so its roots are what a ball meets.
  const forest = terrain.forestTrunks;
  if (forest) {
    best = sweepForestTrunks(forest, from, to, radius);
  } else {
    // No forest drawn: the port's record of where its palms stand is all there is to hit.
    const ports = terrain.ports ?? (terrain.port ? [terrain.port] : null);
    for (const port of ports ?? []) {
      const palms = port?.palms;
      if (!(palms instanceof Float32Array) || palms.length < 8) continue;
      const hit = sweepForestTrunks(foreshorePalmGrid(port), from, to, radius);
      if (hit && (!best || hit.fraction < best.fraction)) {
        best = { fraction: hit.fraction, kind: 'scenery', sceneryType: 'palm', port, palmIndex: hit.treeIndex, sceneryPos: hit.sceneryPos, normal: hit.normal };
      }
    }
  }

  const trees = terrain.treeData;
  if (trees && trees.length >= 8 && !options?.previewOnly) {
    const reachSq = (segHalf + 5.5) ** 2;
    for (let i = 0; i < trees.length; i += 8) {
      const scale = trees[i + 3];
      if (!(scale > 0.25)) continue;
      const tx = trees[i], ty = trees[i + 1], tz = trees[i + 2];
      const tdx = midX - tx, tdz = midZ - tz;
      if (tdx * tdx + tdz * tdz > reachSq) continue;
      if (segMaxY < ty - 0.5 - radius || segMinY > ty + 11.5 * scale + radius) continue;
      const tTree = intersectVerticalCylinder(from, to, tx, tz, ty, ty + 11.0 * scale, 1.9 * scale + radius);
      if (tTree >= 0 && (!best || tTree < best.fraction)) {
        const hx = from[0] + (to[0] - from[0]) * tTree;
        const hz = from[2] + (to[2] - from[2]) * tTree;
        const nx = hx - tx, nz = hz - tz;
        const nLen = Math.hypot(nx, 0.35, nz) || 1;
        best = {
          fraction: tTree,
          kind: 'scenery',
          sceneryType: 'tree',
          treeIndex: i,
          sceneryPos: [tx, ty, tz],
          normal: [nx / nLen, 0.35 / nLen, nz / nLen],
        };
      }
    }
  }

  return best;
}

export function applySceneryImpactDamage(terrain, event) {
  if (!terrain || !event) return null;
  terrain.sceneryImpacts ??= [];
  const vel = event.velocity ?? [200, 0, 0];
  const speed = Math.hypot(vel[0], vel[1], vel[2]);
  const mass = event.mass ?? 5.4;
  const energy = event.energy ?? (0.5 * mass * speed * speed);
  const pos = event.surfacePosition ?? event.position ?? event.sceneryPos ?? [0, 0, 0];
  const normal = event.normal ?? [0, 1, 0];
  const craterRadius = +(0.55 * Math.cbrt(mass / 5.4) * Math.max(0.8, Math.cbrt(energy / 100000))).toFixed(2);
  // A tree of the forest: the ball's mark goes in its root, on the GPU and in the save, as the next frame begins.
  const forestTree = event.forestTree ?? null;
  if (forestTree) {
    const hot = event.ammo === 'hot';
    terrain.pendingForestStrikes ??= [];
    terrain.pendingForestStrikes.push({ tree: forestTree, impact: { energy, bearing: Math.atan2(vel[2], vel[0]), hot } });
    const firePort = hot ? terrain.port ?? terrain.ports?.[0] ?? null : null;
    if (firePort) {
      firePort.sceneryFires ??= [];
      if (firePort.sceneryFires.length >= 12) firePort.sceneryFires.shift();
      firePort.sceneryFires.push({ position: [pos[0], pos[1] + 1.2, pos[2]], intensity: 0.95, age: 0, seed: ((terrain.sceneryImpacts.length * 0.618 + 0.31) % 1) || 0.47 });
    }
    const record = { position: [...pos], normal: [...normal], sceneryType: event.sceneryType ?? 'tree', energyKj: +(energy / 1000).toFixed(1), craterRadius, time: event.time ?? 0 };
    if (terrain.sceneryImpacts.length >= 64) terrain.sceneryImpacts.shift();
    terrain.sceneryImpacts.push(record);
    event.materialClass = 'timber';
    event.felled = true;
    return { kind: 'scenery', sceneryType: record.sceneryType, hitCount: terrain.sceneryImpacts.length, craterRadius, energyKj: record.energyKj, felled: true };
  }
  const bake = {
    kind: 'scenery-tree',
    x: +pos[0].toFixed(3),
    y: +pos[1].toFixed(3),
    z: +pos[2].toFixed(3),
    nx: +(normal[0] ?? 0).toFixed(3),
    ny: +(normal[1] ?? 1).toFixed(3),
    nz: +(normal[2] ?? 0).toFixed(3),
    radius: +(Math.max(4.5, craterRadius * 4.5)).toFixed(3),
    stepDepth: +(Math.min(1.6, Math.max(0.55, craterRadius * 0.95))).toFixed(3),
    severity: +(Math.min(1.4, Math.max(0.65, craterRadius * 1.1))).toFixed(3),
  };
  let palmFelled = false;
  if (event.port) {
    event.port.sceneryBakes ??= [];
    event.port.sceneryBakes.push(bake);
    if (Number.isInteger(event.palmIndex)) {
      event.port.damagedPalms ??= {};
      event.port.damagedPalms[event.palmIndex] = (event.port.damagedPalms[event.palmIndex] ?? 0) + 1;
      // Downed, for what a later ball can meet.
      if (event.port.damagedPalms[event.palmIndex] >= PALM_FELLED_AT) {
        event.port.palmGrid = null;
        palmFelled = true;
      }
      if (Array.isArray(event.port.palms) && typeof event.port.palms[event.palmIndex] === 'object' && event.port.palms[event.palmIndex]) {
        event.port.palms[event.palmIndex].damaged = (event.port.palms[event.palmIndex].damaged ?? 0) + 1;
      }
    }
    if (event.ammo === 'hot' || energy >= 135000) {
      event.port.sceneryFires ??= [];
      if (event.port.sceneryFires.length >= 12) event.port.sceneryFires.shift();
      event.port.sceneryFires.push({
        position: [pos[0], pos[1] + 1.2, pos[2]],
        intensity: event.ammo === 'hot' ? 0.95 : 0.65,
        age: 0,
        seed: ((terrain.sceneryImpacts.length * 0.618 + 0.31) % 1) || 0.47,
      });
    }
  }
  terrain.pendingLandBakes ??= [];
  terrain.pendingLandBakes.push(bake);
  const record = {
    position: [...pos],
    normal: [...normal],
    sceneryType: event.sceneryType ?? 'palm',
    energyKj: +(energy / 1000).toFixed(1),
    craterRadius,
    time: event.time ?? 0,
  };
  if (terrain.sceneryImpacts.length >= 64) terrain.sceneryImpacts.shift();
  terrain.sceneryImpacts.push(record);
  event.materialClass = 'timber';
  event.felled = palmFelled;
  return {
    kind: 'scenery',
    sceneryType: record.sceneryType,
    hitCount: terrain.sceneryImpacts.length,
    craterRadius,
    energyKj: record.energyKj,
    felled: palmFelled,
  };
}

export function sweepTerrainSegment(from, to, radius = 0.08, terrain, options = null) {
  const sampleFn = terrain?.groundSample ?? terrain?.height;
  if (typeof sampleFn !== 'function') return null;
  const maxTerrainPeak = (terrain?.region?.peakElevationMetres ?? 900) + 12;
  if (Math.min(from[1], to[1]) - radius > maxTerrainPeak) return null;

  const segLen = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
  const previewOnly = options?.previewOnly === true;

  // Coarse 4-point height probe to skip 64-step subdivision over open water or high air.
  if (segLen > 6) {
    let maxClearanceBelow = -Infinity;
    for (let c = 0; c <= 4; c++) {
      const t = c * 0.25;
      const cx = from[0] + (to[0] - from[0]) * t;
      const cy = from[1] + (to[1] - from[1]) * t;
      const cz = from[2] + (to[2] - from[2]) * t;
      const ch = sampleFn(cx, cz);
      const diff = ch - (cy - radius);
      if (diff > maxClearanceBelow) maxClearanceBelow = diff;
    }
    // If all 5 coarse samples are at least 18 m below the trajectory segment, skip fine marching.
    if (maxClearanceBelow < -18) return null;
  }

  const stepSize = previewOnly ? 2.5 : 0.75;
  const maxStepCount = previewOnly ? 24 : 64;
  const steps = Math.min(maxStepCount, Math.max(1, Math.ceil(segLen / stepSize)));
  let prevT = 0;
  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const x = from[0] + (to[0] - from[0]) * t;
    const y = from[1] + (to[1] - from[1]) * t;
    const z = from[2] + (to[2] - from[2]) * t;
    const h = sampleFn(x, z);
    if (h > 0.05 && y - radius <= h) {
      let low = prevT, high = t;
      if (i > 0) {
        const bisectIters = previewOnly ? 6 : 12;
        for (let b = 0; b < bisectIters; b++) {
          const mid = (low + high) * 0.5;
          const mx = from[0] + (to[0] - from[0]) * mid;
          const my = from[1] + (to[1] - from[1]) * mid;
          const mz = from[2] + (to[2] - from[2]) * mid;
          const mh = sampleFn(mx, mz);
          if (mh > 0.05 && my - radius <= mh) high = mid; else low = mid;
        }
      }
      const hx = from[0] + (to[0] - from[0]) * high;
      const hz = from[2] + (to[2] - from[2]) * high;
      const elevation = sampleFn(hx, hz);
      const dx = (sampleFn(hx - 1, hz) - sampleFn(hx + 1, hz)) * 0.5;
      const dz = (sampleFn(hx, hz - 1) - sampleFn(hx, hz + 1)) * 0.5;
      const nLen = Math.hypot(dx, 1, dz) || 1;
      return {
        fraction: high,
        kind: 'terrain',
        elevation,
        normal: [dx / nLen, 1 / nLen, dz / nLen],
      };
    }
    prevT = t;
  }
  return null;
}

export function applyTerrainImpactDamage(terrain, event) {
  if (!terrain || !event) return null;
  terrain.landImpacts ??= [];
  const vel = event.velocity ?? [200, 0, 0];
  const speed = Math.hypot(vel[0], vel[1], vel[2]);
  const mass = event.mass ?? 5.4;
  const energy = event.energy ?? (0.5 * mass * speed * speed);
  const pos = event.surfacePosition ?? event.position ?? [0, 0, 0];
  const normal = event.normal ?? [0, 1, 0];
  const craterRadius = +landCraterSize(energy).radius.toFixed(2);
  const record = {
    position: [...pos],
    normal,
    energyKj: +(energy / 1000).toFixed(1),
    craterRadius,
    elevation: +(event.elevation ?? pos[1] ?? 0).toFixed(1),
    time: event.time ?? 0,
  };
  if (terrain.landImpacts.length >= 64) terrain.landImpacts.shift();
  terrain.landImpacts.push(record);

  const sand = terrain.sandAt?.(pos[0], pos[2]) ?? 0;
  terrain.pendingCraters ??= [];
  terrain.pendingCraters.push({ x: pos[0], z: pos[2], energyJ: energy, velocity: vel, normal, sand });

  // Also blast/char any coastal palm trees standing right next to the terrain crater
  const ports = terrain.ports ?? (terrain.port ? [terrain.port] : null);
  if (ports) {
    for (const port of ports) {
      const palms = port?.palms;
      if (!palms) continue;
      let hitPalm = false;
      if (palms instanceof Float32Array && palms.length >= 8) {
        const maxPalms = Math.min(palms.length / 8, 520);
        for (let idx = 0; idx < maxPalms; idx++) {
          if ((port.damagedPalms?.[idx] ?? 0) >= 3) continue;
          const base = idx * 8;
          if (Math.hypot(pos[0] - palms[base], pos[2] - palms[base + 2]) <= 6.5) {
            hitPalm = true;
            break;
          }
        }
      } else if (Array.isArray(palms)) {
        for (let i = 0; i < palms.length; i++) {
          const p = palms[i];
          if (p && Math.hypot(pos[0] - p.x, pos[2] - p.z) <= 6.5) {
            hitPalm = true;
            break;
          }
        }
      }
      if (hitPalm) {
        port.sceneryBakes ??= [];
        port.sceneryBakes.push({
          kind: 'scenery-tree',
          x: +pos[0].toFixed(3),
          y: +pos[1].toFixed(3),
          z: +pos[2].toFixed(3),
          nx: +(normal[0] ?? 0).toFixed(3),
          ny: +(normal[1] ?? 1).toFixed(3),
          nz: +(normal[2] ?? 0).toFixed(3),
          radius: 5.5,
          stepDepth: 0.75,
          severity: 0.85,
        });
      }
    }
  }

  return {
    kind: 'terrain',
    craterCount: terrain.landImpacts.length,
    craterRadius,
    elevation: record.elevation,
    energyKj: record.energyKj,
    sand,
  };
}

export function createGunnerySolidSweep({ sourceBoat, sourceBuilding = null, getVessels = () => [], getTerrain = () => null, onRigTorn = null } = {}) {
  return function sweep(from, to, projectile) {
    const radius = projectile?.sweepRadius ?? projectile?.radius ?? 0.08;
    const previewOnly = projectile?.previewOnly === true;
    const opts = previewOnly || sourceBuilding ? { previewOnly, ignore: sourceBuilding } : null;
    let best = null;
    const vessels = getVessels() ?? [];
    for (const entry of vessels) {
      const targetBoat = entry?.boat ?? entry;
      const hit = sweepShipSegment(from, to, radius, targetBoat, sourceBoat, opts);
      if (hit && (!best || hit.fraction < best.fraction)) best = hit;
    }
    const terrain = getTerrain();
    if (terrain) {
      const ports = terrain.ports ?? (terrain.port ? [terrain.port] : null);
      if (ports) {
        for (const port of ports) {
          if (!port) continue;
          const bHit = sweepBuildingSegment(from, to, radius, port, opts);
          if (bHit && (!best || bHit.fraction < best.fraction)) best = bHit;
        }
      }
      const sHit = sweepScenerySegment(from, to, radius, terrain, opts);
      if (sHit && (!best || sHit.fraction < best.fraction)) best = sHit;
      const tHit = sweepTerrainSegment(from, to, radius, terrain, opts);
      if (tHit && (!best || tHit.fraction < best.fraction)) best = tHit;
    }
    const arrow = isArrowAmmo(projectile?.ammo);
    // A ball tears canvas and rope and flies on. An arrow sticks in them, and an aiming preview names the first it
    // would tear, since that is what the shot does to her.
    if (projectile) for (const entry of vessels) {
      const crossings = sweepShipRigging(from, to, radius, entry?.boat ?? entry, sourceBoat, best?.fraction ?? 1, previewOnly);
      if (crossings.length && (arrow || previewOnly)) best = crossings[0];
      else for (const crossing of crossings) { const report = tearRigWithBall(crossing, projectile, from, to, sourceBoat); if (report) onRigTorn?.(report); }
    }
    // Aiming previews never harm anyone. An arrow stops in the first body it meets; a ball
    // passes through every body before whatever it strikes first.
    if (!previewOnly) {
      for (const entry of vessels) {
        const targetBoat = entry?.boat ?? entry;
        const crew = targetBoat?.crewCompany?.crew;
        if (!crew?.length || targetBoat === sourceBoat || targetBoat.showProw === false) continue;
        const span = Math.max(targetBoat.length ?? 20, targetBoat.beam ?? 6) * 0.6 + 4 + Math.hypot(to[0] - from[0], to[2] - from[2]);
        if (Math.hypot((from[0] + to[0]) * 0.5 - (targetBoat.x ?? 0), (from[2] + to[2]) * 0.5 - (targetBoat.z ?? 0)) > span) continue;
        const localFrom = vesselWorldToLocal(targetBoat, from), localTo = vesselWorldToLocal(targetBoat, to);
        const hits = sweepCrewBodies(localFrom, localTo, radius, crew, best?.fraction ?? 1);
        if (!hits.length) continue;
        if (arrow) {
          best = { fraction: hits[0].fraction, kind: 'ship', hitZone: 'crew', targetBoat, sailor: hits[0].sailor, localPosition: hits[0].point, normal: [0, 1, 0] };
        } else {
          const direction = localTo.map((v, i) => v - localFrom[i]);
          for (const hit of hits) strikeCrewBodyWithBall(targetBoat, hit, projectile, direction);
        }
      }
      // Men ashore: a ball goes through them too, on the way to whatever stops it.
      if (!arrow && projectile) {
        const land = getTerrain?.(), shores = land?.ports ?? (land?.port ? [land.port] : null);
        for (const port of shores ?? []) {
          // The people in its streets see it go by. What it does to them is worked out on the GPU.
          port?.townsfolkWatch?.(from, to, best, projectile);
          const soldiers = port?.garrison?.soldiers;
          if (!soldiers?.length) continue;
          const reach = Math.max(400, (port.reach ?? 0) + 60) + Math.hypot(to[0] - from[0], to[2] - from[2]), mx = (from[0] + to[0]) * 0.5, mz = (from[2] + to[2]) * 0.5;
          if (Math.hypot(mx - (port.center?.x ?? mx), mz - (port.center?.z ?? mz)) > reach) continue;
          for (const hit of sweepCrewBodies(from, to, radius, soldiers, best?.fraction ?? 1)) strikeSoldierWithBall(hit, projectile, port);
        }
      }
    }
    return best;
  };
}

export function resolveSolidGunneryImpact(event, { getTerrain = () => null } = {}) {
  if (!event || event.type !== 'impact') return null;
  if (isArrowAmmo(event.ammo)) {
    if (event.kind === 'ship' && event.targetBoat) return applyArrowImpact(event.targetBoat, event);
    // Stone shrugs off arrows, but a garrison still answers whoever loosed them.
    if (event.kind === 'building' && event.building && event.sourceBoat) (createBuildingDamageState(event.building).attackers ??= new Set()).add(event.sourceBoat);
    return null;
  }
  if (event.kind === 'ship' && event.targetBoat) {
    return applyShipImpactDamage(event.targetBoat, event);
  }
  if (event.kind === 'jetty' && (event.jetty || event.building)) {
    const terrain = getTerrain();
    return applyJettyImpactDamage(event.jetty ?? event.building, event, { port: event.port, terrain });
  }
  if (event.kind === 'building' && event.building) {
    return applyBuildingImpactDamage(event.building, event);
  }
  if (event.kind === 'scenery') {
    const terrain = getTerrain();
    if (terrain) return applySceneryImpactDamage(terrain, event);
  }
  if (event.kind === 'terrain') {
    const terrain = getTerrain();
    if (terrain) return applyTerrainImpactDamage(terrain, event);
  }
  return null;
}

// Explicit orders govern the drill. There is no automatic reload or repeated
// firing. The captain's spoken order has the same duration with sound muted.
export function createShipGunnery(boat,{onEvent=()=>{},onOrder=()=>{},muzzleBlock=()=>null,getVessels=()=>[],getTerrain=()=>null,sweep=null,deferSeaCollision=true,waterHeight=0,autoReload=false}={}){
  const state=createGunneryState(createNavalBattleGunDefinitions(boat));boat.gunnery=state;
  createVesselDamageState(boat);
  const previousStages=new Array(state.guns.length);
  const solidSweep=sweep??createGunnerySolidSweep({sourceBoat:boat,getVessels,getTerrain,onRigTorn:report=>{lastDamageReport=report;if(damageLog.length>=32)damageLog.shift();damageLog.push(report);}});
  const damageLog=[];
  let pending=null,prepared=false,lastReady=false,flash=null,lastDamageReport=null,fireAtWillMode=false,showTrajectoryMode=true,lastAimSummary=null;
  let cachedAimArcs=null,cachedAimTime=-1,cachedAimSide=null,cachedAimAmmo=null,cachedAimElev=NaN,cachedAimTrav=NaN,cachedAimQuoin=NaN,cachedAimX=NaN,cachedAimZ=NaN,cachedAimHeading=NaN,cachedAimRoll=NaN;
  const attended=gun=>!gun.visibleCrew||boat.aiGunneryAttended===true||boat.gunneryAttendance?.has(gun.id)===true;
  const sideValid=side=>side==='port'||side==='starboard';
  const weapon=gunneryWeapon(state.guns[0]);
  const hasPowder=()=>!weapon.usesPowder||!boat.magazine||(!boat.magazine.exploded&&boat.magazine.powderKg>0);
  function traceBallisticPreview(gun,windVec,{elevationDeg=0,traverseDeg=0,rollRad=0,alpha=0.72,isLiveRoll=false}={}){
    const savedRoll=boat.roll,savedElev=gun.elevation,savedTrav=gun.traverse;
    boat.roll=rollRad;
    gun.elevation=elevationDeg;
    gun.traverse=traverseDeg;
    const pose=gunMuzzlePose(gun,boat);
    boat.roll=savedRoll;
    gun.elevation=savedElev;
    gun.traverse=savedTrav;
    const ammo=state.ammo??'round';
    const {speed:speedMul,drag:dragMul}=gunneryAmmoFlight(ammo);
    const radius=ammo==='grape'?(gun.diameter/2)*.55:gun.diameter/2;
    const sweepRadius=ammo==='chain'?gun.diameter*1.85:radius;
    const dragFactor=.5*state.airDensity*(gun.dragCoefficient*dragMul)*Math.PI*radius*radius/gun.mass;
    const gravity=state.gravity;
    const speed=gun.muzzleSpeed*speedMul;
    let pos=[...pose.position];
    let vel=pose.direction.map((d,i)=>d*speed+(pose.velocity?.[i]??0));
    const points=[[...pos]];
    const dtStep=0.14,maxSteps=32;
    let flightSeconds=0,hitInfo=null;
    const probe={radius,sweepRadius,mass:gun.mass,ammo,previewOnly:true};
    const accel=v=>{
      const rx=v[0]-windVec[0],ry=v[1]-windVec[1],rz=v[2]-windVec[2];
      const relSpeed=Math.hypot(rx,ry,rz);
      const k=dragFactor*relSpeed;
      return [-k*rx,-k*ry-gravity,-k*rz];
    };
    for(let step=0;step<maxSteps;step++){
      const a0=accel(vel);
      const mid=[vel[0]+a0[0]*dtStep*.5,vel[1]+a0[1]*dtStep*.5,vel[2]+a0[2]*dtStep*.5];
      const am=accel(mid);
      const nextPos=[pos[0]+mid[0]*dtStep,pos[1]+mid[1]*dtStep,pos[2]+mid[2]*dtStep];
      const nextVel=[vel[0]+am[0]*dtStep,vel[1]+am[1]*dtStep,vel[2]+am[2]*dtStep];
      const seaY=typeof waterHeight==='function'?waterHeight(nextPos[0],nextPos[2],state.time+flightSeconds+dtStep):(Number.isFinite(waterHeight)?waterHeight:0);
      let waterFrac=null;
      if(nextPos[1]<=seaY&&pos[1]>seaY){
        waterFrac=Math.max(0,Math.min(1,(pos[1]-seaY)/Math.max(1e-5,pos[1]-nextPos[1])));
      }
      const solid=solidSweep?solidSweep(pos,nextPos,probe):null;
      const solidFrac=Number.isFinite(solid?.fraction)?Math.max(0,Math.min(1,solid.fraction)):null;
      if(solidFrac!==null&&(waterFrac===null||solidFrac<=waterFrac)){
        const hitPos=pos.map((v,i)=>v+(nextPos[i]-v)*solidFrac);
        points.push(hitPos);
        flightSeconds+=dtStep*solidFrac;
        hitInfo={
          kind:solid.kind??'solid',
          hitZone:solid.hitZone??(solid.kind==='ship'?'hull':'solid'),
          position:hitPos,
          normal:solid.normal??[0,1,0],
        };
        break;
      }
      if(waterFrac!==null){
        const hitPos=[
          pos[0]+(nextPos[0]-pos[0])*waterFrac,
          seaY,
          pos[2]+(nextPos[2]-pos[2])*waterFrac,
        ];
        points.push(hitPos);
        flightSeconds+=dtStep*waterFrac;
        hitInfo={kind:'water',hitZone:'water',position:hitPos,normal:[0,1,0]};
        break;
      }
      points.push(nextPos);
      pos=nextPos;
      vel=nextVel;
      flightSeconds+=dtStep;
    }
    if(!hitInfo){
      hitInfo={kind:'water',hitZone:'water',position:[...points.at(-1)],normal:[0,1,0]};
    }
    const kindCode=isLiveRoll
      ?4
      :hitInfo.kind==='ship'
        ?(hitInfo.hitZone==='rigging'?2:1)
        :(hitInfo.kind==='terrain'||hitInfo.kind==='building'||hitInfo.kind==='jetty')
          ?3
          :0;
    const segments=[];
    const count=points.length-1;
    const ribbonWidth=isLiveRoll?0.095:0.15;
    for(let i=0;i<count;i++){
      const u0=i/count,u1=(i+1)/count;
      segments.push({
        p0:[points[i][0],points[i][1],points[i][2],ribbonWidth],
        p1:[points[i+1][0],points[i+1][1],points[i+1][2],u0],
        style:[u1,alpha,kindCode,0],
      });
    }
    const ringRadius=isLiveRoll?1.35:(hitInfo.kind==='ship'?2.15:2.65);
    const n=hitInfo.normal??[0,1,0];
    segments.push({
      p0:[hitInfo.position[0],hitInfo.position[1],hitInfo.position[2],ringRadius],
      p1:[n[0],n[1],n[2],0],
      style:[1,Math.min(1,alpha*1.25),kindCode,1],
    });
    const dx=hitInfo.position[0]-pose.position[0],dz=hitInfo.position[2]-pose.position[2];
    return {
      segments,
      rangeMeters:Math.round(Math.hypot(dx,dz)),
      flightSeconds:+flightSeconds.toFixed(2),
      hitKind:hitInfo.kind,
      hitZone:hitInfo.hitZone,
      kindCode,
    };
  }
  let cachedScaleLen=NaN,cachedScaleBeam=NaN,cachedScaleModelId=null;
  function syncScaledGuns(){
    const mId=boat?.model?.id??boat?.modelId??'nina';
    const len=Number(boat?.length)||0,bm=Number(boat?.beam)||0;
    if(mId===cachedScaleModelId&&Math.abs(len-cachedScaleLen)<1e-4&&Math.abs(bm-cachedScaleBeam)<1e-4)return;
    cachedScaleModelId=mId;cachedScaleLen=len;cachedScaleBeam=bm;
    const spec=computeArchetypeScaleSpec({modelId:mId,length:len||undefined,beam:bm||undefined});
    boat.scaleSpec=spec;
    for(const g of state.guns){
      const disabled=!spec.isDefaultScale&&spec.defaultGunCount>0&&!spec.activeGunIds.has(g.id);
      g.disabledByScale=disabled;
      if(disabled){
        g.loading=false;
        g.queued=false;
        if(g.stage==='ready')g.stage='secured';
      }
    }
  }
  syncScaledGuns();
  const canFire=side=>{
    syncScaledGuns();
    if(!sideValid(side)||boat.gunnerySide!==side||pending||state.queue.length||!hasPowder())return false;
    let count=0;
    for(const g of state.guns){
      if(gunneryOffline(g)||g.side!==side)continue;
      count++;
      if(g.stage!=='ready'||!attended(g)||muzzleBlock(g,gunMuzzlePose(g,boat)))return false;
    }
    return count>0;
  };
  const canFireLoaded=side=>{
    syncScaledGuns();
    if(!sideValid(side)||boat.gunnerySide!==side||pending||state.queue.length||!hasPowder())return false;
    for(const g of state.guns){
      if(!gunneryOffline(g)&&g.side===side&&g.stage==='ready'&&!g.queued&&attended(g)&&!muzzleBlock(g,gunMuzzlePose(g,boat)))return true;
    }
    return false;
  };
  function recoil(event){
    applyRigidHullImpulse(boat,event.position,event.impulse);
  }
  function orderFire(side,allowPartial=false){
    if(!(allowPartial?canFireLoaded(side):canFire(side)))return false;
    const order='fire-'+side;
    const targetElevation=Number.isFinite(boat.gunneryElevation)?boat.gunneryElevation:0;
    const sideSign=side==='port'?-1:1;
    const initRollDeg=sideSign*(boat.roll??0)*180/Math.PI;
    const initRateDeg=sideSign*(boat.rollVelocity??0)*180/Math.PI;
    pending={
      side,
      allowPartial,
      stage:'laying',
      at:state.time+(weapon.usesPowder?GUNNERY_ORDER_SECONDS[order]:.35),
      targetElevation,
      effectiveQuoin:targetElevation,
      minRollDeg:initRollDeg,
      maxRollDeg:initRollDeg,
      maxAbsRollSeen:Math.max(Math.abs(initRollDeg),Math.abs(initRateDeg)*0.25),
      prevError:null,
      fireAt:null,
      interval:0.14,
    };
    onOrder(order,boat);
    return true;
  }
  return {
    state,
    damageLog,
    weapon,
    get effectiveRange(){return weapon.effectiveRange;},
    get magazine(){return weapon.usesPowder?boat.magazine:null;},
    get lastDamageReport(){return lastDamageReport;},
    get fireAtWill(){return fireAtWillMode;},
    setFireAtWill(enabled,side=null){
      fireAtWillMode=Boolean(enabled);
      if(fireAtWillMode){
        const targetSide=sideValid(side)?side:(sideValid(boat.gunnerySide)?boat.gunnerySide:'port');
        boat.gunnerySide=targetSide;prepared=true;
        prepareGunnery(state,targetSide);
      }
      return fireAtWillMode;
    },
    prepare(side){
      syncScaledGuns();
      if(!sideValid(side))return false;
      if(pending||state.queue.length)return false;
      const changed=boat.gunnerySide!==side;
      if(changed)for(const g of state.guns)if(g.side!==side){g.loading=false;g.queued=false;}
      boat.gunnerySide=side;prepared=true;lastReady=false;
      const count=prepareGunnery(state,side);if(count||changed)onOrder('prepare',boat);
      return count>0||changed;
    },
    readyAtQuarters(side){
      syncScaledGuns();
      if(!sideValid(side))return false;
      pending=null;state.queue.length=0;
      boat.gunnerySide=side;prepared=true;lastReady=true;
      for(const g of state.guns)if(!gunneryOffline(g)&&g.side===side){
        g.stage='ready';g.loading=false;g.progress=1;g.offset=0;g.queued=false;
      }
      return true;
    },
    fire(side,options={}){
      return orderFire(side,Boolean(options?.allowPartial));
    },
    fireLoaded(side){
      return orderFire(side,true);
    },
    cease(){
      fireAtWillMode=false;
      pending=null;state.queue.length=0;for(const g of state.guns)g.queued=false;
      onOrder('cease',boat);
    },
    standDown(){
      fireAtWillMode=false;
      pending=null;state.queue.length=0;boat.gunnerySide=null;lastReady=false;
      for(const g of state.guns){g.queued=false;g.loading=false;}
    },
    update(dt,wind){
      syncScaledGuns();
      if(boat.damage?.settledWreck&&state.projectiles.length===0)return [];
      stepVesselDamage(boat,dt,getTerrain?.());
      if(boat.damage?.sunk){
        fireAtWillMode=false;pending=null;state.queue.length=0;
        for(const g of state.guns){g.queued=false;g.loading=false;}
      }
      if(fireAtWillMode&&sideValid(boat.gunnerySide)&&hasPowder()){
        prepared=true;
        prepareGunnery(state,boat.gunnerySide);
        if(!pending&&!state.queue.length&&canFireLoaded(boat.gunnerySide)){
          const targetElevation=Number.isFinite(boat.gunneryElevation)?boat.gunneryElevation:0;
          const sideSign=boat.gunnerySide==='port'?-1:1;
          const rollElevDeg=sideSign*(boat.roll??0)*180/Math.PI;
          const range=gunElevationRange(state.guns[0]);
          const quoin=Math.max(range.min,Math.min(range.max,targetElevation-rollElevDeg*0.5));
          for(const g of state.guns)if(g.side===boat.gunnerySide&&g.stage==='ready')g.elevation=quoin;
          fireGunnery(state,boat.gunnerySide,{interval:0.12,ammo:state.ammo});
        }
      }
      if(pending){
        const sideSign=pending.side==='port'?-1:1;
        const rollElevDeg=sideSign*(boat.roll??0)*180/Math.PI;
        const rollRateDeg=sideSign*(boat.rollVelocity??0)*180/Math.PI;
        pending.minRollDeg=Math.min(pending.minRollDeg,rollElevDeg);
        pending.maxRollDeg=Math.max(pending.maxRollDeg,rollElevDeg);
        pending.maxAbsRollSeen=Math.max(pending.maxAbsRollSeen,Math.abs(rollElevDeg),Math.abs(rollRateDeg)*0.25);
        if(state.time+1e-8>=pending.at){
          if(pending.stage==='laying'){
            const range=gunElevationRange(state.guns[0]);
            if(pending.minRollDeg<=0.15&&pending.maxRollDeg>=-0.15){
              pending.effectiveQuoin=pending.targetElevation;
            }else{
              const meanHeel=0.5*(pending.minRollDeg+pending.maxRollDeg);
              pending.effectiveQuoin=Math.max(range.min,Math.min(range.max,pending.targetElevation-meanHeel));
            }
            pending.stage='steady';
          }
          // Every gun in the order was lost after it was given: nothing can ever
          // answer "give fire", and a held order would block all further orders.
          if(pending.stage==='steady'&&gunnerySummary(state,pending.side).ready===0&&!state.queue.length)pending=null;
          if(pending?.stage==='steady'){
            let readyCount=0,clearCount=0,allReadyClear=true;
            for(const g of state.guns){
              if(g.side!==pending.side||g.stage!=='ready'||gunneryOffline(g))continue;
              if(!g.queued)readyCount++;
              if(attended(g)&&!muzzleBlock(g,gunMuzzlePose(g,boat)))clearCount++;
              else allReadyClear=false;
            }
            const interval=readyCount>8?Math.max(0.04,1.1/readyCount):0.14;
            const isFlatCalm=pending.maxAbsRollSeen<1e-3&&Math.abs(rollElevDeg)<1e-3&&Math.abs(rollRateDeg)<1e-3;
            const giveFireLead=isFlatCalm?0:0.35;
            const rippleHalf=0.5*Math.max(0,readyCount-1)*interval;
            const leadSeconds=giveFireLead+rippleHalf;
            const predWorldElev=pending.effectiveQuoin+rollElevDeg+rollRateDeg*leadSeconds;
            const ePred=predWorldElev-pending.targetElevation;
            const waitTime=Math.max(0,state.time-pending.at);
            const crossedZero=pending.prevError!==null&&pending.prevError*ePred<=0&&Math.abs(pending.prevError-ePred)<6;
            const withinWindow=Math.abs(ePred)<=0.45+0.35*waitTime;
            const goodRollDirection=pending.targetElevation<-1?(rollRateDeg<=0.2||waitTime>2.8):(rollRateDeg>=-0.2||waitTime>2.8);
            const portsClear=(pending.allowPartial||waitTime>=3.5)?clearCount>0:(readyCount>0&&allReadyClear);
            pending.prevError=ePred;
            if(isFlatCalm||(portsClear&&(((crossedZero||withinWindow)&&goodRollDirection)||waitTime>=5.2))){
              if(weapon.usesPowder)onEvent({
                type:'give-fire',
                side:pending.side,
                targetElevation:pending.targetElevation,
                worldElevation:+(pending.effectiveQuoin+rollElevDeg).toFixed(2),
                rollDegrees:+rollElevDeg.toFixed(2),
                position:[boat.x??0,(boat.heave??0)+3,boat.z??0],
              });
              pending.stage='firing';
              pending.fireAt=state.time+giveFireLead;
              pending.interval=interval;
            }
          }
          if(pending&&pending.stage==='firing'&&state.time+1e-8>=pending.fireAt){
            for(const g of state.guns)if(g.side===pending.side)g.elevation=pending.effectiveQuoin;
            fireGunnery(state,pending.side,{interval:pending.interval,ammo:state.ammo});
            pending=null;
          }
        }
      }
      for(const gun of state.guns)previousStages[gun.index]=gun.stage;
      const crewEfficiency=computeCrewEfficiency(boat);
      const events=stepGunnery(state,dt,{boat,deferSeaCollision,waterHeight,
        windVelocity:wind,muzzle:gun=>gunMuzzlePose(gun,boat),
        sweep:solidSweep,
        // Lighting each fire arrow from a pot of coals slows the archers.
        crewRate:()=>crewEfficiency*(state.ammo==='fire-arrow'?.66:1),
        gunAttended:gun=>!boat.damage?.surrendered&&attended(gun),canFire:(gun,pose)=>!boat.damage?.surrendered&&attended(gun)&&!muzzleBlock(gun,pose),
        onEvent:event=>{
          if(event.type==='shot'&&weapon.usesPowder){consumeMagazineOrdnance(boat,event);recoil(event);flash={gunId:event.gunId,side:event.gun.sideSign,time:event.time,mass:event.mass};}
          if(event.type==='impact'&&event.kind!=='water'){
            event.sourceBoat=boat;
            const report=resolveSolidGunneryImpact(event,{getTerrain});
            if(report){event.damageReport=report;lastDamageReport=report;if(damageLog.length>=32)damageLog.shift();damageLog.push(report);}
          }
          if(event.type!=='ready')onEvent(event);
        },
      });
      if(weapon.usesPowder)for(const gun of state.guns)if(previousStages[gun.index]!==gun.stage&&(gun.stage==='ram'||gun.stage==='runout')){
        onEvent({type:gun.stage==='ram'?'load':'run-out',gun,position:gunMuzzlePose(gun,boat).position});
      }
      if((fireAtWillMode||autoReload)&&prepared&&sideValid(boat.gunnerySide)&&hasPowder()&&!boat.damage?.sunk&&!boat.damage?.surrendered&&!pending){
        if(prepareGunnery(state,boat.gunnerySide)>0)lastReady=false;
      }
      const s=gunnerySummary(state,boat.gunnerySide);
      let allAttended=true;
      if(prepared&&s.total>0&&s.ready===s.total){
        for(const g of state.guns)if(g.side===boat.gunnerySide&&!gunneryOffline(g)&&!attended(g)){allAttended=false;break;}
      }else allAttended=false;
      const ready=prepared&&s.total>0&&s.ready===s.total&&allAttended;
      if(ready&&!lastReady&&weapon.usesPowder)onEvent({type:'ready',position:[boat.x,boat.heave+3,boat.z]});
      lastReady=ready;return events;
    },
    impact(contact){return resolveGunneryImpact(state,contact.shotId??contact.id,contact);},
    summary(side){syncScaledGuns();return gunnerySummary(state,side);},
    canFire,
    canFireLoaded,
    blockedReason(side){
      if(side!==boat.gunnerySide)return null;
      if(boat.damage?.surrendered)return 'Colors struck (surrendered)';
      if(!hasPowder())return boat.magazine?.exploded?'Magazine exploded':'Powder exhausted';
      for(const gun of state.guns){
        if(gun.side!==side||gunneryOffline(gun))continue;
        if(!attended(gun))return 'Manning guns';
        const reason=muzzleBlock(gun,gunMuzzlePose(gun,boat));if(reason)return reason;
      }return null;
    },
    // Why a battery is not progressing through the loading drill (or cannot be
    // loaded at all). Surfaced in the UI so stalls are never silent.
    stallReason(side){
      if(!sideValid(side))return null;
      if(boat.damage?.sunk)return 'Foundering';
      if(boat.damage?.surrendered)return 'Colors struck (surrendered)';
      if(!hasPowder())return boat.magazine?.exploded?'Magazine exploded':'Powder exhausted';
      const s=gunnerySummary(state,side);
      if(s.total===0&&s.dismounted>0)return weapon.usesPowder?`All ${s.dismounted} guns dismounted`:`All ${s.dismounted} archers down`;
      // Loaded guns the captain has stood down cannot fire until prepared again.
      if(boat.gunnerySide!==side)return s.ready>0?'Stood down':null;
      let unmanned=0;
      for(const g of state.guns)if(g.side===side&&!gunneryOffline(g)&&(g.loading||g.stage==='ready')&&!attended(g))unmanned++;
      if(unmanned)return boat.gunneryCrewNote??`${unmanned} gun${unmanned>1?'s':''} awaiting crew`;
      if(s.spent>0&&s.loading===0&&!autoReload&&!fireAtWillMode)return 'Order reload';
      return null;
    },
    get selectedSide(){return boat.gunnerySide??null;},
    get ordered(){return pending?.side??null;},
    get orderStage(){return pending?.stage??null;},
    rollStatus(side){
      if(!pending||pending.side!==side)return null;
      const sideSign=side==='port'?-1:1;
      const rollElevDeg=sideSign*(boat.roll??0)*180/Math.PI;
      const worldElev=(pending.effectiveQuoin??pending.targetElevation)+rollElevDeg;
      return {stage:pending.stage,targetElevation:pending.targetElevation,worldElevation:+worldElev.toFixed(1),rollDegrees:+rollElevDeg.toFixed(1)};
    },
    get ammo(){return state.ammo??'round';},
    setAmmo(type){
      const next=weapon.ammo.includes(type)?type:weapon.defaultAmmo;
      state.ammo=next;boat.gunneryAmmo=next;return next;
    },
    get elevation(){return boat.gunneryElevation??0;},
    get elevationRange(){return gunElevationRange(state.guns[0]);},
    setElevation(degrees){
      const range=gunElevationRange(state.guns[0]);
      const next=Number.isFinite(Number(degrees))?Math.max(range.min,Math.min(range.max,Number(degrees))):0;
      boat.gunneryElevation=next;for(const g of state.guns)g.elevation=next;
      cachedAimArcs=null;
      return next;
    },
    get traverse(){return boat.gunneryTraverse??0;},
    get traverseRange(){return gunTraverseRange(state.guns[0]);},
    // Whether the battery trains freely along the rail rather than through a gunport.
    get isSwivelBattery(){return state.guns[0]?.kind==='swivel'||state.guns[0]?.kind==='bow';},
    setTraverse(degrees){
      const range=gunTraverseRange(state.guns[0]);
      const next=Number.isFinite(Number(degrees))?Math.max(range.min,Math.min(range.max,Number(degrees))):0;
      boat.gunneryTraverse=next;for(const g of state.guns)g.traverse=next;
      cachedAimArcs=null;
      return next;
    },
    trainOnTarget(preferredSide=null){
      const side=sideValid(preferredSide)?preferredSide:(sideValid(boat.gunnerySide)?boat.gunnerySide:'port');
      const sideSign=side==='port'?-1:1;
      const tRange=gunTraverseRange(state.guns[0]);
      const eRange=gunElevationRange(state.guns[0]);
      let bestLocal=null,bestDist=Infinity;
      const vessels=getVessels()??[];
      for(const entry of vessels){
        const tb=entry?.boat??entry;
        if(!tb||tb===boat||tb.damage?.sunk||tb.showProw===false)continue;
        // Great guns lay on the hull. Swivels and archers lay on whoever stands above the rail.
        const rail=vesselRailHeight(tb,0)??3.5;
        const loc=vesselWorldToLocal(boat,[tb.x??0,(tb.heave??0)+(this.isSwivelBattery?rail+.5:rail*.62),tb.z??0]);
        if(loc[0]*sideSign<=0.5)continue;
        const d=Math.hypot(loc[0],loc[2]);
        if(d<bestDist){bestDist=d;bestLocal=loc;}
      }
      const terrain=getTerrain();
      const ports=terrain?.ports??(terrain?.port?[terrain.port]:[]);
      let bestFortLocal=null,bestFortDist=Infinity;
      let bestIntactBldgLocal=null,bestIntactBldgDist=Infinity;
      for(const port of ports){
        for(const inst of (port?.instances??[])){
          const groundY=inst.baseY??inst.y??0;
          const targetY=groundY+(inst.height??8.0)*0.72;
          const loc=vesselWorldToLocal(boat,[inst.x??0,targetY,inst.z??0]);
          if(loc[0]*sideSign<=1.0)continue;
          const d=Math.hypot(loc[0],loc[2]);
          const isRuined=inst.damageState?.state==='ruined';
          const isFort=inst.prefabId==='stone_sea_bastion'||inst.prefabId==='bastion_trace_fortress'||inst.prefabId==='english_triangular_palisade_fort'||Boolean(inst.gunnery?.guns?.length);
          if(isFort&&!isRuined&&d<bestFortDist){
            bestFortDist=d;bestFortLocal=loc;
          }
          if(!isRuined&&d<bestIntactBldgDist){
            bestIntactBldgDist=d;bestIntactBldgLocal=loc;
          }
          if(d<bestDist){bestDist=d;bestLocal=loc;}
        }
      }
      if(bestFortLocal&&(bestFortDist<=bestDist*1.8||bestFortDist<=520)){
        bestLocal=bestFortLocal;
        bestDist=bestFortDist;
      }else if(bestIntactBldgLocal&&bestIntactBldgDist<=bestDist*2.2){
        bestLocal=bestIntactBldgLocal;
        bestDist=bestIntactBldgDist;
      }
      if(!bestLocal)return null;
      // Positive traverse trains toward the bow (-Z in local ship coords)
      const rawTravDeg=Math.atan2(-bestLocal[2],Math.abs(bestLocal[0]))*180/Math.PI;
      const clampedTrav=+(Math.max(tRange.min,Math.min(tRange.max,rawTravDeg))).toFixed(1);
      const gunSpeed=state.guns[0]?.muzzleSpeed??380;
      const grav=state.gravity??9.81;
      const dragComp=1+0.0022*bestDist;
      const flight=gunneryAmmoFlight(state.ammo);
      const ballisticDeg=weapon.usesPowder
        ?Math.max(0,(0.5*grav*bestDist/(gunSpeed*gunSpeed))*180/Math.PI*1.12*dragComp)
        :bowElevationDegrees(bestDist,gunSpeed*flight.speed,flight.drag);
      // Laid from the battery's real height, since a castle gun fires down onto a waist.
      const sideGun=state.guns.find(g=>g.side===side&&!gunneryOffline(g))??state.guns[0];
      const muzzleY=sideGun?gunMuzzlePose(sideGun,boat).localPosition[1]:1.6;
      const heightDeg=Math.atan2(bestLocal[1]-muzzleY,bestDist)*180/Math.PI;
      const clampedElev=+(Math.max(eRange.min,Math.min(eRange.max,ballisticDeg+heightDeg))).toFixed(1);
      this.setTraverse(clampedTrav);
      this.setElevation(clampedElev);
      return {side,traverse:clampedTrav,elevation:clampedElev,distance:Math.round(bestDist)};
    },
    get showTrajectory(){return showTrajectoryMode;},
    setShowTrajectory(enabled){showTrajectoryMode=Boolean(enabled);if(!showTrajectoryMode){lastAimSummary=null;cachedAimArcs=null;}return showTrajectoryMode;},
    get aimSummary(){return lastAimSummary;},
    computeAimTrajectories({wind=[0,0,0],fallbackSide=null}={}){
      const activeSide=sideValid(boat.gunnerySide)?boat.gunnerySide:(sideValid(fallbackSide)?fallbackSide:null);
      if(!showTrajectoryMode||!activeSide){
        lastAimSummary=null;
        cachedAimArcs=null;
        return [];
      }
      const targetElevation=Number.isFinite(boat.gunneryElevation)?boat.gunneryElevation:0;
      const targetTraverse=Number.isFinite(boat.gunneryTraverse)?boat.gunneryTraverse:0;
      const ammoKey=state.ammo??'round';
      const quoinKey=pending?.effectiveQuoin??targetElevation;
      // Reuse cached trajectory preview within 45 ms unless aiming parameters or ship pose changed significantly
      if(
        cachedAimArcs &&
        state.time - cachedAimTime >= 0 &&
        state.time - cachedAimTime < 0.045 &&
        cachedAimSide === activeSide &&
        cachedAimAmmo === ammoKey &&
        Math.abs(cachedAimElev - targetElevation) < 1e-3 &&
        Math.abs(cachedAimTrav - targetTraverse) < 1e-3 &&
        Math.abs(cachedAimQuoin - quoinKey) < 1e-3 &&
        Math.abs(cachedAimX - (boat.x ?? 0)) < 0.15 &&
        Math.abs(cachedAimZ - (boat.z ?? 0)) < 0.15 &&
        Math.abs(cachedAimHeading - (boat.heading ?? 0)) < 0.1 &&
        Math.abs(cachedAimRoll - (boat.roll ?? 0)) < 0.0025
      ){
        return cachedAimArcs;
      }
      const sideGuns=state.guns.filter(g=>g.side===activeSide&&!g.dismounted);
      if(!sideGuns.length){
        lastAimSummary=null;
        cachedAimArcs=null;
        return [];
      }
      // Sort by fore-to-aft z coordinate to pick representative fore, midships, and aft guns
      const sorted=[...sideGuns].sort((a,b)=>(a.muzzleDesign?.[2]??0)-(b.muzzleDesign?.[2]??0));
      const picked=sorted.length<=2
        ?sorted
        :[sorted[0],sorted[Math.floor(sorted.length*0.5)],sorted[sorted.length-1]];
      const windVec=Array.isArray(wind)&&wind.length===3?wind:[0,0,0];
      const allSegments=[];
      let midTrace=null;
      for(let i=0;i<picked.length;i++){
        const isMid=i===Math.floor(picked.length*0.5);
        const trace=traceBallisticPreview(picked[i],windVec,{
          elevationDeg:targetElevation,
          traverseDeg:targetTraverse,
          rollRad:0,
          alpha:isMid?0.84:0.54,
          isLiveRoll:false,
        });
        if(isMid||!midTrace)midTrace=trace;
        allSegments.push(...trace.segments);
      }
      // Also render the live instantaneous roll trajectory from the midships gun when the vessel is rolling
      if(Math.abs(boat.roll??0)>0.008){
        const midGun=picked[Math.floor(picked.length*0.5)];
        const liveTrace=traceBallisticPreview(midGun,windVec,{
          elevationDeg:quoinKey,
          traverseDeg:targetTraverse,
          rollRad:boat.roll??0,
          alpha:0.42,
          isLiveRoll:true,
        });
        allSegments.push(...liveTrace.segments);
      }
      lastAimSummary=midTrace?{
        side:activeSide,
        rangeMeters:midTrace.rangeMeters,
        flightSeconds:midTrace.flightSeconds,
        hitKind:midTrace.hitKind,
        hitZone:midTrace.hitZone,
        targetElevation,
        targetTraverse,
      }:null;
      cachedAimArcs=allSegments;
      cachedAimTime=state.time;
      cachedAimSide=activeSide;
      cachedAimAmmo=ammoKey;
      cachedAimElev=targetElevation;
      cachedAimTrav=targetTraverse;
      cachedAimQuoin=quoinKey;
      cachedAimX=boat.x??0;
      cachedAimZ=boat.z??0;
      cachedAimHeading=boat.heading??0;
      cachedAimRoll=boat.roll??0;
      return allSegments;
    },
    // Reuse the two previously reserved Hull axis padding floats. GPU lighting
    // resolves the actual attachment, with no additional binding or larger UBO.
    get flash(){const age=flash?state.time-flash.time:1;return age>=0&&age<.085?{gunId:flash.gunId,energy:flash.side*Math.min(1,Math.cbrt(flash.mass/12))*Math.sin(Math.PI*age/.085)}:null;},
  };
}

let nextCollisionVesselUid = 1;
function getCollisionVesselUid(boat) {
  if (!boat) return 0;
  if (!boat._collisionUid) boat._collisionUid = nextCollisionVesselUid++;
  return boat._collisionUid;
}

function vesselCollisionHullSpheres(boat) {
  const L = boat.length ?? 20;
  const B = boat.beam ?? 6;
  const halfB = B * 0.5;
  const headingRad = ((boat.heading ?? 0) * Math.PI) / 180;
  const fwdX = Math.sin(headingRad);
  const fwdZ = -Math.cos(headingRad);
  const bx = boat.x ?? 0;
  const bz = boat.z ?? 0;
  const stations = [
    [-0.43, 0.62, false],
    [-0.30, 0.82, false],
    [-0.15, 0.96, false],
    [0.00, 1.02, false],
    [0.15, 0.96, false],
    [0.30, 0.80, false],
    [0.43, 0.56, false],
  ];
  const modelId = boat.model?.id ?? boat.modelId ?? 'nina';
  const hasBowsprit = modelId !== 'taino-canoe' && (boat.model?.rig?.sails?.length ?? 1) > 0;
  if (hasBowsprit) {
    stations.push([0.55, 0.28, true]);
  }
  const spheres = new Array(stations.length);
  for (let i = 0; i < stations.length; i++) {
    const [sFrac, widthMul, isBowsprit] = stations[i];
    spheres[i] = {
      wx: bx + sFrac * L * fwdX,
      wz: bz + sFrac * L * fwdZ,
      r: halfB * widthMul,
      sFrac,
      localZ: -sFrac * L,
      isBowsprit,
    };
  }
  return { spheres, fwdX, fwdZ, rightX: Math.cos(headingRad), rightZ: Math.sin(headingRad), L, B };
}

function applySingleVesselCollisionDamage(targetBoat, otherBoat, contact, { isBowImpact, isRammedBeam } = {}) {
  const damage = createVesselDamageState(targetBoat);
  const L = targetBoat.length ?? 20;
  const B = targetBoat.beam ?? 6;
  const worldPt = contact.position;
  const localPt = vesselWorldToLocal(targetBoat, [
    worldPt[0],
    (targetBoat.heave ?? 0) + (isBowImpact ? 1.05 : 0.45),
    worldPt[2],
  ]);
  localPt[0] = Math.max(-B * 0.48, Math.min(B * 0.48, localPt[0] || (B * 0.42)));
  localPt[1] = Math.max(-0.4, Math.min(1.6, localPt[1]));
  localPt[2] = Math.max(-L * 0.48, Math.min(L * 0.48, localPt[2]));

  const designPt = localToShipDesignPoint(targetBoat, localPt) ?? [0, 0.6, 0];
  const side = localPt[0] >= 0 ? 1 : -1;
  const sideName = side >= 0 ? 'starboard' : 'port';

  const rawEnergy = contact.energy ?? 80000;
  // Scale low-to-medium speed hull crunching so a 2-6 m/s collision inflicts realistic structural damage.
  const massFactor = Math.min(2.2, Math.max(0.55, (otherBoat?.hydrodynamics?.mass ?? 60000) / Math.max(15000, targetBoat?.hydrodynamics?.mass ?? 60000)));
  const hullEnergy = rawEnergy * (isRammedBeam ? 1.55 : isBowImpact ? 0.95 : 1.15) * massFactor;

  damage.hits = (damage.hits ?? 0) + 1;
  damage.hullHits = (damage.hullHits ?? 0) + 1;
  damage.hullDamageJoules = (damage.hullDamageJoules ?? 0) + hullEnergy;
  damage.hullIntegrity = Math.max(0, 1 - damage.hullDamageJoules / damage.maxHullEnergy);

  const resolvedPart = resolveShipHitPart(targetBoat, localPt, 'hull');
  const hitPartId = resolvedPart?.id ?? (isBowImpact ? 'hull.bowsprit_stem' : `hull.${sideName}_planking`);
  const prevPart = damage.partDamage[hitPartId] ?? 0;
  const deltaDamage = hullEnergy / Math.max(20000, damage.maxHullEnergy * 0.22);
  damage.partDamage[hitPartId] = Math.min(1, +(prevPart + Math.max(0.08, deltaDamage * 1.4)).toFixed(3));

  const siteSeverity = Math.min(1.35, Math.max(0.38, Math.cbrt(hullEnergy / 65000) * 0.68));
  const stepDepth = Math.min(0.38, Math.max(0.14, siteSeverity * 0.26));
  const baseRadius = Math.min(0.095, Math.max(0.055, 0.050 + siteSeverity * 0.028));

  const crater = {
    x: +(side * Math.max(0.35, Math.abs(designPt[0]))).toFixed(3),
    y: +Math.max(0.15, Math.min(1.45, designPt[1])).toFixed(3),
    z: +Math.max(-5.8, Math.min(5.8, designPt[2])).toFixed(3),
    side,
    radius: +baseRadius.toFixed(3),
    depth: +stepDepth.toFixed(3),
    severity: +siteSeverity.toFixed(3),
    hits: 1,
  };
  damage.craters.push(crater);
  if (damage.craters.length > 28) damage.craters.shift();
  damage.pendingBakes.push({
    kind: 'hull-crater',
    x: crater.x,
    y: crater.y,
    z: crater.z,
    side,
    radius: crater.radius,
    stepDepth: crater.depth,
    severity: crater.severity,
    hits: 1,
  });

  // Bow or bowsprit collision shock to rigging and foremast
  let rigDamageApplied = false;
  if (isBowImpact || contact.bowspritContact) {
    const rigEnergy = rawEnergy * (contact.bowspritContact ? 1.35 : 0.85) * massFactor;
    damage.rigHits = (damage.rigHits ?? 0) + 1;
    damage.rigDamageJoules = (damage.rigDamageJoules ?? 0) + rigEnergy;
    damage.rigIntegrity = Math.max(0, 1 - damage.rigDamageJoules / damage.maxRigEnergy);
    damage.partDamage['rig.bowsprit'] = Math.min(1, +((damage.partDamage['rig.bowsprit'] ?? 0) + Math.max(0.18, rigEnergy / (damage.maxRigEnergy * 0.3))).toFixed(3));
    damage.partDamage['rig.fore.mast'] = Math.min(1, +((damage.partDamage['rig.fore.mast'] ?? 0) + Math.max(0.10, rigEnergy / (damage.maxRigEnergy * 0.45))).toFixed(3));
    if (damage.mastIntegrity && Number.isFinite(damage.mastIntegrity.fore)) {
      damage.mastIntegrity.fore = Math.max(0, +(damage.mastIntegrity.fore - rigEnergy / Math.max(18000, damage.maxRigEnergy * 0.42)).toFixed(3));
      const prevStage = damage.mastState?.fore ?? 0;
      const nextStage = damage.mastIntegrity.fore <= 0.18 ? 2 : damage.mastIntegrity.fore <= 0.58 ? 1 : 0;
      if (nextStage > prevStage && damage.mastState) {
        damage.mastState.fore = nextStage;
        queueMastBreak(damage, {
          kind: 'mast-break',
          mastGroup: 'fore',
          stage: nextStage === 2 ? 'full' : 'topmast',
          side,
          pivotY: nextStage === 2 ? 1.85 : 6.2,
          pivotZ: -3.2,
        });
      }
    }
    rigDamageApplied = true;
  }

  // Waterline breach & compartment flooding when heavily rammed or high-energy hull crunch
  let waterlineBreached = false;
  if ((isRammedBeam && contact.impactSpeed >= 1.85) || hullEnergy >= 135000) {
    const halfL = Math.max(6, L * 0.5);
    const compSection = localPt[2] < -halfL * 0.28 ? 'fore' : localPt[2] > halfL * 0.28 ? 'aft' : 'mid';
    const compSide = side >= 0 ? 'Starboard' : 'Port';
    const compKey = `${compSection}${compSide}`;
    const comp = damage.compartments?.[compKey];
    const holeArea = +(0.014 * Math.max(0.7, Math.cbrt(hullEnergy / 110000)) * (isRammedBeam ? 1.45 : 0.9)).toFixed(5);
    damage.breaches = (damage.breaches ?? 0) + 1;
    damage.waterlineBreaches = (damage.waterlineBreaches ?? 0) + 1;
    damage.waterlineBreachArea = +((damage.waterlineBreachArea ?? 0) + holeArea).toFixed(5);
    damage.breachArea = damage.waterlineBreachArea;
    if (comp) {
      comp.breached = true;
      comp.breachArea = +(comp.breachArea + holeArea).toFixed(5);
    }
    waterlineBreached = true;
  }

  damage.state = damage.sunk
    ? 'sunk'
    : damage.hullIntegrity > 0.75
      ? 'intact'
      : damage.hullIntegrity > 0.4
        ? 'damaged'
        : 'crippled';
  damage.revision = (damage.revision ?? 0) + 1;
  const report = {
    kind: 'collision',
    hitZone: isBowImpact ? 'bow-ram' : 'hull',
    side: sideName,
    hitPartId,
    waterlineBreach: waterlineBreached,
    rigShock: rigDamageApplied,
    hullIntegrity: +damage.hullIntegrity.toFixed(3),
    rigIntegrity: +damage.rigIntegrity.toFixed(3),
    state: damage.state,
    energyKj: +(hullEnergy / 1000).toFixed(1),
  };
  damage.lastHit = report;
  return report;
}

export function applyShipCollisionDamage(boatA, boatB, contact, options = {}) {
  if (!boatA || !boatB || !contact) return null;
  const sA = contact.stationA ?? 0;
  const sB = contact.stationB ?? 0;
  const aBow = sA >= 0.28 || Boolean(contact.bowspritA) || (contact.fwdDotA ?? 0) > 0.68;
  const bBow = sB >= 0.28 || Boolean(contact.bowspritB) || (contact.fwdDotB ?? 0) > 0.68;
  const aRammedBeam = bBow && Math.abs(sA) < 0.34;
  const bRammedBeam = aBow && Math.abs(sB) < 0.34;

  const reportA = applySingleVesselCollisionDamage(boatA, boatB, contact, {
    isBowImpact: aBow,
    isRammedBeam: aRammedBeam,
  });
  const reportB = applySingleVesselCollisionDamage(boatB, boatA, contact, {
    isBowImpact: bBow,
    isRammedBeam: bRammedBeam,
  });

  return {
    position: contact.position,
    normal: contact.normal,
    impactSpeed: contact.impactSpeed,
    energy: contact.energy,
    reportA,
    reportB,
  };
}

export function resolveVesselCollisions(vessels, dt = 1 / 60, options = {}) {
  if (!Array.isArray(vessels) || vessels.length < 2) return [];
  const active = [];
  for (let i = 0; i < vessels.length; i++) {
    const entry = vessels[i];
    const boat = entry?.boat ?? entry;
    if (!boat || boat.showProw === false || boat.damage?.sunk || boat.sinking?.sunk) continue;
    if (!boat.hydrodynamics) {
      boat.hydrodynamics = boatHydrodynamics(boat.length ?? 20, boat.beam ?? 6, boat.provisionDays, boat.cargoTonnes, boat.modelId ?? 'nina');
    }
    if (boat._collisionCooldowns && dt > 0 && Number.isFinite(dt)) {
      for (const k of Object.keys(boat._collisionCooldowns)) {
        boat._collisionCooldowns[k] -= dt;
        if (boat._collisionCooldowns[k] <= 0) delete boat._collisionCooldowns[k];
      }
    }
    active.push({ boat, entry });
  }
  if (active.length < 2) return [];

  const events = [];
  const terrain = options?.terrain ?? null;

  for (let i = 0; i < active.length; i++) {
    for (let j = i + 1; j < active.length; j++) {
      const boatA = active[i].boat;
      const boatB = active[j].boat;
      const dxAB = (boatB.x ?? 0) - (boatA.x ?? 0);
      const dzAB = (boatB.z ?? 0) - (boatA.z ?? 0);
      const maxReach = ((boatA.length ?? 20) + (boatB.length ?? 20)) * 0.65 + ((boatA.beam ?? 6) + (boatB.beam ?? 6)) * 0.6;
      if (dxAB * dxAB + dzAB * dzAB > maxReach * maxReach) continue;

      const chainA = vesselCollisionHullSpheres(boatA);
      const chainB = vesselCollisionHullSpheres(boatB);

      let bestPen = 0;
      let bestHullPen = 0;
      let bestPair = null;
      let bestHullPair = null;
      let bowspritContact = false;

      for (let ia = 0; ia < chainA.spheres.length; ia++) {
        const sA = chainA.spheres[ia];
        for (let ib = 0; ib < chainB.spheres.length; ib++) {
          const sB = chainB.spheres[ib];
          const sx = sB.wx - sA.wx;
          const sz = sB.wz - sA.wz;
          const dist = Math.hypot(sx, sz);
          const minSep = sA.r + sB.r;
          if (dist < minSep) {
            const pen = minSep - dist;
            if (sA.isBowsprit || sB.isBowsprit) bowspritContact = true;
            if (pen > bestPen) {
              bestPen = pen;
              bestPair = { sA, sB, sx, sz, dist, pen };
            }
            if (!sA.isBowsprit && !sB.isBowsprit && pen > bestHullPen) {
              bestHullPen = pen;
              bestHullPair = { sA, sB, sx, sz, dist, pen };
            }
          }
        }
      }

      const chosen = bestHullPair ?? bestPair;
      if (!chosen || chosen.pen <= 0) continue;

      const { sA, sB, sx, sz, dist, pen } = chosen;
      let nx = 0, nz = 0;
      if (dist > 1e-5) {
        nx = sx / dist;
        nz = sz / dist;
      } else {
        const cDist = Math.hypot(dxAB, dzAB);
        if (cDist > 1e-5) {
          nx = dxAB / cDist;
          nz = dzAB / cDist;
        } else {
          nx = chainA.rightX;
          nz = chainA.rightZ;
        }
      }

      const cx = sA.wx + nx * (sA.r - pen * 0.5);
      const cz = sA.wz + nz * (sA.r - pen * 0.5);
      const cy = ((boatA.heave ?? 0) + (boatB.heave ?? 0)) * 0.5 + 0.85;

      const mA = (boatA.hydrodynamics?.mass ?? 60000) + Math.max(0, (boatA.damage?.floodingTonnes ?? 0) * 1000);
      const mB = (boatB.hydrodynamics?.mass ?? 60000) + Math.max(0, (boatB.damage?.floodingTonnes ?? 0) * 1000);
      const invMA = 1 / Math.max(1000, mA);
      const invMB = 1 / Math.max(1000, mB);
      const invSum = invMA + invMB;
      const mEff = 1 / invSum;

      // 1. Position depenetration so hulls never pass through each other
      const sepDist = pen + 0.05;
      const moveA = sepDist * (invMA / invSum);
      const moveB = sepDist * (invMB / invSum);
      const targetAx = (boatA.x ?? 0) - nx * moveA;
      const targetAz = (boatA.z ?? 0) - nz * moveA;
      const targetBx = (boatB.x ?? 0) + nx * moveB;
      const targetBz = (boatB.z ?? 0) + nz * moveB;

      if (typeof terrain?.constrain === 'function') {
        const prevAx = boatA.x, prevAz = boatA.z;
        boatA.x = targetAx;
        boatA.z = targetAz;
        const cA = terrain.constrain(boatA, prevAx, prevAz);
        if (cA && typeof cA === 'object' && Number.isFinite(cA.x)) {
          boatA.x = cA.x;
          boatA.z = cA.z;
        }
        const actualMovedA = Math.hypot(boatA.x - prevAx, boatA.z - prevAz);
        const leftoverA = Math.max(0, moveA - actualMovedA);
        const prevBx = boatB.x, prevBz = boatB.z;
        boatB.x = targetBx + nx * leftoverA;
        boatB.z = targetBz + nz * leftoverA;
        const cB = terrain.constrain(boatB, prevBx, prevBz);
        if (cB && typeof cB === 'object' && Number.isFinite(cB.x)) {
          boatB.x = cB.x;
          boatB.z = cB.z;
        }
      } else {
        boatA.x = targetAx;
        boatA.z = targetAz;
        boatB.x = targetBx;
        boatB.z = targetBz;
      }
      boatA.revision = (boatA.revision ?? 0) + 1;
      boatB.revision = (boatB.revision ?? 0) + 1;

      // 2. Relative velocity at the contact point
      const surgeA = boatForwardSpeed(boatA);
      const leewayA = boatA.leewayVelocity ?? 0;
      const yawRateA = boatA.yawRate ?? 0;
      const rAx = cx - (boatA.x ?? 0);
      const rAz = cz - (boatA.z ?? 0);
      const vAx = surgeA * chainA.fwdX + leewayA * chainA.rightX - rAz * yawRateA;
      const vAz = surgeA * chainA.fwdZ + leewayA * chainA.rightZ + rAx * yawRateA;

      const surgeB = boatForwardSpeed(boatB);
      const leewayB = boatB.leewayVelocity ?? 0;
      const yawRateB = boatB.yawRate ?? 0;
      const rBx = cx - (boatB.x ?? 0);
      const rBz = cz - (boatB.z ?? 0);
      const vBx = surgeB * chainB.fwdX + leewayB * chainB.rightX - rBz * yawRateB;
      const vBz = surgeB * chainB.fwdZ + leewayB * chainB.rightZ + rBx * yawRateB;

      const rvx = vBx - vAx;
      const rvz = vBz - vAz;
      const closingSpeed = -(rvx * nx + rvz * nz);
      const tx = -nz, tz = nx;
      const tangentSpeed = rvx * tx + rvz * tz;
      const relSpeed = Math.hypot(rvx, rvz);

      // 3. 6-DOF rigid-body collision & grinding impulse
      const restitution = 0.30;
      const minSepSpeed = Math.min(1.35, 0.38 + pen * 0.95);
      const dvNormal = closingSpeed > 0
        ? Math.max((1 + restitution) * closingSpeed, minSepSpeed)
        : minSepSpeed;
      const jN = mEff * dvNormal * 1.22;
      const jT = -Math.sign(tangentSpeed) * Math.min(Math.abs(tangentSpeed) * mEff * 0.48, jN * 0.34);

      const impBx = nx * jN + tx * jT;
      const impBz = nz * jN + tz * jT;
      applyRigidHullImpulse(boatA, [cx, cy, cz], [-impBx, 0, -impBz]);
      applyRigidHullImpulse(boatB, [cx, cy, cz], [impBx, 0, impBz]);

      // If a vessel is in manual speed mode and rams head-on, bled speed is reflected in boat.speed
      if (boatA.propulsion !== 'sail' && Number.isFinite(boatA.speed) && sA.sFrac > 0.2 && closingSpeed > 0.5) {
        boatA.speed = Math.max(0, +(boatA.speed * 0.35).toFixed(2));
      }
      if (boatB.propulsion !== 'sail' && Number.isFinite(boatB.speed) && sB.sFrac > 0.2 && closingSpeed > 0.5) {
        boatB.speed = Math.max(0, +(boatB.speed * 0.35).toFixed(2));
      }

      // 4. Kinetic-energy-scaled structural damage with pair cooldown
      const impactSpeed = Math.max(closingSpeed, relSpeed * 0.55, pen > 0.45 ? 1.4 : 0);
      const uidA = getCollisionVesselUid(boatA);
      const uidB = getCollisionVesselUid(boatB);
      const pairKey = uidA < uidB ? `${uidA}:${uidB}` : `${uidB}:${uidA}`;
      boatA._collisionCooldowns ??= {};
      boatB._collisionCooldowns ??= {};
      const onCooldown = (boatA._collisionCooldowns[pairKey] ?? 0) > 0;

      let damageOutcome = null;
      const collisionEnergy = 0.5 * mEff * impactSpeed * impactSpeed;
      if (!onCooldown && impactSpeed >= 0.48) {
        boatA._collisionCooldowns[pairKey] = 0.50;
        boatB._collisionCooldowns[pairKey] = 0.50;
        const contactInfo = {
          position: [cx, cy, cz],
          normal: [nx, 0, nz],
          penetration: pen,
          closingSpeed,
          impactSpeed,
          energy: collisionEnergy,
          stationA: sA.sFrac,
          stationB: sB.sFrac,
          fwdDotA: chainA.fwdX * nx + chainA.fwdZ * nz,
          fwdDotB: -(chainB.fwdX * nx + chainB.fwdZ * nz),
          bowspritA: sA.isBowsprit,
          bowspritB: sB.isBowsprit,
          bowspritContact,
        };
        damageOutcome = applyShipCollisionDamage(boatA, boatB, contactInfo, options);
      }

      const collisionEvent = {
        type: 'collision',
        kind: 'ship',
        boatA,
        boatB,
        entryA: active[i].entry,
        entryB: active[j].entry,
        position: [cx, cy, cz],
        surfacePosition: [cx, cy, cz],
        normal: [nx, 0.15, nz],
        velocity: [rvx, 0, rvz],
        penetration: pen,
        closingSpeed,
        impactSpeed,
        energy: collisionEnergy,
        mass: Math.min(28, Math.max(6, mEff / 4500)),
        damageOutcome,
      };
      if (damageOutcome && typeof options?.onCollision === 'function') {
        options.onCollision(collisionEvent);
      }
      events.push(collisionEvent);
    }
  }
  return events;
}

const GROUNDING_GRIND_SCALE = 0.15;
export function applyGroundingImpactDamage(boat, contact, options = {}) {
  if (!boat || !contact) return null;
  const subInfo = contact.substrateInfo ?? GROUNDING_SUBSTRATES[contact.substrate] ?? GROUNDING_SUBSTRATES.shoal;
  const impactSpeed = Math.max(0, Number.isFinite(contact.impactSpeed) ? contact.impactSpeed : 0);
  if (impactSpeed <= subInfo.safeTouchSpeed) return null;

  const damage = createVesselDamageState(boat);
  // A hull working on the bottom at a crawl grinds, not strikes. This contact arrives every
  // frame, so hard knocks count each time but slow grinding only every second and a half.
  const groundingNow = options.nowMs ?? performance.now();
  if (impactSpeed < 1.2 && groundingNow < (damage.groundingQuietUntilMs ?? -Infinity)) return null;
  damage.groundingQuietUntilMs = groundingNow + 1500;
  const L = boat.length ?? 20;
  const B = boat.beam ?? 6;
  const mass = (boat.hydrodynamics?.mass ?? 60000) + Math.max(0, (damage.floodingTonnes ?? 0) * 1000);
  const isScrape = contact.type === 'shoal-scrape';
  const effSpeed = Math.max(0.15, impactSpeed - subInfo.safeTouchSpeed * 0.6);
  const scrapeScale = isScrape ? Math.max(0.14, (contact.scrapeSeverity ?? 0.35) * 0.32) : 1.0;

  // Kinetic grounding impact energy scaled by substrate hardness/damageMultiplier.
  // Normalize against vessel maxHullEnergy so both light craft and heavy ships experience
  // realistic speed-dependent grounding damage when striking rock, reef, shoal, or sand.
  const speedNormEnergy = damage.maxHullEnergy * 0.032 * effSpeed * effSpeed * scrapeScale;
  const rawKinetic = 0.5 * mass * effSpeed * effSpeed * scrapeScale;
  const baseEnergy = Math.max(speedNormEnergy, Math.min(rawKinetic, damage.maxHullEnergy * 0.48));
  // Working on the bottom wears a hull down over many minutes. Only a real blow breaks her.
  const hullEnergy = baseEnergy * subInfo.damageMultiplier * (impactSpeed < 1.2 ? GROUNDING_GRIND_SCALE : 1);

  damage.hits = (damage.hits ?? 0) + 1;
  damage.hullHits = (damage.hullHits ?? 0) + 1;
  damage.groundingHits = (damage.groundingHits ?? 0) + 1;
  damage.groundingSubstrate = subInfo.id;
  damage.hullDamageJoules = (damage.hullDamageJoules ?? 0) + hullEnergy;
  damage.hullIntegrity = Math.max(0, 1 - damage.hullDamageJoules / damage.maxHullEnergy);

  const localPt = Array.isArray(contact.localPosition)
    ? [...contact.localPosition]
    : [0, -(boat.hydrodynamics?.draft ?? 2) * 0.85, -L * 0.35];
  const side = localPt[0] >= 0 ? 1 : -1;
  const sideName = side >= 0 ? 'starboard' : 'port';
  const designPt = localToShipDesignPoint(boat, localPt) ?? [side * 0.45, -0.35, -3.5];

  const deltaPart = Math.max(0.06, hullEnergy / Math.max(20000, damage.maxHullEnergy * 0.25));
  damage.partDamage['keel.main'] = Math.min(1, +((damage.partDamage['keel.main'] ?? 0) + deltaPart * 1.25).toFixed(3));
  damage.partDamage['hull.garboard'] = Math.min(1, +((damage.partDamage['hull.garboard'] ?? 0) + deltaPart * 1.15).toFixed(3));
  const stationPart = contact.station === 'bow' || localPt[2] < -L * 0.22
    ? 'hull.stem'
    : contact.station === 'stern' || localPt[2] > L * 0.22
      ? 'hull.sternpost'
      : `hull.${sideName}_planking`;
  damage.partDamage[stationPart] = Math.min(1, +((damage.partDamage[stationPart] ?? 0) + deltaPart).toFixed(3));

  // 3D lower-bilge / keel stove-in deformation crater
  const siteSeverity = Math.min(1.4, Math.max(0.35, Math.cbrt(hullEnergy / Math.max(15000, damage.maxHullEnergy * 0.08)) * 0.68));
  const stepDepth = Math.min(0.40, Math.max(0.12, siteSeverity * 0.26));
  const baseRadius = Math.min(0.095, Math.max(0.052, 0.048 + siteSeverity * 0.028));
  const crater = {
    x: +(side * Math.max(0.32, Math.min(1.35, Math.abs(designPt[0]) || 0.55))).toFixed(3),
    y: +Math.max(-0.55, Math.min(0.25, designPt[1])).toFixed(3),
    z: +Math.max(-5.8, Math.min(5.8, designPt[2])).toFixed(3),
    side,
    radius: +baseRadius.toFixed(3),
    depth: +stepDepth.toFixed(3),
    severity: +siteSeverity.toFixed(3),
    hits: 1,
  };
  damage.craters.push(crater);
  if (damage.craters.length > 28) damage.craters.shift();
  damage.pendingBakes.push({
    kind: 'hull-crater',
    x: crater.x,
    y: crater.y,
    z: crater.z,
    side,
    radius: crater.radius,
    stepDepth: crater.depth,
    severity: crater.severity,
    hits: 1,
  });

  // Underwater bilge/keel breach & compartment flooding
  let waterlineBreached = false;
  const breachTriggered =
    impactSpeed >= subInfo.breachSpeedThreshold ||
    (!isScrape && (subInfo.id === 'stone' || subInfo.id === 'reef') && damage.hullIntegrity <= 0.78) ||
    (isScrape && (subInfo.id === 'stone' || subInfo.id === 'reef') && impactSpeed >= subInfo.breachSpeedThreshold * 0.95);

  if (breachTriggered) {
    const halfL = Math.max(6, L * 0.5);
    const compSection = localPt[2] < -halfL * 0.25 ? 'fore' : localPt[2] > halfL * 0.25 ? 'aft' : 'mid';
    const compSide = side >= 0 ? 'Starboard' : 'Port';
    const compKey = `${compSection}${compSide}`;
    const comp = damage.compartments?.[compKey];
    const holeArea = +(
      0.018 *
      subInfo.breachMultiplier *
      Math.max(0.65, effSpeed / 1.8) *
      (isScrape ? 0.45 : 1.15)
    ).toFixed(5);
    damage.breaches = (damage.breaches ?? 0) + 1;
    damage.waterlineBreaches = (damage.waterlineBreaches ?? 0) + 1;
    damage.waterlineBreachArea = +((damage.waterlineBreachArea ?? 0) + holeArea).toFixed(5);
    damage.breachArea = damage.waterlineBreachArea;
    damage.breachSideMoment = +((damage.breachSideMoment ?? 0) + side * holeArea).toFixed(5);
    const trimWeight = localPt[2] < -halfL * 0.15 ? -0.65 : localPt[2] > halfL * 0.15 ? 0.65 : -0.25;
    damage.breachTrimMoment = +((damage.breachTrimMoment ?? 0) + trimWeight * holeArea).toFixed(5);

    const wpArea = Math.max(2.5, boat.hydrodynamics?.waterplaneArea ?? (L * B * 0.72));
    const floodAdd = +(
      Math.min(wpArea * 0.35, 0.85 * subInfo.breachMultiplier * (effSpeed / 1.6) * (isScrape ? 0.35 : 1.0))
    ).toFixed(3);
    if (comp) {
      comp.breached = true;
      comp.breachArea = +(comp.breachArea + holeArea).toFixed(5);
      comp.waterTonnes = +(comp.waterTonnes + floodAdd).toFixed(3);
    }
    damage.floodingTonnes = +((damage.floodingTonnes ?? 0) + floodAdd).toFixed(3);
    if (Number.isFinite(boat.hydrodynamics?.waterplaneArea) && Number.isFinite(boat.length) && Number.isFinite(boat.beam)) {
      boat.cargoTonnes = Math.min(100, (boat.cargoTonnes ?? 0) + floodAdd);
      try {
        boat.hydrodynamics = boatHydrodynamics(
          boat.length,
          boat.beam,
          boat.provisionDays ?? 30,
          boat.cargoTonnes,
          boat.modelId ?? 'nina',
        );
      } catch {
        // Keep existing hydrodynamics if modelId is custom
      }
    }
    damage.floodingSinkage = +((damage.floodingTonnes * 1000) / (1025 * wpArea)).toFixed(4);
    waterlineBreached = true;
  }

  // Sudden deceleration mast whip on hard rock/reef impact
  let rigShock = false;
  if (!isScrape && (subInfo.id === 'stone' || subInfo.id === 'reef') && impactSpeed >= 2.5) {
    const whipEnergy = damage.maxRigEnergy * 0.035 * (impactSpeed - 2.0) * subInfo.hardness;
    damage.rigHits = (damage.rigHits ?? 0) + 1;
    damage.rigDamageJoules = (damage.rigDamageJoules ?? 0) + whipEnergy;
    if (damage.mastIntegrity && Number.isFinite(damage.mastIntegrity.fore)) {
      damage.mastIntegrity.fore = Math.max(0, +(damage.mastIntegrity.fore - whipEnergy / Math.max(15000, damage.maxRigEnergy * 0.38)).toFixed(3));
      damage.rigIntegrity = (damage.mastIntegrity.fore + damage.mastIntegrity.main + damage.mastIntegrity.mizzen) / 3;
      const prevStage = damage.mastState?.fore ?? 0;
      const nextStage = damage.mastIntegrity.fore <= 0.20 ? 2 : (damage.mastIntegrity.fore <= 0.60 || impactSpeed >= 5.2) ? 1 : 0;
      if (nextStage > prevStage && damage.mastState) {
        damage.mastState.fore = nextStage;
        queueMastBreak(damage, {
          kind: 'mast-break',
          mastGroup: 'fore',
          stage: nextStage === 2 ? 'full' : 'topmast',
          side,
          pivotY: nextStage === 2 ? 1.85 : 6.2,
          pivotZ: -3.2,
        });
      }
    }
    rigShock = true;
  }

  // Check if the vessel has been stove in / wrecked on the rocks or reef
  const baseFreeboard = Math.max(0.35, Math.min(2.6, boat.hydrodynamics?.freeboard ?? 1.8));
  if (
    damage.hullIntegrity <= 0.12 ||
    damage.floodingSinkage >= baseFreeboard * 0.95 ||
    ((subInfo.id === 'stone' || subInfo.id === 'reef') && damage.hullIntegrity <= 0.26 && damage.waterlineBreachArea >= 0.035)
  ) {
    damage.sunk = true;
    if (subInfo.id === 'stone' || subInfo.id === 'reef') {
      damage.wreckedOnRocks = true;
    }
    damage.floodingRoll = boat.groundingRoll || side * 0.34;
    damage.floodingPitch = boat.groundingPitch || -0.18;
  }

  damage.state = damage.sunk
    ? (damage.wreckedOnRocks ? 'wrecked-on-rocks' : 'sunk')
    : damage.hullIntegrity > 0.75
      ? 'intact'
      : damage.hullIntegrity > 0.4
        ? 'damaged'
        : 'crippled';
  damage.revision = (damage.revision ?? 0) + 1;

  const report = {
    kind: 'grounding',
    contactType: contact.type ?? 'grounding',
    substrate: subInfo.id,
    substrateLabel: subInfo.label,
    station: contact.station ?? 'keel',
    impactSpeed: +impactSpeed.toFixed(2),
    waterlineBreach: waterlineBreached,
    rigShock,
    hullIntegrity: +damage.hullIntegrity.toFixed(3),
    rigIntegrity: +damage.rigIntegrity.toFixed(3),
    breaches: damage.breaches ?? 0,
    waterlineBreachArea: +(damage.waterlineBreachArea ?? 0).toFixed(5),
    floodingTonnes: +(damage.floodingTonnes ?? 0).toFixed(2),
    wreckedOnRocks: Boolean(damage.wreckedOnRocks),
    sunk: Boolean(damage.sunk),
    state: damage.state,
    energyKj: +(hullEnergy / 1000).toFixed(1),
  };
  damage.lastHit = report;
  damage.lastGrounding = report;
  return report;
}

setGroundingDamageHandler(applyGroundingImpactDamage);

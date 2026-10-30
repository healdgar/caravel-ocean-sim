// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
import { createGunneryState, prepareGunnery, fireGunnery, stepGunnery, gunnerySummary, resolveGunneryImpact, GUNNERY_AMMO_TYPES } from './gunnery-state.js';
import { createGunDefinitions, createNavalBattleGunDefinitions, gunMuzzlePose, gunElevationRange, gunTraverseRange } from './gunnery-models.js';
import { GUNNERY_ORDER_SECONDS } from './gunnery-audio.js';
import { boatRotate, boatHydrodynamics, boatForwardSpeed } from './boat.js';
import { SHIP_MODELS } from './ship-models.js';
import { createShipAssetCache } from './ship-mesh.js';
import { PORT_PREFABS, getBuildingParts } from './coastal-world.js';
import { GROUNDING_SUBSTRATES, classifyGroundingSubstrate, setGroundingDamageHandler } from './terrain-model.js';
import { locatePartAtLocalPoint, isSuperstructurePartId } from './part-assembly.js';
import { createFortGarrison, stepFortGarrison } from './crew.js';

export { GROUNDING_SUBSTRATES, classifyGroundingSubstrate };

let gunneryShipAssetCache = null;

function getModelMastSpecs(modelId) {
  if (modelId === 'taino-canoe') return [];
  if (modelId === 'oseberg' || modelId === 'lusoria') {
    return [['main', 0.0, 4.2, 1.15]];
  }
  if (modelId === 'gipsy-moth-iv') {
    return [
      ['main', -1.15, 4.8, 1.25],
      ['mizzen', 2.7, 3.4, 1.15],
    ];
  }
  if (modelId === 'nina') {
    return [
      ['fore', -3.6, 4.35, 1.45],
      ['main', -0.2, 5.1, 1.35],
      ['mizzen', 3.4, 3.95, 1.85],
    ];
  }
  if (modelId === 'pinta') {
    return [
      ['fore', -3.5, 4.2, 1.45],
      ['main', 0.1, 5.2, 1.35],
      ['mizzen', 3.8, 3.8, 1.75],
    ];
  }
  if (modelId === 'santa-maria') {
    return [
      ['fore', -3.55, 4.6, 1.65],
      ['main', 0.05, 5.65, 1.45],
      ['mizzen', 3.85, 4.1, 1.95],
    ];
  }
  if (modelId === 'flying-cloud') {
    return [
      ['fore', -3.4, 5.6, 1.45],
      ['main', 0.15, 6.1, 1.4],
      ['mizzen', 3.45, 5.1, 1.55],
    ];
  }
  return [
    ['fore', -3.55, 5.72, 2.05],
    ['main', 0.05, 6.18, 1.55],
    ['mizzen', 3.53, 5.15, 2.05],
  ];
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

function resolveShipHitPart(targetBoat, localPosition, hitZone) {
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
    const designPt = localToShipDesignPoint(targetBoat, localPosition);
    const subAssemblies =
      hitZone === 'rigging'
        ? ['masts-and-spars', 'rigging-and-sails']
        : ['keel-and-frame', 'decks-and-interior', 'ordnance-and-helm', 'hull-and-bulwarks'];
    return locatePartAtLocalPoint(partAssembly, designPt, { subAssemblies });
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
  const barrelsTotal = isFirstRate ? 350 : Math.max(8, gunCount * 3);
  const initialPowderKg = +(barrelsTotal * barrelMassKg).toFixed(1);
  const initialRounds = {
    round: isFirstRate ? 6200 : gunCount * 50,
    hot: isFirstRate ? 240 : gunCount * 6,
    chain: isFirstRate ? 620 : gunCount * 10,
    grape: isFirstRate ? 840 : gunCount * 12,
  };
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
  if (!mag || mag.exploded) return mag;
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

export function createVesselDamageState(boat) {
  const magazine = createVesselMagazineState(boat);
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

  // Queue the 3D mesh explosion deformation (heaves decks upward, blows port & starboard hull planking outward).
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

export function sweepShipSegment(from, to, radius = 0.08, targetBoat, sourceBoat = null, options = null) {
  if (!targetBoat || targetBoat === sourceBoat || targetBoat.showProw === false) return null;
  const L = targetBoat.length ?? 20, B = targetBoat.beam ?? 6;
  const boundR = Math.max(L, B) * 1.1 + 12;
  const midX = (from[0] + to[0]) * 0.5 - (targetBoat.x ?? 0);
  const midZ = (from[2] + to[2]) * 0.5 - (targetBoat.z ?? 0);
  const segLen = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]);
  if (Math.hypot(midX, midZ) > boundR + segLen * 0.5) return null;

  const draft = (targetBoat.hydrodynamics?.draft ?? 2.2) + radius;
  const mastTop = Math.max(14, L * 0.85) + radius;
  const heave = targetBoat.heave ?? 0;
  if (Math.max(from[1], to[1]) < heave - draft - 4 || Math.min(from[1], to[1]) > heave + mastTop + 4) {
    return null;
  }

  // Compute vessel basis once for both endpoints instead of 6 boatRotate calls.
  const { ax, ay, az } = vesselBasisAxes(targetBoat);
  const bx = targetBoat.x ?? 0, bz = targetBoat.z ?? 0;
  const dx0 = from[0] - bx, dy0 = from[1] - heave, dz0 = from[2] - bz;
  const dx1 = to[0] - bx, dy1 = to[1] - heave, dz1 = to[2] - bz;
  const p0 = [
    dx0 * ax[0] + dy0 * ax[1] + dz0 * ax[2],
    dx0 * ay[0] + dy0 * ay[1] + dz0 * ay[2],
    dx0 * az[0] + dy0 * az[1] + dz0 * az[2],
  ];
  const p1 = [
    dx1 * ax[0] + dy1 * ax[1] + dz1 * ax[2],
    dx1 * ay[0] + dy1 * ay[1] + dz1 * ay[2],
    dx1 * az[0] + dy1 * az[1] + dz1 * az[2],
  ];

  const halfL = L * 0.52 + radius;
  const halfB = B * 0.52 + radius;
  const baseFreeboard = Math.max(4.6, (targetBoat.hydrodynamics?.freeboard ?? 1.8) * 2.1 + B * 0.35) + radius;
  const maxWidth = Math.max(halfB, B * 0.85 + radius);

  // Fast 3D local AABB slab test to reject misses and restrict marching to [tEnter, tExit].
  let tEnter = 0, tExit = 1;
  const minB = [-maxWidth, -draft, -halfL];
  const maxB = [maxWidth, mastTop, halfL];
  for (let a = 0; a < 3; a++) {
    const d = p1[a] - p0[a];
    if (Math.abs(d) < 1e-9) {
      if (p0[a] < minB[a] || p0[a] > maxB[a]) return null;
    } else {
      let t1 = (minB[a] - p0[a]) / d;
      let t2 = (maxB[a] - p0[a]) / d;
      if (t1 > t2) { const tmp = t1; t1 = t2; t2 = tmp; }
      if (t1 > tEnter) tEnter = t1;
      if (t2 < tExit) tExit = t2;
      if (tEnter > tExit) return null;
    }
  }

  const modelId = targetBoat.model?.id ?? targetBoat.modelId;
  const model = modelId ? SHIP_MODELS[modelId] : null;
  const f = model?.designFrame;
  const sx = f?.beam ? B / f.beam : B / 3.6;
  const sy = f?.verticalScale ?? 1;
  const sz = f?.length ? L / f.length : L / 12;
  const craters = targetBoat.damage?.craters;
  const previewOnly = options?.previewOnly === true;

  const classifyLocal = (lx, ly, lz) => {
    const castleLift = lz > L * 0.1 ? B * 0.28 : lz < -L * 0.22 ? B * 0.16 : 0;
    const freeboard = baseFreeboard + castleLift;
    if (Math.abs(lz) <= halfL && ly >= -draft && ly <= freeboard) {
      const taper = Math.max(0.32, 1 - 0.55 * (lz / halfL) ** 2);
      const dyDesign = ly / (sy || 1);
      const dzDesign = lz / (sz || 1);
      const tumblehome = dyDesign > 0.3 ? Math.max(0.76, 1 - 0.11 * Math.max(0, dyDesign - 0.3)) : 1.0;
      const outerMaxX = halfB * taper * tumblehome;
      let erodedDesign = 0;
      if (!previewOnly && Array.isArray(craters) && craters.length > 0) {
        const side = lx >= 0 ? 1 : -1;
        for (let c = 0; c < craters.length; c++) {
          const cr = craters[c];
          if (cr.side !== side) continue;
          const distYZ = Math.hypot(dyDesign - cr.y, dzDesign - cr.z);
          const envRadius = Math.max(0.18, cr.radius * 1.85);
          if (distYZ < envRadius) {
            const falloff = 1 - distYZ / envRadius;
            erodedDesign += cr.depth * falloff * falloff;
          }
        }
      }
      const maxX = Math.max(halfB * 0.08, outerMaxX - erodedDesign * (sx || 1));
      if (Math.abs(lx) <= maxX) {
        const nx = lx / Math.max(0.2, maxX), ny = (ly - (freeboard - draft) * 0.5) / Math.max(0.5, (freeboard + draft) * 0.5), nz = lz / halfL;
        return { hitZone: 'hull', mastGroup: null, localNormal: [nx, ny * 0.35, nz * 0.4] };
      }
    }
    if (ly > baseFreeboard - radius && ly <= mastTop && (targetBoat.model?.rig?.sails?.length ?? (model?.rig?.sails?.length ?? 1)) > 0) {
      const mastW = B * 0.85 + radius, mastD = L * 0.14 + radius;
      const sailCount = targetBoat.model?.rig?.sails?.length ?? model?.rig?.sails?.length ?? 3;
      const mastStations = sailCount === 1
        ? [['main', 0], ['fore', -L * 0.26], ['mizzen', L * 0.26]]
        : [['fore', -L * 0.26], ['main', 0], ['mizzen', L * 0.26]];
      for (const [group, zCenter] of mastStations) {
        if (Math.abs(lx) <= mastW && Math.abs(lz - zCenter) <= mastD) {
          return { hitZone: 'rigging', mastGroup: group, localNormal: [lx >= 0 ? 1 : -1, 0.15, (lz - zCenter) / mastD] };
        }
      }
    }
    return null;
  };

  const clippedLen = segLen * Math.max(0, tExit - tEnter);
  const stepSize = previewOnly ? 0.85 : 0.45;
  const steps = Math.min(previewOnly ? 20 : 48, Math.max(4, Math.ceil(clippedLen / stepSize)));
  let prevT = tEnter;
  for (let i = 0; i <= steps; i++) {
    const t = tEnter + (tExit - tEnter) * (i / steps);
    const lx = p0[0] + (p1[0] - p0[0]) * t;
    const ly = p0[1] + (p1[1] - p0[1]) * t;
    const lz = p0[2] + (p1[2] - p0[2]) * t;
    const hit = classifyLocal(lx, ly, lz);
    if (hit) {
      let low = prevT, high = t, bestHit = hit, bestLocal = [lx, ly, lz];
      if (i > 0) {
        const bisectIters = previewOnly ? 5 : 10;
        for (let b = 0; b < bisectIters; b++) {
          const mid = (low + high) * 0.5;
          const mx = p0[0] + (p1[0] - p0[0]) * mid;
          const my = p0[1] + (p1[1] - p0[1]) * mid;
          const mz = p0[2] + (p1[2] - p0[2]) * mid;
          const mHit = classifyLocal(mx, my, mz);
          if (mHit) { high = mid; bestHit = mHit; bestLocal = [mx, my, mz]; } else { low = mid; }
        }
      }
      const hitPart = previewOnly ? null : resolveShipHitPart(targetBoat, bestLocal, bestHit.hitZone);
      return {
        fraction: high,
        kind: 'ship',
        targetBoat,
        targetId: targetBoat.id ?? targetBoat.modelId ?? 'ship',
        targetName: targetBoat.model?.name ?? targetBoat.modelId ?? 'Vessel',
        hitZone: bestHit.hitZone,
        mastGroup: bestHit.mastGroup,
        hitPartId: hitPart?.id ?? null,
        hitSubAssembly: hitPart?.subAssembly ?? null,
        hitLayer: hitPart?.layer ?? null,
        waterline: bestHit.hitZone === 'hull' && bestLocal[1] <= 0.75,
        localPosition: bestLocal,
        normal: vesselLocalToWorldNormal(targetBoat, bestHit.localNormal),
      };
    }
    prevT = t;
  }
  return null;
}

export function applyShipImpactDamage(targetBoat, event) {
  if (!targetBoat || !event) return null;
  const damage = createVesselDamageState(targetBoat);
  const vel = event.velocity ?? [200, 0, 0];
  const speed = Math.hypot(vel[0], vel[1], vel[2]);
  const mass = event.mass ?? 5.4;
  const energy = event.energy ?? (0.5 * mass * speed * speed);
  const pos = event.surfacePosition ?? event.position ?? [targetBoat.x ?? 0, targetBoat.heave ?? 0, targetBoat.z ?? 0];
  const scale = event.hitZone === 'rigging' ? 0.35 : 1.0;
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
    damage.rigDamageJoules += effectiveRigEnergy;
    const validGroups = mastSpecs.map((m) => m[0]);
    const requestedGroup = event.mastGroup && Object.hasOwn(damage.mastIntegrity, event.mastGroup) ? event.mastGroup : 'main';
    const group =
      validGroups.length === 0 || validGroups.includes(requestedGroup)
        ? requestedGroup
        : validGroups[0];
    const prevInt = Math.max(0.05, damage.mastIntegrity[group] ?? 1);
    damage.mastIntegrity[group] = Math.max(0, damage.mastIntegrity[group] - (effectiveRigEnergy / damage.maxRigEnergy) * 1.8);
    damage.rigIntegrity = computeModelRigIntegrity(damage, mastSpecs);
    const sailKey = group === 'fore' ? 'sailFore' : group === 'mizzen' ? 'sailMizzen' : 'sailMain';
    if (typeof targetBoat[sailKey] === 'number') {
      const ratio = damage.mastIntegrity[group] / prevInt;
      targetBoat[sailKey] = Math.min(targetBoat[sailKey] * ratio, damage.mastIntegrity[group]);
    }
    const specEntry = mastSpecs.find((m) => m[0] === group);
    const mastDefaultZ = specEntry ? specEntry[1] : group === 'fore' ? -3.55 : group === 'mizzen' ? 3.53 : 0.05;
    const ripX = designPt ? Math.max(-1.85, Math.min(1.85, designPt[0])) : 0;
    const ripY = designPt ? Math.max(2.4, Math.min(8.4, designPt[1])) : 4.8;
    const ripZ = designPt ? Math.max(-5.6, Math.min(5.6, designPt[2])) : mastDefaultZ;
    const ripRadius = ammo === 'grape' ? 1.95 : ammo === 'chain' ? 1.75 : 1.25;
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
  if (ammo === 'hot') {
    damage.fireCount = (damage.fireCount ?? 0) + 1;
    const addIntensity = Math.min(1.2, 0.48 + energy / 550000);
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

  const partBudget = Math.min(
    1100000,
    (event.hitZone === 'rigging' ? damage.maxRigEnergy : damage.maxHullEnergy) * 0.18
  );
  const deltaDamage = energy / Math.max(10000, partBudget);
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
    const targetGuns = targetBoat.gunnery?.state?.guns;
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
              radius: ammo === 'chain' ? 1.55 : 1.15,
              severity: ammo === 'chain' ? 1.25 : 0.85,
              hits: damage.sailRips,
            });
          }
        }
      }

      // 3d. Striking the back wall of the hull (opposite-side inner hull wall) after crossing the interior
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
  for (const [mGroup, mastZ, topPivotY, fullPivotY] of mastSpecs) {
    const mInt = damage.mastIntegrity[mGroup] ?? 1;
    const prevStage = damage.mastState[mGroup] ?? 0;
    if (mInt <= 0.62 && prevStage < 1) {
      damage.mastState[mGroup] = 1;
      damage.pendingBakes.push({
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
      const sailKey = mGroup === 'fore' ? 'sailFore' : mGroup === 'mizzen' ? 'sailMizzen' : 'sailMain';
      if (typeof targetBoat[sailKey] === 'number') targetBoat[sailKey] = 0;
      damage.pendingBakes.push({
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
  if (damage.waterlineBreachArea > 0 && damage.floodingTonnes < maxFloodTonnes) {
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
      if (c.breachArea > 0) {
        c.breachArea = Math.max(0, c.breachArea - 0.000025 * clampedDt * damage.hullIntegrity);
        totalBreachArea += c.breachArea;
        const heelSub = Math.max(-0.20, curRoll * xSign * (boat.beam ?? 6) * 0.35);
        const trimSub = Math.max(-0.30, -curPitch * zSign * (boat.length ?? 20) * 0.22);
        const headMetres = Math.max(0.18, 0.36 + (damage.floodingSinkage ?? 0) * 0.90 + heelSub + trimSub);
        const flowVelocity = 0.78 * Math.sqrt(2 * 9.81 * headMetres) * (1.55 + 1.15 * (1 - damage.hullIntegrity));
        const grossRate = (c.breachArea * flowVelocity * 1025) / 1000;
        const netRate = Math.max(0, grossRate - pumpCapacity * 0.22);
        if (netRate > 0 && c.waterTonnes < compMaxTonnes) {
          const add = Math.min(compMaxTonnes - c.waterTonnes, netRate * clampedDt);
          c.waterTonnes = +(c.waterTonnes + add).toFixed(3);
          totalNetAdd += add;
        }
      }
    }
    damage.waterlineBreachArea = +totalBreachArea.toFixed(5);

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
      const sideSign = damage.breachSideMoment >= 0 ? 1 : -1;
      const trimSign = damage.breachTrimMoment >= 0 ? 1 : -1;
      const targetRoll = Math.abs(heelImbalance) > 0.03
        ? Math.max(-0.54, Math.min(0.54, heelImbalance * 0.44))
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
    const sideSign = Math.abs(damage.breachSideMoment) > 1e-6
      ? Math.sign(damage.breachSideMoment)
      : (Math.sign(damage.hullSideMoment || 0) || 1);
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
        boat.settledWreck = true;
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
        intensity: f.intensity,
        age: f.age,
        seed: f.seed,
      });
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
          damage.pendingBakes.push({
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
}

export function sweepBuildingSegment(from, to, radius = 0.08, port, options = null) {
  const instances = port?.instances;
  if (!Array.isArray(instances) || !instances.length) return null;
  const midX = (from[0] + to[0]) * 0.5;
  const midZ = (from[2] + to[2]) * 0.5;
  const segHalf = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]) * 0.5;
  const portAnchorX = port.center?.x ?? port.berth?.x ?? instances[0].x ?? 0;
  const portAnchorZ = port.center?.z ?? port.berth?.z ?? instances[0].z ?? 0;
  if (Math.hypot(midX - portAnchorX, midZ - portAnchorZ) > 1800 + segHalf) return null;
  const segMinY = Math.min(from[1], to[1]);
  const segMaxY = Math.max(from[1], to[1]);
  const previewOnly = options?.previewOnly === true;
  let best = null;
  for (const inst of instances) {
    const baseY = inst.baseY ?? inst.y ?? 0;
    const foundDepth = Math.max(0, inst.foundationDepth ?? 4.5);
    const roofExtra = Math.max(
      inst.roofHeight ?? inst.roofPitch ?? 2.0,
      inst.prefabId === 'mission_chapel' ? 9.2 : inst.prefabId === 'timber_mole_pier' ? 6.2 : 1.5,
    );
    const instHeight = inst.height ?? 10;
    if (segMaxY < baseY - foundDepth - radius || segMinY > baseY + instHeight + roofExtra + radius) continue;
    const depthZ = inst.depth ?? inst.length ?? 20;
    const widthX = inst.width ?? 12;
    const halfDiag = Math.hypot(widthX, depthZ) * 0.5 + radius;
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
    const minB = [-widthX * 0.5 - radius, -foundDepth - radius, -depthZ * 0.5 - radius];
    const maxB = [widthX * 0.5 + radius, instHeight + roofExtra + radius, depthZ * 0.5 + radius];
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
    if (!best || tMin < best.fraction) {
      const ln = [0, 0, 0]; ln[hitAxis] = hitSign;
      const normal = [ln[0] * cosY + ln[2] * sinY, ln[1], -ln[0] * sinY + ln[2] * cosY];
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

export function createBuildingMagazineState(building) {
  if (!building) return null;
  if (building.magazine && Number.isFinite(building.magazine.initialPowderKg)) {
    if (building.damageState) building.damageState.magazine = building.magazine;
    return building.magazine;
  }
  const prefabId = building.prefabId ?? '';
  const isFortress = prefabId === 'bastion_trace_fortress';
  const isBastion = prefabId === 'stone_sea_bastion';
  const isArsenal = prefabId === 'royal_atarazanas_arsenal';
  const isArmedPier = Boolean(building.armed || building.hasMagazine);
  const barrelMassKg = 40.8;
  const barrelsTotal = isFortress
    ? 280
    : isBastion
      ? 120
      : isArsenal
        ? 80
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
    ? 25000000
    : materialClass === 'fortified-stone'
      ? 14000000
      : materialClass === 'timber'
        ? 2500000
        : 8500000;
  const defaultOuterPenJoules = materialClass === 'fortified-stone'
    ? 420000
    : materialClass === 'masonry'
      ? 165000
      : 38000;
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

  const dismountAdd = Math.max(1, Math.round(2 + 6 * powderFrac));
  d.dismountedGuns = (d.dismountedGuns ?? 0) + dismountAdd;
  const guns = building.gunnery?.state?.guns ?? building.gunnery?.guns;
  if (Array.isArray(guns)) {
    let left = dismountAdd;
    for (const g of guns) {
      if (left <= 0) break;
      if (!g.dismounted) {
        g.dismounted = true;
        g.loading = false;
        g.queued = false;
        left--;
      }
    }
  }

  d.pendingBakes.push({
    kind: 'building-explosion',
    x: +worldBlastPt[0].toFixed(3),
    y: +worldBlastPt[1].toFixed(3),
    z: +worldBlastPt[2].toFixed(3),
    radius: +(Math.max(4.5, Math.min(building.width ?? 16, building.depth ?? 16) * (0.45 + 0.35 * powderFrac))).toFixed(3),
    stepDepth: +(0.85 + 1.45 * powderFrac).toFixed(3),
    severity: +(1.0 + 0.48 * powderFrac).toFixed(3),
    powderFraction: +powderFrac.toFixed(3),
  });

  const numFires = Math.min(6, Math.max(2, Math.round(2 + 4 * powderFrac)));
  for (let i = 0; i < numFires; i++) {
    if (d.fires.length >= 10) d.fires.shift();
    const flx = ((i % 2 === 0 ? 1 : -1) * (building.width ?? 14) * 0.22);
    const fly = Math.max(1.2, (building.height ?? 5) * 0.65);
    const flz = ((i - (numFires - 1) * 0.5) * (building.depth ?? 14) * 0.16);
    const fWorld = buildingLocalToWorld(building, [flx, fly, flz]);
    d.fires.push({
      localPosition: [flx, fly, flz],
      intensity: +(1.05 + 0.45 * powderFrac).toFixed(3),
      age: 0,
      seed: ((d.hits * 0.618 + i * 0.27) % 1) || 0.43,
    });
    d.worldFires.push({
      position: fWorld,
      intensity: +(1.05 + 0.45 * powderFrac).toFixed(3),
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
  const d = createBuildingDamageState(building);
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

  d.hits++;
  d.damageJoules += effectiveEnergy;
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

  // Check if the shot struck a shore-battery embrasure cannon and dismounted it.
  const bGuns = building.gunnery?.state?.guns ?? building.gunnery?.guns;
  let dismountedNow = false;
  if (Array.isArray(bGuns) && bGuns.length > 0) {
    for (const g of bGuns) {
      if (g.dismounted) continue;
      const distLocal = Math.hypot(
        (g.localPosition?.[0] ?? 0) - (localPos[0] ?? 0),
        (g.localPosition?.[1] ?? 0) - (localPos[1] ?? 0),
        (g.localPosition?.[2] ?? 0) - (localPos[2] ?? 0),
      );
      if (distLocal < 1.85 || (isEmbrasure && distLocal < 3.2)) {
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
          radius: 1.25,
          stepDepth: 0.45,
          severity: 1.05,
        });
        break;
      }
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
      radius: 1.25,
      stepDepth: 0.45,
      severity: 1.05,
    });
  }

  // Hot shot fire ignition:
  // - Timber buildings (piers, careening sheds, watchtowers) ignite rapidly with high intensity.
  // - Masonry buildings ignite roof rafters and interior timber floors.
  // - Fortified stone resists exterior fire unless the hot shot penetrates an embrasure/breach or strikes the parapet/polvorín.
  if (ammo === 'hot') {
    const canIgniteStone =
      materialClass !== 'fortified-stone' ||
      penetratedOuter ||
      isEmbrasure ||
      dismountedNow ||
      hitPartId?.includes('polvorin') ||
      hitPartId?.includes('citadel') ||
      (localPos[1] ?? 0) >= (building.height ?? 5) * 0.62;
    if (canIgniteStone) {
      d.fireCount = (d.fireCount ?? 0) + 1;
      const baseIgnite = materialClass === 'timber' ? 0.68 : materialClass === 'masonry' ? 0.42 : 0.34;
      const addIntensity = Math.min(1.45, baseIgnite + energy / (materialClass === 'timber' ? 420000 : 680000));
      let merged = false;
      for (const f of d.fires) {
        const dist = Math.hypot(
          (f.localPosition[0] ?? 0) - (localPos[0] ?? 0),
          (f.localPosition[1] ?? 0) - (localPos[1] ?? 0),
          (f.localPosition[2] ?? 0) - (localPos[2] ?? 0),
        );
        if (dist < 4.0) {
          f.intensity = Math.min(1.65, +(f.intensity + addIntensity * 0.7).toFixed(3));
          merged = true;
          break;
        }
      }
      if (!merged && d.fires.length < 10) {
        d.fires.push({
          localPosition: [...localPos],
          intensity: +addIntensity.toFixed(3),
          age: 0,
          seed: ((d.hits * 0.6180339) % 1) || 0.39,
        });
      }
      d.worldFires = d.fires.map((f) => ({
        position: buildingLocalToWorld(building, f.localPosition),
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
      (hitPartId?.includes('citadel') && penetratedOuter);
    const hl = (building.depth ?? building.length ?? 18) * 0.5;
    const nearPolvorinVault =
      penetratedOuter &&
      Math.abs(localPos[0] ?? 0) <= (building.width ?? 16) * 0.24 &&
      Math.abs((localPos[2] ?? 0) - hl * 0.32) <= Math.max(2.6, hl * 0.28);
    if ((isPolvorinPart || nearPolvorinVault) && (penetratedOuter || ammo === 'hot' || event.hitZone === 'magazine')) {
      detonateBuildingMagazine(building, {
        localPos,
        cause: ammo === 'hot' ? 'hot-shot' : 'shot',
      });
    }
  }

  d.revision = (d.revision ?? 0) + 1;
  const report = {
    kind: 'building',
    buildingId: building.id,
    buildingName: building.label ?? building.prefabId,
    prefabId: building.prefabId,
    materialClass,
    ammo,
    hitPartId,
    hitSubAssembly,
    partDamage: d.partDamage[hitPartId] ?? nextPartDamage,
    penetratedOuter,
    breaches: d.breaches ?? 0,
    throughBreaches: d.throughBreaches ?? 0,
    dismountedGuns: d.dismountedGuns ?? 0,
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
      position: buildingLocalToWorld(building, f.localPosition),
      intensity: f.intensity,
      age: f.age,
      seed: f.seed,
    });
  }
  d.integrity = Math.max(0, 1 - d.damageJoules / d.maxEnergy);
  d.state = d.integrity > 0.75 ? 'intact' : d.integrity > 0.4 ? 'damaged' : d.integrity > 0.1 ? 'breached' : 'ruined';
  d.fireIntensity = +totalIntensity.toFixed(3);

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

  if (prefabId === 'bastion_trace_fortress') {
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
  } else if (building.armed && (prefabId === 'stone_quay_seawall' || prefabId === 'timber_mole_pier')) {
    addEmbrasureGun('port', -1, -hw * 0.35, yTop + 0.35, -hl, [0, 0, -1], 12);
    addEmbrasureGun('starboard', 1, hw * 0.35, yTop + 0.35, hl, [0, 0, 1], 12);
  }
  return guns;
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

export function createBuildingGunnery(building, { onEvent = () => {}, getVessels = () => [], getTerrain = () => null, sweep = null } = {}) {
  const defs = createBuildingGunDefinitions(building);
  const state = createGunneryState(defs);
  building.gunnery = state;
  createBuildingDamageState(building);
  const solidSweep = sweep ?? createGunnerySolidSweep({ sourceBoat: null, getVessels, getTerrain });
  const damageLog = [];
  let lastDamageReport = null;

  const hasPowder = () => !building.magazine || (!building.magazine.exploded && building.magazine.powderKg > 0);
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
      const side = localTz <= 0 ? 'port' : 'starboard';

      // Ballistic elevation solution for shore battery firing down/out at an offshore vessel.
      const muzzleY = (building.baseY ?? building.y ?? 0) + (building.height ?? 6) + 0.25;
      const targetY = (targetBoat.heave ?? 0) + 1.1;
      const dy = targetY - muzzleY;
      const v0 = 435; // 24-pdr / 32-pdr muzzle velocity (m/s)
      const gravDropDeg = (0.5 * Math.asin(Math.max(-0.95, Math.min(0.95, (9.81 * distH) / (v0 * v0)))) * 180) / Math.PI;
      const directAngleDeg = (Math.atan2(dy, distH) * 180) / Math.PI;
      const aimElevDeg = Math.max(-8, Math.min(16, directAngleDeg + gravDropDeg * 1.08));

      for (const g of state.guns) {
        if (g.side === side && !g.dismounted) {
          g.aimDirectionLocal = [...localDir];
          g.elevation = aimElevDeg;
          g.stage = 'ready';
          g.loading = false;
          g.progress = 1;
          g.offset = 0;
          g.queued = false;
        }
      }
      return fireGunnery(state, side, { interval: 0.10, ammo: state.ammo });
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
        canFire: (gun) => !gun.dismounted && hasPowder(),
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

export function createPortGunnery(port, { onEvent = () => {}, getVessels = () => [], getTerrain = () => null, autoReturnFire = true, returnFireRange = 420 } = {}) {
  const batteries = [];
  const instances = port?.instances ?? [];
  for (const inst of instances) {
    createBuildingDamageState(inst);
    const defs = createBuildingGunDefinitions(inst);
    if (defs.length > 0) {
      batteries.push(createBuildingGunnery(inst, { onEvent, getVessels, getTerrain }));
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
        const portAttacked = instances.some((inst) => (inst.damageState?.hits ?? 0) > 0);
        cooldown -= dt;
        if (cooldown <= 0 && portAttacked) {
          const vessels = getVessels() ?? [];
          let nearestBoat = null;
          let nearestDist = Infinity;
          for (const entry of vessels) {
            const boat = entry?.boat ?? entry;
            if (!boat || boat.damage?.sunk) continue;
            for (const b of batteries) {
              const d = Math.hypot((boat.x ?? 0) - (b.building.x ?? 0), (boat.z ?? 0) - (b.building.z ?? 0));
              if (d < nearestDist) {
                nearestDist = d;
                nearestBoat = boat;
              }
            }
          }
          if (nearestBoat && nearestDist <= returnFireRange) {
            for (const b of batteries) b.fireAtTarget(nearestBoat);
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

export function sweepScenerySegment(from, to, radius = 0.08, terrain, options = null) {
  if (!terrain) return null;
  const midX = (from[0] + to[0]) * 0.5;
  const midZ = (from[2] + to[2]) * 0.5;
  const segHalf = Math.hypot(to[0] - from[0], to[1] - from[1], to[2] - from[2]) * 0.5;
  const segMinY = Math.min(from[1], to[1]);
  const segMaxY = Math.max(from[1], to[1]);
  let best = null;

  const ports = terrain.ports ?? (terrain.port ? [terrain.port] : null);
  if (ports) {
    for (const port of ports) {
      const palms = port?.palms;
      if (!palms) continue;
      if (palms instanceof Float32Array && palms.length >= 8) {
        const portAnchorX = port.center?.x ?? port.berth?.x ?? palms[0] ?? 0;
        const portAnchorZ = port.center?.z ?? port.berth?.z ?? palms[2] ?? 0;
        if (Math.hypot(midX - portAnchorX, midZ - portAnchorZ) > 1800 + segHalf) continue;
        const maxPalms = Math.min(palms.length / 8, 520);
        for (let idx = 0; idx < maxPalms; idx++) {
          if ((port.damagedPalms?.[idx] ?? 0) >= 3) continue;
          const base = idx * 8;
          const px = palms[base], py = palms[base + 1], pz = palms[base + 2];
          const plumeR = Math.max(2.2, palms[base + 3] || 3.2);
          const ht = Math.max(5.5, palms[base + 4] || 9.0);
          if (segMaxY < py - 0.5 - radius || segMinY > py + ht + 2.5 + radius) continue;
          const pdx = midX - px, pdz = midZ - pz;
          const maxR = plumeR + 2.5 + radius + segHalf;
          if (pdx * pdx + pdz * pdz > maxR * maxR) continue;
          const tTrunk = intersectVerticalCylinder(from, to, px, pz, py - 0.4, py + ht * 0.85, 1.35 + radius);
          const tCrown = intersectVerticalCylinder(from, to, px, pz, py + ht * 0.65, py + ht + 2.2, plumeR + radius);
          let tHit = -1;
          if (tTrunk >= 0 && tCrown >= 0) tHit = Math.min(tTrunk, tCrown);
          else if (tTrunk >= 0) tHit = tTrunk;
          else if (tCrown >= 0) tHit = tCrown;
          if (tHit >= 0 && (!best || tHit < best.fraction)) {
            const hx = from[0] + (to[0] - from[0]) * tHit;
            const hz = from[2] + (to[2] - from[2]) * tHit;
            const nx = hx - px, nz = hz - pz;
            const nLen = Math.hypot(nx, 0.35, nz) || 1;
            best = {
              fraction: tHit,
              kind: 'scenery',
              sceneryType: 'palm',
              port,
              palmIndex: idx,
              sceneryPos: [px, py, pz],
              normal: [nx / nLen, 0.35 / nLen, nz / nLen],
            };
          }
        }
      } else if (Array.isArray(palms) && palms.length) {
        const portAnchorX = port.center?.x ?? port.berth?.x ?? palms[0].x ?? 0;
        const portAnchorZ = port.center?.z ?? port.berth?.z ?? palms[0].z ?? 0;
        if (Math.hypot(midX - portAnchorX, midZ - portAnchorZ) > 1800 + segHalf) continue;
        for (let i = 0; i < palms.length; i++) {
          const palm = palms[i];
          if (!palm || (palm.damaged ?? 0) >= 3) continue;
          const s = palm.scale ?? 1;
          const py = palm.y ?? 0;
          if (segMaxY < py - 0.5 - radius || segMinY > py + 10.5 * s + radius) continue;
          const pdx = midX - palm.x, pdz = midZ - palm.z;
          const maxR = 3.5 * s + radius + segHalf;
          if (pdx * pdx + pdz * pdz > maxR * maxR) continue;
          const tTrunk = intersectVerticalCylinder(from, to, palm.x, palm.z, py - 0.4, py + 7.4 * s, 1.15 * s + radius);
          const tCrown = intersectVerticalCylinder(from, to, palm.x, palm.z, py + 5.6 * s, py + 10.2 * s, 3.1 * s + radius);
          let tHit = -1;
          if (tTrunk >= 0 && tCrown >= 0) tHit = Math.min(tTrunk, tCrown);
          else if (tTrunk >= 0) tHit = tTrunk;
          else if (tCrown >= 0) tHit = tCrown;
          if (tHit >= 0 && (!best || tHit < best.fraction)) {
            const hx = from[0] + (to[0] - from[0]) * tHit;
            const hz = from[2] + (to[2] - from[2]) * tHit;
            const nx = hx - palm.x, nz = hz - palm.z;
            const nLen = Math.hypot(nx, 0.35, nz) || 1;
            best = {
              fraction: tHit,
              kind: 'scenery',
              sceneryType: 'palm',
              port,
              palmIndex: i,
              sceneryPos: [palm.x, py, palm.z],
              normal: [nx / nLen, 0.35 / nLen, nz / nLen],
            };
          }
        }
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
  if (event.port) {
    event.port.sceneryBakes ??= [];
    event.port.sceneryBakes.push(bake);
    if (Number.isInteger(event.palmIndex)) {
      event.port.damagedPalms ??= {};
      event.port.damagedPalms[event.palmIndex] = (event.port.damagedPalms[event.palmIndex] ?? 0) + 1;
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
  return {
    kind: 'scenery',
    sceneryType: record.sceneryType,
    hitCount: terrain.sceneryImpacts.length,
    craterRadius,
    energyKj: record.energyKj,
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
  const craterRadius = +(0.35 * Math.cbrt(mass / 5.4) * Math.max(0.7, Math.cbrt(energy / 120000))).toFixed(2);
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

  terrain.pendingLandBakes ??= [];
  terrain.pendingLandBakes.push({
    kind: 'terrain-crater',
    x: +pos[0].toFixed(3),
    y: +pos[1].toFixed(3),
    z: +pos[2].toFixed(3),
    nx: +(normal[0] ?? 0).toFixed(3),
    ny: +(normal[1] ?? 1).toFixed(3),
    nz: +(normal[2] ?? 0).toFixed(3),
    radius: +(Math.max(2.5, craterRadius * 3.5)).toFixed(3),
    stepDepth: +(Math.min(0.85, Math.max(0.25, craterRadius * 0.65))).toFixed(3),
    severity: +(Math.min(1.35, Math.max(0.45, craterRadius * 0.95))).toFixed(3),
  });

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
  };
}

export function createGunnerySolidSweep({ sourceBoat, getVessels = () => [], getTerrain = () => null } = {}) {
  return function sweep(from, to, projectile) {
    const radius = projectile?.sweepRadius ?? projectile?.radius ?? 0.08;
    const previewOnly = projectile?.previewOnly === true;
    const opts = previewOnly ? { previewOnly: true } : null;
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
    return best;
  };
}

export function resolveSolidGunneryImpact(event, { getTerrain = () => null } = {}) {
  if (!event || event.type !== 'impact') return null;
  if (event.kind === 'ship' && event.targetBoat) {
    return applyShipImpactDamage(event.targetBoat, event);
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
export function createShipGunnery(boat,{onEvent=()=>{},onOrder=()=>{},muzzleBlock=()=>null,getVessels=()=>[],getTerrain=()=>null,sweep=null,deferSeaCollision=true,waterHeight=0}={}){
  const state=createGunneryState(createNavalBattleGunDefinitions(boat));boat.gunnery=state;
  createVesselDamageState(boat);
  const previousStages=new Array(state.guns.length);
  const solidSweep=sweep??createGunnerySolidSweep({sourceBoat:boat,getVessels,getTerrain});
  const damageLog=[];
  let pending=null,prepared=false,lastReady=false,flash=null,lastDamageReport=null,fireAtWillMode=false,showTrajectoryMode=true,lastAimSummary=null;
  let cachedAimArcs=null,cachedAimTime=-1,cachedAimSide=null,cachedAimAmmo=null,cachedAimElev=NaN,cachedAimTrav=NaN,cachedAimQuoin=NaN,cachedAimX=NaN,cachedAimZ=NaN,cachedAimHeading=NaN,cachedAimRoll=NaN;
  const attended=gun=>!gun.visibleCrew||boat.gunneryAttendance?.has(gun.id)===true;
  const sideValid=side=>side==='port'||side==='starboard';
  const hasPowder=()=>!boat.magazine||(!boat.magazine.exploded&&boat.magazine.powderKg>0);
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
    const speedMul=ammo==='hot'?.88:ammo==='chain'?.82:ammo==='grape'?.85:1;
    const dragMul=ammo==='chain'?1.62:ammo==='grape'?1.18:1;
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
        :(hitInfo.kind==='terrain'||hitInfo.kind==='building')
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
  const canFire=side=>{
    if(!sideValid(side)||boat.gunnerySide!==side||pending||state.queue.length||!hasPowder())return false;
    let count=0;
    for(const g of state.guns){
      if(g.side!==side)continue;
      count++;
      if(g.stage!=='ready'||!attended(g)||muzzleBlock(g,gunMuzzlePose(g,boat)))return false;
    }
    return count>0;
  };
  const canFireLoaded=side=>{
    if(!sideValid(side)||boat.gunnerySide!==side||pending||state.queue.length||!hasPowder())return false;
    for(const g of state.guns){
      if(g.side===side&&g.stage==='ready'&&!g.queued&&attended(g)&&!muzzleBlock(g,gunMuzzlePose(g,boat)))return true;
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
      at:state.time+GUNNERY_ORDER_SECONDS[order],
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
    get magazine(){return boat.magazine;},
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
      if(!sideValid(side))return false;
      if(pending||state.queue.length||state.guns.some(g=>g.loading&&g.side!==side))return false;
      const changed=boat.gunnerySide!==side;
      boat.gunnerySide=side;prepared=true;lastReady=false;
      const count=prepareGunnery(state,side);if(count||changed)onOrder('prepare',boat);
      return count>0||changed;
    },
    readyAtQuarters(side){
      if(!sideValid(side))return false;
      pending=null;state.queue.length=0;
      boat.gunnerySide=side;prepared=true;lastReady=true;
      for(const g of state.guns)if(g.side===side){
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
          if(pending.stage==='steady'){
            let readyCount=0,clearCount=0,allReadyClear=true;
            for(const g of state.guns){
              if(g.side!==pending.side||g.stage!=='ready')continue;
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
            const portsClear=pending.allowPartial?clearCount>0:(readyCount>0&&allReadyClear);
            pending.prevError=ePred;
            if(isFlatCalm||(portsClear&&(((crossedZero||withinWindow)&&goodRollDirection)||waitTime>=5.2))){
              onEvent({
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
      const events=stepGunnery(state,dt,{deferSeaCollision,waterHeight,
        windVelocity:wind,muzzle:gun=>gunMuzzlePose(gun,boat),
        sweep:solidSweep,
        gunAttended:attended,canFire:(gun,pose)=>attended(gun)&&!muzzleBlock(gun,pose),
        onEvent:event=>{
          if(event.type==='shot'){consumeMagazineOrdnance(boat,event);recoil(event);flash={gunId:event.gunId,side:event.gun.sideSign,time:event.time,mass:event.mass};}
          if(event.type==='impact'&&event.kind!=='water'){
            const report=resolveSolidGunneryImpact(event,{getTerrain});
            if(report){event.damageReport=report;lastDamageReport=report;if(damageLog.length>=32)damageLog.shift();damageLog.push(report);}
          }
          if(event.type!=='ready')onEvent(event);
        },
      });
      for(const gun of state.guns)if(previousStages[gun.index]!==gun.stage&&(gun.stage==='ram'||gun.stage==='runout')){
        onEvent({type:gun.stage==='ram'?'load':'run-out',gun,position:gunMuzzlePose(gun,boat).position});
      }
      const s=gunnerySummary(state,boat.gunnerySide);
      let allAttended=true;
      if(prepared&&s.total>0&&s.ready===s.total){
        for(const g of state.guns)if(g.side===boat.gunnerySide&&!attended(g)){allAttended=false;break;}
      }else allAttended=false;
      const ready=prepared&&s.total>0&&s.ready===s.total&&allAttended;
      if(ready&&!lastReady)onEvent({type:'ready',position:[boat.x,boat.heave+3,boat.z]});
      lastReady=ready;return events;
    },
    impact(contact){return resolveGunneryImpact(state,contact.shotId??contact.id,contact);},
    summary(side){return gunnerySummary(state,side);},
    canFire,
    canFireLoaded,
    blockedReason(side){
      if(side!==boat.gunnerySide)return null;
      if(boat.magazine?.exploded)return 'Magazine exploded';
      if(boat.magazine&&boat.magazine.powderKg<=0)return 'Powder exhausted';
      for(const gun of state.guns){
        if(gun.side!==side)continue;
        if(!attended(gun))return 'Manning guns';
        const reason=muzzleBlock(gun,gunMuzzlePose(gun,boat));if(reason)return reason;
      }return null;
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
      const next=GUNNERY_AMMO_TYPES.includes(type)?type:'round';
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
    get isSwivelBattery(){return state.guns[0]?.kind==='swivel';},
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
        const loc=vesselWorldToLocal(boat,[tb.x??0,(tb.heave??0)+2.2,tb.z??0]);
        if(loc[0]*sideSign<=0.5)continue;
        const d=Math.hypot(loc[0],loc[2]);
        if(d<bestDist){bestDist=d;bestLocal=loc;}
      }
      const terrain=getTerrain();
      const ports=terrain?.ports??(terrain?.port?[terrain.port]:[]);
      for(const port of ports){
        for(const inst of (port?.instances??[])){
          const loc=vesselWorldToLocal(boat,[inst.x??0,(inst.baseY??0)+3.0,inst.z??0]);
          if(loc[0]*sideSign<=1.0)continue;
          const d=Math.hypot(loc[0],loc[2]);
          if(d<bestDist){bestDist=d;bestLocal=loc;}
        }
      }
      if(!bestLocal)return null;
      // Positive traverse trains toward the bow (-Z in local ship coords)
      const rawTravDeg=Math.atan2(-bestLocal[2],Math.abs(bestLocal[0]))*180/Math.PI;
      const clampedTrav=+(Math.max(tRange.min,Math.min(tRange.max,rawTravDeg))).toFixed(1);
      const gunSpeed=state.guns[0]?.muzzleSpeed??380;
      const grav=state.gravity??9.81;
      const ballisticDeg=Math.max(0,(0.5*grav*bestDist/(gunSpeed*gunSpeed))*180/Math.PI*1.12);
      const heightDeg=Math.atan2(bestLocal[1]-1.6,bestDist)*180/Math.PI;
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
        damage.pendingBakes.push({
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

export function applyGroundingImpactDamage(boat, contact, options = {}) {
  if (!boat || !contact) return null;
  const subInfo = contact.substrateInfo ?? GROUNDING_SUBSTRATES[contact.substrate] ?? GROUNDING_SUBSTRATES.shoal;
  const impactSpeed = Math.max(0, Number.isFinite(contact.impactSpeed) ? contact.impactSpeed : 0);
  if (impactSpeed <= subInfo.safeTouchSpeed) return null;

  const damage = createVesselDamageState(boat);
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
  const hullEnergy = baseEnergy * subInfo.damageMultiplier;

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
        damage.pendingBakes.push({
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

// ============================================================================
// WATERWORLD — Ship Boarding, Crew Melee Combat, Pier Docking & Mooring Lines
//
// Implements:
//   1. Boarding a surrendered vessel to take her as a prize without bloodshed,
//      or boarding an active vessel so the crews fight each other along the
//      bulwarks and gangplanks until one side wins based on morale and
//      strength (with women explicitly just as strong as men: 1.0 = 1.0).
//   2. Pier docking & ship-to-ship mooring line sequences: throwing bow, stern,
//      and spring lines onto piers or adjacent vessels, making fast, holding
//      station with spring-damped mooring physics, and casting off.
//   3. 3D world-space catenary hemp line & oak gangplank geometry builder for
//      the ship-colors WebGPU renderer (modes 4 and 5).
// ============================================================================

import { modelDeck, modelDeckWidth, vesselHull } from './hull.js';
import { applyPirateCrewAttire } from './crew.js';
import { resolveIndigenousCultureRegion } from './coastal-world.js';
import {
  applyIndigenousSupportAction,
  getActiveIndigenousSovereigntyState,
} from './indigenous-sovereignty.js';

export const FEMALE_BOARDING_STRENGTH = 1.0;
export const MALE_BOARDING_STRENGTH = 1.0;

function bdClamp(x, a, b) {
  return x < a ? a : x > b ? b : x;
}

// Basis vectors matching Waterworld's world coordinate convention (js/vessels.js & js/boat.js):
// heading = 0 -> North (-Z), heading = 90 -> East (+X).
// Forward (bow): (+sin(h), -cos(h))
// Right (starboard): (+cos(h), +sin(h))
function boatBasis(boat) {
  const h = ((boat?.heading ?? 0) * Math.PI) / 180;
  const ch = Math.cos(h), sh = Math.sin(h);
  return {
    h,
    ch,
    sh,
    fwdX: sh,
    fwdZ: -ch,
    rightX: ch,
    rightZ: sh,
  };
}

function boatWorldPoint(boat, lx, ly, lz) {
  const hull = vesselHull(boat);
  const f = hull.frame;
  const sx = (boat.beam ?? f.beam) / f.beam;
  const sy = f.verticalScale ?? 1;
  const sz = (boat.length ?? f.length) / f.length;
  const { rightX, rightZ, fwdX, fwdZ } = boatBasis(boat);
  const x = lx * sx;
  const y = ly * sy;
  const z = lz * sz;
  return [
    (boat.x ?? 0) + x * rightX + z * fwdX,
    (boat.heave ?? 0) + y,
    (boat.z ?? 0) + x * rightZ + z * fwdZ,
  ];
}

// Compute crew boarding combat power from individual crew strength & battle morale.
// Women and men have identical per-sailor physical strength (1.0).
export function computeBoardingStrength(vesselOrBoat, companyArg = null) {
  const boat = vesselOrBoat?.boat ?? vesselOrBoat ?? {};
  const company = companyArg ?? vesselOrBoat?.crew?.state ?? vesselOrBoat?.company ?? boat?.company ?? null;
  const sailors = company?.crew ?? company?.sailors ?? [];
  const dmg = boat.damage ?? null;
  const cas = dmg?.crewCasualties ?? dmg?.crew ?? null;

  let able = 0;
  let wounded = 0;
  let incapacitated = 0;
  let femaleHands = 0;
  let maleHands = 0;
  let totalStrength = 0;

  if (sailors.length > 0) {
    for (const s of sailors) {
      // Women are just as strong as men (both 1.0)
      const indivStrength = (s.sex === 'female' ? FEMALE_BOARDING_STRENGTH : MALE_BOARDING_STRENGTH) * (s.strength ?? 1.0);
      if (s.sex === 'female') femaleHands++;
      else maleHands++;

      const health = s.health ?? 1.0;
      const fallen = s.casualtyState === 'fallen' || s.wounded === 'incapacitated' || health <= 0.15;
      const hurt = !fallen && (s.casualtyState === 'wounded' || s.wounded === 'wounded' || health < 0.72);
      if (fallen) {
        incapacitated++;
      } else if (hurt) {
        wounded++;
        totalStrength += indivStrength * 0.48;
      } else {
        able++;
        totalStrength += indivStrength;
      }
    }
  } else if (cas) {
    able = Math.max(0, cas.able ?? 10);
    wounded = Math.max(0, cas.wounded ?? 0);
    incapacitated = Math.max(0, cas.killed ?? cas.incapacitated ?? 0);
    femaleHands = Math.floor((able + wounded) / 2);
    maleHands = (able + wounded) - femaleHands;
    totalStrength = able * 1.0 + wounded * 0.48;
  } else {
    able = 12;
    femaleHands = 6;
    maleHands = 6;
    totalStrength = 12.0;
  }

  const morale = bdClamp(
    dmg?.battleMorale ?? cas?.battleMorale ?? company?.morale ?? 0.9,
    0.05,
    1.0,
  );
  // Morale strongly multiplies combat effectiveness in boarding actions
  const moraleMultiplier = 0.30 + 0.70 * morale;
  const effectiveStrength = totalStrength * moraleMultiplier;

  return {
    able,
    wounded,
    incapacitated,
    total: able + wounded + incapacitated,
    femaleHands,
    maleHands,
    meanFemaleStrength: FEMALE_BOARDING_STRENGTH,
    meanMaleStrength: MALE_BOARDING_STRENGTH,
    baseStrength: totalStrength,
    morale,
    moraleMultiplier,
    effectiveStrength,
  };
}

function getVesselCompany(v) {
  return v?.crew?.state ?? v?.company ?? v?.boat?.company ?? null;
}

function assignCrewToRailAction(company, boat, kind, side = 'starboard') {
  const sailors = company?.crew ?? company?.sailors;
  if (!sailors || !boat) return;
  const sideSign = side === 'port' ? -1 : 1;
  const zSlots = [-2.2, -1.1, 0.0, 1.1, 2.2, -1.65, 0.55, 1.65];
  let idx = 0;
  for (const s of sailors) {
    if (s.id === 'ines' || s.role === 'helmsman' || s.role === 'Helmsman') continue;
    if (s.casualtyState === 'fallen' || s.wounded === 'incapacitated') continue;
    s.home ??= [s.x ?? 0, s.z ?? 0];
    const z = bdClamp(zSlots[idx % zSlots.length], -3.0, 3.0);
    const hb = Math.max(0.55, modelDeckWidth(boat, z) - 0.24);
    const x = sideSign * hb;
    const y = modelDeck(boat, z);
    s.x = x;
    s.z = z;
    s.intent = 'work';
    s.job = {
      kind,
      stage: 'working',
      side,
      sideSign,
      position: [x, y, z],
      targetX: x,
      targetZ: z,
      workX: x,
      workZ: z,
      elapsed: 0,
      rung: 0,
      timer: 12.0,
      hold: 12.0,
    };
    idx++;
  }
}

function releaseCrewRailAction(company, boat) {
  if (boat) {
    boat.boardingActive = false;
    boat.mooringActive = false;
  }
  const sailors = company?.crew ?? company?.sailors;
  if (!sailors) return;
  for (const s of sailors) {
    if (s.job && (s.job.kind === 'boarding' || s.job.kind === 'mooring')) {
      s.job = null;
      if (Array.isArray(s.home)) {
        s.x = s.home[0];
        s.z = s.home[1];
      }
    }
  }
}

// Find the closest pier / harbor jetty in the terrain port instances, or
// synthesize a stone/timber quay alongside the ship when near land/harbor.
export function findNearestPier(boat, env = {}) {
  const bx = boat?.x ?? 0;
  const bz = boat?.z ?? 0;
  const instances = env?.portInstances ?? env?.terrain?.port?.instances ?? [];
  let bestPier = null;
  let bestDist = Infinity;

  if (Array.isArray(instances)) {
    for (const inst of instances) {
      if (!inst) continue;
      const isPier = inst.assetId === 'harbor_jetty_and_crane' ||
        /jetty|pier|wharf|dock|quay/i.test(inst.assetId ?? '');
      if (!isPier && bestPier) continue;
      const dx = (inst.x ?? 0) - bx;
      const dz = (inst.z ?? 0) - bz;
      const d = Math.hypot(dx, dz);
      const effectiveD = isPier ? d : d + 120;
      if (effectiveD < bestDist) {
        bestDist = d;
        const rot = inst.rotY ?? 0;
        bestPier = {
          kind: 'pier',
          label: isPier ? 'Harbor Timber Pier & Crane' : 'Harbor Quay',
          x: inst.x ?? 0,
          y: Math.max(1.25, (inst.y ?? 0) + 1.35),
          z: inst.z ?? 0,
          heading: (rot * 180 / Math.PI) % 360,
          distance: d,
        };
      }
    }
  }

  if (bestPier && bestPier.distance <= 36) {
    // Clamp effective bollard line-of-action to a clean lateral warping range (<= 9.5 m)
    // so hauling never drags the vessel across shoals or far-off shore geometry.
    const { rightX, rightZ } = boatBasis(boat);
    const dx = bestPier.x - bx;
    const dz = bestPier.z - bz;
    const sideSign = (dx * rightX + dz * rightZ) >= 0 ? 1 : -1;
    const side = sideSign >= 0 ? 'starboard' : 'port';
    const halfBeam = Math.max(2.0, (boat?.beam ?? 4.8) * 0.5);
    const clampedDist = bdClamp(bestPier.distance, halfBeam + 3.2, halfBeam + 7.5);
    return {
      ...bestPier,
      x: bx + rightX * sideSign * clampedDist,
      z: bz + rightZ * sideSign * clampedDist,
      distance: clampedDist,
      side,
    };
  }

  // Fallback: create a berth alongside the ship's port beam at a smooth warping distance
  const { rightX, rightZ } = boatBasis(boat);
  const halfBeam = Math.max(2.0, (boat?.beam ?? 4.8) * 0.5);
  const pierOffset = halfBeam + 5.2;
  return {
    kind: 'pier',
    label: env?.portLabel || 'Harbor Landing Pier',
    x: bx - rightX * pierOffset,
    y: 1.35,
    z: bz - rightZ * pierOffset,
    heading: boat?.heading ?? 0,
    distance: pierOffset,
    side: 'port',
  };
}

function buildLineDescriptorsForPier(boat, pier, side = 'port') {
  const sideSign = side === 'port' ? -1 : 1;
  const { fwdX, fwdZ, rightX, rightZ } = boatBasis(boat);
  const pierSign = sideSign;
  const halfBeam = Math.max(1.8, (boat.beam ?? 3.6) * 0.5);
  const pierDist = halfBeam + 5.2;

  // 4 classic mooring lines: Bow line, Forward spring, Aft spring, Stern line
  const specs = [
    { name: 'Bow line', shipZ: 3.3, pierAlong: 4.4 },
    { name: 'Fore spring', shipZ: 1.6, pierAlong: -0.9 },
    { name: 'Aft spring', shipZ: -1.5, pierAlong: 1.1 },
    { name: 'Stern fast', shipZ: -3.4, pierAlong: -4.2 },
  ];

  const basePierX = pier?.x ?? ((boat.x ?? 0) + rightX * pierSign * pierDist);
  const basePierZ = pier?.z ?? ((boat.z ?? 0) + rightZ * pierSign * pierDist);
  const basePierY = pier?.y ?? 1.35;

  return specs.map((sp, i) => {
    const hb = Math.max(0.55, modelDeckWidth(boat, sp.shipZ) - 0.08);
    const deckY = modelDeck(boat, sp.shipZ) + 0.34;
    return {
      name: sp.name,
      index: i,
      shipLocal: [sideSign * hb, deckY, sp.shipZ],
      pierWorld: [
        basePierX + fwdX * sp.pierAlong,
        basePierY,
        basePierZ + fwdZ * sp.pierAlong,
      ],
    };
  });
}

function buildLineDescriptorsForShip(boat, targetBoat, side = 'starboard') {
  const sideSign = side === 'port' ? -1 : 1;
  // Determine which side of targetBoat faces our boat
  const { rightX: tRightX, rightZ: tRightZ } = boatBasis(targetBoat);
  const toPlayerX = (boat.x ?? 0) - (targetBoat.x ?? 0);
  const toPlayerZ = (boat.z ?? 0) - (targetBoat.z ?? 0);
  const targetSideSign = (toPlayerX * tRightX + toPlayerZ * tRightZ) >= 0 ? 1 : -1;

  const specs = [
    { name: 'Fore grappling hook', shipZ: 3.1, targetZ: 3.0 },
    { name: 'Forward spring line', shipZ: 1.2, targetZ: 1.1 },
    { name: 'Waist grappling hook', shipZ: -1.1, targetZ: -1.1 },
    { name: 'Quarter fast line', shipZ: -3.1, targetZ: -3.0 },
  ];

  return specs.map((sp, i) => {
    const hb1 = Math.max(0.55, modelDeckWidth(boat, sp.shipZ) - 0.06);
    const y1 = modelDeck(boat, sp.shipZ) + 0.38;
    const hb2 = Math.max(0.55, modelDeckWidth(targetBoat, sp.targetZ) - 0.06);
    const y2 = modelDeck(targetBoat, sp.targetZ) + 0.38;
    return {
      name: sp.name,
      index: i,
      shipLocal: [sideSign * hb1, y1, sp.shipZ],
      targetLocal: [targetSideSign * hb2, y2, sp.targetZ],
    };
  });
}

export function createDockingBoardingState(boat, options = {}) {
  const state = {
    boat,
    company: options.company ?? null,
    getAdditionalVessels: options.getAdditionalVessels ?? (() => []),
    onEvent: options.onEvent ?? null,

    // Docking / Mooring state
    // 'clear' | 'throwing-lines' | 'making-fast' | 'moored' | 'grappled' | 'casting-off'
    mooringPhase: 'clear',
    mooringTargetKind: null, // 'pier' | 'vessel'
    mooringSide: 'port',
    pier: null,
    berthX: null,
    berthZ: null,
    berthHeading: null,
    pierNormalX: 0,
    pierNormalZ: 0,
    lateralGap: 0,
    lateralSpeed: 0,
    haulVx: 0,
    haulVz: 0,
    terrain: null,
    targetVessel: null,
    lineProgress: 0,    // 0 = coiled aboard, 1 = landed on bollard/rail
    lineTension: 0,     // 0 = slack/flying, 1 = taut made fast
    gangplankProgress: 0, // 0 = stowed, 1 = bridged across bulwarks
    phaseTimer: 0,
    lines: [],

    // Boarding & Combat state
    // 'none' | 'approaching' | 'grappling' | 'capturing-surrendered' | 'boarding-melee' | 'captured' | 'repulsed'
    boardingPhase: 'none',
    boardingMode: null, // 'surrendered' | 'fight'
    boardingTimer: 0,
    combatRoundTimer: 0,
    combatRounds: 0,
    capturedVessels: [],
    lastOutcome: null,
    statusText: 'Lines coiled aboard · Clear of pier and vessels',
    combatLog: [],
  };

  function emit(type, detail = {}) {
    if (typeof state.onEvent === 'function') {
      state.onEvent({ type, state, ...detail });
    }
  }

  function determineSideToward(tx, tz) {
    const { rightX, rightZ } = boatBasis(boat);
    const dx = tx - (boat.x ?? 0);
    const dz = tz - (boat.z ?? 0);
    return (dx * rightX + dz * rightZ) >= 0 ? 'starboard' : 'port';
  }

  // Throw mooring lines onto a pier and make fast
  function dockAtPier(env = {}, { immediate = false } = {}) {
    const pier = findNearestPier(boat, env);
    const side = pier.side ?? determineSideToward(pier.x, pier.z);
    const sideSign = side === 'port' ? -1 : 1;
    const { rightX, rightZ } = boatBasis(boat);
    const halfBeam = Math.max(1.8, (boat.beam ?? 3.6) * 0.5);
    const fenderGap = halfBeam + 1.6;

    state.terrain = env?.terrain ?? state.terrain ?? null;
    state.pier = pier;
    state.pierNormalX = rightX * sideSign;
    state.pierNormalZ = rightZ * sideSign;
    state.lateralGap = Math.max(0.6, (pier.distance ?? (fenderGap + 3.6)) - fenderGap);
    state.lateralSpeed = 0;
    state.berthX = (boat.x ?? 0) + state.pierNormalX * state.lateralGap;
    state.berthZ = (boat.z ?? 0) + state.pierNormalZ * state.lateralGap;
    state.berthHeading = boat.heading ?? 0;
    state.haulVx = 0;
    state.haulVz = 0;
    state.targetVessel = null;
    state.mooringTargetKind = 'pier';
    state.mooringSide = side;
    state.boardingPhase = 'none';
    state.boardingMode = null;
    state.gangplankProgress = 0;
    state.lines = buildLineDescriptorsForPier(boat, pier, side);

    if (immediate) {
      state.mooringPhase = 'moored';
      state.lineProgress = 1.0;
      state.lineTension = 1.0;
      state.lateralGap = 0;
      state.phaseTimer = 0;
      boat.mooringActive = false;
      boat.mooringRestraint = 1.0;
      state.statusText = `Moored alongside ${pier.label} (${side} lines fast)`;
    } else {
      state.mooringPhase = 'throwing-lines';
      state.lineProgress = 0.05;
      state.lineTension = 0.0;
      state.phaseTimer = 0;
      boat.mooringActive = true;
      boat.mooringRestraint = 0.05;
      assignCrewToRailAction(state.company, boat, 'mooring', side);
      state.statusText = `Throwing bow & stern lines to ${pier.label} (${side} side)…`;
    }

    emit('dock-start', { pier, side, immediate });
    return { ok: true, pier, side, phase: state.mooringPhase };
  }

  // Throw grappling/mooring lines onto another ship
  function grappleShip(targetVessel, { mode = 'moor', pullAlongside = true } = {}) {
    if (!targetVessel?.boat) {
      return { ok: false, reason: 'No vessel in range to throw lines' };
    }
    const tb = targetVessel.boat;
    if (pullAlongside) {
      // If the vessel is far off, bring her within initial line-throwing distance (~desiredGap + 4.5 m)
      // so the subsequent making-fast phase smoothly hauls the hulls beam-to-beam without snapping.
      const { rightX, rightZ } = boatBasis(boat);
      const dx = (tb.x ?? 0) - (boat.x ?? 0);
      const dz = (tb.z ?? 0) - (boat.z ?? 0);
      const dist = Math.hypot(dx, dz);
      const sideSign = (dx * rightX + dz * rightZ) >= 0 ? 1 : -1;
      const desiredGap = Math.max(6.2, ((boat.beam ?? 4.8) + (tb.beam ?? 4.8)) * 0.68);
      if (dist > desiredGap + 6.0) {
        const stagingDist = desiredGap + 4.2;
        tb.x = (boat.x ?? 0) + rightX * sideSign * stagingDist;
        tb.z = (boat.z ?? 0) + rightZ * sideSign * stagingDist;
        tb.heading = boat.heading ?? 0;
        tb.surgeVelocity = (boat.surgeVelocity ?? 0) * 0.35;
        tb.leewayVelocity = 0;
      }
    }

    const side = determineSideToward(tb.x ?? 0, tb.z ?? 0);
    const sideSign = side === 'port' ? -1 : 1;
    const { rightX, rightZ } = boatBasis(boat);
    const curDist = Math.hypot((tb.x ?? 0) - (boat.x ?? 0), (tb.z ?? 0) - (boat.z ?? 0));
    const desiredGap = Math.max(5.8, ((boat.beam ?? 4.8) + (tb.beam ?? 4.8)) * 0.65);
    state.pier = null;
    state.berthX = null;
    state.berthZ = null;
    state.pierNormalX = rightX * sideSign;
    state.pierNormalZ = rightZ * sideSign;
    state.lateralGap = Math.max(0, curDist - desiredGap);
    state.lateralSpeed = 0;
    state.haulVx = 0;
    state.haulVz = 0;
    state.targetVessel = targetVessel;
    state.mooringTargetKind = 'vessel';
    state.mooringSide = side;
    state.mooringPhase = 'throwing-lines';
    state.lineProgress = 0.08;
    state.lineTension = 0.0;
    state.phaseTimer = 0;
    state.lines = buildLineDescriptorsForShip(boat, tb, side);

    boat.mooringActive = true;
    assignCrewToRailAction(state.company, boat, 'mooring', side);
    const targetComp = getVesselCompany(targetVessel);
    if (targetComp) {
      const oppSide = side === 'port' ? 'starboard' : 'port';
      assignCrewToRailAction(targetComp, tb, mode === 'board-fight' ? 'boarding' : 'mooring', oppSide);
    }

    state.statusText = `Throwing grappling lines across to ${tb.shipName || tb.name || 'vessel'} (${side} beam)…`;
    emit('grapple-start', { targetVessel, side, mode });
    return { ok: true, targetVessel, side };
  }

  // Complete capture of a vessel (either surrendered or defeated in boarding melee)
  function capturePrizeVessel(targetVessel, captureMethod = 'surrendered') {
    if (!targetVessel?.boat) return null;
    const tb = targetVessel.boat;
    tb.captured = true;
    tb.capturedBy = 'player';
    tb.captureMethod = captureMethod;
    tb.allyConsort = true;
    tb.disarmedPrize = false;
    if (tb.damage) {
      tb.damage.surrendered = false;
      tb.damage.surrenderReason = null;
      tb.damage.battleMorale = Math.max(0.78, tb.damage.battleMorale ?? 0.78);
      tb.damage.moraleState = 'steady';
      tb.damage.floodingRate = 0;
      tb.damage.floodingLevel = Math.min(0.15, tb.damage.floodingLevel ?? 0);
      if (tb.damage.crewCasualties) {
        tb.damage.crewCasualties.surrendered = false;
        tb.damage.crewCasualties.battleMorale = tb.damage.battleMorale;
      }
    }
    targetVessel.faction = 'friendly';
    targetVessel.isPirate = false;
    tb.faction = 'friendly';
    if (targetVessel.follower) {
      targetVessel.follower.faction = 'friendly';
      targetVessel.follower.encounterMode = null;
      targetVessel.follower.status = `Captured Prize (${tb.shipName || tb.name || 'Prize'})`;
    }
    targetVessel.gunnery?.standDown?.();

    // Hoist the player's colors over the captured prize
    const playerColors = (!boat.colors || boat.colors === 'surrender') ? 'portugal' : boat.colors;
    tb.colors = playerColors;
    tb.battleColors = playerColors;

    // If she was a pirate, her prize crew now wears regular attire or prize colors
    const targetComp = getVesselCompany(targetVessel);
    if (targetComp) {
      applyPirateCrewAttire(targetComp, false);
      releaseCrewRailAction(targetComp, tb);
    }
    releaseCrewRailAction(state.company, boat);
    boat.boardingActive = false;
    tb.boardingActive = false;

    const shipLabel = tb.shipName || tb.name || 'Captured Prize';
    const targetPower = computeBoardingStrength(targetVessel, targetComp);
    const plunder = {
      vesselName: shipLabel,
      captureMethod,
      waterDays: 12,
      foodDays: 16,
      cannons: 4,
      survivingCrew: Math.max(2, targetPower.able || 6),
      timberTonnes: 6,
      goldEscudos: captureMethod === 'boarded-and-fought' ? 280 : 180,
    };

    if (!state.capturedVessels.includes(targetVessel)) {
      state.capturedVessels.push(targetVessel);
    }
    state.pendingPrizeVessel = targetVessel;
    state.boardingPhase = 'captured';
    state.lastOutcome = {
      outcome: 'captured',
      captureMethod,
      vessel: targetVessel,
      plunder,
    };
    state.statusText = captureMethod === 'surrendered'
      ? `Boarded surrendered ${shipLabel} and took her as a prize! Hoisted ${playerColors} colors.`
      : `Boarding party victorious! Captured ${shipLabel} hand-to-hand and hoisted ${playerColors} colors!`;
    state.combatLog.unshift(state.statusText);
    emit('vessel-captured', { targetVessel, captureMethod, plunder });
    return state.lastOutcome;
  }

  // Resolve what to do with a captured prize vessel:
  // - 'ally': Put a prize crew aboard and keep her in our fleet as an allied warship
  // - 'impress-plunder': Impress her surviving crew and plunder her cannon & supplies
  // - 'scuttle-repair': Plunder her supplies & raw materials (oak timber, spars, canvas) to repair our boat and scuttle the prize
  function resolvePrizeDisposition(targetVessel = null, disposition = 'ally', { voyage = null, playerVessel = null } = {}) {
    const vessel = targetVessel ?? state.pendingPrizeVessel ?? state.targetVessel ?? state.capturedVessels[state.capturedVessels.length - 1];
    if (!vessel?.boat) {
      return { ok: false, reason: 'No captured prize vessel to dispose of' };
    }
    const tb = vessel.boat;
    const shipLabel = tb.shipName || tb.name || 'Captured Prize';
    const playerColors = (!boat.colors || boat.colors === 'surrender') ? 'portugal' : boat.colors;
    state.pendingPrizeVessel = null;

    if (disposition === 'ally') {
      tb.captured = true;
      tb.allyConsort = true;
      tb.disarmedPrize = false;
      tb.scuttled = false;
      tb.colors = playerColors;
      tb.battleColors = playerColors;
      tb.faction = 'friendly';
      vessel.faction = 'friendly';
      vessel.isPirate = false;
      if (tb.damage) {
        tb.damage.surrendered = false;
        tb.damage.sunk = false;
        tb.damage.settledWreck = false;
        tb.damage.restingOnBottom = false;
        tb.damage.hullIntegrity = Math.max(0.68, tb.damage.hullIntegrity ?? 0.68);
        tb.damage.rigIntegrity = Math.max(0.75, tb.damage.rigIntegrity ?? 0.75);
        tb.damage.floodingRate = 0;
        tb.damage.floodingLevel = 0;
        tb.damage.floodingSinkage = 0;
        tb.damage.battleMorale = 0.88;
        tb.damage.moraleState = 'steady';
        if (tb.damage.crewCasualties) {
          tb.damage.crewCasualties.surrendered = false;
          tb.damage.crewCasualties.able = Math.max(6, tb.damage.crewCasualties.able || 8);
          tb.damage.crewCasualties.battleMorale = 0.88;
        }
      }
      if (vessel.follower) {
        vessel.follower.faction = 'friendly';
        vessel.follower.encounterMode = null;
        vessel.follower.formation = { trail: 2.2, side: 1.6 };
        vessel.follower.captainOrder = 'full';
        vessel.follower.status = `Allied Prize (${shipLabel})`;
      }
      tb.sailFore = 1;
      tb.sailMain = 1;
      tb.sailMizzen = 1;
      if (voyage?.provisions) {
        voyage.provisions.water = Math.min(90, (voyage.provisions.water ?? 30) + 8);
        voyage.provisions.food = Math.min(120, (voyage.provisions.food ?? 40) + 10);
      }
      if (state.mooringPhase !== 'clear') castOff();
      const summary = `🏴 Prize crew placed aboard ${shipLabel}! She hoists ${playerColors} colors and joins our fleet as an allied consort (+8d water, +10d food).`;
      state.statusText = summary;
      state.combatLog.unshift(summary);
      const res = { ok: true, disposition: 'ally', vessel, summary };
      emit('prize-disposition', res);
      return res;
    }

    if (disposition === 'gift-indigenous' || disposition === 'gift-prize') {
      const lat = voyage?.true?.lat ?? state.terrain?.region?.latitude ?? 18.4;
      const lon = voyage?.true?.lon ?? state.terrain?.region?.longitude ?? -69.9;
      const culture =
        resolveIndigenousCultureRegion(lat, lon) ||
        { id: state.terrain?.region?.indigenousSettlement?.cultureId || 'taino-greater-antilles' };
      const sovRes = applyIndigenousSupportAction(
        culture.id,
        'gift-prize',
        getActiveIndigenousSovereigntyState(),
        { boat, voyage, cannonCount: 6 }
      );
      boat.colors = 'indigenous-confederacy';
      tb.colors = 'indigenous-confederacy';
      tb.allyConsort = true;
      tb.faction = 'friendly';
      vessel.faction = 'friendly';
      if (tb.damage) {
        tb.damage.surrendered = false;
        tb.damage.sunk = false;
        tb.damage.hullIntegrity = Math.max(0.75, tb.damage.hullIntegrity ?? 0.75);
        tb.damage.rigIntegrity = Math.max(0.80, tb.damage.rigIntegrity ?? 0.80);
        tb.damage.floodingRate = 0;
        tb.damage.floodingLevel = 0;
        tb.damage.battleMorale = 0.94;
      }
      if (vessel.follower) {
        vessel.follower.faction = 'friendly';
        vessel.follower.encounterMode = null;
        vessel.follower.formation = { trail: 2.0, side: -1.8 };
        vessel.follower.captainOrder = 'full';
        vessel.follower.status = `Sovereign Indigenous Consort (${shipLabel})`;
      }
      tb.sailFore = 1;
      tb.sailMain = 1;
      tb.sailMizzen = 1;
      if (state.mooringPhase !== 'clear') castOff();
      const summary = `🛡️ ${sovRes.message}`;
      state.statusText = summary;
      state.combatLog.unshift(summary);
      const res = {
        ok: true,
        disposition: 'gift-indigenous',
        vessel,
        sovereigntyResult: sovRes,
        summary,
      };
      emit('prize-disposition', res);
      return res;
    }

    if (disposition === 'impress-plunder') {
      const targetComp = getVesselCompany(vessel);
      const targetSailors = targetComp?.crew ?? targetComp?.sailors ?? [];
      const targetAble = targetSailors.filter(s => s.casualtyState !== 'fallen' && s.wounded !== 'incapacitated').length;
      const pressedCount = Math.max(3, Math.min(8, targetAble > 0 ? Math.ceil(targetAble * 0.5) : 4));

      // Heal wounded/fallen in player's crew and add pressed hands to player's roster (women and men equally strong = 1.0)
      const playerSailors = state.company?.crew ?? state.company?.sailors ?? [];
      let healed = 0;
      for (const s of playerSailors) {
        if (healed < pressedCount && (s.wounded || s.casualtyState !== 'able' || (s.health ?? 1) < 1)) {
          s.health = 1.0;
          s.wounded = null;
          s.casualtyState = 'able';
          s.strength = 1.0;
          healed++;
        }
      }
      let addedToRoster = 0;
      if (Array.isArray(state.company?.crew)) {
        const candidates = targetSailors.filter(s => s.casualtyState !== 'fallen');
        for (let i = 0; i < pressedCount; i++) {
          const src = candidates[i];
          const sex = src?.sex ?? (i % 2 === 0 ? 'female' : 'male');
          state.company.crew.push({
            id: `impressed-${Date.now()}-${i}`,
            name: src?.name ?? (sex === 'female' ? `Catalina (${shipLabel})` : `Rodrigo (${shipLabel})`),
            role: src?.role ?? 'Able seaman (impressed)',
            sex,
            strength: 1.0,
            health: 1.0,
            casualtyState: 'able',
            wounded: null,
            x: 0,
            y: 0,
            z: 0,
          });
          addedToRoster++;
        }
      }
      const dmg = boat.damage;
      if (dmg) {
        dmg.battleMorale = bdClamp((dmg.battleMorale ?? 0.85) + 0.22, 0.2, 1.0);
        dmg.moraleState = 'steady';
        const cas = dmg.crewCasualties ?? dmg.crew;
        if (cas) {
          cas.total = (cas.total ?? 22) + Math.max(0, pressedCount - healed);
          cas.able = Math.min(cas.total, (cas.able ?? 18) + pressedCount);
          cas.wounded = Math.max(0, (cas.wounded ?? 0) - healed);
          cas.battleMorale = dmg.battleMorale;
        }
      }
      if (state.company) {
        state.company.morale = bdClamp((state.company.morale ?? 0.85) + 0.20, 0.2, 1.0);
      }

      // Plunder her cannon, powder, shot, and provisions
      const plunderedGuns = 4;
      boat.plunderedCannons = (boat.plunderedCannons ?? 0) + plunderedGuns;
      boat.plunderedFirepowerMultiplier = Math.min(2.0, +((boat.plunderedFirepowerMultiplier ?? 1.0) + 0.25).toFixed(2));
      boat.provisionDays = Math.min(120, (boat.provisionDays ?? 60) + 18);
      if (voyage) {
        voyage.morale = Math.min(1.0, (voyage.morale ?? 0.85) + 0.12);
        if (voyage.provisions) {
          voyage.provisions.water = Math.min(90, (voyage.provisions.water ?? 30) + 18);
          voyage.provisions.food = Math.min(120, (voyage.provisions.food ?? 40) + 24);
        }
      }

      // Disarm the prize and leave her hove-to
      tb.allyConsort = false;
      tb.disarmedPrize = true;
      tb.sailFore = 0;
      tb.sailMain = 0;
      tb.sailMizzen = 0;
      if (vessel.follower) {
        vessel.follower.faction = 'friendly';
        vessel.follower.encounterMode = 'adrift';
        vessel.follower.captainOrder = 'furl';
        vessel.follower.status = `Plundered Hulk (${shipLabel})`;
      }
      vessel.gunnery?.standDown?.();
      if (state.mooringPhase !== 'clear') castOff();

      const summary = `⚓ Impressed ${pressedCount} able hands into our crew and plundered ${plunderedGuns} cannon (+25% broadside weight, +18d water, +24d food) from ${shipLabel}!`;
      state.statusText = summary;
      state.combatLog.unshift(summary);
      const res = {
        ok: true,
        disposition: 'impress-plunder',
        vessel,
        impressedCount: addedToRoster || pressedCount,
        pressedCrew: pressedCount,
        plunderedCannons: plunderedGuns,
        waterDays: 18,
        foodDays: 24,
        summary,
      };
      emit('prize-disposition', res);
      return res;
    }

    if (disposition === 'scuttle-repair') {
      // Salvage oak planking, spars, canvas, cordage, and stores to repair our hull & rigging
      const prevHull = boat.damage?.hullIntegrity ?? 1.0;
      const prevRig = boat.damage?.rigIntegrity ?? 1.0;
      if (boat.damage) {
        boat.damage.hullIntegrity = Math.min(1.0, +((boat.damage.hullIntegrity ?? 0.6) + 0.55).toFixed(3));
        boat.damage.rigIntegrity = 1.0;
        boat.damage.floodingRate = 0;
        boat.damage.floodingLevel = 0;
        boat.damage.floodingSinkage = 0;
        boat.damage.floodingRoll = 0;
        boat.damage.floodingPitch = 0;
        boat.damage.battleMorale = Math.min(1.0, (boat.damage.battleMorale ?? 0.85) + 0.15);
        if (boat.damage.mastIntegrity) {
          boat.damage.mastIntegrity.fore = 1;
          boat.damage.mastIntegrity.main = 1;
          boat.damage.mastIntegrity.mizzen = 1;
        }
        if (boat.damage.mastState) {
          boat.damage.mastState.fore = 0;
          boat.damage.mastState.main = 0;
          boat.damage.mastState.mizzen = 0;
        }
        if (Array.isArray(boat.damage.craters)) boat.damage.craters.length = 0;
        if (boat.damage.partDamage) {
          for (const k of Object.keys(boat.damage.partDamage)) boat.damage.partDamage[k] = 0;
        }
      }
      boat.rawMaterialsTonnes = (boat.rawMaterialsTonnes ?? 0) + 6;
      boat.provisionDays = Math.min(120, (boat.provisionDays ?? 60) + 14);
      if (voyage) {
        voyage.hull = boat.damage?.hullIntegrity ?? 1.0;
        if (voyage.provisions) {
          voyage.provisions.water = Math.min(90, (voyage.provisions.water ?? 30) + 14);
          voyage.provisions.food = Math.min(120, (voyage.provisions.food ?? 40) + 18);
        }
      }
      if (playerVessel) {
        playerVessel.pose?.updateDamage?.(boat);
        playerVessel.wetness?.updateDamage?.(boat.damage);
      }

      // Cast off and scuttle the prize so she floods and sinks into the sea
      if (state.mooringPhase !== 'clear') castOff();
      tb.allyConsort = false;
      tb.scuttled = true;
      tb.sunk = true;
      tb.showProw = false;
      tb.sailFore = 0;
      tb.sailMain = 0;
      tb.sailMizzen = 0;
      if (tb.damage) {
        tb.damage.sunk = true;
        tb.damage.hullIntegrity = 0;
        tb.damage.floodingRate = 0.38;
        tb.damage.floodingLevel = 1.0;
        tb.damage.sinkingDepth = Math.max(2.2, tb.damage.sinkingDepth ?? 2.2);
        tb.damage.floodingSinkage = Math.max(1.8, tb.damage.floodingSinkage ?? 1.8);
        tb.damage.floodingPitch = 0.14;
        tb.damage.floodingRoll = 0.22;
      }
      if (vessel.follower) {
        vessel.follower.status = `Scuttled (${shipLabel} sinking)`;
      }
      vessel.gunnery?.standDown?.();

      const newHullPct = Math.round((boat.damage?.hullIntegrity ?? 1) * 100);
      const summary = `🔨 Stripped ${shipLabel} of oak timber, spars, canvas & stores and scuttled her! Repaired our hull (${Math.round(prevHull * 100)}% → ${newHullPct}%) and rigging (${Math.round(prevRig * 100)}% → 100%), +14d water, +18d food.`;
      state.statusText = summary;
      state.combatLog.unshift(summary);
      const res = {
        ok: true,
        disposition: 'scuttle-repair',
        vessel,
        hullIntegrityAfter: boat.damage?.hullIntegrity ?? 1.0,
        rigIntegrityAfter: boat.damage?.rigIntegrity ?? 1.0,
        rawMaterialsTonnes: boat.rawMaterialsTonnes,
        scuttledSunk: true,
        summary,
      };
      emit('prize-disposition', res);
      return res;
    }

    return { ok: false, reason: `Unknown prize disposition: ${disposition}` };
  }

  // Board a target vessel:
  // - If surrendered -> grapple, lay gangplanks, and take her as a prize without bloodshed.
  // - If not surrendered -> grapple, lay gangplanks, and fight crew-vs-crew based on
  //   morale and strength (women just as strong as men) until one side wins.
  function boardVessel(targetVessel = null, { immediateResolve = false } = {}) {
    const vessel = targetVessel ?? state.targetVessel ?? findNearestBoardableVessel();
    if (!vessel?.boat) {
      return { ok: false, reason: 'No vessel within boarding reach' };
    }
    const tb = vessel.boat;
    const isSurrendered = Boolean(tb.damage?.surrendered || tb.colors === 'surrender');

    grappleShip(vessel, {
      mode: isSurrendered ? 'board-surrendered' : 'board-fight',
      pullAlongside: true,
    });

    state.boardingMode = isSurrendered ? 'surrendered' : 'fight';
    state.boardingTimer = 0;
    state.combatRoundTimer = 0;
    state.combatRounds = 0;

    if (isSurrendered) {
      state.boardingPhase = 'capturing-surrendered';
      state.statusText = `Throwing grappling irons & boarding surrendered ${tb.shipName || tb.name || 'vessel'} to take prize possession…`;
      if (immediateResolve) {
        state.mooringPhase = 'grappled';
        state.lineProgress = 1.0;
        state.lineTension = 1.0;
        state.gangplankProgress = 1.0;
        const result = capturePrizeVessel(vessel, 'surrendered');
        return { ok: true, mode: 'surrendered', ...result };
      }
      return { ok: true, mode: 'surrendered', phase: state.boardingPhase, vessel };
    }

    // Active boarding combat
    state.boardingPhase = 'grappling';
    boat.boardingActive = true;
    tb.boardingActive = true;
    assignCrewToRailAction(state.company, boat, 'boarding', state.mooringSide);
    const targetComp = getVesselCompany(vessel);
    if (targetComp) {
      const oppSide = state.mooringSide === 'port' ? 'starboard' : 'port';
      assignCrewToRailAction(targetComp, tb, 'boarding', oppSide);
    }

    const atk = computeBoardingStrength({ boat, company: state.company });
    const def = computeBoardingStrength(vessel);
    state.statusText = `Grappling ${tb.shipName || tb.name || 'enemy vessel'} to board & fight! Crew strength ${atk.effectiveStrength.toFixed(1)} (morale ${Math.round(atk.morale * 100)}%) vs ${def.effectiveStrength.toFixed(1)} (morale ${Math.round(def.morale * 100)}%).`;
    state.combatLog.unshift(state.statusText);

    if (immediateResolve) {
      state.mooringPhase = 'grappled';
      state.lineProgress = 1.0;
      state.lineTension = 1.0;
      state.gangplankProgress = 1.0;
      state.boardingPhase = 'boarding-melee';
      for (let i = 0; i < 16 && state.boardingPhase === 'boarding-melee'; i++) {
        stepBoardingCombatRound();
      }
      return {
        ok: true,
        mode: 'fight',
        phase: state.boardingPhase,
        outcome: state.lastOutcome,
        vessel,
      };
    }

    return { ok: true, mode: 'fight', phase: state.boardingPhase, vessel };
  }

  function stepCrewCasualtiesAndMorale(boatObj, companyObj, casualtyPoints, moraleDrop) {
    const sailors = companyObj?.crew ?? companyObj?.sailors ?? [];
    let remaining = casualtyPoints;
    for (const s of sailors) {
      if (remaining <= 0.01) break;
      if (s.casualtyState === 'fallen' || s.wounded === 'incapacitated') continue;
      const currentHealth = s.health ?? 1.0;
      const hit = Math.min(currentHealth, remaining * 0.42);
      s.health = Math.max(0.05, currentHealth - hit);
      remaining -= hit * 2.0;
      if (s.health <= 0.18) {
        s.wounded = 'incapacitated';
        s.casualtyState = 'fallen';
        s.woundSeverity = 1.0;
        s.scorchAmount = Math.min(1, (s.scorchAmount ?? 0) + 0.25);
        s.collapseYaw = s.yaw ?? 0;
        s.fallDir = ((s.crewIndex ?? 0) % 2 === 0) ? 1 : -1;
      } else if (s.health < 0.72) {
        s.wounded = 'wounded';
        s.casualtyState = 'wounded';
        s.woundSeverity = Math.max(0.45, 1 - s.health);
        s.scorchAmount = Math.min(1, (s.scorchAmount ?? 0) + 0.12);
      }
    }

    if (companyObj) {
      companyObj.morale = bdClamp((companyObj.morale ?? 0.9) - moraleDrop, 0.05, 1.0);
    }
    const dmg = boatObj?.damage;
    if (dmg) {
      dmg.battleMorale = bdClamp((dmg.battleMorale ?? 0.9) - moraleDrop, 0.05, 1.0);
      const cas = dmg.crewCasualties ?? dmg.crew;
      if (cas) {
        if (sailors.length > 0) {
          let able = 0, wounded = 0, incap = 0;
          for (const s of sailors) {
            if (s.casualtyState === 'fallen' || s.wounded === 'incapacitated' || (s.health ?? 1) <= 0.18) incap++;
            else if (s.casualtyState === 'wounded' || s.wounded === 'wounded' || (s.health ?? 1) < 0.72) wounded++;
            else able++;
          }
          cas.able = able;
          cas.wounded = wounded;
          cas.incapacitated = incap;
          cas.killed = incap;
        } else {
          const woundCount = Math.min(cas.able ?? 0, Math.max(0, Math.round(casualtyPoints * 0.85)));
          cas.able = Math.max(0, (cas.able ?? 10) - woundCount);
          cas.wounded = (cas.wounded ?? 0) + Math.ceil(woundCount * 0.65);
          const fallenDelta = Math.floor(woundCount * 0.35);
          cas.incapacitated = (cas.incapacitated ?? 0) + fallenDelta;
          cas.killed = (cas.killed ?? 0) + fallenDelta;
        }
        cas.battleMorale = dmg.battleMorale;
        if (dmg.battleMorale <= 0.18 || cas.able <= 1) {
          cas.surrendered = true;
          dmg.surrendered = true;
        }
      }
    }
  }

  function stepBoardingCombatRound() {
    const vessel = state.targetVessel;
    if (!vessel?.boat) {
      state.boardingPhase = 'none';
      return;
    }
    const tb = vessel.boat;
    const targetComp = getVesselCompany(vessel);
    state.combatRounds++;

    const atk = computeBoardingStrength({ boat, company: state.company });
    const def = computeBoardingStrength(vessel, targetComp);

    const ratio = atk.effectiveStrength / Math.max(0.5, def.effectiveStrength);
    const invRatio = def.effectiveStrength / Math.max(0.5, atk.effectiveStrength);

    // Damage and morale shock inflicted by each crew on the other
    const defCasualties = bdClamp(0.85 * Math.pow(ratio, 0.85), 0.25, 3.2);
    const atkCasualties = bdClamp(0.65 * Math.pow(invRatio, 0.85), 0.12, 2.6);
    const defMoraleDrop = bdClamp(0.11 * ratio, 0.04, 0.28);
    const atkMoraleDrop = bdClamp(0.07 * invRatio, 0.02, 0.22);

    stepCrewCasualtiesAndMorale(tb, targetComp, defCasualties, defMoraleDrop);
    stepCrewCasualtiesAndMorale(boat, state.company, atkCasualties, atkMoraleDrop);

    const atkAfter = computeBoardingStrength({ boat, company: state.company });
    const defAfter = computeBoardingStrength(vessel, targetComp);

    state.statusText = `Boarding melee round ${state.combatRounds}: Our crew ${atkAfter.able} able (${Math.round(atkAfter.morale * 100)}% morale, str ${atkAfter.effectiveStrength.toFixed(1)}) vs ${tb.shipName || tb.name || 'Enemy'} ${defAfter.able} able (${Math.round(defAfter.morale * 100)}% morale, str ${defAfter.effectiveStrength.toFixed(1)})`;
    state.combatLog.unshift(state.statusText);
    if (state.combatLog.length > 12) state.combatLog.length = 12;

    // Check victory / defeat conditions based on morale and remaining strength
    const defenderBroken =
      defAfter.morale <= 0.20 ||
      defAfter.able <= 1 ||
      (state.combatRounds >= 3 && atkAfter.effectiveStrength >= defAfter.effectiveStrength * 1.45) ||
      (state.combatRounds >= 6 && atkAfter.effectiveStrength >= defAfter.effectiveStrength);

    const attackerBroken =
      !defenderBroken && (
        atkAfter.morale <= 0.16 ||
        atkAfter.able <= 1 ||
        (state.combatRounds >= 4 && defAfter.effectiveStrength >= atkAfter.effectiveStrength * 1.55)
      );

    if (defenderBroken) {
      capturePrizeVessel(vessel, 'boarded-and-fought');
    } else if (attackerBroken) {
      state.boardingPhase = 'repulsed';
      releaseCrewRailAction(state.company, boat);
      if (targetComp) releaseCrewRailAction(targetComp, tb);
      state.lastOutcome = {
        outcome: 'repulsed',
        vessel,
        attacker: atkAfter,
        defender: defAfter,
      };
      state.statusText = `Boarding party driven back from ${tb.name || 'enemy vessel'}! Regrouping on deck.`;
      state.combatLog.unshift(state.statusText);
      emit('boarding-repulsed', state.lastOutcome);
    }
  }

  // Cast off all mooring / grappling lines and retract gangplanks
  function castOff() {
    if (state.mooringPhase === 'clear' && state.boardingPhase === 'none') {
      return { ok: false, reason: 'Already clear of all lines' };
    }
    const prevTarget = state.mooringTargetKind === 'pier'
      ? (state.pier?.label || 'pier')
      : (state.targetVessel?.boat?.shipName || state.targetVessel?.boat?.name || 'vessel');
    state.mooringPhase = 'casting-off';
    state.boardingPhase = 'none';
    state.boardingMode = null;
    state.phaseTimer = 0;
    // Immediately release line tension and mooring restraint so inward hauling stops on this exact frame!
    state.lineTension = 0;
    boat.mooringForce = null;
    boat.mooringRestraint = 0;
    boat.boardingActive = false;
    boat.mooringActive = true;
    if (state.targetVessel?.boat) {
      state.targetVessel.boat.mooringRestraint = 0;
      state.targetVessel.boat.boardingActive = false;
      state.targetVessel.boat.mooringActive = false;
    }
    assignCrewToRailAction(state.company, boat, 'mooring', state.mooringSide);

    // Cancel any inward hauling velocity and impart a smooth lateral shove-off velocity
    // away from the pier/ship (negative lateralSpeed = moving away along -pierNormal).
    const { rightX, rightZ } = boatBasis(boat);
    const sideSign = state.mooringSide === 'port' ? -1 : 1;
    const awaySign = -sideSign;
    if (!state.pierNormalX && !state.pierNormalZ) {
      state.pierNormalX = rightX * sideSign;
      state.pierNormalZ = rightZ * sideSign;
    }
    const lateralShoveSpeed = 0.85;
    state.lateralSpeed = -lateralShoveSpeed;
    state.haulVx = -state.pierNormalX * lateralShoveSpeed;
    state.haulVz = -state.pierNormalZ * lateralShoveSpeed;
    boat.leewayVelocity = awaySign * 0.55;
    boat.surgeVelocity = Math.max(boat.surgeVelocity ?? 0, 0.55);
    boat.u = boat.surgeVelocity;
    boat.v = boat.leewayVelocity;

    state.statusText = `Casting off bow & stern lines from ${prevTarget}…`;
    emit('cast-off-start', { target: prevTarget });
    return { ok: true, target: prevTarget };
  }

  function findNearestBoardableVessel(maxDist = 260) {
    const vessels = state.getAdditionalVessels() ?? [];
    let best = null;
    let bestD = maxDist;
    for (const v of vessels) {
      if (!v?.boat || v.boat.sunk) continue;
      const d = Math.hypot((v.boat.x ?? 0) - (boat.x ?? 0), (v.boat.z ?? 0) - (boat.z ?? 0));
      if (d < bestD) {
        bestD = d;
        best = v;
      }
    }
    return best;
  }

  function moveBoatSmooth(dx, dz) {
    if (!Number.isFinite(dx) || !Number.isFinite(dz)) return;
    if (Math.abs(dx) < 1e-6 && Math.abs(dz) < 1e-6) return;
    const prevX = boat.x ?? 0;
    const prevZ = boat.z ?? 0;
    boat.x = prevX + dx;
    boat.z = prevZ + dz;
    if (state.terrain && typeof state.terrain.constrain === 'function') {
      const blocked = state.terrain.constrain(boat, prevX, prevZ);
      if (blocked) {
        state.lateralSpeed = 0;
        state.lateralGap = 0;
        state.haulVx = 0;
        state.haulVz = 0;
      }
    }
  }

  function applyMooringPhysics(dt) {
    if (state.mooringPhase === 'casting-off') {
      boat.mooringRestraint = 0;
      boat.mooringForce = null;
      if (state.targetVessel?.boat) state.targetVessel.boat.mooringRestraint = 0;
      // Smoothly glide away from the pier/ship along -pierNormal with exponential water drag
      const drag = Math.exp(-dt * 1.65);
      state.lateralSpeed = Math.min(0, (state.lateralSpeed ?? -0.85) * drag);
      const stepAway = -state.lateralSpeed * dt; // > 0
      state.lateralGap = (state.lateralGap ?? 0) + stepAway;
      const awayX = -state.pierNormalX * stepAway;
      const awayZ = -state.pierNormalZ * stepAway;
      state.haulVx = -state.pierNormalX * Math.abs(state.lateralSpeed);
      state.haulVz = -state.pierNormalZ * Math.abs(state.lateralSpeed);
      moveBoatSmooth(awayX, awayZ);
      // Prevent wind leeway from pushing the ship back toward the pier while casting off
      const sideSign = state.mooringSide === 'port' ? -1 : 1;
      if (Number.isFinite(boat.leewayVelocity) && boat.leewayVelocity * sideSign > 0) {
        boat.leewayVelocity = 0;
      }
      return;
    }

    if (
      state.mooringPhase !== 'throwing-lines' &&
      state.mooringPhase !== 'making-fast' &&
      state.mooringPhase !== 'moored' &&
      state.mooringPhase !== 'grappled'
    ) {
      boat.mooringRestraint = 0;
      if (state.targetVessel?.boat) state.targetVessel.boat.mooringRestraint = 0;
      state.lateralSpeed = 0;
      state.haulVx = 0;
      state.haulVz = 0;
      boat.mooringForce = null;
      return;
    }

    // Smoothly ramp mooring restraint so sail/wave drift checks gently without fighting the lines
    const rawTension = bdClamp(state.lineTension, 0, 1);
    const smoothTension = rawTension * rawTension * (3 - 2 * rawTension);
    const restraint = state.mooringPhase === 'throwing-lines'
      ? 0.35 * bdClamp(state.lineProgress, 0, 1)
      : 0.35 + 0.65 * smoothTension;
    boat.mooringRestraint = restraint;
    if (state.mooringTargetKind === 'vessel' && state.targetVessel?.boat) {
      state.targetVessel.boat.mooringRestraint = restraint;
    }

    const velDecay = Math.exp(-dt * 4.5 * restraint);
    if (Number.isFinite(boat.surgeVelocity)) boat.surgeVelocity *= velDecay;
    if (Number.isFinite(boat.leewayVelocity)) boat.leewayVelocity *= velDecay;
    if (Number.isFinite(boat.yawRate)) boat.yawRate *= velDecay;
    if (Number.isFinite(boat.u)) boat.u *= velDecay;
    if (Number.isFinite(boat.v)) boat.v *= velDecay;

    const haulEffort = state.mooringPhase === 'throwing-lines'
      ? 0.0
      : smoothTension;
    if (haulEffort <= 0.005) {
      state.lateralSpeed = 0;
      boat.mooringForce = null;
      return;
    }

    if (state.mooringTargetKind === 'pier' && state.pier) {
      const gap = Math.max(0, state.lateralGap ?? 0);
      if (gap > 0.002) {
        // First-order smoothed 1D lateral warping speed along locked pierNormal:
        // accelerates smoothly from 0 up to ~1.05 m/s and eases smoothly to 0 at berth.
        const targetSpeed = Math.min(1.05, gap * 0.85) * haulEffort;
        state.lateralSpeed = Math.max(0, state.lateralSpeed ?? 0);
        state.lateralSpeed += (targetSpeed - state.lateralSpeed) * Math.min(1, dt * 4.2);
        const stepLat = Math.min(gap, state.lateralSpeed * dt);
        state.lateralGap = Math.max(0, gap - stepLat);
        state.haulVx = state.pierNormalX * state.lateralSpeed;
        state.haulVz = state.pierNormalZ * state.lateralSpeed;
        moveBoatSmooth(state.pierNormalX * stepLat, state.pierNormalZ * stepLat);
      } else {
        state.lateralSpeed = 0;
        state.haulVx = 0;
        state.haulVz = 0;
      }
    } else if (state.mooringTargetKind === 'vessel' && state.targetVessel?.boat) {
      const tb = state.targetVessel.boat;
      const gap = Math.max(0, state.lateralGap ?? 0);
      if (gap > 0.002) {
        const targetSpeed = Math.min(1.25, gap * 0.9) * haulEffort;
        state.lateralSpeed = Math.max(0, state.lateralSpeed ?? 0);
        state.lateralSpeed += (targetSpeed - state.lateralSpeed) * Math.min(1, dt * 4.5);
        const stepLat = Math.min(gap, state.lateralSpeed * dt);
        state.lateralGap = Math.max(0, gap - stepLat);
        state.haulVx = state.pierNormalX * state.lateralSpeed;
        state.haulVz = state.pierNormalZ * state.lateralSpeed;
        // Both hulls draw smoothly toward each other (35% player ship, 65% target ship)
        moveBoatSmooth(state.pierNormalX * stepLat * 0.35, state.pierNormalZ * stepLat * 0.35);
        tb.x = (tb.x ?? 0) - state.pierNormalX * stepLat * 0.65;
        tb.z = (tb.z ?? 0) - state.pierNormalZ * stepLat * 0.65;
      } else {
        state.lateralSpeed = 0;
        state.haulVx = 0;
        state.haulVz = 0;
      }
      if (Number.isFinite(tb.surgeVelocity)) tb.surgeVelocity *= velDecay;
      if (Number.isFinite(tb.leewayVelocity)) tb.leewayVelocity *= velDecay;
      if (Number.isFinite(tb.u)) tb.u *= velDecay;
      if (Number.isFinite(tb.v)) tb.v *= velDecay;
    }
  }

  function step(dt) {
    if (!(dt > 0)) return;
    state.phaseTimer += dt;

    if (state.mooringPhase === 'throwing-lines') {
      state.lineProgress = bdClamp(state.lineProgress + dt * 0.65, 0, 1);
      if (state.lineProgress >= 1.0) {
        state.mooringPhase = 'making-fast';
        state.phaseTimer = 0;
        state.statusText = state.mooringTargetKind === 'pier'
          ? `Lines over the bollards on ${state.pier?.label || 'pier'} — hauling taut & making fast…`
          : `Grappling hooks fast on ${state.targetVessel?.boat?.name || 'vessel'} — hauling bulwarks alongside…`;
        emit('making-fast', { pier: state.pier, vessel: state.targetVessel });
      }
    } else if (state.mooringPhase === 'making-fast') {
      state.lineTension = bdClamp(state.lineTension + dt * 0.85, 0, 1);
      if (state.mooringTargetKind === 'vessel') {
        state.gangplankProgress = bdClamp(state.gangplankProgress + dt * 0.75, 0, 1);
      }
      if (state.lineTension >= 1.0) {
        state.mooringPhase = state.mooringTargetKind === 'pier' ? 'moored' : 'grappled';
        state.phaseTimer = 0;
        if (state.mooringPhase === 'moored') {
          releaseCrewRailAction(state.company, boat);
          state.statusText = `Moored fast alongside ${state.pier?.label || 'pier'} (${state.mooringSide} side). Ready to cast off.`;
          emit('dock-complete', { pier: state.pier });
        } else {
          state.gangplankProgress = 1.0;
          if (state.boardingPhase === 'capturing-surrendered' && state.targetVessel) {
            capturePrizeVessel(state.targetVessel, 'surrendered');
          } else if (state.boardingPhase === 'grappling') {
            state.boardingPhase = 'boarding-melee';
            state.combatRoundTimer = 0;
            state.statusText = `Gangplanks down! Boarding party charging across onto ${state.targetVessel?.boat?.name || 'enemy vessel'}!`;
          } else {
            releaseCrewRailAction(state.company, boat);
            state.statusText = `Grappled alongside ${state.targetVessel?.boat?.name || 'vessel'}. Lines & gangplanks fast.`;
          }
        }
      }
    } else if (state.mooringPhase === 'casting-off') {
      state.gangplankProgress = bdClamp(state.gangplankProgress - dt * 1.6, 0, 1);
      state.lineTension = 0;
      state.lineProgress = bdClamp(state.lineProgress - dt * 1.15, 0, 1);
      if (state.lineProgress <= 0.01) {
        state.mooringPhase = 'clear';
        state.mooringTargetKind = null;
        state.pier = null;
        state.berthX = null;
        state.berthZ = null;
        state.haulVx = 0;
        state.haulVz = 0;
        state.targetVessel = null;
        state.lines = [];
        state.lineProgress = 0;
        state.lineTension = 0;
        state.gangplankProgress = 0;
        releaseCrewRailAction(state.company, boat);
        state.statusText = 'All lines cast off and coiled aboard · Making way';
        emit('cast-off-complete', {});
      }
    }

    if (state.boardingPhase === 'boarding-melee') {
      state.boardingTimer += dt;
      state.combatRoundTimer += dt;
      if (state.combatRoundTimer >= 1.35) {
        state.combatRoundTimer = 0;
        stepBoardingCombatRound();
      }
    }

    applyMooringPhysics(dt);
  }

  function buildVertices() {
    return buildMooringAndGangplankVertices(state, boat);
  }

  return {
    state,
    dockAtPier,
    grappleShip,
    boardVessel,
    capturePrizeVessel,
    resolvePrizeDisposition,
    castOff,
    step,
    buildVertices,
    findNearestBoardableVessel,
    computePlayerStrength: () => computeBoardingStrength({ boat, company: state.company }),
  };
}

// Push a 3-sided prism tube segment along p0 -> p1 (mode 4 = braided hemp rope)
function pushRopeSegment(out, p0, p1, radius, u0, u1, lineIndex) {
  const dx = p1[0] - p0[0];
  const dy = p1[1] - p0[1];
  const dz = p1[2] - p0[2];
  const len = Math.hypot(dx, dy, dz) || 1e-4;
  const tx = dx / len, ty = dy / len, tz = dz / len;

  // Orthonormal frame around tangent
  let ux = -tz, uy = 0, uz = tx;
  const uLen = Math.hypot(ux, uz);
  if (uLen < 1e-3) {
    ux = 1; uy = 0; uz = 0;
  } else {
    ux /= uLen; uz /= uLen;
  }
  const vx = ty * uz - tz * uy;
  const vy = tz * ux - tx * uz;
  const vz = tx * uy - ty * ux;

  const sides = 3;
  for (let s = 0; s < sides; s++) {
    const a0 = (s / sides) * Math.PI * 2;
    const a1 = ((s + 1) / sides) * Math.PI * 2;
    const c0 = Math.cos(a0), s0 = Math.sin(a0);
    const c1 = Math.cos(a1), s1 = Math.sin(a1);

    const n0x = ux * c0 + vx * s0;
    const n0y = uy * c0 + vy * s0;
    const n0z = uz * c0 + vz * s0;

    const n1x = ux * c1 + vx * s1;
    const n1y = uy * c1 + vy * s1;
    const n1z = uz * c1 + vz * s1;

    const v00 = [p0[0] + n0x * radius, p0[1] + n0y * radius, p0[2] + n0z * radius];
    const v01 = [p0[0] + n1x * radius, p0[1] + n1y * radius, p0[2] + n1z * radius];
    const v10 = [p1[0] + n0x * radius, p1[1] + n0y * radius, p1[2] + n0z * radius];
    const v11 = [p1[0] + n1x * radius, p1[1] + n1y * radius, p1[2] + n1z * radius];

    // Triangle 1
    out.push(
      v00[0], v00[1], v00[2], n0x, n0y, n0z, u0, 0, 4, lineIndex,
      v10[0], v10[1], v10[2], n0x, n0y, n0z, u1, 0, 4, lineIndex,
      v11[0], v11[1], v11[2], n1x, n1y, n1z, u1, 1, 4, lineIndex,
    );
    // Triangle 2
    out.push(
      v00[0], v00[1], v00[2], n0x, n0y, n0z, u0, 0, 4, lineIndex,
      v11[0], v11[1], v11[2], n1x, n1y, n1z, u1, 1, lineIndex === -1 ? 4 : 4, lineIndex,
      v01[0], v01[1], v01[2], n1x, n1y, n1z, u0, 1, 4, lineIndex,
    );
  }
}

// Push a weathered oak boarding gangplank (mode 5) bridging startWorld -> endWorld
function pushGangplankBox(out, startW, endW, width = 0.68, thickness = 0.09) {
  const dx = endW[0] - startW[0];
  const dy = endW[1] - startW[1];
  const dz = endW[2] - startW[2];
  const len = Math.hypot(dx, dz) || 1e-4;
  const rx = -dz / len * (width * 0.5);
  const rz = dx / len * (width * 0.5);

  const p00 = [startW[0] - rx, startW[1] + thickness, startW[2] - rz];
  const p01 = [startW[0] + rx, startW[1] + thickness, startW[2] + rz];
  const p10 = [endW[0] - rx, endW[1] + thickness, endW[2] - rz];
  const p11 = [endW[0] + rx, endW[1] + thickness, endW[2] + rz];

  // Top plank surface
  out.push(
    p00[0], p00[1], p00[2], 0, 1, 0, 0, 0, 5, 0,
    p10[0], p10[1], p10[2], 0, 1, 0, 1, 0, 5, 0,
    p11[0], p11[1], p11[2], 0, 1, 0, 1, 1, 5, 0,

    p00[0], p00[1], p00[2], 0, 1, 0, 0, 0, 5, 0,
    p11[0], p11[1], p11[2], 0, 1, 0, 1, 1, 5, 0,
    p01[0], p01[1], p01[2], 0, 1, 0, 0, 1, 5, 0,
  );
}

export function buildMooringAndGangplankVertices(stateOrController, boatArg = null) {
  const state = stateOrController?.state ?? stateOrController;
  const boat = boatArg ?? state?.boat;
  if (!state || !boat || state.mooringPhase === 'clear' || !state.lines?.length) {
    return new Float32Array(0);
  }

  const out = [];
  const progress = bdClamp(state.lineProgress ?? 0, 0, 1);
  const tension = bdClamp(state.lineTension ?? 0, 0, 1);
  const segs = 10;
  const ropeRadius = 0.042;

  for (let i = 0; i < state.lines.length; i++) {
    const line = state.lines[i];
    const startW = boatWorldPoint(boat, line.shipLocal[0], line.shipLocal[1], line.shipLocal[2]);
    let fullEndW;
    if (state.mooringTargetKind === 'vessel' && state.targetVessel?.boat && line.targetLocal) {
      fullEndW = boatWorldPoint(
        state.targetVessel.boat,
        line.targetLocal[0],
        line.targetLocal[1],
        line.targetLocal[2],
      );
    } else if (line.pierWorld) {
      fullEndW = line.pierWorld;
    } else {
      continue;
    }

    // Stagger each line slightly during throwing/casting off
    const stagger = i * 0.08;
    const lp = bdClamp((progress - stagger) / (1 - stagger * 0.5), 0.04, 1.0);

    // When throwing (< 1 in 'throwing-lines'), the rope end arcs upward through the air toward the bollard/rail;
    // when casting off ('casting-off'), it drops slack off the bollard and coils back aboard;
    // when landed (== 1), it sags in a natural catenary that pulls taut as tension -> 1.
    const isCastingOff = state.mooringPhase === 'casting-off';
    const throwArcLift = (!isCastingOff && lp < 1.0)
      ? Math.sin(lp * Math.PI) * 1.45
      : isCastingOff
      ? -0.45 * Math.sin(lp * Math.PI)
      : 0.0;
    const curEndW = [
      startW[0] + (fullEndW[0] - startW[0]) * lp,
      startW[1] + (fullEndW[1] - startW[1]) * lp + throwArcLift,
      startW[2] + (fullEndW[2] - startW[2]) * lp,
    ];

    const span = Math.hypot(curEndW[0] - startW[0], curEndW[2] - startW[2]);
    const sag = isCastingOff
      ? bdClamp(span * 0.18, 0.16, 1.35)
      : lp >= 0.99
      ? bdClamp(span * (0.14 - 0.095 * tension), 0.12, 1.45)
      : -0.35 * Math.sin(lp * Math.PI);

    let prevPt = startW;
    for (let s = 1; s <= segs; s++) {
      const t = s / segs;
      const u0 = (s - 1) / segs;
      const u1 = t;
      const catenary = -4 * sag * t * (1 - t);
      const pt = [
        startW[0] + (curEndW[0] - startW[0]) * t,
        startW[1] + (curEndW[1] - startW[1]) * t + catenary,
        startW[2] + (curEndW[2] - startW[2]) * t,
      ];
      pushRopeSegment(out, prevPt, pt, ropeRadius, u0, u1, i);
      prevPt = pt;
    }
  }

  // Add oak boarding gangplanks when grappled to a vessel
  const gp = bdClamp(state.gangplankProgress ?? 0, 0, 1);
  if (gp > 0.05 && state.mooringTargetKind === 'vessel' && state.targetVessel?.boat) {
    const tb = state.targetVessel.boat;
    const plankPairs = [1, 2]; // Fore-waist and aft-waist gangplanks
    for (const idx of plankPairs) {
      const line = state.lines[idx];
      if (!line || !line.targetLocal) continue;
      const startW = boatWorldPoint(boat, line.shipLocal[0], line.shipLocal[1] + 0.06, line.shipLocal[2]);
      const fullEndW = boatWorldPoint(tb, line.targetLocal[0], line.targetLocal[1] + 0.06, line.targetLocal[2]);
      const curEndW = [
        startW[0] + (fullEndW[0] - startW[0]) * gp,
        startW[1] + (fullEndW[1] - startW[1]) * gp,
        startW[2] + (fullEndW[2] - startW[2]) * gp,
      ];
      pushGangplankBox(out, startW, curEndW, 0.72, 0.08);
    }
  }

  return new Float32Array(out);
}

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

export const FEMALE_BOARDING_STRENGTH = 1.0;
export const MALE_BOARDING_STRENGTH = 1.0;

function bdClamp(x, a, b) {
  return x < a ? a : x > b ? b : x;
}

function boatWorldPoint(boat, lx, ly, lz) {
  const hull = vesselHull(boat);
  const f = hull.frame;
  const sx = (boat.beam ?? f.beam) / f.beam;
  const sy = f.verticalScale ?? 1;
  const sz = (boat.length ?? f.length) / f.length;
  const h = (boat.heading ?? 0) * Math.PI / 180;
  const ch = Math.cos(h), sh = Math.sin(h);
  const x = lx * sx;
  const y = ly * sy;
  const z = lz * sz;
  return [
    (boat.x ?? 0) + x * ch + z * sh,
    (boat.heave ?? 0) + y,
    (boat.z ?? 0) - x * sh + z * ch,
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

  if (bestPier && bestPier.distance <= 320) {
    return bestPier;
  }

  // Fallback: create a berth alongside the ship's port or starboard beam
  const h = (boat?.heading ?? 0) * Math.PI / 180;
  const rightX = Math.cos(h);
  const rightZ = -Math.sin(h);
  const halfBeam = Math.max(2.4, (boat?.beam ?? 4.8) * 0.5);
  const pierOffset = halfBeam + 2.6;
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
  const h = (boat.heading ?? 0) * Math.PI / 180;
  const fwdX = Math.sin(h);
  const fwdZ = Math.cos(h);
  const rightX = Math.cos(h);
  const rightZ = -Math.sin(h);
  const pierSign = sideSign;
  const halfBeam = Math.max(1.8, (boat.beam ?? 3.6) * 0.5);
  const pierDist = halfBeam + 2.4;

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
  const th = (targetBoat.heading ?? 0) * Math.PI / 180;
  const tRightX = Math.cos(th);
  const tRightZ = -Math.sin(th);
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
    const h = (boat.heading ?? 0) * Math.PI / 180;
    const rightX = Math.cos(h);
    const rightZ = -Math.sin(h);
    const dx = tx - (boat.x ?? 0);
    const dz = tz - (boat.z ?? 0);
    return (dx * rightX + dz * rightZ) >= 0 ? 'starboard' : 'port';
  }

  // Throw mooring lines onto a pier and make fast
  function dockAtPier(env = {}, { immediate = false } = {}) {
    const pier = findNearestPier(boat, env);
    const side = pier.side ?? determineSideToward(pier.x, pier.z);
    state.pier = pier;
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
      state.phaseTimer = 0;
      boat.mooringActive = false;
      state.statusText = `Moored alongside ${pier.label} (${side} lines fast)`;
    } else {
      state.mooringPhase = 'throwing-lines';
      state.lineProgress = 0.05;
      state.lineTension = 0.0;
      state.phaseTimer = 0;
      boat.mooringActive = true;
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
      // Bring vessels beam-to-beam at close grappling distance if within hailing/boarding reach
      const h = (boat.heading ?? 0) * Math.PI / 180;
      const rightX = Math.cos(h);
      const rightZ = -Math.sin(h);
      const dx = (tb.x ?? 0) - (boat.x ?? 0);
      const dz = (tb.z ?? 0) - (boat.z ?? 0);
      const dist = Math.hypot(dx, dz);
      const sideSign = (dx * rightX + dz * rightZ) >= 0 ? 1 : -1;
      const desiredGap = Math.max(6.2, ((boat.beam ?? 4.8) + (tb.beam ?? 4.8)) * 0.68);
      if (dist > desiredGap * 1.35) {
        tb.x = (boat.x ?? 0) + rightX * sideSign * desiredGap;
        tb.z = (boat.z ?? 0) + rightZ * sideSign * desiredGap;
        tb.heading = boat.heading ?? 0;
        tb.u = (boat.u ?? 0) * 0.25;
        tb.v = 0;
      }
    }

    const side = determineSideToward(tb.x ?? 0, tb.z ?? 0);
    state.pier = null;
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
    if (tb.damage) {
      tb.damage.surrendered = true;
    }
    targetVessel.faction = 'friendly';
    targetVessel.isPirate = false;
    tb.faction = 'friendly';
    if (targetVessel.follower) {
      targetVessel.follower.faction = 'friendly';
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
    const plunder = {
      vesselName: shipLabel,
      captureMethod,
      waterDays: 12,
      foodDays: 16,
      goldEscudos: captureMethod === 'boarded-and-fought' ? 280 : 180,
    };

    if (!state.capturedVessels.includes(targetVessel)) {
      state.capturedVessels.push(targetVessel);
    }
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
      } else if (s.health < 0.72) {
        s.wounded = 'wounded';
        s.casualtyState = 'wounded';
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
      : (state.targetVessel?.boat?.name || 'vessel');
    state.mooringPhase = 'casting-off';
    state.boardingPhase = 'none';
    state.boardingMode = null;
    state.phaseTimer = 0;
    boat.mooringForce = null;
    boat.boardingActive = false;
    boat.mooringActive = true;
    assignCrewToRailAction(state.company, boat, 'mooring', state.mooringSide);

    // Gentle shove-off impulse away from the pier/ship so she makes clean sea room
    const h = (boat.heading ?? 0) * Math.PI / 180;
    const rightX = Math.cos(h);
    const rightZ = -Math.sin(h);
    const awaySign = state.mooringSide === 'port' ? 1 : -1;
    boat.u = Math.max(boat.u ?? 0, 0.65);
    boat.v = (boat.v ?? 0) + awaySign * 0.28;
    boat.x = (boat.x ?? 0) + rightX * awaySign * 0.35;
    boat.z = (boat.z ?? 0) + rightZ * awaySign * 0.35;

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

  function applyMooringPhysics(dt) {
    if (state.mooringPhase !== 'making-fast' && state.mooringPhase !== 'moored' && state.mooringPhase !== 'grappled') {
      boat.mooringForce = null;
      return;
    }
    const tension = bdClamp(state.lineTension, 0, 1);
    if (tension <= 0.01) {
      boat.mooringForce = null;
      return;
    }

    if (state.mooringTargetKind === 'pier' && state.pier) {
      // Hold ship gently alongside the pier berth
      const h = (boat.heading ?? 0) * Math.PI / 180;
      const rightX = Math.cos(h);
      const rightZ = -Math.sin(h);
      const sideSign = state.mooringSide === 'port' ? -1 : 1;
      const halfBeam = Math.max(1.8, (boat.beam ?? 3.6) * 0.5);
      const desiredX = state.pier.x - rightX * sideSign * (halfBeam + 2.2);
      const desiredZ = state.pier.z - rightZ * sideSign * (halfBeam + 2.2);
      const dx = desiredX - (boat.x ?? 0);
      const dz = desiredZ - (boat.z ?? 0);
      const dist = Math.hypot(dx, dz);
      if (dist < 45) {
        const pull = Math.min(1, dt * 1.8 * tension);
        boat.x = (boat.x ?? 0) + dx * pull * 0.25;
        boat.z = (boat.z ?? 0) + dz * pull * 0.25;
      }
      boat.u = (boat.u ?? 0) * Math.max(0, 1 - dt * 3.5 * tension);
      boat.v = (boat.v ?? 0) * Math.max(0, 1 - dt * 4.0 * tension);
      boat.yawRate = (boat.yawRate ?? 0) * Math.max(0, 1 - dt * 4.0 * tension);
    } else if (state.mooringTargetKind === 'vessel' && state.targetVessel?.boat) {
      const tb = state.targetVessel.boat;
      const h = (boat.heading ?? 0) * Math.PI / 180;
      const rightX = Math.cos(h);
      const rightZ = -Math.sin(h);
      const sideSign = state.mooringSide === 'port' ? -1 : 1;
      const desiredGap = Math.max(5.8, ((boat.beam ?? 4.8) + (tb.beam ?? 4.8)) * 0.65);
      const targetX = (boat.x ?? 0) + rightX * sideSign * desiredGap;
      const targetZ = (boat.z ?? 0) + rightZ * sideSign * desiredGap;
      const pull = Math.min(1, dt * 2.6 * tension);
      tb.x = (tb.x ?? 0) + (targetX - (tb.x ?? 0)) * pull;
      tb.z = (tb.z ?? 0) + (targetZ - (tb.z ?? 0)) * pull;
      tb.u = (tb.u ?? 0) * Math.max(0, 1 - dt * 3.0 * tension);
      tb.v = (tb.v ?? 0) * Math.max(0, 1 - dt * 3.5 * tension);
      boat.u = (boat.u ?? 0) * Math.max(0, 1 - dt * 2.5 * tension);
      boat.v = (boat.v ?? 0) * Math.max(0, 1 - dt * 3.0 * tension);
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
      state.gangplankProgress = bdClamp(state.gangplankProgress - dt * 1.4, 0, 1);
      state.lineTension = bdClamp(state.lineTension - dt * 1.2, 0, 1);
      state.lineProgress = bdClamp(state.lineProgress - dt * 0.75, 0, 1);
      if (state.lineProgress <= 0.01) {
        state.mooringPhase = 'clear';
        state.mooringTargetKind = null;
        state.pier = null;
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

    // When throwing (< 1), the rope end arcs upward through the air toward the bollard/rail;
    // when landed (== 1), it sags in a natural catenary that pulls taut as tension -> 1.
    const throwArcLift = lp < 1.0 ? Math.sin(lp * Math.PI) * 1.65 : 0.0;
    const curEndW = [
      startW[0] + (fullEndW[0] - startW[0]) * lp,
      startW[1] + (fullEndW[1] - startW[1]) * lp + throwArcLift,
      startW[2] + (fullEndW[2] - startW[2]) * lp,
    ];

    const span = Math.hypot(curEndW[0] - startW[0], curEndW[2] - startW[2]);
    const sag = lp >= 0.99
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

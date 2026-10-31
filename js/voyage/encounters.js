// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
//
// Open-ocean encounter director (1550 era):
// - Whale sightings that trigger the live 3D humpback whale system (`marineLife`)
//   with masthead lookout callouts.
// - Strange-sail sightings (Spanish Flota merchantmen, Portuguese Carreira da
//   Índia naus, French corsairs of Dieppe/La Rochelle, Basque whalers, and
//   distressed caravels) with interactive tactical orders via `raiseInterrupt`:
//     • Bear away to avoid
//     • Hold course
//     • Close to hail (compare dead reckoning, news, provisions)
//     • Clear for action (spawn/position live 3D ship encounter at 1× On deck)

import { compassPointName, relativeBearingCall, formatLatitude, formatLongitude } from './compass.js';
import { addLog, addMark, raiseInterrupt } from './passage.js';
import { mulberry32 } from './ocean-climate.js';

const encounterWrap360 = (d) => ((d % 360) + 360) % 360;

export const ENCOUNTER_ARCHETYPES = Object.freeze([
  {
    id: 'spanish-merchant-nao',
    title: 'Spanish Merchant Nao',
    names: ['Nuestra Señora de la Concepción', 'San Juan Bautista', 'Santa María de Begoña', 'San Nicolás'],
    flag: 'Crown of Castile (Cross of Burgundy)',
    colors: 'castile',
    battleColors: 'castile',
    rig: 'three-masted nao',
    hostile: false,
    speedKts: 5.2,
    weight(lat, lon) {
      if (lat >= 8 && lat <= 38 && lon >= -92 && lon <= -10) return 1.4;
      return 0.45;
    },
  },
  {
    id: 'portuguese-carreira',
    title: 'Portuguese Caravel / Nau',
    names: ['São Bento', 'Espírito Santo', 'Santa Cruz de Lisboa', 'São Pantaleão'],
    flag: 'Kingdom of Portugal (Order of Christ & Quinas)',
    colors: 'portugal',
    battleColors: 'portugal',
    rig: 'lateen caravela redonda',
    hostile: false,
    speedKts: 6.1,
    weight(lat, lon) {
      if (lat >= -36 && lat <= 42 && lon >= -48 && lon <= 25) return 1.35;
      return 0.5;
    },
  },
  {
    id: 'french-corsair',
    title: 'French Huguenot Corsair',
    names: ['Le Faucon de Dieppe', 'La Reine des Mers', 'La Salamandre', 'Le Cerf Volant'],
    flag: 'French privateer / Jolly Roger',
    colors: 'france',
    battleColors: 'jolly-roger',
    rig: 'weatherly flush-decked patache',
    hostile: true,
    disguisedChance: 0.45,
    speedKts: 7.4,
    weight(lat, lon) {
      if (lat >= 10 && lat <= 28 && lon >= -85 && lon <= -58) return 1.3;
      if (lat >= 34 && lat <= 50 && lon >= -32 && lon <= -2) return 1.1;
      return 0.4;
    },
  },
  {
    id: 'basque-whaler',
    title: 'Basque Whaling Nao',
    names: ['Santa Catalina de Pasajes', 'San Sebastián', 'María de Zumaya'],
    flag: 'Guipúzcoa / Señorío de Vizcaya',
    colors: 'basque',
    battleColors: 'basque',
    rig: 'stout Biscayan nao',
    hostile: false,
    speedKts: 4.8,
    weight(lat, lon) {
      if (lat >= 38 && lat <= 62 && lon >= -62 && lon <= -1) return 1.8;
      return 0.15;
    },
  },
  {
    id: 'distressed-caravel',
    title: 'Becalmed Caravel in Distress',
    names: ['Santiago el Menor', 'Todos los Santos', 'Madre de Dios'],
    flag: 'Merchant caravel (sprung fore-topmast)',
    colors: 'portugal',
    battleColors: 'portugal',
    rig: 'two-masted caravel',
    hostile: false,
    distressed: true,
    speedKts: 2.5,
    weight(lat, lon) {
      const absLat = Math.abs(lat);
      if (absLat < 12 || (absLat > 24 && absLat < 33)) return 1.1;
      return 0.35;
    },
  },
]);

export function pickEncounterArchetype(lat, lon, rand = Math.random) {
  let total = 0;
  const weights = ENCOUNTER_ARCHETYPES.map((a) => {
    const w = Math.max(0.05, a.weight(lat, lon));
    total += w;
    return w;
  });
  let r = rand() * total;
  for (let i = 0; i < ENCOUNTER_ARCHETYPES.length; i++) {
    r -= weights[i];
    if (r <= 0) return ENCOUNTER_ARCHETYPES[i];
  }
  return ENCOUNTER_ARCHETYPES[0];
}

export function describeEncounterThroughSpyglass(enc, targetVessel = null) {
  if (!enc) return 'Horizon clear through the glass.';
  enc.spyglassInspected = true;
  if (enc.disguised) {
    enc.apparentHostile = enc.actuallyHostile;
  }
  const tb = targetVessel?.boat ?? targetVessel ?? null;
  const crewCount = targetVessel?.company?.members?.length ?? tb?.crewCompany?.members?.length ?? (enc.actuallyHostile ? 24 : 18);
  const hullPct = Math.round(((tb?.damage?.hullIntegrity ?? 1) || 1) * 100);
  const gunCount = tb?.gunnery?.guns?.length ?? 4;
  if (enc.disguised) {
    return `Through the brass spyglass from the crow's nest: "${enc.shipName}" (${enc.archetype.rig}, bearing ${enc.bearingPoint}) is a disguised ${enc.archetype.title}! Beneath her worn merchant canvas you spot ${gunCount} run-out cannon and ~${crewCount} corsairs in brown & black jerkins crouched along the bulwarks (${hullPct}% hull, making ~${enc.speedKts} kts).`;
  }
  if (enc.actuallyHostile) {
    return `Through the spyglass from the crow's nest: "${enc.shipName}" — ${enc.archetype.title} (${enc.archetype.rig}, bearing ${enc.bearingPoint}). Flying ${enc.flag}, ${gunCount} guns run out, ~${crewCount} hands in brown & black fighting gear on deck (${hullPct}% hull, ~${enc.speedKts} kts).`;
  }
  if (enc.distressed) {
    return `Through the spyglass from the crow's nest: "${enc.shipName}" — ${enc.archetype.title} (${enc.archetype.rig}, bearing ${enc.bearingPoint}). Sprung fore-topmast, ~${crewCount} weary hands signalling from the quarterdeck (${hullPct}% hull, ~${enc.speedKts} kts).`;
  }
  return `Through the spyglass from the crow's nest: "${enc.shipName}" — ${enc.archetype.title} (${enc.archetype.rig}, bearing ${enc.bearingPoint}). Flying ${enc.flag}, ~${crewCount} hands at stations, ${gunCount} broadside pieces (${hullPct}% hull, ~${enc.speedKts} kts).`;
}

export function createEncounterDirector({ seed = 0x1550cafe } = {}) {
  const rand = mulberry32(seed);
  const state = {
    active: null,
    nextWhaleCheckHrs: 8.0 + rand() * 10.0,
    nextSailCheckHrs: 18.0 + rand() * 18.0,
    elapsedVoyageHrs: 0,
    realCooldownSec: 0,
    totalWhales: 0,
    totalSails: 0,
  };

  function spawnWhaleEncounter(voyage, boat, env = {}) {
    const relDeg = (rand() - 0.5) * 130;
    const callout = relativeBearingCall(relDeg);
    const distYards = Math.round(140 + rand() * 260);
    state.totalWhales += 1;

    // Trigger the live 3D humpback whale breach/blow near the player's hull
    try {
      env.marineLife?.state?.trigger?.(boat, {
        terrain: env.terrain ?? null,
        vessels: env.vessels ?? [],
      });
    } catch {
      /* ignore headless test environment */
    }

    const msg = `¡Ballena! Whale spout ${callout} (~${distYards} yds).`;
    addLog(voyage, msg, 'whale');
    addMark(voyage, { kind: 'whale', lat: voyage.dr.lat, lon: voyage.dr.lon, label: 'Whale sighted' });
    env.onToast?.(msg, 7);
    return {
      kind: 'whale',
      message: msg,
      relBearingDeg: relDeg,
    };
  }

  function spawnSailEncounter(voyage, boat, env = {}) {
    const { lat, lon } = voyage.true;
    const arch = pickEncounterArchetype(lat, lon, rand);
    const shipName = arch.names[Math.floor(rand() * arch.names.length)];
    const relSide = rand() < 0.5 ? -1 : 1;
    const relDeg = relSide * (15 + rand() * 65);
    const bearingDeg = encounterWrap360((boat?.heading ?? 0) + relDeg);
    const compassBrg = encounterWrap360(bearingDeg - (voyage.variation ?? 0));
    const callout = relativeBearingCall(relDeg);
    const distNm = +(3.2 + rand() * 2.8).toFixed(1);
    const disguised = Boolean(arch.hostile && rand() < (arch.disguisedChance ?? 0));

    state.totalSails += 1;
    const enc = {
      id: `sail-${state.totalSails}`,
      kind: 'sail',
      archetype: arch,
      shipName,
      flag: disguised ? 'Unidentified merchant colors (suspicious trim)' : arch.flag,
      colors: disguised ? 'castile' : (arch.colors ?? 'castile'),
      battleColors: arch.battleColors ?? arch.colors ?? 'jolly-roger',
      apparentHostile: arch.hostile && !disguised,
      actuallyHostile: Boolean(arch.hostile),
      disguised,
      distressed: Boolean(arch.distressed),
      relBearingDeg: relDeg,
      bearingDeg,
      compassBearingDeg: compassBrg,
      bearingPoint: compassPointName(compassBrg),
      distanceNm: distNm,
      speedKts: arch.speedKts,
      callout,
      title: `¡Vela! Sail ho! ${callout}`,
      text: `The masthead lookout sings out: "Sail ${callout}!" A ${arch.rig} (${distNm} nm off, bearing ${compassPointName(compassBrg)} by the compass) — ${
        disguised
          ? 'flying worn merchant colors, though her ports sit low and weatherly'
          : arch.hostile
          ? `${arch.title} standing down upon us`
          : `${arch.title} (${arch.flag})`
      }. What are your orders?`,
    };
    state.active = enc;
    env.onSightVessel?.(enc);
    addMark(voyage, { kind: 'sail', lat: voyage.dr.lat, lon: voyage.dr.lon, label: `Sail (${arch.title})` });
    raiseInterrupt(
      voyage,
      {
        type: 'sail',
        title: enc.title,
        text: enc.text,
        encounter: enc,
        choices: [
          { id: 'spyglass', label: "🔭 Crow's Nest & Spyglass" },
          { id: 'fight', label: '⚔️ Clear for action!' },
          { id: 'board', label: '🪝 Grapple & board her!' },
          { id: 'hail', label: '🎺 Close to hail' },
          { id: 'hold', label: 'Hold course' },
          { id: 'avoid', label: 'Bear away to avoid' },
        ],
        log: `Sail sighted ${callout} (${arch.rig}, ${distNm} nm, bearing ${compassPointName(compassBrg)}).`,
      },
      'watch'
    );
    env.onInterrupt?.(voyage.interrupt);
    return enc;
  }

  function step(voyage, boat, dtRealSec, env = {}) {
    if (!voyage || !Number.isFinite(dtRealSec) || dtRealSec <= 0) return null;
    if (state.active || voyage.interrupt) return null;
    if (Number.isFinite(env.coastKm) && env.coastKm < 12) return null;

    const rate = voyage.rate ?? 1;
    const dHrs = (dtRealSec * rate) / 3600;
    state.elapsedVoyageHrs += dHrs;
    if (state.realCooldownSec > 0) state.realCooldownSec = Math.max(0, state.realCooldownSec - dtRealSec);

    if (state.elapsedVoyageHrs >= state.nextWhaleCheckHrs) {
      state.nextWhaleCheckHrs = state.elapsedVoyageHrs + 10.0 + rand() * 14.0;
      const absLat = Math.abs(voyage.true.lat);
      const whaleProb = absLat > 35 ? 0.55 : 0.35;
      if (rand() < whaleProb) {
        return spawnWhaleEncounter(voyage, boat, env);
      }
    }

    if (state.elapsedVoyageHrs >= state.nextSailCheckHrs && state.realCooldownSec <= 0) {
      state.nextSailCheckHrs = state.elapsedVoyageHrs + 18.0 + rand() * 24.0;
      const sailProb = 0.65;
      if (rand() < sailProb) {
        state.realCooldownSec = 25;
        return spawnSailEncounter(voyage, boat, env);
      }
    }

    return null;
  }

  function resolveDecision(choiceId, voyage, boat, helmsman, env = {}) {
    const enc = state.active ?? voyage?.interrupt?.encounter;
    state.active = null;
    if (!enc) return null;

    const shipSpeedKts = Math.hypot(boat?.surgeVelocity ?? 3.0, boat?.leewayVelocity ?? 0) * 1.943844;
    const outcome = { choice: choiceId, encounter: enc, summary: '', combatStarted: false };

    if (choiceId === 'avoid') {
      const turnDir = enc.relBearingDeg >= 0 ? -1 : 1;
      const currentCompass = encounterWrap360((boat?.heading ?? 0) - (voyage.variation ?? 0));
      const nextCompass = encounterWrap360(currentCompass + turnDir * 33.75);
      env.onOrderCompassCourse?.(nextCompass);
      const escapeChance = enc.actuallyHostile
        ? Math.max(0.25, Math.min(0.92, 0.58 + (shipSpeedKts - enc.speedKts) * 0.08))
        : 0.98;
      if (rand() < escapeChance) {
        outcome.summary = `Bore away to ${compassPointName(nextCompass)}. The ${enc.archetype.rig} dropped hull-down astern.`;
        addLog(voyage, outcome.summary, 'encounter');
      } else {
        outcome.summary = `${enc.shipName} (${enc.archetype.title}) holds the weather gauge and is overhauling us — clear for action!`;
        outcome.combatStarted = true;
        addLog(voyage, outcome.summary, 'combat');
        env.onEngageVessel?.(enc);
      }
      env.onToast?.(outcome.summary, 7);
      return outcome;
    }

    if (choiceId === 'hold') {
      if (enc.actuallyHostile && rand() < 0.75) {
        outcome.summary = `${enc.shipName} hoists French privateer colors and alters course to intercept — beat to quarters!`;
        outcome.combatStarted = true;
        addLog(voyage, outcome.summary, 'combat');
        env.onEngageVessel?.(enc);
      } else {
        outcome.summary = `Held course past ${enc.shipName}; exchanged flag salutes at ${enc.distanceNm} nm.`;
        addLog(voyage, outcome.summary, 'encounter');
      }
      env.onToast?.(outcome.summary, 6);
      return outcome;
    }

    if (choiceId === 'hail') {
      if (enc.actuallyHostile) {
        outcome.summary = `Treachery! As we closed to hail, ${enc.shipName} ran out her battery and opened fire!`;
        outcome.combatStarted = true;
        addLog(voyage, outcome.summary, 'combat');
        env.onEngageVessel?.(enc);
        env.onToast?.(outcome.summary, 8);
        return outcome;
      }

      // Friendly / neutral hail: compare pilot's reckoning!
      voyage.dr.lat = voyage.dr.lat * 0.35 + voyage.true.lat * 0.65;
      voyage.dr.lon = voyage.dr.lon * 0.35 + voyage.true.lon * 0.65;
      voyage.latUncNm = Math.max(2, voyage.latUncNm * 0.5);
      voyage.lonUncNm = Math.max(5, voyage.lonUncNm * 0.42);
      voyage.fixes.push({
        kind: 'hail',
        lat: voyage.dr.lat,
        lon: voyage.dr.lon,
        dateMs: voyage.dateMs,
        label: `Spoke ${enc.shipName}`,
      });

      const posStr = `${formatLatitude(voyage.dr.lat)}, ${formatLongitude(voyage.dr.lon)}`;
      if (enc.distressed) {
        voyage.provisions.water = Math.max(1, voyage.provisions.water - 1.5);
        voyage.morale = Math.min(1, voyage.morale + 0.08);
        outcome.summary = `Spoke the distressed caravel ${enc.shipName}; shared a cask of water and compared pilot charts (${posStr}).`;
      } else {
        voyage.provisions.water = Math.min(90, voyage.provisions.water + 2.5);
        voyage.provisions.food = Math.min(120, voyage.provisions.food + 2.5);
        voyage.morale = Math.min(1, voyage.morale + 0.04);
        outcome.summary = `Hailed ${enc.shipName} (${enc.archetype.title}) within speaking-trumpet range. Compared pilot reckoning (${posStr}) and traded fresh casks.`;
      }
      outcome.hailed = true;
      addLog(voyage, outcome.summary, 'hail');
      env.onHailVessel?.(enc);
      env.onToast?.(outcome.summary, 8);
      return outcome;
    }

    if (choiceId === 'fight') {
      env.onOrderCompassCourse?.(enc.compassBearingDeg);
      outcome.summary = `Beat to quarters! Steering ${enc.bearingPoint} to intercept ${enc.shipName} (${enc.archetype.title}) and close to cannon range!`;
      outcome.combatStarted = true;
      addLog(voyage, outcome.summary, 'combat');
      env.onEngageVessel?.(enc, { mode: 'fight' });
      env.onToast?.(outcome.summary, 7);
      return outcome;
    }

    if (choiceId === 'board') {
      env.onOrderCompassCourse?.(enc.compassBearingDeg);
      outcome.summary = `Grappling irons & boarding pikes ready! Steering ${enc.bearingPoint} to close and lay ${enc.shipName} (${enc.archetype.title}) aboard!`;
      outcome.combatStarted = true;
      outcome.boarded = true;
      addLog(voyage, outcome.summary, 'combat');
      if (env.onBoardVessel) env.onBoardVessel(enc);
      else env.onEngageVessel?.(enc, { board: true, mode: 'board' });
      env.onToast?.(outcome.summary, 8);
      return outcome;
    }

    return outcome;
  }

  return {
    state,
    step,
    spawnWhaleEncounter,
    spawnSailEncounter,
    resolveDecision,
  };
}

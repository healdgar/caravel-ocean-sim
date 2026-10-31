// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
//
// Rogue Liberator & Sovereign Indigenous Polity System (1492–1689):
// Models the alternate-history gameplay path where the captain breaks with the
// European colonial crowns ("going rogue"), trades fairly with Native American
// settlements, shares epidemic quarantine & apothecary knowledge, arms and
// fortifies coastal villages with captured cannon and iron, repels European
// conquistador / slaver / colonial expeditions, and elevates Indigenous nations
// into persistent, sovereign political units independent of European colonizers.

export const SOVEREIGNTY_STORAGE_KEY = 'waterworld.indigenousSovereignty.v1';

export const SOVEREIGN_INDIGENOUS_POLITIES = Object.freeze({
  'abenaki-algonquian': Object.freeze({
    id: 'wabanaki-confederacy',
    cultureId: 'abenaki-algonquian',
    polityName: 'Wabanaki & Dawnland Algonquian Confederacy',
    shortName: 'Wabanaki Confederacy',
    capitalLabel: 'Mawooshen & Shawmut Grand Council',
    leaderTitle: 'Grand Sachem / Sagamore Council',
    bannerColors: 'indigenous-confederacy',
    tradeGoods: ['cured beaver & otter pelts', 'smoked Atlantic cod & salmon', 'Three Sisters maize & maple stores', 'birchbark & white-pine spars'],
    defenseDoctrine: 'Palisaded river-mouth bastions, captured bronze culverins, and swift Dawnland war-canoe flotillas',
  }),
  'mid-atlantic-algonquian': Object.freeze({
    id: 'tsenacommacah-league',
    cultureId: 'mid-atlantic-algonquian',
    polityName: 'Sovereign Tsenacommacah & Lenapehoking League',
    shortName: 'Tsenacommacah League',
    capitalLabel: 'Werowocomoco & Lenapehoking Council',
    leaderTitle: 'Mamanatowick & Sachem Council',
    bannerColors: 'indigenous-confederacy',
    tradeGoods: ['cured tidewater maize & beans', 'smoked sturgeon & roasted oysters', 'dressed deerskin & copper gorgets', 'seasoned live-oak ship timber'],
    defenseDoctrine: 'Triple-ringed palisade forts, tidal channel stakes, and captured coastal artillery',
  }),
  'florida-gulf-chiefdoms': Object.freeze({
    id: 'calusa-timucua-paramountcy',
    cultureId: 'florida-gulf-chiefdoms',
    polityName: 'Calusa & Timucua Maritime Paramountcy',
    shortName: 'Calusa Paramountcy',
    capitalLabel: 'Calos Shell-Mound Citadel',
    leaderTitle: 'Paramount Cacique Carlos',
    bannerColors: 'indigenous-confederacy',
    tradeGoods: ['salvaged plate-fleet silver & ambergris', 'dried mullet & sea-turtle stores', 'yaupon cassina tea & palm cordage', 'cypress dugout timbers'],
    defenseDoctrine: 'High shell-mound gun platforms, mangrove ambush channels, and twin-hulled war-canoes',
  }),
  'taino-greater-antilles': Object.freeze({
    id: 'taino-cacicazgo-federation',
    cultureId: 'taino-greater-antilles',
    polityName: 'Sovereign Taíno Cacicazgo Federation',
    shortName: 'Taíno Federation',
    capitalLabel: 'Confederación de Xaraguá, Maguana & Borikén',
    leaderTitle: 'Guamiquina (Supreme Cacique Council)',
    bannerColors: 'indigenous-confederacy',
    tradeGoods: ['lasting cassava cazabe bread', 'woven cotton hamacas & sailcloth', 'alluvial guanín gold & carved zemís', 'guaiacum medicinal lignum-vitae bark'],
    defenseDoctrine: 'Fortified headland batey citadels, captured Spanish lombards, and 80-man royal kanawa squadrons',
  }),
  'kalinago-lesser-antilles': Object.freeze({
    id: 'kalinago-waitukubuli-league',
    cultureId: 'kalinago-lesser-antilles',
    polityName: 'Kalinago Waitukubuli Maritime League',
    shortName: 'Kalinago League',
    capitalLabel: 'Waitukubuli & Hairoun Carbet Council',
    leaderTitle: 'Ouboutou (Grand War Chief)',
    bannerColors: 'indigenous-confederacy',
    tradeGoods: ['cassava bread & smoked fish', 'woven cotton & annatto dye', 'mountain spring water & tropical fruit', 'ironwood bow-staves & cordage'],
    defenseDoctrine: 'Volcanic headland batteries, reef-channel ambushes, and ocean-going kanawa raiders',
  }),
  'maya-mesoamerica-coast': Object.freeze({
    id: 'maritime-maya-league',
    cultureId: 'maya-mesoamerica-coast',
    polityName: 'Maritime Maya League of Ecab, Cozumel & Chakán Putum',
    shortName: 'Maritime Maya League',
    capitalLabel: 'Zama (Tulum) & Champotón Port Council',
    leaderTitle: 'Halach Uinic & Batab Council',
    bannerColors: 'indigenous-confederacy',
    tradeGoods: ['Yucatán sea salt & melipona honey', 'woven cotton mantas & cacao beans', 'copal incense & obsidian blades', 'cured venison & maize'],
    defenseDoctrine: 'Whitewashed limestone sea-walls, coastal watch-shrine batteries, and armed trading canoes',
  }),
  'tierra-firme-carib-arawak': Object.freeze({
    id: 'dulegaya-coquivacoa-federation',
    cultureId: 'tierra-firme-carib-arawak',
    polityName: 'Sovereign Dulegaya & Coquivacoa Federation',
    shortName: 'Dulegaya–Coquivacoa Federation',
    capitalLabel: 'Darién, Guajira & Orinoco Council',
    leaderTitle: 'Sailas & Cacique Council',
    bannerColors: 'indigenous-confederacy',
    tradeGoods: ['Margarita & Guajira pearls', 'smoked river fish & cassava', 'pitch-caulking bitumen & hardwood', 'cacao & medicinal cinchona bark'],
    defenseDoctrine: 'Estuary stilt-forts, shoal-draft piraguas, and captured brass swivel guns',
  }),
  'tupinamba-brazil-guiana': Object.freeze({
    id: 'confederacao-dos-tamoios',
    cultureId: 'tupinamba-brazil-guiana',
    polityName: 'Confederação dos Tamoios & Potiguara',
    shortName: 'Confederação dos Tamoios',
    capitalLabel: 'Guanabara & Cabo Frio Caiçara Council',
    leaderTitle: 'Morubixaba & Pajé Council',
    bannerColors: 'indigenous-confederacy',
    tradeGoods: ['brazilwood dyewood & manioc flour', 'cured tapir & sea-fish', 'cotton hammocks & macaw plumes', 'fresh water & tropical citrus'],
    defenseDoctrine: 'Double-palisaded caiçara fortresses armed with culverins and 60-paddle war igaras',
  }),
  'pacific-indigenous-coast': Object.freeze({
    id: 'biru-araucanian-league',
    cultureId: 'pacific-indigenous-coast',
    polityName: 'Sovereign Birú & Mapuche Littoral League',
    shortName: 'Birú–Mapuche League',
    capitalLabel: 'Tumbes & Arauco Maritime Council',
    leaderTitle: 'Curaca & Toki Council',
    bannerColors: 'indigenous-confederacy',
    tradeGoods: ['quinoa, maize & charqui', 'fine camelid textiles & silverwork', 'balsa & cedar spars', 'fresh Andean spring water'],
    defenseDoctrine: 'Coastal pukara stone redoubts, captured artillery, and ocean-going balsa rafts',
  }),
});

function sovClamp(x, a, b) {
  return x < a ? a : x > b ? b : x;
}

export function createIndigenousRegionRecord(cultureId = 'taino-greater-antilles', overrides = {}) {
  const polity = SOVEREIGN_INDIGENOUS_POLITIES[cultureId] ?? SOVEREIGN_INDIGENOUS_POLITIES['taino-greater-antilles'];
  const rec = {
    cultureId: polity.cultureId,
    polityId: polity.id,
    polityName: polity.polityName,
    shortName: polity.shortName,
    tradeCount: Number(overrides.tradeCount) || 0,
    armsCount: Number(overrides.armsCount) || 0,
    suppliedCannon: Number(overrides.suppliedCannon) || 0,
    suppliedShips: Number(overrides.suppliedShips) || 0,
    repelledExpeditions: Number(overrides.repelledExpeditions) || 0,
    medicalQuarantine: Boolean(overrides.medicalQuarantine),
    fortified: Boolean(overrides.fortified),
    proclaimedSovereign: Boolean(overrides.proclaimedSovereign),
    bonusStrength: Number(overrides.bonusStrength) || 0,
  };
  return recomputeRegionSovereigntyMetrics(rec);
}

export function recomputeRegionSovereigntyMetrics(rec) {
  if (!rec) return null;
  const polity = SOVEREIGN_INDIGENOUS_POLITIES[rec.cultureId] ?? SOVEREIGN_INDIGENOUS_POLITIES['taino-greater-antilles'];
  const rawStrength =
    (rec.tradeCount ?? 0) * 0.16 +
    (rec.armsCount ?? 0) * 0.26 +
    (rec.suppliedCannon ?? 0) * 0.06 +
    (rec.suppliedShips ?? 0) * 0.28 +
    (rec.repelledExpeditions ?? 0) * 0.30 +
    (rec.medicalQuarantine ? 0.24 : 0) +
    (rec.fortified ? 0.18 : 0) +
    (rec.proclaimedSovereign ? 0.35 : 0) +
    (rec.bonusStrength ?? 0);

  rec.strengthScore = Number(sovClamp(rawStrength, 0, 1.25).toFixed(3));
  if (rec.proclaimedSovereign || rec.strengthScore >= 0.78) {
    rec.polityTier = 'sovereign-polity';
    rec.polityTierLabel = 'Sovereign Indigenous Polity';
    rec.isSovereignPolity = true;
    rec.resistsColonization = true;
  } else if (rec.strengthScore >= 0.45 || rec.fortified || (rec.repelledExpeditions ?? 0) >= 1) {
    rec.polityTier = 'fortified-federation';
    rec.polityTierLabel = 'Fortified Indigenous Federation';
    rec.isSovereignPolity = false;
    rec.resistsColonization = rec.strengthScore >= 0.52;
  } else if (rec.strengthScore >= 0.15 || (rec.tradeCount ?? 0) >= 1) {
    rec.polityTier = 'trading-partner';
    rec.polityTierLabel = 'Allied Trading Settlement';
    rec.isSovereignPolity = false;
    rec.resistsColonization = false;
  } else {
    rec.polityTier = 'traditional';
    rec.polityTierLabel = 'Traditional Indigenous Settlement';
    rec.isSovereignPolity = false;
    rec.resistsColonization = false;
  }
  rec.polityName = polity.polityName;
  rec.shortName = polity.shortName;
  rec.leaderTitle = polity.leaderTitle;
  rec.capitalLabel = polity.capitalLabel;
  rec.bannerColors = polity.bannerColors;
  return rec;
}

export function createIndigenousSovereigntyState(initial = {}) {
  const regions = {};
  for (const cultureId of Object.keys(SOVEREIGN_INDIGENOUS_POLITIES)) {
    regions[cultureId] = createIndigenousRegionRecord(cultureId, initial?.regions?.[cultureId] ?? {});
  }
  return {
    version: 1,
    allegiance: initial.allegiance === 'rogue-liberator' ? 'rogue-liberator' : 'crown',
    rogueDeclaredYear: initial.rogueDeclaredYear ?? null,
    treatiesSigned: Number(initial.treatiesSigned) || 0,
    totalTrades: Number(initial.totalTrades) || 0,
    totalColonizersRepelled: Number(initial.totalColonizersRepelled) || 0,
    regions,
  };
}

let activeSovereigntyState = createIndigenousSovereigntyState();

export function getActiveIndigenousSovereigntyState() {
  return activeSovereigntyState;
}

export function setActiveIndigenousSovereigntyState(nextState, { persist = false, storage = undefined } = {}) {
  activeSovereigntyState = nextState && nextState.regions
    ? createIndigenousSovereigntyState(nextState)
    : createIndigenousSovereigntyState();
  if (persist) {
    saveIndigenousSovereigntyToStorage(activeSovereigntyState, storage);
  }
  return activeSovereigntyState;
}

export function resetActiveIndigenousSovereigntyState({ persist = false, storage = undefined } = {}) {
  activeSovereigntyState = createIndigenousSovereigntyState();
  if (persist) {
    const store = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
    try { store?.removeItem?.(SOVEREIGNTY_STORAGE_KEY); } catch { /* ignore */ }
  }
  return activeSovereigntyState;
}

export function saveIndigenousSovereigntyToStorage(state = activeSovereigntyState, storage = undefined) {
  const store = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
  if (!store || !state) return false;
  try {
    store.setItem(SOVEREIGNTY_STORAGE_KEY, JSON.stringify(serializeIndigenousSovereignty(state)));
    return true;
  } catch {
    return false;
  }
}

export function loadIndigenousSovereigntyFromStorage(storage = undefined) {
  const store = storage ?? (typeof localStorage !== 'undefined' ? localStorage : null);
  if (!store) return null;
  try {
    const raw = store.getItem(SOVEREIGNTY_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    const restored = restoreIndigenousSovereignty(parsed);
    if (restored) activeSovereigntyState = restored;
    return restored;
  } catch {
    return null;
  }
}

export function serializeIndigenousSovereignty(state = activeSovereigntyState) {
  if (!state) return null;
  const compactRegions = {};
  for (const [cultureId, rec] of Object.entries(state.regions ?? {})) {
    if (
      (rec.strengthScore ?? 0) > 0 ||
      rec.tradeCount > 0 ||
      rec.armsCount > 0 ||
      rec.repelledExpeditions > 0 ||
      rec.medicalQuarantine ||
      rec.fortified ||
      rec.proclaimedSovereign
    ) {
      compactRegions[cultureId] = {
        tradeCount: rec.tradeCount,
        armsCount: rec.armsCount,
        suppliedCannon: rec.suppliedCannon,
        suppliedShips: rec.suppliedShips,
        repelledExpeditions: rec.repelledExpeditions,
        medicalQuarantine: rec.medicalQuarantine,
        fortified: rec.fortified,
        proclaimedSovereign: rec.proclaimedSovereign,
        bonusStrength: rec.bonusStrength,
      };
    }
  }
  return {
    v: 1,
    allegiance: state.allegiance ?? 'crown',
    rogueDeclaredYear: state.rogueDeclaredYear ?? null,
    treatiesSigned: state.treatiesSigned ?? 0,
    totalTrades: state.totalTrades ?? 0,
    totalColonizersRepelled: state.totalColonizersRepelled ?? 0,
    regions: compactRegions,
  };
}

export function restoreIndigenousSovereignty(data) {
  if (!data || typeof data !== 'object') return null;
  return createIndigenousSovereigntyState({
    allegiance: data.allegiance,
    rogueDeclaredYear: data.rogueDeclaredYear,
    treatiesSigned: data.treatiesSigned,
    totalTrades: data.totalTrades,
    totalColonizersRepelled: data.totalColonizersRepelled,
    regions: data.regions ?? {},
  });
}

export function resolveRegionSovereigntyRecord(cultureId, specOrState = null) {
  if (!cultureId || !SOVEREIGN_INDIGENOUS_POLITIES[cultureId]) return null;
  // Explicit override on specOrRegion takes priority over global active state
  if (specOrState && typeof specOrState === 'object') {
    const explicit = specOrState.indigenousSovereignty ?? (specOrState.regions ? specOrState : null);
    if (explicit) {
      if (explicit.regions?.[cultureId]) {
        return recomputeRegionSovereigntyMetrics({
          ...createIndigenousRegionRecord(cultureId, explicit.regions[cultureId]),
          allegiance: explicit.allegiance ?? activeSovereigntyState.allegiance,
        });
      }
      if (explicit.cultureId === cultureId || (!explicit.regions && (explicit.strengthScore !== undefined || explicit.isSovereignPolity !== undefined || explicit.tradeCount !== undefined || explicit.fortified !== undefined || explicit.proclaimedSovereign !== undefined))) {
        return recomputeRegionSovereigntyMetrics({
          ...createIndigenousRegionRecord(cultureId, explicit),
          ...(explicit.strengthScore !== undefined ? { bonusStrength: explicit.strengthScore } : {}),
          allegiance: explicit.allegiance ?? activeSovereigntyState.allegiance,
        });
      }
    }
  }
  const base = activeSovereigntyState?.regions?.[cultureId] ?? createIndigenousRegionRecord(cultureId);
  return recomputeRegionSovereigntyMetrics({
    ...base,
    allegiance: activeSovereigntyState?.allegiance ?? 'crown',
  });
}

/**
 * Execute a player action supporting/defending a Native American settlement or culture region.
 * Actions:
 *  - 'go-rogue': Break with European colonizers, hoist Sovereign Indigenous Confederacy banner, sign Wampum/Guanín treaty
 *  - 'trade': Fair barter (tools & charts for cassava, maize, smoked fish, fresh water)
 *  - 'share-medicine': Establish epidemic quarantine & apothecary exchange (prevents virgin-soil epidemic collapse)
 *  - 'arm-settlement': Deliver cannon, powder, and forged iron weapons; erects palisade & coastal battery
 *  - 'defend-settlement': Repel a European conquistador / slaver / colonial expedition
 *  - 'gift-prize': Turn over a captured European ship and her artillery to the Indigenous confederacy
 *  - 'proclaim-sovereignty': Formally recognize/elevate the confederacy as a sovereign political unit
 */
export function applyIndigenousSupportAction(
  cultureId,
  actionId,
  {
    state = activeSovereigntyState,
    voyage = null,
    boat = null,
    year = 1550,
    cannonCount = 2,
    persist = false,
  } = {},
) {
  const targetState = state ?? activeSovereigntyState;
  const polity = SOVEREIGN_INDIGENOUS_POLITIES[cultureId] ?? SOVEREIGN_INDIGENOUS_POLITIES['taino-greater-antilles'];
  const rec = targetState.regions[polity.cultureId] ?? createIndigenousRegionRecord(polity.cultureId);
  targetState.regions[polity.cultureId] = rec;

  let summary = '';
  let foodGained = 0;
  let waterGained = 0;
  let moraleDelta = 0;
  let colorsChangedTo = null;

  if (actionId === 'go-rogue') {
    targetState.allegiance = 'rogue-liberator';
    targetState.rogueDeclaredYear ??= year;
    targetState.treatiesSigned = (targetState.treatiesSigned ?? 0) + 1;
    rec.bonusStrength = (rec.bonusStrength ?? 0) + 0.25;
    colorsChangedTo = 'indigenous-confederacy';
    if (boat) boat.colors = 'indigenous-confederacy';
    moraleDelta = 0.08;
    summary = `Renounced European colonial commission and swore a Treaty of Alliance with the ${polity.polityName}! Hoisted the Sovereign Confederacy banner.`;
  } else if (actionId === 'trade') {
    rec.tradeCount = (rec.tradeCount ?? 0) + 1;
    targetState.totalTrades = (targetState.totalTrades ?? 0) + 1;
    foodGained = 14;
    waterGained = 14;
    moraleDelta = 0.06;
    const good = polity.tradeGoods[(rec.tradeCount - 1) % polity.tradeGoods.length];
    summary = `Traded fairly with the ${polity.shortName}: bartered iron tools & cordage for ${good} (+${foodGained} d food, +${waterGained} d water). Village prosperity & resilience strengthened!`;
  } else if (actionId === 'share-medicine') {
    rec.medicalQuarantine = true;
    rec.bonusStrength = (rec.bonusStrength ?? 0) + 0.14;
    moraleDelta = 0.05;
    summary = `Established quarantine protocols and shared apothecary stores with the ${polity.shortName}, shielding coastal villages from Old World virgin-soil epidemics!`;
  } else if (actionId === 'arm-settlement') {
    rec.armsCount = (rec.armsCount ?? 0) + 1;
    rec.suppliedCannon = (rec.suppliedCannon ?? 0) + Math.max(1, cannonCount);
    rec.fortified = true;
    moraleDelta = 0.07;
    summary = `Supplied forged iron weapons, powder, and ${Math.max(1, cannonCount)} cannon to the ${polity.shortName}! The settlement has erected timber palisades and a shore battery to repel European colonizers.`;
  } else if (actionId === 'defend-settlement') {
    targetState.allegiance = 'rogue-liberator';
    targetState.rogueDeclaredYear ??= year;
    targetState.totalColonizersRepelled = (targetState.totalColonizersRepelled ?? 0) + 1;
    rec.repelledExpeditions = (rec.repelledExpeditions ?? 0) + 1;
    rec.fortified = true;
    colorsChangedTo = 'indigenous-confederacy';
    if (boat) boat.colors = 'indigenous-confederacy';
    foodGained = 8;
    waterGained = 8;
    moraleDelta = 0.10;
    summary = `Defended the ${polity.shortName} against a European colonial raiding squadron! Captured ordnance delivered to shore defenders (+${foodGained} d provisions gifted in gratitude).`;
  } else if (actionId === 'gift-prize') {
    targetState.allegiance = 'rogue-liberator';
    rec.suppliedShips = (rec.suppliedShips ?? 0) + 1;
    rec.armsCount = (rec.armsCount ?? 0) + 1;
    rec.suppliedCannon = (rec.suppliedCannon ?? 0) + Math.max(2, cannonCount);
    rec.fortified = true;
    foodGained = 12;
    waterGained = 12;
    moraleDelta = 0.09;
    summary = `Turned the captured prize and her ${Math.max(2, cannonCount)} cannon over to the ${polity.polityName}! Indigenous mariners & artillerists now man her to guard the coast (+${foodGained} d fresh stores gifted).`;
  } else if (actionId === 'proclaim-sovereignty') {
    targetState.allegiance = 'rogue-liberator';
    rec.proclaimedSovereign = true;
    rec.fortified = true;
    rec.medicalQuarantine = true;
    rec.bonusStrength = Math.max(rec.bonusStrength ?? 0, 0.35);
    colorsChangedTo = 'indigenous-confederacy';
    if (boat) boat.colors = 'indigenous-confederacy';
    moraleDelta = 0.12;
    summary = `Proclaimed the ${polity.polityName} (${polity.capitalLabel}) as a Sovereign Political Unit independent of all European colonizers!`;
  }

  recomputeRegionSovereigntyMetrics(rec);

  if (voyage) {
    if (voyage.provisions) {
      if (foodGained > 0) voyage.provisions.food = Math.min(140, (voyage.provisions.food ?? 45) + foodGained);
      if (waterGained > 0) voyage.provisions.water = Math.min(110, (voyage.provisions.water ?? 40) + waterGained);
    }
    if (moraleDelta > 0) {
      voyage.morale = sovClamp((voyage.morale ?? 0.85) + moraleDelta, 0, 1);
    }
    voyage.indigenousSovereignty = serializeIndigenousSovereignty(targetState);
  }
  if (boat && foodGained > 0) {
    boat.provisionDays = Math.min(140, (boat.provisionDays ?? 60) + Math.round((foodGained + waterGained) * 0.5));
  }
  if (persist) {
    saveIndigenousSovereigntyToStorage(targetState);
  }

  return {
    ok: true,
    actionId,
    cultureId: polity.cultureId,
    polity,
    record: rec,
    allegiance: targetState.allegiance,
    colorsChangedTo,
    foodGained,
    waterGained,
    summary,
  };
}

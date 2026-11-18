// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The colours a ship wears and the acts of wearing them. Her ensign and masthead pennant are cloth of her assembly
// (js/vessel-detail.js), flown in her pose pass and woven by her hull shader (js/wgsl/ship-colours.js) by `code`.

// Historically grounded 16th-century & Age-of-Sail naval ensigns ("ship's colors").
export const SHIP_COLORS = Object.freeze({
  portugal: Object.freeze({
    id: 'portugal',
    code: 1,
    name: 'Kingdom of Portugal (Quinas & Cross of Christ)',
    shortLabel: 'Portugal 🇵🇹',
    faction: 'portuguese',
    isHostile: false,
    isSurrender: false,
    description: 'Royal white field bearing the crimson Order of Christ cross and the five blue escutcheons (quinas) of Lisbon.',
  }),
  castile: Object.freeze({
    id: 'castile',
    code: 2,
    name: 'Crown of Castile (Cross of Burgundy)',
    shortLabel: 'Castile / Spain 🇪🇸',
    faction: 'spanish',
    isHostile: false,
    isSurrender: false,
    description: 'White naval ensign with the crimson ragged saltire of Saint Andrew (Cruz de Borgoña) flown by Spanish naos.',
  }),
  france: Object.freeze({
    id: 'france',
    code: 3,
    name: 'Kingdom of France (Pavillon Royal / Huguenot)',
    shortLabel: 'France 🇫🇷',
    faction: 'french',
    isHostile: false,
    isSurrender: false,
    description: 'Maritime blue field quartered by a white cross with gold fleurs-de-lis flown by Norman and La Rochelle vessels.',
  }),
  basque: Object.freeze({
    id: 'basque',
    code: 4,
    name: 'Señorío de Vizcaya (Biscayan Merchant Colors)',
    shortLabel: 'Vizcaya / Basque',
    faction: 'basque',
    isHostile: false,
    isSurrender: false,
    description: 'Crimson and white merchant ensign of Bilbao and San Sebastián iron-and-wool traders.',
  }),
  england: Object.freeze({
    id: 'england',
    code: 5,
    name: 'Kingdom of England (Tudor St. George Cross)',
    shortLabel: 'England 🏴󠁧󠁢󠁥󠁮󠁧󠁿',
    faction: 'english',
    isHostile: false,
    isSurrender: false,
    description: 'White field quartered by the red cross of Saint George.',
  }),
  'jolly-roger': Object.freeze({
    id: 'jolly-roger',
    code: 6,
    name: 'Jolly Roger (Pirate / Sea-Rover Colors)',
    shortLabel: 'Jolly Roger 🏴‍☠️',
    faction: 'pirate',
    isHostile: true,
    isSurrender: false,
    description: 'Black sea-rover ensign bearing a white skull and crossed bones to demand immediate surrender.',
  }),
  'blood-flag': Object.freeze({
    id: 'blood-flag',
    code: 7,
    name: 'Sans Quartier (Red Flag of No Quarter)',
    shortLabel: 'Blood Flag 🚩',
    faction: 'corsair',
    isHostile: true,
    isSurrender: false,
    description: 'Solid crimson battle banner signalling combat to the death without quarter.',
  }),
  surrender: Object.freeze({
    id: 'surrender',
    code: 8,
    name: 'White Flag of Surrender (Struck Colors)',
    shortLabel: 'Surrendered 🏳️',
    faction: 'neutral',
    isHostile: false,
    isSurrender: true,
    description: 'Plain white flag hoisted after striking national colors to signal surrender and ask for quarter.',
  }),
  'indigenous-confederacy': Object.freeze({
    id: 'indigenous-confederacy',
    code: 9,
    name: 'Sovereign Indigenous Confederacy (Wampum & Sun Zemi Banner)',
    shortLabel: 'Indigenous Confederacy ☀️',
    faction: 'indigenous',
    isHostile: false,
    isSurrender: false,
    description: 'Wampum-indigo and terracotta-ochre treaty banner bearing a golden Guanín sun disc and white shell-wampum belt.',
  }),
});

export const DEFAULT_SHIP_COLORS = 'portugal';

export function getShipColorsInfo(colorsId) {
  return SHIP_COLORS[colorsId] ?? SHIP_COLORS[DEFAULT_SHIP_COLORS];
}

export function setVesselColors(boat, colorsId) {
  if (!boat) return getShipColorsInfo(DEFAULT_SHIP_COLORS);
  const info = getShipColorsInfo(colorsId);
  boat.colors = info.id;
  if (info.isSurrender) {
    if (boat.damage) boat.damage.surrendered = true;
  } else if (boat.damage && boat.damage.surrendered && colorsId !== 'surrender') {
    boat.damage.surrendered = false;
    boat.damage.surrenderReason = null;
  }
  return info;
}

export function hoistBattleColors(boat, battleColorsId = 'jolly-roger') {
  if (!boat || boat.damage?.surrendered) return getShipColorsInfo(boat?.colors);
  if (!boat.falseColors && boat.colors && boat.colors !== battleColorsId) {
    boat.falseColors = boat.colors;
  }
  return setVesselColors(boat, battleColorsId);
}

export function strikeVesselColors(boat, reason = 'Struck colors') {
  if (!boat) return null;
  if (boat.colors && boat.colors !== 'surrender') {
    boat.previousColors = boat.colors;
  }
  boat.colors = 'surrender';
  boat.sailSet = 0;
  boat.targetSpeed = 0;
  if (boat.damage) {
    const alreadySurrendered = Boolean(boat.damage.surrendered);
    boat.damage.surrendered = true;
    boat.damage.surrenderReason = reason;
    boat.damage.moraleState = 'broken';
    if (!alreadySurrendered) {
      boat.onSurrender?.(boat, boat.damage, reason);
    }
  }
  return SHIP_COLORS.surrender;
}

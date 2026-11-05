// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The colour of the sea by where you are. Open water is blue almost everywhere: bluest in the clear
// low-latitude gyres, turning greyer and greener at high latitudes. Turquoise belongs only over
// pale shallow sand in clear tropical water, and rivers leave estuaries murky at any latitude.
const SEA_DEEP_TROPICS = [0.0010, 0.0100, 0.0400];
const SEA_DEEP_TEMPERATE = [0.0016, 0.0105, 0.0280];
const SEA_DEEP_HIGH = [0.0030, 0.0120, 0.0160];
const SEA_TEMPERATE_LATITUDE = 38;
const SEA_HIGH_LATITUDE = 62;
const SEA_TROPICS_END = 24;
const SEA_SUBTROPICS_END = 36;
const SEA_CLEAREST_TURBIDITY = 0.3;
const SEA_MURKY_TURBIDITY = 1.5;
const MURKY_COASTS = /estuary|river|harbor-channel/;

const seaMix = (a, b, t) => a.map((v, k) => v + (b[k] - v) * t);
const seaStep = (edge0, edge1, x) => { const t = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0))); return t * t * (3 - 2 * t); };

// Body colour of deep water, before turbidity.
export function deepSeaColour(latitude) {
  const north = Math.abs(latitude);
  if (north <= SEA_TEMPERATE_LATITUDE) return seaMix(SEA_DEEP_TROPICS, SEA_DEEP_TEMPERATE, seaStep(SEA_TROPICS_END, SEA_TEMPERATE_LATITUDE, north));
  return seaMix(SEA_DEEP_TEMPERATE, SEA_DEEP_HIGH, seaStep(SEA_TEMPERATE_LATITUDE, SEA_HIGH_LATITUDE, north));
}
// 1 where shallows run clear over pale sand, 0 where they do not.
export function coastalClarity(latitude, archetype = '') {
  if (MURKY_COASTS.test(archetype)) return 0;
  return 1 - seaStep(SEA_TROPICS_END, SEA_SUBTROPICS_END, Math.abs(latitude));
}
// How much this coast scales how fast water hides what lies under it.
export function coastalTurbidityScale(latitude, archetype = '') {
  if (MURKY_COASTS.test(archetype)) return SEA_MURKY_TURBIDITY;
  return 1 + (SEA_CLEAREST_TURBIDITY - 1) * coastalClarity(latitude, archetype);
}

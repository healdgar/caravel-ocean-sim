// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Symmetric per-family Continuum threshold profiles (AGENTS.md rule 3).
//
// Every family drawn through the one Continuum shares the exact same selection, morph, sample-mask handoff, splat and
// thinning kernel (js/continuum-core.js, js/wgsl/continuum-cut.js), parameterized solely by one uniform profile record
// of seven orthogonal fields defined here in one table so tuning is symmetric and never fragmented across families:
//   errorScale        near-field multiplier on the scene's shared pixel error (< 1 sharper close-up, > 1 softer organic)
//   taperMetres       distance in metres at which allowed pixel error doubles (0 = strictly linear perspective)
//   splatScale        multiplier on the splat handoff span in pixels (1 = standard 3.5..5.25 px)
//   minPixels         projected pixel span below which horizon splats stochastically hash-thin with area inflation
//   maxDistance       world distance in metres where micro-layers smoothly hash-dissolve to 0 (0 = full horizon)
//   shadowMinError    minimum world-space shadow geometric error in metres (0 = shadow-map texel limit)
//   shadowMaxDistance maximum camera distance in metres at which instances cast into shadow maps (0 = shadow-map box)

import { CONTINUUM_DEFAULT_PROFILE, normalizeContinuumProfile } from './continuum-core.js';

export const CONTINUUM_FAMILY_DEFAULTS = Object.freeze({
  ships: normalizeContinuumProfile({
    errorScale: 0.32, taperMetres: 600, taperPower: 1.0, splatScale: 0.75, minPixels: 1.0, maxDistance: 0, shadowMinError: 0.0, shadowMaxDistance: 0,
  }),
  tradeVessels: normalizeContinuumProfile({
    errorScale: 0.30, taperMetres: 600, taperPower: 1.0, splatScale: 5.0, minPixels: 1.0, maxDistance: 0, shadowMinError: 0.02, shadowMaxDistance: 900,
  }),
  people: normalizeContinuumProfile({
    errorScale: 0.14, taperMetres: 9.0, taperPower: 1.55, splatScale: 0.85, minPixels: 1.2, maxDistance: 0, shadowMinError: 0.38, shadowMaxDistance: 80,
  }),
  hair: normalizeContinuumProfile({
    errorScale: 0.15, taperMetres: 18.0, taperPower: 1.50, splatScale: 0.85, minPixels: 1.0, maxDistance: 160, shadowMinError: 0.12, shadowMaxDistance: 65,
  }),
  animals: normalizeContinuumProfile({
    errorScale: 0.22, taperMetres: 48, taperPower: 1.10, splatScale: 1.0, minPixels: 1.1, maxDistance: 0, shadowMinError: 0.07, shadowMaxDistance: 240,
  }),
  props: normalizeContinuumProfile({
    errorScale: 0.45, taperMetres: 48, taperPower: 1.15, splatScale: 0.90, minPixels: 1.3, maxDistance: 1400, shadowMinError: 0.05, shadowMaxDistance: 200,
  }),
  city: normalizeContinuumProfile({
    errorScale: 0.24, taperMetres: 420, taperPower: 1.05, splatScale: 4.2, minPixels: 1.0, maxDistance: 0, shadowMinError: 0.28, shadowMaxDistance: 380,
  }),
  boulders: normalizeContinuumProfile({
    errorScale: 0.50, taperMetres: 420, taperPower: 1.0, splatScale: 0.85, minPixels: 1.2, maxDistance: 0, shadowMinError: 0.05, shadowMaxDistance: 400,
  }),
  forest: normalizeContinuumProfile({
    errorScale: 0.44, taperMetres: 260, taperPower: 1.05, splatScale: 6.5, minPixels: 1.4, maxDistance: 0, shadowMinError: 0.55, shadowMaxDistance: 260,
  }),
  meadow: normalizeContinuumProfile({
    errorScale: 0.52, taperMetres: 320, taperPower: 1.10, splatScale: 0.45, minPixels: 0.70, maxDistance: 0, shadowMinError: 0.22, shadowMaxDistance: 140,
  }),
  land: normalizeContinuumProfile({
    errorScale: 1.0, taperMetres: 0, taperPower: 1.0, splatScale: 1.0, minPixels: 1.0, maxDistance: 0, shadowMinError: 0.0, shadowMaxDistance: 0,
  }),
});

const liveContinuumProfiles = new Map(Object.entries(CONTINUUM_FAMILY_DEFAULTS));

// Resolves a family key ('people', 'forest', ...), an explicit profile object, or null (CONTINUUM_DEFAULT_PROFILE).
export function continuumProfile(keyOrSpec = null) {
  if (!keyOrSpec) return CONTINUUM_DEFAULT_PROFILE;
  if (typeof keyOrSpec === 'string') {
    const found = liveContinuumProfiles.get(keyOrSpec);
    if (!found) throw Error(`Unknown continuum profile family: ${keyOrSpec}`);
    return found;
  }
  return normalizeContinuumProfile(keyOrSpec);
}

// Live symmetric override for runtime tuning / diagnostics: updates a single family's profile in place so every scene
// reading that family key picks up the new numbers on the next frame.
export function setContinuumProfile(family, patch) {
  const prev = liveContinuumProfiles.get(family);
  if (!prev) throw Error(`Unknown continuum profile family: ${family}`);
  const next = normalizeContinuumProfile({ ...prev, ...patch });
  liveContinuumProfiles.set(family, next);
  return next;
}

export function resetContinuumProfiles(family = null) {
  if (family) {
    const def = CONTINUUM_FAMILY_DEFAULTS[family];
    if (!def) throw Error(`Unknown continuum profile family: ${family}`);
    liveContinuumProfiles.set(family, def);
    return def;
  }
  for (const [k, v] of Object.entries(CONTINUUM_FAMILY_DEFAULTS)) liveContinuumProfiles.set(k, v);
  return continuumProfilesSnapshot();
}

export function continuumProfilesSnapshot() {
  return Object.fromEntries([...liveContinuumProfiles.entries()].map(([k, v]) => [k, { ...v }]));
}

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

// Every family defaults to CONTINUUM_DEFAULT_PROFILE so every model family reads the exact same shared scene pixel
// error scalar, perspective law, shadow frustum, and budget (AGENTS.md rule 3: no per-family errorScale divergence
// and no hard shadowMaxDistance cutoffs). Live diagnostics may still override a family temporarily via setContinuumProfile.
export const CONTINUUM_FAMILY_DEFAULTS = Object.freeze({
  ships: CONTINUUM_DEFAULT_PROFILE,
  tradeVessels: CONTINUUM_DEFAULT_PROFILE,
  people: CONTINUUM_DEFAULT_PROFILE,
  hair: CONTINUUM_DEFAULT_PROFILE,
  animals: CONTINUUM_DEFAULT_PROFILE,
  props: CONTINUUM_DEFAULT_PROFILE,
  city: CONTINUUM_DEFAULT_PROFILE,
  boulders: CONTINUUM_DEFAULT_PROFILE,
  forest: CONTINUUM_DEFAULT_PROFILE,
  meadow: CONTINUUM_DEFAULT_PROFILE,
  land: CONTINUUM_DEFAULT_PROFILE,
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

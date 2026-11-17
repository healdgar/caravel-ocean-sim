// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The one continuum's shared numbers (AGENTS.md rule 3). Every family that is drawn across distance reads
// its splat and thinning limits from here, so a change to how the continuum ends is made once.
// Pure constants: loaded early in the bundle, before any family that reads them.

// Below this projected span, in pixels, a body morphs into its single view-facing horizon splat.
export const CONTINUUM_SPLAT_PIXELS = 3.5;
// Below this span the splat is thinned by a deterministic hash and the survivors are inflated to keep its area.
export const CONTINUUM_MIN_PIXELS = 1.0;

# Sailing and weather sounds

Twelve project-generated ElevenLabs `eleven_text_to_sound_v2` effects, selected
from the local authoring workflow. `provenance.json` records source take, edits,
duration, loop intent and SHA-256 for each distributed MP3. Prompts and listening
decisions live in `scripts/audio/`; raw generation records remain local.

Rebuild with `node scripts/audio-promote.mjs` when the original local takes are
available, then `npm run build`. Promotion applies the accepted trim, EQ, fade
and loop-crossfade edits before LAME encoding. The runtime mixes these headroom
normalized files at lower, condition-dependent gains.

Heavy hull slam, snow-contact, distant-flock and tern attempts were rejected and
are not included. Snow uses wind ambience. This folder contains no API keys or
runtime service dependencies.

## Deferred hull and wave audio

Separate improvement, recorded 2026-10-20; not implemented or regenerated yet.

- **Light contact:** the current slap is too harsh and sounds like a deliberate
  splash. Replace or reshape it into softer water pressure and wet impacts
  against wooden planking.
- **Cutting through swells:** add a rushing wash as the bow and hull slice
  through water, varying with speed and actual wave contact.
- **Re-entry after a crest:** use a watery crash when the exposed lower hull
  lands against the water. Drive this separately from light contact, using
  downward motion relative to the water and impact severity.

Audition these as distinct layers in a wooden sailing ship context, with Argon
listening feedback and in-game review before promotion. Preserve quiet intervals;
avoid repetitive, equally loud splashes on every wave. Current assets and runtime
mix remain unchanged until this workstream is resumed.

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

## Hull and wave audio refinement

Runtime refinement, 2026-10-21. Existing accepted audio files remain unchanged;
this pass changes their contact drivers and playback envelopes, not their provenance.

- **Light contact:** the accepted slap is now quieter, low-pass filtered and
  given a short attack/release envelope. A passing wave cannot repeatedly fire
  accents as it reaches adjacent contact stations: pressure must recede and a
  quiet interval must elapse before rearming. Stern-wake samples are excluded.
- **Cutting through swells:** the accepted rushing `hull-wash` texture follows
  speed in either direction, actual fore-contact wetness, pressure and relative
  closing. It also responds to waves against a stationary hull. Attack/release
  smoothing prevents one readback from chopping its volume.
- **Re-entry after exposure:** ten dedicated lower-bilge/keel probes use actual
  model surfaces and the full scaled/rotated hull transform. They query all six
  horizontally displaced FFT bands and retain dry/wet hysteresis each frame,
  independently of decimated CPU audio readback. A fresh inward return suppresses
  coincident light-splash accents for a longer quiet interval. The pressure-driven
  wash continues. The forty existing wake/spray records remain waterline contacts
  and no longer classify bottom impacts. Replaying wash as a louder impact was
  rejected in listening review. Each probe retains its latest return, rather
  than queueing sounds for every missed event during a slow readback.

The remaining asset task is a broad watery re-entry crash, with no brittle wood
breakage or separate splash attacks. The lower-hull sampler measures geometric
encounter speed, not water-particle velocity, force, pressure or joules. Its ten
coverage points and dry/wet tolerances are authored numerical choices, and it
currently excludes the local wake grids. It adds no impulses to the ship and
runs only with sound enabled. Reset, mute, hiding, teleport and stale readback
cannot replay a stored return. Generate and audition replacement sounds
in a wooden sailing ship context, with Argon listening feedback and in-game
review before promotion. Two further candidates cost 70 generation credits;
Argon rejected their edited takes for vocal/knock artifacts and unnatural tails.
Neither entered the asset manifest. Prompts and decisions are recorded in
`scripts/audio/hull-contact*.json`; `npm run audio -- plan --set hull` inspects
the recipes without generating. No rejected heavy-slam take was reintroduced.

`node scripts/hull-audio-review.mjs` renders deterministic offline Web Audio A/B
fixtures using the accepted files and production contact-state decisions. Local
WAVs, source hashes, levels and action logs stay under ignored `shots/`.
Argon directly auditioned the WAVs via `agy`: calm and stationary mixes improved;
rough re-entry still needs its own accepted texture. This is model feedback,
not user approval or proof of in-game acoustics.

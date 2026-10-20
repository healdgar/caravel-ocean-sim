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

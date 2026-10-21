# Gunnery sound

Copyright Six Cailloux, LLC. Code: MIT. Generated assets use the existing project's ElevenLabs authoring workflow; provider terms apply to the audio.

The runtime uses offline MP3 assets, the scene's existing Web Audio context, and the existing sound opt-in. No runtime provider calls or credentials. Captain Trevenen retains the selected Cornish voice; Tomás reports readiness.

## What drives playback

- The preparation and fire buttons request complete spoken orders. `GUNNERY_ORDER_SECONDS` provides their measured asset durations for visual sequencing, including when sound is muted.
- Ramming and running out follow actual loading-stage events. Recoil follows discharge. Readiness is spoken only after an actual `ready` event.
- Reports use the muzzle's world position and distance / speed of sound. The temperature approximation is `331.3 + 0.606 × °C` metres per second, defaulting to 15°C. Visible flash remains immediate.
- Reports arriving within 100 ms from the same battery share a louder bounded acoustic voice. This is a sound mixing budget; it does not merge physical projectiles or firing events. Arrival queue: at most 32 groups. Repeated command clicks retain one pending spoken order, and mute clears obsolete arrivals.
- Muzzle reports retain a sharp transient and open-air tail. Wooden trucks, hemp breeching arrest, tackle haul and rammer seating remain separate quieter layers. Effects receive fixed peak scaling without transient compression; the scene's master limiter still protects combined playback. Stereo panning and range falloff use the existing scene mixer.

## Historical basis and limits

[Royal Navy Museums' Victory conservation log](https://www.royalnavymuseums.org.uk/hms-victory-conservation-log) identifies 104 guns in 1805, surviving 32-pounders and 24-pounders, and a roughly three-ton original 32-pounder with carriage. It also documents unpainted gun-deck planks and hemp running rigging. These support the heavy wood, rope and iron sound palette.

[USS Constitution Museum's gun-crew account](https://ussconstitutionmuseum.org/2014/03/07/a-gun-by-any-other-name/) describes coordinated loading, firing, running in and running out by large gun crews. [The U.S. Navy's gun-deck overview](https://www.history.navy.mil/research/publications/publications-by-subject/tet-the-turning-point/constitution-gun-deck.html) supplies a contemporary demonstration and historical context. [The museum's Daniel Hogan record](https://ussconstitutionmuseum.org/crew/daniel-hogan/) describes dense sulphurous gun smoke during battle.

These are authored reconstructions, not measured acoustic recordings of a loaded 1805 naval gun. Modern Victory salutes are not a calibration source: many surviving display guns are replica teak or GRP. The MVP does not simulate cabin reverberation, hearing damage, directional muzzle overpressure, supersonic shot shock waves, or humidity-dependent atmospheric absorption. Captain wording is period-inspired English gameplay dialogue, shared with the existing fictional captain rather than a recorded historical officer.

## Reproduction

`node scripts/gunnery-audio.mjs plan` prints the bounded batch. `generate 01` buys only missing exact takes; request journals prevent duplicate paid submissions and uncertain requests are never retried automatically. `review 01` builds a local listening page. `promote 01` checks originals and rebuilds runtime assets and provenance. Local key: `.env.local`; source audio and provider request records remain in ignored `.audio/gunnery/`.

Selected runtime bytes and hashes are recorded in [assets/audio/gunnery/provenance.json](assets/audio/gunnery/provenance.json). [The listening record](scripts/audio/gunnery-review.json) identifies rejected takes, selected edits, and the final direct Argon checks. All nine selected samples passed. The report was trimmed to 0.52 seconds to remove a spurious second hit; the rammer retains only its first clean stroke. Fifteen generations cost 274 provider credits in total. These perceptual checks do not replace the user's review of the finished mix. Focused verification: `node --test tests/gunnery-audio.test.mjs`.

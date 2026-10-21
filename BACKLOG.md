# Waterworld backlog and overnight checkpoint

Run: October 20–21, 2026, America/Los_Angeles. Stop starting new work at **08:00 October 21**; stabilize active changes and report.

## Working rules

- Follow existing repository structure. Keep project context and checkpoints here.
- Direct subagents only; **no nested subagents**.
- **Testing baton: root.** Only root may run tests, builds, browser checks, numerical validation or profiling. Other agents may read/edit source and write proposed tests. Transfer this baton explicitly before another agent runs anything.
- Check active agents and test processes after interruption. Preserve unrelated changes; integrate bounded changes and verify before publishing.
- Test appropriate CPU invariants, actual native WebGPU rendering and affected user flows. Desktop/mobile viewports do not establish physical iPhone performance.
- Publish only passing checkpoints to the existing GitHub Pages site. Verify deployment and public artifact bytes. Keep measured facts distinct from authored historical/physical assumptions.
- Avoid new paid generation until existing assets and concrete gaps have been assessed.

## Baseline

- Published `bea3a355a7d5d273f958d3622cf014bb3045be68`: crew-served cannon drill, solid round-shot flight/recoil, actual FFT sea contacts, volumetric powder smoke, local flash lighting and reviewed audio.
- Last complete native Metal suite: 350 tests passed. A final focused control/crew run passed 7 tests after the last small control changes. Current test count can consequently differ from that earlier full run.
- Public `docs/index.html` SHA-256: `499368f428c73138c010e0cc2b3b54fed403544fc78fbbe85d104527d6a08af4`.
- Clean tree verified before overnight work began.
- Local hourly continuation: `waterworld-overnight-backlog`, bounded to this night; disable when the overnight run ends. Active goal carries the same cutoff.

## Active work

| Priority | Owner | Work | Gate |
|---|---|---|---|
| 1 | overnight_sailing | Source audit and bounded repair of sail forces, fill/luff, tacking, in-irons handling and shared rig clearance | Source-proven issue, physical invariants, actual GPU rig/clearance checks |
| 1 | overnight_marine | Source audit and bounded repair of whale/marine animation and water-contact defects | No rest-pose distortion; continuous animation; actual GPU/water visibility |
| 1 | overnight_hull_audio | Resume deferred hull/wave audio: quiet rush, distinct watery bottom impacts, fewer deliberate splash sounds | Contact-driven events, bounded mix, Argon review if new samples are required |
| 1 | root | Integrate and verify serially; audit new gunnery safety/playability and live startup | One testing owner, independent state, rendered and public verification |

These audits may close with no change when current source already satisfies the request. Do not invent fixes to fill a workstream.

## Remaining requested programme

1. Complete unresolved Victory shape/structure and sail/rig details when current evidence identifies defects; use existing measured GLB/reconstruction ledgers. Preserve real joins and tapered entrance; avoid detached decorative boards.
2. Finish Pinta and Santa María beyond their validated planned definitions, then enable a three-model fleet. `SHIP_MODELS.md` lists geometry, physics, rig, crew and fleet gates. They must not silently borrow Niña geometry or reported tonnage as displacement.
3. Refine landfall geography/vegetation from meaningful island/river/coastal modules, atmospheric visibility and natural source data. Existing Saba is an MVP; global mapping and explorable interiors are not required. Open-ocean voyage target remains 15–20 minutes without fast-forwarding local simulation.
4. Continue marine encounters, water interaction/refraction and effects quality based on rendered evidence. Shark/whale/dolphin systems already exist; distinguish defects from missing systems.
5. Improve crew appearance and functional work/decision hooks where current source/rendered checks show outstanding issues. Preserve diverse identities and half-female crew, without gendered costume/pose bias.
6. Later vessels: c.850 Viking longship, c.350 Roman galley, 1492 Caribbean canoe for30people, Flying Cloud clipper (replacing generic schooner), Gipsy Moth IV. Resolve source/reconstruction choices and propulsion before declaring playable.

## Uncalibrated or deliberately subsequent systems

- Gunnery muzzle speeds, reload/cadence and constant spherical drag remain authored approximations; damage, penetration, ricochet, adjustable gun elevation and AI combat are subsequent systems, not completed capabilities.
- Historical ship displacement, detailed rig leads/sail schedules and hydrodynamic coefficients retain their source/assumption distinctions in research files.
- Physical iPhone frame-rate qualification remains device-specific. Existing adaptive resolution targets30FPS; source/native desktop tests are not a replacement for that check.

## Release log

- Overnight work started23:19 October20. Direct agents have disjoint ownership; root runs all checks. No overnight changes released yet.
- First batch: heave/yaw relative sail wind, continuous whale emergence, root-anchored breath births, calmer hull audio and actual-sea muzzle clearance. Initial focused checks:30sailing/controlCPU,43otherCPU and11nativeMetal cases passed. Three whale GPU cases initially lacked CHROMIUM_PATH, then passed with the configured browser.
- Integrated run:367/368 passed. The packed-wave image oracle failed its 0.1% one-level channel threshold. Fresh-device SAME-shader controls reproduced52/49152 differing channels, with maximum error1 and identical alpha. Bound raised to0.2%; hard one-level/alpha limits remain. Four serial diagnostic runs then passed; this corrects measured native image noise, not a renderer change.
- Argon listened directly through agy: calm/stationary mixes improved; replayed-wash re-entry lacked body and pumped. Two new candidates (70credits) and their trimmed versions were rejected; no new audio assets promoted. Re-entry now retains the continuous wash and suppresses the fake extra impact. True underside probes/accepted heavy-crash texture remain pending.
- Root rendered actual blow and breach sequences on Metal at1000x700, no GPU/page errors; PNG evidence remains under ignored shots/. The final ambient hull mix received Argon KEEP; a heavy-impact texture remains absent.
- **Held rig prototype:** support-owner/cache changes passed40focusedCPU cases but exposed a17mm main-stay/mizzen intersection in four new mixed-yard poses. Narrowing the pinned-seam ramp to1/26 moved the crossing into triangles touching the sewn luff (segment3; full24mm rope penetration). The full run consequently passed371/372; that prototype is not releasable. Correct support sidedness/wrap geometry together; do not adjust separation tolerances or hide a rope. The complete patch and proposed CPU regression are preserved locally under ignored `shots/lateen-support-work/`. Those runtime changes and extra fixtures have been removed from the release batch pending a coherent correction. The existing operating rig is unchanged.
- **Release batch01 gate passed:** rebuilt all standalone pages; complete native Metal suite368/368 passed in187.9s, serialized by root. Public deployment/read-back still pending at this checkpoint. No new audio asset bytes entered the release.

## Next mechanical rig work

The full retained-yard bad-tack correction remains open. Separate yard side from
signed working-sheet angle, lead free cloth leeward around the aft mast while
keeping its luff sewn, and transition loaded/eased runners with climber safety.
CPU/WGSL/rope endpoints/forces/shadows must share that geometry. Existing tests
that expect windward-clew backing do not establish correct routine tacking.
Restrict own-yard exemptions to the sewn-luff neighbourhood when introducing a
wrap; do not hide intersections or restore an artificial force multiplier.

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
- Local hourly continuation: `waterworld-overnight-backlog`, bounded to this night; disable when the overnight run ends. The goal record carries the same cutoff but currently reports blocked; no code/permission blocker remains. Continue under the explicit overnight authorization and heartbeat.

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
- **Published batch01:** `5d4f210c7cf9652188b55885fdf95d67679473a9`. Rebuilt all standalone pages; complete native Metal suite368/368 passed in187.9s, serialized by root. Pages deployment39565380826 succeeded. Public artifact SHA-256 matched local: `79afb04fcc1df1109cd02f2dafb255d0f092262ad16fe654149e19366c2a3b04`. Fresh visible Chrome loaded Victory, completed real crew preparation, enabled fire after52/52ready and discharged52guns; no console errors. Local proof `shots/overnight-live-victory.png`. No new audio asset bytes entered the release.

## Next mechanical rig work

The full retained-yard bad-tack correction remains open. Separate yard side from
signed working-sheet angle, lead free cloth leeward around the aft mast while
keeping its luff sewn, and transition loaded/eased runners with climber safety.
CPU/WGSL/rope endpoints/forces/shadows must share that geometry. Existing tests
that expect windward-clew backing do not establish correct routine tacking.
Restrict own-yard exemptions to the sewn-luff neighbourhood when introducing a
wrap; do not hide intersections or restore an artificial force multiplier.

For the next pass, the held patch is `shots/lateen-support-work/owner-pose.patch`;
its proposed test is `rig-support.fixture.txt` in the same folder (not named
*.test.mjs, so Node cannot accidentally discover the unreleased fixture).
Do not promote its narrower seam ramp alone: it changes which triangle crosses
the same rope. The current one-sided X projection sends free cloth outboard of
a neighbouring stay while its sewn luff remains inboard. A continuous contact
path around the actual support, with the correct side, is required.
Routine sheet handling needs separate signed trim and latched working side;
occupied runners must remain taut until climbers descend. Additional per-mast
support controls may require a uniform-layout change; preserve Victory's
interpretation and every consumer if doing so. Full clearance, pinned-luff,
continuity, mirrored/dissipative force and crew-safety gates precede release.

## Batch02 in progress: lower-hull contact

Root retains the testing baton. The expanded isolated lateen oracle ran204
synthetic poses:164failed, predominantly compressed/furled own-yard penetration;
full-canvas failures occurred at opening0. The ordinary trim controller keeps
opening>=.30 and gathers before opening0 during a yard transfer. Thus the
synthetic matrix diagnoses several representations, not204 reachable sailing
states. No rig prototype entered production. Proper exposed-cloth wrapping needs
signed sheet trim, a textile rest metric/slack, finite owner-posed obstacles,
continuous contact topology and a shared deformation lattice. Gathered fabric
needs its own yard-surface bundle; blanket contact exemptions are unacceptable.

A separate ten-point canonical lower-bilge/keel sampler is being integrated.
It retains exposure/return on the GPU every enabled simulation frame; existing
40waterline/wake records cannot stand in for bottom contacts. Encounter speed
is diagnostic, not impact energy or a new force. First/reset/stale events stay
silent. Actual underside returns will suppress coincident light-splash audio;
a convincing heavy-crash sample remains unaccepted. No paid generation.

Batch02 local gate:376/376native Metal tests passed, serialized by root,
186.1seconds. Focused hull/weather checks19/19and all3page startup checks passed.
An initial reserved WGSL field (`meta`) prevented startup; renamed to `tags`,
rebuilt, then ran the passing full suite. Independent direct-agent source review
found no remaining blocker. Actual visible Chrome exercised Victory, sound
enable, Hella rough, spectrum reset and mute with no console errors; proof
`shots/overnight-bottom-local.png`. No crash sound, force impulse or rig change
is included. Publication pending.

**Published batch02:** `1e665c03a715e5e57b147d14034faef146b4e26a`.
Pages deployment39581887758succeeded. Public page SHA-256 matched local bytes:
`04cc20d03bd006453ec6e2e4c798729e3875b90975f9dcbcfcf50085d6c42443`.
Fresh visible Chrome loaded the published Victory, enabled sound, changed to
Hella rough, muted and continued rendering with no console warnings/errors.
Live proof `shots/overnight-bottom-live.png`; verification tabs closed.
Source/bundles/tests are committed and pushed; this publication receipt remains
local for the next checkpoint. Root remains the sole tester. Next priority is
the retained-yard operating-rig correction; do not promote any held contact
prototype or claim the accepted heavy-crash texture exists.

## Batch03: retained-yard research and isolated prototypes

`RIG_HANDLING.md` records the mechanical distinctions and release gates. Primary
museum research adds the missing routine yard-azimuth degree of freedom; the
existing yard is rigid in azimuth outside transfers. Root's25raw yaw/signed-sheet
poses showed forward force is possible but every such pose still contacts rig;
yaw alone is not a clearance correction. The actual-yard oracle now accepts an
optional yard transform. An eight-fixture pure crew/support handover prototype
passed, but it changes no production state and remains blocked at its external
geometry-clearance gate. Held fixtures use `.fixture.mjs`, never `.test.mjs`,
to avoid accidental discovery by the production suite. No batch03 runtime edits
or publication yet. Continue finite-mast wrapping/slack work; never promote a
signed-clew flip, wider spar offset or support masking as a completed correction.

Root subsequently rejected three isolated contact candidates on the same
fully exposed signed-sheet fixture: independent horizontal rows157pairs
(45own-mast), raw-subarc splice143(36own-mast), mesh constraints119(11own-mast).
The mesh pins were exact but edge stretch reached1.60times canonical reference;
three sails took425ms in the unoptimized diagnostic. None is releasable.
Ordinary free-edge points must move; they are not fixed attachments. Continue
from a known clear lattice with contact history, rather than inventing a wrap
side from an already intersecting raw surface. `RIG_HANDLING.md` records the
specific failures and remaining gates. No live rig change.

Root's31pose retained-history continuation removed deep own-mast crossings.
With target attraction applied once before each unchanged64iteration solve,
all93sampled sail surfaces met their own-mast margin; full-rig endpoint still
failed194pairs and edge stretch reached8%. This is not continuous collision or
textile clearance. Worst stretch sits below the moving clew, including on a
mizzen with no contact projection; explicit endpoint relaxation confirms slow
local propagation. An optional canonical graph-distance tether experiment is
next, preserving edge limits and iteration count. Production remains unchanged.

That tether comparison reduced maximum local stretch to4.6%, but still failed
217full-rig contacts. A full-raw-target prediction reversed contact normals and
was rejected. Selected rope witnesses are gathered stays/runners, always-eased
working falls and a foreign halyard; more support release alone is insufficient.
Root's production metric sweep also found existing tight-backed edge ratios
up to1.131with little total-area change. The reusable material-mesh audit exposes
this limitation without blessing it as a clearance pass.

Fresh visible Chrome inspected Victory's stern and close forward-quarter view,
calm sea/furled sails, with no console warnings/errors. Source audit found no
recurrence of the corrected blunt entrance or detached wales. Remaining numeric
gate: define and measure semantic keel and figurehead-to-taffrail endpoints
against the ledger's46.1010m/69.0372m conventions before reshaping again; generic
mesh extrema are not those measurements. Proofs `shots/overnight-victory-bow-review.png`
and `shots/overnight-victory-shape-review.png`; inspection tab closed.

**Batch03 gate passed:** complete native Metal suite383/383, serialized by root,
180.1seconds. Seven new material-mesh audit checks passed, including finite-input
arithmetic overflow; independent review caught and corrected partial edge extrema
after overflow. CLI JSON returned54records with no invalid coordinates/topology,
while honestly reporting backed-pose edge stretch. Only the audit script/tests
and local project documentation enter this checkpoint. Runtime JS/WGSL and all
three standalone page bytes remain unchanged. No contact prototype, artificial
force correction, new asset or paid generation is included. Publication pending.

The heartbeat remains active. Its bounded count was extended from9to10solely to
retain a wake at/after the08:00cutoff for stabilization/report/disable; the prompt,
thread, notification policy and prohibition on new implementation after08:00
are unchanged. Always check actual local time before starting another change.

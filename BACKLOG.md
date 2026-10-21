# Waterworld backlog and overnight checkpoint

Overnight run: October 20–21, 2026, America/Los_Angeles, with an **08:00 October 21**
implementation cutoff. That one-night heartbeat is now **paused**. Subsequent
daytime work follows the user's new requests; earlier active-heartbeat/cutoff
entries below are historical records, not current scheduling instructions.

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
- Original local hourly continuation: `waterworld-overnight-backlog`, bounded to that night and now paused. Daytime requests do not extend its overnight authorization or reactivate it.

## Original overnight workstreams

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

**Published batch03:** `443ea7fcbf9d3c879490d96f361f71dec55d965b`.
Pages deployment39597495015succeeded; legacy Pages reports built at the same
commit. Public page SHA-256 matches the prior verified runtime and local bytes:
`04cc20d03bd006453ec6e2e4c798729e3875b90975f9dcbcfcf50085d6c42443`.
The audit, tests and documentation are pushed; only this publication receipt
remains local. All direct agents are complete; root retains testing. No test or
inspection browser remains active. Local server8088stays available.

Next bounded rig step: begin from an independently certified full-rig seed,
not merely an own-mast-clear raw surface. Solve cloth against the actual mast,
gathered rope bundle and foreign load-bearing lines; keep sheet/support controls
independent. Preserve rest lengths, moving-attachment consistency and contact
history before pursuing CPU/GPU integration or performance. Do not promote the
held row/PBD/tether prototypes or substitute support release for contact solving.
At/after08:00local, start no new implementation and disable the one-night heartbeat.

Historical overnight status: the heartbeat remains active. Its bounded count was extended from9to10solely to
retain a wake at/after the08:00cutoff for stabilization/report/disable; the prompt,
thread, notification policy and prohibition on new implementation after08:00
are unchanged. Always check actual local time before starting another change.

## Batch04: breach trajectory continuity

Verified whole-body breach discontinuities at ages 4, 6 and 8.9: pitch jumped at
the launch branch, and vertical velocity jumped into and out of flight. Exact
swimming/ballistic derivatives now join through submerged Hermite approach and
recovery segments. A squared-sine bank has zero endpoint roll rates. Airborne
height/pitch, launch time, apex and flight duration remain unchanged; the bank
waveform changes intentionally. This is authored C1 kinematics, not C2 motion,
conserved energy or hydrodynamic propulsion. Event logic and assets are unchanged.

Root's dense diagnostic found root minima −5.53 m/−5.61 m in approach/recovery;
the existing analytic body envelope reaches −10.58 m. These are not animated-skin
or actual-seabed clearance checks. Independent direct-agent source review found
no blocker. 22 focused marine checks passed on Metal. An initial omitted Chrome
path prevented three GPU checks from launching; the correctly configured run
passed. Complete serialized native Metal suite 385/385 passed in 175.4 seconds;
all three standalone pages rebuilt. Visible Chrome captured the actual airborne
breach and re-entry at deterministic frames 435/545 with no console warnings or
errors (`shots/overnight-c1-breach.png`, `shots/overnight-c1-reentry.png`). Existing
entry spray still shows authored pointed particle shapes; this checkpoint fixes
motion, not that remaining fluid-effects quality limitation. Publication pending.
Root remains sole tester.

Further held rig work established one full-rig-clear static seed and preserved
raked-mast-axis rotation invariants, but the raw handover first contacts rig at
step 5 and 216 independent-yaw endpoints yielded no complete clearance. See
`RIG_HANDLING.md`; no prototype entered the runtime. Victory's endpoint audit
also found missing semantic keel/figurehead/taffrail measurement nodes; details
are recorded in `VICTORY_RESEARCH.md`. Do not reshape to generic mesh extrema.

**Published batch04:** `dfd0ba8fdd55ce71a8bf0564d6a84a120d9ed1bd`.
Pages deployment 39604848700 succeeded; public standalone bytes exactly match
local SHA-256 `eadd9154e79e2d1bc7f670e528b324dcc3e9ae02f5fbfc40542c687c94d3c8d9`.
Fresh visible Chrome loaded the public whale encounter without console warnings
or errors; proof `shots/overnight-c1-breach-live.png`. Verification tab closed;
direct agents complete, root retains testing and local server 8088 remains up.
This publication receipt remains local for the next checkpoint. Full rig
handling, accepted heavy hull-crash audio, actual wave-relative animal contact
events and improved marine entry spray remain open. No new paid generation.

## Batch05: marine impact water

The visible whale re-entry spikes came from the shared dolphin crown's
13-cycle rim sampled at only 28 segments, compounded by high rim foam and
overlapping crowns. Marine impacts now use their own 64-segment/six-row curved
sheet, analytic normals, brief staggered emission and full gravity for every
detached row.64 impact drops retain first-contact records and generate24
representative fallout ripples. Dolphins and whale breath remain unchanged.

An initial candidate fixed drops but could expose an absorbed sheet again when
waves fell. Independent review identified that gap. A separate344,064-byte
cache now retains water absorption at every sheet lattice vertex, with exact
seam identity, serial-keyed slot reuse and a dedicated compute dispatch.
Root's13 focused Metal checks pass, including actual marine runtime rendering,
analytic velocity/gravity/normals, later finest-band waves, first-contact
retention and recycled keys. Full suite and final rendered gate pending.
Limitations: sampled point contact, no swept/interior-triangle collision, no
impact wind or fluid-pressure coupling. Geometry/contact work persists through
the bounded4.2-second event life; physical iPhone cost is unqualified.

Argon directly auditioned the existing anchor plunge and a filtered/slowed trial
alone and in the current rough-water mix. Both hull-impact trials were REJECTED:
point-source bubble/plunge, muffled slosh and repetition. No asset promoted or
new sound generation. Detailed local review/provenance is recorded in
`scripts/audio/hull-contact-review.json`; its duration guesses are not measured
evidence. The continuous accepted wash remains, without a heavy-crash accent.

The additional rig source audit supports the existing forward heel/aft penna
orientation. Authored neighboring support/tackle leads remain suspect. A
partial-brailing diagnostic is recommended but unrun; no rig behavior changed.

**Batch05 held after rendered review:** the revised effect removes pointed
rims but looks too faint in actual early/side re-entry captures
(`shots/overnight-impact-early.png`, `shots/overnight-impact-side.png`). All13
focused GPU checks pass, including the new retained sheet contacts, but their
water is spatially flat. Source concern: one frozen root height can place a
new parcel below the local wave at its offset footprint, immediately latching
absorption. Check per-parcel local launch-height sampling before promoting;
do not merely increase opacity or disable valid contact. Marine agent has a
read-only design audit, no further edit authorization. Full suite/build and
publication have NOT been run for batch05. Last public release remains
`dfd0ba8`; root retains the testing baton. All working edits are intentional.

## User priority: startup delay and loading feedback

The held batch05 runtime/docs/test work is preserved in local Git stash
`01a25d28773a65b814f7689355fd78ffce03c9d0` (message: Held marine impact v2).
Production marine code was restored before this change; no held impact code is
part of the startup release. Ignored recordings/prototypes remain in place.

Verified the public page transferred14,055,444compressed bytes and decoded to
21,774,158bytes before startup. On this Mac's fresh Chrome context, first GPU
frame completed at2.34s, with102pipelines and no application errors. That desktop
observation is not a physical-iPhone timing. The published HTML embedded muted
audio, inactive terrain and all models. Generic init failures only logged, and
the existing starting label was hidden inside the optional performance HUD.

The Pages build now emits about600KB of HTML with explicit, content-hashed media
files and a SHA-256 asset manifest. Mandatory wood/crew/whale files preload;
audio remains gesture-loaded and terrain remains scene-gated. Both downloadable
ocean pages retain every original embedded asset. No media reduction or fidelity
change. Older hashed files remain available for cached HTML. A static loading
screen precedes the module, reports actual milestones, waits for first canvas
GPU completion, supports mobile/reduced motion, and retains errors with Retry.
No guessed progress percentage or failure timeout. The extra presentation RAF
was removed during review to preserve deterministic single-callback render
fixtures; first-GPU-work completion still gates readiness.

Eight focused tests passed before the final two assertion improvements: delayed
module/mobile layout, first GPU fence, sticky API failure/Retry, script/asset
failures, deferred web audio, byte-identical versioned media and both actual
file:// offline boots. Exact per-asset embedding and single-transfer preload
checks are now in the full serialized native Metal suite. Full/rendered/public
gates pending. Root remains sole tester; direct agents did source work only.

Final startup validation: **393/393 PASS**, serialized installed Chrome on native
Metal, 185.5 seconds. The first full run found five legacy UI fixtures that froze
RAF before any frame and then clicked through the loader. Those fixtures now
render their real first frame and await readiness; their interaction assertions
remain intact. Eight new startup/packaging tests pass, including exact bytes in
both downloads and exactly one request for each preloaded asset.

Visible Chrome review of the rebuilt Pages scene showed the real loading stage,
then the ship, instruments, helm and usable Sea settings; no warning/error logs.
Evidence: `shots/startup-mobile-loading.png`, `shots/startup-ready-local.png`.
Initial Pages HTML is 614,127 bytes; 53 referenced assets total 15,875,925 bytes.
The whale remains a mandatory 8.32 MB startup resource and pipeline count remains
102; this checkpoint improves packaging and feedback without claiming all
startup work has disappeared.

Published startup checkpoint `12e58a891419e317d029df461e59783732219c10`;
Pages workflow `39618593217` succeeded. At 2026-10-21 14:40:48 UTC, the public
HTML and manifest matched local bytes, and all 53 deployed assets matched their
SHA-256/byte counts. HTML SHA-256:
`72ef564f9369023b602a8b7e4d2755a5a1d0762bd747a79c96ffcc1261fda148`.
Fresh public Chrome on this Mac reached its first GPU frame in 1.20s, versus
the earlier 2.34s observation; HTML transfer was 212,493 compressed bytes.
These are desktop observations, not an iPhone or controlled repeated benchmark.
The deployed scene also passed visible Chrome review: real loading stage,
then the ship/helm, with no warning/error logs. Evidence:
`shots/startup-ready-public.png`; local receipts are in
`/tmp/waterworld-startup-deployed.json` and
`/tmp/waterworld-startup-after-public.json`.

## Daytime requests: forest, ship wake and shared surface disturbances

**Published and verified: runtime checkpoint `6a39870`.**
The public-byte receipt is recorded below. Root alone owns
numerical/geometric checks, native GPU tests, rendered review, builds and any
subsequent Pages publication. Documentation/source readiness is not a passing
combined run or a physical-iPhone result.

- **Ship wake:** removed the separate reflective waterline ribbon. Continuous
  interpolation now drives resolved crest/trough pressure across fore/aft
  contacts, with Victory's correct aft span. Headway/pressure set outward peel
  velocity and nearby foam transport. A balanced stern trough/recovery pair and
  compact alternating quarter-pressure lobes drive the actual retained height
  field. These are bounded authored waves, not calibrated CFD or Kelvin dispersion;
  no propulsion assist was added.
- **Shared scene water:** wildlife surface events, anchor entry and actual
  round-shot water contacts feed independent 512² near/far layers covering
  256/1,024 m. Their authored 4 m/s wave response contributes surface displacement,
  normals, refraction and probes without altering the global FFT spectrum.
  Source IDs, bounded impulses, reset handling and near/far representation are
  part of root's current checks. Existing splash effects are not sufficient proof
  that the underlying sea moves correctly.
- **Forest:** the Saba pack records 17,466 stable trees from 360,000 deterministic
  candidates. Distant trees use opaque primary-bough envelopes joined to their
  actual trunk. Near/middle geometry retains recursive branches and leaf cutouts.
  Actual render-pixel height/FOV/depth select a conservative 3 px geometry-error
  target with 12% hysteresis; frustum culling and source-integrated leaf colour are
  included. Production 96/512 near/middle budgets flag overflow rather than
  silently violating the geometry target. Source colour/elevation remain 8 m/16 m;
  density is authored, not historical canopy reconstruction. Combined geometric,
  canopy rendering and desktop cost checks passed as recorded below; pixel
  geometry bounds do not certify imperceptible alpha/colour transitions.
- **Breaking water:** `BREAKING_WAVES.md` records primary research, engine limits
  and a proposed shared lifecycle for wakes, open-sea crests and future beaches.
  It is not implemented. References include
  [Thürey et al. 2007](https://cgl.ethz.ch/Downloads/Publications/Papers/2007/Thue07b/Thue07b.pdf),
  [Chentanez/Müller 2010](https://matthias-research.github.io/pages/publications/hfFluid.pdf)
  and [Derakhti et al. 2020](https://faculty.washington.edu/jmt3rd/Publications/Derakhti_etal_2020_breakingonset.pdf).
  Wind is not the sole cause of breaking; `B≈.85` cannot be applied using wind,
  a fixed grid propagation speed or an unvalidated fluid-velocity estimate.
  Argon input is consultation, not validation evidence.

### Next bounded hull-audio work — not implemented

The user's clarification distinguishes sustained hull-relative rushing from
small steep wave-face slaps riding on a larger swell. Current waterline contacts
sample all six FFT bands independently of broad buoyancy-slope filtering, but
their pressure signal uses a 0.65 m footprint and a roughly 56 ms temporal filter.
Audio then requires a stronger spray-launch serial, reads every eight frames,
and applies whole-wave rearm/quiet gates. Short modest contacts can be attenuated
or missed; the current continuous wash uses surge speed rather than full
hull-relative current/leeway flow.

Next: a separately gated modest-contact audio event retaining peak/time/position
through readback, plus a small steep wave-on-long-swell fixture at 30/60/120 Hz.
Keep rush continuous, preserve underside-return suppression and avoid coupling
ordinary slaps to ballistic spray eligibility. Assess spatial filtering only
after the fixture shows an actual loss. No new audio runtime, asset promotion
or physical-device qualification is claimed by this source audit.

### Daytime checkpoint validation

- **406/406 PASS**, installed Chrome on native Metal, serialized by root,
  208.5 seconds. Includes source and all three packaged pages, offline downloads,
  mobile controls, sail/rig invariants, Victory, shared optics, scene-wave kernels,
  propagation/reset/reprojection, source lifecycle, canopy geometry and actual
  production whale contacts. Imagery preparation script syntax also checked;
  no imagery download/regeneration or new paid asset generation.
- The first combined run was405/406: the new wave-image fixture let its wildlife
  follow camera move after ending the animal. Freezing camera/frame inputs fixed
  the comparison, without a runtime change. At the same scene instant, removing
  wave sampling changed6304pixels versus4pixels in the unchanged control; the
  wave remains after actor/splash removal. The corrected full run passed.
- Tightened offline geometry bounds with point-to-triangle BVH queries and
  adaptive subdivision, then regenerated the eight cached tier tables. Full
  geometric surfaces remain conservative: this is not an alpha/colour guarantee.
  Pixel-mode selection avoids an unnecessary whole-stand distance sort.
- Actual1280×800 horizon/approach/coast checks: median GPU-completed frame
  intervals8.3/8.5/10.6ms; p9510.6/9.8/13.2ms. At3840×2160: medians11.5/13.1/29.6ms;
  p9513.7/15.0/31.5ms. These are short sequential CPU+GPU completion observations
  on this Mac, not physical-iPhone qualification or isolated GPU pass timings.
  The4K coast retained231near,11790middle and4052far trees; pixel quality takes
  precedence over legacy96/512 authoring budgets. No runtime region was deleted.
- Visible Chrome reviewed revised wakes in mild/rough water with no warnings or
  errors. Local evidence: `shots/wake-field-heavy-final-local.png`,
  `shots/forest-water-coast-3840.png`, `shots/whale-real-waves-contact.png`.
  Independent source review found no wave binding/current/reset/order blocker.
- Remaining: connected overturning/spilling water and richer splash absorption,
  genuinely sharper coastal relief/colour, appearance-bounded stand-level forest
  aggregation, physical-iPhone cost, and independent modest-slap audio. The new
  waves are authored linear responses; no CFD, calibrated energy conservation,
  bathymetric surf or universal breaking-onset implementation is claimed.

**Published daytime checkpoint:** `6a39870345526df0809cbb9b0969749eb4942c93`.
Pages workflow `39633359534` succeeded. At2026-10-21 16:18:27UTC, deployed HTML,
manifest and all53 referenced assets matched local bytes/SHA-256 counts.
HTML637680bytes, SHA-256
`a9614bc10be3868ee695f0d0e30cfce0832a258eef67dabc79a83b22b11b6689`;
referenced assets15875925bytes. Fresh visible public Chrome loaded the coastal
scene with no warnings/errors; proof `shots/daytime-public-coast.png`.
Source/asset receipts remain local in `/tmp/waterworld-startup-deployed.json`.
The overnight heartbeat remains paused; this batch followed fresh daytime requests.

## Finite hull exclusion and green water

User reported a carved hollow with sharp inner edges when the bow plunges into
a large crest. Source confirmed the ocean mask extruded the hull footprint to
infinite height; an older test explicitly required that wrong above-rail mask.

- Shared model-aware finite boundaries now follow exposed decks and solid cap
  tops. Both ocean visibility paths admit continuous water above those caps;
  below-rail hull and cabin/raised-deck space remain excluded.
- Deck water enters all four perimeter faces, including a bow-only pulse with
  dry side lips. Physical face lengths weight the bounded flux. Runoff starts
  at the incoming head and travels inward; residual wash drains and dries.
- Optional shared scene-wave sampling is connected to both ships' deck fields.
  Its compute precedes deck updates; no self-wave propulsion force was added.
- **407/407 native Metal tests PASS**, root serialized,198.8seconds. New test
  proves bow-only ingress, no below-cap leak, cabin separation, retained wash,
  drainage/wet-film persistence, current shared-wave view and disabled clears.
  Five focused mask/deck/visibility/wake GPU checks also passed. Controlled
  same-pose before/after renders show continuous water over the foredeck:
  `shots/deck-boarding-legacy.png`, `shots/deck-boarding-finite.png`.
- This is prescribed-wave visibility plus bounded thin deck water, not a
  hydraulic overturning, flood-mass or cabin-flooding solver. No physical-iPhone
  cost qualification. Published as `f16d33d20a2bd89a7246b225597a2000d02de7e7`;
  Pages workflow39643356285 succeeded. At17:26:02UTC, deployed HTML and all53
  assets matched tested bytes. HTML639533bytes, SHA-256
  `fc0786da50541b07feeb017542e27153b75ffdc7c24ee9e4655fb3ea9a109783`;
  assets15875925bytes.

Separate active terrain work: reuse local forestmodeler/furlong woodland assets
and directional depth reprojection for a terrain-conforming cohesive canopy;
varied trees and resolvable grass/rocks; no unreviewed prototype in this water
checkpoint. Original ground-cover additions are preserved in
`shots/terrain-next/source.patch` while the water snapshot is tested/published.
Cloud views from above remain lower priority. Coastal/isolated-shoal surf must
use local depth relative to wave height and wavelength; this is required shared
breaking-water work, not a shoreline colour band. Keep its design separate from
claims about already implemented runtime.

## Underwater inspection, caustics and close ground detail

- Exterior orbit now spans both sides of the waterline, with a closer zoom and
  independent focus panning. Right/Shift drag pans; touch supports two-finger pan
  and pinch. Free inspection also crosses the sea; terrain clearance remains.
  Captain-view behavior is unchanged. Share links retain exterior angle/range/pan
  and free-view coordinates.
- The same displaced sea now has an interior dielectric interface: water-to-air
  refraction, a Snell window and total internal reflection. A current GPU probe
  classifies the camera without readback lag. A bounded HDR medium pass before
  bloom applies spectral extinction and sunlight/sky scattering; captured solid
  material avoids duplicate air fog and water attenuation. Captured shallow bed
  can fill ordinary terrain's deliberately omitted submerged triangles.
- Wave slopes drive a local refracted-light receiver Jacobian for caustics on
  submerged solids from above/below water. Flat waves do not invent a pattern;
  solar occlusion, depth and turbidity fade it. This is not multivalued photon
  tracing, reflected-object reconstruction or full multiple scattering. Runtime
  Moon lighting is pending the separate astronomy design.
- Grass clumps and irregular rocks use four shared opaque meshes, deterministic
  regional patches, triangle-accurate terrain roots, slope-aligned normals and
  actual-render-pixel omission/hysteresis. Grass bends with wind; cached sunlight
  avoids ray marching clouds per blade. Ground materials gain filtered meso detail.
- Focused native optical checks passed: Snell/TIR, actual-wave focusing, negative
  solar/depth/turbidity controls, one/four-sample depth, raw-solid occlusion,
  current GPU camera classification, disabled dispatch and resize. Actual desktop
  and emulated-mobile gestures pass. **420/420 complete production tests PASS**,
  installed Chrome/native Metal, root serialized,214.6seconds. All three packaged
  pages are included. Rendered shallow-bed caustics change with actual wave time;
  proof `shots/caustic-bed-10.png` and `shots/caustic-bed-10.7.png`, no page/GPU
  errors. An earlier run caught grass/rock pipelines mislabeled as tree wood;
  their distinct ground-cover label restores the unchanged two-tree-pipeline
  oracle. The final complete run passes without loosening that oracle.
  Published as `d0018e998611256cc71679e1958a1cf5aebb56a1`; Pages workflow
  39653348992 succeeded. At18:32:08UTC, public HTML, manifest and all53assets
  matched tested bytes. HTML659253bytes, SHA-256
  `0868df573dec143c4212659ff4027ff20c20621c6b6c51729509b06ba9b19ff6`;
  assets15875925bytes. Fresh visible public Chrome rendered submerged ship,
  refracted surface and controls with no warnings/errors. Proof:
  `shots/underwater-public-verified.png`. No physical-iPhone claim.
- Actual1280×800 horizon/approach/coast GPU-completed frame medians with original
  trees and new ground detail:6.2/6.0/8.9ms, p957.4/7.5/11.1ms, no page/GPU errors.
  Coast selected252rocks and634grass clumps (69156prop triangles). These short
  sequential observations are Mac results, not physical-iPhone qualification.

### Held directional woodland prototype

Imported exact leafy colour/normal/RG16-depth banks and reduced wood from local
Castle and Commons / Forestmodeler, with source hashes and notices. Two banks
use9MiB uncompressed GPU textures. New modules, intake script, assets and proposed
tests remain local (fixture in `shots/woodland-next/woodland.test.mjs.txt`);
**not imported by the production terrain or standalone build**.
Initial rendered coverage was unacceptable (twig-like fragments/missing crowns),
and frame medians22.4–28.2ms exceeded the accepted original tree path. No release
claim follows its CPU receipt/bounds tests. Ray-entry/depth convergence repair,
matched-source near geometry, below/overhead view coverage and coherent stand
aggregation still need rendered validation.

Source density review also found the existing full-green placement intensity
can cover only about38% even under optimistic opaque-disc crowns. Increasing
global candidates to900k predicts only about70%, with greater overdraw; it is
not a calibrated closure fix. Next: authored patch closure targets and measured
source crown footprints, deterministic union/overlap planting, then distant
volumes derived from those same planted crowns. Do not fill sparse stands with
an unrelated opaque shell or certify a new asset using old geometry-error tables.

### Subsequent physics and sky work

`BREAKING_WAVES.md` now requires detached-shoal and shoreline surf driven by local
height/wavelength/depth, not a shoreline foam band. The current authored bed lacks
intertidal/shoal detail; runtime transport/breaking/swashing remains pending.
`ASTRO_NAVIGATION.md` specifies historical stars, Moon phase/light and optional
sextant lessons; the current600second loop cannot serve as its astronomy clock.
The distant long-crest report is source-confirmed: swell is deliberately narrow
(spread48). A broader directional spectrum/finite coherence needs a separate
height/energy-preserving comparison; shortening peak wavelength is not that fix.

# Shared vessels and fleet programme — 22 October 2026

User-authorized order: finish the Victory bow/keel assessment; compare Niña and
Victory's applicable parts and animations; implement the remaining vessel
programme; expose independently selectable AI escorts sailing as a fleet.
Performance is measured, but is not an admission gate for this programme.

## Baseline and ownership

Public name: **Ocean Sailing Simulator**.
Published runtime: `7fba40de2601552757ada1ce490883ced75f06fb`.
The four-model/fleet/night checkpoint below is qualified and published: root's full
native Metal suite passed **572/572**, zero skips, in **302.194 seconds**, with
rendered checks. Pages deployment `7243537555` succeeded at **2026-10-22T04:12:31Z**;
HTML, manifest and all 53 assets matched exact public sizes/hashes at **04:13:27Z**.
The subsequent **nine-model candidate is integrated but unpublished**, with final
combined/native/rendered qualification pending. The receipt above remains the
public baseline; backend-ready source is not a release receipt.
Root alone runs tests, builds, rendered checks and profiling. Direct agents may
author disjoint code and proposed tests; no nested agents. Held `woodland`
prototype files are unrelated and remain outside these checkpoints.

## Assessment

- Victory's rounded upper bow is supported by photographs. Its current lower
  entrance and waterline registration are authored, not traced Admiralty offsets.
  Do not narrow the whole forebody from one photograph. See
  `VICTORY_RESEARCH.md` for sources and unresolved measurements.
- The initial comparison found generic lateral drag and omitted sail yaw.
  Current source instead integrates loaded hull/actual exposed-keel strips,
  passive lateral forces and their yaw/roll moments alongside sail yaw. Existing
  mass, loading, inertia and righting remain. Coefficients and dynamic CLR are
  authored; force passivity alone is not historical calibration.
- Shared nine-float mesh/material format, semantic part ranges, attachment
  roles, posed surfaces, wetness, lighting and per-instance simulation are useful.
  Binary "Victory, otherwise Niña" dispatch is not a model abstraction.
- Do not collapse differences: lateen transfer, square bracing, luff-axis trim,
  wheel/tiller/steering-oar operation, deck hierarchy and submerged hull shape
  remain model-owned capabilities. A canoe has no sails or dummy masts.

## Checkpoints

1. **Comparison and lateral body:** inspectable existing-model part contract;
   authoritative attachment transforms; cached submerged-profile strips with
   side/yaw/roll loads; sail yaw applied without artificial propulsion. Preserve
   existing mesh bytes. Validate passivity, symmetry and sternway handling.
2. **Fleet resources:** per-model immutable assets and per-instance mutable
   resources, pooled wake textures and variable shadow/mask/probe dispatch.
   Up to eight escorts plus player, allocated for enabled selections. Independent
   model choices/toggles, formation slots and collision avoidance. One ocean and
   weather simulation. Preserve old share links.
3. **Shared construction and motion:** descriptor-owned hull/deck/contact data;
   shared mesh primitives; arbitrary sail surfaces under up to three controls;
   identical posed cloth for visible geometry, forces, ropes, shadows and wetness.
   An explicit CPU pose path is acceptable initially. Unknown backends fail.
4. **1492 variants:** Pinta, then Santa María. Own hulls, decks, crew routes,
   helm, anchors, loading and real mixed rigs. Square canvas is divided into
   historically appropriate courses/topsails. Record replica versus historical
   dimensions and never turn builders' tonnage into displacement.
5. **Later craft:** ninth-century Oseberg-based vessel, late-Roman river galley,
   thirty-person Caribbean dugout canoe, Flying Cloud, Gipsy Moth IV. Resolve
   evidence and interpretation in `SHIP_MODEL_RESEARCH.md` before admission.
   Oar/paddle strokes must drive geometry, hand targets, immersion and physical
   force together; recovery strokes produce no thrust.
6. **Integration/release:** serial focused checks, full regression suite,
   rendered isolated and mixed fleets, loading/rig/propulsion/disabled-resource
   checks, packaged pages and deployed-byte verification. Update README/backlog
   with actual completion and explicit limits. Never label metadata or a static
   mesh as a playable vessel.

## Current four-model/fleet/night checkpoint — published and byte-verified

| Checkpoint | Published scope | Remaining boundary |
|---|---|---|
| Shared parts and lateral body | Niña/Victory comparison, semantic transforms, reusable construction, loaded hull/actual-keel strips and sail/water moment balance | Geometry preservation, passive-load and physical-helm regressions passed; original offsets/dynamic CLR remain uncalibrated |
| Fleet | Up to 8 independently selected/enabled followers plus player; one ocean/weather; per-model immutable assets; per-vessel mutable state; pooled wake/shadow layers | Mixed/maximum-nine modular and Pages allocation/isolation fixtures passed; no device performance guarantee or complete collision solver |
| New construction/motion | Authoritative CPU surface/yard/rope/attachment pose, GPU upload and wetness-probe refresh for new models; explicit legacy backends | Current force/crew/visible/shadow/submerged/wet consistency checks passed; tested poses do not certify every operating rig configuration |
| 1492 variants | Pinta and Santa María published with own hull/decks/equipment, three/five actual sails respectively | Reconstruction offsets, working cloth dimensions, loading and gun outfit remain authored |
| Five later craft at this receipt | Authored Oseberg/Lusoria/canoe prototypes and Flying Cloud/Gipsy Moth IV definitions | They were outside this public runtime; their integrated candidate is recorded separately below |
| Astronomy/night | Unwrapped clock/location, Sun/Moon/phase and historical stars, cloud/depth/horizon visibility and coherent lunar lighting through explicit 528-byte Frame | Native/integrated/minified checks and full/new-Moon rendered captures passed; no certified navigation accuracy or physical-iPhone performance |

## Nine-model candidate — integrated, unpublished

The candidate wires all nine model choices through their actual hull, rig,
crew, propulsion, equipment and rendering paths. It can select one of each as
player plus eight followers; disabled rows still allocate no vessel resources.
One FFT ocean/weather system remains shared. Per-vessel pose buffers, companies,
rowing-water samples, wake layers, shadows, wetness, guns/anchors where present,
and simulation state remain independently owned.

| Model group | Candidate implementation | Remaining release boundary |
|---|---|---|
| Oseberg / Lusoria | Independent open hulls, 30/24 oars, one main-controlled square sail, real benches, steering oars and full 32/26-person companies | Final combined geometry/crew/water-force/native/rendered qualification |
| Taíno-style canoe | Independent dugout, 30 occupants with 24 drive paddlers and steering paddle; no sails, anchor or guns | Same gates; authored regional dimensions and loading remain explicit |
| Flying Cloud | Independent clipper, 25 cloth surfaces/15 yards, actual working stays and fittings, wheel, 12 workers representing 42 loaded | Rig envelope/source uncertainty and full combined/rendered gates; cloth inventory not historically certified |
| Gipsy Moth IV | Two physical masts, four sails under three controls, real fin/cockpit/tiller, one sailor; recorded engine disabled | Final combined crew/rig/fin/native/rendered gates; original design-DWL separated from later refits |
| Mixed fleet | Eight selectable followers, including ordinary human-powered effort/turn policy | All-nine-model source requires its own final qualification and exact deployed-byte receipt |

The source company counts are **12/12/12/12/32/26/30/12/1** for
Niña/Pinta/Santa María/Victory/Oseberg/Lusoria/canoe/Flying Cloud/Gipsy Moth:
149 represented actors for one of each. Personnel mass remains model-owned:
Victory loads 820, Flying Cloud 42, Pinta 30 and Santa María 40; their twelve
visible workers represent a watch. These manifests are simulation choices,
not newly verified historical complements.

Rowing controls use Rest/Easy/Full effort, turn demand and stroke rate. One
stroke drives the blade mesh, crew hand/foot targets, real moving-water contact
and bounded human loads; dry recovery supplies no drive. Oseberg/Lusoria combine
that with wind where usable. UI and AI omit nonexistent rig/equipment; no engine
or zero-flow steering assist is introduced.

Reported length conventions, beam and tonnage remain separate from authored
offsets, draft, loading and sail/rig geometry. Oseberg supplies AD 820 proportions
for a c.850 scenario; Lusoria selects a riverine reconstruction; the canoe is an
authored Greater Antillean target. Flying Cloud selects the contemporary
225 ft deck/41 ft beam report without claiming its 25 surfaces are a recovered
inventory. Gipsy Moth selects original design-DWL dimensions/lead, not later
restoration displacement. See [model contracts and company table](SHIP_MODELS.md)
and [source limits](SHIP_MODEL_RESEARCH.md). Geometric passivity/clearance does
not certify historical polars, seaworthiness or navigation accuracy.

The candidate remains pending final combined qualification, rendered checks,
publication and public byte verification. No sustained Mac or physical-iPhone
performance result follows from nine-vessel allocation or viewport emulation.

## Shared fleet behaviour

Roster changes apply through reload. `fleet=nina,pinta,santa-maria,victory` selects
independent followers; `!model-id` retains a disabled row without allocation.
Legacy links without `fleet` keep the same-model escort; `follower=0` keeps only
the player. Formation guidance uses ordinary sail/helm commands, leeway,
leader/station motion and bounded helm feedback. It supplies no motor, zero-flow
steering assist or forced ship translation/heading. Candidate rowing followers
add ordinary human effort/differential stroke commands. Avoidance is not yet a
collision solver, voyage planner, combat or hailing system.

Historical waterline/offset calibration remains unresolved separately from engine
refactoring. The nine-vessel cap reflects explicit resource limits, not 60 FPS on
all Macs or 30 FPS on a physical iPhone. Root reviewed Pinta/Santa María in visible
Chrome and native actual four-vessel/full-Moon/new-Moon captures alongside the
passing suite. Exact commit/publication/deployed-byte receipts are recorded in
[BACKLOG.md](BACKLOG.md#published-checkpoint-four-vessels-independent-fleets-and-night);
physical-device performance remains separate from release verification.

## Additional authorized work

### Renewed overnight implementation, October 21–22

The user renewed overnight work, with an 08:00 PDT October 22 implementation
cutoff. Root retains exclusive test/build/browser/profiling execution. Direct
authors work in separate local managed worktrees; no nested agents.

| Owner | Local worktree | Source ownership |
|---|---|---|
| frame_cpu_audit | overnight-physics | Procedural hull/floor/keel contract, hydro/loading/lateral/contact, sailing and real rowing/water forces |
| frame_gpu_audit | overnight-models | Later ship meshes, authored spars/rigs, control-group surface poses, model-owned attachments |
| post_parity_tests | overnight-crew | Variable companies, seated rowing/steering IK, capability-aware jobs and moisture capacity |
| root | primary checkout | Registry/parts/assets, equipment absence, main/UI/follower/sharing/bundle, integration and every qualification/release |

Each author commits source and proposed checks without executing validation.
Root integrates coherent handoffs before admission. Physics distinguishes outer
body from keel/fin appendage (union volume, exposed lateral area), weather floor
from perimeter barrier, and physical mast index from sail control group. Rowing
must use current water-relative blade motion with stale-sample suppression.
The five later vessels remain unregistered until those contracts work together.

Night source follows `ASTRO_NAVIGATION.md`: independent simultaneous Sun/Moon,
actual phase/limb and catalogue rotation, explicit 528-byte production Frame
(previous 384-byte prefix retained), and shared lunar sea/material/cloud/wet/
underwater paths. Solar shadow/cloud-map priority above the horizon is a bounded
approximation, not dual independent light-field maps. Manual links remain manual.
The locally pinned code/data retain separate MIT/CC BY-SA notices.

Navigation instruments, learning hints, assistance and certified historical sight
accuracy remain later work. Do not conflate sky implementation with qualified
sextant/position-fix mechanics. Held woodland work remains outside this programme.

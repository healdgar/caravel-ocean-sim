# Shared breaking water — research and implementation boundary

2026-10-21. **Design proposal, not an implemented or validated breaker solver.**
The current wake correction and shared disturbance field passed separate GPU
and rendered checks recorded in BACKLOG.md. Those checks do not establish this
proposed breaking-water design.

## Physical distinctions

Wind contributes energy and can strip spray from a crest, but is not required
for wave breaking. Laboratory wave groups produce deep-water spilling and
plunging breakers through wave interactions without shoaling or wind. See
[Kway, Loh and Chan (1998)](https://doi.org/10.1016/S0029-8018(97)00039-5).
Shoaling, opposing flow and hull displacement are additional routes to steep,
unstable water. A common visual lifecycle can serve them; their forcing and
onset criteria must remain distinct.

- **Spilling:** water and aerated turbulence run down the crest's forward face.
- **Plunging:** a coherent lip leaves the crest, overturns and hits the water ahead.
- **Spindrift:** wind removes smaller airborne water from an existing crest.
- **Impact splash:** an object drives water out of the surface; it need not satisfy
  a freely propagating wave's breaking-onset criterion.

Gravity, initial water momentum and pressure determine the main water motion.
Wind drag acts separately on detached water; it must not supply every sheet's
forward velocity. A single-valued height field cannot represent an overturning lip.

## Applicable primary research

[Barthélémy et al. (2018)](https://doi.org/10.1017/jfm.2018.93) developed a
crest-local energy-flux threshold. On the free surface it becomes
`B = Ucrest / Ccrest`: water velocity in the propagation direction divided by
the tracked crest's speed. Their deep/intermediate-depth onset range is about
0.85–0.86. This is not wind speed divided by phase speed.

[Derakhti et al. (2020), author PDF](https://faculty.washington.edu/jmt3rd/Publications/Derakhti_etal_2020_breakingonset.pdf)
extends the framework to tested shoaling cases, with onset around 0.85–0.88.
It requires adequately resolved crest geometry, fluid velocity and crest tracking.
Toe-driven surging breakers are a different mechanism. General complex 3D
bathymetry and directly wind-forced shallow breakers are not universally certified
by those results. Slope, height/depth and surf similarity are useful diagnostics,
not interchangeable universal thresholds.

[Thürey et al. (2007), author PDF](https://cgl.ethz.ch/Downloads/Publications/Papers/2007/Thue07b/Thue07b.pdf)
is the closest practical graphics architecture: detect and track connected steep
fronts, emit connected particle sheets, evolve detached water under initial
velocity and gravity, then merge it with the height field and create drops/foam.
The paper deliberately targets important visual behavior rather than full 3D
fluid physics. Tracking also suppresses duplicate nearby births.

[Chentanez and Müller (2010), author PDF](https://matthias-research.github.io/pages/publications/hfFluid.pdf)
uses steepness, rising surface and negative curvature together to detect candidate
breaking water, with particle/height-field coupling and foam advection. Its example
thresholds depend on its numerical model; copying them into our FFT/wake grids
would not establish a physical or frame-rate-independent criterion. It also explains
why a height/vertical-velocity wave equation cannot supply horizontal fluid flow.

[Deane and Stokes (2002)](https://www.nature.com/articles/nature00967) identifies
distinct bubble-creation regimes: turbulence fragments larger entrained bubbles;
jet/drop impacts create smaller ones. Foam birth should therefore follow actual
air entrainment and impact activity rather than arbitrary bright pixels.

[Callaghan (2013)](https://doi.org/10.1002/jgrd.50768) separates formation and
decay times and discusses bubble-plume evolution and surfactant stabilization.
Its measured area-weighted 5.3-second lifetime is dataset-specific, not a universal
foam expiration constant. Active whitewater and residual foam need separate states.

## Current source and missing quantities

| Existing component | Reusable capability | Important limitation |
|---|---|---|
| `js/wgsl/sim.js`, `js/wgsl/ocean.js` | Six FFT cascades, displacement derivatives, common ocean geometry/optics | Choppy displacement and compression are not a nonlinear fluid-velocity solution or validated breaking onset |
| `js/wgsl/interaction.js` | Actual hull contacts, incident-wave impacts, displaced local wakes, detached sheets/drops and landing foam | Authored non-dispersive wake; representative sheet landing, not a complete sheet/water contact surface |
| `js/wgsl/spindrift.js` | Persistent crest roots, ridge fitting, world-space birth data, bounded plume population | Wind-gated mist with authored launch/gravity; samples FFT, not every interactive field; not a plunging-sheet implementation |
| `js/surface-waves.js`, `js/wgsl/surface-waves.js`, `js/wgsl/surface-coupling.js` | Shared event-driven disturbance height, vertical velocity and foam; bounded near/far grids | Linear impulse response; no horizontal fluid flow, overturning or bathymetric shoaling; separate numerical/rendered checks do not validate breaking behavior |
| `js/wgsl/sim.js` foam clipmaps | Persistent fresh/aged coverage and advection | Compression remains a proxy; wind drift does not equal water velocity |
| `js/wgsl/terrain.js` coastal water | Terrain-height query and shallow-water coloration | Underwater skirt and shore foam are authored visual responses, not surveyed bathymetry or a shoaling solver |

Neither the wake's 2.5 m/s propagation constant nor the shared field's 4 m/s
constant is `Ccrest` for arbitrary FFT waves. Wind is not `Ucrest`. A time derivative
of artistically scaled choppy displacement is not automatically the liquid velocity
needed by the published `B` criterion. Do not label a compression/slope heuristic
as that criterion.

## Proposed shared lifecycle

This is an engineering proposal inferred from the research, not a reproduced paper.
Suggested ownership: new `js/breakers.js` and `js/wgsl/breakers.js`, with explicit
adapters for the existing ocean, hull-contact, spindrift and scene-wave modules.

1. **Candidate and tracking.** Query the same total displaced surface used by
   rendering: all six horizontally inverted cascades, both vessel wakes and the
   shared disturbance field. Track crest/front identity and neighboring tangent
   samples in world space. Record steepness, curvature, rise and propagation
   direction. Initially expose these as proxy diagnostics. Enable a `B` mode only
   after validating its independent fluid-velocity and crest-speed estimates.
2. **Onset and budget.** Latch one generation-tagged event, with hysteresis and
   finite spatial/temporal emission. Inputs identify source kind, position/tangent,
   water velocity, crest speed when valid, scale, depth, available energy/volume,
   and wind. A hull impact can supply a forced event directly. Calm water and an
   arbitrary steep rear face must not generate a breaker.
3. **Connected water.** Emit successive rows from the tracked front, retaining
   each row's actual birth position, velocity and age. Use surface-following
   whitewater for spillers and a connected departing lip for plungers. Ordinary
   foam gain cannot replace this geometry. Split small spray from the lip;
   apply gravity at 9.81 m/s² and size-dependent air drag explicitly.
4. **First contact.** Test the actual moving sheet samples against the total
   current surface. Latch absorption per generation/sample; trim the mesh as
   water enters. A later trough must not resurrect absorbed vertices. Derive
   return impulses and foam from contact momentum/air-entrainment budgets,
   and enqueue each return once into the shared disturbance path.
5. **Whitewater and residual foam.** Maintain active aerated water separately
   from residual coverage. Advect with an explicitly defined water-flow estimate,
   age and decay it, then allow a smaller wind contribution. Subsurface bubble
   clouds are a later optional layer, not an opacity substitute for missing water.

Prescribed FFT waves and linear disturbance grids do not conserve emitted liquid
volume or remove nonlinear breaking energy. Full conservation claims require a
corresponding coupling/dissipation model. Track budgets and expose that limitation
before adding local damping or another solver. Keep incident hull forcing separate
from self-generated return waves to avoid feedback propulsion.

For beaches, reuse the lifecycle only after a local depth/current/shore response
exists. A foam-colored depth band does not simulate shoaling. For open sea, keep
wind-driven spindrift as a child effect; a windless wake may still break.

## Coastal and shoal surf — required scope, not implemented

The requested system includes **surf over submerged shoals as well as surf at
land**, followed by run-up, retreating water, retained foam and wet ground.
Breaking must respond to the **local wave height and wavelength relative to
local depth**. Neither distance from shore, global significant wave height nor
wind alone can decide where every wave breaks. Shorter steep wavelets riding a
larger swell remain separate candidates when resolved; do not collapse all
contacts into the largest swell's crest or its rearm interval.

### Source-proven limitations

- `js/wgsl/terrain.js`, `COASTAL_WATER`: current shore foam is a colour mix from
  instantaneous water/bed separation, positive surface height and procedural
  noise. It has no crest identity, incoming wavelength, horizontal water flow,
  breaking sheet, wet/dry front or backwash. More brightness in that band is not
  the requested surf.
- `scripts/prepare-land-imagery.py` and the Saba manifest: wet cells receive
  `min(120, 2 + .15 * shoreDistance)` metres of authored depth. The minimum wet
  cell depth is two metres; bilinear interpolation between those cells and land
  supplies a graphical shoreline, not a resolved beach profile. A monotone
  distance skirt contains no authored detached offshore bars, reefs or shoals.
  The current sixteen-metre elevation grid and quarter-metre quantization cannot
  establish detailed intertidal flow. Preserve the measured land relief and its
  provenance; introduce explicitly authored or separately sourced shallow beds.
- `js/wgsl/surface-waves.js`: the shared impulse field has no bed input or
  horizontal momentum and uses a constant propagation speed. Its boat-centred
  near/far coverage is not a coastal propagation, shoaling or swash solver.
- `js/wgsl/spindrift.js`: its fixed-scale ridge shoulders, compression proxy and
  wind gate are reusable tracking ideas, not a wavelength-aware coastal onset
  model. Windless incoming surf must work without enabling spindrift.

### Bounded implementation order

1. **One canonical coastal bed.** Add a resident shallow-water tile contract with
   bed elevation, wet/dry validity and authored/source provenance. Keep the real
   island landform. Supply controlled beach, steep rock shore and detached shoal
   fixtures first; do not manufacture shoals from the greenness map. Depth
   sampling must agree across propagation, rendered water, shoreline contact,
   underwater visibility and vessel clearance. Refine spatial resolution against
   the shortest enabled coastal wavelength and bed feature, with convergence
   checks instead of a universal cell size.
2. **Incident wave and local transport.** Drive tile boundaries from the same
   horizontally inverted incident FFT field. Preserve amplitude, phase and
   propagation direction across the boundary. Add wavelength-aware depth response
   before labelling it shoaling; a depth-only shallow-water approximation cannot
   represent every FFT band. Restrict such an approximation to its applicable
   bands and retain resolved short chop separately. Compose a local correction
   to the incident surface, not a second complete wave added on top of it.
3. **Tracked depth-limited fronts.** For each candidate retain crest position,
   adjacent troughs, crest-to-trough height, local wavelength/direction, depth,
   steepness, bed gradient and recent propagation history. Multi-scale sampling
   must distinguish a small steep face from its underlying swell. Use a documented
   proxy mode until its quantities and onset law are validated. Do not invent a
   numerical breaking threshold, reuse global `Hs` as local height, or rename a
   depth ratio as the published `B` criterion. A detached shoal must use the same
   front lifecycle without a distance-to-land condition.
4. **Spill, collapse and first return.** Start with one controlled spilling front,
   then a coherent overturning lip where justified. Reuse generation-tagged
   connected rows, gravity, total-surface first contact and one return budget.
   Advect active whitewater and residual foam with the defined local water flow;
   wind is a secondary drift. Separate burst foam from a permanent shoreline
   colour. Feedback/dissipation remains explicitly approximate while the global
   incident FFT is prescribed.
5. **Swash and backwash.** Maintain finite water depth and horizontal transport
   over the local bed, with wet/dry positivity and bounded time steps. Water must
   climb the beach, slow, recede downhill and leave a drying wetness field that
   the terrain material actually samples. A spray plane above dry ground or a
   sinusoidal dark shore strip does not satisfy this step. Rocky shores can use
   contact splash without falsely behaving like gently sloping beaches.

Keep tile work, crest slots and emitted rows bounded; retain world identities
as the observer moves. Distant landfall may display aggregated whitewater from
the same active coastal state when individual sheets are subpixel. It must not
substitute an always-white band or independent, camera-reseeded surf for that
state. Use the existing sun, shadows, air visibility and water optical path.

### Coastal acceptance fixtures

- The **same incoming wave height, wavelength and phase** over deep water, a
  gradual shelf and a detached shoal; changes must follow the bed, not shore
  distance. Repeat with different heights and wavelengths, including a resolved
  short wave riding a long swell.
- Calm water over a beach and shoal: no permanent breaker, foam or rising water
  source. High wind with flat water must not become a surf shortcut. Deep water
  and a steep but receding/rear face remain negative cases.
- A shoal outside the shoreline foam band's reach; an oblique incoming front;
  a sheltered coast; and independently classified steep-rock contact versus
  shallow-beach spill. Record where current transport/shelter is approximate.
- Continuous water displacement at tile boundaries, coherent front identity,
  no duplicate energy/foam injection, once-only sheet absorption, and no expired
  event resurrected after reset or slot reuse.
- A crest reaches dry shore, runs up and retreats; retained foam moves with the
  water and wet ground outlasts it. Wet/dry cells stay finite and nonnegative;
  no water appears uphill without an incoming volume/transport source.
- The three existing horizon/approach/coast views, low waterline and overhead
  views, and changed render resolution/FOV. Measure active work and native GPU
  cost; physical-iPhone qualification remains separate.

## Consultation, not validation

Argon consultation relayed during this work suggested smooth hull source/sink
forcing, balanced pressure kernels, and a stern-recovery scale proportional to
`U²/g`. It also warned that a constant-speed wave field does not establish the
deep-water Kelvin angle. These are design suggestions, not measured validation
or evidence that the current wake has physically correct dispersion.

## Acceptance gates before promotion

- Controlled nonbreaking, spilling and plunging fixtures; zero-wind forced breaks
  and high-wind flat-water negatives. Reject troughs, rear faces and duplicate births.
- Known traveling-wave velocity/crest-speed checks before enabling `B`; verify
  resolution sensitivity and distinguish proxies from measured quantities.
- Connected birth geometry, full-gravity trajectories and finite normals; no
  floating ribbons, rectangular spray cards, disconnected roots or expired reappearance.
- All-six-cascade horizontal inversion and identical total-surface sampling for
  rendered water and first contact, including overlapping wakes and scene waves.
- Event/slot reuse, reset, teleport, spectrum change and delayed-readback checks;
  one landing budget and foam deposit per absorbed parcel.
- Crest/trough displacement without opaque overlays, bounded return impulses and
  no self-propulsion. Foam survives/adapts after breaking rather than staying at source.
- World-space trails through turns, moving cameras and near/far recentering;
  comparable outcomes at 30/60/120 Hz and changed spatial resolution.
- Separate near-waterline and overhead rendered review of hull, open-sea and beach
  cases. GPU assertions alone cannot certify convincing water.
- Fixed population/work caps, inactive-path checks and measured GPU cost. Desktop
  or browser-emulated results do not qualify physical iPhone performance.

First bounded experiment: one tracked, forced wake-front event using shared
surface contact and connected rows, before automatic open-ocean or beach births.

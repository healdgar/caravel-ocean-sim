# Retained-yard lateen handling — implementation checkpoint

2026-10-21. **Design and isolated experiments; not released rig behavior.**
Production remains the retained-yard model described in `SAILING_MODEL.md`.
No propulsion bonus, reversed-force shortcut or powered steering is authorized.

## Mechanical distinctions

A yard retained on one side of its mast need not remain fixed in azimuth.
The [Museu Marítim de Mallorca's lateen account](https://museumaritim.conselldemallorca.es/en/-/san-miguel-un-llaut-gran-de-1899)
describes yard orientation, inclination and sail concavity controlled through
heel lines/braces, an upper vang and the sheet. This is a later Mediterranean
analogue, not a recovered Niña rig schedule. Its English translation's
windward/leeward terminology should not be treated as course terminology.

Our normal yard has no azimuth control: `lateenYardPoint` applies only transfer
side/offset and dip. `opening` hinges the canvas about that fixed diagonal yard.
`pose.side` additionally selects the working sheet, eased shrouds and climbing
side. Those are separate mechanical decisions.

For the current surface in beam airflow, changing pressure reverses camber but
leaves the clew's hinge direction unchanged. The resulting backed-sail force is
a consequence of the geometry; it does not establish that a real retained-yard
lateen must propel a ship astern on its bad tack.

## Required shared controls

| Control | Meaning |
|---|---|
| Yard side | Retained sling/yard location; changes only during an ordered transfer |
| Yard azimuth/inclination | Rigid spar orientation with matching heel, head and sling leads |
| Signed sheet angle/load | Working/lazy sheet handling, independent of yard side |
| Port/starboard support state | Gradual take-up/easing; no release under a climber |
| Cloth contact/slack | Continuous mast/support bearing with a defined textile rest metric |

All consumers must use the same posed surface: display, force panels, hems,
rope endpoints, crew grips, attachments, wetness and shadows. A neighbour's
support belongs to its own mast pose. Aerodynamic caches must include those
neighbour dependencies.

## Safe routine handover

Latch intent outside calm, headwind and dead-run hysteresis, with dwell.
Reserve affected runners before allowing another ascent. Descend existing
climbers normally and require a transaction-tagged deck/aloft acknowledgment.
Take up the new windward supports while keeping the old supports loaded.
Only a clearance-proven sheet path permits sheet handover; release the old
supports afterwards. Missing acknowledgment freezes progress. A completed
physical transaction keeps its captured target through a later gust.

Full yard transfer remains an exclusive captain's maneuver. Routine handover
must never repeatedly gather/transfer the rig while the vessel is in irons.
The intent prototype does not move production cloth, ropes, yards or forces.

## Root verification so far

- A 25-pose raw sweep varied yard azimuth and signed sheet angle from -0.6 to
  +0.6 radians. Several poses generated forward force using the production
  panel-force function, but **every forward-driving pose still contacted rig**.
  Positive yard azimuth also introduced spar/support contacts. This is evidence
  against a rigid-yaw-only shortcut, not a trim optimization or historical polar.
- Eight pure handover fixtures passed: latch/dwell, reservation, crew generation,
  take-up before release, clearance hold, captured target, exclusivity and mirrors.
  They establish control logic only, not collision clearance or executed crew work.
- Geometry probes use design coordinates. A 0.003-unit clearance is 0.005m at
  the default uniform Niña scale. Interpret raw distances before calling them metres.

### Rejected contact experiments

One fully exposed diagnostic pose uses retained side -1, signed sheet +0.3 rad,
zero yard azimuth, pressure -1 and clew contraction 0.98 on all three masts.
These are authored inputs, not a calibrated sailing trim.

| Candidate | Actual triangle/rig contact pairs | Own-mast pairs | Result |
|---|---:|---:|---|
| Independent horizontal detour rows | 157 | 45 | Whole-row replacements jump between adjacent triangles; curved rows can hit a mast while their endpoint chord clears it |
| Raw-contour subarc splice | 143 | 36 | Preserves outer raw contour, but freezes ordinary free-edge points; remaining contacts and wrap-topology conflicts |
| 64-iteration mesh constraints | 119 | 11 | Exact luff/clew pins, but unresolved interior crossings and edge stretch up to 1.60 times reference |

The mesh solver frees ordinary boundary vertices; only 27 sewn-luff vertices and
the clew are pinned per sail. Its first three-sail solve took 425 ms in a local
Node diagnostic, excluding 38 ms for the independent full-rig oracle. This is
neither a production frame-time benchmark nor a viable per-frame budget.
No inverted or degenerate faces appeared in this single endpoint, but that
does not establish absence of self-intersections or a valid textile metric.

An intersecting initial surface gives unsigned contact projection no reliable
wrap side. A 31-pose continuation from signed sheet -0.3 to +0.3 rad retained contact
history and avoided deep mast crossings. Repeated attraction toward the raw
target still left 13 own-mast clearance-margin failures and up to 10.7% edge stretch.
Applying attraction once before each unchanged 64-iteration solve cleared every
sampled own-mast surface, but retained up to 8% edge stretch and 194 full-rig contact
pairs at the endpoint. No sampled face inversion or lost contact history was
observed. Swept clearance and self-contact remain unproved.

The once-mode worst edge is the foot immediately below the moving clew on all
three sails. It also stretches on the mizzen without any mast projection.
An explicit zero-attraction endpoint relaxation reduced maximum stretch to
about 4.7% after 256 additional iterations; it did not justify a larger production
iteration budget. This identifies slow constraint propagation separately from
the remaining rig/contact problem.

[Long-range attachment research](https://matthias-research.github.io/pages/publications/sca2012cloth.pdf)
supplies a bounded convergence experiment: upper-distance constraints from
each free vertex to the clew and nearest sewn-luff pin, using canonical mesh
path lengths. Those inequalities follow from existing edge limits; they must
not introduce tighter Euclidean rest shortcuts or inflated fabric allowance.
They do not establish wrapping, self-contact or a complete textile model.

The two-anchor experiment retained the same 31 poses and 64 iterations. Its worst
edge stretch fell to 4.6%, but 217 full-rig contacts remained. Rest limits were not
relaxed. A separate full-raw-target prediction caused contact-normal reversals
and up to 18.8% stretch; rejected. Better target matching is not contact continuity.

Selected witnesses include already gathered runners/stays and working falls
parked beside the mast, plus a foreign main halyard crossing fore canvas. They
cannot all be corrected by releasing more taut supports. The mast and its real
gathered rope bundle need a shared bearing surface; foreign load-bearing lines
remain separate obstacles. Changing support side on the held lattice reduced
the contact count but introduced yard/support conflicts; it did not clear the rig.

The released tight-opening backed pose also exceeds its canonical local edge
budgets: maximum ratios about 1.095/1.131/1.096 across the three sails, while area
ratios remain near 1.001. This source-level measurement is a pre-existing
kinematic limitation, not a newly introduced regression or a calibrated fabric
strain. Area-only checks cannot certify the cloth's material geometry.

Local experiments and results remain under ignored `shots/lateen-support-work/`.
Held test files use `.fixture.mjs`, avoiding automatic production test discovery.

## Remaining release gates

Resolve exposed cloth against finite owner-posed supports with fixed sewn
attachments and measured slack requirements. Check actual 26-row triangles,
continuous transitions, no fold-through and shared CPU/WGSL geometry. A sampled
curve clearing a mast does not prove its rendered triangle chords clear it.

Furled cloth needs a real bundle surface: the existing compressed triangle can
enter its own spar. Full-canvas/opening-zero synthetic poses are diagnostic;
ordinary trim keeps opening at least 0.30 and gathers before zero during transfer.
Neither case justifies a blanket collision exemption.

[Membrane tacking research](https://arxiv.org/abs/2410.04966) treats tension,
material stiffness, inertia and transition kinematics as consequential. Its
2-D modern-sail study supplies no calibrated Niña cloth parameters or ready
3-D mast-contact solver. Keep numerical tolerances and handling rates labelled
as authored policy until independently grounded.

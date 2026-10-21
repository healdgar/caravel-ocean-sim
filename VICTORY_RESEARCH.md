# HMS Victory: construction references and modelling limits

Research checked 20 October 2026. Target: Victory in her **1805 Trafalgar configuration**, before battle damage. This is a source ledger for a procedural interpretation, not a claim that every offset or rigging lead has been digitized.

## Principal dimensions

Captain W. J. L. Wharton's *A Short History of H.M.S. Victory* (1884) supplies a useful explicitly labelled dimension table. Preserve its conventions; one generic `length` cannot represent all of them. [Original naval historian's text](https://www.gutenberg.org/files/40847/40847-h/40847-h.htm).

| Quantity | Reported value | Exact metric conversion | Application |
|---|---:|---:|---|
| Gun-deck length | 186 ft | 56.6928 m | Principal hull/deck design baseline |
| Keel length | 151 ft 3 in | 46.1010 m | Lower longitudinal profile; not visible hull length |
| Figurehead to taffrail | 226 ft 6 in | 69.0372 m | Overhanging hull/extremity extent; not bowsprit-inclusive LOA |
| Extreme beam | 52 ft | 15.8496 m | Maximum external breadth in this source |
| Depth of hold | 21 ft 6 in | 6.5532 m | Internal construction dimension; **not draught** |
| Tonnage | 2,162 tons | Do not convert to kg | Source says tonnage, without a loading condition or a mass definition |

The Royal Navy describes the preserved ship as approximately 69 m long and 3,500 tonnes. This corroborates scale, but is a **modern conservation report**, not a recovered loaded displacement curve for October 1805. [Royal Navy, 11 August 2020](https://www.royalnavy.mod.uk/news/2020/august/11/20200811-visitors-get-to-see-underneath-victory-for-first-time).

The National Historic Ships register lists 51 ft beam but gives an erroneous 5.49 m conversion; 51 ft actually equals 15.5448 m. Its 153 ft air-draught entry also describes a different mast/display convention from many popular total-height numbers. Do not combine incompatible measurements silently. Its narrative establishes three masts, three principal gun decks, pronounced tumblehome and the 1800–03 reconstruction. [Register 499](https://www.nationalhistoricships.org.uk/register/499/hms-victory).

**Still uncalibrated:** loaded draught, waterline length, vertical centre of gravity, detailed mass distribution, roll/pitch damping, resistance and sail coefficients. Commonly repeated mast heights and draught values were not verified against an accessible 1805 dimensional schedule in this quick pass. Any chosen runtime values must remain labelled authored approximations. Builder's measurement/tons burthen are capacity conventions, not displacement mass.

## Measured user reference and waterline fit

The supplied `Meshy_AI_Victory_at_Portsmouth_1020215320_generate.glb` is a shape
reference, rather than a replacement runtime asset. Its SHA-256 is
`f54976c233c708811065981f00a1be9ff6b3c6a56880b34b36d391720cd3453e`.
It contains 3,517,784 triangles, including broken/fused rigging and fittings.
The game retains its procedural working structure, gunports, guns and rig.

Exact triangle/plane intersections were measured along source X (bow negative,
stern positive), with Y up and Z across the beam. Port/starboard outer distances
were averaged. Section spikes caused by guns, boats, channels and broken
attachments were excluded; small missing intervals were interpolated. Fifteen
longitudinal stations and eight reliable source height bands inform the fit.
Shape-preserving cubic interpolation shares tangents between frames; separate
height sections allow a rounded bluff bow, tumblehome and a fine lower stern
under a broad upper counter. A single repeated cross-section cannot do this.

Registration is explicit and **authored**:

- Robust reference half-breadth: 0.176884356886 source units. Scale:
  44.802152884 metres/source unit, anchored to the reported 15.8496 m beam.
- Source gun-deck endpoints are inferred, not annotated. The fitted sternpost
  is X=+0.78; the 56.6928 m baseline gives centre X=0.147298261907.
- Source upper gun-deck floor Y=-0.358 aligns with design height 1.17
  (5.527548 m). This places the chosen waterline at source Y=-0.481376838928.
  The GLB itself supplies no waterline or loading condition.
- Engine design Z=(source X-centre X)×44.802152884/4.7244. Design base
  Y=(source Y-waterline)×44.802152884/4.7244; the authored sheer is then added.
  Transverse widths use the corresponding beam scale. Extreme offsets are
  bounded by the reported beam.

The user's Portsmouth photograph supplies an additional visual check of lower
gunport clearance, high stern galleries and the narrow lower stern. Its
perspective and unspecified loading condition cannot establish exact draft.
The reference mesh's shallow underside cannot establish it either; the deeper
8.8 m fairbody remains authored. Reconstruction plans and this reference also
describe different historical/display states, so the fit is not an assertion
that every feature matches October 1805.

An independent set of 22 clean sections at source X=-0.30, +0.10, +0.40 and
+0.60, omitted from the fitted station grid, gives 0.0668 m RMS half-breadth
error and 0.2119 m maximum error. These measure agreement with this imperfect
GLB, not historical accuracy. Tests also check rendered joins and dense CPU/GPU
width parity, so water contact follows the same surface.

The procedural hull's edge planks, continuous waterways, tapered bulkheads,
rail posts, proud wale returns, curved gunport lids and raked end closures use
the same hull evaluator. Stern galleries have shared arched, horizontally bowed
and raked skins, glazing and structural returns. Their restrained crown and
corner rounding are authored from the reference silhouette and photograph,
not surveyed moulding dimensions. The completed working model retains 104
represented guns and its existing sail/rig attachment nodes at 89,449 triangles
(5,846,340 bytes of indexed geometry); the source's broken rigging is not copied.

The first fit incorrectly closed every above-water height at one vertical
gun-deck endpoint. Fine forward sections show the actual rounded shell reaching
source X≈-0.507 to -0.510, ahead of that cutoff. The corrected stem varies with
height and projects about 1.10 m forward of its authored waterline endpoint.
Dense forward frames and vertical stem samples retain the rounded entry instead
of a large triangular first panel. A fore-only coordinate warp ends before the
first gunport, preserving interior deck and rig registration. The measured
stem/beakhead are distinguished; broken lower source plating still requires
authored closure. Regression rays hit actual rendered planking at reliable upper
near-nose sections, rather than accepting only a zero-width endpoint.

The generated reference's lower entrance remained too full after that stem fix:
the actual waterline reached 7.40 m breadth only 1 m behind the stem, and 10.42 m
at 2 m. The [ZAZ0120 half-breadths](https://www.rmg.co.uk/collections/objects/rmgc-object-79911)
and [ZAZ0126 upper-deck plan](https://www.rmg.co.uk/collections/objects/rmgc-object-79917)
guide a separate faired entrance over the forward 6.07 m. The latter plan and
the clean generated sections retain the broad rounded upper battery; the
correction fades out above the lower entrance and below the fine keel sections.
The revised actual waterline breadths at 0.5/1/2/4/6 m aft of the stem are
2.72/5.07/8.41/12.38/13.99 m. These are authored offsets constrained by coarse
visual plan ranges, **not** digitized historical waterlines or a sharp clipper
bow. The 22 held-out clean reference sections remain within 0.0665 m RMS and
0.2119 m maximum error. Rendered entrance widths, deck/rail/wale joints and the
same CPU/GPU footprint are tested together.

Three shaped rectangular headrails per side now sweep from the upper bow into
the head, with transverse headtimbers, a small grating and a solid curved
cutwater/knee. The initial low-reaching four-rail arrangement was rejected in
assembled Blender inspection. Stable transported timber frames avoid twisting
and pinching the near-vertical stem. Each head frame passes through all three
rails; forward tips embed in the solid knee, and grating bearers reach the hull
and knee. Actual triangle contacts supplement analytic point checks. Hull wales
now share the complete planking grid, including gunport boundaries; midpoint
rays check their returns against the rendered skin, not only its analytic loft.
Bowsprit support leads meet the current skin. A compact shield and
crown replace the ring-shaped figurehead placeholder. This remains simplified
authored royal-arms decoration, not a sculpted copy of the original 1803 arms.

The fit changes integrated volume at the chosen waterline from 4,747.85 to
4,781.93 m³ (+0.72%), and waterplane area from 765.88 to approximately 809 m². At the
model's 1,025 kg/m³ seawater density that is 4,901.48 tonnes. The default
manifest's fixed mass is derived from this geometry to retain its chosen
waterline; it is not independent evidence for historical displacement.
Independent numerical quadrature checks convergence, buoyancy and declared
mass accounting. Positive model stability does not validate its authored
centre of gravity or damping against sea trials.

## Original and reconstruction plans

| Record | What it establishes | Caveat |
|---|---|---|
| [RMG ZAZ0122, inboard profile](https://www.rmg.co.uk/collections/objects/rmgc-object-79913) | Deck levels, riders and mast relationships; 1:48 | Museum dates it c.1788, after an earlier mast repositioning, before the 1800–03 reconstruction |
| [RMG ZAZ0123, orlop](https://www.rmg.co.uk/collections/objects/rmgc-object-79914) | Internal lower layout; 1:48 | Same earlier configuration |
| [RMG ZAZ0124, lower gun deck](https://www.rmg.co.uk/collections/objects/rmgc-object-79915) | Deck outline, apertures and longitudinal arrangement; 1:48 | Same earlier configuration |
| [RMG ZAZ0125, middle deck](https://www.rmg.co.uk/collections/objects/rmgc-object-79916) | Middle-deck layout; 1:48 | Same earlier configuration |
| [RMG ZAZ0120, body/sheers/half-breadth](https://prints.rmg.co.uk/collections/ship-plans/products/body-plan-for-hms-victory-1765-j1842) | Rounded bilges, tumblehome, bow/stern form | Dated c.1830 but explicitly depicts a **pre-1803** arrangement; gun-port layout differs from Slade's 1759 plan |
| [RMG LEB0009, complete sail plan](https://www.rmg.co.uk/collections/objects/rmgc-object-534301) | Full-rigged silhouette, waterline starboard elevation | Basil Lavis, 1921 reconstruction; catalogue has no downloadable image on the inspected page |
| [Science Museum, Callender's official-plan reductions](https://collection.sciencemuseumgroup.org.uk/documents/aa110066605/the-model-makers-plans-of-h-m-s-victory-reduced-from-the-official-plans) | Set includes body, sheer, half-breadth, inboard/outboard, poop, quarterdeck/forecastle, upper deck and rigging | Published 1936; reduced from Navy/Admiralty plans dated 1759 and 1805, not one uniform-date original |

The [Brunel Institute's MacGregor collection catalogue](https://www.ssgreatbritain.org/wp-content/uploads/2021/05/david-macgregor-ship-plans-collection-july-2013.pdf) identifies additional 1805 reconstruction sheets: 2012.02935 sail/rig profile; 2012.02952–53 body/stern; 2012.02954 upper-deck belaying positions; 2012.02958–60 sail cloth layout. These catalogue descriptions are leads for refinement, not evidence that their full-size drawings were acquired or traced.

RMG credits the plan reproductions to the National Maritime Museum/Crown and provides image licensing links. Online access is not a blanket asset redistribution licence. No museum image is bundled as a game texture or under the project's MIT licence. Wharton's 1884 text is public-domain historical material; the Project Gutenberg edition supplies its own jurisdictional reuse notice.

## Rig and construction priorities

Victory needs three stepped masts with square courses, topsails and topgallants; a mizzen spanker and fore-and-aft headsails complete the recognisable rig. Fighting tops are open working platforms supported at the lower-mast heads, with shrouds and ratlines below them. They should not be represented by a medieval barrel crow's nest. Exact yard dimensions, mast rakes and sail subdivisions remain plan-derived work rather than verified numerical offsets in this ledger. The Lavis/Callender records above are the next dimensional references.

An unusually strong size anchor survives: NMRN reports Victory's original fore topsail at **80 ft foot × 54 ft head × 54 ft depth** (24.384 × 16.4592 × 16.4592 m), with nominal area 3,618 sq ft (~336.1 m²). This validates a large trapezoidal topsail rather than a generic triangular caravel sail. The area is the museum's reported cloth figure; it need not equal a flat trapezoid fitted to curved edges. [NMRN conservation article, 28 November 2024](https://www.royalnavymuseums.org.uk/news/caring-hms-victorys-fore-topsail).

NMRN confirms **104 guns at Trafalgar**, including surviving lower-deck long 32-pounders and middle-deck long 24-pounders. It also distinguishes dark tarred standing rigging from pale running rigging and explains that the surviving spars/rigging include modern replacements. [Museum conservation log](https://www.royalnavymuseums.org.uk/hms-victory-conservation-log). Do not infer 1805 mast construction from current wrought-iron lower masts: they were installed in 1894 from HMS Shah. [NMRN mast conservation, 14 May 2021](https://www.royalnavymuseums.org.uk/news/hms-victorys-lower-mast-removed-temporarily-analysis-and-conservation).

Wharton's older armament table explicitly describes **1778**, not Trafalgar. It must not be relabelled an 1805 deck schedule. His text does separately identify the two 68-pounder forecastle carronades and absence of poop guns at Trafalgar. The initial model can represent the three principal gun batteries and upperworks without claiming an exact surveyed port/gun schedule.

Visible priorities: full three-decker hull with tumblehome; three repeated battery bands following sheer; real port recesses and lids; bluff but rounded bow, beakhead and projecting bowsprit; squared multi-level stern galleries; continuous lower hull/copper sheathing; forecastle, open waist, quarterdeck and poop; ship's wheel/binnacle on the quarterdeck; boats, hatches, capstans, anchors and catheads; stepped masts, fighting tops, cross-trees and distinct standing/running rigging. These are modelling requirements inferred from the construction references, not measurements supplied by the dimension table.

## Authored square-sail dimensions

The current procedural plan uses the following metre dimensions. **Only the fore-topsail's 54/80/54 ft head/foot/depth and 3,618 sq ft area are supported by the surviving sail's museum report.** The other tiers and all camber values are authored reconstruction proportions pending a measured sail schedule. These are nominal areas; raised foot contours and backing contact modify the instantaneous surface.

| Sail | Head width m | Foot width m | Depth m | Nominal area m² | Maximum belly m |
|---|---:|---:|---:|---:|---:|
| Fore course | 23.99 | 20.69 | 12.85 | 287.1 | 2.17 |
| Fore topsail | 16.46 | 24.38 | 16.46 | 336.1 | 1.80 |
| Fore topgallant | 12.99 | 17.39 | 8.27 | 125.6 | 1.09 |
| Main course | 26.20 | 22.45 | 14.41 | 350.5 | 2.46 |
| Main topsail | 20.91 | 24.43 | 17.39 | 394.2 | 2.03 |
| Main topgallant | 14.62 | 19.59 | 8.69 | 148.7 | 1.23 |
| Mizzen topsail | 13.74 | 15.94 | 13.09 | 194.2 | 1.28 |
| Mizzen topgallant | 9.47 | 12.77 | 6.99 | 77.7 | 0.90 |

Maximum belly represents full deployment, full fill and unit pressure before support contact, approximately 10–17% of these tier depths. It is not a calibrated textile or aerodynamic measurement. The mizzen crossjack remains a bare yard, rather than an extra square course.

Victory's working bower equipment is likewise authored: a 4,000 kg anchor, approximately 3.4 m shank and 4.8 m timber stock, 16 cm diameter hemp rode and 260 m maximum rode. The finite holding estimate is approximately 314 kN. These equipment assumptions distinguish it from the smaller caravel's 240 kg anchor; they do not certify historical anchor scantlings, seabed holding or capstan performance.

## Pre-implementation compatibility audit

The following records the starting architecture inspected before this implementation. It identifies what the Victory work must replace; it is not a report that these limitations remain in the completed build. A scaled Niña would be an inadequate Victory implementation.

1. `js/ship-models.js`, `js/rig-definition.js` and `js/ship-mesh.js` accept only the ready `lateen3` backend/Niña builder. Add a genuine model/backend instead of bypassing readiness checks.
2. `js/sailing.js`, `js/sail-aerodynamics.js`, `js/lateen.js` and `js/wgsl/lateen.js` assume three lateen sail poses. Preserve three **mast control groups** while allowing multiple actual sail panels, correct bracing, reefing and independently placed cloth corners. Rendering, force integration, shadows, wetness and rope endpoints must evaluate the same posed geometry.
3. `js/boat.js` integrates a canonical Niña hull and a twelve-person manifest. Victory needs its own immersed-volume/waterplane model, draught and stability parameters; reported tonnage must not become mass by a unit conversion. A small visible crew is a render budget, not the historical complement.
4. `js/hull.js` exports Niña deck, helm, tiller, cathead and hull functions. Vessel-local deck/camera/crew/anchor nodes and water exclusion must follow Victory's actual levels and dimensions. A wheel must operate its steering linkage rather than make the Niña tiller visible through the deck.
5. Fleet rendering currently has two vessel slots. A player-selected Victory plus existing companion fits that count; a three-ship fleet still requires separate renderer expansion. Camera extent must include yards, mast height and bowsprit rather than hull length alone.

Acceptance: finite closed hull, connected structures, distinct gun-port openings, crew on actual decks, matching CPU/GPU square-sail pose, model-specific hydrostatics, sensible captain view, correct cast shadows and wetness, reproducible build, and actual rendered inspection from both broadsides, bow, stern and above. Numerical dimensions alone do not establish historical accuracy or a calibrated sailing model.

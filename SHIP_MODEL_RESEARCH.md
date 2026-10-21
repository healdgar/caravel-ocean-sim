# Fleet reference metadata — 20 October 2026

These are reported reconstructions or estimates, not measured dimensions of the
lost 1492 vessels. Keep each source's subject, length basis and tonnage meaning.
Do not average different reconstructions or silently substitute them for the
current authored 20 × 6 m caravel.

## Modern replica profiles

| Reference vessel | Reported dimensions | Reported tonnage | Sail area |
|---|---|---|---|
| Sanger Ships Niña | Deck length 65 ft (19.812 m); beam 18 ft (5.4864 m); draught 7 ft (2.1336 m) | 75; source calls it tonnage, basis/unit unspecified | 1,919 ft² (178.281 m²) |
| Sanger Ships Pinta | Deck length 85 ft (25.908 m); beam 23 ft (7.0104 m); draught 7.5 ft (2.286 m) | 101; source calls it tonnage, basis/unit unspecified | 3,800 ft² (353.032 m²) |
| Fundación Nao Victoria Santa María | Length 28.30 m, length convention unspecified; maximum beam 7.96 m; **puntal 3.49 m is hull depth, not draught** | Approximately 200 toneladas, described as weight; loading condition unspecified | 300 m² |

Niña/Pinta: [operator's earlier technical page](https://www.ninapinta.org/index.html),
retrieved through its indexed text; direct retrieval was unavailable during this
audit. The [current operator page](https://www.ninapinta.net/) confirms that its
Pinta was enlarged for visitors. Its various enlargement comparisons disagree;
do not use them to derive original dimensions. It describes its Niña as square
fore/main with lateen aft canvas, unlike our requested all-lateen game Niña.

Santa María: [builder/operator technical page](https://www.fundacionnaovictoria.org/es/la-construccion-nao-santa-maria/).
It lists three masts plus bowsprit, four named deck levels, and five sails:
maincourse, maintopsail, lateen mizzen, spritsail and forecourse. The reported
mainmast reaches 25 m above the waterline. This is a modern replica's specification.

## Alternative historical interpretations

- [Mariners' Museum Niña catalogue](https://catalogs.marinersmuseum.org/object/CL21542):
  approximate length 67 ft (20.4216 m), beam 21 ft (6.4008 m), draught 7 ft
  (2.1336 m), **58–60 tons capacity**. Length convention and the capacity-ton
  standard are unspecified. Its model has four masts, two square and two lateen;
  its rig is not our three-mast lateen interpretation.
- [Baiona municipality's 2026 Pinta guide](https://www.baiona.gal/wp-content/uploads/2026/02/Revista-Arribada-2026.pdf),
  PDF page 8: length 23 m, unspecified convention, three masts, square rig,
  estimated cargo capacity **80 toneladas castellanas**. It prints an approximate
  equivalent of 71 toneladas; retain the original capacity statement without
  treating either number as displacement mass. This report supplies no beam or
  draught. The local museum replica was installed in 1993.

The [Barcelona Maritime Museum Santa María model](https://www.mmb.cat/en/colleccions/model-ships/model-carrack-santa-maria/)
supports square fore/main and lateen mizzen for the nao/carrack interpretation.
The requested foremast lookout platform should remain an explicit authored
attachment, not a verified historical claim. A [guide to Spain's earlier official
replica](https://upload.wikimedia.org/wikipedia/commons/6/68/Books_from_the_Library_of_Congress_%28IA_officialguidehis00stev%29.pdf)
instead places its crow's nest on the **mainmast**; replicas differ.

## Definition contract

Store `referenceMeasurements` separately from simulation parameters: subject
(`modern-replica` or `historical-estimate`), source URL, raw value/unit, measurement
kind (`deck-length`, `length-unspecified`, `beam`, `draught`, `hull-depth`,
`capacity`, `tonnage-unspecified`, `reported-weight`), uncertainty and notes.
Metric conversions preserve the reported precision; their extra digits are not
evidence of survey accuracy. Leave unknown measures null.

Simulation mass, ballast, displacement, inertia, sail coefficients and attachment
coordinates remain independently authored and hydrostatically checked. Neither
capacity tons nor unspecified tonnage supplies kilograms for the force model.
Pinta can share caravel component roles with a square fore/main rig definition;
Santa María needs its own hull/deck hierarchy, not just a scaled Niña mesh.

## Pinta / Santa María implementation audit

Source/code review, 20 October 2026; no runtime changes or validation in this pass.

The planned definitions correctly preserve unresolved positions and reject play.
Pinta already requests two square courses and a lateen mizzen. Santa María adds
a main topsail and spritsail, matching the five sail names on the builder page.
Three mast control groups can therefore remain; they must not limit sail count.

Rechecking the [current Niña/Pinta operator](https://www.ninapinta.net/) confirms
that its Pinta is a modern, enlarged visitor vessel. Its Niña reconstruction also
uses evidence from a later inventory, rather than our three-lateen interpretation.
Its modern below-deck crew accommodation is not an original deck plan. The older
exact dimension table above remains indexed evidence, not a newly surveyed hull.
Neither that table nor Baiona's length/capacity estimate supplies hull offsets,
mast positions, individual sail dimensions or a defensible displacement.

The [Santa María builder](https://www.fundacionnaovictoria.org/es/la-construccion-nao-santa-maria/)
names Principal, Castillo, Tolda and Toldilla: separate deck levels, not evidence
of four full-length decks. The replica uses wood-covered fibreglass construction.
The [Barcelona museum model](https://www.mmb.cat/en/colleccions/model-ships/model-carrack-santa-maria/)
was made in 1964; it supports a rig interpretation, not original construction
measurements. Santa María's planned graph still lacks an explicit poop-deck role;
its user-requested foremast lookout placement remains unverified.

### Smallest coherent playable Pinta

Implement one three-sail mixed rig before adding Santa María or a third fleet
slot. Reuse caravel building primitives and force equations, with an independent
Pinta design and independently allocated running state. Extract the existing
square-cloth evaluator from Victory only far enough to accept model-owned sail,
spar, support and rope descriptors. Combine two such square courses with an
actual lateen mizzen; Victory's gaff spanker is not a lateen replacement.

Current blockers are concrete: `createVictorySailGeometry()` imports Victory's
twelve sails and vertical scale; CPU/WGSL motion imports its support/rope arrays
and brace stops; `hull.rig.w` distinguishes only Niña/Victory. Most other model-ID
branches silently select Niña for anything else. Merely allowing another backend
name would bypass protection without supplying a working model.

| Implementation owner | Files / responsibility |
|---|---|
| Vessel geometry | New `js/models/pinta.js` and mesh builder; `js/ship-mesh.js`, `js/hull.js`, `js/wgsl/hull.js`: own hull/deck profile, joined structure, scale and attachment points. Caravel primitives may be shared; shape and dimensions remain explicit. |
| Rig / sail physics | `js/lateen.js`, `js/victory-motion.js`, corresponding WGSL, `js/sail-aerodynamics.js`, `js/sailing.js`: descriptor-driven square/lateen poses, model-specific brace/contact limits, actual sail areas, paired sheets and independently resolved rope leads. One posed surface serves forces, rendering, shadows and wetting. |
| Ship integration | `js/ship-models.js`, `js/rig-definition.js`, `js/vessels.js`, `js/wgsl/vessel.js`: resolved nodes and explicit backend dispatch. Preserve the ready guard until every required capability exists; avoid treating Pinta as either binary shader branch. |
| Loading / deck work | `js/boat.js`, `js/crew-work.js`, `js/anchor-state.js`, `js/gunnery-models.js`: hull-derived hydrostatics/inertia, authored loading, routes and helm, anchor equipment and explicit gun attachments or empty armament. Do not inherit Niña's twelve-person manifest or Victory's batteries by fallback. |
| UI / release integration | `js/main.js` and fleet/render bindings: model selection, specification labels and per-instance resources. Keep two slots initially. Three independently selectable ships require the separate ocean-mask/wake/probe/shadow expansion already listed in `SHIP_MODELS.md`. |

Before authoring, select **one** Pinta subject: an explicitly authored 1492-style
reconstruction or the enlarged Sanger visitor replica. Preserve the distinction
in UI metadata. Resolve its hull-length convention, beam/draught profile, deck
breaks, mast/yard/sail proportions, loading and armament without averaging the
incompatible reports. Unsupported choices should be labelled authored, not
historically calibrated. A named reconstruction drawing can govern proportions;
museum photographs alone cannot establish reliable offsets.

Acceptance requires actual cloth/rope clearance on both tacks and during
reefing/yard work, CPU/WGSL attachment agreement, load/freeboard and inertial
checks, crew-route containment, per-instance independence and a visible sailing
check. The retained-yard bad-tack defect documented in `SAILING_MODEL.md` must not
be copied into the new lateen. Keep Pinta planned until those checks pass. Santa
María follows with its own nao hull/deck hierarchy and an explicit lookout
decision; the three-ship fleet and physical-iPhone 30 FPS check follow that.

## Later vessel reference starting points

Requested sequence after the 1492 fleet: c. AD 850 Viking longship; c. AD 350 Roman
galley; AD 1492 Caribbean canoe for 30 people; HMS Victory in 1805. This records
targets and research leads, not selected plans, finished specifications or runtime
support. All require dimensions and load/displacement evidence before modelling.

- **Viking:** the [Museum of the Viking Age's Oseberg account](https://www.vikingtidsmuseet.no/english/viking-age/viking-ships/the-oseberg-ship.html)
  describes a sail-and-oar vessel built in the 820s, 21.5 m long and 5 m wide,
  with 15 oar holes per side. It is a nearby-period archaeological reference,
  not an exact AD 850 narrow war-longship specification. The [Viking Ship Museum's
  longship study](https://www.vikingeskibsmuseet.dk/frontend/Dokumenter/Skuldelev2_b.pdf)
  distinguishes broader ninth-century Norwegian finds from the narrower later
  longships. Select a defensible hull/rig interpretation for the requested period
  before adopting dimensions or decorative reconstruction details.
- **Roman:** [LEIZA's Museum of Ancient Seafaring](https://www.leiza.de/museen/museum-fuer-antike-schifffahrt)
  holds the Mainz Roman wrecks and reconstructions. Treat those as a research
  collection, not automatic approval of a particular AD 350 seagoing galley.
  Vessel class, operating waters, steering, rig and rowing arrangement remain
  unresolved. Do not borrow a classical trireme or later medieval galley solely
  because it matches a familiar silhouette.
- **Caribbean:** the [1492 journal account reproduced by Northern Virginia
  Community College](https://pressbooks.nvcc.edu/ushistory/chapter/journal-of-christopher-columbus-1492/)
  describes single-tree canoes, paddles and some carrying 40–45 people. That
  supports a substantial paddled-canoe design space; it provides neither exact
  hull offsets nor proof that 30 occupants means 30 paddlers. The requested
  30-person capacity is our design target. Select a regional/cultural basis and
  document reconstruction choices rather than generalizing every Caribbean canoe.
- **Victory:** the [Royal Navy Museums' HMS Victory page](https://www.royalnavymuseums.org.uk/visit-us/portsmouth-historic-dockyard/hms-victory)
  identifies Nelson's Trafalgar flagship and describes 1805 service with 104 guns
  and 820 people. Use **1805 configuration** as the working target, pending any
  user correction; obtain period plans and dated rig/deck specifications before
  authoring. A game reconstruction of the sailing vessel must distinguish
  historical structure from modern preservation supports and visitor alterations.

These reference crew figures describe their sources; they are not approved
runtime agent counts or substitutes for mass, ballast and hydrostatic data.

The later programme also includes **Flying Cloud**, replacing a generic schooner,
and **Gipsy Moth IV** (the working interpretation of "Gypsy Moth"). Both are planned:

- [The Mariners' Museum's Flying Cloud record](https://catalogs.marinersmuseum.org/object/CL14156)
  identifies Donald McKay's 1851 American clipper. Its lines, deck layout and
  complete sail tiers need dedicated references; Victory's hull must not be reused.
- [Royal Museums Greenwich's Gipsy Moth IV record](https://www.rmg.co.uk/collections/objects/rmgc-object-13959)
  identifies Chichester's ketch for the 1966–67 voyage. Obtain the original yacht's
  hull and rig plans before choosing dimensions or cockpit/crew attachments.

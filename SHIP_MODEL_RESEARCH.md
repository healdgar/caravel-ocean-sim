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

## Build subjects and specification dossiers — 21 October 2026

Source review only; no new vessel is playable. The choices below refine the
earlier research leads. `reported` values retain their source's subject and
measurement convention; `authored` means a game/reconstruction choice. Unresolved
draught, displacement, ballast and sail areas stay null in historical metadata.
Each runtime model still needs its own immersed hull, loading manifest, mass
distribution, steering equipment and actual propulsion attachments.

### Viking c. 850: Oseberg-based coastal sailing/rowing vessel

**Build choice:** an explicitly labelled Oseberg-based interpretation in a c. 850
scenario, using the actual AD 820 vessel rather than implying an excavated 850
warship. Reported hull length **21.5 m**, beam **5 m**, **15 oar holes per side**;
museum crew interpretation **32: 30 rowers, helmsman and lookout**. The source
does not identify that length as LWL. Oak hull, pine deck/mast/oars.
[Museum of the Viking Age, current Norwegian account](https://www.vikingtidsmuseet.no/vikingtiden/vikingskip/osebergskipet.html).

Use a low-freeboard, clinker-planked, double-ended hull, structural keel,
starboard steering oar and one square-sail rig as the reconstruction brief.
Exact sail area, loaded draught/displacement and ballast require a named sailing
reconstruction. Prefer the revised **Oseberg Project 2006 / Saga Oseberg** hull
interpretation: Roskilde's reconstruction team documents corrections to bow,
keel rocker and displayed hull assembly, prompted by the earlier *Dronningen*
replica's failed trials. Do not trace the old museum silhouette and claim its
hydrodynamics are established.
[Reconstruction team's account and hull drawings](https://www.vikingeskibsmuseet.dk/en/professions/boatyard/building-projects/the-oseberg-ship).

Required parts: 30 physical oar stations, steering-oar pivot/immersion, mast step,
yard/sheet/brace leads, clinker strakes and removable/working rowing space.
Crew rendering count may differ from the manifest; mass must not disappear when
agents are hidden.

### Roman c. 350: Mainz-type lusoria, 18 m reconstruction branch

**Build choice:** a fourth-century river patrol craft, not a classical trireme.
Use the **18 m × 2.8 m Lusoria Rhenana** reconstruction as the initial proportion
reference: operator reports **24 rowers, 12 per side**, mast about **9 m**, an
experimental **20 m² sail**, and roughly **5 tonnes vessel weight**. That last
figure is not documented loaded displacement; do not add 24 people to a
five-tonne *displacement* without resolving its loading basis.
[Replica operator's technical account](https://lusoriarhenana.de/schiff/).

The archaeological basis is incomplete Mainz wrecks I/V. Dreyer's 2020 report
explains competing **21.5 m versus at most 18 m** reconstructions; retain the
18 m branch consistently. It describes the later Gallo-Roman boats as
flat-bottomed, oak-built, smooth-planked and iron-fastened. Oars are primary;
sail form and steering arrangements retain reconstruction uncertainty. Do not
combine the longer replica's station spacing with the shorter hull.
[Living Danube Limes technical report, printed pp. 4–5, 7, 10–11](https://www.donau-uni.ac.at/dam/jcr%3A74a2a26d-90e5-41d6-84e1-cfb3cb91738f/LDL_Technical%20features%20of%20Roman%20Danube%20Ships.pdf).

For proportions seek the actual reconstruction lines and hydrostatic work:
[Trier University's reconstruction project](https://www.uni-trier.de/universitaet/fachbereiche-faecher/fachbereich-iii/faecher/geschichte/profil/fachgebiete/alte-geschichte-1/nachbauten-antiker-schiffe/roemisches-militaerschiff-lusoria)
and [Hochschule Trier's 3D reconstruction](https://www.hochschule-trier.de/hauptcampus/technik/labor-fuer-digitale-produktentwicklung-und-fertigung-ldpf/projekte/lusoria-rhenana-3d-rekonstruktion-eines-spaetroemischen-flusskriegsschiffes).
The c. 350 label is a scenario approximation, not a precise wreck construction
date. Draft, service complement beyond rowers, loaded mass and verified rig
dimensions remain unresolved.

### Caribbean c. 1492: 30-occupant Taíno-style dugout

**Build choice:** a Greater Antillean single-log paddled canoe with a **30-person
capacity**, not automatically 30 active paddlers. Columbus's October account
describes single-tree canoes holding 40–45 people, smaller variants and
shovel-shaped paddles; it supplies no usable offsets, beam or loaded draught.
This is a European observer's translated account, not an Indigenous construction
manual. [Journal extract, Markham translation, pp. 37–68](https://pressbooks.nvcc.edu/ushistory/chapter/journal-of-christopher-columbus-1492/).

The Florida Museum identifies Caribbean ceiba single-trunk canoe construction;
its modern Jamaican illustration is a comparative construction reference, not a
1492 survey. [Caribbean Archaeology Program](https://www.floridamuseum.ufl.edu/caribarch/education/ceiba/).
No retrieved primary reference establishes our 30-person hull dimensions.
Start layout exploration at an **authored 14 m × 1.8 m**, then resolve shell
thickness, occupants/paddle clearances, wood mass, stores, stability and freeboard
before freezing geometry. This is a design target, not historical metadata.
Use a dugout shell and paddle propulsion; add neither an inherited European keel
nor an unsupported sail rig. Paddling stations, steering paddle, cargo and bailer
positions need explicit attachments.

### Flying Cloud, 1851: McKay full-rigged clipper

**Build choice:** the 1851 American clipper, replacing the generic schooner.
The Mariners' Museum's **CL17938** record transcribes a Currier composition's
inscription as keel **208 ft (63.3984 m)**, deck **225 ft (68.58 m)**, and
knightheads-to-taffrail **235 ft (71.628 m)**; beam **40 ft (12.192 m)** and
hold depth **21½ ft (6.5532 m)**. These are three distinct length conventions;
hold depth is not draught. The accession is a c. 1912–25 restrike of an
1852 composition. Its transcribed **1,139 register tons** conflicts with the
same record's **1,782 tons** vessel notes. Preserve both reports as unresolved
tonnage, never kilograms. [Museum catalogue and inscription](https://catalogs.marinersmuseum.org/object/CL17938).

Use an independent fine-ended clipper hull and three-mast full square rig as the
modelling brief. Exact underwater profile, deck breaks, sail tiers/areas, spar
positions and crew complement still require plans or a contemporary inventory;
neither the print nor a tonnage number establishes them. Avoid importing
Victory's batteries, hull or sail dimensions. A second museum reference is the
[Smithsonian rigged model TR.319491](https://americanhistory.si.edu/pt/collections/object/nmah_1384460).
For traceable plans/research, Mystic's **Alexander G. Law Collection, box 3,
folder 4**, explicitly contains *Flying Cloud* material; those are later model
research records, not automatically surviving builder's offsets.
[Collection finding aid](https://research.mysticseaport.org/coll/coll261/).

#### Working rig inventory audit — 22 October 2026

The [Boston Daily Atlas report of 25 April 1851](https://www.sobco.com/ship_model/BDA/1851-04-25.html)
explicitly lists a **56 ft crossjack yard**, **24 ft main-Spencer gaff**,
**55 ft spanker boom** and **40 ft spanker gaff**. This is the contemporary
text through a modern transcription; the original newspaper facsimile was not
checked. The report confirms those spars, but its yard table does not establish
the lowest mizzen sail's cloth dimensions or when that cloth was set. Do not
infer fifteen working square sails merely from fifteen yards, or infer a bare
crossjack solely from Victory's different configuration. Main-Spencer hardware
has direct textual support; its working cloth remains an authored interpretation.

The Museum of Fine Arts' own **April 1935 Bulletin, p. 25**, describes Boucher's
Flying Cloud model as built from original plans/data under Arthur H. Clark,
with all sails set. That establishes the museum's stated model provenance,
not a recovered sail inventory for our mesh. The
[museum publication](https://gizamedia.rc.fas.harvard.edu/images/MFA-images/Giza/GizaImage/full/library/bmfa_pdfs/bmfa33_1935_21to25.pdf)
was readable, but its relevant model image was not available for detailed
identification. The [museum-contributed catalogue record, 35.42](https://luna.davidrumsey.com/amico135996-17603.html),
dates Boucher's model to **1915**; later references calling it 1916 should not
silently replace that catalogue date.

Bradner's [individual-sail reconstruction index](https://www.sobco.com/ship_model/fc/Flying_Cloud_Plans_Bradner/indexes/Index-Flying_Cloud_Individual_Sails.htm)
includes a mizzen “Skip Jack” sail and main Spencer. It is a useful later
interpretation, not independent proof of the 1851 canvas inventory. The current
model retains a working crossjack with this uncertainty explicit. Its **25 cloth
surfaces and 15 yards** are implementation counts. Individual cloth dimensions,
the mizzen staysail selection, chainplate spread, raised crossjack foot and gaff
sheet stops remain authored; passing geometric clearance tests cannot certify
their historical accuracy. The raised foot derives from actual spanker-boom
clearance. Contact-classification defects must be fixed in the shared evaluator,
not excused by deleting uncertain canvas or repeatedly moving fittings.

### Gipsy Moth IV, 1966: original-voyage Bermudan ketch

**Build choice:** Chichester's original-voyage yacht, keeping departure and later
Sydney keel modifications distinguishable. Builder-archive notes by Jeremy Lines,
reprinted in February 2024, report **LOA 53.1 ft; LBP 42.7 ft; LWL 38.5 ft;
beam 10.5 ft; draught 7.75 ft; displacement to DWL 23,320 lb (about 10.58 t);
original lead 8,490 lb (about 3.85 t)**. **19 Thames Measurement tons** is a
separate tonnage measure. Additional ballast after trials and an aft keel
extension in Sydney mean the original DWL figure is not a verified mass for
every voyage stage. [Builder-archive notes, Nautipedia reprint](https://www.nautipedia.it/2024_02_Review:_Behind_the_scenes_of_a_famous_adventure:_Yard_No._916_GIPSY_MOTH_IV).

The newsletter's original Mailchimp link now redirects; the verified text here
is the attributed reprint. It identifies **19 digitised Gosport drawings** and
34 Greenwich drawing entries as further plan leads. Those are the next source
for keel/rudder profile, mast/boom placement and sail dimensions. A
[later broker's 1966/2005 specification](https://boatmanager.sandemanyachtcompany.co.uk/uploads/pdf/GIPSY_MOTH_IV%20-%20Sandeman.pdf)
instead reports **16 tonnes**, **39 ft 1 in LWL**, cold-moulded mahogany and a
Bermudan ketch. Keep that restored-vessel report separate; do not average it
with original DWL displacement. The historical voyage is single-handed;
subsequent training crews are a different manifest.
[Royal Museums Greenwich's voyage/rig account](https://www.rmg.co.uk/collections/objects/rmgc-object-13959).

Use separate main/mizzen booms, headsail leads, cockpit, steering and ballast/keel
geometry. Shared force/rig primitives may serve it; three-mast caravel controls
must not dictate its two-mast structure. Museum painting dimensions are object
measurements, not yacht dimensions.

### Source-to-model gates

Before any of these enters the playable registry: record the selected subject
and reconstruction branch; freeze a proportion/attachment drawing; separately
author permanent mass, ballast, people, provisions and cargo; integrate the
immersed hull at that load; distinguish geometric lateral centroid from measured
dynamic CLR; and validate propulsion, steering, working space and animation
clearances. Oared hulls must not acquire the Niña manifest or sail backend by
fallback. Reference photographs/plans remain reference material; no source image,
paid asset or new model was downloaded or promoted in this research pass.

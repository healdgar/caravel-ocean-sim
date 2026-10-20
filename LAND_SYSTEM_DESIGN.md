# Land, voyages and river navigation

Design and implementation status, 20 October 2026. The first visual landfall slice
is implemented: Saba elevation, generated canopy, atmospheric coloration,
terrain/cloud shadows, approximate shore response and a world overview chart.
Use `?landfall=approach&boat=1`. This single resident region has no terrain streaming,
ports or voyage compression. Its underwater skirt and clearance constraint are
approximations, not hydrographic grounding. See `assets/world/README.md` for provenance.
The agreed future target is **15–20 minutes of open-ocean sailing per typical voyage**,
plus coastal navigation, docking and optional encounters.

## Playable scope

Build **selected, meaningful game spaces**, not a detailed navigable globe. A
lightweight geographic atlas can supply optional world context, expedition
selection and chart references. It does not commit the game to generating,
storing or seamlessly sailing every coastline or inland area.

Initial region families are:

- **Virgin Islands:** connected island-hopping waters, channels, approaches and
  selected ports. Neighboring shores visible across a channel share a continuous
  local metric region; preserve the real channel geometry.
- **Columbia and Hudson:** selected contiguous navigable river reaches with
  meaningful bends, bars, currents, junctions or berths. Their expedition modules
  are separate from the Caribbean; no geographic portal between them is implied.
- **Cuba and Hispaniola:** coastal strips arranged around each island's **closed
  coastline**, with connected sea routes and selected bays, headlands and ports.
  The interior is inaccessible except where an explicit river or other playable
  module opens it. Strip width follows the navigation problem and sightlines,
  rather than one fixed kilometre buffer.

Large-island interiors still need coherent relief and real broad silhouettes for
all supported viewing directions. Use low-cost elevation/color proxies behind
the detailed coastal ring, including inland ridges visible from offshore. They
are visual backdrops, not an implied explorable terrain simulation. Close the
land surface behind the strips: no holes, abrupt inland cliffs, missing horizon
mass or exposed module edges when the camera looks inland. Detailed modules join
this backdrop at fixed, tested seams.

Region boundaries are content and streaming boundaries, not visible scale
changes. Positions, elevations, shorelines, vegetation and distant proxies must
agree across them. Islands stay fixed when the destination or approach changes.
This regional plan replaces any implied whole-Caribbean or whole-world detail
generation requirement. **Only the single Saba visual MVP exists today**; the
region families, coastal rings and river reaches below are plans.

## Core decision

Keep the ship, water, wind, crew and controls running at ordinary simulation speed. Shorten the navigable space between detailed regions. Maintain a geographic chart alongside this compressed playable world.

The player sails at six knots through the water while covering geographic distance faster offshore. Near a harbor, reef or riverbank, a metre becomes a metre again. Better sail handling still yields earlier arrival; a becalmed ship does not advance automatically.

This requires a geography layer, not a faster physics clock. The current custom WebGPU renderer can accommodate it without replacing the engine, but terrain, bathymetry, streaming and grounding are new systems.

## Source data

Use downloadable source data to build our own regional assets locally. A map picture alone provides neither terrain height nor underwater clearance.

| Source | Use in this game | Constraints |
|---|---|---|
| [OpenStreetMap](https://www.openstreetmap.org/copyright) and [processed coastlines](https://osmdata.openstreetmap.de/data/coastlines.html) | Coastlines, islands, river outlines, place names and selected geographic features | ODbL attribution and applicable derivative-database sharing obligations. Coverage and completeness vary. Download extracts; do not use the public tile service as an asset CDN. |
| [Copernicus GLO-30](https://dataspace.copernicus.eu/explore-data/data-collections/copernicus-contributing-missions/collections-description/COP-DEM) | Island relief, hills and distant silhouettes | Global 30 m surface model, including vegetation/buildings; not uniformly bare-earth terrain. Retain required attribution and clean up modern structures. It supplies no riverbed survey. |
| [GEBCO](https://www.gebco.net/data-products/gridded-bathymetry-data) | Broad seafloor, continental shelves and deep-water context | Public-domain global grid at 15 arcseconds: roughly 400–460 m cells in the Caribbean. Too coarse to determine reef passages or docking clearance. Preserve source-quality information. |
| [NOAA coastal elevation models](https://www.ncei.noaa.gov/products/coastal-elevation-models) and [chart features](https://www.nauticalcharts.noaa.gov/data/gis-data-and-services.html) | Detailed terrain/bathymetry and channel/hazard references where available | NOAA lists Puerto Rico and U.S. Virgin Islands CUDEM products at 1/9 and 1/3 arcsecond spacing. Verify individual tiles, source accuracy, dates and vertical datums. Grid spacing is not survey accuracy. |
| [Natural Earth](https://www.naturalearthdata.com/about/terms-of-use/) | Lightweight Caribbean overview chart and fallback land outlines | Public domain. Its “1:10m” means 1:10 million map scale, not ten-metre detail; unsuitable for tactical coastlines. |
| [Google Earth](https://www.google.com/help/terms_maps-earth/) / [Google Map Tiles](https://developers.google.com/maps/documentation/tile/policies) | Visual inspection or a separately licensed map visualization | Ordinary access does not grant permission to extract and redistribute terrain/imagery as our game assets. Map Tiles also restricts extraction, offline use and storage. Not the proposed terrain pipeline. |
| [Apple Maps](https://www.apple.com/legal/internet-services/maps/terms-en.html) | An authorized embedded map, if ever useful | Its terms restrict copying, extraction and derivative use. Not an open terrain or bathymetry source. |

**Recommended combination: OSM outlines + Copernicus land elevation + GEBCO offshore depth + NOAA/local surveys for playable shores.** Add suitably licensed orthophotography or satellite imagery for the selected region's ground color and biome distribution. Use authored detail where the source cannot resolve a navigational feature; label that provenance rather than inventing survey precision.

Keep OSM-derived geographic data identifiable and distributable with its required license. ODbL obligations concern the data; they do not automatically impose ODbL on our game code. The [OSMF produced-work guidance](https://osmfoundation.org/wiki/Licence/Community_Guidelines/Produced_Work_-_Guideline) distinguishes rendered works from derivative databases. Retain source snapshots, modifications, license notices and reproducible conversion instructions with each pack.

Modern terrain is a starting point for this historical setting. Author period ports and settlements, remove modern infrastructure, and identify historically reconstructed shorelines separately. Present-day river channels and deltas must not be presented as exact historical reconstructions.

### Imagery-seeded regional assets

Use imagery as a measured starting point for the chosen modules, not as a mandate
to download or texture the globe. Orthorectify/co-register it with the regional
elevation and coast data; record acquisition date, resolution, season, color
processing and uncertainty. Imagery supplies surface appearance; a height model
supplies terrain geometry and separate depth data supplies navigable water.

Preserve broad real colors and transitions between vegetation, sand, exposed
rock, wet ground and developed areas. Reduce photographed haze and baked shadows
before using the result as ground albedo, so our sun, clouds and atmosphere can
relight it. Do not describe an attractive AI repaint as measured color or infer
surveyed underwater clearance from water color. Authored historical cleanup and
generated close-range detail remain separate, reproducible layers.

Derive broad vegetation/biome masks from the imagery, terrain slope/elevation and
reviewed regional presets. Generate coherent near-shore ground materials,
forests and rocks from those masks. Retain the same low-frequency color field in
the distant proxy; approaching a shore must reveal detail without replacing its
recognizable color or landform. Detail unsupported by the imagery is plausible
authored generation, not recovered photographic evidence.

## Space and clocks

| Layer | Representation | Responsibility |
|---|---|---|
| Geographic atlas | Lightweight WGS84 latitude/longitude outlines and source metadata | Optional world context, real locations, chart, distances and region lookup |
| Playable regions | Local metric coordinates; detailed coastal areas joined by shortened ocean areas | Actual sailing distance, visible terrain, collisions and encounters |
| Local simulation | Metres and seconds, small coordinates around the active region | Existing ship, waves, wakes, spray, crew and camera |
| Voyage state | Route, visited areas, elapsed play time and geographic progress | Pacing, encounter opportunities, saves and ETA |

`simTime`, integration `dt`, animations, wave periods, sail response and cooldowns remain unchanged. Start with the same ordinary clock for weather evolution and tides. If a later campaign needs journeys to consume fictional days of supplies, add an explicit calendar policy; do not feed its clock into physics, the sun or tide height.

### Geographic compression

Use an atlas of regional mappings: within a region, `p = F(g)` maps geographic coordinates to playable coordinates. Near tactical features, `F` is a rigid local projection at 1:1 scale. In empty offshore areas, it maps a long geographic passage onto a shorter playable passage. The ship integrates physical motion in `p`; its chart position comes from `F⁻¹(p)`.

For a simple offshore corridor, geographic progress is approximately `K × physical progress`, where `K` is its distance-compression ratio. This is a consequence of the map, not a multiplier on ship velocity or `dt`.

Build mappings before play, with continuous boundaries, positive Jacobians and no folds or overlapping land. Match position and direction across adjacent regions; preserve lengths and bearings in tactical areas. Account for the mapping when translating chart courses and geographic wind/current directions; never scale wind or current strength by `K`. A route graph helps planning and events but does not steer the player: corridors need navigable width, cross-connections and reversible entry from different bearings.

Do not continuously rearrange islands around the selected destination. Turning back or changing destination must preserve the world, chart position and previously seen landmarks. Nearby islands whose tactical regions overlap belong to one region; retain their channels instead of compressing through them. Large islands use connected coastal regions around a closed island boundary. Their inland backdrop can be simplified, with the real visible ridgelines preserved; important bays, headlands and passages need explicit preservation constraints. An inaccessible interior does not license a gap in the island boundary or a false silhouette.

There is a real compromise: exact global geography, unchanged local scale everywhere and drastically shorter journeys cannot all coexist. Preserve the geographic chart and tactical geometry; allow distortion in empty passage lengths and distant presentation. The mapping and horizon transition must pass a prototype before expanding the selected regional library.

### Pacing example

An illustrative 90-nautical-mile offshore leg takes 15 real hours at six knots. A 50:1 distance ratio gives 18 minutes of offshore play. At four knots it takes 27 minutes; at eight knots, 13.5 minutes. These figures exclude approach and transition regions, and are not predictions for a particular route.

Tune a corridor's playable length against a six-knot reference passage, including its transition lengths. Integrate travel time through the complete mapping rather than applying one multiplier to the entire voyage. The 15–20-minute target is a reference-weather design target, not a guaranteed arrival timer. Bad winds, tacking, detours, combat and deliberate exploration can extend it. Very short island hops can remain shorter.

Budget approaches separately. One nautical mile at six knots takes ten minutes. A 600 m final approach at three knots takes about 6.5 minutes before docking. Consequently, a blanket five-mile uncompressed coastal belt would defeat the pacing goal. Size tactical regions around the actual navigation problem; expose longer coastal passages as such in the voyage estimate.

## Arrival and encounters

The voyage should read as departure → offshore sailing → land sighting → coastal pilotage → harbor → berth. There should be no visible ship acceleration.

1. Preload destination regions and neighboring alternatives while offshore. Use conservative hazard bounds covering small islands, rocks, shoals and missing-data areas, not just distance to the major coastline.
2. Reduce compression through authored transition areas before close landmarks or hazards require normal parallax. Use smooth spatial derivatives; avoid a speed toggle at a fixed radius.
3. Render distant silhouettes from the same regional mapping used by navigation. Blend terrain levels of detail without changing a landmark's bearing or apparent size at handover. Consider mountain height and visibility: a tall island can be visible much earlier than its shoreline.
4. Enter 1:1 space before the first meaningful maneuver, with enough distance for turning and slowing. Broad shoals may require a much larger tactical area than a steep island shore.
5. Keep visible vessels, floating objects and their wakes in the same physical frame. Hailing or combat unfolds at 1:1 scale. Instantiate contacts beyond interaction range and use a persistent encounter region for their resolution; entering or leaving it cannot teleport or rescale visible objects.

The difficult part is the horizon. Haze can soften level-of-detail changes, but cannot conceal arbitrary island resizing in clear weather. Distant proxies must converge on the actual approach geometry before the player reaches it. If a route cannot hide a regional handover, keep more of it continuous and accept a longer voyage. Never force the transition by changing weather or blocking the player's view.

Sweep each proposed movement against region boundaries and hazard envelopes; a fast geographic step must not skip a reef or an encounter. Advance to the first boundary, resolve the mapping, then consume the remaining step. Preload based on maximum plausible ground speed, turn options and load latency. Missing collision/bathymetry data must never be treated as open water: retain coarse conservative coverage, cancel compression early, and surface a loading failure before entry.

### Weather and event pacing

Store broad geographic weather areas and a deterministic voyage seed. Sample their intended local conditions along the voyage, then evolve the existing ocean and sky on ordinary time. Introduce fronts with visible warning and gradual changes in wind/spectrum; fast chart movement must not cause successive instantaneous storms.

Schedule event opportunities using elapsed playable minutes, route progress, location and cooldowns. Give the crossing quiet intervals as well as optional sails on the horizon, flotsam, squalls, wildlife or distress signals. Do not multiply event rolls by compression. Events can be missed or avoided and should not guarantee a fixed arrival time. Persist event identities so circling a boundary or reloading cannot repeatedly regenerate them.

For future fleets, share a physical encounter region among nearby ships. Distant ships can use coarse geographic travel until they approach that region. This is a single-player design; independent compression for nearby multiplayer players would need additional synchronization policy.

## Shores and shallow water

Each detailed region needs land height, bed elevation, water coverage, water level, current vectors, collision features and source-quality metadata. Normalize vertical datums during preprocessing: chart depths, terrain heights and mean sea level are not interchangeable.

Expose one authoritative surface description to rendering and vessel physics:

`sampleEnvironment(position, time) → bedHeight, waterLevel, current, waveConditions, material, dataQuality`

CPU and GPU consumers use the same data and conventions. Rendered water and buoyancy probes must agree about shallow-wave changes and mean level.

The existing deep-water FFT remains the offshore wave source. Coastal work needs depth-dependent attenuation, approximate shoaling/refraction, shelter from land, and breaking/foam near shore. Start with an explicitly approximate coastal model; a complete shallow-water fluid solver is a separate project. Merely drawing an island through today's infinite ocean would leave waves propagating through it.

Grounding uses multiple hull/keel contact samples, loaded draft and local bed height. Low-speed contact, sliding, grounding and release with rising water require physical response; damage can follow later. Harbor structures use simple collision volumes; fenders, anchors and mooring constraints make stopping distinct from setting speed to zero. Current affects speed over ground while sail/drag calculations use velocity relative to the water.

## Rivers

Use the same regional asset format for Caribbean coasts and selected Columbia and Hudson reaches. The Amazon mouth and Mississippi remain possible later modules, not a requirement to map every river. River packs are separate expeditions outside the Caribbean atlas, not geographically adjacent portals. An expedition selection can load them independently; a later wider-world campaign can connect them by travel.

River regions add channel beds, longitudinal water-surface slope, tidal influence where applicable, currents, eddies, bank shelter and restricted turning space. Ocean swell fades inland; wind chop and ship wake remain. Flow should steer and carry the vessel independently of where the bow points. Use an authored/derived flow field first; research hydrodynamic simulation only after navigation works.

Keep widths, bends, bars, junctions and docking areas at 1:1. Do not accelerate past nearby banks: their movement immediately reveals the compression. Offer selected contiguous reaches initially. Later, shorten uneventful reaches during world authoring or provide an explicit passage skip between navigable sectors. Real-scale traversal of an entire long river remains a long session.

Detailed riverbed coverage needs a separate inventory. OSM river outlines and satellite elevation cannot establish navigable depth. The Amazon mouth, in particular, is not solved by adding a global land DEM; use suitable regional surveys or clearly authored gameplay bathymetry.

## Fit to this repository and mobile rendering

Current integration points:

- `js/main.js:updateBoat` adds physical surge/leeway distance directly to `boat.x/z`; retain this contract. Add geographic mapping after the physical step, not inside `stepBoatSurge`.
- `js/boat.js` owns mass, draft, forces and inertia. Add currents and bed contacts without applying travel compression to those forces.
- `js/interaction.js` stores wake-grid origins and world-space particles. Region/origin changes must transform these, camera, shadows, probes, wetness and pending readbacks together. Preserve FFT sampling phase with explicit offsets; do not reset the sea or clear a wake at handover.
- `js/main.js` advances `simTime` and encodes the custom WebGPU passes. Add terrain depth/color with consistent reversed-depth conventions, culling occluded ocean where practical.
- `build.mjs` has explicit readable/minified module lists. New modules need both lists updated when implemented.

The MVP implements `js/terrain-model.js` (regional geometry/clearance), `js/terrain.js`
and `js/wgsl/terrain.js` (rendering), and `js/landfall.js` (entry points/weather/chart).
Future boundaries include `js/world.js` (coordinates/streaming), `js/voyage.js`
(progress/events), and `js/coastal-water.js` (shared environmental sampling).

Preprocess GIS data locally into versioned `assets/world/<region>/` packs. A manifest records geographic bounds, local origin/projection, mapping version, height/depth tiles, hazards, ports, source dates, license notices, datum transformations and checksums. It also identifies playable water/reaches, coastal-strip boundaries, inaccessible interior proxies, explicit inland entrances and adjoining module/seam IDs. Keep gameplay edits separate from source snapshots. Save region/mapping versions and voyage state so an asset update cannot silently move a saved ship onto land.

Stream nearby quadtree terrain tiles; use cheap silhouettes at distance, reusable ground materials, instanced vegetation and simplified distant ports. Decode in a worker and cap resident buffers/textures. Neither the whole Caribbean nor photogrammetric city meshes should be resident. Collision terrain must stay independent of visual LOD and adaptive render resolution.

### Deterministic vegetation and distance detail — planned

Dan Greenheck's [Fractals to Forests / EZ-Tree article](https://tympanus.net/codrops/2025/01/27/fractals-to-forests-creating-realistic-3d-trees-with-three-js/)
is a useful procedural-tree reference: seeded recursive branches, taper, growth
direction, adjustable branch tessellation and leaf cards. Its implementation
does **not** use L-systems. Our distance-LOD and regional placement rules below
are a proposed adaptation, not a feature established by that article or our MVP.

- Derive stable tree IDs, position, species preset, height, crown size and shape
  seed from the regional vegetation layer. Generate these independently of
  camera distance and terrain-tile load order. Give shared-border instances one
  owner so adjacent strips cannot duplicate or move them.
- Generate each canonical branch skeleton from its stable seed, then derive
  lower-detail meshes and impostors from that same tree. Changing tessellation
  must not consume a different random sequence that changes the tree's form.
  Reuse a bounded library of variants where appropriate; avoid generating a new
  detailed mesh for every approaching tree during a frame.
- At distance, show canopy color/height masses; nearer, use clusters or tree
  impostors; closest, use instanced trunks, major branches and foliage. Preserve
  tree locations, physical sizes, canopy coverage and silhouette through the
  handovers. Distance changes representation, not growth, density or placement.
- Select detail by projected size and budget, with hysteresis and smooth
  transitions. Wind phase and broad shadowing remain consistent across levels.
  Keep collision and navigation envelopes independent of the visual tree LOD.
- Implement or preprocess the useful algorithms for our **native WebGPU/WGSL**
  renderer. Do not introduce a Three.js runtime to render the land or trees.
  Check the project's license before reusing its code or exported assets.

Acceptance includes repeated approaches, turns, region reloads and seam crossings
with identical tree identities; no popping in position/scale, floating trunks or
canopy-color jumps; and measured ocean-plus-land cost on iPhone. The existing
generated Saba canopy does not establish this full tree pipeline.

Initial performance acceptance: measure combined ocean + land on the actual iPhone against the existing 30 fps target. A provisional land budget of 2–4 ms GPU and 64 MB additional resident assets is a starting allocation, not a measured capability or a guarantee that the current frame has that headroom. Bound tile uploads and avoid compilation/decode spikes during approach.

The current single-file ocean demo can remain self-contained. Selected-region builds will use optional static regional assets hosted with Pages, copied by the build with versioned URLs. Loading a streaming region from `file://` will not be supported; use HTTP or an explicitly packaged offline region. No runtime Google/Apple API key is required for the recommended source stack.

## Implementation sequence and acceptance

Completed precursor: one visual Saba region, selected for a distinctive landfall
silhouette and a small distributable elevation pack. This validates rendering,
not the spatial compression, coastal rings, tree LOD or harbor systems below. A
selected Virgin Islands island-hopping module is the preferred next coastal
pilot; source coverage and navigable depth must be inspected before selecting
its exact shores and port.

1. **Prove spatial transitions.** Two small test shores, a shortened ocean corridor, geographic chart and reversible approaches. Inspect clear-weather silhouettes, arbitrary turns, alternate approaches and boundary crossings. No whole-world import yet.
2. **Build one real region.** Select a Virgin Islands harbor and neighboring island leg after inspecting imagery, elevation and bathymetry. Add imagery-seeded terrain/color/biomes, deterministic vegetation detail, bed sampling, grounding and one berth. Nearby-island channels remain continuous; they need not demonstrate maximum compression.
3. **Prove one complete voyage.** Add a sufficiently separated destination, tune the offshore portion to 15–20 minutes at reference conditions, introduce a weather transition and one optional encounter, and profile on iPhone. Test reduced sail, tacking, drift and a full return voyage.
4. **Expand selected spaces.** Automate repeatable regional imports and source audits. Build connected Cuba/Hispaniola coastal strips with closed coastlines and coherent inland silhouette proxies; add chosen ports, reefs and explicit inland modules. Do not populate their entire interiors or every Caribbean island.
5. **Add selected river reaches.** Choose a Columbia or Hudson reach; validate currents, bars, bends, bank collisions and water-level continuity before adding more meaningful reaches. Entire river packs remain optional.

Required checks before shipping the first slice: unchanged sailing/animation/wave timing under compression; chart round-trip consistency; no inverted/overlapping region mappings; no skipped hazards; closed island boundaries and stable visible inland silhouettes; continuous terrain/color/vegetation seams with no visible scale changes; persistent contacts; no wake or FFT phase jump; matching rendered/probed water; tide/draft grounding behavior; cold-cache streaming failure handling; save/reload at boundaries; and native iPhone frame-time measurement. A build or desktop screenshot alone does not establish those results.

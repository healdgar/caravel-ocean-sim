# Model audit

Compares the hand-written numbers that describe each ship and port building with the geometry actually drawn. Nine ships, 34 building prefabs, ten ports, nine forest tree species.

```bash
WEBGPU_BACKEND=metal node scripts/model-audit.mjs --report=MODEL_AUDIT.md
```

That rewrites the measured tables below and takes about 90 seconds. It runs headless. On Metal it reads the live game's own vertices, indices and GPU-posed buffer for each ship, so the rig is measured where it is drawn. `--no-gpu` measures the rest mesh in Node instead.

`tests/model-audit.test.mjs` holds the game to `tests/data/model-audit-known.json`: nothing new may pass its limit, and no known fault may get worse. After a fix, run `node scripts/model-audit.mjs --write-known`. `tests/model-audit-gpu.test.mjs` holds the Node mesh to what the GPU draws.

To show the audit passes what is right: a sweep that follows the mesh scores 100% agreement with no air or through lines, and a mast table 1 m out is caught. Both are tests. `tests/ship-collider.test.mjs` holds the shot to it on every ship, and `tests/model-audit-gpu.test.mjs` holds the yards and hatch lids the shot moves to where the GPU draws them.

The audit changes no model. No plain typo turned up.

## Defects, most visible in play first

"Lines" are straight lines across a ship's whole silhouette, from every bearing. They weigh the rig by its area, so they say how wrong a zone is, not how often a real broadside goes there. Real shots cluster lower.

### Seen in any fight

| # | Defect | Measured | Where |
|---|---|---|---|
| 1 | **Fixed: balls burst in empty air around the rig.** The rig box is gone. A ball meets what is drawn, from `js/ship-collider.js`, and goes through canvas and rope, tearing them. | Was 57–85% of lines stopping more than 1 m from anything drawn, typically 2.2–6.8 m, up to 12 m. Now none, on all nine. | `sweepShipSegment` |
| 2 | **Fixed: once a building had been hit, balls stopped in mid-air, up to 30 m off.** The boxes are gone, and a ball meets only what is drawn. About 7% of fort lines still read as stopping away from the mesh this audit knows, which does not include a fort's earth. Was: `addSolid` boxed a world-aligned box after turning it, so turned buildings ballooned. Every real port turns its buildings. This brings back the fault `traceShotAtBuilding` was written to end, from the first hit on. | Quay wall: reach 8 m becomes 43 m, 72% of lines stop in air. Corral 23%, loggia 16%, sea bastion 10%, star fort 9%. Fort lines stopping early besides: 28–35%. Square, none; the quay's reach is tight again at 90°. | `js/building-fracture.js:522` |
| 3 | **Fixed: no forest tree could be struck.** A ball meets the wood each tree draws, through a grid over the roots the GPU draws, as chains of round sections measured from the mesh. It goes through air, leaves and twigs thinner than itself. Was: 0 of 14,000–56,000 trees strikable, 0% of lines through a trunk stopped. | All the trees drawn are strikable. Lines through a trunk stopped 90–100%, on all nine species, 7 of them at 99% or better. None stop in air. Ceiba's buttresses (90%) and mangrove's prop roots (93%) are the misses. | `js/forest-trunks.js`, `js/forest-trunk-shapes.js` |
| 4 | **Fixed: balls pass through Victory's bow and stern**, and the Santa María's and Niña's upper works. The shot's hull was a formula ending at 0.52 length. Now it is her planks. | Through hull was Victory 10.6%, Santa María 3.6%, Niña 1.5%. Now Victory 0.2%, the rest 0. Victory's is her guns, which the GPU runs in up to 1.1 m and the shot holds at rest. | `sweepShipSegment` |
| 5 | **Fixed: lower masts cannot be hit, nor Victory's upper rig.** Masts and yards are solid on their own triangles, and a fallen one is not. | Dead band was Victory 10.6 m, Flying Cloud 6.6 m, others 2.4–4.1 m, with tops a formula out by up to 14 m. Now none, from one 0.5 m step over the rail to the masthead, on all eight rigged ships. | `sweepShipSegment` |
| 6 | **Fixed: balls stopped in air around foreshore palms.** A foreshore palm is a root of the forest, and a ball meets its leaning trunk. Was: 45–48% of lines stopped in air, about 1.4 m from anything, at a trunk 1.35 m in radius against 0.34 m drawn. | No line stops in air, and 98% of lines through the trunk stop within 0.5 m of it. | `js/forest-trunks.js` |

### Seen on deck at normal camera range

| # | Defect | Measured | Where |
|---|---|---|---|
| 7 | **Fixed: Victory's helmsman stood in the wheel.** He stands aft of the after wheel, to starboard of its spindle and post, facing forward, hands on the rim. | Was through it by 1.09 m. Now clear. | `js/models/victory.js`, `helm.grip` in `js/ship-models.js` |
| 8 | **Fixed: Victory's hands stood in the poop stairs.** q10 and q11 stand forward of the stair foot. q12 stands at the rail between two guns, and q9, the mizzen sheet hand, in the next bay forward: the bay by the mizzen fall is where the hauler stands. Isabel keeps to the same bay to port: her round went round a gun and through the stair. | Was q9 0.99 m, q12 0.58 m, q10 0.33 m. Now clear. | `js/models/victory.js` |
| 9 | **The audit was wrong: no Victory hand stood on air.** q8, q11, Duarte, Leonor and w3 each stood on a 9 mm seam between planks, and one line down a seam found the deck below. There is no hatch under w3. A floor is now read across a boot's width. Duarte, Beatriz and Leonor still moved inboard, from a gun's carriage and a brace. | Was 3.0 m and 0.64 m, 5.6% of 90 s of crew positions. Now none. Every plank has these seams: 75 walk cells read over nothing for the same reason. | `floorBeneath` in `scripts/model-audit-lib.mjs` |
| 10 | **Fixed: Niña's aft waist hand stood under the stair.** He stands inboard, forward of its foot, clear of the main shrouds and of the corridor Rui walks to the hatch. | Was through tread 4 by 0.73 m. Now clear. | `js/models/nina.js` |
| 11 | **Fixed: Flying Cloud's two bow hands stood outside her hull.** They stand on the forecastle behind the anchors, facing forward. | Was x 1.56 m at a half-width of 1.39 m. Now x 0.87 m on deck. | `js/models/later-sail.js` |
| 12 | **Fixed: Gipsy Moth's only hand stood in the tiller.** She sits on the port bench with her feet in the well and both hands on the tiller, and walks from the well to work. | Was through it by 0.87 m. Now clear. | `js/models/later-sail.js`, `crewSeatedPose` |
| 13 | **Fixed: the Oseberg's helmsman stood in the deck stores.** He sits further out on his thwart with his boots beside them, and turns part way to the steering oar. | Was 0.41 m. Now clear. | `js/models/rowing.js`, `crewSeatedPose` |
| 14 | **Fixed: rowers' legs through benches and boots through floorboards, on all three rowed ships.** One pose: the pelvis rides above the bench by the back of the thigh and each ankle above the floor by the boot, both measured from the body's own skin. A paddler bows over a low grip he cannot otherwise reach. The canoe's narrow first row and stern bench sit further in, boots a boot's width from her side. No bench, oar or paddle moved, so they still meet the water. | Was all 88: legs 0.13–0.15 m, soles 0.11 m. Now none, through the whole stroke. The 0.34 m was the audit's: a toe under the next thwart. So was row 8's floorboard gap: a line along the edge between two triangles. | `poseSeatedCrew`, `rowingStationPose` |
| 15 | **Fixed: helmsmen's hands through tillers.** On the Santa María, Niña and Pinta he stands beside the handle to port of the bar, facing forward and turned a little in toward it, hands on it, boots planted. He faced aft before. Niña's fore hands move inboard of the shroud leads, which are what they met: `mast.fore` holds those fittings as well as the mast. | Was Santa María 0.22 m, Niña 0.17 m, Pinta 0.12 m; fore hands 0.27 m. Now clear. | `crewHelmStand`, `crewHelmHands` |

### Seen on close inspection

| # | Defect | Measured | Where |
|---|---|---|---|
| 16 | **Oak grain 2–10 times too dense on five ships**, the fault the Pinta and Santa María had. The default UV repeats per design unit, so a smaller ship packs more into a metre. It only looks right on Victory by luck of size. `additional-ships.js:39` passes a grain; these do not. | Repeats per metre across / along, Niña 0.96 / 0.33. Canoe deck 10 / 1.7, Lusoria 6.4 / 1.3, Oseberg 3.6 / 1.1, Gipsy Moth oak 3.7 / 1.5, Flying Cloud deck 3 / 0.7 and material 17 16.7 / 5. Pinta, Santa María, Victory match. | `js/rowing-ships.js:22`, `js/later-sail-ships.js:29`, `js/mesh-writer.js:28` |
| 17 | **Wall planks grow with the ship.** The shader sets their width in design units. | Flying Cloud 0.91 m, Victory 0.76 m, Niña 0.27 m. | `js/wgsl/caravel.js:213` |

### Numbers wrong, little to see

| # | Defect | Measured | Where |
|---|---|---|---|
| 18 | **Flying Cloud's eight guns are not drawn**, so a ball appears from nowhere. Their numbers were written by hand. | Muzzle up to 1.6 m from the hull. Station 3.3 m off her deck. | `js/gunnery-models.js:79` |
| 19 | **Archers' stations off the floor.** Abstract, so only their arrows show it. | Oseberg 0.22 m, canoe 0.25 m. | `js/gunnery-models.js:80` |
| 20 | **A bulwark invented for shots.** Fixed for the ball, which meets the shell as drawn. `vesselRailHeight` still adds 1 m of wall for what splinters reach and for a warship's aim at a rail. | Rail against mesh, P90: Victory 1.05 m, Gipsy Moth 1.03 m, Flying Cloud 0.66 m. | `js/gunnery-control.js:908`, `:921` |
| 21 | **Niña's mizzen breaks under the quarterdeck.** | Full break at 3.08 m, deck at 3.83 m. | `js/ship-fracture.js:27` |
| 22 | **Two Victory guns fire into the main chains.** The quarterdeck gun's station read over a gap was a plank seam, as in 9. | Muzzle 0.08 m from `rig.standing.main` (upper battery, gun 38 each side). | `js/gunnery-models.js:25` |
| 23 | **The walk grid runs through solid things.** The rowed and later-sail ships skip the obstacle check, and Victory's obstacles leave these out. No hand was seen walking these cells in 90 s. | Flying Cloud 414 of 3,467 cells inside her deckhouse. Victory 83 through bulkheads, stairs and wheel. Gipsy Moth 54 in her cabin. | `js/crew-navigation.js:214`, `:228`, `:284` |
| 24 | **Low rails**, under 0.8 m. Oseberg now passes at 0.93 m. These two may be right for the hull, so I flag rather than call them faults. | Canoe 0.41 m, Lusoria 0.57 m. Gipsy Moth 0.82 m passes at her lowest. | `js/models/rowing.js` |
| 25 | **Rig ends loose.** | Victory: 27 line ends up to 0.56 m from anything, `helm.tiller` and `helm.rudder` nodes 0.80 m, `rig.mizzen.fall` 0.52 m. Lusoria: 2 ends, 0.37 m. | `js/ship-models.js:87-88`, `js/victory.js` |
| 26 | **One jetty's shore end stands in rising ground.** Only at Boston. | 0.43 m. | `js/port-props.js` |
| 27 | **Fixed: a dead code path in the shot.** Without a damage state, hits went to fixed stations, including masts a ship lacks. The stations are gone with the box. A hit credits the mast its triangle belongs to. | None left. | `sweepShipSegment` |

## What holds

- **Buildings as meshes.** All 34 prefabs: every line agrees with the mesh, before any hit.
- **Ports.** Every building is known by its own mesh: four live, ten offline. Other ports: a streamed section's port has `instances: []` (`js/coastal-world.js:10810`), so only the active port ever has buildings, and live `terrain.ports` held one.
- **Hydrostatics.** Displaced volume within 1.4% of the mesh on all nine. Hull-width formula within 0.07 m at P90. Draft exact, but for Niña's separate keel, 0.12 m.
- **Mast stations.** Within 0.34 m of the mesh on all ships, after the earlier fix. Santa María's foremast is the largest, from its rake.
- **Gun muzzles and breeches** of drawn guns. Within 0.14 m of the barrel, at rest.
- **Chainwales.** Height and outer edge match the function.
- **Cleats and jetty decks.** Every cleat is on its deck. Jetty decks stand 1.40 and 1.51 m above the sea, against 1.5 m.
- **Pinta and Santa María's grain.** Matches the Niña. The earlier fix holds.
- **GPU pose.** Masts unmoved. Among hull parts only hatch lids move.

## What this does not cover

- Ships are level at their design waterline, on a calm sea, with sails as the game first sets them. Hits below the sea are not counted.
- At rest (`--no-gpu`, `--write-known`, and so `tests/model-audit.test.mjs`) the Niña's, Pinta's and Santa María's lateen yards stand in the rest mesh, where the game never draws them, so `collision.through-mast/nina` and `/pinta` are known there. On Metal those read 0.
- Crew are measured at the watch, standing or rowing, posed as the game draws them with hands closed. `tests/crew-stations.test.mjs` adds a long watch, the whole stroke, either rudder and manned guns. Hands walking on a job, aloft work and falls are not held to it, nor are bodies against rope and cloth, which move with the wind.
- At hard rudder a helmsman follows the tiller: across the Santa María's poop stair foot past about 13°, and the Gipsy Moth's tiller can reach her on the bench past about 16°.
- Flying Cloud's spanker boom passes 1.55 m over the deck at her wheel, so her helmsman's head meets it on one tack in a narrow range of brace.
- A hit's credited part and ship fracture after damage are checked by `tests/ship-collider.test.mjs` and `tests/ship-fracture.test.mjs`, not here. Nor are the terrain sweep and the legacy trees used only if the forest fails to load.
- Trees are measured standing, in calm air. Wood is hard where a tube is as thick as a ball, or is a slender tree's own stem. That is the audit's own measure, from rays across each tube, not the table's. Wind, felled trees and fallen trunks are not measured.
- A manifest's `heightMetres` differs from its mesh (palm 10.4 against 17.5 m). Nothing I found reads it for collision, so it is not ranked.

## Measured


<!-- audit tables start -->
Measured 2026-11-06. Rig as the GPU posed it, read back on Metal. 58 measurements past their limits.

### Posed geometry read back from the GPU

| Ship | vertices | hull-class parts that moved | mast | spar | cloth | rope | gun | length off | beam off | sinkage off |
|---|---|---|---|---|---|---|---|---|---|---|
| nina | 91998 | hatch.cover 2.27 | 0 | 0.77 | 4.85 | 4.86 | 0.09 | 0 | 0 | 0 |
| pinta | 43041 | hatch.main 2.92 | 0 | 0.75 | 3.65 | 6.65 | 0.09 | 0 | 0 | 0 |
| santa-maria | 48686 | hatch.main 3.68 | 0 | 0.69 | 2.49 | 4.61 | 0.09 | 0 | 0 | 0 |
| victory | 144783 | hatch.main 4.68 | 0 | 1.89 | 1.79 | 1.88 | 1.1 | 0 | 0 | 0 |
| oseberg | 71016 | none | 0 | 0.6 | 0.61 | 0.61 | – | 0 | 0 | 0 |
| lusoria | 30703 | none | 0 | 0.5 | 0.48 | 0.48 | – | 0 | 0 | 0 |
| taino-canoe | 26453 | none | – | – | – | – | – | 0 | 0 | 0 |
| flying-cloud | 76071 | hatch.main 4.7 | 0 | 2.28 | 2.54 | 2.28 | – | 0 | 0 | 0 |
| gipsy-moth-iv | 21568 | hatch.main 0.85 | 0 | 0.4 | 0.4 | 0.41 | – | 0 | 0 | 0 |

### 1a. Balls against ship meshes

Share of lines that either the shot or the mesh says struck. *Agree* is within 0.5 m of the first solid surface. *Soft* stopped with nothing solid within 0.5 m, on or near cloth or rope only. *Air* stopped more than 1 m from anything drawn. *Through* passed a solid surface unstopped.

| Ship | lines | agree % | soft % | air: rig % | air: hull % | median gap m | max gap m | through hull % | through mast/spar % | phantom mast % | wrong mast % | parts missed most |
|---|---|---|---|---|---|---|---|---|---|---|---|---|
| nina | 13017 | 100 | 0 | 0 | 0 | – | 0 | 0 | 0 | 0 | 0 |  |
| pinta | 11385 | 100 | 0 | 0 | 0 | – | 0 | 0 | 0 | 0 | 0 |  |
| santa-maria | 13702 | 100 | 0 | 0 | 0 | – | 0 | 0 | 0 | 0 | 0 |  |
| victory | 13939 | 98.7 | 1.1 | 0 | 0 | – | 0 | 0.2 | 0 | 0 | 0 | gunnery.recoil.# 8, gun.forecastle.port.# 6, gun.forecastle.starboard.# 6, gun.quarter.starboard.# 3, gun.quarter.port.# 3 |
| oseberg | 8220 | 100 | 0 | 0 | 0 | – | 0 | 0 | 0 | 0 | 0 |  |
| lusoria | 6164 | 100 | 0 | 0 | 0 | – | 0 | 0 | 0 | 0 | 0 |  |
| taino-canoe | 9084 | 100 | 0 | 0 | 0 | – | 0 | 0 | 0 | 0 | 0 |  |
| flying-cloud | 11086 | 100 | 0 | 0 | 0 | – | 0 | 0 | 0 | 0 | 0 |  |
| gipsy-moth-iv | 8959 | 100 | 0 | 0 | 0 | – | 0 | 0 | 0 | 0 | 0 |  |

### 1b. Balls against trees

*Trunk lines* are fired close together at the trunk alone. The rest cross the tree's whole silhouette: *wood lines* cross wood as thick as a ball, or a slender tree's own trunk; *all wood* counts twigs too, which a ball goes through. *Agree* is within 0.5 m of that wood. *Soft* stopped within a metre of something drawn, usually a line that misses the wood by less than the ball's own width. *Air* stopped further off than that. *Through* passed thick wood unstopped.

| Tree | mode | trunk lines | trunk lines stopped % | trunk agree % | wood lines stopped % | all wood stopped % | agree % | soft % | air % | through % | gap m | top m | reach m |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| subtropical/royal_palm | forest | 7399 | 100 | 100 | 100 | 74.6 | 62.2 | 37.8 | 0 | 0 | – | 20.97 | 3.53 |
| subtropical/palm | forest | 2813 | 100 | 98.5 | 100 | 53.3 | 58.9 | 41.1 | 0 | 0 | – | 18.65 | 5.26 |
| subtropical/palm-0.2 | foreshore | 3328 | 100 | 98.6 | 100 | 51 | 51.8 | 48.2 | 0 | 0 | – | 15.31 | 5.32 |
| subtropical/palm-0.5 | foreshore | 3429 | 100 | 98.5 | 100 | 51.5 | 54.7 | 45.3 | 0 | 0 | – | 17.31 | 6.11 |
| subtropical/palm-0.8 | foreshore | 3499 | 100 | 98.3 | 100 | 53.8 | 56.1 | 43.9 | 0 | 0 | – | 19.3 | 6.9 |
| subtropical/ceiba | forest | 4975 | 90.1 | 78.4 | 89.9 | 49.6 | 46.9 | 46.4 | 0 | 6.7 | – | 26.21 | 14.11 |
| subtropical/mangrove | forest | 1996 | 92.8 | 75.2 | 91.7 | 38.1 | 22.9 | 74.1 | 0 | 3.1 | – | 14.11 | 5.96 |
| saba/oak | forest | 1317 | 99.5 | 96.7 | 98 | 32 | 52.7 | 46.2 | 0 | 1.1 | – | 24.5 | 28.21 |
| saba/maple | forest | 1311 | 99.9 | 98.9 | 75 | 4.8 | 4.8 | 93.5 | 0 | 1.6 | – | 22.72 | 22.39 |
| saba/birch | forest | 1722 | 100 | 100 | 0 | 0 | 0 | 0 | 0 | 0 | – | 12.86 | 15.49 |
| saba/elm | forest | 1501 | 99.1 | 94.9 | 99.2 | 33.2 | 57.5 | 42.1 | 0 | 0.5 | – | 23.19 | 28.07 |
| saba/chestnut | forest | 1859 | 99.9 | 95.3 | 97.9 | 42.7 | 55.8 | 43 | 0 | 1.2 | – | 28.31 | 23.11 |

### 1c. A live port and forest, read from the running game

| Region | ports | buildings | known by mesh | traced by mesh | trees drawn | trees a ball can strike | palms a ball can strike |
|---|---|---|---|---|---|---|---|
| lisbon | 1 | 26 | 26 | 26 | 36000 | 36000 | 0 |
| havana | 1 | 23 | 23 | 23 | 56000 | 56000 | 520 |
| san-juan | 1 | 23 | 23 | 23 | 56000 | 56000 | 520 |
| jamestown | 1 | 18 | 18 | 18 | 36000 | 36000 | 0 |

### 1d. Balls against port buildings

*Mesh* is an intact building, turned 40°. *Square* and *turned* are the same building once cut into pieces, at 0° and 40°. Each cell is agree / air / through / early, as lines.

| Prefab | nominal w×h×l | drawn top m | mesh half m | reach square m | reach turned m | mesh | pieces square | pieces turned | max air m |
|---|---|---|---|---|---|---|---|---|---|
| timber_mole_pier | 7.5×2.8×68 | 10.3 | 34 | 34 | 34.1 | 332 / 0 / 0 / 0 | 472 / 0 / 0 / 0 | 332 / 0 / 0 / 0 | 0 |
| stone_sea_bastion | 28×11.5×34 | 19.5 | 18.9 | 18.9 | 21.2 | 1248 / 0 / 0 / 0 | 1640 / 0 / 0 / 0 | 1072 / 149 / 0 / 41 | 2.9 |
| casa_de_contratacion | 16×8.5×26 | 12 | 14.1 | 14.1 | 14.2 | 1332 / 0 / 0 / 0 | 1728 / 0 / 0 / 0 | 1332 / 0 / 0 / 0 | 0.1 |
| royal_warehouse | 14×7.2×30 | 10.3 | 15.8 | 15.8 | 16 | 1332 / 0 / 0 / 0 | 1712 / 0 / 0 / 0 | 1332 / 0 / 0 / 2 | 0.3 |
| careening_shed | 11×5.6×22 | 8.2 | 11.8 | 11.8 | 11.9 | 768 / 0 / 0 / 0 | 1072 / 0 / 0 / 0 | 773 / 0 / 0 / 3 | 0.3 |
| mission_chapel | 13×12×28 | 23.6 | 18.7 | 18.7 | 18.7 | 1254 / 0 / 0 / 0 | 1461 / 0 / 0 / 5 | 1227 / 0 / 0 / 27 | 0.4 |
| colonial_town_block | 18×6.4×24 | 8.6 | 12.7 | 12.7 | 13 | 1205 / 0 / 0 / 0 | 1582 / 0 / 0 / 0 | 1197 / 0 / 0 / 8 | 0.2 |
| stone_quay_seawall | 84×1.9×12 | 3.2 | 42.8 | 42.8 | 45.7 | 419 / 0 / 0 / 0 | 634 / 0 / 4 / 0 | 405 / 7 / 2 / 12 | 3.1 |
| single_nave_solar | 9.5×7.2×22 | 9.4 | 11.7 | 11.7 | 12 | 1162 / 0 / 0 / 0 | 1482 / 0 / 0 / 0 | 1162 / 0 / 0 / 0 | 0.2 |
| l_wing_u_wing_solar | 17×7.4×24 | 9.6 | 12.7 | 12.7 | 13 | 1239 / 0 / 0 / 0 | 1623 / 0 / 0 / 0 | 1239 / 0 / 0 / 0 | 0.2 |
| modular_patio_cloister | 26×8.2×30 | 12.4 | 15.7 | 15.7 | 16 | 1214 / 0 / 0 / 0 | 1609 / 0 / 0 / 0 | 1214 / 0 / 0 / 0 | 0 |
| royal_atarazanas_arsenal | 26×8.2×36 | 10.4 | 18.8 | 18.8 | 19 | 1304 / 0 / 0 / 0 | 1764 / 0 / 0 / 16 | 1300 / 0 / 0 / 4 | 0.4 |
| open_lonja_loggia | 13.5×7.4×26 | 10.4 | 13.9 | 13.9 | 14.1 | 1120 / 0 / 0 / 0 | 1516 / 0 / 0 / 0 | 1119 / 0 / 0 / 1 | 0.2 |
| walled_mule_corral | 30×5.8×34 | 7.2 | 17.7 | 17.7 | 17.9 | 1053 / 0 / 0 / 0 | 1472 / 0 / 0 / 0 | 1053 / 0 / 0 / 0 | 0.2 |
| bastion_trace_fortress | 38×9.8×42 | 15.4 | 33 | 33 | 36.1 | 1208 / 0 / 0 / 0 | 1462 / 0 / 0 / 16 | 951 / 253 / 0 / 35 | 2.8 |
| torreon_atalaya_farol | 13×15.5×13 | 21.8 | 7.4 | 7.4 | 7.4 | 792 / 0 / 0 / 0 | 1064 / 0 / 0 / 0 | 792 / 0 / 0 / 0 | 0 |
| curtain_wall_and_gate | 6.2×6.6×34 | 10.3 | 17.7 | 17.7 | 17.7 | 1009 / 0 / 0 / 0 | 1296 / 0 / 0 / 0 | 999 / 0 / 0 / 10 | 0.3 |
| stone_arch_bridge | 7.2×4.6×32 | 4.6 | 16.2 | 16.2 | 16.6 | 800 / 0 / 0 / 0 | 848 / 0 / 0 / 116 | 755 / 0 / 0 / 47 | 0.5 |
| thatched_bohio_palafito | 8.5×4.8×14 | 7.9 | 11.8 | 11.8 | 11.8 | 836 / 0 / 0 / 0 | 974 / 0 / 0 / 0 | 836 / 0 / 0 / 0 | 0 |
| astillero_and_moored_hull | 8.2×5.2×23 | 5.1 | 11.8 | 11.8 | 11.8 | 631 / 0 / 0 / 0 | 862 / 0 / 1 / 20 | 628 / 0 / 0 / 3 | 0.1 |
| abenaki_birchbark_wigwam | 6.4×3.6×6.8 | 4.4 | 5.3 | 5.3 | 5.3 | 520 / 0 / 0 / 0 | 575 / 0 / 0 / 0 | 519 / 0 / 0 / 1 | 0 |
| algonquian_longhouse | 7.2×5.2×22 | 5.4 | 11.7 | 11.7 | 11.7 | 1354 / 0 / 0 / 0 | 1641 / 0 / 0 / 0 | 1355 / 0 / 0 / 1 | 0.1 |
| indigenous_palisade_ring | 26×4.4×28 | 5 | 12.9 | 12.9 | 12.9 | 1378 / 0 / 0 / 0 | 1347 / 0 / 0 / 27 | 1353 / 0 / 0 / 35 | 0.1 |
| taino_cacique_caney | 11.2×6.4×16.5 | 7.2 | 9.5 | 9.5 | 9.6 | 931 / 0 / 0 / 0 | 1194 / 0 / 0 / 0 | 926 / 0 / 0 / 5 | 0.2 |
| taino_circular_bohio | 8.6×5.4×8.6 | 6.3 | 4.5 | 4.5 | 4.5 | 808 / 0 / 0 / 0 | 812 / 0 / 0 / 0 | 808 / 0 / 0 / 0 | 0 |
| taino_batey_court | 15×2.2×24 | 1.9 | 12 | 12 | 12.4 | 506 / 0 / 0 / 0 | 640 / 0 / 0 / 0 | 528 / 0 / 0 / 14 | 0.4 |
| kalinago_carbet_hall | 9.8×6.2×21 | 6.4 | 14.2 | 14.2 | 14.2 | 974 / 0 / 0 / 0 | 1112 / 0 / 0 / 0 | 974 / 0 / 0 / 0 | 0 |
| tupinamba_oca_longhouse | 9.6×6.6×28 | 6.9 | 14.4 | 14.4 | 14.4 | 1216 / 0 / 0 / 0 | 1580 / 0 / 0 / 0 | 1216 / 0 / 0 / 0 | 0.1 |
| palafito_estuary_village | 14×5.4×18 | 6.3 | 12.6 | 12.6 | 12.7 | 637 / 0 / 0 / 0 | 710 / 0 / 0 / 0 | 631 / 0 / 0 / 6 | 0.2 |
| maya_limestone_shrine_and_na | 11.5×7.4×18.5 | 7 | 9.2 | 9.2 | 9.6 | 797 / 0 / 0 / 0 | 1000 / 0 / 0 / 0 | 800 / 0 / 0 / 2 | 0.3 |
| indigenous_canoe_landing | 8.5×2.2×16 | 1.4 | 11.4 | 11.4 | 11.4 | 172 / 0 / 0 / 0 | 180 / 0 / 0 / 0 | 172 / 0 / 0 / 0 | 0 |
| english_triangular_palisade_fort | 118×6.8×90 | 8.4 | 57.5 | 57.5 | 57.5 | 1064 / 0 / 0 / 0 | 970 / 0 / 0 / 24 | 1041 / 0 / 0 / 25 | 0.1 |
| english_half_timber_hall | 10.5×7.4×22 | 10.4 | 13.6 | 13.6 | 13.6 | 1071 / 0 / 0 / 0 | 1292 / 0 / 0 / 0 | 1071 / 0 / 0 / 0 | 0 |
| english_timber_cottage | 8.2×5.8×15.5 | 7.7 | 8.9 | 8.9 | 9.2 | 1086 / 0 / 0 / 0 | 1356 / 0 / 0 / 0 | 1090 / 0 / 0 / 3 | 0.2 |

### 2a. Masts

| Ship | mast | table z | mesh z | off | deck y | foot y | top y | top break | full break | break above deck | rig top | rail | struck from | struck to | dead band |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| nina | fore | -3.23 | -3.23 | 0.01 | 1.19 | 0.67 | 15.21 | 8.5 | 2.42 | 1.23 | 21.06 | 2.08 | 2.58 | 15.08 | 0 |
| nina | main | 3.57 | 3.57 | 0.01 | 1.23 | 0.7 | 12.24 | 7.25 | 2.25 | 1.02 | 21.06 | 2.08 | 2.58 | 15.08 | 0 |
| nina | mizzen | 8.1 | 8.13 | 0.03 | 3.83 | 1.46 | 9.4 | 6.58 | 3.08 | -0.75 | 21.06 | 2.08 | 2.58 | 15.08 | 0 |
| pinta | fore | -6.87 | -6.9 | 0.03 | 1.66 | 1.66 | 20.51 | 9.07 | 3.13 | 1.48 | 25.05 | 2.47 | 2.97 | 24.97 | 0 |
| pinta | main | 0.22 | 0.01 | 0.2 | 1.47 | 1.47 | 25.05 | 11.23 | 2.91 | 1.44 | 25.05 | 2.47 | 2.97 | 24.97 | 0 |
| pinta | mizzen | 8.2 | 8 | 0.2 | 2.79 | 2.78 | 19.43 | 8.2 | 3.78 | 0.99 | 25.05 | 2.47 | 2.97 | 24.97 | 0 |
| santa-maria | fore | -8.37 | -8.71 | 0.34 | 1.7 | 1.72 | 18.99 | 10.85 | 3.89 | 2.19 | 25 | 2.54 | 3.04 | 24.54 | 0 |
| santa-maria | main | 0.12 | -0.1 | 0.22 | 1.54 | 1.54 | 25 | 13.32 | 3.42 | 1.88 | 25 | 2.54 | 3.04 | 24.54 | 0 |
| santa-maria | mizzen | 10.64 | 10.63 | 0 | 3.42 | 3.42 | 18.51 | 9.67 | 4.6 | 1.18 | 25 | 2.54 | 3.04 | 24.54 | 0 |
| victory | fore | -16.77 | -16.76 | 0.01 | 5.71 | -1.99 | 57.4 | 27.02 | 7.51 | 1.8 | 62.36 | 6.53 | 8.03 | 62.03 | 0 |
| victory | main | 0.24 | 0.26 | 0.02 | 5.53 | -1.99 | 62.36 | 29.2 | 7.32 | 1.8 | 62.36 | 6.53 | 8.03 | 62.03 | 0 |
| victory | mizzen | 16.68 | 16.62 | 0.06 | 8.03 | -1.99 | 49.37 | 24.33 | 9.83 | 1.8 | 62.36 | 6.53 | 8.03 | 62.03 | 0 |
| oseberg | main | 0 | 0.02 | 0.02 | 0.15 | 0.15 | 10.6 | 7.53 | 2.06 | 1.91 | 10.6 | 0.95 | 1.45 | 10.45 | 0 |
| lusoria | main | 0 | -0.18 | 0.18 | 0.07 | 0.07 | 9 | 6.3 | 1.72 | 1.65 | 9 | 0.55 | 1.05 | 8.55 | 0 |
| taino-canoe | – | – | – | – | – | – | – | – | – | – | -Infinity | 0.42 | – | – | – |
| flying-cloud | fore | -18.92 | -18.83 | 0.09 | 3.21 | 3.15 | 48.31 | 32 | 8.29 | 5.08 | 52.02 | 3.97 | 4.97 | 51.97 | 0 |
| flying-cloud | main | -0.63 | -0.54 | 0.09 | 2.98 | 2.9 | 52.02 | 34.86 | 8 | 5.03 | 52.02 | 3.97 | 4.97 | 51.97 | 0 |
| flying-cloud | mizzen | 19.72 | 19.72 | 0.01 | 4.65 | 4.59 | 42.59 | 29.15 | 8.86 | 4.21 | 52.02 | 3.97 | 4.97 | 51.97 | 0 |
| gipsy-moth-iv | main | -1.55 | -1.54 | 0.01 | 0.83 | 0.83 | 14.4 | 6.47 | 1.69 | 0.86 | 14.4 | 1.82 | 2.32 | 14.32 | 0 |
| gipsy-moth-iv | mizzen | 3.64 | 3.66 | 0.02 | 0.3 | 0.3 | 9.8 | 4.59 | 1.55 | 1.25 | 14.4 | 1.82 | 2.32 | 14.32 | 0 |

### 2b. Guns

| Ship | guns | undrawn | muzzle off barrel m | breech off barrel m | lowest muzzle above sea | furthest from hull | into own ship | station off floor |
|---|---|---|---|---|---|---|---|---|
| nina | 4 | 0 | 0.05 | 0 | 4.81 | 0.75 | 0 | 0 |
| pinta | 4 | 0 | 0.04 | 0 | 3.64 | 0.53 | 0 | 0.01 |
| santa-maria | 4 | 0 | 0.04 | 0 | 4.22 | 0.61 | 0 | 0.01 |
| victory | 104 | 0 | 0.14 | 0 | 1.8 | 1.06 | 2 | 0 |
| oseberg | 6 | 6 | 0 | 0 | 1.92 | 0.94 | 0 | 0.22 |
| lusoria | 6 | 6 | 0 | 0 | 1.53 | 0.96 | 0 | 0.08 |
| taino-canoe | 6 | 6 | 0 | 0 | 1.1 | 0.68 | 0 | 0.25 |
| flying-cloud | 8 | 8 | 0 | 0 | 5.03 | 1.6 | 0 | 3.34 |
| gipsy-moth-iv | 0 | 0 | 0 | 0 | – | 0 | 0 | 0 |

### 2c. Crew stations, routes and walkways

| Ship | crew | floating | under something | pressed | no hull beside | route floating % | worst m | who | walk cells | over nothing | worst m | inside a structure | through solid | through what |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| nina | 24 | 0 | 0 | 0 | 0 | 0 | 0.34 | maria 2 | 397 | 0 | 0 | 0 | 12 | stair:tread:# 6, bow.structure 5, anchor:cathead:-# 1, tackle.fore 1 |
| pinta | 30 | 0 | 0 | 0 | 0 | 0 | 9 | maria 1 | 690 | 0 | 0 | 0 | 16 | deck.stairs.forecastle.stairs.port 8, deck.stairs.forecastle.stairs.starboard 8, deck.stairs.quarter.stairs.port 6, deck.stairs.quarter.stairs.starboard 6 |
| santa-maria | 40 | 0 | 0 | 0 | 0 | 0 | 9 | maria 3 | 943 | 2 | 0.16 | 0 | 24 | deck.stairs.poop.stairs.port 8, deck.stairs.poop.stairs.starboard 8, deck.stairs.quarter.stairs.port 7, deck.stairs.quarter.stairs.starboard 7 |
| victory | 64 | 0 | 0 | 0 | 0 | 0 | 0 | maria 2 | 2048 | 0 | 0 | 0 | 83 | deck.bulkhead.#.# 40, stairs.quarter.port 8, stairs.quarter.starboard 8, helm.wheel 8 |
| oseberg | 32 | 0 | 0 | 0 | 0 | 0 | 0 |  | 277 | 0 | 0 | 0 | 1 | rowing.benches 34, deck.stores 8, mast.main.cut 1 |
| lusoria | 26 | 0 | 0 | 0 | 0 | 0 | 0 |  | 158 | 0 | 0 | 0 | 0 | rowing.benches 12, deck.stores 4 |
| taino-canoe | 30 | 0 | 0 | 0 | 0 | 0 | 0 |  | 56 | 0 | 0 | 0 | 0 | rowing.benches 8, deck.stores 1 |
| flying-cloud | 42 | 0 | 0 | 0 | 0 | 0 | 0 |  | 3467 | 0 | 0 | 414 | 87 | structure.deckhouse 41, deck.bulkhead.forecastle 11, deck.stairs.poop.port 11, deck.stairs.poop.starboard 9 |
| gipsy-moth-iv | 1 | 0 | 0 | 0 | 0 | 0 | 0 |  | 161 | 2 | 1.38 | 54 | 13 | deck.cockpit 11, structure.cabin 7, deck.stairs.cockpit-entry 5, hull.planking 1 |

### 2d. Rig and fittings

| Ship | attachment nodes | more than 0.25 m from anything | worst | lines | loose ends | worst m | chainwale samples missed | chainwale height off |
|---|---|---|---|---|---|---|---|---|
| nina | 36 | 0 |  | 56 | 0 | 0 | – | – |
| pinta | 45 | 0 |  | 202 | 0 | 0 | – | – |
| santa-maria | 58 | 0 |  | 196 | 0 | 0 | – | – |
| victory | 67 | 3 | helm.tiller 0.8m, helm.rudder 0.8m, rig.mizzen.fall 0.52m | 260 | 27 | 0.56 | 0 | 0 |
| oseberg | 232 | 0 |  | 6 | 0 | 0 | – | – |
| lusoria | 190 | 0 |  | 6 | 2 | 0.37 | – | – |
| taino-canoe | 149 | 0 |  | 0 | 0 | 0 | – | – |
| flying-cloud | 219 | 0 |  | 472 | 0 | 0 | – | – |
| gipsy-moth-iv | 38 | 0 |  | 17 | 0 | 0 | – | – |

### 3. Waterline and hull

| Ship | draft table | draft mesh | freeboard table | rail mid min | at z | rail amidships | rail formula P90 | deck formula P75 | hull width P90 | beam run | beam mesh | length run | length mesh | volume table | volume mesh | error % |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| nina | 2.09 | 2.21 | 1.08 | 2.23 | -1.89 | 2.23 | 0.19 | 0.04 | 0.04 | 6 | 6.38 | 20 | 23.61 | 113 | 114 | 1.4 |
| pinta | 2.29 | 2.29 | 1.47 | 2.42 | -1.58 | 2.42 | 0.08 | 0 | 0.05 | 7.01 | 7.11 | 25.91 | 26.1 | 154 | 154 | 0 |
| santa-maria | 1.95 | 1.95 | 1.54 | 2.53 | -2.42 | 2.53 | 0.23 | 0 | 0.05 | 7.96 | 8.07 | 28.3 | 28.51 | 178 | 178 | -0.1 |
| victory | 8.8 | 8.8 | 5.53 | 7.56 | -6.22 | 7.56 | 1.05 | 0 | 0.07 | 15.85 | 16.32 | 56.69 | 63.8 | 4782 | 4762 | -0.4 |
| oseberg | 0.9 | 0.9 | 0.95 | 0.93 | -1.31 | 0.93 | 0.02 | 0.08 | 0 | 5 | 5.05 | 21.5 | 22.38 | 20 | 20 | 0 |
| lusoria | 0.38 | 0.38 | 0.55 | 0.57 | -4.17 | 0.57 | 0.02 | 0 | 0 | 2.8 | 2.83 | 18 | 18.03 | 10 | 10 | 0.3 |
| taino-canoe | 0.42 | 0.42 | 0.42 | 0.41 | -2.56 | 0.41 | 0.03 | 0 | 0 | 1.8 | 1.82 | 14 | 14.02 | 4 | 4 | -0.2 |
| flying-cloud | 5.46 | 5.46 | 2.97 | 4.53 | -2.51 | 4.53 | 0.66 | 0 | 0.01 | 12.5 | 12.58 | 68.58 | 68.69 | 1677 | 1676 | -0.1 |
| gipsy-moth-iv | 2.36 | 2.36 | 0.82 | 0.82 | -4.14 | 1.42 | 1.03 | 0.59 | 0 | 3.2 | 3.23 | 16.18 | 16.21 | 10 | 10 | -0.1 |

### 4a. Crew bodies

| Ship | crew | body meets a solid | through more than 8 cm | deepest m | soles sunk | by m | parts | worst |
|---|---|---|---|---|---|---|---|---|
| nina | 24 | 2 | 0 | 0 | 0 | 0 | deck.main.planks 1, helm.tiller 1 |  |
| pinta | 30 | 1 | 0 | 0 | 0 | 0 | helm.tiller 1 |  |
| santa-maria | 40 | 1 | 0 | 0 | 0 | 0 | helm.tiller 1 |  |
| victory | 64 | 1 | 0 | 0 | 0 | 0 | deck.quarter.planks 1 |  |
| oseberg | 32 | 14 | 0 | 0 | 0 | 0 | deck.floorboards 14 |  |
| lusoria | 26 | 14 | 0 | 0 | 0 | 0 | deck.floorboards 14 |  |
| taino-canoe | 30 | 21 | 0 | 0 | 0 | 0 | deck.floorboards 11, rowing.benches 9, deck.stores 1 |  |
| flying-cloud | 42 | 1 | 0 | 0 | 0 | 0 | helm.wheel 1 |  |
| gipsy-moth-iv | 1 | 1 | 0 | 0 | 0 | 0 | helm.tiller 1 |  |

### 4b. Port props

| Port | buildings | known by mesh | cleats | off their deck | worst m | no mesh under | jetties | root in rising ground | head dry |
|---|---|---|---|---|---|---|---|---|---|
| lisbon | 26 | 26 | 38 | 0 | 0.1 | 0 | 0 | 0 | 0 |
| havana | 23 | 23 | 15 | 0 | 0 | 0 | 2 | 0 | 0 |
| san-juan | 23 | 23 | 15 | 0 | 0 | 0 | 2 | 0 | 0 |
| cartagena | 23 | 23 | 15 | 0 | 0 | 0 | 2 | 0 | 0 |
| veracruz | 23 | 23 | 15 | 0 | 0 | 0 | 2 | 0 | 0 |
| jamestown | 9 | 9 | 0 | 0 | 0 | 0 | 2 | 0 | 0 |
| boston | 10 | 10 | 0 | 0 | 0 | 0 | 2 | 1 | 0 |
| plymouth-colony | 10 | 10 | 0 | 0 | 0 | 0 | 2 | 0 | 0 |
| quebec | 10 | 10 | 0 | 0 | 0 | 0 | 2 | 0 | 0 |
| cape-town | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 | 0 |

| Jetty model | length | width | height | deck claimed | deck in mesh | above sea | wanted |
|---|---|---|---|---|---|---|---|
| jetty-weathered | 16 | 5.79 | 6.17 | 5.3 | 5.31 | 1.51 | 1.5 |
| jetty-planked | 18 | 9 | 4.15 | 3.4 | 3.3 | 1.4 | 1.5 |

### 5. Surface, in oak repeats per metre (across / along the grain) and shader planks in metres

| Ship | deck | hull plank | oak | oak-5 | oak-6 | paint-20 | paint-21 | paint-23 | paint-24 | spar | trim | wale/post | wood-14 | wood-17 | wood-18 | wall course | deck plank | hull course |
|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|---|
| nina | 0.96 / 0.33 | 0.235 / 0.371 | 0.96 / 0.33 | 0.877 / 0.39 | 0.87 / 0.39 | – | – | – | – | 0.96 / 0.45 | – | 0.96 / 0.359 | – | 1.128 / 0.39 | – | 0.267 | 0.242 | 0.236 |
| pinta | 0.96 / 0.33 | 0.223 / 0.357 | 0.96 / 0.45 | – | – | – | – | – | – | 0.945 / 0.498 | – | 0.958 / 0.335 | 0.96 / 0.33 | 0.96 / 0.33 | 1.064 / 0.33 | 0.345 | 0.282 | 0.249 |
| santa-maria | 0.96 / 0.33 | 0.222 / 0.359 | 0.96 / 0.45 | – | – | – | – | – | – | 0.827 / 0.48 | – | 0.958 / 0.348 | 0.96 / 0.33 | 0.96 / 0.33 | 1.024 / 0.33 | 0.377 | 0.321 | 0.25 |
| victory | 0.909 / 0.423 | – | 1.136 / 0.423 | – | – | 1.054 / 0.415 | 1.055 / 0.421 | 1.058 / 0 | 1.136 / 0.423 | 1.134 / 0.3 | 1.01 / 0.301 | – | 1.058 / 0.423 | – | 1.136 / 0.423 | 0.756 | 0.638 | – |
| oseberg | 3.6 / 1.116 | 0.181 / 0.376 | 2.791 / 1.113 | – | – | – | – | – | – | – | – | 4.705 / 1.812 | – | – | – | 0.287 | 0.201 | 0.307 |
| lusoria | 6.429 / 1.333 | 0.308 / 0.402 | 5.54 / 1.333 | – | – | – | – | – | – | – | – | 4.787 / 1.842 | – | – | – | 0.24 | 0.113 | 0.18 |
| taino-canoe | 10 / 1.714 | 0.323 / 0.52 | 6.69 / 1.713 | – | – | – | – | – | – | – | – | 3.995 / 2 | – | – | – | 0.187 | 0.072 | 0.172 |
| flying-cloud | 3 / 0.7 | – | 0.875 / 0.347 | – | – | 0.244 / 0.104 | – | 0.875 / 0.344 | – | 1.43 / 0.249 | – | – | 0.875 / 0.35 | 16.712 / 4.984 | 1.44 / 0.35 | 0.914 | 0.503 | – |
| gipsy-moth-iv | 3 / 0.7 | – | 3.707 / 1.483 | – | – | – | – | 0.252 / 0.445 | – | – | – | – | – | – | – | 0.216 | 0.129 | – |

### Every measurement past its limit

| Check | measured | limit | note |
|---|---|---|---|
| building.pieces-air-turned/bastion_trace_fortress | 20.42 | 2 | reach grows from 33 m to 36.1 m when turned; stops up to 2.8 m from it |
| building.pieces-air-turned/stone_sea_bastion | 11.81 | 2 | reach grows from 18.9 m to 21.2 m when turned; stops up to 2.9 m from it |
| gun.blocked/victory | 2 | 0 | gun.upper.port.38 into rig.standing.main at 0.08 m |
| gun.station-off-floor/flying-cloud | 3.34 | 0.15 | battle.gun.port.3 |
| gun.station-off-floor/oseberg | 0.22 | 0.15 | battle.archer.port.0 |
| gun.station-off-floor/taino-canoe | 0.25 | 0.15 | battle.archer.port.0 |
| gun.undrawn/flying-cloud | 8 | 0 | fires from a place with no gun drawn |
| hull.deck-formula/gipsy-moth-iv | 0.59 | 0.2 | modelDeck against the deck drawn |
| hull.low-rail/lusoria | 0.57 | 0.8 | at z -4.17 m |
| hull.low-rail/taino-canoe | 0.41 | 0.8 | at z -2.56 m |
| hull.rail-formula/flying-cloud | 0.66 | 0.3 | vesselRailHeight against the rail drawn |
| hull.rail-formula/gipsy-moth-iv | 1.03 | 0.3 | vesselRailHeight against the rail drawn |
| hull.rail-formula/victory | 1.05 | 0.3 | vesselRailHeight against the rail drawn |
| mast.break-below-deck/nina/mizzen | -0.75 | 0.2 | full break 3.08 m, deck 3.83 m |
| node.loose/victory | 3 | 0 | helm.tiller 0.8m, helm.rudder 0.8m, rig.mizzen.fall 0.52m |
| prop.jetty-root-buried/boston | 0.43 | 0 | the shore end stands in rising ground |
| rope.loose/lusoria | 2 | 0 | of 6 lines; worst 0.37 m; rig.standing 2 |
| rope.loose/victory | 27 | 0 | of 260 lines; worst 0.56 m; rig.standing.main 12, rig.standing.mizzen 8, rig.standing.fore 6, rig.running 1 |
| surface.grain-across/flying-cloud/deck | 3.13 | 1.67 | 3/m against Niña's 0.96/m |
| surface.grain-across/flying-cloud/wood-17 | 14.82 | 1.67 | 16.712/m against Niña's 1.128/m |
| surface.grain-across/gipsy-moth-iv/deck | 3.13 | 1.67 | 3/m against Niña's 0.96/m |
| surface.grain-across/gipsy-moth-iv/oak | 3.86 | 1.67 | 3.707/m against Niña's 0.96/m |
| surface.grain-across/lusoria/deck | 6.7 | 1.67 | 6.429/m against Niña's 0.96/m |
| surface.grain-across/lusoria/oak | 5.77 | 1.67 | 5.54/m against Niña's 0.96/m |
| surface.grain-across/lusoria/wale/post | 4.99 | 1.67 | 4.787/m against Niña's 0.96/m |
| surface.grain-across/oseberg/deck | 3.75 | 1.67 | 3.6/m against Niña's 0.96/m |
| surface.grain-across/oseberg/oak | 2.91 | 1.67 | 2.791/m against Niña's 0.96/m |
| surface.grain-across/oseberg/wale/post | 4.9 | 1.67 | 4.705/m against Niña's 0.96/m |
| surface.grain-across/taino-canoe/deck | 10.42 | 1.67 | 10/m against Niña's 0.96/m |
| surface.grain-across/taino-canoe/oak | 6.97 | 1.67 | 6.69/m against Niña's 0.96/m |
| surface.grain-across/taino-canoe/wale/post | 4.16 | 1.67 | 3.995/m against Niña's 0.96/m |
| surface.grain-along/flying-cloud/deck | 2.12 | 1.67 | 0.7/m against Niña's 0.33/m |
| surface.grain-along/flying-cloud/spar | 0.55 | 1.67 | 0.249/m against Niña's 0.45/m |
| surface.grain-along/flying-cloud/wood-17 | 12.78 | 1.67 | 4.984/m against Niña's 0.39/m |
| surface.grain-along/gipsy-moth-iv/deck | 2.12 | 1.67 | 0.7/m against Niña's 0.33/m |
| surface.grain-along/gipsy-moth-iv/oak | 4.49 | 1.67 | 1.483/m against Niña's 0.33/m |
| surface.grain-along/lusoria/deck | 4.04 | 1.67 | 1.333/m against Niña's 0.33/m |
| surface.grain-along/lusoria/oak | 4.04 | 1.67 | 1.333/m against Niña's 0.33/m |
| surface.grain-along/lusoria/wale/post | 5.13 | 1.67 | 1.842/m against Niña's 0.359/m |
| surface.grain-along/oseberg/deck | 3.38 | 1.67 | 1.116/m against Niña's 0.33/m |
| surface.grain-along/oseberg/oak | 3.37 | 1.67 | 1.113/m against Niña's 0.33/m |
| surface.grain-along/oseberg/wale/post | 5.05 | 1.67 | 1.812/m against Niña's 0.359/m |
| surface.grain-along/taino-canoe/deck | 5.19 | 1.67 | 1.714/m against Niña's 0.33/m |
| surface.grain-along/taino-canoe/oak | 5.19 | 1.67 | 1.713/m against Niña's 0.33/m |
| surface.grain-along/taino-canoe/wale/post | 5.57 | 1.67 | 2/m against Niña's 0.359/m |
| surface.wall-course/flying-cloud | 0.91 | 0.45 | wall courses 0.914 m wide against Niña's 0.267 m |
| surface.wall-course/victory | 0.76 | 0.45 | wall courses 0.756 m wide against Niña's 0.267 m |
| walk.inside-structure/flying-cloud | 414 | 0 | of 3467 cells: under a roof with no floor |
| walk.inside-structure/gipsy-moth-iv | 54 | 0 | of 161 cells: under a roof with no floor |
| walk.over-nothing/gipsy-moth-iv | 2 | 0 | of 161 cells; up to 1.38 m |
| walk.over-nothing/santa-maria | 2 | 0 | of 943 cells; up to 0.16 m |
| walk.through-solid/flying-cloud | 87 | 0 | of 3467 cells; structure.deckhouse 41, deck.bulkhead.forecastle 11, deck.stairs.poop.port 11, deck.stairs.poop.starboard 9 |
| walk.through-solid/gipsy-moth-iv | 13 | 0 | of 161 cells; deck.cockpit 11, structure.cabin 7, deck.stairs.cockpit-entry 5, hull.planking 1 |
| walk.through-solid/nina | 12 | 0 | of 397 cells; stair:tread:# 6, bow.structure 5, anchor:cathead:-# 1, tackle.fore 1 |
| walk.through-solid/oseberg | 1 | 0 | of 277 cells; rowing.benches 34, deck.stores 8, mast.main.cut 1 |
| walk.through-solid/pinta | 16 | 0 | of 690 cells; deck.stairs.forecastle.stairs.port 8, deck.stairs.forecastle.stairs.starboard 8, deck.stairs.quarter.stairs.port 6, deck.stairs.quarter.stairs.starboard 6 |
| walk.through-solid/santa-maria | 24 | 0 | of 943 cells; deck.stairs.poop.stairs.port 8, deck.stairs.poop.stairs.starboard 8, deck.stairs.quarter.stairs.port 7, deck.stairs.quarter.stairs.starboard 7 |
| walk.through-solid/victory | 83 | 0 | of 2048 cells; deck.bulkhead.#.# 40, stairs.quarter.port 8, stairs.quarter.starboard 8, helm.wheel 8 |
<!-- audit tables end -->

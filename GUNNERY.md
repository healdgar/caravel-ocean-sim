# Gunnery

Copyright © 2026 Six Cailloux, LLC. Code: MIT; see LICENSE.

Open **Captain → Gunnery**. Prepare port or starboard, wait for the battery to report ready, then order that broadside to fire. Each order fires once. Prepare again to reload; Cease fire cancels guns that have not yet discharged. Stand down releases the gun crews; a new sailing order also returns them to ship duties. Ready guns retain their load, but cannot fire without their crews; interrupted loading restarts on the next preparation order. Enable sound for the captain, gun crews, tackles and reports. Muting does not shorten the captain's order or accelerate firing.

Niña retains four small rail swivel guns. Victory has 104 mountings: three principal batteries, quarterdeck and forecastle guns, including the two forward carronades. They are distinct gun types, rather than scaled copies of one shot. Preparation moves guns inboard for loading; gun carriages and barrels run out, fire, recoil and remain spent. Fixed port frames and lids do not recoil.

## Drill and crew

Victory’s stages are wet sponge, load, ram, run out, prime and ready. Niña’s small swivels use removable breech-chamber handling, rather than reaching over the rail to ram an inaccessible muzzle. Visible crews walk to assigned stations; loading pauses without attendance or while they brace. Captain and helmsman keep their stations. Sail work already underway must finish or descend safely. The cannon animation and sound follow actual stage transitions; a preset visual timer does not fire the gun.

Victory's twelve visible sailors represent a watch, not her entire complement. A small selection of weather-deck teams demonstrate the drill; the interior batteries and remaining teams are abstracted. This release does not animate hundreds of gun-deck sailors or reproduce every officer, powder runner, vent thumbstall and safety step of the full historical drill. Reload durations (33 seconds of attended work) and the rolling broadside interval (0.14 seconds) are gameplay settings, not measured historical timings.

### Stations under battle damage and sail work

Sail hands with canvas to set or take in leave the guns for the sheets and return afterward; other hands fill their stations. Canvas lost to mast damage needs no hands and moves nobody. Lookout and hatch work wait while guns are manned. A sail order no longer stands the battery down; only the sea watch order, Stand down, surrender and similar orders do, and loaded guns then read "Stood down" until prepared again.

A dismounted gun (`gun.dismounted`) stops loading and firing, cancels any queued shot, leaves the battery's `total` and is counted separately. Its team moves to the next mounted weather-deck gun. A broadside order whose guns are all lost stands down rather than blocking later orders. Full repair and recycling a dormant vessel remount guns through `remountVesselGuns`.

A station no hand can reach passes to abstract crew after about five seconds of failed routes, or once a hand has spent `30 s + vessel length` walking to it. Changing battery or issuing a new captain's order retries the visible team. The helm and gunnery panels report what holds a battery (`stallReason`) or canvas (`boat.sailHoldReason`) in plain language.

## Flight, recoil and water contact

Solid cast-iron round shot inherits the muzzle's full physical velocity, including forward motion, leeway, heave, yaw, pitch and roll. The muzzle follows the rendered barrel, and heel changes its actual firing direction. Flight integrates gravity and quadratic drag relative to ambient wind at 120 Hz. Dispersion is seeded and small. There are no glowing tracers, guided shots or explosive cannonballs.

Shot weight is in imperial pounds; mass is converted to kilograms. Diameter follows an iron sphere at 7,200 kg/m³. The 32-pounder reference speed is 487.68 m/s (1,600 ft/s); the 24-pounder, 12-pounder, swivel and carronade speeds are authored approximations. Constant drag coefficient 0.47 does not reproduce the changing transonic drag of real round shot.

An opposite impulse enters the existing hull's surge, leeway, heave and angular velocity states. The normal mass, added-water inertia and hull resistance then govern motion. Recoil is applied once per discharge, not repeatedly while its animation plays.

Loaded muzzles also require a fresh GPU sea-clearance sample before the captain can order fire, and each gun is checked again at discharge. Awash muzzles, stale readbacks, substantial movement and changed sea/ship revisions hold fire without spending a round or applying recoil. The HUD distinguishes checking the sea from gunports awash. A 10 cm clearance margin is an authored operational constraint, not a recovered historical firing rule.

Contact sweeps the shot's trajectory against all six cascades of the actual GPU ocean, including inverse horizontal displacement. Spatial subdivisions and bisection catch crests between integration points. Asynchronous readback retains unchecked trajectory segments. It samples the current wave field, rather than reconstructing historical FFT textures at every past trajectory time. Splashes are emitted from those measured contacts with the arriving velocity and shot mass.

Penetration, structural damage, land impacts, adjustable elevation and AI combat now exist in `js/gunnery-control.js`. Water-skipping ricochets and variable powder charges are not modeled. Forts return fire only on ships that fired on them, and one non-magazine hit can disable at most 30% of a crew.

## Bows

The Taíno canoe, Oseberg and Lusoria have no gunpowder, so their batteries are archers at the rail. They use the same aiming, flight and order path as guns, with a 65 g arrow at 52 m/s and about 170 m of useful reach. Plain arrows have no powder, smoke, flash or recoil. They wound only the bodies they reach, stay in them and cannot breach a hull. A fire arrow flies slower, takes longer to ready and can start a fire; crews douse one, but several on one spot grow. Gipsy Moth IV carries no weapons. All figures are authored approximations.

## What shots do to people

Shots are swept against each visible sailor as an upright capsule. The solid hull ends at the rail, so a shot above it meets whoever stands in its path, and a shot below it stops at the hull. A ball goes straight through a body and flies on. It kills outright, and it can take a limb (55% on an arm or leg), break one (30%) or crush the chest (60% of torso hits). Those chances are authored. Splinters fly from a hit that breaks through or strikes a bulwark, reach about 3 m at most and can break limbs. A small count stands in for crew who are not drawn, in proportion to how crowded the ship is. A magazine blast harms by area. So does a ball that strikes the sea, but only those already in it: a swimmer or floating body within 4.6 m is killed, maimed and thrown, and one within 1.35 m, or struck a third time, is destroyed. He was counted lost when he went over the side and is not counted again. Swivels and archers lay on people above the rail; great guns lay on the hull.

## Smoke, flash and sound

A short muzzle flash illuminates nearby timber and crew. Iron striking timber, stone, earth or water makes no smoke and no flash; its debris, dust and spray are drawn on the GPU from the contact.

Powder smoke is a dense bank that blows with the breeze. Each gun throws a jet from its actual muzzle that lasts under three seconds; no two guns' jets are alike in size, lean or pace, so a broadside's are not a row of one shape. Guns that fire together along one stretch of her side (within 7.5 m and 1.6 s of one another, laid alike, ten at most) leave one bank between them, so a full broadside of 52 is six to a dozen banks, by the order her guns fire in, and a single gun is a puff in proportion. A bank is thick enough at first to hide what is behind it. It swells, rises a little and thins over its life, and it is carried downwind at the wind's own speed and direction once the air has caught it up, about a second after the gun. It lasts 52 s in a dead calm, where it hangs about the ship, and 52 / (1 + wind / 9 m/s) seconds otherwise: about 29 s in a 7 m/s breeze and 19 s in a 16 m/s wind, which tears it away as a long streak (`gunneryBankSeconds`).

A bank has no shape of its own. It is a swelling, blunt underneath, carved by one field of billows that fills the world and travels with the wind: where the billows are full the smoke stands out to the swelling's edge, between them it is eaten back, and late in its life right through, so an old bank tears into separate clouds. Banks that overlap are carved from the same billows and join as one. The billows are a 64-cubed tiling block of noise made once on the GPU and kept at four sizes, so a coarse walk through thin smoke reads billows no finer than its steps and shows no grain. Each pixel walks a volume in at most ten steps; where it first meets smoke it finds the billow's face and is lit there. Sunlight is dimmed by the billows that stand toward the sun and by the rest of the bank beyond them, with a slower falloff for light scattered many times; the sky lights what is open to it, so the bank is darker within, between billows and underneath. Smoke is white-grey in daylight, a dirty yellow-grey for its first seconds, and dark at night. Volumes are clipped to the resolved ship and ocean depth.

All of it is worked out on the GPU. JavaScript sends a gun's record (muzzle, aim, charge, the frame clock when it fired) and its bank's once, when it fires, and nothing after: no smoke is moved, aged or sorted in JavaScript. A compute pass adds the frame's wind to a running total each frame, notes the total at each record's birth, and lays out every jet, flash and bank from the records, the clock and that carry; splashes and strikes are aged the same way from the clock they struck by. It is not a fluid simulation: smoke does not flow round the hull or sails, and the wind it rides is the one wind of the frame (`js/wgsl/gunnery.js`, `GUNNERY_BUILD` and `gunnerySmoke`; `js/gunnery-effects.js`).

Smoke that is not there or cannot be seen is not paid for. There are 128 shots and 48 banks at most, the oldest giving way. JavaScript forgets a gun when its jet is spent and a bank when the wind has had the whole of its life, and with no smoke in the air and nothing burning there is no compute pass, no copy of the depth and no smoke pass at all. While there is smoke, the pass that puts the volumes in drawing order, farthest first, leaves out every one wholly outside the view, and what it counts, the nearest 256 at most, is what the GPU draws (`drawIndirect`). With none in view it draws nothing and copies no depth.

A fire is one small record on the GPU: where it burns (in her own frame when it is aboard a ship), since when, how fierce it is and how fast that is changing. Each frame a compute pass makes the fire's two flame volumes and six parcels of pitch smoke from that record, the frame's clock and the wind, and carries a fire aboard with her hull's transform. The same records give the two fire lights the scene is lit by and the glow a burning ship throws on her own decks, so what is lit is always the fire that is drawn. JavaScript keeps only the simulation of a fire (growth, spread, damage) and rewrites its record when it is lit, struck again, doused or changes pace; a fire burning steadily sends nothing.

Smoke and flame draw after the scene, in one single-sampled pass on the resolved colour, against a resolved copy of the scene's depth. There is one pipeline for them, and the tests draw with it.

The existing Web Audio context spatializes each report. Sound arrives after distance divided by the speed of sound; nearby report arrivals can share a mixing voice while their projectiles remain independent. Gun reports have a separate bounded source pool so they do not consume every crew/mechanical voice. [Sound generation, listening review and provenance](GUNNERY_AUDIO.md).

Secured gunnery emits no smoke/particle work or ocean readback. A manned, loaded battery adds a bounded muzzle-clearance query while it awaits orders. A broadside adds bounded round shot, smoke volumes and impact slots. Full Victory broadsides cost more than idle sailing, particularly close to the smoke: seen from her own deck the bank fills much of the picture and is the dearest view, and in a calm it stays for most of a minute. The existing resolution monitor retains its 30 FPS target; physical iPhone performance still requires device testing.

## Sources and reconstruction limits

- [Royal Navy Museums: Victory conservation log](https://www.royalnavymuseums.org.uk/hms-victory-conservation-log): 104 guns, surviving 32- and 24-pounders, heavy carriages, hemp rigging and gun-deck materials.
- [U.S. Naval History and Heritage Command: Constitution gun deck](https://www.history.navy.mil/research/library/online-reading-room/title-list-alphabetically/c/the-constitution-gun-deck.html): sponge, load, ram, tackle runout, prime, firing on the roll, breeching and dense whitish smoke. Comparable early nineteenth-century practice, not a claim that an American frigate's drill exactly matches Victory in 1805.
- [USS Constitution Museum: A Gun by Any Other Name](https://ussconstitutionmuseum.org/2014/03/07/a-gun-by-any-other-name/): coordinated teams and the manpower required for large naval guns.
- [Howard Douglas, A Treatise on Naval Gunnery (1855)](https://www.ibiblio.org/pha/USN/Navy/Treatise%20on%20Naval%20Gunnery%20%28Douglas%29%20%281855%29.pdf): a later worked 32-pounder example at 1,600 ft/s, used as a reference rather than a recovered Victory firing table.
- [Mary Rose Trust: swivel gun](https://maryrose.org/artefacts/swivel-gun/): removable breech chambers on rail-mounted swivels. This guides Niña’s authored small-gun animation; it is not proof of her precise gun inventory.
- [NASA: Flight Equations with Drag](https://www1.grc.nasa.gov/beginners-guide-to-aeronautics/flight-equations-with-drag/): vector drag and gravity formulation.

These sources guide the reconstruction. Exact charge tables, historical shot quality, sea-state firing doctrine and reload performance have not been calibrated to this ship.

## Holes and flooding

A penetrating round or hot shot leaves a hole in the hull, recorded in `damage.holes` in her own frame in metres. The hole, not the hit, decides the water: see `js/hull-holes.js`. Grape, chain and arrows never hole a hull. Waterline hits that do not penetrate still use the older estimated leak in `compartments[...].breachArea`.

A ship draws with the whole-hull shader until something marks her. After that she draws in two steps from a second shader: `surviving` lays depth and decides what shot and tearing have taken away, then `fs` shades only what is left. Holes, hold water and craters share one uniform buffer per ship (`js/hull-flood.js`), updated only when they change.

## How a ship comes apart

No hit moves a timber vertex. A vertex pulled on its own stretches every triangle it shares, which pinches hulls and shears masts. A hit does two things instead: it scorches the surface (`bakeVesselImpactMarks`, which only displaces torn sail cloth), and it wears the pieces of her it reached (`js/ship-fracture.js`). Parts say what a piece is, damage says how much it has taken, and fracture says which pieces leave.

- **Shards.** Built once per model. Keel, decks and hull below the waterline stay. Bulwarks, cabins, castles, galleries and topsides break into plank-sized shards, using the Voronoi cells buildings use (`sampleVoronoiBlockCell`). Small fittings are one shard. Each gun is one shard.
- **Compounding.** Light shots wear a shard until it goes. A penetrating shot takes the nearest at once. A wrecked fitting (part damage at 0.65) comes away rather than vanishing. A shard with no remaining path back to what stays comes down too, so nothing is left standing in space.
- **Masts.** A mast divides at its two break heights. Rings, tops, yards, sails and rigging belong to the section they are fixed to, so they fall as one rigid body. Victory breaks at her real joints. A pole mast is cut there when the model is built, with a splintered cap on each side. A section falls from its break, at the station its own spar stands at, in one rigid turn that is timed to end as it reaches the sea, so nothing in it bends or flattens on the way. A square-rigged section turns a third of a circle about a skew axis, which lays the mast and its yards level together. A lateen or gaff section, whose yard reaches along her, topples a quarter circle over the side. It floats flat, rocked a little by the sea, then sinks. Rope goes with the mast as it starts to lean, then is gone, parted. The crow's nest, pennant and parrels go when what they stand on goes.
- **Guns.** A dismounted gun is knocked off its trucks and stays aboard. It goes back when remounted.
- **Magazine, broken back.** A magazine blast throws everything in its radius. A broken back takes the planking across that station. Neither bends her: she founders as she was.
- **Sinking.** As she goes down her masts go by the board and a share of her upper works floats free, once (`damage.wreckageReleased`). A wreck that comes back from a save is already dismasted and sheds nothing more. The bed stops her: in a harbour she settles with her keel a little way into the bottom and whatever stands higher than the water still showing, and only in deep water does she go under by her own length.
- **Graphics.** When a shard breaks JavaScript writes its 64-byte flight record and 32 bytes saying where she was and how she lay. Shards that break together are neighbours, so each run of them is one write. A compute pass moves each shard every frame, rigid in metres, and runs only once something has broken. While anything is in the air or adrift, her 64-byte frame and a 32-byte clock are uploaded per frame; once everything has come to rest or gone, nothing is.
- **Saves.** Masts return from `mastState`. Shards shot away are listed in the snapshot and come back already gone. A full structural repair restores them.

What goes over the side is in the world's frame from the moment it leaves her: it starts from her position, heading and heel as they were, falls to the sea she floats on (`shipSeaLevel`), lies there on its broad side and is left astern. A dismounted gun stays aboard, in her frame.

- **Timber adrift and shot.** A ball through planking afloat smashes each piece on its line and flies on, as it does through canvas; nothing afloat stops a ball, and an arrow does nothing to it (`shatterFloatingWreckageOnSegment`). A ball that strikes her side (3.6 m) or the sea (4.6 m) throws the pieces lying in the water there into the air again, and smashes those under 1.85 m or already thrown once (`blastFloatingWreckageAt`). Only what has been off her for 0.35 s and lies within 0.55 m of the sea counts, so planking still in the air from the last ball is left alone. A fallen mast is not struck.
- **Cost.** The pieces of a wreck that lie in the water are listed once a frame, with one box round them, however many balls are flying; a ball nowhere near costs a comparison.

### What a gap does

- **Shots.** The hull a shot first reaches is a solid that knows nothing of the pieces. Once she has lost something, her own triangles decide: `traceShotPastGap` follows the shot's line through what stays and what is left. If the first thing on that line is a piece that has gone, the shot flies on and strikes the next thing still standing, whether that is the far side, a frame, a deck, a gun or a mast. A mast struck this way is hurt like any other. Cloth and rope do not stop it. If nothing stands on the line it flies clear. A line with no gap on it strikes exactly where it did. A hit is never credited to a part with nothing left of it.
- **Masts.** A shot passes through where a fallen section was. The rig zones go up only as far as `mastState` leaves the mast standing.
- **Shielding.** Bodies are reached up to where the shot stops, so planking that has gone shields nobody.
- **The rail.** `crewRailAboveDeck` counts only what is left of her side at that station and on that side. A body with no rail to stop it goes over at walking pace (`crewClearsRail`). The deck itself never leaves, so hands stay on it, but they keep 0.45 m from an edge with less than 0.5 m of rail left. A hand caught there moves in, a post there moves inboard, and a route past it goes round, on every ship with crew. See `CREW.md`.

`scripts/damage-review.mjs` prints a row of level shots asked both ways, as she is and as if nothing had left her, and how many bodies each reaches.

`node scripts/damage-review.mjs` takes pictures of this from the real game. `npm run perf -- '[["battle",{"battle":"1"}]]'` measures it.

## How a building comes apart

Buildings break the way ships do: no hit moves a vertex, each piece is one rigid body, and flights use the same record format (`js/building-fracture.js`). What differs is what a piece is, what holds it up, and where it comes to rest.

- **Shards.** Built once per building, on its first hit, from the port's part catalog. The work is sliced so a frame stops after 3 ms, and the hit waits in the queue for those few frames. A wall face is cut into stone blocks along its courses, breaking where `sampleVoronoiBlockCell` changes cell. A building past 3,200 blocks gets bigger ones. Each block is a closed solid. What is buried or always under water stays, along with paved floors, and a post driven into the ground stays when what stood on it goes. Small fittings are one shard, a gun is one shard, and any other floor comes down in large slabs.
- **What a breach shows.** The faces inside a wall begin as points, so an intact wall costs what it always cost. A break opens the hidden faces of the block's neighbours, in raw stone laid along the wall as its facing is (`buildingKindWithYaw`). A fort's facing stands in front of a rubble core, and only the rim of its rampart falls with the wall. The rest of the flat stays, because earth holds it.
- **Support.** A link says whether a shard rests on another or only stands beside it. Support climbs from the ground through what rests on what. A stone can also hang from the stone beside it for its span, one stone in masonry and three or four in timber and roofs, and the stone on top of that one is a step better off. A small hole stands as an arch. A wide breach brings down a triangle of wall above it, each stone a moment after the last.
- **Compounding.** A penetrating shot takes the nearest blocks at once, a light one only wears them, and worn blocks are scorched. A collapse takes what stands above its own height. A magazine blast throws everything in its radius outward.
- **Rubble.** A piece lands on what is under the place it comes down: the ground, a floor below it, or the heap already there. A floor slab that has been shot away is no floor: what comes down over the hole, stone or man, lands on whatever is under it (`floorAt` with the state's `broken`). Rubble already lying on a slab when it goes is not moved. It rolls off a heap steeper than the angle of repose and lies about flat, and it stays. A ball among rubble shifts the pieces near it, and the third such strike smashes a piece; the heap is lowered or moved by that piece's share. Stone over deep water goes to the seabed. Timber over deep water floats a while, then is gone.
- **Graphics.** A struck building draws from its own buffers, and its range of the port's index buffer is cleared once. A hit writes flight records and shard scorch, nothing else. The pose pass runs only while something is in the air or just changed, and the last pose stays in the vertex buffer, so a ruin costs its triangles and no compute. An intact port pays nothing.

- **Shots.** A building is one box to the sweep, so its pieces decide what a shot meets. Where a line goes in through a gap, the shot flies on to the next thing standing, inside the building or beyond it, and strikes whatever that is. A fort's earth stops it, so a ball does not pass through a rampart. A ball goes through men ashore on its way, as it does sailors.
- **Saves.** A building's record is its standing plus its hits, sixteen characters each, and replaying the hits puts every piece back exactly where it fell, with nothing seen to fall. The career save holds every port. A share link holds the port in view, the worst damage first, as much as fits in nine thousand characters. A port with no record costs one lookup. Fires go out across a reload, and soldiers a ball struck get back up. Those whose wall has gone stay down, because the hits say so.
- **Rebuilding.** A town rebuilds what was shot down. A week's clearing up, then up to 30 days for timber, 60 for masonry and 90 for a fort, in proportion to the damage, counted in game days from the last shot. Being hit again restarts the count. The building comes back whole, all at once, and its saved damage is gone.

- **Soldiers.** A man comes down with the stretch he stands on, to the ground, a floor or the rubble under him, and stays down. One walking a rampart keeps to what is left of his beat. On a fort's deck he only steps down when the parapet goes, because the rampart still holds him. A saved ruin has its men already down, and a rebuilt one has them back at their posts. This is worked out only when a building has lost something, never by the frame.

`node scripts/building-damage-review.mjs` takes pictures of this from the real game. `npm run perf -- '[["fort",{"fort":"siege"}]]'` measures it.

## What a ball strikes on a building

To the sweep a building is only a box saying the ball is near. The ball strikes the first thing really standing on its line: the mesh until the building is first hit and cut, then its pieces, skipping what has gone, and the earth behind a fort's facing. The box comes from what the building really reaches, so a star fort's bastions stop balls, and the air in the corners of a triangular fort does not. Behind a fort's facing is earth, cut into clods two deep and about twice as hard to shift as stone, and behind that is the inside of the fort, so sustained fire opens a breach right through and the next ball flies in. A ball that strikes something that cannot break, such as a footing, still shakes what stands within six metres. A fort's own balls never strike it, and a gun fires over the first six metres of its own works. On a fort with no drawn trace every gun, flank guns included, stands at the opening nearest its place along the parapet, never behind a merlon (`nearestEmbrasure`).

## What a ball through the rig does

Canvas and rope do not stop a ball. It tears them and flies on, and each mast it crosses loses at most 6.5% of its integrity however heavy the ball, so six or so tears bring a topmast down. A ball that strikes a mast or yard itself does its full harm, and one 24-pounder can then fell a small ship's mast.

## What a ball strikes in a forest

A live forest's trees and foreshore palms are its own roots. A ball meets the wood they draw, through a grid over those roots, and goes through air, leaves and twigs. The trunk model is handed the ball's own energy and whether it met the trunk or a limb, so a slender palm snaps to one ball and a hardwood takes a wound first and falls to the next. What it does to them, down to a tree falling, is on the GPU and in the save. See [What a ball meets](FOREST_INSTANCES.md#what-a-ball-meets).

## The free camera's cannon

For trying out destruction: in the free camera, hold F to fire a 24-pounder where the sight points, at most once a second (`js/free-cannon.js`). Its balls strike ships, buildings, trees and ground as any other, and what they do is saved like any other damage. They raise no muzzle smoke, since it would hide the target, and no fort answers them by firing on a ship. Nor does a fort fire on arrival at a port saved battered: only fresh hits start a fight.

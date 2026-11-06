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

Shots are swept against each visible sailor as an upright capsule. The solid hull ends at the rail, so a shot above it meets whoever stands in its path, and a shot below it stops at the hull. A ball goes straight through a body and flies on. It kills outright, and it can take a limb (55% on an arm or leg), break one (30%) or crush the chest (60% of torso hits). Those chances are authored. Splinters fly from a hit that breaks through or strikes a bulwark, reach about 3 m at most and can break limbs. A small count stands in for crew who are not drawn, in proportion to how crowded the ship is. Only a magazine blast harms by area. Swivels and archers lay on people above the rail; great guns lay on the hull.

## Smoke, flash and sound

A short muzzle flash illuminates nearby timber and crew. Connected three-dimensional powder clouds expand from each actual muzzle, slow, entrain in the wind and dilute. They are raymarched finite volumes, clipped to the resolved ship/ocean depth, with sky and sun illumination. Smoke is off-white in daylight and darkens at night. The approximation is bounded; it is not a fluid simulation.

The existing Web Audio context spatializes each report. Sound arrives after distance divided by the speed of sound; nearby report arrivals can share a mixing voice while their projectiles remain independent. Gun reports have a separate bounded source pool so they do not consume every crew/mechanical voice. [Sound generation, listening review and provenance](GUNNERY_AUDIO.md).

Secured gunnery emits no smoke/particle work or ocean readback. A manned, loaded battery adds a bounded muzzle-clearance query while it awaits orders. A broadside adds bounded round shot, smoke volumes and impact slots. Full Victory broadsides cost more than idle sailing, particularly close to the smoke. The existing resolution monitor retains its 30 FPS target; physical iPhone performance still requires device testing.

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
- **Masts.** A mast divides at its two break heights. Rings, tops, yards, sails and rigging belong to the section they are fixed to, so they fall as one rigid body. Victory breaks at her real joints. A pole mast is cut there when the model is built, with a splintered cap on each side. A section topples from its break, at the station its own spar stands at, goes over the side and floats flat with its yards level, then sinks. Rope goes with the mast as it starts to lean, then is gone, parted. The crow's nest, pennant and parrels go when what they stand on goes.
- **Guns.** A dismounted gun is knocked off its trucks and stays aboard. It goes back when remounted.
- **Magazine, broken back.** A magazine blast throws everything in its radius. A broken back takes the planking across that station. Neither bends her: she founders as she was.
- **Graphics.** JavaScript writes one 64-byte flight record when a shard breaks. A compute pass moves each shard every frame, rigid in metres, and runs only once something has broken. While anything is in the air, a single clock value is uploaded per frame.
- **Saves.** Masts return from `mastState`. Shards shot away are listed in the snapshot and come back already gone. A full structural repair restores them.

Fallen wreckage stays in the ship's frame while it floats, so she tows it.

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
- **What a breach shows.** The faces inside a wall begin as points, so an intact wall costs what it always cost. A break opens the hidden faces of the block's neighbours, in raw stone. A fort's facing stands in front of a rubble core, and only the rim of its rampart falls with the wall. The rest of the flat stays, because earth holds it.
- **Support.** A link says whether a shard rests on another or only stands beside it. Support climbs from the ground through what rests on what. A stone can also hang from the stone beside it for its span, one stone in masonry and three or four in timber and roofs, and the stone on top of that one is a step better off. A small hole stands as an arch. A wide breach brings down a triangle of wall above it, each stone a moment after the last.
- **Compounding.** A penetrating shot takes the nearest blocks at once, a light one only wears them, and worn blocks are scorched. A collapse takes what stands above its own height. A magazine blast throws everything in its radius outward.
- **Rubble.** A piece lands on what is under the place it comes down: the ground, a floor below it, or the heap already there. It rolls off a heap steeper than the angle of repose and lies about flat, and it stays. Stone over deep water goes to the seabed. Timber over deep water floats a while, then is gone.
- **Graphics.** A struck building draws from its own buffers, and its range of the port's index buffer is cleared once. A hit writes flight records and shard scorch, nothing else. The pose pass runs only while something is in the air or just changed, and the last pose stays in the vertex buffer, so a ruin costs its triangles and no compute. An intact port pays nothing.

- **Shots.** A building is one box to the sweep, so its pieces decide what a shot meets. Where a line goes in through a gap, the shot flies on to the next thing standing, inside the building or beyond it, and strikes whatever that is. A fort's earth stops it, so a ball does not pass through a rampart. A ball goes through men ashore on its way, as it does sailors.
- **Saves.** A building's record is its standing plus its hits, sixteen characters each, and replaying the hits puts every piece back exactly where it fell, with nothing seen to fall. The career save holds every port. A share link holds the port in view, the worst damage first, as much as fits in nine thousand characters. A port with no record costs one lookup. Fires go out across a reload, and soldiers a ball struck get back up. Those whose wall has gone stay down, because the hits say so.
- **Rebuilding.** A town rebuilds what was shot down. A week's clearing up, then up to 30 days for timber, 60 for masonry and 90 for a fort, in proportion to the damage, counted in game days from the last shot. Being hit again restarts the count. The building comes back whole, all at once, and its saved damage is gone.

- **Soldiers.** A man comes down with the stretch he stands on, to the ground, a floor or the rubble under him, and stays down. One walking a rampart keeps to what is left of his beat. On a fort's deck he only steps down when the parapet goes, because the rampart still holds him. A saved ruin has its men already down, and a rebuilt one has them back at their posts. This is worked out only when a building has lost something, never by the frame.

`node scripts/building-damage-review.mjs` takes pictures of this from the real game. `npm run perf -- '[["fort",{"fort":"siege"}]]'` measures it.

## The free camera's cannon

For trying out destruction: in the free camera, hold F to fire a 24-pounder where the sight points, at most once a second (`js/free-cannon.js`). Its balls strike ships, buildings, trees and ground as any other, and what they do is saved like any other damage. They raise no muzzle smoke, since it would hide the target, and no fort answers them by firing on a ship. Nor does a fort fire on arrival at a port saved battered: only fresh hits start a fight.

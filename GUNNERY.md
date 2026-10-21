# Gunnery

Copyright © 2026 Six Cailloux, LLC. Code: MIT; see LICENSE.

Open **Captain → Gunnery**. Prepare port or starboard, wait for the battery to report ready, then order that broadside to fire. Each order fires once. Prepare again to reload; Cease fire cancels guns that have not yet discharged. Stand down releases the gun crews; a new sailing order also returns them to ship duties. Ready guns retain their load, but cannot fire without their crews; interrupted loading restarts on the next preparation order. Enable sound for the captain, gun crews, tackles and reports. Muting does not shorten the captain's order or accelerate firing.

Niña retains four small rail swivel guns. Victory has 104 mountings: three principal batteries, quarterdeck and forecastle guns, including the two forward carronades. They are distinct gun types, rather than scaled copies of one shot. Preparation moves guns inboard for loading; gun carriages and barrels run out, fire, recoil and remain spent. Fixed port frames and lids do not recoil.

## Drill and crew

Victory’s stages are wet sponge, load, ram, run out, prime and ready. Niña’s small swivels use removable breech-chamber handling, rather than reaching over the rail to ram an inaccessible muzzle. Visible crews walk to assigned stations; loading pauses without attendance or while they brace. Captain and helmsman keep their stations. Sail work already underway must finish or descend safely. The cannon animation and sound follow actual stage transitions; a preset visual timer does not fire the gun.

Victory's twelve visible sailors represent a watch, not her entire complement. A small selection of weather-deck teams demonstrate the drill; the interior batteries and remaining teams are abstracted. This release does not animate hundreds of gun-deck sailors or reproduce every officer, powder runner, vent thumbstall and safety step of the full historical drill. Reload durations (33 seconds of attended work) and the rolling broadside interval (0.14 seconds) are gameplay settings, not measured historical timings.

## Flight, recoil and water contact

Solid cast-iron round shot inherits the muzzle's full physical velocity, including forward motion, leeway, heave, yaw, pitch and roll. The muzzle follows the rendered barrel, and heel changes its actual firing direction. Flight integrates gravity and quadratic drag relative to ambient wind at 120 Hz. Dispersion is seeded and small. There are no glowing tracers, guided shots or explosive cannonballs.

Shot weight is in imperial pounds; mass is converted to kilograms. Diameter follows an iron sphere at 7,200 kg/m³. The 32-pounder reference speed is 487.68 m/s (1,600 ft/s); the 24-pounder, 12-pounder, swivel and carronade speeds are authored approximations. Constant drag coefficient 0.47 does not reproduce the changing transonic drag of real round shot.

An opposite impulse enters the existing hull's surge, leeway, heave and angular velocity states. The normal mass, added-water inertia and hull resistance then govern motion. Recoil is applied once per discharge, not repeatedly while its animation plays.

Loaded muzzles also require a fresh GPU sea-clearance sample before the captain can order fire, and each gun is checked again at discharge. Awash muzzles, stale readbacks, substantial movement and changed sea/ship revisions hold fire without spending a round or applying recoil. The HUD distinguishes checking the sea from gunports awash. A 10 cm clearance margin is an authored operational constraint, not a recovered historical firing rule.

Contact sweeps the shot's trajectory against all six cascades of the actual GPU ocean, including inverse horizontal displacement. Spatial subdivisions and bisection catch crests between integration points. Asynchronous readback retains unchecked trajectory segments. It samples the current wave field, rather than reconstructing historical FFT textures at every past trajectory time. Splashes are emitted from those measured contacts with the arriving velocity and shot mass.

Ship penetration, structural damage, land impacts, water-skipping ricochets, variable powder charges, adjustable gun elevation, and AI combat decisions are subsequent systems. The following ship keeps its guns secured. This is a firing and sea-impact system, not a completed combat model.

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

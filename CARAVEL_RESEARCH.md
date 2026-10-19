# Caravel shape and equipment audit — 19 October 2026

This is a reconstruction-guided game vessel, not a replica with surveyed offsets.
The established 20 × 6 m size and twelve-person company are retained. The chosen
baseline is Martínez-Hidalgo’s interpretation of Niña after conversion to square
sails in the Canaries, rather than a mixture of incompatible reconstructions.

## Drawings examined

- [Martínez-Hidalgo 1963 and d’Albertis 1892 Niña plates](https://navires-anciens.be/plans_de_la_nina/), reproduced by Navires Anciens. Visually inspected the sheer/profile, half-breadth and body views in both plates. The Martínez-Hidalgo plate guides this revision: narrowing forebody, curved/raked stem, finer underwater ends, full midbody and narrowing stern. These are differing modern reconstructions, not surviving fifteenth-century construction plans.
- [Mariners’ Museum Niña model](https://catalogs.marinersmuseum.org/object/CL21542), based on Martínez-Hidalgo hull drawings. Its inventory includes four falconets on the poop rail. Its rig follows a separate four-mast hypothesis; only its equipment inventory informs our guns.
- [Martínez-Hidalgo, *Columbus’ Ships*](https://www.scribd.com/document/305995423/Columbus-Ships), printed pp. 98–100, explicitly describes the converted Niña with square forecourse and maincourse, a lateen mizzen, no topsails, no spritsail and no round top. The tiller is described on p. 99; the general steering discussion places it on the main deck. The adjacent Pinta discussion supplies the Mediterranean runner convention, an inference for our Niña rig. Earlier pp. 21–27 and 38–39 inform the low forward deck.

## Implemented interpretation

`js/hull.js` now uses ten authored longitudinal breadth stations and monotone
Hermite interpolation. They are visually guided approximations, **not offsets
traced or measured from the plates**. CPU geometry and WGSL water exclusion share
the coefficients. The bow narrows sooner; the midbody has modest tumblehome;
forward and aft submerged sections become finer. A curved stem follows the same
surface. Draft is 2.0 m at default scale; integrated displacement is about 107.7 t.
The latter is the volume of this mesh, not historical tonnage.

There is one continuous main deck and one partial raised quarterdeck, with cargo
space implied below. The tall forecastle tier and its ladder were removed. The
hold has no modeled interior, and there is no separate enclosed gun deck. Two
small rectangular stern lights replace nine ornate arched windows. Four hollow-
muzzled iron falconets sit on swivel forks on the aft rail, clear of deck routes.
They are visible equipment; aiming, firing, ammunition and recoil are unimplemented.

The wheel is replaced by a direct tiller on the main deck beneath the quarterdeck.
The stock passes through a small stern port; a real opening in the forward cabin
bulkhead gives access. The helmsman follows the arm, with hands placed against it.
The player observes from the quarterdeck above. Control direction still commands
the desired turn; the forward-pointing tiller moves opposite the rudder blade.

The rig now has three single masts, two square courses and one lateen mizzen.
Both topsails and the large baskets are removed. Mast rake, sail proportions,
shorter bowsprit and longitudinal stays follow the selected plate's arrangement.
Paired runners lead to the waterways; there are no ratline ladders or channels.
These dimensions are authored approximations, not measurements extracted from the
plate. The source's proposed deck length is 20.10 m and beam 6.44 m, versus our
20 × 6 m. No exact-replica claim is made for hull volume, windows, deck fittings,
armament, rope count, crew complement or accommodation layout.

The source specifies a bonnet on the maincourse. Detachable bonnet handling,
yard lowering, mast-side changes of the lateen yard and detailed block systems
are not implemented. Continuous canvas gathering and automatic yard trim remain
simulation approximations. The museum model and modern sailing replica use an
alternative four-mast interpretation; their rigs are not used as interchangeable
evidence for this three-mast version.

## Simulation implications

The shared hull changes ocean masking, contacts, deck-wash width, displacement,
inertia and keel resistance together. Contact normals now follow the actual
planking gradient. Relative wave rise drives bounded quadratic impact forcing;
receding water or a stronger new strike re-arms bursts. Paired contact spans form
broader sheets, then mist breaks from their airborne lips. Sheet landings add
foam. This is still an authored visual response, not a slamming-pressure CFD model.

Crew climb the same central runners rendered by `js/rigging.js`; alternating
hand grips and simplified boot locks follow those ropes. Work gates sail movement,
and the carpenter closes a visible hatch. The lookout holds below the foremast
head; there is no platform to enter. Nearby crew fade in the helm camera;
exterior appearance and shadows remain intact. See [CREW.md](CREW.md).

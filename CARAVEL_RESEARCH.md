# Caravel shape and equipment audit — 18 October 2026

This is a reconstruction-guided game vessel, not a replica with surveyed offsets.
The established 20 × 6 m size and twelve-person company are retained.

## Drawings examined

- [Martínez-Hidalgo 1963 and d’Albertis 1892 Niña plates](https://navires-anciens.be/plans_de_la_nina/), reproduced by Navires Anciens. Visually inspected the sheer/profile, half-breadth and body views in both plates. The Martínez-Hidalgo plate guides this revision: narrowing forebody, curved/raked stem, finer underwater ends, full midbody and narrowing stern. These are differing modern reconstructions, not surviving fifteenth-century construction plans.
- [Mariners’ Museum Niña model](https://catalogs.marinersmuseum.org/object/CL21542), based on Martínez-Hidalgo hull drawings. Its inventory includes four falconets on the poop rail. This supports four small swivel cannon; it does not establish the exact armament of every caravel.
- [Martínez-Hidalgo, *Columbus’ Ships*](https://www.scribd.com/document/305995423/Columbus-Ships), especially the discussion of caravels and the forecastle, printed pp. 21–27 and 38–39. His interpretation distinguishes their low forward working area from a nao's raised forecastle.

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

The wheel, substantial lookout basket and five-panel three-mast rig remain game
concessions. In particular, the wheel is anachronistic for a fifteenth-century
caravel. Neither the two-mast Martínez-Hidalgo plate nor the museum's four-mast
rig exactly matches ours. A stricter period replica would require a separate rig
and tiller redesign. No contemporary certainty is claimed for window dimensions,
rail heights, gun dimensions, sail-handling choreography or the crew complement.

## Simulation implications

The shared hull changes ocean masking, contacts, deck-wash width, displacement,
inertia and keel resistance together. Contact normals now follow the actual
planking gradient. Relative wave rise drives bounded quadratic impact forcing;
receding water or a stronger new strike re-arms bursts. Paired contact spans form
broader sheets, then mist breaks from their airborne lips. Sheet landings add
foam. This is still an authored visual response, not a slamming-pressure CFD model.

Crew climb the same ratlines rendered by `js/rigging.js`; IK places limbs against
those lines. Work gates sail movement, and the carpenter closes a visible hatch.
The lookout holds on the foremast shrouds below the top: passage through the solid
crow's-nest platform remains future work. Nearby crew fade in the helm camera;
exterior appearance and shadows remain intact. See [CREW.md](CREW.md).

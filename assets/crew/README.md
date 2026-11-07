# Crew assets

`sailor.glb`: the male crew body, generated with Tripo on paid API credits and fitted to the classic
skeleton: 15,692 triangles, 8,342 vertices, 65 joints; Idle, Walk and Brace clips. Its file carries lighter
levels of 4,327, 1,569 and 320 triangles.
`sailor-female.glb`: the female crew body, made the same way on the classic female skeleton: 15,353
triangles, 7,742 vertices, 65 joints; the same clips and levels of 4,386, 1,552 and 320 triangles.
`captain.glb`: the ship and presidio captain body, generated with Tripo on paid API credits, fitted to the
classic skeleton (`--textured`) with its embedded 2048×2048 JPEG texture preserved, and decimated with
`scripts/safe-decimate.mjs` (`ignoreUvs: false`): 3,600 base triangles (from 5,316 raw), 3,567 vertices,
65 joints; Idle, Walk and Brace clips, and lighter baked levels of 1,500, 742 and 317 triangles.
`sailor-classic.glb`: 993,696 bytes, 15,995 triangles, 65 joints; the same clips. Its skeleton and clips are
what the male body is fitted to, and Indigenous men are built on it, because their dress re-sculpts its
garment pieces.
`sailor-female-classic.glb`: 1,212,816 bytes, 18,720 triangles, 65 joints; the same clips, retargeted to the
distinct female base mesh with tied hair. The same goes for the female body and Indigenous women.
Each GLB contains all geometry, vertex colours, skeleton and animation.
Runtime instances share each mesh and vary clothing, skin/hair colours, height,
facial proportions and animation phase. Six instances of each model form the
current company. Individual appearances live in `js/crew.js`; `js/wgsl/crew.js`
applies bounded head, jaw, nose and eye morphs before animation, including brows
and hair, with corrected normals and matching shadows. The GLB files and skeletons
retain their established rig and animation data. Black, white and East Asian appearances and red hair are
intentional artistic choices, independent of jobs and historical demographics.

Original assets: Quaternius [Universal Base Characters](https://quaternius.itch.io/universal-base-characters)
and [Universal Animation Library](https://quaternius.itch.io/universal-animation-library).
The animation library credits Quaternius and Gonzalo Furnier. Both packs use
[CC0 1.0](LICENSE-CC0.txt). The local clothing and retargeting adaptations are
also dedicated under CC0.

The official itch.io download stalled during acquisition. The unmodified free
Standard assets were retrieved from the public
[NafisRayan mirror](https://github.com/NafisRayan/Animate-Rigged-Humanoid-No-Blender/tree/5821923af517ac5fdc82505faa92a0d575fc1b1a),
pinned to `5821923af517ac5fdc82505faa92a0d575fc1b1a`. No code from that repository
is used or executed. Exact source paths and SHA-256 checksums are in
`scripts/prepare-crew.mjs`.

Rebuild the classic bodies from verified source data:

```sh
node scripts/prepare-crew.mjs /tmp/waterworld-crew --download
npm run build
```

Omit `--download` when those files already exist. Only this preparation command
contacts the source host. The running simulator uses the local GLB, embedded in
standalone builds; it does not contact an asset service.

Preparation retains target bone lengths, transfers animation rotations through
model-space rest poses, and keeps small pelvis/root translations. It removes
unused clips and textures, bakes each hair export's node transform, adds a belt,
and authors vertex colours and
slightly expanded clothing surfaces. The local body adaptation reduces torso,
upper-arm and thigh bulk and chest/bust projection with bone-weighted radial
reshaping. Heights, joint locations, hands, feet and animation data remain intact;
normals are recomputed and clothing/belt thickness reduced to match. The costume is an initial approximation,
not a documented historical reconstruction. Ground contact is approximate;
there is no foot IK or cloth simulation.

## Fitting a generated body

Generate and rig a character with Tripo using `--then "rig:spec=unreal"`, then fit it and bake its levels:

```sh
python scripts/fit-crew-body.py rigged.glb assets/crew/sailor-classic.glb assets/crew/sailor.glb
node scripts/bake-crew-levels.mjs assets/crew/sailor.glb
```

The woman was generated from this prompt, after a first attempt read as a man. Tripo's filter refused wording
about her figure:

> a single adult woman sailor from the 17th century with a feminine face, slim build and long dark hair
> gathered into a low ponytail, wearing a loose plain linen blouse, brown wool knee breeches and leather
> shoes, bare calves, full body, standing in T-pose with arms straight out and fingers separated, no hat,
> no weapons, no base

The fit keeps our skeleton and clips. It also moves elbows and knees onto our joints, and draws limbs in to
the classic thickness, because work poses were tuned on that body. The texture is baked to vertex colours
and split into shirt, trousers, skin and hair, each stored as a departure from that garment's typical
colour, so every sailor can wear their own while keeping the painted folds and faces. Shoes, belts and the
whites of the eyes keep their paint. The generated sources are kept in `.tripo/`, which git ignores.

Tripo's terms give paid users the rights to what they generate, including commercial use.

## Workwear refinement

The classic bodies remain the authored Quaternius crew. The Meshy replacement
experiment is shelved; its generated bodies and preparation scripts stay local
under `.meshy/`, outside standalone builds.

Revision 2 shapes cloth over the torso and limbs, adds a sewn neck band and
rolled cuffs, and bridges the trouser front and seat while retaining separate
leg openings. Coincident mirrored vertices share
smooth normals, removing lighting seams that exaggerated anatomical creases.
The body skin weights, 65-joint skeleton and animation curves are unchanged.
The belt borrows adjacent garment weights so it follows waist and hip bends.
New cuffs and collars use the existing forearm and neck bones;
they add 312 triangles per body. Runtime skin lighting has mild diffuse wrap
and a broad dry highlight; linen remains matte and wetness still follows spray.

This is stylized workwear, not cloth simulation or a calibrated historical
costume. Review front, rear, walking, crouching and work poses after rebuilding.

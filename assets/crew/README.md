# First deckhand

`sailor.glb`: 975,136 bytes, 15,683 triangles, 65 joints; Idle, Walk and Brace
clips. The GLB contains all geometry, vertex colours, skeleton and animation.

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

Rebuild from verified source data:

```sh
node scripts/prepare-crew.mjs /tmp/waterworld-crew --download
npm run build
```

Omit `--download` when those files already exist. Only this preparation command
contacts the source host. The running simulator uses the local GLB, embedded in
standalone builds; it does not contact an asset service.

Preparation retains target bone lengths, transfers animation rotations through
model-space rest poses, and keeps small pelvis/root translations. It removes
unused clips and textures, adds hair and a belt, and authors vertex colours and
slightly expanded clothing surfaces. The costume is an initial approximation,
not a documented historical reconstruction. Ground contact is approximate;
there is no foot IK or cloth simulation.

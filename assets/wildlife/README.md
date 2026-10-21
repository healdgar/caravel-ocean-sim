# Sperm whale

`whale.glb` is a reduced derivative of the user-supplied straight,
rigged `Meshy_AI_Character_output (1).glb`. It replaces the curled display model.

| | Supplied source | Runtime derivative |
|---|---:|---:|
| Triangles | 145,388 | 39,254 |
| Vertices | 81,768 | 28,526 |
| Weighted joints | 18 | 18 |

Source SHA-256: `8bb6babe3cf638efb988e3509fdc2875451e93be52b44f5b06b24fe2a02e2d94`.
Runtime SHA-256: `af1b3d2448efbc0f67673f46494c890aa901a4728ac627c3d2d55e3b00fe43f3`.

Blender reduction preserves the rig, UVs and all three original embedded JPEG
images byte-for-byte. A sampled nearest-surface comparison at the authored
14.1 m game scale found a maximum 2.7 mm source-to-reduced difference. This
sampled geometric comparison does not prove identical pixels at every pose.

`js/marine-asset.js` converts head +Z to actor -Z, retains Y up and centres the
neutral envelope. The game length is authored, not an anatomical measurement.
There are no supplied animation clips. `js/marine-rig.js` adds a bounded 5.2 s
travelling vertical tail stroke and paired flipper motion through the existing
bones; it applies no rest-pose curl correction. Skinning runs on the GPU.
As the root emerges, an authored smooth transition reduces that stroke to 20%
while airborne. It replaces a one-metre threshold that abruptly changed 80% of
the skeletal pose during a breach; the neutral mesh and rig remain untouched.

The forehead outlet is mapped to actor coordinates `[-.25, 1.28, -6]`.
Whale rendering and the outlet share pitch and roll. Exhalation and contact
particles are separate project simulations. Surface contacts still use an
analytic envelope, not collision against every animated triangle.

Each real blow also retains the animal-root X/Z at emission. Its outlet height
is relative to the ocean under that root, so the GPU's first birth query samples
the same root rather than a different wave under the forehead several metres
away. A negative, nonzero event key seeds the existing bounded origin cache;
the first compute dispatch replaces it with the positive key and frozen launch
height. Slot reuse captures a fresh origin. Synthetic effects without a root
anchor still sample their effect position. Airborne breath stays detached from
later animal movement and waves; later water still clips droplets and receives
their impacts. These are birth-snapshot effects, not a fluid simulation.

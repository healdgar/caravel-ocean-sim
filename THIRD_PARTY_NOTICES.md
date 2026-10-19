# Third-party code

## Quaternius crew assets

The first sailor adapts Quaternius Universal Base Characters and Universal
Animation Library (animations credited to Quaternius and Gonzalo Furnier), under
CC0 1.0 Universal: https://creativecommons.org/publicdomain/zero/1.0/.

Sources: https://quaternius.itch.io/universal-base-characters and
https://quaternius.itch.io/universal-animation-library.
The free Standard data was acquired from a public mirror pinned at
`NafisRayan/Animate-Rigged-Humanoid-No-Blender@5821923af517ac5fdc82505faa92a0d575fc1b1a`.
No mirror code is used. `assets/crew/README.md`, `assets/crew/LICENSE-CC0.txt` and
`scripts/prepare-crew.mjs` retain provenance, licence and exact source checksums.
Local costume/retargeting adaptations are also CC0.

## Joshbrew WebGPU clouds

The volumetric cloud density, cached lighting, and ray integration in
`js/wgsl/clouds.js` and `js/wgsl/cloud-model.js` adapt
[joshbrew/webgpu_realtime_clouds](https://github.com/joshbrew/webgpu_realtime_clouds)
at commit `bf7a48f949e25e09d463357149ec9d0009e97328`.

Source functions: `roundedCloudBody`, `cloudEllipsoid`, `cloudSoftUnion`, and
`buildCloudLightField` in `tools/clouds/shaders/cloudFields.wgsl`;
`cloudRayJitter` and the cached ray integration in `tools/clouds/shaders/clouds.wgsl`;
`contrast01`, `ridge01`, and `hash11Fast` in `tools/clouds/shaders/cloudCommon.wgsl`.

The adaptation uses kilometre coordinates, a periodic ocean cloud field, our
atmospheric LUTs, and our own camera reprojection and resource scheduling. It
omits the upstream playground, aircraft, terrain, planet renderer and engine
wrapper. Density changes rebuild the field; wind advects it without rebuilding.

MIT License

Copyright (c) 2025 Joshua Brewster (Bubba Skrimp)

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

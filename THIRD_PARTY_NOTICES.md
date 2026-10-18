# Third-party code

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

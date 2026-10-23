# Vendored dependencies

## Lossless forest transport

`forest-meshopt.js` vendors `meshoptimizer@1.3.0/meshopt_decoder.mjs`,
Arseny Kapoulkine, MIT. Upstream SHA-256:
`10b313edaa0e322b0c1b46443f6c8b186b42139fe1eca189d50c09511d0ebedc`.
Only its declaration/export changes: `var MeshoptDecoder` becomes
`export const ForestMeshoptDecoder`, and the trailing export is removed.
The embedded WebAssembly and decoder implementation remain unchanged.
The complete upstream notice is retained in `LICENSE.meshoptimizer`.
Source: https://github.com/zeux/meshoptimizer .

Forest transport uses lossless `ATTRIBUTES` or `INDICES` sequence decoding,
with no filters or index reordering. Encoded and original decoded SHA-256
receipts are verified locally. No decoder or WebAssembly is fetched remotely.

## Astronomy

Astronomy Engine by Don Cross, MIT, commit `865d3da7d8112bbc7911238052c6af4aaf877181`. `astronomy-engine.js` encloses the unmodified official `source/js/astronomy.browser.min.js` in a local CommonJS wrapper. Original SHA-256: `d1b3ab4b86aa409f78c0f0d95162a847496cba7e938eb6f4712cf9c1c45f4a2e`. Source: https://github.com/cosinekitty/astronomy/tree/865d3da7d8112bbc7911238052c6af4aaf877181 . License: `astronomy.LICENSE`.

`../star-catalog.js` derives magnitude ≤5.5 stars from HYG v4.1, David Nash / Astronexus, commit `c7f7f883fe678cc7680169a50ccd7dcc49b060ce`; CC BY-SA 4.0. Catalogue source SHA-256: `d9f69fd86bbf90a4e4d52b4c5c53eacfa6dfc0bfdef85bfd94f095e0bebe4ebd`. Source: https://github.com/astronexus/HYG-Database/tree/c7f7f883fe678cc7680169a50ccd7dcc49b060ce/hyg/CURRENT . The data derivative retains its separate license in `hyg.LICENSE`; the simulator code remains MIT.

No runtime network or credential is required.

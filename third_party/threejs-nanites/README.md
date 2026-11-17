# threejs-nanites cluster builder

The offline cluster DAG builder from [threejs-nanites](https://github.com/VictorZakharov/threejs-nanites) by Victor Zakharov, MIT (see LICENSE), at commit 500113d.

Only `src/nanite-lib/dag/` is here. It needs meshoptimizer and not three.js. The rest of that library draws through three.js, which this game does not use, so the runtime is our own WGSL in `js/forest-clusters.js`.

Local changes:

- `LeafVerts` and `DagResult` carry `src`, the source vertex behind every packed leaf vertex, so a tree's colours, materials and canopy exposure survive the build.
- Coarser leaf levels trade length for width (`rounder` in `dag/leaves.ts`), because our long thin leaves became streaks when grown.
- Bark can be split into parts (`barkParts`): a cluster holds one part, and the caller makes part boundaries seams. A caller can measure each group's error its own way (`barkGroupError`). Each cluster names the group it was simplified in and the one it merged into (`groups`). A skinned body uses all three (`scripts/prepare-crew-continuum.mjs`).

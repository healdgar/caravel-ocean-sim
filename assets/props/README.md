# Generated props

Models generated with Tripo on paid API credits, reduced and baked here. `js/port-props.js` places them and `js/props.js` draws them. Sources stay in `.tripo/`, which git ignores.

| File | Model | Triangles | Texture |
|---|---|---|---|
| `cleat.glb` | a mooring cleat, on pier and quay edges | 358 | 512 px |
| `jetty-weathered.glb` | a small jetty on the beach | 613 | 1024 px |
| `jetty-planked.glb` | a small jetty on the beach | 1,489 | 1024 px |

Rebuild one with:

```sh
node scripts/safe-decimate.mjs .tripo/cleat.glb --type prop --out assets/props/cleat.glb --python venv/bin/python
```

`--type structure` for a jetty. The Python needs `bpy`, which does the bake.

The generated ceiba isn't used. Grown trees look better at every distance, so it would only suit a species we can't grow.

To add a model, list it in `PROP_MODELS` and `runtimeAssetTypes` in `build.mjs`, and say where it goes in `layPortProps`.

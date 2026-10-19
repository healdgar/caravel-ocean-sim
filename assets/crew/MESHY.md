# Meshy crew source workflow

**Shelved October 19, 2026.** The user chose to refine the original 65-joint
Quaternius crew. Meshy candidates and preparation experiments remain local in
`.meshy/`; none is shipped. The CLI is retained for explicit future use.
The native remesh and later local reduction/weight-transfer attempts exhibited
surface and deformation defects in close review. A 65-bone derivative did not
resolve them. Experimental renderer changes were archived locally and removed
from the active runtime.

The local CLI generates source art with **Meshy 7.1**. It does not replace the
shipped sailors or call Meshy from the browser. Requires Node 20+; no extra npm
dependencies. Blender is used later for mesh preparation and binding.

## Credentials

Store the Meshy API key as a concealed field in 1Password, then configure its
secret reference (vault/item names or IDs both work):

```sh
npm run meshy -- configure --key-ref 'op://Private/Meshy API/credential'
npm run meshy -- doctor
```

The CLI calls `op read` directly with argument arrays, captures the secret only
in memory, and sends it only to `https://api.meshy.ai`. Unlock 1Password and enable
its CLI integration. Alternatively provide `MESHY_API_KEY_REF` or an already
injected `MESHY_API_KEY`. No key argument, key file, browser secret or committed
credential is used. `.meshy/config.json` stores only the reference.

## Generate and inspect

```sh
npm run meshy -- plan male
npm run meshy -- plan female
npm run meshy -- preview male
npm run meshy -- preview female
npm run meshy -- status TASK_ID
npm run meshy -- wait TASK_ID --seconds 45
npm run meshy -- download TASK_ID
npm run meshy -- inspect .meshy/tasks/TASK_ID/model.glb
```

`plan` is offline. **`preview` and `refine` consume Meshy API credits.** The initial
pair uses one male and one female, ordinary slim adult proportions, working
clothes, solid hair and separated fingers in a T-pose. Prompts live in
`scripts/meshy/crew-presets.json`; `--prompt-file FILE` overrides the geometry
prompt. These two appearances are initial art candidates, not the entire roster.
Pose and period work clothing are one shared prompt. Male/female describe body
anatomy only; neither changes costume, posture, job or equipment. The outfit is
an art reconstruction, not evidence of a standardized caravel uniform.

Inspect the generated shape from front, side and back in Blender before texturing:
limbs, fingers, shoulders, facial structure and clothing clearance matter more
than the thumbnail. Generation requests use `model_type: standard`, pinned
`ai_model: meshy-7.1`, and `should_remesh: false` to retain the source geometry.
The tool never silently switches to T2.5 or another model.

Render a neutral front/side/back inspection sheet with the installed Blender:

```sh
/Applications/Blender.app/Contents/MacOS/Blender --background --factory-startup --disable-autoexec --python scripts/preview-crew.py -- .meshy/tasks/TASK_ID/model.glb .meshy/tasks/TASK_ID/review.png
```

The sheet normalizes display height only; it does not modify or rig the GLB.

After accepting a preview, texture that task:

```sh
npm run meshy -- refine PREVIEW_TASK_ID --preset male
npm run meshy -- wait REFINE_TASK_ID --seconds 45
npm run meshy -- download REFINE_TASK_ID
```

Refine requests pin 7.1 and request 2K PBR textures. Use `--preset female` for
the female candidate. Keep the high-detail source and maps; optimize a copy.

## Image-guided candidates

The first two text-only rounds failed the requested pose/costume. Prefer a
single-person front-view T-pose image with the same work outfit across body types:

The initial reference pair was made with the built-in image generation tool.
Exact prompts and edit relationship are in `scripts/meshy/reference-prompts.json`;
the project copies are `.meshy/references/female-v1.png` and `male-v1.png`.
The male's hip/waist proportions were then revised independently in `male-v2.png`;
the female reference remains unchanged.

```sh
npm run meshy -- image-plan .meshy/references/female-v1.png --preset female
npm run meshy -- image .meshy/references/female-v1.png --preset female
npm run meshy -- status IMAGE_TASK_ID
npm run meshy -- download IMAGE_TASK_ID
```

`image` is a paid Image-to-3D request with 7.1, T-pose, no geometry decimation,
2K PBR textures, and image enhancement disabled to preserve the supplied design.
It uploads the chosen local reference to Meshy as a data URI. JSON logs retain
the source path/hash instead of duplicating image data. The task record selects
the correct API for later status/download commands. To recover an image task
without its local record, use `--kind image`, including `list --kind image`.
Image tasks already include texturing; do not use the text-preview `refine`
command on them. Textured outputs still require inspection and rig preparation.

### Current source candidates (October 19, 2026)

Downloaded and rendered in Blender from front, side and back:

| Candidate | Task ID | Source triangles |
| --- | --- | ---: |
| Female, unchanged approved reference | `01a15598-c591-776c-bb4e-c239c95c791d` | 1,561,100 |
| Male, corrected hip/waist proportions | `01a1559b-96be-7522-9570-80240fdb9e08` | 960,042 |

Each task directory contains the original `model.glb`, 2K PBR maps, `review.png`,
and `review.json`. Those originals remain unrigged. The male reference has the
requested narrower hips and straighter waist. Prepared derivatives live separately
under `.meshy/prepared/`; none replaces the shipped Quaternius crew.
The local `.meshy/crew-generation-report.json` records seven generation tasks
(170 credits) plus four native remesh/rig tasks (20 credits), including rejected
and superseded candidates.

## Native remesh and auto-rig

The first local preparation under `.meshy/prepared/` **failed visual review**.
Do not integrate those derivatives. Fitting the bodies to the old superhero
skeleton distorted their anatomy; aggressive reduction, donor weights and texture
rebaking damaged clothing and animation. Structural tests did not detect these
visual failures. The source GLBs are intact.

The following describes the shelved experiment, not the active asset pipeline.
It used the original successful generation tasks with Meshy's native remesher,
then its auto-rigger. The skeleton must fit the body; preserve the source anatomy.
The original models exceed the rigging API's 300,000-face limit for task inputs.
Start with 20,000 quad-dominant polygons as an intermediate asset; GLB triangulates
quads, so inspect actual triangle counts before claiming a runtime budget.

```sh
npm run meshy -- remesh ORIGINAL_TASK_ID --polygons 20000 --topology quad
npm run meshy -- wait REMESH_TASK_ID --seconds 45
npm run meshy -- download REMESH_TASK_ID
npm run meshy -- rig REMESH_TASK_ID --height 1.75
npm run meshy -- wait RIG_TASK_ID --seconds 45
npm run meshy -- download RIG_TASK_ID
```

Use 1.75 m for the male and 1.68 m for the female starting models. These are
production scale choices, not historical measurements. Remesh and rigging each
cost 5 credits per character at the documented October 19, 2026 rate.

Rig downloads include `model.glb` and, when supplied by Meshy, `walking.glb` and
`running.glb`. Preserve their fitted bones and skin weights for visual review.
Do not transplant the old skeleton or its animation keys directly. Later game
integration needs animation retargeting and an IK bone mapping. Auto-rig success
alone does not approve anatomy, hands, cloth, weights, or animation quality.

- [Remesh API](https://docs.meshy.ai/en/api/remesh)
- [Rigging API](https://docs.meshy.ai/en/api/rigging)
- [API pricing](https://docs.meshy.ai/en/api/pricing)

### Native results (October 19, 2026)

Both remesh and rig tasks completed and were downloaded. No shipped assets changed.

| Body | Remesh task | Rig task | Triangles | Walking vertices | Bones |
| --- | --- | --- | ---: | ---: | ---: |
| Male | `01a155ba-7461-777d-af19-92c61c40d07c` | `01a155bd-0bac-77b7-9b36-fca8a5c0c4c8` | 38,975 | 30,537 | 24 |
| Female | `01a155ba-a928-7126-aacd-8d434c6fa8cf` | `01a155bd-1771-74c1-8807-484a6fa43f71` | 50,933 | 44,579 | 24 |

These are intermediate assets above the final mobile budget. Native walking
preserves the silhouettes considerably better than the rejected donor-rig pass.
The female crotch still pinches; shoulders and clothing need refinement. There
are no individual finger bones, so rope/tiller grasp poses need extra rig work.
Garment cleanup has not been carried over from the rejected derivatives.

`scripts/review-meshy-native.py` renders the supplied walking GLBs without locally
warping anatomy or transferring weights. `.meshy/native-rig-review/` contains the
editable Blender scene, walking frames/video and manifest. Numeric checks verified
normalized weights and finite transforms across 32 samples of each returned clip;
that does not certify deformation or visual quality. The current game still needs
texture support, animation retargeting and a bone mapping for crew work/IK.

## Local records and recovery

All downloads and task records stay under gitignored `.meshy/`. Download manifests
record file size and SHA-256; remote signed asset URLs and API keys are omitted.
Download again to refresh URLs and recover incomplete/corrupt files. Meshy results
expire, so download successful tasks promptly. No remote task is deleted.

Identical requests reuse their saved task IDs. A reservation written before each
POST prevents simultaneous or interrupted commands from silently buying another
task. A definite authentication/quota/input rejection permits retry; a timeout or
server failure leaves the reservation intact because the task may exist remotely.

```sh
npm run meshy -- list --page 1
```

Recover the matching ID using the prompt and creation time, then use `status`,
`wait` and `download`. If necessary inspect the local submission record. Only use
`--attempt 2` (or another unique name) when deliberately requesting another paid
candidate. The CLI does not automatically retry POSTs or recover by regenerating.
Stopping `wait` does not cancel the remote task; a pending task can be checked
again later. API-created tasks may not appear in Meshy's web-app asset library.

## Renderer integration still required

Raw Meshy GLBs are **not drop-in crew replacements**. Offline inspection reports
counts, textures, loader compatibility and correspondence with our two existing
rig templates. A structural match does not establish visual quality or correct
deformation under all animations.

The rejected local derivatives met numerical budgets but failed visual review.
Native auto-rig outputs require a different skeleton/animation adapter. Neither
set is approved for the current renderer.

The present renderer accepts vertex colors only. Retaining the generated facial
and cloth detail requires adding UV/material texture support to the crew loader,
GPU layout and shaders, with matching shadows. Existing color masks, facial
deformations and wetness coordinates also require adaptation. Confirm walking,
climbing hand/foot contacts, tiller grip, camera transparency and wet lighting
before replacing the shipped assets. Keep the two shared model batches where
possible; validate iPhone performance after integration.

Generated assets do not inherit the existing Quaternius CC0 license. Record
generation provenance and the applicable Meshy account terms when promoting
accepted source art into tracked assets.

## Validation and references

```sh
node --test tests/meshy.test.mjs
```

Tests exercise credentials, pinned request shapes, duplicate/ambiguous submissions,
polling, download integrity/resume, safe asset hosts and existing rig inspection.
They use fake API responses; only `doctor` or real tasks verify live access.

- [Text-to-3D API](https://docs.meshy.ai/en/api/text-to-3d)
- [Authentication](https://docs.meshy.ai/en/api/authentication)
- [Task lifecycle](https://docs.meshy.ai/en/api/task-lifecycle)
- [Asset retention](https://docs.meshy.ai/en/api/asset-retention)
- [1Password secret reads](https://developer.1password.com/docs/cli/reference/commands/read/)

API contract checked October 19, 2026.

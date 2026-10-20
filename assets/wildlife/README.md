# Whale

`whale.glb` is the user-supplied `Meshy_AI_Character_output.glb`, unchanged.
SHA-256: `86dce920b93ac22cf864feac74a457abea9da1e9efc25aec7c1a73a6634f5632`.

It is the compatible rigged version of
`Meshy_AI_Gentle_Giant_of_the_D_1020213410_texture.glb`: 10,792 vertices,
15,717 triangles, matching UVs/indices, three embedded JPEG maps and 23 joints.
Its source position scale/origin differ from the initial static export.
Neither supplied file contains animation clips.

`js/marine-asset.js` converts head +Z to actor -Z, retains Y up, sets the authored
game length to 14.1 m and aligns the trunk with the encounter origin. This game
scale is not an anatomical measurement. UVs, weights and textures are preserved.
`js/marine-rig.js` relaxes the raised display tail and adds bounded swimming
strokes through the existing joints. Skinning runs on the GPU.

The forehead outlet is mapped to actor coordinates
`[-3.79664, 1.2930143, -6.10073]`. Exhalation and water-contact effects are
separate project simulations. See the repository's asset notices.

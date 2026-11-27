// Bundles index.html + js modules into self-contained pages that can be opened directly
// from disk (file://) without a server:
//   ocean.html      readable bundle
//   ocean.min.html  minified bundle (WGSL comments/whitespace stripped; JS minified with
//                   esbuild when it can be found, otherwise comments/indentation stripped)
//   node build.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import vm from 'node:vm';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { FOREST_ASSETS, SUBTROPICAL_FOREST_ASSETS, PORTUGAL_FOREST_ASSETS } from './js/forest-scenery.js';
import { FOREST_CONTINUUM_ASSETS, SUBTROPICAL_FOREST_CONTINUUM_ASSETS, PORTUGAL_FOREST_CONTINUUM_ASSETS, FOREST_CONTINUUM_MOBILE_ASSETS, PORTUGAL_FOREST_CONTINUUM_MOBILE_ASSETS } from './js/forest-continuum.js';
import { SUBTROPICAL_FOREST_GROVE_ASSETS, PORTUGAL_FOREST_GROVE_ASSETS } from './js/forest-groves.js';
import { PORTUGAL_MEADOW_GRASS_ASSETS, TROPICAL_MEADOW_GRASS_ASSETS, PORTUGAL_MEADOW_GRASS_MOBILE_ASSETS, TROPICAL_MEADOW_GRASS_MOBILE_ASSETS } from './js/meadow-continuum.js';
import { FOREST_SURFACE_ASSETS, SUBTROPICAL_FOREST_SURFACE_ASSETS, PORTUGAL_FOREST_SURFACE_ASSETS } from './js/forest-surfaces.js';
import { CREW_CONTINUUM_ASSETS, CREW_CONTINUUM_MOBILE_ASSETS, crewContinuumMissingMessage } from './js/crew-continuum.js';
import { HAIR_CONTINUUM_ASSETS } from './js/hair-continuum.js';
import { CLOTHING_CONTINUUM_ASSETS } from './js/clothing-continuum.js';
import { CITY_CONTINUUM_ASSETS } from './js/city-continuum.js';
import { PROP_CONTINUUM_ASSETS } from './js/prop-continuum.js';
import { BOULDER_CONTINUUM_ASSETS } from './js/boulder-continuum.js';
import { SHIP_CONTINUUM_ASSETS } from './js/ship-continuum.js';
import { ANIMAL_CONTINUUM_ASSETS, LIVESTOCK_TEXTURE_ASSETS } from './js/animal-continuum.js';
import { CONTINUUM_BAKE_ASSETS } from './js/continuum-bake-client.js';
import { BAKED_BOARDS, BAKED_WORLDS } from './js/board-model.js';
import { bundleContinuumBakeWorker } from './scripts/continuum-bake-worker-bundle.mjs';

const root = path.dirname(fileURLToPath(import.meta.url));
const wgslModules = ['js/wgsl/common.js', 'js/wgsl/celestial.js', 'js/wgsl/hull.js', 'js/wgsl/lateen.js', 'js/wgsl/victory.js', 'js/wgsl/vessel.js', 'js/wgsl/vessel-pose.js', 'js/wgsl/shadows.js', 'js/wgsl/interaction.js', 'js/wgsl/surface-waves.js', 'js/wgsl/surface-coupling.js', 'js/wgsl/fleet-wakes.js', 'js/wgsl/cloud-model.js', 'js/wgsl/clouds.js', 'js/wgsl/sky.js', 'js/wgsl/deck.js', 'js/wgsl/spindrift.js', 'js/wgsl/wetness.js', 'js/wgsl/sim.js', 'js/wgsl/water-optics.js', 'js/wgsl/underwater.js', 'js/wgsl/ocean.js', 'js/wgsl/ocean-lighting.js', 'js/wgsl/post.js', 'js/wgsl/neural-post.js', 'js/wgsl/neural-pbr.js', 'js/wgsl/caravel.js', 'js/wgsl/crew.js', 'js/wgsl/terrain.js', 'js/wgsl/weather.js', 'js/wgsl/anchor.js', 'js/wgsl/dolphins.js', 'js/wgsl/marine-life.js', 'js/wgsl/gunnery.js', 'js/wgsl/gunnery-probe.js', 'js/wgsl/hull-contact.js', 'js/wgsl/rowing-water.js', 'js/wgsl/crew-solve.js'];
const order = ['js/vendor/astronomy-engine.js', 'js/star-catalog.js', 'js/astronomy.js', 'js/continuum-core.js', 'js/continuum-census.js', 'js/continuum-format.js', 'js/crew-skeleton.js', 'js/rig-definition.js', 'js/hull-loft.js', 'js/models/additional.js', 'js/models/rowing.js', 'js/models/later-sail.js', 'js/models/procedural.js', 'js/models/nina.js', 'js/models/victory.js', 'js/hull.js', 'js/rig-plan.js', 'js/rigging.js', 'js/lateen.js', 'js/additional-rig.js', 'js/rig-surface.js', 'js/rowing.js', 'js/procedural-models.js', 'js/ship-models.js', 'js/victory-motion.js', 'js/sail-aerodynamics.js', 'js/sailing.js', 'js/dolphin-state.js', 'js/marine-life-state.js', 'js/hull-lateral.js', 'js/boat.js', 'js/gunnery-state.js', 'js/gunnery-models.js', ...wgslModules, 'js/celestial.js', 'js/fleet.js', 'js/surface-waves.js', 'js/surface-bindings.js', 'js/rowing-water.js', 'js/rowing-surface-events.js', 'js/gunnery-effects.js', 'js/gunnery-sea-probe.js', 'js/gunport-safety.js', 'js/hull-contact.js', 'js/vessels.js', 'js/follower.js', 'js/anchor-state.js', 'js/ship-parts.js', 'js/water-optics.js', 'js/underwater.js', 'js/anchor-iron.js', 'js/anchor.js', 'js/animal-scene.js', 'js/dolphins.js', 'js/dolphin-ui.js', 'js/gltf.js', 'js/marine-asset.js', 'js/marine-rig.js', 'js/marine-life.js', 'js/marine-loader.js', 'js/marine-ui.js', 'js/caravel.js', 'js/mesh-writer.js', 'js/victory.js', 'js/additional-ships.js', 'js/rowing-ships.js', 'js/later-sail-ships.js', 'js/ship-mesh.js', 'js/crew-work.js', 'js/crew-pose.js', 'js/crew.js', 'js/wetness.js', 'js/sharing.js', 'js/camera.js', 'js/free-cam-mobile.js', 'js/vessel-pose.js', 'js/shadows.js', 'js/deck.js', 'js/interaction.js', 'js/spindrift.js', 'js/clouds.js', 'js/terrain-model.js', 'js/vegetation.js', 'js/terrain.js', 'js/landfall.js', 'js/profiler.js', 'js/resolution.js', 'js/instruments.js', 'js/controls.js', 'js/weather-state.js', 'js/audio-assets.js', 'js/voice-assets.js', 'js/voice-lines.js', 'js/gunnery-audio-assets.js', 'js/gunnery-audio.js', 'js/gunnery-control.js', 'js/gunnery-ui.js', 'js/audio.js', 'js/weather.js', 'js/main.js'];
// Baked stand loading is deferred to landfall; preserve existing module order.
order.splice(order.indexOf('js/vegetation.js')+1,0,'js/indigenous-sovereignty.js','js/cairn-primitives.js','js/coastal-world.js');
order.splice(order.indexOf('js/terrain.js'),0,'js/coastal-field.js');
order.splice(order.indexOf('js/terrain.js'),0,'js/sea-colour.js');
order.splice(order.indexOf('js/gltf.js'),0,'js/crew-pose-cadence.js');
order.splice(order.indexOf('js/crew-work.js'),0,'js/crew-navigation.js','js/crew-motion.js','js/models/crew-deck-masks.js','js/crew-deck.js','js/crew-traffic.js');
order.splice(order.indexOf('js/crew-pose.js'),0,'js/crew-physics.js');
order.splice(order.indexOf('js/crew.js'),0,'js/crew-clip-pose.js');
order.splice(order.indexOf('js/crew.js'),0,'js/crew-solve.js');
// People through the one continuum: the baked format, strand hair, its GPU cut and draws, and the batches crew.js keeps.
order.splice(order.indexOf('js/crew.js'),0,'js/crew-continuum.js','js/hair-continuum.js','js/clothing-continuum.js','js/wgsl/crew-continuum.js','js/bc7-transcode.js','js/crew-continuum-draw.js');
order.splice(order.indexOf('js/terrain.js'),0,'js/terrain-near.js');
order.splice(order.indexOf('js/terrain.js'),0,'js/forest-scenery.js');
order.splice(order.indexOf('js/terrain.js'),0,'js/forest-groves.js');
order.splice(order.indexOf('js/forest-scenery.js'),0,'js/forest-surfaces.js');
order.splice(order.indexOf('js/forest-scenery.js'),0,'js/task-yield.js');
order.splice(order.indexOf('js/forest-scenery.js'),0,'js/forest-trunk-shapes.js','js/forest-trunks.js');
// The forest on the one continuum: its atlas's packing, then its material and stand pass, which read the trunks' codes.
order.splice(order.indexOf('js/forest-scenery.js'),0,'js/forest-continuum.js','js/wgsl/forest-continuum.js');
order.splice(order.indexOf('js/profiler.js')+1,0,'js/gpu-benchmark.js');
order.splice(order.indexOf('js/main.js'),0,'js/wgsl-prune.js','js/gpu-program-cache.js','js/models/neural-light-weights.js','js/neural-post.js');
order.splice(order.indexOf('js/main.js'),0,'js/career-save.js','js/career-ui.js','js/career-era.js','js/career-trade.js','js/career-port.js');
order.splice(order.indexOf('js/gunnery-control.js'),0,'js/hull-holes.js','js/vessel-damage.js');
order.splice(order.indexOf('js/main.js'),0,'js/sea-shadows.js');
order.splice(order.indexOf('js/crew-solve.js'),0,'js/crew-wounds.js');
order.splice(order.indexOf('js/crew.js'),0,'js/crew-overboard.js');
order.splice(order.indexOf('js/crew.js'),0,'js/crew-aloft.js','js/crew-components.js');
order.splice(order.indexOf('js/wgsl/vessel-pose.js'),0,'js/wgsl/rig-surfaces.js');
order.splice(order.indexOf('js/wgsl/vessel-pose.js'),0,'js/wgsl/vessel-recoil.js');
wgslModules.push('js/wgsl/human-morph.js','js/wgsl/part-assembly.js','js/wgsl/rig-surfaces.js','js/wgsl/vessel-recoil.js','js/wgsl/hull-flood.js','js/wgsl/townsfolk.js');
// Shaders read these constants as they are built, so they come first, after the fort plan the streets import.
order.unshift('js/version.js','js/asset-cache.js','js/fort-plan.js','js/fort-records.js','js/harbour-geography.js','js/harbour-defences.js','js/town-streets.js','js/indigenous-dress.js');
order.splice(order.indexOf('js/main.js'),0,'js/wgsl/townsfolk.js','js/town-clips.js','js/town-shots.js','js/townsfolk.js','js/board-armies.js','js/prop-continuum.js','js/wgsl/prop-continuum.js','js/gunnery-tools.js','js/props.js','js/free-cannon.js','js/castle-duel.js');
order.splice(order.indexOf('js/coastal-world.js'),0,'js/port-props.js','js/tripo-pier-assets.js');
wgslModules.push('js/wgsl/ship-fracture.js');
order.splice(order.indexOf('js/wgsl/vessel-pose.js')+1,0,'js/wgsl/part-assembly.js');
order.splice(order.indexOf('js/wgsl/part-assembly.js')+1,0,'js/wgsl/ship-fracture.js');
order.splice(order.indexOf('js/boat.js'),0,'js/ship-part-taxonomy.js');
order.splice(order.indexOf('js/ship-parts.js'),0,'js/part-assembly.js');
order.splice(order.indexOf('js/ship-parts.js'),0,'js/ship-fracture.js');
order.splice(order.indexOf('js/terrain.js'),0,'js/continuum-bake-client.js','js/building-fracture.js');
order.splice(order.indexOf('js/terrain.js'),0,'js/land-craters.js');
order.splice(order.indexOf('js/wgsl/terrain.js'),0,'js/wgsl/land-craters.js');
wgslModules.push('js/wgsl/land-craters.js');
order.splice(order.indexOf('js/wgsl/neural-pbr.js'),0,'js/models/neural-pbr-weights.js');
order.splice(order.indexOf('js/terrain.js'),0,'js/ground-detail.js','js/neural-pbr.js');
order.splice(order.indexOf('js/wgsl/terrain.js'),0,'js/wgsl/ground-detail.js');
wgslModules.push('js/wgsl/ground-detail.js');
// The Old World: building types ahead of the land shader, which reads their constants, then the town plan and its country.
order.splice(order.indexOf('js/wgsl/terrain.js'),0,'js/native-works.js','js/old-world-works.js','js/old-world-buildings.js');
// The one cut (its pose kinds, the ships' and the wind's among them, then its select, lists and pipeline family,
// js/wgsl/continuum-cut.js), then the city continuum: its bodies' packing, then its material, which reads the
// buildings' own constants.
order.splice(order.indexOf('js/wgsl/terrain.js'),0,'js/wgsl/human-morph.js','js/wgsl/continuum-kinds.js','js/wgsl/ship-kinds.js','js/wgsl/continuum-wind.js','js/wgsl/continuum-cut.js','js/city-continuum.js','js/wgsl/city-continuum.js');
// The animal continuum: its atlas format, then how a family's pass writes its joints (the SKINNED kind's pose data),
// which the herds' and the sea's shaders are built on.
order.splice(order.indexOf('js/wgsl/terrain.js'),0,'js/animal-continuum.js','js/wgsl/skinned-pose.js');
wgslModules.push('js/wgsl/skinned-pose.js');
// A port's country as Castle and Commons' model founded it: what is asked of the model, how it stands here, and the GPU's stamp of it.
// The herds go first: board-folk.js reads herds.js's STREET_MOUNT_FLAG as it loads.
order.splice(order.indexOf('js/coastal-world.js'),0,'js/river-water.js','js/herds.js','js/board-model.js','js/board-worker.js','js/board-life.js','js/board-keep.js','js/board-folk.js','js/folk-card.js','js/mate-counsel.js','js/storyteller.js','js/first-mate.js','js/old-world-city.js','js/board-waterfront.js','js/place-landmarks.js','js/old-world-board.js','js/native-towns.js','js/colonial-towns.js','js/old-world.js');
order.splice(order.indexOf('js/terrain.js'),0,'js/board-stamp.js');
order.splice(order.indexOf('js/wgsl/terrain.js')+1,0,'js/wgsl/continuum-cards.js','js/wgsl/inland-water.js','js/wgsl/herds.js','js/wgsl/shallow-water.js','js/wgsl/surf-spray.js');
wgslModules.push('js/wgsl/continuum-cards.js','js/wgsl/inland-water.js','js/wgsl/herds.js','js/wgsl/shallow-water.js','js/wgsl/surf-spray.js');
order.splice(order.indexOf('js/terrain.js'),0,'js/inland-water.js','js/shallow-water.js','js/meadow-continuum.js','js/wgsl/meadow-continuum.js','js/meadow-crops.js','js/wgsl/meadow-blades.js','js/meadow-grass.js','js/trade-vessels.js');
order.splice(order.indexOf('js/trade-vessels.js'),0,'js/wgsl/hull-flood.js','js/hull-flood.js');
// Ships in the one continuum: the bodies' format and loading, ahead of the families that draw them (their kinds,
// js/wgsl/ship-kinds.js, stand beside the kernel's).
order.splice(order.indexOf('js/trade-vessels.js'),0,'js/ship-continuum.js');
// The fleet's own ships in the same continuum (js/vessel-continuum.js), drawn by main.js.
order.splice(order.indexOf('js/main.js'),0,'js/vessel-continuum.js');
// A city's buildings as the guns meet them: after the fracture code it hands them to, ahead of the land it is drawn with.
order.splice(order.indexOf('js/terrain.js'),0,'js/city-targets.js','js/boulder-continuum.js','js/wgsl/boulder-continuum.js','js/continuum-scene.js','js/continuum-cards.js','js/city-continuum-draw.js');
// The land's continuum: its programs ahead of the land shader its drawing is appended to, its bake and cut ahead of the land.
order.splice(order.indexOf('js/wgsl/terrain.js'),0,'js/wgsl/land-banks.js','js/wgsl/land-continuum.js');
wgslModules.push('js/wgsl/land-banks.js','js/wgsl/land-continuum.js');
order.splice(order.indexOf('js/terrain.js'),0,'js/land-continuum.js','js/land-banks.js');
// The ground the land draws, which every family standing on it reads: beside the shared core, ahead of them all.
order.splice(order.indexOf('js/continuum-core.js')+1,0,'js/continuum-profiles.js','js/continuum-ground.js','js/continuum-hiz.js','js/world-bodies.js');
order.splice(order.indexOf('js/main.js'),0,'js/port-damage.js','js/debug-world.js');
order.splice(order.indexOf('js/main.js'),0,'js/webgpu-adapter.js');
order.splice(order.indexOf('js/ship-mesh.js'),0,'js/rig-gpu-data.js');
order.splice(order.indexOf('js/ship-mesh.js'),0,'js/ship-collider.js');
order.splice(order.indexOf('js/vessel-pose.js'),0,'js/vessel-recoil.js');
order.splice(order.indexOf('js/gunnery-audio.js'), 0, 'js/world-audio-assets.js');
order.splice(order.indexOf('js/rigging.js'), 0, 'js/rope-wave.js');
order.splice(order.indexOf('js/gunnery-control.js'), 0, 'js/ship-colors.js', 'js/boarding-docking.js');
// A ship's detail layer (lines, colours, crow's nest, anchor): its passes and her colours' weave ahead of her hull
// shader, its assembly and compact state ahead of her mesh.
order.splice(order.indexOf('js/wgsl/caravel.js'), 0, 'js/wgsl/ship-colours.js', 'js/wgsl/vessel-detail.js');
wgslModules.push('js/wgsl/ship-colours.js', 'js/wgsl/vessel-detail.js');
order.splice(order.indexOf('js/ship-mesh.js'), 0, 'js/vessel-detail.js');
order.splice(
  order.indexOf('js/main.js'),
  0,
  'js/voyage/compass.js',
  'js/voyage/ocean-climate.js',
  'js/voyage/landfall-approach.js',
  'js/voyage/helmsman.js',
  'js/voyage/passage.js',
  'js/voyage/encounters.js',
  'js/voyage/chart-drawer.js',
  'js/voyage/voyage-controller.js',
);
// Downloads keep embedded assets. Pages uses identical bytes in independently
// cacheable, content-addressed files; optional audio/terrain need not travel in
// the initial HTML. Only these explicit runtime files and manifest MP3s qualify.
const runtimeAssetTypes = new Map([
  ['assets/boards/lisbon-1550.json','application/json'],
  // The founded world whole (the model's own save) and the model's program: fetched once the game is on the screen.
  ['assets/boards/lisbon-1550.world','application/octet-stream'],
  ['assets/board/game.js','text/javascript'],
  ['assets/board/runtime.js','text/javascript'],
  ['assets/caravel-oak-albedo.webp','image/webp'],
  ['assets/wildlife/whale.glb','model/gltf-binary'],
  // People are drawn through the continuum alone (CREW_CONTINUUM_ASSETS, below): the old crew bodies are not shipped.
  ['assets/props/cleat.glb','model/gltf-binary'],
  ['assets/props/jetty-weathered.glb','model/gltf-binary'],
  ['assets/props/jetty-planked.glb','model/gltf-binary'],
  ['assets/world/saba/albedo.png','image/png'],
  ['assets/world/saba/biome.bin','application/octet-stream'],
  ['assets/world/saba/height.bin','application/octet-stream'],
  ['assets/world/saba/manifest.json','application/json'],
  ['assets/world/land.json','application/json'],
  ['assets/world/hyg-stars.bin','application/octet-stream'],
  ['assets/ports/1550/land-materials-pbr.png','image/png'],
  ['assets/neural-pbr/neural-pbr-latents.bin.gz','application/octet-stream'],
  ['assets/neural-pbr/neural-light-weights.bin','application/octet-stream'],
]);
// The optional exporter declares this pack only after real source baking. Never
// manufacture a near tile to satisfy a build or fetch absent optional assets.
if(fs.existsSync(path.join(root,'assets/world/saba/wells-bay/manifest.json'))){
  for(const [name,mime]of [['manifest.json','application/json'],['height.bin','application/octet-stream'],['measured.bin','application/octet-stream'],['albedo.png','image/png']])
    runtimeAssetTypes.set('assets/world/saba/wells-bay/'+name,mime);
}
if(fs.existsSync(path.join(root,'assets/forest-scenery/saba/manifest.json'))){
  for(const file of [...Object.values(FOREST_SURFACE_ASSETS),...Object.values(FOREST_CONTINUUM_ASSETS),...Object.values(FOREST_CONTINUUM_MOBILE_ASSETS),...Object.values(FOREST_ASSETS)]){
    if(fs.existsSync(path.join(root,file)))runtimeAssetTypes.set(file,file.endsWith('.json')?'application/json':file.endsWith('.png')?'image/png':'application/octet-stream');
  }
}
if(fs.existsSync(path.join(root,'assets/forest-scenery/subtropical/manifest.json'))){
  for(const file of [...Object.values(SUBTROPICAL_FOREST_SURFACE_ASSETS),...Object.values(SUBTROPICAL_FOREST_CONTINUUM_ASSETS),...Object.values(SUBTROPICAL_FOREST_GROVE_ASSETS),...Object.values(SUBTROPICAL_FOREST_ASSETS)]){
    if(fs.existsSync(path.join(root,file)))runtimeAssetTypes.set(file,file.endsWith('.json')?'application/json':file.endsWith('.png')?'image/png':'application/octet-stream');
  }
}
if(fs.existsSync(path.join(root,'assets/forest-scenery/portugal/manifest.json'))){
  for(const file of [...Object.values(PORTUGAL_FOREST_SURFACE_ASSETS),...Object.values(PORTUGAL_FOREST_CONTINUUM_ASSETS),...Object.values(PORTUGAL_FOREST_CONTINUUM_MOBILE_ASSETS),...Object.values(PORTUGAL_FOREST_GROVE_ASSETS),...Object.values(PORTUGAL_FOREST_ASSETS)]){
    if(fs.existsSync(path.join(root,file)))runtimeAssetTypes.set(file,file.endsWith('.json')?'application/json':file.endsWith('.png')?'image/png':'application/octet-stream');
  }
}
// The meadow continuum's packs (scripts/prepare-meadow-grass.mjs & prepare-mobile-continuum.mjs): every coast's sward.
for(const assets of [PORTUGAL_MEADOW_GRASS_ASSETS,TROPICAL_MEADOW_GRASS_ASSETS,PORTUGAL_MEADOW_GRASS_MOBILE_ASSETS,TROPICAL_MEADOW_GRASS_MOBILE_ASSETS]){
  for(const file of Object.values(assets)){
    if(fs.existsSync(path.join(root,file)))runtimeAssetTypes.set(file,file.endsWith('.json')?'application/json':'application/octet-stream');
  }
}
// The city continuum's atlas (scripts/prepare-city-continuum.mjs), kept in git: the city is drawn from nothing else.
for(const file of Object.values(CITY_CONTINUUM_ASSETS))runtimeAssetTypes.set(file,file.endsWith('.json')?'application/json':'application/octet-stream');
// The prop continuum's atlas (scripts/prepare-prop-continuum.mjs), kept in git: port props and round shot are drawn
// from nothing else.
for(const file of Object.values(PROP_CONTINUUM_ASSETS))runtimeAssetTypes.set(file,file.endsWith('.json')?'application/json':'application/octet-stream');
// The boulder continuum's atlas (scripts/prepare-boulder-continuum.mjs), kept in git: ground-cover rocks are drawn
// from nothing else.
for(const file of Object.values(BOULDER_CONTINUUM_ASSETS))runtimeAssetTypes.set(file,file.endsWith('.json')?'application/json':'application/octet-stream');
// The animal continuum's atlas (scripts/prepare-animal-continuum.mjs) and Tripo H3.1 livestock basecolor textures.
for(const file of Object.values(ANIMAL_CONTINUUM_ASSETS))runtimeAssetTypes.set(file,file.endsWith('.json')?'application/json':'application/octet-stream');
for(const file of LIVESTOCK_TEXTURE_ASSETS)runtimeAssetTypes.set(file,'image/jpeg');
// The one simplifier (js/continuum-bake.js) bundled for the page's bake workers (js/continuum-bake-worker.js), written
// only when it changes.
{
  const bakeWorker=CONTINUUM_BAKE_ASSETS['bake-worker.js'],out=path.join(root,bakeWorker);
  const {text}=await bundleContinuumBakeWorker(root);
  if(!fs.existsSync(out)||!text.equals(fs.readFileSync(out))){fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,text);}
  runtimeAssetTypes.set(bakeWorker,'text/javascript');
}
// The people continuum's bodies (scripts/prepare-crew-continuum.mjs) and their strand hair & beards (scripts/prepare-hair-continuum.mjs).
const missingCrewContinuum=Object.values(CREW_CONTINUUM_ASSETS).flatMap(files=>Object.values(files)).filter(file=>!fs.existsSync(path.join(root,file)));
if(missingCrewContinuum.length)throw Error(crewContinuumMissingMessage(missingCrewContinuum));
for(const files of Object.values(CREW_CONTINUUM_ASSETS))for(const file of Object.values(files))
  runtimeAssetTypes.set(file,file.endsWith('.json')?'application/json':file.endsWith('.glb')?'model/gltf-binary':'application/octet-stream');
for(const files of Object.values(CREW_CONTINUUM_MOBILE_ASSETS))for(const file of Object.values(files))
  if(fs.existsSync(path.join(root,file)))runtimeAssetTypes.set(file,file.endsWith('.json')?'application/json':file.endsWith('.glb')?'model/gltf-binary':'application/octet-stream');
for(const file of Object.values(HAIR_CONTINUUM_ASSETS))
  runtimeAssetTypes.set(file,file.endsWith('.json')?'application/json':'application/octet-stream');
for(const file of Object.values(CLOTHING_CONTINUUM_ASSETS))
  runtimeAssetTypes.set(file,file.endsWith('.json')?'application/json':'application/octet-stream');
// The ships' continuum bodies (scripts/prepare-ship-continuum.mjs), committed and embedded: no ship is drawn without them.
for(const files of Object.values(SHIP_CONTINUUM_ASSETS))for(const file of Object.values(files)){
  runtimeAssetTypes.set(file,file.endsWith('.json')?'application/json':'application/octet-stream');
}
// Every Old World city is its board: each one baked, with the world it was founded as, is published (js/board-model.js).
for(const file of Object.values(BAKED_BOARDS))runtimeAssetTypes.set(file,'application/json');
for(const file of Object.values(BAKED_WORLDS))runtimeAssetTypes.set(file,'application/octet-stream');
if(fs.existsSync(path.join(root,'assets/boards/partner-ports-1550.json'))){
  runtimeAssetTypes.set('assets/boards/partner-ports-1550.json','application/json');
}
const runtimeAssetBytes = new Map(), pagesAssets = new Map();
// Keep core sailing and the forest maps embedded in downloads. The forest's continuum
// atlases alone exceed 100 MB after base64 encoding; downloads load those from the
// same versioned public asset instead.
const externalDownloadGeometry=new Set(['assets/boards/lisbon-1550.world','assets/boards/partner-ports-1550.json','assets/board/game.js','assets/board/runtime.js', ...[FOREST_CONTINUUM_ASSETS,SUBTROPICAL_FOREST_CONTINUUM_ASSETS,PORTUGAL_FOREST_CONTINUUM_ASSETS,FOREST_CONTINUUM_MOBILE_ASSETS,PORTUGAL_FOREST_CONTINUUM_MOBILE_ASSETS].flatMap(assets=>Object.values(assets)).filter(f=>f.endsWith('.gz')), ...[PORTUGAL_MEADOW_GRASS_ASSETS,TROPICAL_MEADOW_GRASS_ASSETS,PORTUGAL_MEADOW_GRASS_MOBILE_ASSETS,TROPICAL_MEADOW_GRASS_MOBILE_ASSETS].flatMap(assets=>Object.values(assets)).filter(f=>f.endsWith('.gz'))]);
// Both block-compressed sets are a saving for online play. Offline, the embedded maps serve instead.
for(const file of [...Object.values(FOREST_SURFACE_ASSETS),...Object.values(SUBTROPICAL_FOREST_SURFACE_ASSETS),...Object.values(PORTUGAL_FOREST_SURFACE_ASSETS)])if(file.endsWith('.gz'))externalDownloadGeometry.add(file);
// The people continuum's bodies (hundreds of MB) stay out of the downloads, which fetch the published copies.
for(const files of Object.values(CREW_CONTINUUM_ASSETS))for(const file of Object.values(files))externalDownloadGeometry.add(file);
for(const files of Object.values(CREW_CONTINUUM_MOBILE_ASSETS))for(const file of Object.values(files))externalDownloadGeometry.add(file);
// So do the founded worlds of the Old World cities.
for(const file of Object.values(BAKED_WORLDS))externalDownloadGeometry.add(file);
function runtimeAssetURL(file,mime,inlineAssets){
  if(!runtimeAssetBytes.has(file))runtimeAssetBytes.set(file,fs.readFileSync(path.join(root,file)));
  const bytes=runtimeAssetBytes.get(file);
  if(inlineAssets&&!externalDownloadGeometry.has(file))return 'data:'+mime+';base64,'+bytes.toString('base64');
  if(!pagesAssets.has(file)){
    const sha256=createHash('sha256').update(bytes).digest('hex'),ext=path.posix.extname(file);
    const url=file.slice(0,-ext.length)+'.'+sha256.slice(0,16)+ext;
    pagesAssets.set(file,{url,bytes:bytes.length,sha256});
  }
  return (inlineAssets?'https://sixcailloux.com/waterworld/':'')+pagesAssets.get(file).url;
}
const stripModuleSyntax = (src,inlineAssets=true) => {
  if(/^import\s*\{[^}]*\bas\b[^}]*\}\s*from/m.test(src)) throw new Error('Standalone modules require canonical import names; aliased imports cannot be flattened.');
  return src
  .replace(/(['"])(assets\/[a-z0-9./-]+)\1/g,(match,quote,file)=>{
    const mime=runtimeAssetTypes.get(file)||(/^assets\/audio\/[a-z0-9/-]+\.mp3$/.test(file)?'audio/mpeg':null);
    return mime?JSON.stringify(runtimeAssetURL(file,mime,inlineAssets)):match;
  })
  .replace(/^import[\s\S]*?from\s+['"][^'"]+['"];\s*$/gm, '')                 // drop imports
  .replace(/^export\s+(const|function\*?|async function\*?|let|class)\s/gm, '$1 ')
  .replace(/^export\s*\{[^}]*\}(?:\s*from\s*['"][^'"]+['"])?;\s*$/gm, '')
  ;
};

const license = fs.readFileSync(path.join(root, 'LICENSE'), 'utf8');
const notices = fs.readFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8');
const pkgVersion = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version || '1.0.0';
const gitRun = (gitArgs) => {
  try { return execFileSync('git', gitArgs, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
};
const gitCount = Number(gitRun(['rev-list', '--count', 'HEAD'])) || 0;
const gitCommit = gitRun(['rev-parse', '--short', 'HEAD']) || 'dev';
const gitBranch = gitRun(['rev-parse', '--abbrev-ref', 'HEAD']) || '';
const gitDirty = Boolean(gitRun(['status', '--porcelain', '--untracked-files=no', '--', 'js/', 'index.html', 'build.mjs', 'scripts/']));
const buildInfo = {
  version: `${pkgVersion.split('.').slice(0, 2).join('.')}.${gitCount}`,
  build: gitCount,
  commit: gitCommit,
  branch: gitBranch,
  dirty: gitDirty,
  builtAt: new Date().toISOString(),
};
const buildBootstrap = `<script>window.__WATERWORLD_BUILD__=${JSON.stringify(buildInfo)};</script>`;
const page = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace('</head>', () => '<!--\n' + license + '\n' + notices + '\n-->\n</head>');
const SCRIPT_TAG = '<script type="module" src="js/main.js"></script>';
const write = (name, html) => {
  fs.writeFileSync(path.join(root, name), html);
  console.log(`wrote ${name}`, (html.length / 1024).toFixed(0) + ' KB');
};

// A module left off the list passes every test that imports it, then stops the published page at start.
for (const f of order) for (const [, target] of fs.readFileSync(path.join(root, f), 'utf8').matchAll(/^\s*(?:import|export)\s[^;'"]*?from\s+['"](\.[^'"]+)['"]/gm)) {
  const wanted = path.posix.join(path.posix.dirname(f), target);
  if (!order.includes(wanted)) throw Error(`${f} imports ${wanted}, which build.mjs does not bundle`);
}

// ---- readable bundle --------------------------------------------------------------------
let code = '';
for (const f of order) code += `// ---- ${f} ----\n${stripModuleSyntax(fs.readFileSync(path.join(root, f), 'utf8'))}\n`;
write('ocean.html', page.replace(SCRIPT_TAG, () => `${buildBootstrap}\n<script type="module">\n${code}\n</script>`));

// ---- minified bundle --------------------------------------------------------------------
// WGSL has no string literals, so comments and whitespace can be removed safely. Spaces are
// kept around + - / so that e.g. "a - -b" or "x / *p" never fuse into other tokens.
const TIGHT_WGSL_RELS = new Set([
  'js/trade-vessels.js', 'js/meadow-grass.js', 'js/wgsl/meadow-continuum.js', 'js/wgsl/meadow-blades.js', 'js/wgsl/boulder-continuum.js',
  'js/wgsl/herds.js', 'js/wgsl/townsfolk.js', 'js/wgsl/gunnery.js',
  'js/wgsl/crew-solve.js', 'js/wgsl/inland-water.js', 'js/wgsl/shallow-water.js', 'js/wgsl/surf-spray.js', 'js/wgsl/hull-flood.js',
  'js/wgsl/land-craters.js', 'js/wgsl/part-assembly.js',
  'js/wgsl/clouds.js', 'js/wgsl/cloud-model.js', 'js/wgsl/sky.js', 'js/wgsl/weather.js',
  'js/wgsl/spindrift.js', 'js/wgsl/rowing-water.js', 'js/wgsl/neural-pbr.js',
  'js/wgsl/victory.js', 'js/wgsl/crew.js', 'js/wgsl/surface-waves.js',
  'js/wgsl/surface-coupling.js', 'js/wgsl/underwater.js', 'js/wgsl/gunnery-probe.js',
  'js/wgsl/hull-contact.js', 'js/wgsl/rig-surfaces.js', 'js/wgsl/vessel-pose.js',
  'js/wgsl/vessel-recoil.js', 'js/wgsl/deck.js', 'js/wgsl/wetness.js',
  'js/forest-surfaces.js', 'js/forest-trunks.js',
  'js/building-fracture.js', 'js/ship-fracture.js',
  'js/wgsl/terrain.js', 'js/wgsl/caravel.js', 'js/wgsl/prop-continuum.js',
  'js/wgsl/vessel.js', 'js/wgsl/neural-post.js', 'js/wgsl/ground-detail.js', 'js/wgsl/lateen.js',
]);
const SEMI_TIGHT_WGSL_RELS = new Set();
function minifyWGSL(src, mode = 0) {
  let out = src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/ ?([{}()[\],;:=<>*&|^!%@.]) ?/g, '$1');
  if (mode > 0) {
    out = out
      .replace(/\b(vec[234]|mat[234]x[234])<(f32|u32|i32)>/g, (_, t, s) => t + s[0])
      .replace(mode === 2 ? /\b(\d+\.\d*?)0+(?![0-9a-zA-Z_])/g : /\b(\d+\.\d*[1-9])0+(?![0-9a-zA-Z_])/g, '$1')
      .replace(mode === 2 ? /(?<![0-9a-zA-Z_.])0\.(\d+)/g : /(?<![0-9a-zA-Z_.])0\.([1-9]\d*)/g, '.$1');
    for (let pass = 0; pass < 2; pass++) {
      out = out.replace(/([A-Za-z0-9_.)\]]) ([+\-/]) ([A-Za-z0-9_.(\[])/g, '$1$2$3');
    }
  }
  return out.trim();
}

// Minify every WGSL template literal in the shader modules in place (shared snippets stay
// shared), handling nested ${...} expressions and nested template literals lexically.
function minifyWGSLInJS(src, isWgslMod, rel = '') {
  const n = src.length;
  let i = 0;
  function scanJS(stopAtBrace) {
    let out = '', depth = 0, canRegex = true;
    while (i < n) {
      const c = src[i];
      if (stopAtBrace && c === '}') {
        if (depth === 0) return out;
        depth--; out += c; i++; canRegex = false; continue;
      }
      if (c === '{') { depth++; out += c; i++; canRegex = true; continue; }
      if (c === '/' && src[i + 1] === '/') {
        const start = i; i += 2;
        while (i < n && src[i] !== '\n') i++;
        out += src.slice(start, i); continue;
      }
      if (c === '/' && src[i + 1] === '*') {
        const start = i; i += 2;
        while (i < n && !(src[i] === '*' && src[i + 1] === '/')) i++;
        i = Math.min(n, i + 2);
        out += src.slice(start, i); continue;
      }
      if (c === "'" || c === '"') {
        const start = i, q = c; i++;
        while (i < n && src[i] !== q) { if (src[i] === '\\') i += 2; else i++; }
        if (i < n) i++;
        out += src.slice(start, i); canRegex = false; continue;
      }
      if (c === '/' && canRegex && src[i + 1] !== '/' && src[i + 1] !== '*') {
        const start = i; i++; let inClass = false;
        while (i < n) {
          const rc = src[i];
          if (rc === '\\') { i += 2; continue; }
          if (rc === '[') { inClass = true; i++; continue; }
          if (rc === ']') { inClass = false; i++; continue; }
          if (rc === '/' && !inClass) { i++; break; }
          if (rc === '\n') break;
          i++;
        }
        while (i < n && /[a-z]/i.test(src[i])) i++;
        out += src.slice(start, i); canRegex = false; continue;
      }
      if (c === '`') { out += scanTemplate(); canRegex = false; continue; }
      if (/\s/.test(c)) { out += c; i++; continue; }
      if (/[A-Za-z0-9_$]/.test(c)) {
        const start = i; i++;
        while (i < n && /[A-Za-z0-9_$]/.test(src[i])) i++;
        const word = src.slice(start, i);
        out += word;
        canRegex = /^(?:return|case|throw|typeof|void|delete|in|of|instanceof|new|yield|await|else|do)$/.test(word);
        continue;
      }
      if ((c === '+' || c === '-') && src[i + 1] === c) {
        out += c + c; i += 2; canRegex = false; continue;
      }
      out += c; i++;
      canRegex = /[=(:,;!&|?+\-~^%*<>[\]]/.test(c);
    }
    return out;
  }
  function scanTemplate() {
    i++; // skip opening `
    const rawChunks = [], exprs = [];
    let cur = '';
    while (i < n) {
      if (src[i] === '\\') { cur += src.slice(i, i + 2); i += 2; continue; }
      if (src[i] === '`') { i++; break; }
      if (src[i] === '$' && src[i + 1] === '{') {
        rawChunks.push(cur); cur = ''; i += 2;
        const expr = scanJS(true);
        if (i < n && src[i] === '}') i++;
        exprs.push('${' + expr + '}');
        continue;
      }
      cur += src[i++];
    }
    rawChunks.push(cur);
    const joinedRaw = rawChunks.join('__P__');
    const shouldMinify = !(rel === 'js/forest-scenery.js' && joinedRaw.includes('forestResidency')) && (isWgslMod
      ? !/<\/?[a-z][\s/>]/i.test(joinedRaw)
      : ((/@(?:compute|vertex|fragment|group|workgroup_size|location|builtin|binding)\b|\bfn\s+[A-Za-z_]\w*\s*\(|\b(?:struct\s+\w+\s*\{|var<(?:storage|uniform|workgroup|private)>|vec[234][fiu]\s*\(|mat[234]x[234]f)/.test(joinedRaw)) && !/<\/?[a-z][\s/>]/i.test(joinedRaw)));
    if (!shouldMinify) {
      const compactHtml = /<\/?[a-z][\s/>]/i.test(joinedRaw) && !/<pre\b/i.test(joinedRaw);
      const compactCss = !compactHtml && /\n\s*(?:body|\.|#)[\w.-]+[\s,{]/.test(joinedRaw);
      const fmt = (s) => compactHtml ? s.replace(/\n\s+/g, ' ').replace(/>\s+</g, '><') : (compactCss ? s.replace(/\n\s+/g, ' ') : s);
      let orig = fmt(rawChunks[0]);
      for (let k = 0; k < exprs.length; k++) orig += exprs[k] + fmt(rawChunks[k + 1]);
      return '`' + orig + '`';
    }
    let masked = rawChunks[0];
    for (let k = 0; k < exprs.length; k++) masked += `__P${k}__` + rawChunks[k + 1];
    const leadSpace = /^\s/.test(masked) && !/@(?:compute|vertex|fragment)\b/.test(joinedRaw);
    const trailSpace = /\s$/.test(masked) && !/@(?:compute|vertex|fragment)\b/.test(joinedRaw);
    let min = minifyWGSL(masked, TIGHT_WGSL_RELS.has(rel) ? 2 : (SEMI_TIGHT_WGSL_RELS.has(rel) ? 1 : 0));
    if (min && leadSpace) min = ' ' + min;
    if (min && trailSpace) min = min + ' ';
    min = min.replace(/__P(\d+)__/g, (_, k) => exprs[Number(k)]);
    return '`' + min + '`';
  }
  return scanJS(false);
}
function collectMinJS(inlineAssets){
  let result='';
  for(const f of order){
    const src=fs.readFileSync(path.join(root,f),'utf8');
    result+=stripModuleSyntax(minifyWGSLInJS(src,wgslModules.includes(f),f),inlineAssets)+'\n';
  }
  return result;
}
let minJs=collectMinJS(true),pagesJs=collectMinJS(false);

function findEsbuild() {
  const req = createRequire(import.meta.url);
  try { return req('esbuild'); } catch { /* not installed in the project */ }
  // fall back to an esbuild left in the npx cache by other tools
  const cache = path.join(os.homedir(), 'AppData', 'Local', 'npm-cache', '_npx');
  for (const dir of fs.existsSync(cache) ? fs.readdirSync(cache) : []) {
    const pkg = path.join(cache, dir, 'node_modules', 'esbuild');
    if (fs.existsSync(pkg)) { try { return req(pkg); } catch { /* try next */ } }
  }
  return null;
}

const esbuild = findEsbuild();
if (esbuild) {
  // Verify every bundled module before js/main.js initializes without top-level TDZ ReferenceErrors.
  const mainMarker = '// ---- js/main.js ----';
  const beforeMain = code.includes(mainMarker) ? code.slice(0, code.indexOf(mainMarker)) : code;
  const stubEl = () => ({ getContext: () => null, style: {}, addEventListener() {}, appendChild() {}, remove() {}, setAttribute() {}, querySelector: () => null, querySelectorAll: () => [] });
  const vmBase = {
    console, Math, Object, Array, Float32Array, Float64Array, Int32Array, Uint32Array, Uint16Array, Uint8Array, Int16Array, Int8Array,
    DataView, ArrayBuffer, Map, Set, WeakMap, WeakSet, Promise, Symbol, Number, String, Boolean, RegExp, Error, TypeError, RangeError, JSON,
    Date, BigInt, Infinity, NaN, isFinite, isNaN, parseFloat, parseInt, encodeURIComponent, decodeURIComponent, atob, btoa, URL, URLSearchParams,
    TextEncoder, TextDecoder, performance, structuredClone, setTimeout, clearTimeout, requestAnimationFrame: () => 0, cancelAnimationFrame: () => {},
    navigator: {}, location: { search: '', href: 'http://localhost/' }, addEventListener() {}, removeEventListener() {},
    matchMedia: () => ({ matches: false, addEventListener() {} }),
    document: { getElementById: () => null, querySelector: () => null, querySelectorAll: () => [], createElement: stubEl, addEventListener() {}, body: { appendChild() {} }, documentElement: { style: {} } },
    localStorage: { getItem: () => null, setItem() {}, removeItem() {} },
    AudioContext: class {}, Worker: class {}, GPUBufferUsage: {}, GPUTextureUsage: {}, GPUShaderStage: {}, GPUMapMode: {},
  };
  vmBase.window = vmBase; vmBase.self = vmBase; vmBase.globalThis = vmBase;
  const initCheckJs = esbuild.transformSync(beforeMain, { format: 'iife', target: 'es2022' }).code;
  vm.runInContext(initCheckJs, vm.createContext(vmBase));

  if (typeof esbuild.build === 'function') {
    const bundleWithAssets = async (inlineAssets) => {
      const res = await esbuild.build({
        entryPoints: [path.join(root, 'js/main.js')],
        bundle: true,
        minify: true,
        treeShaking: true,
        format: 'esm',
        target: 'es2022',
        charset: 'utf8',
        legalComments: 'none',
        logLevel: 'silent',
        write: false,
        plugins: [{
          name: 'waterworld-assets',
          setup(b) {
            b.onLoad({ filter: /\.js$/ }, ({ path: p }) => {
              const rel = path.relative(root, p).split(path.sep).join('/');
              const raw = fs.readFileSync(p, 'utf8');
              const contents = minifyWGSLInJS(raw, wgslModules.includes(rel), rel)
                .replace(/(['"])(assets\/[a-z0-9./-]+)\1/g, (match, _, file) => {
                  const mime = runtimeAssetTypes.get(file) || (/^assets\/audio\/[a-z0-9/-]+\.mp3$/.test(file) ? 'audio/mpeg' : null);
                  return mime ? JSON.stringify(runtimeAssetURL(file, mime, inlineAssets)) : match;
                });
              return { contents, loader: 'js' };
            });
          },
        }],
      });
      return new TextDecoder().decode(res.outputFiles[0].contents);
    };
    minJs = await bundleWithAssets(true);
    pagesJs = await bundleWithAssets(false);
  } else {
    minJs = esbuild.transformSync(minJs, { minify: true, format: 'esm', target: 'es2022', legalComments: 'none' }).code;
    pagesJs = esbuild.transformSync(pagesJs, { minify: true, format: 'esm', target: 'es2022', legalComments: 'none' }).code;
  }
} else {
  console.log('esbuild not found: JS gets comment/indentation stripping only');
  minJs = minJs.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('//')).join('\n');
  pagesJs = pagesJs.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('//')).join('\n');
}

const minifyPage = js => page
  .replace(/<script>([\s\S]*?)<\/script>/, (_, b) => `<script>${esbuild ? esbuild.transformSync(b, { loader: 'js', minify: true, legalComments: 'none' }).code.trim() : b.trim()}</script>`)
  .replace(/<style>([\s\S]*?)<\/style>/, (_, css) => `<style>${esbuild ? esbuild.transformSync(css, { loader: 'css', minify: true, legalComments: 'none' }).code.trim() : css.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\s+/g, ' ').replace(/ ?([{}:;,>]) ?/g, '$1').trim()}</style>`)
  .replace(/<[a-z][^>]*>/gi, tag => tag.replace(/\s+/g, ' '))
  .replace(/>\s+</g, '><')
  .replace(SCRIPT_TAG, () => `${buildBootstrap}<script type="module">${js}</script>`);
write('ocean.min.html', minifyPage(minJs));

// Pages serves cached assets; the two ocean downloads remain self-contained. The published page opens on deck, so
// it writes boat=1 into a bare address; whether the address was bare is kept first, for the game to ask a returning
// captain about a saved voyage (js/main.js) instead of taking the visit for a scene of its own.
const assetIndex = Object.fromEntries([...pagesAssets.values()].map((r) => [r.sha256.slice(0, 16), r.bytes]));
const pagesBootstrap = `<script>window.__WATERWORLD_ASSET_INDEX__=${JSON.stringify(assetIndex)};const siteURL=new URL(location.href);window.oceanOpenedBare=!siteURL.search;if(!siteURL.searchParams.has("boat")){siteURL.searchParams.set("boat","1");history.replaceState(null,"",siteURL);}</script>`;
fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
for(const [file,record]of pagesAssets){
  const destination=path.join(root,'docs',record.url);
  fs.mkdirSync(path.dirname(destination),{recursive:true});
  fs.writeFileSync(destination,runtimeAssetBytes.get(file));
}
fs.writeFileSync(path.join(root,'docs','assets-manifest.json'),JSON.stringify(Object.fromEntries(pagesAssets),null,2)+'\n');
fs.writeFileSync(path.join(root,'docs','build-info.json'),JSON.stringify(buildInfo,null,2)+'\n');
// Only sailing essentials preload. Marine encounters load their whale asset
// on demand, keeping optional downloads off the first-frame critical path.
const startupPreloads=['assets/caravel-oak-albedo.webp']
  .map(file=>`<link rel="preload" as="fetch" href="${pagesAssets.get(file).url}" crossorigin="anonymous">`).join('');
write('docs/index.html', minifyPage(pagesJs).replace('</head>','<meta name="robots" content="noindex, nofollow, noarchive">'+startupPreloads+'</head>')
  .replace('<script type="module">', pagesBootstrap + '<script type="module">'));
console.log(`stamped build #${buildInfo.build} (v${buildInfo.version} ${buildInfo.commit}${buildInfo.dirty ? '*' : ''})`);
fs.writeFileSync(path.join(root, 'docs', '.nojekyll'), '');

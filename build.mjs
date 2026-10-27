// Bundles index.html + js modules into self-contained pages that can be opened directly
// from disk (file://) without a server:
//   ocean.html      readable bundle
//   ocean.min.html  minified bundle (WGSL comments/whitespace stripped; JS minified with
//                   esbuild when it can be found, otherwise comments/indentation stripped)
//   node build.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { FOREST_ASSETS, SUBTROPICAL_FOREST_ASSETS } from './js/forest-scenery.js';
import { FOREST_IMPOSTOR_ASSETS } from './js/forest-impostor.js';
import { FOREST_LIGHT_ASSETS } from './js/forest-light.js';
import { FOREST_NATIVE_LOD_ASSETS } from './js/forest-native-lod.js';
import { FOREST_VOLUME_ASSETS, SUBTROPICAL_FOREST_VOLUME_ASSETS } from './js/forest-volume.js';
import { FOREST_MIDDLE_ASSETS, SUBTROPICAL_FOREST_MIDDLE_ASSETS } from './js/forest-middle.js';
import { FOREST_MASS_ASSETS } from './js/forest-mass.js';

const root = path.dirname(fileURLToPath(import.meta.url));
const wgslModules = ['js/wgsl/common.js', 'js/wgsl/celestial.js', 'js/wgsl/hull.js', 'js/wgsl/lateen.js', 'js/wgsl/victory.js', 'js/wgsl/vessel.js', 'js/wgsl/vessel-pose.js', 'js/wgsl/shadows.js', 'js/wgsl/interaction.js', 'js/wgsl/surface-waves.js', 'js/wgsl/surface-coupling.js', 'js/wgsl/fleet-wakes.js', 'js/wgsl/cloud-model.js', 'js/wgsl/clouds.js', 'js/wgsl/sky.js', 'js/wgsl/deck.js', 'js/wgsl/spindrift.js', 'js/wgsl/wetness.js', 'js/wgsl/sim.js', 'js/wgsl/water-optics.js', 'js/wgsl/underwater.js', 'js/wgsl/ocean.js', 'js/wgsl/ocean-lighting.js', 'js/wgsl/post.js', 'js/wgsl/caravel.js', 'js/wgsl/crew.js', 'js/wgsl/terrain.js', 'js/wgsl/weather.js', 'js/wgsl/anchor.js', 'js/wgsl/dolphins.js', 'js/wgsl/marine-life.js', 'js/wgsl/gunnery.js', 'js/wgsl/gunnery-probe.js', 'js/wgsl/hull-contact.js', 'js/wgsl/rowing-water.js'];
const order = ['js/vendor/astronomy-engine.js', 'js/star-catalog.js', 'js/astronomy.js', 'js/rig-definition.js', 'js/hull-loft.js', 'js/models/additional.js', 'js/models/rowing.js', 'js/models/later-sail.js', 'js/models/procedural.js', 'js/models/nina.js', 'js/models/victory.js', 'js/hull.js', 'js/rig-plan.js', 'js/rigging.js', 'js/lateen.js', 'js/additional-rig.js', 'js/rig-surface.js', 'js/rowing.js', 'js/procedural-models.js', 'js/ship-models.js', 'js/victory-motion.js', 'js/sail-aerodynamics.js', 'js/sailing.js', 'js/dolphin-state.js', 'js/marine-life-state.js', 'js/hull-lateral.js', 'js/boat.js', 'js/gunnery-state.js', 'js/gunnery-models.js', ...wgslModules, 'js/celestial.js', 'js/fleet.js', 'js/surface-waves.js', 'js/surface-bindings.js', 'js/rowing-water.js', 'js/rowing-surface-events.js', 'js/gunnery-effects.js', 'js/gunnery-sea-probe.js', 'js/gunport-safety.js', 'js/hull-contact.js', 'js/vessels.js', 'js/follower.js', 'js/anchor-state.js', 'js/ship-parts.js', 'js/water-optics.js', 'js/underwater.js', 'js/anchor.js', 'js/dolphin-mesh.js', 'js/dolphins.js', 'js/dolphin-ui.js', 'js/gltf.js', 'js/marine-asset.js', 'js/marine-rig.js', 'js/marine-life.js', 'js/marine-loader.js', 'js/marine-ui.js', 'js/caravel.js', 'js/mesh-writer.js', 'js/victory.js', 'js/additional-ships.js', 'js/rowing-ships.js', 'js/later-sail-ships.js', 'js/ship-mesh.js', 'js/crew-work.js', 'js/gunnery-tools.js', 'js/crew-pose.js', 'js/crew.js', 'js/wetness.js', 'js/sharing.js', 'js/camera.js', 'js/vessel-pose.js', 'js/shadows.js', 'js/deck.js', 'js/interaction.js', 'js/spindrift.js', 'js/clouds.js', 'js/terrain-model.js', 'js/vegetation.js', 'js/terrain.js', 'js/landfall.js', 'js/profiler.js', 'js/resolution.js', 'js/instruments.js', 'js/controls.js', 'js/weather-state.js', 'js/audio-assets.js', 'js/voice-assets.js', 'js/voice-lines.js', 'js/gunnery-audio-assets.js', 'js/gunnery-audio.js', 'js/gunnery-control.js', 'js/gunnery-ui.js', 'js/audio.js', 'js/weather.js', 'js/main.js'];
// Baked stand loading is deferred to landfall; preserve existing module order.
order.splice(order.indexOf('js/vegetation.js')+1,0,'js/coastal-world.js');
order.splice(order.indexOf('js/terrain.js'),0,'js/canopy-scenery.js');
order.splice(order.indexOf('js/crew-work.js'),0,'js/crew-navigation.js','js/crew-motion.js');
order.splice(order.indexOf('js/terrain.js'),0,'js/terrain-near.js');
order.splice(order.indexOf('js/terrain.js'),0,'js/forest-scenery.js');
order.splice(order.indexOf('js/terrain.js'),0,'js/vendor/forest-meshopt.js','js/forest-mass.js');
order.splice(order.indexOf('js/forest-scenery.js'),0,'js/forest-impostor.js');
order.splice(order.indexOf('js/forest-scenery.js'),0,'js/forest-light.js');
order.splice(order.indexOf('js/forest-scenery.js'),0,'js/forest-native-lod.js');
order.splice(order.indexOf('js/forest-scenery.js'),0,'js/forest-volume.js');
order.splice(order.indexOf('js/forest-scenery.js'),0,'js/forest-middle.js');
order.splice(order.indexOf('js/forest-scenery.js'),0,'js/task-yield.js','js/forest-occlusion.js');
order.splice(order.indexOf('js/profiler.js')+1,0,'js/gpu-benchmark.js');
order.splice(order.indexOf('js/main.js'),0,'js/wgsl-prune.js','js/gpu-program-cache.js');
order.splice(order.indexOf('js/wgsl/vessel-pose.js'),0,'js/wgsl/rig-surfaces.js');
order.splice(order.indexOf('js/wgsl/vessel-pose.js'),0,'js/wgsl/vessel-recoil.js');
order.splice(order.indexOf('js/ship-mesh.js'),0,'js/rig-gpu-data.js');
order.splice(order.indexOf('js/vessel-pose.js'),0,'js/vessel-recoil.js');
// Downloads keep embedded assets. Pages uses identical bytes in independently
// cacheable, content-addressed files; optional audio/terrain need not travel in
// the initial HTML. Only these explicit runtime files and manifest MP3s qualify.
const runtimeAssetTypes = new Map([
  ['assets/caravel-oak-albedo.webp','image/webp'],
  ['assets/wildlife/whale.glb','model/gltf-binary'],
  ['assets/crew/sailor.glb','model/gltf-binary'],
  ['assets/crew/sailor-female.glb','model/gltf-binary'],
  ['assets/tree-foliage.png','image/png'],
  ['assets/world/saba/albedo.png','image/png'],
  ['assets/world/saba/canopy.png','image/png'],
  ['assets/world/saba/biome.bin','application/octet-stream'],
  ['assets/world/saba/height.bin','application/octet-stream'],
  ['assets/world/saba/manifest.json','application/json'],
  ['assets/world/land.json','application/json'],
  ['assets/canopy-scenery/saba/manifest.json','application/json'],
  ['assets/canopy-scenery/saba/near.bin','application/octet-stream'],
  ['assets/canopy-scenery/saba/leaf.bin','application/octet-stream'],
  ['assets/canopy-scenery/saba/far.bin','application/octet-stream'],
  ['assets/canopy-scenery/saba/instances.bin','application/octet-stream'],
  ['assets/ports/1550/buildings-1550-lrm.bin','application/octet-stream'],
  ['assets/ports/1550/buildings-1550-photo-atlas.jpg','image/jpeg'],
]);
// The optional exporter declares this pack only after real source baking. Never
// manufacture a near tile to satisfy a build or fetch absent optional assets.
if(fs.existsSync(path.join(root,'assets/world/saba/wells-bay/manifest.json'))){
  for(const [name,mime]of [['manifest.json','application/json'],['height.bin','application/octet-stream'],['measured.bin','application/octet-stream'],['albedo.png','image/png']])
    runtimeAssetTypes.set('assets/world/saba/wells-bay/'+name,mime);
}
if(fs.existsSync(path.join(root,'assets/forest-scenery/saba/manifest.json'))){
  for(const file of [...Object.values(FOREST_ASSETS),...Object.values(FOREST_IMPOSTOR_ASSETS),...Object.values(FOREST_LIGHT_ASSETS),...Object.values(FOREST_NATIVE_LOD_ASSETS),...Object.values(FOREST_VOLUME_ASSETS),...Object.values(FOREST_MIDDLE_ASSETS)]){
    if(fs.existsSync(path.join(root,file)))runtimeAssetTypes.set(file,file.endsWith('.json')?'application/json':file.endsWith('.png')?'image/png':'application/octet-stream');
  }
}
if(fs.existsSync(path.join(root,'assets/forest-scenery/saba/mass/manifest.json'))){
  for(const file of Object.values(FOREST_MASS_ASSETS))
    runtimeAssetTypes.set(file,file.endsWith('.json')?'application/json':'application/octet-stream');
}
if(fs.existsSync(path.join(root,'assets/forest-scenery/subtropical/manifest.json'))){
  for(const file of [...Object.values(SUBTROPICAL_FOREST_ASSETS),...Object.values(SUBTROPICAL_FOREST_VOLUME_ASSETS),...Object.values(SUBTROPICAL_FOREST_MIDDLE_ASSETS)]){
    if(fs.existsSync(path.join(root,file)))runtimeAssetTypes.set(file,file.endsWith('.json')?'application/json':file.endsWith('.png')?'image/png':'application/octet-stream');
  }
}
const runtimeAssetBytes = new Map(), pagesAssets = new Map();
// Keep core sailing and the native forest atlases embedded in downloads. The
// lossless mature close-up buffers alone exceed 100 MB after base64 encoding;
// load those optional buffers from the same versioned public asset instead.
const externalDownloadGeometry=new Set(['assets/forest-scenery/saba/vertices.bin.gz','assets/forest-scenery/saba/indices.bin.gz','assets/forest-scenery/saba/mass/vertices.bin.gz','assets/forest-scenery/saba/mass/indices.bin.gz','assets/forest-scenery/subtropical/vertices.bin.gz','assets/forest-scenery/subtropical/indices.bin.gz']);
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
  .replace(/^export\s+(const|function|async function|let|class)\s/gm, '$1 ')
  .replace(/^export\s*\{[^}]*\}\s*from\s*['"][^'"]+['"];\s*$/gm, '')
  ;
};

const license = fs.readFileSync(path.join(root, 'LICENSE'), 'utf8');
const notices = fs.readFileSync(path.join(root, 'THIRD_PARTY_NOTICES.md'), 'utf8');
const page = fs.readFileSync(path.join(root, 'index.html'), 'utf8').replace('</head>', () => '<!--\n' + license + '\n' + notices + '\n-->\n</head>');
const SCRIPT_TAG = '<script type="module" src="js/main.js"></script>';
const write = (name, html) => {
  fs.writeFileSync(path.join(root, name), html);
  console.log(`wrote ${name}`, (html.length / 1024).toFixed(0) + ' KB');
};

// ---- readable bundle --------------------------------------------------------------------
let code = '';
for (const f of order) code += `// ---- ${f} ----\n${stripModuleSyntax(fs.readFileSync(path.join(root, f), 'utf8'))}\n`;
write('ocean.html', page.replace(SCRIPT_TAG, () => `<script type="module">\n${code}\n</script>`));

// ---- minified bundle --------------------------------------------------------------------
// WGSL has no string literals, so comments and whitespace can be removed safely. Spaces are
// kept around + - / so that e.g. "a - -b" or "x / *p" never fuse into other tokens.
function minifyWGSL(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .replace(/\/\/[^\n]*/g, ' ')
    .replace(/\s+/g, ' ')
    .replace(/ ?([{}()[\],;:=<>*&|^!%@.]) ?/g, '$1')
    .trim();
}

// Minify every WGSL template literal in the shader modules in place (shared snippets stay
// shared). ${...} interpolations are swapped for identifier-like placeholders first so the
// minifier never fuses tokens across them.
function minifyTemplates(src) {
  return src.replace(/`([^`]*)`/g, (_, body) => {
    const parts = [];
    const masked = body.replace(/\$\{[^}]*\}/g, (m) => `__P${parts.push(m) - 1}__`);
    const out = minifyWGSL(masked).replace(/__P(\d+)__/g, (_, i) => parts[Number(i)]);
    return '`' + out + '`';
  });
}
function collectMinJS(inlineAssets){
  let result='';
  for(const f of order){
    const src=fs.readFileSync(path.join(root,f),'utf8');
    result+=stripModuleSyntax(wgslModules.includes(f)?minifyTemplates(src):src,inlineAssets)+'\n';
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
  minJs = esbuild.transformSync(minJs, { minify: true, format: 'esm', target: 'es2022', legalComments: 'none' }).code;
  pagesJs = esbuild.transformSync(pagesJs, { minify: true, format: 'esm', target: 'es2022', legalComments: 'none' }).code;
} else {
  console.log('esbuild not found: JS gets comment/indentation stripping only');
  minJs = minJs.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('//')).join('\n');
  pagesJs = pagesJs.split('\n').map((l) => l.trim()).filter((l) => l && !l.startsWith('//')).join('\n');
}

const minifyPage = js => page
  .replace(SCRIPT_TAG, () => `<script type="module">${js}</script>`)
  .replace(/<style>([\s\S]*?)<\/style>/, (_, css) => `<style>${css.replace(/\s+/g, ' ').replace(/ ?([{}:;,>]) ?/g, '$1').trim()}</style>`)
  .replace(/>\s+</g, '><');
write('ocean.min.html', minifyPage(minJs));

// Pages serves cached assets; the two ocean downloads remain self-contained.
const pagesBootstrap = '<script>const siteURL=new URL(location.href);if(!siteURL.searchParams.has("boat")){siteURL.searchParams.set("boat","1");history.replaceState(null,"",siteURL);}</script>';
fs.mkdirSync(path.join(root, 'docs'), { recursive: true });
for(const [file,record]of pagesAssets){
  const destination=path.join(root,'docs',record.url);
  fs.mkdirSync(path.dirname(destination),{recursive:true});
  fs.writeFileSync(destination,runtimeAssetBytes.get(file));
}
fs.writeFileSync(path.join(root,'docs','assets-manifest.json'),JSON.stringify(Object.fromEntries(pagesAssets),null,2)+'\n');
// Only sailing essentials preload. Marine encounters load their whale asset
// on demand, keeping optional downloads off the first-frame critical path.
const startupPreloads=['assets/caravel-oak-albedo.webp','assets/crew/sailor.glb',
  'assets/crew/sailor-female.glb']
  .map(file=>`<link rel="preload" as="fetch" href="${pagesAssets.get(file).url}" crossorigin="anonymous">`).join('');
write('docs/index.html', minifyPage(pagesJs).replace('</head>','<meta name="robots" content="noindex, nofollow, noarchive">'+startupPreloads+'</head>')
  .replace('<script type="module">', pagesBootstrap + '<script type="module">'));
fs.writeFileSync(path.join(root, 'docs', '.nojekyll'), '');

// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Grown temperate specimens are authored visual proxies, not surveyed Saba flora.
// A pack's trees are drawn through the one continuum alone (AGENTS.md rule 3): each prototype a type of the pack's
// atlas (js/forest-continuum.js), each root stood every frame as a record of the one format by the forest's stand pass
// and worn by its material (js/wgsl/forest-continuum.js), cut and cast by the one cut (js/continuum-scene.js). This
// module holds the roots, strikes and fells them, and keeps the wood a ball meets (js/forest-trunks.js).
import {continuumGroundView} from './continuum-ground.js';
import {createTaskYieldBudget} from './task-yield.js';
import {CONTINUUM_RECORD_WORDS,continuumRoom} from './continuum-format.js';
import {CONTINUUM_ROW} from './wgsl/continuum-cut.js';
import {CONTINUUM_WIND_POSE} from './wgsl/continuum-wind.js';
import {createContinuumScene,requestContinuumAtlas,requestContinuumPrograms,requestContinuumView} from './continuum-scene.js';
import {loadForestContinuum,forestContinuumAssetsFor} from './forest-continuum.js';
import {FOREST_CONTINUUM_BLASTS,FOREST_CONTINUUM_STAND_BYTES,FOREST_CONTINUUM_STOOD_BYTES,forestContinuumMaterial,forestContinuumStandWGSL} from './wgsl/forest-continuum.js';
import {FOREST_FALL_BEARINGS,FOREST_FALL_SECONDS,FOREST_LONG_FALLEN,TREE_STRIKE_REACH_M,blastForestRoot,buildForestTrunkGridAsync,forestStrikesFromSave,forestStrikesToSave,forestTrunkShape,nearestForestRoot,reapplyForestStrikes,strikeForestTree} from './forest-trunks.js';
import {FOREST_SURFACE_ASSETS,SUBTROPICAL_FOREST_SURFACE_ASSETS,PORTUGAL_FOREST_SURFACE_ASSETS,chooseForestSurfaceCodec,createForestSurfaceTextures,forestMaterialOptics,loadForestSurfaceSet} from './forest-surfaces.js';

// What the game fetches of a pack: its manifest, its roots, and the maps a device without block compression
// builds its surfaces from. The pack's own vertex and index streams are the bake source of its continuum atlas
// (scripts/prepare-forest-continuum.mjs) and stay on disk.
export const FOREST_ASSETS=Object.freeze({
  'manifest.json':'assets/forest-scenery/saba/manifest.json',
  'roots.bin':'assets/forest-scenery/saba/roots.bin.gz',
  'leaf-oak-0-albedo.png':'assets/forest-scenery/saba/leaf-oak-0-albedo.png',
  'leaf-oak-0-normal.png':'assets/forest-scenery/saba/leaf-oak-0-normal.png',
  'leaf-oak-1-albedo.png':'assets/forest-scenery/saba/leaf-oak-1-albedo.png',
  'leaf-oak-1-normal.png':'assets/forest-scenery/saba/leaf-oak-1-normal.png',
  'leaf-oak-2-albedo.png':'assets/forest-scenery/saba/leaf-oak-2-albedo.png',
  'leaf-oak-2-normal.png':'assets/forest-scenery/saba/leaf-oak-2-normal.png',
  'leaf-maple-0-albedo.png':'assets/forest-scenery/saba/leaf-maple-0-albedo.png',
  'leaf-maple-0-normal.png':'assets/forest-scenery/saba/leaf-maple-0-normal.png',
  'leaf-maple-1-albedo.png':'assets/forest-scenery/saba/leaf-maple-1-albedo.png',
  'leaf-maple-1-normal.png':'assets/forest-scenery/saba/leaf-maple-1-normal.png',
  'leaf-maple-2-albedo.png':'assets/forest-scenery/saba/leaf-maple-2-albedo.png',
  'leaf-maple-2-normal.png':'assets/forest-scenery/saba/leaf-maple-2-normal.png',
  'leaf-birch-0-albedo.png':'assets/forest-scenery/saba/leaf-birch-0-albedo.png',
  'leaf-birch-0-normal.png':'assets/forest-scenery/saba/leaf-birch-0-normal.png',
  'leaf-birch-1-albedo.png':'assets/forest-scenery/saba/leaf-birch-1-albedo.png',
  'leaf-birch-1-normal.png':'assets/forest-scenery/saba/leaf-birch-1-normal.png',
  'leaf-birch-2-albedo.png':'assets/forest-scenery/saba/leaf-birch-2-albedo.png',
  'leaf-birch-2-normal.png':'assets/forest-scenery/saba/leaf-birch-2-normal.png',
  'leaf-elm-0-albedo.png':'assets/forest-scenery/saba/leaf-elm-0-albedo.png',
  'leaf-elm-0-normal.png':'assets/forest-scenery/saba/leaf-elm-0-normal.png',
  'leaf-elm-1-albedo.png':'assets/forest-scenery/saba/leaf-elm-1-albedo.png',
  'leaf-elm-1-normal.png':'assets/forest-scenery/saba/leaf-elm-1-normal.png',
  'leaf-elm-2-albedo.png':'assets/forest-scenery/saba/leaf-elm-2-albedo.png',
  'leaf-elm-2-normal.png':'assets/forest-scenery/saba/leaf-elm-2-normal.png',
  'leaf-chestnut-0-albedo.png':'assets/forest-scenery/saba/leaf-chestnut-0-albedo.png',
  'leaf-chestnut-0-normal.png':'assets/forest-scenery/saba/leaf-chestnut-0-normal.png',
  'leaf-chestnut-1-albedo.png':'assets/forest-scenery/saba/leaf-chestnut-1-albedo.png',
  'leaf-chestnut-1-normal.png':'assets/forest-scenery/saba/leaf-chestnut-1-normal.png',
  'leaf-chestnut-2-albedo.png':'assets/forest-scenery/saba/leaf-chestnut-2-albedo.png',
  'leaf-chestnut-2-normal.png':'assets/forest-scenery/saba/leaf-chestnut-2-normal.png',
  'oak-bark-albedo.png':'assets/forest-scenery/saba/oak-bark-albedo.png',
  'oak-bark-normal.png':'assets/forest-scenery/saba/oak-bark-normal.png',
  'oak-bark-roughness.png':'assets/forest-scenery/saba/oak-bark-roughness.png',
  'oak-wounds-albedo.png':'assets/forest-scenery/saba/oak-wounds-albedo.png',
  'oak-wounds-normal.png':'assets/forest-scenery/saba/oak-wounds-normal.png',
  'oak-wounds-roughness.png':'assets/forest-scenery/saba/oak-wounds-roughness.png',
  'maple-bark-albedo.png':'assets/forest-scenery/saba/maple-bark-albedo.png',
  'maple-bark-normal.png':'assets/forest-scenery/saba/maple-bark-normal.png',
  'maple-bark-roughness.png':'assets/forest-scenery/saba/maple-bark-roughness.png',
  'maple-wounds-albedo.png':'assets/forest-scenery/saba/maple-wounds-albedo.png',
  'maple-wounds-normal.png':'assets/forest-scenery/saba/maple-wounds-normal.png',
  'maple-wounds-roughness.png':'assets/forest-scenery/saba/maple-wounds-roughness.png',
  'birch-bark-albedo.png':'assets/forest-scenery/saba/birch-bark-albedo.png',
  'birch-bark-normal.png':'assets/forest-scenery/saba/birch-bark-normal.png',
  'birch-bark-roughness.png':'assets/forest-scenery/saba/birch-bark-roughness.png',
  'birch-wounds-albedo.png':'assets/forest-scenery/saba/birch-wounds-albedo.png',
  'birch-wounds-normal.png':'assets/forest-scenery/saba/birch-wounds-normal.png',
  'birch-wounds-roughness.png':'assets/forest-scenery/saba/birch-wounds-roughness.png',
  'elm-bark-albedo.png':'assets/forest-scenery/saba/elm-bark-albedo.png',
  'elm-bark-normal.png':'assets/forest-scenery/saba/elm-bark-normal.png',
  'elm-bark-roughness.png':'assets/forest-scenery/saba/elm-bark-roughness.png',
  'elm-wounds-albedo.png':'assets/forest-scenery/saba/elm-wounds-albedo.png',
  'elm-wounds-normal.png':'assets/forest-scenery/saba/elm-wounds-normal.png',
  'elm-wounds-roughness.png':'assets/forest-scenery/saba/elm-wounds-roughness.png',
  'chestnut-bark-albedo.png':'assets/forest-scenery/saba/chestnut-bark-albedo.png',
  'chestnut-bark-normal.png':'assets/forest-scenery/saba/chestnut-bark-normal.png',
  'chestnut-bark-roughness.png':'assets/forest-scenery/saba/chestnut-bark-roughness.png',
  'chestnut-wounds-albedo.png':'assets/forest-scenery/saba/chestnut-wounds-albedo.png',
  'chestnut-wounds-normal.png':'assets/forest-scenery/saba/chestnut-wounds-normal.png',
  'chestnut-wounds-roughness.png':'assets/forest-scenery/saba/chestnut-wounds-roughness.png',
});
export const SUBTROPICAL_FOREST_ASSETS=Object.freeze({
  'manifest.json':'assets/forest-scenery/subtropical/manifest.json',
  'roots.bin':'assets/forest-scenery/subtropical/roots.bin.gz',
  'royal-palm-bark-albedo.png':'assets/forest-scenery/subtropical/royal-palm-bark-albedo.png',
  'royal-palm-bark-normal.png':'assets/forest-scenery/subtropical/royal-palm-bark-normal.png',
  'royal-palm-bark-roughness.png':'assets/forest-scenery/subtropical/royal-palm-bark-roughness.png',
  'royal-palm-wounds-albedo.png':'assets/forest-scenery/subtropical/royal-palm-wounds-albedo.png',
  'royal-palm-wounds-normal.png':'assets/forest-scenery/subtropical/royal-palm-wounds-normal.png',
  'royal-palm-wounds-roughness.png':'assets/forest-scenery/subtropical/royal-palm-wounds-roughness.png',
  'royal-palm-foliage-0-albedo.png':'assets/forest-scenery/subtropical/royal-palm-foliage-0-albedo.png',
  'royal-palm-foliage-0-normal.png':'assets/forest-scenery/subtropical/royal-palm-foliage-0-normal.png',
  'royal-palm-foliage-1-albedo.png':'assets/forest-scenery/subtropical/royal-palm-foliage-1-albedo.png',
  'royal-palm-foliage-1-normal.png':'assets/forest-scenery/subtropical/royal-palm-foliage-1-normal.png',
  'royal-palm-foliage-2-albedo.png':'assets/forest-scenery/subtropical/royal-palm-foliage-2-albedo.png',
  'royal-palm-foliage-2-normal.png':'assets/forest-scenery/subtropical/royal-palm-foliage-2-normal.png',
  'palm-bark-albedo.png':'assets/forest-scenery/subtropical/palm-bark-albedo.png',
  'palm-bark-normal.png':'assets/forest-scenery/subtropical/palm-bark-normal.png',
  'palm-bark-roughness.png':'assets/forest-scenery/subtropical/palm-bark-roughness.png',
  'palm-wounds-albedo.png':'assets/forest-scenery/subtropical/palm-wounds-albedo.png',
  'palm-wounds-normal.png':'assets/forest-scenery/subtropical/palm-wounds-normal.png',
  'palm-wounds-roughness.png':'assets/forest-scenery/subtropical/palm-wounds-roughness.png',
  'palm-foliage-0-albedo.png':'assets/forest-scenery/subtropical/palm-foliage-0-albedo.png',
  'palm-foliage-0-normal.png':'assets/forest-scenery/subtropical/palm-foliage-0-normal.png',
  'palm-foliage-1-albedo.png':'assets/forest-scenery/subtropical/palm-foliage-1-albedo.png',
  'palm-foliage-1-normal.png':'assets/forest-scenery/subtropical/palm-foliage-1-normal.png',
  'palm-foliage-2-albedo.png':'assets/forest-scenery/subtropical/palm-foliage-2-albedo.png',
  'palm-foliage-2-normal.png':'assets/forest-scenery/subtropical/palm-foliage-2-normal.png',
  'ceiba-bark-albedo.png':'assets/forest-scenery/subtropical/ceiba-bark-albedo.png',
  'ceiba-bark-normal.png':'assets/forest-scenery/subtropical/ceiba-bark-normal.png',
  'ceiba-bark-roughness.png':'assets/forest-scenery/subtropical/ceiba-bark-roughness.png',
  'ceiba-wounds-albedo.png':'assets/forest-scenery/subtropical/ceiba-wounds-albedo.png',
  'ceiba-wounds-normal.png':'assets/forest-scenery/subtropical/ceiba-wounds-normal.png',
  'ceiba-wounds-roughness.png':'assets/forest-scenery/subtropical/ceiba-wounds-roughness.png',
  'ceiba-foliage-0-albedo.png':'assets/forest-scenery/subtropical/ceiba-foliage-0-albedo.png',
  'ceiba-foliage-0-normal.png':'assets/forest-scenery/subtropical/ceiba-foliage-0-normal.png',
  'ceiba-foliage-1-albedo.png':'assets/forest-scenery/subtropical/ceiba-foliage-1-albedo.png',
  'ceiba-foliage-1-normal.png':'assets/forest-scenery/subtropical/ceiba-foliage-1-normal.png',
  'ceiba-foliage-2-albedo.png':'assets/forest-scenery/subtropical/ceiba-foliage-2-albedo.png',
  'ceiba-foliage-2-normal.png':'assets/forest-scenery/subtropical/ceiba-foliage-2-normal.png',
  'mangrove-bark-albedo.png':'assets/forest-scenery/subtropical/mangrove-bark-albedo.png',
  'mangrove-bark-normal.png':'assets/forest-scenery/subtropical/mangrove-bark-normal.png',
  'mangrove-bark-roughness.png':'assets/forest-scenery/subtropical/mangrove-bark-roughness.png',
  'mangrove-wounds-albedo.png':'assets/forest-scenery/subtropical/mangrove-wounds-albedo.png',
  'mangrove-wounds-normal.png':'assets/forest-scenery/subtropical/mangrove-wounds-normal.png',
  'mangrove-wounds-roughness.png':'assets/forest-scenery/subtropical/mangrove-wounds-roughness.png',
  'mangrove-foliage-0-albedo.png':'assets/forest-scenery/subtropical/mangrove-foliage-0-albedo.png',
  'mangrove-foliage-0-normal.png':'assets/forest-scenery/subtropical/mangrove-foliage-0-normal.png',
  'mangrove-foliage-1-albedo.png':'assets/forest-scenery/subtropical/mangrove-foliage-1-albedo.png',
  'mangrove-foliage-1-normal.png':'assets/forest-scenery/subtropical/mangrove-foliage-1-normal.png',
  'mangrove-foliage-2-albedo.png':'assets/forest-scenery/subtropical/mangrove-foliage-2-albedo.png',
  'mangrove-foliage-2-normal.png':'assets/forest-scenery/subtropical/mangrove-foliage-2-normal.png',
});
export const PORTUGAL_FOREST_ASSETS=Object.freeze({
  'manifest.json':'assets/forest-scenery/portugal/manifest.json',
  'roots.bin':'assets/forest-scenery/portugal/roots.bin.gz',
  'oak-veteran-bark-albedo.png':'assets/forest-scenery/portugal/oak-veteran-bark-albedo.png',
  'oak-veteran-bark-normal.png':'assets/forest-scenery/portugal/oak-veteran-bark-normal.png',
  'oak-veteran-bark-roughness.png':'assets/forest-scenery/portugal/oak-veteran-bark-roughness.png',
  'oak-veteran-wounds-albedo.png':'assets/forest-scenery/portugal/oak-veteran-wounds-albedo.png',
  'oak-veteran-wounds-normal.png':'assets/forest-scenery/portugal/oak-veteran-wounds-normal.png',
  'oak-veteran-wounds-roughness.png':'assets/forest-scenery/portugal/oak-veteran-wounds-roughness.png',
  'oak-veteran-foliage-0-albedo.png':'assets/forest-scenery/portugal/oak-veteran-foliage-0-albedo.png',
  'oak-veteran-foliage-0-normal.png':'assets/forest-scenery/portugal/oak-veteran-foliage-0-normal.png',
  'oak-veteran-foliage-1-albedo.png':'assets/forest-scenery/portugal/oak-veteran-foliage-1-albedo.png',
  'oak-veteran-foliage-1-normal.png':'assets/forest-scenery/portugal/oak-veteran-foliage-1-normal.png',
  'oak-veteran-foliage-2-albedo.png':'assets/forest-scenery/portugal/oak-veteran-foliage-2-albedo.png',
  'oak-veteran-foliage-2-normal.png':'assets/forest-scenery/portugal/oak-veteran-foliage-2-normal.png',
  'chestnut-veteran-bark-albedo.png':'assets/forest-scenery/portugal/chestnut-veteran-bark-albedo.png',
  'chestnut-veteran-bark-normal.png':'assets/forest-scenery/portugal/chestnut-veteran-bark-normal.png',
  'chestnut-veteran-bark-roughness.png':'assets/forest-scenery/portugal/chestnut-veteran-bark-roughness.png',
  'chestnut-veteran-wounds-albedo.png':'assets/forest-scenery/portugal/chestnut-veteran-wounds-albedo.png',
  'chestnut-veteran-wounds-normal.png':'assets/forest-scenery/portugal/chestnut-veteran-wounds-normal.png',
  'chestnut-veteran-wounds-roughness.png':'assets/forest-scenery/portugal/chestnut-veteran-wounds-roughness.png',
  'chestnut-veteran-foliage-0-albedo.png':'assets/forest-scenery/portugal/chestnut-veteran-foliage-0-albedo.png',
  'chestnut-veteran-foliage-0-normal.png':'assets/forest-scenery/portugal/chestnut-veteran-foliage-0-normal.png',
  'chestnut-veteran-foliage-1-albedo.png':'assets/forest-scenery/portugal/chestnut-veteran-foliage-1-albedo.png',
  'chestnut-veteran-foliage-1-normal.png':'assets/forest-scenery/portugal/chestnut-veteran-foliage-1-normal.png',
  'chestnut-veteran-foliage-2-albedo.png':'assets/forest-scenery/portugal/chestnut-veteran-foliage-2-albedo.png',
  'chestnut-veteran-foliage-2-normal.png':'assets/forest-scenery/portugal/chestnut-veteran-foliage-2-normal.png',
  'maple-veteran-bark-albedo.png':'assets/forest-scenery/portugal/maple-veteran-bark-albedo.png',
  'maple-veteran-bark-normal.png':'assets/forest-scenery/portugal/maple-veteran-bark-normal.png',
  'maple-veteran-bark-roughness.png':'assets/forest-scenery/portugal/maple-veteran-bark-roughness.png',
  'maple-veteran-wounds-albedo.png':'assets/forest-scenery/portugal/maple-veteran-wounds-albedo.png',
  'maple-veteran-wounds-normal.png':'assets/forest-scenery/portugal/maple-veteran-wounds-normal.png',
  'maple-veteran-wounds-roughness.png':'assets/forest-scenery/portugal/maple-veteran-wounds-roughness.png',
  'maple-veteran-foliage-0-albedo.png':'assets/forest-scenery/portugal/maple-veteran-foliage-0-albedo.png',
  'maple-veteran-foliage-0-normal.png':'assets/forest-scenery/portugal/maple-veteran-foliage-0-normal.png',
  'maple-veteran-foliage-1-albedo.png':'assets/forest-scenery/portugal/maple-veteran-foliage-1-albedo.png',
  'maple-veteran-foliage-1-normal.png':'assets/forest-scenery/portugal/maple-veteran-foliage-1-normal.png',
  'maple-veteran-foliage-2-albedo.png':'assets/forest-scenery/portugal/maple-veteran-foliage-2-albedo.png',
  'maple-veteran-foliage-2-normal.png':'assets/forest-scenery/portugal/maple-veteran-foliage-2-normal.png',
  'elm-veteran-bark-albedo.png':'assets/forest-scenery/portugal/elm-veteran-bark-albedo.png',
  'elm-veteran-bark-normal.png':'assets/forest-scenery/portugal/elm-veteran-bark-normal.png',
  'elm-veteran-bark-roughness.png':'assets/forest-scenery/portugal/elm-veteran-bark-roughness.png',
  'elm-veteran-wounds-albedo.png':'assets/forest-scenery/portugal/elm-veteran-wounds-albedo.png',
  'elm-veteran-wounds-normal.png':'assets/forest-scenery/portugal/elm-veteran-wounds-normal.png',
  'elm-veteran-wounds-roughness.png':'assets/forest-scenery/portugal/elm-veteran-wounds-roughness.png',
  'elm-veteran-foliage-0-albedo.png':'assets/forest-scenery/portugal/elm-veteran-foliage-0-albedo.png',
  'elm-veteran-foliage-0-normal.png':'assets/forest-scenery/portugal/elm-veteran-foliage-0-normal.png',
  'elm-veteran-foliage-1-albedo.png':'assets/forest-scenery/portugal/elm-veteran-foliage-1-albedo.png',
  'elm-veteran-foliage-1-normal.png':'assets/forest-scenery/portugal/elm-veteran-foliage-1-normal.png',
  'elm-veteran-foliage-2-albedo.png':'assets/forest-scenery/portugal/elm-veteran-foliage-2-albedo.png',
  'elm-veteran-foliage-2-normal.png':'assets/forest-scenery/portugal/elm-veteran-foliage-2-normal.png',
  'birch-veteran-bark-albedo.png':'assets/forest-scenery/portugal/birch-veteran-bark-albedo.png',
  'birch-veteran-bark-normal.png':'assets/forest-scenery/portugal/birch-veteran-bark-normal.png',
  'birch-veteran-bark-roughness.png':'assets/forest-scenery/portugal/birch-veteran-bark-roughness.png',
  'birch-veteran-wounds-albedo.png':'assets/forest-scenery/portugal/birch-veteran-wounds-albedo.png',
  'birch-veteran-wounds-normal.png':'assets/forest-scenery/portugal/birch-veteran-wounds-normal.png',
  'birch-veteran-wounds-roughness.png':'assets/forest-scenery/portugal/birch-veteran-wounds-roughness.png',
  'birch-veteran-foliage-0-albedo.png':'assets/forest-scenery/portugal/birch-veteran-foliage-0-albedo.png',
  'birch-veteran-foliage-0-normal.png':'assets/forest-scenery/portugal/birch-veteran-foliage-0-normal.png',
  'birch-veteran-foliage-1-albedo.png':'assets/forest-scenery/portugal/birch-veteran-foliage-1-albedo.png',
  'birch-veteran-foliage-1-normal.png':'assets/forest-scenery/portugal/birch-veteran-foliage-1-normal.png',
  'birch-veteran-foliage-2-albedo.png':'assets/forest-scenery/portugal/birch-veteran-foliage-2-albedo.png',
  'birch-veteran-foliage-2-normal.png':'assets/forest-scenery/portugal/birch-veteran-foliage-2-normal.png',
  'blueberry-veteran-bark-albedo.png':'assets/forest-scenery/portugal/blueberry-veteran-bark-albedo.png',
  'blueberry-veteran-bark-normal.png':'assets/forest-scenery/portugal/blueberry-veteran-bark-normal.png',
  'blueberry-veteran-bark-roughness.png':'assets/forest-scenery/portugal/blueberry-veteran-bark-roughness.png',
  'blueberry-veteran-wounds-albedo.png':'assets/forest-scenery/portugal/blueberry-veteran-wounds-albedo.png',
  'blueberry-veteran-wounds-normal.png':'assets/forest-scenery/portugal/blueberry-veteran-wounds-normal.png',
  'blueberry-veteran-wounds-roughness.png':'assets/forest-scenery/portugal/blueberry-veteran-wounds-roughness.png',
  'blueberry-veteran-foliage-0-albedo.png':'assets/forest-scenery/portugal/blueberry-veteran-foliage-0-albedo.png',
  'blueberry-veteran-foliage-0-normal.png':'assets/forest-scenery/portugal/blueberry-veteran-foliage-0-normal.png',
  'blueberry-veteran-foliage-1-albedo.png':'assets/forest-scenery/portugal/blueberry-veteran-foliage-1-albedo.png',
  'blueberry-veteran-foliage-1-normal.png':'assets/forest-scenery/portugal/blueberry-veteran-foliage-1-normal.png',
  'blueberry-veteran-foliage-2-albedo.png':'assets/forest-scenery/portugal/blueberry-veteran-foliage-2-albedo.png',
  'blueberry-veteran-foliage-2-normal.png':'assets/forest-scenery/portugal/blueberry-veteran-foliage-2-normal.png',
});
export const FOREST_SPECIES=Object.freeze(['oak','maple','birch','elm','chestnut','palm','royal_palm','ceiba','mangrove','blueberry']);
export const FOREST_ROOT_FLOATS=12;
const finite=(v,n)=>Array.isArray(v)&&v.length===n&&v.every(Number.isFinite);
const uint=n=>Number.isSafeInteger(n)&&n>=0;
const forestMapReceipt=(value,encoding)=>value&&/^[a-z0-9-]+\.png$/.test(value.file)&&uint(value.bytes)&&value.bytes>0&&value.bytes<=8*1024*1024&&/^[a-f0-9]{64}$/.test(value.sha256)&&value.encoding===encoding;
const forestSourceReceipt=value=>value&&typeof value.file==='string'&&value.file.length>0&&uint(value.bytes)&&value.bytes>0&&/^[a-f0-9]{64}$/.test(value.sha256);
const forestSameReceipt=(a,b)=>forestSourceReceipt(a)&&forestSourceReceipt(b)&&['file','bytes','sha256'].every(key=>a[key]===b[key]);
function validateForestGeometryError(p,manifest){
  if(p.geometryErrorSupported!==true)return;
  const certificate=p.geometryErrorSource,error=p.geometryErrorMetres;
  if(!Number.isFinite(error)||error<0||Math.fround(error)!==error||p.geometryErrorMethod!=='symmetric-fixed-opposing-vertex-triangle-bound-v1'||
    !forestSameReceipt(certificate?.nativeGLB,p.source?.native?.glb)||!forestSameReceipt(certificate?.farAsset,p.source?.directFar)||
    !forestSourceReceipt(certificate?.method)||certificate.method.file!=='scripts/prepare-canopy-scenery.py#conservative_error')throw Error('Invalid forest geometry error certificate');
  for(const name of ['vertices.bin','indices.bin']){
    const receipt=certificate.packedStreams?.[name],packed=manifest.files[name];
    if(receipt?.bytes!==packed.bytes||receipt.sha256!==packed.sha256)throw Error('Forest geometry certificate stream mismatch');
  }
  for(const key of ['wood','leaf','far']){
    const range=certificate.ranges?.[key],measured=certificate.measuredStreams?.[key];
    if(range?.firstIndex!==p[key].firstIndex||range.indexCount!==p[key].indexCount||measured?.strideFloats!==14||
      measured.vertexCount!==p[key].indexCount||measured.bytes!==measured.vertexCount*56||!/^[a-f0-9]{64}$/.test(measured.sha256))throw Error('Forest geometry certificate range mismatch');
  }
}
export function validateForestMaterials(prototypes){
  let count=0;const receipts=new Map();
  for(const p of prototypes){
    if(!Array.isArray(p.nativeMaterials)||!p.nativeMaterials.length||p.nativeMaterials.length>16)throw Error('Forest requires native materials');
    for(const material of p.nativeMaterials){
      if(!forestMapReceipt(material.albedo,'srgb')||!forestMapReceipt(material.normal,'linear')||
        (material.roughnessMap&&!forestMapReceipt(material.roughnessMap,'linear'))||
        (material.wrap!==undefined&&!['clamp','repeat'].includes(material.wrap))||
        (material.clearcoat!==undefined&&!(Number.isFinite(material.clearcoat)&&material.clearcoat>=0&&material.clearcoat<=1))||
        !['roughness','underside','transmission','opacityThreshold'].every(key=>Number.isFinite(material[key])&&material[key]>=0&&material[key]<=1)||
        !finite(material.undersideReference,3)||material.undersideReference.some(v=>v<0||v>1))throw Error('Invalid native forest material');
      for(const kind of ['albedo','normal','roughnessMap'].filter(key=>material[key])){
        const r=material[kind],identity=[r.bytes,r.sha256,r.encoding].join(':');
        if(receipts.has(r.file)&&receipts.get(r.file)!==identity)throw Error('Conflicting native forest surface receipt');receipts.set(r.file,identity);
      }
      count++;
    }
  }
  if(count>128)throw Error('Forest native material layer limit exceeded');
  return count;
}
export function validateForestScenery(m){
  if(m?.format!=='waterworld.forest-instances'||![1,2].includes(m.version)||m.units!=='metres'||m.upAxis!=='Y'||m.vertexStride!==(m.version===2?56:52)||m.rootStride!==48||
    !uint(m.rootCount)||!m.rootCount||m.rootCount>250000||!Array.isArray(m.prototypes)||!m.prototypes.length||m.prototypes.length>32)throw Error('Unsupported instanced forest');
  for(const [name,stride,count]of[['vertices.bin',m.vertexStride,'vertexCount'],['indices.bin',4,'indexCount'],['roots.bin',48,'rootCount']]){
    const f=m.files?.[name];if(!uint(f?.[count])||!f[count]||f.bytes!==f[count]*stride||f.bytes>512*1024*1024||!/^[a-f0-9]{64}$/.test(f.sha256))throw Error('Invalid forest stream receipt: '+name);
    if(f.gzip&&(!uint(f.gzip.bytes)||!f.gzip.bytes||f.gzip.bytes>192*1024*1024||!/^[a-f0-9]{64}$/.test(f.gzip.sha256)||f.gzip.file!==name+'.gz'))throw Error('Invalid encoded forest stream receipt: '+name);
  }
  if(m.files['roots.bin'].rootCount!==m.rootCount)throw Error('Forest root count mismatch');
  const c=m.coverage;
  if(c?.kind!=='occupied-cells'||!finite(c.originXZ,2)||!(c.cellMetres>0)||!finite(c.dimensions,2)||!c.dimensions.every(n=>uint(n)&&n>0)||
    !Array.isArray(c.cells)||new Set(c.cells).size!==c.cells.length||c.cells.some(n=>!uint(n)||n>=c.dimensions[0]*c.dimensions[1]))throw Error('Invalid forest occupied coverage');
  const native=m.version===2&&m.materialContract==='gene-surfaces-v3';
  if(m.version===2&&!native)throw Error('Current forest requires native material contract');
  if(m.materialContract&&!native)throw Error('Unsupported forest material contract');
  if(native)validateForestMaterials(m.prototypes);
  let nextIndex=0,nextRoot=0;
  for(const [i,p]of m.prototypes.entries()){
    if(p.id!==i||!FOREST_SPECIES.includes(p.species)||!finite(p.low,3)||!finite(p.high,3)||p.low.some((v,k)=>v>p.high[k])||
      !finite(p.centre,3)||!(p.radius>0)||!uint(p.firstRoot)||p.firstRoot!==nextRoot||!uint(p.rootCount))throw Error('Invalid forest prototype');
    for(let bits=0;bits<8;bits++)if(Math.hypot(...p.low.map((v,k)=>(bits&(1<<k)?p.high[k]:v)-p.centre[k]))>p.radius+1e-4)throw Error('Forest prototype bound misses geometry');
    for(const key of ['wood','leaf','far']){
      const r=p[key];if(!uint(r?.firstIndex)||r.firstIndex!==nextIndex||!uint(r.indexCount)||r.indexCount%3||r.firstIndex+r.indexCount>m.files['indices.bin'].indexCount)throw Error('Invalid forest index range');
      nextIndex+=r.indexCount;
    }
    if(!p.far.indexCount||!p.leaf.indexCount)throw Error('Forest requires detailed foliage and opaque far canopy');
    validateForestGeometryError(p,m);
    nextRoot+=p.rootCount;
  }
  if(nextIndex!==m.files['indices.bin'].indexCount||nextRoot!==m.rootCount)throw Error('Incomplete forest partitions');
  if(m.appearanceErrorSupported!==false)throw Error('Forest appearance LOD is not certified');
  return m;
}
function* forestRootChecks(manifest,roots){
  if(!(roots instanceof Float32Array)||roots.byteLength!==manifest.files['roots.bin'].bytes)throw Error('Incomplete forest roots');
  for(const p of manifest.prototypes)for(let i=p.firstRoot;i<p.firstRoot+p.rootCount;i++){
    const o=i*12,r0=roots[o],r2=roots[o+2],r3=roots[o+3],r5=roots[o+5],r6=roots[o+6],r7=roots[o+7],r8=roots[o+8],r9=roots[o+9];
    for(let k=0;k<12;k++)if(!Number.isFinite(roots[o+k]))throw Error('Invalid forest root transform');
    if(r3<=0||r3>5||r8!==p.id||r9<0||r5<=0||r5>2||r6<=0||r6>2||r7<=0||r7>2||!forestCoversPoint(manifest,r0,r2))throw Error('Invalid forest root transform');
    if((i&1023)===0)yield;
  }
}
function forestLoadAbort(signal){if(signal?.aborted)throw signal.reason??new DOMException('Forest load aborted','AbortError');}
// Walks a pack's checks, yielding to the page as the work grows long.
async function finishForestChecks(iterator){
  const pauseIfNeeded=createTaskYieldBudget();
  for(;;){const next=iterator.next();if(next.done)return next.value;const pause=pauseIfNeeded();if(pause)await pause;}
}
// Roots whose bytes were checked once when the pack was baked need not be walked again at every landfall.
const CERTIFIED_FOREST_ROOT_SHAS=new Set([
  '69bc2f787873f09944683f49e88c9bc09d8b068a33aee85453b626150050de9b',
  '5e26e551af5855219ef1ac84ef97fafeef1a4826cd94da7ff6fcda78dfed6963',
  '2c700a58140e7dcb2772fc999e6d52b487621ad168ebe70f4b7447210ee1af40',
]);
// A pack as the game holds it: its manifest and its roots, verified, and its maps, which a device with
// block-compressed surfaces never needs (deferSurfaces leaves them to loadSurfaces). Procedural coasts plant
// their own roots (js/terrain.js) and skip the pack's.
export async function loadForestScenery({fetchAsset=fetch,assets=FOREST_ASSETS,skipRoots=false,deferSurfaces=false}={}){
  const load=async(n,signal)=>{forestLoadAbort(signal);if(typeof assets[n]!=='string')throw Error('Unregistered forest asset: '+n);const r=await fetchAsset(assets[n],signal?{signal}:undefined);if(!r.ok)throw Error('Forest scenery unavailable ('+r.status+'): '+n);return r;};
  const manifest=validateForestScenery(await(await load('manifest.json')).json());
  if(!globalThis.crypto?.subtle)throw Error('Forest receipt verification requires Web Crypto');
  const digest=async raw=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',raw)),v=>v.toString(16).padStart(2,'0')).join('');
  const stream=async(name,signal)=>{
    const receipt=manifest.files[name];let raw=await(await load(name,signal)).arrayBuffer();
    if(receipt.gzip){
      if(raw.byteLength!==receipt.gzip.bytes||await digest(raw)!==receipt.gzip.sha256)throw Error('Forest encoded digest mismatch: '+name);
      if(typeof DecompressionStream!=='function')throw Error('Forest roots require gzip decoding');
      raw=await new Response(new Blob([raw]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
    }
    forestLoadAbort(signal);if(raw.byteLength!==receipt.bytes||await digest(raw)!==receipt.sha256)throw Error('Forest digest mismatch: '+name);return raw;
  };
  // Old 42-tree stand packs use their separate loader. A regional production
  // forest must never silently borrow that stand's generic foliage image.
  if(manifest.version!==2||manifest.materialContract!=='gene-surfaces-v3')throw Error('Regional forest requires current native surfaces');
  validateForestMaterials(manifest.prototypes);
  const roots=new Float32Array(skipRoots?new ArrayBuffer(0):await stream('roots.bin'));
  if(!skipRoots&&!CERTIFIED_FOREST_ROOT_SHAS.has(manifest.files['roots.bin']?.sha256))await finishForestChecks(forestRootChecks(manifest,roots));
  let mapsPromise;
  // The maps, fetched once however often they are asked for.
  const loadSurfaces=({signal}={})=>mapsPromise??=(async()=>{
    const textures={},pending=new Map();
    await Promise.all(manifest.prototypes.flatMap(p=>p.nativeMaterials.flatMap(material=>['albedo','normal','roughnessMap'].filter(kind=>material[kind]).map(async kind=>{
      const receipt=material[kind];if(pending.has(receipt.file))return pending.get(receipt.file);
      const request=(async()=>{
        const raw=await(await load(receipt.file,signal)).arrayBuffer();
        if(raw.byteLength!==receipt.bytes)throw Error('Incomplete forest surface: '+receipt.file);
        if(await digest(raw)!==receipt.sha256)throw Error('Forest surface digest mismatch: '+receipt.file);textures[receipt.file]=raw;
      })();pending.set(receipt.file,request);return request;
    }))));
    return textures;
  })();
  // Once the GPU holds the surfaces the pack lets go of the maps; a later call fetches and verifies them afresh.
  const releaseSurfaces=()=>{mapsPromise=undefined;};
  return {manifest,roots,textures:deferSurfaces?null:await loadSurfaces(),loadSurfaces,releaseSurfaces};
}
const coverageSets=new WeakMap();
export function forestCoversPoint(manifest,x,z){
  const c=manifest.coverage,ix=Math.floor((x-c.originXZ[0])/c.cellMetres),iz=Math.floor((z-c.originXZ[1])/c.cellMetres);
  if(ix<0||iz<0||ix>=c.dimensions[0]||iz>=c.dimensions[1])return false;
  let cells=coverageSets.get(manifest);if(!cells){cells=new Set(c.cells);coverageSets.set(manifest,cells);}
  return cells.has(iz*c.dimensions[0]+ix);
}
export function excludeForestRoots(trees,manifest){
  if(!(trees instanceof Float32Array)||trees.length%8)throw Error('Invalid legacy forest roots');
  const out=[];for(let i=0;i<trees.length;i+=8)if(!forestCoversPoint(manifest,trees[i],trees[i+2]))out.push(...trees.subarray(i,i+8));
  return new Float32Array(out);
}

// Native pigment is sRGB; alpha is coverage, and normals are linear. Generate
// linear, coverage-weighted mips once on the GPU. Thresholding averaged alpha
// would delete subpixel leaves and turn an otherwise dense forest into haze.
// Half floats here serve this compute pass, which needs a format it can write;
// no value leaves 0..1. Devices with block compression use forest-surfaces.js.
// Signed normals are biased so both paths hold one encoding: forestDetailSigned reads it.
export const FOREST_SURFACE_MIPS_WGSL=/* wgsl */`
@group(0)@binding(0)var forestMipAlbedo:texture_2d_array<f32>;
@group(0)@binding(1)var forestMipNormal:texture_2d_array<f32>;
@group(0)@binding(2)var forestMipColourOut:texture_storage_2d_array<rgba16float,write>;
@group(0)@binding(3)var forestMipNormalOut:texture_storage_2d_array<rgba16float,write>;
@group(0)@binding(4)var forestMipRoughness:texture_2d_array<f32>;
@group(0)@binding(5)var<storage,read>forestMipOptics:array<vec4f>;
fn forestMipLinear(c:vec3f)->vec3f{
 return select(pow((c+vec3f(.055))/1.055,vec3f(2.4)),c/12.92,c<=vec3f(.04045));
}
@compute @workgroup_size(8,8,1)fn forestSurfaceInit(@builtin(global_invocation_id)id:vec3u){
 let size=textureDimensions(forestMipColourOut);if(any(id.xy>=size)||id.z>=textureNumLayers(forestMipColourOut)){return;}
 let p=vec2i(id.xy);let layer=i32(id.z);let c=textureLoad(forestMipAlbedo,p,layer,0);
 let nTex=textureLoad(forestMipNormal,p,layer,0);
 let n=normalize(nTex.xyz*2.-1.);
 var roughness=select(forestMipOptics[id.z].x,nTex.a,nTex.a<0.995);
 if(forestMipOptics[id.z].y>0.){roughness=textureLoad(forestMipRoughness,p,layer,0).r;}
 textureStore(forestMipColourOut,p,layer,vec4f(forestMipLinear(c.rgb)*c.a,c.a));
 textureStore(forestMipNormalOut,p,layer,vec4f((n*c.a*127.+vec3f(128.))/255.,roughness*c.a));
}
@compute @workgroup_size(8,8,1)fn forestSurfaceMips(@builtin(global_invocation_id)id:vec3u){
 let size=textureDimensions(forestMipColourOut);if(any(id.xy>=size)||id.z>=textureNumLayers(forestMipColourOut)){return;}
 let edge=vec2i(textureDimensions(forestMipAlbedo))-1;let p=vec2i(id.xy)*2;let layer=i32(id.z);
 var colour=vec4f(0);var normal=vec4f(0);
 for(var y=0;y<2;y++){for(var x=0;x<2;x++){
   let q=min(p+vec2i(x,y),edge);colour+=textureLoad(forestMipAlbedo,q,layer,0);normal+=textureLoad(forestMipNormal,q,layer,0);
 }}
 textureStore(forestMipColourOut,vec2i(id.xy),layer,colour*.25);
 textureStore(forestMipNormalOut,vec2i(id.xy),layer,normal*.25);
}
`;

export async function createForestLeafSurfaces({device,shader,pack}){
  const layerCount=validateForestMaterials(pack.manifest.prototypes),materials=pack.manifest.prototypes.flatMap(p=>p.nativeMaterials);
  const images=[],families=[],textures=[],temporary=[];
  let submitted=false;
  try{
    const optics=new Float32Array(layerCount*12);
    for(const material of materials){
      for(const kind of ['albedo','normal','roughnessMap'].filter(key=>material[key])){
        const raw=pack.textures?.[material[kind].file];if(!(raw instanceof ArrayBuffer)||raw.byteLength!==material[kind].bytes)throw Error('Missing native forest surface: '+material[kind].file);
      }
    }
    const T=GPUTextureUsage;
    const pipelinesPromise=shader(FOREST_SURFACE_MIPS_WGSL,'forest native surface mipmaps').then(code=>Promise.all([
      device.createComputePipelineAsync({label:'forest initialise native surfaces',layout:'auto',compute:{module:code,entryPoint:'forestSurfaceInit'}}),
      device.createComputePipelineAsync({label:'forest filter native coverage',layout:'auto',compute:{module:code,entryPoint:'forestSurfaceMips'}}),
    ]));
    pipelinesPromise.catch(()=>{});
    const bitmapCache=new Map();
    const decodedMaps=await Promise.all(materials.map(async material=>{
      const entries=await Promise.all(['albedo','normal','roughnessMap'].filter(key=>material[key]).map(async kind=>{
        const file=material[kind].file;
        let bmpPromise=bitmapCache.get(file);
        if(!bmpPromise){
          const raw=pack.textures[file];
          bmpPromise=createImageBitmap(new Blob([raw],{type:'image/png'}),{premultiplyAlpha:'none',colorSpaceConversion:'none'}).then(img=>{images.push(img);return img;});
          bitmapCache.set(file,bmpPromise);
        }
        return[kind,await bmpPromise];
      }));
      return Object.fromEntries(entries);
    }));
    for(const [index,material]of materials.entries()){
      const maps=decodedMaps[index];
      const {width,height}=maps.albedo;
      if(width<1||height<1||width>2048||height>2048||(width&(width-1))||(height&(height-1))||Object.values(maps).some(image=>image.width!==width||image.height!==height))throw Error('Native material maps require matching power-of-two dimensions');
      let family=families.find(f=>f.width===width&&f.height===height);
      if(!family){family={width,height,id:families.length,rows:[],levels:1+Math.floor(Math.log2(Math.max(width,height)))};families.push(family);}
      if(families.length>4)throw Error('Native forest texture dimension family limit exceeded');
      const rowKey=`${material.albedo.file}:${material.normal.file}:${material.roughnessMap?.file??''}:${material.roughness}`;
      let rowIdx=family.rows.findIndex(r=>r.rowKey===rowKey);
      if(rowIdx<0){rowIdx=family.rows.length;family.rows.push({maps,material,rowKey});}
      forestMaterialOptics(optics,index,material,family.id,rowIdx);
    }
    const [init,mip]=await pipelinesPromise;
    const encoder=device.createCommandEncoder({label:'forest immutable surface preparation'}),pass=encoder.beginComputePass();
    const view=(texture,level)=>texture.createView({dimension:'2d-array',baseMipLevel:level,mipLevelCount:1});
    for(const family of families){
      const {width,height,rows,levels}=family;
      const raw=label=>{const t=device.createTexture({label,size:[width,height,rows.length],format:'rgba8unorm',usage:T.TEXTURE_BINDING|T.COPY_DST|T.RENDER_ATTACHMENT});temporary.push(t);return t;};
      const sources=[raw('forest native source albedo'),raw('forest native source normal'),raw('forest native source roughness')];
      const target=label=>{const t=device.createTexture({label,size:[width,height,rows.length],format:'rgba16float',mipLevelCount:levels,usage:T.TEXTURE_BINDING|T.STORAGE_BINDING});textures.push(t);return t;};
      family.albedo=target('forest immutable native pigment and coverage mips');family.normal=target('forest immutable native normal and roughness mips');
      const rowOptics=new Float32Array(rows.length*4);for(const [layer,row]of rows.entries()){
        for(const [i,kind]of ['albedo','normal','roughnessMap'].entries())if(row.maps[kind])device.queue.copyExternalImageToTexture({source:row.maps[kind]},{texture:sources[i],origin:[0,0,layer]},[width,height]);
        rowOptics.set([row.material.roughness,row.maps.roughnessMap?1:0,0,0],layer*4);
      }
      const rowBuffer=device.createBuffer({label:'forest surface initial optics',size:rowOptics.byteLength,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});temporary.push(rowBuffer);device.queue.writeBuffer(rowBuffer,0,rowOptics);
      for(let level=0;level<levels;level++){
        const pipeline=level?mip:init;pass.setPipeline(pipeline);
        const resources=[level?view(family.albedo,level-1):view(sources[0],0),level?view(family.normal,level-1):view(sources[1],0),view(family.albedo,level),view(family.normal,level)];
        const entries=resources.map((resource,binding)=>({binding,resource}));
        if(!level)entries.push({binding:4,resource:view(sources[2],0)},{binding:5,resource:{buffer:rowBuffer}});
        pass.setBindGroup(0,device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries}));
        pass.dispatchWorkgroups(Math.ceil(Math.max(1,width>>level)/8),Math.ceil(Math.max(1,height>>level)/8),rows.length);
      }
    }
    pass.end();device.queue.submit([encoder.finish()]);submitted=true;
    const cleanup=()=>{for(const resource of temporary)resource.destroy();};
    device.queue.onSubmittedWorkDone().then(cleanup,cleanup);
    return {families,optics,layers:layerCount,destroy(){for(const texture of textures)texture.destroy();}};
  }catch(error){for(const texture of textures)texture.destroy();if(!submitted)for(const resource of temporary)resource.destroy();throw error;}
  finally{for(const image of images)image.close();}
}

// As many roots as the device lets one buffer hold and one storage binding see, at 48 bytes a root: the roots are
// the largest of the buffers sized by them. The stand pass spreads its workgroups past one dispatch row, so that
// bounds nothing.
export function forestRootCapacity(device){
  const limits=device?.limits??{};
  const bytes=Math.min(limits.maxStorageBufferBindingSize??134217728,limits.maxBufferSize??268435456);
  return Math.max(1,Math.floor(bytes/48));
}

// A pack's roots, section by section, nearest the player first, each section as the arrays it was planted in
// (retargetForestPackToProcedural, js/terrain.js). A pack read whole from disk is one section of one array.
export function forestPackSections(pack){
  if(Array.isArray(pack?.sections))return pack.sections;
  return pack?.roots?.length?[{key:'pack',parts:[pack.roots]}]:[];
}

// Every root of a pack in one array, section after section: for tools and tests. The game never joins them.
export function forestPackRoots(pack){
  const parts=forestPackSections(pack).flatMap(section=>section.parts??[]);
  const out=new Float32Array(parts.reduce((sum,part)=>sum+part.length,0));
  let at=0;for(const part of parts){out.set(part,at);at+=part.length;}
  return out;
}

// The forest of a pack, drawn through the one continuum (AGENTS.md rule 3). Each prototype is a type of the pack's
// atlas (js/forest-continuum.js); each frame the stand pass (js/wgsl/forest-continuum.js) writes every root in view or
// in the shadow map's box as a record of the one format, posed by the WIND kind with its gust, any blast's push and
// what shot has done to it; the one cut (js/continuum-scene.js) cuts each at the scene's one pixel error and draws it
// with the forest's material, and casts its shadow. Nothing here selects, lists or draws a tree of its own.
export async function createForestRenderer({device,shader,frameUBO,resources,clouds,format,samples,shadowFormat,terrainSource,pack,groundSample,
  savedStrikes=null,strikeOrigin={x:0,z:0},onStrikesChanged=null}){
  if(samples<2)throw Error('Forest leaf coverage requires MSAA');
  const m=pack.manifest,allocated=[],B=GPUBufferUsage,P=m.prototypes.length;
  const make=(data,usage,label)=>{if(data.byteLength>device.limits.maxBufferSize)throw Error(label+' exceeds GPU maxBufferSize');const b=device.createBuffer({size:Math.max(4,data.byteLength),usage:usage|B.COPY_DST,label});allocated.push(b);if(data.byteLength)device.queue.writeBuffer(b,0,data);return b;};
  const abort=new AbortController();
  let destroyed=false,surfaces=null,roots=null,scene=null,standGroup=null;
  const query=typeof location==='undefined'?new URLSearchParams():new URLSearchParams(location.search);
  const shadowUniform=resources.find(([id])=>id===19)?.[1].buffer;
  if(!shadowUniform)throw Error('The forest is lit and cut by the land\'s shadow map, and there is none');
  // The GPU lets a buffer go once the work already given it is done.
  const retire=items=>{const drop=()=>{for(const b of items)b?.destroy();};if(typeof device.queue?.onSubmittedWorkDone==='function')device.queue.onSubmittedWorkDone().then(drop,drop);else drop();};
  try{
    const isSubtropicalPack=m.prototypes.some(p=>p.species==='royal_palm'||p.species==='ceiba'||p.species==='mangrove');
    const isCohortPack=m.prototypes.some(p=>Boolean(p.cohort));
    const samplerOptions={minFilter:'linear',magFilter:'linear',mipmapFilter:'linear',maxAnisotropy:4};
    const nativeSampler=device.createSampler({...samplerOptions,addressModeU:'clamp-to-edge',addressModeV:'clamp-to-edge'});
    const nativeRepeatSampler=device.createSampler({...samplerOptions,addressModeU:'repeat',addressModeV:'repeat'});
    // The pack's atlas, its programs, its view and its stand pass, asked for at once while the roots are laid, the
    // programs binding as many pages as the atlas takes.
    const assets=forestContinuumAssetsFor(m);
    const atlasReady=requestContinuumAtlas(device,`forest ${assets['manifest.json']}`,()=>loadForestContinuum({assets})),pages=atlasReady.then(a=>a.pages.length);
    const ready=Promise.all([
      atlasReady,
      requestContinuumPrograms({device,shader,shadowFormat,pages}),
      requestContinuumView({device,shader,material:forestContinuumMaterial(terrainSource),format,samples,pages}),
      shader(forestContinuumStandWGSL(),'forest stand'),
    ]);
    ready.catch(()=>{});
    // A pack planted for a coast (js/terrain.js) is the coast's own, and its arrays are struck where they lie. A pack
    // read whole from disk may be shared, so it is copied first.
    const initialSections=Array.isArray(pack.sections)?pack.sections:forestPackSections({roots:pack.roots?.slice()});
    let excludedRoots=0;
    const strikes=forestStrikesFromSave(savedStrikes,strikeOrigin),falling=[];
    if(groundSample)for(const section of initialSections)for(const rooted of section.parts)for(let i=0;i+12<=rooted.length;i+=12){
      const x=rooted[i],z=rooted[i+2],y=groundSample(x,z);
      if(!Number.isFinite(y))throw Error('Non-finite forest ground sampler');
      const sx=(groundSample(x+1,z)-groundSample(x-1,z))*.5,sz=(groundSample(x,z+1)-groundSample(x,z-1))*.5,slope=Math.hypot(sx,sz);
      // A measured near tile can expose a cliff/beach hidden by coarse data.
      // Reject that root once; never leave it floating or grow a replacement.
      const minY=rooted[i+10]<0?0.75:18;
      if(y<minY||y>845||!Number.isFinite(slope)||slope>1.1){rooted[i+3]=0;excludedRoots++;continue;}
      const basal=m.prototypes[rooted[i+8]].basalRadius??0;
      const maxSink=rooted[i+10]<0?0.65:Infinity;
      rooted[i+9]=Math.min(maxSink,Math.max(rooted[i+9],basal*rooted[i+3]*slope+.08));rooted[i+1]=y-rooted[i+9];
    }
    // Only the device's limits bound the roots (forestRootCapacity); the buffers grow with the sections they hold.
    const deviceCapacity=forestRootCapacity(device);
    let rootCapacity=0,activeRootCount=0;
    const stats={loaded:true,backend:'continuum',roots:0,excludedRoots,rootCapacity,deviceRootCapacity:deviceCapacity,sections:{resident:0,released:0,arrays:0},prototypes:P,
      materialContract:m.materialContract,materialLayers:0,textureFamilies:[],coverageFiltering:'Stable independent leaf footprint sample masks',
      species:[...new Set(m.prototypes.map(p=>p.species))],sourceClaim:m.sourceClaim};
    const trunkShapes=m.prototypes.map(p=>forestTrunkShape(p.species,m.stature==='full-grown'?{height:p.high[1],trunkRadius:p.dbhCentimetres/200}:null));
    // Every array of roots held, by the array: where it lies in the roots, how many it holds, how many stand in it,
    // and the ground it covers. An array once given its strikes is never given them again: it keeps them while it is
    // let go and comes back with them.
    const slabs=new Map(),charred=new WeakSet(),grids=new Map();
    let order=[];
    const slabOf=(part,count,start)=>{
      let standing=0,minX=Infinity,maxX=-Infinity,minZ=Infinity,maxZ=-Infinity;
      for(let i=0,at=0;i<count;i++,at+=12){
        if(!(part[at+3]>0))continue;
        const kind=part[at+8]|0,x=part[at],z=part[at+2];
        if(kind>=0&&kind<P)standing++;
        if(x<minX)minX=x;if(x>maxX)maxX=x;if(z<minZ)minZ=z;if(z>maxZ)maxZ=z;
      }
      return {part,count,start,standing,minX,maxX,minZ,maxZ};
    };
    const rootsBuffer=capacity=>device.createBuffer({size:Math.max(48,capacity*48),usage:B.STORAGE|B.COPY_DST|B.COPY_SRC,label:'forest root transforms'});
    // The roots stood each frame, and the cut's workgroups for them; and what the stand pass is told: the roots in
    // use, the records it may write, whether shadows are cast, the blasts, the world's offset.
    const stood=device.createBuffer({label:'forest stood',size:FOREST_CONTINUUM_STOOD_BYTES,usage:B.STORAGE|B.INDIRECT});allocated.push(stood);
    const standBytes=new ArrayBuffer(FOREST_CONTINUUM_STAND_BYTES),standWords=new Uint32Array(standBytes),standFloats=new Float32Array(standBytes);
    const standUniform=make(new Uint8Array(standBytes),B.UNIFORM,'forest stand');
    const blasts=[];let shiftX=0,shiftZ=0,standChanged=true;
    // A blast whips the trees its wave reaches: at its centre `strength` metres at a tree's tips, none past `radius`.
    // The frame's clock comes round again, so one is forgotten a few seconds after it went off.
    const addBlast=(x,y,z,now,radius,strength,speed)=>{
      if(!Number.isFinite(x+y+z+now))return;
      blasts.push({x,y,z,now,radius,strength,speed,until:performance.now()+8000});
      while(blasts.length>FOREST_CONTINUUM_BLASTS)blasts.shift();
      standChanged=true;
    };
    const writeStand=capacity=>{
      const clock=performance.now();
      for(let k=blasts.length-1;k>=0;k--)if(blasts[k].until<clock){blasts.splice(k,1);standChanged=true;}
      if(!standChanged)return;
      standWords.set([activeRootCount,capacity,1,blasts.length],0);
      standFloats.set([shiftX,0,shiftZ,0],4);
      blasts.forEach((b,k)=>standFloats.set([b.x,b.y,b.z,b.now,b.radius,b.strength,b.speed,0],8+k*8));
      device.queue.writeBuffer(standUniform,0,standBytes);standChanged=false;
    };
    let standLayout=null,atlas=null,programs=null,view=null;
    // One scene as large as the roots held: every root may stand in view at once. Made anew when the roots grow.
    const makeScene=()=>{
      const capacity=Math.max(1,Math.min(rootCapacity,Math.floor(Math.min(device.limits.maxStorageBufferBindingSize,device.limits.maxBufferSize)/(CONTINUUM_RECORD_WORDS*4))));
      if(scene?.capacity===capacity){standGroup=standBindGroup();return;}
      if(scene)retire([scene]);
      const {room}=continuumRoom(atlas.types,new Array(atlas.types.length).fill(capacity));
      scene=createContinuumScene({device,atlas,programs,capacity,room,view,poseRoom:capacity*CONTINUUM_WIND_POSE,frame:frameUBO,shadowUniform,samples,label:'forest',written:true});
      scene.setCount(capacity);scene.setWorldOffset(shiftX,shiftZ);
      standGroup=standBindGroup();standChanged=true;
    };
    const standBindGroup=()=>device.createBindGroup({label:'forest stand',layout:standLayout,entries:[
      ...[frameUBO,shadowUniform,roots,atlas.buffer,scene.records,scene.poses,stood,standUniform].map((buffer,binding)=>({binding,resource:{buffer}})),
      {binding:8,resource:continuumGroundView(device)}]});
    // The sections the pack holds, nearest the player first, each whole or not at all: those that fit the device's
    // roots in that order are held, and the first that does not is let go with every one beyond it. An array held
    // before keeps its place in the roots; one let go is zeroed; one new takes the first gap that holds it. When none
    // does, the roots are packed anew on the GPU into a buffer as large as they need, and all bound to the old is bound
    // anew.
    const applySections=sections=>{
      const wanted=[];let total=0,resident=0,released=0;
      for(let k=0;k<sections.length;k++){
        const parts=(sections[k].parts??[]).filter(part=>part?.length>=12);
        const count=parts.reduce((sum,part)=>sum+Math.floor(part.length/12),0);
        if(total+count>deviceCapacity){released=sections.length-k;break;}
        total+=count;resident++;
        for(const part of parts)if(!wanted.includes(part))wanted.push(part);
      }
      const keep=new Set(wanted),encoder=device.createCommandEncoder({label:'forest sections'});
      for(const [part,slab] of slabs)if(!keep.has(part)){
        encoder.clearBuffer(roots,slab.start*48,slab.count*48);
        slabs.delete(part);grids.delete(part);
      }
      const fresh=wanted.filter(part=>!slabs.has(part)),occupied=[...slabs.values()].sort((a,b)=>a.start-b.start),placed=[];
      const gapFor=count=>{
        for(let k=0,at=0;k<=occupied.length;k++){
          const end=k<occupied.length?occupied[k].start:rootCapacity;
          if(end-at>=count)return {at,k};
          if(k<occupied.length)at=occupied[k].start+occupied[k].count;
        }
        return null;
      };
      let fits=Boolean(roots);
      for(const part of fresh){
        if(!fits)break;
        const count=Math.floor(part.length/12),gap=gapFor(count);
        if(!gap){fits=false;break;}
        const slab=slabOf(part,count,gap.at);occupied.splice(gap.k,0,slab);placed.push(slab);
      }
      const previous=[];
      if(!fits){
        // A quarter again what the sections need, so the next to come seldom asks for more.
        const capacity=Math.max(1,rootCapacity,Math.min(deviceCapacity,Math.max(total,pack.maxRootCapacity||0,Math.ceil(total*1.25))));
        const next=rootsBuffer(capacity);let at=0;
        for(const slab of [...slabs.values()].sort((a,b)=>a.start-b.start)){encoder.copyBufferToBuffer(roots,slab.start*48,next,at*48,slab.count*48);slab.start=at;at+=slab.count;}
        previous.push(roots);roots=next;
        rootCapacity=capacity;placed.length=0;
        for(const part of fresh){const count=Math.floor(part.length/12);placed.push(slabOf(part,count,at));at+=count;}
      }
      device.queue.submit([encoder.finish()]);
      retire(previous);
      for(const slab of placed){
        // Trees shot down in an earlier sitting are down before the section is seen.
        if(!charred.has(slab.part)){reapplyForestStrikes(slab.part,slab.count,strikes);charred.add(slab.part);}
        slabs.set(slab.part,slab);
        device.queue.writeBuffer(roots,slab.start*48,slab.part,0,slab.count*12);
      }
      order=wanted;
      let standing=0;activeRootCount=0;
      for(const slab of slabs.values()){standing+=slab.standing;activeRootCount=Math.max(activeRootCount,slab.start+slab.count);}
      standChanged=true;
      if(atlas)makeScene();
      Object.assign(stats,{roots:standing,rootCapacity,sections:{resident,released,arrays:slabs.size}});
    };
    applySections(initialSections);
    async function loadCompressedSurfaces(){
      const materials=m.prototypes.flatMap(p=>p.nativeMaterials);
      const codec=chooseForestSurfaceCodec(device,query.get('forestSurfaces')||'auto');
      stats.surfaces={codec:null,downloadBytes:0,error:null};
      if(!codec)return null;
      let set;
      try{set=await loadForestSurfaceSet({assets:isSubtropicalPack?SUBTROPICAL_FOREST_SURFACE_ASSETS:isCohortPack?PORTUGAL_FOREST_SURFACE_ASSETS:FOREST_SURFACE_ASSETS,materials,codec,signal:abort.signal});}
      catch(error){if(abort.signal.aborted)throw error;stats.surfaces.error=error.message;return null;}
      if(!set){stats.surfaces.error='Prebuilt surfaces do not match this pack\'s maps; rebake with scripts/prepare-forest-surfaces.py';return null;}
      device.pushErrorScope('validation');
      let result=null;
      try{result=createForestSurfaceTextures({device,set,materials});}catch(error){stats.surfaces.error=error.message;}
      const invalid=await device.popErrorScope();
      if(invalid){result?.destroy();stats.surfaces.error=invalid.message;return null;}
      if(result)stats.surfaces={codec,downloadBytes:set.families.reduce((sum,f)=>sum+f.albedo.downloadBytes+f.detail.downloadBytes,0),error:null};
      return result;
    }
    // Prebuilt blocks avoid the map download and the half-float arrays. If they cannot be used, for any reason, the maps can.
    surfaces=await loadCompressedSurfaces();forestLoadAbort(abort.signal);
    if(!surfaces){
      const textures=pack.textures&&Object.keys(pack.textures).length?pack.textures:await pack.loadSurfaces({signal:abort.signal});
      surfaces=await createForestLeafSurfaces({device,shader,pack:{manifest:m,textures}});forestLoadAbort(abort.signal);
    }
    const materials=make(surfaces.optics,B.STORAGE,'forest material optics');
    stats.materialLayers=surfaces.layers;stats.textureFamilies=surfaces.families.map(f=>({width:f.width,height:f.height,layers:f.rows.length,mipLevels:f.levels}));
    // The GPU holds the surfaces now; the pack lets go of its maps.
    pack.releaseSurfaces?.();
    let standModule;
    [atlas,programs,view,standModule]=await ready;forestLoadAbort(abort.signal);
    // A pack's atlas is its own: one type a prototype, in its order, named for it.
    const names=m.prototypes.map(p=>`${p.species}${p.cohort?`-${p.cohort}`:''}`),types=atlas.manifest.types;
    if(types.length!==P||types.some((type,id)=>type.name!==names[id]))throw Error(`The forest continuum atlas is not this pack's (${types.map(t=>t.name)} for ${names}): rebake it with scripts/prepare-forest-continuum.mjs`);
    const firstLayers=[];let layer=0;for(const p of m.prototypes){firstLayers.push(layer);layer+=p.nativeMaterials.length;}
    const C=GPUShaderStage.COMPUTE,entry=(binding,type)=>({binding,visibility:C,buffer:{type}});
    standLayout=device.createBindGroupLayout({label:'forest stand',entries:[entry(0,'uniform'),entry(1,'uniform'),entry(2,'read-only-storage'),entry(3,'read-only-storage'),entry(4,'storage'),entry(5,'storage'),entry(6,'storage'),entry(7,'uniform'),
      {binding:8,visibility:C,texture:{sampleType:'unfilterable-float',viewDimension:'2d-array'}}]});
    const standPipelineLayout=device.createPipelineLayout({label:'forest stand',bindGroupLayouts:[standLayout]});
    const [standReset,standRoots,standFinish]=await Promise.all(['forestStandReset','forestStandRoots','forestStandFinish'].map(entryPoint=>
      device.createComputePipelineAsync({label:`forest ${entryPoint}`,layout:standPipelineLayout,compute:{module:standModule,entryPoint}})));
    forestLoadAbort(abort.signal);
    makeScene();
    // The view's groups: the land's scene (its frame, sky, light and shadow map), the clouds, and the pack's maps.
    const sceneIds=[0,1,2,3,4,5,6,19,20,21];
    const sceneGroup=device.createBindGroup({label:'forest scene',layout:view.pipeline.getBindGroupLayout(0),entries:resources.filter(([i])=>sceneIds.includes(i)).map(([binding,resource])=>({binding,resource}))});
    const cloudGroup=clouds.bindVolume(view.pipeline);
    const surfaceEntries=[];
    for(let family=0;family<4;family++){
      const texture=surfaces.families[family]??surfaces.families[0];
      surfaceEntries.push({binding:family*2,resource:texture.albedo.createView({dimension:'2d-array'})},{binding:family*2+1,resource:texture.normal.createView({dimension:'2d-array'})});
    }
    // The same surfaces cut its leaves' shadows (the forest material's shadow, its group 2).
    const surfaceOwn=[...surfaceEntries,{binding:8,resource:nativeSampler},{binding:9,resource:nativeRepeatSampler},{binding:10,resource:{buffer:materials}}];
    const surfaceGroup=device.createBindGroup({label:'forest surfaces',layout:view.pipeline.getBindGroupLayout(3),entries:surfaceOwn});
    const continuumStats=atlas.manifest.totals;
    stats.continuum={types:continuumStats.types,clusters:continuumStats.clusters,vertices:continuumStats.vertices,atlasBytes:atlas.words.byteLength,firstLayers};
    // A ball finds its trees through these: one grid an array, built off the frame one after another, nearest
    // first, each serving as soon as it is ready; an array let go takes its grid with it.
    // A pack's trees are struck as the wood measured for their species (js/forest-trunk-shapes.js). Full-grown trees are
    // not the size of the trees measured, so for them that wood is made as tall as each kind of tree and as stout in the trunk.
    let trunkGrid=null,trunkBuild=0;
    const publishTrunks=()=>{
      const list=order.map(part=>grids.get(part)).filter(Boolean);
      trunkGrid=list.length?{grids:list,trees:list.reduce((sum,grid)=>sum+grid.trees,0)}:null;
    };
    const rebuildTrunks=async()=>{
      const build=++trunkBuild;publishTrunks();
      try{
        for(const part of order){
          const slab=slabs.get(part);
          if(!slab||grids.has(part))continue;
          const grid=await buildForestTrunkGridAsync(part,slab.count,trunkShapes,{isCancelled:()=>destroyed||build!==trunkBuild||!slabs.has(part)});
          if(destroyed||build!==trunkBuild)return;
          if(grid&&slabs.has(part)){grids.set(part,grid);publishTrunks();}
        }
      }catch(error){console.error('Forest trunk grid failed',error);}
    };
    const trunksReady=rebuildTrunks();
    const writeRoot=(slab,index)=>{if(slabs.get(slab.part)===slab)device.queue.writeBuffer(roots,(slab.start+index)*48,slab.part,index*12,12);};
    // A tree coming down whips the trees it falls through, along the line it falls.
    const noteFall=(slab,index,now)=>{
      const live=slab.part,at=index*12;
      const fx=live[at],fy=live[at+1],fz=live[at+2],fScale=Math.max(0.5,live[at+3]);
      falling.push({x:fx,z:fz,now,part:live,index});
      const proto=m.prototypes[live[at+8]|0]??m.prototypes[0];
      const code=(live[at+9]|0)>>>0;
      const fallAng=(((code>>>11)&(FOREST_FALL_BEARINGS-1))/FOREST_FALL_BEARINGS)*Math.PI*2;
      const reach=Math.max(4,(proto?.high?.[1]??16)*fScale*0.88);
      addBlast(fx+Math.cos(fallAng)*reach*0.55,fy+3.5,fz+Math.sin(fallAng)*reach*0.55,now,reach*1.15,0.8,FOREST_FALL_SECONDS+0.8);
    };
    // The arrays whose ground reaches within this of a point.
    const slabsNear=(x,z,reach)=>[...slabs.values()].filter(s=>x>=s.minX-reach&&x<=s.maxX+reach&&z>=s.minZ-reach&&z<=s.maxZ+reach);
    // The root a ball's grid named: in the array it named while that is held, or the root standing where it stood.
    const liveRoot=hit=>{
      const slab=slabs.get(hit.roots);
      if(slab&&hit.rootIndex<slab.count)return {slab,index:hit.rootIndex};
      for(const near of slabsNear(hit.x,hit.z,0))for(let i=0;i<near.count;i++)if(near.part[i*12]===hit.x&&near.part[i*12+2]===hit.z)return {slab:near,index:i};
      return null;
    };
    const saveStrikes=()=>{onStrikesChanged?.(forestStrikesToSave(strikes,strikeOrigin));};
    const release=()=>{destroyed=true;abort.abort();for(const b of allocated)b.destroy();roots?.destroy();scene?.destroy();surfaces?.destroy();};
    return {stats,trunksReady,
      get trunks(){return trunkGrid;},
      updatePack(nextPack){
        if(destroyed||!nextPack?.manifest)return;
        applySections(forestPackSections(nextPack));
        rebuildTrunks();
      },
      // A blast close by, with no ball in the tree: the nearest takes it, and surrounding trees whip in the shockwave.
      strike(x,z,now=0,groundAt=null){
        if(destroyed)return;
        const gy=groundAt?groundAt(x,z):0;
        addBlast(x,(Number.isFinite(gy)?gy:0)+2.4,z,now,34,1.6,280);
        let slab=null,index=-1,distance=Infinity;
        for(const near of slabsNear(x,z,TREE_STRIKE_REACH_M)){
          const found=nearestForestRoot(near.part,near.count,x,z);
          if(found.index>=0&&found.distance<distance){slab=near;index=found.index;distance=found.distance;}
        }
        if(!slab)return;
        blastForestRoot(slab.part,index,x,z,strikes,{now,groundAt,shapeOf:id=>trunkShapes[id]});
        writeRoot(slab,index);saveStrikes();
        if(slab.part[index*12+11]<0)noteFall(slab,index,now);
      },
      // A ball in this tree. Only this root's 48 bytes go to the GPU, and only now.
      strikeTree(hit,impact,now=0,groundAt=null){
        if(destroyed)return null;
        const hx=hit.x??0,hz=hit.z??0,hy=(groundAt?groundAt(hx,hz):0)+(hit.height??3);
        addBlast(hx,Number.isFinite(hy)?hy:3,hz,now,26,1.1,290);
        const found=liveRoot(hit);if(!found)return null;
        const {slab,index}=found;
        const result=strikeForestTree(slab.part,index,trunkShapes[slab.part[index*12+8]|0],{...impact,height:hit.height,onTrunk:hit.onTrunk,now,groundAt},strikes);
        if(!result)return null;
        writeRoot(slab,index);saveStrikes();
        if(result.felled)noteFall(slab,index,now);
        return result;
      },
      // Once a tree is down it stays down, whatever the clock does: it wraps every ten minutes. A tree whose section
      // was let go meanwhile lies down in its array, and comes back so.
      settleFalls(now){
        for(let f=falling.length-1;f>=0;f--){
          const fall=falling[f],age=now-fall.now;
          if(age>=0&&age<FOREST_FALL_SECONDS+.1)continue;
          falling.splice(f,1);
          const at=fall.index*12;
          if(fall.part[at]!==fall.x||fall.part[at+2]!==fall.z)continue;
          fall.part[at+11]=FOREST_LONG_FALLEN;
          const slab=slabs.get(fall.part);if(slab)writeRoot(slab,fall.index);
        }
      },
      // Where the scene's frame lies in the world's (js/terrain.js setWorldOffset).
      setWorldOffset(x=0,z=0){
        if(destroyed||(x===shiftX&&z===shiftZ))return;
        shiftX=x;shiftZ=z;standChanged=true;scene.setWorldOffset(x,z);
      },
      // In the frame's compute pass: every root stood, then the one cut over what was stood.
      encode(pass){
        if(destroyed)return;
        writeStand(scene.capacity);
        pass.setBindGroup(0,standGroup);
        pass.setPipeline(standReset);pass.dispatchWorkgroups(1);
        if(activeRootCount){const groups=Math.ceil(activeRootCount/64);pass.setPipeline(standRoots);pass.dispatchWorkgroups(Math.min(groups,65535),Math.ceil(groups/65535));}
        pass.setPipeline(standFinish);pass.dispatchWorkgroups(CONTINUUM_ROW/64);
        scene.encode(pass,{buffer:stood});
      },
      draw(pass){if(destroyed)return;pass.setBindGroup(3,surfaceGroup);scene.draw(pass,sceneGroup,cloudGroup);},
      drawShadow(pass){if(!destroyed)scene.drawShadow(pass,{own:surfaceOwn});},
      // The indirect draws the view submits, for the continuum census (js/continuum-census.js).
      continuumDraws(){return destroyed?[]:scene.continuumDraws();},
      destroy:release};
  }catch(error){destroyed=true;abort.abort();for(const b of allocated)b.destroy();roots?.destroy();scene?.destroy();surfaces?.destroy();throw error;}
}

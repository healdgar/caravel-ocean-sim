// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Grown temperate specimens are authored visual proxies, not surveyed Saba flora.
// A pack's trees are drawn through the one continuum alone (AGENTS.md rule 3): each tree's cluster cut near
// (js/forest-clusters.js), its progressive crown far and its splat at the horizon (js/forest-crowns.js). This
// module places the roots, culls them once on the GPU into one visible list a species, and shades bark and leaves.
import {createForestTerrainOcclusion,withForestTerrainOcclusion} from './forest-occlusion.js';
import {FRAME_WGSL} from './wgsl/common.js';
import {createTaskYieldBudget} from './task-yield.js';
import {loadForestClusters,createForestClusters,FOREST_CLUSTER_ASSETS,SUBTROPICAL_FOREST_CLUSTER_ASSETS,PORTUGAL_FOREST_CLUSTER_ASSETS,FOREST_CLUSTER_VERTEX_WGSL,FOREST_CLUSTER_SHADOW_WGSL} from './forest-clusters.js';
import {loadForestCrowns,FOREST_CROWN_ASSETS,SUBTROPICAL_FOREST_CROWN_ASSETS,PORTUGAL_FOREST_CROWN_ASSETS,FOREST_CROWN_SPLAT_PIXELS,FOREST_CROWN_MIN_PIXELS} from './forest-crowns.js';
import {loadForestWind,createForestWind,FOREST_WIND_ASSETS,SUBTROPICAL_FOREST_WIND_ASSETS,PORTUGAL_FOREST_WIND_ASSETS,FOREST_WIND_BASIS_RADIAL,FOREST_WIND_EVENT_FRIEDLANDER,FOREST_WIND_EVENT_PULSE} from './forest-wind.js';
import {FOREST_FALL_BEARINGS,FOREST_FALL_HEIGHT_STEPS,FOREST_FALL_REST_MIN_DEG,FOREST_FALL_SECONDS,FOREST_LONG_FALLEN,FOREST_WOUND_BEARINGS,buildForestTrunkGridAsync,forestStrikesFromSave,forestStrikesToSave,forestTrunkShape,reapplyForestStrikes,strikeForestRoot,strikeForestTree} from './forest-trunks.js';
import {FOREST_SURFACE_ASSETS,SUBTROPICAL_FOREST_SURFACE_ASSETS,PORTUGAL_FOREST_SURFACE_ASSETS,chooseForestSurfaceCodec,createForestSurfaceTextures,forestMaterialOptics,loadForestSurfaceSet} from './forest-surfaces.js';

// What the game fetches of a pack: its manifest, its roots, and the maps a device without block compression
// builds its surfaces from. The pack's own vertex and index streams are the bake source of its clusters and
// crowns (scripts/prepare-forest-clusters.mjs) and stay on disk.
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

const ROOT_WGSL=/* wgsl */`
struct ForestRoot {rootScale:vec4f,yawColour:vec4f,identity:vec4f};
`;
// What every tree's clusters and crowns are placed and shaded through (js/forest-clusters.js, js/forest-crowns.js).
export const FOREST_VERTEX_WGSL=ROOT_WGSL+/* wgsl */`
@group(2)@binding(0)var<storage,read>forestRoots:array<ForestRoot>;
@group(2)@binding(2)var<uniform>forestBin:vec4u;
struct ForestLeafMaterial {optics:vec4f,underside:vec4f,coordinates:vec4f};
@group(2)@binding(3)var forestNativeAlbedo0:texture_2d_array<f32>;
@group(2)@binding(4)var forestNativeNormal0:texture_2d_array<f32>;
@group(2)@binding(5)var forestNativeSampler:sampler;
@group(2)@binding(6)var<storage,read>forestNativeMaterials:array<ForestLeafMaterial>;
@group(2)@binding(7)var forestNativeAlbedo1:texture_2d_array<f32>;
@group(2)@binding(8)var forestNativeNormal1:texture_2d_array<f32>;
@group(2)@binding(9)var forestNativeAlbedo2:texture_2d_array<f32>;
@group(2)@binding(10)var forestNativeNormal2:texture_2d_array<f32>;
@group(2)@binding(11)var forestNativeAlbedo3:texture_2d_array<f32>;
@group(2)@binding(12)var forestNativeNormal3:texture_2d_array<f32>;
@group(2)@binding(13)var forestNativeRepeatSampler:sampler;
struct ForestVertex {
 @invariant @builtin(position)pos:vec4f,@location(0)world:vec3f,@location(1)normal:vec3f,
 @location(2)kind:vec2f,@location(3)leafUV:vec2f,@location(4)colour:vec3f,
 @location(5)@interpolate(flat)nativeMaterial:i32,
 // The share of each pixel that the tree's far crown has taken from its leaves (js/forest-crowns.js).
 @location(6)@interpolate(flat)crownFade:f32,
 // The light the tree's own canopy lets through to this vertex, baked into its cluster (scripts/prepare-forest-clusters.mjs).
 @location(7)canopyAO:f32,
 @location(8)@interpolate(flat)coverageSeed:u32,
};
// The continuum's own hash (js/continuum-core.js), which the land's module carries once for every family in it.
fn forestCoverageHash(value:u32)->u32{return continuumHash(value);}
fn forestLeafSampleMask(alpha:f32,seed:u32,pixel:vec2f)->u32{
 let samples=select(4u,forestBin.w,forestBin.w>0u);let p=vec2u(pixel);
 let random=forestCoverageHash(seed^forestCoverageHash(p.x)^forestCoverageHash(p.y*0x9e3779b9u));
 let coverage=clamp(alpha,0.,1.)*f32(samples);let whole=u32(floor(coverage));
 let count=min(samples,whole+select(0u,1u,fract(coverage)>f32(random&65535u)/65536.));
 let bits=(1u<<count)-1u;let rotation=(random>>16u)%samples;
 return ((bits<<rotation)|(bits>>(samples-rotation)))&((1u<<samples)-1u);
}
// The samples of a pixel that a tree's far crown takes while it comes in over its own leaves: the continuum's
// one split (continuumSamples) with seed 0, the forest's own pattern. The crown draws these and the leaves give
// exactly these up, so between them each sample is drawn once and the change needs no blending.
fn forestCrownSamples(share:f32,pixel:vec2f)->u32{return continuumSamples(share,pixel,select(4u,forestBin.w,forestBin.w>0u),0u);}
// Three motions at three speeds. The whole tree bends with height, branches bob by their reach from
// the trunk, and leaves flutter. Gust fronts roll downwind across the forest at the wind's own speed.
// The wind's own simulation (js/forest-wind.js) replaces this where it runs.
fn forestWind(r:ForestRoot,local:vec3f,model:vec3f,flutterWeight:f32)->vec3f{
 let speed=F.windP[0].z;if(speed<=.05){return vec3f(0);}
 let collarPin=select(smoothstep(0.22,1.05,model.y),1.0,flutterWeight>0.);
 if(collarPin<=0.){return vec3f(0);}
 let downwind=F.windP[0].xy;let t=F.camPos.w;
 let front=(dot(r.rootScale.xz,downwind)-t*speed)*.035;
 let across=dot(r.rootScale.xz,vec2f(-downwind.y,downwind.x))*.02;
 let gust=.55+.3*sin(front)+.15*sin(front*2.7+across);
 let strength=clamp(speed/14.,0.,1.6)*gust;
 let phase=r.rootScale.x*.13+r.rootScale.z*.11;
 let bend=strength*.0016*local.y*local.y*(.65+.35*sin(t*1.1+phase));
 let reach=length(local.xz);
 let bob=strength*.045*reach*sin(t*2.3+phase+dot(model,vec3f(.7,.5,.6)));
 let flutter=strength*.03*flutterWeight*sin(t*9.+dot(model,vec3f(7.1,5.3,6.7)));
 return vec3f(downwind.x*(bend+bob+flutter),(bob+flutter)*.6,downwind.y*(bend+bob+flutter))*collarPin;
}
fn forestGroundRoot(posIn:vec3f,kindVal:f32)->vec3f{
 if(kindVal>=3.5){return posIn;}
 var pos=posIn;
 let rHoriz=length(pos.xz);
 let flareEnv=0.32+0.14*min(rHoriz,4.0)-0.46*smoothstep(1.15,2.6,rHoriz);
 if(pos.y<flareEnv+0.04&&(rHoriz>0.18||pos.y<0.02)){
  let wEnv=1.0-smoothstep(flareEnv-0.08,flareEnv+0.04,pos.y);
  let wRad=max(smoothstep(0.18,0.22,rHoriz),1.0-smoothstep(-0.01,0.02,pos.y));
  let w=wEnv*wRad;
  if(rHoriz>0.20){
   let rOut=0.20+0.52*(1.0-exp(-(rHoriz-0.20)/0.52));
   let k=mix(1.0,rOut/max(rHoriz,1e-5),w);
   pos.x*=k;pos.z*=k;
  }
  let dr=max(0.0,rHoriz-0.18);
  let py=max(-2.2,pos.y-(1.35*dr+0.45*min(dr*dr,4.0)));
  pos.y=mix(pos.y,py,w);
 }
 return pos;
}
// What shot has done to this tree, from its root (js/forest-trunks.js). JavaScript writes it only when a ball lands.
fn forestFallTurn(r:ForestRoot,code:u32)->vec2f{
 let rest=(${FOREST_FALL_REST_MIN_DEG}.+f32(code>>18u))*.01745329;var angle=rest;
 let age=F.camPos.w+r.identity.w;
 if(r.identity.w>-1e8&&age>=0.){let e=min(age/${FOREST_FALL_SECONDS},1.);angle=rest*e*e;}
 return vec2f(sin(angle),cos(angle));
}
// Turns about the level line across the fall, so that up goes towards the bearing.
fn forestFallRotate(v:vec3f,bearing:vec2f,turn:vec2f)->vec3f{
 let along=v.x*bearing.x+v.z*bearing.y;let reach=along*turn.y+v.y*turn.x;
 return vec3f(v.x-bearing.x*along+bearing.x*reach,v.y*turn.y-along*turn.x,v.z-bearing.y*along+bearing.y*reach);
}
fn forestFallBearing(code:u32)->vec2f{let a=f32((code>>11u)&${FOREST_FALL_BEARINGS-1}u)/${FOREST_FALL_BEARINGS}.*6.2831853;return vec2f(cos(a),sin(a));}
struct ForestStruck {local:vec3f,normal:vec3f,colour:vec3f,fallen:bool};
fn forestStruckPlace(r:ForestRoot,model:vec3f,local:vec3f,normal:vec3f,colour:vec3f,isWood:bool)->ForestStruck{
 var o:ForestStruck;o.local=local;o.normal=normal;o.colour=colour;o.fallen=false;
 let paleWood=colour*vec3f(2.7,2.2,1.5)+vec3f(.07,.055,.03);
 if(r.identity.w<0.){
  // Snapped at the height it was struck: the stump stays, and what is above comes down.
  let code=u32(r.identity.y);let height=f32(code&2047u)/${FOREST_FALL_HEIGHT_STEPS}.;
  if(isWood){o.colour=mix(colour,paleWood,1.-smoothstep(0.,.7,abs(model.y-height)));}
  if(model.y>height){
   let bearing=forestFallBearing(code);let turn=forestFallTurn(r,code);let hinge=vec3f(0.,height*r.rootScale.w,0.);
   o.local=hinge+forestFallRotate(local-hinge,bearing,turn);o.normal=forestFallRotate(normal,bearing,turn);o.fallen=true;
  }
  return o;
 }
 if(isWood){
  // A gouge on the side the ball came from, its raw wood showing.
  let code=u32(r.identity.w);let height=f32(code&2047u)/${FOREST_FALL_HEIGHT_STEPS}.;let severity=f32(code>>17u)/127.;
  let along=abs(model.y-height)/(.6+.6*severity);
  if(along<1.){
   let a=f32((code>>11u)&${FOREST_WOUND_BEARINGS-1}u)/${FOREST_WOUND_BEARINGS}.*6.2831853;
   // The trunk alone: a limb that happens to leave it at this height is whole.
   let facing=smoothstep(-.6,.5,-dot(normal.xz,vec2f(cos(a),sin(a))));let mark=(1.-along*along)*facing*(1.-smoothstep(.9,1.25,length(model.xz)));
   o.local=local-normal*mark*(.03+.09*severity)*r.rootScale.w;o.colour=mix(colour,paleWood,mark);
  }
 }
 return o;
}
fn forestPlaceSkinned(r:ForestRoot,rootId:u32,posLocal:vec3f,normAdj:vec3f,kind:vec2f,leafUV:vec2f,colour:vec3f,nativeMaterial:f32,vertex:u32,canopyAO:f32,alreadySkinned:bool)->ForestVertex{
 let c=cos(r.yawColour.x);let s=sin(r.yawColour.x);
 let posAdj=posLocal;
 var local=vec3f(c*posAdj.x-s*posAdj.z,posAdj.y,s*posAdj.x+c*posAdj.z)*r.rootScale.w;
 if(!alreadySkinned){
  let flutterWeight=select(0.,clamp(leafUV.x,0.,1.),kind.x>=3.5&&nativeMaterial>=0.);
  local+=forestWind(r,local,posAdj,flutterWeight);
 }
 var o:ForestVertex;
 o.normal=vec3f(c*normAdj.x-s*normAdj.z,normAdj.y,s*normAdj.x+c*normAdj.z);
 let baseCol=select(colour,vec3f(1.),nativeMaterial>=0.);
 var tint=baseCol*r.yawColour.yzw;var fallen=false;
 if(r.identity.w!=0.){let struck=forestStruckPlace(r,posAdj,local,o.normal,tint,kind.x<3.5);local=struck.local;o.normal=struck.normal;tint=struck.colour;fallen=struck.fallen;}
 o.world=r.rootScale.xyz+local;
 if(!fallen&&kind.x>=3.5){o.world.y=max(o.world.y,r.rootScale.y);}
 o.nativeMaterial=i32(nativeMaterial);if(o.nativeMaterial>=0){o.nativeMaterial+=i32(forestBin.y);}
 o.kind=kind;o.leafUV=leafUV;o.colour=tint;o.canopyAO=canopyAO;o.coverageSeed=forestCoverageHash(vertex^(rootId*0x9e3779b9u));o.pos=F.viewProj*vec4f(earthCurve(o.world-F.camPos.xyz,F.camPos.y),1);return o;
}
fn forestNativeLinear(c:vec3f)->vec3f{
 return select(pow((c+vec3f(.055))/1.055,vec3f(2.4)),c/12.92,c<=vec3f(.04045));
}
struct ForestSurface {pigment:vec4f,detail:vec4f};
// A leaf's own colour from what the textures keep, which is that colour times coverage. Where coverage
// nears nothing the two are noise over noise: BC7 and ASTC blocks, and rounding to eight bits, leave a
// little colour over a coverage of zero, and dividing by zero then gives one sample a value at the top
// of the half-float range. Below the floor the colour fades to black instead of growing, and a surface
// has no colour above one anyway. Only the stochastic edge of a leaf is ever this thin.
const FOREST_THINNEST_COVERAGE=1./32.;
fn forestOwnColour(pigment:vec4f)->vec3f{return min(pigment.rgb/max(pigment.a,FOREST_THINNEST_COVERAGE),vec3f(1));}
fn forestDetailSigned(d:vec4f)->vec4f{return vec4f(d.xyz*(255./127.)-vec3f(128./127.),d.a);}
fn forestNativePair(albedo:texture_2d_array<f32>,normal:texture_2d_array<f32>,uv:vec2f,ux:vec2f,uy:vec2f,layer:i32,repeating:bool)->ForestSurface{
 var result:ForestSurface;
 if(repeating){result.pigment=textureSampleGrad(albedo,forestNativeRepeatSampler,uv,layer,ux,uy);result.detail=textureSampleGrad(normal,forestNativeRepeatSampler,uv,layer,ux,uy);}
 else{result.pigment=textureSampleGrad(albedo,forestNativeSampler,uv,layer,ux,uy);result.detail=textureSampleGrad(normal,forestNativeSampler,uv,layer,ux,uy);}
 result.detail=forestDetailSigned(result.detail);
 return result;
}
fn forestReadNative(material:ForestLeafMaterial,uv:vec2f,ux:vec2f,uy:vec2f)->ForestSurface{
 let family=u32(material.coordinates.x);let layer=i32(material.coordinates.y);let repeating=material.coordinates.z>0.;
 if(family==0u){return forestNativePair(forestNativeAlbedo0,forestNativeNormal0,uv,ux,uy,layer,repeating);}
 if(family==1u){return forestNativePair(forestNativeAlbedo1,forestNativeNormal1,uv,ux,uy,layer,repeating);}
 if(family==2u){return forestNativePair(forestNativeAlbedo2,forestNativeNormal2,uv,ux,uy,layer,repeating);}
 return forestNativePair(forestNativeAlbedo3,forestNativeNormal3,uv,ux,uy,layer,repeating);
}
fn forestNativeAlbedoOnly(material:ForestLeafMaterial,uv:vec2f,ux:vec2f,uy:vec2f)->vec4f{
 let family=u32(material.coordinates.x);let layer=i32(material.coordinates.y);let repeating=material.coordinates.z>0.;
 if(repeating){
  if(family==0u){return textureSampleGrad(forestNativeAlbedo0,forestNativeRepeatSampler,uv,layer,ux,uy);}
  if(family==1u){return textureSampleGrad(forestNativeAlbedo1,forestNativeRepeatSampler,uv,layer,ux,uy);}
  if(family==2u){return textureSampleGrad(forestNativeAlbedo2,forestNativeRepeatSampler,uv,layer,ux,uy);}
  return textureSampleGrad(forestNativeAlbedo3,forestNativeRepeatSampler,uv,layer,ux,uy);
 }
 if(family==0u){return textureSampleGrad(forestNativeAlbedo0,forestNativeSampler,uv,layer,ux,uy);}
 if(family==1u){return textureSampleGrad(forestNativeAlbedo1,forestNativeSampler,uv,layer,ux,uy);}
 if(family==2u){return textureSampleGrad(forestNativeAlbedo2,forestNativeSampler,uv,layer,ux,uy);}
 return textureSampleGrad(forestNativeAlbedo3,forestNativeSampler,uv,layer,ux,uy);
}
fn forestMappedNormal(geometric:vec3f,detail:vec3f,dx:vec3f,dy:vec3f,ux:vec2f,uy:vec2f)->vec3f{
 let determinant=ux.x*uy.y-ux.y*uy.x;
 let direction=select(-1.,1.,determinant>=0.);
 let tangent=dx*uy.y-dy*ux.y;let bitangent=dy*ux.x-dx*uy.x;
 var n=geometric;
 if(abs(determinant)>1e-12&&dot(tangent,tangent)>1e-16&&dot(bitangent,bitangent)>1e-16&&dot(detail,detail)>1e-16){
   let t=normalize(tangent)*direction;let b=normalize(bitangent)*direction;
   let sampled=normalize(detail);n=normalize(t*sampled.x+b*sampled.y+geometric*sampled.z);
 }
 return n;
}
@fragment fn forestNativeOpaqueFS(in:ForestVertex,@builtin(front_facing)front:bool)->@location(0)vec4f{
 let dx=dpdx(in.world);let dy=dpdy(in.world);let ux=dpdx(in.leafUV);let uy=dpdy(in.leafUV);
 let geometric=normalize(in.normal);let exposure=clamp(in.kind.y,0.,1.);
 let material=forestNativeMaterials[u32(in.nativeMaterial)];
 let surface=forestReadNative(material,in.leafUV,ux,uy);
 var colour=forestOwnColour(surface.pigment)*in.colour;
 let barkViewDist=1./max(in.pos.w,1e-6);
 let barkClose=1.-smoothstep(8.,32.,barkViewDist);
 var detailVec=surface.detail.xyz*vec3f(1.25+0.35*barkClose,1.25+0.35*barkClose,1.0);
 if(barkClose>0.001){
  let grainU=in.leafUV.x*46.0+sin(in.leafUV.y*9.5)*1.4;
  let grainV=in.leafUV.y*18.0;
  let fissure=sin(grainU)*0.65+sin(grainU*2.3+grainV*0.7)*0.35;
  let plate=cos(grainU)*0.65+cos(grainU*2.3+grainV*0.7)*0.35;
  detailVec.x+=plate*0.18*barkClose;
  detailVec.y+=sin(grainV*2.1+grainU*0.4)*0.08*barkClose;
  colour*=1.0+fissure*0.055*barkClose;
 }
 let n=forestMappedNormal(geometric,detailVec,dx,dy,ux,uy)*select(-1.,1.,front);
 let roughness=clamp(surface.detail.a/max(surface.pigment.a,FOREST_THINNEST_COVERAGE),0.22,0.98);
 let barkWet=clamp(material.coordinates.w*(1.0-roughness),0.0,0.28);
 // Static escape through this specimen's original leaf-area field. Terrain
 // and cloud shadows remain dynamic in landFinish; this is not a sun shadow.
 let woodAO=min(in.canopyAO,select(1.0,mix(0.30,1.0,exposure),in.canopyAO>0.995&&exposure<0.995));
 return landFinish(in.world,n,colour,max(dot(n,F.sunDir.xyz),0.)*(.35+.65*woodAO),(.36+max(n.y,0.)*.25)*woodAO,barkWet,roughness);
}
fn forestNativeAlpha(material:ForestLeafMaterial,uv:vec2f,ux:vec2f,uy:vec2f)->f32{
 return forestNativeAlbedoOnly(material,uv,ux,uy).a;
}
fn forestBotanicalDetail(uv:vec2f,viewDist:f32,rawAlpha:f32)->vec4f{
 let detailW=1.-smoothstep(10.,38.,viewDist);
 if(detailW<=.001||rawAlpha<=.04){return vec4f(rawAlpha,0.,0.,0.);}
 // Preserve the true high-res botanical spray alpha silhouette cleanly without cookie-cutter perforation,
 // adding only subtle pinnate venation normal relief and cuticle/chlorophyll micro-variation inside leaves.
 let edgeSharp=smoothstep(.24,.76,rawAlpha);
 let crispAlpha=mix(rawAlpha,edgeSharp,detailW*.24);
 let interior=smoothstep(.20,.65,rawAlpha)*detailW;
 let chevronU=uv.x*22.0-abs(uv.y-.5)*14.0;
 let secVein=sin(chevronU)*exp(-abs(fract(chevronU*.1591549)-.5)*3.2);
 let fineNet=sin(uv.x*68.0+uv.y*44.0)*cos(uv.x*41.0-uv.y*63.0);
 let sideSign=select(-1.,1.,uv.y>=.5);
 let veinX=(secVein*.16+fineNet*.045)*interior;
 let veinY=(cos(chevronU)*sideSign*.14+fineNet*.045)*interior;
 let dapple=(sin(uv.x*11.3+uv.y*7.9)*.55+cos(uv.x*19.7-uv.y*15.1)*.45)*interior;
 return vec4f(crispAlpha,veinX,veinY,dapple);
}
// Leaf coverage lays depth first, through every layer of a crown. Shading then lights only
// the leaves in front, and each sample's depth test decides which of them it shows.
struct ForestLeafCoverage {@location(0)colour:vec4f,@builtin(sample_mask)mask:u32};
@fragment fn forestNativeLeafDepthFS(in:ForestVertex)->ForestLeafCoverage{
 // Nearby leaves read coverage half a level finer, which shows their shapes. It ends before the far
 // canopy, whose look depends on the plain average. The mean coverage read is the same either way.
 // Position's w is one over view depth; a world position here would be one more value per vertex.
 let viewDist=1./max(in.pos.w,1e-6);
 let near=mix(.7,1.,smoothstep(30.,90.,viewDist));
 let rawAlpha=forestNativeAlpha(forestNativeMaterials[u32(in.nativeMaterial)],in.leafUV,dpdx(in.leafUV)*near,dpdy(in.leafUV)*near);
 let bot=forestBotanicalDetail(in.leafUV,viewDist,rawAlpha);
 let crispRaw=select(rawAlpha,bot.x,viewDist<38.);
 let alpha=clamp(crispRaw*mix(1.,2.25,smoothstep(45.,220.,viewDist)),0.,1.);
 // Independent native leaf footprints must not all select identical hardware
 // sample bits at small projected sizes. Stable per-primitive/root masks keep
 // expected filtered source coverage, including sub-sample fractions. This is
 // independent-footprint integration, not recovery of correlated source masks.
 var o:ForestLeafCoverage;o.colour=vec4f(0);o.mask=forestLeafSampleMask(alpha,in.coverageSeed,in.pos.xy)&~forestCrownSamples(in.crownFade,in.pos.xy);return o;
}
@fragment fn forestNativeLeafFS(in:ForestVertex,@builtin(front_facing)front:bool)->@location(0)vec4f{
 let material=forestNativeMaterials[u32(in.nativeMaterial)];
 let ux=dpdx(in.leafUV);let uy=dpdy(in.leafUV);
 let viewDist=1./max(in.pos.w,1e-6);
 let dx=dpdx(in.world);let dy=dpdy(in.world);
 let surface=forestReadNative(material,in.leafUV,ux,uy);let pigment=surface.pigment;
 var colour=forestOwnColour(pigment)*in.colour;
 let uvOff=in.leafUV-vec2f(.5,.5);
 let frondCurve=vec3f(uvOff.x*0.06,uvOff.y*0.05,0.0);
 let mappedN=forestMappedNormal(normalize(in.normal),surface.detail.xyz*vec3f(1.35,1.35,1.0),dx,dy,ux,uy)*select(-1.,1.,front);
 var n=normalize(mappedN+frondCurve);
 var rawRough=surface.detail.a/max(pigment.a,FOREST_THINNEST_COVERAGE);
 if(viewDist<38.){
  let bot=forestBotanicalDetail(in.leafUV,viewDist,pigment.a);
  let tDir=normalize(dx+vec3f(1e-5,0.,0.));let bDir=normalize(dy+vec3f(0.,0.,1e-5));
  n=normalize(n+(tDir*bot.y+bDir*bot.z)*0.28);
  let leafVar=bot.w;
  colour*=vec3f(1.+leafVar*.07,1.+leafVar*.10,1.-leafVar*.05);
  rawRough=clamp(rawRough-leafVar*.08,0.22,0.92);
 }
 if(!front){colour=mix(colour,forestNativeLinear(material.underside.rgb)*in.colour,material.optics.y);}
 let exposure=clamp(in.kind.y,0.,1.);let nDotL=dot(n,F.sunDir.xyz);
 let backlit=max(-nDotL,0.)*material.optics.z;
 colour=colour*mix(vec3f(1.0),vec3f(1.12,1.18,0.72),backlit*exposure);
 let diffuse=(max(nDotL,0.)+backlit)*(.22+.78*exposure*exposure)*(.35+.65*in.canopyAO);
 let ambient=(.12+exposure*.56+abs(n.y)*.09)*in.canopyAO;
 let roughness=clamp(rawRough,0.24,0.92);
 let cuticleWet=clamp((1.0-roughness)*0.42*(0.35+0.65*exposure),0.0,0.36);
 let lit=landFinish(in.world,n,colour,diffuse,ambient,cuticleWet,roughness);
 return vec4f(lit.rgb,pigment.a);
}
`+FOREST_CLUSTER_VERTEX_WGSL;
// The land shadow map takes each tree's own cluster cut against the light's box (js/forest-clusters.js).
export const FOREST_SHADOW_WGSL=FOREST_CLUSTER_SHADOW_WGSL;
// One pass over the roots a frame: every tree in view goes on its species' one visible list, however far
// off; no tree is ever handed to another surface. Nothing here sorts trees by distance; what each listed tree draws, from its finest leaves
// to a single splat, is its own continuum's choice (forestClusterSelect, js/forest-clusters.js).
export const FOREST_CULL_WGSL=FRAME_WGSL+ROOT_WGSL+/* wgsl */`
struct ForestPrototype {bound:vec4f,roots:vec4u};
@group(0)@binding(0)var<uniform>F:Frame;
@group(0)@binding(1)var<storage,read>roots:array<ForestRoot>;
@group(0)@binding(2)var<storage,read>prototypes:array<ForestPrototype>;
@group(0)@binding(3)var<storage,read_write>visible:array<u32>;
@group(0)@binding(4)var<storage,read_write>visibleCounts:array<atomic<u32>>;
// Roots in use, species, the scene's pixel error, unused.
@group(0)@binding(5)var<uniform>parameters:vec4f;
@compute @workgroup_size(64)fn forestReset(@builtin(global_invocation_id)id:vec3u){
 if(id.x>=u32(parameters.y)){return;}atomicStore(&visibleCounts[id.x],0u);
}
@compute @workgroup_size(64)fn forestCull(@builtin(global_invocation_id)id:vec3u){
 if(id.x>=u32(parameters.x)){return;}
 let r=roots[id.x];if(r.rootScale.w<=0.0){return;}let pi=u32(r.identity.x);let p=prototypes[pi];let c=cos(r.yawColour.x);let s=sin(r.yawColour.x);
 let b=p.bound.xyz*r.rootScale.w;
 // A felled tree lies as far as its own height from where it stood.
 let world=r.rootScale.xyz+vec3f(c*b.x-s*b.z,b.y,s*b.x+c*b.z);let relative=world-F.camPos.xyz;let radius=p.bound.w*r.rootScale.w*select(1.,2.,r.identity.w<0.);
 let clip=F.viewProj*vec4f(relative,1);
 let rowW=vec3f(F.viewProj[0].w,F.viewProj[1].w,F.viewProj[2].w);
 for(var a=0u;a<2u;a++){
   let row=vec3f(F.viewProj[0][a],F.viewProj[1][a],F.viewProj[2][a]);
   if(clip.w+clip[a]<-radius*length(rowW+row)||clip.w-clip[a]<-radius*length(rowW-row)){return;}
 }
 if(clip.w<-radius*length(rowW)){return;}
 let slot=atomicAdd(&visibleCounts[pi],1u);
 if(slot<p.roots.y){visible[p.roots.x+slot]=id.x;}
}
`;

export async function createForestRenderer({device,module,frameUBO,shader,resources,clouds,format,samples,pack,groundSample,pixelError=3,
  terrainOcclusion=null,savedStrikes=null,strikeOrigin={x:0,z:0},onStrikesChanged=null}){
  if(!(pixelError>0))throw Error('Invalid forest pixel error');
  if(samples<2)throw Error('Forest leaf coverage requires MSAA');
  const m=pack.manifest,allocated=[],B=GPUBufferUsage;
  const make=(data,usage,label)=>{if(data.byteLength>device.limits.maxBufferSize)throw Error(label+' exceeds GPU maxBufferSize');const b=device.createBuffer({size:Math.max(4,data.byteLength),usage:usage|B.COPY_DST,label});allocated.push(b);if(data.byteLength)device.queue.writeBuffer(b,0,data);return b;};
  const abort=new AbortController();
  let destroyed=false,terrainVisibility=null,surfaces=null,clusters=null,wind=null,fallCapsuleCursor=4;
  // Far crowns (js/forest-crowns.js). forestCrowns=0 draws every tree's leaves as far as they go; the
  // others move the change for inspection: the nearest it may fall, in metres, the pixel share, and how
  // broad a tree may stand on screen as a crown, in leaf errors. forestWind=0 leaves the trees to the
  // shader's own sway.
  const query=typeof location==='undefined'?new URLSearchParams():new URLSearchParams(location.search);
  const crownsWanted=query.get('forestCrowns')!=='0',windWanted=query.get('forestWind')!=='0',crownChange={};
  for(const [key,name]of [['nearest','forestCrownNearest'],['limit','forestCrownLimit'],['widest','forestCrownWidest']]){const value=Number(query.get(name));if(query.has(name)&&value>=0)crownChange[key]=value;}
  try{
    const isSubtropicalPack=m.prototypes.some(p=>p.species==='royal_palm'||p.species==='ceiba'||p.species==='mangrove');
    const isCohortPack=m.prototypes.some(p=>Boolean(p.cohort));
    const samplerOptions={minFilter:'linear',magFilter:'linear',mipmapFilter:'linear',maxAnisotropy:4};
    const nativeSampler=device.createSampler({...samplerOptions,addressModeU:'clamp-to-edge',addressModeV:'clamp-to-edge'});
    const nativeRepeatSampler=device.createSampler({...samplerOptions,addressModeU:'repeat',addressModeV:'repeat'});
    const rooted=pack.roots.slice();let excludedRoots=0;
    let liveRoots=rooted;const strikes=forestStrikesFromSave(savedStrikes,strikeOrigin),falling=[];
    if(groundSample)for(let i=0;i<rooted.length;i+=12){
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
    let activeRootCount=m.rootCount;
    // Trees shot down in an earlier sitting are down before the coast is first seen.
    reapplyForestStrikes(rooted,activeRootCount,strikes);
    const stats={loaded:true,backend:'continuum',roots:m.rootCount-excludedRoots,excludedRoots,prototypes:m.prototypes.length,gpuCulling:true,terrainOcclusion:false,pixelError,
      materialContract:m.materialContract,materialLayers:0,textureFamilies:[],coverageFiltering:'Stable independent leaf footprint sample masks',
      species:[...new Set(m.prototypes.map(p=>p.species))],sourceClaim:m.sourceClaim};
    // Clusters are each tree near and middling, crowns beyond (js/forest-clusters.js, js/forest-crowns.js): fetched
    // at once, while the roots are culled and the surfaces built. A pack without clusters cannot draw its trees.
    // Without crowns its leaves draw as far as they go, and without wind its trees sway in the shader alone.
    const clusterPromise=loadForestClusters({assets:isSubtropicalPack?SUBTROPICAL_FOREST_CLUSTER_ASSETS:isCohortPack?PORTUGAL_FOREST_CLUSTER_ASSETS:FOREST_CLUSTER_ASSETS,signal:abort.signal})
      .catch(error=>{if(!abort.signal.aborted)stats.clusters={loaded:false,error:error.message};throw error;});
    const crownPromise=crownsWanted?loadForestCrowns({assets:isSubtropicalPack?SUBTROPICAL_FOREST_CROWN_ASSETS:isCohortPack?PORTUGAL_FOREST_CROWN_ASSETS:FOREST_CROWN_ASSETS,signal:abort.signal})
      .catch(error=>{if(abort.signal.aborted)throw error;stats.crowns={loaded:false,error:error.message};return null;}):Promise.resolve(null);
    const windPromise=windWanted?loadForestWind({assets:isSubtropicalPack?SUBTROPICAL_FOREST_WIND_ASSETS:isCohortPack?PORTUGAL_FOREST_WIND_ASSETS:FOREST_WIND_ASSETS,signal:abort.signal})
      .catch(error=>{if(abort.signal.aborted)throw error;stats.wind={enabled:false,error:error.message};return null;}):Promise.resolve(null);
    for(const promise of [clusterPromise,crownPromise,windPromise])promise.catch(()=>{});
    const maxRootCapacity=Math.max(m.rootCount,pack.maxRootCapacity||m.rootCount);
    const roots=device.createBuffer({size:Math.max(4,maxRootCapacity*12*4),usage:B.STORAGE|B.COPY_DST,label:'forest immutable root transforms'});
    allocated.push(roots);if(rooted.byteLength)device.queue.writeBuffer(roots,0,rooted);
    // Each species' bound and the stretch of the roots it holds, which its visible list shares.
    const meta=new ArrayBuffer(m.prototypes.length*32),floats=new Float32Array(meta),words=new Uint32Array(meta);
    for(const p of m.prototypes){floats.set([...p.centre,p.radius],p.id*8);words.set([p.firstRoot,p.rootCount,0,0],p.id*8+4);}
    const prototypes=make(new Uint8Array(meta),B.STORAGE,'forest species bounds and root ranges');
    const visible=make(new Uint32Array(maxRootCapacity),B.STORAGE,'forest GPU visible root IDs');
    const visibleCounts=make(new Uint32Array(m.prototypes.length),B.STORAGE,'forest GPU visible root counts');
    let currentPixelError=pixelError;
    const parameters=make(new Float32Array([activeRootCount,m.prototypes.length,pixelError,0]),B.UNIFORM,'forest roots and pixel error');
    const writeParameters=()=>device.queue.writeBuffer(parameters,0,new Float32Array([activeRootCount,m.prototypes.length,currentPixelError,0]));
    let cullSource=FOREST_CULL_WGSL;
    if(terrainOcclusion){terrainVisibility=createForestTerrainOcclusion({device,...terrainOcclusion});cullSource=withForestTerrainOcclusion(cullSource);stats.terrainOcclusion=true;}
    const cullModule=await shader(cullSource,'forest GPU cull');
    const [reset,cull]=await Promise.all([
      device.createComputePipelineAsync({label:'forest reset visible counts',layout:'auto',compute:{module:cullModule,entryPoint:'forestReset'}}),
      device.createComputePipelineAsync({label:'forest cull',layout:'auto',compute:{module:cullModule,entryPoint:'forestCull'}}),
    ]);
    const resetGroup=device.createBindGroup({layout:reset.getBindGroupLayout(0),entries:[{binding:4,resource:{buffer:visibleCounts}},{binding:5,resource:{buffer:parameters}}]});
    const cullGroup=device.createBindGroup({layout:cull.getBindGroupLayout(0),entries:[...[frameUBO,roots,prototypes,visible,visibleCounts,parameters].map((buffer,binding)=>({binding,resource:{buffer}})),...(terrainVisibility?.entries??[])]});
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
    const [clusterSource,crownSource,windSource]=await Promise.all([clusterPromise,crownPromise,windPromise]);forestLoadAbort(abort.signal);
    wind=await createForestWind({device,shader,frameWGSL:FRAME_WGSL,frameUBO,windSource,roots,maxRoots:maxRootCapacity,prototypes:m.prototypes});
    wind.updateRoots(activeRootCount);
    stats.wind=wind.stats;
    if(typeof window!=='undefined')window.oceanForestWind=wind;
    const firstMaterials=[];let materialCursor=0;for(const p of m.prototypes){firstMaterials.push(materialCursor);materialCursor+=p.nativeMaterials.length;}
    const sceneIds=[0,1,2,3,4,5,6,19,20,21];
    const bind=(p,ids=sceneIds)=>device.createBindGroup({layout:p.getBindGroupLayout(0),entries:resources.filter(([i])=>ids.includes(i)).map(([binding,resource])=>({binding,resource}))});
    bind.frameUBO=frameUBO;
    clusters=await createForestClusters({device,shader,module,frame:FRAME_WGSL,source:clusterSource,crowns:crownSource,crownChange,wind,prototypes:m.prototypes,roots,visible,visibleCounts,parameters,format,samples,bind,
      hasLandShadow:resources.some(([id])=>id===19),shadowUniform:resources.find(([id])=>id===19)?.[1].buffer??null,
      cloudEntries:p=>clouds.bindVolume(p),
      surfaceEntries:(pipeline,id,offset,normals)=>{
        const entries=[{binding:0,resource:{buffer:roots}},{binding:2,resource:{buffer:offset}},{binding:5,resource:nativeSampler},{binding:6,resource:{buffer:materials}},{binding:13,resource:nativeRepeatSampler}];
        for(let family=0;family<4;family++){const texture=surfaces.families[family]??surfaces.families[0],first=family?5+family*2:3;
          entries.push({binding:first,resource:texture.albedo.createView({dimension:'2d-array'})});if(normals)entries.push({binding:first+1,resource:texture.normal.createView({dimension:'2d-array'})});}
        return device.createBindGroup({layout:pipeline.getBindGroupLayout(2),entries});
      },firstMaterials});
    forestLoadAbort(abort.signal);
    stats.clusters={loaded:true,count:clusterSource.manifest.clusterCount,bytes:clusterSource.vertices.byteLength+clusterSource.indices.byteLength+clusterSource.clusters.byteLength};
    if(crownSource)stats.crowns={loaded:true,mode:'progressive-continuum',steps:crownSource.manifest.prototypes.reduce((sum,q)=>sum+q.stepCount,0),splatPixels:FOREST_CROWN_SPLAT_PIXELS,minPixels:FOREST_CROWN_MIN_PIXELS,triangles:crownSource.manifest.indexCount/3,bytes:crownSource.vertices.byteLength+crownSource.indices.byteLength+crownSource.morph.byteLength,error:null};
    // The GPU holds the surfaces now; the pack lets go of its maps.
    pack.releaseSurfaces?.();
    // A ball finds its trees through this. A new one builds off the frame; the old one serves until it is ready.
    // A pack's trees are struck as the wood measured for their species (js/forest-trunk-shapes.js). Full-grown trees are
    // not the size of the trees measured, so for them that wood is made as tall as each kind of tree and as stout in the trunk.
    const trunkShapes=m.prototypes.map(p=>forestTrunkShape(p.species,m.stature==='full-grown'?{height:p.high[1],trunkRadius:p.dbhCentimetres/200}:null));
    let trunkGrid=null,trunkBuild=0;
    const rebuildTrunks=()=>{
      const build=++trunkBuild,forRoots=liveRoots,forCount=activeRootCount;
      return buildForestTrunkGridAsync(forRoots,forCount,trunkShapes,{isCancelled:()=>destroyed||build!==trunkBuild}).then(grid=>{if(grid&&build===trunkBuild)trunkGrid=grid;}).catch(error=>{console.error('Forest trunk grid failed',error);});
    };
    const trunksReady=rebuildTrunks();
    const writeRoot=index=>device.queue.writeBuffer(roots,index*48,liveRoots.subarray(index*12,index*12+12));
    const noteFall=(index,now)=>{
      const fx=liveRoots[index*12],fy=liveRoots[index*12+1],fz=liveRoots[index*12+2],fScale=Math.max(0.5,liveRoots[index*12+3]);
      falling.push({x:fx,z:fz,now});
      if(wind?.enabled){
        const proto=m.prototypes[liveRoots[index*12+8]|0]??m.prototypes[0];
        const code=(liveRoots[index*12+9]|0)>>>0;
        const fallAng=(((code>>>11)&(FOREST_FALL_BEARINGS-1))/FOREST_FALL_BEARINGS)*Math.PI*2;
        const reach=Math.max(4,(proto?.high?.[1]??16)*fScale*0.88);
        const crownR=Math.max(2.5,Math.min(10,(proto?.radius??12)*fScale*0.32));
        const capSlot=4+(fallCapsuleCursor++%12);
        wind.setPushCapsule(capSlot,{ax:fx,ay:fy+1.8,az:fz,bx:fx+Math.cos(fallAng)*reach,by:fy+2.8,bz:fz+Math.sin(fallAng)*reach,radius:crownR,strength:14500,falloff:1.1,now,duration:FOREST_FALL_SECONDS+1.4});
        wind.emitForce({x:fx+Math.cos(fallAng)*reach*0.55,y:fy+3.5,z:fz+Math.sin(fallAng)*reach*0.55,radius:reach*1.15,strengthPa:340,dx:Math.cos(fallAng),dy:-0.15,dz:Math.sin(fallAng),basis:FOREST_WIND_BASIS_RADIAL,eventType:FOREST_WIND_EVENT_PULSE,now,waveSpeed:FOREST_FALL_SECONDS+0.8,lobe:0.45});
      }
    };
    const liveIndex=(hit)=>{
      if(hit.roots===liveRoots)return hit.rootIndex;
      for(let i=0;i<activeRootCount;i++)if(liveRoots[i*12]===hit.x&&liveRoots[i*12+2]===hit.z)return i;
      return -1;
    };
    const saveStrikes=()=>{onStrikesChanged?.(forestStrikesToSave(strikes,strikeOrigin));};
    return {stats,trunksReady,
      get wind(){return wind;},
      get trunks(){return trunkGrid;},
      updatePack(nextPack,nextHeights=null,nextRegion=null){
        if(destroyed||!nextPack?.roots||!nextPack?.manifest)return;
        const nextCount=Math.min(maxRootCapacity,nextPack.manifest.rootCount);
        activeRootCount=nextCount;
        stats.roots=nextCount;
        if(nextPack.roots.byteLength){
          liveRoots=nextPack.roots;reapplyForestStrikes(liveRoots,nextCount,strikes);
          device.queue.writeBuffer(roots,0,nextPack.roots.subarray(0,nextCount*12));
        }
        for(const p of nextPack.manifest.prototypes){
          if(m.prototypes[p.id]){m.prototypes[p.id].firstRoot=p.firstRoot;m.prototypes[p.id].rootCount=p.rootCount;}
          words[p.id*8+4]=p.firstRoot;words[p.id*8+5]=p.rootCount;
        }
        clusters.placeTrees();
        wind.updateRoots(nextCount);
        device.queue.writeBuffer(prototypes,0,new Uint8Array(meta));
        writeParameters();
        if(nextHeights)terrainVisibility?.update?.(nextHeights,nextRegion);
        rebuildTrunks();
      },
      // A blast close by, with no ball in the tree: the nearest takes it, and surrounding trees whip in the shockwave.
      strike(x,z,now=0,groundAt=null){
        if(destroyed)return;
        if(wind?.enabled){
          const gy=groundAt?groundAt(x,z):0;
          wind.emitForce({x,y:(Number.isFinite(gy)?gy:0)+2.4,z,radius:34,strengthPa:920,basis:FOREST_WIND_BASIS_RADIAL,eventType:FOREST_WIND_EVENT_FRIEDLANDER,now,waveSpeed:280});
        }
        const index=strikeForestRoot(liveRoots,activeRootCount,x,z,strikes,{now,groundAt,shapeOf:id=>trunkShapes[id]});
        if(index<0)return;
        writeRoot(index);saveStrikes();
        if(liveRoots[index*12+11]<0)noteFall(index,now);
      },
      // A ball in this tree. Only this root's 48 bytes go to the GPU, and only now.
      strikeTree(hit,impact,now=0,groundAt=null){
        if(destroyed)return null;
        if(wind?.enabled){
          const hx=hit.x??0,hz=hit.z??0,hy=(groundAt?groundAt(hx,hz):0)+(hit.height??3);
          wind.emitForce({x:hx,y:Number.isFinite(hy)?hy:3,z:hz,radius:26,strengthPa:720,dx:impact?.vx??1,dy:impact?.vy??0,dz:impact?.vz??0,basis:FOREST_WIND_BASIS_RADIAL,eventType:FOREST_WIND_EVENT_FRIEDLANDER,now,waveSpeed:290,lobe:0.35});
        }
        const index=liveIndex(hit);if(index<0)return null;
        const result=strikeForestTree(liveRoots,index,trunkShapes[liveRoots[index*12+8]|0],{...impact,height:hit.height,onTrunk:hit.onTrunk,now,groundAt},strikes);
        if(!result)return null;
        writeRoot(index);saveStrikes();
        if(result.felled)noteFall(index,now);
        return result;
      },
      // Once a tree is down it stays down, whatever the clock does: it wraps every ten minutes.
      settleFalls(now){
        for(let f=falling.length-1;f>=0;f--){
          const fall=falling[f],age=now-fall.now;
          if(age>=0&&age<FOREST_FALL_SECONDS+.1)continue;
          falling.splice(f,1);
          for(let i=0;i<activeRootCount;i++)if(liveRoots[i*12]===fall.x&&liveRoots[i*12+2]===fall.z){liveRoots[i*12+11]=FOREST_LONG_FALLEN;writeRoot(i);break;}
        }
      },
      // The scene's one pixel error, which every tree's cut and crown read.
      setPixelError(next){if(!destroyed&&Number.isFinite(next)&&next>0&&Math.abs(next-currentPixelError)>1e-4){currentPixelError=next;stats.pixelError=next;writeParameters();}},
      encode(pass){if(!activeRootCount)return;pass.setPipeline(reset);pass.setBindGroup(0,resetGroup);pass.dispatchWorkgroups(Math.ceil(m.prototypes.length/64));pass.setPipeline(cull);pass.setBindGroup(0,cullGroup);pass.dispatchWorkgroups(Math.ceil(activeRootCount/64));wind.encode(pass);clusters.encode(pass);},
      drawOpaque(pass){clusters.drawOpaque(pass);},
      // The indirect draws drawOpaque and drawCutout submit, for the continuum census (js/continuum-census.js).
      // Records lie five words apart, whichever draw call reads them; leaves drawn for depth and again to shade
      // are listed twice, because they are submitted twice.
      continuumDraws(){
        if(destroyed)return [];
        const out=[],P=m.prototypes.length,record=(buffer,at,records=1)=>{if(records>0)out.push({buffer,offset:at*20,records,stride:5});};
        // Per species: camera wood and leaves, then the shadow map's two, then the crowns' lists (js/forest-clusters.js).
        record(clusters.draws,0,P*2);
        for(const p of m.prototypes)record(clusters.draws,p.id*2+1);
        if(clusters.crowns)record(clusters.draws,P*4,clusters.draws.size/20-P*4);
        return out;
      },
      drawCutout(pass){clusters.drawLeafDepth(pass);clusters.drawLeaves(pass);},
      drawShadow(pass){clusters.drawShadow(pass);},
      destroy(){destroyed=true;abort.abort();for(const b of allocated)b.destroy();wind?.destroy();clusters?.destroy();surfaces?.destroy();terrainVisibility?.destroy();}};
  }catch(error){destroyed=true;abort.abort();for(const b of allocated)b.destroy();wind?.destroy();clusters?.destroy();surfaces?.destroy();terrainVisibility?.destroy();throw error;}
}

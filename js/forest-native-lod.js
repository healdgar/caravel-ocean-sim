// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Receipt-verified native woody LOD tiers and preauthored 2-triangle leaf
// ribbons addressing immutable assets/forest-scenery/saba/vertices.bin.
export const FOREST_NATIVE_LOD_ASSETS=Object.freeze({
 'lod/manifest.json':'assets/forest-scenery/saba/lod/manifest.json',
 'lod/lod-indices.bin.gz':'assets/forest-scenery/saba/lod/lod-indices.bin.gz',
});
const forestNativeLodMaxBytes=128*1024*1024;
const forestNativeLodUint=value=>Number.isSafeInteger(value)&&value>=0;
const forestNativeLodReceipt=value=>forestNativeLodUint(value?.bytes)&&value.bytes>0&&value.bytes<=forestNativeLodMaxBytes&&typeof value.sha256==='string'&&/^[a-f0-9]{64}$/.test(value.sha256);
const forestNativeLodSameReceipt=(a,b)=>forestNativeLodReceipt(a)&&forestNativeLodReceipt(b)&&a.bytes===b.bytes&&a.sha256===b.sha256;

export function validateForestNativeLOD(document,forest){
 const source=document?.source,item=document?.files?.['lod-indices.bin'],count=document?.indexCount,manifest=forest?.manifest??forest;
 if(document?.format!=='waterworld.forest-native-lod'||document.version!==1||document.units!=='metres'||document.upAxis!=='Y'||
  document.appearanceErrorSupported!==false||!forestNativeLodUint(count)||count===0||count%3!==0||
  !forestNativeLodReceipt(item)||item.indexCount!==count||item.bytes!==count*4||
  !forestNativeLodReceipt(item.gzip)||item.gzip.file!=='lod-indices.bin.gz'||Object.keys(document.files).length!==1)throw Error('Invalid native forest LOD manifest');
 for(const name of ['vertices.bin','indices.bin','roots.bin']){
  if(!forestNativeLodUint(manifest?.files?.[name]?.bytes)||manifest.files[name].bytes!==source?.files?.[name]?.bytes||
   manifest.files[name].sha256!==source?.files?.[name]?.sha256)throw Error('Native forest LOD source mismatch: '+name);
 }
 if(manifest.canopyShade&&!forestNativeLodSameReceipt(source?.canopyShade,manifest.canopyShade))throw Error('Native forest LOD canopy shade mismatch');
 for(const file of ['scripts/prepare-forest-native-lod.mjs','scripts/prepare-forest-wood-lods.mjs','js/forest-leaf-ribbons.js']){
  const m=source?.methods?.[file];if(!forestNativeLodReceipt(m)||m.file!==file)throw Error('Invalid native forest LOD method provenance: '+file);
 }
 if(!Array.isArray(document.prototypes)||!Array.isArray(manifest.prototypes)||document.prototypes.length!==manifest.prototypes.length)throw Error('Invalid native forest LOD prototype table');
 let cursor=0;
 for(const [id,p]of document.prototypes.entries()){
  const original=manifest.prototypes[id];
  if(p?.id!==id||original?.id!==id||p.species!==original.species||!Array.isArray(p.woodTiers)||p.woodTiers.length!==3)throw Error('Invalid native forest LOD specimen');
  for(const [tierIndex,wt]of p.woodTiers.entries()){
   if(wt?.tier!==tierIndex||wt.firstIndex!==cursor||!forestNativeLodUint(wt.indexCount)||wt.indexCount===0||wt.indexCount%3!==0||
    wt.triangles!==wt.indexCount/3||wt.originalTriangles!==original.wood.indexCount/3||
    !Number.isFinite(wt.maximumReportedErrorMetres)||wt.maximumReportedErrorMetres<0||wt.maximumReportedErrorMetres>.5||
    !forestNativeLodReceipt(wt.indices)||wt.indices.bytes!==wt.indexCount*4||!Array.isArray(wt.parts)||!wt.parts.length)throw Error('Invalid native forest woody LOD tier');
   cursor+=wt.indexCount;
  }
  const lr=p.leafRibbons;
  if(lr?.firstIndex!==cursor||!forestNativeLodUint(lr.indexCount)||lr.indexCount===0||lr.indexCount%6!==0||
   lr.leafCount!==lr.indexCount/6||lr.originalFirstIndex!==original.leaf.firstIndex||
   lr.originalIndexCount!==original.leaf.indexCount||
   !Number.isFinite(lr.maximumPositionErrorUpperMetres)||lr.maximumPositionErrorUpperMetres<0||lr.maximumPositionErrorUpperMetres>.1||
   !forestNativeLodReceipt(lr.indices)||lr.indices.bytes!==lr.indexCount*4)throw Error('Invalid native forest leaf ribbon tier');
  cursor+=lr.indexCount;
  const far=p.far;
  if(far?.firstIndex!==cursor||!forestNativeLodUint(far.indexCount)||far.indexCount===0||far.indexCount%3!==0||
   far.originalFirstIndex!==original.far.firstIndex||far.originalIndexCount!==original.far.indexCount||
   !forestNativeLodReceipt(far.indices)||far.indices.bytes!==far.indexCount*4)throw Error('Invalid native forest LOD far range');
  cursor+=far.indexCount;
 }
 if(cursor!==count)throw Error('Incomplete native forest LOD index partitions');
 return document;
}

export async function loadForestNativeLOD({forest,fetchAsset=fetch,assets=FOREST_NATIVE_LOD_ASSETS,signal}={}){
 if(typeof assets?.['lod/manifest.json']!=='string'||typeof assets?.['lod/lod-indices.bin.gz']!=='string')return null;
 if(!globalThis.crypto?.subtle||typeof DecompressionStream!=='function')throw Error('Native forest LOD requires verified gzip transport');
 const digest=async bytes=>Array.from(new Uint8Array(await crypto.subtle.digest('SHA-256',bytes)),n=>n.toString(16).padStart(2,'0')).join('');
 const load=async name=>{
  if(signal?.aborted)throw signal.reason??new DOMException('Forest load aborted','AbortError');
  const response=await fetchAsset(assets[name],signal?{signal}:undefined);
  if(!response.ok)throw Error('Native forest LOD asset unavailable: '+name);
  return response.arrayBuffer();
 };
 const json=await load('lod/manifest.json');
 const manifest=validateForestNativeLOD(JSON.parse(new TextDecoder('utf-8',{fatal:true}).decode(json)),forest);
 const item=manifest.files['lod-indices.bin'];
 const encoded=await load('lod/'+item.gzip.file);
 if(encoded.byteLength!==item.gzip.bytes||await digest(encoded)!==item.gzip.sha256)throw Error('Native forest LOD encoded digest mismatch');
 const raw=await new Response(new Blob([encoded]).stream().pipeThrough(new DecompressionStream('gzip'))).arrayBuffer();
 if(raw.byteLength!==item.bytes||await digest(raw)!==item.sha256)throw Error('Native forest LOD decoded digest mismatch');
 const indices=new Uint32Array(raw),vertexCount=(forest?.manifest??forest).files['vertices.bin'].vertexCount;
 for(let i=0;i<indices.length;i++)if(indices[i]>=vertexCount)throw Error('Native forest LOD index outside vertex stream');
 return{manifest,indices,prototypes:manifest.prototypes,sourceValidated:true};
}

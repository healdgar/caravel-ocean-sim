#!/usr/bin/env node
// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Offline only: derive smaller leaf indices from verified mature inspection pages.
import {access,mkdir,mkdtemp,readFile,rename,rm,writeFile} from 'node:fs/promises';
import {dirname,join,resolve,relative,sep,isAbsolute} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {loadForestInspectionPilot} from '../js/forest-lod-inspection.js';
import {reduceForestLeafRibbons,prepareForestRibbonInspection} from '../js/forest-leaf-ribbons.js';
import {validateForestRibbonAssets} from '../js/forest-ribbon-assets.js';
const ROOT=dirname(dirname(fileURLToPath(import.meta.url))),check=(ok,m)=>{if(!ok)throw Error(m);};
const receipt=bytes=>({bytes:bytes.byteLength,sha256:createHash('sha256').update(bytes).digest('hex')}),raw=a=>Buffer.from(a.buffer,a.byteOffset,a.byteLength),exists=async p=>{try{await access(p);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}};

export function createForestRibbonPrototype(inspection){
 const floats=new Float32Array(inspection.vertices.buffer,inspection.vertices.byteOffset,inspection.vertices.byteLength/4),ribbons=reduceForestLeafRibbons(floats,inspection.indices,undefined,{vertexStride:15}),derived=prepareForestRibbonInspection(inspection,ribbons);
 const clusters=derived.clusters.filter(c=>c.representation==='ribbon').map(c=>({sourceNodeID:c.sourceNodeID,firstLeaf:c.firstLeaf,leafCount:c.leafCount,firstIndex:c.firstIndex,indexCount:c.indexCount,reductionErrorMetres:c.reductionErrorMetres,interpolationDeviations:c.interpolationDeviations}));
 return{indices:ribbons.indices,record:{id:inspection.prototype.id,species:inspection.prototype.species,leafCount:ribbons.leafCount,sourceVertices:receipt(inspection.vertices),sourceIndices:receipt(raw(inspection.indices)),maximumPositionErrorUpperMetres:ribbons.maximumPositionErrorUpperMetres,interpolationDeviations:derived.reduction.interpolationDeviations,clusters}};
}

export async function prepareForestRibbons({inspection,source,out,prototypeIDs}){
 const input=resolve(inspection),native=resolve(source),target=resolve(out);
 for(const folder of [input,native]){const r=relative(folder,target);check(target!==folder&&(r==='..'||r.startsWith('..'+sep)||isAbsolute(r)),'Output must be outside source folders');}
 check(!await exists(target),'Fresh ribbon output required');const snapshots=new Map(),allowed=new Map();
 const pin=async path=>{const bytes=await readFile(path),r=receipt(bytes),previous=snapshots.get(path);check(!previous||JSON.stringify(r)===JSON.stringify(previous),'Source changed while reading: '+path);snapshots.set(path,r);return bytes;};
 const inspectionRaw=await pin(join(input,'manifest.json')),m=JSON.parse(inspectionRaw),sourceRaw=await pin(join(native,'manifest.json'));
 allowed.set('/inspection/manifest.json',join(input,'manifest.json'));allowed.set('/source/manifest.json',join(native,'manifest.json'));allowed.set('/source/canopy-shade.json',join(native,'canopy-shade.json'));
 check(Array.isArray(m.prototypes)&&m.prototypes.length>0,'Inspection prototypes required');
 for(const p of m.prototypes)for(const r of [p.hierarchy.leafOrder,...p.pages.flatMap(page=>Object.values(page.files))])allowed.set('/inspection/'+r.gzip.file,join(input,r.gzip.file));
 const fetchAsset=async url=>{const u=new URL(url);check(u.origin==='https://forest-author.invalid'&&!u.search&&!u.hash,'Unexpected authoring URL');const path=allowed.get(u.pathname);check(path,'Unlisted authoring source: '+u.pathname);return new Response(await pin(path));};
 const loader=await loadForestInspectionPilot('https://forest-author.invalid/inspection/',{sourceBase:'https://forest-author.invalid/source/',fetchAsset,allowExperimental:true});
 const selected=prototypeIDs??m.prototypes.map(p=>p.id);check(Array.isArray(selected)&&selected.length>0&&new Set(selected).size===selected.length&&selected.every(id=>Number.isSafeInteger(id)&&id>=0&&m.prototypes.some(p=>p.id===id)),'Invalid prototype selection');
 const methods=[];for(const file of ['scripts/prepare-forest-ribbons.mjs','js/forest-leaf-ribbons.js'])methods.push({file,...receipt(await pin(join(ROOT,file)))});
 await mkdir(dirname(target),{recursive:true});const staging=await mkdtemp(join(dirname(target),'.forest-ribbons-'));const records=[];
 try{
  for(const id of selected){const original=await loader.loadGeometry(id),authored=createForestRibbonPrototype(original),bytes=raw(authored.indices),encoded=gzipSync(bytes,{level:9,mtime:0}),file='prototype-'+id+'-indices.u32.bin';check(bytes.length<=64*1024*1024&&encoded.length<=64*1024*1024,'Authored index budget exceeded');
   await writeFile(join(staging,file+'.gz'),encoded,{flag:'wx'});records.push({...authored.record,indices:{file,...receipt(bytes),gzip:{file:file+'.gz',...receipt(encoded)}}});original.destroy();
  }
  for(const [path,pinned]of snapshots)check(JSON.stringify(receipt(await readFile(path)))===JSON.stringify(pinned),'Source changed during ribbon authoring: '+path);
  const manifest=validateForestRibbonAssets({format:'waterworld.forest-ribbon-assets',version:1,experimental:true,qualified:false,complete:true,units:'metres',upAxis:'Y',source:{inspectionManifest:{file:'manifest.json',...receipt(inspectionRaw)},normalizedInspection:receipt(Buffer.from(JSON.stringify(m))),nativeManifest:m.source.manifest},methods,prototypes:records,limitations:['Retains every source blade. Guarded UV-corresponded position error does not establish normal/AO/lighting likeness.','Experimental source-derived indices. Runtime selection, all camera envelopes, wind and production streaming remain independently qualified.']});
  check(JSON.stringify(receipt(sourceRaw))===JSON.stringify(snapshots.get(join(native,'manifest.json'))),'Native metadata changed');await writeFile(join(staging,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});check(!await exists(target),'Output became occupied');await rename(staging,target);return manifest;
 }catch(error){await rm(staging,{recursive:true,force:true});throw error;}
}

if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const options={},flags={'--inspection':'inspection','--source':'source','--out':'out','--prototype':'prototypeIDs'};
 for(let i=2;i<process.argv.length;i+=2){const key=flags[process.argv[i]];check(key&&process.argv[i+1]&&options[key]===undefined,'Usage: --inspection PACK --source NATIVE --out FRESH [--prototype 0,2]');options[key]=key==='prototypeIDs'?process.argv[i+1].split(',').map(Number):process.argv[i+1];}
 check(options.inspection&&options.source&&options.out,'Inspection, source and fresh output required');prepareForestRibbons(options).then(m=>console.log(JSON.stringify({prototypes:m.prototypes.map(p=>({id:p.id,sourceTriangles:p.leafCount*4,reducedTriangles:p.leafCount*2,encodedBytes:p.indices.gzip.bytes,errorMetres:p.maximumPositionErrorUpperMetres}))}))).catch(e=>{console.error(e.stack??e);process.exitCode=1;});
}

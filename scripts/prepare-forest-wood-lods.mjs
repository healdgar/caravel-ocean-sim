#!/usr/bin/env node
// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Offline index-only woody LODs from immutable mature Forestmodeler geometry.
import {readFile,writeFile,mkdir,access} from 'node:fs/promises';
import {resolve,join,dirname} from 'node:path';
import {fileURLToPath} from 'node:url';
import {gzipSync,gunzipSync} from 'node:zlib';
import {createHash} from 'node:crypto';
import {loadMiddleTools} from './simplify-forest-middle.mjs';

const check=(ok,message)=>{if(!ok)throw Error(message);};
const receipt=b=>({bytes:b.byteLength,sha256:createHash('sha256').update(b).digest('hex')});
const same=(a,b)=>a.bytes===b.bytes&&a.sha256===b.sha256;
export const FOREST_WOOD_LOD_RECIPES=Object.freeze([
 Object.freeze({tier:0,targetTriangles:18000,errorMetres:.025}),
 Object.freeze({tier:1,targetTriangles:5000,errorMetres:.10}),
 Object.freeze({tier:2,targetTriangles:600,errorMetres:.35}),
]);

export function forestWoodMaterialParts(prototype,vertices,indices){
 check(vertices instanceof Float32Array&&vertices.length%14===0&&indices instanceof Uint32Array,'Invalid native woody source buffers');
 const range=prototype.wood;
 check(Number.isSafeInteger(range?.firstIndex)&&range.firstIndex>=0&&Number.isSafeInteger(range?.indexCount)&&range.indexCount>0&&range.indexCount%3===0&&range.firstIndex+range.indexCount<=indices.length,'Invalid native woody range');
 const groups=new Map();
 for(let at=range.firstIndex;at<range.firstIndex+range.indexCount;at+=3){
  let material;
  for(let k=0;k<3;k++){
   const id=indices[at+k];check(id*14+13<vertices.length,'Woody source index outside vertices');
   const row=vertices.subarray(id*14,id*14+14);
   check(row.every(Number.isFinite)&&row[6]===3&&Number.isInteger(row[13])&&row[13]>=0&&row[13]<prototype.nativeMaterials.length,'Invalid woody material or vertex');
   if(k===0)material=row[13];else check(row[13]===material,'Woody triangle crosses material bindings');
  }
  if(!groups.has(material))groups.set(material,[]);
  groups.get(material).push(indices[at],indices[at+1],indices[at+2]);
 }
 return [...groups].sort((a,b)=>a[0]-b[0]).map(([material,values])=>({material,indices:Uint32Array.from(values)}));
}

export function reduceForestWood(prototype,source,indices,simplifier,recipe){
 check(Number.isSafeInteger(recipe.tier)&&recipe.tier>=0&&recipe.tier<=2&&Number.isSafeInteger(recipe.targetTriangles)&&recipe.targetTriangles>0&&Number.isFinite(recipe.errorMetres)&&recipe.errorMetres>0&&recipe.errorMetres<=.5,'Invalid woody LOD recipe');
 const parts=forestWoodMaterialParts(prototype,source,indices),records=[],outIndices=[],sourceIDs=[],outParts=[],reports=[];
 let firstIndex=0,firstVertex=0;
 for(const part of parts){
  const ids=[],remap=new Map(),local=new Uint32Array(part.indices.length);
  for(let n=0;n<part.indices.length;n++){
   const old=part.indices[n];let id=remap.get(old);
   if(id===undefined){id=ids.length;ids.push(old);remap.set(old,id);}local[n]=id;
  }
  const data=new Float32Array(ids.length*14),attributes=new Float32Array(ids.length*5);
  for(let n=0;n<ids.length;n++){
   data.set(source.subarray(ids[n]*14,ids[n]*14+14),n*14);
   attributes.set([data[n*14+3],data[n*14+4],data[n*14+5],data[n*14+8],data[n*14+9]],n*5);
  }
  const scale=simplifier.getScale(data,14),target=Math.max(3,Math.floor(recipe.targetTriangles*part.indices.length/prototype.wood.indexCount)*3);
  check(Number.isFinite(scale)&&scale>0,'Degenerate woody simplification bounds');
  const original=receipt(new Uint8Array(data.buffer));
  const [reduced,error]=simplifier.simplifyWithAttributes(local,data,14,attributes,5,[.15,.15,.15,.025,.025],null,Math.min(local.length,target),recipe.errorMetres/scale,['Permissive']);
  check(same(receipt(new Uint8Array(data.buffer)),original),'Woody simplifier mutated source records');
  check(reduced instanceof Uint32Array&&reduced.length>0&&reduced.length%3===0&&reduced.length<=local.length&&Number.isFinite(error)&&error>=0&&error*scale<=recipe.errorMetres+1e-6,'Invalid woody simplifier result');
  const kept=new Map(),values=[],packed=new Uint32Array(reduced.length);
  for(let n=0;n<reduced.length;n++){
   check(reduced[n]<ids.length,'Reduced woody index escaped original records');
   let id=kept.get(reduced[n]);if(id===undefined){id=kept.size;kept.set(reduced[n],id);for(let k=0;k<14;k++)values.push(data[reduced[n]*14+k]);}packed[n]=firstVertex+id;
  }
  const vertices=Float32Array.from(values);records.push(vertices);outIndices.push(packed);sourceIDs.push(Uint32Array.from([...kept.keys()].map(localID=>ids[localID])));
  outParts.push({material:part.material,firstIndex,indexCount:packed.length});
  reports.push({material:part.material,sourceTriangles:local.length/3,triangles:packed.length/3,reportedErrorMetres:error*scale,targetMet:packed.length<=target});
  firstIndex+=packed.length;firstVertex+=vertices.length/14;
 }
 const vertices=new Float32Array(firstVertex*14),result=new Uint32Array(firstIndex);let a=0,b=0;
 for(const record of records){vertices.set(record,a);a+=record.length;}for(const part of outIndices){result.set(part,b);b+=part.length;}
 const sourceVertexIDs=new Uint32Array(firstVertex);let sourceAt=0;for(const part of sourceIDs){sourceVertexIDs.set(part,sourceAt);sourceAt+=part.length;}
 return{vertices,indices:result,sourceVertexIDs,parts:outParts,reports,triangles:result.length/3,targetMet:result.length/3<=recipe.targetTriangles};
}

async function stream(folder,name,item){
 const file=item.gzip?.file??name;check(file===name||file===name+'.gz','Unsafe original woody stream path');
 const encoded=await readFile(join(folder,file));check(same(receipt(encoded),item.gzip??item),'Native woody encoded digest mismatch');
 const decoded=item.gzip?gunzipSync(encoded,{maxOutputLength:item.bytes}):encoded;
 check(same(receipt(decoded),item),'Native woody decoded digest mismatch');return decoded;
}
export async function prepareForestWoodLODs({pack,out,prototypeIDs=[0,2],meshoptimizer,recipes=FOREST_WOOD_LOD_RECIPES}){
 const folder=resolve(pack),target=resolve(out);check(!target.startsWith(folder+'/')&&target!==folder,'Output must be outside source');
 try{await access(target);throw Error('Fresh woody output required');}catch(e){if(e.code!=='ENOENT')throw e;}
 const raw=await readFile(join(folder,'manifest.json')),m=JSON.parse(raw);
 check(m.format==='waterworld.forest-instances'&&m.version===2&&m.vertexStride===56,'Original v2 native forest source required');
 check(Array.isArray(prototypeIDs)&&prototypeIDs.length>0&&new Set(prototypeIDs).size===prototypeIDs.length&&prototypeIDs.every(id=>Number.isInteger(id)&&m.prototypes[id]?.id===id),'Invalid woody prototype selection');
 const vRaw=await stream(folder,'vertices.bin',m.files['vertices.bin']),iRaw=await stream(folder,'indices.bin',m.files['indices.bin']);
 const vertices=new Float32Array(vRaw.buffer.slice(vRaw.byteOffset,vRaw.byteOffset+vRaw.byteLength)),indices=new Uint32Array(iRaw.buffer.slice(iRaw.byteOffset,iRaw.byteOffset+iRaw.byteLength)),tools=await loadMiddleTools(meshoptimizer);
 await mkdir(target,{recursive:true});const files={},prototypes=[];
 for(const id of prototypeIDs){
  const p=m.prototypes[id],tiers=[];
  for(const recipe of recipes){
   const reduced=reduceForestWood(p,vertices,indices,tools.simplifier,recipe),base=`${p.species}-tier-${recipe.tier}`;
   for(const [suffix,data]of [['vertices',reduced.vertices],['indices',reduced.indices],['source-ids',reduced.sourceVertexIDs]]){
    const bytes=Buffer.from(data.buffer,data.byteOffset,data.byteLength),name=base+'-'+suffix+'.bin',encoded=gzipSync(bytes,{level:9});
    await writeFile(join(target,name+'.gz'),encoded);files[name]={...receipt(bytes),gzip:{file:name+'.gz',...receipt(encoded)}};
   }
   tiers.push({tier:recipe.tier,recipe,vertices:base+'-vertices.bin',indices:base+'-indices.bin',sourceVertexIDs:base+'-source-ids.bin',parts:reduced.parts,triangles:reduced.triangles,targetMet:reduced.targetMet,reports:reduced.reports});
   console.log(JSON.stringify({species:p.species,tier:recipe.tier,sourceTriangles:p.wood.indexCount/3,triangles:reduced.triangles,targetMet:reduced.targetMet}));
  }
  prototypes.push({id,species:p.species,nativeMaterials:p.nativeMaterials,tiers});
 }
 const method=await readFile(fileURLToPath(import.meta.url)),manifest={format:'waterworld.forest-lod-wood-pilot',version:1,units:'metres',upAxis:'Y',vertexStride:56,appearanceStatus:'unqualified',source:{manifest:receipt(raw),vertices:m.files['vertices.bin'],indices:m.files['indices.bin'],method:{file:'scripts/prepare-forest-wood-lods.mjs',...receipt(method)},tools:tools.receipt},files,prototypes};
 await writeFile(join(target,'manifest.json'),JSON.stringify(manifest,null,2)+'\n');return manifest;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const options={};for(let i=2;i<process.argv.length;i+=2){const key={'--pack':'pack','--out':'out','--prototype':'prototypeIDs','--meshoptimizer-module':'meshoptimizer'}[process.argv[i]];check(key&&process.argv[i+1]!==undefined,'Usage: --pack SOURCE --out FRESH [--prototype 0,2] [--meshoptimizer-module LOCAL_PINNED]');options[key]=key==='prototypeIDs'?process.argv[i+1].split(',').map(Number):process.argv[i+1];}
 prepareForestWoodLODs(options).catch(error=>{console.error(error.stack);process.exitCode=1;});
}

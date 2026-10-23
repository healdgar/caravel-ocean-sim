#!/usr/bin/env node
// Copyright (c) 2026 Six Cailloux, LLC. MIT.
/** Experimental paged complete native leaf geometry, never botanical fallback.
 * node scripts/prepare-forest-inspection.mjs --pack assets/forest-scenery/saba \
 *   --out /tmp/forest-inspection-FRESH --prototype 0,2 --nodes-per-page 64
 * Original14f/56B records are copied byte-for-byte; float15 is verified native
 * canopyAO. All original complete blades and winding survive spatial grouping.
 * Root executes this offline authoring step and all tests. No growth or GPU job.
 */
import {access,mkdir,mkdtemp,readFile,rename,rm,stat,writeFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {fileURLToPath} from 'node:url';
import {endianness} from 'node:os';
import {gzipSync,gunzipSync} from 'node:zlib';
import {partitionForestLeaves,selectForestClusterFrontier} from './forest-lod-clusters.mjs';

const ROOT=dirname(dirname(fileURLToPath(import.meta.url))),NATIVE_STRIDE=56,STRIDE=60,LEAVES=32;
const requireValue=(ok,message)=>{if(!ok)throw Error(message);};
const uint=n=>Number.isSafeInteger(n)&&n>=0;
export const inspectionReceipt=raw=>({bytes:raw.byteLength,sha256:createHash('sha256').update(raw).digest('hex')});
const same=(a,b)=>a?.bytes===b?.bytes&&a?.sha256===b?.sha256;
const safe=name=>{requireValue(typeof name==='string'&&/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name),'Unsafe source filename');return name;};
const exists=async path=>{try{await access(path);return true;}catch(e){if(e.code==='ENOENT')return false;throw e;}};
const indexBytes=ids=>Buffer.from(ids.buffer,ids.byteOffset,ids.byteLength);

async function readInspectionSource(pack,selected){
 requireValue(endianness()==='LE','Little-endian source records required');
 const path=resolve(pack),manifestPath=(await stat(path)).isDirectory()?join(path,'manifest.json'):path,folder=dirname(manifestPath),manifestRaw=await readFile(manifestPath);
 requireValue(manifestRaw.length<=4*1024*1024,'Oversized source manifest');const m=JSON.parse(manifestRaw);
 requireValue(m.format==='waterworld.forest-instances'&&m.version===2&&m.vertexStride===56&&m.units==='metres'&&m.upAxis==='Y'&&m.materialContract==='gene-surfaces-v3'&&Array.isArray(m.prototypes),'Original native56B forest v2 required');
 const files=new Map(),receipts={},physical=new Map();let sourceBytes=0;
 const read=async(name,item)=>{
  safe(name);requireValue(uint(item?.bytes)&&item.bytes>0&&item.bytes<=256*1024*1024&&/^[a-f0-9]{64}$/.test(item.sha256??''),'Invalid original receipt');
  if(files.has(name)){requireValue(same(receipts[name],item),'Conflicting original receipt');return files.get(name);}
  let raw;
  if(await exists(join(folder,name))){raw=await readFile(join(folder,name));physical.set(name,inspectionReceipt(raw));}
  else{safe(item.gzip?.file);const z=await readFile(join(folder,item.gzip.file));requireValue(same(inspectionReceipt(z),item.gzip),'Encoded source receipt differs');physical.set(item.gzip.file,inspectionReceipt(z));raw=gunzipSync(z,{maxOutputLength:item.bytes});}
  requireValue(same(inspectionReceipt(raw),item),'Decoded source receipt differs: '+name);sourceBytes+=raw.length;requireValue(sourceBytes<=384*1024*1024,'Source exceeds explicit384MiB budget');
  files.set(name,raw);receipts[name]=inspectionReceipt(raw);return raw;
 };
 for(const name of ['vertices.bin','indices.bin','roots.bin'])await read(name,m.files?.[name]);
 const vraw=files.get('vertices.bin'),iraw=files.get('indices.bin');requireValue(vraw.length%56===0&&iraw.length%4===0,'Source geometry alignment differs');
 const vertices=new Float32Array(vraw.buffer.slice(vraw.byteOffset,vraw.byteOffset+vraw.length)),indices=new Uint32Array(iraw.buffer.slice(iraw.byteOffset,iraw.byteOffset+iraw.length));
 const pointer=m.canopyShade;requireValue(pointer?.file==='canopy-shade.json'&&pointer.bytes<=4*1024*1024,'Verified original canopy-shade pointer required');
 const lightRaw=await read(pointer.file,pointer),light=JSON.parse(lightRaw),shade=light.files?.['canopy-shade.bin'];
 requireValue(light.format==='waterworld.native-canopy-light'&&light.version===1&&light.recipe?.version===1&&light.vertexCount===vraw.length/56&&
  shade?.bytes===Math.ceil(light.vertexCount/4)*4&&shade.gzip?.file==='canopy-shade.bin.gz'&&light.source?.method?.file==='scripts/prepare-forest-light.py'&&
  Object.keys(light.source.files??{}).length===3&&Array.isArray(light.prototypes)&&light.prototypes.length===m.prototypes.length,'Invalid original canopy-shade layout');
 for(const name of ['vertices.bin','indices.bin','roots.bin'])requireValue(same(light.source.files[name],m.files[name]),'Canopy-shade native source differs: '+name);
 for(const p of m.prototypes){const own=light.prototypes.find(q=>q.id===p.id);requireValue(own?.species===p.species,'Canopy-shade specimen differs');
  for(const kind of ['wood','leaf']){const r=own.membership?.[kind],expected=p[kind];requireValue(uint(expected?.firstIndex)&&uint(expected.indexCount)&&expected.firstIndex+expected.indexCount<=indices.length&&
   r?.firstIndex===expected.firstIndex&&r.indexCount===expected.indexCount&&same(r.indices,inspectionReceipt(indexBytes(indices.subarray(expected.firstIndex,expected.firstIndex+expected.indexCount)))),'Canopy-shade original membership differs');}}
 const ao=await read('canopy-shade.bin',shade);for(let i=light.vertexCount;i<ao.length;i++)requireValue(ao[i]===255,'Canopy-shade padding must be neutral');
 const prototypes=selected.map(id=>{const p=m.prototypes.find(p=>p.id===id);requireValue(p,'Unknown selected prototype');return p;});
 for(const p of prototypes){safe(p.species);requireValue(p.source?.native?.materialContract==='gene-surfaces-v3'&&Array.isArray(p.nativeMaterials),'Missing native material authority');
  const leaf=p.nativeMaterials.filter(x=>x.name.startsWith('foliage_'));requireValue(leaf.length>0,'Missing original leaf materials');
  for(const material of leaf){requireValue(uint(material.index)&&material.wrap==='clamp','Invalid native leaf material');
   for(const key of ['albedo','normal','roughnessMap'])if(material[key]){const map=material[key];requireValue(same(map,m.files[map.file])&&same(map,p.source.native.maps?.[map.file])&&
    map.encoding===(key==='albedo'?'srgb':'linear')&&uint(map.width)&&map.width>0&&uint(map.height)&&map.height>0,'Native leaf map authority differs');await read(map.file,map);}
   requireValue(material.albedo&&material.normal,'Original leaf pigment/normal maps required');
  }
 }
 return{folder,manifestPath,manifestRaw,manifest:m,vertices,indices,vraw,iraw,ao,files,receipts,physical,prototypes,
  canopyShade:{manifest:{file:pointer.file,...inspectionReceipt(lightRaw)},field:{file:'canopy-shade.bin',...inspectionReceipt(ao)},recipe:light.recipe}};
}

export async function prepareForestInspection({pack,out,prototype=[0,2],nodesPerPage=64,maxDecodedMiB=512,maxEncodedMiB=256,maxTotalMiB=768}){
 requireValue(Array.isArray(prototype)&&prototype.length>0&&prototype.length<=5&&new Set(prototype).size===prototype.length&&prototype.every(uint),'Invalid prototype selection');
 requireValue(uint(nodesPerPage)&&nodesPerPage>=1&&nodesPerPage<=256&&[maxDecodedMiB,maxEncodedMiB,maxTotalMiB].every(n=>uint(n)&&n>=1&&n<=4096),'Unsafe inspection page/data budget');
 const output=resolve(out),source=await readInspectionSource(pack,prototype),rel=relative(source.folder,output);
 requireValue(output!==source.folder&&(rel==='..'||rel.startsWith('..'+sep)||isAbsolute(rel)),'Inspection output must be outside source pack');
 requireValue(!await exists(output),'Fresh output required');await mkdir(dirname(output),{recursive:true});
 const staging=await mkdtemp(join(dirname(output),'.forest-inspection-')),method=await readFile(fileURLToPath(import.meta.url)),helper=await readFile(join(ROOT,'scripts/forest-lod-clusters.mjs'));
 let decodedGPUBytes=0,decodedSourceIDBytes=0,encodedBytes=0;const records=[];
 const emit=async(name,raw,gpu=true)=>{
  if(gpu)decodedGPUBytes+=raw.length;else decodedSourceIDBytes+=raw.length;
  requireValue(decodedGPUBytes+decodedSourceIDBytes<=maxDecodedMiB*1024*1024,'Decoded inspection budget exceeded; no nodes omitted');
  const encoded=gzipSync(raw,{level:9,mtime:0});encodedBytes+=encoded.length;
  requireValue(encodedBytes<=maxEncodedMiB*1024*1024&&encodedBytes+decodedGPUBytes+decodedSourceIDBytes<=maxTotalMiB*1024*1024,'Encoded/combined inspection budget exceeded; no truncation');
  await writeFile(join(staging,name+'.gz'),encoded,{flag:'wx'});return{file:name,...inspectionReceipt(raw),gzip:{file:name+'.gz',...inspectionReceipt(encoded)}};
 };
 try{
  for(const p of source.prototypes){
   const h=partitionForestLeaves(source.vertices,source.indices,p.leaf,{maxLeaves:LEAVES}),frontier=selectForestClusterFrontier(h,LEAVES),prefix='prototype-'+p.id+'-'+p.species;
   await mkdir(join(staging,prefix));const pages=[],clusters=[],leafOrder=await emit(prefix+'/leaf-order.u32.bin',indexBytes(h.leafOrder),false);
   const leafMaterials=p.nativeMaterials.filter(m=>m.name.startsWith('foliage_')),slots=new Set(leafMaterials.map(m=>m.index));
   for(const material of h.leafMaterials)requireValue(slots.has(material),'Hierarchy refers to non-leaf source material');
   for(let firstNode=0;firstNode<frontier.length;firstNode+=nodesPerPage){
    const page=pages.length,vertexParts=[],indices=[],sourceIDs=[],clusterIDs=[];let vertexCount=0;
    for(const nodeID of frontier.slice(firstNode,firstNode+nodesPerPage)){
     const n=h.nodes[nodeID],original=h.orderedIndices.subarray(n.firstIndex,n.firstIndex+n.indexCount),local=new Map(),firstVertex=vertexCount,firstIndex=indices.length,id=clusters.length;
     requireValue(n.leafCount<=32&&n.indexCount===n.leafCount*h.indicesPerLeaf&&n.indexCount<=384,'Inspection node exceeds complete32-blade pull budget');
     for(const global of original){let own=local.get(global);
      if(own===undefined){own=vertexCount++;local.set(global,own);const row=Buffer.alloc(STRIDE);source.vraw.copy(row,0,global*NATIVE_STRIDE,(global+1)*NATIVE_STRIDE);row.writeFloatLE(source.ao[global]/255,56);vertexParts.push(row);sourceIDs.push(global);}
      indices.push(own);
     }
     const ids=new Uint32Array(sourceIDs.slice(firstVertex)),radius=Math.hypot(...n.high.map((v,k)=>(v-n.low[k])*.5));
     requireValue(radius>0,'Degenerate inspection source bounds');
     clusters.push({id,sourceNodeID:n.id,parentNodeID:n.parent,firstLeaf:n.firstLeaf,leafCount:n.leafCount,page,firstVertex,vertexCount:vertexCount-firstVertex,
      firstIndex,indexCount:indices.length-firstIndex,low:n.low.slice(),high:n.high.slice(),centre:n.centre.slice(),radius,extent:radius,
      sourceMembership:{leafIDs:inspectionReceipt(indexBytes(h.leafOrder.subarray(n.firstLeaf,n.firstLeaf+n.leafCount))),
       originalGlobalIndices:inspectionReceipt(indexBytes(original)),originalGlobalVertexIDs:inspectionReceipt(indexBytes(ids))}});clusterIDs.push(id);
    }
    const v=Buffer.concat(vertexParts),i=new Uint32Array(indices),ids=new Uint32Array(sourceIDs),files={
     vertices:await emit(prefix+'/page-'+page+'-vertices.bin',v),indices:await emit(prefix+'/page-'+page+'-indices.bin',indexBytes(i)),
     sourceIDs:await emit(prefix+'/page-'+page+'-source-ids.bin',indexBytes(ids),false)};
    pages.push({index:page,clusterIDs,vertexCount,indexCount:i.length,triangleCount:i.length/3,decodedGPUBytes:v.length+i.byteLength,files});
   }
   records.push({id:p.id,species:p.species,source:p.source,nativeMaterials:leafMaterials,sourceLeafRange:{...p.leaf,indices:inspectionReceipt(indexBytes(source.indices.subarray(p.leaf.firstIndex,p.leaf.firstIndex+p.leaf.indexCount)))},
    biologicalRootXYZ:[0,0,0],groundPlaneY:0,low:h.nodes[0].low,high:h.nodes[0].high,centre:h.nodes[0].centre,leafCount:h.leafCount,leafTriangles:h.leafTriangles,
    hierarchy:{root:h.root,leafOrder,nodes:h.nodes.map(({id,parent,children,firstLeaf,leafCount})=>({id,parent,children,firstLeaf,leafCount}))},
    clusters,pages,triangleCount:p.leaf.indexCount/3,sourceGeometryPolicy:'Every complete source blade appears exactly once in frontier32; no wood or whole-plant fallback'});
  }
  for(const [name,expected]of source.physical)requireValue(same(inspectionReceipt(await readFile(join(source.folder,name))),expected),'Source changed: '+name);
  requireValue((await readFile(source.manifestPath)).equals(source.manifestRaw)&&(await readFile(fileURLToPath(import.meta.url))).equals(method)&&(await readFile(join(ROOT,'scripts/forest-lod-clusters.mjs'))).equals(helper),'Source or authoring method changed');
  const manifest={format:'waterworld.forest-inspection-pilot',version:1,experimental:true,qualified:false,complete:true,units:'metres',upAxis:'Y',vertexStride:60,indexType:'uint32',
   attributes:{originalNativeRecord:{offset:0,bytes:56},position:{offset:0,components:3},normal:{offset:12,components:3},kindShade:{offset:24,components:2},uv:{offset:32,components:2},linearRGB:{offset:40,components:3},nativeMaterial:{offset:52,components:1},canopyAO:{offset:56,components:1}},
   source:{manifest:{file:'manifest.json',...inspectionReceipt(source.manifestRaw)},assetBaseHint:source.folder,files:source.receipts,nativeSource:source.manifest.nativeSource,canopyShade:source.canopyShade,
    methods:[{file:'scripts/prepare-forest-inspection.mjs',...inspectionReceipt(method)},{file:'scripts/forest-lod-clusters.mjs',...inspectionReceipt(helper)}]},
   layout:{maximumLeavesPerCluster:32,maximumTrianglesPerCluster:128,maximumPulledVerticesPerCluster:384,nodesPerPage,
    indices:'Each page uses compact page-local vertex IDs. firstIndex/indexCount refer to that page index stream; original global IDs are parallel sourceIDs provenance.',
    padding:'Stored index ranges are NOT padded. A fixed384 GPU pull must emit a degenerate triangle for every vertex>=indexCount; never read outside its cluster.',
    originalRecords:'Bytes0..55 of every60B row are unchanged source56B; float14 is f32(originalUNORM8CanopyAO/255). Winding, UV and nativeMaterial are unchanged.',
    materials:'Original leaf-only material table/map receipts, referenced through an explicitly supplied sourceBase. No maps copied or inferred.'},
   decodedGPUBytes,decodedSourceIDBytes,encodedBytes,maximumDecodedBytes:maxDecodedMiB*1024*1024,maximumEncodedBytes:maxEncodedMiB*1024*1024,maximumCombinedBytes:maxTotalMiB*1024*1024,prototypes:records,
   limitations:['Experimental streamed inspection leaf tier only. Runtime parent/child cover, pixel qualification, wind and device cost are not established by this export.',
    'All source blades are retained, including localY<0 geometry; native visibility may clip biological soil. No source geometry edits, wood substitution, growth or density shells.',
    'Exact native records preserve source shape; native lighting/coverage and all camera transitions still require rendered comparison.']};
  await writeFile(join(staging,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});requireValue(!await exists(output),'Fresh inspection output occupied');await rename(staging,output);return manifest;
 }catch(e){await rm(staging,{recursive:true,force:true});throw e;}
}

export function parseInspectionArguments(argv){
 const o={},flags={'--pack':'pack','--out':'out','--prototype':'prototype','--nodes-per-page':'nodesPerPage','--max-decoded-mib':'maxDecodedMiB','--max-encoded-mib':'maxEncodedMiB','--max-total-mib':'maxTotalMiB'};
 for(let at=0;at<argv.length;at++){const key=flags[argv[at]];requireValue(key&&at+1<argv.length&&o[key]===undefined,'Expected --pack SOURCE --out FRESH [--prototype 0,2] [--nodes-per-page 64]');const value=argv[++at];o[key]=key==='prototype'?value.split(',').map(Number):key.endsWith('MiB')||key==='nodesPerPage'?Number(value):value;}
 requireValue(o.pack&&o.out,'--pack and --out required');return o;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))prepareForestInspection(parseInspectionArguments(process.argv.slice(2))).then(m=>console.log(JSON.stringify({prototypes:m.prototypes.length,decodedGPUBytes:m.decodedGPUBytes,encodedBytes:m.encodedBytes}))).catch(e=>{console.error(e.stack??e);process.exitCode=1;});

#!/usr/bin/env node
// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Offline index-only reduction of actual native-field intermediate meshes.
import {createHash} from 'node:crypto';
import {access,mkdir,mkdtemp,readFile,rename,rm,writeFile} from 'node:fs/promises';
import {basename,dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {gzipSync,gunzipSync} from 'node:zlib';

const STRIDE=52,MAX_BYTES=256*1024*1024,MAX_ERROR=.4;
const SPECIES=['oak','maple','birch','elm','chestnut'];
const DEFAULT_TOOLS='/tmp/waterworld-meshopt-tools/node_modules/meshoptimizer';
const PIN=Object.freeze({version:'1.3.0',packageSHA256:'7c0b926331466962d22ab250359fcdea20c225ab243d78474b955fb6af23f74c',
 simplifierSHA256:'c3098ee4cb4fc242b84f064c88898e76e44bf58b0e1f693507f323c08cdbb5ed',
 decoderSHA256:'10b313edaa0e322b0c1b46443f6c8b186b42139fe1eca189d50c09511d0ebedc'});
const FLAGS=Object.freeze(['LockBorder']),WEIGHTS=Object.freeze([1,1,1,1,1,1]),FIELD_WEIGHTS=Object.freeze([0,0,0,0,0,0]);
const require=(ok,message)=>{if(!ok)throw Error(message);};
export const middleReceipt=raw=>({bytes:raw.byteLength,sha256:createHash('sha256').update(raw).digest('hex')});
const validReceipt=x=>Number.isSafeInteger(x?.bytes)&&x.bytes>0&&x.bytes<=MAX_BYTES&&/^[a-f0-9]{64}$/.test(x.sha256??'');
const sameReceipt=(a,b)=>a.bytes===b.bytes&&a.sha256===b.sha256;
const uint=n=>Number.isSafeInteger(n)&&n>=0;
const safeName=name=>typeof name==='string'&&name===basename(name)&&name!=='.'&&name!=='..'&&!name.includes('\\');

export async function loadMiddleTools(folder=DEFAULT_TOOLS){
 folder=resolve(folder);
 const [pkg,source,decoder]=await Promise.all(['package.json','meshopt_simplifier.js','meshopt_decoder.mjs'].map(name=>readFile(join(folder,name))));
 require(JSON.parse(pkg).name==='meshoptimizer'&&JSON.parse(pkg).version===PIN.version&&middleReceipt(pkg).sha256===PIN.packageSHA256&&
  middleReceipt(source).sha256===PIN.simplifierSHA256&&middleReceipt(decoder).sha256===PIN.decoderSHA256,'Pinned meshoptimizer1.3.0 bytes differ');
 const [{MeshoptSimplifier:simplifier},{MeshoptDecoder:decode}]=await Promise.all([
  import(pathToFileURL(join(folder,'meshopt_simplifier.js')).href),import(pathToFileURL(join(folder,'meshopt_decoder.mjs')).href)]);
 require(simplifier.supported&&decode.supported,'Pinned meshoptimizer unavailable');await Promise.all([simplifier.ready,decode.ready]);
 return{simplifier,decoder:decode,folder,receipt:{version:PIN.version,package:middleReceipt(pkg),
  simplifier:{file:'meshopt_simplifier.js',...middleReceipt(source)},decoder:{file:'meshopt_decoder.mjs',...middleReceipt(decoder)}}};
}

export function validateMiddleSource(m){
 require(m?.format==='waterworld.native-forest-mass'&&m.version===2&&m.units==='metres'&&m.upAxis==='Y','Expected original native field mass v2');
 require(Array.isArray(m.prototypes)&&m.prototypes.length===5,'Expected five source middle prototypes');
 for(const name of ['middle-vertices.bin','middle-indices.bin']){
  const item=m.files?.[name];require(validReceipt(item),'Missing source middle receipt: '+name);
  if(item.gzip)require(validReceipt(item.gzip)&&safeName(item.gzip.file)&&item.gzip.file===name+'.gz','Unsafe middle gzip receipt');
  if(item.meshopt){const c=item.meshopt,stride=name==='middle-vertices.bin'?52:4,mode=stride===52?'ATTRIBUTES':'INDICES';
   require(validReceipt(c)&&uint(c.count)&&c.count>0&&c.stride===stride&&c.count*stride===item.bytes&&c.mode===mode&&
    (c.filter===undefined||c.filter==='NONE'),'Unsafe lossless middle codec');}
 }
 require(m.files['middle-vertices.bin'].bytes%STRIDE===0&&m.files['middle-indices.bin'].bytes%12===0,'Misaligned source middle streams');
 require(validReceipt(m.source?.nativeFieldManifest)&&validReceipt(m.source?.method)&&m.source.method.file==='scripts/prepare-forest-mass.py'&&
  m.source.nativeFieldRecipe?.version===1,'Missing actual native field source provenance');
 for(const name of ['vertices.bin','indices.bin','roots.bin'])require(validReceipt(m.source?.files?.[name]),'Missing native source receipt: '+name);
 let cursor=0;
 for(const [id,p]of m.prototypes.entries()){
  require(p.id===id&&p.species===SPECIES[id]&&p.firstIndex===cursor&&uint(p.indexCount)&&p.indexCount>0&&p.indexCount%3===0&&
   Number.isFinite(p.lodErrorMetres)&&p.lodErrorMetres>=0,'Invalid contiguous middle prototype range/error');
  cursor+=p.indexCount;
 }
 require(cursor*4===m.files['middle-indices.bin'].bytes,'Incomplete source middle membership');return m;
}

export async function decodeMiddleStream(folder,name,item,tools){
 let raw;
 if(item.gzip){
  const encoded=await readFile(join(folder,item.gzip.file));require(sameReceipt(middleReceipt(encoded),item.gzip),'Encoded middle receipt differs: '+name);
  raw=gunzipSync(encoded,{maxOutputLength:item.meshopt?.bytes??item.bytes});
  if(item.meshopt){const c=item.meshopt;require(sameReceipt(middleReceipt(raw),c),'Middle codec receipt differs: '+name);
   const decoded=new Uint8Array(item.bytes);tools.decoder.decodeGltfBuffer(decoded,c.count,c.stride,raw,c.mode,'NONE');raw=Buffer.from(decoded);}
 }else raw=await readFile(join(folder,name));
 require(sameReceipt(middleReceipt(raw),item),'Decoded middle receipt differs: '+name);return raw;
}

function indicesFrom(raw){
 const result=new Uint32Array(raw.byteLength/4);for(let i=0;i<result.length;i++)result[i]=raw.readUInt32LE(i*4);return result;
}

export function splitMiddlePrototype(p,vertices,indices){
 const groups={wood:[],leaf:[]},count=vertices.byteLength/STRIDE;
 for(let at=p.firstIndex;at<p.firstIndex+p.indexCount;at+=3){
  const tri=[indices[at],indices[at+1],indices[at+2]];
  require(tri.every(id=>uint(id)&&id<count),'Middle triangle outside source vertex buffer');
  const kinds=tri.map(id=>vertices.readFloatLE(id*STRIDE+24));
  require(kinds.every(kind=>kind===kinds[0])&&(kinds[0]===3||kinds[0]===4),'Mixed/non-native wood-leaf triangle');
  groups[kinds[0]===3?'wood':'leaf'].push(...tri);
 }
 for(const kind of ['wood','leaf'])require(groups[kind].length>0,'Missing actual source middle '+kind);
 return Object.fromEntries(Object.entries(groups).map(([kind,ids])=>[kind,new Uint32Array(ids)]));
}

function exactPart(ids,source){
 const map=new Map(),records=[],local=new Uint32Array(ids.length);
 for(let i=0;i<ids.length;i++){
  const row=source.subarray(ids[i]*STRIDE,(ids[i]+1)*STRIDE),key=row.toString('hex');let next=map.get(key);
  if(next===undefined){next=records.length;map.set(key,next);records.push(row);}local[i]=next;
 }
 const rows=Buffer.concat(records),positions=new Float32Array(rows.byteLength/4),attributes=new Float32Array(records.length*6);
 for(let i=0;i<records.length;i++){
  for(let k=0;k<13;k++){const value=rows.readFloatLE(i*STRIDE+k*4);require(Number.isFinite(value),'Nonfinite original middle record');positions[i*13+k]=value;}
  const length=Math.hypot(positions[i*13+3],positions[i*13+4],positions[i*13+5]);
  require(Math.abs(length-1)<.01&&[3,4].includes(positions[i*13+6])&&positions[i*13+7]>=0&&positions[i*13+7]<=1,'Invalid middle normal/kind/exposure');
  for(let k=0;k<3;k++){
   const pigment=positions[i*13+10+k];require(pigment>=0&&pigment<=1,'Invalid source middle pigment');
   attributes[i*6+k]=positions[i*13+3+k];attributes[i*6+3+k]=pigment;
  }
 }
 return{rows,positions,attributes,indices:local};
}

function nonzero(indices,positions){
 const out=new Uint32Array(indices.length);let cursor=0,removed=0;
 require(indices instanceof Uint32Array&&indices.length%3===0,'Invalid simplifier triangle indices');
 for(let at=0;at<indices.length;at+=3){
  const [a,b,c]=indices.subarray(at,at+3);require([a,b,c].every(id=>id<positions.length/13),'Simplified vertex outside original records');
  const u=[0,1,2].map(k=>positions[b*13+k]-positions[a*13+k]),v=[0,1,2].map(k=>positions[c*13+k]-positions[a*13+k]);
  const cross=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]];
  if(cross.every(x=>x===0)){removed++;continue;}
  out[cursor++]=a;out[cursor++]=b;out[cursor++]=c;
 }
 return{indices:out.subarray(0,cursor),removed};
}

function downwardFloat32(value){
 const bytes=new ArrayBuffer(4),f=new Float32Array(bytes),u=new Uint32Array(bytes);f[0]=value;if(f[0]>value)u[0]--;return f[0];
}

export function simplifyMiddleKind(ids,source,simplifier,{targetTriangles,errorMetres,shadingProfile='vertex'}){
 require(uint(targetTriangles)&&targetTriangles>=1&&targetTriangles<=100000&&Number.isFinite(errorMetres)&&errorMetres>0&&errorMetres<=MAX_ERROR,'Unsafe middle reduction target/error');
 require(shadingProfile==='vertex'||shadingProfile==='field','Unsupported middle shading profile');
 const data=exactPart(ids,source),clean=nonzero(data.indices,data.positions);
 const kind=data.positions[6];
 for(let at=6;at<data.positions.length;at+=13)require(data.positions[at]===kind,'Mixed middle part kinds');
 require(shadingProfile!=='field'||kind===4,'Field shading is valid only for native leaf shells');
 const weights=shadingProfile==='field'?FIELD_WEIGHTS:WEIGHTS;
 require(clean.indices.length>=3,'Original middle part has no visible triangles');
 const target=Math.min(clean.indices.length,targetTriangles*3),scale=simplifier.getScale(data.positions,13);
 require(Number.isFinite(scale)&&scale>0,'Undefined source middle position scale');
 const relativeError=downwardFloat32(errorMetres/scale);require(relativeError>0&&Number.isFinite(relativeError),'Unrepresentable middle error bound');
 const inputHash=middleReceipt(data.rows),positionsHash=middleReceipt(new Uint8Array(data.positions.buffer)),attrsHash=middleReceipt(new Uint8Array(data.attributes.buffer)),indicesHash=middleReceipt(new Uint8Array(clean.indices.buffer,clean.indices.byteOffset,clean.indices.byteLength));
 let reduced=clean.indices,reportedRelativeError=0;
 if(target<clean.indices.length)[reduced,reportedRelativeError]=simplifier.simplifyWithAttributes(clean.indices,data.positions,13,data.attributes,6,[...weights],null,target,relativeError,[...FLAGS]);
 const absoluteError=reportedRelativeError*scale;
 require(Number.isFinite(absoluteError)&&absoluteError>=0&&absoluteError<=errorMetres,'Reported middle simplification error exceeds requested metres');
 require(sameReceipt(middleReceipt(data.rows),inputHash)&&sameReceipt(middleReceipt(new Uint8Array(data.positions.buffer)),positionsHash)&&
  sameReceipt(middleReceipt(new Uint8Array(data.attributes.buffer)),attrsHash)&&sameReceipt(middleReceipt(new Uint8Array(clean.indices.buffer,clean.indices.byteOffset,clean.indices.byteLength)),indicesHash),'Simplifier mutated original middle records/indices');
 require(reduced instanceof Uint32Array&&reduced.length<=clean.indices.length,'Invalid middle simplifier result');
 const candidate=nonzero(reduced,data.positions);require(candidate.indices.length>=3,'Middle simplifier erased an entire source part');
 const remap=new Int32Array(data.rows.length/STRIDE).fill(-1),kept=[],resultIndices=new Uint32Array(candidate.indices.length);
 for(let i=0;i<candidate.indices.length;i++){const old=candidate.indices[i];let next=remap[old];if(next<0){next=kept.length;remap[old]=next;kept.push(old);}resultIndices[i]=next;}
 const vertices=Buffer.alloc(kept.length*STRIDE);
 for(let i=0;i<kept.length;i++)data.rows.copy(vertices,i*STRIDE,kept[i]*STRIDE,(kept[i]+1)*STRIDE);
 return{vertices,indices:resultIndices,report:{originalTriangles:ids.length/3,nonzeroInputTriangles:clean.indices.length/3,
  sourceVertexRecords:data.rows.length/STRIDE,triangles:resultIndices.length/3,vertices:kept.length,targetTriangles,targetMet:resultIndices.length/3<=targetTriangles,
  removedInputZeroAreaTriangles:clean.removed,removedOutputZeroAreaTriangles:candidate.removed,positionScaleMetres:scale,
  targetRelativeError:relativeError,reportedRelativeError,reportedErrorMetres:absoluteError,shadingProfile,attributeWeights:[...weights],
  sourceIndices:middleReceipt(new Uint8Array(ids.buffer,ids.byteOffset,ids.byteLength)),retainedVertexRecords:middleReceipt(vertices),
  qualification:shadingProfile==='field'?'Meshoptimizer reported position-only error; GPU leaf shading must sample original native field pigment and gradient normals; no native appearance certificate':
   'Meshoptimizer reported attribute-weighted error only; no Hausdorff, native alpha, colour or appearance certificate'}};
}

function outputBounds(vertices){
 const low=[Infinity,Infinity,Infinity],high=[-Infinity,-Infinity,-Infinity];
 for(let i=0;i<vertices.length;i+=STRIDE)for(let k=0;k<3;k++){const x=vertices.readFloatLE(i+k*4);low[k]=Math.min(low[k],x);high[k]=Math.max(high[k],x);}
 const centre=low.map((v,k)=>(v+high[k])*.5);return{low,high,centre,radius:Math.hypot(...low.map((v,k)=>(high[k]-v)*.5))+.001};
}

export async function simplifyForestMiddle({mass,output,meshoptimizer=DEFAULT_TOOLS,errorMetres=.35,leafTriangles=512,woodTriangles=256,leafShading='vertex'}){
 require(new Uint8Array(new Uint32Array([1]).buffer)[0]===1,'Little-endian host required for exact middle records');
 require(Number.isFinite(errorMetres)&&errorMetres>0&&errorMetres<=MAX_ERROR,'--error-metres must be positive and at most0.4');
 require([leafTriangles,woodTriangles].every(n=>uint(n)&&n>=1&&n<=100000),'Invalid middle triangle target');
 require(leafShading==='vertex'||leafShading==='field','Unsupported --leaf-shading profile');
 const source=resolve(mass),destination=resolve(output),nested=relative(source,destination);
 require(destination!==source&&!(nested!== '..'&&!nested.startsWith('..'+sep)&&!isAbsolute(nested)),'Middle output must be outside source pack');
 try{await access(destination);throw Error('Fresh middle output required');}catch(error){if(error.code!=='ENOENT')throw error;}
 const original=await readFile(join(source,'manifest.json'));require(original.length<=4*1024*1024,'Oversized source mass manifest');
 const m=validateMiddleSource(JSON.parse(original)),tools=await loadMiddleTools(meshoptimizer);
 const vertexRaw=await decodeMiddleStream(source,'middle-vertices.bin',m.files['middle-vertices.bin'],tools);
 const indexRaw=await decodeMiddleStream(source,'middle-indices.bin',m.files['middle-indices.bin'],tools),indices=indicesFrom(indexRaw);
 const vertexHash=middleReceipt(vertexRaw),indexHash=middleReceipt(indexRaw),vertexParts=[],indexParts=[],prototypes=[];
 let vertexCount=0,indexCount=0;
 for(const p of m.prototypes){
  const groups=splitMiddlePrototype(p,vertexRaw,indices),parts={},start=indexCount,localVertices=[];
  for(const kind of ['wood','leaf']){
   const reduced=simplifyMiddleKind(groups[kind],vertexRaw,tools.simplifier,{targetTriangles:kind==='wood'?woodTriangles:leafTriangles,errorMetres,
    shadingProfile:kind==='leaf'?leafShading:'vertex'});
   const localIndices=reduced.indices.slice();for(let i=0;i<localIndices.length;i++)localIndices[i]+=vertexCount;
   parts[kind]={firstIndex:indexCount,indexCount:localIndices.length,simplification:reduced.report};
   vertexParts.push(reduced.vertices);localVertices.push(reduced.vertices);indexParts.push(Buffer.from(localIndices.buffer));
   vertexCount+=reduced.vertices.length/STRIDE;indexCount+=localIndices.length;
  }
  const maximumError=Math.max(parts.wood.simplification.reportedErrorMetres,parts.leaf.simplification.reportedErrorMetres);
  prototypes.push({id:p.id,species:p.species,firstIndex:start,indexCount:indexCount-start,wood:parts.wood,leaf:parts.leaf,
   ...outputBounds(Buffer.concat(localVertices)),lodErrorMetres:p.lodErrorMetres+maximumError,
   source:{firstIndex:p.firstIndex,indexCount:p.indexCount,indices:middleReceipt(indexRaw.subarray(p.firstIndex*4,(p.firstIndex+p.indexCount)*4))},
   simplification:{reportedErrorMetres:maximumError,targetMet:parts.wood.simplification.targetMet&&parts.leaf.simplification.targetMet}});
  console.log(JSON.stringify({species:p.species,wood:parts.wood.simplification,leaf:parts.leaf.simplification}));
 }
 require(sameReceipt(middleReceipt(vertexRaw),vertexHash)&&sameReceipt(middleReceipt(indexRaw),indexHash),'Original middle buffers changed');
 const buffers={'middle-vertices.bin':Buffer.concat(vertexParts),'middle-indices.bin':Buffer.concat(indexParts)};
 await mkdir(dirname(destination),{recursive:true});const staging=await mkdtemp(join(dirname(destination),'.forest-middle-'));
 try{
  const files={};for(const [name,raw]of Object.entries(buffers)){
   require(raw.length>0&&raw.length<=MAX_BYTES,'Reduced middle buffer exceeds GPU budget');const encoded=gzipSync(raw,{level:9,mtime:0});
   require(encoded.length<=100*1024*1024,'Reduced middle file exceeds asset budget');await writeFile(join(staging,name+'.gz'),encoded,{flag:'wx'});
   files[name]={...middleReceipt(raw),gzip:{file:name+'.gz',...middleReceipt(encoded)}};
  }
  const method=await readFile(fileURLToPath(import.meta.url));
  const manifest={format:'waterworld.native-forest-middle',version:1,units:'metres',upAxis:'Y',vertexStride:STRIDE,
   source:{massManifest:{file:'manifest.json',...middleReceipt(original)},
    files:Object.fromEntries(['vertices.bin','indices.bin','roots.bin'].map(name=>[name,m.source.files[name]])),
    middleStreams:{'middle-vertices.bin':vertexHash,'middle-indices.bin':indexHash},
    nativeFieldManifest:m.source.nativeFieldManifest,nativeFieldRecipe:m.source.nativeFieldRecipe,massMethod:m.source.method,
    method:{file:'scripts/simplify-forest-middle.mjs',...middleReceipt(method)},meshoptimizer:tools.receipt},
   recipe:{version:1,api:'simplifyWithAttributes',flags:[...FLAGS],positionStrideFloats:13,attributes:['normalX','normalY','normalZ','linearR','linearG','linearB'],
    attributeWeights:[...WEIGHTS],woodAttributeWeights:[...WEIGHTS],leafAttributeWeights:[...(leafShading==='field'?FIELD_WEIGHTS:WEIGHTS)],leafShading,
    maximumReportedErrorMetres:errorMetres,leafTargetTriangles:leafTriangles,woodTargetTriangles:woodTriangles,
    vertexPolicy:'Index-only simplification and exact52-byte record deduplication/first-use compaction; no updated positions, UVs, normals, pigment or exposure',
    targetPolicy:'Requested triangle targets do not override the reported error limit; unmet targets are retained and reported truthfully',
    zeroAreaPolicy:'Only exactly zero stored-position cross products removed; no tiny nonzero triangles discarded',
    shadingPolicy:leafShading==='field'?'Leaf normal/pigment simplification weights are zero because runtime samples original native 3D field; wood retains vertex normal/pigment weights':
     'Wood and leaves retain vertex normal/pigment simplification weights',
    qualification:'Tool-reported error under the recorded per-part attribute weights, added to source authored LOD footprint; no native appearance certificate'},
   prototypes,files,appearanceErrorSupported:false,validation:null};
  require((await readFile(join(source,'manifest.json'))).equals(original),'Mass manifest changed during middle reduction');
  for(const [name,expected]of [['middle-vertices.bin',vertexHash],['middle-indices.bin',indexHash]])
   require(sameReceipt(middleReceipt(await decodeMiddleStream(source,name,m.files[name],tools)),expected),'Source stream changed during middle reduction');
  await writeFile(join(staging,'manifest.json'),JSON.stringify(manifest,null,2)+'\n',{flag:'wx'});
  try{await access(destination);throw Error('Fresh middle output was occupied');}catch(error){if(error.code!=='ENOENT')throw error;}
  await rename(staging,destination);return manifest;
 }catch(error){await rm(staging,{recursive:true,force:true});throw error;}
}

function parseArguments(argv){
 const options={},names={'--mass':'mass','--output':'output','--meshoptimizer':'meshoptimizer','--error-metres':'errorMetres','--leaf-triangles':'leafTriangles','--wood-triangles':'woodTriangles','--leaf-shading':'leafShading'};
 for(let i=0;i<argv.length;i++){
  const key=names[argv[i]];require(key&&i+1<argv.length&&options[key]===undefined,'Expected --mass SOURCE --output FRESH [--meshoptimizer PINNED_PACKAGE] [--error-metres .35] [--leaf-triangles 512] [--wood-triangles 256] [--leaf-shading vertex|field]');
  const value=argv[++i];options[key]=['errorMetres','leafTriangles','woodTriangles'].includes(key)?Number(value):value;
 }
 require(options.mass&&options.output,'--mass and --output required');return options;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))simplifyForestMiddle(parseArguments(process.argv.slice(2))).catch(error=>{console.error(error.stack??error);process.exitCode=1;});

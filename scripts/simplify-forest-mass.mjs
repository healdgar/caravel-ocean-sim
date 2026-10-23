#!/usr/bin/env node
// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Offline only. Reduce the authored native-leaf mass, never native tree meshes.
// Root must qualify the resulting silhouette, pigment and frame cost before use.
import {createHash} from 'node:crypto';
import {createReadStream,createWriteStream} from 'node:fs';
import {access,copyFile,lstat,mkdir,mkdtemp,open,readFile,rename,rm,writeFile} from 'node:fs/promises';
import {basename,dirname,isAbsolute,join,relative,resolve,sep} from 'node:path';
import {pipeline} from 'node:stream/promises';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {createGzip,gunzipSync} from 'node:zlib';

const PIN=Object.freeze({version:'1.3.0',
 moduleSHA256:'c3098ee4cb4fc242b84f064c88898e76e44bf58b0e1f693507f323c08cdbb5ed',
 packageSHA256:'7c0b926331466962d22ab250359fcdea20c225ab243d78474b955fb6af23f74c'});
const DEFAULT_MODULE='/tmp/waterworld-meshopt-tools/node_modules/meshoptimizer/meshopt_simplifier.js';
const MAX_BUFFER=256*1024*1024,MAX_FILE=100*1024*1024,STRIDE=24;
const ERROR_METRES=.25,TARGET_RATIO=.25,ATTRIBUTE_WEIGHTS=Object.freeze([1,1,1,1,1,1]);
const STREAMS=['vertices.bin','indices.bin','root-chunks.bin','root-neighbors.bin','middle-vertices.bin','middle-indices.bin'];
const require=(ok,message)=>{if(!ok)throw Error(message);};
const sha256=bytes=>createHash('sha256').update(bytes).digest('hex');
const receipt=bytes=>({bytes:bytes.byteLength,sha256:sha256(bytes)});
const isUint=value=>Number.isSafeInteger(value)&&value>=0;
const isReceipt=value=>isUint(value?.bytes)&&value.bytes>0&&/^[a-f0-9]{64}$/.test(value.sha256??'');
const sameReceipt=(a,b)=>a.bytes===b.bytes&&a.sha256===b.sha256;
const vector=(value,size)=>Array.isArray(value)&&value.length===size&&value.every(Number.isFinite);
const safeName=name=>typeof name==='string'&&name===basename(name)&&name!=='.'&&name!=='..'&&!name.includes('\\');
const half=bits=>{const sign=bits&0x8000?-1:1,e=(bits>>10)&31,m=bits&1023;return e===0?sign*m*2**-24:e===31?(m?NaN:sign*Infinity):sign*(1+m/1024)*2**(e-15);};
const planeTolerance=plane=>Math.max(1e-5,Math.abs(Math.fround(plane))*2**-22);

function validateManifest(m){
 require(m?.format==='waterworld.native-forest-mass'&&m.version===2&&m.vertexStride===STRIDE&&m.units==='metres'&&m.upAxis==='Y','Expected compact v2 native forest mass');
 require(!m.simplification,'Input is already simplified; start from the original mass');
 require(m.appearanceErrorSupported===false&&m.validation===null,'Only an explicitly unqualified source mass is accepted');
 require(Array.isArray(m.chunks)&&m.chunks.length>0&&m.chunks.length<=4096&&isUint(m.rootCount),'Invalid mass chunks/root count');
 require(m.files&&Object.keys(m.files).every(name=>STREAMS.includes(name)),'Unknown mass stream: refusing to omit an unhandled asset');
 for(const name of ['vertices.bin','indices.bin','root-chunks.bin'])require(isReceipt(m.files[name]),'Missing mass stream: '+name);
 for(const [name,item]of Object.entries(m.files)){
  require(isReceipt(item)&&item.bytes<=MAX_BUFFER&&isReceipt(item.gzip)&&safeName(item.gzip.file)&&item.gzip.file===name+'.gz','Invalid stream receipt: '+name);
  require(!item.meshopt,'Input must be the original gzip pack, before meshopt transport: '+name);
 }
 require(m.files['vertices.bin'].bytes%STRIDE===0&&m.files['indices.bin'].bytes%12===0&&m.files['root-chunks.bin'].bytes===m.rootCount*4,'Misaligned mass streams');
 require(!m.files['root-neighbors.bin']||m.files['root-neighbors.bin'].bytes===m.rootCount*16,'Invalid neighbor stream');
 require(Boolean(m.prototypes)===Boolean(m.files['middle-vertices.bin'])&&Boolean(m.prototypes)===Boolean(m.files['middle-indices.bin']),'Incomplete original middle streams');
 require(isReceipt(m.source?.nativeFieldManifest)&&isReceipt(m.source?.method)&&m.source.nativeFieldRecipe?.version===1,'Missing original native field provenance');
 for(const name of ['vertices.bin','indices.bin','roots.bin'])require(isReceipt(m.source?.files?.[name]),'Missing original native source receipt: '+name);
 let cursor=0,totalRoots=0;
 for(const [id,p]of m.chunks.entries()){
  require(p.id===id&&p.firstIndex===cursor&&isUint(p.indexCount)&&p.indexCount>0&&p.indexCount%3===0&&isUint(p.rootCount),'Invalid contiguous chunk range: '+id);
  require(vector(p.low,3)&&vector(p.high,3)&&vector(p.centre,3)&&vector(p.nominalBoundsXZ,4)&&Number.isFinite(p.radius)&&p.radius>0&&Number.isFinite(p.lodErrorMetres)&&p.lodErrorMetres>=0,'Invalid chunk bound/error: '+id);
  require(p.low.every((v,k)=>v<=p.high[k])&&p.nominalBoundsXZ[0]<p.nominalBoundsXZ[1]&&p.nominalBoundsXZ[2]<p.nominalBoundsXZ[3],'Inverted chunk bound: '+id);
  cursor+=p.indexCount;totalRoots+=p.rootCount;
 }
 require(cursor*4===m.files['indices.bin'].bytes&&totalRoots===m.residentRootCount&&m.residentRootCount+m.excludedRootCount<=m.rootCount,'Incomplete chunk coverage');
 return m;
}

async function verifiedStream(folder,name,item){
 const encoded=await readFile(join(folder,item.gzip.file));
 require(sameReceipt(receipt(encoded),item.gzip),'Encoded receipt differs: '+name);
 const raw=gunzipSync(encoded,{maxOutputLength:item.bytes});
 require(sameReceipt(receipt(raw),item),'Decoded receipt differs: '+name);
 return raw;
}

async function pinnedSimplifier(modulePath){
 const path=resolve(modulePath);require(basename(path)==='meshopt_simplifier.js','Expected local meshopt_simplifier.js');
 const [moduleRaw,packageRaw]=await Promise.all([readFile(path),readFile(join(dirname(path),'package.json'))]);
 require(sha256(moduleRaw)===PIN.moduleSHA256&&sha256(packageRaw)===PIN.packageSHA256,'Meshoptimizer source differs from pinned 1.3.0');
 require(JSON.parse(packageRaw).version===PIN.version,'Meshoptimizer version differs');
 // Import is deliberately local, after byte verification; never a runtime CDN.
 const {MeshoptSimplifier:simplifier}=await import(pathToFileURL(path).href);
 require(simplifier?.supported,'Pinned meshoptimizer simplifier unsupported');await simplifier.ready;
 return simplifier;
}

function downFloat32(value){
 const bytes=new ArrayBuffer(4),f=new Float32Array(bytes),u=new Uint32Array(bytes);f[0]=value;
 if(f[0]>value)u[0]--;return f[0];
}

function chunkInput(chunk,vertices,indices){
 const map=new Map(),originalIds=[],localIndices=new Uint32Array(chunk.indexCount),count=vertices.byteLength/STRIDE;
 for(let k=0;k<chunk.indexCount;k++){
  const id=indices[chunk.firstIndex+k];require(id<count,'Chunk index outside original vertices: '+chunk.id);
  let local=map.get(id);if(local===undefined){local=originalIds.length;map.set(id,local);originalIds.push(id);}localIndices[k]=local;
 }
 const rows=Buffer.alloc(originalIds.length*STRIDE),attrs=new Float32Array(originalIds.length*6),locks=new Uint8Array(originalIds.length);
 const planes=[[0,chunk.nominalBoundsXZ[0]],[0,chunk.nominalBoundsXZ[1]],[2,chunk.nominalBoundsXZ[2]],[2,chunk.nominalBoundsXZ[3]]];
 let locked=0;
 for(let i=0;i<originalIds.length;i++){
  vertices.copy(rows,i*STRIDE,originalIds[i]*STRIDE,(originalIds[i]+1)*STRIDE);
  const at=i*STRIDE,xyz=[rows.readFloatLE(at),rows.readFloatLE(at+4),rows.readFloatLE(at+8)];
  require(xyz.every(Number.isFinite),'Nonfinite source position: '+chunk.id);
  require(xyz.every((v,k)=>v>=chunk.low[k]-.001&&v<=chunk.high[k]+.001),'Position outside original chunk bound: '+chunk.id);
  require(xyz[0]>=planes[0][1]-.001&&xyz[0]<=planes[1][1]+.001&&xyz[2]>=planes[2][1]-.001&&xyz[2]<=planes[3][1]+.001,'Position outside nominal chunk planes: '+chunk.id);
  const normal=[0,1,2].map(k=>Math.max(-1,rows.readInt8(at+12+k)/127)),length=Math.hypot(...normal);
  require(Number.isFinite(length)&&length>.5&&length<1.5,'Undefined packed source normal: '+chunk.id);
  for(let k=0;k<3;k++)attrs[i*6+k]=normal[k]/length;
  for(let k=0;k<4;k++){
   const value=half(rows.readUInt16LE(at+16+k*2));require(Number.isFinite(value)&&value>=0&&(k!==3||value<=1),'Invalid source linear pigment: '+chunk.id);
   if(k<3)attrs[i*6+3+k]=value;
  }
  if(planes.some(([axis,plane])=>Math.abs(xyz[axis]-plane)<=planeTolerance(plane))){locks[i]=1;locked++;}
 }
 require(rows.byteOffset%4===0,'Unaligned local vertex allocation');
 const positions=new Float32Array(rows.buffer,rows.byteOffset,rows.byteLength/4);
 const clean=nonzeroTriangles(localIndices,positions,chunk.id),active=new Uint8Array(originalIds.length);
 for(const index of clean.indices)active[index]=1;
 // A vertex referenced only by invisible zero-area faces is not a seam point.
 for(let i=0;i<locks.length;i++)if(locks[i]&&!active[i]){locks[i]=0;locked--;}
 return{rows,attrs,locks,locked,indices:clean.indices,positions,planes,removedZeroAreaTriangles:clean.removed};
}

function nonzeroTriangles(indices,positions,id){
 require(indices instanceof Uint32Array&&indices.length>0&&indices.length%3===0,'Invalid triangle list: '+id);
 const count=positions.length/6,output=new Uint32Array(indices.length);let cursor=0,removed=0;
 for(let i=0;i<indices.length;i+=3){
  const a=indices[i],b=indices[i+1],c=indices[i+2];
  require(a<count&&b<count&&c<count,'Triangle address outside vertices: '+id);
  const ux=positions[b*6]-positions[a*6],uy=positions[b*6+1]-positions[a*6+1],uz=positions[b*6+2]-positions[a*6+2];
  const vx=positions[c*6]-positions[a*6],vy=positions[c*6+1]-positions[a*6+1],vz=positions[c*6+2]-positions[a*6+2];
  const x=uy*vz-uz*vy,y=uz*vx-ux*vz,z=ux*vy-uy*vx;
  require(Number.isFinite(x)&&Number.isFinite(y)&&Number.isFinite(z),'Nonfinite triangle: '+id);
  // Stored Float32 world coordinates can collapse an otherwise valid local
  // marching-cubes face. Exact zero area has no raster coverage; no epsilon
  // threshold is used, so every nonzero-area face survives this cleanup.
  if(x===0&&y===0&&z===0){removed++;continue;}
  output[cursor++]=a;output[cursor++]=b;output[cursor++]=c;
 }
 require(cursor>0,'Chunk has no nonzero-area triangles: '+id);
 return{indices:removed?output.subarray(0,cursor):indices,removed};
}

function seamEdges(indices,input,keyFor){
 const {positions,planes}=input;
 const edges=new Map();
 for(let i=0;i<indices.length;i+=3)for(let j=0;j<3;j++){
  const a=indices[i+j],b=indices[i+(j+1)%3];
  if(!planes.some(([axis,plane])=>Math.abs(positions[a*6+axis]-plane)<=planeTolerance(plane)&&Math.abs(positions[b*6+axis]-plane)<=planeTolerance(plane)))continue;
  const ka=keyFor(a),kb=keyFor(b);require(ka!==kb,'Zero-length edge survived exact-area cleanup');
  const key=ka<kb?ka+':'+kb:kb+':'+ka,sign=ka<kb?1:-1,item=edges.get(key);
  if(item){item.count++;item.direction+=sign;}else edges.set(key,{count:1,direction:sign});
  if(!item)edges.get(key).vertices=ka<kb?[a,b]:[b,a];
 }
 // Cancel spatially identical, oppositely directed internal edges even if
 // Float32 quantization gave their coincident endpoints different vertex IDs.
 // Nonzero directed multiplicity remains part of the exact spatial seam.
 for(const [key,item]of edges)if(item.direction===0)edges.delete(key);
 return edges;
}

function verifySeams(before,after,input){
 const keys=new Array(input.locks.length),keyFor=id=>keys[id]??=input.rows.subarray(id*STRIDE,id*STRIDE+12).toString('hex');
 const attributeKey=id=>input.rows.subarray(id*STRIDE+12,id*STRIDE+15).toString('hex')+':'+input.rows.subarray(id*STRIDE+16,id*STRIDE+22).toString('hex');
 const coordinate=id=>Array.from(input.positions.subarray(id*6,id*6+3));
 const oldEdges=seamEdges(before,input,keyFor),newEdges=seamEdges(after,input,keyFor);
 const diagnostics={oldEdges:oldEdges.size,newEdges:newEdges.size,missingEdges:0,addedEdges:0,changedDirections:0,
  lockedPositions:0,missingLockedPositions:0,missingLockedAttributeVariants:0,samples:[]};
 const edgeSample=(type,key,old,next)=>{if(diagnostics.samples.length<4)diagnostics.samples.push({type,positionWords:key,
  coordinates:(old??next).vertices.map(coordinate),oldDirection:old?.direction??0,newDirection:next?.direction??0});};
 for(const [key,item]of oldEdges){const next=newEdges.get(key);if(!next){diagnostics.missingEdges++;edgeSample('missing-edge',key,item,next);}
  else if(next.direction!==item.direction){diagnostics.changedDirections++;edgeSample('changed-direction',key,item,next);}}
 for(const [key,item]of newEdges)if(!oldEdges.has(key)){diagnostics.addedEdges++;edgeSample('added-edge',key,undefined,item);}
 const expected=new Map(),used=new Uint8Array(input.locks.length);
 for(let id=0;id<input.locks.length;id++)if(input.locks[id]){
  const key=keyFor(id);if(!expected.has(key))expected.set(key,new Map());expected.get(key).set(attributeKey(id),id);
 }
 const surviving=new Map();for(const index of after)used[index]=1;
 for(let id=0;id<used.length;id++)if(used[id]){const key=keyFor(id);if(expected.has(key)){
  if(!surviving.has(key))surviving.set(key,new Map());surviving.get(key).set(attributeKey(id),id);
 }}
 diagnostics.lockedPositions=expected.size;
 for(const [key,variants]of expected){const kept=surviving.get(key);
  if(!kept){diagnostics.missingLockedPositions++;if(diagnostics.samples.length<4)diagnostics.samples.push({type:'missing-locked-position',positionWords:key,coordinates:coordinate(variants.values().next().value)});continue;}
  for(const [attribute,id]of variants)if(!kept.has(attribute)){
   diagnostics.missingLockedAttributeVariants++;
   if(diagnostics.samples.length<4){const candidate=kept.values().next().value,normal=input.attrs.subarray(id*6,id*6+3),other=input.attrs.subarray(candidate*6,candidate*6+3);
    diagnostics.samples.push({type:'locked-normal-or-pigment-changed',positionWords:key,coordinates:coordinate(id),
     originalNormalPigmentWords:attribute,survivingNormalPigmentWords:attributeKey(candidate),
     normalAngleDegrees:Math.acos(Math.max(-1,Math.min(1,normal[0]*other[0]+normal[1]*other[1]+normal[2]*other[2])))*180/Math.PI,
     maxLinearRGBDifference:Math.max(...[0,1,2].map(k=>Math.abs(input.attrs[id*6+3+k]-input.attrs[candidate*6+3+k])))});
   }
  }
 }
 return{ok:diagnostics.missingEdges===0&&diagnostics.addedEdges===0&&diagnostics.changedDirections===0&&diagnostics.missingLockedPositions===0&&diagnostics.missingLockedAttributeVariants===0,diagnostics};
}

function compactOriginal(indices,rows){
 const remap=new Int32Array(rows.byteLength/STRIDE).fill(-1),used=[],outputIndices=new Uint32Array(indices.length);
 for(let i=0;i<indices.length;i++){const old=indices[i];let next=remap[old];if(next<0){next=used.length;remap[old]=next;used.push(old);}outputIndices[i]=next;}
 const output=Buffer.alloc(used.length*STRIDE),low=[Infinity,Infinity,Infinity],high=[-Infinity,-Infinity,-Infinity];
 for(let i=0;i<used.length;i++){
  rows.copy(output,i*STRIDE,used[i]*STRIDE,(used[i]+1)*STRIDE);
  for(let k=0;k<3;k++){const value=output.readFloatLE(i*STRIDE+k*4);low[k]=Math.min(low[k],value);high[k]=Math.max(high[k],value);}
 }
 const centre=low.map((v,k)=>(v+high[k])*.5),radius=Math.hypot(...low.map((v,k)=>(high[k]-v)*.5))+.001;
 return{vertices:output,indices:outputIndices,low,high,centre,radius};
}

async function writeAll(file,bytes){
 let offset=0;while(offset<bytes.byteLength){const {bytesWritten}=await file.write(bytes,offset,bytes.byteLength-offset);require(bytesWritten>0,'Short output write');offset+=bytesWritten;}
}

async function fileReceipt(path){
 const hash=createHash('sha256');let bytes=0;for await(const block of createReadStream(path)){hash.update(block);bytes+=block.byteLength;}
 return{bytes,sha256:hash.digest('hex')};
}

async function compressGeometry(folder,name,rawPath){
 const raw=await fileReceipt(rawPath);require(raw.bytes>0&&raw.bytes<=MAX_BUFFER,'Simplified GPU buffer exceeds 256 MiB: '+name);
 const filename=name+'.gz',path=join(folder,filename);
 // No filename/timestamp field: repeat runs on the pinned Node/zlib produce
 // identical gzip bytes. Geometry and triangle sequence are not transformed.
 await pipeline(createReadStream(rawPath),createGzip({level:9,mtime:0}),createWriteStream(path,{flags:'wx'}));
 const compressed=await fileReceipt(path);require(compressed.bytes<=MAX_FILE,'Simplified download exceeds 100 MiB: '+filename);
 await rm(rawPath);return{...raw,gzip:{file:filename,...compressed}};
}

export async function simplifyForestMass({input,output,modulePath=DEFAULT_MODULE,errorMetres=ERROR_METRES,ratio=TARGET_RATIO}){
 require(Number.isFinite(errorMetres)&&errorMetres>0&&errorMetres<=ERROR_METRES,'--error-metres must be positive and at most 0.25');
 require(Number.isFinite(ratio)&&ratio>0&&ratio<=1,'--ratio must be positive and at most 1');
 require(new Uint8Array(new Uint32Array([1]).buffer)[0]===1,'Little-endian host required for exact source records');
 const source=resolve(input),destination=resolve(output),inside=relative(source,destination);
 require(destination!==source&&!(!inside.startsWith('..'+sep)&&inside!=='..'&&!isAbsolute(inside)),'Output must be outside the source pack');
 try{await lstat(destination);throw Error('Output must be fresh');}catch(error){if(error.code!=='ENOENT')throw error;}
 const originalRaw=await readFile(join(source,'manifest.json')),manifest=validateManifest(JSON.parse(originalRaw));
 const simplifier=await pinnedSimplifier(modulePath);
 // Sequential decode bounds transient memory; the two source geometry buffers
 // remain immutable throughout every chunk simplification.
 const vertices=await verifiedStream(source,'vertices.bin',manifest.files['vertices.bin']);
 const indexBytes=await verifiedStream(source,'indices.bin',manifest.files['indices.bin']);
 require(indexBytes.byteOffset%4===0,'Unaligned source indices');
 const indices=new Uint32Array(indexBytes.buffer,indexBytes.byteOffset,indexBytes.byteLength/4);
 const ownerBytes=await verifiedStream(source,'root-chunks.bin',manifest.files['root-chunks.bin']),owners=new Uint32Array(ownerBytes.buffer,ownerBytes.byteOffset,ownerBytes.byteLength/4),counts=new Uint32Array(manifest.chunks.length);
 for(const owner of owners){if(owner===0xffffffff)continue;require(owner<counts.length,'Invalid original owner');counts[owner]++;}
 for(const chunk of manifest.chunks)require(counts[chunk.id]===chunk.rootCount,'Original owner table disagrees with chunk coverage');
 await mkdir(dirname(destination),{recursive:true});const staging=await mkdtemp(join(dirname(destination),'.forest-mass-simplify-'));
 let vertexFile,indexFile;
 try{
  const vertexPath=join(staging,'.vertices.raw'),indexPath=join(staging,'.indices.raw');
  vertexFile=await open(vertexPath,'wx');indexFile=await open(indexPath,'wx');
  const chunks=[],positionsHash=createHash('sha256');let vertexCount=0,indexCount=0,maxError=0,removedInputZeroAreaTriangles=0,removedOutputZeroAreaTriangles=0,fallbackChunks=0;
  for(const chunk of manifest.chunks){
   const data=chunkInput(chunk,vertices,indices),unchanged=sha256(data.rows),indexDigest=sha256(new Uint8Array(data.indices.buffer)),scale=simplifier.getScale(data.positions,6);
   require(Number.isFinite(scale)&&scale>0,'Undefined simplifier position scale: '+chunk.id);
   const targetIndexCount=Math.max(3,Math.floor(data.indices.length*ratio/3)*3),relativeTarget=downFloat32(errorMetres/scale);
   require(relativeTarget>0&&Number.isFinite(relativeTarget),'Unrepresentable simplifier error target: '+chunk.id);
   const [reduced,reportedRelativeError]=simplifier.simplifyWithAttributes(data.indices,data.positions,6,data.attrs,6,[...ATTRIBUTE_WEIGHTS],data.locks,targetIndexCount,relativeTarget,['LockBorder']);
   const absoluteError=reportedRelativeError*scale;
   require(Number.isFinite(absoluteError)&&absoluteError>=0&&absoluteError<=errorMetres,'Reported simplification error exceeds requested metres: '+chunk.id);
   require(reduced.length<=data.indices.length&&sha256(data.rows)===unchanged&&sha256(new Uint8Array(data.indices.buffer))===indexDigest,'Simplifier mutated original input: '+chunk.id);
   const clean=nonzeroTriangles(reduced,data.positions,chunk.id),seamCheck=verifySeams(data.indices,clean.indices,data);
   const fallback=seamCheck.ok?null:{reason:'Exact spatial seam/locked normal-pigment preservation failed; original nonzero input retained',candidateIndexCount:clean.indices.length,diagnostics:seamCheck.diagnostics};
   const appliedError=fallback?0:absoluteError,result=compactOriginal(fallback?data.indices:clean.indices,data.rows);
   if(fallback){fallbackChunks++;console.warn(JSON.stringify({chunk:chunk.id,fallback}));}
   require((vertexCount+result.vertices.length/STRIDE)*STRIDE<=MAX_BUFFER&&(indexCount+result.indices.length)*4<=MAX_BUFFER,'Simplified geometry exceeds GPU buffer budget');
   // Keep the simplifier's triangle order and winding exactly as returned; only
   // vertex identifiers change through a first-use, byte-preserving compaction.
   for(let i=0;i<result.indices.length;i++)result.indices[i]+=vertexCount;
   await writeAll(vertexFile,result.vertices);await writeAll(indexFile,new Uint8Array(result.indices.buffer));
   const positionBytes=Buffer.alloc(result.vertices.length/STRIDE*12);
   for(let i=0;i<result.vertices.length/STRIDE;i++)result.vertices.copy(positionBytes,i*12,i*STRIDE,i*STRIDE+12);
   positionsHash.update(positionBytes);
   chunks.push({...chunk,firstIndex:indexCount,indexCount:result.indices.length,low:result.low,high:result.high,centre:result.centre,radius:result.radius,
    lodErrorMetres:chunk.lodErrorMetres+appliedError,simplification:{originalIndexCount:chunk.indexCount,nonzeroInputIndexCount:data.indices.length,targetIndexCount,resultIndexCount:result.indices.length,
     removedInputZeroAreaTriangles:data.removedZeroAreaTriangles,removedOutputZeroAreaTriangles:clean.removed,
     originalVertexCount:data.rows.length/STRIDE,resultVertexCount:result.vertices.length/STRIDE,lockedNominalVertices:data.locked,nominalSeamEdges:seamCheck.diagnostics.oldEdges,
     seamCheck:seamCheck.diagnostics,fallback,positionScaleMetres:scale,targetRelativeError:relativeTarget,reportedRelativeError,
     candidateReportedAbsoluteErrorMetres:absoluteError,reportedAbsoluteErrorMetres:appliedError,
     errorQualification:'Meshoptimizer attribute-weighted estimate; not a Hausdorff or native appearance certificate'}});
   vertexCount+=result.vertices.length/STRIDE;indexCount+=result.indices.length;maxError=Math.max(maxError,appliedError);
   removedInputZeroAreaTriangles+=data.removedZeroAreaTriangles;removedOutputZeroAreaTriangles+=clean.removed;
   console.log(JSON.stringify({chunk:chunk.id+1,chunks:manifest.chunks.length,sourceTriangles:chunk.indexCount/3,triangles:result.indices.length/3,removedInputZeroAreaTriangles:data.removedZeroAreaTriangles,removedOutputZeroAreaTriangles:clean.removed,reportedErrorMetres:appliedError,fallback:Boolean(fallback)}));
  }
  await vertexFile.close();vertexFile=null;await indexFile.close();indexFile=null;
  const files={...manifest.files};
  files['vertices.bin']=await compressGeometry(staging,'vertices.bin',vertexPath);
  files['indices.bin']=await compressGeometry(staging,'indices.bin',indexPath);
  for(const [name,item]of Object.entries(manifest.files))if(name!=='vertices.bin'&&name!=='indices.bin'){
   // Verify both receipts, then copy original transport bytes: owner, neighbor
   // and intermediate meshes retain their exact source identities and encoding.
   await verifiedStream(source,name,item);require(item.gzip.bytes<=MAX_FILE,'Preserved file exceeds 100 MiB: '+name);
   await copyFile(join(source,item.gzip.file),join(staging,item.gzip.file));
   require(sameReceipt(await fileReceipt(join(staging,item.gzip.file)),item.gzip),'Preserved transport changed: '+name);
  }
  const tool=await readFile(fileURLToPath(import.meta.url));
  const outputManifest={...manifest,chunks,files,quantization:{...manifest.quantization,
   positions:'Surviving original Float32 XYZ and all compact vertex records copied byte-for-byte',
   implicitAttributes:'kind4, exposure.8, UV0; seam-locked index-only simplification',positionSHA256:positionsHash.digest('hex')},
   simplification:{version:1,method:{file:'scripts/simplify-forest-mass.mjs',...receipt(tool)},inputManifest:receipt(originalRaw),inputFiles:manifest.files,
    meshoptimizer:{version:PIN.version,module:'meshopt_simplifier.js',sha256:PIN.moduleSHA256,packageSHA256:PIN.packageSHA256},
    runtime:{node:process.version,zlib:process.versions.zlib},api:'simplifyWithAttributes',flags:['LockBorder'],positionStrideFloats:6,
    attributes:['unitNormalX','unitNormalY','unitNormalZ','linearRed','linearGreen','linearBlue'],attributeWeights:[...ATTRIBUTE_WEIGHTS],
    targetRatio:ratio,maximumReportedErrorMetres:errorMetres,actualMaximumReportedErrorMetres:maxError,
    removedInputZeroAreaTriangles,removedOutputZeroAreaTriangles,fallbackChunks,
    degeneratePolicy:'Remove only faces whose stored Float32-position cross product is exactly zero before/after simplification, preserving every nonzero-area face regardless of size. Compare seams against the exact-nonzero input; reject invalid addresses and nonfinite values',
    seamPolicy:'Lock vertices within max(1e-5, abs(Float32(plane))*2^-22) m of nominal XZ planes; compare directed edges by exact original XYZ bytes, locked XYZ survival and packed normal/RGB variants separately. Failed candidates retain original nonzero geometry and report diagnostics',
    vertexPolicy:'No updates, welding, filters, moved positions, attribute rewriting or triangle rotations; compact surviving original 24-byte records in returned index first-use order',
    sourceTriangles:indices.length/3,triangles:indexCount/3,vertices:vertexCount,
    qualification:'Reported attribute-weighted simplifier error is added to each authored sampling footprint. No native silhouette, alpha, colour or appearance certificate; rendered before/after validation required'},
   appearanceErrorSupported:false,validation:null};
  const encoded=Buffer.from(JSON.stringify(outputManifest,null,2)+'\n');require(encoded.length<=MAX_FILE,'Output manifest exceeds file budget');
  await writeFile(join(staging,'manifest.json'),encoded,{flag:'wx'});
  try{await access(destination);throw Error('Output appeared during simplification');}catch(error){if(error.code!=='ENOENT')throw error;}
  await rename(staging,destination);
  console.log(JSON.stringify({output:destination,sourceTriangles:indices.length/3,triangles:indexCount/3,removedInputZeroAreaTriangles,removedOutputZeroAreaTriangles,fallbackChunks,maximumReportedErrorMetres:maxError,files}));
  return outputManifest;
 }catch(error){await vertexFile?.close();await indexFile?.close();await rm(staging,{recursive:true,force:true});throw error;}
}

function argumentsFor(argv){
 const options={};for(let i=0;i<argv.length;i++){
  const name=argv[i];require(['--input','--output','--meshoptimizer-module','--error-metres','--ratio'].includes(name)&&i+1<argv.length,'Usage: node scripts/simplify-forest-mass.mjs --input ORIGINAL_PACK --output FRESH_PACK [--error-metres .25] [--ratio .25] [--meshoptimizer-module LOCAL_PINNED_JS]');
  const key={'--input':'input','--output':'output','--meshoptimizer-module':'modulePath','--error-metres':'errorMetres','--ratio':'ratio'}[name];
  require(options[key]===undefined,'Duplicate option: '+name);const value=argv[++i];options[key]=key==='errorMetres'||key==='ratio'?Number(value):value;
 }
 require(options.input&&options.output,'Both --input and --output are required');return options;
}
if(process.argv[1]&&resolve(process.argv[1])===fileURLToPath(import.meta.url))simplifyForestMass(argumentsFor(process.argv.slice(2))).catch(error=>{console.error(error.stack??error);process.exitCode=1;});

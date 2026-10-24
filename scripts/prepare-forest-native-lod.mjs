#!/usr/bin/env node
// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Packs verified 5-species reduced woody LOD tiers and preauthored 2-triangle
// curved leaf ribbons into a single global index stream addressing the
// immutable assets/forest-scenery/saba/vertices.bin and canopy-shade.bin.
import {readFile,mkdir,writeFile} from 'node:fs/promises';
import {dirname,join,resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
import {gunzipSync,gzipSync} from 'node:zlib';
import {reduceForestLeafRibbons} from '../js/forest-leaf-ribbons.js';

const root=dirname(dirname(fileURLToPath(import.meta.url)));
const args={};
for(let i=2;i<process.argv.length;i+=2){
 const key={'--source':'source','--wood':'wood','--out':'out'}[process.argv[i]];
 if(!key||!process.argv[i+1])throw Error('Usage: node scripts/prepare-forest-native-lod.mjs --wood DIR [--source DIR] [--out DIR]');
 args[key]=process.argv[i+1];
}
if(!args.wood)throw Error('Prepared 5-species woody LOD directory (--wood) is required');

const sourceDir=resolve(args.source??join(root,'assets/forest-scenery/saba'));
const woodDir=resolve(args.wood);
const outDir=resolve(args.out??join(sourceDir,'lod'));

const receipt=bytes=>({bytes:bytes.byteLength,sha256:createHash('sha256').update(bytes).digest('hex')});
const upwardFloat32=value=>{
 const n=Math.fround(value);if(n>=value)return n;
 const b=new ArrayBuffer(4),f=new Float32Array(b),u=new Uint32Array(b);f[0]=n;u[0]++;return f[0];
};
async function readStream(dir,name,item){
 const raw=await readFile(join(dir,item.gzip?item.gzip.file:name));
 const bytes=item.gzip?gunzipSync(raw):raw;
 const r=receipt(bytes);
 if(r.bytes!==item.bytes||r.sha256!==item.sha256)throw Error(`Stream digest mismatch for ${name}`);
 return bytes;
}

const sourceManifestBytes=await readFile(join(sourceDir,'manifest.json'));
const sourceManifest=JSON.parse(sourceManifestBytes.toString('utf8'));
const woodManifestBytes=await readFile(join(woodDir,'manifest.json'));
const woodManifest=JSON.parse(woodManifestBytes.toString('utf8'));

if(sourceManifest.format!=='waterworld.forest-instances'||sourceManifest.version!==2||sourceManifest.vertexStride!==56)throw Error('Expected v2 56-byte native forest source manifest');
if(woodManifest.format!=='waterworld.forest-lod-wood-pilot'||woodManifest.version!==1||woodManifest.prototypes.length!==sourceManifest.prototypes.length)throw Error('Expected matching 5-species woody LOD manifest');

const verticesBytes=await readStream(sourceDir,'vertices.bin',sourceManifest.files['vertices.bin']);
const indicesBytes=await readStream(sourceDir,'indices.bin',sourceManifest.files['indices.bin']);
const vertices=new Float32Array(verticesBytes.buffer,verticesBytes.byteOffset,verticesBytes.byteLength/4);
const indices=new Uint32Array(indicesBytes.buffer,indicesBytes.byteOffset,indicesBytes.byteLength/4);
const vertexCount=verticesBytes.byteLength/56;

const methodScriptBytes=await readFile(fileURLToPath(import.meta.url));
const woodModuleBytes=await readFile(join(root,'scripts/prepare-forest-wood-lods.mjs'));
const ribbonModuleBytes=await readFile(join(root,'js/forest-leaf-ribbons.js'));

const chunks=[];
let cursor=0;
const prototypes=[];

for(const p of sourceManifest.prototypes){
 const wp=woodManifest.prototypes.find(q=>q.id===p.id&&q.species===p.species);
 if(!wp||!Array.isArray(wp.tiers)||wp.tiers.length!==3)throw Error(`Missing 3 woody tiers for prototype ${p.id} (${p.species})`);
 const woodTiers=[];
 for(const wt of wp.tiers){
  const localIndicesBytes=await readStream(woodDir,wt.indices,woodManifest.files[wt.indices]);
  const sourceIDsBytes=await readStream(woodDir,wt.sourceVertexIDs,woodManifest.files[wt.sourceVertexIDs]);
  const localIndices=new Uint32Array(localIndicesBytes.buffer,localIndicesBytes.byteOffset,localIndicesBytes.byteLength/4);
  const sourceIDs=new Uint32Array(sourceIDsBytes.buffer,sourceIDsBytes.byteOffset,sourceIDsBytes.byteLength/4);
  const globalWood=new Uint32Array(localIndices.length);
  for(let i=0;i<localIndices.length;i++){
   const local=localIndices[i];if(local>=sourceIDs.length)throw Error('Woody local index out of range');
   const global=sourceIDs[local];if(global>=vertexCount||vertices[global*14+6]!==3)throw Error('Woody global vertex is not native wood');
   globalWood[i]=global;
  }
  for(let i=0;i<globalWood.length;i+=3){
   const m0=vertices[globalWood[i]*14+13],m1=vertices[globalWood[i+1]*14+13],m2=vertices[globalWood[i+2]*14+13];
   if(m0!==m1||m0!==m2||m0<0||m0>=p.nativeMaterials.length)throw Error('Woody triangle crosses native material groups');
  }
  const firstIndex=cursor,indexCount=globalWood.length,bytes=new Uint8Array(globalWood.buffer,globalWood.byteOffset,globalWood.byteLength);
  chunks.push(bytes);cursor+=indexCount;
  const maxErr=Math.max(...wt.reports.map(r=>r.reportedErrorMetres));
  woodTiers.push({
   tier:wt.tier,
   targetTriangles:wt.recipe.targetTriangles,
   targetErrorMetres:wt.recipe.errorMetres,
   maximumReportedErrorMetres:upwardFloat32(maxErr),
   firstIndex,
   indexCount,
   triangles:indexCount/3,
   originalTriangles:p.wood.indexCount/3,
   parts:wt.parts.map((part,idx)=>({
    material:part.material,
    firstIndex:firstIndex+part.firstIndex,
    indexCount:part.indexCount,
    triangles:part.indexCount/3,
    reportedErrorMetres:upwardFloat32(wt.reports[idx].reportedErrorMetres),
   })),
   indices:receipt(bytes),
  });
 }

 const ribbon=reduceForestLeafRibbons(vertices,indices,p.leaf,{vertexStride:14});
 for(let i=0;i<ribbon.indices.length;i+=3){
  const g0=ribbon.indices[i],g1=ribbon.indices[i+1],g2=ribbon.indices[i+2];
  if(g0>=vertexCount||g1>=vertexCount||g2>=vertexCount)throw Error('Ribbon global vertex out of range');
  if(vertices[g0*14+6]<4||vertices[g1*14+6]<4||vertices[g2*14+6]<4)throw Error('Ribbon vertex is not native foliage');
  const m0=vertices[g0*14+13],m1=vertices[g1*14+13],m2=vertices[g2*14+13];
  if(m0!==m1||m0!==m2||m0<0||m0>=p.nativeMaterials.length)throw Error('Ribbon triangle crosses native material groups');
 }
 const leafFirstIndex=cursor,leafIndexCount=ribbon.indices.length;
 const leafBytes=new Uint8Array(ribbon.indices.buffer,ribbon.indices.byteOffset,ribbon.indices.byteLength);
 chunks.push(leafBytes);cursor+=leafIndexCount;

 const farSlice=indices.subarray(p.far.firstIndex,p.far.firstIndex+p.far.indexCount);
 const farFirstIndex=cursor,farIndexCount=farSlice.length;
 const farBytes=new Uint8Array(farSlice.buffer,farSlice.byteOffset,farSlice.byteLength);
 chunks.push(farBytes);cursor+=farIndexCount;

 prototypes.push({
  id:p.id,
  species:p.species,
  woodTiers,
  leafRibbons:{
   firstIndex:leafFirstIndex,
   indexCount:leafIndexCount,
   triangles:ribbon.ribbonTriangles,
   leafCount:ribbon.leafCount,
   originalFirstIndex:p.leaf.firstIndex,
   originalIndexCount:p.leaf.indexCount,
   originalTriangles:ribbon.originalTriangles,
   maximumPositionErrorMetres:ribbon.maximumPositionErrorMetres,
   maximumPositionErrorUpperMetres:ribbon.maximumPositionErrorUpperMetres,
   indices:receipt(leafBytes),
  },
  far:{
   firstIndex:farFirstIndex,
   indexCount:farIndexCount,
   triangles:farIndexCount/3,
   originalFirstIndex:p.far.firstIndex,
   originalIndexCount:p.far.indexCount,
   indices:receipt(farBytes),
  },
 });
}

const totalBytes=cursor*4,combined=new Uint8Array(totalBytes);
let offset=0;
for(const chunk of chunks){combined.set(chunk,offset);offset+=chunk.byteLength;}
const encoded=gzipSync(combined,{level:9,mtime:0});

await mkdir(outDir,{recursive:true});
const streamFile='lod-indices.bin',gzipFile='lod-indices.bin.gz';
await writeFile(join(outDir,gzipFile),encoded);

const manifest={
 format:'waterworld.forest-native-lod',
 version:1,
 units:'metres',
 upAxis:'Y',
 appearanceErrorSupported:false,
 indexCount:cursor,
 source:{
  files:{
   'vertices.bin':sourceManifest.files['vertices.bin'],
   'indices.bin':sourceManifest.files['indices.bin'],
   'roots.bin':sourceManifest.files['roots.bin'],
  },
  canopyShade:sourceManifest.canopyShade,
  woodManifest:receipt(woodManifestBytes),
  methods:{
   'scripts/prepare-forest-native-lod.mjs':{file:'scripts/prepare-forest-native-lod.mjs',...receipt(methodScriptBytes)},
   'scripts/prepare-forest-wood-lods.mjs':{file:'scripts/prepare-forest-wood-lods.mjs',...receipt(woodModuleBytes)},
   'js/forest-leaf-ribbons.js':{file:'js/forest-leaf-ribbons.js',...receipt(ribbonModuleBytes)},
  },
 },
 files:{
  [streamFile]:{
   indexCount:cursor,
   ...receipt(combined),
   gzip:{
    file:gzipFile,
    ...receipt(encoded),
   },
  },
 },
 prototypes,
};
const manifestText=JSON.stringify(manifest,null,2)+'\n';
await writeFile(join(outDir,'manifest.json'),manifestText);
console.log(JSON.stringify({
 outDir,
 indexCount:cursor,
 rawBytes:combined.byteLength,
 gzipBytes:encoded.byteLength,
 prototypes:prototypes.map(p=>({
  id:p.id,
  species:p.species,
  woodTiers:p.woodTiers.map(t=>({tier:t.tier,triangles:t.triangles,errorMetres:t.maximumReportedErrorMetres})),
  leafRibbons:{triangles:p.leafRibbons.triangles,originalTriangles:p.leafRibbons.originalTriangles,errorMetres:p.leafRibbons.maximumPositionErrorUpperMetres},
 })),
},null,2));

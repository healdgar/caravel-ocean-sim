// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {gzipSync} from 'node:zlib';
import {FOREST_MIDDLE_ASSETS,loadForestMiddle} from '../js/forest-middle.js';
const middleReceipt=bytes=>({bytes:bytes.byteLength,sha256:createHash('sha256').update(bytes).digest('hex')});
function fixture(){
 const vertices=new Float32Array([[-1,0,0],[1,0,0],[0,1,0],[-1,1,0],[1,1,0],[0,2,0]].flatMap((p,i)=>[...p,0,0,1,i<3?3:4,.8,0,0,.1,.3,.1])),indices=new Uint32Array([0,1,2,3,4,5]);
 const forest={files:Object.fromEntries(['vertices.bin','indices.bin','roots.bin'].map((name,i)=>[name,middleReceipt(Buffer.alloc([1120,48,96][i]))])),prototypes:[{id:0,species:'oak'}]};
 const mass={files:{'middle-vertices.bin':middleReceipt(Buffer.alloc(624)),'middle-indices.bin':middleReceipt(Buffer.alloc(48))},source:{files:structuredClone(forest.files),
  nativeFieldManifest:middleReceipt(Buffer.from('original leaf-area field manifest')),method:{file:'scripts/prepare-forest-mass.py',...middleReceipt(Buffer.from('original mass source'))}},
  prototypes:[{id:0,species:'oak',firstIndex:0,indexCount:12,lodErrorMetres:2}]};
 const p={id:0,species:'oak',firstIndex:0,indexCount:6,low:[-1,0,0],high:[1,2,0],centre:[0,1,0],radius:Math.sqrt(2)+.001,lodErrorMetres:2.1,
  source:{firstIndex:0,indexCount:12,indices:structuredClone(mass.files['middle-indices.bin'])},simplification:{reportedErrorMetres:.1,targetMet:true}};
 for(const [kind,firstIndex,error]of [['wood',0,.05],['leaf',3,.1]])p[kind]={firstIndex,indexCount:3,simplification:{originalTriangles:2,nonzeroInputTriangles:2,triangles:1,vertices:3,targetTriangles:1,targetMet:true,reportedErrorMetres:error}};
 const manifest={format:'waterworld.native-forest-middle',version:1,units:'metres',upAxis:'Y',vertexStride:52,appearanceErrorSupported:false,validation:null,
  source:{files:structuredClone(forest.files),middleStreams:structuredClone(mass.files),massManifest:{file:'manifest.json',...middleReceipt(Buffer.from('original raw mass manifest, before transport packaging'))},
   nativeFieldManifest:structuredClone(mass.source.nativeFieldManifest),massMethod:structuredClone(mass.source.method),method:{file:'scripts/simplify-forest-middle.mjs',...middleReceipt(Buffer.from('source middle reducer'))},
   meshoptimizer:{version:'1.3.0',package:{bytes:1,sha256:'7c0b926331466962d22ab250359fcdea20c225ab243d78474b955fb6af23f74c'},
    simplifier:{file:'meshopt_simplifier.js',bytes:1,sha256:'c3098ee4cb4fc242b84f064c88898e76e44bf58b0e1f693507f323c08cdbb5ed'},decoder:{file:'meshopt_decoder.mjs',bytes:1,sha256:'10b313edaa0e322b0c1b46443f6c8b186b42139fe1eca189d50c09511d0ebedc'}}},
  recipe:{version:1,api:'simplifyWithAttributes',flags:['LockBorder'],maximumReportedErrorMetres:.35},prototypes:[p],files:{}};
 const f={forest,mass,manifest,raw:{'middle-vertices.bin':new Uint8Array(vertices.buffer),'middle-indices.bin':new Uint8Array(indices.buffer)},encoded:{},requests:[],assets:{'manifest.json':'middle.json','middle-vertices.bin.gz':'vertices.gz','middle-indices.bin.gz':'indices.gz'}};
 f.refreshBinary=()=>{for(const [name,raw]of Object.entries(f.raw)){const encoded=gzipSync(raw);f.encoded[name]=encoded;manifest.files[name]={...middleReceipt(raw),gzip:{file:name+'.gz',...middleReceipt(encoded)}};}};
 f.refreshJSON=()=>{f.json=Buffer.from(JSON.stringify(manifest));f.pointer={file:'middle/manifest.json',...middleReceipt(f.json)};forest.middle=f.pointer;};
 f.fetchAsset=async name=>{f.requests.push(name);const bytes=name==='middle.json'?f.json:name==='vertices.gz'?f.encoded['middle-vertices.bin']:name==='indices.gz'?f.encoded['middle-indices.bin']:null;return bytes?new Response(Uint8Array.from(bytes)):new Response(null,{status:404});};
 f.load=()=>loadForestMiddle({forest:f.forest,mass:f.mass,assets:f.assets,fetchAsset:f.fetchAsset});f.refreshBinary();f.refreshJSON();return f;
}

test('missing intermediate pack is neutral without fetching; verified pack preserves original retained records and ranges',async()=>{
 let fetches=0;assert.equal(await loadForestMiddle({forest:{},fetchAsset:async()=>{fetches++;throw Error('unexpected fetch');}}),null);assert.equal(fetches,0);
 const f=fixture(),pack=await f.load();assert.equal(pack.sourceValidated,true);assert.deepEqual(f.requests,['middle.json','vertices.gz','indices.gz']);
 assert.deepEqual(new Uint8Array(pack.vertices.buffer),f.raw['middle-vertices.bin']);assert.deepEqual(new Uint8Array(pack.indices.buffer),f.raw['middle-indices.bin']);
 assert.equal(pack.prototypes,pack.manifest.prototypes);assert.equal(pack.prototypes[0].wood.indexCount,3);assert.equal(pack.prototypes[0].leaf.firstIndex,3);assert.equal(pack.prototypes[0].lodErrorMetres,2.1);
 assert.deepEqual(FOREST_MIDDLE_ASSETS,{'manifest.json':'assets/forest-scenery/saba/middle/manifest.json','middle-vertices.bin.gz':'assets/forest-scenery/saba/middle/middle-vertices.bin.gz','middle-indices.bin.gz':'assets/forest-scenery/saba/middle/middle-indices.bin.gz'});
 assert.equal(await loadForestMiddle({forest:f.forest,receipt:null,fetchAsset:async()=>{throw Error('unexpected fetch');}}),null);
});

test('native and original decoded middle receipts bind lineage across repackaged runtime mass manifests',async()=>{
 const f=fixture();f.mass.files['middle-vertices.bin'].gzip={file:'different-lossless-transport.gz',bytes:1,sha256:'0'.repeat(64)};
 f.manifest.source.massManifest=middleReceipt(Buffer.from('informational source identity differs from current packaged JSON'));f.refreshJSON();
 assert.equal((await loadForestMiddle({forest:{manifest:f.forest},mass:{manifest:f.mass},assets:f.assets,fetchAsset:f.fetchAsset})).sourceValidated,true);
 for(const edit of [f=>f.mass.files['middle-vertices.bin'].sha256='0'.repeat(64),f=>f.mass.source.files['roots.bin'].bytes++,f=>f.mass.source.nativeFieldManifest.sha256='0'.repeat(64)]){
  const changed=fixture();edit(changed);await assert.rejects(changed.load(),/stream|source|provenance/);
 }
});

test('manifest, compressed and decoded digest mutants fail independently',async()=>{
 for(const edit of [f=>f.pointer.sha256='0'.repeat(64),f=>f.pointer.bytes++,f=>f.json[0]^=1,f=>f.encoded['middle-vertices.bin'][8]^=1,
  f=>{f.manifest.files['middle-indices.bin'].sha256='0'.repeat(64);f.refreshJSON();}]){const f=fixture();edit(f);await assert.rejects(f.load(),/digest/);}
 const unsafe=fixture();unsafe.pointer.file='../middle.json';await assert.rejects(unsafe.load(),/pointer/);assert.equal(unsafe.requests.length,0);
 const missing=fixture();delete missing.assets['middle-indices.bin.gz'];await assert.rejects(missing.load(),/Unregistered/);
});

test('unsupported certification, method/source drift, ranges and dishonest error/target reports fail before geometry fetch',async()=>{
 const edits=[m=>m.appearanceErrorSupported=true,m=>m.geometryErrorSupported=true,m=>m.validation={},m=>m.vertexStride=56,
  m=>m.source.files['vertices.bin'].sha256='0'.repeat(64),m=>m.source.middleStreams['middle-indices.bin'].bytes++,m=>m.source.method.file='scripts/prepare-forest-canopy.py',m=>m.source.meshoptimizer.simplifier.sha256='0'.repeat(64),
  m=>m.recipe.api='simplifyWithUpdate',m=>m.prototypes[0].id=1,m=>m.prototypes[0].species='fir',m=>m.prototypes[0].leaf.firstIndex=0,m=>m.prototypes[0].wood.indexCount=6,
  m=>m.prototypes[0].source.indexCount=6,m=>m.prototypes[0].wood.simplification.targetMet=false,m=>m.prototypes[0].leaf.simplification.reportedErrorMetres=.4,
  m=>m.prototypes[0].simplification.reportedErrorMetres=0,m=>m.prototypes[0].lodErrorMetres=2];
 for(const edit of edits){const f=fixture();edit(f.manifest);f.refreshJSON();await assert.rejects(f.load(),/manifest|source|stream|provenance|prototype|part|footprint/);assert.equal(f.requests.length,1);}
});

test('wrong material triangles, indices, normals, pigment and changed bounds reject even with valid transport hashes',async()=>{
 for(const edit of [f=>new Float32Array(f.raw['middle-vertices.bin'].buffer)[6]=4,f=>new Uint32Array(f.raw['middle-indices.bin'].buffer)[2]=3,
  f=>new Uint32Array(f.raw['middle-indices.bin'].buffer)[0]=999,f=>new Float32Array(f.raw['middle-vertices.bin'].buffer)[3]=NaN,
  f=>new Float32Array(f.raw['middle-vertices.bin'].buffer)[5]=0,f=>new Float32Array(f.raw['middle-vertices.bin'].buffer)[10]=-.1,
  f=>new Float32Array(f.raw['middle-vertices.bin'].buffer)[11]=1.1,f=>new Float32Array(f.raw['middle-vertices.bin'].buffer)[0]=-2,
  f=>f.manifest.prototypes[0].low[0]=-2,f=>f.manifest.prototypes[0].centre[1]=2,f=>f.manifest.prototypes[0].wood.simplification.vertices=2]){
  const f=fixture();edit(f);f.refreshBinary();f.refreshJSON();await assert.rejects(f.load(),/vertex|material|outside|bounds|retained/);
 }
});

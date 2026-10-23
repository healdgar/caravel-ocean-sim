// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {gzipSync} from 'node:zlib';
import {FOREST_LIGHT_ASSETS,FOREST_LIGHT_WGSL,loadForestLight,forestLightGPUBytes} from '../js/forest-light.js';

const lightReceipt=bytes=>({bytes:bytes.byteLength,sha256:createHash('sha256').update(bytes).digest('hex')});
function fixture(){
 const count=7,vertices=new Uint8Array(count*56),indices=new Uint32Array([0,1,2,3,4,5]),roots=new Uint8Array(48);
 const forest={vertexStride:56,files:{'vertices.bin':lightReceipt(vertices),'indices.bin':lightReceipt(new Uint8Array(indices.buffer)),'roots.bin':lightReceipt(roots)},
  prototypes:[{id:0,species:'oak',wood:{firstIndex:0,indexCount:3},leaf:{firstIndex:3,indexCount:3}}]};
 const raw=new Uint8Array([255,200,0,64,128,1,254,255]),sourceField=lightReceipt(Buffer.from('native oak continuous leaf-area field'));
 const manifest={format:'waterworld.native-canopy-light',version:1,vertexCount:count,
  source:{files:structuredClone(forest.files),nativeFieldManifest:lightReceipt(Buffer.from('original native fields manifest')),
   method:{file:'scripts/prepare-forest-light.py',...lightReceipt(Buffer.from('offline native exposure source'))}},recipe:{version:1},
  prototypes:[{id:0,species:'oak',sourceField:{file:'oak.npz',...sourceField},sampledVertexCount:6,membership:{
   wood:{firstIndex:0,indexCount:3,indices:lightReceipt(new Uint8Array(indices.buffer,0,12))},
   leaf:{firstIndex:3,indexCount:3,indices:lightReceipt(new Uint8Array(indices.buffer,12,12))}}}],files:{}};
 const f={forest,manifest,raw,requests:[],assets:{'canopy-shade.json':'shade.json','canopy-shade.bin.gz':'shade.bin.gz'}};
 f.refreshBinary=()=>{f.encoded=gzipSync(f.raw);manifest.files['canopy-shade.bin']={...lightReceipt(f.raw),gzip:{file:'canopy-shade.bin.gz',...lightReceipt(f.encoded)}};};
 f.refreshJSON=()=>{f.json=Buffer.from(JSON.stringify(manifest));f.pointer={file:'canopy-shade.json',...lightReceipt(f.json)};forest.canopyShade=f.pointer;};
 f.fetchAsset=async path=>{f.requests.push(path);const bytes=path==='shade.json'?f.json:path==='shade.bin.gz'?f.encoded:null;
  return bytes?new Response(Uint8Array.from(bytes)):new Response(null,{status:404});};
 f.refreshBinary();f.refreshJSON();return f;
}

test('absent light sidecar is neutral and performs no requests',async()=>{
 let requests=0;assert.equal(await loadForestLight({forest:{},fetchAsset:async()=>{requests++;throw Error('unexpected request');}}),null);assert.equal(requests,0);
 const neutral=forestLightGPUBytes();assert.equal(neutral.byteLength,20);assert.deepEqual(Array.from(new Uint32Array(neutral.buffer,0,4)),[0,0,0,0]);
 assert.deepEqual(Array.from(neutral.subarray(16)),[255,255,255,255]);assert.notEqual(forestLightGPUBytes(),neutral);
 assert.equal(await loadForestLight({forest:{canopyShade:{file:'bad'}},receipt:null,fetchAsset:async()=>{throw Error('unexpected request');}}),null);
});

test('loader verifies native lineage and both transport receipts before publishing immutable bytes',async()=>{
 const f=fixture(),pack=await loadForestLight({forest:f.forest,assets:f.assets,fetchAsset:f.fetchAsset});
 assert.deepEqual(f.requests,['shade.json','shade.bin.gz']);assert.equal(pack.sourceValidated,true);assert.deepEqual(pack.bytes,f.raw);
 assert.equal(pack.manifest.vertexCount,7);assert.deepEqual(pack.manifest.source.files,f.forest.files);
 assert.deepEqual(FOREST_LIGHT_ASSETS,{'canopy-shade.json':'assets/forest-scenery/saba/canopy-shade.json','canopy-shade.bin.gz':'assets/forest-scenery/saba/canopy-shade.bin.gz'});
 const gpu=forestLightGPUBytes(pack),view=new DataView(gpu.buffer);assert.equal(view.getUint32(0,true),7);
 assert.deepEqual([4,8,12].map(at=>view.getUint32(at,true)),[0,0,0]);assert.deepEqual(gpu.subarray(16),f.raw);
 for(let vertex=0;vertex<7;vertex++){const word=view.getUint32(16+(vertex>>2)*4,true);assert.equal(((word>>>((vertex&3)*8))&255)/255,f.raw[vertex]/255);}
 gpu[16]=0;assert.equal(pack.bytes[0],255,'GPU packing copies source bytes instead of mutating them');assert.equal(f.raw[0],255);
 assert.throws(()=>forestLightGPUBytes({...pack,sourceValidated:false}),/Unverified/);
});

test('manifest pointer and exact encoded/decoded receipts reject independent tampering',async()=>{
 for(const mutate of [f=>f.pointer.sha256='0'.repeat(64),f=>f.pointer.bytes++,f=>f.json[0]^=1,
  f=>f.encoded[8]^=1,f=>{f.manifest.files['canopy-shade.bin'].sha256='0'.repeat(64);f.refreshJSON();}]){
  const f=fixture();mutate(f);await assert.rejects(loadForestLight({forest:f.forest,receipt:f.pointer,assets:f.assets,fetchAsset:f.fetchAsset}),/digest/);
 }
 const f=fixture();f.pointer.file='../canopy-shade.json';await assert.rejects(loadForestLight({forest:f.forest,assets:f.assets,fetchAsset:f.fetchAsset}),/pointer/);assert.equal(f.requests.length,0);
 const missing=fixture();delete missing.assets['canopy-shade.bin.gz'];await assert.rejects(loadForestLight({forest:missing.forest,assets:missing.assets,fetchAsset:missing.fetchAsset}),/Unregistered/);
});

test('source, membership, format and alignment mutants cannot borrow another forest shade',async()=>{
 const edits=[m=>m.format='waterworld.invented-light',m=>m.version=2,m=>m.vertexCount++,m=>m.vertexCount=0,
  m=>m.source.files['vertices.bin'].sha256='0'.repeat(64),m=>m.source.files['indices.bin'].bytes++,m=>delete m.source.files['roots.bin'],
  m=>m.source.nativeFieldManifest.sha256='bad',m=>m.source.method.file='scripts/prepare-forest-canopy.py',m=>m.source.method.bytes=0,m=>m.recipe.version=2,
  m=>m.files['canopy-shade.bin'].bytes--,m=>m.files['canopy-shade.bin'].gzip.file='../shade.gz',
  m=>m.prototypes[0].species='fir',m=>m.prototypes[0].membership.leaf.firstIndex=0,m=>m.prototypes[0].membership.wood.indices.bytes=4,
  m=>m.prototypes[0].sourceField.sha256='bad',m=>m.prototypes[0].sampledVertexCount=8];
 for(const edit of edits){const f=fixture();edit(f.manifest);f.refreshJSON();await assert.rejects(loadForestLight({forest:f.forest,assets:f.assets,fetchAsset:f.fetchAsset}),/manifest|source|specimen|membership/);assert.equal(f.requests.length,1);}
 const wrongStride=fixture();wrongStride.forest.vertexStride=52;await assert.rejects(loadForestLight({forest:wrongStride.forest,assets:wrongStride.assets,fetchAsset:wrongStride.fetchAsset}),/manifest/);
});

test('verified padding is still required to be neutral, while all visible UNORM8 values are preserved',async()=>{
 const f=fixture();f.raw[7]=0;f.refreshBinary();f.refreshJSON();await assert.rejects(loadForestLight({forest:f.forest,assets:f.assets,fetchAsset:f.fetchAsset}),/padding/);
 assert.throws(()=>forestLightGPUBytes({manifest:{vertexCount:7},bytes:f.raw,sourceValidated:true}),/padding/);
 assert.throws(()=>forestLightGPUBytes({manifest:{vertexCount:7},bytes:new Uint8Array(7),sourceValidated:true}),/Unverified/);
 const truncated=fixture();truncated.encoded=gzipSync(truncated.raw.subarray(0,7));truncated.manifest.files['canopy-shade.bin'].gzip={file:'canopy-shade.bin.gz',...lightReceipt(truncated.encoded)};truncated.refreshJSON();
 await assert.rejects(loadForestLight({forest:truncated.forest,assets:truncated.assets,fetchAsset:truncated.fetchAsset}),/decoded digest/);
});

test('GPU contract is read-only, namespaced, indexed by original vertex and neutral out of range',()=>{
 assert.match(FOREST_LIGHT_WGSL,/struct ForestNativeCanopyLightBlock\s*\{counts:vec4u,packed:array<u32>\}/);
 assert.match(FOREST_LIGHT_WGSL,/@group\(2\)@binding\(14\)var<storage,read>forestNativeCanopyLight/);
 assert.match(FOREST_LIGHT_WGSL,/fn forestNativeCanopyAO\(vertex:u32\)->f32/);
 assert.match(FOREST_LIGHT_WGSL,/if\(vertex>=forestNativeCanopyLight\.counts\.x\)\{return 1\.;\}/);
 assert.match(FOREST_LIGHT_WGSL,/packed\[vertex>>2u\]/);assert.match(FOREST_LIGHT_WGSL,/word>>\(\(vertex&3u\)\*8u\)\)&255u/);
 assert.doesNotMatch(FOREST_LIGHT_WGSL,/read_write|atomic|texture|@compute/);
});

// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {gzipSync} from 'node:zlib';
import {FOREST_VOLUME_ASSETS,FOREST_VOLUME_WGSL,loadForestVolumes,createForestVolumeResources} from '../js/forest-volume.js';

const volumeReceipt=bytes=>({bytes:bytes.byteLength,sha256:createHash('sha256').update(bytes).digest('hex')});
function fixture(){
 const forest={vertexStride:56,files:Object.fromEntries(['vertices.bin','indices.bin','roots.bin'].map((name,i)=>[name,volumeReceipt(Buffer.alloc([504,24,48][i]))])),prototypes:[{id:0,species:'oak'}]};
 const field=new Uint8Array(64),view=new DataView(field.buffer);for(let at=0;at<64;at+=8)for(const [c,bits]of [0x3400,0x3800,0x3000,0x3c00].entries())view.setUint16(at+c*2,bits,true);
 const p={id:0,species:'oak',originXYZ:[0,0,0],cellMetres:1,dimensionsXYZ:[2,2,2],low:[-.5,0,-.5],high:[1.5,1.5,1.5],samplingFootprintMetres:Math.sqrt(3),sourceField:{file:'oak.npz',...volumeReceipt(Buffer.from('original native leaf moments'))}};
 const manifest={format:'waterworld.native-forest-volume',version:1,source:{files:structuredClone(forest.files),nativeFieldManifest:volumeReceipt(Buffer.from('original field cache manifest')),method:{file:'scripts/prepare-forest-volume.py',...volumeReceipt(Buffer.from('offline field transport source'))}},recipe:{version:1,nativeGroundPlaneY:0,extinction:.5},prototypes:[p],files:{}};
 const f={forest,manifest,raw:{field,exposure:new Uint8Array([255,200,180,128,64,32,16,0])},encoded:{},requests:[],assets:{'manifest.json':'volume.json','prototype-0-oak/field.rgba16f.bin.gz':'field.gz','prototype-0-oak/exposure.r8.bin.gz':'exposure.gz'}};
 f.refreshBinary=()=>{for(const [key,suffix]of [['field','field.rgba16f.bin'],['exposure','exposure.r8.bin']]){const file='prototype-0-oak/'+suffix,bytes=gzipSync(f.raw[key]);f.encoded[key]=bytes;p[key]={file,...volumeReceipt(f.raw[key]),gzip:{file:file+'.gz',...volumeReceipt(bytes)}};manifest.files[file]=p[key];}};
 f.refreshJSON=()=>{f.json=Buffer.from(JSON.stringify(manifest));f.pointer={file:'volumes/manifest.json',...volumeReceipt(f.json)};forest.volume=f.pointer;};
 f.fetchAsset=async name=>{f.requests.push(name);const bytes=name==='volume.json'?f.json:name==='field.gz'?f.encoded.field:name==='exposure.gz'?f.encoded.exposure:null;return bytes?new Response(Uint8Array.from(bytes)):new Response(null,{status:404});};
 f.refreshBinary();f.refreshJSON();return f;
}

test('volume loader is optional and preserves original x-fastest density/moment and escape bytes',async()=>{
 let fetches=0;assert.equal(await loadForestVolumes({forest:{},fetchAsset:async()=>{fetches++;throw Error('unexpected fetch');}}),null);assert.equal(fetches,0);
 const f=fixture(),pack=await loadForestVolumes({forest:f.forest,assets:f.assets,fetchAsset:f.fetchAsset});assert.equal(pack.sourceValidated,true);
 assert.deepEqual(f.requests,['volume.json','field.gz','exposure.gz']);assert.deepEqual(pack.prototypes[0].field,f.raw.field);assert.deepEqual(pack.prototypes[0].exposure,f.raw.exposure);
 assert.deepEqual(pack.manifest.prototypes[0].originXYZ,[0,0,0]);assert.ok(Object.values(FOREST_VOLUME_ASSETS).every(path=>path.startsWith('assets/forest-scenery/saba/volumes/')));
 assert.equal(await loadForestVolumes({forest:f.forest,receipt:null,fetchAsset:async()=>{throw Error('unexpected fetch');}}),null);
});

test('volume transport independently verifies pointer, encoded and decoded receipts',async()=>{
 for(const mutate of [f=>f.pointer.sha256='0'.repeat(64),f=>f.json[0]^=1,f=>f.encoded.field[8]^=1,
  f=>{f.manifest.prototypes[0].field.sha256='0'.repeat(64);f.refreshJSON();}]){
  const f=fixture();mutate(f);await assert.rejects(loadForestVolumes({forest:f.forest,assets:f.assets,fetchAsset:f.fetchAsset}),/digest/);
 }
 const unsafe=fixture();unsafe.pointer.file='../manifest.json';await assert.rejects(loadForestVolumes({forest:unsafe.forest,assets:unsafe.assets,fetchAsset:unsafe.fetchAsset}),/pointer/);assert.equal(unsafe.requests.length,0);
 const missing=fixture();delete missing.assets['prototype-0-oak/exposure.r8.bin.gz'];await assert.rejects(loadForestVolumes({forest:missing.forest,assets:missing.assets,fetchAsset:missing.fetchAsset}),/Unregistered/);
});

test('source lineage, voxel centres, byte layout and unqualified sampling bounds fail closed',async()=>{
 const edits=[m=>m.version=2,m=>m.appearanceErrorSupported=true,m=>m.geometryErrorSupported=true,m=>m.source.files['vertices.bin'].sha256='0'.repeat(64),m=>delete m.source.files['roots.bin'],m=>m.source.nativeFieldManifest.sha256='bad',
  m=>m.source.method.file='scripts/prepare-forest-canopy.py',m=>m.recipe.nativeGroundPlaneY=-1,m=>m.recipe.extinction=1,m=>m.recipe.version=2,
  m=>m.prototypes[0].species='fir',m=>m.prototypes[0].dimensionsXYZ[0]=3,m=>m.prototypes[0].dimensionsXYZ[0]=1,m=>m.prototypes[0].cellMetres=NaN,
  m=>m.prototypes[0].originXYZ[0]=1,m=>m.prototypes[0].low[1]=-.5,m=>m.prototypes[0].high[2]++,m=>m.prototypes[0].samplingFootprintMetres=.1,
  m=>m.prototypes[0].sourceField.sha256='bad',m=>m.prototypes[0].field.bytes--,m=>m.prototypes[0].field.gzip.file='../field.gz'];
 for(const edit of edits){const f=fixture();edit(f.manifest);f.refreshJSON();await assert.rejects(loadForestVolumes({forest:f.forest,assets:f.assets,fetchAsset:f.fetchAsset}),/manifest|source|specimen|bounds|stream/);assert.equal(f.requests.length,1);}
});

test('verified half-float fields reject negative/nonfinite density or pigment before resource creation',async()=>{
 for(const [offset,bits]of [[6,0x7c00],[6,0xbc00],[0,0x7e00],[2,0xbc00],[6,0]]){
  const f=fixture();new DataView(f.raw.field.buffer).setUint16(offset,bits,true);f.refreshBinary();f.refreshJSON();
  await assert.rejects(loadForestVolumes({forest:f.forest,assets:f.assets,fetchAsset:f.fetchAsset}),/density|pigment/);
 }
});

test('resource contract uploads immutable 3D fields/metadata once and reuses prototype bindings',async()=>{
 const f=fixture(),pack=await loadForestVolumes({forest:f.forest,assets:f.assets,fetchAsset:f.fetchAsset}),savedT=globalThis.GPUTextureUsage,savedB=globalThis.GPUBufferUsage;
 const textures=[],buffers=[],writes=[],groups=[],samplers=[];
 const device={limits:{maxTextureDimension3D:256},queue:{writeTexture:(target,bytes,layout,size)=>writes.push({target,bytes:Uint8Array.from(bytes),layout,size}),writeBuffer:(buffer,offset,bytes)=>writes.push({buffer,offset,bytes:Uint8Array.from(new Uint8Array(bytes.buffer,bytes.byteOffset,bytes.byteLength))})},
  createTexture:d=>{const t={descriptor:d,createView:desc=>({texture:t,descriptor:desc}),destroy(){t.destroyed=true;}};textures.push(t);return t;},
  createBuffer:d=>{const b={descriptor:d,destroy(){b.destroyed=true;}};buffers.push(b);return b;},createSampler:d=>{samplers.push(d);return{descriptor:d};},createBindGroup:d=>{groups.push(d);return d;}};
 try{globalThis.GPUTextureUsage={TEXTURE_BINDING:4,COPY_DST:2};globalThis.GPUBufferUsage={UNIFORM:64,INDEX:16,COPY_DST:8};
  const r=createForestVolumeResources({device,pack}),pipeline={getBindGroupLayout:index=>({index})};assert.equal(r.indexCount,36);assert.equal(r.immutableBytes,64+8+64+144);
  assert.equal(textures.length,2);assert.deepEqual(textures.map(t=>[t.descriptor.dimension,t.descriptor.format,t.descriptor.size]),[['3d','rgba16float',[2,2,2]],['3d','r8unorm',[2,2,2]]]);
  assert.deepEqual(writes[0].bytes,f.raw.field);assert.deepEqual(writes[1].bytes,f.raw.exposure);assert.equal(writes[0].layout.bytesPerRow,16);assert.equal(writes[0].layout.rowsPerImage,2);
  assert.equal(samplers[0].addressModeW,'clamp-to-edge');assert.equal(samplers[0].minFilter,'linear');assert.deepEqual(r.fieldBounds,[{low:[-.5,0,-.5],high:[1.5,1.5,1.5]}]);
  assert.ok(r.samplingFootprints[0]>=Math.sqrt(3));assert.equal(r.appearanceErrorSupported,false);assert.equal(r.outsideCameraOnly,true);
  assert.equal(r.bind(pipeline,0),r.bind(pipeline,0));assert.equal(groups.length,1);assert.equal(groups[0].layout.index,3);assert.equal(writes.length,4,'bind reuse never uploads field or frame geometry');assert.throws(()=>r.bind(pipeline,1),/prototype/);
  r.destroy();assert.ok(textures.every(t=>t.destroyed));assert.ok(buffers.every(b=>b.destroyed));assert.deepEqual(pack.prototypes[0].field,f.raw.field);
 }finally{if(savedT===undefined)delete globalThis.GPUTextureUsage;else globalThis.GPUTextureUsage=savedT;if(savedB===undefined)delete globalThis.GPUBufferUsage;else globalThis.GPUBufferUsage=savedB;}
});

test('volume shader uses finite bounded integration, actual weighted hit depth and source-ground clipping',()=>{
 assert.match(FOREST_VOLUME_WGSL,/@group\(3\)@binding\(0\)var forestVolumeField:texture_3d<f32>/);assert.match(FOREST_VOLUME_WGSL,/array<u32,36>/);
 assert.match(FOREST_VOLUME_WGSL,/min\(64u,max\(1u,u32\(ceil/);assert.match(FOREST_VOLUME_WGSL,/1\.-exp\(-forestVolumeMeta\.dimensionsExtinction\.w\*density\*step\)/);
 assert.match(FOREST_VOLUME_WGSL,/colour\/weightSum\*in\.yawTint\.yzw/);assert.match(FOREST_VOLUME_WGSL,/hit\/weightSum/);assert.match(FOREST_VOLUME_WGSL,/o\.depth=clip\.z\/clip\.w/);
 assert.match(FOREST_VOLUME_WGSL,/if\(weightSum<=0\.\)\{discard;\}/);assert.match(FOREST_VOLUME_WGSL,/local\.y<forestVolumeMeta\.highFloor\.w/);
 assert.doesNotMatch(FOREST_VOLUME_WGSL,/textureSample\(|dpdx|dpdy|read_write|@compute/);
});

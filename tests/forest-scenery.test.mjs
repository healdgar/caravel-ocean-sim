// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {validateForestScenery,validateForestMaterials,decodeForestScenery,loadForestScenery,forestCoversPoint,excludeForestRoots,FOREST_ASSETS,FOREST_VERTEX_LAYOUT,FOREST_VERTEX_WGSL,FOREST_SURFACE_MIPS_WGSL} from '../js/forest-scenery.js';

function fixture(){
  const vertices=new Float32Array([3,4,4].flatMap(kind=>[[-1,0,0],[1,0,0],[0,2,0]].flatMap(p=>[...p,0,0,1,kind,.5,0,0,.1,.2,.05])));
  const indices=new Uint32Array([0,1,2,3,4,5,6,7,8]);
  const roots=new Float32Array([8,19.9,8,1,.2,1,1,1,0,.1,0,0]);
  const streams={'vertices.bin':vertices.buffer,'indices.bin':indices.buffer,'roots.bin':roots.buffer},files={};
  for(const [name,count,key]of[['vertices.bin',9,'vertexCount'],['indices.bin',9,'indexCount'],['roots.bin',1,'rootCount']]){
    const raw=streams[name];files[name]={bytes:raw.byteLength,sha256:createHash('sha256').update(new Uint8Array(raw)).digest('hex'),[key]:count};
  }
  return {streams,manifest:{format:'waterworld.forest-instances',version:1,units:'metres',upAxis:'Y',vertexStride:52,rootStride:48,rootCount:1,appearanceErrorSupported:false,files,
    coverage:{kind:'occupied-cells',originXZ:[0,0],dimensions:[2,2],cellMetres:64,cells:[0]},
    prototypes:[{id:0,species:'oak',low:[-1,0,0],high:[1,2,0],centre:[0,1,0],radius:Math.sqrt(2)+.0001,firstRoot:0,rootCount:1,
      wood:{firstIndex:0,indexCount:3},leaf:{firstIndex:3,indexCount:3},far:{firstIndex:6,indexCount:3}}]}};
}
function nativeFixture(){
  const f=fixture(),source=new Float32Array(f.streams['vertices.bin']),vertices=new Float32Array(9*14),textures={};
  for(let i=0;i<9;i++){vertices.set(source.subarray(i*13,i*13+13),i*14);vertices[i*14+13]=i<3?0:i<6?1:-1;}
  f.streams['vertices.bin']=vertices.buffer;
  f.manifest.version=2;f.manifest.vertexStride=56;f.manifest.materialContract='gene-surfaces-v3';
  f.manifest.files['vertices.bin']={vertexCount:9,bytes:vertices.byteLength,sha256:createHash('sha256').update(new Uint8Array(vertices.buffer)).digest('hex')};
  f.manifest.prototypes[0].nativeMaterials=['bark','foliage'].map((name,index)=>{
    const receipt=kind=>{const file=`oak-${name}-${kind}.png`,raw=new Uint8Array([137,80,78,71,index,kind==='normal'?1:0]);textures[file]=raw.buffer;
      return{file,bytes:raw.byteLength,sha256:createHash('sha256').update(raw).digest('hex'),encoding:kind==='albedo'?'srgb':'linear'};};
    return{name,index,albedo:receipt('albedo'),normal:receipt('normal'),roughnessMap:index?undefined:receipt('roughness'),
      roughness:.65,underside:index ? .3 : 0,transmission:index ? .13 : 0,opacityThreshold:index ? .35 : 0,undersideReference:[.62,.7,.58],wrap:index?'clamp':'repeat'};
  });
  return{...f,textures};
}
test('instanced pack preserves prototype vertices and compact roots, and declares no appearance certification',()=>{
  const {manifest,streams}=fixture(),before=structuredClone(streams),pack=decodeForestScenery(manifest,streams);
  assert.equal(pack.vertices.length,117);assert.equal(pack.roots.length,12);assert.equal(pack.indices.length,9);
  for(const name of Object.keys(streams))assert.deepEqual(new Uint8Array(streams[name]),new Uint8Array(before[name]));
  assert.ok(Object.values(FOREST_ASSETS).every(path=>path.startsWith('assets/forest-scenery/')));
});
test('invalid species, bounds, partitions, roots, indices and invented error certification are rejected',()=>{
  for(const edit of [m=>m.appearanceErrorSupported=true,m=>m.prototypes[0].species='fir',m=>m.rootStride=32,m=>m.prototypes[0].radius=.1,
    m=>m.prototypes[0].leaf.firstIndex=0,m=>m.prototypes[0].firstRoot=1,m=>m.coverage.cells.push(0),m=>m.files['roots.bin'].bytes=0]){
    const {manifest}=fixture();edit(manifest);assert.throws(()=>validateForestScenery(manifest));
  }
  for(const edit of [s=>new Uint32Array(s['indices.bin'])[0]=100,s=>new Float32Array(s['roots.bin'])[8]=1,s=>new Float32Array(s['roots.bin'])[0]=80,
    s=>new Float32Array(s['vertices.bin'])[3]=NaN,s=>new Float32Array(s['roots.bin'])[9]=-.1]){
    const {manifest,streams}=fixture();edit(streams);assert.throws(()=>decodeForestScenery(manifest,streams));
  }
});
test('only occupied cells suppress old roots; explicit bare/coastal cells and old root bytes survive',()=>{
  const {manifest}=fixture(),inside=[8,1,8,3,10,.2,0,0],outside=[72,1,8,3,10,.2,0,0],boundary=[64,1,0,3,10,.2,0,0];
  const roots=new Float32Array([...inside,...outside,...boundary]),before=roots.slice();
  assert.equal(forestCoversPoint(manifest,8,8),true);assert.equal(forestCoversPoint(manifest,72,8),false);assert.equal(forestCoversPoint(manifest,-1,8),false);
  assert.deepEqual(excludeForestRoots(roots,manifest),new Float32Array([...outside,...boundary]));assert.deepEqual(roots,before);
});
test('optional loader verifies binary digests before publishing a pack',async()=>{
  const {manifest,streams,textures}=nativeFixture(),assets=Object.fromEntries(['manifest.json',...Object.keys(streams),...Object.keys(textures)].map(n=>[n,n]));
  const fetchAsset=async name=>name==='manifest.json'?Response.json(manifest):new Response(streams[name]??textures[name]);
  assert.equal((await loadForestScenery({assets,fetchAsset})).roots.length,12);
  new Uint8Array(streams['roots.bin'])[0]^=1;
  await assert.rejects(loadForestScenery({assets,fetchAsset}),/digest/i);
});
test('native material IDs preserve every source group and explicitly isolate the coarse far approximation',()=>{
  const {manifest,streams}=nativeFixture(),pack=decodeForestScenery(manifest,streams);
  assert.equal(FOREST_VERTEX_LAYOUT.arrayStride,56);assert.deepEqual(FOREST_VERTEX_LAYOUT.attributes.at(-1),{shaderLocation:7,offset:52,format:'float32'});
  assert.equal(validateForestMaterials(manifest.prototypes),2);assert.deepEqual([pack.vertices[13],pack.vertices[55],pack.vertices[97]],[0,1,-1]);
  for(const edit of [m=>delete m.materialContract,m=>m.prototypes[0].nativeMaterials[0].albedo.encoding='linear',
    m=>m.prototypes[0].nativeMaterials[1].transmission=1.1,m=>m.prototypes[0].nativeMaterials[0].roughnessMap.file='../escape.png']){
    const f=nativeFixture();edit(f.manifest);assert.throws(()=>validateForestScenery(f.manifest));
  }
  for(const [vertex,value]of [[0,-1],[3,2],[6,0]]){
    const f=nativeFixture();new Float32Array(f.streams['vertices.bin'])[vertex*14+13]=value;
    assert.throws(()=>decodeForestScenery(f.manifest,f.streams),/material/i);
  }
  const mixed=nativeFixture();new Float32Array(mixed.streams['vertices.bin'])[27]=1;
  assert.throws(()=>decodeForestScenery(mixed.manifest,mixed.streams),/material groups/);
});
test('native surface receipts are verified and an old regional pack cannot borrow generic foliage',async()=>{
  const {manifest,streams,textures}=nativeFixture(),assets=Object.fromEntries(['manifest.json',...Object.keys(streams),...Object.keys(textures)].map(n=>[n,n]));
  const fetchAsset=async name=>name==='manifest.json'?Response.json(manifest):new Response(streams[name]??textures[name]);
  const loaded=await loadForestScenery({assets,fetchAsset});assert.deepEqual(Object.keys(loaded.textures).sort(),Object.keys(textures).sort());
  const first=Object.keys(textures)[0];new Uint8Array(textures[first])[4]^=1;
  await assert.rejects(loadForestScenery({assets,fetchAsset}),/surface digest/i);
  const old=fixture(),oldAssets=Object.fromEntries(['manifest.json',...Object.keys(old.streams)].map(n=>[n,n]));
  await assert.rejects(loadForestScenery({assets:oldAssets,fetchAsset:async name=>name==='manifest.json'?Response.json(old.manifest):new Response(old.streams[name])}),/native surfaces/);
});
test('native stream transport verifies both encoded and decoded receipts',async()=>{
  const {manifest,streams,textures}=nativeFixture(),encoded={},assets=Object.fromEntries(['manifest.json',...Object.keys(textures)].map(name=>[name,name]));
  for(const [name,raw]of Object.entries(streams)){
    const bytes=gzipSync(new Uint8Array(raw));encoded[name+'.gz']=bytes;assets[name]=name+'.gz';
    manifest.files[name].gzip={file:name+'.gz',bytes:bytes.byteLength,sha256:createHash('sha256').update(bytes).digest('hex')};
  }
  const fetchAsset=async name=>name==='manifest.json'?Response.json(manifest):new Response(encoded[name]??textures[name]);
  assert.equal((await loadForestScenery({assets,fetchAsset,loadAtlases:false})).vertices.length,126);
  const original=encoded['roots.bin.gz'].slice();encoded['roots.bin.gz'][8]^=1;
  await assert.rejects(loadForestScenery({assets,fetchAsset,loadAtlases:false}),/encoded digest/);
  encoded['roots.bin.gz']=original;manifest.files['roots.bin'].sha256='0'.repeat(64);
  await assert.rejects(loadForestScenery({assets,fetchAsset,loadAtlases:false}),/Forest digest/);
});
test('forest rendering cannot fall back to the legacy generic mask or threshold averaged coverage',async()=>{
  const source=await readFile(new URL('../js/forest-scenery.js',import.meta.url),'utf8');
  assert.doesNotMatch(FOREST_VERTEX_WGSL,/leafSpray|tree-foliage|canopyLeafFS|discard/);
  assert.match(FOREST_VERTEX_WGSL,/@location\(7\)nativeMaterial/);
  assert.match(FOREST_VERTEX_WGSL,/forestNativeOpaqueFS/);assert.match(FOREST_VERTEX_WGSL,/forestNativeLeafFS/);
  assert.match(FOREST_VERTEX_WGSL,/return vec4f\(lit\.rgb,pigment\.a\)/);
  assert.match(FOREST_SURFACE_MIPS_WGSL,/forestMipLinear\(c\.rgb\)\*c\.a/);
  assert.match(FOREST_SURFACE_MIPS_WGSL,/colour\*\.25/);assert.doesNotMatch(FOREST_SURFACE_MIPS_WGSL,/discard|step\(/);
  assert.match(source,/alphaToCoverageEnabled:fragment==='forestNativeLeafFS'/);
  assert.match(source,/nearPixels=3/);assert.match(source,/nearPixels<=3/);
});

// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {validateForestScenery,decodeForestScenery,loadForestScenery,forestCoversPoint,excludeForestRoots,FOREST_ASSETS} from '../js/forest-scenery.js';

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
  const {manifest,streams}=fixture(),assets=Object.fromEntries(['manifest.json',...Object.keys(streams)].map(n=>[n,n]));
  const fetchAsset=async name=>name==='manifest.json'?Response.json(manifest):new Response(streams[name]);
  assert.equal((await loadForestScenery({assets,fetchAsset})).roots.length,12);
  new Uint8Array(streams['roots.bin'])[0]^=1;
  await assert.rejects(loadForestScenery({assets,fetchAsset}),/digest/i);
});

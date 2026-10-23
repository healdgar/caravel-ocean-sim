// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {createForestRibbonPrototype} from '../scripts/prepare-forest-ribbons.mjs';
import {validateForestRibbonAssets,loadForestRibbonAssets} from '../js/forest-ribbon-assets.js';
const raw=a=>Buffer.from(a.buffer,a.byteOffset,a.byteLength),receipt=a=>({bytes:a.byteLength,sha256:createHash('sha256').update(a).digest('hex')});

function fixture(){
 const uv=[[0,0],[1,0],[1,.5],[0,.5],[1,1],[0,1]],floats=new Float32Array(6*15),indices=Uint32Array.from([0,1,2,0,2,3,3,2,4,3,4,5]);
 for(const [id,[u,v]]of uv.entries())floats.set([u,.5+v,v===.5?.1:0,0,0,1,4,1,u,v,.2,.4,.1,2,1],id*15);
 const c={id:0,sourceNodeID:7,firstLeaf:0,leafCount:1,firstVertex:0,vertexCount:6,firstIndex:0,indexCount:12,low:[0,.5,0],high:[1,1.5,.11],centre:[.5,1,.05],radius:.8,extent:.8},native=receipt(Buffer.from('native source'));
 const inspection={manifest:{source:{manifest:native},example:'normalized original inspection'},immutable:true,stats:{sourceMembershipVerified:true},prototype:{id:0,species:'oak',leafCount:1},vertexStride:60,vertices:new Uint8Array(floats.buffer),indices,sourceIDs:Uint32Array.from([0,1,2,3,4,5]),leafOrder:Uint32Array.from([0]),materials:[{index:2}],textures:new Map(),clusters:[c],ranges:new Map([[7,{firstVertex:0,vertexCount:6,firstIndex:0,indexCount:12}]]),destroy(){}};
 const authored=createForestRibbonPrototype(inspection),record=authored.record,assets=new Map(),calls=[],base='https://forest.invalid/ribbons/';
 const manifest={format:'waterworld.forest-ribbon-assets',version:1,experimental:true,qualified:false,complete:true,units:'metres',upAxis:'Y',source:{inspectionManifest:receipt(Buffer.from('inspection manifest')),normalizedInspection:receipt(Buffer.from(JSON.stringify(inspection.manifest))),nativeManifest:native},methods:['scripts/prepare-forest-ribbons.mjs','js/forest-leaf-ribbons.js'].map(file=>({file,...receipt(Buffer.from(file))})),prototypes:[record]};
 const f={inspection,authored,manifest,record,assets,calls,base,failOnce:null};
 f.refresh=()=>assets.set(base+'manifest.json',Buffer.from(JSON.stringify(manifest)));
 f.setRaw=bytes=>{const encoded=gzipSync(bytes);record.indices={file:'indices.u32.bin',...receipt(bytes),gzip:{file:'indices.u32.bin.gz',...receipt(encoded)}};assets.set(base+record.indices.gzip.file,encoded);f.refresh();};f.setRaw(raw(authored.indices));
 f.fetchAsset=async url=>{calls.push(url);if(f.failOnce===url){f.failOnce=null;return new Response(null,{status:503});}const bytes=assets.get(url);return bytes?new Response(Uint8Array.from(bytes)):new Response(null,{status:404});};
 f.load=(options={})=>loadForestRibbonAssets(base,{fetchAsset:f.fetchAsset,allowExperimental:true,...options});return f;
}

test('authored ribbons require explicit review; manifest stays unqualified',async()=>{
 const f=fixture();await assert.rejects(loadForestRibbonAssets(f.base,{fetchAsset:f.fetchAsset}),/experimental/);assert.equal(f.calls.length,0);assert.equal(validateForestRibbonAssets(f.manifest),f.manifest);assert.equal(f.manifest.qualified,false);
});

test('offline authoring and verified loading preserve both complete frontiers without reauthoring leaves',async()=>{
 const f=fixture(),sourceV=f.inspection.vertices.slice(),sourceI=f.inspection.indices.slice(),loader=await f.load(),derived=await loader.apply(f.inspection);
 assert.equal(derived.vertices,f.inspection.vertices);assert.equal(derived.materials,f.inspection.materials);assert.equal(derived.textures,f.inspection.textures);assert.equal(derived.destroy,f.inspection.destroy);assert.deepEqual(derived.indices.slice(0,6),f.authored.indices);assert.deepEqual(derived.indices.slice(6),sourceI);
 assert.deepEqual(derived.clusters.map(c=>[c.selectionKey,c.firstIndex,c.indexCount]),[['ribbon:7',0,6],['original:7',6,12]]);assert.equal(derived.sourceRanges,f.inspection.ranges);assert.equal(derived.ranges.get('original:7').firstIndex,6);assert.equal(derived.reduction.sourceTriangles,4);assert.equal(derived.reduction.reducedTriangles,2);assert.equal(derived.reduction.fullTriangles,6);assert.equal(derived.reduction.authored,true);assert.equal(derived.reduction.appearanceQualified,false);
 assert.equal(derived.clusters[0].reductionErrorMetres,f.record.maximumPositionErrorUpperMetres);assert.ok(derived.clusters[0].reductionErrorMetres>=.1);assert.deepEqual(f.inspection.vertices,sourceV);assert.deepEqual(f.inspection.indices,sourceI);assert.deepEqual(f.calls,[f.base+'manifest.json',f.base+'indices.u32.bin.gz']);
});

test('source records, normalized manifest and verified membership bind authored indices before download',async()=>{
 for(const mode of ['vertex','indices','manifest','verified','derived']){const f=fixture(),loader=await f.load();
  if(mode==='vertex')f.inspection.vertices[0]^=1;if(mode==='indices')[f.inspection.indices[0],f.inspection.indices[1]]=[f.inspection.indices[1],f.inspection.indices[0]];if(mode==='manifest')f.inspection.manifest.example='different';if(mode==='verified')f.inspection.stats.sourceMembershipVerified=false;if(mode==='derived')f.inspection.reduction={};
  await assert.rejects(loader.apply(f.inspection),/source|original inspection/);assert.equal(f.calls.length,1);
 }
});

test('schema rejects broken blade cover, missing source evidence and unsafe paths',()=>{
 const edits=[m=>m.qualified=true,m=>m.prototypes[0].leafCount++,m=>m.prototypes[0].clusters[0].firstLeaf=1,m=>m.prototypes[0].clusters[0].firstIndex=6,m=>m.prototypes[0].clusters.push(m.prototypes[0].clusters[0]),m=>m.prototypes[0].clusters[0].reductionErrorMetres=NaN,m=>m.prototypes[0].interpolationDeviations.qualified=true,m=>m.prototypes[0].indices.gzip.file='../raw-reference.bin.gz',m=>m.source.normalizedInspection.sha256='x',m=>m.methods=[]];
 for(const edit of edits){const f=fixture(),m=structuredClone(f.manifest);edit(m);assert.throws(()=>validateForestRibbonAssets(m),/Forest ribbon assets/);}
});

test('encoded/decoded corruption, gzip expansion and budget overflow fail without unbounded decode',async()=>{
 for(const mode of ['encoded','decoded','expansion','short','budget']){const f=fixture();
  if(mode==='encoded')f.record.indices.gzip.sha256='0'.repeat(64);if(mode==='decoded')f.record.indices.sha256='0'.repeat(64);
  if(mode==='expansion'||mode==='short'){const encoded=gzipSync(Buffer.alloc(f.record.indices.bytes+(mode==='expansion'?4:-4)));f.record.indices.gzip={file:f.record.indices.gzip.file,...receipt(encoded)};f.assets.set(f.base+f.record.indices.gzip.file,encoded);}f.refresh();
  const loader=await f.load(mode==='budget'?{maxAdditionalBytes:1}:{});await assert.rejects(loader.apply(f.inspection),/digest|expands|budget/);if(mode==='budget')assert.equal(f.calls.length,1);
 }
});

test('self-consistent replacement bytes cannot invent retained corners or branch ownership',async()=>{
 for(const mode of ['corner','winding','branch']){const f=fixture();if(mode==='branch')f.record.clusters[0].sourceNodeID=8;else{const bad=f.authored.indices.slice();if(mode==='corner')bad[0]=2;else[bad[0],bad[1]]=[bad[1],bad[0]];f.setRaw(raw(bad));}f.refresh();const loader=await f.load();await assert.rejects(loader.apply(f.inspection),/corners\/winding|ownership\/bound/);}
});

test('failed authored page transport retries without a poisoned queue or mutation',async()=>{
 const f=fixture(),loader=await f.load();f.failOnce=f.base+'indices.u32.bin.gz';await assert.rejects(loader.apply(f.inspection),/unavailable/);const result=await loader.apply(f.inspection);assert.equal(result.indices.length,18);assert.equal(f.inspection.indices.length,12);assert.equal(f.calls.filter(x=>x.endsWith('.gz')).length,2);
});

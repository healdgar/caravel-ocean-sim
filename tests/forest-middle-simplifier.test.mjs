// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Offline fixtures. The root validator executes these; authoring does not.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {pathToFileURL} from 'node:url';
import {gzipSync,gunzipSync} from 'node:zlib';
import {middleReceipt,loadMiddleTools,validateMiddleSource,decodeMiddleStream,splitMiddlePrototype,simplifyMiddleKind,simplifyForestMiddle} from '../scripts/simplify-forest-middle.mjs';

const STRIDE=52,SPECIES=['oak','maple','birch','elm','chestnut'];
const TOOLS=process.env.FOREST_MESHOPT_PACKAGE??'/tmp/waterworld-meshopt-tools/node_modules/meshoptimizer';
const ENCODER_SHA='22c128be3e22b187e2d2661882fc62f51e995f409c0fe14c9f6358cfbaff1611';
const tools=()=>loadMiddleTools(TOOLS);
const floats=values=>{const out=Buffer.alloc(values.length*4);values.forEach((x,i)=>out.writeFloatLE(x,i*4));return out;};
const uints=values=>{const out=Buffer.alloc(values.length*4);values.forEach((x,i)=>out.writeUInt32LE(x,i*4));return out;};
const receipt=(text)=>middleReceipt(Buffer.from(text));

function fixture(){
 const rows=[],indices=[],prototypes=[];
 const grid=(kind,n,offset)=>{
  const base=rows.length;
  for(let y=0;y<=n;y++)for(let x=0;x<=n;x++){
   const u=x/n,v=y/n;
   rows.push([offset+u,v,kind===3?-.2:0,0,0,1,kind,.25+.5*u,u,v,.2+.3*u,.35+.2*v,.15]);
  }
  for(let y=0;y<n;y++)for(let x=0;x<n;x++){
   const a=base+y*(n+1)+x,b=a+1,c=a+n+1,d=c+1;indices.push(a,b,d,a,d,c);
  }
 };
 for(const [id,species]of SPECIES.entries()){
  const firstIndex=indices.length;
  // Deliberately leaf-first: the reduced ABI must partition wood then leaf.
  grid(4,12,id*3);grid(3,1,id*3);
  prototypes.push({id,species,firstIndex,indexCount:indices.length-firstIndex,lodErrorMetres:2+id*.125});
 }
 const vertices=floats(rows.flat()),indexRaw=uints(indices);
 const manifest={format:'waterworld.native-forest-mass',version:2,units:'metres',upAxis:'Y',prototypes,
  files:{'middle-vertices.bin':middleReceipt(vertices),'middle-indices.bin':middleReceipt(indexRaw)},
  source:{files:Object.fromEntries(['vertices.bin','indices.bin','roots.bin'].map(name=>[name,receipt('original native '+name)])),
   nativeFieldManifest:{file:'manifest.json',...receipt('native fields')},nativeFieldRecipe:{version:1},
   method:{file:'scripts/prepare-forest-mass.py',...receipt('native mass method')}}};
 return{vertices,indices:new Uint32Array(indices),indexRaw,manifest};
}

async function saveFixture(folder,f,{gzip=false,meshopt=false}={}){
 await mkdir(folder,{recursive:true});const manifest=structuredClone(f.manifest);
 let encoder;
 if(meshopt){
  const source=await readFile(join(TOOLS,'meshopt_encoder.js'));assert.equal(middleReceipt(source).sha256,ENCODER_SHA);
  ({MeshoptEncoder:encoder}=await import(pathToFileURL(join(TOOLS,'meshopt_encoder.js')).href));await encoder.ready;
 }
 for(const [name,raw]of [['middle-vertices.bin',f.vertices],['middle-indices.bin',f.indexRaw]]){
  let transport=raw;
  if(meshopt){const stride=name==='middle-vertices.bin'?52:4,mode=stride===52?'ATTRIBUTES':'INDICES';
   transport=Buffer.from(stride===52?encoder.encodeVertexBuffer(raw,raw.length/stride,stride):encoder.encodeIndexSequence(raw,raw.length/stride,stride));
   manifest.files[name].meshopt={...middleReceipt(transport),count:raw.length/stride,stride,mode};}
  if(gzip){const gz=gzipSync(transport,{level:9,mtime:0});await writeFile(join(folder,name+'.gz'),gz);
   manifest.files[name].gzip={file:name+'.gz',...middleReceipt(gz)};
  }else await writeFile(join(folder,name),transport);
 }
 await writeFile(join(folder,'manifest.json'),JSON.stringify(manifest));return manifest;
}

function outputRows(raw){const set=new Set();for(let at=0;at<raw.length;at+=STRIDE)set.add(raw.subarray(at,at+STRIDE).toString('hex'));return set;}

test('real pinned simplifier retains exact native records, partitions parts and reports bounded error',async()=>{
 const temp=await mkdtemp(join(tmpdir(),'forest-middle-fixture-'));
 try{
  const f=fixture(),source=join(temp,'source'),output=join(temp,'reduced');await saveFixture(source,f,{gzip:true});
  const originalManifest=await readFile(join(source,'manifest.json'));
  const result=await simplifyForestMiddle({mass:source,output,meshoptimizer:TOOLS,errorMetres:.35,leafTriangles:16,woodTriangles:1});
  assert.equal(result.format,'waterworld.native-forest-middle');assert.equal(result.version,1);assert.equal(result.vertexStride,52);
  assert.equal(result.recipe.leafShading,'vertex');assert.deepEqual(result.recipe.leafAttributeWeights,[1,1,1,1,1,1]);
  assert.equal(result.appearanceErrorSupported,false);assert.deepEqual(result.source.files,f.manifest.source.files);
  assert.deepEqual(result.source.middleStreams,f.manifest.files);
  const v=gunzipSync(await readFile(join(output,'middle-vertices.bin.gz'))),i=gunzipSync(await readFile(join(output,'middle-indices.bin.gz')));
  assert.deepEqual(middleReceipt(v),{bytes:result.files['middle-vertices.bin'].bytes,sha256:result.files['middle-vertices.bin'].sha256});
  assert.deepEqual(middleReceipt(i),{bytes:result.files['middle-indices.bin'].bytes,sha256:result.files['middle-indices.bin'].sha256});
  const originalRows=outputRows(f.vertices);for(const row of outputRows(v))assert.ok(originalRows.has(row),'invented/changed52-byte source record');
  let cursor=0;const used=new Set();
  for(const p of result.prototypes){
   assert.equal(p.firstIndex,cursor);assert.equal(p.wood.firstIndex,cursor);assert.equal(p.leaf.firstIndex,cursor+p.wood.indexCount);
   assert.equal(p.indexCount,p.wood.indexCount+p.leaf.indexCount);
   assert.deepEqual(p.source.indices,middleReceipt(f.indexRaw.subarray(f.manifest.prototypes[p.id].firstIndex*4,(f.manifest.prototypes[p.id].firstIndex+f.manifest.prototypes[p.id].indexCount)*4)));
   for(const kind of ['wood','leaf']){
    const part=p[kind],stats=part.simplification;assert.ok(stats.reportedErrorMetres>=0&&stats.reportedErrorMetres<=.35);
    assert.equal(stats.shadingProfile,'vertex');assert.deepEqual(stats.attributeWeights,[1,1,1,1,1,1]);
    assert.equal(stats.targetMet,stats.triangles<=stats.targetTriangles);assert.equal(stats.triangles,part.indexCount/3);
    assert.ok(stats.triangles<=stats.originalTriangles);
    for(let at=part.firstIndex;at<part.firstIndex+part.indexCount;at++){
     const id=i.readUInt32LE(at*4);assert.ok(id<v.length/STRIDE);used.add(id);assert.equal(v.readFloatLE(id*STRIDE+24),kind==='wood'?3:4);
    }
   }
   assert.equal(p.wood.simplification.targetMet,false,'locked square border must not be forced below its valid target');
   const error=Math.max(p.wood.simplification.reportedErrorMetres,p.leaf.simplification.reportedErrorMetres);
   assert.equal(p.lodErrorMetres,f.manifest.prototypes[p.id].lodErrorMetres+error);cursor+=p.indexCount;
  }
  assert.equal(cursor*4,i.length);assert.equal(used.size,v.length/STRIDE,'compacted buffer contains unused records');
  assert.deepEqual(await readFile(join(source,'manifest.json')),originalManifest);
  assert.deepEqual(gunzipSync(await readFile(join(source,'middle-vertices.bin.gz'))),f.vertices);
  assert.deepEqual(gunzipSync(await readFile(join(source,'middle-indices.bin.gz'))),f.indexRaw);
  await assert.rejects(simplifyForestMiddle({mass:source,output,meshoptimizer:TOOLS}),/Fresh middle output/);
 }finally{await rm(temp,{recursive:true,force:true});}
});

test('field leaf profile omits only resampled shading attributes and retains exact shape records',async()=>{
 const temp=await mkdtemp(join(tmpdir(),'forest-middle-field-'));
 try{
  const f=fixture(),source=join(temp,'source'),output=join(temp,'reduced');await saveFixture(source,f);
  const result=await simplifyForestMiddle({mass:source,output,meshoptimizer:TOOLS,errorMetres:.35,leafTriangles:16,woodTriangles:1,leafShading:'field'});
  assert.equal(result.recipe.leafShading,'field');assert.deepEqual(result.recipe.leafAttributeWeights,[0,0,0,0,0,0]);
  assert.deepEqual(result.recipe.woodAttributeWeights,[1,1,1,1,1,1]);assert.equal(result.recipe.maximumReportedErrorMetres,.35);
  const v=gunzipSync(await readFile(join(output,'middle-vertices.bin.gz'))),originalRows=outputRows(f.vertices);
  for(const row of outputRows(v))assert.ok(originalRows.has(row),'field profile changed a position or source record');
  for(const p of result.prototypes){
   assert.equal(p.leaf.simplification.shadingProfile,'field');assert.deepEqual(p.leaf.simplification.attributeWeights,[0,0,0,0,0,0]);
   assert.equal(p.wood.simplification.shadingProfile,'vertex');assert.deepEqual(p.wood.simplification.attributeWeights,[1,1,1,1,1,1]);
   for(const kind of ['wood','leaf'])assert.ok(p[kind].simplification.reportedErrorMetres<=.35);
  }
  assert.deepEqual(await readFile(join(source,'middle-vertices.bin')),f.vertices);
  assert.deepEqual(await readFile(join(source,'middle-indices.bin')),f.indexRaw);
  await assert.rejects(simplifyForestMiddle({mass:source,output:join(temp,'bad'),leafShading:'generic'}),/Unsupported --leaf-shading/);
 }finally{await rm(temp,{recursive:true,force:true});}
});

test('field profile passes zero weights without weakening the geometric cap or changing wood',()=>{
 const f=fixture(),groups=splitMiddlePrototype(f.manifest.prototypes[0],f.vertices,f.indices),calls=[];
 const tool={getScale:()=>1,simplifyWithAttributes:(ids,positions,stride,attributes,attributeStride,weights,locks,target,error)=>{
  calls.push({weights,error,stride,attributeStride});return[ids,0];
 }};
 simplifyMiddleKind(groups.leaf,f.vertices,tool,{targetTriangles:1,errorMetres:.35,shadingProfile:'field'});
 simplifyMiddleKind(groups.wood,f.vertices,tool,{targetTriangles:1,errorMetres:.35});
 assert.deepEqual(calls.map(c=>c.weights),[[0,0,0,0,0,0],[1,1,1,1,1,1]]);
 assert.ok(calls.every(c=>c.error<=.35&&c.stride===13&&c.attributeStride===6));
 assert.throws(()=>simplifyMiddleKind(groups.wood,f.vertices,tool,{targetTriangles:1,errorMetres:.35,shadingProfile:'field'}),/only for native leaf shells/);
 assert.throws(()=>simplifyMiddleKind(groups.leaf,f.vertices,tool,{targetTriangles:1,errorMetres:.35,shadingProfile:'unknown'}),/Unsupported middle shading/);
 assert.throws(()=>simplifyMiddleKind(groups.leaf,f.vertices,{getScale:()=>1,simplifyWithAttributes:ids=>[ids,.351]},
  {targetTriangles:1,errorMetres:.35,shadingProfile:'field'}),/exceeds requested metres/);
});

test('raw and meshopt+gzip inputs decode to identical original middle bytes',async()=>{
 const temp=await mkdtemp(join(tmpdir(),'forest-middle-codec-'));
 try{
  const f=fixture(),tool=await tools();
  for(const [label,options]of [['raw',{}],['encoded',{gzip:true,meshopt:true}]]){
   const folder=join(temp,label),m=await saveFixture(folder,f,options);validateMiddleSource(m);
   assert.deepEqual(await decodeMiddleStream(folder,'middle-vertices.bin',m.files['middle-vertices.bin'],tool),f.vertices);
   assert.deepEqual(await decodeMiddleStream(folder,'middle-indices.bin',m.files['middle-indices.bin'],tool),f.indexRaw);
  }
 }finally{await rm(temp,{recursive:true,force:true});}
});

test('kind, source provenance and contiguous membership violations fail',()=>{
 const f=fixture(),mixed=Buffer.from(f.vertices);mixed.writeFloatLE(3,24);
 assert.throws(()=>splitMiddlePrototype(f.manifest.prototypes[0],mixed,f.indices),/Mixed\/non-native/);
 for(const mutate of [m=>{m.source.method.file='replacement.js';},m=>{delete m.source.nativeFieldRecipe;},
  m=>{m.prototypes[1].firstIndex++;},m=>{m.prototypes[0].lodErrorMetres=NaN;},m=>{m.files['middle-vertices.bin'].gzip={file:'../escape.gz',...receipt('bad')};}]){
  const m=structuredClone(f.manifest);mutate(m);assert.throws(()=>validateMiddleSource(m));
 }
});

test('tool error and mutation never override the source records or metre cap',()=>{
 const f=fixture(),ids=splitMiddlePrototype(f.manifest.prototypes[0],f.vertices,f.indices).leaf,original=Buffer.from(f.vertices);
 assert.throws(()=>simplifyMiddleKind(ids,f.vertices,{getScale:()=>1,simplifyWithAttributes:i=>[i,.36]},
  {targetTriangles:1,errorMetres:.35}),/exceeds requested metres/);
 assert.throws(()=>simplifyMiddleKind(ids,f.vertices,{getScale:()=>1,simplifyWithAttributes:(i,p)=>{p[0]+=1;return[i,0];}},
  {targetTriangles:1,errorMetres:.35}),/mutated original/);
 assert.throws(()=>simplifyMiddleKind(ids,f.vertices,{getScale:()=>1},
  {targetTriangles:1,errorMetres:.41}),/Unsafe middle reduction/);
 assert.deepEqual(f.vertices,original,'rejected tools changed source buffer');
});

test('corrupt encoded or decoded source receipts fail before publishing output',async()=>{
 const temp=await mkdtemp(join(tmpdir(),'forest-middle-receipts-'));
 try{
  const f=fixture(),tool=await tools(),folder=join(temp,'source'),m=await saveFixture(folder,f,{gzip:true});
  const bad=structuredClone(m.files['middle-vertices.bin']);bad.gzip.sha256='0'.repeat(64);
  await assert.rejects(decodeMiddleStream(folder,'middle-vertices.bin',bad,tool),/Encoded middle receipt/);
  const decoded=structuredClone(m.files['middle-vertices.bin']);decoded.sha256='0'.repeat(64);
  await assert.rejects(decodeMiddleStream(folder,'middle-vertices.bin',decoded,tool),/Decoded middle receipt/);
  await assert.rejects(simplifyForestMiddle({mass:folder,output:join(folder,'nested'),meshoptimizer:TOOLS}),/outside source pack/);
 }finally{await rm(temp,{recursive:true,force:true});}
});

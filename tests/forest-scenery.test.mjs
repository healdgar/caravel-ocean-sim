// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {validateForestScenery,validateForestMaterials,decodeForestScenery,decodeForestSceneryAsync,loadForestScenery,forestCoversPoint,excludeForestRoots,FOREST_ASSETS,FOREST_VERTEX_LAYOUT,FOREST_VERTEX_WGSL,FOREST_SURFACE_MIPS_WGSL} from '../js/forest-scenery.js';

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
function attachAtlas(f){
  const hash=bytes=>createHash('sha256').update(bytes).digest('hex'),views=[];
  for(let row=0;row<16;row++)for(let column=0;column<16;column++){
    const u=2*(column+.5)/16-1,v=2*(row+.5)/16-1;let x=u,y=1-Math.abs(u)-Math.abs(v),z=v;
    if(y<0){x=(1-Math.abs(v))*Math.sign(u);z=(1-Math.abs(u))*Math.sign(v);}
    const length=Math.hypot(x,y,z),direction=[x/length,y/length,z/length],reference=Math.abs(direction[1])>.999?[0,0,1]:[0,1,0];
    const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]],r=cross(reference,direction),right=r.map(n=>n/Math.hypot(...r)),up=cross(direction,right);
    views.push({index:views.length,row,column,direction,right,up});
  }
  const raw=new Uint8Array(1024*1024*8),encoded=gzipSync(raw),rawHash=hash(raw),encodedHash=hash(encoded),responses={},assets={'manifest.json':'atlas.json'};
  const files=structuredClone(f.manifest.files);
  for(const p of f.manifest.prototypes)for(const m of p.nativeMaterials)for(const key of ['albedo','normal','roughnessMap'])if(m[key])files[m[key].file]=m[key];
  const prototypes=f.manifest.prototypes.map(p=>{
    const outputs={};for(const [key,stem]of [['albedo','albedo'],['normalDepth','normal-depth']]){
      const file=`prototype-${p.id}-${p.species}/${stem}.rgba16f.bin`;
      outputs[key]={file,bytes:raw.byteLength,sha256:rawHash,gzip:{file:file+'.gz',bytes:encoded.byteLength,sha256:encodedHash,uncompressedSHA256:rawHash}};
      assets[file+'.gz']=file+'.gz';responses[file+'.gz']=encoded;
    }
    return{id:p.id,species:p.species,centre:p.centre,radius:p.radius,projection:{extent:p.radius*1.05},detailedGeometry:{wood:p.wood,leaf:p.leaf},outputs};
  });
  const manifest={format:'waterworld.native-impostors',version:1,complete:true,units:'metres',upAxis:'Y',layout:{grid:[16,16],tilePixels:64,atlasPixels:[1024,1024],views},source:{files},prototypes};
  const bytes=new TextEncoder().encode(JSON.stringify(manifest));responses['atlas.json']=bytes;
  f.manifest.impostors={file:'impostors/manifest.json',bytes:bytes.byteLength,sha256:hash(bytes)};
  return{assets,responses};
}
test('instanced pack preserves prototype vertices and compact roots, and declares no appearance certification',()=>{
  const {manifest,streams}=fixture(),before=structuredClone(streams),pack=decodeForestScenery(manifest,streams);
  assert.equal(pack.vertices.length,117);assert.equal(pack.roots.length,12);assert.equal(pack.indices.length,9);
  for(const name of Object.keys(streams))assert.deepEqual(new Uint8Array(streams[name]),new Uint8Array(before[name]));
  assert.ok(Object.values(FOREST_ASSETS).every(path=>path.startsWith('assets/forest-scenery/')));
});
test('cooperative native validation preserves exact bytes, failures and abort semantics',async()=>{
  const f=nativeFixture(),sync=decodeForestScenery(f.manifest,f.streams);let yields=0;
  const asyncPack=await decodeForestSceneryAsync(f.manifest,f.streams,{yieldTask:async()=>{yields++;}});
  assert.ok(yields>0);for(const key of ['vertices','indices','roots'])assert.deepEqual(asyncPack[key],sync[key]);
  const bad=nativeFixture();new Uint32Array(bad.streams['indices.bin'])[0]=999;
  await assert.rejects(decodeForestSceneryAsync(bad.manifest,bad.streams,{yieldTask:async()=>{}}),/index outside/);
  const abort=new AbortController();await assert.rejects(decodeForestSceneryAsync(f.manifest,f.streams,{signal:abort.signal,yieldTask:async()=>abort.abort()}),{name:'AbortError'});
});
test('full-sphere first forest requires only roots and atlases; native fetch is cached and receipt verified later',async()=>{
  const f=nativeFixture(),atlas=attachAtlas(f),requests=[],assets=Object.fromEntries(['manifest.json',...Object.keys(f.streams),...Object.keys(f.textures)].map(n=>[n,n]));
  const fetchAsset=async name=>{
    requests.push(name);if(name==='manifest.json')return Response.json(f.manifest);
    return new Response(new Uint8Array(atlas.responses[name]??f.streams[name]??f.textures[name]));
  };
  const pack=await loadForestScenery({assets,impostorAssets:atlas.assets,fetchAsset});
  assert.equal(pack.vertices,null);assert.equal(pack.indices,null);assert.equal(pack.textures,null);assert.ok(pack.impostors);
  assert.equal(requests.includes('vertices.bin'),false);assert.equal(requests.includes('indices.bin'),false);
  assert.equal(requests.some(name=>name.endsWith('.png')),false);assert.equal(pack.roots.length,12);
  assert.equal(pack.releaseNativeCPU(),false,'no fulfilled cache exists at first readiness');
  const a=pack.loadNative(),b=pack.loadNative();assert.equal(a,b,'one cached native load');
  assert.equal(pack.releaseNativeCPU(),false,'an in-flight load remains deduplicated');assert.equal(pack.loadNative(),a);
  const native=await a;assert.deepEqual(native.vertices,decodeForestScenery(f.manifest,f.streams).vertices);
  assert.equal(requests.filter(name=>name==='vertices.bin').length,1);assert.equal(requests.filter(name=>name==='indices.bin').length,1);
  for(const name of Object.keys(f.textures))assert.equal(requests.filter(value=>value===name).length,1,name);
  const retained=native.vertices.slice();assert.equal(pack.releaseNativeCPU(),true);assert.equal(pack.releaseNativeCPU(),false);
  assert.deepEqual(native.vertices,retained,'cache release never detaches or mutates caller-held geometry');
  const fresh=pack.loadNative();assert.notEqual(fresh,a);assert.equal(pack.loadNative(),fresh);
  assert.deepEqual((await fresh).vertices,retained,'explicit reload verifies the original immutable bytes again');
  for(const name of ['vertices.bin','indices.bin',...Object.keys(f.textures)])assert.equal(requests.filter(value=>value===name).length,2,name+' reloaded once after release');
  const tampered=nativeFixture(),tamperedAtlas=attachAtlas(tampered);new Uint8Array(tampered.streams['vertices.bin'])[0]^=1;
  const delayed=await loadForestScenery({assets,impostorAssets:tamperedAtlas.assets,fetchAsset:async name=>name==='manifest.json'?Response.json(tampered.manifest):new Response(new Uint8Array(tamperedAtlas.responses[name]??tampered.streams[name]??tampered.textures[name]))});
  await assert.rejects(delayed.loadNative(),/Forest digest mismatch: vertices/);
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
test('geometry error certificates bind exact source and packed ranges without claiming appearance certification',()=>{
  const f=nativeFixture(),p=f.manifest.prototypes[0],receipt=file=>({file,bytes:4,sha256:'0'.repeat(64)});
  p.source={native:{glb:receipt('oak.glb')},directFar:receipt('oak-far.bin')};
  p.geometryErrorSupported=true;p.geometryErrorMetres=Math.fround(.02);p.geometryErrorMethod='symmetric-fixed-opposing-vertex-triangle-bound-v1';
  p.geometryErrorSource={nativeGLB:structuredClone(p.source.native.glb),farAsset:structuredClone(p.source.directFar),
    packedStreams:Object.fromEntries(['vertices.bin','indices.bin'].map(name=>[name,{bytes:f.manifest.files[name].bytes,sha256:f.manifest.files[name].sha256}])),
    measuredStreams:Object.fromEntries(['wood','leaf','far'].map(key=>[key,{bytes:p[key].indexCount*56,vertexCount:p[key].indexCount,strideFloats:14,sha256:'0'.repeat(64)}])),
    ranges:Object.fromEntries(['wood','leaf','far'].map(key=>[key,structuredClone(p[key])])),method:receipt('scripts/prepare-canopy-scenery.py#conservative_error')};
  assert.equal(validateForestScenery(f.manifest),f.manifest);assert.equal(f.manifest.appearanceErrorSupported,false);
  for(const edit of [p=>p.geometryErrorMetres=-1,p=>p.geometryErrorMetres=.02,p=>p.geometryErrorMethod='invented',
    p=>p.geometryErrorSource.nativeGLB.sha256='1'.repeat(64),p=>p.geometryErrorSource.farAsset.bytes++,
    p=>p.geometryErrorSource.packedStreams['indices.bin'].bytes++,p=>p.geometryErrorSource.ranges.leaf.indexCount=0,
    p=>p.geometryErrorSource.measuredStreams.far.strideFloats=13,p=>p.geometryErrorSource.method.file='other.py']){
    const manifest=structuredClone(f.manifest);edit(manifest.prototypes[0]);assert.throws(()=>validateForestScenery(manifest),/certificate/);
  }
  delete p.geometryErrorSupported;delete p.geometryErrorSource;assert.equal(validateForestScenery(f.manifest),f.manifest,'old source packs retain the whole-support fallback');
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
  const fetchAsset=async name=>name==='manifest.json'?Response.json(manifest):new Response(new Uint8Array(encoded[name]??textures[name]));
  assert.equal((await loadForestScenery({assets,fetchAsset,loadAtlases:false})).vertices.length,126);
  const original=Uint8Array.from(encoded['roots.bin.gz']);encoded['roots.bin.gz'][8]^=1;
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

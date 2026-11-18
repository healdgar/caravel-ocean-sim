// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {gzipSync} from 'node:zlib';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {validateForestScenery,validateForestMaterials,loadForestScenery,forestCoversPoint,excludeForestRoots,FOREST_ASSETS,SUBTROPICAL_FOREST_ASSETS,PORTUGAL_FOREST_ASSETS,FOREST_SURFACE_MIPS_WGSL} from '../js/forest-scenery.js';
import {forestContinuumMaterial,forestContinuumStandWGSL} from '../js/wgsl/forest-continuum.js';

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
// What the game fetches of a pack, as a fetch that notes each request.
function served(f,source=f){
  const requests=[],assets=Object.fromEntries(['manifest.json',...Object.keys(f.streams),...Object.keys(f.textures??{})].map(n=>[n,n]));
  const fetchAsset=async name=>{requests.push(name);return name==='manifest.json'?Response.json(source.manifest):new Response(new Uint8Array(source.streams[name]??source.textures[name]));};
  return {requests,assets,fetchAsset};
}
test('a pack loads as its roots and maps: its vertex and index streams stay on disk as the continuum bakes\' source',async()=>{
  const f=nativeFixture(),{requests,assets,fetchAsset}=served(f);
  assert.ok(Object.values(FOREST_ASSETS).every(path=>path.startsWith('assets/forest-scenery/')));
  for(const table of [FOREST_ASSETS,SUBTROPICAL_FOREST_ASSETS,PORTUGAL_FOREST_ASSETS])assert.equal(Object.keys(table).some(name=>/^(vertices|indices)\.bin/.test(name)),false);
  const pack=await loadForestScenery({assets,fetchAsset});
  assert.equal(pack.roots.length,12);assert.deepEqual(Object.keys(pack.textures).sort(),Object.keys(f.textures).sort());
  assert.equal('vertices' in pack,false);assert.equal('indices' in pack,false);
  assert.equal(requests.includes('vertices.bin'),false);assert.equal(requests.includes('indices.bin'),false);
});
test('deferred maps are fetched once, verified, and fetched afresh only after the pack lets them go',async()=>{
  const f=nativeFixture(),{requests,assets,fetchAsset}=served(f);
  const pack=await loadForestScenery({assets,fetchAsset,deferSurfaces:true});
  assert.equal(pack.textures,null);assert.equal(requests.some(name=>name.endsWith('.png')),false);assert.equal(pack.roots.length,12);
  const a=pack.loadSurfaces(),b=pack.loadSurfaces();assert.equal(a,b,'one cached map load');
  assert.deepEqual(Object.keys(await a).sort(),Object.keys(f.textures).sort());
  for(const name of Object.keys(f.textures))assert.equal(requests.filter(value=>value===name).length,1,name);
  pack.releaseSurfaces();const fresh=pack.loadSurfaces();assert.notEqual(fresh,a);await fresh;
  for(const name of Object.keys(f.textures))assert.equal(requests.filter(value=>value===name).length,2,name+' fetched again once let go');
  const tampered=nativeFixture();new Uint8Array(tampered.textures[Object.keys(tampered.textures)[0]])[4]^=1;
  const delayed=await loadForestScenery({...served(f,tampered),deferSurfaces:true});
  await assert.rejects(delayed.loadSurfaces(),/surface digest/i);
});
test('roots out of their species, their coverage or the ground are rejected before the GPU sees them',async()=>{
  for(const edit of [r=>r[8]=1,r=>r[0]=80,r=>r[9]=-.1,r=>r[3]=NaN]){
    const f=nativeFixture();edit(new Float32Array(f.streams['roots.bin']));
    f.manifest.files['roots.bin'].sha256=createHash('sha256').update(new Uint8Array(f.streams['roots.bin'])).digest('hex');
    const {assets,fetchAsset}=served(f);
    await assert.rejects(loadForestScenery({assets,fetchAsset}),/Invalid forest root transform/);
  }
});
test('invalid species, bounds, partitions, root receipts and invented error certification are rejected',()=>{
  for(const edit of [m=>m.appearanceErrorSupported=true,m=>m.prototypes[0].species='fir',m=>m.rootStride=32,m=>m.prototypes[0].radius=.1,
    m=>m.prototypes[0].leaf.firstIndex=0,m=>m.prototypes[0].firstRoot=1,m=>m.coverage.cells.push(0),m=>m.files['roots.bin'].bytes=0]){
    const {manifest}=fixture();edit(manifest);assert.throws(()=>validateForestScenery(manifest));
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
test('native material receipts are counted and checked',()=>{
  const {manifest}=nativeFixture();
  assert.equal(validateForestMaterials(manifest.prototypes),2);
  for(const edit of [m=>delete m.materialContract,m=>m.prototypes[0].nativeMaterials[0].albedo.encoding='linear',
    m=>m.prototypes[0].nativeMaterials[1].transmission=1.1,m=>m.prototypes[0].nativeMaterials[0].roughnessMap.file='../escape.png']){
    const f=nativeFixture();edit(f.manifest);assert.throws(()=>validateForestScenery(f.manifest));
  }
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
test('root transport verifies both encoded and decoded receipts',async()=>{
  const {manifest,streams,textures}=nativeFixture(),encoded={},assets=Object.fromEntries(['manifest.json',...Object.keys(textures)].map(name=>[name,name]));
  for(const [name,raw]of Object.entries(streams)){
    const bytes=gzipSync(new Uint8Array(raw));encoded[name+'.gz']=bytes;assets[name]=name+'.gz';
    manifest.files[name].gzip={file:name+'.gz',bytes:bytes.byteLength,sha256:createHash('sha256').update(bytes).digest('hex')};
  }
  const fetchAsset=async name=>name==='manifest.json'?Response.json(manifest):new Response(new Uint8Array(encoded[name]??textures[name]));
  assert.equal((await loadForestScenery({assets,fetchAsset})).roots.length,12);
  const original=Uint8Array.from(encoded['roots.bin.gz']);encoded['roots.bin.gz'][8]^=1;
  await assert.rejects(loadForestScenery({assets,fetchAsset}),/encoded digest/);
  encoded['roots.bin.gz']=original;manifest.files['roots.bin'].sha256='0'.repeat(64);
  await assert.rejects(loadForestScenery({assets,fetchAsset}),/Forest digest/);
});
test('forest rendering cannot fall back to the legacy generic mask or threshold averaged coverage',async()=>{
  const source=await readFile(new URL('../js/forest-scenery.js',import.meta.url),'utf8');
  // The forest is one family of the one continuum (js/wgsl/forest-continuum.js): its leaves are cut by sample
  // coverage alone (AGENTS.md rule 2), never a threshold on it, and nothing of it discards.
  const material=forestContinuumMaterial('');
  assert.equal(material.coverage,true,'leaves are cut by the sample mask');
  assert.doesNotMatch(material.wgsl(),/discard/,'trees never discard');
  assert.doesNotMatch(material.wgsl(),/leafSpray|tree-foliage|canopyLeafFS/);
  assert.match(material.wgsl(),/fn forestContinuumCoverage\(v:ContinuumVarying,front:bool\)->u32/);
  assert.match(FOREST_SURFACE_MIPS_WGSL,/forestMipLinear\(c\.rgb\)\*c\.a/);
  assert.match(FOREST_SURFACE_MIPS_WGSL,/colour\*\.25/);assert.doesNotMatch(FOREST_SURFACE_MIPS_WGSL,/discard|step\(/);
  // No selection, list, pipeline or ladder of its own: the forest stands its records and the one cut does the rest.
  assert.doesNotMatch(source,/setVertexBuffer|drawIndexedIndirect|nativeLod|nativeMid|previousLod|forestResidency|deferNative|loadNative|createRenderPipeline/);
});
test('the stand lists each tree in view or in the light box once, and sorts nothing by distance',()=>{
  const stand=forestContinuumStandWGSL();
  assert.equal(stand.split('atomicAdd(&forestStood[3],1u)').length-1,1);
  assert.match(stand,/if\(slot>=forestStand\.counts\.y\)\{return;\}/,'never past the scene\'s capacity');
  // Past 65,535 workgroups the roots spread over a second dimension, and their count is read exactly, not as a float.
  assert.equal(stand.split('let i=id.x+id.y*groups.x*64u;').length-1,1);
  assert.equal(stand.split('if(i>=forestStand.counts.x){return;}').length-1,1);
  assert.doesNotMatch(stand,/nearLod|midLod|farLod|previousLod|commands|atlasThreshold|sort/);
});
test('a procedural landfall skips the pack\'s roots, and a device with prebuilt surfaces its maps',async()=>{
  const f=nativeFixture(),{requests,assets,fetchAsset}=served(f);
  const pack=await loadForestScenery({assets,fetchAsset,skipRoots:true,deferSurfaces:true});
  assert.equal(pack.roots.length,0);assert.equal(pack.textures,null);
  assert.deepEqual(requests,['manifest.json']);
});

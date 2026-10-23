// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Small offline transport fixtures; no browser, GPU, baking or source assets.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {access,mkdir,mkdtemp,readFile,readdir,rm,writeFile} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gunzipSync,gzipSync} from 'node:zlib';
import {packageForestRuntime,parseArguments} from '../scripts/prepare-forest-runtime.mjs';

const receipt=raw=>({bytes:raw.byteLength,sha256:createHash('sha256').update(raw).digest('hex')});
const png=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+aDLsAAAAASUVORK5CYII=','base64');
async function fixture(t){
  const folder=await mkdtemp(join(tmpdir(),'forest-runtime-fixture-'));t.after(()=>rm(folder,{recursive:true,force:true}));
  const pack=join(folder,'pack'),atlases=join(folder,'atlases');await mkdir(pack);await mkdir(atlases);
  const files={
    'vertices.bin':Buffer.alloc(56*6,7),'indices.bin':Buffer.from(new Uint32Array([0,1,2,3,4,5]).buffer),
    'roots.bin':Buffer.alloc(48,9),'source-catalog.json':Buffer.from('{"originalGrowth":"older-baked-engine"}\n'),
  };
  // Birch legitimately has no wound material/maps. Do not invent either.
  const nativeMaterials=[];
  for(const [index,name,prefix]of [[0,'bark','birch-bark'],[1,'foliage_0','leaf-birch-0']]){
    const material={index,name,roughness:.81,underside:index?.38:0,transmission:index?.16:0,undersideReference:[.62,.7,.58],opacityThreshold:index?.35:0,wrap:index?'clamp':'repeat',clearcoat:index?0:.2};
    for(const [slot,suffix,encoding]of [['albedo','albedo','srgb'],['normal','normal','linear'],...(!index?[['roughnessMap','roughness','linear']]:[])]){
      const file=prefix+'-'+suffix+'.png';files[file]=Buffer.from(png);material[slot]={file,...receipt(png),encoding,width:1,height:1};
    }
    nativeMaterials.push(material);
  }
  const prototype={id:0,species:'birch',firstRoot:0,rootCount:1,wood:{firstIndex:0,indexCount:3},leaf:{firstIndex:3,indexCount:3},far:{firstIndex:6,indexCount:0},
    nativeMaterials,low:[0,0,0],high:[1,3,1],centre:[.5,1.5,.5],radius:2,
    source:{native:{materialContract:'gene-surfaces-v3',cohort:{originalSource:{engine:'older-baked-engine',age:25}},maps:Object.fromEntries(Object.entries(files).filter(([name])=>name.endsWith('.png')).map(([name,raw])=>[name,receipt(raw)]))}}};
  const manifest={format:'waterworld.forest-instances',version:2,units:'metres',upAxis:'Y',vertexStride:56,rootStride:48,rootCount:1,
    materialContract:'gene-surfaces-v3',prototypes:[prototype],nativeSource:{mode:'catalog-mature-usdz',ages:{birch:25}},
    files:Object.fromEntries(Object.entries(files).map(([name,raw])=>[name,receipt(raw)]))};
  for(const [name,raw]of Object.entries(files))await writeFile(join(pack,name),raw);
  const manifestRaw=Buffer.from(JSON.stringify(manifest,null,2)+'\n');await writeFile(join(pack,'manifest.json'),manifestRaw);
  const prefix='prototype-0-birch';await mkdir(join(atlases,prefix));
  const outputs={},atlasFiles={};
  for(const [slot,file,raw]of [
    ['albedo','albedo.rgba16f.bin',Buffer.alloc(4*4*8,13)],
    ['normalDepth','normal-depth.rgba16f.bin',Buffer.alloc(4*4*8,21)],
    ['albedoPNG','albedo.png',png],['preview','preview.png',png],
  ]){
    const name=prefix+'/'+file;atlasFiles[name]=raw;await writeFile(join(atlases,name),raw);
    outputs[slot]={file:name,...receipt(raw)};
    if(slot==='albedo'||slot==='normalDepth'){
      const zipped=gzipSync(raw,{level:9});await writeFile(join(atlases,name+'.gz'),zipped);
      outputs[slot].gzip={file:name+'.gz',...receipt(zipped),uncompressedSHA256:outputs[slot].sha256};
    }
  }
  const atlas={format:'waterworld.native-impostors',version:1,complete:true,units:'metres',upAxis:'Y',layout:{sphere:'full',atlasPixels:[4,4]},
    source:{manifest:receipt(manifestRaw),files:structuredClone(manifest.files),nativeSource:manifest.nativeSource},
    prototypes:[{id:0,species:'birch',source:structuredClone(prototype.source),nativeMaterials:structuredClone(nativeMaterials),
      detailedGeometry:{wood:structuredClone(prototype.wood),leaf:structuredClone(prototype.leaf)},outputs}]};
  await writeFile(join(atlases,'manifest.json'),JSON.stringify(atlas,null,2)+'\n');
  return {folder,pack,atlases,manifest,atlas,files,atlasFiles};
}

test('lossless deterministic geometry/atlas packaging keeps native maps and source receipts',async t=>{
  const f=await fixture(t),output=join(f.folder,'runtime-a'),other=join(f.folder,'runtime-b');
  await packageForestRuntime({...f,output});await packageForestRuntime({...f,output:other});
  const raw=await readFile(join(output,'manifest.json')),m=JSON.parse(raw);
  assert.deepEqual(raw,await readFile(join(other,'manifest.json')),'Output location/time must not enter deterministic metadata');
  assert.deepEqual(m.prototypes,f.manifest.prototypes,'No geometry/material/provenance metadata may change');
  assert.equal(m.prototypes[0].nativeMaterials.length,2);assert.ok(!m.prototypes[0].nativeMaterials.some(x=>x.name==='wounds'));
  for(const name of ['vertices.bin','indices.bin','roots.bin']){
    assert.equal(m.files[name].bytes,f.manifest.files[name].bytes);assert.equal(m.files[name].sha256,f.manifest.files[name].sha256);
    const gzip=m.files[name].gzip,zipped=await readFile(join(output,gzip.file));assert.deepEqual(receipt(zipped),{bytes:gzip.bytes,sha256:gzip.sha256});
    assert.deepEqual(gunzipSync(zipped),f.files[name]);assert.deepEqual(zipped,await readFile(join(other,gzip.file)));
    assert.deepEqual([...zipped.subarray(4,8)],[0,0,0,0]);assert.equal(zipped[9],255);
    await assert.rejects(access(join(output,name)),{code:'ENOENT'});
  }
  for(const [name,source]of Object.entries(f.files))if(!name.endsWith('.bin')){
    assert.deepEqual(await readFile(join(output,name)),source,'Original native image/catalog bytes must survive');
    assert.deepEqual(m.files[name],f.manifest.files[name]);
  }
  const atlasRaw=await readFile(join(output,m.impostors.file));assert.deepEqual(receipt(atlasRaw),{bytes:m.impostors.bytes,sha256:m.impostors.sha256});
  const a=JSON.parse(atlasRaw);
  assert.deepEqual(a.source,f.atlas.source);assert.deepEqual(a.prototypes[0].nativeMaterials,f.atlas.prototypes[0].nativeMaterials);
  for(const [kind,item]of Object.entries(a.prototypes[0].outputs)){
    if(kind==='albedo'||kind==='normalDepth'){
      const zipped=await readFile(join(output,'impostors',item.gzip.file));assert.deepEqual(receipt(zipped),{bytes:item.gzip.bytes,sha256:item.gzip.sha256});
      assert.deepEqual(gunzipSync(zipped),f.atlasFiles[item.file]);await assert.rejects(access(join(output,'impostors',item.file)),{code:'ENOENT'});
    }else assert.deepEqual(await readFile(join(output,'impostors',item.file)),f.atlasFiles[item.file]);
  }
  assert.deepEqual(await readFile(join(output,'source-forest-manifest.json')),await readFile(join(f.pack,'manifest.json')));
});

test('tampered native geometry fails without publishing a partial directory',async t=>{
  const f=await fixture(t),output=join(f.folder,'runtime');await writeFile(join(f.pack,'vertices.bin'),Buffer.alloc(56*6,99));
  await assert.rejects(packageForestRuntime({...f,output}),/Receipt mismatch/);await assert.rejects(access(output),{code:'ENOENT'});
});

test('tampered compressed atlas and a stale source manifest are rejected',async t=>{
  const f=await fixture(t),output=join(f.folder,'runtime'),file=f.atlas.prototypes[0].outputs.albedo.gzip.file;
  await writeFile(join(f.atlases,file),Buffer.from('damaged gzip'));
  await assert.rejects(packageForestRuntime({...f,output}),/Receipt mismatch/);
  const g=await fixture(t);g.atlas.source.manifest.sha256='0'.repeat(64);
  await writeFile(join(g.atlases,'manifest.json'),JSON.stringify(g.atlas));
  await assert.rejects(packageForestRuntime({...g,output:join(g.folder,'runtime')}),/Atlas source forest manifest/);
});

test('an atlas cannot substitute native materials or detailed geometry ranges',async t=>{
  for(const mode of ['material','geometry']){
    const f=await fixture(t),output=join(f.folder,'runtime');
    if(mode==='material')f.atlas.prototypes[0].nativeMaterials[0].roughness=.2;
    else f.atlas.prototypes[0].detailedGeometry.leaf.firstIndex=0;
    await writeFile(join(f.atlases,'manifest.json'),JSON.stringify(f.atlas));
    await assert.rejects(packageForestRuntime({...f,output}),mode==='material'?/source\/materials differ/:/geometry ranges differ/);
    await assert.rejects(access(output),{code:'ENOENT'});
  }
});

test('existing output is preserved and arguments cannot silently overwrite',async t=>{
  const f=await fixture(t),output=join(f.folder,'existing');await mkdir(output);await writeFile(join(output,'keep'),'existing user data');
  await assert.rejects(packageForestRuntime({...f,output}),/already exists/);assert.equal(await readFile(join(output,'keep'),'utf8'),'existing user data');
  assert.deepEqual((await readdir(output)),['keep']);
  assert.deepEqual(parseArguments(['--pack','p','--atlases','a','--output','o']),{pack:'p',atlases:'a',output:'o'});
  assert.throws(()=>parseArguments(['--pack','p','--pack','p2','--atlases','a','--output','o']),/repeated/);
});

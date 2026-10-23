// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Synthetic source-byte fixtures; root alone executes tests.
import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtemp,mkdir,readFile,rm,writeFile,access} from 'node:fs/promises';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {gzipSync,gunzipSync} from 'node:zlib';
import {inspectionReceipt as receipt,prepareForestInspection} from '../scripts/prepare-forest-inspection.mjs';

const floats=values=>{const b=Buffer.alloc(values.length*4);values.forEach((v,i)=>b.writeFloatLE(v,i*4));return b;};
const uints=values=>{const b=Buffer.alloc(values.length*4);values.forEach((v,i)=>b.writeUInt32LE(v,i*4));return b;};
const row=(x,y,z,kind,material,u=0,v=0)=>[x,y,z,0,1,0,kind,.72,u,v,.25,.5,.75,material];

async function fixture(folder,{gzip=true,leafCount=64}={}){
 await mkdir(folder);const rows=[],indices=[],prototypes=[],maps={'leaf-albedo.png':Buffer.from('fixture original pigment PNG bytes'),'leaf-normal.png':Buffer.from('fixture original normal PNG bytes')};
 for(const [id,species]of [[0,'oak'],[2,'birch']]){
  const wood={firstIndex:indices.length,indexCount:3},woodStart=rows.length;
  rows.push(row(-1,0,0,3,1),row(1,0,0,3,1),row(0,1,0,3,1));indices.push(woodStart,woodStart+1,woodStart+2);
  const leaf={firstIndex:indices.length,indexCount:leafCount*12};
  for(let blade=0;blade<leafCount;blade++){
   const at=rows.length,x=(blade%8)*.6,z=Math.floor(blade/8)*.6;
   rows.push(row(x,2,z,4,0,.5,.5),row(x-.2,2,z-.1,4,0,0,0),row(x+.2,2,z-.1,4,0,1,0),row(x+.2,2,z+.1,4,0,1,1),row(x-.2,2,z+.1,4,0,0,1));
   indices.push(at,at+1,at+2,at,at+2,at+3,at,at+3,at+4,at,at+4,at+1);
  }
  const nativeMaps=Object.fromEntries(Object.entries(maps).map(([file,raw])=>[file,{file,...receipt(raw)}]));
  prototypes.push({id,species,wood,leaf,nativeMaterials:[{index:0,name:'foliage_0',wrap:'clamp',opacityThreshold:.5,roughness:.8,underside:.2,transmission:.15,undersideReference:[.2,.3,.1],
   albedo:{...nativeMaps['leaf-albedo.png'],width:1,height:1,encoding:'srgb'},normal:{...nativeMaps['leaf-normal.png'],width:1,height:1,encoding:'linear'}}],source:{native:{materialContract:'gene-surfaces-v3',maps:nativeMaps}}});
 }
 const vertices=floats(rows.flat()),indexRaw=uints(indices),roots=Buffer.alloc(48),streams={'vertices.bin':vertices,'indices.bin':indexRaw,'roots.bin':roots},files={};
 for(const [name,raw]of Object.entries({...streams,...maps})){files[name]=receipt(raw);if(gzip&&!name.endsWith('.png')){const z=gzipSync(raw,{mtime:0});files[name].gzip={file:name+'.gz',...receipt(z)};await writeFile(join(folder,name+'.gz'),z);}else await writeFile(join(folder,name),raw);}
 const ao=Buffer.alloc(Math.ceil(rows.length/4)*4,255);for(let i=0;i<rows.length;i++)ao[i]=(i*37)%256;
 const encoded=gzipSync(ao,{mtime:0}),sourceFiles=Object.fromEntries(Object.entries(streams).map(([name,raw])=>[name,receipt(raw)]));
 const light={format:'waterworld.native-canopy-light',version:1,vertexCount:rows.length,recipe:{version:1},source:{files:sourceFiles,method:{file:'scripts/prepare-forest-light.py'}},
  prototypes:prototypes.map(p=>({id:p.id,species:p.species,membership:Object.fromEntries(['wood','leaf'].map(k=>[k,{...p[k],indices:receipt(indexRaw.subarray(p[k].firstIndex*4,(p[k].firstIndex+p[k].indexCount)*4))}]))})),
  files:{'canopy-shade.bin':{...receipt(ao),gzip:{file:'canopy-shade.bin.gz',...receipt(encoded)}}}};
 const lightRaw=Buffer.from(JSON.stringify(light));await writeFile(join(folder,'canopy-shade.bin.gz'),encoded);await writeFile(join(folder,'canopy-shade.json'),lightRaw);
 const manifest={format:'waterworld.forest-instances',version:2,vertexStride:56,units:'metres',upAxis:'Y',materialContract:'gene-surfaces-v3',files,prototypes,canopyShade:{file:'canopy-shade.json',...receipt(lightRaw)}};
 await writeFile(join(folder,'manifest.json'),JSON.stringify(manifest));return{manifest,vertices,indexRaw,ao,indices,rows};
}
async function decoded(folder,item){const encoded=await readFile(join(folder,item.gzip.file));assert.deepEqual(receipt(encoded),{bytes:item.gzip.bytes,sha256:item.gzip.sha256});const raw=gunzipSync(encoded);assert.deepEqual(receipt(raw),{bytes:item.bytes,sha256:item.sha256});return raw;}

test('inspection pages preserve original56B records, AO, complete blades and index winding',async()=>{
 const tmp=await mkdtemp(join(tmpdir(),'forest-inspection-'));
 try{
  const pack=join(tmp,'source'),out=join(tmp,'inspection'),f=await fixture(pack),sourceBefore=await readFile(join(pack,'manifest.json'));
  const m=await prepareForestInspection({pack,out,prototype:[0,2],nodesPerPage:1});assert.equal(m.format,'waterworld.forest-inspection-pilot');assert.equal(m.vertexStride,60);assert.equal(m.qualified,false);
  let gpuBytes=0;
  for(const p of m.prototypes){const original=f.manifest.prototypes.find(q=>q.id===p.id),order=await decoded(out,p.hierarchy.leafOrder),seen=[];
   assert.equal(p.pages.length,2);assert.equal(p.triangleCount,original.leaf.indexCount/3);assert.equal(p.nativeMaterials.length,1);
   for(const page of p.pages){const v=await decoded(out,page.files.vertices),i=await decoded(out,page.files.indices),ids=await decoded(out,page.files.sourceIDs);gpuBytes+=v.length+i.length;
    for(let at=0;at<page.vertexCount;at++){const global=ids.readUInt32LE(at*4);assert.ok(v.subarray(at*60,at*60+56).equals(f.vertices.subarray(global*56,(global+1)*56)));assert.equal(v.readFloatLE(at*60+56),Math.fround(f.ao[global]/255));}
    for(const clusterID of page.clusterIDs){const c=p.clusters[clusterID];assert.equal(c.page,page.index);assert.ok(c.leafCount<=32);assert.equal(c.indexCount,c.leafCount*12);assert.ok(c.indexCount<=384);
     for(let leaf=0;leaf<c.leafCount;leaf++){const originalLeaf=order.readUInt32LE((c.firstLeaf+leaf)*4);seen.push(originalLeaf);
      for(let corner=0;corner<12;corner++){const compact=i.readUInt32LE((c.firstIndex+leaf*12+corner)*4),global=ids.readUInt32LE(compact*4);assert.equal(global,f.indices[original.leaf.firstIndex+originalLeaf*12+corner]);}}
    }
   }
   assert.deepEqual(seen.sort((a,b)=>a-b),Array.from({length:64},(_,i)=>i));
  }
  assert.equal(m.decodedGPUBytes,gpuBytes);assert.ok((await readFile(join(pack,'manifest.json'))).equals(sourceBefore));
  await assert.rejects(prepareForestInspection({pack,out,prototype:[0]}),/Fresh output/);
 }finally{await rm(tmp,{recursive:true,force:true});}
});

test('raw native input works without copying original leaf maps or emitting wood',async()=>{
 const tmp=await mkdtemp(join(tmpdir(),'forest-inspection-raw-'));
 try{const pack=join(tmp,'source'),out=join(tmp,'out');await fixture(pack,{gzip:false});const m=await prepareForestInspection({pack,out,prototype:[2],nodesPerPage:64});
  assert.equal(m.prototypes.length,1);assert.equal(m.prototypes[0].pages.length,1);assert.equal(m.prototypes[0].pages[0].clusterIDs.length,2);
  for(const p of m.prototypes)for(const page of p.pages){const raw=await decoded(out,page.files.vertices);for(let at=0;at<raw.length;at+=60)assert.equal(raw.readFloatLE(at+24),4);}
  assert.ok(m.source.files['leaf-albedo.png']);await assert.rejects(access(join(out,'leaf-albedo.png')));assert.ok(m.source.assetBaseHint.endsWith('source'));
 }finally{await rm(tmp,{recursive:true,force:true});}
});

test('corrupt native AO transport or membership prevents any published pack',async()=>{
 const tmp=await mkdtemp(join(tmpdir(),'forest-inspection-bad-'));
 try{const pack=join(tmp,'source'),out=join(tmp,'out');await fixture(pack);const file=join(pack,'canopy-shade.bin.gz'),raw=await readFile(file);raw[raw.length-1]^=1;await writeFile(file,raw);
  await assert.rejects(prepareForestInspection({pack,out,prototype:[0]}),/Encoded source receipt/);await assert.rejects(access(out));
  const second=join(tmp,'second');const f=await fixture(second);const lightPath=join(second,'canopy-shade.json'),light=JSON.parse(await readFile(lightPath));light.prototypes[0].membership.leaf.firstIndex++;
  const changed=Buffer.from(JSON.stringify(light));await writeFile(lightPath,changed);f.manifest.canopyShade={file:'canopy-shade.json',...receipt(changed)};await writeFile(join(second,'manifest.json'),JSON.stringify(f.manifest));
  await assert.rejects(prepareForestInspection({pack:second,out,prototype:[0]}),/membership differs/);await assert.rejects(access(out));
 }finally{await rm(tmp,{recursive:true,force:true});}
});

test('unsafe controls, unknown sources and source-nested output fail without truncation',async()=>{
 const tmp=await mkdtemp(join(tmpdir(),'forest-inspection-controls-'));
 try{const pack=join(tmp,'source');await fixture(pack);
  await assert.rejects(prepareForestInspection({pack,out:join(tmp,'a'),prototype:[0],nodesPerPage:0}),/Unsafe inspection/);
  await assert.rejects(prepareForestInspection({pack,out:join(tmp,'b'),prototype:[99]}),/Unknown selected/);
  await assert.rejects(prepareForestInspection({pack,out:join(pack,'nested'),prototype:[0]}),/outside source pack/);
  await assert.rejects(prepareForestInspection({pack,out:join(tmp,'c'),prototype:[0],maxDecodedMiB:0}),/Unsafe inspection/);
 }finally{await rm(tmp,{recursive:true,force:true});}
});

test('an actual decoded budget overflow rejects the whole pack without dropping blades',async()=>{
 const tmp=await mkdtemp(join(tmpdir(),'forest-inspection-budget-'));
 try{const pack=join(tmp,'source'),out=join(tmp,'out');await fixture(pack,{leafCount:2048});const before=await readFile(join(pack,'manifest.json'));
  await assert.rejects(prepareForestInspection({pack,out,maxDecodedMiB:1}),/Decoded inspection budget exceeded/);
  await assert.rejects(access(out));assert.ok((await readFile(join(pack,'manifest.json'))).equals(before));
 }finally{await rm(tmp,{recursive:true,force:true});}
});

// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Synthetic transport/ownership tests. PNG decode is mocked here; real PNG and
// shader appearance require root's browser review, not this fixture.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {gzipSync} from 'node:zlib';
import {loadForestInspectionPilot} from '../js/forest-lod-inspection.js';

const receipt=bytes=>({bytes:bytes.byteLength,sha256:createHash('sha256').update(bytes).digest('hex')});
const bytes=array=>Buffer.from(array.buffer,array.byteOffset,array.byteLength);
const pattern=[0,1,3,1,4,3,1,2,4,2,5,4];
const PNG=Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVQIHWP4z8DwHwAFgAI/ScLbtAAAAABJRU5ErkJggg==','base64');
function fixture(){
 const assets=new Map(),calls=[],N=128,originalVertices=new Float32Array(N*6*14),originalIndices=new Uint32Array(N*12),order=Uint32Array.from({length:N},(_,i)=>N-1-i);
 for(let leaf=0;leaf<N;leaf++){
  const points=[[0,0],[1,0],[2,0],[0,1],[1,1],[2,1]];
  for(let corner=0;corner<6;corner++)originalVertices.set([leaf*3+points[corner][0],points[corner][1],0,0,0,1,4,.72,points[corner][0]/2,points[corner][1],1,1,1,3],(leaf*6+corner)*14);
  originalIndices.set(pattern.map(i=>leaf*6+i),leaf*12);
 }
 const sourceFiles={'vertices.bin':receipt(bytes(originalVertices)),'indices.bin':receipt(bytes(originalIndices)),'roots.bin':receipt(Buffer.alloc(48))},map=(file,encoding)=>({file,...receipt(PNG),encoding,width:1,height:1});
 const material={index:3,name:'foliage_0',wrap:'clamp',roughness:.9,underside:.3,transmission:.25,opacityThreshold:.35,undersideReference:[.2,.3,.1],albedo:map('pigment.png','srgb'),normal:map('normal.png','linear')};
 const nativeMaps=Object.fromEntries([material.albedo,material.normal].map(r=>[r.file,{...r}]));Object.assign(sourceFiles,nativeMaps);
 const original={id:0,species:'oak',leaf:{firstIndex:0,indexCount:originalIndices.length},nativeMaterials:[material],source:{native:{maps:nativeMaps,materialContract:'gene-surfaces-v3'}}};
 const shade={format:'waterworld.native-canopy-light',version:1,vertexCount:N*6,source:{files:Object.fromEntries(['vertices.bin','indices.bin','roots.bin'].map(key=>[key,sourceFiles[key]]))},files:{'canopy-shade.bin':receipt(Buffer.alloc(N*6,51))},prototypes:[{id:0,species:'oak',membership:{leaf:{...original.leaf,indices:receipt(bytes(originalIndices))}}}]},shadeRaw=Buffer.from(JSON.stringify(shade)),shadePointer={file:'canopy-shade.json',...receipt(shadeRaw)};
 const source={format:'waterworld.forest-instances',version:2,units:'metres',upAxis:'Y',vertexStride:56,materialContract:'gene-surfaces-v3',files:sourceFiles,prototypes:[original],canopyShade:shadePointer},sourceRaw=Buffer.from(JSON.stringify(source));
 assets.set('/source/manifest.json',sourceRaw);assets.set('/source/canopy-shade.json',shadeRaw);for(const r of Object.values(nativeMaps))assets.set('/source/'+r.file,PNG);
 const transport=(file,raw)=>{const encoded=gzipSync(raw);assets.set('/pilot/'+file+'.gz',encoded);return{file,...receipt(raw),gzip:{file:file+'.gz',...receipt(encoded)}};};
 const nodes=[{id:0,parent:-1,children:[1,4],firstLeaf:0,leafCount:128},{id:1,parent:0,children:[2,3],firstLeaf:0,leafCount:64},{id:2,parent:1,children:[],firstLeaf:0,leafCount:32},{id:3,parent:1,children:[],firstLeaf:32,leafCount:32},{id:4,parent:0,children:[5,6],firstLeaf:64,leafCount:64},{id:5,parent:4,children:[],firstLeaf:64,leafCount:32},{id:6,parent:4,children:[],firstLeaf:96,leafCount:32}],frontier=[2,3,5,6],pages=[],clusters=[],pageRaw=[];
 for(let page=0;page<2;page++){
  const v=new Float32Array(64*6*15),i=new Uint32Array(64*12),s=new Uint32Array(64*6),clusterIDs=[];
  for(let j=0;j<64;j++){
   const leaf=order[page*64+j];
   for(let corner=0;corner<6;corner++){v.set(originalVertices.subarray((leaf*6+corner)*14,(leaf*6+corner+1)*14),(j*6+corner)*15);v[(j*6+corner)*15+14]=51/255;s[j*6+corner]=leaf*6+corner;}
   i.set(pattern.map(k=>j*6+k),j*12);
  }
  for(let local=0;local<2;local++){
   const id=page*2+local,node=nodes[frontier[id]],firstVertex=local*32*6,firstIndex=local*32*12,ownIDs=s.subarray(firstVertex,firstVertex+32*6),global=Uint32Array.from(i.subarray(firstIndex,firstIndex+32*12),id=>s[id]);
   const low=[order[node.firstLeaf+31]*3,0,0],high=[order[node.firstLeaf]*3+2,1,0],centre=low.map((x,k)=>(x+high[k])*.5),radius=Math.hypot(...high.map((x,k)=>(x-low[k])*.5));
   clusters.push({id,sourceNodeID:node.id,parentNodeID:node.parent,firstLeaf:node.firstLeaf,leafCount:32,page,firstVertex,vertexCount:32*6,firstIndex,indexCount:32*12,low,high,centre,radius,extent:radius,sourceMembership:{leafIDs:receipt(bytes(order.subarray(node.firstLeaf,node.firstLeaf+32))),originalGlobalIndices:receipt(bytes(global)),originalGlobalVertexIDs:receipt(bytes(ownIDs))}});clusterIDs.push(id);
  }
  const files={vertices:transport(`page-${page}-vertices.bin`,bytes(v)),indices:transport(`page-${page}-indices.bin`,bytes(i)),sourceIDs:transport(`page-${page}-source-ids.bin`,bytes(s))};
  pages.push({index:page,clusterIDs,vertexCount:v.length/15,indexCount:i.length,triangleCount:i.length/3,decodedGPUBytes:v.byteLength+i.byteLength,files});pageRaw.push({vertices:Buffer.from(bytes(v)),indices:Buffer.from(bytes(i)),sourceIDs:Buffer.from(bytes(s))});
 }
 const prototype={id:0,species:'oak',source:original.source,nativeMaterials:[material],sourceLeafRange:{...original.leaf,indices:receipt(bytes(originalIndices))},biologicalRootXYZ:[0,0,0],groundPlaneY:0,low:[0,0,0],high:[383,1,0],centre:[191.5,.5,0],leafCount:N,leafTriangles:4,hierarchy:{root:0,leafOrder:transport('leaf-order.u32.bin',bytes(order)),nodes},clusters,pages,triangleCount:N*4};
 const m={format:'waterworld.forest-inspection-pilot',version:1,experimental:true,qualified:false,complete:true,units:'metres',upAxis:'Y',vertexStride:60,indexType:'uint32',attributes:{originalNativeRecord:{offset:0,bytes:56},position:{offset:0,components:3},normal:{offset:12,components:3},kindShade:{offset:24,components:2},uv:{offset:32,components:2},linearRGB:{offset:40,components:3},nativeMaterial:{offset:52,components:1},canopyAO:{offset:56,components:1}},source:{manifest:{file:'manifest.json',...receipt(sourceRaw)},files:{...sourceFiles,'canopy-shade.json':shadePointer,'canopy-shade.bin':{file:'canopy-shade.bin',...shade.files['canopy-shade.bin']}},canopyShade:{manifest:shadePointer,field:{file:'canopy-shade.bin',...shade.files['canopy-shade.bin']}},methods:['scripts/prepare-forest-inspection.mjs','scripts/forest-lod-clusters.mjs'].map(file=>({file,...receipt(Buffer.from(file))}))},layout:{maximumLeavesPerCluster:32,maximumTrianglesPerCluster:128,maximumPulledVerticesPerCluster:384,nodesPerPage:2},maximumDecodedBytes:1024*1024,maximumEncodedBytes:1024*1024,maximumCombinedBytes:2*1024*1024,prototypes:[prototype]};
 function refresh(){const records=[prototype.hierarchy.leafOrder,...pages.flatMap(p=>Object.values(p.files))];m.decodedGPUBytes=pages.reduce((sum,p)=>sum+p.decodedGPUBytes,0);m.decodedSourceIDBytes=prototype.hierarchy.leafOrder.bytes+pages.reduce((sum,p)=>sum+p.files.sourceIDs.bytes,0);m.encodedBytes=records.reduce((sum,r)=>sum+r.gzip.bytes,0);assets.set('/pilot/manifest.json',Buffer.from(JSON.stringify(m)));}
 const f={manifest:m,prototype,assets,calls,pageRaw,originalVertices,originalIndices,order,refresh,failOnce:null,
  replaceEncoded(r,encoded){r.gzip={file:r.file+'.gz',...receipt(encoded)};assets.set('/pilot/'+r.gzip.file,encoded);refresh();},
  replaceRaw(r,raw){Object.assign(r,transport(r.file,raw));refresh();},
  async fetchAsset(url){calls.push(url);assert.doesNotMatch(url,/\/source\/(?:vertices\.bin|indices\.bin|roots\.bin|canopy-shade\.bin)/,'original full geometry/AO download is forbidden');if(f.failOnce===url){f.failOnce=null;return new Response(new Uint8Array([0,1,2]));}const data=assets.get(url);return data?new Response(Uint8Array.from(data)):new Response(null,{status:404});},
 };
 refresh();return f;
}
async function bitmapFixture(run){
 const original=globalThis.createImageBitmap,opened=[];
 globalThis.createImageBitmap=async(blob,options)=>{assert.deepEqual(options,{premultiplyAlpha:'none',colorSpaceConversion:'none',imageOrientation:'none'});assert.equal(blob.type,'image/png');const bitmap={width:opened.nextWidth??1,height:1,closes:0,close(){this.closes++;}};delete opened.nextWidth;opened.push(bitmap);return bitmap;};
 try{return await run(opened);}finally{if(original===undefined)delete globalThis.createImageBitmap;else globalThis.createImageBitmap=original;}
}
const load=(f,options={})=>loadForestInspectionPilot('/pilot',{sourceBase:'/source',fetchAsset:f.fetchAsset,allowExperimental:true,...options});

test('inspection requires explicit review before fetching any asset',async()=>{
 let requests=0;await assert.rejects(loadForestInspectionPilot('/pilot',{sourceBase:'/source',fetchAsset:async()=>{requests++;throw Error('unexpected');}}),/experimental/);assert.equal(requests,0);
});

test('complete multi-page source membership and sparse material indices survive without native geometry fetch',async()=>bitmapFixture(async opened=>{
 const f=fixture(),loader=await load(f),p=await loader.loadPrototype(0);assert.equal(p.vertexStride,60);assert.equal(p.vertices.byteLength,128*6*60);assert.equal(p.indices.length,128*12);assert.equal(p.materials.length,1);assert.equal(p.materials[0].index,3);assert.equal(p.sourceIDs[0],127*6);
 assert.deepEqual(p.leafOrder,f.order);assert.equal(p.ranges.get(6).firstVertex,576);assert.equal(p.ranges.get(6).firstIndex,1152);assert.deepEqual(p.indices.slice(1152,1164),Uint32Array.from(pattern,k=>576+k),'page base is added once; cluster firstVertex is already represented by page-local IDs');
 const rows=new Float32Array(p.vertices.buffer);for(let n=0;n<p.sourceIDs.length;n++){assert.deepEqual(rows.slice(n*15,n*15+14),f.originalVertices.slice(p.sourceIDs[n]*14,p.sourceIDs[n]*14+14));assert.ok(Math.abs(rows[n*15+14]-.2)<1e-7);}
 assert.equal(p.stats.sourceGeometryFetched,false);assert.equal(p.stats.sourceMembershipVerified,true);assert.match(p.stats.qualification,/no native appearance certificate/);assert.equal(p.textures.size,2);for(const [file,r]of p.textures){assert.deepEqual(Buffer.from(r.bytes),PNG);assert.equal(r.width,1);assert.equal(r.receipt.file,file);assert.ok(opened.includes(r.bitmap));}
 assert.deepEqual(f.calls.slice(0,3),['/pilot/manifest.json','/source/manifest.json','/source/canopy-shade.json']);assert.deepEqual(f.calls.slice(3,10),['/pilot/leaf-order.u32.bin.gz','/pilot/page-0-vertices.bin.gz','/pilot/page-0-indices.bin.gz','/pilot/page-0-source-ids.bin.gz','/pilot/page-1-vertices.bin.gz','/pilot/page-1-indices.bin.gz','/pilot/page-1-source-ids.bin.gz']);
 p.destroy();p.destroy();assert.ok(opened.every(b=>b.closes===1),'pack owns and closes each original bitmap exactly once');
}));

test('broken frontier, source metadata, byte budgets and pull bounds reject without truncation',async()=>{
 for(const mutate of [f=>f.prototype.clusters[1].firstLeaf=0,f=>f.prototype.clusters[0].indexCount=385,f=>f.prototype.pages[0].clusterIDs=[0,0],f=>f.prototype.clusters[0].firstVertex=1,f=>f.prototype.hierarchy.nodes[1].children=[2,2],f=>f.manifest.source.canopyShade.field.sha256='0'.repeat(64)]){
  const f=fixture();mutate(f);f.refresh();await assert.rejects(load(f),/Forest inspection/);assert.ok(!f.calls.some(x=>x.endsWith('-vertices.bin.gz')));
 }
 const f=fixture(),loader=await load(f,{maxDecodedBytes:1000});await assert.rejects(loader.loadPrototype(0),/complete decoded budget/);assert.equal(f.calls.length,3,'overflow fails before allocating/fetching prototype pages');
});

test('encoded/decoded corruption and bounded gzip expansion are independently rejected',async()=>{
 for(const mode of ['encoded','decoded','expansion','short']){
  const f=fixture(),r=f.prototype.hierarchy.leafOrder;
  if(mode==='encoded')r.gzip.sha256='0'.repeat(64);
  if(mode==='decoded')r.sha256='0'.repeat(64);
  if(mode==='expansion')f.replaceEncoded(r,gzipSync(Buffer.alloc(r.bytes+4)));
  if(mode==='short')f.replaceEncoded(r,gzipSync(Buffer.alloc(r.bytes-4)));
  f.refresh();const loader=await load(f);await assert.rejects(loader.loadPrototype(0),mode==='expansion'?/gzip expands/:mode==='short'?/short decoded/:/digest mismatch/);
 }
});

test('indices cannot escape source clusters and winding/membership may not silently change',async()=>{
 for(const mode of ['cross-cluster','winding','global-membership','duplicate-leaf','material','nonfinite']){
  const f=fixture();
  if(mode==='duplicate-leaf'){const ids=Uint32Array.from(f.order);ids[1]=ids[0];f.replaceRaw(f.prototype.hierarchy.leafOrder,bytes(ids));}
  else if(mode==='material'||mode==='nonfinite'){const raw=Buffer.from(f.pageRaw[0].vertices);raw.writeFloatLE(mode==='material'?0:NaN,(mode==='material'?13:3)*4);f.replaceRaw(f.prototype.pages[0].files.vertices,raw);}
  else{
   const raw=Buffer.from(f.pageRaw[0].indices);if(mode==='cross-cluster')raw.writeUInt32LE(0,384*4);else{const a=raw.readUInt32LE(0),b=raw.readUInt32LE(4);raw.writeUInt32LE(b,0);raw.writeUInt32LE(a,4);}f.replaceRaw(f.prototype.pages[0].files.indices,raw);
   if(mode==='global-membership'){
    // A self-consistent replacement page/cluster receipt still may not redefine
    // the original AO manifest's independent complete source-leaf membership.
    const c=f.prototype.clusters[0],sourceIDs=f.pageRaw[0].sourceIDs,global=Uint32Array.from({length:c.indexCount},(_,j)=>sourceIDs.readUInt32LE(raw.readUInt32LE((c.firstIndex+j)*4)*4));c.sourceMembership.originalGlobalIndices=receipt(bytes(global));f.refresh();
   }
  }
  const loader=await load(f);await assert.rejects(loader.loadPrototype(0),mode==='cross-cluster'?/escapes its source cluster/:mode==='duplicate-leaf'?/leaf order/:mode==='material'||mode==='nonfinite'?/source record/:mode==='global-membership'?/reconstructed complete original leaf index order.*digest mismatch/:/original indices.*digest mismatch/);
 }
});

test('decoded PNG dimensions are authoritative and a rejected bitmap is owned and released',async()=>bitmapFixture(async opened=>{
 const f=fixture(),loader=await load(f);opened.nextWidth=2;await assert.rejects(loader.loadPrototype(0),/original PNG dimensions differ/);assert.equal(opened.length,1);assert.equal(opened[0].closes,1);
 const p=await loader.loadPrototype(0);assert.equal(p.textures.size,2);assert.equal(opened.length,3);p.destroy();assert.ok(opened.every(b=>b.closes===1),'retry owns fresh bitmaps; failed decoder result is never retained');
}));

test('failed page/PNG loads do not poison retry or leak another pack bitmap',async()=>bitmapFixture(async opened=>{
 const f=fixture(),loader=await load(f);f.failOnce='/pilot/page-0-indices.bin.gz';await assert.rejects(loader.loadPrototype(0),/digest mismatch/);assert.equal(opened.length,0);
 f.failOnce='/source/normal.png';await assert.rejects(loader.loadPrototype(0),/digest mismatch/);assert.equal(opened.length,1);assert.equal(opened[0].closes,1,'earlier pigment bitmap released on later PNG failure');
 const [a,b]=await Promise.all([loader.loadPrototype(0),loader.loadPrototype(0)]);assert.equal(opened.length,5);a.destroy();assert.equal(opened[1].closes,1);assert.equal(opened[2].closes,1);assert.equal(opened[3].closes,0);assert.equal(opened[4].closes,0);b.destroy();assert.ok(opened.every(x=>x.closes===1));
}));

test('offline geometry loading verifies original membership without PNG fetches or a decoder',async()=>{
 const f=fixture(),loader=await load(f),geometry=await loader.loadGeometry(0);
 assert.equal(geometry.geometryOnly,true);assert.equal(geometry.stats.sourceMembershipVerified,true);assert.equal(geometry.textures.size,0);assert.equal(geometry.indices.length,f.originalIndices.length);assert.deepEqual(geometry.leafOrder,f.order);assert.ok(f.calls.every(url=>!url.endsWith('.png')));assert.ok(f.calls.every(url=>!url.includes('/source/vertices.bin')));
 geometry.destroy();geometry.destroy();
 const raw=Buffer.from(f.pageRaw[0].indices);raw.writeUInt32LE(999999,0);f.replaceRaw(f.prototype.pages[0].files.indices,raw);
 const corrupted=await load(f);await assert.rejects(corrupted.loadGeometry(0),/escapes.*source cluster/);
});

test('geometry-only requests do not suppress later explicit original texture loading',async()=>bitmapFixture(async opened=>{
 const f=fixture(),loader=await load(f),[geometry,textured]=await Promise.all([loader.loadGeometry(0),loader.loadPrototype(0)]);
 assert.equal(geometry.geometryOnly,true);assert.equal(textured.geometryOnly,false);assert.deepEqual(geometry.vertices,textured.vertices);assert.deepEqual(geometry.indices,textured.indices);assert.equal(geometry.textures.size,0);assert.equal(textured.textures.size,2);assert.equal(opened.length,2);
 geometry.destroy();assert.ok(opened.every(bitmap=>bitmap.closes===0));textured.destroy();assert.ok(opened.every(bitmap=>bitmap.closes===1));
}));

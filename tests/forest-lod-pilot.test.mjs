// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Synthetic metadata/transport checks. No GPU or appearance qualification.
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {test} from 'node:test';
import {gzipSync} from 'node:zlib';
import {validateForestClusterPilot,loadForestClusterPilot,packForestClusterMips,forestClusterNodes} from '../js/forest-lod-pilot.js';

const pilotTestReceipt=raw=>({bytes:raw.byteLength,sha256:createHash('sha256').update(raw).digest('hex')});
const pilotTestChannels=['albedo','normalDepth','lighting'];
function pilotTestFixture(){
 const frames=[
  {direction:[1,0,0],right:[0,0,-1],up:[0,1,0]},
  {direction:[-1,0,0],right:[0,0,1],up:[0,1,0]},
  {direction:[0,1,0],right:[-1,0,0],up:[0,0,1]},
  {direction:[0,-1,0],right:[1,0,0],up:[0,0,1]},
  {direction:[0,0,1],right:[1,0,0],up:[0,1,0]},
  {direction:[0,0,-1],right:[-1,0,0],up:[0,1,0]},
 ];
 const hierarchyNodes=[
  {id:0,parent:-1,children:[1,2],firstLeaf:0,leafCount:8},
  {id:1,parent:0,children:[3,4],firstLeaf:0,leafCount:4},
  {id:2,parent:0,children:[5,6],firstLeaf:4,leafCount:4},
  {id:3,parent:1,children:[],firstLeaf:0,leafCount:2},
  {id:4,parent:1,children:[],firstLeaf:2,leafCount:2},
  {id:5,parent:2,children:[],firstLeaf:4,leafCount:2},
  {id:6,parent:2,children:[],firstLeaf:6,leafCount:2},
 ];
 const raw=new Map(),encoded=new Map(),requests=[],failOnce=new Set(),base='https://forest.invalid/pilot/';
 const tier=(maxLeaves,nodeIDs)=>{
  const clusters=nodeIDs.map((nodeID,id)=>{
   const node=hierarchyNodes[nodeID];return{id,sourceNodeID:nodeID,firstLeaf:node.firstLeaf,leafCount:node.leafCount,centre:[node.firstLeaf+node.leafCount*.5,2,0],extent:node.leafCount,
    views:frames.map((frame,index)=>{const slot=id*6+index;return{index,...structuredClone(frame),page:Math.floor(slot/16),tile:[slot%4,Math.floor(slot%16/4)]};})};
  });
  const pages=Array.from({length:Math.ceil(clusters.length*6/16)},(_,index)=>({index,grid:[4,4],mips:[4,2,1].map((tilePixels,level)=>{
   const gutter=1,pitchPixels=tilePixels+2,atlasPixels=[4*pitchPixels,4*pitchPixels],outputs={};
   for(const [channel,name]of pilotTestChannels.entries()){
    const file=`prototype-0/tier-${maxLeaves}/page-${index}-mip-${level}-${name}.rgba8.bin`,data=new Uint8Array(atlasPixels[0]*atlasPixels[1]*4),pixel=channel===0?[17+maxLeaves+index+level,60,30,255]:channel===1?[128,128,255,128]:[128,224,64,255];
    for(let at=0;at<data.length;at+=4)data.set(pixel,at);
    const zipped=gzipSync(data);raw.set(file,data);encoded.set(file+'.gz',zipped);outputs[name]={file,...pilotTestReceipt(data),gzip:{file:file+'.gz',...pilotTestReceipt(zipped)}};
   }
   return{level,tilePixels,gutter,pitchPixels,atlasPixels,format:'rgba8unorm',bytesPerTexel:4,outputs};
  })}));
  return{maxLeaves,clusters,pages};
 };
 // Deliberately supply fine before coarse; assembly must not mutate this order.
 const manifest={format:'waterworld.forest-leaf-cluster-pilot',version:1,experimental:true,complete:true,qualified:false,units:'metres',upAxis:'Y',
  prototypes:[{id:0,species:'oak',leafCount:8,hierarchyNodes,tiers:[tier(2,[3,4,5,6]),tier(4,[1,2])]}]};
 const f={manifest,raw,encoded,requests,failOnce,base};
 f.fetchAsset=async url=>{
  const value=String(url);requests.push(value);if(value===base+'manifest.json')return new Response(JSON.stringify(manifest),{headers:{'Content-Type':'application/json'}});
  if(!value.startsWith(base))throw Error('Unexpected external fetch: '+value);const file=value.slice(base.length);
  if(failOnce.delete(file))return new Response(null,{status:503});
  const bytes=encoded.get(file);return bytes?new Response(Uint8Array.from(bytes)):new Response(null,{status:404});
 };
 f.load=(options={})=>loadForestClusterPilot(base,{fetchAsset:f.fetchAsset,allowExperimental:true,...options});return f;
}
function pilotTestPage(pack,maxLeaves=2,index=0){
 const prototype=pack.manifest.prototypes[0],tier=prototype.tiers.find(t=>t.maxLeaves===maxLeaves),page=tier.pages[index];return{prototype,tier,page};
}

function pilotTestAssertPacked(mips,layout){
 assert.ok(layout.width>0&&layout.height>0);assert.equal(layout.rects.length,mips.length);
 let area=0;
 for(const [i,a]of layout.rects.entries()){
  assert.deepEqual(a.slice(2),mips[i].atlasPixels);assert.ok(a[0]>=0&&a[1]>=0&&a[0]+a[2]<=layout.width&&a[1]+a[3]<=layout.height);area+=a[2]*a[3];
  for(let j=0;j<i;j++){
   const b=layout.rects[j],overlapX=Math.max(0,Math.min(a[0]+a[2],b[0]+b[2])-Math.max(a[0],b[0])),overlapY=Math.max(0,Math.min(a[1]+a[3],b[1]+b[3])-Math.max(a[1],b[1]));
   assert.equal(overlapX*overlapY,0,'independent source mip rectangles must never overlap');
  }
 }
 assert.ok(area<=layout.width*layout.height);
}

test('pilot schema accepts complete source frontiers and does not rewrite metadata or qualification',()=>{
 const f=pilotTestFixture(),before=structuredClone(f.manifest);assert.equal(validateForestClusterPilot(f.manifest),f.manifest);assert.deepEqual(f.manifest,before);
 for(const tier of f.manifest.prototypes[0].tiers){
  const owners=tier.clusters.flatMap(c=>Array.from({length:c.leafCount},(_,i)=>c.firstLeaf+i));assert.deepEqual(owners.sort((a,b)=>a-b),[0,1,2,3,4,5,6,7]);
 }
 assert.equal(f.manifest.qualified,false);
});

test('truncated, overlapping and hierarchy-mismatched source ownership fail before pages load',()=>{
 const edits=[
  m=>m.prototypes[0].tiers.find(t=>t.maxLeaves===4).clusters.pop(),
  m=>m.prototypes[0].leafCount++,
  m=>m.prototypes[0].tiers[0].clusters[1].firstLeaf=0,
  m=>m.prototypes[0].tiers[0].clusters[0].sourceNodeID=999,
  m=>m.prototypes[0].hierarchyNodes[3].firstLeaf=1,
  m=>m.prototypes[0].hierarchyNodes[3].leafCount=3,
  m=>m.prototypes[0].hierarchyNodes.push(structuredClone(m.prototypes[0].hierarchyNodes[3])),
 ];
 for(const edit of edits){const f=pilotTestFixture();edit(f.manifest);assert.throws(()=>validateForestClusterPilot(f.manifest),/source|ownership|hierarchy|frontier|Duplicate/);assert.equal(f.requests.length,0);}
});

test('page tiles, independent mip geometry, formats and exact raw byte counts are enforced',()=>{
 const edits=[
  m=>m.prototypes[0].tiers[0].clusters[0].views[0].tile[0]=4,
  m=>m.prototypes[0].tiers[0].clusters[0].views[0].tile[1]=4,
  m=>m.prototypes[0].tiers[0].clusters[0].views[0].tile[0]=-1,
  m=>m.prototypes[0].tiers[0].clusters[0].views[0].page=100,
  m=>m.prototypes[0].tiers[0].pages[0].grid[0]=0,
  m=>m.prototypes[0].tiers[0].pages[0].grid[0]=8,
  m=>m.prototypes[0].tiers[0].pages[0].mips[0].atlasPixels[0]++,
  m=>m.prototypes[0].tiers[0].pages[0].mips[0].pitchPixels++,
  m=>m.prototypes[0].tiers[0].pages[0].mips[0].tilePixels=0,
  m=>m.prototypes[0].tiers[0].pages[0].mips[1].level=2,
  m=>m.prototypes[0].tiers[0].pages[0].mips[0].format='rgba8unorm-srgb',
  m=>m.prototypes[0].tiers[0].pages[0].mips[0].bytesPerTexel=8,
  m=>m.prototypes[0].tiers[0].pages[0].mips[0].outputs.normalDepth.bytes--,
  m=>delete m.prototypes[0].tiers[0].pages[0].mips[0].outputs.lighting,
  m=>m.prototypes[0].tiers[0].pages[0].mips[0].outputs.albedo.gzip.file='../native/vertices.bin.gz',
 ];
 for(const edit of edits){const f=pilotTestFixture();edit(f.manifest);assert.throws(()=>validateForestClusterPilot(f.manifest));}
});

test('independent guttered mip packing shares space without overlap or changing tile grids',()=>{
 const f=pilotTestFixture(),page=f.manifest.prototypes[0].tiers[0].pages[0],before=structuredClone(page.mips),layout=packForestClusterMips(page.mips);pilotTestAssertPacked(page.mips,layout);assert.deepEqual(page.mips,before);
 const sizes=[64,32,16,8,4],mips=sizes.map(n=>({atlasPixels:[n,n]})),small=packForestClusterMips(mips);pilotTestAssertPacked(mips,small);assert.ok(small.height<sizes.reduce((a,b)=>a+b,0),'smaller source levels share a packed row');
 assert.throws(()=>packForestClusterMips([]),/Missing/);assert.throws(()=>packForestClusterMips([{atlasPixels:[16,16]},{atlasPixels:[32,8]}]),/Incompatible/);
 assert.throws(()=>packForestClusterMips([{atlasPixels:[16,0]}]),/Incompatible/);
});

test('runtime node links form an exact parent/child cover without mutating tier order',()=>{
 const f=pilotTestFixture(),p=f.manifest.prototypes[0],before=structuredClone(p),{nodes,tiers}=forestClusterNodes(p);
 assert.deepEqual(tiers.map(t=>t.maxLeaves),[4,2]);assert.deepEqual(nodes.map(n=>n.parent),[-1,-1,0,0,1,1]);assert.deepEqual(nodes.map(n=>n.childCount),[2,2,0,0,0,0]);
 for(const [id,parent]of nodes.entries())if(parent.childCount){
  const children=nodes.filter(n=>n.parent===id),leaves=children.flatMap(c=>Array.from({length:c.leafCount},(_,i)=>c.firstLeaf+i));
  assert.deepEqual(leaves,Array.from({length:parent.leafCount},(_,i)=>parent.firstLeaf+i));assert.equal(new Set(leaves).size,parent.leafCount);
 }
 assert.deepEqual(p,before);
 const corrupt=[
  p=>{p.tiers[0].clusters[1].firstLeaf=0;},
  p=>{p.tiers[0].clusters.pop();},
  p=>{p.tiers[1].clusters.pop();},
  p=>{p.tiers[0].clusters[1].firstLeaf=3;},
 ];
 for(const edit of corrupt){const other=pilotTestFixture().manifest.prototypes[0];edit(other);assert.throws(()=>forestClusterNodes(other),/hierarchy|cover|overlap|holes/i);}
});

test('unqualified pilot loading requires explicit review and never silently requests reference geometry',async()=>{
 for(const allowExperimental of [undefined,false,1,'true']){
  const f=pilotTestFixture();await assert.rejects(loadForestClusterPilot(f.base,{fetchAsset:f.fetchAsset,allowExperimental}),/explicit review/);assert.equal(f.requests.length,0);
 }
 const f=pilotTestFixture(),pack=await f.load();assert.equal(pack.manifest.qualified,false);assert.deepEqual(f.requests,[f.base+'manifest.json']);
 const {prototype,tier,page}=pilotTestPage(pack),loaded=await pack.loadPage(prototype,tier,page);assert.equal(loaded.mips.length,page.mips.length);
 for(const [level,mip]of loaded.mips.entries())for(const channel of pilotTestChannels)assert.deepEqual(mip.data[channel],f.raw.get(page.mips[level].outputs[channel].file));
 assert.ok(f.requests.every(url=>url===f.base+'manifest.json'||f.encoded.has(url.slice(f.base.length))));assert.ok(f.requests.every(url=>!/vertices\.bin|indices\.bin|roots\.bin/.test(url)));
});

test('page promises deduplicate within a tier, remain distinct across tiers, and release explicitly',async()=>{
 const f=pilotTestFixture(),pack=await f.load(),fine=pilotTestPage(pack,2),coarse=pilotTestPage(pack,4),one=pack.loadPage(fine.prototype,fine.tier,fine.page),same=pack.loadPage(fine.prototype,fine.tier,fine.page);
 assert.equal(one,same);const loaded=await one,afterFine=f.requests.length;assert.equal(pack.loadPage(fine.prototype,fine.tier,fine.page),one);assert.equal(f.requests.length,afterFine);
 const other=await pack.loadPage(coarse.prototype,coarse.tier,coarse.page);assert.notEqual(other,loaded);assert.notEqual(other.mips[0].data.albedo[0],loaded.mips[0].data.albedo[0]);
 pack.releasePage(fine.prototype,fine.tier,fine.page);const reloaded=pack.loadPage(fine.prototype,fine.tier,fine.page);assert.notEqual(reloaded,one);assert.deepEqual(await reloaded,loaded);
});

test('failed page requests and encoded digest errors can retry without a stuck rejected cache entry',async()=>{
 for(const failure of ['unavailable','encoded']){
  const f=pilotTestFixture(),pack=await f.load(),{prototype,tier,page}=pilotTestPage(pack),file=page.mips[0].outputs.albedo.gzip.file,original=f.encoded.get(file);
  if(failure==='unavailable')f.failOnce.add(file);else{const corrupt=Buffer.from(original);corrupt[8]^=1;f.encoded.set(file,corrupt);}
  const rejected=pack.loadPage(prototype,tier,page);await assert.rejects(rejected,/unavailable|encoded digest/);f.encoded.set(file,original);
  const retried=pack.loadPage(prototype,tier,page);assert.notEqual(retried,rejected);assert.equal((await retried).mips.length,page.mips.length);assert.equal(f.requests.filter(url=>url===f.base+file).length,2);
 }
});

test('decoded hashes and bounded expansion are independently verified after authenticated gzip bytes',async()=>{
 for(const failure of ['decoded','oversized','short']){
  const f=pilotTestFixture(),item=f.manifest.prototypes[0].tiers[0].pages[0].mips[0].outputs.albedo;
  if(failure==='decoded')item.sha256='0'.repeat(64);
  else{const raw=new Uint8Array(item.bytes+(failure==='oversized'?1:-1)),zipped=gzipSync(raw);f.encoded.set(item.gzip.file,zipped);item.gzip={file:item.gzip.file,...pilotTestReceipt(zipped)};}
  const pack=await f.load(),{prototype,tier,page}=pilotTestPage(pack);await assert.rejects(pack.loadPage(prototype,tier,page),/decoded digest|expands beyond/);
 }
 const f=pilotTestFixture(),pack=await f.load({maxDecodedBytes:1000}),{prototype,tier,page}=pilotTestPage(pack);await assert.rejects(pack.loadPage(prototype,tier,page),/residency budget/);assert.deepEqual(f.requests,[f.base+'manifest.json']);
});

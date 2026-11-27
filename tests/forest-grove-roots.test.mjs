// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// A grove's trees are roots of the forest pack: planted where its wood is marked, kept off towns, ways and water,
// planted again only when their section changes, and struck, felled and saved as any other tree.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import {FOREST_GROVE_VARIANTS,FOREST_GROVE_TREE_FLOATS,PORTUGAL_FOREST_GROVE_ASSETS,NORTHERN_FOREST_GROVE_ASSETS,SUBTROPICAL_FOREST_GROVE_ASSETS,
  validateForestGroves,loadForestGroves,forestGroveCover,forestGroveOccupy,forestGroveTrees,forestGroveStamp} from '../js/forest-groves.js';
import {generateProceduralCoastalPack,portClearanceEnvelope,PLANT_STREET_GAP_M,terrainSurfaceSample} from '../js/coastal-world.js';
import {CITY_BLOCK_FLOATS} from '../js/old-world-city.js';
import {streetEdgeAt} from '../js/town-streets.js';
import {retargetForestPackToProcedural} from '../js/terrain.js';
import {forestRootCapacity,forestPackRoots} from '../js/forest-scenery.js';
import {forestTrunkShape,buildForestTrunkGrid,sweepForestTrunks,strikeForestRoot,forestStrikesToSave,forestStrikesFromSave,reapplyForestStrikes,FOREST_LONG_FALLEN} from '../js/forest-trunks.js';

const PACKS={portugal:PORTUGAL_FOREST_GROVE_ASSETS,northern:NORTHERN_FOREST_GROVE_ASSETS,subtropical:SUBTROPICAL_FOREST_GROVE_ASSETS};
const serve=(change=bytes=>bytes)=>async path=>{
  const bytes=change(fs.readFileSync(path),path);
  return {ok:true,status:200,json:async()=>JSON.parse(bytes.toString()),body:new Blob([bytes]).stream()};
};

for(const [name,assets] of Object.entries(PACKS))test(`${name}'s grove is where its trees stand, and nothing else`,async()=>{
  const stand=await loadForestGroves({assets,fetchAsset:serve()}),m=stand.manifest;
  assert.deepEqual(Object.keys(m.files),['trees.bin']);
  assert.deepEqual(Object.keys(assets),['manifest.json','trees.bin.gz']);
  assert.equal(stand.trees.length,FOREST_GROVE_VARIANTS*m.maxTrees*FOREST_GROVE_TREE_FLOATS);
  const kinds=JSON.parse(fs.readFileSync(`assets/forest-scenery/${name}/manifest.json`,'utf8')).prototypes.length;
  for(let variant=0;variant<FOREST_GROVE_VARIANTS;variant++){
    const count=m.groves[variant].trees;
    // The first place is empty, every other of the grove's trees stands inside its square.
    assert.ok(stand.trees.subarray(variant*m.maxTrees*FOREST_GROVE_TREE_FLOATS,(variant*m.maxTrees+1)*FOREST_GROVE_TREE_FLOATS).every(v=>v===0));
    for(let id=1;id<=count;id++){
      const t=stand.trees.subarray((variant*m.maxTrees+id)*FOREST_GROVE_TREE_FLOATS,(variant*m.maxTrees+id+1)*FOREST_GROVE_TREE_FLOATS);
      assert.ok(t[0]>=0&&t[0]<=m.tileMetres&&t[1]>=0&&t[1]<=m.tileMetres&&t[3]>0&&Number.isInteger(t[4])&&t[4]<kinds&&t[5]>0&&t[6]>0,`grove ${variant} tree ${id}`);
    }
  }
});

test('groves load only what verifies',async()=>{
  const spoiled=serve((bytes,path)=>{if(!path.endsWith('trees.bin.gz'))return bytes;const raw=zlib.gunzipSync(bytes);raw[40]^=1;return zlib.gzipSync(raw);});
  await assert.rejects(loadForestGroves({assets:PORTUGAL_FOREST_GROVE_ASSETS,fetchAsset:spoiled}),/failed verification/);
  await assert.rejects(loadForestGroves({assets:PORTUGAL_FOREST_GROVE_ASSETS,fetchAsset:async()=>({ok:false,status:404})}),/unavailable \(404\)/);
  const manifest=JSON.parse(fs.readFileSync(PORTUGAL_FOREST_GROVE_ASSETS['manifest.json'],'utf8'));
  assert.throws(()=>validateForestGroves({...manifest,version:1}),/Invalid forest grove manifest/);
  assert.throws(()=>validateForestGroves({...manifest,maxTrees:1}),/hold no trees/);
  assert.throws(()=>validateForestGroves({...manifest,files:{'trees.bin':{...manifest.files['trees.bin'],bytes:8}}}),/do not match/);
});

// A square of coast 2048 m across: sea to the west, a beach, then land rising east, all of it marked as forest but a steep scarp.
function coast(){
  const region={x:1000,z:-3000,span:2048,size:129,biomeSize:128},heights=new Float32Array(129*129),biome=new Uint8Array(128*128).fill(255);
  for(let j=0;j<129;j++)for(let i=0;i<129;i++){
    const x=i*16;
    heights[j*129+i]=x<512?-4:x<1536?.5+(x-512)*.04:x<1600?41.5+(x-1536)*2:169.5+(x-1600)*.02;
  }
  return {region,heights,biome};
}
const at=(cover,size,i,j,byte=0)=>cover[(j*size+i)*2+byte];

test('a wood is marked wherever trees are planted, and comes down to its edge over a few squares',()=>{
  const {region,heights,biome}=coast(),size=256,cover=forestGroveCover({region,heights,biome,size});
  assert.equal(cover.length,size*size*2);
  const row=128,step=region.span/size;
  // No wood on the sea or on ground the tide reaches; all of it well inland; none on the scarp.
  assert.equal(at(cover,size,20,row),0);
  assert.equal(at(cover,size,Math.floor(900/step),row),255);
  assert.ok(at(cover,size,Math.floor(1568/step),row)<20);
  assert.equal(at(cover,size,Math.floor(1900/step),row),255);
  // From the shore inward the marking only rises, and takes more than one square to do it.
  const shore=Math.floor(512/step);let rising=0;
  for(let i=shore-6;i<shore+12;i++){assert.ok(at(cover,size,i+1,row)>=at(cover,size,i,row));if(at(cover,size,i,row)>0&&at(cover,size,i,row)<255)rising++;}
  assert.ok(rising>=3,`the wood's edge is ${rising} squares broad`);
  // Thinly marked ground is a wood's margin, and unmarked ground is none.
  const thin=forestGroveCover({region,heights,biome:biome.map(()=>75),size}),bare=forestGroveCover({region,heights,biome:biome.map(()=>41),size});
  const inland=Math.floor(900/step);
  assert.ok(at(thin,size,inland,row)>90&&at(thin,size,inland,row)<170);assert.equal(at(bare,size,inland,row),0);
  // A mangrove pack roots lower on the shore than the others.
  const low=heights.map(h=>h>0?Math.min(h,.5):h);
  assert.equal(at(forestGroveCover({region,heights:low,biome,size}),size,inland,row),0);
  assert.equal(at(forestGroveCover({region,heights:low,biome,size,mangrove:true}),size,inland,row),255);
  // A section whose marking is missing is no wood at all.
  assert.ok(forestGroveCover({region,heights,biome:new Uint8Array(4),size}).every(v=>v===0));
});

test('a planted tree takes its ground from the grove, most at its trunk and none beyond its crown',()=>{
  const {region,heights,biome}=coast(),size=256,step=region.span/size,cover=forestGroveCover({region,heights,biome,size});
  const wood=cover.filter((_,k)=>k%2===0);
  const x0=region.x-region.span/2,z0=region.z-region.span/2,root=[x0+900,10,z0+1000];
  const roots=new Float32Array(24);roots.set([...root,2.5,0,1,1,1,3,.2,-1.25,0],0);
  // The second record is an empty place in the roots: it takes nothing.
  roots.set([x0+1300,10,z0+1000,0,0,1,1,1,3,.2,-1.25,0],12);
  forestGroveOccupy(cover,size,region,roots,(kind,scale)=>{assert.equal(kind,3);return 6*scale;});
  const taken=(x,z)=>at(cover,size,Math.floor((x-x0)/step),Math.floor((z-z0)/step),1);
  assert.equal(taken(root[0],root[2]),255);
  const crown=taken(root[0]+15,root[2]);
  assert.ok(crown>30&&crown<200,`at its crown's edge the tree has ${crown} of 255`);
  assert.equal(taken(root[0]+40,root[2]),0);assert.equal(taken(x0+1300,z0+1000),0);
  for(let d=0;d<40;d+=step)assert.ok(taken(root[0]+d+step,root[2])<=taken(root[0]+d,root[2]));
  // What is wood is left as it was, and a tree that is gone gives its ground back.
  assert.deepEqual(cover.filter((_,k)=>k%2===0),wood);
  forestGroveOccupy(cover,size,region,new Float32Array(0),()=>6);
  assert.ok(cover.every((v,k)=>k%2===0||v===0));
});

test('a grove plants its trees where the wood stands, the same trees every time, and none where planted trees stand',async()=>{
  const stand=await loadForestGroves({assets:PORTUGAL_FOREST_GROVE_ASSETS,fetchAsset:serve()});
  const {region,heights,biome}=coast(),size=256,cover=forestGroveCover({region,heights,biome,size});
  const harbour={x:region.x-region.span/2+256,z:region.z};
  const plant=c=>{const out=[];forestGroveTrees({stand,cover:c,size,region,harbour,visit:(x,z,kind,scale,yaw,seed)=>out.push({x,z,kind,scale,yaw,seed})});return out;};
  const trees=plant(cover),x0=region.x-region.span/2;
  assert.ok(trees.length>500,`${trees.length} trees in a wood of two kilometres`);
  assert.deepEqual(plant(cover),trees);
  for(const t of trees){
    assert.ok(t.x-x0>512,'none on the sea');
    assert.ok(t.scale>0&&Number.isFinite(t.yaw)&&t.yaw>=0&&t.yaw<Math.PI*2);
  }
  // Inland trees stand at their full size, and those near the harbour smaller.
  const nearest=trees.reduce((a,b)=>Math.hypot(a.x-harbour.x,a.z-harbour.z)<Math.hypot(b.x-harbour.x,b.z-harbour.z)?a:b);
  const farthest=trees.reduce((a,b)=>Math.hypot(a.x-harbour.x,a.z-harbour.z)>Math.hypot(b.x-harbour.x,b.z-harbour.z)?a:b);
  assert.ok(nearest.scale<farthest.scale*1.02);
  // Ground that planted trees have is no grove's.
  for(let k=1;k<cover.length;k+=2)cover[k]=255;
  assert.equal(plant(cover).length,0);
});

// Cartagena in 1605: a walled colonial city on a wooded coast.
const cartagena=()=>generateProceduralCoastalPack({id:'cartagena',year:1605,size:129,biomeSize:64,albedoSize:64,vegetationCandidates:4000});
const subtropical=()=>({manifest:JSON.parse(fs.readFileSync('assets/forest-scenery/subtropical/manifest.json','utf8'))});
const rootKey=(roots,k)=>`${roots[k]},${roots[k+2]},${roots[k+8]}`;

test('a grove\'s trees are roots of the forest, clear of town, ways and water, planted again only when their section changes',async()=>{
  const stand=await loadForestGroves({assets:SUBTROPICAL_FOREST_GROVE_ASSETS,fetchAsset:serve()});
  const pack=cartagena(),forest=subtropical();
  const planted=retargetForestPackToProcedural(forest,pack);
  const withGrove=retargetForestPackToProcedural(forest,pack,undefined,{stand});
  assert.equal(planted.groveRoots??0,0);
  assert.ok(withGrove.groveRoots>1000,`${withGrove.groveRoots} grove roots`);
  assert.equal(withGrove.sectionsReleased,0);
  assert.equal(withGrove.roots,null,'a planted pack is held section by section, never joined');
  const plantedRoots=forestPackRoots(planted),groveRoots=forestPackRoots(withGrove);
  assert.equal(withGrove.manifest.rootCount,groveRoots.length/12);
  assert.equal(withGrove.manifest.rootCount-planted.manifest.rootCount,withGrove.groveRoots);
  // Every planted tree is still planted, and the grove adds only its own.
  const plantedKeys=new Set();for(let k=0;k<plantedRoots.length;k+=12)plantedKeys.add(rootKey(plantedRoots,k));
  const grove=[];
  for(let k=0;k<groveRoots.length;k+=12){const key=rootKey(groveRoots,k);if(!plantedKeys.delete(key))grove.push(k);}
  assert.equal(plantedKeys.size,0);
  assert.equal(grove.length,withGrove.groveRoots);
  // Each grove root is a planted tree's record: a kind of the pack, a scale, its ground, and a root's identity.
  const blocks=pack.city?.blocks??new Float32Array(0);
  const inBlock=(x,z)=>{for(let b=0;b<blocks.length;b+=CITY_BLOCK_FLOATS){const dx=x-blocks[b],dz=z-blocks[b+2],c=Math.cos(blocks[b+3]),s=Math.sin(blocks[b+3]);if(Math.abs(dx*c-dz*s)<=blocks[b+4]*.5&&Math.abs(dx*s+dz*c)<=blocks[b+5]*.5)return true;}return false;};
  const roots=groveRoots;
  for(const k of grove){
    const x=roots[k],y=roots[k+1],z=roots[k+2],scale=roots[k+3],kind=roots[k+8],sink=roots[k+9];
    assert.ok(Number.isInteger(kind)&&kind<forest.manifest.prototypes.length&&scale>0);
    assert.ok(roots[k+10]<0&&roots[k+11]===0,'a standing root');
    const gy=terrainSurfaceSample(pack.heights,x,z,pack.region);
    assert.ok(gy>=0.35&&Math.abs(y-(gy-sink))<1e-3,`grove root at (${x.toFixed(1)}, ${z.toFixed(1)}) stands on its ground`);
    assert.ok(portClearanceEnvelope(pack.port,x,z,8),'clear of the port');
    assert.ok(streetEdgeAt(pack.port.streets,x,z)>=PLANT_STREET_GAP_M-1e-3,'clear of the ways');
    assert.equal(inBlock(x,z),false,'clear of the city');
  }
  // Planted again only when the section changes: the same section gives back the same roots, and a section
  // whose ground is different is stamped differently.
  const cached=pack._cachedForestGrove;
  assert.ok(Array.isArray(cached?.roots)&&cached.roots.length>0&&cached.roots.every(part=>part instanceof Float32Array),'a grove is held as arrays of records');
  const again=retargetForestPackToProcedural(forest,pack,undefined,{stand});
  assert.equal(pack._cachedForestGrove,cached);
  assert.ok(cached.roots.every(part=>again.sections[0].parts.includes(part)),'the same arrays, not copies');
  assert.deepEqual(forestPackRoots(again),groveRoots);
  const raised=Float32Array.from(pack.heights,h=>h+1);
  assert.notEqual(forestGroveStamp({...pack,heights:raised},new Float32Array(0)),forestGroveStamp(pack,new Float32Array(0)));
  // A fresh coast plants the same grove: what is saved by place finds its tree again.
  const fresh=retargetForestPackToProcedural(forest,cartagena(),undefined,{stand});
  assert.deepEqual(forestPackRoots(fresh),groveRoots);
  // Another terrain given the same section plants its own: its forest strikes what it holds where it lies.
  const other=retargetForestPackToProcedural(forest,pack,undefined,{stand,owner:{}});
  assert.notEqual(pack._cachedForestGrove,cached);
  assert.deepEqual(forestPackRoots(other),groveRoots);
});

test('a device holds the sections nearest the player, each whole, and lets the farthest go',async()=>{
  const stand=await loadForestGroves({assets:SUBTROPICAL_FOREST_GROVE_ASSETS,fetchAsset:serve()});
  const pack=cartagena(),forest=subtropical(),square=coast();
  const far={...square,region:{...square.region,x:pack.region.x+30000,z:pack.region.z}};
  const sizes=held=>Object.fromEntries(held.sections.map(section=>[section.key,section.parts.reduce((sum,part)=>sum+part.length/12,0)]));
  const all=retargetForestPackToProcedural(forest,pack,undefined,{stand,extraSections:[far]});
  const farKey=`${far.region.x},${far.region.z}`,whole=sizes(all);
  assert.deepEqual(Object.keys(whole),['coast',farKey]);
  assert.equal(all.sectionsReleased,0);
  assert.ok(whole.coast>1000&&whole[farKey]>100,`${whole.coast} and ${whole[farKey]} roots`);
  // One root short of both: the section nearer the player is held whole, and the other let go whole.
  const tight=whole.coast+whole[farKey]-1;
  const byFar=retargetForestPackToProcedural(forest,pack,undefined,{stand,extraSections:[far],rootCapacity:tight,near:far.region});
  assert.deepEqual(sizes(byFar),{[farKey]:whole[farKey]});
  assert.equal(byFar.sectionsReleased,1);
  assert.equal(byFar.manifest.rootCount,whole[farKey]);
  const byCoast=retargetForestPackToProcedural(forest,pack,undefined,{stand,extraSections:[far],rootCapacity:tight,near:pack.region});
  assert.deepEqual(sizes(byCoast),{coast:whole.coast});
  assert.equal(byCoast.sectionsReleased,1);
  // A section let go keeps only the size of its grove; it is planted again when it is held again.
  assert.equal(far._cachedForestGrove.roots,null);
  assert.equal(far._cachedForestGrove.count,whole[farKey]-(far._cachedForestPlanted?.roots.length??0)/12);
  const back=retargetForestPackToProcedural(forest,pack,undefined,{stand,extraSections:[far]});
  assert.deepEqual(sizes(back),whole);
  assert.deepEqual(forestPackRoots(back),forestPackRoots(all));
});

test('a grove\'s tree is struck, felled and remembered as any tree',async()=>{
  const stand=await loadForestGroves({assets:SUBTROPICAL_FOREST_GROVE_ASSETS,fetchAsset:serve()});
  const forest=subtropical(),pack=retargetForestPackToProcedural(forest,cartagena(),undefined,{stand});
  const planted=new Set(),bare=retargetForestPackToProcedural(forest,cartagena());
  const plantedRoots=forestPackRoots(bare);for(let k=0;k<plantedRoots.length;k+=12)planted.add(rootKey(plantedRoots,k));
  const roots=forestPackRoots(pack),count=roots.length/12;
  let index=-1;for(let i=0;i<count;i++)if(!planted.has(rootKey(roots,i*12))&&roots[i*12+3]>.8){index=i;break;}
  assert.ok(index>=0,'a grove tree to shoot at');
  const shapes=forest.manifest.prototypes.map(p=>forestTrunkShape(p.species));
  const grid=buildForestTrunkGrid(roots,count,shapes);
  const x=roots[index*12],y=roots[index*12+1]+roots[index*12+9]+1.2,z=roots[index*12+2];
  const hit=sweepForestTrunks(grid,[x+0.8,y,z],[x,y,z],0.08);
  assert.ok(hit,'the ball finds the grove tree\'s wood');
  assert.equal(hit.forestTree.roots,roots);assert.equal(hit.forestTree.rootIndex,index);
  // Three blasts fell it, and the fall is kept by its place.
  const strikes=new Map();
  for(let k=0;k<3;k++)assert.equal(strikeForestRoot(roots,count,x,z,strikes,{shapeOf:id=>shapes[id]}),index);
  assert.ok(roots[index*12+11]<0,'felled');
  const saved=forestStrikesToSave(strikes,{x:0,z:0});
  const again=forestPackRoots(retargetForestPackToProcedural(forest,cartagena(),undefined,{stand}));
  reapplyForestStrikes(again,count,forestStrikesFromSave(saved,{x:0,z:0}));
  assert.equal(again[index*12+11],FOREST_LONG_FALLEN,'the coast comes back with the grove tree down');
});

test('the roots are as many as the device holds, and only its limits bound them',()=>{
  assert.equal(forestRootCapacity({limits:{maxStorageBufferBindingSize:256*1024*1024,maxBufferSize:512*1024*1024,maxComputeWorkgroupsPerDimension:1<<20}}),Math.floor(256*1024*1024/48));
  assert.equal(forestRootCapacity({limits:{maxStorageBufferBindingSize:1<<30,maxBufferSize:128*1024*1024,maxComputeWorkgroupsPerDimension:1<<20}}),Math.floor(128*1024*1024/48));
  // The passes over the roots spread their workgroups over a second dimension, so a dispatch bounds nothing.
  assert.equal(forestRootCapacity({limits:{maxStorageBufferBindingSize:256*1024*1024,maxBufferSize:512*1024*1024,maxComputeWorkgroupsPerDimension:65535}}),Math.floor(256*1024*1024/48));
  const scenery=fs.readFileSync('js/forest-scenery.js','utf8'),terrain=fs.readFileSync('js/terrain.js','utf8');
  // A coast with more trees takes larger buffers, packed anew on the GPU; each tree claims its wind anew, and the stand,
  // blocks and wind are bound to the new roots when the scene is made again.
  assert.match(scenery,/encoder\.copyBufferToBuffer\(roots,slab\.start\*48,next,at\*48,slab\.count\*48\)/);
  assert.match(scenery,/encoder\.clearBuffer\(windOwners\);[\s\S]*?if\(atlas\)makeScene\(\);/);
  assert.match(scenery,/standGroup=standBindGroup\(\);blockGroup=blockBindGroup\(\);windGroup=windBindGroup\(\);/);
  assert.match(scenery,/\[frameUBO,shadowUniform,roots,atlas\.buffer/);
  // The grove is planted on every section of the stream, and nothing draws it but the forest.
  assert.ok(!/FOREST_GROVE_WGSL|createForestGroves|groves\?\.encode|groves\?\.draw/.test(terrain));
  assert.match(terrain,/stand:grovePack,rootCapacity/);
});

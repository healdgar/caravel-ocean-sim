// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import {FOREST_GROVE_TEXELS,FOREST_GROVE_LEVELS,FOREST_GROVE_VARIANTS,FOREST_GROVE_MAPS,FOREST_GROVE_TREE_FLOATS,PORTUGAL_FOREST_GROVE_ASSETS,SUBTROPICAL_FOREST_GROVE_ASSETS,
  validateForestGroves,loadForestGroves,forestGroveCover,forestGroveOccupy,forestGroveStands,forestGroveTiles,FOREST_GROVE_WGSL,FOREST_GROVE_CULL_WGSL} from '../js/forest-groves.js';
import {FOREST_CULL_WGSL,FOREST_MIDDLE_ROOT_CULL_WGSL,FOREST_CANOPY_RANGE_WGSL,FOREST_CANOPY_CROWN_METRES,FOREST_CANOPY_CROWN_PIXELS,forestWithNativeLod,forestWithGroveCanopy} from '../js/forest-scenery.js';

const PACKS={portugal:PORTUGAL_FOREST_GROVE_ASSETS,subtropical:SUBTROPICAL_FOREST_GROVE_ASSETS};
const serve=(change=bytes=>bytes)=>async path=>{
  const bytes=change(fs.readFileSync(path),path);
  return {ok:true,status:200,json:async()=>JSON.parse(bytes.toString()),body:new Blob([bytes]).stream()};
};
const N=FOREST_GROVE_TEXELS;
let mapBytes=0;for(let level=0;level<FOREST_GROVE_LEVELS;level++)mapBytes+=(N>>level)**2*4;
// One level of one grove's canopy map: its heights in metres and the tree that owns each texel.
function canopy(pack,variant,level){
  const n=N>>level;let at=variant*FOREST_GROVE_MAPS*mapBytes;
  for(let l=0;l<level;l++)at+=(N>>l)**2*4;
  const height=new Float32Array(n*n),owner=new Uint16Array(n*n);
  for(let i=0;i<n*n;i++){const b=pack.maps.subarray(at+i*4,at+i*4+4);height[i]=((b[0]<<4)|(b[1]>>4))/4095*pack.manifest.heightMetres;owner[i]=((b[1]&15)<<8)|b[2];}
  return {n,height,owner};
}

for(const [name,assets] of Object.entries(PACKS))test(`${name}'s groves are closed, rounded canopy that meets any other grove at its edge`,async()=>{
  const pack=await loadForestGroves({assets,fetchAsset:serve()}),m=pack.manifest,cell=m.tileMetres/N;
  assert.equal(pack.maps.length,FOREST_GROVE_VARIANTS*FOREST_GROVE_MAPS*mapBytes);
  assert.equal(pack.trees.length,FOREST_GROVE_VARIANTS*m.maxTrees*FOREST_GROVE_TREE_FLOATS);
  const kinds=JSON.parse(fs.readFileSync(`assets/forest-scenery/${name}/manifest.json`,'utf8')).prototypes.length;
  const first=canopy(pack,0,0);
  for(let variant=0;variant<FOREST_GROVE_VARIANTS;variant++){
    const fine=canopy(pack,variant,0),count=m.groves[variant].trees;
    let low=Infinity,high=0,steepest=0;
    for(let z=0;z<N;z++)for(let x=0;x<N;x++){
      const i=z*N+x,h=fine.height[i];low=Math.min(low,h);high=Math.max(high,h);
      // The grove repeats, so its last texel stands beside its first.
      steepest=Math.max(steepest,Math.abs(h-fine.height[z*N+(x+1)%N]),Math.abs(h-fine.height[((z+1)%N)*N+x]));
      // Every part of the canopy belongs to a tree of this grove, whose kind the pack has.
      assert.ok(fine.owner[i]>=1&&fine.owner[i]<=count,`grove ${variant} texel ${i} is owned by tree ${fine.owner[i]} of ${count}`);
    }
    // Dense everywhere: no hole reaches the ground, and no texel stands above what the map can hold.
    assert.ok(low>8,`grove ${variant} has a hole ${low} m deep`);assert.ok(high<m.heightMetres);
    // Rounded: no crown stands as a cliff beside the next.
    assert.ok(steepest/cell<4,`grove ${variant} steps ${steepest} m in one texel of ${cell} m`);
    // A swell, not a tower: the tallest tree stands well under half as high again as the grove's roof.
    const mean=fine.height.reduce((sum,h)=>sum+h,0)/fine.height.length;
    assert.ok(high<mean*1.45,`grove ${variant} rises to ${high} m over a roof at ${mean} m`);
    // The first row and column are what a neighbour's far edge reads: every grove has the same.
    for(let k=0;k<N;k++){assert.equal(fine.height[k],first.height[k]);assert.equal(fine.height[k*N],first.height[k*N]);}
    for(let id=1;id<=count;id++){
      const tree=pack.trees.subarray((variant*m.maxTrees+id)*FOREST_GROVE_TREE_FLOATS,(variant*m.maxTrees+id+1)*FOREST_GROVE_TREE_FLOATS);
      assert.ok(tree[0]>=0&&tree[0]<=m.tileMetres&&tree[1]>=0&&tree[1]<=m.tileMetres&&tree[3]>0&&Number.isInteger(tree[4])&&tree[4]<kinds&&tree[5]>0&&tree[6]>0,`grove ${variant} tree ${id}`);
    }
    // Each coarser level is the same canopy, half as fine: its mean height is the finer level's.
    for(let level=1;level<FOREST_GROVE_LEVELS;level++){
      const coarse=canopy(pack,variant,level),average=coarse.height.reduce((sum,h)=>sum+h,0)/coarse.height.length;
      assert.ok(Math.abs(average-mean)<.1,`grove ${variant} level ${level} stands at ${average} m, not ${mean} m`);
      assert.ok(coarse.owner.every(o=>o>=1&&o<=count));
    }
  }
});

test('groves load only what verifies',async()=>{
  const spoiled=serve((bytes,path)=>{if(!path.endsWith('maps.bin.gz'))return bytes;const raw=zlib.gunzipSync(bytes);raw[40]^=1;return zlib.gzipSync(raw);});
  await assert.rejects(loadForestGroves({assets:PORTUGAL_FOREST_GROVE_ASSETS,fetchAsset:spoiled}),/failed verification/);
  await assert.rejects(loadForestGroves({assets:PORTUGAL_FOREST_GROVE_ASSETS,fetchAsset:async()=>({ok:false,status:404})}),/unavailable \(404\)/);
  const manifest=JSON.parse(fs.readFileSync(PORTUGAL_FOREST_GROVE_ASSETS['manifest.json'],'utf8'));
  assert.throws(()=>validateForestGroves({...manifest,levels:3}),/Invalid forest grove manifest/);
  assert.throws(()=>validateForestGroves({...manifest,maxTrees:5000}),/too many trees/);
  assert.throws(()=>validateForestGroves({...manifest,files:{...manifest.files,'maps.bin':{...manifest.files['maps.bin'],bytes:8}}}),/do not match/);
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

test('groves are listed for the ground a canopy stands on and nowhere else',()=>{
  const {region,heights,biome}=coast(),size=256,tile=128,cover=forestGroveCover({region,heights,biome,size});
  const tiles=forestGroveTiles({cover,size,region,heights,tileMetres:tile}),x0=region.x-region.span/2,z0=region.z-region.span/2;
  assert.equal(tiles.length%4,0);
  const columns=new Set();
  for(let k=0;k<tiles.length;k+=4){
    const column=Math.round((tiles[k]-x0)/tile);columns.add(column);
    assert.equal(tiles[k],x0+column*tile);assert.equal((tiles[k+1]-z0)%tile,0);
    // The ground under a grove, between which the GPU decides whether it is in view.
    const low=Math.min(...[0,1].map(e=>heights[Math.min(128,(column+e)*8)])),high=Math.max(...[0,1].map(e=>heights[Math.min(128,(column+e)*8)]));
    assert.ok(tiles[k+2]<=low+1e-3&&tiles[k+3]>=high-1e-3);
  }
  // None over the sea, all sixteen rows of every wooded column, and the scarp's column for the canopy that slopes down to it.
  assert.ok(!columns.has(0)&&!columns.has(2));
  for(const column of [5,8,11,13,15])assert.ok(columns.has(column),`column ${column}`);
  assert.equal(tiles.length/4,columns.size*16);
  // Where planted trees have all the ground the groves are listed all the same: far off the canopy closes over them.
  for(let k=1;k<cover.length;k+=2)cover[k]=255;
  assert.deepEqual(forestGroveTiles({cover,size,region,heights,tileMetres:tile}),tiles);
  // Unmarked ground has none.
  assert.equal(forestGroveTiles({cover:new Uint8Array(cover.length),size,region,heights,tileMetres:tile}).length,0);
});

test('far off, a tree standing in closed wood gives way to the canopy, which has closed over it',()=>{
  const {region,heights,biome}=coast(),size=256,cover=forestGroveCover({region,heights,biome,size});
  const x0=region.x-region.span/2,z0=region.z-region.span/2,record=(x,scale=2)=>[x0+x,10,z0+1000,scale,0,1,1,1,3,.2,-1.25,0];
  // Deep in the wood; at its very edge by the shore; on the sea; an empty place deep in the wood; and, the 34th, deep in again.
  const roots=new Float32Array(34*12);
  roots.set(record(900),0);roots.set(record(522),12);roots.set(record(200),24);roots.set(record(1000,0),36);roots.set(record(1900),33*12);
  const stands=forestGroveStands(cover,size,region,roots,new Uint32Array(2));
  assert.deepEqual([...stands],[1,2]);
  // Marks from another section of ground are kept, and trees outside this one are not judged by it.
  const far=new Float32Array(12);far.set([x0-500,10,z0+1000,2,0,1,1,1,3,.2,-1.25,0]);
  assert.deepEqual([...forestGroveStands(cover,size,region,far,new Uint32Array([1]))],[1]);
  // The forest's choice of trees drops a marked tree past the range at which a crown is a dozen pixels.
  for(const source of [FOREST_CULL_WGSL,forestWithNativeLod(FOREST_MIDDLE_ROOT_CULL_WGSL)]){
    const cull=forestWithGroveCanopy(source);
    assert.match(cull,/@group\(0\)@binding\(13\)var<storage,read>forestCanopyRoots:array<u32>;/);
    assert.match(cull,/if\(\(\(forestCanopyRoots\[id\.x>>5u\]>>\(id\.x&31u\)\)&1u\)==1u&&length\(relative\)>forestCanopyRange\(\)\)\{return;\}\n let clip=/);
    assert.ok(!source.includes('forestCanopyRoots'));
  }
  assert.equal(FOREST_CANOPY_CROWN_METRES/FOREST_CANOPY_CROWN_PIXELS,20/12);
  assert.ok(FOREST_CANOPY_RANGE_WGSL.includes('F.screen.y/max(2.0*length(F.camUp.xyz),.0001)*1.6667'));
  // The canopy parts for planted trees near the camera and not at all before that range, by the same measure.
  assert.ok(FOREST_GROVE_WGSL.includes(FOREST_CANOPY_RANGE_WGSL));
  assert.match(FOREST_GROVE_WGSL,/let parted=1\.-smoothstep\(0\.7,0\.94,distance\(vec3f\(at\.x,ground,at\.y\),F\.camPos\.xyz\)\/forestCanopyRange\(\)\);/);
  const scenery=fs.readFileSync('js/forest-scenery.js','utf8'),terrain=fs.readFileSync('js/terrain.js','utf8');
  assert.match(scenery,/cullSource=forestWithGroveCanopy\(cullSource\);/);assert.match(scenery,/\{binding:13,resource:\{buffer:canopyRoots\}\}/);
  assert.match(terrain,/forest\.leaveToCanopy\(groves\.sync\(/);
});

test('the canopy is one surface the GPU alone places, chooses and draws',()=>{
  // It lies on the ground at each of its own points, so it follows the land, and comes down where the cover says.
  assert.match(FOREST_GROVE_WGSL,/let ground=forestGroveGroundAt\(at\);/);assert.match(FOREST_GROVE_WGSL,/let standing=forestGroveStanding\(at,parted\);/);
  assert.match(FOREST_GROVE_WGSL,/var y=ground\+\(tall\+sunk\)\*standing-sunk;/);
  assert.match(FOREST_GROVE_WGSL,/smoothstep\(0\.45,0\.95,cover\.r\)\*\(1\.-parted\*smoothstep\(0\.,0\.9,cover\.g\)\)/);
  // No tree of it stands or falls alone: nothing in the vertex stage branches on a tree.
  const vertex=/@vertex fn forestGroveVS[\s\S]*?\n\}/.exec(FOREST_GROVE_WGSL)[0];
  assert.ok(!/if\(owner|stands=/.test(vertex));
  // It is lit as the far crowns are, and faces as the ground under it slopes.
  assert.match(vertex,/forestCrownLight\(o\.world,leaves,outward,colour,look\.a,canopy\.a,forestGrove\.optics,forestGrove\.underside\.rgb\)/);
  assert.match(vertex,/forestGroveGroundAt\(east\)-ground,forestGroveGroundAt\(south\)-ground/);
  // Where no wood stands it lies under the ground, and it is plain opaque, so what is hidden costs nothing.
  assert.match(FOREST_GROVE_WGSL,/@fragment fn forestGroveFS\(in:ForestVertex\)->@location\(0\)vec4f\{return forestCrownShade\(in\);\}/);
  assert.ok(!/discard|sample_mask/.test(FOREST_GROVE_WGSL));
  assert.match(FOREST_GROVE_WGSL,/let sunk=3\.0\+max\(square-16\.0,0\.\)\*0\.5;/);
  // The choice of groves and levels is a compute pass that counts into indirect draws.
  assert.match(FOREST_GROVE_CULL_WGSL,/@compute @workgroup_size\(1\)fn forestGroveReset\(\)/);
  assert.match(FOREST_GROVE_CULL_WGSL,/let slot=atomicAdd\(&forestGroveDraws\[level\*5u\+1u\],1u\);/);
  // Each frame JavaScript only binds and dispatches: it sends the GPU nothing.
  const source=fs.readFileSync('js/forest-groves.js','utf8');
  for(const name of ['encode','drawOpaque']){
    const body=new RegExp(`\\n      ${name}\\(pass\\) \\{[\\s\\S]*?\\n      \\},`).exec(source)?.[0];
    assert.ok(body,name);assert.ok(!/writeBuffer|writeTexture|new (Float32|Uint32|Uint8)Array|createBindGroup|createBuffer/.test(body),name);
  }
  const terrain=fs.readFileSync('js/terrain.js','utf8');
  assert.match(terrain,/groves\?\.encode\(pass\)/);assert.match(terrain,/groves\?\.drawOpaque\(pass\)/);
  assert.match(terrain,/forest\.updatePack\(nextForestPack,[^;]*\);\n\s*syncGroves\(nextForestPack\.roots\);/);
  // The published page carries both packs' groves.
  const build=fs.readFileSync('build.mjs','utf8');
  assert.match(build,/SUBTROPICAL_FOREST_GROVE_ASSETS/);assert.match(build,/PORTUGAL_FOREST_GROVE_ASSETS/);
});

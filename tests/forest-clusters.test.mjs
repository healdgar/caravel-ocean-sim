import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import zlib from 'node:zlib';
import {FOREST_CLUSTER_ASSETS,SUBTROPICAL_FOREST_CLUSTER_ASSETS,PORTUGAL_FOREST_CLUSTER_ASSETS,FOREST_CLUSTER_VERTEX_WORDS,FOREST_CLUSTER_WORDS,FOREST_LEAF_VERTICES,forestClusterIsDrawn,packForestClusterVertex} from '../js/forest-clusters.js';
import {reapplyForestStrikes,strikeForestRoot} from '../js/forest-trunks.js';

const MAX_TRIANGLES=128,STORAGE_BINDING_LIMIT=134217728;
function loadPack(pack){
  const dir=`assets/forest-scenery/${pack}/clusters`,manifest=JSON.parse(fs.readFileSync(`${dir}/manifest.json`,'utf8')),streams={};
  for(const [name,receipt] of Object.entries(manifest.files)){
    const bytes=zlib.gunzipSync(fs.readFileSync(`${dir}/${receipt.gzip.file}`));
    assert.equal(bytes.length,receipt.bytes,name);
    assert.equal(createHash('sha256').update(bytes).digest('hex'),receipt.sha256,name);
    assert.ok(bytes.length<STORAGE_BINDING_LIMIT,`${name} must fit one storage binding`);
    streams[name]=bytes;
  }
  const words=streams['clusters.bin'];
  return {manifest,floats:new Float32Array(words.buffer,words.byteOffset,words.length/4),uints:new Uint32Array(words.buffer,words.byteOffset,words.length/4)};
}
const cluster=({floats,uints},i)=>{const at=i*FOREST_CLUSTER_WORDS;return{err:floats[at+12],parentErr:floats[at+13],first:uints[at+14],triangles:uints[at+15]>>>1,leaf:(uints[at+15]&1)===1,radius:floats[at+11]};};

for(const pack of ['saba','subtropical','portugal'])test(`${pack} clusters are verified, bounded and ordered so the GPU can take a prefix`,()=>{
  const data=loadPack(pack);
  assert.equal(data.manifest.format,'waterworld.forest-clusters');
  const forest=JSON.parse(fs.readFileSync(`assets/forest-scenery/${pack}/manifest.json`,'utf8'));
  assert.deepEqual(data.manifest.prototypes.map(p=>p.species),forest.prototypes.map(p=>p.species),'every species is baked, in the order roots name them');
  for(const p of data.manifest.prototypes){
    let previous=Infinity,roots=0;
    for(let i=p.firstCluster;i<p.firstCluster+p.clusterCount;i++){
      const c=cluster(data,i);
      assert.ok(c.parentErr<=previous,`${p.species} cluster ${i} breaks the coarsest-first order`);previous=c.parentErr;
      assert.ok(c.triangles>0&&c.triangles<=MAX_TRIANGLES);
      assert.ok(c.err<=c.parentErr,'a parent is never finer than its child');
      if(c.leaf){assert.equal(c.triangles%4,0,'leaves stay whole');assert.ok((c.first+c.triangles/4*FOREST_LEAF_VERTICES)<=data.manifest.vertexCount);}
      else assert.ok(c.first+c.triangles*3<=data.manifest.indexCount);
      if(c.parentErr>1e29)roots++;
    }
    assert.ok(roots>0,`${p.species} needs a coarsest cut`);
    assert.ok(p.stats.leafClusters>0,`${p.species} has leaves`);
  }
});

test('Lisbon\'s trees keep every leaf at the finest cut, and a town-wide view needs a fraction of their triangles',()=>{
  // The pack stores a leaf as one quad where the others store two; the baker cuts each in half to match.
  const data=loadPack('portugal'),forest=JSON.parse(fs.readFileSync('assets/forest-scenery/portugal/manifest.json','utf8'));
  for(const p of data.manifest.prototypes){
    const source=forest.prototypes[p.id];let finestLeaves=0,finest=0,far=0;
    for(let i=p.firstCluster;i<p.firstCluster+p.clusterCount;i++){
      const c=cluster(data,i);
      if(c.err===0&&c.leaf)finestLeaves+=c.triangles;
      if(c.err===0)finest+=c.triangles;
      // Two hundred metres off on a 1117-pixel-high screen, at the leaf limit the game cuts to.
      if(forestClusterIsDrawn({error:c.err,parentError:c.parentErr,lodDistance:200,parentDistance:200},1117,.6))far+=c.triangles;
    }
    assert.equal(finestLeaves,source.leaf.indexCount/6*4,`${p.species} ${source.cohort} lost or gained leaves in the bake`);
    assert.ok(far>0&&far<finest*.6,`${p.species} ${source.cohort} draws ${far} of ${finest} triangles from 200 m`);
  }
});

test('a tree has one cut at each distance, and it gets coarser with distance',()=>{
  const data=loadPack('subtropical'),p=data.manifest.prototypes.find(q=>q.species==='palm');
  const counts=[8,30,120,500,2000].map(distance=>{
    let triangles=0;
    for(let i=p.firstCluster;i<p.firstCluster+p.clusterCount;i++){
      const c=cluster(data,i);
      if(forestClusterIsDrawn({error:c.err,parentError:c.parentErr,lodDistance:distance,parentDistance:distance},1000,.6))triangles+=c.triangles;
    }
    return triangles;
  });
  for(let i=1;i<counts.length;i++)assert.ok(counts[i]<=counts[i-1],`triangles rose with distance: ${counts}`);
  assert.ok(counts[0]>counts.at(-1)*20,`too little range between near and far: ${counts}`);
  assert.ok(counts.at(-1)>0,'a far tree must still draw something');
});

test('a cluster is drawn only between its own limit and its parent\'s',()=>{
  const at=d=>forestClusterIsDrawn({error:.01,parentError:.02,lodDistance:d,parentDistance:d},1000,1);
  assert.equal(at(5),false,'too close: its finer children draw instead');
  assert.equal(at(15),true);
  assert.equal(at(30),false,'too far: its coarser parent draws instead');
});

test('vertices pack into five words and keep their values within the 16-bit step',()=>{
  const quant={low:[-5,0,-5],posScale:20,uvLow:[0,0],uvScale:[2,6]};
  const words=packForestClusterVertex({position:[1.25,7.5,-3],normal:[0,1,0],uv:[1,3],colour:[.25,.81,1],material:3,shade:.5,canopy:1},quant);
  assert.equal(words.length,FOREST_CLUSTER_VERTEX_WORDS);
  assert.ok(Math.abs(-5+(words[0]&65535)/65535*20-1.25)<4e-4);
  assert.ok(Math.abs((words[0]>>>16)/65535*20-7.5)<4e-4);
  assert.ok(Math.abs(-5+(words[1]&65535)/65535*20+3)<4e-4);
  assert.equal((words[1]>>>16)&255,3,'material');
  assert.ok(Math.abs((words[3]&65535)/65535*2-1)<1e-4);
  assert.ok(Math.abs(((words[4]&255)/255)**2-.25)<.01,'colour survives its square-root storage');
  assert.equal(words[4]>>>24,255,'canopy');
});

test('palms are palms: a clear trunk, a crown of leaflets high up, no mat of surface roots',()=>{
  const dir='assets/forest-scenery/subtropical',manifest=JSON.parse(fs.readFileSync(`${dir}/manifest.json`,'utf8'));
  const raw=zlib.gunzipSync(fs.readFileSync(`${dir}/vertices.bin.gz`)),vertices=new Float32Array(raw.buffer,raw.byteOffset,raw.length/4);
  const rawIndices=zlib.gunzipSync(fs.readFileSync(`${dir}/indices.bin.gz`)),indices=new Uint32Array(rawIndices.buffer,rawIndices.byteOffset,rawIndices.length/4);
  for(const species of ['royal_palm','palm']){
    const p=manifest.prototypes.find(q=>q.species===species);
    const heights=[],spread=[];
    for(let k=0;k<p.leaf.indexCount;k++){const v=indices[p.leaf.firstIndex+k]*14;heights.push(vertices[v+1]);spread.push(Math.hypot(vertices[v],vertices[v+2]));}
    heights.sort((a,b)=>a-b);
    assert.ok(heights[Math.floor(heights.length*.05)]>p.heightMetres*.45,`${species} leaves belong in the crown`);
    assert.ok(Math.max(...spread.slice(0,20000))>p.crownRadiusMetres*.7,`${species} crown spreads wide`);
    assert.equal(p.leaf.indexCount%12,0);
    for(let k=0;k<p.wood.indexCount;k++){
      const v=indices[p.wood.firstIndex+k]*14,height=vertices[v+1],reach=Math.hypot(vertices[v],vertices[v+2]);
      if(height<1)assert.ok(reach<1,`${species} has no surface roots: wood at ${reach} m near the ground`);
    }
  }
});

test('shot chars the nearest tree, fells it on the third hit, and the mark survives streaming',()=>{
  const root=(x,z)=>[x,2,z,1.2,0,1,1,1,0,0,-2,0];
  const roots=new Float32Array([...root(0,0),...root(40,0)]),strikes=new Map();
  assert.equal(strikeForestRoot(roots,2,1,1,strikes),0);
  assert.ok(Math.abs(roots[5]-.6)<1e-6,'one hit chars it');
  assert.equal(roots[3],Math.fround(1.2),'one hit leaves it standing');
  assert.equal(strikeForestRoot(roots,2,20,0,strikes),-1,'nothing stands within reach');
  strikeForestRoot(roots,2,0,0,strikes);strikeForestRoot(roots,2,0,0,strikes);
  assert.ok(roots[11]<0,'the third hit fells it');
  assert.equal(roots[15],Math.fround(1.2),'its neighbour is untouched');
  assert.equal(strikeForestRoot(roots,1,0,0,strikes),-1,'a felled tree takes no more hits');
  const streamed=new Float32Array([...root(40,0),...root(0,0)]);
  reapplyForestStrikes(streamed,2,strikes);
  assert.ok(streamed[12+11]<0,'still felled after the coast streams again');
  assert.equal(streamed[11],0);
});

test('cluster assets are written as literal paths, so the build publishes them',()=>{
  // build.mjs finds assets by matching quoted paths in the source. A path built at run time 404s on the
  // site, and the forest then quietly falls back to its old tiers.
  const source=fs.readFileSync('js/forest-clusters.js','utf8');
  const build=fs.readFileSync('build.mjs','utf8');
  assert.match(build,/FOREST_CLUSTER_ASSETS/);
  assert.match(build,/SUBTROPICAL_FOREST_CLUSTER_ASSETS/);
  assert.match(build,/\.\.\.Object\.values\(PORTUGAL_FOREST_CLUSTER_ASSETS\)/,'Lisbon\'s pack is published with its clusters');
  for(const file of [...Object.values(FOREST_CLUSTER_ASSETS),...Object.values(SUBTROPICAL_FOREST_CLUSTER_ASSETS),...Object.values(PORTUGAL_FOREST_CLUSTER_ASSETS)]){
    assert.ok(source.includes(`'${file}'`),`${file} must appear literally`);
    assert.ok(fs.existsSync(file),`${file} must exist`);
  }
});

function grownTree(species){
  const dir='assets/forest-scenery/subtropical',manifest=JSON.parse(fs.readFileSync(`${dir}/manifest.json`,'utf8'));
  const raw=zlib.gunzipSync(fs.readFileSync(`${dir}/vertices.bin.gz`)),vertices=new Float32Array(raw.buffer,raw.byteOffset,raw.length/4);
  const rawIndices=zlib.gunzipSync(fs.readFileSync(`${dir}/indices.bin.gz`)),indices=new Uint32Array(rawIndices.buffer,rawIndices.byteOffset,rawIndices.length/4);
  const p=manifest.prototypes.find(q=>q.species===species);
  const positions=range=>{const out=[];for(let k=0;k<range.indexCount;k+=3){const v=indices[range.firstIndex+k]*14;out.push([vertices[v],vertices[v+1],vertices[v+2]]);}return out;};
  return {p,wood:positions(p.wood),leaves:positions(p.leaf)};
}
const reachOf=([x,,z])=>Math.hypot(x,z);
const furthest=points=>points.reduce((most,point)=>Math.max(most,reachOf(point)),0);

test('a ceiba is a broad emergent on plank buttresses, with its leaves high and wide',()=>{
  const {p,wood,leaves}=grownTree('ceiba');
  assert.ok(p.crownRadius>=7,'its crown spreads far wider than the old column');
  const low=leaves.filter(([,y])=>y<p.heightMetres*.5).length;
  assert.ok(low<leaves.length*.02,`leaves belong in the crown, ${low} of ${leaves.length} hang low`);
  assert.ok(furthest(leaves)>p.crownRadius*.8,'the crown reaches its stated radius');
  const buttress=wood.filter(([,y])=>y<.6);
  assert.ok(furthest(buttress)>1.5,'buttresses run out from the foot of the trunk');
  const bole=wood.filter(([,y])=>y>6&&y<8);
  assert.ok(furthest(bole)<.8,'and are gone a few metres up');
});

test('a mangrove is a low dome on prop roots that reach the ground',()=>{
  const {p,wood,leaves}=grownTree('mangrove');
  assert.ok(p.heightMetres<10,'mangroves stay low');
  assert.ok(p.crownRadius>=3.5,'with a broad crown');
  const feet=wood.filter(([,y])=>y<0);
  assert.ok(feet.length>20,'prop roots reach the ground');
  const out=feet.filter(point=>reachOf(point)>1.2);
  assert.ok(out.length>10,'well out from the stems');
  const low=leaves.filter(([,y])=>y<1.5).length;
  assert.ok(low<leaves.length*.02,`the roots stand clear of the leaves: ${low} of ${leaves.length} hang low`);
});

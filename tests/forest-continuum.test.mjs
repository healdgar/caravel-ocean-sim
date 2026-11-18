import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import zlib from 'node:zlib';
import {CONTINUUM_CLUSTER_TRIANGLES,CONTINUUM_CLUSTER_WORDS,CONTINUUM_HEADER,CONTINUUM_TYPE,CONTINUUM_TYPE_WORDS,checkContinuumAtlas} from '../js/continuum-format.js';
import {FOREST_CONTINUUM_ASSETS,SUBTROPICAL_FOREST_CONTINUUM_ASSETS,PORTUGAL_FOREST_CONTINUUM_ASSETS,validateForestContinuumManifest} from '../js/forest-continuum.js';
import {reapplyForestStrikes,strikeForestRoot} from '../js/forest-trunks.js';

const ASSETS={saba:FOREST_CONTINUUM_ASSETS,subtropical:SUBTROPICAL_FOREST_CONTINUUM_ASSETS,portugal:PORTUGAL_FOREST_CONTINUUM_ASSETS};
// The saba atlas is over GitHub's file limit and is baked locally (scripts/prepare-forest-continuum.mjs saba).
const present=pack=>fs.existsSync(ASSETS[pack]['atlas.bin.gz']);
function loadPack(pack){
  const manifest=validateForestContinuumManifest(JSON.parse(fs.readFileSync(ASSETS[pack]['manifest.json'],'utf8')));
  const bytes=zlib.gunzipSync(fs.readFileSync(ASSETS[pack]['atlas.bin.gz']));
  assert.equal(bytes.length,manifest.atlas.bytes);
  assert.equal(createHash('sha256').update(bytes).digest('hex'),manifest.atlas.sha256);
  const words=checkContinuumAtlas(new Uint32Array(bytes.buffer,bytes.byteOffset,bytes.length/4),pack);
  return {manifest,words,floats:new Float32Array(words.buffer,words.byteOffset,words.length)};
}
const typeOf=({words,floats},t)=>{const at=words[CONTINUUM_HEADER.typesAt]+t*CONTINUUM_TYPE_WORDS;return{first:words[at+CONTINUUM_TYPE.clusterFirst],count:words[at+CONTINUUM_TYPE.clusterCount],sphere:Array.from(floats.subarray(at+CONTINUUM_TYPE.sphere,at+CONTINUUM_TYPE.sphere+4))};};
const cluster=({words,floats},type,i)=>{
  const at=words[CONTINUUM_HEADER.clustersAt]+(type.first+i)*CONTINUUM_CLUSTER_WORDS;
  return{lod:Array.from(floats.subarray(at,at+4)),parent:Array.from(floats.subarray(at+4,at+8)),cull:Array.from(floats.subarray(at+8,at+12)),err:floats[at+12],parentErr:floats[at+13],triangles:words[at+15]&255};
};
// The one cut's own test (js/continuum-core.js continuumClusterDrawn), seen from `distance` metres off its sphere's centre.
const drawnAt=(c,distance,focal,pixels)=>{
  const projected=(e,s)=>e*focal/Math.max(distance-s[3],1e-3);
  return projected(c.parentErr,c.parent)>pixels&&projected(c.err,c.lod)<=pixels;
};

for(const pack of Object.keys(ASSETS))test(`${pack}: every tree is one type of the one continuum, its clusters ordered so the cut can take a prefix`,{skip:!present(pack)&&'its atlas is baked locally'},()=>{
  const data=loadPack(pack);
  const forest=JSON.parse(fs.readFileSync(`assets/forest-scenery/${pack}/manifest.json`,'utf8'));
  assert.deepEqual(data.manifest.types.map(t=>t.name),forest.prototypes.map(p=>`${p.species}${p.cohort?`-${p.cohort}`:''}`),'every prototype is baked, in the order roots name them');
  data.manifest.types.forEach((t,id)=>{
    const type=typeOf(data,id);
    let previous=Infinity,roots=0;
    for(let i=0;i<type.count;i++){
      const c=cluster(data,type,i);
      assert.ok(c.parentErr<=previous,`${t.name} cluster ${i} breaks the coarsest-first order`);previous=c.parentErr;
      assert.ok(c.triangles>0&&c.triangles<=CONTINUUM_CLUSTER_TRIANGLES);
      assert.ok(c.err<=c.parentErr,'a parent is never finer than its child');
      // The cut bounds the clusters it tries by the type's sphere: one poking out of it would be missed.
      for(const s of [c.lod,c.parent,c.cull])assert.ok(Math.hypot(s[0]-type.sphere[0],s[1]-type.sphere[1],s[2]-type.sphere[2])+s[3]<=type.sphere[3]+1e-3,`${t.name} cluster ${i} lies outside its type's sphere`);
      if(c.parentErr>1e29)roots++;
    }
    assert.ok(roots>0,`${t.name} needs a coarsest cut`);
    assert.ok(t.clusters.leafClusters>0,`${t.name} has leaves`);
  });
});

test('a tree has one cut at each distance, and it gets coarser with distance',()=>{
  const data=loadPack('subtropical'),id=data.manifest.types.findIndex(t=>t.name==='palm'),type=typeOf(data,id);
  const counts=[8,30,120,500,2000].map(distance=>{
    let triangles=0;
    for(let i=0;i<type.count;i++){const c=cluster(data,type,i);if(drawnAt(c,distance,1000,3))triangles+=c.triangles;}
    return triangles;
  });
  for(let i=1;i<counts.length;i++)assert.ok(counts[i]<=counts[i-1],`triangles rose with distance: ${counts}`);
  assert.ok(counts[0]>counts.at(-1)*20,`too little range between near and far: ${counts}`);
  assert.ok(counts.at(-1)>0,'a far tree must still draw something');
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

test('continuum assets are written as literal paths, so the build publishes them',()=>{
  // build.mjs finds assets by matching quoted paths in the source. A path built at run time 404s on the site.
  const source=fs.readFileSync('js/forest-continuum.js','utf8');
  const build=fs.readFileSync('build.mjs','utf8');
  assert.match(build,/FOREST_CONTINUUM_ASSETS/);
  assert.match(build,/SUBTROPICAL_FOREST_CONTINUUM_ASSETS/);
  assert.match(build,/PORTUGAL_FOREST_CONTINUUM_ASSETS/);
  for(const file of Object.values(ASSETS).flatMap(Object.values)){
    assert.ok(source.includes(`'${file}'`),`${file} must appear literally`);
    if(!file.includes('/saba/continuum/atlas'))assert.ok(fs.existsSync(file),`${file} must exist`);
  }
});

function grownTree(species){
  const dir='assets/forest-scenery/subtropical',manifest=JSON.parse(fs.readFileSync(`${dir}/manifest.json`,'utf8'));
  const raw=zlib.gunzipSync(fs.readFileSync(`${dir}/vertices.bin.gz`)),vertices=new Float32Array(raw.buffer,raw.byteOffset,raw.length/4);
  const rawIndices=zlib.gunzipSync(fs.readFileSync(`${dir}/indices.bin.gz`)),indices=new Uint32Array(rawIndices.buffer,rawIndices.byteOffset,rawIndices.length/4);
  const p=manifest.prototypes.find(q=>q.species===species);
  const positions=range=>{const out=[];for(let k=0;k<range.indexCount;k+=3){const v=indices[range.firstIndex+k]*14;out.push([vertices[v],vertices[v+1],vertices[v+2]]);}return out;};
  return {p,wood:positions(p.wood),leaves:positions(p.leaf),pack:manifest.prototypes};
}
const reachOf=([x,,z])=>Math.hypot(x,z);
const furthest=points=>points.reduce((most,point)=>Math.max(most,reachOf(point)),0);

// The ceiba and the mangrove are forestmodeler's (commit 86873b3), which the owner kept over the two grown here
// before them. These say how those trees are built, so that a new bake which changes their build is noticed.
test('a ceiba is the tallest and broadest tree of its pack: a clear trunk, boughs from a few metres up, a crown wider than it is tall',()=>{
  const {p,wood,leaves,pack}=grownTree('ceiba');
  assert.ok(pack.every(other=>other.heightMetres<=p.heightMetres&&other.crownRadius<=p.crownRadius),'no tree of the pack is taller or broader');
  assert.ok(p.crownRadius>=7&&p.crownRadius*2>p.heightMetres,'its crown is wider than the tree is tall');
  assert.ok(furthest(leaves)>p.crownRadius*.8,'the crown reaches its stated radius');
  const trunk=wood.filter(([,y])=>y>=0&&y<2);
  assert.ok(furthest(trunk)<.6,'the trunk rises clear for its first two metres');
  const onTrunk=leaves.filter(([,y])=>y<2).length;
  assert.ok(onTrunk<leaves.length*.03,`with next to no leaf on it: ${onTrunk} of ${leaves.length} hang under two metres`);
  const boughs=wood.filter(([,y])=>y>6&&y<8);
  assert.ok(furthest(boughs)>p.crownRadius*.7,'boughs carry the crown out to its edge');
  // Its foliage starts low for so tall a tree: the body of the crown is the middle half of its height.
  const body=leaves.filter(([,y])=>y>=p.heightMetres*.25&&y<p.heightMetres*.75).length;
  assert.ok(body>leaves.length*.75,`most of its leaves lie in the middle half of its height: ${body} of ${leaves.length}`);
  const roots=wood.filter(([,y])=>y<0);
  assert.ok(furthest(roots)>1.5,'roots run out from the foot of the trunk, under the ground');
});

test('a mangrove is a low dome wider than it is tall, in leaf nearly to the ground, over roots that spread beneath it',()=>{
  const {p,wood,leaves}=grownTree('mangrove');
  assert.ok(p.heightMetres<10,'mangroves stay low');
  assert.ok(p.crownRadius>=3.5&&p.crownRadius*2>p.heightMetres,'under a crown wider than the tree is tall');
  const feet=wood.filter(([,y])=>y<0);
  assert.ok(feet.length>20,'roots reach into the ground');
  const out=feet.filter(point=>reachOf(point)>1.2);
  assert.ok(out.length>10,'well out from the stems');
  const dome=leaves.filter(([,y])=>y>=1.5&&y<5).length;
  assert.ok(dome>leaves.length*.8,`the dome is the bulk of it: ${dome} of ${leaves.length} leaves lie between 1.5 and 5 metres`);
  const fringe=leaves.filter(([,y])=>y<1.5).length;
  assert.ok(fringe>0&&fringe<leaves.length*.1,`a fringe of leaf hangs under the dome, and no more than a fringe: ${fringe} of ${leaves.length}`);
  assert.ok(leaves.every(([,y])=>y>=0),'and no leaf lies under the ground');
});

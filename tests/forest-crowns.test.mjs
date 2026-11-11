import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import zlib from 'node:zlib';
import {FOREST_CROWN_LEVELS,FOREST_CROWN_NEAREST,FOREST_CROWN_BAND,PORTUGAL_FOREST_CROWN_ASSETS,SUBTROPICAL_FOREST_CROWN_ASSETS,validateForestCrowns,loadForestCrowns,forestCrownLook,forestCrownChange,FOREST_CROWN_WGSL} from '../js/forest-crowns.js';
import {FOREST_CLUSTER_SELECT,FOREST_CLUSTER_VERTEX_WGSL,FOREST_CLUSTER_VERTEX_WORDS} from '../js/forest-clusters.js';
import {FOREST_VERTEX_WGSL} from '../js/forest-scenery.js';

const PACKS={portugal:PORTUGAL_FOREST_CROWN_ASSETS,subtropical:SUBTROPICAL_FOREST_CROWN_ASSETS};
function loadPack(pack){
  const dir=`assets/forest-scenery/${pack}/crowns`,manifest=JSON.parse(fs.readFileSync(`${dir}/manifest.json`,'utf8')),streams={};
  for(const [name,receipt] of Object.entries(manifest.files)){
    const bytes=zlib.gunzipSync(fs.readFileSync(`${dir}/${receipt.gzip.file}`));
    assert.equal(bytes.length,receipt.bytes,name);
    assert.equal(createHash('sha256').update(bytes).digest('hex'),receipt.sha256,name);
    streams[name]=new Uint32Array(bytes.buffer,bytes.byteOffset,bytes.length/4);
  }
  return {manifest,vertices:streams['vertices.bin'],indices:streams['indices.bin']};
}
const position=(data,p,vertex)=>{
  const at=vertex*FOREST_CLUSTER_VERTEX_WORDS,w0=data.vertices[at],w1=data.vertices[at+1];
  return [w0&65535,w0>>>16,w1&65535].map((v,k)=>p.low[k]+v/65535*p.posScale);
};

for(const pack of Object.keys(PACKS))test(`${pack} has a verified crown for every species: one closed body and its trunk, facing outward at every level`,()=>{
  const data=loadPack(pack),forest=JSON.parse(fs.readFileSync(`assets/forest-scenery/${pack}/manifest.json`,'utf8'));
  validateForestCrowns(data.manifest);
  assert.deepEqual(data.manifest.prototypes.map(p=>[p.id,p.species,p.cohort??null]),forest.prototypes.map(p=>[p.id,p.species,p.cohort??null]),'every species is baked, in the order roots name them');
  assert.equal(data.vertices.length,data.manifest.vertexCount*FOREST_CLUSTER_VERTEX_WORDS);
  assert.equal(data.indices.length,data.manifest.indexCount);
  for(const p of data.manifest.prototypes){
    const source=forest.prototypes[p.id];
    assert.equal(p.levels.length,FOREST_CROWN_LEVELS);
    for(const [id,level] of p.levels.entries()){
      const name=`${p.species} ${p.cohort??''} level ${id}`,edges=new Map(),body=new Map();let volume=0;
      const find=v=>{let root=v;while(body.get(root)!==root)root=body.get(root);body.set(v,root);return root;};
      for(let i=level.firstIndex;i<level.firstIndex+level.indexCount;i+=3){
        const corners=[0,1,2].map(k=>data.indices[i+k]);
        for(const v of corners){assert.ok(v>=p.firstVertex&&v<p.firstVertex+p.vertexCount,`${name} reaches into another tree's vertices`);if(!body.has(v))body.set(v,v);}
        body.set(find(corners[1]),find(corners[0]));body.set(find(corners[2]),find(corners[0]));
        for(let k=0;k<3;k++){const a=corners[k],b=corners[(k+1)%3],key=a<b?`${a},${b}`:`${b},${a}`;edges.set(key,(edges.get(key)??0)+(a<b?1:-1));}
        const [a,b,c]=corners.map(v=>position(data,p,v));
        volume+=(a[0]*(b[1]*c[2]-b[2]*c[1])-a[1]*(b[0]*c[2]-b[2]*c[0])+a[2]*(b[0]*c[1]-b[1]*c[0]))/6;
      }
      // Back faces are culled, so a gap or a face turned inward would show as a hole in the canopy.
      assert.ok([...edges.values()].every(n=>n===0),`${name} is not closed: some edge lacks its opposite`);
      assert.ok(volume>0,`${name} faces inward`);
      // A far wood reads as crowns, not as cards: the leaves are one continuous body, and the trunk
      // (material 1, lit as wood) is the only other.
      const bodies=new Map();
      for(const v of body.keys()){const root=find(v),wood=((data.vertices[v*FOREST_CLUSTER_VERTEX_WORDS+1]>>>16)&255)===1;assert.ok(!bodies.has(root)||bodies.get(root)===wood,`${name} joins leaf to wood`);bodies.set(root,wood);}
      assert.equal([...bodies.values()].filter(wood=>!wood).length,1,`${name} is not one body`);
      assert.equal([...bodies.values()].filter(wood=>wood).length,level.trunkTriangles?1:0,`${name} trunk`);
      if(id)assert.ok(level.indexCount<p.levels[id-1].indexCount,`${name} is no coarser than the level before`);
    }
    // No thinner-looking woods: the levels the game draws nearest cover what the far leaves cover.
    for(const level of p.levels)assert.ok(Math.abs(level.outlineShare-1)<.06,`${p.species} ${p.cohort??''} covers ${level.outlineShare} of its leaves' outline`);
    // The crown stays within the tree it stands for.
    const low=[Infinity,Infinity,Infinity],high=[-Infinity,-Infinity,-Infinity];
    for(let v=p.firstVertex;v<p.firstVertex+p.vertexCount;v++)position(data,p,v).forEach((x,k)=>{low[k]=Math.min(low[k],x);high[k]=Math.max(high[k],x);});
    const reach=Math.max(1.5,source.radius*.25);
    for(let k=0;k<3;k++){assert.ok(low[k]>source.centre[k]-source.radius-reach,`${p.species} crown leaves its tree`);assert.ok(high[k]<source.centre[k]+source.radius+reach,`${p.species} crown leaves its tree`);}
    const look=forestCrownLook(p);
    assert.equal(look.length,12);assert.ok(look[4]>.5&&look[4]<=1,'leaves seen at one place face much the same way');
    assert.ok(look[5]>=0&&look[5]<.5&&look[6]>0&&look[6]<=1);
    // A leaf's underside is paler than a dark upper face, most of all in blue (forestNativeLeafFS mixes towards the material's reference).
    for(const gain of look.subarray(8,11))assert.ok(gain>.5&&gain<12,`${p.species} underside gain ${gain}`);
  }
});

test('crowns load only what verifies',async()=>{
  const serve=(change=bytes=>bytes)=>async path=>{
    const bytes=change(fs.readFileSync(path),path);
    return {ok:true,status:200,json:async()=>JSON.parse(bytes.toString()),body:new Blob([bytes]).stream()};
  };
  const crowns=await loadForestCrowns({assets:PORTUGAL_FOREST_CROWN_ASSETS,fetchAsset:serve()});
  assert.equal(crowns.manifest.prototypes.length,12);
  assert.equal(crowns.vertices.byteLength,crowns.manifest.vertexCount*FOREST_CLUSTER_VERTEX_WORDS*4);
  // One flipped bit in the vertices, repacked so that only the checksum can tell.
  const spoiled=serve((bytes,path)=>{if(!path.endsWith('vertices.bin.gz'))return bytes;const raw=zlib.gunzipSync(bytes);raw[40]^=1;return zlib.gzipSync(raw);});
  await assert.rejects(loadForestCrowns({assets:PORTUGAL_FOREST_CROWN_ASSETS,fetchAsset:spoiled}),/failed verification/);
  await assert.rejects(loadForestCrowns({assets:PORTUGAL_FOREST_CROWN_ASSETS,fetchAsset:async()=>({ok:false,status:404})}),/unavailable \(404\)/);
  const manifest=JSON.parse(fs.readFileSync(PORTUGAL_FOREST_CROWN_ASSETS['manifest.json'],'utf8'));
  assert.throws(()=>validateForestCrowns({...manifest,levels:2}),/Invalid forest crown manifest/);
  assert.throws(()=>validateForestCrowns({...manifest,prototypes:manifest.prototypes.map((p,i)=>i?p:{...p,levels:p.levels.slice().reverse()})}),/malformed/);
});

test('a crown takes over no nearer than the range at which leaf cards reach their far shape',()=>{
  // The cards' far shape and coverage are complete at 320 m (forestClusterVertex) and 220 m (forestNativeLeafDepthFS).
  assert.ok(FOREST_CROWN_NEAREST>=320);
  // Every crown names the leaf cut at which its tree changes: in a view 1117 pixels high and 58 degrees tall, at that range.
  for(const pack of Object.keys(PACKS))for(const p of loadPack(pack).manifest.prototypes){
    const widest=loadPack(pack).manifest.widestLeafErrors;
    const view={leafErrorMetres:p.leafErrorMetres,breadthMetres:p.breadthMetres,widestLeafErrors:widest,pixelsPerMetre:1008,leafPixels:1.2};
    const leaves=forestCrownChange({...view,widestLeafErrors:0}),change=forestCrownChange(view),grown=forestCrownChange({...view,scale:2.5});
    assert.ok(leaves.start>=FOREST_CROWN_NEAREST&&leaves.start<FOREST_CROWN_NEAREST+1,`${p.species} changes at ${leaves.start} m`);
    for(const [at,scale]of [[change,1],[grown,2.5]]){
      assert.ok(Math.abs(at.end-at.start*(1+FOREST_CROWN_BAND))<1e-9);
      // Closed woods change at the one range whatever a tree's size. On open ground a broad tree keeps its
      // leaves until it is no wider on screen than the pack allows, at any size it is grown to.
      if(!widest){assert.equal(at.start,leaves.start);continue;}
      assert.ok(at.start>=leaves.start);
      assert.ok(p.breadthMetres*scale*1008/at.start<=1.2*widest+1e-6,`${p.species} is ${p.breadthMetres*scale*1008/at.start} pixels broad at its change`);
    }
    assert.ok(grown.start>=change.start);
  }
  // Lisbon's woods are closed; the tropics' trees stand apart, and a ceiba grown to twice its modelled size keeps its leaves well past the nearest range.
  assert.equal(loadPack('portugal').manifest.widestLeafErrors,undefined);
  const tropics=loadPack('subtropical').manifest,ceiba=tropics.prototypes.find(p=>p.species==='ceiba');
  assert.ok(tropics.widestLeafErrors>0);
  assert.ok(forestCrownChange({leafErrorMetres:ceiba.leafErrorMetres,breadthMetres:ceiba.breadthMetres,widestLeafErrors:tropics.widestLeafErrors,scale:2,pixelsPerMetre:1008,leafPixels:1.2}).start>FOREST_CROWN_NEAREST*1.8);
  const near=forestCrownChange({leafErrorMetres:.1,pixelsPerMetre:1008,leafPixels:1.2});
  assert.equal(near.start,FOREST_CROWN_NEAREST);
  // A sharper picture or a spyglass carries the change further out.
  const sharp=forestCrownChange({leafErrorMetres:.39,pixelsPerMetre:2016,leafPixels:1.2});
  assert.ok(sharp.start>FOREST_CROWN_NEAREST*1.9);
  assert.ok(forestCrownChange({leafErrorMetres:.39,pixelsPerMetre:3970,leafPixels:1.2}).start>sharp.start);
});

test('the GPU cut, the leaves and the crown agree on which samples each draws',()=>{
  const select=FOREST_CLUSTER_SELECT('struct Frame{x:f32};');
  assert.ok(select.includes(`const FOREST_CROWN_NEAREST=${FOREST_CROWN_NEAREST.toFixed(2)};`));
  assert.match(FOREST_CLUSTER_SELECT('',{nearest:150,limit:1000}),/FOREST_CROWN_LIMIT=1000\.0000;\nconst FOREST_CROWN_NEAREST=150\.00;/);
  // The change falls where the leaves are drawn as coarse as the crown's manifest says, by the leaves' own limit.
  assert.match(select,/let start=max\(max\(FOREST_CROWN_NEAREST,bucket\.crownErr\.w\*focal\/limitLeaf\),bucket\.crownSize\.x\*scale\*focal\/limitLeaf\);/);
  // A tree wholly in its crown lists no cluster of leaf or wood, and a leaf cluster carries its tree's share above its number.
  assert.match(select,/if\(crownShare==255u\)\{return;\}/);
  assert.match(FOREST_CROWN_WGSL,/let wood=\(\(w1>>16u\)&255u\)==1u;/);
  assert.match(select,/index\|select\(0u,crownShare<<24u,isLeaf\)/);
  assert.match(FOREST_CLUSTER_VERTEX_WGSL,/forestClusters\[item\.y&0xffffffu\]/);
  assert.match(FOREST_CLUSTER_VERTEX_WGSL,/o\.crownFade=f32\(item\.y>>24u\)\/255\.;/);
  // The leaves give up exactly the samples the crown takes.
  assert.match(FOREST_VERTEX_WGSL,/forestLeafSampleMask\(alpha,in\.coverageSeed,in\.pos\.xy\)&~forestCrownSamples\(in\.crownFade,in\.pos\.xy\)/);
  assert.match(FOREST_CROWN_WGSL,/o\.mask=forestCrownSamples\(in\.crownFade,in\.pos\.xy\)/);
  // The crown that has wholly taken over is plain opaque: no sample mask, no discard, so hidden crowns cost nothing.
  const solid=/@fragment fn forestCrownFS\([^)]*\)->@location\(0\)vec4f\{[^}]*\}/.exec(FOREST_CROWN_WGSL)?.[0]??'';
  assert.ok(solid&&!/discard|sample_mask/.test(solid));
  assert.ok(!/discard/.test(FOREST_CROWN_WGSL));
});

// forestCrownSamples, as the shader computes it.
function crownSamples(share,x,y,samples){
  if(share<=0)return 0;
  const hash=value=>{let v=value>>>0;v=Math.imul(v^(v>>>16),0x7feb352d)>>>0;v=Math.imul(v^(v>>>15),0x846ca68b)>>>0;return (v^(v>>>16))>>>0;};
  const random=hash((x^hash((Math.imul(y,0x9e3779b9)+0x51ed270b)>>>0))>>>0);
  const count=Math.min(samples,Math.floor(share*samples+(random&65535)/65536)),bits=(1<<count)-1,rotation=(random>>>16)%samples;
  return ((bits<<rotation)|(bits>>>(samples-rotation)))&((1<<samples)-1);
}
test('over the change a crown takes its share of every pixel\'s samples, evenly',()=>{
  for(const samples of [1,2,4])for(const share of [1/255,.25,.5,.8,1]){
    let taken=0;const each=new Array(samples).fill(0);
    for(let y=0;y<128;y++)for(let x=0;x<128;x++){
      const mask=crownSamples(share,x,y,samples);
      assert.ok(mask>=0&&mask<1<<samples);
      for(let s=0;s<samples;s++)if(mask&(1<<s)){taken++;each[s]++;}
    }
    const mean=taken/(128*128*samples);
    assert.ok(Math.abs(mean-share)<.02,`${samples} samples at ${share}: took ${mean}`);
    for(const n of each)assert.ok(Math.abs(n/(128*128)-share)<.04,'no sample is favoured');
  }
  assert.equal(crownSamples(0,5,9,4),0);
  assert.equal(crownSamples(1,5,9,4),15,'a crown that has taken over takes every sample');
});

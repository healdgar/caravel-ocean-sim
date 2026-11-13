import {test} from 'node:test';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import fs from 'node:fs';
import zlib from 'node:zlib';
import {FOREST_CROWN_VERSION,FOREST_CROWN_STEP_WORDS,FOREST_CROWN_SPLAT_PIXELS,FOREST_CROWN_MIN_PIXELS,FOREST_CROWN_NEAREST,FOREST_CROWN_BAND,PORTUGAL_FOREST_CROWN_ASSETS,SUBTROPICAL_FOREST_CROWN_ASSETS,validateForestCrowns,loadForestCrowns,forestCrownLook,forestCrownSplatLook,forestCrownChange,FOREST_CROWN_WGSL} from '../js/forest-crowns.js';
import {FOREST_CLUSTER_SELECT,FOREST_CLUSTER_VERTEX_WGSL,FOREST_CLUSTER_VERTEX_WORDS} from '../js/forest-clusters.js';
import {FOREST_VERTEX_WGSL} from '../js/forest-scenery.js';

const PACKS={portugal:PORTUGAL_FOREST_CROWN_ASSETS,subtropical:SUBTROPICAL_FOREST_CROWN_ASSETS};
const f32Buf=new ArrayBuffer(4),u32View=new Uint32Array(f32Buf),f32View=new Float32Array(f32Buf);
const bitsToF32=u=>{u32View[0]=u>>>0;return f32View[0];};

function loadPack(pack){
  const dir=`assets/forest-scenery/${pack}/crowns`,manifest=JSON.parse(fs.readFileSync(`${dir}/manifest.json`,'utf8')),streams={};
  for(const [name,receipt] of Object.entries(manifest.files)){
    const bytes=zlib.gunzipSync(fs.readFileSync(`${dir}/${receipt.gzip.file}`));
    assert.equal(bytes.length,receipt.bytes,name);
    assert.equal(createHash('sha256').update(bytes).digest('hex'),receipt.sha256,name);
    streams[name]=new Uint32Array(bytes.buffer,bytes.byteOffset,bytes.length/4);
  }
  return {manifest,vertices:streams['vertices.bin'],indices:streams['indices.bin'],morph:streams['morph.bin']};
}
const position=(data,p,vertex)=>{
  const at=vertex*FOREST_CLUSTER_VERTEX_WORDS,w0=data.vertices[at],w1=data.vertices[at+1];
  return [w0&65535,w0>>>16,w1&65535].map((v,k)=>p.low[k]+v/65535*p.posScale);
};
const isWood=(data,vertex)=>((data.vertices[vertex*FOREST_CLUSTER_VERTEX_WORDS+1]>>>16)&255)===1;
const readMappedLocal=(morph,mapOff,localV)=>{
  const w=morph[mapOff+(localV>>>2)];
  return (w>>>((localV&3)*8))&255;
};

for(const pack of Object.keys(PACKS))test(`${pack} has one progressive continuum crown per species: closed, outward, C0-continuous across every half-edge collapse down to its core and 1-tri splat`,()=>{
  const data=loadPack(pack),forest=JSON.parse(fs.readFileSync(`assets/forest-scenery/${pack}/manifest.json`,'utf8'));
  validateForestCrowns(data.manifest);
  assert.equal(data.manifest.version,FOREST_CROWN_VERSION);
  assert.deepEqual(data.manifest.prototypes.map(p=>[p.id,p.species,p.cohort??null]),forest.prototypes.map(p=>[p.id,p.species,p.cohort??null]),'every species is baked, in the order roots name them');
  assert.equal(data.vertices.length,data.manifest.vertexCount*FOREST_CLUSTER_VERTEX_WORDS);
  assert.equal(data.morph.length,data.manifest.morphWordCount);
  assert.equal(data.indices.length,data.manifest.indexCount);
  assert.deepEqual([...data.indices.subarray(data.manifest.splatFirstIndex,data.manifest.splatFirstIndex+3)],[0,1,2],'1-triangle horizon splat index triplet');

  for(const p of data.manifest.prototypes){
    const source=forest.prototypes[p.id];
    assert.ok(p.stepCount>=100,`${p.species} should collapse smoothly across >100 half-edge steps (got ${p.stepCount})`);
    assert.ok(p.minFoliageTriangles>=4&&p.minFoliageTriangles<=8,`${p.species} collapses down to a minimal closed polyhedron (${p.minFoliageTriangles} tris)`);
    assert.ok(p.outlineShareRange[0]>.94&&p.outlineShareRange[1]<1.06,`${p.species} ${p.cohort??''} keeps silhouette outline share in [0.94, 1.06]: ${p.outlineShareRange}`);

    const low=[Infinity,Infinity,Infinity],high=[-Infinity,-Infinity,-Infinity];
    let prevAlive=Infinity,prevErr=-1;

    for(let s=0;s<=p.stepCount;s++){
      const name=`${p.species} ${p.cohort??''} step ${s}/${p.stepCount}`;
      const hdr=p.morphOffset+s*FOREST_CROWN_STEP_WORDS;
      const h0=data.morph[hdr],aliveTris=h0&65535,collapseV=(h0>>>16)&255,targetV=h0>>>24;
      const err=bitsToF32(data.morph[hdr+1]),grow=bitsToF32(data.morph[hdr+2]),mapOff=data.morph[hdr+3];

      assert.ok(aliveTris>0&&aliveTris*3<=p.baseIndexCount,`${name} alive triangle count ${aliveTris}`);
      assert.ok(aliveTris<prevAlive,`${name} did not retire any triangles (${aliveTris} vs ${prevAlive})`);
      assert.ok(err>prevErr,`${name} error is not strictly increasing (${err} vs ${prevErr})`);
      prevAlive=aliveTris;prevErr=err;

      if(s<p.stepCount&&collapseV<250){
        const nextMapOff=data.morph[hdr+FOREST_CROWN_STEP_WORDS+3];
        for(let lv=0;lv<p.vertexCount;lv++){
          const curM=readMappedLocal(data.morph,mapOff,lv);
          const nextM=readMappedLocal(data.morph,nextMapOff,lv);
          assert.equal(nextM,curM===collapseV?targetV:curM,`${name} C0 ancestor transition mismatch at local vertex ${lv}`);
        }
      }
      if(s===p.stepCount)assert.equal(collapseV,255,`${name} final step morphs into splat ellipsoid`);

      const edges=new Map(),body=new Map();
      let folVol=0,woodVol=0,woodTris=0;
      const find=v=>{let root=v;while(body.get(root)!==root)root=body.get(root);body.set(v,root);return root;};

      for(let t=0;t<aliveTris;t++){
        const i=p.firstIndex+t*3;
        const corners=[0,1,2].map(k=>{
          const baseGv=data.indices[i+k];
          assert.ok(baseGv>=p.firstVertex&&baseGv<p.firstVertex+p.vertexCount,`${name} index out of prototype range`);
          const mappedLocal=readMappedLocal(data.morph,mapOff,baseGv-p.firstVertex);
          assert.ok(mappedLocal<p.vertexCount,`${name} mapped local vertex out of range`);
          return p.firstVertex+mappedLocal;
        });
        assert.ok(corners[0]!==corners[1]&&corners[1]!==corners[2]&&corners[2]!==corners[0],`${name} contains degenerate triangle in active prefix`);
        for(const v of corners)if(!body.has(v))body.set(v,v);
        body.set(find(corners[1]),find(corners[0]));body.set(find(corners[2]),find(corners[0]));
        for(let k=0;k<3;k++){
          const a=corners[k],b=corners[(k+1)%3],key=a<b?`${a},${b}`:`${b},${a}`;
          edges.set(key,(edges.get(key)??0)+(a<b?1:-1));
        }
        const wood=isWood(data,corners[0]);
        const pts=corners.map(v=>{
          const raw=position(data,p,v);
          const scaled=wood?raw:[0,1,2].map(axis=>p.splat.centre[axis]+(raw[axis]-p.splat.centre[axis])*grow);
          for(let axis=0;axis<3;axis++){low[axis]=Math.min(low[axis],scaled[axis]);high[axis]=Math.max(high[axis],scaled[axis]);}
          return scaled;
        });
        const [a,b,c]=pts;
        const v6=(a[0]*(b[1]*c[2]-b[2]*c[1])-a[1]*(b[0]*c[2]-b[2]*c[0])+a[2]*(b[0]*c[1]-b[1]*c[0]))/6;
        if(wood){woodVol+=v6;woodTris++;}else folVol+=v6;
      }

      assert.ok([...edges.values()].every(n=>n===0),`${name} is not closed: some edge lacks its opposite`);
      assert.ok(folVol>0,`${name} foliage faces inward (${folVol})`);
      if(woodTris>0)assert.ok(woodVol>0,`${name} trunk faces inward (${woodVol})`);
      if(s===p.stepCount)assert.equal(woodTris,0,`${name} sub-pixel trunk should be retired before splat handoff`);

      const bodies=new Map();
      for(const v of body.keys()){
        const root=find(v),wood=isWood(data,v);
        assert.ok(!bodies.has(root)||bodies.get(root)===wood,`${name} joins leaf to wood`);
        bodies.set(root,wood);
      }
      assert.equal([...bodies.values()].filter(wood=>!wood).length,1,`${name} foliage is not one body`);
      assert.equal([...bodies.values()].filter(wood=>wood).length,woodTris?1:0,`${name} trunk body count`);
    }

    const reach=Math.max(1.5,source.radius*.25);
    for(let k=0;k<3;k++){
      assert.ok(low[k]>source.centre[k]-source.radius-reach,`${p.species} crown leaves its tree (low[${k}]=${low[k]})`);
      assert.ok(high[k]<source.centre[k]+source.radius+reach,`${p.species} crown leaves its tree (high[${k}]=${high[k]})`);
    }
    const look=forestCrownLook(p),splatLook=forestCrownSplatLook(p);
    assert.equal(look.length,16);
    assert.ok(look[4]>.5&&look[4]<=1,'leaves seen at one place face much the same way');
    assert.ok(look[5]>=0&&look[5]<.5&&look[6]>0&&look[6]<=1);
    assert.equal(splatLook.length,12);
    assert.ok(splatLook[3]>0&&splatLook[7]>0,'1-triangle splat radii are positive');
    assert.ok(Math.abs(3.14025*splatLook[3]*splatLook[7]-p.stats.meanOutlineSquareMetres)/p.stats.meanOutlineSquareMetres<.03,'1-triangle splat matches the crown mean silhouette area');
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
  assert.equal(crowns.morph.byteLength,crowns.manifest.morphWordCount*4);
  const spoiled=serve((bytes,path)=>{if(!path.endsWith('vertices.bin.gz'))return bytes;const raw=zlib.gunzipSync(bytes);raw[40]^=1;return zlib.gzipSync(raw);});
  await assert.rejects(loadForestCrowns({assets:PORTUGAL_FOREST_CROWN_ASSETS,fetchAsset:spoiled}),/failed verification/);
  await assert.rejects(loadForestCrowns({assets:PORTUGAL_FOREST_CROWN_ASSETS,fetchAsset:async()=>({ok:false,status:404})}),/unavailable \(404\)/);
  const manifest=JSON.parse(fs.readFileSync(PORTUGAL_FOREST_CROWN_ASSETS['manifest.json'],'utf8'));
  assert.throws(()=>validateForestCrowns({...manifest,version:2}),/Invalid forest crown manifest/);
  assert.throws(()=>validateForestCrowns({...manifest,prototypes:manifest.prototypes.map((p,i)=>i?p:{...p,stepCount:0})}),/malformed/);
});

test('a crown takes over no nearer than the range at which leaf cards reach their far shape',()=>{
  assert.ok(FOREST_CROWN_NEAREST>=320);
  for(const pack of Object.keys(PACKS))for(const p of loadPack(pack).manifest.prototypes){
    const widest=loadPack(pack).manifest.widestLeafErrors;
    const view={leafErrorMetres:p.leafErrorMetres,breadthMetres:p.breadthMetres,widestLeafErrors:widest,pixelsPerMetre:1008,leafPixels:1.2};
    const leaves=forestCrownChange({...view,widestLeafErrors:0}),change=forestCrownChange(view),grown=forestCrownChange({...view,scale:2.5});
    assert.ok(leaves.start>=FOREST_CROWN_NEAREST&&leaves.start<FOREST_CROWN_NEAREST+1,`${p.species} changes at ${leaves.start} m`);
    for(const [at,scale]of [[change,1],[grown,2.5]]){
      assert.ok(Math.abs(at.end-at.start*(1+FOREST_CROWN_BAND))<1e-9);
      if(!widest){assert.equal(at.start,leaves.start);continue;}
      assert.ok(at.start>=leaves.start);
      assert.ok(p.breadthMetres*scale*1008/at.start<=1.2*widest+1e-6,`${p.species} is ${p.breadthMetres*scale*1008/at.start} pixels broad at its change`);
    }
    assert.ok(grown.start>=change.start);
  }
  assert.equal(loadPack('portugal').manifest.widestLeafErrors,undefined);
  const tropics=loadPack('subtropical').manifest,ceiba=tropics.prototypes.find(p=>p.species==='ceiba');
  assert.ok(tropics.widestLeafErrors>0);
  assert.ok(forestCrownChange({leafErrorMetres:ceiba.leafErrorMetres,breadthMetres:ceiba.breadthMetres,widestLeafErrors:tropics.widestLeafErrors,scale:2,pixelsPerMetre:1008,leafPixels:1.2}).start>FOREST_CROWN_NEAREST*1.8);
  const near=forestCrownChange({leafErrorMetres:.1,pixelsPerMetre:1008,leafPixels:1.2});
  assert.equal(near.start,FOREST_CROWN_NEAREST);
  const sharp=forestCrownChange({leafErrorMetres:.39,pixelsPerMetre:2016,leafPixels:1.2});
  assert.ok(sharp.start>FOREST_CROWN_NEAREST*1.9);
  assert.ok(forestCrownChange({leafErrorMetres:.39,pixelsPerMetre:3970,leafPixels:1.2}).start>sharp.start);
});

test('the GPU progressive continuum cut, the leaves and the crown agree on which samples each draws',()=>{
  const select=FOREST_CLUSTER_SELECT('struct Frame{x:f32};');
  assert.ok(select.includes(`const FOREST_CROWN_NEAREST=${FOREST_CROWN_NEAREST.toFixed(2)};`));
  assert.ok(select.includes(`const FOREST_CROWN_SPLAT_PIXELS=${FOREST_CROWN_SPLAT_PIXELS.toFixed(4)};`));
  assert.ok(select.includes(`const FOREST_CROWN_MIN_PIXELS=${FOREST_CROWN_MIN_PIXELS.toFixed(4)};`));
  assert.match(FOREST_CLUSTER_SELECT('',{nearest:150,limit:1000}),/FOREST_CROWN_LIMIT=1000\.0000;\nconst FOREST_CROWN_NEAREST=150\.00;/);
  assert.match(select,/let start=max\(max\(FOREST_CROWN_NEAREST,bucket\.crownSize\.z\*focal\/limitLeaf\),bucket\.crownSize\.x\*scale\*focal\/limitLeaf\);/);
  assert.match(select,/while\(sLo<sHi\)/);
  assert.match(FOREST_CROWN_WGSL,/let wood=\(\(w1>>16u\)&255u\)==1u;/);
  assert.match(select,/index\|select\(0u,crownShare<<24u,isLeaf\)/);
  assert.match(FOREST_CLUSTER_VERTEX_WGSL,/forestClusters\[item\.y&0xffffffu\]/);
  assert.match(FOREST_CLUSTER_VERTEX_WGSL,/o\.crownFade=f32\(item\.y>>24u\)\/255\.;/);
  assert.match(FOREST_VERTEX_WGSL,/forestLeafSampleMask\(alpha,in\.coverageSeed,in\.pos\.xy\)&~forestCrownSamples\(in\.crownFade,in\.pos\.xy\)/);
  assert.match(FOREST_CROWN_WGSL,/o\.mask=forestCrownSamples\(in\.crownFade,in\.pos\.xy\)/);
  const solid=/@fragment fn forestCrownFS\([^)]*\)->@location\(0\)vec4f\{[^}]*\}/.exec(FOREST_CROWN_WGSL)?.[0]??'';
  assert.ok(solid&&!/discard|sample_mask/.test(solid));
  assert.ok(!/discard/.test(FOREST_CROWN_WGSL));
});

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

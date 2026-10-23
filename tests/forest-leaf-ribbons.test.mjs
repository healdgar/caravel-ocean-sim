// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {reduceForestLeafRibbons,prepareForestRibbonInspection} from '../js/forest-leaf-ribbons.js';

const ribbonUV=[[0,0],[1,0],[1,.5],[0,.5],[1,1],[0,1]],ribbonIndices=[0,1,2,0,2,3,3,2,4,3,4,5];
const fanUV=[[0,0],[1,0],[1,1],[0,1],[.5,.5]],fanIndices=[0,1,4,1,2,4,2,3,4,3,0,4];
function fixture({fan=false,stride=14,heights,material=2,shift=[0,0,0],prefix=0,reverse=false}={}){
 const uv=fan?fanUV:ribbonUV,order=fan?fanIndices:ribbonIndices,vertices=new Float32Array((prefix+uv.length)*stride);
 for(let id=0;id<prefix;id++)vertices.set([20+id,0,0,0,0,1,3,.8,0,0,.2,.4,.1,0,...(stride===15?[1]:[])],id*stride);
 for(const [id,p]of uv.entries())vertices.set([p[0]+shift[0],p[1]+shift[1],(heights?.[id]??0)+shift[2],0,0,1,4,.8,...p,.2,.4,.1,material,...(stride===15?[1]:[])],(prefix+id)*stride);
 const body=order.map(id=>id+prefix);if(reverse)for(let at=0;at<body.length;at+=3)[body[at+1],body[at+2]]=[body[at+2],body[at+1]];
 const indices=Uint32Array.from([...(prefix?[0,1,2]:[]),...body]),range={firstIndex:prefix?3:0,indexCount:12};return{vertices,indices,range,stride};
}
const reduce=f=>reduceForestLeafRibbons(f.vertices,f.indices,f.range,{vertexStride:f.stride});
const close=(a,b,epsilon=1e-10)=>assert.ok(Math.abs(a-b)<=epsilon,`${a} != ${b}`);

test('curved six-vertex ribbon halves triangles without deleting a blade or changing original records',()=>{
 const f=fixture({heights:[0,0,.25,.25,0,0],prefix:3}),before=f.vertices.slice(),beforeIndices=f.indices.slice(),beforeRange={...f.range},r=reduce(f),b=r.blades[0];
 assert.equal(r.format,'waterworld.forest-leaf-ribbons');assert.equal(r.leafCount,1);assert.equal(r.sourceTriangles,4);assert.equal(r.triangles,2);assert.equal(r.vertexStride,56);
 assert.equal(r.vertices,f.vertices);assert.equal(r.source.vertices,f.vertices);assert.equal(r.source.indices,f.indices);assert.deepEqual(r.source.range,f.range);
 assert.deepEqual(r.indices,new Uint32Array([3,4,7,3,7,8]));assert.deepEqual(b.cornerVertexIDs,[3,4,7,8]);assert.deepEqual(b.sourceVertexIDs,[3,4,5,6,7,8]);
 assert.deepEqual({sourceFirstIndex:b.sourceFirstIndex,sourceIndexCount:b.sourceIndexCount,firstIndex:b.firstIndex,indexCount:b.indexCount},{sourceFirstIndex:3,sourceIndexCount:12,firstIndex:0,indexCount:6});
 close(b.positionErrorMetres,.25);assert.ok(b.positionErrorUpperMetres>=.25);assert.ok(b.positionErrorUpperMetres<.25000001);assert.equal(r.maximumPositionErrorUpperMetres,b.positionErrorUpperMetres);
 assert.equal(r.appearanceQualified,false);assert.equal(b.interpolationDeviations.qualified,false);assert.equal(b.interpolationDeviations.canopyAO,null);
 assert.deepEqual(f.vertices,before);assert.deepEqual(f.indices,beforeIndices);assert.deepEqual(f.range,beforeRange);
});

test('overlay intersections expose error missed by checking only original ribbon vertices',()=>{
 // Original intermediate edge vertices lie exactly on both candidate surfaces.
 // Nevertheless the differing internal diagonals yield maxima at UV crossings.
 const r=reduce(fixture({heights:[0,0,.5,0,1,0]})),b=r.blades[0];
 assert.equal(b.diagonal,0);close(b.diagonalPositionErrorsMetres[0],.25);close(b.diagonalPositionErrorsMetres[1],1/3);
 close(b.witness.uv[0],.5);close(b.witness.uv[1],.5);close(b.positionErrorMetres,.25);
 assert.ok(!ribbonUV.some(uv=>uv[0]===b.witness.uv[0]&&uv[1]===b.witness.uv[1]));assert.ok(b.sourceTriangleTargets.every(n=>n>=1&&n<=3));
});

test('planar five-vertex fan is exact geometrically while changed normal/AO interpolation stays unqualified',()=>{
 const f=fixture({fan:true,stride:15});f.vertices.set([0,1,0],4*15+3);f.vertices[4*15+7]=.2;f.vertices[4*15+14]=0;
 const r=reduce(f),b=r.blades[0];assert.equal(r.vertexStride,60);assert.equal(b.diagonal,0);close(b.positionErrorMetres,0);assert.ok(b.positionErrorUpperMetres<1e-9);
 close(b.interpolationDeviations.normalVector,Math.SQRT2);close(b.interpolationDeviations.exposure,.6,1e-7);close(b.interpolationDeviations.canopyAO,1);assert.equal(b.interpolationDeviations.qualified,false);
 assert.deepEqual(r.indices,new Uint32Array([0,1,2,0,2,3]));assert.ok(r.limitations.some(s=>s.includes('normal maps/AO')));
});

test('selects the lower-error outer diagonal and retains source winding even for nonplanar fans',()=>{
 const a=reduce(fixture({fan:true,heights:[0,0,1,0,.5]})).blades[0];assert.equal(a.diagonal,0);close(a.positionErrorMetres,0);close(a.diagonalPositionErrorsMetres[1],.5);
 const f=fixture({fan:true,heights:[1,0,0,0,0],reverse:true}),r=reduce(f),b=r.blades[0];assert.equal(b.diagonal,1);close(b.positionErrorMetres,0);close(b.diagonalPositionErrorsMetres[0],.5);
 assert.deepEqual(r.indices,new Uint32Array([0,3,1,1,3,2]));
 for(let at=0;at<r.indices.length;at+=3){const uv=[...r.indices.subarray(at,at+3)].map(id=>Array.from(f.vertices.subarray(id*14+8,id*14+10)));assert.ok((uv[1][0]-uv[0][0])*(uv[2][1]-uv[0][1])-(uv[1][1]-uv[0][1])*(uv[2][0]-uv[0][0])<0);}
});

test('multiple complete blades retain original global membership, material and stride15 AO records',()=>{
 const a=fixture({stride:15,material:2,heights:[0,0,.1,.1,0,0]}),b=fixture({stride:15,material:7,shift:[4,2,3]}),vertices=new Float32Array(a.vertices.length+b.vertices.length);vertices.set(a.vertices);vertices.set(b.vertices,a.vertices.length);
 const indices=Uint32Array.from([...a.indices,...b.indices].map((id,at)=>at<12?id:id+6)),before=vertices.slice(),r=reduceForestLeafRibbons(vertices,indices,undefined,{vertexStride:15});
 assert.equal(r.leafCount,2);assert.equal(r.indices.length,12);assert.deepEqual(r.blades.map(p=>p.material),[2,7]);assert.deepEqual(r.blades.map(p=>p.sourceFirstIndex),[0,12]);assert.deepEqual(r.blades.map(p=>p.firstIndex),[0,6]);
 for(const blade of r.blades){const original=new Set(indices.subarray(blade.sourceFirstIndex,blade.sourceFirstIndex+12));for(const id of r.indices.subarray(blade.firstIndex,blade.firstIndex+6)){assert.ok(original.has(id));assert.equal(vertices[id*15+13],blade.material);assert.equal(vertices[id*15+14],1);}}
 assert.deepEqual(vertices,before);assert.notEqual(r.indices,indices);assert.equal(r.source.indices,indices);
});

test('duplicate seam IDs with identical positions remain distinct records; a discontinuous seam fails',()=>{
 const f=fixture(),vertices=new Float32Array(12*14),indices=Uint32Array.from({length:12},(_,i)=>i);
 for(let at=0;at<12;at++)vertices.set(f.vertices.subarray(f.indices[at]*14,f.indices[at]*14+14),at*14);
 const r=reduceForestLeafRibbons(vertices,indices);assert.equal(r.leafCount,1);assert.equal(r.blades[0].sourceVertexIDs.length,12);
 for(const id of r.indices)assert.ok(indices.includes(id));const broken=vertices.slice();broken[3*14]+=.1;assert.throws(()=>reduceForestLeafRibbons(broken,indices),/discontinuous/);
});

test('the bound includes an explicit translation-sensitive arithmetic guard and deterministic ties',()=>{
 const f=fixture({heights:[0,0,.25,.25,0,0],shift:[1_000_000,1_000_000,1_000_000]}),a=reduce(f),b=reduce(f);
 close(a.blades[0].positionErrorMetres,.25,1e-8);assert.ok(a.blades[0].positionErrorUpperMetres>=.25+a.blades[0].arithmeticGuardMetres);assert.ok(a.blades[0].arithmeticGuardMetres>1e-7);
 assert.deepEqual(a.indices,b.indices);assert.deepEqual(a.blades,b.blades);assert.equal(a.blades[0].diagonal,0);
});

test('malformed records, incomplete blades, material/kind changes and nonconforming UV charts fail closed',()=>{
 const edits=[f=>f.vertices=new Float64Array(f.vertices),f=>f.indices=new Int32Array(f.indices),f=>f.vertices=f.vertices.subarray(1),f=>f.vertices[0]=NaN,f=>f.vertices[13]=Infinity,
  f=>f.indices[0]=f.vertices.length/14,f=>f.range.firstIndex=1,f=>f.range.indexCount=9,f=>f.range.indexCount=24,
  f=>f.vertices[2*14+13]=7,f=>f.vertices[2*14+6]=3,f=>f.vertices[2*14+6]=4.5,
  f=>f.vertices[0*14+8]=-.1,f=>f.vertices[0*14+8]=.1,f=>f.vertices[2*14+9]=.25,
  f=>{[f.indices[1],f.indices[2]]=[f.indices[2],f.indices[1]];},f=>f.indices[1]=f.indices[0],
  f=>f.indices.set(f.indices.subarray(0,3),3),f=>{for(const id of [0,1,2])f.vertices.set([0,0,0],id*14);}];
 for(const edit of edits){const f=fixture();edit(f);assert.throws(()=>reduce(f),/Forest leaf ribbon/);}
 const f=fixture();for(const vertexStride of [0,13,16,14.5])assert.throws(()=>reduceForestLeafRibbons(f.vertices,f.indices,f.range,{vertexStride}),/stride/);
});

test('rejects unsupported T junctions and charts lacking a single-valued UV-to-position map',()=>{
 const f=fixture({fan:true});f.vertices[4*14+8]=0;f.vertices[4*14+9]=.5;assert.throws(()=>reduce(f),/UV|boundary|topology/);
 const bad=fixture();bad.vertices[2*14+8]=0;bad.vertices[2*14+9]=.5;assert.throws(()=>reduce(bad),/discontinuous|UV/);
});


test('uses the supported diagonal when one collapses, and rejects two degenerate candidates',()=>{
 const f=fixture();f.vertices.set([2,0,0],4*14);const r=reduce(f),b=r.blades[0];
 assert.equal(b.diagonal,1);assert.equal(b.diagonalPositionErrorsMetres[0],null);assert.ok(Number.isFinite(b.diagonalPositionErrorBoundsMetres[1]));
 const folded=fixture();for(const [id,position]of [[0,[0,0,0]],[1,[1,0,0]],[2,[1,1,0]],[3,[2,1,0]],[4,[2,0,0]],[5,[3,0,0]]])folded.vertices.set(position,id*14);
 assert.throws(()=>reduce(folded),/both outer-corner diagonals/);
});


function inspectionFixture(){
 const a=fixture({stride:15,material:2,heights:[0,0,.25,.25,0,0]}),b=fixture({stride:15,material:7,shift:[4,2,3]}),backing=new ArrayBuffer(16+a.vertices.byteLength+b.vertices.byteLength+16),vertices=new Uint8Array(backing,16,a.vertices.byteLength+b.vertices.byteLength),floats=new Float32Array(backing,16,vertices.byteLength/4);floats.set(a.vertices);floats.set(b.vertices,a.vertices.length);floats.set([0,1,0],2*15+3);floats[2*15+7]=.4;floats[2*15+10]=.5;floats[2*15+14]=0;
 const indices=Uint32Array.from([...a.indices,...b.indices].map((id,at)=>at<12?id:id+6)),clusters=[
  {id:0,sourceNodeID:8,parentNodeID:4,firstLeaf:0,leafCount:1,firstVertex:0,vertexCount:6,firstIndex:0,indexCount:12,low:[0,0,0],high:[1,1,.25],centre:[.5,.5,.125],radius:1},
  {id:1,sourceNodeID:19,parentNodeID:12,firstLeaf:1,leafCount:1,firstVertex:6,vertexCount:6,firstIndex:12,indexCount:12,low:[4,2,3],high:[5,3,3],centre:[4.5,2.5,3],radius:1},
 ],ranges=new Map(clusters.map(c=>[c.sourceNodeID,{firstVertex:c.firstVertex,vertexCount:c.vertexCount,firstIndex:c.firstIndex,indexCount:c.indexCount}]));
 const inspection={vertexStride:60,prototype:{id:0,leafCount:2},vertices,indices,sourceIDs:Uint32Array.from({length:12},(_,i)=>100+i),leafOrder:new Uint32Array([1,0]),clusters,ranges,materials:[{index:2},{index:7}],textures:new Map([['original',{}]]),manifest:{format:'source'},stats:{sourceMembershipVerified:true},destroy(){}};
 return{inspection,floats,ribbons:reduceForestLeafRibbons(floats,indices,undefined,{vertexStride:15})};
}

test('explicit ribbon inspection shares source records and provides two complete disjoint candidate index spans',()=>{
 const {inspection:i,floats,ribbons:r}=inspectionFixture(),beforeV=i.vertices.slice(),beforeI=i.indices.slice(),beforeR=r.indices.slice(),beforeClusters=structuredClone(i.clusters),derived=prepareForestRibbonInspection(i,r);
 assert.notEqual(derived,i);assert.equal(derived.vertices,i.vertices);assert.equal(derived.materials,i.materials);assert.equal(derived.textures,i.textures);assert.equal(derived.sourceIDs,i.sourceIDs);assert.equal(derived.leafOrder,i.leafOrder);assert.equal(derived.manifest,i.manifest);assert.equal(derived.destroy,i.destroy);assert.equal(derived.sourceRanges,i.ranges);
 assert.deepEqual(derived.indices,Uint32Array.from([...r.indices,...i.indices]));assert.equal(derived.clusters.length,4);
 assert.deepEqual(derived.clusters.map(c=>[c.selectionKey,c.representation,c.firstIndex,c.indexCount]),[['ribbon:8','ribbon',0,6],['ribbon:19','ribbon',6,6],['original:8','original',12,12],['original:19','original',24,12]]);
 for(const [index,c]of derived.clusters.entries()){
  const source=i.clusters[index%2];assert.notEqual(c,source);for(const key of ['low','high','centre'])assert.equal(c[key],source[key]);for(const key of ['radius','firstLeaf','leafCount','firstVertex','vertexCount','sourceNodeID'])assert.equal(c[key],source[key]);
  assert.deepEqual(derived.ranges.get(c.selectionKey),{firstVertex:c.firstVertex,vertexCount:c.vertexCount,firstIndex:c.firstIndex,indexCount:c.indexCount});
 }
 assert.equal(derived.clusters[0].reductionErrorMetres,r.blades[0].positionErrorUpperMetres);assert.equal(derived.clusters[1].reductionErrorMetres,r.blades[1].positionErrorUpperMetres);assert.ok(derived.clusters[0].reductionErrorMetres>derived.clusters[1].reductionErrorMetres);assert.equal(derived.clusters[2].reductionErrorMetres,0);
 assert.deepEqual(derived.reduction,{format:'waterworld.forest-ribbon-inspection',version:1,appearanceQualified:false,maximumPositionErrorUpperMetres:r.maximumPositionErrorUpperMetres,sourceTriangles:8,reducedTriangles:4,fullTriangles:12,interpolationDeviations:r.blades[0].interpolationDeviations});
 assert.equal(derived.clusters[0].appearanceQualified,false);assert.deepEqual(derived.clusters[0].interpolationDeviations,r.blades[0].interpolationDeviations);assert.deepEqual(derived.clusters[1].interpolationDeviations,r.blades[1].interpolationDeviations);assert.equal(derived.reduction.interpolationDeviations.qualified,false);close(derived.reduction.interpolationDeviations.normalVector,Math.SQRT2);close(derived.reduction.interpolationDeviations.canopyAO,1);
 assert.deepEqual(i.vertices,beforeV);assert.deepEqual(i.indices,beforeI);assert.deepEqual(r.indices,beforeR);assert.deepEqual(i.clusters,beforeClusters);assert.equal(floats.buffer,i.vertices.buffer);assert.equal(Object.hasOwn(i,'reduction'),false);assert.equal(i.ranges.has('ribbon:8'),false);
});

test('each explicit candidate frontier owns every source blade once and aggregates its own guarded error',()=>{
 const {inspection:i,ribbons:r}=inspectionFixture(),merged={...i,clusters:[{...i.clusters[0],sourceNodeID:3,firstLeaf:0,leafCount:2,firstVertex:0,vertexCount:12,firstIndex:0,indexCount:24,low:[0,0,0],high:[5,3,3],radius:4}],ranges:new Map([[3,{firstVertex:0,vertexCount:12,firstIndex:0,indexCount:24}]])},derived=prepareForestRibbonInspection(merged,r);
 assert.equal(derived.clusters.length,2);assert.equal(derived.clusters[0].reductionErrorMetres,Math.max(...r.blades.map(b=>b.positionErrorUpperMetres)));for(const key of ['normalVector','exposure','linearRGB','canopyAO']){assert.equal(derived.clusters[0].interpolationDeviations[key],Math.max(...r.blades.map(b=>b.interpolationDeviations[key])));assert.equal(derived.reduction.interpolationDeviations[key],derived.clusters[0].interpolationDeviations[key]);}
 for(const representation of ['ribbon','original']){const selected=derived.clusters.filter(c=>c.representation===representation),cover=selected.flatMap(c=>Array.from({length:c.leafCount},(_,k)=>c.firstLeaf+k));assert.deepEqual(cover,[0,1]);}
});

test('ribbon inspection rejects copied buffers, forged results, incomplete reducer ranges and double derivation',()=>{
 const {inspection:i,floats,ribbons:r}=inspectionFixture();
 assert.throws(()=>prepareForestRibbonInspection(i,{...r}),/original stride15 reducer result/);
 assert.throws(()=>prepareForestRibbonInspection({...i,vertices:i.vertices.slice()},r),/source buffers/);
 assert.throws(()=>prepareForestRibbonInspection({...i,vertices:new Uint8Array(i.vertices.buffer,i.vertices.byteOffset+4,i.vertices.byteLength-4)},r),/original60B/);
 assert.throws(()=>prepareForestRibbonInspection({...i,indices:i.indices.slice()},r),/source buffers/);
 const copied=reduceForestLeafRibbons(floats.slice(),i.indices,undefined,{vertexStride:15});assert.throws(()=>prepareForestRibbonInspection(i,copied),/source buffers/);
 const partial=reduceForestLeafRibbons(floats,i.indices,{firstIndex:0,indexCount:12},{vertexStride:15});assert.throws(()=>prepareForestRibbonInspection(i,partial),/source buffers/);
 const derived=prepareForestRibbonInspection(i,r);assert.throws(()=>prepareForestRibbonInspection(derived,r),/source buffers|membership/);
});

test('ribbon inspection rejects mutated reduced membership and malformed cluster/pointer/frontier cover',()=>{
 const mutations=[
  x=>x.ribbons.indices[0]=2,
  x=>x.inspection.clusters[0].firstIndex=12,
  x=>x.inspection.clusters[0].indexCount=6,
  x=>x.inspection.clusters[0].leafCount=2,
  x=>x.inspection.clusters[1].firstLeaf=0,
  x=>x.inspection.clusters[1].sourceNodeID=8,
  x=>x.inspection.clusters[0].firstVertex=1,
  x=>x.inspection.clusters[0].radius=NaN,
  x=>x.inspection.clusters[0].high=[.5,.5,.1],
  x=>x.inspection.ranges.get(8).indexCount=6,
  x=>x.inspection.sourceIDs=x.inspection.sourceIDs.subarray(1),
  x=>x.inspection.leafOrder[1]=1,
  x=>x.inspection.materials=[{index:2}],
  x=>x.inspection.clusters=x.inspection.clusters.slice(0,1),
 ];
 for(const mutate of mutations){const x=inspectionFixture();mutate(x);assert.throws(()=>prepareForestRibbonInspection(x.inspection,x.ribbons),/Forest leaf ribbon/);}
});

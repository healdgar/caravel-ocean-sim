// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {partitionForestLeaves,selectForestClusterFrontier,assembleForestClusterIndices} from '../scripts/forest-lod-clusters.mjs';

function forestLodFixture(centres=[9,-3,5,-7,1,11,-1,3]){
 const vertices=new Float32Array((3+centres.length*6)*14),indices=new Uint32Array(3+centres.length*12);
 for(let id=0;id<3;id++)vertices.set([100+(id===1?1:0),id===2?1:0,0,0,0,1,3,.8,0,0,.2,.3,.1,0],id*14);
 indices.set([0,1,2]);
 for(let leaf=0;leaf<centres.length;leaf++){
  const centre=Array.isArray(centres[leaf])?centres[leaf]:[centres[leaf],0,0];
  for(let corner=0;corner<6;corner++){
   const y=corner%3-1;vertices.set([centre[0]+(corner<3?-.15:.15),centre[1]+y*.2,centre[2]+Math.abs(y)*.02,0,0,1,4,.8,corner<3?0:1,(corner%3)*.5,.2,.4,.1,1+leaf%3],(3+leaf*6+corner)*14);
  }
  indices.set([0,3,4,0,4,1,1,4,5,1,5,2].map(id=>id+3+leaf*6),3+leaf*12);
 }
 return{vertices,indices,range:{firstIndex:3,indexCount:centres.length*12}};
}
function forestLodTriangles(indices){
 const triangles=[];for(let at=0;at<indices.length;at+=3)triangles.push(Array.from(indices.subarray(at,at+3)).join(','));return triangles.sort();
}
function forestLodCheckNodes(h){
 for(const node of h.nodes){
  assert.equal(node.firstIndex,node.firstLeaf*h.indicesPerLeaf);assert.equal(node.indexCount,node.leafCount*h.indicesPerLeaf);assert.ok(node.children.length===0||node.children.length===2);
  for(let at=node.firstIndex;at<node.firstIndex+node.indexCount;at++)for(let k=0;k<3;k++){
   const value=h.source.vertices[h.orderedIndices[at]*14+k];assert.ok(value>=node.low[k]&&value<=node.high[k]);
  }
  assert.deepEqual(node.centre,node.low.map((v,k)=>(v+node.high[k])*.5));
  if(node.children.length){
   const [left,right]=node.children.map(id=>h.nodes[id]);assert.equal(left.parent,node.id);assert.equal(right.parent,node.id);assert.equal(left.depth,node.depth+1);assert.equal(right.depth,node.depth+1);
   assert.equal(left.firstLeaf,node.firstLeaf);assert.equal(right.firstLeaf,left.firstLeaf+left.leafCount);assert.equal(left.leafCount+right.leafCount,node.leafCount);
  }
  assert.equal(Object.hasOwn(node,'indices'),false);assert.equal(Object.hasOwn(node,'leaves'),false);
 }
}

test('hierarchy retains complete blades, original winding, materials and immutable source references',()=>{
 const f=forestLodFixture(),beforeV=f.vertices.slice(),beforeI=f.indices.slice(),beforeRange={...f.range},h=partitionForestLeaves(f.vertices,f.indices,f.range,{maxLeaves:2});
 assert.equal(h.format,'waterworld.forest-leaf-hierarchy');assert.equal(h.root,0);assert.equal(h.leafCount,8);assert.equal(h.indicesPerLeaf,12);assert.equal(h.source.vertices,f.vertices);assert.equal(h.source.indices,f.indices);
 assert.deepEqual([...h.leafOrder].sort((a,b)=>a-b),[0,1,2,3,4,5,6,7]);assert.equal(h.orderedIndices.length,f.range.indexCount);assert.ok(h.nodes.length<=2*h.leafCount-1);
 for(let at=0;at<h.leafCount;at++){
  const original=h.leafOrder[at],first=f.range.firstIndex+original*12;assert.deepEqual(h.orderedIndices.subarray(at*12,at*12+12),f.indices.subarray(first,first+12));assert.equal(h.leafMaterials[original],1+original%3);
 }
 const frontier=selectForestClusterFrontier(h,2),assembled=assembleForestClusterIndices(h,frontier);
 assert.deepEqual(assembled,h.orderedIndices);assert.deepEqual(forestLodTriangles(assembled),forestLodTriangles(f.indices.subarray(f.range.firstIndex,f.range.firstIndex+f.range.indexCount)));
 assert.deepEqual(f.vertices,beforeV);assert.deepEqual(f.indices,beforeI);assert.deepEqual(f.range,beforeRange);forestLodCheckNodes(h);
});

test('median split uses longest centroid axis with deterministic source-order ties',()=>{
 const f=forestLodFixture([5,0,5,-5,0,9,-9,0]),h=partitionForestLeaves(f.vertices,f.indices,f.range,{maxLeaves:1}),again=partitionForestLeaves(f.vertices,f.indices,f.range,{maxLeaves:1});
 assert.deepEqual(h.leafOrder,new Uint32Array([6,3,1,4,7,0,2,5]));assert.deepEqual(h.leafOrder,again.leafOrder);assert.deepEqual(h.nodes,again.nodes);assert.deepEqual(h.orderedIndices,again.orderedIndices);
 const vertical=forestLodFixture([[0,100,0],[0,-100,0],[10,0,0],[-10,50,0]]),v=partitionForestLeaves(vertical.vertices,vertical.indices,vertical.range,{maxLeaves:2});
 assert.deepEqual(v.leafOrder,new Uint32Array([1,2,3,0]));forestLodCheckNodes(v);
});

test('exact-position seam duplicates establish connectivity without welding original IDs',()=>{
 const f=forestLodFixture([0]),vertices=new Float32Array(12*14),indices=Uint32Array.from({length:12},(_,i)=>i);
 for(let at=0;at<12;at++)vertices.set(f.vertices.subarray(f.indices[3+at]*14,f.indices[3+at]*14+14),at*14);
 const h=partitionForestLeaves(vertices,indices,{firstIndex:0,indexCount:12});assert.deepEqual(assembleForestClusterIndices(h,[0]),indices);assert.equal(new Set(h.orderedIndices).size,12);
 const disconnected=vertices.slice();for(let id=9;id<12;id++)disconnected[id*14]+=10;
 assert.throws(()=>partitionForestLeaves(disconnected,indices,{firstIndex:0,indexCount:12}),/Disconnected/);
});

test('frontiers cover each original blade exactly once and fail unavailable finer refinement',()=>{
 const f=forestLodFixture(),h=partitionForestLeaves(f.vertices,f.indices,f.range,{maxLeaves:2});
 for(const maximum of [2,3,4,8,100]){
  const frontier=selectForestClusterFrontier(h,maximum),members=frontier.flatMap(id=>{const n=h.nodes[id];assert.ok(n.leafCount<=maximum);return [...h.leafOrder.subarray(n.firstLeaf,n.firstLeaf+n.leafCount)];});
  assert.deepEqual(members.sort((a,b)=>a-b),[0,1,2,3,4,5,6,7]);assert.equal(new Set(members).size,h.leafCount);
 }
 assert.deepEqual(selectForestClusterFrontier(h,8),[0]);assert.throws(()=>selectForestClusterFrontier(h,1),/refinement unavailable/);
 const capped=partitionForestLeaves(f.vertices,f.indices,f.range,{maxLeaves:1,maxDepth:0});assert.equal(capped.nodes.length,1);assert.deepEqual(selectForestClusterFrontier(capped,8),[0]);assert.throws(()=>selectForestClusterFrontier(capped,4),/refinement unavailable/);
});

test('assembler supports partial disjoint bakes, preserves requested node order, rejects overlapping ownership',()=>{
 const f=forestLodFixture(),h=partitionForestLeaves(f.vertices,f.indices,f.range,{maxLeaves:1}),frontier=selectForestClusterFrontier(h,2),chosen=[frontier[2],frontier[0]],expected=[];
 for(const id of chosen){const n=h.nodes[id];expected.push(...h.orderedIndices.subarray(n.firstIndex,n.firstIndex+n.indexCount));}
 assert.deepEqual(assembleForestClusterIndices(h,chosen),Uint32Array.from(expected));assert.equal(assembleForestClusterIndices(h,[]).length,0);
 assert.throws(()=>assembleForestClusterIndices(h,[frontier[0],frontier[0]]),/Overlapping/);assert.throws(()=>assembleForestClusterIndices(h,[0,frontier[0]]),/Overlapping/);assert.throws(()=>assembleForestClusterIndices(h,[-1]),/node/);
 const changed={...h,orderedIndices:h.orderedIndices.slice()};changed.orderedIndices[0]=0;assert.throws(()=>assembleForestClusterIndices(changed,[0]),/changed after partition/);
 f.vertices[h.orderedIndices[0]*14+13]=90;assert.throws(()=>assembleForestClusterIndices(h,[0]),/changed after partition/);
});

test('malformed source types, finite attributes, complete ranges and leaf materials fail closed',()=>{
 const edits=[f=>f.vertices=new Uint8Array(f.vertices.buffer),f=>f.indices=new Int32Array(f.indices.buffer),f=>f.vertices=f.vertices.subarray(1),f=>f.vertices[0]=Infinity,
  f=>f.vertices[13]=NaN,f=>f.indices[0]=f.vertices.length/14,f=>f.range.firstIndex=4,f=>f.range.indexCount--,
  f=>f.vertices[f.indices[3]*14+13]=1.5,f=>f.vertices[f.indices[3]*14+13]=-1,f=>f.vertices[f.indices[3]*14+13]=128,
  f=>f.vertices[f.indices[3]*14+13]=2,f=>f.vertices[f.indices[3]*14+6]=3,f=>f.indices[4]=f.indices[3]];
 for(const edit of edits){const f=forestLodFixture();edit(f);assert.throws(()=>partitionForestLeaves(f.vertices,f.indices,f.range),/source|range|Nonfinite|material|kind|Degenerate/);}
 for(const options of [{leafTriangles:0},{leafTriangles:1.5},{leafTriangles:65},{maxDepth:-1},{maxDepth:33},{maxLeaves:0},{maxLeaves:Infinity}]){
  const f=forestLodFixture();assert.throws(()=>partitionForestLeaves(f.vertices,f.indices,f.range,options),/options/);
 }
});

test('frontier traversal rejects broken child ranges and corrupted original-leaf ownership',()=>{
 const f=forestLodFixture(),h=partitionForestLeaves(f.vertices,f.indices,f.range,{maxLeaves:1});
 const duplicate={...h,leafOrder:h.leafOrder.slice()};duplicate.leafOrder[1]=duplicate.leafOrder[0];assert.throws(()=>selectForestClusterFrontier(duplicate,8),/Overlapping/);
 const broken={...h,nodes:h.nodes.map(n=>({...n,children:[...n.children]}))};broken.nodes[broken.nodes[0].children[0]].parent=100;assert.throws(()=>selectForestClusterFrontier(broken,1),/parent\/child/);
 const missing={...h,nodes:h.nodes.map(n=>({...n,children:[...n.children]}))};missing.nodes[0].children[1]=h.nodes.length;assert.throws(()=>selectForestClusterFrontier(missing,1),/node/);
 for(const maximum of [0,-1,NaN,1.5])assert.throws(()=>selectForestClusterFrontier(h,maximum),/frontier/);
});

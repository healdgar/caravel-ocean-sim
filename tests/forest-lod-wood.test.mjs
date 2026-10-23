// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {forestWoodMaterialParts,reduceForestWood} from '../scripts/prepare-forest-wood-lods.mjs';

function fixture(){
 const vertices=new Float32Array(8*14);for(let i=0;i<8;i++)vertices.set([i%2,Math.floor(i/2)%2,Math.floor(i/4),0,0,1,3,.8,i%2,Math.floor(i/2)%2,1,1,1,Math.floor(i/4)],i*14);
 const indices=Uint32Array.from([0,1,2,2,1,3,4,5,6,6,5,7]),prototype={wood:{firstIndex:0,indexCount:12},nativeMaterials:[{name:'bark'},{name:'wound'}]};
 return{vertices,indices,prototype};
}
test('woody LODs retain source identities, exact vertex records and material partitions',()=>{
 const {vertices,indices,prototype}=fixture(),before=vertices.slice(),indexBefore=indices.slice();
 const tool={getScale:()=>1,simplifyWithAttributes:(source)=>[source.slice(0,3),.01]};
 const result=reduceForestWood(prototype,vertices,indices,tool,{tier:1,targetTriangles:2,errorMetres:.1});
 assert.equal(result.triangles,2);assert.equal(result.targetMet,true);assert.equal(result.parts.length,2);
 for(let id=0;id<result.sourceVertexIDs.length;id++)assert.deepEqual(result.vertices.subarray(id*14,id*14+14),vertices.subarray(result.sourceVertexIDs[id]*14,result.sourceVertexIDs[id]*14+14));
 for(const part of result.parts)for(const id of result.indices.subarray(part.firstIndex,part.firstIndex+part.indexCount))assert.equal(result.vertices[id*14+13],part.material);
 assert.deepEqual(vertices,before);assert.deepEqual(indices,indexBefore);
});
test('woody authoring rejects mixed materials, malformed indices and geometry mutation',()=>{
 const f=fixture();f.vertices[13]=1;assert.throws(()=>forestWoodMaterialParts(f.prototype,f.vertices,f.indices),/crosses material/);
 const outside=fixture();outside.indices[0]=9999;assert.throws(()=>forestWoodMaterialParts(outside.prototype,outside.vertices,outside.indices),/outside/);
 const original=fixture(),mutating={getScale:()=>1,simplifyWithAttributes:(indices,vertices)=>{vertices[0]+=1;return[indices,0];}};
 assert.throws(()=>reduceForestWood(original.prototype,original.vertices,original.indices,mutating,{tier:1,targetTriangles:2,errorMetres:.1}),/mutated source/);
 const excess=fixture(),tooFar={getScale:()=>1,simplifyWithAttributes:indices=>[indices,.2]};
 assert.throws(()=>reduceForestWood(excess.prototype,excess.vertices,excess.indices,tooFar,{tier:1,targetTriangles:2,errorMetres:.1}),/Invalid woody simplifier result/);
});

// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createAnchorGPUTemplate,writeAnchorGPUState,createAnchorRenderer,ANCHOR_GPU_RODE_SPANS,ANCHOR_GPU_STATE_FLOATS} from '../js/anchor.js';
import {ANCHOR_RENDER,ANCHOR_GPU_RENDER} from '../js/wgsl/anchor.js';
import {anchorEquipment,anchorRodePoints,anchorFairlead,anchorEyeOffset} from '../js/anchor-state.js';

test('anchor topology is immutable unit iron and GPU tube/splash templates',()=>{
  const a=createAnchorGPUTemplate(),b=createAnchorGPUTemplate();
  assert.deepEqual(a.vertices,b.vertices);assert.equal(a.vertices.length,a.totalCount*8);
  assert.ok(a.vertices.every(Number.isFinite));assert.ok(a.ironCount>100&&a.totalCount<4096);
  assert.equal(a.solidCount-a.ironCount,48*5*6+10*4*6);assert.equal(a.ringCount,24*6);assert.equal(a.totalCount-a.solidCount,24*6+16*3);
  const counts=new Map();for(let i=0;i<a.vertices.length;i+=8){const kind=a.vertices[i+6];counts.set(kind,(counts.get(kind)??0)+1);}
  assert.equal(counts.get(4),48*5*6);assert.equal(counts.get(5),10*4*6);assert.equal(counts.get(6),24*6);assert.equal(counts.get(7),16*3);
  assert.ok(!ANCHOR_RENDER.includes('anchorGPUState'),'shared tool shader retains its original interface');
  assert.match(ANCHOR_GPU_RENDER,/@binding\(7\).*anchorGPUState/);assert.match(ANCHOR_GPU_RENDER,/anchorGPUExpand\(position,normal,kind\)/);
});

test('anchor compact inputs retain all physical catenary knots and splash timing for each fitted model',()=>{
  for(const modelId of ['nina','victory','pinta','santa-maria','oseberg','lusoria','flying-cloud','gipsy-moth-iv']){
    const boat={modelId,x:12,z:-40,length:modelId==='victory'?56.69:20,beam:6,heave:.4,heading:72,pitch:.1,roll:-.2};
    const state={phase:'anchored',position:{x:9,y:-8,z:-37},worldHeading:23,rode:35,bed:-8,time:4,splash:{x:10,y:.2,z:-39,at:3.6}};
    const values=new Float32Array(ANCHOR_GPU_STATE_FLOATS),equipment=anchorEquipment(boat),knots=anchorRodePoints(state,boat,ANCHOR_GPU_RODE_SPANS);
    assert.equal(writeAnchorGPUState(state,boat,values),192);assert.ok(values.every(Number.isFinite));assert.equal(values.length,53*4);
    assert.equal(values[0],Math.fround(equipment.renderScale));assert.equal(values[1],Math.fround(equipment.rodeRadius));
    assert.equal(values[2],Math.fround(23*Math.PI/180));assert.equal(values[3],0);
    for(let i=0;i<49;i++)assert.deepEqual(values.subarray(16+i*4,20+i*4),Float32Array.from([knots[i].x,knots[i].y,knots[i].z,0]));
    assert.equal(writeAnchorGPUState({...state,time:4.5},boat,values),144);
    assert.equal(writeAnchorGPUState({...state,time:5.3},boat,values),0);
    assert.equal(writeAnchorGPUState({...state,phase:'stowed'},boat,values),0);assert.equal(values[3],1);
    const local={...boat,x:0,z:0,heave:0,heading:0,pitch:0,roll:0},fairlead=anchorFairlead(local);
    assert.deepEqual(values.subarray(4,7),Float32Array.from([fairlead.x,fairlead.y-anchorEyeOffset(boat),fairlead.z]));
    const localKnots=anchorRodePoints({...state,phase:'stowed'},local,48);
    for(let i=0;i<49;i++)assert.deepEqual(values.subarray(16+i*4,19+i*4),Float32Array.from([localKnots[i].x,localKnots[i].y,localKnots[i].z]));
  }
});

test('working anchor uploads only compact physical commands; stowed hull motion uploads only its pose',async t=>{
  const prior=Object.getOwnPropertyDescriptor(globalThis,'GPUBufferUsage');
  Object.defineProperty(globalThis,'GPUBufferUsage',{configurable:true,value:{VERTEX:1,COPY_DST:2,UNIFORM:4,STORAGE:8}});
  t.after(()=>prior?Object.defineProperty(globalThis,'GPUBufferUsage',prior):delete globalThis.GPUBufferUsage);
  const writes=[],buffers=[],device={createBuffer(desc){const b={...desc,destroyed:false,destroy(){this.destroyed=true;}};buffers.push(b);return b;},
    queue:{writeBuffer(buffer,offset,data){writes.push({buffer,offset,data:data.slice()});}},
    async createRenderPipelineAsync(desc){return{...desc,getBindGroupLayout(){return{};}};},createBindGroup(desc){return desc;}};
  const renderer=await createAnchorRenderer({device,shader:async source=>{assert.equal(source,ANCHOR_GPU_RENDER);return{};},shadows:{bind(){return{};}}});
  const boat={modelId:'nina',x:12,z:-40,length:20,beam:6,heave:.4,heading:72,pitch:.1,roll:-.2};
  const state={phase:'stowed',position:{x:0,y:0,z:0},worldHeading:23,rode:35,bed:-8,time:4,splash:null};
  renderer.update(state,boat);const afterStowed=writes.length;
  renderer.update(state,{...boat,heading:110,pitch:.3});
  assert.equal(writes.length,afterStowed+1);assert.equal(writes.at(-1).buffer.label,'anchor pose');
  for(const phase of ['lowering','setting','anchored','weighing'])renderer.update({...state,phase,position:{x:9,y:-8,z:-37},splash:{x:10,y:.2,z:-39,at:3.6}},boat);
  const geometry=writes.filter(w=>w.buffer.usage&GPUBufferUsage.VERTEX);assert.equal(geometry.length,1,'only initialization uploads vertices');
  for(const write of writes.slice(1))assert.ok(write.buffer.label==='anchor pose'||write.buffer.label==='anchor compact physical state');
  const draws=[],pass={setVertexBuffer(){},setPipeline(){},setBindGroup(){},draw(...args){draws.push(args);}};
  renderer.draw(pass);assert.equal(draws.length,2);assert.equal(draws[1][0],192);assert.equal(draws[1][2],draws[0][0]);
  renderer.destroy();assert.ok(buffers.every(b=>b.destroyed));
});

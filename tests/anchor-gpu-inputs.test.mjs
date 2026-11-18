// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ANCHOR_IRON} from '../js/anchor-iron.js';
import {writeAnchorSplashState,createAnchorSplashRenderer,ANCHOR_SPLASH_FLOATS} from '../js/anchor.js';
import {ANCHOR_RENDER,ANCHOR_SPLASH_RENDER,ANCHOR_SPLASH_RING_VERTICES,ANCHOR_SPLASH_DROP_VERTICES} from '../js/wgsl/anchor.js';
import {anchorEquipment,anchorEyeOffset} from '../js/anchor-state.js';
import {writeVesselDetailState,VESSEL_DETAIL_STATE_FLOATS} from '../js/vessel-detail.js';
import {createShipAssetCache} from '../js/ship-mesh.js';

test('the baked anchor stands in the frame the rode and the seabed rely on, and each fitted ship carries it whole',()=>{
  assert.equal(ANCHOR_IRON.length%18,0,'whole triangles of position and normal');
  const triangles=ANCHOR_IRON.length/18;assert.ok(triangles<=400,`${triangles} triangles is over budget`);
  let lowY=Infinity,highY=-Infinity,maxX=0,maxZ=0;
  for(let i=0;i<ANCHOR_IRON.length;i+=6){
    const x=ANCHOR_IRON[i],y=ANCHOR_IRON[i+1],z=ANCHOR_IRON[i+2];lowY=Math.min(lowY,y);highY=Math.max(highY,y);maxX=Math.max(maxX,Math.abs(x));maxZ=Math.max(maxZ,Math.abs(z));
    assert.ok(Math.abs(Math.hypot(ANCHOR_IRON[i+3],ANCHOR_IRON[i+4],ANCHOR_IRON[i+5])-1)<.01,'unit normals');
  }
  assert.ok(Math.abs(lowY+.67)<.002,`crown at ${lowY}`);
  assert.ok(highY>.65&&highY<.8,`the ring tops out at ${highY}, around the rode's eye at .65`);
  assert.ok(maxX>.4&&maxX<.7,`arms reach ${maxX}`);assert.ok(maxZ>.4&&maxZ<.8,`stock reaches ${maxZ}`);
  // Her working anchor's iron is part of her assembly (js/vessel-detail.js), every corner of it a station of her pose pass.
  const cache=createShipAssetCache();
  for(const modelId of ['nina','victory']){
    const asset=cache.get(modelId),iron=asset.groups.find(g=>g.id==='anchor.port.iron');
    assert.ok(iron&&iron.nodeId==='anchor.port.root',`${modelId} carries her anchor's iron`);
    assert.equal(iron.vertexCount,ANCHOR_IRON.length/6,`${modelId} carries every triangle of it`);
    assert.ok(asset.groups.some(g=>g.id==='anchor.port.ring'),`${modelId} carries the fairlead's ring`);
  }
  assert.ok(!cache.get('taino-canoe').groups.some(g=>g.id.startsWith('anchor.port.')),'a canoe with no anchor carries none');
});

test('the anchor splash keeps the shared material and builds its ring and drops from the vertex index',()=>{
  assert.ok(!ANCHOR_RENDER.includes('anchorSplash'),'shared tool shader retains its original interface');
  assert.match(ANCHOR_SPLASH_RENDER,/@binding\(7\)\s*var<uniform>\s*anchorSplash/);
  assert.match(ANCHOR_SPLASH_RENDER,/@vertex fn vs\(@builtin\(vertex_index\)/);
  assert.equal(ANCHOR_SPLASH_RING_VERTICES,24*6);assert.equal(ANCHOR_SPLASH_DROP_VERTICES,16*3);
});

test('a let-go anchor is compact state: her detail pass places the iron and runs the rode, the splash times itself',()=>{
  for(const modelId of ['nina','victory','pinta','santa-maria','oseberg','lusoria','flying-cloud','gipsy-moth-iv']){
    const boat={modelId,x:12,z:-40,length:modelId==='victory'?56.69:20,beam:6,heave:.4,heading:72,pitch:.1,roll:-.2};
    const state={installed:true,phase:'anchored',position:{x:9,y:-8,z:-37},worldHeading:23,rode:35,bed:-8,time:4,splash:{x:10,y:.2,z:-39,at:3.6}};
    const values=new Float32Array(VESSEL_DETAIL_STATE_FLOATS);
    writeVesselDetailState(values,{boat,anchor:state});assert.ok(values.every(Number.isFinite));
    assert.deepEqual(values.subarray(8,16),Float32Array.from([9,-8,-37,1,23*Math.PI/180,35,-8,anchorEyeOffset(boat)]));
    writeVesselDetailState(values,{boat,anchor:{...state,phase:'stowed'}});
    assert.equal(values[11],0,'a stowed anchor hangs at her cathead as built');
    const splash=new Float32Array(ANCHOR_SPLASH_FLOATS);
    assert.equal(writeAnchorSplashState(state,boat,splash),192);
    assert.deepEqual(splash,Float32Array.from([10,.2,-39,4-3.6,anchorEquipment(boat).renderScale,0,0,0]));
    assert.equal(writeAnchorSplashState({...state,time:4.5},boat,splash),144);
    assert.equal(writeAnchorSplashState({...state,time:5.3},boat,splash),0);
    assert.equal(writeAnchorSplashState({...state,phase:'stowed'},boat,splash),0);
  }
});

test('the splash uploads only its compact state and draws nothing once settled',async t=>{
  const prior=Object.getOwnPropertyDescriptor(globalThis,'GPUBufferUsage');
  Object.defineProperty(globalThis,'GPUBufferUsage',{configurable:true,value:{VERTEX:1,COPY_DST:2,UNIFORM:4,STORAGE:8}});
  t.after(()=>prior?Object.defineProperty(globalThis,'GPUBufferUsage',prior):delete globalThis.GPUBufferUsage);
  const writes=[],buffers=[],device={createBuffer(desc){const b={...desc,destroyed:false,destroy(){this.destroyed=true;}};buffers.push(b);return b;},
    queue:{writeBuffer(buffer,offset,data){writes.push({buffer,offset,data:data.slice()});}},
    async createRenderPipelineAsync(desc){return{...desc,getBindGroupLayout(){return{};}};},createBindGroup(desc){return desc;}};
  const renderer=await createAnchorSplashRenderer({device,shader:async source=>{assert.equal(source,ANCHOR_SPLASH_RENDER);return{};},shadows:{bind(){return{};}}});
  const boat={modelId:'nina',x:12,z:-40,length:20,beam:6,heave:.4,heading:72,pitch:.1,roll:-.2};
  const state={installed:true,phase:'stowed',position:{x:0,y:0,z:0},worldHeading:23,rode:35,bed:-8,time:4,splash:null};
  renderer.update(state,boat);renderer.update(state,{...boat,heading:110,pitch:.3});
  assert.equal(writes.length,0,'a stowed anchor uploads nothing');
  for(const phase of ['lowering','setting','anchored','weighing'])renderer.update({...state,phase,position:{x:9,y:-8,z:-37},splash:{x:10,y:.2,z:-39,at:3.6}},boat);
  assert.equal(writes.length,4);assert.ok(writes.every(w=>w.buffer.label==='anchor splash'&&w.data.length===ANCHOR_SPLASH_FLOATS));
  assert.ok(!buffers.some(b=>b.usage&GPUBufferUsage.VERTEX),'no geometry is uploaded');
  const draws=[],pass={setPipeline(){},setBindGroup(){},draw(...args){draws.push(args);}};
  renderer.draw(pass);assert.deepEqual(draws,[[192]]);
  renderer.update({...state,phase:'anchored',time:9,splash:{x:10,y:.2,z:-39,at:3.6}},boat);renderer.draw(pass);
  assert.equal(draws.length,1,'a settled splash draws nothing');
  renderer.destroy();assert.ok(buffers.every(b=>b.destroyed));
});

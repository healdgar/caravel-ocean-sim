// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createWaterOptics} from '../js/water-optics.js';
import {createSurfaceWetness,createWetnessData} from '../js/wetness.js';

function fakeDevice(){
  const pipelines=[],buffers=[],textures=[],groups=[];
  return {pipelines,buffers,textures,groups,
    queue:{writeBuffer(buffer,offset,data){
      const bytes=new Uint8Array(data.buffer,data.byteOffset,data.byteLength);
      buffer.bytes.set(bytes,offset);
    }},
    createBuffer(descriptor){const buffer={...descriptor,bytes:new Uint8Array(descriptor.size),destroyed:false,destroy(){this.destroyed=true;}};buffers.push(buffer);return buffer;},
    createTexture(descriptor){const texture={...descriptor,destroyed:false,createView(){return{texture:this};},destroy(){this.destroyed=true;}};textures.push(texture);return texture;},
    createBindGroup(descriptor){const group={...descriptor};groups.push(group);return group;},
    async createRenderPipelineAsync(descriptor){const pipeline={descriptor,getBindGroupLayout(index){return{pipeline:this,index};}};pipelines.push(pipeline);return pipeline;},
  };
}
const material=`struct Varyings {world:vec3f};
@vertex fn vs()->Varyings{return Varyings(vec3f(0));}
@fragment fn fs(v:Varyings)->@location(0) vec4f{return vec4f(v.world,1);}
@fragment fn otherFS(v:Varyings)->@location(0) vec4f{return vec4f(v.world,1);}`;
const vertex={buffers:[{arrayStride:12,attributes:[{shaderLocation:0,offset:0,format:'float32x3'}]}]};
const captureOptions=()=>({source:material,vertex:structuredClone(vertex)});

test('concurrent equivalent underwater materials share compilation but retain vessel bindings and current wave field',async()=>{
  const device=fakeDevice(),waves={views:[{id:0},{id:1}],uniform:{},current:0};
  let modules=0,release;
  const gate=new Promise(resolve=>{release=resolve;});
  const optics=createWaterOptics({device,seaView:{},seaSampler:{},surfaceWaves:waves,shader:async source=>{modules++;await gate;return{source};}});
  const first=optics.capture({...captureOptions(),pipeline:{surface:'player'}});
  const second=optics.capture({...captureOptions(),pipeline:{surface:'companion'}});
  assert.equal(modules,1,'concurrent requests must share the pending compilation');
  release();const [a,b]=await Promise.all([first,second]);
  assert.equal(a,b);assert.equal(device.pipelines.length,1);
  const hullA={},hullB={},groupA=a.bindGroup([{buffer:hullA}]),groupB=b.bindGroup([{buffer:hullB}]);
  assert.notEqual(groupA,groupB);
  assert.equal(groupA.entries[0].resource.buffer,hullA);
  assert.equal(groupB.entries[0].resource.buffer,hullB);
  const bound=[],pass={setPipeline(pipeline){assert.equal(pipeline,a.pipeline);},setBindGroup(index,group){bound.push([index,group]);}};
  a.bind(pass);const waveA=bound.find(([i])=>i===3)[1];
  bound.length=0;waves.current=1;b.bind(pass);const waveB=bound.find(([i])=>i===3)[1];
  assert.equal(waveA.entries.find(e=>e.binding===3).resource,waves.views[0]);
  assert.equal(waveB.entries.find(e=>e.binding===3).resource,waves.views[1]);
  assert.notEqual(waveA,waveB,'sharing must not freeze the ping-pong wave selection');
});

test('capture cache distinguishes shader semantics, vertex state, resource groups and factory ownership',async()=>{
  const device=fakeDevice(),shader=async source=>({source}),settings={device,shader,seaView:{},seaSampler:{}};
  const optics=createWaterOptics(settings),base=await optics.capture(captureOptions());
  const variations=[
    {source:material+'\n// different source'},
    {entry:'otherFS'},
    {world:'v.world+vec3f(1)'},
    {vertex:{...vertex,entryPoint:'otherVS'}},
    {vertex:{...vertex,constants:{example:1}}},
    {vertex:{buffers:[{...vertex.buffers[0],arrayStride:24}]}},
    {groups:2},
  ];
  for(const changed of variations){
    const variant=await optics.capture({...captureOptions(),...changed});
    assert.notEqual(variant.pipeline,base.pipeline,JSON.stringify(changed));
    assert.equal(await optics.capture({...captureOptions(),...changed}),variant,'repeat variants should reuse their own pipeline');
  }
  assert.equal(device.pipelines.length,1+variations.length);
  assert.notEqual((await createWaterOptics(settings).capture(captureOptions())).pipeline,base.pipeline,'a factory must not capture another scene\'s resources');
  assert.notEqual((await createWaterOptics({...settings,format:'rgba8unorm'}).capture(captureOptions())).pipeline,base.pipeline);
  assert.equal(device.pipelines.at(-1).descriptor.fragment.targets[0].format,'rgba8unorm');
});

test('rejected shader or pipeline creation evicts the pending capture and permits retry',async()=>{
  for(const failure of ['shader','pipeline']){
    const device=fakeDevice(),original=device.createRenderPipelineAsync.bind(device);let modules=0,attempts=0;
    device.createRenderPipelineAsync=async descriptor=>{attempts++;if(failure==='pipeline'&&attempts===1)throw Error('pipeline failed');return original(descriptor);};
    const optics=createWaterOptics({device,seaView:{},seaSampler:{},shader:async source=>{modules++;if(failure==='shader'&&modules===1)throw Error('shader failed');return{source};}});
    const results=await Promise.allSettled([optics.capture(captureOptions()),optics.capture(captureOptions())]);
    assert.ok(results.every(result=>result.status==='rejected'&&result.reason.message===failure+' failed'));
    const recovered=await optics.capture(captureOptions());
    assert.equal(await optics.capture(captureOptions()),recovered);
    assert.equal(modules,2,'the failed entry must be retried exactly once');
    assert.equal(device.pipelines.length,1);
  }
});

test('wetness reuses model probe generation while crew points, moisture and GPU lifetimes stay per vessel',async t=>{
  const savedBuffer=Object.getOwnPropertyDescriptor(globalThis,'GPUBufferUsage'),savedTexture=Object.getOwnPropertyDescriptor(globalThis,'GPUTextureUsage');
  Object.defineProperty(globalThis,'GPUBufferUsage',{configurable:true,value:{STORAGE:1,COPY_DST:2,COPY_SRC:4,UNIFORM:8}});
  Object.defineProperty(globalThis,'GPUTextureUsage',{configurable:true,value:{STORAGE_BINDING:1,TEXTURE_BINDING:2}});
  t.after(()=>{for(const[name,descriptor]of[['GPUBufferUsage',savedBuffer],['GPUTextureUsage',savedTexture]]){if(descriptor)Object.defineProperty(globalThis,name,descriptor);else delete globalThis[name];}});
  const mesh=new Float32Array([0,0,0,0,1,0,0,0,0,.3,0,0,0,1,0,0,0,0]),expected=createWetnessData(mesh);
  let samples=0;Object.defineProperty(mesh,'subarray',{value:function(...args){samples++;return Float32Array.prototype.subarray.apply(this,args);}});
  const device=fakeDevice(),computePipe=async()=>({getBindGroupLayout(){return{};}});
  const create=source=>createSurfaceWetness({device,mesh:source,hullUBO:{},frameUBO:{},computePipe});
  const a=await create(mesh),firstSamples=samples,b=await create(mesh);
  assert.ok(firstSamples>0);assert.equal(samples,firstSamples,'identical model mesh must not rebuild the probe template');
  for(const key of ['points','lookup','state'])assert.notEqual(a[key],b[key],key+' GPU buffers belong to one vessel');
  assert.deepEqual(new Float32Array(a.points.bytes.buffer),expected.points);
  assert.deepEqual(new Float32Array(b.points.bytes.buffer),expected.points);
  const company={crew:[{position:[2,3,4],scale:[1,1,1],visible:true}]},boat={length:12,beam:3.6,modelId:'nina'};
  a.updateCrew(company,boat);b.updateCrew({crew:[]},boat);
  const offset=a.crewOffset*8;
  assert.ok(new Float32Array(a.points.bytes.buffer).subarray(offset).some(v=>v!==0));
  assert.ok(new Float32Array(b.points.bytes.buffer).subarray(offset).every(v=>v===0),'crew upload must not inherit another vessel\'s mutable probe points');
  assert.deepEqual(createWetnessData(mesh).points,expected.points,'the pure generator stays fresh and independent');
  a.state.bytes[0]=73;assert.equal(b.state.bytes[0],0,'GPU moisture remains independent');
  a.destroy();assert.ok(a.points.destroyed&&a.lookup.destroyed&&a.state.destroyed);
  assert.ok(!b.points.destroyed&&!b.lookup.destroyed&&!b.state.destroyed,'destroy must not invalidate another vessel');
  b.updateCrew(company,boat);
  const clone=new Float32Array(mesh);let cloneSamples=0;
  Object.defineProperty(clone,'subarray',{value:function(...args){cloneSamples++;return Float32Array.prototype.subarray.apply(this,args);}});
  const c=await create(clone);assert.ok(cloneSamples>0,'a distinct mesh generates its own template');
  assert.notEqual(c.points,b.points,'a distinct mesh receives independent resources');
  b.destroy();c.destroy();
});

// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createVolumetricClouds} from '../js/clouds.js';
import {CLOUD_CAMERA_RAYS,CLOUD_RESOLVE} from '../js/wgsl/clouds.js';

function cloudDepthDevice(t){
  for(const [name,value] of Object.entries({GPUTextureUsage:{TEXTURE_BINDING:1,STORAGE_BINDING:2,COPY_SRC:4},GPUBufferUsage:{UNIFORM:1,COPY_DST:2}})){
    const prior=Object.getOwnPropertyDescriptor(globalThis,name);
    Object.defineProperty(globalThis,name,{configurable:true,value});
    t.after(()=>prior?Object.defineProperty(globalThis,name,prior):delete globalThis[name]);
  }
  const textures=[],buffers=[],groups=[],dispatches=[];
  const device={queue:{writeBuffer(){}},
    createBuffer(descriptor){const buffer={...descriptor,destroyed:false,destroy(){this.destroyed=true;}};buffers.push(buffer);return buffer;},
    createTexture(descriptor){const texture={...descriptor,destroyed:false,createView(){return {texture};},destroy(){this.destroyed=true;}};textures.push(texture);return texture;},
    createSampler(descriptor){return descriptor;},
    createBindGroup(descriptor){groups.push(descriptor);return descriptor;},
  };
  const computePipe=async(source,label)=>({source,label,getBindGroupLayout(index){return {label,index};}});
  let pipeline;const bindings=new Map();
  const pass={setPipeline(value){pipeline=value;},setBindGroup(index,value){bindings.set(index,value);},
    dispatchWorkgroups(...size){dispatches.push({pipeline,size,bindings:new Map(bindings)});}};
  return {device,computePipe,pass,textures,buffers,groups,dispatches};
}
const cloudDepthTexture=(dispatch,binding)=>dispatch.bindings.get(0).entries.find(entry=>entry.binding===binding)?.resource.texture;

test('ray depth and temporal history share two alternating textures without a resolve write',async t=>{
  const gpu=cloudDepthDevice(t),clouds=await createVolumetricClouds({...gpu,frameUBO:{},transView:{},skyView:{},sampler:{},fieldSize:[8,4,8]});
  const frame=new Float32Array(132);frame[0]=frame[5]=frame[10]=frame[15]=1;frame[32]=.6;frame[33]=.8;frame[36]=64;frame[37]=48;
  const settings={clouds:.8,cloudQuality:.5,haze:3};
  let previousDepth,previousColor;
  for(let step=0;step<4;step++){
    frame[70]=step;clouds.update(frame,settings,1/60);gpu.dispatches.length=0;clouds.encode(gpu.pass);
    const ray=gpu.dispatches.find(d=>d.pipeline.label==='cloud rays'),resolve=gpu.dispatches.find(d=>d.pipeline.label==='cloud resolve');
    assert.ok(ray&&resolve);assert.ok(gpu.dispatches.indexOf(ray)<gpu.dispatches.indexOf(resolve));
    const currentDepth=cloudDepthTexture(ray,5),historyDepth=cloudDepthTexture(resolve,4);
    assert.equal(cloudDepthTexture(resolve,2),currentDepth,'resolve consumes the depth written by this ray dispatch');
    assert.notEqual(historyDepth,currentDepth,'previous depth cannot alias the new ray output');
    assert.equal(cloudDepthTexture(resolve,6),clouds.output,'colour and depth advance in the same history slot');
    assert.equal(resolve.bindings.get(0).entries.some(entry=>entry.binding===7),false,'resolve has no depth output binding');
    assert.deepEqual(ray.size,[4,3]);assert.deepEqual(resolve.size,ray.size);
    if(step){assert.equal(historyDepth,previousDepth);assert.equal(cloudDepthTexture(resolve,3),previousColor);}
    previousDepth=currentDepth;previousColor=clouds.output;
  }
  const depths=gpu.textures.filter(texture=>texture.format==='r32float');
  assert.deepEqual(depths.map(texture=>texture.label).sort(),['cloud depth A','cloud depth B']);
  assert.match(CLOUD_CAMERA_RAYS,/textureStore\(depthOut,vec2i\(id.xy\),vec4f\(ray.distance\)\)/);
  assert.doesNotMatch(CLOUD_RESOLVE,/texture_storage_2d<r32float|textureStore\(depthOut/);
  clouds.destroy();assert.ok(gpu.textures.every(texture=>texture.destroyed));assert.ok(gpu.buffers.every(buffer=>buffer.destroyed));
});

test('cloud history resize replaces both depth slots and stable frames reuse bind groups',async t=>{
  const gpu=cloudDepthDevice(t),clouds=await createVolumetricClouds({...gpu,frameUBO:{},transView:{},skyView:{},sampler:{},fieldSize:[8,4,8]});
  const frame=new Float32Array(132);frame[36]=64;frame[37]=48;frame[33]=1;
  const settings={clouds:.8,cloudQuality:.5,haze:3};
  clouds.update(frame,settings,0);clouds.encode(gpu.pass);
  const textureCount=gpu.textures.length,groupCount=gpu.groups.length,oldDepths=gpu.textures.filter(texture=>texture.format==='r32float');
  clouds.update(frame,settings,0);assert.equal(clouds.historyValid,true);clouds.encode(gpu.pass);
  assert.equal(gpu.textures.length,textureCount);assert.equal(gpu.groups.length,groupCount);
  frame[36]=128;clouds.update(frame,settings,0);assert.equal(clouds.historyValid,false);gpu.dispatches.length=0;clouds.encode(gpu.pass);
  assert.ok(oldDepths.every(texture=>texture.destroyed));
  const ray=gpu.dispatches.find(d=>d.pipeline.label==='cloud rays'),resolve=gpu.dispatches.find(d=>d.pipeline.label==='cloud resolve');
  const depth=cloudDepthTexture(ray,5);assert.deepEqual(depth.size,[64,24]);assert.equal(cloudDepthTexture(resolve,2),depth);
  assert.ok(!oldDepths.includes(depth));assert.ok(!oldDepths.includes(cloudDepthTexture(resolve,4)));
  assert.equal(gpu.textures.filter(texture=>texture.format==='r32float'&&!texture.destroyed).length,2);
  clouds.destroy();assert.ok(gpu.textures.every(texture=>texture.destroyed));
});

// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The land's detail does not depend on the port, so one bake serves every terrain on a device.
import {test} from 'node:test';
import assert from 'node:assert/strict';

globalThis.GPUTextureUsage??={TEXTURE_BINDING:4,STORAGE_BINDING:8,COPY_SRC:1,COPY_DST:2};
globalThis.GPUBufferUsage??={STORAGE:128,COPY_DST:8};
const {sharedGroundDetail}=await import('../js/ground-detail.js');

// A device that only counts what is asked of it.
function countingDevice(){
  const counts={textures:0,buffers:0,submits:0,uploads:0,destroyed:0};
  const pass={setPipeline(){},setBindGroup(){},dispatchWorkgroups(){},end(){}};
  const device={
    createTexture(){counts.textures++;return {createView:()=>({}),destroy(){counts.destroyed++;}};},
    createBuffer(){counts.buffers++;return {destroy(){counts.destroyed++;}};},
    createCommandEncoder:()=>({beginComputePass:()=>pass,finish:()=>({})}),
    createBindGroup:()=>({}),createSampler:()=>({}),
    queue:{submit(){counts.submits++;},writeBuffer(){counts.uploads++;},writeTexture(){}},
  };
  return {device,counts};
}
const pipe={getBindGroupLayout:()=>({})};

test('a second terrain takes the first one\'s ground detail and bakes nothing',async()=>{
  const {device,counts}=countingDevice();let pipelines=0;
  const options={device,computePipe:async()=>{pipelines++;return pipe;},mipPipe:pipe};
  const first=await sharedGroundDetail(options),once={...counts};
  assert.deepEqual([once.textures,once.buffers,once.submits,once.uploads,pipelines],[1,1,1,1,1]);
  // The first terrain is left behind before the next landfall.
  first.dispose();
  assert.equal(counts.destroyed,0,'leaving one port keeps the detail for the next');
  const second=await sharedGroundDetail(options);
  assert.equal(second.texture,first.texture);assert.equal(second.archBuffer,first.archBuffer);
  assert.deepEqual(second.resources.map(([binding])=>binding),[16,17,18]);
  assert.deepEqual({...counts},once,'nothing is created, uploaded or baked again');assert.equal(pipelines,1);
});

test('each device has its own ground detail, and a failed bake is tried again',async()=>{
  const a=countingDevice(),b=countingDevice();
  const [detailA,detailB]=await Promise.all([a,b].map(({device})=>sharedGroundDetail({device,computePipe:async()=>pipe,mipPipe:pipe})));
  assert.notEqual(detailA.texture,detailB.texture);assert.equal(a.counts.textures,1);assert.equal(b.counts.textures,1);
  const c=countingDevice();let attempts=0;
  const failing={device:c.device,computePipe:async()=>{if(!attempts++)throw Error('shader lost');return pipe;},mipPipe:pipe};
  await assert.rejects(sharedGroundDetail(failing),/shader lost/);
  await new Promise(resolve=>setTimeout(resolve,0));
  assert.ok((await sharedGroundDetail(failing)).texture,'the next terrain bakes afresh');assert.equal(attempts,2);
});

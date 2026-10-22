// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {createGunneryTools,GUNNERY_TOOL_RENDER} from '../js/gunnery-tools.js';
import {createGunDefinitions} from '../js/gunnery-models.js';
import {requirePlayableShipModel} from '../js/ship-models.js';

function assertGPUToolRuntime(source){
  const renderer=source.slice(source.indexOf('export async function createGunneryTools'));
  assert.ok(renderer.length>500);assert.doesNotMatch(renderer,/buildGunneryToolVertices\s*\(/,'runtime cannot call the offline CPU tessellator');
  const update=renderer.slice(renderer.indexOf('update(company'),renderer.indexOf('draw(pass)'));
  assert.ok(update.length>100);assert.doesNotMatch(update,/writeBuffer\s*\(\s*vertex\s*,/,'runtime cannot upload animated triangle vertices');assert.match(update,/writeGunneryToolInstances\s*\(/,'live updates contain only compact tool endpoint commands');
}

test('gunnery tools cannot restore a CPU triangle-animation backend',()=>{
  const source=readFileSync(new URL('../js/gunnery-tools.js',import.meta.url),'utf8');assertGPUToolRuntime(source);
  assert.throws(()=>assertGPUToolRuntime(source.replace('writeGunneryToolInstances(company,boat,instances)','buildGunneryToolVertices(company,boat,vertices)')),/CPU tessellator|compact tool/);
});

function assertGPUAnchorRuntime(source){
  const renderer=source.slice(source.indexOf('export async function createAnchorRenderer')),update=renderer.slice(renderer.indexOf('update(state,boat)'),renderer.indexOf('drawSubmerged(pass)'));
  assert.ok(update.length>200);assert.match(renderer,/shader\(ANCHOR_GPU_RENDER/,'anchor draws must use the GPU expansion shader');assert.match(update,/writeAnchorGPUState\(/,'anchor updates contain physical commands');
  assert.doesNotMatch(update,/\b(?:triangle|tube)\s*\(|vertices\.set\s*\(/,'anchor updates must not tessellate geometry on CPU');assert.doesNotMatch(update,/writeBuffer\(\s*buffer\s*,/,'anchor updates must not upload animated vertices');
}

test('anchor updates cannot restore per-frame CPU tessellation or dynamic triangle uploads',()=>{
  const source=readFileSync(new URL('../js/anchor.js',import.meta.url),'utf8');assertGPUAnchorRuntime(source);
  assert.throws(()=>assertGPUAnchorRuntime(source.replace('writeAnchorGPUState(state,boat,values)','triangle(a,b,c,0)')),/physical commands|tessellate/);
  assert.throws(()=>assertGPUAnchorRuntime(source.replace('device.queue.writeBuffer(stateBuffer,0,values)','device.queue.writeBuffer(buffer,0,vertices)')),/animated vertices/);
});

test('actual gunnery renderer uploads immutable templates once and shares only compact endpoints across all draw paths',async t=>{
  const prior=Object.getOwnPropertyDescriptor(globalThis,'GPUBufferUsage');Object.defineProperty(globalThis,'GPUBufferUsage',{configurable:true,value:{VERTEX:1,COPY_DST:2,UNIFORM:4,STORAGE:8}});t.after(()=>prior?Object.defineProperty(globalThis,'GPUBufferUsage',prior):delete globalThis.GPUBufferUsage);
  const buffers=[],writes=[],groups=[],captures=[];
  const pipeline=label=>({label,getBindGroupLayout(){return {};}}),device={createBuffer(d){const b={...d,destroy(){}};buffers.push(b);return b;},createRenderPipelineAsync:async d=>pipeline(d.label),createBindGroup(d){groups.push(d);return d;},queue:{writeBuffer(buffer,offset,data,start=0,count){const unit=data.BYTES_PER_ELEMENT??1;writes.push({buffer,offset,bytes:count===undefined?data.byteLength-start*unit:count*unit});}}};
  const submergedPipeline=pipeline('submerged gun tools'),renderer=await createGunneryTools({device,shader:async source=>({source}),shadows:{uniform:{},bind(){return {};},},format:'rgba16float',samples:1,waterOptics:{async capture(options){captures.push(options);return {pipeline:submergedPipeline,bind(){},bindGroup(resources){return {resources};}};}}});
  try{
    const model=requirePlayableShipModel('victory'),boat={modelId:model.id,model,...model.runtime,heading:32,pitch:.1,roll:-.2,x:15,z:-8,heave:.4},gun={...createGunDefinitions('victory').find(g=>g.kind==='long-gun'),stage:'swab',progress:.125,offset:.5},company={crew:[{intent:'work',position:[-2,5,1],job:{kind:'gunnery',stage:'working',gunRole:'loader',gun}}]};
    const template=buffers.find(b=>b.label==='immutable crew gun tool tubes'),endpoints=buffers.find(b=>b.label==='crew gun tool endpoints');assert.ok(template&&endpoints);assert.equal(writes.filter(w=>w.buffer===template).length,1);assert.ok(endpoints.usage&GPUBufferUsage.STORAGE);
    writes.length=0;renderer.update(company,boat,true);gun.progress=.875;renderer.update(company,boat,true);assert.ok(writes.length>=4);assert.ok(writes.every(w=>w.buffer!==template&&w.bytes<=64),'two live tubes plus a 64-byte rigid transform do not upload triangles');
    const draws=[],pass={setPipeline(p){this.pipeline=p;},setBindGroup(i,g){this.groups??=[];this.groups[i]=g;},setVertexBuffer(i,b){this.vertices??=[];this.vertices[i]=b;},draw(vertices,instances=1,first=0,firstInstance=0){draws.push({pipeline:this.pipeline,groups:this.groups.slice(),vertices:this.vertices.slice(),count:vertices,instances,first,firstInstance});}};
    renderer.draw(pass);renderer.drawShadow(pass);renderer.drawSubmerged(pass);assert.equal(draws.length,3);assert.ok(draws.every(d=>d.vertices[0]===template&&d.instances===2&&d.count===72));
    const main=draws[0].groups[0].entries.find(e=>e.binding===7).resource.buffer,shadow=draws[1].groups[0].entries.find(e=>e.binding===2).resource.buffer,submerged=draws[2].groups[0].resources[7].buffer;
    assert.equal(main,endpoints);assert.equal(shadow,endpoints);assert.equal(submerged,endpoints);assert.equal(captures[0].source,GUNNERY_TOOL_RENDER,'submerged capture runs the same GPU endpoint expansion');
    draws.length=0;renderer.update(company,boat,false);renderer.draw(pass);renderer.drawShadow(pass);renderer.drawSubmerged(pass);assert.deepEqual(draws,[],'hidden tools emit no stale instances');
  }finally{renderer.destroy();}
});

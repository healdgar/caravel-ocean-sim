// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createGPUProgramCache} from '../js/gpu-program-cache.js';
function fixture(){
  const created=[],pipelines=[],device={createShaderModule(descriptor){const module={...descriptor,getCompilationInfo:async()=>({messages:[]})};created.push(module);return module;},async createComputePipelineAsync(descriptor){const pipeline={...descriptor};pipelines.push(pipeline);return pipeline;}};
  return {device,created,pipelines};
}
test('concurrent identical programs coalesce after rewriting, with device and source isolation',async()=>{
  const f=fixture();let fleet=2;const cache=createGPUProgramCache({device:f.device,prepare:code=>code+' fleet '+fleet});
  const a=cache.shader('source','first'),b=cache.shader('source','other label');assert.equal(a,b);assert.equal(await a,await b);assert.equal(f.created.length,1);
  const pipes=await Promise.all([cache.computePipe('source','one'),cache.computePipe('source','two')]);assert.equal(pipes[0],pipes[1]);assert.equal(f.created.length,1);assert.equal(f.pipelines.length,1);
  assert.equal(f.pipelines[0].layout,'auto');assert.equal(f.pipelines[0].compute.entryPoint,'main');
  fleet=3;assert.notEqual(await cache.shader('source','new fleet'),await a);assert.notEqual(await cache.computePipe('source','new fleet'),pipes[0]);
  assert.notEqual(await cache.shader('other source','different'),await a);
  const other=fixture();assert.notEqual(await createGPUProgramCache({device:other.device}).shader('source','other device'),await a);
});
test('failed compilation, diagnostics and pipelines evict rejected promises and permit retry',async()=>{
  for(const failure of ['module','diagnostic','pipeline']){
    const f=fixture(),make=f.device.createShaderModule.bind(f.device),pipe=f.device.createComputePipelineAsync.bind(f.device);let attempts=0;
    f.device.createShaderModule=descriptor=>{if(failure==='module'&&attempts++===0)throw Error('module failed');const module=make(descriptor);if(failure==='diagnostic'&&attempts++===0)module.getCompilationInfo=async()=>({messages:[{type:'error',message:'invalid'}]});return module;};
    f.device.createComputePipelineAsync=descriptor=>failure==='pipeline'&&attempts++===0?Promise.reject(Error('pipeline failed')):pipe(descriptor);
    const reported=[],cache=createGPUProgramCache({device:f.device,report:messages=>reported.push(messages)});
    await assert.rejects(cache.computePipe('source','test'),failure==='diagnostic'?/Shader compile error/:/failed/);
    const value=await cache.computePipe('source','retry');assert.equal(value,await cache.computePipe('source','repeat'));assert.equal(f.pipelines.length,1);
    if(failure==='diagnostic')assert.equal(reported[0][0].message,'invalid');
    if(failure==='pipeline')assert.equal(f.created.length,1,'a pipeline failure must retain its valid shader');
  }
});

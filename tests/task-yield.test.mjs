// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createTaskYieldBudget,yieldCooperativeTask} from '../js/task-yield.js';

async function withGlobals(values,run){
  const prior=Object.fromEntries(Object.keys(values).map(key=>[key,Object.getOwnPropertyDescriptor(globalThis,key)]));
  try{for(const [key,value]of Object.entries(values))Object.defineProperty(globalThis,key,{value,writable:true,configurable:true});return await run();}
  finally{for(const [key,descriptor]of Object.entries(prior))if(descriptor)Object.defineProperty(globalThis,key,descriptor);else delete globalThis[key];}
}
test('cooperative budget processes small batches without idle waits and resets after yielding',async()=>{
  let time=0,calls=0,release;
  const pauseIfNeeded=createTaskYieldBudget({budgetMs:8,now:()=>time,yieldTask:()=>{calls++;return new Promise(resolve=>release=resolve);}});
  for(let i=0;i<27000;i++)assert.equal(pauseIfNeeded(),null);
  assert.equal(calls,0);time=7.99;assert.equal(pauseIfNeeded(),null);time=8;
  const pause=pauseIfNeeded();assert.equal(calls,1);time=1000;release();await pause;
  time=1007.99;assert.equal(pauseIfNeeded(),null);time=1008;
  const next=pauseIfNeeded();assert.equal(calls,2);release();await next;
  const failed=createTaskYieldBudget({now:()=>time,yieldTask:()=>Promise.reject(Error('yield failed'))});time+=8;
  await assert.rejects(failed(),/yield failed/);
});
test('browser without scheduler yields a real task without a clamped timer and closes both ports',async()=>{
  const NativeChannel=globalThis.MessageChannel;let closed=0,complete=false;
  class TrackedChannel extends NativeChannel{
    constructor(){super();for(const port of [this.port1,this.port2]){const close=port.close.bind(port);port.close=()=>{closed++;close();};}}
  }
  await withGlobals({scheduler:undefined,MessageChannel:TrackedChannel,setTimeout:()=>{throw Error('unexpected timer fallback');}},async()=>{
    const pending=yieldCooperativeTask().then(()=>{complete=true;});await Promise.resolve();
    assert.equal(complete,false,'a microtask must not masquerade as a browser task');await pending;
    assert.equal(complete,true);assert.equal(closed,2);
  });
});
test('native scheduler is preferred; legacy timer is only a last fallback',async()=>{
  const scheduler={calls:0,yield(){this.calls++;return Promise.resolve();}};
  await withGlobals({scheduler,MessageChannel:class{constructor(){throw Error('unexpected channel');}}},()=>yieldCooperativeTask());
  assert.equal(scheduler.calls,1);let timers=0;
  await withGlobals({scheduler:undefined,MessageChannel:undefined,setTimeout:(resolve,ms)=>{timers++;assert.equal(ms,0);queueMicrotask(resolve);}},()=>yieldCooperativeTask());
  assert.equal(timers,1);
});
test('message failures reject and release both task ports',async()=>{
  for(const failSend of [true,false]){
    let closed=0;class BrokenChannel{constructor(){this.port1={close(){closed++;}};this.port2={close(){closed++;},postMessage:()=>{if(failSend)throw Error('send failed');queueMicrotask(()=>this.port1.onmessageerror());}};}}
    await withGlobals({scheduler:undefined,MessageChannel:BrokenChannel},()=>assert.rejects(yieldCooperativeTask(),failSend?/send failed/:/message failed/));
    assert.equal(closed,2);
  }
});

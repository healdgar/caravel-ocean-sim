// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createDeferredMarineLife} from '../js/marine-loader.js';

const boat={x:0,z:0,heading:0,length:20,beam:6};
const deferred=()=>{let resolve,reject;const promise=new Promise((a,b)=>{resolve=a;reject=b;});return {promise,resolve,reject};};
function rendererFor(state){return {state,update:(...args)=>state.step(...args),encode(){},draw(){},drawSubmerged(){},destroy(){this.destroyed=true;}};}

test('marine assets stay unloaded until needed and slow loading preserves the full encounter',async()=>{
  const gate=deferred();let calls=0,renderer;
  const marine=createDeferredMarineLife({random:()=>.4},async options=>{calls++;renderer=rendererFor(options.state);await gate.promise;return renderer;});
  for(let i=0;i<100;i++)marine.update(.1,boat,{});
  assert.equal(calls,0);assert.ok(Math.abs(marine.state.time-10)<1e-9);
  assert.equal(marine.state.trigger('whale',boat,{behavior:'breach'}),true);
  const pending=marine.load();assert.equal(marine.state.loading,true);
  await Promise.resolve();assert.equal(calls,1);
  for(let i=0;i<100;i++)marine.update(.1,boat,{});
  assert.equal(marine.state.age,0,'breach clock is frozen while the model is unavailable');
  marine.encode({});marine.draw({});marine.drawSubmerged({});
  gate.resolve();await pending;
  assert.equal(marine.state.loading,false);assert.equal(renderer.state,marine.state);
  marine.update(.1,boat,{});assert.equal(marine.state.age,.1);
  await marine.load();assert.equal(calls,1,'later sightings reuse the renderer');
  marine.destroy();assert.equal(renderer.destroyed,true);
});

test('natural sightings request their assets and preserve their initial pose',async()=>{
  const gate=deferred();let calls=0;
  const marine=createDeferredMarineLife({random:()=>0},async options=>{calls++;await gate.promise;return rendererFor(options.state);});
  for(let i=0;i<9100&&!marine.state.active;i++)marine.update(.1,boat,{});
  await Promise.resolve();assert.equal(calls,1);assert.equal(marine.state.active,true);
  assert.equal(marine.state.age,0);assert.equal(marine.state.loading,true);
  const pending=marine.load();gate.resolve();await pending;marine.destroy();
});

test('a failed optional model does not disable sailing or prevent an explicit retry',async()=>{
  let calls=0;
  const marine=createDeferredMarineLife({random:()=>.4},async options=>{
    if(++calls===1)throw Error('Whale download failed');return rendererFor(options.state);
  });
  marine.state.trigger('whale',boat);
  await assert.rejects(marine.load(),/download failed/);
  assert.equal(marine.state.active,false);assert.equal(marine.state.loading,false);
  assert.match(marine.state.loadError,/download failed/);
  assert.equal(marine.state.trigger('shark',boat),true);await marine.load();
  assert.equal(marine.state.loadError,null);assert.equal(calls,2);
  marine.update(.1,boat,{});assert.equal(marine.state.active,true);marine.destroy();
});

test('cancel and disposal during loading cannot resurrect an encounter or leak its renderer',async()=>{
  for(const destroy of [false,true]){
    const gate=deferred();let renderer;
    const marine=createDeferredMarineLife({random:()=>.4},async options=>{renderer=rendererFor(options.state);await gate.promise;return renderer;});
    marine.state.trigger('whale',boat);const pending=marine.load();await Promise.resolve();
    if(destroy)marine.destroy();else marine.state.clear();
    gate.resolve();await pending;marine.update(.1,boat,{});
    assert.equal(marine.state.active,false);assert.equal(!!renderer.destroyed,destroy);
    if(!destroy)marine.destroy();else await assert.rejects(marine.load(),/destroyed/);
  }
});

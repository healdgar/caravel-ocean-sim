import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createGunportSafetyState} from '../js/gunport-safety.js';

test('a gunport needs a recent dry sample of the current muzzle and sea revision',()=>{
  const state=createGunportSafetyState(),gun={id:0,diameter:.2},pose={position:[1,2,3]};
  assert.equal(state.block(gun,pose,1),'Checking sea at gunports');
  state.accept(0,{position:pose.position,height:1,time:1,revision:5});
  assert.equal(state.block(gun,pose,1.1,5),null);
  assert.equal(state.block(gun,pose,1.31,5),'Checking sea at gunports');
  assert.equal(state.block(gun,pose,.9,5),'Checking sea at gunports');
  assert.equal(state.block(gun,pose,1.1,6),'Checking sea at gunports');
  assert.equal(state.block(gun,{position:[1.51,2,3]},1.1,5),'Checking sea at gunports');
  state.accept(0,{position:pose.position,height:1.85,time:1.2,revision:5});
  assert.equal(state.block(gun,pose,1.2,5),'Gunports awash');
  // The newly posed muzzle can dip before the next sea readback returns.
  state.accept(0,{position:pose.position,height:1.5,time:1.3,revision:5});
  assert.equal(state.block(gun,{position:[1,1.65,3]},1.3,5),'Gunports awash');
});
test('gunport samples reject invalid/stale data, isolate gun ids and invalidate on clear',()=>{
  const state=createGunportSafetyState(),pose={position:[0,2,0]};
  for(const data of[{position:[NaN,2,0],height:0,time:0},{position:[],height:0,time:0},{position:[0,2,0],height:NaN,time:0}])assert.equal(state.accept(0,data),false);
  assert.equal(state.accept(128,{position:pose.position,height:0,time:0}),false);
  state.accept(0,{position:pose.position,height:2,time:5});
  assert.equal(state.accept(0,{position:pose.position,height:0,time:4}),false);
  state.accept(1,{position:pose.position,height:0,time:5});
  assert.equal(state.block({id:0,diameter:.2},pose,5),'Gunports awash');
  assert.equal(state.block({id:1,diameter:.2},pose,5),null);
  assert.equal(state.accept(0,{position:pose.position,height:0,time:1,revision:1}),true);
  assert.equal(state.block({id:0,diameter:.2},pose,1,1),null);
  state.clear();assert.equal(state.size,0);assert.equal(state.block({id:1},pose,5),'Checking sea at gunports');
});

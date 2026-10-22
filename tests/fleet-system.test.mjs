// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {MAX_FOLLOWERS,readyFleetModels,fleetFromSearch,fleetToSearch,fleetFormation,fleetModelCode,fleetViewBounds,validateFleetDevice} from '../js/fleet.js';
import {copyVessel} from '../js/vessels.js';
import {getShipModel} from '../js/ship-models.js';
import {createFollower,steerFollower} from '../js/follower.js';
import {withPooledFleetWakes} from '../js/wgsl/fleet-wakes.js';
import {withFleetHullCount,SCENE_HEIGHT_PROBE,createOpticalOcean} from '../js/wgsl/ocean.js';
import {SCENE_FOAM_UPDATE} from '../js/wgsl/sim.js';
import {COASTAL_WATER} from '../js/wgsl/terrain.js';
import {withSceneShadowCount,SCENE_SHADOW_SAMPLE} from '../js/wgsl/shadows.js';

const source={modelId:'nina',length:20,beam:6,eye:3.9,heading:118,x:0,z:0,provisionDays:30,cargoTonnes:0,sailFore:1,sailMain:1,sailMizzen:1};

test('fleet query preserves legacy escort defaults and independently selected disabled rows',()=>{
  assert.deepEqual(fleetFromSearch(new URLSearchParams(),'victory'),[{id:'escort-1',modelId:'victory',enabled:true}]);
  assert.equal(fleetFromSearch(new URLSearchParams('follower=0'),'nina')[0].enabled,false);
  const entries=fleetFromSearch(new URLSearchParams('fleet=nina,victory,!nina&follower=0'));
  assert.deepEqual(entries.map(({modelId,enabled})=>[modelId,enabled]),[['nina',true],['victory',true],['nina',false]]);
  assert.equal(fleetToSearch(entries),'nina,victory,!nina');
  assert.deepEqual(fleetFromSearch(new URLSearchParams('fleet=')),[]);
  assert.equal(fleetFromSearch(new URLSearchParams('fleet='+Array(8).fill('nina').join(','))).length,8);
  assert.throws(()=>fleetFromSearch(new URLSearchParams('fleet='+Array(9).fill('nina').join(','))),/at most/);
  assert.throws(()=>fleetFromSearch(new URLSearchParams('fleet=not-a-ship')),/Unknown/);
  assert.throws(()=>fleetToSearch(Array(9).fill({modelId:'nina'})),/Invalid/);
});

test('ready fleet selection uses registry identities and explicit GPU backend codes',()=>{
  const models=readyFleetModels();assert.ok(models.some(m=>m.id==='nina'));assert.ok(models.some(m=>m.id==='victory'));
  for(const model of models)assert.equal(model.status,'ready');
  assert.equal(fleetModelCode(getShipModel('nina')),0);assert.equal(fleetModelCode(getShipModel('victory')),1);
  assert.equal(fleetModelCode({id:'future',modelCode:7}),7);
  assert.throws(()=>fleetModelCode({id:'future'}),/Missing/);
});

test('mixed fleet copies use their own model dimensions and independent physical state',()=>{
  const nina=copyVessel(source,{id:'nina',distance:0,side:0}),victory=copyVessel(nina,{id:'victory',modelId:'victory'});
  assert.equal(victory.modelId,'victory');assert.equal(victory.model,getShipModel('victory'));
  assert.equal(victory.length,victory.model.runtime.length);assert.equal(victory.beam,victory.model.runtime.beam);
  assert.equal(victory.hydrodynamics.modelCode,1);assert.notEqual(victory.target,nina.target);
  assert.notEqual(victory.hydrodynamics,nina.hydrodynamics);assert.equal(nina.length,source.length);
});

test('all eight formation stations differ and neighbor avoidance commands only the helm and canvas',()=>{
  const stations=Array.from({length:MAX_FOLLOWERS},(_,i)=>fleetFormation(i));
  assert.deepEqual(stations[0],{trail:2.8,side:1.5});assert.equal(new Set(stations.map(s=>s.trail+'/'+s.side)).size,8);
  const leader=copyVessel(source,{distance:0,side:0}),boat=copyVessel(leader),neighbor=copyVessel(leader);
  neighbor.x=boat.x+.1;neighbor.z=boat.z+.2;boat.surgeVelocity=1;boat.leewayVelocity=.1;
  const before=[boat.x,boat.z,boat.heading,boat.surgeVelocity,boat.leewayVelocity,boat.yawRate];
  steerFollower(createFollower(stations[3]),boat,leader,.1,7,118*Math.PI/180,[leader,boat,neighbor]);
  assert.deepEqual([boat.x,boat.z,boat.heading,boat.surgeVelocity,boat.leewayVelocity,boat.yawRate],before);
  assert.ok(Math.abs(boat.rudderTarget)<=35);
});

test('formation guidance follows ground track and compensates actual follower leeway',()=>{
  const leader=copyVessel({...source,heading:90},{distance:0,side:0});leader.surgeVelocity=2;leader.leewayVelocity=1;
  const boat=copyVessel(leader),state=createFollower();boat.surgeVelocity=2;boat.leewayVelocity=1;
  steerFollower(state,boat,leader,.1,7,0);
  assert.ok(Math.abs(state.stationVelocityX-2)<1e-12);assert.ok(Math.abs(state.stationVelocityZ-1)<1e-12);
  assert.ok(Math.abs(state.trackCourse-Math.atan2(2,-1)*180/Math.PI)<1e-10,'track includes the real sideways motion');
  assert.ok(Math.abs(state.course-90)<1e-10,'equal leeway needs equal bow heading at station');
  assert.ok(Math.abs(boat.rudderTarget)<1e-9,'leeway alone must not make the escort turn away');
});

test('formation station feedforward includes the leader rotating its real offset',()=>{
  const leader=copyVessel({...source,heading:0},{distance:0,side:0});leader.surgeVelocity=2;leader.leewayVelocity=.5;leader.yawRate=.02;
  const boat=copyVessel(leader),state=createFollower();boat.surgeVelocity=2;boat.leewayVelocity=.5;
  steerFollower(state,boat,leader,.1,7,0);
  assert.ok(Math.abs(state.stationVelocityX-(.5-.02*leader.length*2.8))<1e-12);
  assert.ok(Math.abs(state.stationVelocityZ-(-2+.02*leader.length*1.5))<1e-12);
});

test('same-model positive sail drive demonstrates a close-hauled course without changing forces',()=>{
  const leader=copyVessel({...source,heading:50},{distance:0,side:0});leader.surgeVelocity=1.1;leader.sailState={forward:100};
  const boat=copyVessel(leader),state=createFollower();boat.surgeVelocity=1.1;
  steerFollower(state,boat,leader,.1,7,Math.PI/2);assert.ok(Math.abs(state.noGoAngle-50)<1e-10);
  assert.equal(leader.sailState.forward,100);assert.equal(boat.surgeVelocity,1.1);
  leader.sailState.forward=-1;steerFollower(state,boat,leader,.1,7,Math.PI/2);assert.equal(state.noGoAngle,62);
  leader.sailState.forward=100;const other=copyVessel(leader,{modelId:'victory'}),otherState=createFollower();other.surgeVelocity=1.1;
  steerFollower(otherState,other,leader,.1,7,Math.PI/2);assert.equal(otherState.noGoAngle,62,'different hulls cannot inherit a demonstrated close-hauled limit');
});

test('weather-helm integral trim is bounded and writes no physical motion',()=>{
  const leader=copyVessel({...source,heading:105},{distance:0,side:0});leader.surgeVelocity=1.5;
  const boat=copyVessel(leader),state=createFollower();boat.heading=100;boat.surgeVelocity=1.5;
  const before=[boat.x,boat.z,boat.heading,boat.surgeVelocity,boat.leewayVelocity,boat.yawRate];
  for(let i=0;i<60;i++)steerFollower(state,boat,leader,.1,7,0);
  assert.ok(state.helmTrim>0&&state.helmTrim<=20,'persistent heading error requests a steady real rudder angle');
  assert.deepEqual([boat.x,boat.z,boat.heading,boat.surgeVelocity,boat.leewayVelocity,boat.yawRate],before);
  const held=state.helmTrim,sharpLeader=copyVessel({...source,heading:160},{distance:0,side:0});sharpLeader.surgeVelocity=1.5;
  const sharpBoat=copyVessel(sharpLeader);sharpBoat.heading=100;sharpBoat.surgeVelocity=1.5;
  steerFollower(state,sharpBoat,sharpLeader,.1,7,0);
  assert.equal(state.helmTrim,held,'large turns cannot wind up the steady trim');
});

test('fleet observer bounds include the largest independently positioned hull',()=>{
  const boats=[{x:0,z:0,length:20},{x:90,z:20,length:57},{x:-50,z:-30,length:20}],bounds=fleetViewBounds(boats);
  for(const boat of boats)assert.ok(Math.hypot(boat.x-bounds.x,boat.z-bounds.z)+boat.length<=bounds.radius+1e-10);
});

test('fleet capacity respects actual texture-array and uniform limits',()=>{
  const limits={maxTextureArrayLayers:256,maxTextureDimension2D:8192,maxUniformBufferBindingSize:65536};
  assert.doesNotThrow(()=>validateFleetDevice(limits,9));
  assert.throws(()=>validateFleetDevice(limits,10),/Invalid/);
  assert.throws(()=>validateFleetDevice({...limits,maxTextureArrayLayers:8},9),/cannot allocate/);
  assert.throws(()=>validateFleetDevice({...limits,maxUniformBufferBindingSize:112*8},9),/cannot allocate/);
});

test('production fleet shaders cover nine hulls and sample a single pooled wake binding',()=>{
  for(const count of [1,2,9]){
    const ocean=withFleetHullCount(createOpticalOcean(COASTAL_WATER,true,true,true),count);
    for(const source of [ocean,SCENE_HEIGHT_PROBE,SCENE_FOAM_UPDATE]){
      const pooled=withPooledFleetWakes(source,count);
      assert.ok(pooled.includes('fleetInteractions:array<Interaction,'+count+'>'));
      assert.ok(pooled.includes('var fleetWakeTex:texture_2d_array<f32>;'));
      assert.doesNotMatch(pooled,/\b(?:I2|wakeTex2)\s*:/);
      assert.doesNotMatch(pooled,/\bvar\s*<\s*uniform\s*>\s*I\s*:/);
    }
    assert.ok(ocean.includes('hulls['+(count-1)+']'));
    const shadows=withSceneShadowCount(SCENE_SHADOW_SAMPLE,count);
    assert.ok(shadows.includes('shadowFrames:array<ShadowFrame,'+count+'>'));
    assert.ok(shadows.includes('vesselLayerShadow(world,normal,'+(count-1)+')'));
  }
  assert.throws(()=>withPooledFleetWakes(SCENE_FOAM_UPDATE,10),/Invalid/);
  assert.throws(()=>withPooledFleetWakes('not a wake shader',3),/Unrecognized/);
});

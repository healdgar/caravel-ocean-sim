// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createFollower,steerFollower} from '../js/follower.js';
import {proceduralDesign} from '../js/models/procedural.js';
import {advanceRowing} from '../js/rowing.js';

const rowingFollowerIds=['oseberg','lusoria','taino-canoe'];
function rowingFollowerBoat(id,extra={}){
  const d=proceduralDesign(id);
  return {modelId:id,...d.runtime,x:0,z:0,heading:0,propulsion:'sail',surgeVelocity:0,leewayVelocity:0,yawRate:0,
    rudder:0,rudderTarget:0,sailFore:0,sailMain:0,sailMizzen:0,...extra};
}
function rowingFollowerStation(leader,id=leader.modelId,extra={}){
  const boat=rowingFollowerBoat(id,extra),L=Math.max(boat.length,leader.length),h=leader.heading*Math.PI/180;
  boat.x=leader.x-Math.sin(h)*L*2.8+Math.cos(h)*L*1.5;
  boat.z=leader.z+Math.cos(h)*L*2.8+Math.sin(h)*L*1.5;
  return boat;
}

test('rowed followers bypass sail no-go and backed-sail recovery without writing physical motion',()=>{
  for(const id of rowingFollowerIds){
    const leader=rowingFollowerBoat(id,{rowingEffort:.7}),boat=rowingFollowerStation(leader),state=createFollower();
    boat.rowingState={phase:.2,rate:.4,effortPort:.3,effortStarboard:.4,cadence:.45};
    Object.assign(state,{recovering:true,recoveryTack:-1,ironsTime:8,tackAge:80,transferCooldown:120,helmTrim:12});
    const motion=[boat.x,boat.z,boat.heading,boat.surgeVelocity,boat.leewayVelocity,boat.yawRate,boat.rudder];
    const stroke={...boat.rowingState};
    steerFollower(state,boat,leader,.1,20,Math.PI/2);
    assert.equal(state.noGoAngle,0);assert.equal(state.recovering,false);assert.equal(state.ironsTime,0);
    assert.equal(state.tack,0);assert.equal(state.transferCooldown,0);assert.equal(state.course,0,'row directly toward the wind');
    assert.deepEqual([boat.x,boat.z,boat.heading,boat.surgeVelocity,boat.leewayVelocity,boat.yawRate,boat.rudder],motion);
    assert.deepEqual(boat.rowingState,stroke,'physics alone advances human strokes');
    assert.equal(boat.sailState,undefined,'rowed recovery cannot create a yard-transfer lifecycle');
    assert.ok(boat.rowingEffort>0&&boat.rowingEffort<=1);assert.equal(boat.propulsion,'sail');
    for(const key of ['sailFore','sailMain','sailMizzen'])assert.equal(boat[key],0,'headwind furls canvas while oars keep working');
  }
});

test('rowed guidance retains its desired course when wind crosses the bow',()=>{
  const leader=rowingFollowerBoat('oseberg',{rowingEffort:1,surgeVelocity:1.2}),boat=rowingFollowerStation(leader),state=createFollower();
  const courses=[];
  for(const direction of [0,Math.PI/2,Math.PI,3*Math.PI/2]){
    steerFollower(state,boat,leader,.1,12,direction);courses.push(state.course);
    assert.equal(state.recovering,false);assert.equal(state.tack,0);
  }
  assert.ok(courses.every(course=>Math.abs(course-courses[0])<1e-12),'wind can furl sails but cannot impose a sailing tack on oars');
});

test('differential stroke commands mirror and keep their physical turn direction in sternway',()=>{
  for(const id of rowingFollowerIds)for(const side of [-1,1]){
    const leader=rowingFollowerBoat(id,{x:side*400,z:-300,rowingEffort:.8}),boat=rowingFollowerBoat(id,{surgeVelocity:1}),state=createFollower({trail:0,side:0});
    steerFollower(state,boat,leader,.1,8,Math.PI/2);
    assert.equal(Math.sign(boat.rowingTurn),side);assert.equal(Math.sign(boat.rudderTarget),side);
    assert.ok(boat.rowingEffort>=0&&boat.rowingEffort<=1);assert.ok(Math.abs(boat.rowingTurn)<=1);assert.ok(Math.abs(boat.rudderTarget)<=35);
    const turn=boat.rowingTurn;boat.surgeVelocity=-1;
    steerFollower(state,boat,leader,.1,8,Math.PI/2);
    assert.equal(boat.rowingTurn,turn,'port/starboard physical blade strokes do not reverse with hull drift');
    assert.equal(Math.sign(boat.rudderTarget),-side,'steering-oar helm reverses with real sternway');
    advanceRowing(boat,.1);
    assert.ok(side>0?boat.rowingState.effortPort>boat.rowingState.effortStarboard:boat.rowingState.effortStarboard>boat.rowingState.effortPort);
  }
});

test('stopped rowed leaders rest at their station; an underway sailing leader still requests human pursuit',()=>{
  for(const id of rowingFollowerIds){
    const leader=rowingFollowerBoat(id),boat=rowingFollowerStation(leader),state=createFollower();
    steerFollower(state,boat,leader,.1,0,0);
    assert.equal(boat.rowingEffort,0);assert.equal(boat.rowingTurn,0);assert.equal(boat.rudderTarget,0);assert.equal(state.status,'Resting at station');
    const sailingLeader={modelId:'nina',length:20,beam:6,x:0,z:0,heading:0,surgeVelocity:2,leewayVelocity:0,yawRate:0,sailFore:1,sailMain:1,sailMizzen:1};
    const pursuing=rowingFollowerStation(sailingLeader,id);
    steerFollower(createFollower(),pursuing,sailingLeader,.1,10,Math.PI/2);
    assert.ok(pursuing.rowingEffort>0,'mixed fleets request actual rowing instead of requiring a rowing leader');
  }
});

test('rowed sail assistance uses actual control groups and cannot invent a canoe rig',()=>{
  for(const id of rowingFollowerIds){
    const leader=rowingFollowerBoat(id,{rowingEffort:.8,surgeVelocity:1}),boat=rowingFollowerStation(leader),state=createFollower();
    boat.rowingCadence=.61;
    steerFollower(state,boat,leader,.1,8,-Math.PI/2);
    assert.equal(boat.sailFore,0);assert.equal(boat.sailMizzen,0);
    assert.equal(boat.rowingCadence,.61,'saved human cadence remains authoritative');
    if(id==='taino-canoe')assert.equal(boat.sailMain,0);else assert.ok(boat.sailMain>0,'physical mast zero operates the main control, not fore');
  }
});

test('nonexistent canvas on a stopped canoe cannot keep a sailing escort deployed',()=>{
  const leader=rowingFollowerBoat('taino-canoe',{sailFore:1,sailMain:1,sailMizzen:1}),boat=rowingFollowerStation(leader,'flying-cloud');
  steerFollower(createFollower(),boat,leader,.1,0,0);
  assert.equal(boat.sailFore,0);assert.equal(boat.sailMain,0);assert.equal(boat.sailMizzen,0);
});

test('the original four retain their sailing helm and canvas policy',()=>{
  for(const id of ['nina','victory','pinta','santa-maria']){
    const dimensions=id==='nina'?{length:20,beam:6}:id==='victory'?{length:56.69,beam:15.8}:proceduralDesign(id).runtime;
    const leader={modelId:id,...dimensions,x:0,z:0,heading:0,propulsion:'sail',surgeVelocity:2,leewayVelocity:0,yawRate:0,
      sailFore:1,sailMain:1,sailMizzen:1};
    const boat={...leader,x:leader.length*1.5,z:leader.length*2.8},state=createFollower();
    steerFollower(state,boat,leader,.1,8,-Math.PI/2);
    assert.equal(state.status,'Following');assert.equal(state.course,0);assert.equal(state.noGoAngle,62);
    assert.ok(Math.abs(boat.rudderTarget)<1e-12);
    assert.equal(boat.sailFore,1);assert.equal(boat.sailMain,1);assert.equal(boat.sailMizzen,1);
    assert.equal(boat.rowingEffort,undefined);assert.equal(boat.rowingTurn,undefined);
  }
});

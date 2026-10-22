// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ROWING_DESIGNS,rowingDeck,rowingHullWidth} from '../js/models/rowing.js';
import {rowingState,advanceRowing,rowingStationPose,rowingSteeringPose,rowingForces} from '../js/rowing.js';

const rowingTestNear=(a,b,e=1e-8)=>assert.ok(Math.abs(a-b)<=e*Math.max(1,Math.abs(a),Math.abs(b)),`${a} != ${b}`);
const rowingTestDot=(a,b)=>a.reduce((s,v,i)=>s+v*b[i],0);
const rowingTestBoat=(d,extra={})=>({modelId:d.id,...d.runtime,heading:0,pitch:0,roll:0,heave:0,x:0,z:0,rudder:0,
  surgeVelocity:0,leewayVelocity:0,rowingState:{phase:d.propulsion.driveFraction*.5,rate:.45,effortPort:1,effortStarboard:1},...extra});

test('stroke geometry, grips and analytic blade velocities describe the same physical shaft',()=>{
  for(const d of Object.values(ROWING_DESIGNS)){
    const boat=rowingTestBoat(d),station=d.stations[Math.floor(d.stations.length/2)];
    for(const phase of [.03,.22,.70]){
      const pose=rowingStationPose(boat,station.id,{phase}),e=1e-6,a=rowingStationPose(boat,station.id,{phase:phase-e}),b=rowingStationPose(boat,station.id,{phase:phase+e});
      for(let i=0;i<3;i++)rowingTestNear(pose.bladeVelocity[i],(b.bladeCentre[i]-a.bladeCentre[i])/(2*e)*boat.rowingState.rate,2e-6);
      for(const hand of pose.hands){
        const axis=pose.shaftB.map((v,i)=>v-pose.shaftA[i]),q=hand.map((v,i)=>v-pose.shaftA[i]),t=rowingTestDot(q,axis)/rowingTestDot(axis,axis);
        assert.ok(t>0&&t<1);assert.ok(Math.hypot(...q.map((v,i)=>v-axis[i]*t))<1e-8,'both hands grip the real shaft');
      }
      const normal=pose.bladeNormal;rowingTestNear(Math.hypot(...normal),1);rowingTestNear(rowingTestDot(normal,pose.bladeAlong),0);rowingTestNear(rowingTestDot(normal,pose.bladeAcross),0);
      for(const foot of pose.feet){
        const z=foot[2]/(d.runtime.length/12),y=rowingDeck(d.id,z);rowingTestNear(foot[1],y*d.frame.verticalScale);
        assert.ok(Math.abs(foot[0])<=rowingHullWidth(d.id,z,y)*d.runtime.beam/3.6+1e-8);
      }
    }
  }
});

test('immersion clips actual world-space blade area across heading, heel, pitch and heave',()=>{
  for(const d of Object.values(ROWING_DESIGNS)){
    const boat=rowingTestBoat(d,{heading:65,pitch:.13,roll:-.21,heave:.4,x:12,z:-6}),first=rowingStationPose(boat,0),level=first.worldCorners.reduce((sum,p)=>sum+p[1],0)/4;
    const half=rowingStationPose(boat,0,{sampleWater:()=>level}),dry=rowingStationPose(boat,0,{sampleWater:()=>-20}),wet=rowingStationPose(boat,0,{sampleWater:()=>20});
    rowingTestNear(half.immersion,.5);rowingTestNear(half.wetArea,d.propulsion.bladeLength*d.propulsion.bladeWidth*.5);
    assert.equal(dry.wetArea,0);rowingTestNear(wet.immersion,1);assert.ok(half.waterValid);
    assert.equal(rowingStationPose(boat,0,{sampleWater:()=>({height:NaN})}).waterValid,false);
  }
});

test('feathered recovery adds no propulsion but an immersed blade still dissipates real body/current flow',()=>{
  for(const d of Object.values(ROWING_DESIGNS)){
    const boat=rowingTestBoat(d);boat.rowingState.phase=.70;
    for(const station of d.stations){const pose=rowingStationPose(boat,station.id,{sampleWater:()=>2});assert.equal(pose.drive,false);rowingTestNear(rowingTestDot(pose.bladeNormal,pose.bladeVelocity),0);}
    const rest=rowingForces({},boat,{sampleWater:()=>2});assert.ok(Math.abs(rest.forward)<1e-8&&Math.abs(rest.power)<1e-8&&Math.abs(rest.crewPower)<1e-8);
    boat.leewayVelocity=.8;boat.heaveVelocity=.2;const moving=rowingForces({},boat,{sampleWater:()=>2});assert.ok(moving.power<0&&moving.dissipation>0);rowingTestNear(moving.crewPower,0);
    const current=rowingForces({},rowingTestBoat(d,{rowingState:{...boat.rowingState}}),{sampleWater:()=>({height:2,velocity:[.8,.2,0]})});
    assert.ok(current.waterPower>0&&current.dissipation>0,'incident water can load a stationary immersed blade without a commanded stroke');
  }
});

test('symmetric drive propels by water reaction; differential effort gives mirrored yaw without a rudder assist',()=>{
  for(const d of Object.values(ROWING_DESIGNS)){
    const boat=rowingTestBoat(d),both=rowingForces({},boat);assert.ok(both.forward>0&&both.crewPower>0);rowingTestNear(both.side,0);rowingTestNear(both.yawMoment,0);
    const port=rowingTestBoat(d),starboard=rowingTestBoat(d);port.rowingState.effortStarboard=0;starboard.rowingState.effortPort=0;
    const a=rowingForces({},port),b=rowingForces({},starboard);assert.ok(a.forward>0&&b.forward>0);assert.ok(a.yawMoment>0&&b.yawMoment<0);
    rowingTestNear(a.forward,b.forward);rowingTestNear(a.side,-b.side);rowingTestNear(a.yawMoment,-b.yawMoment);
    const dry=rowingForces({},boat,{sampleWater:()=>-20});assert.equal(dry.forward,0);assert.equal(dry.activeBlades,0);
  }
});

test('relative blade drag remains dissipative and human/water/body powers close under compound vessel motion',()=>{
  for(const d of Object.values(ROWING_DESIGNS))for(const phase of [.04,.22,.70]){
    const boat=rowingTestBoat(d,{heading:33,pitch:.1,roll:-.12,surgeVelocity:1.1,leewayVelocity:.3,heaveVelocity:.2,pitchVelocity:.04,rollVelocity:-.03,yawRate:.05});boat.rowingState.phase=phase;
    const out=rowingForces({},boat,{sampleWater:()=>({height:.7,velocity:[.3,.1,-.2]}),cg:[0,.1,.05]});
    assert.ok(out.dissipation>=0);rowingTestNear(out.power,out.crewPower+out.waterPower-out.dissipation,1e-9);
    for(const blade of out.blades){
      assert.ok(rowingTestDot(blade.force,blade.relativeVelocity)<=1e-8);
      if(blade.drive)assert.ok(blade.crewPower<=d.propulsion.maxPower+1e-8);
    }
  }
});

test('steering oar/paddle uses through-water flow, reverses astern and cannot turn a motionless vessel',()=>{
  for(const d of Object.values(ROWING_DESIGNS)){
    const base=rowingTestBoat(d,{rudder:25,rowingState:{phase:0,rate:0,effortPort:0,effortStarboard:0}}),zero=rowingForces({},base);
    assert.equal(zero.forward,0);assert.equal(zero.yawMoment,0);
    const ahead=rowingForces({},{...base,surgeVelocity:2}),astern=rowingForces({},{...base,surgeVelocity:-2});
    assert.ok(ahead.yawMoment>0&&astern.yawMoment<0);rowingTestNear(ahead.yawMoment,-astern.yawMoment);assert.ok(ahead.power<0&&astern.power<0);
    const helm=rowingSteeringPose(base);assert.equal(helm.hands.length,2);assert.ok(helm.wetArea>0);
  }
});

test('cadence is frame-partition invariant; force queries do not advance stroke or mutate vessel momentum',()=>{
  for(const d of Object.values(ROWING_DESIGNS)){
    const a={modelId:d.id,surgeVelocity:2,heading:40},b={...a};advanceRowing(a,5,{effort:1,turn:.4});
    for(let i=0;i<600;i++)advanceRowing(b,1/120,{effort:1,turn:.4});
    for(const key of ['phase','rate','effortPort','effortStarboard'])rowingTestNear(a.rowingState[key],b.rowingState[key],1e-10);
    assert.equal(a.rowingState.effortPort,1);assert.equal(a.rowingState.effortStarboard,.6);
    const snapshot=JSON.stringify(a.rowingState);rowingForces({},a);assert.equal(JSON.stringify(a.rowingState),snapshot);assert.equal(a.surgeVelocity,2);assert.equal(a.heading,40);
    const state=rowingState(a),previous=state.phase;advanceRowing(a,NaN);assert.equal(state.phase,previous);
    const stale=rowingForces({},rowingTestBoat(d));assert.ok(stale.blades.length>0);rowingForces(stale,rowingTestBoat(d,{surgeVelocity:NaN}));assert.equal(stale.blades.length,0);assert.equal(stale.forward,0);
  }
  assert.throws(()=>rowingForces({},{modelId:'missing'}),/No rowing vessel/);
});

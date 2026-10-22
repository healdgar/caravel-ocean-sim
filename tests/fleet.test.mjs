import assert from 'node:assert/strict';
import {test} from 'node:test';
import {bindVesselModel,copyVessel,createVesselProbeState,acceptVesselProbe,stepVessel} from '../js/vessels.js';
import {getShipModel} from '../js/ship-models.js';
import {createFollower,steerFollower} from '../js/follower.js';
import {sailingState,advanceSails,sailForces} from '../js/sailing.js';

const RAD=Math.PI/180;
const source={length:24,beam:7.2,eye:4,heading:118,x:0,z:0,provisionDays:30,cargoTonnes:0,sailFore:1,sailMain:1,sailMizzen:1};

test('copied vessels preserve dimensions and loading without sharing mutable rig or wave state',()=>{
  const first=copyVessel(source,{distance:0,side:0}),second=copyVessel(first);
  assert.equal(second.length,first.length);assert.equal(second.beam,first.beam);assert.equal(second.hydrodynamics.mass,first.hydrodynamics.mass);
  assert.notEqual(second.target,first.target);assert.notEqual(sailingState(first),sailingState(second));
  assert.notEqual(first.sailState.rig,second.sailState.rig);
  const a=createVesselProbeState(),b=createVesselProbeState(),heights=new Float32Array(16);heights.fill(2,0,9);
  acceptVesselProbe(second,b,heights,1,0,second.length,second.beam);
  assert.equal(first.heave,-first.hydrodynamics.sinkage);assert.ok(second.heave>1);assert.equal(a.time,-1);assert.equal(b.time,1);
  assert.equal(acceptVesselProbe(second,b,heights,2,0,second.length,second.beam),false,'stale readback cannot overwrite a newer placement');
});

test('vessel instances share an immutable model identity while retaining their configured dimensions and load',()=>{
  const first=bindVesselModel({...source,id:'leader'}),second=copyVessel(first,{id:'follower',distance:0,side:0});
  assert.equal(first.modelId,'nina');assert.equal(second.modelId,'nina');
  assert.equal(first.model,getShipModel('nina'));assert.equal(second.model,first.model);
  assert.ok(Object.isFrozen(first.model));
  assert.equal(first.length,source.length);assert.equal(first.beam,source.beam);
  assert.equal(second.length,source.length);assert.equal(second.beam,source.beam);
  assert.equal(second.provisionDays,source.provisionDays);assert.equal(second.cargoTonnes,source.cargoTonnes);
});

test('additional models bind their own identities and dimensions; unknown models cannot mutate a vessel',()=>{
  const boat=bindVesselModel({...source}),model=boat.model;
  for(const id of ['pinta','santa-maria']){
    const copy=copyVessel({...source},{modelId:id});assert.equal(copy.model,getShipModel(id));
    assert.equal(copy.length,getShipModel(id).runtime.length);assert.equal(copy.beam,getShipModel(id).runtime.beam);
    assert.notEqual(copy.hydrodynamics,boat.hydrodynamics);
    assert.equal(boat.model,model);assert.equal(boat.modelId,'nina');
  }
  assert.throws(()=>bindVesselModel(boat,'unknown-ship'),/unknown|not.*found/i);
  assert.equal(boat.model,model);
});

test('copying a vessel copies its requested configuration without transplanting a running simulation',()=>{
  const first=copyVessel(source,{id:'leader',distance:0,side:0});
  Object.assign(first,{speed:6,surgeVelocity:2,leewayVelocity:.2,yawRate:.03,rudder:12,rudderTarget:12,
    externalForce:{x:100,z:200,yaw:300},crewSailRate:new Float64Array([.3,.6,.9])});
  advanceSails(first,.1,9,.7);sailForces(first,9,.7,2);
  const firstRig=sailingState(first),firstSet=Array.from(firstRig.set),firstForces=[firstRig.forward,firstRig.side];
  const second=copyVessel(first,{id:'follower',distance:0,side:0}),secondRig=sailingState(second);
  assert.equal(first.id,'leader');assert.equal(second.id,'follower');
  assert.equal(second.speed,first.speed);assert.equal(second.propulsion,'sail');
  assert.equal(second.surgeVelocity,undefined);assert.equal(second.leewayVelocity,undefined);
  assert.equal(second.externalForce,undefined);assert.equal(second.crewSailRate,undefined);
  assert.equal(second.rudder,0);assert.equal(second.rudderTarget,0);assert.equal(second.yawRate,0);
  assert.notEqual(second.hydrodynamics,first.hydrodynamics);
  assert.notEqual(secondRig.geometry,firstRig.geometry);assert.notEqual(secondRig.set,firstRig.set);
  assert.notEqual(secondRig.panelSide,firstRig.panelSide);assert.notEqual(secondRig.panelMoment,firstRig.panelMoment);
  second.sailFore=0;advanceSails(second,1,15,2);sailForces(second,15,2,0);
  assert.deepEqual(Array.from(firstRig.set),firstSet,'working one ship cannot change another ship\'s canvas');
  assert.deepEqual([firstRig.forward,firstRig.side],firstForces,'force queries remain per ship');
});

test('follower policy has no authority to translate, accelerate or rotate a ship',()=>{
  const lead=copyVessel(source,{distance:0,side:0}),boat=copyVessel(lead),state=createFollower();
  Object.assign(boat,{surgeVelocity:1.2,leewayVelocity:.1,yawRate:.03});
  const before=[boat.x,boat.z,boat.heading,boat.surgeVelocity,boat.leewayVelocity,boat.yawRate];
  steerFollower(state,boat,lead,.1,7,118*RAD);
  assert.deepEqual([boat.x,boat.z,boat.heading,boat.surgeVelocity,boat.leewayVelocity,boat.yawRate],before);
  assert.equal(boat.propulsion,'sail');assert.ok(Math.abs(boat.rudderTarget)<=35);
});

test('a full-canvas leader starting from rest keeps follower sails set; a furled stopped leader can furl them',()=>{
  const lead=copyVessel(source,{distance:0,side:0}),boat=copyVessel(lead),state=createFollower();
  lead.surgeVelocity=0;steerFollower(state,boat,lead,.1,7,118*RAD);
  for(const key of ['sailFore','sailMain','sailMizzen'])assert.ok(boat[key]>.8,'low speed alone must not furl a sailing companion');
  lead.sailFore=lead.sailMain=lead.sailMizzen=0;
  steerFollower(state,boat,lead,.1,7,118*RAD);
  for(const key of ['sailFore','sailMain','sailMizzen'])assert.equal(boat[key],0,'a stopped, furled leader requests companion furling at station');
});

test('formation following sails for four minutes using ordinary hull forces and remains separated',()=>{
  const lead=copyVessel(source,{distance:0,side:0}),boat=copyVessel(lead),state=createFollower();
  const a=createVesselProbeState(),b=createVesselProbeState();let minDistance=Infinity,captainTrim=0;
  for(let i=0;i<7200;i++){
    const dt=1/30,t=i*dt;
    // A captain must hold the requested course against real sail/hull yaw.
    // This order acts through rudder lag, water flow and yaw inertia; it never
    // overwrites heading or suppresses the forces the escort must also balance.
    const error=Math.atan2(Math.sin((118-lead.heading)*RAD),Math.cos((118-lead.heading)*RAD))/RAD;
    captainTrim=Math.max(-20,Math.min(20,captainTrim+error*.06*dt));
    lead.rudderTarget=Math.max(-35,Math.min(35,error*1.1-(lead.yawRate??0)/RAD*5+captainTrim));
    stepVessel(lead,a,dt,t,7,118*RAD);steerFollower(state,boat,lead,dt,7,118*RAD);stepVessel(boat,b,dt,t,7,118*RAD);
    minDistance=Math.min(minDistance,Math.hypot(boat.x-lead.x,boat.z-lead.z));
  }
  const h=lead.heading*RAD,goalX=lead.x-Math.sin(h)*lead.length*2.8+Math.cos(h)*lead.length*1.5,goalZ=lead.z+Math.cos(h)*lead.length*2.8+Math.sin(h)*lead.length*1.5;
  assert.ok(Math.hypot(boat.x-goalX,boat.z-goalZ)<lead.length,'follower remains within one hull length of its station');
  assert.ok(minDistance>lead.length*2,'physical hulls remain well separated');
  assert.ok(boat.surgeVelocity>1);assert.ok(Math.abs(boat.heading-lead.heading)<5);
  assert.ok(Math.abs(lead.heading-118)<2,'the captain holds course through physical helm forces');
  assert.equal(boat.sailState.maneuver,undefined,'routine following never transfers yards');
});

test('in-irons recovery uses real sternway and keeps one tack commitment',()=>{
  const lead=copyVessel({...source,heading:0},{distance:0,side:0}),boat=copyVessel(lead),state=createFollower();
  const wind=Math.PI/2;boat.heading=0;boat.surgeVelocity=-.3;
  for(let i=0;i<100;i++)steerFollower(state,boat,lead,.1,9,wind);
  const tack=state.tack;assert.equal(state.status,'Recovering from irons');assert.equal(Math.sign(boat.rudderTarget),-tack);
  boat.surgeVelocity=.3;steerFollower(state,boat,lead,.1,9,wind);
  assert.equal(Math.sign(boat.rudderTarget),tack);assert.equal(state.tack,tack);assert.equal(boat.surgeVelocity,.3);
});

test('a backed follower recovers through real steering and one deliberate yard transfer',()=>{
  const lead=copyVessel(source,{distance:0,side:0}),boat=copyVessel(lead),state=createFollower(),probe=createVesselProbeState();
  boat.heading=0;lead.surgeVelocity=1;let transfers=0,wasTransferring=false;
  for(let i=0;i<7200;i++){
    const dt=1/30,t=i*dt,h=lead.heading*RAD;
    lead.x+=Math.sin(h)*dt;lead.z-=Math.cos(h)*dt;
    steerFollower(state,boat,lead,dt,9,Math.PI/2);
    if(boat.sailState?.maneuver&&!wasTransferring)transfers++;
    wasTransferring=!!boat.sailState?.maneuver;
    stepVessel(boat,probe,dt,t,9,Math.PI/2);
  }
  assert.equal(transfers,1,'a sustained bad-tack recovery warrants one transfer, not repeated transfers in irons');
  assert.ok(boat.surgeVelocity>.5,'wind and the new yard side restore forward motion');
  assert.equal(state.recovering,false);
});

test('a leader crossing the wind cannot reverse a committed backed recovery',()=>{
  const lead=copyVessel(source,{distance:0,side:0}),boat=copyVessel(lead),state=createFollower();
  boat.heading=0;boat.surgeVelocity=-.3;state.ironsTime=4;
  steerFollower(state,boat,lead,.1,9,Math.PI/2);
  assert.equal(state.recovering,true);
  const side=state.recoveryTack,course=state.course,rudder=boat.rudderTarget;
  assert.ok(side===1||side===-1);
  // Move the pursuit destination across the bow in both directions. This
  // deliberately changes the next sailing tack while the hull still backs.
  for(const pursuitSide of [-side,side,-side]){
    lead.x=boat.x+pursuitSide*500;lead.z=boat.z;lead.heading=pursuitSide>0?90:270;
    steerFollower(state,boat,lead,.1,9,Math.PI/2);
    assert.equal(state.tack,pursuitSide,'the pursuit target has crossed the wind');
    assert.equal(state.recoveryTack,side);
    assert.equal(state.course,course,'the committed escape course stays fixed');
    assert.equal(boat.rudderTarget,rudder,'sternway keeps the same recovery helm');
  }
  boat.heading=((course%360)+360)%360;boat.surgeVelocity=-.2;
  steerFollower(state,boat,lead,.1,9,Math.PI/2);
  assert.equal(state.recoveryTack,side,'heading clear of the wind alone cannot end recovery');
  boat.surgeVelocity=.5;steerFollower(state,boat,lead,.1,9,Math.PI/2);
  assert.equal(state.recovering,false);assert.equal(state.recoveryTack,0,'positive forward escape releases the commitment');
});

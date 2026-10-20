import assert from 'node:assert/strict';
import {test} from 'node:test';
import {copyVessel,createVesselProbeState,acceptVesselProbe,stepVessel} from '../js/vessels.js';
import {createFollower,steerFollower} from '../js/follower.js';
import {sailingState} from '../js/sailing.js';

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
  const a=createVesselProbeState(),b=createVesselProbeState();let minDistance=Infinity;
  for(let i=0;i<7200;i++){
    const dt=1/30,t=i*dt;
    stepVessel(lead,a,dt,t,7,118*RAD);steerFollower(state,boat,lead,dt,7,118*RAD);stepVessel(boat,b,dt,t,7,118*RAD);
    minDistance=Math.min(minDistance,Math.hypot(boat.x-lead.x,boat.z-lead.z));
  }
  const h=lead.heading*RAD,goalX=lead.x-Math.sin(h)*lead.length*2.8+Math.cos(h)*lead.length*1.5,goalZ=lead.z+Math.cos(h)*lead.length*2.8+Math.sin(h)*lead.length*1.5;
  assert.ok(Math.hypot(boat.x-goalX,boat.z-goalZ)<lead.length,'follower remains within one hull length of its station');
  assert.ok(minDistance>lead.length*2,'physical hulls remain well separated');
  assert.ok(boat.surgeVelocity>1);assert.ok(Math.abs(boat.heading-lead.heading)<5);
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

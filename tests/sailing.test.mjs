import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apparentWind, sailingState, sailForces, advanceSails, SAIL_AREAS } from '../js/sailing.js';
import { stepBoatSurge, boatForwardSpeed, KNOT_TO_MPS } from '../js/boat.js';

const vessel = extra => ({ propulsion:'sail', speed:6, heading:0, length:12, beam:3.6, sailFore:1, sailMain:1, sailMizzen:1, ...extra });
const windAt = angle => (angle + 90) * Math.PI / 180;
function trimmed(boat, wind=7, angle=90, speed=0, side=0) {
  const s=sailForces(boat,wind,windAt(angle),speed,side);
  s.squareYaw=s.squareTarget;s.lateenYaw=s.lateenTarget;
  return {...sailForces(boat,wind,windAt(angle),speed,side)};
}
function sail(boat, seconds=120, wind=7, angle=90, dt=1/30, slope=0) {
  for(let i=0;i<Math.round(seconds/dt);i++)stepBoatSurge(boat,slope,dt,wind,windAt(angle));
  return boat;
}

test('apparent wind subtracts vessel velocity and respects compass heading',()=>{
  const a=apparentWind({tack:1},0,3,0,7,Math.PI/2);
  assert.ok(Math.abs(a.apparentSpeed-10)<1e-10);assert.ok(Math.abs(a.apparentAngle)<1e-10);
  const b=apparentWind({tack:1},90,3,0,7,Math.PI);
  assert.ok(Math.abs(a.apparentSpeed-b.apparentSpeed)<1e-10);
  assert.ok(Math.abs(a.apparentAngle-b.apparentAngle)<1e-10);
  const following=apparentWind({tack:1},0,3,0,7,-Math.PI/2);
  assert.ok(Math.abs(following.apparentSpeed-4)<1e-10);
});

test('thrust requires wind, raised canvas and a sailable angle; pressure scales with wind squared',()=>{
  assert.equal(trimmed(vessel(),0).forward,0);
  assert.ok(trimmed(vessel(),7,0).forward===0);
  assert.equal(trimmed(vessel({sailFore:0,sailMain:0,sailMizzen:0})).forward,0);
  const normal=trimmed(vessel()),double=trimmed(vessel(),14),half=trimmed(vessel({sailFore:.5,sailMain:.5,sailMizzen:.5}));
  assert.ok(normal.forward>1000);
  assert.ok(Math.abs(double.forward/normal.forward-4)<1e-10);
  assert.ok(Math.abs(half.forward/normal.forward-.5)<1e-10);
});

test('each mast has independent canvas and mis-trim depowers the sails',()=>{
  for(let i=0;i<3;i++){
    const b=vessel({sailFore:0,sailMain:0,sailMizzen:0});b[['sailFore','sailMain','sailMizzen'][i]]=1;
    const loads=trimmed(b);
    assert.ok(Math.abs(loads.area-SAIL_AREAS[i])<1e-10);assert.ok(loads.forward>0);
  }
  const b=vessel(),full=trimmed(b);b.sailState.squareYaw+=Math.PI/2;b.sailState.lateenYaw+=Math.PI/2;
  assert.ok(sailForces(b,7,windAt(90),0).forward<full.forward*.01);
});

test('raising and lowering takes time; bare poles coast under drag and retain wave response',()=>{
  const b=vessel({sailFore:0,sailMain:0,sailMizzen:0});sailingState(b);
  b.sailFore=b.sailMain=b.sailMizzen=1;advanceSails(b,1,7,windAt(90));
  assert.ok(b.sailState.set.every(x=>Math.abs(x-.18)<1e-12));
  sail(b,12);assert.ok(b.surgeVelocity>0);
  const before=b.surgeVelocity;b.sailFore=b.sailMain=b.sailMizzen=0;
  stepBoatSurge(b,0,1/60,7,windAt(90));
  assert.ok(b.sailState.set.every(x=>x>0.9));assert.ok(Math.abs(b.surgeVelocity-before)<.02);
  sail(b,6);assert.ok(b.sailState.set.every(x=>x===0));
  const coast=b.surgeVelocity;sail(b,20);assert.ok(b.surgeVelocity>0 && b.surgeVelocity<coast);
  const uphill=vessel({sailFore:0,sailMain:0,sailMizzen:0,surgeVelocity:2});
  const downhill={...uphill};stepBoatSurge(uphill,.05,.1,7,0);stepBoatSurge(downhill,-.05,.1,7,0);
  assert.ok(uphill.surgeVelocity<2 && downhill.surgeVelocity>2);
});

test('wind angles produce distinct speeds and mirrored tacks give mirrored heel and leeway',()=>{
  const head=sail(vessel(),120,7,0),reach=sail(vessel()),run=sail(vessel(),120,7,180),other=sail(vessel(),120,7,-90);
  assert.equal(boatForwardSpeed(head),0);
  assert.ok(reach.surgeVelocity>run.surgeVelocity && run.surgeVelocity>0.5);
  assert.ok(Math.abs(reach.surgeVelocity-other.surgeVelocity)<1e-8);
  assert.ok(Math.abs(reach.leewayVelocity+other.leewayVelocity)<1e-8);
  assert.ok(reach.sailHeel>0 && other.sailHeel<0,'wind from starboard heels the vessel to port');
  for(const angle of [60,90,105,120,150])assert.ok(trimmed(vessel(),7,angle).side<=0,'side force remains leeward');
});

test('sailing starts from rest, adds mass-dependent acceleration and conserves motion on mode changes',()=>{
  const a=vessel({sailMizzen:0}),b=vessel({sailMizzen:0,length:24});
  trimmed(a);trimmed(b);assert.equal(boatForwardSpeed(a),0);
  stepBoatSurge(a,0,.1,7,windAt(90));stepBoatSurge(b,0,.1,7,windAt(90));
  assert.ok(a.surgeVelocity>b.surgeVelocity*1.8);
  a.propulsion='manual';const previous=a.surgeVelocity;stepBoatSurge(a,0,1/60,7,windAt(90));
  assert.ok(Math.abs(a.surgeVelocity-previous)<.1);
  a.propulsion='sail';assert.notEqual(boatForwardSpeed(a),a.speed*KNOT_TO_MPS);
});

test('zero-time startup and paused frames leave finite motion without repeating displacement',()=>{
  const b=vessel();
  assert.equal(stepBoatSurge(b,0,0,7,windAt(90)),0);
  assert.equal(b.leewayDistance,0);assert.equal(b.leewayVelocity,0);assert.equal(b.sailHeel,0);
  stepBoatSurge(b,0,.1,7,windAt(90));
  assert.notEqual(b.leewayDistance,0);
  const velocity=b.surgeVelocity;
  assert.equal(stepBoatSurge(b,0,0,7,windAt(90)),0);
  assert.equal(b.leewayDistance,0);assert.equal(b.surgeVelocity,velocity);
});

test('still air cannot supply energy to a moving or drifting vessel',()=>{
  for(const speed of [-4,-1,0,1,4])for(const side of [-1,0,1]){
    const loads=trimmed(vessel(),0,0,speed,side);
    assert.ok(loads.forward*speed+loads.side*side<1e-8);
  }
});

test('sailing remains finite and consistent from 10 to 120 FPS, including strong wind and gybes',()=>{
  const results=[1/10,1/30,1/120].map(dt=>{
    const b=vessel();sail(b,30,14,90,dt);sail(b,15,14,-90,dt);return b;
  });
  for(const b of results){
    assert.ok(Number.isFinite(b.surgeVelocity) && Number.isFinite(b.leewayVelocity));
    assert.ok(Math.abs(b.surgeVelocity-results[2].surgeVelocity)<.015);
    assert.ok(Math.abs(b.leewayVelocity-results[2].leewayVelocity)<.015);
  }
  const storm=sail(vessel(),120,32,90);
  assert.ok(storm.surgeVelocity<10 && Math.abs(storm.sailHeel)<=.42);
});

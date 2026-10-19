import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apparentWind, sailingState, sailForces, advanceSails, SAIL_AREAS, SAIL_PLAN, windAtHeight } from '../js/sailing.js';
import { stepBoatSurge, stepBoatHeel, stepBoatRoll, boatHydrodynamics, boatSpring, boatForwardSpeed, KNOT_TO_MPS } from '../js/boat.js';
import { HULL_VERTICAL_SCALE } from '../js/hull.js';

const vessel = extra => ({ propulsion:'sail', speed:6, heading:0, length:20, beam:6, sailFore:1, sailMain:1, sailMizzen:1, ...extra });
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
  assert.equal(half.area,normal.area*.5);
  assert.ok(half.forward/normal.forward>.5 && half.forward/normal.forward<.55,'remaining canvas sits higher in slightly stronger wind');
});

test('each mast has independent canvas and mis-trim depowers the sails',()=>{
  for(let i=0;i<3;i++){
    const b=vessel({sailFore:0,sailMain:0,sailMizzen:0});b[['sailFore','sailMain','sailMizzen'][i]]=1;
    const loads=trimmed(b);
    assert.ok(Math.abs(loads.area-SAIL_AREAS[i]*HULL_VERTICAL_SCALE*(20/12))<1e-10);assert.ok(loads.forward>0);
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
  const a=vessel({sailMizzen:0}),b=vessel({sailMizzen:0,length:40});
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
  for(const speed of [-4,-1,0,1,4])for(const side of [-1,0,1])for(const rollRate of [-.2,0,.2]){
    const loads=trimmed(vessel({roll:.15,rollVelocity:rollRate}),0,0,speed,side);
    assert.ok(loads.forward*speed+loads.side*side+loads.rollMoment*rollRate<1e-8);
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
    assert.ok(Math.abs(b.sailHeel-results[2].sailHeel)<.002);
    assert.ok(Math.abs(b.sailHeelVelocity-results[2].sailHeelVelocity)<.002);
  }
  const storm=sail(vessel(),120,32,90);
  assert.ok(storm.surgeVelocity<10 && Math.abs(storm.sailHeel)<=.42);
});

test('marine wind shear is referenced to 10 m and higher sail centres exert more torque per square metre',()=>{
  assert.equal(windAtHeight(12,10),12);assert.equal(windAtHeight(12,0),0);
  assert.ok(windAtHeight(12,2)<windAtHeight(12,5));assert.ok(windAtHeight(12,20)>12);
  const loads=trimmed(vessel(),12),strong=trimmed(vessel(),24),bare=trimmed(vessel({sailFore:0,sailMain:0,sailMizzen:0}),12);
  assert.ok(Math.abs(strong.rollMoment/loads.rollMoment-4)<1e-10);
  assert.ok(loads.rollMoment>0);assert.equal(bare.rollMoment,0);
  for(const lower of [0]){
    const area=i=>SAIL_PLAN[i].width*SAIL_PLAN[i].height*.95;
    assert.ok(Math.abs(loads.panelSide[lower+1])/area(lower+1)>Math.abs(loads.panelSide[lower])/area(lower),'higher canvas feels faster wind');
    assert.ok(loads.panelMoment[lower+1]/area(lower+1)>loads.panelMoment[lower]/area(lower),'height adds leverage as well as pressure');
  }
  const reef=trimmed(vessel({sailFore:.5,sailMain:.5,sailMizzen:.5}),12);
  assert.ok(reef.rollMoment<loads.rollMoment*.65 && reef.rollMoment>loads.rollMoment*.5);
  const tilted=trimmed(vessel({roll:.5}),12);
  assert.ok(tilted.rollMoment<loads.rollMoment*.8,'heeling shortens the projected area and lever');
});

test('roll inertia delays heel, displacement resists torque and righting moment balances a held wind load',()=>{
  const a=vessel({hydrodynamics:boatHydrodynamics(20,6)}),large=vessel({hydrodynamics:boatHydrodynamics(40,6)});
  const moment=a.hydrodynamics.rollStiffness*.15,equilibrium=Math.asin(.15);
  stepBoatHeel(a,moment,1/120);stepBoatHeel(large,moment,1/120);
  assert.ok(a.sailHeel>0 && a.sailHeel<equilibrium*.001);
  assert.ok(large.sailHeel<a.sailHeel*.55&&large.sailHeel>a.sailHeel*.45,'twice the fixed vessel mass nearly halves the initial response; crew and stores stay fixed');
  // The larger vessel has a longer roll period; allow 40 s to settle.
  for(let i=0;i<4800;i++)stepBoatHeel(a,moment,1/120);
  assert.ok(Math.abs(a.sailHeel-equilibrium)<.0001);assert.ok(Math.abs(a.sailHeelVelocity)<.0001);
  const angle=a.sailHeel;stepBoatHeel(a,0,1/120);
  assert.ok(Math.abs(a.sailHeel-angle)<.001,'removing torque preserves angular motion');
  const energy=b=>.5*b.hydrodynamics.rollInertia*b.sailHeelVelocity**2+b.hydrodynamics.rollStiffness*(1-Math.cos(b.sailHeel));
  const start=energy(a);for(let i=0;i<4800;i++)stepBoatHeel(a,0,1/120);
  assert.ok(energy(a)<start*1e-6,'damping dissipates roll energy after the wind load is removed');
});

test('reefing unloads torque gradually and wave-supported roll is composed without a second wind spring',()=>{
  const b=sail(vessel(),90,20,75),angle=b.sailHeel;
  assert.ok(angle>.02);
  b.sailFore=b.sailMain=b.sailMizzen=0;
  stepBoatSurge(b,0,1/60,20,windAt(75));
  assert.ok(Math.abs(b.sailHeel-angle)<.002);
  sail(b,30,20,75);assert.ok(Math.abs(b.sailHeel)<.0001);
  const combined={roll:0,waveRoll:0,waveRollVelocity:0,sailHeel:.12,sailHeelVelocity:.03},wave={roll:0};
  for(let i=0;i<120;i++){
    boatSpring(wave,'roll',.06,2,1/60);
    stepBoatRoll(combined,.06,2,1/60);
    assert.ok(Math.abs(combined.roll-wave.roll-.12)<1e-12);
    assert.ok(Math.abs(combined.rollVelocity-wave.rollVelocity-.03)<1e-12);
  }
});

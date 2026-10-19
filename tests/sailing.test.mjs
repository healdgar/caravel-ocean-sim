import {lateenSheetTarget} from '../js/lateen.js';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { apparentWind, sailingState, sailForces, advanceSails, SAIL_AREAS, windAtHeight } from '../js/sailing.js';
import { stepBoatSurge, stepBoatRotation, boatHydrodynamics, boatForwardSpeed, KNOT_TO_MPS } from '../js/boat.js';
import { HULL_VERTICAL_SCALE } from '../js/hull.js';

const vessel = extra => ({ propulsion:'sail', speed:6, heading:0, length:20, beam:6, sailFore:1, sailMain:1, sailMizzen:1, ...extra });
const windAt = angle => (angle + 90) * Math.PI / 180;
function trimmed(boat, wind=7, angle=90, speed=0, side=0) {
  const s=sailForces(boat,wind,windAt(angle),speed,side);
  s.squareYaw=s.squareTarget;s.lateenYaw=s.lateenTarget;
  for(let i=0;i<3;i++){s.rig[i].opening=lateenSheetTarget(s.lateenTarget,i);s.rig[i].side=-s.tack;}
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
  const b=vessel(),full=trimmed(b);b.sailState.squareYaw+=Math.PI/2;b.sailState.lateenYaw+=Math.PI/2;for(const p of b.sailState.rig)p.opening+=Math.PI/2;
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
  assert.ok(reach.roll>0 && other.roll<0,'wind from starboard heels the vessel to port');
  for(const angle of [60,90,105,120,150])assert.ok(trimmed(vessel(),7,angle).side<=0,'side force remains leeward');
});

test('sailing starts from rest, adds mass-dependent acceleration and conserves motion on mode changes',()=>{
  const a=vessel({sailMizzen:0}),b=vessel({sailMizzen:0,cargoTonnes:40});
  trimmed(a);trimmed(b);assert.equal(boatForwardSpeed(a),0);
  stepBoatSurge(a,0,.1,7,windAt(90));stepBoatSurge(b,0,.1,7,windAt(90));
  assert.ok(a.surgeVelocity>b.surgeVelocity*1.2);
  a.propulsion='manual';const previous=a.surgeVelocity;stepBoatSurge(a,0,1/60,7,windAt(90));
  assert.ok(Math.abs(a.surgeVelocity-previous)<.1);
  a.propulsion='sail';assert.notEqual(boatForwardSpeed(a),a.speed*KNOT_TO_MPS);
});

test('zero-time startup and paused frames leave finite motion without repeating displacement',()=>{
  const b=vessel();
  assert.equal(stepBoatSurge(b,0,0,7,windAt(90)),0);
  assert.equal(b.leewayDistance,0);assert.equal(b.leewayVelocity,0);assert.equal(b.roll,0);
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
    assert.ok(Math.abs(b.roll-results[2].roll)<.002);
    assert.ok(Math.abs(b.rollVelocity-results[2].rollVelocity)<.002);
  }
  const storm=sail(vessel(),120,32,90);
  assert.ok(storm.surgeVelocity<10 && Math.abs(storm.roll)<=.42);
});

test('marine wind shear is referenced to 10 m and higher sail centres exert more torque per square metre',()=>{
  assert.equal(windAtHeight(12,10),12);assert.equal(windAtHeight(12,0),0);
  assert.ok(windAtHeight(12,2)<windAtHeight(12,5));assert.ok(windAtHeight(12,20)>12);
  const loads=trimmed(vessel(),12),strong=trimmed(vessel(),24),bare=trimmed(vessel({sailFore:0,sailMain:0,sailMizzen:0}),12);
  assert.ok(Math.abs(strong.rollMoment/loads.rollMoment-4)<1e-10);
  assert.ok(loads.rollMoment>0);assert.equal(bare.rollMoment,0);
  for(const lower of [1,2]){
    const higher=lower-1; // The traced all-lateen plan is tallest forward.
    const area=i=>SAIL_AREAS[i];
    assert.ok(Math.abs(loads.panelSide[higher])/area(higher)>Math.abs(loads.panelSide[lower])/area(lower),'higher canvas feels faster wind');
    assert.ok(loads.panelMoment[higher]/area(higher)>loads.panelMoment[lower]/area(lower),'height adds leverage as well as pressure');
  }
  const reef=trimmed(vessel({sailFore:.5,sailMain:.5,sailMizzen:.5}),12);
  // Half the area retains more than half the torque: the tall triangular
  // fore course gathers upward, raising its remaining centre of effort.
  assert.ok(reef.rollMoment<loads.rollMoment*.75 && reef.rollMoment>loads.rollMoment*.5);
  const tilted=trimmed(vessel({roll:.5}),12);
  assert.ok(tilted.rollMoment<loads.rollMoment*.8,'heeling shortens the projected area and lever');
});

test('roll inertia delays heel, displacement resists torque and righting moment balances a held wind load',()=>{
  const a=vessel({hydrodynamics:boatHydrodynamics(20,6)}),large=vessel({hydrodynamics:boatHydrodynamics(40,6)});
  const moment=a.hydrodynamics.rollStiffness*.15,equilibrium=Math.asin(.15);
  stepBoatRotation(a,'roll',0,moment,1/120);stepBoatRotation(large,'roll',0,moment,1/120);
  assert.ok(a.roll>0 && a.roll<equilibrium*.001);
  assert.ok(large.roll<a.roll*.55&&large.roll>a.roll*.45,'twice the fixed vessel mass nearly halves the initial response; crew and stores stay fixed');
  // The larger vessel has a longer roll period; allow 40 s to settle.
  for(let i=0;i<4800;i++)stepBoatRotation(a,'roll',0,moment,1/120);
  assert.ok(Math.abs(a.roll-equilibrium)<.0001);assert.ok(Math.abs(a.rollVelocity)<.0001);
  const angle=a.roll;stepBoatRotation(a,'roll',0,0,1/120);
  assert.ok(Math.abs(a.roll-angle)<.001,'removing torque preserves angular motion');
  const energy=b=>.5*b.hydrodynamics.rollInertia*b.rollVelocity**2+b.hydrodynamics.rollStiffness*(1-Math.cos(b.roll));
  const start=energy(a);for(let i=0;i<4800;i++)stepBoatRotation(a,'roll',0,0,1/120);
  assert.ok(energy(a)<start*1e-6,'damping dissipates roll energy after the wind load is removed');
});

test('reefing unloads torque gradually without resetting angular motion',()=>{
  const b=sail(vessel(),90,20,75),angle=b.roll;
  assert.ok(angle>.02);
  b.sailFore=b.sailMain=b.sailMizzen=0;
  stepBoatSurge(b,0,1/60,20,windAt(75));
  assert.ok(Math.abs(b.roll-angle)<.002);
  sail(b,30,20,75);assert.ok(Math.abs(b.roll)<.0001);
});

test('sail forces act on wave roll itself and can damp it without removing mean heel',()=>{
  function response(raised,dt){
    const b=vessel({hydrodynamics:boatHydrodynamics(20,6),surgeVelocity:2,
      sailFore:raised,sailMain:raised,sailMizzen:raised,roll:0,rollVelocity:0});
    let sum=0,squares=0,n=0;
    for(let i=0;i<Math.round(120/dt);i++){
      const t=i*dt;advanceSails(b,dt,14,windAt(60));
      const loads=sailForces(b,14,windAt(60),2,0);
      stepBoatRotation(b,'roll',.1*Math.sin(t*2*Math.PI/6.5),loads.rollMoment,dt);
      if(t>60){sum+=b.roll;squares+=b.roll*b.roll;n++;}
    }
    return {mean:sum/n,rms:Math.sqrt(squares/n-(sum/n)**2)};
  }
  const bare=response(0,1/120),set=response(1,1/120),coarse=response(1,1/30);
  assert.ok(set.rms<bare.rms*.96,`close-reach sail damping: ${JSON.stringify({bare,set})}`);
  assert.ok(set.mean>bare.mean+.02,'steady pressure still heels the vessel');
  assert.ok(Math.abs(coarse.rms-set.rms)<.0002,'damping survives coarse animation frames');
});

test('rapid wave slopes cannot prescribe roll velocity; long swells still move the hull',()=>{
  function response(period){
    const b=vessel({hydrodynamics:boatHydrodynamics(20,6),surgeVelocity:0,roll:0,rollVelocity:0});
    let squares=0,n=0;
    for(let i=0;i<120*120;i++){
      const t=i/120;stepBoatRotation(b,'roll',.1*Math.sin(t*2*Math.PI/period),0,1/120);
      if(t>60){squares+=b.roll*b.roll;n++;}
    }
    return Math.sqrt(squares/n);
  }
  assert.ok(response(1)<response(14)*.06,'short chop is rejected by angular inertia');
  assert.ok(response(14)>.06,'long-wave rocking is retained');
  const b=vessel({hydrodynamics:boatHydrodynamics(20,6),surgeVelocity:0,roll:.1,rollVelocity:0,pitch:.1,pitchVelocity:0});
  const energy=axis=>.5*b.hydrodynamics[axis+'Inertia']*b[axis+'Velocity']**2+b.hydrodynamics[axis+'Stiffness']*(1-Math.cos(b[axis]));
  for(const axis of ['roll','pitch']){
    let before=energy(axis);
    for(let i=0;i<1200;i++){
      stepBoatRotation(b,axis,0,0,1/120);const after=energy(axis);
      assert.ok(after<=before*1.00001,'free rotation dissipates energy');before=after;
    }
    assert.ok(Math.abs(b[axis])<.002);
  }
});

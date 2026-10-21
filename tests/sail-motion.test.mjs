// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {boatHydrodynamics,boatRotate} from '../js/boat.js';
import {vesselDraft} from '../js/hull.js';
import {sailForces,sailingState} from '../js/sailing.js';
import {sailPanelForce} from '../js/sail-aerodynamics.js';

const motionLoadKeys=['forward','side','heaveForce','rollMoment','pitchMoment','yawMoment'];
function motionBoat(modelId,extra={}){
  const victory=modelId==='victory',length=victory?56.6928:20,beam=victory?15.8496:6;
  const boat={modelId,length,beam,heading:37,roll:.24,pitch:-.13,rollVelocity:.17,pitchVelocity:-.11,
    sailFore:1,sailMain:1,sailMizzen:1,...extra};
  boat.hydrodynamics=boatHydrodynamics(length,beam,60,0,modelId);
  const state=sailingState(boat);state.squareYaw=.2;state.lateenYaw=.4;
  state.rig.forEach(p=>Object.assign(p,{opening:.63,fill:.9,pressure:1,side:-1}));
  return boat;
}
const motionClose=(actual,expected,label)=>assert.ok(Math.abs(actual-expected)<=Math.max(1,Math.abs(expected))*1e-6,
  `${label}: ${actual} != ${expected}`);

test('omitted heave and yaw rates retain the exact explicitly stationary load result',()=>{
  for(const model of['nina','victory']){
    const implicit=sailForces(motionBoat(model),9,2.3,2.8,-.3);
    const explicit=sailForces(motionBoat(model,{heaveVelocity:0,yawRate:0}),9,2.3,2.8,-.3);
    for(const key of[...motionLoadKeys,'area'])assert.equal(implicit[key],explicit[key],model+' '+key);
  }
});

test('heave and yaw independently produce opposing still-air loads on raised cloth',()=>{
  for(const model of['nina','victory'])for(const rate of[-1.2,1.2]){
    const heave=motionBoat(model,{roll:0,pitch:0,rollVelocity:0,pitchVelocity:0,heaveVelocity:rate,yawRate:0});
    const vertical=sailForces(heave,0,0,0,0);
    assert.ok(vertical.heaveForce*rate<0,model+' vertical motion must meet aerodynamic resistance');
    const yaw=motionBoat(model,{roll:0,pitch:0,rollVelocity:0,pitchVelocity:0,heaveVelocity:0,yawRate:rate*.2});
    const turn=sailForces(yaw,0,0,0,0);
    assert.ok(turn.yawMoment*yaw.yawRate<0,model+' yaw motion must meet aerodynamic resistance');
  }
});

// Differentiate the authoritative rigid transform, rather than repeating the
// analytical omega expression used by the runtime. Work in the existing
// centre-of-gravity load frame and compare all force and generalized moments.
test('all panel loads agree with finite-differenced rigid heave, heading, pitch and roll motion',()=>{
  for(const model of['nina','victory'])for(const heading of[37,161]){
    const boat=motionBoat(model,{heading,heaveVelocity:1.4,yawRate:.23}),speed=2.6,sideways=-.4;
    const loads=sailForces(boat,0,0,speed,sideways),force=[0,0,0],moment=[0,0,0],coefficients={},patch=new Float64Array(3);
    const angle=heading*Math.PI/180,c=Math.cos(angle),s=Math.sin(angle),dt=1e-5;
    const cg=boat.hydrodynamics.centreOfGravity-vesselDraft(boat);
    const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
    const rotate=(p,t)=>{const out=[0,0,0];boatRotate(out,...p,angle+boat.yawRate*t,boat.pitch+boat.pitchVelocity*t,boat.roll+boat.rollVelocity*t);return out;};
    const translation=[speed*s+sideways*c,boat.heaveVelocity,-speed*c+sideways*s];
    for(const panel of loads.geometry.panels){
      const local=[panel.point[0],panel.point[1]-cg,panel.point[2]],before=rotate(local,-dt),after=rotate(local,dt),r=rotate(local,0),normal=rotate(panel.normal,0);
      const air=after.map((v,i)=>-translation[i]-(v-before[i])/(2*dt));
      sailPanelForce(patch,coefficients,...normal,...air,panel.area,panel.aspect);
      const torque=cross(r,patch);for(let i=0;i<3;i++){force[i]+=patch[i];moment[i]+=torque[i];}
    }
    const inverse=v=>[c*v[0]+s*v[2],v[1],-s*v[0]+c*v[2]],F=inverse(force),M=inverse(moment);
    const expected={forward:-F[2],side:F[0],heaveForce:F[1],pitchMoment:M[0],yawMoment:-M[1],rollMoment:-Math.sin(boat.pitch)*M[1]+Math.cos(boat.pitch)*M[2]};
    for(const key of motionLoadKeys)motionClose(loads[key],expected[key],model+' '+heading+' '+key);
  }
});

test('combined still-air six-axis loads dissipate mechanical work at arbitrary attitudes',()=>{
  let seed=0x14921805;
  const random=()=>{seed=(1664525*seed+1013904223)>>>0;return seed/4294967296;};
  for(const model of['nina','victory'])for(let i=0;i<120;i++){
    const boat=motionBoat(model,{heading:random()*360,roll:(random()-.5)*1.1,pitch:(random()-.5)*.5,
      rollVelocity:random()-.5,pitchVelocity:random()-.5,yawRate:(random()-.5)*.6,heaveVelocity:(random()-.5)*4});
    const speed=random()*8-4,sideways=random()*4-2,loads=sailForces(boat,0,0,speed,sideways);
    const work=loads.forward*speed+loads.side*sideways+loads.heaveForce*boat.heaveVelocity+
      loads.rollMoment*boat.rollVelocity+loads.pitchMoment*boat.pitchVelocity+loads.yawMoment*boat.yawRate;
    assert.ok(Number.isFinite(work)&&work<=1e-7,model+' still-air work: '+work);
  }
});

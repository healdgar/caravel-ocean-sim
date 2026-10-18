import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boatTargets, boatSpring, boatRotate } from '../js/boat.js';

test('flat sea gives level hull and correct height', () => {
  assert.deepEqual(boatTargets(Array(9).fill(2), 10, 3), { heave: 2, pitch: 0, roll: 0 });
});
test('hull fits a sloping water plane with correct bow and starboard signs', () => {
  const heights = [];
  for (let f = -1; f <= 1; f++) for (let r = -1; r <= 1; r++) heights.push(2 + f + r * 0.3);
  const pose = boatTargets(heights, 10, 3);
  assert.ok(Math.abs(pose.heave - 2) < 1e-12);
  assert.ok(Math.abs(pose.pitch - Math.atan(0.2)) < 1e-12);
  assert.ok(Math.abs(pose.roll - Math.atan(0.2)) < 1e-12);
  assert.ok(boatTargets(heights, 20, 3).pitch < pose.pitch);
});
test('damping is frame-rate independent for a held wave target', () => {
  const a = { heave: 0 }, b = { heave: 0 };
  for (let i = 0; i < 60; i++) boatSpring(a, 'heave', 2, 3, 1 / 60);
  for (let i = 0; i < 20; i++) boatSpring(b, 'heave', 2, 3, 1 / 20);
  assert.ok(Math.abs(a.heave - b.heave) < 1e-12);
  assert.ok(a.heave > 0 && a.heave < 2);
});
test('a rising water plane is followed without permanent spring lag', () => {
  for(const dt of [1/30,1/120]){
    const state={heave:0};
    for(let i=0;i<Math.round(4/dt);i++)boatSpring(state,'heave',i*dt,3,dt,1);
    assert.ok(Math.abs(state.heave-4)<0.001);
    assert.ok(Math.abs(state.heaveVelocity-1)<0.001);
  }
});
test('heading and pitch orient the camera along the boat', () => {
  const out = new Float64Array(3);
  boatRotate(out, 0, 0, -1, Math.PI / 2, 0, 0);
  assert.ok(Math.abs(out[0] - 1) < 1e-12);
  boatRotate(out, 0, 0, -1, 0, 0.2, 0);
  assert.ok(out[1] > 0);
});
import { stepBoatSteering } from '../js/boat.js';

const steeringBoat = (speed=6,length=12) => ({speed,length,heading:0,rudder:0,rudderTarget:0,yawRate:0});
function advance(boat,command,seconds,dt=1/60) { for(let t=0;t<seconds-1e-9;t+=dt)stepBoatSteering(boat,command,dt); return boat; }
test('rudder steers port and starboard with turn inertia', () => {
  const right=advance(steeringBoat(),1,6),left=advance(steeringBoat(),-1,6);
  assert.ok(right.heading>5 && right.heading<90);
  assert.ok(left.heading>270 && left.heading<355);
  assert.ok(Math.abs(right.heading+left.heading-360)<1e-8);
  assert.ok(right.rudder<=35 && right.rudder>34);
});
test('stationary boat has no rudder-driven yaw, and a larger hull turns more slowly', () => {
  assert.equal(advance(steeringBoat(0),1,8).heading,0);
  assert.ok(advance(steeringBoat(6,24),1,6).heading<advance(steeringBoat(6,12),1,6).heading);
});
test('centering rudder lets yaw decay and results stay stable at lower frame rate', () => {
  const a=advance(steeringBoat(),1,4),b=advance(steeringBoat(),1,4,1/20);
  assert.ok(Math.abs(a.heading-b.heading)<0.3);
  const turn=a.yawRate; a.rudderTarget=0; advance(a,0,10);
  assert.ok(Math.abs(a.yawRate)<turn*0.01);
  assert.ok(Math.abs(a.rudder)<1e-6);
});

import { boatEyePosition } from '../js/boat.js';
import { HELM_EYE_Z, HELM_EYE_HEIGHT } from '../js/hull.js';
test('boarding uses the ship world position and eye height independently of a spectator camera', () => {
  const boat={x:100,z:-30,heave:2,eye:HELM_EYE_HEIGHT,length:12,heading:90,pitch:0,roll:0};
  const out=new Float64Array(3); boatEyePosition(out,boat);
  assert.deepEqual(Array.from(out),[100-HELM_EYE_Z,2+HELM_EYE_HEIGHT,-30]);
  boat.pitch=0.2;boat.roll=-0.15;boatEyePosition(out,boat);
  assert.ok(Math.abs(Math.hypot(out[0]-boat.x,out[1]-boat.heave,out[2]-boat.z)-Math.hypot(boat.eye,HELM_EYE_Z))<1e-12);
  const previous=Array.from(out);boat.x+=20;boat.z-=5;boatEyePosition(out,boat);
  assert.ok(Math.abs(out[0]-previous[0]-20)<1e-12);
  assert.ok(Math.abs(out[2]-previous[2]+5)<1e-12);
  boat.length=24;boat.pitch=boat.roll=boat.heading=0;boatEyePosition(out,boat);
  assert.ok(Math.abs(out[2]-boat.z-2*HELM_EYE_Z)<1e-12,'helm eye follows a resized stern');
});

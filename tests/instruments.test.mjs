import assert from 'node:assert/strict';
import {test} from 'node:test';
import {instrumentReadout} from '../js/instruments.js';
import {sailingState,advanceSails,sailForces} from '../js/sailing.js';
import {KNOT_TO_MPS} from '../js/boat.js';

test('instruments distinguish signed speed, apparent wind from bearing and sternway guidance',()=>{
  const b={length:20,beam:6,propulsion:'sail',heading:0,surgeVelocity:-KNOT_TO_MPS};
  const s=sailingState(b);Object.assign(s,{apparentAngle:Math.PI/2,apparentSpeed:10*KNOT_TO_MPS});
  let r=instrumentReadout(b);assert.equal(r.speed,'-1.0');assert.equal(r.motion,'ASTERN');assert.equal(r.wind,'10.0');assert.equal(r.direction,'90° starboard');assert.equal(r.degrees,90);
  s.apparentAngle=-Math.PI/4;r=instrumentReadout(b);assert.equal(r.direction,'45° port');
  s.apparentAngle=0;assert.match(instrumentReadout(b).cue,/steering is reversed/);
  b.surgeVelocity=0;assert.match(instrumentReadout(b).cue,/rudder needs water flow/);
  b.surgeVelocity=-KNOT_TO_MPS;b.rudderTarget=30;s.apparentAngle=Math.PI/2;assert.match(instrumentReadout(b).cue,/centre rudder/);
  b.surgeVelocity=-.001;assert.equal(instrumentReadout(b).speed,'0.0');
  s.apparentSpeed=0;assert.equal(instrumentReadout(b).calm,true);
});

test('wind dial follows the boat, not the camera or the world wind bearing',()=>{
  const b={length:20,beam:6,heading:0,propulsion:'sail'};
  advanceSails(b,.1,8,0);sailForces(b,8,0,0);
  assert.equal(instrumentReadout(b).degrees,-90);
  b.heading=90;advanceSails(b,.1,8,0);sailForces(b,8,0,0);
  assert.equal(instrumentReadout(b).direction,'Astern');
});

// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createImpactDetector,createHullAudioState} from '../js/weather-state.js';

const hullAudioContact=(changes={})=>({revision:1,reset:false,wet:1,pressure:.2,closing:0,impact:0,position:{x:2,y:0,z:-4},...changes});
function hullAudioAdvance(state,seconds,contact=hullAudioContact(),speed=3,dt=.05){
  let result;for(let t=0;t<seconds-1e-9;t+=dt){state.contact(contact);result=state.update(Math.min(dt,seconds-t),{speed});}return result;
}
function hullAudioRecord(values,index,{serial=0,strength=0,pressure=0,wet=1,closing=0,immersion=0}={}){
  const at=index*16;values[at]=index+1;values[at+1]=0;values[at+2]=-4;values[at+3]=pressure;values[at+7]=strength;
  values[at+11]=wet;values[at+12]=immersion;values[at+14]=closing;values[at+15]=serial;
}

test('hull sound contact summary retains continuous water pressure while accents require a fresh fore serial',()=>{
  const detector=createImpactDetector(),values=new Float32Array(40*16);
  hullAudioRecord(values,0,{pressure:.3,wet:1,closing:1.2,strength:.8});
  assert.equal(detector.sample(values,1),null,'initial contact must not produce an accent');
  assert.ok(detector.contact.pressure>0&&detector.contact.wet>0);assert.ok(Math.abs(detector.contact.closing-1.2)<1e-6);
  values[15]=1;assert.equal(detector.sample(values,1).kind,'light');
  values[3]=.7;assert.equal(detector.sample(values,1),null,'continuous bow pressure is a water bed, not repeated slaps');
  assert.ok(detector.contact.pressure>.02);
  hullAudioRecord(values,32,{serial:9,strength:3,pressure:2,closing:5});
  assert.equal(detector.sample(values,1),null,'stern-wake forcing cannot masquerade as a bow slam');
  assert.equal(detector.sample(values,2),null,'sea and vessel resets are silent');
});

test('re-entry classification requires observed exposure, wet return and relative closing',()=>{
  const detector=createImpactDetector(1),values=new Float32Array(16);
  hullAudioRecord(values,0,{wet:0,immersion:-.8});detector.sample(values,1,{draft:3});
  detector.sample(values,1,{draft:3});detector.sample(values,1,{draft:3});
  hullAudioRecord(values,0,{serial:1,strength:2,wet:1,closing:2,immersion:.1});
  assert.equal(detector.sample(values,1,{draft:3}).kind,'reentry');
  hullAudioRecord(values,0,{serial:2,strength:2,wet:1,closing:2,immersion:.2});
  assert.equal(detector.sample(values,1,{draft:3}).kind,'light','persistent immersion does not invent repeated lower-hull landings');
});

test('a passing wave receives one restrained accent, quiet time and recession before rearming',()=>{
  const state=createHullAudioState(),event={x:2,y:0,z:-4,strength:1,kind:'light',wet:1,closing:1};
  state.contact(hullAudioContact({reset:true}));assert.equal(state.impact(event),null);
  hullAudioAdvance(state,1.1);const first=state.impact(event);assert.equal(first.id,'hull-slap');
  assert.ok(first.gain<.1&&first.options.attack>0&&first.options.lowpassHz<2500);
  assert.equal(state.impact({...event,x:3}),null,'the next bow station is still the same wave');
  hullAudioAdvance(state,3,hullAudioContact({closing:1,impact:1}));assert.equal(state.impact(event),null,'a cooldown alone cannot retrigger persistent pressure');
  hullAudioAdvance(state,.55,hullAudioContact({closing:0,impact:0}));assert.ok(state.impact(event));
});

test('water rushing follows contact and signed speed, works at rest in waves and decays when dry',()=>{
  const ahead=createHullAudioState(),astern=createHullAudioState(),still=createHullAudioState();
  const a=hullAudioAdvance(ahead,2,hullAudioContact(),3),b=hullAudioAdvance(astern,2,hullAudioContact(),-3);
  assert.ok(Math.abs(a.wash-b.wash)<1e-10,'sternway still moves water along a hull');
  const waves=hullAudioAdvance(still,2,hullAudioContact({pressure:.7,closing:2}),0);assert.ok(waves.wash>.08,'wave wash exists without authored forward speed');
  const dry=hullAudioAdvance(ahead,4,hullAudioContact({wet:0,pressure:0,closing:0}),3);assert.ok(dry.wash<a.wash*.04);
  assert.ok(Number.isFinite(statefulWash(ahead)));
  function statefulWash(state){return state.update(NaN,{speed:NaN}).wash;}
});

test('re-entry retains wash without substituting an unaccepted crash or triggering a light slap',()=>{
  const state=createHullAudioState();hullAudioAdvance(state,1.1);
  const action=state.impact({x:0,y:0,z:0,strength:2,kind:'reentry',closing:2,wet:1});
  assert.equal(action,null,'no louder loop or rejected crash is presented as a bottom impact');
  assert.ok(state.update(.1,{speed:3}).wash>0,'the continuous contact-driven water bed remains');
  assert.equal(state.impact({x:0,y:0,z:0,strength:1,kind:'light',closing:1,wet:1}),null,'the same return cannot fall through to a splash accent');
  state.reset();assert.equal(state.impact({x:0,y:0,z:0,strength:3,kind:'reentry',closing:3,wet:1}),null);
  assert.equal(state.update(0).wash,0);assert.equal(state.impact({x:0,z:0,strength:NaN}),null);
});

test('constant-contact wash envelopes are independent of render frame partition',()=>{
  const a=createHullAudioState(),b=createHullAudioState();
  const fine=hullAudioAdvance(a,1,hullAudioContact(),2,1/60),coarse=hullAudioAdvance(b,1,hullAudioContact(),2,1/30);
  assert.ok(Math.abs(fine.wash-coarse.wash)<1e-10);
});

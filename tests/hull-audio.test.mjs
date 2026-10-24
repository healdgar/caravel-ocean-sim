// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createImpactDetector,createHullAudioState,createTimberAudioState,hullRelativeWaterSpeed,weatherAudioLevels} from '../js/weather-state.js';

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

test('waterline exposure never masquerades as underside re-entry',()=>{
  const detector=createImpactDetector(1),values=new Float32Array(16);
  hullAudioRecord(values,0,{wet:0,immersion:-.8});detector.sample(values,1,{draft:3});
  detector.sample(values,1,{draft:3});detector.sample(values,1,{draft:3});
  hullAudioRecord(values,0,{serial:1,strength:2,wet:1,closing:2,immersion:.1});
  assert.equal(detector.sample(values,1,{draft:3}).kind,'light');
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

test('a fresh underside return suppresses coincident slaps without inventing crash energy or sound',()=>{
  const state=createHullAudioState();hullAudioAdvance(state,1.1);
  const event={x:0,y:0,z:0,kind:'underside-reentry',closing:2,age:.1,probe:0,epoch:1,serial:1};
  assert.equal(state.underside(event),true,'encounter speed requires no fabricated strength');
  assert.equal(state.underside(event),false,'the same sampled episode cannot extend its quiet period');
  assert.ok(state.update(.1,{speed:3}).wash>0,'the continuous contact-driven water bed remains');
  assert.equal(state.impact({x:0,y:0,z:0,strength:1,kind:'light',closing:1,wet:1}),null,'the same return cannot fall through to a splash accent');
  state.reset();assert.equal(state.underside({...event,closing:NaN}),false);
  assert.equal(state.underside({...event,age:.5}),false,'stalled readbacks cannot replay old returns');
  assert.equal(state.underside({...event,age:-.1}),false);
  assert.equal(state.underside({...event,closing:-2}),false,'separating hull and water is not an impact');
  assert.equal(state.underside({...event,kind:'reentry'}),false,'waterline proxies cannot select the bottom-contact path');
  assert.equal(state.update(0).wash,0);assert.equal(state.impact({x:0,z:0,strength:NaN}),null);
});

test('constant-contact wash envelopes are independent of render frame partition',()=>{
  const a=createHullAudioState(),b=createHullAudioState();
  const fine=hullAudioAdvance(a,1,hullAudioContact(),2,1/60),coarse=hullAudioAdvance(b,1,hullAudioContact(),2,1/30);
  assert.ok(Math.abs(fine.wash-coarse.wash)<1e-10);
});

const timberFace=(changes={})=>({x:2,y:0,z:-4,strength:2,closing:2,wet:1,kind:'light',...changes});
const timberReturn=(changes={})=>({x:2,y:-1,z:-4,kind:'underside-reentry',closing:2,age:.1,probe:0,epoch:1,serial:1,revision:1,...changes});
function timberAdvance(state,seconds,{contact=hullAudioContact(),strain=0,audible=true,dt=.05,revision=contact.revision}={}){
  const sounds=[];
  for(let t=0;t<seconds-1e-9;t+=dt){
    state.contact(contact);
    const sound=state.update(Math.min(dt,seconds-t),{strain,position:{x:2,y:0,z:-4},revision,audible});
    if(sound)sounds.push(sound);
  }
  return sounds;
}

test('fresh hard water contact can groan without requiring large rigid-body motion',()=>{
  const state=createTimberAudioState(()=>0);
  state.contact(hullAudioContact({reset:true}));assert.equal(state.impact(timberFace()),null,'first/reset sample is silent');
  assert.deepEqual(timberAdvance(state,4.1),[],'a steady hull has no periodic strain creak');
  const sound=state.impact(timberFace());
  assert.equal(sound.id,'timber-creak');assert.equal(sound.spatial,true);
  assert.ok(sound.gain>=.1&&sound.gain<=.28&&sound.rate>=.9&&sound.rate<=.98);
  assert.equal(sound.options.duration,4);assert.ok(sound.options.attack>0&&sound.options.release>0);
});

test('timber contact episodes group bow stations and underside probes until recession and cooldown',()=>{
  const state=createTimberAudioState(()=>0);timberAdvance(state,4.1);
  const sounds=[];
  for(let probe=0;probe<10;probe++){const sound=state.underside(timberReturn({probe}));if(sound)sounds.push(sound);}
  assert.equal(sounds.length,1,'one lower-hull return, not ten groans');
  assert.equal(state.impact(timberFace()),null,'the bow and underside share the same acoustic episode');
  timberAdvance(state,6,{contact:hullAudioContact({closing:2,impact:2})});
  assert.equal(state.impact(timberFace({x:3})),null,'elapsed cooldown cannot retrigger persistent loading');
  timberAdvance(state,.55);
  assert.equal(state.underside(timberReturn({probe:0})),null,'a consumed probe serial stays consumed after recession');
  assert.ok(state.underside(timberReturn({probe:0,serial:2})),'a genuinely new return can groan');
});

test('periodic timber motion and contact strain share one cooldown without belated contact playback',()=>{
  const state=createTimberAudioState(()=>0);
  const periodic=timberAdvance(state,4.1,{strain:.2});assert.equal(periodic.length,1);assert.equal(periodic[0].spatial,false);
  assert.equal(state.impact(timberFace()),null,'a just-played motion creak blocks contact layering');
  assert.deepEqual(timberAdvance(state,5.2,{contact:hullAudioContact({closing:2,impact:2})}),[],'no queued contact replays at cooldown expiry');
  assert.equal(state.impact(timberFace()),null,'the blocked encounter was consumed');
  timberAdvance(state,.55);assert.ok(state.impact(timberFace()));
  assert.deepEqual(timberAdvance(state,.1,{strain:.3,contact:hullAudioContact({closing:2,impact:2})}),[],'contact also blocks a coincident periodic creak');
});

test('invalid, dry, separating, weak and stale face contacts cannot consume a timber episode',()=>{
  const state=createTimberAudioState(()=>0);timberAdvance(state,4.1);
  for(const changes of [{strength:.7},{closing:0},{closing:-3},{wet:0},{strength:NaN},{closing:Infinity},{x:NaN},{kind:'reentry'},{revision:0},{age:.36},{age:-.1},{age:NaN}])
    assert.equal(state.impact(timberFace(changes)),null,JSON.stringify(changes));
  state.update(.4);state.update(.4);state.update(.4);state.update(.1);
  // update caps elapsed time at .1 like the hull-audio envelope; four steps
  // without a refreshed contact exceed its .35-second freshness window.
  assert.equal(state.impact(timberFace()),null,'a stale summary cannot authorize a new groan');
  state.contact(hullAudioContact());assert.ok(state.impact(timberFace()),'invalid/stale events did not consume the episode or cooldown');
});

test('underside timber uses fresh revisioned returns and rejects old epochs and invalid serials',()=>{
  const state=createTimberAudioState(()=>0);timberAdvance(state,4.1);
  for(const changes of [{age:.36},{age:-.1},{closing:0},{closing:NaN},{revision:2},{probe:10},{probe:-1},{serial:1.5},{epoch:NaN},{z:Infinity}])
    assert.equal(state.underside(timberReturn(changes)),null,JSON.stringify(changes));
  assert.ok(state.underside(timberReturn({epoch:2})));
  timberAdvance(state,5.6);
  assert.equal(state.underside(timberReturn({epoch:1,serial:9})),null,'older epochs cannot play after rearming');
  assert.equal(state.underside(timberReturn({epoch:2})),null,'serial ledger survives the acoustic cooldown');
  assert.ok(state.underside(timberReturn({epoch:2,serial:2})));
});

test('timber gain follows bounded authored contact severity, without inventing force or impact energy',()=>{
  const mild=createTimberAudioState(()=>.5),strong=createTimberAudioState(()=>.5);
  timberAdvance(mild,4.1);timberAdvance(strong,4.1);
  const a=mild.impact(timberFace({strength:.8,closing:1.3})),b=strong.impact(timberFace({strength:100,closing:8}));
  assert.ok(a.gain<b.gain);assert.ok(b.gain<=.28);assert.equal(a.rate,b.rate);
  assert.equal('force' in b,false);assert.equal('energy' in b,false);
});

test('timber reset, teleport and mute cannot replay a pending contact or motion creak',()=>{
  const state=createTimberAudioState(()=>0);timberAdvance(state,4.1);assert.ok(state.impact(timberFace()));
  state.reset();assert.equal(state.impact(timberFace()),null);assert.equal(state.underside(timberReturn()),null);
  assert.deepEqual(timberAdvance(state,6,{audible:false,strain:.3}),[],'muted motion cannot schedule audible creaks');
  assert.deepEqual(timberAdvance(state,.1,{strain:0}),[],'there is no saved event to replay on resume');
  state.contact(hullAudioContact({revision:2,reset:true}));
  assert.equal(state.impact(timberFace({revision:1})),null);
  assert.equal(state.underside(timberReturn()),null,'an old return cannot cross a vessel teleport');
  timberAdvance(state,4.1,{contact:hullAudioContact({revision:2})});
  assert.ok(state.impact(timberFace({revision:2})));
});

test('timber episode recession and periodic scheduling are consistent at 30/60/120 Hz',()=>{
  for(const dt of [1/30,1/60,1/120]){
    const state=createTimberAudioState(()=>0);timberAdvance(state,4.1,{dt});assert.ok(state.impact(timberFace()));
    timberAdvance(state,5.2,{dt,contact:hullAudioContact({closing:2,impact:2})});
    assert.equal(state.impact(timberFace()),null);
    timberAdvance(state,.55,{dt});assert.ok(state.impact(timberFace()));
  }
});

test('continuous wash uses full hull-relative surge, leeway and current flow',()=>{
  assert.ok(Math.abs(hullRelativeWaterSpeed({speed:3,leeway:4})-5)<1e-12);
  assert.ok(Math.abs(hullRelativeWaterSpeed({speed:2,heading:0,currentZ:-2}))<1e-12,'following current cancels water-relative surge');
  assert.ok(Math.abs(hullRelativeWaterSpeed({speed:0,heading:90,currentZ:2})-2)<1e-12,'beam current produces lateral hull flow at anchor');
  const surgeOnly=createHullAudioState(),withLeeway=createHullAudioState(),anchoredInCurrent=createHullAudioState();
  for(let t=0;t<2;t+=.05){
    surgeOnly.contact(hullAudioContact({pressure:.1,closing:0}));surgeOnly.update(.05,{speed:1.5,leeway:0});
    withLeeway.contact(hullAudioContact({pressure:.1,closing:0}));withLeeway.update(.05,{speed:1.5,leeway:2.0});
    anchoredInCurrent.contact(hullAudioContact({pressure:.1,closing:0}));anchoredInCurrent.update(.05,{speed:0,heading:0,currentZ:2.5});
  }
  assert.ok(withLeeway.update(0,{speed:1.5,leeway:2.0}).wash>surgeOnly.update(0,{speed:1.5,leeway:0}).wash,'leeway increases hull-relative water wash');
  assert.ok(anchoredInCurrent.update(0,{speed:0,heading:0,currentZ:2.5}).wash>.1,'current past an anchored hull drives continuous wash');
  assert.ok(weatherAudioLevels({speed:0,leeway:2.5})['hull-wash']>0);
});

test('modest wave-face slaps retain peak/time/position across 8-frame readback, respect underside suppression and never trigger spray or timber groans',()=>{
  const detector=createImpactDetector(40),values=new Float32Array(72*16);
  const station=15,at=station*16,mat=(40+station)*16;
  // Seed frame: wet bow on a rising long swell, no ballistic spray serial.
  values[at]=1.8;values[at+1]=.1;values[at+2]=-9.5;values[at+3]=.25;values[at+7]=.05;values[at+11]=1;values[at+14]=.45;values[at+15]=0;
  values[mat]=1.8;values[mat+1]=.1;values[mat+2]=-9.5;values[mat+3]=1.0;values[mat+4]=0;values[mat+5]=0;values[mat+6]=1;values[mat+7]=0;
  values[mat+10]=.5;values[mat+14]=.9;values[mat+15]=0;
  assert.equal(detector.sample(values,1,{now:1.0}),null);
  // Modest slap occurred at t=1.42s, read back 5 frames later at t=1.50s after instantaneous impact already decayed.
  values[at]=1.9;values[at+1]=.02;values[at+2]=-9.7;values[at+7]=.02;values[at+14]=.38;values[at+15]=0;
  values[mat]=1.82;values[mat+1]=.18;values[mat+2]=-9.54;values[mat+3]=1.42;
  values[mat+4]=.11;values[mat+5]=.88;values[mat+6]=.95;values[mat+7]=1;
  values[mat+10]=.08;values[mat+14]=1.20;values[mat+15]=.52;
  const event=detector.sample(values,1,{now:1.50});
  assert.equal(event.kind,'modest');
  assert.ok(Math.abs(event.peakStrength-.11)<1e-6&&Math.abs(event.peakClosing-.88)<1e-6);
  assert.ok(Math.abs(event.time-1.42)<1e-6&&Math.abs(event.age-.08)<1e-6);
  assert.ok(Math.abs(event.x-1.82)<1e-6&&Math.abs(event.y-.18)<1e-6&&Math.abs(event.z+9.54)<1e-6,'retained event position survives later frame motion');
  assert.equal(detector.sample(values,1,{now:1.58}),null,'same modest serial cannot replay on subsequent readback');

  const hull=createHullAudioState(),timber=createTimberAudioState(()=>0);
  hullAudioAdvance(hull,1.1,hullAudioContact({closing:.42,relativeClosing:.05,lastTroughTime:1.2}));
  timberAdvance(timber,4.1);
  const sound=hull.impact(event);
  assert.equal(sound?.id,'hull-slap');assert.equal(sound?.kind,'modest');
  assert.ok(sound.gain>=.018&&sound.gain<.06);
  assert.equal(timber.impact(event),null,'modest wave-face slaps do not trigger heavy timber groans');
  assert.equal(hull.impact({...event,x:1.9,time:1.46}),null,'adjacent bow station on the same wave face stays grouped');
  // Even while long-swell closing remains .42 (> .24), trough recession in the short wave rearms modest slaps.
  hullAudioAdvance(hull,.75,hullAudioContact({closing:.42,relativeClosing:.04,lastTroughTime:1.75}));
  assert.equal(hull.impact({...event,time:2.20})?.kind,'modest','short-wave trough rearms next slap atop long swell');
  // Underside re-entry suppresses modest slaps during its 3.2s return window.
  assert.equal(hull.underside({x:0,y:-1,z:-4,kind:'underside-reentry',closing:2.1,age:.08,probe:0,epoch:1,serial:1}),true);
  hullAudioAdvance(hull,1.2,hullAudioContact({closing:.1,relativeClosing:.02,lastTroughTime:3.1}));
  assert.equal(hull.impact({...event,time:3.4}),null,'underside return suppresses modest slaps');
});

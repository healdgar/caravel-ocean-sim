// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createGunneryEffectState,gunnerySmokeParcel,GUNNERY_FX_LIMITS} from '../js/gunnery-effects.js';

const fxShot={position:[0,3,0],direction:[1,0,0],chargeKg:3};
test('cannon visuals consume real bounded shot/contact records and leave no idle simulation',()=>{
  const state=createGunneryEffectState();assert.equal(state.active,false);
  state.step(1,{wind:[12,0,0]});assert.deepEqual(state.shots,[]);assert.deepEqual(state.impacts,[]);
  assert.equal(state.emitShot({position:[NaN,1,0]}),false);assert.equal(state.emitShot({...fxShot,direction:[0,0,0]}),false);
  assert.equal(state.emitImpact({position:[0,0,0],velocity:[0,0,0]}),false);
  for(let i=0;i<400;i++){state.emitShot({...fxShot,id:i});state.emitImpact({id:i,position:[i,0,0],velocity:[200,-20,0]});}
  assert.equal(state.shots.length,GUNNERY_FX_LIMITS.shots);assert.equal(state.impacts.length,GUNNERY_FX_LIMITS.impacts);
  assert.equal(state.shots[0].id,400-GUNNERY_FX_LIMITS.shots);assert.equal(state.impacts[0].id,400-GUNNERY_FX_LIMITS.impacts);
  state.setProjectiles(Array.from({length:300},(_,id)=>({id,position:[id,2,0],radius:.075})));
  assert.equal(state.projectiles.length,GUNNERY_FX_LIMITS.projectiles);
  state.clear();assert.equal(state.active,false);
});

test('powder cloud momentum entrains to actual wind independently of frame partition',()=>{
  const a=createGunneryEffectState(),b=createGunneryEffectState();a.emitShot(fxShot);b.emitShot(fxShot);
  for(let i=0;i<120;i++)a.step(1/60,{wind:[8,0,-3]});
  for(let i=0;i<40;i++)b.step(.05,{wind:[8,0,-3]});
  assert.ok(Math.hypot(...a.shots[0].drift.map((v,k)=>v-b.shots[0].drift[k]))<1e-10);
  assert.ok(a.shots[0].drift[0]>5&&a.shots[0].drift[2]<-2);
  const early=a.shots[0].driftVelocity[0];for(let i=0;i<120;i++)a.step(1/60,{wind:[-8,0,3]});
  assert.ok(early>0&&a.shots[0].driftVelocity[0]<0,'wind reversal changes the advected cloud continuously');
});

test('three connected powder billows expand, decelerate, dilute and expire with no persistent flash',()=>{
  const state=createGunneryEffectState();state.emitShot(fxShot);const shot=state.shots[0];
  assert.equal(gunnerySmokeParcel(shot,1),null);
  const samples=[];for(const age of [.06,.15,.5,1,3,8,17,18]){shot.age=age;samples.push(gunnerySmokeParcel(shot,0));}
  for(const p of samples){assert.ok([...p.centre,...p.radii,p.extinction].every(Number.isFinite));assert.ok(p.radii.every(v=>v>0));}
  for(let i=1;i<samples.length;i++){assert.ok(samples[i].radii[0]>samples[i-1].radii[0]);assert.ok(samples[i].extinction<samples[i-1].extinction);}
  assert.ok(samples[1].centre[0]-samples[0].centre[0]>(samples[4].centre[0]-samples[3].centre[0])*.3,'initial muzzle momentum decays');
  assert.equal(samples.at(-1).extinction,0);
  shot.age=0;for(let i=0;i<80;i++)state.step(.25,{wind:[0,0,0]});assert.equal(state.active,false);
  assert.ok(GUNNERY_FX_LIMITS.flashSeconds<.1);
});

test('roundshot poses and fixed impact births are copied without altering ballistics',()=>{
  const state=createGunneryEffectState(),position=[1,2,3];state.setProjectiles([{id:7,position,radius:.08},{position:[Infinity,2,3]}]);
  position[0]=90;assert.deepEqual(state.projectiles,[{id:7,position:[1,2,3],radius:.08}]);
  const impact={position:[2,.7,5],velocity:[180,-25,10],massKg:14};state.emitImpact(impact);state.step(.2,{wind:[10,0,0]});
  assert.deepEqual(state.impacts[0].position,[2,.7,5]);assert.deepEqual(state.impacts[0].velocity,[180,-25,10]);
  assert.equal(state.projectiles[0].position[1],2,'only the ballistics owner moves a projectile');
});

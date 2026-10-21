import {test} from 'node:test';
import assert from 'node:assert/strict';
import {GUNNERY_LIMITS,GUNNERY_STAGE_DURATIONS,createGunneryState,prepareGunnery,fireGunnery,stepGunnery,gunnerySummary,resolveGunneryImpact} from '../js/gunnery-state.js';

const fastDrill={swab:.05,load:.05,ram:.05,runout:.05,prime:.05};
const gunDef=(id=0,side='starboard',extra={})=>({id,side,calibre:32,dispersion:0,speedVariation:0,durations:fastDrill,...extra});
const clearEnv={muzzle:()=>({position:[0,30,0],direction:[1,0,0],velocity:[0,0,0]}),surfaceHeight:()=>-Infinity};
function advance(state,seconds,environment=clearEnv,dt=1/60){
  const events=[];let remaining=seconds;
  while(remaining>1e-10){const take=Math.min(dt,remaining);events.push(...stepGunnery(state,take,environment));remaining-=take;}
  return events;
}
function loaded(defs=[gunDef()],options={}){
  const state=createGunneryState(defs,options);prepareGunnery(state,'port');prepareGunnery(state,'starboard');advance(state,.3);return state;
}
const close=(actual,wanted,tolerance=1e-8)=>assert.ok(Math.abs(actual-wanted)<=tolerance,`${actual} differs from ${wanted} by more than ${tolerance}`);

test('gunnery definitions distinguish nominal shot weight from bore and bound independent pools',()=>{
  const state=createGunneryState([{id:0,side:-1,calibre:32},{id:1,side:1,calibre:68,kind:'carronade'}]);
  assert.equal(state.guns[0].side,'port');assert.equal(state.guns[1].side,'starboard');
  close(state.guns[0].mass,32*.45359237);assert.ok(state.guns[0].diameter>.15&&state.guns[0].diameter<.16);
  assert.equal(state.guns[0].muzzleSpeed,487.68);assert.equal(state.guns[1].muzzleSpeed,300);
  assert.deepEqual(state.guns[0].durations,GUNNERY_STAGE_DURATIONS);
  assert.equal(state.guns[0].stage,'secured');assert.equal(fireGunnery(state,'port'),0);
  assert.throws(()=>createGunneryState([gunDef(0),gunDef(0)]),/unique ids/);
  assert.throws(()=>createGunneryState([{id:0,side:'bow'}]),/port\/starboard/);
  assert.throws(()=>createGunneryState(Array.from({length:129},(_,i)=>gunDef(i))),/128/);
});

test('explicit preparation visits every drill stage; physical crew attendance pauses work and runout',()=>{
  const state=createGunneryState([gunDef(0,'port',{durations:{swab:.1,load:.1,ram:.1,runout:.2,prime:.1}})]),gun=state.guns[0];
  assert.equal(prepareGunnery(state,'starboard'),0);assert.equal(prepareGunnery(state,'port'),1);
  advance(state,.5,{...clearEnv,gunAttended:()=>false});assert.equal(gun.elapsed,0);assert.equal(gun.stage,'swab');
  assert.equal(prepareGunnery(state,'port'),0,'same captain order cannot reset progress');
  const stages=new Set(),events=[];
  for(let i=0;i<90;i++){
    stages.add(gun.stage);events.push(...stepGunnery(state,1/120,clearEnv));
    if(gun.stage==='runout'&&gun.progress>.2&&gun.progress<.8){
      assert.ok(gun.offset>0&&gun.offset<gun.recoilLength);
      const progress=gun.progress,offset=gun.offset;
      advance(state,.1,{...clearEnv,gunAttended:()=>false});assert.equal(gun.progress,progress);assert.equal(gun.offset,offset);
    }
  }
  assert.deepEqual([...stages],['swab','load','ram','runout','prime','ready']);
  assert.equal(events.filter(e=>e.type==='ready').length,1);assert.equal(gun.offset,0);
  assert.equal(gun.loading,false);assert.equal(state.projectiles.length,0,'ready waits indefinitely for the captain');
  advance(state,5);assert.equal(gun.roundsFired,0);assert.equal(prepareGunnery(state,'port'),0);
});

test('a fire order snapshots ready guns only, staggers gun captains and never repeats on held order',()=>{
  const state=loaded([gunDef(0),gunDef(1),gunDef(2,'port'),gunDef(3,'starboard',{durations:{...fastDrill,swab:10}})]);
  assert.equal(fireGunnery(state,'starboard'),2);assert.equal(fireGunnery(state,'starboard'),0);
  const events=advance(state,1),shots=events.filter(e=>e.type==='shot');
  assert.deepEqual(shots.map(e=>e.gunId),[0,1]);close(shots[1].time-shots[0].time,.14);
  assert.equal(state.guns[2].roundsFired,0);assert.equal(state.guns[3].roundsFired,0);
  assert.equal(state.queue.length,0);assert.equal(state.guns[0].stage,'spent');
  advance(state,15);assert.equal(state.guns[3].stage,'ready');assert.equal(state.guns[3].roundsFired,0,'old fire order cannot catch a later loaded gun');
  assert.equal(state.guns[0].roundsFired,1);assert.equal(state.guns[0].loading,false);
  assert.equal(gunnerySummary(state,'port').ready,1);
});

test('a shot inherits full rigid hull velocity and emits exactly one opposite momentum impulse',()=>{
  const state=loaded([gunDef(0,'starboard',{muzzleSpeed:400})],{airDensity:0,gravity:0}),seen=[];
  const direction=[Math.sqrt(.5),.5,-.5],velocity=[3,1.25,-5];
  fireGunnery(state,'starboard');const events=stepGunnery(state,1/60,{...clearEnv,muzzle:()=>({position:[7,12,-9],direction,velocity}),onEvent:e=>seen.push(e)});
  const shot=events.find(e=>e.type==='shot');assert.ok(shot);assert.equal(seen.filter(e=>e.type==='shot').length,1);
  for(let i=0;i<3;i++){
    close(shot.velocity[i],direction[i]*400+velocity[i]);
    close(shot.impulse[i],-direction[i]*400*state.guns[0].mass*1.25);
  }
  const projectile=state.projectiles[0];for(let i=0;i<3;i++)close(projectile.position[i],shot.position[i]+shot.velocity[i]*(projectile.time-shot.time));
  advance(state,1,{...clearEnv,onEvent:e=>seen.push(e)});assert.equal(seen.filter(e=>e.type==='shot').length,1);
  assert.ok(state.guns[0].offset>0,'carriage remains run in after recoil');
  assert.equal(state.guns[0].stage,'spent');assert.equal(prepareGunnery(state,'starboard'),1);
  assert.equal(state.guns[0].stage,'swab');
});

test('zero-drag flight agrees with analytical gravity rather than an authored visual arc',()=>{
  const state=loaded([gunDef(0,'starboard',{muzzleSpeed:100})],{airDensity:0});fireGunnery(state,'starboard');
  const env={...clearEnv,muzzle:()=>({position:[1,50,3],direction:[1,0,0],velocity:[3,2,-4]})};
  const shot=advance(state,1.2,env).find(e=>e.type==='shot'),p=state.projectiles[0],t=p.time-shot.time;
  close(p.position[0],1+103*t,1e-9);close(p.position[1],50+2*t-.5*state.gravity*t*t,1e-9);
  close(p.position[2],3-4*t,1e-9);close(p.velocity[1],2-state.gravity*t,1e-9);
});

test('quadratic spherical drag matches its one-dimensional solution and responds to relative wind',()=>{
  const def=gunDef(0,'starboard',{muzzleSpeed:487.68}),state=loaded([def],{gravity:0});
  fireGunnery(state,'starboard');const shot=advance(state,2).find(e=>e.type==='shot'),p=state.projectiles[0],t=p.time-shot.time;
  const k=.5*state.airDensity*p.dragCoefficient*Math.PI*p.radius*p.radius/p.mass;
  const wantedVelocity=shot.muzzleSpeed/(1+k*shot.muzzleSpeed*t),wantedDistance=Math.log1p(k*shot.muzzleSpeed*t)/k;
  close(p.velocity[0],wantedVelocity,.002);close(p.position[0],wantedDistance,.004);assert.ok(p.velocity[0]<shot.muzzleSpeed);
  const tailwind=loaded([def],{gravity:0});fireGunnery(tailwind,'starboard');advance(tailwind,2,{...clearEnv,windVelocity:[30,0,0]});
  assert.ok(tailwind.projectiles[0].velocity[0]>p.velocity[0]);
  const crosswind=loaded([def],{gravity:0});fireGunnery(crosswind,'starboard');advance(crosswind,2,{...clearEnv,windVelocity:[0,0,20]});
  assert.ok(crosswind.projectiles[0].position[2]>0);assert.ok(crosswind.projectiles[0].velocity[2]>0);
});

test('fixed physics and seeded dispersion are independent of render-frame partition',()=>{
  const defs=Array.from({length:4},(_,i)=>gunDef(i,'starboard',{dispersion:.004,speedVariation:.008}));
  const a=loaded(defs,{seed:99}),b=loaded(defs,{seed:99}),c=loaded(defs,{seed:100});
  for(const state of[a,b,c])fireGunnery(state,'starboard');
  const ea=advance(a,2,clearEnv,1/60),eb=advance(b,2,clearEnv,1/30),ec=advance(c,2,clearEnv,1/60);
  // The GPU sweep's frame-start pose intentionally depends on frame duration;
  // all physical state and fixed-tick history must remain byte-identical.
  const physical=state=>state.projectiles.map(({previous,previousTime,...p})=>p);
  assert.deepEqual(physical(a),physical(b));assert.deepEqual(ea.filter(e=>e.type==='shot').map(e=>e.velocity),eb.filter(e=>e.type==='shot').map(e=>e.velocity));
  assert.notDeepEqual(ea.filter(e=>e.type==='shot').map(e=>e.velocity),ec.filter(e=>e.type==='shot').map(e=>e.velocity));
  assert.equal(a.seed,b.seed);assert.equal(a.guns.every(g=>g.roundsFired===1),true);
});

test('swept first contact catches narrow wave crests between two above-water integration endpoints',()=>{
  const state=loaded([gunDef(0,'starboard',{muzzleSpeed:600,diameter:.1})],{airDensity:0,gravity:0});
  fireGunnery(state,'starboard');
  const surfaceHeight=(x,z,t)=>Math.abs(x-2.1)<.3?3:0;
  const env={surfaceHeight,muzzle:()=>({position:[0,2,0],direction:[1,0,0],velocity:[0,0,0]})};
  const events=stepGunnery(state,1/60,env),hits=events.filter(e=>e.type==='impact');
  assert.equal(hits.length,1);assert.equal(state.projectiles.length,0);
  assert.ok(hits[0].position[0]>1.79&&hits[0].position[0]<1.81,'first rising face, not end of segment');
  assert.equal(hits[0].surfacePosition[1],3);assert.equal(hits[0].kind,'water');
  assert.equal(advance(state,1,env).filter(e=>e.type==='impact').length,0,'one splash per shot contact');
});

test('moving sea is sampled at projectile time and solid sweeps select the earlier contact',()=>{
  const state=loaded([gunDef(0,'starboard',{muzzleSpeed:100,diameter:.1})],{airDensity:0,gravity:0});
  const birth=state.time;fireGunnery(state,'starboard');
  const env={muzzle:()=>({position:[0,1,0],direction:[1,0,0],velocity:[0,0,0]}),surfaceHeight:(x,z,t)=>(t-birth)*20};
  const hits=advance(state,.2,env).filter(e=>e.type==='impact');assert.equal(hits.length,1);
  close(hits[0].time-birth,.95/20,2e-6);close(hits[0].surfacePosition[1],.95,3e-5);
  const blocked=loaded([gunDef()],{airDensity:0,gravity:0});fireGunnery(blocked,'starboard');
  const events=stepGunnery(blocked,1/60,{...clearEnv,sweep:()=>({fraction:.2,kind:'terrain',body:'rock'})});
  const hit=events.find(e=>e.type==='impact');assert.equal(hit.kind,'terrain');assert.equal(hit.body,'rock');
  assert.equal(blocked.projectiles.length,0);
});

test('submerged, invalid or obstructed muzzles neither spend a round nor kick the hull',()=>{
  for(const [environment,reason]of[
    [{muzzle:()=>({position:[0,0,0],direction:[1,0,0]})},'submerged'],
    [{muzzle:()=>({position:[0,4,0],direction:[0,0,0]})},'muzzle'],
    [{...clearEnv,canFire:()=>false},'obstructed'],
  ]){
    const state=loaded();fireGunnery(state,'starboard');const events=stepGunnery(state,1/60,environment);
    assert.equal(events.filter(e=>e.type==='shot').length,0);assert.equal(events.find(e=>e.type==='blocked')?.reason,reason);
    assert.equal(state.guns[0].stage,'ready');assert.equal(state.guns[0].roundsFired,0);assert.equal(state.guns[0].offset,0);
  }
});

test('bounded pools, finite lifetimes, frame gaps and invalid dt cannot leak or trigger runaway fire',()=>{
  const state=loaded([gunDef(0),gunDef(1)],{maxProjectiles:1,maxFlight:.5,maxEvents:2});
  fireGunnery(state,'starboard');const events=advance(state,.3);
  assert.equal(events.filter(e=>e.type==='shot').length,1);assert.ok(events.some(e=>e.reason==='capacity'));
  assert.equal(state.projectiles.length,1);assert.equal(state.guns[1].roundsFired,0);
  advance(state,1);assert.equal(state.projectiles.length,0);
  assert.equal(fireGunnery(state,'starboard'),1);const callback=[];
  stepGunnery(state,120,{...clearEnv,onEvent:e=>callback.push(e)});assert.ok(state.events.length<=2);
  close(state.droppedTime,120-GUNNERY_LIMITS.maxAdvance);assert.equal(callback.filter(e=>e.type==='shot').length,1);
  const time=state.time,position=state.projectiles.map(p=>[...p.position]);
  for(const dt of[0,-1,NaN,Infinity])assert.deepEqual(stepGunnery(state,dt,clearEnv),[]);
  assert.equal(state.time,time);assert.deepEqual(state.projectiles.map(p=>p.position),position);
  advance(state,1);assert.equal(state.projectiles.length,0);assert.equal(state.queue.length,0);
});

test('recoil can finish before a new explicit loading cycle and never jumps instantly back out',()=>{
  const state=loaded();fireGunnery(state,'starboard');stepGunnery(state,1/120,clearEnv);const gun=state.guns[0];
  assert.equal(gun.stage,'recoil');assert.equal(prepareGunnery(state,'starboard'),1);
  advance(state,.3);assert.equal(gun.stage,'recoil');assert.ok(gun.offset>0&&gun.offset<gun.recoilLength);
  const held=gun.offset;advance(state,.6,{...clearEnv,gunAttended:()=>false});
  assert.equal(gun.stage,'swab');assert.equal(gun.offset,gun.recoilLength);assert.ok(gun.offset>=held);
  advance(state,1);assert.equal(gun.stage,'ready');assert.equal(gun.offset,0);assert.equal(gun.roundsFired,1);
});

test('deferred GPU sea sweeps retain a whole-frame segment and dispatch one delayed contact on next step',()=>{
  const state=loaded([gunDef(0,'starboard',{muzzleSpeed:100})],{airDensity:0}),seen=[];
  const env={deferSeaCollision:true,muzzle:()=>({position:[0,-1,0],direction:[1,0,0],velocity:[0,0,0]}),onEvent:e=>seen.push(e)};
  fireGunnery(state,'starboard');const shots=stepGunnery(state,1/30,env).filter(e=>e.type==='shot');assert.equal(shots.length,1,'no invented flat-plane muzzle rejection');
  assert.equal(state.projectiles.length,1,'GPU sea owns contact even below mean water');
  const p=state.projectiles[0];close(p.previous[0],0);close(p.position[0],100/30);close(p.previousTime,p.born);
  stepGunnery(state,1/30,env);close(p.previous[0],100/30);close(p.position[0],200/30);
  const contactTime=p.born+.02,position=[2,-1-.5*state.gravity*.02**2,0];
  const hit=resolveGunneryImpact(state,p.id,{position,time:contactTime,normal:[0,1,0]});assert.equal(hit.type,'impact');
  close(hit.velocity[1],-state.gravity*.02,1e-10);assert.equal(state.projectiles.length,0);assert.equal(state.pendingEvents.length,1);
  assert.equal(seen.filter(e=>e.type==='impact').length,0,'async result is not prematurely dispatched');
  assert.equal(resolveGunneryImpact(state,p.id,{position}),null,'duplicate readback cannot create another impact');
  const dispatched=stepGunnery(state,1/60,env).filter(e=>e.type==='impact');assert.equal(dispatched.length,1);
  assert.equal(dispatched[0].id,hit.id);assert.equal(seen.filter(e=>e.type==='impact').length,1);assert.equal(state.pendingEvents.length,0);
  assert.equal(stepGunnery(state,1/60,env).filter(e=>e.type==='impact').length,0);
});

test('deferred contact history and pending impact storage stay bounded, and invalid contacts preserve the shot',()=>{
  const state=loaded([gunDef()],{gravity:0}),env={...clearEnv,deferSeaCollision:true};fireGunnery(state,'starboard');advance(state,2,env);
  const p=state.projectiles[0];assert.ok(p.history.length<=32);
  assert.equal(resolveGunneryImpact(state,p.id,{position:[NaN,0,0]}),null);assert.equal(state.projectiles.length,1);
  assert.equal(resolveGunneryImpact(state,1000,{position:[0,0,0]}),null);
  resolveGunneryImpact(state,p.id,{position:[1,0,0]});const events=stepGunnery(state,0,env);
  assert.equal(events.filter(e=>e.type==='impact').length,1,'paused frame still drains completed GPU result');
  assert.equal(stepGunnery(state,0,env).length,0);
});

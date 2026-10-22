import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {crewMotionPolicy,crewAdvanceWalk,crewTurnTowards,crewDeckHazard} from '../js/crew-motion.js';
import {createDeckhand,stepDeckhand,createCompany,stepCompany} from '../js/crew.js';
import {loadCrewGLB} from '../js/gltf.js';
import {getShipModel} from '../js/ship-models.js';
import {createGunDefinitions} from '../js/gunnery-models.js';
import {createGunneryState,prepareGunnery,stepGunnery,GUNNERY_STAGE_DURATIONS} from '../js/gunnery-state.js';

const paceBoat={modelId:'nina',length:20,beam:6,roll:0,rollVelocity:0,pitch:0};
const paceClose=(a,b,e=1e-10)=>assert.ok(Math.abs(a-b)<=e,`${a} differs from ${b}`);
const paceDistance=(a,b)=>Math.hypot(...Array.from(a,(v,i)=>v-b[i]));

test('purposeful deck pace has physical caps and slows for slope, heel, narrow space and hazards',()=>{
  const patrol=crewMotionPolicy(paceBoat),work=crewMotionPolicy(paceBoat,{purpose:'work'});
  paceClose(patrol.speedMetresPerSecond,1.25);paceClose(work.speedMetresPerSecond,1.4);
  assert.ok(patrol.turnRadiansPerSecond>0&&patrol.turnRadiansPerSecond<=4);
  assert.ok(patrol.strideMetres>=1.2&&patrol.strideMetres<=1.4,'a complete human Walk cycle covers two steps');
  for(const purpose of ['patrol','work'])for(const grade of [-2,-.5,0,.5,2])for(const roll of [0,.12,.3]){
    const base=crewMotionPolicy(paceBoat,{purpose}),state={...paceBoat,roll,rollVelocity:.12,pitch:.1};
    const normal=crewMotionPolicy(state,{purpose,grade}),tight=crewMotionPolicy(state,{purpose,grade,constrained:true});
    for(const policy of [normal,tight])assert.ok(Object.values(policy).every(Number.isFinite)&&policy.speedMetresPerSecond>0&&policy.speedMetresPerSecond<=base.speedMetresPerSecond);
    assert.ok(tight.speedMetresPerSecond<normal.speedMetresPerSecond);
    assert.equal(crewMotionPolicy(state,{purpose,grade,hazard:true}).speedMetresPerSecond,0);
    if(grade!==0)assert.ok(normal.speedMetresPerSecond<crewMotionPolicy(state,{purpose}).speedMetresPerSecond);
    paceClose(normal.speedMetresPerSecond,crewMotionPolicy(state,{purpose,grade:-grade}).speedMetresPerSecond);
  }
  assert.throws(()=>crewMotionPolicy(paceBoat,{purpose:'run'}));assert.throws(()=>crewMotionPolicy(paceBoat,{grade:NaN}));
});

test('existing brace entry and release thresholds retain hysteresis',()=>{
  for(const [key,enter,release]of [['roll',.36,.26],['rollVelocity',.5,.3]])for(const sign of [-1,1]){
    assert.equal(crewDeckHazard({...paceBoat,[key]:sign*(enter+.001)},0,false),true);
    assert.equal(crewDeckHazard({...paceBoat,[key]:sign*(release+.001)},0,true),true);
    assert.equal(crewDeckHazard({...paceBoat,[key]:sign*(release-.001)},0,true),false);
    assert.equal(crewDeckHazard({...paceBoat,[key]:sign*((enter+release)/2)},0,false),false);
  }
  assert.equal(crewDeckHazard(paceBoat,23.01,false),true);assert.equal(crewDeckHazard(paceBoat,20,true),true);assert.equal(crewDeckHazard(paceBoat,18.99,true),false);
});

test('actual male and female Walk duration advances by distance, independent of frame partition or work clocks',()=>{
  for(const name of ['sailor.glb','sailor-female.glb']){
    const animator=loadCrewGLB(readFileSync(new URL('../assets/crew/'+name,import.meta.url))).animator,clipDuration=animator.clips.get('Walk').duration;
    assert.ok(clipDuration>1.3&&clipDuration<1.4,'read the complete actual clip rather than assuming one-second cadence');
    const results=[];
    for(const frames of [1,30,60,120]){
      const s={walkDistance:.4,walkTime:.7,walkClipDuration:clipDuration,time:12,workElapsed:8,rowPhase:.3};
      for(let i=0;i<frames;i++)crewAdvanceWalk(s,2.6/frames,{strideMetres:1.3});
      paceClose(s.walkDistance,3);paceClose(s.walkTime,.7+2*clipDuration);results.push(s.walkTime);
      const before={...s};crewAdvanceWalk(s,0);assert.deepEqual(s,before,'turning, blocked and waiting feet do not advance');
      assert.deepEqual([s.time,s.workElapsed,s.rowPhase],[12,8,.3],'distance changes no simulation, reload or rowing clock');
    }
    assert.ok(Math.max(...results)-Math.min(...results)<1e-12);
  }
  for(const invalid of [-1,NaN,Infinity])assert.throws(()=>crewAdvanceWalk({},invalid));
  assert.throws(()=>crewAdvanceWalk({},1,{strideMetres:0}));assert.throws(()=>crewAdvanceWalk({},1,{clipDuration:0}));
});

test('bounded deck turns follow the short arc and compose across frame partitions',()=>{
  for(const [start,end]of [[Math.PI-.02,-Math.PI+.02],[0,Math.PI*.75],[1,-1]]){
    const total=.2,rate=2,whole=crewTurnTowards(start,end,total,rate);let split=start;
    for(let i=0;i<24;i++)split=crewTurnTowards(split,end,total/24,rate);
    paceClose(split,whole);assert.ok(Math.abs(Math.atan2(Math.sin(whole-start),Math.cos(whole-start)))<=total*rate+1e-12);
  }
  assert.equal(crewTurnTowards(.3,2,.1,0),.3);assert.throws(()=>crewTurnTowards(0,1,-1,2));
});

test('real unobstructed deck movement attains the authored pace without moonwalking while waiting or braced',()=>{
  const final=[];
  for(const fps of [30,60,120]){
    const s=createDeckhand();s.wait=0;s.yaw=0;stepDeckhand(s,paceBoat,0,0);
    const origin=Array.from(s.position),startTime=s.walkTime;let travelled=0;
    for(let i=0;i<fps;i++){
      const before=Array.from(s.position);stepDeckhand(s,paceBoat,1/fps,0);const distance=paceDistance(s.position,before);
      assert.ok(distance<=1.25/fps+2e-6,'no per-frame station teleport');travelled+=distance;
    }
    assert.ok(travelled>1.15&&travelled<=1.25001,'safe deck patrol is a purposeful human walk');
    paceClose(s.walkTime-startTime,travelled/1.3*(4/3),3e-6);final.push(Array.from(s.position));
    assert.ok(paceDistance(s.position,origin)>1.15);
    s.order='standby';s.decisionIn=0;const stopped=Array.from(s.position),gait=s.walkTime;
    for(let i=0;i<fps;i++)stepDeckhand(s,paceBoat,1/fps,0);
    assert.deepEqual(Array.from(s.position),stopped);assert.equal(s.walkTime,gait);
    s.order='patrol';s.decisionIn=0;
    for(let i=0;i<fps;i++)stepDeckhand(s,{...paceBoat,roll:.5},1/fps,0);
    assert.deepEqual(Array.from(s.position),stopped);assert.equal(s.walkTime,gait);assert.equal(s.intent,'brace');
  }
  for(const position of final)assert.ok(paceDistance(position,final[0])<2e-5,'same physical travel at 30/60/120 Hz');
});

test('seated strokes and gun loading retain their independent physical clocks',()=>{
  for(const id of ['oseberg','lusoria','taino-canoe']){
    const model=getShipModel(id),boat={modelId:id,model,...model.runtime,roll:0,rollVelocity:0,sailFore:1,sailMain:1,sailMizzen:1},company=createCompany(undefined,id);
    stepCompany(company,boat,0,3);const phase=boat.rowingState?.phase;
    const rowers=company.crew.filter(s=>s.seatedPose),before=rowers.map(s=>s.walkTime);assert.ok(rowers.length>20);
    for(let i=0;i<20;i++)stepCompany(company,boat,.1,3);
    assert.equal(boat.rowingState?.phase,phase,'crew cannot advance propulsion-owned rowing phase');
    assert.deepEqual(rowers.map(s=>s.walkTime),before,'seated rowers have no deck-walking cadence');
  }
  assert.deepEqual(GUNNERY_STAGE_DURATIONS,{swab:6,load:8,ram:7,runout:8,prime:4});
  for(const fps of [30,60,120]){
    const state=createGunneryState([createGunDefinitions('victory').find(g=>g.visibleCrew)]);prepareGunnery(state,'port');
    for(let i=0;i<fps*32;i++)stepGunnery(state,1/fps,{gunAttended:()=>true});
    assert.equal(state.guns[0].stage,'prime','faster feet cannot accelerate the 33-second drill');
    for(let i=0;i<fps;i++)stepGunnery(state,1/fps,{gunAttended:()=>true});
    assert.equal(state.guns[0].stage,'ready');assert.equal(state.projectiles.length,0);
  }
});

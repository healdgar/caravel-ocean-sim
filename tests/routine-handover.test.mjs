// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createRoutineHandover,stepRoutineHandover,routineHandoverCommands,
  canBeginYardTransfer} from '../js/routine-handover.js';

const wind=(side=1,angle=90,speed=8)=>({speed,angle:angle*Math.PI/180,across:side*speed});
const crew=state=>({generation:state.generation,reservedMask:7,aloftClearMask:7,deckClearMask:7});
const geometry=(state,revision=1)=>({generation:state.generation,revision,
  kind:'sheet-and-release-sweep',targetSide:state.targetSide,clear:true});
const initial=side=>createRoutineHandover({workingSide:side,
  policy:{dwell:.2,takeUpRate:2,sheetRate:2,releaseRate:2}});
function tick(state,options={}){
  return stepRoutineHandover(state,.1,{observation:wind(1),geometryRevision:1,...options});
}
function capture(state=initial(-1)){
  state=tick(state);state=tick(state);assert.equal(state.phase,'wait-clear');return state;
}
function toGate(state=capture()){
  for(let i=0;i<20&&state.phase!=='wait-geometry';i++)state=tick(state,{crewAck:crew(state)});
  assert.equal(state.phase,'wait-geometry');return state;
}

test('pure stepping leaves input, yard/force objects and returned command copies independent',()=>{
  const state=initial(-1),before=structuredClone(state),external={yardSide:-1,force:123};
  const next=tick(state,{...external});assert.deepEqual(state,before);
  next.controls[0].supportEase.port=99;assert.equal(state.controls[0].supportEase.port,1);
  const commands=routineHandoverCommands(state);commands.controls[0].supportEase.port=88;
  assert.equal(state.controls[0].supportEase.port,1);assert.deepEqual(external,{yardSide:-1,force:123});
  assert.equal(commands.appliedToGeometry,false);
});

test('calm, headwind and dead-run hysteresis retain side; dwell rejects rapid crossings',()=>{
  let state=initial(-1);
  for(let i=0;i<100;i++)state=tick(state,{observation:wind(i%2?1:-1,1)});
  assert.equal(state.generation,0);assert.equal(state.workingSide,-1);
  state=tick(state,{observation:wind(1,50)}); // still inside headwind exit cone
  assert.equal(state.candidateSide,null);
  state=tick(state,{observation:wind(1,90,.3)});
  state=tick(state,{observation:wind(1,90,.6)});assert.equal(state.latch.calm,true);
  state=tick(state,{observation:wind(1,175)});state=tick(state,{observation:wind(1,165)});
  assert.equal(state.latch.deadRun,true);assert.equal(state.candidateSide,null);
  for(let i=0;i<100;i++)state=tick(state,{observation:wind(i%2?1:-1,90)});
  assert.equal(state.generation,0,'each usable crossing must itself survive the dwell');
  state=tick(state);state=tick(state);assert.equal(state.generation,1);
});

test('reservation and matching aloft/deck acknowledgments precede any control movement',()=>{
  let state=capture(),controls=structuredClone(state.controls);
  assert.equal(canBeginYardTransfer(state),false);
  assert.deepEqual(routineHandoverCommands(state).reserveRunnersMask,7);
  for(const ack of [undefined,{...crew(state),generation:0},{...crew(state),reservedMask:3},
    {...crew(state),aloftClearMask:6},{...crew(state),deckClearMask:3}]){
    state=tick(state,{crewAck:ack});assert.equal(state.phase,'wait-clear');assert.deepEqual(state.controls,controls);
  }
  state=tick(state,{crewAck:crew(state),observation:wind(1,5)});
  assert.equal(state.phase,'wait-clear','in-irons latch holds even with all crew clear');
  state=tick(state,{crewAck:crew(state)});state=tick(state,{crewAck:crew(state)});
  assert.equal(state.phase,'take-up-new-support');assert.equal(state.physicalStarted,false);
});

test('new windward support tensions monotonically while old loaded support remains taut; geometry gate stays shut',()=>{
  let state=capture(),previous=1;
  for(let i=0;i<30&&state.phase!=='wait-geometry';i++){
    state=tick(state,{crewAck:crew(state)});
    for(const control of state.controls){
      assert.ok(control.supportEase.port<=previous+1e-12);
      assert.equal(control.supportEase.starboard,0,'old windward set must remain taut');
      assert.equal(control.sheetBlend,0,'sheet crossing has not been proven');
    }
    previous=state.controls[0].supportEase.port;
  }
  assert.equal(state.phase,'wait-geometry');
  const held=structuredClone(state.controls);
  for(let i=0;i<100;i++)state=tick(state,{crewAck:crew(state)});
  assert.equal(state.phase,'wait-geometry');assert.deepEqual(state.controls,held);
  for(const ack of [{...geometry(state),clear:false},{...geometry(state),generation:state.generation-1},
    {...geometry(state),revision:2},{...geometry(state),targetSide:-1}]){
    state=tick(state,{crewAck:crew(state),geometryAck:ack});assert.equal(state.phase,'wait-geometry');
  }
});

test('captured side finishes after motion begins, with sheet sweep before old support release',()=>{
  let state=toGate(),sawSheet=false,sawRelease=false;
  for(let i=0;i<100&&state.phase!=='hold';i++){
    const before=state;
    state=tick(state,{observation:wind(-1),crewAck:crew(state),geometryAck:geometry(state)});
    assert.equal(state.targetSide,1,'late reversal cannot retarget physical motion');
    if(state.phase==='hand-sheets')sawSheet=true;
    if(state.phase==='release-old-support')sawRelease=true;
    if(before.phase==='hand-sheets')assert.ok(state.controls.every(c=>c.supportEase.port===0&&c.supportEase.starboard===0));
    if(before.phase==='release-old-support')assert.ok(state.controls.every(c=>c.supportEase.port===0));
  }
  assert.ok(sawSheet&&sawRelease);assert.equal(state.phase,'hold');assert.equal(state.workingSide,1);
  assert.equal(state.reserved,false);assert.equal(canBeginYardTransfer(state),true);
  assert.ok(state.controls.every(c=>c.supportEase.port===0&&c.supportEase.starboard===1));
});

test('missing crew or expired geometry freezes motion; no timeout permits unsafe release',()=>{
  let state=toGate();state=tick(state,{crewAck:crew(state),geometryAck:geometry(state)});
  assert.equal(state.phase,'hand-sheets');
  const before=structuredClone(state.controls);
  for(let i=0;i<100;i++)state=tick(state,{geometryAck:geometry(state)});
  assert.deepEqual(state.controls,before);
  state=tick(state,{crewAck:crew(state),geometryAck:geometry(state),geometryRevision:2});
  assert.equal(state.holdReason,'geometry-clearance-expired');assert.deepEqual(state.controls,before);
});

test('pre-motion reversal can cancel; explicit yard transfer owns an exclusive lock',()=>{
  let state=capture(),generation=state.generation;
  state=tick(state,{observation:wind(-1)});state=tick(state,{observation:wind(-1)});
  assert.equal(state.phase,'hold');assert.equal(state.reserved,false);
  state=tick(state,{yardTransferActive:true});state=tick(state,{yardTransferActive:true});
  assert.equal(state.phase,'hold');assert.equal(state.generation,generation);
  state=tick(state);state=tick(state);assert.equal(state.phase,'wait-clear');assert.ok(state.generation>generation);
  const before=structuredClone(state.controls);
  state=tick(state,{yardTransferActive:true,crewAck:crew(state)});
  assert.equal(state.conflict,true);assert.deepEqual(state.controls,before);
  assert.equal(canBeginYardTransfer(state),false);
  state=tick(state,{cancelBeforeMotion:true});assert.equal(state.phase,'hold');
});

test('opposite handover mirrors support ownership; invalid steps never advance controls',()=>{
  let state=initial(1),began=false;
  for(let i=0;i<100;i++){
    const options={observation:wind(-1),crewAck:crew(state),geometryAck:geometry(state)};
    state=tick(state,options);began||=state.phase!=='hold';
    if(began&&state.phase==='hold')break;
  }
  assert.ok(began);assert.equal(state.workingSide,-1);
  assert.ok(state.controls.every(c=>c.supportEase.port===1&&c.supportEase.starboard===0));
  for(const dt of [0,-1,NaN,Infinity,1]){
    const next=stepRoutineHandover(state,dt,{observation:wind(1)});
    assert.deepEqual(next.controls,state.controls);assert.equal(next.generation,state.generation);
    assert.equal(next.holdReason,'invalid-timestep');
  }
});

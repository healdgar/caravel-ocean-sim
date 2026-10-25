// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Pure state -> state stepping; controls are intentions, never applied geometry.
// In particular, sheetBlend is load handover progress, NOT a licence to linearly
// rotate a clew through a mast. An external geometry proof is required below.

export const ROUTINE_HANDOVER_DEFAULTS=Object.freeze({
  // Illustrative numerical policy, not historically calibrated limits.
  calmEnter:.5,calmExit:.7,headEnter:42*Math.PI/180,headExit:55*Math.PI/180,
  runEnter:170*Math.PI/180,runExit:158*Math.PI/180,acrossMinimum:.12,
  dwell:.6,takeUpRate:.5,sheetRate:.4,releaseRate:.5,maxDt:.1,
});
const routineSide=value=>value===-1||value===1;
const routineEaseKey=side=>side<0?'port':'starboard';
const routineMask=7;
const routineCopy=state=>({...state,policy:{...state.policy},latch:{...state.latch},
  controls:state.controls.map(control=>({...control,supportEase:{...control.supportEase}}))});
const routineToward=(value,target,amount)=>value+Math.max(-amount,Math.min(amount,target-value));
const routineWrap=angle=>Math.abs(Math.atan2(Math.sin(angle),Math.cos(angle)));
function routineCrewCleared(ack,generation){
  return ack?.generation===generation&&['reservedMask','aloftClearMask','deckClearMask'].every(key=>
    Number.isInteger(ack[key])&&(ack[key]&routineMask)===routineMask);
}
function routineSweepCleared(ack,state,revision){
  return ack?.generation===state.generation&&ack?.revision===revision
    &&ack?.kind==='sheet-and-release-sweep'&&ack?.targetSide===state.targetSide&&ack?.clear===true;
}
function routineObserve(state,observation,dt){
  const speed=observation?.speed,angle=observation?.angle,across=observation?.across;
  const valid=[speed,angle,across].every(Number.isFinite)&&speed>=0;
  if(!valid){state.candidateSide=null;state.candidateTime=0;state.observationValid=false;return false;}
  const p=state.policy,a=routineWrap(angle),l=state.latch;
  l.calm=l.calm?speed<p.calmExit:speed<=p.calmEnter;
  l.headwind=l.headwind?a<p.headExit:a<=p.headEnter;
  l.deadRun=l.deadRun?a>p.runExit:a>=p.runEnter;
  state.observationValid=true;
  const usable=!l.calm&&!l.headwind&&!l.deadRun&&Math.abs(across)>p.acrossMinimum;
  if(!usable){state.candidateSide=null;state.candidateTime=0;return false;}
  // Velocity toward +X puts the leeward/working sheet on +X, independently of
  // which side still carries each yard. Observations do not change yard sides.
  const side=across>0?1:-1;
  if(state.candidateSide===side)state.candidateTime+=dt;
  else {state.candidateSide=side;state.candidateTime=dt;}
  return state.candidateTime+1e-12>=p.dwell;
}
function routineReturnToHold(state,reason){
  state.phase='hold';state.targetSide=state.workingSide;state.reserved=false;
  state.physicalStarted=false;state.geometryRevision=null;state.requestedGeometryRevision=null;state.holdReason=reason;
  for(const control of state.controls)control.targetSide=state.workingSide;
  state.candidateSide=null;state.candidateTime=0;return state;
}

export function createRoutineHandover({workingSide=-1,policy={}}={}){
  if(!routineSide(workingSide))throw Error('workingSide must be -1 or 1');
  const p={...ROUTINE_HANDOVER_DEFAULTS,...policy};
  if(!Object.values(p).every(Number.isFinite)||p.calmEnter<0||p.calmExit<p.calmEnter
    ||p.headEnter<0||p.headExit<=p.headEnter||p.runExit<=p.headExit||p.runEnter<=p.runExit
    ||p.runEnter>Math.PI||p.acrossMinimum<0||p.dwell<=0
    ||p.takeUpRate<=0||p.sheetRate<=0||p.releaseRate<=0||p.maxDt<=0)throw Error('Invalid handover policy');
  return {version:1,generation:0,phase:'hold',workingSide,targetSide:workingSide,
    reserved:false,physicalStarted:false,geometryRevision:null,requestedGeometryRevision:null,observationValid:false,
    candidateSide:null,candidateTime:0,latch:{calm:true,headwind:false,deadRun:false},
    holdReason:'awaiting-observation',conflict:false,policy:p,
    controls:Array.from({length:3},()=>({workingSide,targetSide:workingSide,sheetBlend:0,
      supportEase:{port:Number(workingSide<0),starboard:Number(workingSide>0)}}))};
}

export function canBeginYardTransfer(state){return state.phase==='hold'&&!state.reserved;}

/**
 * observation={speed:m/s,angle:wind-FROM radians off bow,across:wind-TOWARD X m/s}
 * crewAck={generation,reservedMask,aloftClearMask,deckClearMask}; all three
 * masks must acknowledge every mast, on EVERY moving step. Missing ack freezes.
 * geometryAck={generation,revision,kind:'sheet-and-release-sweep',targetSide,clear}
 * certifies the whole proposed sheet/release path for geometryRevision. This
 * controller never produces such a certificate; a manual test ack is not proof.
 * yardTransferActive is an external lock. canBeginYardTransfer must be checked
 * before granting it; conflict freezes this controller without moving controls.
 */
export function stepRoutineHandover(previous,dt,{observation,crewAck,geometryAck,
  geometryRevision=0,yardTransferActive=false,cancelBeforeMotion=false}={}){
  const state=routineCopy(previous);state.conflict=false;
  if(!(Number.isFinite(dt)&&dt>0&&dt<=state.policy.maxDt)){
    state.holdReason='invalid-timestep';return state;
  }
  state.requestedGeometryRevision=geometryRevision;
  const stable=routineObserve(state,observation,dt);
  if(yardTransferActive){
    state.conflict=state.phase!=='hold';state.holdReason=state.conflict?'exclusive-owner-conflict':'yard-transfer-owns-rig';
    state.candidateSide=null;state.candidateTime=0;return state;
  }
  if(cancelBeforeMotion&&!state.physicalStarted&&state.phase!=='hold')
    return routineReturnToHold(state,'cancelled-before-motion');
  // A stable return to the old side can cancel ONLY before any support moves.
  if(state.phase!=='hold'&&!state.physicalStarted&&stable&&state.candidateSide===state.workingSide)
    return routineReturnToHold(state,'wind-returned-before-motion');
  if(state.phase==='hold'){
    state.holdReason=stable?'holding-working-side':'wind-latch';
    if(stable&&state.candidateSide!==state.workingSide){
      state.generation++;state.targetSide=state.candidateSide;state.phase='wait-clear';
      state.reserved=true;state.holdReason='awaiting-crew-clear';
      for(const control of state.controls)control.targetSide=state.targetSide;
    }
    return state;
  }
  const crewClear=routineCrewCleared(crewAck,state.generation);
  if(!crewClear){state.holdReason='awaiting-crew-clear';return state;}
  // Before the first actual take-up increment, calm/irons/run retains the last
  // working side even if the crew has already descended and acknowledged.
  if(!state.physicalStarted&&(!stable||state.candidateSide!==state.targetSide)){
    state.holdReason='awaiting-stable-captured-side';return state;
  }
  if(state.phase==='wait-clear'){
    state.phase='take-up-new-support';state.holdReason=null;return state;
  }
  const newWindward=routineEaseKey(-state.targetSide),oldWindward=routineEaseKey(-state.workingSide);
  if(state.phase==='take-up-new-support'){
    for(const control of state.controls){
      control.supportEase[newWindward]=routineToward(control.supportEase[newWindward],0,dt*state.policy.takeUpRate);
      // The old loaded set stays taut until clearance and the new set is taken up.
      control.supportEase[oldWindward]=0;
    }
    state.physicalStarted=true;state.holdReason=null;
    if(state.controls.every(control=>control.supportEase[newWindward]===0)){
      state.phase='wait-geometry';state.holdReason='geometry-clearance-required';
    }
    return state;
  }
  // Both sets remain taut here. NOTHING moves the sheets or releases the old
  // support until an external, transaction/version-matched sweep is certified.
  if(state.phase==='wait-geometry'){
    if(!routineSweepCleared(geometryAck,state,geometryRevision)){
      state.holdReason='geometry-clearance-required';return state;
    }
    state.geometryRevision=geometryRevision;state.phase='hand-sheets';state.holdReason=null;return state;
  }
  if(!routineSweepCleared(geometryAck,state,geometryRevision)){
    state.holdReason='geometry-clearance-expired';return state;
  }
  state.geometryRevision=geometryRevision;
  if(state.phase==='hand-sheets'){
    for(const control of state.controls)control.sheetBlend=routineToward(control.sheetBlend,1,dt*state.policy.sheetRate);
    state.holdReason=null;
    if(state.controls.every(control=>control.sheetBlend===1))state.phase='release-old-support';
    return state;
  }
  if(state.phase==='release-old-support'){
    for(const control of state.controls){
      control.supportEase[newWindward]=0;
      control.supportEase[oldWindward]=routineToward(control.supportEase[oldWindward],1,dt*state.policy.releaseRate);
    }
    state.holdReason=null;
    if(state.controls.every(control=>control.supportEase[oldWindward]===1)){
      state.workingSide=state.targetSide;
      for(const control of state.controls){control.workingSide=state.workingSide;control.sheetBlend=0;}
      return routineReturnToHold(state,'captured-handover-complete');
    }
    return state;
  }
  throw Error(`Unknown routine handover phase: ${state.phase}`);
}

export function routineHandoverCommands(state){
  const active=state.phase!=='hold';
  return {generation:state.generation,phase:state.phase,appliedToGeometry:false,
    targetSide:state.targetSide,workingSide:state.workingSide,
    reserveRunnersMask:active?routineMask:0,descendMask:active?routineMask:0,
    deckClearRequestMask:active?routineMask:0,yardTransferAllowed:canBeginYardTransfer(state),
    geometryRequest:['wait-geometry','hand-sheets','release-old-support'].includes(state.phase)
      ?{generation:state.generation,kind:'sheet-and-release-sweep',targetSide:state.targetSide,
        revision:state.requestedGeometryRevision,requiredClearance:.003,units:'production design coordinates'}:null,
    controls:state.controls.map(control=>({...control,supportEase:{...control.supportEase}}))};
}

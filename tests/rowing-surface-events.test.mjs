// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Real blade geometry and accepted water fields; only the final GPU-field sink
// is replaced here. Root alone executes this independent qualification.
import assert from 'node:assert/strict';
import test from 'node:test';
import {ROWING_DESIGNS} from '../js/models/rowing.js';
import {advanceRowing,rowingStationPose,rowingSteeringPose,rowingForces} from '../js/rowing.js';
import {createRowingWaterConsumer} from '../js/rowing-water.js';
import {surfaceWaveEmission} from '../js/surface-waves.js';
import {ROWING_SURFACE_LIMITS,rowingSurfaceImpulse,createRowingSurfaceEvents} from '../js/rowing-surface-events.js';

const rowEventNear=(a,b,e=1e-7)=>assert.ok(Math.abs(a-b)<=e*Math.max(1,Math.abs(a),Math.abs(b)),a+' != '+b);
function rowEventWater(boat){
  const consumer=createRowingWaterConsumer(),field={clock:0,height:0,velocity:[0,0,0],recordedModel:boat.modelId,recordedRevision:boat.revision};
  const probe={get state(){return consumer.state;},sample:(x,z)=>consumer.sample(x,z,{time:field.clock,revision:boat.revision,modelId:boat.modelId})};
  function accept(time){
    field.clock=time;const values=new Float32Array(8*8*4);
    for(let i=0;i<64;i++)values.set([field.height,...field.velocity],i*4);
    assert.equal(consumer.accept(values,{columns:8,rows:8,domain:[boat.x,boat.z,32,40],axes:[1,0,0,1],time,modelId:field.recordedModel,revision:field.recordedRevision,quality:'surface-orbital'}),true);
  }
  boat.rowingWater=probe;return {field,probe,consumer,accept};
}
function rowEventVessel(id='oseberg',vesselId='player',extra={}){
  const d=ROWING_DESIGNS[id],boat={modelId:id,...d.runtime,showProw:true,effects:true,revision:1,x:0,z:0,heading:0,heave:0,pitch:0,roll:0,rudder:0,
    surgeVelocity:0,leewayVelocity:0,heaveVelocity:0,pitchVelocity:0,rollVelocity:0,yawRate:0,rowingEffort:1,rowingCadence:.45,
    rowingState:{phase:0,rate:.45,cadence:.45,effortPort:1,effortStarboard:1},...extra};
  return {id:vesselId,boat,water:rowEventWater(boat)};
}
function rowEventSink(){
  const emitted=[],sink={epoch:0,stats:{queued:0},emit(event){assert.ok(surfaceWaveEmission(event),'collector produces a valid existing shared-field event');assert.ok(this.stats.queued<64,'rowing never displaces an already queued impact');this.stats.queued++;emitted.push(structuredClone(event));return true;}};
  return {sink,emitted};
}
function rowEventTick(collector,sink,vessels,time,{dt=1/60,refresh=true,...flags}={}){
  sink.stats.queued=0;
  for(const v of vessels){v.water.field.clock=time;if(refresh)v.water.accept(time);}
  const pending=collector.collect(vessels,{time,dt,...flags});assert.ok(Array.isArray(pending)&&pending.length<=32,'one bounded frame snapshot');
  const accepted=collector.flush({time,dt,...flags});assert.ok(Array.isArray(accepted)&&accepted.length<=32,'global frame budget');
  assert.ok(collector.state.pending.length<=32);return accepted;
}
function rowEventPose(v,stationId){return stationId==='helm'?rowingSteeringPose(v.boat,{sampleWater:v.boat.rowingWater.sample}):rowingStationPose(v.boat,stationId,{sampleWater:v.boat.rowingWater.sample});}
function rowEventCatchSeed(time=10){
  const v=rowEventVessel(),{sink}=rowEventSink(),collector=createRowingSurfaceEvents(sink);v.boat.rowingState.phase=.22;v.water.accept(time);
  const pose=rowEventPose(v,ROWING_DESIGNS.oseberg.stations[0].id);
  // The selected actual blade begins 3 cm clear; a 4 cm, 2 m/s descent
  // crosses the wet threshold without tripping the separate teleport gate.
  v.boat.heave+=.03-Math.min(...pose.worldCorners.map(p=>p[1]));v.boat.heaveVelocity=-2;
  assert.deepEqual(rowEventTick(collector,sink,[v],time,{dt:.02}),[]);return {v,sink,collector};
}
function rowEventCatchPending(fixture,time=10.02){
  const {v,sink,collector}=fixture;v.boat.heave-=.04;v.water.accept(time);sink.stats.queued=0;
  const pending=collector.collect([v],{time,dt:.02});assert.ok(pending.some(e=>e.kind==='entry'),'the identical valid contact must produce a real candidate');return pending;
}

test('surface impulse is finite, water-relative and bounded by actual reaction impulse and displaced water',()=>{
  const input={wetArea:.08,bladeWidth:.15,relativeVelocity:[0,-2,0],normal:[0,1,0],force:[0,80,0],dt:.02},p=rowingSurfaceImpulse(input);
  assert.ok(p&&p.impulseNs>0&&p.waterMassKg>0&&p.normalSpeed>0);
  rowEventNear(p.normalSpeed,2);assert.ok(p.impulseNs<=80*.02+1e-12);
  const waterLimit=1025*.08*Math.min(.15,2*.02)*2;assert.ok(p.impulseNs<=waterLimit+1e-12,'no ship or crew mass enters the small blade budget');
  const quiet=rowingSurfaceImpulse({...input,relativeVelocity:[0,0,0]});assert.ok(quiet===null||quiet.impulseNs===0,'co-moving water cannot supply impact energy');
  const tangential=rowingSurfaceImpulse({...input,relativeVelocity:[3,0,2]});assert.ok(tangential===null||tangential.impulseNs===0,'tangent speed is not plate-normal reaction speed');
  const forceLimited=rowingSurfaceImpulse({...input,force:[0,.01,0]});assert.ok(forceLimited&&forceLimited.impulseNs<=.01*.02+1e-12);
  for(const edit of [{wetArea:0},{wetArea:NaN},{bladeWidth:-1},{relativeVelocity:[NaN,0,0]},{normal:[0,0,0]},{normal:[0,2,0]},{force:[0,Infinity,0]},{dt:0},{dt:NaN},{dt:1}]){
    const bad=rowingSurfaceImpulse({...input,...edit});assert.ok(bad===null||bad.impulseNs===0,'invalid/zero input cannot create a physical pulse '+JSON.stringify(edit));
  }
});

test('actual oar and paddle entry/emergence events stay on real moving blade footprints',t=>{
  const receipts=[];
  for(const id of Object.keys(ROWING_DESIGNS)){
    const v=rowEventVessel(id),{sink}=rowEventSink(),collector=createRowingSurfaceEvents(sink),seen=[],keys=new Set();v.water.accept(0);
    assert.deepEqual(rowEventTick(collector,sink,[v],0),[],'first observation seeds real contacts without a fabricated catch');
    let previous=new Map([...ROWING_DESIGNS[id].stations.map(s=>s.id),'helm'].map(s=>[s,rowEventPose(v,s)]));
    const history=new Map([...previous].map(([station,pose])=>[station,[{time:0,pose}]]));
    for(let i=1;i<=180;i++){
      advanceRowing(v.boat,1/60,{effort:1,cadence:.45});
      const checkForces=i===1||i%60===0,before=checkForces?rowingForces({},v.boat,{sampleWater:v.boat.rowingWater.sample}):null,stroke=structuredClone(v.boat.rowingState),events=rowEventTick(collector,sink,[v],i/60);
      if(checkForces)assert.deepEqual(rowingForces({},v.boat,{sampleWater:v.boat.rowingWater.sample}),before,id+' existing force outputs stay exact');assert.deepEqual(v.boat.rowingState,stroke,'event queries cannot advance rowing phase');
      const current=new Map([...previous.keys()].map(s=>[s,rowEventPose(v,s)]));
      for(const [station,pose]of current)history.get(station).push({time:i/60,pose});
      for(const e of events){
        assert.equal(e.vesselId,v.id);assert.ok(current.has(e.stationId));assert.ok(['entry','emerge'].includes(e.kind));assert.ok(e.time<=i/60+1e-9&&i/60-e.time<=ROWING_SURFACE_LIMITS.staleSeconds+.1);
        const samples=history.get(e.stationId),at=Math.max(1,samples.findIndex(sample=>sample.time>=e.time-1e-10)),A=samples[at-1],B=samples[at],a=A.pose,b=B.pose,points=[...a.worldCorners,...b.worldCorners],fraction=(e.time-A.time)/(B.time-A.time);
        assert.ok(a.waterValid&&b.waterValid);assert.ok(Math.max(a.wetArea,b.wetArea,current.get(e.stationId).wetArea)>0,'physical water was touched');
        for(const [coordinate,k]of [['x',0],['z',2]])assert.ok(e[coordinate]>=Math.min(...points.map(p=>p[k]))-.06&&e[coordinate]<=Math.max(...points.map(p=>p[k]))+.06,'source follows actual '+e.stationId+' blade, not a ship-centred ribbon');
        const crossings=a.worldCorners.map((p,k)=>p.map((value,j)=>value+(b.worldCorners[k][j]-value)*fraction)).filter(p=>Math.abs(p[1])<1e-7);
        assert.ok(crossings.some(p=>Math.hypot(p[0]-e.x,p[2]-e.z)<1e-7),'event timestamp and position match an independently reconstructed actual blade/free-surface crossing');
        assert.ok(e.radiusMetres>0&&e.radiusMetres<1&&e.impulseNs>0&&Number.isFinite(e.impulseNs));assert.ok(e.wetArea>0&&e.wetArea<=b.bladeLength*b.bladeWidth+1e-9);
        assert.ok(e.relativeVelocity.every(Number.isFinite)&&e.surfaceNormal.every(Number.isFinite));assert.ok(surfaceWaveEmission(e));
        const key=e.source+'/'+e.id;assert.equal(keys.has(key),false,'new physical crossings retain unique shared-field identities');keys.add(key);
        seen.push(e.kind);
      }
      previous=current;
    }
    assert.ok(seen.includes('entry')&&seen.includes('emerge'),id+' real stroke must enter and leave the resolved sea');receipts.push({id,events:seen.length});
  }
  t.diagnostic(JSON.stringify(receipts));
});

test('rising incident water and descending hull produce equivalent relative blade contact without momentum changes',()=>{
  const a=rowEventVessel('oseberg','relative'),b=rowEventVessel('oseberg','relative'),one=rowEventSink(),two=rowEventSink(),A=createRowingSurfaceEvents(one.sink),B=createRowingSurfaceEvents(two.sink),entryA=[],entryB=[];
  for(const v of [a,b]){v.boat.heave=.413;v.boat.rowingState.phase=.22;}
  for(let i=0;i<=40;i++){
    const time=i*.02;a.boat.heave=.413-time;a.boat.heaveVelocity=-1;b.water.field.height=time;b.water.field.velocity=[0,1,0];
    const beforeA=structuredClone(a.boat.rowingState),beforeB=structuredClone(b.boat.rowingState),forcesA=rowingForces({},a.boat,{sampleWater:()=>({height:0,velocity:[0,0,0]})}),forcesB=rowingForces({},b.boat,{sampleWater:()=>({height:time,velocity:[0,1,0]})});
    entryA.push(...rowEventTick(A,one.sink,[a],time,{dt:.02}).filter(e=>e.kind==='entry'));entryB.push(...rowEventTick(B,two.sink,[b],time,{dt:.02}).filter(e=>e.kind==='entry'));
    assert.deepEqual(a.boat.rowingState,beforeA);assert.deepEqual(b.boat.rowingState,beforeB);assert.equal(a.boat.surgeVelocity,0);assert.equal(b.boat.surgeVelocity,0);
    assert.deepEqual(rowingForces({},a.boat,{sampleWater:()=>({height:0,velocity:[0,0,0]})}),forcesA,'contact collection cannot alter real force outputs');
    assert.deepEqual(rowingForces({},b.boat,{sampleWater:()=>({height:time,velocity:[0,1,0]})}),forcesB);
  }
  const sort=list=>list.sort((a,b)=>a.stationId.localeCompare(b.stationId));sort(entryA);sort(entryB);assert.ok(entryA.length>0);assert.deepEqual(entryA.map(e=>e.stationId),entryB.map(e=>e.stationId));
  for(let i=0;i<entryA.length;i++){rowEventNear(entryA[i].closingSpeed,entryB[i].closingSpeed,1e-5);rowEventNear(entryA[i].impulseNs,entryB[i].impulseNs,1e-5);}
});

test('explicit missing/stale/mismatched water and reset/wrap/teleport histories cannot synthesize flat-water catches',()=>{
  const control=rowEventCatchSeed();rowEventCatchPending(control);assert.ok(control.collector.flush({time:10.02,dt:.02}).length>0,'positive control crosses without a teleport');
  for(const failure of ['missing','numeric-height','invalid-velocity','stale','model','unsupported-model','revision','hidden','reset','wrap','teleport','epoch']){
    const {v,sink,collector}=rowEventCatchSeed();v.boat.heave-=.04;
    let time=10.02,flags={dt:.02};
    if(failure==='missing')v.boat.rowingWater={state:null,sample:()=>null};
    if(failure==='numeric-height')v.boat.rowingWater={get state(){return v.water.probe.state;},sample:()=>0};
    if(failure==='invalid-velocity')v.boat.rowingWater={get state(){return v.water.probe.state;},sample:()=>({height:0,velocity:[0,NaN,0]})};
    if(failure==='stale'){time=10.4;flags.refresh=false;}
    if(failure==='model')v.water.field.recordedModel='lusoria';
    if(failure==='unsupported-model')v.boat.modelId='gipsy-moth-iv';
    if(failure==='revision')v.boat.revision++;
    if(failure==='hidden')flags.hidden=true;
    if(failure==='reset')flags.resetSea=true;
    if(failure==='wrap'){time=.02;v.water.consumer.clear();}
    if(failure==='teleport'){v.boat.x=10000;v.boat.z=-10000;}
    if(failure==='epoch')sink.epoch++;
    assert.deepEqual(rowEventTick(collector,sink,[v],time,flags),[],failure+' invalidates previous crossing history');assert.equal(collector.state.histories,0,failure+' releases old contact history');
  }
  const v=rowEventVessel(),{sink}=rowEventSink(),collector=createRowingSurfaceEvents(sink);v.boat.rowingState.phase=.22;v.boat.heave=-1;delete v.boat.rowingWater;
  for(let i=0;i<20;i++)assert.deepEqual(rowEventTick(collector,sink,[v],i*.02,{dt:.02,refresh:false}),[],'there is no implicit flatwater fallback');
  collector.reset();assert.equal(collector.state.pending.length,0);assert.equal(collector.state.histories,0);
});

test('queued disabled or stale contacts are dropped and re-enable/fresh water cannot bridge the known gap',()=>{
  for(const failure of ['showProw','effects','stale']){
    const fixture=rowEventCatchSeed(),{v,sink,collector}=fixture;rowEventCatchPending(fixture);
    const time=failure==='stale'?10.4:10.04;
    if(failure!=='stale')v.boat[failure]=false;
    v.water.field.clock=time;
    assert.deepEqual(collector.flush({time,dt:.02}),[],failure+' invalidation precedes queued emission');
    assert.equal(sink.stats.queued,0);assert.equal(collector.state.pending.length,0);assert.equal(collector.state.histories,0);
    if(failure!=='stale')v.boat[failure]=true;
    assert.deepEqual(rowEventTick(collector,sink,[v],time+.02,{dt:.02}),[],'first enabled fresh sample seeds the already submerged blade without inventing an entry');
    assert.ok(collector.state.histories>0,'fresh active geometry is tracked again');
  }
  for(const property of ['showProw','effects']){
    const {v,sink,collector}=rowEventCatchSeed();v.boat[property]=false;v.boat.heave-=.04;
    assert.deepEqual(rowEventTick(collector,sink,[v],10.02,{dt:.02}),[]);assert.equal(collector.state.histories,0);
    v.boat[property]=true;
    assert.deepEqual(rowEventTick(collector,sink,[v],10.04,{dt:.02}),[],'collect-only disable cannot preserve a pre-disable crossing either');
  }
  const {v,sink,collector}=rowEventCatchSeed(20);v.water.field.clock=20.4;
  assert.deepEqual(collector.flush({time:20.4,dt:.02}),[]);v.boat.heave-=.04;
  assert.deepEqual(rowEventTick(collector,sink,[v],20.42,{dt:.02}),[],'a known stale gap between a dry observation and a fresh submerged observation cannot be bridged');
});

test('passive emergence cannot stretch a short observed wet reaction across a longer dry frame',()=>{
  const v=rowEventVessel(),{sink}=rowEventSink(),collector=createRowingSurfaceEvents(sink),station=ROWING_DESIGNS.oseberg.stations[0].id;
  v.boat.rowingState.phase=.7;v.boat.rowingState.rate=0;v.boat.rowingAttendance=new Set([station]);v.water.accept(10);
  const pose=rowEventPose(v,station);v.boat.heave+=-.03-Math.min(...pose.worldCorners.map(p=>p[1]));v.boat.heaveVelocity=2.5;
  rowEventTick(collector,sink,[v],10,{dt:.01});
  const load=rowingForces({},v.boat,{sampleWater:v.boat.rowingWater.sample}).blades.find(b=>b.stationId===station);
  assert.ok(load&&load.wetArea>0&&!load.drive);const normalSpeed=Math.abs(load.relativeVelocity.reduce((sum,x,i)=>sum+x*load.normal[i],0));
  const reactionCap=Math.hypot(...load.force)*.01,waterCap=1025*load.wetArea*Math.min(pose.bladeWidth,normalSpeed*.01)*normalSpeed;
  v.boat.heave+=.10;const out=rowEventTick(collector,sink,[v],10.04,{dt:.04}),event=out.find(e=>e.stationId===station&&e.kind==='emerge');
  assert.ok(event,'the real partly immersed recovery blade emerges and satisfies dry confirmation');
  assert.ok(event.impulseNs>0&&event.impulseNs<=Math.min(reactionCap,waterCap)+1e-10,'the prior 10 ms reaction bounds the pulse even when the next observation spans 40 ms');
  assert.equal(v.boat.rowingState.rate,0);assert.equal(v.boat.rowingState.phase,.7,'passive contact never invents a new stroke');
});

test('millimetre wet-line chatter stays inside hysteresis; feathered recovery adds no power or artificial thrust',()=>{
  const v=rowEventVessel(),{sink}=rowEventSink(),collector=createRowingSurfaceEvents(sink);v.boat.rowingState.phase=.22;v.boat.rowingState.rate=0;v.boat.surgeVelocity=.8;
  v.boat.rowingAttendance=new Set([ROWING_DESIGNS.oseberg.stations[0].id]);
  const pose=rowingStationPose(v.boat,0,{sampleWater:()=>({height:0,velocity:[0,0,0]})}),bottom=Math.min(...pose.worldCorners.map(p=>p[1]));
  v.water.field.height=bottom-.1;rowEventTick(collector,sink,[v],0,{dt:.02});
  for(let i=1;i<=50;i++){v.water.field.height=bottom+(i%2?1:-1)*.001;v.water.field.velocity=[0,i%2?.1:-.1,0];assert.deepEqual(rowEventTick(collector,sink,[v],i*.02,{dt:.02}),[],'sub-threshold wet chatter is not repeated breaking water');}
  v.boat.rowingState.phase=.7;v.water.field.height=1;v.boat.leewayVelocity=.8;v.boat.heaveVelocity=.2;collector.reset();
  const before=rowingForces({},v.boat,{sampleWater:()=>({height:1,velocity:[0,0,0]})}),snapshot={phase:v.boat.rowingState.phase,speed:v.boat.surgeVelocity,side:v.boat.leewayVelocity};
  for(let i=51;i<=70;i++)rowEventTick(collector,sink,[v],i*.02,{dt:.02});
  const after=rowingForces({},v.boat,{sampleWater:()=>({height:1,velocity:[0,0,0]})});assert.deepEqual(after,before);rowEventNear(after.crewPower,0);assert.ok(after.dissipation>0&&after.power<0);
  assert.deepEqual({phase:v.boat.rowingState.phase,speed:v.boat.surgeVelocity,side:v.boat.leewayVelocity},snapshot);
});

test('nine full companies share at most32 fair frame events, bounded histories and the unoccupied shared-field capacity',t=>{
  const vessels=Array.from({length:9},(_,i)=>rowEventVessel('oseberg','fleet-'+i,{x:i*20,z:i*4,heave:1})),{sink}=rowEventSink(),collector=createRowingSurfaceEvents(sink),represented=new Set();
  for(const v of vessels)v.boat.rowingState.phase=.22;
  rowEventTick(collector,sink,vessels,0,{dt:.02});let largest=0;
  for(let i=1;i<=90;i++){
    for(const v of vessels){v.boat.heave=1-i*.02;v.boat.heaveVelocity=-1;}
    const accepted=rowEventTick(collector,sink,vessels,i*.02,{dt:.02});largest=Math.max(largest,accepted.length);for(const e of accepted)represented.add(e.vesselId);
    assert.ok(collector.state.pending.length<=32&&collector.state.vessels<=9&&collector.state.histories<=9*31,'active roster, not elapsed time, bounds history');
    if(accepted.length>=9)assert.equal(new Set(accepted.map(e=>e.vesselId)).size,9,'simultaneous stations cannot starve a later vessel');
  }
  assert.equal(represented.size,9);assert.ok(largest>0&&largest<=32);
  // Re-enter with only one shared slot free, then no slots. Existing impacts
  // retain their place; rowing does not replace them or defer an unbounded tail.
  for(const [index,occupied]of [63,64].entries()){
    const baseTime=3+index*3;collector.reset();for(const v of vessels){v.boat.heave=1;v.water.accept(baseTime);}
    collector.collect(vessels,{time:baseTime,dt:.02});collector.flush({time:baseTime,dt:.02});
    for(let i=1;i<=80;i++){
      const time=baseTime+i*.02;sink.stats.queued=occupied;for(const v of vessels){v.boat.heave=1-i*.02;v.boat.heaveVelocity=-1;v.water.accept(time);}
      collector.collect(vessels,{time,dt:.02});const out=collector.flush({time,dt:.02});assert.ok(out.length<=64-occupied&&sink.stats.queued<=64);assert.equal(collector.state.pending.length,0,'discard overflow this frame, no catch-up spray');
    }
  }
  collector.collect([],{time:8,dt:.02});collector.flush({time:8,dt:.02});assert.equal(collector.state.histories,0,'removed roster histories are released');
  t.diagnostic(JSON.stringify({vessels:represented.size,largestFrame:largest,maxEvents:ROWING_SURFACE_LIMITS.maxEvents}));
});

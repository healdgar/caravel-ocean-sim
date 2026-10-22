// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
import {ROWING_DESIGNS} from './models/rowing.js';
import {rowingStationPose,rowingSteeringPose,rowingForces} from './rowing.js';
import {ROWING_WATER_LIMITS} from './rowing-water.js';
import {SURFACE_WAVE_LIMITS} from './surface-waves.js';

// Contact tolerances and a frame-snapshot approximation, not a splash scale or
// a new force model. Catches wholly between two snapshots cannot be recovered.
export const ROWING_SURFACE_LIMITS=Object.freeze({maxEvents:32,maxVessels:9,maxDt:.100001,
  staleSeconds:ROWING_WATER_LIMITS.staleSeconds,entryDepth:.005,dryClearance:.02,drySeconds:.03,waterDensity:1025});
const rowingSurfacePoint=p=>p?.length===3&&Array.from(p).every(Number.isFinite);
const rowingSurfaceDot=(a,b)=>a.reduce((sum,x,i)=>sum+x*b[i],0);
const rowingSurfaceSub=(a,b)=>a.map((x,i)=>x-b[i]);
const rowingSurfaceCross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const rowingSurfaceRotate=(axes,p)=>[0,1,2].map(i=>axes[0][i]*p[0]+axes[1][i]*p[1]+axes[2][i]*p[2]);
const rowingSurfaceSnapshot=e=>({...e,velocity:[...e.velocity],relativeVelocity:[...e.relativeVelocity],surfaceNormal:[...e.surfaceNormal]});

// Momentum is bounded by BOTH the actual plate reaction over this interval and
// the water swept by that blade. No vessel or crew mass enters this estimate.
// This diagnostic helper never integrates a force or changes stroke state.
export function rowingSurfaceImpulse({wetArea,bladeWidth,relativeVelocity,normal,force,dt}={}){
  const L=ROWING_SURFACE_LIMITS;
  if(![wetArea,bladeWidth,dt].every(Number.isFinite)||!(wetArea>0&&bladeWidth>0&&dt>0&&dt<=L.maxDt)
    ||![relativeVelocity,normal,force].every(rowingSurfacePoint))return null;
  const normalLength=Math.hypot(...normal);if(Math.abs(normalLength-1)>1e-5)return null;
  const normalSpeed=Math.abs(rowingSurfaceDot(relativeVelocity,normal));
  const waterMassKg=L.waterDensity*wetArea*Math.min(bladeWidth,normalSpeed*dt);
  const impulseNs=Math.min(Math.hypot(...force)*dt,waterMassKg*normalSpeed);
  if(!(Number.isFinite(impulseNs)&&impulseNs>0&&waterMassKg>0))return null;
  return {impulseNs,waterMassKg,normalSpeed,energyJ:.5*impulseNs*normalSpeed};
}

function rowingSurfaceAcceptedWater(boat,time){
  const water=boat.rowingWater,state=water?.state,L=ROWING_SURFACE_LIMITS;
  if(typeof water?.sample!=='function'||!state||state.modelId!==boat.modelId||state.revision!==boat.revision
    ||!Number.isFinite(state.time)||time<state.time||time-state.time>L.staleSeconds)return null;
  const sample=(x,z)=>{
    const q=water.sample(x,z);
    // A numeric height (the standalone force evaluator's explicit flat-water
    // option) is deliberately inadmissible for this runtime contact producer.
    return q&&typeof q==='object'&&Number.isFinite(q.height)&&rowingSurfacePoint(q.velocity)?q:null;
  };
  return {water,sample};
}
function rowingSurfaceKinematics(boat,pose,point,water){
  const h=boat.heading*Math.PI/180,p=boat.pitch??0,ch=Math.cos(h),sh=Math.sin(h),cp=Math.cos(p),sp=Math.sin(p);
  const u=boat.surgeVelocity??0,v=boat.leewayVelocity??0,w=boat.heaveVelocity??0,pr=boat.pitchVelocity??0,rr=boat.rollVelocity??0,yr=boat.yawRate??0;
  if(![u,v,w,pr,rr,yr].every(Number.isFinite))return null;
  const cg=[0,boat.hydrodynamics?(boat.hydrodynamics.centreOfGravity-(boat.hydrodynamics.datumDraft??-ROWING_DESIGNS[boat.modelId].profile.levels[0]*ROWING_DESIGNS[boat.modelId].frame.verticalScale)):0,0];
  const centre=rowingSurfaceRotate(pose.axes,cg).map((x,i)=>x+[boat.x,boat.heave,boat.z][i]);
  const omega=[pr*ch-rr*sh*cp,-yr-rr*sp,pr*sh+rr*ch*cp],spin=rowingSurfaceCross(omega,rowingSurfaceSub(point,centre));
  const stroke=rowingSurfaceRotate(pose.axes,pose.bladeVelocity),translation=[u*sh+v*ch,w,-u*ch+v*sh];
  return translation.map((x,i)=>x+spin[i]+stroke[i]-water.velocity[i]);
}
function rowingSurfaceCrossing(previous,current,entering){
  let crossing=null;
  for(let i=0;i<current.gaps.length;i++){
    const a=previous.gaps[i],b=current.gaps[i];
    if(entering?!(a>0&&b<=0):!(a<=0&&b>0))continue;
    const t=a/(a-b);
    if(crossing&&(entering?t>=crossing.t:t<=crossing.t))continue;
    crossing={t,time:previous.time+(current.time-previous.time)*t,
      point:previous.corners[i].map((x,k)=>x+(current.corners[i][k]-x)*t)};
  }
  return crossing;
}
function rowingSurfaceNormal(sample,point,width){
  const step=Math.max(.02,Math.min(.10,width*.5));
  const xp=sample(point[0]+step,point[2]),xm=sample(point[0]-step,point[2]);
  const zp=sample(point[0],point[2]+step),zm=sample(point[0],point[2]-step);
  if(!xp||!xm||!zp||!zm)return null;
  const n=[-(xp.height-xm.height)/(2*step),1,-(zp.height-zm.height)/(2*step)],length=Math.hypot(...n);
  return n.map(x=>x/length);
}
function rowingSurfaceBoatMoved(previous,boat,dt){
  const values=[boat.x,boat.heave,boat.z,boat.heading,boat.length,boat.beam];
  if(!values.every(Number.isFinite)||!(boat.length>0&&boat.beam>0))return true;
  if(!previous)return false;
  const speed=Math.hypot(boat.surgeVelocity??0,boat.leewayVelocity??0,boat.heaveVelocity??0);
  const angular=Math.abs(boat.pitchVelocity??0)+Math.abs(boat.rollVelocity??0)+Math.abs(boat.yawRate??0);
  const allowance=.5+2*dt*(speed+boat.length*.5*angular);
  const turn=Math.abs(((boat.heading-previous.heading+540)%360)-180)*Math.PI/180;
  return Math.hypot(boat.x-previous.x,boat.heave-previous.y,boat.z-previous.z)>allowance
    ||turn>.05+2*dt*Math.abs(boat.yawRate??0)||boat.length!==previous.length||boat.beam!==previous.beam;
}

// collect() follows current crew/mesh posing. flush() precedes the EXISTING
// shared field update next frame; it never moves that update or re-ages older
// anchor/wildlife/gunnery sources. The single-frame queue has no deferred backlog.
export function createRowingSurfaceEvents(surfaceWaves,{maxEvents=ROWING_SURFACE_LIMITS.maxEvents}={}){
  if(typeof surfaceWaves?.emit!=='function')throw new TypeError('A shared surface-wave producer is required');
  const L=ROWING_SURFACE_LIMITS;
  if(!Number.isInteger(maxEvents)||maxEvents<1||maxEvents>L.maxEvents)throw new RangeError('Invalid rowing surface event budget');
  const vessels=new Map(),stats={pending:0,trackedStations:0,emitted:0,dropped:0,resets:0};
  let pending=[],epoch=surfaceWaves.epoch,clock=null,vesselCursor=0,serial=0;
  function reset(){pending=[];vessels.clear();stats.pending=0;stats.trackedStations=0;stats.resets++;clock=null;epoch=surfaceWaves.epoch;}
  function validFrame(time,dt,hidden,resetSea){
    if(hidden||resetSea||!Number.isFinite(time)||!Number.isFinite(dt)||!(dt>0&&dt<=L.maxDt)||epoch!==surfaceWaves.epoch||clock!==null&&time<clock){reset();return false;}
    return true;
  }
  function eventFor(vessel,boat,pose,crossing,kind,load,sample,time,dt){
    if(!crossing||!load||time-load.time>L.maxDt*1.01||time-crossing.time>SURFACE_WAVE_LIMITS.maxEventAge)return null;
    const point=crossing.point,water=sample(point[0],point[2]),normal=rowingSurfaceNormal(sample,point,pose.bladeWidth);
    if(!water||!normal)return null;
    const relative=rowingSurfaceKinematics(boat,pose,point,water);if(!relative)return null;
    const normalSpeed=rowingSurfaceDot(relative,normal),closingSpeed=kind==='entry'?-normalSpeed:normalSpeed;
    if(!(closingSpeed>1e-5))return null;
    const wetArea=Math.min(load.wetArea,pose.bladeLength*pose.bladeWidth);
    const impulse=rowingSurfaceImpulse({wetArea,bladeWidth:pose.bladeWidth,relativeVelocity:relative,normal:pose.worldNormal,force:load.force,dt:Math.min(dt,load.dt)});
    if(!impulse)return null;
    // Emergence can use the last fresh submerged reaction, but never extend
    // that old load over a longer interval or invent extra reaction work.
    const observed=rowingSurfaceImpulse({wetArea,bladeWidth:pose.bladeWidth,relativeVelocity:load.relativeVelocity,normal:load.normal,force:load.force,dt:load.dt});
    if(!observed)return null;
    impulse.impulseNs=Math.min(impulse.impulseNs,observed.impulseNs);
    // The shared field attenuates this transferred momentum again. A blade's
    // actual footprint supplies its radius; a visual splash never supplies it.
    const radiusMetres=Math.sqrt(wetArea/Math.PI),massKg=impulse.impulseNs/closingSpeed;
    return {source:'rowing:'+vessel.id+'/'+pose.stationId,id:++serial,epoch,vesselId:vessel.id,stationId:pose.stationId,
      kind,time:crossing.time,x:point[0],z:point[2],radiusMetres,closingSpeed,massKg,velocity:[...relative],age:time-crossing.time,
      impulseNs:impulse.impulseNs,wetArea,waterMassKg:impulse.waterMassKg,relativeVelocity:relative,surfaceNormal:normal};
  }
  function collect(roster,{time,dt,hidden=false,resetSea=false}={}){
    // Calling collect twice cannot grow a backlog or repeat the previous catch.
    if(pending.length){stats.dropped+=pending.length;pending=[];}
    if(!validFrame(time,dt,hidden,resetSea))return [];
    if(clock!==null&&time<=clock){reset();return [];}
    clock=time;
    const active=new Set(),buckets=[];
    for(const vessel of Array.isArray(roster)?roster.slice(0,L.maxVessels):[]){
      const boat=vessel?.boat,id=vessel?.id;
      if(!boat||typeof id!=='string'||active.has(id)||!Object.hasOwn(ROWING_DESIGNS,boat.modelId))continue;
      active.add(id);
      const state=boat.rowingState,accepted=rowingSurfaceAcceptedWater(boat,time),previous=vessels.get(id);
      if(!accepted||!state||![state.phase,state.rate,state.effortPort,state.effortStarboard].every(Number.isFinite)
        ||rowingSurfaceBoatMoved(previous?.position,boat,dt)){
        vessels.delete(id);continue;
      }
      const same=previous?.boat===boat&&previous?.water===accepted.water&&previous?.revision===boat.revision&&previous?.modelId===boat.modelId;
      const record=same?previous:{boat,water:accepted.water,revision:boat.revision,modelId:boat.modelId,stations:new Map(),cursor:0};
      record.position={x:boat.x,y:boat.heave,z:boat.z,heading:boat.heading,length:boat.length,beam:boat.beam};
      vessels.set(id,record);
      const sample=accepted.sample,design=ROWING_DESIGNS[boat.modelId],loads={};
      // rowingState already exists and is finite above. Thus these public pose /
      // force calls cannot initialize it; force scratch belongs only to us.
      rowingForces(loads,boat,{time,sampleWater:sample});
      const loadMap=new Map(loads.blades.map(load=>[load.stationId,{...load,time,dt}]));
      const poses=design.stations.map((station,i)=>rowingStationPose(boat,i,{time,sampleWater:sample}));
      poses.push(rowingSteeringPose(boat,{time,sampleWater:sample}));
      const candidates=[];
      for(const pose of poses){
        const cornerWater=pose.worldCorners.map(p=>sample(p[0],p[2]));
        if(!pose.waterValid||cornerWater.some(q=>!q)){record.stations.delete(pose.stationId);continue;}
        const current={time,corners:pose.worldCorners.map(p=>[...p]),gaps:pose.worldCorners.map((p,i)=>p[1]-cornerWater[i].height)};
        const low=Math.min(...current.gaps),dry=low>=L.dryClearance,wet=low<=-L.entryDepth&&pose.wetArea>0;
        let history=record.stations.get(pose.stationId);
        const load=loadMap.get(pose.stationId);
        if(!history){
          history={...current,wet:!dry,dryTime:0,crossing:null,lastLoad:load??null};record.stations.set(pose.stationId,history);continue;
        }
        if(history.wet){
          if(low>0&&!history.crossing)history.crossing=rowingSurfaceCrossing(history,current,false);
          if(low<=0){history.crossing=null;history.dryTime=0;}
          history.dryTime=dry?history.dryTime+dt:0;
          if(history.dryTime>=L.drySeconds){
            const event=eventFor(vessel,boat,pose,history.crossing,'emerge',load??history.lastLoad,sample,time,dt);
            if(event)candidates.push({event,boat,water:accepted.water,revision:boat.revision,modelId:boat.modelId,position:{...record.position}});
            history.wet=false;history.crossing=null;history.dryTime=0;
          }
        }else{
          if(low<=0&&!history.crossing)history.crossing=rowingSurfaceCrossing(history,current,true);
          if(low>0)history.crossing=null;
          if(wet){
            const event=eventFor(vessel,boat,pose,history.crossing,'entry',load,sample,time,dt);
            if(event)candidates.push({event,boat,water:accepted.water,revision:boat.revision,modelId:boat.modelId,position:{...record.position}});
            history.wet=true;history.crossing=null;history.dryTime=0;
          }
        }
        history.time=time;history.corners=current.corners;history.gaps=current.gaps;if(load)history.lastLoad=load;
      }
      // Rotate station priority even when several synchronized catches exceed
      // the frame budget; every real station gets a turn across later cycles.
      candidates.sort((a,b)=>{
        const ai=poses.findIndex(p=>p.stationId===a.event.stationId),bi=poses.findIndex(p=>p.stationId===b.event.stationId);
        return (ai-record.cursor+poses.length)%poses.length-(bi-record.cursor+poses.length)%poses.length;
      });
      buckets.push({record,candidates,poses});
    }
    for(const id of vessels.keys())if(!active.has(id))vessels.delete(id);
    let available=true;
    while(pending.length<maxEvents&&available){
      available=false;
      for(let k=0;k<buckets.length&&pending.length<maxEvents;k++){
        const bucket=buckets[(vesselCursor+k)%buckets.length],next=bucket.candidates.shift();
        if(!next)continue;
        pending.push(next);available=true;
        bucket.record.cursor=(bucket.poses.findIndex(p=>p.stationId===next.event.stationId)+1)%bucket.poses.length;
      }
    }
    for(const bucket of buckets)stats.dropped+=bucket.candidates.length;
    if(buckets.length)vesselCursor=(vesselCursor+1)%buckets.length;
    stats.pending=pending.length;stats.trackedStations=Array.from(vessels.values()).reduce((sum,r)=>sum+r.stations.size,0);
    return pending.map(p=>rowingSurfaceSnapshot(p.event));
  }
  function flush({time,dt,hidden=false,resetSea=false}={}){
    if(!validFrame(time,dt,hidden,resetSea))return [];
    // A field discontinuity observed while draining must also break crossing
    // history, even if a fresh packet arrives before the next collection.
    for(const [id,record] of vessels){
      const accepted=rowingSurfaceAcceptedWater(record.boat,time);
      if(!accepted||accepted.water!==record.water||record.boat.revision!==record.revision||record.boat.modelId!==record.modelId
        ||rowingSurfaceBoatMoved(record.position,record.boat,dt))vessels.delete(id);
    }
    stats.trackedStations=Array.from(vessels.values()).reduce((sum,r)=>sum+r.stations.size,0);
    const queue=pending;pending=[];stats.pending=0;
    const available=Math.max(0,Math.min(maxEvents,SURFACE_WAVE_LIMITS.emitters-(surfaceWaves.stats?.queued??SURFACE_WAVE_LIMITS.emitters)));
    const emitted=[];
    for(const item of queue){
      const boat=item.boat,event=item.event,accepted=rowingSurfaceAcceptedWater(boat,time),age=time-event.time;
      if(emitted.length>=available||!vessels.has(event.vesselId)||!accepted||accepted.water!==item.water||boat.revision!==item.revision||boat.modelId!==item.modelId
        ||rowingSurfaceBoatMoved(item.position,boat,dt)||age<0||age>SURFACE_WAVE_LIMITS.maxEventAge||!accepted.sample(event.x,event.z)){
        stats.dropped++;continue;
      }
      const next={...event,age};
      if(surfaceWaves.emit(next)){emitted.push(rowingSurfaceSnapshot(next));stats.emitted++;}else stats.dropped++;
    }
    return emitted;
  }
  return {collect,flush,reset,stats,get state(){return {pending:pending.map(p=>rowingSurfaceSnapshot(p.event)),histories:stats.trackedStations,vessels:vessels.size};}};
}

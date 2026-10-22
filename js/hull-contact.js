// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
import {HULL_DRAFT, hullSurfacePoint, vesselVerticalScale} from './hull.js';
import {VICTORY_DESIGN, victoryHullPoint} from './models/victory.js';
import {PROCEDURAL_DESIGNS,proceduralBottom} from './models/procedural.js';
import {hullLoftPoint,hullLoftBottom} from './hull-loft.js';
import {boatRotate,boatForwardSpeed} from './boat.js';
import {HULL_CONTACT_QUERY, HULL_CONTACT_COUNT, HULL_CONTACT_RECORD_BYTES,
  HULL_CONTACT_FLAGS} from './wgsl/hull-contact.js';

// Sampling/hysteresis tolerances are authored numerical policy, not measured
// vessel slam thresholds or force coefficients. Events remain diagnostics.
export const HULL_CONTACT_LIMITS=Object.freeze({dryGap:.025,wetGap:.005,dryHold:.06,
  staleSeconds:.35,minClosing:0,peakWindow:.2,readEvery:8,maxDt:.100001});
const hullContactNormalize=p=>{const n=Math.hypot(...p);return p.map(v=>v/Math.max(n,1e-15));};
const hullContactSubtract=(a,b)=>a.map((v,i)=>v-b[i]);
const hullContactCross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const hullContactFinitePoint=p=>p?.length===3&&Array.from(p).every(Number.isFinite);
const hullContactWallTime=()=>globalThis.performance?.now?.()??Date.now();

export function createHullContactDefinitions(modelId='nina'){
  if(!['nina','victory'].includes(modelId)&&!Object.hasOwn(PROCEDURAL_DESIGNS,modelId))throw Error(`No underside geometry for ${modelId}`);
  const points=[];
  const add=(id,position,normal,source)=>points.push({id,position,normal,source});
  if(modelId==='nina'){
    // Exact longitudinal grid/rings used by createCaravelMesh, not a waterline
    // contact guessed downwards. Other ring angles altered for wales are absent.
    for(const i of [12,36,60,88])for(const ring of [8,16]){
      const station=-6.4+i*12/112,angle=ring*Math.PI/24,p=hullSurfacePoint(station,angle),e=1e-5;
      const around=hullContactSubtract(hullSurfacePoint(station,angle+e),hullSurfacePoint(station,angle-e));
      const along=hullContactSubtract(hullSurfacePoint(station+e,angle),hullSurfacePoint(station-e,angle));
      let normal=hullContactNormalize(hullContactCross(along,around));if(normal[0]*p[0]<0)normal=normal.map(v=>-v);
      add(`bilge.${i}.${ring<12?'starboard':'port'}`,p,normal,{group:'hull',station,ring});
    }
    // The timber keel extends .075 design units below the skin. Its bevel has
    // a flat bottom face on x=0, so these points lie on that actual face.
    for(const i of [36,72]){
      const z=-6.4+i*12/112;
      add(`keel.${i}`,[0,-HULL_DRAFT-.075,z],[0,-1,0],{group:'hull.keel-stem',station:z});
    }
  }else if(modelId==='victory'){
    // Both station and base-Y values are vertices of Victory's current loft.
    // victoryHullPoint includes the submerged end rake and local sheer.
    for(const station of [-4.5,-2.5,0,3])for(const side of [-1,1]){
      const y=-1.5,p=victoryHullPoint(station,y,side),e=1e-5;
      const up=hullContactSubtract(victoryHullPoint(station,y+e,side),victoryHullPoint(station,y-e,side));
      const along=hullContactSubtract(victoryHullPoint(station+e,y,side),victoryHullPoint(station-e,y,side));
      let normal=hullContactNormalize(hullContactCross(up,along));if(normal[0]*side<0)normal=normal.map(v=>-v);
      add(`bilge.${station}.${side<0?'port':'starboard'}`,p,normal,{group:'hull.planking',station,baseY:y});
    }
    for(const station of [-2.5,1.5])add(`keel.${station}`,
      victoryHullPoint(station,-VICTORY_DESIGN.hull.draft,0),[0,-1,0],
      {group:'hull.planking',station,baseY:-VICTORY_DESIGN.hull.draft});
  }else{
    const d=PROCEDURAL_DESIGNS[modelId],profile=d.profile,baseY=profile.levels[1];
    for(const station of [-4.2,-3,0,3])for(const side of [-1,1]){
      const p=hullLoftPoint(profile,station,baseY,side),e=1e-5;
      const up=hullContactSubtract(hullLoftPoint(profile,station,baseY+e,side),hullLoftPoint(profile,station,baseY-e,side));
      const along=hullContactSubtract(hullLoftPoint(profile,station+e,baseY,side),hullLoftPoint(profile,station-e,baseY,side));
      let normal=hullContactNormalize(hullContactCross(up,along));if(normal[0]*side<0)normal=normal.map(v=>-v);
      add(`bilge.${station}.${side<0?'port':'starboard'}`,p,normal,{group:'hull.planking',station,baseY});
    }
    const stations=d.keel?.kind==='profiled-ballast-fin'?[.2,1.2]:[-3,1.5];
    for(const station of stations)add(`${d.keel?'keel':'bottom'}.${station}`,[0,proceduralBottom(modelId,station),station],[0,-1,0],{group:d.keel?'hull.keel':'hull.closed-shell',station});
  }
  const values=new Float32Array(HULL_CONTACT_COUNT*8);
  points.forEach((p,i)=>{values.set([...p.position,i,...p.normal,0],i*8);});
  return {modelId,points,values,description:'Authored ten-point lower-bilge/keel coverage of canonical model geometry; FFT-only incident contact, no forces.'};
}

export function hullContactWorldPoint(definition,boat){
  const p=definition.position??definition,scale=[boat.beam/3.6,vesselVerticalScale(boat),boat.length/12],out=[0,0,0];
  boatRotate(out,...p.map((v,k)=>v*scale[k]),(boat.heading??0)*Math.PI/180,boat.pitch??0,boat.roll??0);
  return out.map((v,k)=>v+[boat.x??0,boat.heave??0,boat.z??0][k]);
}

// Readback-only consumer. The GPU owns per-frame dry/wet transitions; CPU
// readback cadence must never stand in for consecutive physical dry samples.
export function createHullContactConsumer({staleSeconds=HULL_CONTACT_LIMITS.staleSeconds}={}){
  const serials=new Uint32Array(HULL_CONTACT_COUNT);let epoch=0;
  return {
    reset(value){epoch=value>>>0;serials.fill(0);},
    consume(buffer,{epoch:requestEpoch,now,extraAge=0}={}){
      if((requestEpoch>>>0)!==epoch)return [];
      const bytes=ArrayBuffer.isView(buffer)?buffer.buffer:buffer;
      const offset=ArrayBuffer.isView(buffer)?buffer.byteOffset:0;
      const size=ArrayBuffer.isView(buffer)?buffer.byteLength:buffer.byteLength;
      if(size<HULL_CONTACT_COUNT*HULL_CONTACT_RECORD_BYTES)throw Error('Truncated underside readback');
      const f=new Float32Array(bytes,offset,HULL_CONTACT_COUNT*24),u=new Uint32Array(bytes,offset,HULL_CONTACT_COUNT*24),events=[];
      for(let i=0;i<HULL_CONTACT_COUNT;i++){
        const at=i*24,recordEpoch=u[at+20],serial=u[at+21],flags=u[at+23];
        if(recordEpoch!==epoch||(flags&HULL_CONTACT_FLAGS.valid)===0||(flags&HULL_CONTACT_FLAGS.event)===0)continue;
        const delta=(serial-serials[i])>>>0;
        if(delta===0||delta>=0x80000000)continue;
        // Consume before checking age or payload. Expired/invalid events must
        // not become audible later if another read returns the same serial.
        serials[i]=serial;
        const eventTime=f[at+15],age=Number.isFinite(now)?now-eventTime:f[at+13]+extraAge;
        const closing=f[at+19],peakClosing=f[at+14],position=Array.from(f.subarray(at+16,at+19));
        if(!hullContactFinitePoint(position)||![age,eventTime,closing,peakClosing].every(Number.isFinite)
          ||age<-.001||age>staleSeconds||closing<=0||peakClosing<closing)continue;
        events.push({kind:'underside-reentry',probe:i,epoch,serial,time:eventTime,age,
          x:position[0],y:position[1],z:position[2],closing,peakClosing});
      }
      return events;
    },
    snapshot(){return {epoch,serials:Array.from(serials)};},
  };
}

export async function createHullContactProbe({device,frameUBO,hullUBO,seaView,seaSampler,
  computePipe,shader,modelId='nina',limits={},clock=hullContactWallTime}){
  const policy={...HULL_CONTACT_LIMITS,...limits},B=GPUBufferUsage;
  for(const key of ['dryGap','wetGap','dryHold','staleSeconds','minClosing','peakWindow'])
    if(!Number.isFinite(policy[key])||policy[key]<0)throw Error(`Invalid hull contact ${key}`);
  if(!Number.isInteger(policy.readEvery)||policy.readEvery<1)throw Error('Invalid hull contact readEvery');
  let definitions=createHullContactDefinitions(modelId),definitionsDirty=true;
  const input=device.createBuffer({label:'canonical underside probes',size:HULL_CONTACT_COUNT*32,usage:B.STORAGE|B.COPY_DST});
  const control=device.createBuffer({label:'underside contact control',size:48,usage:B.UNIFORM|B.COPY_DST});
  const output=device.createBuffer({label:'persistent underside contacts',size:HULL_CONTACT_COUNT*HULL_CONTACT_RECORD_BYTES,usage:B.STORAGE|B.COPY_SRC});
  const readback=device.createBuffer({label:'underside contact readback',size:HULL_CONTACT_COUNT*HULL_CONTACT_RECORD_BYTES,usage:B.MAP_READ|B.COPY_DST});
  const pipeline=computePipe?await computePipe(HULL_CONTACT_QUERY,'underside incident sea contact'):
    await device.createComputePipelineAsync({label:'underside incident sea contact',layout:'auto',
      compute:{module:await shader(HULL_CONTACT_QUERY,'underside incident sea contact'),entryPoint:'main'}});
  const resources=[{buffer:frameUBO},{buffer:hullUBO},{buffer:control},{buffer:input},seaView,seaSampler,{buffer:output}];
  const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:resources.map((resource,binding)=>({binding,resource}))});
  const bytes=new ArrayBuffer(48),f=new Float32Array(bytes),u=new Uint32Array(bytes),consumer=createHullContactConsumer(policy);
  let epoch=0,sampleID=0,time=0,enabled=false,valid=false,destroyed=false,boat=null,previous=null;
  let encodedSample=-1,copiedSample=-1,encodedRequest=null,pending=null,lastRecords=null,lastEvents=[],lastError=null;
  function reset(){
    epoch=(epoch+1)>>>0;if(epoch===0)epoch=1;
    consumer.reset(epoch);previous=null;encodedRequest=null;encodedSample=-1;copiedSample=-1;
    valid=false;lastEvents=[];lastRecords=null;
  }
  reset();
  const currentRequest=request=>!destroyed&&enabled&&request.epoch===epoch
    &&boat?.revision===request.revision;
  const requestNow=request=>Math.max(time,request.time+Math.max(0,clock()-request.wallTime)/1000);
  function refreshEvent(event){
    if(destroyed||!enabled||event?.epoch!==epoch||event.revision!==boat?.revision)return null;
    const wall=clock(),age=Math.max(time-event.time,event.age+Math.max(0,wall-event.observedWallTime)/1000);
    return Number.isFinite(age)&&age>=-.001&&age<=policy.staleSeconds
      ? {...event,age,observedWallTime:wall}:null;
  }
  return {
    output,control,input,readback,
    get epoch(){return epoch;},get enabled(){return enabled;},get pending(){return !!pending;},
    get requestEpoch(){return encodedRequest?.epoch??pending?.request.epoch??null;},
    update(nextBoat,dt,{enabled:requested=false,resetSea=false,hidden=false}={}){
      if(destroyed)return false;
      const active=!!requested&&!hidden&&nextBoat?.showProw!==false;
      if(active!==enabled){enabled=active;reset();}
      boat=nextBoat;
      // No queue writes, dispatches or copies while disabled, including input.
      if(!enabled)return false;
      const nextModel=boat.modelId??modelId;
      if(nextModel!==definitions.modelId){definitions=createHullContactDefinitions(nextModel);definitionsDirty=true;reset();}
      const fields=[boat.x,boat.z,boat.heave,boat.length,boat.beam,boat.pitch??0,boat.roll??0,boat.heading??0];
      if(!fields.every(Number.isFinite)||!(boat.length>0&&boat.beam>0)||!(dt>0&&dt<=policy.maxDt)){
        reset();return false;
      }
      // Compare actual probe displacement with physical sailing/body rates.
      // The tolerance admits integration error; it is not a force or assistance.
      let moved=false;
      if(previous){
        const radius=Math.max(boat.length*.5,boat.beam*.5,vesselVerticalScale(boat)*2);
        const rates=[boat.rollVelocity??0,boat.pitchVelocity??0,boat.yawRate??0];
        const speed=Math.hypot(boatForwardSpeed(boat),boat.leewayVelocity??0,boat.heaveVelocity??0);
        const envelope=.5+radius*.01+2*dt*(speed+radius*rates.reduce((sum,v)=>sum+Math.abs(v),0));
        if(!Number.isFinite(envelope))moved=true;
        else for(const definition of definitions.points){
          const a=hullContactWorldPoint(definition,boat),b=hullContactWorldPoint(definition,previous);
          if(Math.hypot(...a.map((v,k)=>v-b[k]))>envelope){moved=true;break;}
        }
      }
      if(resetSea||previous&&(previous.revision!==boat.revision||previous.length!==boat.length||previous.beam!==boat.beam)||moved)reset();
      previous={x:boat.x,z:boat.z,heave:boat.heave,length:boat.length,beam:boat.beam,revision:boat.revision,
        modelId:nextModel,pitch:boat.pitch??0,roll:boat.roll??0,heading:boat.heading??0};
      time+=dt;sampleID=(sampleID+1)>>>0;valid=true;encodedSample=-1;
      f.set([dt,time,policy.dryGap,policy.wetGap,policy.dryHold,policy.staleSeconds,policy.minClosing,policy.peakWindow]);
      u.set([epoch,1,HULL_CONTACT_COUNT,sampleID],8);
      if(definitionsDirty){device.queue.writeBuffer(input,0,definitions.values);definitionsDirty=false;}
      device.queue.writeBuffer(control,0,bytes);return true;
    },
    encode(cp){
      if(destroyed||!enabled||!valid||encodedSample===sampleID)return false;
      cp.setPipeline(pipeline);cp.setBindGroup(0,group);cp.dispatchWorkgroups(1);
      encodedSample=sampleID;return true;
    },
    copy(encoder,frameIndex){
      if(destroyed||!enabled||!valid||pending||encodedRequest||encodedSample!==sampleID||copiedSample===sampleID
        ||!Number.isInteger(frameIndex)||frameIndex%policy.readEvery!==0)return false;
      encoder.copyBufferToBuffer(output,0,readback,0,HULL_CONTACT_COUNT*HULL_CONTACT_RECORD_BYTES);
      copiedSample=sampleID;encodedRequest={epoch,revision:boat.revision,sampleID,time,wallTime:clock()};return true;
    },
    read(callback){
      if(pending)return pending.promise;
      if(destroyed||!encodedRequest)return Promise.resolve(0);
      const request=encodedRequest;encodedRequest=null;
      const operation={request,promise:null};pending=operation;
      operation.promise=readback.mapAsync(GPUMapMode.READ).then(async()=>{
        let events=[];
        try{
          // Epoch/revision BEFORE consume: stale completions cannot change the
          // new generation's serial ledger, suppression state or callback.
          if(!currentRequest(request))return 0;
          lastRecords=new Uint8Array(readback.getMappedRange()).slice();
          events=consumer.consume(lastRecords,{epoch:request.epoch,now:requestNow(request)});lastEvents=events;
        }finally{if(readback.mapState==='mapped')readback.unmap();}
        let count=0;
        for(const event of events){
          if(!currentRequest(request))break;
          const age=requestNow(request)-event.time;
          if(age<-.001||age>policy.staleSeconds)continue;
          await callback?.({...event,age,revision:request.revision,observedWallTime:clock()});count++;
        }
        return count;
      }).catch(error=>{lastError=String(error?.message??error);return 0;}).finally(()=>{
        if(pending===operation)pending=null;
      });
      return operation.promise;
    },
    reset,refreshEvent,
    snapshot(){return {epoch,enabled,valid,time,sampleID,pending:!!pending,requestEpoch:encodedRequest?.epoch??pending?.request.epoch??null,
      modelId:definitions.modelId,policy:{...policy},definitions:definitions.points.map(p=>({...p,position:[...p.position],normal:[...p.normal]})),
      consumer:consumer.snapshot(),events:lastEvents.map(e=>({...e})),records:lastRecords?.slice()??null,lastError};},
    destroy(){destroyed=true;enabled=false;reset();for(const buffer of [input,control,output,readback])buffer.destroy();},
  };
}

// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import {SURFACE_WAVE_UPDATE,SURFACE_WAVE_SPEED} from './wgsl/surface-waves.js';

export const SURFACE_WAVE_LIMITS=Object.freeze({emitters:64,nearExtent:256,farExtent:1024,maxDt:.1,restSeconds:45,maxEventAge:.5,dedupe:4096});
const surfaceWaveFinite=(v,fallback=0)=>Number.isFinite(v)?v:fallback;
const surfaceWaveClamp=(v,min,max)=>Math.max(min,Math.min(max,v));

// Physical contact inputs are normalized here; visual FX size/brightness never
// determine wave forcing. Mass-less wildlife uses an authored displaced-water
// mass estimate. The .12 momentum transfer is an authored coupling coefficient.
export function surfaceWaveEmission(event){
  if(!event||typeof event.source!=='string'||!event.source||!Number.isSafeInteger(event.id)||event.id<=0)return null;
  const {x,z,radiusMetres,closingSpeed}=event;
  if(![x,z,radiusMetres,closingSpeed].every(Number.isFinite)||radiusMetres<=0||closingSpeed<0)return null;
  if(!['entry','emerge','trail'].includes(event.kind))return null;
  const velocity=event.velocity??[0,0,0];if(velocity.length!==3||!Array.from(velocity).every(Number.isFinite))return null;
  const age=event.age??0;if(!Number.isFinite(age)||age<0||age>SURFACE_WAVE_LIMITS.maxEventAge)return null;
  if(event.massKg!==undefined&&(!Number.isFinite(event.massKg)||event.massKg<=0))return null;
  const radius=surfaceWaveClamp(radiusMetres,.15,12),speed=Math.hypot(velocity[0],velocity[2]);
  const normalSpeed=event.kind==='trail'?Math.min(2,speed*.09):Math.min(25,closingSpeed);
  if(normalSpeed<=0)return null;
  const waterMass=1000*Math.PI*radius*radius*Math.max(.25,radius);
  const momentum=(event.massKg??waterMass)*normalSpeed;
  const sign=event.kind==='emerge'?-1:1;
  const kick=sign*surfaceWaveClamp(momentum/waterMass*.12,0,5)*Math.exp(-age*.7);
  const direction=speed>1e-6?[velocity[0]/speed,velocity[2]/speed]:[1,0];
  return {source:event.source,id:event.id,x,z,radius,kick,direction,trail:event.kind==='trail',age,
    foam:Math.min(1,Math.abs(kick)*.4),priority:event.kind==='entry'?2:event.kind==='emerge'?1:0};
}

export async function createSurfaceWaves({device,computePipe,size=512}){
  if(!Number.isInteger(size)||size<32||size>512||size%8)throw new RangeError('Surface wave size must be a multiple of 8 between 32 and 512');
  const B=GPUBufferUsage,T=GPUTextureUsage,domains=new Float32Array(8),committed=new Float64Array(4);
  const uniform=device.createBuffer({label:'scene surface wave domains',size:64,usage:B.UNIFORM|B.COPY_DST});
  const uniforms=Array.from({length:3},(_,i)=>device.createBuffer({label:'scene wave substep '+i,size:64,usage:B.UNIFORM|B.COPY_DST}));
  const sources=device.createBuffer({label:'scene wave impulses',size:SURFACE_WAVE_LIMITS.emitters*48,usage:B.STORAGE|B.COPY_DST});
  const textures=[0,1].map(i=>device.createTexture({label:'scene surface waves '+i,size:[size,size,2],format:'rgba16float',usage:T.TEXTURE_BINDING|T.STORAGE_BINDING|T.COPY_SRC}));
  const views=textures.map(t=>t.createView({dimension:'2d-array'})),pipeline=await computePipe(SURFACE_WAVE_UPDATE,'scene surface gravity waves');
  const groups=uniforms.map(u=>views.map((view,i)=>device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[
    {binding:0,resource:{buffer:u}},{binding:1,resource:view},{binding:2,resource:views[1-i]},{binding:3,resource:{buffer:sources}},
  ]})));
  const values=new Float32Array(16),sourceValues=new Float32Array(SURFACE_WAVE_LIMITS.emitters*12),pending=[],seen=new Set();
  const stats={active:false,queued:0,culled:0,dropped:0,duplicates:0,invalid:0,resets:0,dispatches:0,accepted:0};
  let current=0,time=0,lastEmission=-Infinity,needsClear=true,steps=0,destroyed=false,epoch=0,hasDomain=false;
  const writeDomain=(active,dt=0,count=0)=>{values.set(domains,0);values[12]=dt;values[13]=needsClear?1:0;values[14]=count;values[15]=active?1:0;device.queue.writeBuffer(uniform,0,values);};
  function reset(){epoch++;stats.resets++;stats.active=false;pending.length=0;stats.queued=0;seen.clear();steps=0;lastEmission=-Infinity;needsClear=true;hasDomain=false;writeDomain(false);}
  writeDomain(false);
  return {uniform,views,textures,stats,get current(){return current;},get view(){return views[current];},get epoch(){return epoch;},
    emit(event){
      if(destroyed)return false;
      const source=surfaceWaveEmission(event);if(!source){stats.invalid++;return false;}
      if(event.epoch!==undefined&&event.epoch!==epoch){stats.invalid++;return false;}
      const key=source.source+'\u0000'+source.id;if(seen.has(key)){stats.duplicates++;return false;}
      if(pending.length===SURFACE_WAVE_LIMITS.emitters){
        let weakest=0;for(let i=1;i<pending.length;i++)if(pending[i].priority<pending[weakest].priority)weakest=i;
        if(source.priority<=pending[weakest].priority){stats.dropped++;return false;}
        pending.splice(weakest,1);stats.dropped++;
      }
      seen.add(key);if(seen.size>SURFACE_WAVE_LIMITS.dedupe)seen.delete(seen.values().next().value);
      pending.push(source);stats.queued=pending.length;return true;
    },
    update(center,dt,resetField=false){
      if(destroyed)return;
      dt=surfaceWaveClamp(surfaceWaveFinite(dt),0,SURFACE_WAVE_LIMITS.maxDt);time+=dt;steps=0;
      const x=surfaceWaveFinite(center?.x),z=surfaceWaveFinite(center?.z);
      const teleport=hasDomain&&Math.hypot(x-committed[0],z-committed[1])>SURFACE_WAVE_LIMITS.farExtent*.25;
      if(resetField||teleport)reset();
      if(dt===0){writeDomain(stats.active);return;}
      for(let layer=0;layer<2;layer++){
        const extent=layer?SURFACE_WAVE_LIMITS.farExtent:SURFACE_WAVE_LIMITS.nearExtent,dx=extent/size;
        domains.set([Math.round(x/dx)*dx,Math.round(z/dx)*dx,extent,dx],layer*4);
      }
      let count=0;
      for(const source of pending){
        const footprint=Math.max(source.radius,domains[7]*1.5),ageRadius=SURFACE_WAVE_SPEED*source.age;
        const reach=4*Math.hypot(footprint,ageRadius)*(source.trail?1.7:1)+domains[7];
        if(Math.max(Math.abs(source.x-domains[4]),Math.abs(source.z-domains[5]))-reach>=SURFACE_WAVE_LIMITS.farExtent*.495){stats.culled++;continue;}
        sourceValues.set([source.x,source.z,source.radius,source.kick,...source.direction,source.trail?1:0,source.foam,source.age,0,0,0],count++*12);
      }
      pending.length=0;stats.queued=0;
      if(count){lastEmission=time;stats.accepted+=count;device.queue.writeBuffer(sources,0,sourceValues,0,count*12);}
      if(time-lastEmission>SURFACE_WAVE_LIMITS.restSeconds){stats.active=false;needsClear=true;hasDomain=false;writeDomain(false);return;}
      stats.active=true;
      const maxStep=.45*domains[3]/SURFACE_WAVE_SPEED;steps=Math.ceil(dt/maxStep);
      const substep=dt/steps;
      for(let i=0;i<steps;i++){
        values.set(domains,0);values.set(i?[domains[0],domains[1],domains[4],domains[5]]:committed,8);
        values.set([substep,i===0&&needsClear?1:0,i===0?count:0,1],12);device.queue.writeBuffer(uniforms[i],0,values);
      }
      writeDomain(true,dt,count);
    },
    encode(pass){
      if(destroyed||!steps||!stats.active)return;
      pass.setPipeline(pipeline);
      for(let i=0;i<steps;i++){pass.setBindGroup(0,groups[i][current]);pass.dispatchWorkgroups(Math.ceil(size/8),Math.ceil(size/8),2);current=1-current;stats.dispatches++;}
      committed.set([domains[0],domains[1],domains[4],domains[5]]);hasDomain=true;needsClear=false;steps=0;
    },reset,
    destroy(){if(destroyed)return;destroyed=true;for(const b of [uniform,...uniforms,sources])b.destroy();for(const t of textures)t.destroy();},
  };
}

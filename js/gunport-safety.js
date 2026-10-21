// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
import {GUNPORT_CLEARANCE} from './wgsl/gunnery-probe.js';
import {gunMuzzlePose} from './gunnery-models.js';

// A dry muzzle is an operational game constraint, not an historical firing
// doctrine or a simulation of powder ignition. Check the actual displaced sea;
// stale async measurements never authorize a shot after a pose/scene change.
export function createGunportSafetyState({maxAge=.3,maxTravel=.5,margin=.1}={}){
  const samples=new Map();
  const validPosition=p=>p?.length===3&&Array.from(p).every(Number.isFinite);
  return {
    accept(id,{position,height,time,revision=0}){
      if(!Number.isInteger(id)||id<0||id>=128||!validPosition(position)||!Number.isFinite(height)||!Number.isFinite(time))return false;
      const previous=samples.get(id);if(previous?.revision===revision&&previous.time>time)return false;
      samples.set(id,{position:[...position],height,time,revision});return true;
    },
    block(gun,pose,time,revision=0){
      const sample=samples.get(gun.id),p=pose?.position;
      if(!sample||sample.revision!==revision||!validPosition(p)||!Number.isFinite(time)||time<sample.time||time-sample.time>maxAge||
        Math.hypot(...p.map((v,i)=>v-sample.position[i]))>maxTravel)return 'Checking sea at gunports';
      return p[1]-(gun.diameter??.15)*.5-sample.height<=margin?'Gunports awash':null;
    },
    clear(){samples.clear();},
    get size(){return samples.size;},
  };
}

export async function createGunportSafety({device,frameUBO,seaView,seaSampler,computePipe}){
  const B=GPUBufferUsage,limit=128,state=createGunportSafetyState();
  const make=(label,usage)=>device.createBuffer({label,size:limit*16,usage});
  const input=make('gunport muzzle positions',B.STORAGE|B.COPY_DST),output=make('gunport sea clearance',B.STORAGE|B.COPY_SRC),readback=make('gunport clearance readback',B.COPY_DST|B.MAP_READ);
  const count=device.createBuffer({label:'gunport query count',size:16,usage:B.UNIFORM|B.COPY_DST});
  const pipeline=await computePipe(GUNPORT_CLEARANCE,'gunport actual sea clearance');
  const resources=[{buffer:frameUBO},seaView,seaSampler,{buffer:input},{buffer:output},{buffer:count}];
  const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:resources.map((resource,binding)=>({binding,resource}))});
  const points=new Float32Array(limit*4);let pending=null,encoded=null,generation=0,destroyed=false;
  return {
    state,
    block:(...args)=>state.block(...args),
    encode(encoder,boat,time){
      if(destroyed||pending||encoded)return false;
      const guns=boat.gunnery?.guns.filter(g=>g.side===boat.gunnerySide&&(g.stage==='ready'||g.queued))??[];
      if(!guns.length){state.clear();return false;}
      const batch=guns.slice(0,limit).map(g=>({id:g.id,position:gunMuzzlePose(g,boat).position,time,revision:boat.revision??0}));
      for(const [i,p]of batch.entries())points.set([...p.position,guns[i].diameter*.5],i*4);
      device.queue.writeBuffer(input,0,points,0,batch.length*4);device.queue.writeBuffer(count,0,new Uint32Array([batch.length,0,0,0]));
      const pass=encoder.beginComputePass({label:'check sea at loaded muzzles'});pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(batch.length/32));pass.end();
      encoder.copyBufferToBuffer(output,0,readback,0,batch.length*16);encoded={batch,generation};return true;
    },
    read(){
      if(!encoded||pending||destroyed)return false;
      const request=encoded;encoded=null;pending=request;
      readback.mapAsync(GPUMapMode.READ).then(()=>{
        try{if(destroyed||request.generation!==generation)return;
          const values=new Float32Array(readback.getMappedRange());
          for(const [i,p]of request.batch.entries())if(values[i*4+3]>.5)state.accept(p.id,{...p,height:values[i*4]});
        }finally{if(readback.mapState==='mapped')readback.unmap();if(pending===request)pending=null;}
      },()=>{if(pending===request)pending=null;state.clear();});return true;
    },
    clear(){generation++;encoded=null;state.clear();},
    get pending(){return !!pending;},
    destroy(){destroyed=true;generation++;state.clear();for(const b of[input,output,readback,count])b.destroy();},
  };
}

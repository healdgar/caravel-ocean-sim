// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import {GUNNERY_SEA_PROBE} from './wgsl/gunnery-probe.js';

export const GUNNERY_SEA_PROBE_LIMITS=Object.freeze({projectiles:128,knotsPerQuery:65,pathKnots:4096});

export async function createGunnerySeaProbe({device,frameUBO,seaView,seaSampler,shader,computePipe,maxProjectiles=128}){
  const limit=Math.max(1,Math.min(GUNNERY_SEA_PROBE_LIMITS.projectiles,Math.floor(maxProjectiles)||128));
  const B=GPUBufferUsage,knotsPerQuery=GUNNERY_SEA_PROBE_LIMITS.knotsPerQuery;
  const input=device.createBuffer({label:'roundshot sea sweep intervals',size:limit*16,usage:B.STORAGE|B.COPY_DST});
  const knots=device.createBuffer({label:'roundshot unverified trajectory knots',size:limit*knotsPerQuery*16,usage:B.STORAGE|B.COPY_DST});
  const output=device.createBuffer({label:'roundshot FFT sea contacts',size:limit*32,usage:B.STORAGE|B.COPY_SRC});
  const readback=device.createBuffer({label:'roundshot contact readback',size:limit*32,usage:B.COPY_DST|B.MAP_READ});
  const uniform=device.createBuffer({label:'roundshot sea query count',size:16,usage:B.UNIFORM|B.COPY_DST});
  const pipeline=computePipe?await computePipe(GUNNERY_SEA_PROBE,'roundshot actual sea sweep'):
    await device.createComputePipelineAsync({label:'roundshot actual sea sweep',layout:'auto',compute:{module:await shader(GUNNERY_SEA_PROBE,'roundshot actual sea sweep'),entryPoint:'main'}});
  const resources=[{buffer:frameUBO},seaView,seaSampler,{buffer:input},{buffer:knots},{buffer:output},{buffer:uniform}];
  const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:resources.map((resource,binding)=>({binding,resource}))});
  const bytes=new ArrayBuffer(limit*16),queryU32=new Uint32Array(bytes),queryF32=new Float32Array(bytes),knotValues=new Float32Array(limit*knotsPerQuery*4);
  const paths=new Map(),resolved=new Set();let pending=null,encoded=null,generation=0,destroyed=false,overflow=0;
  const validVector=p=>p?.length===3&&Array.from(p).every(Number.isFinite);
  function append(path,p,time){
    if(!validVector(p)||!Number.isFinite(time)||time<=path.latest+1e-9)return;
    // The default 30s / 120Hz flight fits entirely within this bounded history.
    // A deliberately stalled consumer retains the oldest unchecked intervals;
    // newer samples wait in the physics owner's history instead of skipping sea.
    if(path.knots.length>=GUNNERY_SEA_PROBE_LIMITS.pathKnots){overflow++;return;}
    path.knots.push({position:Array.from(p),time});path.latest=time;
  }
  function collect(projectiles,simTime){
    const live=new Set();
    for(const p of projectiles){
      if(!p||!validVector(p.position))continue;
      const id=p.id;live.add(id);if(resolved.has(id))continue;
      let path=paths.get(id);
      if(!path){path={id,radius:Number.isFinite(p.radius)?Math.max(0,p.radius):.075,knots:[],latest:-Infinity};paths.set(id,path);}
      if(Array.isArray(p.history)&&p.history.length){for(const k of p.history)append(path,k.position,k.time);}
      else if(validVector(p.previous)&&Number.isFinite(p.previousTime))append(path,p.previous,p.previousTime);
      append(path,p.position,Number.isFinite(p.time)?p.time:simTime);
    }
    for(const id of paths.keys())if(!live.has(id))paths.delete(id);
    for(const id of resolved)if(!live.has(id))resolved.delete(id);
  }
  return {
    get pending(){return !!pending;},get queued(){return paths.size;},get overflow(){return overflow;},
    encode(encoder,projectiles=[],simTime=0){
      if(destroyed)return false;
      collect(projectiles,simTime);
      if(pending||encoded)return false;
      const batch=[];let knotCount=0;
      for(const path of paths.values()){
        if(batch.length===limit)break;
        if(path.knots.length<2)continue;
        const count=Math.min(path.knots.length,knotsPerQuery),index=batch.length;
        queryU32[index*4]=knotCount;queryU32[index*4+1]=count;queryF32[index*4+2]=path.radius;queryF32[index*4+3]=0;
        for(let k=0;k<count;k++){const point=path.knots[k];knotValues.set([...point.position,point.time],(knotCount+k)*4);}
        knotCount+=count;batch.push({id:path.id,time:path.knots[count-1].time});
      }
      if(!batch.length)return false;
      device.queue.writeBuffer(input,0,bytes,0,batch.length*16);device.queue.writeBuffer(knots,0,knotValues,0,knotCount*4);
      device.queue.writeBuffer(uniform,0,new Uint32Array([batch.length,0,0,0]));
      const pass=encoder.beginComputePass({label:'sweep roundshot against actual FFT sea'});pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(batch.length/32));pass.end();
      encoder.copyBufferToBuffer(output,0,readback,0,batch.length*32);encoded={batch,generation};return true;
    },
    // Call once after queue.submit. It starts a promise without stalling RAF.
    read(onHit){
      if(destroyed||pending||!encoded)return false;
      const request=encoded;encoded=null;pending=request;
      readback.mapAsync(GPUMapMode.READ).then(()=>{
        try{
          if(destroyed||request.generation!==generation)return;
          const values=new Float32Array(readback.getMappedRange());
          for(let i=0;i<request.batch.length;i++){
            const q=request.batch[i],at=i*8,path=paths.get(q.id);if(!path||resolved.has(q.id))continue;
            if(values[at+7]>.5){
              resolved.add(q.id);paths.delete(q.id);
              onHit?.({shotId:q.id,position:Array.from(values.subarray(at,at+3)),time:values[at+3],surfacePosition:Array.from(values.subarray(at+4,at+7)),kind:'water'});
            }else{
              let remove=0;while(remove<path.knots.length-1&&path.knots[remove+1].time<=q.time+1e-7)remove++;
              if(remove)path.knots.splice(0,remove);
            }
          }
        }finally{if(readback.mapState==='mapped')readback.unmap();if(pending===request)pending=null;}
      },()=>{if(pending===request)pending=null;});return true;
    },
    clear(){generation++;paths.clear();resolved.clear();encoded=null;overflow=0;},
    destroy(){destroyed=true;generation++;paths.clear();resolved.clear();for(const b of [input,knots,output,readback,uniform])b.destroy();},
  };
}

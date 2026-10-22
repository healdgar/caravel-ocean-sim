// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
import {rowingDesign} from './models/rowing.js';
import {ROWING_WATER_QUERY} from './wgsl/rowing-water.js';
import {coupleSurfaceHeight} from './wgsl/surface-coupling.js';

export const ROWING_WATER_LIMITS=Object.freeze({columns:32,rows:64,staleSeconds:.25,maxDt:.100001,readEvery:2});
const rowingWaterFiniteDomain=d=>d?.length===4&&d.every(Number.isFinite)&&d[2]>0&&d[3]>0;
const rowingWaterFiniteAxes=a=>a?.length===4&&a.every(Number.isFinite)&&Math.abs(a[0]*a[3]-a[1]*a[2]-1)<1e-5;
export function createRowingWaterConsumer({staleSeconds=ROWING_WATER_LIMITS.staleSeconds}={}){
  let packet=null;
  return {
    accept(values,meta){
      if(!(values instanceof Float32Array)||!Number.isInteger(meta?.columns)||!Number.isInteger(meta?.rows)||meta.columns<2||meta.rows<2||values.length!==meta.columns*meta.rows*4
        ||!rowingWaterFiniteDomain(meta.domain)||!rowingWaterFiniteAxes(meta.axes)||!Number.isFinite(meta.time)||!Number.isInteger(meta.revision))return false;
      if(packet&&meta.time<packet.time)return false;
      packet={...meta,domain:[...meta.domain],axes:[...meta.axes],values:values.slice()};return true;
    },
    sample(x,z,{time=packet?.time,revision=packet?.revision,modelId=packet?.modelId}={}){
      if(!packet||!Number.isFinite(x)||!Number.isFinite(z)||!Number.isFinite(time)||time<packet.time||time-packet.time>staleSeconds||revision!==packet.revision||modelId!==packet.modelId)return null;
      const dx=x-packet.domain[0],dz=z-packet.domain[1],a=packet.axes;
      const X=((dx*a[0]+dz*a[1])/packet.domain[2]+.5)*packet.columns-.5;
      const Z=((dx*a[2]+dz*a[3])/packet.domain[3]+.5)*packet.rows-.5;
      const i=Math.floor(X),j=Math.floor(Z),u=X-i,v=Z-j;
      if(i<0||j<0||i+1>=packet.columns||j+1>=packet.rows)return null;
      const indices=[(j*packet.columns+i)*4,(j*packet.columns+i+1)*4,((j+1)*packet.columns+i)*4,((j+1)*packet.columns+i+1)*4],value=[];
      for(let k=0;k<4;k++){
        const q=indices.map(at=>packet.values[at+k]);if(q.some(x=>!Number.isFinite(x)||Math.abs(x)>1e10))return null;
        value[k]=(q[0]*(1-u)+q[1]*u)*(1-v)+(q[2]*(1-u)+q[3]*u)*v;
      }
      return {height:value[0],velocity:value.slice(1),quality:packet.quality};
    },
    get state(){return packet?{time:packet.time,revision:packet.revision,modelId:packet.modelId,quality:packet.quality}:null;},
    clear(){packet=null;},
  };
}

export async function createRowingWaterProbe({device,frameUBO,seaView,seaSampler,computePipe,modelId,surfaceWaves=null}){
  const design=rowingDesign(modelId),B=GPUBufferUsage,L=ROWING_WATER_LIMITS,count=L.columns*L.rows,bytes=count*16;
  const history=[0,1].map(i=>device.createBuffer({label:modelId+' orbital history '+i,size:bytes,usage:B.STORAGE}));
  const output=device.createBuffer({label:modelId+' rowing water field',size:bytes,usage:B.STORAGE|B.COPY_SRC});
  const read=device.createBuffer({label:modelId+' rowing water readback',size:bytes,usage:B.COPY_DST|B.MAP_READ});
  const uniform=device.createBuffer({label:modelId+' rowing water query',size:96,usage:B.UNIFORM|B.COPY_DST});
  const source=surfaceWaves?coupleSurfaceHeight(ROWING_WATER_QUERY,'0.0','p',{uniformBinding:7,textureBinding:8,samplerName:'rowingWaterSampler'}):ROWING_WATER_QUERY;
  const pipeline=await computePipe(source,'rowing actual water field');
  const groups=history.map((previous,i)=>(surfaceWaves?surfaceWaves.views:[null]).map(view=>device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:
    [{buffer:frameUBO},seaView,seaSampler,{buffer:previous},{buffer:history[1-i]},{buffer:output},{buffer:uniform},...(view?[{buffer:surfaceWaves.uniform},view]:[])].map((resource,binding)=>({binding,resource}))})));
  const consumer=createRowingWaterConsumer(),data=new ArrayBuffer(96),f=new Float32Array(data),u=new Uint32Array(data);
  let boat=null,now=0,domain=null,axes=null,dt=0,chop=1,enabled=false,ready=false,generation=0,lastField=null,bank=0,serial=0,encoded=null,pending=null,destroyed=false;
  function reset(){generation++;lastField=null;encoded=null;ready=false;consumer.clear();}
  function dispose(){if(destroyed)return;destroyed=true;reset();for(const b of [...history,output,read,uniform])b.destroy();}
  return {
    get pending(){return !!pending;},get state(){return consumer.state;},get quality(){return consumer.state?.quality??'unavailable';},
    update(nextBoat,elapsed,{time=now+elapsed,choppy=1,enabled:requested=true,hidden=false,resetSea=false}={}){
      if(destroyed)return false;
      ready=false;
      const active=!!requested&&!hidden;
      if(active!==enabled||resetSea)reset();enabled=active;boat=nextBoat;now=time;dt=elapsed;chop=choppy;
      if(!enabled)return false;
      if(boat.modelId!==modelId)throw Error('Rowing water probe model changed without rebuilding');
      const fields=[boat.x,boat.z,boat.heading,boat.length,boat.beam,time,elapsed,choppy];
      if(!fields.every(Number.isFinite)||!(elapsed>0&&elapsed<=L.maxDt&&boat.length>0&&boat.beam>0)||choppy<0){reset();return false;}
      const h=boat.heading*Math.PI/180;axes=[Math.cos(h),Math.sin(h),-Math.sin(h),Math.cos(h)];
      domain=[boat.x,boat.z,boat.beam+2*design.propulsion.outboard+6,boat.length+6];
      if(lastField&&(lastField.revision!==boat.revision||lastField.length!==boat.length||lastField.beam!==boat.beam||time<=lastField.time
        ||Math.hypot(domain[0]-lastField.domain[0],domain[1]-lastField.domain[1])>Math.min(domain[2],domain[3])*.3))reset();
      ready=true;return true;
    },
    encode(encoder){
      if(destroyed||!enabled||!ready||!domain||!(dt>0&&dt<=L.maxDt))return false;
      const elapsed=lastField?now-lastField.time:dt,valid=!!lastField&&elapsed>0&&elapsed<=L.maxDt;
      f.set(domain,0);f.set(lastField?.domain??domain,4);f.set(axes,8);f.set(lastField?.axes??axes,12);
      f.set([elapsed,Number(valid),chop,lastField?.chop??chop],16);u.set([L.columns,L.rows,generation,0],20);device.queue.writeBuffer(uniform,0,data);
      const pass=encoder.beginComputePass({label:'sample actual rowing water'});pass.setPipeline(pipeline);pass.setBindGroup(0,groups[bank][surfaceWaves?surfaceWaves.current:0]);pass.dispatchWorkgroups(L.columns/8,L.rows/8);pass.end();bank=1-bank;
      const meta={time:now,revision:boat.revision,modelId,domain:[...domain],axes:[...axes],columns:L.columns,rows:L.rows,
        quality:chop>.05&&(lastField?.chop??0)>.05?'surface-orbital':'vertical-only',length:boat.length,beam:boat.beam,chop,generation};
      lastField=meta;serial++;
      if(!pending&&!encoded&&valid&&serial%L.readEvery===0){encoder.copyBufferToBuffer(output,0,read,0,bytes);encoded=meta;}
      return true;
    },
    // Start after queue.submit; this promise never blocks animation or physics.
    readback(){
      if(destroyed||pending||!encoded)return false;
      const request=encoded;encoded=null;pending=request;
      read.mapAsync(GPUMapMode.READ).then(()=>{
        try{if(!destroyed&&request.generation===generation)consumer.accept(new Float32Array(read.getMappedRange()),request);}
        finally{if(read.mapState==='mapped')read.unmap();if(pending===request)pending=null;}
      },()=>{if(pending===request)pending=null;});return true;
    },
    sample(x,z){return enabled&&boat?consumer.sample(x,z,{time:now,revision:boat.revision,modelId:boat.modelId}):null;},
    reset,destroy:dispose,dispose,
  };
}

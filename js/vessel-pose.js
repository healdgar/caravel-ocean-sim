// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import {VESSEL_POSE_UPDATE,VESSEL_POSE_DYNAMIC_UPDATE,VESSEL_SURFACE_POSE_UPDATE,VESSEL_SURFACE_POSE_DYNAMIC_UPDATE} from './wgsl/vessel-pose.js';
import {createRigGPUFrame,writeRigGPUFrame} from './rig-gpu-data.js';
import {createVesselRecoil} from './vessel-recoil.js';
import {createPartAssemblyGPU,bakeVesselImpactMarks} from './part-assembly.js';
import {createShipFractureGPU} from './ship-fracture.js';
import {createVesselDetailGPU} from './vessel-detail.js';

const vesselPosePipelineCache=new WeakMap();
async function vesselPosePipeline(device,computePipe,generic,dynamic=false){
  let modes=vesselPosePipelineCache.get(device);if(!modes){modes=new Map();vesselPosePipelineCache.set(device,modes);}
  const key=(generic?2:0)|(dynamic?1:0);
  const code=generic?(dynamic?VESSEL_SURFACE_POSE_DYNAMIC_UPDATE:VESSEL_SURFACE_POSE_UPDATE):(dynamic?VESSEL_POSE_DYNAMIC_UPDATE:VESSEL_POSE_UPDATE);
  if(!modes.has(key))modes.set(key,computePipe(code,dynamic?'shared dynamic vessel deformation':'shared vessel deformation'));
  try{return await modes.get(key);}catch(error){modes.delete(key);throw error;}
}

function collectDynamicVesselIndices(vertexCount,mesh,rigData,recoilMap=null){
  const set=new Set();
  if(rigData){
    const verts=rigData.vertices;
    for(let i=0;i<vertexCount;i++)if(verts[i*12]!==0)set.add(i);
  }else if(mesh instanceof Float32Array&&mesh.length>=vertexCount*9){
    for(let i=0;i<vertexCount;i++){
      const m=mesh[i*9+6],base=Math.floor(m),frac=m-base,uvx=mesh[i*9+7];
      if(base===7||base===8||base===14||base===18||(base===12&&uvx>=100)||(frac>1e-4&&(base===9||base===13||base===19||base===10)))set.add(i);
    }
  }else{
    return null;
  }
  // Always reset gun recoil vertices in the dynamic pass so VESSEL_RECOIL_UPDATE never accumulates across frames
  // without forcing a full-hull pose dispatch while sailing intact.
  if(recoilMap?.guns?.length){
    for(const gun of recoilMap.guns){
      if(gun?.indices)for(const idx of gun.indices)if(idx<vertexCount)set.add(idx);
    }
  }
  return Uint32Array.from(set).sort((a,b)=>a-b);
}

export async function createVesselPose({device,computePipe,sourceBuffer,mesh=null,pristineMesh=null,vertexCount,hullUBO,shared=null,rigData=null,recoilMap=null,partAssembly=null,fracture=null,detail=null}){
  if(!Number.isSafeInteger(vertexCount)||vertexCount<1)throw new RangeError('Vessel pose needs a positive vertex count');
  if(shared&&shared.device!==device)throw new Error('Vessel pose assets belong to another graphics device');
  if(shared&&(shared.rigData??null)!==rigData)throw new Error('Vessel pose metadata belongs to another model');
  if(rigData&&(!(rigData.model instanceof Float32Array)||!(rigData.vertices instanceof Float32Array)||rigData.vertices.length!==vertexCount*12))throw Error('GPU rig metadata must match every indexed vertex');
  const pipeline=shared?.pipeline??await vesselPosePipeline(device,computePipe,!!rigData);
  // Her detail layer's line vertices follow her assembly's posed vertices, three rows each (js/vessel-detail.js),
  // rounded up to whole posed records so every pass that reads her posed vertices as records still may.
  const lineBytes=detail?.lineVertexCount?Math.ceil(detail.lineVertexCount*3/2)*32:0;
  // Then one posed record more: the header by which the continuum's RIDER kind reads all of it (js/wgsl/ship-kinds.js),
  // written once by her continuum (js/vessel-continuum.js) at vec4f `headerAt`.
  const headerAt=(vertexCount*32+lineBytes)/16;
  const buffer=device.createBuffer({label:'posed vessel vertices',size:vertexCount*32+lineBytes+32,
    usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_SRC|GPUBufferUsage.COPY_DST});
  const resources=[hullUBO,sourceBuffer,buffer],state=rigData?createRigGPUFrame(rigData):null;
  let modelBuffer=shared?.modelBuffer??null,metadataBuffer=shared?.metadataBuffer??null,stateBuffer=null;
  if(rigData){
    const upload=(label,data)=>{const value=device.createBuffer({label,size:data.byteLength,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});device.queue.writeBuffer(value,0,data);return value;};
    if(!shared){modelBuffer=upload('shared rig descriptors',rigData.model);metadataBuffer=upload('shared indexed rig bindings',rigData.vertices);}
    stateBuffer=device.createBuffer({label:'vessel compact rig state',size:state.byteLength,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});
    resources.push(modelBuffer,metadataBuffer,stateBuffer);
  }
  // The descriptor shader reads its compact state rather than Hull. Automatic
  // layouts omit that unused binding; retain the original binding numbers.
  const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:resources.map((resource,binding)=>({binding,resource:{buffer:resource}})).filter(entry=>!rigData||entry.binding!==0)});
  // Compact dynamic-only vertex dispatch: rigid hull/deck/gun/mast vertices never move while sailing intact,
  // cutting pose compute threads by 65–95% across every ship model with bit-identical results.
  let dynamicPipeline=shared?.dynamicPipeline??null,dynamicBuffer=shared?.dynamicBuffer??null,dynamicCount=shared?.dynamicCount??-1,dynamicGroup=null;
  if(!shared){
    const indices=collectDynamicVesselIndices(vertexCount,pristineMesh??mesh,rigData,recoilMap);
    if(indices&&indices.length<vertexCount){
      dynamicCount=indices.length;
      if(dynamicCount>0){
        dynamicPipeline=await vesselPosePipeline(device,computePipe,!!rigData,true);
        dynamicBuffer=device.createBuffer({label:'shared dynamic vessel vertex indices',size:indices.byteLength,usage:GPUBufferUsage.STORAGE|GPUBufferUsage.COPY_DST});
        device.queue.writeBuffer(dynamicBuffer,0,indices);
      }
    }
  }
  if(dynamicPipeline&&dynamicBuffer&&dynamicCount>0){
    const dynBinding=rigData?6:3;
    const dynEntries=resources.map((resource,binding)=>({binding,resource:{buffer:resource}})).filter(entry=>!rigData||entry.binding!==0);
    dynEntries.push({binding:dynBinding,resource:{buffer:dynamicBuffer}});
    dynamicGroup=device.createBindGroup({layout:dynamicPipeline.getBindGroupLayout(0),entries:dynEntries});
  }
  const recoil=recoilMap?.guns?.length?await createVesselRecoil({device,computePipe,posedBuffer:buffer,recoilMap,shared:shared?.recoilAssets??null}):null;
  const assembly=partAssembly?.parts?.length?await createPartAssemblyGPU({device,computePipe,posedBuffer:buffer,catalog:partAssembly,shared:shared?.partAssemblyAssets??null}):null;
  const shards=fracture?.shardCount>1?await createShipFractureGPU({device,computePipe,posedBuffer:buffer,fracture,shared:shared?.fractureAssets??null}):null;
  const details=detail&&(detail.stationCount||detail.lineVertexCount)?await createVesselDetailGPU({device,computePipe,posedBuffer:buffer,sourceBuffer,hullUBO,detail,fracture:shards,shared:shared?.detailAssets??null}):null;
  const assets=shared??Object.freeze({device,pipeline,dynamicPipeline,dynamicBuffer,dynamicCount,rigData,modelBuffer,metadataBuffer,recoilAssets:recoil?.assets??null,partAssemblyAssets:assembly?.assets??null,fractureAssets:shards?.assets??null,detailAssets:details?.assets??null});let destroyed=false,initialized=!rigData;
  // True once her vertices carry damage, which the hull shader's whole variant would not draw.
  let baked=false,clock=0,needsFullPose=true;
  return {buffer,assets,vertexCount,headerAt,lineVertexCount:detail?.lineVertexCount??0,partAssembly:assembly,
    get scarred(){return baked||assembly?.active===true||shards?.active===true;},
    update(boat,time,wind){
      clock=time;shards?.tick(boat?.damage,time,boat);
      if(destroyed||!rigData)return false;
      writeRigGPUFrame(rigData,boat,time,wind,state);device.queue.writeBuffer(stateBuffer,0,state);initialized=true;return true;
    },
    updateRecoil(guns,boat){return recoil?.update(guns,boat)??false;},
    // Her detail's compact state for the frame (js/vessel-detail.js writeVesselDetailState).
    updateDetail(values){details?.update(values);},
    updateDamage(boat){
      if(destroyed)return false;
      let updated=false;
      if(assembly){
        assembly.state.syncVesselDamage(boat?.damage,boat);
        if(assembly.update())updated=true;
      }
      const pending=boat?.damage?.pendingBakes;
      if(mesh instanceof Float32Array&&Array.isArray(pending)&&pending.length>0){
        const batch=pending.splice(0,6);
        shards?.apply(boat.damage,batch,clock,boat);
        const range=bakeVesselImpactMarks(mesh,batch,9);
        if(range){
          baked=true;needsFullPose=true;
          device.queue.writeBuffer(sourceBuffer,range.byteOffset,mesh.buffer,mesh.byteOffset+range.byteOffset,range.byteLength);
          updated=true;
        }
      }
      if(shards?.sync(boat?.damage,boat))updated=true;
      return updated;
    },
    // Undo scorch marks and broken shards once a repair or a new ship makes them wrong.
    restoreGeometry(){
      if(destroyed||!(mesh instanceof Float32Array)||!(pristineMesh instanceof Float32Array))return false;
      mesh.set(pristineMesh);device.queue.writeBuffer(sourceBuffer,0,mesh);baked=false;needsFullPose=true;shards?.reset();return true;
    },
    encode(pass,enabled=true){
      if(!enabled||destroyed)return false;
      if(!initialized)throw Error('GPU rig state must be updated before dispatch');
      const inplaceMutators=Boolean(assembly?.active||shards?.active);
      if(needsFullPose||inplaceMutators||dynamicCount<0||(recoil?.active&&!dynamicGroup)){
        pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(vertexCount/64));
        needsFullPose=inplaceMutators||Boolean(recoil?.active&&!dynamicGroup);
      }else if(dynamicCount>0&&dynamicGroup){
        pass.setPipeline(dynamicPipeline);pass.setBindGroup(0,dynamicGroup);pass.dispatchWorkgroups(Math.ceil(dynamicCount/64));
      }
      recoil?.encode(pass);assembly?.encode(pass);
      // Her colours and her anchor's iron are placed on her assembled parts, then her shards fly with them, then her
      // lines are laid between the parts they ride.
      details?.encodeStations(pass);shards?.encode(pass);details?.encodeLines(pass);return true;
    },
    destroy(){if(!destroyed){destroyed=true;recoil?.destroy();assembly?.destroy();details?.destroy();shards?.destroy();buffer.destroy();stateBuffer?.destroy();}},
  };
}

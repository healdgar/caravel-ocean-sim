// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import {HULL_VERTICAL_SCALE} from './hull.js';
import {VESSEL_POSE_UPDATE,VESSEL_SURFACE_POSE_UPDATE} from './wgsl/vessel-pose.js';
import {createRigGPUFrame,writeRigGPUFrame} from './rig-gpu-data.js';

const vesselPosePipelineCache=new WeakMap();
async function vesselPosePipeline(device,computePipe,generic){
  let modes=vesselPosePipelineCache.get(device);if(!modes){modes=new Map();vesselPosePipelineCache.set(device,modes);}
  if(!modes.has(generic))modes.set(generic,computePipe(generic?VESSEL_SURFACE_POSE_UPDATE:VESSEL_POSE_UPDATE,'shared vessel deformation'));
  try{return await modes.get(generic);}catch(error){modes.delete(generic);throw error;}
}

export const POSED_VERTEX_LAYOUT=Object.freeze({arrayStride:32,attributes:Object.freeze([
  Object.freeze({shaderLocation:4,offset:0,format:'float32x3'}),
  Object.freeze({shaderLocation:5,offset:16,format:'float32x3'}),
])});

// Alter only the posed position/normal input. Material coordinates, original
// normals, UVs, vertex indices and moisture lookup retain their exact contract.
export function withPosedVesselVertices(source){
  const signature=/(@vertex\s+fn\s+vs\s*\()([\s\S]*?)(\)\s*->)/;
  const call='rigVertex(position,normal,material,uv)';
  if(!signature.test(source)||source.split(call).length!==2)throw new Error('Unrecognized vessel vertex shader');
  if(/@location\([45]\)\s+(?:posedPosition|posedNormal)/.test(source))throw new Error('Vessel vertices are already posed');
  return source.replace(signature,(_match,start,args,end)=>start+args+',@location(4) posedPosition:vec3f,@location(5) posedNormal:vec3f'+end)
    .replace(call,`RigVertex(posedPosition,posedNormal,vec3f(hull.size.x/3.6,select(${HULL_VERTICAL_SCALE},hull.right.w,hull.right.w>0.0),hull.size.y/12.0))`);
}

export async function createVesselPose({device,computePipe,sourceBuffer,vertexCount,hullUBO,shared=null,rigData=null}){
  if(!Number.isSafeInteger(vertexCount)||vertexCount<1)throw new RangeError('Vessel pose needs a positive vertex count');
  if(shared&&shared.device!==device)throw new Error('Vessel pose assets belong to another graphics device');
  if(shared&&(shared.rigData??null)!==rigData)throw new Error('Vessel pose metadata belongs to another model');
  if(rigData&&(!(rigData.model instanceof Float32Array)||!(rigData.vertices instanceof Float32Array)||rigData.vertices.length!==vertexCount*12))throw Error('GPU rig metadata must match every indexed vertex');
  const pipeline=shared?.pipeline??await vesselPosePipeline(device,computePipe,!!rigData);
  const buffer=device.createBuffer({label:'posed vessel vertices',size:vertexCount*32,
    usage:GPUBufferUsage.STORAGE|GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_SRC});
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
  const assets=shared??Object.freeze({device,pipeline,rigData,modelBuffer,metadataBuffer});let destroyed=false,initialized=!rigData;
  return {buffer,assets,vertexCount,
    update(boat,time,wind){
      if(destroyed||!rigData)return false;
      writeRigGPUFrame(rigData,boat,time,wind,state);device.queue.writeBuffer(stateBuffer,0,state);initialized=true;return true;
    },
    encode(pass,enabled=true){
      if(!enabled||destroyed)return false;
      if(!initialized)throw Error('GPU rig state must be updated before dispatch');
      pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(vertexCount/64));return true;
    },
    destroy(){if(!destroyed){destroyed=true;buffer.destroy();stateBuffer?.destroy();}},
  };
}

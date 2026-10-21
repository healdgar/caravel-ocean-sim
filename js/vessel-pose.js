// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import {HULL_VERTICAL_SCALE} from './hull.js';
import {VESSEL_POSE_UPDATE} from './wgsl/vessel-pose.js';

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

export async function createVesselPose({device,computePipe,sourceBuffer,vertexCount,hullUBO,shared=null}){
  if(!Number.isSafeInteger(vertexCount)||vertexCount<1)throw new RangeError('Vessel pose needs a positive vertex count');
  if(shared&&shared.device!==device)throw new Error('Vessel pose assets belong to another graphics device');
  const pipeline=shared?.pipeline??await computePipe(VESSEL_POSE_UPDATE,'shared vessel deformation');
  const buffer=device.createBuffer({label:'posed vessel vertices',size:vertexCount*32,
    usage:GPUBufferUsage.STORAGE|GPUBufferUsage.VERTEX|GPUBufferUsage.COPY_SRC});
  const group=device.createBindGroup({layout:pipeline.getBindGroupLayout(0),entries:[hullUBO,sourceBuffer,buffer].map((resource,binding)=>({binding,resource:{buffer:resource}}))});
  const assets=shared??Object.freeze({device,pipeline});let destroyed=false;
  return {buffer,assets,vertexCount,
    encode(pass,enabled=true){
      if(!enabled||destroyed)return false;
      pass.setPipeline(pipeline);pass.setBindGroup(0,group);pass.dispatchWorkgroups(Math.ceil(vertexCount/64));return true;
    },
    destroy(){if(!destroyed){destroyed=true;buffer.destroy();}},
  };
}

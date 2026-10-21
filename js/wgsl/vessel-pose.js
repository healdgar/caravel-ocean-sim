// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import {VESSEL_RIG} from './vessel.js';

// The canonical deformation is evaluated once per original indexed vertex.
// Original local/material/UV data stays in the unmodified source vertex buffer.
export const VESSEL_POSE_UPDATE=VESSEL_RIG+/* wgsl */ `
@group(0)@binding(0)var<uniform>hull:Hull;
@group(0)@binding(1)var<storage,read>vesselPoseSource:array<f32>;
struct VesselPoseVertex {position:vec4f,normal:vec4f};
@group(0)@binding(2)var<storage,read_write>vesselPoseOutput:array<VesselPoseVertex>;
@compute @workgroup_size(64)fn main(@builtin(global_invocation_id)id:vec3u){
  let vertex=id.x;let at=vertex*9u;
  if(vertex>=arrayLength(&vesselPoseOutput)||at+8u>=arrayLength(&vesselPoseSource)){return;}
  let position=vec3f(vesselPoseSource[at],vesselPoseSource[at+1u],vesselPoseSource[at+2u]);
  let normal=vec3f(vesselPoseSource[at+3u],vesselPoseSource[at+4u],vesselPoseSource[at+5u]);
  let uv=vec2f(vesselPoseSource[at+7u],vesselPoseSource[at+8u]);
  let rig=rigVertex(position,normal,vesselPoseSource[at+6u],uv);
  vesselPoseOutput[vertex]=VesselPoseVertex(vec4f(rig.position,0),vec4f(rig.normal,0));
}
`;

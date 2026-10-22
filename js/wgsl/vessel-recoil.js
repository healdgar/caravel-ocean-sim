// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Runs after canonical ship deformation. Each record owns one indexed vertex;
// no original vertex buffer is rewritten and no position is read back to CPU.
export const VESSEL_RECOIL_UPDATE=/* wgsl */ `
struct VesselRecoilVertex {position:vec4f,normal:vec4f};
@group(0)@binding(0)var<storage,read_write>vesselRecoilPosed:array<VesselRecoilVertex>;
@group(0)@binding(1)var<storage,read>vesselRecoilRecords:array<vec2u>;
@group(0)@binding(2)var<storage,read>vesselRecoilDeltas:array<vec4f>;
@compute @workgroup_size(64)fn main(@builtin(global_invocation_id)id:vec3u){
  if(id.x>=arrayLength(&vesselRecoilRecords)){return;}
  let record=vesselRecoilRecords[id.x];
  if(record.x>=arrayLength(&vesselRecoilPosed)||record.y>=arrayLength(&vesselRecoilDeltas)){return;}
  let delta=vesselRecoilDeltas[record.y].xyz;if(all(delta==vec3f(0))){return;}
  vesselRecoilPosed[record.x].position+=vec4f(delta,0);
}
`;

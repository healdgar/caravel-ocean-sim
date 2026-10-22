// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
import {FRAME_WGSL,CASCADES} from './common.js';

// Previous displacements are reprojected at the SAME material coordinate q.
// The grid may move/rotate with its ship; that motion never enters dD(q)/dt.
// This is a near-surface linear orbital approximation, not a depth-resolved
// velocity solver. Visual horizontal choppiness is divided out when available.
export const ROWING_WATER_QUERY=FRAME_WGSL+/* wgsl */ `
struct RowingWaterQuery {
  domain:vec4f,previousDomain:vec4f,axes:vec4f,previousAxes:vec4f,
  step:vec4f, // dt, valid previous field, current chop, previous chop
  grid:vec4u,
};
@group(0)@binding(0)var<uniform> F:Frame;
@group(0)@binding(1)var rowingWaterSea:texture_2d_array<f32>;
@group(0)@binding(2)var rowingWaterSampler:sampler;
@group(0)@binding(3)var<storage,read> rowingWaterPrevious:array<vec4f>;
@group(0)@binding(4)var<storage,read_write> rowingWaterNext:array<vec4f>;
@group(0)@binding(5)var<storage,read_write> rowingWaterOutput:array<vec4f>;
@group(0)@binding(6)var<uniform> RW:RowingWaterQuery;
fn rowingWaterDisplacement(q:vec2f)->vec3f {
  var value=vec3f(0);
  for(var cascade=0u;cascade<${CASCADES}u;cascade++){
    value+=textureSampleLevel(rowingWaterSea,rowingWaterSampler,q*F.cascInvL[cascade>>2u][cascade&3u],i32(cascade),0.0).xyz;
  }
  return value;
}
fn rowingWaterExtra(p:vec2f)->f32{return 0.0;}
fn rowingWaterPast(q:vec2f)->vec4f {
  let delta=q-RW.previousDomain.xy;
  let uv=vec2f(dot(delta,RW.previousAxes.xy),dot(delta,RW.previousAxes.zw))/RW.previousDomain.zw+.5;
  let at=uv*vec2f(RW.grid.xy)-.5;let base=vec2i(floor(at));let f=fract(at);let size=vec2i(RW.grid.xy);
  if(any(base<vec2i(0))||any(base+vec2i(1)>=size)){return vec4f(1e20);}
  let i=u32(base.y)*RW.grid.x+u32(base.x);
  return mix(mix(rowingWaterPrevious[i],rowingWaterPrevious[i+1u],f.x),
    mix(rowingWaterPrevious[i+RW.grid.x],rowingWaterPrevious[i+RW.grid.x+1u],f.x),f.y);
}
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
  if(any(id.xy>=RW.grid.xy)){return;}
  let index=id.y*RW.grid.x+id.x;let uv=(vec2f(id.xy)+.5)/vec2f(RW.grid.xy)-.5;
  let p=RW.domain.xy+RW.axes.xy*(uv.x*RW.domain.z)+RW.axes.zw*(uv.y*RW.domain.w);
  // Save the material-grid snapshot, not samples following a moving hull point.
  rowingWaterNext[index]=vec4f(rowingWaterDisplacement(p),rowingWaterExtra(p));
  if(RW.step.y<.5||RW.step.x<=0.0){rowingWaterOutput[index]=vec4f(1e20);return;}
  var q=p;
  for(var inverse=0u;inverse<4u;inverse++){q=p-rowingWaterDisplacement(q).xz;}
  let current=rowingWaterDisplacement(q);let old=rowingWaterPast(q);
  if(any(abs(old)>vec4f(1e10))){rowingWaterOutput[index]=vec4f(1e20);return;}
  var velocity=vec3f(0,(current.y-old.y+rowingWaterExtra(q)-old.w)/RW.step.x,0);
  if(RW.step.z>.05&&RW.step.w>.05){
    let horizontal=(current.xz/RW.step.z-old.xz/RW.step.w)/RW.step.x;
    velocity.x=horizontal.x;velocity.z=horizontal.y;
  }
  // A zero-chop non-flat field retains actual vertical motion and contact.
  // Its unrecoverable horizontal component is explicitly reported as omitted.
  rowingWaterOutput[index]=vec4f(current.y+rowingWaterExtra(p),velocity);
}
`;

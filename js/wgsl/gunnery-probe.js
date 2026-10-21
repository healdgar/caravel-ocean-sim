// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import {FRAME_WGSL,CASCADES} from './common.js';

// Every query is an ordered section of the physics owner's actual pose history.
// The sea is the current FFT snapshot. Spatially sweeping old path knots avoids
// tunneling on delayed readback; it does not replay historical ocean textures.
export const GUNNERY_SEA_PROBE=FRAME_WGSL+/* wgsl */ `
@group(0)@binding(0)var<uniform>F:Frame;
@group(0)@binding(1)var gunneryProbeSea:texture_2d_array<f32>;
@group(0)@binding(2)var gunneryProbeSampler:sampler;
struct GunnerySeaQuery{offset:u32,count:u32,radius:f32,padding:f32};
@group(0)@binding(3)var<storage,read>gunnerySeaQueries:array<GunnerySeaQuery>;
@group(0)@binding(4)var<storage,read>gunnerySeaKnots:array<vec4f>;
struct GunnerySeaHit{positionTime:vec4f,surfaceHit:vec4f};
@group(0)@binding(5)var<storage,read_write>gunnerySeaHits:array<GunnerySeaHit>;
@group(0)@binding(6)var<uniform>gunnerySeaCount:vec4u;
fn gunneryProbeDisplacement(q:vec2f)->vec3f{
  var d=vec3f(0);
  for(var cascade=0u;cascade<${CASCADES}u;cascade++){
    d+=textureSampleLevel(gunneryProbeSea,gunneryProbeSampler,q*F.cascInvL[cascade>>2u][cascade&3u],i32(cascade),0.0).xyz;
  }
  return d;
}
fn gunneryProbeHeight(p:vec2f)->f32{
  var q=p;
  for(var inverse=0u;inverse<2u;inverse++){q=p-gunneryProbeDisplacement(q).xz;}
  return gunneryProbeDisplacement(q).y;
}
fn gunneryProbeClearance(start:vec4f,end:vec4f,fraction:f32,radius:f32)->f32{
  let p=mix(start.xyz,end.xyz,fraction);return p.y-radius-gunneryProbeHeight(p.xz);
}
@compute @workgroup_size(32)fn main(@builtin(global_invocation_id)id:vec3u){
  if(id.x>=gunnerySeaCount.x){return;}
  let query=gunnerySeaQueries[id.x];var hit=GunnerySeaHit(vec4f(0),vec4f(0));
  for(var knot=1u;knot<query.count;knot++){
    let start=gunnerySeaKnots[query.offset+knot-1u];let end=gunnerySeaKnots[query.offset+knot];
    let segments=max(1u,u32(ceil(length(end.xyz-start.xyz)/.75)));var low=0.0;
    var fraction=-1.0;
    if(gunneryProbeClearance(start,end,0.0,query.radius)<=0.0){fraction=0.0;}
    else{
      for(var segment=1u;segment<=segments;segment++){
        var high=f32(segment)/f32(segments);
        if(gunneryProbeClearance(start,end,high,query.radius)<=0.0){
          for(var refine=0u;refine<14u;refine++){
            let mid=(low+high)*.5;
            if(gunneryProbeClearance(start,end,mid,query.radius)>0.0){low=mid;}else{high=mid;}
          }
          fraction=high;break;
        }
        low=high;
      }
    }
    if(fraction>=0.0){
      hit.positionTime=mix(start,end,fraction);
      hit.surfaceHit=vec4f(hit.positionTime.x,gunneryProbeHeight(hit.positionTime.xz),hit.positionTime.z,1);
      break;
    }
  }
  gunnerySeaHits[id.x]=hit;
}
`;

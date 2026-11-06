// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Moves every released shard as one rigid body, after the rig, recoil and part stages have posed her.
// All the motion is here: JavaScript writes a shard's flight once, when it breaks. Shard 0 stays put.
export const SHIP_FRACTURE_POSE_UPDATE = /* wgsl */ `
struct FracturePoseVertex {position:vec4f,normal:vec4f};
struct FractureClock {now:f32,gravity:f32,pad0:f32,pad1:f32,scale:vec4f};
@group(0)@binding(0)var<storage,read_write>fracturePosed:array<FracturePoseVertex>;
@group(0)@binding(1)var<storage,read>fractureVertexShards:array<u32>;
@group(0)@binding(2)var<storage,read>fractureRecords:array<vec4f>;
@group(0)@binding(3)var<uniform>fractureClock:FractureClock;
fn fractureRotate(v:vec3f,axis:vec3f,c:f32,s:f32)->vec3f {
  return v*c+cross(axis,v)*s+axis*dot(axis,v)*(1.0-c);
}
@compute @workgroup_size(64)fn main(@builtin(global_invocation_id)id:vec3u){
  let vertex=id.x;
  if(vertex>=arrayLength(&fracturePosed)||vertex>=arrayLength(&fractureVertexShards)){return;}
  let shard=fractureVertexShards[vertex];
  if(shard==0u){return;}
  let at=shard*4u;
  let motion=fractureRecords[at+3u];
  // Age -2 is an intact shard.
  if(motion.w<-1.5){return;}
  let origin=fractureRecords[at];
  let flight=fractureRecords[at+1u];
  let spinHide=fractureRecords[at+2u];
  let age=select(max(0.0,fractureClock.now-origin.w),motion.w,motion.w>=0.0);
  let current=fracturePosed[vertex];
  // Gone: every vertex at one point, so its triangles have no area and raster nothing.
  if(spinHide.w>=0.0&&age>=spinHide.w){
    fracturePosed[vertex].position=vec4f(origin.xyz,current.position.w);
    return;
  }
  let scale=fractureClock.scale.xyz;
  let settle=flight.w;
  let hinge=motion.x;
  let rate=length(spinHide.xyz);
  let free=max(0.0,min(age,settle)-hinge);
  let held=min(age,hinge);
  var angle=rate*free;
  if(hinge>0.0){angle+=0.5*rate*held*held/hinge;}
  let drop=0.5*fractureClock.gravity*motion.y*free*free+motion.z*max(0.0,age-settle);
  let displacement=flight.xyz*free-vec3f(0.0,drop,0.0);
  // Rigid in metres: a ship's design frame is not uniformly scaled.
  var relative=(current.position.xyz-origin.xyz)*scale;
  var normal=current.normal.xyz;
  if(rate>1e-5){
    let axis=spinHide.xyz/rate;
    let c=cos(angle);let s=sin(angle);
    relative=fractureRotate(relative,axis,c,s);
    let scaleOfNormal=length(normal);
    let turned=fractureRotate(normal/max(scaleOfNormal,1e-5)/scale,axis,c,s)*scale;
    normal=normalize(turned)*scaleOfNormal;
  }
  fracturePosed[vertex].position=vec4f(origin.xyz+(relative+displacement)/scale,current.position.w);
  fracturePosed[vertex].normal=vec4f(normal,current.normal.w);
}
`;

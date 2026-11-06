// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Moves every released shard as one rigid body. All the motion is here: JavaScript writes a shard's flight
// once, when it breaks. Shard 0 stays put. Ships pose in place, after the rig, recoil and part stages.
// Buildings are static, so they pose from their rest vertices and only while something is in the air.
const SHARD_FLIGHT = /* wgsl */ `
struct FractureClock {now:f32,gravity:f32,pad0:f32,pad1:f32,scale:vec4f};
struct ShardPose {position:vec3f,normal:vec3f};
fn fractureRotate(v:vec3f,axis:vec3f,c:f32,s:f32)->vec3f {
  return v*c+cross(axis,v)*s+axis*dot(axis,v)*(1.0-c);
}
// A point of a shard on the clock, given its record. Age -2 (intact) must be handled by the caller.
fn shardFlight(position:vec3f,restNormal:vec3f,origin:vec4f,flight:vec4f,spinHide:vec4f,motion:vec4f,clock:FractureClock)->ShardPose {
  let age=select(max(0.0,clock.now-origin.w),motion.w,motion.w>=0.0);
  // Gone: every vertex at one point, so its triangles have no area and raster nothing.
  if(spinHide.w>=0.0&&age>=spinHide.w){return ShardPose(origin.xyz,restNormal);}
  let scale=clock.scale.xyz;
  let settle=flight.w;
  let hinge=motion.x;
  let rate=length(spinHide.xyz);
  let free=max(0.0,min(age,settle)-hinge);
  let held=min(age,hinge);
  var angle=rate*free;
  if(hinge>0.0){angle+=0.5*rate*held*held/hinge;}
  let drop=0.5*clock.gravity*motion.y*free*free+motion.z*max(0.0,age-settle);
  let displacement=flight.xyz*free-vec3f(0.0,drop,0.0);
  // Rigid in metres: a ship's design frame is not uniformly scaled.
  var relative=(position-origin.xyz)*scale;
  var normal=restNormal;
  if(rate>1e-5){
    let axis=spinHide.xyz/rate;
    let c=cos(angle);let s=sin(angle);
    relative=fractureRotate(relative,axis,c,s);
    let scaleOfNormal=length(normal);
    let turned=fractureRotate(normal/max(scaleOfNormal,1e-5)/scale,axis,c,s)*scale;
    normal=normalize(turned)*scaleOfNormal;
  }
  return ShardPose(origin.xyz+(relative+displacement)/scale,normal);
}
`;

export const SHIP_FRACTURE_POSE_UPDATE = /* wgsl */ `${SHARD_FLIGHT}
struct FracturePoseVertex {position:vec4f,normal:vec4f};
@group(0)@binding(0)var<storage,read_write>fracturePosed:array<FracturePoseVertex>;
@group(0)@binding(1)var<storage,read>fractureVertexShards:array<u32>;
@group(0)@binding(2)var<storage,read>fractureRecords:array<vec4f>;
@group(0)@binding(3)var<uniform>fractureClock:FractureClock;
@compute @workgroup_size(64)fn main(@builtin(global_invocation_id)id:vec3u){
  let vertex=id.x;
  if(vertex>=arrayLength(&fracturePosed)||vertex>=arrayLength(&fractureVertexShards)){return;}
  let shard=fractureVertexShards[vertex];
  if(shard==0u){return;}
  let at=shard*4u;
  let motion=fractureRecords[at+3u];
  if(motion.w<-1.5){return;}
  let current=fracturePosed[vertex];
  let pose=shardFlight(current.position.xyz,current.normal.xyz,fractureRecords[at],fractureRecords[at+1u],fractureRecords[at+2u],motion,fractureClock);
  fracturePosed[vertex].position=vec4f(pose.position,current.position.w);
  fracturePosed[vertex].normal=vec4f(pose.normal,current.normal.w);
}
`;

// A land vertex is eight floats: position, normal, kind, shade. A shard's scorch lengthens its normal,
// which is how the land shader reads structural damage.
export const BUILDING_FRACTURE_POSE_UPDATE = /* wgsl */ `${SHARD_FLIGHT}
struct LandFractureVertex {a:vec4f,b:vec4f};
@group(0)@binding(0)var<storage,read_write>fracturePosed:array<LandFractureVertex>;
@group(0)@binding(1)var<storage,read>fractureRest:array<LandFractureVertex>;
@group(0)@binding(2)var<storage,read>fractureVertexShards:array<u32>;
@group(0)@binding(3)var<storage,read>fractureRecords:array<vec4f>;
@group(0)@binding(4)var<uniform>fractureClock:FractureClock;
@group(0)@binding(5)var<storage,read>fractureScorch:array<f32>;
@compute @workgroup_size(64)fn main(@builtin(global_invocation_id)id:vec3u){
  let vertex=id.x;
  if(vertex>=arrayLength(&fracturePosed)){return;}
  let shard=fractureVertexShards[vertex];
  if(shard==0u){return;}
  let at=shard*4u;
  let motion=fractureRecords[at+3u];
  let scorch=fractureScorch[shard];
  if(motion.w<-1.5&&scorch<=0.0){return;}
  let rest=fractureRest[vertex];
  let position=rest.a.xyz;
  // Faces that were inside the wall already read as raw stone, and a burn only adds to it.
  let baseNormal=vec3f(rest.a.w,rest.b.xy);
  let baseLength=length(baseNormal);
  let normal=baseNormal*(max(baseLength,1.0+scorch)/max(baseLength,1e-5));
  if(motion.w<-1.5){
    fracturePosed[vertex].a=vec4f(position,normal.x);
    fracturePosed[vertex].b=vec4f(normal.yz,rest.b.zw);
    return;
  }
  let pose=shardFlight(position,normal,fractureRecords[at],fractureRecords[at+1u],fractureRecords[at+2u],motion,fractureClock);
  fracturePosed[vertex].a=vec4f(pose.position,pose.normal.x);
  fracturePosed[vertex].b=vec4f(pose.normal.yz,rest.b.zw);
}
`;

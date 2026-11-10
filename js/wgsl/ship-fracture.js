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
  var worldMetres=origin.xyz*scale+relative+displacement;
  if(age>settle&&motion.y>0.0&&(clock.pad0>0.001||abs(clock.pad1)>0.001||abs(clock.scale.w)>0.001)){
    let waterAge=age-settle;
    let blend=smoothstep(0.0,0.45,waterAge);
    let seed=origin.x*1.73+origin.z*2.19;
    let waveBob=(sin(clock.now*1.85+seed)*0.09+cos(clock.now*1.27-seed*0.7)*0.06)*blend;
    let waveRockX=sin(clock.now*1.65+seed*1.3)*0.11*blend;
    let waveRockZ=cos(clock.now*1.42-seed*0.9)*0.14*blend;
    let cr=cos(clock.pad1-waveRockZ);let sr=sin(clock.pad1-waveRockZ);
    let cp=cos(clock.scale.w-waveRockX);let sp=sin(clock.scale.w-waveRockX);
    let wy=worldMetres.y+clock.pad0*blend+waveBob;
    let wz=worldMetres.z;
    let yy=cp*wy+sp*wz;
    let lz=-sp*wy+cp*wz;
    let lx=cr*worldMetres.x+sr*yy;
    let ly=-sr*worldMetres.x+cr*yy;
    worldMetres=vec3f(lx,ly,lz);
    let nScale=length(normal);
    let nUnit=normal/max(nScale,1e-5)/scale;
    let nyy=cp*nUnit.y+sp*nUnit.z;
    let nlz=-sp*nUnit.y+cp*nUnit.z;
    let nlx=cr*nUnit.x+sr*nyy;
    let nly=-sr*nUnit.x+cr*nyy;
    normal=normalize(vec3f(nlx,nly,nlz)*scale)*nScale;
  }
  return ShardPose(worldMetres/scale,normal);
}
`;

export const SHIP_FRACTURE_POSE_UPDATE = /* wgsl */ `${SHARD_FLIGHT}
struct FracturePoseVertex {position:vec4f,normal:vec4f};
@group(0)@binding(0)var<storage,read_write>fracturePosed:array<FracturePoseVertex>;
@group(0)@binding(1)var<storage,read>fractureVertexShards:array<u32>;
@group(0)@binding(2)var<storage,read>fractureRecords:array<vec4f>;
@group(0)@binding(3)var<uniform>fractureClock:FractureClock;
fn fractureBoatRotate(v:vec3f,heading:f32,pitch:f32,roll:f32)->vec3f {
  let cr=cos(roll);let sr=sin(roll);
  let cp=cos(pitch);let sp=sin(pitch);
  let ch=cos(heading);let sh=sin(heading);
  let xx=cr*v.x-sr*v.y;let yy=sr*v.x+cr*v.y;
  let yp=cp*yy-sp*v.z;let zp=sp*yy+cp*v.z;
  return vec3f(ch*xx-sh*zp,yp,sh*xx+ch*zp);
}
// Attitudes are quaternions (xyz, w), so a piece can turn from how it flew to how it floats and stay rigid.
fn fractureQuatMul(a:vec4f,b:vec4f)->vec4f {
  return vec4f(a.w*b.xyz+b.w*a.xyz+cross(a.xyz,b.xyz),a.w*b.w-dot(a.xyz,b.xyz));
}
fn fractureQuatAxis(axis:vec3f,angle:f32)->vec4f {
  return vec4f(axis*sin(angle*0.5),cos(angle*0.5));
}
fn fractureQuatTurn(v:vec3f,q:vec4f)->vec3f {
  return v+2.0*cross(q.xyz,cross(q.xyz,v)+q.w*v);
}
// The same turn as fractureBoatRotate: roll, then pitch, then compass heading.
fn fractureBoatQuat(heading:f32,pitch:f32,roll:f32)->vec4f {
  return fractureQuatMul(fractureQuatAxis(vec3f(0.0,-1.0,0.0),heading),fractureQuatMul(fractureQuatAxis(vec3f(1.0,0.0,0.0),pitch),fractureQuatAxis(vec3f(0.0,0.0,1.0),roll)));
}
// A piece adrift in the world. It flies from where the ship was when it left her, meets the sea, and comes to
// rest flat on it. spawn1.z says how: 0, 1 or 2 lay the piece's own thinnest side (up, athwart, fore-and-aft)
// on the water, and 3 means its spin was written to land it flat, which is how everything that fell together
// about one pivot (a mast with its yards and tops) keeps one attitude. Either way it is one turn of the whole
// piece about its pivot, never a squeeze.
fn shardFlightWorld(position:vec3f,restNormal:vec3f,origin:vec4f,flight:vec4f,spinHide:vec4f,motion:vec4f,spawn0:vec4f,spawn1:vec4f,right:vec3f,up:vec3f,fwd:vec3f,boatOrigin:vec3f,waterY:f32,clock:FractureClock)->ShardPose {
  let age=select(max(0.0,clock.now-origin.w),motion.w,motion.w>=0.0);
  if(spinHide.w>=0.0&&age>=spinHide.w){return ShardPose(origin.xyz,restNormal);}
  let scale=clock.scale.xyz;
  let hinge=motion.x;
  let rate=length(spinHide.xyz);
  let startWorldPivot=spawn0.xyz+fractureBoatRotate(origin.xyz*scale,spawn0.w,spawn1.x,spawn1.y);
  let velWorld=fractureBoatRotate(flight.xyz,spawn0.w,0.0,0.0);
  let g=max(0.1,clock.gravity*motion.y);
  let h0=startWorldPivot.y-waterY;
  let vy0=select(0.0,max(0.0,velWorld.y),h0>0.05);
  let fallTime=select(0.25,(vy0+sqrt(vy0*vy0+2.0*g*max(0.0,h0)))/g,h0>0.0);
  let settle=hinge+fallTime;
  let free=max(0.0,min(age,settle)-hinge);
  let held=min(age,hinge);
  var angle=rate*free;
  if(hinge>0.0){angle+=0.5*rate*held*held/hinge;}
  let waterAge=max(0.0,age-settle);
  let waterBlend=smoothstep(0.0,0.40,waterAge);
  let seed=origin.x*1.73+origin.z*2.19;
  let waveBob=(sin(clock.now*1.85+seed)*0.08+cos(clock.now*1.27-seed*0.7)*0.05)*waterBlend;
  let sinkDrop=motion.z*waterAge;
  let airY=select(mix(startWorldPivot.y,waterY,smoothstep(0.0,settle,age)),startWorldPivot.y+vy0*free-0.5*g*free*free,h0>0.0);
  let pivotY=select(airY,waterY,age>=settle)+waveBob-sinkDrop;
  let worldPivot=vec3f(startWorldPivot.x+velWorld.x*free,pivotY,startWorldPivot.z+velWorld.z*free);
  let relative0=(position-origin.xyz)*scale;
  let scaleOfNormal=length(restNormal);
  let restUnitN=normalize(restNormal/max(scaleOfNormal,1e-5)/scale);
  let spinAxis=select(vec3f(0.0,1.0,0.0),spinHide.xyz/max(rate,1e-5),rate>1e-5);
  let flightTurn=fractureQuatMul(fractureBoatQuat(spawn0.w,spawn1.x,spawn1.y),fractureQuatAxis(spinAxis,angle));
  // The sea rocks a plank about its middle. A whole mast turns about its foot, far from most of it, so the same
  // angle would wave its head a metre clear of the water: it gets a fifth of it.
  let rock=waterBlend*select(1.0,0.2,spawn1.z>2.5);
  let waveRockX=sin(clock.now*1.65+seed*1.3)*0.08*rock;
  let waveRockZ=cos(clock.now*1.42-seed*0.9)*0.10*rock;
  var flatTurn=vec4f(0.0,0.0,0.0,1.0);
  var flatYaw=spawn0.w+seed*0.45;
  if(spawn1.z>2.5){
    // The whole turn its spin was given to make, as the ship's own frame timed the fall.
    flatTurn=fractureQuatAxis(spinAxis,rate*max(0.0,flight.w-0.5*hinge));
    flatYaw=spawn0.w;
  }else if(spawn1.z>1.5){
    flatTurn=fractureQuatAxis(vec3f(1.0,0.0,0.0),-1.5707963);
  }else if(spawn1.z>0.5){
    flatTurn=fractureQuatAxis(vec3f(0.0,0.0,1.0),select(1.5707963,-1.5707963,origin.x>=0.0));
  }
  flatTurn=fractureQuatMul(fractureBoatQuat(flatYaw,waveRockX,waveRockZ),flatTurn);
  if(dot(flightTurn,flatTurn)<0.0){flatTurn=-flatTurn;}
  let flatBlend=smoothstep(hinge*0.6,settle,age);
  let turn=normalize(mix(flightTurn,flatTurn,flatBlend));
  let worldRel=fractureQuatTurn(relative0,turn);
  let worldN=fractureQuatTurn(restUnitN,turn);
  let d=(worldPivot+worldRel)-boatOrigin;
  let localMetres=vec3f(dot(d,right),dot(d,up),-dot(d,fwd));
  let localN=vec3f(dot(worldN,right),dot(worldN,up),-dot(worldN,fwd));
  return ShardPose(localMetres/scale,normalize(localN*scale)*scaleOfNormal);
}
@compute @workgroup_size(64)fn main(@builtin(global_invocation_id)id:vec3u){
  let vertex=id.x;
  if(vertex>=arrayLength(&fracturePosed)||vertex>=arrayLength(&fractureVertexShards)){return;}
  let shard=fractureVertexShards[vertex];
  if(shard==0u){return;}
  let at=shard*4u;
  let motion=fractureRecords[at+3u];
  if(motion.w<-1.5){return;}
  let current=fracturePosed[vertex];
  let header=fractureRecords[3u];
  if(header.w>0.5){
    let shardCount=u32(round(header.y));
    let spawnAt=shardCount*4u+shard*2u;
    if(spawnAt+1u<arrayLength(&fractureRecords)&&fractureRecords[spawnAt+1u].w>0.5){
      let r0=fractureRecords[0u];
      let r1=fractureRecords[1u];
      let r2=fractureRecords[2u];
      let pose=shardFlightWorld(current.position.xyz,current.normal.xyz,fractureRecords[at],fractureRecords[at+1u],fractureRecords[at+2u],motion,fractureRecords[spawnAt],fractureRecords[spawnAt+1u],r0.xyz,r1.xyz,r2.xyz,vec3f(r0.w,r1.w,r2.w),header.x,fractureClock);
      fracturePosed[vertex].position=vec4f(pose.position,current.position.w);
      fracturePosed[vertex].normal=vec4f(pose.normal,current.normal.w);
      return;
    }
  }
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

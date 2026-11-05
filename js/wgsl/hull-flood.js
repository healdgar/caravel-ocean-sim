// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Water standing in a holed hull, and the sea pouring in through each hole. The hull's own
// shader cuts the holes; these are only seen through them, through hatches, or once she is awash.
import { FRAME_WGSL, NOISE_WGSL, HULL_HOLE_LIMIT } from './common.js';

export const HULL_FLOOD_JET_SEGMENTS = 8;
export const HULL_FLOOD_RENDER = FRAME_WGSL + NOISE_WGSL + /* wgsl */ `
struct FloodHull { right:vec4f, up:vec4f, forward:vec4f, size:vec4f, origin:vec4f };
struct HullFlood { scale:vec4f, level:vec4f, holes:array<vec4f,${HULL_HOLE_LIMIT}>, flows:array<vec4f,${HULL_HOLE_LIMIT}> };
@group(0) @binding(0) var<uniform> F:Frame;
@group(0) @binding(1) var<uniform> hull:FloodHull;
@group(0) @binding(2) var<uniform> flood:HullFlood;
@group(0) @binding(3) var envCube:texture_cube<f32>;
@group(0) @binding(4) var sampC:sampler;
struct FloodVertex { @builtin(position) pos:vec4f, @location(0) world:vec3f, @location(1) uv:vec2f, @location(2) strength:f32 };
fn floodPlace(p:vec3f)->vec3f { return hull.right.xyz*p.x+hull.up.xyz*p.y-hull.forward.xyz*p.z+hull.origin.xyz; }
@vertex fn planeVS(@location(0) outline:vec2f)->FloodVertex {
  var o:FloodVertex;
  let world=floodPlace(vec3f(outline.x,flood.level.x,outline.y));
  o.world=world;o.uv=outline;o.strength=1.0;
  o.pos=F.viewProj*vec4f(world-F.camPos.xyz,1.0);
  return o;
}
@fragment fn planeFS(in:FloodVertex)->@location(0) vec4f {
  let time=F.post.z*.016;
  let ripple=vec2f(gnoise(in.uv*3.1+vec2f(time*.7,0.0)),gnoise(in.uv*3.7+vec2f(0.0,time*.6)))*.05;
  let n=normalize(hull.up.xyz+hull.right.xyz*ripple.x+hull.forward.xyz*ripple.y);
  let v=normalize(F.camPos.xyz-in.world);
  let f=.02+.98*pow(clamp(1.0-abs(dot(n,v)),0.0,1.0),5.0);
  let ambient=textureSampleLevel(envCube,sampC,vec3f(0,1,0),6.0).rgb;
  let reflection=textureSampleLevel(envCube,sampC,reflect(-v,n),4.0).rgb;
  // A hold is dark: what light there is comes in through the holes and the hatches.
  let body=vec3f(.018,.05,.058)*ambient;
  let churn=flood.level.y*smoothstep(.15,.55,gnoise(in.uv*7.0+vec2f(time*1.3,-time)));
  return vec4f(mix(body,reflection*.4,f)+vec3f(.5,.54,.55)*ambient*churn*.18,1.0);
}
// The sea coming in shows as a curtain just inside the hole, falling to the water in the hold.
@vertex fn jetVS(@builtin(vertex_index) index:u32,@builtin(instance_index) instance:u32)->FloodVertex {
  let hole=flood.holes[instance];let flow=flood.flows[instance].x;
  let quad=array<vec2f,6>(vec2f(0,-1),vec2f(1,-1),vec2f(0,1),vec2f(0,1),vec2f(1,-1),vec2f(1,1))[index%6u];
  let along=(f32(index/6u)+quad.x)/${HULL_FLOOD_JET_SEGMENTS}.0;
  let inward=-sign(hole.x);
  let reach=clamp(sqrt(flow)*1.8,.3,1.4);
  let fall=max(.25,hole.y+hole.w-flood.level.x);
  let width=hole.w*(.95+.7*along);
  let p=vec3f(hole.x+inward*(.14+reach*along*along),hole.y+hole.w-fall*along,hole.z+quad.y*width);
  var o:FloodVertex;
  let world=floodPlace(p);
  o.world=world;o.uv=vec2f(along*fall,quad.y*width);o.strength=clamp(flow*5.0,.3,1.0);
  o.pos=F.viewProj*vec4f(world-F.camPos.xyz,1.0);
  if(flow<=0.0){o.pos=vec4f(3,3,0,1);}
  return o;
}
@fragment fn jetFS(in:FloodVertex)->@location(0) vec4f {
  let time=F.post.z*.016;
  let streak=gnoise(vec2f(in.uv.y*9.0,in.uv.x*1.6-time*6.0))+.5*gnoise(vec2f(in.uv.y*23.0,in.uv.x*3.5-time*9.0))+.5;
  if(streak<.42-.3*in.strength){discard;}
  let ambient=textureSampleLevel(envCube,sampC,vec3f(0,1,0),6.0).rgb;
  let colour=mix(vec3f(.05,.13,.13),vec3f(.74,.8,.8),smoothstep(.4,1.0,streak));
  return vec4f(colour*ambient*.55,1.0);
}
`;

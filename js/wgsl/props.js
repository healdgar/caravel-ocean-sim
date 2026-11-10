// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Textured props. A compute pass culls them and lists what shows for one indirect draw per model. A prop broken by
// shot is the same instance in the same draw: each vertex reads its shard's flight from one shared buffer, so whole
// props, flying timber and what lies on the beach all light and cast shadow alike.
import { FRAME_WGSL, ATMO_CORE_WGSL, ENV_MIPS, SIM_CLOCK_LOOP_S } from './common.js';
import { VESSEL_RIG, VESSEL_LIGHTING } from './vessel.js';
import { SKY_RENDER_FUNCS } from './sky.js';
import { SHADOW_FRAME, SHADOW_SAMPLE } from './shadows.js';

export const PROP_DRAW_WORDS = 5;
const PROP_SMALLEST_PIXELS = 2.5;
// FRACTURE_GRAVITY in js/ship-fracture.js, which evaluates the same flight on the CPU.
export const PROP_SHARD_GRAVITY = 9.80665;

// `records` is where this prop's block starts in the shard records, counted in vec4f.
const PROP_RECORD = /* wgsl */ `
struct Prop {position:vec3f,yaw:f32,records:u32,model:u32,first:u32,radius:f32};
`;

export const PROPS_CULL = FRAME_WGSL + PROP_RECORD + /* wgsl */ `
@group(0) @binding(0) var<uniform> F:Frame;
@group(0) @binding(1) var<storage,read> props:array<Prop>;
@group(0) @binding(2) var<storage,read_write> shown:array<Prop>;
@group(0) @binding(3) var<storage,read_write> draws:array<atomic<u32>>;
@compute @workgroup_size(16) fn reset(@builtin(global_invocation_id) id:vec3u){
  if(id.x*${PROP_DRAW_WORDS}u+1u<arrayLength(&draws)){atomicStore(&draws[id.x*${PROP_DRAW_WORDS}u+1u],0u);}
}
fn inFrustum(relative:vec3f,radius:f32)->bool {
  let clip=F.viewProj*vec4f(relative,1);
  let rowW=vec3f(F.viewProj[0].w,F.viewProj[1].w,F.viewProj[2].w);
  for(var a=0u;a<2u;a++){
    let row=vec3f(F.viewProj[0][a],F.viewProj[1][a],F.viewProj[2][a]);
    if(clip.w+clip[a]<-radius*length(rowW+row)||clip.w-clip[a]<-radius*length(rowW-row)){return false;}
  }
  return clip.w>=-radius*length(rowW);
}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){
  if(id.x>=arrayLength(&props)){return;}
  let prop=props[id.x];
  if(prop.radius<=0.0){return;}
  let relative=prop.position-F.camPos.xyz;
  let cullR=select(prop.radius,prop.radius+18.0,length(relative)<110.0);
  if(!inFrustum(relative,cullR)){return;}
  let depth=max(dot(relative,normalize(F.camFwd.xyz)),1.2);
  if(2.0*prop.radius*F.screen.y/(2.0*length(F.camUp.xyz))/depth<${PROP_SMALLEST_PIXELS.toFixed(1)}){return;}
  let slot=atomicAdd(&draws[prop.model*${PROP_DRAW_WORDS}u+1u],1u);
  shown[prop.first+slot]=prop;
}
`;

// Where a vertex of a prop is now, in the prop's own frame. A prop's block in the shard records is one vec4f whose x
// is the frame time at which its debris clock read zero, then four vec4f a shard as js/ship-fracture.js lays them
// out: pivot and release time, velocity and settle time, spin and the age it is hidden at, then hinge, gravity,
// sink and what holds it (-2 standing, -1 in flight, otherwise the age it stopped at). Needs F and shardRecords.
const PROP_FLIGHT = /* wgsl */ `
struct PropPose {position:vec3f,normal:vec3f,hidden:bool};
fn propRotate(v:vec3f,axis:vec3f,c:f32,s:f32)->vec3f {
  return v*c+cross(axis,v)*s+axis*dot(axis,v)*(1.0-c);
}
fn propPose(prop:Prop,shard:u32,position:vec3f,normal:vec3f)->PropPose {
  var pose:PropPose;pose.position=position;pose.normal=normal;pose.hidden=false;
  let at=prop.records+1u+shard*4u;
  let motion=shardRecords[at+3u];
  if(motion.w<-1.5){return pose;}
  let origin=shardRecords[at];let flight=shardRecords[at+1u];let spinHide=shardRecords[at+2u];
  // The frame clock starts again every ${SIM_CLOCK_LOOP_S} s; no flight lasts that long.
  var clock=F.camPos.w-shardRecords[prop.records].x;
  if(clock<0.0){clock+=${SIM_CLOCK_LOOP_S.toFixed(1)};}
  let age=select(max(0.0,clock-origin.w),motion.w,motion.w>=0.0);
  if(spinHide.w>=0.0&&age>=spinHide.w){pose.hidden=true;return pose;}
  let settle=flight.w;let hinge=motion.x;let rate=length(spinHide.xyz);
  let free=max(0.0,min(age,settle)-hinge);let held=min(age,hinge);
  var angle=rate*free;
  if(hinge>0.0){angle+=0.5*rate*held*held/hinge;}
  let drop=0.5*${PROP_SHARD_GRAVITY}*motion.y*free*free+motion.z*max(0.0,age-settle);
  var relative=position-origin.xyz;
  if(rate>1e-5){
    let axis=spinHide.xyz/rate;let ca=cos(angle);let sa=sin(angle);
    relative=propRotate(relative,axis,ca,sa);
    pose.normal=normalize(propRotate(normal,axis,ca,sa));
  }
  pose.position=origin.xyz+relative+flight.xyz*free-vec3f(0.0,drop,0.0);
  return pose;
}
`;

const PROP_FRAGMENT = /* wgsl */ `
struct PropVertex {@builtin(position) position:vec4f,@location(0) world:vec3f,@location(1) normal:vec3f,@location(2) uv:vec2f};
@fragment fn propFS(v:PropVertex,@builtin(front_facing) front:bool)->@location(0) vec4f {
  var n=normalize(v.normal)*select(-1.0,1.0,front);let sun=F.sunDir.xyz;
  let albedo=textureSample(pigment,pigmentSampler,v.uv).rgb;
  let luma=dot(albedo,vec3f(0.2126,0.7152,0.0722));
  let dx=dpdx(v.world);let dy=dpdy(v.world);
  let sx=cross(dy,n);let sy=cross(n,dx);
  let det=dot(dx,sx);
  let uvFootprint=max(length(dpdx(v.uv)),length(dpdy(v.uv)));
  let bumpFilter=1.0-smoothstep(0.015,0.08,uvFootprint);
  let propBump=luma*0.0045*bumpFilter;
  let propGrad=(dpdx(propBump)*sx+dpdy(propBump)*sy)/max(abs(det),0.000001)*sign(det);
  n=normalize(n-clamp(propGrad,vec3f(-0.26),vec3f(0.26)));
  let shadowSample=vesselShadow(v.world,n);
  let direct=sunIlluminance()*sunVis[0]*step(0.0,sun.y)*solarShadowVisibility(shadowSample);
  let sky=textureSampleLevel(envCube,sampC,vec3f(0,1,0),${ENV_MIPS - 1}.0).rgb;
  let sea=textureSampleLevel(envCube,sampC,normalize(vec3f(n.x,-.65,n.z)),${ENV_MIPS - 1}.0).rgb;
  let view=normalize(F.camPos.xyz-v.world);
  // TextureCraft-calibrated cavity AO, tidal waterline darkening & hawser curvature edge wear
  let tidalWet=1.0-smoothstep(0.05,1.45,v.world.y);
  let curvature=clamp(length(fwidth(n))*0.42*bumpFilter,0.0,1.0);
  let cavityAO=clamp(0.72+0.28*smoothstep(0.08,0.52,luma)-0.16*tidalWet,0.52,1.0);
  let edgeChafe=curvature*smoothstep(0.35,1.65,v.world.y)*0.12;
  let weatheredAlbedo=clamp(albedo*cavityAO+vec3f(0.11,0.09,0.07)*edgeChafe,vec3f(0.02),vec3f(0.95));
  let rough=clamp(0.90-luma*0.18-tidalWet*0.18+edgeChafe*0.10,0.44,0.92);let f0=vec3f(.04);
  let spec=vesselSpecular(n,view,sun,rough,f0);
  let reflected=textureSampleLevel(envCube,sampC,reflect(-view,n),rough*${ENV_MIPS - 1}.0).rgb;
  let col=lunarSurface(n,view,weatheredAlbedo,rough,f0,sunVis[1]*lunarShadowVisibility(shadowSample))+lightningSurface(n,view,weatheredAlbedo,rough)+gunFlashSurface(v.world,n,view,weatheredAlbedo,rough)+worldFireSurface(v.world,n,view,weatheredAlbedo,rough)
    +weatheredAlbedo*(direct*max(dot(n,sun),0.0)/PI+vesselAmbient(n,sky,sea))+direct*spec*max(dot(n,sun),0.0)
    +reflected*F.windP[1].w*vesselEnvironment(n,view,rough,f0);
  return vec4f(surfaceAir(col,v.world),1);
}
`;

const PROP_INPUT = /* wgsl */ `
struct PropInput {@location(0) position:vec3f,@location(1) normal:vec3f,@location(2) uv:vec2f,@location(3) shard:u32,@builtin(instance_index) instance:u32};
`;

export const PROPS_RENDER = FRAME_WGSL + ATMO_CORE_WGSL + VESSEL_RIG + VESSEL_LIGHTING + SHADOW_SAMPLE + SKY_RENDER_FUNCS + PROP_RECORD + /* wgsl */ `
@group(0) @binding(0) var<uniform> F:Frame;
@group(0) @binding(1) var<uniform> hull:Hull;
@group(0) @binding(4) var transLUT:texture_2d<f32>;
@group(0) @binding(5) var sampC:sampler;
@group(0) @binding(6) var envCube:texture_cube<f32>;
@group(0) @binding(7) var<storage,read> sunVis:array<f32,4>;
@group(0) @binding(9) var skyLUT:texture_2d<f32>;
@group(0) @binding(10) var<storage,read> shown:array<Prop>;
@group(0) @binding(11) var pigment:texture_2d<f32>;
@group(0) @binding(12) var pigmentSampler:sampler;
@group(0) @binding(13) var<storage,read> shardRecords:array<vec4f>;
` + PROP_FLIGHT + PROP_INPUT + PROP_FRAGMENT + /* wgsl */ `
@vertex fn propVS(v:PropInput)->PropVertex {
  let prop=shown[v.instance];let c=cos(prop.yaw);let s=sin(prop.yaw);
  let pose=propPose(prop,v.shard,v.position,v.normal);let p=pose.position;
  var out:PropVertex;
  out.world=vec3f(p.x*c+p.z*s,p.y,p.z*c-p.x*s)+prop.position;
  out.position=select(F.viewProj*vec4f(earthCurve(out.world-F.camPos.xyz,F.camPos.y),1),vec4f(0.0,0.0,-2.0,1.0),pose.hidden);
  out.normal=vec3f(pose.normal.x*c+pose.normal.z*s,pose.normal.y,pose.normal.z*c-pose.normal.x*s);
  out.uv=v.uv;
  return out;
}
`;

export const PROPS_SHADOW = FRAME_WGSL + SHADOW_FRAME + PROP_RECORD + /* wgsl */ `
@group(0) @binding(0) var<uniform> SH:ShadowFrame;
@group(0) @binding(1) var<storage,read> shown:array<Prop>;
@group(0) @binding(2) var<storage,read> shardRecords:array<vec4f>;
@group(0) @binding(3) var<uniform> F:Frame;
` + PROP_FLIGHT + PROP_INPUT + /* wgsl */ `
@vertex fn propShadowVS(v:PropInput)->@builtin(position) vec4f {
  let prop=shown[v.instance];let c=cos(prop.yaw);let s=sin(prop.yaw);
  let pose=propPose(prop,v.shard,v.position,v.normal);let p=pose.position;
  let world=vec3f(p.x*c+p.z*s,p.y,p.z*c-p.x*s)+prop.position;
  return select(SH.lightView*vec4f(world-SH.origin.xyz,1.0),vec4f(0.0,0.0,-2.0,1.0),pose.hidden);
}
`;

// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Textured props. A compute pass culls them and lists what shows for one indirect draw per model.
import { FRAME_WGSL, ATMO_CORE_WGSL, ENV_MIPS } from './common.js';
import { VESSEL_RIG, VESSEL_LIGHTING } from './vessel.js';
import { SKY_RENDER_FUNCS } from './sky.js';
import { SHADOW_FRAME, SHADOW_SAMPLE } from './shadows.js';

export const PROP_DRAW_WORDS = 5;
const PROP_SMALLEST_PIXELS = 2.5;

const PROP_RECORD = /* wgsl */ `
struct Prop {position:vec3f,yaw:f32,scale:f32,model:u32,first:u32,radius:f32};
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
struct PropInput {@location(0) position:vec3f,@location(1) normal:vec3f,@location(2) uv:vec2f,@builtin(instance_index) instance:u32};
@vertex fn propVS(v:PropInput)->PropVertex {
  let prop=shown[v.instance];let c=cos(prop.yaw);let s=sin(prop.yaw);let p=v.position*prop.scale;
  var out:PropVertex;
  out.world=vec3f(p.x*c+p.z*s,p.y,p.z*c-p.x*s)+prop.position;
  out.position=F.viewProj*vec4f(earthCurve(out.world-F.camPos.xyz,F.camPos.y),1);
  out.normal=vec3f(v.normal.x*c+v.normal.z*s,v.normal.y,v.normal.z*c-v.normal.x*s);
  out.uv=v.uv;
  return out;
}
` + PROP_FRAGMENT;

export const PROPS_FRACTURED_RENDER = FRAME_WGSL + ATMO_CORE_WGSL + VESSEL_RIG + VESSEL_LIGHTING + SHADOW_SAMPLE + SKY_RENDER_FUNCS + /* wgsl */ `
struct FracturedProp {
  position:vec3f,
  yaw:f32,
  clock:f32,
  gravity:f32,
  scale:f32,
  pad0:f32,
};
@group(0) @binding(0) var<uniform> F:Frame;
@group(0) @binding(1) var<uniform> hull:Hull;
@group(0) @binding(4) var transLUT:texture_2d<f32>;
@group(0) @binding(5) var sampC:sampler;
@group(0) @binding(6) var envCube:texture_cube<f32>;
@group(0) @binding(7) var<storage,read> sunVis:array<f32,4>;
@group(0) @binding(9) var skyLUT:texture_2d<f32>;
@group(0) @binding(11) var pigment:texture_2d<f32>;
@group(0) @binding(12) var pigmentSampler:sampler;
@group(0) @binding(13) var<uniform> FP:FracturedProp;
@group(0) @binding(14) var<storage,read> fractureRecords:array<vec4f>;
struct PropFracturedInput {
  @location(0) position:vec3f,
  @location(1) normal:vec3f,
  @location(2) uv:vec2f,
  @location(3) shard:u32,
};
fn propFractureRotate(v:vec3f,axis:vec3f,c:f32,s:f32)->vec3f {
  return v*c+cross(axis,v)*s+axis*dot(axis,v)*(1.0-c);
}
@vertex fn propFracturedVS(v:PropFracturedInput)->PropVertex {
  let at=v.shard*4u;
  let origin=fractureRecords[at];
  let flight=fractureRecords[at+1u];
  let spinHide=fractureRecords[at+2u];
  let motion=fractureRecords[at+3u];
  var localPos=v.position*FP.scale;
  var localNorm=v.normal;
  if(motion.w>=-1.5){
    let age=select(max(0.0,FP.clock-origin.w),motion.w,motion.w>=0.0);
    if(spinHide.w>=0.0&&age>=spinHide.w){
      var hidden:PropVertex;
      hidden.position=vec4f(0.0,0.0,-2.0,1.0);
      hidden.world=FP.position;
      hidden.normal=vec3f(0.0,1.0,0.0);
      hidden.uv=v.uv;
      return hidden;
    }
    let settle=flight.w;
    let hinge=motion.x;
    let rate=length(spinHide.xyz);
    let free=max(0.0,min(age,settle)-hinge);
    let held=min(age,hinge);
    var angle=rate*free;
    if(hinge>0.0){angle+=0.5*rate*held*held/hinge;}
    let drop=0.5*FP.gravity*motion.y*free*free+motion.z*max(0.0,age-settle);
    let displacement=flight.xyz*free-vec3f(0.0,drop,0.0);
    var relative=localPos-origin.xyz;
    if(rate>1e-5){
      let axis=spinHide.xyz/rate;
      let ca=cos(angle);let sa=sin(angle);
      relative=propFractureRotate(relative,axis,ca,sa);
      localNorm=normalize(propFractureRotate(localNorm,axis,ca,sa));
    }
    localPos=origin.xyz+relative+displacement;
  }
  let c=cos(FP.yaw);let s=sin(FP.yaw);
  var out:PropVertex;
  out.world=vec3f(localPos.x*c+localPos.z*s,localPos.y,localPos.z*c-localPos.x*s)+FP.position;
  out.position=F.viewProj*vec4f(earthCurve(out.world-F.camPos.xyz,F.camPos.y),1);
  out.normal=vec3f(localNorm.x*c+localNorm.z*s,localNorm.y,localNorm.z*c-localNorm.x*s);
  out.uv=v.uv;
  return out;
}
` + PROP_FRAGMENT;

export const PROPS_SHADOW = SHADOW_FRAME + PROP_RECORD + /* wgsl */ `
@group(0) @binding(0) var<uniform> SH:ShadowFrame;
@group(0) @binding(1) var<storage,read> shown:array<Prop>;
struct PropInput {@location(0) position:vec3f,@location(1) normal:vec3f,@location(2) uv:vec2f,@builtin(instance_index) instance:u32};
@vertex fn propShadowVS(v:PropInput)->@builtin(position) vec4f {
  let prop=shown[v.instance];let c=cos(prop.yaw);let s=sin(prop.yaw);let p=v.position*prop.scale;
  let world=vec3f(p.x*c+p.z*s,p.y,p.z*c-p.x*s)+prop.position;
  return SH.lightView*vec4f(world-SH.origin.xyz,1.0);
}
`;

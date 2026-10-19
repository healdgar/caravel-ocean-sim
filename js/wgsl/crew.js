import { FRAME_WGSL, ATMO_CORE_WGSL, ENV_MIPS } from './common.js';
import { VESSEL_RIG } from './vessel.js';
import { SHADOW_SAMPLE, SHADOW_FRAME } from './shadows.js';

const CREW_SKIN = /* wgsl */ `
@group(0) @binding(1) var<uniform> hull:Hull;
@group(0) @binding(2) var<storage,read> joints:array<mat4x4f>;
struct CrewActor { transform:mat4x4f, shirt:vec4f, trousers:vec4f, skin:vec4f, hair:vec4f };
@group(0) @binding(3) var<storage,read> actors:array<CrewActor>;
struct CrewInput {
  @location(0) position:vec3f, @location(1) normal:vec3f,
  @location(2) color:vec3f, @location(3) bones:vec4u, @location(4) weights:vec4f,
  @builtin(instance_index) instance:u32
};
fn crewSkin(v:CrewInput)->mat4x4f {
  let b=v.bones+vec4u(v.instance*65u);
  return actors[v.instance].transform*(joints[b.x]*v.weights.x+joints[b.y]*v.weights.y+
    joints[b.z]*v.weights.z+joints[b.w]*v.weights.w);
}
`;
export const CREW_RENDER = FRAME_WGSL + ATMO_CORE_WGSL + VESSEL_RIG + CREW_SKIN + SHADOW_SAMPLE + /* wgsl */ `
@group(0) @binding(0) var<uniform> F:Frame;
@group(0) @binding(4) var transLUT:texture_2d<f32>;
@group(0) @binding(5) var sampC:sampler;
@group(0) @binding(6) var envCube:texture_cube<f32>;
@group(0) @binding(7) var<storage,read> sunVis:array<f32,4>;
@group(0) @binding(8) var<storage,read> moisture:array<vec2f>;
struct CrewVertex {
  @builtin(position) position:vec4f, @location(0) world:vec3f,
  @location(1) normal:vec3f, @location(2) color:vec3f, @location(3) @interpolate(flat) helm:f32,
  @location(4) wet:vec2f, @location(5) skin:f32
};
@vertex fn vs(v:CrewInput)->CrewVertex {
  let skin=crewSkin(v);let p=rotateHull((skin*vec4f(v.position,1)).xyz)+hull.origin.xyz;
  var out:CrewVertex;out.position=F.viewProj*vec4f(p-F.camPos.xyz,1);
  out.world=p;out.normal=normalize(rotateHull((skin*vec4f(v.normal,0)).xyz));out.color=v.color;
  let actor=actors[v.instance];out.helm=actor.trousers.w;
  let base=u32(actor.hair.w);let y=v.position.y;
  let lower=mix(moisture[base],moisture[base+1u],smoothstep(.08,.5,y));
  let upper=mix(moisture[base+2u],moisture[base+3u],smoothstep(1.08,1.55,y));
  out.wet=mix(lower,upper,smoothstep(.5,1.08,y));
  out.skin=select(0.0,1.0,distance(v.color,vec3f(.36,.18,.10))<.001);
  if(actor.shirt.w>0.5){out.position=vec4f(2,2,0,1);}
  if(distance(v.color,vec3f(.55,.47,.31))<.001){out.color=actor.shirt.rgb;}
  if(distance(v.color,vec3f(.095,.12,.15))<.001){out.color=actor.trousers.rgb;}
  if(distance(v.color,vec3f(.36,.18,.10))<.001){out.color=actor.skin.rgb;}
  if(distance(v.color,vec3f(.045,.019,.009))<.001){out.color=actor.hair.rgb;}
  return out;
}
@fragment fn fs(v:CrewVertex,@builtin(front_facing) front:bool)->@location(0) vec4f {
  // Screen-door transparency preserves correct depth and the two instanced draws.
  // Every nearby sailor clears the first-person sightline, including moving crew.
  let opacity=select(1.0,smoothstep(1.4,4.8,distance(v.world,F.camPos.xyz)),v.helm>.5);
  let pixel=vec2u(v.position.xy)%4u;
  let bayer=array<f32,16>(0,8,2,10,12,4,14,6,3,11,1,9,15,7,13,5);
  if(opacity<(bayer[pixel.y*4u+pixel.x]+.5)/16.0){discard;}
  let n=normalize(v.normal)*select(-1.0,1.0,front);let sun=F.sunDir.xyz;
  let trans=textureSampleLevel(transLUT,sampC,transRMuToUV(RG+F.atmo.y,sun.y),0).rgb;
  let direct=trans*F.sunDir.w*sunVis[0]*step(0.0,sun.y)*vesselShadow(v.world,n);
  let sky=textureSampleLevel(envCube,sampC,vec3f(0,1,0),${ENV_MIPS-1}.0).rgb;
  let sea=textureSampleLevel(envCube,sampC,vec3f(0,-1,0),${ENV_MIPS-1}.0).rgb;
  let ambient=sky*(.5+.5*n.y)+sea*.15*(.5-.5*n.y);
  let wet=clamp(v.wet,vec2f(0),vec2f(1));
  let albedo=v.color*mix(1.0,mix(.68,.92,v.skin),wet.x);
  let view=normalize(F.camPos.xyz-v.world);let halfway=normalize(view+sun);
  // Damp cloth stays matte; exposed skin carries a modest fresh-water highlight.
  let gloss=mix(.004,.035,v.skin)*wet.y*pow(max(dot(n,halfway),0.0),mix(8.0,32.0,v.skin));
  let col=albedo*(direct*max(dot(n,sun),0.0)/PI+ambient)+direct*gloss*max(dot(n,sun),0.0);
  let fog=exp(-F.fogExt.rgb*length(v.world-F.camPos.xyz));
  return vec4f(col*fog+sky*(1.0-fog),1);
}
`;
export const CREW_SHADOW = VESSEL_RIG + CREW_SKIN + SHADOW_FRAME + /* wgsl */ `
@group(0) @binding(0) var<uniform> SH:ShadowFrame;
@vertex fn vs(v:CrewInput)->@builtin(position) vec4f {
  return SH.lightView*vec4f(rotateHull((crewSkin(v)*vec4f(v.position,1)).xyz),1);
}
`;

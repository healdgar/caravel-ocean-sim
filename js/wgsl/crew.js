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
struct CrewVertex {
  @builtin(position) position:vec4f, @location(0) world:vec3f,
  @location(1) normal:vec3f, @location(2) color:vec3f
};
@vertex fn vs(v:CrewInput)->CrewVertex {
  let skin=crewSkin(v);let p=rotateHull((skin*vec4f(v.position,1)).xyz)+hull.origin.xyz;
  var out:CrewVertex;out.position=F.viewProj*vec4f(p-F.camPos.xyz,1);
  out.world=p;out.normal=normalize(rotateHull((skin*vec4f(v.normal,0)).xyz));out.color=v.color;
  let actor=actors[v.instance];
  if(actor.shirt.w>0.5){out.position=vec4f(2,2,0,1);}
  if(distance(v.color,vec3f(.55,.47,.31))<.001){out.color=actor.shirt.rgb;}
  if(distance(v.color,vec3f(.095,.12,.15))<.001){out.color=actor.trousers.rgb;}
  if(distance(v.color,vec3f(.36,.18,.10))<.001){out.color=actor.skin.rgb;}
  if(distance(v.color,vec3f(.045,.019,.009))<.001){out.color=actor.hair.rgb;}
  return out;
}
@fragment fn fs(v:CrewVertex,@builtin(front_facing) front:bool)->@location(0) vec4f {
  let n=normalize(v.normal)*select(-1.0,1.0,front);let sun=F.sunDir.xyz;
  let trans=textureSampleLevel(transLUT,sampC,transRMuToUV(RG+F.atmo.y,sun.y),0).rgb;
  let direct=trans*F.sunDir.w*sunVis[0]*step(0.0,sun.y)*vesselShadow(v.world,n);
  let sky=textureSampleLevel(envCube,sampC,vec3f(0,1,0),${ENV_MIPS-1}.0).rgb;
  let sea=textureSampleLevel(envCube,sampC,vec3f(0,-1,0),${ENV_MIPS-1}.0).rgb;
  let ambient=sky*(.5+.5*n.y)+sea*.15*(.5-.5*n.y);
  let col=v.color*(direct*max(dot(n,sun),0.0)/PI+ambient);
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

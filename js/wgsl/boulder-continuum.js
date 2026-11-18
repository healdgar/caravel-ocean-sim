// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The boulders' material in the one continuum's pipeline family (js/wgsl/continuum-cut.js): how a ground-cover rock
// wears its surface. Its cut, its shadow, its atlas and its lift onto the drawn ground are the one cut's; this is only
// its stone: its archetype's lithology in its own tint, grain and crystal, the land's soil at its foot, lichen where
// the ground is green and its top faces the sky, wet near the sea, lit by the land's own light and shadow.
import { FRAME_WGSL, ATMO_CORE_WGSL } from './common.js';
import { SKY_RENDER_FUNCS } from './sky.js';
import { SHADOW_FRAME } from './shadows.js';
import { BOULDER_CONTINUUM_MATERIAL } from '../boulder-continuum.js';

// Group 0: the land's resources a boulder is shaded by (js/boulder-continuum.js BOULDER_CONTINUUM_BINDINGS of
// js/terrain.js nearResources). Group 1 is unused; the scene's data is group 2.
const boulderContinuumPreludeWGSL = () => FRAME_WGSL + ATMO_CORE_WGSL + SHADOW_FRAME + /* wgsl */`
struct BoulderLand { domain:vec4f };
@group(0) @binding(0) var<uniform> F:Frame;
@group(0) @binding(1) var transLUT:texture_2d<f32>;
@group(0) @binding(2) var skyLUT:texture_2d<f32>;
@group(0) @binding(3) var sampC:sampler;
@group(0) @binding(4) var envCube:texture_cube<f32>;
@group(0) @binding(5) var landLight:texture_2d<f32>;
@group(0) @binding(6) var<uniform> LAND:BoulderLand;
@group(0) @binding(7) var landAlbedo:texture_2d<f32>;
@group(0) @binding(8) var landSampler:sampler;
@group(0) @binding(9) var vegetationMask:texture_2d<f32>;
@group(0) @binding(19) var<uniform> landSH:ShadowFrame;
@group(0) @binding(20) var landSolidShadow:texture_depth_2d;
@group(0) @binding(21) var landShadowCompare:sampler_comparison;
` + SKY_RENDER_FUNCS;

const BOULDER_CONTINUUM_MATERIAL_WGSL = /* wgsl */`
// An archetype's lithology (its tag, (archetype + 0.5) / 6), in a rock's own tint by its seed.
fn boulderContinuumPalette(archTag:f32,seed:f32)->vec3f {
  let idx=clamp(u32(floor(archTag*6.0)),0u,5u);
  var base=vec3f(0.24,0.23,0.21);
  if(idx==1u){base=vec3f(0.32,0.29,0.24);}
  else if(idx==2u){base=vec3f(0.27,0.22,0.18);}
  else if(idx==3u){base=vec3f(0.16,0.17,0.18);}
  else if(idx==4u){base=vec3f(0.22,0.23,0.21);}
  else if(idx==5u){base=vec3f(0.29,0.25,0.20);}
  return base*(0.90+0.20*fract(seed*31.7+archTag*5.3));
}
// Its stone (its archetype's, in its own tint: the record's identity is its seed), and how lit its facet is and how
// high it stands in its type's own units, by which its foot takes the soil. A point carries its facet's light in its
// word, a far-body triangle that of the surface nearest it; a splat stands lit as a top.
fn boulderContinuumVarying(s:ContinuumSurface,v:ptr<function,ContinuumVarying>) {
  (*v).stone=boulderContinuumPalette(continuumTypeF(s.model,${BOULDER_CONTINUUM_MATERIAL.archetype}u),bitcast<f32>(s.record.spare.x));
  (*v).lit=vec2f(select(bitcast<f32>(s.word),0.8,s.what==CONTINUUM_SPLAT_ENTRY),s.local.y);
}
fn boulderContinuumLandShadow(world:vec3f,normal:vec3f)->f32 {
  if(landSH.origin.w<0.5){return 1.0;}
  let facing=select(-1.0,1.0,dot(normal,landSH.sun.xyz)>=0.0);
  let offset=normal*facing*0.032+landSH.sun.xyz*0.025;
  let p=landSH.lightView*vec4f(world-landSH.origin.xyz+offset,1.0);
  let uv=p.xy*vec2f(0.5,-0.5)+0.5;
  let edge=min(min(uv.x,1.0-uv.x),min(uv.y,1.0-uv.y));
  let fade=smoothstep(0.0,0.06,edge)*step(0.0,p.z)*step(p.z,1.0);
  let refZ=min(p.z-0.08/max(landSH.sun.w,1.0),0.99999);
  let s1=textureSampleCompareLevel(landSolidShadow,landShadowCompare,clamp(uv,vec2f(0.0),vec2f(1.0)),refZ);
  return mix(1.0,s1,fade);
}
fn boulderContinuumShade(v:ContinuumVarying,front:bool)->vec4f {
  // The far body is shaded flat, each face by its own plane; a splat leans its normal to the sky.
  let across=dpdx(v.world);let down=dpdy(v.world);
  let plane=cross(down,across);
  let eye=continuumEye();
  let faceted=select(v.normal,normalize(plane)*select(-1.0,1.0,dot(plane,eye-v.world)>=0.0),dot(plane,plane)>1e-16);
  var base=normalize(v.normal);
  if(v.coverage.x==CONTINUUM_FAR_ENTRY){base=faceted;}
  else if(v.coverage.x==CONTINUUM_SPLAT_ENTRY){base=normalize(vec3f(0.0,1.0,0.0)+v.normal*0.6);}
  let world=v.world;
  let camDist=distance(world,eye);
  let grainFade=smoothstep(48.0,10.0,camDist);
  let crystal=sin(world.x*9.5+world.z*7.1)*0.5+cos(world.y*12.3-world.x*5.7)*0.5;
  let gx=cos(world.x*19.0+world.z*11.0)*0.072*grainFade;
  let gz=sin(world.z*19.0-world.x*11.0)*0.072*grainFade;
  let n=normalize(base+vec3f(gx,0.0,gz));

  let uv=clamp((world.xz-LAND.domain.xy)/LAND.domain.z+0.5,vec2f(0.0),vec2f(1.0));
  let soil=pow(textureSampleLevel(landAlbedo,landSampler,uv,1.0).rgb,vec3f(2.2));
  let vegetation=textureSampleLevel(vegetationMask,landSampler,uv,0.0).r;
  let lichenNoise=sin(world.x*2.4+world.z*1.9)*cos(world.z*3.1-world.x*2.7);
  let lichen=smoothstep(0.55,0.88,max(n.y,0.0))*smoothstep(0.20,0.75,lichenNoise)*smoothstep(0.08,0.45,vegetation);
  let rootMask=1.0-smoothstep(-0.18,0.14,v.lit.y);

  let shade=0.68+v.lit.x*0.34;
  var albedo=mix(v.stone,soil,0.22)*shade*(0.90+0.12*max(n.y,0.0)+crystal*0.045*grainFade);
  albedo=mix(albedo,vec3f(0.24,0.27,0.16)*shade,lichen*0.58);
  albedo=mix(albedo,soil*0.74,rootMask*0.40);

  let roughness=clamp(0.76-crystal*0.05+lichen*0.14,0.54,0.92);
  let sunlight=textureSampleLevel(landLight,sampC,uv,0.0);
  let shadowed=vec3f(boulderContinuumLandShadow(world,n));
  let direct=sunIlluminance()*sunlight.r*solarShadowVisibility(shadowed).x;
  let ambient=textureSampleLevel(envCube,sampC,vec3f(0.0,1.0,0.0),7.0).rgb;
  let diffuse=max(dot(n,F.sunDir.xyz),0.0);
  let visibility=0.35+0.32*max(n.y,0.0);
  let wet=(1.0-smoothstep(0.6,3.2,world.y))*0.55;
  let toEye=normalize(eye-world);

  var color=albedo*(1.0-wet*0.3)*(direct*diffuse/PI+ambient*visibility);
  let sun=normalize(select(vec3f(0.0,1.0,0.0),F.sunDir.xyz,length(F.sunDir.xyz)>0.001));
  let halfRaw=toEye+sun;
  let halfway=select(vec3f(0.0,1.0,0.0),normalize(halfRaw),length(halfRaw)>1e-5);
  color+=direct*pow(max(dot(n,halfway),0.0),mix(14.0,36.0,wet))*(0.042+wet*0.11);
  color+=lunarSurface(n,toEye,albedo,roughness,vec3f(0.035),vec3f(sunlight.g)*lunarShadowVisibility(shadowed));
  let shifted=world+continuumShift();
  color+=lightningSurface(n,toEye,albedo,roughness)+worldFireSurface(shifted,n,toEye,albedo,roughness);
  return vec4f(continuumAir(color,shifted),1.0);
}
`;

// The boulders' material (js/wgsl/continuum-cut.js). Closed bodies wound outward; not seen under water.
export const BOULDER_CONTINUUM_MATERIAL_SPEC = Object.freeze({
  name: 'boulderContinuum', prelude: boulderContinuumPreludeWGSL, core: false, data: Object.freeze({ group: 2, binding: 0 }),
  varyings: [['stone', 'vec3f', true], ['lit', 'vec2f']],
  wgsl: () => BOULDER_CONTINUUM_MATERIAL_WGSL, salt: 5,
  cullMode: 'back', air: true, capture: false,
});

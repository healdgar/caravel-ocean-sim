import { FRAME_WGSL, ATMO_CORE_WGSL } from './common.js';
import { SKY_RENDER_FUNCS } from './sky.js';
import { VESSEL_LIGHTING } from './vessel.js';
import { SCENE_SHADOW_SAMPLE } from './shadows.js';

export const ANCHOR_RENDER = FRAME_WGSL+ATMO_CORE_WGSL+SKY_RENDER_FUNCS+VESSEL_LIGHTING+SCENE_SHADOW_SAMPLE+/* wgsl */ `
@group(0) @binding(0) var<uniform> F:Frame;
@group(0) @binding(1) var transLUT:texture_2d<f32>;
@group(0) @binding(2) var skyLUT:texture_2d<f32>;
@group(0) @binding(3) var sampC:sampler;
@group(0) @binding(4) var envCube:texture_cube<f32>;
@group(0) @binding(5) var<storage,read> sunVis:array<f32>;
struct AnchorPose {right:vec4f,up:vec4f,aft:vec4f,origin:vec4f};
@group(0) @binding(6) var<uniform> A:AnchorPose;
struct AnchorVertex {
  @builtin(position) position:vec4f,@location(0) world:vec3f,
  @location(1) normal:vec3f,@location(2) kind:vec2f,
};
@vertex fn vs(@location(0) position:vec3f,@location(1) normal:vec3f,@location(2) kind:vec2f)->AnchorVertex {
  let world=select(position,A.origin.xyz+A.right.xyz*position.x+A.up.xyz*position.y+A.aft.xyz*position.z,A.origin.w>.5);
  let n=select(normal,A.right.xyz*normal.x+A.up.xyz*normal.y+A.aft.xyz*normal.z,A.origin.w>.5);
  var out:AnchorVertex;out.position=F.viewProj*vec4f(world-F.camPos.xyz,1);
  out.world=world;out.normal=n;out.kind=kind;return out;
}
@fragment fn fs(v:AnchorVertex)->@location(0) vec4f {
  let n=normalize(v.normal);let eye=normalize(F.camPos.xyz-v.world);
  let iron=v.kind.x<.5;let water=v.kind.x>2.5;
  var color=select(select(vec3f(.11,.075,.037),vec3f(.07,.055,.04),v.kind.x>1.5),vec3f(.032,.035,.038),iron);
  color=select(color,vec3f(.45,.57,.59),water);
  let grain=.92+.08*sin(v.world.y*110.0+sin(v.world.x*67.0)+v.world.z*53.0);
  color*=select(grain,1.0,water);
  let rough=select(select(.8,.38,iron),.5,water);
  let f0=select(vec3f(.035),vec3f(.13),iron);
  let sun=sunIlluminance()*sunVis[0]*step(0.0,F.sunDir.y)*solarShadowVisibility(vesselShadow(v.world,n));
  let sky=textureSampleLevel(envCube,sampC,vec3f(0,1,0),7).rgb;
  let sea=textureSampleLevel(envCube,sampC,vec3f(0,-1,0),7).rgb;
  var radiance=color*vesselAmbient(n,sky,sea)+sun*(color/PI+vesselSpecular(n,eye,F.sunDir.xyz,rough,f0))*max(dot(n,F.sunDir.xyz),0.0);
  radiance+=lunarSurface(n,eye,color,rough,f0,sunVis[1]*lunarShadowVisibility(vesselShadow(v.world,n)))+lightningSurface(n,eye,color,rough);
  let alpha=select(1.0,clamp(v.kind.y,0.0,1.0),water);
  return vec4f(surfaceAir(radiance,v.world)*alpha,alpha);
}
`;

// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Share moving-wave contact, atmosphere and the same wet skin lighting as the
// dolphins. Only species-specific motion and the whale exhalation are added.
import {DOLPHIN_RENDER} from './dolphins.js';
export const MARINE_BLOW_SEGMENTS=16;
export const MARINE_BLOW_ROWS=5;
const marineBodyVertex=/* wgsl */ `
@vertex fn dolphinVS(@location(0) p:vec3f,@location(1) normal:vec3f,@location(2) albedo:vec3f,@builtin(instance_index) id:u32)->DolphinVertex {
  let d=dolphins[id];let whale=d.pose.w>0.0;
  let roll=d.pose.w-select(-2.0,2.0,whale);
  let length=select(4.8,13.2,whale);
  let tail=clamp((p.z-select(.15,1.6,whale))/select(2.4,5.4,whale),0.0,1.0);
  let beat=sin(F.reserved.w*select(4.2,2.0,whale)+d.pose.z);
  var local=p;var bentN=normal;
  if(whale){local.y+=beat*.55*tail*tail;bentN=normalize(normal+vec3f(0,0,-normal.y*beat*.20*tail));}
  else{local.x+=beat*.42*tail*tail;bentN=normalize(normal+vec3f(0,0,-normal.x*beat*.35*tail));}
  let forward=dolphinYaw(vec3f(0,0,-length*.32),d.root.w).xz;
  let seaPitch=clamp(atan2(dolphinHeight(d.root.xz+forward)-dolphinHeight(d.root.xz-forward),length*.64),-.28,.28);
  let pitchAngle=d.pose.x+seaPitch*(1.0-smoothstep(-.5,2.0,d.root.y));
  let c=cos(pitchAngle);let s=sin(pitchAngle);
  let pitch=mat3x3f(vec3f(1,0,0),vec3f(0,c,s),vec3f(0,-s,c));
  let cr=cos(roll);let sr=sin(roll);let bank=mat3x3f(vec3f(cr,sr,0),vec3f(-sr,cr,0),vec3f(0,0,1));
  let root=vec3f(d.root.x,dolphinHeight(d.root.xz)+d.root.y,d.root.z);
  var o:DolphinVertex;o.world=root+dolphinYaw(pitch*bank*local*d.pose.y,d.root.w);
  o.normal=dolphinYaw(pitch*bank*bentN,d.root.w);o.albedo=albedo;
  o.pos=F.viewProj*vec4f(o.world-F.camPos.xyz,1);return o;
}
`;
const marineBodyBegin=DOLPHIN_RENDER.indexOf('@vertex fn dolphinVS(');
const marineBodyEnd=DOLPHIN_RENDER.indexOf('fn dolphinSkinRadiance(');
if(marineBodyBegin<0||marineBodyEnd<marineBodyBegin)throw new Error('Shared marine skin shader contract changed');
export const MARINE_LIFE_RENDER=DOLPHIN_RENDER.slice(0,marineBodyBegin)+marineBodyVertex+DOLPHIN_RENDER.slice(marineBodyEnd)+/* wgsl */ `
// World-space turbulent exhalation tube: no large rectangular mist cards.
@vertex fn marineBlowVS(@builtin(vertex_index) vertex:u32,@builtin(instance_index) id:u32)->DolphinEffect {
  let s=splashes[id];let corner=dolphinCorner(vertex%6u)*.5+.5;
  let cell=vertex/6u;let segment=cell%${MARINE_BLOW_SEGMENTS}u;let row=cell/${MARINE_BLOW_SEGMENTS}u;
  let level=(f32(row)+corner.y)/${MARINE_BLOW_ROWS}.0;
  let angle=(f32(segment)+corner.x)*(2.0*PI)/${MARINE_BLOW_SEGMENTS}.0;
  let age=s.root.z;let growth=smoothstep(0.0,.55,age);let released=max(0.0,age-.65);
  let curl=sin(angle*3.0+level*11.0-age*4.0+s.shape.y)*.11;
  let spread=(.06+level*.58+released*.12)*(1.0+curl)*growth;
  let drift=vec2f(s.motion.y,s.motion.z)*(age*.13+level*.085)*growth;
  let q=s.root.xy+drift+vec2f(cos(angle),sin(angle))*spread;
  let base=dolphinHeight(s.root.xy)+s.motion.x;
  var o:DolphinEffect;o.world=vec3f(q.x,base+released*1.5+level*4.8*growth,q.y);
  o.uv=vec2f(angle,level);o.data=dolphinEffectData(s);o.pos=F.viewProj*vec4f(o.world-F.camPos.xyz,1);return o;
}
@fragment fn marineBlowFS(v:DolphinEffect)->@location(0) vec4f {
  let age=v.data.x;let fade=smoothstep(0.0,.08,age)*(1.0-smoothstep(1.2,2.7,age));
  let turbulence=.55+.20*sin(v.uv.x*7.0+v.uv.y*13.0-age*6.0)+.2*sin(v.uv.x*13.0-v.uv.y*21.0);
  let edge=smoothstep(0.0,.08,v.uv.y)*(1.0-smoothstep(.70,1.0,v.uv.y));
  let alpha=fade*edge*turbulence*.34;
  if(alpha<.004){discard;}
  let normal=normalize(cross(dpdy(v.world),dpdx(v.world)));
  let light=dolphinWaterColor(v.world,normal,.90);
  return vec4f(surfaceAir(light,v.world)*alpha,alpha);
}
`;

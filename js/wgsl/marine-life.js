// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Share moving-wave contact, atmosphere and the same wet skin lighting as the
// dolphins. Impact water and exhalation have separate, finite parcel dynamics.
import {DOLPHIN_RENDER} from './dolphins.js';
export const MARINE_MIST_COUNT=96;
export const MARINE_BREATH_DROP_COUNT=64;
export const MARINE_FALLOUT_COUNT=24;
export const MARINE_IMPACT_SEGMENTS=64;
export const MARINE_IMPACT_ROWS=6;
export const MARINE_IMPACT_DROP_COUNT=64;
// Analytic parcel motion in metres/seconds. Fine condensate follows a decaying
// exhaled-air jet; heavier entrained water has drag and full gravity.
export const MARINE_BREATH_DYNAMICS=/* wgsl */ `
fn marineRandom(x:u32)->f32 {
  var n=x;n=(n^(n>>16u))*2246822519u;n=(n^(n>>13u))*3266489917u;
  return f32(n^(n>>16u))/4294967296.0;
}
struct MarineBreath {offset:vec3f,velocity:vec3f,age:f32,radius:f32,life:f32,opacity:f32};
fn marineBreathParticle(eventAge:f32,id:u32,seed:f32,wind:vec2f,heading:f32,scale:f32,coarse:bool)->MarineBreath {
  let key=id*747796405u+bitcast<u32>(seed);
  let a=marineRandom(key);let b=marineRandom(key+277803737u);let c=marineRandom(key+1597334677u);
  let birth=a*.42;let t=max(0.0,eventAge-birth);let angle=b*6.2831853;
  let radial=select(.35+c*.9,.5+c*1.7,coarse)*scale;
  let source=vec3f(sin(heading)*3.0,0,-cos(heading)*3.0);
  let lx=cos(angle)*radial;let lz=sin(angle)*radial;
  let launch=source+vec3f(cos(heading)*lx-sin(heading)*lz,select(5.5+c*2.0,5.5+c*3.0,coarse)*scale,sin(heading)*lx+cos(heading)*lz);
  let drag=select(1.9,.22+c*.23,coarse);
  let ambient=vec3f(wind.x,select(.08,-9.81/drag,coarse),wind.y);
  let decay=exp(-drag*t);let integral=(1.0-decay)/drag;
  var o:MarineBreath;
  o.offset=source*birth+ambient*t+(launch-ambient)*integral;
  o.velocity=ambient+(launch-ambient)*decay;o.age=eventAge-birth;
  o.radius=select((.055+c*.035+t*(.23+c*.12))*scale,(.010+c*.014)*scale,coarse);
  o.life=select(1.6+b*.7,2.6,coarse);
  o.opacity=select(.075,.7,coarse)*smoothstep(0.0,.045,o.age)*(1.0-smoothstep(o.life*.65,o.life,o.age));
  return o;
}
`;
// A short lamella of water leaves the footprint over .18 seconds. Each row
// labels a different emission time, with full gravity after release: no row
// remains tethered to a later wave. Wind and fluid sheet interactions are not
// modeled here. The existing surface ripples supply wave-attached foam.
export const MARINE_IMPACT_DYNAMICS=/* wgsl */ `
struct MarineImpactSheet {offset:vec3f,velocity:vec3f,normal:vec3f,age:f32,birth:f32,life:f32,opacity:f32};
struct MarineImpactDrop {offset:vec3f,velocity:vec3f,age:f32,birth:f32,life:f32,radius:f32,opacity:f32};
fn marineImpactPhase(seed:f32,key:f32)->f32 {return seed+marineRandom(bitcast<u32>(key))*6.2831853;}
fn marineImpactSheet(eventAge:f32,angle:f32,row:f32,seed:f32,heading:f32,scale:f32,strength:f32,speed:f32,key:f32)->MarineImpactSheet {
  let phase=marineImpactPhase(seed,key);let force=clamp(strength,.1,2.6);let footprint=.23*max(.6,scale);
  let birth=(1.0-row)*.18;let age=eventAge-birth;let t=max(0.0,age);let c=cos(angle);let s=sin(angle);
  let wrinkle=1.0+.07*sin(angle*2.0+phase)+.035*sin(angle*3.0-phase);
  let radius=footprint*wrinkle+(.8+force*1.3)*t;
  let radial=.8+force*1.3;let upward=(1.8+force*2.35)*(.94+.06*sin(angle*2.0+phase));
  let radiusAngle=footprint*(.14*cos(angle*2.0+phase)+.105*cos(angle*3.0-phase));
  let upwardAngle=(1.8+force*2.35)*.12*cos(angle*2.0+phase);
  let tangentAngle=vec3f(c*radiusAngle-s*radius,upwardAngle*t,1.15*(s*radiusAngle+c*radius));
  // Once emitted, source travel during birth and flight sums to speed*eventAge,
  // so it has no row derivative. The row derivative includes the complete g.
  let tangentRow=vec3f(c*radial,upward-9.81*t,1.15*s*radial)*.18;
  let surfaceNormal=cross(tangentAngle,tangentRow);let normalLength=length(surfaceNormal);
  var o:MarineImpactSheet;
  o.offset=dolphinYaw(vec3f(c*radius,.035+upward*t-4.905*t*t,1.15*s*radius-clamp(speed,0.0,12.0)*.22*(birth+t)),heading);
  o.velocity=dolphinYaw(vec3f(c*radial,upward-9.81*t,1.15*s*radial-clamp(speed,0.0,12.0)*.22),heading);
  o.normal=dolphinYaw(surfaceNormal/max(normalLength,1e-9),heading);
  if(normalLength<1e-9){o.normal=vec3f(0,1,0);}
  o.age=age;o.birth=birth;o.life=(upward+sqrt(upward*upward+2.0*9.81*.035))/9.81;
  o.opacity=smoothstep(0.0,.025,age)*(1.0-smoothstep(o.life*.68,o.life,age));return o;
}
fn marineImpactDrop(eventAge:f32,id:u32,seed:f32,heading:f32,scale:f32,strength:f32,speed:f32,key:f32)->MarineImpactDrop {
  let hash=id*747796405u+bitcast<u32>(seed)+bitcast<u32>(key);
  let a=marineRandom(hash);let b=marineRandom(hash+277803737u);let c=marineRandom(hash+1597334677u);
  let angle=f32(id)*2.3999632+marineImpactPhase(seed,key);let birth=a*.18;let age=eventAge-birth;let t=max(0.0,age);
  let force=clamp(strength,.1,2.6);let radial=(.8+force*1.3)*(.45+.8*b);let upward=(1.8+force*2.35)*(.72+.42*c);
  let source=vec3f(cos(angle)*.23*max(.6,scale)*(.75+.25*c),.035,sin(angle)*.23*max(.6,scale)*1.15*(.75+.25*c)-clamp(speed,0.0,12.0)*.22*birth);
  let launch=vec3f(cos(angle)*radial,upward,sin(angle)*radial*1.15-clamp(speed,0.0,12.0)*.22);
  var o:MarineImpactDrop;o.offset=dolphinYaw(source+launch*t+vec3f(0,-4.905*t*t,0),heading);
  o.velocity=dolphinYaw(launch+vec3f(0,-9.81*t,0),heading);o.age=age;o.birth=birth;
  o.life=(upward+sqrt(upward*upward+2.0*9.81*.035))/9.81;o.radius=(.012+c*.018)*clamp(scale/5.2,.6,2.0);
  o.opacity=.62*smoothstep(0.0,.02,age)*(1.0-smoothstep(o.life*.82,o.life,age));return o;
}
fn marineImpactOpacity(p:MarineImpactDrop,hit:vec4f,key:f32)->f32 {
  return select(p.opacity,0.0,key>0.0&&hit.x==key&&hit.y>=0.0);
}
fn marineSheetContactIndex(key:f32,column:u32,row:u32)->u32 {
  return ((u32(key)%48u)*${MARINE_IMPACT_SEGMENTS}u+column%${MARINE_IMPACT_SEGMENTS}u)*${MARINE_IMPACT_ROWS+1}u+row;
}
fn marineSheetOpacity(p:MarineImpactSheet,hit:vec4f,key:f32)->f32 {
  return select(p.opacity,0.0,key>0.0&&hit.x==key&&hit.y>=0.0);
}
`;
const marineBodyVertex=/* wgsl */ `
@vertex fn dolphinVS(@location(0) p:vec3f,@location(1) normal:vec3f,@location(2) albedo:vec3f,@location(3) uv:vec2f,@location(4) joints:vec4u,@location(5) weights:vec4f,@builtin(instance_index) id:u32)->DolphinVertex {
  let d=dolphins[id];let whale=d.pose.w>0.0;
  let roll=d.pose.w-select(-2.0,2.0,whale);
  let length=select(4.8,13.2,whale);
  let tail=clamp((p.z-select(.15,1.6,whale))/select(2.4,5.4,whale),0.0,1.0);
  let beat=sin(F.reserved.w*select(4.2,2.0,whale)+d.pose.z);
  var local=p;var bentN=normal;
  if(whale){let skin=marineBones[joints.x]*weights.x+marineBones[joints.y]*weights.y+marineBones[joints.z]*weights.z+marineBones[joints.w]*weights.w;local=(skin*vec4f(p,1)).xyz;bentN=normalize((skin*vec4f(normal,0)).xyz);}
  else{local.x+=beat*.42*tail*tail;bentN=normalize(normal+vec3f(0,0,-normal.x*beat*.35*tail));}
  let forward=dolphinYaw(vec3f(0,0,-length*.32),d.root.w).xz;
  let seaPitch=clamp(atan2(dolphinHeight(d.root.xz+forward)-dolphinHeight(d.root.xz-forward),length*.64),-.28,.28);
  // Whale pitch/roll come from the same CPU pose used by its forehead outlet.
  // An extra wave pitch here would detach exhalation from the rendered head.
  let pitchAngle=d.pose.x+seaPitch*(1.0-smoothstep(-.5,2.0,d.root.y))*select(1.0,0.0,whale);
  let c=cos(pitchAngle);let s=sin(pitchAngle);
  let pitch=mat3x3f(vec3f(1,0,0),vec3f(0,c,s),vec3f(0,-s,c));
  let cr=cos(roll);let sr=sin(roll);let bank=mat3x3f(vec3f(cr,sr,0),vec3f(-sr,cr,0),vec3f(0,0,1));
  let root=vec3f(d.root.x,dolphinHeight(d.root.xz)+d.root.y,d.root.z);
  var o:DolphinVertex;o.world=root+dolphinYaw(pitch*bank*local*d.pose.y,d.root.w);
  o.normal=dolphinYaw(pitch*bank*bentN,d.root.w);o.albedo=albedo;o.uv=uv;o.species=select(0.0,1.0,whale);
  o.pos=F.viewProj*vec4f(o.world-F.camPos.xyz,1);return o;
}
`;
const marineBodyBegin=DOLPHIN_RENDER.indexOf('@vertex fn dolphinVS(');
const marineBodyEnd=DOLPHIN_RENDER.indexOf('fn dolphinSkinRadiance(');
if(marineBodyBegin<0||marineBodyEnd<marineBodyBegin)throw new Error('Shared marine skin shader contract changed');
const marineEffects=DOLPHIN_RENDER.slice(marineBodyEnd)
  .replace('fn dolphinSkinRadiance(world:vec3f,normal:vec3f,albedo:vec3f)->vec3f',
    'fn dolphinSkinRadiance(world:vec3f,normal:vec3f,albedo:vec3f,roughness:f32)->vec3f')
  .replace('let rough=.32;','let rough=roughness;')
  .replace('return vec4f(surfaceAir(dolphinSkinRadiance(v.world,v.normal,v.albedo),v.world),1);',/* wgsl */ `
  let base=textureSample(marineColor,seaSampler,v.uv).rgb;
  let map=textureSample(marineNormal,seaSampler,v.uv).xyz*2.0-1.0;
  let rough=textureSample(marineRoughness,seaSampler,v.uv).g;
  let dx=dpdx(v.world);let dy=dpdy(v.world);let du=dpdx(v.uv);let dv=dpdy(v.uv);
  let determinant=du.x*dv.y-du.y*dv.x;var n=normalize(v.normal);
  if(v.species>.5&&abs(determinant)>1e-9){
    let t=normalize((dx*dv.y-dy*du.y)/determinant);let b=normalize((dy*du.x-dx*dv.x)/determinant);
    n=normalize(t*map.x+b*map.y+n*map.z);
  }
  let albedo=v.albedo*select(vec3f(1),base,v.species>.5);
  let r=select(.32,clamp(rough,.22,.9),v.species>.5);
  return vec4f(surfaceAir(dolphinSkinRadiance(v.world,n,albedo,r),v.world),1);`)
  .replace('dolphinHeight(q)+.035+rise*t*lobe','mix(dolphinHeight(q),marineBirthSea(s),t)+.035+rise*t*lobe')
  .replace('dolphinHeight(s.root.xy)+.08','marineBirthSea(s)+.08')
  .replace('let radius=dot(v.uv,v.uv);if(radius>.96){discard;}',
    'let radius=dot(v.uv,v.uv);if(radius>.96||v.world.y<=dolphinHeight(v.world.xz)){discard;}');
const marineBodyBindings=DOLPHIN_RENDER.slice(0,marineBodyBegin)
  .replace(/@location\(2\)\s*albedo:vec3f};/,'@location(2) albedo:vec3f,@location(3) uv:vec2f,@location(4) species:f32};');
export const MARINE_LIFE_RENDER=marineBodyBindings+marineBodyVertex+marineEffects+MARINE_BREATH_DYNAMICS+MARINE_IMPACT_DYNAMICS+/* wgsl */ `
@group(0) @binding(10) var<storage,read> marineOrigins:array<vec4f>;
@group(0) @binding(11) var<storage,read> marineLandings:array<vec4f>;
@group(0) @binding(12) var marineColor:texture_2d<f32>;
@group(0) @binding(13) var marineNormal:texture_2d<f32>;
@group(0) @binding(14) var marineRoughness:texture_2d<f32>;
@group(0) @binding(15) var<storage,read> marineBones:array<mat4x4f>;
@group(0) @binding(16) var<storage,read> marineSheetLandings:array<vec4f>;
fn marineBirthSea(s:DolphinSplash)->f32 {
  let origin=marineOrigins[u32(s.motion.w)%48u];
  if(origin.x==s.motion.w&&s.motion.w>0.0){return origin.y;}
  return dolphinHeight(s.root.xy);
}
fn marineBreathWorld(s:DolphinSplash,p:MarineBreath)->vec3f {
  return vec3f(s.root.x,marineBirthSea(s)+s.motion.x,s.root.y)+p.offset;
}
fn marineImpactWorld(s:DolphinSplash,offset:vec3f)->vec3f {return vec3f(s.root.x,marineBirthSea(s),s.root.y)+offset;}
fn marineImpactDropBirthSea(s:DolphinSplash,id:u32)->f32 {
  let index=48u+(u32(s.motion.w)%48u)*${MARINE_IMPACT_DROP_COUNT}u+id%${MARINE_IMPACT_DROP_COUNT}u;
  if(index<arrayLength(&marineOrigins)){
    let origin=marineOrigins[index];
    if(origin.x==s.motion.w&&s.motion.w>0.0){return origin.y;}
  }
  return marineBirthSea(s);
}
fn marineImpactDropWorld(s:DolphinSplash,id:u32,offset:vec3f)->vec3f {
  return vec3f(s.root.x,marineImpactDropBirthSea(s,id),s.root.y)+offset;
}
fn marineImpactSheetBirthSea(s:DolphinSplash,hit:vec4f)->f32 {
  if(s.motion.w>0.0&&hit.x==s.motion.w){return hit.z;}
  return marineBirthSea(s);
}
fn marineImpactSheetWorld(s:DolphinSplash,offset:vec3f,hit:vec4f)->vec3f {
  return vec3f(s.root.x,marineImpactSheetBirthSea(s,hit),s.root.y)+offset;
}
struct MarineImpactVertex {@builtin(position) pos:vec4f,@location(0) uv:vec2f,@location(1) world:vec3f,@location(2) data:vec4f,@location(3) normal:vec3f};
@vertex fn marineImpactSheetVS(@builtin(vertex_index) vertex:u32,@builtin(instance_index) id:u32)->MarineImpactVertex {
  let s=splashes[id];let corner=dolphinCorner(vertex%6u)*.5+.5;let cell=vertex/6u;
  let segment=cell%${MARINE_IMPACT_SEGMENTS}u;let column=(segment+u32(corner.x))%${MARINE_IMPACT_SEGMENTS}u;
  let rowIndex=cell/${MARINE_IMPACT_SEGMENTS}u+u32(corner.y);
  // Geometry and contact share the exact seam sample; only the interpolated
  // material angle remains unwrapped across the final angular cell.
  let angle=f32(column)*(2.0*PI)/${MARINE_IMPACT_SEGMENTS}.0;let row=f32(rowIndex)/${MARINE_IMPACT_ROWS}.0;
  let p=marineImpactSheet(s.root.z,angle,row,s.shape.y,s.shape.x,s.shape.w,s.root.w,s.motion.x,s.motion.w);
  let hit=marineSheetLandings[marineSheetContactIndex(s.motion.w,column,rowIndex)];
  var o:MarineImpactVertex;o.world=marineImpactSheetWorld(s,p.offset,hit);o.normal=p.normal;
  o.uv=vec2f((f32(segment)+corner.x)*(2.0*PI)/${MARINE_IMPACT_SEGMENTS}.0,row);
  o.data=vec4f(p.age,marineSheetOpacity(p,hit,s.motion.w),marineImpactPhase(s.shape.y,s.motion.w),s.root.w);
  o.pos=F.viewProj*vec4f(o.world-F.camPos.xyz,1);return o;
}
@fragment fn marineImpactSheetFS(v:MarineImpactVertex)->@location(0) vec4f {
  if(v.data.x<=0.0||v.world.y<=dolphinHeight(v.world.xz)){discard;}
  let edge=smoothstep(0.0,.12,v.uv.y)*(1.0-smoothstep(.82,1.0,v.uv.y));
  let lace=.62+.2*sin(v.uv.x*11.0+v.data.z)*sin(v.uv.y*9.0+v.data.z)+.18*sin(v.uv.x*17.0-v.uv.y*11.0);
  let opening=smoothstep(.12,.55,v.data.x);let film=smoothstep(opening*.55,opening*.55+.22,lace);
  let foam=.08+.22*opening+.08*sin(v.uv.x*5.0+v.data.z)*sin(v.uv.x*5.0+v.data.z);
  let alpha=v.data.y*edge*film*(.16+.18*foam)*min(1.0,.45+v.data.w);
  if(alpha<.003){discard;}
  return vec4f(surfaceAir(dolphinWaterColor(v.world,v.normal,foam),v.world)*alpha,alpha);
}
@vertex fn marineImpactDropVS(@builtin(vertex_index) vertex:u32,@builtin(instance_index) instance:u32)->DolphinEffect {
  let s=splashes[instance/${MARINE_IMPACT_DROP_COUNT}u];let id=instance%${MARINE_IMPACT_DROP_COUNT}u;
  let p=marineImpactDrop(s.root.z,id,s.shape.y,s.shape.x,s.shape.w,s.root.w,s.motion.x,s.motion.w);
  let centre=marineImpactDropWorld(s,id,p.offset);let hit=marineLandings[(u32(s.motion.w)%48u)*${MARINE_BREATH_DROP_COUNT}u+id];
  let corner=dolphinCorner(vertex);let up=normalize(F.camUp.xyz);let right=normalize(F.camRight.xyz);
  let stretch=min(.05,abs(dot(p.velocity,up))*.006);
  var o:DolphinEffect;o.world=centre;o.uv=corner;o.data=vec4f(p.age,marineImpactOpacity(p,hit,s.motion.w),s.shape.y,0);
  o.pos=F.viewProj*vec4f(centre-F.camPos.xyz+right*corner.x*p.radius+up*corner.y*(p.radius+stretch),1);return o;
}
@fragment fn marineImpactDropFS(v:DolphinEffect)->@location(0) vec4f {
  let r2=dot(v.uv,v.uv);if(r2>=1.0||v.world.y<=dolphinHeight(v.world.xz)){discard;}
  let alpha=(1.0-smoothstep(.2,1.0,r2))*v.data.y;if(alpha<.001){discard;}
  let eye=normalize(F.camPos.xyz-v.world);
  let normal=normalize(normalize(F.camRight.xyz)*v.uv.x+normalize(F.camUp.xyz)*v.uv.y+eye*sqrt(max(.01,1.0-r2)));
  return vec4f(surfaceAir(dolphinWaterColor(v.world,normal,.12),v.world)*alpha,alpha);
}
// Many soft, staggered parcels detach from a brief moving exhalation. There is
// no connected cone, cylinder, or continuously rising sheet.
@vertex fn marineBlowVS(@builtin(vertex_index) vertex:u32,@builtin(instance_index) id:u32)->DolphinEffect {
  let s=splashes[id];let p=marineBreathParticle(s.root.z,vertex/6u,s.shape.y,s.motion.yz,s.shape.x,s.shape.w/5.2,false);
  let corner=dolphinCorner(vertex%6u);let centre=marineBreathWorld(s,p);
  var o:DolphinEffect;o.world=centre+(normalize(F.camRight.xyz)*corner.x+normalize(F.camUp.xyz)*corner.y)*p.radius;
  o.uv=corner;o.data=vec4f(p.age,p.opacity,s.shape.y,0);o.pos=F.viewProj*vec4f(o.world-F.camPos.xyz,1);return o;
}
@fragment fn marineBlowFS(v:DolphinEffect)->@location(0) vec4f {
  let r2=dot(v.uv,v.uv);if(r2>=1.0){discard;}
  let breakup=.75+.16*sin(v.world.x*13.0+v.world.y*9.0+v.data.z)*sin(v.world.z*11.0-v.world.y*7.0);
  let alpha=exp(-r2*3.5)*(1.0-smoothstep(.65,1.0,r2))*v.data.y*breakup;
  if(alpha<.001||v.world.y<=dolphinHeight(v.world.xz)){discard;}
  let view=normalize(F.camPos.xyz-v.world);let forward=pow(max(dot(-view,F.sunDir.xyz),0.0),6.0);
  let light=skyAtmo(vec3f(0,1,0))*.65+sunIlluminance()*sunVis[0]*step(0.0,F.sunDir.y)*(.18+.32*forward)+lunarIlluminance()*sunVis[1]*(.18+.32*pow(max(dot(-view,lunarDirection()),0.0),6.0))+lightningLight()*.25;
  return vec4f(surfaceAir(light,v.world)*alpha,alpha);
}
@vertex fn marineBreathDropVS(@builtin(vertex_index) vertex:u32,@builtin(instance_index) id:u32)->DolphinEffect {
  let s=splashes[id];let p=marineBreathParticle(s.root.z,vertex/6u,s.shape.y,s.motion.yz,s.shape.x,s.shape.w/5.2,true);
  let corner=dolphinCorner(vertex%6u);let centre=marineBreathWorld(s,p);
  let up=normalize(F.camUp.xyz);let right=normalize(F.camRight.xyz);
  let streak=clamp(dot(p.velocity,up)*.009,-.07,.07);
  let hit=marineLandings[(u32(s.motion.w)%48u)*${MARINE_BREATH_DROP_COUNT}u+vertex/6u];
  let landed=hit.x==s.motion.w&&hit.y>=0.0;
  var o:DolphinEffect;o.world=centre;o.uv=corner;o.data=vec4f(p.age,select(p.opacity,0.0,landed),s.shape.y,0);
  o.pos=F.viewProj*vec4f(centre-F.camPos.xyz+right*corner.x*p.radius+up*corner.y*(p.radius+abs(streak)),1);return o;
}
@fragment fn marineBreathDropFS(v:DolphinEffect)->@location(0) vec4f {
  let r2=dot(v.uv,v.uv);if(r2>=1.0||v.world.y<=dolphinHeight(v.world.xz)){discard;}
  let alpha=(1.0-smoothstep(.2,1.0,r2))*v.data.y;
  if(alpha<.001){discard;}
  let eye=normalize(F.camPos.xyz-v.world);
  let normal=normalize(normalize(F.camRight.xyz)*v.uv.x+normalize(F.camUp.xyz)*v.uv.y+eye*sqrt(max(.01,1.0-r2)));
  return vec4f(surfaceAir(dolphinWaterColor(v.world,normal,.25),v.world)*alpha,alpha);
}
// Representative returning droplets make small, expanding surface ripples.
@vertex fn marineFalloutVS(@builtin(vertex_index) vertex:u32,@builtin(instance_index) id:u32)->DolphinEffect {
  let s=splashes[id];let particle=vertex/6u;
  let hit=marineLandings[(u32(s.motion.w)%48u)*${MARINE_BREATH_DROP_COUNT}u+particle];
  let valid=hit.x==s.motion.w&&hit.y>=0.0;
  let age=select(-1.0,s.root.z-hit.y,valid);let corner=dolphinCorner(vertex%6u);let radius=.035+max(0.0,age)*.38;
  let q=hit.zw+corner*radius;
  var o:DolphinEffect;o.world=vec3f(q.x,dolphinHeight(q)+.018,q.y);o.uv=corner;o.data=vec4f(age,1.0-smoothstep(.35,.8,age),0,0);
  o.pos=F.viewProj*vec4f(o.world-F.camPos.xyz,1);return o;
}
@fragment fn marineFalloutFS(v:DolphinEffect)->@location(0) vec4f {
  let r=length(v.uv);let ring=1.0-smoothstep(.035,.12,abs(r-.78));
  let alpha=ring*smoothstep(0.0,.05,v.data.x)*v.data.y*.13;if(alpha<.002){discard;}
  return vec4f(surfaceAir(dolphinWaterColor(v.world,vec3f(0,1,0),.4),v.world)*alpha,alpha);
}
`;

// Fixed-size birth-height cache, keyed by event serial rather than sorted draw
// order. Only a new event samples the sea; detached spray cannot ride later waves.
export const MARINE_EFFECT_INIT=DOLPHIN_RENDER+MARINE_BREATH_DYNAMICS+MARINE_IMPACT_DYNAMICS+/* wgsl */ `
@group(0) @binding(10) var<storage,read_write> marineBirths:array<vec4f>;
@group(0) @binding(11) var<storage,read_write> marineContacts:array<vec4f>;
@group(0) @binding(16) var<storage,read_write> marineSheetContacts:array<vec4f>;
// Separate dispatch preserves the existing birth/breath pipeline's bindings.
// Every material vertex freezes its own launch-footprint sea height and latches
// absorption, including waves overtaking rising sheet water. Neither falling
// waves nor draw-order changes release that latch.
@compute @workgroup_size(${MARINE_IMPACT_SEGMENTS}) fn marineImpactContactCS(@builtin(workgroup_id) id:vec3u,@builtin(local_invocation_id) local:vec3u){
  let s=splashes[id.x];if(s.motion.w<=0.0||s.shape.z<.5||s.shape.z>=2.5){return;}
  let slot=u32(s.motion.w)%48u;let origin=marineBirths[slot];
  if(origin.x!=s.motion.w){return;}
  let angle=f32(local.x)*(2.0*PI)/${MARINE_IMPACT_SEGMENTS}.0;
  for(var row=0u;row<=${MARINE_IMPACT_ROWS}u;row++){
    let rowFrac=f32(row)/${MARINE_IMPACT_ROWS}.0;
    let index=marineSheetContactIndex(s.motion.w,local.x,row);
    var hit=marineSheetContacts[index];
    if(hit.x!=s.motion.w){
      let p0=marineImpactSheet(0.0,angle,rowFrac,s.shape.y,s.shape.x,s.shape.w,s.root.w,s.motion.x,s.motion.w);
      hit=vec4f(s.motion.w,-1.0,dolphinHeight(s.root.xy+p0.offset.xz),0.0);
    }
    if(hit.y<0.0){
      let p=marineImpactSheet(s.root.z,angle,rowFrac,s.shape.y,s.shape.x,s.shape.w,s.root.w,s.motion.x,s.motion.w);
      let world=vec3f(s.root.x,hit.z,s.root.y)+p.offset;
      if(p.age>0.0&&world.y<=dolphinHeight(world.xz)){hit=vec4f(s.motion.w,s.root.z,hit.z,0.0);}
    }
    marineSheetContacts[index]=hit;
  }
}
@compute @workgroup_size(${MARINE_BREATH_DROP_COUNT}) fn marineBirthCS(@builtin(workgroup_id) id:vec3u,@builtin(local_invocation_id) local:vec3u){
  let s=splashes[id.x];let slot=u32(s.motion.w)%48u;
  if(local.x==0u&&s.motion.w>0.0&&marineBirths[slot].x!=s.motion.w){
    // CPU seeds real blows with their interpolated animal-root query. The
    // outlet's height is relative to that same sea sample used by the body.
    // Direct/synthetic effects have no negative key and retain their fallback.
    let seed=marineBirths[slot];let anchor=select(s.root.xy,seed.zw,seed.x == -s.motion.w);
    marineBirths[slot]=vec4f(s.motion.w,dolphinHeight(anchor),0,0);
  }
  storageBarrier();
  if(s.motion.w<=0.0||s.shape.z<.5){return;}
  let index=slot*${MARINE_BREATH_DROP_COUNT}u+local.x;
  var hit=marineContacts[index];
  if(s.shape.z<2.5){
    let dropBirthIndex=48u+index;
    var launchY=marineBirths[slot].y;
    if(local.x<${MARINE_IMPACT_DROP_COUNT}u){
      if(dropBirthIndex<arrayLength(&marineBirths)){
        if(marineBirths[dropBirthIndex].x!=s.motion.w){
          let p0=marineImpactDrop(0.0,local.x,s.shape.y,s.shape.x,s.shape.w,s.root.w,s.motion.x,s.motion.w);
          marineBirths[dropBirthIndex]=vec4f(s.motion.w,dolphinHeight(s.root.xy+p0.offset.xz),0,0);
        }
        launchY=marineBirths[dropBirthIndex].y;
      }else if(hit.x!=s.motion.w){
        let p0=marineImpactDrop(0.0,local.x,s.shape.y,s.shape.x,s.shape.w,s.root.w,s.motion.x,s.motion.w);
        launchY=dolphinHeight(s.root.xy+p0.offset.xz);
      }
    }
    if(hit.x!=s.motion.w){hit=vec4f(s.motion.w,-1,0,0);}
    if(local.x<${MARINE_IMPACT_DROP_COUNT}u&&hit.y<0.0){
      let p=marineImpactDrop(s.root.z,local.x,s.shape.y,s.shape.x,s.shape.w,s.root.w,s.motion.x,s.motion.w);
      let world=vec3f(s.root.x,launchY,s.root.y)+p.offset;
      // A rising wave can absorb rising water too. Once contact is recorded,
      // a later falling wave must not resurrect the airborne parcel.
      if(p.age>0.0&&world.y<=dolphinHeight(world.xz)){hit=vec4f(s.motion.w,s.root.z,world.xz);}
    }
    marineContacts[index]=hit;return;
  }
  if(hit.x!=s.motion.w){hit=vec4f(s.motion.w,-1,0,0);}
  if(hit.y<0.0){
    let p=marineBreathParticle(s.root.z,local.x,s.shape.y,s.motion.yz,s.shape.x,s.shape.w/5.2,true);
    let world=vec3f(s.root.x,marineBirths[slot].y+s.motion.x,s.root.y)+p.offset;
    if(p.age>0.0&&p.velocity.y<0.0&&world.y<=dolphinHeight(world.xz)){hit=vec4f(s.motion.w,s.root.z,world.xz);}
  }
  marineContacts[index]=hit;
}
`;

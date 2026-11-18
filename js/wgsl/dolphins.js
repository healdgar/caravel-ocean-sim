// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The sea's animals: the water they throw up, and their bodies through the one continuum (js/animal-continuum.js).
// Each body is a record of the one format, of the SKINNED kind: the stand below sets it on the moving sea at its depth
// and writes its joints (a dolphin's or shark's spine bent by its stroke, the whale's rig's bones), and the one cut
// chooses its clusters, far body or splat, poses them by those joints and draws them in the sea's material below.
import {FRAME_WGSL,ATMO_CORE_WGSL,CASCADES} from './common.js';
import {SKY_RENDER_FUNCS} from './sky.js';
import {VESSEL_LIGHTING} from './vessel.js';
import {SHADOW_SAMPLE} from './shadows.js';
import {DOLPHIN_SPLASH_SECONDS} from '../dolphin-state.js';
import {CONTINUUM_KIND} from '../continuum-format.js';
import {CONTINUUM_RECORD_WGSL} from './continuum-cut.js';
import {SKINNED_POSE_WGSL} from './skinned-pose.js';
import {ANIMAL_TYPE,ANIMAL_CONTINUUM_TYPES,ANIMAL_CONTINUUM_MATERIAL,ANIMAL_POSE_JOINTS,ANIMAL_POSE_VEC4S,ANIMAL_RIG_VEC4S,ANIMAL_SEA_STATIONS} from '../animal-continuum.js';

export const DOLPHIN_RIPPLE_SEGMENTS=32;
export const DOLPHIN_RIPPLE_RINGS=3;
export const DOLPHIN_RIPPLE_ROWS=2;
export const DOLPHIN_SHEET_SEGMENTS=28;
export const DOLPHIN_SHEET_ROWS=3;
export const DOLPHIN_DROP_COUNT=24;

// The moving sea's height under a point (F, displacement and seaSampler bound by the module that holds it).
const DOLPHIN_SEA_HEIGHT=/* wgsl */ `
fn dolphinSea(q:vec2f)->vec3f {
  var d=vec3f(0);
  for(var c=0u;c<${CASCADES}u;c++){d+=textureSampleLevel(displacement,seaSampler,q*F.cascInvL[c>>2u][c&3u],i32(c),0.0).xyz;}
  return d;
}
fn dolphinHeight(p:vec2f)->f32 {var q=p;for(var k=0;k<2;k++){q=p-dolphinSea(q).xz;}return dolphinSea(q).y;}
`;
// A continuous water film adds a narrow sunlight glint over the softer skin reflection. Both lobes use the scene sun,
// sky and atmospheric extinction, each seen through `shadow` (the land shadow set's, or 1). The skin's own roughness is
// .32 unless its texture says otherwise (the whale's).
const SEA_SKIN_WGSL=/* wgsl */ `
fn seaSkinRadiance(world:vec3f,normal:vec3f,albedo:vec3f,rough:f32,shadow:vec3f)->vec3f {
  let n=normalize(normal);let eye=normalize(F.camPos.xyz-world);let sun=F.sunDir.xyz;
  let direct=sunIlluminance()*sunVis[0]*step(0.0,sun.y)*solarShadowVisibility(shadow);
  let moon=vec3f(sunVis[1])*lunarShadowVisibility(shadow);
  let sky=textureSampleLevel(envCube,sampC,vec3f(0,1,0),8.0).rgb;
  let sea=textureSampleLevel(envCube,sampC,vec3f(0,-.4,1),8.0).rgb;
  let f0=vec3f(.035);let coatRough=.11;let coatF0=vec3f(.0204);
  let coatF=vesselFresnel(coatF0,max(dot(n,eye),0.0));
  let diffuse=albedo*(vesselAmbient(n,sky,sea)+direct*max(dot(n,sun),0.0)/PI);
  let reflected=textureSampleLevel(envCube,sampC,reflect(-eye,n),rough*8.0).rgb*vesselEnvironment(n,eye,rough,f0);
  let spec=vesselSpecular(n,eye,sun,rough,f0)*direct*max(dot(n,sun),0.0);
  let waterReflection=textureSampleLevel(envCube,sampC,reflect(-eye,n),coatRough*8.0).rgb*vesselEnvironment(n,eye,coatRough,coatF0);
  let waterGlint=vesselSpecular(n,eye,sun,coatRough,coatF0)*direct*max(dot(n,sun),0.0);
  let moonSkin=lunarSurface(n,eye,albedo,rough,f0,moon);
  let moonCoat=lunarSurface(n,eye,vec3f(0),coatRough,coatF0,moon);
  return (diffuse+reflected+spec+moonSkin)*(1.0-coatF)+waterReflection+waterGlint+moonCoat+lightningSurface(n,eye,albedo,coatRough);
}
fn dolphinSkinRadiance(world:vec3f,normal:vec3f,albedo:vec3f,rough:f32)->vec3f {return seaSkinRadiance(world,normal,albedo,rough,vec3f(1.0));}
`;

// What every sea animal's water shares: the scene, the moving sea, the wet skin's light and the water each animal
// throws up. Their bodies are the one continuum's (seaStandWGSL, the sea's material, below).
export const DOLPHIN_SEA_WGSL=FRAME_WGSL+ATMO_CORE_WGSL+VESSEL_LIGHTING+/* wgsl */ `
@group(0) @binding(0) var<uniform> F:Frame;
@group(0) @binding(1) var transLUT:texture_2d<f32>;
@group(0) @binding(2) var skyLUT:texture_2d<f32>;
@group(0) @binding(3) var sampC:sampler;
@group(0) @binding(4) var envCube:texture_cube<f32>;
@group(0) @binding(5) var<storage,read> sunVis:array<f32,4>;
@group(0) @binding(6) var displacement:texture_2d_array<f32>;
@group(0) @binding(7) var seaSampler:sampler;
// root: world xz, age, strength; shape: heading, seed, kind, scale;
// motion: swimming speed. Kind 0=surface trail, 1=emergence, 2=reentry.
struct DolphinSplash {root:vec4f,shape:vec4f,motion:vec4f};
@group(0) @binding(9) var<storage,read> splashes:array<DolphinSplash>;
`+SKY_RENDER_FUNCS+DOLPHIN_SEA_HEIGHT+SEA_SKIN_WGSL+/* wgsl */ `
fn dolphinYaw(p:vec3f,heading:f32)->vec3f {let c=cos(heading);let s=sin(heading);return vec3f(c*p.x-s*p.z,p.y,s*p.x+c*p.z);}
fn dolphinCorner(i:u32)->vec2f {return array<vec2f,6>(vec2f(-1,-1),vec2f(1,-1),vec2f(-1,1),vec2f(-1,1),vec2f(1,-1),vec2f(1,1))[i];}
struct DolphinEffect {@builtin(position) pos:vec4f,@location(0) uv:vec2f,@location(1) world:vec3f,@location(2) data:vec4f};
fn dolphinWaterColor(world:vec3f,normal:vec3f,foam:f32)->vec3f {
  let eye=normalize(F.camPos.xyz-world);var n=normalize(normal);if(dot(n,eye)<0.0){n=-n;}
  let direct=sunIlluminance()*sunVis[0]*step(0.0,F.sunDir.y);
  let reflected=textureSampleLevel(envCube,sampC,reflect(-eye,n),1.6).rgb;
  let light=skyAtmo(vec3f(0,1,0))*.55+direct*max(F.sunDir.y,.08)*.22+lunarIlluminance()*sunVis[1]*max(lunarDirection().y,.08)*.22+lightningLight()*.25;
  let spec=vesselSpecular(n,eye,F.sunDir.xyz,.19,vec3f(.025))*direct*max(dot(n,F.sunDir.xyz),0.0);
  return mix(reflected*.85+spec+lunarSurface(n,eye,vec3f(0),.19,vec3f(.025),vec3f(sunVis[1])),light,foam);
}
fn dolphinEffectData(s:DolphinSplash)->vec4f {return vec4f(s.root.z,s.root.w,s.shape.y,s.shape.z);}
@vertex fn dolphinRippleVS(@builtin(vertex_index) vertex:u32,@builtin(instance_index) id:u32)->DolphinEffect {
  let s=splashes[id];let trail=s.shape.z<.5;
  let ring=vertex/${DOLPHIN_RIPPLE_SEGMENTS*DOLPHIN_RIPPLE_ROWS*6}u;
  let row=(vertex/${DOLPHIN_RIPPLE_SEGMENTS*6}u)%${DOLPHIN_RIPPLE_ROWS}u;
  let segment=(vertex/6u)%${DOLPHIN_RIPPLE_SEGMENTS}u;let corner=dolphinCorner(vertex%6u)*.5+.5;
  let angle=(f32(segment)+corner.x)*(2.0*PI)/${DOLPHIN_RIPPLE_SEGMENTS}.0;
  let age=s.root.z-f32(ring)*.24;let grown=max(0.0,age);
  let scale=max(.6,s.shape.w);let cross=(f32(row)+corner.y)/${DOLPHIN_RIPPLE_ROWS}.0*2.0-1.0;
  let radius=(select(.4,.22,trail)*scale+grown*select(1.18,.88,trail))*(1.0+.025*sin(angle*5.0+s.shape.y));
  let width=(.09+grown*.035)*scale;
  let r=radius+cross*width;
  let local=vec3f(cos(angle)*r,0,sin(angle)*r*select(.86,1.18,trail));
  let q=s.root.xy+dolphinYaw(local,s.shape.x).xz;
  let crest=(1.0-cross*cross)*.025*s.root.w*exp(-grown);
  var o:DolphinEffect;o.world=vec3f(q.x,dolphinHeight(q)+.026+crest,q.y);o.uv=vec2f(cross,angle);
  o.data=dolphinEffectData(s);o.data.x=age;
  o.pos=F.viewProj*vec4f(o.world-F.camPos.xyz,1);return o;
}
@fragment fn dolphinRippleFS(v:DolphinEffect)->@location(0) vec4f {
  var normal=normalize(cross(dpdy(v.world),dpdx(v.world)));if(normal.y<0.0){normal=-normal;}
  let age=v.data.x;if(age<=0.0){discard;}
  let edge=1.0-smoothstep(.35,1.0,abs(v.uv.x));
  let broken=.65+.25*sin(v.uv.y*9.0+v.data.z)+.1*sin(v.uv.y*17.0-v.data.z);
  let fade=smoothstep(0.0,.12,age)*(1.0-smoothstep(.5,${DOLPHIN_SPLASH_SECONDS},age));
  // A surface swimmer leaves a broken, aft-weighted wake, not a spray emitter.
  let aft=select(1.0,.28+.72*smoothstep(-.5,.4,sin(v.uv.y)),v.data.w<.5);
  let foam=clamp(broken*exp(-age*1.2)*v.data.y,0.0,1.0);
  let alpha=edge*fade*aft*(.16+foam*.44)*min(1.0,.45+v.data.y);
  let light=dolphinWaterColor(v.world,normal,foam);
  return vec4f(surfaceAir(light,v.world)*alpha,alpha);
}
// A connected world-space crown expands from the contact footprint. Its rim
// rises ballistically, then breaks up; it is never a camera-facing smoke card.
@vertex fn dolphinSplashVS(@builtin(vertex_index) vertex:u32,@builtin(instance_index) id:u32)->DolphinEffect {
  let s=splashes[id];let corner=dolphinCorner(vertex%6u)*.5+.5;
  let cell=vertex/6u;let segment=cell%${DOLPHIN_SHEET_SEGMENTS}u;let row=cell/${DOLPHIN_SHEET_SEGMENTS}u;
  let angle=(f32(segment)+corner.x)*(2.0*PI)/${DOLPHIN_SHEET_SEGMENTS}.0;
  let t=(f32(row)+corner.y)/${DOLPHIN_SHEET_ROWS}.0;
  let age=s.root.z;let strength=s.root.w;let scale=max(.6,s.shape.w);
  let lobe=.8+.16*sin(angle*7.0+s.shape.y)+.09*sin(angle*13.0-s.shape.y);
  let rise=max(0.0,(2.1+strength*2.9)*age-4.905*age*age);
  let radius=(.23*scale+age*(.75+strength*1.6)*mix(.5,1.0,t))*(1.0+.1*sin(angle*5.0+s.shape.y));
  let drift=s.motion.x*age*.22;
  let q=s.root.xy+dolphinYaw(vec3f(cos(angle)*radius,0,sin(angle)*radius*1.15-drift),s.shape.x).xz;
  var o:DolphinEffect;o.world=vec3f(q.x,dolphinHeight(q)+.035+rise*t*lobe,q.y);
  o.uv=vec2f(angle,t);o.data=dolphinEffectData(s);o.pos=F.viewProj*vec4f(o.world-F.camPos.xyz,1);return o;
}
@fragment fn dolphinSplashFS(v:DolphinEffect)->@location(0) vec4f {
  let n=normalize(cross(dpdy(v.world),dpdx(v.world)));
  let life=(2.1+v.data.y*2.9)/4.905;
  let fade=smoothstep(0.0,.045,v.data.x)*(1.0-smoothstep(life*.55,life,v.data.x));
  let lace=.5+.25*sin(v.uv.x*19.0+v.data.z)*sin(v.uv.y*17.0+v.data.z)+.25*sin(v.uv.x*31.0-v.uv.y*13.0);
  let opening=smoothstep(.12,.55,v.data.x)*smoothstep(.1,.75,v.uv.y);
  let film=smoothstep(opening*.65,opening*.65+.18,lace);
  let foam=clamp(.18+smoothstep(.4,1.0,v.uv.y)*.68+opening*.25,0.0,1.0);
  let alpha=fade*film*(.17+foam*.43)*min(1.0,.45+v.data.y);
  if(alpha<.003){discard;}
  return vec4f(surfaceAir(dolphinWaterColor(v.world,n,foam),v.world)*alpha,alpha);
}
@vertex fn dolphinDropVS(@builtin(vertex_index) vertex:u32,@builtin(instance_index) instance:u32)->DolphinEffect {
  let s=splashes[instance/${DOLPHIN_DROP_COUNT}u];let id=f32(instance%${DOLPHIN_DROP_COUNT}u);let age=s.root.z;
  let angle=id*2.39996+s.shape.y;let random=fract(sin(id*13.71+s.shape.y)*312.6);
  let speed=(.7+random*1.4)*(.6+s.root.w*.7);
  let launch=dolphinYaw(vec3f(cos(angle)*speed,2.0+s.root.w*2.3+random*.8,sin(angle)*speed-s.motion.x*.18),s.shape.x);
  let p=vec3f(s.root.x,dolphinHeight(s.root.xy)+.08,s.root.y)+launch*age+vec3f(0,-4.905*age*age,0);
  let corner=dolphinCorner(vertex);let width=(.018+random*.018)*(.65+s.root.w)*max(.15,1.0-age*.8);
  var o:DolphinEffect;o.world=p;o.uv=corner;o.data=dolphinEffectData(s);
  o.pos=F.viewProj*vec4f(p-F.camPos.xyz+(normalize(F.camRight.xyz)*corner.x+normalize(F.camUp.xyz)*corner.y)*width,1);return o;
}
@fragment fn dolphinDropFS(v:DolphinEffect)->@location(0) vec4f {
  let radius=dot(v.uv,v.uv);if(radius>.96){discard;}
  let life=(2.0+v.data.y*2.3+.8)/4.905;
  let alpha=(1.0-smoothstep(.25,1.0,radius))*(1.0-smoothstep(life*.6,life,v.data.x))*.65*min(1.0,.45+v.data.y);
  let eye=normalize(F.camPos.xyz-v.world);
  let n=normalize(F.camRight.xyz*v.uv.x+F.camUp.xyz*v.uv.y+eye*sqrt(max(.01,1.0-radius)));
  return vec4f(surfaceAir(dolphinWaterColor(v.world,n,.65),v.world)*alpha,alpha);
}
`;

// The dolphins' water: their ripples, crowns and spray.
export const DOLPHIN_RENDER=DOLPHIN_SEA_WGSL;

// What a sea family's state writes for each animal (SEA_PLACE_VEC4S vec4f): where it swims, its depth under the sea and
// its yaw (the continuum's turns the other way from its heading); its pitch, roll, scale and its stroke's phase
// (radians); its type (below 0: none) and its seed (u32 bits).
export const SEA_PLACE_VEC4S=3;

// The stand: each animal's record set on the moving sea under it at its depth and turned, afloat and important (a
// breach, a fin, a blow is what the player watches); a shark near the surface pitched with the wave it rides. Its
// joints are written as scripts/prepare-animal-continuum.mjs measured them: a dolphin's or shark's spine stations
// bent by its stroke or, `marine`, the whale's rig's bones as its state poses them (column-major, to rows).
export function seaStandWGSL(marine){
  const A=ANIMAL_TYPE;
  return FRAME_WGSL+CONTINUUM_RECORD_WGSL+SKINNED_POSE_WGSL+/* wgsl */ `
@group(0) @binding(0) var<uniform> F:Frame;
@group(0) @binding(1) var<storage,read> seaPlaces:array<vec4f>;
@group(0) @binding(2) var<storage,read_write> seaRecords:array<ContinuumRecord>;
@group(0) @binding(3) var<storage,read_write> skinnedPoses:array<vec4f>;
@group(0) @binding(4) var<uniform> seaRig:array<vec4f,${ANIMAL_CONTINUUM_TYPES.length*ANIMAL_RIG_VEC4S}>;
${marine?'@group(0) @binding(5) var<storage,read> marineBones:array<mat4x4f>;':''}
@group(0) @binding(6) var displacement:texture_2d_array<f32>;
@group(0) @binding(7) var seaSampler:sampler;
`+DOLPHIN_SEA_HEIGHT+/* wgsl */ `
const SEA_POSE_VEC4S:u32=${ANIMAL_POSE_VEC4S}u;
const SEA_RIG_VEC4S:u32=${ANIMAL_RIG_VEC4S}u;
const SEA_STATIONS:u32=${ANIMAL_SEA_STATIONS}u;
fn seaRigAt(model:u32,k:u32)->vec4f {return seaRig[model*SEA_RIG_VEC4S+k];}
// Station k of a spine reaching 'reach' along its bend, bent by the stroke's beat: a dolphin's flukes up and down, a
// shark's tail from side to side.
fn seaStation(model:u32,k:u32,reach:f32,beat:f32)->SkinnedJoint {
  let dolphin=model==${A.dolphin}u;
  let start=select(.15,.25,dolphin);let run=select(2.4,1.35,dolphin);let amplitude=select(.42,.24,dolphin);
  let t=f32(k)/f32(SEA_STATIONS-1u)*reach;let z=start+run*t;
  let bend=beat*amplitude*t*t;let slope=atan(beat*amplitude*2.0*t/run);
  if(dolphin){return skinnedThen(skinnedTranslate(vec3f(0.0,bend,0.0)),skinnedAbout(vec3f(0.0,0.0,z),skinnedRotX(-slope)));}
  return skinnedThen(skinnedTranslate(vec3f(bend,0.0,0.0)),skinnedAbout(vec3f(0.0,0.0,z),skinnedRotY(slope)));
}
@compute @workgroup_size(64) fn seaStandCS(@builtin(global_invocation_id) id:vec3u) {
  let idx=id.x;
  if(idx>=arrayLength(&seaRecords)||idx*${SEA_PLACE_VEC4S}u+2u>=arrayLength(&seaPlaces)){return;}
  let at=idx*SEA_POSE_VEC4S;
  let a=seaPlaces[idx*3u];let b=seaPlaces[idx*3u+1u];let c=seaPlaces[idx*3u+2u];
  if(c.x<0.0){seaRecords[idx]=ContinuumRecord(vec4f(0.0),vec4f(0.0,0.0,0.0,1.0),vec4u(CONTINUUM_GONE,at,idx,0u),vec4u(0u));return;}
  let model=u32(c.x);
  var pitch=b.x;
  if(model==${A.shark}u){
    let forward=vec2f(sin(a.w),cos(a.w))*(-4.8*.32);
    let wave=clamp(atan2(dolphinHeight(a.xz+forward)-dolphinHeight(a.xz-forward),4.8*.64),-.28,.28);
    pitch+=wave*(1.0-smoothstep(-.5,2.0,a.y));
  }
  seaRecords[idx]=ContinuumRecord(vec4f(a.x,dolphinHeight(a.xz)+a.y,a.z,b.z),skinnedTurn(a.w,pitch,b.y),
    vec4u(model|(${CONTINUUM_KIND.SKINNED}u<<CONTINUUM_KIND_SHIFT)|CONTINUUM_SEA|CONTINUUM_IMPORTANT_FLAG,at,bitcast<u32>(c.y),0u),vec4u(0u));
  let head=seaRigAt(model,2u);let count=min(u32(head.x),${ANIMAL_POSE_JOINTS}u);let slack=head.y;
  skinnedWriteHead(at,count,slack);${marine?`
  if(model==${A.whale}u){
    for(var j=0u;j<count;j++){
      let m=marineBones[j];
      skinnedWriteJoint(at,count,j,SkinnedJoint(vec4f(m[0].x,m[1].x,m[2].x,m[3].x),vec4f(m[0].y,m[1].y,m[2].y,m[3].y),vec4f(m[0].z,m[1].z,m[2].z,m[3].z)),seaRigAt(model,3u+j),slack,false);
    }
    return;
  }`:''}
  let beat=select(sin(F.reserved.w*4.2+b.w),sin(F.reserved.w*8.0+b.w),model==${A.dolphin}u);
  for(var k=0u;k<count;k++){skinnedWriteJoint(at,count,k,seaStation(model,k,head.w,beat),seaRigAt(model,3u+k),slack,false);}
}
`;
}

// The sea's material (js/wgsl/continuum-cut.js): wet skin, its colour each point's own (a far triangle's the nearest
// the bake found; a splat's its type's mean), lit through the land's shadow set; `marine`, the whale's by its own
// textures at the place each of its points carries. Seen under water too, through the water's own capture.
function seaContinuumMaterial(name,marine){
  const W=ANIMAL_TYPE.whale,M=ANIMAL_CONTINUUM_MATERIAL;
  const prelude=()=>FRAME_WGSL+ATMO_CORE_WGSL+VESSEL_LIGHTING+SHADOW_SAMPLE+SKY_RENDER_FUNCS+SEA_SKIN_WGSL+/* wgsl */ `
@group(0) @binding(0) var<uniform> F:Frame;
@group(0) @binding(1) var transLUT:texture_2d<f32>;
@group(0) @binding(2) var skyLUT:texture_2d<f32>;
@group(0) @binding(3) var sampC:sampler;
@group(0) @binding(4) var envCube:texture_cube<f32>;
@group(0) @binding(5) var<storage,read> sunVis:array<f32,4>;
${marine?`@group(0) @binding(7) var marineSampler:sampler;
@group(0) @binding(12) var marineColor:texture_2d<f32>;
@group(0) @binding(13) var marineNormal:texture_2d<f32>;
@group(0) @binding(14) var marineRoughness:texture_2d<f32>;`:''}
`;
  const wgsl=()=>/* wgsl */ `
fn ${name}Varying(s:ContinuumSurface,v:ptr<function,ContinuumVarying>) {
  (*v).uv=vec2f(0.5);(*v).look=0u;
  if(s.what==CONTINUUM_SPLAT_ENTRY){
    // A dome over the outline: its corners lean out, its middle faces the eye.
    let toward=s.normal;
    let lift=continuumQuat(s.record.turn,vec3f(0.0,1.0,0.0));
    let up=normalize(lift-toward*dot(lift,toward)+vec3f(0.0,1e-4,0.0));
    let right=normalize(cross(up,toward));
    let corner=s.corner*0.5;
    (*v).normal=normalize(right*(corner.x*.55)+up*(corner.y*.65)+toward*.2828);
    (*v).albedo=max(vec3f(continuumTypeF(s.model,${M.colour}u),continuumTypeF(s.model,${M.colour + 1}u),continuumTypeF(s.model,${M.colour + 2}u)),vec3f(0.0));${marine?`
    if(s.model==${W}u){(*v).albedo*=textureSampleLevel(marineColor,marineSampler,vec2f(.5),16.0).rgb;}`:''}
    return;
  }
  (*v).albedo=vec3f(f32((s.word>>16u)&255u),f32((s.word>>8u)&255u),f32(s.word&255u))/255.0;${marine?`
  if(s.model==${W}u){(*v).uv=continuumUV(s.vertex);(*v).look=1u;}`:''}
}
fn ${name}Shade(v:ContinuumVarying,front:bool)->vec4f {
  var n=normalize(v.normal);var albedo=v.albedo;var rough=.32;${marine?`
  // The whale's own skin, its colour, relief and roughness, read in uniform control flow.
  let base=textureSample(marineColor,marineSampler,v.uv).rgb;
  let map=textureSample(marineNormal,marineSampler,v.uv).xyz*2.0-1.0;
  let gloss=textureSample(marineRoughness,marineSampler,v.uv).g;
  let dx=dpdx(v.world);let dy=dpdy(v.world);let du=dpdx(v.uv);let dv=dpdy(v.uv);
  let determinant=du.x*dv.y-du.y*dv.x;
  if(v.look==1u){
    albedo*=base;rough=clamp(gloss,.22,.9);
    if(abs(determinant)>1e-9){
      let t=normalize((dx*dv.y-dy*du.y)/determinant);let b=normalize((dy*du.x-dx*dv.x)/determinant);
      n=normalize(t*map.x+b*map.y+n*map.z);
    }
  }`:''}
  return vec4f(continuumAir(seaSkinRadiance(v.world,n,albedo,rough,vesselShadow(v.world,n)),v.world),1.0);
}
`;
  return Object.freeze({
    name,prelude,core:false,data:Object.freeze({group:2,binding:0}),
    varyings:[['albedo','vec3f'],['uv','vec2f'],['look','u32',true]],wgsl,salt:13,
    // Open fins and flukes are lit from whichever side is seen.
    cullMode:'none',air:true,capture:true,
  });
}
export const DOLPHIN_CONTINUUM_MATERIAL_SPEC=seaContinuumMaterial('dolphinContinuum',false);
export const MARINE_CONTINUUM_MATERIAL_SPEC=seaContinuumMaterial('marineContinuum',true);


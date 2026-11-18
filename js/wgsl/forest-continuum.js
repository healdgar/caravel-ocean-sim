// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The forest in the one continuum's pipeline family (js/wgsl/continuum-cut.js): its material and the pass that stands
// its trees. Their cut, their shadow and their atlas are the one cut's, and their points are carried by their bones
// through the WIND kind (js/wgsl/continuum-wind.js); this is where a tree stands each frame, how its bones are stepped
// and how its bark and leaves are worn.
//   stand     one thread a root (js/forest-scenery.js keeps them, struck where a ball lands): each tree in view or in
//             the shadow map's box is written as a record of the one format, in the order it is found, with its
//             skeletons (its wind lane's and its own, claimed when it is near or pushed) and what shot has done to it
//             (felled at its break, or wounded) as its pose, and the select's workgroups are written for an indirect
//             dispatch.
//   wind      each type's skeleton for every lane of the wind, and the trees' own, stepped as damped springs: the
//             wind's pressure on every bone, and on an own one the blasts', the falls', passing shot's and hulls' and a
//             walker's.
//   material  bark and leaves as the pack's own maps wear them, lit by the land's finish. A leaf card cuts its shape by
//             the sample mask alone (rule 2): each sample of a pixel is kept by the card's coverage there, its pattern
//             seeded by the card. The far body and the splat are lit as the crown of leaves they stand for.
import { FRAME_WGSL } from './common.js';
import { SHADOW_FRAME } from './shadows.js';
import { CONTINUUM_RECORD_WGSL, CONTINUUM_ROW } from './continuum-cut.js';
import { CONTINUUM_WIND_FORM, CONTINUUM_WIND_POSE, CONTINUUM_WIND_BONES, CONTINUUM_WIND_SKELETON, CONTINUUM_WIND_FLUTTER } from './continuum-wind.js';
import { CONTINUUM_HEADER, CONTINUUM_TYPE, CONTINUUM_TYPE_WORDS, CONTINUUM_KIND, CONTINUUM_KIND_SHIFT, CONTINUUM_STRUCK } from '../continuum-format.js';
import { continuumGroundWGSL } from '../continuum-ground.js';
import { FOREST_CONTINUUM_MATERIAL, FOREST_CONTINUUM_UNTEXTURED } from '../forest-continuum.js';
import { FOREST_FALL_BEARINGS, FOREST_FALL_HEIGHT_STEPS, FOREST_FALL_REST_MIN_DEG, FOREST_FALL_SECONDS, FOREST_WOUND_BEARINGS } from '../forest-trunks.js';

// Where the scene's data binds in a forest view: group 2, past the land's own group 2 bindings. Its maps and their
// optics are group 3.
export const FOREST_CONTINUUM_DATA = Object.freeze({ group: 2, binding: 40 });
// The stand pass's uniform: [roots in use, records it may write, 1 if shadows are cast, where the trees' poses begin
// in the pose buffer (past the skeletons)], then the world's offset [x, 0, z, 0] (the roots stand in the scene's frame).
export const FOREST_CONTINUUM_STAND_BYTES = 32;
// The stand pass's own buffer: the select's workgroups (x, y, z), then how many records it wrote.
export const FOREST_CONTINUUM_STOOD_BYTES = 16;

// ---------------------------------------------------------------------------------------------- the wind
// A tree bends by its skeleton (js/wgsl/continuum-wind.js), each bone a damped spring the wind's pressure drives. Every
// type steps one skeleton for each of the lanes the wind may blow along it (FOREST_WIND_BEARINGS bearings in its own
// frame, two phases), and a tree takes its lane's; a tree near the eye, or in reach of a blast, a passing ball or hull,
// a falling tree or a walker, steps one of its own (FOREST_WIND_OWN at once), started from its lane's so it takes over
// without a jump, driven by those too, and handed back over FOREST_WIND_GRACE_S once nothing touches it.
export const FOREST_WIND_BEARINGS = 8;
export const FOREST_WIND_LANES = FOREST_WIND_BEARINGS * 2;
export const FOREST_WIND_OWN = 256;
export const FOREST_WIND_FORCES = 16;
export const FOREST_WIND_CAPSULES = 16;
export const FOREST_WIND_NEAR_M = 48;
export const FOREST_WIND_GRACE_S = 3;
// The skeletons a pack of `types` steps, at the head of the forest's pose buffer: its lanes', then the trees' own.
export const forestWindSkeletons = (types) => types * FOREST_WIND_LANES + FOREST_WIND_OWN;
// Where force or capsule k lies in the wind's uniform, in floats.
export const FOREST_WIND_FORCE_AT = (k) => 8 + k * 16;
export const FOREST_WIND_CAPSULE_AT = (k) => 8 + FOREST_WIND_FORCES * 16 + k * 12;
// The wind's uniform: [forces, capsules, types, 0], [how hard the wind blows the trees (1 as measured), 0, 0, 0], then
// each force [x, y, z, radius], [direction, pressure (Pa)], [the frame time it began, its wave's speed or its length,
// its lobe toward its direction or its swirl's core, the cosine of its cone], [basis, event, 0, 0] and each capsule
// [a, radius], [b, push at its axis (N)], [falloff power, 0, the frame time it began, how long it lasts (0: while
// set)], in the scene's frame. Bases: FOREST_WIND_BASIS; events: FOREST_WIND_EVENT.
export const FOREST_WIND_BYTES = 32 + FOREST_WIND_FORCES * 64 + FOREST_WIND_CAPSULES * 48;
export const FOREST_WIND_BASIS = Object.freeze({ RADIAL: 0, DIRECTIONAL: 1, SWIRL: 2, CONE: 3 });
export const FOREST_WIND_EVENT = Object.freeze({ CONTINUOUS: 0, FRIEDLANDER: 1, PULSE: 2, BURST: 3 });
// The wind's state: [the frame time stepped, the wind's direction smoothed (x, z), its speed smoothed], [the step, 1
// once begun, the wind's velocity smoothed (x, z)], one vec4f each own skeleton's [its tree, when last touched, its
// share, 0], then [turn, 0] and [turning rate, 0] a bone of every skeleton.
const FOREST_WIND_STATE_BONES = 2 + FOREST_WIND_OWN;
export const forestWindStateBytes = (types) => (FOREST_WIND_STATE_BONES + forestWindSkeletons(types) * CONTINUUM_WIND_BONES * 2) * 16;

const forestWindCommonWGSL = () => /* wgsl */`
struct ForestRoot {rootScale:vec4f,yawColour:vec4f,identity:vec4f};
struct ForestWindForce {at:vec4f,toward:vec4f,timing:vec4f,kind:vec4f};
struct ForestWindCapsule {a:vec4f,b:vec4f,shape:vec4f};
struct ForestWind {counts:vec4u,tuning:vec4f,forces:array<ForestWindForce,${FOREST_WIND_FORCES}>,capsules:array<ForestWindCapsule,${FOREST_WIND_CAPSULES}>};
const FOREST_WIND_BONES:u32=${CONTINUUM_WIND_BONES}u;
const FOREST_WIND_SKELETON:u32=${CONTINUUM_WIND_SKELETON}u;
fn forestWindHash(value:u32)->u32{var x=value;x=(x^(x>>16u))*0x7feb352du;x=(x^(x>>15u))*0x846ca68bu;return x^(x>>16u);}
// The lane a tree stands in: the bearing, in its own frame, of the wind smoothed, and one of two phases by its hash.
fn forestWindLane(yaw:f32,downwind:vec2f,tree:u32)->u32{
 let c=cos(yaw);let s=sin(yaw);let w=vec2f(c*downwind.x+s*downwind.y,-s*downwind.x+c*downwind.y);
 let bearing=min(u32(floor(fract(atan2(w.y,w.x)*0.15915494+${(1 + 0.5 / FOREST_WIND_BEARINGS).toFixed(4)})*${FOREST_WIND_BEARINGS}.0)),${FOREST_WIND_BEARINGS - 1}u);
 return bearing*2u+(forestWindHash(tree^0x6c8e9cf5u)&1u);
}
// Whether a force or a capsule reaches a point now.
fn forestWindTouched(at:vec3f)->bool{
 for(var k=0u;k<min(forestWind.counts.x,${FOREST_WIND_FORCES}u);k++){let f=forestWind.forces[k];if(distance(at,f.at.xyz)<f.at.w*1.35+8.0){return true;}}
 for(var k=0u;k<min(forestWind.counts.y,${FOREST_WIND_CAPSULES}u);k++){let c=forestWind.capsules[k];if(distance(at,0.5*(c.a.xyz+c.b.xyz))<c.a.w+0.5*distance(c.a.xyz,c.b.xyz)+6.0){return true;}}
 return false;
}
`;

// ---------------------------------------------------------------------------------------------- the stand pass
export function forestContinuumStandWGSL() {
  const F = CONTINUUM_WIND_FORM, T = CONTINUUM_TYPE;
  return FRAME_WGSL + SHADOW_FRAME + CONTINUUM_RECORD_WGSL + continuumGroundWGSL(0, 8) + forestWindCommonWGSL() + /* wgsl */`
struct ForestStand {counts:vec4u,shift:vec4f};
@group(0)@binding(0)var<uniform>F:Frame;
@group(0)@binding(1)var<uniform>SH:ShadowFrame;
@group(0)@binding(2)var<storage,read>forestRoots:array<ForestRoot>;
@group(0)@binding(3)var<storage,read>forestAtlas:array<u32>;
@group(0)@binding(4)var<storage,read_write>forestRecords:array<ContinuumRecord>;
@group(0)@binding(5)var<storage,read_write>forestPoses:array<vec4f>;
@group(0)@binding(6)var<storage,read_write>forestStood:array<atomic<u32>,4>;
@group(0)@binding(7)var<uniform>forestStand:ForestStand;
@group(0)@binding(9)var<uniform>forestWind:ForestWind;
@group(0)@binding(10)var<storage,read_write>forestWindState:array<vec4f>;
@group(0)@binding(11)var<storage,read_write>forestWindOwners:array<atomic<u32>,${FOREST_WIND_OWN}>;
fn forestStandTypeF(model:u32,field:u32)->f32{return bitcast<f32>(forestAtlas[forestAtlas[${CONTINUUM_HEADER.typesAt}u]+model*${CONTINUUM_TYPE_WORDS}u+field]);}
// A tree's yaw turns its type's +x toward (cos, 0, sin) of it.
fn forestStandTurn(yaw:f32,v:vec3f)->vec3f{let c=cos(yaw);let s=sin(yaw);return vec3f(c*v.x-s*v.z,v.y,s*v.x+c*v.z);}
fn forestStandOutside(relative:vec3f,reach:f32)->bool{
 let m=F.viewProj;let p=vec4f(relative,1.0);
 let w=vec4f(m[0].w,m[1].w,m[2].w,m[3].w);let x=vec4f(m[0].x,m[1].x,m[2].x,m[3].x);let y=vec4f(m[0].y,m[1].y,m[2].y,m[3].y);
 let planes=array<vec4f,5>(w+x,w-x,w+y,w-y,w);
 for(var i=0u;i<5u;i++){if(dot(planes[i],p)< -reach*length(planes[i].xyz)){return true;}}
 return false;
}
fn forestStandShadowed(world:vec3f,reach:f32)->bool{
 let light=SH.lightView*vec4f(world-SH.origin.xyz,1.0);
 let r=reach*vec3f(length(vec3f(SH.lightView[0].x,SH.lightView[1].x,SH.lightView[2].x)),length(vec3f(SH.lightView[0].y,SH.lightView[1].y,SH.lightView[2].y)),length(vec3f(SH.lightView[0].z,SH.lightView[1].z,SH.lightView[2].z)));
 return abs(light.x)<1.0+r.x&&abs(light.y)<1.0+r.y&&light.z> -r.z&&light.z<1.0+r.z;
}
// How far a skeleton's bones can carry any point of a type's sphere (continuumWindReach).
fn forestStandReach(skeleton:u32,sphere:vec4f)->f32{let h=forestPoses[skeleton];return h.x+h.y*(length(sphere.xyz)+sphere.w+h.z);}
// The skeleton a tree steps of its own and its share, if it has one: kept while it is near the eye or touched, and
// claimed (one of twelve slots its index probes) when it is first, started from its lane's.
fn forestStandOwn(tree:u32,touched:bool,near:f32,lane:u32)->vec2f{
 let start=(tree*2654435761u)&${FOREST_WIND_OWN - 1}u;let stride=(((tree>>8u)*2u+1u)&${FOREST_WIND_OWN - 1}u);
 var slot=-1;
 for(var k=0u;k<12u;k++){let at=(start+k*stride)&${FOREST_WIND_OWN - 1}u;if(atomicLoad(&forestWindOwners[at])==tree+1u){slot=i32(at);break;}}
 let now=forestWindState[0].x;
 if(slot<0&&touched){
  for(var k=0u;k<12u;k++){
   let at=(start+k*stride)&${FOREST_WIND_OWN - 1}u;
   if(atomicCompareExchangeWeak(&forestWindOwners[at],0u,tree+1u).exchanged){
    slot=i32(at);
    let source=${FOREST_WIND_STATE_BONES}u+lane*FOREST_WIND_BONES*2u;let into=${FOREST_WIND_STATE_BONES}u+(forestWind.counts.z*${FOREST_WIND_LANES}u+at)*FOREST_WIND_BONES*2u;
    for(var b=0u;b<FOREST_WIND_BONES*2u;b++){forestWindState[into+b]=forestWindState[source+b];}
    forestWindState[2u+at]=vec4f(f32(tree),now,1.0,0.0);
    break;
   }
  }
 }else if(slot>=0&&touched){
  var own=forestWindState[2u+u32(slot)];
  own.y=now;own.z=max(own.z,max(1.0-smoothstep(${(FOREST_WIND_NEAR_M * 0.78).toFixed(1)},${FOREST_WIND_NEAR_M.toFixed(1)},near),0.85));
  forestWindState[2u+u32(slot)]=own;
 }
 if(slot<0){return vec2f(-1.0,0.0);}
 return vec2f(f32(slot),clamp(forestWindState[2u+u32(slot)].z,0.0,1.0));
}
@compute @workgroup_size(1)fn forestStandReset(){atomicStore(&forestStood[3],0u);}
@compute @workgroup_size(64)fn forestStandRoots(@builtin(global_invocation_id)id:vec3u,@builtin(num_workgroups)groups:vec3u){
 let i=id.x+id.y*groups.x*64u;
 if(i>=forestStand.counts.x){return;}
 let r=forestRoots[i];let scale=r.rootScale.w;
 if(!(scale>0.0)){return;}
 let model=u32(r.identity.x);let yaw=r.yawColour.x;
 // Where it stands as drawn: on the ground the land draws there (js/continuum-ground.js). It is struck, felled and
 // blown over where it truly stands (js/forest-trunks.js on the CPU).
 let shift=forestStand.shift.xyz;
 let position=r.rootScale.xyz+vec3f(0.0,continuumGroundLift(r.rootScale.xz+shift.xz),0.0);
 let sphere=vec4f(forestStandTypeF(model,${T.sphere}u),forestStandTypeF(model,${T.sphere + 1}u),forestStandTypeF(model,${T.sphere + 2}u),forestStandTypeF(model,${T.sphere + 3}u));
 let felled=r.identity.w<0.0;let wounded=r.identity.w>0.0;let t=F.camPos.w;
 // Its skeleton: its lane's, and its own when near the eye or touched; a tree on the ground is still.
 var bones=vec3f(-1.0,-1.0,0.0);var sway=0.0;
 if(!felled&&forestWind.counts.z>model){
  let lane=model*${FOREST_WIND_LANES}u+forestWindLane(yaw,forestWindState[0].yz,i);
  bones.x=f32(lane*FOREST_WIND_SKELETON);
  sway=forestStandReach(lane*FOREST_WIND_SKELETON,sphere);
  let near=distance(position+shift,F.camPos.xyz);
  let touched=near<${FOREST_WIND_NEAR_M.toFixed(1)}||forestWindTouched(r.rootScale.xyz);
  if(touched||near<${(FOREST_WIND_NEAR_M * 1.5).toFixed(1)}){
   let own=forestStandOwn(i,touched,near,lane);
   if(own.x>=0.0){
    let skeleton=(forestWind.counts.z*${FOREST_WIND_LANES}u+u32(own.x))*FOREST_WIND_SKELETON;
    bones=vec3f(bones.x,f32(skeleton),own.y);
    sway=max(sway,forestStandReach(skeleton,sphere));
   }
  }
 }
 // A tree felled lies within its own height of where it stood: its record's reach takes it in.
 let reach=select(0.0,sphere.w*scale,felled);
 let radius=(sphere.w+sway*1.25+${(CONTINUUM_WIND_FLUTTER * 2).toFixed(3)})*scale+reach;
 let centre=position+forestStandTurn(yaw,sphere.xyz)*scale;
 let relative=centre+shift-F.camPos.xyz;
 if(forestStandOutside(earthCurve(relative,F.camPos.y),radius)&&!(forestStand.counts.z!=0u&&forestStandShadowed(centre,radius))){return;}
 let slot=atomicAdd(&forestStood[3],1u);
 if(slot>=forestStand.counts.y){return;}
 // What shot has done to it (js/forest-trunks.js): felled at the height it broke, falling toward its bearing over
 // ${FOREST_FALL_SECONDS} s; or wounded, the ball's side gouged. Bearings are turned into its type's own frame.
 var form=${F.STANDING}u;var held=vec4f(0.0);
 if(felled){
  let code=u32(r.identity.y);
  let rest=(${FOREST_FALL_REST_MIN_DEG}.0+f32(code>>18u))*.01745329;var angle=rest;
  let age=t+r.identity.w;
  if(r.identity.w>-1e8&&age>=0.0){let e=min(age/${FOREST_FALL_SECONDS.toFixed(4)},1.0);angle=rest*e*e;}
  form=${F.FELLED}u;
  held=vec4f(f32(code&2047u)/${FOREST_FALL_HEIGHT_STEPS}.0,f32((code>>11u)&${FOREST_FALL_BEARINGS - 1}u)/${FOREST_FALL_BEARINGS}.0*6.2831853-yaw,angle,0.0);
 }else if(wounded){
  let code=u32(r.identity.w);
  form=${F.WOUNDED}u;
  held=vec4f(f32(code&2047u)/${FOREST_FALL_HEIGHT_STEPS}.0,f32((code>>11u)&${FOREST_WOUND_BEARINGS - 1}u)/${FOREST_WOUND_BEARINGS}.0*6.2831853-yaw,f32(code>>17u)/127.0,0.0);
 }
 let pose=forestStand.counts.w+slot*${CONTINUUM_WIND_POSE}u;
 forestPoses[pose]=vec4f(bones,f32(form));
 forestPoses[pose+1u]=held;
 forestPoses[pose+2u]=vec4f(0.0);
 // Its seed is where it stands, so its sample pattern and its thinning are its own however the trees are listed.
 let seed=forestWindHash(bitcast<u32>(r.rootScale.x)^forestWindHash(bitcast<u32>(r.rootScale.z)));
 let half=yaw*0.5;
 let tag=model|(${CONTINUUM_KIND.WIND}u<<${CONTINUUM_KIND_SHIFT}u)|select(0u,${CONTINUUM_STRUCK >>> 0}u,felled||wounded);
 forestRecords[slot]=ContinuumRecord(vec4f(position,scale),vec4f(0.0,-sin(half),0.0,cos(half)),vec4u(tag,pose,seed,bitcast<u32>(reach)),vec4u(pack4x8unorm(vec4f(r.yawColour.yzw*0.5,0.0)),0u,0u,0u));
}
// The select's workgroups for the records written, ${CONTINUUM_ROW} a row; every record of the last row past them gone.
@compute @workgroup_size(64)fn forestStandFinish(@builtin(global_invocation_id)id:vec3u){
 let n=min(atomicLoad(&forestStood[3]),forestStand.counts.y);
 let across=min(n,${CONTINUUM_ROW}u);let rows=(n+${CONTINUUM_ROW - 1}u)/${CONTINUUM_ROW}u;
 if(id.x==0u){atomicStore(&forestStood[0],across);atomicStore(&forestStood[1],rows);atomicStore(&forestStood[2],1u);}
 let tail=n+id.x;
 if(tail<across*rows&&tail<forestStand.counts.y){forestRecords[tail].tag.x=CONTINUUM_GONE;}
}
`;
}

// ---------------------------------------------------------------------------------------------- the leaves' maps
// The pack's maps and their optics, in `group` (the view's 3, its shadow's 2), and what a leaf card's cut reads of them.
const forestLeafMapsWGSL = (group) => /* wgsl */`
struct ForestLeafMaterial {optics:vec4f,underside:vec4f,coordinates:vec4f};
@group(${group})@binding(0)var forestNativeAlbedo0:texture_2d_array<f32>;
@group(${group})@binding(1)var forestNativeNormal0:texture_2d_array<f32>;
@group(${group})@binding(2)var forestNativeAlbedo1:texture_2d_array<f32>;
@group(${group})@binding(3)var forestNativeNormal1:texture_2d_array<f32>;
@group(${group})@binding(4)var forestNativeAlbedo2:texture_2d_array<f32>;
@group(${group})@binding(5)var forestNativeNormal2:texture_2d_array<f32>;
@group(${group})@binding(6)var forestNativeAlbedo3:texture_2d_array<f32>;
@group(${group})@binding(7)var forestNativeNormal3:texture_2d_array<f32>;
@group(${group})@binding(8)var forestNativeSampler:sampler;
@group(${group})@binding(9)var forestNativeRepeatSampler:sampler;
@group(${group})@binding(10)var<storage,read>forestNativeMaterials:array<ForestLeafMaterial>;
const FOREST_UNTEXTURED:u32=0xffffu;
fn forestNativeAlbedoOnly(material:ForestLeafMaterial,uv:vec2f,ux:vec2f,uy:vec2f)->vec4f{
 let family=u32(material.coordinates.x);let layer=i32(material.coordinates.y);
 if(family==0u){return textureSampleGrad(forestNativeAlbedo0,forestNativeSampler,uv,layer,ux,uy);}
 if(family==1u){return textureSampleGrad(forestNativeAlbedo1,forestNativeSampler,uv,layer,ux,uy);}
 if(family==2u){return textureSampleGrad(forestNativeAlbedo2,forestNativeSampler,uv,layer,ux,uy);}
 return textureSampleGrad(forestNativeAlbedo3,forestNativeSampler,uv,layer,ux,uy);
}
// The samples of a pixel a leaf card covers: its coverage times the samples, rounded by a hash of the card and the
// pixel and rotated by it, so cards seen through one another keep independent footprints.
fn forestLeafSampleMask(alpha:f32,seed:u32,pixel:vec2f,samples:u32)->u32{
 let n=clamp(samples,1u,8u);let p=vec2u(pixel);
 let random=continuumHash(seed^continuumHash(p.x)^continuumHash(p.y*0x9e3779b9u));
 let coverage=clamp(alpha,0.,1.)*f32(n);let whole=u32(floor(coverage));
 let count=min(n,whole+select(0u,1u,fract(coverage)>f32(random&65535u)/65536.));
 let bits=(1u<<count)-1u;let rotation=(random>>16u)%n;
 return ((bits<<rotation)|(bits>>(n-rotation)))&((1u<<n)-1u);
}
`;

// ---------------------------------------------------------------------------------------------- the wind's step
// Three passes about the stand: the head before it (the clock, the wind smoothed, each own skeleton aged and let go
// once untouched for FOREST_WIND_GRACE_S), then after it every lane's skeleton and every own one stepped, and their
// bones' turns written into the pose buffer for the WIND kind to carry the trees' points by.
export function forestWindStepWGSL() {
  const B = FOREST_WIND_BASIS, E = FOREST_WIND_EVENT;
  return FRAME_WGSL + forestWindCommonWGSL() + /* wgsl */`
@group(0)@binding(0)var<uniform>F:Frame;
@group(0)@binding(1)var<uniform>forestWind:ForestWind;
@group(0)@binding(2)var<storage,read>forestRoots:array<ForestRoot>;
@group(0)@binding(3)var<storage,read>forestWindRest:array<vec4f>;
@group(0)@binding(4)var<storage,read_write>forestWindState:array<vec4f>;
@group(0)@binding(5)var<storage,read_write>forestPoses:array<vec4f>;
@group(0)@binding(6)var<storage,read_write>forestWindOwners:array<atomic<u32>,${FOREST_WIND_OWN}>;
fn forestWindFinite(v:vec3f)->bool{return all(v==v)&&all((bitcast<vec3u>(v)&vec3u(0x7fffffffu))<vec3u(0x7f800000u))&&dot(v,v)<1e4;}
fn forestWindTurn(v:vec3f)->vec4f{let a=length(v);if(a<1e-6){return vec4f(v*0.5,1.0);}return vec4f(v*(sin(a*0.5)/a),cos(a*0.5));}
fn forestWindCompose(a:vec4f,b:vec4f)->vec4f{return vec4f(a.w*b.xyz+b.w*a.xyz+cross(a.xyz,b.xyz),a.w*b.w-dot(a.xyz,b.xyz));}
fn forestWindRotate(q:vec4f,v:vec3f)->vec3f{let t=2.0*cross(q.xyz,v);return v+q.w*t+cross(q.xyz,t);}
// The pressure (Pa, as a vector) a force puts on a point now: a blast's wave running out from it and sucking back, a
// pulse or a burst, or a steady push; outward, along its direction, swirling, or in a cone.
fn forestWindForceAt(f:ForestWindForce,at:vec3f,now:f32)->vec3f{
 let rel=at-f.at.xyz;let d=length(rel);let radius=max(f.at.w,0.25);let event=u32(f.kind.y+0.5);let elapsed=now-f.timing.x;
 var pressure=f.toward.w;
 if(event==${E.FRIEDLANDER}u){
  let speed=max(f.timing.y,15.0);
  if(elapsed<0.0||d>radius*1.35){return vec3f(0.0);}
  let tau=max(0.09,radius/(speed*1.6));let lt=(elapsed-d/speed)/tau;
  if(lt< -0.15||lt>4.5){return vec3f(0.0);}
  let near=clamp(1.0-d/(radius*1.35),0.0,1.0);
  pressure*=select((1.0-lt)*exp(-lt),exp(lt*14.0),lt<0.0)*(0.35+0.65*near*near);
 }else if(event==${E.PULSE}u||event==${E.BURST}u){
  let lasts=max(f.timing.y,0.18);
  if(elapsed<0.0||elapsed>lasts||d>radius){return vec3f(0.0);}
  let u=elapsed/lasts;let near=clamp(1.0-d/radius,0.0,1.0);
  pressure*=select(sin(u*3.14159265),exp(-u*3.2)*(1.0-exp(-u*18.0)),event==${E.BURST}u)*near*near;
 }else{
  if(d>radius){return vec3f(0.0);}
  let near=clamp(1.0-d/radius,0.0,1.0);pressure*=near*near;
 }
 let basis=u32(f.kind.x+0.5);
 let out=select(vec3f(1.0,0.0,0.0),rel/max(d,1e-4),d>1e-4);
 let ahead=normalize(select(vec3f(1.0,0.0,0.0),f.toward.xyz,length(f.toward.xyz)>1e-4));
 if(basis==${B.RADIAL}u){return normalize(mix(out,ahead,clamp(f.timing.z,0.0,1.0)*0.65))*pressure;}
 if(basis==${B.DIRECTIONAL}u){return ahead*pressure;}
 if(basis==${B.SWIRL}u){
  let around=normalize(select(vec3f(-out.z,0.0,out.x),cross(vec3f(0.0,1.0,0.0),out),length(out.xz)>1e-4));
  let core=max(f.timing.z,0.5);
  return (around*0.88+out*0.22)*(pressure*min(d/core,core/max(d,0.25)));
 }
 let c=dot(out,ahead);
 if(c<f.timing.w){return vec3f(0.0);}
 return out*(pressure*clamp((c-f.timing.w)/max(1.0-f.timing.w,1e-3),0.0,1.0));
}
// The push (N) a capsule puts on a point within it: away from its axis, harder the deeper.
fn forestWindCapsuleAt(c:ForestWindCapsule,at:vec3f,now:f32)->vec3f{
 if(c.shape.w>0.0&&(now<c.shape.z||now>c.shape.z+c.shape.w)){return vec3f(0.0);}
 let ab=c.b.xyz-c.a.xyz;let ab2=dot(ab,ab);
 let t=select(0.0,clamp(dot(at-c.a.xyz,ab)/ab2,0.0,1.0),ab2>1e-6);
 let away=at-(c.a.xyz+ab*t);let d=length(away);let radius=max(c.a.w,0.1);
 if(d>=radius){return vec3f(0.0);}
 return select(vec3f(0.0,1.0,0.0),away/max(d,1e-4),d>1e-4)*(c.b.w*pow(1.0-d/radius,max(c.shape.x,0.5)));
}
@compute @workgroup_size(1)fn forestWindHead(){
 let now=F.camPos.w;let first=forestWindState[1].y==0.0;
 let dt=select(clamp(now-forestWindState[0].x,0.0,0.05),0.016,first||now<forestWindState[0].x);
 let raw=F.windP[0].xy;let dir=select(vec2f(1.0,0.0),raw/max(length(raw),1e-5),length(raw)>1e-4);
 var was=forestWindState[1].zw;if(!forestWindFinite(vec3f(was,0.0))){was=vec2f(0.0);}
 var want=dir*F.windP[0].z;if(!forestWindFinite(vec3f(want,0.0))){want=vec2f(0.0);}
 let blown=mix(was,want,select(1.0-exp(-dt*2.5),1.0,first));let speed=length(blown);
 forestWindState[0]=vec4f(now,select(dir,blown/max(speed,1e-5),speed>1e-4),speed*forestWind.tuning.x);
 forestWindState[1]=vec4f(dt,select(2.0,1.0,first),blown);
 for(var s=0u;s<${FOREST_WIND_OWN}u;s++){
  if(atomicLoad(&forestWindOwners[s])==0u){continue;}
  var own=forestWindState[2u+s];
  if(now<own.y){own.y=now;}
  let age=now-own.y;
  if(age>${FOREST_WIND_GRACE_S.toFixed(2)}){atomicStore(&forestWindOwners[s],0u);own=vec4f(-1.0,0.0,0.0,0.0);}
  else{own.z=min(own.z+dt*3.5,1.0)*(1.0-smoothstep(${(FOREST_WIND_GRACE_S * 0.35).toFixed(2)},${FOREST_WIND_GRACE_S.toFixed(2)},age));}
  forestWindState[2u+s]=own;
 }
}
// One skeleton stepped: each bone's turn a damped spring under the moment the wind's pressure on what it carries puts
// about its pivot (and, for a tree's own, every force's and capsule's where that pressure acts), its twist stiffer
// than its bend, its bend saturating at its largest; its branches shedding eddies flutter; each bone's turn carried
// by its parent's. Written as the WIND kind reads it, with how far any point can go.
fn forestWindStep(skeleton:u32,model:u32,toward:vec3f,speed:f32,gust:f32,phase:f32,own:bool,tree:ForestRoot){
 let now=forestWindState[0].x;let dt=clamp(forestWindState[1].x,0.0,0.05);let begin=forestWindState[1].y<1.5;let half=dt*0.5;
 let blown=speed*gust;let pressure=0.6125*blown*blown;
 let ramp=clamp((blown-3.0)/17.0,0.0,1.0);let alive=smoothstep(0.08,1.4,blown);
 var turned:array<vec4f,${CONTINUUM_WIND_BONES}>;var moved:array<vec3f,${CONTINUUM_WIND_BONES}>;
 let c=cos(tree.yawColour.x);let s=sin(tree.yawColour.x);let scale=max(tree.rootScale.w,0.25);
 let out=skeleton*FOREST_WIND_SKELETON;
 var reach=vec3f(0.0);
 for(var b=0u;b<FOREST_WIND_BONES;b++){
  let rest=(model*FOREST_WIND_BONES+b)*4u;
  let pivot=forestWindRest[rest];let axis=forestWindRest[rest+1u];let aero=forestWindRest[rest+2u];let spring=forestWindRest[rest+3u];
  let bone=u32(pivot.w+0.5);
  if(((bone>>8u)&1u)==0u){turned[b]=vec4f(0.0,0.0,0.0,1.0);moved[b]=vec3f(0.0);forestPoses[out+1u+b*2u]=vec4f(0.0,0.0,0.0,1.0);forestPoses[out+2u+b*2u]=vec4f(0.0);continue;}
  let parent=i32(bone&63u)-1;let group=(bone>>6u)&3u;
  let at=${FOREST_WIND_STATE_BONES}u+(skeleton*FOREST_WIND_BONES+b)*2u;
  var angle=forestWindState[at].xyz;var rate=forestWindState[at+1u].xyz;
  if(!forestWindFinite(angle)||!forestWindFinite(rate*0.01)){angle=vec3f(0.0);rate=vec3f(0.0);}
  let stiffness=max(spring.x,1.0);let omega=clamp(spring.y,0.8,18.0);let damping=clamp(spring.z,0.1,0.85);let most=max(spring.w,0.02);
  // Eddies vary the flow from bone to bone by where it lies, so neighbouring branches sway together without tearing.
  let p=phase+dot(pivot.xyz,vec3f(0.32,0.21,0.29));
  let eddy=1.0+0.26*sin(now*(0.85+0.18*omega)+p)+0.14*cos(now*(1.65+0.25*omega)-p*1.3);
  let side=vec3f(-toward.z,0.12*sin(now*1.4+p),toward.x)*(0.2*sin(now*(1.25+0.22*omega)+p*1.7));
  var force=normalize(toward*eddy+side+vec3f(0.0,-0.06*blown/14.0,0.0))*(pressure*aero.w);
  if(own){
   // Where the wind presses it, in the scene's frame; what pushes there turned into the tree's.
   let press=pivot.xyz+aero.xyz*0.65;
   let world=tree.rootScale.xyz+vec3f(c*press.x-s*press.z,press.y,s*press.x+c*press.z)*scale;
   var push=vec3f(0.0);
   for(var k=0u;k<min(forestWind.counts.x,${FOREST_WIND_FORCES}u);k++){push+=forestWindForceAt(forestWind.forces[k],world,now)*aero.w;}
   for(var k=0u;k<min(forestWind.counts.y,${FOREST_WIND_CAPSULES}u);k++){push+=forestWindCapsuleAt(forestWind.capsules[k],world,now);}
   force+=vec3f(c*push.x+s*push.z,push.y,-s*push.x+c*push.z);
  }
  let torque=cross(aero.xyz,force);
  if(begin){
   // At first, leaning as the wind holds it, still.
   var lean=torque/stiffness;lean-=axis.xyz*(dot(lean,axis.xyz)*0.55);
   let l=length(lean);if(l>1e-5){lean*=most*tanh(l/most)/l;}
   angle=lean;rate=vec3f(0.0);
  }else if(half>0.0){
   for(var k=0u;k<2u;k++){
    let bent=angle+axis.xyz*dot(angle,axis.xyz)*1.2;
    rate+=(torque*(omega*omega/stiffness)-omega*omega*bent-2.0*damping*omega*rate)*half;
    angle+=rate*half;
    let l=length(angle);
    if(l>1e-5){
     let held=most*tanh(l/most);
     if(l>most*0.85){let d=angle/l;let outward=dot(rate,d);if(outward>0.0){rate-=d*(outward*(1.0-held/l));}}
     angle*=held/l;
    }
   }
  }
  if(!forestWindFinite(angle)||!forestWindFinite(rate*0.01)){angle=vec3f(0.0);rate=vec3f(0.0);}
  forestWindState[at]=vec4f(angle,0.0);forestWindState[at+1u]=vec4f(rate,0.0);
  var flutter=vec3f(0.0);
  if(group>=1u){
   let along=axis.w;let f=now*omega*(2.6+1.8*along)*mix(0.3,1.0,ramp)+p*2.3;
   let a=normalize(cross(axis.xyz,select(vec3f(0.0,1.0,0.0),vec3f(1.0,0.0,0.0),abs(axis.y)>0.9)));let a2=cross(axis.xyz,a);
   flutter=(a*sin(f)+a2*(0.65*cos(f*1.37+0.8)))*(alive*mix(0.24,1.0,ramp)*(0.005+0.024*along*along)*select(0.55,1.0,group==2u));
  }
  var q=forestWindTurn(angle+flutter);var pivoted=pivot.xyz;
  if(parent>=0){let up=u32(parent);pivoted=forestWindRotate(turned[up],pivot.xyz)+moved[up];q=normalize(forestWindCompose(turned[up],q));}
  turned[b]=q;moved[b]=pivoted-forestWindRotate(q,pivot.xyz);
  forestPoses[out+1u+b*2u]=q;forestPoses[out+2u+b*2u]=vec4f(moved[b],0.0);
  reach=max(reach,vec3f(distance(pivoted,pivot.xyz),2.0*length(q.xyz),length(pivot.xyz)));
 }
 forestPoses[out]=vec4f(reach,0.0);
}
@compute @workgroup_size(64)fn forestWindLanes(@builtin(global_invocation_id)id:vec3u){
 let types=forestWind.counts.z;
 if(id.x>=types*${FOREST_WIND_LANES}u){return;}
 let model=id.x/${FOREST_WIND_LANES}u;let lane=id.x%${FOREST_WIND_LANES}u;
 let angle=f32(lane/2u)/${FOREST_WIND_BEARINGS}.0*6.2831853;
 let phase=f32(lane&1u)*2.4+f32(model)*0.61;let now=forestWindState[0].x;
 var tree:ForestRoot;tree.rootScale=vec4f(0.0,0.0,0.0,1.0);tree.yawColour=vec4f(0.0);tree.identity=vec4f(0.0);
 forestWindStep(id.x,model,vec3f(cos(angle),0.0,sin(angle)),forestWindState[0].w,max(0.72+0.22*sin(now*0.62+phase)+0.12*sin(now*1.47-phase*1.3),0.15),phase,false,tree);
}
@compute @workgroup_size(64)fn forestWindOwn(@builtin(global_invocation_id)id:vec3u){
 let types=forestWind.counts.z;
 if(id.x>=${FOREST_WIND_OWN}u||types==0u){return;}
 let owner=atomicLoad(&forestWindOwners[id.x]);
 if(owner==0u){return;}
 let tree=forestRoots[owner-1u];let model=min(u32(max(tree.identity.x,0.0)),types-1u);
 let now=forestWindState[0].x;let dir=forestWindState[0].yz;let speed=forestWindState[0].w;
 let c=cos(tree.yawColour.x);let s=sin(tree.yawColour.x);
 let toward=vec3f(c*dir.x+s*dir.y,0.0,-s*dir.x+c*dir.y);
 // The gusts roll across the land at the wind's own speed.
 let front=(dot(tree.rootScale.xz,dir)-now*max(speed,2.0))*0.032;let across=dot(tree.rootScale.xz,vec2f(-dir.y,dir.x))*0.021;
 forestWindStep(types*${FOREST_WIND_LANES}u+id.x,model,normalize(select(vec3f(1.0,0.0,0.0),toward,length(toward)>1e-4)),speed,max(0.68+0.24*sin(front)+0.14*sin(front*2.35+across),0.12),tree.rootScale.x*0.13+tree.rootScale.z*0.11,true,tree);
}
`;
}

// ---------------------------------------------------------------------------------------------- the material
const forestContinuumMaterialWGSL = () => {
  const M = FOREST_CONTINUUM_MATERIAL, F = CONTINUUM_WIND_FORM;
  return /* wgsl */`
${forestLeafMapsWGSL(3)}fn forestNativeLinear(c:vec3f)->vec3f{return select(pow((c+vec3f(.055))/1.055,vec3f(2.4)),c/12.92,c<=vec3f(.04045));}
struct ForestSurface {pigment:vec4f,detail:vec4f};
// A leaf's own colour from what the maps keep, which is that colour times coverage. Where coverage nears nothing the
// two are noise over noise (block compression and rounding leave a little colour over a coverage of zero), so below
// this floor the colour fades to black instead of growing.
const FOREST_THINNEST_COVERAGE=1./32.;
fn forestOwnColour(pigment:vec4f)->vec3f{return min(pigment.rgb/max(pigment.a,FOREST_THINNEST_COVERAGE),vec3f(1));}
fn forestDetailSigned(d:vec4f)->vec4f{return vec4f(d.xyz*(255./127.)-vec3f(128./127.),d.a);}
fn forestNativePair(albedo:texture_2d_array<f32>,normal:texture_2d_array<f32>,uv:vec2f,ux:vec2f,uy:vec2f,layer:i32,repeating:bool)->ForestSurface{
 var result:ForestSurface;
 if(repeating){result.pigment=textureSampleGrad(albedo,forestNativeRepeatSampler,uv,layer,ux,uy);result.detail=textureSampleGrad(normal,forestNativeRepeatSampler,uv,layer,ux,uy);}
 else{result.pigment=textureSampleGrad(albedo,forestNativeSampler,uv,layer,ux,uy);result.detail=textureSampleGrad(normal,forestNativeSampler,uv,layer,ux,uy);}
 result.detail=forestDetailSigned(result.detail);
 return result;
}
fn forestReadNative(material:ForestLeafMaterial,uv:vec2f,ux:vec2f,uy:vec2f)->ForestSurface{
 let family=u32(material.coordinates.x);let layer=i32(material.coordinates.y);let repeating=material.coordinates.z>0.;
 if(family==0u){return forestNativePair(forestNativeAlbedo0,forestNativeNormal0,uv,ux,uy,layer,repeating);}
 if(family==1u){return forestNativePair(forestNativeAlbedo1,forestNativeNormal1,uv,ux,uy,layer,repeating);}
 if(family==2u){return forestNativePair(forestNativeAlbedo2,forestNativeNormal2,uv,ux,uy,layer,repeating);}
 return forestNativePair(forestNativeAlbedo3,forestNativeNormal3,uv,ux,uy,layer,repeating);
}
// A layer's own colour over all of it: the last level of its coverage-weighted mips.
fn forestNativeMean(material:ForestLeafMaterial)->vec3f{
 let family=u32(material.coordinates.x);let layer=i32(material.coordinates.y);let middle=vec2f(.5);
 var pigment:vec4f;
 if(family==0u){pigment=textureSampleLevel(forestNativeAlbedo0,forestNativeSampler,middle,layer,f32(textureNumLevels(forestNativeAlbedo0)-1u));}
 else if(family==1u){pigment=textureSampleLevel(forestNativeAlbedo1,forestNativeSampler,middle,layer,f32(textureNumLevels(forestNativeAlbedo1)-1u));}
 else if(family==2u){pigment=textureSampleLevel(forestNativeAlbedo2,forestNativeSampler,middle,layer,f32(textureNumLevels(forestNativeAlbedo2)-1u));}
 else{pigment=textureSampleLevel(forestNativeAlbedo3,forestNativeSampler,middle,layer,f32(textureNumLevels(forestNativeAlbedo3)-1u));}
 return forestOwnColour(pigment);
}
fn forestMappedNormal(geometric:vec3f,detail:vec3f,dx:vec3f,dy:vec3f,ux:vec2f,uy:vec2f)->vec3f{
 let determinant=ux.x*uy.y-ux.y*uy.x;
 let direction=select(-1.,1.,determinant>=0.);
 let tangent=dx*uy.y-dy*ux.y;let bitangent=dy*ux.x-dx*uy.x;
 var n=geometric;
 if(abs(determinant)>1e-12&&dot(tangent,tangent)>1e-16&&dot(bitangent,bitangent)>1e-16&&dot(detail,detail)>1e-16){
   let t=normalize(tangent)*direction;let b=normalize(bitangent)*direction;
   let sampled=normalize(detail);n=normalize(t*sampled.x+b*sampled.y+geometric*sampled.z);
 }
 return n;
}
// Near, a leaf's edge is crisp and its veins and cuticle show; this fades out before the canopy is far.
fn forestBotanicalDetail(uv:vec2f,viewDist:f32,rawAlpha:f32)->vec4f{
 let detailW=1.-smoothstep(10.,38.,viewDist);
 if(detailW<=.001||rawAlpha<=.04){return vec4f(rawAlpha,0.,0.,0.);}
 let edgeSharp=smoothstep(.24,.76,rawAlpha);
 let crispAlpha=mix(rawAlpha,edgeSharp,detailW*.24);
 let interior=smoothstep(.20,.65,rawAlpha)*detailW;
 let chevronU=uv.x*22.0-abs(uv.y-.5)*14.0;
 let secVein=sin(chevronU)*exp(-abs(fract(chevronU*.1591549)-.5)*3.2);
 let fineNet=sin(uv.x*68.0+uv.y*44.0)*cos(uv.x*41.0-uv.y*63.0);
 let sideSign=select(-1.,1.,uv.y>=.5);
 let veinX=(secVein*.16+fineNet*.045)*interior;
 let veinY=(cos(chevronU)*sideSign*.14+fineNet*.045)*interior;
 let dapple=(sin(uv.x*11.3+uv.y*7.9)*.55+cos(uv.x*19.7-uv.y*15.1)*.45)*interior;
 return vec4f(crispAlpha,veinX,veinY,dapple);
}
// The colour light shining through a leaf takes on, as its blade passes the green and holds back the blue; a leaf
// near and a crown far take on the same.
const FOREST_LEAF_BACKLIT=vec3f(1.12,1.18,.72);
fn forestLeafBacklit(colour:vec3f,backlit:f32,exposure:f32)->vec3f{return colour*mix(vec3f(1.),FOREST_LEAF_BACKLIT,backlit*exposure);}
// A leaf's colour on the side seen: its face, or its underside as its maps' optics give it, worn by the specimen's
// tint as its face is.
fn forestLeafUnderside(face:vec3f,material:ForestLeafMaterial,tint:vec3f)->vec3f{return mix(face,forestNativeLinear(material.underside.rgb)*tint,material.optics.y);}
// A crown is lit as the leaves it stands for, not as the surface it is. Each leaf is lit by its own normal, turned
// to face the viewer, and shows its underside from below, in the colours a leaf near is worn in (face and back); the
// leaves of a bough face much the same way (leaves) and differ by a known spread (FOREST_CROWN_ALIKE, the length of
// their mean). Eight leaves about that mean, each counted by how much of it the viewer sees, give the light and
// colour a pixel full of them would average to.
const FOREST_CROWN_ALIKE=.7;
const FOREST_CROWN_RING=array<vec2f,8>(
 vec2f(.92387953,.38268343),vec2f(.38268343,.92387953),vec2f(-.38268343,.92387953),vec2f(-.92387953,.38268343),
 vec2f(-.92387953,-.38268343),vec2f(-.38268343,-.92387953),vec2f(.38268343,-.92387953),vec2f(.92387953,-.38268343));
struct ForestCrownLight {colour:vec3f,light:vec2f,finish:vec2f,normal:vec3f};
fn forestCrownLight(world:vec3f,leaves:vec3f,outward:vec3f,face:vec3f,back:vec3f,exposure:f32,escape:f32,transmission:f32,roughness:f32)->ForestCrownLight{
 let view=normalize(continuumEye()-world);let middle=normalize(leaves);
 let side=normalize(cross(middle,select(vec3f(1.,0.,0.),vec3f(0.,0.,1.),abs(middle.x)>.9)));let other=cross(middle,side);
 let spread=sqrt(1.-FOREST_CROWN_ALIKE*FOREST_CROWN_ALIKE);
 let moonDir=lunarDirection();
 var weight=0.;var gain=vec3f(0.);var lit=vec3f(0.);var mean=vec3f(0.);var level=0.;var moon=0.;
 for(var k=0;k<8;k++){
  let cs=FOREST_CROWN_RING[k];
  var n=middle*FOREST_CROWN_ALIKE+(side*cs.x+other*cs.y)*spread;
  let facing=dot(n,view);let seen=abs(facing);
  if(facing<0.){n=-n;}
  let nDotL=dot(n,F.sunDir.xyz);let backlit=max(-nDotL,0.)*transmission;
  let tint=forestLeafBacklit(select(back,face,facing>=0.),backlit,exposure);
  gain+=tint*seen;lit+=tint*(seen*(max(nDotL,0.)+backlit));mean+=n*seen;level+=abs(n.y)*seen;moon+=max(dot(n,moonDir),0.)*seen;weight+=seen;
 }
 weight=max(weight,1e-4);mean/=weight;
 let luma=vec3f(.2126,.7152,.0722);
 var o:ForestCrownLight;
 o.colour=gain/weight;
 o.light=vec2f(dot(lit,luma)/max(dot(gain,luma),1e-4)*(.22+.78*exposure*exposure)*(.35+.65*escape),(.12+exposure*.56+level/weight*.09)*escape);
 let rough=clamp(roughness,.24,.92);
 // Leaves this small show no highlight of their own; a wet leaf's darker colour stays.
 o.finish=vec2f(clamp((1.-rough)*.42*(.35+.65*exposure),0.,.36),max(rough,.8));
 // By night the moon is the light that matters, and the normal is turned to give the leaves' own share of it.
 var night=mean;let low=length(moonDir.xz);
 if(low>.05){let along=clamp((moon/weight-mean.y*moonDir.y)/low,-1.,1.);night=vec3f(moonDir.x/low*along,mean.y,moonDir.z/low*along);}
 o.normal=mix(mean,night,1.-smoothstep(-.12,.02,F.sunDir.y));
 // A crown is a rounded body as well as a mass of leaves: darker on the side it turns from the sun, its underside
 // seeing less sky than its top. Over a whole crown both average to one.
 o.light*=vec2f(mix(.68,1.36,smoothstep(-.45,.75,dot(outward,F.sunDir.xyz))),mix(.8,1.2,outward.y*.5+.5));
 return o;
}
// Value noise on a lattice fixed to the ground, between -1 and 1.
fn forestCrownLattice(p:vec3f)->f32{
 let i=vec3i(floor(p));let f=fract(p);let u=f*f*(3.-2.*f);var sum=0.;
 for(var k=0;k<8;k++){
  let corner=vec3i(k&1,(k>>1)&1,k>>2);let q=bitcast<vec3u>(i+corner);
  let h=continuumHash((q.x*0x8da6b343u)^continuumHash((q.y*0xd8163841u)^continuumHash(q.z*0xcb1ab31fu)));
  let w=mix(vec3f(1.)-u,u,vec3f(corner));
  sum+=w.x*w.y*w.z*f32(h&65535u)/65535.;
 }
 return sum*2.-1.;
}
// Sprays of leaves catch the light or fall into the next one's shade, and whole boughs stand lighter or darker: two
// sizes of that unevenness, each fading out as it shrinks below what a pixel can show.
fn forestCrownMottle(world:vec3f)->f32{
 let pixel=length(continuumEye()-world)*2.*length(F.camUp.xyz)/max(F.screen.y,1.);
 let spray=forestCrownLattice(world/1.1)*.26*(1.-smoothstep(.3,.8,pixel/1.1));
 let bough=forestCrownLattice(world/3.4+vec3f(17.3,5.1,9.7))*.16*(1.-smoothstep(.3,.8,pixel/3.4));
 return 1.+spray+bough;
}
// The surface lies just inside its outermost leaves, which the land's shadow map holds: its shadow is looked up beyond them.
const FOREST_CROWN_SHADOW_LIFT=.45;
// A far triangle's word and a splat's: leaf | layer << 1 | exposure << 5 | canopy light << 11 | colour << 17.
struct ForestFarLook {leaf:bool,layer:u32,exposure:f32,escape:f32,colour:vec3f};
fn forestFarLook(word:u32)->ForestFarLook{
 var o:ForestFarLook;
 o.leaf=(word&1u)!=0u;o.layer=(word>>1u)&15u;o.exposure=f32((word>>5u)&63u)/63.;o.escape=f32((word>>11u)&63u)/63.;
 let root=vec3f(f32((word>>17u)&31u),f32((word>>22u)&31u),f32((word>>27u)&31u))/31.;
 o.colour=root*root;
 return o;
}
fn forestContinuumVarying(s:ContinuumSurface,v:ptr<function,ContinuumVarying>){
 let tint=unpack4x8unorm(s.record.spare.x).rgb*2.0;
 let first=continuumType(s.model,${M.firstLayer}u);
 let data=continuumKindData(s.record);
 (*v).seed=continuumHash(s.vertex^(s.record.tag.z*0x9e3779b9u));
 (*v).uv=vec2f(0.0);(*v).surface=vec4f(0.0);(*v).crown=vec4f(0.0);
 if(s.what==CONTINUUM_CLUSTER_ENTRY){
  let layer=s.high&15u;let leaf=(s.high>>4u)&1u;
  let word=unpack4x8unorm(s.word);
  let uvLow=vec2f(continuumTypeF(s.model,${M.uvLow}u),continuumTypeF(s.model,${M.uvLow + 1}u));
  let uvScale=vec2f(continuumTypeF(s.model,${M.uvScale}u),continuumTypeF(s.model,${M.uvScale + 1}u));
  (*v).uv=uvLow+continuumUV(s.vertex)*uvScale;
  let textured=layer!=${FOREST_CONTINUUM_UNTEXTURED}u;
  // The maps carry a textured surface's colour; the pack's vertex colour stands for one without.
  (*v).colour=select(word.rgb*word.rgb,vec3f(1.0),textured)*tint;
  // Raw wood where a ball gouged the trunk, and about the break of one felled.
  var raw=0.0;
  if(leaf==0u){
   let form=u32(round(continuumPoses[data].w));
   if(form==${F.WOUNDED}u){raw=continuumWindWound(data,s.local,continuumQuat(vec4f(-s.record.turn.xyz,s.record.turn.w),s.normal));}
   else if(form==${F.FELLED}u){
    // About the break: the height each point stood at before it fell (what lies below the hinge never moved).
    let held=continuumPoses[data+1u];let hinge=vec3f(0.0,held.x,0.0);
    let stood=hinge+continuumWindFall(s.local-hinge,held.y,-held.z);
    raw=1.0-smoothstep(0.0,.7,abs(select(s.local.y,stood.y,s.local.y>held.x||stood.y>held.x)-held.x));
   }
  }
  (*v).surface=vec4f(f32((s.high>>5u)&255u)/255.,word.a,raw,0.0);
  (*v).layer=select(FOREST_UNTEXTURED,first+layer,textured)|(leaf<<16u);
  return;
 }
 // The far body and the splat: a crown of leaves, or the bare wood below it.
 var look:ForestFarLook;
 if(s.what==CONTINUUM_FAR_ENTRY){look=forestFarLook(s.word);}else{look=forestFarLook(continuumType(s.model,${M.splat}u));}
 let textured=look.layer!=${FOREST_CONTINUUM_UNTEXTURED}u;
 let material=forestNativeMaterials[select(0u,first+look.layer,textured)];
 var colour=look.colour;
 if(textured){colour=forestNativeMean(material);}
 colour*=tint;
 (*v).layer=FOREST_UNTEXTURED;
 if(!look.leaf){
  let n=s.normal;
  (*v).colour=colour;
  (*v).crown=vec4f(max(dot(n,F.sunDir.xyz),0.)*(.35+.65*look.escape),(.36+max(n.y,0.)*.25)*look.escape,0.,.95);
  return;
 }
 var outward=s.normal;
 if(s.what==CONTINUUM_SPLAT_ENTRY){
  // The splat is a dome toward the eye: its corners lean out from the middle as a crown's sides do.
  let toEye=s.normal;let up=normalize(vec3f(0.0,1.0,0.0)-toEye*toEye.y+vec3f(0.0,1e-4,0.0));let right=cross(up,toEye);
  outward=normalize(toEye*.68+right*(s.corner.x*.79*.52)+up*(s.corner.y*.79*.56));
 }
 // Its leaves' undersides, as a leaf near shows them.
 let back=select(colour,forestLeafUnderside(colour,material,tint),textured);
 let lit=forestCrownLight(s.world,normalize(outward+vec3f(0.,.35,0.)),outward,colour,back,look.exposure,look.escape,material.optics.z,material.optics.x);
 (*v).colour=lit.colour;(*v).normal=lit.normal;(*v).crown=vec4f(lit.light,lit.finish);
 (*v).surface=vec4f(look.exposure,1.0,0.0,0.0);
}
fn forestContinuumShade(v:ContinuumVarying,front:bool)->vec4f{
 let dx=dpdx(v.world);let dy=dpdy(v.world);let ux=dpdx(v.uv);let uy=dpdy(v.uv);
 let toEye=continuumEye()-v.world;let viewDist=length(toEye);
 var n=normalize(v.normal);var colour=v.colour;var diffuse=0.0;var ambient=0.0;var wet=0.0;var roughness=.9;
 var shadowAt=v.world;
 let exposure=clamp(v.surface.x,0.,1.);
 if(v.coverage.x!=CONTINUUM_CLUSTER_ENTRY){
  // A crown, each face by its own plane, mottled as its leaves would be.
  let across=cross(dx,dy);
  let outward=normalize(across*select(-1.,1.,dot(across,toEye)>=0.)+toEye*1e-9);
  shadowAt=v.world+outward*FOREST_CROWN_SHADOW_LIFT;
  let mottle=mix(1.,forestCrownMottle(v.world),clamp(v.surface.y,0.,1.));
  // An edge-on triangle's pixel reads its varyings from past its corners: each is held to what a leaf can be.
  let span=dot(v.normal,v.normal);
  n=select(outward,v.normal*inverseSqrt(max(span,1e-12)),span>1e-6&&span<1e6);
  colour=clamp(v.colour,vec3f(0.),vec3f(4.));let light=clamp(v.crown.xy,vec2f(0.),vec2f(4.,1.));
  let finish=clamp(v.crown.zw,vec2f(0.,.05),vec2f(1.));
  diffuse=light.x*mottle;ambient=light.y*mix(1.,mottle,.6);wet=finish.x;roughness=finish.y;
 }else{
  let layer=v.layer&0xffffu;let leaf=(v.layer>>16u)!=0u;let textured=layer!=FOREST_UNTEXTURED;
  let material=forestNativeMaterials[select(0u,layer,textured)];
  var surface=forestReadNative(material,v.uv,ux,uy);
  if(!textured){surface.pigment=vec4f(1.);surface.detail=vec4f(0.,0.,1.,.9);}
  let canopy=clamp(v.surface.y,0.,1.);
  if(!leaf){
   // Bark: its maps, its grain close to, raw where shot has opened it.
   let pale=v.colour*vec3f(2.7,2.2,1.5)+vec3f(.07,.055,.03);
   colour=forestOwnColour(surface.pigment)*mix(v.colour,pale,clamp(v.surface.z,0.,1.));
   let barkClose=1.-smoothstep(8.,32.,viewDist);
   var detailVec=surface.detail.xyz*vec3f(1.25+0.35*barkClose,1.25+0.35*barkClose,1.0);
   if(barkClose>0.001){
    let grainU=v.uv.x*46.0+sin(v.uv.y*9.5)*1.4;let grainV=v.uv.y*18.0;
    let fissure=sin(grainU)*0.65+sin(grainU*2.3+grainV*0.7)*0.35;
    let plate=cos(grainU)*0.65+cos(grainU*2.3+grainV*0.7)*0.35;
    detailVec.x+=plate*0.18*barkClose;detailVec.y+=sin(grainV*2.1+grainU*0.4)*0.08*barkClose;
    colour*=1.0+fissure*0.055*barkClose;
   }
   n=forestMappedNormal(n,detailVec,dx,dy,ux,uy)*select(-1.,1.,front);
   roughness=clamp(surface.detail.a/max(surface.pigment.a,FOREST_THINNEST_COVERAGE),0.22,0.98);
   wet=clamp(material.coordinates.w*(1.0-roughness),0.0,0.28);
   // The light the specimen's own canopy lets through (not a sun shadow: the land's and the clouds' stay).
   let woodAO=min(canopy,select(1.0,mix(0.30,1.0,exposure),canopy>0.995&&exposure<0.995));
   diffuse=max(dot(n,F.sunDir.xyz),0.)*(.35+.65*woodAO);ambient=(.36+max(n.y,0.)*.25)*woodAO;
  }else{
   let pigment=surface.pigment;
   colour=forestOwnColour(pigment)*v.colour;
   let uvOff=v.uv-vec2f(.5,.5);
   let mappedN=forestMappedNormal(n,surface.detail.xyz*vec3f(1.35,1.35,1.0),dx,dy,ux,uy)*select(-1.,1.,front);
   n=normalize(mappedN+vec3f(uvOff.x*0.06,uvOff.y*0.05,0.0));
   var rawRough=surface.detail.a/max(pigment.a,FOREST_THINNEST_COVERAGE);
   if(viewDist<38.){
    let bot=forestBotanicalDetail(v.uv,viewDist,pigment.a);
    let tDir=normalize(dx+vec3f(1e-5,0.,0.));let bDir=normalize(dy+vec3f(0.,0.,1e-5));
    n=normalize(n+(tDir*bot.y+bDir*bot.z)*0.28);
    colour*=vec3f(1.+bot.w*.07,1.+bot.w*.10,1.-bot.w*.05);
    rawRough=clamp(rawRough-bot.w*.08,0.22,0.92);
   }
   if(!front){colour=forestLeafUnderside(colour,material,v.colour);}
   let nDotL=dot(n,F.sunDir.xyz);
   let backlit=max(-nDotL,0.)*material.optics.z;
   colour=forestLeafBacklit(colour,backlit,exposure);
   diffuse=(max(nDotL,0.)+backlit)*(.22+.78*exposure*exposure)*(.35+.65*canopy);
   ambient=(.12+exposure*.56+abs(n.y)*.09)*canopy;
   roughness=clamp(rawRough,0.24,0.92);
   wet=clamp((1.0-roughness)*0.42*(0.35+0.65*exposure),0.0,0.36);
  }
 }
 return landFinishShadowed(v.world,n,colour,diffuse,ambient,wet,roughness,landShadowVisibility(shadowAt,select(n,normalize(shadowAt-v.world+n*1e-6),v.coverage.x!=CONTINUUM_CLUSTER_ENTRY)));
}
// A leaf card's cut: the samples its coverage takes, nearer leaves reading coverage half a level finer, which shows
// their shapes, and far ones a little fuller, as a canopy's many small gaps close at a distance. Bark, the far body
// and the splat cover every sample.
fn forestContinuumCoverage(v:ContinuumVarying,front:bool)->u32{
 let ux=dpdx(v.uv);let uy=dpdy(v.uv);
 let layer=v.layer&0xffffu;
 if(v.coverage.x!=CONTINUUM_CLUSTER_ENTRY||(v.layer>>16u)==0u||layer==FOREST_UNTEXTURED){return 0xffffffffu;}
 let viewDist=length(continuumEye()-v.world);
 let near=mix(.7,1.,smoothstep(30.,90.,viewDist));
 let rawAlpha=forestNativeAlbedoOnly(forestNativeMaterials[layer],v.uv,ux*near,uy*near).a;
 let crisp=select(rawAlpha,forestBotanicalDetail(v.uv,viewDist,rawAlpha).x,viewDist<38.);
 return forestLeafSampleMask(clamp(crisp*mix(1.,2.25,smoothstep(45.,220.,viewDist)),0.,1.),v.seed,v.position.xy,v.coverage.w);
}
`;
};

// Its shadow: a leaf card's shadow is cut by its coverage as its view is (one sample a texel), so the sun comes through
// the gaps between leaves; bark, the far body and the splat cast whole. Its maps are the shadow program's group 2, the
// same entries as the view's group 3 (js/forest-scenery.js).
const FOREST_CONTINUUM_SHADOW = Object.freeze({
  prelude: () => forestLeafMapsWGSL(2), own: true, coverage: true,
  varyings: [['uv', 'vec2f'], ['layer', 'u32', true], ['seed', 'u32', true]],
  wgsl: () => {
    const M = FOREST_CONTINUUM_MATERIAL;
    return /* wgsl */`
fn forestContinuumShadowVarying(s:ContinuumSurface,v:ptr<function,ContinuumShadowVarying>){
 (*v).seed=continuumHash(s.vertex^(s.record.tag.z*0x9e3779b9u));(*v).uv=vec2f(0.0);(*v).layer=FOREST_UNTEXTURED;
 let layer=s.high&15u;
 if(s.what!=CONTINUUM_CLUSTER_ENTRY||((s.high>>4u)&1u)==0u||layer==${FOREST_CONTINUUM_UNTEXTURED}u){return;}
 let uvLow=vec2f(continuumTypeF(s.model,${M.uvLow}u),continuumTypeF(s.model,${M.uvLow + 1}u));
 let uvScale=vec2f(continuumTypeF(s.model,${M.uvScale}u),continuumTypeF(s.model,${M.uvScale + 1}u));
 (*v).uv=uvLow+continuumUV(s.vertex)*uvScale;
 (*v).layer=continuumType(s.model,${M.firstLayer}u)+layer;
}
fn forestContinuumShadowCoverage(v:ContinuumShadowVarying)->u32{
 let ux=dpdx(v.uv);let uy=dpdy(v.uv);
 // Every map is named, on a path never taken, so the program's group holds all the view's entries.
 if(v.coverage.w==0u){
  let m=vec2f(0.0);
  return u32(textureSampleLevel(forestNativeNormal0,forestNativeRepeatSampler,m,0,0.).x+textureSampleLevel(forestNativeNormal1,forestNativeRepeatSampler,m,0,0.).x
   +textureSampleLevel(forestNativeNormal2,forestNativeRepeatSampler,m,0,0.).x+textureSampleLevel(forestNativeNormal3,forestNativeRepeatSampler,m,0,0.).x);
 }
 if(v.layer==FOREST_UNTEXTURED){return 0xffffffffu;}
 return forestLeafSampleMask(forestNativeAlbedoOnly(forestNativeMaterials[v.layer],v.uv,ux,uy).a,v.seed,v.position.xy,1u);
}
`;
  },
});

// The forest's material (js/wgsl/continuum-cut.js), shaded with the land's module source (js/wgsl/terrain.js TERRAIN as
// the terrain draws it), which holds the shared core, the frame and the land's finish (groups 0 and 1).
export function forestContinuumMaterial(landSource) {
  return Object.freeze({
    name: 'forestContinuum', prelude: () => landSource, core: true, data: FOREST_CONTINUUM_DATA,
    varyings: [['uv', 'vec2f'], ['colour', 'vec3f'], ['surface', 'vec4f'], ['crown', 'vec4f'], ['layer', 'u32', true], ['seed', 'u32', true]],
    wgsl: forestContinuumMaterialWGSL, salt: 3,
    // Leaf cards are seen from both sides; the far body's back faces are its far side's leaves.
    cullMode: 'none', air: false, capture: false, coverage: true, shadow: FOREST_CONTINUUM_SHADOW,
  });
}

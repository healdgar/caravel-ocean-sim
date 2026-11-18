// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The people continuum's GPU side (js/crew-continuum.js, js/crew-continuum-draw.js). A person is a record of the one
// cut's SKINNED kind (js/wgsl/continuum-kinds.js): the cut, its lists, its handoffs, its shadow and its capture under
// water are the one continuum's (js/wgsl/continuum-cut.js). This supplies three things only: the pass that poses people
// placed on the GPU into the crew's joints and actors, the stand that turns those joints and actors into each person's
// record and pose data, and the crew's material.
import { FRAME_WGSL } from './common.js';
import { CREW_JOINT_BLEND_WGSL, crewRenderWGSL } from './crew.js';
import { CONTINUUM_RECORD_WGSL } from './continuum-cut.js';
import { SKINNED_POSE_WGSL, skinnedPoseVec4s } from './skinned-pose.js';
import { continuumGroundWGSL } from '../continuum-ground.js';
import { CONTINUUM_KIND } from '../continuum-format.js';
import { CREW_JOINT_COUNT, CREW_JOINT_PARENTS, CREW_SLOT } from '../crew-skeleton.js';
import { CREW_CONTINUUM_RIG_VEC4S, CREW_CONTINUUM_WEAR_VEC4S } from '../crew-continuum.js';

// What the GPU is told of a person, beside their joints and actor record (the batch's orders): bit 1 as
// CREW_CONTINUUM_ORDER_IMPORTANT says; above the low two bits, when not 0, who they are plus one. Where people are
// compacted afresh each frame their slot changes, and the hash that thins them and splits their samples follows who
// they are, so no one flickers as others come and go.
export const CREW_CONTINUUM_ORDER_IMPORTANT = 2;  // wounded, spoken to or aimed at: cut at the core's CONTINUUM_IMPORTANT
export const CREW_CONTINUUM_IDENTITY_SHIFT = 2;
// A person's pose data in its scene's pose buffer: the SKINNED kind's head, then every joint's rows and posed sphere.
export const CREW_CONTINUUM_POSE_VEC4S = skinnedPoseVec4s(CREW_JOINT_COUNT);
// How far a severed person's points may stray from their joints' bounds: a forearm, shin or head drawn in to its stump
// is carried by the stump's joint and the one it hung from at once.
const CREW_CONTINUUM_SEVERED_SLACK = 0.6;

// --------------------------------------------------------------------------------------------- posing people placed on the GPU
// People whose place and pose a compute pass works out (the townsfolk, a vessel's deck hands) are written as one record
// each, compacted by who is kept, and this pass turns each record into the joints and actor the stand reads, as the
// crew's own passes write them for the ship's company. One workgroup a person, dispatched from the count the placing
// pass kept, so nothing on the CPU knows how many there are.
//   transform  where the person stands, metres and radians in the world (or the hull's frame, if the batch has one)
//   frames     (clip frame A, frame B, brace frame, look)
//   blend      (A toward B, toward the brace frame, unused, unused)
//   who        (identity, damage, orders, moisture slot): damage is injury | wound << 3 | scorch << 7 | seed << 11,
//              orders bit 1 cuts them finer, and the moisture slot is the first of four the drawing reads.
export const CREW_CONTINUUM_PLACED_WORDS = 28;
// A look: shirt, trousers, skin (w the body: 0 a man's, 1 a woman's), hair (w the dress / DRESS_MASK_SCALE) and face.
export const CREW_CONTINUUM_LOOK_WORDS = 20;
export const CREW_CONTINUUM_PLACED_WGSL = /* wgsl */`
struct CrewPlaced { transform:mat4x4f, frames:vec4u, blend:vec4f, who:vec4u };
`;
// What a wound takes off, in slots of the skeleton: the joint it parts at and every joint that hangs from it. Each joint
// is followed in the skin order by all its descendants, so they are one run, ended by the first joint whose parent comes
// before the one parted. Injury 1 takes off the left forearm, 2 the right, 3 and 4 the left and right shins, 5 the
// head; 6 and 7 break the left and right arm at the elbow.
const CREW_CONTINUUM_SEVERED = Object.freeze(['lowerarm_l', 'lowerarm_r', 'calf_l', 'calf_r', 'neck_01'].map((name) => {
  const first = CREW_SLOT[name];
  let last = first;
  while (last + 1 < CREW_JOINT_COUNT && CREW_JOINT_PARENTS[last + 1] >= first) last++;
  return Object.freeze([first, last]);
}));
export function crewContinuumPoseWGSL() {
  const N = CREW_JOINT_COUNT, run = ([first, last]) => `vec2u(${first}u,${last}u)`;
  return CREW_JOINT_BLEND_WGSL + CREW_CONTINUUM_PLACED_WGSL + /* wgsl */`
struct CrewActor { transform:mat4x4f, shirt:vec4f, trousers:vec4f, skin:vec4f, hair:vec4f, face:vec4f };
struct CrewLook { shirt:vec4f, trousers:vec4f, skin:vec4f, hair:vec4f, face:vec4f };
struct CrewPoseRun { first:u32, unused0:u32, unused1:u32, unused2:u32 };
@group(0) @binding(0) var<storage,read> placed:array<CrewPlaced>;
@group(0) @binding(1) var<storage,read> palettes:array<mat4x4f>;
@group(0) @binding(2) var<storage,read> looks:array<CrewLook>;
@group(0) @binding(3) var<storage,read> rest:array<vec4f>;
@group(0) @binding(4) var<storage,read_write> joints:array<mat4x4f>;
@group(0) @binding(5) var<storage,read_write> actors:array<CrewActor>;
@group(0) @binding(6) var<storage,read_write> orders:array<u32>;
@group(0) @binding(7) var<uniform> poseRun:CrewPoseRun;
var<workgroup> crewPosed:array<mat4x4f,${N}>;
fn crewPoseSevered(injury:u32)->vec2u {
  switch injury {
    case 1u: { return ${run(CREW_CONTINUUM_SEVERED[0])}; }
    case 2u: { return ${run(CREW_CONTINUUM_SEVERED[1])}; }
    case 3u: { return ${run(CREW_CONTINUUM_SEVERED[2])}; }
    case 4u: { return ${run(CREW_CONTINUUM_SEVERED[3])}; }
    case 5u: { return ${run(CREW_CONTINUUM_SEVERED[4])}; }
    default: { return vec2u(1u,0u); }
  }
}
fn crewPoseBroken(injury:u32)->vec2u {
  if(injury==6u){return ${run(CREW_CONTINUUM_SEVERED[0])};}
  if(injury==7u){return ${run(CREW_CONTINUUM_SEVERED[1])};}
  return vec2u(1u,0u);
}
@compute @workgroup_size(64) fn crewContinuumPose(@builtin(workgroup_id) group:vec3u,@builtin(local_invocation_index) lane:u32){
  let person=group.x;
  let slot=poseRun.first+person;
  if(slot>=arrayLength(&placed)){return;}
  let at=placed[slot];
  // The clip's two frames, blended about each joint's own place at rest, and then toward the brace.
  for(var j=lane;j<${N}u;j+=64u){
    let pivot=rest[j].xyz;
    var m=palettes[at.frames.x*${N}u+j];
    if(at.blend.x>0.0&&at.frames.y!=at.frames.x){m=crewBlendJoint(m,palettes[at.frames.y*${N}u+j],at.blend.x,pivot);}
    if(at.blend.y>0.0){m=crewBlendJoint(m,palettes[at.frames.z*${N}u+j],at.blend.y,pivot);}
    crewPosed[j]=m;
  }
  workgroupBarrier();
  // What a wound took off is drawn in to the stump, where it parted; a broken arm hangs bent at the elbow.
  let injury=at.who.y&7u;
  let severed=crewPoseSevered(injury);let broken=crewPoseBroken(injury);
  let stump=crewPosed[min(severed.x,${N - 1}u)];let stumpRest=rest[min(severed.x,${N - 1}u)].xyz;
  let elbow=rest[min(broken.x,${N - 1}u)].xyz;
  let turn=select(-0.68,0.68,injury==6u);let c=cos(turn);let s=sin(turn);
  let bend=mat4x4f(vec4f(c,s,0.0,0.0),vec4f(-s,c,0.0,0.0),vec4f(0.0,0.0,1.0,0.0),vec4f(elbow-vec3f(elbow.x*c-elbow.y*s,elbow.x*s+elbow.y*c,elbow.z),1.0));
  for(var j=lane;j<${N}u;j+=64u){
    var m=crewPosed[j];
    if(j>=severed.x&&j<=severed.y){
      let a=mat3x3f(stump[0].xyz,stump[1].xyz,stump[2].xyz)*0.001;
      m=mat4x4f(vec4f(a[0],0.0),vec4f(a[1],0.0),vec4f(a[2],0.0),vec4f((stump*vec4f(stumpRest,1.0)).xyz-a*stumpRest,1.0));
    }else if(j>=broken.x&&j<=broken.y){m=m*bend;}
    joints[slot*${N}u+j]=m;
  }
  if(lane==0u){
    let look=looks[at.frames.w];
    let damage=at.who.y;
    let wound=f32((damage>>3u)&15u)/15.0;
    let scorch=f32((damage>>7u)&15u)/15.0;
    let bandage=select(0.0,0.06+f32((damage>>11u)&7u)/7.0*0.32,damage>0u);
    let shirt=mix(look.shirt.rgb,look.shirt.rgb*vec3f(0.55,0.32,0.32)+vec3f(0.2,0.0,0.0),smoothstep(0.15,0.85,wound));
    actors[slot]=CrewActor(at.transform,vec4f(shirt,wound*0.45),vec4f(look.trousers.rgb,scorch*0.42),vec4f(look.skin.rgb,floor(look.skin.w)+bandage),
      vec4f(look.hair.rgb,f32(at.who.w)+fract(look.hair.w)),look.face);
    orders[person]=(at.who.z&3u)|((at.who.x+1u)<<${CREW_CONTINUUM_IDENTITY_SHIFT}u);
  }
}
`;
}

// --------------------------------------------------------------------------------------------- the stand
// Each person's record and pose data, from the joints and actor the crew's passes (or the pose pass above) have just
// written: a workgroup a person. The record stands where the actor's transform puts the body, in the world (through
// the hull's frame, the world's own ashore), at the actor's scale, unturned: each joint's rows carry the body's turn
// and pose, in the type's own metres, so a joint's matrix is the hull's turn of actor and joint together, less the
// body's place, over its scale. A person who is not drawn (hidden, or past the batch's count) is GONE, however near
// the eye stands; one with a limb parted (a joint drawn in to nothing) is DAMAGED, cut whole as clusters at the finest their error
// allows. `ground`: they stand on the land, drawn on the ground the land draws (js/continuum-ground.js).
//   run  first slot of the batch, how many it holds, the word of the counted dispatch that says how many when the GPU
//        counts them, flags: 1 counted on the GPU, 2 afloat
export function crewContinuumStandWGSL(ground) {
  const N = CREW_JOINT_COUNT;
  return FRAME_WGSL + CONTINUUM_RECORD_WGSL + SKINNED_POSE_WGSL + (ground ? continuumGroundWGSL(0, 10) : '') + /* wgsl */`
struct CrewStandHull { right:vec4f, up:vec4f, forward:vec4f, size:vec4f, origin:vec4f };
struct CrewStandActor { transform:mat4x4f, shirt:vec4f, trousers:vec4f, skin:vec4f, hair:vec4f, face:vec4f };
struct CrewStandRun { first:u32, count:u32, counted:u32, flags:u32 };
${ground ? '@group(0) @binding(0) var<uniform> F:Frame;' : ''}
@group(0) @binding(1) var<uniform> crewStandHull:CrewStandHull;
@group(0) @binding(2) var<storage,read> crewStandJoints:array<mat4x4f>;
@group(0) @binding(3) var<storage,read> crewStandActors:array<CrewStandActor>;
@group(0) @binding(4) var<storage,read> crewStandOrders:array<u32>;
@group(0) @binding(5) var<uniform> crewStandRun:CrewStandRun;
@group(0) @binding(6) var<storage,read_write> crewStandRecords:array<ContinuumRecord>;
@group(0) @binding(7) var<storage,read_write> skinnedPoses:array<vec4f>;
@group(0) @binding(8) var<uniform> crewStandRig:array<vec4f,${CREW_CONTINUUM_RIG_VEC4S}>;
@group(0) @binding(9) var<storage,read> crewStandCounted:array<u32>;
var<workgroup> crewStandSevered:atomic<u32>;
fn crewStandTurn(p:vec3f)->vec3f { return crewStandHull.right.xyz*p.x+crewStandHull.up.xyz*p.y-crewStandHull.forward.xyz*p.z; }
@compute @workgroup_size(64) fn crewContinuumStand(@builtin(workgroup_id) group:vec3u,@builtin(local_invocation_index) lane:u32){
  let person=group.x;
  let slot=crewStandRun.first+person;
  let held=select(crewStandRun.count,crewStandCounted[crewStandRun.counted],(crewStandRun.flags&1u)!=0u);
  let actor=crewStandActors[min(slot,arrayLength(&crewStandActors)-1u)];
  let T=actor.transform;
  let scale=max(length(T[0].xyz),1e-3);
  let place=crewStandTurn(T[3].xyz)+crewStandHull.origin.xyz;
  let gone=person>=held||slot>=arrayLength(&crewStandActors)||actor.shirt.w>0.5;
  // A joint drawn in to nothing: a parted limb, which its stump carries.
  if(!gone){
    for(var j=lane;j<${N}u;j+=64u){
      let m=crewStandJoints[slot*${N}u+j];
      if(max(max(length(m[0].xyz),length(m[1].xyz)),length(m[2].xyz))<0.01){atomicOr(&crewStandSevered,1u);}
    }
  }
  workgroupBarrier();
  let severed=atomicLoad(&crewStandSevered)!=0u;
  let at=person*${CREW_CONTINUUM_POSE_VEC4S}u;
  let slack=crewStandRig[0].y+select(0.0,${CREW_CONTINUUM_SEVERED_SLACK.toFixed(2)},severed);
  if(!gone){
    let over=1.0/scale;
    for(var j=lane;j<${N}u;j+=64u){
      let A=T*crewStandJoints[slot*${N}u+j];
      let x=crewStandTurn(A[0].xyz)*over;let y=crewStandTurn(A[1].xyz)*over;let z=crewStandTurn(A[2].xyz)*over;
      let t=crewStandTurn(A[3].xyz-T[3].xyz)*over;
      skinnedWriteJoint(at,${N}u,j,SkinnedJoint(vec4f(x.x,y.x,z.x,t.x),vec4f(x.y,y.y,z.y,t.y),vec4f(x.z,y.z,z.z,t.z)),crewStandRig[1u+j],slack,false);
    }
  }
  if(lane==0u){
    var lift=0.0;${ground ? `
    if(!gone){lift=continuumGroundLift(place.xz);}` : ''}
    let orders=crewStandOrders[min(person,arrayLength(&crewStandOrders)-1u)];
    let identity=select(slot,(orders>>${CREW_CONTINUUM_IDENTITY_SHIFT}u)-1u,(orders>>${CREW_CONTINUUM_IDENTITY_SHIFT}u)!=0u);
    var flags=${CONTINUUM_KIND.SKINNED}u<<CONTINUUM_KIND_SHIFT;
    if(gone){flags|=CONTINUUM_GONE;}
    if((crewStandRun.flags&2u)!=0u){flags|=CONTINUUM_SEA;}
    if((orders&${CREW_CONTINUUM_ORDER_IMPORTANT}u)!=0u){flags|=CONTINUUM_IMPORTANT_FLAG;}
    if(severed){flags|=CONTINUUM_DAMAGED;}
    crewStandRecords[person]=ContinuumRecord(vec4f(place+vec3f(0.0,lift,0.0),scale),vec4f(0.0,0.0,0.0,1.0),vec4u(flags,at,identity,0u),vec4u(slot,0u,0u,0u));
    skinnedWriteHead(at,${N}u,slack);
  }
}
`;
}

// --------------------------------------------------------------------------------------------- the material
// The crew's material (js/wgsl/continuum-cut.js): each person in their own colours, lit as the crew are (crewShadeLit,
// js/wgsl/crew.js). The full body wears its picture, cloth taking the person's shirt and trousers at the shade the
// picture holds against its region's median; the far body wears each triangle's colour so worn; the splat each region's
// mean, by its share of the outline. Its group 0 is the crew's own (bindings 0 to 14), with the body's picture (15),
// its sampler (16) and its wear (17); the record's first spare word is the person's slot in the crew's actors.
function crewContinuumMaterialWGSL() {
  return /* wgsl */`
// What this person wears where the body is of a region. Skin, hair and paint are worn as the picture has them; cloth
// takes the person's own shirt and trousers, at the shade the picture holds against that region's median, so folds
// and stitching survive any colour. Where cloth is the colour of this body's skin (a label strayed onto a neck or a
// wrist) it is worn as skin. w: how much of it is skin.
fn crewContinuumWorn(region:u32,picture:vec3f,actor:CrewActor)->vec4f {
  let median=crewWear[min(region,4u)];
  if(region==0u||region>=3u||median.w<0.5){return vec4f(picture,select(0.0,1.0,region==3u));}
  let worn=select(actor.trousers.rgb,actor.shirt.rgb,region==1u);
  // Bounded, so a stain or a pale fleck in dark cloth stays a fleck and does not blaze in a pale shirt.
  let shade=clamp(picture/max(median.xyz,vec3f(1e-3)),vec3f(0.35),vec3f(1.45));
  let dyed=worn*mix(vec3f(dot(shade,vec3f(0.299,0.587,0.114))),shade,0.2);
  let skin=crewWear[3u];
  let bright=max(dot(picture,vec3f(0.3333)),1e-3);let skinBright=max(dot(skin.xyz,vec3f(0.3333)),1e-3);
  let away=length(picture/bright-skin.xyz/skinBright)+abs(log2(bright/skinBright))*0.15;
  let cloth=select(1.0,smoothstep(0.1,0.28,away),skin.w>0.5);
  return vec4f(mix(picture,dyed,cloth),1.0-cloth);
}
// A word's colour: three bytes, each the square root of its linear channel.
fn crewContinuumWordColour(word:u32)->vec3f { let c=vec3f(f32(word&255u),f32((word>>8u)&255u),f32((word>>16u)&255u))/255.0;return c*c; }
// The crew's group 0, named whole on a path never taken, so the layout each pipeline derives holds all of it.
fn crewContinuumTouch()->f32 {
  if(continuumView.counts.y!=0xffffffffu){return 0.0;}
  return textureSampleLevel(transLUT,sampC,vec2f(0.0),0.0).x+textureSampleLevel(skyLUT,sampC,vec2f(0.0),0.0).x+textureSampleLevel(envCube,sampC,vec3f(0.0,1.0,0.0),0.0).x
    +textureSampleLevel(captainTex,captainSampler,vec2f(0.0),0.0).x+textureSampleLevel(crewAlbedo,crewAlbedoSampler,vec2f(0.0),0.0).x
    +joints[0][0].x+hull.origin.x+moisture[0].x+crewWear[0].x;
}
fn crewContinuumVarying(s:ContinuumSurface,v:ptr<function,ContinuumVarying>) {
  let slot=s.record.spare.x;
  let actor=actors[slot];
  var region=s.word>>24u;
  var rest=s.local;
  var tone=vec4f(crewContinuumWordColour(s.word),0.0);
  (*v).uv=vec2f(0.5);
  if(s.what==CONTINUUM_SPLAT_ENTRY){
    // Each region's mean, worn, by its share of the outline.
    var colour=vec3f(0.0);var skin=0.0;
    for(var r=0u;r<5u;r++){
      let share=crewWear[5u+r];
      if(share.w<=0.0){continue;}
      let worn=crewContinuumWorn(r,share.xyz,actor);
      colour+=worn.rgb*share.w;skin+=worn.w*share.w;
    }
    tone=vec4f(colour,skin);region=0u;
  }else{
    rest=continuumPointAt(s.model,s.vertex).position;
    if(s.what==CONTINUUM_CLUSTER_ENTRY){(*v).uv=continuumUV(s.vertex);}
    else{tone=crewContinuumWorn(region,tone.rgb,actor);}
  }
  (*v).tone=tone;
  (*v).bodyPos=rest+vec3f(crewContinuumTouch());
  (*v).look=vec4u(s.what,region,slot,crewDressOf(actor.hair.w)>>16u);
  let wound=select(clamp(actor.shirt.w/0.45,0.0,1.0),0.0,actor.shirt.w>0.5);
  (*v).hurt=vec4f(wound,clamp(fract(actor.trousers.w)/0.42,0.0,1.0),fract(actor.skin.w),0.0);
  let base=crewMoistureBase(actor.hair.w);let y=rest.y;
  let lower=mix(moisture[base],moisture[base+1u],smoothstep(.08,.48,y));
  let upper=mix(moisture[base+2u],moisture[base+3u],smoothstep(1.02,1.48,y));
  (*v).wet=mix(lower,upper,smoothstep(.48,1.02,y));
}
fn crewContinuumShade(v:ContinuumVarying,front:bool)->vec4f {
  // Read in uniform control flow; worn only by the full body.
  let picture=textureSample(crewAlbedo,crewAlbedoSampler,v.uv).rgb;
  var surface=v.tone;
  if(v.look.x==CONTINUUM_CLUSTER_ENTRY){surface=crewContinuumWorn(v.look.y,picture,actors[v.look.z]);}
  var c:CrewVertex;
  c.position=v.position;c.world=v.world;c.normal=v.normal;c.color=surface.rgb;c.wet=v.wet;c.skin=clamp(surface.w,0.0,1.0);
  c.bodyPos=v.bodyPos;c.damage=v.hurt.xyz;c.paint=v.look.w;c.actor=v.look.z;
  return vec4f(continuumAir(crewShadeLit(c,front,surface.rgb),v.world),1.0);
}
`;
}
export const CREW_CONTINUUM_MATERIAL = Object.freeze({
  name: 'crewContinuum',
  prelude: () => crewRenderWGSL() + /* wgsl */`
@group(0) @binding(15) var crewAlbedo:texture_2d<f32>;
@group(0) @binding(16) var crewAlbedoSampler:sampler;
@group(0) @binding(17) var<uniform> crewWear:array<vec4f,${CREW_CONTINUUM_WEAR_VEC4S}>;
`,
  core: false, data: Object.freeze({ group: 2, binding: 0 }),
  varyings: Object.freeze([['uv', 'vec2f'], ['tone', 'vec4f'], ['bodyPos', 'vec3f'], ['wet', 'vec2f'], ['look', 'vec4u', true], ['hurt', 'vec4f', true]].map(Object.freeze)),
  wgsl: crewContinuumMaterialWGSL, salt: 17,
  // Sleeves, collars and hems are open shells, lit from whichever side is seen.
  cullMode: 'none', air: true, capture: true,
});

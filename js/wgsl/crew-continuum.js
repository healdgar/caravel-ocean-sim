// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The people continuum's GPU side (js/crew-continuum.js, js/crew-continuum-draw.js). A person is a record of the one
// cut's SKINNED kind (js/wgsl/continuum-kinds.js): the cut, its lists, its handoffs, its shadow and its capture under
// water are the one continuum's (js/wgsl/continuum-cut.js). This supplies three things only: the pass that poses people
// placed on the GPU into the crew's joints and actors, the stand that turns those joints and actors into each person's
// record and pose data, and the crew's material.
import { ENV_MIPS, FRAME_WGSL } from './common.js';
import { CREW_JOINT_BLEND_WGSL, crewRenderWGSL } from './crew.js';
import { CONTINUUM_RECORD_WGSL } from './continuum-cut.js';
import { SKINNED_POSE_WGSL, skinnedPoseVec4s } from './skinned-pose.js';
import { continuumGroundWGSL } from '../continuum-ground.js';
import { CONTINUUM_KIND } from '../continuum-format.js';
import { CREW_JOINT_COUNT, CREW_JOINT_PARENTS, CREW_SLOT } from '../crew-skeleton.js';
import { CREW_CONTINUUM_RIG_VEC4S, CREW_CONTINUUM_WEAR_VEC4S } from '../crew-continuum.js';
import { HUMAN_MORPH_WGSL } from './human-morph.js';

// What the GPU is told of a person, beside their joints and actor record (the batch's orders): bit 0 marks a mounted
// horseback rider, bit 1 as CREW_CONTINUUM_ORDER_IMPORTANT says; above the low two bits, when not 0, who they are plus
// one. Where people are compacted afresh each frame their slot changes, and the hash that thins them and splits their
// samples follows who they are, so no one flickers as others come and go.
export const CREW_CONTINUUM_ORDER_MOUNTED = 1;    // riding astride a horse: stays adult/youth & wears riding breeches
export const CREW_CONTINUUM_ORDER_IMPORTANT = 2;  // wounded, spoken to or aimed at: cut at the core's CONTINUUM_IMPORTANT
export const CREW_CONTINUUM_AGE_SHIFT = 2;        // bits 2..8: exact board age in years (0 = fallback deterministic life stage)
export const CREW_CONTINUUM_IDENTITY_SHIFT = 9;   // bits 9..31: stable person identity + 1 (8.3M unique IDs)
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
    let ageWord=((at.who.z>>8u)&127u)<<${CREW_CONTINUUM_AGE_SHIFT}u;
    orders[person]=(at.who.z&3u)|ageWord|((at.who.x+1u)<<${CREW_CONTINUUM_IDENTITY_SHIFT}u);
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
  return FRAME_WGSL + CONTINUUM_RECORD_WGSL + SKINNED_POSE_WGSL + HUMAN_MORPH_WGSL + (ground ? continuumGroundWGSL(0, 10) : '') + /* wgsl */`
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
  let slack=crewStandRig[0].y+0.08+select(0.0,${CREW_CONTINUUM_SEVERED_SLACK.toFixed(2)},severed);
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
    let realAge=(orders>>${CREW_CONTINUUM_AGE_SHIFT}u)&127u;
    let isMounted=(orders&${CREW_CONTINUUM_ORDER_MOUNTED}u)!=0u;
    let female=actor.skin.w>0.5&&actor.skin.w<1.5;
    let stage=humanLifeStageFromAge(realAge,identity,${ground ? 'true' : 'false'},isMounted);
    // Townsfolk bake baseScale into actor.transform on placement; deck crew apply height diversity directly here!
    let finalScale=select(scale,scale*stage.x,${ground ? 'false' : 'true'}&&abs(scale-1.0)<0.01);
    let morphZ=humanMorphPackZ(identity,female);
    // Set HUMAN_MORPH_BODY_INSET_BIT on the clothed body skin record alone (cleared when forwarded to clothing & hair!)
    let morphW=humanMorphPackW(stage.y,stage.z,isMounted)|HUMAN_MORPH_BODY_INSET_BIT;
    var flags=${CONTINUUM_KIND.SKINNED}u<<CONTINUUM_KIND_SHIFT;
    if(gone){flags|=CONTINUUM_GONE;}
    if((crewStandRun.flags&2u)!=0u){flags|=CONTINUUM_SEA;}
    if((orders&${CREW_CONTINUUM_ORDER_IMPORTANT}u)!=0u){flags|=CONTINUUM_IMPORTANT_FLAG;}
    if(severed){flags|=CONTINUUM_DAMAGED;}
    crewStandRecords[person]=ContinuumRecord(vec4f(place+vec3f(0.0,lift,0.0),finalScale),vec4f(0.0,0.0,0.0,1.0),vec4u(flags,at,identity,0u),vec4u(slot,0u,morphZ,morphW));
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
// and stitching survive any colour. Where cloth is the colour of this body's skin on a neck or wrist border, it is
// worn as skin; where white blouse texels bled onto the anatomical neck cylinder, they wear the body's skin.
// Mirrors crewContinuumHairStand's deterministic groom roll so the scalp under-coat matches each person's exact 3D groom:
// 0 = shaved dome (no scalp under-coat), 1 = full hair-bearing scalp under-coat, 2 = tonsure fringe (crown dome left bare).
fn crewScalpMode(actor:CrewActor,identity:u32,slot:u32)->f32 {
  let female=actor.skin.w>0.5&&actor.skin.w<1.5;
  let indigenous=actor.face.w>1.5;
  if(female||indigenous){return 1.0;}
  let hasComp=actor.face.w<0.0;
  let compMask=select(0u,u32((-actor.face.w)*0.5),hasComp);
  let hairCode=compMask&7u;
  if(hairCode>=1u&&hairCode<=5u){return 1.0;}
  var h=(identity*131u+1u)*0x9e3779b1u+0x85ebca6bu;
  h=(h^(h>>15u))*0x2c1b3c6du;
  h=h^(h>>13u);
  let roll=h&31u;
  if(roll==0u){return 0.0;}
  if(roll<=3u){return 2.0;}
  return 1.0;
}
fn crewContinuumWorn(region:u32,picture:vec3f,actor:CrewActor,bodyPos:vec3f,scalpMode:f32)->vec4f {
  // Clean undressed anatomical base bodies:
  //   region 3 = skin (tinted seamlessly by each person's actor.skin.rgb — zero baked clothes, zero garment stains!)
  //   region 4 = legacy high-forehead brow tag -> treated as skin so no floating brow stripe ever appears on the forehead
  //   region 0 = eye opening (sclera & iris kept verbatim; surrounding eyelids/sockets tinted as skin; true brow ridge tinted as hair)
  //   region 1/2 = fallback dyed cloth only if a legacy body is ever loaded
  let female=actor.skin.w>0.5&&actor.skin.w<1.5;
  let skin=crewWear[3u];
  let skinLuma=max(dot(skin.xyz,vec3f(0.299,0.587,0.114)),1e-3);
  let picLuma=dot(picture,vec3f(0.299,0.587,0.114));

  // Preserve full 4K/8K painted skin detail (cheeks, lips, eyelid creases, nostrils, pores) while transferring cleanly
  // to each person's actor.skin.rgb with a gentle blue-channel ceiling so cool shadow texels never turn lavender/grey.
  let lumaRatio=clamp(picLuma/skinLuma,0.34,1.52);
  let softLuma=mix(1.0,lumaRatio,0.88);
  let rawShade=clamp(picture/max(skin.xyz,vec3f(1e-3)),vec3f(0.34),vec3f(1.52));
  let safeShade=vec3f(rawShade.r,rawShade.g,min(rawShade.b,lumaRatio*1.06));
  var skinTone=actor.skin.rgb*mix(vec3f(softLuma),safeShade,0.62);

  // Gentle lip warmth reinforcement (4K/8K painted texture already carries natural lip color).
  let lipY=select(1.584,1.506,female);
  let lipZ=select(0.082,0.095,female);
  let lipD=length(vec2f(bodyPos.x/0.024,(bodyPos.y-lipY)/0.0085));
  let lipMask=step(lipZ,bodyPos.z)*(1.0-smoothstep(0.65,1.15,lipD));
  skinTone=mix(skinTone,skinTone*vec3f(1.06,0.88,0.86),lipMask*0.16);

  var baseOut=vec4f(picture,0.0);
  if(region==0u){
    // Actual mesh eye vertices: preserve the 4K/8K painted iris, pupil, lash-line, and natural white sclera verbatim,
    // only capping extreme specular highlights so eyes stay lifelike rather than chalky or muddy grey.
    let eyeCol=min(picture,vec3f(0.76,0.74,0.72));
    baseOut=vec4f(eyeCol,0.0);
  }else if(region==3u||region==4u){
    // Keep surrounding face/eyelid skin continuous in actor.skin; preserve any bright sclera or true dark pupil/iris
    // texels strictly inside the palpebral fissure with a soft feathered transition so shadowed eyelid creases never smudge.
    let eyeX=select(0.0275,0.0300,female);
    let eyeY=select(1.654,1.579,female);
    let eyeRel=vec2f((abs(bodyPos.x)-eyeX)/0.0145,(bodyPos.y-eyeY)/0.0085);
    let inEyeBox=smoothstep(0.048,0.062,bodyPos.z)*(1.0-smoothstep(0.35,1.00,dot(eyeRel,eyeRel)));
    let brightSclera=smoothstep(skinLuma*1.18,skinLuma*1.48,picLuma);
    let lowWarmth=1.0-smoothstep(0.10,0.24,picture.r-picture.b);
    let darkIrisLash=(1.0-smoothstep(skinLuma*0.16,skinLuma*0.36,picLuma))*lowWarmth;
    let eyeOpen=inEyeBox*max(brightSclera,darkIrisLash);
    let eyeCol=min(picture,vec3f(0.76,0.74,0.72));
    baseOut=vec4f(mix(skinTone,eyeCol,eyeOpen),1.0-eyeOpen);
  }else if(region==1u||region==2u){
    let median=crewWear[min(region,4u)];
    if(median.w>=0.5){
      let worn=select(actor.trousers.rgb,actor.shirt.rgb,region==1u);
      let shade=clamp(picture/max(median.xyz,vec3f(1e-3)),vec3f(0.35),vec3f(1.45));
      baseOut=vec4f(worn*mix(vec3f(dot(shade,vec3f(0.299,0.587,0.114))),shade,0.2),0.0);
    }
  }
  // Softly harmonize the painted 4K/8K eyebrows toward each person's actor.hair.rgb without stamping opaque stripes over skin.
  let axFace=abs(bodyPos.x);
  let browMinZ=select(0.066,0.078,female);
  if(baseOut.w>0.5&&bodyPos.z>browMinZ&&axFace>0.011&&axFace<0.054){
    let browArch=select(
      1.6730+0.0058*smoothstep(0.015,0.039,axFace)-0.0026*smoothstep(0.041,0.052,axFace),
      1.6005+0.0055*smoothstep(0.015,0.037,axFace)-0.0022*smoothstep(0.039,0.047,axFace),
      female
    );
    let browEndX=select(0.051,0.046,female);
    let browXMask=smoothstep(0.013,0.018,axFace)*(1.0-smoothstep(browEndX-0.007,browEndX,axFace));
    let browHalfH=select(0.0042,0.0034,female)*(0.65+0.35*browXMask);
    let browYMask=1.0-smoothstep(browHalfH*0.40,browHalfH*1.20,abs(bodyPos.y-browArch));
    let browDark=1.0-smoothstep(skinLuma*0.58,skinLuma*0.95,picLuma);
    let browCov=browXMask*browYMask*browDark;
    if(browCov>0.002){
      let hairCol=max(actor.hair.rgb,vec3f(0.012,0.010,0.008));
      let browTint=hairCol*(0.75+0.35*clamp(picLuma/max(skinLuma*0.75,1e-3),0.2,1.2));
      baseOut=vec4f(mix(baseOut.rgb,browTint,browCov*0.72),mix(baseOut.w,0.0,browCov*0.72));
    }
  }
  // Fibrous hair-root scalp under-coat: softly tints & texturizes the hair-bearing cranium inside the 3D strand hairline
  // with the person's darkened root hair pigment so bare scalp never flashes between locks from any angle or distance.
  let crownY=select(1.770,1.692,female);
  if(bodyPos.y>crownY-0.180&&baseOut.w>0.5&&scalpMode>0.5){
    let midZ=select(-0.010,-0.003,female);
    let ax=abs(bodyPos.x);
    let rz=bodyPos.z-midZ;
    let wispNoise=sin(bodyPos.x*220.0+bodyPos.z*140.0)*0.0028+sin(bodyPos.x*470.0-bodyPos.y*280.0)*0.0014;
    let widowDip=0.005*exp(-((bodyPos.x/0.020)*(bodyPos.x/0.020)));
    let templeRec=0.005*exp(-(((ax-0.044)/0.020)*((ax-0.044)/0.020)));
    let foreLine=(crownY-0.050)-widowDip+templeRec+wispNoise;
    let sideburnMask=smoothstep(0.048,0.058,ax)*(1.0-smoothstep(0.032,0.048,rz))*smoothstep(crownY-0.138,crownY-0.118,bodyPos.y);
    let frontMask=max(select(1.0,smoothstep(foreLine-0.005,foreLine+0.014,bodyPos.y),rz>0.008),sideburnMask);
    let earDy=(bodyPos.y-(crownY-0.128))/0.034;
    let earDz=(rz+0.018)/0.026;
    let earKeep=smoothstep(0.90,1.25,earDy*earDy+earDz*earDz+select(2.0,0.0,ax>0.052));
    let napeLine=(crownY-0.165)+0.024*max(0.0,(rz+0.075)*4.0)+wispNoise;
    let napeMask=smoothstep(napeLine-0.004,napeLine+0.018,bodyPos.y);
    let tonsureR=length(vec2f(bodyPos.x/0.058,(rz+0.004)/0.070));
    let tonsureKeep=select(1.0,max(smoothstep(0.86,1.10,tonsureR),1.0-smoothstep(crownY-0.072,crownY-0.056,bodyPos.y)),scalpMode>1.5);
    let cranialMask=frontMask*earKeep*napeMask;
    let scalpCov=cranialMask*tonsureKeep;
    if(scalpCov>0.002){
      let hairCol=max(actor.hair.rgb,vec3f(0.010,0.008,0.007));
      let fiberA=sin(bodyPos.x*520.0+sin(bodyPos.z*190.0)*1.6);
      let fiberB=sin((bodyPos.x*0.7+bodyPos.z*0.7)*860.0+bodyPos.y*240.0);
      let rootGrain=0.38+0.14*(0.5+0.5*fiberA)+0.08*(0.5+0.5*fiberB);
      let scalpTint=hairCol*rootGrain;
      baseOut=vec4f(mix(baseOut.rgb,scalpTint,scalpCov*0.92),mix(baseOut.w,0.0,scalpCov*0.92));
    }
  }
  return baseOut;
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
  let scalpMode=crewScalpMode(actor,s.record.tag.z,slot);
  if(s.what==CONTINUUM_SPLAT_ENTRY){
    // Each region's mean, worn, by its share of the outline.
    var colour=vec3f(0.0);var skin=0.0;
    for(var r=0u;r<5u;r++){
      let share=crewWear[5u+r];
      if(share.w<=0.0){continue;}
      let worn=crewContinuumWorn(r,share.xyz,actor,vec3f(0.0,1.0,0.0),0.0);
      colour+=worn.rgb*share.w;skin+=worn.w*share.w;
    }
    tone=vec4f(colour,skin);region=0u;
  }else{
    rest=continuumPointAt(s.model,s.vertex).position;
    if(s.what==CONTINUUM_CLUSTER_ENTRY){(*v).uv=continuumUV(s.vertex);}
    else{tone=crewContinuumWorn(region,tone.rgb,actor,rest,scalpMode);}
  }
  (*v).tone=tone;
  (*v).bodyPos=rest+vec3f(crewContinuumTouch());
  (*v).look=vec4u(s.what,region,slot,crewDressOf(actor.hair.w)>>16u);
  let wound=select(clamp(actor.shirt.w/0.45,0.0,1.0),0.0,actor.shirt.w>0.5);
  (*v).hurt=vec4f(wound,clamp(fract(actor.trousers.w)/0.42,0.0,1.0),fract(actor.skin.w),scalpMode);
  let base=crewMoistureBase(actor.hair.w);let y=rest.y;
  let lower=mix(moisture[base],moisture[base+1u],smoothstep(.08,.48,y));
  let upper=mix(moisture[base+2u],moisture[base+3u],smoothstep(1.02,1.48,y));
  (*v).wet=mix(lower,upper,smoothstep(.48,1.02,y));
}
fn crewContinuumShade(v:ContinuumVarying,front:bool)->vec4f {
  // Read in uniform control flow; worn only by the full body.
  let picture=textureSample(crewAlbedo,crewAlbedoSampler,v.uv).rgb;
  var surface=v.tone;
  if(v.look.x==CONTINUUM_CLUSTER_ENTRY){surface=crewContinuumWorn(v.look.y,picture,actors[v.look.z],v.bodyPos,v.hurt.w);}
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

// --------------------------------------------------------------------------------------------- strand hair & beards
// Pairs each stood person with up to two records in the hair continuum (2 * person = scalp groom 0..8, 2 * person + 1 =
// facial groom 9..11), sharing the person's posed joint palette in skinnedPoses and writing walking/stride sway into
// skinnedPoses[at].zw so CONTINUUM_KIND.SKINNED bends free strand tips with both wind and movement.
export function crewContinuumHairStandWGSL() {
  const N = CREW_JOINT_COUNT;
  return CONTINUUM_RECORD_WGSL + /* wgsl */`
struct CrewStandActor { transform:mat4x4f, shirt:vec4f, trousers:vec4f, skin:vec4f, hair:vec4f, face:vec4f };
struct CrewHairInfo { scalpShift:vec4f, beardShift:vec4f, counts:vec4u };
@group(0) @binding(0) var<storage,read> crewStandRecords:array<ContinuumRecord>;
@group(0) @binding(1) var<storage,read_write> skinnedPoses:array<vec4f>;
@group(0) @binding(2) var<storage,read> crewStandActors:array<CrewStandActor>;
@group(0) @binding(3) var<uniform> crewHairInfo:CrewHairInfo;
@group(0) @binding(4) var<storage,read_write> hairRecords:array<ContinuumRecord>;

fn crewHairHash(v:u32)->u32 {
  var h=v*0x9e3779b1u+0x85ebca6bu;
  h=(h^(h>>15u))*0x2c1b3c6du;
  return h^(h>>13u);
}

@compute @workgroup_size(64) fn crewContinuumHairStand(@builtin(global_invocation_id) gid:vec3u){
  let person=gid.x;
  let cap=crewHairInfo.counts.x;
  if(person>=cap){return;}
  let rec=crewStandRecords[person];
  let at=rec.tag.y;
  let headSph=skinnedPoses[at+1u+${N}u*3u+9u];
  let personGone=(rec.tag.x&CONTINUUM_GONE)!=0u||headSph.w<0.0;
  let baseFlags=rec.tag.x&(~65535u)&(~CONTINUUM_GONE);
  if(personGone){
    let dead=ContinuumRecord(rec.place,rec.turn,vec4u(baseFlags|CONTINUUM_GONE,at,rec.tag.z*2u,0u),vec4u(rec.spare.x,0u,0u,0u));
    hairRecords[person*2u]=dead;
    hairRecords[person*2u+1u]=dead;
    return;
  }

  let slot=min(rec.spare.x,arrayLength(&crewStandActors)-1u);
  let actor=crewStandActors[slot];
  let identity=rec.tag.z;
  let h=crewHairHash(identity*131u+1u);

  // Instantaneous gait sway from posed left/right foot separation + head forward trailing drag.
  let m0=skinnedPoses[at+1u+9u*3u];
  let m1=skinnedPoses[at+1u+9u*3u+1u];
  let m2=skinnedPoses[at+1u+9u*3u+2u];
  let footL=vec2f(skinnedPoses[at+1u+83u*3u].w,skinnedPoses[at+1u+83u*3u+2u].w);
  let footR=vec2f(skinnedPoses[at+1u+91u*3u].w,skinnedPoses[at+1u+91u*3u+2u].w);
  let stride=footL-footR;
  let gait=clamp(length(stride)-0.22,0.0,0.65);
  let fwdXZ=vec2f(m0.z,m2.z);
  skinnedPoses[at]=vec4f(skinnedPoses[at].xy,clamp(-fwdXZ*gait*0.048+stride*0.022,vec2f(-0.042),vec2f(0.042)));

  let female=crewHairInfo.scalpShift.w>0.5||(actor.skin.w>0.5&&actor.skin.w<1.5);
  let indigenous=actor.face.w>1.5;
  let hasComp=actor.face.w<0.0;
  let compMask=select(0u,u32((-actor.face.w)*0.5),hasComp);
  let hairCode=compMask&7u;
  let beardCode=(compMask>>6u)&3u;

  var scalpType=0u;
  var scalpGone=false;
  if(indigenous){
    if(female){scalpType=select(8u,7u,(h&7u)==0u);}
    else{scalpType=select(3u,0u,(h&7u)==0u);}
  }else if(female){
    if(hairCode==4u){scalpType=6u;}
    else if(hairCode==5u){scalpType=7u;}
    else if(hairCode==3u){scalpType=8u;}
    else if(hairCode==1u||hairCode==2u){scalpType=5u;}
    else{scalpType=5u+(h&3u);}
  }else{
    if(hairCode==1u){scalpType=0u;}
    else if(hairCode==2u||hairCode==4u||hairCode==5u){scalpType=1u;}
    else if(hairCode==3u){scalpType=2u;}
    else{
      // Note: reconcileColonialGroomAndComp zeroes hairCode when hat!=0 (though hats are not drawn on continuum bodies),
      // so roll full period hair for most hairCode==0 men, leaving ~12% tonsure fringe and ~6% shaved dome.
      let roll=h&31u;
      if(roll==0u){scalpGone=true;}
      else if(roll<=3u){scalpType=4u;}
      else if(roll<=13u){scalpType=0u;}
      else if(roll<=23u){scalpType=1u;}
      else{scalpType=2u;}
    }
  }

  var beardType=9u;
  var beardGone=true;
  if(!female&&!indigenous){
    if(beardCode==1u){beardType=9u;beardGone=false;}
    else if(beardCode==2u){beardType=10u;beardGone=false;}
    else if(beardCode==3u){beardType=11u;beardGone=false;}
    else{
      let bRoll=(h>>4u)&7u;
      if(bRoll==2u||bRoll==3u){beardType=9u;beardGone=false;}
      else if(bRoll==4u||bRoll==5u){beardType=10u;beardGone=false;}
      else if(bRoll>=6u){beardType=11u;beardGone=false;}
    }
  }

  let isChild=(rec.spare.w&255u)>45u;
  if(isChild){
    beardGone=true;
    if(scalpGone||scalpType==4u){scalpGone=false;scalpType=select(0u,5u,female);}
  }

  let scale=rec.place.w;
  let ds=crewHairInfo.scalpShift.xyz;
  let db=crewHairInfo.beardShift.xyz;
  let scalpDelta=vec3f(dot(m0.xyz,ds),dot(m1.xyz,ds),dot(m2.xyz,ds))*scale;
  let beardDelta=vec3f(dot(m0.xyz,db),dot(m1.xyz,db),dot(m2.xyz,db))*scale;
  let reachWord=bitcast<u32>(0.14f);

  let sFlags=select(baseFlags|scalpType,baseFlags|CONTINUUM_GONE,scalpGone);
  let bFlags=select(baseFlags|beardType,baseFlags|CONTINUUM_GONE,beardGone);
  let cleanW=rec.spare.w&(~(1u<<17u));
  hairRecords[person*2u]=ContinuumRecord(vec4f(rec.place.xyz+scalpDelta,scale),rec.turn,vec4u(sFlags,at,identity*2u,reachWord),vec4u(slot,scalpType,rec.spare.z,cleanW));
  hairRecords[person*2u+1u]=ContinuumRecord(vec4f(rec.place.xyz+beardDelta,scale),rec.turn,vec4u(bFlags,at,identity*2u+1u,reachWord),vec4u(slot,beardType,rec.spare.z,cleanW));
}
`;
}

function hairContinuumMaterialWGSL() {
  return /* wgsl */`
fn hairContinuumDecodeOct(u:f32,v:f32)->vec3f {
  let fx=u*2.0-1.0;let fy=v*2.0-1.0;
  var n=vec3f(fx,fy,1.0-abs(fx)-abs(fy));
  let t=max(-n.z,0.0);
  n.x+=select(t,-t,n.x>=0.0);
  n.y+=select(t,-t,n.y>=0.0);
  return normalize(n);
}
fn hairContinuumTouch()->f32 {
  if(continuumView.counts.y!=0xffffffffu){return 0.0;}
  return textureSampleLevel(transLUT,sampC,vec2f(0.0),0.0).x+textureSampleLevel(skyLUT,sampC,vec2f(0.0),0.0).x+textureSampleLevel(envCube,sampC,vec3f(0.0,1.0,0.0),0.0).x
    +textureSampleLevel(captainTex,captainSampler,vec2f(0.0),0.0).x+sunVis[0]+joints[0][0].x+hull.origin.x+moisture[0].x+actors[0].hair.x;
}
fn hairContinuumVarying(s:ContinuumSurface,v:ptr<function,ContinuumVarying>) {
  let slot=s.record.spare.x;
  let actor=actors[slot];
  let baseHair=max(actor.hair.rgb,vec3f(0.010,0.008,0.007));
  let data=continuumKindData(s.record);
  let count=u32(continuumPoses[data].x);
  var tLocal=vec3f(0.0,-1.0,0.0);
  var along=0.5;
  var crossV=0.0;
  var lockTone=0.5;
  var seedPhase=0.5;
  if(s.what!=CONTINUUM_SPLAT_ENTRY){
    let tu=f32(s.word&255u)/255.0;
    let tv=f32((s.word>>8u)&255u)/255.0;
    tLocal=hairContinuumDecodeOct(tu,tv);
    lockTone=f32((s.word>>16u)&255u)/255.0;
    seedPhase=f32((s.word>>24u)&255u)/255.0;
    if(s.what==CONTINUUM_CLUSTER_ENTRY){
      let hv=continuumPointAt(s.model,s.vertex).high;
      along=f32(hv&255u)/255.0;
      crossV=f32((hv>>8u)&255u)/255.0*2.0-1.0;
    }else{
      // Far hair shell: derive smooth crown-to-tip flow & azimuth fiber coordinate so far hair keeps natural strand sheen.
      along=clamp((1.75-s.local.y)*4.2,0.0,1.0);
      crossV=sin(atan2(s.local.x,s.local.z+0.01)*9.0);
    }
  }
  var tWorld=tLocal;
  if(count>9u){
    let mHead=continuumSkinnedJoint(data,count,9u);
    let tr=vec4f(tLocal,0.0)*mHead;
    if(length(tr)>1e-4){tWorld=normalize(tr);}
  }
  (*v).fiberT=tWorld+vec3f(hairContinuumTouch());
  (*v).strand=vec4f(along,crossV,lockTone,seedPhase);
  let elderness=f32((s.record.spare.w>>8u)&255u)*(1.0/255.0);
  (*v).tone=mix(baseHair,vec3f(0.46,0.44,0.42),smoothstep(0.30,1.0,elderness)*0.75);
  let mBase=crewMoistureBase(actor.hair.w);
  (*v).wet=moisture[mBase+3u];
}
fn hairContinuumShade(v:ContinuumVarying,front:bool)->vec4f {
  var n=normalize(select(-v.normal,v.normal,front));
  var T=v.fiberT;
  let tl=length(T);
  T=select(vec3f(0.0,-1.0,0.0),T/max(tl,1e-4),tl>1e-4);
  let along=clamp(v.strand.x,0.0,1.0);
  let crossV=clamp(v.strand.y,-1.0,1.0);
  let lockTone=v.strand.z;
  let seedPhase=v.strand.w;

  // Dense multi-frequency individual hair-fiber striations, fwidth band-limited to eliminate shimmer/banding with distance.
  let B=normalize(cross(n,T)+vec3f(1e-5,0.0,0.0));
  let wobble=sin(along*14.0+seedPhase*6.2831853)*0.22;
  let uFiber=crossV+wobble;
  let du=max(fwidth(uFiber),1e-4);
  let band1=1.0-smoothstep(0.08,0.28,du);
  let band2=1.0-smoothstep(0.035,0.14,du);
  let band3=1.0-smoothstep(0.018,0.075,du);
  let micro=sin(uFiber*28.27+seedPhase*6.2831853)*band1;
  let micro2=sin(uFiber*62.83-seedPhase*12.566+along*4.0)*band2;
  let micro3=sin(uFiber*113.10+seedPhase*18.85-along*7.5)*band3;
  let edgeFluff=smoothstep(0.55,1.0,abs(crossV));
  n=normalize(n+B*(crossV*0.32+micro*0.18+micro2*0.10+micro3*0.05));

  // Root-to-tip melanin variation, deep follicle root AO, sub-strand striations, and soft sun-kissed tips.
  let rootAO=mix(0.36,1.0,smoothstep(0.0,0.28,along));
  let fiberShade=0.84+0.12*micro+0.07*micro2+0.04*micro3-edgeFluff*0.10;
  let lockVar=mix(0.68,1.34,lockTone)*fiberShade;
  let tipWarm=mix(vec3f(1.0),vec3f(1.16,1.08,0.94),along*along*0.45);
  let wet=clamp(v.wet,vec2f(0.0),vec2f(1.0));
  let albedo=clamp(v.tone*lockVar*tipWarm*mix(1.0,0.62,wet.x),vec3f(0.005),vec3f(0.92));

  let sun=F.sunDir.xyz;
  let shadowSample=vesselShadow(v.world,n);
  let direct=sunIlluminance()*sunVis[0]*step(0.0,sun.y)*solarShadowVisibility(shadowSample);
  let sky=textureSampleLevel(envCube,sampC,vec3f(0.0,1.0,0.0),${ENV_MIPS - 1}.0).rgb;
  let sea=textureSampleLevel(envCube,sampC,normalize(vec3f(n.x,-0.65,n.z)),${ENV_MIPS - 1}.0).rgb;
  let ambient=vesselAmbient(n,sky,sea)*rootAO;
  let view=normalize(F.camPos.xyz-v.world);
  let H=normalize(sun+view);

  // Marschner / Kajiya-Kay dual-lobe anisotropic hair fiber highlights:
  //   R-lobe: cuticular surface glint shifted slightly toward root
  //   TRT-lobe: internal pigment-tinted sheen shifted toward tip
  let T1=normalize(T-n*0.09);
  let T2=normalize(T+n*0.15);
  let sinTH1=sqrt(max(0.0,1.0-clamp(dot(T1,H),-1.0,1.0)*clamp(dot(T1,H),-1.0,1.0)));
  let sinTH2=sqrt(max(0.0,1.0-clamp(dot(T2,H),-1.0,1.0)*clamp(dot(T2,H),-1.0,1.0)));
  let atten=smoothstep(-0.25,0.45,dot(n,sun))*rootAO;
  let specR=pow(sinTH1,mix(48.0,110.0,wet.y))*mix(0.022,0.058,wet.y)*atten;
  let tintTRT=pow(max(albedo,vec3f(0.010)),vec3f(0.75))*1.45;
  let specTRT=pow(sinTH2,22.0)*0.068*atten*(1.0-wet.x*0.35)*tintTRT;

  // Soft wrapped fiber diffuse + backlit forward scatter through thin wisps & strand tips.
  let wrapDiff=max(0.0,(dot(n,sun)+0.32)/1.32)/3.14159265*rootAO;
  let backScatter=pow(clamp(dot(-sun,view),0.0,1.0),4.0)*(0.18+0.42*along)*atten*albedo*1.4;
  let skyGlint=textureSampleLevel(envCube,sampC,reflect(-view,n),5.5).rgb*0.014*rootAO;
  let rough=mix(0.76,0.44,wet.y);
  let f0=vec3f(0.04);
  let col=lunarSurface(n,view,albedo,rough,f0,sunVis[1]*lunarShadowVisibility(shadowSample))
    +lightningSurface(n,view,albedo,rough)+gunFlashSurface(v.world,n,view,albedo,rough)+worldFireSurface(v.world,n,view,albedo,rough)
    +albedo*(direct*wrapDiff+ambient)+direct*(vec3f(specR)+specTRT+backScatter)+skyGlint*F.windP[1].w;
  return vec4f(continuumAir(col,v.world),1.0);
}
`;
}

export const HAIR_CONTINUUM_MATERIAL = Object.freeze({
  name: 'hairContinuum',
  prelude: () => crewRenderWGSL(),
  core: false, data: Object.freeze({ group: 2, binding: 0 }),
  varyings: Object.freeze([['fiberT', 'vec3f'], ['strand', 'vec4f'], ['tone', 'vec3f'], ['wet', 'vec2f']].map(Object.freeze)),
  wgsl: hairContinuumMaterialWGSL, salt: 19,
  cullMode: 'none', air: true, capture: true,
});

// --------------------------------------------------------------------------------------------- kinematic 1550 clothing
// Pairs each stood undressed person with up to three separate physical 3D garment records in the clothing continuum
// (3 * person + 0 = upper garment, + 1 = lower garment + belt + shoes, + 2 = optional shoulder cloak), sharing the
// exact same posed 93-joint palette in skinnedPoses (including walking stride sway in skinnedPoses[at].zw) so skirts,
// sleeves, tunics, and cloaks deform and billow physically on the GPU with zero garment-to-garment stain bleed.
export function crewContinuumClothingStandWGSL() {
  return CONTINUUM_RECORD_WGSL + /* wgsl */`
struct CrewStandActor { transform:mat4x4f, shirt:vec4f, trousers:vec4f, skin:vec4f, hair:vec4f, face:vec4f };
struct CrewClothInfo { counts:vec4u }; // x=count, y=female(0/1), z=roleCode(0=hand,1=captain,2=soldier,3=indigenous), w=pad
@group(0) @binding(0) var<storage,read> crewStandRecords:array<ContinuumRecord>;
@group(0) @binding(1) var<storage,read> crewStandActors:array<CrewStandActor>;
@group(0) @binding(2) var<uniform> crewClothInfo:CrewClothInfo;
@group(0) @binding(3) var<storage,read_write> clothRecords:array<ContinuumRecord>;

fn crewClothHash(v:u32)->u32 {
  var h=v*0x9e3779b1u+0x85ebca6bu;
  h=(h^(h>>15u))*0x2c1b3c6du;
  return h^(h>>13u);
}

@compute @workgroup_size(64) fn crewContinuumClothingStand(@builtin(global_invocation_id) gid:vec3u){
  let person=gid.x;
  let cap=crewClothInfo.counts.x;
  if(person>=cap){return;}
  let rec=crewStandRecords[person];
  let at=rec.tag.y;
  let personGone=(rec.tag.x&CONTINUUM_GONE)!=0u;
  let baseFlags=rec.tag.x&(~65535u)&(~CONTINUUM_GONE);
  if(personGone){
    let dead=ContinuumRecord(rec.place,rec.turn,vec4u(baseFlags|CONTINUUM_GONE,at,rec.tag.z*3u,0u),vec4u(rec.spare.x,0u,0u,0u));
    clothRecords[person*3u]=dead;
    clothRecords[person*3u+1u]=dead;
    clothRecords[person*3u+2u]=dead;
    return;
  }

  let slot=min(rec.spare.x,arrayLength(&crewStandActors)-1u);
  let actor=crewStandActors[slot];
  let identity=rec.tag.z;
  let h=crewClothHash(identity*197u+7u);

  let female=crewClothInfo.counts.y!=0u||(actor.skin.w>0.5&&actor.skin.w<1.5);
  let roleCode=crewClothInfo.counts.z;
  let indigenous=roleCode==3u||actor.face.w>1.5;
  let isChild=(rec.spare.w&255u)>45u;
  let isMounted=((rec.spare.w>>16u)&1u)!=0u;

  var upperType=0u;
  var lowerType=7u;
  var cloakGone=true;

  if(indigenous){
    if(female){
      upperType=6u; // indigenous-huipil-f
      lowerType=select(12u,14u,isMounted); // tailored riding breeches when astride a horse
    }else{
      upperType=5u; // indigenous-tunic-m
      lowerType=11u; // indigenous-breechcloth-m
    }
  }else if(female){
    // European women: gathered linen chemise blouse or laced bodice;
    // pleated kirtle / apron skirt on foot, tailored female riding breeches when riding astride a horse!
    upperType=select(3u,4u,(h&1u)!=0u);
    lowerType=select(select(9u,10u,((h>>1u)&1u)!=0u),14u,isMounted);
  }else if(roleCode==1u){
    // Captain / Iberian officer: tailored doublet + paned trunk hose + shoulder cloak!
    upperType=1u;
    lowerType=8u;
    cloakGone=isChild;
  }else if(roleCode==2u){
    // Tercio / presidio garrison soldier: buff leather jerkin + trunk hose!
    upperType=2u;
    lowerType=8u;
  }else{
    // European mariner / townsman / rower: 72% loose open V-neck linen shirt + mariner slops,
    // 28% tailored doublet + trunk hose; never equip stiff shoulder cloaks on common townsfolk or seated barge rowers!
    let styleRoll=(h&15u);
    upperType=select(0u,1u,styleRoll>=11u&&!isChild);
    lowerType=select(7u,8u,styleRoll>=11u&&!isChild);
    cloakGone=true;
  }

  // Generous reach margin (0.72 m) so cluster bounding spheres rooted on pelvis/spine_02 always cover outstretched sleeves & morphed builds.
  let reachWord=bitcast<u32>(0.72f);
  let cleanW=rec.spare.w&(~(1u<<17u));
  clothRecords[person*3u]=ContinuumRecord(rec.place,rec.turn,vec4u(baseFlags|upperType,at,identity*3u,reachWord),vec4u(slot,upperType,rec.spare.z,cleanW));
  clothRecords[person*3u+1u]=ContinuumRecord(rec.place,rec.turn,vec4u(baseFlags|lowerType,at,identity*3u+1u,reachWord),vec4u(slot,lowerType,rec.spare.z,cleanW));
  let cFlags=select(baseFlags|13u,baseFlags|CONTINUUM_GONE,cloakGone);
  clothRecords[person*3u+2u]=ContinuumRecord(rec.place,rec.turn,vec4u(cFlags,at,identity*3u+2u,reachWord),vec4u(slot,13u,rec.spare.z,cleanW));
}
`;
}

function clothingContinuumMaterialWGSL() {
  return /* wgsl */`
fn clothContinuumTouch()->f32 {
  if(continuumView.counts.y!=0xffffffffu){return 0.0;}
  return textureSampleLevel(transLUT,sampC,vec2f(0.0),0.0).x+textureSampleLevel(skyLUT,sampC,vec2f(0.0),0.0).x+textureSampleLevel(envCube,sampC,vec3f(0.0,1.0,0.0),0.0).x
    +textureSampleLevel(captainTex,captainSampler,vec2f(0.0),0.0).x+sunVis[0]+joints[0][0].x+hull.origin.x+moisture[0].x+actors[0].shirt.x;
}
fn clothContinuumChannelColor(ch:u32,actor:CrewActor)->vec3f {
  switch ch {
    case 0u: { return actor.shirt.rgb; }
    case 1u: { return actor.trousers.rgb; }
    case 2u: { return vec3f(0.74,0.71,0.64); }    // crisp off-white linen (chemise sleeves, collar/cuff trim, working apron)
    case 3u: { return vec3f(0.068,0.044,0.028); } // dark oiled leather (belt, shoes/boots)
    case 4u: { return vec3f(0.46,0.30,0.08); }    // burnished brass (buckle, studs)
    case 5u: { return vec3f(0.32,0.21,0.11); }    // buff leather / tan hide (soldier jerkin, moccasins)
    case 6u: { return vec3f(0.055,0.052,0.058); } // dark charcoal wool (fitted hose/stockings, officer cloak)
    default: { return vec3f(0.36,0.085,0.055); }  // woven madder-red decorative trim
  }
}
fn clothingContinuumVarying(s:ContinuumSurface,v:ptr<function,ContinuumVarying>) {
  let slot=s.record.spare.x;
  let actor=actors[slot];
  let ch=s.word&7u;
  let fab=(s.word>>3u)&7u;
  let foldAO=mix(0.68,1.05,f32((s.word>>8u)&255u)/255.0);
  let wu=f32((s.word>>16u)&255u)/255.0;
  let wv=f32((s.word>>24u)&255u)/255.0;
  var baseCol=clothContinuumChannelColor(ch,actor);
  if(s.what==CONTINUUM_SPLAT_ENTRY){
    let gType=s.record.spare.y;
    baseCol=select(actor.trousers.rgb,actor.shirt.rgb,gType<=6u);
    if(gType==13u){baseCol=vec3f(0.055,0.052,0.058);}
  }
  (*v).tone=vec4f(baseCol,foldAO);
  (*v).cloth=vec4f(wu,wv,f32(fab),f32(ch));
  let y=s.local.y;
  let mBase=crewMoistureBase(actor.hair.w);
  let lower=mix(moisture[mBase],moisture[mBase+1u],smoothstep(.08,.48,y));
  let upper=mix(moisture[mBase+2u],moisture[mBase+3u],smoothstep(1.02,1.48,y));
  (*v).wet=mix(lower,upper,smoothstep(.48,1.02,y));
  (*v).bodyPos=s.local+vec3f(clothContinuumTouch());
}
fn clothingContinuumShade(v:ContinuumVarying,front:bool)->vec4f {
  // Compute all screen-space derivatives in uniform control flow for TBDR-safe, zero-shimmer woven cloth PBR!
  let dPdx=dpdx(v.world);
  let dPdy=dpdy(v.world);
  let bp=v.bodyPos;
  let dBpdx=dpdx(bp);
  let dBpdy=dpdy(bp);
  let chEdge=fwidth(v.cloth.w);
  let nGeom=normalize(select(-v.normal,v.normal,front));
  let view=normalize(F.camPos.xyz-v.world);
  let sun=F.sunDir.xyz;
  let fab=u32(v.cloth.z+0.5);
  let isWool=(fab==1u);
  let isLeather=(fab==2u);
  let isBrass=(fab==3u);

  // Nyquist-band-limited multi-scale fabric micro-normal perturbation & albedo thread modulation:
  //   fab 0/4 (linen/cotton): crisp orthogonal plain-weave warp/weft + hand-loomed yarn slub
  //   fab 1   (wool):         45-deg Renaissance diagonal twill wales + cross-nap texture
  //   fab 2   (leather):      organic pebbled hide grain + subtle hide mottling
  //   fab 3   (brass):        smooth burnished metal with faint hammered patina
  let bpFoot=max(length(dBpdx),length(dBpdy));
  let fineVis=(1.0-smoothstep(0.0008,0.0034,bpFoot))*step(1e-6,bpFoot);
  let medVis=(1.0-smoothstep(0.0028,0.013,bpFoot))*step(1e-6,bpFoot);
  let tau=6.2831853;

  // Linen / cotton plain weave
  let uLin=(bp.x+bp.z*0.72)*240.0*tau;
  let vLin=bp.y*240.0*tau;
  let sLinU=bp.y*58.0*tau+sin(bp.x*22.0)*1.4;
  let sLinV=(bp.x-bp.z)*52.0*tau;
  let gLin=vec3f(cos(uLin)*sin(vLin)*240.0,sin(uLin)*cos(vLin)*240.0,cos(uLin)*sin(vLin)*172.8)*(0.00040*fineVis)
    +vec3f(cos(sLinV)*52.0,cos(sLinU)*58.0,-cos(sLinV)*52.0)*(0.00042*medVis);
  let modLin=sin(uLin)*sin(vLin)*0.052*fineVis+(sin(sLinU)*0.6+sin(sLinV)*0.4)*0.032*medVis;

  // Wool diagonal twill
  let tW1=(bp.x*165.0-bp.y*165.0+bp.z*140.0)*tau;
  let tW2=(bp.x*90.0+bp.y*95.0-bp.z*85.0)*tau;
  let gWool=vec3f(cos(tW1)*165.0,-cos(tW1)*165.0,cos(tW1)*140.0)*(0.00048*fineVis)
    +vec3f(cos(tW2)*90.0,cos(tW2)*95.0,-cos(tW2)*85.0)*(0.00034*medVis);
  let modWool=sin(tW1)*0.058*fineVis+sin(tW2)*0.034*medVis;

  // Leather pebble grain
  let l1=(bp.x*175.0+bp.y*145.0-bp.z*160.0)*tau;
  let l2=(bp.x*135.0-bp.y*185.0+bp.z*125.0)*tau;
  let l3=(bp.x*52.0+bp.y*46.0+bp.z*58.0)*tau;
  let gLeath=vec3f(cos(l1)*sin(l2)*175.0+sin(l1)*cos(l2)*135.0,cos(l1)*sin(l2)*145.0-sin(l1)*cos(l2)*185.0,-cos(l1)*sin(l2)*160.0+sin(l1)*cos(l2)*125.0)*(0.00034*fineVis)
    +vec3f(cos(l3)*52.0,cos(l3)*46.0,cos(l3)*58.0)*(0.00046*medVis);
  let modLeath=sin(l1)*sin(l2)*0.044*fineVis+sin(l3)*0.038*medVis;

  var gradBp=select(gLin,gWool,isWool);
  gradBp=select(gradBp,gLeath,isLeather);
  gradBp=select(gradBp,vec3f(0.0),isBrass);
  var weaveMod=select(modLin,modWool,isWool);
  weaveMod=select(weaveMod,modLeath,isLeather);
  weaveMod=select(weaveMod,0.0,isBrass);

  // Subtle stitched seam & hem/trim edge definition (channel border seam + side-seam running stitch)
  let borderSeam=smoothstep(0.06,0.35,chEdge)*step(0.0001,bpFoot);
  let sideSeam=exp(-pow((bp.z+0.032)/0.0045,2.0))*smoothstep(0.84,0.92,bp.y)*(1.0-smoothstep(1.36,1.42,bp.y));
  let stitchTick=smoothstep(0.45,0.92,sin(bp.y*130.0*tau))*fineVis;
  let seamDark=select(borderSeam*0.11+sideSeam*stitchTick*0.08,0.0,isBrass);
  gradBp+=select(vec3f(0.0,cos(bp.y*130.0*tau)*sideSeam*0.025*fineVis,0.0),vec3f(0.0),isBrass);

  let dhdx=dot(gradBp,dBpdx);
  let dhdy=dot(gradBp,dBpdy);
  let r1=cross(dPdy,nGeom);
  let r2=cross(nGeom,dPdx);
  let det=dot(dPdx,r1);
  let invDet=1.0/select(max(abs(det),1e-8),-max(abs(det),1e-8),det<0.0);
  let n=normalize(nGeom-(r1*dhdx+r2*dhdy)*select(0.0,invDet,abs(det)>1e-8));

  let wet=clamp(v.wet,vec2f(0.0),vec2f(1.0));
  let foldAO=v.tone.w;
  var albedo=clamp(v.tone.rgb*foldAO*(1.0+weaveMod-seamDark)*mix(1.0,0.62,wet.x),vec3f(0.008),vec3f(0.95));

  let shadowSample=vesselShadow(v.world,n);
  let direct=sunIlluminance()*sunVis[0]*step(0.0,sun.y)*solarShadowVisibility(shadowSample);
  let sky=textureSampleLevel(envCube,sampC,vec3f(0.0,1.0,0.0),${ENV_MIPS - 1}.0).rgb;
  let sea=textureSampleLevel(envCube,sampC,normalize(vec3f(n.x,-0.65,n.z)),${ENV_MIPS - 1}.0).rgb;
  let ambient=vesselAmbient(n,sky,sea)*mix(0.80,1.0,clamp(foldAO,0.68,1.0));

  let ndl=max(dot(n,sun),0.0);
  let ndv=max(dot(n,view),0.0);
  // Natural matte textile roughness: 0.88 linen/cotton, 0.92 wool, 0.56 leather, 0.30 brass
  let dryClothRough=select(0.88,0.92,isWool);
  let wetClothRough=select(0.54,0.58,isWool);
  let rough=select(select(mix(dryClothRough,wetClothRough,wet.y),mix(0.56,0.26,wet.y),isLeather),0.30,isBrass);
  let f0=select(select(vec3f(0.028),vec3f(0.042),isLeather),albedo,isBrass);
  let diffuse=select(albedo*(1.0/3.14159265),albedo*0.18,isBrass);
  let clothSheen=select(pow(1.0-ndv,3.4)*select(0.060,0.075,isWool)*(1.0-wet.x*0.55),0.0,isBrass||isLeather);
  let spec=vesselSpecular(n,view,sun,rough,f0)*ndl;
  let envScale=select(select(0.018,0.048,isLeather),0.45,isBrass);
  let envRefl=textureSampleLevel(envCube,sampC,reflect(-view,n),rough*6.5).rgb*envScale*F.windP[1].w;

  var col=direct*(diffuse*ndl+spec)+albedo*ambient+envRefl+albedo*clothSheen*(ambient+direct*0.28);
  col+=lunarSurface(n,view,albedo,rough,f0,sunVis[1]*lunarShadowVisibility(shadowSample))
    +lightningSurface(n,view,albedo,rough)+gunFlashSurface(v.world,n,view,albedo,rough)+worldFireSurface(v.world,n,view,albedo,rough);
  return vec4f(continuumAir(col,v.world),1.0);
}
`;
}

export const CLOTHING_CONTINUUM_MATERIAL = Object.freeze({
  name: 'clothingContinuum',
  prelude: () => crewRenderWGSL(),
  core: false, data: Object.freeze({ group: 2, binding: 0 }),
  varyings: Object.freeze([['tone', 'vec4f'], ['cloth', 'vec4f'], ['wet', 'vec2f'], ['bodyPos', 'vec3f']].map(Object.freeze)),
  wgsl: clothingContinuumMaterialWGSL, salt: 23,
  cullMode: 'none', air: true, capture: true,
});

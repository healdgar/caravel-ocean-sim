// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// People walking between a town's buildings. Where each one is follows from the time alone, so a
// compute pass finds them, culls them and picks their detail with nothing kept between frames, and
// the vertex stage reads their pose straight from the baked clips.
import { FRAME_WGSL } from './common.js';
import { CREW_RENDER } from './crew.js';
import { ROUTE_STEP_M } from '../town-streets.js';
import { CREW_WALK_CYCLE_METRES } from '../crew-motion.js';

export const TOWNSFOLK_TIERS = 4;
export const TOWNSFOLK_BODY_WORDS = 8;
export const TOWNSFOLK_LOOKS = 48;
const CLIP_FRAMES_PER_SECOND = 30;
const BODY_HEIGHT_M = 1.75;
const BODY_BOUND_M = 1.3;
// How tall someone appears on screen, in pixels, at each change of detail.
const NEAR_PIXELS = 300;
const MID_PIXELS = 120;
const FAR_PIXELS = 36;
const SMALLEST_PIXELS = 2.5;

const TOWN_BODY = /* wgsl */ `
struct TownBody {position:vec3f,heading:f32,frameA:u32,frameB:u32,blend:f32,look:u32};
`;

export const TOWNSFOLK_WALK = FRAME_WGSL + TOWN_BODY + /* wgsl */ `
struct Walker {first:u32,count:u32,phase:f32,speed:f32,side:f32,pauseAt:f32,pauseFor:f32,indoors:f32,length:f32,abroad:f32,look:u32,flags:u32};
struct TownCrowd {clips:array<vec4u,2>,bucketSpan:u32,looks:u32,calm:f32,padding:f32};
@group(0) @binding(0) var<uniform> F:Frame;
@group(0) @binding(1) var<storage,read> walkers:array<Walker>;
@group(0) @binding(2) var<storage,read> route:array<vec4f>;
@group(0) @binding(3) var<storage,read_write> bodies:array<TownBody>;
@group(0) @binding(4) var<storage,read_write> draws:array<atomic<u32>>;
@group(0) @binding(5) var<uniform> crowd:TownCrowd;
fn inFrustum(relative:vec3f,radius:f32)->bool {
  let clip=F.viewProj*vec4f(relative,1);
  let rowW=vec3f(F.viewProj[0].w,F.viewProj[1].w,F.viewProj[2].w);
  for(var a=0u;a<2u;a++){
    let row=vec3f(F.viewProj[0][a],F.viewProj[1][a],F.viewProj[2][a]);
    if(clip.w+clip[a]<-radius*length(rowW+row)||clip.w-clip[a]<-radius*length(rowW-row)){return false;}
  }
  return clip.w>=-radius*length(rowW);
}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){
  if(id.x>=arrayLength(&walkers)){return;}
  let w=walkers[id.x];
  // After dark most are home, and when the guns open everyone is.
  let abroad=(.1+.9*smoothstep(-.1,.14,F.sunDir.y))*crowd.calm;
  if(w.abroad>abroad){return;}
  // Out along the route, a stop on the way perhaps, then indoors; then the same way back.
  let walking=w.length/w.speed;
  let leg=walking+w.pauseFor+w.indoors;
  let time=F.camPos.w;
  let turn=fract(time/(2.0*leg)+w.phase)*2.0*leg;
  let back=turn>=leg;
  let inLeg=turn-select(0.0,leg,back);
  // At the end of the leg they go indoors, unless where they went is in the open.
  let arrived=inLeg>=walking+w.pauseFor;
  if(arrived&&((w.flags>>select(2u,1u,back))&1u)==0u){return;}
  let model=w.flags&1u;
  let stopAt=walking*w.pauseAt;
  let stopped=arrived||(w.pauseFor>0.0&&inLeg>=stopAt&&inLeg<stopAt+w.pauseFor);
  let walked=min(w.length,(min(inLeg,stopAt)+max(0.0,inLeg-stopAt-w.pauseFor))*w.speed);
  let along=select(walked,w.length-walked,back)/${ROUTE_STEP_M.toFixed(4)};
  let i=min(u32(max(along,0.0)),w.count-2u);
  let here=mix(route[w.first+i],route[w.first+i+1u],clamp(along-f32(i),0.0,1.0));
  let ahead=route[w.first+min(i+3u,w.count-1u)].xz-route[w.first+u32(max(i32(i)-2,0))].xz;
  let facing=normalize(ahead+vec2f(1e-4,0.0))*select(1.0,-1.0,back);
  // Each keeps to their right of the way, so those coming and going pass.
  let aside=vec2f(facing.y,-facing.x)*w.side*here.w;
  let position=vec3f(here.x+aside.x,here.y,here.z+aside.y);
  let relative=position+vec3f(0.0,${(BODY_HEIGHT_M * 0.5).toFixed(3)},0.0)-F.camPos.xyz;
  if(!inFrustum(relative,${BODY_BOUND_M.toFixed(2)})){return;}
  let depth=max(dot(relative,normalize(F.camFwd.xyz)),.1);
  let pixels=${BODY_HEIGHT_M.toFixed(3)}*F.screen.y/(2.0*length(F.camUp.xyz))/depth;
  if(pixels<${SMALLEST_PIXELS.toFixed(1)}){return;}
  let tier=select(select(select(3u,2u,pixels>${FAR_PIXELS.toFixed(1)}),1u,pixels>${MID_PIXELS.toFixed(1)}),0u,pixels>${NEAR_PIXELS.toFixed(1)});
  // A stride's frame follows the ground covered, so feet do not slide.
  let clip=crowd.clips[model];
  var first=clip.z;var frames=clip.w;
  var cycle=walked/${CREW_WALK_CYCLE_METRES.toFixed(3)}+w.phase*7.0;
  if(stopped){first=clip.x;frames=clip.y;cycle=(time+w.phase*97.0)*${CLIP_FRAMES_PER_SECOND.toFixed(1)}/f32(frames);}
  let frame=fract(cycle)*f32(frames);
  let whole=min(u32(frame),frames-1u);
  let bucket=model*${TOWNSFOLK_TIERS}u+tier;
  let slot=atomicAdd(&draws[bucket*5u+1u],1u);
  bodies[bucket*crowd.bucketSpan+slot]=TownBody(position,atan2(facing.x,facing.y),first+whole,first+(whole+1u)%frames,select(fract(frame),0.0,tier>=2u),model*crowd.looks+w.look%crowd.looks);
}
`;

export const TOWNSFOLK_RENDER = CREW_RENDER + TOWN_BODY + /* wgsl */ `
struct TownLook {shirt:vec4f,trousers:vec4f,skin:vec4f,hair:vec4f,face:vec4f};
@group(0) @binding(10) var<storage,read> bodies:array<TownBody>;
@group(0) @binding(11) var<storage,read> poses:array<mat4x4f>;
@group(0) @binding(12) var<storage,read> looks:array<TownLook>;
fn townPose(frame:u32,v:CrewInput)->mat4x4f {
  let at=frame*65u;
  return poses[at+v.bones.x]*v.weights.x+poses[at+v.bones.y]*v.weights.y+poses[at+v.bones.z]*v.weights.z+poses[at+v.bones.w]*v.weights.w;
}
@vertex fn townsfolkVS(v:CrewInput)->CrewVertex {
  let body=bodies[v.instance];let look=looks[body.look];
  var pose=townPose(body.frameA,v);
  if(body.blend>0.0){pose=pose*(1.0-body.blend)+townPose(body.frameB,v)*body.blend;}
  let dress=crewDressOf(look.hair.w);
  var surface=CrewSurface(CREW_PIECE_OUT,v.normal);
  if(!crewPieceHidden(v.color,dress)){surface=crewMorph(v.position,v.normal,look.face,look.skin.w);}
  let c=cos(body.heading);let s=sin(body.heading);
  let local=(pose*vec4f(surface.position,1)).xyz;
  let turned=(pose*vec4f(surface.normal,0)).xyz;
  var out:CrewVertex;
  out.world=vec3f(local.x*c+local.z*s,local.y,local.z*c-local.x*s)+body.position;
  out.position=F.viewProj*vec4f(out.world-F.camPos.xyz,1);
  out.normal=normalize(vec3f(turned.x*c+turned.z*s,turned.y,turned.z*c-turned.x*s));
  let clothed=crewClothed(v.color,v.position,look.shirt.rgb,look.trousers.rgb,look.skin.rgb,look.hair.rgb,look.face.w>1.5,dress);
  out.color=clothed.rgb;out.skin=clothed.w;out.paint=dress>>16u;
  out.helm=0.0;out.wet=vec2f(0.0);out.bodyPos=v.position;out.damage=vec3f(0.0);
  return out;
}
`;

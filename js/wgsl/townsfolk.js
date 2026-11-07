// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// People walking between a town's buildings. Where each one is follows from the time alone, so a
// compute pass finds them, culls them and picks their detail, and the vertex stage reads their pose
// straight from the baked clips. Shot falling among them is all the pass keeps: a small record per
// person, written only when something befalls them. js/town-shots.js says what it is given.
import { FRAME_WGSL, SIM_CLOCK_LOOP_S } from './common.js';
import { CREW_RENDER } from './crew.js';
import { ROUTE_STEP_M } from '../town-streets.js';
import { CREW_WALK_CYCLE_METRES } from '../crew-motion.js';

export const TOWNSFOLK_TIERS = 4;
export const TOWNSFOLK_BODY_WORDS = 8;
export const TOWNSFOLK_LOOKS = 48;
export const TOWN_FATE_WORDS = 12;
export const TOWN_SHOT_LIMIT = 64;
export const TOWN_SHOT_WORDS = 12;
export const [TOWN_ABOUT, TOWN_AFRAID, TOWN_FALLING, TOWN_DOWN] = [0, 1, 2, 3];
export const TOWN_COWER_FRAMES = 10;
export const TOWN_FALL_FRAMES = 21;
export const TOWN_FALL_RATE = 15;
export const TOWN_RUN_CYCLE_METRES = 2.4;
export const TOWN_RUN_SPEEDS = Object.freeze([3.4, 5.2]);
// Who reacts to what. Fear is 1 at the shot and 0 at the edge of its reach, and fear times this is the chance of it.
export const TOWN_REACT_GAIN = 2.5;
// Below this fear they only stop and look. Above it a share get down where they are and the rest run.
export const TOWN_ONLY_LOOKS = 0.22;
export const TOWN_COWER_SHARE = 0.25;
// Seconds to get over it: at the least, more for those it came nearest, and a spread between people.
export const TOWN_SETTLE_S = Object.freeze([6, 12, 8]);
const TOWN_STARTLE_S = 0.25;
const TOWN_LEAST_RUN_S = 1.5;
const TOWN_BLAST_CHANCE = 0.85;
// How many samples of their way each looks along, to see which direction leads from the shot.
const TOWN_LOOK_AHEAD = 10;
const TOWN_CORNERED_M = 2;
const CLIP_FRAMES_PER_SECOND = 30;
const BODY_HEIGHT_M = 1.75;
const BODY_BOUND_M = 1.3;
const LYING_BOUND_M = 2.4;
// How tall someone appears on screen, in pixels, at each change of detail.
const NEAR_PIXELS = 110;
const MID_PIXELS = 48;
const FAR_PIXELS = 20;
const SMALLEST_PIXELS = 2.5;

const TOWN_BODY = /* wgsl */ `
struct TownBody {position:vec3f,heading:f32,frameA:u32,frameB:u32,blend:f32,look:u32};
`;

export const TOWNSFOLK_WALK = FRAME_WGSL + TOWN_BODY + /* wgsl */ `
struct Walker {first:u32,count:u32,phase:f32,speed:f32,side:f32,pauseAt:f32,pauseFor:f32,indoors:f32,length:f32,abroad:f32,look:u32,flags:u32};
struct TownCrowd {clips:array<vec4u,6>,bucketSpan:u32,looks:u32,padding:vec2u};
struct TownShot {start:vec3f,strike:f32,end:vec3f,blast:f32,reach:f32,seed:f32,padding:vec2f};
struct TownShots {count:u32,list:array<TownShot,${TOWN_SHOT_LIMIT}>};
struct TownFate {mode:u32,since:f32,until:f32,runFor:f32,along:f32,going:f32,lane:f32,heading:f32,clock:f32,speed:f32,look:f32,how:u32};
struct TownSpot {position:vec3f,forward:vec2f};
@group(0) @binding(0) var<uniform> F:Frame;
@group(0) @binding(1) var<storage,read> walkers:array<Walker>;
@group(0) @binding(2) var<storage,read> route:array<vec4f>;
@group(0) @binding(3) var<storage,read_write> bodies:array<TownBody>;
@group(0) @binding(4) var<storage,read_write> draws:array<atomic<u32>>;
@group(0) @binding(5) var<uniform> crowd:TownCrowd;
@group(0) @binding(6) var<uniform> shots:TownShots;
@group(0) @binding(7) var<storage,read_write> fates:array<TownFate>;
const ABOUT=${TOWN_ABOUT}u;const AFRAID=${TOWN_AFRAID}u;const FALLING=${TOWN_FALLING}u;const DOWN=${TOWN_DOWN}u;
fn inFrustum(relative:vec3f,radius:f32)->bool {
  let clip=F.viewProj*vec4f(relative,1);
  let rowW=vec3f(F.viewProj[0].w,F.viewProj[1].w,F.viewProj[2].w);
  for(var a=0u;a<2u;a++){
    let row=vec3f(F.viewProj[0][a],F.viewProj[1][a],F.viewProj[2][a]);
    if(clip.w+clip[a]<-radius*length(rowW+row)||clip.w-clip[a]<-radius*length(rowW-row)){return false;}
  }
  return clip.w>=-radius*length(rowW);
}
fn townRoll(who:u32,salt:f32)->f32 {
  var h=(who*2654435761u)^(u32(salt*4093.0)*40503u);
  h=(h^(h>>15u))*2246822519u;h=(h^(h>>13u))*3266489917u;h=h^(h>>16u);
  return f32(h>>8u)/16777216.0;
}
// The frame clock runs round, so a time past may read as later than now.
fn secondsSince(since:f32,time:f32)->f32 {let age=time-since;return select(age,age+${SIM_CLOCK_LOOP_S.toFixed(1)},age<0.0);}
fn turnTo(heading:f32,goal:f32)->f32 {return atan2(sin(goal-heading),cos(goal-heading));}
// Somewhere on their way, on the side of it they are keeping to: +1 is the right hand going out along it.
fn wayAt(w:Walker,metres:f32,lane:f32)->TownSpot {
  let along=metres/${ROUTE_STEP_M.toFixed(4)};
  let i=min(u32(max(along,0.0)),w.count-2u);
  let here=mix(route[w.first+i],route[w.first+i+1u],clamp(along-f32(i),0.0,1.0));
  let ahead=route[w.first+min(i+3u,w.count-1u)].xz-route[w.first+u32(max(i32(i)-2,0))].xz;
  let forward=normalize(ahead+vec2f(1e-4,0.0));
  let aside=vec2f(forward.y,-forward.x)*lane*w.side*here.w;
  return TownSpot(vec3f(here.x+aside.x,here.y,here.z+aside.y),forward);
}
// What to add to the clock so that their day, which follows from the time, goes on from this point of it.
fn routineClock(w:Walker,metres:f32,going:f32,time:f32)->f32 {
  let walking=w.length/w.speed;
  let leg=walking+w.pauseFor+w.indoors;
  let walked=select(metres,w.length-metres,going<0.0)/w.speed;
  let inLeg=walked+select(0.0,w.pauseFor,w.pauseFor>0.0&&walked>=walking*w.pauseAt);
  return select(0.0,leg,going<0.0)+inLeg-fract(time/(2.0*leg)+w.phase)*2.0*leg;
}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){
  if(id.x>=arrayLength(&walkers)){return;}
  let w=walkers[id.x];
  var fate=fates[id.x];
  let time=F.camPos.w;
  let age=secondsSince(fate.since,time);
  // The fear passes and they take up their day from where they are. They run only along their own way, which was
  // laid clear of walls and water, so they cannot go through a building or into the sea.
  if(fate.mode==AFRAID&&age>=fate.until){
    let ranFor=clamp(age-${TOWN_STARTLE_S.toFixed(2)},0.0,fate.runFor);
    fate.clock=routineClock(w,clamp(fate.along+fate.going*fate.speed*ranFor,0.0,w.length),fate.going,time);
    fate.mode=ABOUT;
    fates[id.x]=fate;
  }else if(fate.mode==FALLING&&age>=${(TOWN_FALL_FRAMES / TOWN_FALL_RATE).toFixed(3)}){
    fate.mode=DOWN;
    fates[id.x]=fate;
  }
  var metres=fate.along;var going=fate.going;var lane=fate.lane;var walked=0.0;var ran=0.0;var stopped=false;var hidden=false;
  if(fate.mode==ABOUT){
    // After dark most are home.
    if(w.abroad>.1+.9*smoothstep(-.1,.14,F.sunDir.y)){return;}
    // Out along the route, a stop on the way perhaps, then indoors; then the same way back.
    let walking=w.length/w.speed;
    let leg=walking+w.pauseFor+w.indoors;
    let turn=fract((time+fate.clock)/(2.0*leg)+w.phase)*2.0*leg;
    let back=turn>=leg;
    let inLeg=turn-select(0.0,leg,back);
    // At the end of the leg they go indoors, unless where they went is in the open.
    let arrived=inLeg>=walking+w.pauseFor;
    if(arrived&&((w.flags>>select(2u,1u,back))&1u)==0u){return;}
    let stopAt=walking*w.pauseAt;
    stopped=arrived||(w.pauseFor>0.0&&inLeg>=stopAt&&inLeg<stopAt+w.pauseFor);
    walked=min(w.length,(min(inLeg,stopAt)+max(0.0,inLeg-stopAt-w.pauseFor))*w.speed);
    metres=select(walked,w.length-walked,back);
    going=select(1.0,-1.0,back);
    // Each keeps to their right of the way, so those coming and going pass.
    lane=going;
  }else if(fate.mode==AFRAID){
    ran=clamp(age-${TOWN_STARTLE_S.toFixed(2)},0.0,fate.runFor);
    metres=clamp(fate.along+fate.going*fate.speed*ran,0.0,w.length);
    // Turning back on their way takes them across it to the other side.
    lane=mix(fate.lane,going,smoothstep(0.0,1.0,age));
    // Run to the end of the way and they are through the door, until it is over.
    hidden=ran>0.0&&(metres<=0.0||metres>=w.length)&&((w.flags>>select(2u,1u,going<0.0))&1u)==0u;
  }
  let spot=wayAt(w,metres,lane);
  let position=spot.position;
  let facing=spot.forward*going;
  var heading=atan2(facing.x,facing.y);
  if(fate.mode>=FALLING){heading=fate.heading;}
  else if(fate.mode==AFRAID){
    if(fate.runFor>0.0){heading=fate.heading+turnTo(fate.heading,heading)*smoothstep(0.0,.3,age);}
    else if((fate.how&1u)==1u){heading=fate.heading;}
    else{heading=fate.heading+turnTo(fate.heading,fate.look)*smoothstep(0.0,.7,age)*(1.0-smoothstep(fate.until-.7,fate.until,age));}
  }
  // What the guns did since the last frame. Nearly always nothing, and then this costs one comparison.
  if(shots.count>0u&&fate.mode<FALLING){
    var fear=0.0;var danger=vec2f(0.0);var fearReach=1.0;var fearSeed=0.0;var struck=false;var fallsTo=vec2f(0.0,1.0);
    for(var k=0u;k<shots.count;k++){
      let shot=shots.list[k];
      let line=shot.end-shot.start;
      let flat=dot(line.xz,line.xz);
      let toStart=shot.start.xz-position.xz;
      let t=select(0.0,clamp(-dot(toStart,line.xz)/flat,0.0,1.0),flat>1e-6);
      let nearest=toStart+line.xz*t;
      let y=shot.start.y+line.y*t;
      let away=length(vec3f(nearest.x,max(max(position.y-y,y-position.y-${BODY_HEIGHT_M.toFixed(3)}),0.0),nearest.y));
      if(!hidden){
        if(away<shot.strike){struck=true;fallsTo=line.xz;}
        else if(away<shot.blast&&townRoll(id.x,shot.seed)<${TOWN_BLAST_CHANCE.toFixed(2)}*(1.0-away/shot.blast)){struck=true;fallsTo=-nearest;}
      }
      let closeness=1.0-away/shot.reach;
      if(closeness>fear){fear=closeness;danger=position.xz+nearest;fearReach=shot.reach;fearSeed=shot.seed;}
    }
    if(struck){
      // Half go down on their face and half on their back, either way in the direction it took them.
      fate.how=select(1u,0u,townRoll(id.x,7.0)<.5);
      let toward=fallsTo*select(-1.0,1.0,fate.how==0u)+vec2f(1e-4,0.0);
      fate.mode=FALLING;fate.since=time;fate.along=metres;fate.going=going;fate.lane=lane;fate.heading=atan2(toward.x,toward.y);
      fates[id.x]=fate;
    }else if(fear>0.0&&townRoll(id.x,fearSeed+1.0)<min(1.0,fear*${TOWN_REACT_GAIN.toFixed(2)})){
      let settle=${TOWN_SETTLE_S[0].toFixed(1)}+fear*${TOWN_SETTLE_S[1].toFixed(1)}+townRoll(id.x,fearSeed+2.0)*${TOWN_SETTLE_S[2].toFixed(1)};
      if(fate.mode==AFRAID&&(age<1.0||hidden||(fate.how&1u)==1u)){
        // Already going, or already down in a doorway: it only takes them longer to get over it.
        fate.until=max(fate.until,age+settle);
      }else{
        let sample=min(u32(max(metres/${ROUTE_STEP_M.toFixed(4)},0.0)),w.count-1u);
        let onward=distance(route[w.first+min(sample+${TOWN_LOOK_AHEAD}u,w.count-1u)].xz,danger);
        let backward=distance(route[w.first+u32(max(i32(sample)-${TOWN_LOOK_AHEAD},0))].xz,danger);
        // Nowhere along their way leads from it, or they just freeze: they get down where they are.
        let cornered=max(onward,backward)+${TOWN_CORNERED_M.toFixed(1)}<distance(position.xz,danger);
        let onlyLooks=fear<${TOWN_ONLY_LOOKS.toFixed(2)};
        let cowers=!onlyLooks&&(cornered||townRoll(id.x,fearSeed+3.0)<${TOWN_COWER_SHARE.toFixed(2)});
        let toDanger=danger-position.xz+vec2f(1e-4,0.0);
        fate.how=select(0u,1u,cowers);
        fate.mode=AFRAID;fate.since=time;fate.along=metres;fate.lane=lane;fate.heading=heading;fate.look=atan2(toDanger.x,toDanger.y);
        fate.speed=${TOWN_RUN_SPEEDS[0].toFixed(2)}+townRoll(id.x,fearSeed+4.0)*${(TOWN_RUN_SPEEDS[1] - TOWN_RUN_SPEEDS[0]).toFixed(2)};
        if(cowers||onlyLooks){
          fate.going=going;fate.runFor=0.0;fate.until=select(settle,settle*.3,onlyLooks);
        }else{
          // Far enough to be out of its reach, which is further for those nearest it.
          fate.going=select(-1.0,1.0,onward>=backward);
          fate.runFor=max(${TOWN_LEAST_RUN_S.toFixed(1)},fearReach*fear*1.2/fate.speed);
          fate.until=fate.runFor+settle;
        }
      }
      fates[id.x]=fate;
    }
  }
  if(hidden){return;}
  let relative=position+vec3f(0.0,${(BODY_HEIGHT_M * 0.5).toFixed(3)},0.0)-F.camPos.xyz;
  if(!inFrustum(relative,select(${BODY_BOUND_M.toFixed(2)},${LYING_BOUND_M.toFixed(2)},fate.mode>=FALLING))){return;}
  let depth=max(dot(relative,normalize(F.camFwd.xyz)),.1);
  let pixels=${BODY_HEIGHT_M.toFixed(3)}*F.screen.y/(2.0*length(F.camUp.xyz))/depth;
  if(pixels<${SMALLEST_PIXELS.toFixed(1)}){return;}
  let tier=select(select(select(3u,2u,pixels>${FAR_PIXELS.toFixed(1)}),1u,pixels>${MID_PIXELS.toFixed(1)}),0u,pixels>${NEAR_PIXELS.toFixed(1)});
  let model=w.flags&1u;
  let plain=crowd.clips[model*3u];let fright=crowd.clips[model*3u+1u];let fall=crowd.clips[model*3u+2u];
  var first=plain.z;var frames=plain.w;var frame=0.0;var looped=true;
  let breathing=(time+w.phase*97.0)*${CLIP_FRAMES_PER_SECOND.toFixed(1)};
  if(fate.mode==ABOUT){
    // A stride's frame follows the ground covered, so feet do not slide.
    var cycle=walked/${CREW_WALK_CYCLE_METRES.toFixed(3)}+w.phase*7.0;
    if(stopped){first=plain.x;frames=plain.y;cycle=breathing/f32(frames);}
    frame=fract(cycle)*f32(frames);
  }else if(fate.mode==AFRAID){
    if(ran>0.0&&ran<fate.runFor&&metres>0.0&&metres<w.length){
      first=fright.x;frames=fright.y;
      frame=fract(ran*fate.speed/${TOWN_RUN_CYCLE_METRES.toFixed(3)}+w.phase*7.0)*f32(frames);
    }else if((fate.how&1u)==1u){
      // Down as it begins and up again as it ends.
      first=fright.z;frames=fright.w;looped=false;
      frame=min(age,fate.until-age)*${CLIP_FRAMES_PER_SECOND.toFixed(1)};
    }else{
      first=plain.x;frames=plain.y;
      frame=fract(breathing/f32(frames))*f32(frames);
    }
  }else{
    let onBack=(fate.how&1u)==1u;
    first=select(fall.x,fall.z,onBack);frames=select(fall.y,fall.w,onBack);looped=false;
    frame=select(age*${TOWN_FALL_RATE.toFixed(1)},f32(frames),fate.mode==DOWN);
  }
  frame=clamp(frame,0.0,f32(frames)-select(1.0,.001,looped));
  let whole=min(u32(frame),frames-1u);
  let after=select(min(whole+1u,frames-1u),(whole+1u)%frames,looped);
  let bucket=model*${TOWNSFOLK_TIERS}u+tier;
  let slot=atomicAdd(&draws[bucket*5u+1u],1u);
  bodies[bucket*crowd.bucketSpan+slot]=TownBody(position,heading,first+whole,first+after,select(fract(frame),0.0,tier>=3u),model*crowd.looks+w.look%crowd.looks);
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
  let rainWet=clamp(F.windP[1].x,0.0,1.0);
  out.helm=0.0;out.wet=vec2f(rainWet*0.65,rainWet*0.75);out.bodyPos=v.position;out.damage=vec3f(0.0);
  return out;
}
`;

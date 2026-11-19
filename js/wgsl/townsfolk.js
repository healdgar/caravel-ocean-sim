// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// People walking between a town's buildings. Where each one is follows from the time alone, so a compute pass finds
// them, keeps those in sight or whose shadow may fall into it, and writes each one kept as a placed person
// (CrewPlaced, js/wgsl/crew-continuum.js), compacted by body: the people continuum poses, cuts and draws them from
// there. Shot falling among them is all the pass keeps of its own: a small record per person, written only when
// something befalls them. js/town-shots.js says what it is given.
import { FRAME_WGSL, SIM_CLOCK_LOOP_S } from './common.js';
import { ROUTE_STEP_M } from '../town-streets.js';
import { CREW_WALK_CYCLE_METRES } from '../crew-motion.js';
import { CREW_CONTINUUM_ORDER_IMPORTANT, CREW_CONTINUUM_PLACED_WGSL } from './crew-continuum.js';
import { continuumGroundWGSL } from '../continuum-ground.js';

// The two bodies of a town: walker flags bit 0 says which a person wears, a man's or a woman's.
export const TOWNSFOLK_MODELS = 2;
export const TOWNSFOLK_LOOKS = 48;
// What the pass counts, for each body: an indirect dispatch (kept, 1, 1, unused) that sizes the pose and the cut.
export const TOWNSFOLK_DISPATCH_WORDS = 4;
export const TOWNSFOLK_COUNT_WORDS = TOWNSFOLK_MODELS * TOWNSFOLK_DISPATCH_WORDS;
// The moisture slots their drawing reads (four each): dry but for the rain, and in the sea.
export const TOWNSFOLK_MOISTURE_SLOTS = 8;
export const TOWNSFOLK_SEA_MOISTURE = 4;
export const TOWN_FATE_WORDS = 12;
export const TOWN_SHOT_LIMIT = 64;
export const TOWN_SHOT_WORDS = 12;
export const [TOWN_ABOUT, TOWN_AFRAID, TOWN_FALLING, TOWN_DOWN] = [0, 1, 2, 3];
// How long the fallen lie, by the game's calendar. The pass is told the date in hours and keeps each one's own.
export const TOWN_CASUALTY_STAY_S = 86400;
export const TOWN_COWER_FRAMES = 10;
export const TOWN_FALL_FRAMES = 21;
export const TOWN_FALL_RATE = 15;
export const TOWN_RUN_CYCLE_METRES = 2.4;
export const TOWN_RIDE_CYCLE_METRES = 2.2;
export const WALKER_MOUNTED_BIT = 16;
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
const BODY_HEIGHT_M = 1.73;
const BODY_BOUND_M = 1.3;
const LYING_BOUND_M = 2.4;
// Out of sight, someone this near the eye and this near the edge of the view may still cast a shadow into it.
const SHADOW_NEAR_M = 110;
const SHADOW_MARGIN_M = 18;

export const TOWNSFOLK_WALK = FRAME_WGSL + CREW_CONTINUUM_PLACED_WGSL + /* wgsl */ `
struct Walker {first:u32,count:u32,phase:f32,speed:f32,side:f32,pauseAt:f32,pauseFor:f32,indoors:f32,length:f32,abroad:f32,look:u32,flags:u32};
// second: the first slot of the second body's people; ride: each body's frames of the ride clip, 16 bits each.
struct TownCrowd {clips:array<vec4u,6>,second:u32,looks:u32,hours:f32,ride:u32};
struct TownShot {start:vec3f,strike:f32,end:vec3f,blast:f32,reach:f32,seed:f32,padding:vec2f};
struct TownShots {count:u32,list:array<TownShot,${TOWN_SHOT_LIMIT}>};
struct TownFate {mode:u32,since:f32,until:f32,runFor:f32,along:f32,going:f32,lane:f32,heading:f32,clock:f32,speed:f32,look:f32,how:u32};
struct TownIntent {pos:vec4f,state:vec4f};
struct TownSpot {position:vec3f,forward:vec2f,centerXZ:vec2f,halfWidth:f32};
@group(0) @binding(0) var<uniform> F:Frame;
@group(0) @binding(1) var<storage,read> walkers:array<Walker>;
@group(0) @binding(2) var<storage,read> route:array<vec4f>;
@group(0) @binding(3) var<storage,read_write> placed:array<CrewPlaced>;
@group(0) @binding(4) var<storage,read_write> counts:array<atomic<u32>>;
@group(0) @binding(5) var<uniform> crowd:TownCrowd;
@group(0) @binding(6) var<uniform> shots:TownShots;
@group(0) @binding(7) var<storage,read_write> fates:array<TownFate>;
@group(0) @binding(8) var<storage,read_write> moisture:array<vec2f>;
` + continuumGroundWGSL(0, 9) + /* wgsl */ `
@group(0) @binding(10) var<storage,read_write> intents:array<TownIntent>;
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
// Somewhere on their way, at normalized lateral fraction latFrac in [-1, 1] of the full walkable half-width.
fn wayAtLat(w:Walker,metres:f32,latFrac:f32)->TownSpot {
  let along=metres/${ROUTE_STEP_M.toFixed(4)};
  let i=min(u32(max(along,0.0)),w.count-2u);
  let here=mix(route[w.first+i],route[w.first+i+1u],clamp(along-f32(i),0.0,1.0));
  let ahead=route[w.first+min(i+3u,w.count-1u)].xz-route[w.first+u32(max(i32(i)-2,0))].xz;
  let forward=normalize(ahead+vec2f(1e-4,0.0));
  let aside=vec2f(forward.y,-forward.x)*clamp(latFrac,-1.0,1.0)*here.w;
  return TownSpot(vec3f(here.x+aside.x,here.y,here.z+aside.y),forward,here.xz,here.w);
}
// Somewhere on their way, on the side of it they are keeping to: +1 is the right hand going out along it.
fn wayAt(w:Walker,metres:f32,lane:f32)->TownSpot {
  return wayAtLat(w,metres,lane*w.side);
}
// What to add to the clock so that their day, which follows from the time, goes on from this point of it.
fn routineClock(w:Walker,metres:f32,going:f32,time:f32)->f32 {
  let walking=w.length/w.speed;
  let leg=walking+w.pauseFor+w.indoors;
  let walked=select(metres,w.length-metres,going<0.0)/w.speed;
  let inLeg=walked+select(0.0,w.pauseFor,w.pauseFor>0.0&&walked>=walking*w.pauseAt);
  return select(0.0,leg,going<0.0)+inLeg-fract(time/(2.0*leg)+w.phase)*2.0*leg;
}
// Pass 1 (intent): publishes each active routine walker's current world position, heading, speed and corridor half-width
// into a dedicated read-only snapshot buffer (intents) so Pass 2 (main) resolves lateral passing, queuing and non-merging
// separation with zero read/write races on fates[]. Mounted riders follow pure closed-form time so they remain 1:1 locked
// to their street mounts in js/wgsl/herds.js while still advertising their presence so pedestrians step aside.
@compute @workgroup_size(64) fn intent(@builtin(global_invocation_id) id:vec3u){
  if(id.x>=arrayLength(&walkers)){return;}
  let w=walkers[id.x];
  let fate=fates[id.x];
  if(fate.mode!=ABOUT){
    intents[id.x]=TownIntent(vec4f(0.0),vec4f(0.0));
    return;
  }
  let time=F.camPos.w;
  if(w.abroad>.1+.9*smoothstep(-.1,.14,F.sunDir.y)){
    intents[id.x]=TownIntent(vec4f(0.0),vec4f(0.0));
    return;
  }
  let isMounted=(w.flags&16u)!=0u;
  let walking=w.length/w.speed;
  let leg=walking+w.pauseFor+w.indoors;
  let clk=select(fate.clock,0.0,isMounted);
  let turn=fract((time+clk)/(2.0*leg)+w.phase)*2.0*leg;
  let back=turn>=leg;
  let inLeg=turn-select(0.0,leg,back);
  let arrived=inLeg>=walking+w.pauseFor;
  if(arrived&&((w.flags>>select(2u,1u,back))&1u)==0u){
    intents[id.x]=TownIntent(vec4f(0.0),vec4f(0.0));
    return;
  }
  let stopAt=walking*w.pauseAt;
  let stopped=arrived||(w.pauseFor>0.0&&inLeg>=stopAt&&inLeg<stopAt+w.pauseFor);
  let walked=min(w.length,(min(inLeg,stopAt)+max(0.0,inLeg-stopAt-w.pauseFor))*w.speed);
  let metres=select(walked,w.length-walked,back);
  let going=select(1.0,-1.0,back);
  let init=(fate.how&1u)!=0u;
  let latFrac=select(select(going*w.side,clamp(fate.lane,-1.0,1.0),init),going*w.side,isMounted);
  let spot=wayAtLat(w,metres,latFrac);
  let facing=spot.forward*going;
  let how=2u|select(0u,4u,isMounted)|select(0u,8u,stopped);
  intents[id.x]=TownIntent(vec4f(spot.position,spot.halfWidth),vec4f(atan2(facing.x,facing.y),select(w.speed,0.0,stopped),going,f32(how)));
}
@compute @workgroup_size(64) fn main(@builtin(global_invocation_id) id:vec3u){
  // Rain and sleet wet them. Snow and hail do not, and neither does anything else the frame happens to carry. Those in
  // the sea are soaked.
  if(id.x==0u){
    let rain=clamp(F.reserved.x,0.0,1.0)*select(0.0,1.0,F.reserved.y<0.5||(F.reserved.y>1.5&&F.reserved.y<2.5));
    let dry=vec2f(rain*0.65,rain*0.75);
    for(var i=0u;i<4u;i++){moisture[i]=dry;moisture[${TOWNSFOLK_SEA_MOISTURE}u+i]=max(dry,vec2f(0.92));}
  }
  if(id.x>=arrayLength(&walkers)){return;}
  let w=walkers[id.x];
  var fate=fates[id.x];
  let time=F.camPos.w;
  var age=secondsSince(fate.since,time);
  // The fear passes and they take up their day from where they are. They run only along their own way, which was
  // laid clear of walls and water, so they cannot go through a building or into the sea.
  if(fate.mode==AFRAID&&age>=fate.until){
    let ranFor=clamp(age-${TOWN_STARTLE_S.toFixed(2)},0.0,fate.runFor);
    fate.clock=routineClock(w,clamp(fate.along+fate.going*fate.speed*ranFor,0.0,w.length),fate.going,time);
    fate.mode=ABOUT;
    fate.how=0u;
    fates[id.x]=fate;
  }else if(fate.mode==FALLING&&age>=${(TOWN_FALL_FRAMES / TOWN_FALL_RATE).toFixed(3)}){
    fate.mode=DOWN;
    fates[id.x]=fate;
  }else if(fate.mode==DOWN&&abs(crowd.hours-fate.clock)>=${(TOWN_CASUALTY_STAY_S / 3600).toFixed(1)}){
    // A day on by the calendar they are gone from where they lay, and the town has its number again. The frame
    // clock cannot say so: it runs round every ${SIM_CLOCK_LOOP_S} seconds.
    fate=TownFate(ABOUT,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0.0,0u);
    fates[id.x]=fate;
  }
  let isMounted=(w.flags&16u)!=0u;
  var metres=fate.along;var going=fate.going;var lane=fate.lane;var walked=0.0;var ran=0.0;var stopped=false;var hidden=false;
  var spot:TownSpot;
  if(fate.mode==ABOUT){
    // After dark most are home.
    if(w.abroad>.1+.9*smoothstep(-.1,.14,F.sunDir.y)){return;}
    // Out along the route, a stop on the way perhaps, then indoors; then the same way back.
    let walking=w.length/w.speed;
    let leg=walking+w.pauseFor+w.indoors;
    let clk=select(fate.clock,0.0,isMounted);
    let turn=fract((time+clk)/(2.0*leg)+w.phase)*2.0*leg;
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
    if(isMounted){
      // Street-mounted riders stay bit-for-bit locked to their horse in js/wgsl/herds.js (pure time, fixed w.side).
      spot=wayAt(w,metres,going);
      lane=going;
    }else{
      let init=(fate.how&1u)!=0u;
      let dt=select(0.0,clamp(secondsSince(fate.since,time),0.0,0.25),init);
      let prefFrac=going*w.side;
      // When turning around at an open-air end (e.g. a pier head), switch immediately to the new right-hand lane.
      let turnedAround=init&&(fate.going*going<0.0);
      var latFrac=select(prefFrac,clamp(fate.lane,-1.0,1.0),init&&!turnedAround);
      let baseSpot=wayAtLat(w,metres,latFrac);
      let facing0=baseSpot.forward*going;
      let right0=vec2f(facing0.y,-facing0.x);
      let halfW=max(baseSpot.halfWidth,0.05);
      let curRightM=latFrac*going*halfW;
      let prefRightM=w.side*halfW;
      let rSelf=0.42;
      var steerRightM=0.0;
      var pushRightM=0.0;
      var pushFwdM=0.0;
      var moveFrac=1.0;
      let totalW=arrayLength(&walkers);
      for(var j=0u;j<totalW;j++){
        if(j==id.x){continue;}
        let oi=intents[j];
        let oHow=u32(oi.state.w+0.5);
        if((oHow&2u)==0u){continue;}
        let dXZ=vec2f(oi.pos.x-baseSpot.position.x,oi.pos.z-baseSpot.position.z);
        if(abs(dXZ.x)>4.2||abs(dXZ.y)>4.2||abs(oi.pos.y-baseSpot.position.y)>1.6){continue;}
        let dist=length(dXZ);
        if(dist>4.2){continue;}
        let fwd=dot(dXZ,facing0);
        let lat=dot(dXZ,right0);
        let rOther=select(0.42,0.88,(oHow&4u)!=0u);
        let rSum=rSelf+rOther;
        let oDir=vec2f(sin(oi.state.x),cos(oi.state.x));
        let sameDir=dot(facing0,oDir);
        let oStopped=(oHow&8u)!=0u||oi.state.y<0.05;
        let oGoing=oi.state.z;
        let oRightPos=curRightM+lat;
        let roomRight=halfW-oRightPos;
        let roomLeft=oRightPos+halfW;
        // Lateral passing: shift into available lateral road/dock space around oncoming, mounted, or slower walkers.
        if(fwd>-0.45&&fwd<3.8&&abs(lat)<rSum*1.55&&halfW>0.26){
          let prox=1.0-clamp(max(fwd,0.0)/3.8,0.0,1.0);
          var passDir=select(-1.0,1.0,roomRight>=roomLeft);
          if(sameDir<-0.25&&roomRight>=rSum*0.80){passDir=1.0;}
          else if(sameDir>=-0.25&&roomLeft>=rSum*0.85&&oi.state.y<w.speed*0.95){passDir=-1.0;}
          let needClear=max(0.0,rSum*1.12-abs(lat));
          steerRightM+=passDir*(0.38+needClear)*prox;
        }
        // Orderly queuing without deadlocks: never trap returning pier walkers or freeze behind open-air loiterers.
        if(!stopped&&fwd>0.02&&fwd<rSum+0.68&&abs(lat)<rSum*0.92){
          let canPassSide=max(roomLeft,roomRight)>=rSum*0.88;
          if(sameDir>=-0.25){
            if(!canPassSide&&!oStopped){
              let qCap=clamp((fwd-rSum*0.95)/0.68,0.0,1.0);
              let matchAhead=select(0.0,clamp(oi.state.y/max(w.speed,0.15),0.0,1.0),fwd>rSum*0.98);
              moveFrac=min(moveFrac,max(qCap,matchAhead*clamp((fwd-rSum*0.92)/0.35,0.0,1.0)));
            }else if(abs(lat)<rSum*0.65){
              // Plenty of lateral room or walker ahead is standing still: slow briefly to step around, never freeze.
              moveFrac=min(moveFrac,select(0.45,0.38,oStopped));
            }
          }else if(!canPassSide&&abs(lat)<rSum*0.72){
            // Opposing traffic in a narrow pinch: leaving-end walkers (going < 0) take right-of-way so piers never jam.
            let yieldToOther=(going>0.0&&oGoing<0.0)||((going*oGoing>0.0)&&(facing0.x<oDir.x));
            if(yieldToOther){
              moveFrac=min(moveFrac,clamp((fwd-rSum*0.85)/0.65,0.26,0.65));
            }
          }
        }
        // Soft non-merging separation clamped strictly inside the walkable corridor.
        if(dist<rSum){
          let pen=rSum-dist;
          let latSign=select(select(-1.0,1.0,lat<0.0),select(-1.0,1.0,id.x>j),abs(lat)<0.04);
          pushRightM+=latSign*pen*0.62;
          let edgeBlocked=(latSign>0.0&&curRightM>halfW-0.12)||(latSign<0.0&&curRightM<-halfW+0.12)||halfW<0.30;
          if(edgeBlocked&&fwd>=0.0&&!oStopped){pushFwdM-=pen*0.42;}
          else if(fwd>0.0&&dist<rSum*0.68&&!oStopped){pushFwdM-=pen*0.24;}
        }
      }
      // Bounded stall breaker (stored in fate.look): if throttled for >1.8 s, smoothly release queuing so no one can trap.
      var stallS=select(0.0,clamp(fate.look,0.0,6.0),init&&!turnedAround);
      if(!stopped&&moveFrac<0.40&&dt>0.0){stallS=min(stallS+dt,6.0);}
      else if(dt>0.0){stallS=max(stallS-dt*1.8,0.0);}
      let escape=smoothstep(1.8,3.4,stallS);
      moveFrac=max(moveFrac,escape);
      pushFwdM*=(1.0-escape);
      let wantRightM=clamp(prefRightM+clamp(steerRightM,-halfW*1.2,halfW*1.2),-halfW,halfW);
      let maxStep=max(0.04,dt*1.65);
      let smoothRightM=curRightM+clamp(wantRightM-curRightM,-maxStep,maxStep);
      let finalRightM=clamp(smoothRightM+clamp(pushRightM,-0.80,0.80),-halfW,halfW);
      latFrac=clamp((finalRightM*going)/halfW,-1.0,1.0);
      if(!stopped&&moveFrac<0.995&&dt>0.0){
        fate.clock-=dt*(1.0-moveFrac);
        let backStep=clamp(pushFwdM,-0.45,0.0);
        metres=clamp(metres+going*backStep,0.0,w.length);
        if(moveFrac<0.16){stopped=true;}
      }else if(pushFwdM<-0.01){
        metres=clamp(metres+going*clamp(pushFwdM,-0.45,0.0),0.0,w.length);
      }
      spot=wayAtLat(w,metres,latFrac);
      lane=going;
      fate.since=time;
      fate.lane=latFrac;
      fate.going=going;
      fate.look=stallS;
      fate.how=1u;
      fates[id.x]=fate;
    }
  }else if(fate.mode==AFRAID){
    ran=clamp(age-${TOWN_STARTLE_S.toFixed(2)},0.0,fate.runFor);
    metres=clamp(fate.along+fate.going*fate.speed*ran,0.0,w.length);
    // Turning back on their way takes them across it to the other side.
    lane=mix(fate.lane,going,smoothstep(0.0,1.0,age));
    // Run to the end of the way and they are through the door, until it is over.
    hidden=ran>0.0&&(metres<=0.0||metres>=w.length)&&((w.flags>>select(2u,1u,going<0.0))&1u)==0u;
    spot=wayAt(w,metres,lane);
  }else{
    spot=wayAt(w,metres,lane);
  }
  var position=spot.position;
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
    var fear=0.0;var danger=vec2f(0.0);var fearReach=1.0;var fearSeed=0.0;var fearBlast=0.0;var fearAway=1e6;
    var struck=false;var directHit=false;var hitSeed=1.0;var hitProx=1.0;var fallsTo=vec2f(0.0,1.0);
    let bodyTop=select(${BODY_HEIGHT_M.toFixed(3)},2.38,isMounted);
    for(var k=0u;k<shots.count;k++){
      let shot=shots.list[k];
      let line=shot.end-shot.start;
      let flat=dot(line.xz,line.xz);
      let toStart=shot.start.xz-position.xz;
      let t=select(0.0,clamp(-dot(toStart,line.xz)/flat,0.0,1.0),flat>1e-6);
      let nearest=toStart+line.xz*t;
      let y=shot.start.y+line.y*t;
      let away=length(vec3f(nearest.x,max(max(position.y-y,y-position.y-bodyTop),0.0),nearest.y));
      let effStrike=shot.strike+select(0.0,0.42,isMounted&&shot.strike>0.0);
      if(!hidden){
        if(away<effStrike){
          struck=true;directHit=true;hitSeed=shot.seed;hitProx=1.0;fallsTo=line.xz;
        }else if(away<shot.blast&&townRoll(id.x,shot.seed)<${TOWN_BLAST_CHANCE.toFixed(2)}*(1.0-away/shot.blast)){
          struck=true;hitSeed=shot.seed;hitProx=clamp(1.0-away/max(shot.blast,0.1),0.25,1.0);fallsTo=-nearest;
        }
      }
      let closeness=1.0-away/shot.reach;
      if(closeness>fear){fear=closeness;danger=position.xz+nearest;fearReach=shot.reach;fearSeed=shot.seed;fearBlast=shot.blast;fearAway=away;}
    }
    if(struck){
      // Half go down on their face and half on their back, and the shot or blast flings them along its path.
      let onBack=select(1u,0u,townRoll(id.x,7.0)<.5);
      let throwDir0=normalize(fallsTo+vec2f(1e-4,0.0));
      let perpDir=vec2f(-throwDir0.y,throwDir0.x)*(townRoll(id.x,hitSeed+5.0)-0.5)*select(0.28,0.42,directHit);
      let throwDir=normalize(throwDir0+perpDir);
      let throwSpeed=select((3.4+townRoll(id.x,hitSeed+6.0)*4.2)*hitProx,4.6+townRoll(id.x,hitSeed+6.0)*3.8,directHit);
      let throwVy=select((1.9+townRoll(id.x,hitSeed+8.0)*2.1)*hitProx,2.4+townRoll(id.x,hitSeed+8.0)*1.9,directHit);
      let rInj=townRoll(id.x,hitSeed+9.0);
      var injuryKind=0u;
      if(directHit){
        if(rInj<0.72){injuryKind=1u+(u32(rInj*100.0)%5u);}
        else if(rInj<0.92){injuryKind=6u+(u32(rInj*100.0)&1u);}
      }else{
        if(rInj<0.38){injuryKind=1u+(u32(rInj*100.0)%4u);}
        else if(rInj<0.68){injuryKind=6u+(u32(rInj*100.0)&1u);}
      }
      let wound4=min(15u,u32((11.0+townRoll(id.x,hitSeed+10.0)*4.9)*max(0.75,hitProx)));
      let scorch4=min(15u,u32((7.0+townRoll(id.x,hitSeed+11.0)*8.9)*max(0.60,hitProx)));
      let seed3=u32(townRoll(id.x,hitSeed+12.0)*7.99)&7u;
      let dmgCode=injuryKind|(wound4<<3u)|(scorch4<<7u)|(seed3<<11u);
      let toward=fallsTo*select(-1.0,1.0,onBack==0u)+vec2f(1e-4,0.0);
      fate.how=onBack|(dmgCode<<1u);
      fate.until=throwDir.x*throwSpeed;
      fate.runFor=throwDir.y*throwSpeed;
      fate.speed=throwVy;
      fate.look=f32(dmgCode);
      fate.mode=FALLING;fate.since=time;fate.along=metres;fate.going=going;fate.lane=lane;fate.heading=atan2(toward.x,toward.y);
      // Their day runs by its own clock only while they are about, so the hour they fell is kept in its place.
      fate.clock=crowd.hours;
      heading=fate.heading;age=0.0;
      fates[id.x]=fate;
    }else if(!isMounted&&fear>0.0&&townRoll(id.x,fearSeed+1.0)<min(1.0,fear*${TOWN_REACT_GAIN.toFixed(2)})){
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
        var survDmg=0u;
        if(fearBlast>0.0&&fearAway<fearBlast*1.45&&!onlyLooks){
          let wProx=clamp(1.0-fearAway/(fearBlast*1.45),0.20,1.0);
          let sInj=select(0u,6u+(id.x&1u),wProx>0.55&&townRoll(id.x,fearSeed+9.0)<0.35);
          let sWound=min(12u,max(4u,u32((6.0+townRoll(id.x,fearSeed+10.0)*6.5)*wProx)));
          let sScorch=min(13u,max(3u,u32((5.0+townRoll(id.x,fearSeed+11.0)*8.0)*wProx)));
          let sSeed=u32(townRoll(id.x,fearSeed+12.0)*7.99)&7u;
          survDmg=sInj|(sWound<<3u)|(sScorch<<7u)|(sSeed<<11u);
        }
        fate.how=select(0u,1u,cowers);
        fate.mode=AFRAID;fate.since=time;fate.along=metres;fate.lane=lane;fate.heading=heading;
        fate.look=select(atan2(toDanger.x,toDanger.y),f32(survDmg),!onlyLooks);
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
  if(fate.mode>=FALLING){
    let fallSpan=${(TOWN_FALL_FRAMES / TOWN_FALL_RATE).toFixed(3)};
    let throwAge=select(min(age,fallSpan),fallSpan,fate.mode==DOWN);
    let vHoriz=vec2f(fate.until,fate.runFor);
    let vy0=max(0.0,fate.speed);
    let g=9.81;
    let tAirFlat=clamp(2.0*vy0/g,0.28,0.96);
    let rightVec=vec2f(spot.forward.y,-spot.forward.x);
    let endXZ=spot.position.xz+vHoriz*(tAirFlat+0.16);
    let endLat=abs(dot(endXZ-spot.centerXZ,rightVec));
    let onPierWay=(w.flags&8u)!=0u && spot.position.y>1.75 && spot.position.y<3.1 && spot.halfWidth<1.35;
    let overPier=onPierWay && endLat>(spot.halfWidth+2.6);
    if(overPier){
      let tSplash=clamp((vy0+sqrt(max(0.0,vy0*vy0+2.0*g*max(0.0,spot.position.y+0.10))))/g,0.32,1.20);
      let flyT=min(throwAge,tSplash);
      let waterT=max(0.0,throwAge-tSplash);
      let waterMax=max(1e-4,1.0-exp(-(fallSpan-tSplash)*4.5));
      let driftT=select(0.0,clamp((1.0-exp(-waterT*4.5))/waterMax,0.0,1.0)*0.10,waterT>0.0);
      let arcY=spot.position.y+vy0*flyT-0.5*g*flyT*flyT;
      let bobY=-0.10+0.04*sin(time*2.2+f32(id.x)*0.73);
      position=vec3f(spot.position.x+vHoriz.x*(flyT+driftT),select(arcY,bobY,throwAge>=tSplash),spot.position.z+vHoriz.y*(flyT+driftT));
    }else{
      let flyT=min(throwAge,tAirFlat);
      let groundT=max(0.0,throwAge-tAirFlat);
      let slideMax=max(1e-4,1.0-exp(-(fallSpan-tAirFlat)*5.0));
      let slideT=select(0.0,clamp((1.0-exp(-groundT*5.0))/slideMax,0.0,1.0)*0.16,groundT>0.0);
      let dispXZ=vHoriz*(flyT+slideT);
      let alongDelta=dot(dispXZ,spot.forward);
      let landSpot=wayAt(w,clamp(metres+alongDelta,0.0,w.length),lane);
      let latSlopeLift=select(0.0,min(0.45,abs(dot(dispXZ,rightVec))*0.09)+0.06,spot.position.y>0.05);
      let groundY=select(spot.position.y,max(spot.position.y,landSpot.position.y)+latSlopeLift,spot.position.y>0.05);
      let baseY=mix(spot.position.y,groundY,clamp(throwAge/max(tAirFlat,0.01),0.0,1.0));
      let saddleDrop=select(0.0,0.62*(1.0-clamp(throwAge/max(tAirFlat,0.01),0.0,1.0)),isMounted);
      let arcY=max(0.0,saddleDrop+vy0*flyT-0.5*g*flyT*flyT);
      let bounceY=select(0.0,sin(groundT/0.24*3.14159)*min(0.18,vy0*0.045),groundT>0.0 && groundT<0.24);
      position=vec3f(spot.position.x+dispXZ.x,baseY+select(arcY,bounceY,throwAge>=tAirFlat),spot.position.z+dispXZ.y);
    }
  }
  if(hidden){return;}
  // Drawn on the ground the land draws there (js/continuum-ground.js) where they walk the land; not on a pier's deck
  // nor in the sea. They are shot and fall where they truly are, above.
  let dry=position.y>-0.02;
  if(dry&&!((w.flags&8u)!=0u&&position.y>1.75)){position.y+=continuumGroundLift(position.xz);}
  let centerY=select(${(BODY_HEIGHT_M * 0.5).toFixed(3)},1.40,isMounted&&fate.mode==ABOUT);
  let relative=position+vec3f(0.0,centerY,0.0)-F.camPos.xyz;
  // Those out of sight are kept only for the shadow they may cast into it, and are never drawn themselves.
  let boundR=select(select(${BODY_BOUND_M.toFixed(2)},1.95,isMounted),${LYING_BOUND_M.toFixed(2)},fate.mode>=FALLING);
  let seen=inFrustum(relative,boundR);
  if(!seen&&(length(relative)>=${SHADOW_NEAR_M.toFixed(1)}||!inFrustum(relative,${SHADOW_MARGIN_M.toFixed(1)}))){return;}
  let model=w.flags&1u;
  let plain=crowd.clips[model*3u];let fright=crowd.clips[model*3u+1u];let fall=crowd.clips[model*3u+2u];
  var first=plain.z;var frames=plain.w;var frame=0.0;var looped=true;
  let breathing=(time+w.phase*97.0)*${CLIP_FRAMES_PER_SECOND.toFixed(1)};
  if(fate.mode==ABOUT){
    if(isMounted){
      let packedRide=(crowd.ride>>(model*16u))&65535u;
      first=fall.z+fall.w;
      frames=select(packedRide,plain.w,packedRide==0u);
      var cycle=walked/${TOWN_RIDE_CYCLE_METRES.toFixed(3)}+w.phase*7.0;
      if(stopped){cycle=breathing/(f32(frames)*2.5);}
      frame=fract(cycle)*f32(frames);
    }else{
      // A stride's frame follows the ground covered, so feet do not slide.
      var cycle=walked/${CREW_WALK_CYCLE_METRES.toFixed(3)}+w.phase*7.0;
      if(stopped){first=plain.x;frames=plain.y;cycle=breathing/f32(frames);}
      frame=fract(cycle)*f32(frames);
    }
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
  let dmgCode=select(select(0u,u32(max(0.0,fate.look)),fate.mode==AFRAID&&(fate.runFor>0.0||fate.how==1u)),fate.how>>1u,fate.mode>=FALLING);
  let blend=select(fract(frame),0.0,fate.mode==DOWN);
  // Kept, in the run of their body's people: everyone kept is posed, and the cut decides who is drawn and how.
  let kept=atomicAdd(&counts[model*${TOWNSFOLK_DISPATCH_WORDS}u],1u);
  let c=cos(heading);let s=sin(heading);
  // Turned by their heading about the vertical: +z, the way they face, comes round toward +x.
  let transform=mat4x4f(vec4f(c,0.0,-s,0.0),vec4f(0.0,1.0,0.0,0.0),vec4f(s,0.0,c,0.0),vec4f(position,1.0));
  // The fallen and the hurt are cut finer, and anyone in the sea is wet through.
  let important=select(0u,${CREW_CONTINUUM_ORDER_IMPORTANT}u,fate.mode>=FALLING||dmgCode>0u);
  let wet=select(0u,${TOWNSFOLK_SEA_MOISTURE}u,!dry);
  placed[select(0u,crowd.second,model==1u)+kept]=CrewPlaced(transform,vec4u(first+whole,first+after,first+whole,model*crowd.looks+w.look%crowd.looks),vec4f(blend,0.0,0.0,0.0),vec4u(id.x,dmgCode,important,wet));
}
`;
export const TOWNSFOLK_RESET = /* wgsl */ `
@group(0) @binding(0) var<storage,read_write> counts:array<u32>;
@compute @workgroup_size(32) fn main(@builtin(global_invocation_id) id:vec3u){
  if(id.x<${TOWNSFOLK_MODELS}u){counts[id.x*${TOWNSFOLK_DISPATCH_WORDS}u]=0u;}
}
`;

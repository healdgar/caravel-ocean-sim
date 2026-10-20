import { boatForwardSpeed } from './boat.js';
import { SAIL_KEYS, sailingState } from './sailing.js';
import { requestYardTransfer, yardTransferAvailable } from './lateen.js';

const RAD=Math.PI/180;
const wrap=a=>Math.atan2(Math.sin(a),Math.cos(a));
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));

// A helm policy, not a motion controller: it writes only rudder and sail targets.
// The hull receives every acceleration and turn from the ordinary sailing model.
export function createFollower(){return {tack:0,tackAge:0,ironsTime:0,recovering:false,recoveryTack:0,transferCooldown:0,course:0,status:'Following',separation:0};}
export function steerFollower(state,boat,leader,dt,windSpeed,windDirection){
  const h=leader.heading*RAD,L=Math.max(leader.length,boat.length);
  const trail=L*2.8,side=L*1.5;
  const goalX=leader.x-Math.sin(h)*trail+Math.cos(h)*side;
  const goalZ=leader.z+Math.cos(h)*trail+Math.sin(h)*side;
  let dx=goalX-boat.x,dz=goalZ-boat.z;
  const separation=Math.hypot(boat.x-leader.x,boat.z-leader.z);state.separation=separation;
  const errorDistance=Math.hypot(dx,dz),lookAhead=L*1.8;
  // Look down the leader's course at station; direct point chasing would make
  // small wake-induced errors command a complete turn at the formation slot.
  dx+=Math.sin(h)*lookAhead;dz-=Math.cos(h)*lookAhead;
  if(separation<L*1.8){
    const awayX=(boat.x-leader.x)/Math.max(separation,.01),awayZ=(boat.z-leader.z)/Math.max(separation,.01);
    dx+=awayX*L*5;dz+=awayZ*L*5;
  }
  let course=Math.atan2(dx,-dz);
  const windFrom=Math.atan2(-Math.cos(windDirection),Math.sin(windDirection));
  const noGo=62*RAD,relative=wrap(course-windFrom);
  state.tackAge+=dt;
  state.transferCooldown=Math.max(0,state.transferCooldown-dt);
  if(Math.abs(relative)<noGo&&windSpeed>.5){
    if(!state.tack)state.tack=Math.sign(wrap(boat.heading*RAD-windFrom))||1;
    // Commit to a tack until the destination lies well across it. Routine tacks
    // retain the yard side; they never trigger repeated full yard transfers.
    if(state.tackAge>35&&relative*state.tack<-.35&&errorDistance>L*4){state.tack*=-1;state.tackAge=0;}
    course=windFrom+state.tack*noGo;state.status='Tacking to follow';
  }else{state.status=separation<L*1.8?'Keeping clear':'Following';if(Math.abs(relative)>.2)state.tack=Math.sign(relative);}
  const heading=boat.heading*RAD,speed=boatForwardSpeed(boat),error=wrap(course-heading);
  state.ironsTime=Math.abs(wrap(heading-windFrom))<42*RAD&&speed<.35?state.ironsTime+dt:0;
  let rudder=clamp(error/RAD*1.1-(boat.yawRate??0)/RAD*5,-35,35);
  if(!state.recovering&&state.ironsTime>4){state.recovering=true;state.recoveryTack=state.tack||1;}
  if(state.recovering&&speed>.45&&Math.abs(wrap(heading-windFrom))>75*RAD){state.recovering=false;state.recoveryTack=0;}
  if(state.recovering){
    // Carry the bow across to a beam reach before attempting to climb back to
    // the close-hauled course. Leaving recovery at 42 degrees can trap a heavy
    // vessel in persistent sternway with its canvas still backed.
    // Pursuit may cross the wind while the hull is backing. Retain this escape
    // side until forward flow is established, independently of the next tack.
    course=windFrom+state.recoveryTack*100*RAD;
    const escape=wrap(course-heading);
    // Once wind has produced sternway, reverse the rudder for that real flow.
    // With no water flow this command produces no yaw authority.
    rudder=clamp(escape/RAD*1.4,-35,35)*(speed<-.12?-1:1);state.status='Recovering from irons';
    const rig=sailingState(boat);
    // A sustained recovery on the bad tack can warrant one deliberate transfer,
    // after the bow is clear of the wind. This cannot chatter while in irons.
    if(Math.abs(wrap(heading-windFrom))>80*RAD&&state.tackAge>20&&state.transferCooldown===0&&yardTransferAvailable(rig)){
      if(requestYardTransfer(rig))state.transferCooldown=180;
    }
    if(rig.maneuver)state.status='Handling yards to recover';
  }else if(speed<-.12)rudder=-rudder;
  boat.propulsion='sail';boat.rudderTarget=rudder;
  const leaderSpeed=Math.max(0,boatForwardSpeed(leader));
  const forwardError=(goalX-boat.x)*Math.sin(h)-(goalZ-boat.z)*Math.cos(h);
  const stationScale=clamp(.9+forwardError/(L*4),.12,1);
  const stormScale=windSpeed>28?.18:windSpeed>20?.4:1;
  const canvas=separation<L*1.3?.05:Math.min(stationScale,stormScale);
  // A newly sailing leader is still accelerating at its formation station.
  // Only a stopped leader with no requested canvas asks the companion to stop.
  const leaderSailing=SAIL_KEYS.some(key=>(leader[key]??0)>.01);
  for(const key of SAIL_KEYS)boat[key]=!leaderSailing&&leaderSpeed<.15&&forwardError<L*.5&&errorDistance<L*2?0:canvas;
  state.course=((course/RAD)%360+360)%360;
  return state;
}

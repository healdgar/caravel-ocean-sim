import { boatForwardSpeed } from './boat.js';
import { SAIL_KEYS, sailingState } from './sailing.js';
import { requestYardTransfer, yardTransferAvailable } from './lateen.js';

const RAD=Math.PI/180;
const wrap=a=>Math.atan2(Math.sin(a),Math.cos(a));
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));

// A helm policy, not a motion controller: it writes only rudder and sail targets.
// The hull receives every acceleration and turn from the ordinary sailing model.
export function createFollower(formation={trail:2.8,side:1.5}){return {formation:{...formation},tack:0,tackAge:0,ironsTime:0,recovering:false,recoveryTack:0,transferCooldown:0,helmTrim:0,course:0,trackCourse:0,noGoAngle:62,stationVelocityX:0,stationVelocityZ:0,status:'Following',separation:0};}
export function steerFollower(state,boat,leader,dt,windSpeed,windDirection,neighbors=null){
  dt=Number.isFinite(dt)?clamp(dt,0,.25):0;
  const h=leader.heading*RAD,L=Math.max(leader.length,boat.length);
  const trail=L*(state.formation?.trail??2.8),side=L*(state.formation?.side??1.5);
  const offsetX=-Math.sin(h)*trail+Math.cos(h)*side,offsetZ=Math.cos(h)*trail+Math.sin(h)*side;
  const goalX=leader.x+offsetX,goalZ=leader.z+offsetZ;
  let dx=goalX-boat.x,dz=goalZ-boat.z;
  const separation=Math.hypot(boat.x-leader.x,boat.z-leader.z);state.separation=separation;
  const errorDistance=Math.hypot(dx,dz),lookAhead=L*1.8;
  const leaderSpeed=boatForwardSpeed(leader),leaderSway=Number.isFinite(leader.leewayVelocity)?leader.leewayVelocity:0;
  const leaderYaw=Number.isFinite(leader.yawRate)?leader.yawRate:0;
  const leaderVX=Math.sin(h)*leaderSpeed+Math.cos(h)*leaderSway,leaderVZ=-Math.cos(h)*leaderSpeed+Math.sin(h)*leaderSway;
  const groundSpeed=Math.hypot(leaderVX,leaderVZ),guidanceTime=lookAhead/Math.max(.5,groundSpeed);
  // An offset station rotates around a turning leader. Follow its actual world
  // velocity, including leeway, instead of treating the bow heading as its track.
  state.stationVelocityX=leaderVX-leaderYaw*offsetZ;
  state.stationVelocityZ=leaderVZ+leaderYaw*offsetX;
  dx+=(groundSpeed>.25?state.stationVelocityX:Math.sin(h)*.5)*guidanceTime;
  dz+=(groundSpeed>.25?state.stationVelocityZ:-Math.cos(h)*.5)*guidanceTime;
  if(separation<L*1.8){
    const awayX=(boat.x-leader.x)/Math.max(separation,.01),awayZ=(boat.z-leader.z)/Math.max(separation,.01);
    dx+=awayX*L*5;dz+=awayZ*L*5;
  }
  if(neighbors)for(const other of neighbors){
    if(other===boat||other===leader||other.showProw===false)continue;
    const ax=boat.x-other.x,az=boat.z-other.z,d=Math.hypot(ax,az),clearance=Math.max(boat.length,other.length)*2;
    if(d<clearance){const away=d>.01?[ax/d,az/d]:[Math.cos(h)*Math.sign(side||1),Math.sin(h)*Math.sign(side||1)];
      const strength=(1-d/clearance)*L*6;dx+=away[0]*strength;dz+=away[1]*strength;}
  }
  const heading=boat.heading*RAD,speed=boatForwardSpeed(boat);
  const leeway=speed>.35?clamp(Math.atan2(boat.leewayVelocity??0,speed),-30*RAD,30*RAD):0;
  const track=Math.hypot(dx,dz)>1e-6?Math.atan2(dx,-dz):h;
  let course=wrap(track-leeway);
  state.trackCourse=((track/RAD)%360+360)%360;
  const windFrom=Math.atan2(-Math.cos(windDirection),Math.sin(windDirection));
  // A same-model leader making headway with positive sail drive demonstrates a
  // usable course. A fixed 62-degree limit otherwise forbids its escort from
  // following it close-hauled. Other hulls keep the conservative authored limit.
  const demonstrated=(boat.modelId??'nina')===(leader.modelId??'nina')&&leaderSpeed>.65&&(leader.sailState?.forward??0)>0;
  const noGo=demonstrated?clamp(Math.abs(wrap(h-windFrom)),45*RAD,62*RAD):62*RAD,relative=wrap(course-windFrom);
  state.noGoAngle=noGo/RAD;
  state.tackAge+=dt;
  state.transferCooldown=Math.max(0,state.transferCooldown-dt);
  if(Math.abs(relative)<noGo&&windSpeed>.5){
    if(!state.tack)state.tack=Math.sign(wrap(boat.heading*RAD-windFrom))||1;
    // Commit to a tack until the destination lies well across it. Routine tacks
    // retain the yard side; they never trigger repeated full yard transfers.
    if(state.tackAge>35&&relative*state.tack<-.35&&errorDistance>L*4){state.tack*=-1;state.tackAge=0;}
    course=windFrom+state.tack*noGo;state.status='Tacking to follow';
  }else{state.status=separation<L*1.8?'Keeping clear':'Following';if(Math.abs(relative)>.2)state.tack=Math.sign(relative);}
  state.ironsTime=Math.abs(wrap(heading-windFrom))<42*RAD&&speed<.35?state.ironsTime+dt:0;
  let rudder;
  if(!state.recovering&&state.ironsTime>4){state.recovering=true;state.recoveryTack=state.tack||1;}
  if(state.recovering&&speed>.45&&Math.abs(wrap(heading-windFrom))>75*RAD){state.recovering=false;state.recoveryTack=0;}
  if(state.recovering){
    state.helmTrim=0;
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
    if((boat.model?.capabilities?.yardTransfer??(boat.modelId===undefined||boat.modelId==='nina'))&&Math.abs(wrap(heading-windFrom))>80*RAD&&state.tackAge>20&&state.transferCooldown===0&&yardTransferAvailable(rig)){
      if(requestYardTransfer(rig))state.transferCooldown=180;
    }
    if(rig.maneuver)state.status='Handling yards to recover';
  }else{
    const error=wrap(course-heading)/RAD,turn=state.status==='Following'?leaderYaw:0;
    const turnHelm=Math.atan(turn*Math.max(boat.length,3)/(Math.max(.6,Math.abs(speed))*.65))/RAD;
    const damping=((boat.yawRate??0)-turn)/RAD*5;
    const before=error*1.1-damping+turnHelm+(state.helmTrim??0);
    // A real sustained wind/hull yaw load needs a steady helm angle. Integral
    // trim learns it through measured heading error, with flow gating and
    // anti-windup. Only the rudder target changes; zero flow still cannot turn.
    if(speed>.4&&Math.abs(error)<35&&(Math.abs(before)<35||Math.sign(before)!==Math.sign(error)))
      state.helmTrim=clamp((state.helmTrim??0)+error*.06*dt,-20,20);
    else if(speed<=.4)state.helmTrim=(state.helmTrim??0)*Math.exp(-dt*.1);
    rudder=clamp(error*1.1-damping+turnHelm+(state.helmTrim??0),-35,35);
    if(speed<-.12)rudder=-rudder;
    if(speed>.4&&Number.isFinite(boat.steeringLoadAcceleration)&&Number.isFinite(boat.steeringResponse)){
      // Invert only the real, flow-dependent helm response. Balance the last
      // observed wind/hull moment through actual rudder deflection, rather than
      // allowing a slow integral to chase weather helm around the formation.
      const blend=1-Math.exp(-dt*2);
      state.loadAcceleration=(state.loadAcceleration??boat.steeringLoadAcceleration)
        +(boat.steeringLoadAcceleration-(state.loadAcceleration??boat.steeringLoadAcceleration))*blend;
      const rate=boat.yawRate??0,targetRate=turn+clamp(error*RAD/15,-.035,.035);
      const requested=rate+boat.steeringResponse*((targetRate-rate)*.5-state.loadAcceleration);
      rudder=clamp(Math.atan(requested*Math.max(boat.length,3)/(speed*.65))/RAD,-35,35);
      state.helmTrim*=Math.exp(-dt*.5);
    }
  }
  boat.propulsion='sail';boat.rudderTarget=rudder;
  const forwardError=(goalX-boat.x)*Math.sin(h)-(goalZ-boat.z)*Math.cos(h);
  let leaderCanvas=0;for(const key of SAIL_KEYS)leaderCanvas=Math.max(leaderCanvas,clamp(leader[key]??0,0,1));
  const stationForward=state.stationVelocityX*Math.sin(heading)-state.stationVelocityZ*Math.cos(heading);
  const stationScale=clamp((leaderCanvas>.01?leaderCanvas:.9)+forwardError/(L*4)+(stationForward-speed)*.15,.12,1);
  const stormScale=windSpeed>28?.18:windSpeed>20?.4:1;
  const canvas=separation<L*1.3?.05:Math.min(stationScale,stormScale);
  // A newly sailing leader is still accelerating at its formation station.
  // Only a stopped leader with no requested canvas asks the companion to stop.
  const leaderSailing=leaderCanvas>.01;
  for(const key of SAIL_KEYS)boat[key]=!leaderSailing&&leaderSpeed<.15&&forwardError<L*.5&&errorDistance<L*2?0:canvas;
  state.course=((course/RAD)%360+360)%360;
  return state;
}

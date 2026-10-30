import { boatForwardSpeed } from './boat.js';
import { SAIL_KEYS, sailingState } from './sailing.js';
import { requestYardTransfer, yardTransferAvailable } from './lateen.js';
import { isProceduralDesign, proceduralDesign } from './models/procedural.js';

const RAD=Math.PI/180;
const wrap=a=>Math.atan2(Math.sin(a),Math.cos(a));
const clamp=(v,a,b)=>Math.max(a,Math.min(b,v));
const followerControlKeys={fore:'sailFore',main:'sailMain',mizzen:'sailMizzen'};
const followerControls=new Map();
const CAPTAIN_SAIL_TARGETS=Object.freeze({
  full:Object.freeze([1,1,1]),
  reduced:Object.freeze([.55,.55,.45]),
  furl:Object.freeze([0,0,0]),
  weather:Object.freeze([.35,.35,0]),
});
function followerSailKeys(boat){
  const id=boat.modelId??'nina';
  if(id==='nina'||id==='victory')return SAIL_KEYS;
  if(followerControls.has(id))return followerControls.get(id);
  const controls=new Set(proceduralDesign(id).surfaces.map(surface=>{
    const key=followerControlKeys[surface.controlGroup];
    if(!key)throw Error('No follower sail control for '+id+': '+surface.controlGroup);
    return key;
  }));
  const keys=SAIL_KEYS.filter(key=>controls.has(key));followerControls.set(id,keys);return keys;
}
function followerCanvas(boat){let canvas=0;for(const key of followerSailKeys(boat))canvas=Math.max(canvas,clamp(boat[key]??0,0,1));return canvas;}

// Rowing is another human control policy. Differential strokes can turn a
// stationary hull through immersed blades; they never set velocity or heading.
function followerRowing(state,boat,leader,{course,heading,speed,windFrom,windSpeed,leaderSpeed,groundSpeed,forwardError,errorDistance,separation,L}){
  state.tack=state.tackAge=state.ironsTime=state.recoveryTack=state.transferCooldown=state.helmTrim=0;
  state.recovering=false;state.noGoAngle=0;
  const isEnemy=state.faction==='enemy';
  const orderStop=!isEnemy&&(state.captainOrder==='furl'||state.captainOrder==='drop-anchor');
  const error=wrap(course-heading)/RAD,yaw=(boat.yawRate??0)/RAD;
  const leaderEffort=Number.isFinite(leader.rowingEffort)?clamp(leader.rowingEffort,0,1):0,leaderCanvas=followerCanvas(leader);
  const working=isEnemy||leaderEffort>.01||leaderCanvas>.01||groundSpeed>.15;
  const resting=orderStop||(!working&&Math.abs(leaderSpeed)<.15&&forwardError<L*.5&&errorDistance<L*2);
  const stationForward=state.stationVelocityX*Math.sin(heading)-state.stationVelocityZ*Math.cos(heading);
  const orderEffortCap=!isEnemy&&state.captainOrder==='weather'?.35:!isEnemy&&state.captainOrder==='reduced'?.55:1;
  let effort=resting?0:clamp((leaderEffort>.01?leaderEffort:.55)+forwardError/(L*4)+(stationForward-speed)*.18,0,orderEffortCap);
  // A heading change is carried out by real one-sided strokes, including when
  // coasting astern. Only the flow-dependent steering oar reverses its helm.
  const turn=resting?0:clamp(error/65-yaw*.08,-1,1);
  if(!resting&&Math.abs(error)>30)effort=Math.max(effort,Math.min(.35,orderEffortCap));
  boat.propulsion='sail';boat.rowingEffort=effort;boat.rowingTurn=turn;
  boat.rudderTarget=resting?0:clamp(error*1.1-yaw*5,-35,35)*(speed<-.12?-1:1);
  const keys=followerSailKeys(boat),angle=Math.min(Math.abs(wrap(course-windFrom)),Math.abs(wrap(heading-windFrom)));
  // Sail assistance is optional; approaching the wind furls actual canvas
  // instead of diverting a rowed course or entering a sail recovery maneuver.
  const usableWind=windSpeed>.5&&angle>=70*RAD;
  const stormScale=windSpeed>28?.18:windSpeed>20?.4:1;
  const canvas=resting||!usableWind||boat.damage?.sunk?0:Math.min(effort,stormScale);
  const orderedSails=!isEnemy?CAPTAIN_SAIL_TARGETS[state.captainOrder]:null;
  for(const [i,key] of SAIL_KEYS.entries()){
    const group=key==='sailFore'?'fore':key==='sailMizzen'?'mizzen':'main';
    const mastCap=boat.damage?.mastIntegrity?.[group]??1;
    const cap=orderedSails?Math.min(mastCap,orderedSails[i]):mastCap;
    boat[key]=keys.includes(key)?Math.min(canvas,cap):0;
  }
  state.course=((course/RAD)%360+360)%360;
  state.status=boat.damage?.sunk?'Foundering':orderStop?(state.captainOrder==='drop-anchor'?'Anchored by order':'Resting by order'):resting?'Resting at station':separation<L*1.8?'Rowing clear':isEnemy?'Rowing to engage':'Rowing to follow';
  return state;
}

// A helm policy: it writes only rudder, canvas and human rowing commands.
// The hull receives every acceleration and turn from the ordinary sailing model.
export function createFollower(formation={trail:2.8,side:1.5},options={}){
  const faction=(options.faction??formation?.faction)==='enemy'?'enemy':'friendly';
  return {
    formation:{...formation},
    faction,
    captainOrder:options.captainOrder??null,
    followGunneryOrders:Boolean(options.followGunneryOrders),
    pendingCaptainFire:null,
    combatTimer:0,
    salvoDelay:Number.isFinite(options.salvoDelay)?options.salvoDelay:0,
    tack:0,tackAge:0,ironsTime:0,recovering:false,recoveryTack:0,transferCooldown:0,helmTrim:0,
    course:0,trackCourse:0,noGoAngle:62,stationVelocityX:0,stationVelocityZ:0,
    status:faction==='enemy'?'Engaging broadside':'Following',separation:0,
  };
}
export function steerFollower(state,boat,leader,dt,windSpeed,windDirection,neighbors=null){
  state.separation=Math.hypot((boat.x??0)-(leader.x??0),(boat.z??0)-(leader.z??0));
  if(boat.settledWreck||boat.damage?.settledWreck){
    state.status='Sunk (wreck)';
    return state;
  }
  dt=Number.isFinite(dt)?clamp(dt,0,.25):0;
  const isEnemy=state.faction==='enemy';
  const h=leader.heading*RAD,L=Math.max(leader.length,boat.length);
  let trail=L*(state.formation?.trail??2.8),side=L*(state.formation?.side??1.5);
  if(isEnemy&&!state.formation?.broadside){
    // Hostile AI maneuvers onto a beam broadside battle station alongside its
    // target rather than trailing astern in escort formation.
    const relSide=(boat.x-leader.x)*Math.cos(h)+(boat.z-leader.z)*Math.sin(h);
    const beamSign=Math.abs(relSide)>L*.25?Math.sign(relSide):(Math.sign(state.formation?.side||1)||1);
    const rangeLengths=clamp(Math.abs(state.formation?.side||1.25),1.15,1.65);
    trail=0;
    side=L*beamSign*rangeLengths;
  }
  const offsetX=-Math.sin(h)*trail+Math.cos(h)*side,offsetZ=Math.cos(h)*trail+Math.sin(h)*side;
  const goalX=leader.x+offsetX,goalZ=leader.z+offsetZ;
  let dx=goalX-boat.x,dz=goalZ-boat.z;
  const separation=Math.hypot(boat.x-leader.x,boat.z-leader.z);state.separation=separation;
  const errorDistance=Math.hypot(dx,dz),lookAhead=L*1.8;
  const rawLeaderSpeed=boatForwardSpeed(leader),leaderSpeed=Number.isFinite(rawLeaderSpeed)?rawLeaderSpeed:0;
  const leaderSway=Number.isFinite(leader.leewayVelocity)?leader.leewayVelocity:0;
  const leaderYaw=Number.isFinite(leader.yawRate)?leader.yawRate:0;
  const leaderVX=Math.sin(h)*leaderSpeed+Math.cos(h)*leaderSway,leaderVZ=-Math.cos(h)*leaderSpeed+Math.sin(h)*leaderSway;
  const groundSpeed=Math.hypot(leaderVX,leaderVZ),guidanceTime=lookAhead/Math.max(.5,groundSpeed);
  // An offset station rotates around a turning leader. Follow its actual world
  // velocity, including leeway, instead of treating the bow heading as its track.
  state.stationVelocityX=leaderVX-leaderYaw*offsetZ;
  state.stationVelocityZ=leaderVZ+leaderYaw*offsetX;
  dx+=(groundSpeed>.25?state.stationVelocityX:Math.sin(h)*.5)*guidanceTime;
  dz+=(groundSpeed>.25?state.stationVelocityZ:-Math.cos(h)*.5)*guidanceTime;
  const stationDist=Math.hypot(trail,side);
  const minClearance=Math.min(L*1.8,Math.max(L*0.65,stationDist*0.78));
  if(separation<minClearance){
    const awayX=(boat.x-leader.x)/Math.max(separation,.01),awayZ=(boat.z-leader.z)/Math.max(separation,.01);
    dx+=awayX*L*5;dz+=awayZ*L*5;
  }
  if(neighbors)for(const other of neighbors){
    if(other===boat||other===leader||other.showProw===false)continue;
    const ax=boat.x-other.x,az=boat.z-other.z,d=Math.hypot(ax,az),clearance=Math.max(boat.length,other.length)*2;
    if(d<clearance){const away=d>.01?[ax/d,az/d]:[Math.cos(h)*Math.sign(side||1),Math.sin(h)*Math.sign(side||1)];
      const strength=(1-d/clearance)*L*6;dx+=away[0]*strength;dz+=away[1]*strength;}
  }
  const rawSpeed=boatForwardSpeed(boat),speed=Number.isFinite(rawSpeed)?rawSpeed:0;
  const heading=boat.heading*RAD;
  const leeway=speed>.35?clamp(Math.atan2(boat.leewayVelocity??0,speed),-30*RAD,30*RAD):0;
  const track=Math.hypot(dx,dz)>1e-6?Math.atan2(dx,-dz):h;
  let course=wrap(track-leeway);
  state.trackCourse=((track/RAD)%360+360)%360;
  const windFrom=Math.atan2(-Math.cos(windDirection),Math.sin(windDirection));
  if(isProceduralDesign(boat.modelId)&&proceduralDesign(boat.modelId).capabilities?.rowing){
    const forwardError=(goalX-boat.x)*Math.sin(h)-(goalZ-boat.z)*Math.cos(h);
    return followerRowing(state,boat,leader,{course,heading,speed,windFrom,windSpeed,leaderSpeed,groundSpeed,forwardError,errorDistance,separation,L});
  }
  // A same-model leader making headway with positive sail drive demonstrates a
  // usable course. A fixed 62-degree limit otherwise forbids its escort from
  // following it close-hauled. Other hulls keep the conservative authored limit.
  const demonstrated=(boat.modelId??'nina')===(leader.modelId??'nina')&&leaderSpeed>.65&&(leader.sailState?.forward??0)>0;
  const noGo=demonstrated?clamp(Math.abs(wrap(h-windFrom)),45*RAD,62*RAD):62*RAD,relative=wrap(course-windFrom);
  state.noGoAngle=noGo/RAD;
  state.tackAge+=dt;
  state.transferCooldown=Math.max(0,state.transferCooldown-dt);
  if(isEnemy&&leader.damage?.sunk){
    if(!state.tack)state.tack=Math.sign(wrap(heading-windFrom))||1;
    course=windFrom+state.tack*95*RAD;
    state.status='Target sunk · standing off';
  }else if(Math.abs(relative)<noGo&&windSpeed>.5){
    if(!state.tack)state.tack=Math.sign(wrap(boat.heading*RAD-windFrom))||1;
    // Commit to a tack until the destination lies well across it. Routine tacks
    // retain the yard side; they never trigger repeated full yard transfers.
    if(state.tackAge>35&&relative*state.tack<-.35&&errorDistance>L*4){state.tack*=-1;state.tackAge=0;}
    course=windFrom+state.tack*noGo;state.status=isEnemy?'Tacking to engage':'Tacking to follow';
  }else{
    state.status=separation<minClearance?'Keeping clear':state.formation?.broadside?'Broadside station':isEnemy?(errorDistance>L*1.6?'Closing to engage':'Engaging broadside'):'Following';
    if(Math.abs(relative)>.2)state.tack=Math.sign(relative);
  }
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
    const error=wrap(course-heading)/RAD,turn=(state.status==='Following'||state.status==='Engaging broadside'||state.status==='Broadside station')?leaderYaw:0;
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
  const leaderCanvas=followerCanvas(leader);
  const stationForward=state.stationVelocityX*Math.sin(heading)-state.stationVelocityZ*Math.cos(heading);
  const stormScale=windSpeed>28?.18:windSpeed>20?.4:1;
  const minCanvasDist=Math.min(L*1.3,Math.max(L*0.55,stationDist*0.72));
  const inCombatEngagement=isEnemy&&Boolean(
    state.formation?.broadside||(leader?.damage?.hits??0)>0||(boat?.damage?.hits??0)>0||(leader?.damage?.rigIntegrity??1)<0.99||(boat?.damage?.rigIntegrity??1)<0.99
  );
  if(inCombatEngagement&&state.baseFightingCanvas===undefined){
    const initialCanvas=followerCanvas(boat);
    state.baseFightingCanvas=initialCanvas>0.15?initialCanvas:(leaderCanvas>0.15?leaderCanvas:0.55);
  }
  const baseCanvas=inCombatEngagement
    ?state.baseFightingCanvas
    :isEnemy?(leaderCanvas>.15?leaderCanvas:.72):(leaderCanvas>.01?leaderCanvas:.9);
  const stationScale=inCombatEngagement
    ?clamp(baseCanvas,0.35,1)
    :clamp(baseCanvas+forwardError/(L*4)+(stationForward-speed)*.15,isEnemy?.35:.12,1);
  const canvas=separation<minCanvasDist?.05:Math.min(stationScale,stormScale);
  // A newly sailing leader is still accelerating at its formation station.
  // Only a stopped leader with no requested canvas asks a friendly companion to stop;
  // an enemy vessel keeps fighting sail to close and bring its broadside to bear.
  const leaderSailing=isEnemy||leaderCanvas>.01;
  const activeKeys=followerSailKeys(boat);
  const orderedSails=!isEnemy?CAPTAIN_SAIL_TARGETS[state.captainOrder]:null;
  const orderFurl=!isEnemy&&(state.captainOrder==='furl'||state.captainOrder==='drop-anchor');
  for(const [i,key] of SAIL_KEYS.entries()){
    const group=key==='sailFore'?'fore':key==='sailMizzen'?'mizzen':'main';
    const mInt=boat.damage?.mastIntegrity?.[group]??1;
    const mState=boat.damage?.mastState?.[group]??0;
    const mastCap=boat.damage?.sunk?0:mInt*(mState>=2?0:mState===1?0.42:1);
    let desired=0;
    if(activeKeys.includes(key)&&!orderFurl){
      if(orderedSails&&(state.captainOrder==='weather'||state.captainOrder==='reduced')){
        desired=orderedSails[i];
      }else{
        desired=!leaderSailing&&leaderSpeed<.15&&forwardError<L*.5&&errorDistance<L*2?0:canvas;
        if(orderedSails)desired=Math.min(desired,orderedSails[i]);
      }
    }
    boat[key]=Math.min(desired*mastCap,mastCap);
  }
  if(!isEnemy&&orderFurl&&!boat.damage?.sunk){
    state.status=state.captainOrder==='drop-anchor'?'Anchored by order':'Furling sails by order';
  }
  if(boat.damage?.sunk)state.status='Foundering';
  state.course=((course/RAD)%360+360)%360;
  return state;
}

export function selectBroadsideFacingTarget(boat,targetBoat){
  const target=targetBoat?.boat??targetBoat;
  if(!boat||!target)return {side:'starboard',distance:Infinity,sideDot:0,foreDot:0,bearingCos:0,foreRatio:1};
  const dx=(target.x??0)-(boat.x??0),dz=(target.z??0)-(boat.z??0);
  const distance=Math.hypot(dx,dz);
  const h=(boat.heading??0)*RAD;
  // Starboard unit vector is (cos(h), sin(h)), forward unit vector is (sin(h), -cos(h))
  const sideDot=dx*Math.cos(h)+dz*Math.sin(h);
  const foreDot=dx*Math.sin(h)-dz*Math.cos(h);
  const side=sideDot>=0?'starboard':'port';
  const bearingCos=distance>1e-4?Math.abs(sideDot)/distance:1;
  const foreRatio=distance>1e-4?Math.abs(foreDot)/distance:0;
  return {side,distance,sideDot,foreDot,bearingCos,foreRatio};
}

export function aimElevationForRange(boat,targetBoat,distance){
  const d=Number.isFinite(distance)?distance:selectBroadsideFacingTarget(boat,targetBoat).distance;
  if(!Number.isFinite(d)||d<=55)return 0.4;
  // Empirical ballistic elevation curve for ~420-480 m/s smoothbore ordnance with air drag
  const deg=clamp((d-45)*0.0135+Math.max(0,d-220)*0.006,0.2,9.5);
  return +deg.toFixed(2);
}

export function isFriendlyInLineOfFire(boat,side,allies=[],maxRange=650){
  if(!boat||!Array.isArray(allies)||!allies.length)return false;
  const h=(boat.heading??0)*RAD;
  const sideSign=side==='port'?-1:1;
  const sx=Math.cos(h)*sideSign,sz=Math.sin(h)*sideSign;
  const fx=Math.sin(h),fz=-Math.cos(h);
  for(const entry of allies){
    const ally=entry?.boat??entry;
    if(!ally||ally===boat||ally.damage?.sunk||ally.showProw===false)continue;
    const dx=(ally.x??0)-(boat.x??0),dz=(ally.z??0)-(boat.z??0);
    const sideDist=dx*sx+dz*sz;
    if(sideDist<=2||sideDist>maxRange)continue;
    const foreDist=Math.abs(dx*fx+dz*fz);
    const halfSpan=(boat.length??25)*0.48+(ally.length??25)*0.55+sideDist*0.22;
    if(foreDist<=halfSpan)return true;
  }
  return false;
}

export function commandFriendlyVessel(vessel,command,{target=null,allies=[],anchorEnv=null}={}){
  if(!vessel||!vessel.boat||vessel.boat.damage?.sunk)return false;
  const faction=vessel.faction??vessel.follower?.faction??'friendly';
  if(faction==='enemy')return false;
  const boat=vessel.boat,follower=vessel.follower,gunnery=vessel.gunnery;
  const cmd=typeof command==='string'?{type:'crew',id:command}:command;
  if(!cmd)return false;

  if(cmd.type==='crew'||(!cmd.type&&typeof cmd.id==='string')){
    const id=cmd.id;
    if(id==='drop-anchor'){
      if(follower){follower.captainOrder='drop-anchor';follower.pendingCaptainFire=null;}
      gunnery?.standDown?.();
      for(const key of SAIL_KEYS)boat[key]=0;
      return Boolean(vessel.anchor?.drop?.(boat,anchorEnv)??true);
    }
    if(id==='weigh-anchor'){
      if(follower&&follower.captainOrder==='drop-anchor')follower.captainOrder='watch';
      return Boolean(vessel.anchor?.weigh?.()??true);
    }
    if(id==='transfer'){
      gunnery?.standDown?.();
      if(vessel.crew?.order(boat,'transfer'))return true;
      return Boolean(requestYardTransfer(sailingState(boat)));
    }
    if(follower){
      follower.captainOrder=id;
      follower.pendingCaptainFire=null;
    }
    gunnery?.standDown?.();
    const applied=vessel.crew?.order(boat,id)??false;
    const sails=CAPTAIN_SAIL_TARGETS[id];
    if(sails){
      boat.propulsion='sail';
      const activeKeys=followerSailKeys(boat);
      for(const [i,key] of SAIL_KEYS.entries()){
        boat[key]=activeKeys.includes(key)?sails[i]:0;
      }
      return true;
    }
    return applied||id==='watch';
  }

  if(!gunnery||!gunnery.state?.guns?.length)return false;
  const enemyBoat=target?.boat??target;
  const liveEnemy=enemyBoat&&!enemyBoat.damage?.sunk?enemyBoat:null;
  const aim=liveEnemy?selectBroadsideFacingTarget(boat,liveEnemy):null;
  const side=(cmd.side==='port'||cmd.side==='starboard')
    ?(liveEnemy&&cmd.autoSide!==false?aim.side:cmd.side)
    :(aim?.side??gunnery.selectedSide??'starboard');

  switch(cmd.type){
    case 'prepare':
      if(follower)follower.pendingCaptainFire=null;
      if(aim)gunnery.setElevation?.(aimElevationForRange(boat,liveEnemy,aim.distance));
      return gunnery.prepare(side);
    case 'fire':
    case 'fire-loaded':{
      const allowPartial=cmd.type==='fire-loaded'||Boolean(cmd.allowPartial);
      if(aim)gunnery.setElevation?.(aimElevationForRange(boat,liveEnemy,aim.distance));
      if(isFriendlyInLineOfFire(boat,side,allies,aim?.distance??650)){
        if(follower){
          follower.status='Holding fire (friendly in line)';
          follower.pendingCaptainFire={side,allowPartial};
        }
        if(gunnery.selectedSide!==side)gunnery.prepare(side);
        return false;
      }
      const canNow=allowPartial?gunnery.canFireLoaded(side):gunnery.canFire(side);
      if(canNow){
        if(follower)follower.pendingCaptainFire=null;
        return allowPartial?gunnery.fireLoaded(side):gunnery.fire(side);
      }
      gunnery.prepare(side);
      if(follower)follower.pendingCaptainFire={side,allowPartial};
      return true;
    }
    case 'fire-at-will':
      if(follower)follower.pendingCaptainFire=null;
      if(aim)gunnery.setElevation?.(aimElevationForRange(boat,liveEnemy,aim.distance));
      return gunnery.setFireAtWill(Boolean(cmd.enabled),side);
    case 'cease':
      if(follower)follower.pendingCaptainFire=null;
      gunnery.cease();
      return true;
    case 'stand-down':
      if(follower)follower.pendingCaptainFire=null;
      gunnery.standDown();
      return true;
    case 'ammo':
      gunnery.setAmmo?.(cmd.ammo);
      return true;
    case 'elevation':
      gunnery.setElevation?.(cmd.elevation);
      return true;
    case 'traverse':
      gunnery.setTraverse?.(cmd.traverse);
      return true;
    case 'train-target':
      gunnery.trainOnTarget?.(cmd.side);
      return true;
    default:
      return false;
  }
}

export function commandFriendlyFleet(vessels,command,options={}){
  if(!Array.isArray(vessels))return 0;
  const allies=options.allies??vessels.filter(v=>(v?.faction??v?.follower?.faction??'friendly')!=='enemy').map(v=>v.boat??v);
  const enemy=options.target??vessels.find(v=>(v?.faction??v?.follower?.faction)==='enemy'&&!v?.boat?.damage?.sunk)??null;
  let count=0;
  for(let i=0;i<vessels.length;i++){
    const v=vessels[i];
    if(!v||v.id==='player')continue;
    const faction=v.faction??v.follower?.faction??'friendly';
    if(faction!=='friendly')continue;
    if(commandFriendlyVessel(v,command,{...options,target:enemy,allies}))count++;
  }
  return count;
}

export function stepVesselCombatAI(vessel,{vessels=[],dt=0,maxRange=650}={}){
  if(!vessel||!vessel.boat||vessel.boat.damage?.sunk)return null;
  const gunnery=vessel.gunnery;
  if(!gunnery||!gunnery.state?.guns?.length)return null;
  const boat=vessel.boat,follower=vessel.follower;
  const faction=vessel.faction??follower?.faction??'friendly';
  const stepDt=Number.isFinite(dt)?Math.max(0,dt):0;
  if(follower){
    follower.combatTimer=(follower.combatTimer??0)+stepDt;
    if(follower.salvoDelay>0)follower.salvoDelay=Math.max(0,follower.salvoDelay-stepDt);
  }

  if(faction==='enemy'){
    // Find nearest non-sunk opposing vessel (player or friendly).
    let nearestTarget=null,nearestDist=Infinity;
    const enemyAllies=[];
    for(const other of vessels){
      const otherBoat=other?.boat??other;
      if(!otherBoat||otherBoat===boat||otherBoat.damage?.sunk||otherBoat.showProw===false)continue;
      const otherFaction=other?.faction??other?.follower?.faction??'friendly';
      if(otherFaction==='enemy'){
        enemyAllies.push(otherBoat);
        continue;
      }
      const d=Math.hypot((otherBoat.x??0)-(boat.x??0),(otherBoat.z??0)-(boat.z??0));
      if(d<nearestDist){nearestDist=d;nearestTarget=otherBoat;}
    }
    if(!nearestTarget){
      if(gunnery.selectedSide)gunnery.standDown();
      return {action:'stand-down',reason:'no-target'};
    }
    const aim=selectBroadsideFacingTarget(boat,nearestTarget);
    gunnery.setElevation?.(aimElevationForRange(boat,nearestTarget,aim.distance));
    if(gunnery.isSwivelBattery)gunnery.trainOnTarget?.(aim.side);
    const summary=gunnery.summary(aim.side);
    // Automatically prepare or reload the broadside bearing on the target.
    if(!gunnery.ordered&&!gunnery.state.queue.length){
      if(gunnery.selectedSide!==aim.side||(summary.loading===0&&summary.ready<summary.total)){
        gunnery.prepare(aim.side);
      }
    }
    const maxForeRatio=gunnery.isSwivelBattery?0.98:0.58;
    const inArc=aim.distance<=maxRange&&aim.foreRatio<=maxForeRatio;
    const blockedByAlly=isFriendlyInLineOfFire(boat,aim.side,enemyAllies,aim.distance);
    const delayDone=!follower||!(follower.salvoDelay>0);
    if(inArc&&!blockedByAlly&&delayDone&&!gunnery.ordered&&!gunnery.state.queue.length){
      if(gunnery.canFire(aim.side)){
        gunnery.fire(aim.side);
        return {action:'fire',side:aim.side,distance:aim.distance};
      }
      if(gunnery.canFireLoaded(aim.side)&&summary.loading===0&&summary.ready>=Math.max(1,Math.ceil(summary.total*0.5))){
        gunnery.fireLoaded(aim.side);
        return {action:'fire-loaded',side:aim.side,distance:aim.distance};
      }
    }
    return {action:'engage',side:aim.side,distance:aim.distance,inArc,blockedByAlly};
  }

  // Friendly vessel combat & queued captain gunnery orders
  const friendlyAllies=[];
  let nearestEnemy=null,nearestEnemyDist=Infinity;
  for(const other of vessels){
    const otherBoat=other?.boat??other;
    if(!otherBoat||otherBoat===boat||otherBoat.damage?.sunk||otherBoat.showProw===false)continue;
    const otherFaction=other?.faction??other?.follower?.faction??'friendly';
    if(otherFaction==='enemy'){
      const d=Math.hypot((otherBoat.x??0)-(boat.x??0),(otherBoat.z??0)-(boat.z??0));
      if(d<nearestEnemyDist){nearestEnemyDist=d;nearestEnemy=otherBoat;}
    }else{
      friendlyAllies.push(otherBoat);
    }
  }
  if(nearestEnemy){
    const aim=selectBroadsideFacingTarget(boat,nearestEnemy);
    gunnery.setElevation?.(aimElevationForRange(boat,nearestEnemy,aim.distance));
    if(gunnery.isSwivelBattery)gunnery.trainOnTarget?.(aim.side);
    if(gunnery.fireAtWill&&gunnery.selectedSide!==aim.side&&!gunnery.ordered&&!gunnery.state.queue.length){
      gunnery.setFireAtWill(true,aim.side);
    }
  }
  if(follower?.pendingCaptainFire){
    const {side,allowPartial}=follower.pendingCaptainFire;
    if(isFriendlyInLineOfFire(boat,side,friendlyAllies,nearestEnemyDist)){
      follower.status='Holding fire (friendly in line)';
      return {action:'hold-fire',side,reason:'friendly-in-line'};
    }
    const canNow=allowPartial?gunnery.canFireLoaded(side):gunnery.canFire(side);
    if(canNow){
      follower.pendingCaptainFire=null;
      if(allowPartial)gunnery.fireLoaded(side);else gunnery.fire(side);
      return {action:allowPartial?'fire-loaded':'fire',side};
    }
    if(gunnery.selectedSide!==side&&!gunnery.ordered&&!gunnery.state.queue.length){
      gunnery.prepare(side);
    }
  }
  return null;
}

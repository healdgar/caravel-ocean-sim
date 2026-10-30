import { boatHydrodynamics, boatTargets, boatWaveAttitude, boatWaveSlope, stepBoatSurge, stepBoatSteering, boatSpring } from './boat.js';
import { requirePlayableShipModel } from './ship-models.js';
import {getShipParts} from './ship-parts.js';

const AXES=['heave','pitch','roll'];

// Model definitions are shared and immutable; all live state remains on a boat.
// Reject unfinished variants before attaching an identity that their renderer
// and physical model cannot yet satisfy.
export function bindVesselModel(boat,modelId=boat.modelId??'nina'){
  const model=requirePlayableShipModel(modelId);
  boat.modelId=model.id;boat.model=model;
  return boat;
}

// Mutable simulation state never aliases the source ship's rig, crew or probe.
export function copyVessel(source,{id='companion',modelId=source.modelId??'nina',distance=source.length*2.8,side=source.length*1.5}={}){
  const model=requirePlayableShipModel(modelId),sameModel=model.id===(source.modelId??'nina');
  const h=source.heading*Math.PI/180;
  const boat={id,enabled:false,showProw:true,effects:source.effects,crew:source.crew!==false,
    length:sameModel?source.length:model.runtime.length,beam:sameModel?source.beam:model.runtime.beam,
    eye:sameModel?source.eye:(model.nodes['helm.camera']?.position[1]??2.4)*model.designFrame.verticalScale,heading:source.heading,propulsion:'sail',
    sailFore:source.sailFore,sailMain:source.sailMain,sailMizzen:source.sailMizzen,
    provisionDays:sameModel?source.provisionDays:getShipParts(model.id).loading.provisionDays,cargoTonnes:sameModel?source.cargoTonnes:0,speed:source.speed,
    rowingEffort:0,rowingTurn:0,
    x:source.x-Math.sin(h)*distance+Math.cos(h)*side,z:source.z+Math.cos(h)*distance+Math.sin(h)*side,
    rudder:0,rudderTarget:0,yawRate:0,heave:0,pitch:0,roll:0,revision:0,
    target:{heave:0,pitch:0,roll:0},waveSlopeX:0,waveSlopeZ:0,waveSampleTime:-1,waveRevision:-1};
  bindVesselModel(boat,model.id);
  boat.hydrodynamics=boatHydrodynamics(boat.length,boat.beam,boat.provisionDays,boat.cargoTonnes,boat.modelId);
  boat.heave=-boat.hydrodynamics.sinkage;
  return boat;
}

export function createVesselProbeState(){return {time:-1,revision:-1,rate:{heave:0,pitch:0,roll:0}};}

export function acceptVesselProbe(boat,state,heights,time,revision,length,beam){
  if(revision!==boat.revision)return false;
  const next={...boatTargets(heights.subarray(0,9),length,beam),...boatWaveAttitude(heights[10],heights[11],boat.heading)};
  const elapsed=time-state.time,placed=state.time<0,valid=state.revision===revision&&elapsed>0&&elapsed<.25;
  for(const key of AXES){
    const limit=key==='heave'?8:1.2;
    const rate=valid?Math.max(-limit,Math.min(limit,(next[key]-boat.target[key])/elapsed)):0;
    state.rate[key]=valid?state.rate[key]+(rate-state.rate[key])*(1-Math.exp(-elapsed*8)):0;
    if(placed){boat[key]=next[key]-(key==='heave'?boat.hydrodynamics.sinkage:0);boat[key+'Velocity']=0;}
  }
  if(placed)boat.revision++;
  Object.assign(boat.target,next);state.time=time;state.revision=boat.revision;
  boat.waveSlopeX=heights[10];boat.waveSlopeZ=heights[11];boat.waveSampleTime=time;boat.waveRevision=boat.revision;
  return true;
}

export function stepVessel(boat,probe,dt,time,windSpeed,windDirection,steering=0,terrain=null){
  const dmg=boat.damage;
  const extraSink=dmg?Math.max(0,(dmg.floodingSinkage??0)-Math.max(0,boat.hydrodynamics.sinkage)):0;
  if(boat.settledWreck||dmg?.settledWreck){
    boat.settledWreck=true;
    boat.surgeVelocity=0;boat.surgeAcceleration=0;boat.leewayVelocity=0;boat.leewayDistance=0;
    boat.yawRate=0;boat.rollVelocity=0;boat.pitchVelocity=0;boat.heaveVelocity=0;
    boat.waterYawMoment=boat.sailYawMoment=boat.rowingYawMoment=boat.waterYawDamping=0;
    boat.heave=-boat.hydrodynamics.sinkage-extraSink;
    boat.roll=(dmg?.floodingRoll??0)+(boat.groundingRoll??0);
    boat.pitch=(dmg?.floodingPitch??0)+(boat.groundingPitch??0);
    return;
  }
  const previousX=boat.x,previousZ=boat.z,age=Math.max(0,time-probe.time);
  const predicted=boat.waveAttitude??={heave:0,pitch:0,roll:0};
  const fresh=age<.25&&probe.revision===boat.revision;
  const waveDecay=dmg?.sunk?Math.exp(-(dmg.sinkingDepth??0)/5):1;
  for(const key of AXES)predicted[key]=(boat.target[key]+(fresh?probe.rate[key]:0)*Math.min(age,.25))*waveDecay;
  if(dmg){
    predicted.roll+=(dmg.floodingRoll??0);
    predicted.pitch+=(dmg.floodingPitch??0);
  }
  if(boat.groundingRoll)predicted.roll+=boat.groundingRoll;
  if(boat.groundingPitch)predicted.pitch+=boat.groundingPitch;
  const distance=dmg?.restingOnBottom?0:stepBoatSurge(boat,boatWaveSlope(boat,time)*waveDecay,dt,windSpeed,windDirection);
  if(dmg?.restingOnBottom){
    const damp=Math.exp(-Math.max(0,dt)*8);
    boat.surgeVelocity=(boat.surgeVelocity??0)*damp;
    boat.leewayVelocity=(boat.leewayVelocity??0)*damp;
    boat.yawRate=(boat.yawRate??0)*damp;
    boatSpring(boat,'roll',predicted.roll,6,dt,0);
    boatSpring(boat,'pitch',predicted.pitch,6,dt,0);
  }else{
    const previousHeading=boat.heading*Math.PI/180,previousYaw=boat.yawRate;
    stepBoatSteering(boat,steering,dt);
    const heading=previousHeading+(previousYaw+boat.yawRate)*dt*.25;
    boat.x+=Math.sin(heading)*distance+Math.cos(heading)*boat.leewayDistance;
    boat.z-=Math.cos(heading)*distance-Math.sin(heading)*boat.leewayDistance;
    if(terrain)boat.coastBlocked=terrain.constrain(boat,previousX,previousZ);
  }
  boatSpring(boat,'heave',predicted.heave-boat.hydrodynamics.sinkage-extraSink,boat.hydrodynamics.heaveOmega,dt,fresh?(probe.rate.heave*waveDecay):0);
}

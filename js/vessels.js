import { boatHydrodynamics, boatTargets, boatWaveAttitude, boatWaveSlope, stepBoatSurge, stepBoatSteering, boatSpring } from './boat.js';

const AXES=['heave','pitch','roll'];

// Mutable simulation state never aliases the source ship's rig, crew or probe.
export function copyVessel(source,{id='companion',distance=source.length*2.8,side=source.length*1.5}={}){
  const h=source.heading*Math.PI/180;
  const boat={id,enabled:false,showProw:true,effects:source.effects,crew:source.crew!==false,
    length:source.length,beam:source.beam,eye:source.eye,heading:source.heading,propulsion:'sail',
    sailFore:source.sailFore,sailMain:source.sailMain,sailMizzen:source.sailMizzen,
    provisionDays:source.provisionDays,cargoTonnes:source.cargoTonnes,speed:source.speed,
    x:source.x-Math.sin(h)*distance+Math.cos(h)*side,z:source.z+Math.cos(h)*distance+Math.sin(h)*side,
    rudder:0,rudderTarget:0,yawRate:0,heave:0,pitch:0,roll:0,revision:0,
    target:{heave:0,pitch:0,roll:0},waveSlopeX:0,waveSlopeZ:0,waveSampleTime:-1,waveRevision:-1};
  boat.hydrodynamics=boatHydrodynamics(boat.length,boat.beam,boat.provisionDays,boat.cargoTonnes);
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
  const previousX=boat.x,previousZ=boat.z,age=Math.max(0,time-probe.time);
  const predicted=boat.waveAttitude??={heave:0,pitch:0,roll:0};
  const fresh=age<.25&&probe.revision===boat.revision;
  for(const key of AXES)predicted[key]=boat.target[key]+(fresh?probe.rate[key]:0)*Math.min(age,.25);
  const distance=stepBoatSurge(boat,boatWaveSlope(boat,time),dt,windSpeed,windDirection);
  const previousHeading=boat.heading*Math.PI/180,previousYaw=boat.yawRate;
  stepBoatSteering(boat,steering,dt);
  const heading=previousHeading+(previousYaw+boat.yawRate)*dt*.25;
  boat.x+=Math.sin(heading)*distance+Math.cos(heading)*boat.leewayDistance;
  boat.z-=Math.cos(heading)*distance-Math.sin(heading)*boat.leewayDistance;
  if(terrain)boat.coastBlocked=terrain.constrain(boat,previousX,previousZ);
  boatSpring(boat,'heave',predicted.heave-boat.hydrodynamics.sinkage,boat.hydrodynamics.heaveOmega,dt,fresh?probe.rate.heave:0);
}

// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Authored human deck pace, independent of rowing, climbing and work clocks.
export const CREW_WALK_CYCLE_METRES=1.30;
export const CREW_WALK_CLIP_SECONDS=4/3;
const crewMotionFinite=(value,fallback=0)=>Number.isFinite(value)?value:fallback;

export function crewDeckHazard(boat,wind=0,braced=false){
  // Preserve the existing enter/release thresholds; one policy prevents new
  // models flickering between patrol and brace at the same sea-state boundary.
  return Math.abs(boat.roll??0)>(braced?.26:.36)||Math.abs(boat.rollVelocity??0)>(braced?.3:.5)||wind>(braced?19:23);
}

export function crewMotionPolicy(boat,{purpose='patrol',grade=0,constrained=false,hazard=false}={}){
  if(!['patrol','work'].includes(purpose)||!Number.isFinite(grade))throw Error('Invalid crew deck-motion request');
  const roll=Math.abs(crewMotionFinite(boat.roll)),rate=Math.abs(crewMotionFinite(boat.rollVelocity)),pitch=Math.abs(crewMotionFinite(boat.pitch));
  // Level weather decks admit a purposeful walk. Physical rise/run, sustained
  // heel and angular motion slow it continuously before existing brace stops.
  const balance=1/(1+2.5*roll+.9*rate+.75*pitch),slope=1/(1+1.8*Math.abs(grade)),space=constrained?.72:1;
  return{
    speedMetresPerSecond:hazard?0:(purpose==='work'?1.75:1.25)*balance*slope*space,
    turnRadiansPerSecond:hazard?0:3.2*Math.sqrt(balance)*(constrained?.8:1),
    strideMetres:CREW_WALK_CYCLE_METRES,
  };
}

export function crewTurnTowards(yaw,desired,dt,rate){
  if(![yaw,desired,dt,rate].every(Number.isFinite)||dt<0||rate<0)throw Error('Invalid crew turn');
  const angle=Math.atan2(Math.sin(desired-yaw),Math.cos(desired-yaw)),step=rate*dt;
  return yaw+Math.max(-step,Math.min(step,angle));
}

export function crewAdvanceWalk(s,distanceMetres,{strideMetres=CREW_WALK_CYCLE_METRES,clipDuration=s.walkClipDuration??CREW_WALK_CLIP_SECONDS}={}){
  if(!Number.isFinite(distanceMetres)||distanceMetres<0||!(Number.isFinite(strideMetres)&&strideMetres>0)||!(Number.isFinite(clipDuration)&&clipDuration>0))throw Error('Invalid crew gait distance');
  // Both stock Walk clips last 4/3 s and have about .67 m fore/aft foot swing.
  // A 1.30 m full-cycle travel is an authored fit, not an exact no-slip solver.
  // Use loaded clip duration where available. Blocked/turning/waiting actors do
  // not cycle their legs; idle, work and water/rowing clocks keep their own dt.
  s.walkDistance=(s.walkDistance??0)+distanceMetres;
  s.walkTime=(s.walkTime??0)+distanceMetres/strideMetres*clipDuration;
  return s.walkTime;
}

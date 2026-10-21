import { HULL_DRAFT, HULL_VERTICAL_SCALE, vesselDeck, vesselDraft } from './hull.js';
import { SQUARE_RIG_MASTS } from './rigging.js';
import { SAIL_PLAN, createLateenPoses, advanceLateenRig } from './lateen.js';
import { createSailGeometry, createVictorySailGeometry, updateSailGeometry, sailPanelForce } from './sail-aerodynamics.js';
export { SAIL_PLAN, runningRiggingLines } from './lateen.js';

// Authored caravel sail plan and aerodynamic response; not a calibrated polar.
// World wind is a velocity toward (cos(direction), sin(direction)) in X/Z.
// Active caravela latina; retain the converted square rig as a separate model plan.
function squareRigPoint(mast,y){
  const m=SQUARE_RIG_MASTS[mast],base=vesselDeck(m.z);
  return [0,y,m.z+m.rake*(y-base)/(m.height-base)];
}
export const SQUARE_RIG_PLAN = [
  {id:1,mast:0,kind:'square',z:squareRigPoint(0,6.4)[2]-.16,top:6.4,width:4.6,height:3.8,belly:.65},
  {id:2,mast:1,kind:'square',z:squareRigPoint(1,8)[2]-.20,top:8,width:6.3,height:5.4,belly:.9},
  {id:3,mast:2,kind:'lateen',corners:[[0,6.7,5.5],[0,2.5,1.35],[.7,3.7,6.2]],pivot:squareRigPoint(2,4.3),belly:.8},
];
export const SAIL_KEYS = ['sailFore', 'sailMain', 'sailMizzen'];
export const SAIL_AREAS = SAIL_PLAN.map(s=>{
  if(s.kind==='square')return s.width*s.height*.95;
  const a=s.corners[1].map((x,i)=>x-s.corners[0][i]),b=s.corners[2].map((x,i)=>x-s.corners[0][i]);
  return .5*Math.hypot(a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]);
});
// Neutral marine surface-layer profile, referenced to the weather control at 10 m.
// Fixed roughness is an approximation; atmospheric stability and directional shear are omitted.
const WIND_ROUGHNESS = 0.0002;
export function windAtHeight(speed, height) {
  return speed * Math.log(Math.max(height, WIND_ROUGHNESS) / WIND_ROUGHNESS) / Math.log(10 / WIND_ROUGHNESS);
}
const sailClamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const sailSmooth = (lo, hi, x) => { const t = sailClamp((x - lo) / (hi - lo), 0, 1); return t * t * (3 - 2 * t); };

export function sailingState(boat) {
  if (!boat.sailState) boat.sailState = {
    set: new Float64Array(SAIL_KEYS.map(key => sailClamp(boat[key] ?? 1, 0, 1))),
    squareYaw: 0, lateenYaw: 0, tack: 1, canvasTack: 1, forward: 0, side: 0, area: 0,
    apparentSpeed: 0, apparentAngle: 0, squareFill: 0, lateenFill: 0,
    squareTarget: 0, lateenTarget: 0, windSide: 0, windForward: 0, rollMoment: 0,
    pitchMoment:0, yawMoment:0, heaveForce:0, panelSide:new Float64Array(3), panelMoment:new Float64Array(3),
  };
  boat.sailState.rig??=createLateenPoses(boat.sailState.set);
  boat.sailState.geometry??=boat.modelId==='victory'?createVictorySailGeometry():createSailGeometry();
  return boat.sailState;
}

export function apparentWind(out, heading, speed, sideways, windSpeed, windDirection) {
  const h = (heading ?? 0) * Math.PI / 180, wx = Math.cos(windDirection) * windSpeed, wz = Math.sin(windDirection) * windSpeed;
  out.windForward = wx * Math.sin(h) - wz * Math.cos(h) - speed;
  out.windSide = wx * Math.cos(h) + wz * Math.sin(h) - sideways;
  out.apparentSpeed = Math.hypot(out.windForward, out.windSide);
  out.apparentAngle = out.apparentSpeed > 1e-6 ? Math.atan2(-out.windSide, -out.windForward) : 0;
  // Retain the last tack near a dead run or calm to avoid chattering across the stern.
  if (Math.abs(out.windSide) > 0.12) out.tack = out.windSide < 0 ? 1 : -1;
  const angle = Math.abs(out.apparentAngle), degrees = angle * 180 / Math.PI;
  out.squareTarget = out.tack * sailClamp((Math.PI / 2 - angle + 0.23) * (1 - sailSmooth(110, 165, degrees)), -Math.PI / 3, Math.PI / 3);
  out.lateenTarget = -out.tack * sailClamp(angle * 0.5 - 0.12, 0.08, 1.2);
  return out;
}

export function advanceSails(boat, dt, windSpeed, windDirection) {
  const s = sailingState(boat);
  apparentWind(s, boat.heading, boat.surgeVelocity ?? 0, boat.leewayVelocity ?? 0, windSpeed, windDirection);
  // This reconstruction's yard/shroud envelope permits 23 degrees of brace.
  // Forces use that physical stop too; do not draw one trim and simulate another.
  if(boat.modelId==='victory')s.squareTarget=sailClamp(s.squareTarget,-.4,.4);
  for (let i = 0; i < 3; i++) s.set[i] += sailClamp(sailClamp(boat[SAIL_KEYS[i]] ?? 1, 0, 1) - s.set[i], -dt * 0.18 * (boat.crewSailRate?.[i]??1), dt * 0.18 * (boat.crewSailRate?.[i]??1));
  // Yards and lateen take time to brace/tack; forces use this actual trim.
  s.squareYaw += sailClamp(s.squareTarget - s.squareYaw, -dt * 0.55, dt * 0.55);
  s.lateenYaw += sailClamp(s.lateenTarget - s.lateenYaw, -dt * 0.65, dt * 0.65);
  if(boat.modelId==='victory'){
    for(let i=0;i<3;i++){s.rig[i].deployed=s.set[i];s.rig[i].side=-s.tack;}
    s.canvasTack=s.tack;
  }else advanceLateenRig(s,boat,dt);
  // Pressure loads fill the canvas with a short response time. This state only
  // advances with time; querying forces never changes the geometry underneath it.
  for(const p of s.rig)p.fill+=((p.targetFill??0)-p.fill)*(1-Math.exp(-dt*4));
}

export function sailForces(boat, windSpeed, windDirection, velocity, sideways = 0,
  roll = boat.roll ?? 0, rollRate = boat.rollVelocity ?? 0) {
  const s = sailingState(boat);
  apparentWind(s, boat.heading, velocity, sideways, windSpeed, windDirection);
  s.forward=0;s.side=0;s.area=0;s.rollMoment=0;s.pitchMoment=0;s.yawMoment=0;s.heaveForce=0;s.squareFill=0;s.lateenFill=0;
  s.panelSide.fill(0);s.panelMoment.fill(0);
  const geometry=s.geometry,panels=updateSailGeometry(geometry,boat,s.rig),force=geometry.force;
  const pitch=boat.pitch??0,pitchRate=boat.pitchVelocity??0,yawRate=boat.yawRate??0,heaveRate=boat.heaveVelocity??0;
  const cr=Math.cos(roll),sr=Math.sin(roll),cp=Math.cos(pitch),sp=Math.sin(pitch);
  const datum=vesselDraft(boat),cg=(boat.hydrodynamics?.centreOfGravity??datum)-datum;
  const relativeDirection=windDirection-(boat.heading??0)*Math.PI/180;
  const windX=Math.cos(relativeDirection),windZ=Math.sin(relativeDirection);
  // Heading is rotation about -worldY. In the heading-aligned load frame,
  // omega includes yaw and the pitch-rotated roll axis. Relative airflow must
  // subtract all rigid motion, including heave; otherwise rising/turning sails
  // see the air as if those components of their motion did not exist.
  const ox=pitchRate,oy=-yawRate-rollRate*sp,oz=rollRate*cp;
  for(let m=0;m<3;m++){
    let fill=0,area=0;
    const group=geometry.victory?geometry.groups[m]:panels,start=geometry.victory?0:m*geometry.indices.length,count=geometry.victory?group.length:geometry.indices.length;
    for(let j=0;j<count;j++){
      const panel=group[start+j];
      const [x,y,z]=panel.point,[nx,ny,nz]=panel.normal;
      const rx=cr*x-sr*(y-cg),ry=cp*(sr*x+cr*(y-cg))-sp*z,rz=sp*(sr*x+cr*(y-cg))+cp*z;
      const normalX=cr*nx-sr*ny,normalY=cp*(sr*nx+cr*ny)-sp*nz,normalZ=sp*(sr*nx+cr*ny)+cp*nz;
      const height=cp*(sr*x+cr*y)-sp*z-(boat.hydrodynamics?.sinkage??0);
      const localWind=windAtHeight(windSpeed,height);
      const wx=windX*localWind-sideways-(oy*rz-oz*ry);
      const wy=-heaveRate-(oz*rx-ox*rz),wz=windZ*localWind+velocity-(ox*ry-oy*rx);
      fill+=sailPanelForce(force,geometry.coefficients,normalX,normalY,normalZ,wx,wy,wz,panel.area,panel.aspect)*panel.area;
      const [fx,fy,fz]=force;
      const mx=ry*fz-rz*fy,my=rz*fx-rx*fz,mz=rx*fy-ry*fx;
      const rollMoment=-sp*my+cp*mz;
      s.forward-=fz;s.side+=fx;s.heaveForce+=fy;s.rollMoment+=rollMoment;s.pitchMoment+=mx;s.yawMoment-=my;
      s.panelSide[m]+=fx;s.panelMoment[m]+=rollMoment;area+=panel.area;
    }
    s.rig[m].targetFill=area>0?fill/area:0;
    s.lateenFill+=s.rig[m].fill*area;s.area+=area;
  }
  s.lateenFill=s.area>0?s.lateenFill/s.area:0;
  if(geometry.victory)s.squareFill=s.lateenFill;
  return s;
}

export function pointOfSail(angle, speed) {
  if (speed < 0.5) return 'Calm';
  const a = Math.abs(angle) * 180 / Math.PI;
  return a < 42 ? 'In irons' : a < 60 ? 'Close-hauled · weak drive' : a < 80 ? 'Close reach'
    : a < 110 ? 'Beam reach' : a < 165 ? 'Broad reach' : 'Running';
}

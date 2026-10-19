import { HULL_DRAFT, HULL_VERTICAL_SCALE, vesselDeck } from './hull.js';
import { SQUARE_RIG_MASTS } from './rigging.js';
import { SAIL_PLAN, createLateenPoses, advanceLateenRig, lateenSheetTarget, lateenClothPoint } from './lateen.js';
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
const SAIL_LOADS = SAIL_PLAN.map((s,i)=>{
  if(s.kind==='square')return {mast:s.mast,kind:s.kind,area:SAIL_AREAS[i],top:s.top,drop:s.height*.5};
  const centre=s.corners[0].map((_,axis)=>s.corners.reduce((sum,p)=>sum+p[axis],0)/3);
  // Match the cloth's column gathering onto the yard (u = 1/3 at its centroid).
  const top=s.corners[0][1]+(s.corners[1][1]-s.corners[0][1])/3;
  return {mast:s.mast,kind:s.kind,area:SAIL_AREAS[i],top,drop:top-centre[1]};
});
const sailClamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const sailSmooth = (lo, hi, x) => { const t = sailClamp((x - lo) / (hi - lo), 0, 1); return t * t * (3 - 2 * t); };

export function sailingState(boat) {
  if (!boat.sailState) boat.sailState = {
    set: new Float64Array(SAIL_KEYS.map(key => sailClamp(boat[key] ?? 1, 0, 1))),
    squareYaw: 0, lateenYaw: 0, tack: 1, canvasTack: 1, forward: 0, side: 0, area: 0,
    apparentSpeed: 0, apparentAngle: 0, squareFill: 0, lateenFill: 0,
    squareTarget: 0, lateenTarget: 0, windSide: 0, windForward: 0, rollMoment: 0,
    loadWind: {tack:1}, panelSide:new Float64Array(SAIL_LOADS.length), panelMoment:new Float64Array(SAIL_LOADS.length),
  };
  boat.sailState.rig??=createLateenPoses(boat.sailState.set);
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
  for (let i = 0; i < 3; i++) s.set[i] += sailClamp(sailClamp(boat[SAIL_KEYS[i]] ?? 1, 0, 1) - s.set[i], -dt * 0.18 * (boat.crewSailRate?.[i]??1), dt * 0.18 * (boat.crewSailRate?.[i]??1));
  // Yards and lateen take time to brace/tack; forces use this actual trim.
  s.squareYaw += sailClamp(s.squareTarget - s.squareYaw, -dt * 0.55, dt * 0.55);
  s.lateenYaw += sailClamp(s.lateenTarget - s.lateenYaw, -dt * 0.65, dt * 0.65);
  advanceLateenRig(s,boat,dt);
}

export function sailForces(boat, windSpeed, windDirection, velocity, sideways = 0,
  roll = boat.roll ?? 0, rollRate = boat.rollVelocity ?? 0) {
  const s = sailingState(boat);
  apparentWind(s, boat.heading, velocity, sideways, windSpeed, windDirection);
  s.forward=0;s.side=0;s.area=0;s.rollMoment=0;s.squareFill=0;s.lateenFill=0;
  const upright=Math.max(0,Math.cos(roll));
  let squareArea=0,lateenArea=0;
  for(let i=0;i<SAIL_LOADS.length;i++){
    const panel=SAIL_LOADS[i],lateen=panel.kind==='lateen',deployed=lateen?s.rig[panel.mast].deployed:s.set[panel.mast];
    // Furling gathers canvas toward its yard, moving the remaining centre of effort upward.
    const centreHeight=lateen?lateenClothPoint(panel.mast,1/3,1/3,s.rig[panel.mast],0,0)[1]:panel.top-panel.drop*(.025+.975*deployed);
    const height=centreHeight*HULL_VERTICAL_SCALE-(boat.hydrodynamics?.sinkage??0);
    const lever=Math.max(.1,height+(boat.hydrodynamics?.draft??HULL_DRAFT*HULL_VERTICAL_SCALE)
      -(boat.hydrodynamics?.centreOfGravity??HULL_DRAFT*HULL_VERTICAL_SCALE))*upright;
    const wind=s.loadWind;wind.tack=s.tack;
    // Roll moves the centre of effort sideways; subtract that velocity from the local wind.
    apparentWind(wind,boat.heading,velocity,sideways-rollRate*lever,windAtHeight(windSpeed,height*upright),windDirection);
    const speed=wind.apparentSpeed,angle=Math.abs(wind.apparentAngle),degrees=angle*180/Math.PI;
    const trim=lateen?Math.max(0,-s.rig[i].side*wind.tack)*Math.max(0,Math.cos(2*(s.rig[i].opening-lateenSheetTarget(wind.lateenTarget,i))))
      :Math.max(0,Math.cos(2*(s.squareYaw-wind.squareTarget)));
    const power=sailSmooth(lateen?42:55,lateen?60:75,degrees)*trim*trim;
    const area=panel.area*deployed*(lateen?boat.length/12:boat.beam/3.6)*HULL_VERTICAL_SCALE;
    const fill=sailSmooth(.5,5,speed)*power;
    if(lateen)s.rig[i].fill=fill;
    s.area+=area;
    if(lateen){s.lateenFill+=fill*area;lateenArea+=area;}else{s.squareFill+=fill*area;squareArea+=area;}
    // Projected area and the horizontal lever both shorten as the vessel heels.
    const q=.5*1.225*speed*speed*area*power*upright;
    const drag=.10+1.2*Math.sin(Math.max(0,angle-Math.PI/2))**2;
    const f=speed>1e-6?wind.windForward/speed:0,r=speed>1e-6?wind.windSide/speed:0;
    let lift=1.1*Math.sin(angle)*(1-sailSmooth(90,125,degrees));
    if(f>0)lift=Math.min(lift,.85*drag*Math.abs(r)/f);
    const side=q*(lift*-f*Math.sign(r)+drag*r);
    s.forward+=q*(lift*Math.abs(r)+drag*f);s.side+=side;
    s.panelSide[i]=side;s.panelMoment[i]=-side*lever;s.rollMoment+=s.panelMoment[i];
  }
  s.squareFill=squareArea>0?s.squareFill/squareArea:0;
  s.lateenFill=lateenArea>0?s.lateenFill/lateenArea:0;
  return s;
}

export function pointOfSail(angle, speed) {
  if (speed < 0.5) return 'Calm';
  const a = Math.abs(angle) * 180 / Math.PI;
  return a < 42 ? 'In irons' : a < 60 ? 'Close-hauled · weak drive' : a < 80 ? 'Close reach'
    : a < 110 ? 'Beam reach' : a < 165 ? 'Broad reach' : 'Running';
}

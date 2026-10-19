import { HULL_DRAFT, HULL_VERTICAL_SCALE } from './hull.js';

// Authored caravel sail plan and aerodynamic response; not a calibrated polar.
// World wind is a velocity toward (cos(direction), sin(direction)) in X/Z.
export const SAIL_PLAN = [
  { id: 1, mast: 0, z: -4.15, top: 6.65, width: 4.9, height: 2.9, belly: 0.7 },
  { id: 2, mast: 0, z: -4.15, top: 8.85, width: 3.25, height: 1.5, belly: 0.42 },
  { id: 3, mast: 1, z: 0.85, top: 8.0, width: 5.9, height: 3.25, belly: 0.88 },
  { id: 4, mast: 1, z: 0.85, top: 10.9, width: 3.95, height: 1.65, belly: 0.52 },
];
export const LATEEN_CORNERS = [[0, 8.05, 5.9], [0, 4.5, 2.6], [1.1, 4.15, 6.3]];
export const SAIL_KEYS = ['sailFore', 'sailMain', 'sailMizzen'];
const squareAreas = [0, 0];
for (const sail of SAIL_PLAN) squareAreas[sail.mast] += sail.width * sail.height * 0.95;
export const SAIL_AREAS = [...squareAreas, 7.63];
// Neutral marine surface-layer profile, referenced to the weather control at 10 m.
// Fixed roughness is an approximation; atmospheric stability and directional shear are omitted.
const WIND_ROUGHNESS = 0.0002;
export function windAtHeight(speed, height) {
  return speed * Math.log(Math.max(height, WIND_ROUGHNESS) / WIND_ROUGHNESS) / Math.log(10 / WIND_ROUGHNESS);
}
const lateenCenter=LATEEN_CORNERS[0].map((_,axis)=>LATEEN_CORNERS.reduce((sum,p)=>sum+p[axis],0)/3);
const lateenYard=LATEEN_CORNERS[1].map((x,axis)=>x-LATEEN_CORNERS[0][axis]);
const lateenProjection=lateenYard.reduce((sum,x,axis)=>sum+x*(lateenCenter[axis]-LATEEN_CORNERS[0][axis]),0)/lateenYard.reduce((sum,x)=>sum+x*x,0);
const lateenFurledHeight=LATEEN_CORNERS[0][1]+lateenProjection*lateenYard[1];
const SAIL_LOADS = [
  ...SAIL_PLAN.map(sail => ({ mast:sail.mast, area:sail.width*sail.height*.95, top:sail.top, drop:sail.height*.5 })),
  { mast:2, area:SAIL_AREAS[2], top:lateenFurledHeight, drop:lateenFurledHeight-lateenCenter[1] },
];
const sailClamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
const sailSmooth = (lo, hi, x) => { const t = sailClamp((x - lo) / (hi - lo), 0, 1); return t * t * (3 - 2 * t); };

export function sailingState(boat) {
  if (!boat.sailState) boat.sailState = {
    set: new Float64Array(SAIL_KEYS.map(key => sailClamp(boat[key] ?? 1, 0, 1))),
    squareYaw: 0, lateenYaw: 0, tack: 1, canvasTack: 1, forward: 0, side: 0, area: 0,
    apparentSpeed: 0, apparentAngle: 0, squareFill: 0, lateenFill: 0,
    squareTarget: 0, lateenTarget: 0, windSide: 0, windForward: 0, rollMoment: 0,
    loadWind: {tack:1}, panelSide:new Float64Array(5), panelMoment:new Float64Array(5),
  };
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
  s.canvasTack += sailClamp(s.tack - s.canvasTack, -dt * 1.2, dt * 1.2);
}

export function sailForces(boat, windSpeed, windDirection, velocity, sideways = 0,
  roll = boat.roll ?? boat.sailHeel ?? 0, rollRate = boat.rollVelocity ?? boat.sailHeelVelocity ?? 0) {
  const s = sailingState(boat);
  apparentWind(s, boat.heading, velocity, sideways, windSpeed, windDirection);
  s.forward=0;s.side=0;s.area=0;s.rollMoment=0;s.squareFill=0;s.lateenFill=0;
  const upright=Math.max(0,Math.cos(roll));
  let squareArea=0;
  for(let i=0;i<SAIL_LOADS.length;i++){
    const panel=SAIL_LOADS[i],lateen=panel.mast===2,deployed=s.set[panel.mast];
    // Furling gathers canvas toward its yard, moving the remaining centre of effort upward.
    const height=(panel.top-panel.drop*(.025+.975*deployed))*HULL_VERTICAL_SCALE;
    const lever=(height+HULL_DRAFT*HULL_VERTICAL_SCALE*.5)*upright;
    const wind=s.loadWind;wind.tack=s.tack;
    // Roll moves the centre of effort sideways; subtract that velocity from the local wind.
    apparentWind(wind,boat.heading,velocity,sideways-rollRate*lever,windAtHeight(windSpeed,height*upright),windDirection);
    const speed=wind.apparentSpeed,angle=Math.abs(wind.apparentAngle),degrees=angle*180/Math.PI;
    const trim=Math.max(0,Math.cos(2*((lateen?s.lateenYaw:s.squareYaw)-(lateen?wind.lateenTarget:wind.squareTarget))));
    const power=sailSmooth(lateen?42:55,lateen?60:75,degrees)*trim*trim;
    const area=panel.area*deployed*(lateen?boat.length/12:boat.beam/3.6)*HULL_VERTICAL_SCALE;
    const fill=sailSmooth(.5,5,speed)*power;
    s.area+=area;
    if(lateen)s.lateenFill=fill;else{s.squareFill+=fill*area;squareArea+=area;}
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
  return s;
}

export function pointOfSail(angle, speed) {
  if (speed < 0.5) return 'Calm';
  const a = Math.abs(angle) * 180 / Math.PI;
  return a < 42 ? 'In irons' : a < 60 ? 'Close-hauled · weak drive' : a < 80 ? 'Close reach'
    : a < 110 ? 'Beam reach' : a < 165 ? 'Broad reach' : 'Running';
}

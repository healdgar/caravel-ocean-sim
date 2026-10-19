import { HELM_EYE_Z, HULL_DRAFT, HULL_VERTICAL_SCALE, hullDeck, hullHalfWidth, hullScale } from './hull.js';
import { advanceSails, sailForces } from './sailing.js';

export const KNOT_TO_MPS = 0.514444;
export const DEFAULT_PROVISION_DAYS = 60;
export const SEAWATER_DENSITY = 1025;
// Authored departure manifest for the twelve-person company. The existing
// design waterline calibrates vessel + permanent ballast mass, not empty wood.
// Quantities are gameplay assumptions, not a recovered historical inventory.
export const BOAT_MANIFEST = Object.freeze({crew:12,personKg:80,waterKgPerDay:5,foodKgPerDay:1.5,casksKg:800,sparesKg:1500});
// Integrate the canonical hull once. At runtime loading only interpolates this
// table; it never adds ocean samples, meshes or GPU work. y is in design units.
const HYDRO_STEP = .005;
const HYDRO_DECK = hullDeck(0);
const HULL_HYDRO = (()=>{
  const rows=[];let volume=0,moment=0,previousArea=0,previousMoment=0;
  for(let j=0;j<=Math.round((HULL_DRAFT+HYDRO_DECK)/HYDRO_STEP);j++){
    const y=-HULL_DRAFT+j*HYDRO_STEP;let area=0,waterplaneMoment=0;
    for(let i=0;i<192;i++){
      const width=hullHalfWidth(-6.4+(i+.5)*12/192,y);
      area+=2*width*12/192;waterplaneMoment+=2/3*width**3*12/192;
    }
    if(j){volume+=(previousArea+area)*.5*HYDRO_STEP;moment+=(previousMoment+area*y)*.5*HYDRO_STEP;}
    rows.push({volume,moment,area,waterplaneMoment});previousArea=area;previousMoment=area*y;
  }
  return rows;
})();
export function hullHydrostatics(length,beam,waterline=0){
  const [sx,sy,sz]=hullScale(length,beam),at=Math.max(0,Math.min(HULL_HYDRO.length-1,(waterline/sy+HULL_DRAFT)/HYDRO_STEP));
  const i=Math.min(HULL_HYDRO.length-2,Math.floor(at)),t=at-i,a=HULL_HYDRO[i],b=HULL_HYDRO[i+1];
  const mix=key=>a[key]+(b[key]-a[key])*t,volume=mix('volume')*sx*sy*sz;
  return {volume,mass:volume*SEAWATER_DENSITY,waterplaneArea:mix('area')*sx*sz,
    centreOfBuoyancy:volume>0?HULL_DRAFT*sy+mix('moment')*sx*sy*sy*sz/volume:0,
    waterplaneMoment:mix('waterplaneMoment')*sx**3*sz};
}
const provisionSetting=value=>Number.isFinite(value)?Math.max(0,Math.min(120,value)):DEFAULT_PROVISION_DAYS;
const cargoSetting=value=>Number.isFinite(value)?Math.max(0,Math.min(40,value)):0;

export function boatHydrodynamics(length, beam, provisionDays=DEFAULT_PROVISION_DAYS, cargoTonnes=0) {
  provisionDays=provisionSetting(provisionDays);cargoTonnes=cargoSetting(cargoTonnes);
  const base=hullHydrostatics(length,beam),sy=HULL_VERTICAL_SCALE,M=BOAT_MANIFEST;
  const crewMass=M.crew*M.personKg,waterMass=M.crew*M.waterKgPerDay*provisionDays;
  const foodMass=M.crew*M.foodKgPerDay*provisionDays,storesMass=M.casksKg+M.sparesKg,cargoMass=cargoTonnes*1000;
  const loadMass=crewMass+waterMass+foodMass+storesMass+cargoMass,mass=base.mass+loadMass;
  // Preserve at least 15 cm to the lowest deck. Unsupported configurations are
  // explicitly reported as overloaded; this remains a non-flooding model.
  let low=0,high=HYDRO_DECK*sy-.15;
  const maximumMass=hullHydrostatics(length,beam,high).mass;
  for(let i=0;i<28;i++){
    const mid=(low+high)*.5;
    if(hullHydrostatics(length,beam,mid).mass<mass)low=mid;else high=mid;
  }
  const sinkage=(low+high)*.5,loaded=hullHydrostatics(length,beam,sinkage);
  const {volume,waterplaneArea}=loaded,draft=HULL_DRAFT*sy+sinkage,freeboard=HYDRO_DECK*sy-sinkage;
  // Authored effective coefficients, not a calibrated resistance curve.
  const wettedArea = 0.85 * length * (beam + 2 * draft);
  // Calibrate fixed vessel KG to the previous stability estimate, then add crew
  // on deck and secured stores/cargo low amidships. No free-surface tank slosh.
  const fixedKG=base.centreOfBuoyancy+base.waterplaneMoment/base.volume-beam*.22;
  const crewKG=HULL_DRAFT*sy+1.5*sy,storesKG=HULL_DRAFT*sy-.45*sy;
  const centreOfGravity=(base.mass*fixedKG+crewMass*crewKG+(loadMass-crewMass)*storesKG)/mass;
  const metacentricHeight=Math.max(.1,loaded.centreOfBuoyancy+loaded.waterplaneMoment/volume-centreOfGravity);
  const rollInertia=1.2*(base.mass*((beam*.38)**2+(1.6*sy)**2+(fixedKG-centreOfGravity)**2)
    +crewMass*((beam*.3)**2+(crewKG-centreOfGravity)**2)
    +(loadMass-crewMass)*((beam*.18)**2+(storesKG-centreOfGravity)**2));
  const rollStiffness=mass*9.81*metacentricHeight;
  const rollDamping=2*.35*Math.sqrt(rollInertia*rollStiffness);
  const addedMass=mass*.08,heaveOmega=Math.sqrt(SEAWATER_DENSITY*9.81*waterplaneArea/(mass+addedMass));
  return { length,beam,provisionDays,cargoTonnes,draft,sinkage,freeboard,volume,mass,addedMass,
    fixedMass:base.mass,loadMass,crewMass,waterMass,foodMass,storesMass,cargoMass,overloadKg:Math.max(0,mass-maximumMass),
    waterplaneArea,centreOfGravity,heaveOmega,drag:0.5*SEAWATER_DENSITY*0.012*wettedArea,
    metacentricHeight,rollInertia,rollStiffness,rollDamping };
}

// Wind-induced roll about the wave-supported attitude. I*angle'' = Mwind - Mg*GM*sin(angle) - damping*angle'.
// Keeping this response separate preserves the established short-wave buoyancy filter.
export function stepBoatHeel(boat, moment, dt) {
  boat.sailHeel ??= 0;boat.sailHeelVelocity ??= 0;
  if(!(dt>0)||!Number.isFinite(dt))return;
  const hydro=boat.hydrodynamics;
  const steps=Math.ceil(dt*120),h=dt/steps;
  for(let i=0;i<steps;i++){
    const free=boat.sailHeelVelocity+(moment-hydro.rollStiffness*Math.sin(boat.sailHeel))/hydro.rollInertia*h;
    boat.sailHeelVelocity=free/(1+hydro.rollDamping/hydro.rollInertia*h);
    boat.sailHeel+=boat.sailHeelVelocity*h;
    // This simulator has no capsize solver; bound extreme out-of-model configurations.
    const limit=Math.PI/3;
    if(Math.abs(boat.sailHeel)>limit){
      boat.sailHeel=Math.sign(boat.sailHeel)*limit;
      if(boat.sailHeel*boat.sailHeelVelocity>0)boat.sailHeelVelocity=0;
    }
  }
}

export function stepBoatRoll(boat, target, omega, dt, targetVelocity=0) {
  boat.waveRoll ??= (boat.roll ?? 0)-(boat.sailHeel ?? 0);
  boat.waveRollVelocity ??= (boat.rollVelocity ?? 0)-(boat.sailHeelVelocity ?? 0);
  boatSpring(boat,'waveRoll',target,omega,dt,targetVelocity);
  boat.roll=boat.waveRoll+(boat.sailHeel ?? 0);
  boat.rollVelocity=boat.waveRollVelocity+(boat.sailHeelVelocity ?? 0);
}

export function boatForwardSpeed(boat) {
  return boat.surgeVelocity ?? (boat.propulsion === 'sail' ? 0 : boat.speed * KNOT_TO_MPS);
}

// World-space, incident-wave slopes arrive in the existing asynchronous probe.
// Never hold an old force indefinitely after a stalled readback or a scene edit.
export function boatWaveSlope(boat, time) {
  const age = time - boat.waveSampleTime;
  if (boat.waveRevision !== boat.revision || !(age >= 0)) return 0;
  const freshness = Math.exp(-Math.max(0, age - 0.25) / 0.25);
  const heading = boat.heading * Math.PI / 180;
  return (boat.waveSlopeX * Math.sin(heading) - boat.waveSlopeZ * Math.cos(heading)) * freshness;
}

// Long-wave Froude–Krylov approximation: F = -rho*g*volume*mean(wave slope).
// Sailing uses apparent-wind forces; manual mode retains the calm-water thrust.
// Both integrate through vessel inertia, resistance and incident-wave pressure.
export function stepBoatSurge(boat, slope, dt, windSpeed = 0, windDirection = 0) {
  boat.leewayDistance = 0;
  boat.leewayVelocity ??= 0;
  boat.sailHeel ??= 0;
  boat.sailHeelVelocity ??= 0;
  if (!(dt > 0) || !Number.isFinite(dt)) return 0;
  let hydro = boat.hydrodynamics;
  if (!hydro || hydro.length !== boat.length || hydro.beam !== boat.beam
      || hydro.provisionDays!==provisionSetting(boat.provisionDays) || hydro.cargoTonnes!==cargoSetting(boat.cargoTonnes)) {
    hydro = boat.hydrodynamics = boatHydrodynamics(boat.length, boat.beam,boat.provisionDays,boat.cargoTonnes);
  }
  const inertia = hydro.mass + hydro.addedMass;
  const sailing = boat.propulsion === 'sail';
  advanceSails(boat, dt, windSpeed, windDirection);
  const target = boat.speed * KNOT_TO_MPS;
  const thrust = hydro.drag * target * Math.abs(target);
  const waveForce = -1025 * 9.81 * hydro.volume * slope;
  const initial = boatForwardSpeed(boat);
  const waveRoll=(boat.roll ?? boat.sailHeel)-boat.sailHeel;
  const waveRollVelocity=(boat.rollVelocity ?? boat.sailHeelVelocity)-boat.sailHeelVelocity;
  let velocity = initial, distance = 0, sideways = boat.leewayVelocity ?? 0, sidewaysDistance = 0;
  const steps = Math.ceil(dt * 120), h = dt / steps;
  for (let i = 0; i < steps; i++) {
    const loads = sailing ? sailForces(boat, windSpeed, windDirection, velocity, sideways,
      waveRoll+boat.sailHeel,waveRollVelocity+boat.sailHeelVelocity) : null;
    stepBoatHeel(boat,loads?.rollMoment ?? 0,h);
    const force = (loads ? loads.forward : thrust) + waveForce;
    const free = velocity + force / inertia * h;
    const froude = Math.abs(velocity) / Math.sqrt(9.81 * boat.length);
    const drag = hydro.drag * (sailing ? 1 + 80 * Math.max(0, froude - 0.28) ** 2 : 1);
    // Implicit signed quadratic drag: stable through zero and during reversals.
    const next = 2 * free / (1 + Math.sqrt(1 + 4 * drag / inertia * h * Math.abs(free)));
    distance += (velocity + next) * 0.5 * h;
    velocity = next;
    // Keel/hull resistance bounds sideways drift instead of converting it into forward drive.
    const lateralInertia = hydro.mass * 1.8, keelDrag = 0.5 * 1025 * boat.length * hydro.draft * 0.8;
    const lateralFree = sideways + (loads?.side ?? 0) / lateralInertia * h;
    const nextSide = 2 * lateralFree / (1 + Math.sqrt(1 + 4 * keelDrag / lateralInertia * h * Math.abs(lateralFree)));
    sidewaysDistance += (sideways + nextSide) * 0.5 * h; sideways = nextSide;
  }
  boat.surgeVelocity = velocity;
  boat.surgeAcceleration = (velocity - initial) / dt;
  boat.leewayVelocity = sideways; boat.leewayDistance = sidewaysDistance;
  sailForces(boat, windSpeed, windDirection, velocity, sideways,
    waveRoll+boat.sailHeel,waveRollVelocity+boat.sailHeelVelocity);
  return distance;
}

// Approximate rigid hull response to a 3 x 3 grid of actual ocean heights.
export function boatTargets(heights, length, beam) {
  const mean = (a, b, c) => (heights[a] + heights[b] + heights[c]) / 3;
  return {
    heave: heights.reduce((a, b) => a + b, 0) / 9,
    pitch: Math.atan2(mean(6, 7, 8) - mean(0, 1, 2), length),
    roll: Math.atan2(mean(2, 5, 8) - mean(0, 3, 6), beam),
  };
}

// Exact critically damped spring step: stable even when frame rate varies.
export function boatSpring(state, key, target, omega, dt, targetVelocity = 0) {
  const velocity = key + 'Velocity';
  const offset = state[key] - target;
  const relativeVelocity = (state[velocity] || 0) - targetVelocity;
  const c = relativeVelocity + omega * offset;
  const decay = Math.exp(-omega * dt);
  state[key] = target + targetVelocity * dt + (offset + c * dt) * decay;
  state[velocity] = targetVelocity + (relativeVelocity - omega * c * dt) * decay;
}

// Transform a local look vector by hull roll, pitch, then compass heading.
export function boatRotate(out, x, y, z, heading, pitch, roll) {
  const cr = Math.cos(roll), sr = Math.sin(roll);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const ch = Math.cos(heading), sh = Math.sin(heading);
  const xx = cr * x - sr * y, yy = sr * x + cr * y;
  const yp = cp * yy - sp * z, zp = sp * yy + cp * z;
  out[0] = ch * xx - sh * zp; out[1] = yp; out[2] = sh * xx + ch * zp;
}
// Rudder lag and yaw inertia; a simple speed-dependent displacement-hull model.
export function stepBoatSteering(boat, command, dt) {
  boat.rudderTarget = Math.max(-35, Math.min(35, boat.rudderTarget + command * 28 * dt));
  boatSpring(boat, 'rudder', boat.rudderTarget, 9, dt);
  const speed = boatForwardSpeed(boat);
  const desired = speed / Math.max(boat.length, 3) * Math.tan(boat.rudder * Math.PI / 180) * 0.65;
  const previous = boat.yawRate || 0;
  boat.yawRate = desired + (previous - desired) * Math.exp(-dt / (0.9 + boat.length * 0.06));
  boat.heading = ((boat.heading + (previous + boat.yawRate) * 0.5 * dt * 180 / Math.PI) % 360 + 360) % 360;
}

// World-space eye anchor; keeping it separate from the vessel allows inspection.
export function boatEyePosition(out, boat) {
  boatRotate(out, 0, boat.eye, HELM_EYE_Z * boat.length / 12, boat.heading * Math.PI / 180, boat.pitch, boat.roll);
  out[0] += boat.x; out[1] += boat.heave; out[2] += boat.z;
  return out;
}

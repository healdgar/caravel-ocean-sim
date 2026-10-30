import assert from 'node:assert/strict';
import { test } from 'node:test';
import { boatWaveAttitude, boatTargets, boatSpring, boatRotate, boatHydrodynamics, hullHydrostatics, boatForwardSpeed, boatWaveSlope, stepBoatSurge, KNOT_TO_MPS } from '../js/boat.js';

test('flat sea gives level hull and correct height', () => {
  assert.deepEqual(boatTargets(Array(9).fill(2), 10, 3), { heave: 2, pitch: 0, roll: 0 });
});
test('hull fits a sloping water plane with correct bow and starboard signs', () => {
  const heights = [];
  for (let f = -1; f <= 1; f++) for (let r = -1; r <= 1; r++) heights.push(2 + f + r * 0.3);
  const pose = boatTargets(heights, 10, 3);
  assert.ok(Math.abs(pose.heave - 2) < 1e-12);
  assert.ok(Math.abs(pose.pitch - Math.atan(0.2)) < 1e-12);
  assert.ok(Math.abs(pose.roll - Math.atan(0.2)) < 1e-12);
  assert.ok(boatTargets(heights, 20, 3).pitch < pose.pitch);
});
test('damping is frame-rate independent for a held wave target', () => {
  const a = { heave: 0 }, b = { heave: 0 };
  for (let i = 0; i < 60; i++) boatSpring(a, 'heave', 2, 3, 1 / 60);
  for (let i = 0; i < 20; i++) boatSpring(b, 'heave', 2, 3, 1 / 20);
  assert.ok(Math.abs(a.heave - b.heave) < 1e-12);
  assert.ok(a.heave > 0 && a.heave < 2);
});
test('a rising water plane is followed without permanent spring lag', () => {
  for(const dt of [1/30,1/120]){
    const state={heave:0};
    for(let i=0;i<Math.round(4/dt);i++)boatSpring(state,'heave',i*dt,3,dt,1);
    assert.ok(Math.abs(state.heave-4)<0.001);
    assert.ok(Math.abs(state.heaveVelocity-1)<0.001);
  }
});
test('heading and pitch orient the camera along the boat', () => {
  const out = new Float64Array(3);
  boatRotate(out, 0, 0, -1, Math.PI / 2, 0, 0);
  assert.ok(Math.abs(out[0] - 1) < 1e-12);
  boatRotate(out, 0, 0, -1, 0, 0.2, 0);
  assert.ok(out[1] > 0);
});
import { stepBoatSteering } from '../js/boat.js';

const steeringBoat = (speed=6,length=12) => ({speed,length,heading:0,rudder:0,rudderTarget:0,yawRate:0});
function advance(boat,command,seconds,dt=1/60) { for(let t=0;t<seconds-1e-9;t+=dt)stepBoatSteering(boat,command,dt); return boat; }
test('rudder steers port and starboard with turn inertia', () => {
  const right=advance(steeringBoat(),1,6),left=advance(steeringBoat(),-1,6);
  assert.ok(right.heading>5 && right.heading<90);
  assert.ok(left.heading>270 && left.heading<355);
  assert.ok(Math.abs(right.heading+left.heading-360)<1e-8);
  assert.ok(right.rudder<=35 && right.rudder>34);
});
test('stationary boat has no rudder-driven yaw, and a larger hull turns more slowly', () => {
  assert.equal(advance(steeringBoat(0),1,8).heading,0);
  assert.ok(advance(steeringBoat(6,24),1,6).heading<advance(steeringBoat(6,12),1,6).heading);
});
test('centering rudder lets yaw decay and results stay stable at lower frame rate', () => {
  const a=advance(steeringBoat(),1,4),b=advance(steeringBoat(),1,4,1/20);
  assert.ok(Math.abs(a.heading-b.heading)<0.3);
  const turn=a.yawRate; a.rudderTarget=0; advance(a,0,10);
  assert.ok(Math.abs(a.yawRate)<turn*0.01);
  assert.ok(Math.abs(a.rudder)<1e-6);
});

import { boatEyePosition, stepBoatView, stepDeckWalk, resetDeckWalk, deckStationLabel } from '../js/boat.js';
import { HELM_EYE_X, HELM_EYE_Z, HELM_EYE_HEIGHT } from '../js/hull.js';
test('boarding uses the ship world position and eye height independently of a spectator camera', () => {
  const boat={x:100,z:-30,heave:2,eye:HELM_EYE_HEIGHT,length:12,beam:3.6,heading:90,pitch:0,roll:0};
  const out=new Float64Array(3); boatEyePosition(out,boat);
  assert.deepEqual(Array.from(out),[100-HELM_EYE_Z,2+HELM_EYE_HEIGHT,-30+HELM_EYE_X]);
  boat.pitch=0.2;boat.roll=-0.15;boatEyePosition(out,boat);
  assert.ok(Math.abs(Math.hypot(out[0]-boat.x,out[1]-boat.heave,out[2]-boat.z)-Math.hypot(HELM_EYE_X,boat.eye,HELM_EYE_Z))<1e-12);
  const previous=Array.from(out);boat.x+=20;boat.z-=5;boatEyePosition(out,boat);
  assert.ok(Math.abs(out[0]-previous[0]-20)<1e-12);
  assert.ok(Math.abs(out[2]-previous[2]+5)<1e-12);
  boat.length=24;boat.beam=7.2;boat.pitch=boat.roll=boat.heading=0;boatEyePosition(out,boat);
  assert.ok(Math.abs(out[0]-boat.x-2*HELM_EYE_X)<1e-12,'captain eye follows a resized beam');
  assert.ok(Math.abs(out[2]-boat.z-2*HELM_EYE_Z)<1e-12,'helm eye follows a resized stern');
});

test('captain starts to windward and crosses smoothly with frame-independent tack changes',()=>{
  const results=[];
  for(const dt of [1/10,1/30,1/120]){
    const b={sailState:{tack:-1}};stepBoatView(b,0);assert.equal(b.eyeSide,-1);
    b.sailState.tack=1;
    for(let i=0;i<Math.round(2/dt);i++){
      const previous=b.eyeSide;stepBoatView(b,dt);
      assert.ok(b.eyeSide>=previous && b.eyeSide<=1);
      assert.ok(b.eyeSide-previous<3*dt,'crossing never teleports across the deck');
    }
    results.push(b.eyeSide);assert.ok(b.eyeSide>.99);
  }
  assert.ok(Math.max(...results)-Math.min(...results)<1e-12);
});

const surgeBoat = (speed = 6) => ({ length: 20, beam: 6, speed, surgeVelocity: speed * KNOT_TO_MPS });
test('displacement scales with submerged geometry and includes added water inertia', () => {
  const base = boatHydrodynamics(20, 6), long = boatHydrodynamics(40, 6), wide = boatHydrodynamics(20, 12);
  assert.ok(base.fixedMass > 107000 && base.fixedMass < 108000);
  assert.ok(base.mass>115000&&base.mass<116000);
  assert.ok(base.draft>2.08&&base.draft<2.10);
  assert.ok(Math.abs(base.mass-base.volume*1025)<.001);
  assert.equal(long.fixedMass, 2 * base.fixedMass);
  assert.equal(wide.fixedMass, 2 * base.fixedMass);
  assert.equal(long.loadMass,base.loadMass,'resizing does not duplicate the twelve-person manifest');
  assert.ok(base.addedMass > 0 && base.drag > 0);
});

test('crew and sixty days of stores settle at an Archimedean waterline; cargo increases draft and inertia',()=>{
  const ship=boatHydrodynamics(20,6),empty=boatHydrodynamics(20,6,0),laden=boatHydrodynamics(20,6,60,20);
  assert.equal(ship.crewMass,960);assert.equal(ship.waterMass,3600);assert.equal(ship.foodMass,1080);
  assert.equal(ship.storesMass,2300);assert.equal(ship.loadMass,7940);
  assert.equal(ship.mass-empty.mass,4680);assert.equal(laden.mass-ship.mass,20000);
  for(const h of [empty,ship,laden]){
    assert.ok(Math.abs(hullHydrostatics(h.length,h.beam,h.sinkage).mass-h.mass)<.001);
    assert.ok(Math.abs(h.draft+h.freeboard-(2+7/6))<1e-10);
    assert.equal(h.overloadKg,0);assert.ok(h.metacentricHeight>0);
  }
  assert.ok(empty.draft<ship.draft&&ship.draft<laden.draft);
  assert.ok(laden.rollInertia>ship.rollInertia&&laden.drag>ship.drag&&laden.heaveOmega<ship.heaveOmega);
  assert.ok(laden.centreOfGravity<ship.centreOfGravity,'secured hold cargo lowers the combined centre of gravity');
});

test('loading edits invalidate cached hydrostatics without changing velocity or hiding crew mass',()=>{
  const b={...surgeBoat(0),surgeVelocity:3};stepBoatSurge(b,0,.01);
  const before=b.surgeVelocity,hydro=b.hydrodynamics;b.cargoTonnes=20;b.crew=false;stepBoatSurge(b,0,.00001);
  assert.notEqual(b.hydrodynamics,hydro);assert.ok(b.hydrodynamics.sinkage>hydro.sinkage);
  assert.ok(Math.abs(b.surgeVelocity-before)<.0001);assert.equal(b.hydrodynamics.crewMass,960);
  const next=b.hydrodynamics;stepBoatSurge(b,0,.01);assert.equal(b.hydrodynamics,next,'steady frames reuse the solved loading');
});

test('unsupported loading is reported without discarding mass or sinking through the open deck',()=>{
  const small=boatHydrodynamics(3,1,120,40);
  assert.ok(small.overloadKg>40000);assert.ok(small.freeboard>=.15);
  assert.equal(small.cargoMass,40000);assert.equal(small.mass,small.fixedMass+small.loadMass);
  for(const h of [small,boatHydrodynamics(20,6,NaN,Infinity),boatHydrodynamics(20,6,-1,-1)])
    assert.ok(Object.values(h).every(Number.isFinite));
});

test('calm-water thrust holds the selected speed and distance without a speed clamp', () => {
  for (const speed of [0, 6, 40]) for (const dt of [1 / 120, 1 / 30, 0.1]) {
    const boat = surgeBoat(speed); let distance = 0;
    for (let i = 0; i < Math.round(20 / dt); i++) distance += stepBoatSurge(boat, 0, dt);
    assert.ok(Math.abs(boat.surgeVelocity - speed * KNOT_TO_MPS) < 1e-10);
    assert.ok(Math.abs(distance - speed * KNOT_TO_MPS * 20) < 1e-8);
  }
});

test('uphill pressure slows the ship; downhill pressure accelerates it independently of pitch', () => {
  const uphill = { ...surgeBoat(), pitch: -0.5 }, downhill = { ...surgeBoat(), pitch: 0.5 };
  stepBoatSurge(uphill, 0.08, 0.1); stepBoatSurge(downhill, -0.08, 0.1);
  assert.ok(uphill.surgeVelocity < 6 * KNOT_TO_MPS);
  assert.ok(downhill.surgeVelocity > 6 * KNOT_TO_MPS);
  const drifting = surgeBoat(0); stepBoatSurge(drifting, 0.08, 0.1);
  assert.ok(drifting.surgeVelocity < 0, 'wave force can move an unpowered hull astern');
});

test('equal applied force accelerates a larger inertia less; target edits preserve momentum', () => {
  const a = surgeBoat(), b = surgeBoat();
  a.hydrodynamics = boatHydrodynamics(20, 6);
  b.hydrodynamics = { ...a.hydrodynamics, mass: a.hydrodynamics.mass * 2, addedMass: a.hydrodynamics.addedMass * 2 };
  a.speed = b.speed = 12;
  stepBoatSurge(a, 0, 0.1); stepBoatSurge(b, 0, 0.1);
  assert.ok(a.surgeVelocity > b.surgeVelocity && b.surgeVelocity > 6 * KNOT_TO_MPS);
  assert.ok(a.surgeVelocity < 6.1 * KNOT_TO_MPS, 'speed setting changes thrust, not current velocity');
});

test('unpowered drag dissipates kinetic energy in either direction without reversing it', () => {
  for (const sign of [-1, 1]) {
    const boat = { ...surgeBoat(0), surgeVelocity: sign * 8 };
    let previous = Math.abs(boat.surgeVelocity);
    for (let i = 0; i < 1200; i++) {
      stepBoatSurge(boat, 0, 0.1);
      assert.ok(Math.abs(boat.surgeVelocity) < previous);
      assert.equal(Math.sign(boat.surgeVelocity), sign);
      previous = Math.abs(boat.surgeVelocity);
    }
  }
});

test('undamped wave work equals the change in kinetic energy including added mass', () => {
  for (const slope of [-0.08, 0.08]) {
    const boat = { ...surgeBoat(0), surgeVelocity: 2 };
    const hydro = boat.hydrodynamics = { ...boatHydrodynamics(20, 6), drag: 0 };
    const inertia = hydro.mass + hydro.addedMass, start = 0.5 * inertia * boat.surgeVelocity ** 2;
    let distance = 0;
    for (let i = 0; i < 100; i++) distance += stepBoatSurge(boat, slope, 0.1);
    const work = -1025 * 9.81 * hydro.volume * slope * distance;
    const energy = 0.5 * inertia * boat.surgeVelocity ** 2 - start;
    assert.ok(Math.abs(work - energy) < 1e-6);
  }
});

test('travelling swell surge remains stable and consistent from 10 to 120 FPS', () => {
  const run = dt => {
    const boat = surgeBoat(); let distance = 0, min = boat.surgeVelocity, max = min;
    for (let i = 0; i < Math.round(120 / dt); i++) {
      const slope = 0.06 * Math.sin(2 * Math.PI * (distance / 120 - i * dt / 8.77));
      distance += stepBoatSurge(boat, slope, dt);
      min = Math.min(min, boat.surgeVelocity); max = Math.max(max, boat.surgeVelocity);
      assert.ok(Number.isFinite(distance) && Math.abs(boat.surgeVelocity) < 20);
    }
    return { velocity: boat.surgeVelocity, distance, min, max };
  };
  const reference = run(1 / 120);
  assert.ok(reference.max - reference.min > 1, 'waves produce meaningful velocity variation');
  for (const dt of [1 / 30, 0.1]) {
    const result = run(dt);
    assert.ok(Math.abs(result.velocity - reference.velocity) < 0.06);
    // The incident force is sampled once per frame, so its phase is quantized.
    assert.ok(Math.abs(result.distance - reference.distance) / reference.distance < 0.005);
  }
});

test('wave force projects onto heading and stale or superseded probes lose influence', () => {
  const boat = { waveSlopeX: 0.1, waveSlopeZ: 0, waveSampleTime: 2, waveRevision: 4, revision: 4, heading: 90 };
  assert.equal(boatWaveSlope(boat, 2.1), 0.1);
  boat.heading = 270; assert.equal(boatWaveSlope(boat, 2.1), -0.1);
  boat.heading = 0; assert.equal(boatWaveSlope(boat, 2.1), 0);
  boat.heading = 90; assert.ok(Math.abs(boatWaveSlope(boat, 4)) < 0.0001);
  assert.equal(boatWaveSlope(boat, 1), 0, 'looped simulation clock rejects old samples');
  boat.revision++; assert.equal(boatWaveSlope(boat, 2.1), 0);
});

test('rudder authority follows actual surge speed including a reversal', () => {
  const forward = { ...steeringBoat(6), surgeVelocity: 3 }, reverse = { ...steeringBoat(6), surgeVelocity: -3 };
  const stopped = { ...steeringBoat(6), surgeVelocity: 0 };
  advance(forward, 1, 4); advance(reverse, 1, 4); advance(stopped, 1, 4);
  assert.ok(forward.heading > 0 && forward.heading < 90);
  assert.ok(Math.abs(forward.heading + reverse.heading - 360) < 1e-8);
  assert.equal(stopped.heading, 0);
  assert.equal(boatForwardSpeed(stopped), 0);
});


test('filtered pressure slopes orient both axes independently of fine surface samples',()=>{
  const north=boatWaveAttitude(.1,-.2,0),east=boatWaveAttitude(.1,-.2,90);
  assert.ok(Math.abs(north.roll-Math.atan(.1))<1e-12);
  assert.ok(Math.abs(north.pitch-Math.atan(.2))<1e-12);
  assert.ok(Math.abs(east.roll-Math.atan(-.2))<1e-12);
  assert.ok(Math.abs(east.pitch-Math.atan(.1))<1e-12);
});

test('deck walking moves viewpoint across main deck and bow while clamping to hull bulwarks', () => {
  const boat={modelId:'nina',x:0,z:0,heave:0,eye:HELM_EYE_HEIGHT,length:20,beam:6,heading:0,pitch:0,roll:0};
  const helmOut=new Float64Array(3),walkOut=new Float64Array(3);
  boatEyePosition(helmOut,boat);
  assert.equal(deckStationLabel(boat),'Deck');

  for(let i=0;i<60;i++)stepDeckWalk(boat,1,0,0,1/30);
  boatEyePosition(walkOut,boat);
  assert.ok(walkOut[2]<helmOut[2]-4,'walking forward advances viewpoint toward the bow (-Z)');
  assert.ok(walkOut[1]<helmOut[1]-0.2,'stepping off the quarterdeck onto the waist lowers eye height to the main deck');
  assert.equal(deckStationLabel(boat),'Waist');

  for(let i=0;i<180;i++)stepDeckWalk(boat,1,-1,0,1/30);
  boatEyePosition(walkOut,boat);
  assert.equal(deckStationLabel(boat),'Bow');
  assert.ok(Math.abs(walkOut[0])<boat.beam*0.5,'bulwark clamping keeps the walker inside the hull beam');

  resetDeckWalk(boat);
  boatEyePosition(walkOut,boat);
  assert.deepEqual(Array.from(walkOut),Array.from(helmOut));
});

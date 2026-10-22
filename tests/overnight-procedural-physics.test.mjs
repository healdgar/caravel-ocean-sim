// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import {PROCEDURAL_DESIGNS,proceduralDesign,proceduralDeck,proceduralHullDeck,proceduralDeckBarrier,proceduralHullWidth,proceduralKeelHalfWidth,proceduralKeelBounds,proceduralDraft,proceduralProvisionDays} from '../js/models/procedural.js';
import {boatHydrodynamics,hullHydrostatics,stepBoatSurge,stepBoatSteering} from '../js/boat.js';
import {createHullLateralDescriptor,evaluateHullLateral} from '../js/hull-lateral.js';
import {createHullContactDefinitions} from '../js/hull-contact.js';
import {sailingState,advanceSails,sailForces} from '../js/sailing.js';
import {advanceRowing,rowingStationPose,rowingForces} from '../js/rowing.js';
const overnightPhysicsIDs=['oseberg','lusoria','taino-canoe','flying-cloud','gipsy-moth-iv'];
const overnightPhysicsClose=(a,b,e=1e-8)=>assert.ok(Math.abs(a-b)<=e,`${a} != ${b}`);
const overnightPhysicsBoat=id=>{const d=proceduralDesign(id);return {modelId:id,...d.runtime,propulsion:'sail',speed:0,heading:0,rudder:0,rudderTarget:0,yawRate:0,roll:0,pitch:0,heave:0,revision:0,sailFore:0,sailMain:0,sailMizzen:0,target:{roll:0,pitch:0}};};

test('shared boat rowing cadence is bounded in Hz and explicit commands override the saved control',()=>{
  const b=overnightPhysicsBoat('lusoria');b.rowingEffort=.5;b.rowingCadence=.55;
  assert.equal(advanceRowing(b,.1).cadence,.55);
  assert.equal(advanceRowing(b,.1,{cadence:.3}).cadence,.3);
  b.rowingCadence=Infinity;assert.equal(advanceRowing(b,.1).cadence,proceduralDesign(b.modelId).propulsion.cadence);
  b.rowingCadence=0;assert.equal(advanceRowing(b,.1).cadence,.12);
  b.rowingCadence=1;assert.equal(advanceRowing(b,.1).cadence,proceduralDesign(b.modelId).propulsion.maxCadence);
});

test('overnight authored hulls have strict independent hydro, keel and contact geometry',()=>{
  for(const id of overnightPhysicsIDs){
    const d=proceduralDesign(id),h=boatHydrodynamics(d.runtime.length,d.runtime.beam,undefined,0,id),contacts=createHullContactDefinitions(id);
    assert.equal(h.modelCode,d.modelCode);assert.equal(h.crewMass,d.loading.crew*d.loading.personKg);
    assert.equal(h.provisionDays,proceduralProvisionDays(id));assert.ok(h.mass>0&&h.rollInertia>0&&h.pitchInertia>0&&h.metacentricHeight>0);
    assert.equal(contacts.points.length,10);assert.ok(contacts.values.every(Number.isFinite));
    for(const p of contacts.points){const n=Math.hypot(...p.normal);assert.ok(n>.99&&n<1.01);}
    const descriptor=createHullLateralDescriptor({modelId:id,...d.runtime,waterline:h.sinkage});
    assert.ok(descriptor.area>0);assert.equal(descriptor.components.some(c=>c.id!=='hull'),!!d.keel);
    const f=evaluateHullLateral({},descriptor,{surge:2,sway:.3,yawRate:.02,rollRate:.01,cgY:h.centreOfGravity-h.datumDraft});
    assert.ok(f.power<=1e-8);overnightPhysicsClose(f.power,-f.dissipation,1e-7);
  }
  for(const id of ['missing','constructor','__proto__']){
    assert.throws(()=>proceduralDesign(id));assert.throws(()=>boatHydrodynamics(14,2,1,0,id));
  }
});

test('open rowing gunwales and recessed yacht cockpit are distinct from their floor',()=>{
  for(const id of ['oseberg','lusoria','taino-canoe']){
    assert.ok(proceduralHullDeck(id,0)>proceduralDeck(id,0));
    overnightPhysicsClose(proceduralDeck(id,0)+proceduralDeckBarrier(id,0),proceduralHullDeck(id,0));
  }
  const d=proceduralDesign('gipsy-moth-iv'),z=(d.cockpit.bounds[0]+d.cockpit.bounds[1])*.5;
  assert.ok(proceduralDeck(d.id,z,0)<proceduralDeck(d.id,z,d.cockpit.halfWidth+.1));
  overnightPhysicsClose(proceduralDeck(d.id,z,0)+proceduralDeckBarrier(d.id,z,0),d.cockpit.coamingHeight+(proceduralHullDeck(d.id,z)-d.profile.deck));
});

test('ballast fin displacement integrates union width rather than an invented rectangle',()=>{
  const id='gipsy-moth-iv',d=proceduralDesign(id),sx=d.runtime.beam/d.frame.beam,sy=d.frame.verticalScale,sz=d.runtime.length/d.frame.length;
  let volume=0,bodyVolume=0;const ny=480,nz=480,lower=-proceduralDraft(id),dy=-lower/ny,dz=12/nz;
  for(let j=0;j<ny;j++)for(let i=0;i<nz;i++){
    const y=lower+(j+.5)*dy,z=-6+(i+.5)*dz,w=proceduralHullWidth(id,z,y);
    bodyVolume+=2*w*dy*dz;volume+=2*Math.max(w,proceduralKeelHalfWidth(id,z,y))*dy*dz;
  }
  const actual=hullHydrostatics(d.runtime.length,d.runtime.beam,0,id);
  assert.ok(volume>bodyVolume);assert.ok(Math.abs(actual.volume-volume*sx*sy*sz)<actual.volume*.01);
  const h=boatHydrodynamics(d.runtime.length,d.runtime.beam,undefined,0,id);
  assert.equal(h.ballastMass,d.keel.ballast.massKg);assert.ok(h.ballastKG<h.centreOfGravity);
  assert.equal(h.referenceDisplacementKg,d.loading.referenceDisplacementKg);
  assert.equal(h.referenceMassDifferenceKg,h.mass-h.referenceDisplacementKg);
  const k=proceduralKeelBounds(id,0);assert.ok(k&&k.bottom<d.profile.levels[0]);
  assert.equal(proceduralKeelBounds(id,-5),null);assert.equal(proceduralKeelHalfWidth(id,-5,-1),0);
});

test('single physical main mast follows main control only; canoe has zero canvas force',()=>{
  for(const id of ['oseberg','lusoria']){
    const boat=overnightPhysicsBoat(id);boat.sailMain=1;advanceSails(boat,3,8,Math.PI/2);
    const s=sailingState(boat);assert.equal(s.set[0],0);assert.ok(s.set[1]>0);assert.equal(s.set[2],0);
    const loads=sailForces(boat,8,Math.PI/2,0);assert.ok(loads.area>0);assert.equal(loads.geometry.surfaces[0].group,1);
  }
  const canoe=overnightPhysicsBoat('taino-canoe');canoe.sailFore=canoe.sailMain=canoe.sailMizzen=1;advanceSails(canoe,2,30,0);
  const f=sailForces(canoe,30,0,2);assert.equal(f.area,0);assert.equal(f.forward,0);assert.equal(f.yawMoment,0);
});

test('missing actual water coasts with no stroke thrust or synthetic steering-oar assist',()=>{
  const boat=overnightPhysicsBoat('lusoria');boat.rowingEffort=1;boat.rudder=boat.rudderTarget=30;
  for(let i=0;i<60;i++){stepBoatSurge(boat,0,1/60,0,0);stepBoatSteering(boat,0,1/60);}
  assert.equal(boat.surgeVelocity,0);assert.equal(boat.leewayVelocity,0);assert.equal(boat.yawRate,0);assert.equal(boat.heading,0);
  boat.rowingWater={sample:()=>({height:0,velocity:[0,0,0]})};
  let moved=0;for(let i=0;i<240;i++){moved+=stepBoatSurge(boat,0,1/60,0,0);stepBoatSteering(boat,0,1/60);}
  assert.ok(moved>0);assert.ok(boat.rowingLoads.crewPower<=proceduralDesign('lusoria').stations.length*210+1e-7);
});

test('attendance parks an unoccupied propulsor and substep velocity reaches relative blade drag',()=>{
  const b=overnightPhysicsBoat('oseberg'),d=proceduralDesign(b.modelId);b.rowingState={phase:.22,rate:.45,effortPort:1,effortStarboard:1};
  const live=rowingStationPose(b,0);assert.ok(live.drive);
  b.rowingAttendance=new Set(d.stations.slice(1).map(s=>s.id));assert.equal(rowingStationPose(b,0).drive,false);
  const f=rowingForces({},b,{surge:0,sway:0}),moving=rowingForces({},b,{surge:3,sway:.2});
  assert.notEqual(f.forward,moving.forward);assert.ok(moving.blades.every(x=>x.stationId!==d.stations[0].id||!x.drive));
});

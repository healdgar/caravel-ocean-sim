// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createShipGunnery,createVesselDamageState,resetVesselDamageState,applyShipImpactDamage,stepVesselDamage,sweepShipSegment} from '../js/gunnery-control.js';
import {boatHydrodynamics} from '../js/boat.js';
import {setVesselHullIntegrity,repairVessel,refloatVessel,stopVesselLeaks,pumpVesselDry,raiseVesselRig,vesselDamageSnapshot,restoreVesselDamageSnapshot} from '../js/vessel-damage.js';

function ship(modelId='nina',length=20,beam=6){
  const boat={modelId,id:'target',length,beam,x:0,z:0,heave:0,heading:0,pitch:0,roll:0,propulsion:'sail',cargoTonnes:2};
  boat.hydrodynamics=boatHydrodynamics(length,beam);
  createShipGunnery(boat);
  return boat;
}
// A real shot through the hull, so these tests exercise the same fields a battle writes.
function hit(boat,energy=900000){
  const from=[boat.x-60,2.2,boat.z],to=[boat.x+60,2.2,boat.z];
  const sweep=sweepShipSegment(from,to,.08,boat,{id:'enemy',modelId:'nina',x:-80,z:0,heave:0,heading:0,pitch:0,roll:0});
  assert.ok(sweep,'the shot meets the hull');
  return applyShipImpactDamage(boat,{...sweep,velocity:[400,0,0],mass:12,energy});
}
function flood(boat,tonnes=6){
  const d=boat.damage;d.compartments.midPort.breachArea=.02;d.waterlineBreachArea=.02;
  d.compartments.midPort.waterTonnes+=tonnes;d.floodingTonnes+=tonnes;d.floodingSinkage=.3;d.floodingRoll=.05;d.floodingPitch=.02;
  boat.cargoTonnes+=tonnes;
}

test('setting hull integrity keeps its joules, so the next hit cannot undo a repair',()=>{
  const boat=ship();const d=boat.damage;
  d.hullDamageJoules=d.maxHullEnergy*.6;d.hullIntegrity=.4;
  repairVessel(boat,{hullGain:.5});
  assert.ok(Math.abs(d.hullIntegrity-.9)<1e-9);
  assert.ok(Math.abs(d.hullDamageJoules-d.maxHullEnergy*.1)<1e-6,'joules follow the repair');
  hit(boat,20000);
  assert.ok(d.hullIntegrity>.7,`one light hit after repair stays near the repaired value, got ${d.hullIntegrity}`);
  assert.equal(setVesselHullIntegrity(d,3),1,'integrity is bounded');
  assert.equal(d.hullDamageJoules,0);
  assert.equal(setVesselHullIntegrity(d,'bad'),0,'non-numeric integrity cannot corrupt the hull');
});

test('a repaired ship stops flooding and gives back the weight of the water',()=>{
  const boat=ship();flood(boat,6);const before=boat.cargoTonnes;
  repairVessel(boat,{leaks:true,flooding:true});
  const d=boat.damage;
  assert.equal(boat.cargoTonnes,before-6,'floodwater carried as cargo weight is removed');
  assert.equal(d.floodingTonnes,0);assert.equal(d.waterlineBreachArea,0);assert.equal(d.floodingSinkage,0);
  assert.ok(Object.values(d.compartments).every(c=>c.breachArea===0&&c.waterTonnes===0));
  for(let i=0;i<40;i++)stepVesselDamage(boat,.25,null);
  assert.equal(d.floodingTonnes,0,'no water returns on later damage steps');
  assert.equal(d.floodingSinkage,0);
});

test('stopping leaks alone leaves the water aboard, and dry pumping is safe to repeat',()=>{
  const boat=ship();flood(boat,4);
  stopVesselLeaks(boat.damage);
  assert.equal(boat.damage.floodingTonnes,4);assert.equal(boat.damage.waterlineBreachArea,0);
  pumpVesselDry(boat);const dry=boat.cargoTonnes;pumpVesselDry(boat);
  assert.equal(boat.cargoTonnes,dry);assert.equal(dry,2,'only floodwater came out, not real cargo');
});

test('rig floors raise masts and clear their broken state only as far as the floor allows',()=>{
  const boat=ship();const d=boat.damage;
  d.mastIntegrity={fore:0,main:.5,mizzen:.9};d.mastState={fore:2,main:1,mizzen:0};
  raiseVesselRig(d,.75);
  assert.deepEqual(d.mastIntegrity,{fore:.75,main:.75,mizzen:.9},'sound masts are not lowered');
  assert.deepEqual(d.mastState,{fore:0,main:0,mizzen:0});
  raiseVesselRig(d,.5);assert.equal(d.mastIntegrity.fore,.75);
  d.mastIntegrity={fore:0,main:.5,mizzen:.9};d.mastState={fore:2,main:1,mizzen:0};
  raiseVesselRig(d,.1);
  assert.deepEqual(d.mastState,{fore:2,main:1,mizzen:0},'a low floor leaves broken masts broken');
});

test('a full refit restores guns, fires and structure as well as the hull',()=>{
  const boat=ship();const d=boat.damage;
  boat.gunnery.guns[0].dismounted=true;d.dismountedGuns=1;
  d.fires.push({intensity:1});d.fireCount=1;d.fireIntensity=1;
  d.craters.push({});d.impactSites.push({});d.pendingBakes.push({});d.partDamage['hull.planking']=.8;d.throughBreaches=2;
  repairVessel(boat,{minHull:1,minRig:1,guns:true,fires:true,structure:true});
  assert.equal(boat.gunnery.guns[0].dismounted,false);assert.equal(d.dismountedGuns,0);
  assert.equal(d.fires.length,0);assert.equal(d.fireIntensity,0);
  assert.equal(d.craters.length+d.impactSites.length+d.pendingBakes.length,0);
  assert.equal(d.partDamage['hull.planking'],0);assert.equal(d.throughBreaches,0);
});

test('a wreck refloated and reset is a new ship with nothing left of the old one',()=>{
  const boat=ship();const d=boat.damage;
  hit(boat);flood(boat,8);
  d.sunk=true;d.settledWreck=true;d.restingOnBottom=true;d.sinkingDepth=25;d.battleMorale=.1;d.surrendered=true;
  d.mastIntegrity.fore=0;d.mastState.fore=2;d.fires.push({});d.crewCasualties.killed=9;d.crewCasualties.able=3;
  boat.gunnery.guns[0].dismounted=true;boat.magazine.powderKg=0;boat.magazine.exploded=true;
  const fresh=resetVesselDamageState(boat);
  assert.equal(boat.damage,fresh);
  assert.equal(fresh.sunk,false);assert.equal(fresh.settledWreck,false);assert.equal(fresh.surrendered,false);
  assert.equal(fresh.sinkingDepth,0);assert.equal(fresh.hullIntegrity,1);assert.equal(fresh.hullDamageJoules,0);
  assert.equal(fresh.floodingTonnes,0);assert.equal(fresh.waterlineBreachArea,0);assert.equal(fresh.battleMorale,1);
  assert.equal(fresh.mastState.fore,0);assert.equal(fresh.fires.length,0);assert.equal(fresh.crewCasualties.killed,0);
  assert.equal(boat.gunnery.guns[0].dismounted,false);
  assert.ok(boat.magazine.powderKg>0);assert.equal(boat.magazine.exploded,false);
  assert.ok(Math.abs(boat.cargoTonnes-2)<.01,'the old floodwater weight went with the old ship');
  stepVesselDamage(boat,.25,null);
  assert.equal(boat.damage.sunk,false,'she does not re-founder on the next frame');
  d.sunk=true;boat.damage=d;refloatVessel(boat);
  assert.equal(d.sunk,false);assert.equal(d.settledWreck,false);assert.equal(d.sinkingDepth,0);
});

test('a damage snapshot survives JSON and restores onto a pristine ship',()=>{
  const boat=ship();const d=boat.damage;
  hit(boat);flood(boat,3);
  d.mastIntegrity.main=.4;d.mastState.main=1;d.crewCasualties.able=11;d.crewCasualties.killed=5;
  boat.gunnery.guns[1].dismounted=true;d.dismountedGuns=1;boat.magazine.powderKg=7;d.surrendered=true;
  const saved=JSON.parse(JSON.stringify(vesselDamageSnapshot(boat)));
  const next=ship();
  assert.equal(restoreVesselDamageSnapshot(next,saved),true);
  const r=next.damage;
  assert.equal(r.hullIntegrity,d.hullIntegrity);assert.equal(r.hullDamageJoules,d.hullDamageJoules,'joules are restored, not re-derived');
  assert.equal(r.floodingTonnes,d.floodingTonnes);assert.equal(r.compartments.midPort.waterTonnes,d.compartments.midPort.waterTonnes);
  assert.equal(r.mastIntegrity.main,.4);assert.equal(r.mastState.main,1);
  assert.equal(r.crewCasualties.able,11);assert.equal(r.crewCasualties.killed,5);
  assert.equal(next.gunnery.guns[1].dismounted,true);assert.equal(r.dismountedGuns,1);
  assert.equal(next.magazine.powderKg,7);assert.equal(r.surrendered,true);assert.equal(r.sunk,false);
  const sunkSave=vesselDamageSnapshot(next);sunkSave.sunk=true;
  const third=ship();restoreVesselDamageSnapshot(third,sunkSave);
  assert.equal(third.damage.sunk,true,'a reload cannot resurrect a sinking ship');
});

test('a partial snapshot only changes what it names, and missing input is harmless',()=>{
  const boat=ship();
  assert.equal(restoreVesselDamageSnapshot(boat,null),false);
  assert.equal(restoreVesselDamageSnapshot({},{hullIntegrity:.5}),false);
  assert.equal(repairVessel({},{minHull:1}),null);
  restoreVesselDamageSnapshot(boat,{hullIntegrity:.7,crewCasualties:{able:6}});
  const d=boat.damage;
  assert.equal(d.hullIntegrity,.7);assert.ok(Math.abs(d.hullDamageJoules-d.maxHullEnergy*.3)<1e-6);
  assert.equal(d.crewCasualties.able,6);assert.equal(d.battleMorale,1);assert.equal(d.mastState.fore,0);
  assert.equal(boat.gunnery.guns.filter(g=>g.dismounted).length,0);
  assert.equal(createVesselDamageState(boat),d,'an existing state is kept, not replaced');
});

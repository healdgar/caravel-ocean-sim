// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createShipGunnery,createVesselDamageState,sweepShipSegment,applyShipImpactDamage,sweepBuildingSegment,applyBuildingImpactDamage,sweepTerrainSegment,applyTerrainImpactDamage,createGunnerySolidSweep} from '../js/gunnery-control.js';
import {GUNNERY_ORDER_SECONDS} from '../js/gunnery-audio.js';
import {boatHydrodynamics} from '../js/boat.js';
import {resolveGlobalCoastalRegion,synthesizeCoastalTerrain,placeCoastalPort} from '../js/coastal-world.js';
function fixture(options={}){
 const boat={modelId:'nina',length:20,beam:6,heading:0,x:0,z:0,heave:0,pitch:0,roll:0,propulsion:'sail',surgeVelocity:0};
 boat.hydrodynamics=boatHydrodynamics(20,6);const events=[],orders=[];
 const guns=createShipGunnery(boat,{onEvent:e=>events.push(e),onOrder:id=>orders.push(id),...options});
 boat.gunneryAttendance=new Set(guns.state.guns.map(g=>g.id));return {boat,guns,events,orders};
}
function advance(guns,time){for(let t=0;t<time-1e-8;t+=.05)guns.update(Math.min(.05,time-t),[0,0,0]);}
test('gun drill needs attended stations; full readiness precedes a captain-ordered single discharge',()=>{
 const {boat,guns,events,orders}=fixture();boat.gunneryAttendance.clear();assert.equal(guns.prepare('port'),true);
 advance(guns,40);assert.equal(guns.summary('port').ready,0);assert.equal(guns.fire('port'),false);
 boat.gunneryAttendance=new Set(guns.state.guns.map(g=>g.id));advance(guns,34);
 assert.equal(guns.summary('port').ready,2);assert.equal(events.filter(e=>e.type==='ready').length,1);
 assert.equal(events.filter(e=>e.type==='shot').length,0);assert.equal(guns.fire('port'),true);
 advance(guns,GUNNERY_ORDER_SECONDS['fire-port']-.1);assert.equal(events.filter(e=>e.type==='shot').length,0);
 advance(guns,1);assert.equal(events.filter(e=>e.type==='shot').length,2);assert.deepEqual(orders,['prepare','fire-port']);
 advance(guns,40);assert.equal(events.filter(e=>e.type==='shot').length,2);assert.equal(guns.summary('port').spent,2);
 assert.ok(Number.isFinite(boat.rollVelocity));assert.ok(Math.abs(boat.rollVelocity)>0);
});
test('cease cancels ordered and queued guns without deleting airborne shot',()=>{
 const {guns,events}=fixture();guns.prepare('starboard');advance(guns,34);guns.fire('starboard');guns.cease();advance(guns,4);
 assert.equal(events.filter(e=>e.type==='shot').length,0);assert.equal(guns.summary('starboard').ready,2);
 guns.fire('starboard');advance(guns,GUNNERY_ORDER_SECONDS['fire-starboard']+.04);assert.equal(events.filter(e=>e.type==='shot').length,1);
 const live=guns.state.projectiles.length;guns.cease();advance(guns,.4);assert.equal(events.filter(e=>e.type==='shot').length,1);assert.equal(guns.state.projectiles.length,live);
});
test('selected battery and crew attendance interlock invalid, abandoned and braced firing orders',()=>{
 const {boat,guns,events}=fixture();assert.equal(guns.prepare('nonsense'),false);assert.equal(guns.fire('nonsense'),false);
 guns.prepare('port');advance(guns,34);assert.equal(guns.canFire('port'),true);
 boat.gunneryAttendance.clear();assert.equal(guns.fire('port'),false);
 boat.gunneryAttendance=new Set(guns.state.guns.map(g=>g.id));guns.fire('port');boat.gunneryAttendance.clear();advance(guns,3);
 assert.equal(events.filter(e=>e.type==='shot').length,0);assert.equal(guns.summary('port').ready,2);
 boat.gunneryAttendance=new Set(guns.state.guns.map(g=>g.id));guns.prepare('starboard');advance(guns,34);assert.equal(guns.fire('port'),false);
 assert.equal(guns.prepare('port'),true);boat.gunneryAttendance=new Set(guns.state.guns.map(g=>g.id));
 assert.equal(guns.canFire('port'),true);assert.equal(guns.fire('nonsense'),false);
});
test('standing down releases stations, preserves loaded guns and cancels a pending broadside',()=>{
 const {boat,guns,events}=fixture();guns.prepare('port');advance(guns,34);guns.fire('port');guns.standDown();advance(guns,4);
 assert.equal(boat.gunnerySide,null);assert.equal(guns.summary('port').ready,2);assert.equal(events.filter(e=>e.type==='shot').length,0);
 assert.equal(guns.canFire('port'),false);assert.equal(guns.prepare('port'),true);assert.equal(guns.canFire('port'),true);
 guns.standDown();guns.prepare('starboard');advance(guns,5);guns.standDown();assert.equal(guns.summary('starboard').loading,0);
 guns.prepare('starboard');assert.ok(guns.state.guns.filter(g=>g.side==='starboard').every(g=>g.stage==='swab'&&g.progress===0));
});

test('fresh gunport clearance is required at the order and again at each discharge',()=>{
 let held='Checking sea at gunports';const {guns,events}=fixture({muzzleBlock:()=>held});
 guns.prepare('port');advance(guns,34);assert.equal(guns.summary('port').ready,2);
 assert.equal(guns.fire('port'),false);assert.equal(guns.blockedReason('port'),held);
 held=null;assert.equal(guns.fire('port'),true);held='Gunports awash';advance(guns,3);
 assert.equal(events.filter(e=>e.type==='shot').length,0);assert.equal(guns.summary('port').ready,2);
 assert.equal(guns.state.projectiles.length,0);assert.equal(guns.blockedReason('port'),held);
 held=null;assert.equal(guns.fire('port'),true);advance(guns,3);assert.equal(events.filter(e=>e.type==='shot').length,2);
});

test('adjustable quoin elevation clamps to physical battery limits and increases ballistic range',()=>{
 const runWithElevation=degrees=>{
  const {guns}=fixture();
  const applied=guns.setElevation(degrees);
  guns.prepare('port');advance(guns,34);guns.fire('port');advance(guns,3);
  const shot=guns.state.projectiles[0];
  return {applied,vy:shot.velocity[1],speed:Math.hypot(...shot.velocity)};
 };
 const low=runWithElevation(-2),level=runWithElevation(0),high=runWithElevation(8),clamped=runWithElevation(50);
 assert.equal(low.applied,-2);assert.equal(high.applied,8);assert.equal(clamped.applied,14);
 assert.ok(high.vy>level.vy&&level.vy>low.vy,'quoin elevation directly controls vertical launch velocity');
});

test('cannonballs strike other ships in hull and rigging zones, imparting 6-DOF impulse, flooding and sail damage',()=>{
 const source={modelId:'nina',length:20,beam:6,heading:0,x:0,z:0,heave:0,pitch:0,roll:0};
 const target={id:'escort-1',modelId:'nina',model:{name:'La Niña',rig:{sails:[{controlGroup:'fore'},{controlGroup:'main'},{controlGroup:'mizzen'}]}},
  length:20,beam:6,heading:0,x:-35,z:0,heave:0,pitch:0,roll:0,showProw:true,
  sailFore:1,sailMain:1,sailMizzen:1,cargoTonnes:0,revision:0};
 target.hydrodynamics=boatHydrodynamics(20,6);
 createVesselDamageState(target);

 // 1. Waterline hull hit from port broadside (-X direction)
 const hullHit=sweepShipSegment([-10,0.4,0],[-50,0.4,0],0.08,target,source);
 assert.ok(hullHit,'swept segment intersects target hull');
 assert.equal(hullHit.kind,'ship');
 assert.equal(hullHit.hitZone,'hull');
 assert.equal(hullHit.waterline,true);
 assert.ok(hullHit.fraction>0.4&&hullHit.fraction<0.7);

 const hullReport=applyShipImpactDamage(target,{...hullHit,position:[-32,0.4,0],surfacePosition:[-32,0.4,0],velocity:[-320,-4,0],mass:5.4,energy:0.5*5.4*320*320});
 assert.equal(hullReport.kind,'ship');
 assert.equal(hullReport.hitZone,'hull');
 assert.ok(hullReport.hullIntegrity<1&&hullReport.hullIntegrity>0.7);
 assert.equal(hullReport.breaches,1);
 assert.ok(hullReport.floodingTonnes>0,'waterline penetration causes flooding');
 assert.ok(target.cargoTonnes>0,'flooding increases vessel load');
 assert.ok(Math.abs(target.leewayVelocity)>0,'impact transfers lateral momentum to struck hull');
 assert.ok(Math.abs(target.rollVelocity)>0,'off-centre hull strike imparts roll impulse');

 // 2. Upper rigging/mast hit reduces mast integrity and caps deployed canvas
 const rigHit=sweepShipSegment([-10,9.5,0],[-50,9.5,0],0.08,target,source);
 assert.ok(rigHit,'swept segment intersects mainmast rigging envelope');
 assert.equal(rigHit.hitZone,'rigging');
 assert.equal(rigHit.mastGroup,'main');
 const rigReport=applyShipImpactDamage(target,{...rigHit,position:[-35,9.5,0],surfacePosition:[-35,9.5,0],velocity:[-300,0,0],mass:14.5,energy:0.5*14.5*300*300});
 assert.equal(rigReport.hitZone,'rigging');
 assert.ok(rigReport.rigIntegrity<1);
 assert.ok(target.sailMain<1,'damaged mainmast rigging reduces deployed main canvas');
});

test('cannonballs strike 16th-century port buildings and coastal land, recording structural damage and craters',()=>{
 const region=resolveGlobalCoastalRegion({id:'cartagena',name:'Cartagena',latitude:10.423,longitude:-75.548,size:65,biomeSize:64,albedoSize:64});
 const heights=synthesizeCoastalTerrain(region);
 const port=placeCoastalPort(region,heights);
 const bastion=port.instances.find(i=>i.prefabId==='stone_sea_bastion');
 const shed=port.instances.find(i=>i.prefabId==='careening_shed')??port.instances.find(i=>i.prefabId==='timber_mole_pier');
 assert.ok(bastion&&shed);

 // Building OBB sweep & damage comparison (masonry bastion vs timber structure)
 const bFrom=[bastion.x,bastion.baseY+bastion.height*0.5,bastion.z+40];
 const bTo=[bastion.x,bastion.baseY+bastion.height*0.5,bastion.z-40];
 const bHit=sweepBuildingSegment(bFrom,bTo,0.08,port);
 assert.ok(bHit,'cannonball intersects port building OBB');
 assert.equal(bHit.kind,'building');
 const shotEnergy=0.5*14.5*420*420;
 const bastionRep=applyBuildingImpactDamage(bastion,{velocity:[0,0,-420],mass:14.5,energy:shotEnergy});
 const shedRep=applyBuildingImpactDamage(shed,{velocity:[0,0,-420],mass:14.5,energy:shotEnergy});
 assert.ok(bastionRep.integrity>shedRep.integrity,'coral-limestone sea bastion resists roundshot better than timber structure');

 // Terrain sweep & crater recording
 const fakeTerrain={
  port,
  height:(x,z)=>z<-100?25:-20,
  groundSample:(x,z)=>z<-100?25:-20,
 };
 assert.equal(sweepTerrainSegment([0,5,0],[0,5,-50],0.08,fakeTerrain),null,'submerged seabed does not block airborne shot');
 const landHit=sweepTerrainSegment([0,12,-80],[0,12,-130],0.08,fakeTerrain);
 assert.ok(landHit,'cannonball strikes rising coastal bluff');
 assert.equal(landHit.kind,'terrain');
 assert.ok(landHit.fraction>0.35&&landHit.fraction<0.45);
 const landRep=applyTerrainImpactDamage(fakeTerrain,{...landHit,surfacePosition:[0,12,-100],velocity:[0,-10,-350],mass:5.4,energy:0.5*5.4*350*350});
 assert.equal(landRep.kind,'terrain');
 assert.equal(landRep.craterCount,1);
 assert.ok(landRep.craterRadius>0.2);

 // End-to-end broadside fire into target ship via createShipGunnery
 const escort={id:'escort-1',modelId:'nina',model:{name:'Escort Caravel',rig:{sails:[]}},length:20,beam:6,heading:0,x:-28,z:0,heave:0,pitch:0,roll:0,showProw:true};
 escort.hydrodynamics=boatHydrodynamics(20,6);
 const {guns,events}=fixture({getVessels:()=>[escort],getTerrain:()=>fakeTerrain});
 guns.prepare('port');advance(guns,34);guns.fire('port');advance(guns,3.5);
 const shipImpacts=events.filter(e=>e.type==='impact'&&e.kind==='ship');
 assert.equal(shipImpacts.length,2,'both port guns strike the escort hull');
 assert.ok(guns.lastDamageReport&&guns.lastDamageReport.kind==='ship');
 assert.ok(escort.damage.hullIntegrity<1);
 assert.equal(guns.state.projectiles.length,0,'solid hits remove projectiles before sea splash');
});

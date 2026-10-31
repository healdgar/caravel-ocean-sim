// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createShipGunnery,createPortGunnery,createVesselDamageState,sweepShipSegment,applyShipImpactDamage,sweepBuildingSegment,applyBuildingImpactDamage,sweepScenerySegment,applySceneryImpactDamage,sweepTerrainSegment,applyTerrainImpactDamage,createGunnerySolidSweep,resolveVesselCollisions,applyShipCollisionDamage,classifyGroundingSubstrate,applyGroundingImpactDamage,stepVesselDamage,computeCrewEfficiency} from '../js/gunnery-control.js';
import {constrainIslandMotion} from '../js/terrain-model.js';
import {GUNNERY_ORDER_SECONDS} from '../js/gunnery-audio.js';
import {boatHydrodynamics} from '../js/boat.js';
import {createFollower,steerFollower,stepVesselCombatAI} from '../js/follower.js';
import {createCompany,stepCompany} from '../js/crew.js';
import {SHIP_COLORS,setVesselColors,strikeVesselColors,buildShipColorsGeometry} from '../js/ship-colors.js';
import {advanceSails} from '../js/sailing.js';
import {resolveGlobalCoastalRegion,synthesizeCoastalTerrain,placeCoastalPort,buildPortPrefabGeometry,generateProceduralCoastalPack} from '../js/coastal-world.js';
import {bakeBuildingImpactDeformations} from '../js/part-assembly.js';
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

test('captain holds fire while steady on the roll and orders give-fire as the hull rolls through the optimal angle with ripple scatter',()=>{
 const {boat,guns,events}=fixture();
 guns.setElevation(2);
 guns.prepare('port');
 advance(guns,34);
 assert.equal(guns.summary('port').ready,2);
 // Simulate a 6-second ocean wave roll of +/- 6 degrees (port rail dips when boat.roll > 0).
 // At t = 2.1s (just after the spoken order), boat.roll is +5.8 deg (port rail dipped -5.8 deg into the trough).
 const omega=2*Math.PI/6,amp=6*Math.PI/180,phase=-0.9;
 let simTime=0;
 const stepRolling=duration=>{
  for(let t=0;t<duration-1e-8;t+=0.02){
   const dt=Math.min(0.02,duration-t);
   simTime+=dt;
   boat.roll=amp*Math.sin(omega*simTime+phase);
   boat.rollVelocity=amp*omega*Math.cos(omega*simTime+phase);
   guns.update(dt,[0,0,0]);
  }
 };
 assert.equal(guns.fire('port'),true);
 assert.equal(guns.orderStage,'laying');
 stepRolling(GUNNERY_ORDER_SECONDS['fire-port']+0.1);
 // At t ~ 2.2s, port side is rolled down ~5.7 deg in the trough: must hold steady and NOT fire into the water!
 assert.equal(guns.orderStage,'steady');
 assert.equal(events.filter(e=>e.type==='shot').length,0,'guns hold fire while hull is rolled into the wave trough');
 stepRolling(3.0);
 const giveFireEvents=events.filter(e=>e.type==='give-fire');
 const shotEvents=events.filter(e=>e.type==='shot');
 assert.equal(giveFireEvents.length,1,'captain shouts give-fire once as hull approaches optimal roll angle');
 assert.equal(shotEvents.length,2,'both guns discharge on the uproll');
 // Verify shots fired near the target elevation (with natural scatter between gun 0 and gun 1 as the hull continued rolling)
 const pitch0=Math.asin(shotEvents[0].direction[1])*180/Math.PI;
 const pitch1=Math.asin(shotEvents[1].direction[1])*180/Math.PI;
 assert.ok(Math.abs(pitch0-pitch1)>0.08,'staggered broadside shots exhibit natural vertical scatter as the boat rolls');
 assert.ok(pitch0>1.5&&pitch0<6.5&&pitch1>1.5&&pitch1<6.5,'both shots fire within the optimal uproll elevation window instead of into the trough');
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
 assert.ok(target.hydrodynamics.sinkage>0,'waterline breach immediately updates hull hydrostatics sinkage');
 const sinkage40=boatHydrodynamics(20,6,30,40).sinkage;
 const sinkage70=boatHydrodynamics(20,6,30,70).sinkage;
 assert.ok(sinkage70>sinkage40,'flooding above 40 tonnes continues submerging hull beyond normal merchant cargo limit');
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
 const followerState=createFollower();
 steerFollower(followerState,target,source,0.1,12,Math.PI*0.5);
 assert.ok(target.sailMain<=target.damage.mastIntegrity.main+1e-6,'follower helm preserves rigging damage cap on damaged mast');
 advanceSails(target,10,12,Math.PI*0.5);
 assert.ok(target.sailState.set[1]<=target.damage.mastIntegrity.main+1e-6,'advanceSails caps deployed sail state to mast integrity');
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

test('readyAtQuarters and manGunStationsImmediate prepare two HMS Victories for immediate broadside fire',async()=>{
 const {manGunStationsImmediate}=await import('../js/crew-work.js');
 const {getShipModel}=await import('../js/ship-models.js');
 const {createCompany,stepCompany}=await import('../js/crew.js');
 const vModel=getShipModel('victory');
 const lead={id:'player',modelId:'victory',model:vModel,length:vModel.runtime.length,beam:vModel.runtime.beam,heading:0,x:0,z:0,heave:0,pitch:0,roll:0,showProw:true};
 lead.hydrodynamics=boatHydrodynamics(lead.length,lead.beam,30,0,'victory');
 const target={id:'escort-1',modelId:'victory',model:vModel,length:vModel.runtime.length,beam:vModel.runtime.beam,heading:0,x:lead.length*1.22,z:0,heave:0,pitch:0,roll:0,showProw:true};
 target.hydrodynamics=boatHydrodynamics(target.length,target.beam,30,0,'victory');
 const company=createCompany(undefined,'victory');
 const events=[];
 const guns=createShipGunnery(lead,{getVessels:()=>[target],onEvent:e=>events.push(e)});
 assert.equal(guns.readyAtQuarters('starboard'),true);
 assert.equal(manGunStationsImmediate(company,lead),true);
 assert.equal(guns.summary('starboard').ready,52,'all 52 starboard guns are ready at quarters');
 assert.equal(guns.canFire('starboard'),true,'starboard broadside can fire immediately on frame 0');
 assert.equal(guns.fire('starboard'),true);
 for(let i=0;i<360;i++){
  stepCompany(company,lead,1/60,6);
  guns.update(1/60,[4,0,0]);
 }
 const shipHits=events.filter(e=>e.type==='impact'&&e.kind==='ship');
 assert.ok(shipHits.length>=40,`expected most of the 52-gun broadside to strike the abeam Victory, got ${shipHits.length}`);
 assert.ok(target.damage.hullIntegrity<1);
});

test('fireLoaded fires the 48 ready guns while weather-deck guns finish loading, fireAtWill auto-cycles, and fullWatch populates 24 Victory deckhands',async()=>{
 const {getShipModel}=await import('../js/ship-models.js');
 const {createCompany,stepCompany}=await import('../js/crew.js');
 const vModel=getShipModel('victory');
 const boat={id:'player',modelId:'victory',model:vModel,length:vModel.runtime.length,beam:vModel.runtime.beam,heading:0,x:0,z:0,heave:0,pitch:0,roll:0,showProw:true,sailFore:1,sailMain:1,sailMizzen:1};
 boat.hydrodynamics=boatHydrodynamics(boat.length,boat.beam,30,0,'victory');
 const company=createCompany(undefined,'victory',{fullWatch:true});
 assert.equal(company.crew.length,24,'fullWatch populates 24 visible hands across Victory weather decks');
 const events=[];
 const guns=createShipGunnery(boat,{onEvent:e=>events.push(e)});
 stepCompany(company,boat,0,6);
 assert.equal(guns.prepare('port'),true);
 for(let i=0;i<335;i++){
  stepCompany(company,boat,0.1,6);
  guns.update(0.1,[0,0,0]);
 }
 const partial=guns.summary('port');
 assert.ok(partial.ready>=48,'at least 48 guns are ready after 33.5s');
 assert.equal(guns.canFireLoaded('port'),true,'canFireLoaded is true when 48 of 52 guns are ready');
 if(partial.ready<partial.total){
  assert.equal(guns.fireLoaded('port'),true,'fireLoaded fires the ready guns without waiting for all 52');
  for(let i=0;i<120;i++){
   stepCompany(company,boat,0.1,6);
   guns.update(0.1,[0,0,0]);
  }
  const shotsFired=events.filter(e=>e.type==='shot').length;
  assert.equal(shotsFired,partial.ready,'all 48 ready guns discharged');
 }
 assert.equal(guns.setFireAtWill(true,'port'),true);
 assert.equal(guns.fireAtWill,true);
 for(let i=0;i<150;i++){
  stepCompany(company,boat,0.1,6);
  guns.update(0.1,[0,0,0]);
 }
 assert.ok(events.filter(e=>e.type==='shot').length>=52,'remaining weather-deck guns finish loading without stalling and fire under fireAtWill');
 guns.cease();
 assert.equal(guns.fireAtWill,false,'cease disables fireAtWill');
});

test('3D aerial aiming trajectory arcs predict range, respond to quoin elevation, and detect ship hull vs rigging impacts',async()=>{
 const {getShipModel}=await import('../js/ship-models.js');
 const vModel=getShipModel('victory');
 const player={id:'player',modelId:'victory',model:vModel,length:vModel.runtime.length,beam:vModel.runtime.beam,heading:0,x:0,z:0,heave:0,pitch:0,roll:0.03,showProw:true};
 player.hydrodynamics=boatHydrodynamics(player.length,player.beam,30,0,'victory');
 const enemy={id:'enemy-1',modelId:'victory',model:vModel,length:vModel.runtime.length,beam:vModel.runtime.beam,heading:0,x:-140,z:0,heave:0,pitch:0,roll:0,showProw:true};
 enemy.hydrodynamics=boatHydrodynamics(enemy.length,enemy.beam,30,0,'victory');
 const vessels=[{id:'player',boat:player},{id:'enemy-1',boat:enemy}];
 const guns=createShipGunnery(player,{getVessels:()=>vessels});
 guns.prepare('port');
 guns.setElevation(0);
 const hullArcs=guns.computeAimTrajectories({wind:[0,0,0]});
 assert.ok(hullArcs.length>10,'produces 3D ribbon segments and impact rings');
 assert.equal(guns.aimSummary.side,'port');
 assert.equal(guns.aimSummary.hitKind,'ship');
 assert.equal(guns.aimSummary.hitZone,'hull','0° quoin at 140m strikes enemy hull');
 guns.setElevation(7.5);
 const rigArcs=guns.computeAimTrajectories({wind:[0,0,0]});
 assert.ok(rigArcs.length>10);
 assert.equal(guns.aimSummary.hitKind,'ship');
 assert.equal(guns.aimSummary.hitZone,'rigging','+7.5° quoin at 140m strikes enemy rigging/sails');
 guns.setShowTrajectory(false);
 assert.deepEqual(guns.computeAimTrajectories({wind:[0,0,0]}),[]);
 assert.equal(guns.aimSummary,null);

 // Swivel rail guns on La Nina swivel ±45° fore/aft and train onto off-beam targets
 const ninaModel=getShipModel('nina');
 const nina={id:'nina-1',modelId:'nina',model:ninaModel,length:20,beam:6,heading:0,x:0,z:0,heave:0,pitch:0,roll:0,showProw:true};
 nina.hydrodynamics=boatHydrodynamics(20,6);
 const offBeamTarget={id:'target-1',modelId:'nina',model:ninaModel,length:20,beam:6,heading:0,x:-40,z:-28,heave:0,pitch:0,roll:0,showProw:true};
 offBeamTarget.hydrodynamics=boatHydrodynamics(20,6);
 const ninaGuns=createShipGunnery(nina,{getVessels:()=>[{boat:nina},{boat:offBeamTarget}]});
 assert.equal(ninaGuns.isSwivelBattery,true);
 assert.deepEqual(ninaGuns.traverseRange,{min:-45,max:45});
 assert.equal(ninaGuns.setTraverse(60),45,'swivel traverse clamps to ±45°');
 ninaGuns.prepare('port');
 const trained=ninaGuns.trainOnTarget('port');
 assert.ok(trained&&trained.traverse>25&&trained.traverse<=45,`expected swivel gun to train ~35° forward onto off-beam target, got ${trained?.traverse}`);
 const swivelArcs=ninaGuns.computeAimTrajectories({wind:[0,0,0]});
 assert.ok(swivelArcs.length>=4);
 assert.equal(ninaGuns.aimSummary.hitKind,'ship','swiveled trajectory strikes the off-beam target vessel');
});

test('shore structure foundation scarps, rotated building OBBs, and coastal palms/trees intersect cannonfire and deform 3D meshes',()=>{
 const region=resolveGlobalCoastalRegion({id:'cartagena',name:'Cartagena',latitude:10.423,longitude:-75.548,size:65,biomeSize:64,albedoSize:64});
 const heights=synthesizeCoastalTerrain(region);
 const port=placeCoastalPort(region,heights);
 const bastion=port.instances.find(i=>i.prefabId==='stone_sea_bastion')??port.instances[0];
 const samplePalms=new Float32Array([
  bastion.x+28,2.2,bastion.z+12,3.4,9.5,0.4,0.02,-0.02,
  bastion.x+36,2.5,bastion.z+18,3.2,8.8,0.6,0.01,-0.01,
 ]);
 const portGeo=buildPortPrefabGeometry(port,samplePalms);
 assert.ok(port.palms instanceof Float32Array&&port.palms.length>=8,'port exposes 3D coastal palms for gunnery sweeps');

 // 1. Low horizontal cannon shot (y = 2.0 m) against a sea bastion (baseY = 4.6 m, foundationDepth = 4.5 m)
 const lowShotY=Math.max(1.2,(bastion.baseY??bastion.y??4.6)-2.4);
 const hitScarp=sweepBuildingSegment([bastion.x-35,lowShotY,bastion.z],[bastion.x+35,lowShotY,bastion.z],0.08,port);
 assert.ok(hitScarp,'low horizontal broadside intersects bastion stone scarp below baseY');
 assert.equal(hitScarp.building,bastion);

 // 2. Rotated building OBB alignment with buildPortPrefabGeometry toWorld convention
 const rotInst={
  id:'rot-warehouse',
  prefabId:'customs_aduana_warehouse',
  x:200,
  y:2.0,
  baseY:2.0,
  z:300,
  yaw:Math.PI/3,
  width:24,
  depth:10,
  height:7,
  foundationDepth:3.5,
 };
 const cosY=Math.cos(rotInst.yaw),sinY=Math.sin(rotInst.yaw);
 // Point at local (+10, 3.0, 0) in coastal-world toWorld coordinates:
 const tipWx=rotInst.x+10*cosY;
 const tipWz=rotInst.z-10*sinY;
 const rotHit=sweepBuildingSegment([tipWx-6*sinY,5.0,tipWz-6*cosY],[tipWx+6*sinY,5.0,tipWz+6*cosY],0.08,{instances:[rotInst]});
 assert.ok(rotHit,'rotated building OBB intersects at its exact rotated world extremity');

 // 3. Subdivided port mesh deformation & normal-magnitude structural damage encoding
 const bReport=applyBuildingImpactDamage(bastion,{
  position:[bastion.x,bastion.baseY+2.5,bastion.z-(bastion.depth??16)*0.5],
  surfacePosition:[bastion.x,bastion.baseY+2.5,bastion.z-(bastion.depth??16)*0.5],
  localPosition:[0,2.5,-(bastion.depth??16)*0.5],
  normal:[0,0,-1],
  velocity:[0,0,280],
  mass:10.9,
  ammo:'round',
 });
 assert.ok(bReport&&bastion.damageState.pendingBakes.length>0);
 const vertsCopy=new Float32Array(portGeo.vertices);
 const dirty=bakeBuildingImpactDeformations(vertsCopy,bastion.damageState.pendingBakes.splice(0),8);
 assert.ok(dirty&&dirty.byteLength>0,'mid-wall cannonball hit deforms subdivided building vertices');
 let maxNormalLen=1.0;
 for(let i=0;i<vertsCopy.length;i+=8){
  const nLen=Math.hypot(vertsCopy[i+3],vertsCopy[i+4],vertsCopy[i+5]);
  if(nLen>maxNormalLen)maxNormalLen=nLen;
 }
 assert.ok(maxNormalLen>1.15,`expected structural damage encoded into normal length > 1.15, got ${maxNormalLen}`);

 // 4. Scenery sweep against coastal 3D palms and procedural trees
 const px=port.palms[0],py=port.palms[1],pz=port.palms[2];
 const terrainMock={
  ports:[port],
  height:()=>1.8,
  treeData:new Float32Array([50,2.0,50,1.2,0,1,0,0]),
 };
 const palmHit=sweepScenerySegment([px-8,py+3.5,pz],[px+8,py+3.5,pz],0.08,terrainMock);
 assert.ok(palmHit&&palmHit.kind==='scenery'&&palmHit.sceneryType==='palm','cannonball intersects coastal 3D palm trunk/crown');
 const sReport=applySceneryImpactDamage(terrainMock,{
  ...palmHit,
  position:[px,py+3.5,pz],
  velocity:[240,0,0],
  mass:5.4,
  ammo:'hot',
 });
 assert.equal(sReport.kind,'scenery');
 assert.ok(port.sceneryBakes?.length>0,'palm impact queues 3D scenery-tree deformation bake');
 assert.ok(port.sceneryFires?.length>0,'hot shot on palm ignites coastal scenery fire');
 const palmDirty=bakeBuildingImpactDeformations(vertsCopy,port.sceneryBakes.splice(0),8);
 assert.ok(palmDirty&&palmDirty.byteLength>0,'palm impact bends and chars 3D palm vertices in portMesh');
});

test('ship-to-ship collision detection prevents vessels from sailing through each other, applies 6-DOF rebound impulse, and inflicts hull/bowsprit/flooding damage',()=>{
 const boatA={
  id:'ship-a',
  modelId:'nina',
  length:20,
  beam:6,
  heading:90, // facing +X (East)
  x:-4.5,
  z:0,
  heave:0,
  pitch:0,
  roll:0,
  propulsion:'sail',
  surgeVelocity:4.8,
  leewayVelocity:0,
  yawRate:0,
  showProw:true,
 };
 boatA.hydrodynamics=boatHydrodynamics(20,6);

 const boatB={
  id:'ship-b',
  modelId:'nina',
  length:20,
  beam:6,
  heading:0, // facing -Z (North), broadside presented to boatA's bow
  x:0,
  z:0,
  heave:0,
  pitch:0,
  roll:0,
  propulsion:'sail',
  surgeVelocity:0.5,
  leewayVelocity:0,
  yawRate:0,
  showProw:true,
 };
 boatB.hydrodynamics=boatHydrodynamics(20,6);

 const vessels=[{id:'ship-a',boat:boatA},{id:'ship-b',boat:boatB}];
 const collisionCallbacks=[];
 const events=resolveVesselCollisions(vessels,1/60,{
  onCollision:ev=>collisionCallbacks.push(ev),
 });

 assert.equal(events.length,1,'detects T-bone ramming collision between boatA bow and boatB port beam');
 assert.equal(collisionCallbacks.length,1);
 assert.ok(boatA.x<-4.5,'depenetrates ramming boatA backward along contact normal');
 assert.ok(boatB.x>0,'depenetrates struck boatB laterally away from ramming bow');
 assert.ok(boatA.surgeVelocity<4.8,'ramming vessel loses forward surge velocity upon impact');
 assert.ok(boatB.leewayVelocity>0.2,'rammed vessel receives lateral leeway velocity impulse');
 assert.ok(Math.abs(boatB.rollVelocity)>0,'above-waterline collision impulse heels/rolls the struck vessel');

 // Structural damage verification on both colliding ships
 assert.ok(boatA.damage&&boatA.damage.hullIntegrity<1,'ramming vessel takes stem/hull damage');
 assert.ok(boatA.damage.rigIntegrity<1,'ramming vessel takes bowsprit/fore-rigging shock damage');
 assert.ok(boatA.damage.pendingBakes.length>0,'ramming vessel queues 3D hull deformation bake');

 assert.ok(boatB.damage&&boatB.damage.hullIntegrity<1,'rammed vessel takes beam hull planking damage');
 assert.ok(boatB.damage.waterlineBreaches>=1,'vessel rammed amidships at 4.8 m/s suffers a waterline breach');
 assert.ok(boatB.damage.breachArea>0,'rammed vessel has positive flooding breach area');
 assert.ok(boatB.damage.pendingBakes.length>0,'rammed vessel queues 3D hull crater deformation bake');
});

test('impact with shoals, reef, stone, and sand models substrate-scaled hull damage, allowing gentle beaching on sand while wrecking vessels on river/coastal rocks and reefs',()=>{
 // 1. Substrate classification across sand beach, shoal bar, coral reef, and river/headland stone
 const sandSub=classifyGroundingSubstrate(
  (x,z)=>z*0.02, // gentle 0.02 slope foreshore
  0,-25,
  {id:'cartagena',coastalClass:'barrier-lagoon'},
  {beaches:[{x:0,z:-20,length:80}]}
 );
 assert.equal(sandSub.substrate,'sand','gentle beach foreshore classifies as sand');

 const shoalSub=classifyGroundingSubstrate(
  (x,z)=>-1.1+(x*0.015), // flat shallow river/harbor bar
  0,0,
  {id:'london',coastalClass:'river-port'}
 );
 assert.equal(shoalSub.substrate,'shoal','shallow river/harbor bar classifies as shoal');

 const reefSub=classifyGroundingSubstrate(
  (x,z)=>-1.2+Math.sin(x*0.6)*0.75+Math.cos(z*0.6)*0.75, // rough submerged coral ledge
  1.2,0.8,
  {id:'nassau',coastalClass:'coral-archipelago',reefBarrier:true}
 );
 assert.equal(reefSub.substrate,'reef','submerged jagged coral ledge classifies as reef');

 const stoneSub=classifyGroundingSubstrate(
  (x,z)=>z*0.42, // steep rocky gorge / headland scarp
  0,-2.5,
  {id:'quebec',coastalClass:'river-gorge',hasRiver:true}
 );
 assert.equal(stoneSub.substrate,'stone','steep river gorge / rocky headland classifies as stone');

 // 2. Gentle beaching on sand (< 1.05 m/s) causes zero hull damage or breaches
 const sandBoat={
  id:'sand-boat',
  modelId:'nina',
  length:20,
  beam:6,
  draft:1.9,
  heading:0,
  x:0,
  z:-18,
  heave:0,
  pitch:0,
  roll:0,
  propulsion:'sail',
  surgeVelocity:0.75,
 };
 sandBoat.hydrodynamics=boatHydrodynamics(20,6);
 const gentleSandSample=(x,z)=>-1.2+(z+18)*-0.02; // gentle sandy shoaling toward -Z
 constrainIslandMotion(null,sandBoat,0,-17.8,gentleSandSample,{id:'cartagena',coastalClass:'barrier-lagoon'},{
  beaches:[{x:0,z:-20,length:100}],
 });
 assert.equal(sandBoat.aground,true,'vessel grounds on shallow sandy foreshore');
 assert.equal(sandBoat.groundingContact?.substrate,'sand');
 assert.equal(sandBoat.damage?.hits??0,0,'gentle beaching on sand below 1.05 m/s inflicts zero hull damage');
 assert.equal(sandBoat.damage?.waterlineBreaches??0,0,'gentle beaching on sand opens no underwater breaches');

 // 3. River gorge / coastal rock strike at navigation speed inflicts heavy keel/garboard/stem damage,
 //    underwater breaches, 3D lower-hull craters, and progressive wave/current pounding until wrecked on the rocks
 const rockBoat={
  id:'rock-boat',
  modelId:'nina',
  length:20,
  beam:6,
  draft:1.9,
  heading:0, // sailing North (-Z) up a narrow rocky river gorge
  x:0,
  z:0,
  heave:0,
  pitch:0,
  roll:0,
  propulsion:'sail',
  surgeVelocity:4.4, // ~8.5 knots approach/river current speed
 };
 rockBoat.hydrodynamics=boatHydrodynamics(20,6);
 const groundingEvents=[];
 // Steep rocky river ledge rising sharply ahead at z < -4
 const riverRockSample=(x,z)=>z<-3.5?-0.45+(-3.5-z)*0.48:-8.0;
 const grounded=constrainIslandMotion(
  null,
  rockBoat,
  0,
  0.8,
  riverRockSample,
  {id:'quebec',coastalClass:'river-gorge',hasRiver:true},
  {onGrounding:(b,contact,report)=>groundingEvents.push({contact,report})}
 );
 assert.equal(grounded,true,'vessel is arrested by submerged river gorge rocks');
 assert.equal(rockBoat.aground,true,'vessel is marked aground on the rocks');
 assert.equal(rockBoat.groundingContact?.substrate,'stone','contact substrate is classified as stone');
 assert.equal(groundingEvents.length,1,'fires onGrounding callback with contact and damage report');
 assert.ok(rockBoat.damage&&rockBoat.damage.hullIntegrity<0.95,'rock strike inflicts immediate structural hull damage');
 assert.ok((rockBoat.damage.partDamage['keel.main']??0)>0 || (rockBoat.damage.partDamage['hull.stem']??0)>0,'damages keel or forefoot stem timbers');
 assert.ok(rockBoat.damage.waterlineBreaches>=1 && rockBoat.damage.breachArea>0,'jagged rock impact rips an underwater hull breach');
 assert.ok(rockBoat.damage.pendingBakes.length>0,'queues 3D lower-hull stove-in crater deformation bake');

 // 4. Continuous wave/current pounding while stranded on the rocks batters and floods the vessel into a wreck on the rocks
 const rockTerrain={height:riverRockSample,region:{id:'quebec',coastalClass:'river-gorge',hasRiver:true}};
 for(let step=0;step<180;step++){
  stepVesselDamage(rockBoat,0.5,rockTerrain);
  if(rockBoat.damage.sunk&&rockBoat.damage.settledWreck)break;
 }
 assert.equal(rockBoat.damage.sunk,true,'vessel stranded on breached river/coastal rocks floods and founders');
 assert.equal(rockBoat.damage.wreckedOnRocks,true,'vessel is marked wreckedOnRocks');
 assert.ok(rockBoat.damage.maxSinkDepth<=2.5,'vessel wrecked on shallow rocks settles onto the ledge rather than sinking into deep abyss');
});

test('town fortifications (bastion, star fortress, watchtower, curtain wall & gate) are staffed with garrison soldiers who patrol ramparts and man embrasures',()=>{
 const pack=generateProceduralCoastalPack('cartagena',{size:65,biomeSize:64,albedoSize:64,vegetationCandidates:120});
 const pg=createPortGunnery(pack.port);
 assert.ok(pg.garrison&&pg.soldiers.length>=36,`expected at least 36 fortification soldiers, got ${pg.soldiers.length}`);
 const byPrefab=new Set(pg.soldiers.map(s=>s.buildingPrefabId));
 for(const prefabId of ['stone_sea_bastion','bastion_trace_fortress','torreon_atalaya_farol','curtain_wall_and_gate']){
  assert.ok(byPrefab.has(prefabId),`expected garrison soldiers on ${prefabId}`);
  const unit=pg.soldiers.filter(s=>s.buildingPrefabId===prefabId);
  assert.ok(unit.length>=4,`${prefabId} has ${unit.length} soldiers`);
  for(let i=0;i<unit.length;i++){
   const s=unit[i];
   assert.ok(s.position.every(Number.isFinite)&&s.transform.every(Number.isFinite));
   assert.ok(Math.abs(s.position[1]-(s.ly+0.028))<1e-4,`${s.id} grounded at fortification deck elevation`);
   for(let j=i+1;j<unit.length;j++){
    const d=Math.hypot(s.position[0]-unit[j].position[0],s.position[1]-unit[j].position[1],s.position[2]-unit[j].position[2]);
    assert.ok(d>=0.65,`${s.id} and ${unit[j].id} maintain garrison separation (${d.toFixed(2)}m)`);
   }
  }
 }
 // Step port gunnery & garrison so rampart sentries walk their patrol routes
 const initialPositions=pg.soldiers.map(s=>Array.from(s.position));
 for(let step=0;step<60;step++)pg.update(0.1,[4,0,0]);
 const patrolled=pg.soldiers.filter((s,i)=>Math.hypot(s.position[0]-initialPositions[i][0],s.position[2]-initialPositions[i][2])>0.25);
 assert.ok(patrolled.length>=12,`expected rampart/bastion sentries to patrol along walls, got ${patrolled.length} moving`);
});

test('ship colors, human crew casualties, battle morale, and surrender signalling work across gunnery and AI',()=>{
 // 1. Historical ship colors & 3D crow's nest + ensign geometry
 assert.ok(SHIP_COLORS.portugal && SHIP_COLORS.castile && SHIP_COLORS.france && SHIP_COLORS['jolly-roger'] && SHIP_COLORS.surrender);
 const geom=buildShipColorsGeometry();
 assert.ok(geom instanceof Float32Array && geom.length>=1000,'builds 3D crow’s nest basket, flagstaff, stern ensign and masthead pennant vertices');

 // 2. Grape shot inflicts heavier human casualties than solid round shot and marks 3D crew actors wounded/fallen
 const makeTarget=()=>{
  const b={id:'enemy-corsair',modelId:'nina',length:20,beam:6,heading:0,x:80,z:0,heave:0,pitch:0,roll:0,propulsion:'sail',colors:'jolly-roger'};
  b.hydrodynamics=boatHydrodynamics(20,6);
  createVesselDamageState(b);
  const comp=createCompany(undefined,'nina',{fullWatch:true});
  stepCompany(comp,b,0.05,8);
  return {boat:b,company:comp};
 };
 const roundTarget=makeTarget();
 const grapeTarget=makeTarget();
 const roundReport=applyShipImpactDamage(roundTarget.boat,{
  ammo:'round',energy:140000,hitZone:'hull',surfacePosition:[80,1.2,0],localPosition:[1.2,1.2,0],designPosition:[0.8,1.1,0],velocity:[-120,0,0],mass:5.4,
 });
 const grapeReport=applyShipImpactDamage(grapeTarget.boat,{
  ammo:'grape',energy:140000,hitZone:'hull',surfacePosition:[80,1.2,0],localPosition:[1.2,1.2,0],designPosition:[0.8,1.1,0],velocity:[-120,0,0],mass:5.4,
 });
 const roundCas=roundReport.casualtiesKilled+roundReport.casualtiesWounded;
 const grapeCas=grapeReport.casualtiesKilled+grapeReport.casualtiesWounded;
 assert.ok(grapeCas>roundCas,`grape shot (${grapeCas}) inflicts more human casualties than round shot (${roundCas})`);
 assert.ok(grapeTarget.boat.damage.battleMorale<roundTarget.boat.damage.battleMorale,'grape shot inflicts greater battle morale loss');
 const affectedActors=grapeTarget.company.crew.filter(s=>s.casualtyState==='wounded'||s.casualtyState==='fallen');
 assert.ok(affectedActors.length>=1,'visible 3D deck crew actors near impact are marked wounded or fallen');
 assert.ok(computeCrewEfficiency(grapeTarget.boat)<1.0,'crew casualties and lowered morale reduce gunnery reload efficiency');

 // 3. Repeated broadsides break enemy battle morale and automatically trigger surrender (striking colors to white flag)
 let surrenderNotified=false;
 grapeTarget.boat.onSurrender=()=>{surrenderNotified=true;};
 for(let salvo=0;salvo<6&&!grapeTarget.boat.damage.surrendered;salvo++){
  applyShipImpactDamage(grapeTarget.boat,{
   ammo:'grape',energy:180000,hitZone:'hull',surfacePosition:[80,1.2,0],localPosition:[1.2,1.2,0],designPosition:[0.8,1.1,0],velocity:[-140,0,0],mass:5.4,
  });
 }
 assert.equal(grapeTarget.boat.damage.surrendered,true,'vessel surrenders when battle morale breaks');
 assert.equal(grapeTarget.boat.colors,'surrender','surrendered vessel hoists the white flag of surrender');
 assert.equal(surrenderNotified,true,'onSurrender callback fires when vessel strikes her colors');

 // 4. Surrendered vessel ceases fire and furls sails, and opposing AI vessels honour the surrender
 const enemyGuns=createShipGunnery(grapeTarget.boat);
 const enemyFollower=createFollower({trail:0,side:1.2},{faction:'enemy'});
 const player={boat:roundTarget.boat,faction:'friendly'};
 const enemyVessel={boat:grapeTarget.boat,gunnery:enemyGuns,follower:enemyFollower,faction:'enemy'};
 steerFollower(enemyFollower,grapeTarget.boat,roundTarget.boat,0.1,8,0);
 assert.ok(enemyFollower.status.includes('Surrendered'),'follower status reflects struck colors');
 const aiRes=stepVesselCombatAI(enemyVessel,{vessels:[player,enemyVessel],dt:0.1});
 assert.equal(aiRes.action,'surrendered','surrendered AI vessel stands down from combat');

 // Opposing AI vessel skips surrendered ship as a target
 const hunterBoat={id:'hunter',modelId:'nina',length:20,beam:6,heading:0,x:0,z:0,heave:0,pitch:0,roll:0,propulsion:'sail',colors:'portugal'};
 hunterBoat.hydrodynamics=boatHydrodynamics(20,6);
 const hunterGuns=createShipGunnery(hunterBoat);
 const hunterVessel={boat:hunterBoat,gunnery:hunterGuns,follower:createFollower({trail:0,side:1.2},{faction:'enemy'}),faction:'enemy'};
 grapeTarget.boat.faction='friendly';
 const hunterRes=stepVesselCombatAI(hunterVessel,{vessels:[hunterVessel,{boat:grapeTarget.boat,faction:'friendly'}],dt:0.1});
 assert.equal(hunterRes.action,'stand-down','opposing AI vessel ceases fire against a ship that has struck her colors');

 // Manual strikeVesselColors / setVesselColors
 setVesselColors(hunterBoat,'france');
 assert.equal(hunterBoat.colors,'france');
 strikeVesselColors(hunterBoat,'Captain’s order');
 assert.equal(hunterBoat.colors,'surrender');
 assert.equal(hunterBoat.damage.surrendered,true);
});

test('pirate AI prepares at quarters, fires broadsides at player ship, and switches sides cleanly when target crosses',async ()=>{
 const {selectBroadsideFacingTarget}=await import('../js/follower.js');
 const player={id:'player',modelId:'nina',length:20,beam:6,heading:0,x:0,z:0,heave:0,pitch:0,roll:0,propulsion:'sail',surgeVelocity:3,sailFore:1,sailMain:1,sailMizzen:1};
 player.hydrodynamics=boatHydrodynamics(20,6);
 createVesselDamageState(player);
 const pirate={id:'pirate',modelId:'nina',length:20,beam:6,heading:90,x:135,z:-25,heave:0,pitch:0,roll:0,propulsion:'sail',surgeVelocity:3,sailFore:1,sailMain:1,sailMizzen:1,colors:'jolly-roger',battleColors:'jolly-roger'};
 pirate.hydrodynamics=boatHydrodynamics(20,6);
 createVesselDamageState(pirate);
 // Deliberately leave pirate.gunneryAttendance empty to verify AI vessels do not deadlock on visibleCrew attendance
 pirate.gunneryAttendance=new Set();
 const shots=[];
 const pirateGuns=createShipGunnery(pirate,{
  getVessels:()=>[player,pirate],
  onEvent:e=>{if(e.type==='shot')shots.push(e);},
 });
 const pirateFollower=createFollower({trail:0,side:1.2},{faction:'enemy',salvoDelay:0.4});
 const vessels=[{boat:player,faction:'friendly'},{boat:pirate,gunnery:pirateGuns,follower:pirateFollower,faction:'enemy'}];
 const firedSides=new Set();
 for(let t=0;t<500;t++){
  steerFollower(pirateFollower,pirate,player,0.1,8,0);
  // First 20s target is to port; next 30s target crosses to starboard
  const bearingDeg=Math.atan2(player.x-pirate.x,-(player.z-pirate.z))*180/Math.PI;
  pirate.heading=((bearingDeg+(t<200?90:-90))%360+360)%360;
  const res=stepVesselCombatAI(vessels[1],{vessels,dt:0.1});
  if(res?.action==='fire'||res?.action==='fire-loaded')firedSides.add(res.side);
  pirateGuns.update(0.1,[5,0,0]);
  selectBroadsideFacingTarget(pirate,player);
 }
 assert.ok(shots.length>=4,`expected pirate AI to fire multiple shots at player ship, got ${shots.length}`);
 assert.ok(firedSides.has('port')&&firedSides.has('starboard'),`expected pirate AI to switch batteries and fire from both sides, got ${[...firedSides].join(',')}`);
});

test('full sail raises all canvas across procedural and multi-mast ships and URL encodes safe game state and position',async ()=>{
 const {issueCaptainOrder}=await import('../js/crew.js');
 const {sailingState}=await import('../js/sailing.js');
 const {SHIP_MODELS}=await import('../js/ship-models.js');
 const {createShareLink,encodeGameStateParam,decodeGameStateParam}=await import('../js/sharing.js');

 // 1. Verify full sail on flying-cloud (procedural 3-mast clipper) and pinta (after partial furl with descending climber)
 for(const id of ['flying-cloud','pinta']){
  const m=SHIP_MODELS[id];
  const b={modelId:id,...m.runtime,roll:0,rollVelocity:0,pitch:0,pitchVelocity:0,rudder:0,sailFore:1,sailMain:1,sailMizzen:1,hatchOpen:0,crew:false,propulsion:'sail'};
  sailingState(b);
  const c=createCompany(undefined,id);
  stepCompany(c,b,0,6);
  issueCaptainOrder(c,b,'furl');
  for(let t=0;t<32;t++){advanceSails(b,0.25,6,0.8);stepCompany(c,b,0.25,6);}
  issueCaptainOrder(c,b,'full');
  for(let t=0;t<220;t++){advanceSails(b,0.25,6,0.8);stepCompany(c,b,0.25,6);}
  const set=Array.from(sailingState(b).set).map(v=>Number(v.toFixed(2)));
  assert.deepEqual(set,[1,1,1],`${id} raises all three mast groups to full sail after mid-furl reversal`);
 }

 // 2. Verify companion follower sets all sails to 1.0 under captain 'full' order
 const leader={modelId:'nina',length:20,beam:6,heading:0,x:0,z:0,sailFore:0.5,sailMain:0.5,sailMizzen:0.5,surgeVelocity:2};
 const companion={modelId:'nina',length:20,beam:6,heading:0,x:-40,z:40,sailFore:0.2,sailMain:0.2,sailMizzen:0.2,surgeVelocity:2};
 const fol=createFollower({trail:2,side:-2},{faction:'friendly'});
 fol.captainOrder='full';
 steerFollower(fol,companion,leader,0.1,8,0);
 assert.equal(companion.sailFore,1);
 assert.equal(companion.sailMain,1);
 assert.equal(companion.sailMizzen,1);

 // 3. Verify URL encoding of safe game state + explicit position/voyage/ship attributes
 const statePayload={
  v:1,
  pos:{lat:38.70715,lon:-9.13642,drLat:38.705,drLon:-9.14,x:-125.4,z:340.8,heading:215.5,speed:5.4,rudder:-3.5,region:'lisboa-ribeira-das-naus'},
  ship:{id:'santa-maria',colors:'portugal',station:'crows-nest',propulsion:'sail',sails:[1,1,1],set:[1,1,1],provisionDays:45,cargoTonnes:12},
  voyage:{active:true,day:3,canvas:'full',course:225,warp:'watch',autopilot:true,waterDays:42,foodDays:57},
  damage:{hullIntegrity:0.92,battleMorale:0.88,surrendered:false,sunk:false},
 };
 const encoded=encodeGameStateParam(statePayload);
 assert.ok(encoded.length>20,'encodes compact base64url state parameter');
 const decoded=decodeGameStateParam(encoded);
 assert.deepEqual(decoded,statePayload,'round-trips safe game state cleanly');

 const boat={
  modelId:'santa-maria',colors:'portugal',viewStation:'crows-nest',propulsion:'sail',
  length:29,beam:8.5,heading:215.5,speed:5.4,eye:3.2,rudderTarget:-3.5,
  sailFore:1,sailMain:1,sailMizzen:1,provisionDays:45,cargoTonnes:12,
  x:-125.4,z:340.8,showProw:true,effects:true,crew:true,followingShip:true,
 };
 const href=createShareLink('https://sixcailloux.com/waterworld/',{windSpeed:8,windDir:45},boat,'boat',{
  voyage:{lat:38.70715,lon:-9.13642,drLat:38.705,drLon:-9.14,region:'lisboa-ribeira-das-naus',canvas:'full',course:225,warp:'watch',autopilot:true,day:3},
  gameState:statePayload,
 });
 const u=new URL(href);
 assert.equal(u.searchParams.get('lat'),'38.70715');
 assert.equal(u.searchParams.get('lon'),'-9.13642');
 assert.equal(u.searchParams.get('drLat'),'38.705');
 assert.equal(u.searchParams.get('drLon'),'-9.14');
 assert.equal(u.searchParams.get('boatX'),'-125.4');
 assert.equal(u.searchParams.get('boatZ'),'340.8');
 assert.equal(u.searchParams.get('boatHeading'),'215.5');
 assert.equal(u.searchParams.get('ship'),'santa-maria');
 assert.equal(u.searchParams.get('colors'),'portugal');
 assert.equal(u.searchParams.get('station'),'crows-nest');
 assert.equal(u.searchParams.get('canvas'),'full');
 assert.equal(u.searchParams.get('course'),'225');
 assert.equal(u.searchParams.get('warp'),'watch');
 assert.deepEqual(decodeGameStateParam(u.searchParams.get('state')),statePayload);
});

test('pirates wear brown and black clothing, women and men have equal boarding strength, and ships can dock/cast off and board/capture surrendered or fighting vessels',async ()=>{
 const {PIRATE_SHIRTS,PIRATE_TROUSERS,isPirateVessel,applyPirateCrewAttire}=await import('../js/crew.js');
 const {createDockingBoardingState,computeBoardingStrength,FEMALE_BOARDING_STRENGTH,MALE_BOARDING_STRENGTH}=await import('../js/boarding-docking.js');

 // 1. Women and men have identical strength (1.0)
 assert.equal(FEMALE_BOARDING_STRENGTH,1.0);
 assert.equal(MALE_BOARDING_STRENGTH,1.0);
 const playerBoat={id:'player',modelId:'nina',name:'Santa Clara',length:20,beam:6,heading:0,x:0,z:0,heave:0,pitch:0,roll:0,propulsion:'sail',colors:'portugal'};
 playerBoat.hydrodynamics=boatHydrodynamics(20,6);
 createVesselDamageState(playerBoat);
 const playerCompany=createCompany(undefined,'nina',{boat:playerBoat});
 const femaleSailors=playerCompany.crew.filter(s=>s.sex==='female');
 const maleSailors=playerCompany.crew.filter(s=>s.sex==='male');
 assert.ok(femaleSailors.length>0&&maleSailors.length>0,'crew has both women and men');
 for(const s of playerCompany.crew){
  assert.equal(s.strength,1.0,`${s.name} (${s.sex}) has strength 1.0`);
 }
 const playerPower=computeBoardingStrength({boat:playerBoat,company:playerCompany});
 assert.equal(playerPower.meanFemaleStrength,playerPower.meanMaleStrength,'female and male boarding strength are equal');

 // 2. Pirates wear brown and black clothing
 const pirateBoat={id:'pirate',modelId:'nina',name:'Black Adder',length:20,beam:6,heading:0,x:14,z:0,heave:0,pitch:0,roll:0,propulsion:'sail',colors:'jolly-roger',battleColors:'jolly-roger',faction:'enemy'};
 pirateBoat.hydrodynamics=boatHydrodynamics(20,6);
 createVesselDamageState(pirateBoat);
 assert.equal(isPirateVessel(pirateBoat),true,'identifies jolly-roger enemy vessel as pirate');
 const pirateCompany=createCompany(undefined,'nina',{boat:pirateBoat});
 assert.equal(pirateCompany.pirateAttire,true,'pirate company wears pirate attire');
 for(const s of pirateCompany.crew){
  assert.ok(PIRATE_SHIRTS.includes(s.shirt),`pirate ${s.name} wears brown or black shirt`);
  assert.ok(PIRATE_TROUSERS.includes(s.trousers),`pirate ${s.name} wears brown or black trousers`);
  // Verify RGB channels are dark/brown (R >= G >= B, low luminance)
  assert.ok(s.shirt[0]<=0.32&&s.shirt[1]<=0.22&&s.shirt[2]<=0.15,'pirate shirt is in brown/black palette');
  assert.ok(s.trousers[0]<=0.25&&s.trousers[1]<=0.18&&s.trousers[2]<=0.12,'pirate trousers are in brown/black palette');
 }

 // 3. Pier docking sequence: throw lines -> make fast -> moored -> cast off
 const pirateVessel={boat:pirateBoat,company:pirateCompany,faction:'enemy'};
 const db=createDockingBoardingState(playerBoat,{
  company:playerCompany,
  getAdditionalVessels:()=>[pirateVessel],
 });
 const dockRes=db.dockAtPier({portLabel:'Ribeira das Naus Pier'});
 assert.equal(dockRes.ok,true);
 assert.equal(db.state.mooringPhase,'throwing-lines');
 assert.equal(playerBoat.mooringActive,true);
 let verts=db.buildVertices();
 assert.ok(verts.length>0,'generates 3D catenary mooring line vertices while throwing lines');

 // Test changing your mind while hauling in and casting off:
 // advance into making-fast (hauling in), record lateral progress toward pier, then castOff()
 playerBoat.heading=255; // Lisbon departure heading
 db.dockAtPier({portLabel:'Ribeira das Naus Pier'});
 const nx=db.state.pierNormalX,nz=db.state.pierNormalZ;
 const projPier=()=>playerBoat.x*nx+playerBoat.z*nz;
 for(let i=0;i<15;i++)db.step(0.12);
 assert.equal(db.state.mooringPhase,'making-fast','entered making-fast (hauling in) phase');
 const beforeHaulStep=projPier();
 db.step(0.05);
 const afterHaulStep=projPier();
 assert.ok(afterHaulStep>beforeHaulStep,'ship moves smoothly toward pier while hauling in');
 assert.ok((afterHaulStep-beforeHaulStep)<0.08,'single-frame lateral movement is smooth and non-jerky');
 // Now change mind mid-haul and cast off!
 const abortCast=db.castOff();
 assert.equal(abortCast.ok,true);
 assert.equal(db.state.lineTension,0,'line tension immediately zeroes on cast off');
 assert.equal(playerBoat.mooringRestraint,0,'mooring restraint immediately zeroes on cast off');
 const atCastMoment=projPier();
 db.step(0.05);
 const afterCastStep=projPier();
 assert.ok(afterCastStep<atCastMoment,'ship immediately stops hauling in and glides away from pier on the very next frame after castOff()');

 // Full dock -> moored -> cast off cycle
 db.dockAtPier({portLabel:'Ribeira das Naus Pier'});
 for(let i=0;i<30;i++)db.step(0.15);
 assert.equal(db.state.mooringPhase,'moored','transitions through making-fast to moored');
 const castRes=db.castOff();
 assert.equal(castRes.ok,true);
 assert.equal(db.state.mooringPhase,'casting-off');
 for(let i=0;i<25;i++)db.step(0.15);
 assert.equal(db.state.mooringPhase,'clear','lines coiled aboard after casting off');
 assert.equal(db.buildVertices().length,0,'no mooring vertices when clear');

 // 4. Board a surrendered vessel and take her as a prize
 const surrBoat={id:'prize',modelId:'nina',name:'San Mateo',length:20,beam:6,heading:0,x:18,z:2,heave:0,pitch:0,roll:0,propulsion:'sail',colors:'surrender'};
 surrBoat.hydrodynamics=boatHydrodynamics(20,6);
 createVesselDamageState(surrBoat);
 surrBoat.damage.surrendered=true;
 const surrCompany=createCompany(undefined,'nina',{boat:surrBoat});
 const surrVessel={boat:surrBoat,company:surrCompany,faction:'enemy'};
 const boardSurr=db.boardVessel(surrVessel);
 assert.equal(boardSurr.ok,true);
 assert.equal(boardSurr.mode,'surrendered');
 for(let i=0;i<35;i++)db.step(0.15);
 assert.equal(surrBoat.captured,true,'surrendered vessel is captured');
 assert.equal(surrVessel.faction,'friendly','captured prize joins player squadron as friendly');
 assert.equal(surrBoat.colors,'portugal','captured prize hoists player colors');

 // 5. Board an active (unsurrendered) pirate vessel, fight crew-to-crew based on morale & strength, and capture her
 pirateBoat.damage.battleMorale=0.62;
 pirateCompany.morale=0.62;
 playerBoat.damage.battleMorale=0.98;
 playerCompany.morale=0.98;
 const boardFight=db.boardVessel(pirateVessel);
 assert.equal(boardFight.ok,true);
 assert.equal(boardFight.mode,'fight');
 assert.equal(playerBoat.boardingActive,true,'player crew stationed at bulwarks for boarding melee');
 assert.equal(pirateBoat.boardingActive,true,'enemy crew stationed at bulwarks for boarding melee');
 for(let i=0;i<80&&db.state.boardingPhase!=='captured';i++){
  db.step(0.2);
  if(i===15){
   const gangplankVerts=db.buildVertices();
   assert.ok(gangplankVerts.length>100,'renders 3D grappling lines and boarding gangplanks during melee');
  }
 }
 assert.equal(db.state.boardingPhase,'captured','higher-morale/strength crew wins boarding combat and captures vessel');
 assert.equal(pirateBoat.captured,true,'defeated enemy vessel is captured as a prize');
 assert.equal(pirateVessel.faction,'friendly','captured pirate vessel becomes friendly prize');
 assert.equal(pirateBoat.colors,'portugal','captured pirate vessel hoists player colors');
 assert.equal(pirateCompany.pirateAttire,false,'captured prize crew reverts from pirate attire');
});

test('URL state restoration with follower=0&fleet= and lat/lon restores onto createVoyage without crashing',async()=>{
 const {decodeGameStateParam}=await import('../js/sharing.js');
 const {createVoyage}=await import('../js/voyage/passage.js');
 const userUrl='https://sixcailloux.com/waterworld/?region=lisbon&lat=38.70535&lon=-9.136&skyMode=manual&astroDate=2026-10-21T00%3A00%3A00.000Z&astroRate=1&latitude=38.70535256978593&longitude=-9.135995217559412&stars=1&constellations=0&boat=0&view=ship&orbitYaw=4.444442&orbitElevation=3.398583&orbitDistance=32&orbitPanX=0&orbitPanY=0&orbitPanZ=0&colors=portugal&propulsion=sail&windSpeed=5&windDir=132&fetchKm=90&swellHs=0.35&swellDir=162&swellLength=65&swellSpread=48&choppy=1.25&turbidity=1.6&foam=1&spindrift=1&sunElev=32&sunAzim=225&exposure=1.35&haze=0.8&clouds=0.3&cloudBase=1.2&cloudDepth=1.8&cloudDensity=1&cloudAnvil=0.05&cloudQuality=0.5&rain=0&precipitation=0&thunder=0&soundVolume=0.7&seabirds=0.25&bloom=0.1&boatLength=20&boatBeam=6&boatHeading=264.687913&boatSpeed=1.5&boatEye=5.433333&boatRudder=0&sailFore=1&sailMain=1&sailMizzen=1&provisionDays=60&cargoTonnes=0&boatX=-0.340862&boatZ=-5816.693855&rowingEffort=0&rowingTurn=0&rowingCadence=0.45&prow=1&effects=1&crew=1&follower=0&fleet=&speedHud=1&windHud=1&headingHud=1&drLat=38.70535&drLon=-9.136&canvas=full&course=247&warp=deck&autopilot=0&day=0&state=eyJ2IjoxLCJwb3MiOnsibGF0IjozOC43MDUzNSwibG9uIjotOS4xMzYsImRyTGF0IjozOC43MDUzNSwiZHJMb24iOi05LjEzNiwieCI6LTAuMzQsInoiOi01ODE2LjY5LCJoZWFkaW5nIjoyNjQuNjksInNwZWVkIjoyLjUxLCJydWRkZXIiOjAsInJlZ2lvbiI6Imxpc2JvbiJ9LCJzaGlwIjp7ImlkIjoibmluYSIsImNvbG9ycyI6InBvcnR1Z2FsIiwic3RhdGlvbiI6ImRlY2siLCJwcm9wdWxzaW9uIjoic2FpbCIsInNhaWxzIjpbMSwxLDFdLCJzZXQiOlsxLDEsMV0sInByb3Zpc2lvbkRheXMiOjYwLCJjYXJnb1Rvbm5lcyI6MH0sInZveWFnZSI6eyJhY3RpdmUiOmZhbHNlLCJkYXkiOjAsImRhdGVNcyI6LTEzMjQ2ODE5MTQ3MDkxLCJjYW52YXMiOiJmdWxsIiwiY291cnNlIjoyNDcsIndhcnAiOiJkZWNrIiwiYXV0b3BpbG90IjpmYWxzZSwiYmVhdCI6ZmFsc2V9LCJkYW1hZ2UiOnsiaHVsbEludGVncml0eSI6MSwiYmF0dGxlTW9yYWxlIjoxLCJzdXJyZW5kZXJlZCI6ZmFsc2UsInN1bmsiOmZhbHNlLCJjYXN1YWx0aWVzIjp7InRvdGFsIjoyMiwiYWJsZSI6MjIsIndvdW5kZWQiOjAsImtpbGxlZCI6MH19LCJlbmNvdW50ZXIiOnsiZmFjdGlvbiI6ImZyaWVuZGx5IiwiY29sb3JzIjoicG9ydHVnYWwiLCJ4IjoxNC40LCJ6IjotNTgzMS4xLCJoZWFkaW5nIjozMTEuNCwic3VycmVuZGVyZWQiOmZhbHNlfX0';
 const qs=new URL(userUrl).searchParams;
 const urlGameState=decodeGameStateParam(qs.get('state'));
 assert.ok(urlGameState,'decodes state parameter');
 const v=createVoyage({lat:38.707,lon:-9.136});
 const qLat=Number(qs.get('lat')),qLon=Number(qs.get('lon'));
 if(v.true){v.true.lat=qLat;v.true.lon=qLon;}
 if(v.dr){v.dr.lat=Number(qs.get('drLat'));v.dr.lon=Number(qs.get('drLon'));}
 assert.equal(v.true.lat,38.70535);
 assert.equal(v.true.lon,-9.136);
 const allowRestoredEncounter=qs.get('follower')!=='0'&&(!qs.has('fleet')||qs.get('fleet')!=='');
 assert.equal(allowRestoredEncounter,false,'does not re-enable encounter ship when follower=0 and fleet is empty');
});

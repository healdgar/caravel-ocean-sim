import assert from 'node:assert/strict';
import {test} from 'node:test';
import {bindVesselModel,copyVessel,createVesselProbeState,acceptVesselProbe,stepVessel} from '../js/vessels.js';
import {getShipModel} from '../js/ship-models.js';
import {createFollower,steerFollower,commandFriendlyFleet,stepVesselCombatAI,selectBroadsideFacingTarget,isFriendlyInLineOfFire} from '../js/follower.js';
import {broadsideFormation,fleetFromSearch,fleetToSearch,normalizeVesselFaction} from '../js/fleet.js';
import {sailingState,advanceSails,sailForces} from '../js/sailing.js';
import {createCompany,stepCompany} from '../js/crew.js';
import {createShipGunnery,createVesselDamageState} from '../js/gunnery-control.js';
import {manGunStationsImmediate} from '../js/crew-work.js';

const RAD=Math.PI/180;
const source={length:24,beam:7.2,eye:4,heading:118,x:0,z:0,provisionDays:30,cargoTonnes:0,sailFore:1,sailMain:1,sailMizzen:1};

test('copied vessels preserve dimensions and loading without sharing mutable rig or wave state',()=>{
  const first=copyVessel(source,{distance:0,side:0}),second=copyVessel(first);
  assert.equal(second.length,first.length);assert.equal(second.beam,first.beam);assert.equal(second.hydrodynamics.mass,first.hydrodynamics.mass);
  assert.notEqual(second.target,first.target);assert.notEqual(sailingState(first),sailingState(second));
  assert.notEqual(first.sailState.rig,second.sailState.rig);
  const a=createVesselProbeState(),b=createVesselProbeState(),heights=new Float32Array(16);heights.fill(2,0,9);
  acceptVesselProbe(second,b,heights,1,0,second.length,second.beam);
  assert.equal(first.heave,-first.hydrodynamics.sinkage);assert.ok(second.heave>1);assert.equal(a.time,-1);assert.equal(b.time,1);
  assert.equal(acceptVesselProbe(second,b,heights,2,0,second.length,second.beam),false,'stale readback cannot overwrite a newer placement');
});

test('vessel instances share an immutable model identity while retaining their configured dimensions and load',()=>{
  const first=bindVesselModel({...source,id:'leader'}),second=copyVessel(first,{id:'follower',distance:0,side:0});
  assert.equal(first.modelId,'nina');assert.equal(second.modelId,'nina');
  assert.equal(first.model,getShipModel('nina'));assert.equal(second.model,first.model);
  assert.ok(Object.isFrozen(first.model));
  assert.equal(first.length,source.length);assert.equal(first.beam,source.beam);
  assert.equal(second.length,source.length);assert.equal(second.beam,source.beam);
  assert.equal(second.provisionDays,source.provisionDays);assert.equal(second.cargoTonnes,source.cargoTonnes);
});

test('additional models bind their own identities and dimensions; unknown models cannot mutate a vessel',()=>{
  const boat=bindVesselModel({...source}),model=boat.model;
  for(const id of ['pinta','santa-maria']){
    const copy=copyVessel({...source},{modelId:id});assert.equal(copy.model,getShipModel(id));
    assert.equal(copy.length,getShipModel(id).runtime.length);assert.equal(copy.beam,getShipModel(id).runtime.beam);
    assert.notEqual(copy.hydrodynamics,boat.hydrodynamics);
    assert.equal(boat.model,model);assert.equal(boat.modelId,'nina');
  }
  assert.throws(()=>bindVesselModel(boat,'unknown-ship'),/unknown|not.*found/i);
  assert.equal(boat.model,model);
});

test('copying a vessel copies its requested configuration without transplanting a running simulation',()=>{
  const first=copyVessel(source,{id:'leader',distance:0,side:0});
  Object.assign(first,{speed:6,surgeVelocity:2,leewayVelocity:.2,yawRate:.03,rudder:12,rudderTarget:12,
    externalForce:{x:100,z:200,yaw:300},crewSailRate:new Float64Array([.3,.6,.9])});
  advanceSails(first,.1,9,.7);sailForces(first,9,.7,2);
  const firstRig=sailingState(first),firstSet=Array.from(firstRig.set),firstForces=[firstRig.forward,firstRig.side];
  const second=copyVessel(first,{id:'follower',distance:0,side:0}),secondRig=sailingState(second);
  assert.equal(first.id,'leader');assert.equal(second.id,'follower');
  assert.equal(second.speed,first.speed);assert.equal(second.propulsion,'sail');
  assert.equal(second.surgeVelocity,undefined);assert.equal(second.leewayVelocity,undefined);
  assert.equal(second.externalForce,undefined);assert.equal(second.crewSailRate,undefined);
  assert.equal(second.rudder,0);assert.equal(second.rudderTarget,0);assert.equal(second.yawRate,0);
  assert.notEqual(second.hydrodynamics,first.hydrodynamics);
  assert.notEqual(secondRig.geometry,firstRig.geometry);assert.notEqual(secondRig.set,firstRig.set);
  assert.notEqual(secondRig.panelSide,firstRig.panelSide);assert.notEqual(secondRig.panelMoment,firstRig.panelMoment);
  second.sailFore=0;advanceSails(second,1,15,2);sailForces(second,15,2,0);
  assert.deepEqual(Array.from(firstRig.set),firstSet,'working one ship cannot change another ship\'s canvas');
  assert.deepEqual([firstRig.forward,firstRig.side],firstForces,'force queries remain per ship');
});

test('follower policy has no authority to translate, accelerate or rotate a ship',()=>{
  const lead=copyVessel(source,{distance:0,side:0}),boat=copyVessel(lead),state=createFollower();
  Object.assign(boat,{surgeVelocity:1.2,leewayVelocity:.1,yawRate:.03});
  const before=[boat.x,boat.z,boat.heading,boat.surgeVelocity,boat.leewayVelocity,boat.yawRate];
  steerFollower(state,boat,lead,.1,7,118*RAD);
  assert.deepEqual([boat.x,boat.z,boat.heading,boat.surgeVelocity,boat.leewayVelocity,boat.yawRate],before);
  assert.equal(boat.propulsion,'sail');assert.ok(Math.abs(boat.rudderTarget)<=35);
});

test('a full-canvas leader starting from rest keeps follower sails set; a furled stopped leader can furl them',()=>{
  const lead=copyVessel(source,{distance:0,side:0}),boat=copyVessel(lead),state=createFollower();
  lead.surgeVelocity=0;steerFollower(state,boat,lead,.1,7,118*RAD);
  for(const key of ['sailFore','sailMain','sailMizzen'])assert.ok(boat[key]>.8,'low speed alone must not furl a sailing companion');
  lead.sailFore=lead.sailMain=lead.sailMizzen=0;
  steerFollower(state,boat,lead,.1,7,118*RAD);
  for(const key of ['sailFore','sailMain','sailMizzen'])assert.equal(boat[key],0,'a stopped, furled leader requests companion furling at station');
});

test('formation following sails for four minutes using ordinary hull forces and remains separated',()=>{
  const lead=copyVessel(source,{distance:0,side:0}),boat=copyVessel(lead),state=createFollower();
  const a=createVesselProbeState(),b=createVesselProbeState();let minDistance=Infinity,captainTrim=0;
  for(let i=0;i<7200;i++){
    const dt=1/30,t=i*dt;
    // A captain must hold the requested course against real sail/hull yaw.
    // This order acts through rudder lag, water flow and yaw inertia; it never
    // overwrites heading or suppresses the forces the escort must also balance.
    const error=Math.atan2(Math.sin((118-lead.heading)*RAD),Math.cos((118-lead.heading)*RAD))/RAD;
    captainTrim=Math.max(-20,Math.min(20,captainTrim+error*.06*dt));
    lead.rudderTarget=Math.max(-35,Math.min(35,error*1.1-(lead.yawRate??0)/RAD*5+captainTrim));
    stepVessel(lead,a,dt,t,7,118*RAD);steerFollower(state,boat,lead,dt,7,118*RAD);stepVessel(boat,b,dt,t,7,118*RAD);
    minDistance=Math.min(minDistance,Math.hypot(boat.x-lead.x,boat.z-lead.z));
  }
  const h=lead.heading*RAD,goalX=lead.x-Math.sin(h)*lead.length*2.8+Math.cos(h)*lead.length*1.5,goalZ=lead.z+Math.cos(h)*lead.length*2.8+Math.sin(h)*lead.length*1.5;
  assert.ok(Math.hypot(boat.x-goalX,boat.z-goalZ)<lead.length,'follower remains within one hull length of its station');
  assert.ok(minDistance>lead.length*2,'physical hulls remain well separated');
  assert.ok(boat.surgeVelocity>1);assert.ok(Math.abs(boat.heading-lead.heading)<5);
  assert.ok(Math.abs(lead.heading-118)<2,'the captain holds course through physical helm forces');
  assert.equal(boat.sailState.maneuver,undefined,'routine following never transfers yards');
});

test('in-irons recovery uses real sternway and keeps one tack commitment',()=>{
  const lead=copyVessel({...source,heading:0},{distance:0,side:0}),boat=copyVessel(lead),state=createFollower();
  const wind=Math.PI/2;boat.heading=0;boat.surgeVelocity=-.3;
  for(let i=0;i<100;i++)steerFollower(state,boat,lead,.1,9,wind);
  const tack=state.tack;assert.equal(state.status,'Recovering from irons');assert.equal(Math.sign(boat.rudderTarget),-tack);
  boat.surgeVelocity=.3;steerFollower(state,boat,lead,.1,9,wind);
  assert.equal(Math.sign(boat.rudderTarget),tack);assert.equal(state.tack,tack);assert.equal(boat.surgeVelocity,.3);
});

test('a backed follower recovers through real steering and one deliberate yard transfer',()=>{
  const lead=copyVessel(source,{distance:0,side:0}),boat=copyVessel(lead),state=createFollower(),probe=createVesselProbeState();
  boat.heading=0;lead.surgeVelocity=1;let transfers=0,wasTransferring=false;
  for(let i=0;i<7200;i++){
    const dt=1/30,t=i*dt,h=lead.heading*RAD;
    lead.x+=Math.sin(h)*dt;lead.z-=Math.cos(h)*dt;
    steerFollower(state,boat,lead,dt,9,Math.PI/2);
    if(boat.sailState?.maneuver&&!wasTransferring)transfers++;
    wasTransferring=!!boat.sailState?.maneuver;
    stepVessel(boat,probe,dt,t,9,Math.PI/2);
  }
  assert.equal(transfers,1,'a sustained bad-tack recovery warrants one transfer, not repeated transfers in irons');
  assert.ok(boat.surgeVelocity>.5,'wind and the new yard side restore forward motion');
  assert.equal(state.recovering,false);
});

test('a leader crossing the wind cannot reverse a committed backed recovery',()=>{
  const lead=copyVessel(source,{distance:0,side:0}),boat=copyVessel(lead),state=createFollower();
  boat.heading=0;boat.surgeVelocity=-.3;state.ironsTime=4;
  steerFollower(state,boat,lead,.1,9,Math.PI/2);
  assert.equal(state.recovering,true);
  const side=state.recoveryTack,course=state.course,rudder=boat.rudderTarget;
  assert.ok(side===1||side===-1);
  // Move the pursuit destination across the bow in both directions. This
  // deliberately changes the next sailing tack while the hull still backs.
  for(const pursuitSide of [-side,side,-side]){
    lead.x=boat.x+pursuitSide*500;lead.z=boat.z;lead.heading=pursuitSide>0?90:270;
    steerFollower(state,boat,lead,.1,9,Math.PI/2);
    assert.equal(state.tack,pursuitSide,'the pursuit target has crossed the wind');
    assert.equal(state.recoveryTack,side);
    assert.equal(state.course,course,'the committed escape course stays fixed');
    assert.equal(boat.rudderTarget,rudder,'sternway keeps the same recovery helm');
  }
  boat.heading=((course%360)+360)%360;boat.surgeVelocity=-.2;
  steerFollower(state,boat,lead,.1,9,Math.PI/2);
  assert.equal(state.recoveryTack,side,'heading clear of the wind alone cannot end recovery');
  boat.surgeVelocity=.5;steerFollower(state,boat,lead,.1,9,Math.PI/2);
  assert.equal(state.recovering,false);assert.equal(state.recoveryTack,0,'positive forward escape releases the commitment');
});

test('two HMS Victories in broadsideFormation hold close beam-to-beam parallel station without repelling or furling',()=>{
  const formation=broadsideFormation(0,{side:'starboard',rangeLengths:1.22});
  assert.equal(formation.trail,0);assert.equal(formation.side,1.22);assert.equal(formation.broadside,true);
  const victory=getShipModel('victory');
  const lead=copyVessel({...source,modelId:'victory',length:victory.runtime.length,beam:victory.runtime.beam,heading:0,sailFore:0.55,sailMain:0.55,sailMizzen:0.55},{id:'player',modelId:'victory',distance:0,side:0});
  const escort=copyVessel(lead,{id:'escort-1',modelId:'victory',distance:lead.length*formation.trail,side:lead.length*formation.side});
  lead.surgeVelocity=escort.surgeVelocity=2.16;
  const state=createFollower(formation);
  steerFollower(state,escort,lead,0.1,7.5,300*RAD);
  assert.equal(state.status,'Broadside station');
  assert.ok(escort.sailMain>0.4,'companion Victory retains fighting sails at close broadside range');
  assert.ok(Math.abs(escort.rudderTarget)<5,'parallel beam-to-beam station requires no emergency avoidance helm');
});

test('fleet faction parsing, friendly ships obeying captain orders, and enemy AI autonomous broadside combat',()=>{
  // 1. Faction URL parsing & serialization
  const parsed=fleetFromSearch(new URLSearchParams('fleet=victory:enemy,nina:friendly,!pinta:enemy'));
  assert.equal(parsed[0].faction,'enemy');
  assert.equal(parsed[1].faction,'friendly');
  assert.equal(parsed[2].faction,'enemy');
  assert.equal(parsed[2].enabled,false);
  assert.equal(fleetToSearch(parsed),'victory:enemy,nina,!pinta:enemy');
  assert.equal(normalizeVesselFaction({modelId:'victory'},{broadside:true,index:0}),'enemy');
  assert.equal(normalizeVesselFaction({modelId:'victory'},{broadside:false,index:0}),'friendly');

  // 2. Friendly ship obeys captain sailing orders (furl, weather, reduced, full) across steerFollower + stepCompany
  const victory=getShipModel('victory');
  const playerBoat=copyVessel({...source,modelId:'victory',length:victory.runtime.length,beam:victory.runtime.beam,heading:0},{id:'player',modelId:'victory',distance:0,side:0});
  const friendlyBoat=copyVessel(playerBoat,{id:'escort-1',modelId:'victory',distance:140,side:-75});
  const enemyBoat=copyVessel(playerBoat,{id:'escort-2',modelId:'victory',distance:0,side:75});
  playerBoat.surgeVelocity=friendlyBoat.surgeVelocity=enemyBoat.surgeVelocity=2.5;

  const friendlyCrew={state:createCompany(undefined,'victory'),order(b,id){return stepCompany(this.state,b,0,7.5)&&true;}};
  // Use actual crew.order via createCompany + issueCaptainOrder
  const {issueCaptainOrder}=friendlyCrew;
  const friendlyCompany=createCompany(undefined,'victory');
  const enemyCompany=createCompany(undefined,'victory');
  const friendlyVessel={
    id:'escort-1',
    faction:'friendly',
    boat:friendlyBoat,
    follower:createFollower({trail:2.4,side:-1.3},{faction:'friendly'}),
    crew:{state:friendlyCompany,order(b,id){return issueCaptainOrder?issueCaptainOrder(friendlyCompany,b,id):false;}},
    gunnery:createShipGunnery(friendlyBoat,{deferSeaCollision:false,getVessels:()=>[playerVessel,friendlyVessel,enemyVessel]}),
  };
  const enemyVessel={
    id:'escort-2',
    faction:'enemy',
    boat:enemyBoat,
    follower:createFollower({trail:0,side:1.3},{faction:'enemy'}),
    crew:{state:enemyCompany},
    gunnery:createShipGunnery(enemyBoat,{deferSeaCollision:false,getVessels:()=>[playerVessel,friendlyVessel,enemyVessel]}),
  };
  const playerVessel={id:'player',faction:'friendly',boat:playerBoat,gunnery:createShipGunnery(playerBoat,{deferSeaCollision:false})};
  const vessels=[playerVessel,friendlyVessel,enemyVessel];

  // Captain orders 'furl': friendly ship furls all sails even while leader still has forward velocity
  commandFriendlyFleet(vessels,{type:'crew',id:'furl'});
  steerFollower(friendlyVessel.follower,friendlyBoat,playerBoat,0.1,7.5,300*RAD);
  assert.equal(friendlyBoat.sailFore,0);
  assert.equal(friendlyBoat.sailMain,0);
  assert.equal(friendlyBoat.sailMizzen,0);
  assert.equal(friendlyVessel.follower.status,'Furling sails by order');

  // Captain orders 'weather': friendly ship sets [0.35, 0.35, 0] and preserves mizzen=0
  commandFriendlyFleet(vessels,{type:'crew',id:'weather'});
  steerFollower(friendlyVessel.follower,friendlyBoat,playerBoat,0.1,7.5,300*RAD);
  assert.equal(friendlyBoat.sailFore,0.35);
  assert.equal(friendlyBoat.sailMain,0.35);
  assert.equal(friendlyBoat.sailMizzen,0);

  // Enemy ship does NOT furl when leader furls/stops; it keeps fighting canvas to engage
  playerBoat.sailFore=playerBoat.sailMain=playerBoat.sailMizzen=0;
  playerBoat.surgeVelocity=0;
  steerFollower(enemyVessel.follower,enemyBoat,playerBoat,0.1,7.5,300*RAD);
  assert.ok(enemyBoat.sailMain>=0.35,'enemy ship maintains fighting canvas even when player stops');

  // 3. Friendly ship obeys captain gunnery orders & respects friendly-fire line-of-fire check
  const aimToEnemy=selectBroadsideFacingTarget(friendlyBoat,enemyBoat);
  assert.equal(aimToEnemy.side,'starboard');
  commandFriendlyFleet(vessels,{type:'prepare',side:'starboard'});
  assert.equal(friendlyVessel.gunnery.selectedSide,'starboard','friendly ship prepares broadside facing enemy');
  friendlyVessel.gunnery.readyAtQuarters('starboard');
  manGunStationsImmediate(friendlyCompany,friendlyBoat);

  // Place playerBoat directly between friendlyBoat and enemyBoat to test friendly-fire hold
  playerBoat.x=(friendlyBoat.x+enemyBoat.x)*0.5;
  playerBoat.z=(friendlyBoat.z+enemyBoat.z)*0.5;
  assert.equal(isFriendlyInLineOfFire(friendlyBoat,'starboard',[playerBoat]),true,'detects flagship in line of fire');
  commandFriendlyFleet(vessels,{type:'fire',side:'starboard'});
  assert.equal(friendlyVessel.gunnery.ordered,null,'friendly ship holds fire while flagship is in line of fire');
  assert.equal(friendlyVessel.follower.status,'Holding fire (friendly in line)');

  // Move flagship clear of line of fire; stepVesselCombatAI automatically releases the held fire order
  playerBoat.x=0;playerBoat.z=-180;
  stepVesselCombatAI(friendlyVessel,{vessels,dt:0.1});
  assert.equal(friendlyVessel.gunnery.ordered,'starboard','friendly ship executes captain fire order once line of fire clears');

  // 4. Enemy AI autonomously prepares, aims, and fires when broadside bears on player/friendly ship
  enemyVessel.gunnery.readyAtQuarters('port');
  manGunStationsImmediate(enemyCompany,enemyBoat);
  // Position friendlyBoat abeam to port of enemyBoat
  friendlyBoat.x=enemyBoat.x-70;
  friendlyBoat.z=enemyBoat.z;
  const aiDecision=stepVesselCombatAI(enemyVessel,{vessels,dt:0.1});
  assert.equal(aiDecision?.action,'fire','enemy AI autonomously orders broadside fire when guns bear');
  assert.equal(enemyVessel.gunnery.ordered,'port');
  assert.ok(enemyVessel.gunnery.elevation>0,'enemy AI sets ballistic elevation for target range');
});

test('sail, rigging, and mast damage immediately diverges vessel speeds in broadside combat without enemy AI speed-matching',()=>{
  const formation=broadsideFormation(0,{side:'starboard',rangeLengths:1.22});
  const victory=getShipModel('victory');
  const player=copyVessel({...source,modelId:'victory',length:victory.runtime.length,beam:victory.runtime.beam,heading:0,sailFore:0.55,sailMain:0.55,sailMizzen:0.55},{id:'player',modelId:'victory',distance:0,side:0});
  const enemy=copyVessel(player,{id:'escort-1',modelId:'victory',distance:0,side:player.length*formation.side});
  player.surgeVelocity=enemy.surgeVelocity=2.16;
  const enemyFollower=createFollower(formation,{faction:'enemy'});
  const probeP=createVesselProbeState(),probeE=createVesselProbeState();
  createVesselDamageState(player);
  createVesselDamageState(enemy);

  // Inflict mast & sail damage on player (topmasts shot away on fore & main, torn canvas) while under 0.55 fighting sail
  player.damage.hits=6;
  player.damage.sailRips=5;
  player.damage.mastIntegrity.fore=0.45;
  player.damage.mastIntegrity.main=0.40;
  player.damage.mastIntegrity.mizzen=0.65;
  player.damage.mastState={fore:1,main:1,mizzen:0};
  player.damage.rigIntegrity=(0.45+0.40+0.65)/3;

  // Step 20 seconds of broadside sailing
  for(let i=0;i<600;i++){
    const dt=1/30,t=i*dt;
    steerFollower(enemyFollower,enemy,player,dt,7.5,300*RAD);
    stepVessel(player,probeP,dt,t,7.5,300*RAD);
    stepVessel(enemy,probeE,dt,t,7.5,300*RAD);
  }

  assert.ok(player.sailState.set[1]<enemy.sailState.set[1]*0.5,'damaged mainmast under fighting sail deploys significantly less effective canvas');
  assert.ok(enemy.sailMain>=0.50&&enemy.sailMain<=0.56,'undamaged enemy keeps its 0.55 fighting sail instead of throttling down to match crippled player');
  assert.ok(player.surgeVelocity<enemy.surgeVelocity*0.65,`crippled ship slows down (${player.surgeVelocity.toFixed(2)} m/s) while undamaged ship maintains headway (${enemy.surgeVelocity.toFixed(2)} m/s)`);
  assert.ok(enemy.z<player.z-12,`undamaged ship pulls ahead of crippled opponent (enemy z=${enemy.z.toFixed(1)}, player z=${player.z.toFixed(1)})`);
});

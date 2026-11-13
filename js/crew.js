import { footingUnder, restingHeightUnder } from './building-fracture.js';
import { enclosurePlan, insetOutline, traceWalls } from './fort-plan.js';
import { DRESS_MASK_SCALE, DRESS_PIECES, indigenousDress } from './indigenous-dress.js';
import { loadCrewGLB, gltfTRS } from './gltf.js';
import { hullDeck, vesselDeck, HULL_VERTICAL_SCALE, modelDeck, modelHullDeck, modelDeckWidth, vesselVerticalScale } from './hull.js';
import { SAIL_KEYS, sailingState } from './sailing.js';
import { requestYardTransfer } from './lateen.js';
import { assignCrewWork, stepCrewWork, updateCrewGunneryAttendance, updateCrewRowingAttendance, hasExtendedCrewModel, crewSeatedPose, crewDeckHeight, crewHelmStand } from './crew-work.js';
import { poseCrewWork, crewAfloatSeconds } from './crew-pose.js';
import { stepCrewPhysicsState, applyCrewRealism } from './crew-physics.js';
import { applyCrewWounds, clearCrewWounds, recordCrewWound } from './crew-wounds.js';
import { crewClearsRail, crewOpenEdgeInset, crewFeetAwash, sendCrewOverboard, stepCrewOverboard, stepGaleKnockdowns, clearCrewOverboard } from './crew-overboard.js';
import { crewLoseHandsAloft, stepCrewAloftFall } from './crew-aloft.js';
import { createGunneryTools, requestGunneryToolPipelines } from './gunnery-tools.js';
import { requestOnce } from './gpu-program-cache.js';
import { CREW_RENDER, CREW_SHADOW, CREW_POSE_BLEND } from './wgsl/crew.js';
import { NINA_DESIGN } from './models/nina.js';
import { VICTORY_DESIGN } from './models/victory.js';
import { requirePlayableShipModel } from './ship-models.js';
import {ADDITIONAL_DESIGNS,additionalStairFlights} from './models/additional.js';
import {ROWING_DESIGNS} from './models/rowing.js';
import {proceduralDesign} from './models/procedural.js';
import { crewDeckHazard, crewMotionPolicy, crewTurnTowards, crewAdvanceWalk } from './crew-motion.js';
import { crewNavigationStation, crewNavigationRoute, crewRoutineSegmentClear } from './crew-navigation.js';
import { crewTrafficStep, crewTrafficAfterStep } from './crew-traffic.js';
import { crewDeckField, crewDeckRoom } from './crew-deck.js';
import { selectCrewLOD, CREW_LOD_TIERS, createCrewLODs, crewPoseInterval, crewApparentDistance, crewLensZoom, crewSailorTier, crewDrawRuns, crewNeedsCutShader, crewClipOnly, crewBakedPose, crewPoseDue, crewPoseSolved, fortPoseDue } from './crew-lod.js';
import { createCrewClipPipeline, createCrewClipBatch, createCrewTurnPipeline, createCrewTurnBatch } from './crew-clip-pose.js';
import { createCrewSolver, createCrewSolveBatch, createCrewArrowPipeline, createCrewArrowBatch, resolveCrewWoundsOnSkeleton } from './crew-solve.js';
import { attachCrewComponents, crewComponentMaskForActor, packCrewFaceW } from './crew-components.js';

// Authored, disjoint stations keep a full company clear of stairs and masts.
// Policies choose intent. The executor alone changes position and animation.
const CREW_IDENTITIES = [
  {id:'ines',name:'Inês',sex:'female',role:'Captain'},
  {id:'tomas',name:'Tomás',sex:'male',role:'Mate'},
  {id:'beatriz',name:'Beatriz',sex:'female',role:'Boatswain'},
  {id:'duarte',name:'Duarte',sex:'male',role:'Foremast hand'},
  {id:'joao',name:'João',sex:'male',role:'Mainmast hand'},
  {id:'catarina',name:'Catarina',sex:'female',role:'Mainmast hand'},
  {id:'leonor',name:'Leonor',sex:'female',role:'Sailmaker'},
  {id:'rui',name:'Rui',sex:'male',role:'Carpenter'},
  {id:'maria',name:'Maria',sex:'female',role:'Lookout'},
  {id:'afonso',name:'Afonso',sex:'male',role:'Foredeck hand'},
  {id:'isabel',name:'Isabel',sex:'female',role:'Mizzen hand'},
  {id:'pedro',name:'Pedro',sex:'male',role:'Helmsman'},
];
// Identity and costume are reusable; home stations belong to the ship layout.
export const CREW_ROSTER = CREW_IDENTITIES.map(person=>({...person,...NINA_DESIGN.crewStations[person.id]}));
export const CAPTAIN_ORDERS = [
  {id:'full',label:'Make full sail',detail:'Set all canvas. Speed follows the wind.',sails:[1,1,1]},
  {id:'reduced',label:'Reduce sail',detail:'Bring each sail group to half canvas.',sails:[.5,.5,.5]},
  {id:'furl',label:'Furl all sails',detail:'Take in the canvas and coast.',sails:[0,0,0]},
  {id:'weather',label:'Prepare for heavy weather',detail:'Shorten sail and secure the main hatch.',sails:[.2,.2,0]},
  {id:'watch',label:'Resume sea watch',detail:'Return to routine duties; retain the current sail setting.'},
  {id:'transfer',label:'Transfer yards',detail:'Move yards to leeward for this leg. Gathers canvas; takes about a minute.'},
];
const CREW_SHIRTS=[[.55,.47,.31],[.23,.31,.36],[.38,.15,.10],[.30,.32,.18],[.48,.36,.22],[.38,.38,.35]];
// Pirate / Sea-Rover brown and black attire (soot black, dark espresso leather, saddle brown, charcoal black, umber, walnut brown).
export const PIRATE_SHIRTS=Object.freeze([
  [.045,.042,.040],
  [.19,.11,.058],
  [.075,.070,.068],
  [.27,.15,.078],
  [.055,.052,.050],
  [.23,.13,.068],
]);
export const PIRATE_TROUSERS=Object.freeze([
  [.038,.036,.035],
  [.13,.078,.044],
  [.062,.058,.055],
  [.17,.10,.056],
]);
// Native American / Indigenous attire palettes (smoked buckskin tan, annatto/bija red-ochre,
// unbleached woven cotton, cedar-bark russet, wampum indigo-slate, soft deerskin buff).
export const INDIGENOUS_SHIRTS=Object.freeze([
  [.46,.32,.18],
  [.48,.14,.08],
  [.62,.54,.42],
  [.36,.20,.11],
  [.16,.24,.32],
  [.52,.39,.24],
]);
export const INDIGENOUS_TROUSERS=Object.freeze([
  [.24,.15,.09],
  [.18,.16,.14],
  [.34,.14,.09],
  [.28,.19,.11],
]);
export const INDIGENOUS_APPEARANCES=Object.freeze([
  {skin:[168,104,68], hair:[18,14,12], face:[1.04,1.02,.004,.94]},
  {skin:[156,94,60],  hair:[15,12,11], face:[1.05,1.01,.003,.92]},
  {skin:[178,114,76], hair:[20,16,14], face:[1.03,1.00,.005,.95]},
  {skin:[145,86,54],  hair:[16,13,12], face:[1.06,1.03,.002,.91]},
  {skin:[184,122,82], hair:[22,17,14], face:[1.02,.99,.004,.96]},
  {skin:[162,98,64],  hair:[19,15,13], face:[1.04,1.01,.003,.93]},
]);
const INDIGENOUS_NAMES=Object.freeze({
  female:['Anacaona','Higuanamá','Atabey','Guanina','Wawaloam','Awashonks','Weetamoo','Jacaranda','Bartira','Paraguaçu','Cacicazgo','Nita'],
  male:['Agüeybaná','Hatuey','Caonabo','Guarionex','Caguax','Samoset','Tisquantum','Madockawando','Passaconaway','Massasoit','Cunhambebe','Arariboia'],
});
export function isPirateVessel(boat){
  if(!boat)return false;
  if(boat.isPirate===true)return true;
  if(boat.colors==='jolly-roger'||boat.colors==='blood-flag')return true;
  if(boat.battleColors==='jolly-roger'||boat.battleColors==='blood-flag')return true;
  if(boat.faction==='enemy'&&!boat.captured)return true;
  return false;
}
// Every actor back on their feet at their post, for a new ship in a pooled hull.
export function reviveCompany(company){
  if(!company?.crew)return;
  for(const s of company.crew){
    s.casualtyState='able';s.wounded=null;s.health=1;s.strength=1;s.woundSeverity=0;s.scorchAmount=0;s.knockdownTimer=0;
    s.job=null;s.aloftFall=null;s.seatedPose=null;s.climbPitch=0;s.navigationPath=null;s.navigationKey=null;s.phys=undefined;
    clearCrewWounds(s);
    clearCrewOverboard(s);
  }
  company.gunneryActive=false;company.pending=false;company.morale=1;
  company.gunAbstractCrew?.clear();company.gunRouteFailSince?.clear();company.revision=(company.revision??0)+1;
}

export function applyPirateCrewAttire(company,pirate=true){
  if(!company?.crew)return company;
  company.pirateAttire=Boolean(pirate);
  for(let i=0;i<company.crew.length;i++){
    const s=company.crew[i];
    if(pirate){
      s.shirt=PIRATE_SHIRTS[i%PIRATE_SHIRTS.length];
      s.trousers=PIRATE_TROUSERS[i%PIRATE_TROUSERS.length];
      s.attireTheme='pirate-brown-black';
    }else{
      s.shirt=CREW_SHIRTS[i%6];
      s.trousers=i%3?[.095,.12,.15]:[.16,.10,.065];
      s.attireTheme='standard';
    }
    if(!s.indigenous)s.compMask=crewComponentMaskForActor(s,i,{pirate});
  }
  return company;
}
// Individual art direction, independent of role and policy. Colours are sRGB bytes;
// face = head width, jaw width, nose projection (metres), eye opening.
// The stylized company intentionally includes Black, white and East Asian
// appearances, including two redheads; it is not a historical demographic claim.
const CREW_APPEARANCES={
  ines:    {skin:[126,79,56], hair:[28,20,18], face:[1.04,1.02,-.002,.96]},
  tomas:   {skin:[227,180,151],hair:[67,43,29], face:[.97,1.03,.003,1.02]},
  beatriz: {skin:[218,166,120],hair:[22,20,19], face:[1.06,.96,-.010,.80]},
  duarte:  {skin:[89,53,39],  hair:[22,18,16], face:[1.05,1.04,-.003,1.00]},
  joao:    {skin:[185,133,94],hair:[29,24,21], face:[1.07,.98,-.012,.78]},
  catarina:{skin:[237,191,163],hair:[164,70,26],face:[.99,.95,.002,1.02]},
  leonor:  {skin:[99,62,45],  hair:[37,24,19], face:[1.02,.97,-.004,.94]},
  rui:     {skin:[220,166,132],hair:[143,54,20],face:[1.02,1.03,.005,.98]},
  maria:   {skin:[230,181,137],hair:[39,29,24],face:[1.04,.98,-.008,.84]},
  afonso:  {skin:[153,96,64], hair:[30,23,18], face:[1.03,1.01,-.001,.96]},
  isabel:  {skin:[213,158,129],hair:[186,148,81],face:[.96,.98,.001,1.00]},
  pedro:   {skin:[205,153,111],hair:[24,22,21],face:[1.06,1.00,-.009,.82]},
};
const crewLinearColour=rgb=>rgb.map(byte=>{const v=byte/255;return v<=.04045?v/12.92:((v+.055)/1.055)**2.4;});
export const CREW_ACTOR_FLOATS=36;
const crewAdditionalNames={
  female:['Inês','Beatriz','Catarina','Leonor','Maria','Isabel','Ama','Lin','Freydís','Lucía','Runa','Mei','Amina','Elena','Nia','Astrid','Clara','Sofia','Teresa','Margarida','Guiomar','Constança','Violante','Branca','Harriet','Charlotte','Eleanor','Frances','Hannah','Abigail','Matilda','Susannah','Lydia','Phoebe','Rosamund','Dorothea','Cordelia','Georgiana','Lavinia','Penelope'],
  male:['Tomás','Duarte','João','Rui','Afonso','Pedro','Kofi','Li','Eirik','Mateo','Soren','Jin','Kwame','Diego','Tariq','Leif','Gonçalo','Fernão','Vasco','Diogo','Nuno','Álvaro','Cristóvão','Bartolomeu','William','Jack','Samuel','Edward','Henry','George','Richard','Robert','Charles','Arthur','Benjamin','Nathaniel','Horatio','Cuthbert','Barnaby','Tobias'],
};
function crewStationIdentity(key,index){
  const named=CREW_IDENTITIES.find(s=>s.id===key);if(named)return {...named,identityId:named.id};
  const sex=index%2?'male':'female',n=Math.floor(index/2),pool=CREW_IDENTITIES.filter(s=>s.sex===sex),identity=pool[n%pool.length];
  return {...identity,id:key,identityId:identity.id,name:crewAdditionalNames[sex][n%crewAdditionalNames[sex].length]};
}
export function createCompany(policy=deckhandDecision,modelId='nina',options={}) {
  const model=requirePlayableShipModel(modelId);
  // Twelve rendered workers are a representative watch on larger ships unless
  // fullWatch is enabled (default in WebGPU createCrew), which populates a
  // vessel's full weather-deck and gun-deck watch stations across all ships.
  const extended=hasExtendedCrewModel(model.id);
  const baseStations=extended?Object.entries(model.crewStations):CREW_ROSTER.map(identity=>[identity.id,model.crewStations[identity.id]]);
  const extraStations=(options?.fullWatch&&model.supplementalCrewStations)
    ?Object.entries(model.supplementalCrewStations):[];
  const stations=[...baseStations,...extraStations];
  const activeControls=extended?['fore','main','mizzen'].map((name,index)=>model.rig.sails.some(s=>s.controlGroup===name)?index:-1).filter(i=>i>=0):[0,1,2];
  const stationBoat={modelId:model.id,model,length:model.runtime.length,beam:model.runtime.beam};
  const manifestCrew=model.id==='victory'?820:extended?proceduralDesign(model.id).loading.crew:(ADDITIONAL_DESIGNS[model.id]?.loading?.crew??12);
  const initialPirate=Boolean(options?.pirate||isPirateVessel(options?.boat));
  const initialIndigenous=Boolean(options?.indigenous||model.id==='taino-canoe');
  return {modelId:model.id,activeControls,representativeWatch:options?.fullWatch?false:stations.length<manifestCrew,order:'watch',revision:0,pending:false,pirateAttire:initialPirate,indigenousAttire:initialIndigenous,crew:stations.map(([key,station],i)=>{
    const identity=(extended||i>=CREW_ROSTER.length)?crewStationIdentity(key,i):CREW_ROSTER[i],person={...identity,...station,stationKey:key};
    if(initialIndigenous){
      const sexPool=INDIGENOUS_NAMES[person.sex]??INDIGENOUS_NAMES.male;
      person.name=sexPool[i%sexPool.length];
    }
    person.route??=[person.z,person.z];person.roles??=[person.role.toLowerCase()];
    if(extended&&Object.hasOwn(ROWING_DESIGNS,model.id)&&person.role==='Passenger'&&!stations.slice(0,i).some(([,p])=>p.role==='Passenger')){person.role='Captain';person.roles=['captain'];}
    // Keep short routine rounds on their current deck. Longer work trips use
    // the model's stair paths, including the exact ramp elevations.
    if(ADDITIONAL_DESIGNS[model.id]&&person.route[0]!==person.route[1]){
      const flights=additionalStairFlights(model.id),end=person.route[1],direction=Math.sign(end-person.z);
      const obstacle=flights.filter(f=>f.side===(Math.sign(person.x)||1)&&(direction>0?f.z0>person.z&&f.z0<=end:f.z1<person.z&&f.z1>=end)).sort((a,b)=>direction*(a.z0-b.z0))[0];
      if(obstacle)person.route=[person.z,direction>0?Math.max(person.z,obstacle.z0-.08):Math.min(person.z,obstacle.z1+.08)];
    }
    // Resolve a clear post before the first visible pose. Never project an
    // existing actor to a new location when a gun moves or an order changes.
    if(person.role!=='Helmsman'){
      const post=crewNavigationStation([person.x,crewDeckHeight(stationBoat,person.z,person.x),person.z],stationBoat);
      if(!post)throw Error('No clear initial crew post: '+model.id+'/'+person.id);
      const shift=post[2]-person.z;person.x=post[0];person.z=post[2];person.route=person.route.map(z=>z+shift);
    }
    const s=createDeckhand(policy);Object.assign(s,person,{crewIndex:i,route:[...person.route],target:person.route[1],wait:i*.37,
      time:i*.43,walkTime:i*.27,patrolX:person.x,yaw:person.yaw??(i%2?Math.PI:0),decisionIn:i/24,company:true,strength:1.0,indigenous:initialIndigenous});
    const sx0=stationBoat.beam/3.6,sy0=vesselVerticalScale(stationBoat),sz0=stationBoat.length/12,y0=crewDeckHeight(stationBoat,s.z,s.x);
    s.navigationY=y0;s.position[0]=s.x*sx0;s.position[1]=y0*sy0+.028;s.position[2]=s.z*sz0;
    s.scale.fill((person.sex==='female'?.99:.96)*(1+(i%3-1)*.025));
    Object.assign(s.observation,{sailorId:s.id,role:s.role,captainOrder:'watch',orderRevision:0});
    const look=initialIndigenous?INDIGENOUS_APPEARANCES[i%INDIGENOUS_APPEARANCES.length]:CREW_APPEARANCES[s.identityId??s.id];
    const pirate=initialPirate&&!initialIndigenous;
    s.shirt=initialIndigenous?INDIGENOUS_SHIRTS[i%INDIGENOUS_SHIRTS.length]:pirate?PIRATE_SHIRTS[i%PIRATE_SHIRTS.length]:CREW_SHIRTS[i%6];
    s.skin=crewLinearColour(look.skin);
    s.trousers=initialIndigenous?INDIGENOUS_TROUSERS[i%INDIGENOUS_TROUSERS.length]:pirate?PIRATE_TROUSERS[i%PIRATE_TROUSERS.length]:(i%3?[.095,.12,.15]:[.16,.10,.065]);
    s.attireTheme=initialIndigenous?'indigenous':pirate?'pirate-brown-black':'standard';
    s.hair=crewLinearColour(look.hair);
    s.face=[look.face[0],look.face[1],look.face[2],look.face[3]+(initialIndigenous?2.0:0)];
    s.compMask=initialIndigenous?0:crewComponentMaskForActor(s,i,{pirate});
    return s;
  })};
}
export function issueCaptainOrder(company,boat,id) {
  const order=CAPTAIN_ORDERS.find(o=>o.id===id);if(!order)return false;
  if(id==='transfer')return hasExtendedCrewModel(boat.modelId)||boat.modelId==='victory'||(ADDITIONAL_DESIGNS[boat.modelId]&&!ADDITIONAL_DESIGNS[boat.modelId].surfaces.some(s=>s.kind==='lateen'))?false:requestYardTransfer(sailingState(boat));
  if(order.sails&&hasExtendedCrewModel(boat.modelId)&&!company.activeControls.length&&id!=='weather')return false;
  company.order=id;company.revision++;company.pending=!!order.sails;
  boat.crewSailRate=new Float64Array(3);
  if(order.sails){if(company.activeControls.length)boat.propulsion='sail';for(const i of company.activeControls)boat[SAIL_KEYS[i]]=order.sails[i];}
  for(const s of company.crew)s.decisionIn=0;
  return true;
}
export function stepCompany(company,boat,dt,wind) {
  company.boat=boat;if(boat)boat.crewCompany=company;
  const shouldBePirate=isPirateVessel(boat)&&!company.indigenousAttire;
  if(Boolean(company.pirateAttire)!==shouldBePirate)applyPirateCrewAttire(company,shouldBePirate);
  const order=CAPTAIN_ORDERS.find(o=>o.id===company.order),sails=sailingState(boat);
  // Manual sail settings supersede an outstanding broad order without stale reapplication.
  if(order.sails&&company.activeControls.some(i=>Math.abs(order.sails[i]-boat[SAIL_KEYS[i]])>.001)){
    company.order='watch';company.pending=false;company.revision++;
  } else company.pending=!!order.sails&&company.activeControls.some(i=>Math.abs(order.sails[i]-sails.set[i])>.01);
  dt=Math.max(0,Math.min(.1,Number.isFinite(dt)?dt:0));
  company.rigManeuver=sails.maneuver?.stage??null;
  company.workTime=(company.workTime??0)+dt;crewLoseHandsAloft(company,boat);assignCrewWork(company,boat);
  for(const s of company.crew)s._cachedDeckY=s.job?.position?.[1]??s.navigationY??crewDeckHeight(boat,s.z,s.x);
  stepGaleKnockdowns(boat,company,wind,dt);
  for(const s of company.crew){
    if(s.overboard){
      if(!s.overboard.gone){
        s.time=(s.time??0)+dt*1.35;
        stepCrewOverboard(boat,s,dt);
        if(s.overboard)stepCrewPhysicsState(s,boat,dt,company);
      }
      continue;
    }
    if(s.aloftFall){
      stepCrewAloftFall(boat,s,dt);
      stepCrewPhysicsState(s,boat,dt,company);
      continue;
    }
    if(boat?.damage?.sunk||(boat?.damage?.floodingSinkage??0)>0.45){
      // The sea takes a hand when it stands over his feet where he is, not where her middle is.
      if(s.visible!==false&&crewFeetAwash(boat,s)){
        const side=Math.sign(s.x||s.position[0]||(((s.crewIndex??0)%2)?1:-1))||1;
        const wasDead=s.casualtyState==='fallen';
        if(sendCrewOverboard(boat,s,{side,outward:0.45,cause:'sinking',dead:wasDead,hurt:s.casualtyState==='wounded',awash:true})){
          stepCrewOverboard(boat,s,dt);
          if(s.overboard)stepCrewPhysicsState(s,boat,dt,company);
          continue;
        }
      }
    }
    // Apply blast knockback velocity (from cannon impacts, magazine explosions or a sea) within deck bounds
    if(dt>0&&((Math.abs(s.knockbackVx??0)>1e-3)||(Math.abs(s.knockbackVz??0)>1e-3))){
      const damp=Math.exp(-dt*5.5);
      const nextX=s.x+(s.knockbackVx??0)*dt;
      const nextZ=s.z+(s.knockbackVz??0)*dt;
      const halfW=Math.max(0.18,modelDeckWidth(boat,nextZ)-0.34/Math.max(0.5,boat.beam/3.6));
      // At the rail a body either goes over or stops against it.
      if(Math.abs(nextX)>halfW&&s.position){
        const side=Math.sign(nextX),outward=Math.abs(s.knockbackVx??0)*(boat.beam/3.6);
        if(Math.sign(s.knockbackVx??0)===side&&crewClearsRail(boat,nextZ,side,outward)&&sendCrewOverboard(boat,s,{side,outward,cause:s.knockbackCause??'blast'}))continue;
      }
      s.x=Math.max(-halfW,Math.min(halfW,nextX));
      s.z=Math.max(-4.6,Math.min(5.2,nextZ));
      s.knockbackVx=(s.knockbackVx??0)*damp;
      s.knockbackVz=(s.knockbackVz??0)*damp;
    }
    // Check proximity to active shipboard fires for heat panic & soot/scorch accumulation
    const fires=boat?.damage?.fires;
    let nearFire=0;
    if(Array.isArray(fires)&&fires.length>0){
      const sx=boat.beam/3.6,sz=boat.length/12;
      for(const f of fires){
        const fx=f.localPosition?.[0]??0,fz=f.localPosition?.[2]??0;
        const d=Math.hypot(s.x*sx-fx,s.z*sz-fz);
        if(d<3.2){
          const heat=Math.max(0,1-d/3.2)*(f.intensity??0.6);
          if(heat>nearFire)nearFire=heat;
        }
      }
    }
    s.firePanic=nearFire>0.18?Math.min(1,nearFire):Math.max(0,(s.firePanic??0)-dt*1.5);
    if(nearFire>0.25&&dt>0){
      s.scorchAmount=Math.min(1,(s.scorchAmount??0)+nearFire*dt*0.22);
    }
    if(s.casualtyState==='fallen'){
      s.job=null;s.observation.job=null;s.seatedPose=null;s.walk=0;s.brace=0;
      s.climbPitch=(s.fallDir??1)*Math.PI*0.47;s.yaw=s.collapseYaw??s.yaw??0;
      stepDeckhand(s,boat,0,wind,company);
      stepCrewPhysicsState(s,boat,dt,company);
      continue;
    }
    if((s.knockdownTimer??0)>0){
      s.knockdownTimer=Math.max(0,s.knockdownTimer-dt);
      const recover=s.knockdownTimer<0.45?s.knockdownTimer/0.45:1;
      s.job=null;s.observation.job=null;s.seatedPose=null;s.walk=0;
      s.climbPitch=(s.fallDir??1)*Math.PI*0.44*recover;
      stepDeckhand(s,boat,0,wind,company);
      stepCrewPhysicsState(s,boat,dt,company);
      continue;
    }
    const sailorDt=s.casualtyState==='wounded'?dt*0.55:dt;
    s.observation.wind=wind;s.observation.roll=boat.roll??0;s.observation.rollRate=boat.rollVelocity??0;s.observation.captainOrder=company.order;s.observation.orderRevision=company.revision;
    s.order=company.gunneryActive||company.pending||company.order==='weather'?'standby':'patrol';
    if(s.job){s.seatedPose=null;s.moisturePoints=null;s.navigationPath=null;s.navigationKey=null;s.navigationY=null;}
    const hadJob=!!s.job;
    if(!stepCrewWork(s,company,boat,sailorDt)){s.observation.job=null;stepDeckhand(s,boat,hadJob?0:sailorDt,wind,company);}
    stepCrewPhysicsState(s,boat,sailorDt,company);
  }
  crewTrafficAfterStep(company,boat,dt);
  updateCrewGunneryAttendance(company,boat);
  updateCrewRowingAttendance(company,boat);
  // Hazard/policy changes above can alter attendance during this step. Resolve
  // every seated target from the final Set used by blades and physical forces.
  if(Object.hasOwn(ROWING_DESIGNS,boat.modelId))for(const s of company.crew)if(!s.job&&s.casualtyState!=='fallen')s.seatedPose=crewSeatedPose(s,boat);
  return company;
}
function boatHatchPending(company){return company.crew.some(s=>s.job?.kind==='hatch'&&s.job.stage!=='return');}
export function companyStatus(company,boat=company?.boat) {
  const dmg=boat?.damage;
  if(dmg?.surrendered)return 'Struck colors (Surrendered 🏳️) · hands standing down';
  const cas=dmg?.crewCasualties;
  const casSuffix=cas&&(cas.killed>0||cas.wounded>0)
    ?` · ${cas.able}/${cas.total} able (${cas.wounded} wounded, ${cas.killed} fallen) · Morale ${Math.round((dmg.battleMorale??1)*100)}% (${dmg.moraleState??'steady'})`
    :'';
  const bracing=company.crew.filter(s=>s.casualtyState!=='fallen'&&s.intent==='brace').length;
  if(bracing)return `${bracing} hands bracing · ${CAPTAIN_ORDERS.find(o=>o.id===company.order).label}${casSuffix}`;
  if(company.rigManeuver)return `Transferring yards · gathering canvas and handling spars${casSuffix}`;
  if(company.order==='weather'&&(boatHatchPending(company)))return `Prepare for heavy weather · securing canvas and hatch${casSuffix}`;
  if(company.pending)return `${CAPTAIN_ORDERS.find(o=>o.id===company.order).label} · handling sails${casSuffix}`;
  return (company.order==='watch'?`Sea watch · ${company.crew.length} ${company.representativeWatch?'hands representing the watch':'aboard'}${company.crew.some(s=>s.job?.kind==='lookout'&&s.job.stage==='working')?' · lookout aloft':''}`:`${CAPTAIN_ORDERS.find(o=>o.id===company.order).label} · sail setting reached`)+casSuffix;
}
export function deckhandDecision(observation) {
  if(observation.hazard)return 'brace';
  if(observation.job)return 'work';
  return observation.order==='patrol'?'patrol':'standby';
}
export function createDeckhand(policy=deckhandDecision) {
  return {x:-.95,z:-1.9,yaw:0,target:.1,wait:1,time:0,walkTime:0,walkDistance:0,walk:0,brace:0,
    decisionIn:0,intent:'standby',order:'patrol',policy,visible:true,
    observation:{order:'patrol',hazard:false,roll:0,rollRate:0,wind:0},
    transform:new Float32Array(16),position:new Float32Array(3),rotation:new Float32Array(4),scale:new Float32Array([.95,.95,.95])};
}
// A hand left standing at an edge with no rail moves in from it, wherever the order had him.
function crewStepInboard(s,boat,dt){
  if(!boat.damage?.fracture?.brokenCount||s.role==='Helmsman'||s.roles?.includes('helmsman')||s.seatedPose||s.visible===false)return false;
  const side=Math.sign(s.x);if(!side)return false;
  const inset=crewOpenEdgeInset(boat,s.z,side);if(!inset)return false;
  const sx=boat.beam/3.6,keep=Math.max(0,modelDeckWidth(boat,s.z)-inset-.34/sx);
  if(Math.abs(s.x)<=keep)return false;
  const motion=crewMotionPolicy(boat,{hazard:s.observation.hazard}),step=motion.speedMetresPerSecond*dt/sx;
  s.x=side*Math.max(keep,Math.abs(s.x)-step);
  s.yaw=crewTurnTowards(s.yaw,-side*Math.PI/2,dt,motion.turnRadiansPerSecond);
  crewAdvanceWalk(s,step*sx,{strideMetres:motion.strideMetres});
  return true;
}
// How long a sailor on his rounds will stand stopped, in seconds.
const CREW_PATROL_PATIENCE=2.5,CREW_ROUND_ROOM_M=.44,CREW_PATROL_TURN_BACK_M=1.3;
function crewPatrolTrafficClear(s,boat,x0,z0,x1,z1){
  const sx=boat.beam/3.6,sz=boat.length/12;
  return crewRoutineSegmentClear(s,boat,[x0/sx,crewDeckHeight(boat,z0/sz,x0/sx),z0/sz],[x1/sx,crewDeckHeight(boat,z1/sz,x1/sx),z1/sz]);
}
// Back onto his round from wherever passing someone has left him. Failing that, the round is over.
function crewPatrolRejoin(s,boat,x,z){
  const sx=boat.beam/3.6,sz=boat.length/12,here=[x/sx,crewDeckHeight(boat,z/sz,x/sx),z/sz],to=s.navigationPath?.[s.navigationCursor];
  // A man on his rounds can always get back to them: straight to his next point, or by ending the leg where he is.
  if(!(to&&crewRoutineSegmentClear(s,boat,here,to)))crewFinishPatrol(s);
  return true;
}
// What a man on his rounds asks of the traffic, written again for each of them rather than made each time.
const crewPatrolStepAsked={x:0,z:0,toX:0,toZ:0,speed:0,dt:0,segmentClear:crewPatrolTrafficClear,rejoin:crewPatrolRejoin};
function crewFinishPatrol(s){
  s.target=s.route?(s.target===s.route[1]?s.route[0]:s.route[1]):s.target>0?-2.2:.1;s.wait=2.5;s.navigationPath=null;
}
function crewPatrolMotion(s,boat,dt,company){
  if(s.intent!=='patrol'||s.visible===false||s.route&&s.route[0]===s.route[1])return false;
  if(s.wait>0){s.wait=Math.max(0,s.wait-dt);return false;}
  const sx=boat.beam/3.6,sz=boat.length/12,sy=vesselVerticalScale(boat),x=s.home?.[0]??s.patrolX??s.x;
  // A shot can close a route that was open, so each break asks again.
  const key=[boat.modelId??'nina',boat.length,boat.beam,s.target,x,boat.damage?.fracture?.revision??0].join('/');
  const from=[s.x,crewDeckHeight(boat,s.z,s.x),s.z];
  if(s.navigationKey!==key){
    // Relocate an unsafe destination, never an actor already on deck. Static
    // no-route results share the same cache key instead of rebuilding each frame.
    const to=crewNavigationStation([x,crewDeckHeight(boat,s.target,x),s.target],boat);
    s.navigationPath=to?crewNavigationRoute([from,to],boat):null;s.navigationKey=key;s.navigationCursor=0;
  }
  const path=s.navigationPath;if(!path?.length)return false;
  // A hand at a tight post stays at it: a round goes only where the mesh leaves room for a body, arms and all.
  const field=company?crewDeckField(boat):null;
  if(field&&crewDeckRoom(field,boat,from[0]*sx,from[2]*sz)<CREW_ROUND_ROOM_M){s.navigationPath=null;return false;}
  while(s.navigationCursor<path.length&&Math.hypot((path[s.navigationCursor][0]-from[0])*sx,(path[s.navigationCursor][1]-from[1])*sy,(path[s.navigationCursor][2]-from[2])*sz)<1e-7)s.navigationCursor++;
  const target=path[s.navigationCursor];
  if(!target){crewFinishPatrol(s);return false;}
  const dx=(target[0]-from[0])*sx,dy=(target[1]-from[1])*sy,dz=(target[2]-from[2])*sz,horizontal=Math.hypot(dx,dz),distance=Math.hypot(horizontal,dy);
  const motion=crewMotionPolicy(boat,{grade:horizontal>1e-8?dy/horizontal:0,hazard:s.observation.hazard});
  const asked=crewPatrolStepAsked;asked.x=from[0]*sx;asked.z=from[2]*sz;asked.toX=target[0]*sx;asked.toZ=target[2]*sz;asked.speed=motion.speedMetresPerSecond;asked.dt=dt;
  const passing=company?crewTrafficStep(s,company,boat,asked):null;
  if(passing){
    const walked=Math.hypot(passing.x-from[0]*sx,passing.z-from[2]*sz);
    // A round is nothing to wait for, or to go out of the way for: he turns back from someone standing in it.
    if(passing.stander&&Math.hypot(passing.stander.position[0]-from[0]*sx,passing.stander.position[2]-from[2]*sz)<CREW_PATROL_TURN_BACK_M){s.patrolStopped=0;s.trafficOffRoute=false;crewFinishPatrol(s);return false;}
    s.patrolStopped=walked<1e-4?(s.patrolStopped??0)+dt:0;
    if(s.patrolStopped>CREW_PATROL_PATIENCE){s.patrolStopped=0;crewFinishPatrol(s);return false;}
    if(walked<1e-5)return false;
    const X=passing.x/sx,Z=passing.z/sz,Y=crewDeckHeight(boat,Z,X);
    s.x=X;s.z=Z;s.navigationY=Y;s._cachedDeckY=Y;s.patrolClearPath=null;crewAdvanceWalk(s,walked,{strideMetres:motion.strideMetres});
    const goal=path[s.navigationCursor];
    if(goal&&Math.hypot((goal[0]-X)*sx,(goal[2]-Z)*sz)<.2&&++s.navigationCursor>=path.length)crewFinishPatrol(s);
    return true;
  }
  const desired=horizontal>1e-8?Math.atan2(dx,dz):s.yaw;s.yaw=crewTurnTowards(s.yaw,desired,dt,motion.turnRadiansPerSecond);
  const angle=Math.atan2(Math.sin(desired-s.yaw),Math.cos(desired-s.yaw));
  const travel=Math.min(distance,motion.speedMetresPerSecond*Math.max(0,Math.cos(angle))*dt),q=distance>1e-8?travel/distance:0;
  const next=from.map((v,i)=>v+(target[i]-v)*q);
  // Routine rounds remain on one weather deck. Its curved sheer is not the
  // endpoint chord; actual stair/ramp travel belongs to the job executor.
  next[1]=crewDeckHeight(boat,next[2],next[0]);
  if(!travel)return false;
  // A round does not go where the mesh has no room for a body, whatever was asked of it. He turns back, or stands if he has nowhere.
  if(field&&crewDeckRoom(field,boat,next[0]*sx,next[2]*sz)<CREW_ROUND_ROOM_M){
    s.patrolStopped=0;crewFinishPatrol(s);
    return false;
  }
  // The way to the next point of his round need only be asked about once, until something is shot away.
  const revision=boat.damage?.fracture?.revision??0;
  if(s.patrolClearPath!==path||s.patrolClearCursor!==s.navigationCursor||s.patrolClearRevision!==revision){
    if(crewRoutineSegmentClear(s,boat,from,target)){s.patrolClearPath=path;s.patrolClearCursor=s.navigationCursor;s.patrolClearRevision=revision;}
    else if(!crewRoutineSegmentClear(s,boat,from,next))return false;
  }
  s.patrolStopped=0;
  const acceptedDistance=Math.hypot((next[0]-from[0])*sx,(next[1]-from[1])*sy,(next[2]-from[2])*sz);
  s.x=next[0];s.z=next[2];s.navigationY=next[1];s._cachedDeckY=next[1];crewAdvanceWalk(s,acceptedDistance,{strideMetres:motion.strideMetres});
  if(distance<=travel+1e-7&&++s.navigationCursor>=path.length)crewFinishPatrol(s);
  return true;
}
function stepProceduralDeckhand(s,boat,dt,wind,company){
  const isDown=s.casualtyState==='fallen'||(s.knockdownTimer??0)>0;
  s.time+=dt;if(!isDown)s.climbPitch=0;
  const o=s.observation;o.wind=wind;o.order=s.order;o.roll=boat.roll??0;o.rollRate=boat.rollVelocity??0;
  o.hazard=crewDeckHazard(boat,wind,s.intent==='brace');s.decisionIn-=dt;
  if(o.hazard||s.decisionIn<=0){let intent;try{intent=s.policy(o);}catch{intent=deckhandDecision(o);}s.intent=o.hazard?'brace':['patrol','standby','brace'].includes(intent)?intent:deckhandDecision(o);s.decisionIn=.5;}
  s.brace+=(Number(o.hazard)-s.brace)*(1-Math.exp(-dt*8));
  const seated=isDown?null:crewSeatedPose(s,boat);s.seatedPose=seated;
  if(seated){
    s.yaw=seated.body.yaw;s.walk=0;
    s.position.set([s.x*boat.beam/3.6,crewDeckHeight(boat,s.z,s.x)*vesselVerticalScale(boat)+.028,s.z*boat.length/12]);
    const seat=seated.seat,feet=seated.feet;s.moisturePoints=[feet[0].map((v,i)=>(v+feet[1][i])*.5),seat.map((v,i)=>v+(i===1?.10:0)),seat.map((v,i)=>v+(i===1?.50:0)),seat.map((v,i)=>v+(i===1?.95:0))];
  }else{
    const moving=isDown?false:crewStepInboard(s,boat,dt)||crewPatrolMotion(s,boat,dt,company);
    s.walk+=(Number(moving)-s.walk)*(1-Math.exp(-dt*8));s.moisturePoints=null;
    const proneLift=isDown?0.11*Math.abs(Math.sin(s.climbPitch??0)):0;
    s.position.set([s.x*boat.beam/3.6,(s.navigationY??crewDeckHeight(boat,s.z,s.x))*vesselVerticalScale(boat)+.028+proneLift,s.z*boat.length/12]);
    if(!isDown&&s.roles?.includes('helmsman'))s.yaw=proceduralDesign(boat.modelId).crewStations[s.stationKey??s.id]?.yaw??s.yaw;
  }
  const sy=Math.sin(s.yaw/2),cy=Math.cos(s.yaw/2),sx=Math.sin((s.climbPitch??0)/2),cx=Math.cos((s.climbPitch??0)/2);
  s.rotation.set([cy*sx,sy*cx,-sy*sx,cy*cx]);gltfTRS(s.transform,s.position,s.rotation,s.scale);return s;
}
export function stepDeckhand(s,boat,dt,wind=0,company=null) {
  dt=Math.max(0,Math.min(.1,Number.isFinite(dt)?dt:0));
  if(hasExtendedCrewModel(boat.modelId))return stepProceduralDeckhand(s,boat,dt,wind,company);
  const isDown=s.casualtyState==='fallen'||(s.knockdownTimer??0)>0;
  s.time+=dt;if(!isDown)s.climbPitch=0;
  const o=s.observation;o.order=s.order;o.roll=boat.roll??0;o.rollRate=boat.rollVelocity??0;o.wind=wind;
  // Hysteresis avoids oscillating between walking and bracing near the threshold.
  o.hazard=crewDeckHazard(boat,wind,s.intent==='brace');
  s.decisionIn-=dt;
  if(o.hazard||s.decisionIn<=0){
    let decision;try{decision=s.policy(o);}catch{decision=deckhandDecision(o);}
    s.intent=['patrol','standby','brace'].includes(decision)?decision:deckhandDecision(o);s.decisionIn=.5;
    if(o.hazard)s.intent='brace';
  }
  // Preserve human proportions when resizing the hull; do not squeeze a person
  // through a walkway narrower than their shoulders.
  s.visible=!s.obliterated&&boat.beam>=(s.company?3.2:2.8)&&boat.length>=(s.company?10.5:8);
  const moving=isDown?false:crewStepInboard(s,boat,dt)||crewPatrolMotion(s,boat,dt,company),lengthScale=boat.length/12;
  const blend=1-Math.exp(-dt*8);s.walk+=(Number(moving)-s.walk)*blend;s.brace+=(Number(s.intent==='brace')-s.brace)*blend;
  if((boat.modelId==='victory'||ADDITIONAL_DESIGNS[boat.modelId])&&s.role!=='Helmsman'){
    const width=Math.max(0,modelDeckWidth(boat,s.z)-.34/(boat.beam/3.6));s.x=Math.max(-width,Math.min(width,s.x));
  }
  const proneLift=isDown?0.11*Math.abs(Math.sin(s.climbPitch??0)):0;
  if(!isDown&&s.role==='Helmsman'&&boat.modelId==='victory'){
    const station=boat.model?.crewStations?.[s.id]??requirePlayableShipModel('victory').crewStations[s.id];
    s.x=station.x;s.z=station.z;s.yaw=station.yaw??Math.PI;s.climbPitch=0;
    s.position.set([s.x*boat.beam/3.6,modelDeck(boat,s.z)*vesselVerticalScale(boat)+.028,s.z*lengthScale]);
  }else if(!isDown&&s.role==='Helmsman'&&ADDITIONAL_DESIGNS[boat.modelId]){
    const design=ADDITIONAL_DESIGNS[boat.modelId],stand=crewHelmStand(boat);
    // Stand beside the real handle. The boat's own weather deck sets feet;
    // neither the Niña's 2.3-high quarterdeck nor its tiller distance is reused.
    s.x=stand.x/(boat.beam/3.6);s.z=stand.z/lengthScale;s.yaw=stand.yaw;s.climbPitch=0;
    const station=design.crewStations[s.id];
    if(Math.abs(modelDeck(boat,s.z)-modelDeck(boat,station.z))>.15){s.x=station.x;s.z=station.z;s.yaw=station.yaw??0;}
    s.position.set([s.x*boat.beam/3.6,modelDeck(boat,s.z)*vesselVerticalScale(boat)+.028,s.z*lengthScale]);
  }else if(!isDown&&s.role==='Helmsman'){
    const stand=crewHelmStand(boat);s.x=stand.x/(boat.beam/3.6);s.z=stand.z/lengthScale;s.yaw=stand.yaw;
    s.position.set([stand.x,hullDeck(s.z)*HULL_VERTICAL_SCALE+.028,stand.z]);
  }else s.position.set([s.x*boat.beam/3.6,(s.navigationY??(s.company?modelDeck(boat,s.z):modelHullDeck(boat,s.z)))*vesselVerticalScale(boat)+.028+proneLift,s.z*lengthScale]);
  const sy=Math.sin(s.yaw/2),cy=Math.cos(s.yaw/2),sx=Math.sin((s.climbPitch??0)/2),cx=Math.cos((s.climbPitch??0)/2);
  s.rotation.set([cy*sx,sy*cx,-sy*sx,cy*cx]);gltfTRS(s.transform,s.position,s.rotation,s.scale);
  return s;
}

let preloadedCrewModels=null;
export function isCaptainActor(s){
  if(!s||s.indigenous)return false;
  return s.role==='Captain'||Boolean(s.roles?.includes('captain'))||s.role==='Capitán de Presidio'||s.role==='Captain of the Guard';
}
// The whole part of an actor's skin.w, which tells the shader whose body it is drawing: a man's, a woman's, or the
// captain's worn by a woman, whose painted beard is then painted out. `own` is a body of its batch's own sex.
export const crewBodyKind=(s,own)=>own?Number(s.sex==='female'):s.sex==='female'?2:0;
export const CAPTAIN_TEXTURE_PX=1024;
async function uploadCaptainTexture(device,model){
  if(!model?.image||typeof createImageBitmap!=='function'){
    const texture=device.createTexture({label:'captain pigment fallback',size:[1,1],format:'rgba8unorm-srgb',usage:(globalThis.GPUTextureUsage?.TEXTURE_BINDING??4)|(globalThis.GPUTextureUsage?.COPY_DST??2)});
    device.queue.writeTexture?.({texture},new Uint8Array([180,140,110,255]),{bytesPerRow:4},[1,1]);
    return texture;
  }
  const blob=new Blob([model.image],{type:model.mime||'image/jpeg'});
  let bitmap=await createImageBitmap(blob,{colorSpaceConversion:'none'});
  // One figure of a few thousand triangles, never more than a screen high: a texel of this is finer than a pixel
  // of him at any distance the camera reaches, and it is a quarter of the memory the painted file would take.
  const longest=Math.max(bitmap.width,bitmap.height);
  if(longest>CAPTAIN_TEXTURE_PX){
    const scale=CAPTAIN_TEXTURE_PX/longest,full=bitmap;
    bitmap=await createImageBitmap(full,{resizeWidth:Math.max(1,Math.round(full.width*scale)),resizeHeight:Math.max(1,Math.round(full.height*scale)),resizeQuality:'high',colorSpaceConversion:'none'});
    full.close();
  }
  const levels=Math.floor(Math.log2(Math.max(bitmap.width,bitmap.height)))+1;
  const texture=device.createTexture({label:'captain pigment',size:[bitmap.width,bitmap.height],mipLevelCount:levels,format:'rgba8unorm-srgb',usage:GPUTextureUsage.TEXTURE_BINDING|GPUTextureUsage.COPY_DST|GPUTextureUsage.RENDER_ATTACHMENT});
  for(let level=0;level<levels;level++){
    const width=Math.max(1,bitmap.width>>level),height=Math.max(1,bitmap.height>>level);
    const source=level?await createImageBitmap(bitmap,{resizeWidth:width,resizeHeight:height,resizeQuality:'high',colorSpaceConversion:'none'}):bitmap;
    device.queue.copyExternalImageToTexture({source},{texture,mipLevel:level},[width,height]);
    if(level)source.close();
  }
  bitmap.close();
  return texture;
}
// The generated bodies have no garment pieces to re-sculpt, so Indigenous people are still built on the
// classic bodies, which travel with them.
async function fetchCrewModels(){
  const [male,female,captain,classicMale,classicFemale]=await Promise.all(['assets/crew/sailor.glb','assets/crew/sailor-female.glb','assets/crew/captain.glb','assets/crew/sailor-classic.glb','assets/crew/sailor-female-classic.glb'].map(async path=>{
    const response=await fetch(path);if(!response.ok)throw Error('Crew asset unavailable');return loadCrewGLB(await response.arrayBuffer());
  }));
  attachCrewComponents(male,'male');attachCrewComponents(female,'female');
  male.indigenousBase=classicMale;female.indigenousBase=classicFemale;
  return [male,female,captain];
}
export function preloadCrewModels(){
  if(!preloadedCrewModels&&typeof fetch==='function'){
    preloadedCrewModels=fetchCrewModels().catch(err=>{preloadedCrewModels=null;throw err;});
  }
  return preloadedCrewModels;
}

const CREW_BODY_VERTICES=[{arrayStride:60,attributes:[
  {shaderLocation:0,offset:0,format:'float32x3'},{shaderLocation:1,offset:12,format:'float32x3'},
  {shaderLocation:2,offset:24,format:'float32x3'},{shaderLocation:3,offset:36,format:'uint16x4'},
  {shaderLocation:4,offset:44,format:'float32x4'},
]}];
// Every program a company is drawn and posed with, asked for once a device. Startup asks before it waits on
// anything, so they compile beside the ocean's; the first company to be made finds them compiling or done.
export function requestCrewPipelines({device,shader,format='rgba16float',samples=4,waterOptics=null}){
  return requestOnce(device,`crew ${format} ${samples}`,async()=>{
    const modules=Promise.all([shader(CREW_RENDER,'crew'),shader(CREW_SHADOW,'crew shadow')]);
    const drawn=(label,entryPoint,target,depthStencil)=>modules.then(([module])=>device.createRenderPipelineAsync({label,layout:'auto',vertex:{module,entryPoint:'vs',buffers:CREW_BODY_VERTICES},
      fragment:{module,entryPoint,targets:[target]},primitive:{topology:'triangle-list',cullMode:'none'},
      depthStencil:{format:'depth32float',...depthStencil},multisample:{count:samples}}));
    const layingDepth={depthWriteEnabled:true,depthCompare:'greater'};
    const tools=requestGunneryToolPipelines({device,shader,format,samples,waterOptics});tools.catch(()=>{});
    Promise.resolve(waterOptics).then(optics=>optics?.capture({source:CREW_RENDER,entry:'crewFS',vertex:{buffers:CREW_BODY_VERTICES},groups:2})).catch(()=>{});
    const [pipeline,cutDepthPipeline,cutPipeline,shadowPipeline,poseBlendPipeline,clipPipeline,solver,arrowPipeline,turnPipeline]=await Promise.all([
      drawn('crew','crewFS',{format},layingDepth),
      drawn('crew surviving','surviving',{format,writeMask:0},layingDepth),
      drawn('crew cut','crewFS',{format},{depthWriteEnabled:false,depthCompare:'equal'}),
      modules.then(([,shadowModule])=>device.createRenderPipelineAsync({label:'crew shadow',layout:'auto',vertex:{module:shadowModule,entryPoint:'vs',buffers:CREW_BODY_VERTICES},primitive:{topology:'triangle-list',cullMode:'none'},
        depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'less',depthBias:2,depthBiasSlopeScale:1.5}})),
      shader(CREW_POSE_BLEND,'crew pose blend').then(module=>device.createComputePipelineAsync({label:'crew pose blend',layout:'auto',compute:{module,entryPoint:'main'}})),
      createCrewClipPipeline(device,shader),
      // One solver for the device: every company and garrison on it is solved together.
      createCrewSolver(device,shader),
      createCrewArrowPipeline(device,shader),
      createCrewTurnPipeline(device,shader),
    ]);
    return {pipeline,cutDepthPipeline,cutPipeline,shadowPipeline,poseBlendPipeline,clipPipeline,solver,arrowPipeline,turnPipeline};
  });
}

export async function createCrew({device,frameUBO,hullUBO,transView,skyView,sampClamp,envCubeView,sunVisBuf,shadows,wetness,shader,format='rgba16float',samples=4,shared=null,modelId='nina',waterOptics=null}) {
  const modelsPromise=shared?.models?Promise.resolve(shared.models):(preloadedCrewModels??fetchCrewModels());
  modelsPromise.catch(()=>{});
  const B=GPUBufferUsage,state=createCompany(undefined,modelId,{fullWatch:true});
  // Built now, at loading, rather than the first time anyone has to step aside.
  crewDeckField({modelId,...requirePlayableShipModel(modelId).runtime});
  const buffer=(label,data,usage)=>{const b=device.createBuffer({label,size:data.byteLength,usage:usage|B.COPY_DST});device.queue.writeBuffer(b,0,data);return b;};
  const layout=CREW_BODY_VERTICES;
  const [models,requested]=await Promise.all([modelsPromise,requestCrewPipelines({device,shader,format,samples,waterOptics})]);
  if(models.some(m=>m.animator.joints.length!==65))throw Error('Crew expects the prepared 65-joint rigs');
  const [pipeline,cutDepthPipeline,cutPipeline,shadowPipeline,captainTexture]=await Promise.all([shared?.pipeline??requested.pipeline,
    shared?.cutDepthPipeline??requested.cutDepthPipeline,
    shared?.cutPipeline??requested.cutPipeline,
    shared?.shadowPipeline??requested.shadowPipeline,
    shared?.captainTexture?Promise.resolve(shared.captainTexture):uploadCaptainTexture(device,models[2])]);
  const captainTexView=shared?.captainTexView??captainTexture.createView();
  const captainSampler=shared?.captainSampler??device.createSampler({label:'captain pigment',magFilter:'linear',minFilter:'linear',mipmapFilter:'linear',addressModeU:'repeat',addressModeV:'repeat',maxAnisotropy:8});
  const group=(pipe,resources)=>device.createBindGroup({layout:pipe.getBindGroupLayout(0),entries:resources.map((resource,binding)=>resource?.resource!==undefined?resource:{binding,resource})});
  const poseBlendPipeline=shared?.poseBlendPipeline??requested.poseBlendPipeline;
  const clipPipeline=shared?.clipPipeline??requested.clipPipeline;
  const solver=requested.solver;
  const arrowPipeline=shared?.arrowPipeline??requested.arrowPipeline;
  const turnPipeline=shared?.turnPipeline??requested.turnPipeline;
  // Each body's mesh is uploaded once and shared by the fleet: the men's, the women's and the captain's.
  const geometry=models.map((model,i)=>{
    if(shared?.geometry?.[i])return shared.geometry[i];
    const vertex=buffer('crew vertices',model.vertices,B.VERTEX),index=buffer('crew indices',model.indices,B.INDEX);
    const lods=(model.lods??[{id:'near',level:0,indices:model.indices,indexCount:model.indices.length,triangles:model.indices.length/3}]).map((tier,t)=>({...tier,buffer:t===0?index:buffer('crew indices '+tier.id,tier.indices,B.INDEX)}));
    return {vertex,index,lods};
  });
  const captainModel=models[2],captainGeometry=geometry[2];
  // A vessel has two batches of bodies, by sex. Her captain is one more body in his or her own, last in it, and
  // drawn from it with the captain's mesh: one person is not worth a third set of joint and actor storage.
  const batches=models.slice(0,2).map((model,i)=>{
    const ofSex=state.crew.filter(s=>s.sex===(i?'female':'male')),hands=ofSex.filter(s=>!isCaptainActor(s)),captains=ofSex.filter(isCaptainActor);
    const people=[...hands,...captains];
    for(const s of hands)s.walkClipDuration=model.animator.clips.get('Walk').duration;
    for(const s of captains)s.walkClipDuration=captainModel.animator.clips.get('Walk').duration;
    // A one-person company legitimately has no actors in one sex batch.
    // Bind valid storage buffers, but submit no phantom instance for that batch.
    const poses=new Float32Array(Math.max(1,people.length)*65*16),actors=new Float32Array(Math.max(1,people.length)*CREW_ACTOR_FLOATS);
    const {vertex,index,lods}=geometry[i];
    const bones=buffer('crew joints',poses,B.STORAGE),actor=buffer('crew transforms',actors,B.STORAGE);
    // Two solved poses per sailor, and how far along the way from one to the other each is.
    const blends=new Float32Array(Math.max(1,people.length)*2);
    const solved=device.createBuffer({label:'crew solved poses',size:poses.byteLength*2,usage:B.STORAGE|B.COPY_DST}),blend=buffer('crew pose blends',blends,B.STORAGE);
    const poseBlendGroup=device.createBindGroup({label:'crew pose blend',layout:poseBlendPipeline.getBindGroupLayout(0),entries:[solved,blend,bones].map((resource,binding)=>({binding,resource:{buffer:resource}}))});
    const clip=createCrewClipBatch(device,clipPipeline,model,bones,people.length);
    // The captain's body is built on its own rig, so far off its joints come from its own baked clips.
    const captainClip=captains.length?createCrewClipBatch(device,clipPipeline,captainModel,bones,people.length):null;
    const turn=createCrewTurnBatch(device,turnPipeline,model,bones,people.length);
    // Anyone near enough to see what their hands are at is solved on the GPU, into the two poses they are shown between.
    const solve=createCrewSolveBatch(device,solver,model,solved,people.length),captainSolve=captains.length?createCrewSolveBatch(device,solver,captainModel,solved,people.length):null;
    const common=[{buffer:hullUBO},{buffer:bones},{buffer:actor}];
    const mainResources=[{buffer:frameUBO},...common,transView,sampClamp,envCubeView,{buffer:sunVisBuf},{buffer:wetness.state},skyView,{binding:13,resource:captainTexView},{binding:14,resource:captainSampler}];
    const main=group(pipeline,mainResources),mainCut=group(cutPipeline,mainResources);
    // The depth entry reads only what the vertex stage does, and the frame.
    const cutDepth=device.createBindGroup({layout:cutDepthPipeline.getBindGroupLayout(0),entries:[0,1,2,3,8].map(binding=>({binding,resource:mainResources[binding]}))});
    const shadow=group(shadowPipeline,[{buffer:shadows.uniform},...common]);
    // What is drawn from this batch's storage: its own bodies, then the captain's, each a run of its slots.
    const parts=[{model,vertex,index,lods,first:0,people:hands},...(captains.length?[{model:captainModel,...captainGeometry,first:hands.length,people:captains}]:[])];
    return {model,people,hands:hands.length,parts,poses,actors,bones,actor,main,mainCut,cutDepth,shadow,mainResources,solved,blend,blends,poseBlendGroup,clip,captainClip,turn,solve,captainSolve};
  });
  const partRuns=(part,tierOf)=>{const runs=crewDrawRuns(part.people,tierOf);if(part.first)for(const run of runs)run.first+=part.first;return runs;};
  const shownTierOf=s=>s.visible===false||s.cutShader?-1:s.lodTier,cutTierOf=s=>s.visible!==false&&s.cutShader?s.lodTier:-1;
  const shadowTierOf=s=>s.visible===false||s.lodTier>=2?-1:Math.min(CREW_LOD_TIERS.length-1,s.lodTier+1);
  const partTriangles=(part,tier)=>(tier===null?part.model.indices.length/3:(part.lods?.[tier]?.triangles??part.model.indices.length/3))*part.people.length;
  const everyPart=batches.flatMap(b=>b.parts);
  const lighting=shadows.bind(pipeline),cutLighting=shadows.bind(cutPipeline);
  const submerged=waterOptics?await waterOptics.capture({source:CREW_RENDER,entry:'crewFS',pipeline,vertex:{buffers:layout},groups:2}):null;
  const submergedLighting=submerged?shadows.bind(submerged.pipeline):null;
  if(submerged)for(const b of batches)b.submerged=submerged.bindGroup(b.mainResources);
  const gunTools=await createGunneryTools({device,frameUBO,transView,skyView,sampClamp,envCubeView,sunVisBuf,shadows,shader,format,samples,waterOptics,shared:shared?.gunTools});
  // An arrow in a body is placed on the GPU from the joints that body is drawn with.
  const placeOf=new Map();
  for(const b of batches){
    b.arrows=createCrewArrowBatch(device,arrowPipeline,b.bones,b.actor,gunTools.tubes,34);
    b.people.forEach((s,i)=>placeOf.set(s,{b,i,animator:(i<b.hands?b.model:captainModel).animator}));
  }
  let enabled=true,drawEnabled=false,posed=false,activeTier=0,shadowTier=1,poseFrame=0;
  const drawBatch=(pass,b,shadow,cutGroup=null)=>{
    let grouped=false;
    for(const part of b.parts){
      const runs=shadow?part.shadowRuns:cutGroup?part.cutRuns:part.runs;
      if(!part.people.length||runs?.length===0||(cutGroup&&!runs))continue;
      if(!grouped){pass.setBindGroup(0,shadow?b.shadow:cutGroup??b.main);grouped=true;}
      pass.setVertexBuffer(0,part.vertex);
      let bound=null;
      for(const run of runs??[{tier:shadow?shadowTier:activeTier,first:part.first,count:part.people.length}]){
        const lod=part.lods?.[run.tier]??part.lods?.[0]??{buffer:part.index,indexCount:part.model.indices.length};
        if(lod.buffer!==bound){pass.setIndexBuffer(lod.buffer,'uint32');bound=lod.buffer;}
        pass.drawIndexed(lod.indexCount??lod.indices.length,run.count,0,0,run.first);
      }
    }
  };
  return {state,assets:{models,pipeline,cutDepthPipeline,cutPipeline,shadowPipeline,poseBlendPipeline,clipPipeline,turnPipeline,arrowPipeline,captainTexture,captainTexView,captainSampler,gunTools:gunTools.assets,geometry},triangles:everyPart.reduce((n,part)=>n+partTriangles(part,null),0),lods:CREW_LOD_TIERS,
    get lodLevel(){return activeTier;},
    get posed(){return posed;},
    get activeTriangles(){return everyPart.reduce((n,part)=>n+partTriangles(part,activeTier),0);},
    joints:65,
    order(boat,id){return issueCaptainOrder(state,boat,id);},
    // A paused frame moves nobody, but the camera and the crew and ship toggles still apply.
    refreshDraw(boat,camera=null){
      const lod=selectCrewLOD(boat,camera);activeTier=lod.mainTier;shadowTier=lod.shadowTier;
      drawEnabled=boat.crew!==false&&boat.showProw&&!lod.culled&&state.crew.some(s=>s.visible);
    },
    update(boat,dt,wind,camera=null){
      const lod=selectCrewLOD(boat,camera);activeTier=lod.mainTier;shadowTier=lod.shadowTier;
      stepCompany(state,boat,dt,wind);enabled=boat.crew!==false;drawEnabled=enabled&&boat.showProw&&!lod.culled&&state.crew.some(s=>s.visible);
      if(!drawEnabled){
        gunTools.update(state,boat,false);
        for(const b of batches){b.arrows.begin();b.arrows.upload();}
        // Hidden rendering does not turn a seated body's moisture samples back
        // into standing-height probes or change its physical rowing attendance.
        if(Object.hasOwn(ROWING_DESIGNS,modelId))for(const b of batches){b.solve.begin();b.captainSolve?.begin();for(const part of b.parts)for(const s of part.people)if(s.seatedPose)poseCrewWork((part.model===captainModel?b.captainSolve:b.solve).recorder,s,boat);}
        return;
      }
      posed=true;poseFrame++;
      for(const b of batches){
        b.clip.begin(b.people.length);b.captainClip?.begin(b.people.length);b.solve.begin();b.captainSolve?.begin();
        for(let i=0;i<b.people.length;i++){
          // The captain's slots follow the hands', and are solved on the captain's own rig.
          const s=b.people[i],own=i<b.hands,a=own?b.model.animator:captainModel.animator,clips=own?b.clip:b.captainClip,solve=own?b.solve:b.captainSolve;
          s.poseElapsed=(s.poseElapsed??0)+dt;
          // A wound or a fall shows at once. Anyone not on show keeps their slot until they are.
          const apparent=crewApparentDistance(s.position,boat,camera);
          s.lodTier=crewSailorTier(apparent,s.lodTier??0);
          // A man in the water, or anyone far off, is posed on the GPU from a baked clip and solved for no further.
          let baked=crewBakedPose(apparent,s);
          if(baked==='walk')clips.set(i,s.time,s.walkTime,s.walk);
          else if(!baked||!clips.loop(i,baked,crewAfloatSeconds(s))){baked=null;clips.off(i);}
          const clipOnly=Boolean(baked);
          // Coming back within reach of their own pose, they take it at once.
          const snap=!s.posedOnce||s.pendingWounds?.length||(s.knockdownTimer??0)>0||(s.clipOnly&&!clipOnly);
          s.clipOnly=clipOnly;
          if(clipOnly)s.posedOnce=true;
          const interval=snap?1:crewPoseInterval(apparent);
          s.poseAge=(s.poseAge??i)+1;
          const due=crewPoseDue(s,clipOnly,snap,interval);
          if(due){
            s.posedOnce=true;s.poseAge=0;crewPoseSolved(s);
            // The older of the two solved poses is the one to replace.
            s.poseSlot=1-(s.poseSlot??0);
            // A shot that has just struck him is matched to a bone on a skeleton posed here, this once.
            if(s.pendingWounds?.length)resolveCrewWoundsOnSkeleton(a,s,boat);
            // His pose is written down for the GPU to solve. Only if there were no room to write it is it solved here.
            if(!solve.add(i,s,boat,s.poseElapsed,i*2+s.poseSlot,{snap})){
              a.sample('Idle',s.time,'Walk',s.walkTime,s.walk);
              if(s.brace>.001 && !(s.job?.rung>0))a.blend('Brace',s.time,s.brace);
              poseCrewWork(a,s,boat);
              applyCrewRealism(a,s,boat,s.poseElapsed);
              applyCrewWounds(a,s);
              device.queue.writeBuffer(b.solved,(i*2+s.poseSlot)*65*64,a.palette);
              if(snap)device.queue.writeBuffer(b.solved,(i*2+1-s.poseSlot)*65*64,a.palette);
            }
            s.poseElapsed=0;
          }
          b.blends[i*2]=Math.min(1,(s.poseAge+1)/interval);b.blends[i*2+1]=s.poseSlot??0;
          const offset=i*CREW_ACTOR_FLOATS;
          b.actors.set(s.transform,offset);
          const isLivingSwimmer=Boolean(s.overboard?.inWater&&s.overboard?.alive);
          const woundAmt=isLivingSwimmer
            ?(s.overboard.wounded?0.45:0)
            :s.casualtyState==='fallen'?1.0:s.casualtyState==='wounded'?Math.max(0.45,Math.min(0.95,s.woundSeverity??(1-(s.health??0.5)))):0;
          const scorchAmt=Math.max(0,Math.min(0.95,s.scorchAmount??(!isLivingSwimmer&&s.casualtyState==='fallen'?0.35:s.casualtyState==='wounded'?0.18:0)));
          s.cutShader=crewNeedsCutShader(crewApparentDistance(s.position,boat,camera,1),boat.enabled===true,woundAmt+scorchAmt);
          const bandageSeed=(!isLivingSwimmer&&(s.casualtyState==='wounded'||s.casualtyState==='fallen'))?(0.06+(((s.crewIndex??i)*0.37)%0.32)):0;
          const shirt=(!isLivingSwimmer&&s.casualtyState==='fallen')
            ?[s.shirt[0]*0.55+0.20,s.shirt[1]*0.32,s.shirt[2]*0.32]
            :(s.casualtyState==='wounded'||(isLivingSwimmer&&s.overboard.wounded))
              ?[s.shirt[0]*0.78+0.12,s.shirt[1]*0.62,s.shirt[2]*0.62]
              :s.shirt;
          b.actors.set(shirt,offset+16);b.actors.set(s.trousers,offset+20);b.actors.set(s.skin,offset+24);b.actors.set(s.hair,offset+28);
          b.actors.set(s.face,offset+32);b.actors[offset+35]=packCrewFaceW(s.face[3],own?(s.compMask??0):0,Boolean(s.indigenous));b.actors[offset+27]=crewBodyKind(s,own)+bandageSeed;
          // The tiller station is below the camera; all crew remain visible.
          // Fractional part of shirt.w (< 0.5) carries wound severity to the crew shader.
          b.actors[offset+19]=!s.visible?1.0:(woundAmt*0.45);
          // Integer part of trousers.w is boat.enabled; fractional part (< 0.45) carries soot/scorch.
          b.actors[offset+23]=Number(boat.enabled===true)+scorchAmt*0.42;
          b.actors[offset+31]=wetness.crewOffset+(s.crewIndex??state.crew.indexOf(s))*4;
        }
        for(const part of b.parts){part.runs=partRuns(part,shownTierOf);part.cutRuns=partRuns(part,cutTierOf);part.shadowRuns=partRuns(part,shadowTierOf);}
        device.queue.writeBuffer(b.blend,0,b.blends);device.queue.writeBuffer(b.actor,0,b.actors);b.clip.upload();b.captainClip?.upload();b.solve.upload();b.captainSolve?.upload();b.turn.update(b.people);
      }
      // After posing, so an arrow's bone is this frame's.
      gunTools.update(state,boat,true);
      for(const b of batches)b.arrows.begin();
      for(const {sailor,arrow,record} of gunTools.placed){const at=placeOf.get(sailor);if(at)at.b.arrows.add(record,at.i,at.animator,arrow);}
      for(const b of batches)b.arrows.upload();
    },
    // Before anything draws them: every joint of every sailor, on the way to their newest pose.
    encodePose(pass){
      if(!drawEnabled)return;
      for(const b of batches)if(b.people.length){b.solve.encode(pass);b.captainSolve?.encode(pass);}
      pass.setPipeline(poseBlendPipeline);
      for(const b of batches)if(b.people.length){pass.setBindGroup(0,b.poseBlendGroup);pass.dispatchWorkgroups(Math.ceil(b.people.length*65/64));}
      for(const b of batches)if(b.people.length){b.clip.encode(pass);b.captainClip?.encode(pass);}
      for(const b of batches)if(b.people.length)b.turn.encode(pass);
      // Last, from the joints everybody will be drawn with.
      for(const b of batches)b.arrows.encode(pass);
    },
    drawSubmerged(pass,above=false){
      if(!submerged||!drawEnabled)return;
      submerged.bind(pass,above);pass.setBindGroup(1,submergedLighting);
      for(const b of batches){
        if(!b.people.length)continue;
        pass.setBindGroup(0,b.submerged);
        for(const part of b.parts){
          if(!part.people.length)continue;
          const lod=part.lods?.at(-1)??{buffer:part.index,indexCount:part.model.indices.length};
          pass.setVertexBuffer(0,part.vertex);pass.setIndexBuffer(lod.buffer,'uint32');pass.drawIndexed(lod.indexCount??lod.indices.length,part.people.length,0,0,part.first);
        }
      }
      gunTools.drawSubmerged(pass,above);
    },
    // Opaque sailors belong with the opaque scene. Anyone being cut follows it.
    drawOpaque(pass){if(!drawEnabled)return;pass.setPipeline(pipeline);pass.setBindGroup(1,lighting);for(const b of batches)drawBatch(pass,b,false);gunTools.draw(pass);},
    drawCut(pass){
      if(!drawEnabled||!everyPart.some(part=>part.cutRuns?.length))return;
      pass.setPipeline(cutDepthPipeline);for(const b of batches)drawBatch(pass,b,false,b.cutDepth);
      pass.setPipeline(cutPipeline);pass.setBindGroup(1,cutLighting);for(const b of batches)drawBatch(pass,b,false,b.mainCut);
    },
    drawShadow(pass){if(!drawEnabled)return;pass.setPipeline(shadowPipeline);for(const b of batches)drawBatch(pass,b,true);gunTools.drawShadow(pass);},
    status(){return state.crew.length&&!state.crew.some(s=>s.visible)?hasExtendedCrewModel(modelId)?'Crew hidden':'Crew needs a larger deck':companyStatus(state);},
    destroy(){
      gunTools.destroy();
      if(!shared){captainTexture?.destroy?.();for(const g of geometry)for(const resource of [g.vertex,g.index,...(g.lods?.slice(1).map(l=>l.buffer)??[])])resource.destroy();}
      for(const b of batches){for(const resource of [b.bones,b.actor,b.solved,b.blend])resource.destroy();b.clip.destroy();b.captainClip?.destroy();b.turn.destroy();b.solve.destroy();b.captainSolve?.destroy();b.arrows.destroy();}
    },
  };
}

export const FORTIFICATION_PREFAB_IDS = Object.freeze([
  'stone_sea_bastion',
  'bastion_trace_fortress',
  'torreon_atalaya_farol',
  'curtain_wall_and_gate',
  'english_triangular_palisade_fort',
]);

export const INDIGENOUS_VILLAGE_PREFAB_IDS = Object.freeze([
  'abenaki_birchbark_wigwam',
  'algonquian_longhouse',
  'indigenous_palisade_ring',
  'taino_cacique_caney',
  'taino_circular_bohio',
  'taino_batey_court',
  'kalinago_carbet_hall',
  'tupinamba_oca_longhouse',
  'palafito_estuary_village',
  'maya_limestone_shrine_and_na',
  'indigenous_canoe_landing',
]);

let cachedIndigenousModels = new WeakMap();

export function buildIndigenousCrewModel(baseModel, female = false) {
  if (!baseModel?.vertices || !baseModel?.indices || !baseModel?.animator) {
    throw Error('buildIndigenousCrewModel requires a loaded crew GLB model');
  }
  const a = baseModel.animator;
  const slotMap = Object.fromEntries(a.joints.map((nodeIdx, slotIdx) => [a.names[nodeIdx], slotIdx]));
  const headSlot = slotMap.Head ?? 6;
  const neckSlot = slotMap.neck_01 ?? 5;
  const spine3Slot = slotMap.spine_03 ?? 4;
  const armSlots = new Set([slotMap.upperarm_l ?? 8, slotMap.lowerarm_l ?? 9, slotMap.upperarm_r ?? 32, slotMap.lowerarm_r ?? 33]);
  const calfSlots = new Set([slotMap.calf_l ?? 56, slotMap.calf_r ?? 61]);

  const baseVertCount = baseModel.vertices.byteLength / 60;
  const baseBytes = new Uint8Array(baseModel.vertices.byteLength);
  baseBytes.set(baseModel.vertices);
  const bf = new Float32Array(baseBytes.buffer, baseBytes.byteOffset, baseBytes.byteLength / 4);
  const bu = new Uint16Array(baseBytes.buffer, baseBytes.byteOffset, baseBytes.byteLength / 2);

  // Re-sculpt puffed European cloth sleeves and baggy slops into bare anatomical arms
  // and lower legs above soft deerskin moccasins, with fringed buckskin / woven cotton
  // tunic, breechcloth (male), or woven nagua skirt (female).
  for (let i = 0; i < baseVertCount; i++) {
    const fOff = i * 15;
    const uOff = i * 30;
    const x = bf[fOff + 0], y = bf[fOff + 1], z = bf[fOff + 2];
    const nx = bf[fOff + 3], ny = bf[fOff + 4], nz = bf[fOff + 5];
    const r = bf[fOff + 6], g = bf[fOff + 7], b = bf[fOff + 8];
    let armW = 0, calfW = 0;
    for (let k = 0; k < 4; k++) {
      const slot = bu[uOff + 18 + k];
      const w = bf[fOff + 11 + k];
      if (armSlots.has(slot)) armW += w;
      if (calfSlots.has(slot)) calfW += w;
    }
    const isShirt = Math.hypot(r - 0.55, g - 0.47, b - 0.31) < 0.008;
    const isTrousers = Math.hypot(r - 0.095, g - 0.12, b - 0.15) < 0.008;

    // Bare anatomical arms: convert sleeve cloth to skin sentinel and pull in puffed sleeve
    if (isShirt && (armW > 0.36 || Math.abs(x) > 0.185)) {
      bf[fOff + 0] = x - nx * 0.013;
      bf[fOff + 1] = y - ny * 0.006;
      bf[fOff + 2] = z - nz * 0.013;
      bf[fOff + 6] = 0.36;
      bf[fOff + 7] = 0.18;
      bf[fOff + 8] = 0.10;
    } else if (isShirt && !female && y > 1.24 && (x * 0.85 + (y - 1.31)) > 0.04) {
      // Asymmetric bare shoulder / diagonal sash tunic on male model
      bf[fOff + 6] = 0.36;
      bf[fOff + 7] = 0.18;
      bf[fOff + 8] = 0.10;
    }

    // The sailors' knitted stockings have no place here.
    if (Math.hypot(r - 0.22, g - 0.195, b - 0.165) < 0.008) {
      bf[fOff + 6] = 0.36;
      bf[fOff + 7] = 0.18;
      bf[fOff + 8] = 0.10;
    }

    // Bare lower calves above deerskin moccasins (y < 0.21 stays moccasin hide)
    if (isTrousers && (calfW > 0.42 || (y >= 0.215 && y <= (female ? 0.56 : 0.66)))) {
      bf[fOff + 0] = x - nx * 0.014;
      bf[fOff + 2] = z - nz * 0.014;
      bf[fOff + 6] = 0.36;
      bf[fOff + 7] = 0.18;
      bf[fOff + 8] = 0.10;
    }
  }

  // The sailors' buns and tousled hair would sit on everyone here. Press hair close to the skull,
  // and the styles below add the length. The clamp leaves a plain cap, as a shaved head needs too.
  const skullY = female ? 1.676 : 1.718;
  for (let i = 0; i < baseVertCount; i++) {
    const fOff = i * 15;
    if (Math.hypot(bf[fOff + 6] - 0.045, bf[fOff + 7] - 0.019, bf[fOff + 8] - 0.009) >= 0.008) continue;
    const dx = bf[fOff], dy = bf[fOff + 1] - skullY, dz = bf[fOff + 2] + 0.006, away = Math.hypot(dx, dy, dz);
    if (away > 0.112) {
      const pull = 0.112 / away;
      bf[fOff] = dx * pull; bf[fOff + 1] = skullY + dy * pull; bf[fOff + 2] = dz * pull - 0.006;
    }
  }

  // Build 3D skinned indigenous regalia & hair meshes (headband, 3 crown feathers,
  // twin braided hair plaits, and carved shell/guanín pectoral collar).
  const extraVerts = [];
  const extraTris = [];
  // Every piece is in the one mesh, and each person's look says which of them show. A vertex carries
  // its piece's number in its red channel, above the colour itself.
  let piece = 0;
  const asPiece = (name, build) => { piece = DRESS_PIECES.indexOf(name) + 1; build(); piece = 0; };
  const pushVertex = (pos, norm, col, bones, weights) => {
    const idx = baseVertCount + extraVerts.length;
    const len = Math.hypot(norm[0], norm[1], norm[2]) || 1;
    extraVerts.push({
      pos: [pos[0], pos[1], pos[2]],
      norm: [norm[0] / len, norm[1] / len, norm[2] / len],
      col: [col[0] + 2 * piece, col[1], col[2]],
      bones: [bones[0] ?? 0, bones[1] ?? 0, bones[2] ?? 0, bones[3] ?? 0],
      weights: [weights[0] ?? 1, weights[1] ?? 0, weights[2] ?? 0, weights[3] ?? 0],
    });
    return idx;
  };
  const pushQuad = (i0, i1, i2, i3) => {
    extraTris.push(i0, i1, i2, i0, i2, i3);
  };

  const browY = female ? 1.688 : 1.734;
  const bandRx = female ? 0.086 : 0.085;
  const bandRz = female ? 0.097 : 0.099;
  const bandCenterZ = -0.002;
  const bandH = 0.024;
  const bandSegs = 16;

  // 1. Woven Wampum / Dyed Quillwork Headband around brow (Head bone)
  asPiece('HEADBAND', () => { for (let s = 0; s < bandSegs; s++) {
    const a0 = (s / bandSegs) * Math.PI * 2;
    const a1 = ((s + 1) / bandSegs) * Math.PI * 2;
    const beadCol = (s % 3 === 0)
      ? [0.84, 0.80, 0.72] // white shell wampum
      : (s % 3 === 1)
        ? [0.58, 0.15, 0.08] // red ochre / dyed quillwork
        : [0.16, 0.36, 0.42]; // purple-indigo quahog wampum / turquoise
    const x0 = Math.sin(a0) * bandRx, z0 = bandCenterZ + Math.cos(a0) * bandRz;
    const x1 = Math.sin(a1) * bandRx, z1 = bandCenterZ + Math.cos(a1) * bandRz;
    const n0 = [Math.sin(a0), 0.08, Math.cos(a0)];
    const n1 = [Math.sin(a1), 0.08, Math.cos(a1)];
    const v0 = pushVertex([x0, browY, z0], n0, beadCol, [headSlot, 0, 0, 0], [1, 0, 0, 0]);
    const v1 = pushVertex([x1, browY, z1], n1, beadCol, [headSlot, 0, 0, 0], [1, 0, 0, 0]);
    const v2 = pushVertex([x1 * 0.99, browY + bandH, z1 * 0.99], n1, beadCol, [headSlot, 0, 0, 0], [1, 0, 0, 0]);
    const v3 = pushVertex([x0 * 0.99, browY + bandH, z0 * 0.99], n0, beadCol, [headSlot, 0, 0, 0], [1, 0, 0, 0]);
    pushQuad(v0, v1, v2, v3);
  } });

  // 2. Crown Eagle / Hawk / Macaw Feathers rising from the back/sides of the headband (Head bone)
  const featherSpecs = female
    ? [
        { x: 0.0, z: bandCenterZ - bandRz * 0.96, h: 0.145, w: 0.017, tiltX: 0.0, tiltZ: -0.22 },
        { x: -0.026, z: bandCenterZ - bandRz * 0.92, h: 0.120, w: 0.015, tiltX: -0.18, tiltZ: -0.26 },
        { x: 0.026, z: bandCenterZ - bandRz * 0.92, h: 0.120, w: 0.015, tiltX: 0.18, tiltZ: -0.26 },
      ]
    : [
        { x: 0.0, z: bandCenterZ - bandRz * 0.96, h: 0.175, w: 0.019, tiltX: 0.0, tiltZ: -0.20 },
        { x: -0.032, z: bandCenterZ - bandRz * 0.90, h: 0.148, w: 0.016, tiltX: -0.22, tiltZ: -0.25 },
        { x: 0.032, z: bandCenterZ - bandRz * 0.90, h: 0.148, w: 0.016, tiltX: 0.22, tiltZ: -0.25 },
      ];
  featherSpecs.forEach((fSpec, featherIndex) => asPiece(featherIndex ? 'MORE_FEATHERS' : 'ONE_FEATHER', () => {
    const baseCol = [0.88, 0.85, 0.78]; // golden eagle white basal vane
    const midCol = [0.76, 0.70, 0.58];
    const tipCol = [0.11, 0.08, 0.06]; // dark eagle tip
    const y0 = browY + bandH * 0.5;
    const yMid = y0 + fSpec.h * 0.58;
    const yTip = y0 + fSpec.h;
    const xMid = fSpec.x + fSpec.tiltX * fSpec.h * 0.55;
    const zMid = fSpec.z + fSpec.tiltZ * fSpec.h * 0.55;
    const xTip = fSpec.x + fSpec.tiltX * fSpec.h;
    const zTip = fSpec.z + fSpec.tiltZ * fSpec.h;
    for (const side of [-1, 1]) {
      const fn = [0, 0.15, side * -0.98];
      const bL = pushVertex([fSpec.x - fSpec.w * 0.45, y0, fSpec.z], fn, baseCol, [headSlot, 0, 0, 0], [1, 0, 0, 0]);
      const bR = pushVertex([fSpec.x + fSpec.w * 0.45, y0, fSpec.z], fn, baseCol, [headSlot, 0, 0, 0], [1, 0, 0, 0]);
      const mR = pushVertex([xMid + fSpec.w, yMid, zMid], fn, midCol, [headSlot, 0, 0, 0], [1, 0, 0, 0]);
      const mL = pushVertex([xMid - fSpec.w, yMid, zMid], fn, midCol, [headSlot, 0, 0, 0], [1, 0, 0, 0]);
      const tV = pushVertex([xTip, yTip, zTip], fn, tipCol, [headSlot, 0, 0, 0], [1, 0, 0, 0]);
      if (side > 0) {
        pushQuad(bL, bR, mR, mL);
        extraTris.push(mL, mR, tV);
      } else {
        pushQuad(bR, bL, mL, mR);
        extraTris.push(mR, mL, tV);
      }
    }
  }));

  // 3. Long Braided Hair Plaits hanging down from temples over shoulders (blended Head -> neck_01 -> spine_03)
  const braidLen = female ? 0.36 : 0.31;
  const braidSegs = 6;
  const hairSentinel = [0.045, 0.019, 0.009];
  const tieCol = [0.58, 0.14, 0.08];
  asPiece('PLAITS', () => { for (const sideX of [-1, 1]) {
    const rings = [];
    for (let k = 0; k <= braidSegs; k++) {
      const t = k / braidSegs;
      const y = (browY - 0.03) - t * braidLen;
      const x = sideX * (0.074 + Math.sin(t * Math.PI) * 0.018);
      const z = -0.048 - Math.sin(t * Math.PI * 0.85) * 0.025;
      const r = (1 - t * 0.52) * (female ? 0.017 : 0.015);
      const wHead = Math.max(0, 1 - t * 1.45);
      const wSpine = Math.max(0, (t - 0.30) / 0.70);
      const wNeck = Math.max(0, 1 - wHead - wSpine);
      const wSum = wHead + wNeck + wSpine || 1;
      const weights = [wHead / wSum, wNeck / wSum, wSpine / wSum, 0];
      const bones = [headSlot, neckSlot, spine3Slot, 0];
      const col = (k === braidSegs - 1) ? tieCol : hairSentinel;
      const ring = [];
      for (let c = 0; c < 5; c++) {
        const ang = (c / 5) * Math.PI * 2;
        const dx = Math.cos(ang) * r, dz = Math.sin(ang) * r;
        ring.push(pushVertex([x + dx, y, z + dz], [Math.cos(ang), -0.1, Math.sin(ang)], col, bones, weights));
      }
      rings.push(ring);
    }
    for (let k = 0; k < braidSegs; k++) {
      for (let c = 0; c < 5; c++) {
        const c1 = (c + 1) % 5;
        pushQuad(rings[k][c], rings[k][c1], rings[k + 1][c1], rings[k + 1][c]);
      }
    }
  } });

  // 4. Collars across the upper chest (spine_03 bone): gold, shell or jade, each its own piece.
  const chestY = female ? 1.335 : 1.375;
  const chestZ = female ? 0.112 : 0.118;
  const collarSegs = 8;
  const collar = (name, colourAt) => asPiece(name, () => { for (let s = 0; s < collarSegs; s++) {
    const collarCol = colourAt(s);
    const t0 = (s / collarSegs) * 2 - 1;
    const t1 = ((s + 1) / collarSegs) * 2 - 1;
    const x0 = t0 * 0.072, x1 = t1 * 0.072;
    const dip0 = (1 - t0 * t0) * 0.028, dip1 = (1 - t1 * t1) * 0.028;
    const z0 = chestZ + (1 - t0 * t0) * 0.016, z1 = chestZ + (1 - t1 * t1) * 0.016;
    const n0 = [t0 * 0.25, 0.22, 0.94], n1 = [t1 * 0.25, 0.22, 0.94];
    const v0 = pushVertex([x0, chestY - dip0 - 0.016, z0], n0, collarCol, [spine3Slot, 0, 0, 0], [1, 0, 0, 0]);
    const v1 = pushVertex([x1, chestY - dip1 - 0.016, z1], n1, collarCol, [spine3Slot, 0, 0, 0], [1, 0, 0, 0]);
    const v2 = pushVertex([x1, chestY - dip1, z1 - 0.004], n1, collarCol, [spine3Slot, 0, 0, 0], [1, 0, 0, 0]);
    const v3 = pushVertex([x0, chestY - dip0, z0 - 0.004], n0, collarCol, [spine3Slot, 0, 0, 0], [1, 0, 0, 0]);
    pushQuad(v0, v1, v2, v3);
  } });
  collar('GOLD_COLLAR', () => [0.76, 0.58, 0.26]);
  collar('SHELL_COLLAR', (s) => (s % 2 ? [0.84, 0.80, 0.72] : [0.30, 0.16, 0.34]));
  collar('JADE_COLLAR', (s) => (s % 2 ? [0.12, 0.36, 0.26] : [0.20, 0.46, 0.34]));

  const eyeY = female ? 1.656 : 1.699;
  const headBones = [headSlot, 0, 0, 0], headWeights = [1, 0, 0, 0];
  // 5. Long hair, falling loose down the back (blended Head -> neck_01 -> spine_03)
  asPiece('LOOSE_HAIR', () => {
    const rows = 7, columns = 7, length = female ? 0.46 : 0.38, grid = [];
    for (let k = 0; k <= rows; k++) {
      const t = k / rows;
      const y = browY + 0.05 - t * length;
      const rx = 0.098 - t * 0.022, rz = 0.104 - t * 0.05, zc = -0.004 - t * 0.058;
      const wHead = Math.max(0, 1 - t * 1.7), wSpine = Math.max(0, (t - 0.35) / 0.65), wNeck = Math.max(0, 1 - wHead - wSpine);
      const row = [];
      for (let c = 0; c <= columns; c++) {
        const angle = (c / columns - 0.5) * Math.PI * 1.15;
        row.push(pushVertex([Math.sin(angle) * rx, y, zc - Math.cos(angle) * rz], [Math.sin(angle), 0.1, -Math.cos(angle)], hairSentinel, [headSlot, neckSlot, spine3Slot, 0], [wHead, wNeck, wSpine, 0]));
      }
      grid.push(row);
    }
    for (let k = 0; k < rows; k++) for (let c = 0; c < columns; c++) pushQuad(grid[k][c], grid[k][c + 1], grid[k + 1][c + 1], grid[k + 1][c]);
  });
  // 6. A crest of hair and dyed deer hair along the middle of the skull, forehead to nape.
  asPiece('ROACH', () => {
    const steps = 9, tip = [0.34, 0.07, 0.04];
    let previous = null;
    for (let k = 0; k <= steps; k++) {
      const angle = -0.55 + (k / steps) * 3.1, rise = Math.sin((k / steps) * Math.PI);
      const inner = 0.098, outer = inner + 0.022 + rise * 0.032;
      const cy = eyeY + 0.002, cz = -0.002, ny = Math.cos(angle), nz = Math.sin(-angle);
      const left = pushVertex([-0.016, cy + ny * inner, cz + nz * inner], [-0.9, ny * 0.4, nz * 0.4], hairSentinel, headBones, headWeights);
      const right = pushVertex([0.016, cy + ny * inner, cz + nz * inner], [0.9, ny * 0.4, nz * 0.4], hairSentinel, headBones, headWeights);
      const crest = pushVertex([0, cy + ny * outer, cz + nz * outer], [0, ny, nz], tip, headBones, headWeights);
      if (previous) { pushQuad(previous[0], left, crest, previous[2]); pushQuad(right, previous[1], previous[2], crest); }
      previous = [left, right, crest];
    }
  });
  // 7. Long quetzal plumes rising from the back of the head and arching behind.
  asPiece('QUETZAL_PLUMES', () => {
    for (const lean of [-0.11, 0, 0.11]) {
      let previous = null;
      const segments = 6, height = 0.42, width = 0.018;
      for (let k = 0; k <= segments; k++) {
        const t = k / segments;
        const x = lean * t, y = browY + 0.02 + Math.sin(t * Math.PI * 0.62) * height, z = -0.075 - t * t * 0.3;
        const colour = t > 0.72 ? [0.02, 0.2, 0.17] : [0.012, 0.13, 0.07];
        const half = width * (1 - t * 0.55);
        const a = pushVertex([x - half, y, z], [0, 0.25, -0.97], colour, headBones, headWeights);
        const b = pushVertex([x + half, y, z], [0, 0.25, -0.97], colour, headBones, headWeights);
        if (previous) pushQuad(previous[0], previous[1], b, a);
        previous = [a, b];
      }
    }
  });
  // 8. A crown of short red and yellow feathers set upright round the head.
  asPiece('FEATHER_CROWN', () => {
    const count = 16;
    for (let f = 0; f < count; f++) {
      const angle = (f / count) * Math.PI * 2, sx = Math.sin(angle), cz = Math.cos(angle);
      const rx = bandRx + 0.004, rz = bandRz + 0.004, y0 = browY + 0.004, h = 0.078 + (f % 2) * 0.016;
      const tangentX = cz * 0.016, tangentZ = -sx * 0.016;
      const px = sx * rx, pz = bandCenterZ + cz * rz;
      const n = [sx, 0.15, cz];
      const a = pushVertex([px - tangentX, y0, pz - tangentZ], n, [0.72, 0.50, 0.08], headBones, headWeights);
      const b = pushVertex([px + tangentX, y0, pz + tangentZ], n, [0.72, 0.50, 0.08], headBones, headWeights);
      const c = pushVertex([px * 1.2, y0 + h, pz * 1.2], n, [0.62, 0.07, 0.04], headBones, headWeights);
      extraTris.push(a, b, c);
    }
  });
  // 9. A stone plug set in the lower lip.
  asPiece('LIP_PLUG', () => {
    const y = eyeY - 0.098, z = 0.1, r = 0.007, n = [0, 0, 1], stone = [0.28, 0.42, 0.36];
    const a = pushVertex([-r, y - r, z], n, stone, headBones, headWeights);
    const b = pushVertex([r, y - r, z], n, stone, headBones, headWeights);
    const c = pushVertex([r, y + r, z], n, stone, headBones, headWeights);
    const d = pushVertex([-r, y + r, z], n, stone, headBones, headWeights);
    pushQuad(a, b, c, d);
  });

  const totalVertCount = baseVertCount + extraVerts.length;
  const vertices = new Uint8Array(totalVertCount * 60);
  vertices.set(baseBytes, 0);
  const vf = new Float32Array(vertices.buffer, vertices.byteOffset, vertices.byteLength / 4);
  const vu = new Uint16Array(vertices.buffer, vertices.byteOffset, vertices.byteLength / 2);
  for (let i = 0; i < extraVerts.length; i++) {
    const v = extraVerts[i];
    const vIdx = baseVertCount + i;
    const fOff = vIdx * 15;
    const uOff = vIdx * 30;
    vf[fOff + 0] = v.pos[0];
    vf[fOff + 1] = v.pos[1];
    vf[fOff + 2] = v.pos[2];
    vf[fOff + 3] = v.norm[0];
    vf[fOff + 4] = v.norm[1];
    vf[fOff + 5] = v.norm[2];
    vf[fOff + 6] = v.col[0];
    vf[fOff + 7] = v.col[1];
    vf[fOff + 8] = v.col[2];
    vu[uOff + 18] = v.bones[0];
    vu[uOff + 19] = v.bones[1];
    vu[uOff + 20] = v.bones[2];
    vu[uOff + 21] = v.bones[3];
    vf[fOff + 11] = v.weights[0];
    vf[fOff + 12] = v.weights[1];
    vf[fOff + 13] = v.weights[2];
    vf[fOff + 14] = v.weights[3];
  }

  const indices = new Uint32Array(baseModel.indices.length + extraTris.length);
  indices.set(baseModel.indices, 0);
  indices.set(extraTris, baseModel.indices.length);
  const lods = createCrewLODs({
    vertices,
    indices,
    vertexCount: totalVertCount,
    animator: baseModel.animator,
  });

  return {
    ...baseModel,
    sex: female ? 'female' : 'male',
    indigenous: true,
    modelVariant: female ? 'indigenous-female' : 'indigenous-male',
    vertices,
    indices,
    lods,
    vertexCount: totalVertCount,
    accessoryVertexCount: extraVerts.length,
    accessoryTriangleCount: extraTris.length / 3,
  };
}

export function createIndigenousCrewModels(models) {
  if (!Array.isArray(models) || models.length < 2) {
    throw Error('createIndigenousCrewModels requires [maleModel, femaleModel]');
  }
  const cached = cachedIndigenousModels.get(models[0]);
  if (cached) return cached;
  const pair = [
    buildIndigenousCrewModel(models[0].indigenousBase ?? models[0], false),
    buildIndigenousCrewModel(models[1].indigenousBase ?? models[1], true),
  ];
  cachedIndigenousModels.set(models[0], pair);
  return pair;
}

// 16th-century Spanish Garrison (*Soldados de Presidio*) uniform colours (linear RGB):
// Tercio crimson, buff leather jerkin, steel breastplate, artillery slate, officer gold-ochre, garrison russet.
const GARRISON_SHIRTS = Object.freeze([
  [.42,.06,.05],
  [.50,.36,.17],
  [.28,.30,.33],
  [.14,.20,.28],
  [.56,.38,.10],
  [.34,.16,.10],
]);
const GARRISON_TROUSERS = Object.freeze([
  [.12,.09,.08],
  [.09,.11,.14],
  [.18,.08,.07],
  [.15,.13,.10],
]);

export function createFortificationSoldiersForInstance(inst, startIndex = 0) {
  if (!inst || !FORTIFICATION_PREFAB_IDS.includes(inst.prefabId)) return [];
  const hw = (inst.width ?? 24) * 0.5;
  const hl = (inst.length ?? 28) * 0.5;
  const yGround = inst.y ?? 0;
  const yTop = yGround + (inst.height ?? 8);
  const cosY = Math.cos(inst.yaw ?? 0);
  const sinY = Math.sin(inst.yaw ?? 0);
  const wallT = 1.75;
  const specs = [];

  if (inst.trace) {
    // Gunners behind the guns the trace has, sentries on the points of its bastions and a captain in the yard.
    const yDeck = yTop - 0.85, trace = inst.trace, lowAt = (z) => (trace.lowZ !== null && trace.lowZ !== undefined && z < trace.lowZ ? trace.lowDrop : 0);
    const inward = insetOutline(trace.outline, 2.6);
    // Nobody shares a post, at a sharp corner or where a beat crosses a gun.
    const free = (lx, lz) => specs.every((spec) => Math.hypot(spec.lx - lx, spec.lz - lz) > 1.6);
    trace.guns.forEach((gun, gunIndex) => {
      let lx = gun.x - gun.nx * 2.5, lz = gun.z - gun.nz * 2.5;
      if (!free(lx, lz)) { lx = gun.x - gun.nx * 1.3; lz = gun.z - gun.nz * 1.3; }
      if (free(lx, lz)) specs.push({ lx, ly: yTop - 0.16 - lowAt(gun.z), lz, routeZ: [lz, lz], localYaw: Math.atan2(gun.nx, gun.nz), role: 'Artillero', stationKind: 'embrasure', gunIndex });
    });
    trace.salients.slice(0, 5).forEach((at) => {
      const [lx, lz] = inward[at];
      if (free(lx, lz)) specs.push({ lx, ly: yDeck - lowAt(lz), lz, routeZ: [lz - 1.2, lz + 1.2], localYaw: Math.atan2(lx, lz), role: 'Vigía de Garita', stationKind: 'bastion' });
    });
    // Sentries walk the longest walls with no guns on them. A beat runs along z, so one on a wall set across it is short.
    const gunWalls = new Set(trace.guns.map((gun) => gun.wall));
    const beats = traceWalls(trace).filter((wall) => wall.index !== trace.gate.wall && wall.length >= 8).sort((a, b) => Number(gunWalls.has(a.index)) - Number(gunWalls.has(b.index)) || b.length - a.length).slice(0, 8);
    beats.forEach((wall, beat) => {
      const lx = (wall.ax + wall.bx) * 0.5 - wall.nx * 3.2, lz = (wall.az + wall.bz) * 0.5 - wall.nz * 3.2;
      const run = Math.abs(wall.uz) > 0.85 ? Math.min(6, wall.length * 0.3) : 1.2;
      if (free(lx, lz)) specs.push({ lx, ly: yTop - 0.16 - lowAt(lz), lz, routeZ: [lz - run, lz + run], localYaw: beat % 2 ? Math.PI : 0, role: beat % 2 ? 'Alabardero' : 'Centinela de Muralla', stationKind: 'rampart' });
    });
    const gate = trace.gate;
    for (const hand of [-1, 1]) {
      const gateX = gate.x - gate.nx * 3.2 + gate.ux * 2.6 * hand, gateZ = gate.z - gate.nz * 3.2 + gate.uz * 2.6 * hand;
      if (free(gateX, gateZ)) specs.push({ lx: gateX, ly: yDeck - lowAt(gate.z), lz: gateZ, routeZ: [gateZ, gateZ], localYaw: Math.atan2(gate.nx, gate.nz), role: 'Guardia de Puerta', stationKind: 'rampart' });
    }
    const yard = trace.buildings.find((building) => building.kind === 'magazine');
    if (yard && free(yard.x, yard.z - yard.radius - 2.4)) specs.push({ lx: yard.x, ly: yDeck - lowAt(yard.z), lz: yard.z - yard.radius - 2.4, routeZ: [yard.z - yard.radius - 3.4, yard.z - yard.radius - 1.4], localYaw: 0, role: 'Capitán de Presidio', stationKind: 'citadel' });
  } else if (inst.prefabId === 'stone_sea_bastion') {
    const yDeck = yTop - 0.85;
    const yBanquette = yTop - 0.16;
    const zSea = -hl + wallT + 0.55;
    const zLand = hl - wallT - 0.55;
    for (const [gIdx, k] of [-1, 0, 1].entries()) {
      const lx = k * (hw * 0.48);
      specs.push({ lx, ly: yBanquette, lz: zSea, routeZ: [zSea, zSea], localYaw: Math.PI, role: 'Artillero', stationKind: 'embrasure', gunIndex: gIdx });
    }
    for (const [gIdx, k] of [-0.5, 0.5].entries()) {
      const lx = k * (hw * 0.50);
      specs.push({ lx, ly: yBanquette, lz: zLand, routeZ: [zLand, zLand], localYaw: 0, role: 'Artillero', stationKind: 'embrasure', gunIndex: 3 + gIdx });
    }
    const zSpan0 = Math.max(-hl + 3.2, -hl * 0.78);
    const zSpan1 = Math.min(-1.0, -hl * 0.18);
    const zSpan2 = Math.max(1.0, hl * 0.18);
    const zSpan3 = Math.min(hl - 3.2, hl * 0.78);
    for (const sideX of [-1, 1]) {
      const lx = sideX * Math.max(2.2, hw - wallT - 0.55);
      specs.push({ lx, ly: yBanquette, lz: (zSpan0 + zSpan1) * 0.5, routeZ: [zSpan0, zSpan1], localYaw: 0, role: 'Centinela de Muralla', stationKind: 'rampart' });
      specs.push({ lx, ly: yBanquette, lz: (zSpan2 + zSpan3) * 0.5, routeZ: [zSpan2, zSpan3], localYaw: Math.PI, role: 'Alabardero', stationKind: 'rampart' });
    }
    // 2 Seaward corner Garita lookouts visible on the flanking sentry turrets
    for (const sx of [-1, 1]) {
      const gx = sx * (hw + 0.35);
      const gz = -(hl + 0.35);
      specs.push({ lx: gx, ly: yTop - 0.10, lz: gz, routeZ: [gz, gz], localYaw: Math.PI, role: 'Vigía de Garita', stationKind: 'garita' });
    }
    const kw = Math.min(6.4, hw * 0.46);
    specs.push({ lx: -kw - 1.15, ly: yDeck, lz: 0, routeZ: [-1.8, 1.8], localYaw: 0, role: 'Capitán de Presidio', stationKind: 'citadel' });
  } else if (inst.prefabId === 'bastion_trace_fortress') {
    const yDeck = yTop - 0.85;
    const yBanquette = yTop - 0.16;
    const bOut = 4.2;
    const zSea = -hl + wallT + 0.55;
    const zLand = hl - wallT - 0.55;
    for (const [gIdx, k] of [-1.5, -0.5, 0.5, 1.5].entries()) {
      const lx = k * (hw * 0.34);
      specs.push({ lx, ly: yBanquette, lz: zSea, routeZ: [zSea, zSea], localYaw: Math.PI, role: 'Artillero', stationKind: 'embrasure', gunIndex: gIdx });
    }
    for (const [gIdx, k] of [-0.5, 0.5].entries()) {
      const lx = k * (hw * 0.34);
      specs.push({ lx, ly: yBanquette, lz: zLand, routeZ: [zLand, zLand], localYaw: 0, role: 'Artillero', stationKind: 'embrasure', gunIndex: 4 + gIdx });
    }
    // 4 Corner diamond bastions (top surface at yTop + 0.65)
    const yBastion = yTop + 0.65;
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) {
        const bx = sx * (hw + 0.3);
        const bz = sz * (hl + 0.3);
        specs.push({ lx: bx, ly: yBastion, lz: bz, routeZ: [bz - 1.25, bz + 1.25], localYaw: sz < 0 ? Math.PI : 0, role: 'Arcabucero de Baluarte', stationKind: 'bastion' });
      }
    }
    // 2 Seaward ravelin guards (top surface at yTop - 1.3)
    const yRavelin = yTop - 1.25;
    const zRavelin = -hl - bOut - 4.5;
    for (const sx of [-1, 1]) {
      specs.push({ lx: sx * 2.4, ly: yRavelin, lz: zRavelin, routeZ: [zRavelin - 1.1, zRavelin + 1.1], localYaw: Math.PI, role: 'Guardia de Revellín', stationKind: 'ravelin' });
    }
    // 2 Flank rampart sentries patrolling the east and west curtain walls
    for (const sx of [-1, 1]) {
      specs.push({ lx: sx * (hw - wallT - 0.55), ly: yBanquette, lz: 0, routeZ: [-hl * 0.55, hl * 0.55], localYaw: sx < 0 ? 0 : Math.PI, role: 'Alabardero', stationKind: 'rampart' });
    }
  } else if (inst.prefabId === 'torreon_atalaya_farol') {
    const rBase = Math.min(hw, hl);
    const yPlinth = yGround + 0.85;
    const cairnName = String(inst.cairnSpec?.name ?? inst.label ?? '');
    if (cairnName.includes('Torre de Belém')) {
      // Torre de Belém: 2 lookouts on the Keep crown (yGround + 21.0, z = 2..11) + 4 sentries on the seaward Bastion deck (yGround + 6.4, z = -9..1)
      const yKeepRoof = yGround + 21.0;
      const yBastionDeck = yGround + 6.4;
      for (const sx of [-1, 1]) {
        specs.push({ lx: sx * 2.8, ly: yKeepRoof, lz: 6.7, routeZ: [4.2, 9.2], localYaw: sx < 0 ? 0 : Math.PI, role: 'Vigía da Torre', stationKind: 'crown' });
        specs.push({ lx: sx * 4.6, ly: yBastionDeck, lz: -6.2, routeZ: [-8.2, -3.2], localYaw: Math.PI, role: 'Bombardeiro do Baluarte', stationKind: 'rampart' });
        specs.push({ lx: sx * 3.0, ly: yBastionDeck, lz: -10.8, routeZ: [-11.6, -9.8], localYaw: Math.PI, role: 'Alabardeiro Real', stationKind: 'plinth' });
      }
    } else if (cairnName.includes('Torreão do Paço')) {
      // Torreão do Paço da Ribeira: 2 guards on the Seaward Royal Balcony (yGround + 7.9) + 2 sentries on the Crown Cornice (yGround + 15.65) + 2 at Water Stairs (yGround + 1.4)
      for (const sx of [-1, 1]) {
        specs.push({ lx: sx * 6.0, ly: yGround + 15.65, lz: -2.0, routeZ: [-6.5, 2.5], localYaw: Math.PI, role: 'Vigía do Torreão', stationKind: 'crown' });
        specs.push({ lx: sx * 2.4, ly: yGround + 7.9, lz: -9.7, routeZ: [-9.7, -9.7], localYaw: Math.PI, role: 'Guarda Real da Varanda', stationKind: 'rampart' });
        specs.push({ lx: sx * 3.2, ly: yGround + 1.4, lz: -9.8, routeZ: [-9.8, -9.8], localYaw: Math.PI, role: 'Alabardeiro do Cais', stationKind: 'plinth' });
      }
    } else if (inst.materialKind === 10) {
      for (const sx of [-1, 1]) {
        specs.push({ lx: sx * rBase * 0.35, ly: yTop, lz: -rBase * 0.35, routeZ: [-rBase * 0.35, -rBase * 0.35], localYaw: Math.PI, role: 'Vigía de Atalaya', stationKind: 'crown' });
        specs.push({ lx: sx * rBase * 0.68, ly: yPlinth, lz: -rBase - 0.35, routeZ: [-rBase - 0.35, -rBase + 0.45], localYaw: Math.PI, role: 'Centinela', stationKind: 'plinth' });
      }
    } else {
      const yCrown = yTop + 0.65;
      const rCrown = rBase * 0.62;
      for (let s = 0; s < 4; s++) {
        const angle = (s + 0.5) * (Math.PI * 0.5);
        const lx = Math.sin(angle) * rCrown;
        const lz = Math.cos(angle) * rCrown;
        specs.push({ lx, ly: yCrown, lz, routeZ: [lz, lz], localYaw: angle, role: 'Vigía de Torreón', stationKind: 'crown' });
      }
      for (const sx of [-1, 1]) {
        specs.push({ lx: sx * 2.2, ly: yPlinth, lz: -rBase - 0.38, routeZ: [-rBase - 0.38, -rBase - 0.38], localYaw: Math.PI, role: 'Alabardero de Torre', stationKind: 'plinth' });
      }
    }
  } else if (inst.prefabId === 'english_triangular_palisade_fort') {
    const yPlinth = yGround + 0.25;
    const yWallTop = yPlinth + 4.4;
    const yBulwarkDeck = yWallTop - 0.95;
    const yBanquette = yWallTop - 1.10;
    const plan = enclosurePlan(inst), [bSW, bSE] = plan.bastions;
    const [one, two, three, four] = plan.guns;
    for (const [gunIndex, [gun, role]] of [
      [one, 'Master Gunner'],
      [two, 'Culverin Gunner'],
      [three, 'Bulwark Gunner'],
      [four, 'North Bulwark Sentry'],
    ].entries()) {
      const gx = gun.x - gun.nx * 1.15;
      const gz = gun.z - gun.nz * 1.15;
      specs.push({
        lx: gx,
        ly: yBulwarkDeck,
        lz: gz,
        routeZ: [gz - 0.7, gz + 0.7],
        localYaw: Math.atan2(gun.nx, gun.nz),
        role,
        stationKind: 'embrasure',
        gunIndex,
      });
    }
    specs.push({ lx: -hw * 0.38, ly: yBanquette, lz: bSW[1] + 1.2, routeZ: [bSW[1] + 0.6, bSW[1] + 2.4], localYaw: Math.PI, role: 'Captain of the Guard', stationKind: 'rampart' });
    specs.push({ lx: hw * 0.38, ly: yBanquette, lz: bSE[1] + 1.2, routeZ: [bSE[1] + 0.6, bSE[1] + 2.4], localYaw: Math.PI, role: 'Pikeman / Musketeer', stationKind: 'rampart' });
    // Two at the gate, either side of it, just outside.
    const gate = plan.gate;
    for (const [hand, role] of [[-1, 'Gate Halberdier'], [1, 'Gate Musketeer']]) {
      const lz = gate.z + gate.nz * 2.2 + gate.uz * hand * 3.2;
      specs.push({ lx: gate.x + gate.nx * 2.2 + gate.ux * hand * 3.2, ly: yPlinth, lz, routeZ: [lz - 1.2, lz + 1.2], localYaw: Math.atan2(gate.nx, gate.nz), role, stationKind: 'parade' });
    }
  } else if (inst.prefabId === 'curtain_wall_and_gate') {
    const wallHW = Math.min(3.4, hw);
    const yWalk = yTop - 0.18;
    const yGateTop = yTop + 2.8;
    const gHW = wallHW + 1.15;
    const zWingMax = Math.max(6.2, hl - 2.0);
    const zWingMin = Math.min(zWingMax - 1.2, 4.8);
    for (const sideZ of [-1, 1]) {
      const z0 = sideZ < 0 ? -zWingMax : zWingMin;
      const z1 = sideZ < 0 ? -zWingMin : zWingMax;
      const zMid = (z0 + z1) * 0.5;
      specs.push({ lx: -wallHW + 1.05, ly: yWalk, lz: zMid - 0.8, routeZ: [z0, zMid], localYaw: 0, role: 'Centinela de Muralla', stationKind: 'adarve' });
      specs.push({ lx: wallHW - 1.05, ly: yWalk, lz: zMid + 0.8, routeZ: [zMid, z1], localYaw: Math.PI, role: 'Arcabucero', stationKind: 'adarve' });
    }
    for (const sz of [-1, 1]) {
      specs.push({ lx: -wallHW * 0.45, ly: yGateTop, lz: sz * 1.4, routeZ: [sz * 1.4, sz * 1.4], localYaw: -Math.PI / 2, role: 'Vigía de Puerta', stationKind: 'gate-roof' });
      specs.push({ lx: -gHW - 0.35, ly: yGround + 0.65, lz: sz * 2.2, routeZ: [sz * 2.2, sz * 2.2], localYaw: -Math.PI / 2, role: 'Guardia de Puerta', stationKind: 'gate-portal' });
    }
  }

  return specs.map((spec, idx) => {
    const globalIdx = startIndex + idx;
    const isIndigenousFort = Boolean(inst.indigenous);
    const identity = crewStationIdentity(`fort_${inst.id ?? inst.prefabId}_${idx}`, globalIdx);
    const sex = isIndigenousFort ? (globalIdx % 2 === 0 ? 'female' : 'male') : identity.sex;
    const name = isIndigenousFort
      ? INDIGENOUS_NAMES[sex][Math.floor(globalIdx / 2) % INDIGENOUS_NAMES[sex].length]
      : identity.name;
    const look = isIndigenousFort ? null : CREW_APPEARANCES[identity.identityId ?? identity.id];
    const role = isIndigenousFort
      ? spec.stationKind === 'embrasure'
        ? 'Sovereign Artillerist'
        : spec.stationKind === 'citadel'
          ? 'Wampum War Captain'
          : 'Rampart Guardian'
      : spec.role;
    const dress = isIndigenousFort ? indigenousDress(inst.cultureId, sex, globalIdx, { role }) : null;
    const s = createDeckhand();
    const baseLy = spec.ly;
    const effLy = baseLy + spec.lx * (inst.slopeX ?? 0) + spec.lz * (inst.slopeZ ?? 0);
    const wx = (inst.x ?? 0) + spec.lx * cosY + spec.lz * sinY;
    const wy = effLy + 0.028;
    const wz = (inst.z ?? 0) - spec.lx * sinY + spec.lz * cosY;
    const worldYaw = (spec.localYaw ?? 0) + (inst.yaw ?? 0);
    Object.assign(s, {
      id: `${inst.id ?? inst.prefabId}_soldier_${idx + 1}`,
      name,
      sex,
      identityId: identity.identityId,
      role,
      stationKind: spec.stationKind,
      gunIndex: spec.gunIndex ?? null,
      buildingId: inst.id ?? inst.prefabId,
      buildingPrefabId: inst.prefabId,
      building: inst,
      lx: spec.lx,
      baseLy,
      ly: effLy,
      lz: spec.lz,
      routeZ: [...spec.routeZ],
      targetZ: spec.routeZ[1],
      localYaw: spec.localYaw ?? 0,
      yaw: worldYaw,
      wait: (globalIdx % 7) * 0.45,
      time: globalIdx * 0.41,
      walkTime: globalIdx * 0.29,
      crewIndex: globalIdx,
      garrison: true,
      indigenous: isIndigenousFort,
      cultureId: inst.cultureId ?? null,
      modelVariant: isIndigenousFort ? (sex === 'female' ? 'indigenous-female' : 'indigenous-male') : 'colonial',
      shirt: isIndigenousFort
        ? dress.shirt
        : GARRISON_SHIRTS[globalIdx % GARRISON_SHIRTS.length],
      trousers: isIndigenousFort
        ? dress.trousers
        : GARRISON_TROUSERS[globalIdx % GARRISON_TROUSERS.length],
      skin: isIndigenousFort ? dress.skin : crewLinearColour(look.skin),
      hair: isIndigenousFort ? dress.hair : crewLinearColour(look.hair),
      face: isIndigenousFort ? dress.face : [...look.face],
      dress: isIndigenousFort ? dress.mask : 0,
    });
    s.compMask = isIndigenousFort ? 0 : crewComponentMaskForActor(s, globalIdx, { garrison: true });
    s.scale.fill((s.sex === 'female' ? 1.04 : 1.02) * (1 + ((globalIdx % 3) - 1) * 0.02));
    s.position.set([wx, wy, wz]);
    const half = s.yaw * 0.5;
    s.rotation.set([0, Math.sin(half), 0, Math.cos(half)]);
    gltfTRS(s.transform, s.position, s.rotation, s.scale);
    return s;
  });
}

export function createIndigenousVillagersForInstance(inst, startIndex = 0, cultureId = null) {
  if (!inst || !INDIGENOUS_VILLAGE_PREFAB_IDS.includes(inst.prefabId)) return [];
  const hw = (inst.width ?? 10) * 0.5;
  const hl = (inst.length ?? 12) * 0.5;
  const yGround = inst.y ?? 0;
  const cosY = Math.cos(inst.yaw ?? 0);
  const sinY = Math.sin(inst.yaw ?? 0);
  const specs = [];

  if (inst.prefabId === 'abenaki_birchbark_wigwam' || inst.prefabId === 'taino_circular_bohio') {
    const rDoor = Math.min(hw, hl) + 1.15;
    specs.push({ lx: -1.1, ly: yGround + 0.04, lz: -rDoor, routeZ: [-rDoor - 1.8, -rDoor + 0.4], localYaw: 0, role: 'Villager' });
    specs.push({ lx: 1.1, ly: yGround + 0.04, lz: -rDoor - 0.6, routeZ: [-rDoor - 2.2, -rDoor], localYaw: 0, role: 'Artisan / Weaver' });
  } else if (inst.prefabId === 'algonquian_longhouse' || inst.prefabId === 'tupinamba_oca_longhouse' || inst.prefabId === 'kalinago_carbet_hall') {
    const zFront = -hl - 1.4;
    const zSide0 = -hl * 0.65;
    const zSide1 = hl * 0.65;
    specs.push({ lx: -1.4, ly: yGround + 0.05, lz: zFront, routeZ: [zFront - 2.0, zFront + 0.2], localYaw: 0, role: 'Sachem / Cacique' });
    specs.push({ lx: 1.4, ly: yGround + 0.05, lz: zFront - 0.5, routeZ: [zFront - 2.2, zFront], localYaw: 0, role: 'Elder / Speaker' });
    specs.push({ lx: -(hw + 1.45), ly: yGround + 0.04, lz: 0, routeZ: [zSide0, zSide1], localYaw: 0, role: 'Hunter / Bowyer' });
    specs.push({ lx: hw + 1.45, ly: yGround + 0.04, lz: 0, routeZ: [zSide0, zSide1], localYaw: Math.PI, role: 'Potter / Cultivator' });
  } else if (inst.prefabId === 'taino_cacique_caney' || inst.prefabId === 'maya_limestone_shrine_and_na') {
    const yPlinth = yGround + (inst.prefabId === 'maya_limestone_shrine_and_na' ? 0.55 : 0.12);
    const zFront = -hl - 1.3;
    specs.push({ lx: 0, ly: yPlinth, lz: -hl * 0.68, routeZ: [-hl * 0.75, -hl * 0.45], localYaw: 0, role: 'Cacique / Halach Uinic' });
    specs.push({ lx: -2.2, ly: yGround + 0.05, lz: zFront, routeZ: [zFront - 2.4, zFront + 0.4], localYaw: 0, role: 'Behique / Guardian' });
    specs.push({ lx: 2.2, ly: yGround + 0.05, lz: zFront, routeZ: [zFront - 2.4, zFront + 0.4], localYaw: 0, role: 'Weaver / Noble' });
  } else if (inst.prefabId === 'taino_batey_court' || inst.prefabId === 'indigenous_palisade_ring') {
    const zSpan = Math.max(2.2, hl * 0.48);
    for (const sx of [-1, 1]) {
      specs.push({ lx: sx * (hw * 0.42), ly: yGround + 0.05, lz: 0, routeZ: [-zSpan, zSpan], localYaw: sx < 0 ? 0 : Math.PI, role: 'Plaza Villager' });
    }
  } else if (inst.prefabId === 'palafito_estuary_village') {
    const yDeck = yGround + (inst.height ?? 6.8) * 0.36 + 0.16;
    specs.push({ lx: -1.8, ly: yDeck, lz: -1.2, routeZ: [-hl * 0.45, hl * 0.45], localYaw: 0, role: 'Lagoon Fisher' });
    specs.push({ lx: 1.8, ly: yDeck, lz: 1.2, routeZ: [-hl * 0.45, hl * 0.45], localYaw: Math.PI, role: 'Net Maker' });
  } else if (inst.prefabId === 'indigenous_canoe_landing') {
    specs.push({ lx: -hw * 0.32, ly: yGround + 0.06, lz: -0.6, routeZ: [-hl * 0.45, hl * 0.45], localYaw: 0, role: 'Canoe Builder' });
    specs.push({ lx: hw * 0.32, ly: yGround + 0.06, lz: 0.4, routeZ: [-hl * 0.45, hl * 0.45], localYaw: Math.PI, role: 'Shore Lookout' });
  }

  return specs.map((spec, idx) => {
    const globalIdx = startIndex + idx;
    const sex = (globalIdx % 2 === 0) ? 'female' : 'male';
    const namePool = INDIGENOUS_NAMES[sex];
    const name = namePool[Math.floor(globalIdx / 2) % namePool.length];
    const dress = indigenousDress(cultureId ?? inst.indigenousCultureId ?? inst.cultureId, sex, globalIdx, { role: spec.role });
    const s = createDeckhand();
    const baseLy = spec.ly;
    const effLy = baseLy + spec.lx * (inst.slopeX ?? 0) + spec.lz * (inst.slopeZ ?? 0);
    const wx = (inst.x ?? 0) + spec.lx * cosY + spec.lz * sinY;
    const wy = effLy + 0.028;
    const wz = (inst.z ?? 0) - spec.lx * sinY + spec.lz * cosY;
    const worldYaw = (spec.localYaw ?? 0) + (inst.yaw ?? 0);
    Object.assign(s, {
      id: `${inst.id ?? inst.prefabId}_villager_${idx + 1}`,
      name,
      sex,
      indigenous: true,
      cultureId: cultureId ?? inst.indigenousCultureId ?? null,
      modelVariant: sex === 'female' ? 'indigenous-female' : 'indigenous-male',
      role: spec.role,
      stationKind: 'indigenous-village',
      gunIndex: null,
      buildingId: inst.id ?? inst.prefabId,
      buildingPrefabId: inst.prefabId,
      building: inst,
      lx: spec.lx,
      baseLy,
      ly: effLy,
      lz: spec.lz,
      routeZ: [...spec.routeZ],
      targetZ: spec.localYaw === Math.PI ? spec.routeZ[0] : spec.routeZ[1],
      localYaw: spec.localYaw ?? 0,
      yaw: worldYaw,
      wait: (globalIdx % 6) * 0.42,
      time: globalIdx * 0.39,
      walkTime: globalIdx * 0.27,
      crewIndex: globalIdx,
      garrison: true,
      strength: 1.0,
      shirt: dress.shirt,
      trousers: dress.trousers,
      skin: dress.skin,
      hair: dress.hair,
      face: dress.face,
      dress: dress.mask,
    });
    s.scale.fill((s.sex === 'female' ? 0.99 : 0.97) * (1 + ((globalIdx % 3) - 1) * 0.02));
    s.position.set([wx, wy, wz]);
    const half = s.yaw * 0.5;
    s.rotation.set([0, Math.sin(half), 0, Math.cos(half)]);
    gltfTRS(s.transform, s.position, s.rotation, s.scale);
    return s;
  });
}

// A port whose country Castle and Commons' model founded mans its posts from that model's own roll of the place
// (`port.watch`, from the board its land was laid from: js/old-world-board.js): whoever holds the place for its lord
// has a captain's post, and the men of the hosts within it and of its watch take the others in the roll's order.
// Each figure is then that person: their name, their sex, and one face of their own wherever they stand. A post the
// roll has no one for stands empty. A port with no such roll keeps the company this game gives it.
function garrisonMuster(watch) {
  if (!watch || !Array.isArray(watch.men)) return null;
  const men = [...watch.men];
  let holder = watch.captain ?? null;
  return (s) => {
    if (holder && isCaptainActor(s)) { const person = holder; holder = null; return person; }
    return men.shift() ?? null;
  };
}
export function garrisonEnlist(s, person) {
  const sex = person.sex === 'f' ? 'female' : 'male', faces = CREW_IDENTITIES.filter((one) => one.sex === sex);
  const identity = faces[Math.abs(person.id | 0) % faces.length], look = CREW_APPEARANCES[identity.id];
  Object.assign(s, { soul: person, name: person.name, sex, identityId: identity.id, skin: crewLinearColour(look.skin), hair: crewLinearColour(look.hair), face: [...look.face] });
  s.compMask = crewComponentMaskForActor(s, s.crewIndex ?? 0, { garrison: true });
  s.scale.fill((sex === 'female' ? 1.04 : 1.02) * (1 + (((s.crewIndex ?? 0) % 3) - 1) * 0.02));
  return s;
}

export function createFortGarrison(port) {
  const instances = port?.instances ?? [];
  const origin = [port?.center?.x ?? 0, 0, port?.center?.z ?? 0];
  const soldiers = [];
  // `units` is every building's men. `byBuilding` is by name, and two buildings of one plan may share a name.
  const byBuilding = new Map(), units = [];
  const cultureId = port?.indigenousSettlement?.cultureId ?? null;
  const muster = garrisonMuster(port?.watch);
  for (const inst of instances) {
    let unit = null;
    if (FORTIFICATION_PREFAB_IDS.includes(inst.prefabId)) {
      unit = createFortificationSoldiersForInstance(inst, soldiers.length);
      if (muster && !inst.indigenous) unit = unit.filter((s) => { const person = muster(s); return person ? garrisonEnlist(s, person) : false; });
    } else if (INDIGENOUS_VILLAGE_PREFAB_IDS.includes(inst.prefabId)) {
      unit = createIndigenousVillagersForInstance(inst, soldiers.length, cultureId);
    }
    if (!unit?.length) continue;
    for (const s of unit) {
      const relPos = [s.position[0] - origin[0], s.position[1] - origin[1], s.position[2] - origin[2]];
      gltfTRS(s.transform, relPos, s.rotation, s.scale);
      s._poseReady = true;
      soldiers.push(s);
    }
    inst.garrisonSoldiers = unit;
    units.push(unit);
    byBuilding.set(inst.id ?? inst.prefabId, unit);
  }
  // `watch` is the model's roll the posts were manned from, or null where the company is this game's own.
  const garrison = { port, origin, soldiers, byBuilding, units, time: 0, dateMs: null, watch: muster ? port.watch : null };
  if (port && typeof port === 'object') port.garrison = garrison;
  return garrison;
}

// Whoever had the stretch under him shot away comes down with it, to whatever is beneath. One walking a rampart
// keeps to what is left of his beat. Runs only when a building has lost something since the last look.
function settleGarrisonOnWhatIsLeft(garrison) {
  for (const unit of garrison.units ?? garrison.byBuilding.values()) {
    const inst = unit[0]?.building, damage = inst?.damageState, state = damage?.fracture;
    if (!state || state.brokenCount === (damage.garrisonSawBroken ?? 0)) continue;
    damage.garrisonSawBroken = state.brokenCount;
    // Nothing in the air means this is a saved ruin coming back: he is already where he fell.
    const settled = state.flying.size === 0;
    let low = Infinity, high = -Infinity;
    for (const s of unit) { if (s.ly < low) low = s.ly; if (s.ly > high) high = s.ly; }
    const near = state.fracture.shards.filter((shard) => shard && shard.localMin[1] <= high + 0.2 && shard.localMax[1] >= low - 1.1);
    for (const s of unit) {
      const footing = footingUnder(state, s.lx, s.ly, s.lz, near);
      // A body already lying there comes down with the stretch too, and has nothing more to say.
      if (footing.stood && !footing.stands) {
        garrisonSoldierFalls(state, s, inst, settled, garrison);
        continue;
      }
      if (s.casualtyState === 'fallen') continue;
      if (footing.floor !== null && footing.floor < s.ly - 0.05) {
        // What he stood on has gone, and the floor is a step below.
        s.homeBaseLy ??= s.baseLy;
        s.baseLy -= s.ly - footing.floor;
        s._poseReady = false;
      }
      if (!s.routeZ || Math.abs(s.routeZ[1] - s.routeZ[0]) <= 0.05) continue;
      s.homeRouteZ ??= [...s.routeZ];
      const [from, to] = s.homeRouteZ, length = Math.abs(to - from), steps = Math.max(1, Math.ceil(length / 0.5));
      let lo = s.lz, hi = s.lz;
      const dir = Math.sign(to - from) || 1;
      // Out each way from where he stands, as far as there is anything to stand on.
      for (let i = 1; i <= steps; i++) {
        const z = s.lz + (dir * length * i) / steps;
        if ((z - from) * dir > length + 1e-6) break;
        const there = footingUnder(state, s.lx, s.ly, z, near);
        if (there.stood && !there.stands) break;
        hi = z;
      }
      for (let i = 1; i <= steps; i++) {
        const z = s.lz - (dir * length * i) / steps;
        if ((z - from) * dir < -1e-6) break;
        const there = footingUnder(state, s.lx, s.ly, z, near);
        if (there.stood && !there.stands) break;
        lo = z;
      }
      s.routeZ = dir > 0 ? [lo, hi] : [hi, lo];
      s.targetZ = Math.abs(s.targetZ - hi) < Math.abs(s.targetZ - lo) ? hi : lo;
    }
  }
}

export function garrisonSoldierFalls(state, s, inst = {}, settled = false, garrison = state) {
  const cosY = Math.cos(inst.yaw ?? 0), sinY = Math.sin(inst.yaw ?? 0);
  const wx = (inst.x ?? 0) + (s.lx ?? 0) * cosY + (s.lz ?? 0) * sinY, wz = (inst.z ?? 0) - (s.lx ?? 0) * sinY + (s.lz ?? 0) * cosY;
  const slope = (s.lx ?? 0) * (inst.slopeX ?? 0) + (s.lz ?? 0) * (inst.slopeZ ?? 0);
  // `s.ly` is a height in the world, so a building whose pieces are not yet known leaves him on its own ground.
  const to = (state?.fracture ? restingHeightUnder(state, wx, wz, s.ly) : (inst.baseY ?? inst.y ?? 0)) - slope;
  const wasDown = s.casualtyState === 'fallen';
  s.homeBaseLy ??= s.baseLy;
  if (!wasDown) {
    s.casualtyState = 'fallen';
    s.fallenAtMs = Number.isFinite(garrison?.dateMs) ? garrison.dateMs : null;
    s.woundSeverity = Math.max(s.woundSeverity ?? 0, 0.72);
    const roll = (((s.crewIndex ?? 0) * 0.6180339887 + 0.23) % 1 + 1) % 1;
    recordCrewWound(s, 'fall', [wx, (s.ly ?? 2) + 0.45, wz], [0, -1, 0], roll);
  }
  s.walk = 0;
  s._poseReady = false;
  if (settled) s.baseLy = to;
  else {
    if (s.garrisonFall) s.garrisonFall.to = Math.min(s.garrisonFall.to, to);
    else s.garrisonFall = { to, speed: 0 };
    if (!wasDown && garrison && typeof garrison === 'object') {
      (garrison.audioEvents ??= []).push({
        type: 'casualty-scream',
        sex: s.sex ?? 'male',
        cause: 'aloft',
        position: [wx, s.ly ?? 4, wz],
      });
    }
  }
}

// A rebuilt building has its men back on its walls, as they were posted.
export function reviveGarrisonSoldiers(building) {
  for (const s of building?.garrisonSoldiers ?? []) {
    if (s.homeBaseLy !== undefined) s.baseLy = s.homeBaseLy;
    if (s.homeLxz) { s.lx = s.homeLxz[0]; s.lz = s.homeLxz[1]; }
    if (s.homeRouteZ) s.routeZ = s.homeRouteZ;
    s.homeBaseLy = undefined;
    s.homeLxz = undefined;
    s.homeRouteZ = undefined;
    s.garrisonFall = null;
    s.fallenElapsedS = 0;
    s.fallenAtMs = null;
    s.visible = true;
    s.casualtyState = 'able';
    s.health = 1;
    s.woundSeverity = 0;
    s.scorchAmount = 0;
    s.knockbackVx = 0;
    s.knockbackVz = 0;
    s.knockbackVy = 0;
    s.knockdownTimer = 0;
    s.phys = undefined;
    s.ragdoll = null;
    clearCrewWounds(s);
    s._poseReady = false;
  }
}

// A day, on the game's calendar when the caller gives its date, and otherwise in seconds stepped at this port.
export const GARRISON_CASUALTY_STAY_S = 86400;
const GARRISON_BODY_HEIGHT_M = 1.7;

// The craters a building has taken since its garrison last looked. Its list is capped and drops the oldest, so the
// place kept in it is the last crater seen and not a count. A rebuilt building has a new record, and a new list.
function garrisonFreshCraters(damage) {
  const craters = damage?.craters;
  if (!craters?.length) return null;
  const last = craters[craters.length - 1];
  if (damage.garrisonSawCrater === last) return null;
  const from = craters.lastIndexOf(damage.garrisonSawCrater) + 1;
  damage.garrisonSawCrater = last;
  damage.garrisonCraterSerial = (damage.garrisonCraterSerial ?? 0) + craters.length - from;
  return from ? craters.slice(from) : craters;
}

export function stepFortGarrison(garrison, dt = 0, wind = 0, dateMs = null) {
  if (!garrison?.soldiers?.length) return garrison;
  dt = Math.max(0, Math.min(0.1, Number.isFinite(dt) ? dt : 0));
  garrison.time = (garrison.time ?? 0) + dt;
  garrison.dateMs = Number.isFinite(dateMs) ? dateMs : null;
  settleGarrisonOnWhatIsLeft(garrison);
  for (const unit of garrison.units ?? garrison.byBuilding?.values() ?? []) unit.freshCraters = garrisonFreshCraters(unit[0]?.building?.damageState);
  const ox = garrison.origin[0], oy = garrison.origin[1], oz = garrison.origin[2];
  const blend = 1 - Math.exp(-dt * 8);
  for (const s of garrison.soldiers) {
    s.time += dt;
    const inst = s.building;
    const dmg = inst?.damageState;
    // Men who come into being on a ruin fell with it while nobody was there: they lie where it left them, unheard.
    const firstLook = !s.garrisonSeen;
    s.garrisonSeen = true;
    if (dmg?.state === 'ruined' && s.casualtyState !== 'fallen') {
      garrisonSoldierFalls(dmg?.fracture, s, inst, firstLook, garrison);
      if (firstLook && Number.isFinite(dmg.lastHitDateMs)) s.fallenAtMs = dmg.lastHitDateMs;
    }
    if (s.casualtyState === 'fallen') {
      s.fallenElapsedS = (s.fallenElapsedS ?? 0) + dt;
      if (garrison.dateMs !== null) s.fallenAtMs ??= garrison.dateMs;
      const lain = garrison.dateMs !== null && Number.isFinite(s.fallenAtMs) ? (garrison.dateMs - s.fallenAtMs) / 1000 : s.fallenElapsedS;
      if (lain >= GARRISON_CASUALTY_STAY_S) {
        s.visible = false;
        continue;
      }
    } else {
      s.fallenElapsedS = 0;
      s.fallenAtMs = null;
    }
    // Shot that has taken a body to pieces leaves nothing to draw until the building is manned again.
    s.visible = !s.obliterated;
    const impacts = inst?.garrisonSoldiers?.freshCraters;
    if (impacts) {
      const serial = (dmg.garrisonCraterSerial ?? impacts.length) - impacts.length;
      const baseY = inst?.baseY ?? inst?.y ?? 0;
      for (let i = 0; i < impacts.length; i++) {
        const imp = impacts[i], k = serial + i;
        const lp = imp.localPosition;
        if (!lp) continue;
        const dx = s.lx - lp[0];
        const dz = s.lz - lp[2];
        // A body stands from his feet to his head, and a crater is where the shot struck, at whatever height.
        const craterY = imp.position?.[1] ?? baseY + lp[1], feet = s.ly ?? baseY;
        const dy = Math.max(0, feet - craterY, craterY - (feet + GARRISON_BODY_HEIGHT_M));
        const d = Math.hypot(dx, dy, dz);
        const flat = Math.hypot(dx, dz);
        // A magazine's crater is as wide as its blast. A shot's is the stone it broke, and its splinters go a few
        // times that far and no farther.
        const blastR = imp.isExplosion ? Math.max(6.0, (imp.radius ?? 2.0) * 3.2) : (imp.radius ?? 1.0) * 3.2;
        const killR = imp.isExplosion ? 5.5 : Math.min(2.6, (imp.radius ?? 1.0) * 1.6);
        if (d < blastR) {
          const prox = Math.max(0.15, 1 - d / blastR);
          const strength = imp.strength ?? imp.severity ?? 0.75;
          const dirX = flat > 1e-3 ? dx / flat : (((s.crewIndex ?? 0) % 2 === 0) ? 1 : -1);
          const dirZ = flat > 1e-3 ? dz / flat : 0.5;
          const cosB = Math.cos(inst?.yaw ?? 0), sinB = Math.sin(inst?.yaw ?? 0);
          const wDirX = dirX * cosB + dirZ * sinB;
          const wDirZ = -dirX * sinB + dirZ * cosB;
          const impulse = prox * (imp.isExplosion ? 8.5 : 4.8);
          s.homeLxz ??= [s.lx, s.lz];
          s.homeBaseLy ??= s.baseLy;
          s.knockbackVx = (s.knockbackVx ?? 0) + dirX * impulse;
          s.knockbackVz = (s.knockbackVz ?? 0) + dirZ * impulse;
          s.knockbackVy = Math.max(s.knockbackVy ?? 0, prox * (imp.isExplosion ? 4.4 : 2.6));
          s.collapseYaw = Math.atan2(wDirX, wDirZ);
          s.fallDir = ((s.crewIndex ?? 0) % 2 === 0) ? 1 : -1;
          s.scorchAmount = Math.min(1, (s.scorchAmount ?? 0) + prox * (imp.isExplosion ? 0.85 : 0.45));
          const roll = (((k + 1) * 0.6180339887 + (s.crewIndex ?? 0) * 0.7548776662) % 1 + 1) % 1;
          const hitY = (s.position?.[1] ?? s.ly ?? 0) + 0.35 + ((roll * 1.732) % 1) * 1.1;
          const sideSign = (((k + (s.crewIndex ?? 0)) % 2) === 0 ? 1 : -1) * 0.22;
          const worldHitOnBody = [
            (s.position?.[0] ?? inst?.x ?? 0) - wDirX * 0.18 + wDirZ * sideSign,
            hitY,
            (s.position?.[2] ?? inst?.z ?? 0) - wDirZ * 0.18 - wDirX * sideSign,
          ];
          recordCrewWound(s, imp.isExplosion || d < Math.min(2.2, killR) ? 'ball' : 'splinter', worldHitOnBody, [wDirX, 0.25, wDirZ], roll);
          const wasAble = s.casualtyState !== 'fallen';
          if (d < killR && strength > 0.45) {
            s.casualtyState = 'fallen';
            s.health = 0;
            s.woundSeverity = 1.0;
            if (wasAble) {
              s.fallenAtMs = garrison.dateMs;
              (garrison.audioEvents ??= []).push({
                type: 'casualty-scream',
                sex: s.sex ?? 'male',
                cause: 'blast',
                position: [s.position?.[0] ?? inst?.x ?? 0, s.position?.[1] ?? 2, s.position?.[2] ?? inst?.z ?? 0],
              });
            }
          } else {
            if (s.casualtyState !== 'fallen') {
              s.casualtyState = 'wounded';
              s.health = Math.max(0.25, (s.health ?? 1) - 0.45 * prox);
              s.woundSeverity = Math.min(1, Math.max(s.woundSeverity ?? 0, 0.45 + 0.45 * prox));
            }
            s.knockdownTimer = Math.max(s.knockdownTimer ?? 0, 1.4 + prox * 1.4);
          }
          s._poseReady = false;
        }
      }
    }
    if (dt > 0 && (Math.abs(s.knockbackVx ?? 0) > 1e-3 || Math.abs(s.knockbackVz ?? 0) > 1e-3 || (s.knockbackVy ?? 0) > 1e-3)) {
      s.homeLxz ??= [s.lx, s.lz];
      s.homeBaseLy ??= s.baseLy;
      s.lx += (s.knockbackVx ?? 0) * dt;
      s.lz += (s.knockbackVz ?? 0) * dt;
      const damp = Math.exp(-dt * 3.8);
      s.knockbackVx = (s.knockbackVx ?? 0) * damp;
      s.knockbackVz = (s.knockbackVz ?? 0) * damp;
      if ((s.knockbackVy ?? 0) > 1e-3) {
        const state = dmg?.fracture;
        const cosY0 = Math.cos(inst?.yaw ?? 0), sinY0 = Math.sin(inst?.yaw ?? 0);
        const wx0 = (inst?.x ?? 0) + s.lx * cosY0 + s.lz * sinY0;
        const wz0 = (inst?.z ?? 0) - s.lx * sinY0 + s.lz * cosY0;
        const hw = (inst?.width ?? 10) * 0.5 + 1.1, hl = (inst?.length ?? inst?.depth ?? 12) * 0.5 + 1.1;
        const offEdge = Math.abs(s.lx) > hw || Math.abs(s.lz) > hl;
        const slope = s.lx * (inst?.slopeX ?? 0) + s.lz * (inst?.slopeZ ?? 0);
        const footing = !offEdge && state?.fracture ? footingUnder(state, s.lx, s.ly, s.lz) : null;
        const floorTo = offEdge
          ? Math.max(0, inst?.baseY ?? inst?.y ?? 0) - slope
          : footing && footing.stood && !footing.stands
            ? Math.max(0, inst?.baseY ?? inst?.y ?? 0, restingHeightUnder(state, wx0, wz0, s.ly + 0.5)) - slope
            : footing?.floor !== null && footing?.floor !== undefined
              ? footing.floor - slope
              : (s.baseLy ?? 0);
        s.garrisonFall = { to: Math.min(s.baseLy ?? 0, floorTo), speed: -s.knockbackVy };
        s.knockbackVy = 0;
      } else {
        const hw = (inst?.width ?? 10) * 0.5 + 1.1, hl = (inst?.length ?? inst?.depth ?? 12) * 0.5 + 1.1;
        const baseGroundY = Math.max(0, inst?.baseY ?? inst?.y ?? 0);
        if ((Math.abs(s.lx) > hw || Math.abs(s.lz) > hl) && (s.baseLy ?? 0) > baseGroundY + 0.35) {
          const slope = s.lx * (inst?.slopeX ?? 0) + (s.lz ?? 0) * (inst?.slopeZ ?? 0);
          const groundTo = baseGroundY - slope;
          if (s.garrisonFall) s.garrisonFall.to = Math.min(s.garrisonFall.to, groundTo);
          else s.garrisonFall = { to: groundTo, speed: 0 };
        }
      }
      s._poseReady = false;
    }
    if (s.garrisonFall) {
      const fall = s.garrisonFall;
      fall.speed += 9.80665 * dt;
      s.baseLy = Math.max(fall.to, s.baseLy - fall.speed * dt);
      if (s.baseLy <= fall.to && fall.speed >= 0) s.garrisonFall = null;
      s._poseReady = false;
    }
    if ((s.knockdownTimer ?? 0) > 0) {
      s.knockdownTimer = Math.max(0, s.knockdownTimer - dt);
      s._poseReady = false;
    }
    let isDown = s.casualtyState === 'fallen' || (s.knockdownTimer ?? 0) > 0;
    // A body is posed afresh until it has come to rest, and then left as it lies.
    if (isDown && !s.ragdoll?.settled) {
      s._poseReady = false;
    }
    const underFire = (dmg?.fires?.length ?? 0) > 0 || (dmg?.state === 'burning');
    let moving = false;
    let working = false;

    if (!isDown && s.gunIndex !== null && inst?.gunnery?.guns?.[s.gunIndex]) {
      const gun = inst.gunnery.guns[s.gunIndex];
      if (gun.dismounted) {
        s.casualtyState = 'fallen';
        s.health = 0;
        s.woundSeverity = Math.max(s.woundSeverity ?? 0, 0.85);
        s._poseReady = false;
        isDown = true;
      } else {
        working = gun.loading || ['swab', 'load', 'ram', 'runout', 'prime', 'recoil'].includes(gun.stage);
      }
    }

    if (!isDown && !underFire && !working && s.routeZ && Math.abs(s.routeZ[1] - s.routeZ[0]) > 0.05) {
      if (s.wait > 0) {
        s.wait = Math.max(0, s.wait - dt);
      } else {
        const dz = s.targetZ - s.lz;
        const dist = Math.abs(dz);
        const speed = 0.78;
        const step = Math.min(dist, speed * dt);
        if (dist > 1e-4) {
          s.lz += Math.sign(dz) * step;
          s.localYaw = dz >= 0 ? 0 : Math.PI;
          moving = step > 0;
          crewAdvanceWalk(s, step);
          s._poseReady = false;
        }
        if (dist - step <= 1e-4) {
          s.targetZ = Math.abs(s.targetZ - s.routeZ[1]) < 1e-3 ? s.routeZ[0] : s.routeZ[1];
          s.wait = 2.4 + (s.crewIndex % 5) * 0.45;
          s._poseReady = false;
        }
      }
    }

    const desiredYaw = (s.localYaw ?? 0) + (inst?.yaw ?? 0);
    const yawDiff = Math.abs(Math.atan2(Math.sin(desiredYaw - s.yaw), Math.cos(desiredYaw - s.yaw)));

    if (!moving && !underFire && !working && s.walk < 1e-4 && s.brace < 1e-4 && s.work < 1e-4 && yawDiff < 1e-3 && s._poseReady) {
      s.walk = 0;
      s.brace = 0;
      s.work = 0;
      stepCrewPhysicsState(s, null, dt, garrison);
      continue;
    }

    if (!moving && s.walk > 0.02) {
      crewAdvanceWalk(s, s.walk * 0.45 * dt);
    }
    s.walk += (Number(moving) - s.walk) * blend;
    s.brace += (Number(underFire) - s.brace) * blend;
    s.work += (Number(working) - s.work) * blend;
    s.yaw = crewTurnTowards(s.yaw, desiredYaw, dt, 4.2);

    const cosY = Math.cos(inst?.yaw ?? 0);
    const sinY = Math.sin(inst?.yaw ?? 0);
    s.ly = (s.baseLy ?? s.ly) + s.lx * (inst?.slopeX ?? 0) + s.lz * (inst?.slopeZ ?? 0);
    const wx = (inst?.x ?? 0) + s.lx * cosY + s.lz * sinY;
    const wy = s.ly + 0.028;
    const wz = (inst?.z ?? 0) - s.lx * sinY + s.lz * cosY;
    s.x = wx;
    s.y = wy;
    s.z = wz;
    s.position.set([wx, wy, wz]);
    const half = s.yaw * 0.5;
    s.rotation.set([0, Math.sin(half), 0, Math.cos(half)]);
    gltfTRS(s.transform, [wx - ox, wy - oy, wz - oz], s.rotation, s.scale);
    stepCrewPhysicsState(s, null, dt, garrison);
    s._poseReady = !moving && s.walk < 1e-3 && yawDiff < 1e-3 && !(isDown && !s.ragdoll?.settled) && !s.garrisonFall;
  }
  return garrison;
}

const MAX_FORT_SOLDIERS_PER_BATCH = 96;
// Of a batch's slots, how many its captains may take from its soldiers.
const MAX_FORT_CAPTAINS_PER_BATCH = 8;

// From how far a garrison is drawn at all.
export const GARRISON_SIGHT_M = 1250;
// How far from its origin, the middle of the port, a garrison's people stand. A fort may guard the river mouth
// kilometres from the town.
export function garrisonReach(garrison) {
  let reach = 0;
  for (const s of garrison?.soldiers ?? []) reach = Math.max(reach, Math.hypot(s.position[0] - garrison.origin[0], s.position[2] - garrison.origin[2]));
  return reach;
}
// Whether a camera is near enough to any ground the garrison holds for it to be worth stepping and drawing.
export function garrisonWithinSight(garrison, camera, reach = garrisonReach(garrison)) {
  return Math.hypot(camera.x - garrison.origin[0], camera.z - garrison.origin[2]) <= reach + GARRISON_SIGHT_M;
}

export async function createFortSoldiers({
  device,
  frameUBO,
  transView,
  skyView,
  sampClamp,
  envCubeView,
  sunVisBuf,
  shadows,
  shader,
  format = 'rgba16float',
  samples = 4,
  shared = null,
  port = null,
  // How many bodies each of its batches has room for: a fort's many by default, or one for a lone figure.
  most = MAX_FORT_SOLDIERS_PER_BATCH,
}) {
  const modelsPromise = shared?.models
    ? Promise.resolve(shared.models)
    : (preloadedCrewModels ?? fetchCrewModels());
  modelsPromise.catch(() => {});
  const B = GPUBufferUsage;
  const buffer = (label, data, usage) => {
    const b = device.createBuffer({ label, size: data.byteLength, usage: usage | B.COPY_DST });
    device.queue.writeBuffer(b, 0, data);
    return b;
  };
  const layout = [{
    arrayStride: 60,
    attributes: [
      { shaderLocation: 0, offset: 0, format: 'float32x3' },
      { shaderLocation: 1, offset: 12, format: 'float32x3' },
      { shaderLocation: 2, offset: 24, format: 'float32x3' },
      { shaderLocation: 3, offset: 36, format: 'uint16x4' },
      { shaderLocation: 4, offset: 44, format: 'float32x4' },
    ],
  }];
  const [models, [module, shadowModule]] = await Promise.all([
    modelsPromise,
    shared ? Promise.resolve([null, null]) : Promise.all([shader(CREW_RENDER, 'fort crew'), shader(CREW_SHADOW, 'fort crew shadow')]),
  ]);
  const [pipeline, shadowPipeline, captainTexture] = await Promise.all([
    shared?.pipeline ?? device.createRenderPipelineAsync({
      label: 'fort crew',
      layout: 'auto',
      vertex: { module, entryPoint: 'vs', buffers: layout },
      fragment: { module, entryPoint: 'crewFS', targets: [{ format }] },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'greater' },
      multisample: { count: samples },
    }),
    shared?.shadowPipeline ?? device.createRenderPipelineAsync({
      label: 'fort crew shadow',
      layout: 'auto',
      vertex: { module: shadowModule, entryPoint: 'vs', buffers: layout },
      primitive: { topology: 'triangle-list', cullMode: 'none' },
      depthStencil: { format: 'depth32float', depthWriteEnabled: true, depthCompare: 'less', depthBias: 2, depthBiasSlopeScale: 1.5 },
    }),
    shared?.captainTexture ? Promise.resolve(shared.captainTexture) : uploadCaptainTexture(device, models[2]),
  ]);
  const captainTexView = shared?.captainTexView ?? captainTexture.createView();
  const captainSampler = shared?.captainSampler ?? device.createSampler({ label: 'captain pigment', magFilter: 'linear', minFilter: 'linear', mipmapFilter: 'linear', addressModeU: 'repeat', addressModeV: 'repeat', maxAnisotropy: 8 });
  const hullData = new Float32Array(52);
  hullData.set([1, 0, 0, 1], 0);
  hullData.set([0, 1, 0, 0], 4);
  hullData.set([0, 0, -1, 0], 0 + 8);
  hullData.set([3.6, 12, 1, 1], 12);
  const fortHullUBO = buffer('fort garrison hull ubo', hullData, B.UNIFORM);
  const dryMoistureBuf = buffer('fort garrison dry moisture', new Float32Array(16), B.STORAGE);
  const group = (pipe, resources) => device.createBindGroup({
    layout: pipe.getBindGroupLayout(0),
    entries: resources.map((resource, binding) => resource?.resource !== undefined ? resource : ({ binding, resource })),
  });
  const indigenousModels = createIndigenousCrewModels(models);
  const allModels = [models[0], models[1], indigenousModels[0], indigenousModels[1]];
  const clipPipeline = shared?.clipPipeline ?? await createCrewClipPipeline(device, shader);
  const solver = await createCrewSolver(device, shader);
  const fortGeometry = (model, given) => {
    if (given) return { ...given, model, owned: false };
    const vertex = buffer('fort crew vertices', model.vertices, B.VERTEX);
    const index = buffer('fort crew indices', model.indices, B.INDEX);
    const lods = (model.lods ?? [{ id: 'near', level: 0, indices: model.indices, indexCount: model.indices.length, triangles: model.indices.length / 3 }]).map((tier, t) => ({
      ...tier,
      buffer: t === 0 ? index : buffer('fort crew indices ' + tier.id, tier.indices, B.INDEX),
    }));
    return { vertex, index, lods, model, owned: true };
  };
  // A fort's captains are few. Each is one more body in the batch of his or her own sex, after its soldiers, drawn
  // from that batch's storage with the captain's mesh.
  const captainModel = models[2] ?? null;
  const captainGeometry = captainModel ? fortGeometry(captainModel, shared?.geometry?.[2]) : null;
  const batches = allModels.map((model, i) => {
    const isIndigenousBatch = i === 2 || i === 3;
    const geometry = fortGeometry(model, isIndigenousBatch ? shared?.indigenousGeometry?.[i - 2] : shared?.geometry?.[i]);
    const poses = new Float32Array(most * 65 * 16);
    const actors = new Float32Array(most * CREW_ACTOR_FLOATS);
    const bones = buffer('fort crew joints', poses, B.STORAGE);
    const clip = createCrewClipBatch(device, clipPipeline, model, bones, most, !isIndigenousBatch);
    const captainClip = captainModel && !isIndigenousBatch ? createCrewClipBatch(device, clipPipeline, captainModel, bones, most) : null;
    // A soldier near enough to see his hands is solved on the GPU, straight into the joints he is drawn from.
    const solve = createCrewSolveBatch(device, solver, model, bones, most);
    const captainSolve = captainClip ? createCrewSolveBatch(device, solver, captainModel, bones, most) : null;
    const actor = buffer('fort crew transforms', actors, B.STORAGE);
    const common = [{ buffer: fortHullUBO }, { buffer: bones }, { buffer: actor }];
    const mainResources = [{ buffer: frameUBO }, ...common, transView, sampClamp, envCubeView, { buffer: sunVisBuf }, { buffer: dryMoistureBuf }, skyView, { binding: 13, resource: captainTexView }, { binding: 14, resource: captainSampler }];
    const main = group(pipeline, mainResources);
    const shadow = group(shadowPipeline, [{ buffer: shadows.uniform }, ...common]);
    return { model, isIndigenousBatch, geometry, people: [], soldiers: 0, actors, bones, actor, main, shadow, clip, captainClip, solve, captainSolve };
  });
  const lighting = shadows.bind(pipeline);
  // One batch's bodies at the garrison's level of detail: its soldiers, then any captains after them.
  const drawFortRun = (pass, geometry, first, count) => {
    if (!count || !geometry) return;
    const lod = geometry.lods?.[activeTier] ?? { buffer: geometry.index, indexCount: geometry.model.indices.length };
    pass.setVertexBuffer(0, geometry.vertex);
    pass.setIndexBuffer(lod.buffer, 'uint32');
    pass.drawIndexed(lod.indexCount ?? lod.indices.length, count, 0, 0, first);
  };
  const drawFortBatch = (pass, b, group) => {
    if (!b.people.length) return;
    pass.setBindGroup(0, group);
    drawFortRun(pass, b.geometry, 0, b.soldiers);
    drawFortRun(pass, captainGeometry, b.soldiers, b.people.length - b.soldiers);
  };

  let activePort = null;
  let garrison = null;
  let reach = 0;
  let drawEnabled = false;
  let activeTier = 0;
  let sampleTick = 0;
  let posesDirty = true;

  function syncPort(nextPort) {
    activePort = nextPort;
    posesDirty = true;
    if (!nextPort?.instances?.length) {
      garrison = null;
      for (const b of batches) b.people = [];
      return;
    }
    garrison = nextPort.garrison ?? createFortGarrison(nextPort);
    reach = garrisonReach(garrison);
    hullData[16] = garrison.origin[0];
    hullData[17] = garrison.origin[1];
    hullData[18] = garrison.origin[2];
    device.queue.writeBuffer(fortHullUBO, 0, hullData);
    batches.forEach((b, index) => {
      const sex = index % 2 ? 'female' : 'male';
      const ofSex = garrison.soldiers.filter(s => Boolean(s.indigenous) === b.isIndigenousBatch && s.sex === sex);
      // Without the captain's mesh a captain is drawn as any other soldier.
      const captains = captainGeometry ? ofSex.filter(isCaptainActor) : [];
      const soldiers = ofSex.filter(s => !captains.includes(s)).slice(0, most - Math.min(captains.length, MAX_FORT_CAPTAINS_PER_BATCH, most));
      b.people = [...soldiers, ...captains.slice(0, Math.min(MAX_FORT_CAPTAINS_PER_BATCH, most))];
      b.soldiers = soldiers.length;
    });
    for (const b of batches) {
      for (let i = 0; i < b.people.length; i++) {
        const s = b.people[i], own = i < b.soldiers;
        s.walkClipDuration = (own ? b.model : captainModel).animator.clips.get('Walk').duration;
        const offset = i * CREW_ACTOR_FLOATS;
        b.actors.set(s.transform, offset);
        b.actors.set(s.shirt, offset + 16);
        b.actors.set(s.trousers, offset + 20);
        b.actors.set(s.skin, offset + 24);
        b.actors.set(s.hair, offset + 28);
        b.actors.set(s.face, offset + 32);
        b.actors[offset + 35] = packCrewFaceW(s.face[3], own ? (s.compMask ?? 0) : 0, Boolean(s.indigenous));
        b.actors[offset + 19] = Number(!s.visible);
        b.actors[offset + 23] = 1;
        b.actors[offset + 27] = crewBodyKind(s, own);
        // A fort's moisture lookup is always the first entry, so the whole of this slot's fraction is free.
        b.actors[offset + 31] = (s.dress ?? 0) / DRESS_MASK_SCALE;
      }
    }
  }
  if (port) syncPort(port);

  return {
    get state() { return garrison; },
    get lodLevel() { return activeTier; },
    setPort(nextPort) { syncPort(nextPort); },
    // `dateMs` is the game's date, by which a fallen soldier's day on the ground is counted.
    update(nextPort, dt, wind = 0, camera = null, stepSimulation = true, dateMs = null) {
      if (nextPort !== activePort || (nextPort && nextPort.garrison && nextPort.garrison !== garrison)) {
        syncPort(nextPort);
      }
      if (!garrison || !garrison.soldiers.length) {
        drawEnabled = false;
        return;
      }
      if (camera && Number.isFinite(camera.x) && Number.isFinite(camera.z) && !garrisonWithinSight(garrison, camera, reach)) {
        drawEnabled = false;
        return;
      }
      if (stepSimulation && dt > 0) stepFortGarrison(garrison, dt, wind, dateMs);
      let minDist = Infinity;
      let anyVisible = false;
      if (camera && Number.isFinite(camera.x) && Number.isFinite(camera.z)) {
        for (const s of garrison.soldiers) {
          if (!s.visible) continue;
          anyVisible = true;
          const d = Math.hypot(s.position[0] - camera.x, (s.position[1] ?? 0) - (camera.y ?? 0), s.position[2] - camera.z);
          if (d < minDist) minDist = d;
        }
      } else {
        minDist = 0;
        anyVisible = garrison.soldiers.some(s => s.visible);
      }
      const lod = selectCrewLOD({ x: 0, z: 0, heave: 0 }, { x: Math.min(minDist, 380), y: 0, z: 0 });
      activeTier = lod.mainTier;
      drawEnabled = minDist <= GARRISON_SIGHT_M && anyVisible;
      if (!drawEnabled) return;

      const stride = activeTier === 0 ? 1 : activeTier === 1 ? 2 : 4;
      const everyone = posesDirty, shouldSamplePoses = posesDirty || (sampleTick++ % stride) === 0;
      posesDirty = false;
      for (const b of batches) {
        if (!b.people.length) continue;
        b.clip.begin(b.people.length);
        b.captainClip?.begin(b.people.length);
        b.solve.begin();
        b.captainSolve?.begin();
        for (let i = 0; i < b.people.length; i++) {
          // A captain's slot follows the soldiers', and is solved on the captain's own rig.
          const s = b.people[i], own = i < b.soldiers;
          const a = (own ? b.model : captainModel).animator, clips = own ? b.clip : b.captainClip, solve = own ? b.solve : b.captainSolve;
          const offset = i * CREW_ACTOR_FLOATS;
          const woundAmt = s.casualtyState === 'fallen'
            ? 1.0
            : s.casualtyState === 'wounded'
              ? Math.max(0.45, Math.min(0.95, s.woundSeverity ?? (1 - (s.health ?? 0.5))))
              : 0;
          const scorchAmt = Math.max(0, Math.min(0.95, s.scorchAmount ?? (s.casualtyState === 'fallen' ? 0.35 : s.casualtyState === 'wounded' ? 0.18 : 0)));
          const bandageSeed = (s.casualtyState === 'wounded' || s.casualtyState === 'fallen')
            ? (0.06 + (((s.crewIndex ?? i) * 0.37) % 0.32))
            : 0;
          const shirt = s.casualtyState === 'fallen'
            ? [s.shirt[0] * 0.55 + 0.20, s.shirt[1] * 0.32, s.shirt[2] * 0.32]
            : s.casualtyState === 'wounded'
              ? [s.shirt[0] * 0.78 + 0.12, s.shirt[1] * 0.62, s.shirt[2] * 0.62]
              : s.shirt;
          b.actors.set(s.transform, offset);
          b.actors.set(shirt, offset + 16);
          b.actors[offset + 19] = !s.visible ? 1.0 : (woundAmt * 0.45);
          b.actors[offset + 23] = 1 + scorchAmt * 0.42;
          b.actors[offset + 27] = crewBodyKind(s, own) + bandageSeed;
          // Only someone close enough to see their hands needs a skeleton solved for them.
          const away = camera ? Math.hypot(s.position[0] - camera.x, (s.position[1] ?? 0) - (camera.y ?? 0), s.position[2] - camera.z) / crewLensZoom(camera) : 0;
          const stirred = !s._poseReady && s.poseWasReady !== false;
          s.poseWasReady = s._poseReady;
          if (crewClipOnly(away, s)) {
            clips.set(i, s.time, s.walkTime, s.walk);
            continue;
          }
          clips.off(i);
          if (fortPoseDue(s, shouldSamplePoses, everyone, stirred)) {
            // A shot that has just struck him is matched to a bone on a skeleton posed here, this once.
            if (s.pendingWounds?.length) resolveCrewWoundsOnSkeleton(a, s, null, false);
            if (!solve.add(i, s, null, dt, i, { work: false })) {
              a.sample('Idle', s.time, 'Walk', s.walkTime, s.walk);
              if (s.brace > 0.001) a.blend('Brace', s.time, s.brace);
              applyCrewRealism(a, s, null, dt);
              applyCrewWounds(a, s);
              device.queue.writeBuffer(b.bones, i * 65 * 64, a.palette);
            }
            crewPoseSolved(s);
          }
        }
        b.clip.upload();
        b.captainClip?.upload();
        b.solve.upload();
        b.captainSolve?.upload();
        device.queue.writeBuffer(b.actor, 0, b.actors, 0, b.people.length * CREW_ACTOR_FLOATS);
      }
    },
    encodePose(pass) {
      if (!drawEnabled) return;
      for (const b of batches) if (b.people.length) { b.solve.encode(pass); b.captainSolve?.encode(pass); b.clip.encode(pass); b.captainClip?.encode(pass); }
    },
    draw(pass) {
      if (!drawEnabled) return;
      pass.setPipeline(pipeline);
      pass.setBindGroup(1, lighting);
      for (const b of batches) drawFortBatch(pass, b, b.main);
    },
    drawShadow(pass) {
      if (!drawEnabled || activeTier >= 2) return;
      pass.setPipeline(shadowPipeline);
      for (const b of batches) drawFortBatch(pass, b, b.shadow);
    },
    destroy() {
      fortHullUBO.destroy();
      dryMoistureBuf.destroy();
      if (!shared?.captainTexture) captainTexture?.destroy?.();
      for (const geometry of [captainGeometry, ...batches.map(b => b.geometry)]) {
        if (!geometry?.owned) continue;
        for (const resource of [geometry.vertex, geometry.index, ...(geometry.lods?.slice(1).map(l => l.buffer) ?? [])]) resource?.destroy?.();
      }
      for (const b of batches) {
        b.bones.destroy();b.clip.destroy();b.captainClip?.destroy();b.solve.destroy();b.captainSolve?.destroy();
        b.actor.destroy();
      }
    },
  };
}

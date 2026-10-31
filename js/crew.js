import { loadCrewGLB, gltfTRS } from './gltf.js';
import { hullDeck, vesselDeck, HULL_VERTICAL_SCALE, HELM_TILLER_DISTANCE, modelDeck, modelHullDeck, modelDeckWidth, vesselVerticalScale } from './hull.js';
import { SAIL_KEYS, sailingState } from './sailing.js';
import { requestYardTransfer } from './lateen.js';
import { assignCrewWork, stepCrewWork, updateCrewGunneryAttendance, updateCrewRowingAttendance, hasExtendedCrewModel, crewSeatedPose, crewDeckHeight } from './crew-work.js';
import { poseCrewWork } from './crew-pose.js';
import { createGunneryTools } from './gunnery-tools.js';
import { CREW_RENDER, CREW_SHADOW } from './wgsl/crew.js';
import { NINA_DESIGN } from './models/nina.js';
import { VICTORY_DESIGN } from './models/victory.js';
import { requirePlayableShipModel, resolveShipNode } from './ship-models.js';
import {ADDITIONAL_DESIGNS,additionalStairFlights} from './models/additional.js';
import {ROWING_DESIGNS} from './models/rowing.js';
import {proceduralDesign} from './models/procedural.js';
import { crewDeckHazard, crewMotionPolicy, crewTurnTowards, crewAdvanceWalk } from './crew-motion.js';
import { crewNavigationStation, crewNavigationRoute, crewRoutineSegmentClear } from './crew-navigation.js';
import { selectCrewLOD, CREW_LOD_TIERS } from './crew-lod.js';

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
export function isPirateVessel(boat){
  if(!boat)return false;
  if(boat.isPirate===true)return true;
  if(boat.colors==='jolly-roger'||boat.colors==='blood-flag')return true;
  if(boat.battleColors==='jolly-roger'||boat.battleColors==='blood-flag')return true;
  if(boat.faction==='enemy'&&!boat.captured)return true;
  return false;
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
const crewAdditionalNames={female:['Inês','Beatriz','Catarina','Leonor','Maria','Isabel','Ama','Lin','Freydís','Lucía','Runa','Mei','Amina','Elena','Nia','Astrid','Clara','Sofia','Teresa','Margarida','Guiomar','Constança','Violante','Branca'],male:['Tomás','Duarte','João','Rui','Afonso','Pedro','Kofi','Li','Eirik','Mateo','Soren','Jin','Kwame','Diego','Tariq','Leif','Gonçalo','Fernão','Vasco','Diogo','Nuno','Álvaro','Cristóvão','Bartolomeu']};
function crewStationIdentity(key,index){
  const named=CREW_IDENTITIES.find(s=>s.id===key);if(named)return {...named,identityId:named.id};
  const sex=index%2?'male':'female',n=Math.floor(index/2),pool=CREW_IDENTITIES.filter(s=>s.sex===sex),identity=pool[n%pool.length];
  return {...identity,id:key,identityId:identity.id,name:crewAdditionalNames[sex][n%crewAdditionalNames[sex].length]};
}
export function createCompany(policy=deckhandDecision,modelId='nina',options={}) {
  const model=requirePlayableShipModel(modelId);
  // Twelve rendered workers are a representative watch on larger ships unless
  // fullWatch is enabled (default in WebGPU createCrew), which populates a
  // vessel's supplemental weather-deck stations (up to full 40-person crew on Santa María).
  const extended=hasExtendedCrewModel(model.id);
  const baseStations=extended?Object.entries(model.crewStations):CREW_ROSTER.map(identity=>[identity.id,model.crewStations[identity.id]]);
  const extraStations=(!extended&&options?.fullWatch&&model.supplementalCrewStations)
    ?Object.entries(model.supplementalCrewStations):[];
  const stations=[...baseStations,...extraStations];
  const activeControls=extended?['fore','main','mizzen'].map((name,index)=>model.rig.sails.some(s=>s.controlGroup===name)?index:-1).filter(i=>i>=0):[0,1,2];
  const stationBoat={modelId:model.id,model,length:model.runtime.length,beam:model.runtime.beam};
  const manifestCrew=model.id==='victory'?820:extended?proceduralDesign(model.id).loading.crew:(ADDITIONAL_DESIGNS[model.id]?.loading?.crew??12);
  const initialPirate=Boolean(options?.pirate||isPirateVessel(options?.boat));
  return {modelId:model.id,activeControls,representativeWatch:stations.length<manifestCrew,order:'watch',revision:0,pending:false,pirateAttire:initialPirate,crew:stations.map(([key,station],i)=>{
    const identity=(extended||i>=CREW_ROSTER.length)?crewStationIdentity(key,i):CREW_ROSTER[i],person={...identity,...station,stationKey:key};
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
      time:i*.43,walkTime:i*.27,patrolX:person.x,yaw:person.yaw??(i%2?Math.PI:0),decisionIn:i/24,company:true,strength:1.0});
    s.scale.fill((person.sex==='female'?.99:.96)*(1+(i%3-1)*.025));
    Object.assign(s.observation,{sailorId:s.id,role:s.role,captainOrder:'watch',orderRevision:0});
    const look=CREW_APPEARANCES[s.identityId??s.id];
    const pirate=initialPirate;
    s.shirt=pirate?PIRATE_SHIRTS[i%PIRATE_SHIRTS.length]:CREW_SHIRTS[i%6];
    s.skin=crewLinearColour(look.skin);
    s.trousers=pirate?PIRATE_TROUSERS[i%PIRATE_TROUSERS.length]:(i%3?[.095,.12,.15]:[.16,.10,.065]);
    s.attireTheme=pirate?'pirate-brown-black':'standard';
    s.hair=crewLinearColour(look.hair);s.face=[...look.face];return s;
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
  const shouldBePirate=isPirateVessel(boat);
  if(Boolean(company.pirateAttire)!==shouldBePirate)applyPirateCrewAttire(company,shouldBePirate);
  const order=CAPTAIN_ORDERS.find(o=>o.id===company.order),sails=sailingState(boat);
  // Manual sail settings supersede an outstanding broad order without stale reapplication.
  if(order.sails&&company.activeControls.some(i=>Math.abs(order.sails[i]-boat[SAIL_KEYS[i]])>.001)){
    company.order='watch';company.pending=false;company.revision++;
  } else company.pending=!!order.sails&&company.activeControls.some(i=>Math.abs(order.sails[i]-sails.set[i])>.01);
  dt=Math.max(0,Math.min(.1,Number.isFinite(dt)?dt:0));
  company.rigManeuver=sails.maneuver?.stage??null;
  company.workTime=(company.workTime??0)+dt;assignCrewWork(company,boat);
  for(const s of company.crew){
    if(s.casualtyState==='fallen'){
      s.job=null;s.observation.job=null;s.seatedPose=null;s.walk=0;s.brace=0;
      s.climbPitch=Math.PI*0.47;s.yaw=s.collapseYaw??s.yaw??0;
      stepDeckhand(s,boat,0,wind,company);
      continue;
    }
    const sailorDt=s.casualtyState==='wounded'?dt*0.55:dt;
    s.observation.wind=wind;s.observation.roll=boat.roll??0;s.observation.rollRate=boat.rollVelocity??0;s.observation.captainOrder=company.order;s.observation.orderRevision=company.revision;
    s.order=company.gunneryActive||company.pending||company.order==='weather'?'standby':'patrol';
    if(s.job){s.seatedPose=null;s.moisturePoints=null;s.navigationPath=null;s.navigationKey=null;s.navigationY=null;}
    const hadJob=!!s.job;
    if(!stepCrewWork(s,company,boat,sailorDt)){s.observation.job=null;stepDeckhand(s,boat,hadJob?0:sailorDt,wind,company);}
  }
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
function crewFinishPatrol(s){
  s.target=s.route?(s.target===s.route[1]?s.route[0]:s.route[1]):s.target>0?-2.2:.1;s.wait=2.5;s.navigationPath=null;
}
function crewPatrolMotion(s,boat,dt,company){
  if(s.intent!=='patrol'||s.visible===false||s.route&&s.route[0]===s.route[1])return false;
  if(s.wait>0){s.wait=Math.max(0,s.wait-dt);return false;}
  const sx=boat.beam/3.6,sz=boat.length/12,sy=vesselVerticalScale(boat),x=s.home?.[0]??s.patrolX??s.x;
  const key=[boat.modelId??'nina',boat.length,boat.beam,s.target,x].join('/');
  const from=[s.x,crewDeckHeight(boat,s.z,s.x),s.z];
  if(s.navigationKey!==key){
    // Relocate an unsafe destination, never an actor already on deck. Static
    // no-route results share the same cache key instead of rebuilding each frame.
    const to=crewNavigationStation([x,crewDeckHeight(boat,s.target,x),s.target],boat);
    s.navigationPath=to?crewNavigationRoute([from,to],boat):null;s.navigationKey=key;s.navigationCursor=0;
  }
  const path=s.navigationPath;if(!path?.length)return false;
  while(s.navigationCursor<path.length&&Math.hypot((path[s.navigationCursor][0]-from[0])*sx,(path[s.navigationCursor][1]-from[1])*sy,(path[s.navigationCursor][2]-from[2])*sz)<1e-7)s.navigationCursor++;
  const target=path[s.navigationCursor];
  if(!target){crewFinishPatrol(s);return false;}
  const dx=(target[0]-from[0])*sx,dy=(target[1]-from[1])*sy,dz=(target[2]-from[2])*sz,horizontal=Math.hypot(dx,dz),distance=Math.hypot(horizontal,dy);
  const motion=crewMotionPolicy(boat,{grade:horizontal>1e-8?dy/horizontal:0,hazard:s.observation.hazard});
  const desired=horizontal>1e-8?Math.atan2(dx,dz):s.yaw;s.yaw=crewTurnTowards(s.yaw,desired,dt,motion.turnRadiansPerSecond);
  const angle=Math.atan2(Math.sin(desired-s.yaw),Math.cos(desired-s.yaw));
  const travel=Math.min(distance,motion.speedMetresPerSecond*Math.max(0,Math.cos(angle))*dt),q=distance>1e-8?travel/distance:0;
  const next=from.map((v,i)=>v+(target[i]-v)*q);
  // Routine rounds remain on one weather deck. Its curved sheer is not the
  // endpoint chord; actual stair/ramp travel belongs to the job executor.
  next[1]=crewDeckHeight(boat,next[2],next[0]);
  if(!travel||!crewRoutineSegmentClear(s,boat,from,next))return false;
  if(company?.crew.some(other=>{
    if(other===s)return false;
    const y=(other.job?.position?.[1]??other.navigationY??crewDeckHeight(boat,other.z,other.x))*sy;
    if(Math.abs(next[1]*sy-y)>=1.7)return false;
    const gap=Math.hypot((next[0]-other.x)*sx,(next[2]-other.z)*sz),before=Math.hypot((from[0]-other.x)*sx,(from[2]-other.z)*sz);
    return gap<.60&&gap<before-1e-8;
  }))return false;
  const acceptedDistance=Math.hypot((next[0]-from[0])*sx,(next[1]-from[1])*sy,(next[2]-from[2])*sz);
  s.x=next[0];s.z=next[2];s.navigationY=next[1];crewAdvanceWalk(s,acceptedDistance,{strideMetres:motion.strideMetres});
  if(distance<=travel+1e-7&&++s.navigationCursor>=path.length)crewFinishPatrol(s);
  return true;
}
function stepProceduralDeckhand(s,boat,dt,wind,company){
  s.time+=dt;s.climbPitch=0;
  const o=s.observation;o.wind=wind;o.order=s.order;o.roll=boat.roll??0;o.rollRate=boat.rollVelocity??0;
  o.hazard=crewDeckHazard(boat,wind,s.intent==='brace');s.decisionIn-=dt;
  if(o.hazard||s.decisionIn<=0){let intent;try{intent=s.policy(o);}catch{intent=deckhandDecision(o);}s.intent=o.hazard?'brace':['patrol','standby','brace'].includes(intent)?intent:deckhandDecision(o);s.decisionIn=.5;}
  s.brace+=(Number(o.hazard)-s.brace)*(1-Math.exp(-dt*8));
  const seated=crewSeatedPose(s,boat);s.seatedPose=seated;
  if(seated){
    s.yaw=seated.body.yaw;s.walk=0;
    s.position.set([s.x*boat.beam/3.6,crewDeckHeight(boat,s.z,s.x)*vesselVerticalScale(boat)+.028,s.z*boat.length/12]);
    const seat=seated.seat,feet=seated.feet;s.moisturePoints=[feet[0].map((v,i)=>(v+feet[1][i])*.5),seat.map((v,i)=>v+(i===1?.10:0)),seat.map((v,i)=>v+(i===1?.50:0)),seat.map((v,i)=>v+(i===1?.95:0))];
  }else{
    const moving=crewPatrolMotion(s,boat,dt,company);
    s.walk+=(Number(moving)-s.walk)*(1-Math.exp(-dt*8));s.moisturePoints=null;
    s.position.set([s.x*boat.beam/3.6,(s.navigationY??crewDeckHeight(boat,s.z,s.x))*vesselVerticalScale(boat)+.028,s.z*boat.length/12]);
    if(s.roles?.includes('helmsman')){const grip=resolveShipNode(boat,'helm.grip');s.yaw=Math.atan2(grip[0]-s.position[0],grip[2]-s.position[2]);}
  }
  const half=s.yaw/2;s.rotation.set([0,Math.sin(half),0,Math.cos(half)]);gltfTRS(s.transform,s.position,s.rotation,s.scale);return s;
}
export function stepDeckhand(s,boat,dt,wind=0,company=null) {
  dt=Math.max(0,Math.min(.1,Number.isFinite(dt)?dt:0));
  if(hasExtendedCrewModel(boat.modelId))return stepProceduralDeckhand(s,boat,dt,wind,company);
  s.time+=dt;s.climbPitch=0;
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
  s.visible=boat.beam>=(s.company?3.2:2.8)&&boat.length>=(s.company?10.5:8);
  const moving=crewPatrolMotion(s,boat,dt,company),lengthScale=boat.length/12;
  const blend=1-Math.exp(-dt*8);s.walk+=(Number(moving)-s.walk)*blend;s.brace+=(Number(s.intent==='brace')-s.brace)*blend;
  if((boat.modelId==='victory'||ADDITIONAL_DESIGNS[boat.modelId])&&s.role!=='Helmsman'){
    const width=Math.max(0,modelDeckWidth(boat,s.z)-.34/(boat.beam/3.6));s.x=Math.max(-width,Math.min(width,s.x));
  }
  if(s.role==='Helmsman'&&boat.modelId==='victory'){
    const station=boat.model?.crewStations?.[s.id]??requirePlayableShipModel('victory').crewStations[s.id];
    s.x=station.x;s.z=station.z;s.yaw=station.yaw??Math.PI;s.climbPitch=.28;
    s.position.set([s.x*boat.beam/3.6,modelDeck(boat,s.z)*vesselVerticalScale(boat)+.028,s.z*lengthScale]);
  }else if(s.role==='Helmsman'&&ADDITIONAL_DESIGNS[boat.modelId]){
    const design=ADDITIONAL_DESIGNS[boat.modelId],grip=resolveShipNode(boat,'helm.grip'),spacing=.40;
    // Stand inboard of the real handle. The boat's own weather deck sets feet;
    // neither the Niña's 2.3-high quarterdeck nor its tiller distance is reused.
    s.x=grip[0]/(boat.beam/3.6);s.z=(grip[2]-spacing)/lengthScale;s.yaw=0;s.climbPitch=.08;
    const station=design.crewStations[s.id];
    if(Math.abs(modelDeck(boat,s.z)-modelDeck(boat,station.z))>.15){s.x=station.x;s.z=station.z;s.yaw=station.yaw??0;}
    s.position.set([s.x*boat.beam/3.6,modelDeck(boat,s.z)*vesselVerticalScale(boat)+.028,s.z*lengthScale]);
  }else if(s.role==='Helmsman'){
    const grip=resolveShipNode(boat,'helm.grip');s.x=grip[0]/(boat.beam/3.6);s.z=(grip[2]-HELM_TILLER_DISTANCE)/lengthScale;s.yaw=0;
    s.position.set([grip[0],hullDeck(s.z)*HULL_VERTICAL_SCALE+.028,grip[2]-HELM_TILLER_DISTANCE]);
  }else s.position.set([s.x*boat.beam/3.6,(s.navigationY??(s.company?modelDeck(boat,s.z):modelHullDeck(boat,s.z)))*vesselVerticalScale(boat)+.028,s.z*lengthScale]);
  const sy=Math.sin(s.yaw/2),cy=Math.cos(s.yaw/2),sx=Math.sin((s.climbPitch??0)/2),cx=Math.cos((s.climbPitch??0)/2);
  s.rotation.set([cy*sx,sy*cx,-sy*sx,cy*cx]);gltfTRS(s.transform,s.position,s.rotation,s.scale);
  return s;
}

let preloadedCrewModels=null;
export function preloadCrewModels(){
  if(!preloadedCrewModels&&typeof fetch==='function'){
    preloadedCrewModels=Promise.all(['assets/crew/sailor.glb','assets/crew/sailor-female.glb'].map(async path=>{
      const response=await fetch(path);if(!response.ok)throw Error('Crew asset unavailable');return loadCrewGLB(await response.arrayBuffer());
    })).catch(err=>{preloadedCrewModels=null;throw err;});
  }
  return preloadedCrewModels;
}

export async function createCrew({device,frameUBO,hullUBO,transView,skyView,sampClamp,envCubeView,sunVisBuf,shadows,wetness,shader,format='rgba16float',samples=4,shared=null,modelId='nina',waterOptics=null}) {
  const modelsPromise=shared?.models?Promise.resolve(shared.models):(preloadedCrewModels??Promise.all(['assets/crew/sailor.glb','assets/crew/sailor-female.glb'].map(async path=>{
    const response=await fetch(path);if(!response.ok)throw Error('Crew asset unavailable');return loadCrewGLB(await response.arrayBuffer());
  })));
  modelsPromise.catch(()=>{});
  const B=GPUBufferUsage,state=createCompany(undefined,modelId,{fullWatch:true});
  const buffer=(label,data,usage)=>{const b=device.createBuffer({label,size:data.byteLength,usage:usage|B.COPY_DST});device.queue.writeBuffer(b,0,data);return b;};
  const layout=[{arrayStride:60,attributes:[
    {shaderLocation:0,offset:0,format:'float32x3'},{shaderLocation:1,offset:12,format:'float32x3'},
    {shaderLocation:2,offset:24,format:'float32x3'},{shaderLocation:3,offset:36,format:'uint16x4'},
    {shaderLocation:4,offset:44,format:'float32x4'},
  ]}];
  const [models,[module,shadowModule]]=await Promise.all([
    modelsPromise,
    shared?Promise.resolve([null,null]):Promise.all([shader(CREW_RENDER,'crew'),shader(CREW_SHADOW,'crew shadow')]),
  ]);
  if(models.some(m=>m.animator.joints.length!==65))throw Error('Crew expects the prepared 65-joint rigs');
  const [pipeline,shadowPipeline]=await Promise.all([shared?.pipeline??device.createRenderPipelineAsync({label:'crew',layout:'auto',vertex:{module,entryPoint:'vs',buffers:layout},
    fragment:{module,entryPoint:'fs',targets:[{format}]},primitive:{topology:'triangle-list',cullMode:'none'},
    depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'greater'},multisample:{count:samples}}),
    shared?.shadowPipeline??device.createRenderPipelineAsync({label:'crew shadow',layout:'auto',vertex:{module:shadowModule,entryPoint:'vs',buffers:layout},primitive:{topology:'triangle-list',cullMode:'none'},
    depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'less',depthBias:2,depthBiasSlopeScale:1.5}})]);
  const group=(pipe,resources)=>device.createBindGroup({layout:pipe.getBindGroupLayout(0),entries:resources.map((resource,binding)=>({binding,resource}))});
  const batches=models.map((model,i)=>{
    const people=state.crew.filter(s=>s.sex===(i?'female':'male'));
    for(const s of people)s.walkClipDuration=model.animator.clips.get('Walk').duration;
    // A one-person company legitimately has no actors in one sex batch.
    // Bind valid storage buffers, but submit no phantom instance for that batch.
    const poses=new Float32Array(Math.max(1,people.length)*65*16),actors=new Float32Array(Math.max(1,people.length)*CREW_ACTOR_FLOATS);
    const vertex=shared?.geometry[i].vertex??buffer('crew vertices',model.vertices,B.VERTEX),index=shared?.geometry[i].index??buffer('crew indices',model.indices,B.INDEX);
    const lods=shared?.geometry[i].lods??(model.lods??[{id:'near',level:0,indices:model.indices,indexCount:model.indices.length,triangles:model.indices.length/3}]).map((tier,t)=>({...tier,buffer:t===0?index:buffer('crew indices '+tier.id,tier.indices,B.INDEX)}));
    const bones=buffer('crew joints',poses,B.STORAGE),actor=buffer('crew transforms',actors,B.STORAGE);
    const common=[{buffer:hullUBO},{buffer:bones},{buffer:actor}];
    const mainResources=[{buffer:frameUBO},...common,transView,sampClamp,envCubeView,{buffer:sunVisBuf},{buffer:wetness.state},skyView];
    const main=group(pipeline,mainResources);
    const shadow=group(shadowPipeline,[{buffer:shadows.uniform},...common]);
    return {model,people,poses,actors,vertex,index,lods,bones,actor,main,shadow,mainResources};
  });
  const lighting=shadows.bind(pipeline);
  const submerged=waterOptics?await waterOptics.capture({source:CREW_RENDER,pipeline,vertex:{buffers:layout},groups:2}):null;
  const submergedLighting=submerged?shadows.bind(submerged.pipeline):null;
  if(submerged)for(const b of batches)b.submerged=submerged.bindGroup(b.mainResources);
  const gunTools=await createGunneryTools({device,frameUBO,transView,skyView,sampClamp,envCubeView,sunVisBuf,shadows,shader,format,samples,waterOptics,shared:shared?.gunTools});
  let enabled=true,drawEnabled=false,activeTier=0,shadowTier=1;
  const drawBatch=(pass,b,shadow)=>{if(!b.people.length)return;const lod=b.lods?.[shadow?shadowTier:activeTier]??{buffer:b.index,indexCount:b.model.indices.length};pass.setBindGroup(0,shadow?b.shadow:b.main);pass.setVertexBuffer(0,b.vertex);pass.setIndexBuffer(lod.buffer,'uint32');pass.drawIndexed(lod.indexCount??lod.indices.length,b.people.length);};
  return {state,assets:{models,pipeline,shadowPipeline,gunTools:gunTools.assets,geometry:batches.map(({vertex,index,lods})=>({vertex,index,lods}))},triangles:batches.reduce((n,b)=>n+b.model.indices.length/3*b.people.length,0),lods:CREW_LOD_TIERS,
    get lodLevel(){return activeTier;},
    get activeTriangles(){return batches.reduce((n,b)=>n+((b.lods?.[activeTier]?.triangles)??(b.model.indices.length/3))*b.people.length,0);},
    joints:65,
    order(boat,id){return issueCaptainOrder(state,boat,id);},
    update(boat,dt,wind,camera=null){
      const lod=selectCrewLOD(boat,camera);activeTier=lod.mainTier;shadowTier=lod.shadowTier;
      stepCompany(state,boat,dt,wind);enabled=boat.crew!==false;drawEnabled=enabled&&boat.showProw&&!lod.culled&&state.crew.some(s=>s.visible);
      gunTools.update(state,boat,drawEnabled);
      if(!drawEnabled){
        // Hidden rendering does not turn a seated body's moisture samples back
        // into standing-height probes or change its physical rowing attendance.
        if(Object.hasOwn(ROWING_DESIGNS,modelId))for(const b of batches)for(const s of b.people)if(s.seatedPose){const a=b.model.animator;a.sample('Idle',s.time);poseCrewWork(a,s,boat);}
        return;
      }
      for(const b of batches){
        const a=b.model.animator;
        for(let i=0;i<b.people.length;i++){
          const s=b.people[i];a.sample('Idle',s.time,'Walk',s.walkTime,s.walk);
          if(s.brace>.001 && !(s.job?.rung>0))a.blend('Brace',s.time,s.brace);
          poseCrewWork(a,s,boat);
          const offset=i*CREW_ACTOR_FLOATS;
          b.poses.set(a.palette,i*65*16);b.actors.set(s.transform,offset);
          const shirt=s.casualtyState==='fallen'
            ?[s.shirt[0]*0.55+0.20,s.shirt[1]*0.32,s.shirt[2]*0.32]
            :s.casualtyState==='wounded'
              ?[s.shirt[0]*0.78+0.12,s.shirt[1]*0.62,s.shirt[2]*0.62]
              :s.shirt;
          b.actors.set(shirt,offset+16);b.actors.set(s.trousers,offset+20);b.actors.set(s.skin,offset+24);b.actors.set(s.hair,offset+28);
          b.actors.set(s.face,offset+32);b.actors[offset+27]=Number(s.sex==='female');
          // The tiller station is below the camera; all crew remain visible.
          b.actors[offset+19]=Number(!s.visible);
          b.actors[offset+23]=Number(boat.enabled===true);
          b.actors[offset+31]=wetness.crewOffset+(s.crewIndex??state.crew.indexOf(s))*4;
        }
        device.queue.writeBuffer(b.bones,0,b.poses);device.queue.writeBuffer(b.actor,0,b.actors);
      }
    },
    drawSubmerged(pass,above=false){
      if(!submerged||!drawEnabled)return;
      submerged.bind(pass,above);pass.setBindGroup(1,submergedLighting);
      for(const b of batches){if(!b.people.length)continue;const lod=b.lods?.[activeTier]??{buffer:b.index,indexCount:b.model.indices.length};pass.setBindGroup(0,b.submerged);pass.setVertexBuffer(0,b.vertex);pass.setIndexBuffer(lod.buffer,'uint32');pass.drawIndexed(lod.indexCount??lod.indices.length,b.people.length);}
      gunTools.drawSubmerged(pass,above);
    },
    draw(pass){if(!drawEnabled)return;pass.setPipeline(pipeline);pass.setBindGroup(1,lighting);for(const b of batches)drawBatch(pass,b,false);gunTools.draw(pass);},
    drawShadow(pass){if(!drawEnabled)return;pass.setPipeline(shadowPipeline);for(const b of batches)drawBatch(pass,b,true);gunTools.drawShadow(pass);},
    status(){return state.crew.length&&!state.crew.some(s=>s.visible)?hasExtendedCrewModel(modelId)?'Crew hidden':'Crew needs a larger deck':companyStatus(state);},
    destroy(){gunTools.destroy();for(const b of batches)for(const resource of [...(shared?[]:[b.vertex,b.index,...(b.lods?.slice(1).map(l=>l.buffer)??[])]),b.bones,b.actor])resource.destroy();},
  };
}

export const FORTIFICATION_PREFAB_IDS = Object.freeze([
  'stone_sea_bastion',
  'bastion_trace_fortress',
  'torreon_atalaya_farol',
  'curtain_wall_and_gate',
]);

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

  if (inst.prefabId === 'stone_sea_bastion') {
    const yDeck = yTop - 0.85;
    const zSea = -hl + wallT + 1.25;
    const zLand = hl - wallT - 1.25;
    for (const [gIdx, k] of [-1, 0, 1].entries()) {
      const lx = k * (hw * 0.48);
      specs.push({ lx, ly: yDeck, lz: zSea, routeZ: [zSea, zSea], localYaw: Math.PI, role: 'Artillero', stationKind: 'embrasure', gunIndex: gIdx });
    }
    for (const [gIdx, k] of [-0.5, 0.5].entries()) {
      const lx = k * (hw * 0.50);
      specs.push({ lx, ly: yDeck, lz: zLand, routeZ: [zLand, zLand], localYaw: 0, role: 'Artillero', stationKind: 'embrasure', gunIndex: 3 + gIdx });
    }
    const zSpan0 = Math.max(-hl + 3.2, -hl * 0.78);
    const zSpan1 = Math.min(-1.0, -hl * 0.18);
    const zSpan2 = Math.max(1.0, hl * 0.18);
    const zSpan3 = Math.min(hl - 3.2, hl * 0.78);
    for (const sideX of [-1, 1]) {
      const lx = sideX * Math.max(2.2, hw - wallT - 0.85);
      specs.push({ lx, ly: yDeck, lz: (zSpan0 + zSpan1) * 0.5, routeZ: [zSpan0, zSpan1], localYaw: sideX < 0 ? -Math.PI / 2 : Math.PI / 2, role: 'Centinela de Muralla', stationKind: 'rampart' });
      specs.push({ lx, ly: yDeck, lz: (zSpan2 + zSpan3) * 0.5, routeZ: [zSpan2, zSpan3], localYaw: sideX < 0 ? -Math.PI / 2 : Math.PI / 2, role: 'Alabardero', stationKind: 'rampart' });
    }
    const kw = Math.min(6.4, hw * 0.46);
    specs.push({ lx: -kw - 1.15, ly: yDeck, lz: 0, routeZ: [-1.2, 1.2], localYaw: -Math.PI / 2, role: 'Capitán de Presidio', stationKind: 'citadel' });
  } else if (inst.prefabId === 'bastion_trace_fortress') {
    const yDeck = yTop - 0.85;
    const bOut = 4.2;
    const zSea = -hl + wallT + 1.25;
    const zLand = hl - wallT - 1.25;
    for (const [gIdx, k] of [-1.5, -0.5, 0.5, 1.5].entries()) {
      const lx = k * (hw * 0.34);
      specs.push({ lx, ly: yDeck, lz: zSea, routeZ: [zSea, zSea], localYaw: Math.PI, role: 'Artillero', stationKind: 'embrasure', gunIndex: gIdx });
    }
    for (const [gIdx, k] of [-0.5, 0.5].entries()) {
      const lx = k * (hw * 0.34);
      specs.push({ lx, ly: yDeck, lz: zLand, routeZ: [zLand, zLand], localYaw: 0, role: 'Artillero', stationKind: 'embrasure', gunIndex: 4 + gIdx });
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
    const yRavelin = yTop - 1.3;
    const zRavelin = -hl - bOut - 4.5;
    for (const sx of [-1, 1]) {
      specs.push({ lx: sx * 2.4, ly: yRavelin, lz: zRavelin, routeZ: [zRavelin - 1.1, zRavelin + 1.1], localYaw: Math.PI, role: 'Guardia de Revellín', stationKind: 'ravelin' });
    }
    // 2 Parade / magazine sentries between the flank barracks
    for (const sx of [-1, 1]) {
      specs.push({ lx: sx * 2.2, ly: yDeck, lz: -3.2, routeZ: [-6.0, -0.8], localYaw: Math.PI, role: 'Alabardero', stationKind: 'parade' });
    }
  } else if (inst.prefabId === 'torreon_atalaya_farol') {
    const rBase = Math.min(hw, hl);
    const yPlinth = yGround + 0.85;
    if (inst.materialKind === 10) {
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
  } else if (inst.prefabId === 'curtain_wall_and_gate') {
    const wallHW = Math.min(3.4, hw);
    const yWalk = yTop - 0.90;
    const yGateTop = yTop + 2.8;
    const gHW = wallHW + 1.15;
    const zWingMax = Math.max(6.2, hl - 2.0);
    const zWingMin = Math.min(zWingMax - 1.2, 4.8);
    for (const sideZ of [-1, 1]) {
      const z0 = sideZ < 0 ? -zWingMax : zWingMin;
      const z1 = sideZ < 0 ? -zWingMin : zWingMax;
      const zMid = (z0 + z1) * 0.5;
      specs.push({ lx: -wallHW + 1.25, ly: yWalk, lz: zMid - 0.8, routeZ: [z0, zMid], localYaw: -Math.PI / 2, role: 'Centinela de Muralla', stationKind: 'adarve' });
      specs.push({ lx: wallHW - 1.25, ly: yWalk, lz: zMid + 0.8, routeZ: [zMid, z1], localYaw: Math.PI / 2, role: 'Arcabucero', stationKind: 'adarve' });
    }
    for (const sz of [-1, 1]) {
      specs.push({ lx: -wallHW * 0.45, ly: yGateTop, lz: sz * 1.4, routeZ: [sz * 1.4, sz * 1.4], localYaw: -Math.PI / 2, role: 'Vigía de Puerta', stationKind: 'gate-roof' });
      specs.push({ lx: -gHW - 0.35, ly: yGround + 0.65, lz: sz * 2.2, routeZ: [sz * 2.2, sz * 2.2], localYaw: -Math.PI / 2, role: 'Guardia de Puerta', stationKind: 'gate-portal' });
    }
  }

  return specs.map((spec, idx) => {
    const globalIdx = startIndex + idx;
    const identity = crewStationIdentity(`fort_${inst.id ?? inst.prefabId}_${idx}`, globalIdx);
    const look = CREW_APPEARANCES[identity.identityId ?? identity.id];
    const s = createDeckhand();
    const wx = (inst.x ?? 0) + spec.lx * cosY + spec.lz * sinY;
    const wy = spec.ly + 0.028;
    const wz = (inst.z ?? 0) - spec.lx * sinY + spec.lz * cosY;
    const worldYaw = (spec.localYaw ?? 0) - (inst.yaw ?? 0);
    Object.assign(s, {
      id: `${inst.id ?? inst.prefabId}_soldier_${idx + 1}`,
      name: identity.name,
      sex: identity.sex,
      identityId: identity.identityId,
      role: spec.role,
      stationKind: spec.stationKind,
      gunIndex: spec.gunIndex ?? null,
      buildingId: inst.id ?? inst.prefabId,
      buildingPrefabId: inst.prefabId,
      building: inst,
      lx: spec.lx,
      ly: spec.ly,
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
      shirt: GARRISON_SHIRTS[globalIdx % GARRISON_SHIRTS.length],
      trousers: GARRISON_TROUSERS[globalIdx % GARRISON_TROUSERS.length],
      skin: crewLinearColour(look.skin),
      hair: crewLinearColour(look.hair),
      face: [...look.face],
    });
    s.scale.fill((s.sex === 'female' ? 0.99 : 0.97) * (1 + ((globalIdx % 3) - 1) * 0.02));
    s.position.set([wx, wy, wz]);
    const half = s.yaw * 0.5;
    s.rotation.set([0, Math.sin(half), 0, Math.cos(half)]);
    gltfTRS(s.transform, s.position, s.rotation, s.scale);
    return s;
  });
}

export function createFortGarrison(port) {
  const instances = port?.instances ?? [];
  const origin = [port?.center?.x ?? 0, 0, port?.center?.z ?? 0];
  const soldiers = [];
  const byBuilding = new Map();
  for (const inst of instances) {
    if (!FORTIFICATION_PREFAB_IDS.includes(inst.prefabId)) continue;
    const unit = createFortificationSoldiersForInstance(inst, soldiers.length);
    for (const s of unit) {
      const relPos = [s.position[0] - origin[0], s.position[1] - origin[1], s.position[2] - origin[2]];
      gltfTRS(s.transform, relPos, s.rotation, s.scale);
      s._poseReady = true;
      soldiers.push(s);
    }
    inst.garrisonSoldiers = unit;
    byBuilding.set(inst.id ?? inst.prefabId, unit);
  }
  const garrison = { port, origin, soldiers, byBuilding, time: 0 };
  if (port && typeof port === 'object') port.garrison = garrison;
  return garrison;
}

export function stepFortGarrison(garrison, dt = 0, wind = 0) {
  if (!garrison?.soldiers?.length) return garrison;
  dt = Math.max(0, Math.min(0.1, Number.isFinite(dt) ? dt : 0));
  garrison.time = (garrison.time ?? 0) + dt;
  const ox = garrison.origin[0], oy = garrison.origin[1], oz = garrison.origin[2];
  const blend = 1 - Math.exp(-dt * 8);
  for (const s of garrison.soldiers) {
    s.time += dt;
    const inst = s.building;
    const dmg = inst?.damageState;
    const ruined = dmg?.state === 'ruined';
    s.visible = !ruined;
    if (ruined) {
      s.walk = 0;
      s.brace = 0;
      s.work = 0;
      continue;
    }
    const underFire = (dmg?.fires?.length ?? 0) > 0 || (dmg?.state === 'burning');
    let moving = false;
    let working = false;

    if (s.gunIndex !== null && inst?.gunnery?.guns?.[s.gunIndex]) {
      const gun = inst.gunnery.guns[s.gunIndex];
      if (gun.dismounted) {
        s.visible = false;
        continue;
      }
      working = gun.loading || ['swab', 'load', 'ram', 'runout', 'prime', 'recoil'].includes(gun.stage);
    }

    if (!underFire && !working && s.routeZ && Math.abs(s.routeZ[1] - s.routeZ[0]) > 0.05) {
      if (s.wait > 0) {
        s.wait = Math.max(0, s.wait - dt);
      } else {
        const dz = s.targetZ - s.lz;
        const dist = Math.abs(dz);
        const speed = 1.15;
        const step = Math.min(dist, speed * dt);
        if (dist > 1e-4) {
          s.lz += Math.sign(dz) * step;
          s.localYaw = dz >= 0 ? 0 : Math.PI;
          moving = step > 0;
          crewAdvanceWalk(s, step, { strideMetres: 0.68 });
          s._poseReady = false;
        }
        if (dist - step <= 1e-4) {
          s.targetZ = Math.abs(s.targetZ - s.routeZ[1]) < 1e-3 ? s.routeZ[0] : s.routeZ[1];
          s.wait = 2.2 + (s.crewIndex % 5) * 0.45;
          s.localYaw = s.lx < 0 ? -Math.PI / 2 : Math.PI / 2;
          s._poseReady = false;
        }
      }
    }

    if (!moving && !underFire && !working && s.walk < 1e-4 && s.brace < 1e-4 && s.work < 1e-4 && s._poseReady) {
      s.walk = 0;
      s.brace = 0;
      s.work = 0;
      continue;
    }

    s.walk += (Number(moving) - s.walk) * blend;
    s.brace += (Number(underFire) - s.brace) * blend;
    s.work += (Number(working) - s.work) * blend;
    s.yaw = (s.localYaw ?? 0) - (inst?.yaw ?? 0);

    const cosY = Math.cos(inst?.yaw ?? 0);
    const sinY = Math.sin(inst?.yaw ?? 0);
    const wx = (inst?.x ?? 0) + s.lx * cosY + s.lz * sinY;
    const wy = s.ly + 0.028;
    const wz = (inst?.z ?? 0) - s.lx * sinY + s.lz * cosY;
    s.position.set([wx, wy, wz]);
    const half = s.yaw * 0.5;
    s.rotation.set([0, Math.sin(half), 0, Math.cos(half)]);
    gltfTRS(s.transform, [wx - ox, wy - oy, wz - oz], s.rotation, s.scale);
    s._poseReady = !moving;
  }
  return garrison;
}

const MAX_FORT_SOLDIERS_PER_BATCH = 64;

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
}) {
  const modelsPromise = shared?.models
    ? Promise.resolve(shared.models)
    : (preloadedCrewModels ?? Promise.all(['assets/crew/sailor.glb', 'assets/crew/sailor-female.glb'].map(async path => {
        const response = await fetch(path);
        if (!response.ok) throw Error('Crew asset unavailable');
        return loadCrewGLB(await response.arrayBuffer());
      })));
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
  const [pipeline, shadowPipeline] = await Promise.all([
    shared?.pipeline ?? device.createRenderPipelineAsync({
      label: 'fort crew',
      layout: 'auto',
      vertex: { module, entryPoint: 'vs', buffers: layout },
      fragment: { module, entryPoint: 'fs', targets: [{ format }] },
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
  ]);
  const hullData = new Float32Array(52);
  hullData.set([1, 0, 0, 1], 0);
  hullData.set([0, 1, 0, 0], 4);
  hullData.set([0, 0, -1, 0], 8);
  hullData.set([3.6, 12, 1, 1], 12);
  const fortHullUBO = buffer('fort garrison hull ubo', hullData, B.UNIFORM);
  const dryMoistureBuf = buffer('fort garrison dry moisture', new Float32Array(16), B.STORAGE);
  const group = (pipe, resources) => device.createBindGroup({
    layout: pipe.getBindGroupLayout(0),
    entries: resources.map((resource, binding) => ({ binding, resource })),
  });
  const batches = models.map((model, i) => {
    const poses = new Float32Array(MAX_FORT_SOLDIERS_PER_BATCH * 65 * 16);
    const actors = new Float32Array(MAX_FORT_SOLDIERS_PER_BATCH * CREW_ACTOR_FLOATS);
    const vertex = shared?.geometry[i].vertex ?? buffer('fort crew vertices', model.vertices, B.VERTEX);
    const index = shared?.geometry[i].index ?? buffer('fort crew indices', model.indices, B.INDEX);
    const lods = shared?.geometry[i].lods ?? (model.lods ?? [{ id: 'near', level: 0, indices: model.indices, indexCount: model.indices.length, triangles: model.indices.length / 3 }]).map((tier, t) => ({
      ...tier,
      buffer: t === 0 ? index : buffer('fort crew indices ' + tier.id, tier.indices, B.INDEX),
    }));
    const bones = buffer('fort crew joints', poses, B.STORAGE);
    const actor = buffer('fort crew transforms', actors, B.STORAGE);
    const common = [{ buffer: fortHullUBO }, { buffer: bones }, { buffer: actor }];
    const mainResources = [{ buffer: frameUBO }, ...common, transView, sampClamp, envCubeView, { buffer: sunVisBuf }, { buffer: dryMoistureBuf }, skyView];
    const main = group(pipeline, mainResources);
    return { model, people: [], poses, actors, vertex, index, lods, bones, actor, main };
  });
  const lighting = shadows.bind(pipeline);

  let activePort = null;
  let garrison = null;
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
    hullData[16] = garrison.origin[0];
    hullData[17] = garrison.origin[1];
    hullData[18] = garrison.origin[2];
    device.queue.writeBuffer(fortHullUBO, 0, hullData);
    batches[0].people = garrison.soldiers.filter(s => s.sex === 'male').slice(0, MAX_FORT_SOLDIERS_PER_BATCH);
    batches[1].people = garrison.soldiers.filter(s => s.sex === 'female').slice(0, MAX_FORT_SOLDIERS_PER_BATCH);
    for (const b of batches) {
      const walkDur = b.model.animator.clips.get('Walk').duration;
      for (let i = 0; i < b.people.length; i++) {
        const s = b.people[i];
        s.walkClipDuration = walkDur;
        const offset = i * CREW_ACTOR_FLOATS;
        b.actors.set(s.transform, offset);
        b.actors.set(s.shirt, offset + 16);
        b.actors.set(s.trousers, offset + 20);
        b.actors.set(s.skin, offset + 24);
        b.actors.set(s.hair, offset + 28);
        b.actors.set(s.face, offset + 32);
        b.actors[offset + 19] = Number(!s.visible);
        b.actors[offset + 23] = 1;
        b.actors[offset + 27] = Number(s.sex === 'female');
        b.actors[offset + 31] = 0;
      }
    }
  }
  if (port) syncPort(port);

  return {
    get state() { return garrison; },
    get lodLevel() { return activeTier; },
    setPort(nextPort) { syncPort(nextPort); },
    update(nextPort, dt, wind = 0, camera = null, stepSimulation = true) {
      if (nextPort !== activePort || (nextPort && nextPort.garrison && nextPort.garrison !== garrison)) {
        syncPort(nextPort);
      }
      if (!garrison || !garrison.soldiers.length) {
        drawEnabled = false;
        return;
      }
      if (camera && Number.isFinite(camera.x) && Number.isFinite(camera.z)) {
        const portCullRadius = Math.max(240, activePort?.clearRadius ?? 260) + 440;
        const dx = camera.x - garrison.origin[0], dz = camera.z - garrison.origin[2];
        if (dx * dx + dz * dz > portCullRadius * portCullRadius) {
          drawEnabled = false;
          return;
        }
      }
      if (stepSimulation && dt > 0) stepFortGarrison(garrison, dt, wind);
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
      const lod = selectCrewLOD({ x: 0, z: 0, heave: 0 }, { x: minDist, y: 0, z: 0 });
      activeTier = lod.mainTier;
      drawEnabled = !lod.culled && minDist <= 420 && anyVisible;
      if (!drawEnabled) return;

      const stride = activeTier === 0 ? 1 : activeTier === 1 ? 2 : 4;
      const shouldSamplePoses = posesDirty || (sampleTick++ % stride) === 0;
      posesDirty = false;
      for (const b of batches) {
        if (!b.people.length) continue;
        const a = b.model.animator;
        for (let i = 0; i < b.people.length; i++) {
          const s = b.people[i];
          const offset = i * CREW_ACTOR_FLOATS;
          b.actors.set(s.transform, offset);
          b.actors[offset + 19] = Number(!s.visible);
          if (shouldSamplePoses) {
            a.sample('Idle', s.time, 'Walk', s.walkTime, s.walk);
            if (s.brace > 0.001) a.blend('Brace', s.time, s.brace);
            b.poses.set(a.palette, i * 65 * 16);
          }
        }
        if (shouldSamplePoses) {
          device.queue.writeBuffer(b.bones, 0, b.poses, 0, b.people.length * 65 * 16);
        }
        device.queue.writeBuffer(b.actor, 0, b.actors, 0, b.people.length * CREW_ACTOR_FLOATS);
      }
    },
    draw(pass) {
      if (!drawEnabled) return;
      pass.setPipeline(pipeline);
      pass.setBindGroup(1, lighting);
      for (const b of batches) {
        if (!b.people.length) continue;
        const lod = b.lods?.[activeTier] ?? { buffer: b.index, indexCount: b.model.indices.length };
        pass.setBindGroup(0, b.main);
        pass.setVertexBuffer(0, b.vertex);
        pass.setIndexBuffer(lod.buffer, 'uint32');
        pass.drawIndexed(lod.indexCount ?? lod.indices.length, b.people.length);
      }
    },
    destroy() {
      fortHullUBO.destroy();
      dryMoistureBuf.destroy();
      for (const b of batches) {
        b.bones.destroy();
        b.actor.destroy();
      }
    },
  };
}

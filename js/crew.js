import { loadCrewGLB, gltfTRS } from './gltf.js';
import { hullDeck, vesselDeck, HULL_VERTICAL_SCALE, HELM_TILLER_DISTANCE, modelDeck, modelHullDeck, modelDeckWidth, vesselVerticalScale } from './hull.js';
import { SAIL_KEYS, sailingState } from './sailing.js';
import { requestYardTransfer } from './lateen.js';
import { assignCrewWork, stepCrewWork, updateCrewGunneryAttendance, updateCrewRowingAttendance, hasExtendedCrewModel, crewSeatedPose, crewDeckHeight } from './crew-work.js';
import { poseCrewWork } from './crew-pose.js';
import { createGunneryTools } from './gunnery-tools.js';
import { CREW_RENDER, CREW_SHADOW } from './wgsl/crew.js';
import { NINA_DESIGN } from './models/nina.js';
import { requirePlayableShipModel, resolveShipNode } from './ship-models.js';
import {ADDITIONAL_DESIGNS,additionalStairFlights} from './models/additional.js';
import {ROWING_DESIGNS} from './models/rowing.js';
import {proceduralDesign} from './models/procedural.js';

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
const crewAdditionalNames={female:['Inês','Beatriz','Catarina','Leonor','Maria','Isabel','Ama','Lin','Freydís','Lucía','Runa','Mei','Amina','Elena','Nia','Astrid'],male:['Tomás','Duarte','João','Rui','Afonso','Pedro','Kofi','Li','Eirik','Mateo','Soren','Jin','Kwame','Diego','Tariq','Leif']};
function crewStationIdentity(key,index){
  const named=CREW_IDENTITIES.find(s=>s.id===key);if(named)return {...named,identityId:named.id};
  const sex=index%2?'male':'female',n=Math.floor(index/2),pool=CREW_IDENTITIES.filter(s=>s.sex===sex),identity=pool[n%pool.length];
  return {...identity,id:key,identityId:identity.id,name:crewAdditionalNames[sex][n%crewAdditionalNames[sex].length]};
}
export function createCompany(policy=deckhandDecision,modelId='nina') {
  const model=requirePlayableShipModel(modelId);
  // Twelve rendered workers are a representative watch on the much larger
  // Victory; they do not replace the vessel's separate personnel/load manifest.
  const extended=hasExtendedCrewModel(model.id),stations=extended?Object.entries(model.crewStations):CREW_ROSTER.map(identity=>[identity.id,model.crewStations[identity.id]]);
  const activeControls=extended?['fore','main','mizzen'].map((name,index)=>model.rig.sails.some(s=>s.controlGroup===name)?index:-1).filter(i=>i>=0):[0,1,2];
  return {modelId:model.id,activeControls,representativeWatch:model.id==='victory'||(extended?proceduralDesign(model.id).loading.crew>stations.length:!!ADDITIONAL_DESIGNS[model.id]),order:'watch',revision:0,pending:false,crew:stations.map(([key,station],i)=>{
    const identity=extended?crewStationIdentity(key,i):CREW_ROSTER[i],person={...identity,...station,stationKey:key};
    person.route??=[person.z,person.z];person.roles??=[person.role.toLowerCase()];
    if(extended&&Object.hasOwn(ROWING_DESIGNS,model.id)&&person.role==='Passenger'&&!stations.slice(0,i).some(([,p])=>p.role==='Passenger')){person.role='Captain';person.roles=['captain'];}
    // Keep short routine rounds on their current deck. Longer work trips use
    // the model's stair paths, including the exact ramp elevations.
    if(ADDITIONAL_DESIGNS[model.id]&&person.route[0]!==person.route[1]){
      const flights=additionalStairFlights(model.id),end=person.route[1],direction=Math.sign(end-person.z);
      const obstacle=flights.filter(f=>f.side===(Math.sign(person.x)||1)&&(direction>0?f.z0>person.z&&f.z0<=end:f.z1<person.z&&f.z1>=end)).sort((a,b)=>direction*(a.z0-b.z0))[0];
      if(obstacle)person.route=[person.z,direction>0?Math.max(person.z,obstacle.z0-.08):Math.min(person.z,obstacle.z1+.08)];
    }
    const s=createDeckhand(policy);Object.assign(s,person,{route:[...person.route],target:person.route[1],wait:i*.37,
      time:i*.43,walkTime:i*.27,yaw:person.yaw??(i%2?Math.PI:0),decisionIn:i/24,company:true});
    s.scale.fill((person.sex==='female'?.99:.96)*(1+(i%3-1)*.025));
    Object.assign(s.observation,{sailorId:s.id,role:s.role,captainOrder:'watch',orderRevision:0});
    const look=CREW_APPEARANCES[s.identityId??s.id];
    s.shirt=CREW_SHIRTS[i%6];s.skin=crewLinearColour(look.skin);s.trousers=i%3?[.095,.12,.15]:[.16,.10,.065];
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
  const order=CAPTAIN_ORDERS.find(o=>o.id===company.order),sails=sailingState(boat);
  // Manual sail settings supersede an outstanding broad order without stale reapplication.
  if(order.sails&&company.activeControls.some(i=>Math.abs(order.sails[i]-boat[SAIL_KEYS[i]])>.001)){
    company.order='watch';company.pending=false;company.revision++;
  } else company.pending=!!order.sails&&company.activeControls.some(i=>Math.abs(order.sails[i]-sails.set[i])>.01);
  dt=Math.max(0,Math.min(.1,Number.isFinite(dt)?dt:0));
  company.rigManeuver=sails.maneuver?.stage??null;
  company.workTime=(company.workTime??0)+dt;assignCrewWork(company,boat);
  for(const s of company.crew){
    s.observation.wind=wind;s.observation.roll=boat.roll??0;s.observation.rollRate=boat.rollVelocity??0;s.observation.captainOrder=company.order;s.observation.orderRevision=company.revision;
    s.order=company.gunneryActive||company.pending||company.order==='weather'?'standby':'patrol';
    if(s.job){s.seatedPose=null;s.moisturePoints=null;}
    if(!stepCrewWork(s,company,boat,dt)){s.observation.job=null;stepDeckhand(s,boat,dt,wind);}
  }
  updateCrewGunneryAttendance(company,boat);
  updateCrewRowingAttendance(company,boat);
  return company;
}
function boatHatchPending(company){return company.crew.some(s=>s.job?.kind==='hatch'&&s.job.stage!=='return');}
export function companyStatus(company) {
  const bracing=company.crew.filter(s=>s.intent==='brace').length;
  if(bracing)return `${bracing} hands bracing · ${CAPTAIN_ORDERS.find(o=>o.id===company.order).label}`;
  if(company.rigManeuver)return 'Transferring yards · gathering canvas and handling spars';
  if(company.order==='weather'&&(boatHatchPending(company)))return 'Prepare for heavy weather · securing canvas and hatch';
  if(company.pending)return `${CAPTAIN_ORDERS.find(o=>o.id===company.order).label} · handling sails`;
  return company.order==='watch'?`Sea watch · ${company.crew.length} ${company.representativeWatch?'hands representing the watch':'aboard'}${company.crew.some(s=>s.job?.kind==='lookout'&&s.job.stage==='working')?' · lookout aloft':''}`:`${CAPTAIN_ORDERS.find(o=>o.id===company.order).label} · sail setting reached`;
}
export function deckhandDecision(observation) {
  if(observation.hazard)return 'brace';
  if(observation.job)return 'work';
  return observation.order==='patrol'?'patrol':'standby';
}
export function createDeckhand(policy=deckhandDecision) {
  return {x:-.95,z:-1.9,yaw:0,target:.1,wait:1,time:0,walkTime:0,walk:0,brace:0,
    decisionIn:0,intent:'standby',order:'patrol',policy,visible:true,
    observation:{order:'patrol',hazard:false,roll:0,rollRate:0,wind:0},
    transform:new Float32Array(16),position:new Float32Array(3),rotation:new Float32Array(4),scale:new Float32Array([.95,.95,.95])};
}
function stepProceduralDeckhand(s,boat,dt,wind){
  s.time+=dt;s.walkTime+=dt*.8;s.climbPitch=0;
  const o=s.observation;o.wind=wind;o.order=s.order;o.roll=boat.roll??0;o.rollRate=boat.rollVelocity??0;
  o.hazard=Math.abs(o.roll)>.36||Math.abs(o.rollRate)>.5||wind>23;s.decisionIn-=dt;
  if(o.hazard||s.decisionIn<=0){let intent;try{intent=s.policy(o);}catch{intent=deckhandDecision(o);}s.intent=o.hazard?'brace':['patrol','standby','brace'].includes(intent)?intent:deckhandDecision(o);s.decisionIn=.5;}
  s.brace+=(Number(o.hazard)-s.brace)*(1-Math.exp(-dt*8));
  const seated=crewSeatedPose(s,boat);s.seatedPose=seated;
  if(seated){
    s.yaw=seated.body.yaw;s.walk=0;
    s.position.set([s.x*boat.beam/3.6,crewDeckHeight(boat,s.z,s.x)*vesselVerticalScale(boat)+.028,s.z*boat.length/12]);
    const seat=seated.seat,feet=seated.feet;s.moisturePoints=[feet[0].map((v,i)=>(v+feet[1][i])*.5),seat.map((v,i)=>v+(i===1?.10:0)),seat.map((v,i)=>v+(i===1?.50:0)),seat.map((v,i)=>v+(i===1?.95:0))];
  }else{
    let moving=false;
    if(s.intent==='patrol'&&s.route[0]!==s.route[1]){
      if(s.wait>0)s.wait=Math.max(0,s.wait-dt);
      else{const travel=Math.min(Math.abs(s.target-s.z),.65*dt/(boat.length/12));s.z+=Math.sign(s.target-s.z)*travel;moving=travel>0;if(Math.abs(s.target-s.z)<1e-6){s.target=s.target===s.route[1]?s.route[0]:s.route[1];s.wait=3;}}
    }
    s.walk+=(Number(moving)-s.walk)*(1-Math.exp(-dt*8));s.moisturePoints=null;
    s.position.set([s.x*boat.beam/3.6,crewDeckHeight(boat,s.z,s.x)*vesselVerticalScale(boat)+.028,s.z*boat.length/12]);
    if(s.roles?.includes('helmsman')){const grip=resolveShipNode(boat,'helm.grip');s.yaw=Math.atan2(grip[0]-s.position[0],grip[2]-s.position[2]);}
  }
  const half=s.yaw/2;s.rotation.set([0,Math.sin(half),0,Math.cos(half)]);gltfTRS(s.transform,s.position,s.rotation,s.scale);return s;
}
export function stepDeckhand(s,boat,dt,wind=0) {
  dt=Math.max(0,Math.min(.1,Number.isFinite(dt)?dt:0));
  if(hasExtendedCrewModel(boat.modelId))return stepProceduralDeckhand(s,boat,dt,wind);
  s.time+=dt;s.climbPitch=0;
  const o=s.observation;o.order=s.order;o.roll=boat.roll??0;o.rollRate=boat.rollVelocity??0;o.wind=wind;
  // Hysteresis avoids oscillating between walking and bracing near the threshold.
  o.hazard=Math.abs(o.roll)>(s.intent==='brace'?.26:.36)||Math.abs(o.rollRate)>(s.intent==='brace'?.3:.5)||wind>(s.intent==='brace'?19:23);
  s.decisionIn-=dt;
  if(o.hazard||s.decisionIn<=0){
    let decision;try{decision=s.policy(o);}catch{decision=deckhandDecision(o);}
    s.intent=['patrol','standby','brace'].includes(decision)?decision:deckhandDecision(o);s.decisionIn=.5;
    if(o.hazard)s.intent='brace';
  }
  // Preserve human proportions when resizing the hull; do not squeeze a person
  // through a walkway narrower than their shoulders.
  s.visible=boat.beam>=(s.company?3.2:2.8)&&boat.length>=(s.company?10.5:8);
  let moving=false;const lengthScale=boat.length/12;
  if(s.visible&&s.intent==='patrol'){
    if(s.wait>0)s.wait=Math.max(0,s.wait-dt);
    else if(s.route&&s.route[0]===s.route[1]){ /* fixed watch station */ }
    else {
      const desired=s.target>s.z?0:Math.PI,angle=Math.atan2(Math.sin(desired-s.yaw),Math.cos(desired-s.yaw));
      s.yaw+=Math.max(-dt*2.5,Math.min(dt*2.5,angle));
      if(Math.abs(angle)<.1){
        const delta=s.target-s.z,travel=Math.min(Math.abs(delta),.8*dt/lengthScale);s.z+=Math.sign(delta)*travel;moving=travel>0;
        if(Math.abs(s.z-s.target)<1e-5){s.target=s.route?(s.target===s.route[1]?s.route[0]:s.route[1]):s.target>0?-2.2:.1;s.wait=2.5;}
      }
    }
  }
  const blend=1-Math.exp(-dt*8);s.walk+=(Number(moving)-s.walk)*blend;s.brace+=(Number(s.intent==='brace')-s.brace)*blend;
  s.walkTime+=dt*.8; // Authored stride cadence, independent of delivered FPS.
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
  }else s.position.set([s.x*boat.beam/3.6,(s.company?modelDeck(boat,s.z):modelHullDeck(boat,s.z))*vesselVerticalScale(boat)+.028,s.z*lengthScale]);
  const sy=Math.sin(s.yaw/2),cy=Math.cos(s.yaw/2),sx=Math.sin((s.climbPitch??0)/2),cx=Math.cos((s.climbPitch??0)/2);
  s.rotation.set([cy*sx,sy*cx,-sy*sx,cy*cx]);gltfTRS(s.transform,s.position,s.rotation,s.scale);
  return s;
}

export async function createCrew({device,frameUBO,hullUBO,transView,skyView,sampClamp,envCubeView,sunVisBuf,shadows,wetness,shader,format='rgba16float',samples=4,shared=null,modelId='nina',waterOptics=null}) {
  const models=shared?.models??await Promise.all(['assets/crew/sailor.glb','assets/crew/sailor-female.glb'].map(async path=>{
    const response=await fetch(path);if(!response.ok)throw Error('Crew asset unavailable');return loadCrewGLB(await response.arrayBuffer());
  })),B=GPUBufferUsage,state=createCompany(undefined,modelId);
  if(models.some(m=>m.animator.joints.length!==65))throw Error('Crew expects the prepared 65-joint rigs');
  const buffer=(label,data,usage)=>{const b=device.createBuffer({label,size:data.byteLength,usage:usage|B.COPY_DST});device.queue.writeBuffer(b,0,data);return b;};
  const layout=[{arrayStride:60,attributes:[
    {shaderLocation:0,offset:0,format:'float32x3'},{shaderLocation:1,offset:12,format:'float32x3'},
    {shaderLocation:2,offset:24,format:'float32x3'},{shaderLocation:3,offset:36,format:'uint16x4'},
    {shaderLocation:4,offset:44,format:'float32x4'},
  ]}];
  const module=shared?null:await shader(CREW_RENDER,'crew'),shadowModule=shared?null:await shader(CREW_SHADOW,'crew shadow');
  const pipeline=shared?.pipeline??await device.createRenderPipelineAsync({label:'crew',layout:'auto',vertex:{module,entryPoint:'vs',buffers:layout},
    fragment:{module,entryPoint:'fs',targets:[{format}]},primitive:{topology:'triangle-list',cullMode:'none'},
    depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'greater'},multisample:{count:samples}});
  const shadowPipeline=shared?.shadowPipeline??await device.createRenderPipelineAsync({label:'crew shadow',layout:'auto',vertex:{module:shadowModule,entryPoint:'vs',buffers:layout},primitive:{topology:'triangle-list',cullMode:'none'},
    depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'less',depthBias:2,depthBiasSlopeScale:1.5}});
  const group=(pipe,resources)=>device.createBindGroup({layout:pipe.getBindGroupLayout(0),entries:resources.map((resource,binding)=>({binding,resource}))});
  const batches=models.map((model,i)=>{
    const people=state.crew.filter(s=>s.sex===(i?'female':'male'));
    // A one-person company legitimately has no actors in one sex batch.
    // Bind valid storage buffers, but submit no phantom instance for that batch.
    const poses=new Float32Array(Math.max(1,people.length)*65*16),actors=new Float32Array(Math.max(1,people.length)*CREW_ACTOR_FLOATS);
    const vertex=shared?.geometry[i].vertex??buffer('crew vertices',model.vertices,B.VERTEX),index=shared?.geometry[i].index??buffer('crew indices',model.indices,B.INDEX);
    const bones=buffer('crew joints',poses,B.STORAGE),actor=buffer('crew transforms',actors,B.STORAGE);
    const common=[{buffer:hullUBO},{buffer:bones},{buffer:actor}];
    const mainResources=[{buffer:frameUBO},...common,transView,sampClamp,envCubeView,{buffer:sunVisBuf},{buffer:wetness.state},skyView];
    const main=group(pipeline,mainResources);
    const shadow=group(shadowPipeline,[{buffer:shadows.uniform},...common]);
    return {model,people,poses,actors,vertex,index,bones,actor,main,shadow,mainResources};
  });
  const lighting=shadows.bind(pipeline);
  const submerged=waterOptics?await waterOptics.capture({source:CREW_RENDER,pipeline,vertex:{buffers:layout},groups:2}):null;
  const submergedLighting=submerged?shadows.bind(submerged.pipeline):null;
  if(submerged)for(const b of batches)b.submerged=submerged.bindGroup(b.mainResources);
  const gunTools=await createGunneryTools({device,frameUBO,transView,skyView,sampClamp,envCubeView,sunVisBuf,shadows,shader,format,samples,waterOptics,shared:shared?.gunTools});
  let enabled=true,drawEnabled=false;
  const drawBatch=(pass,b,shadow)=>{if(!b.people.length)return;pass.setBindGroup(0,shadow?b.shadow:b.main);pass.setVertexBuffer(0,b.vertex);pass.setIndexBuffer(b.index,'uint32');pass.drawIndexed(b.model.indices.length,b.people.length);};
  return {state,assets:{models,pipeline,shadowPipeline,gunTools:gunTools.assets,geometry:batches.map(({vertex,index})=>({vertex,index}))},triangles:batches.reduce((n,b)=>n+b.model.indices.length/3*b.people.length,0),joints:65,
    order(boat,id){return issueCaptainOrder(state,boat,id);},
    update(boat,dt,wind){
      stepCompany(state,boat,dt,wind);enabled=boat.crew!==false;drawEnabled=enabled&&boat.showProw&&state.crew.some(s=>s.visible);
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
          b.actors.set(s.shirt,offset+16);b.actors.set(s.trousers,offset+20);b.actors.set(s.skin,offset+24);b.actors.set(s.hair,offset+28);
          b.actors.set(s.face,offset+32);b.actors[offset+27]=Number(s.sex==='female');
          // The tiller station is below the camera; all crew remain visible.
          b.actors[offset+19]=Number(!s.visible);
          b.actors[offset+23]=Number(boat.enabled===true);
          b.actors[offset+31]=wetness.crewOffset+state.crew.indexOf(s)*4;
        }
        device.queue.writeBuffer(b.bones,0,b.poses);device.queue.writeBuffer(b.actor,0,b.actors);
      }
    },
    drawSubmerged(pass){
      if(!submerged||!drawEnabled)return;
      submerged.bind(pass);pass.setBindGroup(1,submergedLighting);
      for(const b of batches){if(!b.people.length)continue;pass.setBindGroup(0,b.submerged);pass.setVertexBuffer(0,b.vertex);pass.setIndexBuffer(b.index,'uint32');pass.drawIndexed(b.model.indices.length,b.people.length);}
      gunTools.drawSubmerged(pass);
    },
    draw(pass){if(!drawEnabled)return;pass.setPipeline(pipeline);pass.setBindGroup(1,lighting);for(const b of batches)drawBatch(pass,b,false);gunTools.draw(pass);},
    drawShadow(pass){if(!drawEnabled)return;pass.setPipeline(shadowPipeline);for(const b of batches)drawBatch(pass,b,true);gunTools.drawShadow(pass);},
    status(){return state.crew.length&&!state.crew.some(s=>s.visible)?hasExtendedCrewModel(modelId)?'Crew hidden':'Crew needs a larger deck':companyStatus(state);},
    destroy(){gunTools.destroy();for(const b of batches)for(const resource of [...(shared?[]:[b.vertex,b.index]),b.bones,b.actor])resource.destroy();},
  };
}

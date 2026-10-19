import { loadCrewGLB, gltfTRS } from './gltf.js';
import { hullDeck, vesselDeck, HULL_VERTICAL_SCALE, HELM_STATION_Z, HELM_TILLER_DISTANCE, tillerPoint } from './hull.js';
import { SAIL_KEYS, sailingState } from './sailing.js';
import { assignCrewWork, stepCrewWork } from './crew-work.js';
import { poseCrewWork } from './crew-pose.js';
import { CREW_RENDER, CREW_SHADOW } from './wgsl/crew.js';

// Authored, disjoint stations keep a full company clear of stairs and masts.
// Policies choose intent. The executor alone changes position and animation.
export const CREW_ROSTER = [
  {id:'ines',name:'Inês',sex:'female',role:'Captain',x:-.8,z:4.5,route:[4.5,4.5],yaw:Math.PI},
  {id:'tomas',name:'Tomás',sex:'male',role:'Mate',x:.8,z:3.3,route:[3.3,3.3],yaw:Math.PI},
  {id:'beatriz',name:'Beatriz',sex:'female',role:'Boatswain',x:-1.05,z:-2.1,route:[-2.1,-1.3]},
  {id:'duarte',name:'Duarte',sex:'male',role:'Foremast hand',x:1.05,z:-1.4,route:[-2.1,-1.3]},
  {id:'joao',name:'João',sex:'male',role:'Mainmast hand',x:-1.1,z:-.45,route:[-.45,.25]},
  {id:'catarina',name:'Catarina',sex:'female',role:'Mainmast hand',x:1.1,z:.2,route:[-.45,.25]},
  {id:'leonor',name:'Leonor',sex:'female',role:'Sailmaker',x:-1.1,z:1.25,route:[1.15,1.85]},
  {id:'rui',name:'Rui',sex:'male',role:'Carpenter',x:-.25,z:1.8,route:[1.8,1.8],yaw:Math.PI},
  {id:'maria',name:'Maria',sex:'female',role:'Lookout',x:.65,z:-4.7,route:[-4.7,-4.7],yaw:Math.PI},
  {id:'afonso',name:'Afonso',sex:'male',role:'Foredeck hand',x:-.65,z:-4.65,route:[-4.65,-4.65],yaw:Math.PI},
  {id:'isabel',name:'Isabel',sex:'female',role:'Mizzen hand',x:-.75,z:3.25,route:[3.25,3.25]},
  {id:'pedro',name:'Pedro',sex:'male',role:'Helmsman',x:0,z:HELM_STATION_Z,route:[HELM_STATION_Z,HELM_STATION_Z],yaw:0},
];
export const CAPTAIN_ORDERS = [
  {id:'full',label:'Make full sail',detail:'Set all canvas. Speed follows the wind.',sails:[1,1,1]},
  {id:'reduced',label:'Reduce sail',detail:'Bring each sail group to half canvas.',sails:[.5,.5,.5]},
  {id:'furl',label:'Furl all sails',detail:'Take in the canvas and coast.',sails:[0,0,0]},
  {id:'weather',label:'Prepare for heavy weather',detail:'Shorten sail and secure the main hatch.',sails:[.2,.2,0]},
  {id:'watch',label:'Resume sea watch',detail:'Return to routine duties; retain the current sail setting.'},
];
const CREW_SHIRTS=[[.55,.47,.31],[.23,.31,.36],[.38,.15,.10],[.30,.32,.18],[.48,.36,.22],[.38,.38,.35]];
const CREW_SKINS=[[.36,.18,.10],[.54,.31,.19],[.20,.085,.045],[.42,.23,.12]];
export function createCompany(policy=deckhandDecision) {
  return {order:'watch',revision:0,pending:false,crew:CREW_ROSTER.map((person,i)=>{
    const s=createDeckhand(policy);Object.assign(s,person,{route:[...person.route],target:person.route[1],wait:i*.37,
      time:i*.43,walkTime:i*.27,yaw:person.yaw??(i%2?Math.PI:0),decisionIn:i/24,company:true});
    s.scale.fill((person.sex==='female'?.99:.96)*(1+(i%3-1)*.025));
    Object.assign(s.observation,{sailorId:s.id,role:s.role,captainOrder:'watch',orderRevision:0});
    s.shirt=CREW_SHIRTS[i%6];s.skin=CREW_SKINS[i%4];s.trousers=i%3?[.095,.12,.15]:[.16,.10,.065];
    s.hair=i%4===0?[.12,.045,.015]:i%4===1?[.075,.055,.033]:[.025,.014,.009];return s;
  })};
}
export function issueCaptainOrder(company,boat,id) {
  const order=CAPTAIN_ORDERS.find(o=>o.id===id);if(!order)return false;
  company.order=id;company.revision++;company.pending=!!order.sails;
  boat.crewSailRate=new Float64Array(3);
  if(order.sails){boat.propulsion='sail';for(let i=0;i<3;i++)boat[SAIL_KEYS[i]]=order.sails[i];}
  for(const s of company.crew)s.decisionIn=0;
  return true;
}
export function stepCompany(company,boat,dt,wind) {
  const order=CAPTAIN_ORDERS.find(o=>o.id===company.order),sails=sailingState(boat);
  // Manual sail settings supersede an outstanding broad order without stale reapplication.
  if(order.sails&&order.sails.some((value,i)=>Math.abs(value-boat[SAIL_KEYS[i]])>.001)){
    company.order='watch';company.pending=false;company.revision++;
  } else company.pending=!!order.sails&&order.sails.some((value,i)=>Math.abs(value-sails.set[i])>.01);
  dt=Math.max(0,Math.min(.1,Number.isFinite(dt)?dt:0));
  company.workTime=(company.workTime??0)+dt;assignCrewWork(company,boat);
  for(const s of company.crew){
    s.observation.wind=wind;s.observation.roll=boat.roll??0;s.observation.rollRate=boat.rollVelocity??0;s.observation.captainOrder=company.order;s.observation.orderRevision=company.revision;
    s.order=company.pending||company.order==='weather'?'standby':'patrol';
    if(!stepCrewWork(s,company,boat,dt)){s.observation.job=null;stepDeckhand(s,boat,dt,wind);}
  }
  return company;
}
function boatHatchPending(company){return company.crew.some(s=>s.job?.kind==='hatch'&&s.job.stage!=='return');}
export function companyStatus(company) {
  const bracing=company.crew.filter(s=>s.intent==='brace').length;
  if(bracing)return `${bracing} hands bracing · ${CAPTAIN_ORDERS.find(o=>o.id===company.order).label}`;
  if(company.order==='weather'&&(boatHatchPending(company)))return 'Prepare for heavy weather · securing canvas and hatch';
  if(company.pending)return `${CAPTAIN_ORDERS.find(o=>o.id===company.order).label} · handling sails`;
  return company.order==='watch'?`Sea watch · 12 aboard${company.crew.some(s=>s.job?.kind==='lookout'&&s.job.stage==='working')?' · lookout aloft':''}`:`${CAPTAIN_ORDERS.find(o=>o.id===company.order).label} · sail setting reached`;
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
export function stepDeckhand(s,boat,dt,wind=0) {
  dt=Math.max(0,Math.min(.1,Number.isFinite(dt)?dt:0));s.time+=dt;
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
  if(s.role==='Helmsman'){
    const grip=tillerPoint(boat);s.x=grip[0]/(boat.beam/3.6);s.z=(grip[2]-HELM_TILLER_DISTANCE)/lengthScale;s.yaw=0;
    s.position.set([grip[0],hullDeck(s.z)*HULL_VERTICAL_SCALE+.028,grip[2]-HELM_TILLER_DISTANCE]);
  }else s.position.set([s.x*boat.beam/3.6,(s.company?vesselDeck(s.z):hullDeck(s.z))*HULL_VERTICAL_SCALE+.028,s.z*lengthScale]);
  s.rotation.set([0,Math.sin(s.yaw/2),0,Math.cos(s.yaw/2)]);gltfTRS(s.transform,s.position,s.rotation,s.scale);
  return s;
}

export async function createCrew({device,frameUBO,hullUBO,transView,sampClamp,envCubeView,sunVisBuf,shadows,wetness,shader,format='rgba16float',samples=4}) {
  const models=await Promise.all(['assets/crew/sailor.glb','assets/crew/sailor-female.glb'].map(async path=>{
    const response=await fetch(path);if(!response.ok)throw Error('Crew asset unavailable');return loadCrewGLB(await response.arrayBuffer());
  })),B=GPUBufferUsage,state=createCompany();
  if(models.some(m=>m.animator.joints.length!==65))throw Error('Crew expects the prepared 65-joint rigs');
  const buffer=(label,data,usage)=>{const b=device.createBuffer({label,size:data.byteLength,usage:usage|B.COPY_DST});device.queue.writeBuffer(b,0,data);return b;};
  const layout=[{arrayStride:60,attributes:[
    {shaderLocation:0,offset:0,format:'float32x3'},{shaderLocation:1,offset:12,format:'float32x3'},
    {shaderLocation:2,offset:24,format:'float32x3'},{shaderLocation:3,offset:36,format:'uint16x4'},
    {shaderLocation:4,offset:44,format:'float32x4'},
  ]}];
  const module=await shader(CREW_RENDER,'crew'),shadowModule=await shader(CREW_SHADOW,'crew shadow');
  const pipeline=await device.createRenderPipelineAsync({label:'crew',layout:'auto',vertex:{module,entryPoint:'vs',buffers:layout},
    fragment:{module,entryPoint:'fs',targets:[{format}]},primitive:{topology:'triangle-list',cullMode:'none'},
    depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'greater'},multisample:{count:samples}});
  const shadowPipeline=await device.createRenderPipelineAsync({label:'crew shadow',layout:'auto',vertex:{module:shadowModule,entryPoint:'vs',buffers:layout},primitive:{topology:'triangle-list',cullMode:'none'},
    depthStencil:{format:'depth32float',depthWriteEnabled:true,depthCompare:'less',depthBias:2,depthBiasSlopeScale:1.5}});
  const group=(pipe,resources)=>device.createBindGroup({layout:pipe.getBindGroupLayout(0),entries:resources.map((resource,binding)=>({binding,resource}))});
  const batches=models.map((model,i)=>{
    const people=state.crew.filter(s=>s.sex===(i?'female':'male'));
    const poses=new Float32Array(people.length*65*16),actors=new Float32Array(people.length*32);
    const vertex=buffer('crew vertices',model.vertices,B.VERTEX),index=buffer('crew indices',model.indices,B.INDEX);
    const bones=buffer('crew joints',poses,B.STORAGE),actor=buffer('crew transforms',actors,B.STORAGE);
    const common=[{buffer:hullUBO},{buffer:bones},{buffer:actor}];
    const main=group(pipeline,[{buffer:frameUBO},...common,transView,sampClamp,envCubeView,{buffer:sunVisBuf},{buffer:wetness.state}]);
    const shadow=group(shadowPipeline,[{buffer:shadows.uniform},...common]);
    return {model,people,poses,actors,vertex,index,bones,actor,main,shadow};
  });
  const lighting=shadows.bind(pipeline);
  let enabled=true,drawEnabled=false;
  const drawBatch=(pass,b,shadow)=>{pass.setBindGroup(0,shadow?b.shadow:b.main);pass.setVertexBuffer(0,b.vertex);pass.setIndexBuffer(b.index,'uint32');pass.drawIndexed(b.model.indices.length,b.people.length);};
  return {state,triangles:batches.reduce((n,b)=>n+b.model.indices.length/3*b.people.length,0),joints:65,
    order(boat,id){return issueCaptainOrder(state,boat,id);},
    update(boat,dt,wind){
      stepCompany(state,boat,dt,wind);enabled=boat.crew!==false;drawEnabled=enabled&&boat.showProw&&state.crew[0].visible;
      if(!drawEnabled)return;
      for(const b of batches){
        const a=b.model.animator;
        for(let i=0;i<b.people.length;i++){
          const s=b.people[i];a.sample('Idle',s.time,'Walk',s.walkTime,s.walk);
          if(s.brace>.001 && !(s.job?.rung>0))a.blend('Brace',s.time,s.brace);
          poseCrewWork(a,s,boat);
          b.poses.set(a.palette,i*65*16);b.actors.set(s.transform,i*32);
          b.actors.set(s.shirt,i*32+16);b.actors.set(s.trousers,i*32+20);b.actors.set(s.skin,i*32+24);b.actors.set(s.hair,i*32+28);
          // The tiller station is below the camera; all crew remain visible.
          b.actors[i*32+19]=0;
          b.actors[i*32+23]=Number(boat.enabled===true);
          b.actors[i*32+31]=wetness.crewOffset+state.crew.indexOf(s)*4;
        }
        device.queue.writeBuffer(b.bones,0,b.poses);device.queue.writeBuffer(b.actor,0,b.actors);
      }
    },
    draw(pass){if(!drawEnabled)return;pass.setPipeline(pipeline);pass.setBindGroup(1,lighting);for(const b of batches)drawBatch(pass,b,false);},
    drawShadow(pass){if(!drawEnabled)return;pass.setPipeline(shadowPipeline);for(const b of batches)drawBatch(pass,b,true);},
    status(){return !state.crew[0].visible?'Crew needs a larger deck':companyStatus(state);},
    destroy(){for(const b of batches)for(const resource of [b.vertex,b.index,b.bones,b.actor])resource.destroy();},
  };
}

import { vesselDeck, HULL_VERTICAL_SCALE, modelDeck, modelDeckWidth, vesselVerticalScale } from './hull.js';
import { shroudGeometry } from './rigging.js';
import { SAIL_KEYS, sailingState } from './sailing.js';
import { gltfTRS } from './gltf.js';
import { resolveShipNode } from './ship-models.js';
import { VICTORY_DESIGN, victorySheer } from './models/victory.js';

const CLIMBERS={beatriz:[0,-1],catarina:[1,1]};
const HANDS={duarte:0,joao:1,isabel:2};
const workClamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const distance3=(a,b)=>Math.hypot(...a.map((x,i)=>x-b[i]));
const deckPoint=(x,z,boat)=>[x,boat?modelDeck(boat,z):vesselDeck(z),z];
function physical(p,boat){return [p[0]*boat.beam/3.6,p[1]*vesselVerticalScale(boat),p[2]*boat.length/12];}
function homePoint(s,boat){return deckPoint(s.home[0],s.home[1],boat);}
function climbRoot(mast,side,rung,boat){
  const p=resolveShipNode(boat,`mast.${['fore','main','mizzen'][mast]}.runner`,{space:'design',side,step:rung});
  p[0]+=side*(boat.modelId==='victory'?.25/(boat.beam/3.6):.108);p[1]-=.12/vesselVerticalScale(boat);return p;
}
function haulStation(mast,boat){
  return resolveShipNode(boat,`station.haul.${['fore','main','mizzen'][mast]}`,{space:'design'});
}
// Match the paired seven-tread flights in the Victory mesh. Keeping these
// elevations on the route prevents a raised-deck transition teleporting feet.
const VICTORY_STAIRS=(()=>{const d=VICTORY_DESIGN.decks;return [
  [d.forecastle.end,d.forecastle.end+.6,d.forecastle.height,d.main],
  [d.quarter.start-.6,d.quarter.start,d.main,d.quarter.height],
  [d.poop.start-.6,d.poop.start,d.quarter.height,d.poop.height],
];})();
function victoryLanding(z){
  for(const [a,b,A,B] of VICTORY_STAIRS)if(z>a&&z<b)return Math.abs(z-a)<Math.abs(z-b)?a:b;
  return z;
}
function victoryStairHeight(z,boat){
  for(const [a,b,A,B]of VICTORY_STAIRS)if(z>=a&&z<=b)return A+(B-A)*(z-a)/(b-a)+victorySheer(z);
  return modelDeck(boat,z);
}
export function victoryCrewRoute(s,target,boat){
  let side=Math.sign(s.x)||Math.sign(target[0])||1;
  const start=victoryLanding(s.z),end=victoryLanding(target[2]);
  const path=[],add=(x,z,y=modelDeck(boat,z))=>{
    const p=[x,y,z],previous=path.at(-1);if(!previous||distance3(previous,p)>1e-8)path.push(p);
  };
  // Enter/leave a flight at its landing, then use the outboard corridor. The
  // centreline remains clear for hatch gratings, capstans and mast heels.
  const outer=z=>side*Math.min(1.3,modelDeckWidth(boat,z)-.12);
  add(s.x,start);add(outer(start),start);
  const along=(from,to)=>{
    const direction=Math.sign(to-from),count=Math.max(1,Math.ceil(Math.abs(to-from)/.35));
    const stops=[from,to,...Array.from({length:count-1},(_,i)=>from+(to-from)*(i+1)/count),...VICTORY_STAIRS.flatMap(([a,b])=>[a,b]).filter(z=>direction>0?z>from&&z<to:z<from&&z>to)].sort((a,b)=>direction*(a-b));
    for(let i=1;i<stops.length;i++){
      const a=stops[i-1],b=stops[i],mid=(a+b)/2,flight=VICTORY_STAIRS.some(([lo,hi])=>mid>lo&&mid<hi);
      add(flight?side*.9:outer(a),a,flight?victoryStairHeight(a,boat):modelDeck(boat,a));
      add(flight?side*.9:outer(b),b,flight?victoryStairHeight(b,boat):modelDeck(boat,b));
    }
  };
  if(target[0]*side<0){
    // Change sides away from the wheel, mast heels, hatch and stair mouths.
    const crossing=Math.min(start,end)>=4.35?4.75:Math.min(start,end)>=1.65?2:Math.max(start,end)<=-3.92?-4.7:.75;
    along(start,crossing);side=-side;add(outer(crossing),crossing);along(crossing,end);
  }else along(start,end);
  add(target[0],end);
  add(target[0],target[2],target[1]);return path;
}
export function crewRunnerMetrics(boat,mast,side){
  if(boat.modelId==='victory'){
    const id=`mast.${['fore','main','mizzen'][mast]}.runner`,a=resolveShipNode(boat,id,{space:'design',side,step:0}),b=resolveShipNode(boat,id,{space:'design',side,step:29});
    const dx=(b[0]-a[0])*boat.beam/3.6,dy=(b[1]-a[1])*vesselVerticalScale(boat),dz=(b[2]-a[2])*boat.length/12;
    return {rungs:29,dy:dy/29,lean:Math.atan2(Math.hypot(dx,dz),dy),yaw:Math.atan2(dx,dz)};
  }
  const {rungs,head,feet}=shroudGeometry(mast,side);
  return {rungs,dy:(head[1]-(feet[0][1]+feet[1][1])*.5)*HULL_VERTICAL_SCALE/rungs};
}
function routeTo(s,target,boat){
  if(boat.modelId==='victory')return victoryCrewRoute(s,target,boat);
  // Named corridors stay clear of the hatch, mast heels and aft companionway.
  if(s.id==='maria')return [deckPoint(s.x,target[2]),target];
  if(s.id==='rui')return [deckPoint(.55,s.z),deckPoint(.55,-2.25),target];
  if(s.id==='beatriz')return [deckPoint(s.x,-2.65),deckPoint(target[0],-2.65),target];
  if(s.id==='catarina')return [deckPoint(s.x,2.55),deckPoint(target[0],2.55),target];
  return [deckPoint(target[0],s.z),target];
}
export function assignCrewWork(company,boat) {
  const sails=sailingState(boat),needs=SAIL_KEYS.map((key,i)=>Math.abs((boat[key]??1)-sails.set[i])>.008);
  company.workTime??=0;
  for(const s of company.crew){
    s.home??=[s.x,s.z];
    if(s.job)continue;
    let job;
    if(CLIMBERS[s.id] && needs[CLIMBERS[s.id][0]] && !sails.maneuver){
      const [mast]=CLIMBERS[s.id],side=boat.modelId==='victory'?Math.sign(s.x)||-1:-Math.sign(sails.rig[mast].side);job={kind:'rig',mast,side};
    }else if(HANDS[s.id]!==undefined && (needs[HANDS[s.id]] || sails.maneuver)){
      job={kind:'haul',mast:HANDS[s.id]};
    }else if(s.id==='rui' && company.order==='weather' && (boat.hatchesClosed??0)<.999){
      job={kind:'hatch'};
    }else if(s.id==='maria' && !sails.maneuver && company.order==='watch' && company.workTime>(s.nextWatch??12)){
      job={kind:'lookout',mast:0,side:boat.modelId==='victory'?Math.sign(s.x)||-1:-Math.sign(sails.rig[0].side)};
    }
    if(!job)continue;
    job.stage='approach';job.elapsed=0;job.rung=0;job.revision=company.revision;
    const target=job.kind==='hatch'?resolveShipNode(boat,'station.hatch',{space:'design'})
      :job.kind==='haul'?haulStation(job.mast,boat)
      :climbRoot(job.mast,job.side,0,boat);
    job.path=routeTo(s,target,boat);job.cursor=0;s.job=job;s.intent='work';s.work=0;
  }
  // Crew attendance gates the actual canvas integrator, even when rendered crew
  // are hidden. Manual sliders still request jobs; no instant magical sail changes.
  boat.crewRigRate??=new Float64Array(3);boat.crewRigRate.fill(0);
  const aloft=company.crew.some(s=>s.job?.rung>0);
  boat.crewSailRate??=new Float64Array(3);boat.crewSailRate.fill(0);
  for(let mast=0;mast<3;mast++){
    const ready=company.crew.filter(s=>s.job?.mast===mast && s.job.stage==='working' && !s.observation.hazard);
    boat.crewRigRate[mast]=Number(!aloft && ready.some(s=>s.job.kind==='haul'));
    boat.crewSailRate[mast]=mast===2?Number(ready.some(s=>s.job.kind==='haul'))
      :Number(ready.some(s=>s.job.kind==='haul') && ready.some(s=>s.job.kind==='rig'));
  }
}
export function stepCrewWork(s,company,boat,dt) {
  const j=s.job;if(!j)return false;
  if(boat.sailState?.maneuver && (j.kind==='rig'||j.kind==='lookout') && ['ascending','working'].includes(j.stage))j.stage='descending';
  dt=workClamp(Number.isFinite(dt)?dt:0,0,.1);s.time+=dt;s.walkTime+=dt*.8;
  const o=s.observation;
  o.hazard=Math.abs(boat.roll??0)>(s.intent==='brace'?.26:.36)||Math.abs(boat.rollVelocity??0)>(s.intent==='brace'?.3:.5)||o.wind>(s.intent==='brace'?19:23);
  o.job=j.kind;o.stage=j.stage;o.order='work';
  s.decisionIn-=dt;
  if(o.hazard||s.decisionIn<=0){
    let choice;try{choice=s.policy(o);}catch{choice='work';}
    s.intent=o.hazard||choice==='brace'?'brace':choice==='standby'?'standby':'work';s.decisionIn=.5;
  }
  const active=s.intent==='work';let moving=false;
  s.visible=boat.beam>=3.2&&boat.length>=10.5;
  if(active){
    j.elapsed+=dt;
    if(j.stage==='approach'||j.stage==='return'){
      let p=j.position??[s.x,s.position[1]? (s.position[1]-.028)/vesselVerticalScale(boat):modelDeck(boat,s.z),s.z];
      const target=j.path[j.cursor],a=physical(p,boat),b=physical(target,boat),d=distance3(a,b);
      const travel=Math.min(d,.75*dt),q=d>1e-6?travel/d:1;
      const next=p.map((x,i)=>x+(target[i]-x)*q),world=physical(next,boat);
      // Yield locally to another body rather than walking through it.
      const occupied=company.crew.some(other=>other!==s&&other.position&&Math.hypot(world[0]-other.position[0],world[1]+.028-other.position[1],world[2]-other.position[2])<.54);
      if(!occupied || d<.02){
        j.position=next;s.x=next[0];s.z=next[2];moving=travel>0;
        if(d>.01)s.yaw=Math.atan2(b[0]-a[0],b[2]-a[2]);
        if(d<=.02){j.cursor++;if(j.cursor>=j.path.length){
          if(j.stage==='return'){s.job=null;s.x=s.home[0];s.z=s.home[1];s.wait=2;return false;}
          j.stage=(j.kind==='rig'||j.kind==='lookout')?'ascending':'working';j.elapsed=0;
        }}
      }
    }else if(j.stage==='ascending'||j.stage==='descending'){
      const {rungs,dy}=crewRunnerMetrics(boat,j.mast,j.side);
      // Stop below the working top, leaving overhead handholds within reach.
      const clearance=1.6+(boat.modelId==='victory'?.25*vesselVerticalScale(boat):0);
      j.top=Math.max(0,Math.floor(rungs-clearance/dy));
      const direction=j.stage==='ascending'?1:-1;
      j.rung=workClamp(j.rung+direction*.38*dt/dy,0,j.top);
      j.position=climbRoot(j.mast,j.side,j.rung,boat);s.x=j.position[0];s.z=j.position[2];s.yaw=-j.side*Math.PI/2;
      if(j.stage==='ascending'&&j.rung>=j.top){j.stage='working';j.elapsed=0;}
      if(j.stage==='descending'&&j.rung<=0)startReturn(s,boat);
    }else if(j.stage==='working'){
      s.yaw=j.kind==='hatch'?(boat.modelId==='victory'?-Math.PI/2:Math.PI):j.kind==='haul'?Math.sign(s.x)*Math.PI/2:-j.side*Math.PI/2;
      if(j.kind==='hatch')boat.hatchesClosed=workClamp((boat.hatchesClosed??0)+dt/8,0,1);
      if(j.kind==='lookout'){company.lookoutHeight=s.position[1]+1.65;}
      const done=j.kind==='hatch'?(boat.hatchesClosed??0)>=1:j.kind==='lookout'?j.elapsed>18||company.order!=='watch'
        :!sailingState(boat).maneuver && Math.abs((boat[SAIL_KEYS[j.mast]]??1)-sailingState(boat).set[j.mast])<.008;
      if(done){if(j.kind==='rig'||j.kind==='lookout'){j.stage='descending';s.nextWatch=company.workTime+45;}
        else startReturn(s,boat);}
    }
    // A replaced order never teleports an aloft sailor; they finish/descend safely.
    if(j.kind==='lookout'&&company.order!=='watch'&&j.stage==='ascending')j.stage='descending';
  }
  const blend=1-Math.exp(-dt*8);s.walk+=(Number(moving)-s.walk)*blend;
  s.brace+=(Number(s.intent==='brace')-s.brace)*blend;
  s.work+=(Number(active&&j.stage==='working')-s.work)*blend;
  const p=j.position??[s.x,modelDeck(boat,s.z),s.z];s.position.set(physical(p,boat));s.position[1]+=.028;
  s.climbPitch=0;
  if(boat.modelId==='victory'&&j.rung>0){
    const runner=crewRunnerMetrics(boat,j.mast,j.side);s.climbPitch=runner.lean;s.yaw=runner.yaw;
  }else if(boat.modelId==='victory'&&j.kind==='haul'&&j.stage==='working')s.climbPitch=.16;
  const sy=Math.sin(s.yaw/2),cy=Math.cos(s.yaw/2),sx=Math.sin(s.climbPitch/2),cx=Math.cos(s.climbPitch/2);
  s.rotation.set([cy*sx,sy*cx,-sy*sx,cy*cx]);gltfTRS(s.transform,s.position,s.rotation,s.scale);
  return true;
}
function startReturn(s,boat){
  const j=s.job;j.stage='return';j.elapsed=0;j.cursor=0;
  const home=homePoint(s,boat);
  if(boat.modelId==='victory'){j.path=victoryCrewRoute(s,home,boat);return;}
  j.path=s.id==='maria'?[deckPoint(s.x,-3.2),deckPoint(home[0],-3.2),home]
    :s.id==='duarte'?[deckPoint(home[0],s.z),home]
    :[...j.path.slice(0,-1).reverse(),home];
}
export function crewWorkLabel(s){
  if(s.intent==='brace')return s.job?.rung>0?'Holding fast aloft':'Bracing';
  if(!s.job)return s.walk>.3?'On rounds':'At station';
  const j=s.job;
  if(j.stage==='ascending')return 'Climbing a runner';if(j.stage==='descending')return 'Climbing down';
  if(j.stage==='approach')return 'Going to work';if(j.stage==='return')return 'Returning to station';
  return {rig:'Working the rigging',haul:'Hauling sail tackle',hatch:'Battening the hatch',lookout:'Keeping lookout aloft'}[j.kind];
}

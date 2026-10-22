import { vesselDeck, HULL_VERTICAL_SCALE, modelDeck, modelDeckWidth, vesselVerticalScale } from './hull.js';
import { shroudGeometry } from './rigging.js';
import { SAIL_KEYS, sailingState } from './sailing.js';
import { gltfTRS } from './gltf.js';
import { resolveShipNode,requirePlayableShipModel } from './ship-models.js';
import { VICTORY_DESIGN, victorySheer,victoryStairFlights,victoryChainwale } from './models/victory.js';
import {ADDITIONAL_DESIGNS,additionalStairFlights} from './models/additional.js';
import {ROWING_DESIGNS,rowingRigContext,rowingBenchDescriptors} from './models/rowing.js';
import {LATER_SAIL_DESIGNS,laterSailStairFlights} from './models/later-sail.js';
import {proceduralDesign,proceduralDeck,proceduralDeckWidth,proceduralHullWidth} from './models/procedural.js';
import {laterSailRigContext} from './additional-rig.js';
import {rowingStationPose,rowingSteeringPose} from './rowing.js';
import {crewNavigationStation,crewNavigationRoute,crewRoutineSegmentClear,crewNavigationClear,crewNavigationSegmentClear,crewNavigationObstacles} from './crew-navigation.js';
import {crewDeckHazard,crewMotionPolicy,crewAdvanceWalk} from './crew-motion.js';

export const hasExtendedCrewModel=id=>Object.hasOwn(ROWING_DESIGNS,id??'')||Object.hasOwn(LATER_SAIL_DESIGNS,id??'');
const crewWorkControls=['fore','main','mizzen'];
export function crewMastName(boat,index){return requirePlayableShipModel(boat.modelId??'nina').rig.masts[index]?.id??crewWorkControls[index];}
const crewExtendedContext=id=>Object.hasOwn(ROWING_DESIGNS,id)?rowingRigContext(id):laterSailRigContext(id);
const crewExtendedFlights=id=>Object.hasOwn(LATER_SAIL_DESIGNS,id)?laterSailStairFlights(id):[];
export function crewDeckHeight(boat,z,x=0){return hasExtendedCrewModel(boat.modelId)?proceduralDeck(boat.modelId,z,x):modelDeck(boat,z);}

// These targets are the actual shaft/seat evaluator used by the water forces
// and visible propulsors. Crew never advances the shared rowing phase.
export function crewSeatedPose(s,boat){
  if(!Object.hasOwn(ROWING_DESIGNS,boat.modelId??''))return null;
  if(s.stationId)return rowingStationPose(boat,s.stationId);
  const d=proceduralDesign(boat.modelId),station=d.crewStations[s.stationKey??s.id];if(!station)return null;
  const scale=[boat.beam/d.frame.beam,d.frame.verticalScale,boat.length/d.frame.length],seat=[station.x,station.y,station.z].map((v,i)=>v*scale[i]);
  const stance=station.yaw??Math.PI,z=seat[2]+Math.cos(stance)*.46,Z=z/scale[2],floor=proceduralDeck(d.id,Z,station.x)*scale[1];
  const edge=Math.max(.12,proceduralHullWidth(d.id,Z,proceduralDeck(d.id,Z,station.x))*scale[0]-d.shellThicknessMetres),x=Math.max(-edge+.12,Math.min(edge-.12,seat[0]));
  const feet=[[x-.10,floor,z],[x+.10,floor,z]],hands=s.role==='Helmsman'?rowingSteeringPose(boat).hands:
    [-1,1].map(side=>[seat[0]+side*.14,seat[1]+.18,seat[2]+Math.cos(stance)*.22]);
  // A side-mounted steering oar is not directly in front of the bench. Turn
  // toward its real grips without moving the seat or the planted foot targets.
  const yaw=s.role==='Helmsman'?Math.atan2((hands[0][0]+hands[1][0])*.5-seat[0],(hands[0][2]+hands[1][2])*.5-seat[2]):stance;
  return {seat,feet,hands,body:{position:seat,yaw,lean:0},stationId:s.stationKey??s.id,drive:false,effort:0};
}
export function updateCrewRowingAttendance(company,boat){
  if(!Object.hasOwn(ROWING_DESIGNS,boat.modelId??''))return;
  const attendance=boat.rowingAttendance??=new Set();attendance.clear();
  for(const s of company.crew)if(s.stationId&&!s.job&&!s.observation.hazard)attendance.add(s.stationId);
}

const CLIMBERS={beatriz:[0,-1],catarina:[1,1]};
const HANDS={duarte:0,joao:1,isabel:2};
const workClamp=(x,a,b)=>Math.max(a,Math.min(b,x));
const distance3=(a,b)=>Math.hypot(...a.map((x,i)=>x-b[i]));
const deckPoint=(x,z,boat)=>[x,boat?crewDeckHeight(boat,z,x):vesselDeck(z),z];
function physical(p,boat){return [p[0]*boat.beam/3.6,p[1]*vesselVerticalScale(boat),p[2]*boat.length/12];}
function crewRowingWalkState(s,boat){
  const j=s.job;if(!j||!Object.hasOwn(ROWING_DESIGNS,boat.modelId??''))return null;
  if(j.rowingWalk?.source===j.path)return j.rowingWalk;
  const points=[],distances=[];let length=0;
  for(const p of j.path??[]){
    const point=physical(p,boat),previous=points.at(-1),distance=previous?Math.hypot(point[0]-previous[0],point[2]-previous[2]):0;
    if(previous&&distance<1e-8)continue;
    length+=distance;points.push(point);distances.push(length);
  }
  if(!points.length)points.push(Array.from(s.position)),distances.push(0);
  const benches=rowingBenchDescriptors(boat.modelId).map(b=>({...b,min:physical(b.min,boat),max:physical(b.max,boat),z:b.z*boat.length/12,top:b.top*vesselVerticalScale(boat)}));
  return j.rowingWalk={source:j.path,points,distances,length,distance:0,benches};
}
function crewRowingPathPoint(w,distance){
  const along=workClamp(distance,0,w.length);let i=1;while(i<w.points.length-1&&w.distances[i]<along)i++;
  const a=w.points[Math.max(0,i-1)],b=w.points[Math.min(i,w.points.length-1)],span=w.distances[Math.min(i,w.distances.length-1)]-w.distances[Math.max(0,i-1)],t=span>1e-9?(along-w.distances[i-1])/span:0;
  return {point:a.map((v,k)=>v+(b[k]-v)*t),yaw:Math.atan2(b[0]-a[0],b[2]-a[2])};
}
// Actual boot soles alternate planted contacts. Swing lifts vertically before
// advancing over a thwart, then lowers onto its top or the actual floor.
// This evaluator never advances work, rowing phase or attendance.
export function crewRowingWalkContacts(s,boat,footprints){
  const w=crewRowingWalkState(s,boat);if(!w)return null;
  const sy=vesselVerticalScale(boat),sx=boat.beam/3.6,sz=boat.length/12,stride=.60,smooth=t=>{t=workClamp(t,0,1);return t*t*(3-2*t);};
  const contact=(distance,side)=>{
    const f=footprints[side],q=crewRowingPathPoint(w,distance),sign=side==='l'?1:-1,lateral=Math.abs(f.ankle[0])*s.scale[0];
    const p=q.point.slice();p[0]+=Math.cos(q.yaw)*sign*lateral;p[2]-=Math.sin(q.yaw)*sign*lateral;
    const radius=Math.hypot(Math.max(Math.abs(f.min[0]),Math.abs(f.max[0]))*s.scale[0],Math.max(Math.abs(f.min[2]),Math.abs(f.max[2]))*s.scale[2]);
    let support=null;
    for(const b of w.benches)if(p[0]+radius>b.min[0]&&p[0]-radius<b.max[0]&&p[2]+radius>b.min[2]&&p[2]-radius<b.max[2]&&(!support||Math.abs(p[2]-b.z)<Math.abs(p[2]-support.z)))support=b;
    if(support){p[2]=support.z;p[1]=support.top;}
    else p[1]=proceduralDeck(boat.modelId,p[2]/sz,p[0]/sx)*sy;
    return {sole:p,yaw:q.yaw,support:support?.id??'floor',radius};
  };
  const feet=[];
  for(const [index,side]of ['l','r'].entries()){
    if(!footprints[side])throw Error('Walking crew requires measured '+side+' boot');
    if(!['approach','return','lookout-approach','lookout-return'].includes(s.job.stage)){
      const f=footprints[side],sign=side==='l'?1:-1,p=Array.from(s.position),lateral=Math.abs(f.ankle[0])*s.scale[0];p[0]+=Math.cos(s.yaw)*sign*lateral;p[2]-=Math.sin(s.yaw)*sign*lateral;
      const radius=Math.hypot(Math.max(Math.abs(f.min[0]),Math.abs(f.max[0]))*s.scale[0],Math.max(Math.abs(f.min[2]),Math.abs(f.max[2]))*s.scale[2]);
      const b=w.benches.find(b=>p[0]+radius>b.min[0]&&p[0]-radius<b.max[0]&&p[2]+radius>b.min[2]&&p[2]-radius<b.max[2]);
      p[1]=b?b.top:proceduralDeck(boat.modelId,p[2]/sz,p[0]/sx)*sy;feet.push({sole:p,yaw:s.yaw,support:b?.id??'floor',swing:false});continue;
    }
    const offset=index*.5,cycle=w.distance/stride+offset,base=Math.floor(cycle),phase=cycle-base,at=(base-offset)*stride+stride*.25,a=contact(at,side);
    if(phase<=.5){feet.push({...a,swing:false});continue;}
    const b=contact(at+stride,side),t=(phase-.5)*2,e=smooth((t-.18)/.64),radius=Math.max(a.radius,b.radius),low=a.sole.map((v,k)=>v+(b.sole[k]-v)*e);
    let clearance=Math.max(a.sole[1],b.sole[1]);
    for(const bench of w.benches)if(Math.max(a.sole[0],b.sole[0])+radius>bench.min[0]&&Math.min(a.sole[0],b.sole[0])-radius<bench.max[0]&&Math.max(a.sole[2],b.sole[2])+radius>bench.min[2]&&Math.min(a.sole[2],b.sole[2])-radius<bench.max[2])clearance=Math.max(clearance,bench.top);
    clearance+=.08;
    low[1]=t<.18?a.sole[1]+(clearance-a.sole[1])*smooth(t/.18):t>.82?clearance+(b.sole[1]-clearance)*smooth((t-.82)/.18):clearance;
    feet.push({sole:low,yaw:a.yaw+Math.atan2(Math.sin(b.yaw-a.yaw),Math.cos(b.yaw-a.yaw))*e,support:null,swing:true});
  }
  return {feet,benches:w.benches,distance:w.distance};
}
function homePoint(s,boat){return deckPoint(s.home[0],s.home[1],boat);}
function climbRoot(mast,side,rung,boat){
  const p=resolveShipNode(boat,`mast.${crewMastName(boat,mast)}.runner`,{space:'design',side,step:rung});
  p[0]+=side*(boat.modelId==='victory'?.25/(boat.beam/3.6):.108);p[1]-=.12/vesselVerticalScale(boat);return p;
}
function haulStation(mast,boat){
  return resolveShipNode(boat,`station.haul.${['fore','main','mizzen'][mast]}`,{space:'design'});
}
function crewWorkDescend(s){
  const j=s.job;
  if(j.lookoutAtStation&&j.lookoutEntry){j.stage='lookout-return';j.path=[[...j.lookoutEntry]];j.cursor=0;j.lookoutAtStation=false;}
  else j.stage='descending';
}
function crewAdditionalPassingDetour(s,company,boat,p,target){
  const d=ADDITIONAL_DESIGNS[boat.modelId],j=s.job,direction=Math.abs(target[2]-p[2])>1e-7?Math.sign(target[2]-p[2]):j.passingDirection;
  if(!d||!direction)return false;
  const sx=boat.beam/3.6,sz=boat.length/12,here=physical(p,boat);here[1]+=.028;
  const bodies=company.crew.filter(o=>o!==s&&o.position),other=bodies.filter(o=>distance3(o.position,here)<.72).sort((a,b)=>distance3(a.position,here)-distance3(b.position,here))[0];
  if(!other||(other.job&&company.crew.indexOf(s)>company.crew.indexOf(other)))return false;
  const clearance=.68,otherX=other.position[0]/sx,otherZ=other.position[2]/sz,end=otherZ+direction*clearance/sz,backZ=otherZ-direction*clearance/sz;
  const retreat=direction*(p[2]-backZ)>0?backZ:p[2];
  let index=j.cursor;while(index<j.path.length-1&&direction*(j.path[index][2]-end)<0)index++;
  const finish=j.path[index];if(direction*(finish[2]-p[2])<=0||Math.abs(finish[2]-retreat)>1.8)return false;
  const flights=additionalStairFlights(boat.modelId),h=d.hatch;
  const clearPoint=q=>{
    const [x,y,z]=q,world=physical(q,boat);world[1]+=.028;
    return Math.abs(x)+.30/sx<modelDeckWidth(boat,z)&&Math.abs(y-modelDeck(boat,z))<.05&&
      !(Math.abs(z-h.centre[2])<h.size[2]/2+.28/sz&&Math.abs(x-h.centre[0])<h.size[0]/2+.30/sx)&&
      !d.masts.some(m=>Math.abs(z-m.z)<.30/sz&&Math.abs(x)<m.radius+.30/sx)&&
      !flights.some(f=>z>f.z0&&z<f.z1&&Math.abs(x-f.x)<f.width/2+.20/sx)&&
      bodies.every(o=>distance3(o.position,world)>=.54-1e-6);
  };
  for(const side of [-Math.sign(p[0]||1),Math.sign(p[0]||1)]){
    const x=otherX+side*clearance/sx,path=[[p[0],modelDeck(boat,retreat),retreat],[x,modelDeck(boat,retreat),retreat],[x,modelDeck(boat,finish[2]),finish[2]],[...finish]];
    let previous=p,clear=true;
    for(const point of path){
      const a=physical(previous,boat),b=physical(point,boat);a[1]+=.028;b[1]+=.028;
      const direction=b.map((v,k)=>v-a[k]),length2=direction.reduce((sum,v)=>sum+v*v,0);
      if(bodies.some(o=>{const t=length2?workClamp(direction.reduce((sum,v,k)=>sum+v*(o.position[k]-a[k]),0)/length2,0,1):0;return distance3(o.position,a.map((v,k)=>v+direction[k]*t))<.54-1e-6;})){clear=false;break;}
      const n=Math.max(1,Math.ceil(distance3(a,b)/.08));
      for(let i=0;i<=n;i++)if(!clearPoint(previous.map((v,k)=>v+(point[k]-v)*i/n))){clear=false;break;}
      if(!clear)break;previous=point;
    }
    if(!clear)continue;
    j.path=[...path,...j.path.slice(index+1)];j.cursor=0;j.passing=true;j.passingDirection=direction;j.blockedTime=0;return true;
  }
  return false;
}
// Match the paired seven-tread flights in the Victory mesh. Keeping these
// elevations on the route prevents a raised-deck transition teleporting feet.
const VICTORY_STAIRS=victoryStairFlights().filter(f=>f.side===1).map(f=>[f.z0,f.z1,f.y0,f.y1,f.x]);
function victoryLanding(z){
  for(const [a,b,A,B] of VICTORY_STAIRS)if(z>a&&z<b)return Math.abs(z-a)<Math.abs(z-b)?a:b;
  return z;
}
function victoryStairHeight(z,boat){
  for(const [a,b,A,B]of VICTORY_STAIRS)if(z>=a&&z<=b)return A+(B-A)*(z-a)/(b-a);
  return modelDeck(boat,z);
}
export function victoryCrewRoute(s,target,boat,{gunCorridor=false}={}){
  let side=Math.sign(s.x)||Math.sign(target[0])||1;
  const start=victoryLanding(s.z),end=victoryLanding(target[2]);
  const path=[],add=(x,z,y=modelDeck(boat,z))=>{
    const p=[x,y,z],previous=path.at(-1);if(!previous||distance3(previous,p)>1e-8)path.push(p);
  };
  // Enter/leave a flight at its landing, then use the outboard corridor. The
  // centreline remains clear for hatch gratings, capstans and mast heels.
  const outer=z=>side*Math.min(gunCorridor?.54:z<=VICTORY_DESIGN.decks.forecastle.end?.41:.90,modelDeckWidth(boat,z)-.34/(boat.beam/3.6));
  add(s.x,start);add(outer(start),start);
  const along=(from,to)=>{
    const direction=Math.sign(to-from),count=Math.max(1,Math.ceil(Math.abs(to-from)/.35));
    const stops=[from,to,...Array.from({length:count-1},(_,i)=>from+(to-from)*(i+1)/count),...VICTORY_STAIRS.flatMap(([a,b])=>[a,b]).filter(z=>direction>0?z>from&&z<to:z<from&&z>to)].sort((a,b)=>direction*(a-b));
    for(let i=1;i<stops.length;i++){
      const a=stops[i-1],b=stops[i],mid=(a+b)/2,flight=VICTORY_STAIRS.find(([lo,hi])=>mid>lo&&mid<hi);
      add(flight?side*flight[4]:outer(a),a,flight?victoryStairHeight(a,boat):modelDeck(boat,a));
      add(flight?side*flight[4]:outer(b),b,flight?victoryStairHeight(b,boat):modelDeck(boat,b));
    }
  };
  if(target[0]*side<0){
    // Change sides away from the wheel, mast heels, hatch and stair mouths.
    const crossing=Math.min(start,end)>=4.35?4.75:Math.min(start,end)>=1.65?2:Math.max(start,end)<=-3.92?-4.7:.75;
    along(start,crossing);side=-side;add(outer(crossing),crossing);along(crossing,end);
  }else along(start,end);
  // An elevated runner root is already the actual destination. An extra
  // floor waypoint at identical X/Z would descend through a port lining.
  if(Math.abs(end-target[2])>1e-8||Math.abs(target[1]-modelDeck(boat,end))*vesselVerticalScale(boat)<.025)add(target[0],end);
  add(target[0],target[2],target[1]);return path;
}
// Exact shared lower/upper landings from the procedural mesh, with separate
// port/starboard flights. Travel follows the ramp instead of snapping deck Y.
export function additionalCrewRoute(s,target,boat,{gunCorridor=false}={}){
  const design=ADDITIONAL_DESIGNS[boat.modelId];if(!design)throw Error('No additional crew route for '+boat.modelId);
  const flights=additionalStairFlights(boat.modelId),path=[],start=s.z,end=target[2];let side=Math.sign(s.x)||Math.sign(target[0])||1;
  const add=(x,y,z)=>{const p=[x,y,z];if(!path.length||distance3(path.at(-1),p)>1e-8)path.push(p);};
  const outer=z=>side*Math.min(gunCorridor?.65:1.12,Math.max(.05,modelDeckWidth(boat,z)-.18));
  const flightHeight=(f,z)=>f.y0+(f.y1-f.y0)*(z-f.z0)/(f.z1-f.z0);
  const height=z=>{const f=flights.find(f=>f.side===side&&z>f.z0&&z<f.z1);return f?flightHeight(f,z):modelDeck(boat,z);};
  const along=(from,to)=>{
    const direction=Math.sign(to-from);if(!direction)return;
    const count=Math.max(1,Math.ceil(Math.abs(to-from)/.30)),stops=[from,to,...Array.from({length:count-1},(_,i)=>from+(to-from)*(i+1)/count),...flights.filter(f=>f.side===side).flatMap(f=>[f.z0,f.z1]).filter(z=>direction>0?z>from&&z<to:z<from&&z>to)].sort((a,b)=>direction*(a-b));
    for(let i=1;i<stops.length;i++){
      const a=stops[i-1],b=stops[i],mid=(a+b)*.5,f=flights.find(f=>f.side===side&&mid>f.z0&&mid<f.z1);
      if(f){add(f.x,flightHeight(f,a),a);add(f.x,flightHeight(f,b),b);}
      else {add(outer(a),modelDeck(boat,a),a);add(outer(b),modelDeck(boat,b),b);}
    }
  };
  add(s.x,s.job?.position?.[1]??modelDeck(boat,start),start);add(outer(start),height(start),start);
  if(target[0]*side<0){
    // Midships crossing avoids the model-owned hatch, mast heels and tiller.
    const crossing=.75;along(start,crossing);side=-side;add(outer(crossing),modelDeck(boat,crossing),crossing);along(crossing,end);
  }else along(start,end);
  add(target[0],target[1],end);return path;
}
export function crewRunnerMetrics(boat,mast,side){
  if(ADDITIONAL_DESIGNS[boat.modelId]||hasExtendedCrewModel(boat.modelId)){
    const model=requirePlayableShipModel(boat.modelId),id=`mast.${model.rig.masts[mast].id}.runner`,rungs=model.nodes[id].motion.rungs;
    const a=resolveShipNode(boat,id,{space:'design',side,step:0}),b=resolveShipNode(boat,id,{space:'design',side,step:rungs});
    const dx=(b[0]-a[0])*boat.beam/3.6,dy=(b[1]-a[1])*vesselVerticalScale(boat),dz=(b[2]-a[2])*boat.length/12;
    return {rungs,dy:dy/rungs,lean:Math.atan2(Math.hypot(dx,dz),dy),yaw:Math.atan2(dx,dz)};
  }
  if(boat.modelId==='victory'){
    const id=`mast.${['fore','main','mizzen'][mast]}.runner`,a=resolveShipNode(boat,id,{space:'design',side,step:0}),b=resolveShipNode(boat,id,{space:'design',side,step:29});
    const dx=(b[0]-a[0])*boat.beam/3.6,dy=(b[1]-a[1])*vesselVerticalScale(boat),dz=(b[2]-a[2])*boat.length/12;
    return {rungs:29,dy:dy/29,lean:Math.atan2(Math.hypot(dx,dz),dy),yaw:Math.atan2(dx,dz)};
  }
  const {rungs,head,feet}=shroudGeometry(mast,side);
  return {rungs,dy:(head[1]-(feet[0][1]+feet[1][1])*.5)*HULL_VERTICAL_SCALE/rungs};
}
function routeTo(s,target,boat){
  if(hasExtendedCrewModel(boat.modelId))return proceduralCrewRoute(s,target,boat);
  if(ADDITIONAL_DESIGNS[boat.modelId])return additionalCrewRoute(s,target,boat);
  if(boat.modelId==='victory')return victoryCrewRoute(s,target,boat);
  // Named corridors stay clear of the hatch, mast heels and aft companionway.
  if(s.id==='maria')return [deckPoint(s.x,target[2],boat),target];
  if(s.id==='rui')return [deckPoint(.55,s.z,boat),deckPoint(.55,-2.25,boat),target];
  if(s.id==='beatriz')return [deckPoint(s.x,-2.65,boat),deckPoint(target[0],-2.65,boat),target];
  if(s.id==='catarina')return [deckPoint(s.x,2.55,boat),deckPoint(target[0],2.55,boat),target];
  return [deckPoint(target[0],s.z,boat),target];
}
// Existing model routes retain their exact stair/ramp elevations. Only blocked
// intermediate waypoints are moved on their own floor, then every connecting
// segment is checked against equipment, including the complete recoil sweep.
function crewWorkNavigationOptions(s,boat){
  const j=s.job;if(!j||!['rig','lookout'].includes(j.kind))return s.navigationBody;
  const root=climbRoot(j.mast,j.side,0,boat),sx=boat.beam/3.6,sz=boat.length/12,sy=vesselVerticalScale(boat),margin=(.30+.03)/sx,
    x=j.side*Math.min(Math.abs(root[0]),Math.max(0,modelDeckWidth(boat,root[2])-margin)),entry=[x,crewDeckHeight(boat,root[2],x),root[2]],
    access={point:physical(root,boat),entry:physical(entry,boat),radius:1.25,mast:j.mast,side:j.side};
  if(boat.modelId==='victory'){
    const key=[boat.length,boat.beam,j.mast,j.side,...root].join('/');
    if(j.navigationAccess?.key===key)return {...s.navigationBody,rigAccess:j.navigationAccess.value};
    const options={...s.navigationBody,rigAccess:access},channelAtRoot=victoryChainwale(j.mast,j.side,root[2]),
      outerAtRoot=[channelAtRoot.outer-j.side*(.30+.025)/sx,channelAtRoot.y,root[2]];
    // Board between actual raised gunport lids, then walk along the rendered
    // channel. Cache this equipment-only access on the job, never per frame.
    for(const offset of[0,.6,-.6,1,-1,1.4,-1.4]){
      const z=root[2]+offset/sz,channel=victoryChainwale(j.mast,j.side,z),
        inboardX=j.side*Math.max(0,modelDeckWidth(boat,z)-margin),floor=crewDeckHeight(boat,z,inboardX),
        outboardX=channel.outer-j.side*(.30+.025)/sx,midY=(floor+channel.y)*.5,
        lead=[[inboardX,floor,z],[inboardX,midY,z],[outboardX,midY,z],[outboardX,channel.y,z],outerAtRoot,root],world=lead.map(p=>physical(p,boat));
      if(world.slice(1).some((p,i)=>!crewNavigationSegmentClear(world[i],p,boat,options)))continue;
      access.entry=world[0];access.lead=world.slice(0,-1);break;
    }
    j.navigationAccess={key,value:access};
  }
  return {...s.navigationBody,rigAccess:access};
}
function crewWorkSegmentClear(s,boat,a,b){
  if(hasExtendedCrewModel(boat.modelId))return true;
  return crewNavigationSegmentClear(physical(a,boat),physical(b,boat),boat,crewWorkNavigationOptions(s,boat));
}
function crewWorkNavigationRoute(s,path,boat,{exactTarget=false,job=s.job}={}){
  if(hasExtendedCrewModel(boat.modelId))return path;
  if(!path?.length)return null;
  const start=s.job?.position?.slice()??[s.x,s.position[1]?(s.position[1]-.028)/vesselVerticalScale(boat):crewDeckHeight(boat,s.z,s.x),s.z],points=[start],options=crewWorkNavigationOptions({...s,job},boat),dense=[];
  const waypoints=path.slice(),access=options?.rigAccess;
  if(access?.entry){
    const scale=[boat.beam/3.6,vesselVerticalScale(boat),boat.length/12],lead=(access.lead??[access.entry]).map(p=>p.map((v,i)=>v/scale[i]));
    if(distance3(physical(waypoints.at(-1),boat),access.point)<1e-6)waypoints.splice(waypoints.length-1,0,...lead);
    else if(distance3(physical(start,boat),access.point)<1e-6){
      while(waypoints.length&&distance3(physical(waypoints[0],boat),access.point)<1e-6)waypoints.shift();
      waypoints.unshift(...lead.slice().reverse());
    }
  }
  let previous=start;
  for(const end of waypoints){
    const a=physical(previous,boat),b=physical(end,boat),distance=Math.hypot(b[0]-a[0],b[2]-a[2]),steps=Math.max(1,Math.ceil(distance/.45)),sy=vesselVerticalScale(boat);
    const ground=Math.abs(previous[1]-crewDeckHeight(boat,previous[2],previous[0]))*sy<.025&&Math.abs(end[1]-crewDeckHeight(boat,end[2],end[0]))*sy<.025;
    // Break gentle sheer into nearby floor edges, while retaining supplied
    // ramp heights and the exact final runner/tool attachment.
    for(let i=1;i<=steps;i++){
      const t=i/steps,p=i===steps?end.slice():previous.map((v,k)=>v+(end[k]-v)*t);
      if(ground&&i<steps){const floor=crewDeckHeight(boat,p[2],p[0]);if(Math.abs(floor-p[1])*sy<.15)p[1]=floor;}
      dense.push(p);
    }
    previous=end;
  }
  for(let i=0;i<dense.length;i++){
    const p=dense[i];
    if(crewNavigationClear(physical(p,boat),boat,options)){points.push(p);continue;}
    if(i<dense.length-1)continue; // route around an obstacle, not through its projected interior samples
    if(exactTarget)return null;
    const clear=crewNavigationStation(p,boat,s.navigationBody);if(!clear)return null;points.push(clear);
  }
  return crewNavigationRoute(points,boat,options);
}
function crewWorkBodiesClear(s,company,boat,path){
  const others=company.crew.filter(o=>o!==s&&o.position);
  for(let i=1;i<path.length;i++){
    const a=physical(path[i-1],boat),b=physical(path[i],boat);a[1]+=.028;b[1]+=.028;
    const ray=b.map((v,k)=>v-a[k]),length2=ray.reduce((sum,v)=>sum+v*v,0);
    if(others.some(o=>{const t=length2?workClamp(ray.reduce((sum,v,k)=>sum+v*(o.position[k]-a[k]),0)/length2,0,1):0;return distance3(o.position,a.map((v,k)=>v+ray[k]*t))<.54-1e-6;}))return false;
  }
  return true;
}
function crewWorkPassingDetour(s,company,boat,p,target){
  if(hasExtendedCrewModel(boat.modelId))return false;
  const j=s.job,from=physical(p,boat),sy=vesselVerticalScale(boat),sx=boat.beam/3.6,sz=boat.length/12;
  // A detour is a horizontal deck walk. Never short-cut a stair or an aloft
  // transition to another floor. Retry only from the existing blocked timer.
  if(Math.abs(p[1]-crewDeckHeight(boat,p[2],p[0]))*sy>.06)return false;
  const neighbours=company.crew.filter(o=>o!==s&&o.position&&Math.abs(o.position[1]-.028-from[1])<.85&&Math.hypot(o.position[0]-from[0],o.position[2]-from[2])<3.5)
    .sort((a,b)=>distance3(a.position,from)-distance3(b.position,from)).slice(0,6);
  if(!neighbours.length)return false;
  const goals=[];
  for(let index=j.cursor;index<Math.min(j.path.length,j.cursor+14);index++){
    const point=j.path[index],world=physical(point,boat),distance=Math.hypot(world[0]-from[0],world[2]-from[2]);
    if(Math.abs(world[1]-from[1])>.12)break;
    if(distance>4)break;
    if(distance>.04&&crewWorkBodiesClear(s,company,boat,[point,point]))goals.push({point,index});
  }
  if(!goals.length)return false;
  // At most 62 vertices: the current position, up to 13 existing waypoints,
  // and eight conservative corners around each of six nearby real bodies.
  const nodes=[p],goalIndices=new Map();
  for(const goal of goals){goalIndices.set(nodes.length,goal.index);nodes.push(goal.point);}
  for(const other of neighbours)for(let k=0;k<8;k++){
    const angle=k*Math.PI/4,x=(other.position[0]+Math.cos(angle)*.61)/sx,z=(other.position[2]+Math.sin(angle)*.61)/sz,
      point=[x,crewDeckHeight(boat,z,x),z];
    if(Math.abs(point[1]*sy-from[1])>.12||!crewWorkSegmentClear(s,boat,point,point)||!crewWorkBodiesClear(s,company,boat,[point,point]))continue;
    nodes.push(point);
  }
  const cost=nodes.map(()=>Infinity),previous=nodes.map(()=>-1),visited=new Set(),edgeCache=new Map();cost[0]=0;
  let finish=-1;
  for(let step=0;step<nodes.length;step++){
    let current=-1;
    for(let i=0;i<nodes.length;i++)if(!visited.has(i)&&(current<0||cost[i]<cost[current]))current=i;
    if(current<0||!Number.isFinite(cost[current]))break;
    if(goalIndices.has(current)){finish=current;break;}
    visited.add(current);
    for(let next=1;next<nodes.length;next++){
      if(visited.has(next))continue;
      const distance=distance3(physical(nodes[current],boat),physical(nodes[next],boat)),candidate=cost[current]+distance;
      if(candidate>=cost[next])continue;
      const key=Math.min(current,next)+'/'+Math.max(current,next);let clear=edgeCache.get(key);
      if(clear===undefined){clear=crewWorkBodiesClear(s,company,boat,[nodes[current],nodes[next]])&&crewWorkSegmentClear(s,boat,nodes[current],nodes[next]);edgeCache.set(key,clear);}
      if(!clear)continue;cost[next]=candidate;previous[next]=current;
    }
  }
  if(finish<0)return false;
  const path=[];for(let index=finish;index>0;index=previous[index])path.push(nodes[index]);path.reverse();
  if(!path.length)return false;
  j.path=[...path,...j.path.slice(goalIndices.get(finish)+1)];j.cursor=0;j.passing=true;j.passingDirection=Math.sign(target[2]-p[2]);j.blockedTime=0;return true;
}
// A stationary off-duty sailor can occupy a legitimate work destination. Ask
// that person to walk to a nearby clear post, retaining their body and floor;
// neither the arriving worker nor the yielding person is moved instantly.
function crewWorkYieldIdle(s,company,boat,p,next){
  if(hasExtendedCrewModel(boat.modelId))return false;
  const wanted=physical(next,boat);wanted[1]+=.028;
  const mayYield=o=>!o.job||(o.job.kind==='gunnery'&&o.job.stage==='working'&&o.job.gun.stage==='ready');
  const blocker=company.crew.filter(o=>o!==s&&mayYield(o)&&o.role!=='Helmsman'&&o.id!=='ines'&&o.position&&distance3(o.position,wanted)<.68).sort((a,b)=>distance3(a.position,wanted)-distance3(b.position,wanted))[0];
  if(!blocker)return false;
  const sx=boat.beam/3.6,sz=boat.length/12,sy=vesselVerticalScale(boat),start=[blocker.x,(blocker.position[1]-.028)/sy,blocker.z],choices=[];
  for(const radius of[.75,1.05])for(const [X,Z]of[[1,0],[-1,0],[0,1],[0,-1],[.707,.707],[-.707,.707],[.707,-.707],[-.707,-.707]]){
    const x=start[0]+X*radius/sx,z=start[2]+Z*radius/sz,target=[x,crewDeckHeight(boat,z,x),z];
    if(Math.abs(target[1]-start[1])*sy>.06||!crewRoutineSegmentClear(blocker,boat,target,target))continue;
    const physicalTarget=physical(target,boat);physicalTarget[1]+=.028;
    if(company.crew.some(o=>o!==blocker&&o.position&&distance3(o.position,physicalTarget)<.70))continue;
    const path=crewWorkNavigationRoute(blocker,[target],boat,{exactTarget:true});if(!path||!crewWorkBodiesClear(blocker,company,boat,path))continue;
    choices.push({target,path,distance:distance3(physicalTarget,wanted)});
  }
  choices.sort((a,b)=>b.distance-a.distance);const choice=choices[0];if(!choice)return false;
  blocker.home??=[blocker.x,blocker.z];
  if(blocker.job){
    const job=blocker.job;job.trafficResume={stage:job.stage,path:job.path.slice(job.cursor),requester:s.id,requesterAt:Array.from(s.position)};
    job.stage='traffic-yield';job.path=choice.path;job.cursor=0;job.elapsed=0;
  }else blocker.job={kind:'yield',stage:'approach',path:choice.path,cursor:0,elapsed:0,rung:0,revision:company.revision,priorHome:blocker.home.slice()};
  blocker.intent='work';blocker.work=0;blocker.decisionIn=0;return true;
}
export function crewGunStation(gun,role,boat){
  const sx=boat.beam/3.6,sz=boat.length/12,sign=gun.sideSign??(gun.side==='port'?-1:1);
  if(boat.modelId==='victory'){
    const scale=[sx,vesselVerticalScale(boat),sz],direction=gun.directionDesign.map((v,i)=>v*scale[i]),n=Math.hypot(...direction);for(let i=0;i<3;i++)direction[i]/=n;
    const offset=Math.max(0,gun.offset??0),muzzle=gun.muzzleDesign.map((v,i)=>v*scale[i]-direction[i]*offset),breech=gun.breechDesign.map((v,i)=>v*scale[i]-direction[i]*offset),progress=workClamp(gun.progress??0,0,1);
    let x;
    if(role==='loader'){
      // The arms work the rammer stroke; the feet follow the gun's travel.
      const stroke=0;
      x=['swab','load','ram'].includes(gun.stage)?muzzle[0]+direction[0]*(.18+stroke):gun.stage==='runout'?(muzzle[0]+direction[0]*.18)*(1-progress)+breech[0]*progress:gun.breechDesign[0]*sx;
      // Stand beside the actual truck envelope, following the real work along
      // the bore as the gun runs out. The feet never enter its recoil corridor.
      const z=gun.station[2]+.126+.31/sz;
      return[x/sx,modelDeck(boat,z),z];
    }
    x=(gun.breechDesign[0]-sign*.10)*sx-sign*(gun.recoilLength+.34);
    const z=gun.station[2]-.13;return[x/sx,modelDeck(boat,z),z];
  }
  if(role==='loader'){
    const x=gun.breechDesign[0]-sign*.15/sx;
    const records=crewNavigationObstacles(boat).filter(o=>o.gunId===gun.id),z=(Math.max(...records.map(o=>o.max[2]))+.32)/sz;
    const edge=modelDeckWidth(boat,z)-.34/sx;
    return [Math.max(-edge,Math.min(edge,x)),modelDeck(boat,z),z];
  }
  const records=crewNavigationObstacles(boat).filter(o=>o.gunId===gun.id),z=(gun.centre?.[2]??gun.muzzleDesign[2])-.25,
    x=(sign<0?Math.max(...records.map(o=>o.max[0]))+.32:Math.min(...records.map(o=>o.min[0]))-.32)/sx;
  return [x,modelDeck(boat,z),z];
}
function crewNinaGunDeckRoute(s,target,boat){
  const path=[],add=p=>{if(!path.length||distance3(path.at(-1),p)>1e-8)path.push(p);};
  const start=s.job?.position?.slice()??[s.x,(s.position[1]-.028)/vesselVerticalScale(boat),s.z],floor=modelDeck(boat,1.5),high=2.3,upperZ=2.74,
    stair=i=>[.96,floor+(high-floor)*i/8,1.5+1.14*i/8],endHigh=target[1]>1.5,onStairs=start[2]>=1.5&&start[2]<=2.64+.0001&&start[1]>modelDeck(boat,start[2])+.1;
  let isHigh=start[1]>1.5;add(start);
  if(onStairs){
    const step=workClamp((start[2]-1.5)/1.14*8,0,8);
    if(endHigh){for(let i=Math.ceil(step);i<=8;i++)add(stair(i));add([.96,high,upperZ]);isHigh=true;}
    else{for(let i=Math.floor(step);i>=0;i--)add(stair(i));isHigh=false;}
  }
  if(!isHigh&&endHigh){
    add([.96,floor,1.5]);for(let i=1;i<=8;i++)add(stair(i));add([.96,high,upperZ]);
    add([0,high,upperZ]);add([0,high,target[2]]);
  }else if(isHigh&&!endHigh){
    add([0,high,start[2]]);add([0,high,upperZ]);add([.96,high,upperZ]);add(stair(8));
    for(let i=7;i>=0;i--)add(stair(i));add([target[0],modelDeck(boat,1.5),1.5]);
  }else if(endHigh){
    add([0,high,path.at(-1)[2]]);add([0,high,target[2]]);
  }else add([target[0],modelDeck(boat,start[2]),start[2]]);
  add(target);return path;
}
function gunCrewRoute(s,target,boat){
  if(ADDITIONAL_DESIGNS[boat.modelId])return additionalCrewRoute(s,target,boat,{gunCorridor:true});
  if(boat.modelId==='victory')return victoryCrewRoute(s,target,boat,{gunCorridor:true});
  return crewNinaGunDeckRoute(s,target,boat);
}
function assignGunCrew(company,boat){
  const guns=boat.gunnery?.guns;
  if(!guns)return;
  const weather=guns.filter(g=>g.weatherDeck),limit=boat.modelId==='victory'?4:2;
  const selected=new Set();
  for(const side of['port','starboard'])for(const gun of weather.filter(g=>g.side===side).slice(0,limit))selected.add(gun.id);
  for(const gun of weather)gun.visibleCrew=selected.has(gun.id);
  const targets=guns.filter(g=>selected.has(g.id)&&g.side===boat.gunnerySide);
  const active=targets.some(g=>g.loading||g.stage==='ready'||g.queued||g.stage==='recoil');company.gunneryActive=active||company.crew.some(s=>s.job?.kind==='gunnery');
  for(const s of company.crew){
    const j=s.job;
    if(j?.kind==='gunnery'&&!['return','waiting-return'].includes(j.stage)&&(!active||j.gun.side!==boat.gunnerySide))startReturn(s,boat,company);
    // An aloft worker climbs down normally; there is no cannon-station teleport.
    if(active&&j&&(j.kind==='rig'||j.kind==='lookout')&&['ascending','working'].includes(j.stage))crewWorkDescend(s);
    else if(active&&j&&['haul','hatch'].includes(j.kind)&&j.stage!=='return')startReturn(s,boat,company);
  }
  if(!active)return;
  const available=company.crew.filter(s=>!['ines','pedro'].includes(s.id)&&!s.job);
  const routeKey=[boat.modelId,boat.length,boat.beam,company.revision,boat.gunnerySide].join('/');
  if(company.gunNavigationKey!==routeKey){company.gunNavigationKey=routeKey;company.gunNavigationRetry=new Map();}
  for(const gun of targets)for(const role of['loader','tackle']){
    if(company.crew.some(s=>s.job?.kind==='gunnery'&&s.job.stage!=='return'&&s.job.gun.id===gun.id&&s.job.gunRole===role))continue;
    const key=gun.id+'/'+role;if((company.gunNavigationRetry.get(key)??0)>company.workTime)continue;
    const target=crewGunStation(gun,role,boat),point=physical(target,boat);
    available.sort((a,b)=>distance3(a.position,point)-distance3(b.position,point));
    let sailor,path;
    for(const candidate of available){const route=crewWorkNavigationRoute(candidate,gunCrewRoute(candidate,target,boat),boat,{exactTarget:true});if(route){sailor=candidate;path=route;break;}}
    if(!sailor){company.gunNavigationRetry.set(key,company.workTime+1);continue;}
    available.splice(available.indexOf(sailor),1);company.gunNavigationRetry.delete(key);
    sailor.home??=[sailor.x,sailor.z];
    sailor.job={kind:'gunnery',gun,gunRole:role,stage:'approach',elapsed:0,rung:0,revision:company.revision,path,cursor:0};
    sailor.intent='work';sailor.work=0;
  }
}
export function updateCrewGunneryAttendance(company,boat){
  boat.gunneryAttendance??=new Set();boat.gunneryAttendance.clear();
  if(!boat.gunnery)return;
  for(const gun of boat.gunnery.guns.filter(g=>g.visibleCrew&&g.side===boat.gunnerySide)){
    const hands=company.crew.filter(s=>s.job?.kind==='gunnery'&&s.job.gun.id===gun.id&&s.job.stage==='working'&&s.intent==='work'&&!s.observation.hazard&&
      distance3(physical(crewGunStation(gun,s.job.gunRole,boat),boat),[s.position[0],s.position[1]-.028,s.position[2]])<.035&&crewNavigationClear([s.position[0],s.position[1]-.028,s.position[2]],boat,s.navigationBody));
    if(hands.some(s=>s.job.gunRole==='loader')&&hands.some(s=>s.job.gunRole==='tackle'))boat.gunneryAttendance.add(gun.id);
  }
}
// Boat-local metre targets shared by actual hand IK and the visible tool mesh.
export function crewGunneryTool(s,boat){
  const j=s.job;if(j?.kind!=='gunnery'||j.stage!=='working'||s.intent!=='work')return null;
  const gun=j.gun,stage=gun.stage,scale=[boat.beam/3.6,vesselVerticalScale(boat),boat.length/12];
  const direction=gun.directionDesign.map((v,i)=>v*scale[i]),n=Math.hypot(...direction);for(let i=0;i<3;i++)direction[i]/=n;
  const muzzle=gun.muzzleDesign.map((v,i)=>v*scale[i]-direction[i]*gun.offset);
  const along=(distance,base=muzzle)=>base.map((v,i)=>v+direction[i]*distance);
  if(j.gunRole==='loader'&&['swab','load','ram'].includes(stage)){
    if(gun.kind==='swivel'){
      const breech=gun.breechDesign.map((v,i)=>v*scale[i]-direction[i]*gun.offset);
      return {kind:'chamber',a:along(-.12,breech),b:along(.12,breech),hands:[breech.map((v,i)=>v+(i===2?.09:0)),breech.map((v,i)=>v-(i===2?.09:0))]};
    }
    const stroke=Math.sin((gun.progress??0)*Math.PI*4)*.10,grip=along(.10+stroke);
    return {kind:stage==='swab'?'sponge':'rammer',a:along(.72+stroke),b:along(-.6+stroke),hands:[grip,along(.26+stroke)]};
  }
  if(j.gunRole==='loader'&&stage==='prime'){
    const breech=gun.breechDesign.map((v,i)=>v*scale[i]-direction[i]*gun.offset);breech[1]+=.10;
    return {kind:'prime',hands:[breech,breech.map((v,i)=>v+(i===2?.12:0))]};
  }
  if(j.gunRole==='tackle'&&['swab','load','ram','runout'].includes(stage)){
    const sign=gun.sideSign??Math.sign(gun.directionDesign[0]),pull=stage==='runout'?Math.sin((gun.progress??0)*Math.PI*6)*.07:0;
    const hands=[-.10,.10].map(z=>[s.position[0]+sign*(.32+pull),s.position[1]+1.03,s.position[2]+z]);
    const breech=gun.breechDesign.map((v,i)=>v*scale[i]-direction[i]*gun.offset);breech[2]-=.22;
    return {kind:'tackle',a:breech,b:hands[1],hands};
  }
  return null;
}
// A bounded deck graph follows the authored floor and stair openings. Only new
// models use it; the qualified four-ship routes keep their original geometry.
export function proceduralCrewRoute(s,target,boat,company=null){
  const d=proceduralDesign(boat.modelId),sx=boat.beam/d.frame.beam,sy=d.frame.verticalScale,sz=boat.length/d.frame.length,flights=crewExtendedFlights(d.id);
  const rowingBody=Object.hasOwn(ROWING_DESIGNS,d.id),bodies=company?.crew.filter(other=>other!==s&&other.position)??[];
  const pitch=.32,margin=d.cockpit?.22:.27,lo=d.profile.stations[0]*sz+.28,hi=d.profile.stations.at(-1)*sz-.28,columns=Math.ceil(boat.beam/pitch);
  // Narrow yacht side decks may lie between regular grid columns. Include the
  // actual centre of each authored cabin/walkway gap, without shrinking people.
  const xColumns=[...Array.from({length:columns+1},(_,i)=>-boat.beam/2+i*boat.beam/columns),...flights.map(f=>f.x*sx)];
  if(rowingBody){
    xColumns.push(0,s.x*sx,target[0]*sx);
    for(const m of d.masts??[])for(const side of[-1,1])xColumns.push(side*((m.radius??0)*sx+.272));
  }
  if(d.cockpit)for(const side of[-1,1])xColumns.push(side*Math.max(0,d.cockpit.halfWidth*sx-margin-.02));
  for(const b of d.structures??[])for(const side of [-1,1]){
    const edge=(b.centre[0]+side*b.size[0]/2)*sx,outside=side*proceduralDeckWidth(d.id,b.centre[2])*sx;
    xColumns.push((edge+outside)*.5);
  }
  xColumns.sort((a,b)=>a-b);
  if(rowingBody)for(let i=xColumns.length-1;i>0;i--)if(Math.abs(xColumns[i]-xColumns[i-1])<1e-8)xColumns.splice(i,1);
  const zRows=Array.from({length:Math.ceil((hi-lo)/pitch)+1},(_,i)=>lo+i*(hi-lo)/Math.ceil((hi-lo)/pitch));
  if(rowingBody){
    const benches=rowingBenchDescriptors(d.id);
    for(let i=1;i<benches.length;i++)zRows.push((benches[i-1].z+benches[i].z)*sz*.5);
    zRows.push(s.z*sz,target[2]*sz);
    for(const m of d.masts??[])zRows.push(m.z*sz);
    zRows.sort((a,b)=>a-b);
    for(let i=zRows.length-1;i>0;i--)if(Math.abs(zRows[i]-zRows[i-1])<1e-8)zRows.splice(i,1);
  }
  const nx=xColumns.length-1,nz=zRows.length-1,width=nx+1;
  const floor=(x,z)=>{const f=flights.find(f=>Math.abs(x-f.x)<=f.width/2&&z>=f.z0&&z<=f.z1);return f?f.y0+(f.y1-f.y0)*(z-f.z0)/(f.z1-f.z0):proceduralDeck(d.id,z,x);};
  const start=s.job?.position??[s.x,crewDeckHeight(boat,s.z,s.x),s.z],points=new Map();
  const make=(i,j)=>{
    if(i<0||i>nx||j<0||j>nz)return null;const key=j*width+i;if(points.has(key))return points.get(key);
    const x=xColumns[i]/sx,z=zRows[j]/sz,y=floor(x,z),p=[x,y,z],world=physical(p,boat);
    let clear=Math.abs(x)+margin/sx<proceduralDeckWidth(d.id,z);
    const c=d.cockpit;
    if(clear&&c){
      const entry=flights.some(f=>f.zoneId==='cockpit'&&Math.abs(x-f.x)<=f.width/2-margin/sx&&z>=f.z0-margin/sz&&z<=f.z1+margin/sz);
      const sideWall=Math.abs(Math.abs(x)-c.halfWidth)*sx<margin&&z>=c.bounds[0]-margin/sz&&z<=c.bounds[1]+margin/sz;
      const endWall=Math.min(Math.abs(z-c.bounds[0]),Math.abs(z-c.bounds[1]))*sz<margin&&Math.abs(x)<c.halfWidth+margin/sx;
      if(sideWall||(endWall&&!entry))clear=false;
    }
    if(clear)for(const m of d.masts??[])if(Math.hypot(x*sx,(z-m.z)*sz)<(m.radius??0)*sx+.27){clear=false;break;}
    if(clear)for(const b of d.structures??[])if(Math.abs(x-b.centre[0])<b.size[0]/2+margin/sx&&Math.abs(z-b.centre[2])<b.size[2]/2+margin/sz&&y<b.centre[1]+b.size[1]/2+.02){clear=false;break;}
    const h=d.hatch;
    if(clear&&h&&Math.abs(x-h.centre[0])<h.size[0]/2+.22/sx&&Math.abs(z-h.centre[2])<h.size[2]/2+.22/sz)clear=false;
    if(clear&&company)for(const other of bodies)if(distance3(rowingBody?[world[0],world[1]+.028,world[2]]:world,other.position)<(rowingBody?.58:.50)&&distance3(world,physical(start,boat))>.48){clear=false;break;}
    const result=clear?{key,i,j,p,world}:null;points.set(key,result);return result;
  };
  const nearest=p=>{
    let I=0;for(let i=1;i<xColumns.length;i++)if(Math.abs(xColumns[i]-p[0]*sx)<Math.abs(xColumns[I]-p[0]*sx))I=i;
    let J=rowingBody?0:Math.round((p[2]*sz-lo)/(hi-lo)*nz);if(rowingBody)for(let j=1;j<zRows.length;j++)if(Math.abs(zRows[j]-p[2]*sz)<Math.abs(zRows[J]-p[2]*sz))J=j;
    let best=null,cost=Infinity;
    for(let radius=0;radius<=3;radius++)for(let j=J-radius;j<=J+radius;j++)for(let i=I-radius;i<=I+radius;i++){
      const node=make(i,j);if(!node)continue;const delta=distance3(node.world,physical(p,boat));if(delta<cost){best=node;cost=delta;}
    }
    return best;
  };
  const a=nearest(start),b=nearest(target);if(!a||!b)return null;
  const heap=[],push=item=>{heap.push(item);let i=heap.length-1;while(i){const p=(i-1)>>1;if(heap[p].cost<=item.cost)break;heap[i]=heap[p];i=p;}heap[i]=item;};
  const pop=()=>{const first=heap[0],last=heap.pop();if(heap.length){let i=0;while(i*2+1<heap.length){let c=i*2+1;if(c+1<heap.length&&heap[c+1].cost<heap[c].cost)c++;if(heap[c].cost>=last.cost)break;heap[i]=heap[c];i=c;}heap[i]=last;}return first;};
  const costs=new Map([[a.key,0]]),parents=new Map(),closed=new Set();push({node:a,cost:distance3(a.world,b.world)});let found=false;
  while(heap.length&&closed.size<18000){
    const {node}=pop();if(closed.has(node.key))continue;closed.add(node.key);if(node.key===b.key){found=true;break;}
    for(const [di,dj]of [[-1,0],[1,0],[0,-1],[0,1],[-1,-1],[-1,1],[1,-1],[1,1]]){
      const next=make(node.i+di,node.j+dj);if(!next||closed.has(next.key))continue;
      const mid=node.p.map((v,i)=>(v+next.p[i])*.5),onStair=flights.some(f=>Math.abs(mid[0]-f.x)<=f.width/2&&mid[2]>=f.z0&&mid[2]<=f.z1);
      if(Math.abs(next.world[1]-node.world[1])>(onStair?.65:.24))continue;
      if(di&&dj&&(!make(node.i+di,node.j)||!make(node.i,node.j+dj)))continue;
      if(rowingBody&&bodies.length){
        const a=node.world.map((v,i)=>v+(i===1?.028:0)),b=next.world.map((v,i)=>v+(i===1?.028:0)),delta=b.map((v,i)=>v-a[i]),length2=delta.reduce((n,v)=>n+v*v,0);
        if(bodies.some(other=>{const t=workClamp(delta.reduce((n,v,i)=>n+v*(other.position[i]-a[i]),0)/Math.max(length2,1e-9),0,1),gap=distance3(a.map((v,i)=>v+delta[i]*t),other.position);return gap<.55&&gap<distance3(a,other.position)-1e-7;}))continue;
      }
      const cost=costs.get(node.key)+distance3(node.world,next.world);if(cost>=(costs.get(next.key)??Infinity))continue;
      costs.set(next.key,cost);parents.set(next.key,node.key);push({node:next,cost:cost+distance3(next.world,b.world)});
    }
  }
  if(!found)return null;const path=[];let key=b.key;
  while(key!==undefined){path.push(points.get(key).p);key=parents.get(key);}path.reverse();
  return [[...start],...path,[...target]];
}
function crewProceduralTask(company,boat,s,job,target){
  const retries=company.routeRetries??=new Map(),key=s.id+'/'+job.kind+'/'+(job.control??''),at=company.workTime??0,geometry=boat.modelId+'/'+boat.length+'/'+boat.beam,retry=retries.get(key);
  if(retry&&retry.revision===company.revision&&retry.geometry===geometry&&at<retry.nextAt&&Math.hypot((s.x-retry.x)*boat.beam/3.6,(s.z-retry.z)*boat.length/12)<.25)return false;
  company.routeAttempts=(company.routeAttempts??0)+1;
  const path=proceduralCrewRoute(s,target,boat,company);
  if(!path){retries.set(key,{revision:company.revision,geometry,nextAt:at+1,x:s.x,z:s.z});return false;}
  retries.delete(key);
  s.home??=[s.x,s.z];s.job={...job,stage:'approach',elapsed:0,rung:0,revision:company.revision,path,cursor:0};s.intent='work';s.work=0;return true;
}
function assignProceduralCrewWork(company,boat){
  const d=proceduralDesign(boat.modelId),context=crewExtendedContext(d.id),model=requirePlayableShipModel(d.id),sails=sailingState(boat),solo=company.crew.length===1;
  const controls=crewWorkControls.map((name,index)=>({name,index,surfaces:d.surfaces.filter(s=>s.controlGroup===name)})).filter(c=>c.surfaces.length);
  boat.crewSailRate??=new Float64Array(3);boat.crewRigRate??=new Float64Array(3);boat.crewSailRate.fill(0);boat.crewRigRate.fill(0);
  // A helmsman stays with the steering blade on crewed craft. A solo sailor can
  // secure the tiller, do one deck job, then physically return to her helm.
  const free=()=>company.crew.filter(s=>!s.job&&(solo||s.role!=='Helmsman')).sort((a,b)=>Number(!!a.stationId)-Number(!!b.stationId));
  if(company.order==='weather'&&(boat.hatchesClosed??0)<.999&&model.nodes['station.hatch']&&!company.crew.some(s=>s.job?.kind==='hatch')){
    const target=resolveShipNode(boat,'station.hatch',{space:'design'});
    for(const s of free())if(crewProceduralTask(company,boat,s,{kind:'hatch'},target))break;
  }
  for(const control of controls){
    if(Math.abs((boat[SAIL_KEYS[control.index]]??1)-sails.set[control.index])<=1e-6)continue;
    const station=context.controlStations?.[control.name];if(!station)continue;
    const mast=station.mast??control.surfaces[0].mast,runner='mast.'+crewMastName(boat,mast)+'.runner';
    const climbing=!solo&&control.surfaces.some(s=>s.kind==='square')&&(model.nodes[runner]?.motion?.rungs??0)>0;
    for(const kind of climbing?['haul','rig']:['haul']){
      if(company.crew.some(s=>s.job?.control===control.index&&s.job.kind===kind))continue;
      const side=1,target=kind==='haul'?station.position:climbRoot(mast,side,0,boat);
      for(const s of free())if(crewProceduralTask(company,boat,s,{kind,control:control.index,mast,side,controlGroup:control.name},target))break;
    }
    const ready=company.crew.filter(s=>s.job?.control===control.index&&s.job.stage==='working'&&s.intent==='work'&&!s.observation.hazard);
    const hauling=ready.some(s=>s.job.kind==='haul');boat.crewRigRate[control.index]=Number(hauling);boat.crewSailRate[control.index]=Number(hauling&&(!climbing||ready.some(s=>s.job.kind==='rig')));
  }
  updateCrewRowingAttendance(company,boat);
}
export function assignCrewWork(company,boat) {
  if(hasExtendedCrewModel(boat.modelId)){assignProceduralCrewWork(company,boat);return;}
  const sails=sailingState(boat),needs=SAIL_KEYS.map((key,i)=>Math.abs((boat[key]??1)-sails.set[i])>.008);
  company.workTime??=0;
  assignGunCrew(company,boat);
  for(const s of company.crew){
    s.home??=[s.x,s.z];
    if(s.job)continue;
    if(company.gunneryActive)continue;
    let job;
    if(CLIMBERS[s.id] && needs[CLIMBERS[s.id][0]] && !sails.maneuver){
      const [mast]=CLIMBERS[s.id],side=boat.modelId==='victory'||ADDITIONAL_DESIGNS[boat.modelId]?Math.sign(s.x)||-1:-Math.sign(sails.rig[mast].side);job={kind:'rig',mast,side};
    }else if(HANDS[s.id]!==undefined && (needs[HANDS[s.id]] || sails.maneuver)){
      job={kind:'haul',mast:HANDS[s.id]};
    }else if(s.id==='rui' && company.order==='weather' && (boat.hatchesClosed??0)<.999){
      job={kind:'hatch'};
    }else if(s.id==='maria' && !sails.maneuver && company.order==='watch' && company.workTime>(s.nextWatch??12)){
      job={kind:'lookout',mast:ADDITIONAL_DESIGNS[boat.modelId]?.lookout?.mast??0,side:boat.modelId==='victory'||ADDITIONAL_DESIGNS[boat.modelId]?Math.sign(s.x)||-1:-Math.sign(sails.rig[0].side)};
    }
    if(!job)continue;
    job.stage='approach';job.elapsed=0;job.rung=0;job.revision=company.revision;
    const target=job.kind==='hatch'?resolveShipNode(boat,'station.hatch',{space:'design'})
      :job.kind==='haul'?haulStation(job.mast,boat)
      :climbRoot(job.mast,job.side,0,boat);
    if((s.navigationRetryAt??0)>company.workTime)continue;
    job.path=crewWorkNavigationRoute(s,routeTo(s,target,boat),boat,{exactTarget:job.kind==='rig'||job.kind==='lookout',job});
    if(!job.path){s.navigationRetryAt=company.workTime+1;continue;}
    job.cursor=0;s.job=job;s.intent='work';s.work=0;
  }
  // Crew attendance gates the actual canvas integrator, even when rendered crew
  // are hidden. Manual sliders still request jobs; no instant magical sail changes.
  boat.crewRigRate??=new Float64Array(3);boat.crewRigRate.fill(0);
  const aloft=company.crew.some(s=>s.job?.rung>0);
  boat.crewSailRate??=new Float64Array(3);boat.crewSailRate.fill(0);
  for(let mast=0;mast<3;mast++){
    const surfaces=ADDITIONAL_DESIGNS[boat.modelId]?.surfaces.filter(s=>s.controlGroup===['fore','main','mizzen'][mast]);
    if(surfaces&&!surfaces.length)continue;
    const ready=company.crew.filter(s=>s.job?.mast===mast && s.job.stage==='working' && !s.observation.hazard);
    boat.crewRigRate[mast]=Number(!aloft && ready.some(s=>s.job.kind==='haul'));
    boat.crewSailRate[mast]=mast===2?Number(ready.some(s=>s.job.kind==='haul'))
      :Number(ready.some(s=>s.job.kind==='haul') && ready.some(s=>s.job.kind==='rig'));
  }
}
export function stepCrewWork(s,company,boat,dt) {
  const j=s.job;if(!j)return false;
  if(boat.sailState?.maneuver && (j.kind==='rig'||j.kind==='lookout') && ['ascending','working'].includes(j.stage))crewWorkDescend(s);
  dt=workClamp(Number.isFinite(dt)?dt:0,0,.1);s.time+=dt;
  const o=s.observation;
  o.hazard=crewDeckHazard(boat,o.wind,s.intent==='brace');
  o.job=j.kind;o.stage=j.stage;o.order='work';
  s.decisionIn-=dt;
  if(o.hazard||s.decisionIn<=0){
    let choice;try{choice=s.policy(o);}catch{choice='work';}
    s.intent=o.hazard||choice==='brace'?'brace':choice==='standby'?'standby':'work';s.decisionIn=.5;
  }
  const active=s.intent==='work';let moving=false;
  if(!hasExtendedCrewModel(boat.modelId))s.visible=boat.beam>=3.2&&boat.length>=10.5;
  if(active){
    j.elapsed+=dt;
    if(j.kind==='gunnery'&&j.stage==='working'){
      const goal=crewGunStation(j.gun,j.gunRole,boat),from=j.position??[s.x,crewDeckHeight(boat,s.z,s.x),s.z];
      if(distance3(physical(goal,boat),physical(from,boat))>.025){
        const path=crewWorkNavigationRoute(s,[from,goal],boat,{exactTarget:true});
        j.path=path??[];j.cursor=0;j.stage=path?'reposition':'waiting-gun';j.elapsed=0;
      }
    }
    if(j.stage==='waiting-gun'&&j.elapsed>.5){
      const goal=crewGunStation(j.gun,j.gunRole,boat),path=crewWorkNavigationRoute(s,[goal],boat,{exactTarget:true});j.elapsed=0;
      if(path){j.path=path;j.cursor=0;j.stage='reposition';}
    }
    if(j.stage==='traffic-hold'){
      const resume=j.trafficResume,requester=company.crew.find(o=>o.id===resume?.requester);
      if(resume&&j.elapsed>.5&&(!requester?.job||(distance3(requester.position,resume.requesterAt)>.85&&distance3(s.position,requester.position)>1.3))){
        j.elapsed=0;
        const target=j.kind==='gunnery'?crewGunStation(j.gun,j.gunRole,boat):resume.path.at(-1),
          route=target&&crewWorkNavigationRoute(s,j.kind==='gunnery'?gunCrewRoute(s,target,boat):resume.path,boat,{exactTarget:true});
        if(route){j.path=route;j.cursor=0;j.stage=resume.stage==='working'?'reposition':resume.stage;j.elapsed=0;delete j.trafficResume;}
      }
    }
    if(['approach','return','reposition','lookout-approach','lookout-return','traffic-yield'].includes(j.stage)){
      let p=j.position??[s.x,s.position[1]? (s.position[1]-.028)/vesselVerticalScale(boat):crewDeckHeight(boat,s.z,s.x),s.z];
      const target=j.path[j.cursor],a=physical(p,boat),b=physical(target,boat),d=distance3(a,b);
      const horizontal=Math.hypot(b[0]-a[0],b[2]-a[2]);
      const motion=crewMotionPolicy(boat,{purpose:'work',grade:horizontal>1e-8?(b[1]-a[1])/horizontal:0,hazard:o.hazard});
      const travel=Math.min(d,motion.speedMetresPerSecond*dt),q=d>1e-6?travel/d:1;
      const next=p.map((x,i)=>x+(target[i]-x)*q),world=physical(next,boat);
      // Yield locally to another body rather than walking through it.
      const occupied=company.crew.some(other=>other!==s&&other.position&&Math.hypot(world[0]-other.position[0],world[1]+.028-other.position[1],world[2]-other.position[2])<.54);
      const clear=crewWorkSegmentClear(s,boat,p,next);
      if(clear&&!occupied){
        const walking=crewRowingWalkState(s,boat);if(walking)walking.distance=Math.min(walking.length,walking.distance+Math.hypot(world[0]-a[0],world[2]-a[2]));
        j.position=next;s.x=next[0];s.z=next[2];moving=travel>0;crewAdvanceWalk(s,travel,{strideMetres:motion.strideMetres});
        if(d>.01)s.yaw=Math.atan2(b[0]-a[0],b[2]-a[2]);
        if(d-travel<=1e-8){j.cursor++;if(j.passing&&j.cursor>=4){j.passing=false;j.passingDirection=0;}if(j.cursor>=j.path.length){
          if(j.stage==='traffic-yield'){j.stage='traffic-hold';j.elapsed=0;}
          else if(j.stage==='return'){s.job=null;s.home=[next[0],next[2]];s.wait=2;return false;}
          if(j.kind==='yield'){
            const shift=next[2]-j.priorHome[1];s.home=[next[0],next[2]];s.patrolX=next[0];s.route=s.route.map(z=>z+shift);s.target=s.route[1];s.navigationPath=null;s.navigationKey=null;s.job=null;s.wait=2;return false;
          }
          if(j.stage==='traffic-hold'){}
          else if(j.stage==='lookout-return')j.stage='descending';
          else if(j.stage==='lookout-approach'){j.stage='working';j.lookoutAtStation=true;}
          else j.stage=(j.kind==='rig'||j.kind==='lookout')?'ascending':'working';j.elapsed=0;
        }}
        j.blockedTime=0;
      }else{
        j.blockedTime=(j.blockedTime??0)+dt;
        if(j.blockedTime>.5){
          if(Object.hasOwn(ROWING_DESIGNS,boat.modelId)){
            const path=proceduralCrewRoute(s,j.path.at(-1),boat,company);if(path){j.path=path;j.cursor=0;}
          }else if(!hasExtendedCrewModel(boat.modelId)){
            let repaired=false;
            if(!clear){const path=crewWorkNavigationRoute(s,j.path.slice(j.cursor),boat,{exactTarget:['rig','lookout','gunnery'].includes(j.kind)});if(path){j.path=path;j.cursor=0;repaired=true;}}
            if(!repaired&&!crewWorkPassingDetour(s,company,boat,p,target)&&!crewWorkYieldIdle(s,company,boat,p,next)&&ADDITIONAL_DESIGNS[boat.modelId]&&j.kind!=='gunnery')crewAdditionalPassingDetour(s,company,boat,p,target);
          }
          j.blockedTime=0;
        }
      }
    }else if(j.stage==='ascending'||j.stage==='descending'){
      const {rungs,dy}=crewRunnerMetrics(boat,j.mast,j.side);
      // Stop below the working top, leaving overhead handholds within reach.
      const clearance=1.6+(boat.modelId==='victory'?.25*vesselVerticalScale(boat):0);
      j.top=Math.max(0,Math.floor(rungs-clearance/dy));
      const lookout=ADDITIONAL_DESIGNS[boat.modelId]?.lookout;
      if(j.kind==='lookout'&&lookout&&lookout.mast===j.mast){
        const root=resolveShipNode(boat,`mast.${['fore','main','mizzen'][j.mast]}.runner`,{space:'design',side:j.side,step:0});
        j.top=Math.min(rungs,Math.max(0,((lookout.height-root[1])*vesselVerticalScale(boat)+.12)/dy));
      }
      const direction=j.stage==='ascending'?1:-1;
      j.rung=workClamp(j.rung+direction*.38*dt/dy,0,j.top);
      j.position=climbRoot(j.mast,j.side,j.rung,boat);s.x=j.position[0];s.z=j.position[2];s.yaw=-j.side*Math.PI/2;
      if(j.stage==='ascending'&&j.rung>=j.top){
        j.stage='working';j.elapsed=0;
        if(j.kind==='lookout'&&lookout&&lookout.mast===j.mast){
          const p=resolveShipNode(boat,'lookout.'+['fore','main','mizzen'][j.mast],{space:'design'});p[0]+=j.side*.20;
          j.lookoutEntry=[...j.position];j.stage='lookout-approach';j.path=[p];j.cursor=0;
        }
      }
      if(j.stage==='descending'&&j.rung<=0)startReturn(s,boat,company);
    }else if(j.stage==='working'&&j.kind==='gunnery'){
      s.yaw=(j.gun.sideSign??Math.sign(j.gun.directionDesign[0]))*Math.PI/2;
      const tool=crewGunneryTool(s,boat);
      if(tool?.hands){const target=tool.hands[0].map((v,i)=>(v+tool.hands[1][i])*.5);s.yaw=Math.atan2(target[0]-s.position[0],target[2]-s.position[2]);}
    }else if(j.stage==='working'){
      s.yaw=j.kind==='hatch'?(boat.modelId==='victory'?-Math.PI/2:Math.PI):j.kind==='haul'?Math.sign(s.x)*Math.PI/2:-j.side*Math.PI/2;
      if(j.kind==='hatch')boat.hatchesClosed=workClamp((boat.hatchesClosed??0)+dt/8,0,1);
      if(j.kind==='lookout'){company.lookoutHeight=s.position[1]+1.65;}
      const done=j.kind==='hatch'?(boat.hatchesClosed??0)>=1:j.kind==='lookout'?j.elapsed>18||company.order!=='watch'
        :!sailingState(boat).maneuver && Math.abs((boat[SAIL_KEYS[j.control??j.mast]]??1)-sailingState(boat).set[j.control??j.mast])<(hasExtendedCrewModel(boat.modelId)?1e-6:.008);
      if(done){if(j.kind==='rig'||j.kind==='lookout'){crewWorkDescend(s);s.nextWatch=company.workTime+45;}
        else startReturn(s,boat,company);}
    }else if(j.stage==='waiting-return'&&j.elapsed>.5){startReturn(s,boat,company);
    }
    // A replaced order never teleports an aloft sailor; they finish/descend safely.
    if(j.kind==='lookout'&&company.order!=='watch'&&j.stage==='ascending')crewWorkDescend(s);
  }
  const blend=1-Math.exp(-dt*8);s.walk+=(Number(moving)-s.walk)*blend;
  s.brace+=(Number(s.intent==='brace')-s.brace)*blend;
  s.work+=(Number(active&&j.stage==='working')-s.work)*blend;
  const p=j.position??[s.x,crewDeckHeight(boat,s.z,s.x),s.z];s.position.set(physical(p,boat));s.position[1]+=.028;
  if(j.kind==='gunnery'&&j.stage==='working'){
    const tool=crewGunneryTool(s,boat);
    if(tool?.hands){const target=tool.hands[0].map((v,i)=>(v+tool.hands[1][i])*.5);s.yaw=Math.atan2(target[0]-s.position[0],target[2]-s.position[2]);}
  }
  if(hasExtendedCrewModel(boat.modelId)&&j.stage==='working'){
    // Approach can enter this stage in the current step. Face the real work
    // before composing its transform, rather than inheriting the last path edge.
    if(j.kind==='haul'){
      const lead=crewExtendedContext(boat.modelId).controlStations?.[j.controlGroup]?.lead;
      if(lead)s.yaw=Math.atan2((lead[0]-s.x)*boat.beam/3.6,(lead[2]-s.z)*boat.length/12);
    }else if(j.kind==='hatch'&&requirePlayableShipModel(boat.modelId).nodes['hatch.grip']){
      const grip=resolveShipNode(boat,'hatch.grip');s.yaw=Math.atan2(grip[0]-s.position[0],grip[2]-s.position[2]);
    }
  }
  s.climbPitch=0;
  if((boat.modelId==='victory'||ADDITIONAL_DESIGNS[boat.modelId]||hasExtendedCrewModel(boat.modelId))&&j.rung>0&&!j.lookoutAtStation){
    const runner=crewRunnerMetrics(boat,j.mast,j.side);s.climbPitch=runner.lean;s.yaw=runner.yaw;
  }else if(boat.modelId==='victory'&&j.kind==='haul'&&j.stage==='working')s.climbPitch=.16;
  else if(hasExtendedCrewModel(boat.modelId)&&proceduralDesign(boat.modelId).cockpit&&j.kind==='hatch'&&j.stage==='working'&&active)s.climbPitch=.36*(1-(boat.hatchesClosed??0));
  const sy=Math.sin(s.yaw/2),cy=Math.cos(s.yaw/2),sx=Math.sin(s.climbPitch/2),cx=Math.cos(s.climbPitch/2);
  s.rotation.set([cy*sx,sy*cx,-sy*sx,cy*cx]);gltfTRS(s.transform,s.position,s.rotation,s.scale);
  return true;
}
function startReturn(s,boat,company=null){
  const j=s.job;delete j.trafficResume;j.stage='return';j.elapsed=0;j.cursor=0;
  const home=homePoint(s,boat);
  if(hasExtendedCrewModel(boat.modelId)){j.path=proceduralCrewRoute(s,home,boat,Object.hasOwn(ROWING_DESIGNS,boat.modelId)?company:null);if(!j.path){j.path=[];j.stage='waiting-return';}return;}
  const path=ADDITIONAL_DESIGNS[boat.modelId]?additionalCrewRoute(s,home,boat,{gunCorridor:j.kind==='gunnery'})
    :boat.modelId==='victory'?victoryCrewRoute(s,home,boat,{gunCorridor:j.kind==='gunnery'})
    :j.kind==='gunnery'?crewNinaGunDeckRoute(s,home,boat)
    :s.id==='maria'?[deckPoint(s.x,-3.2,boat),deckPoint(home[0],-3.2,boat),home]
    :s.id==='duarte'?[deckPoint(home[0],s.z,boat),home]
    :[...j.path.slice(0,-1).reverse(),home];
  j.path=crewWorkNavigationRoute(s,path,boat);if(!j.path){j.path=[];j.stage='waiting-return';}
}
export function crewWorkLabel(s){
  if(s.job?.stage==='traffic-yield'||s.job?.stage==='traffic-hold')return 'Making way';
  if(s.intent==='brace')return s.job?.rung>0?'Holding fast aloft':'Bracing';
  if(!s.job&&s.seatedPose)return s.stationId?s.seatedPose.effort>0?s.seatedPose.drive?'Pulling the blade':'Recovering the blade':'Holding the loom':s.role==='Helmsman'?'Working the steering blade':'Seated at station';
  if(!s.job)return s.walk>.3?'On rounds':'At station';
  const j=s.job;
  if(j.stage==='ascending')return 'Climbing a runner';if(j.stage==='descending')return 'Climbing down';
  if(j.kind==='yield')return 'Making room on deck';
  if(j.stage==='approach')return 'Going to work';if(j.stage==='return')return 'Returning to station';
  if(j.kind==='gunnery')return {swab:'Sponging the bore',load:'Loading round shot',ram:'Ramming home',runout:'Hauling the gun out',prime:'Priming the gun',ready:'Standing clear · gun ready',recoil:'Standing clear of recoil',spent:'Awaiting reload'}[j.gun.stage]??'At the guns';
  return {rig:'Working the rigging',haul:'Hauling sail tackle',hatch:'Battening the hatch',lookout:'Keeping lookout aloft'}[j.kind];
}

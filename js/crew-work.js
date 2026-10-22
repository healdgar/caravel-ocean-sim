import { vesselDeck, HULL_VERTICAL_SCALE, modelDeck, modelDeckWidth, vesselVerticalScale } from './hull.js';
import { shroudGeometry } from './rigging.js';
import { SAIL_KEYS, sailingState } from './sailing.js';
import { gltfTRS } from './gltf.js';
import { resolveShipNode,requirePlayableShipModel } from './ship-models.js';
import { VICTORY_DESIGN, victorySheer } from './models/victory.js';
import {ADDITIONAL_DESIGNS,additionalStairFlights} from './models/additional.js';
import {ROWING_DESIGNS,rowingRigContext} from './models/rowing.js';
import {LATER_SAIL_DESIGNS,laterSailStairFlights} from './models/later-sail.js';
import {proceduralDesign,proceduralDeck,proceduralDeckWidth,proceduralHullWidth} from './models/procedural.js';
import {laterSailRigContext} from './additional-rig.js';
import {rowingStationPose,rowingSteeringPose} from './rowing.js';

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
  const yaw=station.yaw??Math.PI,z=seat[2]+Math.cos(yaw)*.46,Z=z/scale[2],floor=proceduralDeck(d.id,Z,station.x)*scale[1];
  const edge=Math.max(.12,proceduralHullWidth(d.id,Z,proceduralDeck(d.id,Z,station.x))*scale[0]-d.shellThicknessMetres),x=Math.max(-edge+.12,Math.min(edge-.12,seat[0]));
  const feet=[[x-.10,floor,z],[x+.10,floor,z]],hands=s.role==='Helmsman'?rowingSteeringPose(boat).hands:
    [-1,1].map(side=>[seat[0]+side*.14,seat[1]+.18,seat[2]+Math.cos(yaw)*.22]);
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
export function victoryCrewRoute(s,target,boat,{gunCorridor=false}={}){
  let side=Math.sign(s.x)||Math.sign(target[0])||1;
  const start=victoryLanding(s.z),end=victoryLanding(target[2]);
  const path=[],add=(x,z,y=modelDeck(boat,z))=>{
    const p=[x,y,z],previous=path.at(-1);if(!previous||distance3(previous,p)>1e-8)path.push(p);
  };
  // Enter/leave a flight at its landing, then use the outboard corridor. The
  // centreline remains clear for hatch gratings, capstans and mast heels.
  const outer=z=>side*Math.min(gunCorridor?.54:1.3,modelDeckWidth(boat,z)-.12);
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
  if(s.id==='maria')return [deckPoint(s.x,target[2]),target];
  if(s.id==='rui')return [deckPoint(.55,s.z),deckPoint(.55,-2.25),target];
  if(s.id==='beatriz')return [deckPoint(s.x,-2.65),deckPoint(target[0],-2.65),target];
  if(s.id==='catarina')return [deckPoint(s.x,2.55),deckPoint(target[0],2.55),target];
  return [deckPoint(target[0],s.z),target];
}
export function crewGunStation(gun,role,boat){
  const sx=boat.beam/3.6,sign=gun.sideSign??(gun.side==='port'?-1:1);
  if(role==='loader'){
    const x=boat.modelId==='victory'?gun.muzzleDesign[0]-sign*(gun.recoilLength+.10)/sx:gun.breechDesign[0]-sign*.15/sx;
    const z=gun.station[2]+(boat.modelId==='victory'?.10:.24);
    const edge=modelDeckWidth(boat,z)-.34/sx;
    return [Math.max(-edge,Math.min(edge,x)),modelDeck(boat,z),z];
  }
  const z=gun.station[2]-(boat.modelId==='victory'?.13:.25),x=gun.station[0]-sign*(boat.modelId==='victory'?.08/sx:.33);
  return [x,modelDeck(boat,z),z];
}
function gunCrewRoute(s,target,boat){
  if(ADDITIONAL_DESIGNS[boat.modelId])return additionalCrewRoute(s,target,boat,{gunCorridor:true});
  if(boat.modelId==='victory')return victoryCrewRoute(s,target,boat,{gunCorridor:true});
  const path=[],add=p=>{if(!path.length||distance3(path.at(-1),p)>1e-8)path.push(p);};
  const start=[s.x,modelDeck(boat,s.z),s.z];add(start);
  // Niña's rendered companionway is a starboard flight at x .72–1.20,
  // from z1.5 to2.64. Walk its actual ramp before entering the quarterdeck.
  if(s.z<2.7){
    add([.96,modelDeck(boat,1.5),1.5]);
    for(let i=1;i<=8;i++)add([.96,modelDeck(boat,1.5)+(2.3-modelDeck(boat,1.5))*i/8,1.5+1.14*i/8]);
  }
  const z=s.z<2.7?2.64:s.z;add([Math.sign(target[0])*.38,2.3,z]);
  add([Math.sign(target[0])*.38,2.3,target[2]]);add(target);return path;
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
    if(j?.kind==='gunnery'&&j.stage!=='return'&&(!active||j.gun.side!==boat.gunnerySide))startReturn(s,boat);
    // An aloft worker climbs down normally; there is no cannon-station teleport.
    if(active&&j&&(j.kind==='rig'||j.kind==='lookout')&&['ascending','working'].includes(j.stage))crewWorkDescend(s);
    else if(active&&j&&['haul','hatch'].includes(j.kind)&&j.stage!=='return')startReturn(s,boat);
  }
  if(!active)return;
  const available=company.crew.filter(s=>!['ines','pedro'].includes(s.id)&&!s.job);
  for(const gun of targets)for(const role of['loader','tackle']){
    if(company.crew.some(s=>s.job?.kind==='gunnery'&&s.job.stage!=='return'&&s.job.gun.id===gun.id&&s.job.gunRole===role))continue;
    const target=crewGunStation(gun,role,boat),point=physical(target,boat);
    available.sort((a,b)=>distance3(a.position,point)-distance3(b.position,point));
    const sailor=available.shift();if(!sailor)continue;
    sailor.home??=[sailor.x,sailor.z];
    sailor.job={kind:'gunnery',gun,gunRole:role,stage:'approach',elapsed:0,rung:0,revision:company.revision,path:gunCrewRoute(sailor,target,boat),cursor:0};
    sailor.intent='work';sailor.work=0;
  }
}
export function updateCrewGunneryAttendance(company,boat){
  boat.gunneryAttendance??=new Set();boat.gunneryAttendance.clear();
  if(!boat.gunnery)return;
  for(const gun of boat.gunnery.guns.filter(g=>g.visibleCrew&&g.side===boat.gunnerySide)){
    const hands=company.crew.filter(s=>s.job?.kind==='gunnery'&&s.job.gun.id===gun.id&&s.job.stage==='working'&&s.intent==='work'&&!s.observation.hazard);
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
  const pitch=.32,margin=d.cockpit?.22:.27,lo=d.profile.stations[0]*sz+.28,hi=d.profile.stations.at(-1)*sz-.28,columns=Math.ceil(boat.beam/pitch);
  // Narrow yacht side decks may lie between regular grid columns. Include the
  // actual centre of each authored cabin/walkway gap, without shrinking people.
  const xColumns=[...Array.from({length:columns+1},(_,i)=>-boat.beam/2+i*boat.beam/columns),...flights.map(f=>f.x*sx)];
  for(const b of d.structures??[])for(const side of [-1,1]){
    const edge=(b.centre[0]+side*b.size[0]/2)*sx,outside=side*proceduralDeckWidth(d.id,b.centre[2])*sx;
    xColumns.push((edge+outside)*.5);
  }
  xColumns.sort((a,b)=>a-b);const nx=xColumns.length-1,nz=Math.ceil((hi-lo)/pitch),width=nx+1;
  const floor=(x,z)=>{const f=flights.find(f=>Math.abs(x-f.x)<=f.width/2&&z>=f.z0&&z<=f.z1);return f?f.y0+(f.y1-f.y0)*(z-f.z0)/(f.z1-f.z0):proceduralDeck(d.id,z,x);};
  const start=s.job?.position??[s.x,crewDeckHeight(boat,s.z,s.x),s.z],points=new Map();
  const make=(i,j)=>{
    if(i<0||i>nx||j<0||j>nz)return null;const key=j*width+i;if(points.has(key))return points.get(key);
    const x=xColumns[i]/sx,z=(lo+j*(hi-lo)/nz)/sz,y=floor(x,z),p=[x,y,z],world=physical(p,boat);
    let clear=Math.abs(x)+margin/sx<proceduralDeckWidth(d.id,z);
    if(clear)for(const m of d.masts??[])if(Math.hypot(x*sx,(z-m.z)*sz)<(m.radius??0)*sx+.27){clear=false;break;}
    if(clear)for(const b of d.structures??[])if(Math.abs(x-b.centre[0])<b.size[0]/2+margin/sx&&Math.abs(z-b.centre[2])<b.size[2]/2+margin/sz&&y<b.centre[1]+b.size[1]/2+.02){clear=false;break;}
    const h=d.hatch;
    if(clear&&h&&Math.abs(x-h.centre[0])<h.size[0]/2+.22/sx&&Math.abs(z-h.centre[2])<h.size[2]/2+.22/sz)clear=false;
    if(clear&&company)for(const other of company.crew)if(other!==s&&other.position&&distance3(world,other.position)<.50&&distance3(world,physical(start,boat))>.48){clear=false;break;}
    const result=clear?{key,i,j,p,world}:null;points.set(key,result);return result;
  };
  const nearest=p=>{
    let I=0;for(let i=1;i<xColumns.length;i++)if(Math.abs(xColumns[i]-p[0]*sx)<Math.abs(xColumns[I]-p[0]*sx))I=i;
    const J=Math.round((p[2]*sz-lo)/(hi-lo)*nz);let best=null,cost=Infinity;
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
      const cost=costs.get(node.key)+distance3(node.world,next.world);if(cost>=(costs.get(next.key)??Infinity))continue;
      costs.set(next.key,cost);parents.set(next.key,node.key);push({node:next,cost:cost+distance3(next.world,b.world)});
    }
  }
  if(!found)return null;const path=[];let key=b.key;
  while(key!==undefined){path.push(points.get(key).p);key=parents.get(key);}path.reverse();
  return [[...start],...path,[...target]];
}
function crewProceduralTask(company,boat,s,job,target){
  const path=proceduralCrewRoute(s,target,boat,company);if(!path)return false;
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
    job.path=routeTo(s,target,boat);job.cursor=0;s.job=job;s.intent='work';s.work=0;
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
  if(!hasExtendedCrewModel(boat.modelId))s.visible=boat.beam>=3.2&&boat.length>=10.5;
  if(active){
    j.elapsed+=dt;
    if(['approach','return','lookout-approach','lookout-return'].includes(j.stage)){
      let p=j.position??[s.x,s.position[1]? (s.position[1]-.028)/vesselVerticalScale(boat):crewDeckHeight(boat,s.z,s.x),s.z];
      const target=j.path[j.cursor],a=physical(p,boat),b=physical(target,boat),d=distance3(a,b);
      const travel=Math.min(d,.75*dt),q=d>1e-6?travel/d:1;
      const next=p.map((x,i)=>x+(target[i]-x)*q),world=physical(next,boat);
      // Yield locally to another body rather than walking through it.
      const occupied=company.crew.some(other=>other!==s&&other.position&&Math.hypot(world[0]-other.position[0],world[1]+.028-other.position[1],world[2]-other.position[2])<.54);
      if(!occupied || d<.02){
        j.position=next;s.x=next[0];s.z=next[2];moving=travel>0;
        if(d>.01)s.yaw=Math.atan2(b[0]-a[0],b[2]-a[2]);
        if(d<=.02){j.cursor++;if(j.passing&&j.cursor>=4){j.passing=false;j.passingDirection=0;}if(j.cursor>=j.path.length){
          if(j.stage==='return'){s.job=null;s.x=s.home[0];s.z=s.home[1];s.wait=2;return false;}
          if(j.stage==='lookout-return')j.stage='descending';
          else if(j.stage==='lookout-approach'){j.stage='working';j.lookoutAtStation=true;}
          else j.stage=(j.kind==='rig'||j.kind==='lookout')?'ascending':'working';j.elapsed=0;
        }}
        j.blockedTime=0;
      }else if(ADDITIONAL_DESIGNS[boat.modelId]&&j.kind!=='gunnery'){
        j.blockedTime=(j.blockedTime??0)+dt;
        if(j.blockedTime>.5)crewAdditionalPassingDetour(s,company,boat,p,target);
      }else if(j.kind==='gunnery'){
        // Shared stairs/crossings can produce opposing traffic. A small clear
        // sidestep lets one body yield without walking through another person.
        j.blockedTime=(j.blockedTime??0)+dt;
        if(j.blockedTime>.5){
          const preference=(company.crew.indexOf(s)%2?1:-1),sx=boat.beam/3.6;
          for(const side of[preference,-preference]){
            const candidate=[p[0]+side*.6*dt/sx,p[1],p[2]],cp=physical(candidate,boat);
            if(Math.abs(candidate[0])+.32/sx>=modelDeckWidth(boat,candidate[2]))continue;
            if(company.crew.some(other=>other!==s&&other.position&&Math.hypot(cp[0]-other.position[0],cp[1]+.028-other.position[1],cp[2]-other.position[2])<.54))continue;
            j.position=candidate;s.x=candidate[0];s.z=candidate[2];moving=true;break;
          }
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
      if(j.stage==='descending'&&j.rung<=0)startReturn(s,boat);
    }else if(j.stage==='working'&&j.kind==='gunnery'){
      s.yaw=(j.gun.sideSign??Math.sign(j.gun.directionDesign[0]))*Math.PI/2;
      const tool=crewGunneryTool(s,boat);
      if(tool?.hands){const target=tool.hands[0].map((v,i)=>(v+tool.hands[1][i])*.5);s.yaw=Math.atan2(target[0]-s.position[0],target[2]-s.position[2]);}
    }else if(j.stage==='working'){
      s.yaw=j.kind==='hatch'?(boat.modelId==='victory'?-Math.PI/2:Math.PI):j.kind==='haul'?Math.sign(s.x)*Math.PI/2:-j.side*Math.PI/2;
      if(j.kind==='haul'&&hasExtendedCrewModel(boat.modelId)){
        const lead=crewExtendedContext(boat.modelId).controlStations?.[j.controlGroup]?.lead;
        if(lead)s.yaw=Math.atan2((lead[0]-s.x)*boat.beam/3.6,(lead[2]-s.z)*boat.length/12);
      }
      if(j.kind==='hatch'&&hasExtendedCrewModel(boat.modelId)&&requirePlayableShipModel(boat.modelId).nodes['hatch.grip']){
        const grip=resolveShipNode(boat,'hatch.grip');s.yaw=Math.atan2(grip[0]-s.position[0],grip[2]-s.position[2]);
      }
      if(j.kind==='hatch')boat.hatchesClosed=workClamp((boat.hatchesClosed??0)+dt/8,0,1);
      if(j.kind==='lookout'){company.lookoutHeight=s.position[1]+1.65;}
      const done=j.kind==='hatch'?(boat.hatchesClosed??0)>=1:j.kind==='lookout'?j.elapsed>18||company.order!=='watch'
        :!sailingState(boat).maneuver && Math.abs((boat[SAIL_KEYS[j.control??j.mast]]??1)-sailingState(boat).set[j.control??j.mast])<(hasExtendedCrewModel(boat.modelId)?1e-6:.008);
      if(done){if(j.kind==='rig'||j.kind==='lookout'){crewWorkDescend(s);s.nextWatch=company.workTime+45;}
        else startReturn(s,boat);}
    }else if(j.stage==='waiting-return'&&j.elapsed>.5){startReturn(s,boat);
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
  s.climbPitch=0;
  if((boat.modelId==='victory'||ADDITIONAL_DESIGNS[boat.modelId]||hasExtendedCrewModel(boat.modelId))&&j.rung>0&&!j.lookoutAtStation){
    const runner=crewRunnerMetrics(boat,j.mast,j.side);s.climbPitch=runner.lean;s.yaw=runner.yaw;
  }else if(boat.modelId==='victory'&&j.kind==='haul'&&j.stage==='working')s.climbPitch=.16;
  else if(j.kind==='gunnery'&&j.stage==='working'&&active&&!['ready','recoil','spent'].includes(j.gun.stage))s.climbPitch=j.gunRole==='loader'&&boat.modelId==='victory'?.45:.10;
  const sy=Math.sin(s.yaw/2),cy=Math.cos(s.yaw/2),sx=Math.sin(s.climbPitch/2),cx=Math.cos(s.climbPitch/2);
  s.rotation.set([cy*sx,sy*cx,-sy*sx,cy*cx]);gltfTRS(s.transform,s.position,s.rotation,s.scale);
  return true;
}
function startReturn(s,boat){
  const j=s.job;j.stage='return';j.elapsed=0;j.cursor=0;
  const home=homePoint(s,boat);
  if(hasExtendedCrewModel(boat.modelId)){j.path=proceduralCrewRoute(s,home,boat);if(!j.path){j.path=[];j.stage='waiting-return';}return;}
  if(ADDITIONAL_DESIGNS[boat.modelId]){j.path=additionalCrewRoute(s,home,boat,{gunCorridor:j.kind==='gunnery'});return;}
  if(boat.modelId==='victory'){j.path=victoryCrewRoute(s,home,boat,{gunCorridor:j.kind==='gunnery'});return;}
  j.path=s.id==='maria'?[deckPoint(s.x,-3.2),deckPoint(home[0],-3.2),home]
    :s.id==='duarte'?[deckPoint(home[0],s.z),home]
    :[...j.path.slice(0,-1).reverse(),home];
}
export function crewWorkLabel(s){
  if(s.intent==='brace')return s.job?.rung>0?'Holding fast aloft':'Bracing';
  if(!s.job&&s.seatedPose)return s.stationId?s.seatedPose.effort>0?s.seatedPose.drive?'Pulling the blade':'Recovering the blade':'Holding the loom':s.role==='Helmsman'?'Working the steering blade':'Seated at station';
  if(!s.job)return s.walk>.3?'On rounds':'At station';
  const j=s.job;
  if(j.stage==='ascending')return 'Climbing a runner';if(j.stage==='descending')return 'Climbing down';
  if(j.stage==='approach')return 'Going to work';if(j.stage==='return')return 'Returning to station';
  if(j.kind==='gunnery')return {swab:'Sponging the bore',load:'Loading round shot',ram:'Ramming home',runout:'Hauling the gun out',prime:'Priming the gun',ready:'Standing clear · gun ready',recoil:'Standing clear of recoil',spent:'Awaiting reload'}[j.gun.stage]??'At the guns';
  return {rig:'Working the rigging',haul:'Hauling sail tackle',hatch:'Battening the hatch',lookout:'Keeping lookout aloft'}[j.kind];
}

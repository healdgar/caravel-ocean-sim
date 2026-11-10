import { vesselDeck, HULL_VERTICAL_SCALE, modelDeck, modelDeckWidth, vesselVerticalScale } from './hull.js';
import { shroudGeometry } from './rigging.js';
import { SAIL_KEYS, sailingState, sailCanvasTarget, sailLosingCanvas } from './sailing.js';
import { gltfTRS } from './gltf.js';
import { resolveShipNode,requirePlayableShipModel } from './ship-models.js';
import { VICTORY_DESIGN, victorySheer,victoryStairFlights,victoryChainwale } from './models/victory.js';
import { NINA_DESIGN } from './models/nina.js';
import {ADDITIONAL_DESIGNS,additionalStairFlights} from './models/additional.js';
import {ROWING_DESIGNS,rowingRigContext,rowingBenchDescriptors} from './models/rowing.js';
import {LATER_SAIL_DESIGNS,laterSailStairFlights} from './models/later-sail.js';
import {proceduralDesign,proceduralDeck,proceduralDeckWidth,proceduralHullWidth} from './models/procedural.js';
import {laterSailRigContext} from './additional-rig.js';
import {rowingStationPose,rowingSteeringPose} from './rowing.js';
import {crewNavigationStation,crewNavigationRoute,crewRoutineSegmentClear,crewNavigationClear,crewNavigationSegmentClear,crewNavigationObstacles,CREW_NAVIGATION_BODY} from './crew-navigation.js';
import {crewDeckHazard,crewMotionPolicy,crewAdvanceWalk,crewTurnTowards} from './crew-motion.js';
import {vesselSidearm} from './gunnery-models.js';
import {shipMastSpecs,fracturePartsGone,LINE_MADE_FAST_BELOW_TOP} from './ship-fracture.js';
import {crewOpenEdgeInset} from './crew-overboard.js';
import {crewTrafficStep,crewTrafficGate,crewTrafficBackTo} from './crew-traffic.js';
import {crewDeckField,crewDeckLineRoom,crewDeckRoom,CREW_DECK_BODY_M} from './crew-deck.js';

export const hasExtendedCrewModel=id=>Object.hasOwn(ROWING_DESIGNS,id??'')||Object.hasOwn(LATER_SAIL_DESIGNS,id??'');
export const CREW_CLIMB_SPEED=.65;
const crewWorkControls=['fore','main','mizzen'];
export function crewMastName(boat,index){return requirePlayableShipModel(boat.modelId??'nina').rig.masts[index]?.id??crewWorkControls[index];}
const crewExtendedContext=id=>Object.hasOwn(ROWING_DESIGNS,id)?rowingRigContext(id):laterSailRigContext(id);
const crewExtendedFlights=id=>Object.hasOwn(LATER_SAIL_DESIGNS,id)?laterSailStairFlights(id):[];
export function crewDeckHeight(boat,z,x=0){return hasExtendedCrewModel(boat.modelId)?proceduralDeck(boat.modelId,z,x):modelDeck(boat,z);}

// These targets are the actual shaft/seat evaluator used by the water forces
// and visible propulsors. Crew never advances the shared rowing phase.
export function crewSeatedPose(s,boat){
  // A single-hander steers from her cockpit bench, where the tiller comes to hand.
  const sitting=Object.hasOwn(ROWING_DESIGNS,boat.modelId??'')||(boat.modelId==='gipsy-moth-iv'&&s.roles?.includes('helmsman'));
  if(!sitting)return null;
  if(s.stationId)return rowingStationPose(boat,s.stationId);
  const d=proceduralDesign(boat.modelId),station=d.crewStations[s.stationKey??s.id];if(!station)return null;
  const scale=[boat.beam/d.frame.beam,d.frame.verticalScale,boat.length/d.frame.length],seat=(station.seat??[station.x,station.y,station.z]).map((v,i)=>v*scale[i]);
  const facing=station.yaw??Math.PI,z=seat[2]+Math.cos(facing)*.42,Z=z/scale[2],floor=proceduralDeck(d.id,Z,station.x)*scale[1];
  const edge=Math.max(.12,proceduralHullWidth(d.id,Z,proceduralDeck(d.id,Z,station.x))*scale[0]-(d.shellThicknessMetres??0)),side=Math.sign(seat[0])||1;
  // Boots either side of the stores, not in them: between what the deck carries there and the hull's own side.
  const stores=(d.equipment.cargo??[]).filter(c=>Math.abs(Z-c.z)<c.extent[2]+.16/scale[2]).reduce((half,c)=>Math.max(half,c.extent[0]*scale[0]),0),inner=stores?stores+.09:0,outer=edge-.07;
  const stance=Math.min(.10,Math.max(.03,(outer-inner)*.5)),x=stores?side*Math.max(inner+stance,Math.min(outer-stance,Math.abs(seat[0]))):Math.max(-edge+.12,Math.min(edge-.12,seat[0]));
  // In a cockpit the feet go forward and inboard off the bench, into the well.
  const helmsman=s.role==='Helmsman'||s.roles?.includes('helmsman'),across=[Math.cos(facing),-Math.sin(facing)],out=seat[0]+Math.sin(facing)*.42;
  const feet=d.cockpit?[1,-1].map(k=>[out+across[0]*k*.09,floor,z+across[1]*k*.09]):[[x-stance,floor,z],[x+stance,floor,z]];
  // At rest his hands lie on his thighs, which ride a thigh's depth over the bench.
  const hands=d.cockpit?crewHelmHands(boat):helmsman?rowingSteeringPose(boat).hands:[-1,1].map(side=>[seat[0]+side*.14,seat[1]+.34,seat[2]+Math.cos(facing)*.30]);
  // A side-mounted steering oar is not directly in front of the bench. Turn
  // part way toward its real grips, still looking ahead, without moving the seat
  // or the planted foot targets. The arms reach the rest of the way.
  let yaw=facing;
  if(helmsman){const off=Math.atan2((hands[0][0]+hands[1][0])*.5-seat[0],(hands[0][2]+hands[1][2])*.5-seat[2])-facing,turn=Math.atan2(Math.sin(off),Math.cos(off));yaw=facing+workClamp(turn,-.45,.45);}
  return {seat,feet,hands,body:{position:seat,yaw,lean:0},stationId:s.stationKey??s.id,drive:false,effort:0};
}
export function updateCrewRowingAttendance(company,boat){
  if(!Object.hasOwn(ROWING_DESIGNS,boat.modelId??''))return;
  const attendance=boat.rowingAttendance??=new Set();attendance.clear();
  for(const s of company.crew)if(s.stationId&&!s.job&&!s.observation.hazard)attendance.add(s.stationId);
}

// A helmsman stands beside his tiller's end to port of it and faces forward, turned
// a little in toward it, with both hands on it. back and out are metres from the
// handle's end, along the tiller and across it. A hand's point is the wrist, up
// off the bar and back toward him, so the fingers close over it. Bars differ:
// Niña's is a square timber, the Pinta's and Santa María's end in a crossbar. The
// Gipsy Moth's helmsman sits to it instead, so she has hands but no stance.
const HELM_TILLER=Object.freeze({
  nina:{back:.30,out:.30,turn:.40,hands:[[.07,.11,.13],[.25,.11,.13]]},
  pinta:{back:.24,out:.28,turn:.40,hands:[[.08,.15,.09],[.09,.04,.09]]},
  'santa-maria':{back:.24,out:.28,turn:.40,hands:[[.08,.15,.09],[.09,.04,.09]]},
  'gipsy-moth-iv':{hands:[[.04,.05,.08],[.18,.05,.08]]},
});
// A wheel's rim is a circle in the design frame, and stays one as the wheel turns, so a hand on it stays on it:
// angles up from the side he stands, and how far aft of the wheel's plane the wrist rides, in design units.
const HELM_WHEEL=Object.freeze({'flying-cloud':{side:-1,high:.8,low:.05,aft:.02}});
// Metres. The handle's end, and the unit way along the tiller to its pivot, in plan.
function crewTillerFrame(boat){
  const id=boat.modelId??'nina',sx=boat.beam/3.6,sz=boat.length/12,grip=resolveShipNode(boat,'helm.grip');
  const pivot=id==='nina'?NINA_DESIGN.tiller.pivot:(ADDITIONAL_DESIGNS[id]??LATER_SAIL_DESIGNS[id]).steering.pivot;
  const x=pivot[0]*sx-grip[0],z=pivot[2]*sz-grip[2],n=Math.hypot(x,z)||1;
  return {grip,along:[x/n,z/n],out:[-z/n,x/n]};
}
// Where the helmsman of a tiller stands, in metres, and which way he faces. Null if she has no tiller.
export function crewHelmStand(boat){
  const stance=HELM_TILLER[boat.modelId??'nina'];if(!stance?.back)return null;
  const {grip,along,out}=crewTillerFrame(boat),yaw=Math.atan2(along[0],along[1])+Math.PI-stance.turn;
  return {x:grip[0]+along[0]*stance.back+out[0]*stance.out,z:grip[2]+along[1]*stance.back+out[1]*stance.out,yaw};
}
// The helmsman's left and right wrists, in hull metres.
export function crewHelmHands(boat){
  const wheel=HELM_WHEEL[boat.modelId];
  if(wheel){
    const d=proceduralDesign(boat.modelId).steering.wheel,sx=boat.beam/3.6,sy=vesselVerticalScale(boat),sz=boat.length/12;
    const turn=Math.sin((boat.rudder??0)*.07)*.18;
    const grips=[wheel.high+turn,wheel.low+turn].map(a=>[(d.centre[0]+wheel.side*Math.cos(a)*d.radius)*sx,(d.centre[1]+Math.sin(a)*d.radius)*sy,(d.centre[2]+wheel.aft)*sz]);
    return wheel.side<0?grips.reverse():grips;
  }
  const stance=HELM_TILLER[boat.modelId??'nina'];
  if(!stance)return ['l','r'].map((_,i)=>resolveShipNode(boat,'helm.grip',{along:i?.09:-.09}));
  const {grip,along,out}=crewTillerFrame(boat);
  return stance.hands.map(([a,o,up])=>[grip[0]+along[0]*a+out[0]*o,grip[1]+up,grip[2]+along[1]*a+out[1]*o]);
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
function homePoint(s,boat){
  const [x,z]=s.home,side=Math.sign(x),inset=crewOpenEdgeInset(boat,z,side);
  // A post at an edge that has lost its rail moves inboard of it.
  return deckPoint(inset?side*Math.min(Math.abs(x),Math.max(0,modelDeckWidth(boat,z)-inset-(.30+.03)/(boat.beam/3.6))):x,z,boat);
}
function climbRoot(mast,side,rung,boat){
  const p=resolveShipNode(boat,`mast.${crewMastName(boat,mast)}.runner`,{space:'design',side,step:rung});
  p[0]+=side*(boat.modelId==='victory'?.25/(boat.beam/3.6):.108);p[1]-=.12/vesselVerticalScale(boat);return p;
}
// Height a broken mast still reaches, in design units. Infinity while it is whole.
export function crewMastTop(boat,mast){
  const state=boat.damage?.mastState;if(!state)return Infinity;
  const name=crewMastName(boat,mast),stage=state[name]??0;
  if(!stage)return Infinity;
  const spec=shipMastSpecs(boat.modelId??'nina').find(m=>m[0]===name);
  return spec?spec[stage>=2?3:2]:Infinity;
}
// A runner's foot within this of the deck's edge, in design units, stands on her rail and not on her deck.
const CREW_RUNNER_FOOT_AT_RAIL=.1;
// What the foot of a runner stands on: Victory's on her chainwales, and other ships' on the rail where it reaches
// the side. Niña's stands inboard on the deck, which never leaves.
export function crewRunnerFootGone(boat,mast,side){
  const state=boat.damage?.fracture;if(!state?.brokenCount)return false;
  if(boat.modelId==='victory')return fracturePartsGone(state).has(`chainwale.${crewMastName(boat,mast)}.${side}`);
  const root=climbRoot(mast,side,0,boat);
  return Math.abs(root[0])+CREW_RUNNER_FOOT_AT_RAIL>=modelDeckWidth(boat,root[2])&&crewOpenEdgeInset(boat,root[2],side)>0;
}
// A runner is made fast at its head and its foot. With either gone there is nothing left to climb.
export function crewRunnerGone(boat,mast,side){
  if(crewRunnerFootGone(boat,mast,side))return true;
  const top=crewMastTop(boat,mast);
  return top!==Infinity&&climbRoot(mast,side,crewRunnerMetrics(boat,mast,side).rungs,boat)[1]-LINE_MADE_FAST_BELOW_TOP>=top;
}
// The side a hand can climb, given the one he would choose. Zero if neither side has a runner left.
export function crewClimbSide(boat,mast,side){
  if(!crewRunnerGone(boat,mast,side))return side;
  return crewRunnerGone(boat,mast,-side)?0:-side;
}
function haulStation(mast,boat){
  return resolveShipNode(boat,`station.haul.${['fore','main','mizzen'][mast]}`,{space:'design'});
}
function crewWorkDescend(s){
  const j=s.job;
  if(j.lookoutAtStation&&j.lookoutEntry){j.stage='lookout-return';j.path=[[...j.lookoutEntry]];j.cursor=0;j.lookoutAtStation=false;}
  else j.stage='descending';
}
function crewWorkFacingYaw(s,j,boat){
  if(j.kind==='boarding'||j.kind==='mooring')return j.combatYaw??((j.sideSign??(j.side==='port'?-1:1))*Math.PI/2);
  const sx=boat.beam/3.6,sz=boat.length/12;
  if(j.kind==='haul'){
    if(hasExtendedCrewModel(boat.modelId)){
      const lead=crewExtendedContext(boat.modelId).controlStations?.[j.controlGroup]?.lead;
      if(lead)return Math.atan2((lead[0]-s.x)*sx,(lead[2]-s.z)*sz);
    }
    const pull=boat.modelId==='victory'?1.10:1.04;
    const height=(s.position[1]+pull)/vesselVerticalScale(boat);
    const fall=resolveShipNode(boat,`rig.${j.controlGroup??crewMastName(boat,j.mast)}.fall`,{space:'design',height});
    const dx=fall[0]*sx-s.position[0],dz=fall[2]*sz-s.position[2];
    if(Math.hypot(dx,dz)>1e-4)return Math.atan2(dx,dz);
    return Math.sign(s.x||1)*Math.PI/2;
  }
  if(j.kind==='hatch'){
    if(hasExtendedCrewModel(boat.modelId)&&requirePlayableShipModel(boat.modelId).nodes['hatch.grip']){
      const grip=resolveShipNode(boat,'hatch.grip');
      return Math.atan2(grip[0]-s.position[0],grip[2]-s.position[2]);
    }
    if(ADDITIONAL_DESIGNS[boat.modelId]||hasExtendedCrewModel(boat.modelId)){
      const h=(ADDITIONAL_DESIGNS[boat.modelId]??proceduralDesign(boat.modelId)).hatch;
      if(h){
        const gx=(h.centre[0]+h.size[0]/2)*sx,gz=h.centre[2]*sz;
        if(Math.hypot(gx-s.position[0],gz-s.position[2])>1e-4)return Math.atan2(gx-s.position[0],gz-s.position[2]);
      }
    }
    return boat.modelId==='victory'?-Math.PI/2:Math.PI;
  }
  return -j.side*Math.PI/2;
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
  if(s.id==='maria')return [deckPoint(.78,s.z,boat),deckPoint(.78,target[2],boat),target];
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
  if(hasExtendedCrewModel(boat.modelId))return crewRoutineSegmentClear(s,boat,a,b);
  return crewNavigationSegmentClear(physical(a,boat),physical(b,boat),boat,crewWorkNavigationOptions(s,boat));
}
// How fast a walker's body comes round to the way he is going, radians a second.
const CREW_WALK_TURN=8;
// On the level, on a hull where nothing is stepped over, a body may leave the line of his route.
function crewWorkOnDeck(boat,p,target){
  if(Object.hasOwn(ROWING_DESIGNS,boat.modelId??''))return false;
  const sy=vesselVerticalScale(boat),sx=boat.beam/3.6,sz=boat.length/12,field=crewDeckField(boat);
  // The foot of a lead up onto a runner can be this near the floor and already over the side.
  const margin=(CREW_NAVIGATION_BODY.radius+1e-3)/sx;
  return Math.abs(p[1]-crewDeckHeight(boat,p[2],p[0]))*sy<=.06&&Math.abs(target[1]-crewDeckHeight(boat,target[2],target[0]))*sy<=.06
    &&Math.abs(p[0])+margin<=modelDeckWidth(boat,p[2])&&Math.abs(target[0])+margin<=modelDeckWidth(boat,target[2])
    &&crewDeckRoom(field,boat,p[0]*sx,p[2]*sz)>0;
}
// Back onto the route from wherever passing someone has left him, by a straight line to one of the next few waypoints.
function crewWorkRejoin(s,boat,x,z){
  const j=s.job,sx=boat.beam/3.6,sz=boat.length/12,here=[x/sx,crewDeckHeight(boat,z/sz,x/sx),z/sz],field=crewDeckField(boat),room=crewDeckRoom(field,boat,x,z);
  // As good as there already.
  const at=j.path[j.cursor];
  if(at&&Math.hypot(at[0]*sx-x,at[2]*sz-z)<.05){j.clearPath=null;j.position=at.slice();s.x=at[0];s.z=at[2];return true;}
  let furthest=j.cursor;
  while(furthest+1<j.path.length&&furthest<j.cursor+2&&crewWorkOnDeck(boat,j.path[furthest],j.path[furthest+1]))furthest++;
  for(let k=furthest;k>=j.cursor;k--){
    const to=j.path[k];
    if(!crewWorkOnDeck(boat,here,to)||!crewWorkSegmentClear(s,boat,here,to))continue;
    const line=crewDeckLineRoom(field,boat,x,z,to[0]*sx,to[2]*sz);
    if(line<CREW_DECK_BODY_M&&line<Math.min(room,crewDeckRoom(field,boat,to[0]*sx,to[2]*sz))-.02)continue;
    j.cursor=k;j.clearPath=null;j.position=here;return true;
  }
  return false;
}
// A step the solver wants that the deck's clearance cannot vouch for: metres, on the floor at each end.
function crewWorkTrafficClear(s,boat,x0,z0,x1,z1){
  const sx=boat.beam/3.6,sz=boat.length/12;
  return crewWorkSegmentClear(s,boat,[x0/sx,crewDeckHeight(boat,z0/sz,x0/sx),z0/sz],[x1/sx,crewDeckHeight(boat,z1/sz,x1/sx),z1/sz]);
}
// The route to the next waypoint need only be asked about once, until something is shot away.
function crewWorkRouteClear(s,boat,j,p,target,next){
  const revision=boat.damage?.fracture?.revision??0;
  if(j.clearPath===j.path&&j.clearCursor===j.cursor&&j.clearRevision===revision)return true;
  if(crewWorkSegmentClear(s,boat,p,target)){j.clearPath=j.path;j.clearCursor=j.cursor;j.clearRevision=revision;return true;}
  return crewWorkSegmentClear(s,boat,p,next);
}
function crewWorkNavigationRoute(s,path,boat,{exactTarget=false,job=s.job}={}){
  if(hasExtendedCrewModel(boat.modelId))return path;
  if(!path?.length)return null;
  const start=s.job?.position?.slice()??[s.x,s.position[1]?(s.position[1]-.028)/vesselVerticalScale(boat):crewDeckHeight(boat,s.z,s.x),s.z],points=[start],options=crewWorkNavigationOptions({...s,job},boat),dense=[];
  const waypoints=path.slice(),access=options?.rigAccess;
  if(access?.entry){
    const scale=[boat.beam/3.6,vesselVerticalScale(boat),boat.length/12],lead=(access.lead??[access.entry]).map(p=>p.map((v,i)=>v/scale[i]));
    // A route being mended may already go by way of the lead.
    if(distance3(physical(waypoints.at(-1),boat),access.point)<1e-6){
      if(!waypoints.slice(0,-1).some(p=>distance3(p,lead[0])<1e-6))waypoints.splice(waypoints.length-1,0,...lead);
    }
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
  const others=company.crew.filter(o=>o!==s&&o.casualtyState!=='fallen'&&o.position);
  for(let i=1;i<path.length;i++){
    const a=physical(path[i-1],boat),b=physical(path[i],boat);a[1]+=.028;b[1]+=.028;
    const ray=b.map((v,k)=>v-a[k]),length2=ray.reduce((sum,v)=>sum+v*v,0);
    // Already this close to someone, as in a tight place, and going no closer to speak of, is no reason to stay.
    if(others.some(o=>{const t=length2?workClamp(ray.reduce((sum,v,k)=>sum+v*(o.position[k]-a[k]),0)/length2,0,1):0,gap=distance3(o.position,a.map((v,k)=>v+ray[k]*t));const from=distance3(o.position,a);return gap<.54-1e-6&&(!length2||gap<from-.03||(gap<.4&&gap<from-1e-3));}))return false;
  }
  return true;
}
function crewWorkPassingDetour(s,company,boat,p,target){
  if(hasExtendedCrewModel(boat.modelId))return false;
  const j=s.job,from=physical(p,boat),sy=vesselVerticalScale(boat),sx=boat.beam/3.6,sz=boat.length/12;
  // A detour is a horizontal deck walk. Never short-cut a stair or an aloft
  // transition to another floor. Retry only from the existing blocked timer.
  if(Math.abs(p[1]-crewDeckHeight(boat,p[2],p[0]))*sy>.06||!crewWorkOnDeck(boat,p,p))return false;
  const neighbours=company.crew.filter(o=>o!==s&&o.casualtyState!=='fallen'&&o.position&&Math.abs(o.position[1]-.028-from[1])<.85&&Math.hypot(o.position[0]-from[0],o.position[2]-from[2])<3.5)
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
const CREW_STANDOFF_S=3,CREW_YIELD_ROOM_M=.34,CREW_YIELD_CLEAR_M=.7,CREW_REROUTE_S=2.5;
// Nose to nose in a gap with someone who goes first, and no way round: back to the last place there was room, and on from there.
function crewWorkBackOff(s,company,boat){
  const j=s.job,back=crewTrafficBackTo(s,company,boat,(j.totalBlockedTime??0)>CREW_STANDOFF_S);
  if(!back)return false;
  const path=crewWorkNavigationRoute(s,[[back[0]/(boat.beam/3.6),back[1]/vesselVerticalScale(boat),back[2]/(boat.length/12)],...j.path.slice(j.cursor)],boat,{exactTarget:['rig','lookout','gunnery'].includes(j.kind)});
  if(!path)return false;
  j.path=path;j.cursor=0;j.clearPath=null;s.trafficOffRoute=false;return true;
}
// A stationary off-duty sailor can occupy a legitimate work destination. Ask
// that person to walk to a nearby clear post, retaining their body and floor;
// neither the arriving worker nor the yielding person is moved instantly.
function crewWorkYieldIdle(s,company,boat,p,next){
  if(hasExtendedCrewModel(boat.modelId))return false;
  const wanted=physical(next,boat);wanted[1]+=.028;
  // Someone already standing aside, and still in the way, can stand further aside.
  const mayYield=o=>!o.job||o.job.stage==='traffic-hold'||(o.job.kind==='gunnery'&&o.job.stage==='working'&&(o.job.gun.stage==='ready'||(s.job?.kind==='gunnery'&&o.job.gunRole==='tackle'&&s.job.gunRole==='loader')));
  const blocker=company.crew.filter(o=>o!==s&&o.casualtyState!=='fallen'&&mayYield(o)&&o.role!=='Helmsman'&&o.id!=='ines'&&o.position&&distance3(o.position,wanted)<.68).sort((a,b)=>distance3(a.position,wanted)-distance3(b.position,wanted))[0];
  if(!blocker)return false;
  const sx=boat.beam/3.6,sz=boat.length/12,sy=vesselVerticalScale(boat),start=[blocker.x,(blocker.position[1]-.028)/sy,blocker.z],choices=[],field=crewDeckField(boat);
  for(const radius of[.75,1.05,1.4])for(const [X,Z]of[[1,0],[-1,0],[0,1],[0,-1],[.707,.707],[-.707,.707],[.707,-.707],[-.707,-.707]]){
    const x=start[0]+X*radius/sx,z=start[2]+Z*radius/sz,target=[x,crewDeckHeight(boat,z,x),z];
    if(Math.abs(target[1]-start[1])*sy>.06||!crewRoutineSegmentClear(blocker,boat,target,target))continue;
    const physicalTarget=physical(target,boat);physicalTarget[1]+=.028;
    if(company.crew.some(o=>o!==blocker&&o.casualtyState!=='fallen'&&o.position&&distance3(o.position,physicalTarget)<.70))continue;
    // Arms and all, on real deck, if the deck has such a place. If not, any place a route may stand, for as long as it takes.
    const cramped=crewDeckRoom(field,boat,physicalTarget[0],physicalTarget[2])<Math.min(CREW_YIELD_ROOM_M,crewDeckRoom(field,boat,blocker.position[0],blocker.position[2]));
    const path=crewWorkNavigationRoute(blocker,[target],boat,{exactTarget:true});if(!path||!crewWorkBodiesClear(blocker,company,boat,path))continue;
    // Out of the way of the one who asked: off the line he still has to walk.
    let clear=distance3(physicalTarget,wanted);
    const lane=[s.position,...(s.job?.path?.slice(s.job.cursor,s.job.cursor+6).map(q=>physical(q,boat))??[])];
    for(let k=1;k<lane.length;k++){
      const ax=lane[k-1][0],az=lane[k-1][2],bx=lane[k][0]-ax,bz=lane[k][2]-az,t=workClamp(((physicalTarget[0]-ax)*bx+(physicalTarget[2]-az)*bz)/Math.max(bx*bx+bz*bz,1e-9),0,1);
      clear=Math.min(clear,Math.hypot(ax+bx*t-physicalTarget[0],az+bz*t-physicalTarget[2]));
    }
    choices.push({target,path,distance:clear,radius,cramped});
  }
  // Far enough off that line is all it takes. He does not walk further from his post than he must.
  choices.sort((a,b)=>a.cramped-b.cramped||Math.min(b.distance,CREW_YIELD_CLEAR_M)-Math.min(a.distance,CREW_YIELD_CLEAR_M)||a.radius-b.radius);const choice=choices[0];if(!choice)return false;
  blocker.home??=[blocker.x,blocker.z];
  if(blocker.job){
    const job=blocker.job;
    if(job.stage==='traffic-hold'&&job.trafficResume){job.trafficResume.requester=s.id;job.trafficResume.requesterAt=Array.from(s.position);}
    else job.trafficResume={stage:job.stage,path:job.path.slice(job.cursor),requester:s.id,requesterAt:Array.from(s.position)};
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
      const z=gun.station[2]+.126+.31/sz,edge=modelDeckWidth(boat,z)-.301/sx;
      return[gun.kind==='carronade'?x/sx:Math.max(-edge,Math.min(edge,x/sx)),modelDeck(boat,z),z];
    }
    x=(gun.breechDesign[0]-sign*.10)*sx-sign*(gun.recoilLength+.34);
    const z=gun.station[2]+(Math.abs(gun.station[2]-1.98)<.05?.06:-.13);return[x/sx,modelDeck(boat,z),z];
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
  const startY=s.position?.[1]?(s.position[1]-.028)/vesselVerticalScale(boat):crewDeckHeight(boat,s.z,s.x);
  const start=s.job?.position?.slice()??[s.x,startY,s.z],floor=modelDeck(boat,1.5),high=2.3,upperZ=2.74,
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
    const laneX=Math.sign(target[0])===Math.sign(start[0])&&Math.abs(start[0])>.25?Math.sign(target[0])*.48:0;
    add([laneX,high,path.at(-1)[2]]);add([laneX,high,target[2]]);
  }else add([target[0],modelDeck(boat,start[2]),start[2]]);
  add(target);return path;
}
function gunCrewRoute(s,target,boat){
  if(ADDITIONAL_DESIGNS[boat.modelId])return additionalCrewRoute(s,target,boat,{gunCorridor:true});
  if(boat.modelId==='victory')return victoryCrewRoute(s,target,boat,{gunCorridor:true});
  return crewNinaGunDeckRoute(s,target,boat);
}
// Sail hands whose mast still needs canvas work stay on the sheets/runners even
// while the guns are manned; the rest of the watch serves the guns.
function crewSailHandMast(s){return CLIMBERS[s.id]?.[0]??HANDS[s.id];}
function crewNeededAtSail(s,needs,maneuver){
  if(!needs)return false;
  if(CLIMBERS[s.id])return Boolean(needs[CLIMBERS[s.id][0]]&&!maneuver);
  return HANDS[s.id]!==undefined&&Boolean(needs[HANDS[s.id]]||maneuver);
}
// Canvas needing hands on a line. Canvas lost to mast damage goes on its own, so
// a hit aloft does not pull a sail hand off a loaded gun for a single frame.
function crewSailWorkNeeded(boat,sails,tolerance){
  return SAIL_KEYS.map((_,i)=>Math.abs(sailCanvasTarget(boat,i)-sails.set[i])>tolerance&&!sailLosingCanvas(boat,i,sails.set[i]));
}
// Visible hands serve authored weather-deck guns. Batteries with no authored stations,
// archers among them, stay abstract, so paddlers keep paddling.
const crewServesGun=gun=>gun.weatherDeck&&!gun.abstractCrew;
function assignGunCrew(company,boat,needs=null,maneuver=false){
  const guns=boat.gunnery?.guns;
  if(!guns)return;
  const offline=g=>Boolean(g.disabledByScale||g.dismounted);
  const fit=s=>!['ines','pedro'].includes(s.id)&&s.casualtyState!=='fallen'&&!(s.knockdownTimer>0);
  const ableHands=company.crew.filter(fit).length;
  const weather=guns.filter(crewServesGun),baseLimit=boat.modelId==='victory'?4:2;
  const limit=Math.max(0,Math.min(baseLimit,Math.floor(ableHands/2)));
  // A gun station the crew physically cannot reach (blocked by wreckage, a
  // fallen shipmate, etc.) is served by unseen hands instead of stalling forever.
  const routeKey=[boat.modelId,boat.length,boat.beam,company.revision,boat.gunnerySide].join('/');
  if(company.gunNavigationKey!==routeKey){company.gunNavigationKey=routeKey;company.gunNavigationRetry=new Map();company.gunRouteFailSince=new Map();company.gunAbstractCrew=new Set();}
  company.gunRouteFailSince??=new Map();company.gunAbstractCrew??=new Set();
  const selected=new Set();
  for(const side of['port','starboard'])for(const gun of weather.filter(g=>g.side===side&&!offline(g)).slice(0,limit))selected.add(gun.id);
  for(const gun of weather)gun.visibleCrew=selected.has(gun.id)&&!company.gunAbstractCrew.has(gun.id);
  const targets=guns.filter(g=>selected.has(g.id)&&g.side===boat.gunnerySide&&!company.gunAbstractCrew.has(g.id));
  const active=targets.some(g=>g.loading||g.stage==='ready'||g.stage==='spent'||g.queued||g.stage==='recoil');
  for(const s of company.crew){
    const j=s.job;
    // A route can exist yet never deliver its hand; no deck walk takes this long.
    if(j?.kind==='gunnery'&&j.stage==='approach'&&company.workTime-(j.assignedAt??company.workTime)>30+boat.length)company.gunAbstractCrew.add(j.gun.id);
    if(j?.kind==='gunnery'&&!['return','waiting-return'].includes(j.stage)&&(!active||j.gun.side!==boat.gunnerySide||!selected.has(j.gun.id)||offline(j.gun)||company.gunAbstractCrew.has(j.gun.id)||crewNeededAtSail(s,needs,maneuver)))startReturn(s,boat,company);
    // An aloft worker climbs down normally; there is no cannon-station teleport.
    // Hands still needed to set or take in canvas finish that work first.
    const sailBusy=j&&(j.kind==='rig'||j.kind==='haul')&&Boolean(needs?.[j.mast]||(maneuver&&j.kind==='haul'));
    if(sailBusy)continue;
    if(active&&j&&(j.kind==='rig'||j.kind==='lookout')&&['ascending','working','lookout-approach'].includes(j.stage))crewWorkDescend(s);
    else if(active&&j&&(j.kind==='rig'||j.kind==='lookout')&&j.stage==='approach')startReturn(s,boat,company);
    else if(active&&j&&['haul','hatch'].includes(j.kind)&&j.stage!=='return')startReturn(s,boat,company);
  }
  company.gunneryActive=active||company.crew.some(s=>s.job?.kind==='gunnery'&&!['return','waiting-return'].includes(s.job.stage));
  boat.gunneryCrewNote=null;
  if(!active)return;
  const onDeck=s=>(s.job?.rung??0)<=0&&Math.abs(s.x)+.26/(boat.beam/3.6)<=modelDeckWidth(boat,s.z);
  const available=company.crew.filter(s=>fit(s)&&!crewNeededAtSail(s,needs,maneuver)&&(!s.job||(onDeck(s)&&(['return','waiting-return'].includes(s.job.stage)||s.job.kind==='yield'))));
  const ordered=boat.modelId==='victory'?[...targets].sort((a,b)=>b.station[2]-a.station[2]):targets;
  let shortHanded=0;
  for(const gun of ordered)for(const role of['loader','tackle']){
    if(company.gunAbstractCrew.has(gun.id))continue;
    if(company.crew.some(s=>s.casualtyState!=='fallen'&&!(s.knockdownTimer>0)&&s.job?.kind==='gunnery'&&!['return','waiting-return'].includes(s.job.stage)&&s.job.gun.id===gun.id&&s.job.gunRole===role)){company.gunRouteFailSince.delete(gun.id+'/'+role);continue;}
    const key=gun.id+'/'+role;if((company.gunNavigationRetry.get(key)??0)>company.workTime)continue;
    const target=crewGunStation(gun,role,boat),point=physical(target,boat);
    available.sort((a,b)=>{
      const aSame=a.job?.kind==='gunnery'&&a.job.gun?.id===gun.id?1:0;
      const bSame=b.job?.kind==='gunnery'&&b.job.gun?.id===gun.id?1:0;
      if(aSame!==bSame)return bSame-aSame;
      const aGun=a.job?.kind==='gunnery'?1:0;
      const bGun=b.job?.kind==='gunnery'?1:0;
      if(aGun!==bGun)return bGun-aGun;
      const aDeck=Math.abs(crewDeckHeight(boat,a.z,a.x)-target[1])<.25?1:0;
      const bDeck=Math.abs(crewDeckHeight(boat,b.z,b.x)-target[1])<.25?1:0;
      if(aDeck!==bDeck)return bDeck-aDeck;
      const aFit=a.casualtyState?0:1,bFit=b.casualtyState?0:1;
      if(aFit!==bFit)return bFit-aFit;
      return distance3(a.position,point)-distance3(b.position,point);
    });
    let sailor,path;
    for(const candidate of available){const route=crewWorkNavigationRoute(candidate,gunCrewRoute(candidate,target,boat),boat,{exactTarget:true});if(route){sailor=candidate;path=route;break;}}
    if(!sailor){
      company.gunNavigationRetry.set(key,company.workTime+1);
      if(!available.length){shortHanded++;company.gunRouteFailSince.delete(key);continue;}
      // Hands are free but none can reach this station: after a few seconds
      // hand the gun to unseen crew rather than leaving it permanently unloaded.
      const since=company.gunRouteFailSince.get(key)??company.workTime;company.gunRouteFailSince.set(key,since);
      if(company.workTime-since>5){company.gunAbstractCrew.add(gun.id);gun.visibleCrew=false;}
      continue;
    }
    available.splice(available.indexOf(sailor),1);company.gunNavigationRetry.delete(key);company.gunRouteFailSince.delete(key);
    sailor.home??=[sailor.x,sailor.z];
    sailor.job={kind:'gunnery',gun,gunRole:role,stage:'approach',elapsed:0,rung:0,revision:company.revision,path,cursor:0,assignedAt:company.workTime};
    sailor.intent='work';sailor.work=0;
  }
  const bracing=company.crew.some(s=>s.job?.kind==='gunnery'&&s.intent==='brace');
  boat.gunneryCrewNote=bracing?'Gun crews bracing · heavy seas'
    :shortHanded&&company.crew.some(s=>fit(s)&&crewNeededAtSail(s,needs,maneuver))?'Hands at the sheets · guns wait for crew'
    :shortHanded?'Short-handed · guns wait for crew'
    :null;
}
export function updateCrewGunneryAttendance(company,boat){
  boat.gunneryAttendance??=new Set();boat.gunneryAttendance.clear();
  if(!boat.gunnery)return;
  for(const gun of boat.gunnery.guns.filter(g=>g.visibleCrew&&g.side===boat.gunnerySide)){
    const hands=company.crew.filter(s=>{
      if(s.casualtyState==='fallen'||(s.knockdownTimer??0)>0||s.job?.kind!=='gunnery'||s.job.gun.id!==gun.id||s.intent!=='work'||s.observation.hazard)return false;
      const pos=[s.position[0],s.position[1]-.028,s.position[2]];
      if(!crewNavigationClear(pos,boat,s.navigationBody))return false;
      const d=distance3(physical(crewGunStation(gun,s.job.gunRole,boat),boat),pos);
      return (s.job.stage==='working'&&d<.08)||(s.job.arrivedAtGun&&['reposition','waiting-gun'].includes(s.job.stage)&&d<1.25)||d<.38;
    });
    if(hands.some(s=>s.job.gunRole==='loader')&&hands.some(s=>s.job.gunRole==='tackle'))boat.gunneryAttendance.add(gun.id);
  }
}
export function manGunStationsImmediate(company,boat){
  const guns=boat.gunnery?.guns;
  if(!guns||!company?.crew||!boat.gunnerySide)return false;
  const ableHands=company.crew.filter(s=>!['ines','pedro'].includes(s.id)&&s.casualtyState!=='fallen'&&!(s.knockdownTimer>0)).length;
  const weather=guns.filter(crewServesGun),baseLimit=boat.modelId==='victory'?4:2;
  const limit=Math.max(0,Math.min(baseLimit,Math.floor(ableHands/2)));
  const selected=new Set();
  for(const side of['port','starboard'])for(const gun of weather.filter(g=>g.side===side&&!g.disabledByScale&&!g.dismounted).slice(0,limit))selected.add(gun.id);
  for(const gun of weather)gun.visibleCrew=selected.has(gun.id);
  const targets=guns.filter(g=>selected.has(g.id)&&g.side===boat.gunnerySide);
  const ordered=boat.modelId==='victory'?[...targets].sort((a,b)=>b.station[2]-a.station[2]):targets;
  // Hands placed at the guns need no route, and those still at the sheets stay there.
  company.gunRouteFailSince?.clear();company.gunAbstractCrew?.clear();
  const sails=sailingState(boat),needs=crewSailWorkNeeded(boat,sails,.008);
  const available=company.crew.filter(s=>!['ines','pedro'].includes(s.id)&&s.casualtyState!=='fallen'&&!(s.knockdownTimer>0)&&!crewNeededAtSail(s,needs,Boolean(sails.maneuver)));
  for(const s of available){s.job=null;s.navigationPath=null;s.navigationKey=null;}
  for(const gun of ordered)for(const role of['loader','tackle']){
    const station=crewGunStation(gun,role,boat),world=physical(station,boat);
    available.sort((a,b)=>distance3(a.position,world)-distance3(b.position,world));
    const sailor=available.shift();if(!sailor)break;
    sailor.home??=[sailor.x,sailor.z];
    sailor.x=station[0];sailor.z=station[2];
    sailor.position.set([world[0],world[1]+.028,world[2]]);
    sailor.yaw=(gun.sideSign??Math.sign(gun.directionDesign[0]))*Math.PI/2;
    sailor.job={kind:'gunnery',gun,gunRole:role,stage:'working',arrivedAtGun:true,elapsed:1,rung:0,revision:company.revision,path:[station],cursor:1,position:station};
    sailor.intent='work';sailor.work=1;sailor.walk=0;
  }
  company.gunneryActive=true;
  updateCrewGunneryAttendance(company,boat);
  return true;
}
// Actor-local hand targets of a boarding fight's cutlass lunge, slash, and parry cycle, in metres.
export function crewBoardingHands(s){
  const phase=s.time*4.8+(s.crewIndex??0)*1.37;
  const cycle=phase%(Math.PI*2);
  // 3-beat fencing cadence: (0..2.1) forward lunge thrust, (2.1..4.2) diagonal high-to-low slash, (4.2..6.28) high guard parry & riposte
  let right,left,point,lunge=0,torsoTwist=0;
  if(cycle<2.1){
    const u=Math.sin((cycle/2.1)*Math.PI);
    lunge=0.14*u;
    torsoTwist=0.28*u;
    right=[-0.10+0.06*u,1.22+0.08*u,0.38+0.34*u];
    left=[0.22+0.05*u,1.14-0.04*u,0.22-0.08*u];
    point=[0.08*(1-u),0.18+0.12*u,0.92];
  }else if(cycle<4.2){
    const t=(cycle-2.1)/2.1,arc=Math.cos(t*Math.PI),drop=Math.sin(t*Math.PI);
    lunge=0.06*drop;
    torsoTwist=-0.32*arc;
    right=[-0.22*arc,1.34-0.28*t,0.36+0.24*drop];
    left=[0.20,1.18+0.06*drop,0.28];
    point=[-0.52*arc,0.48-0.55*t,0.74];
  }else{
    const t=(cycle-4.2)/(Math.PI*2-4.2),parry=Math.sin(t*Math.PI);
    lunge=-0.06*parry;
    torsoTwist=-0.18*parry;
    right=[-0.04+0.18*parry,1.38+0.10*parry,0.34+0.08*parry];
    left=[0.18,1.24+0.08*parry,0.32];
    point=[0.48*parry+0.15,0.62+0.18*parry,0.58];
  }
  return {right,left,point,lunge,torsoTwist};
}
// The weapon each hand holds in a boarding fight, from the fist to its point.
function crewBoardingWeapon(s,boat){
  const arm=vesselSidearm(boat?.modelId),hands=crewBoardingHands(s),c=Math.cos(s.yaw),sn=Math.sin(s.yaw);
  const toBoat=p=>{const x=p[0]*s.scale[0],y=p[1]*s.scale[1],z=p[2]*s.scale[2];return [s.position[0]+c*x+sn*z,s.position[1]+y,s.position[2]-sn*x+c*z];};
  const n=Math.hypot(...hands.point);
  return {kind:arm.kind,radius:arm.radius,a:toBoat(hands.right),b:toBoat(hands.right.map((v,i)=>v+hands.point[i]/n*arm.length))};
}
// Boat-local metre targets shared by actual hand IK and the visible tool mesh.
export function crewGunneryTool(s,boat){
  const j=s.job;
  if(j?.kind==='boarding'&&j.stage==='working'&&s.position)return crewBoardingWeapon(s,boat);
  if(j?.kind==='lookout'&&j.stage==='working'&&(s.intent==='work'||j.lookoutAtStation)&&s.position&&(s.phys?.usingSpyglass??true)){
    const scaleY=s.scale?.[1]??1;
    const eyeY=s.position[1]+(j.lookoutAtStation?1.24:1.42)*scaleY;
    const lookYaw=(s.yaw??Math.PI)+(s.phys?.gazeYaw??0);
    const lookPitch=s.phys?.gazePitch??-0.05;
    const cp=Math.cos(lookPitch),sp=Math.sin(lookPitch);
    const dir=[Math.sin(lookYaw)*cp,sp,Math.cos(lookYaw)*cp];
    const sideOffset=[-Math.cos(lookYaw)*0.05,0,Math.sin(lookYaw)*0.05];
    const base=[s.position[0]+sideOffset[0],eyeY,s.position[2]+sideOffset[2]];
    const a=base.map((v,i)=>v+dir[i]*0.08);
    const b=base.map((v,i)=>v+dir[i]*0.46);
    return {kind:'spyglass',a,b};
  }
  if(j?.kind!=='gunnery'||j.stage!=='working'||s.intent!=='work')return null;
  const gun=j.gun,stage=gun.stage,scale=[boat.beam/3.6,vesselVerticalScale(boat),boat.length/12];
  const direction=gun.directionDesign.map((v,i)=>v*scale[i]),n=Math.hypot(...direction);for(let i=0;i<3;i++)direction[i]/=n;
  const muzzle=gun.muzzleDesign.map((v,i)=>v*scale[i]-direction[i]*gun.offset);
  const along=(distance,base=muzzle)=>base.map((v,i)=>v+direction[i]*distance);
  if(j.gunRole==='loader'&&['swab','load','ram'].includes(stage)){
    if(gun.kind==='swivel'){
      const breech=gun.breechDesign.map((v,i)=>v*scale[i]-direction[i]*gun.offset);
      return {kind:'chamber',a:along(-.12,breech),b:along(.12,breech),hands:[breech.map((v,i)=>v+(i===2?.09:0)),breech.map((v,i)=>v-(i===2?.09:0))]};
    }
    const handBase=gun.kind==='carronade'?muzzle:[s.position[0]-direction[0]*.18,muzzle[1],muzzle[2]];
    const stroke=Math.sin((gun.progress??0)*Math.PI*4)*.10,grip=along(.10+stroke,handBase);
    return {kind:stage==='swab'?'sponge':'rammer',a:along(.72+stroke),b:along(-.6+stroke),hands:[grip,along(.26+stroke,handBase)]};
  }
  if(j.gunRole==='loader'&&stage==='prime'){
    const breech=gun.breechDesign.map((v,i)=>v*scale[i]-direction[i]*gun.offset);breech[1]+=.10;
    // Victory's loader stands beside the truck, so he primes from the breech's
    // near shoulder; reaching its far side folds his legs through the carriage.
    if(boat.modelId==='victory')breech[2]+=.12;
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
  const rowingBody=Object.hasOwn(ROWING_DESIGNS,d.id),bodies=company?.crew.filter(other=>other!==s&&other.casualtyState!=='fallen'&&other.position)??[];
  const pitch=.32,margin=d.cockpit?.22:.27,lo=d.profile.stations[0]*sz+.28,hi=d.profile.stations.at(-1)*sz-.28,columns=Math.ceil(boat.beam/pitch);
  // A station beside an open edge moves inboard of it, and nothing below walks along one.
  const targetInset=crewOpenEdgeInset(boat,target[2],Math.sign(target[0]));
  if(targetInset){
    const keep=Math.max(0,proceduralDeckWidth(d.id,target[2])-targetInset-(margin+.02)/sx);
    if(Math.abs(target[0])>keep){const x=Math.sign(target[0])*keep;target=[x,proceduralDeck(d.id,target[2],x),target[2]];}
  }
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
    let clear=Math.abs(x)+margin/sx+crewOpenEdgeInset(boat,z,Math.sign(x))<proceduralDeckWidth(d.id,z);
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
  // A start off her decks has no path, however near a node the search above can find.
  if(distance3(a.world,physical(start,boat))>2)return null;
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
  for(const s of company.crew){
    if(s.casualtyState==='fallen'){s.job=null;continue;}
    const j=s.job;if(!j)continue;
    if(crewMastJobLost(s,boat,company))continue;
    if(j.kind==='rig'&&j.stage==='descending'&&Math.abs(sailCanvasTarget(boat,j.control)-sails.set[j.control])>1e-6){
      j.stage='ascending';j.elapsed=0;
    }else if((j.rung??0)<=0&&['return','waiting-return'].includes(j.stage)&&controls.some(c=>Math.abs(sailCanvasTarget(boat,c.index)-sails.set[c.index])>1e-6)){
      s.job=null;
    }
  }
  // A helmsman stays with the steering blade on crewed craft. A solo sailor can
  // secure the tiller, do one deck job, then physically return to her helm.
  const free=targetPoint=>{
    const worldTarget=targetPoint?physical(targetPoint,boat):null;
    return company.crew.filter(s=>s.casualtyState!=='fallen'&&!s.job&&(solo||s.role!=='Helmsman')).sort((a,b)=>{
      const stationDiff=Number(!!a.stationId)-Number(!!b.stationId);
      if(stationDiff)return stationDiff;
      if(!worldTarget)return 0;
      return distance3(a.position,worldTarget)-distance3(b.position,worldTarget);
    });
  };
  if(company.order==='weather'&&(boat.hatchesClosed??0)<.999&&model.nodes['station.hatch']&&!company.crew.some(s=>s.job?.kind==='hatch')){
    const target=resolveShipNode(boat,'station.hatch',{space:'design'});
    for(const s of free(target))if(crewProceduralTask(company,boat,s,{kind:'hatch'},target))break;
  }
  for(const control of controls){
    const targetSet=sailCanvasTarget(boat,control.index);
    if(Math.abs(targetSet-sails.set[control.index])<=1e-6)continue;
    const station=context.controlStations?.[control.name];if(!station)continue;
    const mast=station.mast??control.surfaces[0].mast,runner='mast.'+crewMastName(boat,mast)+'.runner';
    const climbSide=(model.nodes[runner]?.motion?.rungs??0)>0?crewClimbSide(boat,mast,1):0;
    const climbing=!solo&&control.surfaces.some(s=>s.kind==='square')&&climbSide!==0;
    for(const kind of climbing?['haul','rig']:['haul']){
      if(company.crew.some(s=>s.job?.control===control.index&&s.job.kind===kind))continue;
      const side=climbSide||1,target=kind==='haul'?station.position:climbRoot(mast,side,0,boat);
      for(const s of free(target))if(crewProceduralTask(company,boat,s,{kind,control:control.index,mast,side,controlGroup:control.name},target))break;
    }
    const ready=company.crew.filter(s=>s.job?.control===control.index&&s.job.stage==='working'&&s.intent==='work'&&!s.observation.hazard);
    const hauling=ready.some(s=>s.job.kind==='haul');
    const raising=targetSet>sails.set[control.index]+1e-6;
    boat.crewRigRate[control.index]=Number(hauling);
    boat.crewSailRate[control.index]=Number(hauling&&(!climbing||raising||ready.some(s=>s.job.kind==='rig')));
  }
  const needs=SAIL_KEYS.map((_,i)=>controls.some(c=>c.index===i)&&Math.abs(sailCanvasTarget(boat,i)-sails.set[i])>1e-6&&!sailLosingCanvas(boat,i,sails.set[i]));
  boat.sailHoldReason=crewSailHoldReason(company,boat,needs);
  updateCrewRowingAttendance(company,boat);
}
export function assignCrewWork(company,boat) {
  if(hasExtendedCrewModel(boat.modelId)){assignProceduralCrewWork(company,boat);return;}
  const sails=sailingState(boat),needs=crewSailWorkNeeded(boat,sails,.008);
  company.workTime??=0;
  assignGunCrew(company,boat,needs,Boolean(sails.maneuver));
  for(const s of company.crew){
    s.home??=[s.x,s.z];
    if(s.casualtyState==='fallen'){s.job=null;continue;}
    if(boat.damage?.surrendered)continue;
    // With the guns manned, only the sail hands (and only for canvas that still
    // needs setting/taking in) leave the battery; lookout and hatch work wait.
    if(company.gunneryActive&&((s.job?.kind==='gunnery'&&!['return','waiting-return'].includes(s.job.stage))||!crewNeededAtSail(s,needs,sails.maneuver)))continue;
    if(s.job){
      const j=s.job;
      if(crewMastJobLost(s,boat,company))continue;
      if(j.kind==='rig'&&j.stage==='descending'&&needs[j.mast]&&!sails.maneuver){
        j.stage='ascending';j.elapsed=0;continue;
      }
      if((j.rung??0)<=0&&(['return','waiting-return'].includes(j.stage)||j.kind==='yield')){
        const wantsClimb=CLIMBERS[s.id]&&needs[CLIMBERS[s.id][0]]&&!sails.maneuver&&crewClimberSide(s,boat,sails,CLIMBERS[s.id][0])!==0;
        const wantsHaul=HANDS[s.id]!==undefined&&(needs[HANDS[s.id]]||sails.maneuver);
        const wantsHatch=s.id==='rui'&&company.order==='weather'&&(boat.hatchesClosed??0)<.999;
        if(wantsClimb||wantsHaul||wantsHatch){s.job=null;}else continue;
      }else continue;
    }
    let job;
    if(CLIMBERS[s.id] && needs[CLIMBERS[s.id][0]] && !sails.maneuver && crewClimberSide(s,boat,sails,CLIMBERS[s.id][0])!==0){
      const [mast]=CLIMBERS[s.id];job={kind:'rig',mast,side:crewClimberSide(s,boat,sails,mast)};
    }else if(HANDS[s.id]!==undefined && (needs[HANDS[s.id]] || sails.maneuver)){
      job={kind:'haul',mast:HANDS[s.id]};
    }else if(company.gunneryActive){
      job=null;
    }else if(s.id==='rui' && company.order==='weather' && (boat.hatchesClosed??0)<.999){
      job={kind:'hatch'};
    }else if(s.id==='maria' && !sails.maneuver && company.order==='watch' && company.workTime>(s.nextWatch??12) && crewMastTop(boat,ADDITIONAL_DESIGNS[boat.modelId]?.lookout?.mast??0)===Infinity && crewClimberSide(s,boat,sails,ADDITIONAL_DESIGNS[boat.modelId]?.lookout?.mast??0)!==0){
      const mast=ADDITIONAL_DESIGNS[boat.modelId]?.lookout?.mast??0;
      job={kind:'lookout',mast,side:crewClimberSide(s,boat,sails,mast)};
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
  // Fallback assignment if a primary haul/rig sailor is fallen in action.
  if(!boat.damage?.surrendered){
    for(let mast=0;mast<3;mast++){
      if(!(needs[mast]||sails.maneuver))continue;
      const surfaces=ADDITIONAL_DESIGNS[boat.modelId]?.surfaces.filter(s=>s.controlGroup===['fore','main','mizzen'][mast]);
      if(surfaces&&!surfaces.length)continue;
      if(!company.crew.some(s=>s.casualtyState!=='fallen'&&s.job?.kind==='haul'&&s.job.mast===mast)){
        const primaryId=Object.keys(HANDS).find(k=>HANDS[k]===mast);
        const primary=company.crew.find(s=>s.id===primaryId);
        if(!primary||primary.casualtyState==='fallen'){
          const target=haulStation(mast,boat);
          const sub=company.crew.find(s=>s.casualtyState!=='fallen'&&!(s.knockdownTimer>0)&&(!s.job||(s.job.kind==='gunnery'&&['return','waiting-return'].includes(s.job.stage)))&&!['ines','pedro'].includes(s.id)&&(s.navigationRetryAt??0)<=company.workTime);
          if(sub){
            const job={kind:'haul',mast,stage:'approach',elapsed:0,rung:0,revision:company.revision};
            job.path=crewWorkNavigationRoute(sub,routeTo(sub,target,boat),boat,{exactTarget:false,job});
            if(job.path){job.cursor=0;sub.job=job;sub.intent='work';sub.work=0;}
          }
        }
      }
    }
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
    const hauling=ready.some(s=>s.job.kind==='haul');
    const targetSet=sailCanvasTarget(boat,mast);
    const raising=targetSet>sails.set[mast]+1e-4;
    // A mast that has lost its runners has its canvas handled from the deck.
    const climberAssigned=company.crew.some(s=>CLIMBERS[s.id]?.[0]===mast&&s.casualtyState!=='fallen'&&crewClimberSide(s,boat,sails,mast)!==0);
    boat.crewRigRate[mast]=Number(!aloft && hauling);
    boat.crewSailRate[mast]=(mast===2||raising||!climberAssigned)
      ?Number(hauling)
      :Number(hauling && ready.some(s=>s.job.kind==='rig'));
  }
  boat.sailHoldReason=crewSailHoldReason(company,boat,needs);
}
// Plain-language reason the canvas is not moving toward the ordered setting.
function crewSailHoldReason(company,boat,needs){
  const waiting=needs.map((need,i)=>need&&!(boat.crewSailRate?.[i]>0));
  if(!waiting.some(Boolean))return null;
  if(boat.damage?.surrendered)return 'Colors struck · hands stood down';
  const sailHands=company.crew.filter(s=>crewSailHandMast(s)!==undefined||s.job?.kind==='haul'||s.job?.kind==='rig');
  const sailHandsDown=sailHands.length>0&&sailHands.every(s=>s.casualtyState==='fallen'||s.knockdownTimer>0);
  if(company.crew.some(s=>(s.job?.kind==='haul'||s.job?.kind==='rig')&&s.intent==='brace'))return 'Hands bracing · heavy seas';
  if(!company.crew.some(s=>s.casualtyState!=='fallen'&&!(s.knockdownTimer>0)&&!['ines','pedro'].includes(s.id)))return 'No able hands to work the sails';
  if(sailHandsDown)return 'Sail hands down · finding replacements';
  if(company.crew.some(s=>(s.job?.kind==='haul'||s.job?.kind==='rig')&&s.job.stage!=='working'))return company.gunneryActive?'Hands leaving the guns for the sheets':'Hands going to the sheets';
  if(company.gunneryActive)return 'Hands at the guns';
  return 'Waiting for hands';
}
// He is at the waypoint. True if that ends his job and his step.
function crewWorkWaypointReached(s,j,at){
  j.position=at;s.x=at[0];s.z=at[2];j.cursor++;s.trafficOffRoute=false;
  if(j.passing&&j.cursor>=4){j.passing=false;j.passingDirection=0;}
  if(j.cursor<j.path.length)return false;
  if(j.stage==='traffic-yield'){j.stage='traffic-hold';j.elapsed=0;}
  else if(j.stage==='return'){s.job=null;s.home=[at[0],at[2]];s.wait=2;return true;}
  if(j.kind==='yield'){
    const shift=at[2]-j.priorHome[1];s.home=[at[0],at[2]];s.patrolX=at[0];s.route=s.route.map(z=>z+shift);s.target=s.route[1];s.navigationPath=null;s.navigationKey=null;s.job=null;s.wait=2;return true;
  }
  if(j.stage==='traffic-hold'){}
  else if(j.stage==='lookout-return')j.stage='descending';
  else if(j.stage==='lookout-approach'){j.stage='working';j.lookoutAtStation=true;}
  else{j.stage=(j.kind==='rig'||j.kind==='lookout')?'ascending':'working';if(j.kind==='gunnery')j.arrivedAtGun=true;}
  j.elapsed=0;
  return false;
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
  if(!hasExtendedCrewModel(boat.modelId))s.visible=!s.obliterated&&boat.beam>=3.2&&boat.length>=10.5;
  if(active){
    j.elapsed+=dt;
    if(j.kind==='gunnery'&&j.stage==='working'){
      j.arrivedAtGun=true;
      const goal=crewGunStation(j.gun,j.gunRole,boat),from=j.position??[s.x,crewDeckHeight(boat,s.z,s.x),s.z];
      const a=physical(from,boat),b=physical(goal,boat),d=distance3(a,b);
      if(d>1e-6){
        const horizontal=Math.hypot(b[0]-a[0],b[2]-a[2]);
        const motion=crewMotionPolicy(boat,{purpose:'work',grade:horizontal>1e-8?(b[1]-a[1])/horizontal:0,hazard:o.hazard});
        const maxStep=motion.speedMetresPerSecond*dt,travel=Math.min(d,maxStep),q=travel/d;
        const next=d<=maxStep+1e-6?goal:from.map((x,i)=>x+(goal[i]-x)*q),nextWorld=physical(next,boat);
        const occupied=company.crew.some(other=>other!==s&&other.casualtyState!=='fallen'&&other.job?.gun?.id!==j.gun.id&&other.role!=='Helmsman'&&other.id!=='ines'&&other.position&&Math.hypot(nextWorld[0]-other.position[0],nextWorld[1]+.028-other.position[1],nextWorld[2]-other.position[2])<.38);
        if(!occupied&&crewWorkSegmentClear(s,boat,from,next)){
          j.position=next;s.x=next[0];s.z=next[2];
          if(travel>.002){moving=true;crewAdvanceWalk(s,travel,{strideMetres:motion.strideMetres});}
        }else if(d>.025&&!crewWorkSegmentClear(s,boat,from,next)){
          const path=crewWorkNavigationRoute(s,[from,goal],boat,{exactTarget:true});
          j.path=path??[];j.cursor=0;j.stage=path?'reposition':'waiting-gun';j.elapsed=0;
        }
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
      // Off the line of his route only on a level deck, and never on a thwart-stepping rowed hull.
      const onDeck=crewWorkOnDeck(boat,p,target);
      const passing=onDeck?crewTrafficStep(s,company,boat,{x:a[0],z:a[2],toX:b[0],toZ:b[2],speed:motion.speedMetresPerSecond,dt,segmentClear:crewWorkTrafficClear,rejoin:crewWorkRejoin}):null;
      // Nobody walks a rowed hull's one gangway both ways, as that hull's own planner sees to it.
      const standing=!onDeck&&!Object.hasOwn(ROWING_DESIGNS,boat.modelId??'')&&crewTrafficGate(s,company,boat,a[0],a[2],dt);
      if(!onDeck)s.trafficWalkingNow=true;
      // Aloft the runner says which way he faces. On deck the body comes round to the way he goes, and the feet do not get ahead of it.
      const turns=d>.01&&!passing&&!((j.rung??0)>0);
      if(turns)s.yaw=crewTurnTowards(s.yaw??0,Math.atan2(b[0]-a[0],b[2]-a[2]),dt,CREW_WALK_TURN);
      const facing=turns?Math.max(0,Math.cos(Math.atan2(b[0]-a[0],b[2]-a[2])-s.yaw)):1;
      const travel=passing?Math.hypot(passing.x-a[0],passing.z-a[2]):Math.min(d,motion.speedMetresPerSecond*facing*dt),q=d>1e-6?travel/d:1;
      const next=passing?[passing.x/(boat.beam/3.6),crewDeckHeight(boat,passing.z/(boat.length/12),passing.x/(boat.beam/3.6)),passing.z/(boat.length/12)]:p.map((x,i)=>x+(target[i]-x)*q),world=physical(next,boat);
      // On a stair or a ladder a body stops for another. On a deck the solver has already dealt with them.
      const bodyRadius=j.kind==='gunnery'?.38:.54;
      const occupied=!passing&&!onDeck&&company.crew.some(other=>{
        if(other===s||other.casualtyState==='fallen'||!other.position)return false;
        const d1=Math.hypot(world[0]-other.position[0],world[1]+.028-other.position[1],world[2]-other.position[2]);
        if(d1>=bodyRadius)return false;
        const d0=Math.hypot(a[0]-other.position[0],a[1]+.028-other.position[1],a[2]-other.position[2]);
        return d1<d0-1e-7;
      });
      const clear=passing?!passing.blocked||passing.hemmed:crewWorkRouteClear(s,boat,j,p,target,next);
      if(standing){j.blockedTime=0;}
      else if(passing){
        const at=company.workTime??0;
        if(passing.ask&&(j.askedAt??-1)<=at){j.askedAt=at+1;crewWorkYieldIdle(s,company,boat,p,[passing.ask.x,(passing.ask.position[1]-.028)/vesselVerticalScale(boat),passing.ask.z]);}
        // Someone standing in the way is a matter for the route: a line round them is better than dodging them. Only then does he
        // leave it, and a body he cannot route round he squeezes past.
        if(passing.stander&&(j.routedAt??-1)<=at){
          j.routedAt=at+CREW_REROUTE_S;
          if(crewWorkPassingDetour(s,company,boat,p,target)){s.trafficOffRoute=false;j.position=p;j.clearPath=null;return crewWorkFinishStep(s,j,boat,dt,active,moving);}
        }
        j.passing=j.passing||(travel>1e-4&&!passing.holding);
        if(travel>1e-5){
          j.position=next;s.x=next[0];s.z=next[2];moving=true;j.clearPath=null;crewAdvanceWalk(s,travel,{strideMetres:motion.strideMetres});
        }
        // A waypoint he is abreast of needs no more going to, unless it is where he is bound. That he has to reach.
        const goal=j.path[j.cursor],goalWorld=physical(goal,boat),left=Math.hypot(goalWorld[0]-world[0],goalWorld[2]-world[2]);
        const after=j.path[j.cursor+1],mayPass=after&&crewWorkOnDeck(boat,goal,after);
        // Nor does one with someone standing on it.
        const taken=mayPass&&passing.blocked&&left<1.2&&company.crew.some(o=>o!==s&&o.casualtyState!=='fallen'&&o.position&&Math.hypot(o.position[0]-goalWorld[0],o.position[1]-.028-goalWorld[1],o.position[2]-goalWorld[2])<.45);
        if(mayPass&&(left<.2||taken)&&crewWorkSegmentClear(s,boat,next,after))j.cursor++;
        else if(left<.05&&travel+left<=motion.speedMetresPerSecond*dt+1e-6&&crewWorkWaypointReached(s,j,goal.slice()))return false;
        if(passing.blocked){j.blockedTime=(j.blockedTime??0)+dt;j.totalBlockedTime=(j.totalBlockedTime??0)+dt;}else{j.blockedTime=0;j.totalBlockedTime=0;}
      }else if(clear&&!occupied){
        const walking=crewRowingWalkState(s,boat);if(walking)walking.distance=Math.min(walking.length,walking.distance+Math.hypot(world[0]-a[0],world[2]-a[2]));
        j.position=next;s.x=next[0];s.z=next[2];moving=travel>0;crewAdvanceWalk(s,travel,{strideMetres:motion.strideMetres});
        if(d-travel<=1e-8&&crewWorkWaypointReached(s,j,next))return false;
        j.blockedTime=0;
        j.totalBlockedTime=0;
      }else{
        j.blockedTime=(j.blockedTime??0)+dt;
        j.totalBlockedTime=(j.totalBlockedTime??0)+dt;
      }
      if(j.blockedTime>.5){
        if(hasExtendedCrewModel(boat.modelId)&&!onDeck){
          const path=proceduralCrewRoute(s,j.path.at(-1),boat,company);if(path){j.path=path;j.cursor=0;}
        }else if(hasExtendedCrewModel(boat.modelId)){
          const path=proceduralCrewRoute(s,j.path.at(-1),boat,company);if(path){j.path=path;j.cursor=0;s.trafficOffRoute=false;}
        }else{
          let repaired=false;
          if(!clear){const path=crewWorkNavigationRoute(s,j.path.slice(j.cursor),boat,{exactTarget:['rig','lookout','gunnery'].includes(j.kind)});if(path){j.path=path;j.cursor=0;repaired=true;s.trafficOffRoute=false;}}
          if(!repaired&&!crewWorkPassingDetour(s,company,boat,p,target)&&!crewWorkYieldIdle(s,company,boat,p,next)&&!crewWorkBackOff(s,company,boat)&&ADDITIONAL_DESIGNS[boat.modelId]&&j.kind!=='gunnery')crewAdditionalPassingDetour(s,company,boat,p,target);
        }
        j.blockedTime=0;
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
      j.rung=workClamp(j.rung+direction*CREW_CLIMB_SPEED*dt/dy,0,j.top);
      j.position=climbRoot(j.mast,j.side,j.rung,boat);s.x=j.position[0];s.z=j.position[2];s.yaw=-j.side*Math.PI/2;
      if(j.stage==='ascending'&&j.rung>=j.top){
        j.stage='working';j.elapsed=0;
        if(j.kind==='lookout'&&lookout&&lookout.mast===j.mast){
          const p=resolveShipNode(boat,'lookout.'+['fore','main','mizzen'][j.mast],{space:'design'});p[0]+=j.side*.20;
          j.lookoutEntry=[...j.position];j.stage='lookout-approach';j.path=[p];j.cursor=0;
        }
      }
      if(j.stage==='descending'&&j.rung<=0)startReturn(s,boat,company);
    }else if(j.stage==='working'&&(j.kind==='boarding'||j.kind==='mooring')){
      s.yaw=j.combatYaw??((j.sideSign??(j.side==='port'?-1:1))*Math.PI/2);
      if(j.crossingGangplank){
        moving=true;
        crewAdvanceWalk(s,dt*1.55,{strideMetres:0.56});
      }
      const done=j.kind==='boarding'?!boat.boardingActive:!boat.mooringActive;
      if(done)startReturn(s,boat,company);
    }else if(j.stage==='working'&&j.kind==='gunnery'){
      s.yaw=(j.gun.sideSign??Math.sign(j.gun.directionDesign[0]))*Math.PI/2;
      const tool=crewGunneryTool(s,boat);
      if(tool?.hands){const target=tool.hands[0].map((v,i)=>(v+tool.hands[1][i])*.5);s.yaw=Math.atan2(target[0]-s.position[0],target[2]-s.position[2]);}
    }else if(j.stage==='working'){
      if(j.kind==='lookout'&&j.lookoutAtStation){
        let desiredYaw=Math.PI+0.28*Math.sin((s.time??0)*0.42);
        if(boat.lookoutSighting&&Number.isFinite(boat.lookoutSighting.x)&&Number.isFinite(boat.lookoutSighting.z)){
          const wx=boat.lookoutSighting.x-(boat.x??0),wz=boat.lookoutSighting.z-(boat.z??0);
          const h=((boat.heading??0)*Math.PI)/180,ch=Math.cos(h),sh=Math.sin(h);
          desiredYaw=Math.atan2(ch*wx-sh*wz,-sh*wx-ch*wz);
        }
        s.yaw=crewTurnTowards(s.yaw??Math.PI,desiredYaw,dt,2.8);
      }else{
        s.yaw=crewWorkFacingYaw(s,j,boat);
      }
      if(j.kind==='hatch')boat.hatchesClosed=workClamp((boat.hatchesClosed??0)+dt/8,0,1);
      if(j.kind==='lookout'){company.lookoutHeight=s.position[1]+1.65;}
      const ctrlIdx=j.control??j.mast,targetSet=sailCanvasTarget(boat,ctrlIdx);
      const done=j.kind==='hatch'?(boat.hatchesClosed??0)>=1:j.kind==='lookout'?j.elapsed>18||company.order!=='watch'
        :!sailingState(boat).maneuver && Math.abs(targetSet-sailingState(boat).set[ctrlIdx])<(hasExtendedCrewModel(boat.modelId)?1e-6:.008);
      if(done){if(j.kind==='rig'||j.kind==='lookout'){crewWorkDescend(s);s.nextWatch=company.workTime+45;}
        else startReturn(s,boat,company);}
    }else if(j.stage==='waiting-return'&&j.elapsed>.5){startReturn(s,boat,company);
    }
    // A replaced order never teleports an aloft sailor; they finish/descend safely.
    if(j.kind==='lookout'&&company.order!=='watch'&&j.stage==='ascending')crewWorkDescend(s);
    if(j.kind==='rig'){
      const ctrlIdx=j.control??j.mast,targetSet=sailCanvasTarget(boat,ctrlIdx);
      const done=!sailingState(boat).maneuver && Math.abs(targetSet-sailingState(boat).set[ctrlIdx])<(hasExtendedCrewModel(boat.modelId)?1e-6:.008);
      if(done&&j.stage==='ascending')crewWorkDescend(s);
      else if(done&&j.stage==='approach')startReturn(s,boat,company);
    }
  }
  return crewWorkFinishStep(s,j,boat,dt,active,moving);
}
// The rest of a sailor's step, whatever the job did: how he stands, and where that puts him.
function crewWorkFinishStep(s,j,boat,dt,active,moving){
  const blend=1-Math.exp(-dt*8);s.walk+=(Number(moving)-s.walk)*blend;
  s.brace+=(Number(s.intent==='brace')-s.brace)*blend;
  s.work+=(Number(active&&j.stage==='working')-s.work)*blend;
  const p=j.position??[s.x,crewDeckHeight(boat,s.z,s.x),s.z];s.position.set(physical(p,boat));s.position[1]+=.028;
  if(j.kind==='gunnery'&&j.stage==='working'){
    const tool=crewGunneryTool(s,boat);
    if(tool?.hands){const target=tool.hands[0].map((v,i)=>(v+tool.hands[1][i])*.5);s.yaw=Math.atan2(target[0]-s.position[0],target[2]-s.position[2]);}
  }else if(j.stage==='working'&&j.kind!=='lookout'){
    // Approach can enter this stage in the current step. Face the real work
    // before composing its transform, rather than inheriting the last path edge.
    s.yaw=crewWorkFacingYaw(s,j,boat);
  }
  s.climbPitch=0;
  if((boat.modelId==='victory'||ADDITIONAL_DESIGNS[boat.modelId]||hasExtendedCrewModel(boat.modelId))&&j.rung>0&&!j.lookoutAtStation){
    const runner=crewRunnerMetrics(boat,j.mast,j.side);s.climbPitch=runner.lean;s.yaw=runner.yaw;
  }else if(j.kind==='haul'&&j.stage==='working')s.climbPitch=.16;
  else if(hasExtendedCrewModel(boat.modelId)&&proceduralDesign(boat.modelId).cockpit&&j.kind==='hatch'&&j.stage==='working'&&active)s.climbPitch=.36*(1-(boat.hatchesClosed??0));
  const sy=Math.sin(s.yaw/2),cy=Math.cos(s.yaw/2),sx=Math.sin(s.climbPitch/2),cx=Math.cos(s.climbPitch/2);
  s.rotation.set([cy*sx,sy*cx,-sy*sx,cy*cx]);gltfTRS(s.transform,s.position,s.rotation,s.scale);
  return true;
}
// A hand sent to a mast that has since come down. Whoever was on it has already gone with it, so this is
// someone still on deck or on what is left. A lookout has no top to go to; others come back from the foot.
function crewMastJobLost(s,boat,company){
  const j=s.job;
  if(j.kind!=='rig'&&j.kind!=='lookout')return false;
  const mastBroken=crewMastTop(boat,j.mast)!==Infinity,runnerGone=crewRunnerGone(boat,j.mast,j.side);
  if(!mastBroken&&!runnerGone)return false;
  if(j.kind==='lookout'&&mastBroken&&['ascending','working','lookout-approach'].includes(j.stage)&&(j.rung??0)>0){crewWorkDescend(s);return true;}
  if((j.rung??0)>0||['return','waiting-return'].includes(j.stage)||(j.kind==='rig'&&!runnerGone))return false;
  startReturn(s,boat,company);
  return true;
}
// The side a climber would take on this mast and can, or zero.
function crewClimberSide(s,boat,sails,mast){
  return crewClimbSide(boat,mast,boat.modelId==='victory'||ADDITIONAL_DESIGNS[boat.modelId]?Math.sign(s.x)||-1:-Math.sign(sails.rig[mast].side));
}
function startReturn(s,boat,company=null){
  const j=s.job;delete j.trafficResume;j.stage='return';j.elapsed=0;j.cursor=0;
  const home=homePoint(s,boat);
  if(hasExtendedCrewModel(boat.modelId)){j.path=proceduralCrewRoute(s,home,boat,company);if(!j.path){j.path=[];j.stage='waiting-return';}return;}
  const path=ADDITIONAL_DESIGNS[boat.modelId]?additionalCrewRoute(s,home,boat,{gunCorridor:j.kind==='gunnery'})
    :boat.modelId==='victory'?victoryCrewRoute(s,home,boat,{gunCorridor:j.kind==='gunnery'})
    :j.kind==='gunnery'?crewNinaGunDeckRoute(s,home,boat)
    :s.id==='maria'?[deckPoint(s.x,-3.2,boat),deckPoint(.78,-3.2,boat),deckPoint(.78,home[2],boat),home]
    :s.id==='duarte'?[deckPoint(home[0],s.z,boat),home]
    :j.path?.length>1?[...j.path.slice(0,-1).reverse(),home]:routeTo(s,home,boat);
  j.path=crewWorkNavigationRoute(s,path,boat);if(!j.path){j.path=[];j.stage='waiting-return';}
}
export function crewWorkLabel(s){
  if(s.casualtyState==='fallen')return 'Fallen in action';
  const woundPrefix=s.casualtyState==='wounded'?'Wounded · ':'';
  if(s.job?.stage==='traffic-yield'||s.job?.stage==='traffic-hold')return woundPrefix+'Making way';
  if(s.intent==='brace')return woundPrefix+(s.job?.rung>0?'Holding fast aloft':'Bracing');
  if(!s.job&&s.seatedPose)return woundPrefix+(s.stationId?s.seatedPose.effort>0?s.seatedPose.drive?'Pulling the blade':'Recovering the blade':'Holding the loom':s.role==='Helmsman'?'Working the steering blade':'Seated at station');
  if(!s.job)return woundPrefix+(s.walk>.3?'On rounds':'At station');
  const j=s.job;
  if(j.stage==='ascending')return woundPrefix+'Climbing a runner';if(j.stage==='descending')return woundPrefix+'Climbing down';
  if(j.kind==='yield')return woundPrefix+'Making room on deck';
  if(j.stage==='approach')return woundPrefix+'Going to work';if(j.stage==='return')return woundPrefix+'Returning to station';
  if(j.kind==='gunnery')return woundPrefix+({swab:'Sponging the bore',load:'Loading round shot',ram:'Ramming home',runout:'Hauling the gun out',prime:'Priming the gun',ready:'Standing clear · gun ready',recoil:'Standing clear of recoil',spent:'Awaiting reload'}[j.gun.stage]??'At the guns');
  return woundPrefix+({rig:'Working the rigging',haul:'Hauling sail tackle',hatch:'Battening the hatch',lookout:'Keeping lookout aloft',boarding:'Fighting at the bulwarks',mooring:'Handling mooring lines'}[j.kind]??'At work');
}

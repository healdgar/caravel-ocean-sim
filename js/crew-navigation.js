// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
import {modelDeck,modelDeckWidth,vesselVerticalScale} from './hull.js';
import {createGunDefinitions} from './gunnery-models.js';
import {VICTORY_MASTS,victoryMastPoint} from './models/victory.js';
import {ADDITIONAL_DESIGNS} from './models/additional.js';
import {ROWING_DESIGNS} from './models/rowing.js';
import {LATER_SAIL_DESIGNS} from './models/later-sail.js';
import {RIG_MASTS,mastPoint} from './rigging.js';

// Metres, independent of design-frame scale. This is a standing-body clearance,
// not a shrunken render proxy. Hands may reach outside it to work real equipment.
export const CREW_NAVIGATION_BODY=Object.freeze({radius:.30,height:1.70});
const crewNavigationCache=new WeakMap();
const crewNavigationKnown=id=>id==='nina'||id==='victory'||Object.hasOwn(ADDITIONAL_DESIGNS,id)||Object.hasOwn(ROWING_DESIGNS,id)||Object.hasOwn(LATER_SAIL_DESIGNS,id);
const crewNavigationExtended=id=>Object.hasOwn(ROWING_DESIGNS,id)||Object.hasOwn(LATER_SAIL_DESIGNS,id);
function crewNavigationScale(boat){return[(boat.beam??3.6)/3.6,vesselVerticalScale(boat),(boat.length??12)/12];}
function crewNavigationPhysical(p,scale){return p.map((v,i)=>v*scale[i]);}
function crewNavigationDesign(p,scale){return p.map((v,i)=>v/scale[i]);}
function crewNavigationEnvelope(options={}){
  return {radius:Math.max(CREW_NAVIGATION_BODY.radius,Number.isFinite(options.radius)?options.radius:0),height:Math.max(CREW_NAVIGATION_BODY.height,Number.isFinite(options.height)?options.height:0)};
}
// Equipment bounds follow the rendered meshes, with the whole authored recoil
// travel reserved even while a gun is run out. Separate component records avoid
// treating an entire gun group (including its empty space) as one solid box.
export function crewNavigationObstacles(boat){
  const id=boat.modelId??'nina';if(!crewNavigationKnown(id))return null;
  const scale=crewNavigationScale(boat),key=id+'/'+scale.join('/'),old=crewNavigationCache.get(boat);
  if(old?.key===key)return old.obstacles;
  const obstacles=[],add=(name,kind,min,max,extra={})=>obstacles.push(Object.freeze({id:name,kind,min:Object.freeze(min),max:Object.freeze(max),...extra}));
  const box=(name,kind,a,b,extra={})=>add(name,kind,crewNavigationPhysical(a,scale),crewNavigationPhysical(b,scale),extra);
  const tube=(name,kind,a,b,r,extra={})=>box(name,kind,a.map((v,i)=>Math.min(v,b[i])-r),a.map((v,i)=>Math.max(v,b[i])+r),extra);
  const swept=(gun,name,a,b)=>{
    const direction=gun.directionDesign.map((v,i)=>v*scale[i]),length=Math.hypot(...direction),delta=direction.map(v=>-v/length*gun.recoilLength),A=crewNavigationPhysical(a,scale),B=crewNavigationPhysical(b,scale);
    add('gun.'+gun.id+'.'+name,'gun',A.map((v,i)=>Math.min(v,v+delta[i])),B.map((v,i)=>Math.max(v,v+delta[i])),{gunId:gun.id,meshGroup:gun.meshGroup,reservation:'full-recoil'});
  };
  for(const gun of createGunDefinitions(id)){
    const side=gun.sideSign,z=gun.station[2],y=gun.breechDesign[1],floor=gun.floorDesign,extra={gunId:gun.id,meshGroup:gun.meshGroup,reservation:'fixed'};
    if(id==='victory'){
      const r=gun.weatherDeck?(gun.kind==='carronade'?.055:.032):({lower:.040,middle:.035,upper:.030}[gun.deck]??.040);
      const a=gun.breechDesign,b=gun.muzzleDesign;
      swept(gun,'barrel',a.map((v,i)=>Math.min(v,b[i])-r),a.map((v,i)=>Math.max(v,b[i])+r));
      if(gun.weatherDeck){
        const x=a[0]+side*.15,lo=Math.min(x-side*.25,x+side*.015),hi=Math.max(x-side*.25,x+side*.015);
        swept(gun,'carriage',[lo,floor+.055,z-.086],[hi,floor+.18,z+.086]);
        for(const X of[x-side*.21,x-side*.005])swept(gun,'trucks.'+X,[X-.042,floor,z-.126],[X+.042,floor+.084,z+.126]);
      }
    }else{
      const additional=Object.hasOwn(ADDITIONAL_DESIGNS,id),x=additional?gun.centre[0]:gun.muzzleDesign[0]-side*.49;
      const r=additional?.033:.065,a=gun.breechDesign,b=gun.muzzleDesign;
      swept(gun,'barrel',a.map((v,i)=>Math.min(v,b[i])-r),a.map((v,i)=>Math.max(v,b[i])+r));
      const tail=additional?[a[0]-side*.16,a[1]-.025,a[2]]:[x-side*.52,y-.10,z];
      swept(gun,'handle',a.map((v,i)=>Math.min(v,tail[i])-.018),a.map((v,i)=>Math.max(v,tail[i])+.018));
      tube('gun.'+gun.id+'.mount','gun',[x,floor,z],[x,y-(additional?.035:.08),z],additional?.025:.035,extra);
      const bearingY=y-(additional?.02:0);
      tube('gun.'+gun.id+'.bearing','gun',[x,bearingY,z-(additional?.065:.13)],[x,bearingY,z+(additional?.065:.13)],additional?.018:.028,extra);
      if(!additional){
        box('gun.'+gun.id+'.cradle','gun',[x-.025,y-.163,z-.12],[x+.025,y-.117,z+.12],extra);
        for(const dz of[-.10,.10])box('gun.'+gun.id+'.fork.'+dz,'gun',[x-.018,y-.18,z+dz-.018],[x+.018,y+.055,z+dz+.018],extra);
        swept(gun,'sight',[x-side*.13-.05,y-.10,z-.05],[x-side*.13+.05,y+.11,z+.05]);
      }
    }
  }
  // The existing five newer-vessel graphs already own their cockpit, bench,
  // stair and mast constraints. Do not replace that independently qualified graph.
  if(!crewNavigationExtended(id)){
    const masts=id==='victory'?VICTORY_MASTS:Object.hasOwn(ADDITIONAL_DESIGNS,id)?ADDITIONAL_DESIGNS[id].masts:RIG_MASTS;
    for(const [index,mast]of masts.entries()){
      const foot=modelDeck(boat,mast.z),top=foot+2/scale[1],point=Y=>id==='victory'?victoryMastPoint(index,Y):id==='nina'?mastPoint(index,Y):[0,Y,mast.z+(mast.rake??0)*(Y-foot)/(mast.height-foot)];
      tube('mast.'+index,'mast',point(foot),point(top),mast.radius??mast.r,{reservation:'fixed'});
    }
    if(id==='victory'){
      for(const z of[-4.52,-1.5,.65,2.35,4.75]){const y=modelDeck(boat,z),w=z===2.35?.29:.34;box('hatch.'+z,'hatch',[-w,y+.008,z-.35],[w,y+.122,z+.35],{reservation:'fixed'});}
      for(const z of[-4.85,2.68]){const y=modelDeck(boat,z);box('capstan.'+z,'capstan',[-.335,y,z-.335],[.335,y+.25,z+.335],{reservation:'fixed'});}
      for(const z of[-5.1,-3.95,1.8,4.22])for(const side of[-1,1]){const x=side*.65,y=modelDeck(boat,z);box('bitt.'+side+'.'+z,'bitt',[x-.16,y,z-.06],[x+.16,y+.21,z+.06],{reservation:'fixed'});}
      const binnacle=modelDeck(boat,3.05);box('binnacle','binnacle',[-.205,binnacle,2.88],[.205,binnacle+.305,3.17],{reservation:'fixed'});
      for(const [index,x]of[-.43,.43].entries())box('boat.waist.'+index,'ship-boat',[x-.34,1.17+.04,-2.59],[x+.34,1.17+.336,.29],{reservation:'fixed'});
    }else if(Object.hasOwn(ADDITIONAL_DESIGNS,id)){
      const h=ADDITIONAL_DESIGNS[id].hatch,x=h.centre[0],z=h.centre[2],y=modelDeck(boat,z);
      box('hatch.main','hatch',[x-h.size[0]/2-.025,y-.03,z-h.size[2]/2-.025],[x+h.size[0]/2+.025,Math.max(y+.12,h.centre[1]+h.size[1]),z+h.size[2]/2+.025],{reservation:'fixed'});
    }else{
      const y=modelDeck(boat,-3.15);box('hatch.main','hatch',[-.518,y,-3.688],[.518,y+.12,-2.612],{reservation:'fixed'});
      const foreFloor=modelDeck(boat,-4.8);
      for(const side of[-1,1]){const x=side*.35;box('bitt.'+side,'bitt',[x-.055,foreFloor,-4.855],[x+.055,foreFloor+.36,-4.745],{reservation:'fixed',meshGroup:'deck.fore.bitts'});}
      box('bitts.crossbeam','bitt',[-.50,foreFloor+.23,-4.85],[.50,foreFloor+.33,-4.75],{reservation:'fixed',meshGroup:'deck.fore.bitts'});
    }
  }
  const result=Object.freeze(obstacles);crewNavigationCache.set(boat,{key,obstacles:result});return result;
}
function crewNavigationInside(p,o,body){
  return p[1]<o.max[1]-.001&&p[1]+body.height>o.min[1]+.001&&p[0]>o.min[0]-body.radius&&p[0]<o.max[0]+body.radius&&p[2]>o.min[2]-body.radius&&p[2]<o.max[2]+body.radius;
}
function crewNavigationIntersects(a,b,o,body){
  const min=[o.min[0]-body.radius,o.min[1]-body.height+.001,o.min[2]-body.radius],max=[o.max[0]+body.radius,o.max[1]-.001,o.max[2]+body.radius];let lo=0,hi=1;
  for(let i=0;i<3;i++){
    const delta=b[i]-a[i];if(Math.abs(delta)<1e-12){if(a[i]<=min[i]||a[i]>=max[i])return false;continue;}
    let A=(min[i]-a[i])/delta,B=(max[i]-a[i])/delta;if(A>B)[A,B]=[B,A];lo=Math.max(lo,A);hi=Math.min(hi,B);if(lo>=hi)return false;
  }
  return hi>0&&lo<1;
}
function crewNavigationOnDeck(p,boat,scale,body){
  const z=p[2]/scale[2],x=p[0]/scale[0];return Number.isFinite(p[1])&&Math.abs(x)+body.radius/scale[0]<modelDeckWidth(boat,z);
}
function crewNavigationPathClear(a,b,boat,obstacles,body,scale){
  if(obstacles.some(o=>crewNavigationIntersects(a,b,o,body)))return false;
  // Preserve the original ramp's interpolated elevation. Width follows the
  // actual hull profile along the path, rather than a fixed patrol corridor.
  const count=Math.max(1,Math.ceil(Math.hypot(b[0]-a[0],b[2]-a[2])/.12));
  for(let i=0;i<=count;i++)if(!crewNavigationOnDeck(a.map((v,k)=>v+(b[k]-v)*i/count),boat,scale,body))return false;
  return true;
}
export function crewRoutineSegmentClear(s,boat,fromDesign,toDesign){
  const obstacles=crewNavigationObstacles(boat);if(!obstacles)return false;
  if(crewNavigationExtended(boat.modelId??'nina'))return true;
  const scale=crewNavigationScale(boat),body=crewNavigationEnvelope(s?.navigationBody),a=crewNavigationPhysical(fromDesign,scale),b=crewNavigationPhysical(toDesign,scale);
  return crewNavigationPathClear(a,b,boat,obstacles,body,scale);
}
export function crewNavigationSegmentClear(aMetres,bMetres,boat,options={}){
  const obstacles=crewNavigationObstacles(boat);if(!obstacles)return false;
  const scale=crewNavigationScale(boat),body=crewNavigationEnvelope(options);
  return crewNavigationPathClear(aMetres,bMetres,boat,obstacles,body,scale);
}
export function crewNavigationClear(pointMetres,boat,options={}){return crewNavigationSegmentClear(pointMetres,pointMetres,boat,options);}
// Only initial posting may choose another point. Existing actors instead walk
// a route to the result; this helper never changes an actor or vessel.
export function crewNavigationStation(pointDesign,boat,options={}){
  const obstacles=crewNavigationObstacles(boat);if(!obstacles)return null;
  if(crewNavigationExtended(boat.modelId??'nina'))return pointDesign.slice();
  const scale=crewNavigationScale(boat),body=crewNavigationEnvelope(options),p=crewNavigationPhysical(pointDesign,scale),candidates=[p];
  const near=obstacles.filter(o=>p[1]<o.max[1]&&p[1]+body.height>o.min[1]);
  for(const o of near){
    const x0=o.min[0]-body.radius-.02,x1=o.max[0]+body.radius+.02,z0=o.min[2]-body.radius-.02,z1=o.max[2]+body.radius+.02;
    for(const x of[x0,x1])candidates.push([x,p[1],p[2]]);
    for(const z of[z0,z1])candidates.push([p[0],p[1],z]);
    for(const x of[x0,x1])for(const z of[z0,z1])candidates.push([x,p[1],z]);
  }
  candidates.sort((a,b)=>Math.hypot(a[0]-p[0],a[2]-p[2])-Math.hypot(b[0]-p[0],b[2]-p[2]));
  for(const candidate of candidates){
    const q=crewNavigationDesign(candidate,scale),floor=modelDeck(boat,q[2]);
    if(Math.abs(floor-pointDesign[1])*scale[1]>.06||!crewNavigationOnDeck(candidate,boat,scale,body)||near.some(o=>crewNavigationInside(candidate,o,body)))continue;
    q[1]=floor;return q;
  }
  return null;
}
function crewNavigationDetour(a,b,boat,obstacles,body,scale){
  if(crewNavigationPathClear(a,b,boat,obstacles,body,scale))return[b];
  // A local visibility graph only on a single authored deck; never replace a
  // stair with a diagonal through its riser or move a route to another floor.
  if(Math.abs(a[1]-b[1])>.15)return null;
  const margin=body.radius+.025,reach=2,low=[Math.min(a[0],b[0])-reach,Math.min(a[2],b[2])-reach],high=[Math.max(a[0],b[0])+reach,Math.max(a[2],b[2])+reach],nodes=[a,b];
  for(const o of obstacles){
    if(a[1]>=o.max[1]||a[1]+body.height<=o.min[1]||o.max[0]+margin<low[0]||o.min[0]-margin>high[0]||o.max[2]+margin<low[1]||o.min[2]-margin>high[1])continue;
    for(const x of[o.min[0]-margin,o.max[0]+margin])for(const z of[o.min[2]-margin,o.max[2]+margin]){
      if(nodes.length>=130)break;
      const y=modelDeck(boat,z/scale[2])*scale[1],p=[x,y,z];
      if(Math.abs(y-a[1])<.15&&crewNavigationOnDeck(p,boat,scale,body)&&!obstacles.some(q=>crewNavigationInside(p,q,body)))nodes.push(p);
    }
  }
  const distance=nodes.map(()=>Infinity),parent=nodes.map(()=>-1),visited=new Set();distance[0]=0;
  for(let step=0;step<nodes.length;step++){
    let current=-1;for(let i=0;i<nodes.length;i++)if(!visited.has(i)&&(current<0||distance[i]<distance[current]))current=i;
    if(current<0||!Number.isFinite(distance[current]))break;if(current===1)break;visited.add(current);
    for(let next=1;next<nodes.length;next++)if(!visited.has(next)){
      const cost=distance[current]+Math.hypot(...nodes[next].map((v,i)=>v-nodes[current][i]));
      if(cost>=distance[next]||!crewNavigationPathClear(nodes[current],nodes[next],boat,obstacles,body,scale))continue;
      distance[next]=cost;parent[next]=current;
    }
  }
  if(parent[1]<0)return null;const path=[];for(let index=1;index>0;index=parent[index])path.push(nodes[index]);return path.reverse();
}
export function crewNavigationRoute(pathDesign,boat,options={}){
  const obstacles=crewNavigationObstacles(boat);if(!obstacles||!pathDesign?.length)return null;
  if(crewNavigationExtended(boat.modelId??'nina'))return pathDesign.map(p=>p.slice());
  const scale=crewNavigationScale(boat),body=crewNavigationEnvelope(options),points=pathDesign.map(p=>crewNavigationPhysical(p,scale));
  if(points.some(p=>!p.every(Number.isFinite))||!crewNavigationPathClear(points[0],points[0],boat,obstacles,body,scale))return null;
  const result=[points[0]];
  for(let i=1;i<points.length;i++){
    const detour=crewNavigationDetour(result.at(-1),points[i],boat,obstacles,body,scale);if(!detour)return null;
    for(const p of detour)if(Math.hypot(...p.map((v,k)=>v-result.at(-1)[k]))>1e-9)result.push(p);
  }
  return result.map(p=>crewNavigationDesign(p,scale));
}

// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Build subjects are sourced; offsets, service drafts, loading and working
// layouts below are authored interpretations, not recovered archaeological lines.
import {deepFreeze} from '../rig-definition.js';
import {prepareHullLoft,hullLoftWidth,hullLoftDeck,hullLoftSheer} from '../hull-loft.js';

const rowingModelStations=[-6,-5.7,-5,-4,-3,-1.5,0,1.5,3,4,5,5.7,6];
function rowingModelProfile({length,draft,freeboard,sheer,breadths,upper,bottom,flat=false}){
  const sy=length/12,D=draft/sy,deck=freeboard/sy;
  return prepareHullLoft({stations:rowingModelStations,levels:[-D,-D*.70,-D*.25,0,deck*.45,deck],
    sections:[flat?bottom:bottom.map(()=>0),bottom,breadths.map(w=>w*.94),breadths,breadths.map((w,i)=>w*.4+upper[i]*.6),upper],
    deck,sheerFore:sheer/sy,sheerAft:sheer/sy,bowRake:flat?.15:.35,sternRake:flat?.15:.35});
}
function rowingModelSail(frame,{height,mastHeight,head,foot,area,z=0}){
  const sx=frame.beam/3.6,sy=frame.length/12,drop=area/((head+foot)*.5),top=height/sy,Y=(height-drop)/sy,Z=z/sy-.06;
  return {masts:[{id:'main',z:z/sy,height:mastHeight/sy,radius:.065,rake:.06}],surfaces:[{id:1,name:'main-square',mast:0,controlGroup:'main',kind:'square',
    pivot:[0,top,Z],corners:[[-head/sx/2,top,Z],[head/sx/2,top,Z],[foot/sx/2,Y,Z],[-foot/sx/2,Y,Z]],belly:.16,braceLimit:.45,
    provenance:'Authored reconstruction sail dimensions; exact archaeological sail area is not established.'}]};
}
function rowingModelBuild({id,modelCode,name,length,beam,draft,freeboard,sheer,breadths,upper,bottom,flat=false,keelDepth=0,keelWidth=0,
  people,rowingPairs,stationFirst,stationLast,propulsor,sail,construction,interpretation,references}){
  const frame={length:12,beam:3.6,verticalScale:length/12},runtime={length,beam},sy=frame.verticalScale,sx=beam/3.6;
  const profile=rowingModelProfile({length,draft:draft-keelDepth,freeboard,sheer,breadths,upper,bottom,flat});
  const design={id,modelCode,name,revision:1,status:'planned',family:construction,frame,runtime,profile,
    interpretation,construction,referenceMeasurements:references,capabilities:{rowing:true,sailing:!!sail,steering:propulsor==='paddle'?'steering-paddle':'steering-oar',anchors:propulsor!=='paddle',gunnery:false},
    floorHeight:(freeboard-.48)/sy,seatHeight:(freeboard-.13)/sy,shellThickness:(propulsor==='paddle'?.055:.035)/sy,shellThicknessMetres:propulsor==='paddle'?.055:.035,
    keel:keelDepth?{bounds:[-5.65,5.65],depth:keelDepth/sy,width:keelWidth/sx}:null,
    loading:{crew:people,personKg:80,personCGAboveSeat:.35,waterKgPerDay:4,foodKgPerDay:1.2,casksKg:id==='oseberg'?180:id==='lusoria'?80:45,
      sparesKg:id==='oseberg'?350:id==='lusoria'?200:70,defaultProvisionDays:id==='oseberg'?7:id==='lusoria'?2:1,designIncludesManifest:true,gmBeamFraction:id==='oseberg'?.13:id==='lusoria'?.16:.18,
      structureFloorThicknessMetres:.025,
      provenance:'Authored service manifest; reported hull weight/tonnage is retained only as source metadata.'},
    propulsion:{kind:propulsor,driveFraction:.44,cadence:.45,maxCadence:.70,catchAngle:.52,
      bladeLength:propulsor==='paddle'?.55:.62,bladeWidth:propulsor==='paddle'?.18:.15,bladeThickness:.018,
      outboard:propulsor==='paddle'?0:id==='oseberg'?2.80:2.45,inboard:.80,shaftRadius:propulsor==='paddle'?.022:.028,
      maxHandForce:300,maxPower:210,dragCoefficient:1.6,normalDragProvenance:'Authored effective plate drag and human force/power limits; not measured replica trials.'},
    ...(sail?rowingModelSail(runtime,sail):{masts:[],surfaces:[]}),stations:[],crewStations:{},equipment:{guns:[],bailer:true,anchor:propulsor!=='paddle',cargo:[{z:3.8,extent:[.32,.16,.5]}]},
  };
  for(let row=0;row<rowingPairs;row++)for(const side of [-1,1]){
    const z=(stationFirst+(stationLast-stationFirst)*row/Math.max(1,rowingPairs-1))/sy,y=hullLoftDeck(profile,z),width=hullLoftWidth(profile,z,y)*sx;
    const lockY=y+(id==='oseberg'?-.12:.065)/sy,lockWidth=id==='oseberg'?hullLoftWidth(profile,z,lockY)*sx:width;
    const inboard=Math.min(design.propulsion.inboard,width*.58),seatX=propulsor==='paddle'?side*Math.min(.32,width-.24):side*Math.max(.12,width-inboard*.82);
    const seatZ=z-(propulsor==='oar'?.14/sy:0);
    const station={id:'rower.'+(side<0?'port':'starboard')+'.'+String(row+1).padStart(2,'0'),index:design.stations.length,row,side,z,
      seat:[seatX/sx,design.seatHeight+hullLoftSheer(profile,seatZ),seatZ],
      pivot:propulsor==='oar'?[side*lockWidth/sx,lockY,z]:null,oarlock:propulsor==='oar'?(id==='oseberg'?'hull-port':'tholepins'):null,
      inboard,outboard:design.propulsion.outboard,kind:propulsor,phaseOffset:0};
    design.stations.push(station);design.crewStations[station.id]={x:station.seat[0],y:station.seat[1],z:station.seat[2],role:propulsor==='paddle'?'Paddler':'Rower',stationId:station.id,yaw:propulsor==='paddle'?Math.PI:0};
  }
  // Full complement and active rowing count are distinct, including the canoe.
  const remaining=people-design.stations.length;
  for(let i=0;i<remaining;i++){
    const steering=i===remaining-1,z=(id==='taino-canoe'?3.50+Math.floor(i/2)*.70:steering?length*.39:-length*.40)/sy,x=(i%2?1:-1)*(id==='taino-canoe'?.30:steering?.45:0)/sx;
    design.crewStations[steering?'helm':'passenger.'+(i+1)]={x,y:design.seatHeight+hullLoftSheer(profile,z),z,role:steering?'Helmsman':'Passenger',yaw:Math.PI};
  }
  const helm=design.crewStations.helm,steerZ=helm.z,steerY=hullLoftDeck(profile,steerZ),steerX=propulsor==='paddle'?Math.min(1.65,hullLoftWidth(profile,steerZ,steerY)-.08):hullLoftWidth(profile,steerZ,steerY)+.035;
  design.steering={kind:design.capabilities.steering,pivot:[steerX,steerY,steerZ],handle:[steerX-.25/sx,steerY+.28/sy,steerZ-.40/sy],
    blade:[steerX+.26/sx,-.28/sy,steerZ+.85/sy],bladeLength:.75,bladeWidth:.20,dragCoefficient:1.5,
    provenance:'Authored starboard steering-oar/paddle layout; not a recovered fitting arrangement.'};
  design.helm={x:helm.x,z:helm.z,eyeAboveDeck:1.4};
  return design;
}
export const ROWING_DESIGNS=deepFreeze({
  oseberg:rowingModelBuild({id:'oseberg',modelCode:4,name:'Oseberg-based vessel · c. 850',length:21.5,beam:5,draft:.75,freeboard:.60,sheer:.60,
    breadths:[0,.06,.32,.80,1.24,1.67,1.8,1.67,1.24,.80,.32,.06,0],upper:[0,.14,.50,1.03,1.45,1.75,1.8,1.75,1.45,1.03,.50,.14,0],
    bottom:[0,.015,.09,.27,.45,.62,.68,.62,.45,.27,.09,.015,0],keelDepth:.12,keelWidth:.12,people:32,rowingPairs:15,stationFirst:-6.4,stationLast:6.4,propulsor:'oar',
    sail:{height:9.5,mastHeight:10.6,head:9,foot:9.5,area:69.375,z:0},construction:'clinker-oak',
    interpretation:'AD 820 Oseberg proportions in a c. 850 scenario, guided by the revised Saga Oseberg reconstruction; authored offsets, .75 m service draft and rig dimensions.',
    references:[{subject:'archaeological-vessel',source:'https://www.vikingtidsmuseet.no/vikingtiden/vikingskip/osebergskipet.html',
      dimensions:[{kind:'hull-length-not-LWL',metres:21.5},{kind:'beam',metres:5}],rowers:30,crew:32,displacement:null,draught:null},
      {subject:'reconstruction-method',source:'https://www.vikingeskibsmuseet.dk/en/professions/boatyard/building-projects/the-oseberg-ship'}]}),
  lusoria:rowingModelBuild({id:'lusoria',modelCode:5,name:'Lusoria Rhenana interpretation · c. 350',length:18,beam:2.8,draft:.38,freeboard:.55,sheer:.22,
    breadths:[0,.12,.58,1.19,1.57,1.77,1.8,1.77,1.57,1.19,.58,.12,0],upper:[0,.20,.70,1.32,1.67,1.79,1.8,1.79,1.67,1.32,.70,.20,0],
    bottom:[0,.04,.26,.74,1.10,1.32,1.36,1.32,1.10,.74,.26,.04,0],flat:true,people:26,rowingPairs:12,stationFirst:-5.2,stationLast:5.2,propulsor:'oar',
    sail:{height:7.2,mastHeight:9,head:4.2,foot:4.2,area:20,z:-.20},construction:'smooth-oak-flat-bottom',
    interpretation:'18 m Mainz/Lusoria Rhenana riverine reconstruction branch, not a trireme; authored .38 m loaded draft and 26-person service company. Replica 5 t weight is not assumed loaded displacement.',
    references:[{subject:'modern-reconstruction',source:'https://lusoriarhenana.de/schiff/',dimensions:[{kind:'hull-length',metres:18},{kind:'beam',metres:2.8},{kind:'mast-height',metres:9}],
      rowers:24,sailArea:{metresSquared:20,kind:'experimental'},weight:{kilograms:5000,kind:'vessel-weight-loading-unspecified'},draught:null},
      {subject:'competing-reconstruction-branches',source:'https://www.donau-uni.ac.at/dam/jcr%3A74a2a26d-90e5-41d6-84e1-cfb3cb91738f/LDL_Technical%20features%20of%20Roman%20Danube%20Ships.pdf'}]}),
  'taino-canoe':rowingModelBuild({id:'taino-canoe',modelCode:6,name:'Taíno-style thirty-person dugout · c. 1492',length:14,beam:1.8,draft:.42,freeboard:.42,sheer:.20,
    breadths:[0,.08,.40,.94,1.38,1.72,1.8,1.72,1.38,.94,.40,.08,0],upper:[0,.14,.58,1.17,1.56,1.78,1.8,1.78,1.56,1.17,.58,.14,0],
    bottom:[0,.025,.15,.45,.74,.94,1.00,.94,.74,.45,.15,.025,0],people:30,rowingPairs:12,stationFirst:-4.9,stationLast:2.8,propulsor:'paddle',construction:'single-ceiba-dugout',
    interpretation:'Greater Antillean single-log design target, authored 14 × 1.8 m, .42 m service draft and 30 occupants (24 paddlers, five passengers and steering paddler); no European keel or sails.',
    references:[{subject:'translated-observer-account',source:'https://pressbooks.nvcc.edu/ushistory/chapter/journal-of-christopher-columbus-1492/',capacityObserved:[40,45],dimensions:null},
      {subject:'comparative-ceiba-construction',source:'https://www.floridamuseum.ufl.edu/caribarch/education/ceiba/'}]}),
});

export function rowingDesign(id){if(!Object.hasOwn(ROWING_DESIGNS,id))throw Error('No rowing vessel design: '+id);return ROWING_DESIGNS[id];}
export function rowingHullWidth(id,z,y){return hullLoftWidth(rowingDesign(id).profile,z,y);}
export function rowingHullDeck(id,z){return hullLoftDeck(rowingDesign(id).profile,z);}
export function rowingDeck(id,z){const d=rowingDesign(id);return d.floorHeight+hullLoftSheer(d.profile,z);}
export function rowingDeckWidth(id,z){const d=rowingDesign(id);return Math.max(0,hullLoftWidth(d.profile,z,rowingDeck(id,z))-.05/(d.runtime.beam/d.frame.beam));}
const rowingRigContexts=new Map();
export function rowingRigContext(id){
  if(rowingRigContexts.has(id))return rowingRigContexts.get(id);
  const d=rowingDesign(id),masts=d.masts.map((m,index)=>({...m,index,controlGroup:m.controlGroup??d.surfaces.find(s=>s.mast===index)?.controlGroup??'main',foot:[0,rowingDeck(id,m.z),m.z],head:[0,m.height,m.z+(m.rake??0)]})),supports=[],lines=[],controlStations={};
  const mastPoint=(index,y)=>{const m=masts[index];if(!m)throw Error('No rowing mast '+index);const t=(y-m.foot[1])/(m.head[1]-m.foot[1]);return m.foot.map((v,i)=>v+(m.head[i]-v)*t);};
  for(const [index,m] of masts.entries()){
    for(const side of [-1,1])for(const offset of [-.65,.65]){
      const z=m.z+offset,y=rowingHullDeck(id,z),a=[side*(rowingHullWidth(id,z,y)-.025),y,z];supports.push({a,b:m.head,r:.008,kind:'shroud',mast:index,side});
    }
    for(const z of [-5.2,5.2])supports.push({a:[0,rowingHullDeck(id,z),z],b:m.head,r:.009,kind:'stay',mast:index,side:0});
  }
  for(const s of d.surfaces){
    for(const [a,b]of [[[0,0],[1,0]],[[1,0],[1,1]],[[1,1],[0,1]],[[0,1],[0,0]]])
      lines.push({surface:s.id,clothEdge:[a,b],kind:'bolt-rope',r:.006});
    for(const side of [-1,1]){
      const z=2.5,y=rowingHullDeck(id,z),x=side*Math.max(.2,rowingHullWidth(id,z,y)-.08);
      lines.push({a:{surface:s.id,uv:[side<0?0:1,1]},b:[x,y,z],kind:'sheet',side,paired:false,sag:.035,r:.007});
      lines.push({a:{surface:s.id,point:s.corners[side<0?0:1]},b:[x,rowingHullDeck(id,3.5),3.5],kind:'brace',side,sag:.03,r:.007});
    }
    lines.push({a:masts[s.mast].head,b:{surface:s.id,point:s.pivot},kind:'halyard',sag:.015,r:.008});
    if(!controlStations[s.controlGroup]){
      const rows=[...new Set(d.stations.map(row=>row.seat[2]))].sort((a,b)=>a-b),m=d.masts[s.mast];
      const at=rows.findIndex(z=>z>m.z+.1),z=at>0?(rows[at-1]+rows[at])*.5:m.z+.3,x=.18;
      const lead=[x,rowingDeck(id,z)+.88/d.frame.verticalScale,z],lineIndex=lines.length;
      lines.push({a:masts[s.mast].head,b:lead,kind:'working-fall',mast:s.mast,controlGroup:s.controlGroup,sag:.01,r:.008});
      controlStations[s.controlGroup]={id:'haul.'+s.controlGroup,mast:s.mast,controlGroup:s.controlGroup,kind:'haul',position:[x+.16,rowingDeck(id,z),z],lead,lineIndex};
    }
  }
  const context=deepFreeze({surfaces:d.surfaces,masts,supports,lines,controlStations,mastPoint});rowingRigContexts.set(id,context);return context;
}

// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Planned, independent reconstructions. Reported particulars remain separate
// from authored offsets, trim, working sail dimensions and simulation loading.
import {deepFreeze} from '../rig-definition.js';
import {prepareHullLoft,hullLoftWidth,hullLoftDeck,hullLoftSheer} from '../hull-loft.js';

const laterSailFoot=.3048,laterSailPound=.45359237;
const laterSailCloudSource='https://www.sobco.com/ship_model/BDA/1851-04-25.html';
const laterSailCloudMuseum='https://catalogs.marinersmuseum.org/object/CL17938';
const laterSailMothArchive='https://www.nautipedia.it/2024_02_Review:_Behind_the_scenes_of_a_famous_adventure:_Yard_No._916_GIPSY_MOTH_IV';
const laterSailCloudFrame={length:12,beam:3.6,verticalScale:225*laterSailFoot/12};
const laterSailCloudRuntime={length:225*laterSailFoot,beam:41*laterSailFoot};
const laterSailMothFrame={length:12,beam:3.6,verticalScale:53.1*laterSailFoot/12};
const laterSailMothRuntime={length:53.1*laterSailFoot,beam:10.5*laterSailFoot};

function laterSailPrepareProfile({stations,levels,sections,deck,sheerFore,sheerAft,bowRake,sternRake}){
  return prepareHullLoft({stations,levels,sections,deck,sheerFore,sheerAft,bowRake,sternRake});
}
function laterSailDeckOf(design,z,x=0){
  let height=design.profile.deck;
  for(const zone of design.deckZones)if(z>=zone.bounds[0]&&z<=zone.bounds[1])height=Math.max(height,zone.height);
  const c=design.cockpit;
  if(c&&z>c.bounds[0]&&z<c.bounds[1]&&Math.abs(x)<c.halfWidth)height=c.floorHeight;
  return height+hullLoftSheer(design.profile,z);
}
function laterSailMastAt(design,mast,y){
  const m=design.masts[mast],floor=laterSailDeckOf(design,m.z),t=(y-floor)/(m.height-floor);
  return [0,y,m.z+(m.rake??0)*t];
}
function laterSailMastRadiusAt(design,mast,y){
  const m=design.masts[mast],floor=laterSailDeckOf(design,m.z),t=Math.max(0,Math.min(1,(y-floor)/(m.height-floor)));
  // Exact linear taper drawn by createLaterSailShipMesh, not a full-height
  // cylinder or a force-dependent clearance masquerading as hardware.
  return m.radius*(1-.76*t);
}
function laterSailSquare(design,id,name,mast,headY,footY,yardFt,armFt,footFt){
  const m=design.masts[mast],pivot=laterSailMastAt(design,mast,headY),sx=design.runtime.beam/design.frame.beam;
  const axis=laterSailMastAt(design,mast,m.height).map((v,i)=>v-laterSailMastAt(design,mast,laterSailDeckOf(design,m.z))[i]);
  const yardRadius=.025,clearance=.012/design.frame.verticalScale;
  const standOff=(laterSailMastRadiusAt(design,mast,headY)+yardRadius+clearance)*Math.hypot(...axis)/axis[1];
  const z=pivot[2]-standOff,footStandOff=(laterSailMastRadiusAt(design,mast,footY)+clearance)*Math.hypot(...axis)/axis[1];
  const footZ=laterSailMastAt(design,mast,footY)[2]-footStandOff;
  const head=(yardFt-2*armFt)*laterSailFoot/sx,foot=footFt*laterSailFoot/sx;
  return {id,name,mast,controlGroup:m.controlGroup,kind:'square',pivot,mastContactSide:'fore',
    corners:[[-head/2,headY,z],[head/2,headY,z],[foot/2,footY,footZ],[-foot/2,footY,footZ]],
    belly:Math.min(.18,(headY-footY)*.11),braceLimit:.67,footRise:.035,contactClearance:.035,
    yardStandOff:{kind:'tapered-mast-and-yard',distance:standOff,clearance},
    spars:[{id:name+'-yard',kind:'yard',a:[-yardFt*laterSailFoot/sx/2,headY,z],b:[yardFt*laterSailFoot/sx/2,headY,z],radius:yardRadius}],
    provenance:{shape:'authored working cloth, with reported yard/yardarm spans',source:laterSailCloudSource,yardLengthFt:yardFt,yardarmFt:armFt}};
}
function laterSailTriangle(id,name,mast,controlGroup,kind,corners,extra={}){
  return {id,name,mast,controlGroup,kind,corners,pivot:[...corners[0]],belly:.10,braceLimit:1.35,
    sewnEdges:kind==='bermudan'?['v0','u0']:['v0'],camberAxis:[1,0,0],contactClearance:.025,...extra};
}
function laterSailGaff(id,name,mast,controlGroup,corners,pivot,extra={}){
  return {id,name,mast,controlGroup,kind:'gaff',corners,pivot,belly:.13,braceLimit:1.30,sewnEdges:['v0','u0'],camberAxis:[1,0,0],...extra};
}
function laterSailTrackGaff(design,surface){
  const m=design.masts[surface.mast],a=surface.corners[0],d=surface.corners[3];
  const low=laterSailMastAt(design,surface.mast,d[1]),high=laterSailMastAt(design,surface.mast,a[1]);
  const foot=laterSailMastAt(design,surface.mast,laterSailDeckOf(design,m.z)),head=laterSailMastAt(design,surface.mast,m.height),axis=head.map((v,i)=>v-foot[i]);
  const clearance=.012/design.frame.verticalScale,cosine=axis[1]/Math.hypot(...axis);
  const rootRadius=point=>Math.max(0,...(surface.spars??[]).flatMap(s=>[
    s.a.every((v,i)=>v===point[i])?s.radius:0,s.b.every((v,i)=>v===point[i])?s.radius*.70:0]));
  // Sewn luff follows mast hoops/travellers outside the actual tapered spar.
  // Brace around that mast's real rake, preserving clearance as the gaff swings.
  const sewnA=[0,a[1],high[2]+(laterSailMastRadiusAt(design,surface.mast,a[1])+rootRadius(a)+clearance)/cosine];
  const sewnD=[0,d[1],low[2]+(laterSailMastRadiusAt(design,surface.mast,d[1])+rootRadius(d)+clearance)/cosine];
  const replacement=p=>p.every((v,i)=>v===a[i])?sewnA:p.every((v,i)=>v===d[i])?sewnD:p;
  return {...surface,pivot:low,hingeAxis:axis,mastContactSide:'aft',corners:[sewnA,surface.corners[1],surface.corners[2],sewnD],
    spars:surface.spars?.map(s=>({...s,a:replacement(s.a),b:replacement(s.b)})),
    luffTrack:{kind:'tapered-mast-hoops',clearance}};
}
function laterSailStayHead(design,surface){
  const m=design.masts[surface.mast],head=surface.corners[1],at=laterSailMastAt(design,surface.mast,head[1]);
  const foot=laterSailMastAt(design,surface.mast,laterSailDeckOf(design,m.z)),top=laterSailMastAt(design,surface.mast,m.height),axis=top.map((v,i)=>v-foot[i]);
  const clearance=.012/design.frame.verticalScale,stayRadius=.008/(design.runtime.beam/design.frame.beam);
  const offset=(laterSailMastRadiusAt(design,surface.mast,head[1])+stayRadius+clearance)*Math.hypot(...axis)/axis[1];
  // A stay terminates at a tang outside the mast. Placing the pinned head on
  // the axis leaves the actual canvas embedded even when free cloth collides.
  return {...surface,mastContactSide:'fore',corners:[surface.corners[0],[0,head[1],at[2]-offset],surface.corners[2]],
    headFitting:{kind:'mast-fore-tang',clearance,stayRadius}};
}
function laterSailCloudCrew(){
  const ids=['ines','tomas','beatriz','duarte','joao','catarina','leonor','rui','maria','afonso','isabel','pedro'];
  const positions=[[-.62,4.6],[.62,4.6],[-1,-3.15],[1,-3.15],[-1.10,-.5],[1.10,-.5],[-1.1,1],[1.1,1],[-.45,-5.1],[.45,-5.1],[-.8,3.15],[0,5.05]];
  return Object.fromEntries(ids.map((id,i)=>{const [x,z]=positions[i];return[id,{x,z,route:i===11?[z,z]:[z,z+.16],yaw:i===11?Math.PI:undefined}];}));
}

const laterSailCloud={
  id:'flying-cloud',modelCode:7,name:'Flying Cloud · 1851',revision:2,status:'planned',family:'extreme-clipper',
  frame:laterSailCloudFrame,runtime:laterSailCloudRuntime,
  interpretation:'1851 departure interpretation. Deck length and 41-foot beam select the contemporary report; all hull offsets and loaded draft are authored, not recovered McKay lines.',
  readiness:{backend:'surfaces-v1',requires:['independent loft/freeboard calibration','per-surface spars and cloth/rope clearance','wheel and deckhouse routes','loaded inertia and working crew','rendered and fleet checks']},
  profile:laterSailPrepareProfile({stations:[-6,-5.7,-5.1,-4.2,-3,-1.5,0,1.5,3,4.2,5.1,5.7,6],
    levels:[-.91,-.68,-.32,0,.52,.92,1.45],deck:.52,sheerFore:.16,sheerAft:.11,bowRake:.35,sternRake:6-(-5.65+208*laterSailFoot/laterSailCloudFrame.verticalScale),
    sections:[
      [0,0,0,0,0,0,0,0,0,0,0,0,0],
      [0,.01,.06,.20,.47,.68,.72,.70,.56,.34,.11,.015,0],
      [0,.025,.15,.47,.93,1.40,1.49,1.45,1.16,.70,.27,.05,0],
      [0,.045,.25,.68,1.23,1.67,1.80,1.76,1.49,1.03,.49,.16,.025],
      [0,.12,.40,.85,1.36,1.72,1.80,1.77,1.55,1.18,.75,.48,.31],
      [0,.12,.40,.85,1.34,1.70,1.78,1.75,1.53,1.16,.72,.46,.30],
      [0,.11,.38,.81,1.29,1.64,1.71,1.69,1.47,1.11,.70,.44,.28],
    ]}),
  deckZones:[{id:'main',bounds:[-6,6],height:.52},
    {id:'forecastle',bounds:[-6,-6+30*laterSailFoot/laterSailCloudFrame.verticalScale],height:.79},
    {id:'poop',bounds:[6-68*laterSailFoot/laterSailCloudFrame.verticalScale,6],height:.52+5*laterSailFoot/laterSailCloudFrame.verticalScale}],
  structures:[{id:'deckhouse',kind:'deckhouse',centre:[0,.52+6.5*laterSailFoot/(2*laterSailCloudFrame.verticalScale),-1.35],
    size:[18*laterSailFoot/(laterSailCloudRuntime.beam/3.6),6.5*laterSailFoot/laterSailCloudFrame.verticalScale,41*laterSailFoot/laterSailCloudFrame.verticalScale],
    source:laterSailCloudSource,placement:'authored abaft foremast; reported dimensions'}],
  barrier:5*laterSailFoot/laterSailCloudFrame.verticalScale,
  keel:{kind:'structural-timber',bounds:[-5.65,-5.65+208*laterSailFoot/laterSailCloudFrame.verticalScale],depth:.045,width:16/12*laterSailFoot/(laterSailCloudRuntime.beam/3.6),material:'rock-maple',provenance:'Reported keel length retained; exposed depth and endpoint placement authored.'},
  helm:{x:.50,z:4.8,eyeAboveDeck:1.6},
  steering:{kind:'rudder',control:'wheel-and-tiller',pivot:[0,-.32,5.48],handle:[0,.96,4.85],
    wheel:{centre:[0,1.01,4.85],radius:.75/laterSailCloudFrame.verticalScale,axis:[0,0,1]},
    rudder:{kind:'sternpost',outline:[[-.20,5.48],[-.82,5.48],[-.79,5.86],[-.18,5.76]],thickness:.035},provenance:'Authored steering attachments pending period plan.'},
  masts:[{id:'fore',controlGroup:'fore',z:-3.38,height:8.45,radius:.128,rake:.76},
    {id:'main',controlGroup:'main',z:-.18,height:9.10,radius:.132,rake:.83},
    {id:'mizzen',controlGroup:'mizzen',z:3.38,height:7.45,radius:.095,rake:.65}],
  surfaces:[],
  bowsprit:{a:[0,.78,-5.35],b:[0,1.38,-8.25],radius:.105,
    sections:[{kind:'bowsprit',outboardFt:20,diameterIn:28.5},{kind:'jibboom',innerJibFt:16,outerJibFt:13,endFt:5,diameterIn:16.5}],source:laterSailCloudSource},
  hatch:{centre:[0,.55,.68],size:[.75,.04,.58]},
  crewStations:laterSailCloudCrew(),
  loading:{crew:42,personKg:80,waterKgPerDay:5,foodKgPerDay:1.5,casksKg:4500,sparesKg:20000,designIncludesManifest:true,gmBeamFraction:.15,
    ballastKg:null,permanentMassKg:null,referenceDisplacementKg:null,authoredDraftMetres:(.91+.045)*laterSailCloudFrame.verticalScale,
    interpretation:'Authored 42-person departure manifest and stores; hydrostatic mass/ballast must be calibrated. Register tonnage is never converted to mass.'},
  equipment:{anchors:true,guns:[],gunProvenance:'No armament inferred from Victory or the caravels.'},
  references:[
    {subject:'contemporary-report-transcription',source:laterSailCloudSource,date:'1851-04-25',selected:true,
      dimensions:[{kind:'keel-length',value:208,unit:'ft',metres:208*laterSailFoot},{kind:'deck-length',value:225,unit:'ft',metres:225*laterSailFoot},{kind:'knightheads-to-taffrail',value:235,unit:'ft',metres:235*laterSailFoot},{kind:'extreme-beam',value:41,unit:'ft',metres:41*laterSailFoot},{kind:'hold-depth-not-draft',value:21.5,unit:'ft',metres:21.5*laterSailFoot}],
      tonnage:{value:1750,unit:'register-tons',kind:'anticipated-register-tonnage',approximate:true},draft:null,displacement:null,sailArea:null,
      reportedYardsFt:{fore:[70,55,44.5,32,22],main:[82,64,50,37,24],mizzen:[56,45,33,25,20]},
      reportedMastPartsFt:{fore:[82,46,25,17,13],main:[88,51,28,19,14.5],mizzen:[78,40,22,14,10]},
      note:'Spar section lengths are not summed as mast height: step and overlaps require plans. Cloth heights, mast placement and truck heights remain authored.'},
    {subject:'museum-print-inscription-and-notes',source:laterSailCloudMuseum,selected:false,
      dimensions:[{kind:'extreme-beam',value:40,unit:'ft',metres:40*laterSailFoot}],
      tonnageReports:[{value:1139,unit:'register-tons',kind:'inscription-register-tonnage'},{value:1782,unit:'tons',kind:'museum-notes-tonnage-unspecified'}],
      note:'Restrike of an 1852 composition; beam and tonnage conflict with other reports. Retained, not averaged.'},
    {subject:'model-plan-research-finding-aid',source:'https://research.mysticseaport.org/coll/coll261/',locator:'Alexander G. Law collection, box3 folder4',note:'Research lead; no claim of recovered builder offsets.'},
  ],
};

// An 1851 single topsail on each mast, followed by topgallant, royal, skysail.
// Cloth widths derive from reported yard spans; vertical placement is authored.
const laterSailCloudTierNames=['course','topsail','topgallant','royal','skysail'];
const laterSailCloudYards=[[70,55,44.5,32,22],[82,64,50,37,24],[56,45,33,25,20]];
const laterSailCloudArms=[[4.5,5,3,2,1.5],[4.5,5,3,2,1.5],[4,4.5,2.5,1.5,1]];
const laterSailCloudHeads=[[3.27,5.28,6.50,7.33,7.96],[3.55,5.65,6.90,7.80,8.42],[3.08,4.77,5.75,6.48,7.00]];
const laterSailCloudFeet=[[.86,3.34,5.35,6.58,7.40],[.86,3.63,5.72,6.99,7.89],[1.05,3.16,4.85,5.83,6.56]];
for(let mast=0;mast<3;mast++)for(let tier=0;tier<5;tier++){
  const yard=laterSailCloudYards[mast][tier],arm=laterSailCloudArms[mast][tier],foot=tier?laterSailCloudYards[mast][tier-1]-2*laterSailCloudArms[mast][tier-1]:yard-2*arm;
  laterSailCloud.surfaces.push(laterSailSquare(laterSailCloud,mast*5+tier+1,laterSailCloud.masts[mast].id+'-'+laterSailCloudTierNames[tier],mast,laterSailCloudHeads[mast][tier],laterSailCloudFeet[mast][tier],yard,arm,foot));
}
laterSailCloud.surfaces.push(
  laterSailTriangle(16,'fore-topmast-staysail',0,'fore','headsail',[[0,.86,-5.75],[0,5.0,-2.95],[0,.95,-2.2]]),
  laterSailTriangle(17,'inner-jib',0,'fore','headsail',[[0,1.05,-6.9],[0,5.65,-2.86],[0,1.1,-3.7]]),
  laterSailTriangle(18,'outer-jib',0,'fore','headsail',[[0,1.37,-8.20],[0,6.45,-2.77],[0,1.4,-5.0]]),
  laterSailTriangle(19,'main-topmast-staysail',1,'main','headsail',[[0,1.15,-2.55],[0,5.4,.30],[0,1.2,.95]]),
  laterSailTriangle(20,'main-topgallant-staysail',1,'main','headsail',[[0,3.8,-2.9],[0,6.8,.43],[0,3.85,.8]]),
  laterSailTriangle(21,'main-royal-staysail',1,'main','headsail',[[0,5.6,-2.8],[0,7.7,.52],[0,5.7,.9]]),
  laterSailTriangle(22,'mizzen-topmast-staysail',2,'mizzen','headsail',[[0,1.25,.25],[0,4.8,3.85],[0,1.3,4.35]]),
  laterSailTriangle(23,'mizzen-topgallant-staysail',2,'mizzen','headsail',[[0,3.8,.3],[0,5.7,3.95],[0,3.85,4.3]]),
  laterSailGaff(24,'main-spencer',1,'main',[[0,3.10,.10],[0,3.45,1.30],[0,1.15,1.50],[0,1.15,-.10]],[0,1.15,-.10],{spars:[{id:'main-spencer-gaff',kind:'gaff',a:[0,3.10,.10],b:[0,3.45,1.30],radius:.022}]}),
  laterSailGaff(25,'mizzen-spanker',2,'mizzen',[[0,3.25,3.65],[0,4.0,5.65],[0,1.15,6.22],[0,1.15,3.30]],[0,1.15,3.30],
    {spars:[{id:'spanker-boom',kind:'boom',a:[0,1.15,3.30],b:[0,1.15,6.22],radius:.035},{id:'spanker-gaff',kind:'gaff',a:[0,3.25,3.65],b:[0,4.0,5.65],radius:.026}]})
);
laterSailCloud.surfaces=laterSailCloud.surfaces.map(s=>s.kind==='gaff'?laterSailTrackGaff(laterSailCloud,s):s.kind==='headsail'?laterSailStayHead(laterSailCloud,s):s);

const laterSailMothScale=laterSailMothFrame.verticalScale,laterSailMothX=laterSailMothRuntime.beam/3.6;
// Authored V-body refinement, not a recovered builder offset table. Keep the
// reported-waterline footprint/max beam, draft, sheer and lead-fin geometry
// fixed; take excess immersed volume out of the bilge/shoulder instead of
// changing displacement mass or moving the chosen waterline datum.
const laterSailMothBilgeScale=.68,laterSailMothShoulderScale=.72;
const laterSailMoth={
  id:'gipsy-moth-iv',modelCode:8,name:'Gipsy Moth IV · 1966',revision:3,status:'planned',family:'bermudan-ketch',
  frame:laterSailMothFrame,runtime:laterSailMothRuntime,
  interpretation:'Original design-DWL branch before voyage alterations. Builder-archive dimensions and original lead retained; hull/fin offsets, cockpit and sail dimensions are authored pending drawings.',
  readiness:{backend:'surfaces-v1',requires:['physical-mast/control-group separation','Bermudan luff/boom evaluator','profiled ballast keel in hydrostatics/contact/lateral force','recessed cockpit','singlehanded deck jobs','DWL displacement/ballast calibration','rendered clearance and fleet checks']},
  profile:laterSailPrepareProfile({stations:[-6,-5.2,-4.35,-3.5,-2,-.75,.75,2,3.5,4.35,5.2,6],
    levels:[-.88,-.62,-.25,0,.82,1.40].map(y=>y/laterSailMothScale),deck:.82/laterSailMothScale,
    sheerFore:.20/laterSailMothScale,sheerAft:.10/laterSailMothScale,bowRake:.45,sternRake:.55,
    sections:[
      [0,0,0,0,0,0,0,0,0,0,0,0],
      [0,0,0,.08,.35,.56,.62,.49,.19,0,0,0].map(w=>w*laterSailMothBilgeScale),
      [0,0,0,.40,1.04,1.35,1.40,1.18,.63,0,0,0].map(w=>w*laterSailMothShoulderScale),
      [0,0,0,.65,1.33,1.70,1.80,1.61,.96,0,0,0],
      [0,.12,.55,1.05,1.57,1.78,1.80,1.68,1.30,.92,.52,.23],
      [0,.11,.52,1.00,1.50,1.71,1.74,1.62,1.25,.88,.49,.22],
    ]}),
  deckZones:[{id:'main',bounds:[-6,6],height:.82/laterSailMothScale}],barrier:.56/laterSailMothScale,
  cockpit:{id:'cockpit',bounds:[2.0,4.55],halfWidth:.68,floorHeight:.29/laterSailMothScale,coamingHeight:.98/laterSailMothScale,provenance:'Authored recess; side walkways retain main deck.'},
  structures:[{id:'cabin',kind:'cabin',centre:[0,1.12/laterSailMothScale,-.45],size:[2.1/laterSailMothX,.60/laterSailMothScale,4.5/laterSailMothScale],provenance:'Authored deckhouse envelope; not a full-width raised deck.'}],
  keel:{kind:'profiled-ballast-fin',material:'lead-and-faired-structure',bounds:[-2.20,2.80],depth:(7.75*laterSailFoot-.88)/laterSailMothScale,width:.34/laterSailMothX,
    sections:[
      {y:-7.75*laterSailFoot/laterSailMothScale,zFore:-.35,zAft:1.80,halfWidth:.10/laterSailMothX},
      {y:-2.15/laterSailMothScale,zFore:-.75,zAft:2.15,halfWidth:.14/laterSailMothX},
      {y:-1.50/laterSailMothScale,zFore:-1.45,zAft:2.50,halfWidth:.17/laterSailMothX},
      {y:-.88/laterSailMothScale,zFore:-2.00,zAft:2.75,halfWidth:.14/laterSailMothX},
      {y:-.56/laterSailMothScale,zFore:-2.20,zAft:2.80,halfWidth:.08/laterSailMothX},
    ],
    ballast:{material:'lead',massKg:8490*laterSailPound,centre:[0,-1.72/laterSailMothScale,.8],positionKind:'authored',source:laterSailMothArchive},
    configuration:'original-design-branch; no Sydney aft extension',provenance:'Reported total draft/original lead; faired fin outline and thickness authored pending original drawings.'},
  helm:{x:.20,z:3.8,eyeAboveDeck:1.6},
  steering:{kind:'rudder',control:'direct-tiller',pivot:[0,-.40/laterSailMothScale,4.70],handle:[0,1.02/laterSailMothScale,3.50],
    rudder:{kind:'separate-profile',outline:[[-.40/laterSailMothScale,4.70],[-1.75/laterSailMothScale,4.25],[-1.90/laterSailMothScale,4.85],[-.40/laterSailMothScale,5.12]],thickness:.055/laterSailMothX},
    selfSteering:{kind:'Hasler-wind-vane',enabled:false},provenance:'Authored original-branch tiller/rudder envelope; 2005 larger rudder not adopted.'},
  masts:[{id:'main',controlGroup:'main',z:-1.15,height:14.4/laterSailMothScale,radius:.10/laterSailMothX,rake:.17},
    {id:'mizzen',controlGroup:'mizzen',z:2.7,height:9.8/laterSailMothScale,radius:.075/laterSailMothX,rake:.12}],
  surfaces:[],bowsprit:null,
  hatch:{centre:[0,1.42/laterSailMothScale,1.10],size:[.62/laterSailMothX,.055/laterSailMothScale,.60/laterSailMothScale]},
  crewStations:{ines:{x:0,z:3.85,route:[3.85,3.85],yaw:0,roles:['captain','helmsman','sail-handler']}},
  loading:{crew:1,personKg:80,waterKgPerDay:5,foodKgPerDay:1.5,casksKg:40,sparesKg:150,designIncludesManifest:true,gmBeamFraction:.14,
    ballastKg:8490*laterSailPound,permanentMassKg:null,referenceDisplacementKg:23320*laterSailPound,
    referenceCondition:'builder original design-DWL, not verified 1966 departure or 1967 Sydney condition',
    authoredDraftMetres:7.75*laterSailFoot,interpretation:'Stores/person mass are authored. DWL figure includes unspecified design loading; do not add it as empty-hull mass.'},
  equipment:{anchors:true,guns:[],gunProvenance:'Unarmed yacht.',engine:{installed:true,enabled:false,powerHp:36,kind:'Perkins4107M',source:laterSailMothArchive}},
  references:[
    {subject:'attributed-builder-archive-notes',source:laterSailMothArchive,author:'Jeremy Lines',date:'2024-02',selected:true,
      dimensions:[{kind:'length-overall',value:53.1,unit:'ft',metres:53.1*laterSailFoot},{kind:'length-between-perpendiculars',value:42.7,unit:'ft',metres:42.7*laterSailFoot},{kind:'length-waterline',value:38.5,unit:'ft',metres:38.5*laterSailFoot},{kind:'beam',value:10.5,unit:'ft',metres:10.5*laterSailFoot},{kind:'draught',value:7.75,unit:'ft',metres:7.75*laterSailFoot}],
      displacement:{value:23320,unit:'lb',kg:23320*laterSailPound,kind:'original-design-DWL'},ballast:{value:8490,unit:'lb',kg:8490*laterSailPound,material:'lead',kind:'original'},
      tonnage:{value:19,unit:'Thames-measurement-tons',kind:'tonnage-not-mass'},
      note:'Additional trial ballast, Sydney aft keel extension, and the later replacement rudder are distinct configurations. Original plans remain required.'},
    {subject:'museum-voyage-and-ketch-account',source:'https://www.rmg.co.uk/collections/objects/rmgc-object-13959',selected:true,crew:{count:1,kind:'historical-singlehanded-voyage'},note:'Painting dimensions are object measurements.'},
    {subject:'restored-1966-2005-broker-specification',source:'https://boatmanager.sandemanyachtcompany.co.uk/uploads/pdf/GIPSY_MOTH_IV%20-%20Sandeman.pdf',selected:false,
      displacement:{value:16,unit:'tonnes',kind:'restored-vessel-report'},note:'Not averaged with original design DWL.'},
  ],
};
const laterSailMothMainTack=laterSailMastAt(laterSailMoth,0,1.35/laterSailMothScale),laterSailMothMainHead=laterSailMastAt(laterSailMoth,0,14.0/laterSailMothScale);
const laterSailMothMizzenTack=laterSailMastAt(laterSailMoth,1,1.45/laterSailMothScale),laterSailMothMizzenHead=laterSailMastAt(laterSailMoth,1,9.35/laterSailMothScale);
// Affine model radii, not x-metre radii applied along a differently scaled z
// axis. The gooseneck clears the finite boom; the pinned head clears the taper.
for(const [index,points,boomRadius]of [[0,[laterSailMothMainTack,laterSailMothMainHead],.065/laterSailMothX],[1,[laterSailMothMizzenTack,laterSailMothMizzenHead],.05/laterSailMothX]]){
  const m=laterSailMoth.masts[index],foot=laterSailMastAt(laterSailMoth,index,laterSailDeckOf(laterSailMoth,m.z)),top=laterSailMastAt(laterSailMoth,index,m.height),axis=top.map((v,i)=>v-foot[i]);
  for(const [j,point]of points.entries())point[2]+=(laterSailMastRadiusAt(laterSailMoth,index,point[1])+(j===0?boomRadius:0)+.012/laterSailMothScale)*Math.hypot(...axis)/axis[1];
}
const laterSailMothBoomY=1.35/laterSailMothScale,laterSailMothMizzenAtBoom=laterSailMastAt(laterSailMoth,1,laterSailMothBoomY);
const laterSailMothMizzenAxis=laterSailMastAt(laterSailMoth,1,laterSailMoth.masts[1].height).map((v,i)=>v-laterSailMastAt(laterSailMoth,1,laterSailDeckOf(laterSailMoth,laterSailMoth.masts[1].z))[i]);
// The finite main boom and its clew terminate ahead of the mizzen shaft, not
// merely ahead of its centreline. Preserve the authored 4.75 m span as a cap.
const laterSailMothMainBoomEnd=Math.min(laterSailMothMainTack[2]+4.75/laterSailMothScale,
  laterSailMothMizzenAtBoom[2]-(laterSailMastRadiusAt(laterSailMoth,1,laterSailMothBoomY)+.065/laterSailMothX+.012/laterSailMothScale)*Math.hypot(...laterSailMothMizzenAxis)/laterSailMothMizzenAxis[1]);
const laterSailMothMainClew=[0,laterSailMothBoomY,laterSailMothMainBoomEnd],laterSailMothMizzenClew=[0,1.45/laterSailMothScale,laterSailMothMizzenTack[2]+2.75/laterSailMothScale];
laterSailMoth.surfaces.push(
  laterSailTriangle(1,'mainsail',0,'main','bermudan',[laterSailMothMainTack,laterSailMothMainHead,laterSailMothMainClew],
    {belly:.14,rotationAxis:'luff',mastContactSide:'aft',spars:[{id:'main-boom',kind:'boom',a:laterSailMothMainTack,b:laterSailMothMainClew,radius:.065/laterSailMothX}]}),
  laterSailTriangle(2,'mizzen',1,'mizzen','bermudan',[laterSailMothMizzenTack,laterSailMothMizzenHead,laterSailMothMizzenClew],
    {belly:.10,rotationAxis:'luff',mastContactSide:'aft',spars:[{id:'mizzen-boom',kind:'boom',a:laterSailMothMizzenTack,b:laterSailMothMizzenClew,radius:.05/laterSailMothX}]}),
  laterSailTriangle(3,'working-jib',0,'fore','headsail',[[0,.90/laterSailMothScale,-5.15],laterSailMastAt(laterSailMoth,0,12.9/laterSailMothScale),[0,1.10/laterSailMothScale,.30]],{belly:.16}),
  laterSailTriangle(4,'inner-staysail',0,'fore','headsail',[[0,.92/laterSailMothScale,-3.35],laterSailMastAt(laterSailMoth,0,9.70/laterSailMothScale),[0,1.10/laterSailMothScale,.15]],{belly:.11})
);
laterSailMoth.surfaces=laterSailMoth.surfaces.map(s=>s.kind==='headsail'?laterSailStayHead(laterSailMoth,s):s);

export const LATER_SAIL_DESIGNS=deepFreeze({'flying-cloud':laterSailCloud,'gipsy-moth-iv':laterSailMoth});
export function laterSailDesign(id){const d=LATER_SAIL_DESIGNS[id];if(!d)throw Error('No later sailing design: '+id);return d;}
export function laterSailHullWidth(id,z,y){return hullLoftWidth(laterSailDesign(id).profile,z,y);}
export function laterSailHullDeck(id,z){return hullLoftDeck(laterSailDesign(id).profile,z);}
export function laterSailDeck(id,z,x=0){return laterSailDeckOf(laterSailDesign(id),z,x);}
export function laterSailDeckWidth(id,z){const d=laterSailDesign(id);let y=d.profile.deck;for(const zone of d.deckZones)if(z>=zone.bounds[0]&&z<=zone.bounds[1])y=Math.max(y,zone.height);return Math.max(0,laterSailHullWidth(id,z,y+hullLoftSheer(d.profile,z))-.035);}
// Authored crew access landings shared byte-for-byte by mesh and routes.
// Coordinates are design units; y includes local sheer. No stair inferred from
// a decorative deckhouse wall is treated as traversable.
export function laterSailStairFlights(id){
  const d=laterSailDesign(id),sx=d.runtime.beam/d.frame.beam,sz=d.runtime.length/d.frame.length,sy=d.frame.verticalScale,result=[];
  if(d.cockpit){
    const join=d.cockpit.bounds[0],z0=join-.22/sz,z1=join+.55/sz;
    result.push({id:'cockpit-entry',zoneId:'cockpit',side:0,x:0,width:.62/sx,z0,z1,
      y0:d.profile.deck+hullLoftSheer(d.profile,z0),y1:d.cockpit.floorHeight+hullLoftSheer(d.profile,z1)});
  }
  for(const zone of d.deckZones.filter(z=>z.id!=='main')){
    const fore=zone.bounds[0]<=d.profile.stations[0],join=fore?zone.bounds[1]:zone.bounds[0],rise=zone.height-d.profile.deck;
    const run=Math.max(.65/sz,rise*sy*1.6/sz),z0=fore?join-.10/sz:join-run,z1=fore?join+run:join+.10/sz;
    for(const side of [-1,1])result.push({id:zone.id+'.'+(side<0?'port':'starboard'),zoneId:zone.id,side,x:side*.95,width:.72/sx,z0,z1,
      y0:(fore?zone.height:d.profile.deck)+hullLoftSheer(d.profile,z0),y1:(fore?d.profile.deck:zone.height)+hullLoftSheer(d.profile,z1)});
  }
  return result;
}
export function laterSailKeelHalfWidth(id,z,y){
  const d=laterSailDesign(id),keel=d.keel;if(!keel)return 0;
  if(keel.kind!=='profiled-ballast-fin'){
    const bottom=d.profile.levels[0]+hullLoftSheer(d.profile,z);
    return z>=keel.bounds[0]&&z<=keel.bounds[1]&&y>=bottom-keel.depth&&y<=bottom?keel.width*.5:0;
  }
  const sections=keel.sections;if(y<sections[0].y||y>sections.at(-1).y)return 0;
  let index=0;while(index<sections.length-2&&y>sections[index+1].y)index++;
  const a=sections[index],b=sections[index+1],t=(y-a.y)/(b.y-a.y),mix=key=>a[key]+(b[key]-a[key])*t;
  const fore=mix('zFore'),aft=mix('zAft');if(z<=fore||z>=aft)return 0;
  const u=(z-fore)/(aft-fore),thickness=10*(.2969*Math.sqrt(u)-.1260*u-.3516*u*u+.2843*u*u*u-.1036*u*u*u*u);
  return Math.max(0,mix('halfWidth')*thickness);
}

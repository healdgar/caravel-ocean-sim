// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
import { deepFreeze } from '../rig-definition.js';

// HMS Victory, 1805 interpretation. Above-water sections measured from the
// user-supplied Meshy reference, fitted to reported dimensions. Underwater
// offsets, loading and rig proportions remain authored, not Admiralty offsets.
// Origin is the loaded waterline amidships; +X starboard, +Z aft. X and Y/Z
// use their respective metre scales so the runtime transform restores shape.
const length=56.6928,beam=15.8496,verticalScale=length/12;
export const VICTORY_DESIGN=deepFreeze({
  frame:{length:12,beam:3.6,verticalScale},runtime:{length,beam},
  hull:{draft:8.8/verticalScale,bowRake:.9,sternRake:.32,
    // Reference axes: bow -X, Y up, beam Z. Registration has no source waterline.
    reference:{sha256:'f54976c233c708811065981f00a1be9ff6b3c6a56880b34b36d391720cd3453e',
      metresPerUnit:44.80215288399298,centreX:0.14729826190723827,waterlineY:-0.4813768389280885,upperFloorY:-.358},
    // Above-water stem rake follows the measured rounded shell; the beakhead
    // is separate. The quadratic fore-only warp leaves gunport leads fixed.
    foreJoin:-5.3,stemLevels:[0,0.107888171,0.487213824,0.866539478,1.056202304,1.245865131,1.435527957,2.65],stemRake:[0,0.062555768,0.204802887,0.22376917,0.22376917,0.233252311,0.233252311,0.233252311],
    stations:[-6,-5.99,-5.97,-5.94,-5.9,-5.84,-5.76,-5.664263832,-5.3,-5.190106766,-4.715949699,-3.767635567,-2.819321434,-1.871007301,-0.922693169,1.92224923,2.870563362,3.344720429,3.818877495,4.767191628,5.71550576,6],
    levels:[-1.862670392,-1.6,-1.2,-0.6,-0.461100308,-0.271437482,0.107888171,0.487213824,0.866539478,1.056202304,1.245865131,1.435527957,1.67,2.15,2.65],
    // Height-major half-breadths. Censored fittings are interpolated; below the
    // shallow reference shell is an independent fairbody with authored draught.
    sections:[
      [0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0,0],
      [0,0.007635424,0.022794968,0.045226947,0.074481155,0.116706716,0.169265494,0.225260429,0.399650766,0.435469005,0.529299969,0.602178682,0.626650834,0.643989656,0.647011018,0.635421207,0.61763455,0.598431232,0.571042495,0.472216745,0.176453914,0.037651718],
      [0,0.015270849,0.045589936,0.090453895,0.14896231,0.233413433,0.33853099,0.450520859,0.799301533,0.870938011,1.058599938,1.204357364,1.253301667,1.287979313,1.294022036,1.270842414,1.235269101,1.196862463,1.14208499,0.94443349,0.352907828,0.075303437],
      [0,0.019810831,0.0591437,0.117345593,0.193248401,0.302806616,0.439175337,0.584459492,1.036931717,1.129865527,1.373318839,1.562409553,1.625904866,1.670892082,1.67873129,1.648660428,1.602511266,1.552686439,1.481623771,1.225211015,0.457826371,0.097690945],
      [0,0.020636282,0.061608021,0.122234992,0.201300418,0.315423558,0.45747431,0.608811971,1.080137206,1.176943258,1.430540457,1.627509951,1.693650902,1.740512585,1.748678427,1.717354613,1.669282568,1.617381707,1.543358095,1.276261473,0.47690247,0.101761401],
      [0,0.035253286,0.105298586,0.208757654,0.342423863,0.529804011,0.744947359,0.930207487,1.305713305,1.373670247,1.558537117,1.710738797,1.76499874,1.8,1.8,1.761124356,1.716835031,1.673117451,1.615890895,1.458032953,0.811625699,0.407045605],
      [0,0.077027951,0.223256902,0.421460725,0.64209511,0.899465306,1.09615876,1.22911626,1.442057674,1.47831211,1.601792965,1.709877351,1.753095479,1.796313608,1.8,1.745412257,1.704744462,1.674614783,1.642952213,1.547908018,1.466118428,1.322898215],
      [0,0.145377277,0.284674967,0.448752214,0.64503463,0.853513476,0.999618985,1.127393904,1.362790112,1.395523086,1.500526525,1.605279462,1.673292666,1.736530616,1.752986339,1.665592651,1.630927151,1.617047425,1.599849139,1.529282,1.644699518,1.648534699],
      [0,0.061530605,0.179300424,0.342432321,0.534014631,0.764329619,0.985179153,1.132092455,1.27012669,1.29215709,1.385496211,1.49671871,1.582708929,1.619033406,1.628761557,1.532368026,1.496791344,1.477230261,1.454402477,1.391316846,1.355842443,1.495892597],
      [0,0.121540838,0.245677904,0.397129619,0.555633256,0.727607016,0.873555105,1.018009884,1.218521124,1.246343214,1.336876077,1.444284848,1.524938833,1.555261848,1.572763559,1.546459209,1.43071954,1.40933321,1.386310801,1.340265982,1.259318391,1.394131196],
      [0,0.07344957,0.254100431,0.418877088,0.57509467,0.696755373,0.854642788,1.004863129,1.1992214,1.221240771,1.274527368,1.381100562,1.487673757,1.514420278,1.529685277,1.41239759,1.373301695,1.355116029,1.326501803,1.308878822,1.187347859,1.312722075],
      [0,0.069678804,0.241055381,0.397372707,0.545570365,0.66098523,0.810766996,0.9532753,1.137655573,1.202937056,1.368078203,1.370912741,1.434129916,1.441788687,1.449447457,1.311586781,1.327806406,1.313442202,1.306039394,1.221943397,1.1378474,1.282193655],
      [0,0.068633622,0.23743955,0.391412116,0.537386809,0.651070451,0.798605491,0.93897617,1.12059074,1.184893,1.34755703,1.35034905,1.412617967,1.420161856,1.427705745,1.291912979,1.30788931,1.293740569,1.286448803,1.203614246,1.120779689,1.26296075],
      [0,0.067240046,0.232618442,0.383464662,0.526475402,0.637850747,0.782390151,0.919910664,1.097837628,1.160834259,1.320195466,1.322930795,1.383935369,1.391326083,1.398716796,1.265681243,1.281333182,1.267471725,1.260328015,1.179175378,1.098022741,1.237316877],
      [0,0.065498076,0.226592058,0.373530344,0.512836143,0.621326116,0.762120976,0.896078782,1.069396239,1.130760833,1.285993511,1.288657976,1.348082121,1.355281365,1.36248061,1.232891574,1.248138022,1.23463567,1.22767703,1.148626793,1.069576556,1.205262035]
    ]},
  decks:{lower:.17,middle:.67,upper:1.17,main:1.17,
    forecastle:{end:-3.92,height:1.67},quarter:{start:1.65,height:1.67},poop:{start:4.35,height:2.15}},
  quarterdeck:{start:1.65,height:1.67},
  helm:{x:.82,z:3.5,eyeAboveDeck:1.6},
  wheel:{centre:[0,1.95,3.7],radius:.18},
  tiller:{pivot:[0,1.42,5.83],handle:[0,1.42,5.1],crewDistance:.35},
  anchor:{z:-4.85,rootInset:.04,tipOutset:.62,rootRise:.19,tipRise:.24,fairleadRise:.24},
  gunDecks:[{id:'lower',count:30,centre:.38,calibre:32,start:-5.12,end:5.05},
    {id:'middle',count:28,centre:.88,calibre:24,start:-4.9,end:4.85},
    {id:'upper',count:30,centre:1.38,calibre:12,start:-5.05,end:5.05},
    {id:'quarter',count:12,centre:1.88,calibre:12,start:1.98,end:5.15},
    {id:'forecastle',count:4,centre:1.88,calibre:12,start:-4.8,end:-4.18}],
  crewStations:{
    ines:{x:-.68,z:4.85,route:[4.6,5.0],yaw:Math.PI},
    tomas:{x:.68,z:4.85,route:[4.6,5.0],yaw:Math.PI},
    beatriz:{x:-1.06,z:-3.95,route:[-4.5,-4.0]},
    duarte:{x:1.06,z:-3.95,route:[-4.5,-4.0]},
    joao:{x:-1.12,z:-.85,route:[-.85,-.25]},
    catarina:{x:1.12,z:-.55,route:[-.85,-.25]},
    leonor:{x:-.93,z:2.15,route:[2.15,2.75]},
    rui:{x:.93,z:2.65,route:[2.2,2.75]},
    maria:{x:-.46,z:-5.05,route:[-5.05,-4.8]},
    afonso:{x:.46,z:-5.05,route:[-5.05,-4.8]},
    isabel:{x:-.9,z:3.35,route:[3.15,3.6]},
    pedro:{x:0,z:3.83,route:[3.83,3.83],yaw:Math.PI},
  },
  provenance:{interpretation:'Authored game reconstruction of the 1805 ship; not surveyed construction offsets.',
    dimensions:'https://www.gutenberg.org/files/40847/40847-h/40847-h.htm',
    structure:'https://www.royalnavymuseums.org.uk/hms-victory-conservation-log',
    plans:'https://www.rmg.co.uk/collections/objects/rmgc-object-79913',
    loadedDraft:'8.8 m authored service loading, not a hydrographic calibration.'},
});
export const VICTORY_MASTS=deepFreeze([
  {id:'fore',z:-3.55,height:12.15,platform:5.65,topmastPlatform:9.42,radius:.13,rake:.07,shrouds:{lowerStart:.8,lowerStep:.16,upperStart:.09,upperStep:.13}},
  {id:'main',z:.05,height:13.2,platform:6.1,topmastPlatform:10.25,radius:.145,rake:.14,shrouds:{lowerStart:.8,lowerStep:.16,upperStart:.09,upperStep:.13}},
  {id:'mizzen',z:3.53,height:10.45,platform:4.95,topmastPlatform:8.20,radius:.105,rake:.18,shrouds:{lowerStart:-1.18,lowerStep:.16,upperStart:.12,upperStep:.03}},
]);
const victoryDesignClamp=(x,a,b)=>Math.max(a,Math.min(b,x));
// Shape-preserving cubic interpolation: adjacent sections share their tangents.
// Smoothstep per interval would force a flat tangent at every frame and shelf.
function victoryTangent(h0,h1,d0,d1){
  if(d0*d1<=0)return 0;
  const a=2*h1+h0,b=h1+2*h0;return (a+b)/(a/d0+b/d1);
}
function victoryEndTangent(h0,h1,d0,d1){
  const m=((2*h0+h1)*d0-h0*d1)/(h0+h1);
  return m*d0<=0?0:d0*d1<0&&Math.abs(m)>3*Math.abs(d0)?3*d0:m;
}
function victoryCubic(a,b,ma,mb,span,t){
  return (2*t*t*t-3*t*t+1)*a+(t*t*t-2*t*t+t)*span*ma+(-2*t*t*t+3*t*t)*b+(t*t*t-t*t)*span*mb;
}
export const VICTORY_HULL_TANGENTS=deepFreeze(VICTORY_DESIGN.hull.sections.map(row=>{
  const xs=VICTORY_DESIGN.hull.stations,n=xs.length,ds=xs.slice(1).map((x,i)=>(row[i+1]-row[i])/(x-xs[i]));
  return row.map((_,i)=>i===0?victoryEndTangent(xs[1]-xs[0],xs[2]-xs[1],ds[0],ds[1]):i===n-1?victoryEndTangent(xs[n-1]-xs[n-2],xs[n-2]-xs[n-3],ds[n-2],ds[n-3]):victoryTangent(xs[i]-xs[i-1],xs[i+1]-xs[i],ds[i-1],ds[i]));
}));
export const VICTORY_STEM_TANGENTS=deepFreeze((()=>{
  const xs=VICTORY_DESIGN.hull.stemLevels,ys=VICTORY_DESIGN.hull.stemRake,n=xs.length,ds=xs.slice(1).map((x,i)=>(ys[i+1]-ys[i])/(x-xs[i]));
  return ys.map((_,i)=>i===0||i===n-1?0:victoryTangent(xs[i]-xs[i-1],xs[i+1]-xs[i],ds[i-1],ds[i]));
})());
export function victoryForeRake(base){
  if(base<=0)return 0;
  const h=VICTORY_DESIGN.hull,xs=h.stemLevels,ys=h.stemRake;let i=0;while(i<xs.length-2&&base>xs[i+1])i++;
  const span=xs[i+1]-xs[i],t=victoryDesignClamp((base-xs[i])/span,0,1);
  return victoryCubic(ys[i],ys[i+1],VICTORY_STEM_TANGENTS[i],VICTORY_STEM_TANGENTS[i+1],span,t);
}
function victorySectionWidth(row,i,t){
  const h=VICTORY_DESIGN.hull,ws=h.sections[row],ms=VICTORY_HULL_TANGENTS[row];
  return victoryCubic(ws[i],ws[i+1],ms[i],ms[i+1],h.stations[i+1]-h.stations[i],t);
}
export function victorySheer(z){return .085*(Math.abs(z)/6)**2+.075*Math.max(0,-z/6)**4;}
export function victoryHullDeck(z){return VICTORY_DESIGN.decks.main+victorySheer(z);}
export function victoryVesselDeck(z){
  const d=VICTORY_DESIGN.decks;
  return (z>=d.poop.start?d.poop.height:z>=d.quarter.start?d.quarter.height:z<=d.forecastle.end?d.forecastle.height:d.main)+victorySheer(z);
}
export function victoryHullHalfWidth(z,y){
  const h=VICTORY_DESIGN.hull,base=y-victorySheer(z),depth=victoryDesignClamp(-base/h.draft,0,1);
  const rake=victoryForeRake(base),bow=-6+h.bowRake*depth*depth-rake,stern=6-h.sternRake*depth*depth;
  if(z<bow-1e-8||z>stern+1e-8||base < -h.draft-1e-8)return 0;
  const join=h.foreJoin,L=join+6,foreDistance=join-z;
  const station=base<=0?z/(z<0?-bow/6:stern/6):z<join?join-2*foreDistance/(1+Math.sqrt(1+4*rake*foreDistance/(L*L))):z;
  const xs=h.stations,ys=h.levels,n=ys.length;
  let i=0;while(i<xs.length-2&&station>xs[i+1])i++;
  const t=victoryDesignClamp((station-xs[i])/(xs[i+1]-xs[i]),0,1);
  let j=0;while(j<n-2&&base>ys[j+1])j++;
  const span=ys[j+1]-ys[j],q=victoryDesignClamp((base-ys[j])/span,0,1),a=victorySectionWidth(j,i,t),b=victorySectionWidth(j+1,i,t),d=(b-a)/span;
  const before=victorySectionWidth(Math.max(0,j-1),i,t),after=victorySectionWidth(Math.min(n-1,j+2),i,t);
  const left=j? victoryTangent(ys[j]-ys[j-1],span,(a-before)/(ys[j]-ys[j-1]),d):victoryEndTangent(span,ys[2]-ys[1],d,(after-b)/(ys[2]-ys[1]));
  const right=j<n-2?victoryTangent(span,ys[j+2]-ys[j+1],d,(after-b)/(ys[j+2]-ys[j+1])):victoryEndTangent(span,ys[j]-ys[j-1],d,(a-before)/(ys[j]-ys[j-1]));
  return Math.max(0,victoryCubic(a,b,left,right,span,q));
}
// One loft point for skin, end closures and every attached timber. Stations
// follow the gun-deck baseline; the submerged ends retract with the stem rake.
export function victoryHullPoint(station,baseY,side){
  const h=VICTORY_DESIGN.hull,depth=Math.max(0,-baseY/h.draft);
  const fore=Math.max(0,(h.foreJoin-station)/(h.foreJoin+6));
  const z=baseY<=0?station*(1-(station<0?h.bowRake:h.sternRake)/6*depth*depth):station-victoryForeRake(baseY)*fore*fore,y=baseY+victorySheer(z);
  return [side*victoryHullHalfWidth(z,y),y,z];
}
export function victoryDeckHalfWidth(z){return Math.max(.012,victoryHullHalfWidth(z,victoryVesselDeck(z))-.045);}
export function victoryHatchPivot(){return [0,victoryVesselDeck(-1.5)+.145,-1.85];}
export function victoryAnchorCathead(side=-1){
  const a=VICTORY_DESIGN.anchor,z=a.z,y=victoryVesselDeck(z),w=victoryDeckHalfWidth(z);
  return {root:[side*(w-a.rootInset),y+a.rootRise,z],tip:[side*(w+a.tipOutset),y+a.tipRise,z],fairlead:[side*(w+a.tipOutset),y+a.fairleadRise,z]};
}
export function victoryMastPoint(index,y){const m=VICTORY_MASTS[index],foot=victoryVesselDeck(m.z);return [0,y,m.z+m.rake*(y-foot)/(m.height-foot)];}
export function victoryShroud(index,side,k,upper=false){
  const m=VICTORY_MASTS[index];
  if(!m||![-1,1].includes(side)||!Number.isInteger(k)||k<0||k>=(upper?4:7))throw Error('Invalid Victory shroud');
  if(upper){
    const p=victoryMastPoint(index,m.platform),top=victoryMastPoint(index,m.topmastPlatform+.18);
    return {root:[side*.43,p[1],p[2]+m.shrouds.upperStart+k*m.shrouds.upperStep],top:[side*.045,top[1],top[2]+k*.018]};
  }
  const z=m.z+m.shrouds.lowerStart+k*m.shrouds.lowerStep,y=victoryVesselDeck(z)+.04,top=victoryMastPoint(index,m.platform+.25);
  return {root:[side*(victoryHullHalfWidth(z,y)+.14),y,z],top:[side*.1,top[1],top[2]+k*.025]};
}
const standingBase=deepFreeze(VICTORY_MASTS.flatMap((m,mast)=>{
  const lines=[];
  for(const side of [-1,1]){
    for(let k=0;k<7;k++){const p=victoryShroud(mast,side,k);lines.push({id:`${m.id}.lower.${side}.${k}`,mast,kind:'lower-shroud',a:p.root,b:p.top,radius:.011});}
    for(let k=0;k<4;k++){const p=victoryShroud(mast,side,k,true);lines.push({id:`${m.id}.upper.${side}.${k}`,mast,kind:'upper-shroud',a:p.root,b:p.top,radius:.0065});}
    for(const h of [m.topmastPlatform+.1,m.height-.2]){const z=m.z+1.75;lines.push({id:`${m.id}.backstay.${side}.${h}`,mast,kind:'backstay',a:[side*victoryDeckHalfWidth(z),victoryVesselDeck(z)+.05,z],b:victoryMastPoint(mast,h),radius:.008});}
  }
  const forward=mast===0?[0,3.05,-8.2]:victoryMastPoint(mast-1,VICTORY_MASTS[mast-1].platform+.2);
  for(const h of [m.platform+.25,m.topmastPlatform+.28,m.height-.25])lines.push({id:`${m.id}.stay.${h}`,mast,kind:'forestay',a:victoryMastPoint(mast,h),b:forward,radius:.009});
  return lines;
}));
const sails=[];
function square(name,mast,top,width,height,bottomWidth,belly){
  const p=victoryMastPoint(mast,top),z=p[2]-.15;
  sails.push({id:sails.length+1,name,mast,kind:'square',controlGroup:VICTORY_MASTS[mast].id,
    top,width,height,z,belly,footRise:name.endsWith('topsail')?.55:name.endsWith('topgallant')?.28:.25,pivot:[0,top,z],
    corners:[[-width/2,top,z],[width/2,top,z],[bottomWidth/2,top-height,z],[-bottomWidth/2,top-height,z]]});
}
// Broad courses and single topsails, rather than later split-topsail rigs.
square('fore-course',0,5.55,5.45,2.72,4.7,.46);
// Surviving fore-topsail: 54 ft head/depth and 80 ft foot (NMRN). The
// straight-corner surface is nominal; it omits the historic cloth's roach.
square('fore-topsail',0,9.24,16.4592/(beam/3.6),16.4592/verticalScale,24.384/(beam/3.6),.38);
square('fore-topgallant',0,11.36,2.95,1.75,3.95,.23);
square('main-course',1,6.02,5.95,3.05,5.1,.52);
square('main-topsail',1,10.08,4.75,3.68,5.55,.43);
square('main-topgallant',1,12.35,3.32,1.84,4.45,.26);
// The mizzen crossjack is a bare yard; the fore-and-aft driver occupies this
// lower tier. Do not add a fictitious mizzen square course in front of it.
square('mizzen-topsail',2,8.06,3.12,2.77,3.62,.27);
square('mizzen-topgallant',2,9.9,2.15,1.48,2.90,.19);
function triangle(name,mast,corners,belly,kind='headsail'){
  const pivot=[...corners[0]];
  sails.push({id:sails.length+1,name,mast,kind,controlGroup:VICTORY_MASTS[mast].id,pivot,belly,corners});
}
triangle('fore-staysail',0,[victoryMastPoint(0,5.9),[0,2.67,-7.0],[0,2.7,-3.95]],.26);
triangle('inner-jib',0,[[0,9.6,-3.58],[0,3.0,-8.65],[0,3.25,-5.55]],.28);
triangle('flying-jib',0,[victoryMastPoint(0,11.95),[0,3.22,-10.4],[0,3.5,-7.35]],.25);
// The driver/spanker is a gaff quadrilateral. It uses the same UV square
// surface evaluator, but fore-and-aft trimming rather than square-yard bracing.
sails.push({id:sails.length+1,name:'spanker',mast:2,kind:'spanker',controlGroup:'mizzen',
  pivot:[0,4.3,3.75],top:6.5,width:2.9,height:3.8,belly:.25,footRise:.12,
  corners:[[0,6.48,3.75],[0,6.0,5.92],[0,2.79,6.45],[0,2.74,3.75]]});
export const VICTORY_SAILS=deepFreeze(sails);
export const VICTORY_STANDING_LINES=deepFreeze([
  ...standingBase.filter(l=>l.mast!==0||l.kind!=='forestay'),
  ...VICTORY_SAILS.filter(s=>s.kind==='headsail').map(s=>({id:'headstay.'+s.name,mast:0,kind:'forestay',a:[...s.corners[0]],b:[...s.corners[1]],radius:.009})),
]);
export const VICTORY_RUNNING_LINES=deepFreeze(VICTORY_SAILS.flatMap(s=>{
  const lines=[],m=VICTORY_MASTS[s.mast],lower=VICTORY_SAILS.filter(q=>q.mast===s.mast&&q.kind==='square'&&q.top<s.top).sort((a,b)=>b.top-a.top)[0];
  if(s.kind==='square')for(const side of [-1,1]){
    const a=s.corners[side<0?0:1].map((x,i)=>x+(i===0?side*.16:0));
    lines.push({sail:s.id,kind:'lift',a,b:victoryMastPoint(s.mast,Math.min(m.height,s.top+.65))});
    const uv=[side<0?0:1,1],clew=[...s.corners[side<0?3:2]],z=Math.min(5.7,m.z+1.0);
    const crossjack=s.name==='mizzen-topsail',p=crossjack?victoryMastPoint(2,4.87):null;
    const b=lower?lower.corners[side<0?0:1].map((x,i)=>x+(i===0?side*.16:0)):crossjack?[side*1.98,p[1],p[2]-.15]:[side*(victoryDeckHalfWidth(z)-.07),victoryVesselDeck(z)+.11,z];
    lines.push({sail:s.id,kind:'sheet',a:clew,b,uv,...(lower||crossjack?{bSail:lower?.id??s.id,bMotion:'yard'}:{})});
    if(crossjack)lines.push({sail:s.id,kind:'lift',a:[...b],b:victoryMastPoint(2,5.4)});
  }
  if(s.kind==='headsail')for(const side of [-1,1]){
    const z=-3.05;
    lines.push({sail:s.id,kind:'sheet',a:[...s.corners[2]],b:[side*(victoryDeckHalfWidth(z)-.08),victoryVesselDeck(z)+.10,z],uv:[0,1]});
  }
  if(s.kind==='spanker'){
    lines.push({sail:s.id,kind:'lift',a:[...s.corners[1]],b:victoryMastPoint(s.mast,6.95)});
    lines.push({sail:s.id,kind:'sheet',a:[...s.corners[2]],b:[0,victoryVesselDeck(5.82)+.12,5.82],uv:[1,1]});
  }
  return lines;
}));
export function victorySailPoint(id,u,v){
  const s=VICTORY_SAILS[id-1];if(!s)throw Error('Unknown Victory sail '+id);
  const [a,b,c,d]=s.corners;
  if(s.kind==='headsail')return a.map((x,i)=>x*(1-u-v)+b[i]*u+c[i]*v);
  const p=a.map((x,i)=>(x*(1-u)+b[i]*u)*(1-v)+(d[i]*(1-u)+c[i]*u)*v);
  p[1]+=(s.footRise??0)*4*u*(1-u)*v;
  return p;
}
export function victorySailArea(id){
  const s=VICTORY_SAILS[id-1],scale=[beam/3.6,verticalScale,verticalScale];
  const tri=(a,b,c)=>{const p=b.map((x,i)=>(x-a[i])*scale[i]),q=c.map((x,i)=>(x-a[i])*scale[i]);return Math.hypot(p[1]*q[2]-p[2]*q[1],p[2]*q[0]-p[0]*q[2],p[0]*q[1]-p[1]*q[0])*.5;};
  return tri(...s.corners.slice(0,3))+(s.corners.length===4?tri(s.corners[0],s.corners[2],s.corners[3]):0);
}

// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
import { deepFreeze } from '../rig-definition.js';

// HMS Victory, 1805: reported principal dimensions, with authored offsets and
// rig proportions. These are not a digitisation of the Admiralty body plans.
// Origin is the loaded waterline amidships; +X starboard, +Z aft. X and Y/Z
// use their respective metre scales so the runtime transform restores shape.
const length=56.6928,beam=15.8496,verticalScale=length/12;
export const VICTORY_DESIGN=deepFreeze({
  frame:{length:12,beam:3.6,verticalScale},runtime:{length,beam},
  hull:{draft:8.8/verticalScale,bowRake:.9,sternRake:.32,
    stations:[-6,-5.75,-5.3,-4.6,-3.7,-2.5,-1,0,1.5,3,4.5,5.35,6],
    breadths:[.035,.38,.86,1.30,1.60,1.77,1.8,1.8,1.77,1.65,1.46,1.29,1.14]},
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
function smoothTable(xs,ys,x){
  let i=0;while(i<xs.length-2&&x>xs[i+1])i++;
  const t=victoryDesignClamp((x-xs[i])/(xs[i+1]-xs[i]),0,1),h=t*t*(3-2*t);
  return ys[i]+(ys[i+1]-ys[i])*h;
}
export function victorySheer(z){return .085*(Math.abs(z)/6)**2+.075*Math.max(0,-z/6)**4;}
export function victoryHullDeck(z){return VICTORY_DESIGN.decks.main+victorySheer(z);}
export function victoryVesselDeck(z){
  const d=VICTORY_DESIGN.decks;
  return (z>=d.poop.start?d.poop.height:z>=d.quarter.start?d.quarter.height:z<=d.forecastle.end?d.forecastle.height:d.main)+victorySheer(z);
}
export function victoryHullHalfWidth(z,y){
  const h=VICTORY_DESIGN.hull,base=y-victorySheer(z),depth=victoryDesignClamp(-base/h.draft,0,1);
  const bow=-6+h.bowRake*depth*depth,stern=6-h.sternRake*depth*depth;
  if(z<bow-1e-8||z>stern+1e-8||base < -h.draft-1e-8)return 0;
  const station=z/(z<0?-bow/6:stern/6),breadth=smoothTable(h.stations,h.breadths,station);
  const section=smoothTable([-h.draft,-1.6,-1.2,-.6,0,.5,1,1.58,2.04,2.65],[0,.37,.74,.96,1,.98,.93,.86,.82,.78],base);
  return breadth*section;
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

// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Independent authored reconstructions. Reference measurements retain their
// subject/convention; neither reported tonnage nor hull depth supplies mass/draft.
import {deepFreeze} from '../rig-definition.js';
import {prepareHullLoft,hullLoftWidth,hullLoftDeck,hullLoftSheer} from '../hull-loft.js';

const additionalStations=[-6,-5.7,-5.1,-4.2,-3,-1.5,0,1.5,3,4.2,5.1,5.7,6];
function additionalProfile({draft,deck,waterline,deckWidths,bottomWidths,sheerFore,sheerAft,bowRake,sternRake}){
  const levels=[-draft,-draft*.7,-draft*.3,0,deck,deck+.65,Math.max(deck+1.4,2.4)];
  const sections=[waterline.map(()=>0),bottomWidths,waterline.map(w=>w*.90),waterline,deckWidths,deckWidths.map(w=>w*.94),deckWidths.map(w=>w*.88)];
  return prepareHullLoft({stations:additionalStations,levels,sections,deck,sheerFore,sheerAft,bowRake,sternRake});
}
function additionalSquare(id,name,mast,y,z,headWidth,footWidth,footY,belly=.22){
  return {id,name,mast,controlGroup:['fore','main','mizzen'][mast],kind:'square',pivot:[0,y,z],
    corners:[[-headWidth/2,y,z],[headWidth/2,y,z],[footWidth/2,footY,z],[-footWidth/2,footY,z]],belly,braceLimit:.4};
}
const additionalCrewIDs=['ines','tomas','beatriz','duarte','joao','catarina','leonor','rui','maria','afonso','isabel','pedro'];
function additionalStationsForCrew(){
  const positions=[[-.60,4.4],[.60,4.4],[-1,-3.5],[1,-3.5],[-.95,-.8],[.95,-.8],[-.9,1.2],[.9,1.2],[-.45,-4.9],[.45,-4.9],[-.72,3.2],[0,4.8]];
  return Object.fromEntries(additionalCrewIDs.map((id,i)=>{const [x,z]=positions[i];return [id,{x,z,route:i===11?[z,z]:[z,z+(i<2?.2:.45)],yaw:i===11?Math.PI:undefined}];}));
}
const pintaScale=25.908/12,santaScale=28.3/12;
export const ADDITIONAL_DESIGNS=deepFreeze({
  pinta:{id:'pinta',modelCode:2,name:'Pinta',revision:1,status:'planned',family:'caravel',
    frame:{length:12,beam:3.6,verticalScale:pintaScale},runtime:{length:25.908,beam:7.0104},
    interpretation:'Enlarged Sanger replica size profile with authored historical mixed rig; not original 1492 offsets.',
    profile:additionalProfile({draft:2.286/pintaScale-.075,deck:.68,sheerFore:.22,sheerAft:.18,bowRake:1.05,sternRake:.45,
      waterline:[0,.16,.57,1.10,1.51,1.74,1.8,1.74,1.56,1.23,.86,.58,.43],
      deckWidths:[0,.26,.72,1.22,1.59,1.76,1.8,1.76,1.61,1.38,1.10,.82,.65],
      bottomWidths:[0,.035,.16,.45,.70,.84,.88,.83,.68,.44,.19,.055,0]}),
    deckZones:[{id:'main',bounds:[-6,6],height:.68},{id:'forecastle',bounds:[-6,-4.2],height:1.0},{id:'quarter',bounds:[2.8,6],height:1.24}],
    barrier:.40,keel:{bounds:[-4.95,5.45],depth:.075,width:.07},
    helm:{x:.65,z:4.6,eyeAboveDeck:1.6},steering:{kind:'rudder',control:'direct-tiller',pivot:[0,-.20,5.62],handle:[0,1.68,4.95]},
    masts:[{id:'fore',z:-3.20,height:9.5,radius:.075,rake:.08},{id:'main',z:0,height:11.6,radius:.095,rake:.10},{id:'mizzen',z:3.7,height:9,radius:.065,rake:.12}],
    surfaces:[additionalSquare(1,'fore-course',0,7.2,-3.38,4.9,4.2,1.5,.28),
      additionalSquare(2,'main-course',1,9.7,-.22,6.0,5.2,1.5,.34),
      {id:3,name:'mizzen-lateen',mast:2,controlGroup:'mizzen',kind:'lateen',corners:[[0,8.7,5.6],[0,3.0,1.7],[0,1.8,6.2]],pivot:[0,5.9,3.68],belly:.28,yardClearance:.27,transferLift:1.0,contactClearance:.08}],
    bowsprit:{a:[0,1.02,-4.85],b:[0,1.55,-8.15],radius:.065},
    hatch:{centre:[0,.75,-1.8],size:[.85,.10,.95]},
    crewStations:additionalStationsForCrew(),
    loading:{crew:30,personKg:80,waterKgPerDay:5,foodKgPerDay:1.5,casksKg:1800,sparesKg:2500,designIncludesManifest:true,gmBeamFraction:.20},
    equipment:{anchors:true,guns:[{side:-1,z:3.3},{side:-1,z:4.5},{side:1,z:3.3},{side:1,z:4.5}],gunProvenance:'Four small period swivel guns are an authored outfit, not a recovered Pinta inventory.'},
    references:[{subject:'modern-enlarged-replica',source:'https://www.ninapinta.org/index.html',
      dimensions:[{kind:'deck-length',value:85,unit:'ft',metres:25.908},{kind:'beam',value:23,unit:'ft',metres:7.0104},{kind:'draught',value:7.5,unit:'ft',metres:2.286}],
      tonnage:{value:101,unit:null,kind:'tonnage-unspecified'},sailArea:{value:353.032,unit:'m2',kind:'replica-reported'}}],
  },
  'santa-maria':{id:'santa-maria',modelCode:3,name:'Santa María',revision:1,status:'planned',family:'nao',
    frame:{length:12,beam:3.6,verticalScale:santaScale},runtime:{length:28.3,beam:7.96},
    interpretation:'Fundación replica reported length/beam, authored nao underwater offsets and 1.95 m draft; not recovered 1492 lines.',
    profile:additionalProfile({draft:1.95/santaScale-.09,deck:(3.49-1.95)/santaScale,sheerFore:.15,sheerAft:.20,bowRake:.80,sternRake:.26,
      waterline:[0,.22,.76,1.35,1.63,1.78,1.8,1.79,1.68,1.48,1.22,1.01,.86],
      deckWidths:[0,.38,.93,1.48,1.69,1.79,1.8,1.79,1.73,1.58,1.42,1.28,1.18],
      bottomWidths:[0,.045,.23,.57,.83,.98,1.03,1.00,.87,.66,.41,.18,.06]}),
    deckZones:[{id:'main',bounds:[-6,6],height:(3.49-1.95)/santaScale},{id:'forecastle',bounds:[-6,-3.95],height:1.12},{id:'quarter',bounds:[2.10,6],height:1.36},{id:'poop',bounds:[4.65,6],height:1.91}],
    barrier:.38,keel:{bounds:[-5.2,5.65],depth:.09,width:.085},
    helm:{x:.66,z:3.9,eyeAboveDeck:1.6},steering:{kind:'rudder',control:'direct-tiller',pivot:[0,-.12,5.77],handle:[0,1.80,4.15]},
    masts:[{id:'fore',z:-3.7,height:8.05,radius:.075,rake:.06},{id:'main',z:-.05,height:25/santaScale,radius:.10,rake:.10},{id:'mizzen',z:4.5,height:7.85,radius:.065,rake:.11}],
    surfaces:[additionalSquare(1,'fore-course',0,6.6,-3.87,3.6,3.0,1.8,.24),
      additionalSquare(2,'main-course',1,8.0,-.29,5.1,4.4,2.3,.32),
      {id:3,name:'mizzen-lateen',mast:2,controlGroup:'mizzen',kind:'lateen',corners:[[0,7.4,5.7],[0,2.8,3.8],[0,1.9,6.1]],pivot:[0,4.5,4.5],belly:.22,yardClearance:.23,transferLift:.8,contactClearance:.07},
      additionalSquare(4,'main-topsail',1,10.4,-.22,3.4,3.8,8.6,.18),
      additionalSquare(5,'spritsail',0,1.75,-7.3,2.6,2.4,.55,.13)],
    bowsprit:{a:[0,1.15,-4.9],b:[0,2.05,-8.4],radius:.075},
    lookout:{mast:0,height:4.2,placement:'User-requested foremast lookout; not a confirmed historical placement.'},
    hatch:{centre:[0,.74,-1.7],size:[1.0,.10,1.10]},
    crewStations:{...additionalStationsForCrew(),ines:{x:-.60,z:5.1,route:[5.1,5.3]},tomas:{x:.60,z:5.1,route:[5.1,5.3]},pedro:{x:0,z:3.95,route:[3.95,3.95],yaw:Math.PI}},
    loading:{crew:40,personKg:80,waterKgPerDay:5,foodKgPerDay:1.5,casksKg:2300,sparesKg:3200,designIncludesManifest:true,gmBeamFraction:.18},
    equipment:{anchors:true,guns:[{side:-1,z:2.95},{side:-1,z:3.85},{side:1,z:2.95},{side:1,z:3.85}],gunProvenance:'Four small period swivel guns are an authored outfit, not a recovered Santa María inventory.'},
    references:[{subject:'modern-replica',source:'https://www.fundacionnaovictoria.org/es/la-construccion-nao-santa-maria/',
      dimensions:[{kind:'length-unspecified',value:28.3,unit:'m',metres:28.3},{kind:'maximum-beam',value:7.96,unit:'m',metres:7.96},{kind:'hull-depth-not-draft',value:3.49,unit:'m',metres:3.49}],
      tonnage:{value:200,unit:'toneladas',kind:'approximate-replica-weight-loading-unspecified'},sailArea:{value:300,unit:'m2',kind:'replica-reported'}}],
  },
});

export function additionalDesign(id){const design=ADDITIONAL_DESIGNS[id];if(!design)throw Error('No additional vessel design: '+id);return design;}
export function additionalHullWidth(id,z,y){return hullLoftWidth(additionalDesign(id).profile,z,y);}
export function additionalHullDeck(id,z){return hullLoftDeck(additionalDesign(id).profile,z);}
export function additionalDeck(id,z){
  const d=additionalDesign(id);let y=d.profile.deck;
  for(const zone of d.deckZones)if(z>=zone.bounds[0]&&z<=zone.bounds[1])y=Math.max(y,zone.height);
  return y+hullLoftSheer(d.profile,z);
}
export function additionalDeckWidth(id,z){return Math.max(0,additionalHullWidth(id,z,additionalDeck(id,z))-.045);}
// Shared visible flights and crew routes, ordered bow to stern. Heights include
// sheer; callers interpolate between these endpoints, rather than stepping
// instantly onto the next raised platform.
export function additionalStairFlights(id){
  const d=additionalDesign(id),boundaries=[...new Set(d.deckZones.flatMap(zone=>zone.bounds))].filter(z=>z>-6&&z<6).sort((a,b)=>a-b);
  const level=z=>d.deckZones.reduce((y,zone)=>z>=zone.bounds[0]&&z<=zone.bounds[1]?Math.max(y,zone.height):y,d.profile.deck),flights=[];
  for(const boundary of boundaries){
    const before=level(boundary-.001),after=level(boundary+.001);if(Math.abs(before-after)<.001)continue;
    const rising=after>before,z0=boundary-(rising?.55:.05),z1=boundary+(rising?.05:.55);
    const zoneId=d.deckZones.find(zone=>zone.height===Math.max(before,after)&&boundary>=zone.bounds[0]&&boundary<=zone.bounds[1])?.id??'main';
    for(const side of [-1,1])flights.push({id:zoneId+'.stairs.'+(side<0?'port':'starboard'),zoneId,side,x:side*.72,width:.38,z0,z1,
      y0:before+hullLoftSheer(d.profile,z0),y1:after+hullLoftSheer(d.profile,z1)});
  }
  return flights;
}

import { HULL_DRAFT, HULL_BOW_RAKE, HULL_STERN_RAKE, HULL_SECTION_POWER, HULL_VERTICAL_SCALE, HULL_STATIONS, HULL_BREADTHS, HULL_TANGENTS,QUARTERDECK_START,QUARTERDECK_HEIGHT } from '../hull.js';
import {VICTORY_DESIGN,VICTORY_HULL_TANGENTS,VICTORY_STEM_TANGENTS} from '../models/victory.js';
import {PROCEDURAL_DESIGNS,proceduralDraft} from '../models/procedural.js';
import {hullLoftWGSL} from '../hull-loft.js';
const victoryHullNX=VICTORY_DESIGN.hull.stations.length,victoryHullNY=VICTORY_DESIGN.hull.levels.length,victoryHullCells=victoryHullNX*victoryHullNY,victoryStemN=VICTORY_DESIGN.hull.stemLevels.length;
const proceduralDeckWGSL=d=>Number.isFinite(d.floorHeight)?`var y=${d.floorHeight};`:
  `var y=${d.profile.deck};`+(d.deckZones??[]).map(zone=>`if(z>=${zone.bounds[0]}&&z<=${zone.bounds[1]}){y=max(y,${zone.height});}`).join('')+
  (d.cockpit?`if(z>${d.cockpit.bounds[0]}&&z<${d.cockpit.bounds[1]}&&abs(x)<${d.cockpit.halfWidth}){y=${d.cockpit.floorHeight};}`:'');
const proceduralKeelWGSL=d=>{
  const k=d.keel;if(!k)return 'return 0.0;';
  if(k.kind!=='profiled-ballast-fin')return `let bottom=${d.profile.levels[0]}+additionalHull${d.modelCode}Sheer(z);if(z>=${k.bounds[0]}&&z<=${k.bounds[1]}&&y>=bottom-${k.depth}&&y<=bottom){return ${k.width*.5};}return 0.0;`;
  return `if(y<${k.sections[0].y}||y>${k.sections.at(-1).y}){return 0.0;}`+k.sections.slice(0,-1).map((a,i)=>{
    const b=k.sections[i+1];return `if(y<=${b.y}){let t=clamp((y-(${a.y}))/${b.y-a.y},0.0,1.0);let fore=mix(${a.zFore},${b.zFore},t);let aft=mix(${a.zAft},${b.zAft},t);if(z<=fore||z>=aft){return 0.0;}let u=(z-fore)/(aft-fore);let thickness=10.0*(.2969*sqrt(u)-.1260*u-.3516*u*u+.2843*u*u*u-.1036*u*u*u*u);return max(0.0,mix(${a.halfWidth},${b.halfWidth},t)*thickness);}`;
  }).join('')+'return 0.0;';
};
function createSceneHullProfile(modelCodes=null){
 const hasVictory=!modelCodes||modelCodes.has(1);
 const designs=Object.values(PROCEDURAL_DESIGNS).filter(d=>!modelCodes||modelCodes.has(d.modelCode));
 const additionalHullWGSLProfiles=designs.map(d=>hullLoftWGSL(d.profile,'additionalHull'+d.modelCode)).join('\n');
 const additionalHullCases=expression=>designs.map(d=>'case '+d.modelCode+'u: {'+expression(d)+'}').join('\n');
 const victoryHullTables=hasVictory?`
const VICTORY_HULL_X=array<f32,${victoryHullNX}>(${VICTORY_DESIGN.hull.stations.map(v=>v.toFixed(9)).join(',')});
const VICTORY_HULL_Y=array<f32,${victoryHullNY}>(${VICTORY_DESIGN.hull.levels.map(v=>v.toFixed(9)).join(',')});
const VICTORY_HULL_WIDTHS=array<f32,${victoryHullCells}>(${VICTORY_DESIGN.hull.sections.flat().map(v=>v.toFixed(9)).join(',')});
const VICTORY_HULL_SLOPES=array<f32,${victoryHullCells}>(${VICTORY_HULL_TANGENTS.flat().map(v=>v.toFixed(9)).join(',')});
fn victorySectionWidth(row:u32,i:u32,t:f32)->f32 {
 let k=row*${victoryHullNX}u+i;
 return victoryCubic(VICTORY_HULL_WIDTHS[k],VICTORY_HULL_WIDTHS[k+1u],VICTORY_HULL_SLOPES[k],VICTORY_HULL_SLOPES[k+1u],VICTORY_HULL_X[i+1u]-VICTORY_HULL_X[i],t);
}
const VICTORY_STEM_Y=array<f32,${victoryStemN}>(${VICTORY_DESIGN.hull.stemLevels.map(v=>v.toFixed(9)).join(',')});
const VICTORY_STEM_RAKE=array<f32,${victoryStemN}>(${VICTORY_DESIGN.hull.stemRake.map(v=>v.toFixed(9)).join(',')});
const VICTORY_STEM_SLOPES=array<f32,${victoryStemN}>(${VICTORY_STEM_TANGENTS.map(v=>v.toFixed(9)).join(',')});
fn victoryForeRake(base:f32)->f32 {
 if(base<=0.0){return 0.0;}var i=0u;while(i<${victoryStemN-2}u&&base>VICTORY_STEM_Y[i+1u]){i++;}
 let span=VICTORY_STEM_Y[i+1u]-VICTORY_STEM_Y[i];let t=clamp((base-VICTORY_STEM_Y[i])/span,0.0,1.0);
 return victoryCubic(VICTORY_STEM_RAKE[i],VICTORY_STEM_RAKE[i+1u],VICTORY_STEM_SLOPES[i],VICTORY_STEM_SLOPES[i+1u],span,t);
}`:`fn victorySectionWidth()->f32 {return 0.0;}`;
 const victoryWidthBody=hasVictory?`let base=y-victorySheer(z);let draft=${VICTORY_DESIGN.hull.draft};let depth=clamp(-base/draft,0.0,1.0);
 let rake=victoryForeRake(base);let bow=-6.0+${VICTORY_DESIGN.hull.bowRake}*depth*depth-rake;let stern=6.0-${VICTORY_DESIGN.hull.sternRake}*depth*depth;
 if(z<bow-.00000001||z>stern+.00000001||base< -draft-.00000001){return 0.0;}
 var station=z/select(stern/6.0,-bow/6.0,z<0.0);
 if(base>0.0){station=z;let join=${VICTORY_DESIGN.hull.foreJoin};let L=join+6.0;let d=join-z;if(z<join){station=join-2.0*d/(1.0+sqrt(1.0+4.0*rake*d/(L*L)));}}
 var i=0u;while(i<${victoryHullNX-2}u&&station>VICTORY_HULL_X[i+1u]){i++;}
 let t=clamp((station-VICTORY_HULL_X[i])/(VICTORY_HULL_X[i+1u]-VICTORY_HULL_X[i]),0.0,1.0);
 var j=0u;while(j<${victoryHullNY-2}u&&base>VICTORY_HULL_Y[j+1u]){j++;}
 let span=VICTORY_HULL_Y[j+1u]-VICTORY_HULL_Y[j];let q=clamp((base-VICTORY_HULL_Y[j])/span,0.0,1.0);
 var vRows=array<f32,4>(0.0,0.0,0.0,0.0);
 for(var r=0u;r<4u;r++){vRows[r]=victorySectionWidth(u32(clamp(i32(j)+i32(r)-1,0,${victoryHullNY-1})),i,t);}
 let before=vRows[0];let a=vRows[1];let b=vRows[2];let after=vRows[3];let d=(b-a)/span;
 var left:f32;
 if(j>0u){let h=VICTORY_HULL_Y[j]-VICTORY_HULL_Y[j-1u];left=victoryTangent(h,span,(a-before)/h,d);}
 else{let h=VICTORY_HULL_Y[2]-VICTORY_HULL_Y[1];left=victoryEndTangent(span,h,d,(after-b)/h);}
 var right:f32;
 if(j<${victoryHullNY-2}u){let h=VICTORY_HULL_Y[j+2u]-VICTORY_HULL_Y[j+1u];right=victoryTangent(span,h,d,(after-b)/h);}
 else{let h=VICTORY_HULL_Y[j]-VICTORY_HULL_Y[j-1u];right=victoryEndTangent(span,h,d,(a-before)/h);}
 return max(0.0,victoryCubic(a,b,left,right,span,q));`:`return 0.0;`;
 return /* wgsl */ `
const HULL_Y_SCALE:f32 = ${HULL_VERTICAL_SCALE};
fn hullDeck(z: f32) -> f32 {
  return select(0.7+0.24*(z/5.6)*(z/5.6),0.7+0.47*pow(max(0.0,-z/6.4),3.0),z<0.0);
}
fn hullBreadth(z:f32)->f32 {
  let stations=array<f32,10>(${HULL_STATIONS.map(x=>Number(x).toFixed(6)).join(',')});
  let widths=array<f32,10>(${HULL_BREADTHS.map(x=>x.toFixed(6)).join(',')});
  let tangents=array<f32,10>(${HULL_TANGENTS.map(x=>x.toFixed(9)).join(',')});
  var i=0u;while(i<8u && z>stations[i+1u]){i++;}
  let span=stations[i+1u]-stations[i];let t=clamp((z-stations[i])/span,0.0,1.0);
  return (2.0*t*t*t-3.0*t*t+1.0)*widths[i]+(t*t*t-2.0*t*t+t)*span*tangents[i]
    +(-2.0*t*t*t+3.0*t*t)*widths[i+1u]+(t*t*t-t*t)*span*tangents[i+1u];
}
fn hullHalfWidth(z: f32, y: f32) -> f32 {
  let deck=hullDeck(z);let depth=clamp((deck-y)/(deck+${HULL_DRAFT}),0.0,1.0);
  let fore=6.4-${HULL_BOW_RAKE}*depth*depth;let aft=5.6-${HULL_STERN_RAKE}*depth*depth;
  if(z < -fore || z > aft || y < -${HULL_DRAFT}) { return 0.0; }
  let station=z/select(aft/5.6,fore/6.4,z<0.0);
  let end=abs(station/select(5.6,6.4,station<0.0));
  return hullBreadth(station)*pow(max(0.0,1.0-depth*depth),${HULL_SECTION_POWER}+1.25*end*end*end)
    *(1.0+0.15*sin(3.14159265*depth));
}
// Compatibility helper for the Niña. Production uses the same model-aware
// finite boundary below, rather than extruding the waterline to infinite height.
fn hullExcludesOcean(local:vec3f)->bool {
  return modelHullExcludesOcean(local,0.0);
}
fn shipY(value:f32)->f32 {return select(HULL_Y_SCALE,value,value>0.0);}
fn victorySheer(z:f32)->f32 {return .085*pow(abs(z)/6.0,2.0)+.075*pow(max(0.0,-z/6.0),4.0);}
fn modelHullDeck(z:f32,model:f32)->f32 {
 if(model>=1.5){switch u32(round(model)){${additionalHullCases(d=>`return ${d.profile.deck}+additionalHull${d.modelCode}Sheer(z);`)}default:{return -1000000.0;}}}
 if(model>.5){return ${VICTORY_DESIGN.decks.main}+victorySheer(z);}return hullDeck(z);
}
fn modelHullDraft(model:f32)->f32 {
 if(model>=1.5){switch u32(round(model)){${additionalHullCases(d=>`return ${proceduralDraft(d.id)};`)}default:{return 0.0;}}}
 return select(${HULL_DRAFT},${VICTORY_DESIGN.hull.draft},model>.5);
}
fn victoryTangent(h0:f32,h1:f32,d0:f32,d1:f32)->f32 {
 if(d0*d1<=0.0){return 0.0;}let a=2.0*h1+h0;let b=h1+2.0*h0;return (a+b)/(a/d0+b/d1);
}
fn victoryEndTangent(h0:f32,h1:f32,d0:f32,d1:f32)->f32 {
 let m=((2.0*h0+h1)*d0-h0*d1)/(h0+h1);
 if(m*d0<=0.0){return 0.0;}if(d0*d1<0.0&&abs(m)>3.0*abs(d0)){return 3.0*d0;}return m;
}
fn victoryCubic(a:f32,b:f32,ma:f32,mb:f32,span:f32,t:f32)->f32 {
 return (2.0*t*t*t-3.0*t*t+1.0)*a+(t*t*t-2.0*t*t+t)*span*ma+(-2.0*t*t*t+3.0*t*t)*b+(t*t*t-t*t)*span*mb;
}
${victoryHullTables}
${additionalHullWGSLProfiles}
fn modelHullWidth(z:f32,y:f32,model:f32)->f32 {
 if(model>=1.5){switch u32(round(model)){${additionalHullCases(d=>`return additionalHull${d.modelCode}Width(z,y);`)}default:{return 0.0;}}}
 if(model<.5){return hullHalfWidth(z,y);}
 ${victoryWidthBody}
}
fn modelVesselDeckAt(z:f32,x:f32,model:f32)->f32 {
 if(model>=1.5){switch u32(round(model)){${additionalHullCases(d=>proceduralDeckWGSL(d)+`return y+additionalHull${d.modelCode}Sheer(z);`)}default:{return -1000000.0;}}}
 if(model<.5){return select(hullDeck(z),${QUARTERDECK_HEIGHT},z>=${QUARTERDECK_START});}
 var y=${VICTORY_DESIGN.decks.main};
 if(z<=${VICTORY_DESIGN.decks.forecastle.end} || z>=${VICTORY_DESIGN.decks.quarter.start}){y=${VICTORY_DESIGN.decks.quarter.height};}
 if(z>=${VICTORY_DESIGN.decks.poop.start}){y=${VICTORY_DESIGN.decks.poop.height};}
 return y+victorySheer(z);
}
fn modelVesselDeck(z:f32,model:f32)->f32 {return modelVesselDeckAt(z,0.0,model);}
fn modelKeelHalfWidth(z:f32,y:f32,model:f32)->f32 {
 if(model>=1.5){switch u32(round(model)){${additionalHullCases(proceduralKeelWGSL)}default:{return 0.0;}}}return 0.0;
}
// Solid cap tops, in canonical design units above each exposed weather deck.
// Open quarterdeck rails have an authored low sill; this is a visual boundary,
// not a collision model of each gap between rail posts.
fn modelDeckBarrierAt(z:f32,x:f32,model:f32)->f32 {
  if(model>=1.5){switch u32(round(model)){${additionalHullCases(d=>Number.isFinite(d.floorHeight)?`return ${d.profile.deck-d.floorHeight};`:
    (d.cockpit?`if(z>${d.cockpit.bounds[0]}&&z<${d.cockpit.bounds[1]}&&abs(x)<${d.cockpit.halfWidth}){return ${d.cockpit.coamingHeight-d.cockpit.floorHeight};}`:'')+`return ${d.barrier??0};`)}default:{return 0.0;}}}
  if(model>.5){
    if(z>${VICTORY_DESIGN.decks.forecastle.end}&&z<${VICTORY_DESIGN.decks.quarter.start}){return ${1.605-VICTORY_DESIGN.decks.main};}
    return select(.310,.215,z>=${VICTORY_DESIGN.decks.poop.start});
  }
  return select(.715,.160,z>=${QUARTERDECK_START});
}
fn modelDeckBarrier(z:f32,model:f32)->f32 {return modelDeckBarrierAt(z,0.0,model);}
fn modelHullExcludesOcean(local:vec3f,model:f32)->bool {
  // A crest higher than the actual barrier is continuous green water above
  // the open deck. Keep all below-deck/cabin space dry; residual deck wash is
  // retained separately when that crest recedes.
  if(local.y>modelVesselDeckAt(local.z,local.x,model)+modelDeckBarrierAt(local.z,local.x,model)){return false;}
  if(model>=3.5){return abs(local.x)<max(modelHullWidth(local.z,local.y,model),modelKeelHalfWidth(local.z,local.y,model));}
  return abs(local.x)<modelHullWidth(local.z,local.y,model);
}
`;
}
export const HULL_PROFILE=createSceneHullProfile();
const sceneHullProfiles=new Map();
// The fleet's models are immutable until navigation reloads the scene. Keep
// their exact loft arithmetic/model IDs; omit only absent procedural profiles.
export function withSceneHullProfile(source,modelCodes){
 if(!source.includes(HULL_PROFILE))return source;
 const codes=[...new Set(modelCodes)].sort((a,b)=>a-b),known=new Set([0,1,...Object.values(PROCEDURAL_DESIGNS).map(d=>d.modelCode)]);
 if(!codes.length||codes.some(code=>!known.has(code)))throw Error('Unknown scene GPU hull model');
 const key=codes.join(',');if(!sceneHullProfiles.has(key))sceneHullProfiles.set(key,createSceneHullProfile(new Set(codes)));
 return source.replaceAll(HULL_PROFILE,sceneHullProfiles.get(key));
}

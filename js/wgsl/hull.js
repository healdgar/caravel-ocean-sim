import { HULL_DRAFT, HULL_BOW_RAKE, HULL_STERN_RAKE, HULL_SECTION_POWER, HULL_VERTICAL_SCALE, HULL_STATIONS, HULL_BREADTHS, HULL_TANGENTS,QUARTERDECK_START,QUARTERDECK_HEIGHT } from '../hull.js';
import {VICTORY_DESIGN} from '../models/victory.js';
export const HULL_PROFILE = /* wgsl */ `
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
// Extend the enclosed water footprint above the deck. The open-ocean wave field
// cannot travel through solid bulwarks; overtopping is admitted at the rail by
// the deck-water solver and then moves across the deck with finite flux.
fn hullExcludesOcean(local:vec3f)->bool {
  return abs(local.x)<hullHalfWidth(local.z,local.y);
}
fn shipY(value:f32)->f32 {return select(HULL_Y_SCALE,value,value>0.0);}
fn victorySheer(z:f32)->f32 {return .085*pow(abs(z)/6.0,2.0)+.075*pow(max(0.0,-z/6.0),4.0);}
fn modelHullDeck(z:f32,model:f32)->f32 {if(model>.5){return ${VICTORY_DESIGN.decks.main}+victorySheer(z);}return hullDeck(z);}
fn modelHullDraft(model:f32)->f32 {return select(${HULL_DRAFT},${VICTORY_DESIGN.hull.draft},model>.5);}
fn modelHullWidth(z:f32,y:f32,model:f32)->f32 {
 if(model<.5){return hullHalfWidth(z,y);}
 let base=y-victorySheer(z);let draft=${VICTORY_DESIGN.hull.draft};let depth=clamp(-base/draft,0.0,1.0);
 let bow=-6.0+${VICTORY_DESIGN.hull.bowRake}*depth*depth;let stern=6.0-${VICTORY_DESIGN.hull.sternRake}*depth*depth;
 if(z<bow-.00000001||z>stern+.00000001||base< -draft-.00000001){return 0.0;}
 let station=z/select(stern/6.0,-bow/6.0,z<0.0);
 let xs=array<f32,13>(${VICTORY_DESIGN.hull.stations.map(v=>v.toFixed(9)).join(',')});
 let ys=array<f32,13>(${VICTORY_DESIGN.hull.breadths.map(v=>v.toFixed(9)).join(',')});
 var i=0u;while(i<11u&&station>xs[i+1u]){i++;}
 let t=clamp((station-xs[i])/(xs[i+1u]-xs[i]),0.0,1.0);let breadth=mix(ys[i],ys[i+1u],t*t*(3.0-2.0*t));
 let levels=array<f32,10>(-draft,-1.6,-1.2,-.6,0,.5,1,1.58,2.04,2.65);
 let widths=array<f32,10>(0,.37,.74,.96,1,.98,.93,.86,.82,.78);
 var j=0u;while(j<8u&&base>levels[j+1u]){j++;}
 let q=clamp((base-levels[j])/(levels[j+1u]-levels[j]),0.0,1.0);
 return breadth*mix(widths[j],widths[j+1u],q*q*(3.0-2.0*q));
}
fn modelVesselDeck(z:f32,model:f32)->f32 {
 if(model<.5){return select(hullDeck(z),${QUARTERDECK_HEIGHT},z>=${QUARTERDECK_START});}
 var y=${VICTORY_DESIGN.decks.main};
 if(z<=${VICTORY_DESIGN.decks.forecastle.end} || z>=${VICTORY_DESIGN.decks.quarter.start}){y=${VICTORY_DESIGN.decks.quarter.height};}
 if(z>=${VICTORY_DESIGN.decks.poop.start}){y=${VICTORY_DESIGN.decks.poop.height};}
 return y+victorySheer(z);
}
`;

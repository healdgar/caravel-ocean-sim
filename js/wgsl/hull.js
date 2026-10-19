import { HULL_DRAFT, HULL_BOW_RAKE, HULL_STERN_RAKE, HULL_SECTION_POWER, HULL_VERTICAL_SCALE, HULL_STATIONS, HULL_BREADTHS, HULL_TANGENTS } from '../hull.js';
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
`;

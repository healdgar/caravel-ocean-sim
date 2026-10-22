import { NINA_DESIGN } from './models/nina.js';
import { VICTORY_DESIGN, victoryHullHalfWidth, victoryHullDeck, victoryVesselDeck, victoryDeckHalfWidth } from './models/victory.js';
import {PROCEDURAL_DESIGNS,proceduralHullWidth,proceduralHullDeck,proceduralDeck,proceduralDeckWidth,proceduralDraft} from './models/procedural.js';

export function vesselHull(boatOrId='nina'){
  const id=typeof boatOrId==='string'?boatOrId:boatOrId.modelId??'nina',profile=VESSEL_HULLS[id];
  if(!profile)throw Error('No hull geometry for '+id);
  return profile;
}
export function vesselVerticalScale(boat){return vesselHull(boat).frame.verticalScale;}
export function vesselDraft(boat){const h=vesselHull(boat);return h.draft*h.frame.verticalScale;}
export function modelDeck(boat,z,x=0){return vesselHull(boat).deck(z,x);}
export function modelHullDeck(boat,z){return vesselHull(boat).hullDeck(z);}
export function modelDeckWidth(boat,z){return vesselHull(boat).deckWidth(z);}
export function modelHullWidth(boat,z,y){return vesselHull(boat).halfWidth(z,y);}
// Preserve the mesh's original design coordinates; convert to metres at the
// hull transform. All consumers (including water and crew) share this scale.
export const HULL_DESIGN_LENGTH = NINA_DESIGN.frame.length;
export const HULL_DESIGN_BEAM = NINA_DESIGN.frame.beam;
export const DEFAULT_BOAT_LENGTH = NINA_DESIGN.runtime.length;
export const DEFAULT_BOAT_BEAM = NINA_DESIGN.runtime.beam;
export const HULL_VERTICAL_SCALE = NINA_DESIGN.frame.verticalScale;
export function hullScale(length = DEFAULT_BOAT_LENGTH, beam = DEFAULT_BOAT_BEAM) {
  return [beam / HULL_DESIGN_BEAM, HULL_VERTICAL_SCALE, length / HULL_DESIGN_LENGTH];
}
export const HULL_DRAFT = NINA_DESIGN.hull.draft;
export const HULL_UNIFORM_BYTES = 208; // transform, controls, lateen poses and pressure sides
export const HULL_BOW_RAKE = NINA_DESIGN.hull.bowRake;
export const HULL_STERN_RAKE = NINA_DESIGN.hull.sternRake;
export const HULL_SECTION_POWER = NINA_DESIGN.hull.sectionPower;
// Upper decks and helm share one layout with the mesh, camera, and water field.
export const QUARTERDECK_START = NINA_DESIGN.quarterdeck.start;
export const QUARTERDECK_HEIGHT = NINA_DESIGN.quarterdeck.height;
// Direct tiller on the main deck below the quarterdeck. The player observes
// from above; the helmsman and camera occupy distinct physical stations.
export const TILLER_PIVOT = NINA_DESIGN.tiller.pivot;
export const TILLER_HANDLE = NINA_DESIGN.tiller.handle;
export const HELM_TILLER_DISTANCE = NINA_DESIGN.tiller.crewDistance;
export const HELM_STATION_Z = TILLER_HANDLE[2] - HELM_TILLER_DISTANCE / HULL_VERTICAL_SCALE;
// Captain stands near a forward quarterdeck corner, clear of the
// centreline masts. These are hull design coordinates, scaled with beam/length.
export const HELM_EYE_X = NINA_DESIGN.helm.x;
export const HELM_EYE_Z = NINA_DESIGN.helm.z;
export const HELM_EYE_HEIGHT = QUARTERDECK_HEIGHT * HULL_VERTICAL_SCALE + NINA_DESIGN.helm.eyeAboveDeck;
export function tillerPoint(boat, along=0) {
  const a=(boat.rudder??0)*Math.PI/180,q=TILLER_HANDLE[2]-TILLER_PIVOT[2]+along/(boat.length/12);
  return [Math.sin(a)*q*boat.beam/3.6,TILLER_HANDLE[1]*HULL_VERTICAL_SCALE,
    (TILLER_PIVOT[2]+Math.cos(a)*q)*boat.length/12];
}
export function hullDeck(z) {
  return z < 0 ? 0.7 + 0.47 * (-z / 6.4) ** 3 : 0.7 + 0.24 * (z / 5.6) ** 2;
}
export function vesselDeck(z) {
  return z >= QUARTERDECK_START ? QUARTERDECK_HEIGHT : hullDeck(z);
}
// One attachment definition for the timber cathead and animated working anchor.
export function anchorCathead(side=-1) {
  const a=NINA_DESIGN.anchor,z=a.z,x=side*(deckHalfWidth(z)+a.tipOutset),y=vesselDeck(z);
  return {root:[side*(deckHalfWidth(z)-a.rootInset),y+a.rootRise,z],tip:[x,y+a.tipRise,z],fairlead:[x,y+a.fairleadRise,z]};
}
// Authored stations guided by the Martinez-Hidalgo reconstruction's half-breadth
// and body plans; not digitized offsets or a claim of an exact Nina replica.
export const HULL_STATIONS = NINA_DESIGN.hull.stations;
export const HULL_BREADTHS = NINA_DESIGN.hull.breadths;
export const HULL_TANGENTS = HULL_STATIONS.map((z,i)=>{
  const slope=j=>(HULL_BREADTHS[j+1]-HULL_BREADTHS[j])/(HULL_STATIONS[j+1]-HULL_STATIONS[j]);
  if(i===0)return slope(0);if(i===HULL_STATIONS.length-1)return slope(i-1);
  const a=slope(i-1),b=slope(i);return a*b>0?2*a*b/(a+b):0;
});
export function hullBreadth(z) {
  let i=0;while(i<HULL_STATIONS.length-2 && z>HULL_STATIONS[i+1])i++;
  const span=HULL_STATIONS[i+1]-HULL_STATIONS[i],t=Math.max(0,Math.min(1,(z-HULL_STATIONS[i])/span));
  return (2*t*t*t-3*t*t+1)*HULL_BREADTHS[i]+(t*t*t-2*t*t+t)*span*HULL_TANGENTS[i]
    +(-2*t*t*t+3*t*t)*HULL_BREADTHS[i+1]+(t*t*t-t*t)*span*HULL_TANGENTS[i+1];
}
export function deckHalfWidth(z) { return Math.max(.015,hullBreadth(z)-.105); }
export function hullHalfWidth(z, y) {
  const deck=hullDeck(z),depth=Math.max(0,Math.min(1,(deck-y)/(deck+HULL_DRAFT)));
  const fore=6.4-HULL_BOW_RAKE*depth*depth,aft=5.6-HULL_STERN_RAKE*depth*depth;
  if(z < -fore-1e-7 || z > aft+1e-7 || y < -HULL_DRAFT)return 0;
  const station=z/(z<0?fore/6.4:aft/5.6),end=Math.abs(station/(station<0?6.4:5.6));
  // Full midbody, modest tumblehome, progressively finer V sections at both ends.
  return hullBreadth(station)*Math.pow(Math.max(0,1-depth*depth),HULL_SECTION_POWER+1.25*end**3)
    *(1+.15*Math.sin(Math.PI*depth));
}
export function hullSurfacePoint(station, angle) {
  const depth=Math.sin(angle), rake=station<0?HULL_BOW_RAKE/6.4:HULL_STERN_RAKE/5.6;
  const z=station*(1-rake*depth*depth), deck=hullDeck(z), y=deck-(deck+HULL_DRAFT)*depth;
  return [Math.sign(Math.cos(angle))*hullHalfWidth(z,Math.max(-HULL_DRAFT,y)),y,z];
}
// Follow a strake relative to the sheer, including the bow/stern rake. Sampling
// hullHalfWidth at an unraked end Z instead snaps the strip towards the centreline.
export function hullSheerAngle(station, offset) {
  let low=0,high=Math.PI/2;
  for(let i=0;i<26;i++){
    const angle=(low+high)/2,p=hullSurfacePoint(station,angle);
    if(p[1]-hullDeck(p[2])>offset)low=angle;else high=angle;
  }
  return (low+high)/2;
}

// Explicit adapters retain each model's actual analytic/section representation.
// New hulls must supply their geometry here rather than inherit a ship-name
// fallback. The legacy functions above remain the unchanged Niña public API.
export const VESSEL_HULLS=Object.freeze({
  nina:Object.freeze({id:'nina',frame:NINA_DESIGN.frame,runtime:NINA_DESIGN.runtime,
    bounds:Object.freeze([-6.4,5.6]),draft:HULL_DRAFT,halfWidth:hullHalfWidth,
    hullDeck,deck:vesselDeck,deckWidth:deckHalfWidth}),
  victory:Object.freeze({id:'victory',frame:VICTORY_DESIGN.frame,runtime:VICTORY_DESIGN.runtime,
    bounds:Object.freeze([-6,6]),draft:VICTORY_DESIGN.hull.draft,halfWidth:victoryHullHalfWidth,
    hullDeck:victoryHullDeck,deck:victoryVesselDeck,deckWidth:victoryDeckHalfWidth}),
  ...Object.fromEntries(Object.entries(PROCEDURAL_DESIGNS).map(([id,d])=>[id,Object.freeze({id,frame:d.frame,runtime:d.runtime,
    bounds:Object.freeze([d.profile.stations[0],d.profile.stations.at(-1)]),draft:proceduralDraft(id),datumDraft:-d.profile.levels[0],
    halfWidth:(z,y)=>proceduralHullWidth(id,z,y),hullDeck:z=>proceduralHullDeck(id,z),deck:(z,x=0)=>proceduralDeck(id,z,x),deckWidth:z=>proceduralDeckWidth(id,z)})])),
});

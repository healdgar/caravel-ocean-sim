// Preserve the mesh's original design coordinates; convert to metres at the
// hull transform. All consumers (including water and crew) share this scale.
export const HULL_DESIGN_LENGTH = 12;
export const HULL_DESIGN_BEAM = 3.6;
export const DEFAULT_BOAT_LENGTH = 20;
export const DEFAULT_BOAT_BEAM = 6;
export const HULL_VERTICAL_SCALE = DEFAULT_BOAT_LENGTH / HULL_DESIGN_LENGTH;
export function hullScale(length = DEFAULT_BOAT_LENGTH, beam = DEFAULT_BOAT_BEAM) {
  return [beam / HULL_DESIGN_BEAM, HULL_VERTICAL_SCALE, length / HULL_DESIGN_LENGTH];
}
export const HULL_DRAFT = 1.2;
export const HULL_UNIFORM_BYTES = 144; // transform, rig, sail set/trim/apparent wind
export const HULL_BOW_RAKE = 1.45;
export const HULL_STERN_RAKE = 0.5;
export const HULL_SECTION_POWER = 0.65;
// Upper decks and helm share one layout with the mesh, camera, and water field.
export const QUARTERDECK_START = 2.7;
export const QUARTERDECK_HEIGHT = 2.3;
// Direct tiller on the main deck below the quarterdeck. The player observes
// from above; the helmsman and camera occupy distinct physical stations.
export const TILLER_PIVOT = [0, 1.38, 5.68];
export const TILLER_HANDLE = [0, 1.43, 3.95];
export const HELM_TILLER_DISTANCE = .32;
export const HELM_STATION_Z = TILLER_HANDLE[2] - HELM_TILLER_DISTANCE / HULL_VERTICAL_SCALE;
// Captain stands near a forward quarterdeck corner, clear of the
// centreline masts. These are hull design coordinates, scaled with beam/length.
export const HELM_EYE_X = 1.1;
export const HELM_EYE_Z = 3.1;
export const HELM_EYE_HEIGHT = QUARTERDECK_HEIGHT * HULL_VERTICAL_SCALE + 1.6;
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
// Authored stations guided by the Martinez-Hidalgo reconstruction's half-breadth
// and body plans; not digitized offsets or a claim of an exact Nina replica.
export const HULL_STATIONS = [-6.4,-5.8,-4.8,-3.2,-1.6,0,1.4,2.8,4.2,5.6];
export const HULL_BREADTHS = [.045,.51,1.08,1.52,1.73,1.77,1.70,1.52,1.29,1.06];
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

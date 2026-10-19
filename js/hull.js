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
export const HULL_DRAFT = 1.55;
export const HULL_UNIFORM_BYTES = 144; // transform, rig, sail set/trim/apparent wind
export const HULL_BOW_RAKE = 0.9;
export const HULL_STERN_RAKE = 0.25;
export const HULL_SECTION_POWER = 0.42;
// Upper decks and helm share one layout with the mesh, camera, and water field.
export const FORECASTLE_END = -3.9;
export const FORECASTLE_HEIGHT = 1.75;
export const QUARTERDECK_START = 2.7;
export const QUARTERDECK_HEIGHT = 2.3;
// Wheel and people retain human dimensions; only their deck anchors scale.
export const WHEEL_CENTER = [0, QUARTERDECK_HEIGHT + .95 / HULL_VERTICAL_SCALE, 4.4];
export const HELM_STATION_Z = WHEEL_CENTER[2] + .60 / HULL_VERTICAL_SCALE;
export const HELM_EYE_Z = HELM_STATION_Z + .25 / HULL_VERTICAL_SCALE;
export const HELM_EYE_HEIGHT = QUARTERDECK_HEIGHT * HULL_VERTICAL_SCALE + 1.6;
export function hullDeck(z) {
  return z < 0 ? 0.7 + 0.47 * (-z / 6.4) ** 3 : 0.7 + 0.24 * (z / 5.6) ** 2;
}
export function vesselDeck(z) {
  return z <= FORECASTLE_END ? FORECASTLE_HEIGHT : z >= QUARTERDECK_START ? QUARTERDECK_HEIGHT : hullDeck(z);
}
export function hullHalfWidth(z, y) {
  const deck = hullDeck(z), depth = Math.max(0, Math.min(1, (deck-y)/(deck+HULL_DRAFT)));
  const fore = 6.4-HULL_BOW_RAKE*depth*depth, aft = 5.6-HULL_STERN_RAKE*depth*depth;
  if(z < -fore-1e-7 || z > aft+1e-7 || y < -HULL_DRAFT) return 0;
  const ratio = z < 0 ? -z/fore : z/aft*(5.6/7.4);
  return (1.8*Math.sqrt(Math.max(0.0006,1-ratio*ratio))+0.105)*Math.pow(Math.max(0,1-depth*depth),HULL_SECTION_POWER);
}
export function hullSurfacePoint(station, angle) {
  const depth=Math.sin(angle), rake=station<0?HULL_BOW_RAKE/6.4:HULL_STERN_RAKE/5.6;
  const z=station*(1-rake*depth*depth), deck=hullDeck(z), y=deck-(deck+HULL_DRAFT)*depth;
  return [Math.sign(Math.cos(angle))*hullHalfWidth(z,Math.max(-HULL_DRAFT,y)),y,z];
}

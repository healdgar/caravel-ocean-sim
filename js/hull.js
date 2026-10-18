// Canonical hull section, in metres. Mesh, ocean mask, and spray use this profile.
export const HULL_DRAFT = 1.55;
export const HULL_BOW_RAKE = 0.9;
export const HULL_STERN_RAKE = 0.25;
export const HULL_SECTION_POWER = 0.42;
// Upper decks and helm share one layout with the mesh, camera, and water field.
export const FORECASTLE_END = -3.9;
export const FORECASTLE_HEIGHT = 1.75;
export const QUARTERDECK_START = 2.7;
export const QUARTERDECK_HEIGHT = 2.3;
export const WHEEL_CENTER = [0, 3.25, 4.4];
export const HELM_EYE_Z = 5.4;
export const HELM_EYE_HEIGHT = 3.9;
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

import { HULL_DRAFT, HULL_BOW_RAKE, HULL_STERN_RAKE, HULL_SECTION_POWER } from '../hull.js';
export const HULL_PROFILE = /* wgsl */ `
fn hullDeck(z: f32) -> f32 {
  return select(0.7+0.24*(z/5.6)*(z/5.6),0.7+0.47*pow(max(0.0,-z/6.4),3.0),z<0.0);
}
fn hullHalfWidth(z: f32, y: f32) -> f32 {
  let deck=hullDeck(z);
  let depth=clamp((deck-y)/(deck+${HULL_DRAFT}),0.0,1.0);
  let fore=6.4-${HULL_BOW_RAKE}*depth*depth;
  let aft=5.6-${HULL_STERN_RAKE}*depth*depth;
  if(z < -fore || z > aft || y < -${HULL_DRAFT}) { return 0.0; }
  let ratio=select(z/aft*(5.6/7.4),-z/fore,z<0.0);
  return (1.8*sqrt(max(0.0006,1.0-ratio*ratio))+0.105)*pow(max(0.0,1.0-depth*depth),${HULL_SECTION_POWER});
}
`;

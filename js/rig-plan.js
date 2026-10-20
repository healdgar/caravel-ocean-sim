import { HULL_DESIGN_LENGTH } from './hull.js';
import { NINA_RIG_PLATE } from './models/nina.js';

// Digitized side elevation, not a perspective photograph or original ship offsets.
// The 303 px stem-to-transom deck span is normalized to our 20 m hull. Pixel
// readings are approximate (+/- 3 px); do not infer precision from these floats.
// The retained quarterdeck lifts this traced rig by .65 design units. The
// geometry remains a documented reconstruction hybrid, not original offsets.
export const LATEEN_RIG_PLATE = NINA_RIG_PLATE;
export function rigPlatePoint([x,y]){
  const p=LATEEN_RIG_PLATE,k=HULL_DESIGN_LENGTH/(p.sternX-p.bowX);
  return [0,(p.waterlineY-y)*k+p.deckLift,(x-p.bowX)*k-6.4];
}

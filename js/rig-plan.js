import { HULL_DESIGN_LENGTH } from './hull.js';

// Digitized side elevation, not a perspective photograph or original ship offsets.
// The 303 px stem-to-transom deck span is normalized to our 20 m hull. Pixel
// readings are approximate (+/- 3 px); do not infer precision from these floats.
export const LATEEN_RIG_PLATE = {
  title: 'Niña, d’Albertis reconstruction (1892)',
  source: 'https://navires-anciens.be/wp-content/uploads/2020/06/Nina.jpg',
  width:669,height:473,bowX:88,sternX:391,waterlineY:320,
  // Our retained Hidalgo-inspired quarterdeck is higher than this plate.
  // Translate the entire rig upward 0.65 design units (1.08 m), without
  // stretching canvas, to clear it. Hull and rig are a documented hybrid.
  deckLift:.65,
  sails:[
    {corners:[[302,22],[100,282],[302,281]],mastFoot:[201,301],mastHead:[198,106],radius:.15,belly:.90},
    {corners:[[370,106],[233,287],[371,272]],mastFoot:[304,277],mastHead:[301,151],radius:.115,belly:.65},
    {corners:[[407,169],[330,272],[407,265]],mastFoot:[372,269],mastHead:[369,194],radius:.095,belly:.35},
  ],
};
export function rigPlatePoint([x,y]){
  const p=LATEEN_RIG_PLATE,k=HULL_DESIGN_LENGTH/(p.sternX-p.bowX);
  return [0,(p.waterlineY-y)*k+p.deckLift,(x-p.bowX)*k-6.4];
}

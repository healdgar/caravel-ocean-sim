import { deckHalfWidth, vesselDeck, HULL_VERTICAL_SCALE } from './hull.js';

// Martinez-Hidalgo's converted Nina: three single masts, without topsails/tops.
// Dimensions are authored approximations of the reconstruction plate.
export const RIG_MASTS = [{z:-4.15,height:6.9,r:.115,rake:-.28},{z:-.1,height:8.7,r:.15,rake:-.12},{z:3.05,height:6.3,r:.095,rake:.18}];
export function mastPoint(mast,y){
  const m=RIG_MASTS[mast],base=vesselDeck(m.z);
  return [0,y,m.z+m.rake*(y-base)/(m.height-base)];
}
export function shroudGeometry(mast,side) {
  const {z,height}=RIG_MASTS[mast],head=mastPoint(mast,height*.92);head[0]=side*.11;
  const feet=[-.65,.65].map(dz=>[side*(deckHalfWidth(z+dz)-.40),vesselDeck(z+dz)+.10,z+dz]);
  const rungs=Math.ceil((head[1]-Math.min(...feet.map(p=>p[1])))*HULL_VERTICAL_SCALE/.35);
  return {head,feet,rungs};
}
export function shroudPoint(mast,side,rung,across=.5) {
  const {head,feet,rungs}=shroudGeometry(mast,side),t=Math.max(0,Math.min(1,rung/rungs));
  return head.map((v,i)=>(feet[0][i]*(1-across)+feet[1][i]*across)*(1-t)+v*t);
}
// Rope ascent uses the central runner, without transverse ratlines.
export function climbingPoint(mast,side,step){return shroudPoint(mast,side,step,.5);}

// Working halyard leads terminate beside the assigned deck hands.
export const SAIL_TACKLES = [{mast:0,x:1.05,z:-1.4},{mast:1,x:-1.1,z:-.45},{mast:2,x:-.75,z:3.25}];
export function tacklePoint(mast,height){
  const t=SAIL_TACKLES[mast],m=RIG_MASTS[mast],side=Math.sign(t.x);
  const bottom=[t.x+side*.25,vesselDeck(t.z)+.25,t.z];
  const top=mastPoint(mast,m.height*.90);top[0]=side*.10;
  const f=Math.max(0,Math.min(1,(height-bottom[1])/(top[1]-bottom[1])));
  return bottom.map((v,i)=>v+(top[i]-v)*f);
}

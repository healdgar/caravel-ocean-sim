import { deckHalfWidth, vesselDeck, HULL_VERTICAL_SCALE, QUARTERDECK_START } from './hull.js';
import { LATEEN_RIG_PLATE, rigPlatePoint } from './rig-plan.js';

// Keep the converted rig's supports with its future model. Active mast positions
// and heights come from the same orthographic plate as the lateen canvas.
export const SQUARE_RIG_MASTS = [{z:-4.15,height:6.9,r:.115,rake:-.28},{z:-.1,height:8.7,r:.15,rake:-.12},{z:3.05,height:6.3,r:.095,rake:.18}];
export const RIG_MASTS = LATEEN_RIG_PLATE.sails.map(s=>{
  const foot=rigPlatePoint(s.mastFoot),head=rigPlatePoint(s.mastHead);
  return {z:foot[2],height:head[1],r:s.radius,rake:head[2]-foot[2]};
});
export function mastPoint(mast,y){
  const m=RIG_MASTS[mast],base=vesselDeck(m.z);
  return [0,y,m.z+m.rake*(y-base)/(m.height-base)];
}
export function shroudGeometry(mast,side) {
  const {z,height}=RIG_MASTS[mast],head=mastPoint(mast,height*.92);head[0]=side*.11;
  const span=z<QUARTERDECK_START?Math.min(.65,QUARTERDECK_START-z-.12):.65;
  const feet=[-span,span].map(dz=>[side*(deckHalfWidth(z+dz)-.40),vesselDeck(z+dz)+.10,z+dz]);
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

// Shared centre lines for visible standing rigging and sail clearance.
export function standingRiggingLines(){
  const lines=[],add=(a,b,r,r2=r,sides=10)=>lines.push({a,b,r,r2,sides,id:0,weights:[0,0]});
  for(let mast=0;mast<RIG_MASTS.length;mast++)for(const side of [-1,1]){
    const {head,feet}=shroudGeometry(mast,side);
    for(const foot of feet)add(foot,head,.022,.016);
    add(feet[0].map((v,i)=>(v+feet[1][i])*.5),head,.024,.021);
  }
  for(const t of SAIL_TACKLES){
    const a=tacklePoint(t.mast,-10),b=tacklePoint(t.mast,30);
    add(a,b,.012,.012,8);add([a[0]-.035,a[1],a[2]],[b[0]-.035,b[1],b[2]],.012,.012,8);
  }
  for(const [mast,target,r] of [[0,[0,1.9,-8.1],.036],[1,mastPoint(0,RIG_MASTS[0].height*.7),.028],[2,mastPoint(1,RIG_MASTS[1].height*.7),.026]])
    add(mastPoint(mast,RIG_MASTS[mast].height*.96),target,r,r*.8,12);
  for(const side of [-1,1])for(const [mast,m] of RIG_MASTS.entries()){
    const z=Math.min(5.35,m.z+1.3);
    const head=mastPoint(mast,RIG_MASTS[mast].height*.94);head[0]=side*.12;
    add(head,[side*(deckHalfWidth(z)-.04),vesselDeck(z)+.35,z],.024);
  }
  return lines;
}

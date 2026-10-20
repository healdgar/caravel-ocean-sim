import { deckHalfWidth, vesselDeck, HULL_VERTICAL_SCALE, QUARTERDECK_START } from './hull.js';
import { LATEEN_RIG_PLATE, rigPlatePoint } from './rig-plan.js';
import { NINA_DESIGN } from './models/nina.js';

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
export function shroudPoint(mast,side,rung,across=.5,pose=null) {
  const {head,feet,rungs}=shroudGeometry(mast,side),t=Math.max(0,Math.min(1,rung/rungs));
  if(pose)return standingRopePoint({kind:'runner',mast,side,a:feet[0].map((v,i)=>v*(1-across)+feet[1][i]*across),b:head},t,pose);
  return head.map((v,i)=>(feet[0][i]*(1-across)+feet[1][i]*across)*(1-t)+v*t);
}
// Rope ascent uses the central runner, without transverse ratlines.
export function climbingPoint(mast,side,step,pose=null){return shroudPoint(mast,side,step,.5,pose);}

// Working halyard leads terminate beside the assigned deck hands.
export const SAIL_TACKLES = NINA_DESIGN.tackles;
export function tacklePoint(mast,height){
  const t=SAIL_TACKLES[mast],m=RIG_MASTS[mast],side=Math.sign(t.x);
  const bottom=[t.x+side*.25,vesselDeck(t.z)+.25,t.z];
  const top=mastPoint(mast,m.height*.90);top[0]=side*.10;
  const f=Math.max(0,Math.min(1,(height-bottom[1])/(top[1]-bottom[1])));
  return bottom.map((v,i)=>v+(top[i]-v)*f);
}
export function workingTacklePoint(mast,height){
  const a=tacklePoint(mast,-10),b=tacklePoint(mast,30),side=Math.sign(a[0]);
  const t=Math.max(0,Math.min(1,(height-a[1])/(b[1]-a[1])));
  return standingRopePoint({kind:'fall',mast,side,a,b},t,null);
}

// Shared centre lines for visible standing rigging and sail clearance.
export function standingRiggingLines(){
  const lines=[],add=(kind,mast,side,a,b,r,r2=r,sides=10)=>lines.push({kind,mast,side,a,b,r,r2,sides,id:0,weights:[0,0]});
  for(let mast=0;mast<RIG_MASTS.length;mast++)for(const side of [-1,1]){
    const {head,feet}=shroudGeometry(mast,side);
    for(const foot of feet)add('shroud',mast,side,foot,head,.022,.016);
    add('runner',mast,side,feet[0].map((v,i)=>(v+feet[1][i])*.5),head,.024,.021);
  }
  for(const t of SAIL_TACKLES){
    const a=tacklePoint(t.mast,-10),b=tacklePoint(t.mast,30),side=Math.sign(a[0]);
    add('fall',t.mast,side,a,b,.012,.012,8);
    add('fall',t.mast,side,[a[0]-.035,a[1],a[2]],[b[0]-.035,b[1],b[2]],.012,.012,8);
  }
  // Keep the fore stay to the bowsprit. The other masts use paired running
  // stays led to the waterways; fixed inter-mast stays blocked yard transfer.
  add('forestay',0,0,[0,1.9,-8.1],mastPoint(0,RIG_MASTS[0].height*.96),.036,.0288,12);
  for(const side of [-1,1])for(const [mast,m] of RIG_MASTS.entries()){
    for(const direction of [-1,1]){
      const z=Math.max(-5.8,Math.min(5.35,m.z+direction*1.3));
      const head=mastPoint(mast,m.height*.94);head[0]=side*.12;
      add('stay',mast,side,[side*(deckHalfWidth(z)-.04),vesselDeck(z)+.03,z],head,.024);
    }
  }
  return lines;
}

export function standingRopePoint(line,t,pose){
  const point=line.a.map((v,i)=>v+(line.b[i]-v)*t);
  if(line.kind==='forestay')return point;
  const lee=(pose?.side??-1)*line.side>0?1:0;
  const ease=line.kind==='fall'?1:Math.max(lee,Math.min(1,(pose?.dip??0)/.12));
  // Eased pendants are gathered alongside the mast. Their fixed deck ends
  // remain visible; paid-out length curves down to the same belaying points.
  const low=1-t,foot=Math.pow(low,32),m=RIG_MASTS[line.mast];
  const y=point[1]-.12*Math.sin(Math.PI*t),axis=mastPoint(line.mast,y);
  const x=line.b[0]+line.side*.08*low+(line.a[0]-line.b[0]-line.side*.08)*foot;
  const z=axis[2]+(line.a[2]-mastPoint(line.mast,line.a[1])[2])*foot;
  return [point[0]+(x-point[0])*ease,point[1]+(y-point[1])*ease,point[2]+(z-point[2])*ease];
}

import { vesselDeck } from './hull.js';
import { mastPoint, RIG_MASTS, standingRiggingLines } from './rigging.js';
import { LATEEN_RIG_PLATE, rigPlatePoint } from './rig-plan.js';

export const SAIL_PLAN=LATEEN_RIG_PLATE.sails.map((s,mast)=>{
  const corners=s.corners.map(rigPlatePoint),[a,b]=corners,m=RIG_MASTS[mast];
  const base=mastPoint(mast,vesselDeck(m.z)),slope=m.rake/(m.height-base[1]);
  const t=(base[2]+slope*(a[1]-base[1])-a[2])/((b[2]-a[2])-slope*(b[1]-a[1]));
  return {id:mast+1,mast,kind:'lateen',corners,pivot:a.map((v,i)=>v+t*(b[i]-v)),belly:s.belly};
});

const mix=(a,b,t)=>a+(b-a)*t;
export const rigClamp=(x,a=0,b=1)=>Math.max(a,Math.min(b,x));
export function rigSmooth(a,b,x){const t=rigClamp((x-a)/(b-a));return t*t*(3-2*t);}
export function lateenSheetTarget(target,mast){return rigClamp(.30+Math.abs(target)*[.76,.72,.68][mast],.30,1.15);}
export function createLateenPoses(set,side=-1){
  return Array.from({length:3},(_,i)=>({side,opening:.30,dip:0,fill:0,deployed:set[i]}));
}
export function advanceLateenRig(s,boat,dt){
  const approach=(value,target,rate)=>value+rigClamp(target-value,-rate*dt,rate*dt);
  const targetSide=-s.tack;
  if(!s.rigInitialized){
    for(const p of s.rig)p.side=targetSide;
    s.rigInitialized=true;
  }
  if(!s.maneuver){
    const changed=s.rig.some(p=>p.side!==targetSide)&&Math.abs(s.windSide)>.5;
    s.tackWait=changed?(s.tackWait??0)+dt:0;
    if(s.tackWait>=.6)s.maneuver={side:targetSide,stage:'gather',mast:0};
  }
  const m=s.maneuver;
  if(m){
    // Finish an underway transfer before accepting another wind reversal.
    // All canvas is gathered before the yards move, avoiding neighbouring sails.
    const ready=boat.crewRigRate?Math.min(...boat.crewRigRate):1;
    if(ready>0){
      if(m.stage==='gather'){
        for(const p of s.rig)p.deployed=approach(p.deployed,0,.35*ready);
        if(s.rig.every(p=>p.deployed===0))m.stage='align';
      }else if(m.stage==='align'){
        for(const p of s.rig)p.opening=approach(p.opening,0,.5);
        if(s.rig.every(p=>p.opening===0))m.stage='raise';
      }else if(m.stage==='raise'){
        const p=s.rig[m.mast];p.dip=approach(p.dip,1,.25);
        if(p.dip===1){m.stage='pass';m.angle=Math.acos(p.side);}
      }else if(m.stage==='pass'){
        const p=s.rig[m.mast],angle=m.side>0?0:Math.PI;
        m.angle=approach(m.angle,angle,.45);p.side=Math.cos(m.angle);
        if(m.angle===angle){p.side=m.side;m.stage='lower';}
      }else if(m.stage==='lower'){
        const p=s.rig[m.mast];p.dip=approach(p.dip,0,.25);
        if(p.dip===0){m.mast++;m.stage=m.mast<3?'raise':'sheet';}
      }else if(m.stage==='sheet'){
        for(let i=0;i<3;i++)s.rig[i].opening=approach(s.rig[i].opening,lateenSheetTarget(s.lateenTarget,i),.45);
        if(s.rig.every(p=>p.opening>=.30))m.stage='set';
      }else{
        const requested=[boat.sailFore??1,boat.sailMain??1,boat.sailMizzen??1].map(v=>rigClamp(v));
        for(let i=0;i<3;i++)s.set[i]=s.rig[i].deployed=approach(s.rig[i].deployed,requested[i],.22*ready);
        if(s.rig.every((p,i)=>p.deployed===requested[i])){s.maneuver=null;s.tackWait=0;}
      }
    }
  }else{
    for(let i=0;i<3;i++){
      const p=s.rig[i];p.deployed=s.set[i];
      p.opening=approach(p.opening,lateenSheetTarget(s.lateenTarget,i),.4-i*.035);
    }
  }
  s.canvasTack=-s.rig.reduce((sum,p)=>sum+p.side,0)/3;
}

// The same per-mast poses drive canvas, yards, rope leads, shadows and wetness.
export function writeLateenUniform(h,s){
  for(let i=0;i<3;i++){
    const p=s.rig[i];h[24+i]=p.deployed;h.set([p.opening,p.side,p.dip,p.fill],36+i*4);
  }
}
const dot=(a,b)=>a.reduce((s,x,i)=>s+x*b[i],0);
const sub=(a,b)=>a.map((v,i)=>v-b[i]);
const cross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
export function rotateAxis(p,axis,angle){
  const c=Math.cos(angle),s=Math.sin(angle),q=cross(axis,p),d=dot(axis,p);
  return p.map((v,i)=>v*c+q[i]*s+axis[i]*d*(1-c));
}
export function lateenRestPoint(mast,u,v){
  const s=SAIL_PLAN[mast],[a,b,c]=s.corners;
  const p=a.map((x,i)=>x+(b[i]-x)*u+(c[i]-x)*v);
  p[0]+=s.belly*27*u*v*(1-u-v);return p;
}
export function lateenYardPoint(mast,point,pose){
  const s=SAIL_PLAN[mast],[a,b]=s.corners;
  const angle=-Math.atan2(a[2]-b[2],a[1]-b[1])*pose.dip;
  const q=rotateAxis(sub(point,s.pivot),[1,0,0],angle);
  const radius=[.46,.40,.34][mast]+pose.dip*.22;
  // The gathered yard passes abaft its mast. It never interpolates through it.
  q[0]+=pose.side*radius;
  q[2]+=Math.sqrt(Math.max(0,1-pose.side*pose.side))*radius;
  q[1]+=pose.dip*[.85,1.80,1.35][mast];
  return q.map((v,i)=>v+s.pivot[i]);
}
export function lateenClothPoint(mast,u,v,pose,time=0,wind=7){
  const s=SAIL_PLAN[mast],[a,b]=s.corners,axis=sub(b,a),n=Math.hypot(...axis);
  axis.forEach((x,i)=>axis[i]=x/n);
  // Affine brailing gathers the clew to the middle of the yard. Sending it to
  // the upper tip dragged its sheets through the next mast's canvas.
  const rest=lateenRestPoint(mast,u,v),clewAlong=dot(sub(s.corners[2],a),axis)/n;
  const onYard=a.map((x,i)=>mix(x,b[i],u+clewAlong*v));
  let p=onYard.map((x,i)=>mix(x,rest[i],mix(.012,1,pose.deployed)));
  const belly=27*u*v*Math.max(0,1-u-v),slack=1-rigSmooth(.2,.85,pose.fill);
  p[0]=pose.side*(p[0]*(.12+.88*pose.fill)+pose.deployed*Math.min(wind/4,1)*belly*
    (.15*slack*slack*Math.sin(time*7+u*17+v*11)+.003*pose.fill*Math.sin(time*.7)));
  p=rotateAxis(sub(p,a),axis,-pose.side*pose.opening).map((x,i)=>x+a[i]);
  return lateenYardPoint(mast,p,pose);
}

// Two sheets stay led to opposite quarters: the working sheet carries load,
// and the lazy sheet hangs below the foot. Halyards support the sling, not the
// upper yard tip. Tack lines control the forward heel of each long yard.
export function runningRiggingLines(){
  const lines=[];
  for(const sail of SAIL_PLAN){
    const {mast,id,corners,pivot}=sail,z=Math.min(5.5,corners[2][2]+.55);
    for(const side of [-1,1])lines.push({kind:'sheet',mast,side,a:corners[2],b:[side*1.0,vesselDeck(z)+.18,z],r:.016,r2:.016,sides:8,id,weights:[1,0]});
    const axis=sub(corners[1],corners[0]),length=Math.hypot(...axis);
    const sling=pivot.map((v,i)=>v+axis[i]/length*[.4,.45,.75][mast]);
    lines.push({kind:'halyard',mast,side:0,a:mastPoint(mast,RIG_MASTS[mast].height*.97),b:sling,r:.022,r2:.022,sides:8,id,weights:[0,1]});
    const tackZ=Math.max(-6.1,corners[1][2]-.25);
    lines.push({kind:'tack',mast,side:0,a:corners[1],b:[0,vesselDeck(tackZ)+.12,tackZ],r:.018,r2:.018,sides:8,id,weights:[1,0]});
  }
  return lines;
}

export function lateenRopePoint(line,t,poses,time=0,wind=7){
  const p=poses[line.mast];let a=line.a,b=line.b;
  if(line.kind==='sheet')a=lateenClothPoint(line.mast,0,1,p,time,wind);
  if(line.kind==='tack')a=lateenYardPoint(line.mast,SAIL_PLAN[line.mast].corners[1],p);
  if(line.kind==='halyard')b=lateenYardPoint(line.mast,line.b,p);
  let point=a.map((x,i)=>mix(x,b[i],t));
  if(line.kind==='sheet'){
    const lazy=1-rigSmooth(-.25,.25,line.side*p.side);
    const lead=[-b[0],b[1]-.05,b[2]-.12],q=t<.72?t/.72:(t-.72)/.28;
    const slack=t<.72?a.map((x,i)=>mix(x,lead[i],q)):lead.map((x,i)=>mix(x,b[i],q));
    slack[1]-=Math.sin(Math.PI*q)*(t<.72?.25:.02);
    point[1]-=Math.sin(Math.PI*t)*(.04+p.dip*.35);
    point=point.map((x,i)=>mix(x,slack[i],lazy));
    // The mizzen's leads are forward of its clew: carry their slack abaft the
    // vertical bundle during transfer. The other sheets already lead aft.
    if(line.mast===2)point[2]+=p.dip*.45*Math.sin(Math.PI*t);
  }else if(line.kind==='tack')point[1]-=Math.sin(Math.PI*t)*(.06+p.dip*.2);
  return point;
}

export const RIG_LINES=[...standingRiggingLines(),...runningRiggingLines()];
export const RIG_SEGMENTS=12;
export function ropeParameter(line,step){
  const t=step/RIG_SEGMENTS;return ['shroud','runner','stay','fall'].includes(line.kind)?t*t:t;
}

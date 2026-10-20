// Shared authored square/fore-and-aft cloth model. Geometry drives forces,
// visible sails, their ropes, shadows and wetness; no requested-speed propulsion.
import {VICTORY_SAILS,VICTORY_STANDING_LINES,victorySailPoint} from './models/victory.js';

const victoryMotionClamp=(x,a,b)=>Math.max(a,Math.min(b,x));
export function victoryPose(sail,state){
  const yaw=sail.kind==='square'?victoryMotionClamp(state.squareYaw,-.4,.4):sail.kind==='spanker'?victoryMotionClamp(state.lateenYaw,-.5,.5):state.lateenYaw;
  const across=state.windSide??0,along=-(state.windForward??0);
  const normal=victoryRotateVector(sail,sail.kind==='square'?[0,0,1]:[1,0,0],yaw),pressure=across*normal[0]+along*normal[2];
  return {yaw,deployed:state.set[sail.mast],fill:state.rig[sail.mast].fill,pressure:victoryMotionClamp(pressure/1.5,-1,1)};
}
export function victoryClothPoint(id,u,v,pose,time=0,wind=0){
  const sail=VICTORY_SAILS[id-1],rest=victorySailPoint(id,u,v),square=sail.kind==='square',quad=sail.corners.length===4;
  const top=quad?victorySailPoint(id,u,0):victorySailPoint(id,u+v*.5,0);
  const set=.012+.988*pose.deployed,p=rest.map((q,i)=>top[i]+(q-top[i])*set);
  const envelope=quad?4*u*(1-u)*Math.sin(Math.PI*v):27*u*v*Math.max(0,1-u-v);
  const slack=1-victoryMotionClamp((pose.fill-.2)/.65,0,1);
  const ripple=Math.min(wind/4,1)*.035*slack*slack*Math.sin(time*6+u*17+v*13);
  p[square?2:0]+=(sail.belly??.2)*envelope*pose.deployed*pose.pressure*(.15+.85*pose.fill)+ripple*envelope*pose.deployed;
  const posed=victoryYardPoint(id,p,pose);
  // Backed square canvas bears against the supporting shrouds. A broad smooth
  // contact band resolves the actual cloth surface, keeping its triangles on
  // the forward side of the ropes without deleting either surface. The band
  // approximates fabric tension between supports; it is not a cloth solver.
  // The sewn head remains pinned to the yard. Its clear boundary tapers into
  // the contact region across the first row of cloth rather than sliding free.
  const headT=victoryMotionClamp(v/.06,0,1),headContact=headT*headT*(3-2*headT);
  if(square||sail.kind==='spanker')for(const line of VICTORY_STANDING_LINES){
    if(line.mast!==sail.mast||line.kind==='forestay')continue;
    const t=(posed[1]-line.a[1])/(line.b[1]-line.a[1]);if(t<=0||t>=1)continue;
    const x=line.a[0]+(line.b[0]-line.a[0])*t,z=line.a[2]+(line.b[2]-line.a[2])*t;
    const d=Math.abs(square?posed[0]-x:posed[2]-z),q=victoryMotionClamp((d-.28)/.32,0,1),weight=(1-q*q*(3-2*q))*headContact;
    if(square){if(posed[2]>z-.055)posed[2]+=(z-.055-posed[2])*weight;}
    else if(posed[0]*x>0&&Math.abs(posed[0])>Math.abs(x)-.055){
      const limit=Math.sign(posed[0])*Math.max(0,Math.abs(x)-.055);posed[0]+=(limit-posed[0])*weight;
    }
  }
  return posed;
}
export function victoryYardPoint(id,p,pose){
  const sail=VICTORY_SAILS[id-1],pivot=sail.pivot,q=victoryRotateVector(sail,p.map((v,i)=>v-pivot[i]),pose.yaw);
  return q.map((v,i)=>v+pivot[i]);
}
export function victoryRotateVector(sail,p,yaw){
  const c=Math.cos(yaw),s=Math.sin(yaw);
  if(sail.kind!=='headsail')return [c*p[0]+s*p[2],p[1],-s*p[0]+c*p[2]];
  const axis=sail.corners[0].map((v,i)=>v-sail.corners[1][i]),length=Math.hypot(...axis);for(let i=0;i<3;i++)axis[i]/=length;
  const dot=axis.reduce((n,v,i)=>n+v*p[i],0),cross=[axis[1]*p[2]-axis[2]*p[1],axis[2]*p[0]-axis[0]*p[2],axis[0]*p[1]-axis[1]*p[0]];
  return p.map((v,i)=>v*c+cross[i]*s+axis[i]*dot*(1-c));
}

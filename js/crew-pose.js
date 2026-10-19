import { gltfQuatMultiply } from './gltf.js';
import { climbingPoint, workingTacklePoint } from './rigging.js';
import { HULL_VERTICAL_SCALE, tillerPoint } from './hull.js';

const poseSub=(a,b)=>a.map((v,i)=>v-b[i]);
const poseDot=(a,b)=>a.reduce((n,v,i)=>n+v*b[i],0);
const poseUnit=a=>{const n=Math.hypot(...a);return a.map(v=>v/Math.max(n,1e-9));};
const poseCross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const posePosition=m=>Array.from(m.subarray(12,15));
function poseRotation(m){
  const scale=Math.hypot(m[0],m[1],m[2]),r=[m[0],m[4],m[8],m[1],m[5],m[9],m[2],m[6],m[10]].map(v=>v/scale);
  const trace=r[0]+r[4]+r[8];let q;
  if(trace>0){const s=Math.sqrt(trace+1)*2;q=[(r[7]-r[5])/s,(r[2]-r[6])/s,(r[3]-r[1])/s,s/4];}
  else {const i=r[0]>r[4]&&r[0]>r[8]?0:r[4]>r[8]?1:2,j=(i+1)%3,k=(i+2)%3;
    const s=Math.sqrt(1+r[i*3+i]-r[j*3+j]-r[k*3+k])*2;q=[0,0,0,0];q[i]=s/4;q[j]=(r[i*3+j]+r[j*3+i])/s;q[k]=(r[i*3+k]+r[k*3+i])/s;q[3]=(r[k*3+j]-r[j*3+k])/s;}
  return q;
}
function turnBone(a,node,from,to){
  const u=poseUnit(from),v=poseUnit(to),dot=poseDot(u,v);
  let delta=dot<-.9999?[...poseUnit(poseCross(u,Math.abs(u[0])<.8?[1,0,0]:[0,1,0])),0]:[...poseCross(u,v),1+dot];
  const n=Math.hypot(...delta);delta=delta.map(x=>x/Math.max(n,1e-9));
  const parent=a.parent[node],q=parent<0?[0,0,0,1]:poseRotation(a.world[parent]),inv=[-q[0],-q[1],-q[2],q[3]];
  const p=new Float32Array(4),local=new Float32Array(4);gltfQuatMultiply(p,inv,delta);gltfQuatMultiply(local,p,q);
  gltfQuatMultiply(p,local,a.pose[node].r);a.pose[node].r.set(p);a.update();
}
export function solveCrewLimb(a,names,target,pole){
  const nodes=names.map(n=>a.names.indexOf(n));if(nodes.some(n=>n<0))return;
  const [upper,lower,end]=nodes,A=posePosition(a.world[upper]),B=posePosition(a.world[lower]),C=posePosition(a.world[end]);
  const l1=Math.hypot(...poseSub(B,A)),l2=Math.hypot(...poseSub(C,B)),ray=poseSub(target,A),dir=poseUnit(ray);
  const d=Math.max(Math.abs(l1-l2)+.001,Math.min(l1+l2-.001,Math.hypot(...ray)));
  const x=(l1*l1-l2*l2+d*d)/(2*d),h=Math.sqrt(Math.max(0,l1*l1-x*x));
  const p=poseSub(pole,A),bend=poseUnit(p.map((v,i)=>v-dir[i]*poseDot(p,dir)));
  const elbow=A.map((v,i)=>v+dir[i]*x+bend[i]*h);
  turnBone(a,upper,poseSub(B,A),poseSub(elbow,A));
  const b=posePosition(a.world[lower]),c=posePosition(a.world[end]);
  turnBone(a,lower,poseSub(c,b),poseSub(target,b));
}
function actorLocal(p,s){
  const dx=p[0]-s.position[0],dy=p[1]-s.position[1],dz=p[2]-s.position[2],c=Math.cos(s.yaw),sn=Math.sin(s.yaw);
  return [(c*dx-sn*dz)/s.scale[0],dy/s.scale[1],(sn*dx+c*dz)/s.scale[2]];
}
export function poseCrewWork(a,s,boat){
  const j=s.job;s.grips=null;
  if(j && ['ascending','descending','working'].includes(j.stage) && (j.kind==='rig'||j.kind==='lookout')){
    const phase=j.rung,targets={};
    for(const [side,offset] of [['l',0],['r',1]]){
      // Alternate hand-over-hand holds with a simplified boot lock on the runner.
      const cycle=(phase+offset)/2,base=Math.floor(cycle)*2-offset,f=cycle-Math.floor(cycle);
      const swing=Math.max(0,Math.min(1,(f-.55)/.45)),e=swing*swing*(3-2*swing);
      const foot=base+1+e*2,hand=foot+3;
      const point=r=>{const p=climbingPoint(j.mast,j.side,r,boat.sailState?.rig[j.mast]);return actorLocal([p[0]*boat.beam/3.6,p[1]*HULL_VERTICAL_SCALE+.08,p[2]*boat.length/12+(side==='l'?.025:-.025)],s);};
      const ft=point(foot),ht=point(hand),sign=side==='l'?1:-1;
      solveCrewLimb(a,[`thigh_${side}`,`calf_${side}`,`foot_${side}`],ft,[sign*.3,.5,.65]);
      solveCrewLimb(a,[`upperarm_${side}`,`lowerarm_${side}`,`hand_${side}`],ht,[sign*.65,1.1,.10]);
      targets[`foot_${side}`]=ft;targets[`hand_${side}`]=ht;
    }
    s.grips=targets;return;
  }
  if(j?.stage==='working' && (j.kind==='haul'||j.kind==='hatch')){
    if(j.kind==='hatch')a.blend('Brace',s.time,.8);
    const phase=s.time*3.4;
    for(const [side,sign] of [['l',1],['r',-1]]){
      let hand;
      if(j.kind==='haul'){
        const height=(s.position[1]+1.04+.17*Math.sin(phase+sign*.55))/HULL_VERTICAL_SCALE;
        const p=workingTacklePoint(j.mast,height);
        hand=actorLocal([p[0]*boat.beam/3.6,p[1]*HULL_VERTICAL_SCALE,p[2]*boat.length/12],s);
      }else hand=[sign*.16,.42+.06*Math.sin(phase),.43];
      solveCrewLimb(a,[`upperarm_${side}`,`lowerarm_${side}`,`hand_${side}`],hand,[sign*.6,1,.10]);
    }
  }else if(s.role==='Helmsman'){
    a.blend('Brace',s.time,.4);
    for(const [side,sign] of [['l',1],['r',-1]]){
      const p=tillerPoint(boat,sign*.09);p[0]+=sign*.035;
      const target=actorLocal(p,s);
      solveCrewLimb(a,[`upperarm_${side}`,`lowerarm_${side}`,`hand_${side}`],target,[sign*.6,1,.3]);
    }
  }
}

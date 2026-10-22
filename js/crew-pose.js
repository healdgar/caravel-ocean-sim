import { gltfQuatMultiply } from './gltf.js';
import { vesselVerticalScale } from './hull.js';
import { resolveShipNode, requirePlayableShipModel } from './ship-models.js';
import { crewRunnerMetrics, crewGunneryTool, crewMastName, hasExtendedCrewModel } from './crew-work.js';
import {ADDITIONAL_DESIGNS} from './models/additional.js';
import {proceduralDesign} from './models/procedural.js';

const poseSub=(a,b)=>a.map((v,i)=>v-b[i]);
const poseDot=(a,b)=>a.reduce((n,v,i)=>n+v*b[i],0);
const poseUnit=a=>{const n=Math.hypot(...a);return a.map(v=>v/Math.max(n,1e-9));};
const poseCross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const posePosition=m=>Array.from(m.subarray(12,15));
const poseNodeIndex=(a,name)=>a.nodeIndex?a.nodeIndex(name):a.names.indexOf(name);
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
  gltfQuatMultiply(p,local,a.pose[node].r);a.pose[node].r.set(p);
  if(a.updateBranch)a.updateBranch(node);else a.update();
}
export function solveCrewLimb(a,names,target,pole){
  const upper=poseNodeIndex(a,names[0]),lower=poseNodeIndex(a,names[1]),end=poseNodeIndex(a,names[2]);if(upper<0||lower<0||end<0)return;
  const A=posePosition(a.world[upper]),B=posePosition(a.world[lower]),C=posePosition(a.world[end]);
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
  const x=c*dx-sn*dz,z=sn*dx+c*dz,pitch=s.climbPitch??0,cp=Math.cos(pitch),sp=Math.sin(pitch);
  return [x/s.scale[0],(cp*dy+sp*z)/s.scale[1],(-sp*dy+cp*z)/s.scale[2]];
}
function poseMoveBone(a,node,target){
  const at=posePosition(a.world[node]),delta=poseSub(target,at),parent=a.parent[node];
  if(parent<0)a.pose[node].t.set(a.pose[node].t.map((v,i)=>v+delta[i]));
  else{
    const matrix=a.world[parent];
    for(let k=0;k<3;k++){const axis=Array.from(matrix.subarray(k*4,k*4+3));a.pose[node].t[k]+=poseDot(axis,delta)/Math.max(1e-12,poseDot(axis,axis));}
  }
  if(a.updateBranch)a.updateBranch(node);else a.update();
}
function poseHullPoint(p,s){
  const x=p[0]*s.scale[0],y=p[1]*s.scale[1],z=p[2]*s.scale[2],c=Math.cos(s.yaw),sn=Math.sin(s.yaw),pitch=s.climbPitch??0,cp=Math.cos(pitch),sp=Math.sin(pitch),Y=cp*y-sp*z,Z=sp*y+cp*z;
  return [s.position[0]+c*x+sn*Z,s.position[1]+Y,s.position[2]-sn*x+c*Z];
}
// Seat is an authoritative pelvis anchor, never the standing actor root. This
// permits real knees/boots on the floor while both hands follow one blade pose.
export function poseSeatedCrew(a,s,targets=s.seatedPose){
  if(!targets)return false;
  const pelvis=poseNodeIndex(a,'pelvis');if(pelvis<0)throw Error('Seated crew requires a pelvis joint');
  const lean=targets.body?.lean??0;
  turnBone(a,pelvis,[0,1,0],[0,Math.cos(lean),Math.sin(lean)]);
  poseMoveBone(a,pelvis,actorLocal(targets.seat,s));
  const grips={};
  for(const [i,side]of ['l','r'].entries()){
    const sign=side==='l'?1:-1,foot=actorLocal(targets.feet[i],s),hand=actorLocal(targets.hands[i],s);
    solveCrewLimb(a,['thigh_'+side,'calf_'+side,'foot_'+side],foot,[sign*.22,.18,.8]);
    solveCrewLimb(a,['upperarm_'+side,'lowerarm_'+side,'hand_'+side],hand,[sign*.6,.6,.15]);
    grips['foot_'+side]=foot;grips['hand_'+side]=hand;
  }
  s.grips=grips;
  const point=name=>{const index=poseNodeIndex(a,name);if(index<0)throw Error('Seated crew requires '+name);return poseHullPoint(posePosition(a.world[index]),s);};
  const left=point('foot_l'),right=point('foot_r');s.moisturePoints=[left.map((v,i)=>(v+right[i])*.5),point('pelvis'),point('spine_02'),point('Head')];
  return true;
}
export function poseCrewWork(a,s,boat){
  const j=s.job;s.grips=null;
  if(!j&&poseSeatedCrew(a,s))return;
  if(j && !j.lookoutAtStation && ['ascending','descending','working'].includes(j.stage) && (j.kind==='rig'||j.kind==='lookout')){
    // The tall first-rate's ratlines are farther apart. Hands can slide along
    // the shroud between them; keep the human gait at a reachable 32 cm stride.
    const spacing=boat.modelId==='victory'||ADDITIONAL_DESIGNS[boat.modelId]||hasExtendedCrewModel(boat.modelId)?crewRunnerMetrics(boat,j.mast,j.side).dy/.32:1;
    const phase=j.rung*spacing,targets={};
    for(const [side,offset] of [['l',0],['r',1]]){
      // Alternate hand-over-hand holds with a simplified boot lock on the runner.
      const cycle=(phase+offset)/2,base=Math.floor(cycle)*2-offset,f=cycle-Math.floor(cycle);
      const swing=Math.max(0,Math.min(1,(f-.55)/.45)),e=swing*swing*(3-2*swing);
      const foot=base+1+e*2,hand=foot+3;
      const point=r=>{const p=resolveShipNode(boat,`mast.${crewMastName(boat,j.mast)}.runner`,{space:'design',side:j.side,step:r/spacing});return actorLocal([p[0]*boat.beam/3.6,p[1]*vesselVerticalScale(boat)+.08,p[2]*boat.length/12+(side==='l'?.025:-.025)],s);};
      const ft=point(foot),ht=point(hand),sign=side==='l'?1:-1;
      solveCrewLimb(a,[`thigh_${side}`,`calf_${side}`,`foot_${side}`],ft,[sign*.3,.5,.65]);
      solveCrewLimb(a,[`upperarm_${side}`,`lowerarm_${side}`,`hand_${side}`],ht,[sign*.65,1.1,.10]);
      targets[`foot_${side}`]=ft;targets[`hand_${side}`]=ht;
    }
    s.grips=targets;return;
  }
  if(j?.kind==='gunnery'&&j.stage==='working'){
    const tool=crewGunneryTool(s,boat);if(!tool?.hands)return;
    a.blend('Brace',s.time,j.gunRole==='loader'?.50:.22);
    for(const [i,side]of ['l','r'].entries()){
      const hand=actorLocal(tool.hands[i],s),sign=side==='l'?1:-1;
      solveCrewLimb(a,[`upperarm_${side}`,`lowerarm_${side}`,`hand_${side}`],hand,[sign*.6,1,.2]);
      (s.grips??={})[`hand_${side}`]=hand;
    }
    return;
  }
  if(j?.stage==='working' && (j.kind==='haul'||j.kind==='hatch')){
    if(j.kind==='hatch')a.blend('Brace',s.time,.8);
    const phase=s.time*3.4;
    for(const [side,sign] of [['l',1],['r',-1]]){
      let hand;
      if(j.kind==='haul'){
        const pull=boat.modelId==='victory'?1.10+.12*Math.sin(phase+sign*.55):1.04+.17*Math.sin(phase+sign*.55);
        const height=(s.position[1]+pull)/vesselVerticalScale(boat);
        const p=resolveShipNode(boat,`rig.${j.controlGroup??crewMastName(boat,j.mast)}.fall`,{space:'design',height});
        hand=actorLocal([p[0]*boat.beam/3.6,p[1]*vesselVerticalScale(boat),p[2]*boat.length/12],s);
      }else if(hasExtendedCrewModel(boat.modelId)&&requirePlayableShipModel(boat.modelId).nodes['hatch.grip']){
        const grip=resolveShipNode(boat,'hatch.grip');grip[0]+=sign*.10;
        hand=actorLocal(grip,s);
      }else if(ADDITIONAL_DESIGNS[boat.modelId]||hasExtendedCrewModel(boat.modelId)){
        const h=(ADDITIONAL_DESIGNS[boat.modelId]??proceduralDesign(boat.modelId)).hatch;
        if(!h)continue;
        hand=actorLocal([(h.centre[0]+h.size[0]/2)*boat.beam/3.6,h.centre[1]*vesselVerticalScale(boat)+.04*Math.sin(phase),h.centre[2]*boat.length/12+sign*.12],s);
      }else hand=[sign*.16,(boat.modelId==='victory'?.70:.42)+.06*Math.sin(phase),.43];
      solveCrewLimb(a,[`upperarm_${side}`,`lowerarm_${side}`,`hand_${side}`],hand,[sign*.6,1,.10]);
      (s.grips??={})[`hand_${side}`]=hand;
    }
  }else if(s.role==='Helmsman'||s.roles?.includes('helmsman')){
    a.blend('Brace',s.time,boat.modelId==='victory'?0:.4);
    for(const [side,sign] of [['l',1],['r',-1]]){
      const p=resolveShipNode(boat,'helm.grip',{along:sign*(boat.modelId==='victory'?-.09:.09)});if(boat.modelId!=='victory')p[0]+=sign*.035;
      const target=actorLocal(p,s);
      solveCrewLimb(a,[`upperarm_${side}`,`lowerarm_${side}`,`hand_${side}`],target,[sign*.6,1,.3]);
      (s.grips??={})[`hand_${side}`]=target;
    }
  }
}

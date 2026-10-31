import { gltfQuatMultiply } from './gltf.js';
import { vesselVerticalScale } from './hull.js';
import { resolveShipNode, requirePlayableShipModel } from './ship-models.js';
import { crewRunnerMetrics, crewGunneryTool, crewMastName, hasExtendedCrewModel, crewRowingWalkContacts, crewDeckHeight } from './crew-work.js';
import {ADDITIONAL_DESIGNS} from './models/additional.js';
import {proceduralDesign} from './models/procedural.js';
import {VICTORY_DESIGN} from './models/victory.js';

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
function poseNeutralSeatedBody(a){
  // Idle's hip sway and torso twist are inappropriate under a constrained
  // seated stroke: they place one shoulder behind the other. Keep authored
  // neutral transforms and actual limb lengths, then apply the shared lean.
  let branch=-1;
  for(const name of ['root','pelvis','spine_01','spine_02','spine_03','clavicle_l','clavicle_r']){
    const node=poseNodeIndex(a,name);if(node<0)continue;
    const rest=a.rest[node],pose=a.pose[node];pose.t.set(rest.t);pose.r.set(rest.r);pose.s.set(rest.s);if(branch<0)branch=node;
  }
  if(branch>=0&&a.updateBranch)a.updateBranch(branch);else a.update();
}
// Seat is an authoritative pelvis anchor, never the standing actor root. This
// permits real knees/boots on the floor while both hands follow one blade pose.
export function poseSeatedCrew(a,s,targets=s.seatedPose){
  if(!targets)return false;
  const pelvis=poseNodeIndex(a,'pelvis');if(pelvis<0)throw Error('Seated crew requires a pelvis joint');
  poseNeutralSeatedBody(a);
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
function poseRowingWalkingFeet(a,s,boat){
  const contacts=crewRowingWalkContacts(s,boat,a.footContacts??{});if(!contacts)return false;
  // Keep the imported upper-body gait, but place an untwisted pelvis over the
  // two real sole targets. Leg lengths and every authored bone scale survive.
  for(const name of ['root','pelvis']){
    const node=poseNodeIndex(a,name);if(node<0)continue;
    a.pose[node].t.set(a.rest[node].t);a.pose[node].r.set(a.rest[node].r);a.pose[node].s.set(a.rest[node].s);
  }
  a.update();
  const pelvis=poseNodeIndex(a,'pelvis'),base=posePosition(a.world[pelvis]),targets=[];
  for(const [i,side]of ['l','r'].entries()){
    const f=a.footContacts[side],p=contacts.feet[i].sole.slice();p[1]+=f.ankleAboveSole*s.scale[1];targets.push(actorLocal(p,s));
  }
  const restAnkle=(a.footContacts.l.ankle[1]+a.footContacts.r.ankle[1])*.5;
  const raised=(targets[0][1]+targets[1][1])*.5-restAnkle;
  poseMoveBone(a,pelvis,[base[0],base[1]+raised-.035,base[2]]);
  // A high/low step bends the knees rather than stretching the floor leg. Find
  // the shared pelvis height permitted by the two actual two-bone chains.
  let lower=0;
  for(const [i,side]of ['l','r'].entries()){
    const hip=posePosition(a.world[poseNodeIndex(a,'thigh_'+side)]),knee=posePosition(a.world[poseNodeIndex(a,'calf_'+side)]),ankle=posePosition(a.world[poseNodeIndex(a,'foot_'+side)]),length=Math.hypot(...poseSub(knee,hip))+Math.hypot(...poseSub(ankle,knee))-.006;
    const horizontal=Math.hypot(targets[i][0]-hip[0],targets[i][2]-hip[2]),height=Math.sqrt(Math.max(0,length*length-horizontal*horizontal));
    lower=Math.min(lower,targets[i][1]+height-hip[1]);
  }
  if(lower<0){const p=posePosition(a.world[pelvis]);p[1]+=lower;poseMoveBone(a,pelvis,p);}
  for(const [i,side]of ['l','r'].entries()){
    const sign=side==='l'?1:-1,f=a.footContacts[side],target=targets[i];
    solveCrewLimb(a,['thigh_'+side,'calf_'+side,'foot_'+side],target,[sign*.25,.35,.85]);
    // Undo the ankle rotation introduced by leg IK. The measured sole stays
    // level; its authored boot/toe geometry is unchanged.
    const foot=f.node,parent=a.parent[foot],q=poseRotation(a.world[parent]),inverse=[-q[0],-q[1],-q[2],q[3]],yaw=contacts.feet[i].yaw-s.yaw,turn=[0,Math.sin(yaw/2),0,Math.cos(yaw/2)],desired=new Float32Array(4),local=new Float32Array(4);
    gltfQuatMultiply(desired,turn,poseRotation(f.restWorld));gltfQuatMultiply(local,inverse,desired);a.pose[foot].r.set(local);
    const toe=poseNodeIndex(a,'ball_'+side);if(toe>=0)a.pose[toe].r.set(a.rest[toe].r);
    if(a.updateBranch)a.updateBranch(foot);else a.update();
    (s.grips??={})['foot_'+side]=target;
  }
  s.walkContacts=contacts;
  const point=name=>poseHullPoint(posePosition(a.world[poseNodeIndex(a,name)]),s),left=point('foot_l'),right=point('foot_r');
  s.moisturePoints=[left.map((v,i)=>(v+right[i])*.5),point('pelvis'),point('spine_02'),point('Head')];return true;
}
function poseGroundedGunBody(a,s,boat,requestedLean,hands=null){
  poseNeutralSeatedBody(a);
  const pelvis=poseNodeIndex(a,'pelvis');if(pelvis<0)throw Error('Gunnery stance requires a pelvis');
  const sx=boat.beam/3.6,sz=boat.length/12,sy=vesselVerticalScale(boat),c=Math.cos(s.yaw),sn=Math.sin(s.yaw);
  const floor=(x,z)=>crewDeckHeight(boat,z/sz,x/sx)*sy,feet=[];
  let platformMin=-Infinity,platformMax=Infinity;
  if(boat.modelId==='victory'){
    // The quarterdeck ends at a real, tall poop-deck rise. Place each complete
    // measured boot on the worker's platform, rather than straddling that wall.
    const d=VICTORY_DESIGN.decks,z=s.position[2]/sz;
    for(const edge of [d.forecastle.end,d.quarter.start,d.poop.start]){
      if(z<edge)platformMax=Math.min(platformMax,edge*sz);else platformMin=Math.max(platformMin,edge*sz);
    }
  }
  for(const side of ['l','r']){
    const f=a.footContacts?.[side];if(!f)throw Error('Gunnery stance requires measured '+side+' boot');
    const x=f.ankle[0]*s.scale[0],z=f.ankle[2]*s.scale[2],X=s.position[0]+c*x+sn*z;
    let Z=s.position[2]-sn*x+c*z;
    const extent=[];
    for(const u of [f.min[0],f.max[0]])for(const v of [f.min[2],f.max[2]])extent.push(-sn*u*s.scale[0]+c*v*s.scale[2]);
    Z=Math.max(platformMin-Math.min(...extent)+.025,Math.min(platformMax-Math.max(...extent)-.025,Z));
    const step=.05,n=poseUnit([-(floor(X+step,Z)-floor(X-step,Z))/(2*step),1,-(floor(X,Z+step)-floor(X,Z-step))/(2*step)]);
    const sole=[X,floor(X,Z)+.002,Z],ankle=sole.map((v,i)=>v+n[i]*f.ankleAboveSole*s.scale[1]);
    feet.push({side,sole,ankle,normal:n,target:actorLocal(ankle,s)});
  }
  const base=posePosition(a.world[pelvis]);let lean=requestedLean,drop=0,reachExcess=0;
  if(hands&&requestedLean>0){
    const targets=hands.map(p=>actorLocal(p,s)),centre=targets[0].map((v,i)=>(v+targets[1][i])*.5),shoulders=[];
    for(const [i,side]of ['l','r'].entries()){
      const shoulder=posePosition(a.world[poseNodeIndex(a,'upperarm_'+side)]),elbow=posePosition(a.world[poseNodeIndex(a,'lowerarm_'+side)]),hand=posePosition(a.world[poseNodeIndex(a,'hand_'+side)]);
      const reach=Math.hypot(...poseSub(elbow,shoulder))+Math.hypot(...poseSub(hand,elbow));shoulders.push(shoulder);
      reachExcess=Math.max(reachExcess,Math.hypot(...poseSub(targets[i],shoulder))-reach+.015);
    }
    // A high swivel breech needs forward reach, not an automatic deep crouch.
    // Only add bend when the actual unchanged hand workspace requires it.
    if(reachExcess>0)lean=Math.max(lean,Math.min(.65,Math.atan2(Math.max(0,centre[2]-base[2]),Math.max(.10,centre[1]-base[1]))));
    const shoulderY=(shoulders[0][1]+shoulders[1][1])*.5;
    drop=Math.max(0,Math.min(.18,shoulderY-centre[1]-.22));
  }else if(requestedLean>0)drop=.12*Math.min(1,requestedLean/.45);
  const fraction=Math.max(0,Math.min(1,lean/.45));
  const lift=feet.reduce((sum,p)=>sum+p.target[1]-a.footContacts[p.side].ankle[1],0)/2;
  // Knees and the hip hinge supply the reach. The actor remains upright/yaw-only,
  // while measured boots keep the same contacts and all limb lengths survive.
  poseMoveBone(a,pelvis,[base[0],base[1]+lift-drop,base[2]+.08*fraction]);
  if(Math.abs(lean)>1e-6)for(const [name,weight]of [['pelvis',.18],['spine_01',.45],['spine_02',.37]]){
    const node=poseNodeIndex(a,name);if(node>=0){const angle=lean*weight;turnBone(a,node,[0,1,0],[0,Math.cos(angle),Math.sin(angle)]);}
  }
  let workspaceForward=0;
  if(boat.modelId==='victory'&&hands&&requestedLean>0){
    // The long gun's operator stands beside its truck. Move the bent hip within
    // a bounded standing workspace, rather than extending either actual arm.
    for(const [i,side]of ['l','r'].entries()){
      const target=actorLocal(hands[i],s),shoulder=posePosition(a.world[poseNodeIndex(a,'upperarm_'+side)]),elbow=posePosition(a.world[poseNodeIndex(a,'lowerarm_'+side)]),hand=posePosition(a.world[poseNodeIndex(a,'hand_'+side)]);
      const reach=Math.hypot(...poseSub(elbow,shoulder))+Math.hypot(...poseSub(hand,elbow))-.015;
      const across=(target[0]-shoulder[0])**2+(target[1]-shoulder[1])**2;
      workspaceForward=Math.max(workspaceForward,target[2]-shoulder[2]-Math.sqrt(Math.max(0,reach*reach-across)));
    }
    workspaceForward=Math.max(0,Math.min(.34-.08*fraction,workspaceForward));
    if(workspaceForward){const p=posePosition(a.world[pelvis]);p[2]+=workspaceForward;poseMoveBone(a,pelvis,p);}
  }
  // As in the rowing stance, lower the pelvis only as much as the genuine leg
  // lengths require. Never lengthen bones to manufacture a planted boot.
  let lower=0;
  for(const p of feet){
    const hip=posePosition(a.world[poseNodeIndex(a,'thigh_'+p.side)]),knee=posePosition(a.world[poseNodeIndex(a,'calf_'+p.side)]),ankle=posePosition(a.world[poseNodeIndex(a,'foot_'+p.side)]);
    const length=Math.hypot(...poseSub(knee,hip))+Math.hypot(...poseSub(ankle,knee))-.006,horizontal=Math.hypot(p.target[0]-hip[0],p.target[2]-hip[2]);
    lower=Math.min(lower,p.target[1]+Math.sqrt(Math.max(0,length*length-horizontal*horizontal))-hip[1]);
  }
  if(lower<0){const p=posePosition(a.world[pelvis]);p[1]+=lower;poseMoveBone(a,pelvis,p);}
  for(const p of feet){
    const side=p.side,sign=side==='l'?1:-1,f=a.footContacts[side];
    solveCrewLimb(a,['thigh_'+side,'calf_'+side,'foot_'+side],p.target,[sign*.25,.35,.85]);
    // Match the measured boot's rest orientation to the actual deck tangent;
    // leg IK must not leave a tipped ankle or rotate the sole through the deck.
    const n=poseUnit([c*p.normal[0]-sn*p.normal[2],p.normal[1],sn*p.normal[0]+c*p.normal[2]]);
    const delta=[...poseCross([0,1,0],n),1+n[1]],size=Math.hypot(...delta),alignment=delta.map(v=>v/size);
    const parent=a.parent[f.node],q=poseRotation(a.world[parent]),inverse=[-q[0],-q[1],-q[2],q[3]],desired=new Float32Array(4),local=new Float32Array(4);
    gltfQuatMultiply(desired,alignment,poseRotation(f.restWorld));gltfQuatMultiply(local,inverse,desired);a.pose[f.node].r.set(local);
    const toe=poseNodeIndex(a,'ball_'+side);if(toe>=0)a.pose[toe].r.set(a.rest[toe].r);
    if(a.updateBranch)a.updateBranch(f.node);else a.update();
    (s.grips??={})['foot_'+side]=p.target;
  }
  s.gunContacts={feet,lean,requestedLean,reachExcessBefore:reachExcess,workspaceForward};
  const point=name=>poseHullPoint(posePosition(a.world[poseNodeIndex(a,name)]),s);
  s.moisturePoints=[feet[0].sole.map((v,i)=>(v+feet[1].sole[i])*.5),point('pelvis'),point('spine_02'),point('Head')];
}
export function poseCrewWork(a,s,boat){
  const j=s.job;s.grips=null;s.walkContacts=null;s.gunContacts=null;
  if(s.casualtyState==='fallen'||(s.knockdownTimer??0)>0){
    const seed=(s.crewIndex??0)*1.37;
    const sideSign=((s.crewIndex??0)%2===0)?1:-1;
    const head=poseNodeIndex(a,'Head');
    if(head>=0)turnBone(a,head,[0,1,0],[sideSign*0.38,0.86,-0.32]);
    solveCrewLimb(a,['upperarm_l','lowerarm_l','hand_l'],[0.34+0.06*Math.sin(seed),1.05+0.12*Math.cos(seed),0.14],[0.7,0.8,0.2]);
    solveCrewLimb(a,['upperarm_r','lowerarm_r','hand_r'],[-0.18,0.88+0.06*Math.sin(seed),0.22],[-0.6,0.9,0.25]);
    solveCrewLimb(a,['thigh_l','calf_l','foot_l'],[0.18,0.14,-0.08],[0.25,0.4,0.88]);
    solveCrewLimb(a,['thigh_r','calf_r','foot_r'],[-0.22,0.06,0.06],[-0.25,0.4,0.88]);
    return;
  }
  if(!j&&poseSeatedCrew(a,s))return;
  if(j)poseRowingWalkingFeet(a,s,boat);
  if(j && !j.lookoutAtStation && ['ascending','descending','working'].includes(j.stage) && (j.kind==='rig'||j.kind==='lookout')){
    // Arrival timing must not move real runner holds through an inherited Walk
    // hip/spine sway. Limb phase below is driven only by actual rung travel.
    poseNeutralSeatedBody(a);
    // The tall first-rate's ratlines are farther apart. Hands can slide along
    // the shroud between them; keep the human gait at a reachable 32 cm stride.
    const spacing=boat.modelId==='victory'||ADDITIONAL_DESIGNS[boat.modelId]||hasExtendedCrewModel(boat.modelId)?crewRunnerMetrics(boat,j.mast,j.side).dy/.32:1;
    const phase=j.rung*spacing,base=Math.floor(phase),u=phase-base,targets={};
    const smooth=(lo,hi)=>{const t=Math.max(0,Math.min(1,(u-lo)/(hi-lo)));return t*t*(3-2*t);};
    // Two-phase rope shimmy: hands climb hand-over-hand while boots clamp the
    // line together, then the pelvis/spine crunches to draw both feet up.
    const crunch=Math.sin(Math.PI*smooth(.42,.96));
    const pelvis=poseNodeIndex(a,'pelvis');
    if(pelvis>=0){
      const p=posePosition(a.world[pelvis]);
      poseMoveBone(a,pelvis,[p[0],p[1]+.04*crunch,p[2]+.03+.03*crunch]);
    }
    for(const [name,weight] of [['spine_01',.06],['spine_02',.05]]){
      const node=poseNodeIndex(a,name);
      if(node>=0){const angle=crunch*weight;turnBone(a,node,[0,1,0],[0,Math.cos(angle),Math.sin(angle)]);}
    }
    const footBase=base+.20+smooth(.46,.94);
    const handSteps={l:base+2.65+smooth(.02,.46),r:base+3.15+smooth(.28,.72)};
    const footSteps={l:footBase+.07,r:footBase-.07};
    for(const side of ['l','r']){
      const sign=side==='l'?1:-1;
      const point=(r,wrap)=>{const p=resolveShipNode(boat,`mast.${crewMastName(boat,j.mast)}.runner`,{space:'design',side:j.side,step:r/spacing});return actorLocal([p[0]*boat.beam/3.6,p[1]*vesselVerticalScale(boat)+.08,p[2]*boat.length/12+sign*wrap],s);};
      const ft=point(footSteps[side],.014),ht=point(handSteps[side],.018);
      solveCrewLimb(a,[`thigh_${side}`,`calf_${side}`,`foot_${side}`],ft,[sign*.12,.55,.78]);
      solveCrewLimb(a,[`upperarm_${side}`,`lowerarm_${side}`,`hand_${side}`],ht,[sign*.55,.95,.18]);
      targets[`foot_${side}`]=ft;targets[`hand_${side}`]=ht;
    }
    s.grips=targets;return;
  }
  if(j?.kind==='gunnery'&&j.stage==='working'){
    const tool=crewGunneryTool(s,boat),active=s.intent==='work'&&!['ready','recoil','spent'].includes(j.gun.stage);
    a.blend('Brace',s.time,active?(j.gunRole==='loader'?.50:.22):0);
    poseGroundedGunBody(a,s,boat,active?(j.gunRole==='loader'&&boat.modelId==='victory'?.45:.10):0,tool?.hands);
    if(!tool?.hands)return;
    for(const [i,side]of ['l','r'].entries()){
      const hand=actorLocal(tool.hands[i],s),sign=side==='l'?1:-1;
      solveCrewLimb(a,[`upperarm_${side}`,`lowerarm_${side}`,`hand_${side}`],hand,[sign*.6,1,.2]);
      (s.grips??={})[`hand_${side}`]=hand;
    }
    return;
  }
  if(j?.kind==='boarding'&&j.stage==='working'){
    a.blend('Brace',s.time,0.55);
    const phase=s.time*4.2+(s.crewIndex??0)*1.15;
    const thrust=Math.sin(phase),slash=Math.cos(phase);
    const handR=[-0.12+0.10*slash,1.26+0.15*thrust,0.44+0.22*Math.max(0,thrust)];
    const handL=[0.20,1.16+0.05*slash,0.28+0.06*Math.max(0,-thrust)];
    solveCrewLimb(a,['upperarm_r','lowerarm_r','hand_r'],handR,[-0.6,1.0,0.2]);
    solveCrewLimb(a,['upperarm_l','lowerarm_l','hand_l'],handL,[0.6,1.0,0.2]);
    s.grips={hand_r:handR,hand_l:handL};
    return;
  }
  if(j?.kind==='mooring'&&j.stage==='working'){
    a.blend('Brace',s.time,0.35);
    const phase=s.time*3.2+(s.crewIndex??0)*0.8;
    for(const [side,sign] of [['l',1],['r',-1]]){
      const hand=[sign*0.16,0.96+0.14*Math.sin(phase+sign*0.5),0.38+0.12*Math.cos(phase)];
      solveCrewLimb(a,[`upperarm_${side}`,`lowerarm_${side}`,`hand_${side}`],hand,[sign*0.6,1.0,0.15]);
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
        const grip=resolveShipNode(boat,'hatch.grip');grip[0]+=sign*.10*Math.cos(s.yaw);grip[2]-=sign*.10*Math.sin(s.yaw);
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
  }else if((s.firePanic??0)>0.15){
    const panic=Math.min(1,s.firePanic??0);
    a.blend('Brace',s.time,0.65*panic);
    const wave=Math.sin(s.time*6.5+(s.crewIndex??0))*0.06;
    const shieldHand=[0.08+wave,1.46,0.24];
    const balanceHand=[-0.28,1.12-wave,0.18];
    solveCrewLimb(a,['upperarm_l','lowerarm_l','hand_l'],shieldHand,[0.6,1.0,0.25]);
    solveCrewLimb(a,['upperarm_r','lowerarm_r','hand_r'],balanceHand,[-0.6,0.9,0.2]);
  }else if(s.casualtyState==='wounded'){
    a.blend('Brace',s.time,0.48);
    const pelvis=poseNodeIndex(a,'pelvis');
    if(pelvis>=0){
      const p=posePosition(a.world[pelvis]);
      poseMoveBone(a,pelvis,[p[0],p[1]-0.055,p[2]-0.02]);
    }
    const spine=poseNodeIndex(a,'spine_02');
    if(spine>=0)turnBone(a,spine,[0,1,0],[0.08,0.96,0.26]);
    const breathe=Math.sin(s.time*2.6+(s.crewIndex??0))*0.02;
    const clutchHand=[0.05,0.98+breathe,0.21];
    solveCrewLimb(a,['upperarm_r','lowerarm_r','hand_r'],clutchHand,[-0.55,0.85,0.3]);
  }
}

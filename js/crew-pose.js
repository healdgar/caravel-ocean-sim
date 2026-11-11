import { gltfQuatMultiply } from './gltf.js';
import { vesselVerticalScale, hullDeck, HULL_VERTICAL_SCALE } from './hull.js';
import { resolveShipNode, requirePlayableShipModel } from './ship-models.js';
import { crewRunnerMetrics, crewGunneryTool, crewBoardingHands, crewMastName, hasExtendedCrewModel, crewRowingWalkContacts, crewDeckHeight, crewHelmHands } from './crew-work.js';
import { applyArticulatedRagdollPose } from './crew-physics.js';
import { CREW_SOLVE_OP } from './wgsl/crew-solve.js';
import {ADDITIONAL_DESIGNS} from './models/additional.js';
import {proceduralDesign} from './models/procedural.js';
import {VICTORY_DESIGN} from './models/victory.js';

const poseSub=(a,b)=>a.map((v,i)=>v-b[i]);
const poseDot=(a,b)=>a.reduce((n,v,i)=>n+v*b[i],0);
const poseUnit=a=>{const n=Math.hypot(...a);return a.map(v=>v/Math.max(n,1e-9));};
const poseCross=(a,b)=>[a[1]*b[2]-a[2]*b[1],a[2]*b[0]-a[0]*b[2],a[0]*b[1]-a[1]*b[0]];
const posePosition=m=>Array.from(m.subarray(12,15));
const poseNodeIndex=(a,name)=>a.nodeIndex?a.nodeIndex(name):a.names.indexOf(name);
export function poseRotation(m){
  const scale=Math.hypot(m[0],m[1],m[2]),r=[m[0],m[4],m[8],m[1],m[5],m[9],m[2],m[6],m[10]].map(v=>v/scale);
  const trace=r[0]+r[4]+r[8];let q;
  if(trace>0){const s=Math.sqrt(trace+1)*2;q=[(r[7]-r[5])/s,(r[2]-r[6])/s,(r[3]-r[1])/s,s/4];}
  else {const i=r[0]>r[4]&&r[0]>r[8]?0:r[4]>r[8]?1:2,j=(i+1)%3,k=(i+2)%3;
    const s=Math.sqrt(1+r[i*3+i]-r[j*3+j]-r[k*3+k])*2;q=[0,0,0,0];q[i]=s/4;q[j]=(r[i*3+j]+r[j*3+i])/s;q[k]=(r[i*3+k]+r[k*3+i])/s;q[3]=(r[k*3+j]-r[j*3+k])/s;}
  return q;
}
// Each step below either poses a skeleton in hand, or, given a recorder in its place (js/crew-solve.js), writes
// the step down for the GPU to do. A recorder has no joints to read, so a step that needs to know where a joint
// has got to is one whole entry, done there.
export function turnBone(a,node,from,to){
  if(a.record){a.put(CREW_SOLVE_OP.turn,a.slot(node),from[0],from[1],from[2],to[0],to[1],to[2]);return;}
  const u=poseUnit(from),v=poseUnit(to),dot=poseDot(u,v);
  let delta=dot<-.9999?[...poseUnit(poseCross(u,Math.abs(u[0])<.8?[1,0,0]:[0,1,0])),0]:[...poseCross(u,v),1+dot];
  const n=Math.hypot(...delta);delta=delta.map(x=>x/Math.max(n,1e-9));
  const parent=a.parent[node],q=parent<0?[0,0,0,1]:poseRotation(a.world[parent]),inv=[-q[0],-q[1],-q[2],q[3]];
  const p=new Float32Array(4),local=new Float32Array(4);gltfQuatMultiply(p,inv,delta);gltfQuatMultiply(local,p,q);
  gltfQuatMultiply(p,local,a.pose[node].r);a.pose[node].r.set(p);
  if(a.updateBranch)a.updateBranch(node);else a.update();
}
export function solveCrewLimb(a,names,target,pole){
  if(a.record){a.limb(CREW_SOLVE_OP.limb,names[0],target,pole);return;}
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
export function poseMoveBone(a,node,target){
  if(a.record){a.put(CREW_SOLVE_OP.move,a.slot(node),target[0],target[1],target[2]);return;}
  const at=posePosition(a.world[node]),delta=poseSub(target,at),parent=a.parent[node];
  if(parent<0)a.pose[node].t.set(a.pose[node].t.map((v,i)=>v+delta[i]));
  else{
    const matrix=a.world[parent];
    for(let k=0;k<3;k++){const axis=Array.from(matrix.subarray(k*4,k*4+3));a.pose[node].t[k]+=poseDot(axis,delta)/Math.max(1e-12,poseDot(axis,axis));}
  }
  if(a.updateBranch)a.updateBranch(node);else a.update();
}
// Move a bone by so much from wherever the pose has it.
function poseShiftBone(a,node,by){
  if(a.record){a.put(CREW_SOLVE_OP.shift,a.slot(node),by[0],by[1],by[2]);a.shifted(by);return;}
  const p=posePosition(a.world[node]);poseMoveBone(a,node,[p[0]+by[0],p[1]+by[1],p[2]+by[2]]);
}
// A reach measured from the head, wherever the pose has put it: the target's height and depth, and the pole's
// height, are given from the head's.
function solveCrewLimbFromHead(a,names,target,pole,headless){
  if(a.record){a.limb(CREW_SOLVE_OP.limbHead,names[0],target,pole);return;}
  const node=poseNodeIndex(a,'Head'),head=node>=0?posePosition(a.world[node]):headless;
  solveCrewLimb(a,names,[target[0],head[1]+target[1],head[2]+target[2]],[pole[0],head[1]+pole[1],pole[2]]);
}
// Where a hand's reach left it, to be held there. A recorder marks the hold for the GPU to read off the hand.
function poseHandReached(a,name){
  if(a.record){const p=[0,0,0];p.reached=true;return p;}
  return posePosition(a.world[poseNodeIndex(a,name)]);
}
function poseHullPoint(p,s){
  const x=p[0]*s.scale[0],y=p[1]*s.scale[1],z=p[2]*s.scale[2],c=Math.cos(s.yaw),sn=Math.sin(s.yaw),pitch=s.climbPitch??0,cp=Math.cos(pitch),sp=Math.sin(pitch),Y=cp*y-sp*z,Z=sp*y+cp*z;
  return [s.position[0]+c*x+sn*Z,s.position[1]+Y,s.position[2]-sn*x+c*Z];
}
function poseNeutralSeatedBody(a){
  // Idle's hip sway and torso twist are inappropriate under a constrained
  // seated stroke: they place one shoulder behind the other. Keep authored
  // neutral transforms and actual limb lengths, then apply the shared lean.
  if(a.record){a.put(CREW_SOLVE_OP.neutral);return;}
  let branch=-1;
  for(const name of ['root','pelvis','spine_01','spine_02','spine_03','clavicle_l','clavicle_r']){
    const node=poseNodeIndex(a,name);if(node<0)continue;
    const rest=a.rest[node],pose=a.pose[node];pose.t.set(rest.t);pose.r.set(rest.r);pose.s.set(rest.s);if(branch<0)branch=node;
  }
  if(branch>=0&&a.updateBranch)a.updateBranch(branch);else a.update();
}
// Leg IK leaves a boot tipped with its shin. Turn it back to how it stands in the
// asset, then to the normal of what it stands on, in the actor's own frame.
function poseBootFlat(a,side,normal){
  const f=a.footContacts[side],parent=a.parent[f.node],q=poseRotation(a.world[parent]),inverse=[-q[0],-q[1],-q[2],q[3]],desired=new Float32Array(4),local=new Float32Array(4);
  const delta=[...poseCross([0,1,0],normal),1+normal[1]],size=Math.hypot(...delta);gltfQuatMultiply(desired,delta.map(v=>v/size),poseRotation(f.restWorld));
  gltfQuatMultiply(local,inverse,desired);a.pose[f.node].r.set(local);
  const toe=poseNodeIndex(a,'ball_'+side);if(toe>=0)a.pose[toe].r.set(a.rest[toe].r);
  if(a.updateBranch)a.updateBranch(f.node);else a.update();
}
// Seat and feet are the surfaces a seated body rests on, never the standing actor
// root. The pelvis rides above the bench by the thigh under it and each ankle above
// the floor by the boot, both measured from this body's own skin, so all three rowed
// ships agree with one pose while both hands follow one blade.
export function poseSeatedCrew(a,s,targets=s.seatedPose){
  if(!targets)return false;
  const pelvis=poseNodeIndex(a,'pelvis');if(pelvis<0)throw Error('Seated crew requires a pelvis joint');
  poseNeutralSeatedBody(a);
  const lean=targets.body?.lean??0;
  if(a.record){
    // The seat, the hands and the ankles, each in his own frame. His wetness is still sampled about the seat, as
    // his last step left it: where his spine and head have got to is not known here.
    const hips=actorLocal(targets.seat,s),hands=[0,1].map(i=>actorLocal(targets.hands[i],s));hips[1]+=a.seatContact.pelvisAboveSeat;
    const feet=['l','r'].map((side,i)=>{const foot=actorLocal(targets.feet[i],s);foot[1]+=a.footContacts[side].ankleAboveSole;return foot;});
    a.put(CREW_SOLVE_OP.seated,lean,hips[0],hips[1],hips[2],0,0,0,...hands[0],0,...hands[1],0,...feet[0],0,...feet[1],0);
    s.grips={foot_l:feet[0],hand_l:hands[0],foot_r:feet[1],hand_r:hands[1]};
    return true;
  }
  turnBone(a,pelvis,[0,1,0],[0,Math.cos(lean),Math.sin(lean)]);
  const hips=actorLocal(targets.seat,s);hips[1]+=a.seatContact?.pelvisAboveSeat??0;
  poseMoveBone(a,pelvis,hips);
  // The low grip at the bottom of a paddle stroke is out of an arm's reach from a
  // sitting shoulder. Bow from the hips over it, as a paddler does, rather than
  // leave the hand short of the shaft or lengthen a bone.
  let excess=0,toward=null;
  for(const [i,side]of ['l','r'].entries()){
    const shoulder=posePosition(a.world[poseNodeIndex(a,'upperarm_'+side)]),elbow=posePosition(a.world[poseNodeIndex(a,'lowerarm_'+side)]),wrist=posePosition(a.world[poseNodeIndex(a,'hand_'+side)]),ray=poseSub(actorLocal(targets.hands[i],s),shoulder);
    const over=Math.hypot(...ray)-Math.hypot(...poseSub(elbow,shoulder))-Math.hypot(...poseSub(wrist,elbow))+.02;
    if(over>excess){excess=over;toward=ray;}
  }
  if(toward){
    const angle=Math.min(.6,excess/.32),along=Math.hypot(toward[0],toward[2])||1,sway=[toward[0]/along,toward[2]/along];
    for(const [name,weight]of [['spine_01',.55],['spine_02',.45]]){
      const node=poseNodeIndex(a,name);if(node>=0){const bend=angle*weight;turnBone(a,node,[0,1,0],[sway[0]*Math.sin(bend),Math.cos(bend),sway[1]*Math.sin(bend)]);}
    }
  }
  const grips={},contact=a.seatContact;
  for(const [i,side]of ['l','r'].entries()){
    // The knee stays over the line from hip to foot, a little out, not splayed through a narrow hull's side.
    const sign=side==='l'?1:-1,f=a.footContacts?.[side],foot=actorLocal(targets.feet[i],s),hand=actorLocal(targets.hands[i],s),leg=['thigh_'+side,'calf_'+side,'foot_'+side],pole=[(posePosition(a.world[poseNodeIndex(a,leg[0])])[0]+foot[0])*.5+sign*.04,.18,.8];
    if(f)foot[1]+=f.ankleAboveSole;
    solveCrewLimb(a,leg,foot,pole);
    if(f&&contact){
      // A foot out ahead of its knee leans the shin back, and the heel skinned to
      // that shin down: rest on the heel with the toes eased up, as a braced foot does.
      const knee=posePosition(a.world[poseNodeIndex(a,leg[1])]),ankle=posePosition(a.world[f.node]),lean=Math.max(0,Math.atan2(ankle[2]-knee[2],knee[1]-ankle[1]));
      const raise=contact.heelBelow*Math.cos(lean)+contact.heelBehind*Math.sin(lean)-f.ankleAboveSole;
      if(raise>.002){foot[1]+=raise;solveCrewLimb(a,leg,foot,pole);}
      poseBootFlat(a,side,[0,Math.cos(lean*.5),-Math.sin(lean*.5)]);
    }
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
  if(a.record){
    const targets=['l','r'].map((side,i)=>{const p=contacts.feet[i].sole.slice();p[1]+=a.footContacts[side].ankleAboveSole*s.scale[1];return actorLocal(p,s);});
    const raised=(targets[0][1]+targets[1][1])*.5-(a.footContacts.l.ankle[1]+a.footContacts.r.ankle[1])*.5,lean=(s.climbPitch??0)/2,level=[-Math.sin(lean),0,0,Math.cos(lean)];
    const turned=contacts.feet.map(foot=>{const yaw=foot.yaw-s.yaw;return gltfQuatMultiply([0,0,0,0],level,[0,Math.sin(yaw/2),0,Math.cos(yaw/2)]);});
    a.put(CREW_SOLVE_OP.rowFeet,raised,...targets[0],...targets[1],...turned[0],...turned[1]);
    (s.grips??={}).foot_l=targets[0];s.grips.foot_r=targets[1];s.walkContacts=contacts;
    s.moisturePoints=[poseHullPoint(targets[0].map((v,i)=>(v+targets[1][i])*.5),s),...a.bodyPoints(raised-.035).map(p=>poseHullPoint(p,s))];
    return true;
  }
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
    // Undo the ankle rotation introduced by leg IK and the actor's forward lean
    // at a halyard. The measured sole stays level; its authored boot/toe geometry
    // is unchanged.
    const foot=f.node,parent=a.parent[foot],q=poseRotation(a.world[parent]),inverse=[-q[0],-q[1],-q[2],q[3]],yaw=contacts.feet[i].yaw-s.yaw,turn=[0,Math.sin(yaw/2),0,Math.cos(yaw/2)],lean=(s.climbPitch??0)/2,level=[-Math.sin(lean),0,0,Math.cos(lean)],desired=new Float32Array(4),turned=new Float32Array(4),local=new Float32Array(4);
    gltfQuatMultiply(turned,level,turn);gltfQuatMultiply(desired,turned,poseRotation(f.restWorld));gltfQuatMultiply(local,inverse,desired);a.pose[foot].r.set(local);
    const toe=poseNodeIndex(a,'ball_'+side);if(toe>=0)a.pose[toe].r.set(a.rest[toe].r);
    if(a.updateBranch)a.updateBranch(foot);else a.update();
    (s.grips??={})['foot_'+side]=target;
  }
  s.walkContacts=contacts;
  const point=name=>poseHullPoint(posePosition(a.world[poseNodeIndex(a,name)]),s),left=point('foot_l'),right=point('foot_r');
  s.moisturePoints=[left.map((v,i)=>(v+right[i])*.5),point('pelvis'),point('spine_02'),point('Head')];return true;
}
function poseGroundedGunBody(a,s,boat,requestedLean,hands=null,{floorAt=null,stoop=false}={}){
  poseNeutralSeatedBody(a);
  const pelvis=poseNodeIndex(a,'pelvis');if(pelvis<0)throw Error('Gunnery stance requires a pelvis');
  const sx=boat.beam/3.6,sz=boat.length/12,sy=vesselVerticalScale(boat),c=Math.cos(s.yaw),sn=Math.sin(s.yaw);
  const floor=floorAt??((x,z)=>crewDeckHeight(boat,z/sz,x/sx)*sy),feet=[];
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
  if(a.record){
    // What the stance is told: which of the cases below applies, the boots, the deck under each, the hands, and
    // the two limits that come from what gun this is. How far he bends for it is found where his joints are.
    const lift=feet.reduce((sum,p)=>sum+p.target[1]-a.footContacts[p.side].ankle[1],0)/2,victoryGun=boat.modelId==='victory'?s.job?.gun:null;
    const mode=hands&&stoop?1:hands&&requestedLean>0?2:requestedLean>0?3:0,held=hands?hands.map(p=>actorLocal(p,s)):[[0,0,0],[0,0,0]];
    const dropLimit=victoryGun?.stage==='prime'?.12:victoryGun?.kind==='carronade'?.18:.36,forwardLimit=boat.modelId==='victory'&&hands&&requestedLean>0?(s.job?.gun?.stage==='prime'?.30:.46):0;
    const normals=feet.map(p=>poseUnit([c*p.normal[0]-sn*p.normal[2],p.normal[1],sn*p.normal[0]+c*p.normal[2]]));
    a.put(CREW_SOLVE_OP.gunBody,mode,requestedLean,lift,dropLimit,forwardLimit,0,0,...held[0],0,...held[1],0,...feet[0].target,0,...feet[1].target,0,...normals[0],0,...normals[1],0);
    for(const p of feet)(s.grips??={})['foot_'+p.side]=p.target;
    s.gunContacts={feet,requestedLean};
    // His wetness is sampled at his boots and, above them, where he would stand: how far he has bent is not known here.
    s.moisturePoints=[feet[0].sole.map((v,i)=>(v+feet[1].sole[i])*.5),...a.bodyPoints(lift).map(p=>poseHullPoint(p,s))];
    return;
  }
  const base=posePosition(a.world[pelvis]);let lean=requestedLean,drop=0,reachExcess=0;
  if(hands&&stoop){
    // A helmsman's bar is often lower than his hands hang. Bend the knees and hips
    // only as far as both hands need to meet it.
    const lift=feet.reduce((sum,p)=>sum+p.target[1]-a.footContacts[p.side].ankle[1],0)/2;
    for(const [i,side]of ['l','r'].entries()){
      const target=actorLocal(hands[i],s),shoulder=posePosition(a.world[poseNodeIndex(a,'upperarm_'+side)]),elbow=posePosition(a.world[poseNodeIndex(a,'lowerarm_'+side)]),hand=posePosition(a.world[poseNodeIndex(a,'hand_'+side)]);
      shoulder[1]+=lift;
      reachExcess=Math.max(reachExcess,Math.hypot(...poseSub(target,shoulder))-Math.hypot(...poseSub(elbow,poseSub(shoulder,[0,lift,0])))-Math.hypot(...poseSub(hand,elbow))+.02);
    }
    drop=Math.min(.24,reachExcess*.7);lean=Math.min(.42,reachExcess*.9);
  }else if(hands&&requestedLean>0){
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
    // Only a long gun's low bore needs the deep crouch. Priming hands sit on top
    // of the breech and a carronade is short: bent knees there enter the carriage.
    const victoryGun=boat.modelId==='victory'?s.job?.gun:null;
    drop=Math.max(0,Math.min(victoryGun?.stage==='prime'?.12:victoryGun?.kind==='carronade'?.18:.36,shoulderY-centre[1]-.16));
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
    workspaceForward=Math.max(0,Math.min((s.job?.gun?.stage==='prime'?.30:.46)-.04*fraction,workspaceForward));
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
    poseBootFlat(a,side,poseUnit([c*p.normal[0]-sn*p.normal[2],p.normal[1],sn*p.normal[0]+c*p.normal[2]]));
    (s.grips??={})['foot_'+side]=p.target;
  }
  s.gunContacts={feet,lean,requestedLean,reachExcessBefore:reachExcess,workspaceForward};
  const point=name=>poseHullPoint(posePosition(a.world[poseNodeIndex(a,name)]),s);
  s.moisturePoints=[feet[0].sole.map((v,i)=>(v+feet[1].sole[i])*.5),point('pelvis'),point('spine_02'),point('Head')];
}
// A man in the water. His stroke, and a dead body's sway, each repeat exactly, so that either is baked once as a
// loop for the GPU to play; one with a wound to show is solved here from the same numbers.
export const CREW_AFLOAT_RATE=2.8;
export const CREW_AFLOAT_LOOPS=[
  {name:'Swim',alive:true,duration:4*Math.PI/CREW_AFLOAT_RATE,rate:10},
  {name:'Float',alive:false,duration:2*Math.PI/(.35*CREW_AFLOAT_RATE),rate:5},
];
// Where in his stroke a sailor is, in seconds. Each starts somewhere of his own.
export function crewAfloatSeconds(s){return (s.time??0)+(s.crewIndex??0)*1.37/CREW_AFLOAT_RATE;}
export function poseCrewAfloat(a,alive,seconds){
  poseNeutralSeatedBody(a);
  const pelvis=poseNodeIndex(a,'pelvis'),head=poseNodeIndex(a,'Head'),neck=poseNodeIndex(a,'neck_01'),t=seconds*CREW_AFLOAT_RATE;
  if(alive){
    // Active breaststroke / treading-water pose: body submerged to the shoulders with head held clear of the sea.
    if(pelvis>=0)poseShiftBone(a,pelvis,[0,-1.08+0.04*Math.sin(t),0]);
    if(neck>=0)turnBone(a,neck,[0,1,0],[0,0.92,-0.38]);
    if(head>=0)turnBone(a,head,[0,1,0],[0.16*Math.sin(t*0.5),0.86,-0.48]);
    const scull=Math.sin(t),reach=Math.cos(t);
    const handL=[0.32+0.18*Math.max(0,scull),0.04+0.05*reach,0.18+0.16*reach];
    const handR=[-0.32-0.18*Math.max(0,scull),0.04+0.05*reach,0.18+0.16*reach];
    solveCrewLimb(a,['upperarm_l','lowerarm_l','hand_l'],handL,[0.65,0.12,-0.10]);
    solveCrewLimb(a,['upperarm_r','lowerarm_r','hand_r'],handR,[-0.65,0.12,-0.10]);
    const kick=Math.sin(t*1.5);
    solveCrewLimb(a,['thigh_l','calf_l','foot_l'],[0.18+0.06*kick,-0.72+0.12*kick,-0.10-0.08*kick],[0.26,-0.35,0.65]);
    solveCrewLimb(a,['thigh_r','calf_r','foot_r'],[-0.18+0.06*kick,-0.72-0.12*kick,-0.10+0.08*kick],[-0.26,-0.35,0.65]);
    return;
  }
  // Dead sailor floating awash on the waves: limbs buoyantly splayed and rocking with the swell.
  if(pelvis>=0)poseShiftBone(a,pelvis,[0,-0.82,0]);
  const sway=Math.sin(t*0.35);
  if(head>=0)turnBone(a,head,[0,1,0],[0.25*sway,0.94,0.22]);
  solveCrewLimb(a,['upperarm_l','lowerarm_l','hand_l'],[0.46,0.24+0.05*sway,0.08],[0.7,0.3,0.1]);
  solveCrewLimb(a,['upperarm_r','lowerarm_r','hand_r'],[-0.46,0.24-0.05*sway,0.08],[-0.7,0.3,0.1]);
  solveCrewLimb(a,['thigh_l','calf_l','foot_l'],[0.22,-0.68,0.06+0.04*sway],[0.25,-0.3,0.8]);
  solveCrewLimb(a,['thigh_r','calf_r','foot_r'],[-0.22,-0.68,0.06-0.04*sway],[-0.25,-0.3,0.8]);
}
export function poseCrewWork(a,s,boat){
  const j=s.job;s.grips=null;s.walkContacts=null;s.gunContacts=null;
  if(s.overboard?.inWater){poseCrewAfloat(a,s.overboard.alive,crewAfloatSeconds(s));return;}
  if(s.casualtyState==='fallen'||(s.knockdownTimer??0)>0){
    if(applyArticulatedRagdollPose(a,s,boat))return;
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
  if(j?.kind==='lookout' && j.lookoutAtStation){
    // Crouched inside the crow's nest basket: knees bent with boots planted on the platform,
    // torso leaning into the forward rail, left hand gripping the basket rim, and right hand
    // holding the brass spyglass up to the eye (or shading the brow) toward sightings/hazards.
    poseNeutralSeatedBody(a);
    const pelvis=poseNodeIndex(a,'pelvis');
    if(pelvis>=0)poseShiftBone(a,pelvis,[0,-0.21,-0.03]);
    for(const [name,angle] of [['pelvis',0.10],['spine_01',0.14],['spine_02',0.12]]){
      const node=poseNodeIndex(a,name);
      if(node>=0)turnBone(a,node,[0,1,0],[0,Math.cos(angle),Math.sin(angle)]);
    }
    const footL=[0.13,0.08,0.02],footR=[-0.13,0.08,-0.04];
    solveCrewLimb(a,['thigh_l','calf_l','foot_l'],footL,[0.22,0.45,0.78]);
    solveCrewLimb(a,['thigh_r','calf_r','foot_r'],footR,[-0.22,0.45,0.78]);
    // Left hand grips the circular crow's nest basket rim (+0.30m above platform floor)
    const rimHand=[0.17,0.58,0.28];
    solveCrewLimb(a,['upperarm_l','lowerarm_l','hand_l'],rimHand,[0.55,0.78,0.18]);
    const gazeYaw=s.phys?.gazeYaw??0,gazePitch=s.phys?.gazePitch??-0.05;
    const useGlass=s.phys?.usingSpyglass??true;
    // The glass is held to the eye, so it goes where the head has gone.
    const spyglassHand=useGlass
      ?[-0.05+gazeYaw*0.12,-0.02+gazePitch*0.10,0.19]
      :[-0.08+gazeYaw*0.08,0.06,0.14];
    solveCrewLimbFromHead(a,['upperarm_r','lowerarm_r','hand_r'],spyglassHand,[-0.58,-0.18,0.26],[0,1.32,0.12]);
    const actualHandR=poseHandReached(a,'hand_r');
    const actualHandL=poseHandReached(a,'hand_l');
    s.grips={foot_l:footL,foot_r:footR,hand_l:actualHandL,hand_r:actualHandR};
    return;
  }
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
    const isLookoutWatch=j.kind==='lookout'&&j.stage==='working';
    const crunch=isLookoutWatch?0.65:Math.sin(Math.PI*smooth(.42,.96));
    const pelvis=poseNodeIndex(a,'pelvis');
    if(pelvis>=0)poseShiftBone(a,pelvis,[0,isLookoutWatch?-0.08:.04*crunch,.03+.03*crunch]);
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
      const ft=point(footSteps[side],.014);
      solveCrewLimb(a,[`thigh_${side}`,`calf_${side}`,`foot_${side}`],ft,[sign*.12,.55,.78]);
      targets[`foot_${side}`]=ft;
      if(isLookoutWatch&&side==='r'){
        solveCrewLimbFromHead(a,['upperarm_r','lowerarm_r','hand_r'],[-0.06,-0.02,0.18],[-0.55,-0.15,0.24],[0,1.45,0.10]);
        targets.hand_r=poseHandReached(a,'hand_r');
      }else{
        const ht=point(handSteps[side],.018);
        solveCrewLimb(a,[`upperarm_${side}`,`lowerarm_${side}`,`hand_${side}`],ht,[sign*.55,.95,.18]);
        targets[`hand_${side}`]=ht;
      }
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
    a.blend('Brace',s.time,j.crossingGangplank?0.22:0.58);
    const {right:handR,left:handL,lunge=0,torsoTwist=0}=crewBoardingHands(s);
    const pelvis=poseNodeIndex(a,'pelvis');
    if(pelvis>=0&&!j.crossingGangplank)poseShiftBone(a,pelvis,[0,-0.05-Math.abs(lunge)*0.18,lunge]);
    for(const [name,weight] of [['spine_01',0.45],['spine_02',0.55]]){
      const node=poseNodeIndex(a,name);
      if(node>=0){
        const angle=torsoTwist*weight;
        turnBone(a,node,[0,0,1],[Math.sin(angle),0.12*Math.max(0,lunge),Math.cos(angle)]);
      }
    }
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
    // Both boots planted on his own deck, under the quarterdeck on the Niña.
    // Nor does a heel behind him climb onto the raised deck beyond his own.
    const hands=crewHelmHands(boat),sz=boat.length/12,below=(boat.modelId??'nina')==='nina'?(x,z)=>hullDeck(z/sz)*HULL_VERTICAL_SCALE:(x,z)=>crewDeckHeight(boat,Math.min(z,s.position[2])/sz,x/(boat.beam/3.6))*vesselVerticalScale(boat);
    poseGroundedGunBody(a,s,boat,0,hands,{floorAt:below,stoop:true});
    for(const [i,[side,sign]] of [['l',1],['r',-1]].entries()){
      const target=actorLocal(hands[i],s);
      solveCrewLimb(a,[`upperarm_${side}`,`lowerarm_${side}`,`hand_${side}`],target,[sign*.6,.6,-.1]);
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
    if(pelvis>=0)poseShiftBone(a,pelvis,[0,-0.055,-0.02]);
    const spine=poseNodeIndex(a,'spine_02');
    if(spine>=0)turnBone(a,spine,[0,1,0],[0.08,0.96,0.26]);
    const breathe=Math.sin(s.time*2.6+(s.crewIndex??0))*0.02;
    const clutchHand=[0.05,0.98+breathe,0.21];
    solveCrewLimb(a,['upperarm_r','lowerarm_r','hand_r'],clutchHand,[-0.55,0.85,0.3]);
  }
}

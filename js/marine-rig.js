// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import {gltfQuatMultiply,gltfMatMultiply} from './gltf.js';

export const MARINE_SWIM_PERIOD=5.2;

// The supplied SmartRig is a whale-specific 23-bone chain, without authored
// clips. Keep its bind pose and weights; add a slow travelling dorsoventral
// stroke, foil pitch and paired pectoral strokes through the existing joints.
export function createMarineRig(model){
  const animator=model?.skin?.animator,normalization=model?.normalization;
  if(!animator||!normalization)throw Error('Marine rig needs a skinned, normalized model');
  const {scale,headSign,sourceCentre}=normalization;
  if(!Number.isFinite(scale)||scale<=0||![1,-1].includes(headSign)||sourceCentre?.length!==3||!sourceCentre.every(Number.isFinite))throw Error('Invalid marine rig normalization');
  animator.sample(null,0);
  const direction=headSign===1?-1:1,axes=[direction,1,direction],C=new Float32Array(16),inverseC=new Float32Array(16);
  for(let i=0;i<3;i++){
    C[i*5]=scale*axes[i];C[12+i]=-sourceCentre[i]*scale*axes[i];
    inverseC[i*5]=axes[i]/scale;inverseC[12+i]=sourceCentre[i];
  }
  C[15]=inverseC[15]=1;
  const palette=new Float32Array(animator.joints.length*16),views=animator.joints.map((_,i)=>palette.subarray(i*16,i*16+16));
  const rawViews=animator.joints.map((_,i)=>animator.palette.subarray(i*16,i*16+16)),matrix=new Float32Array(16),delta=new Float32Array(4);
  const channels=[];
  const channel=(name,axis,amplitude,phase,bias=0)=>{
    const node=animator.names.indexOf(name);if(node<0)throw Error('Missing whale rig joint: '+name);
    const restWorld=animator.world[node],localAxis=[0,1,2].map(i=>restWorld[i*4+axis]*axes[axis]);
    const length=Math.hypot(...localAxis);for(let i=0;i<3;i++)localAxis[i]/=length;
    channels.push({node,axis:localAxis,amplitude,phase,bias});
  };
  // Convert the model-space transverse X axis into each native bone's rest
  // frame. These arbitrary Meshy bone axes are not interchangeable with X.
  for(const [index,name]of ['008','007','006','005','004','003','002'].entries())
    // The supplied rest mesh raises its tail several metres above the back.
    // Relax that display pose at the tail root for ordinary swimming, through
    // its skin weights, rather than moving the animal or hiding exposed fins.
    channel('Bone_'+name,0,[.020,.030,.038,.044,.050,.042,.032][index],-index*.2,index===0?.35:0);
  channel('Bone_020',0,.080,-1.6);channel('Bone_022',0,.080,-1.6);
  // Opposite signs about longitudinal Z raise/lower both flippers together.
  channel('Bone_015',2,.055,1.3);channel('Bone_018',2,-.055,1.3);
  function update(time,amplitude=1){
    if(!Number.isFinite(time)||!Number.isFinite(amplitude))throw Error('Invalid marine rig time or amplitude');
    const strength=Math.max(0,Math.min(1,amplitude)),phase=((time%MARINE_SWIM_PERIOD)+MARINE_SWIM_PERIOD)%MARINE_SWIM_PERIOD/MARINE_SWIM_PERIOD*Math.PI*2;
    for(let i=0;i<animator.pose.length;i++){
      animator.pose[i].t.set(animator.rest[i].t);animator.pose[i].r.set(animator.rest[i].r);animator.pose[i].s.set(animator.rest[i].s);
    }
    for(const motion of channels){
      const half=(motion.bias+Math.sin(phase+motion.phase)*motion.amplitude)*strength*.5,s=Math.sin(half);
      delta[0]=motion.axis[0]*s;delta[1]=motion.axis[1]*s;delta[2]=motion.axis[2]*s;delta[3]=Math.cos(half);
      gltfQuatMultiply(animator.pose[motion.node].r,animator.rest[motion.node].r,delta);
    }
    animator.update();
    // Vertices are already metre-scaled and reoriented by the loader. A raw
    // source-space skin matrix must undergo the same change of basis.
    for(let i=0;i<views.length;i++){gltfMatMultiply(matrix,C,rawViews[i]);gltfMatMultiply(views[i],matrix,inverseC);}
    return palette;
  }
  update(0,0);
  return {palette,update};
}

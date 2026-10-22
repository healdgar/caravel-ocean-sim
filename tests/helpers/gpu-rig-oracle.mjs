// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Explicit offline reference only. Never imported by application modules.
import {createAdditionalAssetPose} from '../../js/additional-ships.js';
import {createRowingAssetPose} from '../../js/rowing-ships.js';
import {createLaterSailAssetPose} from '../../js/later-sail-ships.js';
import {ROWING_DESIGNS} from '../../js/models/rowing.js';
import {LATER_SAIL_DESIGNS} from '../../js/models/later-sail.js';

export const GPU_RIG_ORACLE_CASES=Object.freeze([
  {name:'loaded-port',time:.3,wind:14,set:[1,1,1],yaw:[-.31,-.48,-.22],fill:1,side:-1,pressure:1,dip:0,rudder:0,hatch:1,phase:.08},
  {name:'reef-starboard',time:7.2,wind:21,set:[.25,.5,.7],yaw:[.32,.47,.24],fill:.8,side:1,pressure:1,dip:0,rudder:24,hatch:.45,phase:.29},
  {name:'luff',time:11.7,wind:8,set:[1,1,1],yaw:[-.15,.25,-.3],fill:0,side:-1,pressure:.2,dip:0,rudder:-30,hatch:0,phase:.49},
  {name:'transfer-backed',time:16.1,wind:17,set:[.012,.05,.3],yaw:[.41,-.51,.33],fill:.1,side:.15,pressure:-.6,dip:.65,rudder:7,hatch:.8,phase:.73},
  {name:'furled-recovery',time:27.3,wind:4,set:[0,0,0],yaw:[-.23,.11,-.27],fill:0,side:1,pressure:-1,dip:0,rudder:-16,hatch:.1,phase:.94},
]);

export function gpuRigOracleBoat(model,c){
  return {modelId:model.id,model,length:model.runtime.length*1.07,beam:model.runtime.beam*.91,heading:37,pitch:.10,roll:-.16,x:72,z:-31,heave:.35,rudder:c.rudder,hatchesClosed:c.hatch,
    sailState:{set:[...c.set],groupYaw:[...c.yaw],windSide:c.side*4,windForward:5,tack:c.side,
      rig:c.set.map((deployed,i)=>({deployed,yaw:c.yaw[i],fill:c.fill,side:c.side,pressure:c.pressure,opening:.6,dip:c.dip}))},
    rowingState:{phase:c.phase,rate:.42,cadence:.42,effortPort:.9,effortStarboard:.65}};
}

export function gpuRigCPUOracle(asset){
  const id=asset.model.id;
  return Object.hasOwn(ROWING_DESIGNS,id)?createRowingAssetPose(asset):Object.hasOwn(LATER_SAIL_DESIGNS,id)?createLaterSailAssetPose(asset):createAdditionalAssetPose(asset);
}

export function gpuRigOracleSamples(vertices){
  const categories=new Map();
  for(let i=0;i<vertices.length;i+=9){
    const material=vertices[i+6],kind=Math.floor(material),key=[9,10,13].includes(kind)?String(material):String(kind);
    if(!categories.has(key))categories.set(key,[]);categories.get(key).push(i/9);
  }
  const selected=new Set();
  for(const list of categories.values())for(let j=0;j<5;j++)selected.add(list[Math.round((list.length-1)*j/4)]);
  return [...selected].sort((a,b)=>a-b);
}

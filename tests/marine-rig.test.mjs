// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {loadMarineGLB} from '../js/marine-asset.js';
import {createMarineRig,MARINE_SWIM_PERIOD} from '../js/marine-rig.js';

const whaleBytes=readFileSync(new URL('../assets/wildlife/whale.glb',import.meta.url));
const close=(a,b,tolerance=4e-5)=>assert.ok(Math.abs(a-b)<tolerance,`${a} differs from ${b}`);
const transform=(m,p,at=0)=>[0,1,2].map(r=>m[at+r]*p[0]+m[at+4+r]*p[1]+m[at+8+r]*p[2]+m[at+12+r]);
const skinned=(model,palette,index)=>{
  const p=Array.from(model.vertices.subarray(index*11,index*11+3)),out=[0,0,0];
  for(let k=0;k<4;k++){
    const q=transform(palette,p,model.skin.joints[index*4+k]*16),w=model.skin.weights[index*4+k];
    for(let r=0;r<3;r++)out[r]+=q[r]*w;
  }
  return out;
};

test('whale rig restores its bind pose, remains periodic and reuses one bounded palette',()=>{
  const model=loadMarineGLB(whaleBytes),rig=createMarineRig(model),palette=rig.palette;
  assert.equal(palette.length,23*16);
  for(let i=0;i<palette.length;i++)close(palette[i],Number((i%16)%5===0));
  rig.update(1.2);const animated=palette.slice();
  assert.strictEqual(rig.update(1.2+MARINE_SWIM_PERIOD),palette);
  for(let i=0;i<palette.length;i++)close(palette[i],animated[i],2e-6);
  for(let i=0;i<100;i++)rig.update(1.2);
  assert.deepEqual(palette,animated,'updates restart from rest instead of accumulating rotations');
  rig.update(-MARINE_SWIM_PERIOD,0);
  for(let i=0;i<palette.length;i++)close(palette[i],Number((i%16)%5===0));
  assert.ok(palette.every(Number.isFinite));
  assert.throws(()=>rig.update(NaN),/Invalid/);assert.throws(()=>rig.update(0,Infinity),/Invalid/);
  assert.throws(()=>createMarineRig({}),/skinned/);
});

test('whale skin matrices use the same metre scale, heading rotation and lifted origin as loaded vertices',()=>{
  const model=loadMarineGLB(whaleBytes),rig=createMarineRig(model),{scale,sourceCentre,headSign}=model.normalization;
  const signs=[headSign===1?-1:1,1,headSign===1?-1:1];
  assert.ok(sourceCentre[1]<.85,'the source origin includes the loader body-root lift');
  for(const time of [.4,1.7,3.3]){
    rig.update(time);
    for(const index of [0,50,500,1000,2000,4000,6000,8000,10000]){
      const p=Array.from(model.vertices.subarray(index*11,index*11+3)),source=p.map((v,i)=>v/(scale*signs[i])+sourceCentre[i]),sum=[0,0,0];
      for(let k=0;k<4;k++){
        const at=model.skin.joints[index*4+k]*16,w=model.skin.weights[index*4+k],q=transform(model.skin.animator.palette,source,at);
        for(let d=0;d<3;d++)sum[d]+=q[d]*w;
      }
      const expected=sum.map((v,i)=>(v-sourceCentre[i])*scale*signs[i]),actual=skinned(model,rig.palette,index);
      for(let d=0;d<3;d++)close(actual[d],expected[d]);
    }
  }
});

test('native whale bone axes produce vertical tail strokes about stable pivots while preserving head and jaw',()=>{
  const model=loadMarineGLB(whaleBytes),rig=createMarineRig(model),a=model.skin.animator;
  const tailNode=a.names.indexOf('Bone_008'),joint=a.joints.indexOf(tailNode),at=joint*16;
  a.sample(null,0);const sourcePivot=Array.from(a.world[tailNode].subarray(12,15));
  const {scale,sourceCentre,headSign}=model.normalization,direction=headSign===1?-1:1;
  const pivot=sourcePivot.map((v,i)=>(v-sourceCentre[i])*scale*(i===1?1:direction));
  rig.update(MARINE_SWIM_PERIOD*.25);
  const m=rig.palette;
  close(m[at],1);for(const k of [1,2,4,8])close(m[at+k],0);
  close(m[at+5],Math.cos(.370));close(m[at+6],Math.sin(.370));close(m[at+9],-Math.sin(.370));close(m[at+10],Math.cos(.370));
  const moved=transform(m,pivot,at);for(let i=0;i<3;i++)close(moved[i],pivot[i]);
  for(const name of ['Bone_000','Bone_001','Bone_012','Bone_011','Bone_010','Bone_009']){
    const off=a.joints.indexOf(a.names.indexOf(name))*16;
    for(let i=0;i<16;i++)close(m[off+i],Number(i%5===0));
  }
  for(let i=0;i<a.pose.length;i++){
    assert.deepEqual(a.pose[i].t,a.rest[i].t);assert.deepEqual(a.pose[i].s,a.rest[i].s);
  }
});

test('weighted whale vertices relax the raised display tail while retaining bounded swimming and a fixed head',()=>{
  const model=loadMarineGLB(whaleBytes),rig=createMarineRig(model);let tailMotion=0,headMotion=0,flipperMotion=0;
  rig.update(0);const swimmingStart=Array.from({length:model.vertexCount},(_,i)=>skinned(model,rig.palette,i));
  const finJoint=model.skin.animator.joints.indexOf(model.skin.animator.names.indexOf('Bone_013'));
  for(const time of [0,1,2,3,4]){
    rig.update(time);
    for(let i=0;i<model.vertexCount;i++){
      const original=Array.from(model.vertices.subarray(i*11,i*11+3)),p=skinned(model,rig.palette,i),distance=Math.hypot(...p.map((v,d)=>v-original[d]));
      if(original[2]>5)tailMotion=Math.max(tailMotion,distance);
      if(original[2]<-6.5)headMotion=Math.max(headMotion,distance);
      for(let k=0;k<4;k++)if(model.skin.joints[i*4+k]===finJoint&&model.skin.weights[i*4+k]>.3)flipperMotion=Math.max(flipperMotion,distance);
      assert.ok(distance<3.5,'the existing skin relaxes the authored up-curled display pose');
      assert.ok(Math.hypot(...p.map((v,d)=>v-swimmingStart[i][d]))<1.5,'the periodic stroke remains small relative to the swimming pose');
    }
  }
  assert.ok(tailMotion>.5);assert.ok(flipperMotion>.03);assert.ok(headMotion<4e-5);
});

test('the complete swimming cycle keeps the weighted raised tail below the normal submerged envelope',()=>{
  const model=loadMarineGLB(whaleBytes),rig=createMarineRig(model);let high=-Infinity,low=Infinity;
  for(let phase=0;phase<64;phase++){
    rig.update(phase/64*MARINE_SWIM_PERIOD);
    for(let i=0;i<model.vertexCount;i++){
      const p=skinned(model,rig.palette,i);high=Math.max(high,p[1]);low=Math.min(low,p[1]);
      assert.ok(p[1]<3,'normal swimming does not leave the supplied display-pose tail above a submerged whale');
      assert.ok(p[1]-3.4<-.4,'the deepest regular surface pose retains a meaningful water cover');
    }
  }
  assert.ok(high>2&&high<2.6);assert.ok(low>-1.7);
  rig.update(0,0);
  for(let i=0;i<rig.palette.length;i++)close(rig.palette[i],Number((i%16)%5===0));
});

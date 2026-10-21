// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {loadMarineGLB} from '../js/marine-asset.js';
import {createMarineRig,MARINE_SWIM_PERIOD} from '../js/marine-rig.js';
import {WHALE_BLOWHOLE} from '../js/marine-life-state.js';

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

test('straight whale rig preserves its neutral bind pose, remains periodic and never accumulates rotations',()=>{
  const model=loadMarineGLB(whaleBytes),rig=createMarineRig(model),palette=rig.palette;
  assert.equal(palette.length,18*16);
  for(let i=0;i<palette.length;i++)close(palette[i],Number((i%16)%5===0));
  rig.update(1.2);const animated=palette.slice();
  assert.strictEqual(rig.update(1.2+MARINE_SWIM_PERIOD),palette);
  for(let i=0;i<palette.length;i++)close(palette[i],animated[i],2e-6);
  for(let i=0;i<100;i++)rig.update(1.2);
  assert.deepEqual(palette,animated);
  rig.update(-MARINE_SWIM_PERIOD,0);
  for(let i=0;i<palette.length;i++)close(palette[i],Number((i%16)%5===0));
  assert.ok(palette.every(Number.isFinite));
  assert.throws(()=>rig.update(NaN),/Invalid/);assert.throws(()=>rig.update(0,Infinity),/Invalid/);
  assert.throws(()=>createMarineRig({}),/skinned/);
  // A coiled source or a permanent corrective bend fails these actual mesh
  // sections even if the rig still produces finite, periodic matrices.
  for(const station of [2,3,4,5,6,6.8]){
    const points=[];for(let i=0;i<model.vertexCount;i++)if(Math.abs(model.vertices[i*11+2]-station)<.12)points.push(skinned(model,palette,i));
    assert.ok(points.length>40);
    const low=[0,1].map(d=>Math.min(...points.map(p=>p[d]))),high=[0,1].map(d=>Math.max(...points.map(p=>p[d])));
    assert.ok(Math.abs((low[0]+high[0])*.5)<.02,'neutral posterior centreline remains straight in plan view');
    assert.ok(Math.abs((low[1]+high[1])*.5)<.45,'neutral tail is not raised into a display curl');
  }
});

test('whale skin matrices retain the source rig change of basis and native joint pivots',()=>{
  const model=loadMarineGLB(whaleBytes),rig=createMarineRig(model),{scale,sourceCentre,headSign}=model.normalization;
  const signs=[headSign===1?-1:1,1,headSign===1?-1:1];
  for(const time of [.4,1.7,3.3]){
    rig.update(time);
    for(const index of [0,50,500,1000,2000,4000,6000,8000,10000,20000,28000]){
      const p=Array.from(model.vertices.subarray(index*11,index*11+3)),source=p.map((v,i)=>v/(scale*signs[i])+sourceCentre[i]),sum=[0,0,0];
      for(let k=0;k<4;k++){
        const at=model.skin.joints[index*4+k]*16,w=model.skin.weights[index*4+k],q=transform(model.skin.animator.palette,source,at);
        for(let d=0;d<3;d++)sum[d]+=q[d]*w;
      }
      const expected=sum.map((v,i)=>(v-sourceCentre[i])*scale*signs[i]),actual=skinned(model,rig.palette,index);
      for(let d=0;d<3;d++)close(actual[d],expected[d]);
    }
  }
  const a=model.skin.animator,tail=a.names.indexOf('Bone_008'),joint=a.joints.indexOf(tail);
  a.sample(null,0);const sourcePivot=Array.from(a.world[tail].subarray(12,15));
  const pivot=sourcePivot.map((v,i)=>(v-sourceCentre[i])*scale*signs[i]);
  rig.update(MARINE_SWIM_PERIOD*.25);
  const moved=transform(rig.palette,pivot,joint*16);for(let i=0;i<3;i++)close(moved[i],pivot[i]);
  const at=joint*16;close(rig.palette[at+5],Math.cos(.035));close(rig.palette[at+6],Math.sin(.035));
  for(let i=0;i<a.pose.length;i++){
    assert.deepEqual(a.pose[i].t,a.rest[i].t);assert.deepEqual(a.pose[i].s,a.rest[i].s);
  }
});

test('weighted swimming bends the tail vertically and flexes both flippers while the head stays fixed',()=>{
  const model=loadMarineGLB(whaleBytes),rig=createMarineRig(model);
  const neutral=Array.from({length:model.vertexCount},(_,i)=>skinned(model,rig.palette,i));
  let tailMotion=0,headMotion=0,leftMotion=0,rightMotion=0,high=-Infinity,low=Infinity;
  const tailY=[];
  for(let phase=0;phase<64;phase++){
    rig.update(phase/64*MARINE_SWIM_PERIOD);let sum=0,count=0;
    for(let i=0;i<model.vertexCount;i++){
      const original=neutral[i],p=skinned(model,rig.palette,i),distance=Math.hypot(...p.map((v,d)=>v-original[d]));
      high=Math.max(high,p[1]);low=Math.min(low,p[1]);
      if(original[2]>4){tailMotion=Math.max(tailMotion,distance);close(p[0],original[0]);}
      if(original[2]>6){sum+=p[1];count++;}
      if(original[2]<-5)headMotion=Math.max(headMotion,distance);
      if(Math.abs(original[2])<3&&original[0]<-1.8)leftMotion=Math.max(leftMotion,distance);
      if(Math.abs(original[2])<3&&original[0]>1.8)rightMotion=Math.max(rightMotion,distance);
      assert.ok(distance<1,'stroke excursion remains bounded relative to a 14.1 m animal');
    }
    tailY.push(sum/count);
  }
  assert.ok(tailMotion>.6&&tailMotion<1);assert.ok(leftMotion>.07&&rightMotion>.07);
  assert.ok(headMotion<.0002,'inherited low-weight skin leakage moves the aft head by less than 0.2 mm');
  assert.ok(Math.max(...tailY)-Math.min(...tailY)>1,'the flukes have a visible up/down stroke');
  assert.ok(high<1.85&&low>-1.9,'normal swimming does not expose a raised, curled tail');
  assert.ok(high-3.4<-1.5,'the resting swim depth covers the complete weighted envelope');
  let neutralTailY=0,count=0;for(const p of neutral)if(p[2]>6){neutralTailY+=p[1];count++;}
  close(tailY.reduce((sum,y)=>sum+y,0)/tailY.length,neutralTailY/count,.025);
});

test('the single forehead outlet lies on the forward skin and stays attached throughout the stroke',()=>{
  const model=loadMarineGLB(whaleBytes),rig=createMarineRig(model),[x,y,z]=WHALE_BLOWHOLE,hits=[];
  assert.ok(x<0&&Math.abs(x)<.5&&z<-5.5);
  for(let i=0;i<model.indices.length;i+=3){
    const [a,b,c]=[0,1,2].map(k=>Array.from(model.vertices.subarray(model.indices[i+k]*11,model.indices[i+k]*11+3)));
    const det=(b[2]-c[2])*(a[0]-c[0])+(c[0]-b[0])*(a[2]-c[2]);if(Math.abs(det)<1e-12)continue;
    const u=((b[2]-c[2])*(x-c[0])+(c[0]-b[0])*(z-c[2]))/det,v=((c[2]-a[2])*(x-c[0])+(a[0]-c[0])*(z-c[2]))/det,w=1-u-v;
    if(Math.min(u,v,w)>=0)hits.push(u*a[1]+v*b[1]+w*c[1]);
  }
  assert.ok(hits.length>=2);const skinY=Math.max(...hits);assert.ok(y>=skinY&&y-skinY<.025,'outlet is just above the measured head surface');
  const nearby=[];for(let i=0;i<model.vertexCount;i++)if(Math.hypot(model.vertices[i*11]-x,model.vertices[i*11+1]-skinY,model.vertices[i*11+2]-z)<.3)nearby.push(i);
  assert.ok(nearby.length>10);const rest=nearby.map(i=>skinned(model,rig.palette,i));
  for(const time of [0,1.3,2.6,3.9]){
    rig.update(time);for(let k=0;k<nearby.length;k++)for(let d=0;d<3;d++)close(skinned(model,rig.palette,nearby[k])[d],rest[k][d],1e-6);
  }
});

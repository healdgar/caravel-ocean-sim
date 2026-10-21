// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {loadMarineGLB} from '../js/marine-asset.js';
import {createMarineRig,marineStrokeAmplitude} from '../js/marine-rig.js';
import {createMarineLifeState,marinePoseAt,WHALE_BLOWHOLE} from '../js/marine-life-state.js';

test('a whale crossing the former one-metre threshold retains continuous actual tail skinning',()=>{
  const bytes=readFileSync(new URL('../assets/wildlife/whale.glb',import.meta.url)),model=loadMarineGLB(bytes),rig=createMarineRig(model);
  const skinned=(palette,i)=>{
    const p=model.vertices.subarray(i*11,i*11+3),out=[0,0,0];
    for(let k=0;k<4;k++){
      const at=model.skin.joints[i*4+k]*16,w=model.skin.weights[i*4+k];
      for(let row=0;row<3;row++)out[row]+=(palette[at+row]*p[0]+palette[at+4+row]*p[1]+palette[at+8+row]*p[2]+palette[at+12+row])*w;
    }
    return out;
  };
  const below=rig.update(1.3,marineStrokeAmplitude(.999)).slice(),above=rig.update(1.3,marineStrokeAmplitude(1.001)).slice();
  let maximum=0,samples=0;
  for(let i=0;i<model.vertexCount;i++)if(model.vertices[i*11+2]>4){
    const a=skinned(below,i),b=skinned(above,i);maximum=Math.max(maximum,Math.hypot(...a.map((v,j)=>v-b[j])));samples++;
  }
  assert.ok(samples>100,'the actual weighted peduncle and flukes are sampled');
  assert.ok(maximum<.003,`a 2mm emergence transition must not snap the tail; actual ${maximum}m`);
  assert.equal(marineStrokeAmplitude(-3),1);assert.ok(Math.abs(marineStrokeAmplitude(3)-.2)<1e-12);
  let previous=1;
  for(let i=0;i<=200;i++){
    const value=marineStrokeAmplitude(-.5+i*.01);assert.ok(value>=.2-1e-12&&value<=previous+1e-12);previous=value;
  }
  for(const end of[-.5,1.5])assert.ok(Math.abs(marineStrokeAmplitude(end+.0001)-marineStrokeAmplitude(end-.0001))<1e-7,'blend joins have no finite slope jump');
  assert.throws(()=>marineStrokeAmplitude(NaN),/depth/);
});

test('a real blow retains its interpolated animal-root wave anchor separately from the forehead outlet',()=>{
  const boat={x:0,z:0,length:20,beam:6,heading:37},state=createMarineLifeState(()=>.4);
  assert.equal(state.trigger('whale',boat,{behavior:'blow'}),true);
  for(let i=0;i<31;i++)state.step(.1,boat,{windSpeed:8,windDir:45});
  const event=state.effects.find(e=>e.kind==='blow'&&e.strength>0);assert.ok(event);
  assert.ok(Number.isFinite(event.anchorX)&&Number.isFinite(event.anchorZ));
  const at=state.age-event.age,pose=marinePoseAt(at,state.animals[0]),scale=state.animals[0].scale;
  const cr=Math.cos(pose.roll),sr=Math.sin(pose.roll),cp=Math.cos(pose.pitch),sp=Math.sin(pose.pitch);
  const bx=(cr*WHALE_BLOWHOLE[0]-sr*WHALE_BLOWHOLE[1])*scale;
  const by=sr*WHALE_BLOWHOLE[0]+cr*WHALE_BLOWHOLE[1],bz=(sp*by+cp*WHALE_BLOWHOLE[2])*scale;
  const expectedX=Math.cos(event.heading)*bx-Math.sin(event.heading)*bz,expectedZ=Math.sin(event.heading)*bx+Math.cos(event.heading)*bz;
  assert.ok(Math.abs(event.x-event.anchorX-expectedX)<1e-9);assert.ok(Math.abs(event.z-event.anchorZ-expectedZ)<1e-9);
  assert.ok(Math.hypot(event.x-event.anchorX,event.z-event.anchorZ)>5,'the outlet lies on the head, far enough from the root to sample a different wave');
  const original=[event.anchorX,event.anchorZ,event.x,event.z,event.height];
  for(let i=0;i<10;i++)state.step(.1,boat,{windSpeed:8,windDir:45});
  assert.deepEqual([event.anchorX,event.anchorZ,event.x,event.z,event.height],original,'a detached blow never follows later animal movement');
});

// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createRowingWaterConsumer,ROWING_WATER_LIMITS} from '../js/rowing-water.js';
const overnightWaterMeta={modelId:'lusoria',revision:3,time:2,domain:[10,20,8,12],axes:[1,0,0,1],columns:4,rows:6,quality:'surface-orbital'};
function overnightWaterField(meta=overnightWaterMeta){
  const values=new Float32Array(meta.columns*meta.rows*4);
  for(let j=0;j<meta.rows;j++)for(let i=0;i<meta.columns;i++){
    const localX=((i+.5)/meta.columns-.5)*meta.domain[2],localZ=((j+.5)/meta.rows-.5)*meta.domain[3];
    const x=meta.domain[0]+localX*meta.axes[0]+localZ*meta.axes[2],z=meta.domain[1]+localX*meta.axes[1]+localZ*meta.axes[3];
    values.set([x*.25+z*.125,1,.5,-2],(j*meta.columns+i)*4);
  }
  return values;
}
test('rowing water sampling uses fixed world coordinates through translating/rotating query grids',()=>{
  const c=createRowingWaterConsumer();assert.equal(c.sample(10,20),null);
  assert.equal(c.accept(overnightWaterField(),overnightWaterMeta),true);
  const a=c.sample(10.4,20.2);assert.ok(Math.abs(a.height-(10.4*.25+20.2*.125))<1e-6);assert.deepEqual(a.velocity,[1,.5,-2]);
  const moved={...overnightWaterMeta,time:2.1,domain:[10.5,20.25,8,12],axes:[0,1,-1,0]};
  assert.equal(c.accept(overnightWaterField(moved),moved),true);
  const b=c.sample(10.4,20.2);assert.ok(Math.abs(a.height-b.height)<1e-6);assert.deepEqual(b.velocity,a.velocity,'ship/grid motion is not water velocity');
});
test('missing, stale, future, reset, mismatched revision and invalid spatial water do not produce a field',()=>{
  const c=createRowingWaterConsumer();c.accept(overnightWaterField(),overnightWaterMeta);
  assert.equal(c.sample(10,20,{time:2+ROWING_WATER_LIMITS.staleSeconds+.001}),null);
  assert.equal(c.sample(10,20,{time:1.9}),null);assert.equal(c.sample(10,20,{revision:4}),null);assert.equal(c.sample(10,20,{modelId:'oseberg'}),null);
  assert.equal(c.sample(100,20),null);
  const bad=overnightWaterField();bad.fill(1e20);c.accept(bad,{...overnightWaterMeta,time:2.1});assert.equal(c.sample(10,20),null);
  c.clear();assert.equal(c.state,null);assert.equal(c.sample(10,20),null);
});
test('resolved calm zero velocity and vertical-only zero-chop fields remain valid water',()=>{
  const c=createRowingWaterConsumer(),flat=new Float32Array(4*6*4);
  c.accept(flat,{...overnightWaterMeta,quality:'vertical-only'});assert.deepEqual(c.sample(10,20),{height:0,velocity:[0,0,0],quality:'vertical-only'});
  for(let i=0;i<flat.length;i+=4){flat[i]=.3;flat[i+2]=.8;}
  c.accept(flat,{...overnightWaterMeta,time:2.1,quality:'vertical-only'});
  const wave=c.sample(10,20);assert.ok(Math.abs(wave.height-.3)<1e-7);assert.ok(Math.abs(wave.velocity[1]-.8)<1e-7);assert.equal(wave.velocity[0],0);assert.equal(wave.velocity[2],0);
});

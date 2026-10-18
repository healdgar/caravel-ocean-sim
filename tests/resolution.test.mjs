import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createAdaptiveResolution} from '../js/resolution.js';

function run(control, seconds, frameSeconds) {
  const changes=[];
  for(let t=0;t<seconds;) {
    const dt=typeof frameSeconds==='function'?frameSeconds(control.scale):frameSeconds;
    t+=dt;if(control.sample(dt))changes.push({time:t,scale:control.scale});
  }
  return changes;
}

test('auto resolution targets 30 FPS with headroom under a pixel-bound workload',()=>{
  const control=createAdaptiveResolution();
  const cost=scale=>0.008+0.05*scale*scale;
  const changes=run(control,60,cost);
  assert.ok(changes.length>0 && changes.length<8);
  assert.ok(1/cost(control.scale)>=30);
  assert.ok(control.scale>control.minimum && control.scale<1);
  assert.equal(run(control,30,cost).length,0,'stable frame rate must not cause resolution pumping');
});

test('full resolution remains intact at 30 and 60 FPS, including an isolated slow frame',()=>{
  for(const fps of [30,60]) {
    const control=createAdaptiveResolution();run(control,4,1/fps);
    control.sample(0.4);run(control,15,1/fps);
    assert.equal(control.scale,1);
  }
});

test('headroom restores resolution slowly and never above native',()=>{
  const control=createAdaptiveResolution();run(control,12,0.07);
  const low=control.scale;assert.ok(low<1);
  assert.equal(run(control,8,1/60).length,0,'brief headroom must not upscale');
  const changes=run(control,200,1/60);
  assert.ok(changes.length>0);
  assert.equal(control.scale,1);
  for(let i=1;i<changes.length;i++)assert.ok(changes[i].time-changes[i-1].time>=10);
});

test('backgrounding, resume gaps and startup do not lower resolution',()=>{
  const control=createAdaptiveResolution();run(control,1.8,0.1);assert.equal(control.scale,1);
  control.sample(20);run(control,8,1/60);assert.equal(control.scale,1);
  for(let i=0;i<100;i++)control.sample(0.1,false);
  run(control,10,1/60);assert.equal(control.scale,1);
  for(const invalid of [0,-1,NaN,Infinity])assert.equal(control.sample(invalid),false);
});

test('manual and fixed-size modes ignore cadence; the automatic floor is bounded',()=>{
  for(const [mode,scale] of [['native',1],['fixed',1],['0.75',0.75],['0.5',0.5]]) {
    const control=createAdaptiveResolution(mode);run(control,60,0.1);assert.equal(control.scale,scale);
  }
  const control=createAdaptiveResolution();run(control,100,0.2);
  assert.equal(control.scale,control.minimum);
  control.setMode('native');assert.equal(control.scale,1);
  control.setMode('0.5');assert.equal(control.scale,0.5);
  control.setMode('auto');assert.equal(control.scale,0.5);
  control.setMode('invalid');assert.equal(control.mode,'auto');
});

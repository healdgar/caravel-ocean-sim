import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createAdaptiveResolution,createAdaptivePolygons} from '../js/resolution.js';

function run(control, seconds, frameSeconds, workMs = null) {
  const changes=[];
  for(let t=0;t<seconds;) {
    const dt=typeof frameSeconds==='function'?frameSeconds(control.scale):frameSeconds;
    const cost=typeof workMs==='function'?workMs(control.scale):workMs;
    t+=dt;if(control.sample(dt,true,cost))changes.push({time:t,scale:control.scale});
  }
  return changes;
}

test('auto resolution targets 60 FPS with headroom under a pixel-bound workload',()=>{
  for(const base of [.003,.008]){
    const control=createAdaptiveResolution(),cost=scale=>base+.05*scale*scale;
    const cadence=scale=>Math.max(1/60,cost(scale));
    const changes=run(control,60,cadence,scale=>cost(scale)*1000);
    assert.equal(control.targetFPS,60);assert.ok(changes.length>0&&changes.length<8);
    assert.ok(1/cost(control.scale)>=60);
    assert.ok(control.scale>control.minimum&&control.scale<1);
    assert.equal(run(control,90,cadence,scale=>cost(scale)*1000).length,0,'steady pixel work must not cause resolution pumping');
  }
});

test('native resolution remains intact at 60+ FPS, including an isolated slow frame',()=>{
  for(const fps of [60,90,120]){
    const control=createAdaptiveResolution();run(control,4,1/fps,8);
    control.sample(.4,true,400);run(control,15,1/fps,8);
    assert.equal(control.scale,1);
  }
  const slow=createAdaptiveResolution();run(slow,20,1/30,30);
  assert.ok(slow.scale<1,'30 FPS no longer satisfies the automatic target');
});

test('measured work headroom restores resolution gradually on a 60 Hz display',()=>{
  const control=createAdaptiveResolution();run(control,12,.07,65);
  const low=control.scale;assert.ok(low<1);
  assert.equal(run(control,8,1/60,8).length,0,'brief headroom must not upscale');
  const changes=run(control,500,1/60,8);
  assert.ok(changes.length>0);assert.equal(control.scale,1);
  let previous=low;
  for(let i=0;i<changes.length;i++){
    assert.ok(changes[i].scale<=previous*1.05+1e-12,'each restoration is bounded relative to the current scale');
    if(i)assert.ok(changes[i].time-changes[i-1].time>=10,'restoration needs sustained headroom again');
    previous=changes[i].scale;
  }
});

test('budget-bound or unreliable work measurements cannot pump resolution upward at 60 Hz',()=>{
  for(const cost of [15,16.6,100,NaN,Infinity,-1,0,null,undefined]){
    const control=createAdaptiveResolution();run(control,12,.07);
    const low=control.scale;assert.ok(low<1);
    assert.equal(run(control,100,1/60,cost).length,0,'no false restoration for work '+cost);
    assert.equal(control.scale,low);
  }
  const partial=createAdaptiveResolution();run(partial,12,.07);
  const low=partial.scale;let sample=0;
  run(partial,100,1/60,()=>++sample%2?8:NaN);
  assert.equal(partial.scale,low,'sparse valid samples cannot establish work headroom');
});

test('delivered cadence alone drives reductions, with a high-refresh fallback for restoration',()=>{
  const control=createAdaptiveResolution();run(control,20,1/60,1000);
  assert.equal(control.scale,1,'overlapping or stalled GPU spans cannot independently lower detail');
  run(control,20,.04,1);assert.ok(control.scale<1,'low claimed work cannot conceal slow delivered cadence');
  assert.equal(run(control,8,1/60).length,0,'a 60 Hz cap alone does not prove restoration headroom');
  assert.ok(run(control,500,1/120).length>0,'unmeasured high-refresh cadence retains the headroom fallback');
  assert.equal(control.scale,1);
});

test('backgrounding, resume gaps and startup do not lower resolution',()=>{
  const control=createAdaptiveResolution();run(control,1.8,.1,100);assert.equal(control.scale,1);
  control.sample(20);run(control,8,1/60,8);assert.equal(control.scale,1);
  for(let i=0;i<100;i++)control.sample(.1,false,100);
  run(control,10,1/60,8);assert.equal(control.scale,1);
  for(const invalid of [0,-1,NaN,Infinity])assert.equal(control.sample(invalid,true,8),false);
});

test('manual modes ignore cadence and a CPU-bound automatic workload respects its floor',()=>{
  for(const [mode,scale] of [['native',1],['fixed',1],['0.75',.75],['0.5',.5]]){
    const control=createAdaptiveResolution(mode);run(control,60,.1,100);assert.equal(control.scale,scale);
  }
  const control=createAdaptiveResolution();run(control,100,.05,50);
  assert.equal(control.scale,control.minimum,'resolution cannot solve a fixed CPU cost or shrink without bound');
  assert.equal(run(control,30,.05,50).length,0);
  control.setMode('native');assert.equal(control.scale,1);
  control.setMode('0.5');assert.equal(control.scale,.5);
  control.setMode('auto');assert.equal(control.scale,.5);
  control.setMode('invalid');assert.equal(control.mode,'auto');
});

test('adaptive polygon controller scales LOD pixel error and ocean node budgets across device power tiers',()=>{
  for(const [input,mode,scale] of [['auto','auto',1],['native','native',1],['high','native',1],['0.75','0.75',.75],['medium','0.75',.75],['0.5','0.5',.5],['low','0.5',.5],['0.25','0.25',.25],['mobile','0.25',.25],['fixed','fixed',1]]){
    const polygons=createAdaptivePolygons(input);
    assert.equal(polygons.mode,mode);
    assert.equal(polygons.scale,scale);
    assert.ok(Math.abs(polygons.pixelError-3/Math.sqrt(scale))<1e-9);
    assert.ok(Math.abs(polygons.oceanRangeScale-Math.sqrt(scale))<1e-9);
    assert.equal(polygons.maxNodes(8192),Math.round(8192*scale));
  }
  const auto=createAdaptivePolygons('auto'),cost=scale=>.004+.035*scale;
  const cadence=scale=>Math.max(1/60,cost(scale));
  const changes=run(auto,60,cadence,scale=>cost(scale)*1000);
  assert.ok(changes.length>0&&changes.length<10);
  assert.ok(auto.scale<1&&auto.scale>=auto.minimum);
  assert.ok(auto.pixelError>3);
  assert.ok(auto.oceanRangeScale<1);
  const restored=run(auto,500,1/60,8);
  assert.ok(restored.length>0);
  assert.equal(auto.scale,1);
});

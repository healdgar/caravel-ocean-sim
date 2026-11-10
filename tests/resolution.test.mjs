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

test('auto resolution finds 60 FPS under a pixel-bound workload and stops asking for more',()=>{
  for(const base of [.003,.008]){
    const control=createAdaptiveResolution(),cost=scale=>base+.05*scale*scale;
    const cadence=scale=>Math.max(1/60,cost(scale));
    const changes=run(control,60,cadence,scale=>cost(scale)*1000);
    assert.equal(control.targetFPS,60);assert.ok(changes.length>0);
    assert.ok(control.scale>control.minimum&&control.scale<1);
    const settled=control.scale,later=run(control,600,cadence,scale=>cost(scale)*1000);
    assert.ok(later.length<=16,`each failed try waits twice as long; saw ${later.length} changes`);
    for(let i=2;i<later.length;i+=2)assert.ok(later[i].time-later[i-2].time>=Math.min(60,i*3),'tries spread out');
    assert.ok(Math.abs(control.scale-settled)<=settled*.15,'it settles where it was');
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

test('at the display cap resolution climbs back one small try at a time',()=>{
  const control=createAdaptiveResolution();run(control,14,.07,65);
  const low=control.scale;assert.ok(low<1);
  assert.equal(run(control,2,1/60,8).length,0,'brief headroom must not upscale');
  const changes=run(control,500,1/60,8);
  assert.ok(changes.length>0);assert.equal(control.scale,1);
  let previous=low;
  for(let i=0;i<changes.length;i++){
    assert.ok(changes[i].scale<=previous*1.06+1e-12,'each restoration is bounded relative to the current scale');
    if(i)assert.ok(changes[i].time-changes[i-1].time>=3,'restoration needs time at the target again');
    previous=changes[i].scale;
  }
});

test('a try that costs the cadence is undone, and the next waits longer',()=>{
  const limit=.6,control=createAdaptiveResolution('auto',{initial:.58});
  const changes=run(control,400,scale=>scale>limit?1/30:1/60,8);
  assert.ok(control.scale<=limit+.05,'settles at what holds the target');
  const tries=changes.filter((change,i)=>i===0||change.scale>changes[i-1].scale);
  assert.ok(tries.length>=2&&tries.length<=9,`tries spread out, saw ${tries.length}`);
  for(let i=1;i<tries.length;i++)assert.ok(tries[i].time-tries[i-1].time>=3*2**(i-1),'each failure doubles the wait');
});

test('frame work forbids a raise only when reliably measured over budget',()=>{
  for(const cost of [15,16.6,100]){
    const control=createAdaptiveResolution('auto',{initial:.5});
    assert.equal(run(control,100,1/60,cost).length,0,'no pixels to save in a CPU-bound frame, at work '+cost);
  }
  for(const cost of [NaN,Infinity,-1,0,null,undefined]){
    const control=createAdaptiveResolution('auto',{initial:.5});
    assert.ok(run(control,100,1/60,cost).length>0,'an unmeasured frame may still try, at work '+cost);
  }
});

test('an automatic start begins from its hint, within bounds, and only automatic does',()=>{
  assert.equal(createAdaptiveResolution('auto',{initial:.5}).scale,.5);
  assert.equal(createAdaptiveResolution('auto',{initial:5}).scale,1);
  assert.equal(createAdaptiveResolution('auto',{initial:.01}).scale,.35);
  assert.equal(createAdaptiveResolution('native',{initial:.5}).scale,1);
  assert.equal(createAdaptiveResolution('0.75',{initial:.5}).scale,.75);
});

test('delivered cadence alone drives reductions, with a high-refresh fallback for restoration',()=>{
  const control=createAdaptiveResolution();run(control,20,1/60,1000);
  assert.equal(control.scale,1,'overlapping or stalled GPU spans cannot independently lower detail');
  run(control,20,.04,1);assert.ok(control.scale<1,'low claimed work cannot conceal slow delivered cadence');
  assert.ok(run(control,500,1/120).length>0,'a high-refresh cadence climbs back the same way');
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
  assert.ok(changes.length>0&&changes.length<16);
  assert.ok(auto.scale<1&&auto.scale>=auto.minimum);
  assert.ok(auto.pixelError>3);
  assert.ok(auto.oceanRangeScale<1);
  const restored=run(auto,500,1/60,8);
  assert.ok(restored.length>0);
  assert.equal(auto.scale,1);
});

test('both budgets still fall on a device taking seconds per frame, and a long pause is not mistaken for one',()=>{
  for(const create of[createAdaptiveResolution,createAdaptivePolygons]){
    const slow=create('auto');
    let changed=0;
    for(let i=0;i<20;i++)if(slow.sample(2.5,true,2500))changed++;
    assert.ok(changed>=2&&slow.scale<.8,`reduced to ${slow.scale} after 50 s of 2.5 s frames`);
    const paused=create('auto');
    for(let i=0;i<200;i++)paused.sample(i%40===39?30:1/60,true,8);
    assert.equal(paused.scale,1,'occasional long pauses reset rather than reduce');
    const hidden=create('auto');
    for(let i=0;i<20;i++)hidden.sample(2.5,false,2500);
    assert.equal(hidden.scale,1,'a hidden tab never reduces');
  }
});

test('one budget holds still while the other is trying more detail',()=>{
  const resolution=createAdaptiveResolution('auto',{initial:.6}),polygons=createAdaptivePolygons('0.5');
  polygons.setMode('auto');
  run(polygons,12,1/60,8);
  assert.ok(polygons.trying,'polygons have raised and are being judged');
  const held=resolution.scale;
  for(let t=0;t<8;t+=.05)resolution.sample(.05,true,8,{mayLower:!polygons.trying});
  assert.equal(resolution.scale,held,'sharpness is not cut for what may be the polygon try');
  const before=polygons.scale;
  for(let t=0;t<8;t+=.05)polygons.sample(.05,true,8);
  assert.ok(polygons.scale<before,'the failed try is undone');
  assert.equal(polygons.trying,false);
  const below=createAdaptivePolygons('0.25');below.setMode('auto');
  for(let t=0;t<8;t+=.05)below.sample(.05,true,8,{mayLowerFurther:false});
  assert.equal(below.scale,.25,'polygons wait below half until the image has given up its share');
});

test('a floor on the governor does not override a polygon budget that was chosen', () => {
  const chosen=createAdaptivePolygons('0.25',{minimum:.35});
  assert.equal(chosen.scale,.25);
  assert.ok(Math.abs(chosen.pixelError-3/Math.sqrt(.25))<1e-9,'a quarter budget draws a quarter, whatever the governor may lower to');
  assert.equal(chosen.maxNodes(8192),Math.round(8192*.25));
  const governed=createAdaptivePolygons('auto',{minimum:.35});
  for(let i=0;i<400;i++)governed.sample(.2,true,200);
  assert.equal(governed.scale,.35,'left to itself the governor stops at its floor');
  assert.ok(Math.abs(governed.pixelError-3/Math.sqrt(.35))<1e-9);
  governed.setMode('0.1');
  assert.ok(Math.abs(governed.oceanRangeScale-Math.sqrt(.1))<1e-9,'and a later choice below the floor is honoured');
});

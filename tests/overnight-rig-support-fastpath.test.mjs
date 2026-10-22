// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Root alone executes these strict scalar/array and mutable-input gates.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {deepFreeze} from '../js/rig-definition.js';
import {rigSurfacePose,surfaceClothPoint,surfaceRestPoint,surfaceRopePoint,withRigSupportCache,withRigPoseContext} from '../js/rig-surface.js';
import {laterSailRigContext} from '../js/additional-rig.js';
import {LATER_SAIL_DESIGNS} from '../js/models/later-sail.js';

const supportFastSurface=extra=>({id:1,mast:0,controlGroup:'main',kind:'square',pivot:[0,1,0],
  corners:[[-1,2,.05],[1,2,.05],[1,0,.05],[-1,0,.05]],belly:.12,...extra});
const supportFastContext=(surface,supports,extra={})=>deepFreeze(withRigSupportCache({surfaces:[surface],supports,masts:[],lines:[],...extra}));
const supportFastReference=context=>({...context,_surfaceCollisionSupports:Object.freeze([...context._surfaceCollisionSupports])});
const supportFastBytes=value=>new Uint8Array(new Float64Array(value).buffer);
function supportFastSegmentPoint(point,a,b){
  const axis=b.map((v,i)=>v-a[i]),delta=point.map((v,i)=>v-a[i]),length2=axis.reduce((sum,v)=>sum+v*v,0),t=Math.max(0,Math.min(1,delta.reduce((sum,v,i)=>sum+v*axis[i],0)/length2));
  return {t,distance:Math.hypot(...point.map((v,i)=>v-(a[i]+axis[i]*t)))};
}
function supportFastHypots(evaluate){
  const original=Math.hypot;let calls=0;
  Math.hypot=(...values)=>{calls++;return original(...values);};
  try{return {value:evaluate(),calls};}finally{Math.hypot=original;}
}
function supportFastCompare(context,state,coordinates,time=1.7,wind=13){
  const direct=supportFastReference(context),fast=withRigPoseContext(context,state),reference=withRigPoseContext(direct,state);
  for(const surface of context.surfaces){
    const pose=rigSurfacePose(surface,state);
    for(const [u,v]of coordinates){
      const a=surfaceClothPoint(surface,u,v,pose,fast,time,wind),b=surfaceClothPoint(surface,u,v,pose,reference,time,wind);
      assert.deepEqual(supportFastBytes(a),supportFastBytes(b),'Float64 coordinates, including signed zero, match the separate array loop');
    }
  }
  return {fast,reference};
}

test('private preparation eliminates repeated support-coordinate reads without changing Float64 output',()=>{
  let reads=0;const watch=point=>new Proxy(Object.freeze(point),{get(target,key,receiver){if(['0','1','2'].includes(key))reads++;return Reflect.get(target,key,receiver);}});
  const surface=supportFastSurface(),context=supportFastContext(surface,[{a:watch([0,-2,0]),b:watch([0,3,0]),r:.12,kind:'shroud'}]),pose=rigSurfacePose(surface,{});
  surfaceClothPoint(surface,.5,.5,pose,context);reads=0;
  const fast=surfaceClothPoint(surface,.4,.3,pose,context);assert.equal(reads,0,'trusted frozen support geometry is not rescanned per cloth sample');
  const direct=surfaceClothPoint(surface,.4,.3,pose,supportFastReference(context));assert.ok(reads>0,'separate array evaluator still reads and validates original endpoints');
  assert.deepEqual(supportFastBytes(fast),supportFastBytes(direct));
});

test('exact normal projections reuse only eight live triples and retain adjacent-angle Float64 results',()=>{
  const surface=supportFastSurface({belly:0}),context=supportFastContext(surface,[{a:[0,-2,0],b:[0,3,0],r:.1,kind:'shroud'}]);
  rigSurfacePose(surface,{});
  const point=yaw=>surfaceClothPoint(surface,.5,.5,{yaw,deployed:1,fill:1,pressure:1},context);
  const first=supportFastHypots(()=>point(0)),hit=supportFastHypots(()=>point(0));
  assert.equal(first.calls,hit.calls+2,'a cache hit removes both primary projection hypots');assert.deepEqual(supportFastBytes(first.value),supportFastBytes(hit.value));
  for(let i=1;i<=8;i++)point(i*.07);
  const evicted=supportFastHypots(()=>point(0));assert.equal(evicted.calls,hit.calls+2,'the ninth distinct triple evicts the oldest entry instead of growing the cache');
  const reference=supportFastReference(context);
  for(const yaw of [0,-0,Number.EPSILON,Number.EPSILON*2,.25,.25+Number.EPSILON,-.25,-.25-Number.EPSILON]){
    const pose={yaw,deployed:.83,fill:.7,pressure:-.6};
    assert.deepEqual(supportFastBytes(surfaceClothPoint(surface,.5,.5,pose,context,1.5,18)),supportFastBytes(surfaceClothPoint(surface,.5,.5,pose,reference,1.5,18)),'no angle/normal quantization or signed-zero coalescing changes output');
  }
});

test('own-mast direction reuses its exact projection while nonpenetrating geometry skips only distance work',()=>{
  const own=supportFastSurface({belly:0,mastContactSide:'fore'}),mast={index:0,foot:[0,-2,0],head:[0,3,0],radius:.1};
  const context=supportFastContext(own,[],{masts:[mast]}),point=yaw=>surfaceClothPoint(own,.4,.4,{yaw,deployed:1,fill:1,pressure:1},context);
  rigSurfacePose(own,{});
  const first=supportFastHypots(()=>point(.1)),other=supportFastHypots(()=>point(.2));
  assert.equal(first.calls,other.calls+2,'a changing cloth normal does not invalidate a constant authored mast direction');
  const distant=supportFastSurface({belly:0,corners:[[-1,2,.5],[1,2,.5],[1,0,.5],[-1,0,.5]]}),clear=supportFastContext(distant,[{a:[0,-2,0],b:[0,3,0],r:.1,kind:'shroud'}]),pose=rigSurfacePose(distant,{});
  surfaceClothPoint(distant,.5,.5,pose,clear);
  const fast=supportFastHypots(()=>surfaceClothPoint(distant,.5,.5,pose,clear)),direct=supportFastHypots(()=>surfaceClothPoint(distant,.5,.5,pose,supportFastReference(clear)));
  assert.equal(direct.calls,fast.calls+3,'two cached projection hypots and one provably irrelevant distance hypot are avoided');
  assert.deepEqual(supportFastBytes(fast.value),supportFastBytes(direct.value));
});

test('far support with ambiguous rest side retains the original pose-accessor distance gate',()=>{
  const surface=supportFastSurface(),context=supportFastContext(surface,[{a:[10,-2,.05],b:[10,3,.05],r:.1,kind:'shroud'}]);
  const sample=c=>{let pressureReads=0;const pose={yaw:0,deployed:1,fill:1,get pressure(){pressureReads++;if(pressureReads>1)throw Error('Unused pose accessor');return 1;}};
    const point=surfaceClothPoint(surface,.5,.5,pose,c);assert.equal(pressureReads,1);return point;};
  assert.deepEqual(supportFastBytes(sample(context)),supportFastBytes(sample(supportFastReference(context))));
});

test('prepared projection preserves overlapping support order and both normal fallback branches',()=>{
  const surface=supportFastSurface(),supports=[
    {a:[0,-3,0],b:[0,3,0],r:.10,kind:'shroud',mast:0},
    {a:[0,-3,.16],b:[0,3,.16],r:.10,kind:'shroud',mast:1},
  ],context=supportFastContext(surface,supports),reversed=supportFastContext(surface,[...supports].reverse());
  const states=[{set:[0,1,0],windSide:6,windForward:-5,rig:[{}, {fill:1}, {}]},
    {set:[0,.3,0],windSide:-5,windForward:7,groupYaw:[0,.37,0],rig:[{}, {fill:0}, {}]}];
  for(const state of states){supportFastCompare(context,state,[[.5,.5],[0,0],[.3,.2],[.5-.0005,.5],[.5+.0005,.5]]);supportFastCompare(reversed,state,[[.5,.5],[.2,.3]]);}
  const pose=rigSurfacePose(surface,states[0]),a=surfaceClothPoint(surface,.5,.5,pose,context),b=surfaceClothPoint(surface,.5,.5,pose,reversed);
  assert.ok(Math.abs(a[2]-b[2])>.05,'overlapping one-sided barriers make order observable');
  const axial=supportFastContext(supportFastSurface({belly:0}),[
    {a:[0,1,-2],b:[0,1,2],r:.2,kind:'shroud'},
  ]);
  supportFastCompare(axial,{set:[0,1,0],rig:[{}, {fill:1}, {}]},[[.5,.5],[.6,.5],[.5,.4]],0,0);
});

test('tapered own-mast barriers and privately prepared moving spars retain exact live results',()=>{
  const main=supportFastSurface({mastContactSide:'fore'}),yard=supportFastSurface({id:2,mast:1,controlGroup:'fore',pivot:[0,1,.08],
    corners:[[-1,1,.08],[1,1,.08],[1,.2,.08],[-1,.2,.08]],spar:true});
  const context=supportFastContext(main,[],{surfaces:[main,yard],
    masts:[{index:0,foot:[0,-1,0],head:[0,3,0],radius:.18,tipRadius:.025}],
    spars:[{surface:2,a:[-.8,1,.08],b:[.8,1,.08],radius:.07}],
    lines:[{a:{surface:1,uv:[.3,.4]},b:{surface:2,point:[.8,1,.08]},kind:'brace',sag:.03}]});
  for(const yaw of [0,.43,-.51]){
    const state={set:[1,.7,0],groupYaw:[yaw,-yaw,0],windSide:yaw<0?-8:5,windForward:4,rig:[{fill:.9},{fill:.4},{}]};
    const {fast,reference}=supportFastCompare(context,state,[[.5,.5],[.2,.3],[.5,.5+.0005]]);
    assert.ok(Object.isFrozen(fast._surfaceActiveSupports),'only private complete prepared live arrays are immutable');
    assert.equal(Object.isFrozen(reference._surfaceActiveSupports),false,'uncached moving views retain the independent array path');
    for(const t of [0,.23,.65,1])assert.deepEqual(supportFastBytes(surfaceRopePoint(context.lines[0],t,{...fast,time:2,wind:9})),supportFastBytes(surfaceRopePoint(context.lines[0],t,{...reference,time:2,wind:9})));
  }
});

test('only the sewn owner exempts its load-bearing stay',()=>{
  const surface=supportFastSurface({belly:0}),stay={a:[0,-2,0],b:[0,3,0],r:.2,kind:'sail-stay',surface:1,mast:0};
  const own=supportFastContext(surface,[stay]),foreign=supportFastContext(surface,[{...stay,surface:2}]),state={set:[0,1,0],rig:[{},{fill:1},{}]},pose=rigSurfacePose(surface,state);
  const point=surfaceClothPoint(surface,.5,.5,pose,own),bare=surfaceClothPoint(surface,.5,.5,pose);
  assert.deepEqual(supportFastBytes(point),supportFastBytes(bare));
  assert.notDeepEqual(supportFastBytes(surfaceClothPoint(surface,.5,.5,pose,foreign)),supportFastBytes(bare));
  supportFastCompare(own,state,[[.5,.5],[.2,.3]]);supportFastCompare(foreign,state,[[.5,.5],[.2,.3]]);
});

test('mutable endpoints, shallow-frozen geometry and frozen accessors never acquire stale validation',()=>{
  const surface=supportFastSurface(),context=withRigSupportCache({surfaces:[surface],masts:[],supports:[{a:[0,-2,0],b:[0,3,0],r:.1}],lines:[]}),pose=rigSurfacePose(surface,{});
  surfaceClothPoint(surface,.5,.5,pose,context);context._surfaceCollisionSupports[0].a[0]=NaN;
  assert.throws(()=>surfaceClothPoint(surface,.5,.5,pose,context),/Invalid rig support descriptor/);
  const shallow=Object.freeze(supportFastSurface());surfaceRestPoint(shallow,.3,.4);shallow.corners[0][0]=NaN;
  assert.throws(()=>surfaceRestPoint(shallow,.3,.4),/Invalid mixed-rig surface descriptor/);
  let kind='square';const accessor=deepFreeze({...supportFastSurface(),get kind(){return kind;}});
  surfaceRestPoint(accessor,.2,.3);kind='invalid';assert.throws(()=>surfaceRestPoint(accessor,.2,.3),/Invalid mixed-rig surface descriptor/);
  let radius=.1;const spoof={surfaces:[surface],masts:[],supports:[{}],_surfaceCollisionSupports:Object.freeze([
    Object.freeze({a:Object.freeze([0,-2,0]),b:Object.freeze([0,3,0]),get r(){return radius;},_surfaceAxis:Object.freeze([0,5,0]),_surfaceLength2:25}),
  ])};
  surfaceClothPoint(surface,.5,.5,pose,spoof);radius=NaN;
  assert.throws(()=>surfaceClothPoint(surface,.5,.5,pose,spoof),/Invalid rig support descriptor/);
});

test('same-mast booms and gaffs preserve the foreign cloth rest side while legacy yards retain their face',()=>{
  const surface=supportFastSurface({belly:0,mastContactSide:'fore'}),spar={a:[0,1,.05],b:[.2,1,2.05],r:.05,kind:'spar',surface:2,mast:0},pose=rigSurfacePose(surface,{}),bare=surfaceClothPoint(surface,.3,.5,pose);
  for(const sparKind of ['boom','gaff']){
    const context=supportFastContext(surface,[{...spar,sparKind}]),remote=surfaceClothPoint(surface,.3,.5,pose,context),near=surfaceClothPoint(surface,.475,.5,pose,context),original=surfaceClothPoint(surface,.475,.5,pose);
    assert.deepEqual(supportFastBytes(remote),supportFastBytes(bare),'a remote longitudinal spar cannot invent a sideways mast-face wall');
    assert.ok(near[0]<original[0],'actual contact keeps the foreign cloth on its original negative-X side');
    assert.ok(supportFastSegmentPoint(near,spar.a,spar.b).distance>=spar.r+(surface.contactClearance??.045)-1e-12,'real finite boom/gaff contact still separates the cloth');
    supportFastCompare(context,{},[[.3,.5],[.475,.5],[.475+.0005,.5]]);
    const sewn=supportFastContext(surface,[{...spar,sparKind,surface:1}]);
    assert.deepEqual(supportFastBytes(surfaceClothPoint(surface,.475,.5,pose,sewn)),supportFastBytes(original),'own sewn spars remain exempt');
  }
  const legacy=supportFastContext(surface,[spar]),yard=supportFastContext(surface,[{...spar,sparKind:'yard'}]);
  const old=surfaceClothPoint(surface,.3,.5,pose,legacy),classified=surfaceClothPoint(surface,.3,.5,pose,yard);
  assert.deepEqual(supportFastBytes(old),supportFastBytes(classified),'unclassified legacy spars retain their exact yard behavior');assert.notDeepEqual(supportFastBytes(classified),supportFastBytes(bare));
});

test('a foreign live gaff keeps genuine moving contact and its spar kind in both pose evaluators',()=>{
  const main=supportFastSurface({belly:0,mastContactSide:'fore'}),gaff=supportFastSurface({id:2,kind:'gaff',controlGroup:'fore',pivot:[0,1,.05],hingeAxis:[0,1,0]}),spar={kind:'gaff',surface:2,a:[0,1,.05],b:[.2,1,2.05],radius:.05};
  const context=supportFastContext(main,[],{surfaces:[main,gaff],masts:[{index:0,foot:[0,-2,.8],head:[0,4,.8],radius:.03}],spars:[spar]}),points=[];
  for(const yaw of [0,.4]){
    const state={set:[1,1,0],surfaceYaw:{1:0,2:yaw},rig:[{fill:0},{fill:0},{}]},live=withRigPoseContext(context,state),direct=withRigPoseContext(supportFastReference(context),state),obstacle=live._surfaceActiveSupports.find(s=>s.kind==='spar');
    assert.equal(obstacle.sparKind,'gaff');const p=surfaceClothPoint(main,.475,.5,live.poses.get(1),live);
    assert.ok(supportFastSegmentPoint(p,obstacle.a,obstacle.b).distance>=spar.radius+(main.contactClearance??.045)-1e-12);
    assert.deepEqual(supportFastBytes(p),supportFastBytes(surfaceClothPoint(main,.475,.5,direct.poses.get(1),direct)));points.push(p);
  }
  assert.notDeepEqual(supportFastBytes(points[0]),supportFastBytes(points[1]),'a truly contacting independently moving gaff still changes cloth');
});

test('the actual opposite-side clipper course stays outside its mast without a remote spanker boom pull',()=>{
  const design=LATER_SAIL_DESIGNS['flying-cloud'],context=laterSailRigContext(design.id),course=design.surfaces.find(s=>s.id===11),state={set:[1,1,1],groupYaw:[.67,.67,.67],windSide:9,windForward:7,rig:[0,1,2].map(()=>({fill:1,side:-1}))};
  const live=withRigPoseContext(context,state),pose=live.poses.get(course.id),boom=live._surfaceActiveSupports.find(s=>s.kind==='spar'&&s.surface===25&&s.sparKind==='boom');
  assert.ok(boom);const without={...live,_surfaceActiveSupports:live._surfaceActiveSupports.filter(s=>s!==boom)},point=surfaceClothPoint(course,.45,1,pose,live,2.7,18),unpulled=surfaceClothPoint(course,.45,1,pose,without,2.7,18);
  assert.deepEqual(supportFastBytes(point),supportFastBytes(unpulled),'the physically remote boom cannot undo earlier real mast separation');
  const mast=context.masts[course.mast],clearance=supportFastSegmentPoint(point,mast.foot,mast.head),radius=mast.radius+(mast.tipRadius-mast.radius)*clearance.t;
  assert.ok(clearance.distance>radius+1e-5,'the source-traced crossjack point remains outside the actual tapered mizzen mast');
  assert.ok(supportFastSegmentPoint(point,boom.a,boom.b).distance>boom.r+(course.contactClearance??.045)+(course.contactBand??.25),'the regression point is outside the remote boom contact band');
});

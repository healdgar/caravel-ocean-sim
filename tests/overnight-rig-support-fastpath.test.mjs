// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Root alone executes these strict scalar/array and mutable-input gates.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {deepFreeze} from '../js/rig-definition.js';
import {rigSurfacePose,surfaceClothPoint,surfaceRestPoint,surfaceRopePoint,withRigSupportCache,withRigPoseContext} from '../js/rig-surface.js';

const supportFastSurface=extra=>({id:1,mast:0,controlGroup:'main',kind:'square',pivot:[0,1,0],
  corners:[[-1,2,.05],[1,2,.05],[1,0,.05],[-1,0,.05]],belly:.12,...extra});
const supportFastContext=(surface,supports,extra={})=>deepFreeze(withRigSupportCache({surfaces:[surface],supports,masts:[],lines:[],...extra}));
const supportFastReference=context=>({...context,_surfaceCollisionSupports:Object.freeze([...context._surfaceCollisionSupports])});
const supportFastBytes=value=>new Uint8Array(new Float64Array(value).buffer);
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

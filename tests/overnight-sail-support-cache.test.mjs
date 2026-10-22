// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createSurfaceSailGeometry,updateSailGeometry} from '../js/sail-aerodynamics.js';
import {withRigPoseContext,surfaceClothPoint,rigSurfacePose} from '../js/rig-surface.js';

test('mean-load cloth and its cache follow another surface actual moving spar',()=>{
  const main={id:1,name:'main',mast:0,controlGroup:'main',kind:'square',pivot:[0,2,0],
    corners:[[-1,2,0],[1,2,0],[1,0,0],[-1,0,0]],belly:0,braceLimit:1,mastContactSide:'aft',contactClearance:.05};
  const fore={id:2,name:'other-yard',mast:1,controlGroup:'fore',kind:'square',pivot:[0,1,.30],
    corners:[[-.8,1,.02],[.8,1,.02],[.8,-1,.02],[-.8,-1,.02]],belly:0,braceLimit:1};
  const design={id:'live-spar-fixture',frame:{length:12,beam:3.6,verticalScale:1},surfaces:[main,fore]};
  const context={surfaces:design.surfaces,masts:[
    {id:'main',index:0,foot:[0,-1,-.30],head:[0,3,-.30],radius:.04},
    {id:'fore',index:1,foot:[0,-1,.30],head:[0,2,.30],radius:.04},
  ],supports:[],spars:[{surface:2,a:fore.corners[0],b:fore.corners[1],radius:.08}]};
  const state={set:[1,1,0],windSide:0,windForward:-4,surfaceYaw:{1:0,2:0},rig:[{fill:0},{fill:0},{}]};
  const boat={length:12,beam:3.6,sailState:state},geometry=createSurfaceSailGeometry(design,context,4);
  const compareLive=()=>{
    const live=withRigPoseContext(context,state);
    for(const surface of geometry.surfaces)for(const [i,uv]of surface.samples.entries()){
      const expected=surfaceClothPoint(surface.sail,...uv,live.poses.get(surface.sail.id),live,0,0);
      assert.deepEqual([...surface.points[i]],expected,'mean-load samples use the same current spar-constrained cloth as rendering');
    }
  };
  updateSailGeometry(geometry,boat);compareLive();
  const first=geometry.surfaces[0].points.map(p=>[...p]),revision=geometry.revision,mainRevision=geometry.surfaces[0].revision,firstArea=geometry.surfaces[0].totalArea;
  const centreIndex=geometry.surfaces[0].samples.findIndex(([u,v])=>u===.5&&v===.5),centre=first[centreIndex];
  // Foreign yards retain the reference cloth's actual side. This main cloth
  // starts at z=0, fore of the crossing yard at z=.02, so must move to -.11.
  assert.ok(Math.abs(centre[2]+.11)<1e-12,'actual crossing must put cloth one spar radius plus clearance ahead of the foreign yard');
  assert.ok(Math.hypot(centre[0],centre[1]-1,centre[2]-.02)>=.13-1e-12,'sample must clear the finite cylinder, not just change its cache');
  updateSailGeometry(geometry,boat);assert.equal(geometry.revision,revision,'identical actual poses retain cached panel geometry');
  state.surfaceYaw[2]=.6;updateSailGeometry(geometry,boat);compareLive();
  assert.ok(geometry.surfaces[0].revision>mainRevision,'another sail yard invalidates main cloth even with unchanged main yaw/fill');
  assert.ok(geometry.surfaces[0].points.some((p,i)=>p.some((v,k)=>Math.abs(v-first[i][k])>1e-5)),'the other yard must change actual sampled cloth, not only its cache revision');
  assert.ok(Math.abs(geometry.surfaces[0].totalArea-firstArea)>1e-5,'bracing the crossing yard must change the actual aerodynamic panel area');
  const settled=geometry.revision;updateSailGeometry(geometry,boat);assert.equal(geometry.revision,settled);
  const beforeRadius=geometry.surfaces[0].revision;context.spars[0].radius=.10;updateSailGeometry(geometry,boat);compareLive();
  assert.ok(geometry.surfaces[0].revision>beforeRadius,'actual spar radius also belongs to the clearance cache key');
  assert.equal(context._surfaceActiveSupports,undefined,'one live vessel pose cannot overwrite canonical static support context');
});

for(const kind of ['mast-tip','support-end'])test(`${kind} taper changes actual mean-load cloth without stale cached panels`,()=>{
  const surface={id:1,mast:0,controlGroup:'main',kind:'square',pivot:[0,2,0],
    corners:[[-1,2,0],[1,2,0],[1,0,0],[-1,0,0]],belly:0,braceLimit:1,mastContactSide:'aft',contactClearance:.05};
  const design={id:'taper-fixture',frame:{length:12,beam:3.6,verticalScale:1},surfaces:[surface]};
  const mast={index:0,foot:[0,0,-.10],head:[0,2,-.10],radius:.20,tipRadius:.10};
  const support={a:mast.foot,b:mast.head,r:.20,rEnd:.10,mast:0,kind:'mast'};
  const context={surfaces:[surface],masts:kind==='mast-tip'?[mast]:[],supports:kind==='support-end'?[support]:[]};
  const state={set:[0,1,0],windSide:0,windForward:-4,rig:[{},{fill:0},{}]},boat={length:12,beam:3.6,sailState:state};
  const geometry=createSurfaceSailGeometry(design,context,4),cloth=geometry.surfaces[0],index=cloth.samples.findIndex(([u,v])=>u===.5&&v===.5);
  updateSailGeometry(geometry,boat);const firstRevision=geometry.revision,firstArea=cloth.totalArea;
  assert.ok(Math.abs(cloth.points[index][2]-.10)<1e-12,'half-height contact uses actual interpolated radius .15 plus .05 clearance');
  updateSailGeometry(geometry,boat);assert.equal(geometry.revision,firstRevision);
  if(kind==='mast-tip')mast.tipRadius=.02;else support.rEnd=.02;
  updateSailGeometry(geometry,boat);
  assert.ok(geometry.revision>firstRevision,'changed physical taper must invalidate panel geometry');
  assert.ok(Math.abs(cloth.points[index][2]-.06)<1e-12,'narrower actual contact radius changes cloth position rather than only its cache key');
  assert.ok(Math.abs(cloth.totalArea-firstArea)>1e-6,'actual tapered contact changes aerodynamic cloth area');
});

test('changing an actual same-mast spar kind invalidates its foreign cloth force cache',()=>{
  const course={id:1,mast:0,controlGroup:'main',kind:'square',pivot:[0,1,0],corners:[[-1,2,.05],[1,2,.05],[1,0,.05],[-1,0,.05]],belly:0,mastContactSide:'fore'};
  const gaff={id:2,mast:0,controlGroup:'fore',kind:'gaff',pivot:[0,1,.05],corners:[[-1,2,.05],[1,2,.05],[1,0,.05],[-1,0,.05]],belly:0,hingeAxis:[0,1,0]};
  const spar={kind:'boom',surface:2,a:[0,1,.05],b:[.2,1,2.05],radius:.05},design={id:'spar-kind-fixture',frame:{length:12,beam:3.6,verticalScale:1},surfaces:[course,gaff]},context={surfaces:design.surfaces,masts:[{index:0,foot:[0,-2,.8],head:[0,4,.8],radius:.03}],supports:[],spars:[spar]};
  const state={set:[1,1,0],surfaceYaw:{1:0,2:0},rig:[{fill:0},{fill:0},{}]},boat={length:12,beam:3.6,sailState:state},geometry=createSurfaceSailGeometry(design,context,10),cloth=geometry.surfaces[0],index=cloth.samples.findIndex(([u,v])=>u===.3&&v===.5);
  assert.ok(index>=0);updateSailGeometry(geometry,boat);const first=[...cloth.points[index]],revision=cloth.revision;
  assert.deepEqual(first,surfaceClothPoint(course,.3,.5,rigSurfacePose(course,state),{},0,0),'a remote boom leaves the opposite-side reference cloth alone');
  updateSailGeometry(geometry,boat);assert.equal(cloth.revision,revision);
  spar.kind='yard';updateSailGeometry(geometry,boat);assert.ok(cloth.revision>revision,'semantic spar classification belongs to the force cache key even with identical endpoints/radius');assert.notDeepEqual([...cloth.points[index]],first);
  spar.kind='boom';updateSailGeometry(geometry,boat);assert.deepEqual([...cloth.points[index]],first,'restoring the actual boom classification restores the same physical cloth');
});

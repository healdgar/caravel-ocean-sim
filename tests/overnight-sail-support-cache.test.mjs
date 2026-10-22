// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import {createSurfaceSailGeometry,updateSailGeometry} from '../js/sail-aerodynamics.js';
import {withRigPoseContext,surfaceClothPoint} from '../js/rig-surface.js';

test('mean-load cloth and its cache follow another surface actual moving spar',()=>{
  const main={id:1,name:'main',mast:0,controlGroup:'main',kind:'square',pivot:[0,2,0],
    corners:[[-1,2,0],[1,2,0],[1,0,0],[-1,0,0]],belly:0,braceLimit:1,mastContactSide:'aft',contactClearance:.05};
  const fore={id:2,name:'other-yard',mast:1,controlGroup:'fore',kind:'square',pivot:[0,1,.02],
    corners:[[-.8,1,.02],[.8,1,.02],[.8,-1,.02],[-.8,-1,.02]],belly:0,braceLimit:1};
  const design={id:'live-spar-fixture',frame:{length:12,beam:3.6,verticalScale:1},surfaces:[main,fore]};
  const context={surfaces:design.surfaces,masts:[],supports:[],spars:[{surface:2,a:fore.corners[0],b:fore.corners[1],radius:.08}]};
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
  const first=geometry.surfaces[0].points.map(p=>[...p]),revision=geometry.revision,mainRevision=geometry.surfaces[0].revision;
  assert.ok(first.some(p=>p[2]>.05),'fixture must actually displace main cloth away from the other yard');
  updateSailGeometry(geometry,boat);assert.equal(geometry.revision,revision,'identical actual poses retain cached panel geometry');
  state.surfaceYaw[2]=.6;updateSailGeometry(geometry,boat);compareLive();
  assert.ok(geometry.surfaces[0].revision>mainRevision,'another sail yard invalidates main cloth even with unchanged main yaw/fill');
  assert.ok(geometry.surfaces[0].points.some((p,i)=>p.some((v,k)=>Math.abs(v-first[i][k])>1e-5)),'the other yard must change actual sampled cloth, not only its cache revision');
  const settled=geometry.revision;updateSailGeometry(geometry,boat);assert.equal(geometry.revision,settled);
  const beforeRadius=geometry.surfaces[0].revision;context.spars[0].radius=.10;updateSailGeometry(geometry,boat);compareLive();
  assert.ok(geometry.surfaces[0].revision>beforeRadius,'actual spar radius also belongs to the clearance cache key');
  assert.equal(context._surfaceActiveSupports,undefined,'one live vessel pose cannot overwrite canonical static support context');
});

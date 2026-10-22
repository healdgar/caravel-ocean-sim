// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {surfaceRestPoint,rigSurfacePose,surfaceClothPoint,surfaceYardPoint,surfaceAttachmentPoint,surfaceRopePoint} from '../js/rig-surface.js';

const close=(a,b,tolerance=1e-10)=>{assert.equal(a.length,b.length);for(let i=0;i<a.length;i++)assert.ok(Math.abs(a[i]-b[i])<tolerance,`${a} differs from ${b}`);};
const mix=(a,b,t)=>a.map((x,i)=>x+(b[i]-x)*t);
const square={id:1,name:'fore-course',mast:0,controlGroup:'fore',kind:'square',corners:[[-2,6,-.2],[2,6,-.2],[2,2,-.2],[-2,2,-.2]],pivot:[0,6,-.2],belly:1,braceLimit:.6};
const lateen={id:2,name:'mizzen',mast:2,controlGroup:'mizzen',kind:'lateen',corners:[[0,8,1],[0,3,-3],[0,2,2]],pivot:[0,5,-1],belly:.4,yardClearance:.3,transferLift:1.4};
const headsail={id:3,name:'jib',mast:0,controlGroup:'fore',kind:'headsail',corners:[[0,7,-5],[0,2,-7],[0,2,-3]],pivot:[0,4,-6],belly:.3};
const gaff={id:4,name:'spanker',mast:2,controlGroup:'mizzen',kind:'gaff',corners:[[0,6,0],[0,7,3],[0,2,4],[0,2,0]],pivot:[0,2,0],belly:.4};
function state(){return {set:[1,.6,.8],squareYaw:.3,lateenYaw:-.4,windSide:3,windForward:-5,tack:-1,
  rig:[{side:1,opening:.5,dip:0,fill:1,deployed:1,pressure:1},{side:-1,opening:.4,dip:0,fill:.4,deployed:.6,pressure:.5},{side:-1,opening:.6,dip:.4,fill:.7,deployed:.8,pressure:-.5}]};}

test('surface topology, pose grouping and limits are explicit and immutable',()=>{
  close(surfaceRestPoint(square,0,0),square.corners[0]);close(surfaceRestPoint(square,1,1),square.corners[2]);
  close(surfaceRestPoint(lateen,0,1),lateen.corners[2]);close(surfaceRestPoint(lateen,1,0),lateen.corners[1]);
  const s=state(),before=JSON.stringify(s),descriptor=JSON.stringify(square);
  s.squareYaw=2;assert.equal(rigSurfacePose(square,s).yaw,.6);
  s.squareYaw=-2;assert.equal(rigSurfacePose(square,s).yaw,-.6);
  s.rig[2].deployed=.2;assert.equal(rigSurfacePose(lateen,s).deployed,.2,'lateen transfer gathering overrides its requested set');
  assert.equal(rigSurfacePose(gaff,s).deployed,.8,'gaff uses its own mast control');
  assert.equal(rigSurfacePose(square,s).fill,1);
  assert.equal(JSON.stringify(square),descriptor);
  const s2=state();for(const surface of[square,lateen,headsail,gaff])rigSurfacePose(surface,s2);assert.equal(JSON.stringify(s2),before);
  assert.throws(()=>surfaceRestPoint({...square,kind:'unknown'},0,0),/Invalid/);
  assert.throws(()=>surfaceRestPoint({...lateen,corners:[[0,0,0],[0,0,0],[1,0,0]]},0,0),/Degenerate/);
});

test('square and lateen sewn heads remain on their actual spars during furl and transfer',()=>{
  const s=state(),support={a:[0,0,0],b:[0,10,0],r:.1,mast:0,kind:'shroud'};
  for(const surface of[square,lateen])for(const deployed of[0,.3,1])for(const u of[0,.2,.7,1]){
    const pose={...rigSurfacePose(surface,s),deployed};
    close(surfaceClothPoint(surface,u,0,pose,{supports:[support]},4,18),surfaceYardPoint(surface,surfaceRestPoint(surface,u,0),pose));
  }
  const full={...rigSurfacePose(square,s),deployed:1,pressure:0},furled={...full,deployed:0};
  const top=surfaceYardPoint(square,surfaceRestPoint(square,.3,0),full),bottom=surfaceClothPoint(square,.3,1,furled);
  assert.ok(Math.hypot(...bottom.map((v,i)=>v-top[i]))<.05,'furled bundle has negligible exposed span');
  const p=rigSurfacePose(lateen,s),port=surfaceYardPoint(lateen,lateen.pivot,{...p,side:-1}),starboard=surfaceYardPoint(lateen,lateen.pivot,{...p,side:1}),transfer=surfaceYardPoint(lateen,lateen.pivot,{...p,side:0});
  assert.ok(port[0]<0&&starboard[0]>0);assert.ok(transfer[2]>lateen.pivot[2],'yard passes abaft the mast instead of linearly through it');
});

test('headsails hinge about the actual sloping luff and a gaff boom stays horizontal',()=>{
  const s=state(),p=rigSurfacePose(headsail,s);
  for(const t of[0,.2,.8,1]){
    const point=mix(headsail.corners[0],headsail.corners[1],t);
    close(surfaceYardPoint(headsail,point,p),point);
    close(surfaceClothPoint(headsail,t,0,p,{},8,20),point);
  }
  const g=rigSurfacePose(gaff,s),clew=surfaceYardPoint(gaff,gaff.corners[2],g);
  assert.equal(clew[1],gaff.corners[2][1]);assert.ok(Math.abs(clew[0])>.5,'boom sweeps across the ship about its mast');
  close(surfaceYardPoint(gaff,gaff.corners[0],g),gaff.corners[0]);
  close(surfaceYardPoint(gaff,gaff.corners[3],g),gaff.corners[3]);
});

test('filled sails draw stable camber while slack sails luff, independently per surface',()=>{
  const s=state(),filled={...rigSurfacePose(square,s),fill:1,pressure:1},slack={...filled,fill:0};
  close(surfaceClothPoint(square,.4,.5,filled,{},0,15),surfaceClothPoint(square,.4,.5,filled,{},.21,15));
  const a=surfaceClothPoint(square,.4,.5,slack,{},0,15),b=surfaceClothPoint(square,.4,.5,slack,{},.21,15);
  assert.ok(Math.hypot(...a.map((x,i)=>x-b[i]))>.005);
  const reverse=surfaceClothPoint(square,.5,.5,{...filled,pressure:-1}),forward=surfaceClothPoint(square,.5,.5,filled);
  assert.ok(Math.hypot(...reverse.map((x,i)=>x-forward[i]))>1.5,'backing reverses camber without moving the sewn head');
  assert.notEqual(rigSurfacePose(square,s).deployed,rigSurfacePose(lateen,s).deployed);
});

test('support contact moves the actual cloth smoothly and retains a real capsule clearance',()=>{
  const s=state();s.squareYaw=0;
  const pose=rigSurfacePose(square,s),support={a:[0,1,0],b:[0,7,0],r:.06,mast:0,side:1,kind:'shroud'};
  const open=surfaceClothPoint(square,.5,.5,pose),context={supports:[support]};
  const contact=surfaceClothPoint(square,.5,.5,pose,context);
  assert.ok(open[2]>0&&contact[2]<=-.105+1e-10,'backed cloth remains ahead of its support without hiding a rope');
  close(surfaceClothPoint(square,.5,0,pose,context),surfaceClothPoint(square,.5,0,pose));
  const edge=(support.r+.045+.25)/4+.5;
  const a=surfaceClothPoint(square,edge-1e-6,.5,pose,context),b=surfaceClothPoint(square,edge+1e-6,.5,pose,context);
  assert.ok(Math.hypot(...a.map((x,i)=>x-b[i]))<.0001,'support tension has no hard boundary');
  const mast=surfaceClothPoint(square,.5,.5,pose,{masts:[{foot:support.a,head:support.b,radius:support.r}]});close(mast,contact);
  assert.throws(()=>surfaceClothPoint(square,.5,.5,pose,{supports:[{a:[0,0,0],b:[0,0,0],r:.1}]}),/Degenerate/);
});

test('cloth and yard rope bindings share posed geometry; paired sheets exchange working and lazy leads',()=>{
  const s=state(),context={surfaces:[square,lateen,headsail,gaff],state:s,time:1.2,wind:13};
  const attach={surface:lateen.id,uv:[0,1]},pose=rigSurfacePose(lateen,s);
  close(surfaceAttachmentPoint(attach,context),surfaceClothPoint(lateen,0,1,pose,context,context.time,context.wind));
  close(surfaceAttachmentPoint({surface:square.id,point:square.corners[0]},context),surfaceYardPoint(square,square.corners[0],rigSurfacePose(square,s)));
  const port={kind:'sheet',side:-1,a:attach,b:[-2,1,3]},starboard={...port,side:1,b:[2,1,3]};
  const before=JSON.stringify(s);
  assert.ok(surfaceRopePoint(port,.5,context)[1]>surfaceRopePoint(starboard,.5,context)[1]+.2,'port is working for the port-side lateen');
  const reversed={...context,state:structuredClone(s)};reversed.state.rig[2].side=1;
  assert.ok(surfaceRopePoint(starboard,.5,reversed)[1]>surfaceRopePoint(port,.5,reversed)[1]+.2);
  for(const line of[port,starboard]){
    close(surfaceRopePoint(line,0,context),surfaceAttachmentPoint(line.a,context));close(surfaceRopePoint(line,1,context),line.b);
  }
  const led={...starboard,lazyLead:[1,1.4,2]};
  const a=surfaceRopePoint(led,.72-1e-6,context),b=surfaceRopePoint(led,.72+1e-6,context);
  assert.ok(Math.hypot(...a.map((x,i)=>x-b[i]))<.0001);
  assert.equal(JSON.stringify(s),before,'queries cannot advance the sail state');
  close(surfaceRopePoint({kind:'stay',a:[0,1,0],b:[1,2,3]},.5,{surfaces:[]}),[.5,1.5,1.5]);
  assert.throws(()=>surfaceAttachmentPoint({surface:99,uv:[0,1]},context),/Unknown/);
  assert.throws(()=>surfaceRopePoint({...port,side:0},.5,context),/port\/starboard/);
});

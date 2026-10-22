// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ADDITIONAL_DESIGNS} from '../js/models/additional.js';
import {additionalRigContext} from '../js/additional-rig.js';
import {createSurfaceSailGeometry,updateSailGeometry} from '../js/sail-aerodynamics.js';
import {surfaceClothPoint,surfaceYardPoint,rigSurfacePose} from '../js/rig-surface.js';
import {sailingState,advanceSails,sailForces} from '../js/sailing.js';
import {requestYardTransfer} from '../js/lateen.js';
import {boatHydrodynamics} from '../js/boat.js';

const close=(a,b,tolerance=1e-9)=>assert.ok(Math.abs(a-b)<tolerance,`${a} differs from ${b}`);
function additionalTestBoat(id){
  const d=ADDITIONAL_DESIGNS[id];return{modelId:id,length:d.runtime.length,beam:d.runtime.beam,heading:0,roll:.1,pitch:.03,
    sailFore:1,sailMain:.65,sailMizzen:.8,surgeVelocity:2,leewayVelocity:.2,
    hydrodynamics:boatHydrodynamics(d.runtime.length,d.runtime.beam,60,0,id)};
}
const additionalLoadFields=['forward','side','heaveForce','rollMoment','pitchMoment','yawMoment','area'];

test('additional models group their actual square and lateen panels by control and share visible poses',()=>{
  for(const [id,count,groups]of [['pinta',3,[1,1,1]],['santa-maria',5,[2,2,1]]]){
    const d=ADDITIONAL_DESIGNS[id],b=additionalTestBoat(id),s=sailingState(b),g=s.geometry;
    assert.equal(g.surfaceRig,true);assert.equal(g.modelId,id);assert.equal(g.surfaces.length,count);
    assert.equal(g.victory,undefined,'a mixed rig must not masquerade as Victory');
    for(let i=0;i<3;i++)assert.equal(g.surfaces.filter(p=>p.group===i).length,groups[i]);
    s.squareYaw=.3;s.lateenYaw=-.4;s.windSide=3;s.windForward=-5;
    s.rig.forEach(p=>Object.assign(p,{fill:.7,pressure:.8,opening:.55}));
    updateSailGeometry(g,b,s.rig);
    const scale=[b.beam/d.frame.beam,d.frame.verticalScale,b.length/d.frame.length];
    for(const surface of g.surfaces){
      const pose=rigSurfacePose(surface.sail,s);
      for(const [j,[a,c,e]]of surface.indices.entries()){
        const points=[a,c,e].map(index=>surfaceClothPoint(surface.sail,...surface.samples[index],pose,g.context,0,0).map((v,k)=>v*scale[k]));
        const panel=surface.panels[j];for(let k=0;k<3;k++)close(panel.point[k],points.reduce((sum,p)=>sum+p[k],0)/3);
        assert.ok(panel.area>=0&&Number.isFinite(panel.aspect));assert.ok(panel.normal.every(Number.isFinite));
      }
      assert.ok(surface.totalArea>0);
    }
    assert.equal(g.groups.flat().length,g.panels.length);
    assert.equal(d.surfaces.filter(p=>p.kind==='lateen').length,1);
    assert.notEqual(g.panels,sailingState(additionalTestBoat(id)).geometry.panels,'running force geometry stays per vessel');
  }
});

test('surface geometry caches unchanged poses and invalidates actual scale, fill and support changes',()=>{
  const d=ADDITIONAL_DESIGNS.pinta,b=additionalTestBoat('pinta'),s=sailingState(b),context=additionalRigContext('pinta');
  const mutable={surfaces:context.surfaces,supports:context.supports.map(p=>({...p,a:[...p.a],b:[...p.b]})),masts:context.masts.map(p=>({...p,foot:[...p.foot],head:[...p.head]}))};
  const g=createSurfaceSailGeometry(d,mutable);updateSailGeometry(g,b,s.rig);
  const first=g.revision,panels=g.panels,positions=g.panels.map(p=>[...p.point]);
  updateSailGeometry(g,b,s.rig);assert.equal(g.revision,first);assert.equal(g.panels,panels);
  g.panels.forEach((p,i)=>assert.deepEqual([...p.point],positions[i]));
  const before=g.surfaces.map(p=>p.revision);s.rig[2].fill=.8;updateSailGeometry(g,b,s.rig);
  assert.equal(g.surfaces[0].revision,before[0]);assert.equal(g.surfaces[1].revision,before[1]);assert.ok(g.surfaces[2].revision>before[2]);
  const filled=g.revision;b.beam*=1.1;updateSailGeometry(g,b,s.rig);assert.ok(g.revision>filled);
  const resized=g.revision;mutable.supports[0].a[0]+=.02;updateSailGeometry(g,b,s.rig);assert.ok(g.revision>resized);
  const moved=g.revision;mutable.masts[0].head[2]+=.02;updateSailGeometry(g,b,s.rig);assert.ok(g.revision>moved);
});

test('furling all additional canvas exposes no force or area; unknown identities cannot inherit Niña',()=>{
  for(const id of['pinta','santa-maria']){
    const b={...additionalTestBoat(id),sailFore:0,sailMain:0,sailMizzen:0},loads=sailForces(b,25,.4,4,1,.2,.3);
    for(const key of additionalLoadFields)assert.equal(loads[key],0,`${id} furled ${key}`);
    assert.ok(loads.geometry.panels.every(p=>p.area===0));
    const calm=additionalTestBoat(id),still=sailForces(calm,0,0,0,0,0,0);
    for(const key of additionalLoadFields.filter(k=>k!=='area'))close(still[key],0);
  }
  assert.throws(()=>sailingState({modelId:'unknown',sailFore:1}),/No sailing model/);
  const empty={id:'empty',frame:{length:12,beam:3.6,verticalScale:1},surfaces:[]},g=createSurfaceSailGeometry(empty);
  assert.deepEqual(g.groups,[[],[],[]]);assert.deepEqual(updateSailGeometry(g,{length:12,beam:3.6,sailState:{}}),[]);
});

test('new mixed rigs retain lateen yards on routine tacks and transfer only their actual lateen group',()=>{
  for(const id of['pinta','santa-maria']){
    const b={...additionalTestBoat(id),roll:0,pitch:0,sailFore:1,sailMain:1,sailMizzen:1},s=sailingState(b);
    advanceSails(b,.1,8,0);const side=s.rig[2].side;advanceSails(b,.1,8,Math.PI);
    assert.equal(s.rig[2].side,side);assert.equal(s.maneuver,undefined,'wind reversal does not order a yard transfer');
    s.tack=-1;s.apparentAngle=Math.PI/2;s.apparentSpeed=8;s.rigInitialized=true;
    s.rig.forEach((p,i)=>Object.assign(p,{side:i===2?-1:1,deployed:1,dip:0}));s.set.fill(1);
    // Unassigned square-mast rig crews must not stall a mizzen-only transfer.
    b.crewRigRate=new Float64Array([0,0,1]);assert.equal(requestYardTransfer(s),true);
    let dipped=false;
    for(let i=0;i<1500&&s.maneuver;i++){
      advanceSails(b,.05,8,0);dipped||=s.rig[2].dip>0;
      for(const j of[0,1])assert.equal(s.rig[j].dip,0);
      for(const surface of ADDITIONAL_DESIGNS[id].surfaces.filter(p=>p.kind==='square')){
        const pose=rigSurfacePose(surface,s);close(surfaceYardPoint(surface,surface.pivot,pose)[1],surface.pivot[1]);
        assert.ok(Math.abs(pose.yaw)<=surface.braceLimit);
      }
    }
    assert.ok(dipped,'the actual lateen yard performs the maneuver');assert.equal(s.maneuver,null,'the bounded transfer completes');assert.equal(s.rig[2].side,1);
    for(const p of s.rig)assert.ok(p.deployed>.99);
  }
});

test('additional cloth forces use their own hydrostatic vertical datum and remain finite and passive',()=>{
  for(const id of['pinta','santa-maria']){
    const b=additionalTestBoat(id),s=sailingState(b);s.squareYaw=.25;s.windSide=4;s.windForward=-5;s.rig.forEach(p=>Object.assign(p,{fill:.8,pressure:1,opening:.55}));
    const firstLoad=sailForces(b,10,.7,3,.4),first=additionalLoadFields.map(k=>firstLoad[k]);assert.ok(first.every(Number.isFinite));assert.ok(first.at(-1)>0);
    const oldHydro=b.hydrodynamics;b.hydrodynamics={...oldHydro,datumDraft:oldHydro.datumDraft+1,centreOfGravity:oldHydro.centreOfGravity+1};
    const secondLoad=sailForces(b,10,.7,3,.4),second=additionalLoadFields.map(k=>secondLoad[k]);second.forEach((x,i)=>close(x,first[i]));
    b.hydrodynamics=oldHydro;b.rollVelocity=.13;b.pitchVelocity=-.07;
    const loads=sailForces(b,0,.4,3,.5),power=loads.forward*3+loads.side*.5+loads.rollMoment*b.rollVelocity+loads.pitchMoment*b.pitchVelocity;
    assert.ok(Number.isFinite(power)&&power<=1e-7,'still air cannot supply propulsion or angular energy');
  }
});

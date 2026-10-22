// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createHullLateralDescriptor,evaluateHullLateral,registerHullLateralModel,HULL_LATERAL_COEFFICIENTS} from '../js/hull-lateral.js';
import {hullHydrostatics,stepBoatSurge,stepBoatSteering} from '../js/boat.js';
import {NINA_DESIGN} from '../js/models/nina.js';
import {VICTORY_DESIGN} from '../js/models/victory.js';

const near=(a,b,tolerance=1e-9)=>assert.ok(Math.abs(a-b)<=tolerance*Math.max(1,Math.abs(a),Math.abs(b)),`${a} != ${b}`);
const definition=(bounds=[-5,5],appendages=[])=>({frame:{length:10,beam:2,verticalScale:1},bounds,
  halfWidth:(z,y)=>z>=bounds[0]&&z<=bounds[1]&&y>=-2&&y<=1?1:0,deck:()=>1,bottom:()=>-2,
  appendages,provenance:'Analytic rectangular test hull; not a playable ship.'});
registerHullLateralModel('test-lateral-rectangle',definition());
registerHullLateralModel('test-lateral-aft',definition([-2,8]));
registerHullLateralModel('test-lateral-fin',definition([-5,5],[{id:'fin',kind:'fin-keel',bounds:[-1,1],top:()=>-2,bottom:()=>-4,
  provenance:'Analytic independently exposed fin.'}]));
const rectangle=()=>createHullLateralDescriptor({modelId:'test-lateral-rectangle',length:10,beam:2});
const descriptor=(modelId,changes={})=>{
  const design=modelId==='victory'?VICTORY_DESIGN:NINA_DESIGN;
  return createHullLateralDescriptor({modelId,...design.runtime,...changes});
};
const load=(d,state)=>evaluateHullLateral({},d,state);
const boat=(modelId='nina',changes={})=>({modelId,...(modelId==='victory'?VICTORY_DESIGN:NINA_DESIGN).runtime,
  heading:0,rudder:0,rudderTarget:0,yawRate:0,roll:0,pitch:0,rollVelocity:0,pitchVelocity:0,heaveVelocity:0,
  propulsion:'sail',speed:6,sailFore:0,sailMain:0,sailMizzen:0,revision:1,...changes});

test('lateral descriptors use physical loaded underwater silhouettes and distinguish actual exposed keel geometry',()=>{
  const nina=descriptor('nina'),victory=descriptor('victory');
  assert.equal(nina.components.length,2);assert.equal(victory.components.length,1);
  assert.equal(nina.components[0].kind,'projected-hull');assert.equal(nina.components[1].kind,'exposed-keel');
  near(nina.components[1].span,.075*NINA_DESIGN.frame.verticalScale);
  near(nina.components[1].area,(5.6-.5-(-6.4+1.45))*(20/12)*.075*NINA_DESIGN.frame.verticalScale);
  assert.ok(nina.area>20&&nina.area<45);assert.ok(victory.area>200&&victory.area<56.6928*8.8);
  assert.ok(victory.span>8&&victory.span<9);assert.ok(victory.area>nina.area*5);
  assert.ok(nina.components.every(c=>c.provenance));assert.match(victory.provenance,/authored/);
  assert.equal(nina.addedMassRatio,.8);assert.equal(HULL_LATERAL_COEFFICIENTS.addedMassRatio,.8);
  assert.ok(Object.isFrozen(nina)&&Object.isFrozen(nina.components)&&Object.isFrozen(nina.components[0].strips));
  const long=descriptor('nina',{length:40}),loaded=descriptor('nina',{waterline:.15});
  near(long.area,nina.area*2);near(long.clr.z,nina.clr.z*2);near(long.clr.y,nina.clr.y);
  assert.ok(loaded.area>nina.area&&loaded.span>nina.span,'loading changes the actual immersed profile');
});

test('registration is explicit and propulsion-independent, with separate aspect for a yacht appendage',()=>{
  assert.throws(()=>createHullLateralDescriptor({modelId:'unknown',length:10,beam:2}),/No lateral hull geometry/);
  assert.throws(()=>hullHydrostatics(10,2,0,'unknown'),/No hydrostatic hull geometry/);
  assert.throws(()=>stepBoatSurge(boat('nina',{modelId:'unknown'}),0,.01),/No hydrostatic hull geometry/);
  assert.throws(()=>registerHullLateralModel('test-lateral-rectangle',definition()),/duplicate/);
  assert.throws(()=>registerHullLateralModel('invalid',{}),/requires/);
  const d=rectangle();near(d.area,20);near(d.clr.z,0);near(d.clr.y,-1);
  const fin=createHullLateralDescriptor({modelId:'test-lateral-fin',length:10,beam:2});
  near(fin.components[1].area,4);near(fin.components[1].aspect,1);near(fin.components[0].aspect,.2);
  assert.equal(fin.components[1].kind,'fin-keel');near(fin.span,4);
  const a=load(d,{surge:3,sway:.3}),b=load(d,{surge:3,sway:.3,propulsion:'oar'});
  assert.deepEqual(a,b,'underwater resistance does not require a sail plan or propulsion controller');
  const dry=createHullLateralDescriptor({modelId:'test-lateral-rectangle',length:10,beam:2,waterline:-3});
  assert.equal(dry.area,0);assert.ok(Object.values(load(dry,{surge:4,sway:2,yawRate:.2})).every(x=>x===0));
});

test('geometric CLR and depth produce the corresponding yaw and roll levers',()=>{
  const d=createHullLateralDescriptor({modelId:'test-lateral-aft',length:10,beam:2}),s=load(d,{sway:1});
  near(d.clr.z,3);near(s.yawMoment/s.side,-d.clr.z);near(s.rollMoment/s.side,-d.clr.y);
  const shifted=load(d,{sway:1,cgY:.6,cgZ:1.5});
  near(shifted.yawMoment/shifted.side,-(d.clr.z-1.5));near(shifted.rollMoment/shifted.side,-(d.clr.y-.6));
  assert.ok(s.side<0&&s.yawMoment>0,'port-directed resistance aft produces clockwise yaw');
});

test('crossflow and attached-flow lift remain passive under coupled sway, yaw, roll, pitch and heave',()=>{
  for(const model of ['nina','victory']){
    const d=descriptor(model),out={};
    for(const surge of [-5,0,5])for(const sway of [-1,0,1])for(const yawRate of [-.2,0,.2])for(const rollRate of [-.2,0,.2])
      for(const roll of [-.25,.25])for(const pitch of [-.12,.12]){
        const s={surge,sway,yawRate,rollRate,roll,pitch,heaveRate:.3,pitchRate:-.1,cgY:1.2};
        assert.equal(evaluateHullLateral(out,d,s),out,'per-step evaluation uses caller-owned output');
        const tolerance=2e-10*Math.max(1,out.dissipation);
        assert.ok(out.power<=tolerance,`${model} water cannot supply power: ${JSON.stringify(s)}`);
        assert.ok(Math.abs(out.power+out.dissipation)<=tolerance,'lift is perpendicular to local flow and drag accounts for the lost power');
        for(const key of ['sideDamping','rollDamping','yawDamping'])assert.ok(Number.isFinite(out[key])&&out[key]>=0);
      }
  }
});

test('mirrored tacks preserve forward work while reversing lateral forces and moments',()=>{
  for(const model of ['nina','victory']){
    const d=descriptor(model),s={surge:4,sway:.7,yawRate:.06,rollRate:.08,roll:.2,pitch:.1,pitchRate:-.03,heaveRate:.2,cgY:1};
    const a=load(d,s),b=load(d,{...s,sway:-s.sway,yawRate:-s.yawRate,rollRate:-s.rollRate,roll:-s.roll});
    for(const key of ['forward','heaveForce','pitchMoment','dissipation'])near(a[key],b[key]);
    for(const key of ['side','rollMoment','yawMoment'])near(a[key],-b[key]);
  }
});

test('zero flow supplies no force, broadside drift is resisted, and attached lift works during headway and sternway',()=>{
  const d=rectangle(),zero=load(d,{});assert.ok(Object.values(zero).every(x=>x===0));
  const rest=load(d,{sway:.5}),ahead=load(d,{surge:4,sway:.5}),astern=load(d,{surge:-4,sway:.5});
  assert.ok(rest.side<0&&rest.forward===0);assert.ok(Math.abs(ahead.side)>Math.abs(rest.side),'headway increases leeway resistance');
  near(ahead.side,astern.side);near(ahead.forward,-astern.forward);assert.ok(ahead.power<0&&astern.power<0);
  const invalid=load(d,{surge:NaN,sway:2});assert.ok(Object.values(invalid).every(x=>x===0));
});

test('distributed local velocities damp pure yaw and roll without a turn-assist or an imposed target heading',()=>{
  const d=rectangle(),yaw=load(d,{yawRate:.2}),roll=load(d,{rollRate:.2});
  assert.ok(yaw.yawMoment<0&&yaw.yawDamping>0);near(yaw.side,0,1e-8);
  assert.ok(roll.rollMoment<0&&roll.rollDamping>0);assert.ok(roll.power<0&&yaw.power<0);
  assert.ok(load(d,{yawRate:-.2}).yawMoment>0);assert.ok(load(d,{rollRate:-.2}).rollMoment>0);
});

test('underwater geometry caches across physics substeps and rebuilds only on geometry or loading edits',()=>{
  const b=boat();stepBoatSurge(b,0,.02,0,0);const cache=b.lateralHydrodynamics;
  for(let i=0;i<12;i++)stepBoatSurge(b,0,.02,0,0);
  assert.equal(b.lateralHydrodynamics,cache);assert.equal(b.lateralHydrodynamics.descriptor,cache.descriptor);
  b.cargoTonnes=10;stepBoatSurge(b,0,.02,0,0);assert.notEqual(b.lateralHydrodynamics,cache);
  assert.ok(b.lateralHydrodynamics.descriptor.area>cache.descriptor.area);
});

test('sail and hull yaw moments reach steering once; revisions and zero-time frames cannot replay old loads',()=>{
  for(const model of ['nina','victory']){
    const b=boat(model,{sailFore:1,sailMain:1,sailMizzen:1});
    stepBoatSurge(b,0,.01,10,0);const moment=b.sailYawMoment+b.waterYawMoment;
    assert.ok(Math.abs(b.sailYawMoment)>1e-3,'the actual off-centre sail loading computes yaw');
    stepBoatSteering(b,0,.01);assert.equal(Math.sign(b.yawRate),Math.sign(moment));
    assert.equal(b.sailYawMoment,0);assert.equal(b.waterYawMoment,0);
    const stale=boat(model,{sailFore:1,sailMain:1,sailMizzen:1});stepBoatSurge(stale,0,.01,10,0);
    stale.revision++;stepBoatSteering(stale,0,.01);assert.equal(stale.yawRate,0);
    stepBoatSurge(stale,0,.01,10,0);stepBoatSurge(stale,0,0,10,0);stepBoatSteering(stale,0,.01);assert.equal(stale.yawRate,0);
  }
});

test('sternway reverses the existing rudder response and the rudder cannot propel or turn a motionless ship',()=>{
  for(const model of ['nina','victory'])for(const speed of [-3,0,3]){
    const a=boat(model,{surgeVelocity:speed,rudder:25,rudderTarget:25}),b=boat(model,{surgeVelocity:speed});
    stepBoatSurge(a,0,.02,0,0);stepBoatSurge(b,0,.02,0,0);
    near(a.surgeVelocity,b.surgeVelocity);near(a.leewayVelocity,b.leewayVelocity);
    stepBoatSteering(a,0,.02);assert.equal(Math.sign(a.yawRate),Math.sign(speed));
    if(speed===0){assert.equal(a.heading,0);assert.equal(a.surgeVelocity,0);}
  }
});

test('shared lateral response stays finite and consistent across 30/60/120 Hz without hull-specific tuning',()=>{
  for(const model of ['nina','victory']){
    const results=[1/30,1/60,1/120].map(dt=>{
      const b=boat(model,{surgeVelocity:3,leewayVelocity:.4,yawRate:.03,roll:.04});
      for(let t=0;t<6-1e-9;t+=dt){stepBoatSurge(b,0,dt,0,0);stepBoatSteering(b,0,dt);}
      return b;
    });
    for(const b of results)for(const key of ['surgeVelocity','leewayVelocity','yawRate','roll','rollVelocity']){
      assert.ok(Number.isFinite(b[key]),`${model} ${key}`);assert.ok(Math.abs(b[key]-results[2][key])<.02,`${model} ${key} frame partition`);
    }
  }
});

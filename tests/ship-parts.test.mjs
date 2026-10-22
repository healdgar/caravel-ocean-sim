// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {getShipParts,resolveShipTransform,SHIP_PART_CAPABILITIES} from '../js/ship-parts.js';
import {getShipModel,resolveShipNode} from '../js/ship-models.js';
import {NINA_DESIGN} from '../js/models/nina.js';
import {VICTORY_DESIGN,VICTORY_SAILS,victoryHullHalfWidth,victoryHatchPivot} from '../js/models/victory.js';
import {hullHalfWidth} from '../js/hull.js';
import {SAIL_PLAN,lateenYardPoint,lateenClothPoint} from '../js/lateen.js';
import {victoryPose,victoryYardPoint,victoryClothPoint} from '../js/victory-motion.js';
import {boatRotate,boatHydrodynamics} from '../js/boat.js';

const close=(a,b,tolerance=1e-10)=>{assert.equal(a.length,b.length);for(let i=0;i<a.length;i++)assert.ok(Math.abs(a[i]-b[i])<tolerance,`${a} differs from ${b}`);};
const add=(a,b)=>a.map((v,i)=>v+b[i]),sub=(a,b)=>a.map((v,i)=>v-b[i]);
function boat(modelId){
  const p=getShipParts(modelId);
  return {modelId,length:p.runtime.length,beam:p.runtime.beam,heading:33,pitch:.09,roll:-.12,x:80,z:-45,heave:.4,rudder:17,hatchesClosed:.3,
    sailState:{set:[1,.65,.4],squareYaw:.3,lateenYaw:-.35,windSide:4,windForward:-3,
      rig:[{side:-1,opening:.6,dip:.2,fill:.7,deployed:1,pressure:.9},{side:1,opening:.4,dip:0,fill:.4,deployed:.65,pressure:.7},{side:-1,opening:.7,dip:.3,fill:.8,deployed:.4,pressure:1}]}};
}

test('ready ships expose shared capabilities without promoting a planned backend',()=>{
  const n=getShipParts('nina'),v=getShipParts('victory');
  assert.equal(getShipParts('nina'),n);assert.ok(Object.isFrozen(n)&&Object.isFrozen(n.hull.keel)&&Object.isFrozen(v.rig.surfaces));
  assert.equal(n.modelCode,0);assert.equal(v.modelCode,1);
  assert.equal(n.hull.profile.halfWidth,hullHalfWidth);assert.equal(v.hull.profile.halfWidth,victoryHullHalfWidth);
  assert.deepEqual(n.frame.axes,{x:'starboard',y:'up',z:'aft'});
  assert.equal(n.hull.keel.kind,'separate-timber');assert.equal(n.hull.keel.exposedDepth,.075);
  assert.equal(v.hull.keel.kind,'integral-loft-bottom');assert.equal(v.hull.keel.separateTimber,null);
  assert.equal(n.hull.keel.historicalEndpoints,null);assert.equal(v.hull.keel.historicalEndpoints,null);
  assert.equal(n.hull.lateral.separateKeel,true);assert.equal(v.hull.lateral.separateKeel,false);
  assert.deepEqual(n.decks.zones.map(d=>d.id),['main','quarter']);
  assert.deepEqual(v.decks.zones.map(d=>d.id),['main','forecastle','quarter','poop']);
  assert.equal(n.rig.surfaces.length,3);assert.equal(v.rig.surfaces.length,12);
  for(const p of[n,v]){
    assert.equal(p.rig.controlGroups.length,3);
    assert.equal(p.rig.controlGroups.flatMap(g=>g.surfaceIDs).length,p.rig.surfaces.length);
    assert.equal(p.crew.representedCount,12);assert.equal(p.crew.stations.length,12);
    assert.equal(p.crew.stations.find(s=>s.id==='pedro').role,'helmsman');
    assert.equal(p.propulsion.oars,null);assert.equal(p.propulsion.paddles,null);
  }
  assert.equal(n.loading.manifest.crew,12);assert.equal(v.loading.manifest.crew,820);
  assert.equal(v.crew.representativeWatch,true);assert.equal(n.crew.representativeWatch,false);
  assert.equal(n.equipment.guns.length,4);assert.equal(v.equipment.guns.length,104);
  assert.equal(n.steering.wheel,null);assert.equal(v.steering.wheel.role,'helm.wheel');
  assert.equal(SHIP_PART_CAPABILITIES.rig.optional,true);assert.deepEqual(SHIP_PART_CAPABILITIES.rig.empty.surfaces,[]);
  assert.equal(getShipParts('pinta').modelId,'pinta');assert.throws(()=>getShipParts('not-a-ship'),/Unknown/);
});

test('profile, loading and crew adapters retain their authoritative inputs',()=>{
  for(const id of['nina','victory']){
    const p=getShipParts(id),b=boat(id),definition=getShipModel(id),design=id==='nina'?NINA_DESIGN:VICTORY_DESIGN;
    for(const z of[-4,0,3])for(const y of[-.7,0,.4])close(p.hull.profile.point(z,y,-1),[-p.hull.profile.halfWidth(z,y),y,z]);
    assert.deepEqual(p.loading.evaluate(b),boatHydrodynamics(b.length,b.beam,b.provisionDays,b.cargoTonnes,id));
    for(const s of p.crew.stations){
      const source=definition.crewStations[s.id];close(s.position,[source.x,p.decks.weatherDeck(source.z),source.z]);assert.deepEqual(s.route,source.route);
    }
    assert.equal(p.hull.profile.draft,design.hull.draft);
    const lateral=p.hull.lateral.create(b);assert.equal(lateral.modelId,id);
    assert.equal(lateral.components.some(c=>c.kind==='exposed-keel'),id==='nina');
  }
});

test('static and moving attachment positions preserve legacy leaf endpoints and world attitude',()=>{
  for(const id of['nina','victory']){
    const b=boat(id),snapshot=JSON.stringify(b);
    const roles=['hull','deck.main','helm.camera','helm.grip','anchor.port.fairlead','station.crew.ines','mast.fore','mast.main.runner','rig.fore.fall'];
    roles.push(id==='nina'?'sail.fore.clew':'sail.fore-course.port');
    for(const role of roles){
      const opts={along:-.09,side:-1,step:12,height:3,time:1.7,wind:12};
      for(const space of['design','vessel'])close(resolveShipTransform(b,role,{...opts,space}).position,resolveShipNode(b,role,{...opts,space}));
      const local=resolveShipTransform(b,role,{...opts,space:'vessel'}),world=resolveShipTransform(b,role,{...opts,space:'world'}),expected=[0,0,0];
      boatRotate(expected,...local.position,b.heading*Math.PI/180,b.pitch,b.roll);close(world.position,add(expected,[b.x,b.heave,b.z]));
      assert.ok(world.basis.flat().every(Number.isFinite));
    }
    assert.equal(JSON.stringify(b),snapshot,'querying parts must not initialize/advance live rig state');
  }
});

test('yard bases follow actual yard transfer and bracing rather than translating a parent',()=>{
  for(const id of['nina','victory']){
    const b=boat(id),model=getShipModel(id),role=id==='nina'?'yard.fore':'yard.fore-course';
    const origin=id==='nina'?model.nodes[role].motion.point:VICTORY_SAILS[0].pivot;
    const evaluate=id==='nina'?p=>lateenYardPoint(0,p,b.sailState.rig[0]):p=>victoryYardPoint(VICTORY_SAILS[0].id,p,victoryPose(VICTORY_SAILS[0],b.sailState));
    const t=resolveShipTransform(b,role,{space:'design'});close(t.position,evaluate(origin));
    for(const [i,axis]of [[1,0,0],[0,1,0],[0,0,1]].entries())close(t.basis[i],sub(evaluate(add(origin,axis)),t.position));
    const next=structuredClone(b);
    if(id==='nina')next.sailState.rig[0].dip=.8;else next.sailState.squareYaw=-.3;
    const changed=resolveShipTransform(next,role,{space:'design'});
    assert.ok(changed.basis.some((axis,i)=>axis.some((x,j)=>Math.abs(x-t.basis[i][j])>.01)),'orientation must change with the authoritative yard pose');
  }
});

test('cloth transforms sample posed camber and return normals after anisotropic scaling',()=>{
  for(const id of['nina','victory']){
    const b=boat(id),role=id==='nina'?'sail.fore':'sail.fore-course',u=.23,v=.31,time=2.3,wind=15;
    const evaluate=id==='nina'?(u,v)=>lateenClothPoint(0,u,v,b.sailState.rig[0],time,wind)
      :(u,v)=>victoryClothPoint(VICTORY_SAILS[0].id,u,v,victoryPose(VICTORY_SAILS[0],b.sailState),time,wind);
    const t=resolveShipTransform(b,role,{space:'design',u,v,time,wind});close(t.position,evaluate(u,v));
    const physical=resolveShipTransform({...b,beam:b.beam*1.2},role,{u,v,time,wind});
    const [a,c,n]=physical.basis,dot=x=>x.reduce((s,v,i)=>s+v*n[i],0);
    assert.ok(Math.abs(dot(a))<1e-9&&Math.abs(dot(c))<1e-9);assert.ok(Math.abs(Math.hypot(...n)-1)<1e-12);
    assert.ok(Math.abs(t.basis[0][0])+Math.abs(t.basis[0][1])+Math.abs(t.basis[0][2])>1,'basis carries UV derivatives rather than a fabricated identity');
  }
});

test('helm and hatch transforms reflect the working pivots; absent parts fail explicitly',()=>{
  const n=boat('nina'),v=boat('victory');
  const nr=resolveShipTransform(n,'helm.rudder',{space:'design'}),vr=resolveShipTransform(v,'helm.rudder',{space:'design'});
  close(nr.position,[0,-.6,5.68]);close(vr.position,VICTORY_DESIGN.tiller.pivot);
  assert.ok(nr.basis[2][0]>0&&vr.basis[2][0]>0,'positive helm moves the trailing axis starboard');
  close(resolveShipTransform(v,'helm.wheel',{space:'design'}).position,VICTORY_DESIGN.wheel.centre);
  close(resolveShipTransform(v,'hatch.main',{space:'design'}).position,victoryHatchPivot());
  assert.ok(resolveShipTransform(n,'hatch.main',{space:'design'}).basis[2][1]<0);
  assert.ok(resolveShipTransform(v,'hatch.main',{space:'design'}).basis[2][1]>0);
  assert.throws(()=>resolveShipTransform(n,'helm.wheel'),/Absent/);
  assert.throws(()=>resolveShipTransform(n,'deck.forecastle'),/Absent/);
  assert.throws(()=>resolveShipTransform(v,'lookout.fore'),/Absent/);
  assert.throws(()=>resolveShipTransform(n,'mast.imaginary'),/Absent/);
  assert.throws(()=>resolveShipTransform(n,'hull',{space:'camera'}),/space/);
});

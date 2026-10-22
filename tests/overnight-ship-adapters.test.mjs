// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Proposed integrated registry/parts/cache checks; execution belongs to root.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {getShipParts,resolveShipTransform} from '../js/ship-parts.js';
import {requirePlayableShipModel,resolveShipNode} from '../js/ship-models.js';
import {createShipAssetCache} from '../js/ship-mesh.js';
import {ROWING_DESIGNS} from '../js/models/rowing.js';
import {LATER_SAIL_DESIGNS} from '../js/models/later-sail.js';
import {proceduralShipNodeTransform} from '../js/procedural-models.js';
import {boatRotate} from '../js/boat.js';

const designs=[...Object.values(ROWING_DESIGNS),...Object.values(LATER_SAIL_DESIGNS)];
const near=(a,b,e=2e-8)=>{assert.equal(a.length,b.length);for(let i=0;i<a.length;i++)assert.ok(Math.abs(a[i]-b[i])<=e,`${a} != ${b}`);};
const ship=d=>({modelId:d.id,...d.runtime,length:d.runtime.length*1.07,beam:d.runtime.beam*.91,rudder:18,heading:37,pitch:.10,roll:-.16,x:72,z:-31,heave:.35,hatchesClosed:.45,
  sailState:{set:[.15,.7,.4],groupYaw:[.2,-.3,.4],windSide:3,windForward:5,rig:[{fill:.6},{fill:.8},{fill:.4}]},rowingState:{phase:.23,rate:.42,effortPort:.9,effortStarboard:.8}});

test('ready later parts expose actual optional equipment, appendages, propulsion and physical mast/control mappings',()=>{
  for(const d of designs){
    const m=requirePlayableShipModel(d.id),p=getShipParts(d.id);assert.equal(p,getShipParts(d.id));assert.ok(Object.isFrozen(p)&&Object.isFrozen(p.roles));
    assert.equal(p.modelCode,d.modelCode);assert.equal(p.rig.masts.length,d.masts.length);assert.equal(p.rig.surfaces.length,d.surfaces.length);
    assert.deepEqual(p.rig.controlGroups.map(g=>g.id),['fore','main','mizzen'].filter(id=>d.surfaces.some(s=>s.controlGroup===id)));
    for(const g of p.rig.controlGroups){assert.equal(g.index,{fore:0,main:1,mizzen:2}[g.id]);assert.ok(m.nodes['station.haul.'+g.id]&&m.nodes['rig.'+g.id+'.fall']);}
    assert.equal(p.equipment.guns.length,0);assert.equal(p.crew.loadedCount,d.loading.crew);assert.equal(p.crew.representedCount,Object.keys(d.crewStations).length);
    assert.equal(!!p.hull.keel,!!d.keel);assert.equal(p.hull.lateral.separateKeel,!!d.keel);
    if(d.id==='taino-canoe'){
      assert.equal(p.equipment.anchor,null);assert.equal(p.hull.keel,null);assert.equal(p.rig.controlGroups.length,0);assert.equal(p.propulsion.sails.enabled,false);assert.equal(p.propulsion.oars,null);assert.equal(p.propulsion.paddles.enabled,true);assert.equal(p.steering.kind,'steering-paddle');
    }else if(d.id==='gipsy-moth-iv'){
      assert.equal(p.hull.keel.kind,'profiled-ballast-fin');assert.equal(p.propulsion.engine.enabled,false);assert.equal(p.steering.wheel,null);assert.equal(p.steering.tiller.role,'helm.tiller');
      assert.deepEqual(p.rig.masts.map(m=>m.id),['main','mizzen']);assert.deepEqual(p.rig.controlGroups.map(g=>g.id),['fore','main','mizzen']);assert.ok(p.decks.zones.some(z=>z.id==='cockpit'));
    }else if(d.id==='flying-cloud'){
      assert.equal(p.steering.tiller,null);assert.equal(p.steering.wheel.role,'helm.wheel');assert.equal(p.rig.surfaces.filter(s=>s.kind==='square').length,15);assert.equal(p.crew.representativeWatch,true);
    }else {assert.equal(p.propulsion.oars.enabled,true);assert.equal(p.propulsion.paddles,null);assert.equal(p.rig.controlGroups[0].index,1);}
  }
});

test('new parts preserve full affine poses through design, vessel and world coordinates',()=>{
  for(const d of designs){
    const b=ship(d),m=requirePlayableShipModel(d.id),parts=getShipParts(d.id),roles=['helm.grip','helm.rudder','helm.camera','deck.main'];
    if(d.surfaces.length)roles.push(m.rig.sails[0].sailNode,m.rig.sails[0].clewNodes[0],m.rig.sails[0].yardNode??m.rig.sails[0].sparNode??m.rig.sails[0].luffNode);
    if(d.stations?.length)roles.push('rowing.'+d.stations[0].id+'.grip.0');
    if(d.hatch)roles.push('hatch.main','hatch.grip');
    const scale=[b.beam/d.frame.beam,d.frame.verticalScale,b.length/d.frame.length],before=JSON.stringify(b);
    for(const role of roles){
      const options={time:2.2,wind:8,along:-.09},expected=proceduralShipNodeTransform(b,m,m.nodes[role],options),design=resolveShipTransform(b,role,{...options,space:'design'}),local=resolveShipTransform(b,role,options),world=resolveShipTransform(b,role,{...options,space:'world'});
      near(design.position,expected.position);near(design.position,resolveShipNode(b,role,{...options,space:'design'}));near(local.position,expected.position.map((v,i)=>v*scale[i]));
      const position=[0,0,0];boatRotate(position,...local.position,b.heading*Math.PI/180,b.pitch,b.roll);near(world.position,position.map((v,i)=>v+[b.x,b.heave,b.z][i]));
      assert.ok(world.basis.flat().every(Number.isFinite));
      if(local.kind==='surface')for(const tangent of local.basis.slice(0,2))assert.ok(Math.abs(tangent.reduce((sum,v,i)=>sum+v*local.basis[2][i],0))<1e-8);
    }
    assert.equal(JSON.stringify(b),before);
    if(!parts.equipment.anchor)assert.throws(()=>resolveShipTransform(b,'anchor.port.fairlead'),/Absent/);
    if(!parts.steering.wheel)assert.throws(()=>resolveShipTransform(b,'helm.wheel'),/Absent/);
  }
});

test('asset cache dispatches each actual builder and authoritative pose without replacing legacy assets',()=>{
  const cache=createShipAssetCache(),seen=new Set();
  for(const d of designs){
    const a=cache.get(d.id);assert.equal(cache.get(d.id),a);assert.equal(a.model.id,d.id);assert.equal(a.gpuPose,false);assert.equal(typeof a.pose,'function');assert.ok(a.vertices.length&&a.indices.length);
    assert.equal(seen.has(a.vertices),false);seen.add(a.vertices);
    const first=new Float32Array(a.vertices),second=new Float32Array(a.vertices),b=ship(d),other={...ship(d),rudder:-20,sailState:{...b.sailState,set:[.8,.2,.9],groupYaw:[-.1,.3,-.2]},rowingState:{...b.rowingState,phase:.72}};
    const source=new Uint32Array(a.vertices.buffer).slice();a.pose(b,2,7,first);const saved=new Uint32Array(first.buffer).slice();a.pose(other,4,11,second);a.pose(b,2,7,first);
    assert.deepEqual(new Uint32Array(first.buffer),saved);assert.deepEqual(new Uint32Array(a.vertices.buffer),source);assert.notDeepEqual(new Uint32Array(first.buffer),new Uint32Array(second.buffer));
  }
  for(const id of ['nina','victory','pinta','santa-maria'])assert.equal(cache.get(id).model.id,id);
  assert.throws(()=>cache.get('unregistered-test-boat'),/Unknown/);
});

// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Proposed real-construction/pose checks, not screenshots or historical proof.
// Root owns execution after the disjoint overnight worktrees are integrated.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createLaterSailShipMesh,createLaterSailAssetPose} from '../js/later-sail-ships.js';
import {LATER_SAIL_DESIGNS,laterSailDesign,laterSailKeelHalfWidth,laterSailStairFlights} from '../js/models/later-sail.js';
import {laterSailRigContext,laterSailSteeringPose} from '../js/additional-rig.js';
import {rigSurfacePose,surfaceClothPoint,surfaceYardPoint,surfaceRopePoint,withRigPoseContext} from '../js/rig-surface.js';
import {indexCaravelMesh} from '../js/caravel.js';

const cached=new Map(),near=(a,b,e=3e-5)=>assert.ok(Math.abs(a-b)<=e,`${a} != ${b}`);
const vectorNear=(a,b,e=3e-5)=>{for(let i=0;i<3;i++)near(a[i],b[i],e);};
const key=p=>p.map(x=>Math.round(x*1e5)).join('/');
const points=mesh=>{const out=[];for(let i=0;i<mesh.length;i+=9)out.push(Array.from(mesh.subarray(i,i+3)));return out;};
function asset(id){
  if(!cached.has(id)){const groups=[],parts=new Map(),raw=createLaterSailShipMesh(id,{groups,parts});cached.set(id,{model:{id},raw,groups,parts,...indexCaravelMesh(raw)});}
  return cached.get(id);
}
const boat=d=>({modelId:d.id,...d.runtime,rudder:23,hatchesClosed:.37,sailState:{set:[.85,.65,.35],groupYaw:[.18,-.27,.32],windSide:3,windForward:6,rig:[{fill:.8,side:-1},{fill:.7,side:1},{fill:.4,side:-1}]}});

test('real later meshes contain 25 clipper surfaces and fifteen yards, two ketch masts and no phantom equipment',()=>{
  for(const d of Object.values(LATER_SAIL_DESIGNS)){
    const a=asset(d.id),names=new Set(a.groups.map(g=>g.id));
    assert.equal(a.raw.length%27,0);assert.ok(a.raw.every(Number.isFinite));assert.ok(a.raw.length/27<250_000);
    for(let i=0;i<a.raw.length;i+=9)near(Math.hypot(a.raw[i+3],a.raw[i+4],a.raw[i+5]),1,2e-6);
    for(const id of ['hull.planking','hull.keel','deck.main.planks','helm.rudder','hatch.main','hatch.coaming','rig.standing','rig.running'])assert.ok(names.has(id),d.id+' '+id);
    assert.equal(a.groups.filter(g=>g.id.startsWith('sail.')).length,d.surfaces.length);
    assert.equal(a.groups.filter(g=>g.id.startsWith('mast.')).length,d.masts.length);
    assert.equal(a.groups.some(g=>g.id.startsWith('gun.')),false);
    for(const group of a.groups){assert.equal(group.firstVertex%3,0);assert.equal(group.vertexCount%3,0);assert.ok(group.firstVertex+group.vertexCount<=a.raw.length/9);}
    if(d.id==='flying-cloud'){
      assert.equal(a.groups.filter(g=>g.id.startsWith('sail.')).length,25);assert.equal(a.groups.filter(g=>g.id.startsWith('yard.')).length,15);
      for(const name of ['structure.deckhouse','deck.poop.planks','deck.forecastle.planks','helm.wheel','bow.bowsprit'])assert.ok(names.has(name));
      assert.equal(names.has('helm.tiller'),false);
    }else{
      for(const name of ['structure.cabin','deck.cockpit','helm.tiller'])assert.ok(names.has(name));
      assert.equal(a.groups.some(g=>g.id.startsWith('yard.')),false);assert.equal(names.has('bow.bowsprit'),false);assert.equal(names.has('helm.wheel'),false);assert.equal(names.has('mast.fore'),false);
      assert.equal(d.equipment.engine.enabled,false);
    }
  }
});

test('finite ballast fin uses its actual changing section shape and clipper wales return to the same skin vertices',()=>{
  const d=laterSailDesign('gipsy-moth-iv'),a=asset(d.id),fin=points(a.parts.get('hull.keel'));
  assert.ok(fin.length>300);const sectionYs=d.keel.sections.map(s=>s.y);
  for(const [x,y,z]of fin){
    const Y=sectionYs.find(v=>Math.abs(y-v)<2e-6);assert.notEqual(Y,undefined);
    near(Math.abs(x),laterSailKeelHalfWidth(d.id,z,Y),3e-5);
    assert.ok(z>=d.keel.bounds[0]-1e-5&&z<=d.keel.bounds[1]+1e-5);
  }
  assert.ok(new Set(fin.map(p=>Math.round(p[2]*1000))).size>40,'fin is not a rectangular extrusion');
  const c=asset('flying-cloud'),skin=new Set(points(c.parts.get('hull.planking')).map(key));
  for(const side of ['port','starboard'])assert.ok(points(c.parts.get('hull.wales.'+side)).filter(p=>skin.has(key(p))).length>100,'wale return edges meet real loft vertices');
});

test('stair landing geometry shares exactly the route endpoints and open cockpit has no main-deck cap',()=>{
  for(const d of Object.values(LATER_SAIL_DESIGNS)){
    const a=asset(d.id),sx=d.runtime.beam/d.frame.beam;
    for(const f of laterSailStairFlights(d.id)){
      const q=points(a.parts.get('deck.stairs.'+f.id));
      for(const [z,y]of [[f.z0,f.y0],[f.z1,f.y1]])for(const side of [-1,1]){
        const wanted=[f.x+side*(f.width/2+.035/sx),y,z];assert.ok(q.some(p=>p.every((v,i)=>Math.abs(v-wanted[i])<2e-6)),'rail post lands on the same actual deck as the route');
      }
    }
    if(d.cockpit){
      const mesh=a.parts.get('deck.main.planks'),c=d.cockpit;
      for(let at=0;at<mesh.length;at+=27){const x=(mesh[at]+mesh[at+9]+mesh[at+18])/3,z=(mesh[at+2]+mesh[at+11]+mesh[at+20])/3;assert.ok(!(Math.abs(x)<c.halfWidth-1e-5&&z>c.bounds[0]+1e-5&&z<c.bounds[1]-1e-5),'deck cannot close over the cockpit well');}
    }
  }
});

test('actual compact cloth/spar/steering vertices use authoritative poses and retain immutable hull/material bits',()=>{
  for(const d of Object.values(LATER_SAIL_DESIGNS)){
    const a=asset(d.id),pose=createLaterSailAssetPose(a),b=boat(d),target=new Float32Array(a.vertices),original=new Uint32Array(a.vertices.buffer).slice(),context=withRigPoseContext(laterSailRigContext(d.id),b.sailState),time=2.3,wind=9;
    assert.equal(pose(b,time,wind,target),true);const bits=new Uint32Array(target.buffer);
    let cloth=0,spars=0,wheel=0;
    for(let at=0;at<a.vertices.length;at+=9){
      const mat=a.vertices[at+6],kind=Math.floor(mat),code=Math.round((mat-kind)*64),dynamic=[7,9,10,12,13,14,18].includes(kind)||(kind===8&&code===1);
      for(let i=0;i<9;i++)if(!dynamic||i>=6)assert.equal(bits[at+i],original[at+i]);
      if((kind===9||kind===13)&&at%117===0){const s=d.surfaces.find(s=>s.id===code);vectorNear(target.subarray(at,at+3),surfaceClothPoint(s,a.vertices[at+7],a.vertices[at+8],rigSurfacePose(s,b.sailState),context,time,wind));cloth++;}
      if(kind===10&&at%153===0){const s=d.surfaces.find(s=>s.id===code);vectorNear(target.subarray(at,at+3),surfaceYardPoint(s,Array.from(a.vertices.subarray(at,at+3)),rigSurfacePose(s,b.sailState)));spars++;}
      if(kind===8&&code===1&&at%27===0){const w=laterSailSteeringPose(b),p=Array.from(a.vertices.subarray(at,at+3)),q=p.map((v,i)=>v-w.wheel.centre[i]);vectorNear(target.subarray(at,at+3),w.wheel.centre.map((v,i)=>v+w.basis.reduce((sum,a,j)=>sum+a[i]*q[j],0)));wheel++;}
    }
    assert.ok(cloth>10&&spars>3);if(d.id==='flying-cloud')assert.ok(wheel>0);
    assert.ok(target.every(Number.isFinite));assert.deepEqual(new Uint32Array(a.vertices.buffer),original);
    assert.throws(()=>pose(b,0,0,new Float32Array(9)),/wrong shape/);
  }
});

test('per-instance poses are independent and sewn running rope rings stay centred on the actual cloth and lines',()=>{
  for(const d of Object.values(LATER_SAIL_DESIGNS)){
    const a=asset(d.id),pose=createLaterSailAssetPose(a),b=boat(d),other={...boat(d),rudder:-18,hatchesClosed:1,sailState:{...b.sailState,set:[.2,.9,.75],groupYaw:[-.3,.1,-.4]}},one=new Float32Array(a.vertices),two=new Float32Array(a.vertices);
    pose(b,2,12,one);const first=new Uint32Array(one.buffer).slice();pose(other,7,3,two);pose(b,2,12,one);assert.deepEqual(new Uint32Array(one.buffer),first);assert.notDeepEqual(new Uint32Array(two.buffer),first);
    const c=laterSailRigContext(d.id),runtime={...withRigPoseContext(c,b.sailState),time:2,wind:12},rings=new Map();
    for(let at=0;at<a.vertices.length;at+=9)if(Math.floor(a.vertices[at+6])===12&&a.vertices[at+7]>=100){
      const line=Math.round(a.vertices[at+7]-100),t=a.vertices[at+8],k=line+'/'+t;let r=rings.get(k);if(!r){r={line,t,points:new Map()};rings.set(k,r);}
      const p=Array.from(one.subarray(at,at+3));r.points.set(p.map(v=>Math.round(v*1e6)).join('/'),p);
    }
    let checked=0;
    for(const r of rings.values())if(r.points.size===4&&c.lines[r.line].kind==='bolt-rope'){
      const sum=[0,0,0];for(const p of r.points.values())for(let j=0;j<3;j++)sum[j]+=p[j];
      vectorNear(sum.map(v=>v/4),surfaceRopePoint(c.lines[r.line],r.t,runtime),5e-5);checked++;
    }
    assert.ok(checked>20,'real sewn rings have four balanced unique vertices');
  }
});

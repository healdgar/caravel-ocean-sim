// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Proposed integration checks. Root alone executes validation after combining
// the physics/model/crew worktrees; definition readiness remains root-gated.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {LATER_SAIL_DESIGNS,laterSailDesign,laterSailDeck,laterSailStairFlights} from '../js/models/later-sail.js';
import {ROWING_DESIGNS} from '../js/models/rowing.js';
import {surfaceControlIndex,rigSurfacePose,surfaceClothPoint,surfaceYardPoint,surfaceRopePoint} from '../js/rig-surface.js';
import {proceduralRigContext,laterSailRigContext,laterSailSteeringPose} from '../js/additional-rig.js';
import {createProceduralShipDefinition,resolveProceduralShipNode,proceduralShipNodeTransform} from '../js/procedural-models.js';
import {rowingStationPose,rowingSteeringPose} from '../js/rowing.js';
import {validateRigDefinition} from '../js/rig-definition.js';

const near=(a,b,e=1e-8)=>{assert.equal(a.length,b.length);for(let i=0;i<a.length;i++)assert.ok(Math.abs(a[i]-b[i])<=e,`${a} != ${b}`);};
const subtract=(a,b)=>a.map((v,i)=>v-b[i]);
const boat=d=>({modelId:d.id,...d.runtime,rudder:17,hatchesClosed:.35,sailState:{set:[.15,.72,.41],groupYaw:[.4,-.25,.65],windSide:4,windForward:-5,
  rig:[{fill:.2,side:-1},{fill:.85,side:1},{fill:.6,side:-1}]},rowingState:{phase:.22,rate:.45,effortPort:1,effortStarboard:.7}});

test('physical main mast zero never consumes fore control; ketch booms remain independently controlled',()=>{
  for(const d of [laterSailDesign('gipsy-moth-iv'),ROWING_DESIGNS.oseberg,ROWING_DESIGNS.lusoria]){
    const b=boat(d),snapshot=JSON.stringify(b);
    for(const surface of d.surfaces){
      const index=surfaceControlIndex(surface),p=rigSurfacePose(surface,b.sailState);
      assert.equal(p.deployed,b.sailState.set[index]);assert.equal(p.fill,b.sailState.rig[index].fill);
      assert.equal(p.yaw,b.sailState.groupYaw[index]);
    }
    assert.equal(JSON.stringify(b),snapshot);
  }
  const d=laterSailDesign('gipsy-moth-iv'),b=boat(d),main=d.surfaces.find(s=>s.kind==='bermudan'&&s.controlGroup==='main'),mizzen=d.surfaces.find(s=>s.kind==='bermudan'&&s.controlGroup==='mizzen');
  const before=surfaceYardPoint(mizzen,mizzen.spars[0].b,rigSurfacePose(mizzen,b.sailState));
  b.sailState.groupYaw[1]=.9;b.sailState.set[1]=.05;
  near(surfaceYardPoint(mizzen,mizzen.spars[0].b,rigSurfacePose(mizzen,b.sailState)),before);
  assert.equal(surfaceControlIndex(main),1);assert.equal(main.mast,0);
  assert.throws(()=>surfaceControlIndex({...main,controlGroup:'phantom'}),/Unknown surface control/);
});

test('Bermudan luffs stay on their actual track, feet on independent booms and lowering gathers toward the foot',()=>{
  const d=laterSailDesign('gipsy-moth-iv'),context=laterSailRigContext(d.id),b=boat(d);
  for(const s of d.surfaces.filter(s=>s.kind==='bermudan'))for(const yaw of [-.8,0,.8]){
    const full={...rigSurfacePose(s,b.sailState),yaw,deployed:1},furled={...full,deployed:0};
    for(const u of [0,.2,.7,1]){
      const on=s.corners[0].map((v,i)=>v+(s.corners[1][i]-v)*u);
      near(surfaceClothPoint(s,u,0,full,context,4,18),on);
    }
    for(const deployed of [0,.2,1])for(const v of [0,.3,1])near(surfaceClothPoint(s,0,v,{...full,deployed},context,4,18),surfaceYardPoint(s,s.corners[0].map((x,i)=>x+(s.corners[2][i]-x)*v),full));
    const head=surfaceClothPoint(s,1,0,furled,context,4,18);
    assert.ok(Math.hypot(...subtract(head,s.corners[0]))<.15,'lowered sail does not retain a full-height luff');
    const m=context.masts[s.mast],luff=s.corners[0],at=context.mastPoint(s.mast,luff[1]);
    assert.ok(luff[2]>at[2],'mast-track luff is behind the mast centre, not embedded in the spar');
    assert.equal(m.climbable,false);
  }
});

test('sewn bolt ropes follow the curved authoritative cloth rather than straight endpoint chords',()=>{
  for(const d of Object.values(LATER_SAIL_DESIGNS)){
    const c=laterSailRigContext(d.id),b=boat(d),runtime={...c,state:b.sailState,time:2.1,wind:13};
    const lines=c.lines.filter(l=>l.kind==='bolt-rope');assert.ok(lines.length>=d.surfaces.length*3);
    for(const line of lines)for(const t of [0,.37,1]){
      const s=d.surfaces.find(s=>s.id===line.surface),uv=line.clothEdge[0].map((v,i)=>v+(line.clothEdge[1][i]-v)*t);
      near(surfaceRopePoint(line,t,runtime),surfaceClothPoint(s,...uv,rigSurfacePose(s,b.sailState),c,runtime.time,runtime.wind));
    }
  }
});

test('new structure graphs contain only real masts, equipment and spars; absent roles fail explicitly',()=>{
  for(const d of [...Object.values(ROWING_DESIGNS),...Object.values(LATER_SAIL_DESIGNS)]){
    const model=createProceduralShipDefinition(d.id),b=boat(d),c=proceduralRigContext(d.id);
    assert.equal(model.status,'planned');assert.deepEqual(validateRigDefinition(model.rig,model.nodes),[]);
    assert.equal(model.rig.masts.length,d.masts.length);assert.equal(model.rig.sails.length,d.surfaces.length);
    for(const mast of model.rig.masts){assert.ok(model.nodes[mast.node]&&model.nodes[mast.headNode]);assert.equal(!!mast.climbNode,mast.climbable);}
    for(const s of model.rig.sails){
      if(['headsail','bermudan'].includes(s.kind))assert.equal(s.yardNode,undefined,'no fictitious yard on luff-borne canvas');
      for(const role of s.clewNodes)assert.ok(model.nodes[role]);
    }
    for(const group of new Set(d.surfaces.map(s=>s.controlGroup))){
      assert.ok(model.nodes['station.haul.'+group]);const fall=model.nodes['rig.'+group+'.fall'];assert.ok(fall);
      near(resolveProceduralShipNode(b,model,fall,{space:'design'}),c.controlStations[group].lead);
    }
    assert.throws(()=>resolveProceduralShipNode(b,model,'yard.phantom'),/Absent/);
    if(d.id==='taino-canoe')assert.equal(Object.keys(model.nodes).some(k=>k.startsWith('mast.')||k.startsWith('sail.')||k.startsWith('anchor.')||k.startsWith('hatch.')),false);
    if(d.id==='gipsy-moth-iv'){assert.equal(model.nodes['mast.fore'],undefined);assert.equal(model.nodes['helm.wheel'],undefined);assert.equal(model.nodes['mast.main.runner'],undefined);}
    if(d.id==='flying-cloud'){assert.ok(model.nodes['helm.wheel']);assert.equal(model.nodes['helm.tiller'],undefined);}
  }
});

test('cloth and spar affine frames derive from the same authoritative pose, with no animated-parent translation fiction',()=>{
  for(const d of Object.values(LATER_SAIL_DESIGNS)){
    const b=boat(d),model=createProceduralShipDefinition(d.id),c=laterSailRigContext(d.id),snapshot=JSON.stringify(b);
    for(const surface of model.rig.sails){
      const s=d.surfaces.find(s=>s.id===surface.surfaceId),options={time:3.4,wind:11,u:.21,v:.32},frame=proceduralShipNodeTransform(b,model,surface.sailNode,options),expected=surfaceClothPoint(s,.21,.32,rigSurfacePose(s,b.sailState),c,3.4,11);
      near(frame.position,expected);near(resolveProceduralShipNode(b,model,surface.sailNode,{...options,space:'design'}),expected);
      for(const role of surface.clewNodes){const node=model.nodes[role],q=proceduralShipNodeTransform(b,model,node,{time:3.4,wind:11});near(q.position,surfaceClothPoint(s,node.motion.u,node.motion.v,rigSurfacePose(s,b.sailState),c,3.4,11));}
      const role=surface.yardNode??surface.sparNode;if(role){const node=model.nodes[role],p=proceduralShipNodeTransform(b,model,node);near(p.position,surfaceYardPoint(s,node.motion.point,rigSurfacePose(s,b.sailState)));}
    }
    assert.equal(JSON.stringify(b),snapshot);
    const helm=laterSailSteeringPose(b);near(resolveProceduralShipNode(b,model,'helm.grip',{space:'design'}),helm.handle);
    if(helm.kind==='tiller'){
      const k=[b.beam/d.frame.beam,d.frame.verticalScale,b.length/d.frame.length];
      near([Math.hypot(...subtract(helm.grips[0],helm.grips[1]).map((v,i)=>v*k[i]))],[.14]);
      near(resolveProceduralShipNode(b,model,'helm.grip',{space:'design',along:-.09}),helm.grips[1]);
    }
    const h=model.nodes['hatch.grip'],a=resolveProceduralShipNode({...b,hatchesClosed:1},model,h,{space:'design'}),open=resolveProceduralShipNode({...b,hatchesClosed:0},model,h,{space:'design'});assert.ok(Math.hypot(...subtract(open,a))>.05);
  }
});

test('rowing hand/foot/blade attachments convert hull metres to design once and follow the real pose',()=>{
  for(const d of Object.values(ROWING_DESIGNS)){
    const b=boat(d),model=createProceduralShipDefinition(d.id),k=[b.beam/d.frame.beam,d.frame.verticalScale,b.length/d.frame.length];
    for(const station of [d.stations[0],d.stations.at(-1)]){
      const live=rowingStationPose(b,station.id),root='rowing.'+station.id;
      near(resolveProceduralShipNode(b,model,root+'.blade'),live.bladeCentre);
      for(let h=0;h<2;h++)near(resolveProceduralShipNode(b,model,root+'.grip.'+h),live.hands[h]);
      near(resolveProceduralShipNode(b,model,root+'.blade',{space:'design'}),live.bladeCentre.map((v,i)=>v/k[i]));
    }
    near(resolveProceduralShipNode(b,model,'helm.grip'),rowingSteeringPose(b).hands[0]);
  }
  const d=laterSailDesign('gipsy-moth-iv'),m=createProceduralShipDefinition(d.id),p=m.nodes['station.hatch'].position,cabin=d.structures[0],flight=laterSailStairFlights(d.id)[0];
  assert.ok(p[2]>cabin.centre[2]+cabin.size[2]/2&&p[2]<flight.z0);near([p[1]],[laterSailDeck(d.id,p[2],p[0])]);
});

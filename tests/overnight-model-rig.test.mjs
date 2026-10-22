// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Proposed integration checks. Root alone executes validation after combining
// the physics/model/crew worktrees; definition readiness remains root-gated.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {LATER_SAIL_DESIGNS,laterSailDesign,laterSailDeck,laterSailStairFlights} from '../js/models/later-sail.js';
import {ROWING_DESIGNS} from '../js/models/rowing.js';
import {surfaceControlIndex,rigSurfacePose,surfaceClothPoint,surfaceYardPoint,surfaceRopePoint,withRigPoseContext} from '../js/rig-surface.js';
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
    const c=laterSailRigContext(d.id),b=boat(d),runtime={...withRigPoseContext(c,b.sailState),time:2.1,wind:13};
    const lines=c.lines.filter(l=>l.kind==='bolt-rope');assert.ok(lines.length>=d.surfaces.length*3);
    for(const line of lines)for(const t of [0,.37,1]){
      const s=d.surfaces.find(s=>s.id===line.surface),uv=line.clothEdge[0].map((v,i)=>v+(line.clothEdge[1][i]-v)*t);
      near(surfaceRopePoint(line,t,runtime),surfaceClothPoint(s,...uv,rigSurfacePose(s,b.sailState),runtime,runtime.time,runtime.wind));
    }
  }
});

test('clipper canvas, load-bearing stays, visible end fittings and affine nodes share one tier-specific geometry',()=>{
  const d=laterSailDesign('flying-cloud'),context=laterSailRigContext(d.id),model=createProceduralShipDefinition(d.id),b=boat(d),stays=context.supports.filter(s=>s.kind==='sail-stay');
  assert.equal(stays.length,8);assert.equal(context.supports.some(s=>s.kind==='stay'),false,'no unrelated duplicate full-height forestay crosses the staysails');
  for(const surface of d.surfaces.filter(s=>s.kind==='headsail')){
    const stay=surface.stay;assert.equal(stays.find(s=>s.id===stay.id),stay);
    const rendered=context.lines.filter(line=>line.id===stay.id);assert.equal(rendered.length,1);assert.equal(rendered[0].static,true);
    near(rendered[0].a,stay.a);near(rendered[0].b,stay.b);assert.equal(rendered[0].r,stay.r);
    assert.equal(context.lines.some(l=>l.surface===surface.id&&l.kind==='luff-stay'),false,'no second shorter line floats beside the structural stay');
    near(surface.corners[0],stay.a);near(surface.corners[1],stay.a.map((v,i)=>v+(stay.b[i]-v)*stay.headParameter));
    for(const yaw of [-.67,0,.67])for(const deployed of [.1,1])for(const u of [0,.19,.63,1]){
      const state={...b.sailState,set:[deployed,deployed,deployed],groupYaw:[yaw,yaw,yaw]},pose=rigSurfacePose(surface,state),expected=surface.corners[0].map((v,i)=>v+(surface.corners[1][i]-v)*u);
      near(surfaceClothPoint(surface,u,0,pose,withRigPoseContext(context,state),3.7,24),expected);
    }
    const root='stay.'+surface.name;
    for(const [name,point]of [['lower',stay.a],['upper',stay.b],['head',surface.corners[1]]]){
      const frame=proceduralShipNodeTransform(b,model,root+'.'+name);near(frame.position,point);
      near(frame.basis[1],stay.b.map((v,i)=>(v-stay.a[i])/Math.hypot(...subtract(stay.b,stay.a))));
    }
    for(const [name,fitting]of [['lower',stay.lowerFitting],['upper',stay.upperFitting]]){
      near(fitting.position,name==='lower'?stay.a:stay.b);assert.ok(Math.hypot(...subtract(fitting.position,fitting.body))>0,'a finite metal tang bridges wood and the stay eye');
      assert.ok(model.rig.fittings.some(f=>f.id===fitting.id&&f.node===root+'.'+name));
    }
    const yard=d.surfaces.flatMap(s=>s.spars??[]).find(p=>p.id===stay.upperFitting.tier),higher=d.surfaces.filter(s=>s.kind==='square'&&s.mast===surface.mast).map(s=>s.spars[0]).filter(p=>p.a[1]>yard.a[1]).sort((a,b)=>a.a[1]-b.a[1])[0];
    assert.ok(stay.b[1]>yard.a[1]&&stay.b[1]<higher.a[1],'stay terminates at its actual named mast tier, not indiscriminately at the truck');
    const next=d.surfaces.find(s=>s.id===stay.upperFitting.nextSurface);
    assert.ok(next.mastTierGap);assert.ok(next.corners[2][1]-stay.b[1]>=stay.upperFitting.clothGap-1e-12,'the structural stay fitting occupies bare mast, never the next square tier canvas');
    assert.equal(next.corners[2][1],next.corners[3][1]);
    if(surface.name==='mizzen-topmast-staysail'){
      const spencer=d.surfaces.find(s=>s.name==='main-spencer');
      assert.equal(stay.lowerFitting.kind,'deck-eye');assert.equal(stay.lowerFitting.mast,undefined);
      assert.ok(stay.a[2]>Math.max(...spencer.corners.map(p=>p[2])),'the mizzen stay cannot start inside the main-spencer sewn luff');
      near([stay.lowerFitting.body[1]],[laterSailDeck(d.id,stay.a[2])]);
    }else if(surface.mast>0){assert.equal(stay.lowerFitting.mast,surface.mast-1);assert.equal(stay.lowerFitting.kind,'mast-aft-tang');}
    else assert.equal(stay.lowerFitting.kind,'bowsprit-collar');
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

test('upper clipper working staysail feet and leeches remain ahead of their actual lower structural stays',()=>{
  const d=laterSailDesign('flying-cloud'),working=d.surfaces.filter(s=>s.workingFoot?.kind==='non-overlapping-staysails');
  assert.ok(working.some(s=>s.id===23),'the overlapping mizzen topgallant clew is corrected in model geometry');
  for(const surface of working){
    const a=surface.corners[0],head=surface.corners[1],clew=surface.corners[2],foot=surface.workingFoot;
    assert.ok(clew[2]<foot.originalClew[2]);assert.equal(clew[1],foot.originalClew[1]);
    assert.equal(surface.stay.a,a,'tack remains attached to the actual structural stay');
    for(const id of foot.lowerStays){
      const lower=d.surfaces.find(s=>s.stay?.id===id).stay,slope=(lower.b[2]-lower.a[2])/(lower.b[1]-lower.a[1]),reserve=(lower.r+foot.clearance+foot.camberReserve)*Math.sqrt(1+slope*slope);
      const low=Math.max(clew[1],lower.a[1]),high=Math.min(head[1],lower.b[1]);
      for(const y of [low,high]){
        const t=(y-clew[1])/(head[1]-clew[1]),z=clew[2]+(head[2]-clew[2])*t,stayZ=lower.a[2]+slope*(y-lower.a[1]);
        assert.ok(z<=stayZ-reserve+1e-12,`${surface.name} actual leech threads ${id}`);
      }
    }
  }
});

test('lowest clipper working staysails retain forward clews instead of overlapping their carrying course yards',()=>{
  const d=laterSailDesign('flying-cloud'),context=laterSailRigContext(d.id),working=d.surfaces.filter(s=>s.workingFoot?.kind==='non-overlapping-course-clearance');
  assert.deepEqual(working.map(s=>s.id),[16,19,22]);
  for(const surface of working){
    const clew=surface.corners[2],at=context.mastPoint(surface.mast,clew[1]);
    assert.ok(clew[2]<at[2]&&clew[2]<surface.workingFoot.originalClew[2]);
    assert.ok(clew[2]>surface.corners[0][2],'working forward cloth retains a finite foot and actual tack attachment');
    assert.equal(clew[1],surface.workingFoot.originalClew[1]);
  }
});

test('cloth and spar affine frames derive from the same authoritative pose, with no animated-parent translation fiction',()=>{
  for(const d of Object.values(LATER_SAIL_DESIGNS)){
    const b=boat(d),model=createProceduralShipDefinition(d.id),c=withRigPoseContext(laterSailRigContext(d.id),b.sailState),snapshot=JSON.stringify(b);
    for(const surface of model.rig.sails){
      const s=d.surfaces.find(s=>s.id===surface.surfaceId),options={time:3.4,wind:11,u:.21,v:.32},frame=proceduralShipNodeTransform(b,model,surface.sailNode,options),expected=surfaceClothPoint(s,.21,.32,rigSurfacePose(s,b.sailState),c,3.4,11);
      near(frame.position,expected);near(resolveProceduralShipNode(b,model,surface.sailNode,{...options,space:'design'}),expected);
      for(const role of surface.clewNodes){const node=model.nodes[role],q=proceduralShipNodeTransform(b,model,node,{time:3.4,wind:11});near(q.position,surfaceClothPoint(s,node.motion.u,node.motion.v,rigSurfacePose(s,b.sailState),c,3.4,11));}
      const role=surface.yardNode??surface.sparNode;if(role){const node=model.nodes[role],p=proceduralShipNodeTransform(b,model,node);near(p.position,surfaceYardPoint(s,node.motion.point,rigSurfacePose(s,b.sailState)));}
      if(surface.yardNode){
        const spar=s.spars.find(p=>p.kind==='yard'),centre=spar.a.map((v,i)=>(v+spar.b[i])*.5);
        near(resolveProceduralShipNode(b,model,surface.yardNode,{space:'design'}),surfaceYardPoint(s,centre,rigSurfacePose(s,b.sailState)));
        near(resolveProceduralShipNode(b,model,surface.yardNode,{space:'design'}),resolveProceduralShipNode(b,model,'spar.'+spar.id,{space:'design'}));
      }
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
  const cabinGap=(p[2]-cabin.centre[2]-cabin.size[2]/2)*d.frame.verticalScale,stairGap=(flight.z0-p[2])*d.frame.verticalScale;
  assert.ok(cabinGap>=.28-1e-9&&cabinGap<=.30+1e-9,'standing hatch station stays outside the cabin wall/navigation margin without exceeding the real arm reach');
  assert.ok(stairGap>=.20-1e-9,'standing worker stays ahead of the cockpit descent');near([p[1]],[laterSailDeck(d.id,p[2],p[0])]);
});

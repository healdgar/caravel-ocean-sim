// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ADDITIONAL_DESIGNS,additionalDeck,additionalDeckWidth} from '../js/models/additional.js';
import {additionalRigContext} from '../js/additional-rig.js';
import {requirePlayableShipModel,resolveShipNode} from '../js/ship-models.js';
import {validateRigDefinition} from '../js/rig-definition.js';
import {getShipParts,resolveShipTransform} from '../js/ship-parts.js';
import {surfaceClothPoint,surfaceYardPoint,surfaceRopePoint,rigSurfacePose} from '../js/rig-surface.js';
import {createAdditionalShipMesh,createAdditionalAssetPose} from '../js/additional-ships.js';
import {boatRotate} from '../js/boat.js';

const close=(a,b,t=1e-9)=>{assert.equal(a.length,b.length);for(let i=0;i<a.length;i++)assert.ok(Math.abs(a[i]-b[i])<t,`${a} != ${b}`);};
const sub=(a,b)=>a.map((v,i)=>v-b[i]),add=(a,b)=>a.map((v,i)=>v+b[i]);
function ship(id){const d=ADDITIONAL_DESIGNS[id];return {modelId:id,...d.runtime,rudder:24,heading:38,pitch:.06,roll:-.11,heave:.5,x:18,z:-25,hatchesClosed:.35,
  sailState:{set:[.8,.6,.7],squareYaw:.32,lateenYaw:-.4,windSide:5,windForward:-4,rig:[0,1,2].map(i=>({side:i===2?-1:1,opening:.5,dip:i===2?.45:0,deployed:.7,fill:.8,pressure:1}))}};}

test('development mixed-rig registry contains each actual surface and complete model-owned attachment roles',()=>{
  for(const [id,count,code]of [['pinta',3,2],['santa-maria',5,3]]){
    const d=ADDITIONAL_DESIGNS[id],m=requirePlayableShipModel(id),b=ship(id),parts=getShipParts(id);
    assert.equal(m.status,'ready');assert.equal(m.development,true);assert.equal(m.modelCode,code);assert.equal(m.gpuPose,true);
    assert.equal(m.geometry,'additional-procedural-v1');assert.equal(m.rig.backend,'surfaces-v1');assert.equal(m.rig.sails.length,count);
    assert.deepEqual(validateRigDefinition(m.rig,m.nodes),[]);assert.equal(m.capabilities.yardTransfer,true);
    assert.deepEqual(parts.decks.zones.map(z=>z.id),d.deckZones.map(z=>z.id));assert.equal(parts.loading.manifest.crew,d.loading.crew);
    assert.equal(parts.crew.representedCount,12);assert.equal(parts.crew.representativeWatch,true);assert.equal(parts.steering.wheel,null);
    assert.equal(parts.rig.controlGroups.flatMap(g=>g.surfaceIDs).length,count);
    for(const role of ['helm.tiller','helm.rudder','helm.grip','helm.camera','hatch.main','station.hatch',...d.deckZones.map(z=>'deck.'+z.id),...Object.keys(d.crewStations).map(n=>'station.crew.'+n)]){
      assert.ok(m.nodes[role],`${id} missing ${role}`);assert.ok(resolveShipNode(b,role).every(Number.isFinite));
    }
    for(const mast of d.masts)for(const role of [`mast.${mast.id}`,`mast.${mast.id}.head`,`mast.${mast.id}.runner`,`station.haul.${mast.id}`,`rig.${mast.id}.fall`,`yard.${mast.id}`,`sail.${mast.id}`])assert.ok(m.nodes[role],role);
    for(const sail of m.rig.sails){assert.ok(m.nodes[sail.sailNode]);for(const clew of sail.clewNodes)assert.ok(m.nodes[clew]);}
    assert.equal(m.rig.sails.filter(s=>s.controlGroup==='main').length,id==='pinta'?1:2);
    for(const side of ['port','starboard'])for(const end of ['root','tip','fairlead'])assert.ok(m.nodes[`anchor.${side}.${end}`]);
    assert.throws(()=>resolveShipTransform(b,'helm.wheel'),/Absent/);assert.throws(()=>resolveShipNode(b,'sail.unknown'),/Unknown/);
  }
  assert.throws(()=>requirePlayableShipModel('future-model'),/Unknown/);
  assert.ok(requirePlayableShipModel('santa-maria').nodes['lookout.fore']);
  assert.equal(requirePlayableShipModel('pinta').nodes['lookout.fore'],undefined);
});

test('yard, cloth and rope nodes use the complete authoritative mixed-rig pose, including active transfer',()=>{
  for(const id of ['pinta','santa-maria']){
    const b=ship(id),d=ADDITIONAL_DESIGNS[id],m=requirePlayableShipModel(id),ctx=additionalRigContext(id),snapshot=JSON.stringify(b);
    for(const side of [-1,0,1])for(const dip of [0,.6,1]){
      Object.assign(b.sailState.rig[2],{side,dip});
      for(const surface of d.surfaces){
        const s=m.rig.sails.find(s=>s.surfaceId===surface.id),pose=rigSurfacePose(surface,b.sailState),opts={space:'design',time:1.9,wind:12};
        const yard=resolveShipTransform(b,s.yardNode,opts),expected=surfaceYardPoint(surface,surface.pivot,pose);close(yard.position,expected);
        for(const [i,e]of [[1,0,0],[0,1,0],[0,0,1]].entries())close(yard.basis[i],sub(surfaceYardPoint(surface,add(surface.pivot,e),pose),expected));
        for(const role of s.clewNodes){const node=m.nodes[role],p=surfaceClothPoint(surface,node.motion.u,node.motion.v,pose,ctx,opts.time,opts.wind);close(resolveShipNode(b,role,opts),p);close(resolveShipTransform(b,role,opts).position,p);}
        const cloth=resolveShipTransform(b,s.sailNode,{...opts,u:.23,v:.31});close(cloth.position,surfaceClothPoint(surface,.23,.31,pose,ctx,opts.time,opts.wind));
        const a=cloth.basis[0],c=cloth.basis[1],n=cloth.basis[2],dot=p=>p.reduce((sum,v,i)=>sum+v*n[i],0);assert.ok(Math.abs(dot(a))<1e-8&&Math.abs(dot(c))<1e-8);
      }
    }
    // Queries never advance simulation. Restore only the explicit test mutations.
    Object.assign(b.sailState,JSON.parse(snapshot).sailState);assert.equal(JSON.stringify(b),snapshot);
    for(const [i,mast]of d.masts.entries()){
      const role='rig.'+mast.id+'.fall',line=ctx.lines.find(l=>l.kind==='working-fall'&&l.mast===i);assert.ok(line);
      close(resolveShipNode(b,role,{space:'design'}),surfaceRopePoint(line,1,{...ctx,state:b.sailState}));
      const t=.6,height=line.a[1]+(line.b[1]-line.a[1])*t;
      close(resolveShipNode(b,role,{space:'design',height}),surfaceRopePoint(line,t,{...ctx,state:b.sailState}));
    }
  }
});

test('anchor, mast and hatch nodes meet their builder-owned endpoints; camera stays inboard and above deck',()=>{
  for(const id of ['pinta','santa-maria']){
    const b=ship(id),d=ADDITIONAL_DESIGNS[id],ctx=additionalRigContext(id),scale=[b.beam/3.6,d.frame.verticalScale,b.length/12];
    for(const [i,mast]of d.masts.entries()){
      close(resolveShipNode(b,'mast.'+mast.id,{space:'design'}),ctx.masts[i].foot);
      close(resolveShipNode(b,'mast.'+mast.id+'.head',{space:'design'}),ctx.masts[i].head);
      assert.ok(getShipParts(id).roles['mast.'+mast.id+'.runner']);
    }
    for(const side of [-1,1])for(const [end,p]of Object.entries(ctx.anchorCathead(side)))close(resolveShipNode(b,`anchor.${side<0?'port':'starboard'}.${end}`,{space:'design'}),p);
    const h=d.hatch;close(resolveShipTransform(b,'hatch.main',{space:'design'}).position,[h.centre[0],h.centre[1],h.centre[2]-h.size[2]/2]);
    const camera=resolveShipNode(b,'helm.camera',{space:'design'});assert.ok(Math.abs(camera[0])+.10<additionalDeckWidth(id,camera[2]));
    assert.ok((camera[1]-additionalDeck(id,camera[2]))*d.frame.verticalScale>=1.59);
    const local=resolveShipTransform(b,'yard.main'),world=resolveShipTransform(b,'yard.main',{space:'world'}),expected=[0,0,0];
    boatRotate(expected,...local.position,b.heading*Math.PI/180,b.pitch,b.roll);close(world.position,add(expected,[b.x,b.heave,b.z]));
    close(local.position,resolveShipNode(b,'yard.main',{space:'design'}).map((v,i)=>v*scale[i]));
  }
});

test('actual posed sail mesh vertices and free-clew nodes share positions, including shortened canvas',()=>{
  for(const id of ['pinta','santa-maria']){
    const groups=[],vertices=createAdditionalShipMesh(id,{groups}),asset={modelId:id,vertices},pose=createAdditionalAssetPose(asset),posed=new Float32Array(vertices),b=ship(id),m=requirePlayableShipModel(id);
    pose(b,2.4,10,posed);
    for(const s of m.rig.sails){
      const g=groups.find(g=>g.id===s.sailNode);assert.ok(g,`${id} missing actual cloth mesh group`);
      for(const role of s.clewNodes){
        const node=m.nodes[role],uv=[node.motion.u,node.motion.v];let at=-1;
        for(let i=g.firstVertex;i<g.firstVertex+g.vertexCount;i++)if(Math.abs(vertices[i*9+7]-uv[0])<1e-7&&Math.abs(vertices[i*9+8]-uv[1])<1e-7){at=i*9;break;}
        assert.ok(at>=0,'free clew must be a real cloth vertex');close(Array.from(posed.subarray(at,at+3)),resolveShipNode(b,role,{space:'design',time:2.4,wind:10}),2e-5);
      }
    }
  }
});

test('surfaces-v1 validation rejects missing nodes and duplicate surface IDs, without imposing one sail per mast',()=>{
  const model=requirePlayableShipModel('santa-maria'),rig=structuredClone(model.rig);
  assert.deepEqual(validateRigDefinition(rig,model.nodes),[]);rig.sails[1].surfaceId=rig.sails[0].surfaceId;
  assert.ok(validateRigDefinition(rig,model.nodes).some(e=>/duplicate authored surface/.test(e)));
  rig.sails[1].surfaceId=2;rig.sails[0].yardNode='missing';assert.ok(validateRigDefinition(rig,model.nodes).some(e=>/unknown node/.test(e)));
  assert.deepEqual(validateRigDefinition({id:'future-rowing-frame',backend:'surfaces-v1',masts:[],sails:[],fittings:[]},{hull:{id:'hull',position:[0,0,0],parent:null,kind:'frame'}}),[]);
});

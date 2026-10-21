// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {test} from 'node:test';
import {readGLB,createSkinAnimator,gltfQuatMultiply} from '../js/gltf.js';
import {createCompany,stepCompany} from '../js/crew.js';
import {stepCrewWork,crewGunStation} from '../js/crew-work.js';
import {poseCrewWork} from '../js/crew-pose.js';
import {getShipModel,resolveShipNode} from '../js/ship-models.js';
import {createGunDefinitions} from '../js/gunnery-models.js';
import {createShipGunnery} from '../js/gunnery-control.js';
import {sailingState} from '../js/sailing.js';

const assets=['sailor.glb','sailor-female.glb'].map(file=>readGLB(fs.readFileSync(new URL('../assets/crew/'+file,import.meta.url))));
const rawBytes=array=>new Uint8Array(array.buffer,array.byteOffset,array.byteLength);
function samePose(actual,expected,label){
  assert.deepEqual(rawBytes(actual.palette),rawBytes(expected.palette),label+' skin palette bytes');
  for(let i=0;i<actual.world.length;i++)assert.deepEqual(rawBytes(actual.world[i]),rawBytes(expected.world[i]),label+' world node '+i);
}
// One translation read per TRS evaluation, without production timing counters.
// During isolated matrix refreshes this counts the actual visited node set.
function countTransforms(animator){
  let count=0;
  for(const pose of animator.pose){const translation=pose.t;Object.defineProperty(pose,'t',{get(){count++;return translation;}});}
  return {get count(){return count;},reset(){count=0;}};
}
function descendant(animator,node,root){
  for(let at=node;at>=0;at=animator.parent[at])if(at===root)return true;
  return false;
}
function ship(id){return {modelId:id,...getShipModel(id).runtime,heading:24,x:0,z:0,heave:0,roll:0,rollVelocity:0,rudder:0,sailFore:1,sailMain:1,sailMizzen:1};}
function cloneActor(actor){return {...actor,position:actor.position.slice(),scale:actor.scale.slice(),rotation:actor.rotation.slice(),transform:actor.transform.slice(),observation:{...actor.observation},job:actor.job?{...actor.job}:null,grips:null};}

test('branch refresh preserves every world/palette byte while visiting only dependent nodes',()=>{
  for(const asset of assets){
    const actual=createSkinAnimator(asset),expected=createSkinAnimator(asset),actualWork=countTransforms(actual),expectedWork=countTransforms(expected);
    for(const name of ['upperarm_l','lowerarm_r','thigh_l','calf_r','hand_l']){
      const node=actual.nodeIndex(name);assert.equal(node,actual.names.indexOf(name));assert.ok(node>=0);
      actual.sample('Idle',.37,'Walk',1.2,.4);expected.sample('Idle',.37,'Walk',1.2,.4);
      const before=actual.world.map(matrix=>matrix.slice());
      for(const animator of [actual,expected]){
        const pose=animator.pose[node];gltfQuatMultiply(pose.r,[Math.sin(.07),0,0,Math.cos(.07)],pose.r);
        pose.t[1]+=.017;for(let k=0;k<3;k++)pose.s[k]*=1.003;
      }
      actualWork.reset();expectedWork.reset();
      assert.equal(actual.updateBranch(node),actual.palette);assert.equal(expected.update(),expected.palette);
      const affected=actual.order.filter(i=>descendant(actual,i,node));
      assert.equal(actualWork.count,affected.length);assert.equal(expectedWork.count,expected.order.length);
      assert.ok(actualWork.count<expectedWork.count,name+' must omit unrelated transforms');
      samePose(actual,expected,name);
      for(const i of actual.order)if(!descendant(actual,i,node))assert.deepEqual(rawBytes(actual.world[i]),rawBytes(before[i]),'unaffected branch '+i);
    }
    assert.equal(actual.nodeIndex('missing-bone'),-1);
    for(const invalid of [-1,1.5,actual.world.length])assert.throws(()=>actual.updateBranch(invalid),/Invalid animation branch/);
    // The original full-update API still observes unrelated direct pose edits.
    for(const animator of [actual,expected]){animator.pose[0].t[0]+=.12;animator.pose[animator.nodeIndex('hand_r')].t[2]-=.03;animator.update();}
    samePose(actual,expected,'full public update');
  }
});

test('real crew rigs retain bit-identical climbing, helm, hauling, hatch and gunnery IK',()=>{
  let cases=0,optimizedReads=0,referenceReads=0;
  for(const id of ['nina','victory']){
    const boat=ship(id),company=createCompany(undefined,id);sailingState(boat);stepCompany(company,boat,0,8);
    const scenarios=[];
    for(const rudder of [-30,0,30])scenarios.push({label:'helm '+rudder,actor:cloneActor(company.crew.find(s=>s.role==='Helmsman')),rudder});
    for(const side of [-1,1])for(const rung of [.5,4.25,9.7]){
      const actor=cloneActor(company.crew.find(s=>s.id==='beatriz'));
      actor.job={kind:'rig',mast:0,side,stage:'ascending',rung,elapsed:0};actor.intent='work';
      stepCrewWork(actor,company,boat,0);
      scenarios.push({label:'climb '+side+'/'+rung,actor,rudder:0});
    }
    for(const kind of ['haul','hatch']){
      const actor=cloneActor(company.crew.find(s=>s.id=== (kind==='haul'?'joao':'rui')));
      const position=resolveShipNode(boat,kind==='haul'?'station.haul.main':'station.hatch',{space:'design'});
      actor.job={kind,mast:1,stage:'working',rung:0,elapsed:0,position,path:[position],cursor:0};actor.intent='work';
      boat.sailMain=.5;stepCrewWork(actor,company,boat,0);boat.sailMain=1;
      assert.equal(actor.job.stage,'working');scenarios.push({label:kind,actor,rudder:0});
    }
    for(const role of ['loader','tackle'])for(const stage of ['swab','ram','runout','prime']){
      const gun={...createGunDefinitions(boat).find(g=>g.weatherDeck),stage,progress:.37,offset:.3};
      const actor=cloneActor(company.crew.find(s=>s.id==='duarte')),position=crewGunStation(gun,role,boat);
      actor.job={kind:'gunnery',gun,gunRole:role,stage:'working',rung:0,elapsed:0,position,path:[position],cursor:0};actor.intent='work';
      stepCrewWork(actor,company,boat,0);scenarios.push({label:'gun '+role+'/'+stage,actor,rudder:0});
    }
    for(const asset of assets){
      const actual=createSkinAnimator(asset),expected=createSkinAnimator(asset),actualWork=countTransforms(actual),expectedWork=countTransforms(expected);
      // Reference retains the former full-tree/full-palette refresh at every
      // bone turn and linear name lookup, with the same actual IK inputs.
      delete expected.updateBranch;delete expected.nodeIndex;
      for(const scenario of scenarios)for(const time of [.03,.73,2.4]){
        boat.rudder=scenario.rudder;
        const a=cloneActor(scenario.actor),b=cloneActor(scenario.actor);a.time=b.time=time;
        actual.sample('Idle',time,'Walk',time*.8,.23);expected.sample('Idle',time,'Walk',time*.8,.23);
        actualWork.reset();expectedWork.reset();poseCrewWork(actual,a,boat);poseCrewWork(expected,b,boat);
        samePose(actual,expected,id+' '+scenario.label+' '+time);assert.deepEqual(a.grips,b.grips);
        assert.ok(actualWork.count<=expectedWork.count,'optimization cannot add transform evaluation');
        optimizedReads+=actualWork.count;referenceReads+=expectedWork.count;cases++;
      }
    }
  }
  assert.ok(cases>=200,'representative posed state coverage');
  assert.ok(optimizedReads<referenceReads*.75,'omit substantial unrelated hierarchy work without altering a pose: '+optimizedReads+'/'+referenceReads);
});

test('reused gunnery stage snapshots preserve transition events and canonical gun identity',()=>{
  for(const id of ['nina','victory']){
    const boat=ship(id),events=[],controller=createShipGunnery(boat,{onEvent:event=>events.push(event)});
    boat.gunneryAttendance=new Set(controller.state.guns.map(gun=>gun.id));
    const gun=controller.state.guns.find(g=>g.weatherDeck);
    Object.assign(gun,{stage:'load',loading:true,elapsed:gun.durations.load-.01});
    controller.update(.05,[0,0,0]);
    assert.equal(gun.stage,'ram');assert.deepEqual(events.filter(e=>e.type==='load').map(e=>e.gun.id),[gun.id]);
    controller.state.guns.reverse();gun.elapsed=gun.durations.ram-.01;
    controller.update(.05,[0,0,0]);controller.update(.05,[0,0,0]);
    assert.equal(gun.stage,'runout');assert.deepEqual(events.filter(e=>e.type==='run-out').map(e=>e.gun.id),[gun.id]);
    assert.equal(events.filter(e=>e.type==='load').length,1,'stable stages cannot repeat a transition event');
  }
});

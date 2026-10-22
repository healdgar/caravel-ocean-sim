// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ADDITIONAL_DESIGNS,additionalDeck,additionalDeckWidth,additionalStairFlights} from '../js/models/additional.js';
import {additionalRigContext} from '../js/additional-rig.js';
import {createCompany,stepCompany,issueCaptainOrder} from '../js/crew.js';
import {additionalCrewRoute,crewRunnerMetrics,stepCrewWork} from '../js/crew-work.js';
import {sailingState,advanceSails} from '../js/sailing.js';
import {resolveShipNode,requirePlayableShipModel} from '../js/ship-models.js';

const close=(a,b,t=1e-6)=>assert.ok(Math.abs(a-b)<t,`${a} != ${b}`);
const distance=(a,b)=>Math.hypot(...a.map((v,i)=>v-b[i]));
function ship(id){return {modelId:id,...ADDITIONAL_DESIGNS[id].runtime,roll:0,pitch:0,rudder:0,rollVelocity:0,sailFore:1,sailMain:1,sailMizzen:1,crew:false,propulsion:'sail'};}

test('additional companies retain identities and own twelve safe station positions, decks and direct tillers',()=>{
  for(const id of ['pinta','santa-maria']){
    const b=ship(id),d=ADDITIONAL_DESIGNS[id],c=createCompany(undefined,id);sailingState(b);stepCompany(c,b,0,6);
    assert.equal(c.modelId,id);assert.equal(c.representativeWatch,true);assert.equal(c.crew.length,12);assert.equal(c.crew.filter(s=>s.sex==='female').length,6);
    for(const s of c.crew){
      assert.ok(s.position.every(Number.isFinite));assert.ok(s.transform.every(Number.isFinite));
      assert.ok(Math.abs(s.x)<additionalDeckWidth(id,s.z),`${id} ${s.id} stays inboard`);
      close(s.position[1],additionalDeck(id,s.z)*d.frame.verticalScale+.028);
      if(s.role!=='Helmsman')close(s.z,d.crewStations[s.id].z);
    }
    for(const mast of requirePlayableShipModel(id).rig.masts){
      const point=resolveShipNode(b,'station.haul.'+mast.id);
      for(const s of c.crew.filter(s=>!['duarte','joao','isabel','beatriz','catarina','rui'].includes(s.id)))assert.ok(distance(point,Array.from(s.position))>.54,`${id} ${mast.id} haul stance must clear standby ${s.id}`);
    }
    for(const rudder of [-35,-10,0,10,35]){
      b.rudder=rudder;stepCompany(c,b,0,6);const s=c.crew.find(p=>p.role==='Helmsman'),grip=resolveShipNode(b,'helm.grip');
      close(s.position[0],grip[0]);close(s.position[2]+.4,grip[2]);
      close(s.position[1],additionalDeck(id,s.z)*d.frame.verticalScale+.028);
      assert.ok(grip[1]-s.position[1]>.5&&grip[1]-s.position[1]<1.4,'real tiller grip is at reachable torso height');
    }
  }
});

test('crew routes meet both ends of every rendered stair flight and never skip raised-deck transitions',()=>{
  for(const id of ['pinta','santa-maria'])for(const side of [-1,1])for(const direction of [-1,1]){
    const b=ship(id),flights=additionalStairFlights(id).filter(f=>f.side===side),start=direction>0?-4.9:5.2,end=direction>0?5.2:-4.9;
    const target=[side*.35,additionalDeck(id,end),end],path=additionalCrewRoute({x:side*.45,z:start},target,b);
    assert.ok(path.length>20);assert.deepEqual(path.at(-1),target);
    for(const f of flights)for(const [z,y]of [[f.z0,f.y0],[f.z1,f.y1]])assert.ok(path.some(p=>Math.abs(p[0]-f.x)<1e-9&&Math.abs(p[1]-y)<1e-9&&Math.abs(p[2]-z)<1e-9),`${id} route meets ${f.id} landing`);
    for(let i=0;i<path.length;i++){
      const p=path[i];assert.ok(p.every(Number.isFinite));assert.ok(Math.abs(p[0])<additionalDeckWidth(id,p[2])+.01);
      if(i){const a=path[i-1];if(Math.abs(a[2]-p[2])<1e-9)close(a[1],p[1],1e-8);}
      const flight=flights.find(f=>p[2]>f.z0+1e-9&&p[2]<f.z1-1e-9);
      if(flight){close(p[0],flight.x);close(p[1],flight.y0+(flight.y1-flight.y0)*(p[2]-flight.z0)/(flight.z1-flight.z0));}
      else close(p[1],additionalDeck(id,p[2]),1e-8);
    }
    const across=additionalCrewRoute({x:side*.45,z:start},[-side*.35,additionalDeck(id,end),end],b);
    assert.ok(across.some(p=>p[2]===.75),'cross ship through a clear midships corridor');
  }
});

test('climbing nodes coincide with actual ratline spans and expose human rung pitch for each mast',()=>{
  for(const id of ['pinta','santa-maria'])for(let mast=0;mast<3;mast++)for(const side of [-1,1]){
    const b=ship(id),d=ADDITIONAL_DESIGNS[id],m=requirePlayableShipModel(id),metrics=crewRunnerMetrics(b,mast,side),role='mast.'+m.rig.masts[mast].id+'.runner';
    close(metrics.dy,.32,1e-9);assert.ok(metrics.rungs>5);assert.ok(metrics.lean>0&&Number.isFinite(metrics.yaw));
    const lines=additionalRigContext(id).lines.filter(l=>l.kind==='ratline'&&l.mast===mast&&l.side===side);
    for(const step of [0,2,Math.floor(metrics.rungs*.5),metrics.rungs]){
      const p=resolveShipNode(b,role,{space:'design',side,step}),near=lines.filter(l=>Math.abs(l.a[1]-p[1])<1e-8);
      assert.ok(near.some(l=>p[0]>=Math.min(l.a[0],l.b[0])-1e-8&&p[0]<=Math.max(l.a[0],l.b[0])+1e-8&&p[2]>=Math.min(l.a[2],l.b[2])-1e-8&&p[2]<=Math.max(l.a[2],l.b[2])+1e-8),'runner point lies on a rendered ratline');
      assert.ok(p[1]>additionalDeck(id,d.masts[mast].z));
    }
  }
});

test('crew physically operate all three mixed-rig groups and their own hatch, with continuous movement',()=>{
  for(const id of ['pinta','santa-maria']){
    const b=ship(id),c=createCompany(undefined,id),state=sailingState(b);stepCompany(c,b,0,8);assert.equal(issueCaptainOrder(c,b,'weather'),true);
    const climbed=new Set(),hauled=new Set();let secured=false,held=false;
    for(let tick=0;tick<2400;tick++){
      const before=c.crew.map(s=>Array.from(s.position));advanceSails(b,.1,8,.8);stepCompany(c,b,.1,8);
      for(const [i,s]of c.crew.entries()){
        assert.ok(distance(Array.from(s.position),before[i])<.20,`${id} ${s.id} moves continuously`);
        assert.ok(s.position.every(Number.isFinite));assert.ok(s.transform.every(Number.isFinite));
        if(s.job?.rung>0){climbed.add(s.job.mast);assert.ok(Math.abs(s.x)<1.9);}
        if(s.job?.kind==='haul'&&s.job.stage==='working')hauled.add(s.job.mast);
        if(s.job?.kind==='hatch'&&s.job.stage==='working')secured=true;
      }
      if(!held){const s=c.crew.find(s=>s.job?.stage==='ascending');if(s){const rung=s.job.rung,position=Array.from(s.position);stepCompany(c,{...b,roll:.6},.1,8);assert.equal(s.job.rung,rung);assert.deepEqual(Array.from(s.position),position);held=true;}}
      if(!c.pending&&!c.crew.some(s=>s.job)&&b.hatchesClosed===1)break;
    }
    assert.deepEqual([...climbed].sort(),[0,1],id+' reaches both rig work sites');assert.deepEqual([...hauled].sort(),[0,1,2],id+' reaches every working fall');assert.ok(secured&&held);
    assert.equal(b.hatchesClosed,1);assert.ok(state.set.every((v,i)=>Math.abs(v-[.2,.2,0][i])<.011));assert.ok(c.crew.every(s=>!s.job));
  }
});

test('Santa María lookout reaches the fore platform and returns over the runner after new orders',()=>{
  const id='santa-maria',b=ship(id),d=ADDITIONAL_DESIGNS[id],c=createCompany(undefined,id);sailingState(b);stepCompany(c,b,0,6);
  const lookout=c.crew.find(s=>s.id==='maria');let reached=false;
  for(let tick=0;tick<1400;tick++){stepCompany(c,b,.1,6);if(lookout.job?.lookoutAtStation){reached=true;break;}}
  assert.ok(reached,'lookout must use the actual foremast station');
  const p=resolveShipNode(b,'lookout.fore'),sy=d.frame.verticalScale;
  close(lookout.position[1],p[1]+.028);assert.ok(Math.abs(lookout.position[0]-p[0])<.34*b.beam/3.6);assert.equal(lookout.climbPitch,0);
  issueCaptainOrder(c,b,'reduced');let returning=false;
  for(let tick=0;tick<2400;tick++){
    const before=Array.from(lookout.position);advanceSails(b,.1,6,.8);stepCompany(c,b,.1,6);
    assert.ok(distance(Array.from(lookout.position),before)<.20,'lookout cannot teleport off her platform');returning||=lookout.job?.stage==='lookout-return';
    if(!lookout.job)break;
  }
  assert.ok(returning);assert.equal(lookout.job,null);close(lookout.position[1],additionalDeck(id,lookout.z)*sy+.028);
});

test('a return walker can pass a standby body when its next route waypoint is only four centimetres ahead',()=>{
  const id='pinta',b=ship(id),d=ADDITIONAL_DESIGNS[id],c=createCompany(undefined,id);sailingState(b);stepCompany(c,b,0,8);
  const s=c.crew.find(s=>s.id==='isabel'),sx=b.beam/3.6,sz=b.length/12,z=1.363928,targetZ=1.344545;
  s.x=1.12;s.z=z;s.home=[-.72,3.2];s.position.set([s.x*sx,additionalDeck(id,z)*d.frame.verticalScale+.028,z*sz]);
  const target=[s.home[0],additionalDeck(id,s.home[1]),s.home[1]],route=additionalCrewRoute(s,target,b);
  s.job={kind:'haul',mast:2,stage:'return',elapsed:0,rung:0,cursor:0,position:[s.x,additionalDeck(id,z),z],path:[[1.12,additionalDeck(id,targetZ),targetZ],...route.slice(2)]};
  s.intent='work';s.decisionIn=0;let passed=false;
  for(let tick=0;tick<1000&&s.job;tick++){
    const before=Array.from(s.position);stepCrewWork(s,c,b,.1);passed||=!!s.job?.passing;
    assert.ok(distance(Array.from(s.position),before)<.20);
    for(const other of c.crew.filter(o=>o!==s))assert.ok(distance(Array.from(s.position),Array.from(other.position))>=.54-1e-5,'the passing path cannot cross a standby body');
  }
  assert.ok(passed);assert.equal(s.job,null);close(s.x,s.home[0]);close(s.z,s.home[1]);
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {createCompany,stepCompany,issueCaptainOrder,companyStatus} from '../js/crew.js';
import {victoryCrewRoute,crewRunnerMetrics} from '../js/crew-work.js';
import {poseCrewWork} from '../js/crew-pose.js';
import {loadCrewGLB} from '../js/gltf.js';
import {advanceSails,sailingState} from '../js/sailing.js';
import {resolveShipNode,getShipModel} from '../js/ship-models.js';
import {modelDeck,modelDeckWidth,vesselVerticalScale} from '../js/hull.js';
import {VICTORY_DESIGN,VICTORY_MASTS,VICTORY_SAILS,victoryShroud} from '../js/models/victory.js';
import {victoryClothPoint,victoryPose} from '../js/victory-motion.js';
import {boatEyePosition,boatRotate} from '../js/boat.js';
import {victoryMastPoint} from '../js/models/victory.js';
import {crewMotionPolicy} from '../js/crew-motion.js';

const fixture=()=>({modelId:'victory',...VICTORY_DESIGN.runtime,roll:0,rollVelocity:0,sailFore:1,sailMain:1,sailMizzen:1});
const distance=(a,b)=>Math.hypot(...Array.from(a,(v,i)=>v-b[i]));
test('Victory uses a human-sized representative watch grounded on its own decks',()=>{
  const b=fixture(),c=createCompany(undefined,'victory');
  for(let i=0;i<120;i++)stepCompany(c,b,.1,2);
  assert.equal(c.crew.length,12);assert.equal(c.crew.filter(s=>s.sex==='female').length,6);
  assert.equal(c.representativeWatch,true);assert.match(companyStatus(c),/representing the watch/);
  for(const s of c.crew){
    assert.ok(s.visible&&s.transform.every(Number.isFinite));
    assert.ok(Math.abs(s.position[1]-modelDeck(b,s.z)*vesselVerticalScale(b)-.028)<2e-6,s.id+' feet on Victory deck');
    assert.ok(Math.abs(s.x)+.3/(b.beam/3.6)<modelDeckWidth(b,s.z));
    assert.ok(s.scale[0]>.9&&s.scale[0]<1.05,'larger hull must not enlarge people');
  }
  const before={revision:c.revision,order:c.order};assert.equal(issueCaptainOrder(c,b,'transfer'),false);
  assert.deepEqual({revision:c.revision,order:c.order},before,'a square-rigger has no lateen yard transfer');
});
test('Victory work routes use the mesh stair landings and safe outboard corridors',()=>{
  const b=fixture(),target=resolveShipNode(b,'station.hatch',{space:'design'}),route=victoryCrewRoute({x:.93,z:2.65},target,b);
  for(const z of [1.05,1.65])assert.ok(route.some(p=>Math.abs(p[0]-.9)<1e-8&&Math.abs(p[2]-z)<1e-8),'quarterdeck stair landing '+z);
  for(const p of route){assert.ok(p.every(Number.isFinite));assert.ok(Math.abs(p[0])<modelDeckWidth(b,p[2]));}
  const crossing=victoryCrewRoute({x:-.9,z:3.35},resolveShipNode(b,'station.haul.mizzen',{space:'design'}),b);
  assert.ok(crossing.some(p=>p[2]===2&&p[0]>0)&&crossing.some(p=>p[2]===2&&p[0]<0),'cross away from the wheel and fixed helmsman');
  assert.ok(crossing.every(p=>!(Math.abs(p[0])<.4&&p[2]>3.2&&p[2]<4.3)));
});
test('Victory runner nodes coincide with the rendered middle shrouds',()=>{
  const b=fixture();
  for(const [i,m]of VICTORY_MASTS.entries())for(const side of[-1,1]){
    const {root:expected,top}=victoryShroud(i,side,3);
    const id='mast.'+m.id+'.runner';
    assert.ok(distance(resolveShipNode(b,id,{space:'design',side,step:0}),expected)<1e-7,m.id+' lower shroud');
    assert.ok(distance(resolveShipNode(b,id,{space:'design',side,step:29}),top)<1e-7,m.id+' upper shroud');
    assert.equal(crewRunnerMetrics(b,i,side).rungs,29);
  }
});
test('Victory clew attachments follow the posed cloth through bracing and reduced canvas',()=>{
  const b=fixture(),state=sailingState(b),model=getShipModel('victory');let samples=0;
  for(const [yaw,set]of[[-.8,.2],[0,.7],[.8,1]]){
    state.squareYaw=yaw;state.lateenYaw=-yaw*.7;state.set.fill(set);state.windSide=5;state.windForward=-8;
    for(const pose of state.rig)pose.fill=.7;
    for(const sail of VICTORY_SAILS){
      const rig=model.rig.sails.find(s=>s.id===sail.name);
      for(const node of rig.clewNodes){
        const u=sail.kind==='headsail'?0:node.endsWith('.port')?0:1;
        const expected=victoryClothPoint(sail.id,u,1,victoryPose(sail,state),2,8);
        assert.ok(distance(resolveShipNode(b,node,{space:'design',time:2,wind:8}),expected)<1e-9,node+' stays on cloth');samples++;
      }
    }
  }
  assert.ok(samples>=60);
});
test('Victory workers climb safely, shorten all sail groups, secure the hatch and return continuously',()=>{
  const b={...fixture(),crew:false},c=createCompany(undefined,'victory');stepCompany(c,b,0,8);issueCaptainOrder(c,b,'weather');
  const actors=Object.fromEntries([['female','sailor-female.glb'],['male','sailor.glb']].map(([sex,path])=>[sex,loadCrewGLB(fs.readFileSync(new URL('../assets/crew/'+path,import.meta.url))).animator]));
  let ascending=0,working=0,foretop=0,maxGripError=0,maxHaulGripError=0;
  for(let i=0;i<6000;i++){
    const previous=c.crew.map(s=>[...s.position]),climbs=c.crew.map(s=>s.job&&({stage:s.job.stage,rung:s.job.rung,mast:s.job.mast,side:s.job.side}));
    advanceSails(b,.1,8,0);stepCompany(c,b,.1,8);
    for(const [k,s]of c.crew.entries()){
      const pace=crewMotionPolicy(b,{purpose:'work'}).speedMetresPerSecond;
      assert.ok(pace<=1.4,'work pace has a physical human cap');
      assert.ok(distance(s.position,previous[k])<=pace*.1+2e-5,s.id+' continuous travel');
      assert.ok(s.transform.every(Number.isFinite));
      for(let n=0;n<k;n++)assert.ok(distance(s.position,c.crew[n].position)>.5,s.id+' body separation');
      if(s.job?.stage==='ascending')ascending++;
      if(climbs[k]&&['ascending','descending'].includes(climbs[k].stage)&&s.job?.stage===climbs[k].stage&&s.job.mast===climbs[k].mast){
        const dy=crewRunnerMetrics(b,s.job.mast,s.job.side).dy;
        assert.ok(Math.abs(s.job.rung-climbs[k].rung)*dy<=.38*.1+1e-9,'faster deck pace cannot accelerate vertical climbing');
      }
      if(s.job?.stage==='working')working++;
      if(s.job?.mast===0&&s.job.kind==='rig'&&s.job.stage==='working'){
        foretop++;assert.ok(s.position[1]+1.65<VICTORY_MASTS[0].platform*vesselVerticalScale(b),'head remains below the solid fighting top');
      }
      if(s.job?.rung>0&&i%17===0){
        const a=actors[s.sex];
        a.sample('Idle',s.time);poseCrewWork(a,s,b);assert.ok(a.palette.every(Number.isFinite));
        for(const[name,target]of Object.entries(s.grips))maxGripError=Math.max(maxGripError,distance(a.world[a.names.indexOf(name)].subarray(12,15),target));
      }
      if(s.job?.kind==='haul'&&s.job.stage==='working'&&i%17===0){
        const a=actors[s.sex];a.sample('Idle',s.time);poseCrewWork(a,s,b);
        for(const[name,target]of Object.entries(s.grips))maxHaulGripError=Math.max(maxHaulGripError,distance(a.world[a.names.indexOf(name)].subarray(12,15),target));
      }
    }
  }
  assert.ok(ascending>100&&working>100&&foretop>0);
  assert.ok(maxGripError<.16,'reachable hand/boot holds on a human-sized climbing gait');
  assert.ok(maxHaulGripError<.12,'haulers reach the actual fall on their side of the ship: '+maxHaulGripError);
  assert.equal(b.hatchesClosed,1);assert.deepEqual([...sailingState(b).set],[.2,.2,0]);
  assert.ok(c.crew.every(s=>!s.job),'all crew finish and return despite hidden rendering');
});
test('Victory helmsman stays on the quarterdeck and reaches the wheel at either rudder extreme',()=>{
  const b=fixture(),c=createCompany(undefined,'victory'),a=loadCrewGLB(fs.readFileSync(new URL('../assets/crew/sailor.glb',import.meta.url))).animator;
  for(const rudder of[-35,0,35]){
    b.rudder=rudder;stepCompany(c,b,0,0);const s=c.crew.find(s=>s.role==='Helmsman');
    assert.equal(s.x,VICTORY_DESIGN.crewStations.pedro.x);assert.equal(s.z,VICTORY_DESIGN.crewStations.pedro.z);
    assert.equal(s.yaw,Math.PI);assert.ok(Math.abs(s.position[1]-modelDeck(b,s.z)*vesselVerticalScale(b)-.028)<2e-6);
    a.sample('Idle',s.time);poseCrewWork(a,s,b);
    for(const[side,sign]of[['l',1],['r',-1]]){
      const h=a.world[a.names.indexOf('hand_'+side)].subarray(12,15),m=s.transform;
      const p=[0,1,2].map(i=>m[i]*h[0]+m[i+4]*h[1]+m[i+8]*h[2]+m[i+12]);
      const target=resolveShipNode(b,'helm.grip',{along:-sign*.09});
      assert.ok(distance(p,target)<.09,'wheel grip within 9 cm');
    }
  }
});
test('Victory captain camera clears every mast throughout the windward crossing and hull attitude',()=>{
  const b={...fixture(),x:100,z:-200,heave:.4,eye:getShipModel('victory').nodes['helm.camera'].position[1]*VICTORY_DESIGN.frame.verticalScale};
  const world=p=>{const out=[0,0,0];boatRotate(out,p[0]*b.beam/3.6,p[1]*vesselVerticalScale(b),p[2]*b.length/12,b.heading*Math.PI/180,b.pitch,b.roll);return [out[0]+b.x,out[1]+b.heave,out[2]+b.z];};
  for(const [heading,pitch,roll]of[[0,0,0],[90,.12,-.2],[217,-.15,.25]]){
    Object.assign(b,{heading,pitch,roll});
    for(let side=-1;side<=1.0001;side+=.05){
      b.eyeSide=side;const eye=[0,0,0];boatEyePosition(eye,b);
      for(const[i,m]of VICTORY_MASTS.entries()){
        const a=world(victoryMastPoint(i,modelDeck(b,m.z))),z=world(victoryMastPoint(i,m.platform));
        const axis=z.map((p,j)=>p-a[j]),q=eye.map((p,j)=>p-a[j]),along=Math.max(0,Math.min(1,q.reduce((s,p,j)=>s+p*axis[j],0)/axis.reduce((s,p)=>s+p*p,0)));
        const clearance=Math.hypot(...q.map((p,j)=>p-axis[j]*along));
        assert.ok(clearance>m.radius*Math.max(b.beam/3.6,vesselVerticalScale(b))+.15,m.id+' camera crosses outside mast trunk');
      }
    }
  }
});

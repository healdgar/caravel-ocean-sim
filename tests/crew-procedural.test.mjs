// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Proposed integration fixtures; root executes after all model backends merge.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {createCompany,stepCompany,issueCaptainOrder} from '../js/crew.js';
import {poseCrewWork} from '../js/crew-pose.js';
import {crewSeatedPose,updateCrewRowingAttendance,proceduralCrewRoute} from '../js/crew-work.js';
import {laterSailRigContext} from '../js/additional-rig.js';
import {laterSailStairFlights} from '../js/models/later-sail.js';
import {loadCrewGLB} from '../js/gltf.js';
import {requirePlayableShipModel,resolveShipNode} from '../js/ship-models.js';
import {proceduralDesign} from '../js/models/procedural.js';
import {rowingStationPose,rowingSteeringPose} from '../js/rowing.js';
import {advanceSails,sailingState} from '../js/sailing.js';
const crewProposedBoat=id=>{const model=requirePlayableShipModel(id);return {modelId:id,model,...model.runtime,heading:0,heave:0,pitch:0,roll:0,rollVelocity:0,rudder:0,sailFore:1,sailMain:1,sailMizzen:1,crew:false,showProw:true,hatchesClosed:0};};
const crewProposedDistance=(a,b)=>Math.hypot(...a.map((v,i)=>v-b[i]));
const crewProposedWorld=(s,p)=>[0,1,2].map(i=>s.transform[i]*p[0]+s.transform[i+4]*p[1]+s.transform[i+8]*p[2]+s.transform[i+12]);

test('complete station-owned companies preserve gender balance, identities and narrow-boat visibility',()=>{
  for(const [id,count]of [['oseberg',32],['lusoria',26],['taino-canoe',30],['flying-cloud',12],['gipsy-moth-iv',1]]){
    const boat=crewProposedBoat(id),company=createCompany(undefined,id);stepCompany(company,boat,0,2);
    assert.equal(company.crew.length,count,id+' authored complement');assert.equal(new Set(company.crew.map(s=>s.id)).size,count);
    assert.deepEqual(new Set(company.crew.map(s=>s.stationKey)),new Set(Object.keys(requirePlayableShipModel(id).crewStations)));
    if(count>1)assert.equal(company.crew.filter(s=>s.sex==='female').length,count/2);
    assert.ok(company.crew.every(s=>s.visible&&s.position.every(Number.isFinite)&&s.transform.every(Number.isFinite)),id+' actors are not hidden by Niña beam thresholds');
    assert.ok(new Set(company.crew.map(s=>s.skin.join(','))).size>=Math.min(count,4),id+' retains diverse appearances');
    if(id==='flying-cloud'){assert.equal(company.representativeWatch,true);assert.equal(proceduralDesign(id).loading.crew,42);}
    if(id==='gipsy-moth-iv'){assert.equal(company.crew[0].id,'ines');assert.equal(company.crew[0].sex,'female');assert.ok(company.crew[0].roles.includes('helmsman'));}
  }
});

test('rower hands, pelvis and planted boots follow shared stroke targets without advancing physical phase',()=>{
  const meshes=Object.fromEntries(['male','female'].map(sex=>[sex,loadCrewGLB(readFileSync(new URL('../assets/crew/'+(sex==='female'?'sailor-female.glb':'sailor.glb'),import.meta.url)))]));
  for(const id of ['oseberg','lusoria','taino-canoe']){
    const boat=crewProposedBoat(id),company=createCompany(undefined,id);
    boat.rowingState={phase:0,rate:.45,effortPort:.6,effortStarboard:.6,cadence:.45};
    for(const phase of [.08,.30,.60,.88]){
      boat.rowingState.phase=phase;stepCompany(company,boat,0,2);assert.equal(boat.rowingState.phase,phase);
      // Include the full beam at midships, both sides and the narrow bow/stern;
      // sampling the first pair alone misses the worst cross-body grip reach.
      const subjects=company.crew;
      for(const s of subjects){
        const targets=crewSeatedPose(s,boat),a=meshes[s.sex].animator;a.sample('Idle',s.time);poseCrewWork(a,s,boat);
        const at=name=>crewProposedWorld(s,Array.from(a.world[a.nodeIndex(name)].subarray(12,15)));
        const left=[Math.cos(s.yaw),0,-Math.sin(s.yaw)],ordered=points=>points[0].reduce((n,v,i)=>n+(v-points[1][i])*left[i],0);
        assert.ok(ordered(targets.feet)>0,id+' '+s.id+' left and right feet must not cross');
        assert.ok(ordered(targets.hands)>0,id+' '+s.id+' shaft grips must preserve anatomical left/right at this facing');
        assert.ok(a.palette.every(Number.isFinite),id+' finite seated skin');
        assert.ok(crewProposedDistance(at('pelvis'),targets.seat)<.025,id+' pelvis rests at its own bench');
        for(const [i,side]of ['l','r'].entries()){
          assert.ok(crewProposedDistance(at('hand_'+side),targets.hands[i])<.08,id+' '+s.id+' '+phase+' actual hand reaches shaft '+JSON.stringify({side,hand:at('hand_'+side),target:targets.hands[i],seat:targets.seat,pelvis:at('pelvis'),root:Array.from(s.position),scale:Array.from(s.scale),lean:targets.body.lean}));
          assert.ok(crewProposedDistance(at('foot_'+side),targets.feet[i])<.08,id+' actual boot reaches the authored floor');
        }
        assert.ok(at('Head')[1]<targets.seat[1]+1.2,'seated workers are not standing templates');
        assert.equal(s.moisturePoints.length,4);assert.ok(s.moisturePoints.every(p=>p.every(Number.isFinite)));
        const authoritative=s.stationId?rowingStationPose(boat,s.stationId):s.role==='Helmsman'?rowingSteeringPose(boat):null;
        if(authoritative)for(let i=0;i<2;i++)assert.ok(crewProposedDistance(targets.hands[i],authoritative.hands[i])<1e-9);
        assert.equal(boat.rowingState.phase,phase,'rendering/IK never advances rowing physics');
      }
    }
  }
});

test('solo Gipsy Moth physically visits independent sail controls and hatch without a two-person gate',()=>{
  const boat=crewProposedBoat('gipsy-moth-iv'),company=createCompany(undefined,boat.modelId),seen=new Set(),masts=new Map(),mesh=loadCrewGLB(readFileSync(new URL('../assets/crew/sailor-female.glb',import.meta.url)));let hatchPoseChecked=false;stepCompany(company,boat,0,3);
  for(const order of ['weather','full']){
    assert.equal(issueCaptainOrder(company,boat,order),true);
    let complete=false;
    for(let i=0;i<2400;i++){
      advanceSails(boat,.1,3,0);stepCompany(company,boat,.1,3);
      const job=company.crew[0].job;if(job?.control!==undefined){seen.add(job.control);masts.set(job.control,job.mast);assert.equal(job.kind,'haul');}
      if(job?.kind==='hatch'&&job.stage==='working'&&!hatchPoseChecked){
        const s=company.crew[0],a=mesh.animator,grip=resolveShipNode(boat,'hatch.grip');a.sample('Idle',s.time);poseCrewWork(a,s,boat);
        for(const [side,sign]of [['l',1],['r',-1]]){
          const hand=crewProposedWorld(s,Array.from(a.world[a.nodeIndex('hand_'+side)].subarray(12,15))),target=[grip[0]+sign*.10*Math.cos(s.yaw),grip[1],grip[2]-sign*.10*Math.sin(s.yaw)];
          assert.ok(crewProposedDistance(hand,target)<.08,'solo sailor reaches actual aft lid grip rather than the far hinge through the cabin '+JSON.stringify({side,hand,target,root:Array.from(s.position),yaw:s.yaw,lean:s.climbPitch}));
        }
        hatchPoseChecked=true;
      }
      assert.ok(company.crew[0].transform.every(Number.isFinite));
      if(!company.pending&&!company.crew.some(s=>s.job)){complete=true;break;}
    }
    assert.ok(complete,order+' finishes with one real sailor and hidden rendering');
    assert.deepEqual(Array.from(sailingState(boat).set),order==='weather'?[.2,.2,0]:[1,1,1]);
  }
  assert.equal(boat.hatchesClosed,1);assert.equal(hatchPoseChecked,true);assert.deepEqual([...seen].sort(),[0,1,2]);assert.deepEqual([...masts].sort((a,b)=>a[0]-b[0]),[[0,0],[1,0],[2,1]],'headsail control is not an invented foremast');
  assert.equal(company.crew.length,1);assert.equal(company.crew[0].job,null);
});

test('sail-less canoe never receives nonexistent mast/hatch/gunnery jobs and keeps every occupied blade attended',()=>{
  const boat=crewProposedBoat('taino-canoe'),company=createCompany(undefined,boat.modelId);stepCompany(company,boat,0,2);
  assert.equal(company.activeControls.length,0);assert.equal(issueCaptainOrder(company,boat,'full'),false);assert.equal(issueCaptainOrder(company,boat,'transfer'),false);
  assert.equal(issueCaptainOrder(company,boat,'weather'),true);
  for(let i=0;i<80;i++)stepCompany(company,boat,.1,2);
  assert.ok(company.crew.every(s=>!s.job));assert.equal(company.pending,false);assert.equal(boat.rowingAttendance.size,24);
  const rower=company.crew.find(s=>s.stationId);rower.job={kind:'haul',stage:'approach'};
  // Attendance is an actual physical eligibility input, independent of drawing.
  const {stationId}=rower;updateCrewRowingAttendance(company,boat);assert.equal(boat.rowingAttendance.has(stationId),false);boat.rowingState={phase:.2,rate:.45,effortPort:1,effortStarboard:1,cadence:.45};
  const absent=rowingStationPose(boat,stationId);assert.equal(absent.effort,0);assert.equal(absent.drive,false);
});

test('entering and leaving a hazard uses final physical attendance for the same-frame hand and blade pose',()=>{
  for(const id of ['oseberg','lusoria','taino-canoe']){
    const boat=crewProposedBoat(id),company=createCompany(undefined,id);boat.rowingState={phase:.2,rate:.45,effortPort:.8,effortStarboard:.8,cadence:.45};
    for(const wind of [3,24,3]){
      stepCompany(company,boat,.1,wind);
      for(const s of company.crew.filter(s=>s.stationId)){
        const actual=rowingStationPose(boat,s.stationId);assert.equal(s.seatedPose.effort,actual.effort);assert.equal(s.seatedPose.drive,actual.drive);
        for(let i=0;i<2;i++)assert.ok(crewProposedDistance(s.seatedPose.hands[i],actual.hands[i])<1e-9,'hazard transition cannot leave a stale attended hand pose');
        assert.equal(boat.rowingAttendance.has(s.stationId),wind<23);
      }
    }
  }
});

test('blocked new-model assignments back off and invalidate immediately for a new captain order',()=>{
  const boat=crewProposedBoat('gipsy-moth-iv'),company=createCompany(undefined,boat.modelId);stepCompany(company,boat,0,3);
  // A disconnected start has no authored deck path. Never teleport it onto a
  // route, and do not explore the entire graph again on every display frame.
  company.crew[0].x=100;company.crew[0].position[0]=100*boat.beam/3.6;issueCaptainOrder(company,boat,'furl');stepCompany(company,boat,.1,3);
  const attempts=company.routeAttempts;assert.ok(attempts>0);assert.equal(company.crew[0].job??null,null);
  for(let i=0;i<5;i++)stepCompany(company,boat,.1,3);assert.equal(company.routeAttempts,attempts);
  issueCaptainOrder(company,boat,'reduced');stepCompany(company,boat,.1,3);assert.ok(company.routeAttempts>attempts,'new orders invalidate blocked-path retry backoff');
  assert.equal(company.crew[0].x,100,'planner failure never supplies a wall bypass or teleport');
});

test('Moth work routes clear the actual cockpit coaming with a complete human envelope',()=>{
  const boat=crewProposedBoat('gipsy-moth-iv'),company=createCompany(undefined,boat.modelId),d=proceduralDesign(boat.modelId),c=d.cockpit,sx=boat.beam/d.frame.beam,sz=boat.length/d.frame.length;
  stepCompany(company,boat,0,3);const sailor=company.crew[0],context=laterSailRigContext(d.id),entry=laterSailStairFlights(d.id).find(f=>f.zoneId==='cockpit'),x=c.halfWidth*sx,z0=c.bounds[0]*sz,z1=c.bounds[1]*sz,gap=entry.width*sx/2;
  const walls=[[[-x,z0],[-x,z1]],[[x,z0],[x,z1]],[[-x,z1],[x,z1]],[[-x,z0],[-gap,z0]],[[gap,z0],[x,z0]]];
  const clearance=(point,[a,b])=>{const v=b.map((q,i)=>q-a[i]),den=v[0]*v[0]+v[1]*v[1],t=Math.max(0,Math.min(1,point.reduce((n,q,i)=>n+(q-a[i])*v[i],0)/den));return Math.hypot(...point.map((q,i)=>q-a[i]-t*v[i]));};
  const targets=[resolveShipNode(boat,'station.hatch',{space:'design'}),...Object.values(context.controlStations).map(station=>station.position)];
  for(const target of targets){
    const path=proceduralCrewRoute(sailor,target,boat);assert.ok(path,'every actual work station must remain reachable through the real entry');
    for(let i=1;i<path.length;i++){
      const a=[path[i-1][0]*sx,path[i-1][2]*sz],b=[path[i][0]*sx,path[i][2]*sz],samples=Math.max(1,Math.ceil(Math.hypot(...b.map((v,j)=>v-a[j]))/.04));
      for(let k=0;k<=samples;k++){const p=a.map((v,j)=>v+(b[j]-v)*k/samples);assert.ok(walls.every(wall=>clearance(p,wall)>=.22-1e-6),'human body never passes through a coaming wall or its opening jamb');}
    }
  }
});

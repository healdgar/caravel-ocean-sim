import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {ROWING_DESIGNS,rowingBenchDescriptors,rowingDeck,rowingHullWidth,rowingRigContext} from '../js/models/rowing.js';
import {hullLoftSheer} from '../js/hull-loft.js';
import {createMeshWriter} from '../js/mesh-writer.js';
import {createRowingShipMesh} from '../js/rowing-ships.js';
import {createCompany,stepCompany,issueCaptainOrder} from '../js/crew.js';
import {advanceSails,sailingState} from '../js/sailing.js';
import {requirePlayableShipModel} from '../js/ship-models.js';
import {loadCrewGLB} from '../js/gltf.js';
import {poseCrewWork} from '../js/crew-pose.js';
import {proceduralCrewRoute} from '../js/crew-work.js';

const crewBenchBoat=id=>{const model=requirePlayableShipModel(id);return {modelId:id,model,...model.runtime,heading:0,heave:0,pitch:0,roll:0,rollVelocity:0,rudder:0,sailFore:1,sailMain:1,sailMizzen:1,crew:false,showProw:true,hatchesClosed:0};};
const crewBenchDistance=(a,b)=>Math.hypot(...a.map((v,i)=>v-b[i]));
const crewBenchWorld=(s,p)=>[0,1,2].map(c=>s.transform[c]*p[0]+s.transform[c+4]*p[1]+s.transform[c+8]*p[2]+s.transform[c+12]);
function crewBenchSkinVertex(mesh,s,index){
  const f=new Float32Array(mesh.vertices.buffer,mesh.vertices.byteOffset,mesh.vertices.byteLength/4),u=new Uint16Array(mesh.vertices.buffer,mesh.vertices.byteOffset,mesh.vertices.byteLength/2),p=[0,0,0],palette=mesh.animator.palette;
  for(let k=0;k<4;k++){
    const at=u[index*30+18+k]*16,w=f[index*15+11+k];
    for(let c=0;c<3;c++)p[c]+=w*(palette[at+c]*f[index*15]+palette[at+4+c]*f[index*15+1]+palette[at+8+c]*f[index*15+2]+palette[at+12+c]);
  }
  return crewBenchWorld(s,p);
}

test('shared thwart descriptors preserve actual full-beam bench and supporting-leg mesh bytes',()=>{
  for(const [id,d]of Object.entries(ROWING_DESIGNS)){
    const parts=new Map();createRowingShipMesh(id,{parts});
    const old=createMeshWriter(),sx=d.runtime.beam/d.frame.beam,zs=[...new Set([...d.stations.map(s=>s.seat[2]),...Object.values(d.crewStations).map(s=>s.z)])].sort((a,b)=>a-b);
    for(const z of zs){
      const y=d.seatHeight+hullLoftSheer(d.profile,z),w=Math.max(0,rowingHullWidth(id,z,y)-d.shellThicknessMetres/sx);if(w<.1)continue;
      old.box([-w,y-.032,z-.065],[w,y,z+.065],1);
      for(const side of [-1,1])old.tube([side*w*.65,rowingDeck(id,z),z],[side*w*.65,y-.02,z],.022,1,.022,6);
    }
    assert.deepEqual(parts.get('rowing.benches'),new Float32Array(old.out),id+' extraction must not shorten, erase or move a single bench vertex');
    const benches=rowingBenchDescriptors(id);assert.equal(benches,rowingBenchDescriptors(id));assert.ok(Object.isFrozen(benches));
    for(const b of benches){
      assert.ok(Object.isFrozen(b.min));assert.equal(b.min[0],-b.max[0]);assert.equal(b.min[2],b.z-.065);assert.equal(b.max[2],b.z+.065);
      assert.ok(Math.abs((b.top-rowingDeck(id,b.z))*d.frame.verticalScale-.35)<1e-10,'actual35cm thwarts remain raised obstacles');
      assert.equal(b.supports.length,2);
    }
  }
});

test('measured boot soles come from actual own skin while retaining immutable crew vertex bytes',()=>{
  for(const file of ['sailor.glb','sailor-female.glb']){
    const bytes=readFileSync(new URL('../assets/crew/'+file,import.meta.url)),mesh=loadCrewGLB(bytes),copy=mesh.vertices.slice(),a=mesh.animator;
    a.sample(null,0);
    for(const side of ['l','r']){
      const f=a.footContacts[side];assert.ok(f.vertices.length>12);assert.ok(f.ankleAboveSole>0&&f.ankleAboveSole<.25);assert.ok(Object.isFrozen(f));
      const s={transform:new Float32Array([1,0,0,0,0,1,0,0,0,0,1,0,0,0,0,1])},points=f.vertices.map(index=>crewBenchSkinVertex(mesh,s,index)),low=Math.min(...points.map(p=>p[1]));
      assert.ok(Math.abs(low-(f.ankle[1]-f.ankleAboveSole))<1e-7,'sole follows this asset skin/bind matrices');
      assert.ok(Math.abs(Math.max(...points.map(p=>p[0]-f.ankle[0]))-f.max[0])<1e-7);
    }
    assert.deepEqual(mesh.vertices,copy);assert.deepEqual(bytes,readFileSync(new URL('../assets/crew/'+file,import.meta.url)));
  }
});

test('rowboat return routes use the same full body clearance as execution, including between graph nodes',()=>{
  for(const id of ['oseberg','lusoria']){
    const boat=crewBenchBoat(id),d=ROWING_DESIGNS[id],company=createCompany(undefined,id);stepCompany(company,boat,0,3);
    const s=company.crew.find(person=>person.role==='Captain'),home=[s.x,rowingDeck(id,s.z),s.z],work=rowingRigContext(id).controlStations.main.position,scale=[boat.beam/d.frame.beam,d.frame.verticalScale,boat.length/d.frame.length];
    s.x=work[0];s.z=work[2];s.position.set(work.map((v,i)=>v*scale[i]+(i===1?.028:0)));s.job={position:[...work]};
    const path=proceduralCrewRoute(s,home,boat,company);assert.ok(path,id+' full return route exists around seated workers');
    for(let i=1;i<path.length;i++){
      const a=path[i-1].map((v,k)=>v*scale[k]+(k===1?.028:0)),b=path[i].map((v,k)=>v*scale[k]+(k===1?.028:0)),delta=b.map((v,k)=>v-a[k]),length2=delta.reduce((sum,v)=>sum+v*v,0);
      for(const other of company.crew.filter(person=>person!==s)){
        const t=Math.max(0,Math.min(1,delta.reduce((sum,v,k)=>sum+v*(other.position[k]-a[k]),0)/Math.max(length2,1e-9))),p=a.map((v,k)=>v+delta[k]*t),gap=crewBenchDistance(p,Array.from(other.position));
        assert.ok(gap>=.54-1e-6,id+' return edge cannot enter the executor stopping radius '+JSON.stringify({other:other.id,gap,a,b,p}));
      }
    }
  }
});

test('real rowing crew complete sail orders while planted and swinging boot mesh clears every real thwart',t=>{
  const meshes=Object.fromEntries(['male','female'].map(sex=>[sex,loadCrewGLB(readFileSync(new URL('../assets/crew/'+(sex==='female'?'sailor-female.glb':'sailor.glb'),import.meta.url)))]));
  let actualSamples=0,benchPlants=0,swings=0;const defects=[];
  for(const id of ['oseberg','lusoria']){
    const boat=crewBenchBoat(id),company=createCompany(undefined,id),d=ROWING_DESIGNS[id],scale=[boat.beam/d.frame.beam,d.frame.verticalScale,boat.length/d.frame.length],benches=rowingBenchDescriptors(id).map(b=>({id:b.id,min:b.min.map((v,i)=>v*scale[i]),max:b.max.map((v,i)=>v*scale[i]),supports:b.supports}));
    stepCompany(company,boat,0,3);
    for(const order of ['reduced','furl','full','weather']){
      assert.equal(issueCaptainOrder(company,boat,order),true);let complete=false;
      for(let tick=0;tick<2400;tick++){
        advanceSails(boat,.1,3,0);stepCompany(company,boat,.1,3);
        for(const s of company.crew.filter(s=>s.job)){
          const mesh=meshes[s.sex],a=mesh.animator;a.sample('Idle',s.time,'Walk',s.walkTime,s.walk);poseCrewWork(a,s,boat);
          assert.ok(a.palette.every(Number.isFinite));assert.ok(s.walkContacts,'actual moving/working rowboat legs use contact planning');
          const pelvis=crewBenchWorld(s,Array.from(a.world[a.nodeIndex('pelvis')].subarray(12,15)));
          for(const [i,side]of ['l','r'].entries()){
            const contact=s.walkContacts.feet[i],f=a.footContacts[side],ankle=crewBenchWorld(s,Array.from(a.world[f.node].subarray(12,15))),target=contact.sole.slice();target[1]+=f.ankleAboveSole*s.scale[1];
            if(crewBenchDistance(ankle,target)>.025)defects.push({id,order,tick,sailor:s.id,side,kind:'reach',gap:crewBenchDistance(ankle,target),target,ankle,pelvis});
            if(contact.swing)swings++;else if(contact.support!=='floor')benchPlants++;
            for(const index of f.vertices){
              const point=crewBenchSkinVertex(mesh,s,index);actualSamples++;
              for(const b of benches)if(point[0]>b.min[0]+.008&&point[0]<b.max[0]-.008&&point[2]>b.min[2]+.008&&point[2]<b.max[2]-.008&&point[1]>b.min[1]+.008&&point[1]<b.max[1]-.008){
                if(defects.length<30)defects.push({id,order,tick,sailor:s.id,side,kind:'boot-in-thwart',vertex:index,point,bench:b});
              }
              for(const b of benches)for(const leg of b.supports){
                const design=point.map((v,i)=>v/scale[i]),radius=Math.hypot(design[0]-leg.a[0],design[2]-leg.a[2]);
                if(design[1]>leg.a[1]+.008/scale[1]&&design[1]<leg.b[1]-.008/scale[1]&&radius<leg.radius-.008/Math.min(scale[0],scale[2])&&defects.length<30)defects.push({id,order,tick,sailor:s.id,side,kind:'boot-in-bench-leg',vertex:index,point,bench:b.id});
              }
              if(!contact.swing&&point[1]<contact.sole[1]-.008&&defects.length<30)defects.push({id,order,tick,sailor:s.id,side,kind:'sole-below-support',point,contact});
            }
          }
        }
        if(!company.pending&&!company.crew.some(s=>s.job)){complete=true;break;}
      }
      assert.ok(complete,id+' '+order+' finishes with real workers and no deck/wall bypass '+JSON.stringify({set:Array.from(sailingState(boat).set),pending:company.pending,jobs:company.crew.filter(s=>s.job).map(s=>({id:s.id,stage:s.job.stage,x:s.x,z:s.z,cursor:s.job.cursor,blocked:s.job.blockedTime})),firstDefects:defects.slice(0,3)}));
      const expected={reduced:.5,furl:0,full:1,weather:.2}[order];assert.ok(Math.abs(sailingState(boat).set[1]-expected)<1e-6);
    }
  }
  t.diagnostic(JSON.stringify({actualBootVertices:actualSamples,benchPlants,swings,defects: defects.slice(0,20)}));
  assert.ok(actualSamples>1000&&benchPlants>10&&swings>10,'the oracle must exercise actual geometry on and over many thwarts');
  assert.equal(defects.length,0,'actual skinned feet must clear physical bench slabs and reach unmodified contact targets '+JSON.stringify(defects.slice(0,20)));
});

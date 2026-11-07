import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {generateProceduralCoastalPack} from '../js/coastal-world.js';
import {terrainSurfaceSample} from '../js/terrain-model.js';
import {
  PROP_MODELS,
  applyJettyImpactDamage,
  ensureJettyFracture,
  evaluateJettyShardPose,
  jettyLocalToWorld,
  layPortProps,
  preparePortJetties,
  readPropModel,
  stepJettyFracture,
  sweepJettySegment,
} from '../js/port-props.js';
import {
  createGunnerySolidSweep,
  resolveSolidGunneryImpact,
  sweepBuildingSegment,
} from '../js/gunnery-control.js';

const GRID={size:513,biomeSize:128,albedoSize:256};

// A small port: one pier running out from a straight beach, with water to the west.
function bay(extra={}){
  const groundAt=(x)=>x*.05;
  const pier={prefabId:'timber_mole_pier',x:-20,z:0,y:.4,yaw:Math.PI/2,length:68,width:7.5,height:2.8};
  const hall={prefabId:'casa_de_contratacion',x:60,z:0,y:3,yaw:0,length:30,width:20,height:9};
  return {port:{center:{x:40,z:0},instances:[pier,hall],indigenousSettlement:{hasIndigenousSettlement:false},...extra},groundAt,pier};
}

test('every model reads as real metres, standing on the ground, centred, with its own texture',()=>{
  for(const spec of PROP_MODELS){
    const m=readPropModel(readFileSync(new URL('../'+spec.file,import.meta.url)),spec);
    assert.ok(m.indices.length/3>100&&m.indices.length/3<2000,`${spec.id}: ${m.indices.length/3} triangles`);
    assert.ok(m.indices.every(i=>i*8<m.vertices.length));
    const lo=[9e9,9e9,9e9],hi=[-9e9,-9e9,-9e9];
    for(let i=0;i<m.vertices.length;i+=8)for(let k=0;k<3;k++){lo[k]=Math.min(lo[k],m.vertices[i+k]);hi[k]=Math.max(hi[k],m.vertices[i+k]);}
    assert.ok(Math.abs(lo[1])<1e-4,`${spec.id} stands on y = 0`);
    assert.ok(Math.abs(lo[0]+hi[0])<1e-3&&Math.abs(lo[2]+hi[2])<1e-3,`${spec.id} is centred`);
    assert.ok(hi[2]-lo[2]>=hi[0]-lo[0],`${spec.id} runs along z`);
    assert.equal(m.mime,'image/jpeg');
    assert.deepEqual([...m.image.subarray(0,3)],[0xff,0xd8,0xff],'real JPEG bytes');
    if(spec.deckShare)assert.ok(m.standsAt<0,'a jetty stands in the water');
  }
});

test('cleats line both edges of a pier at deck height, and stay on it',()=>{
  const {port,groundAt,pier}=bay(),cleats=layPortProps(port,groundAt).filter(p=>p.model===0),c=Math.cos(pier.yaw),s=Math.sin(pier.yaw);
  assert.ok(cleats.length>=12,`${cleats.length} cleats`);
  for(const cleat of cleats){
    assert.equal(cleat.y,pier.y+pier.height);
    assert.equal(cleat.owner,0);
    const dx=cleat.x-pier.x,dz=cleat.z-pier.z,lx=dx*c-dz*s,lz=dx*s+dz*c;
    assert.ok(Math.abs(lx)<pier.width/2&&Math.abs(lx)>pier.width/2-1,`across the deck ${lx}`);
    assert.ok(Math.abs(lz)<pier.length/2,`along it ${lz}`);
  }
  assert.ok(cleats.some(p=>(p.x-pier.x)*c-(p.z-pier.z)*s>0)&&cleats.some(p=>(p.x-pier.x)*c-(p.z-pier.z)*s<0));
});

test('a quay has cleats only on its sea side',()=>{
  const quay={prefabId:'stone_quay_seawall',x:0,z:0,y:1,yaw:0,length:40,width:6,height:2};
  const cleats=layPortProps({center:{x:40,z:0},instances:[quay]},x=>x*.05).filter(p=>p.model===0);
  assert.ok(cleats.length>0);
  assert.ok(cleats.every(p=>p.x<0),'the sea is to the west');
});

test('a jetty stands on the shore, root on the beach and head in the water, clear of buildings',()=>{
  const {port,groundAt}=bay(),jetties=layPortProps(port,groundAt).filter(p=>p.model>0);
  assert.ok(jetties.length>0&&jetties.length<=2,`${jetties.length} jetties`);
  for(const j of jetties){
    const seaX=Math.sin(j.yaw),seaZ=Math.cos(j.yaw);
    assert.ok(groundAt(j.x-seaX*12)>groundAt(j.x+seaX*12),'its length runs down the beach');
    assert.ok(groundAt(j.x+seaX*5)<0,'its head is in water');
    assert.equal(j.y,null,'its height comes from the model');
    assert.equal(j.owner,-1);
    for(const inst of port.instances)assert.ok(Math.hypot(inst.x-j.x,inst.z-j.z)>Math.hypot(inst.length,inst.width)/2,inst.prefabId);
  }
  if(jetties.length===2)assert.notEqual(jetties[0].model,jetties[1].model);
});

test('a sovereign Indigenous town gets no plank jetty, and a place with no port gets nothing',()=>{
  const {port,groundAt}=bay({indigenousSettlement:{hasIndigenousSettlement:true,isSovereignPolity:true}});
  assert.equal(layPortProps(port,groundAt).filter(p=>p.model>0).length,0);
  assert.deepEqual(layPortProps(null,groundAt),[]);
  assert.deepEqual(layPortProps({center:{x:0,z:0},instances:[]},groundAt),[]);
});

test('the same port lays the same props, and a real port gets them',()=>{
  const {port,groundAt}=bay();
  assert.deepEqual(layPortProps(port,groundAt),layPortProps(port,groundAt));
  const pack=generateProceduralCoastalPack('lisbon',GRID);
  const ground=(x,z)=>terrainSurfaceSample(pack.heights,x,z,pack.region);
  assert.deepEqual(pack.port.props,layPortProps(pack.port,ground));
  assert.ok(pack.port.props.some(p=>p.model===0),'Lisbon has cleats on its piers');
});

test('a cannonball strikes a rustic jetty\'s drawn timbers, breaks off flying shards that fall under gravity, and lets follow-up shots pass through the gap',()=>{
  const models=PROP_MODELS.map(spec=>readPropModel(readFileSync(new URL('../'+spec.file,import.meta.url)),spec));
  for(const modelIndex of [1,2]){
    const model=models[modelIndex];
    const jetty={model:modelIndex,x:0,y:null,z:0,yaw:0.35,owner:-1};
    const port={center:{x:0,z:0},instances:[],props:[jetty],groundAt:()=>-1.8};
    preparePortJetties(port,models,port.groundAt);

    // Pick a deck shard near mid-length and aim a horizontal shot directly through one of its triangles.
    const state=ensureJettyFracture(jetty,model,port.groundAt);
    const targetShard=state.shards.find(s=>s.tier===2&&s.bay>=2&&s.bay<=5)??state.shards[0];
    const i0=model.indices[targetShard.indexStart]*8;
    const i1=model.indices[targetShard.indexStart+1]*8;
    const i2=model.indices[targetShard.indexStart+2]*8;
    const triCenter=[
      (model.vertices[i0]+model.vertices[i1]+model.vertices[i2])/3,
      (model.vertices[i0+1]+model.vertices[i1+1]+model.vertices[i2+1])/3,
      (model.vertices[i0+2]+model.vertices[i1+2]+model.vertices[i2+2])/3,
    ];
    const from=jettyLocalToWorld(jetty,triCenter[0]-12,triCenter[1],triCenter[2],model);
    const to=jettyLocalToWorld(jetty,triCenter[0]+12,triCenter[1],triCenter[2],model);

    // A shot high above the jetty misses (passes through air, not an oversized box).
    const airFrom=jettyLocalToWorld(jetty,triCenter[0]-12,model.height+2.5,triCenter[2],model);
    const airTo=jettyLocalToWorld(jetty,triCenter[0]+12,model.height+2.5,triCenter[2],model);
    assert.equal(sweepJettySegment(airFrom,airTo,0.08,port),null,`${PROP_MODELS[modelIndex].id}: air above deck is clear`);

    // The shot aimed at the drawn timber hits via both sweepJettySegment and createGunnerySolidSweep.
    const sweep=createGunnerySolidSweep({getVessels:()=>[],getTerrain:()=>({port})});
    const hit=sweep(from,to,{radius:0.08,ammo:'round'});
    assert.ok(hit,`${PROP_MODELS[modelIndex].id}: cannonball hits drawn jetty mesh`);
    assert.equal(hit.kind,'jetty');
    assert.equal(hit.materialClass,'timber');
    assert.equal(hit.jetty,jetty);
    assert.deepEqual(sweepBuildingSegment(from,to,0.08,port)?.jetty,jetty);

    const vel=[
      (to[0]-from[0])*15,
      (to[1]-from[1])*15,
      (to[2]-from[2])*15,
    ];
    const report=resolveSolidGunneryImpact({
      ...hit,
      type:'impact',
      ammo:'round',
      mass:10.9,
      velocity:vel,
      position:jettyLocalToWorld(jetty,...hit.localPosition,model),
    },{getTerrain:()=>({port})});

    assert.ok(report,`${PROP_MODELS[modelIndex].id}: impact resolves`);
    assert.equal(report.kind,'jetty');
    assert.ok(report.releasedShards.length>=1,`${PROP_MODELS[modelIndex].id}: releases broken timber shards`);
    assert.ok(state.aliveCount<state.shards.length);

    // Released shards fly outward and upward initially, then fall under gravity below their starting height.
    const brokenId=report.releasedShards[0];
    const pose0=evaluateJettyShardPose(jetty,brokenId,0);
    assert.equal(pose0.inFlight,true);
    stepJettyFracture(jetty,0.12);
    const poseMid=evaluateJettyShardPose(jetty,brokenId);
    const horizDisp=Math.hypot(
      poseMid.localPosition[0]-pose0.localPosition[0],
      poseMid.localPosition[2]-pose0.localPosition[2],
    );
    assert.ok(horizDisp>0.25,`${PROP_MODELS[modelIndex].id}: broken timber flies outward (${horizDisp.toFixed(2)} m)`);
    assert.ok(poseMid.angle>0.2,`${PROP_MODELS[modelIndex].id}: broken timber spins in flight`);

    for(let step=0;step<40;step++)stepJettyFracture(jetty,0.1);
    const poseLate=evaluateJettyShardPose(jetty,brokenId);
    assert.ok(poseLate.localPosition[1]<pose0.localPosition[1]-0.4,`${PROP_MODELS[modelIndex].id}: broken timber falls under gravity`);

    // A follow-up shot along the exact same line now passes through the broken gap (or hits a deeper shard behind it, and once cleared, passes right through).
    for(let shotIdx=0;shotIdx<4;shotIdx++){
      const nextHit=sweep(from,to,{radius:0.08,ammo:'round'});
      if(!nextHit)break;
      resolveSolidGunneryImpact({...nextHit,type:'impact',ammo:'round',mass:10.9,velocity:vel},{getTerrain:()=>({port})});
    }
    assert.equal(sweep(from,to,{radius:0.08,ammo:'round'}),null,`${PROP_MODELS[modelIndex].id}: follow-up shot passes cleanly through the breached gap`);
  }
});

test('shooting away the supporting pilings under a rustic jetty collapses the unsupported deck section above',()=>{
  const models=PROP_MODELS.map(spec=>readPropModel(readFileSync(new URL('../'+spec.file,import.meta.url)),spec));
  for(const modelIndex of [1,2]){
    const model=models[modelIndex];
    const jetty={model:modelIndex,x:0,y:null,z:0,yaw:0,owner:-1};
    const port={center:{x:0,z:0},instances:[],props:[jetty],groundAt:()=>-2.0};
    preparePortJetties(port,models,port.groundAt);
    const state=ensureJettyFracture(jetty,model,port.groundAt);

    // Strike the lower anchored pilings across the seaward bays with low horizontal shots below deck level.
    const anchored=state.shards.filter(s=>s.anchored);
    assert.ok(anchored.length>=4,`${PROP_MODELS[modelIndex].id} has anchored pilings`);
    let totalCollapsed=0;
    for(const piling of anchored){
      if(!state.alive[piling.id])continue;
      const report=applyJettyImpactDamage(jetty,{
        shardId:piling.id,
        localPosition:[piling.center[0],Math.min(piling.center[1],model.fracture.deckY*0.4),piling.center[2]],
        velocity:[320,0,0],
        mass:14.5,
        energy:740000,
        ammo:'round',
      },{port});
      totalCollapsed+=report?.collapsedShards.length??0;
    }
    assert.ok(totalCollapsed>0,`${PROP_MODELS[modelIndex].id}: shooting out pilings collapses ${totalCollapsed} supported upper shards`);
  }
});

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
  pierBentStations,
  pierBrowStations,
  pierCraneStation,
  preparePortJetties,
  propDrawRadius,
  readPropModel,
  stepJettyFracture,
  sweepJettySegment,
} from '../js/port-props.js';
import {createPortDamageStore} from '../js/port-damage.js';
import {evaluateShardFlight} from '../js/ship-fracture.js';
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

test('laying props leaves the port as it was given',()=>{
  const {port,groundAt}=bay(),keys=Object.getOwnPropertyNames(port).sort();
  layPortProps(port,groundAt);
  assert.deepEqual(Object.getOwnPropertyNames(port).sort(),keys,'no ground sampler is hung on the port');
});

test('pier cleats stand midway between bents, clear of the bollard posts, the crane and the boarding brow',()=>{
  for(const length of [38,52,68,74]){
    const pier={prefabId:'timber_mole_pier',x:0,z:0,y:.4,yaw:0,length,width:8,height:2};
    const cleats=layPortProps({center:{x:40,z:0},instances:[pier]},()=>-2).filter(p=>p.model===0),bents=pierBentStations(length);
    assert.ok(cleats.length>=4,`${length} m pier: ${cleats.length} cleats`);
    assert.ok(Math.abs(bents[0]+length/2-1.2)<1e-9&&Math.abs(bents.at(-1)-length/2+1.2)<1e-9,'bents run end to end');
    const [browFrom,browTo]=pierBrowStations(length);
    // At no turn, a pier's own across and along are the world's x and z.
    for(const cleat of cleats){
      assert.ok(Math.min(...bents.map(b=>Math.abs(b-cleat.z)))>1.5,`${length} m pier: a cleat ${cleat.z.toFixed(2)} along stands on a bent`);
      if(cleat.x<0)continue;
      assert.ok(Math.abs(cleat.z-pierCraneStation(length))>2,`${length} m pier: a cleat ${cleat.z.toFixed(2)} along stands in the crane`);
      assert.ok(cleat.z<browFrom-0.4||cleat.z>browTo+0.4,`${length} m pier: a cleat ${cleat.z.toFixed(2)} along stands under the brow`);
    }
  }
});

// A jetty across a shoreline: beach where x < 0, water beyond. Its length runs out along x.
const SHORE_GROUND=(x)=>x<0?0.5:-1.5;
function shorePort(){
  const pier={prefabId:'timber_mole_pier',x:40,z:60,y:.4,yaw:0,length:68,width:7.5,height:2.8};
  return {regionId:'shore-port',center:{x:0,z:0},instances:[pier],groundAt:SHORE_GROUND,props:[
    {model:1,x:0,y:null,z:0,yaw:Math.PI/2,owner:-1},
    {model:0,x:40-3.2,y:3.2,z:60,yaw:0,owner:0},
  ]};
}
const PROP_FILES=()=>PROP_MODELS.map(spec=>readPropModel(readFileSync(new URL('../'+spec.file,import.meta.url)),spec));
const shoot=(port,prop,shard,velocity)=>applyJettyImpactDamage(prop,{shardId:shard.id,localPosition:[...shard.center],velocity,mass:10.9,energy:550000,ammo:'round'},{port});
const settle=(prop)=>{for(let i=0;i<150;i++)stepJettyFracture(prop,0.1);};
// Where a point of a shard is now, in the prop's own frame.
const shardPoint=(prop,s,point)=>{const state=prop.fracture,at=s*16;return evaluateShardFlight(state.flight.records.subarray(at,at+16),state.now-state.flight.epoch,point,[1,1,1]);};

test('a shard lands where it is thrown to: on the beach from over water it lies there, and off the beach into water it sinks',()=>{
  const models=PROP_FILES();
  for(const [from,shotX,lands] of [['water',-320,'beach'],['beach',320,'water']]){
    const port=shorePort(),jetty=port.props[0];
    preparePortJetties(port,models,port.groundAt);
    const state=jetty.fracture,model=models[1];
    // A deck shard a few metres to one side of the shoreline, shot towards the other.
    const worldX=(shard)=>jettyLocalToWorld(jetty,shard.center[0],shard.center[1],shard.center[2],model)[0];
    const shard=state.shards.filter(s=>s.tier===2&&(from==='water'?worldX(s)>0.4&&worldX(s)<3.5:worldX(s)<-0.4&&worldX(s)>-3.5)).sort((a,b)=>Math.abs(worldX(a))-Math.abs(worldX(b)))[0];
    assert.ok(shard,`a deck shard over the ${from} near the shoreline`);
    const report=shoot(port,jetty,shard,[shotX,0,0]);
    assert.equal(report.releasedShards[0],shard.id);
    const at=shard.id*16,records=state.flight.records,kept=records[at+11]<0,settleAt=records[at+7];
    settle(jetty);
    const pose=evaluateJettyShardPose(jetty,shard.id);
    if(lands==='beach'){
      assert.ok(kept,'thrown ashore from over water, it is kept');
      assert.ok(pose.worldPosition[0]<0,`it came down ashore, at x ${pose.worldPosition[0].toFixed(2)}`);
      assert.ok(Math.abs(pose.worldPosition[1]-0.5)<0.02,`and lies on the beach, not at the waterline: y ${pose.worldPosition[1].toFixed(2)}`);
      assert.equal(pose.retired,false);
    }else{
      assert.ok(!kept,'thrown off the beach into water, it is not kept');
      assert.equal(pose.retired,true,'and is gone once it has sunk');
    }
    // It falls for as long as the fall takes, however long that is.
    const drop=jettyLocalToWorld(jetty,shard.center[0],shard.center[1],shard.center[2],model)[1]-(lands==='beach'?0.5:-0.25),vy=records[at+5];
    assert.ok(Math.abs(settleAt-(vy+Math.sqrt(vy*vy+2*9.80665*drop))/9.80665)<1e-3,`time of flight ${settleAt.toFixed(3)} s`);
  }
});

test('a prop is drawn as far as its timber goes: whole, in the air, lying on the beach, and not at all once sunk or its pier gone',()=>{
  const models=PROP_FILES();
  for(const [ground,left] of [[()=>0.5,'lies'],[()=>-1.5,'sinks']]){
    const port={...shorePort(),groundAt:ground},jetty=port.props[0],cleat=port.props[1],model=models[1];
    preparePortJetties(port,models,port.groundAt);
    assert.equal(propDrawRadius(jetty,model),model.radius,'whole, its own size');
    assert.equal(propDrawRadius(cleat,models[0],'ruined'),0,'nothing once its pier is ruined');
    assert.equal(propDrawRadius(cleat,models[0],'breached'),0);
    assert.equal(propDrawRadius(cleat,models[0],'damaged'),models[0].radius);
    const state=jetty.fracture;
    shoot(port,jetty,state.shards.find(s=>s.tier===2),[0,0,320]);
    assert.ok(propDrawRadius(jetty,model)>model.radius,'further while timber is in the air');
    assert.equal(propDrawRadius(jetty,model,'ruined'),0,'broken or not, nothing once what it stood on has gone');
    for(let guard=0;guard<200&&state.aliveCount>0;guard++)shoot(port,jetty,state.shards.find(s=>state.alive[s.id]),[0,0,320]);
    assert.equal(state.aliveCount,0,'every shard shot away');
    assert.ok(propDrawRadius(jetty,model)>0,'still drawn while the last of it falls');
    settle(jetty);
    assert.equal(state.flight.flying.size,0);
    if(left==='lies'){
      assert.equal(state.kept,state.shards.length,'all of it lies on the beach');
      assert.ok(propDrawRadius(jetty,model)>model.radius,'so it is still drawn, out to where the furthest piece lies');
    }else{
      assert.equal(state.kept,0);
      assert.equal(propDrawRadius(jetty,model),0,'all of it sunk, nothing is drawn');
    }
  }
});

test('a struck jetty and a struck cleat are saved with their port and come back with the same shards gone and the same shards lying where they fell',()=>{
  const models=PROP_FILES(),port=shorePort(),[jetty,cleat]=port.props;
  preparePortJetties(port,models,port.groundAt);
  const deck=jetty.fracture.shards.filter(s=>s.tier===2),worldX=(s)=>jettyLocalToWorld(jetty,s.center[0],s.center[1],s.center[2],models[1])[0];
  // One shot over the beach and one over the water, so some timber lies and some sinks.
  shoot(port,jetty,deck.reduce((a,b)=>worldX(a)<worldX(b)?a:b),[0,0,320]);
  shoot(port,jetty,deck.reduce((a,b)=>worldX(a)>worldX(b)?a:b),[0,0,320]);
  shoot(port,cleat,cleat.fracture.shards[0],[320,0,0]);
  settle(jetty);settle(cleat);
  const lying=(prop)=>prop.fracture.shards.filter(s=>!prop.fracture.alive[s.id]&&!evaluateJettyShardPose(prop,s.id).retired).map(s=>s.id);
  const gone=(prop)=>prop.fracture.shards.filter(s=>!prop.fracture.alive[s.id]&&evaluateJettyShardPose(prop,s.id).retired).map(s=>s.id);
  assert.ok(lying(jetty).length>0&&gone(jetty).length>0,`jetty: ${lying(jetty).length} lying, ${gone(jetty).length} gone`);
  assert.ok(gone(cleat).length>0,'the cleat lost timber into the water under its pier');

  const day=86400000,date=Date.UTC(1650,5,1);
  const saved=JSON.parse(JSON.stringify(createPortDamageStore(null,{dateMs:date}).snapshot([port])));
  // A store works on the record it is given, so each gets its own copy.
  const copy=()=>JSON.parse(JSON.stringify(saved));
  assert.deepEqual(Object.keys(saved['shore-port']).sort(),['prop:0','prop:1']);
  assert.ok(JSON.stringify(saved).length<1200,`a compact record: ${JSON.stringify(saved).length} characters`);
  assert.deepEqual(Object.keys(createPortDamageStore(copy(),{dateMs:date}).forLink(shorePort())['shore-port']).sort(),['prop:0','prop:1'],'a share link carries them too');

  // The port comes into being again two days on: first its record, and its models only when it is next in reach.
  const again=shorePort(),store=createPortDamageStore(copy(),{dateMs:date+2*day});
  assert.equal(store.restore(again),2);
  preparePortJetties(again,models,again.groundAt);
  for(const [was,now] of [[jetty,again.props[0]],[cleat,again.props[1]]]){
    assert.deepEqual([...now.fracture.alive],[...was.fracture.alive],'the same shards stand');
    assert.equal(now.fracture.aliveCount,was.fracture.aliveCount);
    assert.deepEqual(gone(now),gone(was),'the same shards are gone');
    assert.deepEqual(lying(now),lying(was),'the same shards lie where they fell');
    assert.equal(now.fracture.flight.flying.size,0,'and none is in the air');
    assert.equal(now.fracture.kept,was.fracture.kept);
    for(const s of lying(was)){
      const c=was.fracture.shards[s].center;
      for(const point of [[c[0],c[1],c[2]],[c[0]+0.5,c[1]+0.2,c[2]-0.3]]){
        const a=shardPoint(was,s,point),b=shardPoint(now,s,point);
        assert.ok(Math.hypot(a[0]-b[0],a[1]-b[1],a[2]-b[2])<0.01,`shard ${s} lies where it lay: ${a.map(v=>v.toFixed(2))} against ${b.map(v=>v.toFixed(2))}`);
      }
    }
    assert.equal(now.damageState.state,was.damageState.state);
    assert.equal(now.damageState.integrity,was.damageState.integrity);
    assert.equal(now.damageState.lastHitDateMs,date,'the day it was hit is kept');
    assert.ok(Math.abs(propDrawRadius(now,models[now.model])-propDrawRadius(was,models[was.model]))<0.01);
    // Saved again untouched, it is the same record.
    const name=`prop:${again.props.indexOf(now)}`;
    assert.deepEqual(JSON.parse(JSON.stringify(store.snapshot([again])))['shore-port'][name],saved['shore-port'][name]);
  }

  // Timber is put back as a timber building is: after a week's clearing up and up to a month's work.
  const later=shorePort();
  assert.equal(createPortDamageStore(copy(),{dateMs:date+60*day}).restore(later),0);
  preparePortJetties(later,models,later.groundAt);
  assert.ok(later.props.every(p=>p.fracture.aliveCount===p.fracture.shards.length&&!p.fracture.damaged),'whole again after two months');

  // A prop that is somewhere else now stands whole, and so does one cut into other shards.
  const moved=shorePort();moved.props[0].x+=6;
  assert.equal(createPortDamageStore(copy(),{dateMs:date}).restore(moved),1);
  const recut=copy();recut['shore-port']['prop:0'].n+=1;
  const other=shorePort();
  createPortDamageStore(recut,{dateMs:date}).restore(other);
  preparePortJetties(other,models,other.groundAt);
  assert.equal(other.props[0].fracture.damaged,false);
  assert.equal(other.props[1].fracture.damaged,true);
});

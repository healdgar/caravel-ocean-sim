// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Forts stand where the harbour needs them. The real coasts here are kept in tests/data/harbours by
// scripts/harbour-coasts.mjs, so this needs no network. All of these fail on forts set out against a straight shore.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import zlib from 'node:zlib';
import {HISTORICAL_COLONIAL_PORTS,buildPortPrefabGeometry,generateProceduralCoastalPack,getBuildingParts,placeCoastalPort,resolveGlobalCoastalRegion,smoothCoastlineAndForeshoreBeaches,synthesizeCoastalTerrain} from '../js/coastal-world.js';
import {FORT_RECORDS,fortRecordsFor} from '../js/fort-records.js';
import {depthInOutline,enclosurePlan,fortLocalToWorld,traceWalls,triangularFortPlan,squareFortPlan} from '../js/fort-plan.js';
import {buildingGunBears,buildingGunMuzzlePose,classifyBuildingMaterial,createBuildingGunDefinitions,createBuildingGunnery,sweepBuildingSegment} from '../js/gunnery-control.js';
import {createFortGarrison} from '../js/crew.js';
import {noteBuildingMeshes,prepareBuildingFracture,applyBuildingFractureEvents} from '../js/building-fracture.js';
import {createPortDamageStore} from '../js/port-damage.js';
import {planHarbourDefences,worldOfPosition} from '../js/harbour-defences.js';
import {readHarbourGeography} from '../js/harbour-geography.js';
import {applyBuildingImpactDamage} from '../js/gunnery-control.js';
import {terrainSurfaceSample} from '../js/terrain-model.js';

const FORT_PREFABS=new Set(['bastion_trace_fortress','stone_sea_bastion','english_triangular_palisade_fort']);
const fixtures=new URL('./data/harbours/',import.meta.url);
function coastOf(id){
  const all=zlib.gunzipSync(fs.readFileSync(new URL(`${id}.bin.gz`,fixtures))),length=all.readUInt32LE(0),header=JSON.parse(all.subarray(4,4+length).toString());
  const words=new Int16Array(all.buffer.slice(all.byteOffset+4+length,all.byteOffset+all.length)),heights=new Float32Array(words.length);
  for(let i=0;i<words.length;i++)heights[i]=words[i]/10;
  return {header,heights};
}
const placed=new Map();
function portOn(id,year){
  const key=`${id}@${year}`;
  if(placed.has(key))return placed.get(key);
  const {header,heights:raw}=coastOf(id);
  const region=resolveGlobalCoastalRegion({id,year,size:header.size,biomeSize:64,albedoSize:64,vegetationCandidates:100,latitude:header.latitude,longitude:header.longitude,shoreBearing:header.shoreBearing});
  const heights=new Float32Array(raw);
  smoothCoastlineAndForeshoreBeaches(heights,region,{});
  const port=placeCoastalPort(region,heights,{preserveRealCoast:true,coastIsReal:true});
  const value={port,region,heights};
  placed.set(key,value);
  return value;
}
const fortsOf=(port)=>port.instances.filter(i=>FORT_PREFABS.has(i.prefabId));
const named=(port,piece)=>{
  const fort=port.instances.find(i=>i.label.includes(piece));
  assert.ok(fort,`no ${piece} among ${fortsOf(port).map(f=>f.label).join(', ')}`);
  return fort;
};
const distance=(a,b)=>Math.hypot(a.x-b.x,a.z-b.z);
const lookOf=(fort)=>[-Math.sin(fort.yaw),-Math.cos(fort.yaw)];
const nearestWater=(fort,heights,region)=>{
  const n=region.size;
  let best=null;
  for(let j=0;j<n;j+=2)for(let i=0;i<n;i+=2){
    if(heights[j*n+i]>=0)continue;
    const x=region.x+(i/(n-1)-.5)*region.span,z=region.z+(j/(n-1)-.5)*region.span,d=Math.hypot(x-fort.x,z-fort.z);
    if(!best||d<best.d)best={x,z,d};
  }
  return best;
};

test('the recorded forts stand on the record\'s ground, within what the coast allows',()=>{
  // Each within this of where the record puts it. A rough position only says which stretch of shore.
  for(const [id,year,piece,within] of [
    ['havana',1650,'Morro',340],['havana',1650,'Punta',340],['havana',1650,'Real Fuerza',520],
    ['san-juan',1650,'Morro',340],['san-juan',1650,'Canuelo',340],
    ['cartagena',1650,'Santa Cruz',600],
    ['boston',1650,'North Battery',620],
    ['goa',1650,'Gaspar',620],
  ]){
    const {port,region}=portOn(id,year),fort=named(port,piece),record=FORT_RECORDS[id].forts.find(f=>f.name.includes(piece));
    const at=worldOfPosition(region,record.lat,record.lon);
    assert.ok(distance(fort,at)<=within,`${id}: ${piece} stands ${distance(fort,at).toFixed(0)} m from its place`);
    assert.equal(fort.guards.source==='record'||within>=500,true,`${id}: ${piece} is by the record or a rough one (${fort.guards.source})`);
  }
});

test('El Morro and La Punta face each other across a harbour mouth, as at Havana and San Juan',()=>{
  const {port}=portOn('havana',1650);
  const morro=named(port,'Morro'),punta=named(port,'Punta'),mouth=port.harbour.mouth;
  assert.equal(port.harbour.kind,'mouth');
  assert.ok(mouth.width<600,`Havana's mouth reads ${mouth.width} m wide`);
  assert.ok(distance(morro,mouth)<700,`Morro ${distance(morro,mouth).toFixed(0)} m from the mouth`);
  assert.ok(distance(punta,mouth)<700,`La Punta ${distance(punta,mouth).toFixed(0)} m from the mouth`);
  // On opposite sides of the way in.
  const across=(f)=>(f.x-mouth.x)*(mouth.right.x-mouth.left.x)+(f.z-mouth.z)*(mouth.right.z-mouth.left.z);
  assert.ok(across(morro)*across(punta)<0,'one on each hand');
  const sj=portOn('san-juan',1650).port;
  const elMorro=named(sj,'Morro'),canuelo=named(sj,'Canuelo'),sjMouth=sj.harbour.mouth;
  assert.ok(distance(elMorro,sjMouth)<1000&&distance(canuelo,sjMouth)<1000,'San Juan closes its mouth from both sides');
});

test('off the chart, a record stands in for itself at the chart\'s nearest place, on the way out',()=>{
  const {port,region}=portOn('lisbon',1650);
  const belem=named(port,'Belém'),juliao=named(port,'Julião');
  assert.equal(belem.guards.source,'moved');
  assert.equal(juliao.guards.source,'moved');
  // Below the town, towards the sea, on the north bank as they really were.
  const town=port.center;
  assert.ok(belem.x<town.x-1500&&juliao.x<town.x-1500,`Belém ${belem.x-town.x|0} and São Julião ${juliao.x-town.x|0} are downriver of the town`);
  assert.ok(belem.z<region.z+region.span/2&&juliao.z<region.z+region.span/2);
  assert.ok(port.instances.some(i=>i.prefabId==='torreon_atalaya_farol'&&i.cairnSpec&&distance(i,belem)<80),'the Tower of Belém stands by its battery');
  assert.equal(fortRecordsFor('jamestown',1650).forts.some(f=>f.name.includes('Algernon')),false,'sixty kilometres off is no part of this harbour');
});

test('a fort looks at the water it guards, and its gate looks away from it or to the town',()=>{
  const seen=[];
  for(const [id,year] of [['havana',1650],['san-juan',1650],['cartagena',1650],['lisbon',1650],['jamestown',1650],['new-amsterdam',1650],['boston',1650],['goa',1650],['coro',1650]]){
    const {port,heights,region}=portOn(id,year);
    for(const fort of fortsOf(port)){
      const water=nearestWater(fort,heights,region),[lx,lz]=lookOf(fort),dx=water.x-fort.x,dz=water.z-fort.z,length=Math.hypot(dx,dz)||1;
      const plan=fort.trace?.gate??enclosurePlan(fort)?.gate;
      assert.ok(plan,`${fort.label} has a gate`);
      const c=Math.cos(fort.yaw),s=Math.sin(fort.yaw),gx=plan.nx*c+plan.nz*s,gz=-plan.nx*s+plan.nz*c;
      const toTown=[port.center.x-fort.x,port.center.z-fort.z],townLength=Math.hypot(...toTown)||1;
      seen.push({label:`${id}: ${fort.label}`,riverGate:fort.gateSide===0,facing:(lx*dx+lz*dz)/length,away:-(gx*dx+gz*dz)/length,towards:(gx*toTown[0]+gz*toTown[1])/townLength});
    }
  }
  assert.ok(seen.length>=18,`${seen.length} forts`);
  // Nearly every sea face has water before it. A fort squares up to the channel, which is not always the nearest shore.
  const facing=seen.filter(f=>f.facing>0);
  assert.ok(facing.length>=seen.length*.8,`only ${facing.length} of ${seen.length} look towards water: ${seen.filter(f=>f.facing<=0).map(f=>f.label).join('; ')}`);
  for(const fort of seen)assert.ok(fort.riverGate||fort.away>-.6||fort.towards>.2,`${fort.label}: its gate opens on the water (${fort.away.toFixed(2)}, ${fort.towards.toFixed(2)})`);
});

test("James Fort's main gate opens to the river, as Strachey says it did, and the way to it stays dry",()=>{
  const {port,heights,region}=portOn('jamestown',1650);
  const fort=fortsOf(port).find(f=>f.gateSide===0);
  assert.ok(fort,'the fort that holds the settlement has its gate in the river curtain');
  assert.match(fort.label,/James Fort/);
  const plan=enclosurePlan(fort),water=nearestWater(fort,heights,region),c=Math.cos(fort.yaw),s=Math.sin(fort.yaw);
  const gx=plan.gate.nx*c+plan.gate.nz*s,gz=-plan.gate.nx*s+plan.gate.nz*c,dx=water.x-fort.x,dz=water.z-fort.z;
  assert.ok((gx*dx+gz*dz)/(Math.hypot(dx,dz)||1)>.5,'it looks at the water');
  const out=fortLocalToWorld(fort,plan.gate.x+plan.gate.nx*6,plan.gate.z+plan.gate.nz*6);
  assert.ok(terrainSurfaceSample(heights,out.x,out.z,region)>0,'and there is bank to stand on outside it');
});

test('Jamestown, New Amsterdam and Boston: gate and river guns no longer point arbitrary ways',()=>{
  for(const id of ['jamestown','new-amsterdam','boston']){
    const {port}=portOn(id,1650),fort=port.instances.find(i=>enclosurePlan(i));
    const {heights,region}=portOn(id,1650),[lx,lz]=lookOf(fort),water=nearestWater(fort,heights,region),dx=water.x-fort.x,dz=water.z-fort.z,length=Math.hypot(dx,dz);
    assert.ok((lx*dx+lz*dz)/length>.6,`${id}: the river guns look at the water (cos ${((lx*dx+lz*dz)/length).toFixed(2)})`);
  }
});

test('guns have clear arcs: most of a fort\'s fire reaches the water in front of it',()=>{
  for(const [id,year] of [['havana',1650],['san-juan',1650],['goa',1650],['coro',1650],['boston',1650]]){
    const {port,heights,region}=portOn(id,year),geometry=buildPortPrefabGeometry(port);
    noteBuildingMeshes(port,geometry);
    for(const fort of fortsOf(port).filter(f=>f.trace)){
      const guns=createBuildingGunDefinitions(fort);
      let clear=0;
      for(const gun of guns){
        const pose=buildingGunMuzzlePose({...gun,elevation:0,offset:0},fort),c=Math.cos(fort.yaw),s=Math.sin(fort.yaw),[nx,,nz]=gun.directionDesign;
        const to=[pose.position[0]+(nx*c+nz*s)*300,1.1,pose.position[2]+(-nx*s+nz*c)*300];
        const from=[pose.position[0]+(nx*c+nz*s)*6,pose.position[1],pose.position[2]+(-nx*s+nz*c)*6];
        if(!sweepBuildingSegment(from,to,.08,port,{previewOnly:true,exact:true}))clear++;
      }
      assert.ok(clear>=guns.length*.5,`${id} ${fort.label}: ${clear} of ${guns.length} guns have a clear line out over their own wall`);
    }
  }
});

test('a gun has an arc: it holds fire at a mark behind its wall, and fires at one before it',()=>{
  const fort={id:'f',prefabId:'stone_sea_bastion',x:0,z:0,y:2,baseY:2,yaw:0,width:40,length:20,height:6,trace:{outline:[[-18,-8],[18,-8],[18,8],[-18,8]],kinds:['front','curtain','curtain','curtain'],salients:[],guns:[{x:0,z:-8,nx:0,nz:-1,wall:0,along:18}],buildings:[],gate:{wall:2,x:0,z:8,nx:0,nz:1,ux:-1,uz:0,halfWidth:1.9},lowZ:null,lowDrop:0}};
  const [gun]=createBuildingGunDefinitions(fort);
  assert.equal(buildingGunBears(gun,fort,0,-300),true,'dead ahead');
  assert.equal(buildingGunBears(gun,fort,200,-200),true,'45 degrees off');
  assert.equal(buildingGunBears(gun,fort,300,-20),false,'along its own wall');
  assert.equal(buildingGunBears(gun,fort,0,300),false,'behind it');
  const battery=createBuildingGunnery({...fort});
  assert.equal(battery.fireAtTarget({x:0,z:300,heave:0}),0,'no shot at a mark behind the wall');
  assert.equal(battery.fireAtTarget({x:0,z:-300,heave:0}),1,'one at a mark before it');
});

test('a fort on a narrow point follows it, and a battery lies along its shore',()=>{
  // A long thin spit running north from a straight shore.
  const size=257,span=8192,heights=new Float32Array(size*size);
  for(let j=0;j<size;j++)for(let i=0;i<size;i++){
    const x=(i/(size-1)-.5)*span,z=(j/(size-1)-.5)*span,spit=Math.abs(x)<70&&z<300&&z>-700;
    heights[j*size+i]=spit?5:z>300?(z-300)*.02+1:-8;
  }
  const region=resolveGlobalCoastalRegion({id:'test-spit',name:'Spit',latitude:18,longitude:-66,hasColonialPort:true,settlementKind:'colonial-port',foundedYear:1500,year:1650,shoreBearing:180,size,biomeSize:64,albedoSize:64,span,x:0,z:0,vegetationCandidates:100});
  const port=placeCoastalPort(region,heights,{preserveRealCoast:true});
  const forts=port.instances.filter(i=>i.trace);
  assert.ok(forts.length>=1,'the port has works');
  for(const fort of forts){
    let wet=0;
    for(const [lx,lz] of fort.trace.outline){const p=fortLocalToWorld(fort,lx,lz);if(Math.abs(p.x)>74&&p.z<298)wet++;}
    assert.ok(wet<=fort.trace.outline.length*.66,`${fort.label} has ${wet} of ${fort.trace.outline.length} walls off the land`);
    if(fort.trace.shape==='battery'){
      const walls=traceWalls(fort.trace).filter(w=>w.kind==='front'),along=walls.reduce((sum,w)=>sum+w.length,0);
      assert.ok(along>=fort.trace.outline.length*2,'its front runs a good way along the water');
    }
  }
});

test('plans differ with the ground: not one stamp per era',()=>{
  const shapes=new Set();
  for(const [id,year] of [['havana',1650],['san-juan',1650],['cartagena',1650],['lisbon',1650],['goa',1650],['boston',1650]]){
    for(const fort of fortsOf(portOn(id,year).port))if(fort.trace)shapes.add(fort.trace.shape);
  }
  for(const shape of ['headland','star','battery','drum'])assert.ok(shapes.has(shape),`some harbour has a ${shape}`);
  const {port}=portOn('havana',1650),a=named(port,'Morro'),b=named(port,'Punta');
  assert.notDeepEqual(a.trace.outline,b.trace.outline);
  assert.ok(a.length>a.width,`El Morro runs out along its point (${a.width.toFixed(0)} by ${a.length.toFixed(0)})`);
});

test('what the builder draws for a fort stays inside its footprint, so it reaches into no neighbour',()=>{
  for(const [id,year] of [['goa',1650],['tenerife',1650]].filter(([id])=>fs.existsSync(new URL(`${id}.bin.gz`,fixtures)))){
    const {port}=portOn(id,year);
    for(const fort of port.instances.filter(i=>i.trace)){
      const drawn=buildPortPrefabGeometry({instances:[fort]}),c=Math.cos(fort.yaw),s=Math.sin(fort.yaw),stride=drawn.vertices.length/(Math.max(...drawn.indices)+1);
      for(let v=0;v<drawn.vertices.length;v+=stride){
        const dx=drawn.vertices[v]-fort.x,dz=drawn.vertices[v+2]-fort.z;
        assert.ok(Math.abs(dx*c-dz*s)<=fort.width/2+.05&&Math.abs(dx*s+dz*c)<=fort.length/2+.05,`${fort.label} draws past its footprint at ${(dx*c-dz*s).toFixed(1)},${(dx*s+dz*c).toFixed(1)}`);
      }
    }
  }
});

test('no fort stands in another building, and no two piers share water',()=>{
  const obb=i=>{const c=Math.cos(i.yaw),s=Math.sin(i.yaw),hw=i.width/2,hl=i.length/2;return [[-hw,-hl],[hw,-hl],[hw,hl],[-hw,hl]].map(([x,z])=>[i.x+x*c+z*s,i.z-x*s+z*c]);};
  const apart=(a,b)=>{for(const shape of [a,b])for(let i=0;i<4;i++){const [px,pz]=shape[i],[qx,qz]=shape[(i+1)%4],nx=pz-qz,nz=qx-px;const span=l=>l.reduce(([lo,hi],[x,z])=>[Math.min(lo,x*nx+z*nz),Math.max(hi,x*nx+z*nz)],[Infinity,-Infinity]);const [al,ah]=span(a),[bl,bh]=span(b);if(al>=bh-1e-6||bl>=ah-1e-6)return true;}return false;};
  for(const id of ['havana','san-juan','cartagena','lisbon','jamestown','new-amsterdam','boston','goa','coro'])for(const year of [1600,1689]){
    const {port}=portOn(id,year);
    for(const fort of port.instances.filter(i=>i.trace))for(const other of port.instances){
      if(other===fort||other.prefabId==='torreon_atalaya_farol'&&other.cairnSpec)continue;
      assert.ok(apart(obb(fort),obb(other)),`${id} ${year}: ${fort.label} stands in ${other.prefabId} "${other.label}"`);
    }
    const piers=port.instances.filter(i=>i.prefabId==='timber_mole_pier');
    for(let i=0;i<piers.length;i++)for(let j=i+1;j<piers.length;j++)assert.ok(apart(obb(piers[i]),obb(piers[j])),`${id} ${year}: two piers overlap`);
  }
  // On the made-up coasts too, in the years the survey found them meeting.
  for(const [id,year] of [['lisbon',1550],['lisbon',1650]]){
    const {port}=generateProceduralCoastalPack({id,year,size:129,biomeSize:64,albedoSize:64,vegetationCandidates:100});
    const piers=port.instances.filter(i=>i.prefabId==='timber_mole_pier');
    for(let i=0;i<piers.length;i++)for(let j=i+1;j<piers.length;j++)assert.ok(apart(obb(piers[i]),obb(piers[j])),`${id} ${year}: two piers overlap`);
  }
});

test('every fort in every port year has a job and a garrison, on any coast',{timeout:300000},()=>{
  let forts=0;
  for(const port of HISTORICAL_COLONIAL_PORTS)for(const year of [port.foundedYear+40,1689]){
    if(year<port.foundedYear||year>1689)continue;
    const region=resolveGlobalCoastalRegion({id:port.id,year,size:129,biomeSize:64,albedoSize:64,vegetationCandidates:100});
    if(region.hasColonialPort===false)continue;
    const placed=placeCoastalPort(region,synthesizeCoastalTerrain(region));
    const garrison=createFortGarrison(placed);
    for(const fort of fortsOf(placed)){
      if(fort.indigenous)continue;
      forts++;
      assert.ok(fort.guards?.what,`${port.id} ${year}: ${fort.label} says what it guards`);
      assert.ok(createBuildingGunDefinitions(fort).length>=3,`${port.id} ${year}: ${fort.label} has guns`);
      assert.ok(garrison.soldiers.filter(s=>s.building===fort).length>=4,`${port.id} ${year}: ${fort.label} has men`);
      assert.equal(classifyBuildingMaterial(fort),fort.prefabId==='english_triangular_palisade_fort'?'timber':'fortified-stone');
    }
  }
  assert.ok(forts>=80,`${forts} forts`);
});

test('a sovereign Indigenous town keeps its own works, and a palisade town gets no European fort',()=>{
  const pack=generateProceduralCoastalPack({latitude:41.2,longitude:-72,year:1650,size:65,biomeSize:64,albedoSize:64,vegetationCandidates:100,hasColonialPort:false});
  for(const inst of pack.port.instances){
    assert.equal(inst.trace,undefined,`${inst.prefabId} was not drawn as a European trace`);
    if(!inst.indigenous)continue;
    assert.ok(!['bastion_trace_fortress','english_triangular_palisade_fort'].includes(inst.prefabId));
  }
  assert.equal(pack.port.harbour,null,'and no one reads its harbour for forts');
});

test('a fort drawn to its ground still comes apart in blocks and earth, and its walls stay on its line',()=>{
  const {port,heights,region}=portOn('havana',1650),fort=named(port,'Morro'),geometry=buildPortPrefabGeometry(port);
  const fracture=prepareBuildingFracture({vertices:geometry.vertices,indices:geometry.indices,catalog:geometry.partAssembly,instanceIndex:port.instances.indexOf(fort),instance:fort,materialClass:'fortified-stone',groundAt:(x,z)=>Math.max(0,fort.y-8)}).fracture;
  const kinds=fracture.shards.filter(Boolean);
  assert.ok(kinds.filter(s=>s.kind===1).length>200,`${kinds.length} shards`);
  assert.ok(kinds.some(s=>s.earth),'earth behind the facing');
  assert.ok(kinds.some(s=>s.kind===4),'guns as pieces');
  assert.ok(kinds.some(s=>s.floorSlab),'paving slabs on the terreplein floor');
  const wall=fort.trace.guns[0],c=Math.cos(fort.yaw),s=Math.sin(fort.yaw),outX=wall.nx*c+wall.nz*s,outZ=-wall.nx*s+wall.nz*c,at=fortLocalToWorld(fort,wall.x,wall.z);
  const report=applyBuildingImpactDamage(fort,{position:[at.x,(fort.baseY??fort.y)+2.5,at.z],surfacePosition:[at.x,(fort.baseY??fort.y)+2.5,at.z],localPosition:[wall.x,2.5,wall.z],normal:[outX,0,outZ],velocity:[-outX*300,0,-outZ*300],mass:14.5,ammo:'round',energy:900000});
  assert.ok(report);
  const released=applyBuildingFractureEvents(fracture,fort.damageState,fort.damageState.pendingBakes.splice(0),0);
  assert.ok(released>0,'a ball takes stones out of the wall');

  // Castelo de São Jorge uphill from Lisboa: cannonfire striking its interior terreplein floor blasts out paving slabs.
  const lisbon=portOn('lisbon',1550).port,castelo=named(lisbon,'Jorge'),lisbonGeom=buildPortPrefabGeometry(lisbon);
  noteBuildingMeshes(lisbon,lisbonGeom);
  const casteloFracture=prepareBuildingFracture({vertices:lisbonGeom.vertices,indices:lisbonGeom.indices,catalog:lisbonGeom.partAssembly,instanceIndex:lisbon.instances.indexOf(castelo),instance:castelo,materialClass:'fortified-stone',groundAt:()=>castelo.y}).fracture;
  const deckY=(castelo.baseY??castelo.y)+castelo.height-0.85;
  const floorHit=sweepBuildingSegment([castelo.x,deckY+12,castelo.z+8],[castelo.x,deckY-6,castelo.z-4],0.08,lisbon);
  assert.ok(floorHit&&floorHit.building===castelo,'a plunging shot strikes Castelo de São Jorge');
  assert.equal(floorHit.floorHit,true,'and is recognized as a fort floor strike');
  const hitWorld=fortLocalToWorld(castelo,floorHit.localPosition[0],floorHit.localPosition[2]);
  applyBuildingImpactDamage(castelo,{...floorHit,position:[hitWorld.x,deckY,hitWorld.z],surfacePosition:[hitWorld.x,deckY,hitWorld.z],velocity:[0,-260,-180],mass:10.9,ammo:'round',energy:545000});
  const floorReleased=applyBuildingFractureEvents(casteloFracture,castelo.damageState,castelo.damageState.pendingBakes.splice(0),0);
  assert.ok(floorReleased>=1,`cannonball blasts ${floorReleased} paving slabs out of Castelo de São Jorge's floor`);
  assert.ok(casteloFracture.floorAt(hitWorld.x,hitWorld.z,deckY+0.5)>=deckY-0.05,'the underlying rampart floor still holds men and rubble');
});

test('an old save whose fort has moved does not crash: the fort stands whole and the record just waits',()=>{
  const {port}=portOn('havana',1650),fort=named(port,'Morro'),index=port.instances.indexOf(fort);
  const name=`${fort.prefabId}_${index}`;
  // As an older game saved a fort: the same building, somewhere else, with no plan key.
  const moved={p:fort.prefabId,x:fort.x+900,z:fort.z-400,s:'damaged',i:.6,j:900000,h:9,b:1,t:0,g:1,c:0,f:0,a:null,l:'AAAAAAAAAAAAAAAA',d:[0,1,99]};
  const samePlace={...moved,x:Math.round(fort.x),z:Math.round(fort.z)};
  for(const record of [moved,samePlace]){
    const copy={...port,instances:port.instances.map(i=>({...i,damageState:null,magazine:null}))};
    const store=createPortDamageStore({[copy.regionId]:{[name]:record}},{dateMs:0});
    assert.equal(store.restore(copy),0,'nothing is applied');
    assert.equal(copy.instances[index].damageState,null,'it stands whole');
    assert.doesNotThrow(()=>store.snapshot([copy]));
  }
  // A save made with this plan comes back on it.
  const live={...port,instances:port.instances.map(i=>({...i,damageState:null,magazine:null}))},target=live.instances[index];
  const first=createPortDamageStore(null,{dateMs:0});
  applyBuildingImpactDamage(target,{position:[target.x,target.y+2,target.z],surfacePosition:[target.x,target.y+2,target.z],localPosition:[0,2,0],normal:[0,0,-1],velocity:[0,0,300],mass:14.5,ammo:'round',energy:900000});
  const saved=first.snapshot([live]),record=saved[live.regionId][name];
  assert.ok(record.k,'the record says which plan');
  const again={...port,instances:port.instances.map(i=>({...i,damageState:null,magazine:null}))};
  assert.equal(createPortDamageStore(JSON.parse(JSON.stringify(saved)),{dateMs:0}).restore(again),1,'and matches');
});

test('enclosure plans keep their houses clear whichever side their gate is on',()=>{
  for(const plan of [triangularFortPlan(118,90,-1),triangularFortPlan(118,90,1),squareFortPlan(96,86)]){
    assert.ok(plan.gate,'it has a gate');
    assert.ok(plan.gate.nz>0,'it looks inland');
    assert.equal(plan.gateEdges.length,2);
    assert.ok(plan.wallSpans.length>=plan.curtains.length+1,'its curtain is cut for it');
    for(const [x,z] of [plan.hallSlot,...plan.cottageSlots])assert.ok(depthInOutline(plan.outline,x,z)>6,`a house at ${x},${z} is inside`);
  }
});

test('the record has what the game needs: every fort a place, a job and a date',()=>{
  const ids=new Set(HISTORICAL_COLONIAL_PORTS.map(p=>p.id));
  for(const [id,record] of Object.entries(FORT_RECORDS)){
    assert.ok(ids.has(id),`${id} is a port`);
    for(const fort of record.forts){
      assert.ok(Number.isFinite(fort.lat)&&Number.isFinite(fort.lon)&&fort.from>=1000,`${id}: ${fort.name}`);
      assert.ok(['mouth','narrows','headland','river','waterfront','island','citadel'].includes(fort.role),`${id}: ${fort.name} ${fort.role}`);
      assert.ok(['star','headland','battery','drum','islet','fitted'].includes(fort.shape),`${id}: ${fort.name} ${fort.shape}`);
      const port=HISTORICAL_COLONIAL_PORTS.find(p=>p.id===id);
      assert.ok(Math.hypot(fort.lat-port.latitude,(fort.lon-port.longitude)*Math.cos(port.latitude*Math.PI/180))*111<25,`${id}: ${fort.name} is within 25 km of its port`);
    }
  }
  assert.ok(Object.keys(FORT_RECORDS).length>=40);
  assert.ok(getBuildingParts('bastion_trace_fortress').vertexCount>1000,'the catalog fort still builds with no trace');
});

test('fort cannons sit flush on their banquettes and bulwarks, clear of stone merlons and parapets',()=>{
  for(const [prefabId,minFloor] of [['stone_sea_bastion',11.3],['bastion_trace_fortress',9.6],['english_triangular_palisade_fort',3.8]]){
    const parts=getBuildingParts(prefabId);
    const cannonGroups=parts.groups.filter(g=>g.partKey==='fort_cannon');
    assert.ok(cannonGroups.length>=4,`${prefabId} has individual fort_cannon parts (${cannonGroups.length})`);
    const instance={prefabId,x:0,z:0,y:0,baseY:0,yaw:0,...parts.dimensions};
    const {fracture}=prepareBuildingFracture({vertices:parts.vertices,indices:parts.indices,catalog:parts.partAssembly,instanceIndex:0,instance,materialClass:classifyBuildingMaterial(prefabId),groundAt:()=>0});
    assert.equal(fracture.guns.length,cannonGroups.length,`${prefabId} maps every fort_cannon to its own gun shard`);
    for(const s of fracture.guns){
      const gun=fracture.shards[s];
      assert.ok(gun.min[1]>=minFloor&&gun.min[1]<=minFloor+0.15,`${prefabId} gun ${s} sits flush on its platform (${gun.min[1].toFixed(2)})`);
      assert.equal(gun.anchored,false,`${prefabId} gun ${s} rests on its platform shards rather than floating anchored`);
      assert.ok(gun.below.length>=1,`${prefabId} gun ${s} is supported from below`);
    }
  }
  for(const [id,year] of [['lisbon',1650],['havana',1650],['san-juan',1650]]){
    const {port}=portOn(id,year),geometry=buildPortPrefabGeometry(port);
    for(const fort of fortsOf(port).filter(f=>f.trace)){
      const instanceIndex=port.instances.indexOf(fort);
      const {fracture,vertices}=prepareBuildingFracture({vertices:geometry.vertices,indices:geometry.indices,catalog:geometry.partAssembly,instanceIndex,instance:fort,materialClass:'fortified-stone',groundAt:()=>fort.y});
      assert.equal(fracture.guns.length,fort.trace.guns.length,`${id} ${fort.label}: every traced gun is an individual gun shard`);
      const walls=traceWalls(fort.trace);
      const merlonVerts=[];
      for(let v=0;v<fracture.vertexShards.length;v++){
        const s=fracture.vertexShards[v];
        if(s&&fracture.shards[s].partKey==='parapet_merlons'){
          merlonVerts.push(fracture.toLocal(vertices[v*8],vertices[v*8+1],vertices[v*8+2]));
        }
      }
      for(const gun of fort.trace.guns){
        const wall=walls[gun.wall];
        for(const [mx,my,mz] of merlonVerts){
          const along=(mx-wall.ax)*wall.ux+(mz-wall.az)*wall.uz;
          const depth=-(mx-wall.ax)*wall.nx-(mz-wall.az)*wall.nz;
          if(depth>=-0.05&&depth<=1.8){
            assert.ok(Math.abs(along-gun.along)>0.65,`${id} ${fort.label}: merlon vertex at along=${along.toFixed(2)} clears gun embrasure at ${gun.along.toFixed(2)}`);
          }
        }
      }
    }
  }
});

test('a hill citadel stands on its hill where the record puts it, however high and far from the water',()=>{
  // A shore running east and west with the sea to the south, a low shelf for the town, and the record's place on a
  // level height behind it. São Filipe stands 120 m up, and San Antonio was said in 1668 to be too far from the coast.
  for(const [id,piece,inland,high] of [['ribeira-grande','Filipe',900,95],['cumana','San Antonio',1100,60]]){
    const region=resolveGlobalCoastalRegion({id,year:1689,size:257,biomeSize:64,albedoSize:64,vegetationCandidates:100});
    const record=FORT_RECORDS[id].forts.find(f=>f.name.includes(piece)),truth=worldOfPosition(region,record.lat,record.lon);
    assert.equal(record.role,'citadel');
    const n=region.size,heights=new Float32Array(n*n),shoreZ=truth.z+inland;
    for(let j=0;j<n;j++)for(let i=0;i<n;i++){
      const d=shoreZ-(region.z+(j/(n-1)-.5)*region.span);
      heights[j*n+i]=d<0?Math.max(-30,d*.05-1):d<350?1+d*.02:d<500?8+(d-350)/150*(high-8):high;
    }
    const harbour=readHarbourGeography(heights,region,{town:{x:truth.x,z:shoreZ-60},seaward:180});
    const plan=planHarbourDefences({harbour,region,portId:id,year:1689,coastIsReal:true,stage:'colony'});
    const fort=plan.forts.find(f=>f.name.includes(piece));
    assert.ok(fort,`${id}: ${piece} stands`);
    assert.equal(fort.source,'record',`${id}: ${piece} is sited by its record`);
    assert.ok(distance(fort.spot,truth)<=64,`${id}: ${piece} stands ${distance(fort.spot,truth).toFixed(0)} m from its place`);
    assert.ok(fort.spot.h>=high-1,`${id}: ${piece} stands on its height, at ${fort.spot.h.toFixed(0)} m of ${high}`);
  }
});

test('Lisbon keeps its castle beside the town and its battery at the water, by limits its own record carries',()=>{
  const castle=FORT_RECORDS.lisbon.forts.find(f=>f.name.includes('Jorge'));
  assert.ok(castle.waterWithinM<=500&&castle.groundBelowM<=50&&castle.command>0,'the castle is held near the water and low by its record');
  for(const [id,port] of Object.entries(FORT_RECORDS))for(const record of port.forts){
    if(record!==castle)assert.ok(record.waterWithinM===undefined&&record.groundBelowM===undefined&&record.command===undefined,`${id}: ${record.name} goes by the general limits`);
  }
  for(const year of [1550,1650]){
    const {port,region,heights}=portOn('lisbon',year),fort=named(port,'Jorge'),battery=named(port,'Baluarte da Ribeira');
    assert.equal(fort.guards.source,'record');
    assert.ok(terrainSurfaceSample(heights,fort.x,fort.z,region)<=castle.groundBelowM,`the castle stands on ${terrainSurfaceSample(heights,fort.x,fort.z,region).toFixed(0)} m`);
    const houses=port.instances.filter(i=>!FORT_PREFABS.has(i.prefabId)&&!i.homeFortId&&i.category!=='infrastructure'&&distance(i,port.center)<600);
    const nearest=Math.min(...houses.map(i=>distance(i,fort)));
    assert.ok(nearest<=220,`the castle stands ${nearest.toFixed(0)} m from the nearest of ${houses.length} town buildings`);
    assert.equal(battery.guards.source,'record');
    assert.ok(nearestWater(battery,heights,region).d<=120,`the battery stands ${nearestWater(battery,heights,region).d.toFixed(0)} m from the water`);
  }
});

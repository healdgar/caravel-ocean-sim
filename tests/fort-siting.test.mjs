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
import {worldOfPosition} from '../js/harbour-defences.js';
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

test('a sovereign Indigenous town keeps its own works, and a palisade town gets no European fort',()=>{
  const pack=generateProceduralCoastalPack({latitude:41.2,longitude:-72,year:1650,size:65,biomeSize:64,albedoSize:64,vegetationCandidates:100,hasColonialPort:false});
  for(const inst of pack.port.instances){
    assert.equal(inst.trace,undefined,`${inst.prefabId} was not drawn as a European trace`);
    if(!inst.indigenous)continue;
    assert.ok(!['bastion_trace_fortress','english_triangular_palisade_fort'].includes(inst.prefabId));
  }
  assert.equal(pack.port.harbour,null,'and no one reads its harbour for forts');
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

// The forts, batteries and watchtowers of a coast are its board's: the bake gathers what the record stands on its
// ground (scripts/bake-board.mjs), Castle and Commons sets each (scripts/board-forts.mjs) and the board builds it of
// the wall's own types (js/old-world-board.js). No port sites a fort of its own.
test('the forts the record names are works of the board, each on its ground, turned to the water',()=>{
  const baked=JSON.parse(fs.readFileSync(new URL('../assets/boards/san-juan-1550.json',import.meta.url),'utf8'));
  const works=baked.board.places.flatMap((place)=>place.works??[]);
  assert.deepEqual(works.map((work)=>work.name).sort(),['Castillo San Felipe del Morro','La Fortaleza']);
  for(const work of works)assert.ok(Number.isFinite(work.turn)&&work.face!==null,work.name);
  assert.deepEqual(baked.request.works.map((work)=>work.name).sort(),works.map((work)=>work.name).sort());
});

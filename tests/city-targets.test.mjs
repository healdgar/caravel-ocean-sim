// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// A city's houses, churches, towers and walls are drawn by the thousand and are no buildings of the port.
// Shot must still strike them, break them up as it does a port's own buildings, and leave a record of it.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildPortPrefabGeometry} from '../js/coastal-world.js';
import {oldWorldCountry} from '../js/old-world.js';
import {CITY_BLOCK_FLOATS} from '../js/old-world-city.js';
import {CITY_BUILDING_TYPES,CITY_HOUSE_TYPES,CITY_TYPE,CITY_TYPED_FLOATS,CITY_TYPED_ROOF,cityTypeTarget,compileCityBuildingTypes} from '../js/old-world-buildings.js';
import {createCityTargets,standCityBuildingMesh} from '../js/city-targets.js';
import {applyBuildingFractureEvents,buildingFractureStateOf,buildingKindWithYaw,buildingReach,prepareBuildingFracture} from '../js/building-fracture.js';
import {applyBuildingImpactDamage,classifyBuildingMaterial,sweepBuildingSegment} from '../js/gunnery-control.js';
import {createPortDamageStore} from '../js/port-damage.js';

// The shore the plan's own tests use: sea to the south, ground rising inland, a height the town can climb.
function shore(){
  const region={id:'test-shore',latitude:38.7,longitude:-9.14,x:0,z:0,span:4096,size:257,biomeSize:128,albedoSize:256};
  const n=region.size,heights=new Float32Array(n*n);
  for(let j=0;j<n;j++)for(let i=0;i<n;i++){
    const x=(i/(n-1)-.5)*region.span,z=(j/(n-1)-.5)*region.span;
    const hill=90*Math.exp(-((x-700)**2+(z+650)**2)/(2*170**2)),height=70*Math.exp(-((x+450)**2+(z+520)**2)/(2*330**2));
    heights[j*n+i]=z>0?-4-z*.01:1.5-z*.02+hill+height;
  }
  return {region,heights,port:{id:'test-port',center:{x:0,z:-30},clearRadius:150,instances:[]}};
}
const types=compileCityBuildingTypes(buildPortPrefabGeometry);
const {region,heights,port:planPort}=shore(),plan=oldWorldCountry(region,heights,planPort).plan;
const record=index=>plan.typed.subarray(index*CITY_TYPED_FLOATS,(index+1)*CITY_TYPED_FLOATS);
const firstOf=wanted=>plan.typedTypes.findIndex(type=>wanted(type));
// Straight down through the middle of a building, from well above its roof to below its floor.
const plumb=index=>{const t=record(index),top=t[1]+types[plan.typedTypes[index]].source.max[1]*t[5];return [[t[0],top+40,t[2]],[t[0],t[1]-2,t[2]]];};
const freshPort=()=>({id:'test-port',center:{x:0,z:-30},instances:[{id:'quay',prefabId:'stone_quay_seawall',x:0,z:-30,yaw:0}]});

test('every block of the plan belongs to one typed building, and each type keeps the mesh it was built from',()=>{
  assert.equal(plan.typedBlocks.length,plan.typedCount*2);
  const owner=new Int32Array(plan.count).fill(-1);
  for(let i=0;i<plan.typedCount;i++){
    const first=plan.typedBlocks[i*2],own=plan.typedBlocks[i*2+1],t=record(i),source=types[plan.typedTypes[i]].source;
    assert.ok(own>=1&&first+own<=plan.count);
    const reach=Math.hypot(Math.max(-source.min[0],source.max[0])*t[4],Math.max(-source.min[2],source.max[2])*t[6])+1.5;
    for(let b=first;b<first+own;b++){
      assert.equal(owner[b],-1,'a block has one owner');owner[b]=i;
      const k=b*CITY_BLOCK_FLOATS;
      assert.ok(plan.blocks[k+8]>=CITY_TYPED_ROOF,'a block a type replaces is marked so');
      assert.ok(Math.hypot(plan.blocks[k]-t[0],plan.blocks[k+2]-t[2])<=reach,`${CITY_BUILDING_TYPES[plan.typedTypes[i]].name}: its block stands within it`);
    }
  }
  assert.ok(owner.every(i=>i>=0),'no block is left that shot could not bring down');
  for(const type of types){
    const {vertices,indices,partAssembly,min,max}=type.source;
    assert.equal(vertices.length%8,0);assert.equal(indices.length%3,0);
    assert.equal(partAssembly.trianglePartIds.length,indices.length/3);
    assert.ok(min[1]<-6&&max[1]>=type.height&&min[0]<0&&max[0]>0&&min[2]<0&&max[2]>0);
  }
  // The wall and its towers are fortified stone to the guns; houses and churches are masonry.
  assert.equal(classifyBuildingMaterial(cityTypeTarget(CITY_TYPE.CURTAIN_LONG)),'fortified-stone');
  assert.equal(classifyBuildingMaterial(cityTypeTarget(CITY_TYPE.KEEP)),'fortified-stone');
  assert.equal(classifyBuildingMaterial(cityTypeTarget(CITY_TYPE.HOUSE_EAVES+2)),'masonry');
  assert.equal(classifyBuildingMaterial(cityTypeTarget(CITY_TYPE.CHURCH_GREAT)),'masonry');
});

test('a type stood in the world is the mesh the land shader would draw of it',()=>{
  const index=firstOf(type=>type<CITY_HOUSE_TYPES),t=record(index),source=types[plan.typedTypes[index]].source;
  const world=standCityBuildingMesh(source,t[0],t[1],t[2],t[3],t[4],t[5],t[6]),c=Math.cos(t[3]),s=Math.sin(t[3]);
  assert.equal(world.length,source.vertices.length);
  let stone=0,glass=0;
  for(let at=0;at<world.length;at+=8){
    const px=source.vertices[at]*t[4],pz=source.vertices[at+2]*t[6];
    assert.ok(Math.abs(world[at]-(t[0]+px*c+pz*s))<1e-3&&Math.abs(world[at+1]-(t[1]+source.vertices[at+1]*t[5]))<1e-3&&Math.abs(world[at+2]-(t[2]-px*s+pz*c))<1e-3);
    assert.ok(Math.abs(Math.hypot(world[at+3],world[at+4],world[at+5])-1)<.02,'a unit normal');
    const kind=Math.floor(world[at+6]+.01);
    assert.equal(kind,Math.floor(source.vertices[at+6]+.01));
    if(kind===14){assert.equal(world[at+6],source.vertices[at+6]);glass++;}
    // Stone is laid along the wall as the fracture lays what a breach shows.
    else if(kind===11&&Math.abs(source.vertices[at+6]-11.02)<1e-4){assert.ok(Math.abs(world[at+6]-buildingKindWithYaw(11,t[3]))<1e-4);stone++;}
  }
  assert.ok(stone>0&&glass>0);
});

test('shot meets a city building, which only then becomes a building of the port',()=>{
  const port=freshPort(),targets=createCityTargets({city:plan,types:()=>types,port});
  assert.equal(targets.count,plan.typedCount);
  const house=firstOf(type=>type<CITY_HOUSE_TYPES),[from,to]=plumb(house);
  // Over the sea, and high over the town: nothing, and nothing made ready.
  assert.equal(targets.sweep([0,5,400],[60,5,460],.08,null,sweepBuildingSegment),null);
  assert.equal(targets.sweep([from[0]-80,900,from[2]],[from[0]+80,900,from[2]],.08,null,sweepBuildingSegment),null);
  assert.equal(targets.standing,0);
  // Aiming at it names it and changes nothing.
  const aimed=targets.sweep(from,to,.08,{previewOnly:true,exact:true},sweepBuildingSegment);
  assert.equal(aimed?.kind,'building');assert.equal(aimed.building.city.index,house);
  assert.equal(port.instances.length,1);assert.equal(aimed.building.damageState,undefined);
  // A ball strikes its roof, not the ground under it.
  const hit=targets.sweep(from,to,.08,null,sweepBuildingSegment),t=record(house);
  assert.equal(hit.building,aimed.building);
  assert.equal(hit.building.id,`city_${house}`);assert.equal(hit.prefabId,'city_house');assert.equal(hit.buildingName,'Town house');
  const struckY=from[1]+(to[1]-from[1])*hit.fraction;
  assert.ok(struckY>t[1]+2&&struckY<from[1]-39,`struck at ${struckY}, floor ${t[1]}`);
  assert.deepEqual(port.instances.slice(1),[hit.building]);
  targets.sweep(from,to,.08,null,sweepBuildingSegment);
  assert.equal(port.instances.length,2,'it joins once');
  // It is as large as the plan made it, and its reach is its mesh's.
  const T=types[plan.typedTypes[house]],reach=buildingReach(hit.building);
  assert.ok(Math.abs(hit.building.width-T.width*t[4])<1e-3&&Math.abs(hit.building.height-T.height*t[5])<1e-3&&Math.abs(hit.building.depth-T.length*t[6])<1e-3);
  assert.ok(reach.min[1]<t[1]-6&&reach.max[1]>t[1]+hit.building.height);
  // A tower of the wall, struck from the side, is fortified stone.
  const tower=firstOf(type=>type===CITY_TYPE.WALL_TOWER),w=record(tower),y=w[1]+6;
  const side=targets.sweep([w[0]-9,y,w[2]],[w[0]+9,y,w[2]],.08,null,sweepBuildingSegment);
  assert.equal(side.building.city.index,tower);assert.equal(classifyBuildingMaterial(side.building),'fortified-stone');
  assert.ok(side.fraction>.2&&side.fraction<.5,`met its face at ${side.fraction}`);
  // A line down a street passes many houses; those it only passes are kept ready, a few at a time.
  for(let i=0;i<plan.typedCount&&i<400;i++){const [a,b]=plumb(i);targets.sweep(a,b,.08,{previewOnly:true},sweepBuildingSegment);}
  assert.ok(targets.standing<=48+port.instances.length,`${targets.standing} standing`);
});

test('a struck city building breaks up as a port building does, and is put back from its record',()=>{
  const port=freshPort(),targets=createCityTargets({city:plan,types:()=>types,port}),store=createPortDamageStore(null,{dateMs:Date.UTC(1580,5,1)});
  // A plain house of three floors with nothing between it and a gun twenty metres up its street.
  const shot=index=>{const t=record(index),c=Math.cos(t[3]),s=Math.sin(t[3]),y=t[1]+4.4;return{t,c,s,y,from:[t[0]-20*s,y,t[2]-20*c],to:[t[0]+20*s,y,t[2]+20*c],d:[s,0,c]};};
  const house=plan.typedTypes.findIndex((type,index)=>type===CITY_TYPE.HOUSE_EAVES+2&&(q=>targets.sweep(q.from,q.to,.08,null,sweepBuildingSegment)?.building?.city?.index===index)(shot(index)));
  assert.ok(house>=0,'a three-storey house with a clear street before it');
  // From the street, square on to its front, at its first floor.
  const{t,c,s,y,from,to,d}=shot(house);
  const first=targets.sweep(from,to,.08,null,sweepBuildingSegment);
  assert.equal(first.building.city.index,house);
  const instance=first.building,source=instance.fractureSource();
  const prepared=prepareBuildingFracture({vertices:source.vertices,indices:source.indices,catalog:source.partAssembly,instanceIndex:0,instance,
    materialClass:classifyBuildingMaterial(instance),groundAt:()=>t[1]});
  assert.ok(prepared.fracture.shards.length>200,`${prepared.fracture.shards.length} pieces`);
  applyBuildingImpactDamage(instance,{...first,mass:10.9,ammo:'round',velocity:[d[0]*420,0,d[2]*420],energy:961000});
  buildingFractureStateOf(instance.damageState,prepared.fracture);
  let broke=applyBuildingFractureEvents(prepared.fracture,instance.damageState,instance.damageState.pendingBakes.splice(0),0);
  // Shot after shot at the same place goes deeper: the breach is real to the next ball.
  let deepest=first.fraction;
  for(let n=1;n<10;n++){
    const hit=targets.sweep(from,to,.08,null,sweepBuildingSegment);
    if(!hit)break;
    deepest=Math.max(deepest,hit.fraction);
    applyBuildingImpactDamage(instance,{...hit,mass:10.9,ammo:'round',velocity:[d[0]*420,0,d[2]*420],energy:961000});
    broke+=applyBuildingFractureEvents(prepared.fracture,instance.damageState,instance.damageState.pendingBakes.splice(0),n);
  }
  assert.ok(broke>10,`${broke} pieces left it`);
  assert.ok(deepest>first.fraction+.005,`the tenth ball met it no deeper than the first: ${first.fraction} to ${deepest}`);
  assert.ok(instance.damageState.hits>=2&&instance.damageState.integrity<1);
  // Out of sight and back: a new port, a new plan of the same town, the same building down.
  store.capture(port);
  const names=store.recorded(port);
  assert.deepEqual(names,[`city_${house}`]);
  const again=freshPort(),revived=createCityTargets({city:plan,types:()=>types,port:again});
  assert.equal(revived.revive([...names,'prop:3','city_99999999','quay']),1);
  assert.equal(again.instances.length,2);
  assert.equal(store.restore(again),1);
  const back=again.instances[1];
  assert.equal(back.city.index,house);assert.equal(back.damageState.hits,instance.damageState.hits);
  assert.ok(back.damageState.replayLog?.length>=16,'its hits are there to replay');
  // And the town rebuilds it: the record goes, and it stands whole to the next shot.
  store.rebuilt(again,back);
  assert.deepEqual(store.recorded(again),[]);
  assert.equal(back.damageState.hits,0);
});

test('whoever walks the city is told where its buildings stand: within their walls, not in the street beside',()=>{
  const targets=createCityTargets({city:plan,types:()=>types,port:freshPort()});
  let asked=0,streets=0;
  for(let i=0;i<plan.typedCount&&asked<40;i+=Math.max(1,Math.floor(plan.typedCount/40))){
    const t=record(i),source=types[plan.typedTypes[i]].source;asked++;
    // The middle of its floor is within it, however it is turned.
    const c=Math.cos(t[3]),s=Math.sin(t[3]),mx=(source.min[0]+source.max[0])*.5*t[4],mz=(source.min[2]+source.max[2])*.5*t[6];
    assert.ok(targets.inside(t[0]+mx*c+mz*s,t[2]-mx*s+mz*c),`the middle of building ${i} is within it`);
    // Well beyond its farthest corner in one direction is either open ground or another building, never this one's doing.
    const reach=Math.hypot(Math.max(-source.min[0],source.max[0])*t[4],Math.max(-source.min[2],source.max[2])*t[6])+60;
    if(!targets.inside(t[0]+reach,t[2]))streets++;
  }
  assert.ok(asked>=20&&streets>=asked*.5,`${streets} of ${asked} points beyond a building are open ground`);
  assert.equal(targets.inside(1e6,1e6),false);
});

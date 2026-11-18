import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildPortPrefabGeometry,generateProceduralCoastalPack} from '../js/coastal-world.js';
import {OLD_WORLD_LAND,OLD_WORLD_CITIES,OLD_WORLD_NO_TREES,inIberia,oldWorldPeople,oldWorldCityNear,oldWorldHolding,
  oldWorldHoldingSeat,oldWorldCountry} from '../js/old-world.js';
import {CITY_BLOCK_FLOATS,CITY_GROUND,CITY_ROOF,CITY_TREES,CITY_WALL,cityFootprintsOverlap} from '../js/old-world-city.js';
import {streetEdgeAt} from '../js/town-streets.js';
import {CITY_BUILDING_TYPES,CITY_CHURCH,CITY_GATE,CITY_HOUSE_STOREYS,CITY_HOUSE_TYPES,CITY_TYPE,CITY_TYPE_SLIGHT_FROM,CITY_TYPED_FLOATS,CITY_TYPED_ROOF,cityHouseType,compileCityBuildingTypes} from '../js/old-world-buildings.js';
import {TERRAIN} from '../js/wgsl/terrain.js';
import {readFileSync} from 'node:fs';

// A straight shore along z=0 with the sea to the south, ground rising gently inland, and one
// steep hill standing a little way back from the water.
function shore(latitude=38.7,longitude=-9.14,rise=0){
  const region={id:'test-shore',latitude,longitude,x:0,z:0,span:4096,size:257,biomeSize:128,albedoSize:256};
  const n=region.size,heights=new Float32Array(n*n);
  for(let j=0;j<n;j++)for(let i=0;i<n;i++){
    const x=(i/(n-1)-.5)*region.span,z=(j/(n-1)-.5)*region.span;
    const hill=90*Math.exp(-((x-700)**2+(z+650)**2)/(2*170**2));
    // And, where asked, a broad easy height the town can climb.
    const height=rise*Math.exp(-((x+450)**2+(z+520)**2)/(2*330**2));
    heights[j*n+i]=z>0?-4-z*.01:1.5-z*.02+hill+height;
  }
  const port={center:{x:0,z:-30},clearRadius:150,instances:[]};
  return {region,heights,port};
}
const slopeAt=(heights,region,x,z)=>{
  const n=region.size,s=(n-1)/region.span,at=(px,pz)=>heights[Math.round((pz+region.span/2)*s)*n+Math.round((px+region.span/2)*s)];
  return Math.hypot(at(x+32,z)-at(x-32,z),at(x,z+32)-at(x,z-32))/64;
};

test('the peninsula is told from France, Africa and the Indies',()=>{
  for(const [name,lat,lon] of [['Lisbon',38.707,-9.136],['Cadiz',36.53,-6.29],['La Coruna',43.371,-8.396],['Palma',39.57,2.65],['Barcelona',41.38,2.17]])
    assert.ok(inIberia(lat,lon),name);
  for(const [name,lat,lon] of [['Cartagena de Indias',10.42,-75.55],['Bordeaux',44.84,-.58],['Bayonne',43.49,-1.47],['Perpignan',42.7,2.9],['Tangier',35.78,-5.8],['Azores',38.5,-28]])
    assert.ok(!inIberia(lat,lon),name);
});

test('a city is found from its country, with its people for the year',()=>{
  const lisbon=oldWorldCityNear(38.75,-9.2);
  assert.equal(lisbon?.id,'lisbon');
  assert.equal(oldWorldCityNear(40.2,-3.7),null,'no port city on the Castilian plateau');
  assert.equal(oldWorldPeople(lisbon,1550),100000);
  assert.equal(oldWorldPeople(lisbon,1400),65000,'before the first count, the first count');
  const mid=oldWorldPeople(lisbon,1585);
  assert.ok(mid>100000&&mid<150000,`grows between counts: ${mid}`);
  for(const city of OLD_WORLD_CITIES)assert.ok(inIberia(city.latitude,city.longitude),city.id);
});

test('holdings are strips found again from any point in them',()=>{
  const sizes=new Map();
  for(let k=0;k<4000;k++){
    const x=-900+(k%63)*29.3,z=400+Math.floor(k/63)*31.7,hold=oldWorldHolding(x,z),again=oldWorldHolding(x,z);
    assert.deepEqual(hold,again);
    assert.ok(hold.edge>=0&&hold.edge<80,`edge ${hold.edge}`);
    const seat=oldWorldHoldingSeat(hold);
    assert.ok(Math.hypot(seat.x-x,seat.z-z)<140,'a holding is a field, not a district');
    const key=`${hold.lie}:${hold.i}:${hold.j}`;sizes.set(key,(sizes.get(key)||0)+1);
  }
  const area=4000*29.3*31.7/sizes.size;
  assert.ok(area>3000&&area<7000,`a holding is about half a hectare: ${area}`);
  const home=oldWorldHoldingSeat(oldWorldHolding(120,340)),there=oldWorldHolding(home.x,home.z),here=oldWorldHolding(120,340);
  assert.deepEqual([there.lie,there.i,there.j],[here.lie,here.i,here.j],'a seat lies in its own holding');
});

test('only an Iberian shore is Old World country, and it is farmed, not forest',()=>{
  const wild=shore(10.4,-75.5);
  assert.equal(oldWorldCountry(wild.region,wild.heights,wild.port),null,'the Indies keep their forest');
  const {region,heights,port}=shore(),country=oldWorldCountry(region,heights,port);
  assert.equal(country.city.id,'lisbon');
  // The city on this ground is its board: none was founded for a made-up shore, so no town is grown on it.
  assert.equal(country.town,null,'no board, no town');
  assert.equal(oldWorldCountry(region,heights,port),country,'one country per ground');
  const share=new Array(9).fill(0);let land=0,treed=0;
  for(let j=0;j<160;j++)for(let i=0;i<160;i++){
    const x=(i/160-.5)*region.span,z=-(j+.5)/160*region.span/2,at=country.landAt(x,z,slopeAt(heights,region,x,z));
    land++;share[at.kind]++;if(at.vegetation>=108/255)treed++;
    assert.ok(at.vegetation>=0&&at.vegetation<=1&&at.r>0&&at.g>0&&at.b>0);
    assert.notEqual(at.kind,OLD_WORLD_LAND.CITY,'no town without its board');
  }
  const of=kind=>share[kind]/land;
  assert.ok(treed/land<.2,`woods are the exception: ${treed/land}`);
  assert.ok(of(OLD_WORLD_LAND.CORN)+of(OLD_WORLD_LAND.FALLOW)>.15,'corn land');
  assert.ok(of(OLD_WORLD_LAND.OLIVES)+of(OLD_WORLD_LAND.VINES)+of(OLD_WORLD_LAND.GARDEN)>.15,'orchards, vines and gardens');
  // Gardens crowd the town; the far country has few.
  let near=0,nearAll=0,far=0,farAll=0;
  for(let k=0;k<6000;k++){
    const x=-1900+(k%77)*49,z=-40-Math.floor(k/77)*25,d=country.beyondTown(x,z);
    if(d<=0)continue;
    const garden=country.landAt(x,z,0).kind===OLD_WORLD_LAND.GARDEN;
    if(d<500){nearAll++;near+=garden;}else if(d>1500){farAll++;far+=garden;}
  }
  assert.ok(near/nearAll>3*(far/farAll+.01),`gardens under the walls ${near/nearAll}, out in the country ${far/farAll}`);
});

test('trees on tended ground stand apart, and in a wood by the forest\'s rules',()=>{
  const {region,heights,port}=shore(),country=oldWorldCountry(region,heights,port),seen=new Set();
  for(let k=0;k<20000;k++){
    const x=-2000+(k%141)*28.3,z=-20-Math.floor(k/141)*14.1,kind=country.landAt(x,z,0).kind,trees=country.treesAt(x,z);
    // A wood keeps the forest's rules, but for the road that runs through it.
    if(kind===OLD_WORLD_LAND.WOOD){assert.ok(trees===null||trees===OLD_WORLD_NO_TREES);if(trees===null)seen.add('wood');continue;}
    if(trees===OLD_WORLD_NO_TREES)continue;
    assert.ok(trees.spacing>=9&&trees.species.length>0&&trees.cohort,'a farmer\'s tree has its room and its kind');
    seen.add(trees.spacing);
  }
  assert.ok(seen.has('wood')&&seen.has(10.5)&&seen.has(10),`olives, a hedgerow and a wood all occur: ${[...seen]}`);
});

test('every building type is written in Cairn and compiles to a mesh of the size it claims',()=>{
  // Nine kinds of building after the houses, then the six things of the street, then whatever else the model
  // builds: seventeen that stand on footings as a house does and nine slighter works.
  assert.equal(CITY_TYPE.PENTICE,CITY_HOUSE_TYPES+9);assert.equal(CITY_TYPE.WINDMILL,CITY_TYPE.WELL+1);assert.equal(CITY_TYPE_SLIGHT_FROM,CITY_TYPE.FENCE_RAIL);
  assert.equal(CITY_BUILDING_TYPES.length,CITY_TYPE.SCAFFOLD+1);assert.ok(CITY_HOUSE_TYPES>2*CITY_HOUSE_STOREYS);
  assert.equal(new Set(Object.values(CITY_TYPE)).size,Object.keys(CITY_TYPE).length,'every type has its own number');
  for(const spec of CITY_BUILDING_TYPES){
    // Plain data: a spec survives a round trip through JSON unchanged.
    assert.deepEqual(JSON.parse(JSON.stringify(spec)),spec,spec.name);
    assert.ok(spec.primitives.some(p=>p.partGroup==='foundation_plinth'),`${spec.name} stands on its own footing`);
  }
  const types=compileCityBuildingTypes(buildPortPrefabGeometry);
  assert.equal(types.length,CITY_BUILDING_TYPES.length);
  types.forEach((type,id)=>{
    assert.equal(type.vertices.length,type.count*8);assert.equal(type.count%3,0);
    // A length of wall is a slab and its merlons; everything else has doors, windows or arrow slits to show.
    const curtain=id===CITY_TYPE.CURTAIN_SHORT||id===CITY_TYPE.CURTAIN_LONG,street=id>=CITY_TYPE.PENTICE&&id<=CITY_TYPE.WELL||id>=CITY_TYPE_SLIGHT_FROM;
    assert.ok(type.triangles>(curtain||street?40:300)&&type.triangles<(street?600:12000),`${type.name}: ${type.triangles} triangles`);
    const lo=[Infinity,Infinity,Infinity],hi=[-Infinity,-Infinity,-Infinity],kinds=new Set();
    for(let k=0;k<type.vertices.length;k+=8){
      for(let a=0;a<3;a++){const v=type.vertices[k+a];assert.ok(Number.isFinite(v));lo[a]=Math.min(lo[a],v);hi[a]=Math.max(hi[a],v);}
      assert.ok(Math.abs(Math.hypot(type.vertices[k+3],type.vertices[k+4],type.vertices[k+5])-1)<.02,'a unit normal');
      kinds.add(Math.floor(type.vertices[k+6]+.01));
    }
    for(const kind of kinds)assert.ok([10,11,12,13,14,15,16,18].includes(kind),`${type.name} is built of known materials: ${kind}`);
    // A thing of the street is written from where it stands or hangs, and is as large as it is written: no more is asked of it.
    if(street){assert.ok(hi[0]-lo[0]<=type.width+.01&&hi[2]-lo[2]<=type.length+.01&&hi[1]-lo[1]<=type.height+1.5,`${type.name} is ${hi[0]-lo[0]} by ${hi[2]-lo[2]} by ${hi[1]-lo[1]}`);return;}
    // Its footing runs below the floor, its walls stand on the plot it claims, give or take eaves and towers.
    assert.ok(lo[1]<-6&&lo[1]>-7,`${type.name} footing ${lo[1]}`);
    const church=id>=CITY_TYPE.CHURCH_LEFT&&id<=CITY_TYPE.CHURCH_GREAT,spread=church?(id===CITY_TYPE.CHURCH_GREAT?CITY_CHURCH.great:CITY_CHURCH.parish).tower:0;
    // A watermill's wheel turns outside its wall, under the launder that comes from behind it; a windmill's sails sweep wider than its tower.
    const mill=id===CITY_TYPE.WATERMILL,sails=id===CITY_TYPE.WINDMILL?.1:0;
    assert.ok(hi[0]<=type.width/2+spread+.7+(mill?1.2:0)&&lo[0]>=-type.width/2-spread-.7-sails,`${type.name} across ${lo[0]}..${hi[0]}`);
    // A house may stand out over its street as far as a jetty, a balcony or a pentice, and its eaves over that.
    assert.ok(hi[2]<=type.length/2+.7+(mill?3:0)&&lo[2]>=-type.length/2-(id<CITY_HOUSE_TYPES?1.75:.7),`${type.name} along ${lo[2]}..${hi[2]}`);
    assert.ok(hi[1]>=type.height&&hi[1]<type.height+(church?CITY_CHURCH.towerRise+CITY_CHURCH.spire+.5:7.5),`${type.name} up ${hi[1]} of ${type.height}`);
    // A house has windows and a tiled roof, and so has the castle's hall; a tower, a gate and the wall are stone.
    if(id<CITY_HOUSE_TYPES||id===CITY_TYPE.HALL)assert.ok(kinds.has(14)&&kinds.has(13)&&kinds.has(12));
    if(id>=CITY_TYPE.WALL_TOWER&&id<=CITY_TYPE.CURTAIN_LONG)assert.ok(kinds.has(11)&&!kinds.has(12)&&!kinds.has(13));
  });
  // Taller houses are taller types, and a ridge along the street is a different type from a gable to it.
  for(let storeys=1;storeys<CITY_HOUSE_STOREYS;storeys++)assert.ok(types[cityHouseType(storeys+1,true)].height>types[cityHouseType(storeys,true)].height);
  assert.notEqual(cityHouseType(2,true),cityHouseType(2,false));
  assert.equal(cityHouseType(9,true),cityHouseType(CITY_HOUSE_STOREYS,true));
});

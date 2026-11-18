import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildPortPrefabGeometry,generateProceduralCoastalPack} from '../js/coastal-world.js';
import {OLD_WORLD_CITIES,inIberia,oldWorldPeople,oldWorldCityNear,oldWorldCountry} from '../js/old-world.js';
import {CITY_BLOCK_FLOATS,CITY_GROUND,CITY_ROOF,CITY_TREES,CITY_WALL,cityFootprintsOverlap} from '../js/old-world-city.js';
import {streetEdgeAt} from '../js/town-streets.js';
import {CITY_BUILDING_TYPES,CITY_CHURCH,CITY_FAMILIES,CITY_HOUSE_STOREYS,CITY_HOUSE_TYPES,CITY_TYPE,CITY_TYPE_SLIGHT_FROM,cityFamilyOf,cityHouseType,compileCityBuildingTypes} from '../js/old-world-buildings.js';
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

test('Old World country is a board\'s: a shore with none standing keeps the rules of a wild shore',()=>{
  const wild=shore(10.4,-75.5);
  assert.equal(oldWorldCountry(wild.region,wild.heights,wild.port),null,'the Indies keep their forest');
  // Lisbon's site lies on this made-up shore, but no board was founded for it: no town, no fields, no country.
  const {region,heights,port}=shore();
  assert.equal(oldWorldCountry(region,heights,port),null,'no board, no country');
  assert.equal(oldWorldCountry(region,heights,null),null,'nor on ground with no port');
});

test('every building type is written in Cairn and compiles to a mesh of the size it claims',()=>{
  // Every kind is a family of its sizes (whole bays, stages, panels, bents or arches), the families tiling the
  // catalogue: the houses, eight kinds of building after them, then the six things of the street, then whatever else
  // the model builds, the slighter works last. Each family's name is its canonical size.
  let at=0;
  for(const family of CITY_FAMILIES){assert.equal(family.from,at);assert.ok(family.canonical>=family.from&&family.canonical<family.from+family.count,family.key);at+=family.count;}
  assert.equal(at,CITY_BUILDING_TYPES.length);
  const order=CITY_FAMILIES.map(f=>f.key);
  assert.equal(cityFamilyOf(CITY_TYPE.CHURCH_LEFT).from,CITY_HOUSE_TYPES);
  assert.deepEqual(order.slice(order.indexOf('CHURCH_LEFT'),order.indexOf('WINDMILL')+1),['CHURCH_LEFT','CHURCH_RIGHT','CHURCH_GREAT','WALL_TOWER','KEEP','GATE','CURTAIN','HALL','PENTICE','SIGN','ALE_STAKE','STALL','MARKET_CROSS','WELL','WINDMILL']);
  assert.equal(CITY_TYPE_SLIGHT_FROM,cityFamilyOf(CITY_TYPE.FENCE_RAIL).from);assert.ok(CITY_HOUSE_TYPES>2*CITY_HOUSE_STOREYS);
  for(const key of Object.keys(CITY_TYPE))if(!key.startsWith('HOUSE_'))assert.equal(cityFamilyOf(CITY_TYPE[key]).canonical,CITY_TYPE[key],key);
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
    const key=cityFamilyOf(id).key,curtain=key==='CURTAIN',street=['PENTICE','SIGN','ALE_STAKE','STALL','MARKET_CROSS','WELL'].includes(key)||id>=CITY_TYPE_SLIGHT_FROM;
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
    const church=key.startsWith('CHURCH_'),spread=church?(key==='CHURCH_GREAT'?CITY_CHURCH.great:CITY_CHURCH.parish.find(P=>P.width===type.width)).tower:0;
    // A watermill's wheel turns outside its wall, under the launder that comes from behind it; a windmill's sails sweep wider than its tower.
    const mill=key==='WATERMILL',sails=key==='WINDMILL'?.1:0;
    assert.ok(hi[0]<=type.width/2+spread+.7+(mill?1.2:0)&&lo[0]>=-type.width/2-spread-.7-sails,`${type.name} across ${lo[0]}..${hi[0]}`);
    // A house may stand out over its street as far as a jetty, a balcony or a pentice, and its eaves over that.
    assert.ok(hi[2]<=type.length/2+.7+(mill?3:0)&&lo[2]>=-type.length/2-(id<CITY_HOUSE_TYPES?1.75:.7),`${type.name} along ${lo[2]}..${hi[2]}`);
    assert.ok(hi[1]>=type.height&&hi[1]<type.height+(church?CITY_CHURCH.towerRise+CITY_CHURCH.spire+.5:7.5),`${type.name} up ${hi[1]} of ${type.height}`);
    // A house has windows and a tiled roof, and so has the castle's hall; a tower, a gate and the wall are stone.
    if(id<CITY_HOUSE_TYPES||key==='HALL')assert.ok(kinds.has(14)&&kinds.has(13)&&kinds.has(12));
    if(['WALL_TOWER','KEEP','GATE','CURTAIN'].includes(key))assert.ok(kinds.has(11)&&!kinds.has(12)&&!kinds.has(13));
  });
  // Taller houses are taller types, and a ridge along the street is a different type from a gable to it.
  for(let storeys=1;storeys<CITY_HOUSE_STOREYS;storeys++)assert.ok(types[cityHouseType(storeys+1,true)].height>types[cityHouseType(storeys,true)].height);
  assert.notEqual(cityHouseType(2,true),cityHouseType(2,false));
  assert.equal(cityHouseType(9,true),cityHouseType(CITY_HOUSE_STOREYS,true));
});

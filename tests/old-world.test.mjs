import {test} from 'node:test';
import assert from 'node:assert/strict';
import {buildPortPrefabGeometry,generateProceduralCoastalPack} from '../js/coastal-world.js';
import {OLD_WORLD_LAND,OLD_WORLD_CITIES,OLD_WORLD_NO_TREES,inIberia,oldWorldPeople,oldWorldCityNear,oldWorldHolding,
  oldWorldHoldingSeat,growOldWorldTown,layOldWorldRoads,oldWorldCountry} from '../js/old-world.js';
import {CITY_BLOCK_FLOATS,CITY_GROUND,CITY_ROOF,CITY_TREES,CITY_WALL,cityFootprintsOverlap} from '../js/old-world-city.js';
import {streetEdgeAt} from '../js/town-streets.js';
import {CITY_BUILDING_TYPES,CITY_CHURCH,CITY_DETAIL_M,CITY_GATE,CITY_HOUSE_STOREYS,CITY_HOUSE_TYPES,CITY_TYPE,CITY_TYPED_FLOATS,CITY_TYPED_ROOF,cityHouseType,compileCityBuildingTypes} from '../js/old-world-buildings.js';
import {CITY_CULL} from '../js/scenery-cull.js';
import {TERRAIN} from '../js/wgsl/terrain.js';

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

test('a town grows from its waterfront to the area asked, along the shore, and never onto water',()=>{
  const {region,heights,port}=shore(),wanted=60e4;
  const town=growOldWorldTown(heights,region,port.center,wanted);
  assert.ok(Math.abs(town.area-wanted)/wanted<.12,`area ${town.area}`);
  const n=region.size,step=region.span/(n-1);let x0=Infinity,x1=-Infinity,z0=Infinity,z1=-Infinity,wet=0,onHill=0,inside=0;
  for(let j=0;j<n;j++)for(let i=0;i<n;i++){
    const k=j*n+i;if(town.urban[k]<.5)continue;inside++;
    const x=(i/(n-1)-.5)*region.span,z=(j/(n-1)-.5)*region.span;
    x0=Math.min(x0,x);x1=Math.max(x1,x);z0=Math.min(z0,z);z1=Math.max(z1,z);
    if(heights[k]<=.25)wet++;
    if(Math.hypot(x-700,z+650)<120)onHill++;
    assert.equal(town.beyond[k],0,'no distance to the town from inside it');
    assert.ok(town.early[k]>=0&&town.early[k]<=1,'every part of the town has its age');
  }
  assert.equal(wet,0,'no house on water');
  assert.ok(z1>-3*step,'the town comes down to the water');
  assert.ok(x1-x0>1.5*(z1-z0),`longer along the shore (${x1-x0}) than inland (${z1-z0})`);
  assert.equal(onHill,0,'the steep hill is left for later');
  const far=Math.round((-1800/region.span+.5)*(n-1))*n+Math.round(.5*(n-1));
  assert.ok(town.beyond[far]>800,'open country lies well beyond the edge');
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
  assert.ok(country.town,'the port holds the city');
  assert.equal(oldWorldCountry(region,heights,port),country,'one country per ground');
  const share=new Array(9).fill(0);let land=0,treed=0;
  for(let j=0;j<160;j++)for(let i=0;i<160;i++){
    const x=(i/160-.5)*region.span,z=-(j+.5)/160*region.span/2,at=country.landAt(x,z,slopeAt(heights,region,x,z));
    land++;share[at.kind]++;if(at.vegetation>=108/255)treed++;
    assert.ok(at.vegetation>=0&&at.vegetation<=1&&at.r>0&&at.g>0&&at.b>0);
    if(at.kind===OLD_WORLD_LAND.CITY)assert.ok(at.vegetation<108/255,'no forest in the streets');
  }
  const of=kind=>share[kind]/land;
  assert.ok(of(OLD_WORLD_LAND.CITY)>.03,'the town shows');
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

test('trees on tended ground stand apart, in the town only where it plants them, and in a wood by the forest\'s rules',()=>{
  const {region,heights,port}=shore(),country=oldWorldCountry(region,heights,port),seen=new Set();
  for(let k=0;k<20000;k++){
    const x=-2000+(k%141)*28.3,z=-20-Math.floor(k/141)*14.1,kind=country.landAt(x,z,0).kind,trees=country.treesAt(x,z);
    if(kind===OLD_WORLD_LAND.CITY){assert.ok(trees===OLD_WORLD_NO_TREES||trees.spacing>=8,'a town tree is a planted one');continue;}
    // A wood keeps the forest's rules, but for the road that runs through it.
    if(kind===OLD_WORLD_LAND.WOOD){assert.ok(trees===null||trees===OLD_WORLD_NO_TREES);if(trees===null)seen.add('wood');continue;}
    if(trees===OLD_WORLD_NO_TREES)continue;
    assert.ok(trees.spacing>=9&&trees.species.length>0&&trees.cohort,'a farmer\'s tree has its room and its kind');
    seen.add(trees.spacing);
  }
  assert.ok(seen.has('wood')&&seen.has(10.5)&&seen.has(10)&&seen.has(11),`olives, a hedgerow, a roadside and a wood all occur: ${[...seen]}`);
});

test('roads leave the waterfront for the border by easy ground',()=>{
  const {region,heights,port}=shore(),roads=layOldWorldRoads(heights,region,port.center);
  assert.ok(roads.length>=3,`several roads: ${roads.length}`);
  const half=region.span/2;let reachBorder=0;
  for(const line of roads){
    const [ex,ez]=line[0];
    if(Math.max(Math.abs(ex),Math.abs(ez))>half-80)reachBorder++;
    for(const [x,z] of line){
      assert.ok(z<8,'no road over the water');
      assert.ok(Math.hypot(x-700,z+650)>150,'no road over the steep hill');
    }
  }
  assert.equal(reachBorder,roads.length,'each road starts at the border and runs in');
  const first=roads[0],[sx,sz]=first[first.length-1];
  assert.ok(Math.hypot(sx-port.center.x,sz-port.center.z)<120,'the first road ends at the waterfront');
});

test('a city is laid out on its ground: streets that join, lots that touch nothing, a wall with its gates',()=>{
  const {region,heights,port}=shore(),country=oldWorldCountry(region,heights,port),plan=country.plan;
  assert.ok(plan,'a town has its plan');
  assert.ok(plan.houses>400,`houses: ${plan.houses}`);
  assert.equal(plan.blocks.length,plan.count*CITY_BLOCK_FLOATS);
  assert.ok(plan.count>=plan.houses);
  const at=(x,z)=>heights[Math.round((z+region.span/2)/region.span*(region.size-1))*region.size+Math.round((x+region.span/2)/region.span*(region.size-1))];
  // Every block is a real box on dry ground, of a roof and a wall the shader knows.
  for(let k=0;k<plan.blocks.length;k+=CITY_BLOCK_FLOATS){
    const b=plan.blocks.subarray(k,k+CITY_BLOCK_FLOATS);
    assert.ok(b.every(Number.isFinite),'finite');
    assert.ok(b[4]>0.5&&b[5]>0.5&&b[6]>0.8&&b[7]>=0&&b[11]>=0,`a block has size: ${[...b]}`);
    assert.ok(Object.values(CITY_ROOF).includes(b[8]%CITY_TYPED_ROOF)&&b[8]<2*CITY_TYPED_ROOF&&Object.values(CITY_WALL).includes(b[9]));
    assert.ok(at(b[0],b[2])>.9,'no block on water');
    assert.ok(b[1]>.5&&b[1]<140,'a floor at the height of the ground');
  }
  // No two lots share ground, and none stands on a street.
  const lots=plan.lots;let shared=0;
  for(let i=0;i<lots.length;i++)for(let j=i+1;j<lots.length;j++){
    if(Math.abs(lots[i].x-lots[j].x)>45||Math.abs(lots[i].z-lots[j].z)>45)continue;
    if(cityFootprintsOverlap(lots[i],lots[j],-.02))shared++;
  }
  assert.equal(shared,0,'lots stand clear of each other');
  for(const lot of lots)assert.equal(plan.groundAt(lot.x,lot.z),CITY_GROUND.HOUSE);
  let lanes=0,joined=0,onStreet=0,sampled=0;
  for(const st of plan.streets){
    if(st.kind==='lane'){lanes++;if(st.joined)joined++;}
    const [x,z]=st.pts[Math.floor(st.pts.length/2)];
    if(st.kind!=='port'){sampled++;if(plan.groundAt(x,z)===CITY_GROUND.STREET)onStreet++;}
    assert.equal(plan.treesAt(x,z),CITY_TREES.NONE,'no tree in a street');
    for(const [px,pz] of st.pts)assert.ok(at(px,pz)>.5,'no street over water');
  }
  assert.ok(lanes>40,`back lanes: ${lanes}`);
  assert.ok(joined>lanes*.3,`lanes meet other streets: ${joined} of ${lanes}`);
  assert.equal(onStreet,sampled,'a street\'s middle is street');
  // The wall goes round the old town, leaves the waterfront to the water, and opens where streets cross it.
  const stood=plan.wall.pts.filter(p=>!p.open).length;
  assert.ok(stood>plan.wall.pts.length*.3&&stood<plan.wall.pts.length,`a wall on the land side only: ${stood} of ${plan.wall.pts.length}`);
  assert.ok(plan.gates.length>=2,`gates: ${plan.gates.length}`);
  for(const gate of plan.gates)assert.equal(plan.groundAt(gate.x,gate.z),CITY_GROUND.STREET,'a gate stands on its street');
  assert.ok(plan.churches.length>=2&&plan.churches[0].great,'churches, the first the greatest');
  // The same ground gives the same city.
  const again=oldWorldCountry(region,Float32Array.from(heights),port).plan;
  assert.equal(again.count,plan.count);
  assert.deepEqual([...again.blocks.subarray(0,48)],[...plan.blocks.subarray(0,48)]);
});

test('every building type is written in Cairn and compiles to a mesh of the size it claims',()=>{
  // Nine kinds of building after the houses, then the six things of the street.
  assert.equal(CITY_TYPE.PENTICE,CITY_HOUSE_TYPES+9);assert.equal(CITY_BUILDING_TYPES.length,CITY_TYPE.WELL+1);assert.ok(CITY_HOUSE_TYPES>2*CITY_HOUSE_STOREYS);
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
    const curtain=id===CITY_TYPE.CURTAIN_SHORT||id===CITY_TYPE.CURTAIN_LONG,street=id>=CITY_TYPE.PENTICE;
    assert.ok(type.triangles>(curtain||street?40:300)&&type.triangles<(street?400:12000),`${type.name}: ${type.triangles} triangles`);
    const lo=[Infinity,Infinity,Infinity],hi=[-Infinity,-Infinity,-Infinity],kinds=new Set();
    for(let k=0;k<type.vertices.length;k+=8){
      for(let a=0;a<3;a++){const v=type.vertices[k+a];assert.ok(Number.isFinite(v));lo[a]=Math.min(lo[a],v);hi[a]=Math.max(hi[a],v);}
      assert.ok(Math.abs(Math.hypot(type.vertices[k+3],type.vertices[k+4],type.vertices[k+5])-1)<.02,'a unit normal');
      kinds.add(Math.floor(type.vertices[k+6]+.01));
    }
    for(const kind of kinds)assert.ok([10,11,12,13,14,18].includes(kind),`${type.name} is built of known materials: ${kind}`);
    // A thing of the street is written from where it stands or hangs, and is as large as it is written: no more is asked of it.
    if(street){assert.ok(hi[0]-lo[0]<=type.width+.01&&hi[2]-lo[2]<=type.length+.01&&hi[1]-lo[1]<=type.height+1.5,`${type.name} is ${hi[0]-lo[0]} by ${hi[2]-lo[2]} by ${hi[1]-lo[1]}`);return;}
    // Its footing runs below the floor, its walls stand on the plot it claims, give or take eaves and towers.
    assert.ok(lo[1]<-6&&lo[1]>-7,`${type.name} footing ${lo[1]}`);
    const church=id>=CITY_TYPE.CHURCH_LEFT&&id<=CITY_TYPE.CHURCH_GREAT,spread=church?(id===CITY_TYPE.CHURCH_GREAT?CITY_CHURCH.great:CITY_CHURCH.parish).tower:0;
    assert.ok(hi[0]<=type.width/2+spread+.7&&lo[0]>=-type.width/2-spread-.7,`${type.name} across ${lo[0]}..${hi[0]}`);
    // A house may stand out over its street as far as a jetty, a balcony or a pentice, and its eaves over that.
    assert.ok(hi[2]<=type.length/2+.7&&lo[2]>=-type.length/2-(id<CITY_HOUSE_TYPES?1.75:.7),`${type.name} along ${lo[2]}..${hi[2]}`);
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

test('each house, church, tower, gate and length of wall of the plan is a Cairn type standing where its block stands',()=>{
  const {region,heights,port}=shore(38.7,-9.14,70),plan=oldWorldCountry(region,heights,port).plan;
  assert.equal(plan.typed.length,plan.typedCount*CITY_TYPED_FLOATS);
  assert.equal(plan.typedTypes.length,plan.typedCount);
  // Blocks that a type replaces, by where they stand.
  const flagged=new Map();
  for(let k=0;k<plan.blocks.length;k+=CITY_BLOCK_FLOATS){
    if(plan.blocks[k+8]<CITY_TYPED_ROOF)continue;
    flagged.set(`${plan.blocks[k]},${plan.blocks[k+1]},${plan.blocks[k+2]}`,k);
  }
  const of=new Array(CITY_BUILDING_TYPES.length).fill(0);let houses=0,missing=0;
  for(let i=0;i<plan.typedCount;i++){
    const t=plan.typed.subarray(i*CITY_TYPED_FLOATS,(i+1)*CITY_TYPED_FLOATS),type=plan.typedTypes[i];
    assert.ok(type<CITY_BUILDING_TYPES.length);of[type]++;
    assert.ok(t.every(Number.isFinite));
    // A type is stretched to its plot, never beyond recognition.
    assert.ok(t[4]>.65&&t[4]<1.6&&t[5]>.75&&t[5]<1.4&&t[6]>.6&&t[6]<1.6,`${CITY_BUILDING_TYPES[type].name} stretched ${t[4]}, ${t[5]}, ${t[6]}`);
    if(type<CITY_HOUSE_TYPES)houses++;
    // The gate's far block is its chamber, up over the passage; every other block stands at the type's root.
    let key=`${t[0]},${t[1]},${t[2]}`;
    if(type===CITY_TYPE.GATE)key=[...flagged.keys()].find(k=>{const [x,y,z]=k.split(',').map(Number);return x===t[0]&&z===t[2]&&Math.abs(y-t[1]-CITY_GATE.passage)<.01;})??'none';
    if(!flagged.has(key))missing++;
    else if(type<CITY_HOUSE_TYPES)assert.equal(plan.blocks[flagged.get(key)+10],t[7],'a house and its block share a tint');
  }
  assert.equal(missing,0,'every type has the block it replaces');
  assert.equal(houses,plan.houses);
  assert.equal(of[CITY_TYPE.GATE],plan.gates.length);
  assert.equal(of[CITY_TYPE.CHURCH_GREAT],1);
  assert.equal(of[CITY_TYPE.CHURCH_LEFT]+of[CITY_TYPE.CHURCH_RIGHT]+1,plan.churches.length);
  assert.equal(of[CITY_TYPE.KEEP],plan.castle?1:0);
  assert.ok(of[CITY_TYPE.WALL_TOWER]>=2*plan.gates.length,`towers: ${of[CITY_TYPE.WALL_TOWER]}`);
  // The wall is typed too, length by length, and the castle's hall: no block is left that is only a block.
  assert.ok(of[CITY_TYPE.CURTAIN_SHORT]+of[CITY_TYPE.CURTAIN_LONG]>20,`lengths of wall: ${of[CITY_TYPE.CURTAIN_SHORT]}+${of[CITY_TYPE.CURTAIN_LONG]}`);
  assert.equal(of[CITY_TYPE.HALL],plan.castle?1:0);
  let plain=0;for(let k=0;k<plan.blocks.length;k+=CITY_BLOCK_FLOATS)if(plan.blocks[k+8]<CITY_TYPED_ROOF)plain++;
  assert.equal(plain,0,`plain blocks: ${plain}`);
  // The shader that drops a block and the cull that shows its type agree on the distance.
  assert.ok(CITY_CULL.includes('<params.x+')&&CITY_DETAIL_M>100&&CITY_DETAIL_M<600);
  assert.ok(TERRAIN.includes('fn cityTypeVS')&&TERRAIN.includes('away<nearTerrain.grid.w'));
});

test('a castle takes the height the old town climbs, and nothing else is built there',()=>{
  const {region,heights,port}=shore(38.7,-9.14,52),country=oldWorldCountry(region,heights,port),plan=country.plan;
  assert.ok(plan.castle,'a castle');
  const at=(x,z)=>heights[Math.round((z+region.span/2)/region.span*(region.size-1))*region.size+Math.round((x+region.span/2)/region.span*(region.size-1))];
  assert.ok(at(plan.castle.x,plan.castle.z)>at(port.center.x,port.center.z)+28,'well above the waterfront');
  assert.equal(plan.groundAt(plan.castle.x+30,plan.castle.z),CITY_GROUND.CASTLE);
  for(const lot of plan.lots)assert.ok(Math.hypot(lot.x-plan.castle.x,lot.z-plan.castle.z)>30,'no house in the castle');
  for(const st of plan.streets)if(st.kind==='lane')for(const [x,z] of st.pts)assert.ok(Math.hypot(x-plan.castle.x,z-plan.castle.z)>40,'no lane through it');
  assert.ok(plan.standing.every(([x,z])=>plan.treesAt(x,z)!==CITY_TREES.NONE),'every planted tree stands where a tree may');
});

test('trees stand round a square, in a walled garden and in back yards, never in a house',()=>{
  const {region,heights,port}=shore(),country=oldWorldCountry(region,heights,port),plan=country.plan,seen=new Set();
  for(let k=0;k<60000;k++){
    const x=-1900+(k%300)*12.7,z=-10-Math.floor(k/300)*7.3;
    if(country.beyondTown(x,z)>0)continue;
    const where=plan.treesAt(x,z),ground=plan.groundAt(x,z),trees=country.treesAt(x,z);
    if(where===CITY_TREES.NONE){assert.equal(trees,OLD_WORLD_NO_TREES);continue;}
    seen.add(where);
    assert.notEqual(ground,CITY_GROUND.HOUSE);assert.notEqual(ground,CITY_GROUND.STREET);
    assert.ok(trees.spacing>=8&&trees.species.length>0,'a town tree has its room');
    assert.ok(country.landAt(x,z,0).vegetation>0,'and the land cover says a tree may stand there');
  }
  assert.ok(seen.has(CITY_TREES.YARD),'yard trees');
  assert.ok(seen.has(CITY_TREES.SQUARE)||seen.has(CITY_TREES.PARK),`a planted square or garden: ${[...seen]}`);
});

test('Lisbon is laid out as a city in farmed country, not a clearing in forest',()=>{
  const pack=generateProceduralCoastalPack('lisbon',{size:257,biomeSize:256,albedoSize:256,vegetationCandidates:400});
  let dense=0,land=0;
  for(let k=0;k<pack.biome.length;k++){
    const i=k%256,j=(k-i)/256,h=pack.heights[Math.round(j/255*256)*257+Math.round(i/255*256)];
    if(h<1.2)continue;land++;if(pack.biome[k]>=108)dense++;
  }
  assert.ok(land>2000,'there is land');
  assert.ok(dense/land<.25,`forest covers little of it: ${dense/land}`);
  const country=oldWorldCountry(pack.region,pack.heights,pack.port);
  assert.ok(Math.abs(country.town.area-country.cityArea)/country.cityArea<.15,'the town takes the ground its people need');
  // A hundred thousand people in some ten thousand houses, as the 1551 count had it.
  assert.ok(pack.city.count>6000,`blocks to draw: ${pack.city.count}`);
  assert.ok(country.plan.houses>5000&&country.plan.houses<22000,`houses: ${country.plan.houses}`);
  assert.equal(pack.city.blocks,country.plan.blocks,'the renderer draws the plan\'s own blocks');
  // Close to, each building is its Cairn type: the plan's own list, one instance to a building.
  assert.equal(pack.city.typed,country.plan.typed);
  assert.equal(pack.city.typedTypes,country.plan.typedTypes);
  assert.ok(pack.city.typedCount>country.plan.houses&&pack.city.typedCount<pack.city.count,`typed: ${pack.city.typedCount} of ${pack.city.count}`);
  // Its streets are paved in the same field as the port's own.
  const streets=pack.port.streets;
  assert.ok(streets.cityWays.length>200,'city streets in the paving field');
  let paved=0,tried=0;
  for(const st of country.plan.streets){
    if(st.kind==='port')continue;
    const [x,z]=st.pts[Math.floor(st.pts.length/2)];tried++;
    if(streetEdgeAt(streets,x,z)<1)paved++;
  }
  assert.ok(paved>tried*.95,`paved under ${paved} of ${tried} streets`);
});

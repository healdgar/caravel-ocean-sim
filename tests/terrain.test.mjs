import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {ISLAND,LAND_REGIONS,LANDFALL_VIEWS,decodeIsland,decodeBiome,islandGeometry,islandVegetation,terrainSample,islandCoordinates,constrainIslandMotion,safeLandfallStart} from '../js/terrain-model.js';
import {vegetationProbability} from '../js/vegetation.js';
import {LANDFALL_SEA,landfallCameraYaw,landfallStageURL} from '../js/landfall.js';
import {cameraModeFromLink,createShareLink} from '../js/sharing.js';
const file=await readFile(new URL('../assets/world/saba/height.bin',import.meta.url));
const heights=decodeIsland(file.buffer.slice(file.byteOffset,file.byteOffset+file.byteLength));
const maskFile=await readFile(new URL('../assets/world/saba/biome.bin',import.meta.url));
const biome=decodeBiome(maskFile.buffer.slice(maskFile.byteOffset,maskFile.byteOffset+maskFile.byteLength));

test('real Saba elevation has coherent scale, winding and finite surface normals',()=>{
  const mesh=islandGeometry(heights);
  const peak=heights.reduce((a,b)=>Math.max(a,b),-Infinity);
  assert.equal(heights.length,513**2);assert.ok(peak>840&&peak<900);
  assert.ok(mesh.indices.length/3<120000,'16 m land mesh stays bounded');
  for(let i=0;i<mesh.vertices.length;i+=8){
    assert.ok(mesh.vertices.slice(i,i+8).every(Number.isFinite));
    assert.ok(Math.abs(Math.hypot(...mesh.vertices.slice(i+3,i+6))-1)<1e-5);
  }
  for(let i=0;i<mesh.indices.length;i+=3){
    const [a,b,c]=Array.from(mesh.indices.slice(i,i+3),v=>mesh.vertices.slice(v*8,v*8+3));
    assert.ok((b[2]-a[2])*(c[0]-a[0])-(b[0]-a[0])*(c[2]-a[2])>0,'upward winding');
  }
  assert.throws(()=>decodeIsland(new ArrayBuffer(4)),/Incomplete/);
});

test('all landfall starts give the loaded ship water clearance and stable geographic coordinates',()=>{
  for(const p of Object.values(LANDFALL_VIEWS)){
    const boat={...p,length:20,beam:6,hydrodynamics:{draft:2.1}};
    assert.equal(constrainIslandMotion(heights,boat,p.x,p.z),false);
    assert.ok(terrainSample(heights,p.x,p.z)<-3);
  }
  assert.deepEqual(islandCoordinates(ISLAND.x,ISLAND.z),{latitude:ISLAND.latitude,longitude:ISLAND.longitude});
  assert.ok(islandCoordinates(ISLAND.x,ISLAND.z-1000).latitude>ISLAND.latitude);
});

test('coastal clearance sweeps the whole path and leaves open-ocean speed unchanged',()=>{
  const boat={x:0,z:-6000,length:20,beam:6,surgeVelocity:3,leewayVelocity:.1};
  assert.equal(constrainIslandMotion(heights,boat,0,0),true,'cannot tunnel into mountain');
  assert.ok(boat.z>-6000);assert.equal(boat.surgeVelocity,0);
  const open={x:0,z:1000,length:20,beam:6,surgeVelocity:3,leewayVelocity:.1};
  assert.equal(constrainIslandMotion(heights,open,0,1010),false);
  assert.equal(open.surgeVelocity,3);assert.equal(open.z,1000);
});

test('landfall starts clear loaded Victory and preserve every valid caravel camera preset',()=>{
  for(const view of Object.values(LANDFALL_VIEWS)){
    const caravel={length:20,beam:6,hydrodynamics:{draft:2.1}};
    const original=structuredClone(view),before=structuredClone(caravel);
    const unchanged=safeLandfallStart(heights,view,caravel);
    assert.equal(unchanged.moved,false);assert.equal(unchanged.x,view.x);assert.equal(unchanged.z,view.z);
    for(const draft of [8.4,8.8,9.3]){
      const victory={length:56.6928,beam:15.8496,hydrodynamics:{draft}};
      const start=safeLandfallStart(heights,view,victory),boat={...victory,...start,surgeVelocity:3,leewayVelocity:.2};
      assert.equal(constrainIslandMotion(heights,boat,start.x,start.z),false,'same full-hull clearance as sailing');
      assert.ok(start.depth>=draft+1);
      assert.equal(start.moved,false,'authored coastal slope also clears a fully loaded first-rate at the preset');
      // The follower is aft/starboard in the vessel frame, including the Wells
      // Bay shore-facing heading, and gets an independent clearance search.
      const heading=(view.heading??0)*Math.PI/180;
      const copyView={...start,x:start.x-Math.sin(heading)*victory.length*2.8+Math.cos(heading)*victory.length*1.5,
        z:start.z+Math.cos(heading)*victory.length*2.8+Math.sin(heading)*victory.length*1.5};
      const follower=safeLandfallStart(heights,copyView,victory);
      const copy={...victory,...follower};
      assert.equal(constrainIslandMotion(heights,copy,copy.x,copy.z),false);
      assert.ok(Math.hypot(follower.x-copyView.x,follower.z-copyView.z)<=500,'companion adjustment stays near the coastal scene');
      assert.ok(follower.depth>=draft+1,'each follower retains its own draft margin regardless of whether relocation was necessary');
    }
    assert.deepEqual(view,original);assert.deepEqual(caravel,before,'spawn search cannot alter physics or camera input');
  }
});

test('Wells Bay preset points the bow and swell into the concave shore while other starts stay unchanged',()=>{
  const coast=LANDFALL_VIEWS.coast,sea=LANDFALL_SEA.coast;
  assert.deepEqual(coast,{x:-1750,z:-7000,y:6,yaw:112,pitch:1,heading:112});
  assert.deepEqual(sea,{swellDir:22,swellHs:1.2,swellLength:95,windSpeed:5.5,windDir:118});
  const shore=[-1500-coast.x,-6900-coast.z],distance=Math.hypot(...shore),h=coast.heading*Math.PI/180,s=sea.swellDir*Math.PI/180;
  assert.ok((Math.sin(h)*shore[0]-Math.cos(h)*shore[1])/distance>.99,'compass heading points into the bay');
  assert.ok((Math.cos(s)*shore[0]+Math.sin(s)*shore[1])/distance>.99,'swell travel uses the distinct X/Z angle convention');
  assert.deepEqual(LANDFALL_VIEWS.horizon,{x:-1800,z:10500,y:6,yaw:6.2,pitch:1});
  assert.deepEqual(LANDFALL_VIEWS.approach,{x:-1100,z:-1400,y:6,yaw:10.4,pitch:6});
});

test('stage navigation resets stale vessel coordinates, helm and swell before applying its preset',()=>{
  const old='https://example.com/ocean.html?landfall=approach&cam=1,2,3,4,5&boatX=450&boatZ=80&boatHeading=270&boatRudder=35&view=ship&boat=0&swellDir=190&swellHs=8&swellLength=300&swellSpread=2&windSpeed=28&windDir=4&follower=0&ship=victory';
  const coast=landfallStageURL(old,'coast','sunset');
  for(const key of ['cam','boatX','boatZ','boatRudder','swellSpread'])assert.equal(coast.searchParams.has(key),false,key+' cannot override the new preset');
  for(const [key,value]of Object.entries({landfall:'coast',view:'boat',boat:'1',boatHeading:'112',boatSpeed:'4',weather:'sunset',swellDir:'22',swellHs:'1.2',swellLength:'95',windSpeed:'5.5',windDir:'118',follower:'0',ship:'victory'}))assert.equal(coast.searchParams.get(key),value,key);
  const horizon=landfallStageURL(old,'horizon');assert.equal(horizon.searchParams.get('boatHeading'),'0');assert.equal(horizon.searchParams.get('swellHs'),'0.65');
  assert.equal(horizon.searchParams.has('swellDir'),false);assert.equal(horizon.searchParams.has('swellLength'),false);
  assert.throws(()=>landfallStageURL(old,'unknown'),/Unknown landfall/);
});

test('boat presets use relative look yaw without replacing explicit camera or shared heading overrides',()=>{
  const absolute=112*Math.PI/180;
  assert.equal(landfallCameraYaw('coast','boat',false,absolute),0);
  assert.equal(landfallCameraYaw('coast','free',false,absolute),absolute);
  assert.equal(landfallCameraYaw('coast','ship',false,absolute),absolute);
  assert.equal(landfallCameraYaw('coast','boat',true,.731),.731);
  assert.equal(landfallCameraYaw(null,'boat',false,.731),.731);
  for(const stage of ['horizon','approach'])assert.equal(landfallCameraYaw(stage,'boat',false,.731),.731,'unmodified stage bearings remain unchanged');
  const link=new URL(createShareLink('https://example.com/?landfall=coast',LANDFALL_SEA.coast,
    {heading:257,x:-1800,z:-7100,speed:4,showProw:true,propulsion:'sail'},'free',
    {cam:{x:-1900,y:12,z:-7200,yaw:.731,pitch:-.2}}));
  assert.equal(link.searchParams.get('boatHeading'),'257');assert.equal(link.searchParams.get('boatX'),'-1800');assert.equal(link.searchParams.get('boatZ'),'-7100');
  const yaw=Number(link.searchParams.get('cam').split(',')[3])*Math.PI/180;
  assert.equal(landfallCameraYaw('coast',cameraModeFromLink(link.searchParams),link.searchParams.has('cam'),yaw),yaw);
});

test('safe start checks hull extremities and handles an enlarged hull or a centre-of-island preset',()=>{
  const region={...ISLAND,size:9,span:400,x:0,z:0},terrain=new Float32Array(81).fill(-40);
  // Deep centre alone is insufficient: the bow/side envelope reaches shallow ground.
  for(let j=0;j<9;j++)terrain[j*9+5]=-2;
  const boat={length:110,beam:25,hydrodynamics:{draft:10}},view={x:0,z:0,y:6,yaw:90,pitch:10};
  const start=safeLandfallStart(terrain,view,boat,region);
  assert.equal(start.moved,true);assert.ok(start.x>100);assert.equal(start.z,0);
  assert.equal(start.y,view.y);assert.equal(start.yaw,view.yaw);assert.equal(start.pitch,view.pitch);
  assert.ok(Number.isFinite(start.depth));
  assert.throws(()=>safeLandfallStart(terrain,view,{...boat,hydrodynamics:{draft:150}},region),/No landfall start/);
});

test('vegetation is deterministic, finite and rooted on dry ground',()=>{
  const trees=islandVegetation(heights,biome);assert.deepEqual(trees,islandVegetation(heights,biome));
  assert.ok(trees.length/8>12000&&trees.length/8<25000,'the resident region contains dense, bounded forest stands');
  for(let i=0;i<trees.length;i+=8){
    assert.ok(trees.slice(i,i+8).every(Number.isFinite));
    assert.ok(Math.abs(trees[i+1]-terrainSample(heights,trees[i],trees[i+2]))<.05);
    assert.ok(trees[i+1]>=15);
    assert.ok(trees[i+3]>=3.2&&trees[i+3]<=7.6&&trees[i+4]>=8&&trees[i+4]<=18,'instance dimensions are physical metres');
    const u=(trees[i]-ISLAND.x)/ISLAND.span+.5,v=(trees[i+2]-ISLAND.z)/ISLAND.span+.5;
    assert.ok(vegetationProbability(biome,ISLAND.biomeSize,u,v)>0,'tree must belong to the registered vegetation mask');
  }
  assert.equal(islandVegetation(heights,new Uint8Array(ISLAND.biomeSize**2)).length,0,'bare imagery mask cannot sprout trees');
});

test('regional image and height layers share provenance and geographic bounds',async()=>{
  const manifest=JSON.parse(await readFile(new URL('../assets/world/saba/manifest.json',import.meta.url),'utf8'));
  assert.equal(manifest.schemaVersion,2);assert.equal(manifest.id,ISLAND.id);
  assert.equal(manifest.spanMetres,ISLAND.span);assert.equal(manifest.gridSize,ISLAND.size);
  assert.deepEqual(manifest.localOrigin,{x:ISLAND.x,z:ISLAND.z});
  assert.equal(manifest.imagery.licence,'CC BY 4.0');assert.match(manifest.imagery.url,/REQUEST=GetMap/);
  assert.equal(manifest.imagery.derivedSpacingMetres,8);assert.equal(manifest.vegetation.maskSize,ISLAND.biomeSize);
  assert.equal(manifest.terrainSurvey.sourceSpacingMetres,.5);assert.equal(manifest.terrainSurvey.derivedSpacingMetres,16);
  assert.match(manifest.terrainSurvey.sourceCRS,/10641/);
  assert.match(manifest.authoredBathymetry.provenance,/not measured bathymetry/);
  assert.equal(manifest.authoredBathymetry.maximumDepthMetres,120);
  assert.equal(manifest.authoredBathymetry.depthPerShoreMetre,.15);
  const seabed=Array.from(heights).filter(h=>h<0);
  assert.ok(new Set(seabed).size>100,'coastal depth grades offshore rather than one flat shelf');
  assert.ok(seabed.every(h=>h>=-120));
  const png=await readFile(new URL('../assets/world/saba/albedo.png',import.meta.url));
  assert.equal(png.readUInt32BE(16),ISLAND.albedoSize);assert.equal(png.readUInt32BE(20),ISLAND.albedoSize);
  const {createHash}=await import('node:crypto');
  assert.equal(createHash('sha256').update(png).digest('hex'),manifest.imagery.albedoSHA256);
  assert.equal(createHash('sha256').update(biome).digest('hex'),manifest.vegetation.sha256);
  assert.equal(createHash('sha256').update(file).digest('hex'),manifest.heightSHA256);
  assert.ok(Object.isFrozen(LAND_REGIONS.saba.assets));
  assert.throws(()=>decodeBiome(new ArrayBuffer(1)),/Incomplete/);
  // An all-green procedural field would fail this: real exposed southern slopes
  // and the greener interior retain markedly different source probabilities.
  const patch=(u,v)=>vegetationProbability(biome,ISLAND.biomeSize,u,v);
  assert.ok(patch(.50,.50)>patch(.49,.72)+.20,'central forest differs from dry southern flank');
});

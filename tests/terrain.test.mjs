import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {ISLAND,LAND_REGIONS,LANDFALL_VIEWS,decodeIsland,decodeBiome,islandGeometry,islandVegetation,terrainSample,islandCoordinates,constrainIslandMotion,safeLandfallStart} from '../js/terrain-model.js';
import {TREE_VARIANTS,TREE_LOD,treeGeometry,treeSkeleton,selectTreeLods,vegetationProbability} from '../js/vegetation.js';
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
      // Match copyVessel's exact following offset at the preset's heading0.
      const copyView={...start,x:start.x+victory.length*1.5,z:start.z+victory.length*2.8};
      const follower=safeLandfallStart(heights,copyView,victory);
      const copy={...victory,...follower};
      assert.equal(constrainIslandMotion(heights,copy,copy.x,copy.z),false);
      assert.ok(Math.hypot(follower.x-copyView.x,follower.z-copyView.z)<=500,'companion adjustment stays near the coastal scene');
      if(view===LANDFALL_VIEWS.coast)assert.equal(follower.moved,true,'first-rate follower originally lies over the shallows');
    }
    assert.deepEqual(view,original);assert.deepEqual(caravel,before,'spawn search cannot alter physics or camera input');
  }
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
  assert.ok(trees.length/8>1000&&trees.length/8<4000);
  for(let i=0;i<trees.length;i+=8){
    assert.ok(trees.slice(i,i+8).every(Number.isFinite));
    assert.ok(Math.abs(trees[i+1]-terrainSample(heights,trees[i],trees[i+2]))<.05);
    assert.ok(trees[i+1]>=15);
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

test('recursive tree variants retain physical extents while increasing branch and foliage detail',()=>{
  const variants=[];
  for(let variant=0;variant<TREE_VARIANTS;variant++){
    const skeleton=treeSkeleton(variant);assert.deepEqual(skeleton,treeSkeleton(variant));
    assert.equal(skeleton.branches.length,17);assert.equal(skeleton.crowns.length,5);
    variants.push(JSON.stringify(skeleton));
    let lastCount=0,canonical=null;
    for(let lod=0;lod<3;lod++){
      const geometry=treeGeometry(variant,lod);assert.deepEqual(geometry,treeGeometry(variant,lod));
      assert.ok(geometry.length>lastCount);lastCount=geometry.length;
      assert.ok(geometry.length/8<2300,'bounded shared tree mesh');
      const bounds={min:[Infinity,Infinity,Infinity],max:[-Infinity,-Infinity,-Infinity]};
      for(let i=0;i<geometry.length;i+=8){
        assert.ok(geometry.subarray(i,i+8).every(Number.isFinite));
        assert.ok(Math.abs(Math.hypot(...geometry.subarray(i+3,i+6))-1)<1e-5);
        for(let a=0;a<3;a++){bounds.min[a]=Math.min(bounds.min[a],geometry[i+a]);bounds.max[a]=Math.max(bounds.max[a],geometry[i+a]);}
      }
      assert.ok(bounds.max[1]<=1.001&&bounds.max[1]>.999);
      if(!canonical)canonical=bounds;
      for(const a of [0,2]){
        assert.ok(Math.abs(bounds.min[a]-canonical.min[a])<1e-6);
        assert.ok(Math.abs(bounds.max[a]-canonical.max[a])<1e-6);
      }
      assert.ok(bounds.min[1]>=-.001);
    }
  }
  assert.equal(new Set(variants).size,TREE_VARIANTS);
});

test('distance LOD preserves every tree identity, root and physical scale under budgets and repeated approaches',()=>{
  const trees=islandVegetation(heights,biome),original=trees.slice(),history=new Map();
  const far={x:0,y:6,z:10500},close={x:-2000,y:80,z:-4400};
  const distant=selectTreeLods(trees,far,history),near=selectTreeLods(trees,close,history);
  assert.ok(distant.every(t=>t.lod===0));assert.ok(near.some(t=>t.lod===2));
  assert.equal(near.length,trees.length/8);assert.equal(new Set(near.map(t=>t.id)).size,near.length);
  assert.ok(near.filter(t=>t.lod===2).length<=TREE_LOD.maxNear);
  assert.ok(near.filter(t=>t.lod===1).length<=TREE_LOD.maxMiddle);
  assert.deepEqual(trees,original);
  selectTreeLods(trees,far,history);
  assert.deepEqual(selectTreeLods(trees,close,history),near,'returning approach selects the same identities and geometry');
  const point=new Float32Array([0,0,0,4,12,.25,0,0]),held=new Map([[0,2]]);
  assert.equal(selectTreeLods(point,{x:TREE_LOD.near+10,y:0,z:0},held)[0].lod,2,'hysteresis prevents boundary chatter');
  assert.equal(selectTreeLods(point,{x:TREE_LOD.near*1.2,y:0,z:0},held)[0].lod,1);
});

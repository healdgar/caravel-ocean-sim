import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {ISLAND,LAND_REGIONS,LANDFALL_VIEWS,decodeIsland,decodeBiome,islandGeometry,islandVegetation,terrainSample,islandCoordinates,constrainIslandMotion,safeLandfallStart} from '../js/terrain-model.js';
import {TREE_VARIANTS,TREE_VERTEX_FLOATS,TREE_LOD,treeGeometry,treeRenderGeometry,treeSkeleton,selectTreeLods,vegetationProbability} from '../js/vegetation.js';
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

const distance3=(a,b)=>Math.hypot(...a.map((v,i)=>v-b[i]));
const pathLength=path=>path.slice(1).reduce((sum,p,i)=>sum+distance3(p,path[i]),0);
const treeBounds=geometry=>{
  const bounds={min:[Infinity,Infinity,Infinity],max:[-Infinity,-Infinity,-Infinity]};
  for(let i=0;i<geometry.length;i+=TREE_VERTEX_FLOATS)for(let a=0;a<3;a++){
    bounds.min[a]=Math.min(bounds.min[a],geometry[i+a]);bounds.max[a]=Math.max(bounds.max[a],geometry[i+a]);
  }
  return bounds;
};

test('recursive tree branches form a connected, tapered hierarchy with seeded irregular growth',()=>{
  assert.ok(TREE_VARIANTS>=8,'forest has more than four repeated silhouettes');
  const variants=[];
  for(let variant=0;variant<TREE_VARIANTS;variant++){
    const skeleton=treeSkeleton(variant),{branches,crowns}=skeleton;
    assert.deepEqual(skeleton,treeSkeleton(variant));variants.push(JSON.stringify(skeleton));
    assert.equal(crowns.length,0,'foliage cannot regress to closed ellipsoid crowns');
    assert.ok(branches.length>100&&branches.length<300,'real recursive detail remains bounded');
    assert.deepEqual(branches[0].from,[0,0,0]);assert.equal(branches[0].parent,-1);
    const levels=new Map(),children=new Uint16Array(branches.length);
    let curved=0;
    for(const [index,branch] of branches.entries()){
      assert.equal(branch.id,index);assert.ok(Number.isInteger(branch.level));
      assert.equal(branch.path[0],branch.from);assert.equal(branch.path.at(-1),branch.to);
      assert.equal(branch.radii.length,branch.path.length);assert.ok(branch.path.length>=3);
      assert.equal(branch.radii[0],branch.radius);assert.equal(branch.radii.at(-1),branch.tipRadius);
      assert.ok(branch.tipRadius>0&&branch.tipRadius<branch.radius*.3,'branch tips taper substantially');
      for(let i=0;i<branch.path.length;i++){
        assert.ok(branch.path[i].every(Number.isFinite));assert.ok(branch.path[i][1]>=0);
        assert.ok(Number.isFinite(branch.radii[i])&&branch.radii[i]>0);
        if(i){assert.ok(branch.radii[i]<branch.radii[i-1]);assert.ok(distance3(branch.path[i],branch.path[i-1])>0);}
      }
      if(index){
        assert.ok(Number.isInteger(branch.parent)&&branch.parent>=0&&branch.parent<index,'parents precede children without cycles');
        const parent=branches[branch.parent];children[branch.parent]++;
        assert.equal(branch.level,parent.level+1);
        assert.ok(branch.attachIndex>0&&branch.attachIndex<parent.path.length);
        assert.equal(branch.from,parent.path[branch.attachIndex],'limb origin shares its actual curved parent section');
        assert.ok(branch.radius<parent.radii[branch.attachIndex],'child root fits inside its parent section');
        assert.ok(branch.growthLength>0&&branch.growthLength<parent.growthLength*.8,'recursive growth lengths shrink before independent height/radius scaling');
      }
      const chord=distance3(branch.from,branch.to);
      if(pathLength(branch.path)>chord+1e-6)curved++;
      const lengths=levels.get(branch.level)??[];lengths.push(pathLength(branch.path));levels.set(branch.level,lengths);
    }
    assert.ok(levels.size>=5,'trunk recursively forks through terminal twigs');
    assert.ok(curved>branches.length*.9,'section paths twist rather than reuse straight cylinders');
    for(let level=2;level<levels.size;level++){
      const mean=n=>levels.get(n).reduce((sum,length)=>sum+length,0)/levels.get(n).length;
      assert.ok(mean(level)<mean(level-1)*.8,'successive twig generations become shorter');
    }
    assert.ok(branches.filter((b,i)=>children[i]===0).every(b=>b.level===levels.size-1));
  }
  assert.equal(new Set(variants).size,TREE_VARIANTS,'each seed changes growth, not just instance colour');
});

test('leaf sprays attach to outer branches and terminal twigs with stem-to-tip texture coordinates',()=>{
  for(let variant=0;variant<TREE_VARIANTS;variant++){
    const {branches,sprays}=treeSkeleton(variant),parents=new Set(branches.map(b=>b.parent)),leafLevels=new Set();
    assert.ok(sprays.length>500&&sprays.length<1500,'leaf sprays fill the canopy without unbounded growth');
    for(const spray of sprays){
      const branch=branches[spray.branch];assert.ok(branch&&branch.level>=3,'leaves belong to outer branches and twigs');leafLevels.add(branch.level);
      if(branch.level===4)assert.ok(!parents.has(branch.id));
      assert.ok(spray.attach>=0&&spray.attach<=1);
      // Anchors follow their actual curved section, not a root-to-tip chord.
      assert.ok(Number.isInteger(spray.attachIndex)&&spray.attachIndex>=0&&spray.attachIndex<branch.path.length-1);
      const a=branch.path[spray.attachIndex],b=branch.path[spray.attachIndex+1];
      const d=b.map((v,i)=>v-a[i]),t=d.reduce((sum,v,i)=>sum+v*(spray.anchor[i]-a[i]),0)/d.reduce((sum,v)=>sum+v*v,0);
      const point=a.map((v,i)=>v+d[i]*t);
      assert.ok(t>=-1e-8&&t<=1+1e-8&&distance3(point,spray.anchor)<1e-8,'leaf stem is on its curved parent twig');
      const stem=spray.corners[0].map((v,i)=>(v+spray.corners[1][i])*.5);
      assert.ok(distance3(stem,spray.anchor)<1e-8,'the card stem meets the twig, without floating leaves');
      assert.ok(spray.corners.every(p=>p.every(Number.isFinite)));assert.ok(spray.width>0&&spray.height>0);
      assert.ok(distance3(spray.corners[0],spray.corners[1])>0&&distance3(spray.corners[0],spray.corners[2])>0);
    }
    assert.deepEqual([...leafLevels].sort(),[3,4]);
    const geometry=treeGeometry(variant,2),uvs=new Set();
    for(let i=0;i<geometry.length;i+=TREE_VERTEX_FLOATS)if(geometry[i+6]===2){
      const [u,v]=geometry.subarray(i+8,i+10);assert.ok(u>=0&&u<=1&&v>=0&&v<=1);uvs.add(`${u},${v}`);
    }
    assert.deepEqual([...uvs].sort(),['0,0','0,1','1,0','1,1']);
  }
});

test('tree LOD changes detail without changing roots, silhouettes or physical dimensions',()=>{
  const triangleLimits=[200,2500,8000];
  for(let variant=0;variant<TREE_VARIANTS;variant++){
    let lastCount=0,canonical=null;
    for(let lod=0;lod<3;lod++){
      const geometry=treeGeometry(variant,lod);assert.deepEqual(geometry,treeGeometry(variant,lod));
      assert.equal(geometry.length%(TREE_VERTEX_FLOATS*3),0);assert.ok(geometry.length>lastCount);lastCount=geometry.length;
      assert.ok(geometry.length/(TREE_VERTEX_FLOATS*3)<=triangleLimits[lod],'shared tree geometry respects its tier budget');
      let foliage=0,bark=0;
      for(let i=0;i<geometry.length;i+=TREE_VERTEX_FLOATS){
        assert.ok(geometry.subarray(i,i+TREE_VERTEX_FLOATS).every(Number.isFinite));
        assert.ok(Math.abs(Math.hypot(...geometry.subarray(i+3,i+6))-1)<1e-5);
        assert.ok(geometry[i+6]===2||geometry[i+6]===3);foliage+=geometry[i+6]===2;bark+=geometry[i+6]===3;
      }
      assert.ok(foliage>100&&bark>=18,'every detail tier retains foliage and a visible trunk');
      for(let i=0;i<geometry.length;i+=TREE_VERTEX_FLOATS*3){
        const a=geometry.subarray(i,i+3),b=geometry.subarray(i+TREE_VERTEX_FLOATS,i+TREE_VERTEX_FLOATS+3),c=geometry.subarray(i+TREE_VERTEX_FLOATS*2,i+TREE_VERTEX_FLOATS*2+3);
        const u=Array.from(b,(v,k)=>v-a[k]),v=Array.from(c,(n,k)=>n-a[k]);
        assert.ok(Math.hypot(u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0])>1e-12,'no collapsed branch or leaf triangles');
      }
      const bounds=treeBounds(geometry);
      assert.ok(bounds.max[1]<=1.001&&bounds.max[1]>.999);assert.equal(bounds.min[1],0);
      if(!canonical)canonical=bounds;
      for(let a=0;a<3;a++){
        assert.ok(Math.abs(bounds.min[a]-canonical.min[a])<1e-6);
        assert.ok(Math.abs(bounds.max[a]-canonical.max[a])<1e-6);
      }
    }
  }
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

test('legacy authoring budgets bound detail work while the denser forest retains every identity',()=>{
  const trees=islandVegetation(heights,biome),crowded=trees.slice(),triangles=[];
  for(let variant=0;variant<TREE_VARIANTS;variant++)triangles.push([0,1,2].map(lod=>treeRenderGeometry(variant,lod).length/(TREE_VERTEX_FLOATS*3)));
  // A dense synthetic approach forces both detail budgets to overflow. Trees
  // must step down in detail while retaining every identity and shape variant.
  for(let i=0;i<crowded.length;i+=8){crowded[i]=0;crowded[i+1]=0;crowded[i+2]=0;}
  const selected=selectTreeLods(crowded,{x:0,y:0,z:0});
  assert.equal(selected.length,crowded.length/8);
  assert.equal(selected.filter(t=>t.lod===2).length,Math.min(TREE_LOD.maxNear,selected.length));
  assert.ok(selected.filter(t=>t.lod===1).length<=TREE_LOD.maxMiddle);
  assert.equal(new Set(selected.map(t=>t.variant)).size,TREE_VARIANTS);
  const count=selected.reduce((sum,t)=>sum+triangles[t.variant][t.lod],0);
  // Population grew from 1775 to 17466. Bound per-instance aggregate geometry
  // plus the explicit legacy detail budgets, rather than keeping an obsolete
  // global triangle cap that could pass only by deleting requested vegetation.
  const farMax=Math.max(...triangles.map(t=>t[0])),middleMax=Math.max(...triangles.map(t=>t[1])),nearMax=Math.max(...triangles.map(t=>t[2]));
  assert.ok(farMax<=300);
  assert.ok(count<=selected.length*farMax+TREE_LOD.maxMiddle*(middleMax-farMax)+TREE_LOD.maxNear*(nearMax-farMax),`crowded authoring forest is ${count} triangles`);
  for(const [id,tree] of selected.entries()){
    assert.equal(tree.id,id,'budget overflow cannot drop or reorder tied instance identities');
    assert.equal(tree.variant,Math.min(TREE_VARIANTS-1,Math.floor(crowded[id*8+5]*TREE_VARIANTS)));
  }
});

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createGunDefinitions,gunMuzzlePose,createGunRecoilMap,updateGunRecoilVertices} from '../js/gunnery-models.js';
import {createShipAssetCache} from '../js/ship-mesh.js';
import {VICTORY_DESIGN,victoryVesselDeck,victorySheer} from '../js/models/victory.js';
import {NINA_DESIGN} from '../js/models/nina.js';
import {HULL_UNIFORM_BYTES} from '../js/hull.js';
import {ADDITIONAL_DESIGNS,additionalDeck} from '../js/models/additional.js';

const gunneryModelIDs=['nina','victory','pinta','santa-maria'],cache=createShipAssetCache(),assets=Object.fromEntries(gunneryModelIDs.map(id=>[id,cache.get(id)]));
const boatFor=modelId=>({modelId,...assets[modelId].model.runtime,propulsion:'sail',
  surgeVelocity:3,leewayVelocity:.4,heading:31,pitch:.2,roll:-.1,x:50,z:120,heave:2,heaveVelocity:.8,pitchVelocity:.13,rollVelocity:-.17,yawRate:.11});
const close=(actual,wanted,tolerance=1e-6)=>assert.ok(Math.abs(actual-wanted)<=tolerance,`${actual} differs from ${wanted} by more than ${tolerance}`);

test('model gun registries enumerate the three actual four-swivel outfits and 104 first-rate mountings with stable side/deck ids',()=>{
  const nina=createGunDefinitions('nina'),victory=createGunDefinitions({modelId:'victory'}),pinta=createGunDefinitions('pinta'),santa=createGunDefinitions('santa-maria');
  assert.equal(nina.length,4);assert.equal(victory.length,104);assert.ok(Object.isFrozen(victory)&&Object.isFrozen(victory[0].muzzleDesign));
  for(const[model,defs]of Object.entries({nina,victory,pinta,'santa-maria':santa})){
    assert.deepEqual(defs.map(g=>g.id),Array.from({length:defs.length},(_,i)=>i));
    for(const side of['port','starboard'])assert.equal(defs.filter(g=>g.side===side).length,defs.length/2);
    for(const gun of defs){
      assert.ok(assets[model].groups.some(g=>g.id===gun.meshGroup));
      assert.equal(gun.sideSign,gun.side==='port'?-1:1);assert.equal(gun.visibleCrew,gun.weatherDeck);
      assert.ok(gun.muzzleDesign.every(Number.isFinite)&&gun.station.every(Number.isFinite));
      assert.ok(gun.station[0]*gun.sideSign<gun.muzzleDesign[0]*gun.sideSign,'crew home/tackle station inboard of muzzle');
      assert.ok(gun.floorDesign<gun.muzzleDesign[1]);
    }
  }
  assert.equal(victory.filter(g=>g.visibleCrew).length,16);assert.equal(victory.filter(g=>g.kind==='carronade'&&g.calibre===68).length,2);
  for(const[deck,count]of[['lower',30],['middle',28],['upper',30],['quarter',12],['forecastle',4]])assert.equal(victory.filter(g=>g.deck===deck).length,count);
  assert.equal(victory[88].meshGroup,'gun.quarter.port.0');assert.equal(victory[103].meshGroup,'gun.forecastle.starboard.1');
  for(const [id,defs]of [['pinta',pinta],['santa-maria',santa]]){
    assert.equal(defs.length,4);assert.deepEqual(defs.map(g=>g.id),[0,1,2,3]);assert.deepEqual(defs.map(g=>g.meshGroup),['gun.0','gun.1','gun.2','gun.3']);
    assert.notEqual(defs,nina,'an additional ship owns its gun attachment list');assert.ok(defs.every(g=>g.kind==='swivel'&&g.type==='swivel'&&g.calibre===2&&g.weatherDeck));
    assert.deepEqual(defs.map(g=>g.muzzleDesign[2]),ADDITIONAL_DESIGNS[id].equipment.guns.map(g=>g.z));
    assert.ok(Object.isFrozen(defs)&&Object.isFrozen(defs[0].muzzleDesign));
  }
  assert.throws(()=>createGunDefinitions('unknown-ship'),/No playable gun/);assert.equal(HULL_UNIFORM_BYTES,208);
});

test('quarterdeck battery remains before the poop and every weatherdeck crew floor is the actual visible deck',()=>{
  const quarter=VICTORY_DESIGN.gunDecks.find(g=>g.id==='quarter');assert.equal(quarter.end,4.12);
  for(const gun of createGunDefinitions('victory').filter(g=>g.weatherDeck)){
    close(gun.floorDesign,victoryVesselDeck(gun.muzzleDesign[2]),1e-12);
    if(gun.deck==='quarter'){
      assert.ok(gun.muzzleDesign[2]<VICTORY_DESIGN.decks.poop.start);
      close(gun.floorDesign-victorySheer(gun.muzzleDesign[2]),VICTORY_DESIGN.decks.quarter.height,1e-12);
    }
    assert.ok(gun.muzzleDesign[1]-gun.floorDesign>.15,'barrel is above the crew standing surface');
  }
  for(const gun of createGunDefinitions('nina'))assert.equal(gun.floorDesign,NINA_DESIGN.quarterdeck.height);
  for(const id of ['pinta','santa-maria'])for(const gun of createGunDefinitions(id))close(gun.floorDesign,additionalDeck(id,gun.muzzleDesign[2]),1e-12);
});

test('each registry muzzle plane and moving range matches rendered barrel geometry rather than a guessed hull point',()=>{
  for(const modelId of gunneryModelIDs){
    const asset=assets[modelId],defs=createGunDefinitions(modelId),motion=asset.groups.filter(g=>g.motion?.type==='gun-recoil');
    assert.equal(motion.length,defs.length);
    for(const group of motion){
      const gun=defs[group.motion.gunId],axis=gun.directionDesign,normal=axis.map(x=>x/Math.hypot(...axis));
      let furthest=-Infinity;
      for(let i=group.firstVertex;i<group.firstVertex+group.vertexCount;i++){
        const at=asset.indices[i]*9,projection=normal.reduce((sum,n,j)=>sum+n*(asset.vertices[at+j]-gun.muzzleDesign[j]),0);
        furthest=Math.max(furthest,projection);
      }
      close(furthest,0,2e-6);
    }
  }
});

test('world muzzle velocity equals finite-differenced yaw/pitch/roll/heave and physical translation at the same attachment',()=>{
  for(const modelId of gunneryModelIDs)for(const gun of[createGunDefinitions(modelId)[0],createGunDefinitions(modelId).at(-1)]){
    const boat=boatFor(modelId),pose=gunMuzzlePose(gun,boat),epsilon=1e-5;
    const at=delta=>{
      const heading=boat.heading*Math.PI/180,dx=boat.surgeVelocity*Math.sin(heading)+boat.leewayVelocity*Math.cos(heading),dz=-boat.surgeVelocity*Math.cos(heading)+boat.leewayVelocity*Math.sin(heading);
      return gunMuzzlePose(gun,{...boat,x:boat.x+dx*delta,z:boat.z+dz*delta,heave:boat.heave+boat.heaveVelocity*delta,
        heading:boat.heading+boat.yawRate*delta*180/Math.PI,pitch:boat.pitch+boat.pitchVelocity*delta,roll:boat.roll+boat.rollVelocity*delta}).position;
    };
    const before=at(-epsilon),after=at(epsilon);
    for(let i=0;i<3;i++)close(pose.velocity[i],(after[i]-before[i])/(2*epsilon),2e-7);
    close(Math.hypot(...pose.direction),1,1e-12);
  }
});

test('run-in offset is physical metres with any vessel scaling and moves along the exact barrel bore',()=>{
  for(const modelId of gunneryModelIDs){
    const boat={...boatFor(modelId),length:80,beam:11},gun=createGunDefinitions(modelId)[0],out=gunMuzzlePose(gun,boat),inside=gunMuzzlePose({...gun,offset:1.1},boat);
    close(Math.hypot(...out.position.map((x,i)=>x-inside.position[i])),1.1,1e-12);
    for(let i=0;i<3;i++)close(out.position[i]-inside.position[i],out.direction[i]*1.1,1e-12);
  }
});

test('sparse recoil changes only tagged moving positions, leaves all fixed ports/UVs/normals intact and restores exact rest bits',()=>{
  for(const modelId of gunneryModelIDs){
    const asset=assets[modelId],map=createGunRecoilMap(asset),vertices=new Float32Array(asset.vertices),boat=boatFor(modelId);
    const offsets=Array.from({length:map.guns.length},()=>0);offsets[0]=.7;
    const ranges=updateGunRecoilVertices(map,vertices,offsets,boat),moving=new Set(map.guns.find(g=>g.id===0).indices);
    assert.ok(ranges.length>0);for(const r of ranges){assert.equal(r.byteOffset,r.firstFloat*4);assert.equal(r.byteLength,r.floatCount*4);}
    let count=0;
    for(let i=0;i<vertices.length;i++){
      const index=Math.floor(i/9),component=i%9;
      if(component>=3||!moving.has(index))assert.equal(vertices[i],asset.vertices[i]);
      else if(vertices[i]!==asset.vertices[i]){count++;assert.ok(ranges.some(r=>i>=r.firstFloat&&i<r.firstFloat+r.floatCount));}
    }
    assert.ok(count>0);assert.deepEqual(updateGunRecoilVertices(map,vertices,offsets,boat),[],'unchanged recoil writes no GPU vertices');
    const first=map.guns.find(g=>g.id===0).indices[0],at=first*9,scale=[boat.beam/3.6,asset.model.designFrame.verticalScale,boat.length/12];
    const gun=createGunDefinitions(modelId)[0],out=gunMuzzlePose(gun,boat),inside=gunMuzzlePose({...gun,offset:.7},boat);
    for(let i=0;i<3;i++)close((vertices[at+i]-asset.vertices[at+i])*scale[i],inside.localPosition[i]-out.localPosition[i],2e-6);
    offsets[0]=0;updateGunRecoilVertices(map,vertices,offsets,boat);
    assert.deepEqual(new Uint32Array(vertices.buffer),new Uint32Array(asset.vertices.buffer),'including signed-zero rest coordinates');
    assert.equal(asset.groups.filter(g=>g.motion?.type==='gun-recoil').length,createGunDefinitions(modelId).length);
  }
});

test('recoil runtime handles core gun objects and updates nonzero metre offsets when vessel dimensions change',()=>{
  for(const modelId of gunneryModelIDs){
    const asset=assets[modelId],map=createGunRecoilMap(asset),vertices=new Float32Array(asset.vertices),boat=boatFor(modelId),offsets=[{offset:1}];
    updateGunRecoilVertices(map,vertices,offsets,boat);const index=map.guns[0].indices[0],at=index*9;
    const bigger={...boat,beam:boat.beam*2},ranges=updateGunRecoilVertices(map,vertices,offsets,bigger);assert.ok(ranges.length>0);
    const gun=createGunDefinitions(modelId)[0],out=gunMuzzlePose(gun,bigger),inside=gunMuzzlePose({...gun,offset:1},bigger),scale=[bigger.beam/3.6,asset.model.designFrame.verticalScale,bigger.length/12];
    for(let i=0;i<3;i++)close((vertices[at+i]-asset.vertices[at+i])*scale[i],inside.localPosition[i]-out.localPosition[i],2e-6);
    if(modelId==='victory'){
      const rest=new Float32Array(asset.vertices),restMap=createGunRecoilMap(asset);updateGunRecoilVertices(restMap,rest,offsets,boat);
      close(vertices[at]-asset.vertices[at],(rest[at]-asset.vertices[at])*.5,1e-7);
    }
  }
});

test('recoil map rejects indexed vertices shared by static structure instead of tearing the gunport',()=>{
  const asset={vertices:new Float32Array(27),indices:new Uint32Array([0,1,2,0,1,2]),groups:[
    {firstVertex:0,vertexCount:3,motion:{type:'gun-recoil',gunId:0,axis:[1,0,0]}}]};
  assert.throws(()=>createGunRecoilMap(asset),/shared with fixed/);
});

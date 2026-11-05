import {test} from 'node:test';
import assert from 'node:assert/strict';
import {generateProceduralCoastalPack,placeCoastalPort,syncPortInstancesToTerrain} from '../js/coastal-world.js';
import {terrainSurfaceSample} from '../js/terrain-model.js';
import {layTownStreets,streetEdgeAt,ROUTE_STEP_M,WALKER_WORDS} from '../js/town-streets.js';

const grid={size:257,biomeSize:64,albedoSize:64,vegetationCandidates:400};
const packs=new Map();
const pack=region=>{if(!packs.has(region))packs.set(region,generateProceduralCoastalPack(region,grid));return packs.get(region);};
const AT_THE_WATER=new Set(['timber_mole_pier','stone_quay_seawall','stone_arch_bridge','careening_shed','astillero_and_moored_hull','thatched_bohio_palafito','indigenous_canoe_landing','palafito_estuary_village','stone_sea_bastion','torreon_atalaya_farol','english_triangular_palisade_fort','indigenous_palisade_ring']);
function wetShare(inst,heights,region){
  const c=Math.cos(inst.yaw),s=Math.sin(inst.yaw);let wet=0,total=0;
  for(let a=-1;a<=1;a+=.25)for(let b=-1;b<=1;b+=.25){
    const lx=a*inst.width/2,lz=b*inst.length/2;
    if(terrainSurfaceSample(heights,inst.x+lx*c+lz*s,inst.z-lx*s+lz*c,region)<0)wet++;
    total++;
  }
  return wet/total;
}

// A round headland: the layout's straight shore is wrong almost everywhere on it.
function headland(){
  const region={id:'test-headland',latitude:18,longitude:-66,x:0,z:0,span:2048,size:257,biomeSize:64,albedoSize:64,shoreBearing:132,climate:'tropical',hasColonialPort:true,settlementKind:'colonial-port',portType:'headland-fortress',year:1650,foundedYear:1521,fortProgramYear:1539,crown:'spain',baseTier:3};
  const n=region.size,heights=new Float32Array(n*n);
  for(let j=0;j<n;j++)for(let i=0;i<n;i++){
    const x=(i/(n-1)-.5)*region.span,z=(j/(n-1)-.5)*region.span,d=Math.hypot(x-120,z+60);
    heights[j*n+i]=(330-d)*.05;
  }
  return {region,heights};
}

test('no building stands in the sea on a coast that curves away from the layout',()=>{
  const {region,heights}=headland();
  const port=placeCoastalPort(region,heights,{preserveRealCoast:true});
  syncPortInstancesToTerrain(port,heights,region,{gradePads:true});
  assert.ok(port.instances.length>=6,`only ${port.instances.length} placed`);
  for(const inst of port.instances){
    if(AT_THE_WATER.has(inst.prefabId))continue;
    assert.equal(wetShare(inst,heights,region),0,`${inst.prefabId} at ${inst.x.toFixed(0)},${inst.z.toFixed(0)} is in the water`);
  }
  for(const inst of port.instances.filter(i=>i.prefabId==='stone_sea_bastion'||i.prefabId==='torreon_atalaya_farol')){
    assert.ok(wetShare(inst,heights,region)<.5,`${inst.prefabId} should have most of its floor on land`);
  }
});

test('a pier reaches from the shore into water, and a bridge has a bank at each end',()=>{
  for(const region of ['cartagena','havana','lisbon']){
    const {port,heights,region:r}=pack(region);
    for(const inst of port.instances){
      const axisX=Math.sin(inst.yaw)*inst.length/2,axisZ=Math.cos(inst.yaw)*inst.length/2;
      const a=terrainSurfaceSample(heights,inst.x+axisX,inst.z+axisZ,r),b=terrainSurfaceSample(heights,inst.x-axisX,inst.z-axisZ,r);
      if(inst.prefabId==='timber_mole_pier'&&inst.y>1)assert.ok(Math.max(a,b)>-1.5&&Math.min(a,b)<0,`${region} pier ends ${a.toFixed(1)} and ${b.toFixed(1)}`);
      if(inst.prefabId==='stone_arch_bridge')assert.ok(Math.min(a,b)>0,`${region} bridge ends ${a.toFixed(1)} and ${b.toFixed(1)}`);
    }
  }
});

test('every door in a town is joined to its ways',()=>{
  for(const region of ['cartagena','havana','lisbon']){
    const {port}=pack(region),{stats}=port.streets;
    assert.ok(stats.doors>=8,`${region} has ${stats.doors} doors`);
    assert.equal(stats.stranded,0,`${region} left ${stats.stranded} doors with no way to them`);
    assert.ok(stats.wayMetres>300,`${region} has only ${stats.wayMetres} m of ways`);
  }
});

test('routes keep to dry ground or a deck, and do not pass through buildings',()=>{
  for(const region of ['cartagena','lisbon']){
    const {port,heights,region:r}=pack(region),{samples}=port.streets;
    const solid=port.instances.filter(i=>!['timber_mole_pier','stone_quay_seawall','stone_arch_bridge','indigenous_palisade_ring','english_triangular_palisade_fort'].includes(i.prefabId));
    let inside=0,total=0;
    for(let k=0;k<samples.length;k+=4){
      const x=samples[k],y=samples[k+1],z=samples[k+2];
      assert.ok(Number.isFinite(y)&&y>-.5,`${region} route sample at height ${y}`);
      const ground=terrainSurfaceSample(heights,x,z,r);
      assert.ok(y>=ground-3,`${region} route is ${(ground-y).toFixed(1)} m underground`);
      total++;
      for(const inst of solid){
        const c=Math.cos(inst.yaw),s=Math.sin(inst.yaw),dx=x-inst.x,dz=z-inst.z;
        if(Math.abs(dx*c-dz*s)<inst.width/2-2.2&&Math.abs(dx*s+dz*c)<inst.length/2-2.2){inside++;break;}
      }
    }
    // Only the last steps of a trip go through a door.
    assert.ok(inside/total<.02,`${region}: ${inside} of ${total} route samples are inside a building`);
  }
});

test('each walker is a valid place on a route and the layout does not change between loads',()=>{
  const {port,heights,region:r}=pack('cartagena'),streets=port.streets;
  const words=new Uint32Array(streets.walkers.buffer),floats=streets.walkers,sampleCount=streets.samples.length/4;
  assert.equal(streets.walkers.length,streets.people*WALKER_WORDS);
  for(let w=0;w<streets.people;w++){
    const at=w*WALKER_WORDS,first=words[at],count=words[at+1];
    assert.ok(count>=2&&first+count<=sampleCount,`walker ${w} route ${first}+${count} of ${sampleCount}`);
    assert.ok(Math.abs(floats[at+8]-(count-1)*ROUTE_STEP_M)<1e-3,`walker ${w} length`);
    assert.ok(floats[at+3]>=.9&&floats[at+3]<=1.7,`walker ${w} speed`);
    assert.ok(words[at+10]<=0xffff);
  }
  const again=layTownStreets(port,(x,z)=>terrainSurfaceSample(heights,x,z,r));
  assert.deepEqual(again.stats.wayMetres,streets.stats.wayMetres);
  assert.deepEqual(Buffer.from(again.field.buffer),Buffer.from(streets.field.buffer));
  assert.deepEqual(Buffer.from(again.walkers.buffer),Buffer.from(streets.walkers.buffer));
});

test('the field marks the ways, and nothing is seeded to grow on them',()=>{
  const {port,vegetation}=pack('cartagena'),streets=port.streets;
  for(const {points} of streets.ways)for(const [x,z] of points)assert.ok(streetEdgeAt(streets,x,z)<1,'a way must read as a way');
  assert.equal(streetEdgeAt(streets,streets.window.x+streets.window.span,streets.window.z),Infinity);
  const trees=vegetation.trees;
  for(let k=0;k<trees.length;k+=8)assert.ok(streetEdgeAt(streets,trees[k],trees[k+2])>=2.9,`tree at ${trees[k]},${trees[k+2]} stands on a way`);
});

test('a grown town paves its busy streets; a small one and a village keep to earth',()=>{
  const paved=port=>{let most=0;for(let k=1;k<port.streets.field.length;k+=2)if(port.streets.field[k]>most)most=port.streets.field[k];return most/255;};
  const city=pack('lisbon').port;
  assert.ok(['citadel-metropolis','fortified-port'].includes(city.stage),city.stage);
  assert.ok(paved(city)>.9,'Lisbon has cobbles');
  const {region,heights}=headland();
  const hamlet={...placeCoastalPort({...region,year:1530},heights,{preserveRealCoast:true})};
  hamlet.stage='outpost';
  const small=layTownStreets(hamlet,(x,z)=>terrainSurfaceSample(heights,x,z,region));
  if(small)assert.ok(paved({streets:small})<.6,'an outpost has no cobbles');
});

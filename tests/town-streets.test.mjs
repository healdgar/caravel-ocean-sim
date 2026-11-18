import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {generateProceduralCoastalPack,placeCoastalPort} from '../js/coastal-world.js';
import {BAKED_BOARDS} from '../js/board-model.js';
import {registerBakedBoard} from '../js/old-world.js';
import {terrainSurfaceSample} from '../js/terrain-model.js';
import {layTownStreets,paveCityStreets,streetEdgeAt,ROUTE_STEP_M,STREET_FIELD_EDGE_M,STREET_FIELD_RANGE_M,WALKER_WORDS} from '../js/town-streets.js';

// A port's ways are laid to its board's waterfront, so each pack stands on its board, on the ground it was founded on.
function upsampleSurvey(survey,n){
  const sN=Math.round(Math.sqrt(survey.length)),out=new Float32Array(n*n);
  for(let j=0;j<n;j++){
    const sy=j/(n-1)*(sN-1),y0=Math.min(sN-2,Math.floor(sy)),ty=sy-y0;
    for(let i=0;i<n;i++){
      const sx=i/(n-1)*(sN-1),x0=Math.min(sN-2,Math.floor(sx)),tx=sx-x0;
      const a=survey[y0*sN+x0],b=survey[y0*sN+x0+1],c=survey[(y0+1)*sN+x0],d=survey[(y0+1)*sN+x0+1];
      out[j*n+i]=(a*(1-tx)+b*tx)*(1-ty)+(c*(1-tx)+d*tx)*ty;
    }
  }
  return out;
}
const packs=new Map();
const pack=id=>{
  if(!packs.has(id)){
    const baked=JSON.parse(readFileSync(new URL('../'+BAKED_BOARDS[`${id}:1550`],import.meta.url),'utf8'));
    const region={...baked.region,size:257,biomeSize:64,albedoSize:64,vegetationCandidates:400,year:1550};
    registerBakedBoard(baked);
    packs.set(id,generateProceduralCoastalPack(region,{},upsampleSurvey(baked.survey,region.size)));
  }
  return packs.get(id);
};
// A round headland, with no board laid on it.
function headland(){
  const region={id:'test-headland',latitude:18,longitude:-66,x:0,z:0,span:2048,size:257,biomeSize:64,albedoSize:64,shoreBearing:132,climate:'tropical',hasColonialPort:true,settlementKind:'colonial-port',portType:'headland-fortress',year:1650,foundedYear:1521,fortProgramYear:1539,crown:'spain',baseTier:3};
  const n=region.size,heights=new Float32Array(n*n);
  for(let j=0;j<n;j++)for(let i=0;i<n;i++){
    const x=(i/(n-1)-.5)*region.span,z=(j/(n-1)-.5)*region.span,d=Math.hypot(x-120,z+60);
    heights[j*n+i]=(330-d)*.05;
  }
  return {region,heights};
}

// A mole runs from the quay's face (local +z, landward) out over the water to its head (local -z).
test('a pier reaches from the shore into water',()=>{
  for(const region of ['cartagena','havana','lisbon']){
    const {port,heights,region:r}=pack(region);
    for(const pier of port.waterfront.filter(w=>w.kind==='pier')){
      const axisX=Math.sin(pier.yaw)*pier.length/2,axisZ=Math.cos(pier.yaw)*pier.length/2;
      const root=terrainSurfaceSample(heights,pier.x+axisX,pier.z+axisZ,r),head=terrainSurfaceSample(heights,pier.x-axisX,pier.z-axisZ,r);
      assert.ok(root>-1.5&&head<0&&head<root,`${region} pier root ${root.toFixed(1)}, head ${head.toFixed(1)}`);
    }
  }
});

test('every door in a town is joined to its ways',()=>{
  for(const region of ['cartagena','havana','lisbon']){
    const {port}=pack(region);
    assert.ok(port.streets,`${region} has no ways`);
    const {stats}=port.streets;
    // Doors are the waterfront's: its moles, slipway and careening shed (a quay is walked on, not entered).
    assert.ok(stats.doors>=2,`${region} has ${stats.doors} doors`);
    assert.equal(stats.stranded,0,`${region} left ${stats.stranded} doors with no way to them`);
    assert.ok(stats.wayMetres>0,`${region} has only ${stats.wayMetres} m of ways`);
  }
});

test('routes keep to dry ground or a deck, and do not pass through buildings',()=>{
  for(const region of ['cartagena','lisbon']){
    const {port,heights,region:r}=pack(region),{samples}=port.streets;
    // What is walked round: the waterfront's works without a deck (a slipway, a careening shed).
    const solid=port.waterfront.filter(w=>w.deck==null);
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
  // Laid again and paved with the board's own streets, as the pack does.
  const again=paveCityStreets(layTownStreets(port,(x,z)=>terrainSurfaceSample(heights,x,z,r)),streets.cityWays);
  assert.deepEqual(again.stats.wayMetres,streets.stats.wayMetres);
  assert.deepEqual(Buffer.from(again.field.buffer),Buffer.from(streets.field.buffer));
  assert.deepEqual(Buffer.from(again.walkers.buffer),Buffer.from(streets.walkers.buffer));
});

test('the field marks the ways, and nothing is seeded to grow on them',()=>{
  const {port,vegetation}=pack('cartagena'),streets=port.streets;
  for(const {points} of streets.ways)for(const [x,z] of points)assert.ok(streetEdgeAt(streets,x,z)<1,'a way must read as a way');
  // Far from every way, nothing reads as one.
  assert.ok(streetEdgeAt(streets,streets.window.x+1e5,streets.window.z)>=STREET_FIELD_RANGE_M-STREET_FIELD_EDGE_M);
  const trees=vegetation.trees;
  for(let k=0;k<trees.length;k+=8)assert.ok(streetEdgeAt(streets,trees[k],trees[k+2])>=2.9,`tree at ${trees[k]},${trees[k+2]} stands on a way`);
});

test('a grown town paves its busy streets; a small one and a village keep to earth',()=>{
  const paved=port=>{let most=0;for(let k=1;k<port.streets.field.length;k+=2)if(port.streets.field[k]>most)most=port.streets.field[k];return most/255;};
  const city=pack('lisbon').port;
  assert.ok(['citadel-metropolis','fortified-port'].includes(city.stage),city.stage);
  assert.ok(paved(city)>.9,'Lisbon has cobbles');
  // Cartagena's waterfront as an outpost's: the same ways, earth.
  const {port,heights,region}=pack('cartagena');
  const small=layTownStreets({...port,stage:'outpost'},(x,z)=>terrainSurfaceSample(heights,x,z,region));
  assert.ok(small,'an outpost has its ways');
  assert.ok(paved({streets:small})<.6,'an outpost has no cobbles');
  // A port's anchor alone has no waterfront until its board lays one, and so no ways.
  const {region:shore,heights:ground}=headland();
  const anchor=placeCoastalPort({...shore,year:1530},ground);
  assert.deepEqual(anchor.waterfront,[]);
  assert.equal(layTownStreets(anchor,(x,z)=>terrainSurfaceSample(ground,x,z,shore)),null);
});

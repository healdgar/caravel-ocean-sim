import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createDolphinEncounter,dolphinBreath,DOLPHIN_LIMIT,DOLPHIN_ENCOUNTER_SECONDS,DOLPHIN_SPLASH_LIMIT} from '../js/dolphin-state.js';
import {createDolphinMesh} from '../js/dolphin-mesh.js';
const vessel=()=>({x:0,z:0,length:20,beam:6,heading:0,surgeVelocity:2});
function seeded(){let n=37241;return ()=>{n=(Math.imul(n,1664525)+1013904223)>>>0;return n/4294967296;};}

test('dolphins appear as bounded rare encounters, never a continuous ambient particle field',()=>{
  const state=createDolphinEncounter(seeded()),boat=vessel();let sightings=0,was=false;
  assert.ok(state.nextAt>=420,'natural visits use the rare interval from startup; previews are explicit');
  for(let i=0;i<36000;i++){
    boat.z-=.2;state.step(.1,boat);
    if(state.active&&!was)sightings++;was=state.active;
    assert.ok(state.count<=DOLPHIN_LIMIT);
  }
  assert.ok(sightings>=1&&sightings<=6,`one simulated hour: ${sightings} encounters`);
  const storm=createDolphinEncounter(()=>.5);
  for(let i=0;i<18000;i++)storm.step(.1,boat,{windSpeed:25,rain:1});
  assert.equal(storm.active,false,'natural sightings are suppressed in poor conditions');
});

test('debug sightings use safe water, reject duplicate pods, and end without relocation artifacts',()=>{
  const state=createDolphinEncounter(()=>.4),boat=vessel();
  assert.equal(state.trigger(boat,{terrain:{height:()=>-2}}),false);
  assert.equal(state.active,false);
  assert.equal(state.trigger(boat,{terrain:{height:()=>20}}),false);
  assert.equal(state.trigger(boat),true);assert.ok(state.count>=5&&state.count<=7);
  assert.match(state.event.text,/Dolphins off the port bow/);
  assert.equal(state.trigger(boat),false);
  for(const a of state.animals.slice(0,state.count))assert.ok(Math.hypot(a.x-boat.x,a.z-boat.z)>boat.length*.65);
  for(let i=0;i<1100;i++){boat.z-=.2;state.step(.1,boat);}
  assert.equal(state.active,false);assert.ok(state.nextAt>state.time+400);
  assert.equal(state.trigger(boat),true);boat.x+=1000;state.step(.1,boat);assert.equal(state.active,false,'teleports clear the encounter');
});

test('pod motion and brief water entries stay finite, separated from hulls and capped at all frame rates',()=>{
  for(const hz of [10,30,60]){
    const boat=vessel(),state=createDolphinEncounter(seeded());state.trigger(boat);
    const previous=state.animals.map(a=>[a.x,a.z]);let sawSurface=false,sawSubmerged=false,sawSplash=false;
    for(let frame=0;frame<hz*DOLPHIN_ENCOUNTER_SECONDS;frame++){
      boat.z-=2/hz;state.step(1/hz,boat);
      for(const [i,a]of state.animals.slice(0,state.count).entries()){
        assert.ok([a.x,a.z,a.heading,a.pitch,a.depth].every(Number.isFinite));
        assert.ok(Math.hypot(a.x-previous[i][0],a.z-previous[i][1])<=8.51/hz);
        assert.ok(Math.hypot(a.x-boat.x,a.z-boat.z)>boat.beam,'dolphins stay outside the vessel');
        assert.ok(Math.abs(a.pitch)<=.65);previous[i]=[a.x,a.z];
        sawSurface ||=a.depth>0;sawSubmerged ||=a.depth<-.8;
      }
      assert.equal(state.splashes.length,DOLPHIN_SPLASH_LIMIT);
      sawSplash ||=state.splashes.some(s=>s.age<.1&&s.strength>0);
    }
    assert.ok(sawSurface&&sawSubmerged&&sawSplash);
  }
  const s=createDolphinEncounter(()=>.5);s.step(100,vessel());assert.ok(s.time<=.1,'background pauses do not advance encounters');
});

test('breathing arcs have rising and falling pitch and geometry has dolphin scale and finite normals',()=>{
  const rising=dolphinBreath(2.7,0),falling=dolphinBreath(4.2,0);
  assert.ok(rising.pitch>0&&falling.pitch<0);
  const mesh=createDolphinMesh();assert.ok(mesh.indices.length/3<4000&&mesh.indices.length/3>1000);
  assert.ok(mesh.vertices.every(Number.isFinite));
  let maxX=0,minZ=0,maxZ=0,maxY=0;
  for(let i=0;i<mesh.vertices.length;i+=9){
    maxX=Math.max(maxX,Math.abs(mesh.vertices[i]));minZ=Math.min(minZ,mesh.vertices[i+2]);maxZ=Math.max(maxZ,mesh.vertices[i+2]);maxY=Math.max(maxY,mesh.vertices[i+1]);
    assert.ok(Math.abs(Math.hypot(...mesh.vertices.slice(i+3,i+6))-1)<1e-5);
  }
  assert.ok(maxX>.75&&maxX<1);assert.ok(maxZ-minZ>2.9&&maxZ-minZ<3.2);assert.ok(maxY>.8&&maxY<.9);
  assert.ok(mesh.indices.every(i=>i<mesh.vertices.length/9));
});

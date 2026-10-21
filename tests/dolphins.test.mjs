import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createDolphinEncounter,dolphinBreath,dolphinSurfaceContact,DOLPHIN_LIMIT,DOLPHIN_ENCOUNTER_SECONDS,DOLPHIN_SPLASH_LIMIT,DOLPHIN_SPLASH_SECONDS} from '../js/dolphin-state.js';
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

test('surface events follow the pitched trunk, with no underwater, airborne, idle or zero-delta emitter',()=>{
  assert.equal(dolphinSurfaceContact(-.65,0,1).touching,false,'an exposed dorsal fin above a submerged trunk is not a body-water contact');
  assert.equal(dolphinSurfaceContact(1,0,1).touching,false,'a fully airborne dolphin leaves no trail');
  assert.equal(dolphinSurfaceContact(-.15,0,1).touching,true);
  assert.equal(dolphinSurfaceContact(-.55,.6,1).touching,true,'pitch can bring the trunk to the surface before the root');
  const state=createDolphinEncounter(()=>0),boat=vessel();state.step(.1,boat);
  assert.ok(state.splashes.every(s=>s.strength===0),'no encounter means no emission');
  state.trigger(boat);
  for(let i=0;i<20;i++)state.step(0,boat);
  assert.ok(state.splashes.every(s=>s.strength===0),'render-only updates cannot generate contacts');
  for(let i=0;i<10;i++)state.step(.1,boat);
  assert.ok(state.splashes.every(s=>s.strength===0),'a submerged swimming pod cannot emit arbitrary surface spray');
  let lastId=0;const kinds=new Set(),entryStrength=[],emergeStrength=[];
  for(let frame=0;frame<60*90;frame++){
    boat.z-=2/60;state.step(1/60,boat);
    const fresh=state.splashes.filter(s=>s.id>lastId&&s.strength>0);lastId=Math.max(lastId,...fresh.map(s=>s.id));
    for(const s of fresh){
      kinds.add(s.kind);assert.ok([s.x,s.z,s.age,s.strength,s.heading,s.seed,s.speed,s.scale].every(Number.isFinite));
      assert.ok(s.age>=-1e-7&&s.age<=.1);assert.ok(s.speed>0&&s.scale>0);
      const a=state.animals[s.animal],at=state.age-s.age,cycle=Math.floor(at/a.period+a.phase),breach=(cycle+s.animal)%5===0&&s.animal%3===0;
      const pose=dolphinBreath(at,a.phase,a.period,breach),contact=dolphinSurfaceContact(pose.depth,pose.pitch,a.scale);
      assert.equal(contact.touching,true,`${s.kind} occurs at an actual body-water contact`);
      if(s.kind==='entry')entryStrength.push(s.strength);
      if(s.kind==='emerge')emergeStrength.push(s.strength);
    }
    assert.ok(state.splashes.filter(s=>s.strength>0&&s.age<DOLPHIN_SPLASH_SECONDS).length<=DOLPHIN_SPLASH_LIMIT);
  }
  assert.deepEqual([...kinds].sort(),['emerge','entry','trail']);
  assert.ok(Math.max(...entryStrength)>Math.max(...emergeStrength),'breach landings drive the stronger splash');
  state.clear();assert.ok(state.splashes.every(s=>s.strength===0),'ending an encounter removes its effects');
  state.trigger(boat);for(let i=0;i<50;i++)state.step(.1,boat);
  boat.x+=1000;state.step(.1,boat);assert.ok(state.splashes.every(s=>s.strength===0),'teleports cannot leave water effects behind');
});

test('surface emission uses fixed contact times and bounded trail cadence across frame rates',()=>{
  const snapshots=[];
  for(const hz of [10,30,60,120]){
    const state=createDolphinEncounter(seeded()),boat=vessel();state.trigger(boat);
    let lastId=0;const events=[];
    for(let frame=0;frame<hz*60;frame++){
      boat.z-=2/hz;state.step(1/hz,boat);
      const fresh=state.splashes.filter(s=>s.id>lastId&&s.strength>0).sort((a,b)=>a.id-b.id);lastId=Math.max(lastId,...fresh.map(s=>s.id));
      for(const s of fresh)events.push({animal:s.animal,kind:s.kind,at:Math.round((state.age-s.age)*1e6)});
    }
    // Event order between animals within a frame is immaterial; event times and counts are fixed.
    snapshots.push(events.sort((a,b)=>a.at-b.at||a.animal-b.animal||a.kind.localeCompare(b.kind)));
    for(let animal=0;animal<state.count;animal++){
      const trails=events.filter(e=>e.animal===animal&&e.kind==='trail');
      for(let i=1;i<trails.length;i++)assert.ok(trails[i].at-trails[i-1].at>=249999,'trail stamps never exceed four per second');
    }
  }
  for(const snapshot of snapshots.slice(1))assert.deepEqual(snapshot,snapshots[0]);
  assert.equal(DOLPHIN_SPLASH_LIMIT,64);assert.equal(DOLPHIN_SPLASH_SECONDS,4.2);
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

test('actual dolphin flukes sweep aft, form a trailing notch and join the tail stock',()=>{
  const {vertices,indices}=createDolphinMesh(),point=i=>Array.from(vertices.slice(i*9,i*9+3));
  const fluke=i=>Math.abs(vertices[i*9+6]-.115)<1e-6&&Math.abs(vertices[i*9+7]-.15)<1e-6&&Math.abs(vertices[i*9+8]-.17)<1e-6;
  const points=[];for(let i=0;i<vertices.length/9;i++)if(fluke(i))points.push(point(i));
  const roots=points.filter(p=>Math.abs(p[0])<1e-6),leadingRoot=Math.min(...roots.map(p=>p[2])),notch=Math.max(...roots.map(p=>p[2]));
  const span=Math.max(...points.map(p=>p[0]))-Math.min(...points.map(p=>p[0])),nose=Math.min(...Array.from({length:vertices.length/9},(_,i)=>vertices[i*9+2]));
  const bodyLength=Math.max(...points.map(p=>p[2]))-nose;
  // Independent anatomical measurements: T. truncatus 61 cm span / 259 cm
  // body length, 35-degree sweep; doi:10.1371/journal.pone.0255464, Table 4.
  assert.ok(span/bodyLength>.23&&span/bodyLength<.28,'flukes span roughly one quarter of body length, not half');
  for(const side of [-1,1]){
    const tip=points.filter(p=>p[0]*side>.37),aftLobe=points.filter(p=>p[0]*side>.15&&p[0]*side<.34);
    assert.ok(tip.length&&Math.min(...tip.map(p=>p[2]))>leadingRoot+.24,'head is -Z; both outer tips must sweep toward +Z');
    const sweep=Math.atan((Math.min(...tip.map(p=>p[2]))-leadingRoot)/(span/2))*180/Math.PI;
    assert.ok(sweep>32&&sweep<40,'fluke tip sweep follows the measured bottlenose form');
    assert.ok(Math.max(...aftLobe.map(p=>p[2]))>notch+.12,'central trailing notch opens between aft-projecting lobes');
    assert.ok(points.some(p=>p[0]*side>.07&&p[0]*side<.085&&p[2]<1.21),'leading root remains ahead of the outer foil');
  }
  const key=p=>p.map(v=>v.toFixed(5)).join(','),port=new Set(points.filter(p=>p[0]<=0).map(p=>key([-p[0],p[1],p[2]])));
  for(const p of points.filter(p=>p[0]>=0))assert.ok(port.has(key(p)),'flukes retain symmetric attachment and sweep');
  // Test the real tail-stock skin at a common embedded root station. Both
  // fluke leading edges sit between its actual upper and lower ring vertices.
  const tailStock=[];for(let i=0;i<vertices.length/9;i++){const p=point(i);if(!fluke(i)&&p[2]>1.17&&p[2]<1.25)tailStock.push(p);}
  assert.ok(tailStock.length>20);
  const bottom=Math.min(...tailStock.map(p=>p[1])),top=Math.max(...tailStock.map(p=>p[1]));
  assert.ok(roots.filter(p=>p[2]===leadingRoot).every(p=>p[1]>bottom&&p[1]<top),'fluke root is embedded in the tail stock');
  for(let i=0;i<indices.length;i+=3){
    const ids=Array.from(indices.slice(i,i+3));if(!ids.every(fluke))continue;
    const p=ids.map(point),centreY=p.reduce((n,q)=>n+q[1]/3,0);
    if(p.every(q=>q[1]>-.1))for(const id of ids)assert.ok(vertices[id*9+4]>0,'upper fluke skin normals point outward on both sides');
    if(p.every(q=>q[1]<-.1))for(const id of ids)assert.ok(vertices[id*9+4]<0,'lower fluke skin normals point outward on both sides');
    assert.ok(Number.isFinite(centreY));
  }
  const tailCap=[];for(let i=0;i<indices.length;i+=3){const ids=Array.from(indices.slice(i,i+3));if(ids.every(id=>!fluke(id)&&Math.abs(vertices[id*9+2]-1.4)<1e-6&&vertices[id*9+5]>.99))tailCap.push(ids);}
  assert.equal(tailCap.length,24,'tail stock is closed where the flukes attach');
});

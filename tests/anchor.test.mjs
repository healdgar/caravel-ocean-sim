import assert from 'node:assert/strict';
import { test } from 'node:test';
import { readFile } from 'node:fs/promises';
import { ANCHOR_LIMITS, FATHOM_METRES, metresToFathoms, anchorFairlead, anchorEligibility, anchorLandVisible,
  anchorTetherForce, createAnchorState, anchorRodePoints } from '../js/anchor-state.js';
import { boatHydrodynamics, stepBoatSurge, stepBoatSteering } from '../js/boat.js';
import { decodeIsland, terrainSample, LANDFALL_VIEWS } from '../js/terrain-model.js';
import { createCaravelMesh } from '../js/caravel.js';
import { anchorCathead, HULL_VERTICAL_SCALE } from '../js/hull.js';
import { createAnchorRenderer } from '../js/anchor.js';

const anchorBoat=()=>({x:-2300,z:-3700,length:20,beam:6,heading:0,heave:0,pitch:0,roll:0,eye:5,
  propulsion:'sail',sailFore:0,sailMain:0,sailMizzen:0,speed:0,surgeVelocity:0,leewayVelocity:0,
  rudder:0,rudderTarget:0,yawRate:0,target:{heave:0},hydrodynamics:boatHydrodynamics(20,6)});
const anchorTerrain={height:(x,z)=>x>-1700?Math.max(5,300-Math.abs(z+5000)*.01):-8};
const anchorEnv={terrain:anchorTerrain,settings:{haze:3,rain:0,clouds:.3,cloudBase:1.5}};
const stepAnchor=(state,boat,seconds,dt=1/60)=>{
  const events=[];
  for(let i=0;i<Math.ceil(seconds/dt);i++){state.step(dt,boat,anchorEnv);events.push(...state.events);}
  return events;
};

test('anchoring requires slow speed, sampled coastal water, safe depth and visible land',()=>{
  const boat=anchorBoat();assert.equal(anchorEligibility(boat,anchorEnv).allowed,true);
  boat.surgeVelocity=2;assert.match(anchorEligibility(boat,anchorEnv).reason,/Slow below/);
  boat.surgeVelocity=0;boat.z=0;assert.match(anchorEligibility(boat,anchorEnv).reason,/sounding/);
  boat.z=-3700;assert.match(anchorEligibility(boat,{...anchorEnv,terrain:{height:()=>-90}}).reason,/Too deep/);
  assert.match(anchorEligibility(boat,{...anchorEnv,terrain:{height:()=>-2}}).reason,/Too shallow/);
  assert.equal(anchorLandVisible(boat,{terrain:{height:()=>-8},settings:{}}),false);
  const fogBoat={...boat,x:-3500};
  assert.equal(anchorLandVisible(fogBoat,anchorEnv),true);
  assert.equal(anchorLandVisible(fogBoat,{...anchorEnv,settings:{...anchorEnv.settings,haze:15,rain:1}}),false);
  assert.equal(anchorEligibility(boat,{}).depth,null);
  assert.equal(metresToFathoms(FATHOM_METRES*7),7);
});

test('actual Near coast start has a simulated sounding while open-ocean fallback does not',async()=>{
  const file=await readFile(new URL('../assets/world/saba/height.bin',import.meta.url));
  const heights=decodeIsland(file.buffer.slice(file.byteOffset,file.byteOffset+file.byteLength));
  const boat={...anchorBoat(),...LANDFALL_VIEWS.coast},terrain={height:(x,z)=>terrainSample(heights,x,z)};
  const available=anchorEligibility(boat,{terrain,settings:{haze:3}});
  assert.equal(available.allowed,true,available.reason);assert.equal(available.source,'Simulated coastal sounding');
  assert.ok(available.depth>3&&available.depth<=ANCHOR_LIMITS.maxDepth);
  boat.x=0;boat.z=0;assert.equal(anchorEligibility(boat,{terrain}).allowed,false);
});

test('drop falls continuously, splashes once, sounds bottom, pays scope and preserves world anchor position',()=>{
  const boat=anchorBoat(),state=createAnchorState(boat),start={...state.position};
  assert.equal(state.drop(boat,anchorEnv),true);assert.equal(state.phase,'lowering');
  assert.equal(state.drop(boat,anchorEnv),false);
  state.step(1/60,boat,anchorEnv);assert.ok(Math.abs(state.position.y-start.y)<.01,'no bottom teleport');
  const events=[...state.events,...stepAnchor(state,boat,25)];
  assert.equal(state.phase,'anchored');assert.equal(state.embedded,true);
  assert.equal(events.filter(e=>e.type==='splash').length,1);
  assert.equal(events.filter(e=>e.type==='set').length,1);
  assert.ok(Math.abs(state.depthFathoms-8/FATHOM_METRES)<1e-12);
  assert.ok(state.rode>state.depth*4&&state.rode<=ANCHOR_LIMITS.maxRode);
  const position={...state.position};boat.x+=5;state.step(1/60,boat,anchorEnv);
  assert.deepEqual(state.position,position,'anchor stays on seabed while hull moves within swing circle');
});

test('anchor entry follows the current wave level rather than the drop-time water level',()=>{
  const boat=anchorBoat(),state=createAnchorState(boat);let surface=0;
  const environment={...anchorEnv,waterHeight:()=>surface};
  assert.equal(state.drop(boat,environment),true);surface=.75;
  const entries=[];
  for(let i=0;i<600;i++){state.step(1/60,boat,environment);entries.push(...state.events.filter(e=>e.type==='splash'));}
  assert.equal(entries.length,1);assert.equal(entries[0].y,surface);
  assert.equal(state.splash.y,surface);
});

test('slack rope exerts no push; stretched rope pulls bow toward anchor and can yaw hull',()=>{
  const boat=anchorBoat(),p=anchorFairlead(boat);
  const state={phase:'anchored',embedded:true,position:{x:p.x,y:-7.78,z:p.z},rode:50};
  assert.deepEqual(anchorTetherForce(state,boat),{x:0,z:0,yaw:0,tension:0});
  state.position.x+=50;
  const force=anchorTetherForce(state,boat);assert.ok(force.x>0);assert.ok(Math.abs(force.z)<1e-10);
  assert.ok(force.yaw>0,'port bow fairlead pulled starboard turns bow starboard');
  assert.ok(force.tension>0&&force.tension<=force.holding);
  state.position.x-=100;assert.ok(anchorTetherForce(state,boat).x<0);
});

test('weighing retrieves continuously and stops exerting force after breakout/housing',()=>{
  const boat=anchorBoat(),state=createAnchorState(boat);state.drop(boat,anchorEnv);stepAnchor(state,boat,25);
  assert.equal(state.weigh(),true);assert.equal(state.weigh(),false);
  let previous={...state.position};
  for(let i=0;i<9000&&state.active;i++){
    state.step(1/60,boat,anchorEnv);
    assert.ok(Math.hypot(state.position.x-previous.x,state.position.y-previous.y,state.position.z-previous.z)<.02,'winch never teleports anchor');
    previous={...state.position};
  }
  assert.equal(state.phase,'stowed');assert.equal(state.embedded,false);
  assert.equal(state.force.tension,0);assert.equal(state.reelRate,0);
});

test('rope endpoints meet fairlead/anchor eye, stay finite and above authored bottom',()=>{
  const boat=anchorBoat(),state=createAnchorState(boat);state.drop(boat,anchorEnv);stepAnchor(state,boat,25);
  boat.z+=15;const points=anchorRodePoints(state,boat);
  assert.equal(points.length,49);assert.deepEqual(points[0],anchorFairlead(boat));
  assert.ok(Math.abs(points.at(-1).y-(state.position.y+.65))<1e-12);
  for(const p of points){assert.ok(Object.values(p).every(Number.isFinite));assert.ok(p.y>=state.bed);}
});

test('optional anchor force uses hull inertia, lateral drag and yaw inertia without propulsion',()=>{
  const boat=anchorBoat(),mass=boat.hydrodynamics.mass+boat.hydrodynamics.addedMass;
  boat.externalForce={x:1000,z:2000,yaw:10000};
  const distance=stepBoatSurge(boat,0,1/60,0,0);stepBoatSteering(boat,0,1/60);
  assert.ok(distance<0&&boat.surgeVelocity<0,'force aft creates sternway through inertia');
  assert.ok(boat.leewayVelocity>0);assert.ok(boat.yawRate>0);
  assert.ok(Math.abs(boat.surgeVelocity)<=2000/mass/60,'no velocity impulse beyond applied force');
  const before=boat.surgeVelocity;boat.externalForce={x:0,z:0,yaw:0};stepBoatSurge(boat,0,1/60,0,0);
  assert.ok(boat.surgeVelocity<0&&Math.abs(boat.surgeVelocity)<Math.abs(before),'momentum persists when released');
});

test('sustained wind load lets hull swing, then balances on the rode without fixing its position',()=>{
  const boat=anchorBoat(),state=createAnchorState(boat);state.drop(boat,anchorEnv);stepAnchor(state,boat,25);
  const start={x:boat.x,z:boat.z},anchor={...state.position};let maximum=0;
  for(let i=0;i<180*30;i++){
    const dt=1/30,force=state.step(dt,boat,anchorEnv);boat.externalForce={...force,x:force.x+4000};
    const distance=stepBoatSurge(boat,0,dt,0,0),heading=boat.heading*Math.PI/180;
    stepBoatSteering(boat,0,dt);
    boat.x+=Math.sin(heading)*distance+Math.cos(heading)*boat.leewayDistance;
    boat.z-=Math.cos(heading)*distance-Math.sin(heading)*boat.leewayDistance;
    maximum=Math.max(maximum,Math.hypot(boat.x-start.x,boat.z-start.z));
  }
  assert.ok(maximum>20&&maximum<65,'hull swings within the paid scope');
  assert.ok(Math.hypot(state.position.x-anchor.x,state.position.z-anchor.z)<.1,'a brief setting shock cannot cause sustained anchor drag');
  assert.ok(Math.abs(state.force.x+4000)<100,'rode balances the sustained load');
  assert.ok(Math.hypot(boat.surgeVelocity,boat.leewayVelocity)<.15);
  assert.ok(Math.abs(boat.heading)>10,'bow responds to fairlead torque');
});

test('drop and retrieval stay stable at 10, 30 and 120 FPS; reset releases the rode load',()=>{
  const results=[];
  for(const fps of [10,30,120]){
    const boat=anchorBoat(),state=createAnchorState(boat);assert.equal(state.drop(boat,anchorEnv),true);
    const events=stepAnchor(state,boat,25,1/fps);
    assert.equal(state.phase,'anchored');assert.equal(events.filter(e=>e.type==='splash').length,1);
    results.push({y:state.position.y,rode:state.rode,depth:state.depthFathoms});
    state.weigh();stepAnchor(state,boat,100,1/fps);assert.equal(state.phase,'stowed');
    state.drop(boat,anchorEnv);stepAnchor(state,boat,25,1/fps);boat.x+=100;
    state.step(1/fps,boat,anchorEnv);assert.ok(state.force.tension>0);
    state.reset(boat);assert.equal(state.active,false);assert.equal(state.force.tension,0);
    assert.equal(state.step(1/fps,boat,anchorEnv).x,0);
  }
  for(const result of results)assert.deepEqual(result,results[0]);
});

test('excess load drags the finite-holding anchor rather than fixing a vessel in place',()=>{
  const boat=anchorBoat(),state=createAnchorState(boat);state.drop(boat,anchorEnv);stepAnchor(state,boat,25);
  const start={...state.position};boat.x+=100;state.step(.1,boat,anchorEnv);
  assert.equal(state.dragging,true);assert.ok(state.position.x>start.x);
  assert.ok(state.force.tension<=ANCHOR_LIMITS.anchorMass*9.81*8);
  assert.equal(boat.x,-2200,'anchor solver applies force without overwriting hull position');
});

test('working anchor fairlead meets the actual port cathead mesh at every hull attitude',()=>{
  const parts=new Map();createCaravelMesh({parts});
  assert.ok(parts.get('anchor:spare')?.length>0,'secured starboard spare remains aboard');
  for(const side of [-1,1]){
    const mesh=parts.get(`anchor:cathead:${side}`),attachment=anchorCathead(side);
    assert.ok(mesh?.length>0);
    for(const point of [attachment.root,attachment.tip]){
      let nearest=Infinity;
      for(let i=0;i<mesh.length;i+=9)nearest=Math.min(nearest,Math.hypot(mesh[i]-point[0],mesh[i+1]-point[1],mesh[i+2]-point[2]));
      assert.ok(nearest<1e-6,'timber endpoint is an actual mesh vertex');
    }
  }
  const boat=anchorBoat(),local=anchorCathead(-1).fairlead;
  const expected={x:boat.x+local[0]*boat.beam/3.6,y:local[1]*HULL_VERTICAL_SCALE,z:boat.z+local[2]*boat.length/12};
  assert.deepEqual(anchorFairlead(boat),expected);
  for(const [heading,pitch,roll] of [[0,.2,-.3],[90,-.2,.1],[217,.3,.2]]){
    Object.assign(boat,{heading,pitch,roll});const state=createAnchorState(boat),rope=anchorRodePoints(state,boat);
    assert.deepEqual(rope[0],anchorFairlead(boat));assert.deepEqual(rope.at(-1),rope[0],'housed anchor eye joins the fairlead');
  }
});

test('deployed anchor retains its world orientation while the moored hull yaws',async()=>{
  const previous=globalThis.GPUBufferUsage;globalThis.GPUBufferUsage={VERTEX:1,COPY_DST:2,UNIFORM:4,STORAGE:8};
  let commands;
  const device={createBuffer:({label})=>({label,destroy(){}}),
    createRenderPipelineAsync:async()=>({getBindGroupLayout(){}}),createBindGroup:()=>({}),
    queue:{writeBuffer(buffer,offset,data,start=0,count=data.length){
      if(buffer.label==='anchor compact physical state')commands=data.slice(start,start+count);
    }}};
  let renderer;
  try{
    renderer=await createAnchorRenderer({device,shader:async()=>({}),shadows:{bind(){}}});
    const boat=anchorBoat(),state=createAnchorState(boat);boat.heading=27;
    state.drop(boat,anchorEnv);stepAnchor(state,boat,25);renderer.update(state,boat);
    // The GPU owns triangle expansion. Scale, heading and anchor origin must
    // remain fixed while fairlead/catenary commands follow the yawing hull.
    // anchor-expansion-gpu.test.mjs also checks the actual expanded triangles.
    const ironCommands=commands.slice(0,7),rodeCommands=commands.slice(8),position={...state.position};
    boat.heading=154;state.step(1/60,boat,anchorEnv);renderer.update(state,boat);
    assert.equal(state.worldHeading,27);assert.deepEqual(state.position,position);
    assert.deepEqual(commands.slice(0,7),ironCommands,'GPU anchor commands preserve the seabed orientation; splash age may advance');
    assert.notDeepEqual(commands.slice(8),rodeCommands,'the physical fairlead and rode continue to follow the hull');
    state.weigh();state.step(1/60,boat,anchorEnv);assert.equal(state.worldHeading,27);
  }finally{renderer?.destroy();globalThis.GPUBufferUsage=previous;}
});

import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {ANCHOR_LIMITS,VICTORY_ANCHOR_LIMITS,anchorEquipment,anchorEyeOffset,anchorFairlead,
  anchorEligibility,anchorTetherForce,anchorRodePoints,createAnchorState} from '../js/anchor-state.js';
import {boatHydrodynamics,boatRotate} from '../js/boat.js';
import {VICTORY_DESIGN,victoryHullHalfWidth} from '../js/models/victory.js';
import {createAnchorRenderer,createAnchorGPUTemplate} from '../js/anchor.js';
import {decodeIsland,terrainSample,LANDFALL_VIEWS,safeLandfallStart} from '../js/terrain-model.js';

const boat=()=>({modelId:'victory',...VICTORY_DESIGN.runtime,x:-2300,z:-3700,heave:0,pitch:0,roll:0,
  heading:0,eye:10,surgeVelocity:0,leewayVelocity:0,yawRate:0,speed:0,
  propulsion:'sail',sailFore:0,sailMain:0,sailMizzen:0,
  hydrodynamics:boatHydrodynamics(VICTORY_DESIGN.runtime.length,VICTORY_DESIGN.runtime.beam,60,0,'victory')});
const environment={terrain:{height:(x,z)=>x>-1700?120:-16},settings:{haze:3,rain:0,clouds:.3,cloudBase:1.5}};
const distance=(a,b)=>Math.hypot(a.x-b.x,a.y-b.y,a.z-b.z);
test('Victory can anchor in the actual graded coastal demo with a terrain-derived sounding',async()=>{
  const file=await readFile(new URL('../assets/world/saba/height.bin',import.meta.url));
  const heights=decodeIsland(file.buffer.slice(file.byteOffset,file.byteOffset+file.byteLength));
  const b={...boat(),x:LANDFALL_VIEWS.coast.x,z:LANDFALL_VIEWS.coast.z},start=safeLandfallStart(heights,b,b);
  Object.assign(b,{x:start.x,z:start.z});
  const terrain={height:(x,z)=>terrainSample(heights,x,z)};
  const available=anchorEligibility(b,{terrain,settings:{haze:3}});
  assert.equal(available.allowed,true,available.reason);
  assert.equal(available.depth,-terrain.height(available.point.x,available.point.z));
  assert.ok(available.depth>b.hydrodynamics.draft+1&&available.depth<=VICTORY_ANCHOR_LIMITS.maxDepth);
  const state=createAnchorState(b);assert.equal(state.drop(b,{terrain,settings:{haze:3}}),true);
  assert.equal(state.depth,null,'the anchor must reach bottom before reporting its sounding');
  for(let i=0;i<180*30&&state.phase!=='anchored';i++)state.step(1/30,b,{terrain,settings:{haze:3}});
  assert.equal(state.phase,'anchored');
  assert.equal(state.depth,available.depth,'soundings use the actual authored seabed, not the former flat8m assumption');
});
test('Victory selects authored first-rate equipment with finite holding strength',()=>{
  const b=boat(),limits=anchorEquipment(b);assert.equal(limits,VICTORY_ANCHOR_LIMITS);
  assert.equal(anchorEquipment({modelId:'nina'}),ANCHOR_LIMITS);
  assert.equal(limits.anchorMass,4000);assert.ok(limits.renderScale>3&&limits.rodeRadius>.07);
  const p=anchorFairlead(b),state={phase:'anchored',embedded:true,position:{x:p.x+200,y:-15,z:p.z},rode:80};
  const force=anchorTetherForce(state,b);
  assert.ok(force.holding>300000&&force.holding<400000);
  assert.ok(force.demand>force.holding&&force.tension===force.holding,'heavy equipment still has finite holding power');
  assert.ok(force.x>0&&Number.isFinite(force.yaw));
});
test('Victory drops and retrieves its larger anchor continuously with matching eye and rode geometry',()=>{
  const b=boat(),state=createAnchorState(b),p=anchorFairlead(b),offset=anchorEyeOffset(b);
  assert.equal(anchorEligibility(b,environment).allowed,true);
  assert.ok(Math.abs(state.position.y+offset-p.y)<1e-9,'housed anchor eye reaches the cathead');
  assert.equal(state.drop(b,environment),true);const events=[];
  let previous={...state.position};
  for(let i=0;i<70*60;i++){
    state.step(1/60,b,environment);events.push(...state.events);
    if(i===0)assert.ok(distance(state.position,previous)<.01,'release starts with gravity, not a position jump');
    assert.ok(distance(state.position,previous)<.2,'continuous free fall through the initial slack');previous={...state.position};
  }
  assert.equal(state.phase,'anchored');assert.equal(state.depth,16);assert.equal(events.filter(e=>e.type==='splash').length,1);
  assert.ok(state.rode<=anchorEquipment(b).maxRode);
  const rope=anchorRodePoints(state,b);assert.deepEqual(rope[0],anchorFairlead(b));
  assert.ok(Math.abs(rope.at(-1).y-state.position.y-offset)<1e-9);
  assert.equal(state.weigh(),true);
  for(let i=0;i<450*30&&state.active;i++){
    previous={...state.position};state.step(1/30,b,environment);assert.ok(distance(state.position,previous)<.03);
  }
  assert.equal(state.phase,'stowed');assert.equal(state.force.tension,0);
  for(const [heading,pitch,roll]of[[0,.2,-.3],[90,-.2,.1],[217,.3,.2]]){
    Object.assign(b,{heading,pitch,roll});state.reset(b);const eye=[0,0,0];boatRotate(eye,0,offset,0,heading*Math.PI/180,pitch,roll);
    assert.ok(distance({x:state.position.x+eye[0],y:state.position.y+eye[1],z:state.position.z+eye[2]},anchorFairlead(b))<1e-9);
  }
});
test('rendered Victory shank, stock and iron thickness scale together independently of the rode',async()=>{
  const before=globalThis.GPUBufferUsage;globalThis.GPUBufferUsage={VERTEX:1,COPY_DST:2,UNIFORM:4,STORAGE:8};let commands,renderer;
  const device={createBuffer:({label})=>({label,destroy(){}}),createRenderPipelineAsync:async()=>({getBindGroupLayout(){}}),createBindGroup:()=>({}),
    queue:{writeBuffer(buffer,offset,data,start=0,count=data.length){if(buffer.label==='anchor compact physical state')commands=data.slice(start,start+count);}}};
  try{
    renderer=await createAnchorRenderer({device,shader:async()=>({}),shadows:{bind(){}}});
    const state={phase:'anchored',worldHeading:0,position:{x:0,y:0,z:0},rode:70,bed:-16,time:0,splash:null};
    const b=boat(),template=createAnchorGPUTemplate();renderer.update(state,{...b,modelId:'nina',length:20,beam:6});const small=commands.slice();
    renderer.update(state,b);const large=commands.slice(),scale=anchorEquipment(b).renderScale;
    assert.equal(small[0],1);assert.equal(large[0],Math.fround(scale));assert.equal(large[1],Math.fround(anchorEquipment(b).rodeRadius));
    for(let i=0;i<72*8;i+=8)for(let axis=0;axis<3;axis++)assert.ok(Math.abs((template.vertices[i+axis]*large[0]+large[4+axis])-(template.vertices[i+axis]*small[0]+small[4+axis])*scale)<2e-6);
    assert.ok(commands.every(Number.isFinite));
    renderer.update(createAnchorState(b),b);
    assert.equal(commands[3],1,'housed anchor uses the hull-local GPU actor pose');
    // Preserve the actual iron/stock bow-clearance gate against the immutable
    // geometry and physical commands. Native GPU expansion is independently
    // checked against this same geometry in anchor-expansion-gpu.test.mjs.
    for(let i=0;i<template.ironCount*8;i+=8){
      const p=[0,1,2].map(axis=>template.vertices[i+axis]*commands[0]+commands[4+axis]);
      const width=victoryHullHalfWidth(p[2]/(b.length/12),p[1]/VICTORY_DESIGN.frame.verticalScale)*b.beam/3.6;
      if(width>0)assert.ok(Math.abs(p[0])-width>.02,'housed iron and timber stock clear the actual bow skin');
    }
  }finally{renderer?.destroy();globalThis.GPUBufferUsage=before;}
});

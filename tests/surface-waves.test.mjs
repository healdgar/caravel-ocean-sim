// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {createSurfaceWaves,surfaceWaveEmission,SURFACE_WAVE_LIMITS} from '../js/surface-waves.js';
import {SURFACE_WAVE_SPEED} from '../js/wgsl/surface-waves.js';
import {createDolphinEncounter} from '../js/dolphin-state.js';
import {createMarineLifeState} from '../js/marine-life-state.js';
import {createAnchorState} from '../js/anchor-state.js';

const contact=(id=1,extra={})=>({source:'test',id,x:0,z:0,radiusMetres:1,closingSpeed:4,kind:'entry',velocity:[2,-4,0],...extra});
async function mockSurface(t){
  const oldB=globalThis.GPUBufferUsage,oldT=globalThis.GPUTextureUsage;
  globalThis.GPUBufferUsage={UNIFORM:1,COPY_DST:2,STORAGE:4};globalThis.GPUTextureUsage={TEXTURE_BINDING:1,STORAGE_BINDING:2,COPY_SRC:4};
  t.after(()=>{if(oldB===undefined)delete globalThis.GPUBufferUsage;else globalThis.GPUBufferUsage=oldB;if(oldT===undefined)delete globalThis.GPUTextureUsage;else globalThis.GPUTextureUsage=oldT;});
  const writes=new Map(),dispatches=[];
  const device={createBuffer:d=>({...d,destroy(){}}),createTexture:d=>({...d,createView:o=>({descriptor:d,...o}),destroy(){}}),createBindGroup:d=>d,
    queue:{writeBuffer(buffer,offset,data,dataOffset=0,size=data.length-dataOffset){writes.set(buffer.label,Array.from(data.subarray(dataOffset,dataOffset+size)));}}};
  const field=await createSurfaceWaves({device,computePipe:async()=>({getBindGroupLayout:()=>({})})});
  const pass={setPipeline(){},setBindGroup(){},dispatchWorkgroups(...args){dispatches.push(args);}};
  return {field,writes,dispatches,pass};
}

test('surface impulses reject invalid inputs and derive bounded coupling from radius, mass and closing velocity',()=>{
  for(const edit of [{id:0},{source:''},{x:NaN},{radiusMetres:0},{closingSpeed:-1},{kind:'blow'},{massKg:0},{age:1},{velocity:[0,Infinity,0]}])assert.equal(surfaceWaveEmission(contact(1,edit)),null);
  const a=surfaceWaveEmission(contact(1,{massKg:12})),b=surfaceWaveEmission(contact(2,{massKg:24})),c=surfaceWaveEmission(contact(3,{massKg:12,closingSpeed:8}));
  assert.ok(a.kick>0&&Math.abs(b.kick-2*a.kick)<1e-12&&Math.abs(c.kick-2*a.kick)<1e-12,'uncapped normal momentum scales linearly');
  const emerge=surfaceWaveEmission(contact(4,{kind:'emerge'}));assert.ok(emerge.kick<0,'leaving water receives the opposite signed forcing');
  assert.equal(surfaceWaveEmission(contact(5,{closingSpeed:0,velocity:[0,0,0]})),null);
  const trail=surfaceWaveEmission(contact(6,{kind:'trail',closingSpeed:0}));assert.ok(trail.trail&&trail.kick>0,'moving surface bodies supply a weaker pressure source');
  assert.ok(surfaceWaveEmission(contact(7,{massKg:1e12,closingSpeed:1e6})).kick<=5);
});

test('surface field stays dormant, preserves dt0 queued contacts and injects each budget only in its first CFL-safe substep',async t=>{
  const {field,writes,dispatches,pass}=await mockSurface(t);
  field.update({x:0,z:0},.1);field.encode(pass);assert.equal(dispatches.length,0);assert.equal(writes.get('scene surface wave domains')[15],0);
  assert.equal(field.emit(contact()),true);assert.equal(field.emit(contact()),false);assert.equal(field.stats.duplicates,1);
  field.update({x:0,z:0},0);field.encode(pass);assert.equal(dispatches.length,0);assert.equal(field.stats.queued,1);
  field.update({x:0,z:0},.1);field.encode(pass);
  assert.equal(dispatches.length,2);assert.equal(field.stats.accepted,1);assert.equal(field.stats.active,true);
  const first=writes.get('scene wave substep 0'),second=writes.get('scene wave substep 1');
  assert.equal(first[14],1);assert.equal(second[14],0,'near and far share one physical source, without reinjection at each substep');
  assert.ok(SURFACE_WAVE_SPEED*first[12]/first[3]<=.45+1e-6,'the finest grid obeys the authored CFL bound');
  field.encode(pass);assert.equal(dispatches.length,2,'encoding twice cannot advance time or inject again');
});

test('surface queue prioritizes substantial entries, culls distant contacts and stops work after bounded quiet decay',async t=>{
  const {field,pass,dispatches}=await mockSurface(t);
  for(let i=1;i<=64;i++)assert.equal(field.emit(contact(i,{kind:'trail',closingSpeed:0})),true);
  assert.equal(field.emit(contact(65)),true);assert.equal(field.stats.queued,64);assert.equal(field.stats.dropped,1);
  field.update({x:0,z:0},.1);field.encode(pass);assert.equal(field.stats.accepted,64);
  const before=dispatches.length;
  for(let i=0;i<460;i++){field.update({x:0,z:0},.1);field.encode(pass);}
  assert.equal(field.stats.active,false);const settled=dispatches.length;assert.ok(settled>before);
  field.update({x:0,z:0},.1);field.encode(pass);assert.equal(dispatches.length,settled);
  assert.equal(field.emit(contact(66,{x:8000})),true);field.update({x:0,z:0},.1);field.encode(pass);
  assert.equal(field.stats.culled,1);assert.equal(field.stats.active,false);assert.equal(dispatches.length,settled);
});

test('domains reproject in world-space cells and resets cannot revive old texture state or stale source epochs',async t=>{
  const {field,writes,pass,dispatches}=await mockSurface(t);
  field.emit(contact());field.update({x:0,z:0},.1);field.encode(pass);
  field.update({x:.6,z:0},.1);
  const step=writes.get('scene wave substep 0');assert.equal(step[0],.5);assert.equal(step[8],0,'previous near origin is retained for the actual reproject');
  field.encode(pass);const before=dispatches.length,epoch=field.epoch;
  field.update({x:1000,z:0},0);field.encode(pass);
  assert.equal(field.epoch,epoch+1);assert.equal(field.stats.active,false);assert.equal(writes.get('scene surface wave domains')[15],0);assert.equal(dispatches.length,before);
  assert.equal(field.emit(contact(2,{epoch})),false);
  field.update({x:1000,z:0},.1);assert.equal(field.epoch,epoch+1,'a dormant teleported field does not reset on every frame');
});

test('wildlife emits physical snapshots once, budgets one whale entry despite three visual crowns, and ending actors does not erase water',async t=>{
  const boat={x:0,z:0,heading:0,length:20,beam:6,surgeVelocity:2},events=[],state=createMarineLifeState(()=>.4,{onSurfaceEvent:e=>events.push(e)});
  state.trigger('whale',boat,{behavior:'breach'});const visual=new Set();
  for(let i=0;i<600;i++){state.step(.025,boat);for(const e of state.effects)if(e.kind==='entry'&&e.strength>0)visual.add(e.id);}
  const entries=events.filter(e=>e.kind==='entry');assert.ok(entries.length>0);assert.equal(visual.size,entries.length*3,'secondary visual crowns cannot triple the physical impact budget');
  assert.ok(entries.every(e=>e.radiusMetres>1&&e.radiusMetres<3&&e.closingSpeed>0&&e.velocity[1]<0));
  assert.ok(events.every(e=>['entry','emerge','trail'].includes(e.kind)&&surfaceWaveEmission(e)));
  const {field,pass}=await mockSurface(t);field.emit(entries[0]);field.update(boat,.1);field.encode(pass);state.clear();state.step(0,boat);
  field.update(boat,.1);assert.equal(field.stats.active,true,'actor removal does not cancel already-transferred water motion');
  const dolphins=[],pod=createDolphinEncounter(()=>.4);pod.onSurfaceEvent=e=>dolphins.push(e);pod.trigger(boat);
  for(let i=0;i<480;i++)pod.step(.025,boat);
  assert.ok(dolphins.some(e=>e.kind==='entry')&&dolphins.some(e=>e.kind==='trail'));
  assert.ok(dolphins.every(e=>e.radiusMetres>0&&e.radiusMetres<1&&e.velocity.every(Number.isFinite)));
  const count=dolphins.length;pod.step(0,boat);pod.clear();assert.equal(dolphins.length,count);
});

test('anchor callbacks freeze impact mass and velocity before later substeps settle it on the seabed',()=>{
  const boat={x:-2300,z:-3700,length:20,beam:6,heading:0,heave:0,pitch:0,roll:0,eye:5,surgeVelocity:0,target:{heave:0}},events=[];
  const environment={terrain:{height:(x,z)=>x>-1700?Math.max(5,300-Math.abs(z+5000)*.01):-8},settings:{haze:3,rain:0,clouds:.3,cloudBase:1.5}};
  const state=createAnchorState(boat,{source:'anchor/player',onSurfaceEvent:e=>events.push(e)});assert.equal(state.drop(boat,environment),true);
  for(let i=0;i<1500;i++)state.step(1/60,boat,environment);
  assert.equal(events.length,1);assert.equal(events[0].source,'anchor/player');assert.equal(events[0].massKg,240);
  assert.ok(events[0].closingSpeed>0&&events[0].velocity[1]<0&&events[0].radiusMetres>0);assert.ok(surfaceWaveEmission(events[0]));
  assert.equal(state.velocity.y,0);const frozen=events[0].velocity.slice();state.reset(boat);assert.deepEqual(events[0].velocity,frozen);
});

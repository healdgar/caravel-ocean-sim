// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {test} from 'node:test';
import {writeGunneryToolInstances,gunneryToolPose,GUNNERY_TOOL_PIECE,GUNNERY_TOOL_RECORDS,GUNNERY_TOOL_RECORD_FLOATS} from '../js/gunnery-tools.js';
import {PROP_CONTINUUM_TOOLS} from '../js/prop-continuum.js';
import {createGunDefinitions} from '../js/gunnery-models.js';
import {requirePlayableShipModel} from '../js/ship-models.js';

function assertGPUToolRuntime(source){
  const renderer=source.slice(source.indexOf('export async function createGunneryTools'));
  assert.ok(renderer.length>500);assert.doesNotMatch(renderer,/buildGunneryToolVertices\s*\(/,'runtime cannot call the offline CPU tessellator');
  const update=renderer.slice(renderer.indexOf('update(company'),renderer.indexOf('draw(pass)'));
  assert.ok(update.length>100);assert.doesNotMatch(update,/writeBuffer\s*\(\s*vertex\s*,/,'runtime cannot upload animated triangle vertices');assert.match(update,/writeGunneryToolInstances\s*\(/,'live updates contain only compact tool endpoint commands');
}

test('gunnery tools cannot restore a CPU triangle-animation backend',()=>{
  const source=readFileSync(new URL('../js/gunnery-tools.js',import.meta.url),'utf8');assertGPUToolRuntime(source);
  assert.throws(()=>assertGPUToolRuntime(source.replace('writeGunneryToolInstances(company, boat, records, placed)','buildGunneryToolVertices(company, boat, vertices)')),/CPU tessellator|compact tool/);
});

// A ship's lines, colours and anchor are her detail layer (js/vessel-detail.js): static records her pose pass reads,
// with her compact state the only thing a frame uploads.
function assertGPUDetailRuntime(source){
  const runtime=source.slice(source.indexOf('export async function createVesselDetailGPU')),update=runtime.slice(runtime.indexOf('update(values)'),runtime.indexOf('encodeStations(pass)'));
  assert.ok(update.length>20);assert.match(update,/writeBuffer\(\s*state\s*,\s*0\s*,\s*values\s*\)/,'detail updates carry only her compact state');
  assert.doesNotMatch(update,/\b(?:triangle|tube|catenary)\s*\(|vertices\.set\s*\(/,'detail updates must not tessellate geometry on CPU');
}

test('a ship\'s lines, colours and anchor cannot restore per-frame CPU tessellation or dynamic triangle uploads',()=>{
  const source=readFileSync(new URL('../js/vessel-detail.js',import.meta.url),'utf8');assertGPUDetailRuntime(source);
  assert.throws(()=>assertGPUDetailRuntime(source.replace('device.queue.writeBuffer(state, 0, values)','device.queue.writeBuffer(model, 0, vertices)')),/compact state/);
  const splash=readFileSync(new URL('../js/anchor.js',import.meta.url),'utf8'),update=splash.slice(splash.indexOf('update(state, boat)'),splash.indexOf('draw(pass)'));
  assert.match(update,/writeAnchorSplashState\(/,'the splash uploads its compact state');assert.doesNotMatch(update,/vertices|triangle|tube/,'the splash builds no geometry on the CPU');
  const main=readFileSync(new URL('../js/main.js',import.meta.url),'utf8');
  assert.doesNotMatch(main,/buildVertices\(|updateMooringVertices|buildMooringAndGangplankVertices/,'mooring lines are never built on the CPU');
});

// The tools are pieces of the props' atlas, drawn through the one continuum: a frame's upload is a record a piece and
// the vessel's pose, and the GPU stands each record as an instance of its piece (js/gunnery-tools.js).
test('a gun crew\'s tools are compact records naming pieces of the props\' atlas, never triangles',()=>{
  const model=requirePlayableShipModel('victory'),boat={modelId:model.id,model,...model.runtime,heading:32,pitch:.1,roll:-.2,x:15,z:-8,heave:.4},gun={...createGunDefinitions('victory').find(g=>g.kind==='long-gun'),stage:'swab',progress:.125,offset:.5};
  const company={crew:[{intent:'work',position:[-2,5,1],job:{kind:'gunnery',stage:'working',gunRole:'loader',gun}}]};
  const records=new Float32Array(GUNNERY_TOOL_RECORDS*GUNNERY_TOOL_RECORD_FLOATS),{count}=writeGunneryToolInstances(company,boat,records);
  const end=(r,k)=>Array.from(records.subarray(r*8+k*4,r*8+k*4+3)),span=(p,q)=>Math.hypot(...p.map((v,i)=>v-q[i])),length=name=>PROP_CONTINUUM_TOOLS[GUNNERY_TOOL_PIECE[name]].length;
  assert.equal(count,2,'a sponger holds a staff and its head');
  assert.equal(records[3],GUNNERY_TOOL_PIECE['rammer-staff']);assert.equal(records[11],GUNNERY_TOOL_PIECE['sponge-head']);
  assert.ok(Math.abs(span(end(0,0),end(0,1))-length('rammer-staff'))<1e-4,'the staff is as long as its piece');
  assert.ok(span(end(1,1),end(0,1))<1e-5&&Math.abs(span(end(1,0),end(1,1))-length('sponge-head'))<1e-4,'the sponge is the staff\'s last piece');
  const pose=gunneryToolPose(boat,count);assert.equal(pose.byteLength,64);assert.equal(pose[15],count);
  assert.equal(writeGunneryToolInstances({crew:[]},boat,records).count,0,'an idle crew holds nothing');
});

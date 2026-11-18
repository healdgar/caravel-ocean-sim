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

function assertGPUAnchorRuntime(source){
  const renderer=source.slice(source.indexOf('export function requestAnchorPipelines')),update=renderer.slice(renderer.indexOf('update(state,boat)'),renderer.indexOf('drawSubmerged(pass)'));
  assert.ok(update.length>200);assert.match(renderer,/shader\(ANCHOR_GPU_RENDER/,'anchor draws must use the GPU expansion shader');assert.match(update,/writeAnchorGPUState\(/,'anchor updates contain physical commands');
  assert.doesNotMatch(update,/\b(?:triangle|tube)\s*\(|vertices\.set\s*\(/,'anchor updates must not tessellate geometry on CPU');assert.doesNotMatch(update,/writeBuffer\(\s*buffer\s*,/,'anchor updates must not upload animated vertices');
}

test('anchor updates cannot restore per-frame CPU tessellation or dynamic triangle uploads',()=>{
  const source=readFileSync(new URL('../js/anchor.js',import.meta.url),'utf8');assertGPUAnchorRuntime(source);
  assert.throws(()=>assertGPUAnchorRuntime(source.replace('writeAnchorGPUState(state,boat,values)','triangle(a,b,c,0)')),/physical commands|tessellate/);
  assert.throws(()=>assertGPUAnchorRuntime(source.replace('device.queue.writeBuffer(stateBuffer,0,values)','device.queue.writeBuffer(buffer,0,vertices)')),/animated vertices/);
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

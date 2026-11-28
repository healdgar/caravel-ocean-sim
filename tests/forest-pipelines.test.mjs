// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// A compute pipeline the forest compiles must also run. aca94ea stopped dispatching the root sort and left its
// shader, pipeline and bind group to be compiled and built at every landfall.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source=fs.readFileSync('js/forest-scenery.js','utf8');
// The forest's own compute passes: its stand, root blocks and wind (js/wgsl/forest-continuum.js), and the native
// surfaces' mipmaps (FOREST_SURFACE_MIPS_WGSL, in the renderer).
const shaders=source+fs.readFileSync('js/wgsl/forest-continuum.js','utf8');

// The renderer compiles its passes in one list: a name for each pipeline, and the entry points they are built from,
// in the same order.
function computeList(){
  const at=source.search(/const \[(\w+(?:,\w+)*)\]=await Promise\.all\(\[\s*\.\.\.\['forest/);
  assert.ok(at>0,'the renderer\'s pipeline list has moved; point this test at it');
  const names=/const \[([\w,]+)\]/.exec(source.slice(at))[1].split(',');
  const body=source.slice(at,source.indexOf(']);',at));
  const entries=[...body.matchAll(/\.\.\.\[([^\]]+)\]\.map\(/g)].flatMap(m=>[...m[1].matchAll(/'(\w+)'/g)].map(e=>e[1]));
  return {names,entries};
}

test('every compute pipeline the forest renderer creates is dispatched',()=>{
  const {names,entries}=computeList();
  assert.equal(entries.length,names.length,'one pipeline to a name');
  assert.ok(names.length>=10,names.join());
  for(const name of names)assert.ok(source.includes(`pass.setPipeline(${name})`),`${name} is compiled and never dispatched`);
  // The surfaces' two passes are chosen by mip level.
  assert.ok(source.includes('const pipeline=level?mip:init;pass.setPipeline(pipeline)'),'the native surfaces\' passes are compiled and never dispatched');
});

test('every compute entry point in the forest renderer\'s shaders has a pipeline',()=>{
  const entries=[...shaders.matchAll(/@compute\s*@workgroup_size\([^)]*\)\s*fn\s+(\w+)/g)].map(match=>match[1]);
  assert.ok(entries.length>=12,entries.join());
  const compiled=new Set([...computeList().entries,...[...source.matchAll(/entryPoint:'(\w+)'/g)].map(m=>m[1])]);
  for(const entry of entries)assert.ok(compiled.has(entry),`${entry} is shipped and never compiled`);
});

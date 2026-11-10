// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// A compute pipeline the forest compiles must also run. aca94ea stopped dispatching the root sort and left its
// shader, pipeline and bind group to be compiled and built at every landfall.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source=fs.readFileSync('js/forest-scenery.js','utf8');

test('every compute pipeline the forest renderer creates is dispatched',()=>{
  const lines=source.split('\n'),start=lines.findIndex(line=>/^\s*const \[reset,cull,[\w,]+\]=await Promise\.all\(\[$/.test(line));
  assert.ok(start>0,'the renderer\'s pipeline list has moved; point this test at it');
  const names=/const \[([\w,]+)\]/.exec(lines[start])[1].split(','),indent=/^\s*/.exec(lines[start+1])[0],elements=[];
  // One pipeline to a line at the list's own indent; deeper lines continue the one above.
  for(let i=start+1;!/^\s*\]\);/.test(lines[i]);i++){
    if(/^\s*/.exec(lines[i])[0]===indent)elements.push(lines[i]);else elements[elements.length-1]+=lines[i];
  }
  assert.equal(elements.length,names.length,'one pipeline to a name');
  const compute=names.filter((name,i)=>elements[i].includes('createComputePipelineAsync'));
  assert.deepEqual(compute,['reset','cull']);
  for(const name of compute)assert.ok(source.includes(`pass.setPipeline(${name})`),`${name} is compiled and never dispatched`);
});

test('every compute entry point in the forest renderer\'s shader has a pipeline',()=>{
  const entries=[...source.matchAll(/@compute\s*@workgroup_size\([^)]*\)\s*fn\s+(\w+)/g)].map(match=>match[1]);
  assert.ok(entries.length>=2);
  for(const entry of entries)assert.ok(source.includes(`entryPoint:'${entry}'`),`${entry} is shipped and never compiled`);
});

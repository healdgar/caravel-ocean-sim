// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
import test from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {boatHydrodynamics} from '../js/boat.js';

// Captured by the sole test owner from a clean archive of the pre-integration
// source and its own dependencies. No copied hydro implementation or tolerance.
const hydroParity=JSON.parse(readFileSync(new URL('./data/original-four-hydro.json',import.meta.url),'utf8'));
test('the original four retain every hydro scalar and return key exactly',()=>{
  assert.match(hydroParity.baseline,/^a0cb3fe[0-9a-f]*$/);
  assert.equal(hydroParity.rows.length,12);
  const byModel=new Map();
  for(const {modelId,length,beam,provisionDays,cargoTonnes,expected} of hydroParity.rows){
    assert.ok(['nina','victory','pinta','santa-maria'].includes(modelId));
    byModel.set(modelId,(byModel.get(modelId)??0)+1);
    assert.ok(Object.values(expected).every(Number.isFinite),'baseline must preserve its numeric-only scalar contract');
    const actual=boatHydrodynamics(length,beam,provisionDays,cargoTonnes,modelId);
    assert.deepEqual(actual,expected,`${modelId}: ${length}m × ${beam}m, ${provisionDays} days, ${cargoTonnes}t cargo`);
  }
  assert.deepEqual([...byModel].sort(),[['nina',3],['pinta',3],['santa-maria',3],['victory',3]]);
});

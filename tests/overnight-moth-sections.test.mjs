// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Root executes this after integrated hydrostatic measurement. The data target
// is original design DWL, not a claim of recovered lines or voyage-day loading.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {laterSailDesign,laterSailHullWidth} from '../js/models/later-sail.js';
import {boatHydrodynamics} from '../js/boat.js';

test('Moth V-body refinement preserves reported extremes, waterline breadth, fin and mass provenance',()=>{
  const d=laterSailDesign('gipsy-moth-iv'),p=d.profile,sy=d.frame.verticalScale;
  assert.equal(d.runtime.length,53.1*.3048);assert.equal(d.runtime.beam,10.5*.3048);
  assert.deepEqual(p.sections[3],[0,0,0,.65,1.33,1.70,1.80,1.61,.96,0,0,0]);
  assert.deepEqual(p.sections[4],[0,.12,.55,1.05,1.57,1.78,1.80,1.68,1.30,.92,.52,.23]);
  assert.equal(Math.max(...p.sections[3]),1.8);assert.equal(p.stations[2],-4.35);assert.equal(p.stations[9],4.35);
  assert.equal(p.levels[0],-.88/sy);assert.equal(d.keel.sections[0].y,-7.75*.3048/sy);
  assert.equal(d.loading.ballastKg,8490*.45359237);assert.equal(d.loading.referenceDisplacementKg,23320*.45359237);
  assert.equal(d.loading.permanentMassKg,null,'do not compensate geometry with an invented fixed mass');
  assert.equal(d.loading.designIncludesManifest,true);assert.equal(d.keel.configuration,'original-design-branch; no Sydney aft extension');
  assert.ok(Math.max(...p.sections[1])<.62&&Math.max(...p.sections[2])<1.40,'only immersed bilge/shoulder breadth is reduced');
  for(const z of [-3,0,3])assert.ok(laterSailHullWidth(d.id,z,p.levels[2])<laterSailHullWidth(d.id,z,0),'underbody retains a continuous tapered entrance and V section');
});

test('authored original-branch Moth geometry approaches reported design-DWL displacement without mass or sinkage compensation',()=>{
  const d=laterSailDesign('gipsy-moth-iv'),hydro=boatHydrodynamics(d.runtime.length,d.runtime.beam,60,0,d.id),target=d.loading.referenceDisplacementKg;
  assert.ok(Math.abs(hydro.mass-target)/target<.02,`geometry-derived ${hydro.mass} kg versus original design-DWL ${target} kg`);
  assert.ok(Math.abs(hydro.draft-7.75*.3048)<1e-6,'reported total draft stays fixed');
  assert.ok(Math.abs(hydro.sinkage)<1e-6,'DWL geometry is not fitted by moving the datum; tolerate the hydrostatic bisection precision');
});

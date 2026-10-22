// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ROWING_DESIGNS,rowingDesign,rowingHullWidth,rowingHullDeck,rowingDeck,rowingRigContext} from '../js/models/rowing.js';
import {surfaceRestPoint} from '../js/rig-surface.js';

const rowingModelTestNear=(a,b)=>assert.ok(Math.abs(a-b)<1e-9,`${a} != ${b}`);
test('rowing build subjects preserve source conventions and explicit authored hydro/loading interpretations',()=>{
  for(const [id,code,L,B,crew,rowers] of [['oseberg',4,21.5,5,32,30],['lusoria',5,18,2.8,26,24],['taino-canoe',6,14,1.8,30,24]]){
    const d=rowingDesign(id);assert.equal(d.modelCode,code);assert.equal(d.runtime.length,L);assert.equal(d.runtime.beam,B);
    assert.equal(d.loading.crew,crew);assert.equal(Object.keys(d.crewStations).length,crew);assert.equal(d.stations.length,rowers);
    assert.ok(Object.isFrozen(d)&&Object.isFrozen(d.profile)&&Object.isFrozen(d.stations));
    assert.match(d.interpretation,/authored/);assert.ok(d.loading.defaultProvisionDays>=1&&d.loading.defaultProvisionDays<=7);
    assert.equal(d.loading.designIncludesManifest,true);assert.ok(d.referenceMeasurements.length>0);
    rowingModelTestNear(rowingHullWidth(id,0,rowingHullDeck(id,0))*2*B/3.6,B);
    assert.ok(rowingDeck(id,0)<rowingHullDeck(id,0));
  }
  assert.equal(ROWING_DESIGNS.lusoria.referenceMeasurements[0].weight.kind,'vessel-weight-loading-unspecified');
  assert.equal(ROWING_DESIGNS.oseberg.referenceMeasurements[0].dimensions[0].kind,'hull-length-not-LWL');
  assert.equal(ROWING_DESIGNS['taino-canoe'].referenceMeasurements[0].dimensions,null);
});
test('oar stations match the own gunwale, pairs have clear longitudinal spacing and canoe has no borrowed rig or keel',()=>{
  for(const d of Object.values(ROWING_DESIGNS)){
    for(const station of d.stations){
      assert.ok(station.seat.every(Number.isFinite));assert.equal(d.crewStations[station.id].stationId,station.id);
      if(station.pivot){const y=station.oarlock==='hull-port'?station.pivot[1]:rowingHullDeck(d.id,station.z);rowingModelTestNear(Math.abs(station.pivot[0]),rowingHullWidth(d.id,station.z,y));}
      const opposite=d.stations.find(s=>s.row===station.row&&s.side===-station.side);
      assert.ok(opposite);rowingModelTestNear(opposite.seat[0],-station.seat[0]);rowingModelTestNear(opposite.z,station.z);
    }
    const rows=d.stations.filter(s=>s.side===1);for(let i=1;i<rows.length;i++)assert.ok((rows[i].z-rows[i-1].z)*d.runtime.length/12>.60);
  }
  const canoe=rowingDesign('taino-canoe');assert.deepEqual(canoe.masts,[]);assert.deepEqual(canoe.surfaces,[]);assert.equal(canoe.keel,null);assert.equal(canoe.capabilities.sailing,false);
  assert.equal(canoe.capabilities.steering,'steering-paddle');assert.equal(canoe.capabilities.gunnery,false);
  assert.equal(rowingDesign('oseberg').capabilities.steering,'steering-oar');assert.equal(rowingDesign('lusoria').keel,null);
  for(const id of ['missing','toString','__proto__'])assert.throws(()=>rowingDesign(id),/No rowing vessel/);
});
test('evidenced square rigs are independent, finite and have the intended physical areas',()=>{
  for(const d of Object.values(ROWING_DESIGNS)){
    const context=rowingRigContext(d.id);assert.equal(context,rowingRigContext(d.id));assert.ok(Object.isFrozen(context));
    assert.equal(context.masts.length,d.capabilities.sailing?1:0);assert.equal(context.surfaces.length,d.capabilities.sailing?1:0);
    if(d.surfaces.length){
      const s=d.surfaces[0];assert.equal(s.kind,'square');assert.equal(s.id,1);
      for(const [i,uv] of [[0,[0,0]],[1,[1,0]],[2,[1,1]],[3,[0,1]]]){
        const point=surfaceRestPoint(s,...uv);for(let j=0;j<3;j++)rowingModelTestNear(point[j],s.corners[i][j]);
      }
      const area=(s.corners[1][0]-s.corners[0][0]+s.corners[2][0]-s.corners[3][0])*.5*(s.corners[0][1]-s.corners[3][1])*d.runtime.beam/3.6*d.frame.verticalScale;
      rowingModelTestNear(area,d.id==='lusoria'?20:69.375);assert.ok(context.supports.length>=4&&context.lines.length>=5);
    }
  }
});

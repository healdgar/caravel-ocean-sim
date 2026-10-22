// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {anchorEquipment,createAnchorState,anchorFairlead,anchorRodePoints} from '../js/anchor-state.js';
import {requirePlayableShipModel} from '../js/ship-models.js';
import {getShipParts} from '../js/ship-parts.js';
import {createGunDefinitions} from '../js/gunnery-models.js';

test('later equipment matches actual fitted roles, with no inert phantom canoe anchor',()=>{
  for(const id of ['oseberg','lusoria','taino-canoe','flying-cloud','gipsy-moth-iv']){
    const model=requirePlayableShipModel(id),boat={modelId:id,...model.runtime,x:0,z:0,heave:0,heading:0,pitch:0,roll:0},parts=getShipParts(id),state=createAnchorState(boat);
    assert.deepEqual(createGunDefinitions(id),[]);assert.deepEqual(parts.equipment.guns,[]);
    if(id==='taino-canoe'){
      assert.equal(anchorEquipment(boat),null);assert.equal(parts.equipment.anchor,null);assert.equal(state.installed,false);
      assert.equal(state.drop(boat),false);assert.equal(state.weigh(),false);assert.deepEqual(anchorRodePoints(state,boat),[]);
      assert.deepEqual(state.step(.1,boat),{x:0,z:0,yaw:0,tension:0});assert.equal(Object.hasOwn(model.nodes,'anchor.port.fairlead'),false);
    }else{
      const limits=anchorEquipment(boat);assert.ok(limits.anchorMass>0&&limits.renderScale>0&&limits.maxRode>0);
      assert.equal(parts.equipment.anchor.limits,limits);assert.equal(state.installed,true);assert.equal(state.phase,'stowed');
      assert.ok(Object.values(anchorFairlead(boat)).every(Number.isFinite));assert.equal(anchorRodePoints(state,boat).length,49);
      assert.deepEqual(state.step(.1,boat),{x:0,z:0,yaw:0,tension:0});
    }
  }
});

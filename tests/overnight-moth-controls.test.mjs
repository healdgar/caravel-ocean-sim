// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Source-authored integration checks; root alone runs the combined suite.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {laterSailDesign,laterSailStairFlights} from '../js/models/later-sail.js';
import {laterSailRigContext} from '../js/additional-rig.js';
import {createProceduralShipDefinition,resolveProceduralShipNode} from '../js/procedural-models.js';

test('Moth headsail and mainsail belay on opposite accessible sides aft of the actual cabin',()=>{
  const d=laterSailDesign('gipsy-moth-iv'),c=laterSailRigContext(d.id),model=createProceduralShipDefinition(d.id),boat={modelId:d.id,...d.runtime};
  const cabin=d.structures[0],aft=cabin.centre[2]+cabin.size[2]/2,roof=cabin.centre[1]+cabin.size[1]/2,flight=laterSailStairFlights(d.id).find(s=>s.zoneId==='cockpit');
  for(const group of ['fore','main']){
    const station=c.controlStations[group],line=c.lines[station.lineIndex];
    assert.ok(station.position[2]>aft&&station.position[2]<flight.z0,'crew does not enter cabin walls or the cockpit descent');
    assert.ok(station.lead[2]>aft,'working fall is actually led aft; no teleporting work-station alias');
    assert.equal(line.kind,'working-fall');assert.equal(line.controlGroup,group);assert.deepEqual(line.b,station.lead);
    assert.deepEqual(resolveProceduralShipNode(boat,model,'station.haul.'+group,{space:'design'}),station.position);
    assert.deepEqual(resolveProceduralShipNode(boat,model,'rig.'+group+'.fall',{space:'design'}),station.lead);
    for(const z of [cabin.centre[2]-cabin.size[2]/2,aft]){
      const t=(z-line.a[2])/(line.b[2]-line.a[2]);
      if(t>=0&&t<=1)assert.ok(line.a[1]+(line.b[1]-line.a[1])*t>roof+.03/d.frame.verticalScale,'real fall clears the cabin roof');
    }
  }
  assert.ok(c.controlStations.fore.position[0]>0&&c.controlStations.main.position[0]<0);
});

import {test} from 'node:test';
import assert from 'node:assert/strict';
import {deepSeaColour,coastalClarity,coastalTurbidityScale} from '../js/sea-colour.js';

const blueOverGreen=([,g,b])=>b/g;

test('deep water is blue at every latitude, and bluest in the low-latitude gyres',()=>{
  for(const latitude of [0,12,24,31,38,50,62,75,-20,-50]){
    const [r,g,b]=deepSeaColour(latitude);
    assert.ok(b>g&&g>r,`${latitude}: ${[r,g,b]} is not blue over green over red`);
  }
  assert.ok(blueOverGreen(deepSeaColour(15))>blueOverGreen(deepSeaColour(40)));
  assert.ok(blueOverGreen(deepSeaColour(40))>blueOverGreen(deepSeaColour(65)));
});

test('sea colour is the same north and south and changes smoothly across the climates',()=>{
  assert.deepEqual(deepSeaColour(-33),deepSeaColour(33));
  for(let latitude=0;latitude<80;latitude++){
    const a=deepSeaColour(latitude),b=deepSeaColour(latitude+1);
    for(let k=0;k<3;k++)assert.ok(Math.abs(a[k]-b[k])<0.002,`step at ${latitude}: ${a} to ${b}`);
  }
});

test('turquoise shallows belong to clear tropical coasts, not estuaries or high latitudes',()=>{
  assert.equal(coastalClarity(18,'volcanic-island'),1);
  assert.equal(coastalClarity(-18,'volcanic-island'),1);
  assert.equal(coastalClarity(38.7,'estuary-harbor'),0,'Lisbon lies on the Tagus');
  assert.equal(coastalClarity(18,'river-delta'),0,'a tropical river still runs murky');
  assert.equal(coastalClarity(50,'volcanic-island'),0);
  const subtropics=coastalClarity(30,'volcanic-island');
  assert.ok(subtropics>0&&subtropics<1);
});

test('clear coasts show the bed through far more water than murky ones',()=>{
  const tropical=coastalTurbidityScale(18,'volcanic-island'),temperate=coastalTurbidityScale(50,'volcanic-island'),estuary=coastalTurbidityScale(18,'estuary-harbor');
  assert.ok(tropical<temperate&&temperate<estuary,`${tropical} ${temperate} ${estuary}`);
  assert.equal(temperate,1);
});

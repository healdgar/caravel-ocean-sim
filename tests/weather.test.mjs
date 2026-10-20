import assert from 'node:assert/strict';
import {test} from 'node:test';
import {readFile} from 'node:fs/promises';
import {createHash} from 'node:crypto';
import {createWeatherState,lightningEnvelope,createImpactDetector,weatherAudioLevels,STORM_WEATHER} from '../js/weather-state.js';
import {SOUND_ASSETS} from '../js/audio-assets.js';

test('storm events have bounded flashes, natural spacing and distance-delayed thunder',()=>{
  const w=createWeatherState(()=>.5),events=[],camera={x:20,z:40};
  for(let i=0;i<12000;i++){
    w.step(1/60,STORM_WEATHER,camera);assert.ok(w.flash>=0&&w.flash<=1);
    if(w.event)events.push({...w.event});
  }
  assert.ok(events.length>=6&&events.length<14);
  for(let i=0;i<events.length;i++){
    const e=events[i];assert.ok(Math.abs(Math.hypot(e.x-camera.x,e.z-camera.z)-e.distance)<1e-9);
    assert.equal(e.delay,e.distance/343);assert.ok(e.delay>.7);
    if(i)assert.ok(e.at-events[i-1].at>9);
  }
  assert.equal(lightningEnvelope(-1),0);assert.equal(lightningEnvelope(1),0);
  w.step(.1,{rain:0,thunder:0},camera);assert.equal(w.flash,0);assert.equal(w.event,null);
  for(let i=0;i<100;i++)w.step(.1,{rain:0,thunder:0},camera);
  assert.equal(w.strike,null);
});

test('weather clamps bad inputs, follows elapsed seconds and never catches up a long pause',()=>{
  const a=createWeatherState(()=>.5),b=createWeatherState(()=>.5),p={rain:50,precipitation:9,thunder:0};
  for(let i=0;i<60;i++)a.step(1/60,p,{x:0,z:0});
  for(let i=0;i<30;i++)b.step(1/30,p,{x:0,z:0});
  assert.ok(Math.abs(a.time-b.time)<1e-10);assert.equal(a.intensity,1);assert.equal(a.type,3);
  a.step(100,p,{x:0,z:0});assert.ok(a.time<1.11);
  a.step(NaN,{rain:NaN,precipitation:NaN},{x:0,z:0});assert.equal(a.intensity,0);assert.equal(a.type,0);
});

test('hull sounds follow new GPU contact events, not persistent pressure or resets',()=>{
  const detect=createImpactDetector(2),v=new Float32Array(32);
  v[7]=1;v[15]=3;assert.equal(detect.sample(v,1),null);
  assert.equal(detect.sample(v,1),null);
  v[15]++;assert.equal(detect.sample(v,1).strength,1);
  v[23]=2;v[31]++;v[15]++;assert.equal(detect.sample(v,1).strength,2);
  v[15]++;assert.equal(detect.sample(v,2),null);
  v[15]=v[31]=0;assert.equal(detect.sample(v,2),null);
  v[15]=1;assert.equal(detect.sample(v,2).strength,1);
});

test('audio layers follow wind, sternway, precipitation type and proximity',()=>{
  assert.ok(Object.values(weatherAudioLevels({})).every(v=>v===0));
  const light=weatherAudioLevels({wind:8,speed:2,intensity:.2}),heavy=weatherAudioLevels({wind:28,speed:-2,intensity:1});
  assert.ok(heavy['wind-strong']>light['wind-strong']);assert.ok(heavy['rain-heavy']>light['rain-heavy']);
  assert.equal(heavy['hull-wash'],light['hull-wash']);
  const snow=weatherAudioLevels({wind:8,intensity:1,type:1});
  for(const id of ['rain-light','rain-heavy','sleet-deck','hail-deck'])assert.equal(snow[id],0);
  assert.equal(weatherAudioLevels({intensity:1,type:3,ship:0})['hail-deck'],0);
  assert.ok(weatherAudioLevels({intensity:1,type:2})['sleet-deck']>0);
});

test('only the twelve selected assets ship, with matching provenance and safe local paths',async()=>{
  const records=JSON.parse(await readFile(new URL('../assets/audio/provenance.json',import.meta.url)));
  assert.equal(records.length,12);assert.equal(Object.keys(SOUND_ASSETS).length,12);
  assert.ok(!SOUND_ASSETS['hull-slam']);assert.ok(!SOUND_ASSETS['snow-contact']);
  for(const record of records){
    const asset=SOUND_ASSETS[record.id];assert.match(asset.url,/^assets\/audio\/[a-z-]+\.mp3$/);
    const bytes=await readFile(new URL('../'+asset.url,import.meta.url));
    assert.equal(createHash('sha256').update(bytes).digest('hex'),record.sha256);
    assert.equal(asset.seconds,record.seconds);assert.equal(asset.loop,record.loop);
  }
});

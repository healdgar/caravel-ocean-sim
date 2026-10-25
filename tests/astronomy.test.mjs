// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {test} from 'node:test';
import {astronomyDirection,astronomyObserver,computeAstronomy,createAstronomyClock,propagatedStars,writeAstronomyFrame,horizonDipDegrees,celestialNavigationSight} from '../js/astronomy.js';
import {createShareLink} from '../js/sharing.js';
import {SKY_CLOUD_FUNCS,ENV_CUBE} from '../js/wgsl/sky.js';
import {SKY_BG} from '../js/wgsl/ocean.js';
import {FRAME_WGSL} from '../js/wgsl/common.js';
import {CELESTIAL_FRAME_BYTES,CELESTIAL_FRAME_FLOATS,withCelestialFrame} from '../js/wgsl/celestial.js';
const close=(actual,expected,tolerance,label='value')=>assert.ok(Math.abs(actual-expected)<=tolerance,`${label}: ${actual} vs ${expected}`);
const angular=(a,b)=>Math.acos(Math.max(-1,Math.min(1,a.reduce((s,v,i)=>s+v*b[i],0))))*180/Math.PI;

test('astronomy cardinal coordinates and global observer displacement preserve true geography',()=>{
  for(const [az,alt,expected]of [[0,0,[0,0,-1]],[90,0,[1,0,0]],[180,0,[0,0,1]],[270,0,[-1,0,0]],[0,90,[0,1,0]]])astronomyDirection(az,alt).forEach((v,i)=>close(v,expected[i],1e-12));
  const o=astronomyObserver({latitude:0,longitude:179.99,x:0,z:0},{x:4000,z:0});assert.ok(o.longitude< -179.9);close(o.latitude,0,1e-6);
  const north=astronomyObserver({latitude:0,longitude:0,x:0,z:0},{x:0,z:-10000});assert.ok(north.latitude>.08);close(north.longitude,0,1e-10);
});
test('unwrapped sky clock survives repeated spectrum wraps, pauses, date edits and share reload',()=>{
  const clock=createAstronomyClock(new URLSearchParams('skyMode=astronomy&astroDate=2024-02-29T23:59:00Z&astroRate=1'));
  clock.update(86461,{x:0,z:0});assert.equal(clock.state.date,'2024-03-02T00:00:01.000Z');
  const frozen=clock.set({rate:0}).date;clock.update(5000);assert.equal(clock.state.date,frozen);
  clock.set({mode:'manual'});clock.update(86400);assert.equal(clock.state.date,frozen);
  clock.set({mode:'astronomy',date:'1492-10-12T12:00:00Z',latitude:-34,longitude:151,rate:1});
  const url=createShareLink('https://example.test/',{}, {modelId:'nina'},'ship',{astronomy:clock.share()});
  const restored=createAstronomyClock(new URL(url).searchParams);assert.equal(restored.mode,'astronomy');assert.equal(restored.state.date,clock.state.date);close(restored.state.observer.latitude,-34,1e-9);close(restored.state.observer.longitude,151,1e-9);
});
test('Sun and Moon match independent USNO modern and 1805 UT1 reference data with explicit parallax conventions',async()=>{
  for(const name of ['usno-2026-10-21-0000-saba','usno-2026-10-21-1600-saba','usno-1805-10-21-1200-portsmouth']){
    const data=JSON.parse(await readFile(new URL('./data/astronomy/'+name+'.json',import.meta.url))),p=data.properties;
    assert.ok(!data.error);const time=String(p.time).trim(),date=`${String(p.year).padStart(4,'0')}-${String(p.month).padStart(2,'0')}-${String(p.day).padStart(2,'0')}T${time}Z`;
    const state=computeAstronomy(date,{latitude:data.geometry.coordinates[1],longitude:data.geometry.coordinates[0],height:0});
    for(const body of p.data.filter(row=>['Sun','Moon'].includes(row.object))){
      // USNO Hc is geocentric; PA is the documented positive altitude correction.
      // Our geometricAltitude is already topocentric and never subtracts PA twice.
      const actual=state[body.object.toLowerCase()],expected=body.almanac_data.hc-body.altitude_corrections.pa;
      close(actual.geometricAltitude,expected,.04,name+' '+body.object+' topocentric altitude');
      assert.ok(angular(astronomyDirection(actual.azimuth,0),astronomyDirection(body.almanac_data.zn,0))<.05,name+' azimuth');
    }
    if(String(p.moon_illum??'').trim()&&Number.isFinite(parseFloat(p.moon_illum)))close(state.moon.phase,parseFloat(p.moon_illum)/100,.015,'USNO phase');
  }
});
test('1492 airless topocentric Moon matches saved NASA/JPL Gregorian Horizons request',async()=>{
  const raw=JSON.parse(await readFile(new URL('./data/astronomy/jpl-1492-moon-saba.json',import.meta.url)));
  assert.ok(!raw.error);const lines=raw.result.split('$$SOE')[1].split('$$EOE')[0].trim().split('\n');
  for(let i=0;i<lines.length;i++){
    const fields=lines[i].split(','),state=computeAstronomy(`1492-10-12T${12+i}:00:00Z`,{latitude:17.635,longitude:-63.238,height:0});
    // Historical Earth-rotation/Delta-T models differ; this is a bounded visual
    // regression, not a certified 2-arcminute historical navigation claim.
    close(state.moon.geometricAltitude,+fields[4],.10,'1492 lunar altitude');
    assert.ok(angular(astronomyDirection(state.moon.azimuth,0),astronomyDirection(+fields[3],0))<.10);
  }
});
test('physical phases, terminator, angular size, historical precession and catalogue motion remain independent of ship heading',()=>{
  const o={latitude:17.635,longitude:-63.238,height:0};
  const full=computeAstronomy('2024-01-25T17:54:00Z',o),fresh=computeAstronomy('2024-02-09T22:59:00Z',o),quarter=computeAstronomy('2024-02-16T15:01:00Z',o);
  assert.ok(full.moon.phase>.995&&fresh.moon.phase<.005);assert.ok(Math.abs(quarter.moon.phase-.5)<.015);
  assert.ok(full.moon.irradiance>fresh.moon.irradiance*100);
  for(const state of [full,fresh,quarter]){close(Math.hypot(...state.moon.direction),1,1e-10);assert.ok(state.moon.radius>.0038&&state.moon.radius<.0052);close(state.moon.direction.reduce((s,v,i)=>s+v*state.moon.right[i],0),0,1e-10);}
  const past=computeAstronomy('1492-10-12T00:00:00Z',o),modern=computeAstronomy('2026-10-21T00:00:00Z',o);
  assert.notDeepEqual(Array.from(past.starRotation),Array.from(modern.starRotation));
  const stars=propagatedStars('1492-10-12T00:00:00Z'),now=propagatedStars('2026-10-21T00:00:00Z');assert.ok(stars.length>1500);
  const arcturus=stars.findIndex(star=>star.hip===69673);assert.ok(arcturus>=0);assert.ok(angular(stars[arcturus].direction,now[arcturus].direction)>.1);
});
test('production celestial frame is explicit, preserves legacy prefix and disables lunar output in manual mode',()=>{
  assert.equal(CELESTIAL_FRAME_FLOATS*4,CELESTIAL_FRAME_BYTES);assert.equal(CELESTIAL_FRAME_BYTES,528);
  assert.match(withCelestialFrame(FRAME_WGSL),/starRotation:mat4x4f/);assert.doesNotMatch(FRAME_WGSL,/moonDir/);
  const clock=createAstronomyClock(),f=new Float32Array(132);f.fill(37,0,96);writeAstronomyFrame(f,clock);
  assert.ok(f.subarray(0,96).every(v=>v===37));assert.equal(f[99],0);assert.equal(f[112],0);
  clock.set({mode:'astronomy'});writeAstronomyFrame(f,clock);assert.equal(f[112],1);assert.ok(f[99]>0);assert.throws(()=>writeAstronomyFrame(new Float32Array(96),clock),/132/);
});

test('environment excludes both explicit celestial discs while the actual sky includes them once',()=>{
  assert.match(SKY_CLOUD_FUNCS,/if \(withSun\) \{[^}]*sunDisk[^}]*lunarDisk[\s\S]*?\}/);
  assert.match(ENV_CUBE,/skyRadiance\(dir, false\)/);
  assert.equal((SKY_BG.match(/lunarDisk\(dir\)/g)||[]).length,1);
});

test('celestial navigation sight helpers recover Polaris latitude with guard correction and solar meridian sight',()=>{
  close(horizonDipDegrees(0),0,1e-12);
  close(horizonDipDegrees(4),1.76*2/60,1e-12);
  const nightState=computeAstronomy('2026-10-21T02:00:00Z',{latitude:28.5,longitude:-63.238,height:2.5});
  const nightSight=celestialNavigationSight(nightState);
  assert.equal(nightSight.polaris.visible,true);
  close(nightSight.polaris.estimatedLatitude,28.5,0.2,'modern Polaris Regimento do Norte latitude');
  const columbusNight=computeAstronomy('1492-10-12T04:00:00Z',{latitude:24.1,longitude:-74.5,height:2.5});
  const columbusSight=celestialNavigationSight(columbusNight);
  assert.ok(columbusSight.polaris.polarDistanceDegrees>3.0,'1492 Polaris was >3 degrees from the celestial pole');
  close(columbusSight.polaris.estimatedLatitude,24.1,0.35,'1492 Polaris guard-corrected latitude');
  const noonState=computeAstronomy('2026-03-20T16:20:00Z',{latitude:17.635,longitude:-63.238,height:2.5});
  const noonSight=celestialNavigationSight(noonState);
  assert.equal(noonSight.solar.visible,true);
  close(noonSight.solar.meridianLatitude,17.635,0.25,'equinox meridian solar latitude');
  close(noonSight.solar.estimatedLongitude,-63.238,2.5,'apparent solar time longitude');
});

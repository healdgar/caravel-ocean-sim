// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {orbitElevation,orbitDistance,panOrbit,placeOrbitCamera} from '../js/camera.js';
import {createShareLink} from '../js/sharing.js';

test('inspection orbit crosses the waterline and stays well defined at either pole',()=>{
  const camera={},orbit={yaw:.7,elevation:orbitElevation(-.6)};
  placeOrbitCamera(camera,orbit,10,4,20,12);
  assert.ok(camera.y<0,'negative elevation reaches the submerged hull');
  for(const angle of [-100,100]){
    orbit.elevation=orbitElevation(angle);placeOrbitCamera(camera,orbit,0,4,0,orbitDistance(1));
    assert.ok(Object.values(camera).every(Number.isFinite));
    assert.ok(Math.hypot(camera.x,camera.z)>0,'camera never crosses the orbit pole');
  }
  assert.ok(orbitDistance(2)<10,'waterline details can be approached closer than the old ten-metre floor');
});

test('inspection pan moves focus in the screen plane and does not depend on render resolution',()=>{
  const orbit={yaw:.83,elevation:-.4},camera={},distance=22;
  placeOrbitCamera(camera,orbit,0,4,0,distance);const before={...camera};
  panOrbit(orbit,120,-180,distance,1,800);placeOrbitCamera(camera,orbit,0,4,0,distance);
  const delta=[camera.x-before.x,camera.y-before.y,camera.z-before.z];
  const forward=[Math.cos(before.pitch)*Math.sin(before.yaw),Math.sin(before.pitch),-Math.cos(before.pitch)*Math.cos(before.yaw)];
  assert.ok(Math.abs(delta.reduce((s,n,i)=>s+n*forward[i],0))<1e-10,'pan is orthogonal to sight line');
  assert.ok(camera.y<before.y,'dragging the focus down exposes the waterline');
  const other={yaw:.83,elevation:-.4};panOrbit(other,60,-90,distance,1,400);
  for(const key of ['panX','panY','panZ'])assert.ok(Math.abs(orbit[key]-other[key])<1e-10,'same viewport fraction gives same world pan');
});

test('inspection share links retain underwater elevation, close range and panned focus',()=>{
  const boat={heading:37,x:345,z:-678},orbit={yaw:4,elevation:-.52,distance:3,panX:2,panY:-4,panZ:9};
  const link=new URL(createShareLink('https://example.com/',{},boat,'ship',{orbit}));
  for(const [key,value]of Object.entries({orbitElevation:orbit.elevation*180/Math.PI,orbitDistance:3,orbitPanX:2,orbitPanY:-4,orbitPanZ:9})){
    assert.ok(Math.abs(Number(link.searchParams.get(key))-value)<1e-6,key);
  }
  const free=new URL(createShareLink('https://example.com/',{},boat,'free',{cam:{x:8,y:-7,z:3,yaw:.4,pitch:1}}));
  assert.equal(Number(free.searchParams.get('cam').split(',')[1]),-7);
  assert.equal(Number(free.searchParams.get('boatX')),345,'sharing a moved inspection camera must not move the ship to its position');
  assert.equal(Number(free.searchParams.get('boatZ')),-678);
});

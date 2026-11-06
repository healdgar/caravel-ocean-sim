// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// What a harbour needs guarding, read from the height field alone, on coasts made to order.
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bestGroundNear,commandFrom,readHarbourGeography} from '../js/harbour-geography.js';

const SPAN=8192,SIZE=257;
const region={x:0,z:0,span:SPAN,size:SIZE};
function coast(height){
  const heights=new Float32Array(SIZE*SIZE);
  for(let j=0;j<SIZE;j++)for(let i=0;i<SIZE;i++)heights[j*SIZE+i]=height((i/(SIZE-1)-.5)*SPAN,(j/(SIZE-1)-.5)*SPAN);
  return heights;
}
// Land to the south of z = 0, with sea to the north.
const straightCoast=coast((x,z)=>z*0.02);
// A round bay south of the sea, joined to it by a strait 500 m wide and 800 m long.
const bayWithMouth=coast((x,z)=>{
  const inBay=Math.hypot(x,z-1800)<1400,inStrait=Math.abs(x)<250&&z>-300&&z<700,sea=z<-200;
  return inBay||inStrait||sea?-8:6+Math.abs(x)*.002;
});
// A river 900 m wide running north and south across the chart, sea to the north.
const river=coast((x,z)=>(Math.abs(x)<450?-6:4));

test('an open shore has no mouth, and its anchorage lies off the town',()=>{
  const read=readHarbourGeography(straightCoast,region,{town:{x:0,z:20}});
  assert.equal(read.kind,'roadstead');
  assert.equal(read.mouth,null);
  assert.ok(read.anchorage.z<0&&read.anchorage.z>-800,`anchorage ${read.anchorage.z}`);
});

test('a bay behind a strait has a mouth, at the strait, with land on both hands',()=>{
  const read=readHarbourGeography(bayWithMouth,region,{town:{x:900,z:2800}});
  assert.equal(read.kind,'mouth');
  assert.ok(read.anchorage.z>700,`the anchorage is in the bay, at ${read.anchorage.x},${read.anchorage.z}`);
  const {mouth}=read;
  assert.ok(Math.abs(mouth.width-500)<130,`mouth ${mouth.width} m wide`);
  assert.ok(mouth.z>-350&&mouth.z<750,`mouth at z ${mouth.z}`);
  assert.ok(mouth.left&&mouth.right,'shores found');
  assert.ok(Math.abs(mouth.left.x)>200&&Math.abs(mouth.right.x)>200&&Math.sign(mouth.left.x)!==Math.sign(mouth.right.x),'one each side');
});

test('sea is where the record says, even against the size of the water',()=>{
  const north=readHarbourGeography(river,region,{town:{x:520,z:0},seaward:0});
  const south=readHarbourGeography(river,region,{town:{x:520,z:0},seaward:180});
  assert.equal(north.kind,'river');
  assert.ok(north.route.at(-1).z<-3500,`going out north ends at ${north.route.at(-1).z}`);
  assert.ok(south.route.at(-1).z>3500,`going out south ends at ${south.route.at(-1).z}`);
});

test('a lake is not an anchorage',()=>{
  const heights=coast((x,z)=>{
    if(z<-1500)return -8;
    return Math.hypot(x,z-400)<500?-8:6;
  });
  const read=readHarbourGeography(heights,region,{town:{x:0,z:800}});
  assert.ok(read.anchorage.z<-1500,`the ship lies in the sea, not the lake: ${read.anchorage.z}`);
});

test('the reading does not depend on the resolution of the terrain',()=>{
  const fine=new Float32Array(513*513);
  for(let j=0;j<513;j++)for(let i=0;i<513;i++){
    const x=(i/512-.5)*SPAN,z=(j/512-.5)*SPAN,inBay=Math.hypot(x,z-1800)<1400,inStrait=Math.abs(x)<250&&z>-300&&z<700,sea=z<-200;
    fine[j*513+i]=inBay||inStrait||sea?-8:6+Math.abs(x)*.002;
  }
  const a=readHarbourGeography(bayWithMouth,region,{town:{x:900,z:2800}}),b=readHarbourGeography(fine,{...region,size:513},{town:{x:900,z:2800}});
  assert.equal(a.kind,b.kind);
  assert.ok(Math.abs(a.mouth.z-b.mouth.z)<130,`${a.mouth.z} and ${b.mouth.z}`);
});

test('ground that commands the mouth is found beside it, and a hill in the way counts against a gun',()=>{
  const read=readHarbourGeography(bayWithMouth,region,{town:{x:900,z:2800}});
  const spot=bestGroundNear(read,read.mouth.left,{reach:500});
  assert.ok(spot,'ground found');
  assert.ok(Math.hypot(spot.x-read.mouth.left.x,spot.z-read.mouth.left.z)<500);
  assert.ok(spot.command>0.1,`command ${spot.command}`);
  const faces=commandFrom(read,spot.x,spot.z);
  const toMouth=[read.mouth.x-spot.x,read.mouth.z-spot.z],length=Math.hypot(...toMouth);
  assert.ok((faces.faceX*toMouth[0]+faces.faceZ*toMouth[1])/length>0,'it looks towards the water it holds');
  const walled=coast((x,z)=>(z<0?-8:Math.abs(z-300)<60?60:5));
  const open=readHarbourGeography(walled,region,{town:{x:0,z:20}});
  assert.ok(commandFrom(open,0,1000).held===0,'behind a ridge nothing can be laid on the sea');
  assert.ok(commandFrom(open,0,100).held>0,'in front of it, the sea is open');
});

// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Her hull must stand clear of the sea at her historic proportions. These hold
// the design numbers; oseberg-deck-water-gpu.test.mjs holds the water itself.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ROWING_DESIGNS,rowingHullDeck,rowingDeck,rowingHullWidth} from '../js/models/rowing.js';
import {boatHydrodynamics} from '../js/boat.js';
import {createRowingShipMesh} from '../js/rowing-ships.js';
import {rowingSteeringPose} from '../js/rowing.js';
import {hullLoftBottom,hullLoftPoint,hullLoftWGSL} from '../js/hull-loft.js';

const d=ROWING_DESIGNS.oseberg,sy=d.frame.verticalScale,sx=d.runtime.beam/d.frame.beam;
const metres=y=>y*sy;

test('she floats at her historic draft and freeboard, with a metre of rail amidships',()=>{
  const h=boatHydrodynamics(d.runtime.length,d.runtime.beam,undefined,0,'oseberg');
  assert.ok(Math.abs(h.sinkage)<1e-6,'the standard load floats her on her design waterline');
  assert.ok(h.draft>=.8&&h.draft<=1,`draft ${h.draft}`);
  assert.ok(h.freeboard>=.8&&h.freeboard<=1,`freeboard ${h.freeboard}`);
  assert.ok(metres(rowingHullDeck('oseberg',0))>=.9,'rail stands clear of the sea amidships');
  assert.ok(metres(rowingDeck('oseberg',0))>0,'floorboards stay above the waterline');
  assert.ok(h.mass>15000&&h.mass<26000,`displacement ${h.mass}`);
  assert.ok(h.metacentricHeight>1&&h.metacentricHeight<3,`GM ${h.metacentricHeight}`);
  // Crew must sit inside her, not perched on the rail.
  assert.ok(metres(rowingHullDeck('oseberg',0)-d.seatHeight)>.4,'rail stands well above the benches');
});

test('her rail sweeps up to carved stems while her keel keeps a long waterline',()=>{
  for(const z of [-6,6])assert.ok(metres(rowingHullDeck('oseberg',z))>2.2,'rail rises high at the ends');
  let rail=rowingHullDeck('oseberg',0);
  for(const z of [1,2,3,4,5,5.5,6]){const next=rowingHullDeck('oseberg',z);assert.ok(next>rail,'rail keeps rising toward the stem');rail=next;}
  const parts=new Map();createRowingShipMesh('oseberg',{parts});const stems=parts.get('hull.carved-stems');
  let top=-Infinity,reach=0;
  for(let i=0;i<stems.length;i+=9){top=Math.max(top,stems[i+1]);reach=Math.max(reach,Math.abs(stems[i+2]));}
  assert.ok(metres(top)>4.5,`carved stems stand ${metres(top)} m above the water`);
  assert.ok(reach<6.5,'stems stay close to her hull length');
  // Keel and floor keep the gentle sheer. Only the rail takes the sweep.
  assert.ok(metres(hullLoftBottom(d.profile,4))<-.4,'keel stays well under water toward the ends');
  assert.ok(metres(rowingDeck('oseberg',4.8)-rowingDeck('oseberg',0))<.45,'floor stays nearly level');
  let wet=0;for(let z=-6;z<=6;z+=.01)if(rowingHullWidth('oseberg',z,0)>0)wet+=.01;
  assert.ok(wet/12>.8,`waterline covers ${wet/12} of her length`);
});

test('her sides flare out from the waterline to the rail and the stem is raked',()=>{
  const waterline=rowingHullWidth('oseberg',0,0)*sx*2;
  assert.ok(waterline<d.runtime.beam*.9,`waterline beam ${waterline} is narrower than her rail`);
  for(let y=.05;y<rowingHullDeck('oseberg',0);y+=.05)assert.ok(rowingHullWidth('oseberg',0,y)>=rowingHullWidth('oseberg',0,y-.05),'no tumblehome amidships');
  const foot=hullLoftPoint(d.profile,6,d.profile.levels[0],1),head=hullLoftPoint(d.profile,6,d.profile.deck,1);
  assert.ok(head[2]-foot[2]>1,'forefoot sweeps back from the head of the stem');
  assert.equal(head[2],6);assert.equal(d.keel.bounds[1],foot[2],'the keel meets the foot of the stem');
});

test('the steering oar hangs clear of her hull from its pivot',()=>{
  const boat={modelId:'oseberg',...d.runtime,rudder:0,rowingState:{phase:0,rate:0,effortPort:0,effortStarboard:0}};
  const pose=rowingSteeringPose(boat),pivot=d.steering.pivot.map((v,i)=>v*[sx,sy,d.runtime.length/12][i]);
  for(const t of [0,.25,.5,.75,1]){
    const p=pivot.map((v,i)=>v+(pose.shaftB[i]-v)*t),design=[p[0]/sx,p[1]/sy,p[2]/(d.runtime.length/12)];
    assert.ok(design[0]>=rowingHullWidth('oseberg',design[2],design[1]),`shaft leaves the hull at t=${t}`);
  }
  assert.ok(Math.abs(pose.bladeAlong[0]*(pose.shaftB[1]-pivot[1])-pose.bladeAlong[1]*(pose.shaftB[0]-pivot[0]))<1e-9,'blade lies in line with the shaft');
  assert.ok(pose.bladeCorners.every(c=>c[1]<0),'blade is fully under water at rest');
});

test('her siblings keep their hulls: no rail sweep leaks into their geometry or shaders',()=>{
  const lusoria=ROWING_DESIGNS.lusoria,canoe=ROWING_DESIGNS['taino-canoe'];
  assert.equal(lusoria.profile.railRise,undefined);assert.equal(canoe.profile.railRise,undefined);
  assert.equal(lusoria.steering.hangsFromPivot,false);assert.equal(canoe.steering.hangsFromPivot,false);
  assert.doesNotMatch(hullLoftWGSL(lusoria.profile,'test'),/Rise/);assert.match(hullLoftWGSL(d.profile,'test'),/testRise/);
  for(const [id,draft,freeboard,floor,seat,keel] of [['lusoria',.38,.55,.07,.42,null],['taino-canoe',.42,.42,-.06,.29,null]]){
    const f=ROWING_DESIGNS[id],s=f.frame.verticalScale,h=boatHydrodynamics(f.runtime.length,f.runtime.beam,undefined,0,id);
    assert.ok(Math.abs(h.draft-draft)<1e-6&&Math.abs(h.freeboard-freeboard)<1e-6);
    assert.ok(Math.abs(f.floorHeight*s-floor)<1e-9&&Math.abs(f.seatHeight*s-seat)<1e-9);
    assert.equal(f.keel,keel);assert.equal(f.stayEnd,5.2);
    assert.ok(Math.abs(f.profile.bowRake-(id==='lusoria'?.15:.35))<1e-12);
  }
});

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
import {readFileSync} from 'node:fs';
import {createCompany,stepCompany} from '../js/crew.js';
import {poseCrewWork} from '../js/crew-pose.js';
import {loadCrewGLB} from '../js/gltf.js';
import {requirePlayableShipModel} from '../js/ship-models.js';

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
  for(let t=0;t<=1;t+=.05){
    const p=pivot.map((v,i)=>v+(pose.shaftB[i]-v)*t),design=[p[0]/sx,p[1]/sy,p[2]/(d.runtime.length/12)];
    assert.ok(design[0]>=rowingHullWidth('oseberg',design[2],design[1]),`shaft leaves the hull at t=${t}`);
  }
  assert.ok(Math.abs(pose.bladeAlong[0]*(pose.shaftB[1]-pivot[1])-pose.bladeAlong[1]*(pose.shaftB[0]-pivot[0]))<1e-9,'blade lies in line with the shaft');
  assert.ok(pose.bladeCorners.every(c=>c[1]<0),'blade is fully under water at rest');
});

test('her flared ends leave room: no seated crew member pokes through the hull',()=>{
  const meshes=Object.fromEntries(['male','female'].map(sex=>[sex,loadCrewGLB(readFileSync(new URL('../assets/crew/'+(sex==='female'?'sailor-female.glb':'sailor.glb'),import.meta.url)))]));
  const model=requirePlayableShipModel('oseberg'),boat={modelId:'oseberg',model,...model.runtime,heading:0,heave:0,pitch:0,roll:0,rollVelocity:0,rudder:0,sailFore:1,sailMain:1,sailMizzen:1,crew:false,showProw:true,hatchesClosed:0};
  const company=createCompany(undefined,'oseberg'),sz=boat.length/12,through=[];
  boat.rowingState={phase:0,rate:.45,effortPort:.6,effortStarboard:.6,cadence:.45};
  for(const [phase,rudder] of [[0,0],[.22,0],[.44,0],[.75,0],[.3,25],[.3,-25]]){
    boat.rowingState.phase=phase;boat.rudder=rudder;stepCompany(company,boat,0,2);
    for(const s of company.crew){
      const mesh=meshes[s.sex],a=mesh.animator;a.sample('Idle',s.time);poseCrewWork(a,s,boat);
      const f=new Float32Array(mesh.vertices.buffer,mesh.vertices.byteOffset,mesh.vertices.byteLength/4),u=new Uint16Array(mesh.vertices.buffer,mesh.vertices.byteOffset,mesh.vertices.byteLength/2);
      for(let i=0;i<mesh.vertices.byteLength/60;i++){
        const local=[0,0,0];
        for(let k=0;k<4;k++){const at=u[i*30+18+k]*16,w=f[i*15+11+k];for(let c=0;c<3;c++)local[c]+=w*(a.palette[at+c]*f[i*15]+a.palette[at+4+c]*f[i*15+1]+a.palette[at+8+c]*f[i*15+2]+a.palette[at+12+c]);}
        const p=[0,1,2].map(c=>s.transform[c]*local[0]+s.transform[c+4]*local[1]+s.transform[c+8]*local[2]+s.transform[c+12]);
        const y=p[1]/sy,z=p[2]/sz;if(Math.abs(z)>6||y>rowingHullDeck('oseberg',z))continue;
        const out=Math.abs(p[0])-rowingHullWidth('oseberg',z,y)*sx;
        if(out>.005)through.push({sailor:s.id,phase,rudder,out});
      }
    }
  }
  assert.deepEqual(through.slice(0,8),[],through.length+' crew vertices stand outside her hull');
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

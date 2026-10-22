// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// Proposed source/data checks; these do not establish playable readiness,
// historical offsets, calibrated displacement, cloth clearance or render parity.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {LATER_SAIL_DESIGNS,laterSailDesign,laterSailHullWidth,laterSailHullDeck,laterSailDeck,laterSailDeckWidth,laterSailKeelHalfWidth} from '../js/models/later-sail.js';
import {hullLoftBottom} from '../js/hull-loft.js';

const close=(a,b,t=1e-9)=>assert.ok(Math.abs(a-b)<t,`${a} != ${b}`);
const ft=.3048,lb=.45359237;
const finiteXYZ=p=>Array.isArray(p)&&p.length===3&&p.every(Number.isFinite);
const area=(d,s)=>{
  const k=[d.runtime.beam/d.frame.beam,d.frame.verticalScale,d.runtime.length/d.frame.length],p=s.corners.map(p=>p.map((v,i)=>v*k[i]));
  const tri=(a,b,c)=>{const x=b.map((v,i)=>v-a[i]),y=c.map((v,i)=>v-a[i]);return Math.hypot(x[1]*y[2]-x[2]*y[1],x[2]*y[0]-x[0]*y[2],x[0]*y[1]-x[1]*y[0])*.5;};
  return tri(...p.slice(0,3))+(p.length===4?tri(p[0],p[2],p[3]):0);
};

test('later sailing definitions remain planned and preserve distinct reported dimensions and mass conventions',()=>{
  const c=laterSailDesign('flying-cloud'),g=laterSailDesign('gipsy-moth-iv');
  assert.ok(Object.isFrozen(LATER_SAIL_DESIGNS)&&Object.isFrozen(c.surfaces)&&Object.isFrozen(g.keel.sections));
  assert.equal(c.status,'planned');assert.equal(g.status,'planned');assert.equal(c.modelCode,7);assert.equal(g.modelCode,8);
  close(c.runtime.length,225*ft);close(c.runtime.beam,41*ft);close(g.runtime.length,53.1*ft);close(g.runtime.beam,10.5*ft);
  const contemporary=c.references.find(r=>r.subject==='contemporary-report-transcription'),museum=c.references.find(r=>r.subject==='museum-print-inscription-and-notes');
  assert.equal(contemporary.selected,true);assert.equal(contemporary.dimensions.find(d=>d.kind==='hold-depth-not-draft').value,21.5);assert.equal(contemporary.draft,null);assert.equal(contemporary.displacement,null);
  assert.equal(museum.dimensions[0].value,40);assert.equal(museum.selected,false);assert.deepEqual(museum.tonnageReports.map(t=>t.value),[1139,1782]);
  assert.equal(c.loading.referenceDisplacementKg,null);assert.equal(c.loading.ballastKg,null);assert.equal(c.loading.permanentMassKg,null);
  const archive=g.references.find(r=>r.subject==='attributed-builder-archive-notes');
  close(archive.displacement.kg,23320*lb);close(archive.ballast.kg,8490*lb);assert.equal(archive.tonnage.kind,'tonnage-not-mass');
  assert.equal(g.references.find(r=>r.subject==='restored-1966-2005-broker-specification').selected,false);
  assert.match(g.keel.configuration,/no Sydney/);assert.equal(g.loading.permanentMassKg,null);
  assert.throws(()=>laterSailDesign('schooner'),/No later sailing design/);
});

test('Flying Cloud has fifteen separate square tiers with reported yards, its own finer bow, and no inherited batteries',()=>{
  const d=laterSailDesign('flying-cloud'),squares=d.surfaces.filter(s=>s.kind==='square');
  assert.equal(d.masts.length,3);assert.equal(squares.length,15);assert.equal(new Set(d.surfaces.map(s=>s.id)).size,d.surfaces.length);
  const yardLengths=[[70,55,44.5,32,22],[82,64,50,37,24],[56,45,33,25,20]];
  for(let mast=0;mast<3;mast++){
    const surfaces=squares.filter(s=>s.mast===mast);assert.deepEqual(surfaces.map(s=>s.name.split('-').at(-1)),['course','topsail','topgallant','royal','skysail']);
    assert.deepEqual(surfaces.map(s=>s.provenance.yardLengthFt),yardLengths[mast]);
    for(let i=0;i<surfaces.length;i++){
      const s=surfaces[i];assert.equal(s.controlGroup,d.masts[mast].controlGroup);assert.equal(s.corners.length,4);assert.ok(s.corners[0][0]<0&&s.corners[1][0]>0);
      assert.ok(s.corners[0][1]>s.corners[3][1]);if(i)assert.ok(s.corners[3][1]>surfaces[i-1].corners[0][1]);
      assert.ok(area(d,s)>0);assert.equal(s.spars[0].kind,'yard');
    }
  }
  assert.ok(d.surfaces.some(s=>s.kind==='headsail'));assert.ok(d.surfaces.some(s=>s.name==='mizzen-spanker'&&s.kind==='gaff'));
  assert.equal(d.equipment.guns.length,0);assert.equal(d.keel.kind,'structural-timber');
  close((d.keel.bounds[1]-d.keel.bounds[0])*d.frame.verticalScale,208*ft);
  assert.ok(laterSailHullWidth(d.id,-4.2,0)<laterSailHullWidth(d.id,4.2,0),'the bow is finer than the fuller run aft');
  assert.ok(laterSailHullWidth(d.id,-5.7,0)<laterSailHullWidth(d.id,-4.2,0));
  assert.notDeepEqual(d.profile.sections,laterSailDesign('gipsy-moth-iv').profile.sections);
});

test('Gipsy Moth is a genuine two-mast Bermudan ketch with independent boom spars and headsail controls',()=>{
  const d=laterSailDesign('gipsy-moth-iv');assert.deepEqual(d.masts.map(m=>m.id),['main','mizzen']);assert.equal(d.masts.length,2);
  assert.deepEqual(d.surfaces.filter(s=>s.kind==='bermudan').map(s=>s.controlGroup),['main','mizzen']);
  assert.equal(d.surfaces.some(s=>s.kind==='gaff'||s.kind==='square'),false);assert.equal(d.bowsprit,null);
  for(const s of d.surfaces){
    assert.ok(s.mast<2);assert.equal(s.corners.length,3);assert.ok(s.corners.every(finiteXYZ));assert.ok(area(d,s)>0);
    if(s.kind==='bermudan'){
      assert.equal(s.rotationAxis,'luff');assert.equal(s.spars.length,1);assert.equal(s.spars[0].kind,'boom');assert.deepEqual(s.spars[0].a,s.corners[0]);assert.deepEqual(s.spars[0].b,s.corners[2]);
      close(s.corners[0][1],s.corners[2][1]);assert.ok(s.corners[2][2]>s.corners[0][2]);
    }else assert.equal(s.controlGroup,'fore');
  }
  assert.equal(d.surfaces[0].mast,0);assert.equal(d.surfaces[0].controlGroup,'main','physical mast index must not select the fore control slot');
  assert.deepEqual(Object.keys(d.crewStations),['ines']);assert.equal(d.loading.crew,1);assert.equal(d.equipment.guns.length,0);assert.equal(d.equipment.engine.enabled,false);
});

test('profiled lead fin has actual changing fore/aft sections, joins the hull, and does not extrude along the whole ship',()=>{
  const id='gipsy-moth-iv',d=laterSailDesign(id),k=d.keel,sy=d.frame.verticalScale;
  assert.equal(k.kind,'profiled-ballast-fin');assert.ok(k.sections.length>=4);close(-k.sections[0].y*sy,7.75*ft);
  close(k.ballast.massKg,8490*lb);assert.equal(k.ballast.positionKind,'authored');
  assert.ok(new Set(k.sections.map(s=>s.zFore)).size>2&&new Set(k.sections.map(s=>s.zAft)).size>2);
  for(const s of k.sections){
    assert.ok(s.zFore<s.zAft&&s.halfWidth>0);assert.equal(laterSailKeelHalfWidth(id,s.zFore-.1,s.y),0);assert.equal(laterSailKeelHalfWidth(id,s.zAft+.1,s.y),0);
    assert.ok(laterSailKeelHalfWidth(id,s.zFore+(s.zAft-s.zFore)*.30,s.y)>0);
  }
  assert.equal(laterSailKeelHalfWidth(id,-5,-1),0);assert.equal(laterSailKeelHalfWidth(id,5,-1),0);
  assert.equal(laterSailKeelHalfWidth(id,0,k.sections[0].y-.01),0);
  const root=k.sections.at(-1),z=(root.zFore+root.zAft)*.5;
  assert.ok(laterSailHullWidth(id,z,root.y)>laterSailKeelHalfWidth(id,z,root.y),'the root overlaps the hull rather than hanging from a gap');
  assert.ok(root.y>hullLoftBottom(d.profile,z));
});

test('cockpit is a recessed local deck, side walkways remain above it, and later data queries stay finite',()=>{
  const g=laterSailDesign('gipsy-moth-iv'),z=3.8;
  assert.ok(laterSailDeck(g.id,z,0)<laterSailDeck(g.id,z,1));close((laterSailDeck(g.id,z,1)-laterSailDeck(g.id,z,0))*g.frame.verticalScale,.82-.29);
  assert.ok(laterSailDeckWidth(g.id,z)>g.cockpit.halfWidth);assert.ok(g.steering.handle[1]>laterSailDeck(g.id,z,0));
  for(const d of Object.values(LATER_SAIL_DESIGNS))for(const station of [-5,-3,0,3,5]){
    assert.ok(Number.isFinite(laterSailHullDeck(d.id,station)));assert.ok(Number.isFinite(laterSailDeck(d.id,station)));assert.ok(laterSailDeckWidth(d.id,station)>=0);
    for(const y of [d.profile.levels[0],-.2,0,.3])assert.ok(Number.isFinite(laterSailHullWidth(d.id,station,y))&&laterSailHullWidth(d.id,station,y)>=0);
  }
});

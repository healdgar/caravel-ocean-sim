// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
import assert from 'node:assert/strict';
import {test} from 'node:test';
import {ADDITIONAL_DESIGNS,additionalHullWidth,additionalDeck} from '../js/models/additional.js';
import {hullLoftBottom} from '../js/hull-loft.js';
import {hullHydrostatics,boatHydrodynamics,boatEyePosition,boatRotate,stepBoatSurge,
  DEFAULT_PROVISION_DAYS,SEAWATER_DENSITY,ADDITIONAL_LOAD_PLACEMENT} from '../js/boat.js';
import {createHullLateralDescriptor,evaluateHullLateral} from '../js/hull-lateral.js';
import {NINA_DESIGN} from '../js/models/nina.js';
import {VICTORY_DESIGN} from '../js/models/victory.js';

const near=(a,b,tolerance=1e-9)=>assert.ok(Math.abs(a-b)<=tolerance*Math.max(1,Math.abs(a),Math.abs(b)),`${a} != ${b}`);
const designs=Object.values(ADDITIONAL_DESIGNS);

// Independent midpoint integration of the actual solid, without the runtime
// hydro table, its trapezoid recurrence, its y spacing or waterline interpolation.
function integrateSolid(d,waterline){
  const {profile:p,keel:k,frame:f,runtime:r}=d,sx=r.beam/f.beam,sy=f.verticalScale,sz=r.length/f.length;
  const lo=p.levels[0]-k.depth,hi=waterline/sy,nz=256,ny=384,dz=(p.stations.at(-1)-p.stations[0])/nz,dy=(hi-lo)/ny;
  let volume=0,yMoment=0,area=0,planeMoment=0,longMoment=0,zMoment=0;
  const width=(z,y)=>{
    const bottom=hullLoftBottom(p,z),keel=z>=k.bounds[0]&&z<=k.bounds[1]&&y>=bottom-k.depth&&y<bottom?k.width*.5:0;
    return Math.max(additionalHullWidth(d.id,z,y),keel);
  };
  for(let i=0;i<nz;i++){
    const z=p.stations[0]+(i+.5)*dz,w=width(z,hi);
    area+=2*w*dz;planeMoment+=2/3*w**3*dz;longMoment+=2*w*z*z*dz;zMoment+=2*w*z*dz;
    for(let j=0;j<ny;j++){
      const y=lo+(j+.5)*dy,dv=2*width(z,y)*dz*dy;volume+=dv;yMoment+=dv*y;
    }
  }
  return {volume:volume*sx*sy*sz,centreOfBuoyancy:(-p.levels[0]+yMoment/volume)*sy,
    waterplaneArea:area*sx*sz,waterplaneMoment:planeMoment*sx**3*sz,
    longitudinalMoment:(longMoment-zMoment*zMoment/area)*sx*sz**3};
}

test('additional hulls integrate their own offsets and actual keel, independently of Niña and Victory',()=>{
  for(const d of designs)for(const level of [-.2,0,.35]){
    const expected=integrateSolid(d,level),actual=hullHydrostatics(d.runtime.length,d.runtime.beam,level,d.id);
    for(const key of Object.keys(expected))near(actual[key],expected[key],key==='longitudinalMoment'?.008:.006);
    near(actual.mass,actual.volume*SEAWATER_DENSITY);
    assert.ok(actual.volume>0&&actual.waterplaneArea>0);
  }
  for(const d of designs){
    const own=hullHydrostatics(d.runtime.length,d.runtime.beam,0,d.id);
    for(const legacy of ['nina','victory']){
      const other=hullHydrostatics(d.runtime.length,d.runtime.beam,0,legacy);
      assert.ok(Math.abs(own.volume-other.volume)>own.volume*.02,`${d.id} must not borrow ${legacy}'s underwater shape`);
    }
  }
});

test('new hull scale follows its own design frame and preserves dimensional powers',()=>{
  for(const d of designs){
    const {length:L,beam:B}=d.runtime,a=hullHydrostatics(L,B,0,d.id),long=hullHydrostatics(2*L,B,0,d.id),wide=hullHydrostatics(L,2*B,0,d.id);
    near(long.volume,2*a.volume);near(wide.volume,2*a.volume);
    near(long.waterplaneArea,2*a.waterplaneArea);near(wide.waterplaneArea,2*a.waterplaneArea);
    near(long.longitudinalMoment,8*a.longitudinalMoment);near(wide.waterplaneMoment,8*a.waterplaneMoment);
    near(long.centreOfBuoyancy,a.centreOfBuoyancy);near(wide.centreOfBuoyancy,a.centreOfBuoyancy);
  }
});

test('own standard manifests are included once and settle at the declared service waterline',()=>{
  for(const d of designs){
    const {length,beam}=d.runtime,M=d.loading,h=boatHydrodynamics(length,beam,DEFAULT_PROVISION_DAYS,0,d.id),base=hullHydrostatics(length,beam,0,d.id);
    assert.equal(h.modelCode,d.modelCode);assert.equal(h.crewMass,M.crew*M.personKg);
    assert.equal(h.waterMass,M.crew*M.waterKgPerDay*DEFAULT_PROVISION_DAYS);
    assert.equal(h.foodMass,M.crew*M.foodKgPerDay*DEFAULT_PROVISION_DAYS);assert.equal(h.storesMass,M.casksKg+M.sparesKg);
    assert.equal(h.loadMass,h.crewMass+h.waterMass+h.foodMass+h.storesMass);assert.equal(h.mass,h.fixedMass+h.loadMass);
    near(h.mass,base.mass);near(h.mass,h.volume*SEAWATER_DENSITY,1e-7);near(h.sinkage,0,1e-7);
    near(h.metacentricHeight,beam*M.gmBeamFraction,1e-7);
    near(h.datumDraft,-d.profile.levels[0]*d.frame.verticalScale);
    near(h.draft-h.datumDraft,d.keel.depth*d.frame.verticalScale,1e-7);
    const sourceDraft=d.id==='pinta'?2.286:1.95;near(h.draft,sourceDraft,1e-7);
    assert.equal(h.overloadKg,0);assert.ok(Object.values(h).every(Number.isFinite));
    assert.equal(h.fixedMass>0,true);assert.ok(h.rollInertia>0&&h.pitchInertia>0&&h.rollDamping>0&&h.pitchDamping>0);
  }
  assert.equal(ADDITIONAL_DESIGNS.pinta.loading.crew,30);assert.equal(ADDITIONAL_DESIGNS['santa-maria'].loading.crew,40);
});

test('provisions and low cargo change Archimedean loading, CG and inertia without converting reported tonnage to mass',()=>{
  for(const d of designs){
    const {length,beam}=d.runtime,M=d.loading,base=boatHydrodynamics(length,beam,60,0,d.id),empty=boatHydrodynamics(length,beam,0,0,d.id),laden=boatHydrodynamics(length,beam,60,15,d.id);
    near(base.mass-empty.mass,M.crew*60*(M.waterKgPerDay+M.foodKgPerDay));near(laden.mass-base.mass,15000);
    assert.ok(empty.sinkage<base.sinkage&&base.sinkage<laden.sinkage);assert.ok(laden.drag>base.drag&&laden.rollInertia>base.rollInertia);
    assert.ok(laden.centreOfGravity<base.centreOfGravity,'secured cargo remains low in the hold');
    const cargoKG=ADDITIONAL_LOAD_PLACEMENT.storesAboveBottom*d.frame.verticalScale;
    near(laden.centreOfGravity,(base.mass*base.centreOfGravity+15000*cargoKG)/laden.mass);
    for(const h of [empty,base,laden]){
      near(h.mass,hullHydrostatics(length,beam,h.sinkage,d.id).mass,1e-7);assert.equal(h.overloadKg,0);
      near(h.draft+h.freeboard,base.draft+base.freeboard);assert.ok(h.metacentricHeight>0);
    }
    // A geometrically computed mass may coincidentally resemble a reported
    // tonnage. Independence is established against a separate solid-volume
    // integral, not by requiring an arbitrary difference from that number.
    near(base.mass,integrateSolid(d,0).volume*SEAWATER_DENSITY,.006);
    assert.ok(d.references[0].tonnage.kind,'reported tonnage retains its meaning');
    const small=boatHydrodynamics(3,.8,120,40,d.id);
    assert.ok(small.overloadKg>0&&small.freeboard>=.15-1e-7);assert.equal(small.cargoMass,40000);
    assert.equal(small.mass,small.fixedMass+small.loadMass);assert.ok(Object.values(small).every(Number.isFinite));
  }
});

test('additional timber keels retain their own exposed bounds, side area, datum and passive response',()=>{
  for(const d of designs){
    const descriptor=createHullLateralDescriptor({modelId:d.id,...d.runtime}),keel=descriptor.components.find(c=>c.kind==='exposed-keel'),sy=d.frame.verticalScale,sz=d.runtime.length/d.frame.length;
    assert.ok(keel&&descriptor.components.some(c=>c.kind==='projected-hull'));assert.match(keel.provenance,/own loft bottom/);
    near(keel.area,(d.keel.bounds[1]-d.keel.bounds[0])*sz*d.keel.depth*sy);near(keel.span,d.keel.depth*sy);
    for(const strip of keel.strips){
      const z=strip.z/sz,bottom=hullLoftBottom(d.profile,z)*sy;
      near(strip.y,bottom-d.keel.depth*sy*.5);near(strip.depth,d.keel.depth*sy);
    }
    const rested=evaluateHullLateral({},descriptor,{});assert.ok(Object.values(rested).every(x=>x===0));
    for(const surge of [-4,0,4]){
      const force=evaluateHullLateral({},descriptor,{surge,sway:.4,yawRate:.03,rollRate:-.04,roll:.08,pitch:.05,cgY:1});
      assert.ok(force.power<0&&force.dissipation>0);near(force.power,-force.dissipation,1e-9);
    }
  }
});

test('captain eye follows each additional helm and occupied deck instead of a Niña anchor',()=>{
  for(const d of designs){
    const boat={modelId:d.id,...d.runtime,x:10,z:-20,heave:.6,heading:0,pitch:0,roll:0,eye:0,eyeSide:1};
    const expected=[d.helm.x*boat.beam/d.frame.beam,additionalDeck(d.id,d.helm.z)*d.frame.verticalScale+d.helm.eyeAboveDeck,d.helm.z*boat.length/d.frame.length];
    const out=boatEyePosition(new Float64Array(3),boat);
    for(let i=0;i<3;i++)near(out[i],expected[i]+[boat.x,boat.heave,boat.z][i]);
    boat.heading=70;boat.pitch=.1;boat.roll=-.2;boat.eyeSide=-1;
    const rotated=new Float64Array(3);boatRotate(rotated,-expected[0],expected[1],expected[2],boat.heading*Math.PI/180,boat.pitch,boat.roll);
    boatEyePosition(out,boat);for(let i=0;i<3;i++)near(out[i],rotated[i]+[boat.x,boat.heave,boat.z][i]);
  }
});

test('physical queries are explicit, reject unsupported IDs and invalid dimensions, and retain legacy scalar contracts',()=>{
  for(const d of designs){
    const status=d.status;boatHydrodynamics(d.runtime.length,d.runtime.beam,60,0,d.id);assert.equal(d.status,status,'physics cannot promote a planned model to playable');
    for(const [length,beam,waterline] of [[0,6,0],[20,-1,0],[Infinity,6,0],[20,6,NaN]])
      assert.throws(()=>hullHydrostatics(length,beam,waterline,d.id),/Invalid additional hull/);
  }
  for(const id of ['missing','toString','__proto__']){
    assert.throws(()=>hullHydrostatics(20,6,0,id),/No hydrostatic hull geometry/);
    assert.throws(()=>boatHydrodynamics(20,6,60,0,id),/No hydrostatic hull geometry/);
    assert.throws(()=>stepBoatSurge({modelId:id},0,.01),/No hydrostatic hull geometry/);
    assert.throws(()=>createHullLateralDescriptor({modelId:id,length:20,beam:6}),/No lateral hull geometry/);
    assert.throws(()=>boatEyePosition(new Float64Array(3),{modelId:id}),/No hydrostatic hull geometry/);
  }
  for(const [id,d] of [['nina',NINA_DESIGN],['victory',VICTORY_DESIGN]]){
    const h=boatHydrodynamics(d.runtime.length,d.runtime.beam,60,0,id);
    assert.equal(Object.hasOwn(h,'datumDraft'),false,'legacy hydro objects retain exactly their existing scalar shape');
    assert.equal(h.modelCode,id==='victory'?1:0);assert.ok(h.mass>0);
  }
});

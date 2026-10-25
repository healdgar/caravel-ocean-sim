import { HELM_EYE_X, HELM_EYE_Z, HULL_DRAFT, HULL_VERTICAL_SCALE, hullDeck, hullHalfWidth, hullScale, vesselVerticalScale, vesselDraft } from './hull.js';
import {VICTORY_DESIGN,victoryHullHalfWidth,victoryHullDeck} from './models/victory.js';
import {PROCEDURAL_DESIGNS,proceduralHullWidth,proceduralHullDeck,proceduralDeck,proceduralKeelHalfWidth,proceduralProvisionDays} from './models/procedural.js';
import {ROWING_DESIGNS} from './models/rowing.js';
import {advanceRowing,rowingForces} from './rowing.js';
import {hullLoftSheer,hullLoftPoint} from './hull-loft.js';
import { advanceSails, sailForces } from './sailing.js';
import {createHullLateralDescriptor,evaluateHullLateral} from './hull-lateral.js';

export const KNOT_TO_MPS = 0.514444;
export const DEFAULT_PROVISION_DAYS = 60;
export const SEAWATER_DENSITY = 1025;
const boatNoRowingWater=()=>null;
// Authored departure manifest for the twelve-person company. The existing
// design waterline calibrates vessel + permanent ballast mass, not empty wood.
// Quantities are gameplay assumptions, not a recovered historical inventory.
export const BOAT_MANIFEST = Object.freeze({crew:12,personKg:80,waterKgPerDay:5,foodKgPerDay:1.5,casksKg:800,sparesKg:1500});
// Integrate the canonical hull once. At runtime loading only interpolates this
// table; it never adds ocean samples, meshes or GPU work. y is in design units.
const HYDRO_STEP = .005;
const HYDRO_DECK = hullDeck(0);
const HULL_HYDRO = (()=>{
  const rows=[];let volume=0,moment=0,previousArea=0,previousMoment=0;
  for(let j=0;j<=Math.round((HULL_DRAFT+HYDRO_DECK)/HYDRO_STEP);j++){
    const y=-HULL_DRAFT+j*HYDRO_STEP;let area=0,waterplaneMoment=0,longitudinalMoment=0,areaZ=0;
    for(let i=0;i<192;i++){
      const z=-6.4+(i+.5)*12/192,width=hullHalfWidth(z,y);
      area+=2*width*12/192;waterplaneMoment+=2/3*width**3*12/192;
      longitudinalMoment+=2*width*z*z*12/192;areaZ+=2*width*z*12/192;
    }
    if(j){volume+=(previousArea+area)*.5*HYDRO_STEP;moment+=(previousMoment+area*y)*.5*HYDRO_STEP;}
    rows.push({volume,moment,area,waterplaneMoment,longitudinalMoment:longitudinalMoment-areaZ*areaZ/Math.max(area,1e-9)});previousArea=area;previousMoment=area*y;
  }
  return rows;
})();
const VICTORY_HYDRO=(()=>{
  const rows=[];let volume=0,moment=0,previousArea=0,previousMoment=0;
  const draft=VICTORY_DESIGN.hull.draft;
  for(let j=0;j<=Math.ceil((draft+VICTORY_DESIGN.decks.main)/HYDRO_STEP);j++){
    const y=-draft+j*HYDRO_STEP;let area=0,waterplaneMoment=0,longitudinalMoment=0,areaZ=0;
    for(let i=0;i<192;i++){
      const z=-6+(i+.5)*12/192,w=victoryHullHalfWidth(z,y);
      area+=2*w*12/192;waterplaneMoment+=2/3*w**3*12/192;longitudinalMoment+=2*w*z*z*12/192;areaZ+=2*w*z*12/192;
    }
    if(j){volume+=(previousArea+area)*.5*HYDRO_STEP;moment+=(previousMoment+area*y)*.5*HYDRO_STEP;}
    rows.push({volume,moment,area,waterplaneMoment,longitudinalMoment:longitudinalMoment-areaZ*areaZ/Math.max(area,1e-9)});
    previousArea=area;previousMoment=area*y;
  }return rows;
})();
// Additional authored profiles have their own lazy table and manifest. Geometry
// queries are permitted before the separate playable-registry clearance gate.
const ADDITIONAL_HYDRO=new Map();
const additionalHydroDesign=id=>Object.hasOwn(PROCEDURAL_DESIGNS,id)?PROCEDURAL_DESIGNS[id]:null;
function hydroModelCode(id){
  if(id==='nina')return 0;if(id==='victory')return 1;
  const d=additionalHydroDesign(id);if(!d)throw Error('No hydrostatic hull geometry for '+id);
  if(!Number.isInteger(d.modelCode)||d.modelCode<2)throw Error('Invalid hydrostatic model code for '+id);
  return d.modelCode;
}
function additionalSheerMinimum(profile,bounds){
  const a=profile.sheerFore??0,b=profile.sheerAft??0,start=profile.stations[0],span=profile.stations.at(-1)-start;
  let minimum=Math.min(hullLoftSheer(profile,bounds[0]),hullLoftSheer(profile,bounds[1]));
  const A=Math.cbrt(a),B=Math.cbrt(b),t=A+B?A/(A+B):.5,z=start+span*t;
  if(z>bounds[0]&&z<bounds[1])minimum=Math.min(minimum,hullLoftSheer(profile,z));
  return minimum;
}
function additionalHydroTable(id){
  let table=ADDITIONAL_HYDRO.get(id);if(table)return table;
  const design=additionalHydroDesign(id);if(!design)throw Error('No hydrostatic hull geometry for '+id);
  const p=design.profile,k=design.keel,bounds=[p.stations[0],p.stations.at(-1)],bottom=p.levels[0];
  const minimumBody=bottom+additionalSheerMinimum(p,bounds);
  const minimumKeel=k?.kind==='profiled-ballast-fin'?k.sections[0].y:k?bottom+additionalSheerMinimum(p,k.bounds)-k.depth:minimumBody;
  const lower=k?.kind==='profiled-ballast-fin'?Math.min(minimumBody,minimumKeel):Math.min(bottom-(k?.depth??0),minimumBody,minimumKeel),deck=p.deck+additionalSheerMinimum(p,bounds);
  const rows=[],n=192,dz=(bounds[1]-bounds[0])/n;let volume=0,moment=0,previousArea=0,previousMoment=0;
  for(let j=0;j<=Math.ceil((deck-lower)/HYDRO_STEP);j++){
    const y=lower+j*HYDRO_STEP;let area=0,waterplaneMoment=0,longitudinalMoment=0,areaZ=0;
    for(let i=0;i<n;i++){
      const z=bounds[0]+(i+.5)*dz,bodyBottom=bottom+hullLoftSheer(p,z);
      const keel=k?.kind==='profiled-ballast-fin'?proceduralKeelHalfWidth(id,z,y):k&&z>=k.bounds[0]&&z<=k.bounds[1]&&y>=bodyBottom-k.depth&&y<bodyBottom?k.width*.5:0;
      const w=Math.max(keel,proceduralHullWidth(id,z,y));
      area+=2*w*dz;waterplaneMoment+=2/3*w**3*dz;longitudinalMoment+=2*w*z*z*dz;areaZ+=2*w*z*dz;
    }
    if(j){volume+=(previousArea+area)*.5*HYDRO_STEP;moment+=(previousMoment+area*y)*.5*HYDRO_STEP;}
    rows.push({volume,moment,area,waterplaneMoment,longitudinalMoment:longitudinalMoment-areaZ*areaZ/Math.max(area,1e-9)});
    previousArea=area;previousMoment=area*y;
  }
  table={design,rows,lower,deck,datumDraft:-bottom,physicalDraft:-Math.min(minimumBody,minimumKeel)};
  ADDITIONAL_HYDRO.set(id,table);return table;
}
function additionalHydrostatics(length,beam,waterline,id){
  if(!Number.isFinite(length)||!(length>0)||!Number.isFinite(beam)||!(beam>0)||!Number.isFinite(waterline))throw Error('Invalid additional hull dimensions or waterline');
  const table=additionalHydroTable(id),f=table.design.frame,sx=beam/f.beam,sy=f.verticalScale,sz=length/f.length;
  const at=Math.max(0,Math.min(table.rows.length-1,(waterline/sy-table.lower)/HYDRO_STEP));
  const i=Math.min(table.rows.length-2,Math.floor(at)),t=at-i,a=table.rows[i],b=table.rows[i+1];
  const mix=key=>a[key]+(b[key]-a[key])*t,volume=mix('volume')*sx*sy*sz;
  return {volume,mass:volume*SEAWATER_DENSITY,waterplaneArea:mix('area')*sx*sz,
    centreOfBuoyancy:volume>0?table.datumDraft*sy+mix('moment')*sx*sy*sy*sz/volume:0,
    waterplaneMoment:mix('waterplaneMoment')*sx**3*sz,longitudinalMoment:mix('longitudinalMoment')*sx*sz**3};
}
export function hullHydrostatics(length,beam,waterline=0,modelId='nina'){
  if(additionalHydroDesign(modelId))return additionalHydrostatics(length,beam,waterline,modelId);
  if(modelId!=='nina'&&modelId!=='victory')throw Error('No hydrostatic hull geometry for '+modelId);
  const victory=modelId==='victory',rows=victory?VICTORY_HYDRO:HULL_HYDRO,draft=victory?VICTORY_DESIGN.hull.draft:HULL_DRAFT;
  const [sx,,sz]=hullScale(length,beam),sy=victory?VICTORY_DESIGN.frame.verticalScale:HULL_VERTICAL_SCALE,at=Math.max(0,Math.min(rows.length-1,(waterline/sy+draft)/HYDRO_STEP));
  const i=Math.min(rows.length-2,Math.floor(at)),t=at-i,a=rows[i],b=rows[i+1];
  const mix=key=>a[key]+(b[key]-a[key])*t,volume=mix('volume')*sx*sy*sz;
  return {volume,mass:volume*SEAWATER_DENSITY,waterplaneArea:mix('area')*sx*sz,
    centreOfBuoyancy:volume>0?draft*sy+mix('moment')*sx*sy*sy*sz/volume:0,
    waterplaneMoment:mix('waterplaneMoment')*sx**3*sz,longitudinalMoment:mix('longitudinalMoment')*sx*sz**3};
}
const provisionSetting=value=>Number.isFinite(value)?Math.max(0,Math.min(120,value)):DEFAULT_PROVISION_DAYS;
const cargoSetting=value=>Number.isFinite(value)?Math.max(0,Math.min(40,value)):0;

export function boatHydrodynamics(length, beam, provisionDays, cargoTonnes=0,modelId='nina') {
  if(additionalHydroDesign(modelId))return additionalBoatHydrodynamics(length,beam,provisionDays,cargoTonnes,modelId);
  provisionDays??=DEFAULT_PROVISION_DAYS;
  provisionDays=provisionSetting(provisionDays);cargoTonnes=cargoSetting(cargoTonnes);
  const victory=modelId==='victory',base=hullHydrostatics(length,beam,0,modelId),sy=victory?VICTORY_DESIGN.frame.verticalScale:HULL_VERTICAL_SCALE;
  const M=victory?{...BOAT_MANIFEST,crew:820,casksKg:40000,sparesKg:60000}:BOAT_MANIFEST;
  const designDraft=victory?VICTORY_DESIGN.hull.draft:HULL_DRAFT,deck=victory?victoryHullDeck(0):HYDRO_DECK;
  const crewMass=M.crew*M.personKg,waterMass=M.crew*M.waterKgPerDay*provisionDays;
  const foodMass=M.crew*M.foodKgPerDay*provisionDays,storesMass=M.casksKg+M.sparesKg,cargoMass=cargoTonnes*1000;
  const loadMass=crewMass+waterMass+foodMass+storesMass+cargoMass;
  // Victory's authored service waterline includes the standard service manifest.
  // Integrate its own offsets; builders' tonnage never becomes kilograms.
  const standardLoad=M.crew*(M.personKg+(M.waterKgPerDay+M.foodKgPerDay)*DEFAULT_PROVISION_DAYS)+M.casksKg+M.sparesKg;
  const fixedMass=Math.max(base.mass*.3,base.mass-(victory?standardLoad:0)),mass=fixedMass+loadMass;
  // Preserve at least 15 cm to the lowest deck. Unsupported configurations are
  // explicitly reported as overloaded; this remains a non-flooding model.
  let low=victory?-designDraft*sy*.25:0,high=deck*sy-.15;
  const maximumMass=hullHydrostatics(length,beam,high,modelId).mass;
  for(let i=0;i<28;i++){
    const mid=(low+high)*.5;
    if(hullHydrostatics(length,beam,mid,modelId).mass<mass)low=mid;else high=mid;
  }
  const sinkage=(low+high)*.5,loaded=hullHydrostatics(length,beam,sinkage,modelId);
  const {volume,waterplaneArea}=loaded,draft=designDraft*sy+sinkage,freeboard=deck*sy-sinkage;
  // Authored effective coefficients, not a calibrated resistance curve.
  const wettedArea = 0.85 * length * (beam + 2 * draft);
  // Calibrate fixed vessel KG to the previous stability estimate, then add crew
  // on deck and secured stores/cargo low amidships. No free-surface tank slosh.
  const fixedKG=base.centreOfBuoyancy+base.waterplaneMoment/base.volume-beam*(victory?.08:.22);
  const crewKG=designDraft*sy+(victory?VICTORY_DESIGN.decks.quarter.height:1.5)*sy,storesKG=designDraft*sy-.45*sy;
  const centreOfGravity=(fixedMass*fixedKG+crewMass*crewKG+(loadMass-crewMass)*storesKG)/mass;
  const metacentricHeight=Math.max(.1,loaded.centreOfBuoyancy+loaded.waterplaneMoment/volume-centreOfGravity);
  const rollInertia=1.2*(fixedMass*((beam*.38)**2+(1.6*sy)**2+(fixedKG-centreOfGravity)**2)
    +crewMass*((beam*.3)**2+(crewKG-centreOfGravity)**2)
    +(loadMass-crewMass)*((beam*.18)**2+(storesKG-centreOfGravity)**2));
  const rollStiffness=mass*9.81*metacentricHeight;
  // Effective added-water inertia and damping are authored, not replica measurements.
  const rollDamping=2*.50*Math.sqrt(rollInertia*rollStiffness);
  const pitchInertia=1.5*(fixedMass*((length*.26)**2+(1.6*sy)**2+(fixedKG-centreOfGravity)**2)
    +crewMass*((length*.25)**2+(crewKG-centreOfGravity)**2)
    +(loadMass-crewMass)*((length*.18)**2+(storesKG-centreOfGravity)**2));
  const pitchStiffness=mass*9.81*Math.max(.1,loaded.centreOfBuoyancy+loaded.longitudinalMoment/volume-centreOfGravity);
  const pitchDamping=2*.70*Math.sqrt(pitchInertia*pitchStiffness);
  const addedMass=mass*.08,heaveOmega=Math.sqrt(SEAWATER_DENSITY*9.81*waterplaneArea/(mass+addedMass));
  return { modelCode:victory?1:0,length,beam,provisionDays,cargoTonnes,draft,sinkage,freeboard,volume,mass,addedMass,
    fixedMass,loadMass,crewMass,waterMass,foodMass,storesMass,cargoMass,overloadKg:Math.max(0,mass-maximumMass),
    waterplaneArea,centreOfGravity,heaveOmega,drag:0.5*SEAWATER_DENSITY*0.012*wettedArea,
    metacentricHeight,rollInertia,rollStiffness,rollDamping,pitchInertia,pitchStiffness,pitchDamping };
}

// Explicit authored loading placements for these new reconstructions, in metres
// above the main deck / design-unit height above the inner bottom. Not a Niña
// manifest fallback or a historical inventory inferred from reported tonnage.
export const ADDITIONAL_LOAD_PLACEMENT=Object.freeze({personCGAboveDeck:.9,storesAboveBottom:.35});
const boatRowingStructureCache=new Map();
function boatRowingStructure(id,length,beam){
  const key=id+'/'+length+'/'+beam;if(boatRowingStructureCache.has(key))return boatRowingStructureCache.get(key);
  const d=ROWING_DESIGNS[id],p=d.profile,sx=beam/d.frame.beam,sy=d.frame.verticalScale,sz=length/d.frame.length;
  const point=(z,y,side)=>hullLoftPoint(p,z,y,side).map((v,i)=>v*[sx,sy,sz][i]);
  let shellArea=0,shellMoment=0,woodVolume=0,woodMoment=0,benchVolume=0,mastVolume=0;
  const triangle=(a,b,c)=>{
    const u=b.map((v,i)=>v-a[i]),v=c.map((v,i)=>v-a[i]);
    const area=.5*Math.hypot(u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]);
    shellArea+=area;shellMoment+=area*(a[1]+b[1]+c[1])/3;
  };
  const wood=(volume,y)=>{if(volume>0){woodVolume+=volume;woodMoment+=volume*y;}};
  const nz=96,ny=24,z0=p.stations[0],span=p.stations.at(-1)-z0,dz=span/nz,dy=(p.deck-p.levels[0])/ny;
  // Thin, uniform shell approximation on the actual outer loft, including a
  // flat keel floor where present. Its CG cannot escape the geometry's height.
  for(let i=0;i<nz;i++){
    const z=z0+i*dz,Z=z+dz;
    for(const side of [-1,1])for(let j=0;j<ny;j++){
      const y=p.levels[0]+j*dy,Y=y+dy,a=point(z,y,side),b=point(Z,y,side),c=point(Z,Y,side),e=point(z,Y,side);
      triangle(a,b,c);triangle(a,c,e);
    }
    const a=point(z,p.levels[0],-1),b=point(Z,p.levels[0],-1),c=point(Z,p.levels[0],1),e=point(z,p.levels[0],1);
    triangle(a,b,c);triangle(a,c,e);
  }
  const shellCentroidY=shellMoment/shellArea;wood(shellArea*d.shellThicknessMetres,shellCentroidY);
  // Floorboard thickness is an explicit authored loading approximation. Bench
  // and leg dimensions below match the visible rowing-ships geometry.
  for(let i=0;i<nz;i++){
    const z=z0+(i+.5)*dz,y=proceduralDeck(id,z),w=Math.max(0,proceduralHullWidth(id,z,y)*sx-d.shellThicknessMetres);
    const t=d.loading.structureFloorThicknessMetres;wood(2*w*dz*sz*t,y*sy-t*.5);
  }
  const benchZs=[...new Set([...d.stations.map(s=>s.seat[2]),...Object.values(d.crewStations).map(s=>s.z)])];
  for(const z of benchZs){
    const y=d.seatHeight+hullLoftSheer(p,z),w=Math.max(0,proceduralHullWidth(id,z,y)-d.shellThicknessMetres/sx);
    if(w<.1)continue;
    const volume=2*w*sx*(.032*sy)*(.13*sz);benchVolume+=volume;wood(volume,(y-.016)*sy);
    const floor=proceduralDeck(id,z),height=Math.max(0,y-.02-floor)*sy;
    wood(2*Math.PI*.022**2*sx*sz*height,(floor+y-.02)*sy*.5);
  }
  if(d.keel){const k=d.keel,n=48,step=(k.bounds[1]-k.bounds[0])/n;
    for(let i=0;i<n;i++){const z=k.bounds[0]+(i+.5)*step;wood(k.width*sx*k.depth*sy*step*sz,(p.levels[0]+hullLoftSheer(p,z)-k.depth*.5)*sy);}
  }
  for(const m of d.masts){
    const y=proceduralDeck(id,m.z),height=(m.height-y)*sy,a=m.radius,b=.018;
    const volume=Math.PI*sx*sz*height*(a*a+a*b+b*b)/3;
    const t=(a*a+2*a*b+3*b*b)/(4*(a*a+a*b+b*b));mastVolume+=volume;wood(volume,y*sy+height*t);
  }
  const cargo=d.equipment.cargo??[],cargoWeight=cargo.reduce((sum,c)=>sum+c.extent.reduce((v,x)=>v*x,1),0);
  const storesFloorY=cargoWeight?cargo.reduce((sum,c)=>sum+proceduralDeck(id,c.z)*sy*c.extent.reduce((v,x)=>v*x,1),0)/cargoWeight:proceduralDeck(id,0)*sy;
  // Only relative wood volumes place fixed mass. They do not claim a measured
  // hull weight or turn reported tonnage into displacement. Rig cloth/oar mass
  // and moving crew redistribution remain outside this static loading proxy.
  const result=Object.freeze({hullLocalY:woodMoment/woodVolume,storesHullLocalY:storesFloorY+.05,shellArea,shellCentroidY,woodVolume,benchVolume,mastVolume});
  boatRowingStructureCache.set(key,result);return result;
}
function additionalBoatHydrodynamics(length,beam,provisionDays,cargoTonnes,id){
  provisionDays=provisionSetting(provisionDays??proceduralProvisionDays(id));cargoTonnes=cargoSetting(cargoTonnes);
  const table=additionalHydroTable(id),d=table.design,M=d.loading,sy=d.frame.verticalScale;
  if(!M||!['crew','personKg','waterKgPerDay','foodKgPerDay','casksKg','sparesKg','gmBeamFraction'].every(key=>Number.isFinite(M[key])&&M[key]>=0)
    ||!(M.personKg>0)||!(M.gmBeamFraction>0)||!Number.isInteger(M.crew)||typeof M.designIncludesManifest!=='boolean')
    throw Error('No explicit loading manifest for '+id);
  if(Object.hasOwn(ROWING_DESIGNS,id)&&!(Number.isFinite(M.structureFloorThicknessMetres)&&M.structureFloorThicknessMetres>0))throw Error('No authored rowing floor structure for '+id);
  const base=additionalHydrostatics(length,beam,0,id),datumDraft=table.datumDraft*sy;
  const crewMass=M.crew*M.personKg,waterMass=M.crew*M.waterKgPerDay*provisionDays,foodMass=M.crew*M.foodKgPerDay*provisionDays;
  const storesMass=M.casksKg+M.sparesKg,cargoMass=cargoTonnes*1000,loadMass=crewMass+waterMass+foodMass+storesMass+cargoMass;
  const standardLoad=M.crew*(M.personKg+(M.waterKgPerDay+M.foodKgPerDay)*proceduralProvisionDays(id))+storesMass;
  const ballast=d.keel?.ballast,ballastMass=Number.isFinite(ballast?.massKg)?ballast.massKg:0;
  const fixedMass=Math.max(base.mass*.3,base.mass-(M.designIncludesManifest?standardLoad:0),ballastMass),mass=fixedMass+loadMass;
  const seated=Object.hasOwn(ROWING_DESIGNS,id),seats=seated?Object.values(d.crewStations):null;
  const structure=seated?boatRowingStructure(id,length,beam):null;
  const crewKG=seated?datumDraft+seats.reduce((sum,p)=>sum+p.y*sy,0)/seats.length+(M.personCGAboveSeat??.35):
    datumDraft+proceduralHullDeck(id,0)*sy+ADDITIONAL_LOAD_PLACEMENT.personCGAboveDeck;
  const storesKG=seated?datumDraft+structure.storesHullLocalY:ADDITIONAL_LOAD_PLACEMENT.storesAboveBottom*sy;
  // Legacy additional sailing hulls retain their authored GM calibration.
  // Open rowing craft instead place structure on their actual shell/equipment.
  const targetKG=base.centreOfBuoyancy+base.waterplaneMoment/base.volume-beam*M.gmBeamFraction;
  const structureMass=fixedMass-ballastMass,ballastKG=ballastMass?datumDraft+ballast.centre[1]*sy:0;
  // An explicit lead ballast is a real mass at its authored depth. Do not
  // silently cancel its righting lever by solving the hull KG back to a GM.
  const structureKG=seated?datumDraft+structure.hullLocalY:datumDraft+(d.profile.deck*.55)*sy;
  const fixedKG=seated?structureKG:ballastMass?(structureMass*structureKG+ballastMass*ballastKG)/fixedMass:
    ((fixedMass+standardLoad)*targetKG-crewMass*crewKG-(standardLoad-crewMass)*storesKG)/fixedMass;
  let low=-table.physicalDraft*sy,high=table.deck*sy-.15;
  const maximumMass=additionalHydrostatics(length,beam,high,id).mass;
  for(let i=0;i<28;i++){
    const mid=(low+high)*.5;if(additionalHydrostatics(length,beam,mid,id).mass<mass)low=mid;else high=mid;
  }
  const sinkage=(low+high)*.5,loaded=additionalHydrostatics(length,beam,sinkage,id),{volume,waterplaneArea}=loaded;
  const draft=table.physicalDraft*sy+sinkage,freeboard=table.deck*sy-sinkage;
  const centreOfGravity=(fixedMass*fixedKG+crewMass*crewKG+(loadMass-crewMass)*storesKG)/mass;
  const rawGM=loaded.centreOfBuoyancy+loaded.waterplaneMoment/volume-centreOfGravity,metacentricHeight=Math.max(.1,rawGM);
  const verticalRadius=(table.physicalDraft+table.deck)*sy*.35;
  const fixedRoll=ballastMass?structureMass*((beam*.38)**2+verticalRadius**2+(structureKG-centreOfGravity)**2)+ballastMass*((d.keel.width*beam/d.frame.beam*.25)**2+(ballastKG-centreOfGravity)**2):fixedMass*((beam*.38)**2+verticalRadius**2+(fixedKG-centreOfGravity)**2);
  const rollInertia=1.2*(fixedRoll
    +crewMass*((beam*.3)**2+(crewKG-centreOfGravity)**2)+(loadMass-crewMass)*((beam*.18)**2+(storesKG-centreOfGravity)**2));
  const rollStiffness=mass*9.81*metacentricHeight,rollDamping=2*.50*Math.sqrt(rollInertia*rollStiffness);
  const fixedPitch=ballastMass?structureMass*((length*.26)**2+verticalRadius**2+(structureKG-centreOfGravity)**2)+ballastMass*((ballast.centre[2]*length/d.frame.length)**2+(ballastKG-centreOfGravity)**2):fixedMass*((length*.26)**2+verticalRadius**2+(fixedKG-centreOfGravity)**2);
  const pitchInertia=1.5*(fixedPitch
    +crewMass*((length*.25)**2+(crewKG-centreOfGravity)**2)+(loadMass-crewMass)*((length*.18)**2+(storesKG-centreOfGravity)**2));
  const pitchStiffness=mass*9.81*Math.max(.1,loaded.centreOfBuoyancy+loaded.longitudinalMoment/volume-centreOfGravity);
  const pitchDamping=2*.70*Math.sqrt(pitchInertia*pitchStiffness),addedMass=mass*.08;
  const result={modelCode:hydroModelCode(id),length,beam,provisionDays,cargoTonnes,datumDraft,draft,sinkage,freeboard,volume,mass,addedMass,
    fixedMass,loadMass,crewMass,waterMass,foodMass,storesMass,cargoMass,overloadKg:Math.max(0,mass-maximumMass),waterplaneArea,centreOfGravity,
    heaveOmega:Math.sqrt(SEAWATER_DENSITY*9.81*waterplaneArea/(mass+addedMass)),drag:.5*SEAWATER_DENSITY*.012*.85*length*(beam+2*draft),
    metacentricHeight,rollInertia,rollStiffness,rollDamping,pitchInertia,pitchStiffness,pitchDamping};
  // Preserve the original four models' exact scalar object contract. Rich
  // provenance/placement diagnostics belong only to the new authored vessels.
  if(d.modelCode>=4)Object.assign(result,{ballastMass,ballastKG,
    referenceDisplacementKg:M.referenceDisplacementKg??null,referenceMassDifferenceKg:Number.isFinite(M.referenceDisplacementKg)?mass-M.referenceDisplacementKg:null,
    fixedKG,structureKG,crewKG,storesKG,rawGM,stabilityClamped:rawGM<.1,
    structureCGBasis:seated?'authored uniform wood shell/floor/bench/keel/mast volume':ballastMass?'authored hull and explicit lead ballast':'authored target GM',
    structureShellCentroidY:structure?.shellCentroidY??null,structureGeometricWoodVolume:structure?.woodVolume??null});
  return result;
}

// One angular momentum state per axis. Wave righting, sail torque and hull
// damping act on the same body; no wave-velocity tracking or added heel angle.
export function stepBoatRotation(boat, axis, waveAngle, moment, dt, addedDamping=0) {
  boat[axis] ??= 0;boat[axis+'Velocity'] ??= 0;
  if(!(dt>0)||!Number.isFinite(dt))return;
  const hydro=boat.hydrodynamics,I=hydro[axis+'Inertia'],K=hydro[axis+'Stiffness'];
  const speed=Math.abs(boatForwardSpeed(boat));
  const froude=speed/Math.sqrt(9.81*boat.length);
  // Extra flow past the hull/keel damps motion underway, even with bare poles.
  const B=hydro[axis+'Damping']*(1+Math.min(.5,froude*1.5))+Math.max(0,addedDamping);
  const steps=Math.ceil(dt*120),h=dt/steps,key=axis+'Velocity';
  for(let i=0;i<steps;i++){
    const torque=moment+K*Math.sin(waveAngle-boat[axis]);
    boat[key]=(boat[key]+torque/I*h)/(1+B/I*h);
    boat[axis]+=boat[key]*h;
    // No capsize/flooding solver: bound out-of-model attitudes, retaining inertia inside it.
    const limit=Math.PI/3;
    if(Math.abs(boat[axis])>limit){boat[axis]=Math.sign(boat[axis])*limit;if(boat[axis]*boat[key]>0)boat[key]=0;}
  }
}

// Incident pressure gradients are already filtered over the hull footprint by
// the GPU probe. Fine visible chop must not tilt a twenty-metre rigid body.
export function boatWaveAttitude(slopeX,slopeZ,heading){
  const h=heading*Math.PI/180;
  return {roll:Math.atan(slopeX*Math.cos(h)+slopeZ*Math.sin(h)),
    pitch:Math.atan(slopeX*Math.sin(h)-slopeZ*Math.cos(h))};
}

export function boatForwardSpeed(boat) {
  return boat.surgeVelocity ?? (boat.propulsion === 'sail' ? 0 : boat.speed * KNOT_TO_MPS);
}

// World-space, incident-wave slopes arrive in the existing asynchronous probe.
// Never hold an old force indefinitely after a stalled readback or a scene edit.
export function boatWaveSlope(boat, time) {
  const age = time - boat.waveSampleTime;
  if (boat.waveRevision !== boat.revision || !(age >= 0)) return 0;
  const freshness = Math.exp(-Math.max(0, age - 0.25) / 0.25);
  const heading = boat.heading * Math.PI / 180;
  return (boat.waveSlopeX * Math.sin(heading) - boat.waveSlopeZ * Math.cos(heading)) * freshness;
}

// Long-wave Froude–Krylov approximation: F = -rho*g*volume*mean(wave slope).
// Sailing uses apparent-wind forces; manual mode retains the calm-water thrust.
// Both integrate through vessel inertia, resistance and incident-wave pressure.
export function stepBoatSurge(boat, slope, dt, windSpeed = 0, windDirection = 0) {
  boat.leewayDistance = 0;
  boat.waterYawMoment=boat.sailYawMoment=boat.rowingYawMoment=boat.waterYawDamping=0;
  boat.leewayVelocity ??= 0;
  boat.roll ??= 0;boat.rollVelocity ??= 0;
  boat.pitch ??= 0;boat.pitchVelocity ??= 0;
  if (!(dt > 0) || !Number.isFinite(dt)) return 0;
  const modelId=boat.modelId??'nina';
  const modelCode=hydroModelCode(modelId);
  let hydro = boat.hydrodynamics;
  if (!hydro || hydro.length !== boat.length || hydro.beam !== boat.beam
      || hydro.modelCode!==modelCode || hydro.provisionDays!==provisionSetting(boat.provisionDays??(additionalHydroDesign(modelId)?proceduralProvisionDays(modelId):DEFAULT_PROVISION_DAYS)) || hydro.cargoTonnes!==cargoSetting(boat.cargoTonnes)) {
    hydro = boat.hydrodynamics = boatHydrodynamics(boat.length, boat.beam,boat.provisionDays,boat.cargoTonnes,boat.modelId);
  }
  // Sample the loaded underwater silhouette only when geometry/loading changes.
  // The descriptor is separate so the existing hydrostatic scalar API remains
  // inspectable; future hulls register geometry explicitly instead of becoming Niña.
  let lateral=boat.lateralHydrodynamics;
  if(!lateral||lateral.hydro!==hydro){
    lateral=boat.lateralHydrodynamics={hydro,
      descriptor:createHullLateralDescriptor({modelId,length:boat.length,beam:boat.beam,waterline:hydro.sinkage}),
      force:{},state:{cgY:hydro.centreOfGravity-(hydro.datumDraft??vesselDraft(boat))}};
  }
  const lateralState=lateral.state,lateralInertia=hydro.mass*(1+lateral.descriptor.addedMassRatio);
  const inertia = hydro.mass + hydro.addedMass;
  const sailing = boat.propulsion === 'sail';
  const rowing=Object.hasOwn(ROWING_DESIGNS,modelId),rowLoads=rowing?(boat.rowingLoads??={}):null;
  const external=boat.externalForce,heading=(boat.heading??0)*Math.PI/180;
  const upwind=sailing&&windSpeed>0?Math.min(1,Math.max(0,(Math.sin(windDirection-heading)+.70)/.45)):0;
  const savedSurge=boat.surgeVelocity,savedLeeway=boat.leewayVelocity;
  if((savedSurge??0)>0&&upwind>0){
    boat.surgeVelocity=savedSurge*(1-.90*upwind);
    boat.leewayVelocity=(savedLeeway??0)*(1-.90*upwind);
  }
  advanceSails(boat, dt, windSpeed, windDirection);
  boat.surgeVelocity=savedSurge;boat.leewayVelocity=savedLeeway;
  const target = boat.speed * KNOT_TO_MPS;
  const thrust = hydro.drag * target * Math.abs(target);
  const waveForce = -1025 * 9.81 * hydro.volume * slope;
  // Optional world-space loads (e.g. an anchor rode) pass through the same
  // inertial integrator as wind and wave pressure. Units: N, clockwise N m.
  const externalX=Number.isFinite(external?.x)?external.x:0,externalZ=Number.isFinite(external?.z)?external.z:0;
  const externalForward=externalX*Math.sin(heading)-externalZ*Math.cos(heading);
  const externalSide=externalX*Math.cos(heading)+externalZ*Math.sin(heading);
  const initial = boatForwardSpeed(boat);
  const attitude=boat.waveAttitude ?? boat.target ?? {roll:0,pitch:0};
  const sailDriveScale=modelId==='victory'?5.5:1.45*Math.sqrt(Math.max(1,boat.length/20));
  let velocity = initial, distance = 0, sideways = boat.leewayVelocity ?? 0, sidewaysDistance = 0;
  const steps = Math.ceil(dt * 120), h = dt / steps;
  for (let i = 0; i < steps; i++) {
    const aeroFactor=velocity>0&&upwind>0?1-.90*upwind:1;
    const loads = sailing ? sailForces(boat, windSpeed, windDirection, velocity*aeroFactor, sideways*aeroFactor) : null;
    let blades=null;
    if(rowing){
      advanceRowing(boat,h,sailing?undefined:{effort:0,port:0,starboard:0});
      // Runtime requires an accepted actual-water field. The pure evaluator's
      // explicit flat-water default is never used implicitly by the game.
      blades=rowingForces(rowLoads,boat,{surge:velocity,sway:sideways,sampleWater:boat.rowingWater?.sample??boatNoRowingWater});
    }
    lateralState.surge=velocity;lateralState.sway=sideways;lateralState.yawRate=boat.yawRate??0;
    lateralState.rollRate=boat.rollVelocity;lateralState.pitchRate=boat.pitchVelocity;lateralState.heaveRate=boat.heaveVelocity??0;
    lateralState.roll=boat.roll;lateralState.pitch=boat.pitch;
    const water=evaluateHullLateral(lateral.force,lateral.descriptor,lateralState);
    // Put each local force at its actual depth/longitudinal station. Its
    // diagonal resistance is implicit; this avoids explicit drag overshoot.
    stepBoatRotation(boat,'roll',attitude.roll??0,(loads?.rollMoment??0)+(blades?.rollMoment??0)+water.rollMoment+water.rollDamping*boat.rollVelocity,h,water.rollDamping);
    stepBoatRotation(boat,'pitch',attitude.pitch??0,(loads?.pitchMoment??0)+(blades?.pitchMoment??0),h);
    const sailForward=loads?(loads.forward>0?loads.forward*sailDriveScale:velocity>0?loads.forward*.15:loads.forward):thrust;
    const force = sailForward + (blades?.forward??0)+waveForce + externalForward+water.forward;
    const free = velocity + force / inertia * h;
    const froude = Math.abs(velocity) / Math.sqrt(9.81 * boat.length);
    const drag = hydro.drag * (sailing && loads?.area > 0 ? 0.20 + 80 * Math.max(0, froude - 0.30) ** 2 : 1);
    // Implicit signed quadratic drag: stable through zero and during reversals.
    const next = 2 * free / (1 + Math.sqrt(1 + 4 * drag / inertia * h * Math.abs(free)));
    distance += (velocity + next) * 0.5 * h;
    velocity = next;
    const lateralFree=sideways+((loads?.side??0)+(blades?.side??0)+externalSide+water.side+water.sideDamping*sideways)/lateralInertia*h;
    const nextSide=lateralFree/(1+water.sideDamping/lateralInertia*h);
    sidewaysDistance += (sideways + nextSide) * 0.5 * h; sideways = nextSide;
    boat.waterYawMoment+=water.yawMoment/steps;boat.sailYawMoment+=(loads?.yawMoment??0)/steps;boat.waterYawDamping+=water.yawDamping/steps;
    boat.rowingYawMoment+=(blades?.yawMoment??0)/steps;
  }
  boat.yawLoadRevision=boat.revision;
  boat.surgeVelocity = velocity;
  boat.surgeAcceleration = (velocity - initial) / dt;
  boat.leewayVelocity = sideways; boat.leewayDistance = sidewaysDistance;
  sailForces(boat, windSpeed, windDirection, velocity, sideways);
  return distance;
}

// Approximate rigid hull response to a 3 x 3 grid of actual ocean heights.
export function boatTargets(heights, length, beam) {
  const mean = (a, b, c) => (heights[a] + heights[b] + heights[c]) / 3;
  return {
    heave: heights.reduce((a, b) => a + b, 0) / 9,
    pitch: Math.atan2(mean(6, 7, 8) - mean(0, 1, 2), length),
    roll: Math.atan2(mean(2, 5, 8) - mean(0, 3, 6), beam),
  };
}

// Exact critically damped spring step: stable even when frame rate varies.
export function boatSpring(state, key, target, omega, dt, targetVelocity = 0) {
  const velocity = key + 'Velocity';
  const offset = state[key] - target;
  const relativeVelocity = (state[velocity] || 0) - targetVelocity;
  const c = relativeVelocity + omega * offset;
  const decay = Math.exp(-omega * dt);
  state[key] = target + targetVelocity * dt + (offset + c * dt) * decay;
  state[velocity] = targetVelocity + (relativeVelocity - omega * c * dt) * decay;
}

// Transform a local look vector by hull roll, pitch, then compass heading.
export function boatRotate(out, x, y, z, heading, pitch, roll) {
  const cr = Math.cos(roll), sr = Math.sin(roll);
  const cp = Math.cos(pitch), sp = Math.sin(pitch);
  const ch = Math.cos(heading), sh = Math.sin(heading);
  const xx = cr * x - sr * y, yy = sr * x + cr * y;
  const yp = cp * yy - sp * z, zp = sp * yy + cp * z;
  out[0] = ch * xx - sh * zp; out[1] = yp; out[2] = sh * xx + ch * zp;
}
// Rudder lag and yaw inertia; a simple speed-dependent displacement-hull model.
export function stepBoatSteering(boat, command, dt) {
  if(!(dt>0)||!Number.isFinite(dt)){boat.waterYawMoment=boat.sailYawMoment=boat.rowingYawMoment=boat.waterYawDamping=0;return;}
  boat.rudderTarget = Math.max(-35, Math.min(35, boat.rudderTarget + command * 28 * dt));
  boatSpring(boat, 'rudder', boat.rudderTarget, 9, dt);
  const speed = boatForwardSpeed(boat);
  const current=boat.yawLoadRevision===boat.revision;
  const activeCanvas=current&&(boat.sailState?.area??0)>0;
  const helmScale=activeCanvas?0.65+0.95*(Math.abs(boat.rudder)/35)**2:0.65;
  const desired = Object.hasOwn(ROWING_DESIGNS,boat.modelId)?0:speed / Math.max(boat.length, 3) * Math.tan(boat.rudder * Math.PI / 180) * helmScale;
  const previous = boat.yawRate || 0;
  const response=0.9+boat.length*.06,decay=Math.exp(-dt/response);
  const waterDamping=current&&Number.isFinite(boat.waterYawDamping)?Math.max(0,boat.waterYawDamping):0;
  const steerage=activeCanvas?.015+.985/(1+(Math.abs(speed)/.20)**2):1;
  const sailWaterMoment=((current&&Number.isFinite(boat.sailYawMoment)?boat.sailYawMoment:0)+(current&&Number.isFinite(boat.waterYawMoment)?boat.waterYawMoment:0))*steerage;
  const yawMoment=(Number.isFinite(boat.externalForce?.yaw)?boat.externalForce.yaw:0)
    +sailWaterMoment+(current&&Number.isFinite(boat.rowingYawMoment)?boat.rowingYawMoment:0);
  const yawInertia=(boat.hydrodynamics?.mass??60000)*(boat.length**2+(boat.beam??boat.length*.3)**2)/12*1.5;
  // Measured load diagnostics for a helmsman's feed-forward. These report the
  // ordinary integration interval; they have no authority to alter motion.
  boat.steeringLoadAcceleration=yawMoment/yawInertia;
  boat.steeringResponse=response;
  // Retain the authored speed/reversed-flow rudder response, then balance actual
  // sail and underwater moments. The shared hull supplies passive yaw damping;
  // rudder deflection never creates surge force or a zero-flow turning assist.
  const damping=yawInertia/response+waterDamping;
  const equilibrium=((activeCanvas?damping:yawInertia/response)*desired+yawMoment+waterDamping*previous)/damping;
  const flowDecay=waterDamping?Math.exp(-dt*damping/yawInertia):decay;
  boat.yawRate=equilibrium+(previous-equilibrium)*flowDecay;
  boat.heading = ((boat.heading + (previous + boat.yawRate) * 0.5 * dt * 180 / Math.PI) % 360 + 360) % 360;
  // One surge interval feeds one steering interval; a paused/stale query cannot
  // keep applying an old sail or wave-related underwater moment indefinitely.
  boat.waterYawMoment=boat.sailYawMoment=boat.rowingYawMoment=boat.waterYawDamping=0;
}

// Stand to windward of the billowing canvas. The sailing model retains its tack
// near a dead run/calm; a critically damped crossing avoids a camera teleport.
export function stepBoatView(boat,dt){
  const side=boat.sailState?.tack??1;
  boat.eyeSide??=side;
  boatSpring(boat,'eyeSide',side,4,dt);
}
// World-space eye anchor; keeping it separate from the vessel allows inspection.
export function boatEyePosition(out, boat) {
  hydroModelCode(boat.modelId??'nina');
  const side=boat.eyeSide??boat.sailState?.tack??1;
  const additional=additionalHydroDesign(boat.modelId),victory=boat.modelId==='victory',helm=additional?.helm??(victory?VICTORY_DESIGN.helm:null);
  // Cross ahead of the mizzen rather than moving the eye through its trunk.
  const eyeZ=victory?helm.z-.65*(1-Math.min(1,side*side)):helm?.z??HELM_EYE_Z;
  const eye=additional?Math.max(Number.isFinite(boat.eye)?boat.eye:-Infinity,proceduralDeck(additional.id,helm.z,helm.x)*additional.frame.verticalScale+helm.eyeAboveDeck):boat.eye;
  boatRotate(out, side * (helm?.x??HELM_EYE_X) * boat.beam / 3.6, eye, eyeZ * boat.length / 12,
    boat.heading * Math.PI / 180, boat.pitch, boat.roll);
  out[0] += boat.x; out[1] += boat.heave; out[2] += boat.z;
  return out;
}

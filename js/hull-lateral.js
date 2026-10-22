// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
import {NINA_DESIGN} from './models/nina.js';
import {VICTORY_DESIGN,victoryHullHalfWidth,victoryHullDeck,victorySheer} from './models/victory.js';
import {ADDITIONAL_DESIGNS,additionalHullWidth,additionalHullDeck} from './models/additional.js';
import {hullLoftBottom} from './hull-loft.js';
import {hullHalfWidth,hullDeck,HULL_DRAFT,HULL_BOW_RAKE,HULL_STERN_RAKE} from './hull.js';
import {deepFreeze} from './rig-definition.js';

// Geometry drives area and levers. These effective coefficients are authored,
// not captive-test measurements of either historical vessel. The .8 added-mass
// ratio retains the previous 1.8M lateral inertia independently of keel shape.
export const HULL_LATERAL_COEFFICIENTS=Object.freeze({density:1025,crossflowCd:.8,efficiency:.6,addedMassRatio:.8});
const models=new Map();
const finitePositive=x=>Number.isFinite(x)&&x>0;

// Registration supplies design-frame geometry, never a ship-name fallback.
// Appendage profiles describe only area exposed outside the hull silhouette;
// a future yacht fin has its own span/aspect rather than inheriting hull aspect.
export function registerHullLateralModel(id,definition){
  if(typeof id!=='string'||!id||models.has(id))throw Error('Invalid or duplicate lateral hull model: '+id);
  const f=definition?.frame,b=definition?.bounds;
  if(!f||![f.length,f.beam,f.verticalScale].every(finitePositive)||!b||b.length!==2||!b.every(Number.isFinite)||!(b[1]>b[0])
    ||typeof definition.halfWidth!=='function'||typeof definition.deck!=='function'||typeof definition.bottom!=='function')
    throw Error('Lateral hull model requires finite frame, bounds and underwater geometry: '+id);
  for(const a of definition.appendages??[])if(!a.id||!a.bounds||a.bounds.length!==2||!a.bounds.every(Number.isFinite)||!(a.bounds[1]>a.bounds[0])
    ||typeof a.top!=='function'||typeof a.bottom!=='function')throw Error('Invalid exposed appendage profile: '+id);
  models.set(id,deepFreeze({...definition,frame:{...f},bounds:[...b],appendages:[...(definition.appendages??[])]}));
}

registerHullLateralModel('nina',{
  frame:NINA_DESIGN.frame,bounds:[-6.4,5.6],halfWidth:hullHalfWidth,deck:hullDeck,bottom:()=>-HULL_DRAFT,
  provenance:'Authored reconstruction hull silhouette; not measured hydrodynamic derivatives.',
  appendages:[{id:'timber-keel',kind:'exposed-keel',bounds:[-6.4+HULL_BOW_RAKE,5.6-HULL_STERN_RAKE],
    top:()=>-HULL_DRAFT,bottom:()=>-HULL_DRAFT-.075,
    provenance:'Exposed lower half of the actual .15-design-unit timber in caravel.js; no invented fin.'}],
});
registerHullLateralModel('victory',{
  frame:VICTORY_DESIGN.frame,bounds:[-6,6],halfWidth:victoryHullHalfWidth,deck:victoryHullDeck,
  bottom:z=>-VICTORY_DESIGN.hull.draft+victorySheer(z),
  provenance:'Current authored underwater Victory loft, including its keel-depth profile; not Admiralty offsets or tank data.',
});
for(const [id,design] of Object.entries(ADDITIONAL_DESIGNS)){
  const {profile,keel}=design;
  registerHullLateralModel(id,{
    frame:design.frame,bounds:[profile.stations[0],profile.stations.at(-1)],
    halfWidth:(z,y)=>additionalHullWidth(id,z,y),deck:z=>additionalHullDeck(id,z),bottom:z=>hullLoftBottom(profile,z),
    provenance:design.interpretation+' Projected authored underwater hull, not measured hydrodynamic derivatives.',
    appendages:keel?[{id:'timber-keel',kind:'exposed-keel',bounds:keel.bounds,
      top:z=>hullLoftBottom(profile,z),bottom:z=>hullLoftBottom(profile,z)-keel.depth,
      provenance:'Exposed timber below this model\'s own loft bottom; bounds, depth and width share the rendered keel definition.'}]:[],
  });
}

function hullBottom(definition,z,top){
  const lower=definition.bottom(z);if(!Number.isFinite(lower)||!Number.isFinite(top))throw Error('Non-finite underwater hull profile');
  if(!(top>lower))return null;
  // Find the last submerged width, then the actual raked bottom at this station.
  // This occurs only when building the cached loaded-waterline descriptor.
  let last=null;
  for(let j=0;j<=32;j++){
    const y=top-(top-lower)*j/32,w=definition.halfWidth(z,y);
    if(!Number.isFinite(w))throw Error('Non-finite underwater hull width');
    if(w>1e-8){last=y;continue;}
    if(last!==null){
      let low=y,high=last;
      for(let k=0;k<24;k++){
        const mid=(low+high)*.5,w=definition.halfWidth(z,mid);if(!Number.isFinite(w))throw Error('Non-finite underwater hull width');
        if(w>1e-8)high=mid;else low=mid;
      }
      return (low+high)*.5;
    }
  }
  return last;
}

export function createHullLateralDescriptor({modelId='nina',length,beam,waterline=0,strips=24}={}){
  const definition=models.get(modelId);if(!definition)throw Error('No lateral hull geometry registered for '+modelId);
  if(![length,beam].every(finitePositive)||!Number.isFinite(waterline)||!Number.isInteger(strips)||strips<4||strips>256)
    throw Error('Invalid lateral hull dimensions, waterline or strip count');
  const {frame}=definition,sx=beam/frame.beam,sy=frame.verticalScale,sz=length/frame.length,level=waterline/sy;
  const components=[];
  const build=(id,kind,bounds,profile,provenance,coefficients={})=>{
    const rows=[],dz=(bounds[1]-bounds[0])/strips;let area=0,depth=0,zMoment=0,yMoment=0,topY=-Infinity,bottomY=Infinity;
    for(let i=0;i<strips;i++){
      const z=bounds[0]+(i+.5)*dz,p=profile(z);if(!p)continue;
      if(!Number.isFinite(p.top)||!Number.isFinite(p.bottom))throw Error('Invalid lateral hull profile for '+modelId);
      if(!(p.top>p.bottom))continue;
      const h=(p.top-p.bottom)*sy,a=h*dz*sz,y=(p.top+p.bottom)*.5*sy,Z=z*sz;
      if(![h,a,y,Z].every(Number.isFinite))throw Error('Invalid lateral hull profile for '+modelId);
      rows.push({y,z:Z,area:a,depth:h});area+=a;depth=Math.max(depth,h);zMoment+=a*Z;yMoment+=a*y;
      topY=Math.max(topY,p.top*sy);bottomY=Math.min(bottomY,p.bottom*sy);
    }
    if(!(area>0))return;
    const aspect=depth*depth/area;
    const cd=coefficients.crossflowCd??HULL_LATERAL_COEFFICIENTS.crossflowCd,e=coefficients.efficiency??HULL_LATERAL_COEFFICIENTS.efficiency;
    if(!finitePositive(cd)||!finitePositive(e))throw Error('Invalid passive lateral coefficients for '+modelId);
    components.push({id,kind,strips:rows,area,span:depth,topY,bottomY,aspect,clr:{x:0,y:yMoment/area,z:zMoment/area},
      liftSlope:Math.PI*aspect/(1+Math.sqrt(1+(aspect/2)**2)),crossflowCd:cd,efficiency:e,provenance});
  };
  build('hull','projected-hull',definition.bounds,z=>{
    const top=Math.min(level,definition.deck(z)),bottom=hullBottom(definition,z,top);
    return bottom===null?null:{top,bottom};
  },definition.provenance,definition.coefficients);
  for(const a of definition.appendages)build(a.id,a.kind??'appendage',a.bounds,z=>{
    const top=Math.min(level,a.top(z)),bottom=a.bottom(z);return {top,bottom};
  },a.provenance,a.coefficients);
  let area=0,y=0,z=0,topY=-Infinity,bottomY=Infinity;
  for(const c of components){area+=c.area;y+=c.area*c.clr.y;z+=c.area*c.clr.z;topY=Math.max(topY,c.topY);bottomY=Math.min(bottomY,c.bottomY);}
  return deepFreeze({modelId,length,beam,waterline,stripCount:strips,scale:{x:sx,y:sy,z:sz},components,area,span:area?topY-bottomY:0,
    // This is a geometric centroid, not a measured dynamic CLR. The actual
    // force/moment ratio varies with drift, yaw, roll and appendage loading.
    clr:{x:0,y:area?y/area:0,z:area?z/area:0},addedMassRatio:HULL_LATERAL_COEFFICIENTS.addedMassRatio,
    provenance:definition.provenance});
}

// Distributed crossflow follows Fossen's strip principle; the bounded attached
// lift uses a low-aspect slope and vanishes broadside. It is perpendicular to
// local relative flow. Crossflow and induced drag dissipate energy. Existing
// whole-hull surge drag owns profile friction, avoiding a second friction term.
// No wave phase speed is used as water velocity; callers supply real relative
// rigid-body motion in the heading frame (X starboard, Y up, Z aft).
export function evaluateHullLateral(out,descriptor,state={}){
  out.forward=out.side=out.heaveForce=out.rollMoment=out.pitchMoment=out.yawMoment=out.power=out.dissipation=0;
  out.sideDamping=out.rollDamping=out.yawDamping=0;
  const u=state.surge??0,v=state.sway??0,w=state.heaveRate??0,p=state.rollRate??0,q=state.pitchRate??0,r=state.yawRate??0;
  const roll=state.roll??0,pitch=state.pitch??0,cgY=state.cgY??0,cgZ=state.cgZ??0;
  if(!Number.isFinite(u)||!Number.isFinite(v)||!Number.isFinite(w)||!Number.isFinite(p)||!Number.isFinite(q)||!Number.isFinite(r)
    ||!Number.isFinite(roll)||!Number.isFinite(pitch)||!Number.isFinite(cgY)||!Number.isFinite(cgZ))return out;
  const cr=Math.cos(roll),sr=Math.sin(roll),cp=Math.cos(pitch),sp=Math.sin(pitch);
  const nx=cr,ny=cp*sr,nz=sp*sr,ty=sp,tz=-cp,ox=q,oy=-r-p*sp,oz=p*cp,rho=HULL_LATERAL_COEFFICIENTS.density;
  for(const c of descriptor.components)for(const strip of c.strips){
    const Y=strip.y-cgY,Z=strip.z-cgZ,rx=-sr*Y,ry=cp*cr*Y-sp*Z,rz=sp*cr*Y+cp*Z;
    const vx=v+oy*rz-oz*ry,vy=w+oz*rx-ox*rz,vz=-u+ox*ry-oy*rx;
    const normal=vx*nx+vy*ny+vz*nz,chord=vy*ty+vz*tz,speed=Math.hypot(chord,normal);
    const cross=.5*rho*strip.area*c.crossflowCd*Math.abs(normal);
    let fNormal=-cross*normal,fChord=0,dragDamping=0;
    if(speed>1e-9){
      const a=chord/speed,b=normal/speed,cl=c.liftSlope*Math.abs(a)*b,pressure=.5*rho*strip.area*speed*speed;
      const lift=pressure*cl,drag=pressure*cl*cl/(Math.PI*c.efficiency*c.aspect);
      fChord=lift*Math.sign(chord)*b-drag*a;
      fNormal-=lift*Math.abs(a)+drag*b;
      dragDamping=drag/speed;out.dissipation+=drag*speed;
    }
    out.dissipation+=cross*normal*normal;
    const fx=fNormal*nx,fy=fNormal*ny+fChord*ty,fz=fNormal*nz+fChord*tz;
    const mx=ry*fz-rz*fy,my=rz*fx-rx*fz,mz=rx*fy-ry*fx;
    out.forward-=fz;out.side+=fx;out.heaveForce+=fy;
    out.rollMoment+=-sp*my+cp*mz;out.pitchMoment+=mx;out.yawMoment-=my;
    // Positive diagonal drag terms permit linearly implicit body updates while
    // retaining cross-coupled force/moment terms and the same force evaluation.
    const mnY=rz*nx-rx*nz,mnZ=rx*ny-ry*nx,mnRoll=-sp*mnY+cp*mnZ;
    const mtY=-rx*tz,mtZ=rx*ty,mtRoll=-sp*mtY+cp*mtZ;
    out.sideDamping+=(cross+dragDamping)*nx*nx;
    out.rollDamping+=(cross+dragDamping)*mnRoll*mnRoll+dragDamping*mtRoll*mtRoll;
    out.yawDamping+=(cross+dragDamping)*mnY*mnY+dragDamping*mtY*mtY;
  }
  out.power=out.forward*u+out.side*v+out.heaveForce*w+out.rollMoment*p+out.pitchMoment*q+out.yawMoment*r;
  return out;
}

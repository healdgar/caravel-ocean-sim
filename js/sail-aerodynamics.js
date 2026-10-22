import { lateenClothPoint } from './lateen.js';
import { HULL_VERTICAL_SCALE } from './hull.js';
import {VICTORY_DESIGN,VICTORY_SAILS} from './models/victory.js';
import {victoryPose,victoryClothPoint} from './victory-motion.js';
import {rigSurfacePose,surfaceClothPoint,withRigPoseContext} from './rig-surface.js';

// Low-order force model, not a measured Niña polar. Coefficients depend on
// incidence to the cloth, never on the controller's requested sheet angle.
// q*S*CL/CD and finite-span induced drag follow NASA Glenn's lift/drag notes.
// Stall limits, efficiency and separated-plate drag are authored approximations.
const AERO_DENSITY = 1.225;
function aeroSmooth(a,b,x){const t=Math.max(0,Math.min(1,(x-a)/(b-a)));return t*t*(3-2*t);}
export function sailCoefficients(out,incidence,aspect){
  const alpha=Math.min(Math.PI/2,Math.abs(incidence)),ar=Math.max(.5,aspect);
  const separation=aeroSmooth(18*Math.PI/180,35*Math.PI/180,alpha);
  const slope=2*Math.PI*ar/(ar+2);
  const attached=slope*alpha,separated=1.6*Math.sin(alpha)*Math.cos(alpha);
  out.lift=Math.sign(incidence)*(attached*(1-separation)+separated*separation);
  const induced=attached*attached/(Math.PI*ar*.7);
  out.drag=.04+induced*(1-separation)+1.6*Math.sin(alpha)**2*separation;
  out.separation=separation;return out;
}

export function createSailGeometry(subdivisions=6){
  const samples=[],indices=[],at=new Map();
  for(let u=0;u<=subdivisions;u++)for(let v=0;v<=subdivisions-u;v++){
    at.set(u+','+v,samples.length);samples.push([u/subdivisions,v/subdivisions]);
  }
  const id=(u,v)=>at.get(u+','+v);
  for(let u=0;u<subdivisions;u++)for(let v=0;v<subdivisions-u;v++){
    indices.push([id(u,v),id(u+1,v),id(u,v+1)]);
    if(u+v<subdivisions-1)indices.push([id(u+1,v),id(u+1,v+1),id(u,v+1)]);
  }
  return {key:new Float64Array(24).fill(NaN),samples,indices,
    panels:Array.from({length:3*indices.length},()=>({
      point:new Float64Array(3),normal:new Float64Array(3),area:0,aspect:1,
    })),coefficients:{lift:0,drag:0,separation:0},force:new Float64Array(3)};
}

export function createVictorySailGeometry(subdivisions=3){
  const groups=Array.from({length:3},()=>[]),panels=[],surfaces=[];
  for(const sail of VICTORY_SAILS){
    const samples=[],indices=[],n=subdivisions,tri=sail.corners.length===3,at=new Map();
    for(let i=0;i<=n;i++)for(let j=0;j<=(tri?n-i:n);j++){at.set(i+','+j,samples.length);samples.push([i/n,j/n]);}
    const index=(i,j)=>at.get(i+','+j);
    for(let i=0;i<n;i++)for(let j=0;j<(tri?n-i:n);j++){
      indices.push([index(i,j),index(i+1,j),index(i,j+1)]);
      if(!tri||i+j<n-1)indices.push([index(i+1,j),index(i+1,j+1),index(i,j+1)]);
    }
    const surface={sail,samples,indices,key:new Float64Array(9).fill(NaN),panels:indices.map(()=>({point:new Float64Array(3),normal:new Float64Array(3),area:0,aspect:1}))};
    groups[sail.mast].push(...surface.panels);panels.push(...surface.panels);surfaces.push(surface);
  }
  return {victory:true,surfaces,groups,panels,coefficients:{lift:0,drag:0,separation:0},force:new Float64Array(3)};
}
function updateVictorySailGeometry(geometry,boat){
  const state=boat.sailState,scale=[boat.beam/3.6,VICTORY_DESIGN.frame.verticalScale,boat.length/12];
  for(const surface of geometry.surfaces){
    const {sail,samples,indices,key}=surface,pose=victoryPose(sail,state);
    const values=[...scale,pose.yaw,pose.deployed,pose.fill,pose.pressure,0,0];
    if(values.every((v,i)=>key[i]===v))continue;key.set(values);
    const points=samples.map(([u,v])=>victoryClothPoint(sail.id,u,v,pose).map((p,i)=>p*scale[i]));let total=0;
    for(const [j,[a,b,c]]of indices.entries()){
      const p=surface.panels[j],A=points[a],B=points[b],C=points[c],u=B.map((v,i)=>v-A[i]),v=C.map((x,i)=>x-A[i]);
      const normal=[u[1]*v[2]-u[2]*v[1],u[2]*v[0]-u[0]*v[2],u[0]*v[1]-u[1]*v[0]],m=Math.hypot(...normal);
      for(let k=0;k<3;k++){p.point[k]=(A[k]+B[k]+C[k])/3;p.normal[k]=normal[k]/Math.max(m,1e-10);}
      p.area=m*.5*pose.deployed/(.012+.988*pose.deployed);total+=p.area;
    }
    const span=Math.max(...points.map(p=>p[1]))-Math.min(...points.map(p=>p[1]));
    for(const panel of surface.panels)panel.aspect=Math.max(.5,Math.min(12,span*span/Math.max(total,1e-6)));
  }return geometry.panels;
}

const surfaceAeroControls=['fore','main','mizzen'];
function surfaceAeroContextKey(context){
  const supports=context._surfaceActiveSupports??context.supports??[],values=[supports.length,context.masts?.length??0];
  for(const s of supports){values.push(...s.a,...s.b,s.r??0,s.mast,s.side,s.kind,s.surface);if(s.rEnd!==undefined)values.push('rEnd',s.rEnd);}
  for(const m of context.masts??[]){values.push(...m.foot,...m.head,m.radius);if(m.tipRadius!==undefined)values.push('tipRadius',m.tipRadius);}
  return values;
}
function surfaceAeroDescriptorKey(s){
  return [s.id,s.kind,s.mast,s.controlGroup,...s.pivot,...s.corners.flat(),s.belly,s.footRise,s.braceLimit,
    s.yardClearance,s.transferArc,s.transferLift,s.contactClearance,s.contactBand,s.contactPinBand,s.flutter,s.pressureSpeed,
    ...(s.camberAxis??[]),(s.sewnEdges??[]).join(','),s.mastContactSide,...(s.hingeAxis??[])];
}

// The same descriptor/evaluator supplies the render mesh and these mean-load
// panels. Actual surfaces are grouped by control, not by one assumed sail/mast.
export function createSurfaceSailGeometry(design,context={},subdivisions=3){
  if(!design?.id||!design.frame||!Array.isArray(design.surfaces)||!Number.isInteger(subdivisions)||subdivisions<1||subdivisions>16)throw Error('Invalid surface sail geometry');
  const groups=Array.from({length:3},()=>[]),panels=[],surfaces=[];
  for(const sail of design.surfaces){
    const group=surfaceAeroControls.indexOf(sail.controlGroup);
    if(group<0)throw Error('Unknown surface sail control group: '+sail.controlGroup);
    const samples=[],indices=[],n=subdivisions,tri=sail.corners.length===3,at=new Map();
    for(let i=0;i<=n;i++)for(let j=0;j<=(tri?n-i:n);j++){at.set(i+','+j,samples.length);samples.push([i/n,j/n]);}
    const index=(i,j)=>at.get(i+','+j);
    for(let i=0;i<n;i++)for(let j=0;j<(tri?n-i:n);j++){
      indices.push([index(i,j),index(i+1,j),index(i,j+1)]);
      if(!tri||i+j<n-1)indices.push([index(i+1,j),index(i+1,j+1),index(i,j+1)]);
    }
    const surface={sail,group,samples,indices,key:null,revision:0,totalArea:0,
      points:samples.map(()=>new Float64Array(3)),panels:indices.map(()=>({point:new Float64Array(3),normal:new Float64Array(3),area:0,aspect:1,kind:sail.kind,surfaceId:sail.id}))};
    groups[group].push(...surface.panels);panels.push(...surface.panels);surfaces.push(surface);
  }
  return {surfaceRig:true,modelId:design.id,design,context,surfaces,groups,panels,revision:0,
    coefficients:{lift:0,drag:0,separation:0},force:new Float64Array(3)};
}

function updateSurfaceSailGeometry(geometry,boat){
  const {design,context}=geometry,state=boat.sailState;
  if(!state)throw Error('Surface sail geometry requires vessel sailing state');
  const scale=[boat.beam/design.frame.beam,design.frame.verticalScale,boat.length/design.frame.length];
  if(!scale.every(v=>Number.isFinite(v)&&v>0))throw Error('Invalid surface sail dimensions');
  const poses=new Map(geometry.surfaces.map(surface=>[surface.sail.id,rigSurfacePose(surface.sail,state)]));
  const liveContext=withRigPoseContext(context,state,poses),contextKey=surfaceAeroContextKey(liveContext);
  for(const surface of geometry.surfaces){
    const {sail,samples,indices,points}=surface,pose=poses.get(sail.id);
    const values=[...scale,pose.yaw,pose.deployed,pose.fill,pose.pressure,pose.side,pose.opening,pose.dip,...surfaceAeroDescriptorKey(sail),...contextKey];
    if(surface.key&&values.length===surface.key.length&&values.every((v,i)=>surface.key[i]===v))continue;
    for(let j=0;j<samples.length;j++){
      const q=surfaceClothPoint(sail,samples[j][0],samples[j][1],pose,liveContext,0,0);
      for(let k=0;k<3;k++)points[j][k]=q[k]*scale[k];
    }
    let total=0,low=Infinity,high=-Infinity;
    for(const point of points){low=Math.min(low,point[1]);high=Math.max(high,point[1]);}
    for(const [j,[a,b,c]]of indices.entries()){
      const panel=surface.panels[j],A=points[a],B=points[b],C=points[c];
      const ux=B[0]-A[0],uy=B[1]-A[1],uz=B[2]-A[2],vx=C[0]-A[0],vy=C[1]-A[1],vz=C[2]-A[2];
      const nx=uy*vz-uz*vy,ny=uz*vx-ux*vz,nz=ux*vy-uy*vx,m=Math.hypot(nx,ny,nz);
      panel.normal[0]=nx/Math.max(m,1e-10);panel.normal[1]=ny/Math.max(m,1e-10);panel.normal[2]=nz/Math.max(m,1e-10);
      for(let k=0;k<3;k++)panel.point[k]=(A[k]+B[k]+C[k])/3;
      // Retain the visual bundle while exposing zero aerodynamic area at furl.
      panel.area=m*.5*pose.deployed/(.012+.988*pose.deployed);total+=panel.area;
    }
    const aspect=Math.max(.5,Math.min(12,(high-low)**2/Math.max(total,1e-6)));
    for(const panel of surface.panels)panel.aspect=aspect;
    surface.totalArea=total;surface.key=values;surface.revision++;geometry.revision++;
  }
  return geometry.panels;
}

// A coarse triangular mesh samples the actual cloth, including its camber and
// mast support on the bad tack. Decorative flutter is omitted from mean loads.
// Cache geometry across rigid-body substeps; no GPU readback is required.
export function updateSailGeometry(geometry,boat,poses){
  if(geometry.surfaceRig)return updateSurfaceSailGeometry(geometry,boat);
  if(geometry.victory)return updateVictorySailGeometry(geometry,boat);
  const sx=boat.beam/3.6,sy=HULL_VERTICAL_SCALE,sz=boat.length/12;
  const {samples,indices}=geometry;
  for(let m=0;m<3;m++){
    const p=poses[m],at=m*8,key=geometry.key;
    if(key[at]===sx&&key[at+1]===sz&&key[at+2]===p.opening&&key[at+3]===p.side
      &&key[at+4]===p.dip&&key[at+5]===p.deployed&&key[at+6]===p.fill&&key[at+7]===p.pressure)continue;
    key.set([sx,sz,p.opening,p.side,p.dip,p.deployed,p.fill,p.pressure],at);
    const points=samples.map(([u,v])=>{
      const q=lateenClothPoint(m,u,v,p,0,0);q[0]*=sx;q[1]*=sy;q[2]*=sz;return q;
    });
    let total=0;
    for(let j=0;j<indices.length;j++){
      const panel=geometry.panels[m*indices.length+j],[ia,ib,ic]=indices[j],a=points[ia],b=points[ib],c=points[ic];
      const ux=b[0]-a[0],uy=b[1]-a[1],uz=b[2]-a[2],vx=c[0]-a[0],vy=c[1]-a[1],vz=c[2]-a[2];
      const nx=uy*vz-uz*vy,ny=uz*vx-ux*vz,nz=ux*vy-uy*vx,n=Math.hypot(nx,ny,nz);
      panel.normal[0]=nx/Math.max(n,1e-10);panel.normal[1]=ny/Math.max(n,1e-10);panel.normal[2]=nz/Math.max(n,1e-10);
      for(let k=0;k<3;k++)panel.point[k]=(a[k]+b[k]+c[k])/3;
      // The narrow visual bundle at zero set is furled cloth, not exposed area.
      panel.area=n*.5*p.deployed/(.012+.988*p.deployed);total+=panel.area;
    }
    const span=Math.max(...points.map(q=>q[1]))-Math.min(...points.map(q=>q[1]));
    for(let j=0;j<indices.length;j++)geometry.panels[m*indices.length+j].aspect=Math.max(.5,Math.min(12,span*span/Math.max(total,1e-6)));
  }
  return geometry.panels;
}

// Lift is perpendicular to relative airflow; drag is parallel and dissipative.
// Reversing the mesh normal leaves the force unchanged. out is caller-owned.
export function sailPanelForce(out,coefficients,nx,ny,nz,wx,wy,wz,area,aspect){
  const speed=Math.hypot(wx,wy,wz);
  if(speed<1e-8||area<=0){out.fill(0);return 0;}
  const x=wx/speed,y=wy/speed,z=wz/speed,dot=Math.max(-1,Math.min(1,nx*x+ny*y+nz*z));
  const incidence=Math.asin(dot),q=.5*AERO_DENSITY*speed*speed*area;
  sailCoefficients(coefficients,incidence,aspect);
  const lift=q*coefficients.lift/Math.max(1e-8,Math.sqrt(Math.max(0,1-dot*dot))),drag=q*coefficients.drag;
  out[0]=(nx-dot*x)*lift+x*drag;out[1]=(ny-dot*y)*lift+y*drag;out[2]=(nz-dot*z)*lift+z*drag;
  return aeroSmooth(.5,5,speed)*aeroSmooth(.02,.20,Math.abs(incidence));
}

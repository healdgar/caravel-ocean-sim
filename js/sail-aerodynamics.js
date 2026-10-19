import { lateenClothPoint } from './lateen.js';
import { HULL_VERTICAL_SCALE } from './hull.js';

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

// A coarse triangular mesh samples the actual cloth, including its camber and
// mast support on the bad tack. Decorative flutter is omitted from mean loads.
// Cache geometry across rigid-body substeps; no GPU readback is required.
export function updateSailGeometry(geometry,boat,poses){
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

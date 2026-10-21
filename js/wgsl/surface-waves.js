// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Linear short gravity-wave response, not a Navier-Stokes or bathymetry solver.
export const SURFACE_WAVE_SPEED=4;
export const SURFACE_WAVE_TYPES=/* wgsl */ `
struct SurfaceWaveUniform {
  nearDomain:vec4f,
  farDomain:vec4f,
  previousCenters:vec4f,
  step:vec4f,
};
`;

// Caller declares SW, surfaceWaveTex and wakeSamp. Both clipmaps represent the
// same disturbance: crossfade their representations instead of adding energy.
export const SURFACE_WAVE_SAMPLE=SURFACE_WAVE_TYPES+/* wgsl */ `
fn surfaceWaveAt(p:vec2f)->vec4f {
  if(SW.step.w<.5){return vec4f(0);}
  let farUV=(p-SW.farDomain.xy)/SW.farDomain.z+.5;
  let farEdge=max(abs(farUV.x-.5),abs(farUV.y-.5));
  if(farEdge>=.495){return vec4f(0);}
  let far=textureSampleLevel(surfaceWaveTex,wakeSamp,farUV,1,0.0)*(1.0-smoothstep(.43,.495,farEdge));
  let nearUV=(p-SW.nearDomain.xy)/SW.nearDomain.z+.5;
  let nearEdge=max(abs(nearUV.x-.5),abs(nearUV.y-.5));
  let nearWeight=1.0-smoothstep(.36,.47,nearEdge);
  if(nearWeight<=0.0){return far;}
  let near=textureSampleLevel(surfaceWaveTex,wakeSamp,nearUV,0,0.0);
  return mix(far,near,nearWeight);
}
`;

export const SURFACE_WAVE_UPDATE=SURFACE_WAVE_TYPES+/* wgsl */ `
@group(0)@binding(0)var<uniform>SW:SurfaceWaveUniform;
@group(0)@binding(1)var surfacePrevious:texture_2d_array<f32>;
@group(0)@binding(2)var surfaceNext:texture_storage_2d_array<rgba16float,write>;
struct SurfaceWaveSource {position:vec4f,direction:vec4f,detail:vec4f};
@group(0)@binding(3)var<storage,read>surfaceSources:array<SurfaceWaveSource>;
fn surfaceOld(q:vec2i,layer:i32,size:vec2i)->vec4f {
  if(SW.step.y>.5||any(q<vec2i(1))||any(q>=size-1)){return vec4f(0);}
  return textureLoad(surfacePrevious,q,layer,0);
}
fn surfaceSourceGaussian(delta:vec2f,direction:vec2f,sigma:f32,elongation:f32)->f32 {
  let along=dot(delta,direction);let across=dot(delta,vec2f(-direction.y,direction.x));
  let r2=(along*along/(elongation*elongation)+across*across)/(sigma*sigma);
  if(r2>=16.0){return 0.0;}
  return exp(-.5*r2)*(1.0-smoothstep(9.0,16.0,r2));
}
@compute @workgroup_size(8,8)fn main(@builtin(global_invocation_id)id:vec3u){
  let size=vec2i(textureDimensions(surfacePrevious));let q=vec2i(id.xy);
  if(any(q>=size)||id.z>=2u){return;}
  let layer=i32(id.z);let domain=select(SW.nearDomain,SW.farDomain,layer==1);
  let previous=select(SW.previousCenters.xy,SW.previousCenters.zw,layer==1);
  let shift=vec2i(round((domain.xy-previous)/domain.w));let oldQ=q+shift;
  let old=surfaceOld(oldQ,layer,size);
  let neighbours=surfaceOld(oldQ+vec2i(1,0),layer,size)+surfaceOld(oldQ-vec2i(1,0),layer,size)+surfaceOld(oldQ+vec2i(0,1),layer,size)+surfaceOld(oldQ-vec2i(0,1),layer,size);
  let p=(vec2f(q)+.5-vec2f(size)*.5)*domain.w+domain.xy;
  var kick=0.0;var foamSource=0.0;
  for(var i=0u;i<u32(SW.step.z);i++){
    let source=surfaceSources[i];let delta=p-source.position.xy;
    // A source narrower than a cell is integrated over a resolvable footprint;
    // the area factor preserves its one physical impulse budget on both grids.
    let radius=max(source.position.z,domain.w*1.5);
    let ageRadius=${SURFACE_WAVE_SPEED}.0*source.detail.x;
    let sigma=sqrt(radius*radius+ageRadius*ageRadius);
    let elongation=select(1.0,1.7,source.direction.z>.5);
    if(any(abs(delta)>vec2f(sigma*4.0*elongation+domain.w))){continue;}
    let gaussian=surfaceSourceGaussian(delta,source.direction.xy,sigma,elongation);
    let adjacent=surfaceSourceGaussian(delta+vec2f(domain.w,0),source.direction.xy,sigma,elongation)+surfaceSourceGaussian(delta-vec2f(domain.w,0),source.direction.xy,sigma,elongation)
      +surfaceSourceGaussian(delta+vec2f(0,domain.w),source.direction.xy,sigma,elongation)+surfaceSourceGaussian(delta-vec2f(0,domain.w),source.direction.xy,sigma,elongation);
    let area=source.position.z*source.position.z/(sigma*sigma*elongation);
    // The discrete Laplacian of the SAME compact Gaussian telescopes to zero
    // over an interior footprint. This preserves signed volume on the lattice,
    // unlike sampling a merely continuum-zero Ricker kernel at coarse cells.
    let normalization=sigma*sigma/(domain.w*domain.w*(1.0+1.0/(elongation*elongation)));
    let impulse=(adjacent-4.0*gaussian)*normalization*area*source.position.w;
    kick+=impulse;foamSource+=gaussian*area*source.direction.w;
  }
  let dt=SW.step.x;let lap=(neighbours.x-4.0*old.x)/(domain.w*domain.w);
  let edge=max(abs(p.x-domain.x),abs(p.y-domain.y))/domain.z;
  let absorption=exp(-dt*(.32+5.0*smoothstep(.36,.495,edge)));
  let velocity=clamp((old.y+kick+${SURFACE_WAVE_SPEED*SURFACE_WAVE_SPEED}.0*lap*dt)*absorption,-8.0,8.0);
  let height=clamp((old.x+velocity*dt)*absorption,-2.0,2.0);
  let boundary=select(1.0,0.0,any(q<vec2i(1))||any(q>=size-1));
  let foam=clamp(old.z*exp(-dt*.65)+foamSource*.08,0.0,1.0)*absorption;
  let fresh=clamp(old.w*exp(-dt*2.0)+foamSource*.12,0.0,1.0)*absorption;
  textureStore(surfaceNext,q,layer,vec4f(height,velocity,foam,fresh)*boundary);
}
`;

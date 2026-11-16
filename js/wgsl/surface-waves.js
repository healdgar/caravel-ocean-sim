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
struct SurfaceWakeHull {posVel:vec4f,dims:vec4f};
@group(0)@binding(3)var<storage,read>surfaceSources:array<SurfaceWaveSource>;
@group(0)@binding(4)var<storage,read>surfaceHulls:array<SurfaceWakeHull>;
fn swSqr(x:f32)->f32 { return x * x; }
fn swClean1(x:f32)->f32 {
  let bits = bitcast<u32>(x) & 0x7fffffffu;
  if ((x != x) || !(x == x) || bits >= 0x7f800000u || abs(x) > 1e4) { return 0.0; }
  return x;
}
fn swClean4(v:vec4f)->vec4f {
  return vec4f(swClean1(v.x), swClean1(v.y), swClean1(v.z), swClean1(v.w));
}
fn surfaceOld(q:vec2i,layer:i32,size:vec2i)->vec4f {
  if(SW.step.y>.5||any(q<vec2i(1))||any(q>=size-1)){return vec4f(0);}
  return swClean4(textureLoad(surfacePrevious,q,layer,0));
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
  var old=swClean4(surfaceOld(oldQ,layer,size));
  if(any(old!=old)){old=vec4f(0);}
  var neighbours=swClean4(surfaceOld(oldQ+vec2i(1,0),layer,size)+surfaceOld(oldQ-vec2i(1,0),layer,size)+surfaceOld(oldQ+vec2i(0,1),layer,size)+surfaceOld(oldQ-vec2i(0,1),layer,size));
  if(any(neighbours!=neighbours)){neighbours=vec4f(0);}
  let p=(vec2f(q)+.5-vec2f(size)*.5)*domain.w+domain.xy;
  let packedCounts=u32(max(0.0,SW.step.z)+0.5);
  let sourceCount=packedCounts&255u;
  let hullCount=packedCounts>>8u;
  var kick=0.0;var foamSource=0.0;
  for(var i=0u;i<sourceCount;i++){
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
  var hullForce=0.0;var hullFoamRate=0.0;
  for(var h=0u;h<hullCount;h++){
    let hull=surfaceHulls[h];
    let vel=hull.posVel.zw;
    let speed=length(vel);
    if(speed<0.20){continue;}
    let fwd=vel/speed;
    let right=vec2f(-fwd.y,fwd.x);
    let L=max(hull.dims.x,4.0);
    let B=max(hull.dims.y,1.4);
    let draft=max(hull.dims.z,0.20);
    let isRiver=hull.dims.w<0.0;
    let halfL=L*0.5;
    let halfB=B*0.5;
    let rel=p-hull.posVel.xy;
    let s=dot(rel,fwd);
    let y=abs(dot(rel,right));
    let wakeReach=min(L*2.2+speed*4.5,44.0);
    let maxHalfW=halfB+wakeReach*0.42+domain.w*3.0;
    if(s>halfL+B*1.8+domain.w*2.0||s<-halfL-wakeReach||y>maxHalfW){continue;}
    let uLong=clamp(s/max(halfL,0.5),-1.0,1.0);
    let planform=halfB*clamp(1.0-pow(max(abs(uLong),0.0),2.35)*0.86,0.14,1.0);
    let shoulderW=max(max(0.55,B*0.20),domain.w*1.35);
    let foreEnv=smoothstep(-0.05*halfL,0.35*halfL,s)*(1.0-smoothstep(0.82*halfL,1.12*halfL,s));
    let outDist=y-planform*0.92;
    let bowCrest=exp(-swSqr((outDist-shoulderW*0.25)/(shoulderW*0.72)))*foreEnv;
    let bowHollow=exp(-swSqr((outDist+shoulderW*0.75)/(shoulderW*0.72)))*foreEnv;
    let stemAlong=(s-halfL*0.90)/max(shoulderW*0.85,0.6);
    let stemAcross=y/max(halfB*0.72,domain.w*1.3);
    let stemR2=stemAlong*stemAlong+stemAcross*stemAcross;
    let stemWave=(1.0-stemR2)*exp(-stemR2);
    let sStern=-halfL*0.90;
    let sternLen=max(domain.w*1.6,L*0.085);
    let sternWid=max(domain.w*1.4,halfB*0.75);
    let sternAlong=(s-sStern)/sternLen;
    let sternAcross=y/sternWid;
    let sternTrough=exp(-sternAlong*sternAlong-sternAcross*sternAcross);
    let recDist=clamp(speed*speed*0.32,domain.w*1.8,L*0.38);
    let recLen=max(domain.w*1.8,recDist*0.65);
    let recWid=max(domain.w*1.5,halfB*1.05);
    let recCrest=exp(-swSqr((s-(sStern-recDist))/recLen)-swSqr(y/recWid));
    let recWeight=(sternLen*sternWid)/(recLen*recWid);
    let sApex=halfL*0.78;
    let trailBehind=sApex-s;
    var kelvinForce=0.0;var kelvinFoam=0.0;
    if(trailBehind>0.0&&trailBehind<wakeReach){
      let armCenter=halfB*0.55+trailBehind*0.35355;
      let armWidth=max(domain.w*1.25,shoulderW*0.75+trailBehind*0.045);
      let armPhase=(y-armCenter)/armWidth;
      let armDecay=exp(-trailBehind/max(L*1.15,8.0))*smoothstep(0.0,B*0.45,trailBehind);
      kelvinForce=-armPhase*exp(-0.5*armPhase*armPhase)*1.65*armDecay;
      kelvinFoam=exp(-0.65*armPhase*armPhase)*armDecay;
    }
    let headway=smoothstep(0.20,1.35,speed);
    let draftScale=clamp(draft/0.85,0.38,1.65)*select(1.0,0.65,isRiver);
    let pressureHead=min(0.60,speed*speed/(2.0*9.81)*0.95)*headway*draftScale;
    hullForce+=((bowCrest-bowHollow)*11.5+stemWave*6.5+kelvinForce*5.2)*pressureHead
      +(recCrest*recWeight-sternTrough)*min(0.55,speed*speed*0.042)*headway*draftScale;
    let bowFroth=exp(-swSqr((outDist-shoulderW*0.35)/(shoulderW*1.15)))*foreEnv*smoothstep(-shoulderW*0.35,shoulderW*0.25,outDist);
    let aftTrail=max(0.0,sStern-s);
    let wakeRibbonW=max(domain.w*1.1,halfB*mix(0.58,1.35,clamp(aftTrail/max(L*1.6,6.0),0.0,1.0)));
    let sternWash=select(0.0,exp(-swSqr(y/wakeRibbonW))*exp(-aftTrail/max(L*1.35,7.0)),s<=sStern+domain.w);
    let insideHull=smoothstep(planform*0.92,planform*0.55,y)*smoothstep(halfL*0.92,halfL*0.55,abs(s));
    let speedFoam=smoothstep(0.26,2.1,speed)*select(1.0,0.75,isRiver);
    hullFoamRate+=(bowFroth*2.4+sternTrough*2.2+sternWash*1.65+kelvinFoam*0.95)*speedFoam*(1.0-insideHull*0.85);
  }
  let dt=SW.step.x;let lap=(neighbours.x-4.0*old.x)/(domain.w*domain.w);
  let edge=max(abs(p.x-domain.x),abs(p.y-domain.y))/domain.z;
  let absorption=exp(-dt*(.32+5.0*smoothstep(.36,.495,edge)));
  let velocity=clamp((old.y+kick+(hullForce+${SURFACE_WAVE_SPEED*SURFACE_WAVE_SPEED}.0*lap)*dt)*absorption,-8.0,8.0);
  let height=clamp((old.x+velocity*dt)*absorption,-2.0,2.0);
  let boundary=select(1.0,0.0,any(q<vec2i(1))||any(q>=size-1));
  let foam=clamp(old.z*exp(-dt*.65)+foamSource*.08+hullFoamRate*dt*.85,0.0,1.0)*absorption;
  let fresh=clamp(old.w*exp(-dt*2.0)+foamSource*.12+hullFoamRate*dt*1.35,0.0,1.0)*absorption;
  var outWave=swClean4(vec4f(height,velocity,foam,fresh)*boundary);
  if(any(outWave!=outWave)||any(abs(outWave)>vec4f(1e4))){outWave=vec4f(0.0);}
  textureStore(surfaceNext,q,layer,outWave);
}
`;

// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import {FRAME_WGSL,ATMO_CORE_WGSL,CASCADES} from './common.js';
import {SKY_RENDER_FUNCS} from './sky.js';
import {VESSEL_LIGHTING} from './vessel.js';

export const GUNNERY_CROWN_SEGMENTS=32;
export const GUNNERY_CROWN_ROWS=7;
export const GUNNERY_DROP_COUNT=32;
export const GUNNERY_RING_SEGMENTS=64;
export const GUNNERY_RING_COUNT=6;
export const GUNNERY_EARTH_COUNT=420;
export const GUNNERY_DUST_COUNT=36;

export function GUNNERY_DEPTH_RESOLVE(samples=4){
  const count=Math.max(1,Math.floor(samples));
  return /* wgsl */ `
@group(0)@binding(0)var gunneryDepthSource:${count===1?'texture_depth_2d':'texture_depth_multisampled_2d'};
@group(0)@binding(1)var gunneryDepthTarget:texture_storage_2d<r32float,write>;
@compute @workgroup_size(8,8)fn gunneryResolveDepth(@builtin(global_invocation_id)id:vec3u){
  let size=textureDimensions(gunneryDepthTarget);if(any(id.xy>=size)){return;}
  var depth=0.0;
  for(var sample=0;sample<${count};sample++){depth=max(depth,textureLoad(gunneryDepthSource,vec2i(id.xy),${count===1?'0':'sample'}));}
  textureStore(gunneryDepthTarget,vec2i(id.xy),vec4f(depth));
}`;
}

export const GUNNERY_RENDER=FRAME_WGSL+ATMO_CORE_WGSL+VESSEL_LIGHTING+/* wgsl */ `
@group(0)@binding(0)var<uniform>F:Frame;
@group(0)@binding(1)var transLUT:texture_2d<f32>;
@group(0)@binding(2)var skyLUT:texture_2d<f32>;
@group(0)@binding(3)var sampC:sampler;
@group(0)@binding(4)var envCube:texture_cube<f32>;
@group(0)@binding(5)var<storage,read>sunVis:array<f32,4>;
@group(0)@binding(6)var gunnerySea:texture_2d_array<f32>;
@group(0)@binding(7)var gunnerySeaSampler:sampler;
struct GunneryVolume{centre:vec4f,axisX:vec4f,axisY:vec4f,axisZ:vec4f,optical:vec4f};
struct GunneryBall{positionRadius:vec4f};
struct GunneryContact{root:vec4f,motion:vec4f,detail:vec4f,extra:vec4f};
struct GunneryArcSegment{p0:vec4f,p1:vec4f,style:vec4f};
@group(0)@binding(8)var<storage,read>gunneryVolumes:array<GunneryVolume>;
@group(0)@binding(9)var<storage,read>gunneryBalls:array<GunneryBall>;
@group(0)@binding(10)var<storage,read>gunneryContacts:array<GunneryContact>;
@group(0)@binding(11)var gunnerySceneDepth:texture_2d<f32>;
@group(0)@binding(12)var<storage,read>gunneryArcs:array<GunneryArcSegment>;
`+SKY_RENDER_FUNCS+/* wgsl */ `
fn gunneryCorner(vertex:u32)->vec2f{return array<vec2f,6>(vec2f(0,0),vec2f(1,0),vec2f(0,1),vec2f(0,1),vec2f(1,0),vec2f(1,1))[vertex%6u];}
fn gunneryCube(vertex:u32)->vec3f{
  let points=array<vec3f,8>(vec3f(-1,-1,-1),vec3f(1,-1,-1),vec3f(-1,1,-1),vec3f(1,1,-1),vec3f(-1,-1,1),vec3f(1,-1,1),vec3f(-1,1,1),vec3f(1,1,1));
  let indices=array<u32,36>(0u,2u,1u,1u,2u,3u,4u,5u,6u,5u,7u,6u,0u,4u,2u,2u,4u,6u,1u,3u,5u,3u,7u,5u,0u,1u,4u,1u,5u,4u,2u,6u,3u,3u,6u,7u);
  return points[indices[vertex]];
}
fn gunneryVolumeLocal(v:GunneryVolume,p:vec3f)->vec3f{
  let d=p-v.centre.xyz;return vec3f(dot(d,v.axisX.xyz)/v.axisX.w,dot(d,v.axisY.xyz)/v.axisY.w,dot(d,v.axisZ.xyz)/v.axisZ.w);
}
fn gunneryVolumeRay(v:GunneryVolume,ray:vec3f)->vec3f{return vec3f(dot(ray,v.axisX.xyz)/v.axisX.w,dot(ray,v.axisY.xyz)/v.axisY.w,dot(ray,v.axisZ.xyz)/v.axisZ.w);}
fn gunneryHash3(p:vec3f)->f32{
  var q=fract(p*vec3f(.1031,.1030,.0973));
  q+=dot(q,q.yxz+33.33);
  return fract((q.x+q.y)*q.z);
}
fn gunneryNoise3(p:vec3f)->f32{
  let i=floor(p);let f=fract(p);let u=f*f*(3.0-2.0*f);
  return mix(
    mix(mix(gunneryHash3(i+vec3f(0,0,0)),gunneryHash3(i+vec3f(1,0,0)),u.x),
        mix(gunneryHash3(i+vec3f(0,1,0)),gunneryHash3(i+vec3f(1,1,0)),u.x),u.y),
    mix(mix(gunneryHash3(i+vec3f(0,0,1)),gunneryHash3(i+vec3f(1,0,1)),u.x),
        mix(gunneryHash3(i+vec3f(0,1,1)),gunneryHash3(i+vec3f(1,1,1)),u.x),u.y),
    u.z);
}
fn gunneryCloudFbm(p:vec3f)->f32{
  var q=p;
  let n0=gunneryNoise3(q);q=q*2.07+vec3f(13.7,-7.3,5.1);
  let n1=gunneryNoise3(q);q=q*2.13+vec3f(-9.1,11.3,-17.9);
  let n2=gunneryNoise3(q);
  // Blend smooth value FBM with crisp inverted-ridge cumulus billows for cauliflower crowns.
  let fbm=n0*.52+n1*.31+n2*.17;
  let b0=1.0-abs(n0*2.0-1.0);
  let b1=1.0-abs(n1*2.0-1.0);
  let b2=1.0-abs(n2*2.0-1.0);
  let billow=b0*b0*.52+b1*.33+b2*.15;
  return mix(fbm,billow,.64);
}
fn gunneryLobeKernel(d:vec3f,falloff:f32)->f32{
  let w=max(0.0,1.0-dot(d,d)*(falloff*.34));
  return w*w;
}
fn gunneryMacroBillow(p:vec3f,age:f32,seed:f32)->f32{
  // Morphs from a high-velocity nozzle jet + toroidal vortex ring at discharge
  // into a multi-lobed buoyant cauliflower cumulus plume as it entrains air.
  let jetStage=clamp(1.0-age*.85,0.0,1.0);
  let turn=seed*.71+age*.14;
  let s1=sin(turn);let c1=cos(turn);
  let s2=sin(turn*1.63+2.1);let c2=cos(turn*1.63+2.1);
  // 7 asymmetric rolling cumulus turret lobes using compact quadratic kernels
  let l0=vec3f(c1*.34,.28,s1*.26+.08);
  let l1=vec3f(-s1*.36,-.16,c1*.28-.06);
  let l2=vec3f(s2*.33,.08,-c2*.32);
  let l3=vec3f(-c2*.25,.38,-s2*.24+.12);
  let l4=vec3f(c2*.28,-.26,s1*.31-.14);
  let l5=vec3f(0.0,.42,.18*c1);
  let l6=vec3f(-c1*.18,.12,-.38);
  let lobes=gunneryLobeKernel(p-l0,5.2)
           +gunneryLobeKernel(p-l1,5.6)
           +gunneryLobeKernel(p-l2,5.8)
           +gunneryLobeKernel(p-l3,6.2)
           +gunneryLobeKernel(p-l4,6.4)
           +gunneryLobeKernel(p-l5,5.9)
           +gunneryLobeKernel(p-l6,5.4)*.85;
  if(jetStage<=0.001){return lobes;}
  // Conical muzzle stem (-z to +z) + expanding toroidal vortex head (+z)
  let axial=clamp((p.z+.68)/1.36,0.0,1.0);
  let coneRadius=mix(.22,.56,axial);
  let radial2=dot(p.xy,p.xy);
  let stemW=max(0.0,1.0-radial2/(coneRadius*coneRadius*2.2))*max(0.0,1.0-pow((p.z+.18)/.78,2.0));
  let stem=stemW*stemW;
  let ringMajor=.30+.14*(1.0-jetStage);
  let ringDist=sqrt(radial2)-ringMajor;
  let vortexW=max(0.0,1.0-(ringDist*ringDist+pow(p.z-.22,2.0)*1.35)*3.6);
  let vortexHead=vortexW*vortexW;
  let jet=stem*.85+vortexHead*1.15;
  return mix(lobes,jet+lobes*.65,jetStage*jetStage);
}
fn gunneryDensityAndFbm(local:vec3f,age:f32,seed:f32)->vec2f{
  // Compact support guarantees no cube edge can appear. Multi-octave 3D cloud FBM
  // and billowing cumulus turret lobes create crisp cauliflower cloud contours.
  let r2Init=dot(local,local);
  let support=1.0-smoothstep(.46,1.0,r2Init);if(support<=0.0){return vec2f(0.0,0.0);}
  let drift=age*.38;
  let warp=vec3f(
    sin(local.y*3.6+local.z*2.7+seed+drift)+.45*cos(local.z*6.4-local.x*4.8+seed*1.7),
    cos(local.x*3.3-local.z*3.1-seed*.7+drift*1.15)+.45*sin(local.x*5.9+local.y*5.2-seed),
    sin(local.x*3.8+local.y*2.9-seed+drift*.85)+.45*cos(local.y*6.1-local.z*5.4+seed*2.3)
  )*(.082+.035*clamp(age*.25,0.0,1.0));
  let p=local+warp;
  let r2=dot(p,p);if(r2>=1.0){return vec2f(0.0,0.0);}
  let lobes=gunneryMacroBillow(p,age,seed);
  let macroShape=smoothstep(.08,.76,lobes);
  let fbm=gunneryCloudFbm(p*3.85+vec3f(seed*1.7,-age*.34,seed*2.3));
  let edgeDisperse=mix(.24,.42,clamp(age/14.0,0.0,1.0));
  let erode=smoothstep(.18,.74,macroShape*(.52+fbm*.94)-(1.0-support)*edgeDisperse);
  let crisp=smoothstep(.05,.88,erode);
  return vec2f(support*crisp*(.42+fbm*1.08),fbm);
}
fn gunneryDensity(local:vec3f,age:f32,seed:f32)->f32{
  return gunneryDensityAndFbm(local,age,seed).x;
}
fn gunneryShadowDensity(local:vec3f,age:f32,seed:f32,localFbm:f32)->f32{
  // Fast macro-envelope self-shadowing modulated by local billow FBM (zero extra 3D noise lookups).
  let r2Init=dot(local,local);
  let support=1.0-smoothstep(.46,1.0,r2Init);if(support<=0.0){return 0.0;}
  let lobes=gunneryMacroBillow(local,age,seed);
  return support*smoothstep(.08,.76,lobes)*(.62+.58*localFbm);
}
fn gunnerySceneDistance(pixel:vec2f,ray:vec3f)->f32{
  let size=textureDimensions(gunnerySceneDepth);let uv=clamp(vec2i(pixel),vec2i(0),vec2i(size)-1);
  let depth=textureLoad(gunnerySceneDepth,uv,0).x;if(depth<=0.0){return 1e8;}
  // General camera-relative projection inversion, including the actual near
  // plane. No guessed 0.1/depth conversion or detached screen-space billboard.
  let clipRay=F.viewProj*vec4f(ray,0);let clipOrigin=F.viewProj*vec4f(0,0,0,1);
  return max(0.0,(clipOrigin.z-depth*clipOrigin.w)/(depth*clipRay.w-clipRay.z));
}
fn gunneryHgPhase(cosTheta:f32,g:f32)->f32{
  let g2=g*g;
  return (1.0-g2)/(4.0*PI*pow(max(.01,1.0+g2-2.0*g*cosTheta),1.5));
}
struct GunneryVolumeVertex{@builtin(position)position:vec4f,@location(0)world:vec3f,@location(1)@interpolate(flat)id:u32};
@vertex fn gunneryVolumeVS(@builtin(vertex_index)vertex:u32,@builtin(instance_index)id:u32)->GunneryVolumeVertex{
  let v=gunneryVolumes[id];let c=gunneryCube(vertex);
  let world=v.centre.xyz+v.axisX.xyz*c.x*v.axisX.w+v.axisY.xyz*c.y*v.axisY.w+v.axisZ.xyz*c.z*v.axisZ.w;
  return GunneryVolumeVertex(F.viewProj*vec4f(world-F.camPos.xyz,1),world,id);
}
@fragment fn gunneryVolumeFS(v:GunneryVolumeVertex)->@location(0)vec4f{
  let volume=gunneryVolumes[v.id];let ray=normalize(v.world-F.camPos.xyz);
  let origin=gunneryVolumeLocal(volume,F.camPos.xyz);let direction=gunneryVolumeRay(volume,ray);
  // The density's domain warp stays within this ellipsoid's conservative cube.
  let safe=select(direction,vec3f(.000001),abs(direction)<vec3f(.000001));
  let t0=(-vec3f(1)-origin)/safe;let t1=(vec3f(1)-origin)/safe;
  let low=min(t0,t1);let high=max(t0,t1);
  let enter=max(0.0,max(low.x,max(low.y,low.z)));
  let scene=gunnerySceneDistance(v.position.xy,ray);
  let centreDist=dot(volume.centre.xyz-F.camPos.xyz,ray);
  let minHorizR=min(volume.axisX.w,volume.axisZ.w);
  // Prevent fires and smoke volumes centered inside or behind a building/hull wall from bleeding through the front face of that wall
  if(volume.centre.w>.5 && scene<centreDist-min(0.35,minHorizR*0.28)){discard;}
  if(volume.optical.w>=1.8 && scene<centreDist-minHorizR*0.32){discard;}
  let wallFrontFade=select(1.0,smoothstep(centreDist-minHorizR*0.35,centreDist+0.15,scene),volume.centre.w>.5||volume.optical.w>=1.8);
  let exit=min(scene,min(high.x,min(high.y,high.z)));if(exit<=enter||wallFrontFade<=0.005){discard;}
  let steps=select(8u,6u,enter>45.0);
  let stepSize=(exit-enter)/f32(steps);var transmittance=1.0;var radiance=vec3f(0);
  let jitter=fract(sin(dot(v.position.xy,vec2f(12.9898,78.233))+volume.optical.z)*43758.5453);
  let skyZenith=skyAtmo(vec3f(0,1,0));
  let skyHorizon=skyAtmo(normalize(vec3f(F.sunDir.x,.12,F.sunDir.z)));
  let lightning=lightningLight()*.25;
  let sunlight=sunIlluminance()*sunVis[0]*step(0.0,F.sunDir.y);
  let sunLocal=gunneryVolumeRay(volume,F.sunDir.xyz);
  let sunLocalDir=normalize(sunLocal+vec3f(0.0,1e-5,0.0));
  let opticalScale=clamp(min(volume.axisX.w,volume.axisY.w)*.35,.32,1.25);
  let cosTheta=dot(ray,F.sunDir.xyz);
  // Dual-lobe Henyey-Greenstein phase function (silver-lining forward scatter + cloud back-scatter).
  let phase=mix(gunneryHgPhase(cosTheta,.66),gunneryHgPhase(cosTheta,-.32),.34)*1.95+.09;
  let age=volume.optical.y;
  let sootFactor=exp(-age*1.45);
  let emberFactor=exp(-age*5.5);
  let selfExposure=min(1.0,1.35/max(F.post.x,1e-3));
  for(var sample=0u;sample<steps;sample++){
    let distance=enter+(f32(sample)+.15+.7*jitter)*stepSize;
    let local=origin+direction*distance;
    let df=gunneryDensityAndFbm(local,age,volume.optical.z);
    // Soft intersection margin removes hard slices at timber and sea.
    var density=df.x*smoothstep(0.0,.28,scene-distance)*wallFrontFade;
    if(density<.0015){continue;}
    var emission=vec3f(0);var extinction=volume.optical.x*density;
    let subtype=volume.optical.w;
    if(volume.centre.w>.5){
      if(subtype>=0.9){
        // Shipboard & fort fire (direction=[0,1,0] -> local.z is vertical in [-1, 1])
        let h=clamp(local.z*0.5+0.5,0.0,1.0);
        let isSparkCrown=subtype>1.4;
        let taper=select(mix(1.0,0.28,h*h),mix(0.65,1.15,h),isSparkCrown);
        let swirl=vec2f(sin(h*5.2-age*7.4+volume.optical.z),cos(h*4.8-age*6.3-volume.optical.z))*0.14*h;
        let rHoriz=length(local.xy-swirl)/max(0.20,taper);
        let advectPos=vec3f(local.x*3.1,local.y*3.1,local.z*2.4-age*5.8)+vec3f(volume.optical.z);
        let fTurb=gunneryCloudFbm(advectPos);
        let fineLick=gunneryNoise3(advectPos*2.6+vec3f(0.0,0.0,-age*4.4));
        let tongueMask=clamp(1.12-rHoriz+(fTurb-0.44)*(0.58+0.62*h)+(fineLick-0.5)*0.34,0.0,1.0);
        let vertEnv=smoothstep(0.0,0.14,h)*(1.0-smoothstep(0.56,1.0,h));
        let flameShape=select(tongueMask*vertEnv,clamp(1.0-rHoriz*0.88,0.0,1.0)*smoothstep(0.0,0.22,h)*(1.0-smoothstep(0.65,1.0,h)),isSparkCrown);
        if(flameShape<0.008){continue;}
        let temp=clamp(flameShape*(1.12-0.46*h)+0.26*fTurb+0.16*fineLick,0.0,1.0);
        let colOuter=vec3f(0.68,0.042,0.004);
        let colMid=vec3f(2.25,0.38,0.024);
        let colInner=vec3f(4.45,1.48,0.18);
        let colWhiteHot=vec3f(6.9,3.8,1.25);
        let c1=mix(colOuter,colMid,smoothstep(0.08,0.52,temp));
        let c2=mix(c1,colInner,smoothstep(0.48,0.84,temp));
        let colCore=mix(c2,colWhiteHot,smoothstep(0.78,0.98,temp)*(1.0-smoothstep(0.0,0.45,h)));
        // Buoyant glowing embers & flying sparks
        let sparkPos=advectPos*4.8+vec3f(sin(age*3.7)*0.8,cos(age*4.1)*0.8,-age*7.2);
        let sparkN1=gunneryNoise3(sparkPos);
        let sparkN2=gunneryNoise3(sparkPos*2.1+vec3f(13.7,7.1,3.9));
        let sparkMask=smoothstep(0.76,0.93,sparkN1)*smoothstep(0.52,0.82,sparkN2);
        let sparks=select(sparkMask*h*1.6,sparkMask*(0.6+1.8*h),subtype>1.1);
        let nightFlameBoost=1.0+0.65*(1.0-smoothstep(-0.08,0.14,F.sunDir.y));
        let flameEmit=select(colCore*flameShape*(1.05-0.25*step(1.15,subtype)),colCore*flameShape*0.28,isSparkCrown);
        emission=(flameEmit+vec3f(3.6,0.92,0.09)*sparks)*clamp(volume.optical.x,0.35,1.35)*selfExposure*nightFlameBoost;
        extinction=density*select(flameShape*5.6,max(flameShape*1.8,sparks*3.2),isSparkCrown);
      }else{
        let flame=max(0.0,1.0-dot(local,local));
        let coreNoise=.65+.35*df.y;
        emission=mix(vec3f(2.2,0.32,.025),vec3f(5.2,1.45,0.22),flame*flame*coreNoise)*volume.optical.x*selfExposure;
        extinction=density*4.2;
      }
    }else{
      // Two finite sunlight steps in normalized [-1, 1] local space + Beer-Powder
      // multi-scattering create crisp cauliflower self-shadowing with minimal ALU cost.
      let d1=gunneryShadowDensity(local+sunLocalDir*.24,age,volume.optical.z,df.y)*.28;
      let d2=gunneryShadowDensity(local+sunLocalDir*.58,age,volume.optical.z,df.y)*.42;
      let shadowDepth=(d1+d2)*volume.optical.x*opticalScale;
      let beer=exp(-shadowDepth*.95);
      let multiScatter=exp(-shadowDepth*.26)*.44;
      let powder=1.0-.58*exp(-shadowDepth*2.6);
      let directTransfer=(beer*powder+multiScatter)*phase;
      let isFireSmoke=subtype>=1.8;
      let heightGrad=clamp(select(local.y,local.z,isFireSmoke)*.5+.5,0.0,1.0);
      let radialRim=clamp(length(local)*1.08,0.0,1.0);
      let ambientOcclusion=mix(.42,1.0,clamp(heightGrad*.65+radialRim*.35,0.0,1.0));
      let ambient=(mix(skyHorizon*.42,skyZenith*.78,heightGrad)+lightning)*ambientOcclusion;
      // Black powder smoke transitions from warm charcoal soot at discharge to
      // potassium-sulfate chalky white cumulus; shipboard pitch/tar fires emit
      // dense dark charcoal/black smoke under-lit by roaring flames below.
      let effSoot=select(sootFactor,0.94,isFireSmoke);
      let shadowTint=select(
        mix(vec3f(.62,.66,.72),vec3f(.34,.33,.32),effSoot*.75),
        vec3f(.11,.10,.10),
        isFireSmoke
      );
      let litTint=select(
        mix(vec3f(.96,.94,.90),vec3f(.58,.54,.50),effSoot*.55),
        vec3f(.24,.22,.20),
        isFireSmoke
      );
      let cloudAlbedo=mix(shadowTint,litTint,clamp(beer+.22,0.0,1.0));
      let throatCore=max(0.0,1.0-length(local-vec3f(0.0,-.05,-.28))*1.45);
      let fireUnderGlow=select(
        0.0,
        (1.0-smoothstep(0.0,0.78,heightGrad))*max(0.0,1.0-length(local.xy)*0.98)*(0.58+0.42*df.y)*max(0.22,2.75-subtype)*(1.0+0.6*(1.0-smoothstep(-0.08,0.14,F.sunDir.y))),
        isFireSmoke
      );
      let internalEmber=(vec3f(2.4,0.42,.03)*(emberFactor*throatCore*throatCore*density)+vec3f(1.15,0.22,0.018)*(fireUnderGlow*density))*selfExposure;
      emission=cloudAlbedo*(ambient+sunlight*directTransfer)+internalEmber;
    }
    let opacity=1.0-exp(-extinction*stepSize);
    radiance+=transmittance*opacity*emission;transmittance*=1.0-opacity;
    if(transmittance<.035){break;}
  }
  let alpha=1.0-transmittance;if(alpha<.002){discard;}
  let averageWorld=F.camPos.xyz+ray*(enter+exit)*.5;
  return vec4f(surfaceAir(radiance/max(alpha,.0001),averageWorld)*alpha,alpha);
}

struct GunneryBallVertex{@builtin(position)position:vec4f,@location(0)world:vec3f,@location(1)normal:vec3f,@location(2)hot:f32};
@vertex fn gunneryBallVS(@builtin(vertex_index)vertex:u32,@builtin(instance_index)id:u32)->GunneryBallVertex{
  let ball=gunneryBalls[id].positionRadius;let cell=vertex/6u;let uv=gunneryCorner(vertex);
  let longitude=(f32(cell%12u)+uv.x)*(2.0*PI)/12.0;let latitude=(f32(cell/12u)+uv.y)*PI/8.0;
  let r=abs(ball.w);let isHot=select(0.0,1.0,ball.w<0.0);
  let normal=vec3f(cos(longitude)*sin(latitude),cos(latitude),sin(longitude)*sin(latitude));let world=ball.xyz+normal*r;
  return GunneryBallVertex(F.viewProj*vec4f(world-F.camPos.xyz,1),world,normal,isHot);
}
@fragment fn gunneryBallFS(v:GunneryBallVertex)->@location(0)vec4f{
  let n=normalize(v.normal);let eye=normalize(F.camPos.xyz-v.world);
  if(v.hot>0.5){
    let core=clamp(dot(n,eye),0.0,1.0);
    let hotGlow=mix(vec3f(1.6,0.25,0.025),vec3f(3.8,0.95,0.12),core*core)*min(1.0,1.35/max(F.post.x,1e-3));
    return vec4f(surfaceAir(hotGlow,v.world),1);
  }
  let sky=textureSampleLevel(envCube,sampC,vec3f(0,1,0),8.0).rgb;let sea=textureSampleLevel(envCube,sampC,vec3f(0,-.4,1),8.0).rgb;
  let direct=sunIlluminance()*sunVis[0]*step(0.0,F.sunDir.y);let nl=max(0.0,dot(n,F.sunDir.xyz));
  let albedo=vec3f(.038,.034,.029);let light=albedo*(vesselAmbient(n,sky,sea)+direct*nl/PI)+vesselSpecular(n,eye,F.sunDir.xyz,.62,vec3f(.045))*direct*nl;
  return vec4f(surfaceAir(light+lightningSurface(n,eye,albedo,.62),v.world),1);
}

fn gunnerySeaDisplacement(q:vec2f)->vec3f{
  var d=vec3f(0);for(var c=0u;c<${CASCADES}u;c++){d+=textureSampleLevel(gunnerySea,gunnerySeaSampler,q*F.cascInvL[c>>2u][c&3u],i32(c),0.0).xyz;}return d;
}
fn gunnerySeaHeight(p:vec2f)->f32{var q=p;for(var i=0u;i<2u;i++){q=p-gunnerySeaDisplacement(q).xz;}return gunnerySeaDisplacement(q).y;}
fn gunneryContactHeading(c:GunneryContact)->vec2f{let horizontal=c.motion.xz;return normalize(horizontal+vec2f(.00001));}
fn gunneryImpactLift(c:GunneryContact)->f32{return clamp(3.0+abs(c.motion.y)*.14+length(c.motion.xyz)*.010,3.8,7.8)*sqrt(c.motion.w);}
fn gunneryImpactRadial(c:GunneryContact)->f32{return clamp(1.2+length(c.motion.xyz)*.008,1.4,3.4)*sqrt(c.motion.w);}
fn gunneryEarthAlbedo(c:GunneryContact)->vec3f{return mix(vec3f(.12,.08,.052),vec3f(.3,.235,.16),c.extra.z);}
fn gunneryWaterRadiance(world:vec3f,normal:vec3f,foam:f32)->vec3f{
  let eye=normalize(F.camPos.xyz-world);var n=normalize(normal);if(dot(n,eye)<0.0){n=-n;}
  let direct=sunIlluminance()*sunVis[0]*step(0.0,F.sunDir.y);
  let reflected=textureSampleLevel(envCube,sampC,reflect(-eye,n),1.2).rgb;
  let nightFloor=vec3f(0.012,0.018,0.028)*min(1.0,1.2/max(F.post.x,1e-3))*(1.0-smoothstep(-0.08,0.12,F.sunDir.y));
  var fireGlow=vec3f(0.0);
  if(F.cascInvL[1].z>1e-5){
    let fPos=vec3f(F.camRight.w,F.camUp.w,F.camFwd.w);
    let fd0=max(1.2,length(fPos-world));
    fireGlow+=vec3f(1.0,0.38,0.07)*(F.cascInvL[1].z*12.0/(4.0+fd0*fd0*0.25));
  }
  let diffuse=skyAtmo(vec3f(0,1,0))*.72+direct*max(F.sunDir.y,.10)*.28+lightningLight()*.3+nightFloor+fireGlow;
  let glint=vesselSpecular(n,eye,F.sunDir.xyz,.16,vec3f(.0204))*direct*max(0.0,dot(n,F.sunDir.xyz));
  return mix(reflected*.88+glint+fireGlow*0.35,diffuse*1.12,foam);
}
struct GunneryWaterVertex{@builtin(position)position:vec4f,@location(0)world:vec3f,@location(1)uv:vec2f,@location(2)@interpolate(flat)id:u32};
// The initial crown combines an outer tulip splash rim and a tall central Worthington
// water column launched from the impact cavity.
@vertex fn gunneryCrownVS(@builtin(vertex_index)vertex:u32,@builtin(instance_index)id:u32)->GunneryWaterVertex{
  let c=gunneryContacts[id];let age=c.root.w;let uv=gunneryCorner(vertex);let cell=vertex/6u;
  // Ground goes up in pieces, not in a sheet.
  if(c.extra.y>0.0){return GunneryWaterVertex(vec4f(0.0,0.0,-1.0,1.0),vec3f(0.0),vec2f(0.0),id);}
  let angle=(f32(cell%${GUNNERY_CROWN_SEGMENTS}u)+uv.x)*(2.0*PI)/${GUNNERY_CROWN_SEGMENTS}.0;
  let row=(f32(cell/${GUNNERY_CROWN_SEGMENTS}u)+uv.y)/${GUNNERY_CROWN_ROWS}.0;
  let lift=gunneryImpactLift(c);let radial=gunneryImpactRadial(c);let heading=gunneryContactHeading(c);let side=vec2f(heading.y,-heading.x);
  let lobe=.86+.09*sin(angle*5.0+c.detail.x*70.0)+.05*sin(angle*11.0-c.detail.x*43.0);
  let radius=(.12+radial*age*(0.18+0.42*pow(row,1.25)))*c.motion.w;
  let drift=heading*min(8.0,length(c.motion.xz)*.018)*age;
  let horizontal=side*cos(angle)*radius+heading*sin(angle)*radius*1.12+drift*row;
  let rise=max(0.0,lift*age-4.905*age*age)*pow(max(0.02,row),0.82)*lobe;
  let baseY=select(gunnerySeaHeight(c.root.xz+horizontal),c.root.y,c.extra.x>.5);
  let world=vec3f(c.root.x+horizontal.x,baseY+.02+rise,c.root.z+horizontal.y);
  return GunneryWaterVertex(F.viewProj*vec4f(world-F.camPos.xyz,1),world,vec2f(angle,row),id);
}
@fragment fn gunneryCrownFS(v:GunneryWaterVertex)->@location(0)vec4f{
  let c=gunneryContacts[v.id];let age=c.root.w;let life=min(1.45,gunneryImpactLift(c)/4.905);
  if(age>=life||age<=0.0){discard;}
  let kind=c.extra.x;
  let nVal=gunneryCloudFbm(v.world*1.65+vec3f(c.detail.x*13.0,-age*4.2,c.detail.x*29.0));
  let topFade=1.0-smoothstep(0.48,0.96,v.uv.y+0.24*(1.0-nVal));
  let botFade=smoothstep(0.0,0.18,v.uv.y);
  let lifeFade=smoothstep(0.0,.03,age)*(1.0-smoothstep(life*.45,life,age));
  let spray=smoothstep(0.26,0.78,nVal+0.22*(1.0-v.uv.y));
  let foam=clamp(.52+0.38*spray,0.0,1.0);
  let baseAlpha=topFade*botFade*spray*lifeFade*0.64;
  let alpha=select(min(0.76,baseAlpha),min(0.95,baseAlpha*1.35),kind>.5);
  if(alpha<.002){discard;}
  let n=normalize(vec3f(v.world.x-c.root.x,max(0.35,0.65*c.motion.w),v.world.z-c.root.z));
  let waterRad=gunneryWaterRadiance(v.world,n,foam);
  let direct=sunIlluminance()*sunVis[0]*step(0.0,F.sunDir.y);
  let ambient=skyAtmo(vec3f(0,1,0))*.6+direct*max(F.sunDir.y,.08)*.25+lightningLight()*.25;
  let solidAlbedo=select(select(vec3f(.46,.33,.20),vec3f(.52,.44,.32),kind>1.5),vec3f(.68,.62,.54),kind>2.5);
  let rad=select(waterRad,solidAlbedo*ambient,kind>.5);
  return vec4f(surfaceAir(rad,v.world)*alpha,alpha);
}
@vertex fn gunneryDropVS(@builtin(vertex_index)vertex:u32,@builtin(instance_index)instance:u32)->GunneryWaterVertex{
  let id=instance/${GUNNERY_DROP_COUNT}u;let c=gunneryContacts[id];let drop=f32(instance%${GUNNERY_DROP_COUNT}u);let age=c.root.w;
  let random=fract(sin(drop*17.137+c.detail.x*73.0)*437.1);let angle=drop*2.399963+c.detail.x*63.0;
  let heading=gunneryContactHeading(c);let side=vec2f(heading.y,-heading.x);let radial=gunneryImpactRadial(c)*(.6+random*.55);
  let across=side*cos(angle)*radial+heading*sin(angle)*radial+heading*min(12.0,length(c.motion.xz)*.025);
  let launch=vec3f(across.x,gunneryImpactLift(c)*(.65+random*.4),across.y);
  // Analytic aerodynamic drift grows gradually; gravity remains 9.81 m/s².
  let wind=c.detail.yzw*(age-.7*(1.0-exp(-age/.7)))*.16;
  let world=c.root.xyz+launch*age+vec3f(0,.04-4.905*age*age,0)+wind;
  let corner=gunneryCorner(vertex)*2.0-1.0;
  let kindBoost=select(1.45,2.15,c.extra.x>.5);
  // Thrown earth flies as the clods below.
  let radius=(.018+random*.036)*c.motion.w*kindBoost*select(1.0,0.0,c.extra.y>0.0);
  let eye=normalize(F.camPos.xyz-world);let right=normalize(F.camRight.xyz);let up=normalize(F.camUp.xyz);
  let surface=world+(right*corner.x+up*corner.y)*radius;
  return GunneryWaterVertex(F.viewProj*vec4f(surface-F.camPos.xyz,1),surface,corner,id);
}
@fragment fn gunneryDropFS(v:GunneryWaterVertex)->@location(0)vec4f{
  let c=gunneryContacts[v.id];let radius=dot(v.uv,v.uv);
  let minHeight=c.root.y-select(0.0,6.5,c.extra.x>.5);
  if(radius>=1.0||c.root.w>3.4||v.world.y<minHeight){discard;}
  let eye=normalize(F.camPos.xyz-v.world);let n=normalize(normalize(F.camRight.xyz)*v.uv.x+normalize(F.camUp.xyz)*v.uv.y+eye*sqrt(max(.001,1.0-radius)));
  let alpha=(1.0-smoothstep(.3,1.0,radius))*.78;
  let kind=c.extra.x;
  let waterRad=gunneryWaterRadiance(v.world,n,.72);
  let direct=sunIlluminance()*sunVis[0]*step(0.0,F.sunDir.y);
  let ambient=skyAtmo(vec3f(0,1,0))*.55+direct*max(dot(n,F.sunDir.xyz),.12)*.32+lightningLight()*.25;
  let fragAlbedo=select(select(vec3f(.38,.24,.12),vec3f(.44,.36,.25),kind>1.5),vec3f(.64,.42,.28),kind>2.5);
  let rad=select(waterRad,fragAlbedo*ambient,kind>.5);
  return vec4f(surfaceAir(rad,v.world)*alpha,alpha);
}
// Earth thrown by a strike on the ground OR 420 ballistic whitewater spray jets & droplets on water impacts.
@vertex fn gunneryEarthVS(@builtin(vertex_index)vertex:u32,@builtin(instance_index)instance:u32)->GunneryWaterVertex{
  let id=instance/${GUNNERY_EARTH_COUNT}u;let c=gunneryContacts[id];let age=c.root.w;
  var o=GunneryWaterVertex(vec4f(0.0,0.0,-1.0,1.0),vec3f(0.0),vec2f(0.0),id);
  let isWater=c.extra.x<.5;
  let pit=select(c.extra.y,max(0.85,c.motion.w*1.55),isWater);
  if(pit<=0.0){return o;}
  let n=f32(instance%${GUNNERY_EARTH_COUNT}u);
  let r1=fract(sin(n*12.9898+c.detail.x*78.233)*43758.5453);
  let r2=fract(sin(n*39.3461+c.detail.x*11.135)*24634.6345);
  let r3=fract(sin(n*73.1563+c.detail.x*51.721)*17431.1953);
  let r4=fract(sin(n*91.2271+c.detail.x*29.417)*31158.8231);
  let heading=gunneryContactHeading(c);let side=vec2f(heading.y,-heading.x);
  let flatness=1.0-abs(c.motion.y)/max(length(c.motion.xyz),.001);
  let start=mix(.16,1.0,sqrt(r1));
  let speed=select(
    sqrt(9.81*pit)*1.05*pow(start,-.95)*(.65+r2*.7),
    gunneryImpactLift(c)*mix(0.48,1.38,pow(1.0-r1,0.55))*(0.68+r2*0.58),
    isWater
  );
  let turn=n*2.399963+c.detail.x*63.0;
  let fwdBias=select(flatness*.75,flatness*0.65*smoothstep(0.35,0.95,r1),isWater);
  let outward=normalize(side*cos(turn)+heading*(sin(turn)+fwdBias)+vec2f(.0001));
  let elevation=select(mix(.8,1.3,r3),mix(0.88,1.48,mix(r3,1.0-r1*0.65,0.55)),isWater);
  let up=sin(elevation)*speed;let along=cos(elevation)*speed;
  let flight=2.0*up/9.81;
  if(age<=0.0||age>=flight+.08){return o;}
  let rise=up*age-4.905*age*age;
  let wind=c.detail.yzw*(age-.7*(1.0-exp(-age/.7)))*select(.05,.14,isWater);
  let radStart=select(start*pit*.55,start*0.35*c.motion.w,isWater);
  let centre=c.root.xyz+vec3f(outward.x*(radStart+along*age),rise,outward.y*(radStart+along*age))+wind;
  let corner=gunneryCorner(vertex)*2.0-1.0;
  let spin=age*(2.0+r2*9.0)+r1*6.28;
  let turned=vec2f(corner.x*cos(spin)-corner.y*sin(spin),corner.x*sin(spin)+corner.y*cos(spin));
  let size=select(
    mix(.022,.13,r4*r4*r4)*sqrt(pit/1.2),
    mix(.038,.165,r4*r4)*sqrt(c.motion.w)*(1.0+0.35*sin(age/max(flight,0.1)*PI)),
    isWater
  );
  let stretchY=select(1.0,1.45,isWater);
  let world=centre+(normalize(F.camRight.xyz)*turned.x+normalize(F.camUp.xyz)*turned.y*stretchY)*size;
  o.position=F.viewProj*vec4f(world-F.camPos.xyz,1.0);
  o.world=world;
  o.uv=corner;
  return o;
}
@fragment fn gunneryEarthFS(v:GunneryWaterVertex)->@location(0)vec4f{
  let c=gunneryContacts[v.id];
  let along=atan2(v.uv.y,v.uv.x);
  let edge=.72+.14*sin(along*3.0+v.world.x*40.0)+.1*sin(along*5.0-v.world.z*50.0);
  let radius=length(v.uv)/edge;if(radius>=1.0){discard;}
  let right=normalize(F.camRight.xyz);let up=normalize(F.camUp.xyz);let eye=normalize(F.camPos.xyz-v.world);
  let n=normalize(right*v.uv.x+up*v.uv.y+eye*sqrt(max(.04,1.0-radius*radius)));
  let direct=sunIlluminance()*sunVis[0]*step(0.0,F.sunDir.y);
  if(c.extra.x<.5){
    if(v.world.y<c.root.y-0.15){discard;}
    let wAlpha=(1.0-smoothstep(0.25,1.0,radius))*0.82;
    let wLit=skyAtmo(vec3f(0,1,0))*.85+direct*(.32+.68*max(dot(n,F.sunDir.xyz),.0))/PI+lightningLight()*.3;
    return vec4f(surfaceAir(vec3f(.94,.97,1.0)*wLit,v.world)*wAlpha,wAlpha);
  }
  let lit=skyAtmo(vec3f(0,1,0))*.6+direct*max(dot(n,F.sunDir.xyz),.0)/PI+lightningLight()*.25;
  return vec4f(surfaceAir(gunneryEarthAlbedo(c)*lit,v.world),1.0);
}
// The dust that goes up with a ground strike OR rising sea-spray mist & churning whitewater boil on water impacts.
struct GunneryDustVertex{@builtin(position)position:vec4f,@location(0)world:vec3f,@location(1)uv:vec2f,@location(2)@interpolate(flat)id:u32,@location(3)@interpolate(flat)alpha:f32,@location(4)@interpolate(flat)seed:f32};
@vertex fn gunneryDustVS(@builtin(vertex_index)vertex:u32,@builtin(instance_index)instance:u32)->GunneryDustVertex{
  let id=instance/${GUNNERY_DUST_COUNT}u;let c=gunneryContacts[id];let age=c.root.w;
  var o=GunneryDustVertex(vec4f(0.0,0.0,-1.0,1.0),vec3f(0.0),vec2f(0.0),id,0.0,0.0);
  let isWater=c.extra.x<.5;
  let pit=select(c.extra.y,max(1.0,c.motion.w*1.65),isWater);
  if(pit<=0.0||age<=0.0){return o;}
  let n=f32(instance%${GUNNERY_DUST_COUNT}u);
  let r1=fract(sin(n*14.1731+c.detail.x*61.37)*43758.5453);
  let r2=fract(sin(n*47.2389+c.detail.x*23.91)*24634.6345);
  let r3=fract(sin(n*83.6127+c.detail.x*47.53)*17431.1953);
  let r4=fract(sin(n*29.8153+c.detail.x*91.27)*31158.8231);
  let decayTau=select(.55+r4*1.1,.65+r4*.85,isWater);
  let baseOp=select(.13,.15,isWater);
  o.alpha=baseOp*smoothstep(0.0,.04,age)*exp(-age/decayTau);
  if(o.alpha<.003){return o;}
  let size=pit/1.2;
  let heading=gunneryContactHeading(c);let side=vec2f(heading.y,-heading.x);
  let flatness=1.0-abs(c.motion.y)/max(length(c.motion.xyz),.001);
  let turn=n*2.399963+c.detail.x*29.0;
  let outward=normalize(side*cos(turn)+heading*(sin(turn)+flatness*.6)+vec2f(.0001));
  let flung=1.0-exp(-age/.42);
  let isSurfaceBoil=isWater&&n<14.0;
  let far=select(mix(.8,7.5,r1*r1)*size*.42*flung,mix(0.22,2.6,r1)*size*0.48*flung,isSurfaceBoil);
  let high=select(
    mix(.5,8.0,r2*r2*r2)*size*.6*flung+.12*age,
    select((0.4+3.6*pow(r2,1.6))*size*flung*(1.0-0.35*smoothstep(0.7,2.0,age)),0.06+0.20*r2,isSurfaceBoil),
    isWater
  );
  let wind=c.detail.yzw*(age-.7*(1.0-exp(-age/.7)))*.22;
  let radius=select((.22+.95*sqrt(age)*(.55+r3*.8))*size,(.28+.85*sqrt(age)*(.55+r3*.65))*size,isWater);
  let centre=vec3f(c.root.x+outward.x*far,c.root.y+high+radius*select(.35,.18,isSurfaceBoil),c.root.z+outward.y*far)+wind;
  let corner=gunneryCorner(vertex)*2.0-1.0;
  let world=centre+(normalize(F.camRight.xyz)*corner.x+normalize(F.camUp.xyz)*corner.y)*radius;
  o.position=F.viewProj*vec4f(world-F.camPos.xyz,1.0);
  o.world=world;o.uv=corner;o.seed=r3*37.0+n;
  return o;
}
@fragment fn gunneryDustFS(v:GunneryDustVertex)->@location(0)vec4f{
  let c=gunneryContacts[v.id];
  let d=dot(v.uv,v.uv);if(d>=1.0){discard;}
  let wisps=.62+.5*gnoise(v.uv*1.7+v.seed)+.28*gnoise(v.uv*4.1-v.seed);
  let alpha=clamp(v.alpha*(1.0-d)*(1.0-d)*wisps*2.0,0.0,1.0);
  if(alpha<.002){discard;}
  let right=normalize(F.camRight.xyz);let up=normalize(F.camUp.xyz);let eye=normalize(F.camPos.xyz-v.world);
  let n=normalize(right*v.uv.x+up*v.uv.y+eye*sqrt(max(.05,1.0-d)));
  let direct=sunIlluminance()*sunVis[0]*step(0.0,F.sunDir.y);
  let lit=skyAtmo(vec3f(0,1,0))*.7+direct*(.35+.65*max(dot(n,F.sunDir.xyz),0.0))/PI+lightningLight()*.25;
  if(c.extra.x<.5){
    return vec4f(surfaceAir(vec3f(.92,.96,1.0)*lit*1.22,v.world)*alpha,alpha);
  }
  return vec4f(surfaceAir(mix(vec3f(.3,.235,.17),vec3f(.62,.53,.4),c.extra.z)*lit,v.world)*alpha,alpha);
}
@vertex fn gunneryRingVS(@builtin(vertex_index)vertex:u32,@builtin(instance_index)id:u32)->GunneryWaterVertex{
  let c=gunneryContacts[id];let ring=vertex/(${GUNNERY_RING_SEGMENTS}u*6u);let uv=gunneryCorner(vertex);let segment=(vertex/6u)%${GUNNERY_RING_SEGMENTS}u;
  let age=c.root.w-f32(ring)*.24;let angle=(f32(segment)+uv.x)*(2.0*PI)/${GUNNERY_RING_SEGMENTS}.0;
  let crossSection=uv.y*2.0-1.0;
  let waveSpeed=(3.2-f32(ring)*.22)*sqrt(max(0.5,c.motion.w));
  let bandHalfWidth=.44+max(0.0,age)*.16;
  let wobble=(sin(angle*5.0+c.detail.x*37.0+f32(ring)*1.9)*.14+cos(angle*11.0-c.detail.x*23.0+max(0.0,age)*2.2)*.08)*(.35+.65*clamp(age,0.0,1.0));
  let radius=(.26+max(0.0,age)*waveSpeed)*(1.0+wobble)+crossSection*bandHalfWidth;
  let q=c.root.xz+vec2f(cos(angle),sin(angle))*radius;
  let waveProfile=cos(crossSection*1.5707963);
  let crest=waveProfile*(.26+.18*exp(-max(0.0,age)*1.1))*c.motion.w*exp(-max(0.0,age)*.45)*exp(-f32(ring)*.28)*step(0.0,age);
  let world=vec3f(q.x,gunnerySeaHeight(q)+.024+crest,q.y);
  return GunneryWaterVertex(F.viewProj*vec4f(world-F.camPos.xyz,1),world,vec2f(crossSection,angle),id*${GUNNERY_RING_COUNT}u+ring);
}
@fragment fn gunneryRingFS(v:GunneryWaterVertex)->@location(0)vec4f{
  let c=gunneryContacts[v.id/${GUNNERY_RING_COUNT}u];if(c.extra.x>.5){discard;}
  let ring=v.id%${GUNNERY_RING_COUNT}u;let age=c.root.w-f32(ring)*.24;if(age<=0.0||age>=6.5){discard;}
  let edge=pow(max(0.0,1.0-abs(v.uv.x)),1.65);
  let nVal=gunneryCloudFbm(vec3f(cos(v.uv.y)*2.4+v.world.x*.35,sin(v.uv.y)*2.4+v.world.z*.35,age*.85+f32(ring)*1.7+c.detail.x*19.0));
  let ringFade=exp(-f32(ring)*.52);
  let broken=smoothstep(0.22+0.26*(1.0-ringFade),0.78,nVal);
  let crestFoam=clamp(exp(-age*.55)*ringFade*.88+.14*broken,0.12,0.92);
  let alpha=edge*broken*ringFade*exp(-age*.48)*smoothstep(0.0,.06,age)*(1.0-smoothstep(4.5,6.5,age))*.54;
  if(alpha<.002){discard;}
  let n=normalize(cross(dpdy(v.world),dpdx(v.world)));
  return vec4f(surfaceAir(gunneryWaterRadiance(v.world,n,crestFoam),v.world)*alpha,alpha);
}
struct GunneryArcVertex{
  @builtin(position)position:vec4f,
  @location(0)world:vec3f,
  @location(1)uv:vec2f,
  @location(2)@interpolate(flat)id:u32
};
@vertex fn gunneryArcVS(@builtin(vertex_index)vertex:u32,@builtin(instance_index)id:u32)->GunneryArcVertex{
  let seg=gunneryArcs[id];
  let corner=gunneryCorner(vertex);
  let isRing=seg.style.w>.5;
  if(isRing){
    // Surface-aligned impact ring quad centered at p0.xyz, normal in p1.xyz, outer radius in p0.w
    let center=seg.p0.xyz;
    let radius=max(.25,seg.p0.w);
    let n=normalize(seg.p1.xyz+vec3f(0.0,1e-5,0.0));
    let helper=select(vec3f(0.0,1.0,0.0),vec3f(1.0,0.0,0.0),abs(n.y)>.92);
    let tangent=normalize(cross(helper,n));
    let bitangent=cross(n,tangent);
    let localUV=corner*2.0-1.0;
    let world=center+(tangent*localUV.x+bitangent*localUV.y)*radius+n*.06;
    return GunneryArcVertex(F.viewProj*vec4f(world-F.camPos.xyz,1.0),world,localUV,id);
  }
  // 3D aerial trajectory ribbon segment from p0.xyz to p1.xyz
  let p=mix(seg.p0.xyz,seg.p1.xyz,corner.x);
  let dir=normalize(seg.p1.xyz-seg.p0.xyz+vec3f(0.0,1e-5,0.0));
  let toCam=normalize(F.camPos.xyz-p);
  var side=cross(dir,toCam);
  let sideLen=length(side);
  if(sideLen<1e-4){side=vec3f(0.0,1.0,0.0);}else{side/=sideLen;}
  let camDist=length(F.camPos.xyz-p);
  let halfWidth=max(seg.p0.w,.0022*camDist);
  let across=(corner.y*2.0-1.0);
  let world=p+side*across*halfWidth;
  let u=mix(seg.p1.w,seg.style.x,corner.x);
  return GunneryArcVertex(F.viewProj*vec4f(world-F.camPos.xyz,1.0),world,vec2f(u,across),id);
}
@fragment fn gunneryArcFS(v:GunneryArcVertex)->@location(0)vec4f{
  let seg=gunneryArcs[v.id];
  let kind=seg.style.z;
  let baseAlpha=seg.style.y;
  let isRing=seg.style.w>.5;
  // Color palette by predicted target zone:
  // 0 = water (warm gold), 1 = ship hull (emerald green), 2 = rigging/sails (bright cyan),
  // 3 = land/fort (fiery orange-red), 4 = live instantaneous roll arc (ice blue)
  var tint=vec3f(1.0,.78,.24);
  if(kind>.5&&kind<1.5){tint=vec3f(.22,1.0,.52);}
  else if(kind>=1.5&&kind<2.5){tint=vec3f(.24,.88,1.0);}
  else if(kind>=2.5&&kind<3.5){tint=vec3f(1.0,.42,.18);}
  else if(kind>=3.5){tint=vec3f(.55,.78,1.0);}
  let sunScale=.85+.25*sunVis[0];
  // They are a guide, not a lamp. Night exposure runs thousands of times higher than day's, so undo it, and keep
  // well under what would dazzle eyes used to the dark, whichever way the night was reached.
  let night=1.0-smoothstep(-.06,.16,F.sunDir.y);
  let glow=tint*(2.4*sunScale+.6*max(0.0,F.sunDir.y))*min(1.0,1.35/max(F.post.x,1e-3))*mix(1.0,.1,night);
  if(isRing){
    let r=length(v.uv);
    if(r>1.0){discard;}
    let outerRing=exp(-pow((r-.84)/.075,2.0));
    let innerRing=exp(-pow((r-.38)/.065,2.0))*.72;
    let centerDot=exp(-pow(r/.11,2.0))*.85;
    let crossHair=exp(-pow(min(abs(v.uv.x),abs(v.uv.y))/.035,2.0))*smoothstep(.18,.82,r)*step(r,.92)*.48;
    let pulse=.82+.18*sin(F.camPos.w*4.2-r*6.28318);
    let alpha=clamp((outerRing+innerRing+centerDot+crossHair)*baseAlpha*pulse,0.0,1.0);
    if(alpha<.004){discard;}
    return vec4f(surfaceAir(glow,v.world)*alpha,alpha);
  }
  let edge=1.0-smoothstep(.25,1.0,abs(v.uv.y));
  let u=v.uv.x;
  // Animated directional dashes flowing from muzzle to target + solid core filament
  let flow=fract(u*14.0-F.camPos.w*1.65);
  let dash=.38+.62*smoothstep(.15,.55,flow)*(1.0-smoothstep(.78,.96,flow));
  let endFade=smoothstep(0.0,.03,u)*(1.0-smoothstep(.94,1.0,u)*.35);
  let alpha=clamp(edge*dash*endFade*baseAlpha,0.0,1.0);
  if(alpha<.003){discard;}
  return vec4f(surfaceAir(glow,v.world)*alpha,alpha);
}
`;

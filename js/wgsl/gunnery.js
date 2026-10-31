// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import {FRAME_WGSL,ATMO_CORE_WGSL,CASCADES} from './common.js';
import {SKY_RENDER_FUNCS} from './sky.js';
import {VESSEL_LIGHTING} from './vessel.js';

export const GUNNERY_CROWN_SEGMENTS=32;
export const GUNNERY_CROWN_ROWS=5;
export const GUNNERY_DROP_COUNT=32;
export const GUNNERY_RING_SEGMENTS=48;
export const GUNNERY_RING_COUNT=4;

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
  let exit=min(scene,min(high.x,min(high.y,high.z)));if(exit<=enter){discard;}
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
  for(var sample=0u;sample<steps;sample++){
    let distance=enter+(f32(sample)+.15+.7*jitter)*stepSize;
    let local=origin+direction*distance;
    let df=gunneryDensityAndFbm(local,age,volume.optical.z);
    // Soft intersection margin removes hard slices at timber and sea.
    var density=df.x*smoothstep(0.0,.28,scene-distance);
    if(density<.0015){continue;}
    var emission=vec3f(0);var extinction=volume.optical.x*density;
    let subtype=volume.optical.w;
    if(volume.centre.w>.5){
      if(subtype>=0.9){
        // Shipboard fire (direction=[0,1,0] -> local.z is vertical in [-1, 1])
        let h=clamp(local.z*0.5+0.5,0.0,1.0);
        let taper=mix(1.0,0.34,h*h);
        let rHoriz=length(local.xy)/max(0.22,taper);
        let advectPos=vec3f(local.x*2.6,local.y*2.6,local.z*2.1-age*4.8)+vec3f(volume.optical.z);
        let fTurb=gunneryCloudFbm(advectPos);
        let tongueMask=clamp(1.08-rHoriz+(fTurb-0.46)*(0.55+0.55*h),0.0,1.0);
        let vertEnv=smoothstep(0.0,0.16,h)*(1.0-smoothstep(0.58,1.0,h));
        let flameShape=tongueMask*vertEnv;
        if(flameShape<0.01){continue;}
        let temp=clamp(flameShape*(1.12-0.48*h)+0.28*fTurb,0.0,1.0);
        let colBase=mix(vec3f(2.2,0.18,0.02),vec3f(24.0,5.8,0.45),smoothstep(0.12,0.58,temp));
        let colCore=mix(colBase,vec3f(54.0,36.0,12.5),smoothstep(0.58,0.92,temp));
        // Add rising glowing embers near the top of the upper flame tongue
        let sparkNoise=gunneryNoise3(advectPos*4.2+vec3f(0.0,0.0,-age*6.0));
        let sparks=select(0.0,smoothstep(0.82,0.95,sparkNoise)*h*18.0,subtype>1.1);
        emission=(colCore*flameShape+vec3f(36.0,12.0,1.8)*sparks)*volume.optical.x;
        extinction=density*flameShape*5.2;
      }else{
        let flame=max(0.0,1.0-dot(local,local));
        let coreNoise=.65+.35*df.y;
        emission=mix(vec3f(16.0,2.6,.18),vec3f(42.0,28.0,9.5),flame*flame*coreNoise)*volume.optical.x;
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
        (1.0-smoothstep(0.0,0.68,heightGrad))*max(0.0,1.0-length(local.xy)*0.95)*(0.65+0.35*df.y)*max(0.15,2.55-subtype),
        isFireSmoke
      );
      let internalEmber=vec3f(14.0,3.8,.45)*(emberFactor*throatCore*throatCore*density)+vec3f(9.5,2.4,0.28)*(fireUnderGlow*density);
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
    let hotGlow=mix(vec3f(11.0,1.8,0.18),vec3f(32.0,14.5,2.8),core*core);
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
fn gunneryImpactLift(c:GunneryContact)->f32{return clamp(2.5+abs(c.motion.y)*.42+length(c.motion.xyz)*.014,3.0,12.0)*sqrt(c.motion.w);}
fn gunneryImpactRadial(c:GunneryContact)->f32{return clamp(1.3+length(c.motion.xyz)*.01,1.6,5.5)*sqrt(c.motion.w);}
fn gunneryWaterRadiance(world:vec3f,normal:vec3f,foam:f32)->vec3f{
  let eye=normalize(F.camPos.xyz-world);var n=normalize(normal);if(dot(n,eye)<0.0){n=-n;}
  let direct=sunIlluminance()*sunVis[0]*step(0.0,F.sunDir.y);
  let reflected=textureSampleLevel(envCube,sampC,reflect(-eye,n),1.2).rgb;
  let diffuse=skyAtmo(vec3f(0,1,0))*.6+direct*max(F.sunDir.y,.08)*.23+lightningLight()*.3;
  let glint=vesselSpecular(n,eye,F.sunDir.xyz,.16,vec3f(.0204))*direct*max(0.0,dot(n,F.sunDir.xyz));
  return mix(reflected*.88+glint,diffuse,foam);
}
struct GunneryWaterVertex{@builtin(position)position:vec4f,@location(0)world:vec3f,@location(1)uv:vec2f,@location(2)@interpolate(flat)id:u32};
// The initial crown is a connected film launched from the real impact's fixed
// birth height. Detached water follows gravity, never the next passing crest.
@vertex fn gunneryCrownVS(@builtin(vertex_index)vertex:u32,@builtin(instance_index)id:u32)->GunneryWaterVertex{
  let c=gunneryContacts[id];let age=c.root.w;let uv=gunneryCorner(vertex);let cell=vertex/6u;
  let angle=(f32(cell%${GUNNERY_CROWN_SEGMENTS}u)+uv.x)*(2.0*PI)/${GUNNERY_CROWN_SEGMENTS}.0;
  let row=(f32(cell/${GUNNERY_CROWN_SEGMENTS}u)+uv.y)/${GUNNERY_CROWN_ROWS}.0;
  let lift=gunneryImpactLift(c);let radial=gunneryImpactRadial(c);let heading=gunneryContactHeading(c);let side=vec2f(heading.y,-heading.x);
  let lobe=.77+.18*sin(angle*7.0+c.detail.x*70.0)+.08*sin(angle*13.0-c.detail.x*43.0);
  let radius=(.06+radial*age*row)*c.motion.w;
  let drift=heading*min(12.0,length(c.motion.xz)*.025)*age;
  let horizontal=side*cos(angle)*radius+heading*sin(angle)*radius*1.18+drift*row;
  let rise=max(0.0,lift*age-4.905*age*age)*row*lobe;
  let world=c.root.xyz+vec3f(horizontal.x,.025+rise,horizontal.y);
  return GunneryWaterVertex(F.viewProj*vec4f(world-F.camPos.xyz,1),world,vec2f(angle,row),id);
}
@fragment fn gunneryCrownFS(v:GunneryWaterVertex)->@location(0)vec4f{
  let c=gunneryContacts[v.id];let age=c.root.w;let life=gunneryImpactLift(c)/4.905;
  if(age>=life||age<=0.0){discard;}
  let kind=c.extra.x;
  let rim=smoothstep(.4,1.0,v.uv.y);let breakup=smoothstep(.15,.8,age)*v.uv.y;
  let lace=.5+.27*sin(v.uv.x*19.0+c.detail.x*31.0)*sin(v.uv.y*14.0+c.detail.x*59.0)+.2*sin(v.uv.x*31.0-v.uv.y*8.0);
  let film=smoothstep(breakup*.58,breakup*.58+.15,lace);
  let foam=clamp(.12+rim*.7+breakup*.2,0.0,1.0);
  let baseAlpha=film*(.18+foam*.52)*smoothstep(0.0,.035,age)*(1.0-smoothstep(life*.6,life,age));
  let alpha=select(baseAlpha,min(1.0,baseAlpha*1.55),kind>.5);
  if(alpha<.002){discard;}
  let n=normalize(cross(dpdy(v.world),dpdx(v.world)));
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
  let kindBoost=select(1.0,2.15,c.extra.x>.5);
  let radius=(.012+random*.028)*c.motion.w*kindBoost;
  let eye=normalize(F.camPos.xyz-world);let right=normalize(F.camRight.xyz);let up=normalize(F.camUp.xyz);
  let surface=world+(right*corner.x+up*corner.y)*radius;
  return GunneryWaterVertex(F.viewProj*vec4f(surface-F.camPos.xyz,1),surface,corner,id);
}
@fragment fn gunneryDropFS(v:GunneryWaterVertex)->@location(0)vec4f{
  let c=gunneryContacts[v.id];let radius=dot(v.uv,v.uv);
  let minHeight=c.root.y-select(0.0,6.5,c.extra.x>.5);
  if(radius>=1.0||c.root.w>3.0||v.world.y<minHeight){discard;}
  let eye=normalize(F.camPos.xyz-v.world);let n=normalize(normalize(F.camRight.xyz)*v.uv.x+normalize(F.camUp.xyz)*v.uv.y+eye*sqrt(max(.001,1.0-radius)));
  let alpha=(1.0-smoothstep(.3,1.0,radius))*.7;
  let kind=c.extra.x;
  let waterRad=gunneryWaterRadiance(v.world,n,.45);
  let direct=sunIlluminance()*sunVis[0]*step(0.0,F.sunDir.y);
  let ambient=skyAtmo(vec3f(0,1,0))*.55+direct*max(dot(n,F.sunDir.xyz),.12)*.32+lightningLight()*.25;
  let fragAlbedo=select(select(vec3f(.38,.24,.12),vec3f(.44,.36,.25),kind>1.5),vec3f(.64,.42,.28),kind>2.5);
  let rad=select(waterRad,fragAlbedo*ambient,kind>.5);
  return vec4f(surfaceAir(rad,v.world)*alpha,alpha);
}
@vertex fn gunneryRingVS(@builtin(vertex_index)vertex:u32,@builtin(instance_index)id:u32)->GunneryWaterVertex{
  let c=gunneryContacts[id];let ring=vertex/(${GUNNERY_RING_SEGMENTS}u*6u);let uv=gunneryCorner(vertex);let segment=(vertex/6u)%${GUNNERY_RING_SEGMENTS}u;
  let age=c.root.w-f32(ring)*.15;let angle=(f32(segment)+uv.x)*(2.0*PI)/${GUNNERY_RING_SEGMENTS}.0;
  let crossSection=uv.y*2.0-1.0;let radius=(.1+max(0.0,age)*2.1*sqrt(c.motion.w))+crossSection*(.055+max(0.0,age)*.018);
  let q=c.root.xz+vec2f(cos(angle),sin(angle))*radius;
  let crest=(1.0-crossSection*crossSection)*.07*c.motion.w*exp(-max(0.0,age)*.8);
  let world=vec3f(q.x,gunnerySeaHeight(q)+.025+crest,q.y);
  return GunneryWaterVertex(F.viewProj*vec4f(world-F.camPos.xyz,1),world,vec2f(crossSection,angle),id*${GUNNERY_RING_COUNT}u+ring);
}
@fragment fn gunneryRingFS(v:GunneryWaterVertex)->@location(0)vec4f{
  let c=gunneryContacts[v.id/${GUNNERY_RING_COUNT}u];if(c.extra.x>.5){discard;}
  let ring=v.id%${GUNNERY_RING_COUNT}u;let age=c.root.w-f32(ring)*.15;if(age<=0.0||age>=8.0){discard;}
  let edge=1.0-smoothstep(.3,1.0,abs(v.uv.x));let broken=.7+.2*sin(v.uv.y*13.0+c.detail.x*71.0)+.1*sin(v.uv.y*29.0-c.detail.x*49.0);
  let alpha=edge*broken*exp(-age*.48)*smoothstep(0.0,.08,age)*(1.0-smoothstep(5.5,8.0,age))*.55;
  let n=normalize(cross(dpdy(v.world),dpdx(v.world)));
  return vec4f(surfaceAir(gunneryWaterRadiance(v.world,n,exp(-age*.9)*.8),v.world)*alpha,alpha);
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
  let glow=tint*(2.4*sunScale+.6*max(0.0,F.sunDir.y));
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

import { CLOUD_MODEL } from './cloud-model.js';

// Joshbrew cached-volume adaptation. Source/license: THIRD_PARTY_NOTICES.md.
const CLOUD_BAKE_UNIFORM = /* wgsl */ `
struct CloudBake { shape:vec4f, sun:vec4f };
@group(0) @binding(0) var<uniform> BAKE:CloudBake;
`;

export const CLOUD_DENSITY = CLOUD_BAKE_UNIFORM + CLOUD_MODEL + /* wgsl */ `
@group(0) @binding(1) var dst:texture_storage_3d<rgba16float,write>;
@compute @workgroup_size(4,4,4)
fn main(@builtin(global_invocation_id) id:vec3u) {
  let size=textureDimensions(dst); if(any(id>=size)){return;}
  if(BAKE.shape.x<=0.001){textureStore(dst,vec3i(id),vec4f(0,0,0,-0.30));return;}
  let uv=(vec3f(id)+0.5)/vec3f(size);
  // Altitude-ramped wind shear bends upper cumulus crowns gracefully while keeping periodic wrap exact.
  let topShear=smoothstep(0.45,0.96,uv.y)*0.34;
  let p=vec3f((uv.x-0.5)*16.0+topShear,uv.y*BAKE.shape.y,(uv.z-0.5)*16.0+topShear*0.55);
  let billowCoarse=cloudWorley3D(p*1.25,20.0);
  let billowFine=cloudWorley3D(p*2.5,40.0);
  let rawDetail=vec3f(cloudNoise(p*4.0,64.0),cloudNoise(p*8.0,128.0),cloudNoise(p*16.0,256.0));
  let detail=vec3f(mix(rawDetail.x,billowCoarse,0.48),mix(rawDetail.y,billowFine,0.42),rawDetail.z);
  let warp=(detail-0.5)*vec3f(0.32,0.24,0.32);
  let q=p+warp;
  let shape=vec4f(mix(cloudNoise(q*0.5,8.0),billowCoarse,0.22),cloudNoise(q,16.0),cloudNoise(q*2.0,32.0),cloudNoise(q*4.0,64.0));
  let distortion=(shape.gba-0.5)*vec3f(0.64,0.36,0.64)+warp;
  let body=roundedCloudBody(p+distortion,shape,detail);
  let fade=smoothstep(0.02,0.13,uv.y)*(1.0-smoothstep(0.97,1.0,uv.y));
  let density=body.xy*1.6*fade;
  textureStore(dst,vec3i(id),vec4f(density,max(density.x,0.0),max(body.z,-0.30)));
}
`;

// Periodic 2D sun-space cloud shadow transmittance map (baked only on lightDirty -> 0 ms steady state).
// Used by CLOUD_CAMERA_RAYS for single-tap volumetric crepuscular sun shafts.
export const CLOUD_SHADOW = CLOUD_BAKE_UNIFORM + /* wgsl */ `
@group(0) @binding(1) var field:texture_3d<f32>;
@group(0) @binding(2) var fieldSampler:sampler;
@group(0) @binding(3) var dst:texture_storage_2d<rgba16float,write>;
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) id:vec3u) {
  let size=textureDimensions(dst);if(any(id.xy>=size)){return;}
  if(BAKE.shape.x<=0.001){textureStore(dst,vec2i(id.xy),vec4f(1.0,0.0,0.0,1.0));return;}
  let uv=(vec2f(id.xy)+0.5)/vec2f(size);
  let sun=normalize(BAKE.sun.xyz);
  let elev=max(sun.y,0.08);
  let h=BAKE.shape.y;
  let path=min(h/elev,12.0);
  let step=path/24.0;
  let baseP=vec3f((uv.x-0.5)*16.0,0.0,(uv.y-0.5)*16.0);
  var tau=0.0;
  for(var i=0u;i<24u;i++){
    let p=baseP+sun*((f32(i)+0.5)*step);
    let sy=p.y/h;
    if(sy>1.0){break;}
    let suv=vec3f(p.x/16.0+0.5,sy,p.z/16.0+0.5);
    tau+=textureSampleLevel(field,fieldSampler,suv,0.0).r*step*BAKE.shape.w*4.0;
    if(tau>14.0){break;}
  }
  textureStore(dst,vec2i(id.xy),vec4f(exp(-tau),min(tau,14.0),0.0,1.0));
}
`;

export const CLOUD_LIGHT = CLOUD_BAKE_UNIFORM + /* wgsl */ `
@group(0) @binding(1) var field:texture_3d<f32>;
@group(0) @binding(2) var fieldSampler:sampler;
@group(0) @binding(3) var dst:texture_storage_3d<rgba16float,write>;
fn fieldSample(p:vec3f)->vec4f {
  let uv=vec3f(p.x/16.0+0.5,p.y/BAKE.shape.y,p.z/16.0+0.5);
  if(uv.y<0.0 || uv.y>1.0){return vec4f(0,0,0,-0.30);}
  return textureSampleLevel(field,fieldSampler,uv,0.0);
}
fn safeNormal(v:vec3f)->vec3f {return v*inverseSqrt(max(dot(v,v),1e-12));}
@compute @workgroup_size(4,4,4)
fn main(@builtin(global_invocation_id) id:vec3u) {
  let size=textureDimensions(dst);if(any(id>=size)){return;}
  let uv=(vec3f(id)+0.5)/vec3f(size);
  let p=vec3f((uv.x-0.5)*16.0,uv.y*BAKE.shape.y,(uv.z-0.5)*16.0);
  let spacing=vec3f(16,BAKE.shape.y,16)/vec3f(size);
  let current=fieldSample(p).g;
  let offsets=array<vec3f,6>(vec3f(1,0,0),vec3f(-1,0,0),vec3f(0,1,0),vec3f(0,-1,0),vec3f(0,0,1),vec3f(0,0,-1));
  var neighbors:array<f32,6>;var nearby=current;
  let normalSpacing=spacing*1.5;
  for(var i=0u;i<6u;i++){
    let n=fieldSample(p+offsets[i]*normalSpacing);neighbors[i]=n.a;nearby=max(nearby,n.g);
  }
  let sun=normalize(BAKE.sun.xyz);
  if(nearby<0.0001){textureStore(dst,vec3i(id),vec4f(max(sun.y,0.0),1,1,1));return;}
  let gradient=vec3f(neighbors[0]-neighbors[1],neighbors[2]-neighbors[3],neighbors[4]-neighbors[5])/normalSpacing;
  var normal=safeNormal(-gradient);if(dot(normal,normal)<0.1){normal=vec3f(0,1,0);}
  let reach=min(4.6,max(1.9,BAKE.shape.y*0.85));
  let step=reach/24.0;var opticalDepth=0.0;
  for(var i=0u;i<24u;i++){opticalDepth+=fieldSample(p+sun*((f32(i)+0.5)*step)).g*step*2.4*BAKE.shape.w;}
  let radius=min(BAKE.shape.y*0.12,0.5);var surrounding=0.0;
  for(var i=0u;i<6u;i++){
    let weight=0.15+0.85*max(dot(offsets[i],normal),0.0);
    let near=fieldSample(p+offsets[i]*radius).g;
    let far=fieldSample(p+offsets[i]*radius*2.4).g;
    surrounding+=(max(near-current*0.20,0.0)*0.6+max(far-current*0.10,0.0)*0.4)*weight;
  }
  let ao=clamp(exp(-surrounding*radius*1.5),0.18,1.0);
  textureStore(dst,vec3i(id),vec4f(max(dot(normal,sun),0.0),saturate(normal.y*0.5+0.5),exp(-opticalDepth),ao));
}
`;

export const CLOUD_FIELD_MIPS = /* wgsl */ `
@group(0) @binding(0) var density:texture_3d<f32>;
@group(0) @binding(1) var light:texture_3d<f32>;
@group(0) @binding(2) var densityOut:texture_storage_3d<rgba16float,write>;
@group(0) @binding(3) var lightOut:texture_storage_3d<rgba16float,write>;
@compute @workgroup_size(4,4,4)
fn main(@builtin(global_invocation_id) id:vec3u){
  if(any(id>=textureDimensions(densityOut))){return;}
  var d=vec4f(0);var l=vec4f(0);var bound=0.0;
  for(var z=0;z<2;z++){for(var y=0;y<2;y++){for(var x=0;x<2;x++){
    let p=vec3i(id)*2+vec3i(x,y,z);let v=textureLoad(density,p,0);
    d+=v;l+=textureLoad(light,p,0);bound=max(bound,v.b);
  }}}
  d*=0.125;d.b=bound;
  textureStore(densityOut,vec3i(id),d);textureStore(lightOut,vec3i(id),l*0.125);
}
`;

export const CLOUD_BINDINGS = /* wgsl */ `
struct CloudFrame {
  previousView:mat4x4f,
  previousCamera:vec4f,
  advection:vec4f, // current x/z and previous x/z, kilometres
  shape:vec4f, // base, thickness, density, valid history
  screen:vec4f, // ray target width/height, frame number, active
};
@group(1) @binding(0) var<uniform> CF:CloudFrame;
@group(1) @binding(1) var cloudDensity:texture_3d<f32>;
@group(1) @binding(2) var cloudLight:texture_3d<f32>;
@group(1) @binding(3) var cloudSampler:sampler;
`;

// Shared by camera rays, reflection rays and sunlight occlusion. No screen-space
// texture is reused for reflections: all three sample the same advected volume.
export const CLOUD_SAMPLE = CLOUD_BINDINGS + /* wgsl */ `
fn cloudRayJitter(pix:vec2u)->f32 {
  var h=(pix.x*0x9e3779b9u)^(pix.y*0x85ebca6bu)^0x68bc21ebu;
  h=(h^(h>>16u))*0x7feb352du;h=(h^(h>>15u))*0x846ca68bu;h=h^(h>>16u);
  return f32(h>>8u)/16777216.0;
}
fn cloudInterval(ro:vec3f,rd:vec3f)->vec2f {
  let origin=ro+vec3f(0,6360,0);
  let top=raySphere(origin,rd,6360.0+CF.shape.x+CF.shape.y);
  var begin=max(top.x,0.0);var end=min(top.y,65.0);
  let bottom=raySphere(origin,rd,6360.0+CF.shape.x);
  if(length(origin)<6360.0+CF.shape.x){begin=max(begin,bottom.y);}
  else if(bottom.x>0.0){end=min(end,bottom.x);}
  let ground=raySphere(origin,rd,6360.0);
  if(ground.x>0.0){end=min(end,ground.x);}
  return vec2f(begin,end);
}
fn cloudUV(p:vec3f)->vec3f {
  // Stable radial altitude avoids subtracting two almost equal large radii.
  let altitude=p.y+dot(p.xz,p.xz)/(sqrt(dot(p.xz,p.xz)+(6360.0+p.y)*(6360.0+p.y))+6360.0+p.y);
  return vec3f((p.x+CF.advection.x)/16.0+0.5,(altitude-CF.shape.x)/CF.shape.y,(p.z+CF.advection.y)/16.0+0.5);
}
fn cloudDensityAt(p:vec3f,lod:f32)->vec4f {
  let uv=cloudUV(p);if(uv.y<0.0 || uv.y>1.0){return vec4f(0);}
  return textureSampleLevel(cloudDensity,cloudSampler,uv,lod);
}
fn volumeSunVisibility(ro:vec3f,rd:vec3f)->f32 {
  if(CF.screen.w<0.5){return 1.0;}
  let hit=cloudInterval(ro,rd);if(hit.y<=hit.x){return 1.0;}
  let step=(hit.y-hit.x)/64.0;var optical=0.0;
  for(var i=0u;i<64u;i++){
    optical+=cloudDensityAt(ro+rd*(hit.x+(f32(i)+0.5)*step),0.0).r*step*CF.shape.z;
    // The solar disc is ~200,000 times brighter than the sky. The camera
    // march's 0.8% residual is invisible in clouds but becomes a false sun.
    // Preserve HDR extinction for both the disc and surface illumination.
    if(optical>20.0){return 0.0;}
  }
  return exp(-optical);
}
// For lighting a surface, which never sees the sun's disc directly: far coarser than the above.
fn volumeSurfaceSunVisibility(ro:vec3f,rd:vec3f)->f32 {
  if(CF.screen.w<0.5){return 1.0;}
  let hit=cloudInterval(ro,rd);if(hit.y<=hit.x){return 1.0;}
  let step=(hit.y-hit.x)/6.0;var optical=0.0;
  for(var i=0u;i<6u;i++){optical+=cloudDensityAt(ro+rd*(hit.x+(f32(i)+0.5)*step),0.0).r*step*CF.shape.z;}
  return exp(-optical);
}
struct CloudRay { color:vec4f, distance:f32 };
fn cloudHG(cosTheta:f32,g:f32)->f32 {
  let g2=g*g;
  return (1.0-g2)/(4.0*3.14159265*pow(max(1.0+g2-2.0*g*cosTheta,1e-4),1.5));
}
fn cloudDualHG(cosTheta:f32,gFwd:f32,gBack:f32,blend:f32)->f32 {
  return mix(cloudHG(cosTheta,gBack),cloudHG(cosTheta,gFwd),blend);
}
fn marchCloudsTo(ro:vec3f,rd:vec3f,budget:u32,jitter:f32,sunColor:vec3f,skyColor:vec3f,maxDistance:f32)->CloudRay {
  var out:CloudRay;out.color=vec4f(0);out.distance=0.0;
  if(CF.screen.w<0.5){return out;}
  var hit=cloudInterval(ro,rd);hit.y=min(hit.y,maxDistance);if(hit.y<=hit.x){return out;}
  let cosSun=dot(rd,F.sunDir.xyz);
  let phase=saturate(cosSun*0.5+0.5);
  let silverPhase=pow(phase,24.0);
  // Precompute dual-lobe Henyey-Greenstein phase across 3 multiple-scattering octaves (Wrenninge / Schneider).
  let hg0=min(cloudDualHG(cosSun,0.78,-0.28,0.72)*2.6,2.2);
  let hg1=min(cloudDualHG(cosSun,0.42,-0.16,0.72)*2.4,1.6);
  let hg2=min(cloudDualHG(cosSun,0.20,-0.08,0.72)*2.2,1.2);
  let powderBack=saturate(1.0-cosSun);
  let moonDir=lunarDirection();
  let moonPhase=saturate(dot(rd,moonDir)*0.5+0.5);
  let moonScatter=0.10+0.30*pow(moonPhase,4.0);
  let moonSilverBase=pow(moonPhase,24.0)*0.25;
  let extent=hit.y-hit.x;var tr=1.0;var color=vec3f(0);var depth=0.0;var weight=0.0;
  let skyDistance=skyAtmo(rd);
  for(var i=0u;i<budget;i++){
    // More intervals at entry, expanding towards the horizon. Jitter changes
    // only sample position; it never leaves the first/last interval uncovered.
    let a=f32(i)/f32(budget);let b=f32(i+1u)/f32(budget);
    let start=hit.x+extent*(a*0.3+a*a*0.7);
    let step=extent*((b*0.3+b*b*0.7)-(a*0.3+a*a*0.7));
    let t=start+step*jitter;let p=ro+rd*t;
    let lod=clamp(log2(max(step*0.35/0.125,1.0)),0.0,3.0);
    // Conservative mip-3 max-bound empty-space skip avoids full light fetches in clear sky gaps.
    if(cloudDensityAt(p,3.0).b<0.0004){continue;}
    let density=cloudDensityAt(p,lod);
    let rho=max(density.r,0.0);
    let alpha=1.0-exp(-rho*step*CF.shape.z);
    if(alpha>0.00001){
      let light=textureSampleLevel(cloudLight,cloudSampler,cloudUV(p),lod);
      let visibility=saturate(light.b);let diffuse=saturate(light.r);let upper=saturate(light.g);let ao=clamp(light.a,0.18,1.0);
      let root=sqrt(visibility);let root4=sqrt(root);
      // 3-octave multiple-scattering energy + Nubis crease/powder sugar darkening.
      let powder=mix(1.0,1.0-0.42*exp(-rho*5.5),powderBack);
      let crease=mix(0.72,1.0,ao);
      let multiSun=(visibility*hg0+root*0.52*hg1+root4*0.26*hg2)*powder*crease;
      let direct=visibility*(0.20+0.80*diffuse);
      let bounce=(0.035+0.18*root4)*(0.25+0.75*upper)*ao;
      let ambient=(0.10+0.19*upper)*ao;
      let silver=silverPhase*root*pow(max(1.0-diffuse,0.0),0.90)*(1.0-smoothstep(0.02,0.20,density.a))*0.28;
      let moonSilver=moonSilverBase*root*pow(max(1.0-diffuse,0.0),0.90)*(1.0-smoothstep(0.02,0.20,density.a));
      let lit=sunColor*((direct*0.62+multiSun*0.42+bounce)*0.20+silver)+lunarCloudLight()*((direct+moonScatter*visibility+bounce)*0.20+moonSilver)+skyColor*(ambient*2.4+0.15);
      let air=exp(-t*(0.009+F.atmo.x*0.003));
      let radiance=mix(skyDistance,lit,air);
      let contribution=tr*alpha;color+=contribution*radiance;depth+=contribution*t;weight+=contribution;
      tr*=1.0-alpha;
      if(tr<0.008){break;}
    }
  }
  let opacity=select(clamp(1.0-tr,0.0,1.0),1.0,tr<0.01);
  if(tr<0.01&&weight>1e-5){color/=max(1.0-tr,1e-4);}
  out.color=vec4f(color,opacity);out.distance=depth/max(weight,0.00001);
  return out;
}
fn marchClouds(ro:vec3f,rd:vec3f,budget:u32,jitter:f32,sunColor:vec3f,skyColor:vec3f)->CloudRay {
  return marchCloudsTo(ro,rd,budget,jitter,sunColor,skyColor,65.0);
}
`;

export const CLOUD_CAMERA_RAYS = /* wgsl */ `
@group(0) @binding(4) var colorOut:texture_storage_2d<rgba16float,write>;
@group(0) @binding(5) var depthOut:texture_storage_2d<r32float,write>;
@group(0) @binding(6) var cloudShadowMap:texture_2d<f32>;
@group(0) @binding(7) var cloudShadowSampler:sampler;
fn cloudCrepuscularShafts(ro:vec3f,rd:vec3f,jitter:f32,sunColor:vec3f,maxDist:f32)->vec3f {
  if(CF.screen.w<0.5||F.sunDir.y<0.03){return vec3f(0.0);}
  let cosSun=dot(rd,F.sunDir.xyz);
  if(cosSun<0.05){return vec3f(0.0);}
  // Only march below the cloud deck where broken cloud gaps cast visible crepuscular shafts.
  var limit=min(maxDist,18.0);
  if(rd.y>0.01&&ro.y<CF.shape.x){limit=min(limit,(CF.shape.x-ro.y)/rd.y);}
  if(limit<=0.15){return vec3f(0.0);}
  let elev=max(F.sunDir.y,0.08);
  let sunRatio=F.sunDir.xz/elev;
  let phase=0.22+1.65*pow(saturate(cosSun),6.0);
  let lowSun=smoothstep(0.03,0.14,F.sunDir.y)*(1.0-0.55*smoothstep(0.35,0.85,F.sunDir.y));
  let hazeGain=(0.0055+F.atmo.x*0.0028)*lowSun*phase;
  var shaft=0.0;var meanVis=0.0;var wSum=0.0;
  let steps=16u;
  for(var i=0u;i<steps;i++){
    let a=f32(i)/f32(steps);let b=f32(i+1u)/f32(steps);
    let s0=0.08+(limit-0.08)*(a*a);let s1=0.08+(limit-0.08)*(b*b);
    let ds=s1-s0;let t=s0+ds*jitter;
    let p=ro+rd*t;
    if(p.y<0.0){break;}
    let dz=max(CF.shape.x-p.y,0.0);
    let hitXZ=p.xz+sunRatio*dz;
    let suv=(hitXZ+CF.advection.xy)/16.0+0.5;
    let sunVis=textureSampleLevel(cloudShadowMap,cloudShadowSampler,suv,0.0).r;
    let altW=exp(-p.y*0.55)*exp(-t*0.085)*ds;
    shaft+=sunVis*altW;
    meanVis+=altW;
    wSum+=1.0;
  }
  // Contrast-preserve: suppress uniform clear-sky glow when there is no shadowing variation; let real broken shafts shine.
  let avgVis=shaft/max(meanVis,1e-4);
  let contrast=smoothstep(0.04,0.28,avgVis)*(1.0-0.72*smoothstep(0.88,0.995,avgVis));
  return sunColor*(shaft*hazeGain*contrast);
}
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) id:vec3u){
  let size=textureDimensions(colorOut);if(any(id.xy>=size)){return;}
  let uv=(vec2f(id.xy)+0.5)/vec2f(size);let ndc=uv*vec2f(2,-2)+vec2f(-1,1);
  let rd=normalize(F.camFwd.xyz+ndc.x*F.camRight.xyz+ndc.y*F.camUp.xyz);
  let jitter=fract(cloudRayJitter(id.xy)+f32(u32(CF.screen.z)%64u)*0.61803398875);
  let ro=F.camPos.xyz*0.001;
  let sunCol=sunIlluminance();
  let ray=marchClouds(ro,rd,64u,jitter,sunCol,skyAtmo(vec3f(0,1,0)));
  let shaftLimit=select(18.0,ray.distance,ray.distance>0.1);
  let shafts=cloudCrepuscularShafts(ro,rd,jitter,sunCol,shaftLimit);
  let outCol=vec4f(ray.color.rgb+shafts*(1.0-ray.color.a*0.55),ray.color.a);
  textureStore(colorOut,vec2i(id.xy),outCol);textureStore(depthOut,vec2i(id.xy),vec4f(ray.distance));
}
`;

export const CLOUD_RESOLVE = /* wgsl */ `
@group(0) @binding(0) var<uniform> F:Frame;
@group(0) @binding(1) var rawColor:texture_2d<f32>;
@group(0) @binding(2) var currentDepth:texture_2d<f32>;
@group(0) @binding(3) var history:texture_2d<f32>;
@group(0) @binding(4) var historyDepth:texture_2d<f32>;
@group(0) @binding(5) var linearSampler:sampler;
@group(0) @binding(6) var resolved:texture_storage_2d<rgba16float,write>;
fn cloudClean4(v:vec4f)->vec4f {
  let bad=(v!=v)|((bitcast<vec4u>(v)&vec4u(0x7fffffffu))>=vec4u(0x7f800000u));
  let safe=select(v,vec4f(0.0),bad);
  return vec4f(clamp(safe.rgb,vec3f(0.0),vec3f(6.0e4)),clamp(safe.a,0.0,1.0));
}
fn cloudScalarFinite(x:f32)->bool {
  return (x==x)&&!(x!=x)&&((bitcast<u32>(x)&0x7fffffffu)<0x7f800000u);
}
// 5-tap Jimenez Catmull-Rom bicubic filter preserves crisp billowing cloud edges during temporal reprojection.
fn cloudSampleCatmullRom(tex:texture_2d<f32>,samp:sampler,uv:vec2f,texSize:vec2f)->vec4f {
  let pos=uv*texSize;
  let tc1=floor(pos-0.5)+0.5;
  let f=pos-tc1;
  let f2=f*f;let f3=f2*f;
  let w0=f2-0.5*(f3+f);
  let w1=1.5*f3-2.5*f2+1.0;
  let w3=0.5*(f3-f2);
  let w2=1.0-w0-w1-w3;
  let w12=w1+w2;
  let inv=1.0/texSize;
  let tc0=(tc1-1.0)*inv;
  let tc3=(tc1+2.0)*inv;
  let tc12=(tc1+w2/max(w12,vec2f(1e-5)))*inv;
  let c0=textureSampleLevel(tex,samp,vec2f(tc12.x,tc0.y),0.0)*(w12.x*w0.y);
  let c1=textureSampleLevel(tex,samp,vec2f(tc0.x,tc12.y),0.0)*(w0.x*w12.y);
  let c2=textureSampleLevel(tex,samp,vec2f(tc12.x,tc12.y),0.0)*(w12.x*w12.y);
  let c3=textureSampleLevel(tex,samp,vec2f(tc3.x,tc12.y),0.0)*(w3.x*w12.y);
  let c4=textureSampleLevel(tex,samp,vec2f(tc12.x,tc3.y),0.0)*(w12.x*w3.y);
  let wSum=w12.x*w0.y+w0.x*w12.y+w12.x*w12.y+w3.x*w12.y+w12.x*w3.y;
  return (c0+c1+c2+c3+c4)/max(wSum,1e-5);
}
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) id:vec3u){
  let size=vec2i(textureDimensions(resolved));let p=vec2i(id.xy);if(any(p>=size)){return;}
  let current=cloudClean4(textureLoad(rawColor,p,0));
  let rawDist=textureLoad(currentDepth,p,0).r;
  let distance=select(0.0,rawDist,cloudScalarFinite(rawDist));
  var result=current;
  if(CF.shape.w>0.5 && current.a>0.0001 && distance>0.0){
    let uv=(vec2f(p)+0.5)/vec2f(size);let ndc=uv*vec2f(2,-2)+vec2f(-1,1);
    let dir=normalize(F.camFwd.xyz+ndc.x*F.camRight.xyz+ndc.y*F.camUp.xyz);
    let shift=(CF.advection.xy-CF.advection.zw)*1000.0;
    let world=F.camPos.xyz+dir*distance*1000.0+vec3f(shift.x,0,shift.y);
    let previous=CF.previousView*vec4f(world-CF.previousCamera.xyz,1.0);
    let at=previous.xy/max(previous.w,0.0001)*vec2f(0.5,-0.5)+0.5;
    if(previous.w>0.0 && all(at>vec2f(0)) && all(at<vec2f(1))){
      let previousDepth=textureLoad(historyDepth,clamp(vec2i(at*vec2f(size)),vec2i(0),size-1),0).r;
      let rawOld=cloudSampleCatmullRom(history,linearSampler,at,vec2f(size));
      let historyFinite=!(any(rawOld!=rawOld)||!(previousDepth==previousDepth))&&cloudScalarFinite(previousDepth)&&all((bitcast<vec4u>(rawOld)&vec4u(0x7fffffffu))<vec4u(0x7f800000u));
      let expected=length(world-CF.previousCamera.xyz)*0.001;
      if(historyFinite && abs(previousDepth-expected)<max(0.35,distance*0.15)){
        var lo=current;var hi=current;
        for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){
          let c=cloudClean4(textureLoad(rawColor,clamp(p+vec2i(x,y),vec2i(0),size-1),0));lo=min(lo,c);hi=max(hi,c);
        }}
        let old=clamp(rawOld,lo,hi);
        let confidence=0.86*(1.0-saturate(abs(old.a-current.a)*2.0));
        result=mix(current,old,confidence);
      }
    }
  }
  result=cloudClean4(result);
  if(any(result!=result)){result=vec4f(0.0);}
  textureStore(resolved,p,result);
}
`;

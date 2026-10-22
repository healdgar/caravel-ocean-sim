import {CELESTIAL_CAUSTIC_STUB} from './celestial.js';
// Copyright (c) 2026 Six Cailloux, LLC. MIT.
import {FRAME_WGSL,ATMO_CORE_WGSL,CASCADES} from './common.js';
import {SKY_RENDER_FUNCS,SUN_DISK} from './sky.js';
import {WATER_OPTICS} from './water-optics.js';
import {SCENE_SHADOW_SAMPLE} from './shadows.js';
import {surfaceWaveSource} from './surface-coupling.js';

// Receiver-map Jacobian of refracted sunlight, sampled from the simulated FFT
// slopes. This local, filtered focusing approximation is not a photon solver:
// folded/multiple light paths are bounded rather than accumulated. No noise or
// preanimated caustic texture is used. See GPU Gems, chapter 2 (Guardado/Crespo).
export function waterCausticFunctions({derivatives='derivTex',sampler='sampR',surfaceWaves=false,shadows=true}={}){
  return CELESTIAL_CAUSTIC_STUB+/* wgsl */ `
fn causticSlope(p:vec2f,footprint:f32)->vec2f {
  var slope=vec2f(0);
  // Long swells transport the patch; the resolved 7 m, 1.4 m and .26 m bands
  // provide its visible focusing. The finite footprint filters deep shimmer.
  for(var c=3u;c<${CASCADES}u;c++){
    let invL=F.cascInvL[c>>2u][c&3u];
    let lod=max(0.0,log2(max(1.0,footprint*invL*f32(textureDimensions(${derivatives}).x))));
    let d=textureSampleLevel(${derivatives},${sampler},p*invL,i32(c),lod);
    slope+=d.xy/max(vec2f(1)+d.zw,vec2f(.2));
  }
  ${surfaceWaves?`if(SW.step.w>.5){
    let e=max(footprint,SW.nearDomain.w);
    slope+=vec2f(surfaceWaveAt(p+vec2f(e,0)).x-surfaceWaveAt(p-vec2f(e,0)).x,
      surfaceWaveAt(p+vec2f(0,e)).x-surfaceWaveAt(p-vec2f(0,e)).x)/(2.0*e);
  }`:''}
  return slope;
}
fn causticLightSlope(p:vec2f,footprint:f32)->vec2f {
  let slope=causticSlope(p,footprint);
  let normal=normalize(vec3f(-slope.x,1,-slope.y));
  let down=refract(-normalize(causticSourceDirection()),normal,1.0/WATER_REFRACTIVE_INDEX);
  return down.xz/max(-down.y,.15);
}
fn waterCausticPixelFootprint(receiver:vec3f)->f32 {
  let relative=receiver-F.camPos.xyz;
  let depth=max(0.0,dot(relative,normalize(F.camFwd.xyz)));
  let pixel=2.0*depth*max(length(F.camRight.xyz)/max(F.screen.x,1.0),length(F.camUp.xyz)/max(F.screen.y,1.0));
  // The usual seabed receiver is oblique to the view. Bound that enlargement
  // without differentiating a discontinuous screen-space captured silhouette.
  return pixel/max(abs(normalize(relative+vec3f(0,.000001,0)).y),.2);
}
fn waterCausticFactorFiltered(receiver:vec3f,surfaceY:f32,pixelFootprint:f32)->vec3f {
  let depth=surfaceY-receiver.y;
  if(depth<=.035||depth>=40.0||causticSourceDirection().y<=.015){return vec3f(1);}
  let light=causticSourceLight();
  let sky=skyAtmo(vec3f(0,1,0));
  let direct=dot(light,vec3f(.2126,.7152,.0722));
  let diffuse=dot(sky,vec3f(.2126,.7152,.0722));
  let strength=smoothstep(.015,.15,causticSourceDirection().y)*direct/max(direct+diffuse*3.0,.00000001)
    *smoothstep(.035,.25,depth)*exp(-depth*(.045+max(optics.x,0.0)*.07))*(1.0-smoothstep(20.0,40.0,depth));
  if(strength<.0001){return vec3f(1);}
  let beam=max(.035,depth*(.018+min(max(optics.x,0.0),4.0)*.006));
  let footprint=max(beam,pixelFootprint*1.25);
  let flat=refract(-normalize(causticSourceDirection()),vec3f(0,1,0),1.0/WATER_REFRACTIVE_INDEX);
  var entry=receiver.xz-depth*flat.xz/max(-flat.y,.15);
  entry=receiver.xz-depth*causticLightSlope(entry,footprint);
  let dx=(causticLightSlope(entry+vec2f(footprint,0),footprint)-causticLightSlope(entry-vec2f(footprint,0),footprint))/(2.0*footprint);
  let dz=(causticLightSlope(entry+vec2f(0,footprint),footprint)-causticLightSlope(entry-vec2f(0,footprint),footprint))/(2.0*footprint);
  let columnX=vec2f(1,0)+depth*dx;let columnZ=vec2f(0,1)+depth*dz;
  let jacobian=columnX.x*columnZ.y-columnX.y*columnZ.x;
  // A point-light inverse determinant diverges at a fold. Integrate a finite
  // beam instead of flattening that singularity into hard three-times plateaux.
  // Beyond a folded single-ray map, fade to mean irradiance; the missing light
  // paths cannot be recovered by taking abs(det) and inventing a second image.
  let blur=.55+min(pixelFootprint/max(beam,.001),2.0)*.35;
  let density=sqrt((1.0+blur*blur)/(jacobian*jacobian+blur*blur));
  let focus=mix(1.0,density,smoothstep(-.35,.15,jacobian));
  let shadow=${shadows?'vesselShadow(vec3f(entry.x,surfaceY,entry.y),vec3f(0,1,0))':'vec3f(1)'};
  return mix(vec3f(1),vec3f(focus),strength*shadow);
}
fn waterCausticFactor(receiver:vec3f,surfaceY:f32)->vec3f {
  return waterCausticFactorFiltered(receiver,surfaceY,0.0);
}
`;
}

// Exact homogeneous single-scatter path weight for a planar water column.
// The light and viewing legs share spectral extinction. Above-surface samples
// cannot contribute, and every channel is bounded by the removed view energy.
export const UNDERWATER_SCATTER=/* wgsl */ `
fn underwaterLightIntegral(path:f32,eyeDepth:f32,rayY:f32,lightCos:f32,turbidity:f32)->vec3f {
  var waterPath=max(path,0.0);
  if(rayY>0.00001){waterPath=min(waterPath,max(eyeDepth,0.0)/rayY);}
  let cosine=max(lightCos,.05);let depth=max(eyeDepth,0.0);
  let start=waterTransmittance(depth/cosine,turbidity);
  let end=waterTransmittance(waterPath,turbidity)*waterTransmittance(max(0.0,depth-rayY*waterPath)/cosine,turbidity);
  let coefficient=1.0-rayY/cosine;
  var integral=vec3f(0);
  if(abs(coefficient)<.001){
    let extinction=vec3f(.20,.065,.035)+max(turbidity,0.0)*vec3f(.11,.095,.085);
    integral=extinction*waterPath*waterTransmittance(depth/cosine+coefficient*waterPath*.5,turbidity);
  }else{integral=(start-end)/coefficient;}
  return clamp(integral,vec3f(0),vec3f(1)-waterTransmittance(waterPath,turbidity));
}
fn underwaterPhase(cosine:f32)->f32 {
  // Both lobes integrate to one. An additive unnormalised solar pedestal made
  // the entire water column glow even away from forward scattering.
  return mix(1.0/(4.0*PI),phaseHG(cosine,.72),.7);
}
`;

// Interior side of the same displaced surface, not a second flat ocean. Exact
// dielectric Fresnel gives a Snell window and total internal reflection. The
// reflected underwater hemisphere remains a bounded diffuse-body approximation;
// this does not trace offscreen objects or reconstruct above-water silhouettes.
export const UNDERWATER_INTERFACE=SUN_DISK+/* wgsl */ `
fn underwaterBoundary(world:vec3f,normal:vec3f,view:vec3f,skyHemi:vec3f,foam:f32,foamLight:vec3f)->vec3f {
  let interior=-normal;
  let cosine=clamp(dot(view,interior),0.0,1.0);
  let reflectance=waterInteriorFresnel(cosine);
  let airRay=refract(-view,interior,WATER_REFRACTIVE_INDEX);
  var transmitted=vec3f(0);
  if(reflectance<.99999&&dot(airRay,airRay)>.00001){
    let dir=normalize(airRay);
    // Sky LUT and solar disc share the ordinary above-water illumination. Local
    // surface slopes distort the window; the medium pass attenuates the eye leg.
    transmitted=(textureSampleLevel(envCube,sampR,normalize(vec3f(dir.x,max(dir.y,.0005),dir.z)),0.0).rgb+sunDisk(dir)*sunVis[0]+lunarDisk(dir)*sunVis[1])*(1.0-reflectance);
  }
  let reflected=F.waterCol.rgb*(skyHemi*1.5+(sunIlluminance()*sunVis[0]*max(F.sunDir.y,0.0)+lunarIlluminance()*sunVis[1]*max(lunarDirection().y,0.0))*.22);
  let bubbles=foamLight*.3+skyHemi*.06;
  return mix(transmitted+reflected*reflectance,bubbles,clamp(foam*.85,0.0,.95));
}
`;

export function createUnderwaterMedium({samples=4,cameraProbe=false,surfaceWaves=false,shadows=false,skipAir=false}={}){
  const count=Math.max(1,Math.floor(samples));
  return FRAME_WGSL+ATMO_CORE_WGSL+WATER_OPTICS+/* wgsl */ `
@group(0)@binding(0)var<uniform>F:Frame;
@group(0)@binding(1)var hdrSource:texture_2d<f32>;
@group(0)@binding(2)var sceneDepth:${count===1?'texture_depth_2d':'texture_depth_multisampled_2d'};
@group(0)@binding(3)var rawSubmerged:texture_2d<f32>;
@group(0)@binding(4)var<uniform>optics:vec4f;
@group(0)@binding(5)var transLUT:texture_2d<f32>;
@group(0)@binding(6)var skyLUT:texture_2d<f32>;
@group(0)@binding(7)var sampC:sampler;
@group(0)@binding(8)var<storage,read>sunVis:array<f32,4>;
@group(0)@binding(9)var derivTex:texture_2d_array<f32>;
@group(0)@binding(10)var seaSampler:sampler;
${cameraProbe?'@group(0)@binding(11)var<storage,read>cameraSea:array<f32,16>;':''}
`+SKY_RENDER_FUNCS+(shadows?SCENE_SHADOW_SAMPLE:'')+(surfaceWaves?surfaceWaveSource(2,0,1,'seaSampler'):'')
  +waterCausticFunctions({derivatives:'derivTex',sampler:'seaSampler',surfaceWaves,shadows})+UNDERWATER_SCATTER+/* wgsl */ `
struct UnderwaterVertex{@builtin(position)position:vec4f,@location(0)ndc:vec2f};
@vertex fn vs(@builtin(vertex_index)i:u32)->UnderwaterVertex {
  let p=vec2f(f32((i<<1u)&2u),f32(i&2u))*2.0-1.0;
  ${skipAir?`// The post passes choose original HDR using this same current GPU probe.
  // Degenerate geometry avoids an otherwise identity full-screen copy in air.
  if(${cameraProbe?'cameraSea[9]':'optics.z'}-F.camPos.y<=.005){return UnderwaterVertex(vec4f(0,0,0,1),p);}`:''}
  return UnderwaterVertex(vec4f(p,0,1),p);
}
fn underwaterSceneDistance(pixel:vec2i,ray:vec3f)->f32 {
  var depth=0.0;
  for(var sample=0;sample<${count};sample++){depth=max(depth,textureLoad(sceneDepth,pixel,${count===1?'0':'sample'}));}
  if(depth<=0.0){return -1.0;}
  let a=F.viewProj*vec4f(ray,0);let b=F.viewProj*vec4f(0,0,0,1);
  return max(0.0,(b.z-depth*b.w)/(depth*a.w-a.z));
}
@fragment fn fs(v:UnderwaterVertex)->@location(0)vec4f {
  let pixel=vec2i(v.position.xy);let original=textureLoad(hdrSource,pixel,0);
  let surfaceY=${cameraProbe?'cameraSea[9]':'optics.z'};
  let eyeDepth=surfaceY-F.camPos.y;
  if(eyeDepth<=.005){return original;}
  let ray=normalize(F.camFwd.xyz+v.ndc.x*F.camRight.xyz+v.ndc.y*F.camUp.xyz);
  let distance=underwaterSceneDistance(pixel,ray);
  var path=select(120.0,min(distance,120.0),distance>=0.0);
  var radiance=select(vec3f(0),original.rgb,distance>=0.0);
  let raw=textureLoad(rawSubmerged,pixel,0);
  let forwardDepth=path*dot(ray,normalize(F.camFwd.xyz));
  // Capture also contains seabed omitted by the ordinary air-side terrain
  // draw. A captured solid may precede the ordinary depth (or fill clear depth),
  // but must never shine through a closer surface or an opaque air object.
  let receiverVisible=raw.a>0.0&&(distance<0.0||raw.a<=forwardDepth+max(.08,forwardDepth*.005));
  if(receiverVisible){path=min(120.0,raw.a/max(dot(ray,normalize(F.camFwd.xyz)),.001));}
  let receiver=F.camPos.xyz+ray*path;
  let endDepth=max(0.0,surfaceY-receiver.y);
  if(receiverVisible){
    radiance=raw.rgb*waterCausticFactorFiltered(receiver,surfaceY,waterCausticPixelFootprint(receiver));
  }
  let lightDown=refract(-normalize(causticSourceDirection()),vec3f(0,1,0),1.0/WATER_REFRACTIVE_INDEX);
  let lightCos=max(-lightDown.y,.25);
  if(receiverVisible){radiance*=waterTransmittance(endDepth/lightCos,optics.x);}
  let transmission=waterTransmittance(path,optics.x);
  // Analytic single scattering avoids depth-dependent four-stratum brightness
  // jumps. The water has no emissive term; sky and refracted sunlight supply it.
  let sun=sunIlluminance()*sunVis[0]*smoothstep(0.0,.05,F.sunDir.y)*(1.0-waterFresnel(max(F.sunDir.y,0.0)));
  let sky=skyAtmo(vec3f(0,1,0));
  let towardLight=normalize(-lightDown);
  // Keep the representative shadow point inside the same participating water
  // segment even when an upward ray exits within the first two metres.
  let at=min(path,min(2.0,eyeDepth/max(ray.y,.00001)));
  let sampleWorld=F.camPos.xyz+ray*at;
  let sampleDepth=max(0.0,surfaceY-sampleWorld.y);
  let entry=sampleWorld.xz-sampleDepth*lightDown.xz/lightCos;
  let sunShadow=${shadows?'vesselShadow(vec3f(entry.x,surfaceY,entry.y),vec3f(0,1,0))':'vec3f(1)'};
  let moonDown=refract(-lunarDirection(),vec3f(0,1,0),1.0/WATER_REFRACTIVE_INDEX);let moonCos=max(-moonDown.y,.25);
  let moon=lunarIlluminance()*sunVis[1]*(1.0-waterFresnel(max(lunarDirection().y,0.0)));
  let scatterAlbedo=clamp(F.waterCol.rgb,vec3f(0),vec3f(.85));
  let scatter=scatterAlbedo*(sky*1.4*underwaterLightIntegral(path,eyeDepth,ray.y,.65,optics.x)
    +sun*solarShadowVisibility(sunShadow)*underwaterPhase(dot(ray,normalize(-refract(-normalize(F.sunDir.xyz),vec3f(0,1,0),1.0/WATER_REFRACTIVE_INDEX))))*underwaterLightIntegral(path,eyeDepth,ray.y,lightCos,optics.x)
    +moon*lunarShadowVisibility(sunShadow)*underwaterPhase(dot(ray,normalize(-moonDown)))*underwaterLightIntegral(path,eyeDepth,ray.y,moonCos,optics.x));
  return vec4f(max(vec3f(0),radiance*transmission+scatter),1);
}
`;
}
export const UNDERWATER_MEDIUM=createUnderwaterMedium();

import { FRAME_WGSL } from './common.js';

// Production Frame extension: original 384 bytes are unchanged. Every production
// shader is specialized by main.shader(), including capture/compute/post paths.
// 384 moonDir, 400 moonRight, 416 moonUp, 432 moonSun, 448 celestial,
// 464 starRotation (64 bytes): total 528. Legacy isolated snippets remain 384.
export const CELESTIAL_FRAME_FLOATS=132;
export const CELESTIAL_FRAME_BYTES=528;
export const CELESTIAL_SOLAR_STUB=`fn celestialSolarVisibility()->f32{return 1.0;}`;
export const CELESTIAL_FRAME_WGSL=FRAME_WGSL.replace(/};\s*$/,`
  moonDir:vec4f,       // world direction, photometric irradiance
  moonRight:vec4f,     // disc right, angular radius
  moonUp:vec4f,        // disc up, illuminated fraction
  moonSun:vec4f,       // Moon-to-Sun direction, Lambert disc integral
  celestial:vec4f,     // astronomy enabled, stars, constellations, lunar shadow map
  starRotation:mat4x4f,// J2000 catalogue to local geographic horizon
};`);

// No lunar bindings leak into legacy isolated tests. Production replaces this
// exact block, not heuristic fragments or otherwise unused uniform components.
export const CELESTIAL_LIGHT_STUB=/* wgsl */ `
fn celestialEnabled()->bool{return false;}
fn lunarDirection()->vec3f{return vec3f(0,1,0);}
fn lunarIrradiance()->f32{return 0.0;}
fn lunarIlluminance()->vec3f{return vec3f(0);}
fn lunarCloudLight()->vec3f{return vec3f(0);}
fn lunarSky(dir:vec3f)->vec3f{return vec3f(0);}
fn lunarDisk(dir:vec3f)->vec3f{return vec3f(0);}
fn lunarShadowVisibility(solar:vec3f)->vec3f{return vec3f(1);}
fn solarShadowVisibility(solar:vec3f)->vec3f{return solar;}
fn lunarSurface(n:vec3f,v:vec3f,albedo:vec3f,rough:f32,f0:vec3f,visibility:vec3f)->vec3f{return vec3f(0);}
`;
const CELESTIAL_LIGHT_REAL=/* wgsl */ `
fn celestialEnabled()->bool{return F.celestial.x>.5;}
fn lunarDirection()->vec3f{return F.moonDir.xyz;}
fn lunarIrradiance()->f32{return F.moonDir.w*step(0.0,F.moonDir.y);}
fn lunarIlluminance()->vec3f{if(lunarIrradiance()<=0.0){return vec3f(0);}return sampleTrans(camR(),F.moonDir.y)*lunarIrradiance();}
fn lunarCloudLight()->vec3f{return lunarIlluminance();}
fn lunarShadowVisibility(solar:vec3f)->vec3f{return select(vec3f(1),solar,F.celestial.w>.5);}
fn solarShadowVisibility(solar:vec3f)->vec3f{return select(solar,vec3f(1),F.celestial.w>.5);}
fn lunarSky(dir:vec3f)->vec3f {
  if(!celestialEnabled()){return vec3f(0);}
  let h=max(dir.y,0.0);let phase=phaseRayleigh(clamp(dot(dir,F.moonDir.xyz),-1.0,1.0));
  let moon=lunarIlluminance()*vec3f(.28,.40,.65)*phase/(.12+h)*.055;
  // Very weak airglow supplies a non-directional floor; it is not blue daylight.
  let airglow=vec3f(.65,.85,.65)*2e-8*(1.0-smoothstep(-.2,-.06,F.sunDir.y));
  return moon+airglow;
}
fn lunarDisk(dir:vec3f)->vec3f {
  if(!celestialEnabled()||dir.y<0.0||F.moonDir.y<0.0){return vec3f(0);}
  let radius=F.moonRight.w;let cosine=dot(dir,F.moonDir.xyz);
  if(cosine<cos(radius*1.5)){return vec3f(0);}
  let xy=vec2f(dot(dir,F.moonRight.xyz),dot(dir,F.moonUp.xyz))/sin(radius);
  let rr=dot(xy,xy);let pixel=max(F.screen.w*2.0*length(F.camUp.xyz)/max(radius,1e-6),.001);
  let edge=1.0-smoothstep(1.0-pixel,1.0+pixel,rr);
  let normal=F.moonRight.xyz*xy.x+F.moonUp.xyz*xy.y-F.moonDir.xyz*sqrt(max(0.0,1.0-rr));
  let lit=max(dot(normal,F.moonSun.xyz),0.0);
  let terrain=1.0+.08*sin(xy.x*13.0+sin(xy.y*19.0))+.02*sin(xy.y*71.0);
  // A Lambert sphere integrates to2/3 of a uniformly lit disc. The1.5
  // factor restores the ephemeris irradiance; tonal detail has unit full-disc mean.
  let radiance=1.5*F.moonDir.w/(PI*radius*radius*max(F.moonSun.w,.002));
  return vec3f(.98,.96,.91)*radiance*lit*terrain*edge*sampleTrans(camR(),dir.y);
}
fn lunarSurface(n:vec3f,v:vec3f,albedo:vec3f,rough:f32,f0:vec3f,visibility:vec3f)->vec3f {
  if(lunarIrradiance()<=0.0){return vec3f(0);}
  let l=lunarDirection();let nl=max(dot(n,l),0.0);let nv=max(dot(n,v),.001);
  let h=normalize(v+l+vec3f(1e-6));let nh=max(dot(n,h),0.0);let vh=max(dot(v,h),0.0);
  let alpha=max(.025,rough*rough);let aa=alpha*alpha;let denom=nh*nh*(aa-1.0)+1.0;
  let distribution=aa/(PI*denom*denom);let k=(rough+1.0)*(rough+1.0)*.125;
  let geometry=nl/(nl*(1.0-k)+k)*nv/(nv*(1.0-k)+k);
  let fresnel=f0+(vec3f(1)-f0)*pow(1.0-vh,5.0);
  let brdf=distribution*geometry*fresnel/max(4.0*nl*nv,.001);
  return lunarIlluminance()*clamp(visibility,vec3f(0),vec3f(1))*nl*(albedo/PI+brdf);
}
`;
export const CELESTIAL_CAUSTIC_STUB=`
fn causticSourceDirection()->vec3f{return F.sunDir.xyz;}
fn causticSourceLight()->vec3f{return sunIlluminance()*sunVis[0];}
`;
const CELESTIAL_CAUSTIC_REAL=`
fn causticSourceDirection()->vec3f{return select(F.sunDir.xyz,F.moonDir.xyz,F.sunDir.y<=.015&&F.moonDir.w>0.0&&F.moonDir.y>0.0);}
fn causticSourceLight()->vec3f{return sunIlluminance()*sunVis[0]*step(.015,F.sunDir.y)+lunarIlluminance()*sunVis[1];}
`;
export const CELESTIAL_STAR_STUB=`fn celestialStarBackground(dir:vec3f)->vec3f{return vec3f(0);}`;
export function withCelestialFrame(source){
  if(source.includes(CELESTIAL_SOLAR_STUB))source=source.replaceAll(CELESTIAL_SOLAR_STUB,`fn celestialSolarVisibility()->f32{return planetDiskVisibility(RG+F.atmo.y,F.sunDir.y,SUN_ANG_R);}`);
  if(source.includes(CELESTIAL_CAUSTIC_STUB))source=source.replaceAll(CELESTIAL_CAUSTIC_STUB,CELESTIAL_CAUSTIC_REAL);
  if(source.includes(CELESTIAL_STAR_STUB)){
    const binding=/\bvar\s+dst\s*:\s*texture_storage_2d_array/.test(source)?6:5;
    source=source.replace(CELESTIAL_STAR_STUB,"@group(0) @binding("+binding+") var stellarCube:texture_cube<f32>;\nfn celestialStarBackground(dir:vec3f)->vec3f{if(dir.y<=0.0||F.celestial.y<=0.0){return vec3f(0);}if(F.celestial.x>.5&&F.moonDir.y>=0.0&&dot(dir,F.moonDir.xyz)>cos(F.moonRight.w)){return vec3f(0);}return textureSampleLevel(stellarCube,sampC,dir,0).rgb;}");
  }
  if(source.includes(FRAME_WGSL))source=source.replaceAll(FRAME_WGSL,CELESTIAL_FRAME_WGSL);
  if(source.includes(CELESTIAL_LIGHT_STUB))source=source.replaceAll(CELESTIAL_LIGHT_STUB,CELESTIAL_LIGHT_REAL);
  return source;
}

export const CELESTIAL_STARS=FRAME_WGSL+/* wgsl */ `
@group(0) @binding(0) var<uniform> F:Frame;
struct StarFace{axis:vec4f};
@group(0) @binding(1) var<uniform> SF:StarFace;
struct StarVertex{@builtin(position) position:vec4f,@location(0) uv:vec2f,@location(1) flux:vec3f,@location(2) altitude:f32};
fn starFaceDirection(d:vec3f,face:u32)->vec3f{
 switch(face){
 case 0u:{return vec3f(-d.z,-d.y,d.x);} case 1u:{return vec3f(d.z,-d.y,-d.x);}
 case 2u:{return vec3f(d.x,d.z,d.y);} case 3u:{return vec3f(d.x,-d.z,-d.y);}
 case 4u:{return vec3f(d.x,-d.y,d.z);} default:{return vec3f(-d.x,-d.y,-d.z);}}
}
@vertex fn vs(@builtin(vertex_index) id:u32,@location(0) direction:vec3f,@location(1) flux:vec3f)->StarVertex{
 let corners=array<vec2f,6>(vec2f(-1,-1),vec2f(1,-1),vec2f(1,1),vec2f(-1,-1),vec2f(1,1),vec2f(-1,1));
 let d=(F.starRotation*vec4f(direction,0)).xyz;let q=starFaceDirection(d,u32(SF.axis.x));
 let size=SF.axis.y;let uv=corners[id];let spread=2.0;
 var o:StarVertex;o.position=vec4f(vec2f(q.x,-q.y)/max(q.z,.00001)+uv*(2.0*spread/size),0,1);
 if(q.z<=0.0||d.y<=0.0||F.celestial.y<=0.0){o.position=vec4f(3,3,0,1);}
 o.uv=uv;o.flux=flux/max(q.z*q.z*q.z,.00001);o.altitude=d.y;return o;
}
@fragment fn fs(o:StarVertex)->@location(0) vec4f{
 let radius=dot(o.uv,o.uv);if(radius>1.0){discard;}
 // Unit-integral Gaussian PSF, physical stellar flux distributed over cube texels.
 let gaussian=exp(-4.0*radius)*1.297;let size=SF.axis.y;
 let solidAngle=4.0/(size*size);let psfArea=4.0;
 let airmass=1.0/max(o.altitude,.04);let extinction=exp(-vec3f(.12,.16,.23)*airmass*max(.5,F.atmo.x/3.0));
 return vec4f(o.flux*gaussian/(solidAngle*psfArea)*extinction*F.celestial.y,1);
}
`;
export const CELESTIAL_LINES=FRAME_WGSL+/* wgsl */ `
@group(0) @binding(0) var<uniform> F:Frame;
@group(0) @binding(1) var cloudScreen:texture_2d<f32>;
@group(0) @binding(2) var lineSampler:sampler;
struct ConstellationVertex{@builtin(position) position:vec4f,@location(0) altitude:f32};
@vertex fn vs(@location(0) direction:vec3f)->ConstellationVertex{
 let d=(F.starRotation*vec4f(direction,0)).xyz;
 var o:ConstellationVertex;o.position=F.viewProj*vec4f(d*100000.0,1);o.position.z=0.0;o.altitude=d.y;return o;
}
@fragment fn fs(o:ConstellationVertex)->@location(0) vec4f{
 if(o.altitude<=0.0||F.celestial.z<=0.0){discard;}
 let cloud=textureSampleLevel(cloudScreen,lineSampler,o.position.xy/F.screen.xy,0).a;
 let opacity=(1.0-smoothstep(.05,.8,cloud))*F.celestial.z;
 return vec4f(vec3f(.18,.28,.38)*opacity/max(F.post.x,.001),opacity);
}
`;

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
  let p=vec3f((uv.x-0.5)*16.0,uv.y*BAKE.shape.y,(uv.z-0.5)*16.0);
  let detail=vec3f(cloudNoise(p*4.0,64.0),cloudNoise(p*8.0,128.0),cloudNoise(p*16.0,256.0));
  let warp=(detail-0.5)*vec3f(0.32,0.24,0.32);
  let q=p+warp;
  let shape=vec4f(cloudNoise(q*0.5,8.0),cloudNoise(q,16.0),cloudNoise(q*2.0,32.0),cloudNoise(q*4.0,64.0));
  let distortion=(shape.gba-0.5)*vec3f(0.64,0.36,0.64)+warp;
  let body=roundedCloudBody(p+distortion,shape,detail);
  let fade=smoothstep(0.02,0.13,uv.y)*(1.0-smoothstep(0.97,1.0,uv.y));
  let density=body.xy*1.6*fade;
  textureStore(dst,vec3i(id),vec4f(density,max(density.x,0.0),max(body.z,-0.30)));
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
struct CloudRay { color:vec4f, distance:f32 };
fn marchClouds(ro:vec3f,rd:vec3f,budget:u32,jitter:f32,sunColor:vec3f,skyColor:vec3f)->CloudRay {
  var out:CloudRay;out.color=vec4f(0);out.distance=0.0;
  if(CF.screen.w<0.5){return out;}
  let hit=cloudInterval(ro,rd);if(hit.y<=hit.x){return out;}
  let phase=saturate(dot(rd,F.sunDir.xyz)*0.5+0.5);
  let scatter=0.10+0.30*pow(phase,4.0);let silverPhase=pow(phase,24.0);
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
    let density=cloudDensityAt(p,lod);
    let alpha=1.0-exp(-max(density.r,0.0)*step*CF.shape.z);
    if(alpha>0.00001){
      let light=textureSampleLevel(cloudLight,cloudSampler,cloudUV(p),lod);
      let visibility=saturate(light.b);let diffuse=saturate(light.r);let upper=saturate(light.g);let ao=clamp(light.a,0.18,1.0);
      let root=sqrt(visibility);
      let direct=visibility*(0.20+0.80*diffuse);
      let bounce=(0.035+0.18*sqrt(root))*(0.25+0.75*upper)*ao;
      let ambient=(0.10+0.19*upper)*ao;
      let silver=silverPhase*root*pow(max(1.0-diffuse,0.0),0.90)*(1.0-smoothstep(0.02,0.20,density.a))*0.25;
      let lit=sunColor*((direct+scatter*visibility+bounce)*0.20+silver)+skyColor*(ambient*2.4+0.15);
      let air=exp(-t*(0.009+F.atmo.x*0.003));
      let radiance=mix(skyDistance,lit,air);
      let contribution=tr*alpha;color+=contribution*radiance;depth+=contribution*t;weight+=contribution;
      tr*=1.0-alpha;
      if(tr<0.008){break;}
    }
  }
  out.color=vec4f(color,clamp(1.0-tr,0.0,1.0));out.distance=depth/max(weight,0.00001);
  return out;
}
`;

export const CLOUD_CAMERA_RAYS = /* wgsl */ `
@group(0) @binding(4) var colorOut:texture_storage_2d<rgba16float,write>;
@group(0) @binding(5) var depthOut:texture_storage_2d<r32float,write>;
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) id:vec3u){
  let size=textureDimensions(colorOut);if(any(id.xy>=size)){return;}
  let uv=(vec2f(id.xy)+0.5)/vec2f(size);let ndc=uv*vec2f(2,-2)+vec2f(-1,1);
  let rd=normalize(F.camFwd.xyz+ndc.x*F.camRight.xyz+ndc.y*F.camUp.xyz);
  let jitter=fract(cloudRayJitter(id.xy)+f32(u32(CF.screen.z)%64u)*0.61803398875);
  let ray=marchClouds(F.camPos.xyz*0.001,rd,64u,jitter,sunIlluminance(),skyAtmo(vec3f(0,1,0)));
  textureStore(colorOut,vec2i(id.xy),ray.color);textureStore(depthOut,vec2i(id.xy),vec4f(ray.distance));
}
`;

export const CLOUD_RESOLVE = /* wgsl */ `
@group(0) @binding(0) var<uniform> F:Frame;
@group(0) @binding(1) var rawColor:texture_2d<f32>;
@group(0) @binding(2) var rawDepth:texture_2d<f32>;
@group(0) @binding(3) var history:texture_2d<f32>;
@group(0) @binding(4) var historyDepth:texture_2d<f32>;
@group(0) @binding(5) var linearSampler:sampler;
@group(0) @binding(6) var resolved:texture_storage_2d<rgba16float,write>;
@group(0) @binding(7) var depthOut:texture_storage_2d<r32float,write>;
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) id:vec3u){
  let size=vec2i(textureDimensions(resolved));let p=vec2i(id.xy);if(any(p>=size)){return;}
  let current=textureLoad(rawColor,p,0);let distance=textureLoad(rawDepth,p,0).r;
  var result=current;
  if(CF.shape.w>0.5 && current.a>0.0001 && distance>0.0){
    let uv=(vec2f(p)+0.5)/vec2f(size);let ndc=uv*vec2f(2,-2)+vec2f(-1,1);
    let dir=normalize(F.camFwd.xyz+ndc.x*F.camRight.xyz+ndc.y*F.camUp.xyz);
    let shift=(CF.advection.xy-CF.advection.zw)*1000.0;
    let world=F.camPos.xyz+dir*distance*1000.0+vec3f(shift.x,0,shift.y);
    let previous=CF.previousView*vec4f(world-CF.previousCamera.xyz,1.0);
    let at=previous.xy/max(previous.w,0.0001)*vec2f(0.5,-0.5)+0.5;
    if(previous.w>0.0 && all(at>vec2f(0)) && all(at<vec2f(1))){
      let oldDepth=textureLoad(historyDepth,clamp(vec2i(at*vec2f(size)),vec2i(0),size-1),0).r;
      let expected=length(world-CF.previousCamera.xyz)*0.001;
      if(abs(oldDepth-expected)<max(0.35,distance*0.15)){
        var lo=current;var hi=current;
        for(var y=-1;y<=1;y++){for(var x=-1;x<=1;x++){
          let c=textureLoad(rawColor,clamp(p+vec2i(x,y),vec2i(0),size-1),0);lo=min(lo,c);hi=max(hi,c);
        }}
        let old=clamp(textureSampleLevel(history,linearSampler,at,0.0),lo,hi);
        let confidence=0.86*(1.0-saturate(abs(old.a-current.a)*2.0));
        result=mix(current,old,confidence);
      }
    }
  }
  textureStore(resolved,p,result);textureStore(depthOut,p,vec4f(distance));
}
`;

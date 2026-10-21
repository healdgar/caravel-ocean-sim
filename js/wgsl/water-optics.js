// Copyright (c) 2026 Six Cailloux, LLC. MIT.

// Shared air/water interface. Coefficients approximate clear blue-green water
// plus a neutral suspended-particle load; turbidity is an authored parameter.
export const WATER_OPTICS=/* wgsl */ `
const WATER_REFRACTIVE_INDEX:f32=1.333;
fn waterFresnel(c:f32)->f32 {
  let cosine=clamp(c,0.0,1.0);
  let transmitted=sqrt(max(0.0,1.0-(1.0-cosine*cosine)/(WATER_REFRACTIVE_INDEX*WATER_REFRACTIVE_INDEX)));
  let perpendicular=(cosine-WATER_REFRACTIVE_INDEX*transmitted)/(cosine+WATER_REFRACTIVE_INDEX*transmitted);
  let parallel=(WATER_REFRACTIVE_INDEX*cosine-transmitted)/(WATER_REFRACTIVE_INDEX*cosine+transmitted);
  return clamp(.5*(perpendicular*perpendicular+parallel*parallel),0.0,1.0);
}
fn waterInteriorFresnel(c:f32)->f32 {
  let cosine=clamp(c,0.0,1.0);
  let sineSquared=WATER_REFRACTIVE_INDEX*WATER_REFRACTIVE_INDEX*(1.0-cosine*cosine);
  if(sineSquared>=1.0){return 1.0;}
  let transmitted=sqrt(max(0.0,1.0-sineSquared));
  let perpendicular=(WATER_REFRACTIVE_INDEX*cosine-transmitted)/max(WATER_REFRACTIVE_INDEX*cosine+transmitted,.000001);
  let parallel=(cosine-WATER_REFRACTIVE_INDEX*transmitted)/max(cosine+WATER_REFRACTIVE_INDEX*transmitted,.000001);
  return clamp(.5*(perpendicular*perpendicular+parallel*parallel),0.0,1.0);
}
fn waterTransmittance(path:f32,turbidity:f32)->vec3f {
  let extinction=vec3f(.20,.065,.035)+max(turbidity,0.0)*vec3f(.11,.095,.085);
  return exp(-extinction*max(path,0.0));
}
fn waterRefract(view:vec3f,normal:vec3f)->vec3f {
  let v=normalize(view);var n=normalize(normal);
  if(dot(n,v)<0.0){n=-n;}
  return normalize(refract(-v,n,1.0/WATER_REFRACTIVE_INDEX));
}
`;

// Opaque scene radiance and forward camera depth are captured before water.
// Each water fragment traces a refracted ray to that screen-space depth layer.
// This is a bounded screen-space approximation: unavailable/off-screen surfaces
// fade to the ordinary water body, rather than exposing unclipped scene colour.
export const WATER_TRANSMISSION=WATER_OPTICS+/* wgsl */ `
@group(3)@binding(0)var underwaterSource:texture_2d<f32>;
@group(3)@binding(1)var opticsSampler:sampler;
@group(3)@binding(2)var<uniform>optics:vec4f;
fn waterSourceSample(uv:vec2f)->vec4f {
  // Eye depth is metadata: blending it against clear alpha zero invents a
  // shallow object at a deep silhouette's edge. Keep exact nearest depth and
  // filter radiance only where neighboring samples describe the same surface.
  let dimensions=vec2i(textureDimensions(underwaterSource));
  let pixel=clamp(vec2i(floor(uv*vec2f(dimensions))),vec2i(0),dimensions-1);
  let nearest=textureLoad(underwaterSource,pixel,0);
  if(nearest.a<=0.0){return vec4f(0);}
  let filtered=textureSampleLevel(underwaterSource,opticsSampler,uv,0.0);
  let continuous=abs(filtered.a-nearest.a)<max(.02,nearest.a*.005);
  return vec4f(select(nearest.rgb,filtered.rgb,continuous),nearest.a);
}
fn waterProject(world:vec3f)->vec2f {
  let clip=F.viewProj*vec4f(world-F.camPos.xyz,1);
  return clip.xy/max(clip.w,.0001)*vec2f(.5,-.5)+.5;
}
fn waterSourcePosition(uv:vec2f,depth:f32)->vec3f {
  let ray=F.camFwd.xyz+(uv.x*2.0-1.0)*F.camRight.xyz+(1.0-uv.y*2.0)*F.camUp.xyz;
  return F.camPos.xyz+ray*(depth/max(dot(ray,normalize(F.camFwd.xyz)),.001));
}
fn waterSourceValid(uv:vec2f,source:vec4f,surface:vec3f,surfaceDepth:f32)->bool {
  // Reverse-Z foreground surfaces must not be pulled into water. Forward-depth
  // alpha is used here so the check stays independent of projection near plane.
  if(any(uv<=vec2f(0))||any(uv>=vec2f(1))||source.a<=surfaceDepth+.025){return false;}
  return waterSourcePosition(uv,source.a).y<surface.y+.025;
}
struct WaterSourceHit {source:vec4f,uv:vec2f,path:f32,valid:f32};
fn waterTraceSource(world:vec3f,ray:vec3f,alongForward:f32,surfaceDepth:f32,start:vec2f)->WaterSourceHit {
  var hit:WaterSourceHit;hit.valid=0.0;hit.path=0.0;hit.uv=start;
  hit.source=waterSourceSample(hit.uv);
  if(!waterSourceValid(hit.uv,hit.source,world,surfaceDepth)){return hit;}
  for(var refine=0u;refine<2u;refine++){
    hit.path=clamp((hit.source.a-surfaceDepth)/alongForward,0.0,500.0);
    hit.uv=waterProject(world+ray*hit.path);
    hit.source=waterSourceSample(hit.uv);
    if(!waterSourceValid(hit.uv,hit.source,world,surfaceDepth)){return hit;}
  }
  hit.path=clamp((hit.source.a-surfaceDepth)/alongForward,0.0,500.0);hit.valid=1.0;return hit;
}
fn waterTransmission(world:vec3f,normal:vec3f,body:vec3f)->vec3f {
  // This path observes the interface from air. Underwater scene variants use
  // the interior dielectric branch; a crest can still rise above an air eye.
  if(optics.y<.5){return body;}
  let forward=normalize(F.camFwd.xyz);
  let surfaceDepth=dot(world-F.camPos.xyz,forward);
  if(surfaceDepth<=0.0){return body;}
  let view=normalize(F.camPos.xyz-world);
  let ray=waterRefract(view,normal);
  let alongForward=dot(ray,forward);
  if(alongForward<=.001){return body;}
  var hit=waterTraceSource(world,ray,alongForward,surfaceDepth,waterProject(world));
  // An isolated animal has no depth outside its original silhouette. Probe a
  // few bounded distances down the refracted ray so that its moved silhouette
  // can enter those pixels; a depth lookup at the original UV alone clips it.
  if(hit.valid<.5){
    let distances=array<f32,3>(3.0,12.0,36.0);
    for(var sample=0u;sample<3u;sample++){
      hit=waterTraceSource(world,ray,alongForward,surfaceDepth,waterProject(world+ray*distances[sample]));
      if(hit.valid>.5){break;}
    }
  }
  if(hit.valid<.5){return body;}
  let edge=min(min(hit.uv.x,1.0-hit.uv.x),min(hit.uv.y,1.0-hit.uv.y));
  let available=smoothstep(0.0,.025,edge);
  let transmission=waterTransmittance(hit.path,optics.x)*available;
  return mix(body,hit.source.rgb,transmission);
}
`;

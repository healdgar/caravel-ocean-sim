// Copyright (c) 2026 Six Cailloux, LLC. MIT.
// Directional surface reconstruction adapts Castle and Commons, copyright
// (c) 2026 healdgar, MIT. Receipts and limits: THIRD_PARTY_NOTICES.md.
import { FRAME_WGSL, ATMO_CORE_WGSL } from './common.js';
import { SKY_RENDER_FUNCS } from './sky.js';
import { CLOUD_SAMPLE } from './clouds.js';

export const WOODLAND = FRAME_WGSL + ATMO_CORE_WGSL + /* wgsl */ `
@group(0) @binding(0) var<uniform> F:Frame;
@group(0) @binding(1) var transLUT:texture_2d<f32>;
@group(0) @binding(2) var skyLUT:texture_2d<f32>;
@group(0) @binding(3) var sampC:sampler;
@group(0) @binding(4) var envCube:texture_cube<f32>;
@group(0) @binding(5) var landLight:texture_2d<f32>;
struct WoodlandLand { domain:vec4f };
@group(0) @binding(6) var<uniform> woodlandLand:WoodlandLand;
struct WoodlandPlant {
  centreRadius:vec4f,
  low:vec4f,
  high:vec4f,
  woodColour:vec4f,
  tile:vec4f,
  scaleInfo:vec4f,
};
struct WoodlandInfo { atlas:vec4f, plants:array<WoodlandPlant,2> };
@group(0) @binding(7) var<uniform> woodlandInfo:WoodlandInfo;
@group(0) @binding(8) var woodlandColour:texture_2d<f32>;
@group(0) @binding(9) var woodlandNormal:texture_2d<f32>;
@group(0) @binding(10) var woodlandDepth:texture_2d<f32>;
@group(0) @binding(11) var woodlandColourSampler:sampler;
` + SKY_RENDER_FUNCS + CLOUD_SAMPLE + /* wgsl */ `
struct WoodlandVertex {
  @builtin(position) position:vec4f,
  @location(0) world:vec3f,
  @location(1) normal:vec3f,
  @location(2) @interpolate(flat) root:vec4f,
  @location(3) @interpolate(flat) shape:vec4f,
};
fn woodlandYaw(p:vec2f,angle:f32)->vec2f {
  let c=cos(angle);let s=sin(angle);return vec2f(p.x*c-p.y*s,p.x*s+p.y*c);
}
fn woodlandWind(shape:vec4f)->vec2f {
  let wind=F.windP[0].xy/max(length(F.windP[0].xy),1.0);
  let crosswind=vec2f(-wind.y,wind.x);
  let phase=shape.y;
  return (wind*(0.7+0.3*sin(F.camPos.w*0.65+phase))+
    crosswind*sin(F.camPos.w*0.49+phase)*0.22)*clamp(F.windP[0].z/12.0,0.0,2.2)*0.018;
}
// The exact same quadratic height shear moves native wood, the reconstructed
// surface and its normal. Inverse point/ray derivatives include that shear;
// a bent crown is not traced as an unrelated undeformed straight ray.
fn woodlandWorldPoint(p:vec3f,root:vec4f,shape:vec4f,plant:WoodlandPlant)->vec3f {
  let h=plant.scaleInfo.x;let height=shape.x*h;
  let shift=woodlandWind(shape)*height*(p.y/h)*(p.y/h);
  let xz=woodlandYaw(p.xz*root.w,shape.y)+root.xz+shift;
  return vec3f(xz.x,root.y+p.y*shape.x,xz.y);
}
fn woodlandLocalPoint(p:vec3f,root:vec4f,shape:vec4f,plant:WoodlandPlant)->vec3f {
  let y=(p.y-root.y)/shape.x;let h=plant.scaleInfo.x;
  let shift=woodlandWind(shape)*(shape.x*h)*(y/h)*(y/h);
  let xz=woodlandYaw(p.xz-root.xz-shift,-shape.y)/root.w;
  return vec3f(xz.x,y,xz.y);
}
fn woodlandLocalDerivative(direction:vec3f,p:vec3f,root:vec4f,shape:vec4f,plant:WoodlandPlant)->vec3f {
  let shear=woodlandWind(shape)*(2.0*p.y/plant.scaleInfo.x);
  let xz=woodlandYaw(direction.xz-shear*direction.y,-shape.y)/root.w;
  return vec3f(xz.x,direction.y/shape.x,xz.y);
}
fn woodlandWorldNormal(n:vec3f,p:vec3f,root:vec4f,shape:vec4f,plant:WoodlandPlant)->vec3f {
  let xz=woodlandYaw(n.xz/root.w,shape.y);
  let shear=woodlandWind(shape)*(2.0*p.y/plant.scaleInfo.x);
  return normalize(vec3f(xz.x,n.y/shape.x-dot(xz,shear),xz.y));
}
fn woodlandRestCentre(root:vec4f,shape:vec4f,plant:WoodlandPlant)->vec3f {
  let xz=woodlandYaw(plant.centreRadius.xz*root.w,shape.y)+root.xz;
  return vec3f(xz.x,root.y+plant.centreRadius.y*shape.x,xz.y);
}
fn woodlandBoundRadius(root:vec4f,shape:vec4f,plant:WoodlandPlant)->f32 {
  let r=plant.centreRadius.w;let h=plant.scaleInfo.x;
  // |windDirection| <=1.22, force<=.0396. .061 covers their product.
  // The sphere includes the maximum whole-crown displacement, not just its
  // shifted centre. CPU culling uses precisely this same bound.
  let maximumY=abs(plant.centreRadius.y)+r;
  return r*max(root.w,shape.x)+0.061*(shape.x*h)*(maximumY/h)*(maximumY/h);
}
@vertex fn woodlandWoodVS(@location(0) p:vec3f,@location(1) n:vec3f,
  @location(2) root:vec4f,@location(3) shape:vec4f)->WoodlandVertex {
  let plant=woodlandInfo.plants[u32(shape.z)];var out:WoodlandVertex;
  out.world=woodlandWorldPoint(p,root,shape,plant);
  out.normal=woodlandWorldNormal(n,p,root,shape,plant);out.root=root;out.shape=shape;
  out.position=F.viewProj*vec4f(out.world-F.camPos.xyz,1);return out;
}
@vertex fn woodlandCrownVS(@location(0) p:vec3f,
  @location(2) root:vec4f,@location(3) shape:vec4f)->WoodlandVertex {
  let plant=woodlandInfo.plants[u32(shape.z)];var out:WoodlandVertex;
  let centre=woodlandRestCentre(root,shape,plant);let radius=woodlandBoundRadius(root,shape,plant);
  if(shape.w<0.5){
    let delta=F.camPos.xyz-centre;let eye=normalize(delta);
    var right=cross(vec3f(0,1,0),eye);
    if(dot(right,right)<0.0001){right=vec3f(1,0,0);}else{right=normalize(right);}
    let up=cross(eye,right);
    // A centre-plane quad is expanded to cover the projected sphere's tangent
    // cone. Merely using radius clips the silhouette for a nearby billboard.
    let d=length(delta);let extent=radius*d/sqrt(max(d*d-radius*radius,0.0001));
    out.world=centre+(right*p.x+up*p.y)*extent;
  }else{out.world=centre+p*radius;}
  out.normal=vec3f(0,1,0);out.root=root;out.shape=shape;
  out.position=F.viewProj*vec4f(out.world-F.camPos.xyz,1);return out;
}
fn woodlandTileUV(q:vec2f,tile:u32,plant:WoodlandPlant)->vec2f {
  let size=plant.tile.z;let stride=size+2.0*plant.tile.w;
  let origin=plant.tile.xy+vec2f(f32(tile%8u),f32(tile/8u))*stride+plant.tile.w;
  let inset=vec2f(0.5/size);
  return (origin+clamp(q,inset,vec2f(1)-inset)*size)/woodlandInfo.atlas.xy;
}
fn woodlandData(texture:texture_2d<f32>,q:vec2f,tile:u32,plant:WoodlandPlant)->vec4f {
  let uv=woodlandTileUV(q,tile,plant);
  return textureLoad(texture,vec2i(floor(uv*vec2f(textureDimensions(texture)))),0);
}
struct WoodlandHit { valid:f32,t:f32,point:vec3f,normal:vec3f,colour:vec3f,leaf:f32 };
struct WoodlandDepthProbe {
  valid:f32,t:f32,point:vec3f,q:vec2f,cell:vec2i,value:vec4f,residual:f32,
};
// One directional atlas stores the nearest baked surface, not a filled volume.
// Empty pixels cannot be converted into occluding crown mass. Search and solve
// are bounded approximations; they cannot recover hidden layers or certify all
// sub-texel leaves. The cap is deliberately visible for the held GPU comparison.
const WOODLAND_SEARCH_STEPS=32u;
const WOODLAND_REFINE_STEPS=3u;
const WOODLAND_SEARCH_BRACKETS=2u;
fn woodlandDepthProbe(origin:vec3f,direction:vec3f,t:f32,view:u32,
  eye:vec3f,right:vec3f,up:vec3f,root:vec4f,shape:vec4f,plant:WoodlandPlant)->WoodlandDepthProbe {
  var probe:WoodlandDepthProbe;probe.valid=0;probe.t=t;
  let local=woodlandLocalPoint(origin+direction*t,root,shape,plant);
  let p=(local-plant.centreRadius.xyz)/plant.centreRadius.w;
  let q=vec2f(0.5+0.5*dot(p,right),0.5-0.5*dot(p,up));
  if(any(q<vec2f(0))||any(q>vec2f(1))){return probe;}
  let value=woodlandData(woodlandDepth,q,view,plant);
  if(value.a<0.1){return probe;}
  let depth=(round(value.r*255.0)*256.0+round(value.g*255.0))/65535.0;
  probe.valid=1;probe.point=local;probe.q=q;
  probe.cell=vec2i(floor(clamp(q,vec2f(0.5/plant.tile.z),vec2f(1.0-0.5/plant.tile.z))*plant.tile.z));
  probe.value=value;probe.residual=dot(p,eye)-(1.0-2.0*depth);return probe;
}
fn woodlandResidualLimit(origin:vec3f,interval:vec2f,root:vec4f,shape:vec4f,plant:WoodlandPlant)->f32 {
  // Two encoded depth units plus a conservative f32 coordinate-roundoff term.
  // This is independent of atlas texel width: a loose UV tolerance must never
  // masquerade as convergence onto a different branch's depth layer.
  let scale=plant.centreRadius.w*min(root.w,shape.x);
  let arithmetic=8.0*1.1920929e-7*(length(origin-root.xyz)+interval.y)/max(scale,0.0001);
  return 4.0/65535.0+arithmetic;
}
fn woodlandRefineDepth(origin:vec3f,direction:vec3f,interval:vec2f,view:u32,
  eye:vec3f,right:vec3f,up:vec3f,root:vec4f,shape:vec4f,plant:WoodlandPlant,
  before:WoodlandDepthProbe,after:WoodlandDepthProbe,epsilon:f32)->WoodlandDepthProbe {
  var invalid:WoodlandDepthProbe;invalid.valid=0;
  var lo=before;var hi=after;
  var t=lo.t;if(abs(hi.residual)<abs(lo.residual)){t=hi.t;}
  var previousCell=vec2i(-1);var previousMaterial=-1.0;
  for(var iteration=0u;iteration<WOODLAND_REFINE_STEPS;iteration++){
    let probe=woodlandDepthProbe(origin,direction,t,view,eye,right,up,root,shape,plant);
    if(probe.valid<0.5){return invalid;}
    previousCell=probe.cell;previousMaterial=step(0.5,probe.value.b);
    if(abs(probe.residual)<=epsilon){continue;}
    if((probe.residual>=0.0)==(lo.residual>=0.0)){lo=probe;}else{hi=probe;}
    let derivative=woodlandLocalDerivative(direction,probe.point,root,shape,plant)/plant.centreRadius.w;
    let denominator=dot(derivative,eye);
    var nextT=(lo.t+hi.t)*0.5;
    if(abs(denominator)>0.00001){
      let proposed=t-probe.residual/denominator;
      if(proposed>lo.t&&proposed<hi.t){nextT=proposed;}
    }
    t=clamp(nextT,interval.x,interval.y);
  }
  // Re-read the actual final point. The final correction must stay on the
  // previous nearest-depth texel and material, not merely within two texels of
  // it. A bracket over a discontinuity therefore cannot invent a bridge.
  var probe=woodlandDepthProbe(origin,direction,t,view,eye,right,up,root,shape,plant);
  if(probe.valid<0.5||any(probe.cell!=previousCell)||step(0.5,probe.value.b)!=previousMaterial||
    abs(probe.residual)>epsilon){return invalid;}
  return probe;
}
fn woodlandViewHit(origin:vec3f,direction:vec3f,interval:vec2f,view:u32,
  root:vec4f,shape:vec4f,plant:WoodlandPlant)->WoodlandHit {
  var result:WoodlandHit;result.valid=0.0;
  let a=f32(view%8u)*PI/4.0;let e=f32(view/8u)*35.0*PI/180.0;
  let eye=vec3f(cos(e)*cos(a),sin(e),cos(e)*sin(a));
  let right=vec3f(sin(a),0,-cos(a));let up=cross(eye,right);
  let epsilon=woodlandResidualLimit(origin,interval,root,shape,plant);
  var previous:WoodlandDepthProbe;previous.valid=0;
  var resolved:WoodlandDepthProbe;resolved.valid=0;var attempts=0u;
  // Common sphere entry is frequently empty: a crown is narrower than its
  // bounding sphere. Scan through to EXIT instead of rejecting that first
  // empty lookup. Invalid samples break a bracket; they are never solid fill.
  for(var march=0u;march<=WOODLAND_SEARCH_STEPS;march++){
    let t=mix(interval.x,interval.y,f32(march)/f32(WOODLAND_SEARCH_STEPS));
    let probe=woodlandDepthProbe(origin,direction,t,view,eye,right,up,root,shape,plant);
    if(probe.valid<0.5){previous.valid=0;continue;}
    if(abs(probe.residual)<=epsilon){
      resolved=woodlandRefineDepth(origin,direction,interval,view,eye,right,up,root,shape,plant,probe,probe,epsilon);
    }else if(previous.valid>0.5&&((previous.residual>=0.0)!=(probe.residual>=0.0))){
      resolved=woodlandRefineDepth(origin,direction,interval,view,eye,right,up,root,shape,plant,previous,probe,epsilon);
      attempts++;
    }
    if(resolved.valid>0.5){break;}
    if(attempts>=WOODLAND_SEARCH_BRACKETS){break;}
    previous=probe;
  }
  if(resolved.valid<0.5){return result;}
  let p=(resolved.point-plant.centreRadius.xyz)/plant.centreRadius.w;
  if(length(p)>1.03){return result;}
  let uv=woodlandTileUV(resolved.q,view,plant);
  let colour=textureSampleLevel(woodlandColour,woodlandColourSampler,uv,0.0);
  if(colour.a<0.1){return result;}
  // Detailed tiers draw their real reduced wood. The atlas fills only leaves,
  // avoiding a second, slightly different wood surface at the same pixels.
  if(shape.w>0.5&&resolved.value.b<0.5){return result;}
  let encoded=woodlandData(woodlandNormal,resolved.q,view,plant).rgb*2.0-1.0;
  if(dot(encoded,encoded)<0.0001){return result;}
  result.valid=1;result.t=resolved.t;result.point=resolved.point;result.normal=normalize(encoded);
  result.colour=colour.rgb;result.leaf=step(0.5,resolved.value.b);return result;
}
fn woodlandFinish(world:vec3f,normal:vec3f,albedo:vec3f,leaf:f32)->vec4f {
  let uv=(world.xz-woodlandLand.domain.xy)/woodlandLand.domain.z+0.5;
  let visibility=textureSampleLevel(landLight,sampC,uv,0.0).r;
  let sunlight=sunIlluminance()*visibility;
  let ambient=textureSampleLevel(envCube,sampC,vec3f(0,1,0),7.0).rgb;
  let nl=dot(normal,F.sunDir.xyz);
  let diffuse=max(nl,0.0)+leaf*0.15*max(-nl,0.0);
  let v=normalize(F.camPos.xyz-world);
  // Authored diffuse self-occlusion only; no claim of resolved leaf scattering
  // or crown-to-crown shadows. Terrain/cloud sunlight is shared with the land.
  var colour=albedo*(sunlight*diffuse/PI+ambient*mix(0.48,0.38,leaf));
  colour+=lightningSurface(normal,v,albedo,mix(0.92,0.88,leaf));
  colour=surfaceAir(colour,world);
  let cloud=marchCloudsTo(F.camPos.xyz*0.001,normalize(world-F.camPos.xyz),12u,0.5,
    sunIlluminance(),skyAtmo(vec3f(0,1,0)),distance(world,F.camPos.xyz)*0.001);
  return vec4f(colour*(1.0-cloud.color.a)+cloud.color.rgb,1);
}
@fragment fn woodlandWoodFS(in:WoodlandVertex)->@location(0) vec4f {
  return woodlandFinish(in.world,normalize(in.normal),woodlandInfo.plants[u32(in.shape.z)].woodColour.rgb,0);
}
struct WoodlandFragment { @location(0) colour:vec4f,@builtin(frag_depth) depth:f32 };
@fragment fn woodlandCrownFS(in:WoodlandVertex)->WoodlandFragment {
  let plant=woodlandInfo.plants[u32(in.shape.z)];let origin=F.camPos.xyz;
  let direction=normalize(in.world-origin);let centre=woodlandRestCentre(in.root,in.shape,plant);
  let radius=woodlandBoundRadius(in.root,in.shape,plant);let delta=origin-centre;
  let b=dot(delta,direction);let perpendicular=delta-direction*b;
  let discriminant=radius*radius-dot(perpendicular,perpendicular);
  if(discriminant<=0.0){discard;}
  let interval=vec2f(max(0.0,-b-sqrt(discriminant)),-b+sqrt(discriminant));
  if(interval.y<=interval.x){discard;}
  // Every proxy triangle starts at this same world-space ray/sphere entry.
  // The raster face position is never used as the depth-query starting point.
  let actualCentre=woodlandWorldPoint(plant.centreRadius.xyz,in.root,in.shape,plant);
  let localEye=normalize(woodlandLocalDerivative(origin-actualCentre,plant.centreRadius.xyz,in.root,in.shape,plant));
  var azimuth=atan2(localEye.z,localEye.x);if(azimuth<0.0){azimuth+=2.0*PI;}
  let ap=azimuth/(PI/4.0);let ep=clamp(asin(clamp(localEye.y,-1.0,1.0))/(35.0*PI/180.0),0.0,2.0);
  var hits:array<WoodlandHit,4>;var weights:array<f32,4>;
  var closest=1e30;var closestIndex=0u;var found=false;
  for(var i=0u;i<4u;i++){
    var ai=u32(floor(ap))+i%2u;var ei=u32(floor(min(ep,1.99999)))+i/2u;
    var weight=mix(1.0-fract(ap),fract(ap),f32(i%2u))*mix(1.0-(ep-floor(min(ep,1.99999))),ep-floor(min(ep,1.99999)),f32(i/2u));
    if(in.shape.w<0.5){
      ai=u32(floor(ap+0.5));ei=u32(floor(ep+0.5));weight=select(0.0,1.0,i==0u);
    }
    weights[i]=weight;
    if(weight<=0.0001){continue;}
    hits[i]=woodlandViewHit(origin,direction,interval,(ai%8u)+min(ei,2u)*8u,in.root,in.shape,plant);
    if(hits[i].valid>0.5&&hits[i].t<closest){closest=hits[i].t;closestIndex=i;found=true;}
  }
  if(!found){discard;}
  let selected=hits[closestIndex];var colour=vec3f(0);var normal=vec3f(0);var sum=0.0;var leaf=0.0;
  // Keep the frontmost resolved depth. Only co-located directional witnesses
  // blend colour/normal; averaging unrelated front/back surfaces invents depth.
  let tolerance=4.0*plant.centreRadius.w*max(in.root.w,in.shape.x)/plant.tile.z;
  for(var i=0u;i<4u;i++){
    if(weights[i]<=0.0001||hits[i].valid<0.5||abs(hits[i].t-closest)>tolerance){continue;}
    let w=weights[i];sum+=w;colour+=hits[i].colour*w;normal+=hits[i].normal*w;leaf+=hits[i].leaf*w;
  }
  if(sum<0.0001){discard;}
  colour/=sum;leaf/=sum;
  if(dot(normal,normal)<0.0001){normal=selected.normal;}else{normal=normalize(normal);}
  let world=origin+direction*closest;
  let worldNormal=woodlandWorldNormal(normal,selected.point,in.root,in.shape,plant);
  let clip=F.viewProj*vec4f(world-F.camPos.xyz,1);
  if(clip.w<=0.0||clip.z<0.0||clip.z>clip.w){discard;}
  var out:WoodlandFragment;out.colour=woodlandFinish(world,worldNormal,colour,leaf);
  out.depth=clip.z/clip.w;return out;
}
`;

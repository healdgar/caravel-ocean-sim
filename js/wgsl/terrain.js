import { FRAME_WGSL, ATMO_CORE_WGSL } from './common.js';
import { SKY_RENDER_FUNCS } from './sky.js';
import { CLOUD_SAMPLE } from './clouds.js';

// Procedurals need their sampling rate in material coordinates, just as image
// textures need mip/anisotropic footprints. See pbr-book.org/4ed/Textures_and_Materials/Texture_Sampling_and_Antialiasing.
// Derivatives are supplied by the caller before material-dependent branches.
export const TERRAIN_FILTERING = /* wgsl */ `
fn landMaterialFootprint(dx:vec2f,dy:vec2f)->f32{
  // Frobenius norm bounds the longest axis of the pixel's material footprint,
  // including oblique/sheared projections; max(length(dx),length(dy)) can miss it.
  return sqrt(dot(dx,dx)+dot(dy,dy));
}
fn landDetailWeight(cellWidth:f32)->f32{
  // A lattice cell needs several pixels. Remove its contrast before Nyquist;
  // multiplying a fully aliased sample by a distant world-metre fade is too late.
  return 1.0-smoothstep(0.125,0.5,cellWidth);
}
fn landFilteredNoise(p:vec2f,cellWidth:f32)->f32{
  let weight=landDetailWeight(cellWidth);
  if(weight<=0.0){return 0.0;}
  return gnoise(p)*weight; // Gradient noise has zero mean.
}
fn landFilteredFissure(p:vec2f,cellWidth:f32,inner:f32,outer:f32)->f32{
  // Thresholding noise introduces much finer features than the lattice itself.
  // Fade crack contrast at its own width, never threshold already-faded noise
  // (which would turn every unresolved cell into a dark crack). Unresolved crack
  // contrast returns to the registered material colour, not a darkened plateau.
  let weight=landDetailWeight(cellWidth/max(outer-inner,0.001));
  if(weight<=0.0){return 0.0;}
  return (1.0-smoothstep(inner,outer,abs(gnoise(p))))*weight;
}
fn landFilteredBump(n:vec3f,dx:vec3f,dy:vec3f,hx:f32,hy:f32)->vec3f{
  let sx=cross(dy,n);let sy=cross(n,dx);let det=dot(dx,sx);
  let area=length(cross(dx,dy));
  // Smooth vertex normals can become nearly tangent to a steep triangle. That
  // ill-conditioned inverse must not amplify tiny residual height differences.
  let confidence=smoothstep(0.08,0.25,abs(det)/max(area,0.000000000001));
  let gradient=(hx*sx+hy*sy)/max(abs(det),max(area*0.08,0.000000000001))*sign(det);
  return normalize(n-clamp(gradient,vec3f(-0.42),vec3f(0.42))*confidence);
}
`;

// These are actual production material functions, also exercised with synthetic
// registered imagery by the native GPU regression. No lighting/exposure changes.
export const TERRAIN_NEAR_MATERIAL = /* wgsl */ `
fn landNearImageConfidence(uv:vec2f,alpha:f32)->f32 {
  return select(0.0,smoothstep(.95,.995,alpha),all(uv>=vec2f(0))&&all(uv<=vec2f(1)));
}
fn landNearImage(p:vec2f,dx:vec2f,dy:vec2f)->vec4f {
  let uv=(p-nearTerrain.domain.xy)/nearTerrain.domain.z+.5;
  let sample=textureSampleGrad(nearAlbedo,landSampler,uv,dx/nearTerrain.domain.z,dy/nearTerrain.domain.z);
  return vec4f(pow(sample.rgb,vec3f(2.2)),landNearImageConfidence(uv,sample.a));
}
fn landNearRockImage(p:vec2f,dx:vec3f,dy:vec3f)->vec4f {
  let uv=(p-nearTerrain.domain.xy)/nearTerrain.domain.z+.5;
  // A cliff's overhead footprint collapses vertically. Use the complete surface
  // footprint, including the changing landward normal, and a stable 4m colour
  // seed. Angular rock detail uses surface coordinates below, not this photo.
  let metres=sqrt(dot(dx,dx)+dot(dy,dy));
  let texels=f32(textureDimensions(nearAlbedo).x)/nearTerrain.domain.z;
  let lod=log2(max(metres*texels,4.0*texels));
  let sample=textureSampleLevel(nearAlbedo,landSampler,uv,max(lod,0.0));
  return vec4f(pow(sample.rgb,vec3f(2.2)),landNearImageConfidence(uv,sample.a));
}
fn landNearFillMissing(selected:vec4f,seed:vec4f)->vec4f {
  // Keep colour and confidence associated until the final coarse fallback.
  // Mixing coarse RGB first would retain photographed sea even after a fully
  // qualified dry seed is found for the missing portion.
  let added=(1.0-selected.a)*seed.a;let confidence=selected.a+added;
  return vec4f((selected.rgb*selected.a+seed.rgb*added)/max(confidence,.0001),confidence);
}
fn landNearDryFallback(p:vec2f,dx:vec3f,dy:vec3f)->vec4f {
  // Only invalid raised pixels reach this bounded search. Flat retained coarse
  // cells can have no useful horizontal normal; their dry source still exists
  // nearby. Search nearest rings without inferring land from RGB hue.
  var selected=vec4f(0);
  for(var ring=0u;ring<3u;ring++){
    let radius=8.0*f32(1u<<ring);
    let a=landNearRockImage(p+vec2f(radius,0),dx,dy);
    let b=landNearRockImage(p-vec2f(radius,0),dx,dy);
    let c=landNearRockImage(p+vec2f(0,radius),dx,dy);
    let d=landNearRockImage(p-vec2f(0,radius),dx,dy);
    let total=a.a+b.a+c.a+d.a;
    let confidence=max(max(a.a,b.a),max(c.a,d.a));
    let colour=(a.rgb*a.a+b.rgb*b.a+c.rgb*c.a+d.rgb*d.a)/max(total,.0001);
    selected=landNearFillMissing(selected,vec4f(colour,confidence));
    if(selected.a>=.995){break;}
  }
  return selected;
}
fn landNearColour(coarse:vec3f,world:vec3f,n:vec3f,dx:vec3f,dy:vec3f,nx:vec3f,ny:vec3f,drySupport:f32)->vec3f {
  let uv=(world.xz-nearTerrain.domain.xy)/nearTerrain.domain.z+.5;
  let edge=min(min(uv.x,uv.y),min(1.0-uv.x,1.0-uv.y))*nearTerrain.domain.z;
  let raised=world.y>0.0;
  if(edge<=0.0||(!raised&&drySupport<=.95)){return coarse;}
  let fine=landNearImage(world.xz,dx.xz,dy.xz);
  // Keep the independent fine survey's actual diffuse colour. Normalizing it
  // against its 8m mip would reintroduce the coarse image's pale coastal strip.
  var selected=fine;
  let steep=smoothstep(.25,.65,1.0-max(n.y,0.0));
  if(steep>0.0||(raised&&fine.a<.995&&length(n.xz)>.001)){
    let horizontal=max(length(n.xz),.001);let outward=n.xz/horizontal;
    let inland=-outward;
    let inlandX=-(nx.xz-outward*dot(outward,nx.xz))/horizontal;
    let inlandY=-(ny.xz-outward*dot(outward,ny.xz))/horizontal;
    // Search the nearest confidently dry landward patch, never project the
    // geographic image around a vertical axis or use opaque WMS surf as rock.
    let a=landNearRockImage(world.xz+inland*8.0,dx+vec3f(inlandX.x,0,inlandX.y)*8.0,dy+vec3f(inlandY.x,0,inlandY.y)*8.0);
    let b=landNearRockImage(world.xz+inland*16.0,dx+vec3f(inlandX.x,0,inlandX.y)*16.0,dy+vec3f(inlandY.x,0,inlandY.y)*16.0);
    let c=landNearRockImage(world.xz+inland*32.0,dx+vec3f(inlandX.x,0,inlandX.y)*32.0,dy+vec3f(inlandY.x,0,inlandY.y)*32.0);
    let weights=vec3f(a.a,(1.0-a.a)*b.a,(1.0-a.a)*(1.0-b.a)*c.a);
    let confidence=dot(weights,vec3f(1));
    let rock=(a.rgb*weights.x+b.rgb*weights.y+c.rgb*weights.z)/max(confidence,.0001);
    selected=landNearFillMissing(selected,vec4f(rock,confidence));
    selected=vec4f(mix(selected.rgb,rock,steep*confidence),selected.a);
  }
  if(raised&&selected.a<.995){selected=landNearFillMissing(selected,landNearDryFallback(world.xz,dx,dy));}
  // A coarse-retained raised vertex can have no fine height support. That is a
  // geometry/provenance issue, not permission to skip available dry imagery.
  let support=select(smoothstep(.95,.995,drySupport),1.0,raised);
  return mix(coarse,selected.rgb,smoothstep(0.0,32.0,edge)*support*selected.a);
}
// Only neutral material coordinates rotate with the surface. The registered
// image above remains geographic XZ, with a separately chosen dry cliff seed.
fn landOrientedDetail(p:vec3f,n:vec3f,dx:vec3f,dy:vec3f,frequency:f32)->f32 {
  let w0=pow(abs(n),vec3f(4));let w=w0/max(dot(w0,vec3f(1)),0.0001);
  var value=0.0;
  if(w.x>.01){value+=w.x*landFilteredNoise(p.zy*frequency,landMaterialFootprint(dx.zy,dy.zy)*frequency);}
  if(w.y>.01){value+=w.y*landFilteredNoise(p.xz*frequency,landMaterialFootprint(dx.xz,dy.xz)*frequency);}
  if(w.z>.01){value+=w.z*landFilteredNoise(p.xy*frequency,landMaterialFootprint(dx.xy,dy.xy)*frequency);}
  return value;
}
fn landOrientedJoint(p:vec3f,n:vec3f,dx:vec3f,dy:vec3f)->f32 {
  let w0=pow(abs(n),vec3f(4));let w=w0/max(dot(w0,vec3f(1)),.0001);
  var value=0.0;
  if(w.x>.01){value+=w.x*landFilteredFissure(p.zy*1.35,landMaterialFootprint(dx.zy,dy.zy)*1.35,.025,.11);}
  if(w.y>.01){value+=w.y*landFilteredFissure(p.xz*1.35,landMaterialFootprint(dx.xz,dy.xz)*1.35,.025,.11);}
  if(w.z>.01){value+=w.z*landFilteredFissure(p.xy*1.35,landMaterialFootprint(dx.xy,dy.xy)*1.35,.025,.11);}
  return value;
}
fn landNearStrata(p:vec3f,dx:vec3f,dy:vec3f)->f32 {
  // A bounded authored material relief, not a claim of surveyed rock bedding.
  // Analytic phase derivatives remove the entire zero-mean signal unresolved.
  let axis=vec3f(.11,5.2,.08);
  let width=length(vec2f(dot(dx,axis),dot(dy,axis)))/6.28318530718;
  return sin(dot(p,axis))*landDetailWeight(width);
}
`;

export const TERRAIN_NEAR_HEIGHT = /* wgsl */ `
struct NearLand {domain:vec4f,grid:vec4f};
fn landNearContains(p:vec2f)->bool {
  let uv=(p-nearTerrain.domain.xy)/nearTerrain.domain.z+0.5;
  return nearTerrain.domain.w>0.5&&all(uv>=vec2f(0))&&all(uv<=vec2f(1));
}
fn landNearHeight(p:vec2f)->f32 {
  let uv=clamp((p-nearTerrain.domain.xy)/nearTerrain.domain.z+0.5,vec2f(0),vec2f(1));
  let side=u32(nearTerrain.grid.x);let limit=vec2i(i32(side)-1);
  let q=uv*vec2f(limit);let i=min(vec2i(floor(q)),max(limit-1,vec2i(0)));let f=q-vec2f(i);
  let next=min(i+1,limit);let a=nearElevation[u32(i.y)*side+u32(i.x)];
  let b=nearElevation[u32(i.y)*side+u32(next.x)];let c=nearElevation[u32(next.y)*side+u32(i.x)];let d=nearElevation[u32(next.y)*side+u32(next.x)];
  return select(d+(1.0-f.x)*(c-d)+(1.0-f.y)*(b-d),a+f.x*(b-a)+f.y*(c-a),f.x+f.y<=1.0);
}
`;
const LAND_SAMPLING = TERRAIN_NEAR_HEIGHT + /* wgsl */ `
struct Land { domain:vec4f };
fn landHeight(p:vec2f)->f32 {
  if(landNearContains(p)){return landNearHeight(p);}
  let uv=(p-LAND.domain.xy)/LAND.domain.z+0.5;
  if(any(uv<vec2f(0))||any(uv>vec2f(1))){return -120.0;}
  let q=uv*vec2f(textureDimensions(elevation)-1u);let i=vec2i(floor(q));let f=fract(q);
  let limit=vec2i(textureDimensions(elevation))-1;
  return mix(mix(textureLoad(elevation,i,0).r,textureLoad(elevation,min(i+vec2i(1,0),limit),0).r,f.x),
    mix(textureLoad(elevation,min(i+vec2i(0,1),limit),0).r,textureLoad(elevation,min(i+vec2i(1,1),limit),0).r,f.x),f.y);
}
`;

// Visual shore response only. The heightfield's underwater skirt is authored;
// this does not pretend to be a surveyed shallow-water wave simulation.
export const COASTAL_WATER = /* wgsl */ `
@group(2) @binding(0) var<uniform> LAND:Land;
@group(2) @binding(1) var elevation:texture_2d<f32>;
@group(2) @binding(2) var<uniform> nearTerrain:NearLand;
@group(2) @binding(3) var<storage,read> nearElevation:array<f32>;
` + LAND_SAMPLING + /* wgsl */ `
fn coastalWater(color:vec3f,p:vec2f,height:f32,foamLight:vec3f)->vec3f{
  let bed=landHeight(p);let shallows=smoothstep(-6.0,0.5,bed);
  let sunlight=(sunIlluminance()*max(F.sunDir.y,0.0)+lunarIlluminance()*max(lunarDirection().y,0.0))/PI;
  var col=mix(color,vec3f(0.045,0.17,0.15)*(sunlight+skyAtmo(vec3f(0,1,0))),shallows*0.28);
  let depth=height-bed;
  let surge=smoothstep(-0.05,0.45,height);
  let broken=0.55+0.45*gnoise(p*0.17+vec2f(F.camPos.w*0.06));
  let foam=(1.0-smoothstep(0.35,3.0,abs(depth)))*surge*broken;
  return mix(col,foamLight,foam*0.7);
}
`;

export const TERRAIN_LIGHT = FRAME_WGSL + ATMO_CORE_WGSL + /* wgsl */ `
@group(0) @binding(0) var<uniform> F:Frame;
@group(0) @binding(1) var transLUT:texture_2d<f32>;
@group(0) @binding(2) var skyLUT:texture_2d<f32>;
@group(0) @binding(3) var sampC:sampler;
@group(0) @binding(4) var elevation:texture_2d<f32>;
@group(0) @binding(5) var lightOut:texture_storage_2d<rgba16float,write>;
@group(0) @binding(6) var<uniform> LAND:Land;
@group(0) @binding(7) var<uniform> nearTerrain:NearLand;
@group(0) @binding(8) var<storage,read> nearElevation:array<f32>;
` + LAND_SAMPLING + SKY_RENDER_FUNCS + CLOUD_SAMPLE + /* wgsl */ `
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) id:vec3u){
  let size=textureDimensions(lightOut);if(any(id.xy>=size)){return;}
  let p=(vec2f(id.xy)+0.5)/vec2f(size)*LAND.domain.z-LAND.domain.z*0.5+LAND.domain.xy;
  let h=landHeight(p);var visibility=0.0;
  if(F.sunDir.y>0.0){
    visibility=volumeSunVisibility(vec3f(p.x,h+8.0,p.y)*0.001,F.sunDir.xyz);
    let horizontal=max(length(F.sunDir.xz),0.01);let direction=F.sunDir.xz/horizontal;
    for(var i=0u;i<16u;i++){
      let reach=28.0*pow(1.31,f32(i));
      let rayHeight=h+8.0+reach*F.sunDir.y/horizontal;
      visibility*=smoothstep(-5.0,12.0,rayHeight-landHeight(p+direction*reach));
    }
  }
  var moonVisibility=0.0;let ml=lunarDirection();
  if(lunarIrradiance()>0.0){
    moonVisibility=volumeSunVisibility(vec3f(p.x,h+8.0,p.y)*.001,ml);
    let horizontal=max(length(ml.xz),.01);let direction=ml.xz/horizontal;
    for(var i=0u;i<16u;i++){
      let reach=28.0*pow(1.31,f32(i));let rayHeight=h+8.0+reach*ml.y/horizontal;
      moonVisibility*=smoothstep(-5.0,12.0,rayHeight-landHeight(p+direction*reach));
    }
  }
  textureStore(lightOut,vec2i(id.xy),vec4f(visibility,moonVisibility,0,1));
}
`;

export const TERRAIN = FRAME_WGSL + ATMO_CORE_WGSL + /* wgsl */ `
@group(0) @binding(0) var<uniform> F:Frame;
@group(0) @binding(1) var transLUT:texture_2d<f32>;
@group(0) @binding(2) var skyLUT:texture_2d<f32>;
@group(0) @binding(3) var sampC:sampler;
@group(0) @binding(4) var envCube:texture_cube<f32>;
@group(0) @binding(5) var landLight:texture_2d<f32>;
@group(0) @binding(6) var<uniform> LAND:Land;
struct Land {domain:vec4f};
@group(0) @binding(7) var landAlbedo:texture_2d<f32>;
@group(0) @binding(8) var landSampler:sampler;
@group(0) @binding(9) var vegetationMask:texture_2d<f32>;
@group(0) @binding(10) var leafSpray:texture_2d<f32>;
@group(0) @binding(11) var<uniform> leafMean:vec4f;
struct NearLand {domain:vec4f,grid:vec4f};
@group(0) @binding(12) var<uniform> nearTerrain:NearLand;
@group(0) @binding(13) var nearAlbedo:texture_2d<f32>;
` + SKY_RENDER_FUNCS + CLOUD_SAMPLE + TERRAIN_FILTERING + TERRAIN_NEAR_MATERIAL + /* wgsl */ `
struct LandVertex {
  @builtin(position) pos:vec4f,
  @location(0) world:vec3f,
  @location(1) normal:vec3f,
  @location(2) kind:vec2f,
  @location(3) leafUV:vec2f,
};
@vertex fn vs(@location(0) position:vec3f,@location(1) normal:vec3f,@location(2) kind:vec2f)->LandVertex{
  var o:LandVertex;o.world=position;o.normal=normal;o.kind=kind;o.leafUV=vec2f(0);
  o.pos=F.viewProj*vec4f(position-F.camPos.xyz,1.0);return o;
}
@vertex fn treeVS(@location(0) position:vec3f,@location(1) normal:vec3f,@location(2) kind:vec2f,
  @location(3) root:vec4f,@location(4) shape:vec4f,@location(5) leafUV:vec2f)->LandVertex{
  let phase=shape.y*2.0*PI;
  let angle=phase;let c=cos(angle);let s=sin(angle);
  let local=vec3f((position.x*c-position.z*s)*root.w,position.y*shape.x,(position.x*s+position.z*c)*root.w);
  // Bend the entire connected structure by height. The same wind field and
  // seed at every tier preserve branch attachments and tree identity at LODs.
  let wind=F.windP[0].xy;let crosswind=vec2f(-wind.y,wind.x);
  let windForce=clamp(F.windP[0].z/12.0,0.0,2.2)*0.018;
  let gust=0.7+0.3*sin(F.camPos.w*0.65+phase);
  let windDirection=wind*gust+crosswind*sin(F.camPos.w*0.49+phase)*0.22;
  let swayXZ=windDirection*windForce*shape.x*position.y*position.y;
  let sway=vec3f(swayXZ.x,0,swayXZ.y);
  var o:LandVertex;o.world=root.xyz+local+sway;
  let scaled=normal/max(vec3f(root.w,shape.x,root.w),vec3f(0.001));
  var rotated=vec3f(scaled.x*c-scaled.z*s,scaled.y,scaled.x*s+scaled.z*c);
  rotated.y-=dot(rotated.xz,windDirection)*windForce*2.0*position.y;
  o.normal=normalize(rotated);o.leafUV=leafUV;
  o.kind=kind;o.pos=F.viewProj*vec4f(o.world-F.camPos.xyz,1.0);return o;
}
@vertex fn groundVS(@location(0) position:vec3f,@location(1) normal:vec3f,@location(2) kind:vec2f,
  @location(3) root:vec4f,@location(4) shape:vec4f,@location(5) leafUV:vec2f)->LandVertex{
  let angle=shape.y*2.0*PI;let c=cos(angle);let s=sin(angle);
  let up=normalize(vec3f(-shape.z,1,-shape.w));let right=normalize(vec3f(1,shape.z,0));let front=cross(right,up);
  let p=vec3f((position.x*c-position.z*s)*root.w,position.y*shape.x,(position.x*s+position.z*c)*root.w);
  let grass=kind.x>6.5;
  var sway=vec3f(0);
  if(grass){let bend=F.windP[0].xy*clamp(F.windP[0].z/12.0,0.0,2.2)*.035*shape.x*position.y*position.y*sin(F.camPos.w*1.8+angle);sway=vec3f(bend.x,0,bend.y);}
  let scaled=normal/max(vec3f(root.w,shape.x,root.w),vec3f(.001));
  let n=vec3f(scaled.x*c-scaled.z*s,scaled.y,scaled.x*s+scaled.z*c);
  var o:LandVertex;o.world=root.xyz+right*p.x+up*p.y+front*p.z+sway;o.normal=normalize(right*n.x+up*n.y+front*n.z);
  o.kind=kind;o.leafUV=leafUV;o.pos=F.viewProj*vec4f(o.world-F.camPos.xyz,1);return o;
}
// The opaque call graph contains neither discard nor a leaf texture fetch.
// Keep that property for Apple's hidden-surface removal; a runtime branch in
// one shared cutout fragment would still make solid ground a feedback shader.
fn landFinish(world:vec3f,n:vec3f,albedo:vec3f,diffuse:f32,ambientVisibility:f32,wet:f32,roughness:f32)->vec4f{
  let uv=(world.xz-LAND.domain.xy)/LAND.domain.z+0.5;
  let sunlight=textureSampleLevel(landLight,sampC,uv,0.0).r;
  let direct=sunIlluminance()*sunlight;
  let ambient=textureSampleLevel(envCube,sampC,vec3f(0,1,0),7.0).rgb;
  var col=albedo*(1.0-wet*0.36)*(direct*diffuse/PI+ambient*ambientVisibility);
  let v=normalize(F.camPos.xyz-world);let h=normalize(v+F.sunDir.xyz);
  let specular=(0.004*(1.0-roughness)+wet*0.06)*pow(max(dot(n,h),0.0),mix(12.0,64.0,1.0-roughness));
  col+=direct*specular;
  col+=lunarSurface(n,v,albedo*(1.0-wet*.36),mix(roughness,.25,wet),vec3f(.035),vec3f(textureSampleLevel(landLight,sampC,uv,0).g));
  col+=lightningSurface(n,v,albedo,roughness);
  col=surfaceAir(col,world);
  // Clip cloud integration at the land surface: clouds behind mountains stay
  // hidden; low clouds in front veil the slopes using the existing volume.
  let ray=marchCloudsTo(F.camPos.xyz*0.001,normalize(world-F.camPos.xyz),12u,0.5,
    sunIlluminance(),skyAtmo(vec3f(0,1,0)),distance(world,F.camPos.xyz)*0.001);
  return vec4f(col*(1.0-ray.color.a)+ray.color.rgb,1.0);
}
fn landOpaque(in:LandVertex)->vec4f{
  let world=in.world;var n=normalize(in.normal);
  let uv=(world.xz-LAND.domain.xy)/LAND.domain.z+0.5;
  let dx=dpdx(world);let dy=dpdy(world);let nx=dpdx(n);let ny=dpdy(n);
  // Registered aerial RGB remains the regional colour seed. The neutral detail
  // below adds material scale, never a replacement green/brown island palette.
  var source=pow(textureSampleGrad(landAlbedo,landSampler,uv,dx.xz/LAND.domain.z,dy.xz/LAND.domain.z).rgb,vec3f(2.2));
  let nearGround=in.kind.x>.5&&in.kind.x<1.5&&nearTerrain.domain.w>.5;
  if(nearGround){
    source=landNearColour(source,world,n,dx,dy,nx,ny,1.0-in.kind.y);
  }
  let vegetation=textureSampleLevel(vegetationMask,landSampler,uv,0.0).r;
  let footprint=max(length(dx),length(dy));
  let detailFade=1.0-smoothstep(0.25,2.5,footprint);
  var grain=0.0;
  if(in.kind.x<2.5){grain=landFilteredNoise(world.xz*0.019,landMaterialFootprint(dx.xz,dy.xz)*0.019);}
  let rocky=smoothstep(0.22,0.56,1.0-n.y+grain*0.07);
  let vertical=mix(world.zy,world.xy,smoothstep(0.35,0.65,abs(n.z)/(abs(n.x)+abs(n.z)+0.001)));
  let materialUV=mix(world.xz,vertical,rocky);
  // Different cliff projections and their blend can stretch coordinates much
  // faster than world position. Filter that actual mapping, before branching.
  let materialWidth=landMaterialFootprint(dpdx(materialUV),dpdy(materialUV));
  let bldgUV=clamp(vec2f(in.kind.x-20.0,in.kind.y),vec2f(0.001),vec2f(0.999));
  let bldgDx=dpdx(bldgUV);let bldgDy=dpdy(bldgUV);
  var albedo=source;var relief=0.0;var roughness=0.95;
  var ambientVisibility=0.42+0.35*max(n.y,0.0);
  let crown=in.kind.x>3.5;
  if(in.kind.x<2.5){
    if(nearGround){
      let rockMass=landOrientedDetail(world,n,dx,dy,.24);
      let fracture=landOrientedDetail(world+vec3f(19.1,7.3,4.7),n,dx,dy,1.35);
      let gravel=landOrientedDetail(world,n,dx,dy,7.5);
      var joint=0.0;var strata=0.0;
      if(rocky>.01){joint=landOrientedJoint(world+vec3f(19.1,7.3,4.7),n,dx,dy);strata=landNearStrata(world,dx,dy);}
      albedo=source*(1.0+rockMass*.22+fracture*.13+gravel*.08+rocky*(strata*.045-joint*.14));
      relief=mix(gravel*.018+fracture*.025,rockMass*.28+fracture*.11+gravel*.014+strata*.016-joint*.08,rocky);
      roughness=clamp(.91+gravel*.08-rocky*.08,.72,.98);
    }else{
    // Ground and cliff projections keep metre-scale stone legible on slopes.
    // Two-dimensional analytic noise only; no 3D noise octave loop. Crowns and
    // bark never execute these ground-material evaluations.
    let isProceduralCoast=in.kind.x<0.5&&in.kind.y>0.015;
    let beachSand=select(0.0,clamp((in.kind.y-0.02)/0.98,0.0,1.0),isProceduralCoast);
    let rockKeep=1.0-beachSand*0.94;
    let blockWidth=materialWidth*.19;let blockWeight=landDetailWeight(blockWidth);
    var blockNoise=0.0;if(blockWeight>0.0){blockNoise=gnoise(materialUV*.19);}
    let blocks=blockNoise*blockWeight*rockKeep;
    let stoneRaw=landFilteredNoise(materialUV*.82,materialWidth*.82);
    let stone=stoneRaw*rockKeep;
    let pores=landFilteredNoise(materialUV*5.4,materialWidth*5.4);
    let fissure=landFilteredFissure(materialUV*1.7+vec2f(13.1,7.7),materialWidth*1.7,.025,.11)*rockKeep;
    // Reuse the raw block noise, not its faded value, without another noise call.
    let coarseFissure=(1.0-smoothstep(.025,.09,abs(blockNoise)))*landDetailWeight(blockWidth/.065)*rockKeep;
    var baseSource=source;
    var swashGloss=0.0;
    var cliffStrata=0.0;
    if(isProceduralCoast){
      let gentle=smoothstep(0.32,0.08,1.0-n.y);
      let dryZone=smoothstep(-0.35,0.65,world.y)*(1.0-smoothstep(2.6,6.2+stoneRaw*1.2,world.y))*gentle*beachSand;
      let swashZone=smoothstep(-0.85,-0.05,world.y)*(1.0-smoothstep(0.42,1.25+stoneRaw*0.22,world.y))*gentle*beachSand;
      let wrack=exp(-pow((world.y-(1.08+stoneRaw*0.20))/0.13,2.0))*gentle*beachSand;
      let shoalZone=(1.0-smoothstep(-5.5,0.12,world.y))*gentle*beachSand;
      let dryCoralSand=vec3f(0.56,0.46,0.31)*(1.0+stoneRaw*0.06+pores*0.03);
      let wetSwashSand=vec3f(0.24,0.19,0.13)*(1.0+pores*0.025);
      let wrackTint=vec3f(0.14,0.12,0.075);
      let shoalSand=vec3f(0.20,0.34,0.32)*(1.0+stoneRaw*0.05);
      baseSource=mix(baseSource,dryCoralSand,dryZone*0.85);
      baseSource=mix(baseSource,wetSwashSand,swashZone*0.88);
      baseSource=mix(baseSource,wrackTint,wrack*0.45);
      baseSource=mix(baseSource,shoalSand,shoalZone*0.75);
      swashGloss=swashZone;
      cliffStrata=sin(world.y*2.35+blockNoise*2.2)*landDetailWeight(footprint*0.45)*rocky*rockKeep;
    }
    let sandRipple=sin(world.x*1.8+world.z*1.3+stoneRaw*2.5)*landDetailWeight(materialWidth*0.45)*beachSand*0.025;
    albedo=baseSource*(1.0+blocks*.14+stone*0.10+cliffStrata*0.065+pores*(0.055-beachSand*0.025)+sandRipple-(fissure*.075+coarseFissure*.08)*rocky);
    let soil=stone*(0.025+vegetation*0.012)+pores*(0.006+vegetation*0.006)+sandRipple*0.35;
    relief=mix(soil,stone*0.14+blocks*.22+cliffStrata*0.035-fissure*0.065-coarseFissure*.10,rocky*rockKeep);
    roughness=clamp(mix(mix(0.89+vegetation*0.035+pores*0.055-rocky*0.08,0.78+pores*0.03,beachSand),0.15,swashGloss),0.14,0.98);
    }
  }else if(in.kind.x>=19.5){
    // Camera-projected photorealistic 1550 building texture atlas (u = in.kind.x - 20.0, v = in.kind.y)
    let photo=pow(textureSampleGrad(nearAlbedo,landSampler,bldgUV,bldgDx,bldgDy).rgb,vec3f(2.2));
    let detailA=landOrientedDetail(world,n,dx,dy,1.6);
    let luma=dot(photo,vec3f(0.299,0.587,0.114));
    albedo=photo*(0.96+detailA*0.06);
    relief=(luma-0.35)*0.028*detailFade+detailA*0.012*detailFade;
    roughness=clamp(0.90-luma*0.12,0.74,0.94);
    ambientVisibility=0.46+0.36*max(n.y,0.0);
  }else if(in.kind.x>=9.5){
    let portShade=clamp(in.kind.y,0.22,1.0);
    let detailA=landOrientedDetail(world,n,dx,dy,1.45);
    let detailB=landOrientedDetail(world+vec3f(7.3,3.1,11.9),n,dx,dy,5.2);
    if(in.kind.x<10.5){
      // Kind 10: Weathered Spanish cedar & pitch-pine timber (piers, balconies, shutters, rafters)
      let plank=sin(world.y*14.0+(world.x+world.z)*3.5+detailA*1.6)*detailFade;
      let grain=sin((world.x-world.z)*18.0+world.y*6.0)*detailFade;
      albedo=vec3f(0.22,0.135,0.075)*portShade*(1.0+detailA*0.16+detailB*0.08+plank*0.07+grain*0.04);
      relief=(detailA*0.024+plank*0.014+grain*0.008)*detailFade;roughness=0.84;ambientVisibility=0.42+0.34*max(n.y,0.0);
    }else if(in.kind.x<11.5){
      // Kind 11: Coursed coral-limestone ashlar masonry (bastion walls, quoins, arches, buttresses)
      let courseIdx=floor(world.y*1.65);
      let courseY=fract(world.y*1.65);let bedJoint=smoothstep(0.0,0.09,courseY)*(1.0-smoothstep(0.91,1.0,courseY));
      let stagger=courseIdx*0.5;
      let blockCoord=(world.x+world.z)*0.72+stagger;
      let blockIdx=floor(blockCoord);
      let headCoord=fract(blockCoord);
      let headJoint=smoothstep(0.0,0.07,headCoord)*(1.0-smoothstep(0.93,1.0,headCoord));
      let mortar=mix(1.0,bedJoint*headJoint,detailFade);
      let blockVar=sin(courseIdx*7.13+blockIdx*13.71)*0.055*detailFade;
      let damp=smoothstep(0.2,3.8,world.y);
      let stoneBase=mix(vec3f(0.36,0.33,0.27),vec3f(0.48,0.44,0.37),damp)+vec3f(blockVar);
      albedo=stoneBase*portShade*(0.84+0.16*mortar+detailA*0.14+detailB*0.07);
      relief=(detailA*0.048+detailB*0.020-(1.0-mortar)*0.038)*detailFade;roughness=0.89;ambientVisibility=0.45+0.33*max(n.y,0.0);
    }else if(in.kind.x<12.5){
      // Kind 12: Warm Spanish colonial limewashed stucco (cream/ochre plaster with rising-damp patina)
      let damp=smoothstep(0.6,3.4,world.y);
      let trowel=sin(world.x*2.4+world.z*2.1+detailA*2.2)*0.025*detailFade;
      let warmStucco=mix(vec3f(0.52,0.46,0.36),vec3f(0.76,0.69,0.56),damp)+vec3f(trowel);
      albedo=warmStucco*portShade*(1.0+detailA*0.08+detailB*0.05);
      relief=(detailA*0.018+detailB*0.010+trowel*0.4)*detailFade;roughness=0.86;ambientVisibility=0.50+0.36*max(n.y,0.0);
    }else if(in.kind.x<13.5){
      // Kind 13: Spanish terracotta barrel roof tiles (tejas curvas with course steps & kiln variation)
      let flute=sin((world.x*3.8+world.z*3.8)*4.2)*detailFade;
      let courseStep=smoothstep(0.0,0.14,fract(world.y*2.4));
      let kilnVar=sin(floor(world.x*3.2)*5.3+floor(world.z*3.2)*9.7)*0.045*detailFade;
      let tileCol=vec3f(0.50+kilnVar,0.175+kilnVar*0.45,0.085+kilnVar*0.25)*(0.90+0.12*courseStep);
      albedo=tileCol*portShade*(1.0+detailA*0.13+flute*0.10+detailB*0.06);
      relief=(flute*0.032+(courseStep-0.5)*0.018+detailA*0.014)*detailFade;roughness=0.80;ambientVisibility=0.48+0.36*max(n.y,0.0);
    }else if(in.kind.x<14.5){
      // Kind 14: Deep recessed colonial openings, arched portals & wrought-iron reja bars
      let reja=smoothstep(0.42,0.48,abs(fract((world.x+world.z)*3.6)-0.5))*smoothstep(0.40,0.47,abs(fract(world.y*2.2)-0.5));
      albedo=mix(vec3f(0.085,0.072,0.058),vec3f(0.042,0.032,0.024),reja)*portShade*(1.0+detailB*0.08);
      relief=(detailB*0.008-(1.0-reja)*0.012)*detailFade;roughness=0.90;ambientVisibility=0.20+0.16*max(n.y,0.0);
    }else if(in.kind.x<15.5){
      // Kind 15: Layered palm-thatch & bundled reed roof (guano / palma real for bohíos, caneyes & palafitos)
      let straw=sin((world.x*5.2+world.z*5.2)*4.6+detailA*2.0)*detailFade;
      let tierStep=smoothstep(0.0,0.22,fract(world.y*1.9));
      let bundleVar=sin(floor(world.x*2.6)*7.1+floor(world.z*2.6)*11.3)*0.04*detailFade;
      let thatchCol=vec3f(0.36+bundleVar,0.27+bundleVar*0.7,0.145+bundleVar*0.4)*(0.86+0.16*tierStep);
      albedo=thatchCol*portShade*(1.0+detailA*0.14+straw*0.11+detailB*0.07);
      relief=(straw*0.036+(tierStep-0.5)*0.024+detailA*0.018)*detailFade;roughness=0.93;ambientVisibility=0.44+0.36*max(n.y,0.0);
    }else{
      // Kind 16: River-cobble courtyard pavement & packed-earth bastion terreplein (empedrado / terraplén)
      let cobbleX=fract(world.x*2.4+sin(world.z*3.1)*0.25)-0.5;
      let cobbleZ=fract(world.z*2.4+cos(world.x*3.1)*0.25)-0.5;
      let cobble=smoothstep(0.42,0.18,sqrt(cobbleX*cobbleX+cobbleZ*cobbleZ));
      let baseEarth=mix(vec3f(0.28,0.25,0.20),vec3f(0.40,0.36,0.30),cobble*detailFade);
      albedo=baseEarth*portShade*(1.0+detailA*0.15+detailB*0.09);
      relief=(detailA*0.032+(cobble-0.5)*0.022)*detailFade;roughness=0.91;ambientVisibility=0.48+0.36*max(n.y,0.0);
    }
  }else if(crown){
    let exposure=clamp(in.kind.y,0.0,1.0);
    let canopyGrain=gnoise(world.xz*0.32+vec2f(world.y*0.17));
    let regionalTint=clamp(source/vec3f(0.10,0.14,0.06),vec3f(0.7),vec3f(1.3));
    albedo=leafMean.rgb*mix(vec3f(1),regionalTint,0.2)*(0.78+exposure*0.30+canopyGrain*0.04);
    ambientVisibility=0.14+exposure*0.47+max(n.y,0.0)*0.08;
    relief=0.0;roughness=0.95;
  }else{
    let barkNoise=gnoise(in.leafUV*vec2f(38.0,9.0));
    let ridges=pow(0.5+0.5*sin(in.leafUV.x*PI*56.0+barkNoise*3.0),5.0);
    albedo=vec3f(0.095,0.068,0.038)*(0.82+barkNoise*0.18+in.kind.y*0.16);
    relief=(ridges-0.5)*0.010*(1.2-in.kind.y)*detailFade;roughness=0.92;
  }
  let reliefX=dpdx(relief);let reliefY=dpdy(relief);
  if(in.kind.x<2.5){n=landFilteredBump(n,dx,dy,reliefX,reliefY);}
  else{
    let sx=cross(dy,n);let sy=cross(n,dx);let det=dot(dx,sx);
    let gradient=(reliefX*sx+reliefY*sy)/max(abs(det),0.00001)*sign(det);
    n=normalize(n-clamp(gradient,vec3f(-0.42),vec3f(0.42)));
  }
  let wet=(1.0-smoothstep(0.5,3.5,world.y))*(0.75+0.25*sin(F.camPos.w*0.7+world.x*0.02));
  roughness=mix(roughness,0.27,wet);
  return landFinish(world,n,albedo,max(dot(n,F.sunDir.xyz),0.0),ambientVisibility,wet,roughness);
}
@fragment fn fs(in:LandVertex,@builtin(front_facing) front:bool)->@location(0) vec4f{return landOpaque(in);}
@fragment fn opaqueFS(in:LandVertex,@builtin(front_facing) front:bool)->@location(0) vec4f{return landOpaque(in);}
// The props use local atmosphere and the terrain's cached cloud sunlight. A
// twelve-step volume integration per grass blade would defeat their budget.
@fragment fn groundFS(in:LandVertex,@builtin(front_facing) front:bool)->@location(0) vec4f{
  let world=in.world;let grass=in.kind.x>6.5;
  var n=normalize(in.normal);if(grass){n*=select(-1.0,1.0,front);}
  let uv=(world.xz-LAND.domain.xy)/LAND.domain.z+.5;
  let source=pow(textureSample(landAlbedo,landSampler,uv).rgb,vec3f(2.2));
  let vegetation=textureSampleLevel(vegetationMask,landSampler,uv,0).r;
  let luminance=dot(source,vec3f(.2126,.7152,.0722));
  let shade=.72+in.kind.y*.30;
  let rock=mix(vec3f(luminance)*vec3f(.95,.91,.85),source,.12)*shade;
  let dry=vec3f(.17,.145,.065);let green=mix(leafMean.rgb,source,.18);
  let foliage=mix(dry,green,smoothstep(.12,.7,vegetation))*shade;
  let albedo=select(rock,foliage,grass);
  let sunlight=textureSampleLevel(landLight,sampC,uv,0).r;
  let direct=sunIlluminance()*sunlight;
  let ambient=textureSampleLevel(envCube,sampC,vec3f(0,1,0),7).rgb;
  let diffuse=max(dot(n,F.sunDir.xyz),0.0)+select(0.0,max(dot(-n,F.sunDir.xyz),0.0)*.35,grass);
  let visibility=select(.35+.28*max(n.y,0.0),.32+in.kind.y*.32,grass);
  let wet=(1.0-smoothstep(1.0,7.0,world.y))*.5;
  var color=albedo*(1.0-wet*.3)*(direct*diffuse/PI+ambient*visibility);
  color+=lunarSurface(n,normalize(F.camPos.xyz-world),albedo,.84,vec3f(.035),vec3f(textureSampleLevel(landLight,sampC,uv,0).g));
  color+=lightningSurface(n,normalize(F.camPos.xyz-world),albedo,.84);
  return vec4f(surfaceAir(color,world),1);
}
@fragment fn leafFS(in:LandVertex,@builtin(front_facing) front:bool)->@location(0) vec4f{
  let world=in.world;var n=normalize(in.normal)*select(-1.0,1.0,front);
  let uv=(world.xz-LAND.domain.xy)/LAND.domain.z+0.5;
  // Derivative-dependent samples precede discard; this shader alone is cutout.
  let leaf=textureSampleBias(leafSpray,landSampler,in.leafUV,0.1);
  let source=pow(textureSample(landAlbedo,landSampler,uv).rgb,vec3f(2.2));
  let regionalTint=clamp(source/vec3f(0.10,0.14,0.06),vec3f(0.7),vec3f(1.3));
  let albedo=pow(leaf.rgb,vec3f(2.2))*mix(vec3f(1),regionalTint,0.2)*(0.78+in.kind.y*0.30);
  let exposure=clamp(in.kind.y,0.0,1.0);let nDotL=dot(n,F.sunDir.xyz);
  let diffuse=(max(nDotL,0.0)+max(-nDotL,0.0)*0.48)*(0.22+0.78*exposure*exposure);
  let ambientVisibility=0.12+exposure*0.55+abs(n.y)*0.08;
  if(leaf.a<0.015){discard;}
  let color=landFinish(world,n,albedo,diffuse,ambientVisibility,0.0,0.95);
  return vec4f(color.rgb,leaf.a);
}
// Imported canopy streams already contain absolute Y-up world positions and
// source linear material factors. Do not run treeVS's root/scale/yaw/sway again.
struct CanopyVertex {
  @builtin(position) pos:vec4f,
  @location(0) world:vec3f,
  @location(1) normal:vec3f,
  @location(2) kind:vec2f,
  @location(3) leafUV:vec2f,
  @location(4) colour:vec3f,
};
@vertex fn bakedCanopyVS(@location(0) position:vec3f,@location(1) normal:vec3f,@location(2) kind:vec2f,
  @location(5) leafUV:vec2f,@location(6) colour:vec3f)->CanopyVertex{
  var o:CanopyVertex;o.world=position;o.normal=normal;o.kind=kind;o.leafUV=leafUV;o.colour=colour;
  o.pos=F.viewProj*vec4f(position-F.camPos.xyz,1);return o;
}
// Opaque imported wood/crowns stay in the opaque visibility path. Their call
// graph has no discard or foliage texture; source RGB replaces shared green.
@fragment fn canopyOpaqueFS(in:CanopyVertex)->@location(0) vec4f{
  let n=normalize(in.normal);let exposure=clamp(in.kind.y,0,1);
  let crown=in.kind.x>3.5;
  let ambient=select(.36+max(n.y,0)*.25,.14+exposure*.47+max(n.y,0)*.08,crown);
  return landFinish(in.world,n,in.colour,max(dot(n,F.sunDir.xyz),0),ambient,0,.95);
}
@fragment fn canopyLeafFS(in:CanopyVertex,@builtin(front_facing) front:bool)->@location(0) vec4f{
  let n=normalize(in.normal)*select(-1.0,1.0,front);
  // This borrowed alpha is an explicit approximation: the supplied GLB/native
  // streams contain no leaf image. Never replace their linear RGB with it.
  let alpha=textureSampleBias(leafSpray,landSampler,in.leafUV,.1).a;
  let exposure=clamp(in.kind.y,0,1);let nDotL=dot(n,F.sunDir.xyz);
  let diffuse=(max(nDotL,0)+max(-nDotL,0)*.48)*(.22+.78*exposure*exposure);
  let ambient=.12+exposure*.55+abs(n.y)*.08;
  if(alpha<.015){discard;}
  let color=landFinish(in.world,n,in.colour,diffuse,ambient,0,.95);
  return vec4f(color.rgb,alpha);
}
`;

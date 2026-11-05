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
fn landMaterialFootprint3(dx:vec3f,dy:vec3f)->f32{
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
// Loose stones of uneven size: each jittered cell has its own tone (x) and a dark gap to
// its nearest neighbour (y). One hash per cell supplies jitter, tone and size, and the
// four closest cells are enough to search for this bounded jitter.
fn landStones(p:vec2f)->vec2f{
  let base=vec2i(floor(p-.5));
  var nearest=9.0;var second=9.0;var tone=0.0;
  for(var j=0;j<2;j++){for(var i=0;i<2;i++){
    let cell=base+vec2i(i,j);
    let h=pcgHash(u32(cell.x)*1664525u+pcgHash(u32(cell.y)+1013904223u));
    let offset=vec2f(cell)+.5+(vec2f(f32(h&255u),f32((h>>8u)&255u))/255.0-.5)*.8-p;
    let r=sqrt(dot(offset,offset))*(.72+f32(h>>24u)/255.0*.56);
    if(r<nearest){second=nearest;nearest=r;tone=f32((h>>16u)&255u)/127.5-1.0;}else if(r<second){second=r;}
  }}
  return vec2f(tone,clamp((second-nearest)*2.6,0.0,1.0));
}
// Three stone sizes, turned against each other so no lattice shows. The two finer sizes
// track the pixel footprint: grit up close, talus far away. Anchored to the world so
// nothing swims; the crossfade hides each change of size.
fn landScreeOctaves(p:vec2f,cell:f32,blend:f32)->vec2f{
  let q=vec2f(p.x*.8-p.y*.6,p.x*.6+p.y*.8)/cell;
  let fine=mix(landStones(q),landStones(vec2f(p.x*.6+p.y*.8,p.y*.6-p.x*.8)/(cell*2.0)+vec2f(37.1,11.3)),blend);
  let large=landStones(vec2f(p.x*.28-p.y*.96,p.x*.96+p.y*.28)/(cell*5.0)+vec2f(5.3,71.9));
  return vec2f(fine.x*.62+large.x*.38,min(fine.y,large.y+.25));
}
// Tone, gap and stone size in metres. Sharp projection weights mean most pixels pay for
// one plane, and every plane is world-true, so a steep face cannot stretch the pattern.
fn landScree(p:vec3f,n:vec3f,width:f32)->vec3f{
  let scale=max(0.0,log2(max(width,.0001)*3.0/.06));
  let level=floor(scale);let blend=scale-level;
  let cell=.06*pow(2.0,level);
  let w0=pow(abs(n),vec3f(8.0));let w=w0/max(dot(w0,vec3f(1.0)),.0001);
  var sum=vec2f(0.0);
  if(w.x>.04){sum+=w.x*landScreeOctaves(p.zy,cell,blend);}
  if(w.y>.04){sum+=w.y*landScreeOctaves(p.xz,cell,blend);}
  if(w.z>.04){sum+=w.z*landScreeOctaves(p.xy,cell,blend);}
  return vec3f(sum,cell*(1.0+blend));
}
// Ground cover for any region, from the patterns of real volcanic and temperate hills:
// olive grass and dark shrub on the gentler ground, pink-tan soil where it thins, and
// red-brown rock on steep faces. The region's own imagery decides how much shows: green
// or tan ground keeps its colour under light mottling, while pale, hueless ground, which
// says nothing about what is there, takes the cover almost entirely. Returns the colour,
// with grass cover in the alpha for the stone layer.
fn landGroundCover(source:vec3f,slope:f32,cliff:f32,patchA:f32,patchB:f32,grain:f32,fine:f32,altitude:f32,exposed:f32,detailedImage:bool)->vec4f{
  let top=max(source.r,max(source.g,source.b));
  let saturation=(top-min(source.r,min(source.g,source.b)))/max(top,.02);
  let greenness=(source.g-max(source.r,source.b))/max(top,.02);
  let hueless=1.0-smoothstep(.1,.3,saturation);
  let saltLimit=smoothstep(1.5,6.0,altitude);
  let grass=smoothstep(-.12,.3,.56+greenness*2.0+patchA*.4+patchB*.62+grain*.5+fine*.22-slope*.95)*(1.0-cliff)*saltLimit;
  let shrub=smoothstep(.26,.5,patchA*.7+patchB*.35+fine*.3+greenness*.3-slope*.2)*grass*.8;
  let leaf=mix(vec3f(.045,.07,.019),vec3f(.1,.14,.035),smoothstep(-.4,.4,patchB+patchA*.4+grain*.4+fine*.25));
  let soil=mix(vec3f(.13,.078,.058),vec3f(.19,.13,.07),smoothstep(-.3,.3,patchB-patchA*.4+fine*.2));
  let rockHue=mix(vec3f(.045,.022,.019),vec3f(.085,.07,.057),smoothstep(-.3,.35,patchA+grain*.5+fine*.3));
  let outcrop=max(cliff,smoothstep(.26,.46,slope+patchA*.2+grain*.12+fine*.1));
  let cover=mix(mix(soil,rockHue,outcrop),mix(leaf,vec3f(.014,.028,.01),shrub),grass);
  // Keep the imagery's ridges and gullies as light and dark within the cover.
  let shape=clamp(pow(dot(source,vec3f(.3,.59,.11))/.14,.3),.72,1.18);
  return vec4f(mix(source,cover*shape,mix(select(.38,.2,detailedImage),.96,hueless)*exposed),grass);
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
fn landFilteredWave(p:vec3f,dx:vec3f,dy:vec3f,axis:vec3f,phase:f32)->f32{
  let cyclesPerPixel=length(vec2f(dot(dx,axis),dot(dy,axis)))/6.28318530718;
  let weight=landDetailWeight(cyclesPerPixel);
  if(weight<=0.0){return 0.0;}
  return sin(dot(p,axis)+phase)*weight;
}
fn landFilteredCourse(coord:f32,coordDx:f32,coordDy:f32,sharpness:f32)->f32{
  let stepPerPixel=length(vec2f(coordDx,coordDy))*max(sharpness,1.0);
  let w1=landDetailWeight(stepPerPixel);
  if(w1<=0.0){return 0.0;}
  let w2=landDetailWeight(stepPerPixel*2.0);
  let a=coord*6.28318530718;
  return 0.68*cos(a)*w1+0.32*cos(a*2.0)*w2;
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
  let nearMode=nearTerrain.domain.w;
  let uv=(p-LAND.domain.xy)/LAND.domain.z+0.5;
  let outDist=length(max(vec2f(0.0),abs(uv-vec2f(0.5))-vec2f(0.5)));
  var rOut=1.0;
  if(nearMode<-0.5 && outDist>0.001){
    let ruv=(p-nearTerrain.domain.xy)/nearTerrain.domain.z+0.5;
    rOut=length(max(vec2f(0.0),abs(ruv-vec2f(0.5))-vec2f(0.5)));
    if(rOut>=0.45){return -120.0;}
  }else if(outDist>1.25){return -120.0;}
  let useNear=landNearContains(p)||(nearMode<-0.5 && outDist>0.001);
  var hNear=0.0;
  if(useNear){
    hNear=landNearHeight(p);
    if(nearMode>0.5||outDist>=0.04){return select(hNear,mix(hNear,-120.0,smoothstep(0.0,0.4,rOut)),nearMode<-0.5);}
  }
  let q=clamp(uv,vec2f(0.0),vec2f(1.0))*vec2f(textureDimensions(elevation)-1u);
  let i=vec2i(floor(q));let f=fract(q);let limit=vec2i(textureDimensions(elevation))-1;
  let hSample=mix(mix(textureLoad(elevation,i,0).r,textureLoad(elevation,min(i+vec2i(1,0),limit),0).r,f.x),
    mix(textureLoad(elevation,min(i+vec2i(0,1),limit),0).r,textureLoad(elevation,min(i+vec2i(1,1),limit),0).r,f.x),f.y);
  if(useNear){return mix(hSample,hNear,smoothstep(0.0,0.04,outDist));}
  return mix(hSample,-120.0,smoothstep(0.0,1.15,outDist));
}
`;

// How the coast shapes the sea, baked per texel by coastal-field.js: shelter along the swell, the
// fetch to the nearest land to windward, and the smoothed seabed with its slope.
export const COASTAL_FIELD_SIZE = 1024;
export const COASTAL_FIELD_SPAN_M = 12288;
export const COASTAL_FIELD_TILE_TEXELS = 64;
const COASTAL_FETCH_LIMIT_M = 1800;
const COASTAL_FIELD_TEXEL_M = COASTAL_FIELD_SPAN_M / COASTAL_FIELD_SIZE;
export const COASTAL_FIELD_BAKE = FRAME_WGSL + /* wgsl */ `
@group(0) @binding(0) var<uniform> F:Frame;
@group(0) @binding(1) var<uniform> LAND:Land;
@group(0) @binding(2) var elevation:texture_2d<f32>;
@group(0) @binding(3) var<uniform> nearTerrain:NearLand;
@group(0) @binding(4) var<storage,read> nearElevation:array<f32>;
@group(0) @binding(5) var<storage,read> tiles:array<vec4f>;
@group(0) @binding(6) var shelterOut:texture_storage_2d<rgba16float,write>;
@group(0) @binding(7) var slopeOut:texture_storage_2d<rgba16float,write>;
` + LAND_SAMPLING + /* wgsl */ `
@compute @workgroup_size(8,8) fn main(@builtin(global_invocation_id) id:vec3u){
  let tile=tiles[id.z];
  let p=tile.xy+(vec2f(id.xy)+0.5)*${COASTAL_FIELD_TEXEL_M.toFixed(1)};
  let at=vec2i(tile.zw)+vec2i(id.xy);
  let bed=landHeight(p);
  if(bed<=-58.0){
    textureStore(shelterOut,at,vec4f(1.0,1.0,bed,bed));
    textureStore(slopeOut,at,vec4f(bed,0.0,0.0,0.0));
    return;
  }
  let windProp=normalize(F.windP[0].xy+vec2f(1e-5,0.0));
  let swellProp=select(windProp,vec2f(cos(F.windP[0].w),sin(F.windP[0].w)),abs(F.windP[0].w)>0.1);
  let upSwell=-swellProp;
  let sideSwell=vec2f(-upSwell.y,upSwell.x);
  let dir0=upSwell;
  let dirL=normalize(upSwell+sideSwell*0.32);
  let dirR=normalize(upSwell-sideSwell*0.32);
  let steps=array<f32,8>(36.0,85.0,165.0,280.0,450.0,700.0,1080.0,1620.0);
  var transC=1.0;
  var transL=1.0;
  var transR=1.0;
  var fetchDist=${COASTAL_FETCH_LIMIT_M}.0;
  for(var i=0u;i<8u;i++){
    let d=steps[i];
    let bC=smoothstep(-0.35,1.15,landHeight(p+dir0*d));
    let bL=smoothstep(-0.35,1.15,landHeight(p+dirL*d));
    let bR=smoothstep(-0.35,1.15,landHeight(p+dirR*d));
    if(bC>0.35 && fetchDist>d){fetchDist=d;}
    transC*=1.0-bC*0.92;
    transL*=1.0-bL*0.88;
    transR*=1.0-bR*0.88;
  }
  let hE=landHeight(p+vec2f(16.0,0.0));
  let hW=landHeight(p-vec2f(16.0,0.0));
  let hN=landHeight(p+vec2f(0.0,16.0));
  let hS=landHeight(p-vec2f(0.0,16.0));
  let bedNear=0.2*(bed+hE+hW+hN+hS);
  var bedSmooth=bedNear;
  var gx=(hE-hW)/32.0;
  var gz=(hN-hS)/32.0;
  if(bedNear>-36.0){
    let hE2=landHeight(p+vec2f(44.0,0.0));
    let hW2=landHeight(p-vec2f(44.0,0.0));
    let hN2=landHeight(p+vec2f(0.0,44.0));
    let hS2=landHeight(p-vec2f(0.0,44.0));
    bedSmooth=0.52*bedNear+0.12*(hE2+hW2+hN2+hS2);
    gx=0.50*gx+0.50*(hE2-hW2)/88.0;
    gz=0.50*gz+0.50*(hN2-hS2)/88.0;
  }
  textureStore(shelterOut,at,vec4f(clamp(0.50*transC+0.25*transL+0.25*transR,0.0,1.0),fetchDist/${COASTAL_FETCH_LIMIT_M}.0,bed,bedNear));
  textureStore(slopeOut,at,vec4f(bedSmooth,gx,gz,0.0));
}
`;

// Visual shore response, nearshore wave shoaling/breaking, and breakwater shelter.
export const COASTAL_WATER = /* wgsl */ `
@group(2) @binding(0) var coastalShelter:texture_2d<f32>;
@group(2) @binding(1) var coastalSlope:texture_2d<f32>;
@group(2) @binding(2) var coastalSampler:sampler;
@group(2) @binding(3) var<uniform> coastalWindow:vec4f;
struct CoastalWaveState {
  swellScale: f32,
  chopScale: f32,
  breakFoam: f32,
  dispOffset: vec3f,
  extraSlope: vec2f,
  shoreDir: vec2f,
  refractWeight: f32,
  bed: f32,
};
fn coastalWaveState(p:vec2f)->CoastalWaveState{
  // Beyond the baked window lies open water. The rim fades so tiles coming into range never show.
  let offset=abs(p-coastalWindow.xy);
  let inside=1.0-smoothstep(coastalWindow.z-1500.0,coastalWindow.z-800.0,max(offset.x,offset.y));
  let uv=p/${COASTAL_FIELD_SPAN_M}.0;
  let shelter=textureSampleLevel(coastalShelter,coastalSampler,uv,0.0);
  let bed=mix(-120.0,shelter.z,inside);
  if(bed<=-58.0){
    return CoastalWaveState(1.0,1.0,0.0,vec3f(0.0),vec2f(0.0),vec2f(1.0,0.0),0.0,bed);
  }
  let slope=textureSampleLevel(coastalSlope,coastalSampler,uv,0.0);
  let rawTransmit=mix(1.0,shelter.x,inside);
  let fetchDist=mix(1.0,shelter.y,inside)*${COASTAL_FETCH_LIMIT_M}.0;
  let bedNear=mix(-120.0,shelter.w,inside);
  let bedSmooth=mix(-120.0,slope.x,inside);
  let gx=slope.y*inside;
  let gz=slope.z*inside;
  let windProp=normalize(F.windP[0].xy+vec2f(1e-5,0.0));
  let swellProp=select(windProp,vec2f(cos(F.windP[0].w),sin(F.windP[0].w)),abs(F.windP[0].w)>0.1);
  let swellHs=select(1.2,F.cascL[1].z,F.cascL[1].w>1.0);
  let swellLen=clamp(select(95.0,F.cascL[1].w,F.cascL[1].w>1.0),30.0,300.0);
  let windSpeed=F.windP[0].z;
  let windHs=0.14*clamp(windSpeed,0.0,24.0);
  let hsTotal=clamp(sqrt(swellHs*swellHs+windHs*windHs),0.0,4.5);
  let gLen=length(vec2f(gx,gz));
  // shoreDir points up-slope (cross-shore toward the beach); tangDir points along-shore (parallel to depth contours).
  let shoreDir=select(swellProp,vec2f(gx,gz)/max(gLen,1e-4),gLen>0.0015);
  let onshoreAlign=clamp(dot(swellProp,shoreDir)*0.75+0.45,0.0,1.0);
  let beachFactor=1.0-smoothstep(0.18,0.38,gLen);
  let seawardExposure=clamp(rawTransmit*(0.25+0.75*onshoreAlign),0.0,1.0);
  let h=max(0.0,-bedSmooth);
  let breakDepth=clamp(1.3+1.35*hsTotal*seawardExposure,1.5,5.8);
  // Ocean-floor drag boosts 3D swell height during shoaling (Green's law) and collapses it only inside the surf zone after breaking.
  let shoalBoost=1.0+0.46*seawardExposure*smoothstep(18.0,breakDepth,h)*smoothstep(0.5,breakDepth*0.75,h);
  let surfDiss=mix(0.18,1.0,smoothstep(0.10,min(breakDepth*0.75,2.4),h));
  let swellScale=clamp(rawTransmit*shoalBoost*surfDiss,0.0,1.48);
  let fetchFactor=smoothstep(25.0,620.0,fetchDist);
  let chopScale=mix(0.42+0.36*fetchFactor,1.0,rawTransmit)*(1.0-0.65*smoothstep(-1.2,0.25,bedNear));
  let refractWeight=(1.0-smoothstep(1.0,26.0,h))*smoothstep(0.0015,0.016,gLen)*beachFactor;
  var breakFoam=0.0;
  var dispOffset=vec3f(0.0);
  var extraSlope=vec2f(0.0);
  let relP=p;
  if(bedSmooth>-20.0 && bedSmooth<0.85 && seawardExposure>0.05 && hsTotal>0.05 && beachFactor>0.02){
    // Snell's law refraction: along-shore wavenumber k_parallel is conserved while ocean-floor drag
    // delays phase in the shallows (+shoreDir), bending wave crests parallel to the beach.
    let k0=clamp(2.0*PI/swellLen,0.055,0.11);
    let omega=clamp(sqrt(9.81*k0)*1.65,1.35,2.05);
    let hNorm=clamp(h/16.0,0.0,1.0);
    let dragLag=4.6*beachFactor*(1.0-sqrt(hNorm+0.015));
    let peelMod=gnoise(p*0.005)*0.55;
    let psi=dot(relP,swellProp)*k0+dragLag-F.camPos.w*omega+peelMod;
    let kShoal=4.6*beachFactor*clamp(gLen,0.022,0.12)/(32.0*sqrt(hNorm+0.015));
    let kLocal=swellProp*k0+shoreDir*kShoal;
    let propDir=normalize(kLocal);
    // Shoaling & surf-zone 3D breaker envelope: rises sharply over the bar and rolls into the swash zone.
    let shoalIn=smoothstep(18.0,5.0,h);
    let boreSust=mix(0.24,1.0,smoothstep(0.06,breakDepth,h))*(1.0-smoothstep(-0.04,0.65,bedNear));
    let groupEnv=0.78+0.22*sin(psi*0.27-F.camPos.w*0.22+gnoise(p*0.0035)*1.4);
    let waveAmp=clamp(0.54*hsTotal,0.0,1.25)*seawardExposure*beachFactor*shoalIn*boreSust*groupEnv;
    // Bottom-drag asymmetry: trough slows on the seabed while the crest overtakes it and pitches forward (+propDir).
    let skewAlpha=mix(0.22,0.78,smoothstep(11.0,1.4,h));
    let cnoidalGamma=mix(0.10,0.38,smoothstep(11.0,1.4,h));
    let sinPsi=sin(psi);
    let cosPsi=cos(psi);
    let theta=psi-skewAlpha*cosPsi;
    let dThetaDpsi=1.0+skewAlpha*sinPsi;
    let sinT=sin(theta);
    let cosT=cos(theta);
    let sin2T=2.0*sinT*cosT;
    let cos2T=cosT*cosT-sinT*sinT;
    let waveProfile=cosT+cnoidalGamma*(cos2T-0.28);
    let dWaveDpsi=-(sinT+2.0*cnoidalGamma*sin2T)*dThetaDpsi;
    let boreHeight=waveAmp*waveProfile;
    let pitchFactor=smoothstep(10.0,1.2,h)*(1.0-smoothstep(-0.08,0.55,bedNear));
    let horizSurge=waveAmp*(0.75+0.65*pitchFactor)*(sin(theta+0.35)+0.30*cnoidalGamma*sin(2.0*theta+0.45));
    dispOffset+=vec3f(propDir.x*horizSurge,boreHeight,propDir.y*horizSurge);
    extraSlope+=kLocal*(waveAmp*dWaveDpsi*1.35);
    // Crashing breaker foam on the pitching shoreward face, its immediate turbulent roller, and the swash lip.
    let frontFace=smoothstep(0.22,0.90,cos(theta-0.46));
    let breakBand=smoothstep(breakDepth+2.2,breakDepth*0.65,h)*(1.0-smoothstep(-0.04,0.48,bedNear));
    let crestBreak=frontFace*breakBand;
    let rollerPhase=smoothstep(0.0,0.86,cos(theta+0.16));
    let innerSurf=smoothstep(breakDepth*1.1,0.45,h)*(1.0-smoothstep(0.02,0.55,bedNear));
    let rollerTex=0.60+0.40*gnoise(p*0.14-propDir*F.camPos.w*0.35);
    let rollerWake=rollerPhase*innerSurf*rollerTex;
    let swashZone=smoothstep(-0.85,-0.04,bedNear)*(1.0-smoothstep(0.05,0.52,bedNear));
    let swashPulse=smoothstep(0.12,0.88,cos(theta-0.24));
    let swashEdge=swashZone*(0.22+0.78*swashPulse);
    let energyMask=clamp(hsTotal/0.65,0.0,1.0);
    breakFoam=clamp(energyMask*seawardExposure*beachFactor*groupEnv*(crestBreak*0.95+rollerWake*0.52+swashEdge*0.56),0.0,1.0);
  }
  let leeWeight=(1.0-rawTransmit)*(1.0-smoothstep(-0.85,0.25,bed))*mix(0.45,1.0,fetchFactor)*clamp(hsTotal/0.8,0.0,1.0);
  if(leeWeight>0.02){
    let leeDir1=normalize(vec2f(swellProp.x*0.48-swellProp.y*0.877,swellProp.x*0.877+swellProp.y*0.48));
    let leeDir2=normalize(vec2f(swellProp.x*0.76+swellProp.y*0.65,-swellProp.x*0.65+swellProp.y*0.76));
    let k1=0.28;
    let k2=0.52;
    let ph1=dot(relP,leeDir1)*k1-F.camPos.w*1.65+gnoise(p*0.018)*1.8;
    let ph2=dot(relP,leeDir2)*k2-F.camPos.w*2.15+gnoise(p*0.031+vec2f(7.3,2.9))*1.6;
    let env=0.62+0.38*gnoise(p*0.012-leeDir1*F.camPos.w*0.08);
    let amp1=0.095*leeWeight*env;
    let amp2=0.058*leeWeight*env;
    dispOffset.y+=amp1*sin(ph1)+amp2*sin(ph2);
    extraSlope+=leeDir1*(amp1*k1*cos(ph1))+leeDir2*(amp2*k2*cos(ph2));
  }
  return CoastalWaveState(swellScale,chopScale,breakFoam,dispOffset,extraSlope,shoreDir,refractWeight,bed);
}
fn coastalRefractDisp(d:vec3f,cws:CoastalWaveState)->vec3f{
  let rw=cws.refractWeight;
  if(rw<=0.001){return d;}
  let tangDir=vec2f(-cws.shoreDir.y,cws.shoreDir.x);
  let dCrossShore=dot(d.xz,cws.shoreDir);
  let dAlongShore=dot(d.xz,tangDir);
  let xzRef=cws.shoreDir*dCrossShore*(1.0+rw*0.28)+tangDir*dAlongShore*(1.0-rw*0.68);
  return vec3f(xzRef.x,d.y,xzRef.y);
}
fn coastalRefractSlope(p:vec2f,sl:vec2f,cws:CoastalWaveState)->vec2f{
  let rw=cws.refractWeight;
  let shelterDamp=mix(0.52,1.0,clamp(cws.swellScale+0.25,0.0,1.0));
  if(rw<=0.001){return sl*shelterDamp;}
  let tangDir=vec2f(-cws.shoreDir.y,cws.shoreDir.x);
  let slCrossShore=dot(sl,cws.shoreDir);
  let slAlongShore=dot(sl,tangDir);
  let refracted=cws.shoreDir*slCrossShore*(1.0+rw*0.35)+tangDir*slAlongShore*(1.0-rw*0.72);
  return refracted*shelterDamp;
}
fn coastalBreakerFoam(p:vec2f,height:f32,sl:vec2f,cws:CoastalWaveState)->f32{
  let bed=cws.bed;
  if(bed<=-18.0 || bed>=0.75){return cws.breakFoam;}
  let h=max(0.08,-bed);
  let frontSlope=max(0.0,-dot(sl,cws.shoreDir));
  let dragRatio=max(0.0,height+0.12)/max(h,0.45);
  let depthBreak=smoothstep(0.18,0.56,dragRatio)*smoothstep(0.09,0.32,frontSlope)*smoothstep(-12.5,-0.5,bed)*(1.0-smoothstep(-0.06,0.45,bed));
  return clamp(max(cws.breakFoam,depthBreak*clamp(cws.swellScale*1.15,0.0,1.0)),0.0,1.0);
}
fn coastalWater(color:vec3f,p:vec2f,bed:f32,height:f32,foamLight:vec3f)->vec3f{
  // Deep/open water: the shallows weight and swash rim are both exactly zero
  // here (ocean height never approaches -58 m), so the result is the input.
  if(bed<=-58.0){return color;}
  // Deep blue gives way with depth. Over clear tropical sand it runs through turquoise to pale
  // aqua, as the sand starts to show through. Elsewhere shallows only turn a dull grey-green.
  let clarity=coastalWindow.w;
  let light=(sunIlluminance()*max(F.sunDir.y,0.0)+lunarIlluminance()*max(lunarDirection().y,0.0))/PI+skyAtmo(vec3f(0,1,0));
  let shelf=smoothstep(-30.0,-7.0,bed);
  let sand=smoothstep(-8.0,-0.6,bed);
  var col=mix(color,vec3f(0.014,0.150,0.205)*light,shelf*0.82*clarity);
  col=mix(col,vec3f(0.085,0.300,0.285)*light,sand*0.42*clarity);
  col=mix(col,vec3f(0.030,0.082,0.072)*light,smoothstep(-12.0,-1.0,bed)*0.45*(1.0-clarity));
  let depth=height-bed;
  let swashRim=(1.0-smoothstep(0.02,0.32,abs(depth)))*smoothstep(-0.20,0.35,height)*(0.45+0.55*gnoise(p*0.22));
  return mix(col,foamLight,swashRim*0.42);
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
fn skyBodyVisibility(p:vec2f,h:f32,dir:vec3f)->f32{
  var v=volumeSunVisibility(vec3f(p.x,h+8.0,p.y)*0.001,dir);
  let horizontal=max(length(dir.xz),0.01);let direction=dir.xz/horizontal;
  for(var i=0u;i<16u;i++){
    let reach=28.0*pow(1.31,f32(i));
    let rayHeight=h+8.0+reach*dir.y/horizontal;
    v*=smoothstep(-5.0,12.0,rayHeight-landHeight(p+direction*reach));
  }
  return v;
}
@compute @workgroup_size(8,8)
fn main(@builtin(global_invocation_id) id:vec3u){
  let size=textureDimensions(lightOut);if(any(id.xy>=size)){return;}
  let p=(vec2f(id.xy)+0.5)/vec2f(size)*LAND.domain.z-LAND.domain.z*0.5+LAND.domain.xy;
  let h=landHeight(p);
  var visibility=0.0;if(F.sunDir.y>0.0){visibility=skyBodyVisibility(p,h,F.sunDir.xyz);}
  var moonVisibility=0.0;if(lunarIrradiance()>0.0){moonVisibility=skyBodyVisibility(p,h,lunarDirection());}
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
  let shifted=position+vec3f(nearTerrain.grid.y,0.0,nearTerrain.grid.z);
  o.pos=F.viewProj*vec4f(earthCurve(shifted-F.camPos.xyz,F.camPos.y),1.0);return o;
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
  o.kind=kind;o.pos=F.viewProj*vec4f(earthCurve(o.world-F.camPos.xyz,F.camPos.y),1.0);return o;
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
  o.kind=kind;o.leafUV=leafUV;o.pos=F.viewProj*vec4f(earthCurve(o.world-F.camPos.xyz,F.camPos.y),1);return o;
}
// The opaque call graph contains neither discard nor a leaf texture fetch.
// Keep that property for Apple's hidden-surface removal; a runtime branch in
// one shared cutout fragment would still make solid ground a feedback shader.
fn landFinish(world:vec3f,n:vec3f,albedo:vec3f,diffuse:f32,ambientVisibility:f32,wet:f32,roughness:f32)->vec4f{
  let uv=(world.xz-LAND.domain.xy)/LAND.domain.z+0.5;
  let edgeDist=min(min(uv.x,1.0-uv.x),min(uv.y,1.0-uv.y));
  let inPrimaryDomain=clamp(LAND.domain.w,0.0,1.0)*smoothstep(0.0,0.36,edgeDist);
  let bakedLight=textureSampleLevel(landLight,sampC,clamp(uv,vec2f(0.0),vec2f(1.0)),0.0).rg;
  // The light bake already holds clouds and terrain. Only ground outside it marches for itself.
  var sunlight=bakedLight.r;
  if(inPrimaryDomain<1.0){
    let cloudSunVis=select(0.0,volumeSurfaceSunVisibility(world*0.001,F.sunDir.xyz),F.sunDir.y>0.0);
    sunlight=mix(cloudSunVis,bakedLight.r,inPrimaryDomain);
  }
  let direct=sunIlluminance()*sunlight;
  // Directional sky-hemisphere + ground/sea bounce irradiance from envCube
  let skyDir=normalize(vec3f(n.x*0.65,max(n.y,0.12),n.z*0.65));
  let skyIrr=textureSampleLevel(envCube,sampC,skyDir,6.0).rgb;
  let bounceDir=normalize(vec3f(n.x*0.5,-0.55,n.z*0.5));
  let groundIrr=textureSampleLevel(envCube,sampC,bounceDir,6.5).rgb*vec3f(0.88,0.80,0.68);
  let hemiMix=clamp(n.y*0.5+0.5,0.0,1.0);
  let ambient=mix(groundIrr*0.54,skyIrr,hemiMix);
  // Architectural cavity & eave self-shadowing + warm solar ground-bounce GI
  let archShadow=smoothstep(0.14,0.58,ambientVisibility);
  let sunGroundBounce=direct*max(F.sunDir.y,0.0)*(1.0-max(n.y,0.0))*0.068*vec3f(0.84,0.74,0.58)*ambientVisibility;
  let diffuseTerm=direct*diffuse*(0.30+0.70*archShadow)/PI+ambient*ambientVisibility+sunGroundBounce;
  let isMetal=wet<-0.01;
  let effWet=select(wet,0.0,isMetal);
  var col=albedo*(1.0-effWet*0.32)*diffuseTerm;
  // Physical GGX microfacet specular + roughness-mipmapped envCube reflections
  let v=normalize(F.camPos.xyz-world);let h=normalize(v+F.sunDir.xyz);
  let nDotV=max(dot(n,v),1e-4);
  let nDotL=max(dot(n,F.sunDir.xyz),0.0);
  let nDotH=max(dot(n,h),0.0);
  let vDotH=max(dot(v,h),0.0);
  let effRough=clamp(mix(roughness,min(roughness,0.12),effWet*0.80),0.06,0.98);
  let smoothFilm=select(clamp((0.40-roughness)/0.32,0.0,1.0)*effWet,1.0,isMetal);
  let f0=select(mix(0.038,0.058,effWet),clamp(-wet,0.18,0.56),isMetal);
  let maxF=select(mix(f0,0.75,smoothFilm),max(1.0-effRough*0.55,f0),isMetal);
  let fresnel=f0+(maxF-f0)*pow(1.0-nDotV,5.0);
  let fresnelSun=f0+(maxF-f0)*pow(1.0-vDotH,5.0);
  let a=effRough*effRough;
  let a2=max(a*a,1e-4);
  let denom=nDotH*nDotH*(a2-1.0)+1.0;
  let D=a2/(PI*denom*denom);
  let k=(effRough+1.0)*(effRough+1.0)*0.125;
  let G=(nDotV/(nDotV*(1.0-k)+k))*(nDotL/(nDotL*(1.0-k)+k));
  let specBRDF=(D*G*fresnelSun)/max(4.0*nDotV,1e-3);
  var reflDir=reflect(-v,n);
  reflDir.y=max(reflDir.y,-0.12);
  let envMip=clamp(effRough*7.0,0.4,7.0);
  let envSpec=textureSampleLevel(envCube,sampC,normalize(reflDir),envMip).rgb;
  let reflStrength=fresnel*smoothFilm*(1.0-effRough*0.78)*(0.26+0.74*ambientVisibility);
  let skyRefl=envSpec*reflStrength;
  let specMask=select(clamp((0.72-effRough)/0.42,0.0,1.0)*(0.08+0.92*effWet),0.65,isMetal);
  col+=direct*min(specBRDF,1.5)*specMask*(0.25+0.75*archShadow)+skyRefl;
  col+=lunarSurface(n,v,albedo*(1.0-effWet*.32),effRough,vec3f(f0),vec3f(mix(1.0,bakedLight.g,inPrimaryDomain)));
  col+=lightningSurface(n,v,albedo,effRough);
  col=surfaceAir(col,world);
  // Clip cloud integration at high mountain surfaces: clouds behind mountain peaks
  // stay hidden and low clouds in front veil upper slopes, while low coastal plains
  // and beaches share the same clear aerial perspective as the ocean and forest canopy.
  let mountainVeil=smoothstep(320.0,580.0,world.y);
  if(mountainVeil>0.001){
    let ray=marchCloudsTo(F.camPos.xyz*0.001,normalize(world-F.camPos.xyz),12u,0.5,
      sunIlluminance(),skyAtmo(vec3f(0,1,0)),distance(world,F.camPos.xyz)*0.001);
    let veilAlpha=ray.color.a*mountainVeil;
    return vec4f(col*(1.0-veilAlpha)+ray.color.rgb*mountainVeil,1.0);
  }
  return vec4f(col,1.0);
}
fn landOpaque(in:LandVertex)->vec4f{
  let world=in.world;
  let rawNLen=length(in.normal);
  let structDmg=clamp(rawNLen-1.0,0.0,1.5);
  var n=in.normal/max(rawNLen,1e-4);
  let uv=(world.xz-LAND.domain.xy)/LAND.domain.z+0.5;
  let dx=dpdx(world);let dy=dpdy(world);let nx=dpdx(n);let ny=dpdy(n);
  // Registered aerial RGB remains the regional colour seed. The neutral detail
  // below adds material scale, never a replacement green/brown island palette.
  // Overhead imagery holds nothing about a steep face. Blur it there by the surface's own
  // footprint and a few texels, so it gives colour without smearing downhill.
  let imageSteep=smoothstep(.12,.42,1.0-max(n.y,0.0));
  let imageBlur=max(max(length(dx),length(dy)),imageSteep*4.0*LAND.domain.z/f32(textureDimensions(landAlbedo).x))/LAND.domain.z;
  var source=pow(textureSampleGrad(landAlbedo,landSampler,uv,mix(dx.xz/LAND.domain.z,vec2f(imageBlur,0.0),imageSteep),mix(dy.xz/LAND.domain.z,vec2f(0.0,imageBlur),imageSteep)).rgb,vec3f(2.2));
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
  // Pick one world-true plane; never blend them. Their coordinates lie thousands of metres
  // apart, so a slight blend slides the pattern across the slope and stripes it. Detail
  // fades to nothing at each switch, leaving no seam for the bump to catch.
  let verticalBias=abs(n.z)-abs(n.x);
  let vertical=select(world.zy,world.xy,verticalBias>0.0);
  let materialUV=select(world.xz,vertical,rocky>.5);
  let materialSeam=smoothstep(0.0,.1,abs(rocky-.5))*select(1.0,smoothstep(0.0,.08,abs(verticalBias)),rocky>.5);
  let materialWidth=landMaterialFootprint3(dx,dy);
  let bldgUV=clamp(vec2f(in.kind.x-20.0,in.kind.y),vec2f(0.001),vec2f(0.999));
  let bldgDx=dpdx(bldgUV);let bldgDy=dpdy(bldgUV);
  var albedo=source;var relief=0.0;var roughness=0.95;
  var ambientVisibility=0.42+0.35*max(n.y,0.0);
  let crown=in.kind.x>3.5;
  var surfaceWet=0.0;
  var canopyBackscatter=0.0;
  if(in.kind.x<2.5){
    let canopyWeight=smoothstep(0.14,0.62,vegetation)*(1.0-rocky*0.85);
    let crownW1=footprint*0.105;let crownW2=footprint*0.046;
    let crownN1=landFilteredNoise(world.xz*0.105+vec2f(grain*0.75,-grain*0.55),crownW1);
    let crownN2=landFilteredNoise(world.xz*0.046+vec2f(-grain*0.45,grain*0.65),crownW2);
    // Bare slopes below about 60 degrees rest as loose stone; only steeper faces show bedding.
    let cliff=smoothstep(.40,.62,1.0-n.y+grain*.05);
    let screeWeight=smoothstep(.10,.30,1.0-n.y+grain*.07)*(1.0-canopyWeight)*(1.0-cliff*.55);
    var scree=vec3f(0.0,1.0,0.0);
    if(screeWeight>.01){scree=landScree(world,n,footprint);}
    let coastSand=select(0.0,clamp((in.kind.y-0.02)/0.98,0.0,1.0),in.kind.x<0.5&&in.kind.y>0.015);
    let groundCover=landGroundCover(source,1.0-n.y,cliff,crownN1,crownN2,grain,scree.x,world.y,(1.0-canopyWeight)*(1.0-coastSand),nearGround);
    source=groundCover.rgb;
    // Single stones dissolve with distance into tone, so far slopes never read as masonry.
    let screeNear=1.0-smoothstep(.04,.45,footprint);
    let screeMottle=crownN1*.2+crownN2*.3;
    // Grass hides most stones, leaving the mottling and only the palest as scattered rocks.
    let screeTone=screeWeight*(screeMottle*.5+(scree.x*mix(.1,.26,screeNear)-(1.0-scree.y)*mix(.03,.3,screeNear))*(1.0-groundCover.a*.65));
    let screeRelief=screeWeight*(scree.y-.5)*scree.z*mix(.06,.3,screeNear);
    if(nearGround){
      let rockMass=landOrientedDetail(world,n,dx,dy,.24);
      let fracture=landOrientedDetail(world+vec3f(19.1,7.3,4.7),n,dx,dy,1.35);
      let gravel=landOrientedDetail(world,n,dx,dy,7.5);
      var joint=0.0;var strata=0.0;
      if(rocky>.01){joint=landOrientedJoint(world+vec3f(19.1,7.3,4.7),n,dx,dy);strata=landNearStrata(world,dx,dy);}
      let crownBillow=(abs(crownN1)*0.68+crownN2*0.32)*canopyWeight;
      let crownGap=clamp(0.38-abs(crownN1),0.0,0.38)*landDetailWeight(crownW1)*canopyWeight;
      let basalWetRock=rocky*(1.0-smoothstep(0.2,2.1,world.y));
      albedo=source*(1.0+screeTone+rockMass*.22+fracture*.13+gravel*.08+rocky*(strata*cliff*.065-joint*.16)+crownBillow*0.18-crownGap*0.38)*(1.0-basalWetRock*0.32);
      relief=screeRelief+mix(gravel*.018+fracture*.025+crownBillow*0.38-crownGap*0.28,rockMass*.28+fracture*.11+gravel*.014+strata*cliff*.022-joint*.09,rocky);
      ambientVisibility*=(1.0-crownGap*0.34)*(1.0-rocky*joint*0.18);
      surfaceWet=basalWetRock*0.75;
      roughness=clamp(.91+gravel*.08-rocky*.08-canopyWeight*0.04,.70,.98);
      canopyBackscatter=canopyWeight*0.16;
    }else{
    // Ground and cliff projections keep metre-scale stone legible on slopes.
    // Two-dimensional analytic noise only; no 3D noise octave loop. Crowns and
    // bark never execute these ground-material evaluations.
    let isProceduralCoast=in.kind.x<0.5&&in.kind.y>0.015;
    let beachSand=select(0.0,clamp((in.kind.y-0.02)/0.98,0.0,1.0),isProceduralCoast);
    let rockKeep=1.0-beachSand*0.94;
    let effCanopy=canopyWeight*(1.0-beachSand);
    let blockWidth=materialWidth*.19;let blockWeight=landDetailWeight(blockWidth);
    var blockNoise=0.0;if(blockWeight>0.0){blockNoise=gnoise(materialUV*.19)*materialSeam;}
    let blocks=blockNoise*blockWeight*rockKeep;
    let stoneRaw=landFilteredNoise(materialUV*.82,materialWidth*.82)*materialSeam;
    let stone=stoneRaw*rockKeep;
    let pores=landFilteredNoise(materialUV*5.4,materialWidth*5.4)*materialSeam;
    let fissure=landFilteredFissure(materialUV*1.7+vec2f(13.1,7.7),materialWidth*1.7,.025,.11)*rockKeep*materialSeam;
    // Reuse the raw block noise, not its faded value, without another noise call.
    let coarseFissure=(1.0-smoothstep(.025,.09,abs(blockNoise)))*landDetailWeight(blockWidth/.065)*rockKeep*materialSeam;
    var baseSource=source;
    var swashGloss=0.0;
    var waterFilm=0.0;
    var cliffStrata=0.0;
    var ledgeStep=0.0;
    var cragFacet=0.0;
    let basalWetRock=rocky*rockKeep*(1.0-smoothstep(0.15,2.15,world.y));
    if(isProceduralCoast){
      let gentle=smoothstep(0.32,0.08,1.0-n.y);
      let cuspWave=sin(world.x*0.042-world.z*0.031+blockNoise*1.5)*0.22;
      let swashRunup=0.26+0.28*sin(F.camPos.w*1.12+world.x*0.038+world.z*0.032+stoneRaw*1.2)+cuspWave;
      let dryZone=smoothstep(-0.35,0.65,world.y)*(1.0-smoothstep(1.85,3.25+stoneRaw*0.45,world.y))*gentle*beachSand;
      waterFilm=smoothstep(-0.95,-0.15,world.y)*(1.0-smoothstep(swashRunup-0.12,swashRunup+0.22,world.y))*gentle*beachSand;
      let capillaryZone=smoothstep(-0.85,-0.05,world.y)*(1.0-smoothstep(swashRunup+0.12,swashRunup+1.15+stoneRaw*0.22,world.y))*gentle*beachSand;
      let wrack=exp(-pow((world.y-(1.12+cuspWave*0.55+stoneRaw*0.20))/0.14,2.0))*gentle*beachSand;
      let shoalZone=(1.0-smoothstep(-5.5,0.12,world.y))*gentle*beachSand;
      let shellGrit=max(0.0,pores-0.25)*landDetailWeight(materialWidth*5.4)*0.08*(1.0-waterFilm*0.7);
      let dryCoralSand=vec3f(0.57,0.47,0.32)*(1.0+stoneRaw*0.06+pores*0.035+shellGrit);
      let dampSand=vec3f(0.34,0.27,0.19)*(1.0+stoneRaw*0.04+pores*0.03);
      let wetSwashSand=vec3f(0.21,0.17,0.12)*(1.0+pores*0.02);
      let wrackTint=vec3f(0.13,0.11,0.07)*(1.0+stoneRaw*0.18);
      let shoalSand=vec3f(0.20,0.34,0.32)*(1.0+stoneRaw*0.05);
      baseSource=mix(baseSource,dryCoralSand,dryZone*0.86);
      baseSource=mix(baseSource,dampSand,capillaryZone*0.82);
      baseSource=mix(baseSource,wetSwashSand,waterFilm*0.92);
      baseSource=mix(baseSource,wrackTint,wrack*0.48);
      baseSource=mix(baseSource,shoalSand,shoalZone*0.75);
      swashGloss=max(capillaryZone*0.58,waterFilm*0.96);
    }
    let strataDetailW=landDetailWeight(footprint*0.45)*cliff*rockKeep;
    cliffStrata=(sin(world.y*1.95+blockNoise*2.4)*0.65+sin(world.y*4.8-stoneRaw*1.7)*0.35)*strataDetailW;
    ledgeStep=(smoothstep(-0.22,0.32,cliffStrata)-0.5)*strataDetailW;
    cragFacet=(abs(stoneRaw)-0.32)*landDetailWeight(materialWidth*0.82)*rocky*rockKeep;
    let rockTone=mix(vec3f(1.0),mix(vec3f(0.94,0.96,1.04),vec3f(1.06,1.01,0.92),clamp(0.5+0.5*cliffStrata,0.0,1.0)),rocky*rockKeep*0.55);
    // Dual-scale beach sand ripples: braided cross-shore swash ripples (smoothed under active water film) + fine wind ripples on dry berm
    // Wind and swash ripple only a gentle beach; sand cannot hold them on a hillside.
    let rippleW=landDetailWeight(materialWidth*0.45)*beachSand*(1.0-smoothstep(.05,.14,1.0-n.y));
    let waveRipple=sin(world.x*1.95+world.z*1.42+stoneRaw*2.8)*cos(world.x*0.58-world.z*0.76+stoneRaw*1.5)*(1.0-waterFilm*0.65);
    let windRipple=sin(world.x*3.3-world.z*2.1+pores*1.6)*(1.0-swashGloss);
    let sandRipple=(waveRipple*0.024+windRipple*0.014)*rippleW;
    // Baked distant canopy crown domes & inter-crown shadow pockets on forested terrain
    let crownBillow=(abs(crownN1)*0.68+crownN2*0.32)*effCanopy;
    let crownGap=clamp(0.40-abs(crownN1),0.0,0.40)*landDetailWeight(crownW1)*effCanopy;
    let canopyTone=mix(vec3f(1.0),vec3f(1.0+crownN2*0.09,1.0+crownBillow*0.14,1.0-crownN2*0.06),effCanopy);
    albedo=baseSource*rockTone*canopyTone*(1.0+screeTone*rockKeep+blocks*.15+stone*0.11+cliffStrata*0.075+ledgeStep*0.06+cragFacet*0.05+pores*(0.055-beachSand*0.025)+sandRipple+crownBillow*0.20-crownGap*0.42-(fissure*.085+coarseFissure*.095)*rocky)*(1.0-basalWetRock*0.34);
    let soil=stone*(0.025+vegetation*0.012)+pores*(0.006+vegetation*0.006)+sandRipple*0.42+crownBillow*0.42-crownGap*0.32;
    let rockRelief=stone*0.15+blocks*.24+cliffStrata*0.048+ledgeStep*0.042+cragFacet*0.035-fissure*0.075-coarseFissure*.11;
    relief=screeRelief*rockKeep+mix(soil,rockRelief,rocky*rockKeep);
    ambientVisibility*=(1.0-crownGap*0.38)*(1.0-(fissure*0.22+coarseFissure*0.25)*rocky);
    surfaceWet=max(swashGloss,basalWetRock*0.75);
    let baseRough=mix(0.89+vegetation*0.03-effCanopy*0.05+pores*0.055-rocky*0.09,0.76+pores*0.03,beachSand);
    roughness=clamp(mix(baseRough,mix(0.20,0.07,waterFilm),surfaceWet),0.07,0.98);
    canopyBackscatter=effCanopy*0.18;
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
    let portShade=clamp(in.kind.y,0.18,1.0);
    let aoVis=0.32+0.68*portShade;
    let shadeAlbedo=0.52+0.48*portShade;
    let camDist=distance(world,F.camPos.xyz);
    let microLodFade=(1.0-smoothstep(140.0,340.0,camDist))*detailFade;
    let archLodFade=(1.0-smoothstep(320.0,900.0,camDist))*detailFade;
    let detailA=landOrientedDetail(world,n,dx,dy,1.45);
    let detailB=landOrientedDetail(world+vec3f(7.3,3.1,11.9),n,dx,dy,5.2);
    if(in.kind.x<10.5){
      // Kind 10: Weathered Spanish cedar, oak & pitch-pine timber (piers, balconies, casements, rafters)
      // Boards lie level on an upright face and side by side on a flat one. Measuring them on
      // the face itself, never along a world diagonal, keeps seams and grain from crossing into a weave.
      let upright=abs(n.y)<.7;
      let boardCoord=select(world.z,world.y,upright)*3.2;
      let boardDx=select(dx.z,dx.y,upright)*3.2;
      let boardDy=select(dy.z,dy.y,upright)*3.2;
      let boardFade=landDetailWeight(length(vec2f(boardDx,boardDy)));
      let plank=(fract(sin(floor(boardCoord)*91.7)*43758.5453)-.5)*boardFade;
      let grainCoord=boardCoord*7.0+detailA*2.4;
      let grain=landFilteredCourse(grainCoord,boardDx*7.0,boardDy*7.0,1.0)*.5*microLodFade;
      let seam=max(0.0,landFilteredCourse(boardCoord,boardDx,boardDy,2.0)-0.38)*archLodFade;
      albedo=vec3f(0.22,0.135,0.075)*shadeAlbedo*(1.0+detailA*0.18+detailB*0.09+plank*0.22+grain*0.05-seam*0.16);
      relief=(detailA*0.036+plank*0.026+grain*0.014-seam*0.034)*archLodFade;
      roughness=clamp(0.73-plank*0.04+seam*0.12,0.62,0.88);
      ambientVisibility=(0.42+0.34*max(n.y,0.0))*aoVis*(1.0-seam*0.22);
    }else if(in.kind.x<11.5){
      // Kind 11: Coursed Pedra Lioz & coral-limestone ashlar masonry (bastion walls, quoins, arches, buttresses)
      let vertWall=1.0-smoothstep(0.35,0.85,abs(n.y));
      let courseY=world.y*1.65;
      let bedJoint=max(0.0,landFilteredCourse(courseY,dx.y*1.65,dy.y*1.65,2.0)-0.22)*vertWall;
      let blockCoord=(world.x+world.z)*0.68+floor(courseY)*0.5;
      let headJoint=max(0.0,landFilteredCourse(blockCoord,(dx.x+dx.z)*0.68,(dy.x+dy.z)*0.68,1.8)-0.28)*vertWall*microLodFade;
      let jointWave=clamp(0.68*bedJoint+0.36*headJoint,0.0,1.0);
      let blockId=floor(courseY)*19.0+floor(blockCoord);
      let blockHash=(fract(sin(blockId*127.1)*43758.5453)-0.5)*archLodFade;
      let damp=smoothstep(0.2,3.8,world.y);
      let blockTint=vec3f(1.0+blockHash*0.065,1.0+blockHash*0.048,1.0+blockHash*0.025);
      let stoneBase=mix(vec3f(0.38,0.35,0.29),vec3f(0.53,0.49,0.41),damp)*blockTint+vec3f(detailA*0.035);
      albedo=stoneBase*shadeAlbedo*(0.98-0.14*jointWave+detailA*0.11+detailB*0.055);
      relief=(detailA*0.044+detailB*0.018-jointWave*0.056)*archLodFade;
      roughness=clamp(0.75-blockHash*0.06+jointWave*0.14+(1.0-damp)*0.05,0.62,0.92);
      ambientVisibility=(0.46+0.34*max(n.y,0.0))*aoVis*(1.0-jointWave*0.26);
    }else if(in.kind.x<12.5){
      // Kind 12: Warm Iberian & colonial limewashed stucco (cream/ochre plaster with trowel relief & cornice weathering)
      let damp=smoothstep(0.5,3.4,world.y);
      let trowel=landFilteredWave(world,dx,dy,vec3f(2.6,0.8,2.3),detailA*2.4)*0.022;
      let washStreak=sin(world.x*3.4+world.z*3.1+detailA*2.0)*0.018*microLodFade;
      let warmStucco=mix(vec3f(0.53,0.47,0.37),vec3f(0.78,0.71,0.58),damp)+vec3f(trowel+washStreak);
      albedo=warmStucco*shadeAlbedo*(1.0+detailA*0.08+detailB*0.045);
      relief=(detailA*0.026+detailB*0.012+trowel*0.52)*archLodFade;
      roughness=clamp(0.77-trowel*1.2+detailB*0.04,0.68,0.88);
      ambientVisibility=(0.48+0.36*max(n.y,0.0))*aoVis;
    }else if(in.kind.x<13.5){
      // Kind 13: Fired terracotta barrel roof tiles (tejas curvas / telha de canudo aligned down roof slope)
      let slopeLen=length(n.xz);
      let tileTan=select(vec3f(0.7071,0.0,0.7071),vec3f(-n.z,0.0,n.x)/max(slopeLen,1e-3),slopeLen>0.08);
      let flute=landFilteredWave(world,dx,dy,tileTan*19.5,detailA*0.55)*microLodFade;
      let courseWave=landFilteredCourse(world.y*2.6,dx.y*2.6,dy.y*2.6,1.8);
      let courseStep=max(0.0,courseWave-0.24)*archLodFade;
      let kilnVar=(detailA*0.62+detailB*0.38)*0.048;
      let tileCol=vec3f(0.52+kilnVar,0.19+kilnVar*0.48,0.092+kilnVar*0.26);
      albedo=tileCol*shadeAlbedo*(1.0+detailA*0.11+flute*0.09+detailB*0.05-courseStep*0.14);
      relief=(flute*0.056+detailA*0.018-courseStep*0.038)*archLodFade;
      roughness=clamp(0.62-flute*0.06+courseStep*0.12+detailB*0.04,0.50,0.78);
      ambientVisibility=(0.48+0.36*max(n.y,0.0))*aoVis*(1.0-courseStep*0.20);
    }else if(in.kind.x<14.5){
      // Kind 14: 16th-century leaded-glass casements (vidrieras emplomadas with sky reflections) & deep arched portals
      let hFlat=1.0-clamp(abs(n.x)+abs(n.z),0.0,1.0);
      let hWx=abs(n.z)+0.7071*hFlat;
      let hWz=abs(n.x)+0.7071*hFlat;
      let hCoord=world.x*hWx+world.z*hWz;
      let hDx=dx.x*hWx+dx.z*hWz;
      let hDy=dy.x*hWx+dy.z*hWz;
      let rejaX=max(0.0,landFilteredCourse(hCoord*3.4,hDx*3.4,hDy*3.4,2.0)-0.34);
      let rejaY=max(0.0,landFilteredCourse(world.y*2.2,dx.y*2.2,dy.y*2.2,1.8)-0.34);
      let rejaWave=clamp(0.62*rejaX+0.48*rejaY,0.0,1.0)*archLodFade;
      let isGlazedWindow=in.kind.y>0.25;
      if(isGlazedWindow){
        // Diamond leaded glass quarrels (emplomado) with crown-glass wave & sky/cloud reflections
        let d1=abs(fract((hCoord+world.y)*2.8)-0.5);
        let d2=abs(fract((hCoord-world.y)*2.8)-0.5);
        let leadCame=(1.0-smoothstep(0.035,0.085,min(d1,d2)))*microLodFade;
        let frameMask=clamp(max(rejaWave,leadCame*0.85),0.0,1.0);
        let glassWarp=sin(hCoord*9.5+detailA*3.2)*cos(world.y*9.5-detailB*3.2)*0.022*archLodFade;
        let roomDepth=vec3f(0.038,0.052,0.066)*(0.75+0.25*sin(hCoord*1.8+world.y*1.2))*(0.65+0.35*portShade);
        let ironCol=vec3f(0.095,0.088,0.082)*(0.70+0.30*portShade);
        albedo=mix(roomDepth,ironCol,frameMask);
        relief=glassWarp*(1.0-frameMask)+frameMask*0.024;
        roughness=mix(0.10,0.48,frameMask);
        surfaceWet=0.72*(1.0-frameMask*0.85);
        ambientVisibility=0.44+0.32*portShade;
      }else{
        // Deep vaulted arch portals & shadowed embrasures with wrought-iron grille bars
        albedo=vec3f(0.048,0.040,0.033)*(1.0-0.22*rejaWave)*portShade*(1.0+detailB*0.08);
        relief=(detailB*0.010+rejaWave*0.018)*archLodFade;
        roughness=mix(0.84,0.45,rejaWave);
        ambientVisibility=0.14+0.12*portShade;
      }
    }else if(in.kind.x<15.5){
      // Kind 15: Layered palm-thatch & bundled reed roof (guano / palma real for bohíos, caneyes & palafitos)
      let straw=landFilteredWave(world,dx,dy,vec3f(23.92,0.0,23.92),detailA*1.8)*microLodFade;
      let tierWave=landFilteredCourse(world.y*1.9,dx.y*1.9,dy.y*1.9,1.7)*archLodFade;
      let bundleVar=(detailA*0.65+detailB*0.35)*0.038;
      let thatchCol=vec3f(0.36+bundleVar,0.27+bundleVar*0.7,0.145+bundleVar*0.4)*(0.94-0.08*tierWave);
      albedo=thatchCol*shadeAlbedo*(1.0+detailA*0.12+straw*0.10+detailB*0.07);
      relief=(straw*0.036-tierWave*0.024+detailA*0.018)*archLodFade;
      roughness=0.91;
      ambientVisibility=(0.44+0.36*max(n.y,0.0))*aoVis;
    }else if(in.kind.x<16.5){
      // Kind 16: River-cobble courtyard pavement & flagstone/packed-earth terreplein (empedrado / calçada)
      let cobbleDetail=landOrientedDetail(world,n,dx,dy,3.8);
      let cobbleJoint=max(0.0,abs(cobbleDetail)-0.22)*microLodFade;
      let baseEarth=vec3f(0.36,0.32,0.265)*(1.0+cobbleDetail*0.12-cobbleJoint*0.18);
      albedo=baseEarth*shadeAlbedo*(1.0+detailA*0.14+detailB*0.08);
      relief=(detailA*0.032+cobbleDetail*0.024-cobbleJoint*0.028)*archLodFade;
      roughness=clamp(0.80+cobbleJoint*0.12,0.70,0.92);
      ambientVisibility=(0.48+0.36*max(n.y,0.0))*aoVis;
    }else if(in.kind.x<17.5){
      // Kind 17: Paper-birch & elm/cedar bark sheathing (Abenaki wigwams, Algonquian longhouses & birchbark canoes)
      let seamY=landFilteredCourse(world.y*1.35,dx.y*1.35,dy.y*1.35,2.0);
      let seamX=landFilteredCourse((world.x+world.z)*0.85,(dx.x+dx.z)*0.85,(dy.x+dy.z)*0.85,2.0);
      let seamWave=(0.65*seamY+0.35*seamX)*archLodFade;
      let lenticel=landFilteredWave(world,dx,dy,vec3f(6.5,26.0,-6.5),detailA*2.4)*microLodFade;
      let sheetVar=(detailA*0.55+detailB*0.45)*0.048;
      let barkCream=vec3f(0.64+sheetVar,0.56+sheetVar*0.8,0.44+sheetVar*0.6);
      let innerCambium=vec3f(0.42,0.26,0.14);
      let baseBark=mix(barkCream,innerCambium,clamp(0.18+0.22*seamWave,0.0,0.65))*(1.0-max(lenticel,0.0)*0.26);
      albedo=baseBark*shadeAlbedo*(0.94+detailA*0.11+detailB*0.06);
      relief=(-seamWave*0.024-lenticel*0.015+detailA*0.018)*archLodFade;
      roughness=0.78;
      ambientVisibility=(0.48+0.36*max(n.y,0.0))*aoVis;
    }else{
      // Kind 18: Dark sand-cast ordnance iron & forged harbor metal (cast-iron fortress cannons, trunnions, bollards, mooring rings, cauldrons)
      let latheBand=landFilteredWave(world,dx,dy,vec3f(14.5,18.0,14.5),detailA*0.85)*microLodFade;
      let bareIron=clamp(0.16+detailA*0.16+max(0.0,n.y)*0.08-max(0.0,-detailB)*0.10,0.05,0.36);
      let oxideDark=vec3f(0.017,0.018,0.021)*(0.90+0.20*detailA);
      let gunmetalSheen=vec3f(0.046,0.050,0.056)*(0.94+0.14*latheBand);
      let warmPatina=vec3f(0.030,0.020,0.014)*clamp(-detailA*0.55+(1.0-max(n.y,0.0))*0.24,0.0,0.42);
      albedo=(mix(oxideDark,gunmetalSheen,bareIron)+warmPatina*0.26)*(0.60+0.40*portShade);
      relief=(detailA*0.016+detailB*0.022+latheBand*0.009)*archLodFade;
      roughness=clamp(0.45-bareIron*0.30-detailB*0.07+(1.0-portShade)*0.10,0.28,0.64);
      surfaceWet=-(0.24+bareIron*0.42);
      ambientVisibility=(0.46+0.38*max(n.y,0.0))*aoVis;
    }
  }else if(crown){
    let exposure=clamp(in.kind.y,0.0,1.0);
    let canopyGrain=gnoise(world.xz*0.32+vec2f(world.y*0.17));
    let clumpBillow=gnoise(world.xz*0.85+vec2f(world.y*0.55,-world.y*0.35))*detailFade;
    let regionalTint=clamp(source/vec3f(0.10,0.14,0.06),vec3f(0.7),vec3f(1.3));
    albedo=leafMean.rgb*mix(vec3f(1),regionalTint,0.2)*(0.76+exposure*0.32+canopyGrain*0.055+clumpBillow*0.045);
    ambientVisibility=0.14+exposure*0.47+max(n.y,0.0)*0.09;
    relief=(canopyGrain*0.035+clumpBillow*0.028)*detailFade;
    roughness=0.88;
    canopyBackscatter=0.22*exposure;
  }else{
    let barkNoise=gnoise(in.leafUV*vec2f(38.0,9.0));
    let ridges=pow(0.5+0.5*sin(in.leafUV.x*PI*56.0+barkNoise*3.0),5.0);
    let fissure=smoothstep(0.15,0.75,ridges);
    albedo=vec3f(0.095,0.068,0.038)*(0.76+fissure*0.12+barkNoise*0.18+in.kind.y*0.16);
    relief=(ridges-0.5)*0.014*(1.2-in.kind.y)*detailFade;roughness=0.91;
  }
  if(structDmg>0.005){
    let dmgW=clamp(structDmg,0.0,1.0);
    let spallDetail=landOrientedDetail(world+vec3f(5.7,2.3,9.1),n,dx,dy,3.2);
    let gritDetail=landOrientedDetail(world+vec3f(14.1,8.7,3.9),n,dx,dy,8.5);
    let fissure=landOrientedJoint(world+vec3f(11.3,4.7,6.9),n,dx,dy);
    let isAperture=abs(in.kind.x-14.0)<=0.4;
    let isCastIron=in.kind.x>=17.5&&in.kind.x<18.5;
    let isStoneRubble=in.kind.x>=10.5&&in.kind.x<16.5&&!isAperture&&abs(in.kind.x-15.0)>0.4;
    if(isAperture){
      let sootVoid=vec3f(0.024,0.020,0.018);
      albedo=mix(albedo,sootVoid,clamp(dmgW*0.58+fissure*0.25,0.0,0.78));
      surfaceWet*=(1.0-dmgW*0.85);
      ambientVisibility*=mix(1.0,0.55,dmgW);
      roughness=max(roughness,0.93);
    }else if(isCastIron){
      let gougeSteel=vec3f(0.085,0.090,0.098)*clamp(0.5+spallDetail*0.8,0.2,1.2);
      let powderSoot=vec3f(0.014,0.013,0.012);
      albedo=mix(mix(albedo,gougeSteel,clamp(dmgW*0.28+max(0.0,spallDetail)*0.22,0.0,0.45)),powderSoot,clamp(fissure*0.52+dmgW*0.30,0.0,0.65));
      relief+=(spallDetail*0.018-fissure*0.022)*dmgW*detailFade;
      roughness=clamp(roughness+dmgW*0.18,0.32,0.76);
    }else if(isStoneRubble){
      let shadeKeep=clamp(in.kind.y,0.38,1.0);
      let exposedCore=select(vec3f(0.45,0.40,0.33),vec3f(0.40,0.25,0.16),in.kind.x>=11.5&&in.kind.x<13.5)*shadeKeep*(0.94+0.14*gritDetail);
      let spallPatch=clamp(dmgW*0.48+spallDetail*0.32,0.0,0.68);
      let spalledAlbedo=mix(albedo,exposedCore,spallPatch);
      let creviceSoot=vec3f(0.085,0.074,0.064);
      let sootMix=clamp(fissure*0.58+max(0.0,-spallDetail)*0.24+dmgW*0.18,0.0,0.62);
      albedo=mix(spalledAlbedo,creviceSoot,sootMix*dmgW);
      let blockFacet=0.35*spallDetail+0.20*gritDetail-0.55*fissure;
      relief+=blockFacet*0.028*dmgW*detailFade;
      ambientVisibility*=mix(1.0,0.62+0.38*clamp(1.0-fissure*0.65+spallDetail*0.20,0.0,1.0),dmgW*0.75);
      roughness=max(roughness,0.93);
    }else{
      let splinterNoise=landOrientedDetail(world+vec3f(3.3,7.9,12.1),n,dx,dy,5.5);
      let rawWood=select(vec3f(0.14,0.105,0.080),vec3f(0.28,0.18,0.095),in.kind.x>=9.5);
      let sootTint=vec3f(0.065,0.056,0.048);
      let dmgAlbedo=mix(albedo,rawWood,clamp(dmgW*0.45+splinterNoise*0.25,0.0,0.65));
      albedo=mix(dmgAlbedo,sootTint,clamp((fissure*0.48+dmgW*0.25-splinterNoise*0.18)*dmgW,0.0,0.58));
      relief+=(splinterNoise*0.024-fissure*0.020)*dmgW*detailFade;
      roughness=max(roughness,0.93);
    }
  }
  let reliefX=dpdx(relief);let reliefY=dpdy(relief);
  n=landFilteredBump(n,dx,dy,reliefX,reliefY);
  let tidePulse=0.75+0.25*sin(F.camPos.w*0.7+world.x*0.02);
  let shoreWet=(1.0-smoothstep(0.35,2.2,world.y))*tidePulse*select(0.45,0.22,in.kind.x>=9.5);
  let wet=select(clamp(max(shoreWet,surfaceWet),0.0,0.96),surfaceWet-shoreWet*0.14,surfaceWet<-0.01);
  roughness=mix(roughness,min(roughness,0.24),shoreWet*0.65);
  let nDotL=dot(n,F.sunDir.xyz);
  let diffuse=max(nDotL,0.0)+max(-nDotL,0.0)*canopyBackscatter;
  return landFinish(world,n,albedo,diffuse,ambientVisibility,wet,roughness);
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
  let rockStrata=sin(world.y*5.5+world.x*2.1-world.z*1.7)*0.08;
  let rock=mix(vec3f(luminance)*vec3f(.96+rockStrata,.91+rockStrata*0.5,.84-rockStrata*0.4),source,.16)*shade*(0.92+0.12*max(n.y,0.0));
  let dry=vec3f(.17,.145,.065);let green=mix(leafMean.rgb,source,.18);
  let foliage=mix(dry,green,smoothstep(.12,.7,vegetation))*shade;
  let albedo=select(rock,foliage,grass);
  let sunlight=textureSampleLevel(landLight,sampC,uv,0).r;
  let direct=sunIlluminance()*sunlight;
  let ambient=textureSampleLevel(envCube,sampC,vec3f(0,1,0),7).rgb;
  let diffuse=max(dot(n,F.sunDir.xyz),0.0)+select(0.0,max(dot(-n,F.sunDir.xyz),0.0)*.38,grass);
  let visibility=select(.35+.30*max(n.y,0.0),.32+in.kind.y*.32,grass);
  let wet=(1.0-smoothstep(0.6,3.2,world.y))*.55;
  var color=albedo*(1.0-wet*.3)*(direct*diffuse/PI+ambient*visibility);
  color+=lunarSurface(n,normalize(F.camPos.xyz-world),albedo,.84,vec3f(.035),vec3f(textureSampleLevel(landLight,sampC,uv,0).g));
  color+=lightningSurface(n,normalize(F.camPos.xyz-world),albedo,.84);
  return vec4f(surfaceAir(color,world),1);
}
@fragment fn leafFS(in:LandVertex,@builtin(front_facing) front:bool)->@location(0) vec4f{
  let world=in.world;
  let uvCentered=in.leafUV-vec2f(0.5,0.5);
  let n=normalize(in.normal*select(-1.0,1.0,front)+vec3f(uvCentered.x*0.24,uvCentered.y*0.20,0.0));
  let uv=(world.xz-LAND.domain.xy)/LAND.domain.z+0.5;
  // Derivative-dependent samples precede discard; this shader alone is cutout.
  let leaf=textureSampleBias(leafSpray,landSampler,in.leafUV,0.1);
  let source=pow(textureSample(landAlbedo,landSampler,uv).rgb,vec3f(2.2));
  let regionalTint=clamp(source/vec3f(0.10,0.14,0.06),vec3f(0.7),vec3f(1.3));
  let exposure=clamp(in.kind.y,0.0,1.0);let nDotL=dot(n,F.sunDir.xyz);
  let backlit=max(-nDotL,0.0)*0.52;
  let warmTrans=mix(vec3f(1.0),vec3f(1.12,1.16,0.78),backlit*exposure);
  let albedo=pow(leaf.rgb,vec3f(2.2))*mix(vec3f(1),regionalTint,0.2)*warmTrans*(0.76+exposure*0.34);
  let diffuse=(max(nDotL,0.0)+backlit)*(0.22+0.78*exposure*exposure);
  let ambientVisibility=0.12+exposure*0.56+abs(n.y)*0.09;
  if(leaf.a<0.015){discard;}
  let color=landFinish(world,n,albedo,diffuse,ambientVisibility,0.0,0.92);
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
  o.pos=F.viewProj*vec4f(earthCurve(position-F.camPos.xyz,F.camPos.y),1);return o;
}
// Opaque imported wood/crowns stay in the opaque visibility path. Their call
// graph has no discard or foliage texture; source RGB replaces shared green.
@fragment fn canopyOpaqueFS(in:CanopyVertex)->@location(0) vec4f{
  let dx=dpdx(in.world);let dy=dpdy(in.world);
  let footprint=max(length(dx),length(dy));
  let crown=in.kind.x>3.5;
  let exposure=clamp(in.kind.y,0.0,1.0);
  var n=normalize(in.normal);
  var col=in.colour;
  var relief=0.0;
  if(crown){
    let clump=landFilteredNoise(in.world.xz*0.42+vec2f(in.world.y*0.28),footprint*0.42);
    let subClump=landFilteredNoise(in.world.xz*1.15-vec2f(in.world.y*0.65),footprint*1.15);
    relief=(clump*0.16+subClump*0.08)*(0.45+0.55*exposure);
    col=col*(0.88+0.22*exposure+clump*0.10+subClump*0.06);
  }
  let rx=dpdx(relief);let ry=dpdy(relief);
  if(crown){n=landFilteredBump(n,dx,dy,rx,ry);}
  let nDotL=dot(n,F.sunDir.xyz);
  let diffuse=max(nDotL,0.0)+select(0.0,max(-nDotL,0.0)*0.22*exposure,crown);
  let ambient=select(.36+max(n.y,0)*.25,.14+exposure*.48+max(n.y,0)*.09,crown);
  return landFinish(in.world,n,col,diffuse,ambient,0,select(0.94,0.92,crown));
}
@fragment fn canopyLeafFS(in:CanopyVertex,@builtin(front_facing) front:bool)->@location(0) vec4f{
  let uvCentered=in.leafUV-vec2f(0.5,0.5);
  let n=normalize(in.normal*select(-1.0,1.0,front)+vec3f(uvCentered.x*0.22,uvCentered.y*0.18,0.0));
  // This borrowed alpha is an explicit approximation: the supplied GLB/native
  // streams contain no leaf image. Never replace their linear RGB with it.
  let alpha=textureSampleBias(leafSpray,landSampler,in.leafUV,.1).a;
  let exposure=clamp(in.kind.y,0,1);let nDotL=dot(n,F.sunDir.xyz);
  let backlit=max(-nDotL,0)*.50;
  let warmCol=in.colour*mix(vec3f(1.0),vec3f(1.10,1.14,0.82),backlit*exposure);
  let diffuse=(max(nDotL,0)+backlit)*(.22+.78*exposure*exposure);
  let ambient=.12+exposure*.56+abs(n.y)*.09;
  if(alpha<.015){discard;}
  let color=landFinish(in.world,n,warmCol,diffuse,ambient,0,.92);
  return vec4f(color.rgb,alpha);
}
`;

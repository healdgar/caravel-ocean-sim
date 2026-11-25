import { FRAME_WGSL, ATMO_CORE_WGSL } from './common.js';
import { SKY_RENDER_FUNCS } from './sky.js';
import { CLOUD_SHADOW_BINDINGS } from './clouds.js';
import { STREET_FIELD_RANGE_M, STREET_FIELD_EDGE_M } from '../town-streets.js';
import { LAND_CRATER_PIT } from './land-craters.js';
import { GROUND_DETAIL_RENDER } from './ground-detail.js';
import { SHADOW_FRAME, LAND_CLOTH_SHADOW } from './shadows.js';
import { CONTINUUM_CORE_WGSL } from '../continuum-core.js';

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
// A paving stone: its tone, and how well inside it this point lies, from 0 in a joint to 1 on its
// flat top. The stones are those of landStones, but every neighbour is searched, so a street shows no
// seam where two cells of the lattice disagree about the nearest stone, and a stone's edge is a narrow
// rounded arris and not a slope that runs to its middle.
fn landSetts(p:vec2f)->vec2f{
  let base=vec2i(floor(p));
  var nearest=9.0;var second=9.0;var tone=0.0;
  for(var j=-1;j<2;j++){for(var i=-1;i<2;i++){
    let cell=base+vec2i(i,j);
    let h=pcgHash(u32(cell.x)*1664525u+pcgHash(u32(cell.y)+1013904223u));
    let offset=vec2f(cell)+.5+(vec2f(f32(h&255u),f32((h>>8u)&255u))/255.0-.5)*.8-p;
    let r=sqrt(dot(offset,offset))*(.72+f32(h>>24u)/255.0*.56);
    if(r<nearest){second=nearest;nearest=r;tone=f32((h>>16u)&255u)/127.5-1.0;}else if(r<second){second=r;}
  }}
  return vec2f(tone,smoothstep(0.0,0.62,(second-nearest)*2.6));
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
  // Pitch decides, whatever the imagery says: turf slips off a slope steeper than about 35 degrees.
  let barePitch=smoothstep(.16,.34,slope+patchA*.07+patchB*.09+grain*.05+fine*.05);
  let grass=smoothstep(-.12,.3,.56+greenness*2.0+patchA*.4+patchB*.62+grain*.5+fine*.22-slope*.95)*(1.0-cliff)*saltLimit*(1.0-barePitch);
  let shrub=smoothstep(.26,.5,patchA*.7+patchB*.35+fine*.3+greenness*.3-slope*.2)*grass*.8;
  let leaf=mix(vec3f(.045,.07,.019),vec3f(.1,.14,.035),smoothstep(-.4,.4,patchB+patchA*.4+grain*.4+fine*.25));
  let soil=mix(vec3f(.13,.078,.058),vec3f(.19,.13,.07),smoothstep(-.3,.3,patchB-patchA*.4+fine*.2));
  let rockHue=mix(vec3f(.045,.022,.019),vec3f(.085,.07,.057),smoothstep(-.3,.35,patchA+grain*.5+fine*.3));
  let outcrop=max(cliff,smoothstep(.26,.46,slope+patchA*.2+grain*.12+fine*.1));
  let cover=mix(mix(soil,rockHue,outcrop),mix(leaf,vec3f(.014,.028,.01),shrub),grass);
  // Keep the imagery's ridges and gullies as light and dark within the cover.
  let shape=clamp(pow(dot(source,vec3f(.3,.59,.11))/.14,.3),.72,1.18);
  return vec4f(mix(source,cover*shape,max(mix(select(.38,.2,detailedImage),.96,hueless),barePitch*select(.92,.6,detailedImage))*exposed),grass);
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
  let an=abs(n);
  var uv=p.xz;var ddx=dx.xz;var ddy=dy.xz;
  if(an.x>an.y&&an.x>=an.z){uv=p.zy;ddx=dx.zy;ddy=dy.zy;}
  else if(an.z>an.y){uv=p.xy;ddx=dx.xy;ddy=dy.xy;}
  return landFilteredNoise(uv*frequency,landMaterialFootprint(ddx,ddy)*frequency);
}
fn landOrientedJoint(p:vec3f,n:vec3f,dx:vec3f,dy:vec3f)->f32 {
  let an=abs(n);
  var uv=p.xz;var ddx=dx.xz;var ddy=dy.xz;
  if(an.x>an.y&&an.x>=an.z){uv=p.zy;ddx=dx.zy;ddy=dy.zy;}
  else if(an.z>an.y){uv=p.xy;ddx=dx.xy;ddy=dy.xy;}
  return landFilteredFissure(uv*1.35,landMaterialFootprint(ddx,ddy)*1.35,.025,.11);
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
  // Shelter fades in with depth. Deep water is stored as open sea, and the two must meet without an edge.
  let rawTransmit=mix(1.0,shelter.x,inside*smoothstep(-58.0,-24.0,bed));
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
    let shoalIn=(1.0-smoothstep(5.0,18.0,h));
    let boreSust=mix(0.24,1.0,smoothstep(0.06,breakDepth,h))*(1.0-smoothstep(-0.04,0.65,bedNear));
    let groupEnv=0.78+0.22*sin(psi*0.27-F.camPos.w*0.22+gnoise(p*0.0035)*1.4);
    let waveAmp=clamp(0.54*hsTotal,0.0,1.25)*seawardExposure*beachFactor*shoalIn*boreSust*groupEnv;
    // Bottom-drag asymmetry: trough slows on the seabed while the crest overtakes it and pitches forward (+propDir).
    let skewAlpha=mix(0.22,0.78,(1.0-smoothstep(1.4,11.0,h)));
    let cnoidalGamma=mix(0.10,0.38,(1.0-smoothstep(1.4,11.0,h)));
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
    let pitchFactor=(1.0-smoothstep(1.2,10.0,h))*(1.0-smoothstep(-0.08,0.55,bedNear));
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
// The colour coming up through the water. Reflections, sun glitter and foam lie on top of it, so the
// waves stay visible right up to the beach. Deep water (height never approaches -58 m) is left as it is.
fn coastalBody(body:vec3f,bed:f32)->vec3f{
  if(bed<=-58.0){return body;}
  // Deep blue gives way with depth. Over clear tropical sand it runs through turquoise to pale
  // aqua, as the sand starts to show through. Elsewhere shallows only turn a dull grey-green.
  let clarity=coastalWindow.w;
  let light=(sunIlluminance()*max(F.sunDir.y,0.0)+lunarIlluminance()*max(lunarDirection().y,0.0))/PI+skyAtmo(vec3f(0,1,0));
  let shelf=smoothstep(-30.0,-7.0,bed);
  let sand=smoothstep(-8.0,-0.6,bed);
  var col=mix(body,vec3f(0.014,0.150,0.205)*light,shelf*0.82*clarity);
  col=mix(col,vec3f(0.085,0.300,0.285)*light,sand*0.42*clarity);
  return mix(col,vec3f(0.030,0.082,0.072)*light,smoothstep(-12.0,-1.0,bed)*0.45*(1.0-clarity));
}
fn coastalSwash(color:vec3f,p:vec2f,bed:f32,height:f32,foamLight:vec3f)->vec3f{
  if(bed<=-58.0){return color;}
  let depth=height-bed;
  let swashRim=(1.0-smoothstep(0.02,0.32,abs(depth)))*smoothstep(-0.20,0.35,height)*(0.45+0.55*gnoise(p*0.22));
  return mix(color,foamLight,swashRim*0.42);
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
` + LAND_SAMPLING + SKY_RENDER_FUNCS + /* wgsl */ `
fn skyBodyVisibility(p:vec2f,h:f32,dir:vec3f)->f32{
  // Pure mountain terrain-on-terrain horizon shadow; live 2D cloud shadows are sampled per-fragment from cloudShadowMap.
  var v=1.0;
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
  // Multiscale valley/ridge cavity AO stored in .b for zero-extra-fetch ravine darkening & crest relief.
  let hAvg1=0.25*(landHeight(p+vec2f(45.0,0.0))+landHeight(p-vec2f(45.0,0.0))+landHeight(p+vec2f(0.0,45.0))+landHeight(p-vec2f(0.0,45.0)));
  let hAvg2=0.25*(landHeight(p+vec2f(120.0,0.0))+landHeight(p-vec2f(120.0,0.0))+landHeight(p+vec2f(0.0,120.0))+landHeight(p-vec2f(0.0,120.0)));
  let cavity=clamp((h-hAvg1)*0.055+(h-hAvg2)*0.024,-0.45,0.35);
  textureStore(lightOut,vec2i(id.xy),vec4f(visibility,moonVisibility,cavity,1.0));
}
`;

// Shared lighting, atmosphere, cloud and land-shadow finish used by land, city and forest continuum pipelines
// without forcing forest shaders to compile unused terrain/building/Neural-PBR code.
export const TERRAIN_FINISH_ONLY = FRAME_WGSL + ATMO_CORE_WGSL + SHADOW_FRAME + CONTINUUM_CORE_WGSL + /* wgsl */ `
@group(0) @binding(0) var<uniform> F:Frame;
@group(0) @binding(1) var transLUT:texture_2d<f32>;
@group(0) @binding(2) var skyLUT:texture_2d<f32>;
@group(0) @binding(3) var sampC:sampler;
@group(0) @binding(4) var envCube:texture_cube<f32>;
@group(0) @binding(5) var landLight:texture_2d<f32>;
@group(0) @binding(6) var<uniform> LAND:Land;
struct Land {domain:vec4f};
@group(0) @binding(19) var<uniform> landSH:ShadowFrame;
@group(0) @binding(20) var landSolidShadow:texture_depth_2d;
@group(0) @binding(21) var landShadowCompare:sampler_comparison;
` + LAND_CLOTH_SHADOW + SKY_RENDER_FUNCS + CLOUD_SHADOW_BINDINGS + /* wgsl */ `
// How far inside the shadow map a place lies: 0 at its edge and beyond, 1 well within. Reads no texture.
fn landShadowCover(p:vec4f)->f32{
  let uv=p.xy*vec2f(0.5,-0.5)+0.5;
  let edge=min(min(uv.x,1.0-uv.x),min(uv.y,1.0-uv.y));
  return smoothstep(0.0,0.06,edge)*step(0.0,p.z)*step(p.z,1.0);
}
fn landShadowCoverage(world:vec3f)->f32{
  if(landSH.origin.w<0.5){return 0.0;}
  return landShadowCover(landSH.lightView*vec4f(world-landSH.origin.xyz,1.0));
}
// The light is the sun by day and the moon once it takes over (F.celestial.w), and the map is drawn from
// whichever it is. Callers pass the result through solarShadowVisibility and lunarShadowVisibility. What
// canvas stands between colours it (LAND_CLOTH_SHADOW).
fn landShadowVisibility(world:vec3f,normal:vec3f)->vec3f{
  if(landSH.origin.w<0.5){return vec3f(1.0);}
  let facing=select(-1.0,1.0,dot(normal,landSH.sun.xyz)>=0.0);
  let offset=normal*facing*0.032+landSH.sun.xyz*0.025;
  let p=landSH.lightView*vec4f(world-landSH.origin.xyz+offset,1.0);
  let uv=p.xy*vec2f(0.5,-0.5)+0.5;
  let fade=landShadowCover(p);
  if(fade<=0.0){return vec3f(1.0);}
  // Eight centimetres along the ray, whatever depth the box was fitted to.
  let refZ=min(p.z-0.08/max(landSH.sun.w,1.0),0.99999);
  let cloth=landClothShadow(uv,refZ);
  let camDelta=world-F.camPos.xyz;
  // Far ground takes one filtered tap and near ground four. The change is scattered over a band of
  // distance, pixel by pixel, so it never draws a ring on the ground.
  let scatter=fract(52.9829189*fract(dot(floor(world.xz*6.0),vec2f(0.06711056,0.00583715))));
  if(dot(camDelta,camDelta)>mix(4225.0,7225.0,scatter)){
    let s1=textureSampleCompareLevel(landSolidShadow,landShadowCompare,uv,refZ);
    return mix(vec3f(1.0),s1*cloth,fade);
  }
  let dim=vec2f(textureDimensions(landSolidShadow));
  let texel=0.65/max(dim,vec2f(1.0));
  var sum=0.0;
  sum+=textureSampleCompareLevel(landSolidShadow,landShadowCompare,uv+vec2f(-texel.x,-texel.y),refZ)*0.25;
  sum+=textureSampleCompareLevel(landSolidShadow,landShadowCompare,uv+vec2f(texel.x,-texel.y),refZ)*0.25;
  sum+=textureSampleCompareLevel(landSolidShadow,landShadowCompare,uv+vec2f(-texel.x,texel.y),refZ)*0.25;
  sum+=textureSampleCompareLevel(landSolidShadow,landShadowCompare,uv+vec2f(texel.x,texel.y),refZ)*0.25;
  return mix(vec3f(1.0),sum*cloth,fade);
}
struct LandVertex {
  @builtin(position) pos:vec4f,
  @location(0) world:vec3f,
  @location(1) normal:vec3f,
  @location(2) kind:vec2f,
  @location(3) leafUV:vec2f,
};
// What a crater does to ground it lies on. Plain ground has no cover to mix, so it never reads the rest.
struct LandPit{normal:vec3f,cover:f32,soil:vec3f,relief:f32,sun:f32,sky:f32,pool:f32,damp:f32,sand:f32};
// The opaque call graph contains neither discard nor a leaf texture fetch.
// Keep that property for Apple's hidden-surface removal; a runtime branch in
// one shared cutout fragment would still make solid ground a feedback shader.
// How much a surface's normal turns within one pixel. A mirror finish cannot show that detail, only
// strobe on whichever facet happens to catch the sun, so that spread widens the highlight instead
// (Kaplanyan and Tokuyoshi's geometric specular antialiasing). Set where a normal has its relief.
var<private> landNormalSpread:f32=0.0;
var<private> landWindowEmission:vec3f=vec3f(0.0);
// Realistic nocturnal household candle schedule shared across all city & port buildings:
//   - Only a sparse minority of windows light up at dusk (~26%), never whole facades at once
//   - Households progressively snuff candles as evening deepens into night (~26% -> ~4% at midnight)
//   - Early risers / bakers relight a modest scattering (~14%) shortly before dawn, then snuff at sunrise
//   - Per-window seed staggers turn-on and bedtime smoothly with zero hard pops when scrubbing time.
fn landNightWindowFactor(sunDir:vec3f,winSeed:f32)->f32{
  let darkEnv=1.0-smoothstep(-0.02,0.09,sunDir.y);
  if(darkEnv<=0.001){return 0.0;}
  // sunDir.x < 0 is west (evening/dusk), sunDir.x > 0 is east (pre-dawn); smooth blend across solar midnight.
  let isDawn=smoothstep(-0.18,0.18,sunDir.x);
  let eveDepth=smoothstep(-0.03,-0.46,sunDir.y);
  let eveFrac=mix(0.27,0.04,eveDepth);
  let dawnDepth=smoothstep(-0.02,-0.32,sunDir.y);
  let dawnFrac=mix(0.15,0.04,dawnDepth);
  let activeFrac=mix(eveFrac,dawnFrac,isDawn);
  let lit=1.0-smoothstep(activeFrac-0.025,activeFrac+0.015,winSeed);
  return darkEnv*lit;
}
fn landFinishShadowed(world:vec3f,n:vec3f,albedo:vec3f,diffuse:f32,ambientVisibility:f32,wet:f32,roughness:f32,shadowVis:vec3f)->vec4f{
  let uv=(world.xz-LAND.domain.xy)/LAND.domain.z+0.5;
  let edgeDist=min(min(uv.x,1.0-uv.x),min(uv.y,1.0-uv.y));
  let isPrimary=select(0.0,1.0,LAND.domain.w>0.05);
  let inPrimaryDomain=isPrimary*smoothstep(0.0,0.08,edgeDist);
  let bakedLight=textureSampleLevel(landLight,sampC,clamp(uv,vec2f(0.0),vec2f(1.0)),0.0).rgb;
  // Crisp real-time 2D cloud shadows everywhere paired with baked mountain horizon occlusion.
  let cloudSun=solarShadowVisibility(vec3f(cloudShadowAt(world*0.001,F.sunDir.xyz))).x;
  let sunlight=mix(1.0,bakedLight.r,inPrimaryDomain)*cloudSun;
  let valleyAO=clamp(1.0+bakedLight.b*inPrimaryDomain*0.48,0.70,1.14);
  let effAmbVis=ambientVisibility*valleyAO;
  // By day the map shades the sun; once the moon is the light it shades the moon and the sun is down.
  let direct=sunIlluminance()*sunlight*solarShadowVisibility(shadowVis);
  // Directional sky-hemisphere + ground/sea bounce irradiance from envCube
  let skyDir=normalize(vec3f(n.x*0.65,max(n.y,0.12),n.z*0.65));
  let skyIrr=textureSampleLevel(envCube,sampC,skyDir,6.0).rgb;
  let bounceDir=normalize(vec3f(n.x*0.5,-0.55,n.z*0.5));
  let groundIrr=textureSampleLevel(envCube,sampC,bounceDir,6.5).rgb*vec3f(0.88,0.80,0.68);
  let hemiMix=clamp(n.y*0.5+0.5,0.0,1.0);
  let ambient=mix(groundIrr*0.54,skyIrr,hemiMix);
  // Architectural cavity & eave self-shadowing + warm solar ground-bounce GI
  let archShadow=smoothstep(0.14,0.58,effAmbVis);
  let sunGroundBounce=direct*max(F.sunDir.y,0.0)*(1.0-max(n.y,0.0))*0.068*vec3f(0.84,0.74,0.58)*effAmbVis;
  let diffuseTerm=direct*diffuse*(0.30+0.70*archShadow)/PI+ambient*effAmbVis+sunGroundBounce;
  let isMetal=wet<-0.01;
  let effWet=select(wet,0.0,isMetal);
  var col=albedo*(1.0-effWet*0.32)*diffuseTerm;
  // Physical GGX microfacet specular + roughness-mipmapped envCube reflections
  let v=normalize(F.camPos.xyz-world);
  let hRaw=v+F.sunDir.xyz;
  let h=select(vec3f(0.0,1.0,0.0),normalize(hRaw),length(hRaw)>1e-5);
  let nDotV=clamp(dot(n,v),1e-4,1.0);
  let nDotL=max(dot(n,F.sunDir.xyz),0.0);
  let nDotH=max(dot(n,h),0.0);
  let vDotH=clamp(dot(v,h),0.0,1.0);
  let effRough=clamp(mix(roughness,min(roughness,0.12),effWet*0.80),0.06,0.98);
  let smoothFilm=select(clamp((0.46-effRough)/0.34,0.0,1.0)*effWet,1.0,isMetal);
  let f0=select(mix(0.038,0.058,effWet),clamp(-wet,0.18,0.56),isMetal);
  let maxF=select(mix(f0,0.75,smoothFilm),max(1.0-effRough*0.55,f0),isMetal);
  let fresnel=f0+(maxF-f0)*pow(clamp(1.0-nDotV,0.0,1.0),5.0);
  let fresnelSun=f0+(maxF-f0)*pow(clamp(1.0-vDotH,0.0,1.0),5.0);
  let a=effRough*effRough;
  let a2=clamp(a*a+landNormalSpread,1e-4,1.0);
  let denom=nDotH*nDotH*(a2-1.0)+1.0;
  let D=a2/(PI*denom*denom);
  let k=(effRough+1.0)*(effRough+1.0)*0.125;
  let G=(nDotV/(nDotV*(1.0-k)+k))*(nDotL/(nDotL*(1.0-k)+k));
  let specBRDF=(D*G*fresnelSun)/max(4.0*nDotV,1e-3);
  let reflStrength=fresnel*smoothFilm*(1.0-effRough*0.78)*(0.26+0.74*effAmbVis);
  var skyRefl=vec3f(0.0);
  if(reflStrength>0.001){
    var reflDir=reflect(-v,n);
    reflDir.y=max(reflDir.y,-0.12);
    let envMip=clamp(effRough*7.0,0.4,7.0);
    skyRefl=textureSampleLevel(envCube,sampC,normalize(reflDir),envMip).rgb*reflStrength;
  }
  let specMask=select(clamp((0.72-effRough)/0.42,0.0,1.0)*(0.08+0.92*effWet),0.65,isMetal);
  col+=direct*min(specBRDF,1.5)*specMask*(0.25+0.75*archShadow)+skyRefl;
  let cloudMoon=lunarShadowVisibility(vec3f(cloudShadowAt(world*0.001,lunarDirection()))).x;
  col+=lunarSurface(n,v,albedo*(1.0-effWet*.32),effRough,vec3f(f0),vec3f(mix(1.0,bakedLight.g,inPrimaryDomain)*cloudMoon)*lunarShadowVisibility(shadowVis));
  col+=lightningSurface(n,v,albedo,effRough)+worldFireSurface(world,n,v,albedo,effRough)+landWindowEmission;
  col=surfaceAir(col,world);
  // Clip cloud integration at high mountain surfaces: high peaks entering the cloud deck get veiled
  // directly from the 2D cloud shadow/optical-depth map (zero 3D texture reads).
  let cloudBaseM=CF.shape.x*1000.0;
  let mountainVeil=smoothstep(max(320.0,cloudBaseM-260.0),max(580.0,cloudBaseM+320.0),world.y)*step(0.5,CF.screen.w);
  if(mountainVeil>0.001){
    let mSh=textureSampleLevel(cloudShadowMap,cloudShadowSampler,(world.xz*0.001+CF.advection.xy)/16.0+0.5,0.0).rg;
    let veilAlpha=clamp(1.0-mSh.r,0.0,0.82)*mountainVeil;
    let veilCol=skyAtmo(vec3f(0,1,0))*0.45+sunIlluminance()*0.20*mSh.r;
    return vec4f(mix(col,veilCol,veilAlpha),1.0);
  }
  return vec4f(col,1.0);
}
fn landFinish(world:vec3f,n:vec3f,albedo:vec3f,diffuse:f32,ambientVisibility:f32,wet:f32,roughness:f32)->vec4f{
  return landFinishShadowed(world,n,albedo,diffuse,ambientVisibility,wet,roughness,landShadowVisibility(world,n));
}
`;

// Hardware 2D-array texture path for TERRAIN_CITY: replaces 12-20 uncached storage reads per building pixel
// with 1-2 hardware trilinear+anisotropic fetches (city uses only 9 sampled textures out of WebGPU's 16 ceiling).
const ARCH_MATERIAL_TEX_SAMPLERS = /* wgsl */ `
@group(0) @binding(17) var archMaterialSampler:sampler;
@group(0) @binding(18) var archMaterialTex:texture_2d_array<f32>;
fn sampleArchLayerGrad(layer:i32,uv:vec2f,ddx:vec2f,ddy:vec2f)->vec4f{
  return textureSampleGrad(archMaterialTex,archMaterialSampler,uv,max(layer,0),ddx,ddy);
}
fn sampleArchNormalMip(layer:i32,uv:vec2f,ddx:vec2f,ddy:vec2f)->vec4f{
  return textureSampleGrad(archMaterialTex,archMaterialSampler,uv,max(layer,0),ddx,ddy);
}
`;

const ARCH_MATERIAL_PBR_FN = /* wgsl */ `
struct ArchPBR{albedo:vec3f,normalOffset:vec3f,roughness:f32,ao:f32};
fn sampleArchMaterialPBR(matIdx:i32,world:vec3f,n:vec3f,dx:vec3f,dy:vec3f,scale:vec2f,lodFade:f32,instYaw:f32,grain:f32)->ArchPBR{
  let evenLayer=matIdx*2;
  let oddLayer=evenLayer+1;
  let relP=world-vec3f(LAND.domain.x,0.0,LAND.domain.y);
  let horizN=length(n.xz);
  let wantNormal=lodFade>0.005;
  // Sloped roofs (terracotta barrel tiles matIdx==3 & palm thatch matIdx==5):
  // Project UVs directly onto the roof slope's horizontal eave tangent (tileTan) and down-slope fall-line (slopeT)
  // so barrel tile flutes and thatch courses run straight down every roof slope from ridge to eave.
  let tileTan=select(vec3f(1.0,0.0,0.0),vec3f(-n.z,0.0,n.x)/max(horizN,1e-4),horizN>0.08);
  let isSlopedRoof=(matIdx==3||matIdx==5)&&abs(n.y)>0.15&&abs(n.y)<0.96&&horizN>0.08;
  let cY=cos(instYaw);
  let sY=sin(instYaw);
  let bP=vec3f(relP.x*cY-relP.z*sY,world.y,relP.x*sY+relP.z*cY);
  let bN=vec3f(n.x*cY-n.z*sY,n.y,n.x*sY+n.z*cY);
  let bDx=vec3f(dx.x*cY-dx.z*sY,dx.y,dx.x*sY+dx.z*cY);
  let bDy=vec3f(dy.x*cY-dy.z*sY,dy.y,dy.x*sY+dy.z*cY);
  let isTop=abs(bN.y)>0.88;
  let isWallX=abs(bN.x)>=abs(bN.z);
  var uv=vec2f(bP.x,-bP.y)*scale;
  var ddx=vec2f(bDx.x,-bDx.y)*scale;
  var ddy=vec2f(bDy.x,-bDy.y)*scale;
  if(isSlopedRoof){
    let slopeT=normalize(cross(tileTan,n));
    uv=vec2f(dot(relP,tileTan),dot(relP,slopeT))*scale;
    ddx=vec2f(dot(dx,tileTan),dot(dx,slopeT))*scale;
    ddy=vec2f(dot(dy,tileTan),dot(dy,slopeT))*scale;
  }else if(isTop){
    uv=vec2f(bP.x,bP.z)*scale;ddx=vec2f(bDx.x,bDx.z)*scale;ddy=vec2f(bDy.x,bDy.z)*scale;
  }else if(isWallX){
    uv=vec2f(bP.z,-bP.y)*scale;ddx=vec2f(bDx.z,-bDx.y)*scale;ddy=vec2f(bDy.z,-bDy.y)*scale;
  }
  // The planks of the timber texture lie along u. A post's grain is upright, and a beam's runs its length: where
  // the member is known to run the other way of this face (grain: 1 upright, 2 across the plot, 3 along it), the
  // texture is laid the other way.
  let turned=!isSlopedRoof&&((grain>0.5&&grain<1.5&&!isTop)||(grain>2.5&&isTop));
  if(turned){uv=uv.yx;ddx=ddx.yx;ddy=ddy.yx;}
  let bS=sampleArchLayerGrad(evenLayer,uv,ddx,ddy);
  let albedo=pow(max(bS.rgb,vec3f(0.01)),vec3f(2.2));
  if(!wantNormal){return ArchPBR(albedo,vec3f(0.0),bS.a,1.0);}
  let nS=sampleArchNormalMip(oddLayer,uv,ddx,ddy);
  var tn=nS.rgb*2.0-1.0;
  // Architectural PBR normal maps use OpenGL +Y=up (-v); swapping u<->v negates both swapped axes.
  if(turned){tn=vec3f(-tn.y,-tn.x,tn.z);}
  let ao=mix(1.0,nS.a,lodFade);
  var normalOffset=vec3f(0.0);
  if(isSlopedRoof){
    let slopeT=normalize(cross(tileTan,n));
    normalOffset=(tileTan*tn.x-slopeT*tn.y)*lodFade;
  }else{
    var localNOff=vec3f(tn.x,tn.y,0.0);
    if(isTop){localNOff=vec3f(tn.x,0.0,-tn.y);}
    else if(isWallX){localNOff=vec3f(0.0,tn.y,tn.x);}
    localNOff*=lodFade;
    normalOffset=vec3f(localNOff.x*cY+localNOff.z*sY,localNOff.y,-localNOff.x*sY+localNOff.z*cY);
  }
  return ArchPBR(albedo,normalOffset,bS.a,ao);
}
// A roof's shade and its age, the same for a building's continuum (js/wgsl/city-continuum.js) and its pieces.
fn cityRoofShade(root:vec4f,tone:f32)->f32{return 0.62+0.38*fract(tone*7.31+root.x*0.137+root.z*0.071);}
fn cityRoofAge(root:vec4f,tone:f32)->f32{return fract(tone*3.17+root.x*0.071+root.z*0.113);}
`;

const CITY_ORIENTED_DETAIL = /* wgsl */ `
fn landOrientedDetail(p:vec3f,n:vec3f,dx:vec3f,dy:vec3f,frequency:f32)->f32 {
  let an=abs(n);
  var uv=p.xz;var ddx=dx.xz;var ddy=dy.xz;
  if(an.x>an.y&&an.x>=an.z){uv=p.zy;ddx=dx.zy;ddy=dy.zy;}
  else if(an.z>an.y){uv=p.xy;ddx=dx.xy;ddy=dy.xy;}
  return landFilteredNoise(uv*frequency,landMaterialFootprint(ddx,ddy)*frequency);
}
fn landOrientedJoint(p:vec3f,n:vec3f,dx:vec3f,dy:vec3f)->f32 {
  let an=abs(n);
  var uv=p.xz;var ddx=dx.xz;var ddy=dy.xz;
  if(an.x>an.y&&an.x>=an.z){uv=p.zy;ddx=dx.zy;ddy=dy.zy;}
  else if(an.z>an.y){uv=p.xy;ddx=dx.xy;ddy=dy.xy;}
  return landFilteredFissure(uv*1.35,landMaterialFootprint(ddx,ddy)*1.35,.025,.11);
}
`;

// Extracted reusable surface blocks so TERRAIN_LAND and TERRAIN_CITY share 100% identical
// material math without forcing Apple Metal to compile and register-spill unused terrain/city branches.
const TERRAIN_LAND_MATERIAL_BLOCK = /* wgsl */ `
    let crownW1=footprint*0.105;let crownW2=footprint*0.046;
    let crownN1=landFilteredNoise(world.xz*0.105+vec2f(grain*0.75,-grain*0.55),crownW1);
    let crownN2=landFilteredNoise(world.xz*0.046+vec2f(-grain*0.45,grain*0.65),crownW2);
    gd=groundDetailAt(world,dx,dy,vec2f(grain,crownN2),vec2f(crownN2,crownN1));
    let breakup=gd.big.a*.8+gd.mid.a*.55+gd.fine.r*.22+gd.mid.r*.18;
    let rocky=groundDetailEdge(rocky,breakup,gd.near);
    let canopyWeight=smoothstep(0.14,0.62,vegetation)*(1.0-rocky*0.85);
    // The crowns painted on far forest give way to the floor beneath them, where the real trees stand.
    let crownKeep=1.0-gd.near;
    // Bare slopes below about 60 degrees rest as loose stone; only steeper faces show bedding.
    let cliff=groundDetailEdge(smoothstep(.40,.62,1.0-n.y+grain*.05),breakup,gd.near);
    let screeWeight=groundDetailEdge(smoothstep(.10,.30,1.0-n.y+grain*.07),breakup,gd.near)*(1.0-canopyWeight)*(1.0-cliff*.55);
    // Up close the detail texture has the stones, so this search, the dearest thing on the land, need not run.
    let screeFarFade=1.0-smoothstep(0.35,0.85,footprint);
    var scree=vec3f(0.0,1.0,0.0);
    if(screeWeight*screeFarFade>.01&&gd.near<1.0){let st=(1.0-gd.near)*screeFarFade;scree=vec3f(crownN1*st,mix(1.0,0.5+0.5*crownN2,st),0.18);}
    // Sand meeting grass ends blade by blade. Sand over bare earth just thins out, as drifted sand does.
    let sandEdge=groundDetailEdge(select(0.0,clamp((in.kind.y-0.02)/0.98,0.0,1.0),in.kind.x<0.5&&in.kind.y>0.015),gd.big.a*1.4+gd.mid.r*.2+gd.fine.r*.3,gd.near);
    let coastSand=mix(select(0.0,clamp((in.kind.y-0.02)/0.98,0.0,1.0),in.kind.x<0.5&&in.kind.y>0.015),sandEdge,smoothstep(.05,.2,(source.g-max(source.r,source.b))/max(source.g,.02)));
    var sandWet=0.0;
    let groundCover=landGroundCover(source,1.0-n.y,cliff,crownN1,crownN2,grain,scree.x,world.y,(1.0-canopyWeight)*(1.0-coastSand),nearGround);
    source=groundCover.rgb;
    // Single stones dissolve with distance into tone, so far slopes never read as masonry.
    let screeNear=1.0-smoothstep(.04,.45,footprint);
    let screeMottle=crownN1*.2+crownN2*.3;
    // Grass hides most stones, leaving the mottling and only the palest as scattered rocks.
    let screeTone=screeWeight*(screeMottle*.5+(scree.x*mix(.1,.26,screeNear)-(1.0-scree.y)*mix(.03,.3,screeNear))*(1.0-groundCover.a*.65));
    let screeRelief=screeWeight*(scree.y-.5)*scree.z*mix(.06,.3,screeNear);
    // Ground and cliff projections keep metre-scale stone legible on slopes.
    // Two-dimensional analytic noise only; no 3D noise octave loop. Crowns and
    // bark never execute these ground-material evaluations.
    let isProceduralCoast=in.kind.x<0.5&&in.kind.y>0.015;
    let beachSand=coastSand;
    let rockKeep=1.0-beachSand*0.94;
    let effCanopy=canopyWeight*(1.0-beachSand);
    let blockWidth=materialWidth*.19;let blockWeight=landDetailWeight(blockWidth);
    // Within the detail's reach its fetches stand in for these noises, which pays for them.
    var blockNoise=gd.big.a*2.5;
    var stoneRaw=gd.big.a*1.2+gd.mid.a*1.2;
    var pores=gd.fine.a*1.5+gd.mid.g*.8;
    var fissure=0.0;
    if(gd.near<1.0){
      let far=1.0-gd.near;
      blockNoise+=crownN1*materialSeam*far;
      stoneRaw+=landFilteredNoise(materialUV*.82,materialWidth*.82)*materialSeam*far;
      pores+=stoneRaw*0.5;
      fissure=(1.0-smoothstep(.025,.11,abs(stoneRaw)))*landDetailWeight(materialWidth*1.7/.085)*rockKeep*materialSeam*far;
    }
    let blocks=blockNoise*blockWeight*rockKeep;
    let stone=stoneRaw*rockKeep;
    // Reuse the raw block noise, not its faded value, without another noise call.
    let coarseFissure=(1.0-smoothstep(.025,.09,abs(blockNoise)))*landDetailWeight(blockWidth/.065)*rockKeep*materialSeam*(1.0-gd.near);
    var baseSource=source;
    var swashGloss=0.0;
    var waterFilm=0.0;
    var cliffStrata=0.0;
    var ledgeStep=0.0;
    var cragFacet=0.0;
    let basalWetRock=rocky*rockKeep*(1.0-smoothstep(0.15,2.15,world.y));
    if(isProceduralCoast){
      // The tide's marks wander with the sand's own grain up close.
      let coastY=world.y+gd.big.a*.35;
      let gentle=(1.0-smoothstep(0.08,0.32,1.0-n.y));
      let cuspWave=sin(world.x*0.042-world.z*0.031+blockNoise*1.5)*0.22;
      let swashRunup=0.26+0.28*sin(F.camPos.w*1.12+world.x*0.038+world.z*0.032+stoneRaw*1.2)+cuspWave;
      let dryZone=smoothstep(-0.35,0.65,coastY)*(1.0-smoothstep(1.85,3.25+stoneRaw*0.45,coastY))*gentle*beachSand;
      waterFilm=smoothstep(-0.95,-0.15,coastY)*(1.0-smoothstep(swashRunup-0.12,swashRunup+0.22,coastY))*gentle*beachSand;
      let capillaryZone=smoothstep(-0.85,-0.05,coastY)*(1.0-smoothstep(swashRunup+0.12,swashRunup+1.15+stoneRaw*0.22,coastY))*gentle*beachSand;
      let wrackD=(coastY-(1.12+cuspWave*0.55+stoneRaw*0.20))/0.14;
      let wrack=exp(-(wrackD*wrackD))*gentle*beachSand;
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
      sandWet=max(capillaryZone,waterFilm);
    }
    let isRiverBank=in.kind.x>1.5&&in.kind.x<2.5;
    if(isRiverBank){
      let bankWet=clamp(in.kind.y,0.0,1.0);
      let bankLoam=vec3f(0.19,0.15,0.105)*(1.0+stoneRaw*0.09+pores*0.04);
      let bedShingle=vec3f(0.135,0.125,0.108)*(1.0+stoneRaw*0.18+pores*0.08);
      let loamMix=smoothstep(0.10,0.58,bankWet);
      let bedMix=smoothstep(0.55,0.92,bankWet);
      baseSource=mix(baseSource,bankLoam,loamMix*0.86);
      baseSource=mix(baseSource,bedShingle,bedMix*0.88);
      swashGloss=max(swashGloss,smoothstep(0.32,0.88,bankWet)*0.78);
      waterFilm=max(waterFilm,smoothstep(0.60,0.95,bankWet)*0.65);
      sandWet=max(sandWet,smoothstep(0.30,0.90,bankWet));
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
    let crownBillow=(abs(crownN1)*0.68+crownN2*0.32)*effCanopy*crownKeep;
    let crownGap=clamp(0.40-abs(crownN1),0.0,0.40)*landDetailWeight(crownW1)*effCanopy*crownKeep;
    let canopyTone=mix(vec3f(1.0),vec3f(1.0+crownN2*0.09,1.0+crownBillow*0.14,1.0-crownN2*0.06),effCanopy);
    albedo=baseSource*rockTone*canopyTone*(1.0+screeTone*rockKeep+blocks*.15+stone*0.11+cliffStrata*0.075+ledgeStep*0.06+cragFacet*0.05+pores*(0.055-beachSand*0.025)+sandRipple+crownBillow*0.20-crownGap*0.42-(fissure*.085+coarseFissure*.095)*rocky)*(1.0-basalWetRock*0.34);
    let soil=stone*(0.025+vegetation*0.012)+pores*(0.006+vegetation*0.006)+sandRipple*0.42+crownBillow*0.42-crownGap*0.32;
    let rockRelief=stone*0.15+blocks*.24+cliffStrata*0.048+ledgeStep*0.042+cragFacet*0.035-fissure*0.075-coarseFissure*.11;
    relief=screeRelief*rockKeep+mix(soil,rockRelief,rocky*rockKeep);
    // Item 3: Valley/ridge macro cavity tone + soft multi-scale organic pasture/turf mottling on open lowlands (no zero-crossing contour rings).
    let macroCav=textureSampleLevel(landLight,sampC,clamp(uv,vec2f(0.0),vec2f(1.0)),0.0).b*select(0.0,1.0,LAND.domain.w>0.05);
    let valleyT=clamp(-macroCav*1.65,0.0,0.52)*(1.0-beachSand);
    let ridgeT=clamp(macroCav*1.45,0.0,0.42)*(1.0-beachSand);
    albedo*=mix(vec3f(1.0),vec3f(0.84,0.87,0.80),valleyT)*mix(vec3f(1.0),vec3f(1.08,1.05,0.96),ridgeT);
    let turfFoot=footprint*0.018;
    let turfFade=landDetailWeight(turfFoot)*(1.0-rocky)*(1.0-beachSand)*(1.0-effCanopy*0.68)*smoothstep(2.2,8.5,world.y);
    if(turfFade>0.01){
      let mBroad=landFilteredNoise(world.xz*0.014+vec2f(11.3,-7.9),footprint*0.014);
      let mMid=landFilteredNoise(vec2f(world.x*0.031-world.z*0.024,world.x*0.024+world.z*0.031)+vec2f(crownN2,crownN1)*0.65,footprint*0.039);
      let mTuft=landFilteredNoise(vec2f(world.x*0.24+world.z*0.17,-world.x*0.17+world.z*0.24)+vec2f(-19.3,14.7),footprint*0.30);
      let mottle=clamp(0.5+0.34*mBroad+0.24*mMid,0.0,1.0);
      let pastureMask=clamp(groundCover.a,0.0,1.0);
      let lushPasture=mix(albedo*vec3f(0.86,1.04,0.84),vec3f(0.062,0.126,0.038),pastureMask*0.34);
      let olivePasture=mix(albedo*vec3f(1.02,1.03,0.84),vec3f(0.104,0.130,0.048),pastureMask*0.28);
      let turfCol=mix(lushPasture,olivePasture,smoothstep(0.22,0.82,mottle))*(1.0+mTuft*0.18*pastureMask);
      albedo=mix(albedo,turfCol,turfFade*mix(0.32,0.48,pastureMask));
      relief+=((mottle-0.5)*0.006+mTuft*0.009*pastureMask)*turfFade;
    }
    // Item 4: Canopy-floor contact AO under dense forests beyond the real-time shadow-map range (260 m).
    let farCanopyAO=effCanopy*(1.0-landShadowCoverage(world));
    albedo*=1.0-farCanopyAO*0.24;
    ambientVisibility*=(1.0-crownGap*0.38)*(1.0-(fissure*0.22+coarseFissure*0.25)*rocky)*(1.0-farCanopyAO*0.44);
    surfaceWet=max(swashGloss,basalWetRock*0.75);
    let baseRough=mix(0.89+vegetation*0.03-effCanopy*0.05+pores*0.055-rocky*0.09,0.76+pores*0.03,beachSand);
    roughness=clamp(mix(baseRough,mix(0.20,0.07,waterFilm),surfaceWet),0.07,0.98);
    canopyBackscatter=effCanopy*0.18;
    if(gd.near>0.0){
      let look=groundDetailLook(gd,albedo,world,n,dx,dy,groundCover.a,coastSand,rocky,cliff,screeWeight,canopyWeight,sandWet);
      albedo=look.albedo;
      // Wet ground is glossy, and a bumped normal on it is exactly what makes sun glints flash. It stays smooth.
      relief+=look.relief*(1.0-smoothstep(.12,.45,max(surfaceWet,(1.0-smoothstep(.35,2.2,world.y))*.45)));
    }
    let windMask=clamp(groundCover.a,0.0,1.0)*(1.0-effCanopy)*(1.0-rocky)*(1.0-beachSand)*select(1.0,0.0,isRiverBank);
    let waveWeight=windMask*landDetailWeight(footprint/26.0)*(1.0-smoothstep(1400.0,2350.0,distance(world,F.camPos.xyz)));
    if(waveWeight>0.01){
      let wv=grassWindWave(world.xz,F.camPos.w,F.windP[0]);
      let crest=smoothstep(-0.35,0.75,wv.y);
      albedo*=mix(vec3f(1.0),mix(vec3f(0.90,0.94,0.88),vec3f(1.14,1.15,1.00),crest),waveWeight*0.72);
      relief+=wv.y*0.018*waveWeight;
      roughness=clamp(mix(roughness,0.58,max(0.0,wv.y)*waveWeight*0.35),0.07,0.98);
    }
`;

const TERRAIN_CITY_MATERIAL_BLOCK = /* wgsl */ `
  if(in.kind.x>=19.5){
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
    let instYaw=clamp((fract(in.kind.x)-0.02)/0.46,0.0,1.0)*PI;
    let camDist=distance(world,F.camPos.xyz);
    let microLodFade=(1.0-smoothstep(140.0,340.0,camDist))*detailFade;
    let archLodFade=(1.0-smoothstep(320.0,900.0,camDist))*detailFade;
    var detailA=0.0;
    var detailB=0.0;
    if(archLodFade>0.01){detailA=landOrientedDetail(world,n,dx,dy,1.45);}
    if(microLodFade>0.01){detailB=landOrientedDetail(world+vec3f(7.3,3.1,11.9),n,dx,dy,5.2);}
    var archNormalOffset=vec3f(0.0);
    var archMatIdx=8;
    var archScale=vec2f(0.65,0.65);
    if(in.kind.x<10.5){archMatIdx=0;archScale=vec2f(0.32,0.52);}
    else if(in.kind.x<11.5){archMatIdx=1;archScale=vec2f(0.46,0.52);}
    else if(in.kind.x<12.5){archMatIdx=2;archScale=vec2f(0.38,0.38);}
    else if(in.kind.x<13.5){archMatIdx=3;archScale=vec2f(0.62,0.68);}
    else if(in.kind.x<15.5){archMatIdx=5;archScale=vec2f(0.55,0.62);}
    else if(in.kind.x<16.5){archMatIdx=6;archScale=vec2f(0.42,0.42);}
    else if(in.kind.x<17.5){archMatIdx=7;archScale=vec2f(0.52,0.58);}
    else if(in.kind.x>=18.5){archMatIdx=2;archScale=vec2f(0.38,0.38);}
    // A building of a type (in.leafUV.y below -0.5): its ashlar in the courses of a house, not a fortress's.
    let typedBuilding=in.leafUV.y<-0.5;
    if(typedBuilding&&archMatIdx==1){archScale=vec2f(0.70,0.80);}
    let timberGrain=select(0.0,floor(in.leafUV.x+0.001),typedBuilding&&archMatIdx==0);
    var pbr=ArchPBR(vec3f(0.5),vec3f(0.0),0.8,1.0);
    if(in.kind.x<13.5||in.kind.x>=14.5){
      pbr=sampleArchMaterialPBR(archMatIdx,world,n,dx,dy,archScale,archLodFade,instYaw,timberGrain);
    }
    if(in.kind.x<10.5){
      // Kind 10: MaterialCraft-cooked dressed Iberian oak, weathered cedar & pitch-pine timber
      let timberLuma=dot(pbr.albedo,vec3f(0.299,0.587,0.114));
      let agedTimber=mix(vec3f(timberLuma),pbr.albedo,0.72)*vec3f(0.93,0.96,1.02);
      albedo=agedTimber*shadeAlbedo*(0.96+detailA*0.07+detailB*0.03);
      archNormalOffset=pbr.normalOffset*0.32;
      relief=detailA*0.0024*archLodFade;
      roughness=clamp(pbr.roughness-0.16+detailB*0.025,0.44,0.72);
      ambientVisibility=(0.44+0.34*max(n.y,0.0))*aoVis*pbr.ao;
      // Intertidal marine algae, capillary wet darkening, and glossy splash sheen on dock pilings & water stairs (excluding canoes, kind.y > 0.85)
      let seaSplashH=clamp(select(0.75,F.cascL[1].z,F.cascL[1].w>1.0)+F.windP[0].z*0.04,0.35,2.2);
      let timberSplashTop=mix(0.68,1.55,clamp((seaSplashH-0.35)/1.85,0.0,1.0))+detailA*0.16;
      let notCanoe=1.0-smoothstep(0.82,0.89,in.kind.y);
      let pilingTide=(1.0-smoothstep(0.12,min(1.35,timberSplashTop*0.92),world.y))*notCanoe*clamp(0.55+0.45*detailA,0.0,1.0);
      let pilingWet=(1.0-smoothstep(0.05,timberSplashTop,world.y))*notCanoe;
      albedo=mix(albedo,vec3f(0.055,0.082,0.042),pilingTide*0.58);
      albedo*=mix(1.0,0.52,pilingWet);
      roughness=mix(mix(roughness,0.84,pilingTide*0.42),0.24,pilingWet*0.82);
      surfaceWet=max(surfaceWet,pilingWet*0.82);
    }else if(in.kind.x<11.5){
      // Kind 11: MaterialCraft-cooked coursed Pedra Lioz & coral-limestone ashlar masonry
      let vertWall=1.0-smoothstep(0.35,0.85,abs(n.y));
      let damp=smoothstep(0.2,3.8,world.y);
      let liozWarmth=vec3f(1.00,0.99,0.96);
      let stoneBase=pbr.albedo*mix(vec3f(0.76,0.75,0.72),liozWarmth,damp)*(0.96+detailA*0.06+detailB*0.03);
      let seaSplashH=clamp(select(0.75,F.cascL[1].z,F.cascL[1].w>1.0)+F.windP[0].z*0.04,0.35,2.2);
      let quaySplashTop=mix(0.65,1.65,clamp((seaSplashH-0.35)/1.85,0.0,1.0))+detailA*0.18;
      let tidalMoss=(1.0-smoothstep(0.12,min(1.42,quaySplashTop*0.88),world.y))*vertWall*clamp(0.55+0.45*detailA,0.0,1.0);
      let quayWet=(1.0-smoothstep(0.04,quaySplashTop,world.y))*(0.55+0.45*vertWall);
      let fouledStone=mix(stoneBase,vec3f(0.075,0.120,0.048),tidalMoss*0.56);
      albedo=fouledStone*shadeAlbedo*mix(1.0,0.48,quayWet);
      archNormalOffset=pbr.normalOffset*0.65;
      relief=detailA*0.004*archLodFade;
      roughness=clamp(mix(pbr.roughness+(1.0-damp)*0.05+tidalMoss*0.10,0.22,quayWet*0.85),0.18,0.92);
      surfaceWet=max(surfaceWet,quayWet*0.86);
      ambientVisibility=(0.46+0.34*max(n.y,0.0))*aoVis*pbr.ao;
    }else if(in.kind.x<12.5){
      // Kind 12: MaterialCraft-cooked Iberian limewashed stucco & weathered limestone plaster
      let damp=smoothstep(0.5,4.2,world.y);
      let wallVar=fract(instYaw*2.37+in.leafUV.x*1.73);
      let stLuma=dot(pbr.albedo,vec3f(0.299,0.587,0.114));
      let chalkBase=mix(vec3f(stLuma),pbr.albedo,0.58);
      let plasterTint=mix(vec3f(0.99,0.98,0.96),vec3f(0.95,0.91,0.84),smoothstep(0.45,0.92,wallVar)*0.45);
      let warmStucco=chalkBase*mix(vec3f(0.76,0.74,0.70),plasterTint,damp);
      albedo=warmStucco*shadeAlbedo*(0.97+detailA*0.05+detailB*0.03);
      archNormalOffset=pbr.normalOffset*0.42;
      relief=detailA*0.005*archLodFade;
      roughness=clamp(pbr.roughness+detailB*0.03,0.70,0.92);
      ambientVisibility=(0.48+0.36*max(n.y,0.0))*aoVis*pbr.ao;
    }else if(in.kind.x<13.5){
      // Kind 13: MaterialCraft-cooked weathered Iberian clay barrel roof tiles (sun-baked muted terracotta, umber & lichen)
      let horizLen=length(n.xz);
      let eaveDir=select(vec3f(1.0,0.0,0.0),vec3f(-n.z,0.0,n.x)/max(horizLen,1e-4),horizLen>0.08);
      let slopeDir=normalize(cross(eaveDir,n));
      let flute=landFilteredWave(world,dx,dy,eaveDir*13.4,detailA*0.35)*microLodFade;
      let slopeCoord=dot(world,slopeDir)*2.6;
      let slopeDx=dot(dx,slopeDir)*2.6;
      let slopeDy=dot(dy,slopeDir)*2.6;
      let courseWave=landFilteredCourse(slopeCoord,slopeDx,slopeDy,1.8);
      let courseStep=max(0.0,courseWave-0.26)*archLodFade;
      let rawTile=pbr.albedo*shadeAlbedo*(0.96+detailA*0.07+flute*0.025-courseStep*0.04);
      // Temper neon-orange kiln saturation into realistic earthy sun-baked clay sienna & dusty terracotta.
      let tileLuma=dot(rawTile,vec3f(0.299,0.587,0.114));
      albedo=mix(vec3f(tileLuma)*vec3f(1.08,0.88,0.74),rawTile*vec3f(0.84,0.88,0.96),0.48);
      // A city's roofs are not of one firing: muted terracotta, bleached buff-clay, weathered brown umber, and grey lichen.
      if(in.leafUV.y<-0.5){
        let age=in.leafUV.x;
        let grey=dot(albedo,vec3f(0.3,0.5,0.2));
        // Old tile browns and loses its chroma; lichen greys the oldest; sun-bleached tiles turn dusty tan.
        albedo=mix(albedo,grey*vec3f(1.06,0.90,0.76),smoothstep(0.22,0.90,age)*0.64);
        albedo=mix(albedo,grey*vec3f(0.95,0.96,0.88),smoothstep(0.48,0.98,fract(age*5.3))*(0.28+0.20*detailA));
        albedo=albedo*mix(1.04,0.82,fract(age*3.7));
      }
      archNormalOffset=pbr.normalOffset*0.72;
      relief=detailA*0.003*archLodFade;
      roughness=clamp(pbr.roughness+detailB*0.03,0.52,0.82);
      ambientVisibility=(0.48+0.36*max(n.y,0.0))*aoVis*pbr.ao;
    }else if(in.kind.x<14.5){
      // Kind 14: MaterialCraft-cooked 16th-century leaded-glass casements (vidrieras emplomadas) & deep arched portals
      let isGlazedWindow=in.kind.y>0.25;
      if(isGlazedWindow){
        // Sample MaterialCraft room/casement texture directly in window-locked [0..1] UV coordinates
        let bWin=sampleArchLayerGrad(8,winUV,winDx,winDy);
        let nWin=sampleArchLayerGrad(9,winUV,winDx,winDy);
        let winAlbedo=pow(max(bWin.rgb,vec3f(0.01)),vec3f(2.2));
        let winRough=bWin.a;
        let winAO=mix(1.0,nWin.a,archLodFade);
        let tnWin=nWin.rgb*2.0-1.0;
        let horizLenW=length(n.xz);
        let winRight=select(vec3f(1.0,0.0,0.0),vec3f(-n.z,0.0,n.x)/max(horizLenW,1e-4),horizLenW>0.08);
        let winUp=vec3f(0.0,1.0,0.0);
        let winShade=0.84-0.14*winUV.y;
        // Crisp window-aligned timber casement border, central mullion (u=0.50), transom (v=0.38) & diamond lead cames
        let borderDist=min(min(winUV.x,1.0-winUV.x),min(winUV.y,1.0-winUV.y));
        let outerFrame=1.0-smoothstep(0.075,0.098,borderDist);
        let mullion=1.0-smoothstep(0.028,0.044,abs(winUV.x-0.50));
        let transom=1.0-smoothstep(0.026,0.042,abs(winUV.y-0.38));
        let woodFrame=max(outerFrame,max(mullion,transom))*archLodFade;
        let cameFoot=max(length(winDx),length(winDy))*4.0;
        let cameFade=(1.0-smoothstep(0.18,0.55,cameFoot))*microLodFade;
        let dA=abs(fract((winUV.x+winUV.y)*3.0)-0.5);
        let dB=abs(fract((winUV.x-winUV.y)*3.0)-0.5);
        let leadCame=(1.0-smoothstep(0.032,0.058,min(dA,dB)))*cameFade*(1.0-woodFrame);
        let frameMask=clamp(max(woodFrame,leadCame*0.85),0.0,1.0);
        let roomDepth=winAlbedo*(0.72+0.28*winShade);
        let woodCol=vec3f(0.082,0.056,0.036)*(0.75+0.25*winShade);
        let leadCol=vec3f(0.095,0.092,0.088)*(0.75+0.25*winShade);
        albedo=mix(mix(roomDepth,leadCol,leadCame),woodCol,woodFrame);
        archNormalOffset=(winRight*tnWin.x-winUp*tnWin.y)*0.45*archLodFade;
        relief=frameMask*0.004;
        roughness=mix(winRough,mix(0.48,0.68,woodFrame),frameMask);
        surfaceWet=0.62*(1.0-frameMask*0.88);
        mirrorSpread=smoothstep(.04,.4,length(dx)+length(dy))*.03;
        ambientVisibility=(0.52+0.28*winShade)*winAO;
        let dmgIntact=1.0-clamp(structDmg*2.2,0.0,1.0);
        if(F.sunDir.y<0.10&&dmgIntact>0.01){
          let winId=floor(world.x*0.35+world.z*0.35)*31.7+floor(world.y*0.32)*73.1;
          let winSeed=fract(sin(winId)*43758.5453);
          let candleSched=landNightWindowFactor(F.sunDir.xyz,winSeed)*dmgIntact;
          if(candleSched>0.001){
            let flicker=0.86+0.09*sin(F.camPos.w*5.4+winSeed*19.0)+0.05*cos(F.camPos.w*13.1-winSeed*29.0);
            let paneGlow=(0.60+0.40*(1.0-winUV.y))*(1.0-frameMask*0.90);
            let candleExp=1.0/max(F.post.x,1.0);
            landWindowEmission=vec3f(0.34,0.145,0.032)*(candleSched*flicker*paneGlow*candleExp*(0.65+0.35*winSeed));
          }
        }
      }else{
        let cY=cos(instYaw);let sY=sin(instYaw);
        let hCoord=(world.x*cY-world.z*sY);
        let hDx=(dx.x*cY-dx.z*sY);
        let hDy=(dy.x*cY-dy.z*sY);
        let rejaX=max(0.0,landFilteredCourse(hCoord*3.4,hDx*3.4,hDy*3.4,2.0)-0.34);
        let rejaY=max(0.0,landFilteredCourse(world.y*2.2,dx.y*2.2,dy.y*2.2,1.8)-0.34);
        let rejaWave=clamp(0.62*rejaX+0.48*rejaY,0.0,1.0)*archLodFade;
        albedo=vec3f(0.048,0.040,0.033)*(1.0-0.22*rejaWave)*portShade*(1.0+detailB*0.08);
        relief=(detailB*0.004+rejaWave*0.006)*archLodFade;
        roughness=mix(0.84,0.48,rejaWave);
        ambientVisibility=0.14+0.12*portShade;
      }
    }else if(in.kind.x<15.5){
      // Kind 15: MaterialCraft-cooked layered palm-thatch & bundled reed/straw roof
      albedo=pbr.albedo*shadeAlbedo*(0.96+detailA*0.08+detailB*0.04);
      if(in.leafUV.y<-0.5){
        let age=in.leafUV.x;
        let grey=dot(albedo,vec3f(0.3,0.5,0.2));
        // Fresh straw is warm gold; weathered thatch darkens to peat-brown and silvers with moss.
        albedo=mix(albedo*vec3f(1.10,1.03,0.84),grey*vec3f(0.92,0.86,0.74),smoothstep(0.22,0.92,age)*0.64);
        albedo=albedo*mix(1.06,0.82,fract(age*4.1));
      }
      archNormalOffset=pbr.normalOffset*0.60;
      relief=detailA*0.004*archLodFade;
      roughness=clamp(pbr.roughness,0.82,0.95);
      ambientVisibility=(0.44+0.36*max(n.y,0.0))*aoVis*pbr.ao;
    }else if(in.kind.x<16.5){
      // Kind 16: MaterialCraft-cooked granite & river-cobble calçada / empedrado pavement.
      // Albedo is trilinearly mipmapped by sampleArchLayerGrad across 6 mip levels; only normal/bump
      // relief needs early derivative damping to prevent grazing-angle specular shimmer.
      let cobbleAniso=max(length(dx),length(dy));
      let cobbleBumpFade=archLodFade*(1.0-smoothstep(0.035,0.14,cobbleAniso))*smoothstep(0.06,0.28,max(abs(n.y),0.12));
      albedo=pbr.albedo*shadeAlbedo*(0.96+detailA*0.05*archLodFade+detailB*0.03*archLodFade);
      archNormalOffset=pbr.normalOffset*0.44*cobbleBumpFade;
      relief=detailA*0.003*cobbleBumpFade;
      roughness=clamp(mix(0.84,pbr.roughness,archLodFade),0.68,0.92);
      ambientVisibility=(0.48+0.36*max(n.y,0.0))*aoVis*mix(1.0,pbr.ao,0.68*archLodFade);
    }else if(in.kind.x<17.5){
      // Kind 17: MaterialCraft-cooked paper-birch & cedar bark sheathing
      albedo=pbr.albedo*shadeAlbedo*(0.96+detailA*0.07+detailB*0.04);
      archNormalOffset=pbr.normalOffset*0.50;
      relief=detailA*0.004*archLodFade;
      roughness=clamp(pbr.roughness,0.70,0.90);
      ambientVisibility=(0.48+0.36*max(n.y,0.0))*aoVis*pbr.ao;
    }else if(in.kind.x<18.5){
      // Kind 18: MaterialCraft-cooked sand-cast ordnance iron & forged harbor metal
      let bareIron=clamp(0.18+detailA*0.14+max(0.0,n.y)*0.08-max(0.0,-detailB)*0.08,0.06,0.34);
      albedo=pbr.albedo*(0.75+0.25*bareIron)*(0.68+0.32*portShade);
      archNormalOffset=pbr.normalOffset*0.48;
      relief=(detailA*0.003+detailB*0.003)*archLodFade;
      roughness=clamp(pbr.roughness-bareIron*0.12,0.44,0.74);
      surfaceWet=-0.08;
      ambientVisibility=(0.46+0.38*max(n.y,0.0))*aoVis*pbr.ao;
    }else{
      // Kind 19: a city house's wall. Limewash over rubble, tinted house by house, with its
      // windows and door counted out along the wall: in.leafUV is bays across and storeys up.
      let tint=floor(in.kind.y);
      let tone=0.72+0.28*fract(in.kind.y);
      var wash=vec3f(0.98,0.98,0.96);
      // Past the washes, the paints of a street's cloth and boards (js/old-world-buildings.js CITY_PAINT).
      if(tint>9.5){wash=vec3f(0.085,0.075,0.068);}
      else if(tint>8.5){wash=vec3f(0.24,0.165,0.105);}
      else if(tint>7.5){wash=vec3f(0.095,0.185,0.045);}
      else if(tint>6.5){wash=vec3f(0.48,0.36,0.14);}
      else if(tint>5.5){wash=vec3f(0.060,0.135,0.300);}
      else if(tint>4.5){wash=vec3f(0.38,0.085,0.055);}
      else if(tint>3.5){wash=vec3f(0.80,0.79,0.76);}
      else if(tint>2.5){wash=vec3f(0.90,0.83,0.80);}
      else if(tint>1.5){wash=vec3f(0.91,0.86,0.77);}
      else if(tint>0.5){wash=vec3f(0.95,0.93,0.88);}
      let damp=max(smoothstep(0.5,4.2,world.y),step(4.5,tint));
      let stBaseLuma=dot(pbr.albedo,vec3f(0.299,0.587,0.114));
      let neutralPlaster=mix(vec3f(stBaseLuma),pbr.albedo,select(0.58,0.75,tint>4.5));
      let stucco=neutralPlaster*wash*mix(vec3f(0.76,0.74,0.70),vec3f(0.99,0.98,0.96),damp);
      albedo=stucco*tone*(0.97+detailA*0.05+detailB*0.03);
      archNormalOffset=pbr.normalOffset*0.42;
      relief=detailA*0.005*archLodFade;
      roughness=clamp(pbr.roughness+detailB*0.03,0.70,0.92);
      ambientVisibility=(0.48+0.36*max(n.y,0.0))*select(0.62+0.38*smoothstep(-0.2,1.4,in.leafUV.y),aoVis,in.leafUV.y<-0.5)*pbr.ao;
      if(in.leafUV.y>0.0){
        let bay=fract(in.leafUV.x);
        let storey=floor(in.leafUV.y);
        let up=fract(in.leafUV.y);
        let door=storey<0.5&&in.leafUV.x>=0.0&&in.leafUV.x<1.0;
        let halfW=select(0.19,0.24,door);
        let low=select(select(0.30,0.40,storey<0.5),0.0,door);
        let high=select(0.74,0.76,door);
        // Each edge softened by what a pixel covers, and the whole faded to its mean tone far off.
        let wide=cityWide;
        let tall=cityTall;
        let across=1.0-smoothstep(halfW-wide,halfW+wide,abs(bay-0.5));
        let upright=smoothstep(low-tall,low+tall,up)*(1.0-smoothstep(high-tall,high+tall,up));
        let seen=1.0-smoothstep(0.22,0.7,max(wide,tall));
        let opening=across*upright;
        let cell=floor(in.leafUV.x)*17.0+storey*29.0+floor(world.x*0.11)*7.0+floor(world.z*0.11)*13.0;
        let pick=fract(sin(cell*12.9898)*43758.5453);
        // A shutter closed over some, the room's dark behind the rest; a door is planks.
        let shut=select(step(0.62,pick),1.0,door);
        let leaf=select(vec3f(0.115,0.150,0.105),vec3f(0.150,0.098,0.060),door||pick>0.84)*(0.8+0.3*fract(pick*7.0));
        let within=mix(vec3f(0.030,0.027,0.026),leaf,shut);
        let frame=clamp((1.0-smoothstep(halfW+0.035,halfW+0.035+wide*2.0,abs(bay-0.5)))*smoothstep(low-0.05-tall,low-0.05+tall,up)*(1.0-smoothstep(high+0.05-tall,high+0.05+tall,up))-opening,0.0,1.0);
        albedo=mix(albedo,albedo*vec3f(0.80,0.78,0.74),frame*seen*0.7);
        albedo=mix(albedo*mix(1.0,0.86,1.0-seen),within*shadeAlbedo,opening*seen);
        roughness=mix(roughness,0.62,opening*seen*(1.0-shut));
        relief=relief-opening*seen*0.004;
        if(F.sunDir.y<0.10&&shut<0.5){
          let roomSeed=fract(sin(cell*78.233+11.7)*43758.5453);
          let candleSched=landNightWindowFactor(F.sunDir.xyz,roomSeed);
          if(candleSched>0.001){
            let flicker=0.86+0.09*sin(F.camPos.w*5.4+pick*19.0)+0.05*cos(F.camPos.w*13.1-pick*29.0);
            landWindowEmission=vec3f(0.34,0.145,0.032)*(candleSched*flicker*opening*mix(0.35,1.0,seen)/max(F.post.x,1.0)*(0.55+0.45*roomSeed));
          }
        }
      }
    }
    // A building of a type says how high each point of it stands above its own floor (in.leafUV.y, from
    // cityTypeVS), and so weathers as a building does: splashed and damp at its foot, its limewash laid on in
    // patches and run with rain, its timber and stone never of one tone from end to end. A flat face stops
    // reading as the side of a block.
    if(in.leafUV.y<-0.5&&(in.kind.x<12.5||in.kind.x>=18.5)&&!(in.kind.x>=18.5&&floor(in.kind.y)>4.5)){
      let above=-in.leafUV.y-1.0;
      let upright=1.0-smoothstep(0.35,0.8,abs(n.y));
      let runDown=vec3f(1.0,0.11,1.0);
      let blotch=landOrientedDetail(world,n,dx,dy,0.36)*archLodFade;
      let streak=landOrientedDetail(world*runDown+vec3f(3.7,0.0,9.1),n,dx*runDown,dy*runDown,2.3)*microLodFade;
      if(in.kind.x<10.5){
        albedo*=1.0+blotch*0.22+streak*0.07;
      }else{
        let foot=(1.0-smoothstep(0.0,0.5+0.45*(blotch+0.5)+0.2*detailA,above))*upright*archLodFade;
        let wet=foot*(0.55+0.45*clamp(0.5+streak,0.0,1.0));
        albedo=mix(albedo,albedo*vec3f(0.56,0.55,0.50)+vec3f(0.010,0.013,0.006),wet*0.62);
        roughness=mix(roughness,0.94,wet*0.5);
        ambientVisibility*=1.0-foot*0.25;
        if(in.kind.x>=18.5){
          albedo*=1.0+blotch*0.15;
          albedo=mix(albedo,albedo*vec3f(0.80,0.78,0.72),clamp(streak-0.06,0.0,1.0)*upright*0.6);
        }else{
          albedo*=1.0+blotch*0.09;
        }
      }
    }
    n=normalize(n+archNormalOffset);
  }
`;

const TERRAIN_TOWN_WAYS_BLOCK = /* wgsl */ `
  // A town's ways, from a distance field baked when it was laid out. Its red channel is how far
  // this point lies outside a way, its green how the way is surfaced: earth, a rutted road, cobbles.
  if(townWindow.z>0.0){
    let townUV=(world.xz-townWindow.xy)/townWindow.z+.5;
    if(all(townUV>vec2f(0.0))&&all(townUV<vec2f(1.0))){
      let way=textureSampleLevel(townField,landSampler,townUV,0.0).rg;
      if(way.r<.52){
        // Grass laps over a way's edge blade by blade.
        let fringe=gd.fine.r*.5+gd.mid.r*.55+gd.mid.a*.7+gd.big.a*.6;
        let frayed=way.r*${STREET_FIELD_RANGE_M.toFixed(1)}-${STREET_FIELD_EDGE_M.toFixed(1)}+(grain*.35+fringe*.7)*(1.0-way.g*.75);
        let soft=max(footprint,mix(.14,.03,gd.near));
        let onWay=1.0-smoothstep(-soft,soft,frayed);
        let trodden=(1.0-smoothstep(0.0,2.4,frayed))*(1.0-onWay);
        if(onWay<=0.001){
          albedo*=1.0-trodden*.2;
        }else{
          let wear=gd.big.a*1.2+grain*0.35;
          let paved=smoothstep(.52,.78,way.g);
          landOnPavedWay=onWay*paved;
          var surface=albedo;
          var surfaceRelief=relief;
          if(paved<0.999){
            let grit=gd.fine.g+gd.mid.g*.9+gd.big.g*.3;
            let earth=mix(vec3f(.27,.215,.15),source,.22)*(1.0+wear*.16+grit*1.1+gd.big.a*.5+gd.mid.a*.35);
            // A road's two wheel tracks run a pace either side of its middle.
            let rutted=1.0-smoothstep(.2,.45,abs(way.g-.5));
            let rutBroken=clamp(1.0+(gd.mid.a*1.4+gd.big.a*.9)*2.0,.3,1.25);
            let rutD=(frayed+.85)/.38;
            let ruts=rutted*exp(-(rutD*rutD))*(1.0-smoothstep(.06,.5,footprint))*mix(1.0,rutBroken,gd.near);
            surface=earth*(1.0-ruts*.26);
            surfaceRelief=wear*.03-ruts*.05+gd.fine.g*.0035+gd.mid.g*.012;
            // Between the tracks of a country road, grass the wheels never reach.
            surface=mix(surface,albedo,rutted*smoothstep(1.55,2.1,-frayed+fringe*1.4)*gd.near*.9);
          }
          if(paved>0.0){
            // Setts, stone by stone, a foot across. Where a pixel is too coarse to hold them, stones two
            // and a half times the size stand in, turned so the two lattices never line up; the two are
            // never laid over each other. A pixel on a street seen along its length is far longer than
            // it is wide, so a size is read twice along that length and fades by the pixel's narrow
            // side: the stones stay sharp down the street and never shimmer. Their relief, which also
            // feeds the highlight, fades by the long side.
            let lx=length(dx.xz);let ly=length(dy.xz);
            let majorXZ=select(dy.xz,dx.xz,lx>=ly);
            let roadFoot=max(min(lx,ly),max(lx,ly)*0.28);
            let anisoFoot=max(lx,ly);
            let streetGrazing=smoothstep(0.04,0.18,max(n.y,0.0));
            let stoneFineFade=(1.0-smoothstep(0.042,0.115,roadFoot))*streetGrazing;
            let stoneMidFade=(1.0-smoothstep(0.095,0.260,roadFoot))*streetGrazing;
            let stoneBumpFade=(1.0-smoothstep(0.018,0.055,anisoFoot))*streetGrazing;
            let midWeight=stoneMidFade*(1.0-stoneFineFade);
            var stonesFine=vec2f(0.0,1.0);
            if(stoneFineFade>0.0){
              if(roadFoot<0.048){
                stonesFine=0.5*(landSetts((world.xz-majorXZ*0.25)*3.4)+landSetts((world.xz+majorXZ*0.25)*3.4));
              }else{
                stonesFine=landSetts(world.xz*3.4);
              }
            }
            var stonesMid=vec2f(0.0,1.0);
            if(midWeight>0.0){
              let qMid=vec2f(world.x*0.8-world.z*0.6,world.x*0.6+world.z*0.8)*1.35+vec2f(17.3,41.7);
              stonesMid=landSetts(qMid);
            }
            let toneMix=stonesFine.x*0.22*stoneFineFade+stonesMid.x*0.18*midWeight;
            let mortarMix=(1.0-stonesFine.y)*0.46*stoneFineFade+(1.0-stonesMid.y)*0.34*midWeight;
            let macroTone=wear*.12+gd.big.a*.28+gd.mid.a*.24+gd.mid.b*.22+gd.fine.a*.32*stoneFineFade;
            let setts=vec3f(.236,.214,.189)*(1.0+macroTone+toneMix)*(1.0-mortarMix);
            surface=mix(surface,setts,paved);
            let bumpVal=(stonesFine.y-.6)*.016*stoneBumpFade+(stonesMid.y-.6)*.02*midWeight*(1.0-stoneBumpFade)+gd.mid.b*.012;
            surfaceRelief=mix(surfaceRelief,bumpVal,paved);
          }
          albedo=mix(albedo*(1.0-trodden*.2),surface,onWay);
          relief=mix(relief,surfaceRelief,onWay);
          roughness=mix(roughness,mix(.93,.82,paved),onWay);
          canopyBackscatter*=1.0-onWay;
        }
      }
    }
  }
`;

const TERRAIN_CITY_DMG_BLOCK = /* wgsl */ `
  if(structDmg>0.005){
    let dmgW=clamp(structDmg,0.0,1.0);
    let spallDetail=landOrientedDetail(world+vec3f(5.7,2.3,9.1),n,dx,dy,3.2);
    let fissure=landOrientedJoint(world+vec3f(11.3,4.7,6.9),n,dx,dy);
    // A kind is the whole number: its fraction carries the building's turn, or a window's own coordinate.
    let isAperture=in.kind.x>=13.5&&in.kind.x<14.5;
    let isThatch=in.kind.x>=14.5&&in.kind.x<15.5;
    let isCastIron=in.kind.x>=17.5&&in.kind.x<18.5;
    let isStoneRubble=in.kind.x>=10.5&&in.kind.x<16.5&&!isAperture&&!isThatch;
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
      let gritDetail=landOrientedDetail(world+vec3f(14.1,8.7,3.9),n,dx,dy,8.5);
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
`;

// Terrain-only surface shader (landContinuum & submerged): zero architectural material branches or bindings,
// zero structDmg, zero unused building derivatives — eliminates Metal register spilling on land fragments.
export const TERRAIN_LAND = TERRAIN_FINISH_ONLY + /* wgsl */ `
@group(0) @binding(7) var landAlbedo:texture_2d<f32>;
@group(0) @binding(8) var landSampler:sampler;
@group(0) @binding(9) var vegetationMask:texture_2d<f32>;
struct NearLand {domain:vec4f,grid:vec4f};
@group(0) @binding(12) var<uniform> nearTerrain:NearLand;
@group(0) @binding(13) var nearAlbedo:texture_2d<f32>;
@group(0) @binding(14) var townField:texture_2d<f32>;
@group(0) @binding(15) var<uniform> townWindow:vec4f;
` + TERRAIN_FILTERING + TERRAIN_NEAR_MATERIAL + GROUND_DETAIL_RENDER + /* wgsl */ `
fn landOpaque(in:LandVertex)->vec4f{return landSurface(in,LandPit(vec3f(0.0),-1.0,vec3f(0.0),0.0,1.0,1.0,0.0,1.0,0.0));}
fn landSurface(in:LandVertex,pit:LandPit)->vec4f{
  let world=in.world;
  let rawNLen=length(in.normal);
  var n=in.normal/max(rawNLen,1e-4);
  let uv=(world.xz-LAND.domain.xy)/LAND.domain.z+0.5;
  let dx=dpdx(world);let dy=dpdy(world);let nx=dpdx(n);let ny=dpdy(n);
  let footprint=max(length(dx),length(dy));
  let imageSteep=smoothstep(.12,.42,1.0-max(n.y,0.0));
  let imageBlur=max(footprint,imageSteep*4.0*LAND.domain.z/f32(textureDimensions(landAlbedo).x))/LAND.domain.z;
  var source=pow(textureSampleGrad(landAlbedo,landSampler,uv,mix(dx.xz/LAND.domain.z,vec2f(imageBlur,0.0),imageSteep),mix(dy.xz/LAND.domain.z,vec2f(0.0,imageBlur),imageSteep)).rgb,vec3f(2.2));
  let nearGround=in.kind.x>.5&&in.kind.x<1.5&&nearTerrain.domain.w>.5;
  if(nearGround){
    source=landNearColour(source,world,n,dx,dy,nx,ny,1.0-in.kind.y);
  }
  let vegetation=textureSampleLevel(vegetationMask,landSampler,uv,0.0).r;
  let grain=landFilteredNoise(world.xz*0.019,landMaterialFootprint(dx.xz,dy.xz)*0.019);
  let rocky=smoothstep(0.22,0.56,1.0-n.y+grain*0.07);
  let verticalBias=abs(n.z)-abs(n.x);
  let vertical=select(world.zy,world.xy,verticalBias>0.0);
  let materialUV=select(world.xz,vertical,rocky>.5);
  let materialSeam=smoothstep(0.0,.1,abs(rocky-.5))*select(1.0,smoothstep(0.0,.08,abs(verticalBias)),rocky>.5);
  let materialWidth=landMaterialFootprint3(dx,dy);
  var albedo=source;var relief=0.0;var roughness=0.95;
  var ambientVisibility=0.42+0.35*max(n.y,0.0);
  var surfaceWet=0.0;var mirrorSpread=0.0;
  var canopyBackscatter=0.0;
  var landOnPavedWay=0.0;
  var gd=GroundDetail(0.0,0.0,vec4f(0.0),vec4f(0.0),vec4f(0.0));
  {
` + TERRAIN_LAND_MATERIAL_BLOCK + /* wgsl */ `
  }
` + TERRAIN_TOWN_WAYS_BLOCK + /* wgsl */ `
  if(pit.cover>=0.0){
    let bare=max(pit.sand,1.0-smoothstep(-.12,-.04,(albedo.g-max(albedo.r,albedo.b))/max(max(albedo.r,max(albedo.g,albedo.b)),.02)));
    albedo=mix(albedo,mix(mix(pit.soil,albedo*pit.damp,bare),vec3f(.022,.036,.04),pit.pool),pit.cover);
    relief=mix(relief,pit.relief*(1.0-.6*bare),pit.cover);
    roughness=mix(roughness,mix(.97,.05,pit.pool),pit.cover);
    canopyBackscatter*=1.0-pit.cover;
    surfaceWet=mix(surfaceWet,pit.pool*.96,pit.cover);
    n=pit.normal;
  }
  ambientVisibility*=pit.sky;
  let reliefX=dpdx(relief);let reliefY=dpdy(relief);
  n=landFilteredBump(n,dx,dy,reliefX,reliefY);
  let turnX=dpdx(n);let turnY=dpdy(n);
  landNormalSpread=min(mirrorSpread+.5*(dot(turnX,turnX)+dot(turnY,turnY)),.18);
  let tidePulse=0.75+0.25*sin(F.camPos.w*0.7+world.x*0.02);
  let shoreWet=(1.0-smoothstep(0.35,2.2,world.y))*tidePulse*0.45;
  let wet=clamp(max(shoreWet,surfaceWet),0.0,0.96);
  roughness=mix(roughness,min(roughness,0.24),shoreWet*0.65);
  let nDotL=dot(n,F.sunDir.xyz);
  var sunReach=pit.sun;
  let beyondShadowMap=(1.0-landShadowCoverage(world))*smoothstep(60.0,120.0,distance(world,F.camPos.xyz));
  if(F.sunDir.y>0.02&&beyondShadowMap>0.0){
    let sunStep=F.sunDir.xz*(14.0/max(F.sunDir.y,0.28))/LAND.domain.z;
    let vegSun=textureSampleLevel(vegetationMask,landSampler,clamp(uv+sunStep,vec2f(0.0),vec2f(1.0)),0.0).r;
    let farCanopyShadow=smoothstep(0.18,0.62,vegSun)*(1.0-smoothstep(0.55,0.92,vegetation)*0.55);
    sunReach*=1.0-farCanopyShadow*0.48*beyondShadowMap;
  }
  let diffuse=(max(nDotL,0.0)+max(-nDotL,0.0)*canopyBackscatter)*sunReach;
  return landFinish(world,n,albedo,diffuse,ambientVisibility,wet,roughness);
}
` + LAND_CRATER_PIT;

// City-only surface shader (cityContinuum & portFractures): uses hardware texture_2d_array (archMaterialTex) instead
// of 12-20 manual storage-buffer reads per pixel, and omits all terrain/groundDetail/landNearColour/landSetts/crater code.
export const TERRAIN_CITY = TERRAIN_FINISH_ONLY + /* wgsl */ `
@group(0) @binding(8) var landSampler:sampler;
@group(0) @binding(13) var nearAlbedo:texture_2d<f32>;
` + TERRAIN_FILTERING + CITY_ORIENTED_DETAIL + ARCH_MATERIAL_TEX_SAMPLERS + ARCH_MATERIAL_PBR_FN + /* wgsl */ `
fn landOpaque(in:LandVertex)->vec4f{return landSurface(in,LandPit(vec3f(0.0),-1.0,vec3f(0.0),0.0,1.0,1.0,0.0,1.0,0.0));}
fn landSurface(in:LandVertex,pit:LandPit)->vec4f{
  let world=in.world;
  let rawNLen=length(in.normal);
  let structDmg=clamp(rawNLen-1.0,0.0,1.5);
  var n=in.normal/max(rawNLen,1e-4);
  let dx=dpdx(world);let dy=dpdy(world);
  let footprint=max(length(dx),length(dy));
  let detailFade=1.0-smoothstep(0.25,2.5,footprint);
  let bldgUV=clamp(vec2f(in.kind.x-20.0,in.kind.y),vec2f(0.001),vec2f(0.999));
  let bldgDx=dpdx(bldgUV);let bldgDy=dpdy(bldgUV);
  let winUV=clamp(vec2f((in.kind.x-14.02)/0.44,(in.kind.y-0.32)/0.64),vec2f(0.0),vec2f(1.0));
  let winDx=dpdx(winUV);let winDy=dpdy(winUV);
  let cityWide=max(fwidth(in.leafUV.x),1e-4);let cityTall=max(fwidth(in.leafUV.y),1e-4);
  var albedo=vec3f(0.5);var relief=0.0;var roughness=0.90;
  var ambientVisibility=0.46+0.35*max(n.y,0.0);
  var surfaceWet=0.0;var mirrorSpread=0.0;
` + TERRAIN_CITY_MATERIAL_BLOCK + TERRAIN_CITY_DMG_BLOCK + /* wgsl */ `
  ambientVisibility*=pit.sky;
  let reliefX=dpdx(relief);let reliefY=dpdy(relief);
  n=landFilteredBump(n,dx,dy,reliefX,reliefY);
  let turnX=dpdx(n);let turnY=dpdy(n);
  landNormalSpread=min(mirrorSpread+.5*(dot(turnX,turnX)+dot(turnY,turnY)),.18);
  let tidePulse=0.75+0.25*sin(F.camPos.w*0.7+world.x*0.02);
  let shoreWet=(1.0-smoothstep(0.35,2.2,world.y))*tidePulse*0.22;
  let wet=select(clamp(max(shoreWet,surfaceWet),0.0,0.96),surfaceWet-shoreWet*0.14,surfaceWet<-0.01);
  roughness=mix(roughness,min(roughness,0.24),shoreWet*0.65);
  let nDotL=dot(n,F.sunDir.xyz);
  let diffuse=max(nDotL,0.0)*pit.sun;
  return landFinish(world,n,albedo,diffuse,ambientVisibility,wet,roughness);
}
`;

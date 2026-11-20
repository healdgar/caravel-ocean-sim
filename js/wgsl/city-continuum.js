// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The city's material in the one continuum's pipeline family (js/wgsl/continuum-cut.js): how a city's buildings, a
// coast's prefabs and the pieces of a struck building wear their surfaces. Their cut, their shadow, their atlas and
// their poses are the one cut's; this is only how a surface is worn, shaded by the land's own opaque surface
// (js/wgsl/terrain.js landOpaque) with a building's limewash, tiles and thatch, its age and its weathering. Its view is
// a module of its own, the land's source its prelude (the land shades it, but does not carry it).
import { CITY_CONTINUUM_KIND_Y, CITY_CONTINUUM_MATERIAL } from '../city-continuum.js';
import { withCapturedAir } from '../water-optics.js';

// A record's identity word, as a city's building holds it (f32): its tint (fract its tone, floor its limewash), or
// CITY_CONTINUUM_AS_BUILT, worn as its builder made it (a coast's prefab, a struck prefab's pieces).
export const CITY_CONTINUUM_AS_BUILT = -1000;
// Where the scene's data binds in a city view: group 2, past the land's own group 2 bindings.
export const CITY_CONTINUUM_DATA = Object.freeze({ group: 2, binding: 40 });

const CITY_CONTINUUM_MATERIAL_WGSL = /* wgsl */`
struct CityContinuumWorn { kind:vec2f, leafUV:vec2f };
// A vertex's kind (material | fraction << 8 in its word, kind.y in its high half-word); a far-body triangle's
// (material | fraction << 8 | kind.y << 20).
fn cityContinuumKind(high:u32,word:u32)->vec2f { return vec2f(f32(word&255u)+f32(word>>8u)/16777215.0,f32(high)/65535.0*${CITY_CONTINUUM_KIND_Y.toFixed(1)}); }
fn cityContinuumFarKind(packed:u32)->vec2f { return vec2f(f32(packed&255u)+f32((packed>>8u)&4095u)/4095.0,f32(packed>>20u)/4095.0*${CITY_CONTINUUM_KIND_Y.toFixed(1)}); }
// A surface as this building wears it: limewash in its own tint, tiles and thatch in its own shade and age, masonry
// turned with it, a timber's grain in place of the age only a tile reads; and below -1, how high it stands above the
// building's floor, by which its walls weather. A window keeps its place in its pane.
fn cityContinuumWorn(kind:vec2f,record:ContinuumRecord,height:f32)->CityContinuumWorn {
  let tint=bitcast<f32>(record.spare.x);
  let root=vec4f(record.place.xyz,continuumYaw(record));
  let built=tint< -150.0;
  let tone=select(fract(tint),0.5,built);
  let material=floor(kind.x+0.01);
  var out:CityContinuumWorn;
  out.kind=kind;
  if(abs(material-14.0)>0.5){
    let turn=0.02+0.46*fract((fract(kind.x)-0.02)/0.46+root.w/PI);
    if(built){out.kind=vec2f(material+turn,kind.y);}
    else if(abs(material-12.0)<0.5){out.kind=vec2f(19.0+turn,floor(tint)+clamp(tone*kind.y,0.02,0.98));}
    else if(abs(material-13.0)<0.5||abs(material-15.0)<0.5){out.kind=vec2f(material+turn,kind.y*cityRoofShade(root,tone));}
    else{out.kind=vec2f(material+turn,kind.y);}
  }
  var grain=0.0;
  if(abs(material-10.0)<0.5){grain=floor(kind.y*0.5);out.kind=vec2f(out.kind.x,kind.y-2.0*grain);}
  out.leafUV=vec2f(select(select(cityRoofAge(root,tone),0.0,built),grain,grain>0.5),select(-1.0-max(height,0.0),-1.0,built));
  return out;
}
// The material block of a type: its splat's roof share, its walls' kind and its roof's.
fn cityContinuumBlockKind(model:u32,at:u32)->vec2f { return vec2f(continuumTypeF(model,at),continuumTypeF(model,at+1u)); }
fn cityContinuumVarying(s:ContinuumSurface,v:ptr<function,ContinuumVarying>) {
  // Every building stands at its type's own size: its height above its floor is its type's, by the record's scale.
  let height=s.local.y*s.record.place.w;
  if(s.what==CONTINUUM_SPLAT_ENTRY){
    let wall=cityContinuumWorn(cityContinuumBlockKind(s.model,${CITY_CONTINUUM_MATERIAL.wallKind}u),s.record,height);
    let roof=cityContinuumWorn(cityContinuumBlockKind(s.model,${CITY_CONTINUUM_MATERIAL.roofKind}u),s.record,height);
    (*v).kind=wall.kind;(*v).leafUV=wall.leafUV;(*v).splatKinds=vec4f(wall.kind,roof.kind);
    // The roof takes the top of the triangle, as much of its area as it takes of the outline: above corner height t
    // (the apex at 2, the base at -1) lies ((2 - t) / 3)^2 of it.
    (*v).splat=vec2f(s.corner.y,2.0-3.0*sqrt(clamp(continuumTypeF(s.model,${CITY_CONTINUUM_MATERIAL.roofShare}u),0.0,1.0)));
    return;
  }
  // Every corner of a far-body triangle carries the triangle's own kind.
  let worn=cityContinuumWorn(select(cityContinuumKind(s.high,s.word),cityContinuumFarKind(s.word),s.what==CONTINUUM_FAR_ENTRY),s.record,height);
  (*v).kind=worn.kind;(*v).leafUV=worn.leafUV;
  // The land reads a face's damage by its normal's length past one: raw stone or timber where a cut opened it, and
  // scorch where fire has been.
  (*v).normal=s.normal*(1.0+s.wear);
}
fn cityContinuumShade(v:ContinuumVarying,front:bool)->vec4f {
  // Where a far face still stands as one wall (its optical normals agree and align with its plane), keep the wall's
  // flat plane so houses stay crisp masonry rather than round cylinders; as walls collapse together at coarse steps,
  // lean smoothly onto the morphed optical normal so coarse bodies never break into flat-shaded facets.
  let across=dpdx(v.world);let down=dpdy(v.world);
  let plane=cross(down,across);
  let unitN=normalize(v.normal);
  let faceted=select(unitN,normalize(plane)*select(-1.0,1.0,dot(plane,continuumEye()-v.world)>=0.0),dot(plane,plane)>1e-16);
  var normal=v.normal;var kind=v.kind;
  if(v.coverage.x==CONTINUUM_FAR_ENTRY){
    let agree=dot(faceted,unitN);
    normal=normalize(mix(unitN,faceted,smoothstep(0.45,0.72,agree)))*length(v.normal);
  }else if(v.coverage.x==CONTINUUM_SPLAT_ENTRY){
    let roof=v.splat.x>v.splat.y;
    kind=select(v.splatKinds.xy,v.splatKinds.zw,roof);
    normal=select(v.normal,normalize(vec3f(0.0,1.0,0.0)+v.normal*0.6),roof);
  }
  // Far, the sun and sky its optical moments say reach what is seen of the building: the sky shut out beneath its
  // eaves, in its yards and at the foot of its towers. Near they are (1, 0, 1, 0).
  let reach=continuumOpticLight(normalize(normal),F.sunDir.xyz,v.optics);
  return landSurface(LandVertex(v.position,v.world,normal,kind,v.leafUV),LandPit(vec3f(0.0),-1.0,vec3f(0.0),0.0,clamp(reach.x+reach.y,0.0,1.0),reach.z,0.0,1.0,0.0));
}
`;

// Octahedral G-buffer card bake hook (js/continuum-cards.js): bakes pure unlit architectural PBR albedo, local normal,
// and matFlag (1.0 = limewash wall, 0.5 = roof tile/thatch, 0.0 = window/stone/timber/iron) directly from archMaterialTex.
const CITY_CONTINUUM_CARD_BAKE = Object.freeze({
  prelude: () => /* wgsl */`
@group(0) @binding(0) var cityCardArchSamp:sampler;
@group(0) @binding(1) var cityCardArchTex:texture_2d_array<f32>;
@group(0) @binding(2) var cityCardLandSamp:sampler;
@group(0) @binding(3) var cityCardNearAlbedo:texture_2d<f32>;
`,
  varyings: [['kind', 'vec2f']],
  wgsl: () => /* wgsl */`
fn cityCardKind(high:u32,word:u32)->vec2f { return vec2f(f32(word&255u)+f32(word>>8u)/16777215.0,f32(high)/65535.0*${CITY_CONTINUUM_KIND_Y.toFixed(1)}); }
fn cityContinuumCardBakeVarying(s:ContinuumSurface,v:ptr<function,ContinuumCardBakeVarying>) {
  (*v).kind=cityCardKind(s.high,s.word);
}
fn cityContinuumCardBake(v:ContinuumCardBakeVarying,front:bool)->ContinuumCardSample {
  let n=normalize(v.normal+vec3f(0.0,1e-6,0.0));
  let dx=dpdx(v.local);let dy=dpdy(v.local);
  let mat=floor(v.kind.x+0.01);
  let portShade=clamp(v.kind.y,0.18,1.0);
  let shadeAlbedo=0.52+0.48*portShade;
  var archIdx=2;
  var sc=vec2f(0.38,0.38);
  var matFlag=0.0;
  if(mat<10.5){archIdx=0;sc=vec2f(0.32,0.52);}
  else if(mat<11.5){archIdx=1;sc=vec2f(0.70,0.80);}
  else if(mat<12.5){archIdx=2;sc=vec2f(0.38,0.38);matFlag=1.0;}
  else if(mat<13.5){archIdx=3;sc=vec2f(0.62,0.68);matFlag=0.5;}
  else if(mat<14.5){archIdx=4;sc=vec2f(1.0,1.0);}
  else if(mat<15.5){archIdx=5;sc=vec2f(0.55,0.62);matFlag=0.5;}
  else if(mat<16.5){archIdx=6;sc=vec2f(0.42,0.42);}
  else if(mat<17.5){archIdx=7;sc=vec2f(0.52,0.58);}
  else if(mat<18.5){archIdx=8;sc=vec2f(0.65,0.65);}
  else if(mat<19.5){archIdx=2;sc=vec2f(0.38,0.38);matFlag=1.0;}
  // Planar/triplanar architectural UV in local building metres (matching ARCH_MATERIAL_PBR_FN).
  let isWall=abs(n.y)<0.55;
  let useZ=abs(n.x)>abs(n.z);
  let uAxis=select(v.local.x,v.local.z,useZ);
  let duAxis=select(dx.x,dx.z,useZ);
  let dvAxis=select(dy.x,dy.z,useZ);
  let archUV=select(v.local.xz*sc,vec2f(uAxis*sc.x,v.local.y*sc.y),isWall);
  let archDx=select(dx.xz*sc,vec2f(duAxis*sc.x,dx.y*sc.y),isWall);
  let archDy=select(dy.xz*sc,vec2f(dvAxis*sc.x,dy.y*sc.y),isWall);
  let bldgUV=clamp(vec2f(v.kind.x-20.0,v.kind.y),vec2f(0.001),vec2f(0.999));
  let winUV=clamp(vec2f((v.kind.x-14.02)/0.44,(v.kind.y-0.32)/0.64),vec2f(0.0),vec2f(1.0));
  let sampUV=select(archUV,winUV,abs(mat-14.0)<0.5);
  let sampDx=select(archDx,dpdx(winUV),abs(mat-14.0)<0.5);
  let sampDy=select(archDy,dpdy(winUV),abs(mat-14.0)<0.5);
  let texLayer=select(archIdx*2,8,abs(mat-14.0)<0.5);
  let rawArch=textureSampleGrad(cityCardArchTex,cityCardArchSamp,sampUV,texLayer,sampDx,sampDy);
  let rawAO=textureSampleGrad(cityCardArchTex,cityCardArchSamp,sampUV,texLayer+1,sampDx,sampDy).a;
  let rawPhoto=textureSampleGrad(cityCardNearAlbedo,cityCardLandSamp,bldgUV,dpdx(bldgUV),dpdy(bldgUV)).rgb;
  let archLin=pow(max(rawArch.rgb,vec3f(0.005)),vec3f(2.2));
  var albedo=archLin*shadeAlbedo*(0.82+0.18*rawAO);
  if(v.kind.x>=19.5){
    albedo=pow(max(rawPhoto,vec3f(0.005)),vec3f(2.2));
    matFlag=0.0;
  }else if(abs(mat-14.0)<0.5){
    let isGlazed=v.kind.y>0.25;
    if(isGlazed){
      let bDist=min(min(winUV.x,1.0-winUV.x),min(winUV.y,1.0-winUV.y));
      let frame=max(1.0-smoothstep(0.075,0.098,bDist),max(1.0-smoothstep(0.028,0.044,abs(winUV.x-0.5)),1.0-smoothstep(0.026,0.042,abs(winUV.y-0.38))));
      albedo=mix(archLin*(0.72+0.28*(0.84-0.14*winUV.y)),vec3f(0.082,0.056,0.036),frame);
    }else{
      albedo=vec3f(0.044,0.037,0.030)*portShade;
    }
    matFlag=0.0;
  }else if(abs(mat-10.0)<0.5){
    let tLuma=dot(archLin,vec3f(0.299,0.587,0.114));
    albedo=mix(vec3f(tLuma),archLin,0.72)*vec3f(0.93,0.96,1.02)*shadeAlbedo*(0.82+0.18*rawAO);
  }else if(abs(mat-11.0)<0.5){
    albedo*=vec3f(1.00,0.99,0.96);
  }else if(abs(mat-12.0)<0.5||abs(mat-19.0)<0.5){
    // Bake neutral chalky limewash stucco matching landSurface; continuumCardFS applies exact limewash tint.
    let damp=smoothstep(0.4,3.8,v.local.y);
    let foot=1.0-smoothstep(0.0,0.85,v.local.y);
    let stLuma=dot(archLin,vec3f(0.299,0.587,0.114));
    let neutralArch=mix(vec3f(stLuma),archLin,0.58);
    let baseTint=mix(vec3f(0.76,0.74,0.70),vec3f(0.99,0.98,0.96),damp)*mix(1.0,0.72,foot*(1.0-abs(n.y)));
    albedo=neutralArch*baseTint*shadeAlbedo*(0.84+0.16*rawAO);
  }else if(abs(mat-13.0)<0.5){
    let rawT=archLin*0.81*shadeAlbedo*(0.82+0.18*rawAO);
    let tLuma=dot(rawT,vec3f(0.299,0.587,0.114));
    albedo=mix(vec3f(tLuma)*vec3f(1.06,0.89,0.76),rawT*vec3f(0.84,0.88,0.96),0.44);
  }else if(abs(mat-18.0)<0.5){
    albedo=archLin*0.82*(0.68+0.32*portShade);
  }
  return ContinuumCardSample(albedo,1.0,n,matFlag);
}
`,
});

// The city's material (js/wgsl/continuum-cut.js), shaded with the land's module source (js/wgsl/terrain.js TERRAIN as
// the terrain draws it), which holds the shared core, the frame and the land's bindings (groups 0 and 1).
export function cityContinuumMaterial(landSource) {
  const captured = withCapturedAir(landSource);
  return Object.freeze({
    name: 'cityContinuum', prelude: (pass) => (pass === 'capture' ? captured : landSource), core: true, data: CITY_CONTINUUM_DATA,
    varyings: [['kind', 'vec2f'], ['leafUV', 'vec2f'], ['splatKinds', 'vec4f', true], ['splat', 'vec2f']],
    wgsl: () => CITY_CONTINUUM_MATERIAL_WGSL, salt: 1,
    // Every type, its far body and its splat are wound outward, so the far faces are left out.
    cullMode: 'back', air: false, capture: true, captureWatersideOnly: true, visibility: true,
    cardBake: CITY_CONTINUUM_CARD_BAKE,
  });
}

// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The city's material in the one continuum's pipeline family (js/wgsl/continuum-cut.js): how a city's buildings, a
// coast's prefabs and the pieces of a struck building wear their surfaces. Their cut, their shadow, their atlas and
// their poses are the one cut's; this is only how a surface is worn, shaded by the land's own opaque surface
// (js/wgsl/terrain.js landOpaque) with a building's limewash, tiles and thatch, its age and its weathering. Its view is
// a module of its own, the land's source its prelude (the land shades it, but does not carry it).
import { CITY_CONTINUUM_KIND_Y, CITY_CONTINUUM_MATERIAL } from '../city-continuum.js';

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

// The city's material (js/wgsl/continuum-cut.js), shaded with the land's module source (js/wgsl/terrain.js TERRAIN as
// the terrain draws it), which holds the shared core, the frame and the land's bindings (groups 0 and 1).
export function cityContinuumMaterial(landSource) {
  return Object.freeze({
    name: 'cityContinuum', prelude: () => landSource, core: true, data: CITY_CONTINUUM_DATA,
    varyings: [['kind', 'vec2f'], ['leafUV', 'vec2f'], ['splatKinds', 'vec4f', true], ['splat', 'vec2f']],
    wgsl: () => CITY_CONTINUUM_MATERIAL_WGSL, salt: 1,
    // Every type, its far body and its splat are wound outward, so the far faces are left out.
    cullMode: 'back', air: false, capture: false,
  });
}

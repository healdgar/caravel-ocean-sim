// Copyright (c) 2026 Six Cailloux, LLC. MIT License; see LICENSE.
// The ground a ball has dug up, held in fine tiles of two texture arrays:
//  - the ground as it was, written from the land's own lattice once, when a tile first comes into use;
//  - what has been done to it, worked out from every crater near the tile, whenever a shot lands there.
// The land draws it (js/wgsl/land-continuum.js): its vertices stand in the pits, its fragments are lit as dug ground.
// See js/land-craters.js for what is written when.
import { NOISE_WGSL } from './common.js';

export const LAND_CRATER_TILE_M = 8;
export const LAND_CRATER_CELLS = 64;
export const LAND_CRATER_CELL_M = LAND_CRATER_TILE_M / LAND_CRATER_CELLS;
// A shadow is followed this far past a tile's edge, so one falling across a seam does not stop at it.
export const LAND_CRATER_GUTTER = 8;
export const LAND_CRATER_TEXELS = LAND_CRATER_CELLS + 1 + 2 * LAND_CRATER_GUTTER;
export const LAND_CRATER_PER_TILE = 32;
// How far a crater's spoil reaches at most, in crater radii, before a flat shot draws it out.
export const LAND_CRATER_REACH = 3.05;
export const LAND_CRATER_LOOKUP_SIZE = 1024;
// Tile layers at most, each with the most its craters dig or throw up over each of its blocks (landCraterPlace.amounts).
export const LAND_CRATER_MOST_LAYERS = 384;
// A tile's blocks, four a side: what the land's cut keeps of a crater is kept block by block (landCraterWaits).
export const LAND_CRATER_BLOCK_M = 2;
export const LAND_CRATER_BLOCKS = LAND_CRATER_TILE_M / LAND_CRATER_BLOCK_M;
const CELL = LAND_CRATER_CELL_M.toFixed(4);
const GUTTER = LAND_CRATER_GUTTER.toFixed(1);
const TEXELS = LAND_CRATER_TEXELS.toFixed(1);

// O(1) GPU lookup from world XZ into the active 8 m crater tile layer and its [81, 81] field UV.
export const LAND_CRATER_SAMPLE_WGSL = /* wgsl */ `
fn landCraterLookupCell(worldXZ: vec2f, originXZ: vec2f) -> vec2i {
  return vec2i(floor((worldXZ - originXZ) * ${(1 / LAND_CRATER_TILE_M).toFixed(4)}));
}
fn landCraterLayerAt(cell: vec2i, enabled: f32, lookupTex: texture_2d<i32>) -> i32 {
  if (enabled < 0.5 || cell.x < 0 || cell.x >= ${LAND_CRATER_LOOKUP_SIZE} || cell.y < 0 || cell.y >= ${LAND_CRATER_LOOKUP_SIZE}) {
    return -1;
  }
  return textureLoad(lookupTex, cell, 0).r;
}
fn landCraterFieldUV(worldXZ: vec2f, originXZ: vec2f, cell: vec2i) -> vec2f {
  let tileOrig = originXZ + vec2f(cell) * ${LAND_CRATER_TILE_M.toFixed(1)};
  return ((worldXZ - tileOrig) * ${(1 / LAND_CRATER_CELL_M).toFixed(1)} + ${(LAND_CRATER_GUTTER + 0.5).toFixed(1)}) / ${TEXELS};
}
`;

// One tile from every crater that reaches it. A pure function of the craters and the ground, so overlapping
// tiles agree along their shared texels, a hit rewrites only what it touched, and a saved list replays exactly.
export const LAND_CRATER_BAKE = NOISE_WGSL + /* wgsl */ `
struct LandCraterRecord{centre:vec2f,radius:f32,depth:f32,heading:vec2f,grazing:f32,seed:f32,sand:f32,pad:f32};
struct LandCraterJob{origin:vec2f,floorY:f32,layer:u32,first:u32,count:u32,pad0:u32,pad1:u32};
@group(0)@binding(0) var<storage,read> craterRecords:array<LandCraterRecord>;
@group(0)@binding(1) var<storage,read> craterJobs:array<LandCraterJob>;
@group(0)@binding(2) var<storage,read> craterLists:array<u32>;
@group(0)@binding(3) var craterGroundIn:texture_2d_array<f32>;
@group(0)@binding(4) var craterFieldOut:texture_storage_2d_array<rgba16float,write>;
struct LandCraterStamp{height:f32,inside:f32,soil:f32,cover:f32};
fn landCraterStamp(c:LandCraterRecord,p:vec2f,rock:f32)->LandCraterStamp{
  let sand=c.sand;
  // Sand slumps to a wider, shallower bowl. Rock barely gives.
  let radius=c.radius*(1.0+.14*sand)*(1.0-.38*rock);
  let depth=c.depth*(1.0-.28*sand)*(1.0-.6*rock);
  // A flat shot drives the pit long and throws its spoil on ahead.
  let off=p-c.centre;
  let side=vec2f(-c.heading.y,c.heading.x);
  let q=vec2f((dot(off,c.heading)-.22*c.grazing*radius)/(1.0+.32*c.grazing),dot(off,side)/(1.0-.06*c.grazing))/radius;
  let angle=select(0.0,atan2(q.y,q.x),dot(q,q)>1e-8);
  let ahead=cos(angle);
  let dir=q/max(length(q),.0001);
  let r=max(length(q)*(1.0+gnoise(dir*1.3+c.seed*17.0)*.12+gnoise(p*.85+c.seed*31.0)*.07),.0001);
  // Thrown ground goes out in uneven tongues.
  let ray=clamp(.5+gnoise(dir*2.3+c.seed*43.0)*.75+gnoise(dir*5.1-c.seed*29.0)*.45,0.0,1.0);
  let rim=depth*.32*(.72+.34*ray+.38*c.grazing*ahead);
  let reach=mix(2.2,3.0,clamp(.5+.5*ahead*c.grazing+(ray-.5)*.6,0.0,1.0));
  // Nothing passes this. landCraterReach in js/land-craters.js picks the tiles by the same figure.
  let limit=radius*${LAND_CRATER_REACH.toFixed(2)}*(1.0+.32*c.grazing);
  let fade=1.0-smoothstep(limit*.8,limit,length(off));
  // Bowl to the crest of the rim, then the spoil thinning as the cube of the distance, as thrown ground does.
  let bowl=-depth+(depth+rim)*pow(min(r,1.0),mix(2.5,2.0,sand));
  let apron=rim*pow(max(r,1.0),-3.0)*(1.0-smoothstep(reach*.72,reach,r));
  let clods=gnoise(p*2.9+c.seed*11.0)*.6+gnoise(p*4.4-c.seed*23.0)*.4;
  let rough=clods*depth*mix(.05,.11,smoothstep(.35,1.0,r))*(1.0-smoothstep(1.2,reach,r))*(1.0-.55*sand);
  return LandCraterStamp((mix(bowl,apron,smoothstep(.95,1.06,r))+rough)*fade,1.0-smoothstep(.7,1.02,r),
    max(1.0-smoothstep(1.02,1.3+.5*ray,r),min(pow(ray,1.5)*.8/(r*r),1.0)*(1.0-smoothstep(reach*.7,reach,r)))*fade,(1.0-smoothstep(reach,reach+.3,r))*fade);
}
@compute @workgroup_size(9,9) fn main(@builtin(global_invocation_id) id:vec3u){
  let job=craterJobs[id.z];
  let texel=vec2i(id.xy);
  let layer=i32(job.layer);
  let ground=textureLoad(craterGroundIn,texel,layer,0);
  if(ground.a<0.0){textureStore(craterFieldOut,texel,layer,vec4f(0.0));return;}
  let p=job.origin+(vec2f(id.xy)-${GUTTER})*${CELL};
  let rock=smoothstep(.22,.5,1.0-sqrt(max(1.0-ground.y*ground.y-ground.z*ground.z,0.0)));
  var stamps:array<LandCraterStamp,${LAND_CRATER_PER_TILE}>;
  let count=min(job.count,${LAND_CRATER_PER_TILE}u);
  for(var i=0u;i<count;i++){stamps[i]=landCraterStamp(craterRecords[craterLists[job.first+i]],p,rock);}
  // Bowls cut into each other. A rim stands unless another bowl has dug it away.
  var carve=0.0;var pile=0.0;var soil=0.0;var sand=0.0;var cover=0.0;
  for(var i=0u;i<count;i++){
    let cut=min(stamps[i].height,0.0);
    let k=min(.18,-max(carve,cut)*2.0);
    let h=max(k-abs(carve-cut),0.0)/max(k,.0001);
    carve=min(carve,cut)-h*h*k*.25;
    var standing=1.0;
    for(var j=0u;j<count;j++){if(j!=i){standing*=1.0-stamps[j].inside;}}
    pile+=max(stamps[i].height,0.0)*standing;
    soil=max(soil,stamps[i].soil);
    if(stamps[i].cover>cover){cover=stamps[i].cover;sand=craterRecords[craterLists[job.first+i]].sand;}
  }
  textureStore(craterFieldOut,texel,layer,vec4f(carve+pile,soil,sand,cover));
}
`;

// Added to the land shader (js/wgsl/terrain.js). The ground the land's continuum walks is the lattice with the pits
// in it (landCraterDepth, through landContinuumRelief in js/wgsl/land-continuum.js), and its fragments lit as the dug ground they are, the
// same fragment shading the ground round them: only the land as it was decides what material a point is; the pit
// decides its lighting and what lies on top.
export const LAND_CRATER_PIT = LAND_CRATER_SAMPLE_WGSL + /* wgsl */ `
@group(2)@binding(54) var landCraterLookup:texture_2d<i32>;
@group(2)@binding(55) var landCraterField:texture_2d_array<f32>;
@group(2)@binding(56) var landCraterSampler:sampler;
// The lookup's origin x z and 1 to look; then the world rectangle every tile in use lies in (x0 x1 z0 z1), outside
// which nothing is read at all; then, for each layer, the most its craters dig or throw up over each of its blocks,
// a row of blocks a vector (landCraterBlockAmount in js/land-craters.js).
struct LandCraterPlace{origin:vec4f,bounds:vec4f,amounts:array<vec4f,${LAND_CRATER_MOST_LAYERS * LAND_CRATER_BLOCKS}>};
@group(2)@binding(57) var<uniform> landCraterPlace:LandCraterPlace;
struct LandCraterSpot{layer:i32,uv:vec2f};
fn landCraterNear(xz:vec2f)->bool{let b=landCraterPlace.bounds;return xz.x>=b.x&&xz.x<=b.y&&xz.y>=b.z&&xz.y<=b.w;}
// The error the land's cut waits for before it brings in a point between its lattice's (js/wgsl/land-continuum.js):
// what the craters do over the block the point is in, nothing where its tile is not in use. The cut keeps at least
// that much over every patch that reaches the block (landContinuumDig in js/land-continuum.js), and splits it.
fn landCraterWaits(xz:vec2f)->f32{
  if(!landCraterNear(xz)){return 0.0;}
  let b=vec2i(floor((xz-landCraterPlace.origin.xy)*${(1 / LAND_CRATER_BLOCK_M).toFixed(4)}));
  let layer=landCraterLayerAt(b>>vec2u(${Math.log2(LAND_CRATER_BLOCKS)}u),landCraterPlace.origin.z,landCraterLookup);
  if(layer<0){return 0.0;}
  let q=b&vec2i(${LAND_CRATER_BLOCKS - 1});
  return landCraterPlace.amounts[layer*${LAND_CRATER_BLOCKS}+q.y][q.x];
}
fn landCraterSpot(xz:vec2f)->LandCraterSpot{
  let cell=landCraterLookupCell(xz,landCraterPlace.origin.xy);
  return LandCraterSpot(landCraterLayerAt(cell,landCraterPlace.origin.z,landCraterLookup),landCraterFieldUV(xz,landCraterPlace.origin.xy,cell));
}
fn landCraterHeight(uv:vec2f,layer:i32)->f32{return textureSampleLevel(landCraterField,landCraterSampler,uv,layer,0.0).r;}
// What the pits have done to the ground's height at a point.
fn landCraterDepth(xz:vec2f)->f32{
  if(!landCraterNear(xz)){return 0.0;}
  let spot=landCraterSpot(xz);
  if(spot.layer<0){return 0.0;}
  return landCraterHeight(spot.uv,spot.layer);
}
// The pit at a fragment of ground whose own normal is 'ground', or plain ground (cover below zero) where none reaches.
// dx and dy are the fragment's world derivatives, taken before any branch.
fn landCraterPit(world:vec3f,ground:vec3f,dx:vec3f,dy:vec3f)->LandPit{
  let plain=LandPit(vec3f(0.0),-1.0,vec3f(0.0),0.0,1.0,1.0,0.0,1.0,0.0);
  if(!landCraterNear(world.xz)){return plain;}
  let spot=landCraterSpot(world.xz);
  if(spot.layer<0){return plain;}
  let field=textureSampleLevel(landCraterField,landCraterSampler,spot.uv,spot.layer,0.0);
  if(field.a<=.002){return plain;}
  let texel=1.0/${TEXELS};
  let metres=1.0/(${TEXELS}*${CELL});
  // The surface as it is now: the land's slope and the pit's together.
  let e=vec2f(texel,0.0);
  let gradient=vec2f(landCraterHeight(spot.uv+e.xy,spot.layer)-landCraterHeight(spot.uv-e.xy,spot.layer),landCraterHeight(spot.uv+e.yx,spot.layer)-landCraterHeight(spot.uv-e.yx,spot.layer))/(2.0*${CELL});
  let tilt=ground.xz/max(ground.y,.05);
  let pool=1.0-smoothstep(0.0,.03,world.y);
  let normal=normalize(mix(vec3f(tilt.x-gradient.x,1.0,tilt.y-gradient.y),vec3f(0.0,1.0,0.0),pool));
  // Walk the height toward the sun, closely at first. The land's light bake knows nothing this small.
  var sun=1.0;
  let sunward=length(F.sunDir.xz);
  if(F.sunDir.y>0.0&&sunward>.001){
    let along=F.sunDir.xz/sunward;
    let climb=F.sunDir.y/sunward+dot(tilt,along);
    var blocked=-1.0;
    for(var i=0u;i<12u;i++){
      let t=pow(f32(i)+1.0,1.5)*.06;
      blocked=max(blocked,landCraterHeight(spot.uv+along*t*metres,spot.layer)-field.r-t*climb);
    }
    sun=1.0-smoothstep(.0,.09,blocked);
  }
  // How much of the sky the ground around leaves open.
  let d=.4*metres;
  let around=.25*(landCraterHeight(spot.uv+vec2f(d,0.0),spot.layer)+landCraterHeight(spot.uv-vec2f(d,0.0),spot.layer)+landCraterHeight(spot.uv+vec2f(0.0,d),spot.layer)+landCraterHeight(spot.uv-vec2f(0.0,d),spot.layer));
  let sky=(1.0-.62*clamp((around-field.r)/.42,0.0,1.0))*(1.0-.3*clamp(-field.r/1.1,0.0,1.0));
  // Turned-over earth: broken clods near, thinning to thrown scatter.
  let width=max(length(dx.xz),length(dy.xz));
  let coarse=landFilteredNoise(world.xz*1.7,width*1.7);let fine=landFilteredNoise(world.xz*6.3,width*6.3);
  let scatter=coarse*.55+fine*.45;
  // Clods a hand across and lumps a span across, each only as long as a few pixels can hold it.
  let clodNear=1.0-smoothstep(.01,.04,width);
  let lumpNear=1.0-smoothstep(.03,.12,width);
  var clods=vec2f(0.0,1.0);var lumps=vec2f(0.0,1.0);
  if(clodNear>0.0){clods=landStones(world.xz*19.0+scatter*1.5);}
  if(lumpNear>0.0){lumps=landStones(vec2f(world.x*.6+world.z*.8,world.z*.6-world.x*.8)*6.5+vec2f(5.3,71.9)+scatter*.8);}
  // Each clod or lump of earth is there or it is not, likelier the nearer the pit. From far off that is a tone.
  let chance=field.g*1.25+scatter*.22-.1;
  let piece=max(smoothstep(1.0-chance-.03,1.0-chance+.03,.5+.5*clods.x),smoothstep(1.0-chance*.8-.03,1.0-chance*.8+.03,.5+.5*lumps.x));
  let lying=max(field.a*mix(smoothstep(.3,.62,chance),piece,lumpNear),pool);
  let rock=smoothstep(.22,.5,1.0-ground.y);
  let deep=clamp(-field.r/.5,0.0,1.0);
  let topsoil=mix(vec3f(.085,.055,.034),vec3f(.032,.021,.014),clamp(.5+scatter*.9+deep*.35,0.0,1.0));
  let stone=vec3f(.3,.27,.23)*(1.0+coarse*.2);
  let broken=1.0+(clods.x*.3-(1.0-clods.y)*.38)*clodNear+(lumps.x*.3-(1.0-lumps.y)*.3)*lumpNear;
  let relief=((clods.y-.55)*.03*clodNear+(lumps.y-.55)*.07*lumpNear+coarse*.035+fine*.012)*(1.0-pool);
  return LandPit(normal,lying,mix(topsoil,stone,rock)*broken,relief,sun,sky,pool,(1.0-.62*deep)*(.72+scatter*.2)*mix(1.0,broken,.45),field.b);
}
`;
